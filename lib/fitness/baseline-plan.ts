import type { EligibilityStatus } from './schemas';
import type { EligibilityReasonCode, AssessmentInput } from './schemas';
import type { EligibilityDecision } from './eligibility';
import type { InitialLoadGuidance } from './load-evidence';

import { createCardioPrescription } from './cardio-prescription';
import { exerciseCatalogKeys, type ExerciseCatalogKey } from './exercise-keys';
import { calculateNutritionPrescription } from './energy';
import { evaluateGoalFeasibility, type GoalFeasibility } from './goal-feasibility';
import { buildStrengthPlan } from './strength-plan';
import { createSleepPrescription } from './sleep-prescription';
import { buildMealPlan } from './meal-plan';
import { fitnessPlanContentSchema, type FitnessPlanContent } from './plan-schema';
import { NEUTRAL_STRATEGY, type PlanStrategy } from './plan-strategy';
import { STRENGTH_EXERCISE_CATALOG } from './exercise-catalog';
import { FITNESS_PLAN_SCHEMA_VERSION, FITNESS_RULES_VERSION } from './versions';
import { localCalendarDate } from './time-zone';

export type BaselinePlanInput = {
  assessment: AssessmentInput;
  eligibility: EligibilityDecision;
  gymConstraints: { unavailableExerciseNames: string[] };
  loadGuidance: InitialLoadGuidance[];
  now: Date;
  // Model-owned strategy, already validated and bounded. Absent means the
  // neutral strategy, which is exactly the plan this generator produced before
  // the strategy existed.
  strategy?: PlanStrategy;
};

export class BaselinePlanEligibilityError extends Error {
  readonly code = 'BASELINE_PLAN_NOT_ELIGIBLE' as const;

  constructor(readonly status: EligibilityStatus) {
    super(`Only ELIGIBLE assessments produce a baseline plan (received ${status}).`);
    this.name = 'BaselinePlanEligibilityError';
  }
}

export class BaselinePlanEvidenceError extends Error {
  readonly code = 'BASELINE_PLAN_LOAD_EVIDENCE_MISSING' as const;

  constructor(readonly catalogKey: string) {
    super(`No load guidance was supplied for the selected exercise ${catalogKey}.`);
    this.name = 'BaselinePlanEvidenceError';
  }
}

const catalogKeySet = new Set<string>(exerciseCatalogKeys);
const catalogNotePrefix = 'catalog:';

