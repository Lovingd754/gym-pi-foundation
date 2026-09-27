import type { Prisma } from '@/prisma/generated/client';
import { ApiError } from '@/lib/api';
import { db } from '@/lib/db';
import { activateFitnessPlan } from '@/lib/fitness/activate-plan';
import { getActivationState } from '@/lib/fitness/activation-state';
import { PlanChangeError, applyPlanChange, type PlanChange } from '@/lib/fitness/plan-change';
import { createDerivedPlanVersion } from '@/lib/fitness/plan-store';
import { parseFitnessPlanContent } from '@/lib/fitness/plan-schema';

// ============================================================
// Plan change proposals
// ============================================================
// The agent may propose a change; only the trainee applies it. A proposal
// stores the *operation* and the plan version it was computed against, and
// applying re-runs the operation on the live plan. Two consequences:
//
//   - The stored row is never a plan. A plan can only enter the database
//     through the rules and the activation path, exactly as a generated one.
//   - A proposal computed against a plan that has since been replaced is
//     refused rather than applied to the wrong plan.

export type PlanChangeKind = 'SWAP_EXERCISE' | 'MOVE_TRAINING_DAY' | 'SET_CARDIO_MINUTES';

export interface PlanDiffRow {
  label: string;
  before: string;
  after: string;
}

export interface PlanProposalView {
  id: string;
  kind: PlanChangeKind;
  diff: PlanDiffRow[];
  createdAt: Date;
}

export interface PlanProposalStore {
  propose(input: {
    userId: string;
    conversationId?: string;
    kind: PlanChangeKind;
    basePlanId: string;
    change: PlanChange;
    diff: PlanDiffRow[];
  }): Promise<{ id: string; created: boolean }>;
  list(userId: string, status: 'PENDING' | 'APPLIED'): Promise<PlanProposalView[]>;
  loadPending(userId: string, proposalId: string): Promise<
    | (PlanProposalView & {
        basePlanId: string;
        change: PlanChange;
      })
    | null
  >;
  markApplied(userId: string, proposalId: string, resultPlanId: string): Promise<void>;
  dismiss(userId: string, proposalId: string): Promise<boolean>;
}

function readDiff(value: unknown): PlanDiffRow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    if (typeof row !== 'object' || row === null) return [];
    const record = row as Record<string, unknown>;
    if (
      typeof record.label !== 'string' ||
      typeof record.before !== 'string' ||
      typeof record.after !== 'string'
    ) {
      return [];
    }
    return [{ label: record.label, before: record.before, after: record.after }];
  });
}

export const prismaPlanProposalStore: PlanProposalStore = {
  async propose(input) {
    // One pending proposal per identical change: a model that repeats itself
    // must not stack cards the trainee has to dismiss one by one.
    const pending = await db.agentPlanProposal.findMany({
      where: { userId: input.userId, status: 'PENDING' },
      select: { id: true, kind: true, change: true },
    });
    const same = pending.find(
      (row) =>
        row.kind === input.kind &&
        JSON.stringify(row.change) === JSON.stringify(input.change as unknown as Prisma.JsonValue),
    );
    if (same) return { id: same.id, created: false };

    const created = await db.agentPlanProposal.create({
      data: {
        userId: input.userId,
        conversationId: input.conversationId ?? null,
        kind: input.kind,
        basePlanId: input.basePlanId,
        change: input.change as unknown as Prisma.InputJsonValue,
        diff: input.diff as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return { id: created.id, created: true };
  },

  async list(userId, status) {
    const rows = await db.agentPlanProposal.findMany({
      where: { userId, status },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, kind: true, diff: true, createdAt: true },
    });
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      diff: readDiff(row.diff),
      createdAt: row.createdAt,
    }));
  },

  async loadPending(userId, proposalId) {
    const row = await db.agentPlanProposal.findFirst({
      where: { id: proposalId, userId, status: 'PENDING' },
      select: { id: true, kind: true, diff: true, createdAt: true, basePlanId: true, change: true },
    });
    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind,
      diff: readDiff(row.diff),
      createdAt: row.createdAt,
      basePlanId: row.basePlanId,
      change: row.change as unknown as PlanChange,
    };
  },

  async markApplied(userId, proposalId, resultPlanId) {
    await db.agentPlanProposal.updateMany({
      where: { id: proposalId, userId, status: 'PENDING' },
      data: { status: 'APPLIED', resultPlanId, decidedAt: new Date() },
    });
  },

  async dismiss(userId, proposalId) {
    const result = await db.agentPlanProposal.deleteMany({
      where: { id: proposalId, userId, status: 'PENDING' },
    });
    return result.count > 0;
  },
};

