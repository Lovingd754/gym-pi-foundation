import type { Lang } from './food-names';
import type { MealKey } from './meal-plan';

// ============================================================
// Grams, in food the trainee already eats
// ============================================================
// "Protein 30g" is a number nobody can picture at breakfast. "Four eggs" is the
// same fact in a form that can be acted on.
//
// The list for each macronutrient is in the order a coach would reach for it,
// and the first food whose portion lands in a sensible range wins. That is
// deliberate: picking purely by arithmetic closeness suggests "two and a half
// glasses of milk" for a protein target, which is accurate and useless.
//
// Portions are ordinary round amounts, not database values, and the copy says
// "约"/"about". The daily total stays the target; this is only how it looks on a
// plate.

export type Macro = 'protein' | 'carbs' | 'fat';

type Rounding =
  // Whole items only: nobody eats 2.4 eggs.
  | 'whole'
  // Halves are natural for a bowl or a spoonful.
  | 'half'
  // The amount is the weight of the food, so it is stated in grams.
  | 'grams';

interface Food {
  name: Record<Lang, string>;
  unit: Record<Lang, string>;
  // Grams of the macronutrient in one unit (or in 100 g for `grams` foods).
  perUnit: number;
  rounding: Rounding;
  // Which meals this food belongs in. Chicken and rice at breakfast is
  // technically correct and nobody would eat it, so the suggestion is filtered
  // by when a person actually eats the thing.
  slots: MealKey[];
}

// In preference order. `grams` foods are expressed as "150g chicken breast"
// rather than a count of servings, because that is how people buy and cook them.
const PROTEIN: Food[] = [
  { name: { zh: '鸡蛋', en: 'eggs' }, unit: { zh: '个', en: '' }, perUnit: 6, rounding: 'whole', slots: ['BREAKFAST', 'LUNCH', 'DINNER'] },
  { name: { zh: '鸡胸肉', en: 'chicken breast' }, unit: { zh: '克', en: 'g' }, perUnit: 30, rounding: 'grams', slots: ['LUNCH', 'DINNER'] },
  { name: { zh: '无糖酸奶', en: 'plain yoghurt' }, unit: { zh: '盒', en: 'pot' }, perUnit: 15, rounding: 'whole', slots: ['BREAKFAST', 'TRAINING'] },
  { name: { zh: '牛奶', en: 'milk' }, unit: { zh: '杯', en: 'glass' }, perUnit: 8, rounding: 'half', slots: ['BREAKFAST', 'TRAINING'] },
  { name: { zh: '豆腐', en: 'tofu' }, unit: { zh: '克', en: 'g' }, perUnit: 8, rounding: 'grams', slots: ['LUNCH', 'DINNER'] },
];

const CARBS: Food[] = [
  { name: { zh: '米饭', en: 'rice' }, unit: { zh: '碗', en: 'bowl' }, perUnit: 50, rounding: 'half', slots: ['LUNCH', 'DINNER'] },
  { name: { zh: '燕麦', en: 'oats' }, unit: { zh: '克', en: 'g' }, perUnit: 27, rounding: 'grams', slots: ['BREAKFAST'] },
  { name: { zh: '面包', en: 'bread' }, unit: { zh: '片', en: 'slice' }, perUnit: 15, rounding: 'whole', slots: ['BREAKFAST', 'TRAINING'] },
  { name: { zh: '红薯', en: 'sweet potato' }, unit: { zh: '克', en: 'g' }, perUnit: 20, rounding: 'grams', slots: ['LUNCH', 'DINNER'] },
  { name: { zh: '香蕉', en: 'bananas' }, unit: { zh: '根', en: '' }, perUnit: 23, rounding: 'whole', slots: ['BREAKFAST', 'TRAINING'] },
];

const FAT: Food[] = [
  { name: { zh: '坚果', en: 'nuts' }, unit: { zh: '小把', en: 'small handful' }, perUnit: 12, rounding: 'half', slots: ['BREAKFAST', 'TRAINING'] },
  { name: { zh: '橄榄油', en: 'olive oil' }, unit: { zh: '勺', en: 'tbsp' }, perUnit: 10, rounding: 'half', slots: ['LUNCH', 'DINNER'] },
  { name: { zh: '花生酱', en: 'peanut butter' }, unit: { zh: '勺', en: 'tbsp' }, perUnit: 8, rounding: 'half', slots: ['BREAKFAST', 'TRAINING'] },
  { name: { zh: '牛油果', en: 'avocado' }, unit: { zh: '个', en: '' }, perUnit: 15, rounding: 'half', slots: ['LUNCH', 'DINNER'] },
];

const BY_MACRO: Record<Macro, Food[]> = { protein: PROTEIN, carbs: CARBS, fat: FAT };

// A portion outside this range stops being a suggestion: nobody wants "nine
// eggs" or "a quarter of an egg" from their meal card.
const MIN_PORTIONS = 0.5;
const MAX_PORTIONS = 4;
const MAX_FOOD_GRAMS = 300;

export interface FoodPortion {
  // A count for countable food, grams of food for weighed food.
  amount: number;
  name: string;
  unit: string;
}

export function closestFood(
  macro: Macro,
  grams: number,
  lang: Lang,
  meal?: MealKey,
): FoodPortion | null {
  if (!Number.isFinite(grams) || grams <= 0) return null;

  const all = BY_MACRO[macro];
  const forMeal = meal ? all.filter((food) => food.slots.includes(meal)) : all;
  // A macro with nothing suitable for this slot falls back to the full list
  // rather than dropping the line: a slightly odd suggestion beats a blank.
  const foods = forMeal.length > 0 ? forMeal : all;
  for (const food of foods) {
    const amount = portionFor(food, grams);
    if (amount === null) continue;
    return { amount, name: food.name[lang], unit: food.unit[lang] };
  }

  // Nothing landed in range: the last food says the closest true thing, even
  // when the amount is large.
  const fallback = foods[foods.length - 1];
  if (!fallback) return null;
  const amount = portionFor(fallback, grams, { ignoreRange: true });
  if (amount === null) return null;
  return { amount, name: fallback.name[lang], unit: fallback.unit[lang] };
}

function portionFor(
  food: Food,
  grams: number,
  options: { ignoreRange?: boolean } = {},
): number | null {
  if (food.rounding === 'grams') {
    // perUnit is the macro per 100 g, so the food weight scales accordingly.
    const foodGrams = Math.round((grams / food.perUnit) * 100 / 25) * 25;
    if (foodGrams < 25) return null;
    if (!options.ignoreRange && foodGrams > MAX_FOOD_GRAMS) return null;
    return foodGrams;
  }

  const raw = grams / food.perUnit;
  const amount = food.rounding === 'whole' ? Math.round(raw) : Math.round(raw * 2) / 2;
  if (amount <= 0) return null;
  if (!options.ignoreRange && (amount < MIN_PORTIONS || amount > MAX_PORTIONS)) return null;
  return amount;
}

export function formatPortion(portion: FoodPortion, lang: Lang): string {
  const amount = Number.isInteger(portion.amount)
    ? String(portion.amount)
    : portion.amount.toFixed(1);
  if (lang === 'zh') return `${amount}${portion.unit}${portion.name}`;
  const unit = portion.unit === '' ? '' : ` ${portion.unit}`;
  return `${amount}${unit} ${portion.name}`;
}
