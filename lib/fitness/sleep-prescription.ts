import type { AssessmentInput, EligibilityReasonCode } from './schemas';

export type SleepPrescriptionInput = {
  habitualSleepMin: AssessmentInput['lifestyle']['habitualSleepMin'];
  wakeTimeMin: AssessmentInput['lifestyle']['wakeTimeMin'];
};

export type SleepReasonCode = Extract<
  EligibilityReasonCode,
  'SLEEP_ADD_30_MINUTES' | 'SLEEP_GENERAL_RANGE' | 'SLEEP_LONG_DURATION_CAP'
>;

export type SleepPrescription = {
  longTermMin: 420;
  longTermMax: 540;
  initialTargetMin: number;
  initialTargetMax: number;
  suggestedBedtimeMin: number;
  wakeTimeMin: number;
  reasons: SleepReasonCode[];
};

const LONG_TERM_MIN = 420;
const LONG_TERM_MAX = 540;

function assertBoundedInteger(value: number, min: number, max: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be a finite integer from ${min} through ${max}`);
  }
}

function roundToQuarterHour(value: number): number {
  return Math.round(value / 15) * 15;
}

function normalizeMinuteOfDay(value: number): number {
  return ((value % 1440) + 1440) % 1440;
}

export function createSleepPrescription(input: SleepPrescriptionInput): SleepPrescription {
  assertBoundedInteger(input.habitualSleepMin, 180, 900, 'habitualSleepMin');
  assertBoundedInteger(input.wakeTimeMin, 0, 1439, 'wakeTimeMin');

  let unroundedTarget: number;
  let reason: SleepReasonCode;
  if (input.habitualSleepMin < LONG_TERM_MIN) {
    unroundedTarget = Math.min(input.habitualSleepMin + 30, LONG_TERM_MIN);
    reason = 'SLEEP_ADD_30_MINUTES';
  } else if (input.habitualSleepMin <= LONG_TERM_MAX) {
    unroundedTarget = input.habitualSleepMin;
    reason = 'SLEEP_GENERAL_RANGE';
  } else {
    unroundedTarget = LONG_TERM_MAX;
    reason = 'SLEEP_LONG_DURATION_CAP';
  }

  const initialTarget = roundToQuarterHour(unroundedTarget);
  const wakeTimeMin = normalizeMinuteOfDay(roundToQuarterHour(input.wakeTimeMin));
  const unroundedBedtime = normalizeMinuteOfDay(wakeTimeMin - initialTarget - 30);
  const suggestedBedtimeMin = normalizeMinuteOfDay(roundToQuarterHour(unroundedBedtime));

  return {
    longTermMin: LONG_TERM_MIN,
    longTermMax: LONG_TERM_MAX,
    initialTargetMin: initialTarget,
    initialTargetMax: initialTarget,
    suggestedBedtimeMin,
    wakeTimeMin,
    reasons: [reason],
  };
}
