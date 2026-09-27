import { db } from '@/lib/db';

export interface LastPerformance {
  exerciseId: string;
  // The most recent previous session for this exercise (excluding the current session).
  sessionStartedAt: Date;
  sets: { weight: number; reps: number; rir: number | null; isDropSet: boolean }[];
  // Best load of the session (handy for a quick display).
  maxWeight: number;
  // Reps at that max load (the highest rep count reached at maxWeight).
  repsAtMaxWeight: number;
  // Cardio totals for the session (issue #176): summed duration/distance and
  // an averaged heart rate across the session's cardio sets. Null for strength
  // exercises (no cardio sets), so the session UI can branch on `cardio`.
  cardio: { durationSec: number; distanceM: number; avgHr: number | null } | null;
}

// Compatibility wrapper for callers that only need the latest exposure.
export async function getLastPerformances(
  userId: string,
  exerciseIds: string[],
  excludeSessionId: string | null,
): Promise<Map<string, LastPerformance>> {
  const recent = await getRecentPerformances(userId, exerciseIds, excludeSessionId, 1);
  return new Map(
    [...recent.entries()].flatMap(([exerciseId, performances]) =>
      performances[0] ? ([[exerciseId, performances[0]]] as const) : [],
    ),
  );
}

export async function getRecentPerformances(
  userId: string,
  exerciseIds: string[],
  excludeSessionId: string | null,
  limit = 2,
): Promise<Map<string, LastPerformance[]>> {
  if (exerciseIds.length === 0) return new Map();
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError('limit must be a positive integer');
  }

  const result = new Map<string, LastPerformance[]>();

  // Each exercise is ownership-scoped through Session.userId. The nested set
  // selection excludes warmups while preserving drop-set metadata for managed
  // progression; the default limit bounds history to the newest two sessions.
  await Promise.all(
    exerciseIds.map(async (exerciseId) => {
      const sessions = await db.session.findMany({
        where: {
          userId,
          ...(excludeSessionId ? { id: { not: excludeSessionId } } : {}),
          sets: { some: { exerciseId, isWarmup: false, exercise: { userId } } },
        },
        orderBy: { startedAt: 'desc' },
        take: limit,
        select: {
          id: true,
          startedAt: true,
          sets: {
            where: { exerciseId, isWarmup: false, exercise: { userId } },
            orderBy: { setNumber: 'asc' },
            select: {
              weight: true,
              reps: true,
              rir: true,
              isDropSet: true,
              durationSec: true,
              distanceM: true,
              avgHr: true,
            },
          },
        },
      });
      const performances = sessions
        .filter((session) => session.sets.length > 0)
        .map((session) => derivePerformance(exerciseId, session.startedAt, session.sets));
      if (performances.length > 0) result.set(exerciseId, performances);
    }),
  );

  return result;
}

type PerformanceRow = {
  weight: number;
  reps: number;
  rir: number | null;
  isDropSet: boolean;
  durationSec: number | null;
  distanceM: number | null;
  avgHr: number | null;
};

function derivePerformance(
  exerciseId: string,
  sessionStartedAt: Date,
  rows: PerformanceRow[],
): LastPerformance {
  const sets = rows.map(({ weight, reps, rir, isDropSet }) => ({
    weight,
    reps,
    rir,
    isDropSet,
  }));
  const maxWeight = Math.max(...sets.map((set) => set.weight));
  const repsAtMaxWeight = Math.max(
    ...sets.filter((set) => set.weight === maxWeight).map((set) => set.reps),
  );
  const cardioRows = rows.filter((row) => row.durationSec != null);
  let cardio: LastPerformance['cardio'] = null;
  if (cardioRows.length > 0) {
    const durationSec = cardioRows.reduce((total, row) => total + (row.durationSec ?? 0), 0);
    const distanceM = cardioRows.reduce((total, row) => total + (row.distanceM ?? 0), 0);
    const heartRateRows = cardioRows.filter((row) => row.avgHr != null);
    const avgHr =
      heartRateRows.length === 0
        ? null
        : Math.round(
            heartRateRows.reduce((total, row) => total + (row.avgHr ?? 0), 0) /
              heartRateRows.length,
          );
    cardio = { durationSec, distanceM, avgHr };
  }
  return { exerciseId, sessionStartedAt, sets, maxWeight, repsAtMaxWeight, cardio };
}
