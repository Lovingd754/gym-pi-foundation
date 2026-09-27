import { Buffer } from 'node:buffer';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@/prisma/generated/client';
import {
  ExerciseCategory,
  EquipmentType,
  MessageRole,
  MuscleGroup,
  Sex,
  TrainingGoal,
  WeightUnit,
} from '@/lib/prisma-client';
import { db } from '@/lib/db';
import { ApiError, handleApiError, parseJsonBody, requireApiUserId } from '@/lib/api';
import {
  AVG_HR_MAX,
  AVG_HR_MIN,
  MAX_DISTANCE_M,
  MAX_DURATION_SEC,
  MAX_HR_MAX,
  MAX_HR_MIN,
} from '@/lib/cardio';
import { MAX_SUPERSET_GROUP, MIN_SUPERSET_GROUP } from '@/lib/supersets';
import { sorenessSchema } from '@/lib/schemas/readiness';
import { gymWeightListSchema } from '@/lib/schemas/gym';
import {
  GYM_EQUIPMENT_IMAGE_MIME_TYPES,
  MAX_GYM_EQUIPMENT_PER_GYM,
  decodeGymEquipmentImage,
} from '@/lib/gym-equipment';
import {
  clearanceSignalValues,
  eligibilityReasonCodeValues,
  eligibilityStatusValues,
  healthAnswersSchema,
  scopeSignalValues,
  temporarySignalValues,
  urgentSignalValues,
} from '@/lib/fitness/schemas';
import { exerciseCatalogKeys } from '@/lib/fitness/exercise-keys';
import { fitnessPlanContentSchema } from '@/lib/fitness/plan-schema';

// ============================================================
// Backup / Import JSON (LOT 11, completed by issue #168)
// ============================================================
// The export covers every entity tied to the user; the import recreates the
// content for the current user with fresh cuid ids (relations are re-linked
// by name), so it does not break uniqueness constraints or pollute another
// user.
//
// Export inventory - systematic check against prisma/schema.prisma. When a
// model or column is added to the schema, extend BOTH the export and the
// import below, bump VERSION, and keep older versions importable.
//
// Exported models and fields:
// - User: profile fields (displayName, bodyweight, sex, heightCm, goal,
//   weeklyFrequency, unit, deloadUntil). email/createdAt ride along for
//   reference but are NEVER imported (they identify the importing account).
// - Exercise: name, muscleGroup, category, defaultRestSec, notes,
//   usesBodyweight.
// - Program / Workout / ProgramExercise: all user content incl supersetGroup.
// - Session / Set: all user content incl durationSec, distanceM, avgHr.
// - Saved Gym profiles plus physical GymEquipment, equipment-to-exercise links,
//   and uploaded/external equipment images.
// - CoachSession, ExerciseGoal, BodyweightEntry, ReadinessCheckin,
//   Conversation / Message: all user content.
// - FitnessProfile / HealthScreening / FitnessGoal / FitnessPlanVersion /
//   FitnessPlanActivation (v6): the personalized-planning record, including the
//   immutable calculation input and the validated plan content. Plans reference
//   their screening/goal/Program by export-array index.
//
// Intentionally excluded:
// - User.id / email / passwordHash / createdAt (identity + credentials of the
//   importing account; restoring them would hijack or corrupt the account).
// - Every row id (regenerated on import; relations re-linked by name).
// - Program.createdAt / Program.updatedAt and Exercise.createdAt (server-side
//   bookkeeping with no user-facing meaning; reset to the import time).
// - User.fitnessOnboardingRequired (navigation state of the *source* account:
//   importing must never decide where the importing account lands next).
// - AgentRun / ToolInvocation audit rows and provider credentials.

const VERSION = 6;

// Hard cap on the import body size, enforced while reading the stream (the
// Content-Length header is attacker-controlled). Generous: a decade of daily
// training exports to a few MB.
const MAX_BACKUP_BYTES = 50 * 1024 * 1024;
const BACKUP_TOO_LARGE_MESSAGE =
  'This backup is larger than the maximum restorable backup size. Reduce uploaded gym equipment images and try again.';

// Export-array index of a related row, or null when the relation is absent (a
// `findIndex` miss must never be written as -1, which would import as invalid).
function indexOrNull(items: readonly { id: string }[], id: string | null): number | null {
  if (!id) return null;
  const index = items.findIndex((item) => item.id === id);
  return index < 0 ? null : index;
}

