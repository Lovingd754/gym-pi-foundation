import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ conversation: vi.fn(), proposal: vi.fn(), update: vi.fn() }));
vi.mock('@/lib/db', () => ({
  db: {
    agentConversation: { findFirst: mocks.conversation, updateMany: mocks.update },
    agentLogProposal: { findFirst: mocks.proposal },
    agentPlanProposal: { findFirst: mocks.proposal },
    agentMemory: { findFirst: mocks.proposal },
  },
}));
import { prismaTaskStateStore } from './task-state-store';
import { taskAfterTool } from './task-state';
beforeEach(() => vi.clearAllMocks());
it('clears confirmed/dismissed task hints using authoritative proposal status', async () => {
  mocks.conversation.mockResolvedValue({
    taskState: taskAfterTool(null, 'log_workout', {}, { proposalId: 'p' }),
    taskStateRevision: 2,
  });
  mocks.proposal.mockResolvedValue({ status: 'APPLIED' });
  expect(await prismaTaskStateStore.load('owner', 'thread')).toEqual({ state: null, revision: 2 });
  expect(mocks.proposal).toHaveBeenCalledWith({
    where: { id: 'p', userId: 'owner', conversationId: 'thread' },
    select: { status: true },
  });
});
it('uses ownership and revision to prevent stale concurrent overwrites', async () => {
  mocks.update.mockResolvedValue({ count: 0 });
  expect(await prismaTaskStateStore.save('owner', 'thread', 3, null)).toBe(false);
  expect(mocks.update.mock.calls[0]![0].where).toEqual({
    id: 'thread',
    userId: 'owner',
    taskStateRevision: 3,
  });
});
it('refuses a missing/foreign conversation', async () => {
  mocks.conversation.mockResolvedValue(null);
  await expect(prismaTaskStateStore.load('other', 'thread')).rejects.toThrow(
    'CONVERSATION_NOT_FOUND',
  );
});
