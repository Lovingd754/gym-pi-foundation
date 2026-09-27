import { db } from '@/lib/db';
import { Prisma } from '@/prisma/generated/client';
import { AgentContextError } from './context';
import { parseTaskState, type AgentTaskState } from './task-state';
export interface TaskStateStore {
  load(
    userId: string,
    conversationId: string,
  ): Promise<{ state: AgentTaskState | null; revision: number }>;
  save(
    userId: string,
    conversationId: string,
    revision: number,
    state: AgentTaskState | null,
  ): Promise<boolean>;
}
export const prismaTaskStateStore: TaskStateStore = {
  async load(userId, conversationId) {
    const row = await db.agentConversation.findFirst({
      where: { id: conversationId, userId },
      select: { taskState: true, taskStateRevision: true },
    });
    if (!row) throw new AgentContextError('CONVERSATION_NOT_FOUND');
    const state = parseTaskState(row.taskState);
    if (state?.pending) {
      const where = { id: state.pending.id, userId, conversationId };
      const proposal =
        state.pending.tool === 'log_workout'
          ? await db.agentLogProposal.findFirst({ where, select: { status: true } })
          : state.pending.tool === 'propose_plan_change'
            ? await db.agentPlanProposal.findFirst({ where, select: { status: true } })
            : await db.agentMemory.findFirst({ where, select: { status: true } });
      if (!proposal || proposal.status !== 'PENDING')
        return { state: null, revision: row.taskStateRevision };
    }
    return { state, revision: row.taskStateRevision };
  },
  async save(userId, conversationId, revision, state) {
    const result = await db.agentConversation.updateMany({
      where: { id: conversationId, userId, taskStateRevision: revision },
      data: {
        taskState: state ? (state as Prisma.InputJsonValue) : Prisma.DbNull,
        taskStateRevision: { increment: 1 },
      },
    });
    return result.count === 1;
  },
};
