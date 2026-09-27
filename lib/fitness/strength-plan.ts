import { EquipmentType, ExerciseCategory, MuscleGroup } from '@/lib/prisma-client';
import {
  generatedWorkoutSchema,
  type GeneratedExercise,
  type GeneratedWorkout,
} from '@/lib/schemas/program-generation';

import {
  STRENGTH_EXERCISE_CATALOG,
  type MovementPattern,
  type StrengthCatalogExercise,
} from './exercise-catalog';
import type { EquipmentType as StrengthEquipmentType } from './exercise-keys';

export type StrengthSplit = 'FULL_BODY_AB' | 'FULL_BODY_ABC' | 'UPPER_LOWER' | 'UPPER_LOWER_PPL';

export type PrimaryMovementPattern = Extract<
  MovementPattern,
  'SQUAT' | 'HINGE' | 'HORIZONTAL_PUSH' | 'HORIZONTAL_PULL' | 'VERTICAL_PUSH' | 'VERTICAL_PULL'
>;

export type AccessoryMovementPattern = Exclude<MovementPattern, PrimaryMovementPattern>;

const fullBodyPatterns = [
  'SQUAT',
  'HINGE',
  'HORIZONTAL_PUSH',
  'HORIZONTAL_PULL',
  'VERTICAL_PUSH',
  'VERTICAL_PULL',
] as const satisfies readonly PrimaryMovementPattern[];

const upperPatterns = [
  'HORIZONTAL_PUSH',
  'HORIZONTAL_PULL',
  'VERTICAL_PUSH',
  'VERTICAL_PULL',
] as const satisfies readonly PrimaryMovementPattern[];

const lowerPatterns = ['SQUAT', 'HINGE'] as const satisfies readonly PrimaryMovementPattern[];

export const CORE_WORKOUT_TEMPLATES: Readonly<Record<string, readonly PrimaryMovementPattern[]>> = {
  'Full Body A': fullBodyPatterns,
  'Full Body B': fullBodyPatterns,
  'Full Body C': fullBodyPatterns,
  Legs: lowerPatterns,
  Lower: lowerPatterns,
  'Lower A': lowerPatterns,
  'Lower B': lowerPatterns,
  Pull: ['HORIZONTAL_PULL', 'VERTICAL_PULL'],
  Push: ['HORIZONTAL_PUSH', 'VERTICAL_PUSH'],
  Upper: upperPatterns,
  'Upper A': upperPatterns,
  'Upper B': upperPatterns,
};

export const ACCESSORY_PATTERN_PRIORITY = [
  'LATERAL_SHOULDER',
  'TRUNK',
  'BICEPS',
  'TRICEPS',
  'CALVES',
  'KNEE_ISOLATION',
  'HAMSTRING_ISOLATION',
] as const satisfies readonly AccessoryMovementPattern[];

export const PRIMARY_PATTERN_TO_MUSCLE_GROUP = {
  SQUAT: MuscleGroup.QUADS,
  HINGE: MuscleGroup.HAMSTRINGS,
  HORIZONTAL_PUSH: MuscleGroup.CHEST,
  HORIZONTAL_PULL: MuscleGroup.BACK_THICKNESS,
  VERTICAL_PUSH: MuscleGroup.SHOULDERS_FRONT,
  VERTICAL_PULL: MuscleGroup.BACK_WIDTH,
} as const satisfies Record<PrimaryMovementPattern, MuscleGroup>;

export const CORE_TEMPLATES = CORE_WORKOUT_TEMPLATES;
export const ACCESSORY_PRIORITY = ACCESSORY_PATTERN_PRIORITY;

