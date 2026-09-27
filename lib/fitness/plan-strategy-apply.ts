import { Prisma } from '@/prisma/generated/client';
import { db } from '@/lib/db';
import { buildBaselinePlan } from './baseline-plan';
import { NEUTRAL_STRATEGY, requestPlanStrategy, type PlanStrategy } from './plan-strategy';
import type { PersistedCalculationInput } from './plan-store';
import { parseFitnessPlanContent } from './plan-schema';
import type { EligibilityDecision } from './eligibility';

// ============================================================
// Applying a strategy to a fresh draft
// ============================================================
// The plan is built inside a short transaction that holds an advisory lock, and
// a model call has no business being in there. So the draft is created exactly
// as it always was - fast, deterministic, neutral - and the strategy is applied
// afterwards as one extra step:
//
//   preview -> create/reuse draft -> (if unshaped) ask for a strategy
//           -> rebuild the content with it -> store strategy + rationale
//
// Everything needed to rebuild is already in the stored calculation input, so
// the rebuild is a pure function of data the database already agreed on. A
// reused draft is never reshaped: its strategy was decided when it was created.

export interface ApplyStrategyDependencies {
  requestStrategy(input: Parameters<typeof requestPlanStrategy>[0]): Promise<PlanStrategy>;
  buildPlan: typeof buildBaselinePlan;
}

const defaultDependencies: ApplyStrategyDependencies = {
  requestStrategy: requestPlanStrategy,
  buildPlan: buildBaselinePlan,
};

// The persisted eligibility is a snapshot; the builder wants a decision. The
// clearance instant is the only field that changes shape.
function toEligibility(value: PersistedCalculationInput['eligibility']): EligibilityDecision {
  return {
    status: value.status,
    reasonCodes: value.reasonCodes,
    clearanceExpiresAt: value.clearanceExpiresAt ? new Date(value.clearanceExpiresAt) : null,
  } as EligibilityDecision;
}

export async function applyPlanStrategy(
  userId: string,
  planId: string,
  dependencies: ApplyStrategyDependencies = defaultDependencies,
): Promise<{ strategy: PlanStrategy; reshaped: boolean }> {
  const version = await db.fitnessPlanVersion.findFirst({
    where: { id: planId, userId },
    select: { id: true, status: true, strategy: true, input: true },
  });
  if (!version) throw new Error('PLAN_NOT_FOUND');
  if (version.status !== 'DRAFT') {
    // A superseded or active version is a decision already made; reshaping it
    // would change a plan the trainee confirmed.
    return { strategy: NEUTRAL_STRATEGY, reshaped: false };
  }

  const stored = version.input as unknown as PersistedCalculationInput;
  const assessment = stored.assessment;
  const parseInstant = new Date(`${stored.calculationDate}T12:00:00.000Z`);

  const strategy = await dependencies.requestStrategy({
    userId,
    goalType: assessment.goal.type,
    weeklyFrequency: assessment.schedule.weeklyFrequency,
    trainingAgeMonths: assessment.profile.trainingAgeMonths,
    equipmentTypes: assessment.schedule.equipmentTypes,
    softConstraints: assessment.softConstraints ?? null,
    safetyNotes: stored.gymConstraints.unavailableExerciseNames,
  });

  if (strategy.source === 'DEFAULT') {
    // Nothing to reshape and nothing worth recording: the content already is
    // the neutral plan.
    await db.fitnessPlanVersion.update({
      where: { id: planId },
      data: { strategy: Prisma.DbNull },
    });
    return { strategy, reshaped: false };
  }

  const content = dependencies.buildPlan({
    assessment,
    eligibility: toEligibility(stored.eligibility),
    gymConstraints: stored.gymConstraints,
    loadGuidance: stored.loadGuidance,
    now: parseInstant,
    strategy,
  });

  // Re-parse before writing: a strategy that somehow produced an invalid plan
  // must fall back rather than store one.
  parseFitnessPlanContent(content);
  await db.fitnessPlanVersion.update({
    where: { id: planId },
    data: {
      content: content as unknown as Prisma.InputJsonValue,
      strategy: strategy as unknown as Prisma.InputJsonValue,
    },
  });
  return { strategy, reshaped: true };
}
