// ============================================================
// Local calendar arithmetic
// ============================================================
// A plan is written in the trainee's own week (Mon-Sun) and "today's workout"
// is a local-calendar question, but every timestamp in the database is an
// instant. Everything that crosses that line goes through here, so the app
// still agrees with the trainee on a Sunday night in Shanghai and nobody has to
// remember which way a time zone offset points.

// 'YYYY-MM-DD' in the given zone - never the server's clock.
export function localCalendarDate(instant: Date, timeZone: string): string {
  if (Number.isNaN(instant.getTime())) throw new RangeError('instant must be a valid date');
  const parts = formatParts(instant, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// 1 = Monday ... 7 = Sunday, in the given zone.
export function isoWeekdayInTimeZone(instant: Date, timeZone: string): number {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(instant);
  const index = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(weekday);
  return index < 0 ? 1 : index + 1;
}

// The Monday of the week `instant` falls in, as a local 'YYYY-MM-DD'. String
// comparison is then a chronological comparison, which is all a caller needs to
// ask "did the trainee's week change since this plan was activated".
export function isoWeekStartDate(instant: Date, timeZone: string): string {
  const today = localCalendarDate(instant, timeZone);
  const weekday = isoWeekdayInTimeZone(instant, timeZone);
  return addDays(today, -(weekday - 1));
}

// Adds whole days to a 'YYYY-MM-DD'. Calendar days, not 24-hour blocks: the
// arithmetic happens on the date itself, so a DST shift cannot land the result
// on the wrong day.
export function addDays(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(shifted.getTime())) throw new RangeError('date must be YYYY-MM-DD');
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

// The instant a local day starts in the given zone, for querying by timestamp.
export function startOfLocalDayUtc(date: string, timeZone: string): Date {
  const target = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(target)) throw new RangeError('date must be YYYY-MM-DD');
  // The offset depends on the instant, so it is resolved twice: the first
  // estimate can land on the other side of a DST change.
  const firstGuess = target - zoneOffsetMs(new Date(target), timeZone);
  const secondGuess = target - zoneOffsetMs(new Date(firstGuess), timeZone);
  return new Date(secondGuess);
}

function formatParts(instant: Date, timeZone: string): Record<string, string> {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(instant);
  } catch {
    throw new RangeError('timeZone must be a valid IANA time zone');
  }
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  const year = value('year');
  const month = value('month');
  const day = value('day');
  if (!year || !month || !day) throw new RangeError('timeZone must be a valid IANA time zone');
  return { year, month, day };
}

function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  // 'hour' can read 24 for midnight in some zones with hour12: false.
  const hour = value('hour') % 24;
  const asUtc = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    hour,
    value('minute'),
    value('second'),
  );
  return asUtc - instant.getTime();
}
