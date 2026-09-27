// ============================================================
// Turning a finished session's sets into one line per movement
// ============================================================
// The history list used to summarize a whole session with three badges (sets,
// tonnage, minutes). Those numbers answer questions the trainee did not ask,
// and mixing a tonnage next to a duration reads as noise. What they actually
// want to see, per day, is: which movements did I do, with how much weight,
// for how many reps and sets.
//
// So a session collapses to one line per movement: the heaviest working set is
// the representative one, and the line reports how many working sets were done
// at that movement. Cardio carries no weight, so its line carries the distance
// instead.

export interface HistorySetSummaryInput {
  weight: number;
  reps: number;
  isWarmup: boolean;
  durationSec: number | null;
  distanceM: number | null;
  // True when the movement's own bodyweight is the load, so a 0 kg logged
  // weight means "bodyweight", not "empty bar".
  usesBodyweight: boolean | null;
  exerciseName: string;
  exerciseCategory: string;
}

export interface HistoryExerciseLine {
  name: string;
  isCardio: boolean;
  // Heaviest working set, in kilograms (canonical). Null for cardio.
  topWeightKg: number | null;
  // Reps of that heaviest set. Null for cardio.
  reps: number | null;
  // Working sets logged for this movement. Warmups are excluded when the
  // trainee has at least one working set.
  workingSets: number;
  usesBodyweight: boolean;
  // Cardio only; summed over the movement's sets.
  distanceM: number;
  durationSec: number;
}

export function summarizeSessionExercises(
  sets: readonly HistorySetSummaryInput[],
): HistoryExerciseLine[] {
  const order: string[] = [];
  const grouped = new Map<string, HistorySetSummaryInput[]>();

  for (const set of sets) {
    const existing = grouped.get(set.exerciseName);
    if (existing) {
      existing.push(set);
    } else {
      grouped.set(set.exerciseName, [set]);
      order.push(set.exerciseName);
    }
  }

  return order.map((name) => {
    const all = grouped.get(name)!;
    const working = all.filter((set) => !set.isWarmup);
    // A session that only ever logged warmups still happened; count them
    // rather than rendering the movement as empty.
    const counted = working.length > 0 ? working : all;
    const first = counted[0]!;
    const isCardio = first.exerciseCategory === 'CARDIO';

    if (isCardio) {
      return {
        name,
        isCardio: true,
        topWeightKg: null,
        reps: null,
        workingSets: counted.length,
        usesBodyweight: false,
        distanceM: counted.reduce((sum, set) => sum + (set.distanceM ?? 0), 0),
        durationSec: counted.reduce((sum, set) => sum + (set.durationSec ?? 0), 0),
      };
    }

    const heaviest = counted.reduce((best, set) => (set.weight > best.weight ? set : best));
    return {
      name,
      isCardio: false,
      topWeightKg: heaviest.weight,
      reps: heaviest.reps,
      workingSets: counted.length,
      usesBodyweight: Boolean(first.usesBodyweight),
      distanceM: 0,
      durationSec: 0,
    };
  });
}

// Groups the history list by calendar day (UTC, the same clock the quick log
// and the rest of the app stamp sets with), newest day first, so the date can
// be a heading above the sessions instead of a line inside every card.
export function groupSessionsByDay<T extends { id: string; startedAt: Date }>(
  sessions: readonly T[],
): Array<{ key: string; date: Date; sessions: T[] }> {
  const days = new Map<string, { key: string; date: Date; sessions: T[] }>();
  for (const session of sessions) {
    const key = session.startedAt.toISOString().slice(0, 10);
    const day = days.get(key);
    if (day) {
      day.sessions.push(session);
    } else {
      days.set(key, { key, date: session.startedAt, sessions: [session] });
    }
  }
  return [...days.values()];
}
