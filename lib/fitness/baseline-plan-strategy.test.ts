import { describe, expect, it } from 'vitest';
import { buildBaselinePlan, type BaselinePlanInput } from './baseline-plan';
import { evaluateEligibility } from './eligibility';
import { STRENGTH_EXERCISE_CATALOG } from './exercise-catalog';
import type { InitialLoadGuidance } from './load-evidence';
import { NEUTRAL_STRATEGY, type PlanStrategy } from './plan-strategy';
import { createAssessmentInputSchema, type AssessmentInput } from './schemas';

const NOW = new Date('2026-09-19T04:00:00.000Z');

const ALL_EQUIPMENT = ['BARBELL', 'DUMBBELL', 'MACHINE', 'CABLE', 'BODYWEIGHT'] as const;

function assessment(
  equipmentTypes: readonly AssessmentInput['schedule']['equipmentTypes'][number][] = [
    'DUMBBELL',
    'BODYWEIGHT',
  ],
): AssessmentInput {
  return createAssessmentInputSchema(NOW).parse({
    profile: {
      displayName: undefined,
      ageYears: 30,
      displaySex: 'PREFER_NOT_TO_SAY',
      energyEquationReference: 'UNSPECIFIED',
      heightCm: 170,
      weightKg: 82,
      trainingAgeMonths: 3,
    },
    goal: {
      type: 'FAT_LOSS',
      desiredWeeklyRatePct: -0.5,
      targetWeightKg: 74,
      targetDate: '2027-03-01',
    },
    schedule: {
      weeklyFrequency: 3,
      availableWeekdays: [1, 3, 5],
      sessionDurationMin: 60,
      equipmentTypes: [...equipmentTypes],
      recentMainLifts: [{ catalogKey: 'goblet_squat', weightKg: 24, reps: 10, rir: 2 }],
    },
    lifestyle: {
      activityLevel: 'SEDENTARY',
      avgDailySteps: 5000,
      currentModerateActivityMin: 40,
      habitualSleepMin: 380,
      bedtimeMin: 1430,
      wakeTimeMin: 420,
      timeZone: 'Asia/Shanghai',
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
}

function guidance(): InitialLoadGuidance[] {
  return STRENGTH_EXERCISE_CATALOG.map((entry) =>
    entry.key === 'goblet_squat'
      ? { catalogKey: entry.key, source: 'USER_REPORTED' as const, initialLoadKg: 24 }
      : { catalogKey: entry.key, source: 'CALIBRATION' as const, initialLoadKg: null },
  );
}

function plan(
  strategy: PlanStrategy,
  equipmentTypes?: readonly AssessmentInput['schedule']['equipmentTypes'][number][],
) {
  const value = assessment(equipmentTypes);
  const input = {
    assessment: value,
    eligibility: evaluateEligibility(value, NOW),
    gymConstraints: { unavailableExerciseNames: [] },
    loadGuidance: guidance(),
    now: NOW,
    strategy,
  } satisfies BaselinePlanInput;
  return buildBaselinePlan(input);
}

function selectedCatalogKeys(content: ReturnType<typeof plan>): string[] {
  return content.strength.days
    .flatMap((day) => day.exercises)
    .map((exercise) => exercise.notes ?? '')
    .filter((note) => note.startsWith('catalog:'))
    .map((note) => note.slice('catalog:'.length));
}

describe('strategy overlay', () => {
  it('produces exactly the neutral plan when the strategy is neutral', () => {
    const neutral = plan(NEUTRAL_STRATEGY);
    const omitted = buildBaselinePlan({
      assessment: assessment(),
      eligibility: evaluateEligibility(assessment(), NOW),
      gymConstraints: { unavailableExerciseNames: [] },
      loadGuidance: guidance(),
      now: NOW,
    });

    expect(neutral).toEqual(omitted);
  });

  it('drops an avoided movement out of every training day', () => {
    const content = plan({ ...NEUTRAL_STRATEGY, avoidCatalogKeys: ['goblet_squat'] });

    expect(selectedCatalogKeys(content)).not.toContain('goblet_squat');
    // The squat slot is still filled: avoidance never removes the pattern.
    expect(content.strength.days.every((day) => day.exercises.length > 0)).toBe(true);
  });

  it('biases selection towards a preferred movement', () => {
    const neutral = selectedCatalogKeys(plan(NEUTRAL_STRATEGY, ALL_EQUIPMENT));
    // A movement the plan could use but does not reach on its own: preferring it
    // must pull it into the rotation without changing anything else.
    const preferred = STRENGTH_EXERCISE_CATALOG.find(
      (entry) =>
        entry.priority === 0 &&
        !neutral.includes(entry.key),
    );
    if (!preferred) throw new Error('fixture has no unused movement to prefer');
    const biased = selectedCatalogKeys(
      plan({ ...NEUTRAL_STRATEGY, preferCatalogKeys: [preferred.key] }, ALL_EQUIPMENT),
    );

    expect(biased).toContain(preferred.key);
  });

  it('keeps a preference inside the equipment the trainee actually has', () => {
    // A barbell movement cannot appear on a dumbbell-only plan, preference or not.
    const content = plan({ ...NEUTRAL_STRATEGY, preferCatalogKeys: ['back_squat'] });

    expect(selectedCatalogKeys(content)).not.toContain('back_squat');
  });

  it('moves the cardio prescription but never below the floor', () => {
    const standard = plan(NEUTRAL_STRATEGY);
    const minimal = plan({ ...NEUTRAL_STRATEGY, cardioPreference: 'MINIMAL' });
    const more = plan({ ...NEUTRAL_STRATEGY, cardioPreference: 'MORE' });

    expect(standard.cardio.additionalWeeklyMin).toBeGreaterThan(20);
    expect(minimal.cardio.additionalWeeklyMin).toBeGreaterThanOrEqual(20);
    expect(minimal.cardio.additionalWeeklyMin).toBeLessThan(standard.cardio.additionalWeeklyMin);
    expect(more.cardio.additionalWeeklyMin).toBeGreaterThan(standard.cardio.additionalWeeklyMin);
    expect(more.cardio.additionalWeeklyMin).toBeLessThanOrEqual(150);

    // The derived schedule always agrees with the prescription.
    for (const content of [minimal, more]) {
      const scheduled = content.schedule.days.reduce((sum, day) => sum + day.cardioMin, 0);
      expect(scheduled).toBe(content.cardio.additionalWeeklyMin);
    }
  });

  it('leaves the numbers to the rules', () => {
    const standard = plan(NEUTRAL_STRATEGY);
    const reshaped = plan({
      ...NEUTRAL_STRATEGY,
      avoidCatalogKeys: ['goblet_squat'],
      cardioPreference: 'MINIMAL',
    });

    // A strategy changes which movements are chosen, never the prescription
    // around them.
    expect(reshaped.strength.weeklyTargetSets).toBe(standard.strength.weeklyTargetSets);
    expect(reshaped.nutrition.caloriesKcal).toEqual(standard.nutrition.caloriesKcal);
    expect(reshaped.sleep).toEqual(standard.sleep);
  });
});
