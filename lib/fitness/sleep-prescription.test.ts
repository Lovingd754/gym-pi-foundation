import { describe, expect, it } from 'vitest';

import { createSleepPrescription } from './sleep-prescription';

describe('createSleepPrescription', () => {
  it.each([
    [419, 420, 'SLEEP_ADD_30_MINUTES'],
    [420, 420, 'SLEEP_GENERAL_RANGE'],
    [540, 540, 'SLEEP_GENERAL_RANGE'],
    [541, 540, 'SLEEP_LONG_DURATION_CAP'],
  ] as const)('handles the %i-minute boundary', (habitualSleepMin, target, reason) => {
    expect(createSleepPrescription({ habitualSleepMin, wakeTimeMin: 420 })).toMatchObject({
      longTermMin: 420,
      longTermMax: 540,
      initialTargetMin: target,
      initialTargetMax: target,
      wakeTimeMin: 420,
      reasons: [reason],
    });
  });

  it('adds 30 minutes below the range and rounds the target to nearest 15', () => {
    expect(createSleepPrescription({ habitualSleepMin: 376, wakeTimeMin: 420 })).toMatchObject({
      initialTargetMin: 405,
      initialTargetMax: 405,
      reasons: ['SLEEP_ADD_30_MINUTES'],
    });
  });

  it('caps a below-range increase at 420 minutes', () => {
    expect(createSleepPrescription({ habitualSleepMin: 400, wakeTimeMin: 420 })).toMatchObject({
      initialTargetMin: 420,
      initialTargetMax: 420,
    });
  });

  it('subtracts sleep and a separate 30-minute onset opportunity with midnight wrap', () => {
    expect(createSleepPrescription({ habitualSleepMin: 420, wakeTimeMin: 360 })).toEqual({
      longTermMin: 420,
      longTermMax: 540,
      initialTargetMin: 420,
      initialTargetMax: 420,
      suggestedBedtimeMin: 1350,
      wakeTimeMin: 360,
      reasons: ['SLEEP_GENERAL_RANGE'],
    });
  });

  it('rounds an unaligned suggested bedtime to nearest 15 minutes', () => {
    expect(
      createSleepPrescription({ habitualSleepMin: 420, wakeTimeMin: 367 }).suggestedBedtimeMin,
    ).toBe(1350);
  });

  it('rounds the fixed wake time before returning the prescription', () => {
    expect(createSleepPrescription({ habitualSleepMin: 420, wakeTimeMin: 421 })).toMatchObject({
      wakeTimeMin: 420,
      suggestedBedtimeMin: 1410,
    });
  });

  it('normalizes a wake time that rounds across the midnight boundary', () => {
    expect(createSleepPrescription({ habitualSleepMin: 420, wakeTimeMin: 1439 })).toMatchObject({
      wakeTimeMin: 0,
      suggestedBedtimeMin: 990,
    });
  });

  it.each([
    ['sleep below schema', { habitualSleepMin: 179, wakeTimeMin: 420 }],
    ['sleep above schema', { habitualSleepMin: 901, wakeTimeMin: 420 }],
    ['fractional sleep', { habitualSleepMin: 420.5, wakeTimeMin: 420 }],
    ['wake below schema', { habitualSleepMin: 420, wakeTimeMin: -1 }],
    ['wake above schema', { habitualSleepMin: 420, wakeTimeMin: 1440 }],
    ['fractional wake', { habitualSleepMin: 420, wakeTimeMin: 420.5 }],
    ['nonfinite sleep', { habitualSleepMin: Number.NaN, wakeTimeMin: 420 }],
  ])('rejects %s', (_label, input) => {
    expect(() => createSleepPrescription(input)).toThrow(RangeError);
  });

  it('returns identical output on repeated calls', () => {
    const input = { habitualSleepMin: 500, wakeTimeMin: 421 };

    expect(createSleepPrescription(input)).toEqual(createSleepPrescription(input));
  });
});
