import { Prisma } from '@/prisma/generated/client';
import { db } from '@/lib/db';
import { hashAuditValue } from '@/lib/agent/audit-hash';
import { ApiError } from '@/lib/api';

import { buildBaselinePlan } from './baseline-plan';
import { evaluateEligibility, type EligibilityDecision } from './eligibility';
import { STRENGTH_EXERCISE_CATALOG } from './exercise-catalog';
import { NutritionConstraintError } from './energy';
import { getInitialLoadGuidance, type InitialLoadGuidance } from './load-evidence';
import { StrengthPlanConstraintError } from './strength-plan';
import { parseFitnessPlanContent, type FitnessPlanContent } from './plan-schema';
import { parseStrategy, type PlanStrategy } from './plan-strategy';
import { describeEnergy, type PlainLanguageEnergy } from './pace';
import { calculateNutritionPrescription } from './energy';
import {
  assessmentHeightCmSchema,
  assessmentWeightKgSchema,
  assessmentWaistCmSchema,
  createAssessmentInputSchema,
  healthAnswersSchema,
  type AssessmentInput,
} from './schemas';
import { lockFitnessUser } from './user-lock';
import { FITNESS_RULES_VERSION } from './versions';
import { localCalendarDate } from './time-zone';

const HISTORY_LIMIT = 50;

export type FitnessPlanComparisonMetric =
  | 'STRENGTH_FREQUENCY'
  | 'STRENGTH_SPLIT'
  | 'TRAINING_DAYS'
  | 'WEEKLY_TARGET_SETS'
  | 'EXERCISE_SELECTION'
  | 'CALORIES'
  | 'PROTEIN'
  | 'CARDIO_MINUTES'
  | 'SLEEP_TARGET';

export type FitnessPlanComparison = {
  previousPlanId: string;
  changes: Array<{
    metric: FitnessPlanComparisonMetric;
    before: number | string | { min: number; max: number } | number[] | string[];
    after: number | string | { min: number; max: number } | number[] | string[];
  }>;
};

export type FitnessPlanView = {
  id: string;
  version: number;
  status: string;
  rulesVersion: string;
  content: FitnessPlanContent;
  // The strategy the content was built with, or null for a neutral plan.
  strategy: PlanStrategy | null;
  // The same targets said in plain language: how much the trainee changes per
  // month and what the daily difference is worth in food. Null when the stored
  // input cannot be read.
  energy: PlainLanguageEnergy | null;
  comparison: FitnessPlanComparison | null;
  createdAt: string;
  activatedAt: string | null;
  programId: string | null;
};

export type FitnessPlanSummary = {
  id: string;
  version: number;
  status: string;
  goal: { type: string; desiredWeeklyRatePct: number };
  createdAt: string;
  activatedAt: string | null;
  programId: string | null;
};

export type CreateOrReuseDraftResult = {
  plan: FitnessPlanView;
  created: boolean;
  activationRevision: number;
};

// The stored calculation input. Display name and clearance free text are
// deliberately absent: they never influence the prescribed plan, and keeping
// them out means an unchanged plan keeps reusing its draft after the user edits
// only those fields.
export type PersistedCalculationInput = {
  weeklyReview?: {
    activities: { weekStart: string; activities: import('./weekly-activities').WeeklyActivity[] };
    strategy: import('./weekly-strategy').WeeklyStrategy;
  };
  rulesVersion: string;
  calculationDate: string;
  assessment: AssessmentInput;
  eligibility: {
    status: string;
    reasonCodes: string[];
    clearanceExpiresAt: string | null;
  };
  gymConstraints: { unavailableExerciseNames: string[] };
  loadGuidance: InitialLoadGuidance[];
};

