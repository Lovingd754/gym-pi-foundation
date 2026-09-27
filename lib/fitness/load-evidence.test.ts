import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/lib/prisma-client';

import { STRENGTH_EXERCISE_CATALOG } from './exercise-catalog';
import {
  chooseInitialLoad,
  getInitialLoadGuidance,
  type AppLoadEvidence,
  type RecentMainLift,
} from './load-evidence';

const bench = STRENGTH_EXERCISE_CATALOG.find((entry) => entry.key === 'bench_press')!;
const dumbbellBench = STRENGTH_EXERCISE_CATALOG.find(
  (entry) => entry.key === 'dumbbell_bench_press',
)!;
const pushUp = STRENGTH_EXERCISE_CATALOG.find((entry) => entry.key === 'push_up')!;

describe('chooseInitialLoad', () => {
  const app: AppLoadEvidence = { loadKg: 82.5 };
  const user: RecentMainLift = { catalogKey: 'bench_press', weightKg: 75, reps: 8, rir: 2 };

  it('prefers reliable app history over the user-entered lift', () => {
    expect(chooseInitialLoad('bench_press', app, user)).toEqual({
      catalogKey: 'bench_press',
      source: 'APP_HISTORY',
      initialLoadKg: 82.5,
    });
  });

  it('uses an exact matching user lift only when app history is absent', () => {
    expect(chooseInitialLoad('bench_press', null, user)).toEqual({
      catalogKey: 'bench_press',
      source: 'USER_REPORTED',
      initialLoadKg: 75,
    });
    expect(chooseInitialLoad('back_squat', null, user)).toEqual({
      catalogKey: 'back_squat',
      source: 'CALIBRATION',
      initialLoadKg: null,
    });
  });

  it('keeps an explicitly reported zero added load for bodyweight work', () => {
    expect(
      chooseInitialLoad('push_up', null, {
        catalogKey: 'push_up',
        weightKg: 0,
        reps: 12,
        rir: 2,
      }),
    ).toEqual({ catalogKey: 'push_up', source: 'USER_REPORTED', initialLoadKg: 0 });
  });
});

describe('getInitialLoadGuidance', () => {
  it('uses the latest reliable exact-name or alias exposure and returns catalog order', async () => {
    const findMany = vi.fn().mockResolvedValue([
      evidenceRow({
        name: 'Bench Press',
        sessionId: 'new-unreliable',
        startedAt: '2026-05-20',
        weight: 90,
        rir: null,
      }),
      evidenceRow({
        name: 'Barbell bench press',
        sessionId: 'reliable',
        startedAt: '2026-05-10',
        weight: 80,
        rir: 2,
      }),
      evidenceRow({
        name: 'Barbell bench press',
        sessionId: 'reliable',
        startedAt: '2026-05-10',
        weight: 85,
        rir: 1,
      }),
      // A heavier drop set must not raise the reported working load.
      evidenceRow({
        name: 'Barbell bench press',
        sessionId: 'reliable',
        startedAt: '2026-05-10',
        weight: 95,
        rir: 1,
        isDropSet: true,
      }),
      evidenceRow({
        name: 'Dumbbell Bench Press',
        sessionId: 'db',
        startedAt: '2026-05-11',
        weight: 30,
        rir: 2,
      }),
      evidenceRow({
        name: 'Push-up',
        sessionId: 'bodyweight',
        startedAt: '2026-05-12',
        weight: 0,
        rir: 2,
      }),
      // Fuzzy near-miss names never seed a canonical exercise.
      evidenceRow({
        name: 'Bench Pres',
        sessionId: 'fuzzy',
        startedAt: '2026-05-19',
        weight: 100,
        rir: 2,
      }),
    ]);
    const tx = { set: { findMany } } as unknown as Prisma.TransactionClient;
    const now = new Date('2026-06-01T00:00:00Z');

    const result = await getInitialLoadGuidance(tx, {
      userId: 'user-1',
      catalogExercises: [bench, dumbbellBench, pushUp],
      recentMainLifts: [
        { catalogKey: 'bench_press', weightKg: 70, reps: 8, rir: 2 },
        { catalogKey: 'push_up', weightKg: 0, reps: 12, rir: 2 },
      ],
      now,
    });

    expect(result).toEqual([
      { catalogKey: 'bench_press', source: 'APP_HISTORY', initialLoadKg: 85 },
      { catalogKey: 'dumbbell_bench_press', source: 'APP_HISTORY', initialLoadKg: 30 },
      { catalogKey: 'push_up', source: 'APP_HISTORY', initialLoadKg: 0 },
    ]);
    expect(JSON.stringify(result)).toBe(
      JSON.stringify(
        await getInitialLoadGuidance(tx, {
          userId: 'user-1',
          catalogExercises: [bench, dumbbellBench, pushUp],
          recentMainLifts: [
            { catalogKey: 'bench_press', weightKg: 70, reps: 8, rir: 2 },
            { catalogKey: 'push_up', weightKg: 0, reps: 12, rir: 2 },
          ],
          now,
        }),
      ),
    );

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isWarmup: false,
          exercise: expect.objectContaining({ userId: 'user-1' }),
          session: expect.objectContaining({
            userId: 'user-1',
            finishedAt: { not: null },
            startedAt: {
              gte: new Date('2026-03-03T00:00:00.000Z'),
              lte: now,
            },
          }),
        }),
      }),
    );
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('falls back when a weighted exposure has no positive load', async () => {
    const tx = {
      set: {
        findMany: vi.fn().mockResolvedValue([
          evidenceRow({
            name: 'Bench Press',
            sessionId: 'zero',
            startedAt: '2026-05-10',
            weight: 0,
            rir: 2,
          }),
        ]),
      },
    } as unknown as Prisma.TransactionClient;

    await expect(
      getInitialLoadGuidance(tx, {
        userId: 'user-1',
        catalogExercises: [bench],
        recentMainLifts: [],
        now: new Date('2026-06-01T00:00:00Z'),
      }),
    ).resolves.toEqual([{ catalogKey: 'bench_press', source: 'CALIBRATION', initialLoadKg: null }]);
  });

  it('batches the name lookup instead of issuing one query per catalog row', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const tx = { set: { findMany } } as unknown as Prisma.TransactionClient;
    // 60 catalog rows x 3 names = 180 names -> 2 bounded batches, not 60 queries.
    const catalogExercises = Array.from({ length: 60 }, (_, index) => ({
      key: `synthetic_${index}`,
      name: `Synthetic ${index}`,
      aliases: [`Synthetic ${index} A`, `Synthetic ${index} B`],
      usesBodyweight: false,
    })) as never;

    await getInitialLoadGuidance(tx, {
      userId: 'user-1',
      catalogExercises,
      recentMainLifts: [],
      now: new Date('2026-06-01T00:00:00Z'),
    });

    expect(findMany).toHaveBeenCalledTimes(2);
    for (const [query] of findMany.mock.calls) {
      expect(query.where.exercise.name.in.length).toBeLessThanOrEqual(100);
    }
  });
});

function evidenceRow(input: {
  name: string;
  sessionId: string;
  startedAt: string;
  weight: number;
  rir: number | null;
  isDropSet?: boolean;
}) {
  return {
    exercise: { name: input.name },
    sessionId: input.sessionId,
    session: { startedAt: new Date(`${input.startedAt}T10:00:00Z`) },
    weight: input.weight,
    rir: input.rir,
    isDropSet: input.isDropSet ?? false,
  };
}
