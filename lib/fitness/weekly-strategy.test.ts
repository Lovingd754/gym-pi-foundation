import { describe, expect, it } from 'vitest';
import { weeklyActivitiesRequestSchema, weeklyConstraints } from './weekly-activities';
import { parseWeeklyStrategy, requestWeeklyStrategy } from './weekly-strategy';

describe('weekly activity constraints', () => {
  it('rejects excessive entries and unsupported equipment', () => {
    expect(
      weeklyActivitiesRequestSchema.safeParse({
        activities: Array(15).fill({ dayOfWeek: 1, description: 'trip', unavailable: true }),
      }).success,
    ).toBe(false);
    expect(
      weeklyActivitiesRequestSchema.safeParse({
        activities: [
          { dayOfWeek: 1, description: 'trip', unavailable: false, equipmentTypes: ['OTHER'] },
        ],
      }).success,
    ).toBe(false);
  });
  it('blocks unavailable days and intersects equipment restrictions', () => {
    expect(
      weeklyConstraints(
        [1, 3, 5],
        ['BARBELL', 'BODYWEIGHT'],
        [
          { dayOfWeek: 3, description: 'travel', unavailable: true },
          { dayOfWeek: 5, description: 'home', unavailable: false, equipmentTypes: ['BODYWEIGHT'] },
        ],
      ),
    ).toEqual({
      availableWeekdays: [1, 5],
      equipmentTypes: ['BODYWEIGHT'],
      sessionDurationMin: null,
    });
  });
});
describe('weekly strategy', () => {
  const constraints = {
    availableWeekdays: [1, 3, 5],
    equipmentTypes: ['BODYWEIGHT' as const],
    sessionDurationMin: null,
  };
  const valid = {
    weekdays: [1, 3],
    avoid: [],
    prefer: ['push_up'],
    cardio: 'MINIMAL',
    recovery: 'REDUCED',
    rationale: 'Travel calls for a lighter week.',
  };
  it('strictly rejects invented days and equipment', () => {
    expect(() => parseWeeklyStrategy({ ...valid, weekdays: [1, 2] }, constraints)).toThrow();
    expect(() => parseWeeklyStrategy({ ...valid, prefer: ['back_squat'] }, constraints)).toThrow();
    expect(parseWeeklyStrategy(valid, constraints).source).toBe('MODEL');
  });
  it('rejects consecutive full body days and recovery with increased cardio', () => {
    expect(() =>
      parseWeeklyStrategy(
        { ...valid, weekdays: [1, 2] },
        { ...constraints, availableWeekdays: [1, 2, 3] },
      ),
    ).toThrow();
    expect(() => parseWeeklyStrategy({ ...valid, cardio: 'MORE' }, constraints)).toThrow();
  });
  it('surfaces invalid model output instead of silent fallback', async () => {
    await expect(
      requestWeeklyStrategy(
        { userId: 'u', context: {}, constraints },
        { complete: async () => '{"weekdays":[2]}' },
      ),
    ).rejects.toThrow('WEEKLY_MODEL_UNAVAILABLE');
  });
});
