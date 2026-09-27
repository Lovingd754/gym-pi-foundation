import { describe, expect, it } from 'vitest';

import { createCardioPrescription } from './cardio-prescription';

describe('createCardioPrescription', () => {
  it('builds exactly two 20-minute sessions below 60 current minutes', () => {
    expect(createCardioPrescription({ currentModerateActivityMin: 59, strengthDays: [] })).toEqual({
      additionalWeeklyMin: 40,
      sessions: [
        {
          dayOfWeek: 1,
          durationMin: 20,
          mode: 'LOW_IMPACT',
          intensity: 'MODERATE',
          rpeMin: 3,
          rpeMax: 5,
        },
        {
          dayOfWeek: 2,
          durationMin: 20,
          mode: 'LOW_IMPACT',
          intensity: 'MODERATE',
          rpeMin: 3,
          rpeMax: 5,
        },
      ],
      reasons: ['CARDIO_BUILD_TO_BASELINE'],
    });
  });

  it('fills from 60 minutes to 150 using three exact sessions', () => {
    const result = createCardioPrescription({
      currentModerateActivityMin: 60,
      strengthDays: [],
    });

    expect(result.additionalWeeklyMin).toBe(90);
    expect(result.sessions.map((session) => session.durationMin)).toEqual([30, 30, 30]);
    expect(result.reasons).toEqual(['CARDIO_FILL_TO_150']);
  });

  it('uses the two-session 20-minute minimum for a tiny remainder', () => {
    const result = createCardioPrescription({
      currentModerateActivityMin: 149,
      strengthDays: [],
    });

    expect(result.additionalWeeklyMin).toBe(20);
    expect(result.sessions.map((session) => session.durationMin)).toEqual([10, 10]);
  });

  it('distributes a rounded remainder deterministically in five-minute increments', () => {
    const result = createCardioPrescription({
      currentModerateActivityMin: 101,
      strengthDays: [],
    });

    expect(result.additionalWeeklyMin).toBe(50);
    expect(result.sessions.map((session) => session.durationMin)).toEqual([20, 15, 15]);
    expect(result.sessions.reduce((sum, session) => sum + session.durationMin, 0)).toBe(50);
    expect(
      result.sessions.every(
        (session) => session.durationMin >= 10 && session.durationMin % 5 === 0,
      ),
    ).toBe(true);
  });

  it('maintains current activity without adding sessions or HIIT at 150 and above', () => {
    expect(
      createCardioPrescription({
        currentModerateActivityMin: 150,
        strengthDays: [{ dayOfWeek: 1, lowerBodyDemand: true }],
      }),
    ).toEqual({
      additionalWeeklyMin: 0,
      sessions: [],
      reasons: ['CARDIO_MAINTAIN_CURRENT'],
    });
  });

  it('chooses non-strength days farthest from lower-body strength work', () => {
    const result = createCardioPrescription({
      currentModerateActivityMin: 20,
      strengthDays: [
        { dayOfWeek: 1, lowerBodyDemand: true },
        { dayOfWeek: 2, lowerBodyDemand: false },
      ],
    });

    expect(result.sessions.map((session) => session.dayOfWeek)).toEqual([4, 5]);
  });

  it('uses all ISO weekdays and combines with non-lower-body strength first when unavoidable', () => {
    const result = createCardioPrescription({
      currentModerateActivityMin: 20,
      strengthDays: [
        { dayOfWeek: 2, lowerBodyDemand: false },
        { dayOfWeek: 3, lowerBodyDemand: true },
        { dayOfWeek: 4, lowerBodyDemand: true },
        { dayOfWeek: 5, lowerBodyDemand: true },
        { dayOfWeek: 6, lowerBodyDemand: true },
        { dayOfWeek: 7, lowerBodyDemand: true },
      ],
    });

    expect(result.sessions.map((session) => session.dayOfWeek)).toEqual([1, 2]);
  });

  it('uses lower-body distance to rank same-demand strength-day fallbacks deterministically', () => {
    const input = {
      currentModerateActivityMin: 20,
      strengthDays: [
        { dayOfWeek: 7, lowerBodyDemand: false },
        { dayOfWeek: 1, lowerBodyDemand: true },
        { dayOfWeek: 6, lowerBodyDemand: false },
        { dayOfWeek: 2, lowerBodyDemand: false },
        { dayOfWeek: 5, lowerBodyDemand: false },
        { dayOfWeek: 3, lowerBodyDemand: false },
        { dayOfWeek: 4, lowerBodyDemand: false },
      ],
    };

    expect(createCardioPrescription(input).sessions.map((session) => session.dayOfWeek)).toEqual([
      4, 5,
    ]);
    expect(createCardioPrescription(input).sessions.map((session) => session.dayOfWeek)).toEqual([
      4, 5,
    ]);
  });

  it('returns stable low-impact moderate RPE fields only', () => {
    const result = createCardioPrescription({
      currentModerateActivityMin: 100,
      strengthDays: [],
    });

    for (const session of result.sessions) {
      expect(session).toMatchObject({
        mode: 'LOW_IMPACT',
        intensity: 'MODERATE',
        rpeMin: 3,
        rpeMax: 5,
      });
      expect(Object.keys(session).sort()).toEqual(
        ['dayOfWeek', 'durationMin', 'intensity', 'mode', 'rpeMax', 'rpeMin'].sort(),
      );
    }
  });

  it.each([
    ['negative activity', { currentModerateActivityMin: -1, strengthDays: [] }],
    ['fractional activity', { currentModerateActivityMin: 20.5, strengthDays: [] }],
    [
      'nonfinite activity',
      { currentModerateActivityMin: Number.POSITIVE_INFINITY, strengthDays: [] },
    ],
    [
      'weekday below range',
      {
        currentModerateActivityMin: 20,
        strengthDays: [{ dayOfWeek: 0, lowerBodyDemand: false }],
      },
    ],
    [
      'weekday above range',
      {
        currentModerateActivityMin: 20,
        strengthDays: [{ dayOfWeek: 8, lowerBodyDemand: false }],
      },
    ],
    [
      'duplicate weekday',
      {
        currentModerateActivityMin: 20,
        strengthDays: [
          { dayOfWeek: 2, lowerBodyDemand: false },
          { dayOfWeek: 2, lowerBodyDemand: true },
        ],
      },
    ],
  ])('rejects %s', (_label, input) => {
    expect(() => createCardioPrescription(input)).toThrow(RangeError);
  });

  it('is deterministic and does not mutate strength days', () => {
    const input = {
      currentModerateActivityMin: 100,
      strengthDays: [
        { dayOfWeek: 3, lowerBodyDemand: true },
        { dayOfWeek: 1, lowerBodyDemand: false },
      ],
    };
    const before = structuredClone(input);

    expect(createCardioPrescription(input)).toEqual(createCardioPrescription(input));
    expect(input).toEqual(before);
  });
});