const splitByFrequency = {
  2: { split: 'FULL_BODY_AB', names: ['Full Body A', 'Full Body B'] },
  3: { split: 'FULL_BODY_ABC', names: ['Full Body A', 'Full Body B', 'Full Body C'] },
  4: { split: 'UPPER_LOWER', names: ['Upper A', 'Lower A', 'Upper B', 'Lower B'] },
  5: { split: 'UPPER_LOWER_PPL', names: ['Upper', 'Lower', 'Push', 'Pull', 'Legs'] },
} as const satisfies Record<
  StrengthPlanInput['weeklyFrequency'],
  { split: StrengthSplit; names: readonly string[] }
>;

const supportedEquipment = new Set<StrengthEquipmentType>([
  EquipmentType.DUMBBELL,
  EquipmentType.BARBELL,
  EquipmentType.MACHINE,
  EquipmentType.CABLE,
  EquipmentType.BODYWEIGHT,
]);

export type StrengthPlanInput = {
  trainingAgeMonths: number;
  weeklyFrequency: 2 | 3 | 4 | 5;
  availableWeekdays: number[];
  sessionDurationMin: number;
  equipmentTypes: StrengthEquipmentType[];
  unavailableExerciseNames: string[];
  // Catalog names the strategy asked to bias towards. They still have to match
  // the movement pattern the day needs and the trainee's equipment: a preference
  // reorders the candidates, it does not add any.
  preferredExerciseNames?: string[];
};

export type StrengthPlanDay = GeneratedWorkout & {
  estimatedDurationMin: number;
  lowerBodyDemand: boolean;
};

export type StrengthPlanReason = 'STRENGTH_NOVICE_RIR_BUFFER' | 'STRENGTH_DURATION_REDUCED';

export type StrengthPrescription = {
  split: StrengthSplit;
  weeklyTargetSets: 6 | 8 | 10;
  introRir: 3 | null;
  introDurationDays: 14 | 0;
  steadyRir: 2;
  achievedSetsByMuscleGroup: Partial<Record<MuscleGroup, number>>;
  days: StrengthPlanDay[];
  reasons: StrengthPlanReason[];
};

export class StrengthPlanConstraintError extends Error {
  readonly code = 'SESSION_DURATION_UNSATISFIABLE' as const;

  constructor(readonly minimumDurationMin: number) {
    super(`Strength sessions require at least ${minimumDurationMin} minutes.`);
    this.name = 'StrengthPlanConstraintError';
  }
}

type NormalizedInput = Omit<
  StrengthPlanInput,
  'availableWeekdays' | 'unavailableExerciseNames' | 'preferredExerciseNames'
> & {
  availableWeekdays: number[];
  unavailableExerciseNames: Set<string>;
  preferredExerciseNames: Set<string>;
};

type MutablePlannedExercise = GeneratedExercise & {
  catalog: StrengthCatalogExercise;
};

type MutablePlannedWorkout = {
  name: string;
  dayOfWeek: number;
  exercises: MutablePlannedExercise[];
  lowerBodyDemand: boolean;
};

