import type { Prisma } from '@/prisma/generated/client';
import { db } from '@/lib/db';
import { evaluateEligibility, type EligibilityDecision } from './eligibility';
import { exerciseCatalogKeys, supportedAssessmentEquipmentValues } from './exercise-keys';
import {
  assessmentHeightCmSchema,
  assessmentResponseSchema,
  assessmentWaistCmSchema,
  assessmentWeightKgSchema,
  assertValidAssessmentCalculationTime,
  clearanceSignalValues,
  healthAnswersSchema,
  scopeSignalValues,
  temporarySignalValues,
  urgentSignalValues,
  type AssessmentInput,
  type AssessmentResponse,
} from './schemas';
import { lockFitnessUser } from './user-lock';
import { FITNESS_RULES_VERSION, FITNESS_SCREENING_VERSION } from './versions';

const equipmentOrder = new Map(
  supportedAssessmentEquipmentValues.map((equipment, index) => [equipment, index] as const),
);
const exerciseOrder = new Map(
  exerciseCatalogKeys.map((catalogKey, index) => [catalogKey, index] as const),
);
const urgentSignalOrder = new Map(
  urgentSignalValues.map((signal, index) => [signal, index] as const),
);
const clearanceSignalOrder = new Map(
  clearanceSignalValues.map((signal, index) => [signal, index] as const),
);
const temporarySignalOrder = new Map(
  temporarySignalValues.map((signal, index) => [signal, index] as const),
);
const scopeSignalOrder = new Map(
  scopeSignalValues.map((signal, index) => [signal, index] as const),
);

const maximumDateTimeMs = 8_640_000_000_000_000;

function calendarDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day));
}

function calendarDateString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function persistedOrderingTime(capturedNow: Date, timestamps: Array<Date | null>): Date {
  let persistedMs = capturedNow.getTime();
  for (const timestamp of timestamps) {
    if (timestamp === null) continue;
    const timestampMs = timestamp.getTime();
    if (!Number.isFinite(timestampMs) || timestampMs >= maximumDateTimeMs) {
      throw new RangeError('Cannot derive a later fitness snapshot timestamp');
    }
    persistedMs = Math.max(persistedMs, timestampMs + 1);
  }
  const persistedAt = new Date(persistedMs);
  assertValidAssessmentCalculationTime(persistedAt);
  return persistedAt;
}

function sortedByLiteralOrder<T extends string>(
  values: readonly T[],
  order: ReadonlyMap<T, number>,
): T[] {
  return [...values].sort((left, right) => order.get(left)! - order.get(right)!);
}

function normalizeInput(rawInput: AssessmentInput): AssessmentInput {
  const equipmentTypes = [
    ...new Set([...rawInput.schedule.equipmentTypes, 'BODYWEIGHT' as const]),
  ].sort((left, right) => equipmentOrder.get(left)! - equipmentOrder.get(right)!);
  const recentMainLifts = [...rawInput.schedule.recentMainLifts].sort(
    (left, right) => exerciseOrder.get(left.catalogKey)! - exerciseOrder.get(right.catalogKey)!,
  );
  const displayName = rawInput.profile.displayName?.trim() || undefined;
  const clearance = rawInput.health.clearance
    ? {
        ...rawInput.health.clearance,
        restrictions: rawInput.health.clearance.restrictions?.trim() || null,
      }
    : undefined;

  return {
    profile: {
      ...rawInput.profile,
      ...(displayName === undefined ? { displayName: undefined } : { displayName }),
    },
    goal: { ...rawInput.goal },
    schedule: {
      ...rawInput.schedule,
      availableWeekdays: [...rawInput.schedule.availableWeekdays].sort(
        (left, right) => left - right,
      ),
      equipmentTypes,
      recentMainLifts,
    },
    lifestyle: { ...rawInput.lifestyle, timeZone: rawInput.lifestyle.timeZone.trim() },
    ...(rawInput.softConstraints === undefined
      ? { softConstraints: undefined }
      : { softConstraints: rawInput.softConstraints }),
    health: {
      ...rawInput.health,
      urgentSignals: sortedByLiteralOrder(rawInput.health.urgentSignals, urgentSignalOrder),
      clearanceSignals: sortedByLiteralOrder(
        rawInput.health.clearanceSignals,
        clearanceSignalOrder,
      ),
      temporarySignals: sortedByLiteralOrder(
        rawInput.health.temporarySignals,
        temporarySignalOrder,
      ),
      scopeSignals: sortedByLiteralOrder(rawInput.health.scopeSignals, scopeSignalOrder),
      ...(clearance === undefined ? { clearance: undefined } : { clearance }),
    },
  };
}

