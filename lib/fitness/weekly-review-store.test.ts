import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  detailed: vi.fn(),
  derived: vi.fn(),
  summary: vi.fn(),
  activities: vi.fn(),
  db: {
    fitnessPlanVersion: { findFirst: vi.fn() },
    session: { findMany: vi.fn() },
    bodyweightEntry: { findMany: vi.fn() },
    bodyMeasurement: { findMany: vi.fn() },
    agentMemory: { findMany: vi.fn() },
    readinessCheckin: { findMany: vi.fn() },
    fitnessPlanActivation: { upsert: vi.fn() },
    $transaction: vi.fn(),
  },
}));
const assessment = {
  schedule: {
    availableWeekdays: [1, 3, 5],
    equipmentTypes: ['BODYWEIGHT'],
    weeklyFrequency: 3,
    sessionDurationMin: 60,
  },
  lifestyle: { timeZone: 'UTC' },
};
const previous = {
  strength: { days: [{ dayOfWeek: 1 }, { dayOfWeek: 3 }, { dayOfWeek: 5 }] },
  cardio: { additionalWeeklyMin: 60 },
  nutrition: { caloriesKcal: { min: 1800, max: 2000 } },
};
const shaped = {
  ...previous,
  strength: { days: [{ dayOfWeek: 1 }, { dayOfWeek: 5 }] },
  cardio: { additionalWeeklyMin: 20 },
  nutrition: { caloriesKcal: { min: 1900, max: 2100 } },
};
vi.mock('@/lib/db', () => ({ db: mocks.db }));
vi.mock('./plan-schema', () => ({ parseFitnessPlanContent: (x: unknown) => x }));
vi.mock('./plan-store', () => ({
  loadCalculationState: async () => ({
    assessment,
    loadGuidance: [{ catalogKey: 'push_up', source: 'CALIBRATION', initialLoadKg: null }],
    gymConstraints: { unavailableExerciseNames: [] },
  }),
  buildPersistedCalculationInput: () => ({ assessment, calculationDate: '2026-09-26' }),
  createDerivedPlanVersion: mocks.derived,
}));
vi.mock('./eligibility', () => ({
  evaluateEligibility: () => ({ status: 'ELIGIBLE', reasonCodes: [] }),
}));
vi.mock('./weekly-strategy', () => ({ requestWeeklyStrategy: mocks.complete }));
vi.mock('./detailed-strength', () => ({ requestDetailedStrength: mocks.detailed }));
vi.mock('./weekly-activities-store', () => ({ getWeeklyActivities: mocks.activities }));
vi.mock('./weekly-strategy-apply', () => ({
  applyWeeklyStrategy: () => ({ assessment, content: shaped }),
}));
vi.mock('./weekly-review', () => ({
  reviewWeek: () => ({
    assessment,
    content: previous,
    adjustments: [
      { kind: 'KEEP', code: 'NO_EVIDENCE' },
      { kind: 'CARDIO', code: 'CARDIO_INCREASED', before: 60, after: 100 },
    ],
    unchanged: true,
  }),
}));
import { runWeeklyReview } from './weekly-review-store';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.detailed.mockResolvedValue(shaped);
  mocks.db.fitnessPlanVersion.findFirst.mockResolvedValue({
    id: 'active',
    version: 1,
    input: { assessment },
    content: previous,
    activatedAt: new Date('2026-09-01'),
    strategy: null,
  });
  mocks.db.session.findMany.mockResolvedValue([]);
  mocks.db.bodyweightEntry.findMany.mockResolvedValue([]);
  mocks.db.bodyMeasurement.findMany.mockResolvedValue([]);
  mocks.db.agentMemory.findMany.mockResolvedValue([{ content: 'Prefers familiar movements' }]);
  mocks.db.readinessCheckin.findMany.mockResolvedValue([
    { readiness: 2, sleepQuality: 2, note: 'Tired' },
  ]);
  mocks.db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({}));
  mocks.activities.mockResolvedValue({
    weekStart: '2026-09-21',
    activities: [{ dayOfWeek: 3, description: 'Travel', unavailable: true }],
  });
  mocks.complete.mockResolvedValue({
    weekdays: [1, 5],
    avoidCatalogKeys: [],
    preferCatalogKeys: [],
    cardioPreference: 'MINIMAL',
    recovery: 'REDUCED',
    rationale: 'Travel and tiredness call for recovery.',
    source: 'MODEL',
  });
  mocks.derived.mockResolvedValue({ id: 'draft', version: 2 });
});
describe('weekly model orchestration', () => {
  it.each([
    [1, 2],
    [1, 7],
  ])('refuses an adjacent-only pair before requesting the model', async (firstDay, secondDay) => {
    assessment.schedule.availableWeekdays = [firstDay, secondDay];
    mocks.activities.mockResolvedValue({ weekStart: '2026-09-21', activities: [] });
    try {
      await expect(runWeeklyReview({ userId: 'owner', force: true })).rejects.toMatchObject({
        status: 409,
        message: 'WEEKLY_SCHEDULE_INFEASIBLE',
      });
      expect(mocks.complete).not.toHaveBeenCalled();
      expect(mocks.derived).not.toHaveBeenCalled();
    } finally {
      assessment.schedule.availableWeekdays = [1, 3, 5];
    }
  });
  it('generates a fresh draft without completion evidence and persists current events and rationale', async () => {
    const outcome = await runWeeklyReview({
      userId: 'owner',
      now: new Date('2026-09-26T12:00:00Z'),
      force: true,
    });
    expect(outcome).toMatchObject({ created: true, activated: false, planId: 'draft' });
    expect(mocks.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'owner',
        context: expect.objectContaining({
          previousPlan: previous,
          activeMemories: ['Prefers familiar movements'],
          recovery: [expect.objectContaining({ readiness: 2 })],
          currentWeekActivities: expect.objectContaining({ weekStart: '2026-09-21' }),
        }),
      }),
    );
    expect(mocks.db.agentMemory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'owner', status: 'ACTIVE' } }),
    );
    expect(mocks.derived).toHaveBeenCalledWith(
      expect.objectContaining({
        content: shaped,
        strategy: expect.objectContaining({ source: 'MODEL' }),
        storedInput: expect.objectContaining({
          weeklyReview: expect.objectContaining({
            strategy: expect.objectContaining({
              rationale: 'Travel and tiredness call for recovery.',
            }),
          }),
        }),
        weeklyActivities: expect.objectContaining({ weekStart: '2026-09-21' }),
      }),
    );
    expect(outcome.adjustments).toEqual(
      expect.arrayContaining([
        { kind: 'CARDIO', code: 'CARDIO_REDUCED', before: 60, after: 20 },
        {
          kind: 'CALORIES',
          code: 'RECALCULATED',
          before: previous.nutrition.caloriesKcal,
          after: shaped.nutrition.caloriesKcal,
        },
      ]),
    );
    expect(outcome.adjustments.some((a) => a.kind === 'KEEP')).toBe(false);
  });
  it('does not persist a draft when detailed candidate validation fails', async () => {
    mocks.detailed.mockRejectedValueOnce(new Error('WEEKLY_MODEL_UNAVAILABLE'));
    await expect(runWeeklyReview({ userId: 'owner', force: true })).rejects.toThrow(
      'WEEKLY_MODEL_UNAVAILABLE',
    );
    expect(mocks.detailed).toHaveBeenCalledWith(
      expect.objectContaining({
        base: shaped,
        calculation: expect.objectContaining({ loadGuidance: expect.any(Array) }),
      }),
    );
    expect(mocks.derived).not.toHaveBeenCalled();
    expect(mocks.db.fitnessPlanActivation.upsert).not.toHaveBeenCalled();
  });
  it('does not create or record a successful review when model generation fails', async () => {
    mocks.complete.mockRejectedValue(new Error('WEEKLY_MODEL_UNAVAILABLE'));
    await expect(runWeeklyReview({ userId: 'owner', force: true })).rejects.toThrow(
      'WEEKLY_MODEL_UNAVAILABLE',
    );
    expect(mocks.derived).not.toHaveBeenCalled();
    expect(mocks.db.fitnessPlanActivation.upsert).not.toHaveBeenCalled();
  });
});