// Pure composition: no database, clock, locale, environment, agent or network
// access. Everything the plan needs arrives in `input`.
export function buildBaselinePlan(input: BaselinePlanInput): FitnessPlanContent {
  if (input.eligibility.status !== 'ELIGIBLE') {
    throw new BaselinePlanEligibilityError(input.eligibility.status);
  }

  const { assessment } = input;
  const strategy = input.strategy ?? NEUTRAL_STRATEGY;
  const calculationDate = localCalendarDate(input.now, assessment.lifestyle.timeZone);

  // An avoided movement is just another unavailable one: the strategy cannot
  // introduce an exercise the equipment check would not have allowed anyway.
  const catalogNameByKey = new Map(
    STRENGTH_EXERCISE_CATALOG.map((entry) => [entry.key, entry.name] as const),
  );
  const unavailableExerciseNames = [
    ...input.gymConstraints.unavailableExerciseNames,
    ...strategy.avoidCatalogKeys.flatMap((key) => {
      const name = catalogNameByKey.get(key);
      return name ? [name] : [];
    }),
  ];
  const preferredExerciseNames = strategy.preferCatalogKeys.flatMap((key) => {
    const name = catalogNameByKey.get(key);
    return name ? [name] : [];
  });

  // Strength first: cardio placement needs to know which days carry heavy
  // lower-body demand before it picks its own days.
  const strength = buildStrengthPlan({
    trainingAgeMonths: assessment.profile.trainingAgeMonths,
    weeklyFrequency: assessment.schedule.weeklyFrequency,
    availableWeekdays: assessment.schedule.availableWeekdays,
    sessionDurationMin: assessment.schedule.sessionDurationMin,
    equipmentTypes: assessment.schedule.equipmentTypes,
    unavailableExerciseNames,
    preferredExerciseNames,
  });

  const selectedCatalogKeys = collectSelectedCatalogKeys(strength.days);
  const loadGuidance = resolveLoadGuidance(selectedCatalogKeys, input.loadGuidance);

  const feasibility = evaluateGoalFeasibility({
    currentWeightKg: assessment.profile.weightKg,
    goalType: assessment.goal.type,
    targetWeightKg: assessment.goal.targetWeightKg,
    targetDate: assessment.goal.targetDate,
    calculationDate,
  });

  const energy = calculateNutritionPrescription({
    weightKg: assessment.profile.weightKg,
    heightCm: assessment.profile.heightCm,
    ageYears: assessment.profile.ageYears,
    energyEquationReference: assessment.profile.energyEquationReference,
    activityLevel: assessment.lifestyle.activityLevel,
    goalType: assessment.goal.type,
    desiredWeeklyRatePct: assessment.goal.desiredWeeklyRatePct,
  });

  const cardio = createCardioPrescription({
    currentModerateActivityMin: assessment.lifestyle.currentModerateActivityMin,
    preference: strategy.cardioPreference,
    strengthDays: strength.days.map((day) => ({
      dayOfWeek: requireWeekday(day.dayOfWeek),
      lowerBodyDemand: day.lowerBodyDemand,
    })),
  });

  const sleep = createSleepPrescription({
    habitualSleepMin: assessment.lifestyle.habitualSleepMin,
    wakeTimeMin: assessment.lifestyle.wakeTimeMin,
  });

  const schedule = buildSchedule(strength.days, cardio.sessions);

  const draft = {
    schemaVersion: FITNESS_PLAN_SCHEMA_VERSION,
    rulesVersion: FITNESS_RULES_VERSION,
    goal: {
      type: assessment.goal.type,
      desiredWeeklyRatePct: assessment.goal.desiredWeeklyRatePct,
      feasibility: {
        status: feasibility.status,
        earliestDate: feasibility.earliestDate,
        latestDate: feasibility.latestDate,
        targetDate: feasibility.targetDate,
      },
    },
    strength: {
      split: strength.split,
      weeklyTargetSets: strength.weeklyTargetSets,
      introRir: strength.introRir,
      introDurationDays: strength.introDurationDays,
      steadyRir: strength.steadyRir,
      achievedSetsByMuscleGroup: strength.achievedSetsByMuscleGroup,
      days: strength.days,
    },
    loadGuidance,
    nutrition: {
      caloriesKcal: energy.targetCalories,
      proteinG: energy.proteinGrams,
      fatG: energy.fatGrams,
      carbsG: energy.carbohydrateGrams,
      meals: buildMealPlan({
        caloriesKcal: energy.targetCalories,
        proteinG: energy.proteinGrams,
        carbsG: energy.carbohydrateGrams,
        fatG: energy.fatGrams,
      }),
    },
    cardio: {
      additionalWeeklyMin: cardio.additionalWeeklyMin,
      sessions: cardio.sessions,
    },
    // The sleep prescription's own reason codes belong to the merged list, not
    // to the stored timing block.
    sleep: {
      longTermMin: sleep.longTermMin,
      longTermMax: sleep.longTermMax,
      initialTargetMin: sleep.initialTargetMin,
      initialTargetMax: sleep.initialTargetMax,
      suggestedBedtimeMin: sleep.suggestedBedtimeMin,
      wakeTimeMin: sleep.wakeTimeMin,
    },
    schedule: { days: schedule },
    reasons: deduplicateReasons([
      input.eligibility.reasonCodes,
      feasibilityReasons(feasibility),
      strength.reasons,
      loadReasonCodes(loadGuidance),
      energy.reasons,
      cardio.reasons,
      sleep.reasons,
    ]),
  };

  return fitnessPlanContentSchema.parse(draft);
}

