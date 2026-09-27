import { z } from 'zod';
import {
  exerciseCatalogKeys,
  exerciseRequiredEquipment,
  supportedAssessmentEquipmentValues,
  type EquipmentType,
} from './exercise-keys';

export const urgentSignalValues = [
  'CURRENT_CHEST_PRESSURE_OR_PAIN',
  'SEVERE_BREATHING_DIFFICULTY',
  'CURRENT_LOSS_OF_CONSCIOUSNESS',
  'CHEST_DISCOMFORT_WITH_SYSTEMIC_SIGNS',
] as const;

export const clearanceSignalValues = [
  'KNOWN_CARDIOVASCULAR_CONDITION',
  'KNOWN_DIABETES_OR_RENAL_CONDITION',
  'UNEXPLAINED_CHEST_NECK_JAW_ARM_SYMPTOM',
  'UNUSUAL_SHORTNESS_OF_BREATH',
  'DIZZINESS_FAINTING_OR_NEAR_FAINTING',
  'ORTHOPNEA_OR_NOCTURNAL_BREATHING_DIFFICULTY',
  'UNEXPLAINED_ANKLE_EDEMA',
  'RECURRENT_PALPITATION_OR_IRREGULAR_RHYTHM',
  'EXERTIONAL_LEG_PAIN_RELIEVED_BY_REST',
  'KNOWN_HEART_MURMUR',
  'UNUSUAL_FATIGUE_DURING_DAILY_ACTIVITY',
  'UNCONTROLLED_HYPERTENSION_OR_LIFTING_RESTRICTION',
] as const;

export const temporarySignalValues = [
  'FEVER_OR_ACUTE_INFECTION',
  'NEW_UNEVALUATED_INJURY_OR_ABNORMAL_PAIN',
  'RECENT_SURGERY_WITHOUT_RETURN_CLEARANCE',
  'MAJOR_RECENT_HEALTH_OR_MEDICATION_CHANGE',
] as const;

export const scopeSignalValues = [
  'PREGNANT_OR_POSTPARTUM',
  'ACTIVE_EATING_DISORDER_TREATMENT',
  'DISEASE_SPECIFIC_EXERCISE_OR_NUTRITION_CARE',
  'POSTOPERATIVE_OR_DISEASE_SPECIFIC_REHABILITATION',
] as const;

export const urgentSignalSchema = z.enum(urgentSignalValues);
export const clearanceSignalSchema = z.enum(clearanceSignalValues);
export const temporarySignalSchema = z.enum(temporarySignalValues);
export const scopeSignalSchema = z.enum(scopeSignalValues);

export const eligibilityStatusValues = [
  'ELIGIBLE',
  'NEEDS_MEDICAL_CLEARANCE',
  'URGENT_ACTION',
  'TEMPORARY_HOLD',
  'OUT_OF_SCOPE',
] as const;

