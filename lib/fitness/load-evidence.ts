import type { Prisma } from '@/lib/prisma-client';

import type { AssessmentInput } from './schemas';
import type { ExerciseCatalogKey } from './exercise-keys';
import type { ExerciseCatalogEntry } from './exercise-catalog';

const LOOKBACK_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const NAME_BATCH_SIZE = 100;

export type RecentMainLift = AssessmentInput['schedule']['recentMainLifts'][number];

export type AppLoadEvidence = {
  loadKg: number;
};

export type InitialLoadGuidance = {
  catalogKey: ExerciseCatalogKey;
  source: 'APP_HISTORY' | 'USER_REPORTED' | 'CALIBRATION';
  initialLoadKg: number | null;
};

type EvidenceRow = {
  exercise: { name: string };
  sessionId: string;
  session: { startedAt: Date };
  weight: number;
  rir: number | null;
  isDropSet: boolean;
};

export function chooseInitialLoad(
  catalogKey: ExerciseCatalogKey,
  appEvidence: AppLoadEvidence | null,
  userEvidence: RecentMainLift | null,
): InitialLoadGuidance {
  if (appEvidence) {
    return { catalogKey, source: 'APP_HISTORY', initialLoadKg: appEvidence.loadKg };
  }
  if (userEvidence?.catalogKey === catalogKey) {
    return { catalogKey, source: 'USER_REPORTED', initialLoadKg: userEvidence.weightKg };
  }
  return { catalogKey, source: 'CALIBRATION', initialLoadKg: null };
}

export async function getInitialLoadGuidance(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    catalogExercises: readonly ExerciseCatalogEntry[];
    recentMainLifts: RecentMainLift[];
    now: Date;
  },
): Promise<InitialLoadGuidance[]> {
  if (Number.isNaN(input.now.getTime())) throw new RangeError('now must be a valid date');
  if (input.catalogExercises.length === 0) return [];

  const catalogByName = new Map<string, ExerciseCatalogEntry>();
  for (const entry of input.catalogExercises) {
    for (const name of [entry.name, ...entry.aliases]) {
      catalogByName.set(name, entry);
    }
  }
  const names = [...catalogByName.keys()];
  const lookbackStart = new Date(input.now.getTime() - LOOKBACK_DAYS * DAY_MS);
  // Sequential: this runs inside the caller's interactive transaction, which
  // owns a single connection, and bounded batches keep any one query small.
  const rows: EvidenceRow[] = [];
  for (const nameBatch of chunk(names, NAME_BATCH_SIZE)) {
    rows.push(
      ...((await tx.set.findMany({
        where: {
          isWarmup: false,
          exercise: { userId: input.userId, name: { in: nameBatch } },
          session: {
            userId: input.userId,
            finishedAt: { not: null },
            startedAt: { gte: lookbackStart, lte: input.now },
          },
        },
        orderBy: [{ session: { startedAt: 'desc' } }, { setNumber: 'asc' }],
        select: {
          exercise: { select: { name: true } },
          sessionId: true,
          session: { select: { startedAt: true } },
          weight: true,
          rir: true,
          isDropSet: true,
        },
      })) as EvidenceRow[]),
    );
  }

  const rowsByKey = new Map<ExerciseCatalogKey, EvidenceRow[]>();
  for (const row of rows) {
    const entry = catalogByName.get(row.exercise.name);
    if (!entry) continue;
    const existing = rowsByKey.get(entry.key) ?? [];
    existing.push(row);
    rowsByKey.set(entry.key, existing);
  }
  const recentByKey = new Map(input.recentMainLifts.map((lift) => [lift.catalogKey, lift]));

  return input.catalogExercises.map((entry) =>
    chooseInitialLoad(
      entry.key,
      latestReliableEvidence(entry, rowsByKey.get(entry.key) ?? []),
      recentByKey.get(entry.key) ?? null,
    ),
  );
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) =>
    values.slice(index * size, (index + 1) * size),
  );
}

function latestReliableEvidence(
  entry: ExerciseCatalogEntry,
  rows: readonly EvidenceRow[],
): AppLoadEvidence | null {
  const bySession = new Map<string, EvidenceRow[]>();
  for (const row of rows) {
    const sessionRows = bySession.get(row.sessionId) ?? [];
    sessionRows.push(row);
    bySession.set(row.sessionId, sessionRows);
  }
  const sessions = [...bySession.values()].sort(
    (left, right) => right[0]!.session.startedAt.getTime() - left[0]!.session.startedAt.getTime(),
  );

  for (const sessionRows of sessions) {
    // Drop sets are deliberately excluded: they are a back-off, not the
    // working load the managed progression rule treats as the reference.
    const qualifying = sessionRows.filter((row) => !row.isDropSet);
    if (qualifying.length === 0 || qualifying.some((row) => row.rir === null)) continue;
    const loadKg = Math.max(...qualifying.map((row) => row.weight));
    if (!entry.usesBodyweight && loadKg <= 0) continue;
    return { loadKg };
  }
  return null;
}
