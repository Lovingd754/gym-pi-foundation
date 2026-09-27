import { describe, expect, it } from 'vitest';

import {
  addDays,
  isoWeekStartDate,
  isoWeekdayInTimeZone,
  localCalendarDate,
  startOfLocalDayUtc,
} from './time-zone';

describe('time zone helpers', () => {
  it('reports the local date and weekday rather than the server clock', () => {
    // 2026-09-20T16:30Z is still Sunday in Shanghai (00:30 on Monday is not).
    const sundayNight = new Date('2026-09-20T16:30:00.000Z');
    expect(localCalendarDate(sundayNight, 'Asia/Shanghai')).toBe('2026-09-21');
    expect(isoWeekdayInTimeZone(sundayNight, 'Asia/Shanghai')).toBe(1);
    expect(localCalendarDate(sundayNight, 'UTC')).toBe('2026-09-20');
    expect(isoWeekdayInTimeZone(sundayNight, 'UTC')).toBe(7);
  });

  it('finds the Monday of the trainee week', () => {
    const wednesday = new Date('2026-09-16T04:00:00.000Z');
    expect(isoWeekStartDate(wednesday, 'Asia/Shanghai')).toBe('2026-09-14');
    const sundayNight = new Date('2026-09-20T16:30:00.000Z');
    expect(isoWeekStartDate(sundayNight, 'Asia/Shanghai')).toBe('2026-09-21');
  });

  it('adds days on the calendar, not on the clock', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('turns a local midnight into the right instant', () => {
    // Shanghai is UTC+8 all year, so local midnight is 16:00Z the day before.
    expect(startOfLocalDayUtc('2026-09-14', 'Asia/Shanghai').toISOString()).toBe(
      '2026-09-13T16:00:00.000Z',
    );
    expect(startOfLocalDayUtc('2026-09-14', 'UTC').toISOString()).toBe(
      '2026-09-14T00:00:00.000Z',
    );
  });
});
