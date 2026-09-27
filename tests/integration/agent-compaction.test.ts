import { describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { COMPACTION_TRIGGER_MESSAGES, compactConversation } from '@/lib/agent/compaction';
import { loadConversationContext } from '@/lib/agent/context';

// Only the summarizer is replaced: the rest of the pipeline (ownership check,
// fold range, persistence, context loading) runs against the real database.
const stubSummarizer = { summarize: async () => 'The trainee trains three days a week.' };

async function seedThread(email: string, messageCount: number) {
  const user = await db.user.create({ data: { email, passwordHash: 'test-password-hash' } });
  const conversation = await db.agentConversation.create({
    data: { userId: user.id, title: 'Long thread' },
  });
  await db.agentMessage.createMany({
    data: Array.from({ length: messageCount }, (_, index) => ({
      conversationId: conversation.id,
      role: index % 2 === 0 ? ('USER' as const) : ('ASSISTANT' as const),
      content: `message-${String(index).padStart(2, '0')}`,
      createdAt: new Date(Date.UTC(2026, 8, 19, 0, index)),
    })),
  });
  return { user, conversation };
}

describe('compactConversation', () => {
  it('folds the old exchanges and leaves the recent ones verbatim', async () => {
    const { user, conversation } = await seedThread('compact@example.com', 40);

    const result = await compactConversation(user.id, conversation.id, stubSummarizer);

    expect(result).toEqual({ compacted: true, folded: 28 });

    const context = await loadConversationContext(user.id, conversation.id);
    expect(context.summary).toBe('The trainee trains three days a week.');
    // 40 messages, 12 kept verbatim: the model sees the digest plus the last 12.
    expect(context.turns).toHaveLength(12);
    expect(context.turns[0]?.content).toBe('message-28');

    // The transcript is untouched. Compaction changes what the model is sent,
    // never what the trainee can look back at.
    expect(await db.agentMessage.count({ where: { conversationId: conversation.id } })).toBe(40);
  });

  it('is a no-op once it has caught up', async () => {
    const { user, conversation } = await seedThread('compact-caught-up@example.com', 40);

    await compactConversation(user.id, conversation.id, stubSummarizer);

    // 12 messages remain unfolded, below the trigger: a second pass must not
    // fold the messages it just decided to keep.
    await expect(
      compactConversation(user.id, conversation.id, stubSummarizer),
    ).resolves.toEqual({ compacted: false });
  });

  it('folds again once enough new exchanges accumulate', async () => {
    const { user, conversation } = await seedThread('compact-again@example.com', 40);
    await compactConversation(user.id, conversation.id, stubSummarizer);

    await db.agentMessage.createMany({
      data: Array.from({ length: COMPACTION_TRIGGER_MESSAGES }, (_, index) => ({
        conversationId: conversation.id,
        role: 'USER' as const,
        content: `later-${index}`,
        createdAt: new Date(Date.UTC(2026, 8, 20, 0, index)),
      })),
    });

    const second = await compactConversation(user.id, conversation.id, {
      summarize: async () => 'digest v2',
    });

    expect(second.compacted).toBe(true);
    const context = await loadConversationContext(user.id, conversation.id);
    expect(context.summary).toBe('digest v2');
    expect(context.turns).toHaveLength(12);
  });

  it('refuses a conversation the caller does not own', async () => {
    const { conversation } = await seedThread('compact-owner@example.com', 40);
    const stranger = await db.user.create({
      data: { email: 'compact-stranger@example.com', passwordHash: 'test-password-hash' },
    });

    await expect(
      compactConversation(stranger.id, conversation.id, stubSummarizer),
    ).rejects.toEqual(expect.objectContaining({ code: 'CONVERSATION_NOT_FOUND' }));
    expect(
      (await db.agentConversation.findUniqueOrThrow({ where: { id: conversation.id } }))
        .contextSummary,
    ).toBeNull();
  });
});
