import { CLEARANCE_VALIDITY_MONTHS } from './versions';
import {
  assertValidAssessmentCalculationTime,
  eligibilityReasonCodeValues,
  type AssessmentInput,
  type EligibilityReasonCode,
  type EligibilityStatus,
} from './schemas';

export type EligibilityDecision = {
  status: EligibilityStatus;
  reasonCodes: EligibilityReasonCode[];
  clearanceExpiresAt: Date | null;
};

const urgentReasons = {
  CURRENT_CHEST_PRESSURE_OR_PAIN: 'URGENT_CHEST_PAIN_AT_REST',
  SEVERE_BREATHING_DIFFICULTY: 'URGENT_SEVERE_BREATHING_DIFFICULTY',
  CURRENT_LOSS_OF_CONSCIOUSNESS: 'URGENT_FAINTING_WITHOUT_EXPLANATION',
  CHEST_DISCOMFORT_WITH_SYSTEMIC_SIGNS: 'URGENT_CHEST_PAIN_AT_REST',
} as const satisfies Record<
  AssessmentInput['health']['urgentSignals'][number],
  EligibilityReasonCode
>;

const scopeReasons = {
  PREGNANT_OR_POSTPARTUM: 'SCOPE_PREGNANT_OR_POSTPARTUM',
  ACTIVE_EATING_DISORDER_TREATMENT: 'SCOPE_EATING_DISORDER_TREATMENT',
  DISEASE_SPECIFIC_EXERCISE_OR_NUTRITION_CARE: 'SCOPE_DISEASE_SPECIFIC_CARE',
  POSTOPERATIVE_OR_DISEASE_SPECIFIC_REHABILITATION: 'SCOPE_DISEASE_SPECIFIC_CARE',
} as const satisfies Record<
  AssessmentInput['health']['scopeSignals'][number],
  EligibilityReasonCode
>;

const temporaryReasons = {
  FEVER_OR_ACUTE_INFECTION: 'HOLD_ACUTE_ILLNESS',
  NEW_UNEVALUATED_INJURY_OR_ABNORMAL_PAIN: 'HOLD_ACUTE_INJURY',
  RECENT_SURGERY_WITHOUT_RETURN_CLEARANCE: 'HOLD_RECENT_SURGERY',
  MAJOR_RECENT_HEALTH_OR_MEDICATION_CHANGE: 'HOLD_ACUTE_ILLNESS',
} as const satisfies Record<
  AssessmentInput['health']['temporarySignals'][number],
  EligibilityReasonCode
>;

const clearanceReasons = {
  KNOWN_CARDIOVASCULAR_CONDITION: 'CLEARANCE_CARDIOVASCULAR_CONCERN',
  KNOWN_DIABETES_OR_RENAL_CONDITION: 'CLEARANCE_METABOLIC_OR_RENAL_CONCERN',
  UNEXPLAINED_CHEST_NECK_JAW_ARM_SYMPTOM: 'CLEARANCE_EXERCISE_SYMPTOM',
  UNUSUAL_SHORTNESS_OF_BREATH: 'CLEARANCE_EXERCISE_SYMPTOM',
  DIZZINESS_FAINTING_OR_NEAR_FAINTING: 'CLEARANCE_EXERCISE_SYMPTOM',
  ORTHOPNEA_OR_NOCTURNAL_BREATHING_DIFFICULTY: 'CLEARANCE_EXERCISE_SYMPTOM',
  UNEXPLAINED_ANKLE_EDEMA: 'CLEARANCE_EXERCISE_SYMPTOM',
  RECURRENT_PALPITATION_OR_IRREGULAR_RHYTHM: 'CLEARANCE_EXERCISE_SYMPTOM',
  EXERTIONAL_LEG_PAIN_RELIEVED_BY_REST: 'CLEARANCE_EXERCISE_SYMPTOM',
  KNOWN_HEART_MURMUR: 'CLEARANCE_EXERCISE_SYMPTOM',
  UNUSUAL_FATIGUE_DURING_DAILY_ACTIVITY: 'CLEARANCE_EXERCISE_SYMPTOM',
  UNCONTROLLED_HYPERTENSION_OR_LIFTING_RESTRICTION: 'CLEARANCE_EXERCISE_SYMPTOM',
} as const satisfies Record<
  AssessmentInput['health']['clearanceSignals'][number],
  EligibilityReasonCode
