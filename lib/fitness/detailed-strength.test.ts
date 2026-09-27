import { expect, it, vi } from 'vitest';
import {
  applyDetailedStrength,
  requestDetailedStrength,
  type DetailedStrengthInput,
} from './detailed-strength';
import { buildBaselinePlan } from './baseline-plan';
import { evaluateEligibility } from './eligibility';
import { createAssessmentInputSchema } from './schemas';
import { STRENGTH_EXERCISE_CATALOG } from './exercise-catalog';
const now = new Date('2026-09-26T04:00:00Z');
const assessment = createAssessmentInputSchema(now).parse({
  profile: {
    ageYears: 30,
    displaySex: 'PREFER_NOT_TO_SAY',
    energyEquationReference: 'UNSPECIFIED',
    heightCm: 170,
    weightKg: 82,
    trainingAgeMonths: 3,
  },
  goal: { type: 'RECOMP', desiredWeeklyRatePct: 0 },
  schedule: {
    weeklyFrequency: 2,
    availableWeekdays: [1, 4],
    sessionDurationMin: 120,
    equipmentTypes: ['BARBELL', 'DUMBBELL', 'BODYWEIGHT'],
    recentMainLifts: [{ catalogKey: 'bench_press', weightKg: 60, reps: 8, rir: 2 }],
  },
  lifestyle: {
    activityLevel: 'SEDENTARY',
    avgDailySteps: 5000,
    currentModerateActivityMin: 150,
    habitualSleepMin: 420,
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
});
const calculation = {
  assessment,
  eligibility: evaluateEligibility(assessment, now),
  gymConstraints: { unavailableExerciseNames: [] },
  now,
  loadGuidance: STRENGTH_EXERCISE_CATALOG.map((e) => ({
    catalogKey: e.key,
    source: e.key === 'bench_press' ? ('USER_REPORTED' as const) : ('CALIBRATION' as const),
    initialLoadKg: e.key === 'bench_press' ? 60 : null,
  })),
};
const input: DetailedStrengthInput = {
  userId: 'synthetic',
  calculation,
  base: buildBaselinePlan(calculation),
  strategy: {
    weekdays: [1, 4],
    avoidCatalogKeys: [],
    preferCatalogKeys: [],
    cardioPreference: 'STANDARD',
    recovery: 'STANDARD',
    rationale: 'Test',
    source: 'MODEL',
  },
  constraints: {
    availableWeekdays: [1, 4],
    equipmentTypes: ['BARBELL', 'DUMBBELL', 'BODYWEIGHT'],
    sessionDurationMin: 120,
  },
  context: {},
};
const candidate = (weightKg: number | null = 60) => ({
  days: [1, 4].map((dayOfWeek) => ({
    dayOfWeek,
    exercises: input.base.strength.days[0]!.exercises.filter((e) => e.category === 'COMPOUND').map(
      (e) => ({
        catalogKey: e.notes!.replace('catalog:', ''),
        sets: 2,
        repsMin: 6,
        repsMax: 8,
        rir: 3,
        restSec: 150,
        weightKg: e.notes === 'catalog:bench_press' ? weightKg : null,
      }),
    ),
  })),
});
it('preserves model sets and evidence-backed load; computes totals', () => {
  const content = applyDetailedStrength(candidate(), input);
  expect(content.strength.days[0]?.exercises[0]?.targetSets).toBe(2);
  expect(content.loadGuidance).toContainEqual({
    catalogKey: 'bench_press',
    source: 'USER_REPORTED',
    initialLoadKg: 60,
  });
  expect(content.strength.achievedSetsByMuscleGroup.CHEST).toBe(4);
});
it('rejects unsupported load without clipping; allows calibration', () => {
  expect(() => applyDetailedStrength(candidate(70), input)).toThrow('LOAD_WITHOUT_EVIDENCE');
  expect(() =>
    applyDetailedStrength(candidate(), {
      ...input,
      calculation: { ...calculation, loadGuidance: [] },
    }),
  ).toThrow('LOAD_WITHOUT_EVIDENCE');
  expect(
    applyDetailedStrength(candidate(null), input).loadGuidance.every(
      (g) => g.source === 'CALIBRATION',
    ),
  ).toBe(true);
});
it('rejects conflicting loads, unavailable equipment and time overflow', () => {
  const conflict = candidate();
  conflict.days[1]!.exercises.find((e) => e.catalogKey === 'bench_press')!.weightKg = 50;
  expect(() => applyDetailedStrength(conflict, input)).toThrow('INCONSISTENT_LOAD');
  expect(() =>
    applyDetailedStrength(candidate(), {
      ...input,
      constraints: { ...input.constraints, equipmentTypes: ['BODYWEIGHT'] },
    }),
  ).toThrow('EXERCISE_UNAVAILABLE');
  expect(() =>
    applyDetailedStrength(candidate(), {
      ...input,
      constraints: { ...input.constraints, sessionDurationMin: 5 },
    }),
  ).toThrow('TIME_BUDGET_EXCEEDED');
});
it('rejects lost movement coverage and changed training weekdays', () => {
  const incomplete = candidate();
  incomplete.days.forEach((d) => {
    d.exercises = d.exercises.filter((e) => e.catalogKey === 'bench_press');
  });
  expect(() => applyDetailedStrength(incomplete, input)).toThrow(
    'MISSING_PRIMARY_MOVEMENT_PATTERN',
  );
  const wrong = candidate();
  wrong.days[0]!.dayOfWeek = 2;
  expect(() => applyDetailedStrength(wrong, input)).toThrow('DAYS_MUST_MATCH_APPROVED_SCHEDULE');
});
it('repairs once using validation feedback, then fails explicitly', async () => {
  const complete = vi
    .fn()
    .mockResolvedValueOnce(JSON.stringify(candidate(70)))
    .mockResolvedValueOnce(JSON.stringify(candidate()));
  expect(
    (await requestDetailedStrength(input, { complete })).loadGuidance.find(
      (g) => g.catalogKey === 'bench_press',
    )?.initialLoadKg,
  ).toBe(60);
  expect(complete).toHaveBeenCalledTimes(2);
  expect(complete.mock.calls[1]![0].messages.at(-1).content).toContain('LOAD_WITHOUT_EVIDENCE');
  const invalid = vi.fn().mockResolvedValue(JSON.stringify(candidate(70)));
  await expect(requestDetailedStrength(input, { complete: invalid })).rejects.toThrow(
    'WEEKLY_MODEL_UNAVAILABLE',
  );
  expect(invalid).toHaveBeenCalledTimes(2);
});
