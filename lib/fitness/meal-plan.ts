import type { NumericRange } from './energy';

// ============================================================
// The daily total, spread across the day
// ============================================================
// The daily total is the contract: hit it and the day went well. The split
// below is the default shape of that day, not a second target to obey - which
// is why the copy that goes with it says outright that a missed breakfast can
// be made up later.
//
// The proportions are deliberately simple and identical for everyone. Inventing
// per-person meal timing from a five-question assessment would look precise and
// mean nothing; what a trainee actually needs is "here is roughly how the day
// divides, and the daily total is what matters".

export const mealKeys = ['BREAKFAST', 'LUNCH', 'TRAINING', 'DINNER'] as const;
export type MealKey = (typeof mealKeys)[number];

export interface MealSplit {
  key: MealKey;
  caloriesKcal: NumericRange;
  proteinG: NumericRange;
  carbsG: NumericRange;
  fatG: NumericRange;
}

// Percentages, by meal. Protein is spread almost evenly because it is the one
// macro where an even spread is the point; carbohydrate is weighted towards the
// meal around training. Both are mild preferences, not prescriptions.
const SHARES: Record<MealKey, { calories: number; protein: number; carbs: number; fat: number }> = {
  BREAKFAST: { calories: 0.25, protein: 0.25, carbs: 0.2, fat: 0.3 },
  LUNCH: { calories: 0.3, protein: 0.28, carbs: 0.3, fat: 0.3 },
  TRAINING: { calories: 0.15, protein: 0.22, carbs: 0.25, fat: 0.1 },
  DINNER: { calories: 0.3, protein: 0.25, carbs: 0.25, fat: 0.3 },
};

export interface MealPlanInput {
  caloriesKcal: NumericRange;
  proteinG: NumericRange;
  carbsG: NumericRange;
  fatG: NumericRange;
}

export function buildMealPlan(daily: MealPlanInput): MealSplit[] {
  return mealKeys.map((key) => ({
    key,
    caloriesKcal: shareRange(daily.caloriesKcal, SHARES[key].calories, 10),
    // Grams to the nearest gram and calories to the nearest ten: coarse enough
    // to read, fine enough that the four meals still add back up to the day.
    proteinG: shareRange(daily.proteinG, SHARES[key].protein, 1),
    carbsG: shareRange(daily.carbsG, SHARES[key].carbs, 1),
    fatG: shareRange(daily.fatG, SHARES[key].fat, 1),
  }));
}

// Each end of the daily range is scaled independently, so the per-meal ranges
// still bracket the meal's own target rather than collapsing to a point.
function shareRange(range: NumericRange, share: number, roundTo: number): NumericRange {
  return {
    min: roundToValue(range.min * share, roundTo),
    max: roundToValue(range.max * share, roundTo),
  };
}

function roundToValue(value: number, increment: number): number {
  return Math.max(increment, Math.round(value / increment) * increment);
}

// The convenience fallback for each slot: what to do when there is no time to
// cook. Static per slot on purpose - a suggestion that fits a shop is worth more
// than one tailored to a person's macros.
export const CONVENIENCE_OPTIONS: Record<MealKey, { zh: string; en: string }> = {
  BREAKFAST: {
    zh: '便利店买两个茶叶蛋 ＋ 一盒无糖豆浆 ＋ 一个饭团',
    en: 'grab two boiled eggs, an unsweetened soy milk and a rice ball at a shop',
  },
  LUNCH: {
    zh: '外卖或便利店点一份鸡胸沙拉 ＋ 一份主食；盖饭就多加一份肉',
    en: 'order a chicken salad plus a starch; add extra meat to a rice bowl',
  },
  TRAINING: {
    zh: '一杯牛奶或乳清 ＋ 一根香蕉；忙起来就一杯酸奶加面包',
    en: 'milk or a shake plus a banana; yoghurt and bread also works',
  },
  DINNER: {
    zh: '外卖点麻辣烫或自选快餐，多夹青菜和豆腐，主食要半份',
    en: 'order a build-your-own bowl, load vegetables and tofu, take half the rice',
  },
};