export async function createOrReuseDraft(
  userId: string,
  now: Date = new Date(),
): Promise<CreateOrReuseDraftResult> {
  if (Number.isNaN(now.getTime())) throw new RangeError('now must be a valid date');
  const capturedNow = new Date(now.getTime());

  return db.$transaction(async (tx) => {
    // First statement: serialize concurrent previews for this user so version
    // allocation cannot race. P2002 retry loops are deliberately not used.
    await lockFitnessUser(tx, userId);

    const state = await loadCalculationState(tx, userId, capturedNow);
    const calculationInput = buildPersistedCalculationInput(
      state,
      localCalendarDate(capturedNow, state.assessment.lifestyle.timeZone),
    );
    const inputHash = hashAuditValue(calculationInput);

    const reusable = await tx.fitnessPlanVersion.findFirst({
      where: { userId, status: 'DRAFT', inputHash },
      orderBy: { version: 'desc' },
    });
    if (reusable) {
      return {
        plan: await toPlanView(reusable, state.activePlan),
        created: false,
        activationRevision: state.activationRevision,
      };
    }

    const version = await nextVersion(tx, userId);
    // Two domain constraints are user-actionable rather than server faults, so
    // they leave the API as a stable 422 the wizard can explain: the split
    // cannot fit the session length, or the calorie target cannot hold the
    // required protein and minimum fat.
    const content = translatePlanConstraint(() =>
      buildBaselinePlan({
        assessment: calculationInput.assessment,
        eligibility: state.eligibility,
        gymConstraints: calculationInput.gymConstraints,
        loadGuidance: calculationInput.loadGuidance,
        now: capturedNow,
      }),
    );

    await tx.fitnessPlanVersion.updateMany({
      where: { userId, status: 'DRAFT' },
      data: { status: 'SUPERSEDED' },
    });
    const created = await tx.fitnessPlanVersion.create({
      data: {
        userId,
        profileId: state.profileId,
        healthScreeningId: state.screeningId,
        goalId: state.goalId,
        version,
        status: 'DRAFT',
        rulesVersion: FITNESS_RULES_VERSION,
        inputHash,
        profileUpdatedAt: state.profileUpdatedAt,
        input: calculationInput as unknown as Prisma.InputJsonValue,
        content: content as unknown as Prisma.InputJsonValue,
      },
    });

    return {
      plan: await toPlanView(created, state.activePlan),
      created: true,
      activationRevision: state.activationRevision,
    };
  });
}

// A change to an existing plan is a new version of it, never an edit: the
// trainee keeps the plan they confirmed, and the replacement goes through the
// same activation path (and therefore the same staleness check) as any other.
//
// The calculation input is copied verbatim on purpose. The assessment did not
// change - only the prescription did - so the input hash that proves the plan
// is still fresh must stay exactly as it was.
export async function createDerivedPlanVersion(input: {
  userId: string;
  basePlanId: string;
  content: FitnessPlanContent;
  // The calculation input to store with the new version. Omitted for a plan
  // change, which leaves the assessment untouched and copies the base's input
  // verbatim; a weekly review passes the assessment it adjusted. Either way the
  // stored hash is the freshness contract against the trainee's saved answers.
  storedInput?: PersistedCalculationInput;
  // Re-stamps the freshness hash. A plan change keeps the base's hash (the
  // answers did not move); a weekly review passes a hash of the state it just
  // read, because it deliberately re-anchors the plan to the current bodyweight
  // and load evidence - facts that would otherwise make its own version look
  // stale the moment it was written.
  inputHash?: string;
  strategy?: PlanStrategy;
  weeklyActivities?: { weekStart: string; activities: unknown[] };
}): Promise<{ id: string; version: number }> {
  return db.$transaction(async (tx) => {
    await lockFitnessUser(tx, input.userId);

    const base = await tx.fitnessPlanVersion.findFirst({
      where: { id: input.basePlanId, userId: input.userId },
      select: {
        id: true,
        profileId: true,
        healthScreeningId: true,
        goalId: true,
        rulesVersion: true,
        inputHash: true,
        profileUpdatedAt: true,
        input: true,
        strategy: true,
      },
    });
    if (!base) throw new ApiError(404, 'Not found.');

    if (input.weeklyActivities) {
      const active = await tx.fitnessPlanVersion.findFirst({
        where: { userId: input.userId, status: 'ACTIVE' },
        select: { id: true },
      });
      const activities = await tx.fitnessWeeklyActivities.findUnique({
        where: {
          userId_weekStart: { userId: input.userId, weekStart: input.weeklyActivities.weekStart },
        },
      });
      if (
        active?.id !== base.id ||
        hashAuditValue(activities?.activities ?? []) !==
          hashAuditValue(input.weeklyActivities.activities)
      )
        throw new ApiError(409, 'WEEKLY_REVIEW_STALE');
    }

    const version = await nextVersion(tx, input.userId);
    await tx.fitnessPlanVersion.updateMany({
      where: { userId: input.userId, status: 'DRAFT' },
      data: { status: 'SUPERSEDED' },
    });

    return tx.fitnessPlanVersion.create({
      data: {
        userId: input.userId,
        profileId: base.profileId,
        healthScreeningId: base.healthScreeningId,
        goalId: base.goalId,
        version,
        status: 'DRAFT',
        rulesVersion: base.rulesVersion,
        inputHash: input.inputHash ?? base.inputHash,
        profileUpdatedAt: base.profileUpdatedAt,
        input: (input.storedInput ?? base.input) as unknown as Prisma.InputJsonValue,
        content: input.content as unknown as Prisma.InputJsonValue,
        // A derived version keeps the strategy that shaped the plan it came
        // from: the rationale and the model's exercise preferences belong to
        // the trainee's plan, not to the one version of it.
        strategy: input.strategy
          ? (input.strategy as unknown as Prisma.InputJsonValue)
          : base.strategy === null
            ? Prisma.DbNull
            : (base.strategy as Prisma.InputJsonValue),
      },
      select: { id: true, version: true },
    });
  });
}

