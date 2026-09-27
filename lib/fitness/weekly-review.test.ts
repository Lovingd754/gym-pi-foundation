import { describe, expect, it } from 'vitest';

import { buildBaselinePlan } from './baseline-plan';
import { evaluateEligibility } from './eligibility';
import { STRENGTH_EXERCISE_CATALOG } from './exercise-catalog';
import type { InitialLoadGuidance } from './load-evidence';
import { createAssessmentInputSchema, type AssessmentInput } from './schemas';
import { reviewWeek, type WeekEvidence, type WeeklyAdjustment } from './weekly-review';
import { applyWeeklyStrategy } from './weekly-strategy-apply';

const NOW = new Date('2026-09-21T04:00:00.000Z');

it('applies fresh weekly days and blocks cardio on unavailable days with reduced recovery volume', () => {
  const value = assessment();
  const before = planFor(value);
  const strategy = {
    weekdays: [1, 5],
    avoidCatalogKeys: [],
    preferCatalogKeys: [],
    cardioPreference: 'MINIMAL' as const,
    recovery: 'REDUCED' as const,
    rationale: 'A lighter travel week.',
    source: 'MODEL' as const,
  };
  const result = applyWeeklyStrategy(
    {
      assessment: value,
      eligibility: evaluateEligibility(value, NOW),
      gymConstraints: { unavailableExerciseNames: [] },
      loadGuidance: guidance(value),
      now: NOW,
    },
    strategy,
    {
      availableWeekdays: [1, 5],
      equipmentTypes: ['DUMBBELL', 'BODYWEIGHT'],
      sessionDurationMin: null,
    },
  );
  expect(result.content.strength.days.map((d) => d.dayOfWeek)).toEqual([1, 5]);
  expect(result.content.cardio.sessions.every((s) => [1, 5].includes(s.dayOfWeek))).toBe(true);
  expect(
    result.content.strength.days.flatMap((d) => d.exercises).every((e) => e.targetRIR >= 3),
  ).toBe(true);
  expect(
    result.content.strength.days
      .flatMap((d) => d.exercises)
      .reduce((sum, e) => sum + e.targetSets, 0),
  ).toBeLessThan(
    before.strength.days.flatMap((d) => d.exercises).reduce((sum, e) => sum + e.targetSets, 0),
  );
});
it('explicitly refuses a weekly duration too short for safe baseline sessions', () => {
  const value = assessment();
  expect(() =>
    applyWeeklyStrategy(
      {
        assessment: value,
        eligibility: evaluateEligibility(value, NOW),
        gymConstraints: { unavailableExerciseNames: [] },
        loadGuidance: guidance(value),
        now: NOW,
      },
      {
        weekdays: [1, 5],
        avoidCatalogKeys: [],
        preferCatalogKeys: [],
        cardioPreference: 'MINIMAL',
        recovery: 'STANDARD',
        rationale: 'Short week',
        source: 'MODEL',
      },
      { availableWeekdays: [1, 5], equipmentTypes: ['BODYWEIGHT'], sessionDurationMin: 20 },
    ),
  ).toThrow('WEEKLY_SCHEDULE_INFEASIBLE');
});
it('retains STANDARD cardio on feasible rest weekdays outside the selected strength days', () => {
  const value = assessment();
  const result = applyWeeklyStrategy(
    {
      assessment: value,
      eligibility: evaluateEligibility(value, NOW),
      gymConstraints: { unavailableExerciseNames: [] },
      loadGuidance: guidance(value),
      now: NOW,
    },
    {
      weekdays: [1, 5],
      avoidCatalogKeys: [],
      preferCatalogKeys: [],
      cardioPreference: 'STANDARD',
      recovery: 'STANDARD',
      rationale: 'Room for strength and cardio.',
      source: 'MODEL',
    },
    {
      availableWeekdays: [1, 2, 3, 4, 5, 6, 7],
      equipmentTypes: ['DUMBBELL', 'BODYWEIGHT'],
      sessionDurationMin: null,
    },
  );
  expect(result.content.cardio.additionalWeeklyMin).toBeGreaterThan(0);
  expect(result.content.cardio.sessions.some((s) => ![1, 5].includes(s.dayOfWeek))).toBe(true);
});

