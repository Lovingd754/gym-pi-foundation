import { z } from 'zod';

import { MuscleGroup } from '@/lib/prisma-client';
import { generatedWorkoutSchema } from '@/lib/schemas/program-generation';

import { eligibilityReasonCodeSchema } from './schemas';
import { exerciseCatalogKeys } from './exercise-keys';
import { FITNESS_PLAN_SCHEMA_VERSION, FITNESS_RULES_VERSION } from './versions';

// ============================================================
// Persisted baseline plan content
// ============================================================
// This is the JSON stored on FitnessPlanVersion and re-validated on every read.
// Every new object boundary is strict and every enum is a literal union: a
// stored payload that drifts from these rules is corrupt, and the caller must
// refuse to render or activate it rather than repairing it silently.

const nonNegativeRangeSchema = z
  .object({ min: z.number().nonnegative(), max: z.number().nonnegative() })
  .strict()
  .refine((range) => range.min <= range.max, { message: 'min must be <= max' });

export const strengthDaySchema = generatedWorkoutSchema
  .extend({
    estimatedDurationMin: z.number().int().positive(),
    lowerBodyDemand: z.boolean(),
  })
  .strict();

// Partial<Record<MuscleGroup, number>>: any subset of the six primary planning
// groups may be present, but an unknown group or a negative count is invalid.
const achievedSetsByMuscleGroupSchema = z
  .object(
    Object.fromEntries(
      Object.keys(MuscleGroup).map((group) => [group, z.number().int().nonnegative().optional()]),
    ),
  )
  .strict();

export const goalFeasibilityStatusValues = [
  'WITHIN_RANGE',
  'EARLIER_THAN_SUPPORTED',
  'LATER_THAN_ESTIMATE',
  'MILESTONE',
  'NOT_REQUESTED',
] as const;

export const strengthSplitValues = [
  'FULL_BODY_AB',
  'FULL_BODY_ABC',
  'UPPER_LOWER',
  'UPPER_LOWER_PPL',
] as const;

export const scheduleDayKindValues = ['STRENGTH', 'CARDIO', 'STRENGTH_AND_CARDIO', 'REST'] as const;

export const initialLoadSourceValues = ['APP_HISTORY', 'USER_REPORTED', 'CALIBRATION'] as const;

const strengthSplitFrequency: Record<(typeof strengthSplitValues)[number], number> = {
  FULL_BODY_AB: 2,
  FULL_BODY_ABC: 3,
  UPPER_LOWER: 4,
  UPPER_LOWER_PPL: 5,
};

const goalSchema = z
  .object({
    type: z.enum(['HYPERTROPHY', 'FAT_LOSS', 'RECOMP']),
    desiredWeeklyRatePct: z.number(),
    feasibility: z
      .object({
        status: z.enum(goalFeasibilityStatusValues),
        earliestDate: z.string().nullable(),
        latestDate: z.string().nullable(),
        targetDate: z.string().nullable(),
      })
      .strict(),
  })
  .strict();

const strengthSchema = z
  .object({
    split: z.enum(strengthSplitValues),
    weeklyTargetSets: z.union([z.literal(6), z.literal(8), z.literal(10)]),
    introRir: z.union([z.literal(3), z.null()]),
    introDurationDays: z.union([z.literal(14), z.literal(0)]),
    steadyRir: z.literal(2),
    achievedSetsByMuscleGroup: achievedSetsByMuscleGroupSchema,
    days: z.array(strengthDaySchema).min(2).max(5),
  })
  .strict();

const loadGuidanceSchema = z
  .object({
    catalogKey: z.enum(exerciseCatalogKeys),
    source: z.enum(initialLoadSourceValues),
    initialLoadKg: z.number().nonnegative().nullable(),
  })
  .strict();

const nutritionSchema = z
  .object({
    caloriesKcal: nonNegativeRangeSchema,
    proteinG: nonNegativeRangeSchema,
    fatG: nonNegativeRangeSchema,
    carbsG: nonNegativeRangeSchema,
    // The daily total split across the day. Optional so a plan stored before
    // meals existed still reads: this schema is re-validated on every read, and
    // a required field here would make every existing plan unreadable.
    meals: z
      .array(
        z
          .object({
            key: z.enum(['BREAKFAST', 'LUNCH', 'TRAINING', 'DINNER']),
            caloriesKcal: nonNegativeRangeSchema,
            proteinG: nonNegativeRangeSchema,
            carbsG: nonNegativeRangeSchema,
            fatG: nonNegativeRangeSchema,
          })
          .strict(),
      )
      .length(4)
      .optional(),
  })
  .strict();

const cardioSchema = z
  .object({
    additionalWeeklyMin: z.number().nonnegative(),
    sessions: z
      .array(
        z
          .object({
            dayOfWeek: z.number().int().min(1).max(7),
            durationMin: z.number().nonnegative(),
            mode: z.literal('LOW_IMPACT'),
            intensity: z.literal('MODERATE'),
            rpeMin: z.literal(3),
            rpeMax: z.literal(5),
          })
          .strict(),
      )
      .max(3),
  })
  .strict();