function persistedHealthAnswers(input: AssessmentInput) {
  return healthAnswersSchema.parse({
    urgentSignals: input.health.urgentSignals,
    clearanceSignals: input.health.clearanceSignals,
    temporarySignals: input.health.temporarySignals,
    scopeSignals: input.health.scopeSignals,
    healthChangedSinceClearance: input.health.healthChangedSinceClearance,
    ...(input.health.clearance ? { clearance: input.health.clearance } : {}),
    attested: input.health.attested,
  });
}

function responseFromInput(args: {
  input: AssessmentInput;
  decision: EligibilityDecision;
  waistCm: number | null;
  activationRevision: number;
  onboardingRequired: boolean;
  unit: 'KG' | 'LB';
}): AssessmentResponse {
  const { input, decision } = args;
  return assessmentResponseSchema.parse({
    assessment: {
      profile: {
        ...input.profile,
        displayName: input.profile.displayName ?? null,
        waistCm: args.waistCm,
        bodyFatPct: input.profile.bodyFatPct ?? null,
      },
      goal: {
        ...input.goal,
        targetWeightKg: input.goal.targetWeightKg ?? null,
        targetDate: input.goal.targetDate ?? null,
      },
      schedule: input.schedule,
      lifestyle: {
        ...input.lifestyle,
        avgDailySteps: input.lifestyle.avgDailySteps ?? null,
      },
      softConstraints: input.softConstraints ?? null,
      health: {
        ...persistedHealthAnswers(input),
        clearance: input.health.clearance ?? null,
      },
      eligibility: {
        status: decision.status,
        reasonCodes: decision.reasonCodes,
        clearanceExpiresAt: decision.clearanceExpiresAt?.toISOString() ?? null,
      },
    },
    activationRevision: args.activationRevision,
    onboardingRequired: args.onboardingRequired,
    unit: args.unit,
  });
}

function legacySex(displaySex: AssessmentInput['profile']['displaySex']) {
  return displaySex === 'PREFER_NOT_TO_SAY' ? null : displaySex;
}