function assessment(
  overrides: {
    profile?: Partial<AssessmentInput['profile']>;
    goal?: Partial<AssessmentInput['goal']>;
    schedule?: Partial<AssessmentInput['schedule']>;
    lifestyle?: Partial<AssessmentInput['lifestyle']>;
  } = {},
): AssessmentInput {
  return createAssessmentInputSchema(NOW).parse({
    profile: {
      ageYears: 29,
      displaySex: 'PREFER_NOT_TO_SAY',
      energyEquationReference: 'UNSPECIFIED',
      heightCm: 170,
      weightKg: 82,
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
      attested: true,
    },
  } as AssessmentInput);
}

function guidance(value: AssessmentInput): InitialLoadGuidance[] {
  const reported = new Map(
    value.schedule.recentMainLifts.map((lift) => [lift.catalogKey, lift.weightKg]),
  );
  return STRENGTH_EXERCISE_CATALOG.map((entry) => {
    const weightKg = reported.get(entry.key);
    return weightKg === undefined
      ? { catalogKey: entry.key, source: 'CALIBRATION' as const, initialLoadKg: null }
      : { catalogKey: entry.key, source: 'USER_REPORTED' as const, initialLoadKg: weightKg };
  });
}

function planFor(value: AssessmentInput) {
  return buildBaselinePlan({
    assessment: value,
    eligibility: evaluateEligibility(value, NOW),
    gymConstraints: { unavailableExerciseNames: [] },
    loadGuidance: guidance(value),
    now: NOW,
  });
}

function evidence(overrides: Partial<WeekEvidence> = {}): WeekEvidence {
  return {
    windowStart: '2026-09-14',
    windowEnd: '2026-09-21',
    plannedSessions: 3,
    completedSessions: 3,
    trainedWeekdays: [1, 3, 5],
    missedWeekdays: [],
    cardioPlannedMin: 40,
    cardioCompletedMin: 40,
    weightStartKg: 82,
    weightEndKg: 82,
    waistStartCm: null,
    waistEndCm: null,
    ...overrides,
  };
}

function review(value: AssessmentInput, week: WeekEvidence) {
  return reviewWeek({
    previousContent: planFor(value),
    previousAssessment: value,
    eligibility: evaluateEligibility(value, NOW),
    gymConstraints: { unavailableExerciseNames: [] },
    loadGuidance: guidance(value),
    evidence: week,
    now: NOW,
  });
}

function codes(adjustments: WeeklyAdjustment[]): string[] {
  return adjustments.map((adjustment) => adjustment.code);
}

