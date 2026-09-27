import { describe, expect, it } from 'vitest';

import {
  ACTIVITY_FACTORS,
  GOAL_FACTORS,
  PROTEIN_GRAMS_PER_KG_BY_GOAL,
  PROTEIN_GRAMS_PER_KG_RANGE,
  NutritionConstraintError,
  calculateMifflinStJeorBmr,
  calculateNutritionPrescription,
} from './energy';

const baseInput = {
  weightKg: 70,
  heightCm: 175,
  ageYears: 30,
  energyEquationReference: 'MALE' as const,
  activityLevel: 'MODERATE' as const,
  goalType: 'FAT_LOSS' as const,
};

describe('calculateMifflinStJeorBmr', () => {
  it('returns the exact unrounded male reference value', () => {
    expect(
      calculateMifflinStJeorBmr({
        weightKg: 70,
        heightCm: 175,
        ageYears: 30,
        reference: 'MALE',
      }),
    ).toBe(1648.75);
  });

  it('returns the exact unrounded female reference value', () => {
    expect(
      calculateMifflinStJeorBmr({
        weightKg: 70,
        heightCm: 175,
        ageYears: 30,
        reference: 'FEMALE',
      }),
    ).toBe(1482.75);
  });
});

describe('calculateNutritionPrescription', () => {
  it('uses the exact configured activity factors without rounding TDEE', () => {
    expect(ACTIVITY_FACTORS).toEqual({
      SEDENTARY: 1.2,
      LIGHT: 1.375,
      MODERATE: 1.55,
      HIGH: 1.725,
    });

    expect(
      Object.fromEntries(
        (Object.keys(ACTIVITY_FACTORS) as Array<keyof typeof ACTIVITY_FACTORS>).map(
          (activityLevel) => [
            activityLevel,
            calculateNutritionPrescription({
              ...baseInput,
              activityLevel,
              goalType: 'RECOMP',
            }).tdeeCalories.min,
          ],
        ),
      ),
    ).toEqual({
      SEDENTARY: 1978.5,
      LIGHT: 2267.03125,
      MODERATE: 2555.5625,
      HIGH: 2844.09375,
    });
  });

  it('keeps the exact goal factors and the fat-loss safety invariant', () => {
    expect(GOAL_FACTORS).toEqual({
      FAT_LOSS: 0.85,
      HYPERTROPHY: 1.08,
      RECOMP: 1,
    });
    expect(GOAL_FACTORS.FAT_LOSS).toBe(1 - 0.15);
    expect(Math.min(...Object.values(GOAL_FACTORS))).toBeGreaterThanOrEqual(0.8);
  });

  it('locks the documented protein clamp and current per-goal factors', () => {
    expect(PROTEIN_GRAMS_PER_KG_RANGE).toEqual({ min: 1.4, max: 2 });
    expect(PROTEIN_GRAMS_PER_KG_BY_GOAL).toEqual({
      FAT_LOSS: 1.8,
      HYPERTROPHY: 1.6,
      RECOMP: 1.6,
    });
  });

  it.each([
    ['FAT_LOSS', 1.8, 180],
    ['HYPERTROPHY', 1.6, 160],
    ['RECOMP', 1.6, 160],
  ] as const)(
    'keeps the %s protein factor and output inside the documented clamp',
    (goalType, proteinFactor, expectedProteinGrams) => {
      expect(PROTEIN_GRAMS_PER_KG_BY_GOAL[goalType]).toBe(proteinFactor);
      expect(proteinFactor).toBeGreaterThanOrEqual(PROTEIN_GRAMS_PER_KG_RANGE.min);
      expect(proteinFactor).toBeLessThanOrEqual(PROTEIN_GRAMS_PER_KG_RANGE.max);

      const result = calculateNutritionPrescription({
        ...baseInput,
        weightKg: 100,
        goalType,
      });
      expect(result.proteinGrams).toEqual({
        min: expectedProteinGrams,
        max: expectedProteinGrams,
      });
      expect(result.proteinGrams.min / 100).toBeGreaterThanOrEqual(PROTEIN_GRAMS_PER_KG_RANGE.min);
      expect(result.proteinGrams.max / 100).toBeLessThanOrEqual(PROTEIN_GRAMS_PER_KG_RANGE.max);
    },
  );

  it('computes and sorts both unspecified reference endpoints', () => {
    expect(
      calculateNutritionPrescription({
        ...baseInput,
        energyEquationReference: 'UNSPECIFIED',
        goalType: 'HYPERTROPHY',
      }),
    ).toEqual({
      bmr: { min: 1482.75, max: 1648.75 },
      tdeeCalories: { min: 1482.75 * 1.55, max: 2555.5625 },
      targetCalories: { min: 2500, max: 2750 },
      proteinGrams: { min: 110, max: 110 },
      fatGrams: { min: 70, max: 75 },
      carbohydrateGrams: { min: 355, max: 405 },
      reasons: ['ENERGY_REFERENCE_RANGE', 'GOAL_HYPERTROPHY_SURPLUS', 'PROTEIN_GOAL_BASED'],
    });
  });

  it('rounds calories to 50 and macros to 5 from each unrounded endpoint', () => {
    expect(calculateNutritionPrescription(baseInput)).toEqual({
      bmr: { min: 1648.75, max: 1648.75 },
      tdeeCalories: { min: 2555.5625, max: 2555.5625 },
      targetCalories: { min: 2150, max: 2150 },
      proteinGrams: { min: 125, max: 125 },
      fatGrams: { min: 60, max: 60 },
      carbohydrateGrams: { min: 280, max: 280 },
      reasons: ['GOAL_FAT_LOSS_DEFICIT', 'PROTEIN_GOAL_BASED'],
    });
  });

  it('uses 1.6 g/kg protein for recomp and emits the maintenance reason once', () => {
    const result = calculateNutritionPrescription({
      ...baseInput,
      goalType: 'RECOMP',
    });

    expect(result.proteinGrams).toEqual({ min: 110, max: 110 });
    expect(result.reasons).toEqual(['GOAL_RECOMP_MAINTENANCE', 'PROTEIN_GOAL_BASED']);
  });

  it('applies the 0.6 g/kg fat minimum when it controls an endpoint', () => {
    const result = calculateNutritionPrescription({
      weightKg: 100,
      heightCm: 180,
      ageYears: 60,
      energyEquationReference: 'FEMALE',
      activityLevel: 'SEDENTARY',
      goalType: 'FAT_LOSS',
    });

    expect(result.fatGrams).toEqual({ min: 60, max: 60 });
    expect(result.carbohydrateGrams).toEqual({ min: 110, max: 110 });
    expect(result.reasons).toEqual([
      'GOAL_FAT_LOSS_DEFICIT',
      'PROTEIN_GOAL_BASED',
      'FAT_MINIMUM_APPLIED',
    ]);
  });

  it('throws a stable constraint error instead of reducing minimums or returning negative carbs', () => {
    expect(() =>
      calculateNutritionPrescription({
        weightKg: 35,
        heightCm: 120,
        ageYears: 120,
        energyEquationReference: 'FEMALE',
        activityLevel: 'SEDENTARY',
        goalType: 'FAT_LOSS',
      }),
    ).toThrowError(NutritionConstraintError);

    try {
      calculateNutritionPrescription({
        weightKg: 35,
        heightCm: 120,
        ageYears: 120,
        energyEquationReference: 'FEMALE',
        activityLevel: 'SEDENTARY',
        goalType: 'FAT_LOSS',
      });
      throw new Error('Expected nutrition calculation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(NutritionConstraintError);
      expect((error as NutritionConstraintError).code).toBe('NUTRITION_MINIMUM_UNSATISFIABLE');
    }
  });

  it.each([
    ['weight', { ...baseInput, weightKg: Number.POSITIVE_INFINITY }],
    ['height', { ...baseInput, heightCm: Number.NaN }],
    ['age', { ...baseInput, ageYears: Number.NEGATIVE_INFINITY }],
  ])('rejects nonfinite %s input', (_label, input) => {
    expect(() => calculateNutritionPrescription(input)).toThrow(RangeError);
  });
});