function normalizedName(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function validateInput(input: StrengthPlanInput): NormalizedInput {
  if (
    !Number.isFinite(input.trainingAgeMonths) ||
    !Number.isInteger(input.trainingAgeMonths) ||
    input.trainingAgeMonths < 0 ||
    input.trainingAgeMonths > 600
  ) {
    throw new RangeError('trainingAgeMonths must be a finite integer from 0 through 600');
  }
  if (![2, 3, 4, 5].includes(input.weeklyFrequency)) {
    throw new RangeError('weeklyFrequency must be 2, 3, 4, or 5');
  }
  if (!Array.isArray(input.availableWeekdays)) {
    throw new RangeError('availableWeekdays must be an array');
  }
  const weekdaySet = new Set<number>();
  for (const weekday of input.availableWeekdays) {
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
      throw new RangeError('availableWeekdays must contain integers from 1 through 7');
    }
    if (weekdaySet.has(weekday)) {
      throw new RangeError('availableWeekdays must be unique');
    }
    weekdaySet.add(weekday);
  }
  if (weekdaySet.size < input.weeklyFrequency) {
    throw new RangeError('availableWeekdays must contain at least weeklyFrequency days');
  }
  if (
    !Number.isFinite(input.sessionDurationMin) ||
    !Number.isInteger(input.sessionDurationMin) ||
    input.sessionDurationMin < 30 ||
    input.sessionDurationMin > 120 ||
    input.sessionDurationMin % 5 !== 0
  ) {
    throw new RangeError('sessionDurationMin must be a five-minute increment from 30 through 120');
  }
  if (!Array.isArray(input.equipmentTypes)) {
    throw new RangeError('equipmentTypes must be an array');
  }
  if (input.equipmentTypes.length === 0) {
    throw new RangeError('equipmentTypes must contain at least one strength equipment type');
  }
  const equipmentSet = new Set<StrengthEquipmentType>();
  for (const equipmentType of input.equipmentTypes) {
    if (!supportedEquipment.has(equipmentType)) {
      throw new RangeError('equipmentTypes contains an unsupported strength equipment type');
    }
    if (equipmentSet.has(equipmentType)) {
      throw new RangeError('equipmentTypes must be unique');
    }
    equipmentSet.add(equipmentType);
  }
  if (!Array.isArray(input.unavailableExerciseNames)) {
    throw new RangeError('unavailableExerciseNames must be an array');
  }
  const unavailableExerciseNames = new Set<string>();
  for (const name of input.unavailableExerciseNames) {
    if (typeof name !== 'string' || name.trim().length === 0 || name.trim().length > 120) {
      throw new RangeError('unavailableExerciseNames must contain nonempty exercise names');
    }
    const normalized = normalizedName(name);
    if (unavailableExerciseNames.has(normalized)) {
      throw new RangeError('unavailableExerciseNames must be unique');
    }
    unavailableExerciseNames.add(normalized);
  }

  return {
    ...input,
    availableWeekdays: [...weekdaySet].sort((left, right) => left - right),
    equipmentTypes: [...equipmentSet],
    unavailableExerciseNames,
    preferredExerciseNames: new Set(
      (input.preferredExerciseNames ?? []).map((name) => normalizedName(name)),
    ),
  };
}

function weeklyTargetSets(trainingAgeMonths: number): 6 | 8 | 10 {
  if (trainingAgeMonths < 6) return 6;
  if (trainingAgeMonths <= 24) return 8;
  return 10;
}

function variationIndex(name: string): number {
  if (name.endsWith(' B')) return 1;
  if (name.endsWith(' C')) return 2;
  return 0;
}

function isUnavailable(
  exercise: StrengthCatalogExercise,
  unavailableNames: ReadonlySet<string>,
): boolean {
  return [exercise.name, ...exercise.aliases].some((name) =>
    unavailableNames.has(normalizedName(name)),
  );
}

function isPreferred(
  exercise: StrengthCatalogExercise,
  preferredNames: ReadonlySet<string>,
): boolean {
  return [exercise.name, ...exercise.aliases].some((name) =>
    preferredNames.has(normalizedName(name)),
  );
}

function selectExercise(
  pattern: MovementPattern,
  rotation: number,
  input: NormalizedInput,
): StrengthCatalogExercise | undefined {
  const availableEquipment = new Set(input.equipmentTypes);
  availableEquipment.add(EquipmentType.BODYWEIGHT);
  const alternatives = STRENGTH_EXERCISE_CATALOG.filter(
    (exercise) =>
      exercise.movementPattern === pattern &&
      availableEquipment.has(exercise.equipmentType) &&
      !isUnavailable(exercise, input.unavailableExerciseNames),
  );
  // A preference reorders the candidates, stable within each group, so the
  // rotation still spreads volume across the week exactly as before.
  const ordered = [
    ...alternatives.filter((exercise) => isPreferred(exercise, input.preferredExerciseNames)),
    ...alternatives.filter((exercise) => !isPreferred(exercise, input.preferredExerciseNames)),
  ];
  return ordered[rotation % ordered.length];
}