async function saveAssessmentTransaction(
  tx: Prisma.TransactionClient,
  userId: string,
  rawInput: AssessmentInput,
  now: Date,
): Promise<AssessmentResponse> {
  await lockFitnessUser(tx, userId);

  const [latestScreening, latestGoal, latestBodyweight, latestWaist] = await Promise.all([
    tx.healthScreening.findFirst({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { createdAt: true },
    }),
    tx.fitnessGoal.findFirst({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { createdAt: true },
    }),
    tx.bodyweightEntry.findFirst({
      where: { userId },
      orderBy: [{ measuredAt: 'desc' }, { id: 'desc' }],
      select: { measuredAt: true, weightKg: true },
    }),
    tx.bodyMeasurement.findFirst({
      where: { userId, site: 'WAIST' },
      orderBy: [{ measuredAt: 'desc' }, { id: 'desc' }],
      select: { measuredAt: true, valueCm: true },
    }),
  ]);
  const persistedAt = persistedOrderingTime(now, [
    latestScreening?.createdAt ?? null,
    latestGoal?.createdAt ?? null,
    latestBodyweight?.measuredAt ?? null,
    latestWaist?.measuredAt ?? null,
  ]);
  const input = normalizeInput(rawInput);
  const decision = evaluateEligibility(input, now);
  const healthAnswers = persistedHealthAnswers(input);

  const user = await tx.user.update({
    where: { id: userId },
    data: {
      displayName: input.profile.displayName ?? null,
      bodyweight: input.profile.weightKg,
      sex: legacySex(input.profile.displaySex),
      heightCm: input.profile.heightCm,
      goal: input.goal.type,
      weeklyFrequency: input.schedule.weeklyFrequency,
      fitnessOnboardingRequired: false,
    },
    select: { unit: true },
  });

  await tx.fitnessProfile.upsert({
    where: { userId },
    create: {
      userId,
      ageYears: input.profile.ageYears,
      displaySex: input.profile.displaySex,
      energyEquationReference: input.profile.energyEquationReference,
      bodyFatPct: input.profile.bodyFatPct ?? null,
      trainingAgeMonths: input.profile.trainingAgeMonths,
      weeklyFrequency: input.schedule.weeklyFrequency,
      availableWeekdays: input.schedule.availableWeekdays,
      sessionDurationMin: input.schedule.sessionDurationMin,
      equipmentTypes: input.schedule.equipmentTypes,
      recentMainLifts: input.schedule.recentMainLifts,
      activityLevel: input.lifestyle.activityLevel,
      avgDailySteps: input.lifestyle.avgDailySteps ?? null,
      currentModerateActivityMin: input.lifestyle.currentModerateActivityMin,
      habitualSleepMin: input.lifestyle.habitualSleepMin,
      bedtimeMin: input.lifestyle.bedtimeMin,
      wakeTimeMin: input.lifestyle.wakeTimeMin,
      timeZone: input.lifestyle.timeZone,
      softConstraints: input.softConstraints ?? null,
      createdAt: persistedAt,
      updatedAt: persistedAt,
    },
    update: {
      ageYears: input.profile.ageYears,
      displaySex: input.profile.displaySex,
      energyEquationReference: input.profile.energyEquationReference,
      bodyFatPct: input.profile.bodyFatPct ?? null,
      trainingAgeMonths: input.profile.trainingAgeMonths,
      weeklyFrequency: input.schedule.weeklyFrequency,
      availableWeekdays: input.schedule.availableWeekdays,
      sessionDurationMin: input.schedule.sessionDurationMin,
      equipmentTypes: input.schedule.equipmentTypes,
      recentMainLifts: input.schedule.recentMainLifts,
      activityLevel: input.lifestyle.activityLevel,
      avgDailySteps: input.lifestyle.avgDailySteps ?? null,
      currentModerateActivityMin: input.lifestyle.currentModerateActivityMin,
      habitualSleepMin: input.lifestyle.habitualSleepMin,
      bedtimeMin: input.lifestyle.bedtimeMin,
      wakeTimeMin: input.lifestyle.wakeTimeMin,
      timeZone: input.lifestyle.timeZone,
      softConstraints: input.softConstraints ?? null,
      updatedAt: persistedAt,
    },
  });

  if (latestBodyweight?.weightKg !== input.profile.weightKg) {
    await tx.bodyweightEntry.create({
      data: { userId, weightKg: input.profile.weightKg, measuredAt: persistedAt },
    });
  }

  if (input.profile.waistCm !== undefined && latestWaist?.valueCm !== input.profile.waistCm) {
    await tx.bodyMeasurement.create({
      data: {
        userId,
        site: 'WAIST',
        valueCm: input.profile.waistCm,
        measuredAt: persistedAt,
      },
    });
  }

  await tx.fitnessGoal.updateMany({
    where: { userId, status: 'ACTIVE' },
    data: { status: 'SUPERSEDED', supersededAt: persistedAt },
  });
  await tx.fitnessGoal.create({
    data: {
      userId,
      type: input.goal.type,
      desiredWeeklyRatePct: input.goal.desiredWeeklyRatePct,
      targetWeightKg: input.goal.targetWeightKg ?? null,
      targetDate: input.goal.targetDate ? calendarDate(input.goal.targetDate) : null,
      status: 'ACTIVE',
      createdAt: persistedAt,
    },
  });

  await tx.healthScreening.create({
    data: {
      userId,
      screeningVersion: FITNESS_SCREENING_VERSION,
      rulesVersion: FITNESS_RULES_VERSION,
      answers: healthAnswers,
      status: decision.status,
      reasonCodes: decision.reasonCodes,
      attestedAt: persistedAt,
      clearanceDate: input.health.clearance ? calendarDate(input.health.clearance.date) : null,
      clearanceUnrestricted: input.health.clearance?.unrestricted ?? null,
      clearanceRestrictions: input.health.clearance?.restrictions ?? null,
      expiresAt: decision.clearanceExpiresAt,
      createdAt: persistedAt,
    },
  });

  const activation = await tx.fitnessPlanActivation.findUnique({
    where: { userId },
    select: { revision: true },
  });

  return responseFromInput({
    input,
    decision,
    waistCm: input.profile.waistCm ?? latestWaist?.valueCm ?? null,
    activationRevision: activation?.revision ?? 0,
    onboardingRequired: false,
    unit: user.unit,
  });
}

