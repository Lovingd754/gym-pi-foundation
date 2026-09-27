import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Model, Usage } from '@earendil-works/pi-ai';
import { db } from '@/lib/db';
import { prismaAgentMemoryStore } from './memory-store';

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface ConversationContext {
  // The folded digest of everything at or before `summarizedThrough`, or null
  // when the thread has never been compacted. Read as background by the model.
  summary: string | null;
  // Facts the trainee confirmed keeping. These follow them into every
  // conversation: a memory that only appears when the model thinks to ask for
  // it is not a memory, so they are loaded on every run rather than exposed as
  // a tool the model may or may not call.
  memories: string[];
  turns: ConversationTurn[];
}

export class AgentContextError extends Error {
  constructor(readonly code: 'CONVERSATION_NOT_FOUND') {
    super(code);
    this.name = 'AgentContextError';
  }
}

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

export async function loadConversationContext(
  userId: string,
  conversationId?: string,
  signal?: AbortSignal,
  currentMessageId?: string,
): Promise<ConversationContext> {
  signal?.throwIfAborted();

  const confirmed = await prismaAgentMemoryStore.list(userId, 'ACTIVE');
  const memories = confirmed.map((memory) => memory.content);
  signal?.throwIfAborted();

  if (!conversationId) return { summary: null, memories, turns: [] };

  const conversation = await db.agentConversation.findFirst({
    where: { id: conversationId, userId },
    select: {
      contextSummary: true,
      summarizedThrough: true,
    },
  });
  if (!conversation) {
    throw new AgentContextError('CONVERSATION_NOT_FOUND');
  }
  signal?.throwIfAborted();

  // A compacted conversation still has its whole transcript on disk; only the
  // model's view is trimmed, and only back to the point the digest covers.
  // Never discard messages that the summary does not yet cover. The current
  // persisted input is added by Agent.prompt(), so exclude that exact row.
  const messages = await db.agentMessage.findMany({
    where: {
      conversationId,
      status: 'COMPLETE',
      ...(conversation.summarizedThrough
        ? { createdAt: { gt: conversation.summarizedThrough } }
        : {}),
      ...(currentMessageId ? { id: { not: currentMessageId } } : {}),
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { role: true, content: true, createdAt: true },
  });
  signal?.throwIfAborted();
  const turns = messages.map((message) => ({
    role: message.role === 'USER' ? ('user' as const) : ('assistant' as const),
    content: message.content,
    timestamp: message.createdAt.getTime(),
  }));

  return { summary: conversation.contextSummary ?? null, memories, turns };
}

export function toPiMessages(turns: ConversationTurn[], model: Model<Api>): AgentMessage[] {
  return turns.map((turn) =>
    turn.role === 'user'
      ? {
          role: 'user',
          content: turn.content,
          timestamp: turn.timestamp,
        }
      : {
          role: 'assistant',
          content: [{ type: 'text', text: turn.content }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: EMPTY_USAGE,
          stopReason: 'stop',
          timestamp: turn.timestamp,
        },
  );
}
