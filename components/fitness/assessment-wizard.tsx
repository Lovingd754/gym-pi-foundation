'use client';

import { useEffect, useMemo, useReducer, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Loader2, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import type { WeightUnit } from '@/lib/prisma-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { STRENGTH_EXERCISE_CATALOG } from '@/lib/fitness/exercise-catalog';
import {
  assessmentInputBaseSchema,
  clearanceSignalValues,
  scopeSignalValues,
  temporarySignalValues,
  urgentSignalValues,
  type AssessmentInput,
} from '@/lib/fitness/schemas';
import type { EligibilityStatus } from '@/lib/fitness/schemas';
import { fromDisplayWeight, roundWeight, toDisplayWeight, unitLabel } from '@/lib/units';
import { DEFAULT_PACE, PACE_ORDER, monthlyChangeKg, paceToRate, rateToPace } from '@/lib/fitness/pace';

// ============================================================
// Five-step assessment wizard
// ============================================================
// One reducer owns the whole form; nothing is sent until the final confirmation.
// The client parses the payload for immediate feedback, but the server response
// stays authoritative - eligibility, prescription and staleness are all decided
// there.

export type WizardAssessment = AssessmentInput;

export interface AssessmentWizardProps {
  // The saved assessment (already normalized by the server) or null on first run.
  savedAssessment: {
    profile: Omit<AssessmentInput['profile'], 'displayName' | 'waistCm' | 'bodyFatPct'> & {
      waistCm: number | null;
      bodyFatPct: number | null;
    };
    goal: {
      type: AssessmentInput['goal']['type'];
      desiredWeeklyRatePct: number;
      targetWeightKg: number | null;
      targetDate: string | null;
    };
    schedule: AssessmentInput['schedule'];
    lifestyle: Omit<AssessmentInput['lifestyle'], 'avgDailySteps'> & {
      avgDailySteps: number | null;
    };
    // The read model spells the absence of a note as null, not undefined.
    softConstraints?: string | null;
    // The read model carries an explicit null when no clearance was recorded.
    health: Omit<AssessmentInput['health'], 'clearance'> & {
      clearance: { date: string; unrestricted: boolean; restrictions: string | null } | null;
    };
  } | null;
  unit: WeightUnit;
  // First-run onboarding may be deferred; voluntary setup and editing may not.
  onboardingRequired: boolean;
}

type HealthGroup = 'urgent' | 'clearance' | 'temporary' | 'scope';

interface LiftRow {
  catalogKey: string;
  weight: string;
  reps: string;
  rir: string;
}

interface Values {
  ageYears: string;
  displaySex: AssessmentInput['profile']['displaySex'];
  energyEquationReference: AssessmentInput['profile']['energyEquationReference'];
  heightCm: string;
  weight: string;
  waistCm: string;
  bodyFatPct: string;
  trainingAgeMonths: string;
  goalType: AssessmentInput['goal']['type'];
  desiredWeeklyRatePct: string;
  targetWeight: string;
  targetDate: string;
  weeklyFrequency: 2 | 3 | 4 | 5;
  availableWeekdays: number[];
  sessionDurationMin: string;
  equipmentTypes: AssessmentInput['schedule']['equipmentTypes'];
  recentMainLifts: LiftRow[];
  activityLevel: AssessmentInput['lifestyle']['activityLevel'];
  avgDailySteps: string;
  currentModerateActivityMin: string;
  habitualSleep: string;
  bedtime: string;
  wakeTime: string;
  timeZone: string;
  // Soft constraints: free text the model reads to shape the plan's strategy.
  softConstraints: string;
  healthYes: Record<HealthGroup, boolean>;
  urgentSignals: string[];
  clearanceSignals: string[];
  temporarySignals: string[];
  scopeSignals: string[];
  healthChangedSinceClearance: boolean;
  endorsedClearance: boolean;
  clearanceDate: string;
  clearanceUnrestricted: boolean;
  clearanceRestrictions: string;
  attested: boolean;
}

interface State {
  step: number;
  values: Values;
  fieldErrors: Record<string, string>;
  submitting: boolean;
  blocked: { status: EligibilityStatus | null; reasons: string[]; message: string | null } | null;
  transientError: string | null;
}

type Action =
  | { type: 'LOAD'; values: Values }
  | { type: 'SET_FIELD'; path: string; value: unknown }
  | { type: 'SET_SIGNAL'; group: HealthGroup; signal: string; selected: boolean }
  | { type: 'SET_GROUP'; group: HealthGroup; yes: boolean }
  | { type: 'NEXT'; step: number; fieldErrors: Record<string, string> }
  | { type: 'BACK' }
  | { type: 'SUBMIT_START' }
  | { type: 'SUBMIT_SUCCESS' }
  | {
      type: 'SUBMIT_BLOCKED';
      status: EligibilityStatus | null;
      reasons: string[];
      message: string | null;
    }
  | { type: 'SUBMIT_ERROR'; message: string };

const STEP_COUNT = 5;

// Dynamic keys (step names, weekday numbers, health signals, reason codes) are
// resolved at runtime; the locale parity test in lib/fitness/messages.test.ts
// asserts every code actually has copy, which is the guarantee that matters.
function useFitnessT(): (key: string, values?: Record<string, string | number>) => string {
  const t = useTranslations('fitness');
  return t as unknown as (key: string, values?: Record<string, string | number>) => string;
}

const healthGroups: readonly HealthGroup[] = ['urgent', 'clearance', 'temporary', 'scope'];

const signalKeyByGroup: Record<HealthGroup, keyof Values> = {
  urgent: 'urgentSignals',
  clearance: 'clearanceSignals',
  temporary: 'temporarySignals',
  scope: 'scopeSignals',
};

// Immutable update along a dotted path. Arrays must stay arrays: spreading one
// into an object would turn `recentMainLifts.0.weight` into a plain object and
// break every later `.map`.
function setAtPath<T>(source: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split('.');
  if (!head) return source;

  if (Array.isArray(source)) {
    const copy = [...source];
    if (rest.length === 0) copy[Number(head)] = value;
    else copy[Number(head)] = setAtPath(copy[Number(head)] ?? {}, rest.join('.'), value);
    return copy as unknown as T;
  }

  const current = source as unknown as Record<string, unknown>;
  if (rest.length === 0) return { ...current, [head]: value } as unknown as T;
  return {
    ...current,
    [head]: setAtPath(current[head] ?? {}, rest.join('.'), value),
  } as unknown as T;
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'LOAD':
      return { ...state, values: action.values, step: 0, fieldErrors: {} };
    case 'SET_FIELD':
      return { ...state, values: setAtPath(state.values, action.path, action.value) };
    case 'SET_SIGNAL': {
      const key = signalKeyByGroup[action.group];
      const current = state.values[key] as string[];
      const next = action.selected
        ? [...new Set([...current, action.signal])]
        : current.filter((signal) => signal !== action.signal);
      return { ...state, values: { ...state.values, [key]: next } };
    }
    case 'SET_GROUP': {
      const key = signalKeyByGroup[action.group];
      return {
        ...state,
        values: {
          ...state.values,
          healthYes: { ...state.values.healthYes, [action.group]: action.yes },
          [key]: action.yes ? (state.values[key] as string[]) : [],
        },
      };
    }
    case 'NEXT':
      return { ...state, step: action.step, fieldErrors: action.fieldErrors };
    case 'BACK':
      return { ...state, step: Math.max(0, state.step - 1), fieldErrors: {} };
    case 'SUBMIT_START':
      return { ...state, submitting: true, transientError: null, fieldErrors: {}, blocked: null };
    case 'SUBMIT_SUCCESS':
      return { ...state, submitting: false };
    case 'SUBMIT_BLOCKED':
      return {
        ...state,
        submitting: false,
        blocked: { status: action.status, reasons: action.reasons, message: action.message },
      };
    case 'SUBMIT_ERROR':
      return { ...state, submitting: false, transientError: action.message };
    default:
      return state;
  }
}

