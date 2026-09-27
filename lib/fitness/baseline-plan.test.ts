import { describe, expect, it } from 'vitest';

import { STRENGTH_EXERCISE_CATALOG } from './exercise-catalog';
import { evaluateEligibility } from './eligibility';
import {
  BaselinePlanEligibilityError,
  BaselinePlanEvidenceError,
  buildBaselinePlan,
  type BaselinePlanInput,
} from './baseline-plan';
import { fitnessPlanContentSchema, parseFitnessPlanContent } from './plan-schema';
import { createAssessmentInputSchema, type AssessmentInput } from './schemas';
import type { InitialLoadGuidance } from './load-evidence';

// The calculation instant is pinned so every derived date and the serialized
// snapshot stay stable regardless of when the suite runs.
const NOW = new Date('2026-09-14T04:00:00.000Z');

function assessment(overrides: {
  profile?: Partial<AssessmentInput['profile']>;
  goal?: Partial<AssessmentInput['goal']>;
  schedule?: Partial<AssessmentInput['schedule']>;
  lifestyle?: Partial<AssessmentInput['lifestyle']>;
}): AssessmentInput {
  const value = {
    profile: {
      displayName: undefined,
      ageYears: 29,
      displaySex: 'PREFER_NOT_TO_SAY',
      energyEquationReference: 'UNSPECIFIED',
      heightCm: 170,
      weightKg: 82,
      waistCm: undefined,
      bodyFatPct: undefined,
      trainingAgeMonths: 3,
      ...overrides.profile,
    },
    goal: {
      type: 'FAT_LOSS',
      desiredWeeklyRatePct: -0.5,
      targetWeightKg: 74,
      targetDate: '2027-03-01',
      ...overrides.goal,
    },
    schedule: {
      weeklyFrequency: 3,
      availableWeekdays: [1, 3, 5],
      sessionDurationMin: 60,
      equipmentTypes: ['DUMBBELL', 'BODYWEIGHT'],
      recentMainLifts: [{ catalogKey: 'goblet_squat', weightKg: 24, reps: 10, rir: 2 }],
      ...overrides.schedule,
    },
    lifestyle: {
      activityLevel: 'SEDENTARY',
      avgDailySteps: 5000,
      currentModerateActivityMin: 40,
      habitualSleepMin: 380,
      bedtimeMin: 1430,
      wakeTimeMin: 420,
      timeZone: 'Asia/Shanghai',
      ...overrides.lifestyle,
    },
    health: {
      urgentSignals: [],
      clearanceSignals: [],
      temporarySignals: [],
      scopeSignals: [],
      healthChangedSinceClearance: false,
      attested: true as const,
    },
  };
  // Fixtures must be valid assessment submissions, not hand-waved objects.
  return createAssessmentInputSchema(NOW).parse(value);
}

function planInput(value: AssessmentInput, overrides: Partial<BaselinePlanInput> = {}) {
  const eligibility = evaluateEligibility(value, NOW);
  const guidance = allCatalogGuidance(value);
  return {
    assessment: value,
    eligibility,
    gymConstraints: { unavailableExerciseNames: [] },
    loadGuidance: guidance,
    now: NOW,
    ...overrides,
  } satisfies BaselinePlanInput;
}

// Supply evidence for every catalog entry so the composer's own filtering (and
// not the fixture) decides which keys reach the plan.
function allCatalogGuidance(value: AssessmentInput): InitialLoadGuidance[] {
  const reported = new Map(
    value.schedule.recentMainLifts.map((lift) => [lift.catalogKey, lift.weightKg]),
  );
  return STRENGTH_EXERCISE_CATALOG.map((entry) => {
    const weightKg = reported.get(entry.key);
    if (weightKg !== undefined) {
      return { catalogKey: entry.key, source: 'USER_REPORTED' as const, initialLoadKg: weightKg };
    }
    return { catalogKey: entry.key, source: 'CALIBRATION' as const, initialLoadKg: null };
  });
}