>;

const knownConditionSignals = new Set<AssessmentInput['health']['clearanceSignals'][number]>([
  'KNOWN_CARDIOVASCULAR_CONDITION',
  'KNOWN_DIABETES_OR_RENAL_CONDITION',
]);

const reasonOrder = new Map(
  eligibilityReasonCodeValues.map((reason, index) => [reason, index] as const),
);

function sortedUnique(reasons: readonly EligibilityReasonCode[]): EligibilityReasonCode[] {
  return [...new Set(reasons)].sort(
    (left, right) => reasonOrder.get(left)! - reasonOrder.get(right)!,
  );
}

function dateParts(value: string): [number, number, number] {
  const [year, month, day] = value.split('-').map(Number);
  return [year!, month!, day!];
}

function addCalendarMonths(value: string, months: number): Date {
  const [year, month, day] = dateParts(value);
  const absoluteMonth = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(absoluteMonth / 12);
  const targetMonth = (absoluteMonth % 12) + 1;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, targetMonth - 1, Math.min(day, lastDay), 23, 59, 59, 999));
}

function localDate(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function evaluateEligibility(
  input: Pick<AssessmentInput, 'profile' | 'lifestyle' | 'health'>,
  now: Date,
): EligibilityDecision {
  assertValidAssessmentCalculationTime(now);
  const { profile, lifestyle, health } = input;
  const clearanceExpiresAt = health.clearance
    ? addCalendarMonths(health.clearance.date, CLEARANCE_VALIDITY_MONTHS)
    : null;

  const urgent = sortedUnique(health.urgentSignals.map((signal) => urgentReasons[signal]));
  if (urgent.length > 0) {
    return { status: 'URGENT_ACTION', reasonCodes: urgent, clearanceExpiresAt };
  }

  const outOfScope: EligibilityReasonCode[] = health.scopeSignals.map(
    (signal) => scopeReasons[signal],
  );
  if (profile.ageYears < 18 || profile.ageYears > 64) {
    outOfScope.push('SCOPE_AGE_OUTSIDE_RANGE');
  }
  if (health.clearance && !health.clearance.unrestricted) {
    outOfScope.push('SCOPE_RESTRICTED_CLEARANCE');
  }
  if (outOfScope.length > 0) {
    return {
      status: 'OUT_OF_SCOPE',
      reasonCodes: sortedUnique(outOfScope),
      clearanceExpiresAt,
    };
  }

  const temporary = sortedUnique(health.temporarySignals.map((signal) => temporaryReasons[signal]));
  if (temporary.length > 0) {
    return { status: 'TEMPORARY_HOLD', reasonCodes: temporary, clearanceExpiresAt };
  }

  const today = localDate(now, lifestyle.timeZone);
  const isExpired = clearanceExpiresAt !== null && dateKey(clearanceExpiresAt) < today;
  const hasUsableClearance =
    health.clearance?.unrestricted === true && !isExpired && !health.healthChangedSinceClearance;
  const unresolvedSignals = health.clearanceSignals.filter(
    (signal) => !knownConditionSignals.has(signal) || !hasUsableClearance,
  );
  const clearance: EligibilityReasonCode[] = unresolvedSignals.map(
    (signal) => clearanceReasons[signal],
  );
  if (health.clearanceSignals.length > 0 && isExpired) {
    clearance.push('CLEARANCE_EXPIRED');
  }
  if (health.clearance && health.healthChangedSinceClearance) {
    clearance.push('CLEARANCE_HEALTH_CHANGED');
  }
  if (clearance.length > 0) {
    return {
      status: 'NEEDS_MEDICAL_CLEARANCE',
      reasonCodes: sortedUnique(clearance),
      clearanceExpiresAt,
    };
  }

  return {
    status: 'ELIGIBLE',
    reasonCodes: ['ELIGIBLE_GENERAL_POPULATION'],
    clearanceExpiresAt,
  };
}