describe('reviewWeek', () => {
  it('leaves the plan alone when the week left no evidence at all', () => {
    const value = assessment();
    const result = review(
      value,
      evidence({
        completedSessions: 0,
        trainedWeekdays: [],
        missedWeekdays: [1, 3, 5],
        cardioCompletedMin: 0,
        weightStartKg: null,
        weightEndKg: null,
      }),
    );

    expect(result.unchanged).toBe(true);
    expect(codes(result.adjustments)).toEqual(['NO_EVIDENCE']);
  });

  it('keeps the structure when the week went to plan', () => {
    const value = assessment();
    const previous = planFor(value);
    const result = review(value, evidence());

    expect(result.content.strength.days.map((day) => day.dayOfWeek)).toEqual([1, 3, 5]);
    expect(result.content.strength.split).toBe(previous.strength.split);
    expect(result.content.cardio.additionalWeeklyMin).toBe(previous.cardio.additionalWeeklyMin);
    expect(codes(result.adjustments)).not.toContain('TRAINING_DAYS_REDUCED');
    expect(codes(result.adjustments)).not.toContain('CARDIO_REDUCED');
  });

  it('steps the pace up when a fat-loss week did not move the scale', () => {
    const value = assessment();
    const result = review(value, evidence({ weightEndKg: 82 }));

    const calories = result.adjustments.find((adjustment) => adjustment.kind === 'CALORIES');
    expect(calories?.code).toBe('PACE_FASTER');
    if (calories?.kind !== 'CALORIES') throw new Error('expected a calorie adjustment');
    expect(calories.after.max).toBeLessThan(calories.before.max);
    expect(result.assessment.goal.desiredWeeklyRatePct).toBe(-0.75);
  });

  it('eases the pace when the weight is falling faster than asked', () => {
    const result = review(assessment(), evidence({ weightEndKg: 80.6 }));

    const calories = result.adjustments.find((adjustment) => adjustment.kind === 'CALORIES');
    expect(calories?.code).toBe('PACE_SLOWER');
    expect(result.assessment.goal.desiredWeeklyRatePct).toBe(-0.25);
  });

  it('recalculates the numbers from the new bodyweight without touching the pace', () => {
    // -0.4% in the week against a -0.5% target is inside the "as asked" band,
    // so the pace stays and only the arithmetic moves.
    const result = review(assessment(), evidence({ weightEndKg: 81.67 }));

    expect(result.assessment.goal.desiredWeeklyRatePct).toBe(-0.5);
    expect(codes(result.adjustments)).toContain('RECALCULATED');
  });

  it('drops a training day after a week with two of them missed', () => {
    const result = review(
      assessment(),
      evidence({
        completedSessions: 1,
        trainedWeekdays: [1],
        missedWeekdays: [3, 5],
        weightEndKg: 81.6,
      }),
    );

    const days = result.adjustments.find((adjustment) => adjustment.kind === 'TRAINING_DAYS');
    expect(days?.code).toBe('TRAINING_DAYS_REDUCED');
    expect(result.content.strength.days).toHaveLength(2);
    expect(result.assessment.schedule.weeklyFrequency).toBe(2);
    expect(result.assessment.schedule.availableWeekdays).toContain(1);
  });

  // A blank week (a holiday, an illness, or simply not logging) is not evidence
  // about which weekdays work, so the schedule stays put and only the body
  // numbers move the plan.
  it('does not restructure the week when nothing at all was trained', () => {
    const result = review(
      assessment(),
      evidence({
        completedSessions: 0,
        trainedWeekdays: [],
        missedWeekdays: [1, 3, 5],
        cardioCompletedMin: 0,
        weightEndKg: 81.6,
      }),
    );

    expect(codes(result.adjustments)).not.toContain('TRAINING_DAYS_REDUCED');
    expect(codes(result.adjustments)).not.toContain('CARDIO_REDUCED');
    expect(result.content.strength.days.map((day) => day.dayOfWeek)).toEqual([1, 3, 5]);
    expect(result.content.cardio.additionalWeeklyMin).toBe(
      planFor(assessment()).cardio.additionalWeeklyMin,
    );
  });

  it('moves a training day onto the day that actually worked', () => {
    const result = review(
      assessment(),
      evidence({
        completedSessions: 3,
        trainedWeekdays: [1, 3, 6],
        missedWeekdays: [5],
        weightEndKg: 81.6,
      }),
    );

    const days = result.adjustments.find((adjustment) => adjustment.kind === 'TRAINING_DAYS');
    expect(days?.code).toBe('TRAINING_DAYS_MOVED');
    expect(result.content.strength.days.map((day) => day.dayOfWeek)).toEqual([1, 3, 6]);
  });

  it('asks for less cardio when most of it did not happen', () => {
    const previous = planFor(assessment());
    const result = review(assessment(), evidence({ cardioCompletedMin: 0, weightEndKg: 82 }));

    const cardio = result.adjustments.find((adjustment) => adjustment.kind === 'CARDIO');
    expect(cardio?.code).toBe('CARDIO_REDUCED');
    expect(result.content.cardio.additionalWeeklyMin).toBeLessThan(
      previous.cardio.additionalWeeklyMin,
    );
  });

  it('adds cardio only once the calorie lever is spent', () => {
    const value = assessment({ goal: { desiredWeeklyRatePct: -0.75 } });
    // Already at the fastest pace the rules allow, and the scale still holds.
    const result = review(value, evidence({ weightEndKg: 82 }));

    expect(result.assessment.goal.desiredWeeklyRatePct).toBe(-0.75);
    expect(codes(result.adjustments)).toContain('CARDIO_INCREASED');
  });

  it('never reports a change it did not make', () => {
    const result = review(assessment(), evidence({ weightEndKg: 81.6 }));
    expect(
      result.adjustments.some(
        (adjustment) => adjustment.kind === 'CALORIES' && adjustment.before === adjustment.after,
      ),
    ).toBe(false);
  });
});