function minutesToClock(minutes: number): string {
  const hours = Math.floor(minutes / 60) % 24;
  const mins = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

function clockToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  if (hours > 23 || mins > 59) return null;
  return hours * 60 + mins;
}

function emptyValues(unit: WeightUnit, timeZone: string): Values {
  return {
    ageYears: '',
    displaySex: 'PREFER_NOT_TO_SAY',
    energyEquationReference: 'UNSPECIFIED',
    heightCm: '',
    weight: '',
    waistCm: '',
    bodyFatPct: '',
    trainingAgeMonths: '',
    goalType: 'HYPERTROPHY',
    desiredWeeklyRatePct: '0.2',
    targetWeight: '',
    targetDate: '',
    weeklyFrequency: 3,
    availableWeekdays: [1, 3, 5],
    sessionDurationMin: '60',
    equipmentTypes: ['BODYWEIGHT'],
    recentMainLifts: [],
    activityLevel: 'MODERATE',
    avgDailySteps: '',
    currentModerateActivityMin: '90',
    habitualSleep: '07:30',
    bedtime: '23:00',
    wakeTime: '07:00',
    timeZone,
    softConstraints: '',
    healthYes: { urgent: false, clearance: false, temporary: false, scope: false },
    urgentSignals: [],
    clearanceSignals: [],
    temporarySignals: [],
    scopeSignals: [],
    healthChangedSinceClearance: false,
    endorsedClearance: false,
    clearanceDate: '',
    clearanceUnrestricted: true,
    clearanceRestrictions: '',
    attested: false,
  };
}

// One decimal is the smallest unit the UI ever needs; unrounded conversions
// would otherwise render values like 154.32358352941437.
function toDisplay(kg: number, unit: WeightUnit): string {
  return String(roundWeight(toDisplayWeight(kg, unit), 1));
}

function valuesFromSaved(
  saved: NonNullable<AssessmentWizardProps['savedAssessment']>,
  unit: WeightUnit,
): Values {
  const base = emptyValues(unit, saved.lifestyle.timeZone);
  return {
    ...base,
    ageYears: String(saved.profile.ageYears),
    displaySex: saved.profile.displaySex,
    energyEquationReference: saved.profile.energyEquationReference,
    heightCm: String(saved.profile.heightCm),
    weight: toDisplay(saved.profile.weightKg, unit),
    waistCm: saved.profile.waistCm === null ? '' : String(saved.profile.waistCm),
    bodyFatPct: saved.profile.bodyFatPct === null ? '' : String(saved.profile.bodyFatPct),
    trainingAgeMonths: String(saved.profile.trainingAgeMonths),
    goalType: saved.goal.type,
    desiredWeeklyRatePct: String(saved.goal.desiredWeeklyRatePct),
    targetWeight:
      saved.goal.targetWeightKg === null ? '' : toDisplay(saved.goal.targetWeightKg, unit),
    targetDate: saved.goal.targetDate ?? '',
    weeklyFrequency: saved.schedule.weeklyFrequency,
    availableWeekdays: [...saved.schedule.availableWeekdays].sort((a, b) => a - b),
    sessionDurationMin: String(saved.schedule.sessionDurationMin),
    equipmentTypes: saved.schedule.equipmentTypes,
    recentMainLifts: saved.schedule.recentMainLifts.map((lift) => ({
      catalogKey: lift.catalogKey,
      weight: toDisplay(lift.weightKg, unit),
      reps: String(lift.reps),
      rir: String(lift.rir),
    })),
    activityLevel: saved.lifestyle.activityLevel,
    avgDailySteps:
      saved.lifestyle.avgDailySteps === null ? '' : String(saved.lifestyle.avgDailySteps),
    currentModerateActivityMin: String(saved.lifestyle.currentModerateActivityMin),
    habitualSleep: minutesToClock(saved.lifestyle.habitualSleepMin),
    bedtime: minutesToClock(saved.lifestyle.bedtimeMin),
    wakeTime: minutesToClock(saved.lifestyle.wakeTimeMin),
    timeZone: saved.lifestyle.timeZone,
    softConstraints: saved.softConstraints ?? '',
    healthYes: {
      urgent: saved.health.urgentSignals.length > 0,
      clearance: saved.health.clearanceSignals.length > 0 || Boolean(saved.health.clearance),
      temporary: saved.health.temporarySignals.length > 0,
      scope: saved.health.scopeSignals.length > 0,
    },
    urgentSignals: [...saved.health.urgentSignals],
    clearanceSignals: [...saved.health.clearanceSignals],
    temporarySignals: [...saved.health.temporarySignals],
    scopeSignals: [...saved.health.scopeSignals],
    healthChangedSinceClearance: saved.health.healthChangedSinceClearance,
    endorsedClearance: Boolean(saved.health.clearance),
    clearanceDate: saved.health.clearance?.date ?? '',
    clearanceUnrestricted: saved.health.clearance?.unrestricted ?? true,
    clearanceRestrictions: saved.health.clearance?.restrictions ?? '',
    attested: saved.health.attested,
  };
}

const rateRangeByGoal = {
  FAT_LOSS: [-0.75, -0.25],
  HYPERTROPHY: [0.1, 0.25],
  RECOMP: [-0.25, 0.25],
} as const;

// The pace the trainee picked, said back to them in kilograms per month rather
// than a percentage of bodyweight - the number they can actually picture.
function describePace(
  t: (key: string, values?: Record<string, string | number>) => string,
  input: { goalType: AssessmentInput['goal']['type']; ratePct: number; weightKg: number },
): string {
  if (input.goalType === 'RECOMP' && input.ratePct === 0) return t('assessment.pacePreview.recomp');
  const perMonth = monthlyChangeKg(input.ratePct, input.weightKg);
  if (perMonth < 0.1) return t('assessment.pacePreview.flat');
  return t(input.ratePct < 0 ? 'assessment.pacePreview.lose' : 'assessment.pacePreview.gain', {
    amount: perMonth,
  });
}

