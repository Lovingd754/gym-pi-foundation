import { describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { loadConversationContext } from '@/lib/agent/context';

describe('loadConversationContext', () => {
  it('excludes the current message by ID without removing an earlier identical message', async () => {
    const user = await db.user.create({
      data: { email: 'context-current@example.com', passwordHash: 'test-password-hash' },
    });
    const conversation = await db.agentConversation.create({ data: { userId: user.id } });
    await db.agentMessage.create({
      data: { conversationId: conversation.id, role: 'USER', content: 'Same words' },
    });
    const current = await db.agentMessage.create({
      data: { conversationId: conversation.id, role: 'USER', content: 'Same words' },
    });
    const context = await loadConversationContext(user.id, conversation.id, undefined, current.id);
    expect(context.turns.map((turn) => turn.content)).toEqual(['Same words']);
  });
  it('returns all unsummarized messages in chronological order', async () => {
    const user = await db.user.create({
      data: {
        email: 'context@example.com',
        passwordHash: 'test-password-hash',
      },
    });
    const conversation = await db.agentConversation.create({
      data: { userId: user.id, title: 'Context' },
    });
    await db.agentMessage.createMany({
      data: Array.from({ length: 25 }, (_, index) => ({
        conversationId: conversation.id,
        role: index % 2 === 0 ? ('USER' as const) : ('ASSISTANT' as const),
        content: 'message-' + String(index).padStart(2, '0'),
        createdAt: new Date(Date.UTC(2026, 8, 13, 0, index)),
      })),
    });
    await db.agentMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'ASSISTANT',
        status: 'INCOMPLETE',
        content: 'partial-response-must-not-enter-context',
        createdAt: new Date(Date.UTC(2026, 8, 13, 1, 0)),
      },
    });

    const context = await loadConversationContext(user.id, conversation.id);

    expect(context.summary).toBeNull();
    expect(context.turns).toHaveLength(25);
    expect(context.turns[0]?.content).toBe('message-00');
    expect(context.turns[24]?.content).toBe('message-24');
  });

  it('sends the digest plus only the messages it does not cover', async () => {
    const user = await db.user.create({
      data: { email: 'context-compacted@example.com', passwordHash: 'test-password-hash' },
    });
    const conversation = await db.agentConversation.create({
      data: { userId: user.id, title: 'Compacted', contextSummary: 'The trainee is cutting.' },
    });
    await db.agentMessage.createMany({
      data: Array.from({ length: 10 }, (_, index) => ({
        conversationId: conversation.id,
        role: index % 2 === 0 ? ('USER' as const) : ('ASSISTANT' as const),
        content: 'message-' + String(index).padStart(2, '0'),
        createdAt: new Date(Date.UTC(2026, 8, 13, 0, index)),
      })),
    });
    // Everything up to and including message-05 is covered by the digest.
    await db.agentConversation.update({
      where: { id: conversation.id },
      data: { summarizedThrough: new Date(Date.UTC(2026, 8, 13, 0, 5)) },
    });

    const context = await loadConversationContext(user.id, conversation.id);

    expect(context.summary).toBe('The trainee is cutting.');
    expect(context.turns.map((turn) => turn.content)).toEqual([
      'message-06',
      'message-07',
      'message-08',
      'message-09',
    ]);
  });

  it('uses the same not-found result for missing and foreign conversations', async () => {
    const owner = await db.user.create({
      data: {
        email: 'context-owner@example.com',
        passwordHash: 'test-password-hash',
      },
    });
    const other = await db.user.create({
      data: {
        email: 'context-other@example.com',
        passwordHash: 'test-password-hash',
      },
    });
    const conversation = await db.agentConversation.create({
      data: { userId: owner.id, title: 'Private' },
    });

    await expect(loadConversationContext(other.id, conversation.id)).rejects.toEqual(
      expect.objectContaining({ code: 'CONVERSATION_NOT_FOUND' }),
    );
    await expect(loadConversationContext(other.id, 'missing-conversation')).rejects.toEqual(
      expect.objectContaining({ code: 'CONVERSATION_NOT_FOUND' }),
    );
  });

  it('starts a brand-new conversation with no digest and no history', async () => {
    await expect(loadConversationContext('any-user')).resolves.toEqual({
      summary: null,
      memories: [],
      turns: [],
    });
  });

  it('carries confirmed memories into a conversation that has never seen them', async () => {
    const user = await db.user.create({
      data: { email: 'context-memory@example.com', passwordHash: 'test-password-hash' },
    });
    // Confirmed in one thread...
    await db.agentMemory.create({
      data: { userId: user.id, content: '膝盖怕深蹲', status: 'ACTIVE' },
    });
    // ...while a proposal the trainee has not accepted must stay out.
    await db.agentMemory.create({
      data: { userId: user.id, content: '可能不喜欢早上训练', status: 'PENDING' },
    });
    const other = await db.agentConversation.create({
      data: { userId: user.id, title: 'A different thread' },
    });

    const context = await loadConversationContext(user.id, other.id);

    expect(context.memories).toEqual(['膝盖怕深蹲']);
    expect(context.turns).toEqual([]);
  });

  it('has the memories even when the run is not tied to a conversation', async () => {
    const user = await db.user.create({
      data: { email: 'context-memory-2@example.com', passwordHash: 'test-password-hash' },
    });
    await db.agentMemory.create({
      data: { userId: user.id, content: '只在午休健身', status: 'ACTIVE' },
    });

    const context = await loadConversationContext(user.id);

    expect(context.memories).toEqual(['只在午休健身']);
  });
});
