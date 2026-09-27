import { describe, expect, it } from 'vitest';

import { EquipmentType, ExerciseCategory, MuscleGroup } from '@/lib/prisma-client';

import {
  ACCESSORY_PATTERN_PRIORITY,
  CORE_WORKOUT_TEMPLATES,
  PRIMARY_PATTERN_TO_MUSCLE_GROUP,
  StrengthPlanConstraintError,
  buildStrengthPlan,
  estimateWorkoutDurationMin,
  type StrengthPlanInput,
} from './strength-plan';
import { STRENGTH_EXERCISE_CATALOG, type MovementPattern } from './exercise-catalog';

const allEquipment: StrengthPlanInput['equipmentTypes'] = [
  EquipmentType.BARBELL,
  EquipmentType.DUMBBELL,
  EquipmentType.MACHINE,
  EquipmentType.CABLE,
  EquipmentType.BODYWEIGHT,
];

function input(overrides: Partial<StrengthPlanInput> = {}): StrengthPlanInput {
  return {
    trainingAgeMonths: 12,
    weeklyFrequency: 3,
    availableWeekdays: [1, 3, 5],
    sessionDurationMin: 120,
    equipmentTypes: allEquipment,
    unavailableExerciseNames: [],
    ...overrides,
  };
}

function patternForNotes(notes: string | null | undefined): MovementPattern {
  const key = notes?.replace(/^catalog:/, '');
  const catalogExercise = STRENGTH_EXERCISE_CATALOG.find((exercise) => exercise.key === key);
  if (!catalogExercise) throw new Error(`Unknown catalog notes: ${notes}`);
  return catalogExercise.movementPattern;
}

describe('strength planning constants', () => {
  it('exports the exact core templates and accessory order', () => {
    expect(CORE_WORKOUT_TEMPLATES).toMatchInlineSnapshot(`
      {
        "Full Body A": [
          "SQUAT",
          "HINGE",
          "HORIZONTAL_PUSH",
          "HORIZONTAL_PULL",
          "VERTICAL_PUSH",
          "VERTICAL_PULL",
        ],
        "Full Body B": [
          "SQUAT",
          "HINGE",
          "HORIZONTAL_PUSH",
          "HORIZONTAL_PULL",
          "VERTICAL_PUSH",
          "VERTICAL_PULL",
        ],
        "Full Body C": [
          "SQUAT",
          "HINGE",
          "HORIZONTAL_PUSH",
          "HORIZONTAL_PULL",
          "VERTICAL_PUSH",
          "VERTICAL_PULL",
        ],
        "Legs": [
          "SQUAT",
          "HINGE",
        ],
        "Lower": [
          "SQUAT",
          "HINGE",
        ],
        "Lower A": [
          "SQUAT",
          "HINGE",
        ],
        "Lower B": [
          "SQUAT",
          "HINGE",
        ],
        "Pull": [
          "HORIZONTAL_PULL",
          "VERTICAL_PULL",
        ],
        "Push": [
          "HORIZONTAL_PUSH",
          "VERTICAL_PUSH",
        ],
        "Upper": [
          "HORIZONTAL_PUSH",
          "HORIZONTAL_PULL",
          "VERTICAL_PUSH",
          "VERTICAL_PULL",
        ],
        "Upper A": [
          "HORIZONTAL_PUSH",
          "HORIZONTAL_PULL",
          "VERTICAL_PUSH",
          "VERTICAL_PULL",
        ],
        "Upper B": [
          "HORIZONTAL_PUSH",
          "HORIZONTAL_PULL",
          "VERTICAL_PUSH",
          "VERTICAL_PULL",
        ],
      }
    `);
    expect(ACCESSORY_PATTERN_PRIORITY).toEqual([
      'LATERAL_SHOULDER',
      'TRUNK',
      'BICEPS',
      'TRICEPS',
      'CALVES',
      'KNEE_ISOLATION',
      'HAMSTRING_ISOLATION',
    ]);
    expect(PRIMARY_PATTERN_TO_MUSCLE_GROUP).toEqual({
      SQUAT: MuscleGroup.QUADS,
      HINGE: MuscleGroup.HAMSTRINGS,
      HORIZONTAL_PUSH: MuscleGroup.CHEST,
      HORIZONTAL_PULL: MuscleGroup.BACK_THICKNESS,
      VERTICAL_PUSH: MuscleGroup.SHOULDERS_FRONT,
      VERTICAL_PULL: MuscleGroup.BACK_WIDTH,
    });
  });
});

