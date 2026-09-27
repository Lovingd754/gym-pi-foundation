import { db } from '@/lib/db';
import { deriveConversationTitle } from '@/lib/chat';

export type AgentMessageRole = 'USER' | 'ASSISTANT';

export interface AgentConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export interface AgentChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export class AgentConversationNotFoundError extends Error {
  constructor() {
    super('AGENT_CONVERSATION_NOT_FOUND');
    this.name = 'AgentConversationNotFoundError';
  }
}

// Resolves the conversation a run belongs to. Ownership is part of the query
// rather than a separate comparison, so a foreign id can never be adopted.
export async function resolveAgentConversation(
  userId: string,
  conversationId: string | undefined,
  firstMessage: string,
): Promise<string> {
  if (!conversationId) {
    const created = await db.agentConversation.create({
      data: { userId, title: deriveConversationTitle(firstMessage) },
      select: { id: true },
    });
    return created.id;
  }

  const owned = await db.agentConversation.findFirst({
    where: { id: conversationId, userId },
    select: { id: true },
  });
  if (!owned) throw new AgentConversationNotFoundError();
  return owned.id;
}

export async function appendAgentMessage(
  conversationId: string,
  role: AgentMessageRole,
  content: string,
): Promise<string> {
  const message = await db.agentMessage.create({
    data: { conversationId, role, content },
    select: { id: true },
  });
  await db.agentConversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
  });
  return message.id;
}

export async function listAgentConversations(
  userId: string,
  take = 50,
): Promise<AgentConversationSummary[]> {
  const conversations = await db.agentConversation.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    take,
    select: { id: true, title: true, updatedAt: true },
  });
  return conversations.map((conversation) => ({
    id: conversation.id,
    title: conversation.title ?? '新对话',
    updatedAt: conversation.updatedAt.toISOString(),
  }));
}

export async function loadAgentMessages(
  userId: string,
  conversationId: string,
): Promise<AgentChatMessage[]> {
  const conversation = await db.agentConversation.findFirst({
    where: { id: conversationId, userId },
    select: {
      messages: {
        where: { status: 'COMPLETE' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { role: true, content: true },
      },
    },
  });
  if (!conversation) throw new AgentConversationNotFoundError();

  return conversation.messages.map((message) => ({
    role: message.role === 'ASSISTANT' ? 'assistant' : 'user',
    content: message.content,
  }));
}
