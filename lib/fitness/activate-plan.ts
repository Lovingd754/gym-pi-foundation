import type { Prisma } from '@/prisma/generated/client';
import { db } from '@/lib/db';
import { ApiError } from '@/lib/api';
import { hashAuditValue } from '@/lib/agent/audit-hash';
import { materializeProgram } from '@/lib/program-generation';
import { generatedProgramSchema } from '@/lib/schemas/program-generation';

import { getActivationState } from './activation-state';
import { parseFitnessPlanContent } from './plan-schema';
import {
  buildPersistedCalculationInput,
  loadCalculationState,
  type PersistedCalculationInput,
} from './plan-store';
import { lockFitnessUser } from './user-lock';
import { FITNESS_RULES_VERSION } from './versions';
import { isoWeekStartDate } from './time-zone';

export type ActivateFitnessPlanResult = {
  planId: string;
  programId: string;
  activationRevision: number;
};

// One interactive transaction performs the whole activation: the same advisory
// lock the preview and session-start paths take serializes all three, so a
// version can never be activated twice and a session can never start on a
// program that is about to be replaced.
export async function activateFitnessPlan(input: {
  userId: string;
  planId: string;
  expectedRevision: number;
  now?: Date;
}): Promise<ActivateFitnessPlanResult> {
  const capturedNow = input.now ? new Date(input.now.getTime()) : new Date();
  if (Number.isNaN(capturedNow.getTime())) throw new RangeError('now must be a valid date');

  return db.$transaction(async (tx) => {
    await lockFitnessUser(tx, input.userId);

    const activation = await getActivationState(tx, input.userId);
    if (activation.revision !== input.expectedRevision) {
      throw new ApiError(409, 'ACTIVATION_REVISION_CONFLICT', {
        activationRevision: activation.revision,
      });
    }

    const plan = await tx.fitnessPlanVersion.findFirst({
      where: { id: input.planId, userId: input.userId },
      select: {
        id: true,
        status: true,
        rulesVersion: true,
        inputHash: true,
        profileUpdatedAt: true,
        input: true,
        content: true,
        goalId: true,
        healthScreeningId: true,
      },
    });
    if (!plan) throw new ApiError(404, 'Not found.');
    if (plan.status !== 'DRAFT') throw new ApiError(409, 'PLAN_NOT_DRAFT');

    const unfinishedSession = await tx.session.findFirst({
      where: { userId: input.userId, finishedAt: null },
      select: { id: true },
    });
    if (unfinishedSession) throw new ApiError(409, 'WORKOUT_IN_PROGRESS');

    const storedInput = plan.input as unknown as PersistedCalculationInput;
    if (
      !storedInput ||
      typeof storedInput.calculationDate !== 'string' ||
      Number.isNaN(new Date(`${storedInput.calculationDate}T12:00:00.000Z`).getTime())
    ) {
      throw new ApiError(409, 'PLAN_INPUT_STALE');
    }
    const parseInstant = new Date(`${storedInput.calculationDate}T12:00:00.000Z`);
    const state = await loadCalculationStateForActivation(
      tx,
      input.userId,
      capturedNow,
      parseInstant,
    );

    // The canonical input hash IS the freshness contract. It already covers the
    // normalized assessment, the eligibility decision, the calculation date, the
    // active-gym constraints and the load evidence gathered at activation time.
    //
    // Comparing append-only row identities on top of it (profile.updatedAt, the
    // newest screening id, the active goal id) would reject a plan the user
    // re-saved with identical answers: every save inserts a new screening and a
    // new goal row and bumps the profile timestamp, so the ids move even though
    // nothing the plan depends on changed.
    const stale =
      plan.rulesVersion !== FITNESS_RULES_VERSION ||
      hashAuditValue(buildPersistedCalculationInput(state, storedInput.calculationDate)) !==
        plan.inputHash;
    if (stale) throw new ApiError(409, 'PLAN_INPUT_STALE');
    if (storedInput.weeklyReview) {
      const activities = storedInput.weeklyReview.activities;
      const currentWeek = isoWeekStartDate(capturedNow, state.assessment.lifestyle.timeZone);
      const row = await tx.fitnessWeeklyActivities.findUnique({
        where: { userId_weekStart: { userId: input.userId, weekStart: currentWeek } },
      });
      if (
        currentWeek !== activities.weekStart ||
        hashAuditValue(row?.activities ?? []) !== hashAuditValue(activities.activities)
      )
        throw new ApiError(409, 'PLAN_INPUT_STALE');
    }

    const content = parseFitnessPlanContent(plan.content);
    const generatedProgram = generatedProgramSchema.parse({
      name: 'Personalized Plan',
      description: null,
      phase: `personalized-${content.goal.type.toLowerCase()}`,
      workouts: content.strength.days.map((day) => ({
        name: day.name,
        dayOfWeek: day.dayOfWeek ?? null,
        exercises: day.exercises,
      })),
    });

    const programId = await materializeProgram(tx, input.userId, generatedProgram, {
      fitness: {
        loadGuidance: content.loadGuidance,
        introRir: content.strength.introRir,
        introDurationDays: content.strength.introDurationDays,
        activatedAt: capturedNow,
      },
    });

    await tx.program.updateMany({
      where: { userId: input.userId, isActive: true, id: { not: programId } },
      data: { isActive: false },
    });
    await tx.program.update({ where: { id: programId }, data: { isActive: true } });

    if (activation.planVersionId && activation.planVersionId !== plan.id) {
      await tx.fitnessPlanVersion.updateMany({
        where: { id: activation.planVersionId, userId: input.userId, status: 'ACTIVE' },
        data: { status: 'SUPERSEDED' },
      });
    }
    await tx.fitnessPlanVersion.update({
      where: { id: plan.id },
      data: { status: 'ACTIVE', programId, activatedAt: capturedNow },
    });

    const activationRevision = activation.revision + 1;
    await tx.fitnessPlanActivation.upsert({
      where: { userId: input.userId },
      create: {
        userId: input.userId,
        planVersionId: plan.id,
        revision: activationRevision,
        activatedAt: capturedNow,
      },
      update: { planVersionId: plan.id, revision: activationRevision, activatedAt: capturedNow },
    });

    return { planId: plan.id, programId, activationRevision };
  });
}

// An ineligible screening at activation time is a staleness problem, not a new
// eligibility decision: the plan the user reviewed can no longer be honoured.
async function loadCalculationStateForActivation(
  tx: Prisma.TransactionClient,
  userId: string,
  now: Date,
  parseInstant: Date,
) {
  try {
    return await loadCalculationState(tx, userId, now, parseInstant);
  } catch (error) {
    // `loadCalculationState` reports its own 409s (missing assessment, or an
    // eligibility decision that is no longer ELIGIBLE). At activation both mean
    // the reviewed plan can no longer be honoured.
    if (error instanceof ApiError && error.status === 409) {
      throw new ApiError(409, 'PLAN_INPUT_STALE', error.details);
    }
    throw error;
  }
}