function selectedCatalogKeys(content: ReturnType<typeof buildBaselinePlan>): string[] {
  const keys = new Set<string>();
  for (const day of content.strength.days) {
    for (const exercise of day.exercises) {
      const match = /^catalog:(.+)$/.exec(exercise.notes ?? '');
      if (match) keys.add(match[1]!);
    }
  }
  return [...keys];
}

const noviceFatLoss = assessment({});

const intermediateHypertrophy = assessment({
  profile: {
    ageYears: 34,
    displaySex: 'FEMALE',
    energyEquationReference: 'FEMALE',
    heightCm: 166,
    weightKg: 60,
    waistCm: 72,
    trainingAgeMonths: 18,
  },
  goal: {
    type: 'HYPERTROPHY',
    desiredWeeklyRatePct: 0.2,
    targetWeightKg: 64,
    targetDate: '2027-06-01',
  },
  schedule: {
    weeklyFrequency: 4,
    availableWeekdays: [2, 4, 6, 7],
    sessionDurationMin: 75,
    equipmentTypes: ['BARBELL', 'DUMBBELL', 'MACHINE', 'CABLE', 'BODYWEIGHT'],
    recentMainLifts: [
      { catalogKey: 'bench_press', weightKg: 45, reps: 8, rir: 2 },
      { catalogKey: 'back_squat', weightKg: 70, reps: 6, rir: 2 },
    ],
  },
  lifestyle: {
    activityLevel: 'MODERATE',
    avgDailySteps: 9000,
    currentModerateActivityMin: 90,
    habitualSleepMin: 430,
    bedtimeMin: 1380,
    wakeTimeMin: 390,
    timeZone: 'Europe/Paris',
  },
});

const experiencedRecomp = assessment({
  profile: {
    ageYears: 41,
    displaySex: 'MALE',
    energyEquationReference: 'MALE',
    heightCm: 181,
    weightKg: 88,
    bodyFatPct: 18,
    trainingAgeMonths: 96,
  },
  goal: {
    type: 'RECOMP',
    desiredWeeklyRatePct: 0,
    targetWeightKg: undefined,
    targetDate: '2027-01-15',
  },
  schedule: {
    weeklyFrequency: 5,
    availableWeekdays: [1, 2, 3, 5, 6],
    sessionDurationMin: 90,
    equipmentTypes: ['BARBELL', 'DUMBBELL', 'MACHINE', 'CABLE', 'BODYWEIGHT'],
    recentMainLifts: [{ catalogKey: 'romanian_deadlift', weightKg: 120, reps: 8, rir: 3 }],
  },
  lifestyle: {
    activityLevel: 'HIGH',
    avgDailySteps: 12000,
    currentModerateActivityMin: 200,
    habitualSleepMin: 470,
    bedtimeMin: 1365,
    wakeTimeMin: 375,
    timeZone: 'America/New_York',
  },
});

