import type { Prisma } from '@/prisma/generated/client';
import { db } from '@/lib/db';
import { ApiError } from '@/lib/api';

// ============================================================
// Managed (personalized) Program immutability
// ============================================================
// A Program created by activating a fitness plan is a versioned prescription:
// its workouts, target sets and managed load/progression metadata are the
// snapshot the user confirmed. Editing it in place would silently invalidate
// that snapshot, so the structural mutation routes refuse the write and the
// user replaces the plan through the preview/confirm flow instead.
//
// Ownership comes first and in the same user-scoped query: a stranger must keep
// getting the route's existing 404 and must never learn that the Program is
// managed. Workout execution (starting a session, logging sets) is deliberately
// NOT blocked - immutability covers the prescription structure only.

type Reader = Prisma.TransactionClient;

const MANAGED_MESSAGE = 'MANAGED_PROGRAM_IMMUTABLE';

export function managedProgramImmutableError(): ApiError {
  return new ApiError(409, MANAGED_MESSAGE);
}

// Returns the owned Program row, or throws the caller's existing 404 wording.
export async function getOwnedProgramForEdit(
  userId: string,
  programId: string,
  notFoundMessage: string,
  client: Reader = db,
): Promise<{ id: string }> {
  const program = await client.program.findFirst({
    where: { id: programId, userId },
    select: { id: true, fitnessPlanVersion: { select: { id: true } } },
  });
  if (!program) throw new ApiError(404, notFoundMessage);
  if (program.fitnessPlanVersion) throw managedProgramImmutableError();
  return { id: program.id };
}

export async function assertProgramEditable(
  userId: string,
  programId: string,
  notFoundMessage = 'Program not found.',
  client: Reader = db,
): Promise<void> {
  await getOwnedProgramForEdit(userId, programId, notFoundMessage, client);
}

export async function assertWorkoutEditable(
  userId: string,
  workoutId: string,
  notFoundMessage: string,
  client: Reader = db,
): Promise<void> {
  const workout = await client.workout.findFirst({
    where: { id: workoutId, program: { userId } },
    select: { id: true, program: { select: { fitnessPlanVersion: { select: { id: true } } } } },
  });
  if (!workout) throw new ApiError(404, notFoundMessage);
  if (workout.program.fitnessPlanVersion) throw managedProgramImmutableError();
}

export async function assertProgramExerciseEditable(
  userId: string,
  programExerciseId: string,
  notFoundMessage: string,
  client: Reader = db,
): Promise<void> {
  const programExercise = await client.programExercise.findFirst({
    where: { id: programExerciseId, workout: { program: { userId } } },
    select: {
      id: true,
      workout: {
        select: { program: { select: { fitnessPlanVersion: { select: { id: true } } } } },
      },
    },
  });
  if (!programExercise) throw new ApiError(404, notFoundMessage);
  if (programExercise.workout.program.fitnessPlanVersion) throw managedProgramImmutableError();
}

// Coach apply edits a batch of ProgramExercises; validating every target before
// the first write keeps the whole apply all-or-nothing.
export async function assertProgramExercisesEditable(
  userId: string,
  programExerciseIds: readonly string[],
  notFoundMessage: string,
  client: Reader = db,
): Promise<void> {
  for (const id of programExerciseIds) {
    await assertProgramExerciseEditable(userId, id, notFoundMessage, client);
  }
}