describe('STRENGTH_EXERCISE_CATALOG', () => {
  it('contains the required canonical alternatives in stable order', () => {
    const namesFor = (pattern: MovementPattern) =>
      STRENGTH_EXERCISE_CATALOG.filter((exercise) => exercise.movementPattern === pattern).map(
        (exercise) => exercise.name,
      );

    expect(namesFor('SQUAT')).toEqual([
      'Back Squat',
      'Goblet Squat',
      'Leg Press',
      'Bodyweight Squat',
    ]);
    expect(namesFor('HINGE')).toEqual([
      'Romanian Deadlift',
      'Dumbbell Romanian Deadlift',
      'Cable Pull Through',
      'Hip Bridge',
    ]);
    expect(namesFor('HORIZONTAL_PUSH')).toEqual([
      'Bench Press',
      'Dumbbell Bench Press',
      'Chest Press',
      'Push-up',
    ]);
    expect(namesFor('HORIZONTAL_PULL')).toEqual([
      'Barbell Row',
      'One-arm Dumbbell Row',
      'Seated Cable Row',
      'Inverted Row',
    ]);
    expect(namesFor('VERTICAL_PUSH')).toEqual([
      'Overhead Press',
      'Dumbbell Shoulder Press',
      'Machine Shoulder Press',
      'Pike Push-up',
    ]);
    expect(namesFor('VERTICAL_PULL')).toEqual(['Pull-up', 'Lat Pulldown', 'Cable Pulldown']);
    expect(namesFor('LATERAL_SHOULDER')).toEqual([
      'Cable Lateral Raise',
      'Dumbbell Lateral Raise',
      'Machine Lateral Raise',
    ]);
    expect(namesFor('KNEE_ISOLATION')).toEqual(['Leg Extension', 'Reverse Lunge', 'Split Squat']);
    expect(namesFor('HAMSTRING_ISOLATION')).toEqual([
      'Leg Curl',
      'Sliding Leg Curl',
      'Single-leg Hip Bridge',
    ]);
    expect(namesFor('BICEPS')).toEqual([
      'Cable Curl',
      'Dumbbell Curl',
      'Barbell Curl',
      'Bodyweight Curl',
    ]);
    expect(namesFor('TRICEPS')).toEqual([
      'Cable Triceps Extension',
      'Dumbbell Overhead Extension',
      'Close-grip Push-up',
    ]);
    expect(namesFor('CALVES')).toEqual([
      'Standing Calf Raise',
      'Dumbbell Calf Raise',
      'Machine Calf Raise',
    ]);
    expect(namesFor('TRUNK')).toEqual(['Cable Crunch', 'Plank', 'Dead Bug']);
  });

  it('marks bodyweight status explicitly and has stable unique keys', () => {
    expect(new Set(STRENGTH_EXERCISE_CATALOG.map((exercise) => exercise.key)).size).toBe(
      STRENGTH_EXERCISE_CATALOG.length,
    );
    for (const exercise of STRENGTH_EXERCISE_CATALOG) {
      expect(exercise.usesBodyweight).toBe(exercise.equipmentType === EquipmentType.BODYWEIGHT);
      expect(exercise.aliases).toBeInstanceOf(Array);
    }
  });
});