export async function saveAssessment(
  userId: string,
  rawInput: AssessmentInput,
  now = new Date(),
): Promise<AssessmentResponse> {
  assertValidAssessmentCalculationTime(now);
  const capturedNow = new Date(now.getTime());
  return db.$transaction((tx) => saveAssessmentTransaction(tx, userId, rawInput, capturedNow));
}

function assertScreeningColumns(
  screening: {
    clearanceDate: Date | null;
    clearanceUnrestricted: boolean | null;
    clearanceRestrictions: string | null;
  },
  health: ReturnType<typeof healthAnswersSchema.parse>,
): void {
  const clearance = health.clearance;
  if (!clearance) {
    if (
      screening.clearanceDate !== null ||
      screening.clearanceUnrestricted !== null ||
      screening.clearanceRestrictions !== null
    ) {
      throw new Error('Persisted health screening clearance is inconsistent');
    }
    return;
  }
  if (
    screening.clearanceDate === null ||
    calendarDateString(screening.clearanceDate) !== clearance.date ||
    screening.clearanceUnrestricted !== clearance.unrestricted ||
    screening.clearanceRestrictions !== clearance.restrictions
  ) {
    throw new Error('Persisted health screening clearance is inconsistent');
  }
}

async function getCurrentAssessmentTransaction(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<AssessmentResponse> {
  const user = await tx.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      displayName: true,
      bodyweight: true,
      heightCm: true,
      unit: true,
      fitnessOnboardingRequired: true,
    },
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
  });
  const waist = await tx.bodyMeasurement.findFirst({
    where: { userId, site: 'WAIST' },
    orderBy: [{ measuredAt: 'desc' }, { id: 'desc' }],
  });
  const activation = await tx.fitnessPlanActivation.findUnique({
    where: { userId },
    select: { revision: true },
  });

  const envelope = {
    activationRevision: activation?.revision ?? 0,
    onboardingRequired: user.fitnessOnboardingRequired,
    unit: user.unit,
  };
  const heightCm = assessmentHeightCmSchema.safeParse(user.heightCm);
  const weightKg = assessmentWeightKgSchema.safeParse(bodyweight?.weightKg ?? user.bodyweight);
  if (!profile || !screening || !goal || !heightCm.success || !weightKg.success) {
    return assessmentResponseSchema.parse({ assessment: null, ...envelope });
  }
  const waistCm = assessmentWaistCmSchema.safeParse(waist?.valueCm);

  const health = healthAnswersSchema.parse(screening.answers);
  assertScreeningColumns(screening, health);

  return assessmentResponseSchema.parse({
    assessment: {
      profile: {
        displayName: user.displayName,
        ageYears: profile.ageYears,
        displaySex: profile.displaySex,
        energyEquationReference: profile.energyEquationReference,
        heightCm: heightCm.data,
        weightKg: weightKg.data,
        waistCm: waistCm.success ? waistCm.data : null,
        bodyFatPct: profile.bodyFatPct,
        trainingAgeMonths: profile.trainingAgeMonths,
      },
      goal: {
        type: goal.type,
        desiredWeeklyRatePct: goal.desiredWeeklyRatePct,
        targetWeightKg: goal.targetWeightKg,
        targetDate: goal.targetDate ? calendarDateString(goal.targetDate) : null,
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
        avgDailySteps: profile.avgDailySteps,
        currentModerateActivityMin: profile.currentModerateActivityMin,
        habitualSleepMin: profile.habitualSleepMin,
        bedtimeMin: profile.bedtimeMin,
        wakeTimeMin: profile.wakeTimeMin,
        timeZone: profile.timeZone,
      },
      softConstraints: profile.softConstraints,
      health: { ...health, clearance: health.clearance ?? null },
      eligibility: {
        status: screening.status,
        reasonCodes: screening.reasonCodes,
        clearanceExpiresAt: screening.expiresAt?.toISOString() ?? null,
      },
    },
    ...envelope,
  });
}

export async function getCurrentAssessment(userId: string): Promise<AssessmentResponse> {
  return db.$transaction((tx) => getCurrentAssessmentTransaction(tx, userId), {
    isolationLevel: 'RepeatableRead',
  });
}