// GET /api/backup: returns an exportable JSON.
export async function GET() {
  try {
    const userId = await requireApiUserId();

    const [imageBudget] = await db.$queryRaw<Array<{ encodedBytes: bigint }>>`
      SELECT COALESCE(SUM(4 * CEIL(OCTET_LENGTH(e."imageData")::numeric / 3)), 0)::bigint AS "encodedBytes"
      FROM "GymEquipment" e
      INNER JOIN "Gym" g ON g.id = e."gymId"
      WHERE g."userId" = ${userId} AND e."imageData" IS NOT NULL
    `;
    if ((imageBudget?.encodedBytes ?? 0n) >= BigInt(MAX_BACKUP_BYTES)) {
      throw new ApiError(413, BACKUP_TOO_LARGE_MESSAGE);
    }

    const [
      user,
      programs,
      exercises,
      sessions,
      coachSessions,
      exerciseGoals,
      bodyweightEntries,
      readinessCheckins,
      conversations,
      gyms,
      fitnessProfile,
      healthScreenings,
      fitnessGoals,
      fitnessPlanVersions,
      fitnessActivation,
    ] = await Promise.all([
      db.user.findUnique({
        where: { id: userId },
        select: {
          email: true,
          createdAt: true,
          displayName: true,
          bodyweight: true,
          sex: true,
          heightCm: true,
          goal: true,
          weeklyFrequency: true,
          unit: true,
          deloadUntil: true,
          activeGymId: true,
        },
      }),
      db.program.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        include: {
          workouts: {
            orderBy: { order: 'asc' },
            include: {
              exercises: {
                orderBy: { order: 'asc' },
                include: { exercise: { select: { name: true } } },
              },
            },
          },
        },
      }),
      db.exercise.findMany({ where: { userId }, orderBy: { name: 'asc' } }),
      db.session.findMany({
        where: { userId },
        orderBy: { startedAt: 'asc' },
        include: {
          sets: {
            orderBy: [{ exerciseId: 'asc' }, { setNumber: 'asc' }],
            include: { gymEquipment: { select: { name: true } } },
          },
        },
      }),
      db.coachSession.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
      db.exerciseGoal.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        include: { exercise: { select: { name: true } } },
      }),
      db.bodyweightEntry.findMany({
        where: { userId },
        orderBy: { measuredAt: 'asc' },
      }),
      db.readinessCheckin.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      }),
      db.conversation.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        include: { messages: { orderBy: { createdAt: 'asc' } } },
      }),
      db.gym.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        include: {
          equipment: {
            orderBy: { name: 'asc' },
            include: { exerciseLinks: { include: { exercise: { select: { name: true } } } } },
          },
          exerciseConfigs: { include: { exercise: { select: { name: true } } } },
        },
      }),
      db.fitnessProfile.findUnique({ where: { userId } }),
      db.healthScreening.findMany({
        where: { userId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      db.fitnessGoal.findMany({
        where: { userId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      db.fitnessPlanVersion.findMany({ where: { userId }, orderBy: { version: 'asc' } }),
      db.fitnessPlanActivation.findUnique({ where: { userId } }),
    ]);

    if (!user) throw new ApiError(404, 'User not found.');

    const dump = {
      version: VERSION,
      exportedAt: new Date().toISOString(),
      user: { email: user.email, createdAt: user.createdAt },
      // Profile fields restored onto the importing account (new in v2).
      profile: {
        displayName: user.displayName,
        bodyweight: user.bodyweight,
        sex: user.sex,
        heightCm: user.heightCm,
        goal: user.goal,
        weeklyFrequency: user.weeklyFrequency,
        unit: user.unit,
        deloadUntil: user.deloadUntil?.toISOString() ?? null,
        activeGymName: gyms.find((gym) => gym.id === user.activeGymId)?.name ?? null,
      },
      exercises: exercises.map((e) => ({
        name: e.name,
        muscleGroup: e.muscleGroup,
        category: e.category,
        defaultRestSec: e.defaultRestSec,
        notes: e.notes,
        usesBodyweight: e.usesBodyweight,
        equipmentType: e.equipmentType,
      })),
      gyms: gyms.map((gym) => ({
        name: gym.name,
        dumbbellWeights: gym.dumbbellWeights,
        plateWeights: gym.plateWeights,
        barWeights: gym.barWeights,
        equipment: gym.equipment.map((item) => ({
          name: item.name,
          equipmentType: item.equipmentType,
          description: item.description,
          manufacturer: item.manufacturer,
          modelName: item.modelName,
          quantity: item.quantity,
          weightOptions: item.weightOptions,
          imageUrl: item.imageUrl,
          imageMimeType: item.imageMimeType,
          imageBase64: item.imageData ? Buffer.from(item.imageData).toString('base64') : null,
          exerciseNames: item.exerciseLinks.map((link) => link.exercise.name),
        })),
        exerciseConfigs: gym.exerciseConfigs.map((config) => ({
          exerciseName: config.exercise.name,
          isAvailable: config.isAvailable,
          weightOptions: config.weightOptions,
        })),
      })),
      programs: programs.map((p) => ({
        name: p.name,
        description: p.description,
        phase: p.phase,
        isActive: p.isActive,
        startDate: p.startDate.toISOString(),
        endDate: p.endDate?.toISOString() ?? null,
        workouts: p.workouts.map((w) => ({
          name: w.name,
          dayOfWeek: w.dayOfWeek,
          order: w.order,
          exercises: w.exercises.map((pe) => ({
            exerciseName: pe.exercise.name,
            order: pe.order,
            targetSets: pe.targetSets,
            targetRepsMin: pe.targetRepsMin,
            targetRepsMax: pe.targetRepsMax,
            targetRIR: pe.targetRIR,
            restSec: pe.restSec,
            autoregulationMode: pe.autoregulationMode,
            fatigueRate: pe.fatigueRate,
            loadAdjustmentPct: pe.loadAdjustmentPct,
            tempo: pe.tempo,
            notes: pe.notes,
            supersetGroup: pe.supersetGroup,
            // v6: managed load/progression metadata.
            initialLoadKg: pe.initialLoadKg,
            initialLoadSource: pe.initialLoadSource,
            progressionRuleVersion: pe.progressionRuleVersion,
            introTargetRIR: pe.introTargetRIR,
            introEndsAt: pe.introEndsAt?.toISOString() ?? null,
          })),
        })),
      })),
      sessions: sessions.map((s) => ({
        programName: programs.find((p) => p.id === s.programId)?.name ?? null,
        workoutName:
          programs.flatMap((p) => p.workouts).find((w) => w.id === s.workoutId)?.name ?? null,
        startedAt: s.startedAt.toISOString(),
        finishedAt: s.finishedAt?.toISOString() ?? null,
        notes: s.notes,
        gymName: gyms.find((gym) => gym.id === s.gymId)?.name ?? null,
        sets: s.sets.map((set) => ({
          exerciseName: exercises.find((e) => e.id === set.exerciseId)?.name ?? null,
          gymEquipmentName: set.gymEquipment?.name ?? null,
          equipmentNameSnapshot: set.equipmentNameSnapshot,
          equipmentLoadSnapshot: set.equipmentLoadSnapshot,
          setNumber: set.setNumber,
          weight: set.weight,
          reps: set.reps,
          rir: set.rir,
          durationSec: set.durationSec,
          distanceM: set.distanceM,
          avgHr: set.avgHr,
          maxHr: set.maxHr,
          notes: set.notes,
          isWarmup: set.isWarmup,
          isDropSet: set.isDropSet,
          completedAt: set.completedAt.toISOString(),
        })),
      })),
      coachSessions: coachSessions.map((c) => ({
        weekStart: c.weekStart.toISOString(),
        weekEnd: c.weekEnd.toISOString(),
        prompt: c.prompt,
        response: c.response,
        appliedAt: c.appliedAt?.toISOString() ?? null,
        createdAt: c.createdAt.toISOString(),
      })),
      exerciseGoals: exerciseGoals.map((g) => ({
        exerciseName: g.exercise.name,
        targetWeight: g.targetWeight,
        targetReps: g.targetReps,
        createdAt: g.createdAt.toISOString(),
        achievedAt: g.achievedAt?.toISOString() ?? null,
      })),
      bodyweightEntries: bodyweightEntries.map((b) => ({
        weightKg: b.weightKg,
        measuredAt: b.measuredAt.toISOString(),
        note: b.note,
      })),
      readinessCheckins: readinessCheckins.map((r) => ({
        readiness: r.readiness,
        sleepQuality: r.sleepQuality,
        soreness: r.soreness,
        note: r.note,
        createdAt: r.createdAt.toISOString(),
      })),
      conversations: conversations.map((c) => ({
        title: c.title,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
        messages: c.messages.map((m) => ({
          role: m.role,
          content: m.content,
          createdAt: m.createdAt.toISOString(),
        })),
      })),
      // v6: the personalized-planning record. Plans point at their screening,
      // goal and Program by index so the file stays free of database ids.
      fitness: {
        profile: fitnessProfile
          ? {
              ageYears: fitnessProfile.ageYears,
              displaySex: fitnessProfile.displaySex,
              energyEquationReference: fitnessProfile.energyEquationReference,
              bodyFatPct: fitnessProfile.bodyFatPct,
              trainingAgeMonths: fitnessProfile.trainingAgeMonths,
              weeklyFrequency: fitnessProfile.weeklyFrequency,
              availableWeekdays: fitnessProfile.availableWeekdays,
              sessionDurationMin: fitnessProfile.sessionDurationMin,
              equipmentTypes: fitnessProfile.equipmentTypes,
              recentMainLifts: fitnessProfile.recentMainLifts,
              activityLevel: fitnessProfile.activityLevel,
              avgDailySteps: fitnessProfile.avgDailySteps,
              currentModerateActivityMin: fitnessProfile.currentModerateActivityMin,
              habitualSleepMin: fitnessProfile.habitualSleepMin,
              bedtimeMin: fitnessProfile.bedtimeMin,
              wakeTimeMin: fitnessProfile.wakeTimeMin,
              timeZone: fitnessProfile.timeZone,
            }
          : null,
        screenings: healthScreenings.map((screening) => ({
          screeningVersion: screening.screeningVersion,
          rulesVersion: screening.rulesVersion,
          answers: screening.answers,
          status: screening.status,
          reasonCodes: screening.reasonCodes,
          attestedAt: screening.attestedAt.toISOString(),
          clearanceDate: screening.clearanceDate?.toISOString() ?? null,
          clearanceUnrestricted: screening.clearanceUnrestricted,
          clearanceRestrictions: screening.clearanceRestrictions,
          expiresAt: screening.expiresAt?.toISOString() ?? null,
          createdAt: screening.createdAt.toISOString(),
        })),
        goals: fitnessGoals.map((goal) => ({
          type: goal.type,
          desiredWeeklyRatePct: goal.desiredWeeklyRatePct,
          targetWeightKg: goal.targetWeightKg,
          targetDate: goal.targetDate?.toISOString() ?? null,
          status: goal.status,
          createdAt: goal.createdAt.toISOString(),
          supersededAt: goal.supersededAt?.toISOString() ?? null,
        })),
        plans: fitnessPlanVersions.map((plan) => ({
          screeningIndex: indexOrNull(healthScreenings, plan.healthScreeningId),
          goalIndex: indexOrNull(fitnessGoals, plan.goalId),
          version: plan.version,
          status: plan.status,
          rulesVersion: plan.rulesVersion,
          inputHash: plan.inputHash,
          profileUpdatedAt: plan.profileUpdatedAt.toISOString(),
          input: plan.input,
          content: plan.content,
          programIndex: indexOrNull(programs, plan.programId),
          createdAt: plan.createdAt.toISOString(),
          activatedAt: plan.activatedAt?.toISOString() ?? null,
        })),
        activation: fitnessActivation
          ? {
              planVersionIndex: indexOrNull(fitnessPlanVersions, fitnessActivation.planVersionId),
              revision: fitnessActivation.revision,
              activatedAt: fitnessActivation.activatedAt.toISOString(),
            }
          : null,
      },
    };

    const filename = `gympi-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const serialized = JSON.stringify(dump, null, 2);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_BACKUP_BYTES) {
      throw new ApiError(413, BACKUP_TOO_LARGE_MESSAGE);
    }
    return new NextResponse(serialized, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}

// ------------------------------------------------------------
// Import
// ------------------------------------------------------------
// The payload is untrusted user input (an uploaded file): every value is
// bounded, every date must parse, arrays are capped, and the whole body is
// size-capped while being read. Version 1 files (pre-#168) stay importable:
// every field/model added in v2 is optional and defaults to null/absent.

// A date string that must actually parse AND fall within PostgreSQL's
// timestamp range. JS Date.parse accepts dates far outside it (e.g. year
// 275760), which would pass Zod and then throw deep in Prisma as a 500; we
// reject them here so a malformed file is a clean 400 with the user's data
// untouched (the route's documented contract).
const dateString = z
  .string()
  .max(40)
  .refine(
    (s) => {
      const t = Date.parse(s);
      if (Number.isNaN(t)) return false;
      // Postgres timestamp years run 4713 BC .. 294276 AD; JS Date itself
      // caps at +/-8.64e15 ms. Bound to years [1, 9999] - well within both
      // and far beyond any real training date.
      const year = new Date(t).getUTCFullYear();
      return year >= 1 && year <= 9999;
    },
    { message: 'Invalid or out-of-range date' },
  );

// The sanitized calculation input we store on a plan version: the normalized
// assessment plus the eligibility decision, the calculation date, the gym
// constraints and the load evidence. It never contains a display name or
// clearance free text, and an uploaded file must match that shape exactly.
const sanitizedPlanInputSchema = z
  .object({
    rulesVersion: z.string().min(1).max(60),
    calculationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    assessment: z
      .object({
        profile: z
          .object({
            displayName: z.string().max(100).optional(),
            ageYears: z.number().int().min(0).max(120),
            displaySex: z.enum(['MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY']),
            energyEquationReference: z.enum(['MALE', 'FEMALE', 'UNSPECIFIED']),
            heightCm: z.number().int().min(120).max(230),
            weightKg: z.number().min(35).max(300),
            waistCm: z.number().min(40).max(220).optional(),
            bodyFatPct: z.number().min(3).max(70).optional(),
            trainingAgeMonths: z.number().int().min(0).max(600),
          })
          .strict(),
        goal: z
          .object({
            type: z.enum(['HYPERTROPHY', 'FAT_LOSS', 'RECOMP']),
            desiredWeeklyRatePct: z.number().min(-0.75).max(0.25),
            targetWeightKg: z.number().min(35).max(300).optional(),
            targetDate: z.string().max(40).optional(),
          })
          .strict(),
        schedule: z
          .object({
            weeklyFrequency: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
            availableWeekdays: z.array(z.number().int().min(1).max(7)).min(2).max(7),
            sessionDurationMin: z.number().int().min(30).max(120),
            equipmentTypes: z.array(z.nativeEnum(EquipmentType)).min(1).max(5),
            recentMainLifts: z
              .array(
                z
                  .object({
                    catalogKey: z.enum(exerciseCatalogKeys),
                    weightKg: z.number().min(0).max(1000),
                    reps: z.number().int().min(1).max(30),
                    rir: z.number().int().min(0).max(5),
                  })
                  .strict(),
              )
              .max(6),
          })
          .strict(),
        lifestyle: z
          .object({
            activityLevel: z.enum(['SEDENTARY', 'LIGHT', 'MODERATE', 'HIGH']),
            avgDailySteps: z.number().int().min(0).max(100000).optional(),
            currentModerateActivityMin: z.number().int().min(0).max(2000),
            habitualSleepMin: z.number().int().min(180).max(900),
            bedtimeMin: z.number().int().min(0).max(1439),
            wakeTimeMin: z.number().int().min(0).max(1439),
            timeZone: z.string().trim().min(1).max(100),
          })
          .strict(),
        health: z
          .object({
            urgentSignals: z.array(z.enum(urgentSignalValues)),
            clearanceSignals: z.array(z.enum(clearanceSignalValues)),
            temporarySignals: z.array(z.enum(temporarySignalValues)),
            scopeSignals: z.array(z.enum(scopeSignalValues)),
            healthChangedSinceClearance: z.boolean(),
            clearance: z
              .object({
                date: z.string().max(40),
                unrestricted: z.boolean(),
                restrictions: z.string().max(500).nullable(),
              })
              .strict()
              .optional(),
            attested: z.literal(true),
          })
          .strict(),
      })
      .strict(),
    eligibility: z
      .object({
        status: z.enum(eligibilityStatusValues),
        reasonCodes: z.array(z.enum(eligibilityReasonCodeValues)).max(20),
        clearanceExpiresAt: z.string().max(40).nullable(),
      })
      .strict(),
    gymConstraints: z
      .object({ unavailableExerciseNames: z.array(z.string().max(120)).max(200) })
      .strict(),
    loadGuidance: z
      .array(
        z
          .object({
            catalogKey: z.enum(exerciseCatalogKeys),
            source: z.enum(['APP_HISTORY', 'USER_REPORTED', 'CALIBRATION']),
            initialLoadKg: z.number().min(0).nullable(),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();

const importSchema = z.object({
  version: z.number().int().min(1).max(VERSION),
  exercises: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(120),
        // A legit export only ever contains valid enum values; rejecting the
        // rest here turns a Prisma 500 into a clean 400.
        muscleGroup: z.nativeEnum(MuscleGroup),
        category: z.nativeEnum(ExerciseCategory),
        defaultRestSec: z.number().int().min(15).max(600),
        notes: z.string().max(2000).nullable().optional(),
        // v2; absent in v1 backups.
        usesBodyweight: z.boolean().optional(),
        // v3; absent in older backups.
        equipmentType: z.nativeEnum(EquipmentType).optional(),
      }),
    )
    .max(2000),
  programs: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(200),
        description: z.string().max(5000).nullable().optional(),
        phase: z.string().max(100),
        isActive: z.boolean(),
        startDate: dateString,
        endDate: dateString.nullable().optional(),
        workouts: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(200),
              dayOfWeek: z.number().int().min(1).max(7).nullable().optional(),
              order: z.number().int().min(0).max(1000),
              exercises: z
                .array(
                  z.object({
                    exerciseName: z.string().max(120),
                    order: z.number().int().min(0).max(1000),
                    targetSets: z.number().int().min(1).max(20),
                    targetRepsMin: z.number().int().min(1).max(50),
                    targetRepsMax: z.number().int().min(1).max(50),
                    targetRIR: z.number().int().min(0).max(5),
                    restSec: z.number().int().min(15).max(600),
                    autoregulationMode: z.enum(['PRESERVE_RIR', 'PRESERVE_REPS']).optional(),
                    fatigueRate: z.number().min(0.25).max(2).nullable().optional(),
                    loadAdjustmentPct: z.number().min(1).max(5).nullable().optional(),
                    tempo: z.string().max(20).nullable().optional(),
                    notes: z.string().max(2000).nullable().optional(),
                    // v2; absent in v1 backups.
                    supersetGroup: z
                      .number()
                      .int()
                      .min(MIN_SUPERSET_GROUP)
                      .max(MAX_SUPERSET_GROUP)
                      .nullable()
                      .optional(),
                    // v6 managed load/progression metadata; absent before v6.
                    initialLoadKg: z.number().min(0).max(1000).nullable().optional(),
                    initialLoadSource: z
                      .enum(['APP_HISTORY', 'USER_REPORTED', 'CALIBRATION'])
                      .nullable()
                      .optional(),
                    progressionRuleVersion: z.string().max(60).nullable().optional(),
                    introTargetRIR: z.number().int().min(0).max(5).nullable().optional(),
                    introEndsAt: dateString.nullable().optional(),
                  }),
                )
                .max(200),
            }),
          )
          .max(100),
      }),
    )
    .max(200),
  sessions: z
    .array(
      z.object({
        programName: z.string().max(200).nullable().optional(),
        workoutName: z.string().max(200).nullable().optional(),
        startedAt: dateString,
        finishedAt: dateString.nullable().optional(),
        notes: z.string().max(5000).nullable().optional(),
        gymName: z.string().max(80).nullable().optional(),
        sets: z
          .array(
            z.object({
              exerciseName: z.string().max(120).nullable(),
              gymEquipmentName: z.string().max(120).nullable().optional(),
              equipmentNameSnapshot: z.string().max(120).nullable().optional(),
              equipmentLoadSnapshot: z.record(z.string(), z.unknown()).nullable().optional(),
              setNumber: z.number().int().min(1).max(1000),
              weight: z.number().min(0).max(5000),
              reps: z.number().int().min(0).max(1000),
              rir: z.number().int().min(0).max(10).nullable().optional(),
              // v2 cardio fields; absent in v1 backups.
              durationSec: z.number().int().min(1).max(MAX_DURATION_SEC).nullable().optional(),
              distanceM: z.number().min(0).max(MAX_DISTANCE_M).nullable().optional(),
              avgHr: z.number().int().min(AVG_HR_MIN).max(AVG_HR_MAX).nullable().optional(),
              maxHr: z.number().int().min(MAX_HR_MIN).max(MAX_HR_MAX).nullable().optional(),
              notes: z.string().max(2000).nullable().optional(),
              isWarmup: z.boolean(),
              isDropSet: z.boolean(),
              completedAt: dateString,
            }),
          )
          .max(1000),
      }),
    )
    .max(20000),
  coachSessions: z
    .array(
      z.object({
        weekStart: dateString,
        weekEnd: dateString,
        prompt: z.string().max(200_000),
        response: z.string().max(200_000),
        appliedAt: dateString.nullable().optional(),
        createdAt: dateString,
      }),
    )
    .max(5000)
    .optional(),
  // Everything below is new in v2 and absent from v1 backups.
  profile: z
    .object({
      displayName: z.string().trim().min(1).max(80).nullable().optional(),
      bodyweight: z.number().min(20).max(300).nullable().optional(),
      sex: z.nativeEnum(Sex).nullable().optional(),
      heightCm: z.number().int().min(100).max(250).nullable().optional(),
      goal: z.nativeEnum(TrainingGoal).nullable().optional(),
      weeklyFrequency: z.number().int().min(1).max(14).nullable().optional(),
      unit: z.nativeEnum(WeightUnit).optional(),
      deloadUntil: dateString.nullable().optional(),
      activeGymName: z.string().max(80).nullable().optional(),
    })
    .optional(),
  gyms: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(80),
        // Same normalization as the gym API (rounded, deduped, sorted), so an
        // imported file cannot store a weight array the UI would never write.
        dumbbellWeights: gymWeightListSchema,
        plateWeights: gymWeightListSchema,
        barWeights: gymWeightListSchema,
        equipment: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(120),
              equipmentType: z.nativeEnum(EquipmentType),
              description: z.string().max(4000).nullable().optional(),
              manufacturer: z.string().max(120).nullable().optional(),
              modelName: z.string().max(120).nullable().optional(),
              quantity: z.number().int().min(1).max(100),
              weightOptions: gymWeightListSchema,
              imageUrl: z
                .string()
                .url()
                .max(2048)
                .nullable()
                .optional()
                .refine((value) => value == null || value.startsWith('https://'), {
                  message: 'Equipment image URL must use HTTPS.',
                }),
              imageMimeType: z.enum(GYM_EQUIPMENT_IMAGE_MIME_TYPES).nullable().optional(),
              imageBase64: z.string().max(7_100_000).nullable().optional(),
              exerciseNames: z.array(z.string().max(120)).max(100),
            }),
          )
          .max(MAX_GYM_EQUIPMENT_PER_GYM)
          .optional(),
        exerciseConfigs: z
          .array(
            z.object({
              exerciseName: z.string().max(120),
              isAvailable: z.boolean(),
              weightOptions: gymWeightListSchema,
            }),
          )
          .max(2000),
      }),
    )
    .max(100)
    .optional(),
  exerciseGoals: z
    .array(
      z.object({
        exerciseName: z.string().max(120),
        targetWeight: z.number().positive().max(1000),
        targetReps: z.number().int().min(1).max(100),
        createdAt: dateString,
        achievedAt: dateString.nullable().optional(),
      }),
    )
    .max(2000)
    .optional(),
  bodyweightEntries: z
    .array(
      z.object({
        weightKg: z.number().min(20).max(300),
        measuredAt: dateString,
        note: z.string().max(500).nullable().optional(),
      }),
    )
    .max(20000)
    .optional(),
  readinessCheckins: z
    .array(
      z.object({
        readiness: z.number().int().min(1).max(5),
        sleepQuality: z.number().int().min(1).max(5),
        soreness: sorenessSchema,
        note: z.string().max(500).nullable().optional(),
        createdAt: dateString,
      }),
    )
    .max(20000)
    .optional(),
  conversations: z
    .array(
      z.object({
        title: z.string().max(200).nullable().optional(),
        createdAt: dateString,
        updatedAt: dateString,
        messages: z
          .array(
            z.object({
              role: z.nativeEnum(MessageRole),
              content: z.string().max(200_000),
              createdAt: dateString,
            }),
          )
          .max(2000),
      }),
    )
    .max(2000)
    .optional(),
  // v6: personalized-planning record. Optional so every v1-v5 file keeps
  // importing; the arrays carry the user's own screening answers, goals, plan
  // snapshots and activation pointer, all re-validated on the way in.
  fitness: z
    .object({
      profile: z
        .object({
          ageYears: z.number().int().min(0).max(120),
          displaySex: z.enum(['MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY']),
          energyEquationReference: z.enum(['MALE', 'FEMALE', 'UNSPECIFIED']),
          bodyFatPct: z.number().min(3).max(70).nullable().optional(),
          trainingAgeMonths: z.number().int().min(0).max(600),
          weeklyFrequency: z.number().int().min(2).max(5),
          availableWeekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
          sessionDurationMin: z.number().int().min(30).max(120),
          equipmentTypes: z.array(z.nativeEnum(EquipmentType)).min(1).max(5),
          recentMainLifts: z.array(z.unknown()).max(6),
          activityLevel: z.enum(['SEDENTARY', 'LIGHT', 'MODERATE', 'HIGH']),
          avgDailySteps: z.number().int().min(0).max(100000).nullable().optional(),
          currentModerateActivityMin: z.number().int().min(0).max(2000),
          habitualSleepMin: z.number().int().min(180).max(900),
          bedtimeMin: z.number().int().min(0).max(1439),
          wakeTimeMin: z.number().int().min(0).max(1439),
          timeZone: z.string().trim().min(1).max(100),
        })
        .nullable(),
      screenings: z
        .array(
          z.object({
            screeningVersion: z.string().min(1).max(60),
            rulesVersion: z.string().min(1).max(60),
            // Reuses the runtime contract rather than a loose object: a file
            // with an unknown signal or a missing attestation is rejected.
            answers: healthAnswersSchema,
            status: z.enum(eligibilityStatusValues),
            reasonCodes: z.array(z.enum(eligibilityReasonCodeValues)).max(20),
            attestedAt: dateString,
            clearanceDate: dateString.nullable().optional(),
            clearanceUnrestricted: z.boolean().nullable().optional(),
            clearanceRestrictions: z.string().max(500).nullable().optional(),
            expiresAt: dateString.nullable().optional(),
            createdAt: dateString,
          }),
        )
        .max(200),
      goals: z
        .array(
          z.object({
            type: z.enum(['HYPERTROPHY', 'FAT_LOSS', 'RECOMP']),
            desiredWeeklyRatePct: z.number().min(-0.75).max(0.25),
            targetWeightKg: z.number().min(35).max(300).nullable().optional(),
            targetDate: dateString.nullable().optional(),
            status: z.enum(['ACTIVE', 'SUPERSEDED']),
            createdAt: dateString,
            supersededAt: dateString.nullable().optional(),
          }),
        )
        .max(200),
      plans: z
        .array(
          z.object({
            screeningIndex: z.number().int().min(0),
            goalIndex: z.number().int().min(0),
            version: z.number().int().min(1).max(100000),
            status: z.enum(['DRAFT', 'ACTIVE', 'SUPERSEDED']),
            rulesVersion: z.string().min(1).max(60),
            inputHash: z.string().min(1).max(200),
            profileUpdatedAt: dateString,
            input: sanitizedPlanInputSchema,
            content: fitnessPlanContentSchema,
            programIndex: z.number().int().min(0).nullable(),
            createdAt: dateString,
            activatedAt: dateString.nullable().optional(),
          }),
        )
        .max(200),
      activation: z
        .object({
          planVersionIndex: z.number().int().min(0).nullable(),
          revision: z.number().int().min(0),
          activatedAt: dateString,
        })
        .nullable()
        .optional(),
    })
    .optional(),
});

const importBodySchema = z.object({
  payload: importSchema,
  // Explicit confirmation: replaces all data of the current user.
  confirmReplace: z.literal(true),
});

// Cross-field validation of the v6 fitness record, run before any write. A
// backup that contradicts itself is rejected as a whole: we never repair a plan
// status, invent a relation, or activate a program the file did not mark active.
function assertFitnessBackupConsistent(payload: z.infer<typeof importSchema>): void {
  const fitness = payload.fitness;
  if (!fitness) return;

  const versions = fitness.plans.map((plan) => plan.version);
  if (new Set(versions).size !== versions.length) {
    throw new ApiError(400, 'Duplicate fitness plan version in backup.');
  }
  if (fitness.goals.filter((goal) => goal.status === 'ACTIVE').length > 1) {
    throw new ApiError(400, 'Backup contains more than one ACTIVE fitness goal.');
  }
  const activePlans = fitness.plans.filter((plan) => plan.status === 'ACTIVE');
  if (activePlans.length > 1) {
    throw new ApiError(400, 'Backup contains more than one ACTIVE fitness plan.');
  }
  for (const plan of fitness.plans) {
    if (!fitness.profile) {
      throw new ApiError(400, 'A fitness plan requires a planning profile.');
    }
    if (plan.screeningIndex >= fitness.screenings.length) {
      throw new ApiError(400, 'Fitness plan references a missing health screening.');
    }
    if (plan.goalIndex >= fitness.goals.length) {
      throw new ApiError(400, 'Fitness plan references a missing goal.');
    }
    if (plan.programIndex !== null && plan.programIndex >= payload.programs.length) {
      throw new ApiError(400, 'Fitness plan references a missing program.');
    }
  }

  const activation = fitness.activation ?? null;
  if (!activation) {
    if (activePlans.length > 0) {
      throw new ApiError(400, 'An ACTIVE fitness plan requires an activation pointer.');
    }
    return;
  }
  if (activation.planVersionIndex === null) {
    if (activePlans.length > 0) {
      throw new ApiError(400, 'A null activation pointer cannot coexist with an ACTIVE plan.');
    }
    return;
  }
  const referenced = fitness.plans[activation.planVersionIndex];
  if (!referenced) throw new ApiError(400, 'Activation references a missing fitness plan.');
  if (referenced.status !== 'ACTIVE') {
    throw new ApiError(400, 'Activation must reference an ACTIVE fitness plan.');
  }
  if (referenced.programIndex !== null && !payload.programs[referenced.programIndex]?.isActive) {
    throw new ApiError(400, 'The activated plan must reference the active program.');
  }
}

// POST /api/backup: clears the current user's data and recreates it from the
// payload. Atomic: everything runs in a Prisma transaction, so a failure
// rolls back to the pre-import state.
export async function POST(req: Request) {
  try {
    const userId = await requireApiUserId();
    const { payload } = await parseJsonBody(req, importBodySchema, {
      maxBytes: MAX_BACKUP_BYTES,
    });

    // Validate and decode equipment images before taking purge locks so a
    // malformed or hand-edited backup fails before any replacement work starts.
    const preparedEquipmentByGymName = new Map<
      string,
      Array<{
        item: NonNullable<NonNullable<typeof payload.gyms>[number]['equipment']>[number];
        decoded: ReturnType<typeof decodeGymEquipmentImage> | null;
      }>
    >();
    const seenGymNames = new Set<string>();
    for (const gym of payload.gyms ?? []) {
      if (seenGymNames.has(gym.name)) continue;
      seenGymNames.add(gym.name);
      const seenEquipmentNames = new Set<string>();
      const prepared = [] as NonNullable<ReturnType<typeof preparedEquipmentByGymName.get>>;
      for (const item of gym.equipment ?? []) {
        const equipmentNameKey = item.name.toLocaleLowerCase('en-US');
        if (seenEquipmentNames.has(equipmentNameKey)) {
          throw new ApiError(400, `Duplicate gym equipment name in backup: ${item.name}`);
        }
        seenEquipmentNames.add(equipmentNameKey);
        const decoded = item.imageBase64
          ? decodeGymEquipmentImage(item.imageBase64, item.imageMimeType ?? undefined)
          : null;
        prepared.push({ item, decoded });
      }
      preparedEquipmentByGymName.set(gym.name, prepared);
    }

    assertFitnessBackupConsistent(payload);

    await db.$transaction(
      async (tx) => {
        // 1. Purge the user's existing data. Order matters where there is no
        //    cascade: sets before sessions and exercises, goals before
        //    exercises. Conversations cascade their messages; programs
        //    cascade workouts and program exercises.
        await tx.set.deleteMany({ where: { session: { userId } } });
        await tx.session.deleteMany({ where: { userId } });
        await tx.gym.deleteMany({ where: { userId } });
        await tx.coachSession.deleteMany({ where: { userId } });
        await tx.exerciseGoal.deleteMany({ where: { userId } });
        await tx.bodyweightEntry.deleteMany({ where: { userId } });
        await tx.readinessCheckin.deleteMany({ where: { userId } });
        await tx.conversation.deleteMany({ where: { userId } });
        // v6 fitness rows: the plan versions hold Restrict foreign keys to the
        // profile/screening/goal rows and point at Programs, so they (and the
        // activation pointer) must go before any of those.
        await tx.fitnessPlanActivation.deleteMany({ where: { userId } });
        await tx.fitnessPlanVersion.deleteMany({ where: { userId } });
        await tx.fitnessGoal.deleteMany({ where: { userId } });
        await tx.healthScreening.deleteMany({ where: { userId } });
        await tx.fitnessProfile.deleteMany({ where: { userId } });
        // workouts/programExercises cascade via Program.
        await tx.program.deleteMany({ where: { userId } });
        await tx.exercise.deleteMany({ where: { userId } });

        // 2. Profile (v2): restore onto the current account. Identity fields
        //    (email, password) are never touched.
        if (payload.profile) {
          const p = payload.profile;
          await tx.user.update({
            where: { id: userId },
            data: {
              ...(p.displayName !== undefined ? { displayName: p.displayName } : {}),
              ...(p.bodyweight !== undefined ? { bodyweight: p.bodyweight } : {}),
              ...(p.sex !== undefined ? { sex: p.sex } : {}),
              ...(p.heightCm !== undefined ? { heightCm: p.heightCm } : {}),
              ...(p.goal !== undefined ? { goal: p.goal } : {}),
              ...(p.weeklyFrequency !== undefined ? { weeklyFrequency: p.weeklyFrequency } : {}),
              ...(p.unit !== undefined ? { unit: p.unit } : {}),
              ...(p.deloadUntil !== undefined
                ? { deloadUntil: p.deloadUntil ? new Date(p.deloadUntil) : null }
                : {}),
            },
          });
        }

        // 3. Recreate the exercises; we keep a name -> id index to link them.
        const exerciseIdByName = new Map<string, string>();
        for (const e of payload.exercises) {
          const created = await tx.exercise.create({
            data: {
              userId,
              name: e.name,
              muscleGroup: e.muscleGroup,
              category: e.category,
              defaultRestSec: e.defaultRestSec,
              notes: e.notes ?? null,
              usesBodyweight: e.usesBodyweight ?? false,
              equipmentType: e.equipmentType ?? 'OTHER',
            },
          });
          exerciseIdByName.set(e.name, created.id);
        }

        // 4. Saved gyms are recreated after exercises so per-exercise
        // availability can be linked by exercise name. Gym names are unique
        // per user, so a hand-edited file carrying the same name twice would
        // abort the whole restore: keep the first occurrence and skip the
        // rest instead of failing.
        const gymIdByName = new Map<string, string>();
        const gymEquipmentIdByGymAndName = new Map<string, string>();
        for (const gym of payload.gyms ?? []) {
          if (gymIdByName.has(gym.name)) continue;
          const configs = gym.exerciseConfigs.flatMap((config) => {
            const exerciseId = exerciseIdByName.get(config.exerciseName);
            return exerciseId
              ? [
                  {
                    exerciseId,
                    isAvailable: config.isAvailable,
                    weightOptions: config.weightOptions,
                  },
                ]
              : [];
          });
          const created = await tx.gym.create({
            data: {
              userId,
              name: gym.name,
              dumbbellWeights: gym.dumbbellWeights,
              plateWeights: gym.plateWeights,
              barWeights: gym.barWeights,
              exerciseConfigs: { createMany: { data: configs } },
            },
          });
          const preparedEquipment = preparedEquipmentByGymName.get(gym.name) ?? [];
          const createdEquipment =
            preparedEquipment.length > 0
              ? await tx.gymEquipment.createManyAndReturn({
                  data: preparedEquipment.map(({ item, decoded }) => ({
                    gymId: created.id,
                    name: item.name,
                    equipmentType: item.equipmentType,
                    description: item.description ?? null,
                    manufacturer: item.manufacturer ?? null,
                    modelName: item.modelName ?? null,
                    quantity: item.quantity,
                    weightOptions: item.weightOptions,
                    imageUrl: decoded ? null : (item.imageUrl ?? null),
                    imageData: decoded?.bytes,
                    imageMimeType: decoded?.mimeType ?? null,
                  })),
                  select: { id: true, name: true },
                })
              : [];
          const equipmentIdByName = new Map(createdEquipment.map((item) => [item.name, item.id]));
          for (const item of createdEquipment) {
            gymEquipmentIdByGymAndName.set(JSON.stringify([gym.name, item.name]), item.id);
          }
          const equipmentExerciseLinks = preparedEquipment.flatMap(({ item }) => {
            const equipmentId = equipmentIdByName.get(item.name);
            if (!equipmentId) return [];
            return [
              ...new Set(
                item.exerciseNames.flatMap((name) => {
                  const exerciseId = exerciseIdByName.get(name);
                  return exerciseId ? [exerciseId] : [];
                }),
              ),
            ].map((exerciseId) => ({ equipmentId, exerciseId }));
          });
          if (equipmentExerciseLinks.length > 0) {
            await tx.gymEquipmentExercise.createMany({ data: equipmentExerciseLinks });
          }
          gymIdByName.set(gym.name, created.id);
        }
        const activeGymId = payload.profile?.activeGymName
          ? (gymIdByName.get(payload.profile.activeGymName) ?? null)
          : null;
        if (payload.gyms) {
          await tx.user.update({ where: { id: userId }, data: { activeGymId } });
        }

        // 5. Recreate programs / workouts / programExercises. The source index
        //    of each Program is kept so the fitness plan restore below can point
        //    a plan at the Program it was activated with.
        const programIdByIndex = new Map<number, string>();
        for (const [programIndex, p] of payload.programs.entries()) {
          const program = await tx.program.create({
            data: {
              userId,
              name: p.name,
              description: p.description ?? null,
              phase: p.phase,
              isActive: p.isActive,
              startDate: new Date(p.startDate),
              endDate: p.endDate ? new Date(p.endDate) : null,
            },
          });
          programIdByIndex.set(programIndex, program.id);
          for (const w of p.workouts) {
            const workout = await tx.workout.create({
              data: {
                programId: program.id,
                name: w.name,
                dayOfWeek: w.dayOfWeek ?? null,
                order: w.order,
              },
            });
            for (const pe of w.exercises) {
              const exId = exerciseIdByName.get(pe.exerciseName);
              if (!exId) continue;
              await tx.programExercise.create({
                data: {
                  workoutId: workout.id,
                  exerciseId: exId,
                  order: pe.order,
                  targetSets: pe.targetSets,
                  targetRepsMin: pe.targetRepsMin,
                  targetRepsMax: pe.targetRepsMax,
                  targetRIR: pe.targetRIR,
                  restSec: pe.restSec,
                  autoregulationMode: pe.autoregulationMode ?? 'PRESERVE_RIR',
                  fatigueRate: pe.fatigueRate ?? null,
                  loadAdjustmentPct: pe.loadAdjustmentPct ?? null,
                  tempo: pe.tempo ?? null,
                  notes: pe.notes ?? null,
                  supersetGroup: pe.supersetGroup ?? null,
                  // Managed metadata exists only from v6; older files keep the
                  // legacy nulls so their progression stays one-exposure.
                  initialLoadKg: payload.version >= 6 ? (pe.initialLoadKg ?? null) : null,
                  initialLoadSource: payload.version >= 6 ? (pe.initialLoadSource ?? null) : null,
                  progressionRuleVersion:
                    payload.version >= 6 ? (pe.progressionRuleVersion ?? null) : null,
                  introTargetRIR: payload.version >= 6 ? (pe.introTargetRIR ?? null) : null,
                  introEndsAt:
                    payload.version >= 6 && pe.introEndsAt ? new Date(pe.introEndsAt) : null,
                },
              });
            }
          }
        }

        // 6. Sessions + sets: we try to link to the program/workout by name,
        //    but accept leaving them nullable if not found.
        const programs = await tx.program.findMany({
          where: { userId },
          include: { workouts: true },
        });
        const programByName = new Map(programs.map((p) => [p.name, p]));

        for (const s of payload.sessions) {
          const program = s.programName ? programByName.get(s.programName) : null;
          const workout = s.workoutName
            ? program?.workouts.find((w) => w.name === s.workoutName)
            : null;
          const session = await tx.session.create({
            data: {
              userId,
              programId: program?.id ?? null,
              workoutId: workout?.id ?? null,
              startedAt: new Date(s.startedAt),
              finishedAt: s.finishedAt ? new Date(s.finishedAt) : null,
              notes: s.notes ?? null,
              gymId: s.gymName ? (gymIdByName.get(s.gymName) ?? null) : null,
            },
          });
          const setRows = s.sets.flatMap((set) => {
            const exId = set.exerciseName ? exerciseIdByName.get(set.exerciseName) : undefined;
            if (!exId) return [];
            return [
              {
                sessionId: session.id,
                exerciseId: exId,
                gymEquipmentId:
                  s.gymName && set.gymEquipmentName
                    ? (gymEquipmentIdByGymAndName.get(
                        JSON.stringify([s.gymName, set.gymEquipmentName]),
                      ) ?? null)
                    : null,
                equipmentNameSnapshot: set.equipmentNameSnapshot ?? null,
                equipmentLoadSnapshot:
                  set.equipmentLoadSnapshot == null
                    ? Prisma.JsonNull
                    : (set.equipmentLoadSnapshot as Prisma.InputJsonValue),
                setNumber: set.setNumber,
                weight: set.weight,
                reps: set.reps,
                rir: set.rir ?? null,
                durationSec: set.durationSec ?? null,
                distanceM: set.distanceM ?? null,
                avgHr: set.avgHr ?? null,
                maxHr: set.maxHr ?? null,
                notes: set.notes ?? null,
                isWarmup: set.isWarmup,
                isDropSet: set.isDropSet,
                completedAt: new Date(set.completedAt),
              },
            ];
          });
          if (setRows.length > 0) await tx.set.createMany({ data: setRows });
        }

        for (const c of payload.coachSessions ?? []) {
          await tx.coachSession.create({
            data: {
              userId,
              weekStart: new Date(c.weekStart),
              weekEnd: new Date(c.weekEnd),
              prompt: c.prompt,
              response: c.response,
              appliedAt: c.appliedAt ? new Date(c.appliedAt) : null,
              createdAt: new Date(c.createdAt),
            },
          });
        }

        // 7. Goals / bodyweight / readiness / conversations (v2). A goal
        //    whose exercise is unknown is skipped, like sets above.
        const goalRows = (payload.exerciseGoals ?? []).flatMap((g) => {
          const exId = exerciseIdByName.get(g.exerciseName);
          if (!exId) return [];
          return [
            {
              userId,
              exerciseId: exId,
              targetWeight: g.targetWeight,
              targetReps: g.targetReps,
              createdAt: new Date(g.createdAt),
              achievedAt: g.achievedAt ? new Date(g.achievedAt) : null,
            },
          ];
        });
        if (goalRows.length > 0) {
          // One goal per (user, exercise): duplicates in the file would break
          // the unique constraint, so keep the last one per exercise.
          const lastPerExercise = new Map(goalRows.map((g) => [g.exerciseId, g]));
          await tx.exerciseGoal.createMany({
            data: Array.from(lastPerExercise.values()),
          });
        }

        const bodyweightRows = (payload.bodyweightEntries ?? []).map((b) => ({
          userId,
          weightKg: b.weightKg,
          measuredAt: new Date(b.measuredAt),
          note: b.note ?? null,
        }));
        if (bodyweightRows.length > 0) {
          await tx.bodyweightEntry.createMany({ data: bodyweightRows });
        }

        const readinessRows = (payload.readinessCheckins ?? []).map((r) => ({
          userId,
          readiness: r.readiness,
          sleepQuality: r.sleepQuality,
          soreness: r.soreness ?? undefined,
          note: r.note ?? null,
          createdAt: new Date(r.createdAt),
        }));
        if (readinessRows.length > 0) {
          await tx.readinessCheckin.createMany({ data: readinessRows });
        }

        for (const c of payload.conversations ?? []) {
          const conversation = await tx.conversation.create({
            data: {
              userId,
              title: c.title ?? null,
              createdAt: new Date(c.createdAt),
              updatedAt: new Date(c.updatedAt),
            },
          });
          if (c.messages.length > 0) {
            await tx.message.createMany({
              data: c.messages.map((m) => ({
                conversationId: conversation.id,
                role: m.role,
                content: m.content,
                createdAt: new Date(m.createdAt),
              })),
            });
          }
        }

        // 8. Fitness planning record (v6): profile, screenings, goals, plan
        //    versions and the activation pointer, in dependency order.
        const fitness = payload.fitness;
        if (fitness) {
          const profile = fitness.profile
            ? await tx.fitnessProfile.create({
                data: {
                  userId,
                  ageYears: fitness.profile.ageYears,
                  displaySex: fitness.profile.displaySex,
                  energyEquationReference: fitness.profile.energyEquationReference,
                  bodyFatPct: fitness.profile.bodyFatPct ?? null,
                  trainingAgeMonths: fitness.profile.trainingAgeMonths,
                  weeklyFrequency: fitness.profile.weeklyFrequency,
                  availableWeekdays: fitness.profile.availableWeekdays,
                  sessionDurationMin: fitness.profile.sessionDurationMin,
                  equipmentTypes: fitness.profile.equipmentTypes,
                  recentMainLifts: fitness.profile.recentMainLifts as Prisma.InputJsonValue,
                  activityLevel: fitness.profile.activityLevel,
                  avgDailySteps: fitness.profile.avgDailySteps ?? null,
                  currentModerateActivityMin: fitness.profile.currentModerateActivityMin,
                  habitualSleepMin: fitness.profile.habitualSleepMin,
                  bedtimeMin: fitness.profile.bedtimeMin,
                  wakeTimeMin: fitness.profile.wakeTimeMin,
                  timeZone: fitness.profile.timeZone,
                },
              })
            : null;

          const screeningIds: string[] = [];
          for (const screening of fitness.screenings) {
            const created = await tx.healthScreening.create({
              data: {
                userId,
                screeningVersion: screening.screeningVersion,
                rulesVersion: screening.rulesVersion,
                answers: screening.answers,
                status: screening.status,
                reasonCodes: screening.reasonCodes,
                attestedAt: new Date(screening.attestedAt),
                clearanceDate: screening.clearanceDate ? new Date(screening.clearanceDate) : null,
                clearanceUnrestricted: screening.clearanceUnrestricted ?? null,
                clearanceRestrictions: screening.clearanceRestrictions ?? null,
                expiresAt: screening.expiresAt ? new Date(screening.expiresAt) : null,
                createdAt: new Date(screening.createdAt),
              },
            });
            screeningIds.push(created.id);
          }

          const goalIds: string[] = [];
          for (const goal of fitness.goals) {
            const created = await tx.fitnessGoal.create({
              data: {
                userId,
                type: goal.type,
                desiredWeeklyRatePct: goal.desiredWeeklyRatePct,
                targetWeightKg: goal.targetWeightKg ?? null,
                targetDate: goal.targetDate ? new Date(goal.targetDate) : null,
                status: goal.status,
                createdAt: new Date(goal.createdAt),
                supersededAt: goal.supersededAt ? new Date(goal.supersededAt) : null,
              },
            });
            goalIds.push(created.id);
          }

          const planIds: string[] = [];
          for (const plan of fitness.plans) {
            const created = await tx.fitnessPlanVersion.create({
              data: {
                userId,
                profileId: profile!.id,
                healthScreeningId: screeningIds[plan.screeningIndex]!,
                goalId: goalIds[plan.goalIndex]!,
                version: plan.version,
                status: plan.status,
                rulesVersion: plan.rulesVersion,
                inputHash: plan.inputHash,
                profileUpdatedAt: new Date(plan.profileUpdatedAt),
                input: plan.input as Prisma.InputJsonValue,
                content: plan.content as unknown as Prisma.InputJsonValue,
                programId:
                  plan.programIndex === null
                    ? null
                    : (programIdByIndex.get(plan.programIndex) ?? null),
                createdAt: new Date(plan.createdAt),
                activatedAt: plan.activatedAt ? new Date(plan.activatedAt) : null,
              },
            });
            planIds.push(created.id);
          }

          if (fitness.activation) {
            await tx.fitnessPlanActivation.create({
              data: {
                userId,
                planVersionId:
                  fitness.activation.planVersionIndex === null
                    ? null
                    : (planIds[fitness.activation.planVersionIndex] ?? null),
                revision: fitness.activation.revision,
                activatedAt: new Date(fitness.activation.activatedAt),
              },
            });
          }
        }

        // 9. The import always lands the account inside the app: onboarding
        //    state belongs to the importing session, never to the file.
        await tx.user.update({
          where: { id: userId },
          data: { fitnessOnboardingRequired: false },
        });
      },
      { timeout: 60_000 },
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