function setsByOccurrence(target: number, count: number): number[] {
  const quotient = Math.floor(target / count);
  const remainder = target % count;
  return Array.from({ length: count }, (_, index) => quotient + Number(index < remainder));
}

function toGeneratedExercise(
  catalog: StrengthCatalogExercise,
  targetSets: number,
): MutablePlannedExercise {
  const compound = catalog.category === ExerciseCategory.COMPOUND;
  return {
    name: catalog.name,
    muscleGroup: catalog.muscleGroup,
    category: catalog.category,
    equipmentType: catalog.equipmentType,
    usesBodyweight: catalog.usesBodyweight,
    targetSets,
    targetRepsMin: compound ? 6 : 10,
    targetRepsMax: compound ? 10 : 15,
    targetRIR: 2,
    restSec: Math.max(catalog.defaultRestSec, compound ? 150 : 75),
    notes: `catalog:${catalog.key}`,
    catalog,
  };
}

export function estimateWorkoutDurationMin(workout: GeneratedWorkout): number {
  const workingSeconds = workout.exercises.reduce(
    (total, exercise) =>
      total + exercise.targetSets * 35 + Math.max(0, exercise.targetSets - 1) * exercise.restSec,
    0,
  );
  const transitionSeconds = Math.max(0, workout.exercises.length - 1) * 90;
  return 8 + Math.ceil((workingSeconds + transitionSeconds) / 60);
}

function generatedView(workout: MutablePlannedWorkout): GeneratedWorkout {
  return {
    name: workout.name,
    dayOfWeek: workout.dayOfWeek,
    exercises: workout.exercises.map(({ catalog: _catalog, ...exercise }) => exercise),
  };
}

function fitWorkout(workout: MutablePlannedWorkout, durationLimit: number): boolean {
  let reduced = false;
  const duration = () => estimateWorkoutDurationMin(generatedView(workout));

  const accessoryIndexes = workout.exercises
    .map((exercise, index) => ({ exercise, index }))
    .filter(({ exercise }) => exercise.catalog.priority > 0)
    .sort(
      (left, right) =>
        right.exercise.catalog.priority - left.exercise.catalog.priority ||
        right.index - left.index,
    );
  for (const { exercise } of accessoryIndexes) {
    if (duration() <= durationLimit) break;
    const currentIndex = workout.exercises.indexOf(exercise);
    if (currentIndex >= 0) {
      workout.exercises.splice(currentIndex, 1);
      reduced = true;
    }
  }

  while (duration() > durationLimit) {
    const reducible = workout.exercises
      .map((exercise, index) => ({ exercise, index }))
      .filter(({ exercise }) => exercise.targetSets > 2)
      .sort(
        (left, right) =>
          Number(left.exercise.category === ExerciseCategory.COMPOUND) -
            Number(right.exercise.category === ExerciseCategory.COMPOUND) ||
          right.exercise.targetSets - left.exercise.targetSets ||
          right.index - left.index,
      )[0];
    if (!reducible) break;
    reducible.exercise.targetSets -= 1;
    reduced = true;
  }

  return reduced;
}

function minimumRequiredDuration(workouts: readonly MutablePlannedWorkout[]): number {
  return Math.max(
    ...workouts.map((workout) => {
      const core = workout.exercises
        .filter((exercise) => exercise.catalog.priority === 0)
        .map((exercise) => ({ ...exercise, targetSets: 2 }));
      return estimateWorkoutDurationMin({
        name: workout.name,
        dayOfWeek: workout.dayOfWeek,
        exercises: core,
      });
    }),
  );
}

