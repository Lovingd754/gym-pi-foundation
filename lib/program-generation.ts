import type { Prisma } from '@/prisma/generated/client';
import { db } from '@/lib/db';
import { STRENGTH_EXERCISE_CATALOG } from '@/lib/fitness/exercise-catalog';
import { exerciseCatalogKeys, type ExerciseCatalogKey } from '@/lib/fitness/exercise-keys';
import { LlmError } from '@/lib/llm';
import { getLlmProviderFor } from '@/lib/llm/settings';
import { PROGRAM_GEN_SYSTEM_PROMPT } from '@/lib/prompts/program-system-prompt';
import { parseGeneratedProgram, type GeneratedProgram } from '@/lib/schemas/program-generation';
import { defaultIntraSetConfig } from '@/lib/intra-set-autoregulation';

// ============================================================
// Materializing a generated program
// ============================================================
// The managed fitness baseline reuses this path so a personalized plan lands in
// the same Program/Workout/ProgramExercise tables the rest of the app already
// reads. The optional `fitness` block is what turns on managed metadata; without
// it the behavior is byte-for-byte the legacy template/AI path.

export type MaterializeFitnessOptions = {
  loadGuidance: ReadonlyArray<{
    catalogKey: string;
    source: 'APP_HISTORY' | 'USER_REPORTED' | 'CALIBRATION';
    initialLoadKg: number | null;
  }>;
  introRir: 3 | null;
  introDurationDays: 14 | 0;
  activatedAt: Date;
};

const INTRO_DURATION_MS = 14 * 86_400_000;
const catalogNotePrefix = 'catalog:';
const catalogKeySet = new Set<string>(exerciseCatalogKeys);
const catalogByKey = new Map(STRENGTH_EXERCISE_CATALOG.map((entry) => [entry.key, entry]));

// Generates a structured program draft from a natural-language goal. Does not
// persist anything: the result is previewed (and edited) before saving.
export async function generateProgram(userId: string, goal: string): Promise<GeneratedProgram> {
  const provider = await getLlmProviderFor(userId);

  const [user, exercises] = await Promise.all([
    db.user.findUnique({
      where: { id: userId },
      select: {
        sex: true,
        heightCm: true,
        bodyweight: true,
        goal: true,
        weeklyFrequency: true,
      },
    }),
    db.exercise.findMany({
      where: { userId },
      select: { name: true, muscleGroup: true, category: true, equipmentType: true },
      orderBy: { name: 'asc' },
    }),
  ]);

  const context = {
    profile: {
      sex: user?.sex ?? null,
      heightCm: user?.heightCm ?? null,
      bodyweight: user?.bodyweight ?? null,
      goal: user?.goal ?? null,
      weeklyFrequency: user?.weeklyFrequency ?? null,
    },
    availableExercises: exercises,
  };

  const userMessage = `User goal:\n${goal}\n\nContext (JSON):\n${JSON.stringify(context, null, 2)}`;

  const { text } = await provider.complete({
    system: PROGRAM_GEN_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
    maxTokens: 8000,
  });

  const parsed = parseGeneratedProgram(text);
  if (!parsed.ok) {
    throw new LlmError(502, `The generated program could not be parsed: ${parsed.error}`);
  }
  return parsed.program;
}

// Persists a (possibly user-edited) generated program in a single transaction.
// New exercises are created on the fly; existing ones are reused by name.
// Returns the new program id. The program is created inactive.
export async function buildProgramFromGenerated(
  userId: string,
  program: GeneratedProgram,
): Promise<string> {
  return db.$transaction((tx) => materializeProgram(tx, userId, program));
}