function feasibilityReasons(feasibility: GoalFeasibility): EligibilityReasonCode[] {
  return feasibility.reasons;
}

function loadReasonCodes(guidance: readonly InitialLoadGuidance[]): EligibilityReasonCode[] {
  return guidance.map((entry) =>
    entry.source === 'APP_HISTORY'
      ? 'LOAD_APP_HISTORY'
      : entry.source === 'USER_REPORTED'
        ? 'LOAD_USER_REPORTED'
        : 'LOAD_CALIBRATION_REQUIRED',
  );
}

// Subsystem order: eligibility, goal, strength, load, nutrition, cardio, sleep.
// Duplicates collapse onto their first occurrence so the stored list is stable.
function deduplicateReasons(groups: readonly (readonly EligibilityReasonCode[])[]) {
  const seen = new Set<EligibilityReasonCode>();
  const reasons: EligibilityReasonCode[] = [];
  for (const group of groups) {
    for (const reason of group) {
      if (seen.has(reason)) continue;
      seen.add(reason);
      reasons.push(reason);
    }
  }
  return reasons;
}

// The catalog key lives in the exercise notes so a stored plan stays readable
// without an extra database relation. Anything else is not a catalog exercise.
function collectSelectedCatalogKeys(
  days: readonly { exercises: readonly { notes?: string | null }[] }[],
): ExerciseCatalogKey[] {
  const keys = new Set<ExerciseCatalogKey>();
  for (const day of days) {
    for (const exercise of day.exercises) {
      const note = exercise.notes;
      if (!note || !note.startsWith(catalogNotePrefix)) continue;
      const key = note.slice(catalogNotePrefix.length);
      if (catalogKeySet.has(key)) keys.add(key as ExerciseCatalogKey);
    }
  }
  return [...keys];
}

function resolveLoadGuidance(
  selectedKeys: readonly ExerciseCatalogKey[],
  supplied: readonly InitialLoadGuidance[],
): InitialLoadGuidance[] {
  const byKey = new Map(supplied.map((entry) => [entry.catalogKey, entry]));
  return selectedKeys.map((catalogKey) => {
    const match = byKey.get(catalogKey);
    if (!match) throw new BaselinePlanEvidenceError(catalogKey);
    return { ...match };
  });
}

function buildSchedule(
  strengthDays: readonly { dayOfWeek?: number | null }[],
  cardioSessions: readonly { dayOfWeek: number; durationMin: number }[],
) {
  const strengthIndexByWeekday = new Map<number, number>();
  strengthDays.forEach((day, index) => {
    strengthIndexByWeekday.set(requireWeekday(day.dayOfWeek), index);
  });
  const cardioMinutesByWeekday = new Map<number, number>();
  for (const session of cardioSessions) {
    cardioMinutesByWeekday.set(
      session.dayOfWeek,
      (cardioMinutesByWeekday.get(session.dayOfWeek) ?? 0) + session.durationMin,
    );
  }

  return [1, 2, 3, 4, 5, 6, 7].map((dayOfWeek) => {
    const strengthDayIndex = strengthIndexByWeekday.get(dayOfWeek) ?? null;
    const cardioMin = cardioMinutesByWeekday.get(dayOfWeek) ?? 0;
    const kind =
      strengthDayIndex !== null
        ? cardioMin > 0
          ? ('STRENGTH_AND_CARDIO' as const)
          : ('STRENGTH' as const)
        : cardioMin > 0
          ? ('CARDIO' as const)
          : ('REST' as const);
    return { dayOfWeek, kind, strengthDayIndex, cardioMin };
  });
}

function requireWeekday(dayOfWeek: number | null | undefined): number {
  if (dayOfWeek == null) {
    throw new RangeError('Every planned training day must have a weekday');
  }
  return dayOfWeek;
}