export const eligibilityReasonCodeValues = [
  'URGENT_CHEST_PAIN_AT_REST',
  'URGENT_FAINTING_WITHOUT_EXPLANATION',
  'URGENT_SEVERE_BREATHING_DIFFICULTY',
  'SCOPE_AGE_OUTSIDE_RANGE',
  'SCOPE_PREGNANT_OR_POSTPARTUM',
  'SCOPE_EATING_DISORDER_TREATMENT',
  'SCOPE_DISEASE_SPECIFIC_CARE',
  'SCOPE_RESTRICTED_CLEARANCE',
  'HOLD_ACUTE_ILLNESS',
  'HOLD_RECENT_SURGERY',
  'HOLD_ACUTE_INJURY',
  'CLEARANCE_CARDIOVASCULAR_CONCERN',
  'CLEARANCE_METABOLIC_OR_RENAL_CONCERN',
  'CLEARANCE_EXERCISE_SYMPTOM',
  'CLEARANCE_BONE_OR_JOINT_CONCERN',
  'CLEARANCE_EXPIRED',
  'CLEARANCE_HEALTH_CHANGED',
  'ELIGIBLE_GENERAL_POPULATION',
  'ENERGY_REFERENCE_RANGE',
  'GOAL_HYPERTROPHY_SURPLUS',
  'GOAL_FAT_LOSS_DEFICIT',
  'GOAL_RECOMP_MAINTENANCE',
  'PROTEIN_GOAL_BASED',
  'FAT_MINIMUM_APPLIED',
  'CARDIO_BUILD_TO_BASELINE',
  'CARDIO_FILL_TO_150',
  'CARDIO_MAINTAIN_CURRENT',
  'SLEEP_ADD_30_MINUTES',
  'SLEEP_GENERAL_RANGE',
  'SLEEP_LONG_DURATION_CAP',
  'STRENGTH_NOVICE_RIR_BUFFER',
  'STRENGTH_DURATION_REDUCED',
  'LOAD_APP_HISTORY',
  'LOAD_USER_REPORTED',
  'LOAD_CALIBRATION_REQUIRED',
  'TARGET_DATE_WITHIN_RANGE',
  'TARGET_DATE_EARLIER_THAN_SUPPORTED',
  'TARGET_DATE_LATER_THAN_ESTIMATE',
  'TARGET_DATE_MILESTONE',
  'NUTRITION_MINIMUM_UNSATISFIABLE',
] as const;

export type EligibilityStatus = (typeof eligibilityStatusValues)[number];
export type EligibilityReasonCode = (typeof eligibilityReasonCodeValues)[number];

export const eligibilityStatusSchema = z.enum(eligibilityStatusValues);
export const eligibilityReasonCodeSchema = z.enum(eligibilityReasonCodeValues);

const calendarDatePattern = /^\d{4}-\d{2}-\d{2}$/;

const invalidCalculationTimeMessage = 'Invalid assessment calculation time';

export function assertValidAssessmentCalculationTime(now: Date): void {
  if (Number.isNaN(now.getTime())) {
    throw new RangeError(invalidCalculationTimeMessage);
  }
}

function isCalendarDate(value: string): boolean {
  if (!calendarDatePattern.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day
  );
}

function localCalendarDate(now: Date, timeZone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((value) => value.type === type)?.value;
    const year = part('year');
    const month = part('month');
    const day = part('day');
    return year && month && day ? `${year}-${month}-${day}` : null;
  } catch {
    return null;
  }
}

function hasDuplicates(values: readonly unknown[]): boolean {
  return new Set(values).size !== values.length;
}

const calendarDateSchema = z.string().refine(isCalendarDate, 'Must be a valid YYYY-MM-DD date');

const displayNameSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().max(100).optional(),
);

export const assessmentHeightCmSchema = z.number().int().min(120).max(230);
export const assessmentWeightKgSchema = z.number().min(35).max(300);
export const assessmentWaistCmSchema = z.number().min(40).max(220);

// Free text the trainee writes in their own words. The model reads it to shape
// the plan's strategy; nothing here is parsed into a number by the app.
export const softConstraintsSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().max(500).optional(),
);

const profileSchema = z
  .object({
    displayName: displayNameSchema,
    ageYears: z.number().int().min(0).max(120),
    displaySex: z.enum(['MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY']),
    energyEquationReference: z.enum(['MALE', 'FEMALE', 'UNSPECIFIED']),
    heightCm: assessmentHeightCmSchema,
    weightKg: assessmentWeightKgSchema,
    waistCm: assessmentWaistCmSchema.optional(),
    bodyFatPct: z.number().min(3).max(70).optional(),
    trainingAgeMonths: z.number().int().min(0).max(600),
  })
  .strict();

const goalSchema = z
  .object({
    type: z.enum(['HYPERTROPHY', 'FAT_LOSS', 'RECOMP']),
    desiredWeeklyRatePct: z.number().min(-0.75).max(0.25),
    targetWeightKg: z.number().min(35).max(300).optional(),
    targetDate: calendarDateSchema.optional(),
  })
  .strict();

