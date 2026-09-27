import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { getCurrentUserId } from '@/lib/auth';
import { applyLogProposal, prismaLogProposalStore } from '@/lib/agent/log-proposals';

vi.mock('@/lib/auth', () => ({ getCurrentUserId: vi.fn() }));
const mockUserId = vi.mocked(getCurrentUserId);

import { POST as postLog } from '@/app/api/agent/log-proposals/[id]/route';

function jsonRequest(body: unknown): Request {
  return new Request('http://test.local/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function idParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function seed(suffix: string) {
  const user = await db.user.create({
    data: { email: `${suffix}@log.test`, passwordHash: 'test-password-hash' },
  });
  const exercise = await db.exercise.create({
    data: { userId: user.id, name: 'Bench Press', muscleGroup: 'CHEST', category: 'COMPOUND' },
  });
  mockUserId.mockResolvedValue(user.id);
  return { user, exercise };
}

function propose(userId: string, exerciseId: string, overrides: Partial<{ sets: number; weight: number }> = {}) {
  return prismaLogProposalStore.propose({
    userId,
    entry: {
      exerciseId,
      weight: overrides.weight ?? 60,
      reps: 8,
      sets: overrides.sets ?? 3,
      rir: 2,
    },
    summary: [{ label: 'Movement', value: 'Bench Press' }],
  });
}

beforeEach(() => {
  mockUserId.mockReset();
});

describe('applying a log proposal', () => {
  it('writes the sets into a finished free session when nothing is in progress', async () => {
    const { user, exercise } = await seed('log-fresh');
    const proposal = await propose(user.id, exercise.id);

    const response = await postLog(jsonRequest({ action: 'log' }), idParams(proposal.id));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { sessionId: string; finishedSession: boolean };

    const session = await db.session.findUniqueOrThrow({ where: { id: body.sessionId } });
    expect(session.userId).toBe(user.id);
    expect(session.finishedAt).not.toBeNull();
    // A chat-logged workout is a free session, not a program session.
    expect(session.programId).toBeNull();
    expect(body.finishedSession).toBe(true);

    const sets = await db.set.findMany({
      where: { sessionId: body.sessionId },
      orderBy: { setNumber: 'asc' },
    });
    expect(sets.map((set) => set.setNumber)).toEqual([1, 2, 3]);
    expect(sets.every((set) => set.weight === 60 && set.reps === 8 && set.rir === 2)).toBe(true);

    const stored = await db.agentLogProposal.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(stored.status).toBe('APPLIED');
    expect(stored.resultSessionId).toBe(body.sessionId);
  });

  it('joins a workout that is still in progress and leaves it open', async () => {
    const { user, exercise } = await seed('log-inprogress');
    const session = await db.session.create({ data: { userId: user.id } });
    await db.set.create({
      data: { sessionId: session.id, exerciseId: exercise.id, setNumber: 1, weight: 55, reps: 8 },
    });
    const proposal = await propose(user.id, exercise.id, { sets: 2 });

    const response = await postLog(jsonRequest({ action: 'log' }), idParams(proposal.id));
    const body = (await response.json()) as { sessionId: string; finishedSession: boolean };

    expect(body.sessionId).toBe(session.id);
    expect(body.finishedSession).toBe(false);
    expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).finishedAt).toBeNull();

    const sets = await db.set.findMany({
      where: { sessionId: session.id },
      orderBy: { setNumber: 'asc' },
    });
    // The new sets continue the numbering instead of colliding with set 1.
    expect(sets.map((set) => set.setNumber)).toEqual([1, 2, 3]);
  });

  it('never lets a stranger write into someone else’s history', async () => {
    const owner = await seed('log-owner');
    const proposal = await propose(owner.user.id, owner.exercise.id);
    const stranger = await db.user.create({
      data: { email: 'log-stranger@log.test', passwordHash: 'test-password-hash' },
    });
    mockUserId.mockResolvedValue(stranger.id);

    const log = await postLog(jsonRequest({ action: 'log' }), idParams(proposal.id));
    expect(log.status).toBe(404);
    const dismiss = await postLog(jsonRequest({ action: 'dismiss' }), idParams(proposal.id));
    expect(dismiss.status).toBe(404);

    expect(await db.session.count({ where: { userId: stranger.id } })).toBe(0);
    expect(await db.set.count()).toBe(0);
    const stored = await db.agentLogProposal.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(stored.status).toBe('PENDING');
  });

  it('deletes a declined entry instead of parking it', async () => {
    const { user, exercise } = await seed('log-dismiss');
    const proposal = await propose(user.id, exercise.id);

    const response = await postLog(jsonRequest({ action: 'dismiss' }), idParams(proposal.id));

    expect(response.status).toBe(200);
    expect(await db.agentLogProposal.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.set.count()).toBe(0);
  });

  it('refuses a proposal whose exercise has since been deleted', async () => {
    const { user, exercise } = await seed('log-exercise-gone');
    const proposal = await propose(user.id, exercise.id);
    await db.set.deleteMany({ where: { exerciseId: exercise.id } });
    await db.exercise.delete({ where: { id: exercise.id } });

    await expect(applyLogProposal(user.id, proposal.id)).rejects.toMatchObject({ status: 404 });
    expect(await db.set.count()).toBe(0);
  });
});
