import { describe, expect, it } from 'vitest';
import { buildMealPlan, mealKeys } from './meal-plan';

const daily = {
  caloriesKcal: { min: 2000, max: 2200 },
  proteinG: { min: 120, max: 135 },
  carbsG: { min: 200, max: 220 },
  fatG: { min: 55, max: 65 },
};

describe('buildMealPlan', () => {
  it('covers the day exactly once, in a fixed order', () => {
    const meals = buildMealPlan(daily);

    expect(meals.map((meal) => meal.key)).toEqual([...mealKeys]);
    expect(meals).toHaveLength(4);
  });

  it('adds back up to the daily total for every macro', () => {
    const meals = buildMealPlan(daily);
    const sum = (pick: (meal: ReturnType<typeof buildMealPlan>[number]) => { min: number; max: number }) =>
      meals.reduce(
        (total, meal) => {
          const range = pick(meal);
          return { min: total.min + range.min, max: total.max + range.max };
        },
        { min: 0, max: 0 },
      );

    // Rounding happens per meal, so the four meals land within one rounding step
    // of the day rather than on it exactly. A third of the daily target would
    // not be rounding.
    type Meal = ReturnType<typeof buildMealPlan>[number];
    for (const [label, pick, target, tolerance] of [
      ['calories', (meal: Meal) => meal.caloriesKcal, daily.caloriesKcal, 40],
      ['protein', (meal: Meal) => meal.proteinG, daily.proteinG, 4],
      ['carbs', (meal: Meal) => meal.carbsG, daily.carbsG, 4],
      ['fat', (meal: Meal) => meal.fatG, daily.fatG, 4],
    ] as const) {
      const total = sum(pick);
      expect(Math.abs(total.min - target.min), `${label} min`).toBeLessThanOrEqual(tolerance);
      expect(Math.abs(total.max - target.max), `${label} max`).toBeLessThanOrEqual(tolerance);
    }
  });

  it('keeps every meal inside the day and never inverts a range', () => {
    for (const meal of buildMealPlan(daily)) {
      for (const range of [meal.caloriesKcal, meal.proteinG, meal.carbsG, meal.fatG]) {
        expect(range.min).toBeLessThanOrEqual(range.max);
        expect(range.min).toBeGreaterThan(0);
      }
      expect(meal.caloriesKcal.min).toBeLessThanOrEqual(daily.caloriesKcal.max);
      expect(meal.proteinG.max).toBeLessThanOrEqual(daily.proteinG.max);
    }
  });

  it('gives protein a flatter spread than carbohydrate', () => {
    const meals = buildMealPlan(daily);
    const spread = (values: number[]) => Math.max(...values) / Math.min(...values);
    const protein = meals.map((meal) => meal.proteinG.min);
    const carbs = meals.map((meal) => meal.carbsG.min);

    expect(spread(protein)).toBeLessThan(spread(carbs));
  });

  it('survives a collapsed daily range', () => {
    const meals = buildMealPlan({
      caloriesKcal: { min: 1800, max: 1800 },
      proteinG: { min: 120, max: 120 },
      carbsG: { min: 180, max: 180 },
      fatG: { min: 50, max: 50 },
    });

    expect(meals).toHaveLength(4);
    expect(meals.every((meal) => meal.caloriesKcal.min === meal.caloriesKcal.max)).toBe(true);
  });
});