describe('buildBaselinePlan composition', () => {
  it('composes every subsystem and re-parses through the persisted schema', () => {
    const content = buildBaselinePlan(planInput(noviceFatLoss));

    expect(fitnessPlanContentSchema.parse(content)).toEqual(content);
    expect(content.schemaVersion).toBe(1);
    expect(content.rulesVersion).toBe('baseline-v1');
    expect(content.strength.days).toHaveLength(3);
    expect(content.loadGuidance.length).toBeGreaterThan(0);
    expect(content.nutrition.caloriesKcal.max).toBeGreaterThan(0);
    expect(content.cardio.additionalWeeklyMin).toBe(40);
    expect(content.sleep.longTermMin).toBe(420);
    expect(content.schedule.days).toHaveLength(7);
    expect(content.reasons).toContain('ELIGIBLE_GENERAL_POPULATION');
    expect(content.goal.feasibility.status).toBe('WITHIN_RANGE');
  });

  it('rejects an ineligible decision before any sub-engine runs', () => {
    const ineligible = evaluateEligibility(
      assessment({ lifestyle: { habitualSleepMin: 380 } }),
      NOW,
    );
    // Force a non-eligible status and empty evidence: eligibility must win.
    expect(() =>
      buildBaselinePlan(
        planInput(noviceFatLoss, {
          eligibility: { ...ineligible, status: 'TEMPORARY_HOLD' },
          loadGuidance: [],
        }),
      ),
    ).toThrow(BaselinePlanEligibilityError);
  });

  it('rejects a selected exercise that has no supplied load evidence', () => {
    const selectedKey = selectedCatalogKeys(buildBaselinePlan(planInput(noviceFatLoss)))[0]!;

    expect(() =>
      buildBaselinePlan(
        planInput(noviceFatLoss, {
          loadGuidance: allCatalogGuidance(noviceFatLoss).filter(
            (guidance) => guidance.catalogKey !== selectedKey,
          ),
        }),
      ),
    ).toThrow(BaselinePlanEvidenceError);
  });

  it('keeps only the evidence of the catalog alternatives that were selected', () => {
    const content = buildBaselinePlan(planInput(intermediateHypertrophy));
    const selected = selectedCatalogKeys(content);

    expect(selected.length).toBeLessThan(STRENGTH_EXERCISE_CATALOG.length);
    expect(content.loadGuidance.map((guidance) => guidance.catalogKey)).toEqual(selected);
  });
});

describe('buildBaselinePlan energy ranges', () => {
  it('produces a genuine range and the reference reason when sex is unspecified', () => {
    const content = buildBaselinePlan(planInput(noviceFatLoss));

    expect(content.nutrition.caloriesKcal.max).toBeGreaterThan(content.nutrition.caloriesKcal.min);
    expect(content.nutrition.proteinG.max).toBeGreaterThanOrEqual(content.nutrition.proteinG.min);
    expect(content.reasons).toContain('ENERGY_REFERENCE_RANGE');
  });

  it.each([
    ['female reference', intermediateHypertrophy],
    ['male reference', experiencedRecomp],
  ])('collapses to exact min/max pairs with a %s', (_label, value) => {
    const content = buildBaselinePlan(planInput(value));

    expect(content.nutrition.caloriesKcal.min).toBe(content.nutrition.caloriesKcal.max);
    expect(content.nutrition.proteinG.min).toBe(content.nutrition.proteinG.max);
    expect(content.nutrition.fatG.min).toBe(content.nutrition.fatG.max);
    expect(content.nutrition.carbsG.min).toBe(content.nutrition.carbsG.max);
    expect(content.reasons).not.toContain('ENERGY_REFERENCE_RANGE');
  });
});

describe('buildBaselinePlan schedule', () => {
  it.each([
    ['novice fat loss', noviceFatLoss],
    ['intermediate hypertrophy', intermediateHypertrophy],
    ['experienced recomp', experiencedRecomp],
  ])('classifies all seven weekdays exactly once for %s', (_label, value) => {
    const content = buildBaselinePlan(planInput(value));
    const days = content.schedule.days;

    expect(days.map((day) => day.dayOfWeek)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const day of days) {
      const isStrength = day.strengthDayIndex !== null;
      const isCardio = day.cardioMin > 0;
      const expected = isStrength
        ? isCardio
          ? 'STRENGTH_AND_CARDIO'
          : 'STRENGTH'
        : isCardio
          ? 'CARDIO'
          : 'REST';
      expect(day.kind).toBe(expected);
      if (day.strengthDayIndex !== null) {
        expect(content.strength.days[day.strengthDayIndex]!.dayOfWeek).toBe(day.dayOfWeek);
      }
    }

    const scheduledCardio = days.reduce((total, day) => total + day.cardioMin, 0);
    const prescribedCardio = content.cardio.sessions.reduce(
      (total, session) => total + session.durationMin,
      0,
    );
    expect(scheduledCardio).toBe(prescribedCardio);
    expect(scheduledCardio).toBe(content.cardio.additionalWeeklyMin);
  });
});