const recentMainLiftSchema = z
  .object({
    catalogKey: z.enum(exerciseCatalogKeys),
    weightKg: z.number().min(0).max(1000),
    reps: z.number().int().min(1).max(30),
    rir: z.number().int().min(0).max(5),
  })
  .strict();

const scheduleSchema = z
  .object({
    weeklyFrequency: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
    availableWeekdays: z.array(z.number().int().min(1).max(7)),
    sessionDurationMin: z
      .number()
      .int()
      .min(30)
      .max(120)
      .refine((value) => value % 5 === 0, 'Must be in 5-minute increments'),
    equipmentTypes: z.array(z.enum(supportedAssessmentEquipmentValues)).min(1),
    recentMainLifts: z.array(recentMainLiftSchema).max(6),
  })
  .strict();

const lifestyleSchema = z
  .object({
    activityLevel: z.enum(['SEDENTARY', 'LIGHT', 'MODERATE', 'HIGH']),
    avgDailySteps: z.number().int().min(0).max(100000).optional(),
    currentModerateActivityMin: z.number().int().min(0).max(2000),
    habitualSleepMin: z.number().int().min(180).max(900),
    bedtimeMin: z.number().int().min(0).max(1439),
    wakeTimeMin: z.number().int().min(0).max(1439),
    timeZone: z.string().trim().min(1).max(100),
  })
  .strict();

const clearanceSchema = z
  .object({
    date: calendarDateSchema,
    unrestricted: z.boolean(),
    restrictions: z.string().trim().max(500).optional(),
  })
  .strict()
  .transform((clearance) => ({
    ...clearance,
    restrictions: clearance.unrestricted ? null : (clearance.restrictions ?? null),
  }));

const healthBaseSchema = z
  .object({
    urgentSignals: z.array(urgentSignalSchema),
    clearanceSignals: z.array(clearanceSignalSchema),
    temporarySignals: z.array(temporarySignalSchema),
    scopeSignals: z.array(scopeSignalSchema),
    healthChangedSinceClearance: z.boolean(),
    clearance: clearanceSchema.optional(),
    attested: z.literal(true),
  })
  .strict();

type HealthForRefinement = {
  urgentSignals: readonly unknown[];
  clearanceSignals: readonly unknown[];
  temporarySignals: readonly unknown[];
  scopeSignals: readonly unknown[];
  clearance?: {
    unrestricted: boolean;
    restrictions: string | null;
  } | null;
};