function translatePlanConstraint<T>(build: () => T): T {
  try {
    return build();
  } catch (error) {
    if (error instanceof StrengthPlanConstraintError) {
      throw new ApiError(422, error.code, { minimumDurationMin: error.minimumDurationMin });
    }
    if (error instanceof NutritionConstraintError) {
      throw new ApiError(422, error.code);
    }
    throw error;
  }
}

export async function getFitnessPlan(
  userId: string,
  planId: string,
): Promise<{ plan: FitnessPlanView; activationRevision: number } | null> {
  const [version, activation] = await Promise.all([
    db.fitnessPlanVersion.findFirst({ where: { id: planId, userId } }),
    db.fitnessPlanActivation.findUnique({
      where: { userId },
      select: { revision: true, planVersion: true },
    }),
  ]);
  if (!version) return null;

  // Comparison is always derived from immutable snapshots on read, so it is
  // never duplicated into the stored content.
  return {
    plan: await toPlanView(version, activation?.planVersion ?? null),
    activationRevision: activation?.revision ?? 0,
  };
}

export async function listFitnessPlans(userId: string): Promise<FitnessPlanSummary[]> {
  const versions = await db.fitnessPlanVersion.findMany({
    where: { userId },
    orderBy: { version: 'desc' },
    take: HISTORY_LIMIT,
    select: {
      id: true,
      version: true,
      status: true,
      goal: { select: { type: true, desiredWeeklyRatePct: true } },
      createdAt: true,
      activatedAt: true,
      programId: true,
    },
  });
  // No health JSON and no calculation input: the history view is identity and
  // status metadata only.
  return versions.map((version) => ({
    id: version.id,
    version: version.version,
    status: version.status,
    goal: { type: version.goal.type, desiredWeeklyRatePct: version.goal.desiredWeeklyRatePct },
    createdAt: version.createdAt.toISOString(),
    activatedAt: version.activatedAt?.toISOString() ?? null,
    programId: version.programId,
  }));
}

type PlanVersionRow = {
  id: string;
  version: number;
  status: string;
  rulesVersion: string;
  content: unknown;
  strategy: unknown;
  input: unknown;
  createdAt: Date;
  activatedAt: Date | null;
  programId: string | null;
};

async function toPlanView(
  version: PlanVersionRow,
  activePlan: PlanVersionRow | null,
): Promise<FitnessPlanView> {
  // Re-validate on every read: a payload that no longer satisfies the rules is
  // corrupt and must surface as a controlled failure, never as a partial plan.
  const content = parseFitnessPlanContent(version.content);
  return {
    id: version.id,
    version: version.version,
    status: version.status,
    rulesVersion: version.rulesVersion,
    content,
    strategy: version.strategy === null ? null : parseStrategy(version.strategy),
    energy: energySummary(version, content),
    comparison:
      activePlan && activePlan.id !== version.id
        ? compareContents(activePlan, parseFitnessPlanContent(activePlan.content), content)
        : null,
    createdAt: version.createdAt.toISOString(),
    activatedAt: version.activatedAt?.toISOString() ?? null,
    programId: version.programId,
  };
}