function achievedVolume(
  workouts: readonly MutablePlannedWorkout[],
): Partial<Record<MuscleGroup, number>> {
  const achieved: Partial<Record<MuscleGroup, number>> = {};
  for (const pattern of Object.keys(PRIMARY_PATTERN_TO_MUSCLE_GROUP) as PrimaryMovementPattern[]) {
    const muscleGroup = PRIMARY_PATTERN_TO_MUSCLE_GROUP[pattern];
    achieved[muscleGroup] = workouts.reduce(
      (total, workout) =>
        total +
        workout.exercises
          .filter((exercise) => exercise.catalog.movementPattern === pattern)
          .reduce((sets, exercise) => sets + exercise.targetSets, 0),
      0,
    );
  }
  return achieved;
}

export function buildStrengthPlan(input: StrengthPlanInput): StrengthPrescription {
  const normalized = validateInput(input);
  const template = splitByFrequency[normalized.weeklyFrequency];
  const targetSets = weeklyTargetSets(normalized.trainingAgeMonths);
  const occurrenceCounts = new Map<PrimaryMovementPattern, number>();
  for (const name of template.names) {
    const patterns = CORE_WORKOUT_TEMPLATES[name]!;
    for (const pattern of patterns) {
      occurrenceCounts.set(pattern, (occurrenceCounts.get(pattern) ?? 0) + 1);
    }
  }
  const allocations = new Map<PrimaryMovementPattern, number[]>();
  for (const [pattern, count] of occurrenceCounts) {
    allocations.set(pattern, setsByOccurrence(targetSets, count));
  }
  const seenOccurrences = new Map<PrimaryMovementPattern, number>();

  const workouts = template.names.map<MutablePlannedWorkout>((name, index) => {
    const patterns = CORE_WORKOUT_TEMPLATES[name]!;
    const rotation = variationIndex(name);
    const exercises = patterns.map((pattern) => {
      const occurrence = seenOccurrences.get(pattern) ?? 0;
      seenOccurrences.set(pattern, occurrence + 1);
      const allocatedSets = allocations.get(pattern)?.[occurrence];
      if (allocatedSets === undefined) {
        throw new Error(`Missing volume allocation for movement pattern ${pattern}`);
      }
      const selected = selectExercise(pattern, rotation, normalized);
      if (!selected) {
        throw new RangeError(`No available exercise for movement pattern ${pattern}`);
      }
      return toGeneratedExercise(selected, allocatedSets);
    });
    for (const pattern of ACCESSORY_PATTERN_PRIORITY) {
      const selected = selectExercise(pattern, rotation, normalized);
      if (selected) exercises.push(toGeneratedExercise(selected, 2));
    }
    return {
      name,
      dayOfWeek: normalized.availableWeekdays[index]!,
      exercises,
      lowerBodyDemand: patterns.includes('SQUAT') || patterns.includes('HINGE'),
    };
  });

  const minimumDurationMin = minimumRequiredDuration(workouts);
  let durationReduced = false;
  for (const workout of workouts) {
    durationReduced = fitWorkout(workout, normalized.sessionDurationMin) || durationReduced;
  }
  if (
    workouts.some(
      (workout) =>
        estimateWorkoutDurationMin(generatedView(workout)) > normalized.sessionDurationMin,
    )
  ) {
    throw new StrengthPlanConstraintError(minimumDurationMin);
  }

  const days = workouts.map<StrengthPlanDay>((workout) => {
    const generated = generatedWorkoutSchema.parse(generatedView(workout));
    return {
      ...generated,
      estimatedDurationMin: estimateWorkoutDurationMin(generated),
      lowerBodyDemand: workout.lowerBodyDemand,
    };
  });
  const novice = normalized.trainingAgeMonths < 6;
  const reasons: StrengthPlanReason[] = [];
  if (novice) reasons.push('STRENGTH_NOVICE_RIR_BUFFER');
  if (durationReduced) reasons.push('STRENGTH_DURATION_REDUCED');

  return {
    split: template.split,
    weeklyTargetSets: targetSets,
    introRir: novice ? 3 : null,
    introDurationDays: novice ? 14 : 0,
    steadyRir: 2,
    achievedSetsByMuscleGroup: achievedVolume(workouts),
    days,
    reasons,
  };
}
