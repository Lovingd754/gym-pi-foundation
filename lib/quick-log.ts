import { db } from '@/lib/db';
import { ensureExerciseCatalog } from '@/lib/exercise-catalog-sync';
import { setInputSchema } from '@/lib/schemas/set';

// ============================================================
// Recording sets without a workout in progress
// ============================================================
// Two entry points write history this way: the quick-log form and a set the
// trainee described in the chat. Both go through this module, so "where does
// this set belong" is answered once:
//
//   - a workout in progress means they are mid-session, so the sets join it and
//     it stays open;
//   - otherwise the set is something they did earlier, so it gets its own free
//     session, finished immediately, which is how the history screen expects to
//     find a completed workout.

export interface QuickLogEntry {
  exerciseId: string;
  // Canonical kilograms. Callers that accept the trainee's own unit convert
  // first, exactly once.
  weight: number;
  reps: number;
  sets: number;
  rir?: number | null;
}

export interface WriteSetsResult {
  sessionId: string;
  setCount: number;
  finishedSession: boolean;
}

export async function writeSets(
  userId: string,
  entry: QuickLogEntry,
  now: Date = new Date(),
): Promise<WriteSetsResult> {
  const exercise = await db.exercise.findFirst({
    where: { id: entry.exerciseId, userId },
    select: { id: true, category: true },
  });
  if (!exercise) throw new Error('EXERCISE_NOT_FOUND');

  // The same schema the manual form goes through: no caller gets to smuggle in
  // a weight or rep count the app would have refused.
  const parsed = setInputSchema.parse({
    exerciseId: entry.exerciseId,
    weight: entry.weight,
    reps: entry.reps,
    ...(entry.rir === undefined || entry.rir === null ? {} : { rir: entry.rir }),
    setNumber: 1,
  });
  const isCardio = exercise.category === 'CARDIO';

  const existing = await db.session.findFirst({
    where: { userId, finishedAt: null },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    select: { id: true },
  });
  const sessionId =
    existing?.id ??
    (await db.session.create({ data: { userId, startedAt: now }, select: { id: true } })).id;

  const lastSet = await db.set.findFirst({
    where: { sessionId, exerciseId: exercise.id },
    orderBy: { setNumber: 'desc' },
    select: { setNumber: true },
  });
  const firstSetNumber = (lastSet?.setNumber ?? 0) + 1;

  await db.set.createMany({
    data: Array.from({ length: entry.sets }, (_, index) => ({
      sessionId,
      exerciseId: exercise.id,
      setNumber: firstSetNumber + index,
      // Cardio sets store weight 0 / reps 1 by convention, like every other
      // writer in the app.
      weight: isCardio ? 0 : parsed.weight,
      reps: isCardio ? 1 : parsed.reps,
      rir: isCardio ? null : (parsed.rir ?? null),
    })),
  });

  const finishedSession = existing === null;
  if (finishedSession) {
    await db.session.update({ where: { id: sessionId }, data: { finishedAt: now } });
  }

  return { sessionId, setCount: entry.sets, finishedSession };
}

export interface QuickLogExercise {
  id: string;
  name: string;
  category: string;
  // The most recent working set for this movement, in kilograms, so the form can
  // default to what the trainee last did.
  lastWeight: number | null;
  lastReps: number | null;
  lastSets: number | null;
}

export interface QuickLogSet {
  id: string;
  exerciseName: string;
  setNumber: number;
  weight: number;
  reps: number;
  durationSec: number | null;
}

export interface QuickLogState {
  exercises: QuickLogExercise[];
  // What has already been recorded today, newest first, so the form can show
  // its own result instead of making the trainee go and check.
  todaySets: QuickLogSet[];
}

// Ordered by what the trainee actually uses: recently logged movements first,
// then the rest alphabetically. A list of thirty exercises sorted by name is a
// list nobody scrolls.
export async function loadQuickLogState(
  userId: string,
  now: Date = new Date(),
): Promise<QuickLogState> {
  await ensureExerciseCatalog(userId);

  const [exercises, recentSets, todaySets] = await Promise.all([
    db.exercise.findMany({
      where: { userId },
      select: { id: true, name: true, category: true },
    }),
    db.set.findMany({
      where: { session: { userId }, isWarmup: false },
      orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
      take: 200,
      select: { exerciseId: true, weight: true, reps: true },
    }),
    db.set.findMany({
      where: { session: { userId }, completedAt: { gte: startOfDay(now) } },
      orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
      take: 30,
      select: {
        id: true,
        setNumber: true,
        weight: true,
        reps: true,
        durationSec: true,
        exercise: { select: { name: true } },
      },
    }),
  ]);

  // One pass over the recent sets gives both the ordering and the defaults.
  const lastByExercise = new Map<string, { weight: number; reps: number; sets: number }>();
  const order = new Map<string, number>();
  for (const set of recentSets) {
    const seen = lastByExercise.get(set.exerciseId);
    if (seen) {
      seen.sets += 1;
      continue;
    }
    lastByExercise.set(set.exerciseId, { weight: set.weight, reps: set.reps, sets: 1 });
    order.set(set.exerciseId, order.size);
  }

  const ordered = [...exercises].sort((left, right) => {
    const leftOrder = order.get(left.id) ?? Number.POSITIVE_INFINITY;
    const rightOrder = order.get(right.id) ?? Number.POSITIVE_INFINITY;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.name.localeCompare(right.name);
  });

  return {
    exercises: ordered.map((exercise) => {
      const last = lastByExercise.get(exercise.id);
      return {
        id: exercise.id,
        name: exercise.name,
        category: exercise.category,
        lastWeight: last?.weight ?? null,
        lastReps: last?.reps ?? null,
        lastSets: last?.sets ?? null,
      };
    }),
    todaySets: todaySets.map((set) => ({
      id: set.id,
      exerciseName: set.exercise.name,
      setNumber: set.setNumber,
      weight: set.weight,
      reps: set.reps,
      durationSec: set.durationSec,
    })),
  };
}

function startOfDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