// Turns the stored calculation input and the computed target into the sentence
// the trainee actually reads. Pure, and deliberately tolerant: a row whose
// input no longer parses still renders a plan, just without the summary.
function energySummary(
  version: PlanVersionRow,
  content: FitnessPlanContent,
): PlainLanguageEnergy | null {
  try {
    const stored = version.input as unknown as PersistedCalculationInput;
    const assessment = stored.assessment;
    const energy = calculateNutritionPrescription({
      weightKg: assessment.profile.weightKg,
      heightCm: assessment.profile.heightCm,
      ageYears: assessment.profile.ageYears,
      energyEquationReference: assessment.profile.energyEquationReference,
      activityLevel: assessment.lifestyle.activityLevel,
      goalType: assessment.goal.type,
      desiredWeeklyRatePct: assessment.goal.desiredWeeklyRatePct,
    });
    const midpoint = (range: { min: number; max: number }) => (range.min + range.max) / 2;
    return describeEnergy({
      goalType: assessment.goal.type,
      ratePct: assessment.goal.desiredWeeklyRatePct,
      weightKg: assessment.profile.weightKg,
      maintenanceKcal: midpoint(energy.tdeeCalories),
      targetKcal: midpoint(content.nutrition.caloriesKcal),
    });
  } catch {
    return null;
  }
}

export type FitnessCalculationState = {
  profileId: string;
  profileUpdatedAt: Date;
  screeningId: string;
  goalId: string;
  assessment: AssessmentInput;
  eligibility: EligibilityDecision;
  gymConstraints: { unavailableExerciseNames: string[] };
  loadGuidance: InitialLoadGuidance[];
  activePlan: PlanVersionRow | null;
  activationRevision: number;
};

