import { describe, expect, it } from 'vitest';
import { GOAL_FACTORS, calculateNutritionPrescription, goalFactorFor } from './energy';

describe('goalFactorFor', () => {
  it('reproduces the shipped factors at the normal pace', () => {
    for (const goalType of ['FAT_LOSS', 'HYPERTROPHY', 'RECOMP'] as const) {
      const standardRate = { FAT_LOSS: -0.5, HYPERTROPHY: 0.2, RECOMP: 0 }[goalType];
      expect(goalFactorFor(goalType, standardRate)).toBeCloseTo(GOAL_FACTORS[goalType], 10);
    }
  });

  it('uses the standard factor when no rate is supplied at all', () => {
    expect(goalFactorFor('FAT_LOSS')).toBe(GOAL_FACTORS.FAT_LOSS);
    expect(goalFactorFor('HYPERTROPHY')).toBe(GOAL_FACTORS.HYPERTROPHY);
    expect(goalFactorFor('RECOMP')).toBe(GOAL_FACTORS.RECOMP);
  });

  it('moves the target in the direction the pace asks for', () => {
    expect(goalFactorFor('FAT_LOSS', -0.25)).toBeGreaterThan(goalFactorFor('FAT_LOSS', -0.5));
    expect(goalFactorFor('FAT_LOSS', -0.75)).toBeLessThan(goalFactorFor('FAT_LOSS', -0.5));
    expect(goalFactorFor('HYPERTROPHY', 0.1)).toBeLessThan(goalFactorFor('HYPERTROPHY', 0.25));
  });

  it('never lets an extreme or broken rate become a crash diet', () => {
    // The eat-less side stays at or above 80% of maintenance...
    expect(goalFactorFor('FAT_LOSS', -5)).toBeGreaterThanOrEqual(0.8);
    // ...and the eat-more side never goes past a 12% surplus.
    expect(goalFactorFor('HYPERTROPHY', 5)).toBeLessThanOrEqual(1.12);
    // A rate in the wrong direction cannot invert the goal.
    expect(goalFactorFor('FAT_LOSS', 0.75)).toBeGreaterThanOrEqual(0.8);
    expect(goalFactorFor('HYPERTROPHY', -0.5)).toBeGreaterThan(1);
    // Garbage falls back to the shipped factor rather than NaN.
    expect(goalFactorFor('FAT_LOSS', Number.NaN)).toBe(GOAL_FACTORS.FAT_LOSS);
  });

  it('changes the calories the trainee actually gets', () => {
    const base = {
      weightKg: 82,
      heightCm: 170,
      ageYears: 30,
      energyEquationReference: 'FEMALE' as const,
      activityLevel: 'MODERATE' as const,
      goalType: 'FAT_LOSS' as const,
    };

    const gentle = calculateNutritionPrescription({ ...base, desiredWeeklyRatePct: -0.25 });
    const standard = calculateNutritionPrescription({ ...base, desiredWeeklyRatePct: -0.5 });
    const fast = calculateNutritionPrescription({ ...base, desiredWeeklyRatePct: -0.75 });

    expect(gentle.targetCalories.min).toBeGreaterThan(standard.targetCalories.min);
    expect(fast.targetCalories.min).toBeLessThan(standard.targetCalories.min);
  });

  it('refuses rather than inventing a plan whose macro minimums cannot fit', () => {
    // This is precisely why the deficit is clamped: even at the aggressive
    // pace, a very heavy trainee on a very low maintenance estimate can reach a
    // target that cannot hold the protein and fat floors. The engine refuses,
    // the API turns that into a 422, and the trainee is told to pick a gentler
    // pace instead of being handed a plan with negative carbohydrate.
    expect(() =>
      calculateNutritionPrescription({
        weightKg: 300,
        heightCm: 150,
        ageYears: 60,
        energyEquationReference: 'FEMALE',
        activityLevel: 'SEDENTARY',
        goalType: 'FAT_LOSS',
        desiredWeeklyRatePct: -0.75,
      }),
    ).toThrow(/NUTRITION_MINIMUM_UNSATISFIABLE/);
  });
});
