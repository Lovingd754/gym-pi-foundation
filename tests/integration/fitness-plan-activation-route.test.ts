import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { getCurrentUserId } from '@/lib/auth';
import { saveAssessment } from '@/lib/fitness/assessment-store';
import type { AssessmentInput } from '@/lib/fitness/schemas';

vi.mock('@/lib/auth', () => ({ getCurrentUserId: vi.fn() }));
const mockUserId = vi.mocked(getCurrentUserId);

import { POST as postPreview } from '@/app/api/fitness/plans/preview/route';
import { POST as postActivate } from '@/app/api/fitness/plans/[id]/activate/route';
import { POST as startSession } from '@/app/api/sessions/route';

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

function inputWith(change?: (input: AssessmentInput) => void): AssessmentInput {
  const input = structuredClone(baseInput);
  change?.(input);
  return input;
}

function actAs(userId: string | null): void {
  mockUserId.mockResolvedValue(userId);
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function idParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function seedUser(suffix: string) {
  return db.user.create({
    data: { email: `${suffix}@activation.test`, passwordHash: 'test-password-hash' },
  });
}

async function seedAssessment(userId: string, input: AssessmentInput = baseInput) {
  return saveAssessment(userId, input, new Date('2026-09-16T12:00:00.000Z'));
}

async function previewDraft() {
  const response = await postPreview(
    jsonRequest('http://test.local/api/fitness/plans/preview', {}),
  );
  return (await response.json()) as { plan: { id: string }; activationRevision: number };
}

function activate(planId: string, expectedRevision: number) {
  return postActivate(
    jsonRequest('http://test.local/api/fitness/plans/x/activate', { expectedRevision }),
    idParams(planId),
  );
}

async function seedUserWithDraft(suffix: string, input: AssessmentInput = baseInput) {
  const user = await seedUser(suffix);
  await seedAssessment(user.id, input);
  actAs(user.id);
  const draft = await previewDraft();
  return { user, planId: draft.plan.id };
}

beforeEach(() => {
  mockUserId.mockReset();
});

describe('POST /api/fitness/plans/[id]/activate', () => {
  it('returns 401 without a session', async () => {
    actAs(null);
    expect((await activate('any', 0)).status).toBe(401);
  });

  it('returns 404 for another user plan', async () => {
    const owner = await seedUserWithDraft('act-owner');
    const stranger = await seedUser('act-stranger');
    actAs(stranger.id);

    expect((await activate(owner.planId, 0)).status).toBe(404);
    expect((await activate('missing-plan', 0)).status).toBe(404);
  });

  it('returns 409 PLAN_NOT_DRAFT for a plan that is not a draft', async () => {
    const { user, planId } = await seedUserWithDraft('act-not-draft');
    await db.fitnessPlanVersion.update({ where: { id: planId }, data: { status: 'SUPERSEDED' } });
    actAs(user.id);

    const response = await activate(planId, 0);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe('PLAN_NOT_DRAFT');
    expect(await db.program.count({ where: { userId: user.id } })).toBe(0);
  });

  it('returns 409 ACTIVATION_REVISION_CONFLICT with the latest revision', async () => {
    const { user, planId } = await seedUserWithDraft('act-revision');
    actAs(user.id);

    const response = await activate(planId, 3);
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe('ACTIVATION_REVISION_CONFLICT');
    expect(body.activationRevision).toBe(0);
    expect(await db.program.count({ where: { userId: user.id } })).toBe(0);
  });

  it('returns 409 WORKOUT_IN_PROGRESS while an unfinished session exists', async () => {
    const { user, planId } = await seedUserWithDraft('act-in-progress');
    await db.session.create({ data: { userId: user.id, startedAt: new Date() } });
    actAs(user.id);

    const response = await activate(planId, 0);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe('WORKOUT_IN_PROGRESS');
    expect(await db.program.count({ where: { userId: user.id } })).toBe(0);
    expect((await db.fitnessPlanVersion.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
      'DRAFT',
    );
  });

  it('returns 409 PLAN_INPUT_STALE when the assessment changed after the draft', async () => {
    const { user, planId } = await seedUserWithDraft('act-stale');
    await seedAssessment(
      user.id,
      inputWith((input) => {
        input.schedule.sessionDurationMin = 75;
      }),
    );
    actAs(user.id);

    const response = await activate(planId, 0);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe('PLAN_INPUT_STALE');
    expect(await db.program.count({ where: { userId: user.id } })).toBe(0);
  });

  it('activates when the same answers were saved again after the preview', async () => {
    const { user, planId } = await seedUserWithDraft('act-resaved');
    // Saving an assessment is append-only: it inserts a new screening and goal
    // row and bumps the profile timestamp even when nothing the plan depends on
    // changed. That must not invalidate a plan whose canonical input is equal.
    await seedAssessment(user.id);
    actAs(user.id);

    const response = await activate(planId, 0);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.activationRevision).toBe(1);
    expect(await db.program.count({ where: { userId: user.id } })).toBe(1);
    expect((await db.fitnessPlanVersion.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
      'ACTIVE',
    );
  });

  it('returns 409 PLAN_INPUT_STALE when the screening is no longer eligible', async () => {
    const { user, planId } = await seedUserWithDraft('act-ineligible');
    await seedAssessment(
      user.id,
      inputWith((input) => {
        input.health.temporarySignals = ['FEVER_OR_ACUTE_INFECTION'];
      }),
    );
    actAs(user.id);

    const response = await activate(planId, 0);
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe('PLAN_INPUT_STALE');
    expect(body.eligibilityStatus).toBe('TEMPORARY_HOLD');
    expect(await db.program.count({ where: { userId: user.id } })).toBe(0);
  });

  it('activates a novice plan with the two-week RIR buffer and managed metadata', async () => {
    const { user, planId } = await seedUserWithDraft(
      'act-novice',
      inputWith((input) => {
        input.profile.trainingAgeMonths = 3;
      }),
    );
    actAs(user.id);

    const response = await activate(planId, 0);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.activationRevision).toBe(1);
    expect(body.planId).toBe(planId);
    expect(body.rawScreeningAnswers).toBeUndefined();

    const plan = await db.fitnessPlanVersion.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.status).toBe('ACTIVE');
    expect(plan.programId).toBe(body.programId);
    expect(plan.activatedAt).not.toBeNull();

    const program = await db.program.findUniqueOrThrow({
      where: { id: body.programId },
      include: { workouts: { include: { exercises: true } } },
    });
    expect(program.userId).toBe(user.id);
    expect(program.isActive).toBe(true);
    // One workout per strength day in the composed plan.
    expect(program.workouts).toHaveLength(3);
    expect(program.workouts.map((workout) => workout.order)).toEqual([1, 2, 3]);

    const programExercises = program.workouts.flatMap((workout) => workout.exercises);
    expect(programExercises.length).toBeGreaterThan(0);
    for (const entry of programExercises) {
      expect(entry.progressionRuleVersion).toBe('double-progression-v2');
      expect(entry.targetRIR).toBe(2);
      expect(entry.introTargetRIR).toBe(3);
      expect(entry.introEndsAt!.getTime() - plan.activatedAt!.getTime()).toBe(14 * 86_400_000);
    }

    // The first working set starts from the recorded app load, not a guess.
    const bench = programExercises.find((entry) => entry.notes === 'catalog:bench_press');
    expect(bench).toBeDefined();
    expect(bench!.initialLoadKg).toBe(60);
    expect(bench!.initialLoadSource).toBe('USER_REPORTED');

    const activation = await db.fitnessPlanActivation.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(activation.planVersionId).toBe(planId);
    expect(activation.revision).toBe(1);
  });

  it('leaves the intro fields null for a non-novice plan', async () => {
    const { user, planId } = await seedUserWithDraft('act-experienced');
    actAs(user.id);

    const response = await activate(planId, 0);
    const body = await response.json();
    const programExp = await db.programExercise.findFirstOrThrow({
      where: { workout: { programId: body.programId } },
    });

    expect(programExp.progressionRuleVersion).toBe('double-progression-v2');
    expect(programExp.targetRIR).toBe(2);
    expect(programExp.introTargetRIR).toBeNull();
    expect(programExp.introEndsAt).toBeNull();
    expect(user.id).toBeTruthy();
  });

  it('re-activation preserves the old program and sessions and increments the revision', async () => {
    const { user, planId } = await seedUserWithDraft('act-second');
    actAs(user.id);
    const first = await (await activate(planId, 0)).json();
    const oldWorkout = await db.workout.findFirstOrThrow({
      where: { programId: first.programId },
    });
    const pastSession = await db.session.create({
      data: {
        userId: user.id,
        workoutId: oldWorkout.id,
        programId: first.programId,
        startedAt: new Date('2026-09-17T08:00:00Z'),
        finishedAt: new Date('2026-09-17T09:00:00Z'),
      },
    });

    await seedAssessment(
      user.id,
      inputWith((input) => {
        input.schedule.sessionDurationMin = 75;
      }),
    );
    const secondDraft = await previewDraft();
    const response = await activate(secondDraft.plan.id, 1);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.activationRevision).toBe(2);
    expect(body.programId).not.toBe(first.programId);

    const oldPlan = await db.fitnessPlanVersion.findUniqueOrThrow({ where: { id: planId } });
    expect(oldPlan.status).toBe('SUPERSEDED');
    expect(oldPlan.programId).toBe(first.programId);
    expect((await db.program.findUniqueOrThrow({ where: { id: first.programId } })).isActive).toBe(
      false,
    );
    const preserved = await db.session.findUniqueOrThrow({ where: { id: pastSession.id } });
    expect(preserved.programId).toBe(first.programId);

    // Activating the second plan also flips the previous ACTIVE version.
    expect(
      (await db.fitnessPlanVersion.findUniqueOrThrow({ where: { id: secondDraft.plan.id } }))
        .status,
    ).toBe('ACTIVE');
  });

  it('rolls back every activation write when materialization fails', async () => {
    const { user, planId } = await seedUserWithDraft('act-rollback');
    actAs(user.id);
    const plan = await db.fitnessPlanVersion.findUniqueOrThrow({ where: { id: planId } });
    const content = plan.content as {
      strength: { days: Array<{ exercises: Array<{ notes: string | null }> }> };
    };
    content.strength.days[0]!.exercises[0]!.notes = 'catalog:not_a_real_key';
    await db.fitnessPlanVersion.update({ where: { id: planId }, data: { content } });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await activate(planId, 0);
      expect(response.status).toBe(500);
    } finally {
      consoleError.mockRestore();
    }

    expect(await db.program.count({ where: { userId: user.id } })).toBe(0);
    const after = await db.fitnessPlanVersion.findUniqueOrThrow({ where: { id: planId } });
    expect(after.status).toBe('DRAFT');
    expect(after.programId).toBeNull();
    expect(await db.fitnessPlanActivation.findUnique({ where: { userId: user.id } })).toBeNull();
  });

  it('answers a parallel double activation with one success and one conflict', async () => {
    const { user, planId } = await seedUserWithDraft('act-parallel');
    actAs(user.id);

    const [first, second] = await Promise.all([activate(planId, 0), activate(planId, 0)]);
    const statuses = [first.status, second.status].sort();

    expect(statuses).toEqual([200, 409]);
    expect(await db.program.count({ where: { userId: user.id } })).toBe(1);
    expect(await db.program.count({ where: { userId: user.id, isActive: true } })).toBe(1);
    expect(
      await db.fitnessPlanVersion.count({ where: { userId: user.id, status: 'ACTIVE' } }),
    ).toBe(1);
    expect(
      (await db.fitnessPlanActivation.findUniqueOrThrow({ where: { userId: user.id } })).revision,
    ).toBe(1);
  });

  it('rejects starting a workout from a replaced managed program', async () => {
    const { user, planId } = await seedUserWithDraft('act-stale-workout');
    actAs(user.id);
    const first = await (await activate(planId, 0)).json();
    const oldWorkout = await db.workout.findFirstOrThrow({
      where: { programId: first.programId },
    });
    const startOldWorkout = () =>
      startSession(jsonRequest('http://test.local/api/sessions', { workoutId: oldWorkout.id }));

    // While the program is active the workout starts normally.
    expect((await startOldWorkout()).status).toBe(201);
    await db.session.updateMany({
      where: { userId: user.id, finishedAt: null },
      data: { finishedAt: new Date() },
    });

    await seedAssessment(
      user.id,
      inputWith((input) => {
        input.schedule.sessionDurationMin = 75;
      }),
    );
    const secondDraft = await previewDraft();
    expect((await activate(secondDraft.plan.id, 1)).status).toBe(200);

    const stale = await startOldWorkout();
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toBe('MANAGED_PROGRAM_STALE');
  });

  it('serializes a concurrent session start and activation on the user lock', async () => {
    const { user, planId } = await seedUserWithDraft('act-race');
    actAs(user.id);
    const first = await (await activate(planId, 0)).json();
    const oldWorkout = await db.workout.findFirstOrThrow({
      where: { programId: first.programId },
    });
    await seedAssessment(
      user.id,
      inputWith((input) => {
        input.schedule.sessionDurationMin = 75;
      }),
    );
    const secondDraft = await previewDraft();

    const [started, activated] = await Promise.all([
      startSession(jsonRequest('http://test.local/api/sessions', { workoutId: oldWorkout.id })),
      activate(secondDraft.plan.id, 1),
    ]);

    // Whichever order the lock grants, exactly one action wins and the loser is
    // told why - never both.
    expect([started.status, activated.status].sort()).toEqual([200, 409]);
  });
});
