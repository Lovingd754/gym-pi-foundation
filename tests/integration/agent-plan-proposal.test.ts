import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { getCurrentUserId } from '@/lib/auth';
import { saveAssessment } from '@/lib/fitness/assessment-store';
import { applyPlanChange } from '@/lib/fitness/plan-change';
import { parseFitnessPlanContent } from '@/lib/fitness/plan-schema';
import type { AssessmentInput } from '@/lib/fitness/schemas';
import {
  PlanProposalStaleError,
  applyPlanProposal,
  prismaApplyPlanChangeDependencies,
  prismaPlanProposalStore,
} from '@/lib/agent/plan-proposals';

vi.mock('@/lib/auth', () => ({ getCurrentUserId: vi.fn() }));
const mockUserId = vi.mocked(getCurrentUserId);

import { POST as postPreview } from '@/app/api/fitness/plans/preview/route';
import { POST as postActivate } from '@/app/api/fitness/plans/[id]/activate/route';
import { POST as postProposal } from '@/app/api/agent/plan-proposals/[id]/route';

// Matches the activation suite's fixture so the plan is built by the real
// generator and activated through the real route.
const baseInput: AssessmentInput = {
  profile: {
    ageYears: 30,
    displaySex: 'FEMALE',
    energyEquationReference: 'FEMALE',
    heightCm: 170,
    weightKg: 70,
    trainingAgeMonths: 18,
  },
  goal: { type: 'RECOMP', desiredWeeklyRatePct: 0 },
  schedule: {
    weeklyFrequency: 3,
    availableWeekdays: [1, 3, 5],
    sessionDurationMin: 60,
    equipmentTypes: ['BARBELL', 'CABLE'],
    recentMainLifts: [{ catalogKey: 'bench_press', weightKg: 60, reps: 8, rir: 2 }],
  },
  lifestyle: {
    activityLevel: 'MODERATE',
    currentModerateActivityMin: 120,
    habitualSleepMin: 480,
    bedtimeMin: 1380,
    wakeTimeMin: 420,
    timeZone: 'UTC',
  },
  health: {
    urgentSignals: [],
    clearanceSignals: [],
    temporarySignals: [],
    scopeSignals: [],
    healthChangedSinceClearance: false,
    attested: true,
  },
};

