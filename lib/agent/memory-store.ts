import { db } from '@/lib/db';

// ============================================================
// Agent memory
// ============================================================
// Two rules shape this store.
//
// 1. The agent can only *propose*. A memory is invisible to every future
//    conversation until the trainee confirms it, so the model can never turn
//    its own guess into a stored fact.
// 2. A memory is one short sentence, not a transcript excerpt. Bounding it
//    keeps the stored text readable in a settings list and keeps a stray long
//    tool argument from becoming permanent context.

export const MEMORY_CONTENT_MAX_CHARS = 200;

export type AgentMemoryStatus = 'PENDING' | 'ACTIVE';

export interface AgentMemoryView {
  id: string;
  content: string;
  status: AgentMemoryStatus;
  createdAt: Date;
}

export interface ProposeMemoryResult {
  id: string;
  status: AgentMemoryStatus;
  // False when an identical proposal (or an already-active memory) existed, so
  // the caller can tell the model "already known" instead of "just proposed".
  created: boolean;
}

export interface AgentMemoryStore {
  propose(input: {
    userId: string;
    conversationId?: string;
    content: string;
  }): Promise<ProposeMemoryResult>;
  confirm(userId: string, memoryId: string): Promise<boolean>;
  dismiss(userId: string, memoryId: string): Promise<boolean>;
  list(userId: string, status: AgentMemoryStatus): Promise<AgentMemoryView[]>;
  remove(userId: string, memoryId: string): Promise<boolean>;
}

export class AgentMemoryContentError extends Error {
  constructor(readonly code: 'MEMORY_EMPTY' | 'MEMORY_TOO_LONG') {
    super(code);
    this.name = 'AgentMemoryContentError';
  }
}

export function normalizeMemoryContent(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized === '') throw new AgentMemoryContentError('MEMORY_EMPTY');
  if (normalized.length > MEMORY_CONTENT_MAX_CHARS) {
    throw new AgentMemoryContentError('MEMORY_TOO_LONG');
  }
  return normalized;
}

export const prismaAgentMemoryStore: AgentMemoryStore = {
  async propose({ userId, conversationId, content }) {
    const normalized = normalizeMemoryContent(content);

    // Re-proposing something the trainee already has is noise, not a new fact.
    // Reusing the row also means the confirmation card does not multiply.
    const existing = await db.agentMemory.findFirst({
      where: { userId, content: normalized, status: { in: ['PENDING', 'ACTIVE'] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true },
    });
    if (existing) {
      return { id: existing.id, status: existing.status, created: false };
    }

    const created = await db.agentMemory.create({
      data: {
        userId,
        content: normalized,
        sourceConversationId: conversationId ?? null,
      },
      select: { id: true },
    });
    return { id: created.id, status: 'PENDING', created: true };
  },

  async confirm(userId, memoryId) {
    // Ownership is part of the update, so a foreign id simply matches nothing.
    const result = await db.agentMemory.updateMany({
      where: { id: memoryId, userId, status: 'PENDING' },
      data: { status: 'ACTIVE', decidedAt: new Date() },
    });
    return result.count > 0;
  },

  async dismiss(userId, memoryId) {
    // "Don't remember this" has to be real: the pending row is deleted rather
    // than parked, so it can never surface again.
    const result = await db.agentMemory.deleteMany({
      where: { id: memoryId, userId, status: 'PENDING' },
    });
    return result.count > 0;
  },

  async list(userId, status) {
    const memories = await db.agentMemory.findMany({
      where: { userId, status },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, content: true, status: true, createdAt: true },
    });
    return memories.map((memory) => ({
      id: memory.id,
      content: memory.content,
      status: memory.status,
      createdAt: memory.createdAt,
    }));
  },

  async remove(userId, memoryId) {
    const result = await db.agentMemory.deleteMany({ where: { id: memoryId, userId } });
    return result.count > 0;
  },
};
