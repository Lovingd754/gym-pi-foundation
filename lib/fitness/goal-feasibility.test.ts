import { describe, expect, it } from 'vitest';

import { calculateNutritionPrescription } from './energy';
import { evaluateGoalFeasibility } from './goal-feasibility';

describe('evaluateGoalFeasibility', () => {
  it('uses the supported fat-loss pace endpoints and exact calendar dates', () => {
    expect(
      evaluateGoalFeasibility({
        currentWeightKg: 100,
        goalType: 'FAT_LOSS',
        targetWeightKg: 90,
        targetDate: '2026-06-01',
        calculationDate: '2026-01-01',
      }),
    ).toEqual({
      status: 'WITHIN_RANGE',
      earliestDate: '2026-04-09',
      latestDate: '2026-10-08',
      targetDate: '2026-06-01',
      reasons: ['TARGET_DATE_WITHIN_RANGE'],
    });
  });

  it('uses the supported hypertrophy pace endpoints across month and year boundaries', () => {
    expect(
      evaluateGoalFeasibility({
        currentWeightKg: 100,
        goalType: 'HYPERTROPHY',
        targetWeightKg: 101,
        targetDate: '2027-01-15',
        calculationDate: '2026-12-01',
      }),
    ).toEqual({
      status: 'WITHIN_RANGE',
      earliestDate: '2026-12-29',
      latestDate: '2027-02-09',
      targetDate: '2027-01-15',
      reasons: ['TARGET_DATE_WITHIN_RANGE'],
    });
  });

  it('rejects a calculated endpoint that crosses beyond four-digit years', () => {
    expect(() =>
      evaluateGoalFeasibility({
        currentWeightKg: 100,
        goalType: 'HYPERTROPHY',
        targetWeightKg: 101,
        targetDate: '9999-12-31',
        calculationDate: '9999-12-01',
      }),
    ).toThrow(RangeError);
  });

  it('formats a non-overflowing endpoint at the end of year 9999', () => {
    expect(
      evaluateGoalFeasibility({
        currentWeightKg: 200,
        goalType: 'HYPERTROPHY',
        targetWeightKg: 201,
        targetDate: '9999-12-31',
        calculationDate: '9999-11-26',
      }),
    ).toEqual({
      status: 'WITHIN_RANGE',
      earliestDate: '9999-12-10',
      latestDate: '9999-12-31',
      targetDate: '9999-12-31',
      reasons: ['TARGET_DATE_WITHIN_RANGE'],
    });
  });

  it('formats and compares an endpoint on leap day', () => {
    expect(
      evaluateGoalFeasibility({
        currentWeightKg: 200,
        goalType: 'HYPERTROPHY',
        targetWeightKg: 201,
        targetDate: '2024-02-29',
        calculationDate: '2024-02-15',
      }),
    ).toEqual({
      status: 'WITHIN_RANGE',
      earliestDate: '2024-02-29',
      latestDate: '2024-03-21',
      targetDate: '2024-02-29',
      reasons: ['TARGET_DATE_WITHIN_RANGE'],
    });
  });

  it.each([
    ['2026-04-08', 'EARLIER_THAN_SUPPORTED', 'TARGET_DATE_EARLIER_THAN_SUPPORTED'],
    ['2026-04-09', 'WITHIN_RANGE', 'TARGET_DATE_WITHIN_RANGE'],
    ['2026-10-08', 'WITHIN_RANGE', 'TARGET_DATE_WITHIN_RANGE'],
    ['2026-10-09', 'LATER_THAN_ESTIMATE', 'TARGET_DATE_LATER_THAN_ESTIMATE'],
  ] as const)('classifies target date %s as %s', (targetDate, status, reason) => {
    const result = evaluateGoalFeasibility({
      currentWeightKg: 100,
      goalType: 'FAT_LOSS',
      targetWeightKg: 90,
      targetDate,
      calculationDate: '2026-01-01',
    });

    expect(result.status).toBe(status);
    expect(result.reasons).toEqual([reason]);
  });

  it('does not request feasibility when the target pair is omitted', () => {
    expect(
      evaluateGoalFeasibility({
        currentWeightKg: 100,
        goalType: 'FAT_LOSS',
        calculationDate: '2026-01-01',
      }),
    ).toEqual({
      status: 'NOT_REQUESTED',
      earliestDate: null,
      latestDate: null,
      targetDate: null,
      reasons: [],
    });
  });

  it('treats an optional recomp date as a milestone without an estimated range', () => {
    expect(
      evaluateGoalFeasibility({
        currentWeightKg: 80,
        goalType: 'RECOMP',
        targetDate: '2026-05-01',
        calculationDate: '2026-01-01',
      }),
    ).toEqual({
      status: 'MILESTONE',
      earliestDate: null,
      latestDate: null,
      targetDate: '2026-05-01',
      reasons: ['TARGET_DATE_MILESTONE'],
    });
  });

  it('does not request a recomp milestone when its date is omitted', () => {
    expect(
      evaluateGoalFeasibility({
        currentWeightKg: 80,
        goalType: 'RECOMP',
        calculationDate: '2026-01-01',
      }).status,
    ).toBe('NOT_REQUESTED');
  });

  it('keeps calorie targets independent of target-date classification', () => {
    const nutrition = calculateNutritionPrescription({
      weightKg: 100,
      heightCm: 180,
      ageYears: 30,
      energyEquationReference: 'MALE',
      activityLevel: 'MODERATE',
      goalType: 'FAT_LOSS',
    });
    const early = evaluateGoalFeasibility({
      currentWeightKg: 100,
      goalType: 'FAT_LOSS',
      targetWeightKg: 90,
      targetDate: '2026-04-08',
      calculationDate: '2026-01-01',
    });
    const late = evaluateGoalFeasibility({
      currentWeightKg: 100,
      goalType: 'FAT_LOSS',
      targetWeightKg: 90,
      targetDate: '2026-10-09',
      calculationDate: '2026-01-01',
    });

    expect(early.status).not.toBe(late.status);
    expect(nutrition.targetCalories).toEqual({ min: 2600, max: 2600 });
  });

  it.each(['2026-02-29', '2026-2-01', 'not-a-date'])('rejects calculation date %s', (date) => {
    expect(() =>
      evaluateGoalFeasibility({
        currentWeightKg: 100,
        goalType: 'FAT_LOSS',
        calculationDate: date,
      }),
    ).toThrow(RangeError);
  });

  it('rejects nonfinite current weight and incomplete target pairs', () => {
    expect(() =>
      evaluateGoalFeasibility({
        currentWeightKg: Number.NaN,
        goalType: 'FAT_LOSS',
        calculationDate: '2026-01-01',
      }),
    ).toThrow(RangeError);
    expect(() =>
      evaluateGoalFeasibility({
        currentWeightKg: 100,
        goalType: 'HYPERTROPHY',
        targetWeightKg: 105,
        calculationDate: '2026-01-01',
      }),
    ).toThrow(RangeError);
  });
});