describe('buildStrengthPlan', () => {
  it.each([
    [2, 'FULL_BODY_AB', ['Full Body A', 'Full Body B']],
    [3, 'FULL_BODY_ABC', ['Full Body A', 'Full Body B', 'Full Body C']],
    [4, 'UPPER_LOWER', ['Upper A', 'Lower A', 'Upper B', 'Lower B']],
    [5, 'UPPER_LOWER_PPL', ['Upper', 'Lower', 'Push', 'Pull', 'Legs']],
  ] as const)('maps frequency %i to %s and fixed day labels', (weeklyFrequency, split, names) => {
    const plan = buildStrengthPlan(
      input({
        weeklyFrequency,
        availableWeekdays: [7, 2, 5, 1, 4].slice(0, weeklyFrequency),
      }),
    );

    expect(plan.split).toBe(split);
    expect(plan.days.map((day) => day.name)).toEqual(names);
  });

  it.each([
    [0, 6],
    [6, 8],
    [24, 8],
    [25, 10],
    [49, 10],
    [500, 10],
    [600, 10],
  ])('sets the weekly primary target for training age %i to %i', (trainingAgeMonths, target) => {
    const plan = buildStrengthPlan(input({ trainingAgeMonths }));

    expect(plan.weeklyTargetSets).toBe(target);
    expect(plan.achievedSetsByMuscleGroup).toEqual({
      [MuscleGroup.QUADS]: target,
      [MuscleGroup.HAMSTRINGS]: target,
      [MuscleGroup.CHEST]: target,
      [MuscleGroup.BACK_THICKNESS]: target,
      [MuscleGroup.SHOULDERS_FRONT]: target,
      [MuscleGroup.BACK_WIDTH]: target,
    });
  });

  it('uses compound and isolation rep ranges with steady RIR 2', () => {
    const plan = buildStrengthPlan(input());

    for (const exercise of plan.days.flatMap((day) => day.exercises)) {
      expect(exercise.targetRIR).toBe(2);
      if (exercise.category === ExerciseCategory.COMPOUND) {
        expect([exercise.targetRepsMin, exercise.targetRepsMax]).toEqual([6, 10]);
        expect(exercise.restSec).toBeGreaterThanOrEqual(150);
      } else {
        expect([exercise.targetRepsMin, exercise.targetRepsMax]).toEqual([10, 15]);
        expect(exercise.restSec).toBeGreaterThanOrEqual(75);
      }
    }
  });

  it('adds only the novice preview RIR override below six training months', () => {
    const novice = buildStrengthPlan(input({ trainingAgeMonths: 5 }));
    const trained = buildStrengthPlan(input({ trainingAgeMonths: 6 }));

    expect(novice).toMatchObject({
      introRir: 3,
      introDurationDays: 14,
      steadyRir: 2,
      reasons: ['STRENGTH_NOVICE_RIR_BUFFER'],
    });
    expect(trained).toMatchObject({ introRir: null, introDurationDays: 0, steadyRir: 2 });
    expect(trained.reasons).not.toContain('STRENGTH_NOVICE_RIR_BUFFER');
  });

  it('uses only explicitly bodyweight catalog entries for bodyweight-only input', () => {
    const plan = buildStrengthPlan(
      input({ equipmentTypes: [EquipmentType.BODYWEIGHT], sessionDurationMin: 90 }),
    );

    for (const exercise of plan.days.flatMap((day) => day.exercises)) {
      expect(exercise.equipmentType).toBe(EquipmentType.BODYWEIGHT);
      expect(exercise.usesBodyweight).toBe(true);
    }
  });

  it('never selects dumbbell, cable, or machine work with barbell plus bodyweight', () => {
    const plan = buildStrengthPlan(
      input({ equipmentTypes: [EquipmentType.BARBELL, EquipmentType.BODYWEIGHT] }),
    );

    expect(
      plan.days
        .flatMap((day) => day.exercises)
        .every((exercise) =>
          new Set<EquipmentType>([EquipmentType.BARBELL, EquipmentType.BODYWEIGHT]).has(
            exercise.equipmentType!,
          ),
        ),
    ).toBe(true);
  });

  it('selects canonical alternatives in catalog rotation order with full equipment', () => {
    const plan = buildStrengthPlan(input());
    const coreNames = plan.days.map((day) =>
      day.exercises
        .slice(0, CORE_WORKOUT_TEMPLATES[day.name]!.length)
        .map((exercise) => exercise.name),
    );

    expect(coreNames).toEqual([
      [
        'Back Squat',
        'Romanian Deadlift',
        'Bench Press',
        'Barbell Row',
        'Overhead Press',
        'Pull-up',
      ],
      [
        'Goblet Squat',
        'Dumbbell Romanian Deadlift',
        'Dumbbell Bench Press',
        'One-arm Dumbbell Row',
        'Dumbbell Shoulder Press',
        'Lat Pulldown',
      ],
      [
        'Leg Press',
        'Cable Pull Through',
        'Chest Press',
        'Seated Cable Row',
        'Machine Shoulder Press',
        'Cable Pulldown',
      ],
    ]);
  });

  it.each(['Bench Press', 'Barbell bench press'])(
    'excludes an unavailable canonical name or explicit legacy alias: %s',
    (unavailableName) => {
      const plan = buildStrengthPlan(input({ unavailableExerciseNames: [unavailableName] }));

      expect(plan.days[0]!.exercises.map((exercise) => exercise.name)).not.toContain('Bench Press');
      expect(plan.days[0]!.exercises).toContainEqual(
        expect.objectContaining({ name: 'Dumbbell Bench Press' }),
      );
    },
  );

  it.each([
    ['Squats · Barbell', 'Back Squat'],
    ['Goblet squat', 'Goblet Squat'],
    ['Leg Press · Machine', 'Leg Press'],
    ['Leg press (45 deg)', 'Leg Press'],
    ['Flat dumbbell bench press', 'Dumbbell Bench Press'],
    ['Machine chest press', 'Chest Press'],
    ['Single-arm dumbbell row', 'One-arm Dumbbell Row'],
    ['One-Arm Rows · Dumbbells', 'One-arm Dumbbell Row'],
    ['Rows with Close Grip · Cable', 'Seated Cable Row'],
    ['Rows with Reverse Grip · Cable', 'Seated Cable Row'],
    ['Rows with Wide Neutral Grip · Cable', 'Seated Cable Row'],
    ['Standing barbell overhead press', 'Overhead Press'],
    ['Standing Shoulder Press · Barbell', 'Overhead Press'],
    ['Seated Shoulder Press with Close Grip · Dumbbells', 'Dumbbell Shoulder Press'],
    ['Seated Shoulder Press · Dumbbells', 'Dumbbell Shoulder Press'],
    ['Pull-Ups with Wide Overhand Grip · Bodyweight', 'Pull-up'],
    ['Lat Pulldowns with Close Neutral Grip · Cable', 'Cable Pulldown'],
    ['Lat Pulldowns with Close Overhand Grip · Cable', 'Cable Pulldown'],
    ['Lateral Raises · Dumbbells', 'Dumbbell Lateral Raise'],
    ['Dumbbell lateral raise', 'Dumbbell Lateral Raise'],
    ['Leg Extensions · Machine', 'Leg Extension'],
    ['Bulgarian split squat', 'Split Squat'],
    ['Bulgarian Split Squats · Dumbbells', 'Split Squat'],
    ['Leg Curls on Leg Extension Machine · Machine', 'Leg Curl'],
    ['Lying Leg Curls · Machine', 'Leg Curl'],
    ['Lying leg curl', 'Leg Curl'],
    ['Seated leg curl', 'Leg Curl'],
    ['Standing cable curl (straight bar)', 'Cable Curl'],
    ['Behind-the-Back Curls · Cable', 'Cable Curl'],
    ['Triceps Pushdowns with Rope · Cable', 'Cable Triceps Extension'],
    ['Overhead cable triceps extension', 'Cable Triceps Extension'],
    ['Standing calf raise (or machine)', 'Standing Calf Raise'],
    ['Seated Calf Raises · Machine', 'Machine Calf Raise'],
    ['Plank + side plank', 'Plank'],
  ])('uses the exact legacy alias %s to exclude %s', (legacyAlias, canonicalName) => {
    const catalogEntry = STRENGTH_EXERCISE_CATALOG.find(
      (exercise) => exercise.name === canonicalName,
    );
    const baseline = buildStrengthPlan(input());
    const constrained = buildStrengthPlan(input({ unavailableExerciseNames: [legacyAlias] }));

    expect(catalogEntry?.aliases).toContain(legacyAlias);
    expect(
      baseline.days.flatMap((day) => day.exercises.map((exercise) => exercise.name)),
    ).toContain(canonicalName);
    expect(
      constrained.days.flatMap((day) => day.exercises.map((exercise) => exercise.name)),
    ).not.toContain(canonicalName);
  });

  it('does not use fuzzy matching for unavailable exercise names', () => {
    const plan = buildStrengthPlan(input({ unavailableExerciseNames: ['Bench Pres'] }));

    expect(plan.days[0]!.exercises.map((exercise) => exercise.name)).toContain('Bench Press');
  });

  it('normalizes submitted availability to distinct ascending weekdays without inventing days', () => {
    const plan = buildStrengthPlan(
      input({ weeklyFrequency: 4, availableWeekdays: [7, 2, 6, 1, 4] }),
    );

    expect(plan.days.map((day) => day.dayOfWeek)).toEqual([1, 2, 4, 6]);
    expect(plan.days.every((day) => [7, 2, 6, 1, 4].includes(day.dayOfWeek!))).toBe(true);
  });

  it.each([45, 60, 90])('fits every workout into a feasible %i-minute session', (duration) => {
    const plan = buildStrengthPlan(
      input({
        trainingAgeMonths: 25,
        weeklyFrequency: 3,
        sessionDurationMin: duration,
      }),
    );

    for (const day of plan.days) {
      expect(day.estimatedDurationMin).toBe(estimateWorkoutDurationMin(day));
      expect(day.estimatedDurationMin).toBeLessThanOrEqual(duration);
    }
  });

  it('removes low-priority isolation work before reducing core sets', () => {
    const plan = buildStrengthPlan(
      input({ weeklyFrequency: 2, availableWeekdays: [1, 4], sessionDurationMin: 90 }),
    );
    const firstDayPatterns = plan.days[0]!.exercises.map((exercise) =>
      patternForNotes(exercise.notes),
    );

    expect(plan.achievedSetsByMuscleGroup).toEqual({
      [MuscleGroup.QUADS]: 8,
      [MuscleGroup.HAMSTRINGS]: 8,
      [MuscleGroup.CHEST]: 8,
      [MuscleGroup.BACK_THICKNESS]: 8,
      [MuscleGroup.SHOULDERS_FRONT]: 8,
      [MuscleGroup.BACK_WIDTH]: 8,
    });
    expect(firstDayPatterns).toContain('LATERAL_SHOULDER');
    expect(firstDayPatterns).not.toContain('HAMSTRING_ISOLATION');
  });

  it('retains every required weekly pattern and records reduced primary volume', () => {
    const plan = buildStrengthPlan(
      input({ weeklyFrequency: 2, availableWeekdays: [1, 4], sessionDurationMin: 45 }),
    );
    const weeklyPatterns = new Set(
      plan.days.flatMap((day) => day.exercises.map((exercise) => patternForNotes(exercise.notes))),
    );

    expect(weeklyPatterns).toEqual(
      new Set([
        'SQUAT',
        'HINGE',
        'HORIZONTAL_PUSH',
        'HORIZONTAL_PULL',
        'VERTICAL_PUSH',
        'VERTICAL_PULL',
      ]),
    );
    expect(Object.values(plan.achievedSetsByMuscleGroup).every((sets) => sets < 8)).toBe(true);
    expect(plan.reasons).toContain('STRENGTH_DURATION_REDUCED');
  });

  it('throws a calculated constraint error rather than removing core movements', () => {
    expect.assertions(3);
    try {
      buildStrengthPlan(
        input({ weeklyFrequency: 2, availableWeekdays: [1, 4], sessionDurationMin: 30 }),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(StrengthPlanConstraintError);
      expect(error).toMatchObject({ code: 'SESSION_DURATION_UNSATISFIABLE' });
      expect((error as StrengthPlanConstraintError).minimumDurationMin).toBeGreaterThan(30);
    }
  });

  it('uses the documented duration equation', () => {
    expect(
      estimateWorkoutDurationMin({
        name: 'Test',
        dayOfWeek: 1,
        exercises: [
          {
            name: 'One',
            muscleGroup: MuscleGroup.CHEST,
            category: ExerciseCategory.COMPOUND,
            equipmentType: EquipmentType.BARBELL,
            usesBodyweight: false,
            targetSets: 3,
            targetRepsMin: 6,
            targetRepsMax: 10,
            targetRIR: 2,
            restSec: 150,
          },
          {
            name: 'Two',
            muscleGroup: MuscleGroup.BACK_THICKNESS,
            category: ExerciseCategory.COMPOUND,
            equipmentType: EquipmentType.BARBELL,
            usesBodyweight: false,
            targetSets: 3,
            targetRepsMin: 6,
            targetRepsMax: 10,
            targetRIR: 2,
            restSec: 150,
          },
        ],
      }),
    ).toBe(23);
  });

  it.each([
    ['negative training age', { trainingAgeMonths: -1 }],
    ['fractional training age', { trainingAgeMonths: 1.5 }],
    ['nonfinite training age', { trainingAgeMonths: Number.POSITIVE_INFINITY }],
    ['training age above canonical maximum', { trainingAgeMonths: 601 }],
    ['invalid frequency', { weeklyFrequency: 6 }],
    ['weekday below range', { availableWeekdays: [0, 2, 4] }],
    ['weekday above range', { availableWeekdays: [1, 3, 8] }],
    ['duplicate weekday', { availableWeekdays: [1, 1, 3] }],
    ['insufficient availability', { availableWeekdays: [1, 3] }],
    ['nonpositive duration', { sessionDurationMin: 0 }],
    ['duration below minimum', { sessionDurationMin: 29 }],
    ['duration outside five-minute increments', { sessionDurationMin: 31 }],
    ['fractional duration', { sessionDurationMin: 45.5 }],
    ['nonfinite duration', { sessionDurationMin: Number.NaN }],
    ['duration above maximum', { sessionDurationMin: 121 }],
    ['five-minute duration above maximum', { sessionDurationMin: 125 }],
    ['empty equipment', { equipmentTypes: [] }],
    ['unsupported equipment', { equipmentTypes: ['CARDIO'] }],
    ['duplicate equipment', { equipmentTypes: ['BARBELL', 'BARBELL'] }],
    ['blank unavailable name', { unavailableExerciseNames: ['  '] }],
    ['duplicate unavailable name', { unavailableExerciseNames: ['Bench Press', 'bench press'] }],
  ])('rejects %s at runtime', (_label, overrides) => {
    expect(() => buildStrengthPlan(input(overrides as Partial<StrengthPlanInput>))).toThrow(
      RangeError,
    );
  });

  it('is deterministic and does not mutate normalized input', () => {
    const value = input({
      availableWeekdays: [5, 1, 3],
      equipmentTypes: [EquipmentType.CABLE, EquipmentType.BODYWEIGHT],
      unavailableExerciseNames: ['Cable Lateral Raise'],
    });
    const before = structuredClone(value);

    expect(buildStrengthPlan(value)).toEqual(buildStrengthPlan(value));
    expect(value).toEqual(before);
  });
});
