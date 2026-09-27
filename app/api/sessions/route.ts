import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { sessionStartSchema } from '@/lib/schemas/session';
import { ApiError, handleApiError, parseJsonBody, requireApiUserId } from '@/lib/api';
import { lockFitnessUser } from '@/lib/fitness/user-lock';

export async function GET() {
  try {
    const userId = await requireApiUserId();
    const sessions = await db.session.findMany({
      where: { userId },
      orderBy: { startedAt: 'desc' },
      include: {
        workout: { select: { name: true } },
        program: { select: { name: true } },
        _count: { select: { sets: true } },
      },
      take: 50,
    });
    return NextResponse.json(sessions);
  } catch (err) {
    return handleApiError(err);
  }
}

// POST /api/sessions: starts a new session on one of the user's workouts.
// Fails if an unfinished session already exists on the same workout
// (avoids zombie sessions created by a double-click).
//
// The whole start runs inside one transaction holding the shared per-user
// fitness lock: activation replaces the active Program, and without the lock a
// start could read the old workout/membership after the plan was swapped.
export async function POST(req: Request) {
  try {
    const userId = await requireApiUserId();
    const { workoutId, gymId } = await parseJsonBody(req, sessionStartSchema);

    const result = await db.$transaction(async (tx) => {
      await lockFitnessUser(tx, userId);

      const workout = await tx.workout.findFirst({
        where: { id: workoutId, program: { userId } },
        select: {
          id: true,
          programId: true,
          program: { select: { isActive: true, fitnessPlanVersion: { select: { id: true } } } },
        },
      });
      if (!workout) {
        throw new ApiError(404, 'Session not found.');
      }

      // A workout that belongs to a managed plan is only startable while its
      // Program is the active one: otherwise the user would train a plan the
      // app has already replaced. Legacy Programs keep their old behavior.
      if (workout.program?.fitnessPlanVersion && !workout.program.isActive) {
        throw new ApiError(409, 'MANAGED_PROGRAM_STALE');
      }

      const selectedGymId =
        gymId ??
        (await tx.user.findUnique({ where: { id: userId }, select: { activeGymId: true } }))
          ?.activeGymId ??
        null;
      if (selectedGymId) {
        const gym = await tx.gym.findFirst({
          where: { id: selectedGymId, userId },
          select: { id: true },
        });
        if (!gym) throw new ApiError(400, 'Invalid gym.');
      }

      const inProgress = await tx.session.findFirst({
        where: { userId, workoutId, finishedAt: null },
      });
      if (inProgress) {
        // We return the existing session instead of creating a new one:
        // allows resuming cleanly after a reload.
        return { session: inProgress, created: false };
      }

      const created = await tx.session.create({
        data: {
          userId,
          workoutId,
          programId: workout.programId,
          gymId: selectedGymId,
        },
      });
      return { session: created, created: true };
    });

    return NextResponse.json(result.session, { status: result.created ? 201 : 200 });
  } catch (err) {
    return handleApiError(err);
  }
}
