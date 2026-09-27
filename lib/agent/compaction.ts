import { db } from '@/lib/db';
import type { LlmMessage } from '@/lib/llm';
import { getLlmProviderFor } from '@/lib/llm/settings';
import { AgentContextError } from './context';

// ============================================================
// Long-thread compaction
// ============================================================
// A conversation that runs long enough eventually costs more than it is worth:
// every turn re-sends the whole history, the oldest parts stop being relevant,
// and the model gets slower for no benefit. So once the un-folded history grows
// past a threshold, the oldest exchanges are folded into one short digest that
// is persisted on the conversation. Later runs read the digest as background
// and load only the recent messages verbatim.
//
// Two properties matter:
//   - The trainee's own words are never lost silently. The digest is additive:
//     messages stay in the transcript and in the history UI; only what the
//     *model* is sent changes, and the interface says so.
//   - A failed summarizer must not break the chat. Falling back to a
//     deterministic digest keeps the loop running with a worse summary rather
//     than dropping the history on the floor.

// How many un-folded messages are allowed to pile up before we compact.
export const COMPACTION_TRIGGER_MESSAGES = 30;
// How many of the newest messages always stay verbatim, so the immediate
// back-and-forth the trainee is in the middle of is never summarized away.
export const COMPACTION_KEEP_RECENT = 12;
// Upper bound on the rows a single compaction reads. A thread longer than this
// compacts again on the next turn, so the work stays bounded.
const COMPACTION_READ_CAP = 400;
// The digest is background, not a transcript: keep it short enough to read at a
// glance and to re-send on every turn.
const DIGEST_MAX_CHARS = 1200;

// Marker the summarizer prompt carries so the keyless demo provider can answer
// it instead of returning a coaching reply.
export const COMPACTION_PROMPT_MARKER = 'COMPACT-CONVERSATION';

export interface CompactionMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt: Date;
}

export interface CompactionResult {
  compacted: boolean;
  // How many messages were folded into the digest on this pass.
  folded?: number;
}

export function shouldCompact(unfoldedMessageCount: number): boolean {
  return unfoldedMessageCount > COMPACTION_TRIGGER_MESSAGES;
}

// Everything older than the newest `COMPACTION_KEEP_RECENT` messages.
export function selectFoldRange<T>(messages: T[]): T[] {
  if (messages.length <= COMPACTION_KEEP_RECENT) return [];
  return messages.slice(0, messages.length - COMPACTION_KEEP_RECENT);
}

export function buildCompactionPrompt(
  existingSummary: string | null,
  messages: CompactionMessage[],
): { system: string; messages: LlmMessage[] } {
  const system = `You maintain the running memory of a fitness coaching conversation. ${COMPACTION_PROMPT_MARKER}

Rewrite the conversation so far as one compact briefing that a coach could read before the next reply. Keep, in this order:
1. what the trainee wants and how it is going;
2. durable facts they stated about themselves (preferences, constraints, habits, schedule);
3. decisions already made and anything they were told to do;
4. questions left open.

Rules:
- Write in the third person, present tense. "The trainee prefers morning sessions."
- Keep every fact that would change future advice and drop everything else: no pleasantries, no repeated advice, no numbers that were never agreed.
- Never add advice of your own, never guess, and never invent a fact that is not in the transcript.
- Do not mention medical conditions beyond a constraint the trainee stated themselves.
- At most ${DIGEST_MAX_CHARS} characters. Plain prose or short bullets, no headings.`;

  const transcript = messages
    .map((message) => `${message.role === 'user' ? 'Trainee' : 'Coach'}: ${message.content}`)
    .join('\n\n');

  const messages_: LlmMessage[] = [
    {
      role: 'user',
      content: existingSummary
        ? `Existing briefing:\n${existingSummary}\n\nNew exchanges to fold in:\n${transcript}`
        : `Conversation so far:\n${transcript}`,
    },
  ];

  return { system, messages: messages_ };
}

