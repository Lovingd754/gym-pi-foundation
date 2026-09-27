import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PACE,
  PACE_ORDER,
  PACE_RATES,
  describeEnergy,
  foodEquivalent,
  monthlyChangeKg,
  paceToRate,
  rateToPace,
} from './pace';

describe('pace choices', () => {
  it('uses the ends and the middle of the range each goal already allows', () => {
    expect(PACE_RATES.FAT_LOSS).toEqual({ GENTLE: -0.25, STANDARD: -0.5, FAST: -0.75 });
    expect(PACE_RATES.HYPERTROPHY).toEqual({ GENTLE: 0.1, STANDARD: 0.2, FAST: 0.25 });
    expect(PACE_RATES.RECOMP).toEqual({ GENTLE: -0.25, STANDARD: 0, FAST: 0.25 });
  });

  it('round-trips every choice', () => {
    for (const goalType of ['FAT_LOSS', 'HYPERTROPHY', 'RECOMP'] as const) {
      for (const pace of PACE_ORDER) {
        expect(rateToPace(goalType, paceToRate(goalType, pace))).toBe(pace);
      }
    }
  });

  it('snaps an older value to the closest choice instead of leaving nothing selected', () => {
    // -0.4 was the old fat-loss default and is not one of the three options.
    expect(rateToPace('FAT_LOSS', -0.4)).toBe('STANDARD');
    expect(rateToPace('FAT_LOSS', -0.7)).toBe('FAST');
    expect(rateToPace('FAT_LOSS', -0.25)).toBe('GENTLE');
  });

  it('defaults to the normal pace', () => {
    expect(DEFAULT_PACE).toBe('STANDARD');
  });
});

describe('monthlyChangeKg', () => {
  it('turns a weekly percentage into kilograms per month', () => {
    // 0.5% of 82 kg per week, over 4.345 weeks.
    expect(monthlyChangeKg(-0.5, 82)).toBeCloseTo(1.78, 2);
    expect(monthlyChangeKg(0.2, 60)).toBeCloseTo(0.52, 2);
  });

  it('is zero for a rate of zero', () => {
    expect(monthlyChangeKg(0, 82)).toBe(0);
  });
});

describe('describeEnergy', () => {
  const base = {
    goalType: 'FAT_LOSS' as const,
    ratePct: -0.5,
    weightKg: 82,
    maintenanceKcal: 2400,
    targetKcal: 2040,
  };

  it('reads a real deficit as losing weight', () => {
    const summary = describeEnergy(base);

    expect(summary.direction).toBe('LOSE');
    expect(summary.deficitKcal).toBe(360);
    expect(summary.monthlyChangeKg).toBeCloseTo(1.8, 1);
  });

  it('reads a surplus as gaining, and small differences as maintenance', () => {
    expect(describeEnergy({ ...base, targetKcal: 2600 }).direction).toBe('GAIN');
    expect(describeEnergy({ ...base, targetKcal: 2380 }).direction).toBe('MAINTAIN');
    expect(describeEnergy({ ...base, targetKcal: 2380 }).deficitKcal).toBe(20);
  });
});

describe('foodEquivalent', () => {
  it('rounds to halves so the sentence stays honest about being approximate', () => {
    expect(foodEquivalent(360).riceBowls).toBe(1.5);
    expect(foodEquivalent(200).riceBowls).toBe(1);
    expect(foodEquivalent(100).riceBowls).toBe(0.5);
  });

  it('never reports zero food for a real difference', () => {
    expect(foodEquivalent(10).riceBowls).toBeGreaterThan(0);
    expect(foodEquivalent(-400).riceBowls).toBe(foodEquivalent(400).riceBowls);
  });
});
