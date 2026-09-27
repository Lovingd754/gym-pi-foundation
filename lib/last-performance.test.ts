import { describe, it, expect, vi, beforeEach } from 'vitest';

// getLastPerformances reads the database directly (no pure-function seam), so we
// mock @/lib/db with a tiny in-memory fake that HONORS the where/orderBy the
// function builds. That way the derivation (warmup exclusion, exclude-session,
// most-recent selection, the max-load and cardio-totals math) is exercised
// through the real query construction rather than re-implemented in the test.

interface Row {
  sessionId: string;
  exerciseId: string;
  setNumber: number;
  weight: number;
  reps: number;
  rir: number | null;
  durationSec: number | null;
  distanceM: number | null;
  avgHr: number | null;
  isWarmup: boolean;
  isDropSet: boolean;
  completedAt: Date;
  startedAt: Date; // the owning session's startedAt, for the include
  userId: string;
}

// Mutable store the tests load before each call.
let rows: Row[] = [];

vi.mock('@/lib/db', () => ({
  db: {
    session: {
      findMany: vi.fn(
        async ({
          where,
          orderBy,
          take,
          select,
        }: {
          where: {
            userId: string;
            id?: { not: string };
            sets: {
              some: { exerciseId: string; isWarmup: boolean; exercise: { userId: string } };
            };
          };
          orderBy: { startedAt: 'desc' | 'asc' };
          take: number;
          select: {
            sets: {
              where: { exerciseId: string; isWarmup: boolean; exercise: { userId: string } };
            };
          };
        }) => {
          const exerciseId = where.sets.some.exerciseId;
          const sessionRows = rows.filter(
            (row) =>
              row.userId === where.userId &&
              row.userId === where.sets.some.exercise.userId &&
              row.exerciseId === exerciseId &&
              !row.isWarmup &&
              row.sessionId !== where.id?.not,
          );
          const sessions = new Map<string, Row[]>();
          for (const row of sessionRows) {
            const existing = sessions.get(row.sessionId) ?? [];
            existing.push(row);
            sessions.set(row.sessionId, existing);
          }
          return [...sessions.entries()]
            .map(([id, values]) => ({ id, startedAt: values[0]!.startedAt, values }))
            .sort((left, right) =>
              orderBy.startedAt === 'desc'
                ? right.startedAt.getTime() - left.startedAt.getTime()
                : left.startedAt.getTime() - right.startedAt.getTime(),
            )
            .slice(0, take)
            .map(({ id, startedAt, values }) => ({
              id,
              startedAt,
              sets: values
                .filter(
                  (row) =>
                    row.exerciseId === select.sets.where.exerciseId &&
                    row.isWarmup === select.sets.where.isWarmup &&
                    row.userId === select.sets.where.exercise.userId,
                )
                .sort((left, right) => left.setNumber - right.setNumber)
                .map(({ weight, reps, rir, isDropSet, durationSec, distanceM, avgHr }) => ({
                  weight,
                  reps,
                  rir,
                  isDropSet,
                  durationSec,
                  distanceM,
                  avgHr,
                })),
            }));
        },
      ),
    },
  },
}));

import { getLastPerformances, getRecentPerformances } from './last-performance';

const USER = 'user-1';

// Factory with sensible strength defaults; override what a test cares about.
function row(p: Partial<Row> & { sessionId: string; exerciseId: string; setNumber: number }): Row {
  return {
    weight: 0,
    reps: 0,
    rir: null,
    durationSec: null,
    distanceM: null,
    avgHr: null,
    isWarmup: false,
    isDropSet: false,
    completedAt: new Date('2026-01-10T12:00:00Z'),
    startedAt: new Date('2026-01-10T12:00:00Z'),
    userId: USER,
    ...p,
  };
}