const sleepSchema = z
  .object({
    longTermMin: z.literal(420),
    longTermMax: z.literal(540),
    initialTargetMin: z.number().int().positive(),
    initialTargetMax: z.number().int().positive(),
    suggestedBedtimeMin: z.number().int().min(0).max(1439),
    wakeTimeMin: z.number().int().min(0).max(1439),
  })
  .strict()
  .refine((sleep) => sleep.initialTargetMin <= sleep.initialTargetMax, {
    message: 'initialTargetMin must be <= initialTargetMax',
  });

const scheduleDaySchema = z
  .object({
    dayOfWeek: z.number().int().min(1).max(7),
    kind: z.enum(scheduleDayKindValues),
    strengthDayIndex: z.number().int().nonnegative().nullable(),
    cardioMin: z.number().nonnegative(),
  })
  .strict();

const scheduleSchema = z.object({ days: z.array(scheduleDaySchema).length(7) }).strict();

export const fitnessPlanContentSchema = z
  .object({
    schemaVersion: z.literal(FITNESS_PLAN_SCHEMA_VERSION),
    rulesVersion: z.literal(FITNESS_RULES_VERSION),
    goal: goalSchema,
    strength: strengthSchema,
    loadGuidance: z.array(loadGuidanceSchema).min(1),
    nutrition: nutritionSchema,
    cardio: cardioSchema,
    sleep: sleepSchema,
    schedule: scheduleSchema,
    reasons: z.array(eligibilityReasonCodeSchema),
  })
  .strict()
  .superRefine((content, ctx) => {
    // Intro RIR and its duration are one decision: a novice buffer is always
    // "RIR 3 for 14 days", and a steady plan carries neither.
    const introPaired =
      (content.strength.introRir === 3 && content.strength.introDurationDays === 14) ||
      (content.strength.introRir === null && content.strength.introDurationDays === 0);
    if (!introPaired) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['strength', 'introRir'],
        message: 'introRir and introDurationDays must be paired as 3 + 14 or null + 0',
      });
    }

    const expectedDays = strengthSplitFrequency[content.strength.split];
    if (content.strength.days.length !== expectedDays) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['strength', 'days'],
        message: `${content.strength.split} requires exactly ${expectedDays} training days`,
      });
    }

    const loadKeys = content.loadGuidance.map((guidance) => guidance.catalogKey);
    if (new Set(loadKeys).size !== loadKeys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['loadGuidance'],
        message: 'Catalog load keys must be unique',
      });
    }
    content.loadGuidance.forEach((guidance, index) => {
      const isCalibration = guidance.source === 'CALIBRATION';
      if (isCalibration !== (guidance.initialLoadKg === null)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['loadGuidance', index, 'initialLoadKg'],
          message: 'Only a CALIBRATION source may carry a null initial load',
        });
      }
    });

    const weekdays = content.schedule.days.map((day) => day.dayOfWeek);
    if (new Set(weekdays).size !== 7) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['schedule', 'days'],
        message: 'Schedule must contain each ISO weekday exactly once',
      });
    }

    const cardioByDay = new Map<number, number>();
    for (const session of content.cardio.sessions) {
      cardioByDay.set(
        session.dayOfWeek,
        (cardioByDay.get(session.dayOfWeek) ?? 0) + session.durationMin,
      );
    }
    let scheduledCardio = 0;
    content.schedule.days.forEach((day, index) => {
      const prescribed = cardioByDay.get(day.dayOfWeek) ?? 0;
      scheduledCardio += day.cardioMin;
      if (day.cardioMin !== prescribed) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['schedule', 'days', index, 'cardioMin'],
          message: 'Scheduled cardio minutes must match the prescribed sessions',
        });
      }
      if (day.strengthDayIndex === null) {
        if (day.kind === 'STRENGTH' || day.kind === 'STRENGTH_AND_CARDIO') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['schedule', 'days', index, 'kind'],
            message: 'A strength day classification requires a strength day index',
          });
        }
        return;
      }
      const strengthDay = content.strength.days[day.strengthDayIndex];
      if (!strengthDay) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['schedule', 'days', index, 'strengthDayIndex'],
          message: 'strengthDayIndex must reference a training day',
        });
        return;
      }
      if (strengthDay.dayOfWeek !== day.dayOfWeek) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['schedule', 'days', index, 'strengthDayIndex'],
          message: 'strengthDayIndex must reference a training day on the same weekday',
        });
      }
    });
    if (scheduledCardio !== content.cardio.additionalWeeklyMin) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cardio', 'additionalWeeklyMin'],
        message: 'Weekly cardio minutes must equal the scheduled total',
      });
    }

    const strengthWeekdays = content.strength.days.map((day) => day.dayOfWeek);
    if (new Set(strengthWeekdays).size !== strengthWeekdays.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['strength', 'days'],
        message: 'Training weekdays must be distinct',
      });
    }
    if (strengthWeekdays.some((weekday) => weekday === null || weekday === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['strength', 'days'],
        message: 'Every training day must have an assigned weekday',
      });
    }
  });

export type FitnessPlanContent = z.infer<typeof fitnessPlanContentSchema>;

export function parseFitnessPlanContent(value: unknown): FitnessPlanContent {
  return fitnessPlanContentSchema.parse(value);
}