export async function loadCalculationState(
  tx: Prisma.TransactionClient,
  userId: string,
  now: Date,
  // Assessment-level date validation (target date in the future, clearance not
  // in the future) is anchored to the preview's own date during activation so
  // that crossing midnight alone does not invalidate a fresh preview.
  parseInstant: Date = now,
): Promise<FitnessCalculationState> {
  // Sequential on purpose: one interactive transaction owns a single database
  // connection, so issuing these reads concurrently only queues them behind
  // each other while risking driver-level pipelining warnings.
  const user = await tx.user.findUniqueOrThrow({
    where: { id: userId },
    select: { heightCm: true, bodyweight: true, activeGymId: true },
  });
  const profile = await tx.fitnessProfile.findUnique({ where: { userId } });
  const screening = await tx.healthScreening.findFirst({
    where: { userId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  const goal = await tx.fitnessGoal.findFirst({
    where: { userId, status: 'ACTIVE' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  const bodyweight = await tx.bodyweightEntry.findFirst({
    where: { userId },
    orderBy: [{ measuredAt: 'desc' }, { id: 'desc' }],
    select: { weightKg: true },
  });
  const waist = await tx.bodyMeasurement.findFirst({
    where: { userId, site: 'WAIST' },
    orderBy: [{ measuredAt: 'desc' }, { id: 'desc' }],
    select: { valueCm: true },
  });
  const activation = await tx.fitnessPlanActivation.findUnique({
    where: { userId },
    select: { revision: true, planVersionId: true, planVersion: true },
  });

  if (!profile || !screening || !goal) {
    throw new ApiError(409, 'ASSESSMENT_REQUIRED');
  }

  const heightCm = assessmentHeightCmSchema.safeParse(user.heightCm);
  const weightKg = assessmentWeightKgSchema.safeParse(bodyweight?.weightKg ?? user.bodyweight);
  if (!heightCm.success || !weightKg.success) {
    throw new ApiError(409, 'ASSESSMENT_REQUIRED');
  }

  const answers = healthAnswersSchema.parse(screening.answers);
  const clearance = clearanceFromScreening(screening);
  const waistCm = assessmentWaistCmSchema.safeParse(waist?.valueCm);
  const assessment = createAssessmentInputSchema(parseInstant).parse({
    profile: {
      ageYears: profile.ageYears,
      displaySex: profile.displaySex,
      energyEquationReference: profile.energyEquationReference,
      heightCm: heightCm.data,
      weightKg: weightKg.data,
      waistCm: waistCm.success ? waistCm.data : undefined,
      bodyFatPct: profile.bodyFatPct ?? undefined,
      trainingAgeMonths: profile.trainingAgeMonths,
    },
    goal: {
      type: goal.type,
      desiredWeeklyRatePct: goal.desiredWeeklyRatePct,
      targetWeightKg: goal.targetWeightKg ?? undefined,
      targetDate: goal.targetDate ? goal.targetDate.toISOString().slice(0, 10) : undefined,
    },
    schedule: {
      weeklyFrequency: profile.weeklyFrequency,
      availableWeekdays: profile.availableWeekdays,
      sessionDurationMin: profile.sessionDurationMin,
      equipmentTypes: profile.equipmentTypes,
      recentMainLifts: profile.recentMainLifts,
    },
    lifestyle: {
      activityLevel: profile.activityLevel,
      avgDailySteps: profile.avgDailySteps ?? undefined,
      currentModerateActivityMin: profile.currentModerateActivityMin,
      habitualSleepMin: profile.habitualSleepMin,
      bedtimeMin: profile.bedtimeMin,
      wakeTimeMin: profile.wakeTimeMin,
      timeZone: profile.timeZone,
    },
    ...(profile.softConstraints === null ? {} : { softConstraints: profile.softConstraints }),
    health: {
      urgentSignals: answers.urgentSignals,
      clearanceSignals: answers.clearanceSignals,
      temporarySignals: answers.temporarySignals,
      scopeSignals: answers.scopeSignals,
      healthChangedSinceClearance: answers.healthChangedSinceClearance,
      clearance,
      attested: true,
    },
  } as AssessmentInput);

  // Eligibility is re-evaluated at `now`: an expired clearance or a health
  // change must block plan generation even when the stored screening was
  // ELIGIBLE when it was written.
  const eligibility = evaluateEligibility(assessment, now);
  if (eligibility.status !== 'ELIGIBLE') {
    throw new ApiError(409, 'FITNESS_NOT_ELIGIBLE', {
      eligibilityStatus: eligibility.status,
      reasonCodes: eligibility.reasonCodes,
    });
  }

  const unavailableExerciseNames = await loadUnavailableExerciseNames(tx, userId, user.activeGymId);
  const loadGuidance = await getInitialLoadGuidance(tx, {
    userId,
    catalogExercises: strengthCatalog,
    recentMainLifts: assessment.schedule.recentMainLifts,
    now,
  });

  const activePlan = activation?.planVersion ?? null;
  if (activation?.planVersionId && (!activePlan || activePlan.status !== 'ACTIVE')) {
    throw new Error('Fitness plan activation points at a plan that is not ACTIVE');
  }

  return {
    profileId: profile.id,
    profileUpdatedAt: profile.updatedAt,
    screeningId: screening.id,
    goalId: goal.id,
    assessment,
    eligibility,
    gymConstraints: { unavailableExerciseNames },
    loadGuidance: alignLoadGuidance(loadGuidance),
    activePlan,
    activationRevision: activation?.revision ?? 0,
  };
}

const strengthCatalog = STRENGTH_EXERCISE_CATALOG;

// `getInitialLoadGuidance` already returns catalog order; this keeps the
// persisted input stable even if a caller hands over a different catalog slice.
function alignLoadGuidance(guidance: InitialLoadGuidance[]): InitialLoadGuidance[] {
  return [...guidance].sort((left, right) =>
    left.catalogKey < right.catalogKey ? -1 : left.catalogKey > right.catalogKey ? 1 : 0,
  );
}

async function loadUnavailableExerciseNames(
  tx: Prisma.TransactionClient,
  userId: string,
  activeGymId: string | null,
): Promise<string[]> {
  if (!activeGymId) return [];
  const configs = await tx.gymExerciseConfig.findMany({
    where: { gymId: activeGymId, gym: { userId }, isAvailable: false },
    select: { exercise: { select: { name: true } } },
    orderBy: { exerciseId: 'asc' },
  });
  return [...new Set(configs.map((config) => config.exercise.name))].sort();
}

// The assessment input schema takes the raw shape (restrictions optional) and
// normalizes it, so the persisted `null` must not be fed back in as-is.
type RawClearance = { date: string; unrestricted: boolean; restrictions?: string };

function clearanceFromScreening(screening: {
  clearanceDate: Date | null;
  clearanceUnrestricted: boolean | null;
  clearanceRestrictions: string | null;
}): RawClearance | undefined {
  const { clearanceDate, clearanceUnrestricted, clearanceRestrictions } = screening;
  if (clearanceDate === null && clearanceUnrestricted === null && clearanceRestrictions === null) {
    return undefined;
  }
  if (clearanceDate === null || clearanceUnrestricted === null) {
    throw new Error('Persisted fitness clearance is inconsistent');
  }
  if (clearanceUnrestricted) {
    if (clearanceRestrictions !== null) {
      throw new Error('Persisted fitness clearance is inconsistent');
    }
    return { date: clearanceDate.toISOString().slice(0, 10), unrestricted: true };
  }
  if (!clearanceRestrictions) throw new Error('Persisted fitness clearance is inconsistent');
  return {
    date: clearanceDate.toISOString().slice(0, 10),
    unrestricted: false,
    restrictions: clearanceRestrictions,
  };
}

export function buildPersistedCalculationInput(
  state: FitnessCalculationState,
  calculationDate: string,
): PersistedCalculationInput {
  const { clearance: _clearance, ...healthWithoutClearance } = state.assessment.health;
  return {
    rulesVersion: FITNESS_RULES_VERSION,
    calculationDate,
    assessment: {
      ...state.assessment,
      profile: {
        ...state.assessment.profile,
        displayName: undefined,
      },
      health: {
        ...healthWithoutClearance,
        // The clearance date/unrestricted flag still gate eligibility; only the
        // free-text restriction summary is dropped from the calculation input.
        ...(state.assessment.health.clearance
          ? {
              clearance: {
                date: state.assessment.health.clearance.date,
                unrestricted: state.assessment.health.clearance.unrestricted,
                // Free text is dropped: only the date and the unrestricted flag
                // can influence eligibility.
                restrictions: null,
              },
            }
          : {}),
      },
    },
    eligibility: {
      status: state.eligibility.status,
      reasonCodes: [...state.eligibility.reasonCodes],
      clearanceExpiresAt: state.eligibility.clearanceExpiresAt?.toISOString() ?? null,
    },
    gymConstraints: state.gymConstraints,
    loadGuidance: state.loadGuidance,
  };
}

async function nextVersion(tx: Prisma.TransactionClient, userId: string): Promise<number> {
  const aggregate = await tx.fitnessPlanVersion.aggregate({
    where: { userId },
    _max: { version: true },
  });
  return (aggregate._max.version ?? 0) + 1;
}

// Comparison is expressed with stable metric codes and raw values (never
// localized prose) so the UI can format it in the user's language.
function compareContents(
  previous: PlanVersionRow,
  before: FitnessPlanContent,
  after: FitnessPlanContent,
): FitnessPlanComparison {
  const changes: FitnessPlanComparison['changes'] = [];
  const compare = (
    metric: FitnessPlanComparisonMetric,
    beforeValue: FitnessPlanComparison['changes'][number]['before'],
    afterValue: FitnessPlanComparison['changes'][number]['after'],
  ) => {
    if (JSON.stringify(beforeValue) === JSON.stringify(afterValue)) return;
    changes.push({ metric, before: beforeValue, after: afterValue });
  };

  compare('STRENGTH_FREQUENCY', before.strength.days.length, after.strength.days.length);
  compare('STRENGTH_SPLIT', before.strength.split, after.strength.split);
  compare('TRAINING_DAYS', trainingDays(before), trainingDays(after));
  compare('WEEKLY_TARGET_SETS', before.strength.weeklyTargetSets, after.strength.weeklyTargetSets);
  compare('EXERCISE_SELECTION', exerciseSelection(before), exerciseSelection(after));
  compare('CALORIES', before.nutrition.caloriesKcal, after.nutrition.caloriesKcal);
  compare('PROTEIN', before.nutrition.proteinG, after.nutrition.proteinG);
  compare('CARDIO_MINUTES', before.cardio.additionalWeeklyMin, after.cardio.additionalWeeklyMin);
  compare(
    'SLEEP_TARGET',
    { min: before.sleep.initialTargetMin, max: before.sleep.initialTargetMax },
    { min: after.sleep.initialTargetMin, max: after.sleep.initialTargetMax },
  );

  return { previousPlanId: previous.id, changes };
}

function trainingDays(content: FitnessPlanContent): number[] {
  return content.strength.days
    .map((day) => day.dayOfWeek ?? 0)
    .filter((day) => day > 0)
    .sort((left, right) => left - right);
}

function exerciseSelection(content: FitnessPlanContent): string[] {
  const keys = new Set<string>();
  for (const day of content.strength.days) {
    for (const exercise of day.exercises) {
      const note = exercise.notes;
      if (note?.startsWith('catalog:')) keys.add(note.slice('catalog:'.length));
    }
  }
  return [...keys].sort();
}