describe('buildBaselinePlan determinism', () => {
  it.each([
    ['novice fat loss', noviceFatLoss],
    ['intermediate hypertrophy', intermediateHypertrophy],
    ['experienced recomp', experiencedRecomp],
  ])('serializes identically across repeat runs for %s', (_label, value) => {
    const first = buildBaselinePlan(planInput(value));
    const second = buildBaselinePlan(planInput(value));

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it.each([
    ['novice fat loss (unspecified reference)', noviceFatLoss],
    ['intermediate hypertrophy (female reference)', intermediateHypertrophy],
    ['experienced recomp (male reference)', experiencedRecomp],
  ])('matches the canonical snapshot for %s', (_label, value) => {
    expect(JSON.stringify(buildBaselinePlan(planInput(value)), null, 2)).toMatchSnapshot();
  });
});

describe('buildBaselinePlan equipment constraints', () => {
  it('honours active-gym unavailability when selecting alternatives', () => {
    const value = assessment({});

    const content = buildBaselinePlan(
      planInput(value, {
        gymConstraints: {
          unavailableExerciseNames: ['Goblet Squat', 'Dumbbell bench press'],
        },
      }),
    );
    const names = content.strength.days.flatMap((day) =>
      day.exercises.map((exercise) => exercise.name),
    );

    expect(names).not.toContain('Goblet Squat');
    expect(names).not.toContain('Dumbbell Bench Press');
  });
});

// A stored payload that breaks any invariant is corrupt: reading it must fail
// loudly instead of rendering or activating a half-valid plan.
describe('fitnessPlanContentSchema corruption guards', () => {
  function validContent() {
    return buildBaselinePlan(planInput(noviceFatLoss));
  }

  function expectRejected(mutate: (content: ReturnType<typeof validContent>) => void) {
    const corrupted = validContent();
    mutate(corrupted);

    expect(() => parseFitnessPlanContent(corrupted)).toThrow();
    expect(fitnessPlanContentSchema.safeParse(validContent()).success).toBe(true);
  }

  it('accepts the untouched composed plan', () => {
    expect(fitnessPlanContentSchema.safeParse(validContent()).success).toBe(true);
  });

  it('rejects a calorie range whose min exceeds its max', () => {
    expectRejected((content) => {
      content.nutrition.caloriesKcal = { min: 3000, max: 2000 };
    });
  });

  it('rejects a negative macro or cardio value', () => {
    expectRejected((content) => {
      content.nutrition.proteinG = { min: -1, max: 100 };
    });
    expectRejected((content) => {
      content.cardio.additionalWeeklyMin = -10;
    });
  });

  it('rejects an intro RIR that is not paired with 14 days', () => {
    expectRejected((content) => {
      content.strength.introRir = 3;
      content.strength.introDurationDays = 0;
    });
  });

  it('rejects duplicate catalog load keys', () => {
    expectRejected((content) => {
      content.loadGuidance.push(content.loadGuidance[0]!);
    });
  });

  it('rejects a load guidance entry for an unknown catalog key', () => {
    expectRejected((content) => {
      content.loadGuidance[0]!.catalogKey = 'not_a_catalog_key' as never;
    });
  });

  it('rejects a strength day count that contradicts the split', () => {
    expectRejected((content) => {
      content.strength.days.pop();
    });
  });

  it('rejects a schedule that does not cover seven distinct weekdays', () => {
    expectRejected((content) => {
      content.schedule.days.pop();
    });
  });

  it('rejects a strengthDayIndex that points outside the training days', () => {
    expectRejected((content) => {
      content.schedule.days[0]!.strengthDayIndex = 99;
    });
  });

  it('rejects schedule cardio minutes that disagree with the sessions', () => {
    expectRejected((content) => {
      const cardioDay = content.schedule.days.find((day) => day.cardioMin > 0)!;
      cardioDay.cardioMin = 5;
    });
  });

  it('rejects an unknown reason code', () => {
    expectRejected((content) => {
      content.reasons.push('NOT_A_REAL_REASON' as never);
    });
  });
});
