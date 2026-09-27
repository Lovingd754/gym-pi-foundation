import type { AssessmentInput, EligibilityReasonCode } from './schemas';

export type GoalFeasibilityStatus =
  | 'WITHIN_RANGE'
  | 'EARLIER_THAN_SUPPORTED'
  | 'LATER_THAN_ESTIMATE'
  | 'MILESTONE'
  | 'NOT_REQUESTED';

export type GoalFeasibilityReasonCode = Extract<
  EligibilityReasonCode,
  | 'TARGET_DATE_WITHIN_RANGE'
  | 'TARGET_DATE_EARLIER_THAN_SUPPORTED'
  | 'TARGET_DATE_LATER_THAN_ESTIMATE'
  | 'TARGET_DATE_MILESTONE'
>;

export type GoalFeasibilityInput = {
  currentWeightKg: AssessmentInput['profile']['weightKg'];
  goalType: AssessmentInput['goal']['type'];
  targetWeightKg?: AssessmentInput['goal']['targetWeightKg'];
  targetDate?: AssessmentInput['goal']['targetDate'];
  calculationDate: string;
};

export type GoalFeasibility = {
  status: GoalFeasibilityStatus;
  earliestDate: string | null;
  latestDate: string | null;
  targetDate: string | null;
  reasons: GoalFeasibilityReasonCode[];
};

const pacePercentages = {
  FAT_LOSS: { slow: 0.25, fast: 0.75 },
  HYPERTROPHY: { slow: 0.1, fast: 0.25 },
} as const;

function parseCalendarDate(value: string, label: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RangeError(`${label} must be a valid YYYY-MM-DD date`);
  }
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new RangeError(`${label} must be a valid YYYY-MM-DD date`);
  }
  return date;
}

function assertFourDigitCalendarYear(date: Date): void {
  const year = date.getUTCFullYear();
  if (!Number.isInteger(year) || year < 0 || year > 9999) {
    throw new RangeError('Calculated target date must use a four-digit year');
  }
}

function addWeeks(date: Date, weeks: number): Date {
  if (!Number.isSafeInteger(weeks) || weeks < 0) {
    throw new RangeError('Calculated duration must be a nonnegative number of weeks');
  }
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + weeks * 7);
  if (Number.isNaN(result.getTime())) {
    throw new RangeError('Calculated target date is invalid');
  }
  assertFourDigitCalendarYear(result);
  return result;
}

function formatCalendarDate(date: Date): string {
  assertFourDigitCalendarYear(date);
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function emptyFeasibility(): GoalFeasibility {
  return {
    status: 'NOT_REQUESTED',
    earliestDate: null,
    latestDate: null,
    targetDate: null,
    reasons: [],
  };
}

export function evaluateGoalFeasibility(input: GoalFeasibilityInput): GoalFeasibility {
  if (!Number.isFinite(input.currentWeightKg) || input.currentWeightKg <= 0) {
    throw new RangeError('currentWeightKg must be finite and positive');
  }
  const calculationDate = parseCalendarDate(input.calculationDate, 'calculationDate');
  const targetEndpoint =
    input.targetDate === undefined ? undefined : parseCalendarDate(input.targetDate, 'targetDate');

  if (input.goalType === 'RECOMP') {
    if (input.targetWeightKg !== undefined) {
      throw new RangeError('Recomp does not accept a target weight');
    }
    if (input.targetDate === undefined) return emptyFeasibility();
    return {
      status: 'MILESTONE',
      earliestDate: null,
      latestDate: null,
      targetDate: input.targetDate,
      reasons: ['TARGET_DATE_MILESTONE'],
    };
  }

  if (input.goalType !== 'FAT_LOSS' && input.goalType !== 'HYPERTROPHY') {
    throw new RangeError('Unsupported goal type');
  }
  const { targetWeightKg, targetDate } = input;
  const hasTargetWeight = targetWeightKg !== undefined;
  const hasTargetDate = targetDate !== undefined;
  if (!hasTargetWeight && !hasTargetDate) return emptyFeasibility();
  if (targetWeightKg === undefined || targetDate === undefined || targetEndpoint === undefined) {
    throw new RangeError('Target weight and target date must be supplied together');
  }
  if (!Number.isFinite(targetWeightKg) || targetWeightKg <= 0) {
    throw new RangeError('targetWeightKg must be finite and positive');
  }
  if (
    (input.goalType === 'FAT_LOSS' && targetWeightKg >= input.currentWeightKg) ||
    (input.goalType === 'HYPERTROPHY' && targetWeightKg <= input.currentWeightKg)
  ) {
    throw new RangeError('Target weight must move in the selected goal direction');
  }

  const weightDelta = Math.abs(targetWeightKg - input.currentWeightKg);
  const pace = pacePercentages[input.goalType];
  const fastWeeklyKg = (input.currentWeightKg * pace.fast) / 100;
  const slowWeeklyKg = (input.currentWeightKg * pace.slow) / 100;
  const earliestEndpoint = addWeeks(calculationDate, Math.ceil(weightDelta / fastWeeklyKg));
  const latestEndpoint = addWeeks(calculationDate, Math.ceil(weightDelta / slowWeeklyKg));
  let status: GoalFeasibilityStatus;
  let reason: GoalFeasibilityReasonCode;
  if (targetEndpoint.getTime() < earliestEndpoint.getTime()) {
    status = 'EARLIER_THAN_SUPPORTED';
    reason = 'TARGET_DATE_EARLIER_THAN_SUPPORTED';
  } else if (targetEndpoint.getTime() > latestEndpoint.getTime()) {
    status = 'LATER_THAN_ESTIMATE';
    reason = 'TARGET_DATE_LATER_THAN_ESTIMATE';
  } else {
    status = 'WITHIN_RANGE';
    reason = 'TARGET_DATE_WITHIN_RANGE';
  }

  return {
    status,
    earliestDate: formatCalendarDate(earliestEndpoint),
    latestDate: formatCalendarDate(latestEndpoint),
    targetDate,
    reasons: [reason],
  };
}
