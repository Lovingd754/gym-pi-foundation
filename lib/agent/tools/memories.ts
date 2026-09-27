import { Type } from '@earendil-works/pi-ai';
import {
  MEMORY_CONTENT_MAX_CHARS,
  AgentMemoryContentError,
  prismaAgentMemoryStore,
  type AgentMemoryStore,
} from '../memory-store';
import { loadToolLabels } from './labels';
import {
  defineSummaryTool,
  summaryLines,
  type SummaryDraft,
  type SummaryToolContext,
} from './summary';
import { fillTemplate } from './current-plan';

const READ_LIMIT = 20;

const readParameters = Type.Object({}, { additionalProperties: false });

const proposeParameters = Type.Object(
  {
    content: Type.String({
      minLength: 1,
      maxLength: MEMORY_CONTENT_MAX_CHARS,
      description:
        'One short sentence in the trainee’s own terms, e.g. "Knee hurts on deep squats, prefers goblet squats". Not a transcript excerpt.',
    }),
  },
  { additionalProperties: false },
);

export function createMemoriesTool(
  context: SummaryToolContext,
  store: AgentMemoryStore = prismaAgentMemoryStore,
) {
  return defineSummaryTool<typeof readParameters, { memoryCount: number }>(
    {
      name: 'get_memories',
      label: 'Read remembered notes',
      description:
        'Read the notes the trainee has confirmed keeping, newest first. Pending proposals are deliberately not included.',
      parameters: readParameters,
      async summarize(_params, ctx): Promise<SummaryDraft<{ memoryCount: number }>> {
        const labels = await loadToolLabels(ctx.locale);
        const memories = await store.list(ctx.userId, 'ACTIVE');
        if (memories.length === 0) {
          return {
            text: labels.text(
              'agent.memory.empty',
              'Nothing is remembered about this trainee yet.',
            ),
            details: { memoryCount: 0 },
          };
        }

        const shown = memories.slice(0, READ_LIMIT);
        const header = fillTemplate(
          labels.text('agent.memory.header', 'Remembered notes ({count})'),
          { count: shown.length },
        );
        const footer =
          memories.length > shown.length
            ? labels.text('agent.memory.more', 'Older notes are not shown.')
            : null;

        return {
          text: summaryLines(header, ...shown.map((memory) => `- ${memory.content}`), footer),
          details: { memoryCount: shown.length },
        };
      },
    },
    context,
  );
}

export function createProposeMemoryTool(
  context: SummaryToolContext,
  store: AgentMemoryStore = prismaAgentMemoryStore,
) {
  return defineSummaryTool<typeof proposeParameters, { memoryId: string; status: string }>(
    {
      name: 'propose_memory',
      label: 'Propose a note to remember',
      description:
        'Propose one short note about the trainee worth keeping for later conversations (a preference, a constraint, a habit). This only creates a pending proposal: the trainee still has to accept it, so never say it has been remembered.',
      parameters: proposeParameters,
      async summarize(params, ctx): Promise<SummaryDraft<{ memoryId: string; status: string }>> {
        const labels = await loadToolLabels(ctx.locale);
        try {
          const result = await store.propose({
            userId: ctx.userId,
            conversationId: ctx.conversationId,
            content: params.content,
          });

          if (!result.created && result.status === 'ACTIVE') {
            return {
              text: labels.text(
                'agent.memory.alreadyKept',
                'This is already one of the trainee’s confirmed notes. Do not propose it again; you may simply use it.',
              ),
              details: { memoryId: result.id, status: result.status },
            };
          }
          if (!result.created) {
            return {
              text: labels.text(
                'agent.memory.alreadyPending',
                'An identical note is already waiting for the trainee to accept it. Do not propose it again.',
              ),
              details: { memoryId: result.id, status: result.status },
            };
          }

          return {
            text: labels.text(
              'agent.memory.proposed',
              'A note has been put forward for the trainee to accept or decline. It is NOT saved yet: say you have proposed it and that they decide, never that you have remembered it.',
            ),
            details: { memoryId: result.id, status: result.status },
          };
        } catch (error) {
          if (error instanceof AgentMemoryContentError) {
            throw new Error(
              error.code === 'MEMORY_TOO_LONG'
                ? `Memory content must be at most ${MEMORY_CONTENT_MAX_CHARS} characters; shorten it to one sentence.`
                : 'Memory content must not be empty.',
            );
          }
          throw error;
        }
      },
    },
    context,
  );
}
