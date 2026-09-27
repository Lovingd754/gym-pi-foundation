import type { AssessmentInput, EligibilityReasonCode } from './schemas';

export type NumericRange = {
  min: number;
  max: number;
};

export const ACTIVITY_FACTORS = {
  SEDENTARY: 1.2,
  LIGHT: 1.375,
  MODERATE: 1.55,
  HIGH: 1.725,
} as const satisfies Record<AssessmentInput['lifestyle']['activityLevel'], number>;

export const GOAL_FACTORS = {
  FAT_LOSS: 0.85,
  HYPERTROPHY: 1.08,
  RECOMP: 1,
} as const satisfies Record<AssessmentInput['goal']['type'], number>;

export const PROTEIN_GRAMS_PER_KG_RANGE = {
  min: 1.4,
  max: 2,
} as const;

export const PROTEIN_GRAMS_PER_KG_BY_GOAL = {
  FAT_LOSS: 1.8,
  HYPERTROPHY: 1.6,
  RECOMP: 1.6,
} as const satisfies Record<AssessmentInput['goal']['type'], number>;

const goalReasons = {
  FAT_LOSS: 'GOAL_FAT_LOSS_DEFICIT',
  HYPERTROPHY: 'GOAL_HYPERTROPHY_SURPLUS',
  RECOMP: 'GOAL_RECOMP_MAINTENANCE',
} as const satisfies Record<AssessmentInput['goal']['type'], EligibilityReasonCode>;

type EnergyEquationReference = AssessmentInput['profile']['energyEquationReference'];
type SpecifiedEnergyEquationReference = Exclude<EnergyEquationReference, 'UNSPECIFIED'>;
type NutritionReasonCode = Extract<
  EligibilityReasonCode,
  | 'ENERGY_REFERENCE_RANGE'
  | 'GOAL_HYPERTROPHY_SURPLUS'
  | 'GOAL_FAT_LOSS_DEFICIT'
  | 'GOAL_RECOMP_MAINTENANCE'
  | 'PROTEIN_GOAL_BASED'
  | 'FAT_MINIMUM_APPLIED'
>;

export type MifflinStJeorInput = {
  weightKg: AssessmentInput['profile']['weightKg'];
  heightCm: AssessmentInput['profile']['heightCm'];
  ageYears: AssessmentInput['profile']['ageYears'];
  reference: SpecifiedEnergyEquationReference;
};

export type NutritionPrescriptionInput = Omit<MifflinStJeorInput, 'reference'> & {
  energyEquationReference: EnergyEquationReference;
  activityLevel: AssessmentInput['lifestyle']['activityLevel'];
  goalType: AssessmentInput['goal']['type'];
  // How fast the trainee wants to change, as a weekly percentage of bodyweight.
  // Absent means the standard pace, which reproduces the fixed factors this
  // module used before the pace became an input.
  desiredWeeklyRatePct?: number;
};

export type NutritionPrescription = {
  bmr: NumericRange;
  tdeeCalories: NumericRange;
  targetCalories: NumericRange;
  proteinGrams: NumericRange;
  fatGrams: NumericRange;
  carbohydrateGrams: NumericRange;
  reasons: NutritionReasonCode[];
};

export class NutritionConstraintError extends Error {
  readonly code = 'NUTRITION_MINIMUM_UNSATISFIABLE' as const;

  constructor() {
    super('NUTRITION_MINIMUM_UNSATISFIABLE');
    this.name = 'NutritionConstraintError';
  }
}

// The standard pace each goal is built around. These are the factors the app
// shipped with, kept as the anchor so a missing rate changes nothing.
const STANDARD_RATE = {
  FAT_LOSS: -0.5,
  HYPERTROPHY: 0.2,
  RECOMP: 0,
} as const satisfies Record<AssessmentInput['goal']['type'], number>;