// The no-model path. Coarser than a real summary but faithful: it quotes what
// the trainee actually asked instead of paraphrasing, so nothing is invented.
export function deterministicDigest(
  existingSummary: string | null,
  messages: CompactionMessage[],
): string {
  const asked = messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content.replace(/\s+/g, ' ').trim())
    .filter((content) => content !== '');

  const highlights = asked.length <= 4 ? asked : [...asked.slice(0, 2), ...asked.slice(-2)];
  const lines = [
    `Earlier in this conversation the trainee raised ${asked.length} ${asked.length === 1 ? 'point' : 'points'}. Most recent, in their words:`,
    ...highlights.map((content) => `- ${content.length > 120 ? `${content.slice(0, 119)}…` : content}`),
  ];
  if (existingSummary) lines.unshift(existingSummary);

  const digest = lines.join('\n');
  return digest.length > DIGEST_MAX_CHARS ? `${digest.slice(0, DIGEST_MAX_CHARS - 1)}…` : digest;
}

export interface CompactionDependencies {
  loadConversation(
    userId: string,
    conversationId: string,
  ): Promise<{ contextSummary: string | null; summarizedThrough: Date | null } | null>;
  loadMessages(conversationId: string, since: Date | null): Promise<CompactionMessage[]>;
  summarize(input: {
    userId: string;
    existingSummary: string | null;
    messages: CompactionMessage[];
  }): Promise<string>;
  saveSummary(input: {
    conversationId: string;
    summary: string;
    summarizedThrough: Date;
  }): Promise<void>;
}

export const prismaCompactionDependencies: CompactionDependencies = {
  async loadConversation(userId, conversationId) {
    const conversation = await db.agentConversation.findFirst({
      where: { id: conversationId, userId },
      select: { contextSummary: true, summarizedThrough: true },
    });
    return conversation ?? null;
  },

  async loadMessages(conversationId, since) {
    const messages = await db.agentMessage.findMany({
      where: {
        conversationId,
        status: 'COMPLETE',
        ...(since ? { createdAt: { gt: since } } : {}),
      },
      // Oldest first: the cap must drop the *newest* rows, because those stay
      // verbatim and will be folded on a later pass.
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: COMPACTION_READ_CAP,
      select: { role: true, content: true, createdAt: true },
    });
    return messages.map((message) => ({
      role: message.role === 'ASSISTANT' ? ('assistant' as const) : ('user' as const),
      content: message.content,
      createdAt: message.createdAt,
    }));
  },

  async summarize({ existingSummary, messages, userId }) {
    const prompt = buildCompactionPrompt(existingSummary, messages);
    const provider = await getLlmProviderFor(userId);
    const result = await provider.complete({
      system: prompt.system,
      messages: prompt.messages,
      // A reasoning model thinks first; leaving room for the digest means not
      // losing it to the thought that produced it.
      maxTokens: 2500,
    });
    return result.text.trim();
  },

  async saveSummary({ conversationId, summary, summarizedThrough }) {
    await db.agentConversation.update({
      where: { id: conversationId },
      data: { contextSummary: summary, summarizedThrough, summaryUpdatedAt: new Date() },
    });
  },
};

export async function compactConversation(
  userId: string,
  conversationId: string,
  overrides: Partial<CompactionDependencies> = {},
): Promise<CompactionResult> {
  const dependencies: CompactionDependencies = { ...prismaCompactionDependencies, ...overrides };
  const conversation = await dependencies.loadConversation(userId, conversationId);
  if (!conversation) throw new AgentContextError('CONVERSATION_NOT_FOUND');

  const messages = await dependencies.loadMessages(conversationId, conversation.summarizedThrough);
  if (!shouldCompact(messages.length)) return { compacted: false };

  const fold = selectFoldRange(messages);
  const through = fold[fold.length - 1];
  if (!through) return { compacted: false };

  let summary = '';
  try {
    summary = await dependencies.summarize({
      userId,
      existingSummary: conversation.contextSummary,
      messages: fold,
    });
  } catch {
    summary = '';
  }

  const digest =
    summary === ''
      ? deterministicDigest(conversation.contextSummary, fold)
      : summary.slice(0, DIGEST_MAX_CHARS);

  await dependencies.saveSummary({
    conversationId,
    summary: digest,
    summarizedThrough: through.createdAt,
  });
  return { compacted: true, folded: fold.length };
}
