import { describe, expect, it } from 'vitest';
import { closestFood, formatPortion } from './food-equivalents';

describe('closestFood', () => {
  it('names the food that lands nearest the target', () => {
    // 20 g of protein is about three eggs.
    expect(closestFood('protein', 20, 'zh')).toEqual({ amount: 3, name: '鸡蛋', unit: '个' });
    // 50 g of carbohydrate is one bowl of rice.
    expect(closestFood('carbs', 50, 'zh')).toEqual({ amount: 1, name: '米饭', unit: '碗' });
  });

  it('answers in the language it was asked in', () => {
    expect(closestFood('protein', 20, 'en')?.name).toBe('eggs');
    expect(closestFood('carbs', 50, 'en')?.name).toBe('rice');
  });

  it('never returns a fractional egg', () => {
    // 5 g is most of an egg, and "0.8 eggs" is not a sentence anyone writes.
    expect(closestFood('protein', 5, 'zh')?.amount).toBe(1);
  });

  it('moves to a weighed food once the portions stop being sensible', () => {
    // Nine eggs is not a meal; 200 g of chicken is.
    expect(closestFood('protein', 60, 'zh')).toEqual({ amount: 200, name: '鸡胸肉', unit: '克' });
  });

  it('stays on the first food while the portion is reasonable', () => {
    expect(closestFood('carbs', 100, 'zh')).toEqual({ amount: 2, name: '米饭', unit: '碗' });
  });

  it('suggests food for the meal it is given, not just the macro', () => {
    // Chicken and rice is right for lunch and absurd at breakfast.
    expect(closestFood('protein', 30, 'zh', 'BREAKFAST')?.name).not.toBe('鸡胸肉');
    expect(closestFood('carbs', 45, 'zh', 'BREAKFAST')?.name).toBe('燕麦');
    expect(closestFood('fat', 15, 'zh', 'DINNER')?.name).toBe('橄榄油');
    expect(closestFood('protein', 30, 'zh', 'DINNER')?.name).toBe('鸡胸肉');
  });

  it('falls back to the full list rather than leaving a meal blank', () => {
    // Nothing in the fat list is specific to nothing, so every slot resolves.
    for (const meal of ['BREAKFAST', 'LUNCH', 'TRAINING', 'DINNER'] as const) {
      expect(closestFood('fat', 15, 'zh', meal)).not.toBeNull();
    }
  });

  it('returns nothing for an impossible target', () => {
    expect(closestFood('protein', 0, 'zh')).toBeNull();
    expect(closestFood('fat', Number.NaN, 'zh')).toBeNull();
    expect(closestFood('carbs', -10, 'zh')).toBeNull();
  });
});

describe('formatPortion', () => {
  it('reads like a portion in each language', () => {
    expect(formatPortion({ amount: 3, name: '鸡蛋', unit: '个' }, 'zh')).toBe('3个鸡蛋');
    expect(formatPortion({ amount: 3, name: 'eggs', unit: '' }, 'en')).toBe('3 eggs');
    expect(formatPortion({ amount: 1.5, name: 'rice', unit: 'bowl' }, 'en')).toBe('1.5 bowl rice');
  });
});