const equipmentOptions = ['DUMBBELL', 'BARBELL', 'MACHINE', 'CABLE', 'BODYWEIGHT'] as const;
const weekdayOptions = [1, 2, 3, 4, 5, 6, 7] as const;
const activityOptions = ['SEDENTARY', 'LIGHT', 'MODERATE', 'HIGH'] as const;
const goalOptions = ['HYPERTROPHY', 'FAT_LOSS', 'RECOMP'] as const;
// The default amounts to the "normal" pace of each goal, used when the current
// rate is not valid for the goal the user just picked (0.2 % is fine for
// hypertrophy and impossible for fat loss, so switching must move it along).
const defaultRateByGoal = {
  FAT_LOSS: paceToRate('FAT_LOSS', DEFAULT_PACE),
  HYPERTROPHY: paceToRate('HYPERTROPHY', DEFAULT_PACE),
  RECOMP: paceToRate('RECOMP', DEFAULT_PACE),
} as const;
const sexOptions = ['MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY'] as const;
const energyOptions = ['MALE', 'FEMALE', 'UNSPECIFIED'] as const;

const signalValuesByGroup: Record<HealthGroup, readonly string[]> = {
  urgent: urgentSignalValues,
  clearance: clearanceSignalValues,
  temporary: temporarySignalValues,
  scope: scopeSignalValues,
};

function numberOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

// What actually goes over the wire. `AssessmentInput` is the server-side output
// type (clearance carries a normalized `restrictions: string | null`), while the
// request body omits that key when the clearance is unrestricted.
export type AssessmentPayload = Omit<AssessmentInput, 'health'> & {
  health: Omit<AssessmentInput['health'], 'clearance'> & {
    clearance?: { date: string; unrestricted: boolean; restrictions?: string };
  };
};

function toAssessmentInput(values: Values, unit: WeightUnit): AssessmentPayload {
  const goalHasTarget = values.targetWeight.trim() !== '' || values.targetDate.trim() !== '';
  const clearance =
    values.healthYes.clearance || values.endorsedClearance
      ? {
          date: values.clearanceDate,
          unrestricted: values.clearanceUnrestricted,
          ...(values.clearanceUnrestricted || values.clearanceRestrictions.trim() === ''
            ? {}
            : { restrictions: values.clearanceRestrictions.trim() }),
        }
      : undefined;
  return {
    profile: {
      ageYears: numberOrNull(values.ageYears) ?? 0,
      displaySex: values.displaySex,
      energyEquationReference: values.energyEquationReference,
      heightCm: numberOrNull(values.heightCm) ?? 0,
      weightKg: fromDisplayWeight(numberOrNull(values.weight) ?? 0, unit),
      ...(numberOrNull(values.waistCm) === null ? {} : { waistCm: numberOrNull(values.waistCm)! }),
      ...(numberOrNull(values.bodyFatPct) === null
        ? {}
        : { bodyFatPct: numberOrNull(values.bodyFatPct)! }),
      trainingAgeMonths: numberOrNull(values.trainingAgeMonths) ?? 0,
    },
    goal: {
      type: values.goalType,
      // Snapped to the nearest choice, so a value saved before the pace picker
      // existed cannot come back as a rate no option shows.
      desiredWeeklyRatePct: paceToRate(
        values.goalType,
        rateToPace(
          values.goalType,
          numberOrNull(values.desiredWeeklyRatePct) ?? paceToRate(values.goalType, DEFAULT_PACE),
        ),
      ),
      ...(values.goalType !== 'RECOMP' && goalHasTarget
        ? {
            targetWeightKg: fromDisplayWeight(numberOrNull(values.targetWeight) ?? 0, unit),
            targetDate: values.targetDate,
          }
        : {}),
    },
    schedule: {
      weeklyFrequency: values.weeklyFrequency,
      availableWeekdays: [...values.availableWeekdays].sort((a, b) => a - b),
      sessionDurationMin: numberOrNull(values.sessionDurationMin) ?? 0,
      equipmentTypes: values.equipmentTypes,
      recentMainLifts: values.recentMainLifts.map((lift) => ({
        catalogKey:
          lift.catalogKey as AssessmentInput['schedule']['recentMainLifts'][number]['catalogKey'],
        weightKg: fromDisplayWeight(numberOrNull(lift.weight) ?? 0, unit),
        reps: numberOrNull(lift.reps) ?? 0,
        rir: numberOrNull(lift.rir) ?? 0,
      })),
    },
    lifestyle: {
      activityLevel: values.activityLevel,
      ...(numberOrNull(values.avgDailySteps) === null
        ? {}
        : { avgDailySteps: numberOrNull(values.avgDailySteps)! }),
      currentModerateActivityMin: numberOrNull(values.currentModerateActivityMin) ?? 0,
      habitualSleepMin: clockToMinutes(values.habitualSleep) ?? 0,
      bedtimeMin: clockToMinutes(values.bedtime) ?? 0,
      wakeTimeMin: clockToMinutes(values.wakeTime) ?? 0,
      timeZone: values.timeZone,
    },
    ...(values.softConstraints.trim() === ''
      ? {}
      : { softConstraints: values.softConstraints.trim() }),
    health: {
      urgentSignals: values.urgentSignals as AssessmentInput['health']['urgentSignals'],
      clearanceSignals: values.clearanceSignals as AssessmentInput['health']['clearanceSignals'],
      temporarySignals: values.temporarySignals as AssessmentInput['health']['temporarySignals'],
      scopeSignals: values.scopeSignals as AssessmentInput['health']['scopeSignals'],
      healthChangedSinceClearance: values.healthChangedSinceClearance,
      ...(clearance ? { clearance } : {}),
      attested: true,
    },
  };
}