export interface ApplyPlanChangeDependencies {
  loadConstraints(userId: string): Promise<{
    availableWeekdays: number[];
    equipmentTypes: string[];
    unavailableExerciseNames: string[];
  }>;
  applyChange: typeof applyPlanChange;
  createVersion: typeof createDerivedPlanVersion;
  activate: typeof activateFitnessPlan;
  loadActivation(userId: string): Promise<{ planVersionId: string | null; revision: number }>;
}

export const prismaApplyPlanChangeDependencies: ApplyPlanChangeDependencies = {
  async loadConstraints(userId) {
    const [profile, user] = await Promise.all([
      db.fitnessProfile.findUnique({
        where: { userId },
        select: { availableWeekdays: true, equipmentTypes: true },
      }),
      db.user.findUnique({ where: { id: userId }, select: { activeGymId: true } }),
    ]);
    const activeGymId = user?.activeGymId ?? null;
    const unavailable = activeGymId
      ? await db.gymExerciseConfig.findMany({
          where: { gymId: activeGymId, isAvailable: false },
          select: { exercise: { select: { name: true } } },
        })
      : [];

    return {
      availableWeekdays: profile?.availableWeekdays ?? [],
      equipmentTypes: profile?.equipmentTypes ?? [],
      unavailableExerciseNames: unavailable.map((config) => config.exercise.name),
    };
  },
  applyChange: applyPlanChange,
  createVersion: createDerivedPlanVersion,
  activate: activateFitnessPlan,
  async loadActivation(userId) {
    const state = await getActivationState(db, userId);
    return { planVersionId: state.planVersionId, revision: state.revision };
  },
};

export interface ApplyPlanChangeResult {
  planId: string;
  programId: string;
  planVersion: number;
}

export class PlanProposalStaleError extends Error {
  constructor() {
    super('PLAN_PROPOSAL_STALE');
    this.name = 'PlanProposalStaleError';
  }
}

export async function applyPlanProposal(
  userId: string,
  proposalId: string,
  dependencies: ApplyPlanChangeDependencies = prismaApplyPlanChangeDependencies,
  store: PlanProposalStore = prismaPlanProposalStore,
): Promise<ApplyPlanChangeResult> {
  const proposal = await store.loadPending(userId, proposalId);
  if (!proposal) throw new ApiError(404, '这条改动已经处理过了。');

  const activation = await dependencies.loadActivation(userId);
  // The trainee may have regenerated their plan after this card appeared.
  // Applying now would silently overwrite that decision.
  if (activation.planVersionId !== proposal.basePlanId) throw new PlanProposalStaleError();

  const base = await db.fitnessPlanVersion.findFirst({
    where: { id: proposal.basePlanId, userId },
    select: { content: true },
  });
  if (!base) throw new PlanProposalStaleError();

  const constraints = await dependencies.loadConstraints(userId);
  const applied = dependencies.applyChange(
    parseFitnessPlanContent(base.content),
    proposal.change,
    constraints,
  );

  const version = await dependencies.createVersion({
    userId,
    basePlanId: proposal.basePlanId,
    content: applied.content,
  });

  let activationResult;
  try {
    activationResult = await dependencies.activate({
      userId,
      planId: version.id,
      expectedRevision: activation.revision,
    });
  } catch (error) {
    // The draft is inert until activated, so a refused activation must not
    // leave a stray version behind for the trainee to find later.
    await db.fitnessPlanVersion
      .deleteMany({ where: { id: version.id, userId, status: 'DRAFT' } })
      .catch(() => {});
    throw error;
  }

  await store.markApplied(userId, proposalId, version.id);
  return { planId: version.id, programId: activationResult.programId, planVersion: version.version };
}

export { PlanChangeError };
