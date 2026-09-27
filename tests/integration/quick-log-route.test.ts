import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { getCurrentUserId } from '@/lib/auth';
import { loadQuickLogState } from '@/lib/quick-log';

vi.mock('@/lib/auth', () => ({ getCurrentUserId: vi.fn() }));
const mockUserId = vi.mocked(getCurrentUserId);

import { POST as postQuickLog } from '@/app/api/log/route';

function jsonRequest(body: unknown): Request {
  return new Request('http://test.local/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function seed(suffix: string) {
  const user = await db.user.create({
    data: { email: `${suffix}@quick-log.test`, passwordHash: 'test-password-hash' },
  });
  const exercise = await db.exercise.create({
    data: { userId: user.id, name: 'Bench Press', muscleGroup: 'CHEST', category: 'COMPOUND' },
  });
  mockUserId.mockResolvedValue(user.id);
  return { user, exercise };
}

beforeEach(() => {
  mockUserId.mockReset();
});

describe('POST /api/log', () => {
  it('records the sets the form submitted', async () => {
    const { user, exercise } = await seed('quick-basic');

    const response = await postQuickLog(
      jsonRequest({ exerciseId: exercise.id, weight: 60, reps: 8, sets: 3 }),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { sessionId: string; setCount: number };
    expect(body.setCount).toBe(3);

    const sets = await db.set.findMany({
      where: { sessionId: body.sessionId },
      orderBy: { setNumber: 'asc' },
    });
    expect(sets.map((set) => set.setNumber)).toEqual([1, 2, 3]);
    expect(sets.every((set) => set.weight === 60 && set.reps === 8)).toBe(true);
    // A quick-logged workout is a finished free session.
    expect(
      (await db.session.findUniqueOrThrow({ where: { id: body.sessionId } })).finishedAt,
    ).not.toBeNull();
    expect(user.id).toBeTruthy();
  });

  it('converts the trainee’s unit before it validates', async () => {
    const { user, exercise } = await seed('quick-lb');
    await db.user.update({ where: { id: user.id }, data: { unit: 'LB' } });

    const response = await postQuickLog(
      jsonRequest({ exerciseId: exercise.id, weight: 135, reps: 5, sets: 1 }),
    );

    expect(response.status).toBe(201);
    const set = await db.set.findFirstOrThrow({ where: { exerciseId: exercise.id } });
    expect(set.weight).toBeCloseTo(61.2, 1);
  });

  it('refuses an exercise the caller does not own', async () => {
    const owner = await seed('quick-owner');
    const stranger = await db.user.create({
      data: { email: 'quick-stranger@quick-log.test', passwordHash: 'test-password-hash' },
    });
    mockUserId.mockResolvedValue(stranger.id);

    const response = await postQuickLog(
      jsonRequest({ exerciseId: owner.exercise.id, weight: 60, reps: 8, sets: 3 }),
    );

    expect(response.status).toBe(404);
    expect(await db.set.count()).toBe(0);
    expect(await db.session.count({ where: { userId: stranger.id } })).toBe(0);
  });

  it('refuses numbers the manual form would refuse', async () => {
    const { exercise } = await seed('quick-invalid');

    for (const payload of [
      { exerciseId: exercise.id, weight: -5, reps: 8, sets: 3 },
      { exerciseId: exercise.id, weight: 60, reps: 0, sets: 3 },
      { exerciseId: exercise.id, weight: 60, reps: 8, sets: 0 },
      { exerciseId: exercise.id, weight: 60, reps: 8, sets: 50 },
    ]) {
      const response = await postQuickLog(jsonRequest(payload));
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    expect(await db.set.count()).toBe(0);
  });
});

describe('loadQuickLogState', () => {
  it('orders movements by recent use and remembers what was last done', async () => {
    const user = await db.user.create({
      data: { email: 'quick-state@quick-log.test', passwordHash: 'test-password-hash' },
    });
    const [alpha, beta] = await Promise.all([
      db.exercise.create({
        data: { userId: user.id, name: 'Alpha press', muscleGroup: 'CHEST', category: 'COMPOUND' },
      }),
      db.exercise.create({
        data: {
          userId: user.id,
          name: 'Beta row',
          muscleGroup: 'BACK_THICKNESS',
          category: 'COMPOUND',
        },
      }),
    ]);
    const session = await db.session.create({ data: { userId: user.id, finishedAt: new Date() } });
    await db.set.create({
      data: {
        sessionId: session.id,
        exerciseId: beta.id,
        setNumber: 1,
        weight: 40,
        reps: 10,
        completedAt: new Date('2026-09-19T10:00:00.000Z'),
      },
    });
    await db.set.create({
      data: {
        sessionId: session.id,
        exerciseId: beta.id,
        setNumber: 2,
        weight: 42.5,
        reps: 9,
        completedAt: new Date('2026-09-19T10:05:00.000Z'),
      },
    });

    const state = await loadQuickLogState(user.id, new Date('2026-09-20T10:00:00.000Z'));

    // The recently trained movement comes first, with its latest set as the
    // default the form prefills.
    expect(state.exercises[0]?.id).toBe(beta.id);
    expect(state.exercises[0]?.lastWeight).toBe(42.5);
    expect(state.exercises[0]?.lastReps).toBe(9);
    expect(state.exercises[0]?.lastSets).toBe(2);

    // The untouched movement is never trained, so it keeps no default - and it
    // sits in the alphabetical tail behind the movement that was used. The tail
    // is the whole default library now, so the assertion is about the ordering
    // rule rather than about a list length.
    const alphaState = state.exercises.find((exercise) => exercise.id === alpha.id);
    expect(alphaState?.lastWeight).toBeNull();
    const rest = state.exercises.slice(1).map((exercise) => exercise.name);
    expect(state.exercises.slice(1).map((exercise) => exercise.id)).not.toContain(beta.id);
    expect(rest).toContain('Alpha press');
    expect(rest).toEqual([...rest].sort((left, right) => left.localeCompare(right)));
  });

  it('shows only today’s sets', async () => {
    const user = await db.user.create({
      data: { email: 'quick-today@quick-log.test', passwordHash: 'test-password-hash' },
    });
    const exercise = await db.exercise.create({
      data: { userId: user.id, name: 'Bench Press', muscleGroup: 'CHEST', category: 'COMPOUND' },
    });
    const session = await db.session.create({ data: { userId: user.id, finishedAt: new Date() } });
    await db.set.create({
      data: {
        sessionId: session.id,
        exerciseId: exercise.id,
        setNumber: 1,
        weight: 60,
        reps: 8,
        completedAt: new Date('2026-09-18T10:00:00.000Z'),
      },
    });
    await db.set.create({
      data: {
        sessionId: session.id,
        exerciseId: exercise.id,
        setNumber: 2,
        weight: 65,
        reps: 6,
        completedAt: new Date('2026-09-20T10:00:00.000Z'),
      },
    });

    const state = await loadQuickLogState(user.id, new Date('2026-09-20T12:00:00.000Z'));

    expect(state.todaySets.map((set) => set.weight)).toEqual([65]);
  });
});