// Returns the first invalid field path per step so the caller can focus it.
function validateStep(
  step: number,
  values: Values,
  unit: WeightUnit,
  today: string,
  t: (key: string, values?: Record<string, string | number>) => string,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const bounded = (path: string, raw: string, min: number, max: number, integer = false) => {
    const value = numberOrNull(raw);
    if (value === null) {
      errors[path] = t('validation.required');
      return;
    }
    if (integer && !Number.isInteger(value)) {
      errors[path] = t('validation.number');
      return;
    }
    if (value < min) errors[path] = t('validation.min', { min });
    else if (value > max) errors[path] = t('validation.max', { max });
  };

  if (step === 0) {
    bounded('ageYears', values.ageYears, 0, 120, true);
    bounded('heightCm', values.heightCm, 120, 230, true);
    bounded('weight', values.weight, unit === 'LB' ? 77.2 : 35, unit === 'LB' ? 661.4 : 300);
    bounded('trainingAgeMonths', values.trainingAgeMonths, 0, 600, true);
    if (values.waistCm.trim() !== '') bounded('waistCm', values.waistCm, 40, 220);
    if (values.bodyFatPct.trim() !== '') bounded('bodyFatPct', values.bodyFatPct, 3, 70);
  }

  if (step === 1) {
    const [minRate, maxRate] = rateRangeByGoal[values.goalType];
    const rate = numberOrNull(values.desiredWeeklyRatePct);
    if (rate === null) errors.desiredWeeklyRatePct = t('validation.required');
    else if (rate < minRate) errors.desiredWeeklyRatePct = t('validation.min', { min: minRate });
    else if (rate > maxRate) errors.desiredWeeklyRatePct = t('validation.max', { max: maxRate });

    const hasWeight = values.targetWeight.trim() !== '';
    const hasDate = values.targetDate.trim() !== '';
    if (values.goalType === 'RECOMP') {
      if (hasWeight) errors.targetWeight = t('validation.targetPair');
    } else if (hasWeight !== hasDate) {
      errors[hasWeight ? 'targetDate' : 'targetWeight'] = t('validation.targetPair');
    } else if (hasWeight) {
      const target = numberOrNull(values.targetWeight);
      const current = numberOrNull(values.weight);
      if (target === null) errors.targetWeight = t('validation.required');
      else if (current !== null) {
        if (values.goalType === 'FAT_LOSS' && target >= current) {
          errors.targetWeight = t('validation.targetDirection');
        }
        if (values.goalType === 'HYPERTROPHY' && target <= current) {
          errors.targetWeight = t('validation.targetDirection');
        }
      }
      if (values.targetDate <= today) errors.targetDate = t('validation.targetFuture');
    }
  }

  if (step === 2) {
    const duration = numberOrNull(values.sessionDurationMin);
    if (duration === null) errors.sessionDurationMin = t('validation.required');
    else if (duration < 30) errors.sessionDurationMin = t('validation.min', { min: 30 });
    else if (duration > 120) errors.sessionDurationMin = t('validation.max', { max: 120 });
    else if (duration % 5 !== 0) errors.sessionDurationMin = t('validation.number');
    if (values.availableWeekdays.length < values.weeklyFrequency) {
      errors.availableWeekdays = t('validation.weekdayCount');
    }
    if (values.equipmentTypes.length === 0) errors.equipmentTypes = t('validation.equipment');
    values.recentMainLifts.forEach((lift, index) => {
      if (numberOrNull(lift.weight) === null)
        errors[`recentMainLifts.${index}.weight`] = t('validation.required');
      if (numberOrNull(lift.reps) === null)
        errors[`recentMainLifts.${index}.reps`] = t('validation.required');
      if (numberOrNull(lift.rir) === null)
        errors[`recentMainLifts.${index}.rir`] = t('validation.required');
    });
  }

  if (step === 3) {
    bounded('currentModerateActivityMin', values.currentModerateActivityMin, 0, 2000, true);
    if (values.avgDailySteps.trim() !== '')
      bounded('avgDailySteps', values.avgDailySteps, 0, 100000, true);
    const sleep = clockToMinutes(values.habitualSleep);
    if (sleep === null) errors.habitualSleep = t('validation.required');
    else if (sleep < 180) errors.habitualSleep = t('validation.min', { min: '3:00' });
    else if (sleep > 900) errors.habitualSleep = t('validation.max', { max: '15:00' });
    if (clockToMinutes(values.bedtime) === null) errors.bedtime = t('validation.required');
    if (clockToMinutes(values.wakeTime) === null) errors.wakeTime = t('validation.required');
    if (values.timeZone.trim() === '') errors.timeZone = t('validation.required');
  }

  if (step === 4) {
    if (values.healthYes.clearance || values.endorsedClearance) {
      if (values.clearanceDate.trim() === '') errors.clearanceDate = t('validation.required');
      else if (values.clearanceDate > today) errors.clearanceDate = t('validation.targetFuture');
      if (!values.clearanceUnrestricted && values.clearanceRestrictions.trim() === '') {
        errors.clearanceRestrictions = t('validation.required');
      }
    }
    if (!values.attested) errors.attested = t('validation.required');
  }

  return errors;
}

const steps = ['profile', 'goal', 'training', 'lifestyle', 'health'] as const;