// Rate -> how far eating sits from maintenance. Linear in the rate (that is the
// only honest relationship) and clamped, so neither a legacy value nor a future
// input can produce a crash diet: the eat-less side never goes past a 20%
// deficit, the eat-more side never past a 12% surplus.
export function goalFactorFor(
  goalType: AssessmentInput['goal']['type'],
  desiredWeeklyRatePct: number = STANDARD_RATE[goalType],
): number {
  if (!Number.isFinite(desiredWeeklyRatePct)) return GOAL_FACTORS[goalType];
  if (goalType === 'FAT_LOSS') {
    return 1 - clamp(Math.abs(desiredWeeklyRatePct) * 0.3, 0.08, 0.2);
  }
  if (goalType === 'HYPERTROPHY') {
    return 1 + clamp(desiredWeeklyRatePct * 0.4, 0.04, 0.12);
  }
  return 1 + clamp(desiredWeeklyRatePct * 0.12, -0.03, 0.03);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be finite`);
  }
}

function assertAnthropometrics(input: Omit<MifflinStJeorInput, 'reference'>): void {
  assertFinite(input.weightKg, 'weightKg');
  assertFinite(input.heightCm, 'heightCm');
  assertFinite(input.ageYears, 'ageYears');
  if (input.weightKg <= 0 || input.heightCm <= 0 || input.ageYears < 0) {
    throw new RangeError('Anthropometric values are outside the supported range');
  }
}

function ascendingRange(values: readonly number[]): NumericRange {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    throw new RangeError('Calculated nutrition range must contain finite values');
  }
  return { min: Math.min(...values), max: Math.max(...values) };
}

function roundTo(value: number, increment: number): number {
  return Math.round(value / increment) * increment;
}

export function calculateMifflinStJeorBmr(input: MifflinStJeorInput): number {
  assertAnthropometrics(input);
  if (input.reference !== 'MALE' && input.reference !== 'FEMALE') {
    throw new RangeError('reference must select a supported energy equation');
  }

  const referenceOffset = input.reference === 'MALE' ? 5 : -161;
  const result = 10 * input.weightKg + 6.25 * input.heightCm - 5 * input.ageYears + referenceOffset;
  if (!Number.isFinite(result) || result <= 0) {
    throw new RangeError('Calculated BMR must be finite and positive');
  }
  return result;
}

export function calculateNutritionPrescription(
  input: NutritionPrescriptionInput,
): NutritionPrescription {
  assertAnthropometrics(input);
  const activityFactor = ACTIVITY_FACTORS[input.activityLevel];
  const goalFactor = goalFactorFor(input.goalType, input.desiredWeeklyRatePct);
  if (activityFactor === undefined || goalFactor === undefined) {
    throw new RangeError('Unsupported activity level or goal type');
  }

  const references: SpecifiedEnergyEquationReference[] =
    input.energyEquationReference === 'UNSPECIFIED'
      ? ['MALE', 'FEMALE']
      : [input.energyEquationReference];
  if (references.some((reference) => reference !== 'MALE' && reference !== 'FEMALE')) {
    throw new RangeError('Unsupported energy equation reference');
  }

  const bmrValues = references.map((reference) =>
    calculateMifflinStJeorBmr({
      weightKg: input.weightKg,
      heightCm: input.heightCm,
      ageYears: input.ageYears,
      reference,
    }),
  );
  const tdeeValues = bmrValues.map((bmr) => bmr * activityFactor);
  const unroundedTargetCalories = tdeeValues.map((tdee) => tdee * goalFactor);
  const proteinFactor = Math.min(
    PROTEIN_GRAMS_PER_KG_RANGE.max,
    Math.max(PROTEIN_GRAMS_PER_KG_RANGE.min, PROTEIN_GRAMS_PER_KG_BY_GOAL[input.goalType]),
  );
  const unroundedProtein = input.weightKg * proteinFactor;
  const minimumFat = input.weightKg * 0.6;
  let fatMinimumApplied = false;

  const macroEndpoints = unroundedTargetCalories.map((targetCalories) => {
    if (!Number.isFinite(targetCalories) || targetCalories <= 0) {
      throw new RangeError('Calculated target calories must be finite and positive');
    }
    const calorieBasedFat = (targetCalories * 0.25) / 9;
    const fat = Math.max(calorieBasedFat, minimumFat);
    fatMinimumApplied ||= minimumFat > calorieBasedFat;
    const carbohydrate = (targetCalories - unroundedProtein * 4 - fat * 9) / 4;
    if (
      !Number.isFinite(unroundedProtein) ||
      !Number.isFinite(fat) ||
      !Number.isFinite(carbohydrate)
    ) {
      throw new RangeError('Calculated macro values must be finite');
    }
    if (carbohydrate < 0) {
      throw new NutritionConstraintError();
    }
    return {
      protein: roundTo(unroundedProtein, 5),
      fat: roundTo(fat, 5),
      carbohydrate: roundTo(carbohydrate, 5),
    };
  });

  const reasons: NutritionReasonCode[] = [];
  if (input.energyEquationReference === 'UNSPECIFIED') reasons.push('ENERGY_REFERENCE_RANGE');
  reasons.push(goalReasons[input.goalType], 'PROTEIN_GOAL_BASED');
  if (fatMinimumApplied) reasons.push('FAT_MINIMUM_APPLIED');

  return {
    bmr: ascendingRange(bmrValues),
    tdeeCalories: ascendingRange(tdeeValues),
    targetCalories: ascendingRange(unroundedTargetCalories.map((value) => roundTo(value, 50))),
    proteinGrams: ascendingRange(macroEndpoints.map((endpoint) => endpoint.protein)),
    fatGrams: ascendingRange(macroEndpoints.map((endpoint) => endpoint.fat)),
    carbohydrateGrams: ascendingRange(macroEndpoints.map((endpoint) => endpoint.carbohydrate)),
    reasons,
  };
}