function addHealthIssues(health: HealthForRefinement, ctx: z.RefinementCtx): void {
  const signalFields = [
    'urgentSignals',
    'clearanceSignals',
    'temporarySignals',
    'scopeSignals',
  ] as const;
  for (const field of signalFields) {
    if (hasDuplicates(health[field])) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} must not contain duplicates`,
      });
    }
  }
  if (health.clearance && !health.clearance.unrestricted && !health.clearance.restrictions) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['clearance', 'restrictions'],
      message: 'Restricted clearance requires a restriction summary',
    });
  }
}

const persistedClearanceSchema = z
  .object({
    date: calendarDateSchema,
    unrestricted: z.boolean(),
    restrictions: z.string().trim().max(500).nullable().optional(),
  })
  .strict()
  .transform((clearance) => ({
    ...clearance,
    restrictions: clearance.unrestricted ? null : (clearance.restrictions ?? null),
  }));

export const healthAnswersSchema = z
  .object({
    urgentSignals: z.array(urgentSignalSchema),
    clearanceSignals: z.array(clearanceSignalSchema),
    temporarySignals: z.array(temporarySignalSchema),
    scopeSignals: z.array(scopeSignalSchema),
    healthChangedSinceClearance: z.boolean(),
    clearance: persistedClearanceSchema.optional(),
    attested: z.literal(true),
  })
  .strict()
  .superRefine(addHealthIssues);

export const assessmentInputBaseSchema = z
  .object({
    profile: profileSchema,
    goal: goalSchema,
    schedule: scheduleSchema,
    lifestyle: lifestyleSchema,
    // Soft constraints (agent pivot): the things the trainee wants that no
    // fixed field can express - "I hate running", "my knee dislikes deep
    // squats", "I only train at lunch". It is part of the calculation input, so
    // changing it produces a new plan instead of silently reusing the old one.
    softConstraints: softConstraintsSchema.optional(),
    health: healthBaseSchema,
  })
  .strict();

export type AssessmentInput = z.infer<typeof assessmentInputBaseSchema>;

export function createAssessmentInputSchema(now: Date) {
  assertValidAssessmentCalculationTime(now);
  const capturedNow = new Date(now.getTime());
  return assessmentInputBaseSchema.superRefine((input, ctx) => {
    addHealthIssues(input.health, {
      ...ctx,
      addIssue: (issue) =>
        ctx.addIssue({ ...issue, path: ['health', ...(issue.path ?? [])] } as z.IssueData),
    });

    const { goal, profile, schedule, lifestyle } = input;
    const rateRange: Record<typeof goal.type, readonly [number, number]> = {
      FAT_LOSS: [-0.75, -0.25],
      HYPERTROPHY: [0.1, 0.25],
      RECOMP: [-0.25, 0.25],
    };
    const [minimumRate, maximumRate] = rateRange[goal.type];
    if (goal.desiredWeeklyRatePct < minimumRate || goal.desiredWeeklyRatePct > maximumRate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['goal', 'desiredWeeklyRatePct'],
        message: `Rate is outside the range for ${goal.type}`,
      });
    }

    if (goal.type === 'RECOMP') {
      if (goal.targetWeightKg !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['goal', 'targetWeightKg'],
          message: 'Recomp does not accept a target weight',
        });
      }
    } else {
      const hasWeight = goal.targetWeightKg !== undefined;
      const hasDate = goal.targetDate !== undefined;
      if (hasWeight !== hasDate) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['goal'],
          message: 'Target weight and target date must be supplied together',
        });
      }
      if (
        goal.type === 'FAT_LOSS' &&
        goal.targetWeightKg !== undefined &&
        goal.targetWeightKg >= profile.weightKg
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['goal', 'targetWeightKg'],
          message: 'Fat-loss target weight must be below current weight',
        });
      }
      if (
        goal.type === 'HYPERTROPHY' &&
        goal.targetWeightKg !== undefined &&
        goal.targetWeightKg <= profile.weightKg
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['goal', 'targetWeightKg'],
          message: 'Hypertrophy target weight must be above current weight',
        });
      }
    }

    if (hasDuplicates(schedule.availableWeekdays)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['schedule', 'availableWeekdays'],
        message: 'Available weekdays must be distinct',
      });
    }
    if (new Set(schedule.availableWeekdays).size < schedule.weeklyFrequency) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['schedule', 'availableWeekdays'],
        message: 'Available weekdays must cover the weekly frequency',
      });
    }
    if (hasDuplicates(schedule.equipmentTypes)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['schedule', 'equipmentTypes'],
        message: 'Equipment types must be distinct',
      });
    }

    const recentKeys = schedule.recentMainLifts.map((lift) => lift.catalogKey);
    if (hasDuplicates(recentKeys)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['schedule', 'recentMainLifts'],
        message: 'Recent lift catalog keys must be distinct',
      });
    }
    const selectedEquipment = new Set<EquipmentType>(schedule.equipmentTypes);
    schedule.recentMainLifts.forEach((lift, index) => {
      const requiredEquipment = exerciseRequiredEquipment[lift.catalogKey];
      if (!selectedEquipment.has(requiredEquipment)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['schedule', 'recentMainLifts', index, 'catalogKey'],
          message: `${requiredEquipment} must be selected for this recent lift`,
        });
      }
      if (requiredEquipment !== 'BODYWEIGHT' && lift.weightKg === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['schedule', 'recentMainLifts', index, 'weightKg'],
          message: 'Loaded-equipment lifts require a positive load',
        });
      }
    });

    const today = localCalendarDate(capturedNow, lifestyle.timeZone);
    if (!today) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lifestyle', 'timeZone'],
        message: 'Must be a valid IANA time zone',
      });
      return;
    }
    if (goal.targetDate && goal.targetDate <= today) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['goal', 'targetDate'],
        message: 'Target date must be in the future',
      });
    }
    if (input.health.clearance && input.health.clearance.date > today) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['health', 'clearance', 'date'],
        message: 'Clearance date cannot be in the future',
      });
    }
  });
}

export const eligibilityResponseSchema = z
  .object({
    status: eligibilityStatusSchema,
    reasonCodes: z.array(eligibilityReasonCodeSchema),
    clearanceExpiresAt: z.string().datetime().nullable(),
  })
  .strict();

const normalizedProfileSchema = profileSchema.extend({
  displayName: z.string().trim().min(1).max(100).nullable(),
  waistCm: assessmentWaistCmSchema.nullable(),
  bodyFatPct: z.number().min(3).max(70).nullable(),
});

const normalizedGoalSchema = goalSchema.extend({
  targetWeightKg: z.number().min(35).max(300).nullable(),
  targetDate: calendarDateSchema.nullable(),
});

const normalizedLifestyleSchema = lifestyleSchema.extend({
  avgDailySteps: z.number().int().min(0).max(100000).nullable(),
});

export const normalizedClearanceSchema = z
  .object({
    date: calendarDateSchema,
    unrestricted: z.boolean(),
    restrictions: z.string().trim().min(1).max(500).nullable(),
  })
  .strict()
  .superRefine((clearance, ctx) => {
    if (!clearance.unrestricted && clearance.restrictions === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['restrictions'],
        message: 'Restricted clearance requires a restriction summary',
      });
    }
    if (clearance.unrestricted && clearance.restrictions !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['restrictions'],
        message: 'Unrestricted clearance must have null restrictions',
      });
    }
  });

const normalizedHealthSchema = z
  .object({
    urgentSignals: z.array(urgentSignalSchema),
    clearanceSignals: z.array(clearanceSignalSchema),
    temporarySignals: z.array(temporarySignalSchema),
    scopeSignals: z.array(scopeSignalSchema),
    healthChangedSinceClearance: z.boolean(),
    clearance: normalizedClearanceSchema.nullable(),
    attested: z.literal(true),
  })
  .strict()
  .superRefine(addHealthIssues);

export const normalizedAssessmentSnapshotSchema = z
  .object({
    profile: normalizedProfileSchema,
    goal: normalizedGoalSchema,
    schedule: scheduleSchema,
    lifestyle: normalizedLifestyleSchema,
    softConstraints: softConstraintsSchema.nullable(),
    health: normalizedHealthSchema,
    eligibility: eligibilityResponseSchema,
  })
  .strict();

export type NormalizedAssessmentSnapshot = z.output<typeof normalizedAssessmentSnapshotSchema>;

export const assessmentResponseSchema = z
  .object({
    assessment: normalizedAssessmentSnapshotSchema.nullable(),
    activationRevision: z.number().int().nonnegative(),
    onboardingRequired: z.boolean(),
    unit: z.enum(['KG', 'LB']),
  })
  .strict();

export type AssessmentResponse = z.output<typeof assessmentResponseSchema>;

export const planPreviewRequestSchema = z.object({}).strict();

export const planActivationRequestSchema = z
  .object({ expectedRevision: z.number().int().nonnegative() })
  .strict();
