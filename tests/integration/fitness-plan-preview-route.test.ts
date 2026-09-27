import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { getCurrentUserId } from '@/lib/auth';
import { saveAssessment } from '@/lib/fitness/assessment-store';
import { planPreviewRequestSchema, type AssessmentInput } from '@/lib/fitness/schemas';

vi.mock('@/lib/auth', () => ({ getCurrentUserId: vi.fn() }));
const mockUserId = vi.mocked(getCurrentUserId);

import { POST as postPreview } from '@/app/api/fitness/plans/preview/route';
import { GET as getPlans } from '@/app/api/fitness/plans/route';
import { GET as getPlan } from '@/app/api/fitness/plans/[id]/route';

const baseInput: AssessmentInput = {
  profile: {
    displayName: 'Ada Lovelace',
    ageYears: 30,
    displaySex: 'FEMALE',
    energyEquationReference: 'FEMALE',
    heightCm: 170,
    weightKg: 70,
    trainingAgeMonths: 18,
  },
  goal: {
    type: 'RECOMP',
    desiredWeeklyRatePct: 0,
  },
  schedule: {
    weeklyFrequency: 3,
    availableWeekdays: [5, 1, 3],
    sessionDurationMin: 60,
    equipmentTypes: ['CABLE', 'BARBELL'],
    recentMainLifts: [
      { catalogKey: 'cable_crunch', weightKg: 25, reps: 12, rir: 2 },
      { catalogKey: 'bench_press', weightKg: 60, reps: 8, rir: 2 },
    ],
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

// The stored clearance always carries a normalized `restrictions` value, while
// the submitted input omits it when the clearance is unrestricted. Fixtures
// therefore go through the same cast the rest of the suite uses.
function unrestrictedClearance(date: string): AssessmentInput['health']['clearance'] {
  return { date, unrestricted: true } as unknown as AssessmentInput['health']['clearance'];
}

function actAs(userId: string | null): void {
  mockUserId.mockResolvedValue(userId);
}

function previewRequest(body: unknown = {}): Request {
  return new Request('http://test.local/api/fitness/plans/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function idParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

function getRequest(): Request {
  return new Request('http://test.local/api/fitness/plans');
}

async function seedUser(suffix: string) {
  return db.user.create({
    data: { email: `${suffix}@plan-preview.test`, passwordHash: 'test-password-hash' },
  });
}

async function seedAssessment(userId: string, input: AssessmentInput = baseInput) {
  return saveAssessment(userId, input, new Date('2026-09-16T12:00:00.000Z'));
}

async function preview() {
  const response = await postPreview(previewRequest());
  return { response, body: await response.json() };
}

type PlanBody = {
  activationRevision: number;
  plan: {
    id: string;
    version: number;
    status: string;
    comparison: {
      previousPlanId: string;
      changes: Array<{ metric: string; before: unknown; after: unknown }>;
    } | null;
    content: {
      rulesVersion: string;
      reasons: string[];
      loadGuidance: Array<{ catalogKey: string; source: string; initialLoadKg: number | null }>;
      schedule: { days: unknown[] };
      strength: { days: Array<{ exercises: Array<{ name: string }> }> };
    };
  };
};

function exerciseNames(content: PlanBody['plan']['content']): string[] {
  return content.strength.days.flatMap((day) => day.exercises.map((exercise) => exercise.name));
}

beforeEach(() => {
  mockUserId.mockReset();
});

describe('POST /api/fitness/plans/preview', () => {
  it('returns 401 without a session', async () => {
    actAs(null);
    expect((await preview()).response.status).toBe(401);
    expect((await getPlans()).status).toBe(401);
  });

  it('rejects a body other than the empty object', async () => {
    const user = await seedUser('body');
    actAs(user.id);

    expect((await postPreview(previewRequest({ anything: true }))).status).toBe(400);
    expect(planPreviewRequestSchema.safeParse({}).success).toBe(true);
  });

  it('returns 409 ASSESSMENT_REQUIRED before the first assessment', async () => {
    const user = await seedUser('empty');
    actAs(user.id);

    const { response, body } = await preview();
    expect(response.status).toBe(409);
    expect(body.error).toBe('ASSESSMENT_REQUIRED');
    expect(await db.fitnessPlanVersion.count({ where: { userId: user.id } })).toBe(0);
  });

  it.each([
    [
      'a temporary hold',
      (input: AssessmentInput) => {
        input.health.temporarySignals = ['FEVER_OR_ACUTE_INFECTION'];
      },
    ],
    [
      'an expired clearance',
      (input: AssessmentInput) => {
        input.health.clearanceSignals = ['KNOWN_CARDIOVASCULAR_CONDITION'];
        input.health.clearance = unrestrictedClearance('2024-01-01');
      },
    ],
    [
      'a health change since clearance',
      (input: AssessmentInput) => {
        input.health.clearanceSignals = ['KNOWN_CARDIOVASCULAR_CONDITION'];
        input.health.clearance = unrestrictedClearance('2026-09-01');
        input.health.healthChangedSinceClearance = true;
      },
    ],
  ])('returns 409 FITNESS_NOT_ELIGIBLE for %s and stores nothing', async (label, mutate) => {
    const user = await seedUser(`ineligible-${label.replace(/\s+/g, '-')}`);
    await seedAssessment(user.id, inputWith(mutate));
    actAs(user.id);

    const { response, body } = await preview();
    expect(response.status).toBe(409);
    expect(body.error).toBe('FITNESS_NOT_ELIGIBLE');
    expect(typeof body.eligibilityStatus).toBe('string');
    expect(body.eligibilityStatus).not.toBe('ELIGIBLE');
    expect(Array.isArray(body.reasonCodes)).toBe(true);
    expect(body.reasonCodes.length).toBeGreaterThan(0);
    expect(await db.fitnessPlanVersion.count({ where: { userId: user.id } })).toBe(0);
  });

  it('creates a validated draft once and then reuses it', async () => {
    const user = await seedUser('create-reuse');
    await seedAssessment(user.id);
    actAs(user.id);

    const first = (await preview()) as { response: Response; body: PlanBody };
    expect(first.response.status).toBe(201);
    expect(first.body.activationRevision).toBe(0);
    expect(first.body.plan.version).toBe(1);
    expect(first.body.plan.status).toBe('DRAFT');
    expect(first.body.plan.comparison).toBeNull();
    expect(first.body.plan.content.rulesVersion).toBe('baseline-v1');
    expect(first.body.plan.content.schedule.days).toHaveLength(7);

    const second = (await preview()) as { response: Response; body: PlanBody };
    expect(second.response.status).toBe(200);
    expect(second.body.plan.id).toBe(first.body.plan.id);
    expect(JSON.stringify(second.body)).toBe(JSON.stringify(first.body));
    expect(await db.fitnessPlanVersion.count({ where: { userId: user.id } })).toBe(1);
  });

  it('supersedes the previous draft when a prescription input changes', async () => {
    const user = await seedUser('supersede');
    await seedAssessment(user.id);
    actAs(user.id);

    const first = (await preview()) as { response: Response; body: PlanBody };
    await seedAssessment(
      user.id,
      inputWith((input) => {
        input.schedule.sessionDurationMin = 75;
      }),
    );
    const second = (await preview()) as { response: Response; body: PlanBody };

    expect(second.response.status).toBe(201);
    expect(second.body.plan.version).toBe(2);
    const rows = await db.fitnessPlanVersion.findMany({
      where: { userId: user.id },
      orderBy: { version: 'asc' },
      select: { id: true, status: true },
    });
    expect(rows.map((row) => row.status)).toEqual(['SUPERSEDED', 'DRAFT']);
    expect(rows[0]!.id).toBe(first.body.plan.id);
  });

  it('reuses the draft for an equivalent input submitted in another order', async () => {
    const user = await seedUser('normalized');
    await seedAssessment(user.id);
    actAs(user.id);

    const first = (await preview()) as { response: Response; body: PlanBody };
    await seedAssessment(
      user.id,
      inputWith((input) => {
        input.schedule.availableWeekdays = [3, 5, 1];
        input.schedule.equipmentTypes = ['BARBELL', 'CABLE'];
      }),
    );
    const second = (await preview()) as { response: Response; body: PlanBody };

    expect(second.response.status).toBe(200);
    expect(second.body.plan.id).toBe(first.body.plan.id);
    const rows = await db.fitnessPlanVersion.findMany({
      where: { userId: user.id },
      select: { inputHash: true },
    });
    expect(new Set(rows.map((row) => row.inputHash)).size).toBe(1);
  });

  it('prefers app history over a user-reported lift and falls back to calibration', async () => {
    const user = await seedUser('evidence');
    await seedAssessment(user.id);
    const bench = await db.exercise.create({
      data: {
        userId: user.id,
        name: 'Bench Press',
        muscleGroup: 'CHEST',
        category: 'COMPOUND',
        equipmentType: 'BARBELL',
      },
    });
    const session = await db.session.create({
      data: { userId: user.id, startedAt: new Date(), finishedAt: new Date() },
    });
    await db.set.create({
      data: {
        sessionId: session.id,
        exerciseId: bench.id,
        setNumber: 1,
        weight: 80,
        reps: 8,
        rir: 2,
        completedAt: new Date(),
      },
    });
    actAs(user.id);

    const { body } = (await preview()) as { body: PlanBody };
    const guidance = body.plan.content.loadGuidance;
    expect(guidance.find((entry) => entry.catalogKey === 'bench_press')).toEqual({
      catalogKey: 'bench_press',
      source: 'APP_HISTORY',
      initialLoadKg: 80,
    });
    expect(body.plan.content.reasons).toContain('LOAD_APP_HISTORY');
    const calibration = guidance.filter((entry) => entry.source === 'CALIBRATION');
    expect(calibration.length).toBeGreaterThan(0);
    expect(calibration.every((entry) => entry.initialLoadKg === null)).toBe(true);
  });

  it('uses only calibration when neither app history nor a reported lift exists', async () => {
    const user = await seedUser('calibration-only');
    await seedAssessment(
      user.id,
      inputWith((input) => {
        input.schedule.recentMainLifts = [];
      }),
    );
    actAs(user.id);

    const { body } = (await preview()) as { body: PlanBody };
    expect(body.plan.content.loadGuidance.every((entry) => entry.source === 'CALIBRATION')).toBe(
      true,
    );
    expect(body.plan.content.reasons).toContain('LOAD_CALIBRATION_REQUIRED');
    expect(body.plan.content.reasons).not.toContain('LOAD_USER_REPORTED');
  });

  it('honours an unavailable exercise in the active gym and invalidates reuse when it changes', async () => {
    const user = await seedUser('gym-constraint');
    await seedAssessment(user.id);
    const bench = await db.exercise.create({
      data: {
        userId: user.id,
        name: 'Bench Press',
        muscleGroup: 'CHEST',
        category: 'COMPOUND',
        equipmentType: 'BARBELL',
      },
    });
    const gym = await db.gym.create({ data: { userId: user.id, name: 'Home' } });
    const config = await db.gymExerciseConfig.create({
      data: { gymId: gym.id, exerciseId: bench.id, isAvailable: false },
    });
    await db.user.update({ where: { id: user.id }, data: { activeGymId: gym.id } });
    actAs(user.id);

    const constrained = (await preview()) as { body: PlanBody };
    const names = exerciseNames(constrained.body.plan.content);
    expect(names).not.toContain('Bench Press');
    expect(names).toContain('Push-up');

    await db.gymExerciseConfig.update({ where: { id: config.id }, data: { isAvailable: true } });
    const relaxed = (await preview()) as { response: Response; body: PlanBody };

    expect(relaxed.response.status).toBe(201);
    expect(relaxed.body.plan.version).toBe(2);
    expect(exerciseNames(relaxed.body.plan.content)).toContain('Bench Press');
  });

  it('persists the normalized calculation input without display name or clearance free text', async () => {
    const user = await seedUser('persisted-input');
    await seedAssessment(
      user.id,
      inputWith((input) => {
        input.health.clearance = unrestrictedClearance('2026-09-01');
      }),
    );
    actAs(user.id);
    const before = new Date().toISOString().slice(0, 10);

    const { body } = (await preview()) as { body: PlanBody };
    const after = new Date().toISOString().slice(0, 10);

    const row = await db.fitnessPlanVersion.findUniqueOrThrow({ where: { id: body.plan.id } });
    const input = row.input as {
      calculationDate: string;
      assessment: {
        profile: Record<string, unknown>;
        health: { clearance?: { restrictions: string | null } | null };
        schedule: { availableWeekdays: number[]; equipmentTypes: string[] };
      };
      eligibility: { status: string; reasonCodes: string[]; clearanceExpiresAt: string | null };
    };
    expect([before, after]).toContain(input.calculationDate);
    expect(input.eligibility.status).toBe('ELIGIBLE');
    expect(input.eligibility.reasonCodes).toContain('ELIGIBLE_GENERAL_POPULATION');
    expect(input.assessment.schedule.availableWeekdays).toEqual([1, 3, 5]);
    expect(input.assessment.schedule.equipmentTypes).toContain('BODYWEIGHT');
    expect('displayName' in input.assessment.profile).toBe(false);
    expect(JSON.stringify(row.input)).not.toContain('Ada Lovelace');
    expect(input.assessment.health.clearance?.restrictions).toBeNull();
  });

  it('compares a replacement draft with the ACTIVE plan using stable metric codes', async () => {
    const user = await seedUser('comparison');
    await seedAssessment(user.id);
    actAs(user.id);

    const first = (await preview()) as { body: PlanBody };
    await db.fitnessPlanVersion.update({
      where: { id: first.body.plan.id },
      data: { status: 'ACTIVE', activatedAt: new Date() },
    });
    await db.fitnessPlanActivation.create({
      data: { userId: user.id, planVersionId: first.body.plan.id, revision: 1 },
    });

    await seedAssessment(
      user.id,
      inputWith((input) => {
        input.profile.weightKg = 75;
        input.lifestyle.currentModerateActivityMin = 30;
      }),
    );
    const second = (await preview()) as { response: Response; body: PlanBody };

    expect(second.response.status).toBe(201);
    expect(second.body.activationRevision).toBe(1);
    const comparison = second.body.plan.comparison!;
    expect(comparison.previousPlanId).toBe(first.body.plan.id);
    const metrics = comparison.changes.map((change) => change.metric);
    expect(metrics).toContain('CARDIO_MINUTES');
    expect(metrics).toContain('CALORIES');
    const cardio = comparison.changes.find((change) => change.metric === 'CARDIO_MINUTES')!;
    expect(cardio).toEqual({ metric: 'CARDIO_MINUTES', before: 30, after: 40 });
    const calories = comparison.changes.find((change) => change.metric === 'CALORIES')!;
    const beforeCalories = calories.before as { min: number; max: number };
    const afterCalories = calories.after as { min: number; max: number };
    expect(typeof beforeCalories.min).toBe('number');
    expect(afterCalories.max).toBeGreaterThan(beforeCalories.max);
    // Unchanged metrics are excluded.
    expect(metrics).not.toContain('STRENGTH_SPLIT');
    expect(metrics.every((metric) => metric === metric.toUpperCase())).toBe(true);
  });
});

describe('GET /api/fitness/plans', () => {
  it('lists only the caller versions, newest first, capped at fifty', async () => {
    const user = await seedUser('history');
    await seedAssessment(user.id);
    actAs(user.id);
    const { body } = (await preview()) as { body: PlanBody };
    const row = await db.fitnessPlanVersion.findUniqueOrThrow({ where: { id: body.plan.id } });
    const other = await seedUser('history-other');
    await db.fitnessPlanVersion.create({
      data: {
        userId: other.id,
        profileId: row.profileId,
        healthScreeningId: row.healthScreeningId,
        goalId: row.goalId,
        version: 1,
        status: 'DRAFT',
        rulesVersion: row.rulesVersion,
        inputHash: 'other-user-hash',
        profileUpdatedAt: row.profileUpdatedAt,
        input: {},
        content: {},
      },
    });
    await db.fitnessPlanVersion.createMany({
      data: Array.from({ length: 51 }, (_, index) => ({
        userId: user.id,
        profileId: row.profileId,
        healthScreeningId: row.healthScreeningId,
        goalId: row.goalId,
        version: index + 2,
        status: 'SUPERSEDED',
        rulesVersion: row.rulesVersion,
        inputHash: `hash-${index}`,
        profileUpdatedAt: row.profileUpdatedAt,
        input: {},
        content: {},
      })),
    });

    const response = await getPlans();
    expect(response.status).toBe(200);
    const history = (await response.json()) as { plans: Array<Record<string, unknown>> };
    expect(history.plans).toHaveLength(50);
    expect(history.plans[0]).toMatchObject({
      version: 52,
      status: 'SUPERSEDED',
      programId: null,
      activatedAt: null,
      goal: { type: 'RECOMP', desiredWeeklyRatePct: 0 },
    });
    expect(typeof history.plans[0]!.createdAt).toBe('string');
    const serialized = JSON.stringify(history);
    expect(serialized).not.toContain('inputHash');
    expect(serialized).not.toContain('"input"');
    expect(serialized).not.toContain(other.id);
  });
});

describe('GET /api/fitness/plans/[id]', () => {
  it('returns the owned plan with its activation revision', async () => {
    const user = await seedUser('read-own');
    await seedAssessment(user.id);
    actAs(user.id);
    const { body } = (await preview()) as { body: PlanBody };

    const response = await getPlan(getRequest(), idParams(body.plan.id));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.plan.id).toBe(body.plan.id);
    expect(payload.plan.content.schemaVersion).toBe(1);
    expect(payload.activationRevision).toBe(0);
  });

  it('returns 404 for another user plan and for an unknown id', async () => {
    const owner = await seedUser('read-owner');
    await seedAssessment(owner.id);
    actAs(owner.id);
    const { body } = (await preview()) as { body: PlanBody };

    const stranger = await seedUser('read-stranger');
    actAs(stranger.id);
    expect((await getPlan(getRequest(), idParams(body.plan.id))).status).toBe(404);
    expect((await getPlan(getRequest(), idParams('does-not-exist'))).status).toBe(404);
  });

  it('fails in a controlled way when the stored content is corrupt', async () => {
    const user = await seedUser('corrupt');
    await seedAssessment(user.id);
    actAs(user.id);
    const { body } = (await preview()) as { body: PlanBody };
    await db.fitnessPlanVersion.update({
      where: { id: body.plan.id },
      data: { content: { schemaVersion: 1, rulesVersion: 'baseline-v1', nonsense: true } },
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await getPlan(getRequest(), idParams(body.plan.id));
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Server error.' });
    } finally {
      consoleError.mockRestore();
    }
  });
});