export function AssessmentWizard({
  savedAssessment,
  unit,
  onboardingRequired,
}: AssessmentWizardProps) {
  const t = useFitnessT();
  const router = useRouter();
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const browserZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', []);
  const [state, dispatch] = useReducer(reducer, null, () => ({
    step: 0,
    values: savedAssessment
      ? valuesFromSaved(savedAssessment, unit)
      : emptyValues(unit, browserZone),
    fieldErrors: {},
    submitting: false,
    blocked: null,
    transientError: null,
  }));
  const stepName = steps[state.step] ?? 'profile';
  const loadedRef = useRef(savedAssessment);

  useEffect(() => {
    if (savedAssessment && loadedRef.current !== savedAssessment) {
      loadedRef.current = savedAssessment;
      dispatch({ type: 'LOAD', values: valuesFromSaved(savedAssessment, unit) });
    }
  }, [savedAssessment, unit]);

  const field = (path: keyof Values | string) => t(`assessment.fields.${path}`);
  const describe = (path: string) => (state.fieldErrors[path] ? `${domId(path)}-error` : undefined);

  function set(path: string, value: unknown) {
    dispatch({ type: 'SET_FIELD', path, value });
  }

  // Focus the first invalid control so a failed step is actionable without a
  // pointer, and keep aria-describedby wired to the message element.
  function focusFirstError(errors: Record<string, string>) {
    const [first] = Object.keys(errors);
    if (!first) return;
    requestAnimationFrame(() => document.getElementById(domId(first))?.focus());
  }

  function goNext() {
    const errors = validateStep(state.step, state.values, unit, today, t);
    if (Object.keys(errors).length > 0) {
      dispatch({ type: 'NEXT', step: state.step, fieldErrors: errors });
      focusFirstError(errors);
      return;
    }
    if (state.step === STEP_COUNT - 1) return;
    dispatch({ type: 'NEXT', step: state.step + 1, fieldErrors: {} });
  }

  async function submit() {
    // Re-entry guard: a second click while the first request is in flight is
    // ignored, so exactly one assessment is sent. The command stays clickable
    // (with a spinner) rather than disabling itself mid-click.
    if (state.submitting) return;
    const errors = validateStep(4, state.values, unit, today, t);
    const payload = toAssessmentInput(state.values, unit);
    const parsed = assessmentInputBaseSchema.safeParse(payload);
    if (!parsed.success) {
      const structural: Record<string, string> = { ...errors };
      for (const issue of parsed.error.issues) {
        const path = issue.path.join('.');
        structural[path] ||= t('validation.required');
      }
      dispatch({ type: 'NEXT', step: state.step, fieldErrors: structural });
      focusFirstError(structural);
      return;
    }
    if (Object.keys(errors).length > 0) {
      dispatch({ type: 'NEXT', step: state.step, fieldErrors: errors });
      focusFirstError(errors);
      return;
    }

    dispatch({ type: 'SUBMIT_START' });
    try {
      const saved = await fetch('/api/fitness/assessment', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!saved.ok) {
        dispatch({ type: 'SUBMIT_ERROR', message: await errorMessage(saved, t) });
        return;
      }
      const body = (await saved.json()) as {
        assessment: { eligibility: { status: EligibilityStatus; reasonCodes: string[] } } | null;
      };
      if (!body.assessment) {
        dispatch({ type: 'SUBMIT_ERROR', message: t('actions.error') });
        return;
      }
      const { status, reasonCodes } = body.assessment.eligibility;
      if (status !== 'ELIGIBLE') {
        dispatch({
          type: 'SUBMIT_BLOCKED',
          status,
          reasons: reasonCodes,
          message: null,
        });
        return;
      }

      const preview = await fetch('/api/fitness/plans/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!preview.ok) {
        const failure = (await preview.json().catch(() => ({}))) as {
          error?: string;
          minimumDurationMin?: number;
        };
        if (failure.error === 'SESSION_DURATION_UNSATISFIABLE') {
          dispatch({
            type: 'SUBMIT_BLOCKED',
            status: null,
            reasons: [],
            message: t('actions.sessionDurationUnsatisfiable', {
              minutes: failure.minimumDurationMin ?? 30,
            }),
          });
          return;
        }
        if (failure.error === 'NUTRITION_MINIMUM_UNSATISFIABLE') {
          dispatch({
            type: 'SUBMIT_BLOCKED',
            status: null,
            reasons: [],
            message: t('actions.qualifiedNutritionReview'),
          });
          return;
        }
        dispatch({ type: 'SUBMIT_ERROR', message: await errorMessage(preview, t) });
        return;
      }
      const created = (await preview.json()) as { plan: { id: string } };
      dispatch({ type: 'SUBMIT_SUCCESS' });
      router.push(`/fitness/plans/${created.plan.id}/preview`);
    } catch {
      dispatch({ type: 'SUBMIT_ERROR', message: t('actions.error') });
    }
  }

  async function skipSetup() {
    try {
      await fetch('/api/fitness/onboarding/skip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      router.push('/chat');
    } catch {
      dispatch({ type: 'SUBMIT_ERROR', message: t('actions.error') });
    }
  }

  if (state.blocked) {
    return (
      <BlockedOutcome
        status={state.blocked.status}
        reasons={state.blocked.reasons}
        message={state.blocked.message}
        onEdit={() => dispatch({ type: 'BACK' })}
      />
    );
  }

  return (
    <form
      className="flex flex-col gap-5 pb-24"
      onSubmit={(event) => {
        // Enter must not submit before the final step.
        event.preventDefault();
        if (state.step === STEP_COUNT - 1) void submit();
        else goNext();
      }}
    >
      <ol className="flex gap-1.5" aria-label={t('assessment.title')}>
        {steps.map((name, index) => (
          <li
            key={name}
            aria-current={index === state.step ? 'step' : undefined}
            className={`h-1.5 flex-1 rounded-sm ${index <= state.step ? 'bg-primary' : 'bg-muted'}`}
            data-testid={`step-segment-${index}`}
          />
        ))}
      </ol>
      <div>
        <h2 className="text-lg font-semibold">{t(`assessment.steps.${stepName}.title`)}</h2>
        <p className="text-sm text-muted-foreground">
          {t(`assessment.steps.${stepName}.description`)}
        </p>
      </div>

      {state.transientError && (
        <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
          <AlertTriangle className="size-4" />
          {state.transientError}
        </p>
      )}

      {state.step === 0 && (
        <StepProfile
          values={state.values}
          set={set}
          field={field}
          describe={describe}
          errors={state.fieldErrors}
        />
      )}
      {state.step === 1 && (
        <StepGoal
          values={state.values}
          set={set}
          describe={describe}
          errors={state.fieldErrors}
          unit={unit}
        />
      )}
      {state.step === 2 && (
        <StepTraining
          values={state.values}
          set={set}
          unit={unit}
          describe={describe}
          errors={state.fieldErrors}
        />
      )}
      {state.step === 3 && (
        <StepLifestyle
          values={state.values}
          set={set}
          field={field}
          describe={describe}
          errors={state.fieldErrors}
        />
      )}
      {state.step === 4 && (
        <StepHealth
          values={state.values}
          set={set}
          dispatch={dispatch}
          describe={describe}
          errors={state.fieldErrors}
        />
      )}

      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-background/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
          <Button
            type="button"
            variant="outline"
            className="h-11"
            onClick={() => dispatch({ type: 'BACK' })}
            disabled={state.step === 0 || state.submitting}
          >
            {t('actions.back')}
          </Button>
          <div className="flex items-center gap-2">
            {onboardingRequired && (
              <Button
                type="button"
                variant="ghost"
                className="h-11"
                onClick={() => void skipSetup()}
              >
                {t('actions.skipForNow')}
              </Button>
            )}
            {state.step === STEP_COUNT - 1 ? (
              <Button type="submit" className="h-11">
                {state.submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
                {t('actions.generate')}
              </Button>
            ) : (
              <Button type="button" className="h-11" onClick={goNext}>
                {t('actions.next')}
              </Button>
            )}
          </div>
        </div>
      </div>
    </form>
  );
}

function domId(path: string): string {
  return `fitness-${path.replace(/\./g, '-')}`;
}

async function errorMessage(response: Response, t: (key: string) => string): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  const key = body.error === 'MANAGED_PROGRAM_IMMUTABLE' ? 'actions.managedProgramImmutable' : null;
  return key
    ? t(key)
    : body.error === 'ASSESSMENT_REQUIRED'
      ? t('actions.assessmentRequired')
      : t('actions.error');
}

type Setter = (path: string, value: unknown) => void;

function FieldError({ path, errors }: { path: string; errors: Record<string, string> }) {
  if (!errors[path]) return null;
  return (
    <p id={`${domId(path)}-error`} className="text-xs text-destructive">
      {errors[path]}
    </p>
  );
}

function NumberField({
  path,
  label,
  suffix,
  value,
  set,
  errors,
  describe,
}: {
  path: string;
  label: string;
  suffix?: string;
  value: string;
  set: Setter;
  errors: Record<string, string>;
  describe: (path: string) => string | undefined;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={domId(path)} className="text-sm">
        {label}
        {suffix ? <span className="ml-1 text-muted-foreground">({suffix})</span> : null}
      </Label>
      <Input
        id={domId(path)}
        inputMode="decimal"
        className="h-11"
        value={value}
        aria-invalid={errors[path] ? true : undefined}
        aria-describedby={describe(path)}
        onChange={(event) => set(path, event.target.value)}
      />
      <FieldError path={path} errors={errors} />
    </div>
  );
}

function TimeField({
  path,
  label,
  value,
  set,
  errors,
  describe,
}: {
  path: string;
  label: string;
  value: string;
  set: Setter;
  errors: Record<string, string>;
  describe: (path: string) => string | undefined;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={domId(path)} className="text-sm">
        {label}
      </Label>
      <Input
        id={domId(path)}
        type="time"
        className="h-11"
        value={value}
        aria-invalid={errors[path] ? true : undefined}
        aria-describedby={describe(path)}
        onChange={(event) => set(path, event.target.value)}
      />
      <FieldError path={path} errors={errors} />
    </div>
  );
}

function Choice<T extends string | number>({
  path,
  label,
  options,
  value,
  onChange,
  errors,
  describe,
  multiple,
}: {
  path: string;
  label: string;
  options: readonly { value: T; label: string }[];
  value: T | readonly T[];
  onChange: (next: T) => void;
  errors: Record<string, string>;
  describe: (path: string) => string | undefined;
  multiple?: boolean;
}) {
  const selected = Array.isArray(value) ? (value as readonly T[]) : null;
  return (
    <fieldset
      id={domId(path)}
      tabIndex={-1}
      className="flex flex-col gap-2"
      aria-invalid={errors[path] ? true : undefined}
      aria-describedby={describe(path)}
    >
      <legend className="text-sm font-medium">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => {
          const isSelected = multiple
            ? (selected ?? []).includes(option.value)
            : value === option.value;
          return (
            <button
              key={String(option.value)}
              type="button"
              aria-pressed={isSelected}
              className={`h-10 rounded-md border px-3 text-sm ${
                isSelected
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border text-muted-foreground'
              }`}
              onClick={() => onChange(option.value)}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      <FieldError path={path} errors={errors} />
    </fieldset>
  );
}

function StepProfile({
  values,
  set,
  field,
  describe,
  errors,
}: {
  values: Values;
  set: Setter;
  field: (path: string) => string;
  describe: (path: string) => string | undefined;
  errors: Record<string, string>;
}) {
  const t = useFitnessT();
  return (
    <div className="flex flex-col gap-4">
      <NumberField
        path="ageYears"
        label={field('ageYears')}
        value={values.ageYears}
        set={set}
        errors={errors}
        describe={describe}
      />
      <NumberField
        path="heightCm"
        label={field('heightCm')}
        suffix="cm"
        value={values.heightCm}
        set={set}
        errors={errors}
        describe={describe}
      />
      <NumberField
        path="weight"
        label={field('weightKg')}
        suffix="kg"
        value={values.weight}
        set={set}
        errors={errors}
        describe={describe}
      />
      <NumberField
        path="waistCm"
        label={field('waistCm')}
        suffix="cm"
        value={values.waistCm}
        set={set}
        errors={errors}
        describe={describe}
      />
      <NumberField
        path="bodyFatPct"
        label={field('bodyFatPct')}
        suffix="%"
        value={values.bodyFatPct}
        set={set}
        errors={errors}
        describe={describe}
      />
      <NumberField
        path="trainingAgeMonths"
        label={field('trainingAgeMonths')}
        suffix={t('assessment.units.months')}
        value={values.trainingAgeMonths}
        set={set}
        errors={errors}
        describe={describe}
      />
      <Choice
        path="displaySex"
        label={field('displaySex')}
        options={sexOptions.map((sex) => ({ value: sex, label: t(`assessment.sex.${sex}`) }))}
        value={values.displaySex}
        onChange={(next) => set('displaySex', next)}
        errors={errors}
        describe={describe}
      />
      <Choice
        path="energyEquationReference"
        label={field('energyEquationReference')}
        options={energyOptions.map((option) => ({
          value: option,
          label: t(`assessment.energyEquation.${option}`),
        }))}
        value={values.energyEquationReference}
        onChange={(next) => set('energyEquationReference', next)}
        errors={errors}
        describe={describe}
      />
      {values.energyEquationReference === 'UNSPECIFIED' && (
        <p className="text-xs text-muted-foreground">{t('notes.energyReferenceRange')}</p>
      )}
      <p className="text-xs text-muted-foreground">{t('notes.recentLiftsIndependent')}</p>
    </div>
  );
}

function StepGoal({
  values,
  set,
  describe,
  errors,
  unit,
}: {
  values: Values;
  set: Setter;
  describe: (path: string) => string | undefined;
  errors: Record<string, string>;
  unit: WeightUnit;
}) {
  const t = useFitnessT();
  const paired = values.goalType !== 'RECOMP';
  const pacePreview = describePace(t, {
    goalType: values.goalType,
    ratePct:
      numberOrNull(values.desiredWeeklyRatePct) ?? paceToRate(values.goalType, DEFAULT_PACE),
    weightKg: fromDisplayWeight(numberOrNull(values.weight) ?? 0, unit),
  });
  return (
    <div className="flex flex-col gap-4">
      <Choice
        path="goalType"
        label={t('assessment.fields.goalType')}
        options={goalOptions.map((goal) => ({
          value: goal,
          label: t(`assessment.goalTypes.${goal}`),
        }))}
        value={values.goalType}
        onChange={(next) => {
          set('goalType', next);
          const [minRate, maxRate] = rateRangeByGoal[next];
          const current = numberOrNull(values.desiredWeeklyRatePct);
          if (current === null || current < minRate || current > maxRate) {
            set('desiredWeeklyRatePct', String(defaultRateByGoal[next]));
          }
        }}
        errors={errors}
        describe={describe}
      />
      <div className="flex flex-col gap-1.5">
        <Choice
          path="desiredWeeklyRatePct"
          label={t('assessment.fields.pace')}
          options={PACE_ORDER.map((pace) => ({
            value: pace,
            label: t(`assessment.pace.${pace}`),
          }))}
          value={rateToPace(
            values.goalType,
            numberOrNull(values.desiredWeeklyRatePct) ?? paceToRate(values.goalType, DEFAULT_PACE),
          )}
          onChange={(next) =>
            set('desiredWeeklyRatePct', String(paceToRate(values.goalType, next)))
          }
          errors={errors}
          describe={describe}
        />
        <p className="text-xs text-muted-foreground">{pacePreview}</p>
        <FieldError path="desiredWeeklyRatePct" errors={errors} />
      </div>
      {paired && (
        <div className="flex flex-col gap-4 rounded-md border border-border p-3">
          <p className="text-xs text-muted-foreground">{t('validation.targetPair')}</p>
          <NumberField
            path="targetWeight"
            label={t('assessment.fields.targetWeightKg')}
            suffix={unitLabel(unit)}
            value={values.targetWeight}
            set={set}
            errors={errors}
            describe={describe}
          />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={domId('targetDate')} className="text-sm">
              {t('assessment.fields.targetDate')}
            </Label>
            <Input
              id={domId('targetDate')}
              type="date"
              className="h-11"
              value={values.targetDate}
              aria-invalid={errors.targetDate ? true : undefined}
              aria-describedby={describe('targetDate')}
              onChange={(event) => set('targetDate', event.target.value)}
            />
            <FieldError path="targetDate" errors={errors} />
          </div>
        </div>
      )}
    </div>
  );
}

function StepTraining({
  values,
  set,
  unit,
  describe,
  errors,
}: {
  values: Values;
  set: Setter;
  unit: WeightUnit;
  describe: (path: string) => string | undefined;
  errors: Record<string, string>;
}) {
  const t = useFitnessT();
  // Only catalog lifts the selected equipment can actually perform.
  const allowedLifts = STRENGTH_EXERCISE_CATALOG.filter(
    (entry) =>
      entry.equipmentType === 'BODYWEIGHT' || values.equipmentTypes.includes(entry.equipmentType),
  );

  return (
    <div className="flex flex-col gap-4">
      <Choice
        path="weeklyFrequency"
        label={t('assessment.fields.weeklyFrequency')}
        options={[2, 3, 4, 5].map((value) => ({ value, label: String(value) }))}
        value={values.weeklyFrequency}
        onChange={(next) => set('weeklyFrequency', next)}
        errors={errors}
        describe={describe}
      />
      <Choice
        path="availableWeekdays"
        label={t('assessment.fields.availableWeekdays')}
        multiple
        options={weekdayOptions.map((day) => ({
          value: day,
          label: t(`assessment.weekdays.${day}`),
        }))}
        value={values.availableWeekdays}
        onChange={(day) =>
          set(
            'availableWeekdays',
            values.availableWeekdays.includes(day)
              ? values.availableWeekdays.filter((item) => item !== day)
              : [...values.availableWeekdays, day].sort((a, b) => a - b),
          )
        }
        errors={errors}
        describe={describe}
      />
      <Choice
        path="equipmentTypes"
        label={t('assessment.fields.equipmentTypes')}
        multiple
        options={equipmentOptions.map((equipment) => ({
          value: equipment,
          label: t(`assessment.equipment.${equipment}`),
        }))}
        value={values.equipmentTypes}
        onChange={(equipment) =>
          set(
            'equipmentTypes',
            values.equipmentTypes.includes(equipment)
              ? values.equipmentTypes.filter((item) => item !== equipment)
              : [...values.equipmentTypes, equipment],
          )
        }
        errors={errors}
        describe={describe}
      />
      <NumberField
        path="sessionDurationMin"
        label={t('assessment.fields.sessionDurationMin')}
        suffix={t('assessment.units.minutes')}
        value={values.sessionDurationMin}
        set={set}
        errors={errors}
        describe={describe}
      />

      <section className="flex flex-col gap-3 rounded-md border border-border p-3">
        <div>
          <h3 className="text-sm font-medium">{t('assessment.recentLift.title')}</h3>
          <p className="text-xs text-muted-foreground">{t('assessment.recentLift.description')}</p>
          <p className="text-xs text-muted-foreground">{t('actions.calibrationAllowed')}</p>
        </div>
        {values.recentMainLifts.map((lift, index) => (
          <div key={`${lift.catalogKey}-${index}`} className="flex flex-wrap items-end gap-2">
            <div className="flex min-w-40 flex-1 flex-col gap-1">
              <Label htmlFor={domId(`recentMainLifts.${index}.catalogKey`)} className="text-xs">
                {t('assessment.recentLift.exercise')}
              </Label>
              <select
                id={domId(`recentMainLifts.${index}.catalogKey`)}
                className="h-10 rounded-md border border-input bg-background px-2 text-sm"
                value={lift.catalogKey}
                onChange={(event) => set(`recentMainLifts.${index}.catalogKey`, event.target.value)}
              >
                {allowedLifts.map((entry) => (
                  <option key={entry.key} value={entry.key}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </div>
            <NumberField
              path={`recentMainLifts.${index}.weight`}
              label={t('assessment.recentLift.load')}
              suffix={unitLabel(unit)}
              value={lift.weight}
              set={set}
              errors={errors}
              describe={describe}
            />
            <NumberField
              path={`recentMainLifts.${index}.reps`}
              label={t('assessment.recentLift.reps')}
              value={lift.reps}
              set={set}
              errors={errors}
              describe={describe}
            />
            <NumberField
              path={`recentMainLifts.${index}.rir`}
              label={t('assessment.recentLift.rir')}
              value={lift.rir}
              set={set}
              errors={errors}
              describe={describe}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-10"
              aria-label={t('actions.removeLift')}
              title={t('actions.removeLift')}
              onClick={() =>
                set(
                  'recentMainLifts',
                  values.recentMainLifts.filter((_, item) => item !== index),
                )
              }
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-10"
            disabled={values.recentMainLifts.length >= 6}
            onClick={() =>
              set('recentMainLifts', [
                ...values.recentMainLifts,
                {
                  catalogKey: allowedLifts[0]?.key ?? 'bench_press',
                  weight: '',
                  reps: '8',
                  rir: '2',
                },
              ])
            }
          >
            <Plus className="mr-2 size-4" />
            {t('actions.addLift')}
          </Button>
          <span className="text-xs text-muted-foreground">{t('actions.maxLifts')}</span>
        </div>
      </section>
      <p className="text-xs text-muted-foreground">{t('notes.strengthFirst')}</p>
    </div>
  );
}

function StepLifestyle({
  values,
  set,
  field,
  describe,
  errors,
}: {
  values: Values;
  set: Setter;
  field: (path: string) => string;
  describe: (path: string) => string | undefined;
  errors: Record<string, string>;
}) {
  const t = useFitnessT();
  return (
    <div className="flex flex-col gap-4">
      <Choice
        path="activityLevel"
        label={field('activityLevel')}
        options={activityOptions.map((level) => ({
          value: level,
          label: t(`assessment.activityLevels.${level}`),
        }))}
        value={values.activityLevel}
        onChange={(next) => set('activityLevel', next)}
        errors={errors}
        describe={describe}
      />
      <NumberField
        path="avgDailySteps"
        label={field('avgDailySteps')}
        suffix={t('assessment.units.stepsPerDay')}
        value={values.avgDailySteps}
        set={set}
        errors={errors}
        describe={describe}
      />
      <NumberField
        path="currentModerateActivityMin"
        label={field('currentModerateActivityMin')}
        suffix={t('assessment.units.minutes')}
        value={values.currentModerateActivityMin}
        set={set}
        errors={errors}
        describe={describe}
      />
      <TimeField
        path="habitualSleep"
        label={field('habitualSleepMin')}
        value={values.habitualSleep}
        set={set}
        errors={errors}
        describe={describe}
      />
      <TimeField
        path="bedtime"
        label={field('bedtimeMin')}
        value={values.bedtime}
        set={set}
        errors={errors}
        describe={describe}
      />
      <TimeField
        path="wakeTime"
        label={field('wakeTimeMin')}
        value={values.wakeTime}
        set={set}
        errors={errors}
        describe={describe}
      />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={domId('timeZone')} className="text-sm">
          {field('timeZone')}
        </Label>
        <Input
          id={domId('timeZone')}
          className="h-11"
          value={values.timeZone}
          aria-invalid={errors.timeZone ? true : undefined}
          aria-describedby={describe('timeZone')}
          onChange={(event) => set('timeZone', event.target.value)}
        />
        <FieldError path="timeZone" errors={errors} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={domId('softConstraints')} className="text-sm">
          {field('softConstraints')}
        </Label>
        <p className="text-xs text-muted-foreground">{field('softConstraintsHelp')}</p>
        <Textarea
          id={domId('softConstraints')}
          rows={3}
          maxLength={500}
          placeholder={field('softConstraintsPlaceholder')}
          value={values.softConstraints}
          aria-invalid={errors.softConstraints ? true : undefined}
          aria-describedby={describe('softConstraints')}
          onChange={(event) => set('softConstraints', event.target.value)}
        />
        <FieldError path="softConstraints" errors={errors} />
      </div>
    </div>
  );
}

function StepHealth({
  values,
  set,
  dispatch,
  describe,
  errors,
}: {
  values: Values;
  set: Setter;
  dispatch: (action: Action) => void;
  describe: (path: string) => string | undefined;
  errors: Record<string, string>;
}) {
  const t = useFitnessT();
  const groupTitle: Record<HealthGroup, string> = {
    urgent: t('assessment.health.urgentTitle'),
    clearance: t('assessment.health.clearanceTitle'),
    temporary: t('assessment.health.temporaryTitle'),
    scope: t('assessment.health.scopeTitle'),
  };
  const showClearanceFields =
    values.healthYes.clearance || values.endorsedClearance || values.clearanceSignals.length > 0;

  return (
    <div className="flex flex-col gap-5">
      {healthGroups.map((group) => (
        <fieldset key={group} className="flex flex-col gap-2 rounded-md border border-border p-3">
          <legend className="text-sm font-medium">{groupTitle[group]}</legend>
          <div className="flex gap-2">
            <button
              type="button"
              aria-pressed={values.healthYes[group]}
              className={`h-10 rounded-md border px-3 text-sm ${
                values.healthYes[group] ? 'border-primary bg-primary/10' : 'border-border'
              }`}
              onClick={() => dispatch({ type: 'SET_GROUP', group, yes: true })}
            >
              ✓
            </button>
            <button
              type="button"
              aria-pressed={!values.healthYes[group]}
              className={`h-10 rounded-md border px-3 text-sm ${
                !values.healthYes[group] ? 'border-primary bg-primary/10' : 'border-border'
              }`}
              onClick={() => dispatch({ type: 'SET_GROUP', group, yes: false })}
            >
              ✕
            </button>
          </div>
          {values.healthYes[group] && (
            <div className="flex flex-col gap-2">
              {signalValuesByGroup[group].map((signal) => {
                const key = signalKeyByGroup[group];
                const selected = (values[key] as string[]).includes(signal);
                return (
                  <label key={signal} className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={selected}
                      onChange={(event) =>
                        dispatch({
                          type: 'SET_SIGNAL',
                          group,
                          signal,
                          selected: event.target.checked,
                        })
                      }
                    />
                    <span>{t(`assessment.health.${group}.${signal}` as never)}</span>
                  </label>
                );
              })}
            </div>
          )}
        </fieldset>
      ))}

      {showClearanceFields && (
        <section className="flex flex-col gap-3 rounded-md border border-border p-3">
          <h3 className="text-sm font-medium">{t('assessment.health.clearanceTitleField')}</h3>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={domId('clearanceDate')} className="text-sm">
              {t('assessment.health.clearanceDate')}
            </Label>
            <Input
              id={domId('clearanceDate')}
              type="date"
              className="h-11"
              value={values.clearanceDate}
              aria-invalid={errors.clearanceDate ? true : undefined}
              aria-describedby={describe('clearanceDate')}
              onChange={(event) => set('clearanceDate', event.target.value)}
            />
            <FieldError path="clearanceDate" errors={errors} />
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id={domId('clearanceUnrestricted')}
              checked={values.clearanceUnrestricted}
              onCheckedChange={(checked) => set('clearanceUnrestricted', checked)}
            />
            <Label htmlFor={domId('clearanceUnrestricted')} className="text-sm">
              {t('assessment.health.clearanceUnrestricted')}
            </Label>
          </div>
          {!values.clearanceUnrestricted && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={domId('clearanceRestrictions')} className="text-sm">
                {t('assessment.health.clearanceRestrictions')}
              </Label>
              <Input
                id={domId('clearanceRestrictions')}
                className="h-11"
                value={values.clearanceRestrictions}
                aria-invalid={errors.clearanceRestrictions ? true : undefined}
                aria-describedby={describe('clearanceRestrictions')}
                onChange={(event) => set('clearanceRestrictions', event.target.value)}
              />
              <FieldError path="clearanceRestrictions" errors={errors} />
            </div>
          )}
        </section>
      )}

      <div className="flex items-center gap-2">
        <Switch
          id={domId('healthChangedSinceClearance')}
          checked={values.healthChangedSinceClearance}
          onCheckedChange={(checked) => set('healthChangedSinceClearance', checked)}
        />
        <Label htmlFor={domId('healthChangedSinceClearance')} className="text-sm">
          {t('assessment.health.healthChanged')}
        </Label>
      </div>

      <div className="flex flex-col gap-1">
        <button
          type="button"
          role="checkbox"
          id={domId('attested')}
          aria-checked={values.attested}
          aria-invalid={errors.attested ? true : undefined}
          aria-describedby={describe('attested')}
          className={`flex items-start gap-2 rounded-md border p-3 text-left text-sm ${
            values.attested ? 'border-primary bg-primary/10' : 'border-border'
          }`}
          onClick={() => set('attested', !values.attested)}
        >
          <ShieldCheck className="mt-0.5 size-4 shrink-0" />
          <span>{t('assessment.health.attested')}</span>
        </button>
        <FieldError path="attested" errors={errors} />
        <p className="text-xs text-muted-foreground">{t('disclaimer')}</p>
      </div>
    </div>
  );
}

function BlockedOutcome({
  status,
  reasons,
  message,
  onEdit,
}: {
  status: EligibilityStatus | null;
  reasons: string[];
  message: string | null;
  onEdit: () => void;
}) {
  const t = useFitnessT();
  return (
    <section
      role="alert"
      className="flex flex-col gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-4"
    >
      <p className="flex items-center gap-2 font-medium">
        <AlertTriangle className="size-4 text-destructive" />
        {status ? t(`eligibility.statuses.${status}.title`) : t('eligibility.title')}
      </p>
      <p className="text-sm">
        {message ?? (status ? t(`eligibility.statuses.${status}.action`) : t('actions.error'))}
      </p>
      {reasons.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
          {reasons.map((reason) => (
            <li key={reason}>
              {t(`reasons.${reason}.title` as never)} — {t(`reasons.${reason}.body` as never)}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">{t('disclaimer')}</p>
      <div>
        <Button type="button" variant="outline" className="h-11" onClick={onEdit}>
          {t('actions.editAssessment')}
        </Button>
      </div>
    </section>
  );
}