// Persists a generated program using an already-open transaction. New
// exercises are created on the fly; existing ones are reused by name without
// overwriting the user's own metadata.
export async function materializeProgram(
  tx: Prisma.TransactionClient,
  userId: string,
  program: GeneratedProgram,
  options?: { fitness?: MaterializeFitnessOptions },
): Promise<string> {
  const fitness = options?.fitness ?? null;
  // Validate every catalog assignment before the first write so a bad plan can
  // never leave a half-materialized Program behind.
  const assignments = fitness ? planCatalogAssignments(program, fitness) : null;
  const guidanceByKey = fitness
    ? new Map(fitness.loadGuidance.map((entry) => [entry.catalogKey, entry]))
    : null;
  const introEndsAt =
    fitness && fitness.introDurationDays === 14
      ? new Date(fitness.activatedAt.getTime() + INTRO_DURATION_MS)
      : null;

  const created = await tx.program.create({
    data: {
      userId,
      name: program.name,
      description: program.description ?? null,
      phase: program.phase,
      isActive: false,
    },
  });

  let workoutOrder = 1;
  for (const [workoutIndex, w] of program.workouts.entries()) {
    const workout = await tx.workout.create({
      data: {
        programId: created.id,
        name: w.name,
        dayOfWeek: w.dayOfWeek ?? null,
        order: workoutOrder++,
      },
    });

    let exerciseOrder = 1;
    for (const [exerciseIndex, ex] of w.exercises.entries()) {
      const catalogKey = assignments?.[workoutIndex]?.[exerciseIndex] ?? null;
      const catalogEntry = catalogKey ? catalogByKey.get(catalogKey) : undefined;
      const exercise = await tx.exercise.upsert({
        where: { userId_name: { userId, name: ex.name } },
        update: {},
        create: {
          userId,
          name: ex.name,
          muscleGroup: ex.muscleGroup,
          category: ex.category,
          equipmentType: ex.equipmentType ?? 'OTHER',
          defaultRestSec: ex.restSec,
          usesBodyweight: ex.usesBodyweight ?? catalogEntry?.usesBodyweight ?? false,
        },
      });

      const autoregDefaults = defaultIntraSetConfig(exercise);
      const guidance = catalogKey ? guidanceByKey?.get(catalogKey) : null;
      await tx.programExercise.create({
        data: {
          workoutId: workout.id,
          exerciseId: exercise.id,
          order: exerciseOrder++,
          targetSets: ex.targetSets,
          targetRepsMin: ex.targetRepsMin,
          targetRepsMax: Math.max(ex.targetRepsMax, ex.targetRepsMin),
          // Managed work always records the steady target; the first-two-week
          // buffer rides on the separate intro fields.
          targetRIR: fitness ? 2 : ex.targetRIR,
          restSec: ex.restSec,
          autoregulationMode: ex.autoregulationMode ?? 'PRESERVE_RIR',
          fatigueRate: ex.fatigueRate ?? autoregDefaults.fatigueRate,
          loadAdjustmentPct: ex.loadAdjustmentPct ?? autoregDefaults.loadAdjustmentPct,
          tempo: ex.tempo ?? null,
          notes: ex.notes ?? null,
          supersetGroup: ex.supersetGroup ?? null,
          initialLoadKg: fitness ? (guidance?.initialLoadKg ?? null) : null,
          initialLoadSource: fitness ? (guidance?.source ?? null) : null,
          progressionRuleVersion: fitness ? 'double-progression-v2' : null,
          introTargetRIR: fitness
            ? fitness.introDurationDays === 14
              ? fitness.introRir
              : null
            : null,
          introEndsAt: fitness ? introEndsAt : null,
        },
      });
    }
  }

  return created.id;
}

// Returns, per workout, the catalog key of each exercise (null when the
// generated exercise carries no catalog note).
function planCatalogAssignments(
  program: GeneratedProgram,
  fitness: MaterializeFitnessOptions,
): (ExerciseCatalogKey | null)[][] {
  const supplied = new Set(fitness.loadGuidance.map((entry) => entry.catalogKey));
  return program.workouts.map((workout) => {
    const seen = new Set<string>();
    return workout.exercises.map((exercise) => {
      const notes = exercise.notes ?? '';
      if (!notes.startsWith(catalogNotePrefix)) return null;
      const key = notes.slice(catalogNotePrefix.length);
      if (!catalogKeySet.has(key)) {
        throw new Error(`Unknown catalog exercise key: ${key}`);
      }
      if (seen.has(key)) {
        throw new Error(`Duplicate catalog exercise ${key} in workout ${workout.name}`);
      }
      seen.add(key);
      if (!supplied.has(key)) {
        throw new Error(`Missing load guidance for catalog exercise ${key}`);
      }
      return key as ExerciseCatalogKey;
    });
  });
}