function jsonRequest(body: unknown): Request {
  return new Request('http://test.local/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function idParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

// A trainee with an ACTIVE personalized plan, created the way the app creates
// one: assessment -> preview -> explicit confirmation.
async function seedActivatedPlan(suffix: string) {
  const user = await db.user.create({
    data: { email: `${suffix}@proposal.test`, passwordHash: 'test-password-hash' },
  });
  await saveAssessment(user.id, baseInput, new Date('2026-09-16T12:00:00.000Z'));
  mockUserId.mockResolvedValue(user.id);

  const preview = await postPreview(jsonRequest({}));
  const draft = (await preview.json()) as { plan: { id: string }; activationRevision: number };
  const activated = await postActivate(
    jsonRequest({ expectedRevision: draft.activationRevision }),
    idParams(draft.plan.id),
  );
  expect(activated.status).toBe(200);
  return { user, planId: draft.plan.id };
}

async function proposeCardioChange(userId: string, planId: string, minutes: number) {
  const plan = await db.fitnessPlanVersion.findUniqueOrThrow({
    where: { id: planId },
    select: { content: true },
  });
  const constraints = await prismaApplyPlanChangeDependencies.loadConstraints(userId);
  const applied = applyPlanChange(
    parseFitnessPlanContent(plan.content),
    { kind: 'SET_CARDIO_MINUTES', minutes },
    constraints,
  );
  const diff = applied.diff.map(() => ({ label: 'Cardio', before: '90 min', after: `${minutes} min` }));
  return prismaPlanProposalStore.propose({
    userId,
    kind: 'SET_CARDIO_MINUTES',
    basePlanId: planId,
    change: { kind: 'SET_CARDIO_MINUTES', minutes },
    diff,
  });
}

beforeEach(() => {
  mockUserId.mockReset();
});

describe('applying a plan change proposal', () => {
  it('produces a new active plan version and retires the previous one', async () => {
    const { user, planId } = await seedActivatedPlan('proposal-apply');
    const proposal = await proposeCardioChange(user.id, planId, 25);

    const response = await postProposal(jsonRequest({ action: 'apply' }), idParams(proposal.id));
    expect(response.status).toBe(200);

    const activation = await db.fitnessPlanActivation.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(activation.planVersionId).not.toBe(planId);

    const current = await db.fitnessPlanVersion.findUniqueOrThrow({
      where: { id: activation.planVersionId ?? '' },
    });
    expect(current.status).toBe('ACTIVE');
    expect(current.version).toBe(2);
    expect(parseFitnessPlanContent(current.content).cardio.additionalWeeklyMin).toBe(25);

    // The plan the trainee confirmed is kept, not overwritten.
    const previous = await db.fitnessPlanVersion.findUniqueOrThrow({ where: { id: planId } });
    expect(previous.status).toBe('SUPERSEDED');
    expect(parseFitnessPlanContent(previous.content).cardio.additionalWeeklyMin).not.toBe(25);

    // A change goes through activation, so the trainee ends up on a real
    // program rather than a detached plan version.
    const program = await db.program.findFirstOrThrow({
      where: { userId: user.id, isActive: true },
    });
    expect(program.id).toBe(current.programId);

    const stored = await db.agentPlanProposal.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(stored.status).toBe('APPLIED');
    expect(stored.resultPlanId).toBe(current.id);
  });

  it('refuses a proposal whose plan has been replaced since it was written', async () => {
    const { user, planId } = await seedActivatedPlan('proposal-stale');
    const proposal = await proposeCardioChange(user.id, planId, 25);

    // The trainee regenerates their plan: a fresh draft is activated instead.
    const preview = await postPreview(jsonRequest({}));
    const replacement = (await preview.json()) as {
      plan: { id: string };
      activationRevision: number;
    };
    expect(replacement.plan.id).not.toBe(planId);
    const activated = await postActivate(
      jsonRequest({ expectedRevision: replacement.activationRevision }),
      idParams(replacement.plan.id),
    );
    expect(activated.status).toBe(200);

    await expect(applyPlanProposal(user.id, proposal.id)).rejects.toBeInstanceOf(
      PlanProposalStaleError,
    );
    const stored = await db.agentPlanProposal.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(stored.status).toBe('PENDING');
  });

  it('leaves no stray draft when activation refuses the change', async () => {
    const { user, planId } = await seedActivatedPlan('proposal-blocked');
    const proposal = await proposeCardioChange(user.id, planId, 25);
    // Activation refuses while a workout is in progress.
    await db.session.create({ data: { userId: user.id } });
    const before = await db.fitnessPlanVersion.count({ where: { userId: user.id } });

    await expect(applyPlanProposal(user.id, proposal.id)).rejects.toMatchObject({
      status: 409,
    });

    expect(await db.fitnessPlanVersion.count({ where: { userId: user.id } })).toBe(before);
    const stored = await db.agentPlanProposal.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(stored.status).toBe('PENDING');
  });

  it('never lets a stranger apply or dismiss a proposal', async () => {
    const { user, planId } = await seedActivatedPlan('proposal-owner');
    const proposal = await proposeCardioChange(user.id, planId, 25);
    const stranger = await db.user.create({
      data: { email: 'proposal-stranger@proposal.test', passwordHash: 'test-password-hash' },
    });
    mockUserId.mockResolvedValue(stranger.id);

    const apply = await postProposal(jsonRequest({ action: 'apply' }), idParams(proposal.id));
    expect(apply.status).toBe(404);
    const dismiss = await postProposal(jsonRequest({ action: 'dismiss' }), idParams(proposal.id));
    expect(dismiss.status).toBe(404);

    const stored = await db.agentPlanProposal.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(stored.status).toBe('PENDING');
    expect((await db.fitnessPlanActivation.findUniqueOrThrow({ where: { userId: user.id } }))
      .planVersionId).toBe(planId);
  });

  it('deletes a declined proposal instead of parking it', async () => {
    const { user, planId } = await seedActivatedPlan('proposal-dismiss');
    const proposal = await proposeCardioChange(user.id, planId, 25);

    const response = await postProposal(
      jsonRequest({ action: 'dismiss' }),
      idParams(proposal.id),
    );

    expect(response.status).toBe(200);
    expect(await db.agentPlanProposal.count({ where: { userId: user.id } })).toBe(0);
  });
});
