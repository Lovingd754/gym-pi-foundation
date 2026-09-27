import type { Prisma } from '@/prisma/generated/client';
import { ApiError } from '@/lib/api';
import { db } from '@/lib/db';
import { writeSets } from '@/lib/quick-log';

// ============================================================
// Logging what the trainee says they did
// ============================================================
// The agent is good at turning "卧推 60 公斤 8 次 3 组" into numbers and bad at
// being trusted with them. So it produces a proposal, the trainee sees exactly
// what would be written, and their tap is what creates the sets. The write
// itself goes through the same set schema and the same session rules as the
// manual form - a proposal is not a shortcut around either.

export interface LogProposalEntry {
  exerciseId: string;
  weight: number;
  reps: number;
  sets: number;
  rir: number | null;
}

export interface LogProposalSummaryRow {
  label: string;
  value: string;
}

export interface LogProposalView {
  id: string;
  summary: LogProposalSummaryRow[];
  createdAt: Date;
}

export interface LogProposalStore {
  propose(input: {
    userId: string;
    conversationId?: string;
    entry: LogProposalEntry;
    summary: LogProposalSummaryRow[];
  }): Promise<{ id: string }>;
  list(userId: string, status: 'PENDING'): Promise<LogProposalView[]>;
  loadPending(
    userId: string,
    proposalId: string,
  ): Promise<{ id: string; entry: LogProposalEntry } | null>;
  markApplied(userId: string, proposalId: string, sessionId: string): Promise<void>;
  dismiss(userId: string, proposalId: string): Promise<boolean>;
}

function readSummary(value: unknown): LogProposalSummaryRow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    if (typeof row !== 'object' || row === null) return [];
    const record = row as Record<string, unknown>;
    if (typeof record.label !== 'string' || typeof record.value !== 'string') return [];
    return [{ label: record.label, value: record.value }];
  });
}

export const prismaLogProposalStore: LogProposalStore = {
  async propose(input) {
    const created = await db.agentLogProposal.create({
      data: {
        userId: input.userId,
        conversationId: input.conversationId ?? null,
        exerciseId: input.entry.exerciseId,
        entry: input.entry as unknown as Prisma.InputJsonValue,
        summary: input.summary as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return { id: created.id };
  },

  async list(userId, status) {
    const rows = await db.agentLogProposal.findMany({
      where: { userId, status },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, summary: true, createdAt: true },
    });
    return rows.map((row) => ({
      id: row.id,
      summary: readSummary(row.summary),
      createdAt: row.createdAt,
    }));
  },

  async loadPending(userId, proposalId) {
    const row = await db.agentLogProposal.findFirst({
      where: { id: proposalId, userId, status: 'PENDING' },
      select: { id: true, entry: true },
    });
    if (!row) return null;
    return { id: row.id, entry: row.entry as unknown as LogProposalEntry };
  },

  async markApplied(userId, proposalId, sessionId) {
    await db.agentLogProposal.updateMany({
      where: { id: proposalId, userId, status: 'PENDING' },
      data: { status: 'APPLIED', resultSessionId: sessionId, decidedAt: new Date() },
    });
  },

  async dismiss(userId, proposalId) {
    const result = await db.agentLogProposal.deleteMany({
      where: { id: proposalId, userId, status: 'PENDING' },
    });
    return result.count > 0;
  },
};

export interface ApplyLogResult {
  sessionId: string;
  setCount: number;
  finishedSession: boolean;
}

// Writes the sets the trainee confirmed.
//
// An unfinished session means they are mid-workout, so the sets join it and it
// stays open. Otherwise the log is something they did earlier, so it gets its
// own free session, finished immediately - which is how it then appears in
// history like any other workout.
export async function applyLogProposal(
  userId: string,
  proposalId: string,
  store: LogProposalStore = prismaLogProposalStore,
  now: () => Date = () => new Date(),
): Promise<ApplyLogResult> {
  const proposal = await store.loadPending(userId, proposalId);
  if (!proposal) throw new ApiError(404, '这条记录已经处理过了。');

  const exercise = await db.exercise.findFirst({
    where: { id: proposal.entry.exerciseId, userId },
    select: { id: true, category: true },
  });
  if (!exercise) throw new ApiError(404, '找不到这个动作。');

  const result = await writeSets(
    userId,
    {
      exerciseId: proposal.entry.exerciseId,
      weight: proposal.entry.weight,
      reps: proposal.entry.reps,
      sets: proposal.entry.sets,
      rir: proposal.entry.rir,
    },
    now(),
  );

  await store.markApplied(userId, proposalId, result.sessionId);
  return result;
}
