import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/prisma/generated/client';
import { db } from '@/lib/db';
import { getCurrentUserId } from '@/lib/auth';
import {
  assessmentResponseSchema,
  createAssessmentInputSchema,
  healthAnswersSchema,
  type AssessmentInput,
} from '@/lib/fitness/schemas';
import { getCurrentAssessment, saveAssessment } from '@/lib/fitness/assessment-store';
import { lockFitnessUser } from '@/lib/fitness/user-lock';
import { FITNESS_RULES_VERSION, FITNESS_SCREENING_VERSION } from '@/lib/fitness/versions';

vi.mock('@/lib/auth', () => ({ getCurrentUserId: vi.fn() }));
const mockUserId = vi.mocked(getCurrentUserId);

import { GET as getAssessment, PUT as putAssessment } from '@/app/api/fitness/assessment/route';
import { POST as skipOnboarding } from '@/app/api/fitness/onboarding/skip/route';
import { POST as postBodyweight } from '@/app/api/bodyweight/route';
import { PATCH as patchProfile } from '@/app/api/profile/route';
import { POST as postMeasurement } from '@/app/api/measurements/route';

const FIXTURE_NOW = new Date('2026-09-16T12:00:00.000Z');

const baseInput: AssessmentInput = {
  profile: {
    displayName: '  Ada Lovelace  ',
    ageYears: 30,
    displaySex: 'FEMALE',
    energyEquationReference: 'FEMALE',
    heightCm: 170,
    weightKg: 70,
    waistCm: 81,
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

function actAs(userId: string | null): void {
  mockUserId.mockResolvedValue(userId);
}

function jsonRequest(method: string, body: unknown): Request {
  return new Request('http://test.local/api/fitness/assessment', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function rawRequest(method: string, body: string): Request {
  return new Request('http://test.local/api/fitness/assessment', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

async function seedUser(suffix = 'owner', unit: 'KG' | 'LB' = 'KG') {
  return db.user.create({
    data: {
      email: `${suffix}@assessment.test`,
      passwordHash: 'test-password-hash',
      unit,
    },
  });
}

async function fitnessWriteCounts(userId: string) {
  const [profiles, screenings, goals, plans, bodyweights, measurements] = await Promise.all([
    db.fitnessProfile.count({ where: { userId } }),
    db.healthScreening.count({ where: { userId } }),
    db.fitnessGoal.count({ where: { userId } }),
    db.fitnessPlanVersion.count({ where: { userId } }),
    db.bodyweightEntry.count({ where: { userId } }),
    db.bodyMeasurement.count({ where: { userId } }),
  ]);
  return { profiles, screenings, goals, plans, bodyweights, measurements };
}

async function put(input: AssessmentInput): Promise<Response> {
  return putAssessment(jsonRequest('PUT', input));
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitForAdvisoryWaiters(holderPid: number, minimum: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [row] = await db.$queryRaw<Array<{ count: number }>>`
      SELECT count(DISTINCT waiting.pid)::int AS count
      FROM pg_locks AS held
      JOIN pg_locks AS waiting
        ON waiting.locktype = held.locktype
        AND waiting.database IS NOT DISTINCT FROM held.database
        AND waiting.classid IS NOT DISTINCT FROM held.classid
        AND waiting.objid IS NOT DISTINCT FROM held.objid
        AND waiting.objsubid IS NOT DISTINCT FROM held.objsubid
      WHERE held.pid = ${holderPid}
        AND held.locktype = 'advisory'
        AND held.granted = true
        AND waiting.granted = false
    `;
    if ((row?.count ?? 0) >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${minimum} advisory lock waiter(s)`);
}

beforeEach(() => {
  mockUserId.mockReset();
});

describe('assessment authentication and validation', () => {
  it('returns 401 for unauthenticated GET and PUT', async () => {
    actAs(null);

    expect((await getAssessment()).status).toBe(401);
    expect((await put(baseInput)).status).toBe(401);
  });

  it.each([
    ['malformed JSON', rawRequest('PUT', '{')],
    ['incomplete input', jsonRequest('PUT', {})],
    ['strict extra fields', jsonRequest('PUT', { ...baseInput, unexpected: true })],
    [
      'out-of-bound input',
      jsonRequest(
        'PUT',
        inputWith((input) => {
          input.profile.weightKg = 301;
        }),
      ),
    ],
    [
      'fractional legacy height',
      jsonRequest(
        'PUT',
        inputWith((input) => {
          input.profile.heightCm = 170.5;
        }),
      ),
    ],
  ])('rejects %s without writes', async (_label, request) => {
    const user = await seedUser();
    actAs(user.id);

    expect((await putAssessment(request)).status).toBe(400);
    expect(await fitnessWriteCounts(user.id)).toEqual({
      profiles: 0,
      screenings: 0,
      goals: 0,
      plans: 0,
      bodyweights: 0,
      measurements: 0,
    });
  });

  it('rejects bodies larger than 32768 raw bytes with 413 and no writes', async () => {
    const user = await seedUser();
    actAs(user.id);
    const oversized = JSON.stringify({ ...baseInput, padding: 'x'.repeat(33_000) });

    expect((await putAssessment(rawRequest('PUT', oversized))).status).toBe(413);
    expect(await fitnessWriteCounts(user.id)).toEqual({
      profiles: 0,
      screenings: 0,
      goals: 0,
      plans: 0,
      bodyweights: 0,
      measurements: 0,
    });
  });
});

describe('PUT /api/fitness/assessment', () => {
  it('normalizes an eligible assessment and persists the complete legacy and fitness snapshot', async () => {
    const user = await seedUser('eligible', 'LB');
    actAs(user.id);

    const response = await put(baseInput);
    expect(response.status).toBe(200);
    const body = assessmentResponseSchema.parse(await response.json());

    expect(body).toMatchObject({
      activationRevision: 0,
      onboardingRequired: false,
      unit: 'LB',
      assessment: {
        profile: {
          displayName: 'Ada Lovelace',
          heightCm: 170,
          waistCm: 81,
          bodyFatPct: null,
        },
        goal: { targetWeightKg: null, targetDate: null },
        schedule: {
          availableWeekdays: [1, 3, 5],
          equipmentTypes: ['BARBELL', 'CABLE', 'BODYWEIGHT'],
          recentMainLifts: [
            { catalogKey: 'bench_press', weightKg: 60, reps: 8, rir: 2 },
            { catalogKey: 'cable_crunch', weightKg: 25, reps: 12, rir: 2 },
          ],
        },
        lifestyle: { avgDailySteps: null },
        health: { clearance: null },
        eligibility: {
          status: 'ELIGIBLE',
          reasonCodes: ['ELIGIBLE_GENERAL_POPULATION'],
          clearanceExpiresAt: null,
        },
      },
    });

    const [storedUser, profile, bodyweight, waist, goal, screening] = await Promise.all([
      db.user.findUniqueOrThrow({ where: { id: user.id } }),
      db.fitnessProfile.findUniqueOrThrow({ where: { userId: user.id } }),
      db.bodyweightEntry.findFirstOrThrow({ where: { userId: user.id } }),
      db.bodyMeasurement.findFirstOrThrow({ where: { userId: user.id, site: 'WAIST' } }),
      db.fitnessGoal.findFirstOrThrow({ where: { userId: user.id } }),
      db.healthScreening.findFirstOrThrow({ where: { userId: user.id } }),
    ]);
    expect(storedUser).toMatchObject({
      displayName: 'Ada Lovelace',
      bodyweight: 70,
      sex: 'FEMALE',
      heightCm: 170,
      goal: 'RECOMP',
      weeklyFrequency: 3,
      fitnessOnboardingRequired: false,
    });
    expect(profile).toMatchObject({
      userId: user.id,
      ageYears: 30,
      displaySex: 'FEMALE',
      energyEquationReference: 'FEMALE',
      bodyFatPct: null,
      equipmentTypes: ['BARBELL', 'CABLE', 'BODYWEIGHT'],
    });
    expect(profile.recentMainLifts).toEqual(body.assessment?.schedule.recentMainLifts);
    expect(bodyweight.weightKg).toBe(70);
    expect(waist).toMatchObject({ site: 'WAIST', valueCm: 81 });
    expect(goal).toMatchObject({ status: 'ACTIVE', type: 'RECOMP', targetWeightKg: null });
    expect(goal.targetDate).toBeNull();
    expect(screening).toMatchObject({
      status: 'ELIGIBLE',
      screeningVersion: FITNESS_SCREENING_VERSION,
      rulesVersion: FITNESS_RULES_VERSION,
      reasonCodes: ['ELIGIBLE_GENERAL_POPULATION'],
    });
    expect(await fitnessWriteCounts(user.id)).toEqual({
      profiles: 1,
      screenings: 1,
      goals: 1,
      plans: 0,
      bodyweights: 1,
      measurements: 1,
    });
  });

  it('sorts every health signal family before evaluation, persistence, and response', async () => {
    const user = await seedUser('signals');
    actAs(user.id);
    const input = inputWith((candidate) => {
      candidate.health.urgentSignals = [
        'SEVERE_BREATHING_DIFFICULTY',
        'CURRENT_CHEST_PRESSURE_OR_PAIN',
      ];
      candidate.health.clearanceSignals = [
        'UNUSUAL_SHORTNESS_OF_BREATH',
        'KNOWN_CARDIOVASCULAR_CONDITION',
      ];
      candidate.health.temporarySignals = [
        'RECENT_SURGERY_WITHOUT_RETURN_CLEARANCE',
        'FEVER_OR_ACUTE_INFECTION',
      ];
      candidate.health.scopeSignals = [
        'ACTIVE_EATING_DISORDER_TREATMENT',
        'PREGNANT_OR_POSTPARTUM',
      ];
    });

    const response = await put(input);
    expect(response.status).toBe(200);
    const saved = assessmentResponseSchema.parse(await response.json());
    expect(saved.assessment?.health).toMatchObject({
      urgentSignals: ['CURRENT_CHEST_PRESSURE_OR_PAIN', 'SEVERE_BREATHING_DIFFICULTY'],
      clearanceSignals: ['KNOWN_CARDIOVASCULAR_CONDITION', 'UNUSUAL_SHORTNESS_OF_BREATH'],
      temporarySignals: ['FEVER_OR_ACUTE_INFECTION', 'RECENT_SURGERY_WITHOUT_RETURN_CLEARANCE'],
      scopeSignals: ['PREGNANT_OR_POSTPARTUM', 'ACTIVE_EATING_DISORDER_TREATMENT'],
    });
    const storedHealth = healthAnswersSchema.parse(
      (await db.healthScreening.findFirstOrThrow({ where: { userId: user.id } })).answers,
    );
    expect(storedHealth.urgentSignals).toEqual(saved.assessment?.health.urgentSignals);
    expect(storedHealth.clearanceSignals).toEqual(saved.assessment?.health.clearanceSignals);
    expect(storedHealth.temporarySignals).toEqual(saved.assessment?.health.temporarySignals);
    expect(storedHealth.scopeSignals).toEqual(saved.assessment?.health.scopeSignals);
    expect(assessmentResponseSchema.parse(await (await getAssessment()).json())).toEqual(saved);
  });

  it.each([
    ['MALE', 'FEMALE', 'MALE'],
    ['FEMALE', 'MALE', 'FEMALE'],
    ['OTHER', 'MALE', 'OTHER'],
    ['PREFER_NOT_TO_SAY', 'FEMALE', null],
  ] as const)(
    'maps display sex %s to legacy sex without using energy reference %s',
    async (displaySex, energyEquationReference, expectedSex) => {
      const user = await seedUser(`sex-${displaySex.toLowerCase()}`);
      actAs(user.id);
      const input = inputWith((candidate) => {
        candidate.profile.displaySex = displaySex;
        candidate.profile.energyEquationReference = energyEquationReference;
      });

      expect((await put(input)).status).toBe(200);
      expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).sex).toBe(expectedSex);
    },
  );

  it('stores target dates as UTC calendar dates and persists a blocked assessment without a plan', async () => {
    const user = await seedUser('blocked');
    actAs(user.id);
    const input = inputWith((candidate) => {
      candidate.goal = {
        type: 'FAT_LOSS',
        desiredWeeklyRatePct: -0.5,
        targetWeightKg: 65,
        targetDate: '2027-03-10',
      };
      candidate.health.clearanceSignals = ['KNOWN_CARDIOVASCULAR_CONDITION'];
      candidate.health.clearance = {
        date: '2026-09-01',
        unrestricted: false,
        restrictions: '  avoid maximal lifts  ',
      };
    });

    const response = await put(input);
    expect(response.status).toBe(200);
    const body = assessmentResponseSchema.parse(await response.json());
    expect(body.onboardingRequired).toBe(false);
    expect(body.assessment?.eligibility.status).toBe('OUT_OF_SCOPE');
    expect(body.assessment?.health.clearance).toEqual({
      date: '2026-09-01',
      unrestricted: false,
      restrictions: 'avoid maximal lifts',
    });

    const [goal, screening, storedUser] = await Promise.all([
      db.fitnessGoal.findFirstOrThrow({ where: { userId: user.id } }),
      db.healthScreening.findFirstOrThrow({ where: { userId: user.id } }),
      db.user.findUniqueOrThrow({ where: { id: user.id } }),
    ]);
    expect(goal.targetWeightKg).toBe(65);
    expect(goal.targetDate?.toISOString()).toBe('2027-03-10T00:00:00.000Z');
    expect(screening.clearanceDate?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(screening.answers).toEqual(body.assessment?.health);
    expect(storedUser.fitnessOnboardingRequired).toBe(false);
    expect(await db.fitnessPlanVersion.count({ where: { userId: user.id } })).toBe(0);
  });

  it('updates one profile while superseding the old goal and appending an immutable screening', async () => {
    const user = await seedUser('updates');
    actAs(user.id);
    expect((await put(baseInput)).status).toBe(200);
    const firstScreening = await db.healthScreening.findFirstOrThrow({
      where: { userId: user.id },
    });
    const firstGoal = await db.fitnessGoal.findFirstOrThrow({ where: { userId: user.id } });

    const secondInput = inputWith((candidate) => {
      candidate.profile.displayName = ' Grace Hopper ';
      candidate.profile.trainingAgeMonths = 36;
      candidate.health.temporarySignals = ['FEVER_OR_ACUTE_INFECTION'];
    });
    expect((await put(secondInput)).status).toBe(200);

    const [profiles, goals, screenings, originalScreening] = await Promise.all([
      db.fitnessProfile.findMany({ where: { userId: user.id } }),
      db.fitnessGoal.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } }),
      db.healthScreening.findMany({ where: { userId: user.id } }),
      db.healthScreening.findUniqueOrThrow({ where: { id: firstScreening.id } }),
    ]);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ trainingAgeMonths: 36 });
    expect(goals).toHaveLength(2);
    expect(goals.find((goal) => goal.id === firstGoal.id)).toMatchObject({ status: 'SUPERSEDED' });
    expect(goals.find((goal) => goal.id === firstGoal.id)?.supersededAt).not.toBeNull();
    expect(goals.filter((goal) => goal.status === 'ACTIVE')).toHaveLength(1);
    expect(screenings).toHaveLength(2);
    expect(originalScreening).toEqual(firstScreening);
  });

  it('deduplicates unchanged measurements, appends changed values, and preserves omitted waist history', async () => {
    const user = await seedUser('measurements');
    actAs(user.id);
    expect((await put(baseInput)).status).toBe(200);

    const omittedWaist = inputWith((candidate) => {
      delete candidate.profile.waistCm;
    });
    const unchanged = await put(omittedWaist);
    expect(unchanged.status).toBe(200);
    expect(assessmentResponseSchema.parse(await unchanged.json()).assessment?.profile.waistCm).toBe(
      81,
    );
    expect(await db.bodyweightEntry.count({ where: { userId: user.id } })).toBe(1);
    expect(await db.bodyMeasurement.count({ where: { userId: user.id, site: 'WAIST' } })).toBe(1);

    const changed = inputWith((candidate) => {
      candidate.profile.weightKg = 71;
      candidate.profile.waistCm = 82;
    });
    expect((await put(changed)).status).toBe(200);
    expect(await db.bodyweightEntry.count({ where: { userId: user.id } })).toBe(2);
    expect(await db.bodyMeasurement.count({ where: { userId: user.id, site: 'WAIST' } })).toBe(2);

    omittedWaist.profile.weightKg = 71;
    const preserved = await put(omittedWaist);
    expect(preserved.status).toBe(200);
    expect(assessmentResponseSchema.parse(await preserved.json()).assessment?.profile.waistCm).toBe(
      82,
    );
    expect(await db.bodyweightEntry.count({ where: { userId: user.id } })).toBe(2);
    expect(await db.bodyMeasurement.count({ where: { userId: user.id, site: 'WAIST' } })).toBe(2);
  });

  it('does not append measurements when explicit weight and waist values are saved unchanged', async () => {
    const user = await seedUser('explicit-measurements');
    actAs(user.id);
    expect((await put(baseInput)).status).toBe(200);
    expect(await db.bodyweightEntry.count({ where: { userId: user.id } })).toBe(1);
    expect(await db.bodyMeasurement.count({ where: { userId: user.id, site: 'WAIST' } })).toBe(1);

    expect((await put(baseInput)).status).toBe(200);

    expect(await db.bodyweightEntry.count({ where: { userId: user.id } })).toBe(1);
    expect(await db.bodyMeasurement.count({ where: { userId: user.id, site: 'WAIST' } })).toBe(1);
  });

  it('serializes concurrent saves into complete snapshots with exactly one active goal', async () => {
    const user = await seedUser('concurrent');
    actAs(user.id);
    const alpha = inputWith((candidate) => {
      candidate.profile.displayName = 'Alpha';
      candidate.profile.weightKg = 72;
      candidate.profile.waistCm = 82;
      candidate.profile.trainingAgeMonths = 20;
      candidate.lifestyle.avgDailySteps = 7_000;
    });
    const beta = inputWith((candidate) => {
      candidate.profile.displayName = 'Beta';
      candidate.profile.weightKg = 74;
      candidate.profile.waistCm = 84;
      candidate.profile.trainingAgeMonths = 40;
      candidate.lifestyle.avgDailySteps = 11_000;
      candidate.health.temporarySignals = ['MAJOR_RECENT_HEALTH_OR_MEDICATION_CHANGE'];
    });

    const responses = await Promise.all([put(alpha), put(beta)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const savedBodies = await Promise.all(
      responses.map(async (response) => assessmentResponseSchema.parse(await response.json())),
    );
    const current = assessmentResponseSchema.parse(await (await getAssessment()).json());

    expect(savedBodies).toContainEqual(current);
    expect(await db.fitnessGoal.count({ where: { userId: user.id, status: 'ACTIVE' } })).toBe(1);
    expect(await db.fitnessProfile.count({ where: { userId: user.id } })).toBe(1);
    expect(await db.healthScreening.count({ where: { userId: user.id } })).toBe(2);
  });

  it('makes the last lock winner current when its captured time predates the first winner', async () => {
    const user = await seedUser('reverse-time');
    const firstWinnerInput = inputWith((candidate) => {
      candidate.profile.displayName = 'First Lock Winner';
      candidate.profile.weightKg = 72;
      candidate.profile.waistCm = 82;
      candidate.profile.trainingAgeMonths = 20;
      candidate.lifestyle.avgDailySteps = 7_000;
    });
    const lastWinnerInput = inputWith((candidate) => {
      candidate.profile.displayName = 'Last Lock Winner';
      candidate.profile.weightKg = 74;
      candidate.profile.waistCm = 84;
      candidate.profile.trainingAgeMonths = 40;
      candidate.lifestyle.avgDailySteps = 11_000;
      candidate.health.temporarySignals = ['MAJOR_RECENT_HEALTH_OR_MEDICATION_CHANGE'];
    });
    const blockerReady = deferred();
    const releaseBlocker = deferred();
    let blockerPid = 0;
    const blocker = db.$transaction(async (tx) => {
      await lockFitnessUser(tx, user.id);
      const [connection] = await tx.$queryRaw<Array<{ pid: number }>>`
        SELECT pg_backend_pid()::int AS pid
      `;
      blockerPid = connection!.pid;
      blockerReady.resolve();
      await releaseBlocker.promise;
    });
    await blockerReady.promise;

    let firstWinner!: Promise<Awaited<ReturnType<typeof saveAssessment>>>;
    let lastWinner!: Promise<Awaited<ReturnType<typeof saveAssessment>>>;
    try {
      firstWinner = saveAssessment(user.id, firstWinnerInput, new Date('2026-09-16T12:00:00.000Z'));
      await waitForAdvisoryWaiters(blockerPid, 1);
      lastWinner = saveAssessment(user.id, lastWinnerInput, new Date('2026-09-15T12:00:00.000Z'));
      await waitForAdvisoryWaiters(blockerPid, 2);
    } finally {
      releaseBlocker.resolve();
    }

    const [, expectedCurrent] = await Promise.all([firstWinner, lastWinner, blocker]);
    const current = await getCurrentAssessment(user.id);
    const [latestScreening, latestBodyweight, latestWaist, activeGoal, profile] = await Promise.all(
      [
        db.healthScreening.findFirstOrThrow({
          where: { userId: user.id },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
        db.bodyweightEntry.findFirstOrThrow({
          where: { userId: user.id },
          orderBy: [{ measuredAt: 'desc' }, { id: 'desc' }],
        }),
        db.bodyMeasurement.findFirstOrThrow({
          where: { userId: user.id, site: 'WAIST' },
          orderBy: [{ measuredAt: 'desc' }, { id: 'desc' }],
        }),
        db.fitnessGoal.findFirstOrThrow({ where: { userId: user.id, status: 'ACTIVE' } }),
        db.fitnessProfile.findUniqueOrThrow({ where: { userId: user.id } }),
      ],
    );
    const expectedPersistedAt = '2026-09-16T12:00:00.001Z';
    expect(latestScreening.createdAt.toISOString()).toBe(expectedPersistedAt);
    expect(latestScreening.attestedAt.toISOString()).toBe(expectedPersistedAt);
    expect(latestBodyweight.measuredAt.toISOString()).toBe(expectedPersistedAt);
    expect(latestWaist.measuredAt.toISOString()).toBe(expectedPersistedAt);
    expect(activeGoal.createdAt.toISOString()).toBe(expectedPersistedAt);
    expect(profile.updatedAt.toISOString()).toBe(expectedPersistedAt);
    expect(current).toEqual(expectedCurrent);
    expect(current.assessment).toMatchObject({
      profile: {
        displayName: 'Last Lock Winner',
        weightKg: 74,
        waistCm: 84,
        trainingAgeMonths: 40,
      },
      lifestyle: { avgDailySteps: 11_000 },
      health: { temporarySignals: ['MAJOR_RECENT_HEALTH_OR_MEDICATION_CHANGE'] },
      eligibility: { status: 'TEMPORARY_HOLD' },
    });
    expect(await db.fitnessGoal.count({ where: { userId: user.id, status: 'ACTIVE' } })).toBe(1);
  });
});

describe('GET /api/fitness/assessment', () => {
  it('returns the exact schema-valid null envelope before the first complete assessment', async () => {
    const user = await seedUser('empty', 'LB');
    actAs(user.id);

    const response = await getAssessment();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      assessment: null,
      activationRevision: 0,
      onboardingRequired: true,
      unit: 'LB',
    });
    expect(assessmentResponseSchema.parse(body)).toEqual(body);
  });

  it('runs all seven assessment reads in one repeatable-read transaction', async () => {
    const user = await seedUser('transaction-reads');
    actAs(user.id);
    expect((await put(baseInput)).status).toBe(200);
    const rootReadSpies = [
      vi.spyOn(db.user, 'findUniqueOrThrow'),
      vi.spyOn(db.fitnessProfile, 'findUnique'),
      vi.spyOn(db.healthScreening, 'findFirst'),
      vi.spyOn(db.fitnessGoal, 'findFirst'),
      vi.spyOn(db.bodyweightEntry, 'findFirst'),
      vi.spyOn(db.bodyMeasurement, 'findFirst'),
      vi.spyOn(db.fitnessPlanActivation, 'findUnique'),
    ];
    const transactionSpy = vi.spyOn(db, '$transaction');

    try {
      expect((await getCurrentAssessment(user.id)).assessment).not.toBeNull();
      expect(transactionSpy).toHaveBeenCalledTimes(1);
      const [operation, options] = transactionSpy.mock.calls[0]!;
      expect(typeof operation).toBe('function');
      expect(options).toEqual({ isolationLevel: 'RepeatableRead' });
      for (const rootReadSpy of rootReadSpies) {
        expect(rootReadSpy).not.toHaveBeenCalled();
      }
    } finally {
      transactionSpy.mockRestore();
      for (const rootReadSpy of rootReadSpies) rootReadSpy.mockRestore();
    }
  });

  it('returns one coherent snapshot when a save commits after its first snapshot read', async () => {
    const user = await seedUser('repeatable-read');
    const assessmentA = inputWith((candidate) => {
      candidate.profile.displayName = 'Snapshot A';
      candidate.profile.weightKg = 72;
      candidate.profile.waistCm = 82;
      candidate.profile.trainingAgeMonths = 20;
    });
    const assessmentB = inputWith((candidate) => {
      candidate.profile.displayName = 'Snapshot B';
      candidate.profile.weightKg = 74;
      candidate.profile.waistCm = 84;
      candidate.profile.trainingAgeMonths = 40;
      candidate.health.temporarySignals = ['FEVER_OR_ACUTE_INFECTION'];
    });
    const expectedA = await saveAssessment(user.id, assessmentA, new Date('2026-09-15T12:00:00Z'));
    const snapshotEstablished = deferred();
    const resumeGetter = deferred();
    type TransactionOptions = {
      maxWait?: number;
      timeout?: number;
      isolationLevel?: Prisma.TransactionIsolationLevel;
    };
    type InteractiveTransaction = <T>(
      operation: (tx: Prisma.TransactionClient) => Promise<T>,
      options?: TransactionOptions,
    ) => Promise<T>;
    const runInteractive = db.$transaction.bind(db) as InteractiveTransaction;
    const transactionSpy = vi.spyOn(db, '$transaction');
    let wrappedGetter = false;
    transactionSpy.mockImplementation(((
      operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
      options?: TransactionOptions,
    ) => {
      if (wrappedGetter) return runInteractive(operation, options);
      wrappedGetter = true;
      return runInteractive(async (tx) => {
        await tx.user.findUniqueOrThrow({ where: { id: user.id }, select: { id: true } });
        snapshotEstablished.resolve();
        await resumeGetter.promise;
        return operation(tx);
      }, options);
    }) as never);

    const getter = getCurrentAssessment(user.id);
    try {
      const state = await Promise.race([
        snapshotEstablished.promise.then(() => 'snapshot-established' as const),
        getter.then(() => 'getter-completed' as const),
      ]);
      expect(state).toBe('snapshot-established');
      const savedB = await saveAssessment(user.id, assessmentB, new Date('2026-09-16T12:00:00Z'));
      expect(savedB).not.toEqual(expectedA);
      resumeGetter.resolve();

      expect(await getter).toEqual(expectedA);
    } finally {
      resumeGetter.resolve();
      await Promise.allSettled([getter]);
      transactionSpy.mockRestore();
    }
  });

  it('returns a null assessment when the legacy height source is missing', async () => {
    const user = await seedUser('missing-height');
    actAs(user.id);
    expect((await put(baseInput)).status).toBe(200);
    await db.user.update({ where: { id: user.id }, data: { heightCm: null } });

    const body = assessmentResponseSchema.parse(await (await getAssessment()).json());
    expect(body).toEqual({
      assessment: null,
      activationRevision: 0,
      onboardingRequired: false,
      unit: 'KG',
    });
  });

  it('returns a null assessment when both current bodyweight sources are missing', async () => {
    const user = await seedUser('missing-weight');
    actAs(user.id);
    expect((await put(baseInput)).status).toBe(200);
    await db.bodyweightEntry.deleteMany({ where: { userId: user.id } });
    await db.user.update({ where: { id: user.id }, data: { bodyweight: null } });

    const body = assessmentResponseSchema.parse(await (await getAssessment()).json());
    expect(body).toEqual({
      assessment: null,
      activationRevision: 0,
      onboardingRequired: false,
      unit: 'KG',
    });
  });

  it('uses the latest bodyweight entry when the legacy bodyweight source is missing', async () => {
    const user = await seedUser('entry-weight');
    actAs(user.id);
    expect((await put(baseInput)).status).toBe(200);
    await db.user.update({ where: { id: user.id }, data: { bodyweight: null } });

    const body = assessmentResponseSchema.parse(await (await getAssessment()).json());
    expect(body.assessment?.profile.weightKg).toBe(70);
  });

  it('returns a null assessment when a supported bodyweight entry is below assessment bounds', async () => {
    const user = await seedUser('legacy-weight');
    actAs(user.id);
    expect((await put(baseInput)).status).toBe(200);
    expect((await postBodyweight(jsonRequest('POST', { weightKg: 30 }))).status).toBe(201);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await getAssessment();
    consoleError.mockRestore();

    expect(response.status).toBe(200);
    expect(assessmentResponseSchema.parse(await response.json()).assessment).toBeNull();
  });

  it('returns a null assessment when a supported legacy height is below assessment bounds', async () => {
    const user = await seedUser('legacy-height');
    actAs(user.id);
    expect((await put(baseInput)).status).toBe(200);
    expect((await patchProfile(jsonRequest('PATCH', { heightCm: 110 }))).status).toBe(200);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await getAssessment();
    consoleError.mockRestore();

    expect(response.status).toBe(200);
    expect(assessmentResponseSchema.parse(await response.json()).assessment).toBeNull();
  });

  it('omits a supported legacy waist measurement below assessment bounds', async () => {
    const user = await seedUser('legacy-waist');
    actAs(user.id);
    expect((await put(baseInput)).status).toBe(200);
    expect(
      (await postMeasurement(jsonRequest('POST', { site: 'WAIST', valueCm: 30 }))).status,
    ).toBe(201);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await getAssessment();
    consoleError.mockRestore();

    expect(response.status).toBe(200);
    const body = assessmentResponseSchema.parse(await response.json());
    expect(body.assessment).not.toBeNull();
    expect(body.assessment?.profile.waistCm).toBeNull();
  });

  it('returns only the authenticated user assessment', async () => {
    const [owner, stranger] = await Promise.all([seedUser('owner'), seedUser('stranger')]);
    actAs(owner.id);
    expect(
      (
        await put(
          inputWith((candidate) => {
            candidate.profile.displayName = 'Owner';
          }),
        )
      ).status,
    ).toBe(200);
    actAs(stranger.id);
    expect(
      (
        await put(
          inputWith((candidate) => {
            candidate.profile.displayName = 'Stranger';
          }),
        )
      ).status,
    ).toBe(200);

    actAs(owner.id);
    const body = assessmentResponseSchema.parse(await (await getAssessment()).json());
    expect(body.assessment?.profile.displayName).toBe('Owner');
    expect(JSON.stringify(body)).not.toContain(stranger.id);
    expect(JSON.stringify(body)).not.toContain('Stranger');
  });

  it('orders equal-time screening, goal, bodyweight, and waist rows by descending id', async () => {
    const user = await seedUser('ties');
    actAs(user.id);
    expect((await put(baseInput)).status).toBe(200);
    const tie = new Date('2026-09-15T00:00:00.000Z');
    await Promise.all([
      db.healthScreening.updateMany({ where: { userId: user.id }, data: { createdAt: tie } }),
      db.fitnessGoal.updateMany({ where: { userId: user.id }, data: { createdAt: tie } }),
      db.bodyweightEntry.updateMany({ where: { userId: user.id }, data: { measuredAt: tie } }),
      db.bodyMeasurement.updateMany({ where: { userId: user.id }, data: { measuredAt: tie } }),
    ]);
    const tieInput = createAssessmentInputSchema(FIXTURE_NOW).parse(
      inputWith((candidate) => {
        candidate.health.temporarySignals = ['FEVER_OR_ACUTE_INFECTION'];
      }),
    );
    await Promise.all([
      db.healthScreening.create({
        data: {
          id: 'zz-screening',
          userId: user.id,
          screeningVersion: FITNESS_SCREENING_VERSION,
          rulesVersion: FITNESS_RULES_VERSION,
          answers: tieInput.health,
          status: 'TEMPORARY_HOLD',
          reasonCodes: ['HOLD_ACUTE_ILLNESS'],
          attestedAt: tie,
          createdAt: tie,
        },
      }),
      db.fitnessGoal.create({
        data: {
          id: 'zz-goal',
          userId: user.id,
          type: 'RECOMP',
          desiredWeeklyRatePct: 0.2,
          status: 'ACTIVE',
          createdAt: tie,
        },
      }),
      db.bodyweightEntry.create({
        data: { id: 'zz-bodyweight', userId: user.id, weightKg: 73, measuredAt: tie },
      }),
      db.bodyMeasurement.create({
        data: { id: 'zz-waist', userId: user.id, site: 'WAIST', valueCm: 83, measuredAt: tie },
      }),
    ]);

    const body = assessmentResponseSchema.parse(await (await getAssessment()).json());
    expect(body.assessment).toMatchObject({
      profile: { weightKg: 73, waistCm: 83 },
      goal: { desiredWeeklyRatePct: 0.2 },
      health: { temporarySignals: ['FEVER_OR_ACUTE_INFECTION'] },
      eligibility: { status: 'TEMPORARY_HOLD', reasonCodes: ['HOLD_ACUTE_ILLNESS'] },
    });
  });

  it('turns corrupt persisted assessment JSON into a controlled 500 response', async () => {
    const user = await seedUser('corrupt');
    actAs(user.id);
    expect((await put(baseInput)).status).toBe(200);
    await db.fitnessProfile.update({
      where: { userId: user.id },
      data: { recentMainLifts: { unexpected: true } },
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await getAssessment();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Server error.' });
    consoleError.mockRestore();
  });
});

describe('POST /api/fitness/onboarding/skip', () => {
  it('requires authentication', async () => {
    actAs(null);
    expect((await skipOnboarding(jsonRequest('POST', {}))).status).toBe(401);
  });

  it('accepts only an empty object, clears only onboarding, creates nothing, and is idempotent', async () => {
    const user = await seedUser('skip');
    actAs(user.id);

    const first = await skipOnboarding(jsonRequest('POST', {}));
    const second = await skipOnboarding(jsonRequest('POST', {}));
    expect(first.status).toBe(204);
    expect(await first.text()).toBe('');
    expect(second.status).toBe(204);
    expect(await db.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({
      email: user.email,
      fitnessOnboardingRequired: false,
      displayName: null,
      bodyweight: null,
      sex: null,
      heightCm: null,
      goal: null,
      weeklyFrequency: null,
    });
    expect(await fitnessWriteCounts(user.id)).toEqual({
      profiles: 0,
      screenings: 0,
      goals: 0,
      plans: 0,
      bodyweights: 0,
      measurements: 0,
    });
  });

  it('waits for the shared user lock before clearing onboarding', async () => {
    const user = await seedUser('locked-skip');
    actAs(user.id);
    const holderReady = deferred();
    const releaseHolder = deferred();
    let holderPid = 0;
    const holder = db.$transaction(async (tx) => {
      await lockFitnessUser(tx, user.id);
      const [connection] = await tx.$queryRaw<Array<{ pid: number }>>`
        SELECT pg_backend_pid()::int AS pid
      `;
      holderPid = connection!.pid;
      holderReady.resolve();
      await releaseHolder.promise;
    });
    await holderReady.promise;

    const skipStarted = deferred();
    let skipRequest: Promise<Response> | null = null;
    try {
      skipRequest = (async () => {
        skipStarted.resolve();
        return skipOnboarding(jsonRequest('POST', {}));
      })();
      await skipStarted.promise;
      await waitForAdvisoryWaiters(holderPid, 1);
      const state = await Promise.race([
        skipRequest.then(() => 'settled' as const),
        new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 25)),
      ]);

      expect(state).toBe('pending');
      expect(
        (await db.user.findUniqueOrThrow({ where: { id: user.id } })).fitnessOnboardingRequired,
      ).toBe(true);
    } finally {
      releaseHolder.resolve();
      await Promise.allSettled([holder, ...(skipRequest ? [skipRequest] : [])]);
    }

    const response = await skipRequest!;
    expect(response.status).toBe(204);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: user.id } })).fitnessOnboardingRequired,
    ).toBe(false);
  });

  it.each([
    ['malformed JSON', rawRequest('POST', '{'), 400],
    ['non-empty object', jsonRequest('POST', { skip: true }), 400],
    ['oversized body', rawRequest('POST', JSON.stringify({ padding: 'x'.repeat(1_100) })), 413],
  ])('rejects %s without changing onboarding', async (_label, request, expectedStatus) => {
    const user = await seedUser('invalid-skip');
    actAs(user.id);

    expect((await skipOnboarding(request)).status).toBe(expectedStatus);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: user.id } })).fitnessOnboardingRequired,
    ).toBe(true);
    expect(await fitnessWriteCounts(user.id)).toEqual({
      profiles: 0,
      screenings: 0,
      goals: 0,
      plans: 0,
      bodyweights: 0,
      measurements: 0,
    });
  });
});
