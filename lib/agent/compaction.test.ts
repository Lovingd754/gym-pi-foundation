import { describe, expect, it, vi } from 'vitest';
import {
  COMPACTION_KEEP_RECENT,
  COMPACTION_PROMPT_MARKER,
  COMPACTION_TRIGGER_MESSAGES,
  buildCompactionPrompt,
  compactConversation,
  deterministicDigest,
  selectFoldRange,
  shouldCompact,
  type CompactionDependencies,
  type CompactionMessage,
} from './compaction';

function message(
  index: number,
  role: 'user' | 'assistant' = 'user',
  content = `message-${index}`,
): CompactionMessage {
  return { role, content, createdAt: new Date(Date.UTC(2026, 8, 19, 0, index)) };
}

function conversationOf(count: number): CompactionMessage[] {
  return Array.from({ length: count }, (_, index) =>
    message(index, index % 2 === 0 ? 'user' : 'assistant'),
  );
}

describe('compaction trigger', () => {
  it('leaves a short conversation alone and folds a long one', () => {
    expect(shouldCompact(COMPACTION_TRIGGER_MESSAGES)).toBe(false);
    expect(shouldCompact(COMPACTION_TRIGGER_MESSAGES + 1)).toBe(true);
  });

  it('always keeps the newest messages verbatim', () => {
    const messages = conversationOf(COMPACTION_TRIGGER_MESSAGES + 6);

    const fold = selectFoldRange(messages);

    expect(fold).toHaveLength(messages.length - COMPACTION_KEEP_RECENT);
    expect(fold[0]).toBe(messages[0]);
    expect(fold[fold.length - 1]).toBe(messages[messages.length - COMPACTION_KEEP_RECENT - 1]);
  });

  it('folds nothing when the history is shorter than the kept window', () => {
    expect(selectFoldRange(conversationOf(COMPACTION_KEEP_RECENT))).toEqual([]);
  });
});

describe('compaction prompt', () => {
  it('carries the marker and both sides of the exchange', () => {
    const prompt = buildCompactionPrompt(null, [
      message(1, 'user', '我一周只能练三天'),
      message(2, 'assistant', '那就按全身分化安排。'),
    ]);

    expect(prompt.system).toContain(COMPACTION_PROMPT_MARKER);
    expect(prompt.system).toContain('Never add advice of your own');
    expect(prompt.messages[0]?.content).toContain('Trainee: 我一周只能练三天');
    expect(prompt.messages[0]?.content).toContain('Coach: 那就按全身分化安排。');
  });

  it('carries the previous digest forward so folding is additive', () => {
    const prompt = buildCompactionPrompt('The trainee is cutting.', [message(1)]);

    expect(prompt.messages[0]?.content).toContain('Existing briefing:\nThe trainee is cutting.');
    expect(prompt.messages[0]?.content).toContain('New exchanges to fold in:');
  });
});

describe('deterministicDigest', () => {
  it('quotes what the trainee asked instead of paraphrasing it', () => {
    const digest = deterministicDigest(null, [
      message(1, 'user', '这周只能练两天'),
      message(2, 'assistant', '好的'),
      message(3, 'user', '膝盖有点不舒服'),
    ]);

    expect(digest).toContain('这周只能练两天');
    expect(digest).toContain('膝盖有点不舒服');
    expect(digest).not.toContain('好的');
  });

  it('stays inside its budget and keeps the older digest', () => {
    const long = Array.from({ length: 12 }, (_, index) =>
      message(index, 'user', '字'.repeat(200)),
    );

    const digest = deterministicDigest('Earlier: the trainee is cutting.', long);

    expect(digest.length).toBeLessThanOrEqual(1200);
    expect(digest.startsWith('Earlier: the trainee is cutting.')).toBe(true);
  });
});

describe('compactConversation', () => {
  function dependencies(
    messages: CompactionMessage[],
    overrides: Partial<CompactionDependencies> = {},
  ): { deps: CompactionDependencies; saveSummary: ReturnType<typeof vi.fn> } {
    const saveSummary = vi.fn(async () => {});
    return {
      saveSummary,
      deps: {
        loadConversation: async () => ({ contextSummary: null, summarizedThrough: null }),
        loadMessages: async () => messages,
        summarize: async () => 'The trainee trains three days a week.',
        saveSummary,
        ...overrides,
      },
    };
  }

  it('does nothing while the thread is short', async () => {
    const { deps, saveSummary } = dependencies(conversationOf(COMPACTION_TRIGGER_MESSAGES));

    await expect(compactConversation('user_1', 'conversation_1', deps)).resolves.toEqual({
      compacted: false,
    });
    expect(saveSummary).not.toHaveBeenCalled();
  });

  it('persists the digest and the point it covers', async () => {
    const messages = conversationOf(COMPACTION_TRIGGER_MESSAGES + 4);
    const { deps, saveSummary } = dependencies(messages);

    const result = await compactConversation('user_1', 'conversation_1', deps);

    expect(result).toEqual({ compacted: true, folded: messages.length - COMPACTION_KEEP_RECENT });
    expect(saveSummary).toHaveBeenCalledWith({
      conversationId: 'conversation_1',
      summary: 'The trainee trains three days a week.',
      summarizedThrough: messages[messages.length - COMPACTION_KEEP_RECENT - 1]?.createdAt,
    });
  });

  it('folds the new exchanges into the existing digest', async () => {
    const messages = conversationOf(COMPACTION_TRIGGER_MESSAGES + 4);
    const summarize = vi.fn(async () => 'updated');
    const { deps } = dependencies(messages, {
      loadConversation: async () => ({
        contextSummary: 'Earlier digest.',
        summarizedThrough: null,
      }),
      summarize,
    });

    await compactConversation('user_1', 'conversation_1', deps);

    expect(summarize).toHaveBeenCalledWith(
      expect.objectContaining({ existingSummary: 'Earlier digest.' }),
    );
  });

  it('falls back to a faithful digest when the summarizer fails', async () => {
    const messages = conversationOf(COMPACTION_TRIGGER_MESSAGES + 4);
    const { deps, saveSummary } = dependencies(messages, {
      summarize: async () => {
        throw new Error('provider down');
      },
    });

    const result = await compactConversation('user_1', 'conversation_1', deps);

    expect(result.compacted).toBe(true);
    const saved = saveSummary.mock.calls[0]?.[0] as { summary: string };
    expect(saved.summary).toContain('message-0');
    expect(saved.summary).toContain('trainee raised');
  });

  it('refuses a conversation the caller does not own', async () => {
    const { deps } = dependencies([], { loadConversation: async () => null });

    await expect(compactConversation('user_1', 'conversation_1', deps)).rejects.toEqual(
      expect.objectContaining({ code: 'CONVERSATION_NOT_FOUND' }),
    );
  });
});
