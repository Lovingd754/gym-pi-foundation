import { describe, expect, it } from 'vitest';
import { buildBaselinePlan, type BaselinePlanInput } from './baseline-plan';
import { evaluateEligibility } from './eligibility';
import { STRENGTH_EXERCISE_CATALOG } from './exercise-catalog';
import type { InitialLoadGuidance } from './load-evidence';
import {
  PlanChangeError,
  allocate,
  applyPlanChange,
  type PlanChangeConstraints,
} from './plan-change';
import { parseFitnessPlanContent, type FitnessPlanContent } from './plan-schema';
import { createAssessmentInputSchema, type AssessmentInput } from './schemas';

const NOW = new Date('2026-09-19T04:00:00.000Z');

function assessment(): AssessmentInput {
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
      equipmentTypes: ['DUMBBELL', 'BODYWEIGHT'],
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

function plan(): FitnessPlanContent {
  const value = assessment();
  const input = {
    assessment: value,
    eligibility: evaluateEligibility(value, NOW),
    gymConstraints: { unavailableExerciseNames: [] },
    loadGuidance: guidance(),
    now: NOW,
  } satisfies BaselinePlanInput;
  return parseFitnessPlanContent(buildBaselinePlan(input));
}

const constraints: PlanChangeConstraints = {
  availableWeekdays: [1, 2, 3, 4, 5],
  equipmentTypes: ['DUMBBELL', 'BODYWEIGHT'],
  unavailableExerciseNames: [],
};

function firstExercise(content: FitnessPlanContent) {
  const day = content.strength.days[0];
  const exercise = day?.exercises[0];
  if (!day || !exercise) throw new Error('fixture has no first exercise');
  return { day, exercise };
}

describe('SWAP_EXERCISE', () => {
  it('picks a same-pattern substitute the trainee has the equipment for', () => {
    const content = plan();
    const { exercise } = firstExercise(content);
    const original = STRENGTH_EXERCISE_CATALOG.find((entry) =>
      [entry.name, ...entry.aliases].includes(exercise.name),
    );
    expect(original).toBeDefined();

    const result = applyPlanChange(
      content,
      { kind: 'SWAP_EXERCISE', from: exercise.name },
      constraints,
    );

    const swapped = result.content.strength.days[0]?.exercises[0];
    expect(swapped?.name).not.toBe(exercise.name);
    expect(swapped?.notes).toMatch(/^catalog:/);
    // The prescription belongs to the rules and is carried over untouched.
    expect(swapped?.targetSets).toBe(exercise.targetSets);
    expect(swapped?.targetRepsMin).toBe(exercise.targetRepsMin);
    expect(swapped?.targetRIR).toBe(exercise.targetRIR);
    expect(result.resolvedExercise?.name).toBe(swapped?.name);
    expect(result.diff[0]).toEqual(
      expect.objectContaining({ kind: 'exercise', before: exercise.name }),
    );
  });

  it('honours an explicit substitute', () => {
    const content = plan();
    const { exercise } = firstExercise(content);
    // Ask the rules what they would pick, then demand exactly that: the model
    // naming a movement must not produce a different plan than letting the
    // rules choose, or the two paths would drift apart.
    const automatic = applyPlanChange(
      content,
      { kind: 'SWAP_EXERCISE', from: exercise.name },
      constraints,
    );
    const requested = automatic.content.strength.days[0]?.exercises[0]?.name;
    if (!requested) throw new Error('fixture produced no substitute');

    const result = applyPlanChange(
      content,
      { kind: 'SWAP_EXERCISE', from: exercise.name, to: requested },
      constraints,
    );

    expect(result.content.strength.days[0]?.exercises[0]?.name).toBe(requested);
  });

  it('refuses a substitute the trainee has no equipment for', () => {
    const content = plan();
    const { exercise } = firstExercise(content);

    expect(() =>
      applyPlanChange(
        content,
        { kind: 'SWAP_EXERCISE', from: exercise.name, to: 'Back Squat' },
        constraints,
      ),
    ).toThrow(PlanChangeError);
  });

  it('refuses an exercise that is not in the plan', () => {
    expect(() =>
      applyPlanChange(plan(), { kind: 'SWAP_EXERCISE', from: 'Barbell Clean' }, constraints),
    ).toThrow(PlanChangeError);
  });

  it('refuses to swap in something the day already trains', () => {
    const content = plan();
    const day = content.strength.days[0];
    const first = day?.exercises[0];
    const second = day?.exercises[1];
    if (!first || !second) throw new Error('fixture too small');

    expect(() =>
      applyPlanChange(
        content,
        { kind: 'SWAP_EXERCISE', from: first.name, to: second.name },
        constraints,
      ),
    ).toThrow(PlanChangeError);
  });
});

describe('MOVE_TRAINING_DAY', () => {
  it('moves the day and rebuilds the schedule around it', () => {
    const content = plan();
    const from = content.strength.days[0]?.dayOfWeek ?? 1;

    const result = applyPlanChange(
      content,
      { kind: 'MOVE_TRAINING_DAY', from, to: 2 },
      constraints,
    );

    expect(result.content.strength.days[0]?.dayOfWeek).toBe(2);
    const schedule = new Map(result.content.schedule.days.map((day) => [day.dayOfWeek, day]));
    expect(schedule.get(from)?.kind).toBe('REST');
    expect(schedule.get(from)?.strengthDayIndex).toBeNull();
    expect(schedule.get(2)?.kind).toMatch(/^STRENGTH/);
    expect(schedule.get(2)?.strengthDayIndex).toBe(0);
  });

  it('refuses a day the trainee is not available', () => {
    const content = plan();
    const from = content.strength.days[0]?.dayOfWeek ?? 1;

    expect(() =>
      applyPlanChange(content, { kind: 'MOVE_TRAINING_DAY', from, to: 7 }, constraints),
    ).toThrow(PlanChangeError);
  });

  it('refuses a day that already has a session', () => {
    const content = plan();
    const from = content.strength.days[0]?.dayOfWeek ?? 1;
    const to = content.strength.days[1]?.dayOfWeek ?? 3;

    expect(() =>
      applyPlanChange(content, { kind: 'MOVE_TRAINING_DAY', from, to }, constraints),
    ).toThrow(PlanChangeError);
  });

  it('refuses a weekday that is not a training day', () => {
    expect(() =>
      applyPlanChange(plan(), { kind: 'MOVE_TRAINING_DAY', from: 2, to: 4 }, constraints),
    ).toThrow(PlanChangeError);
  });
});

describe('SET_CARDIO_MINUTES', () => {
  it('redistributes the minutes so the days still add up', () => {
    const content = plan();
    const before = content.cardio.additionalWeeklyMin;
    expect(before).toBeGreaterThan(20);

    const result = applyPlanChange(content, { kind: 'SET_CARDIO_MINUTES', minutes: 45 }, {
      ...constraints,
    });

    const total = result.content.cardio.sessions.reduce(
      (sum, session) => sum + session.durationMin,
      0,
    );
    expect(total).toBe(45);
    expect(result.content.cardio.additionalWeeklyMin).toBe(45);

    // The derived schedule follows without being patched by hand.
    const scheduled = result.content.schedule.days.reduce((sum, day) => sum + day.cardioMin, 0);
    expect(scheduled).toBe(45);
  });

  it('drops the sessions entirely at zero', () => {
    const result = applyPlanChange(plan(), { kind: 'SET_CARDIO_MINUTES', minutes: 0 }, constraints);

    expect(result.content.cardio.sessions).toEqual([]);
    expect(result.content.cardio.additionalWeeklyMin).toBe(0);
    expect(result.content.schedule.days.every((day) => day.kind !== 'CARDIO')).toBe(true);
  });

  it('refuses an impossible amount', () => {
    expect(() =>
      applyPlanChange(plan(), { kind: 'SET_CARDIO_MINUTES', minutes: 900 }, constraints),
    ).toThrow(PlanChangeError);
  });
});

describe('allocate', () => {
  it('splits minutes so they add back up exactly', () => {
    expect(allocate(90, 2)).toEqual([45, 45]);
    expect(allocate(100, 3)).toEqual([34, 33, 33]);
    expect(allocate(90, 0)).toEqual([]);
    for (const total of [5, 7, 45, 100, 299]) {
      for (const count of [1, 2, 3]) {
        expect(allocate(total, count).reduce((sum, value) => sum + value, 0)).toBe(total);
      }
    }
  });
});