describe('getLastPerformances', () => {
  beforeEach(() => {
    rows = [];
  });

  it('returns an empty map for an empty exercise list (no db work)', async () => {
    const map = await getLastPerformances(USER, [], null);
    expect(map.size).toBe(0);
  });

  it('omits an exercise with no prior history (no crash, absent from map)', async () => {
    const map = await getLastPerformances(USER, ['exo-missing'], null);
    expect(map.has('exo-missing')).toBe(false);
    expect(map.size).toBe(0);
  });

  it('derives strength last-set values: max load and reps at that load', async () => {
    const at = (d: number) => new Date(`2026-01-${String(d).padStart(2, '0')}T12:00:00Z`);
    rows = [
      // Older session, must be ignored once a newer one exists.
      row({
        sessionId: 'old',
        exerciseId: 'bench',
        setNumber: 1,
        weight: 80,
        reps: 8,
        completedAt: at(3),
        startedAt: at(3),
      }),
      // Newer session: top load 100, reached for 5 then 6 reps.
      row({
        sessionId: 'new',
        exerciseId: 'bench',
        setNumber: 1,
        weight: 90,
        reps: 8,
        rir: 2,
        completedAt: at(9),
        startedAt: at(9),
      }),
      row({
        sessionId: 'new',
        exerciseId: 'bench',
        setNumber: 2,
        weight: 100,
        reps: 5,
        rir: 1,
        completedAt: at(9),
        startedAt: at(9),
      }),
      row({
        sessionId: 'new',
        exerciseId: 'bench',
        setNumber: 3,
        weight: 100,
        reps: 6,
        rir: 0,
        completedAt: at(9),
        startedAt: at(9),
      }),
    ];

    const perf = (await getLastPerformances(USER, ['bench'], null)).get('bench');
    expect(perf).toBeDefined();
    expect(perf!.sessionStartedAt.getTime()).toBe(at(9).getTime());
    expect(perf!.maxWeight).toBe(100);
    expect(perf!.repsAtMaxWeight).toBe(6); // higher rep count at the max load
    expect(perf!.sets).toEqual([
      { weight: 90, reps: 8, rir: 2, isDropSet: false },
      { weight: 100, reps: 5, rir: 1, isDropSet: false },
      { weight: 100, reps: 6, rir: 0, isDropSet: false },
    ]);
    expect(perf!.cardio).toBeNull(); // strength -> no cardio totals
  });

  it('excludes warmup sets from the derivation', async () => {
    rows = [
      // A heavy warmup must not become maxWeight nor appear in `sets`.
      row({
        sessionId: 's',
        exerciseId: 'bench',
        setNumber: 1,
        weight: 200,
        reps: 1,
        isWarmup: true,
      }),
      row({ sessionId: 's', exerciseId: 'bench', setNumber: 2, weight: 90, reps: 8 }),
      row({ sessionId: 's', exerciseId: 'bench', setNumber: 3, weight: 95, reps: 6 }),
    ];

    const perf = (await getLastPerformances(USER, ['bench'], null)).get('bench');
    expect(perf!.maxWeight).toBe(95);
    expect(perf!.sets).toHaveLength(2);
    expect(perf!.sets.some((s) => s.weight === 200)).toBe(false);
  });

  it('excludes the current session when excludeSessionId is given', async () => {
    const at = (d: number) => new Date(`2026-01-${String(d).padStart(2, '0')}T12:00:00Z`);
    rows = [
      row({
        sessionId: 'prev',
        exerciseId: 'bench',
        setNumber: 1,
        weight: 70,
        reps: 10,
        completedAt: at(5),
        startedAt: at(5),
      }),
      row({
        sessionId: 'curr',
        exerciseId: 'bench',
        setNumber: 1,
        weight: 110,
        reps: 3,
        completedAt: at(8),
        startedAt: at(8),
      }),
    ];

    // Excluding the current session, the previous one is the reference.
    const excluded = await getLastPerformances(USER, ['bench'], 'curr');
    expect(excluded.get('bench')!.maxWeight).toBe(70);

    // With no exclusion, the most recent (current) session wins.
    const all = await getLastPerformances(USER, ['bench'], null);
    expect(all.get('bench')!.maxWeight).toBe(110);
  });

  it('sums cardio duration/distance and AVERAGES heart rate over only the rows with HR', async () => {
    rows = [
      // 20:00 / 3 km / 150 bpm, 10:00 / 2 km / 170 bpm, 5:00 / 1 km / no HR.
      row({
        sessionId: 'run',
        exerciseId: 'running',
        setNumber: 1,
        weight: 0,
        reps: 1,
        durationSec: 1200,
        distanceM: 3000,
        avgHr: 150,
      }),
      row({
        sessionId: 'run',
        exerciseId: 'running',
        setNumber: 2,
        weight: 0,
        reps: 1,
        durationSec: 600,
        distanceM: 2000,
        avgHr: 170,
      }),
      row({
        sessionId: 'run',
        exerciseId: 'running',
        setNumber: 3,
        weight: 0,
        reps: 1,
        durationSec: 300,
        distanceM: 1000,
        avgHr: null,
      }),
    ];

    const perf = (await getLastPerformances(USER, ['running'], null)).get('running');
    // duration/distance summed across all cardio rows...
    // ...but HR averaged over only the two rows that recorded it: (150+170)/2 = 160 (NOT (150+170)/3, NOT a sum of 320).
    expect(perf!.cardio).toEqual({ durationSec: 2100, distanceM: 6000, avgHr: 160 });
  });

  it('rounds the averaged heart rate to the nearest integer', async () => {
    rows = [
      row({
        sessionId: 'run',
        exerciseId: 'running',
        setNumber: 1,
        weight: 0,
        reps: 1,
        durationSec: 600,
        distanceM: 1000,
        avgHr: 150,
      }),
      row({
        sessionId: 'run',
        exerciseId: 'running',
        setNumber: 2,
        weight: 0,
        reps: 1,
        durationSec: 600,
        distanceM: 1000,
        avgHr: 151,
      }),
      row({
        sessionId: 'run',
        exerciseId: 'running',
        setNumber: 3,
        weight: 0,
        reps: 1,
        durationSec: 600,
        distanceM: 1000,
        avgHr: 152,
      }),
    ];
    // (150 + 151 + 152) / 3 = 151, exact here; but also covers the rounding path.
    expect((await getLastPerformances(USER, ['running'], null)).get('running')!.cardio!.avgHr).toBe(
      151,
    );
  });

  it('reports null avgHr when cardio rows recorded no heart rate (no divide-by-zero)', async () => {
    rows = [
      row({
        sessionId: 'run',
        exerciseId: 'running',
        setNumber: 1,
        weight: 0,
        reps: 1,
        durationSec: 1200,
        distanceM: 3000,
        avgHr: null,
      }),
      row({
        sessionId: 'run',
        exerciseId: 'running',
        setNumber: 2,
        weight: 0,
        reps: 1,
        durationSec: 600,
        distanceM: 2000,
        avgHr: null,
      }),
    ];
    const perf = (await getLastPerformances(USER, ['running'], null)).get('running');
    expect(perf!.cardio).toEqual({ durationSec: 1800, distanceM: 5000, avgHr: null });
  });

  it('treats a missing distance as zero when summing cardio distance', async () => {
    rows = [
      row({
        sessionId: 'run',
        exerciseId: 'running',
        setNumber: 1,
        weight: 0,
        reps: 1,
        durationSec: 1200,
        distanceM: 3000,
        avgHr: 140,
      }),
      // duration-only row (no distance recorded) must contribute 0 to distance.
      row({
        sessionId: 'run',
        exerciseId: 'running',
        setNumber: 2,
        weight: 0,
        reps: 1,
        durationSec: 600,
        distanceM: null,
        avgHr: 160,
      }),
    ];
    const perf = (await getLastPerformances(USER, ['running'], null)).get('running');
    expect(perf!.cardio).toEqual({ durationSec: 1800, distanceM: 3000, avgHr: 150 });
  });

  it('passes set weight through unchanged (no bodyweight effective-load transform here)', async () => {
    // The derivation returns the raw stored Set.weight; effective-load semantics
    // for bodyweight exercises are applied by the consumers (lib/stats), not by
    // getLastPerformances. A pull-up logged with +0 added load stays 0.
    rows = [
      row({ sessionId: 's', exerciseId: 'pullup', setNumber: 1, weight: 0, reps: 10 }),
      row({ sessionId: 's', exerciseId: 'pullup', setNumber: 2, weight: 10, reps: 8 }),
    ];
    const perf = (await getLastPerformances(USER, ['pullup'], null)).get('pullup');
    expect(perf!.sets).toEqual([
      { weight: 0, reps: 10, rir: null, isDropSet: false },
      { weight: 10, reps: 8, rir: null, isDropSet: false },
    ]);
    expect(perf!.maxWeight).toBe(10);
    expect(perf!.repsAtMaxWeight).toBe(8);
  });

  it('returns the newest two distinct sessions and preserves drop-set metadata internally', async () => {
    const at = (day: number) => new Date(`2026-01-${String(day).padStart(2, '0')}T12:00:00Z`);
    rows = [
      row({
        sessionId: 'old',
        exerciseId: 'bench',
        setNumber: 1,
        weight: 70,
        reps: 10,
        startedAt: at(2),
        completedAt: at(2),
      }),
      row({
        sessionId: 'middle',
        exerciseId: 'bench',
        setNumber: 1,
        weight: 80,
        reps: 8,
        startedAt: at(5),
        completedAt: at(5),
      }),
      row({
        sessionId: 'new',
        exerciseId: 'bench',
        setNumber: 1,
        weight: 90,
        reps: 6,
        startedAt: at(9),
        completedAt: at(9),
      }),
      row({
        sessionId: 'new',
        exerciseId: 'bench',
        setNumber: 2,
        weight: 75,
        reps: 10,
        isDropSet: true,
        startedAt: at(9),
        completedAt: at(9),
      }),
      row({
        sessionId: 'other-user',
        exerciseId: 'bench',
        setNumber: 1,
        weight: 200,
        reps: 2,
        userId: 'user-2',
        startedAt: at(10),
        completedAt: at(10),
      }),
    ];

    const recent = await getRecentPerformances(USER, ['bench'], null);

    expect(recent.get('bench')?.map((performance) => performance.sessionStartedAt)).toEqual([
      at(9),
      at(5),
    ]);
    expect(recent.get('bench')?.[0]?.sets).toEqual([
      { weight: 90, reps: 6, rir: null, isDropSet: false },
      { weight: 75, reps: 10, rir: null, isDropSet: true },
    ]);
  });

  it('resolves several exercises in one call, each from its own latest session', async () => {
    rows = [
      row({ sessionId: 'a', exerciseId: 'bench', setNumber: 1, weight: 100, reps: 5 }),
      row({ sessionId: 'b', exerciseId: 'squat', setNumber: 1, weight: 140, reps: 5 }),
    ];
    const map = await getLastPerformances(USER, ['bench', 'squat', 'deadlift'], null);
    expect(map.get('bench')!.maxWeight).toBe(100);
    expect(map.get('squat')!.maxWeight).toBe(140);
    expect(map.has('deadlift')).toBe(false); // no history -> absent
  });
});
