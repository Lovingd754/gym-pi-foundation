import type { AssessmentInput, EligibilityReasonCode } from './schemas';

export type StrengthDay = {
  dayOfWeek: number;
  lowerBodyDemand: boolean;
};

export type CardioPrescriptionInput = {
  currentModerateActivityMin: AssessmentInput['lifestyle']['currentModerateActivityMin'];
  strengthDays: readonly StrengthDay[];
  // The strategy's stance, bounded by the same guidelines the default follows:
  // MINIMAL still keeps a floor once cardio is prescribed at all, MORE never
  // pushes past the 150 min/week public-health baseline.
  preference?: 'MINIMAL' | 'STANDARD' | 'MORE';
};

export type CardioSession = {
  dayOfWeek: number;
  durationMin: number;
  mode: 'LOW_IMPACT';
  intensity: 'MODERATE';
  rpeMin: 3;
  rpeMax: 5;
};

export type CardioReasonCode = Extract<
  EligibilityReasonCode,
  'CARDIO_BUILD_TO_BASELINE' | 'CARDIO_FILL_TO_150' | 'CARDIO_MAINTAIN_CURRENT'
>;

export type CardioPrescription = {
  additionalWeeklyMin: number;
  sessions: CardioSession[];
  reasons: CardioReasonCode[];
};

const isoWeekdays = [1, 2, 3, 4, 5, 6, 7] as const;

function validateInput(input: CardioPrescriptionInput): void {
  if (
    !Number.isFinite(input.currentModerateActivityMin) ||
    !Number.isInteger(input.currentModerateActivityMin) ||
    input.currentModerateActivityMin < 0
  ) {
    throw new RangeError('currentModerateActivityMin must be a nonnegative finite integer');
  }

  const seenDays = new Set<number>();
  for (const strengthDay of input.strengthDays) {
    if (
      !Number.isInteger(strengthDay.dayOfWeek) ||
      strengthDay.dayOfWeek < 1 ||
      strengthDay.dayOfWeek > 7
    ) {
      throw new RangeError('Strength weekdays must be integers from 1 through 7');
    }
    if (typeof strengthDay.lowerBodyDemand !== 'boolean') {
      throw new RangeError('lowerBodyDemand must be boolean');
    }
    if (seenDays.has(strengthDay.dayOfWeek)) {
      throw new RangeError('Strength weekdays must be unique');
    }
    seenDays.add(strengthDay.dayOfWeek);
  }
}

function cyclicDistance(left: number, right: number): number {
  const direct = Math.abs(left - right);
  return Math.min(direct, 7 - direct);
}

function chooseSessionDays(strengthDays: readonly StrengthDay[], count: number): number[] {
  const strengthByDay = new Map(strengthDays.map((day) => [day.dayOfWeek, day] as const));
  const lowerBodyDays = strengthDays
    .filter((day) => day.lowerBodyDemand)
    .map((day) => day.dayOfWeek);
  const distanceFromLowerBody = (day: number) =>
    lowerBodyDays.length === 0
      ? 0
      : Math.min(...lowerBodyDays.map((lowerDay) => cyclicDistance(day, lowerDay)));

  const nonStrengthDays = isoWeekdays
    .filter((day) => !strengthByDay.has(day))
    .sort(
      (left, right) => distanceFromLowerBody(right) - distanceFromLowerBody(left) || left - right,
    );
  const selected: number[] = nonStrengthDays.slice(0, count);

  if (selected.length < count) {
    const combinedDays = [...strengthDays].sort(
      (left, right) =>
        Number(left.lowerBodyDemand) - Number(right.lowerBodyDemand) ||
        distanceFromLowerBody(right.dayOfWeek) - distanceFromLowerBody(left.dayOfWeek) ||
        left.dayOfWeek - right.dayOfWeek,
    );
    selected.push(...combinedDays.slice(0, count - selected.length).map((day) => day.dayOfWeek));
  }

  return selected.sort((left, right) => left - right);
}

function distributeDuration(totalMinutes: number, sessionCount: number): number[] {
  const totalUnits = totalMinutes / 5;
  const baseUnits = Math.floor(totalUnits / sessionCount);
  const remainder = totalUnits % sessionCount;
  return Array.from(
    { length: sessionCount },
    (_unused, index) => (baseUnits + (index < remainder ? 1 : 0)) * 5,
  );
}

const MINIMUM_PRESCRIBED_MINUTES = 20;
const PUBLIC_HEALTH_BASELINE_MINUTES = 150;

// The stance moves the prescription inside the band the default already uses,
// and never turns "some cardio" into "no cardio": the floor exists because the
// guideline is about health, not preference.
function applyPreference(
  additionalWeeklyMin: number,
  preference: NonNullable<CardioPrescriptionInput['preference']>,
): number {
  if (preference === 'STANDARD' || additionalWeeklyMin === 0) return additionalWeeklyMin;
  const scaled =
    preference === 'MINIMAL'
      ? Math.max(MINIMUM_PRESCRIBED_MINUTES, Math.round((additionalWeeklyMin * 0.5) / 5) * 5)
      : Math.min(
          PUBLIC_HEALTH_BASELINE_MINUTES,
          Math.round((additionalWeeklyMin * 1.4) / 5) * 5,
        );
  return scaled;
}

export function createCardioPrescription(input: CardioPrescriptionInput): CardioPrescription {
  validateInput(input);

  let additionalWeeklyMin: number;
  let reason: CardioReasonCode;
  if (input.currentModerateActivityMin < 60) {
    additionalWeeklyMin = 40;
    reason = 'CARDIO_BUILD_TO_BASELINE';
  } else if (input.currentModerateActivityMin < 150) {
    additionalWeeklyMin = Math.max(20, Math.ceil((150 - input.currentModerateActivityMin) / 5) * 5);
    reason = 'CARDIO_FILL_TO_150';
  } else {
    return {
      additionalWeeklyMin: 0,
      sessions: [],
      reasons: ['CARDIO_MAINTAIN_CURRENT'],
    };
  }

  additionalWeeklyMin = applyPreference(additionalWeeklyMin, input.preference ?? 'STANDARD');
  const sessionCount = additionalWeeklyMin > 40 ? 3 : 2;
  const days = chooseSessionDays(input.strengthDays, sessionCount);
  const durations = distributeDuration(additionalWeeklyMin, sessionCount);
  const sessions = days.map<CardioSession>((dayOfWeek, index) => ({
    dayOfWeek,
    durationMin: durations[index]!,
    mode: 'LOW_IMPACT',
    intensity: 'MODERATE',
    rpeMin: 3,
    rpeMax: 5,
  }));

  return { additionalWeeklyMin, sessions, reasons: [reason] };
}
