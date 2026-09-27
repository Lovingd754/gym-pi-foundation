import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getLocale } from 'next-intl/server';
import { z } from 'zod';
import { ApiError, handleApiError, parseJsonBody, requireApiUserId } from '@/lib/api';
import { rateLimit } from '@/lib/rate-limit';
import { createPiFitnessAgentRuntime } from '@/lib/agent/pi-runtime';
import {
  AgentConversationNotFoundError,
  appendAgentMessage,
  resolveAgentConversation,
} from '@/lib/agent/conversations';
import type { FitnessAgentStreamEvent } from '@/lib/agent/contracts';
import { prismaAgentMemoryStore } from '@/lib/agent/memory-store';
import { compactConversation } from '@/lib/agent/compaction';
import { prismaPlanProposalStore } from '@/lib/agent/plan-proposals';
import { prismaLogProposalStore } from '@/lib/agent/log-proposals';

const bodySchema = z.object({
  conversationId: z.string().cuid().optional(),
  message: z.string().trim().min(1).max(4000),
  sessionId: z.string().cuid().optional(),
});

const ENCODER = new TextEncoder();

// Server-sent events. Every frame is a JSON payload on a single `data:` line,
// so the client can render text deltas, tool cards and the terminal reason
// from one ordered stream.
function frame(payload: Record<string, unknown>): Uint8Array {
  return ENCODER.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

// POST /api/agent/chat
//
// Streams one agent run. The user message is persisted before the loop starts
// and the assistant message after it ends, so a dropped connection leaves an
// auditable transcript rather than a half-written turn.
export async function POST(req: Request) {
  try {
    const userId = await requireApiUserId();

    const rl = rateLimit(`agent-chat:${userId}`, 60, 60_000);
    if (!rl.ok) {
      return NextResponse.json(
        { error: '消息太频繁了，稍等一会儿再发。' },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
      );
    }

    const { conversationId: requestedId, message, sessionId } = await parseJsonBody(
      req,
      bodySchema,
    );

    let conversationId: string;
    try {
      conversationId = await resolveAgentConversation(userId, requestedId, message);
    } catch (error) {
      if (error instanceof AgentConversationNotFoundError) {
        throw new ApiError(404, '找不到这段对话。');
      }
      throw error;
    }

    const currentMessageId = await appendAgentMessage(conversationId, 'USER', message);

    const runId = randomUUID();
    const abort = new AbortController();
    req.signal.addEventListener('abort', () => abort.abort(), { once: true });
    const locale = await getLocale();

    const runtime = createPiFitnessAgentRuntime();
    let assistantText = '';
    let failure: string | undefined;

    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (event: FitnessAgentStreamEvent) => {
          if (event.type === 'text-delta') assistantText += event.delta;
          controller.enqueue(frame(event as unknown as Record<string, unknown>));
        };

        // The assistant turn is written before anything else looks at the
        // thread, so compaction always folds whole exchanges. Guarded because
        // both the success path and the error path must persist exactly once.
        let persisted = false;
        const persistAssistant = async () => {
          if (persisted) return;
          persisted = true;
          if (assistantText.trim()) {
            await appendAgentMessage(conversationId, 'ASSISTANT', assistantText).catch(() => {});
          }
        };

        try {
          const result = await runtime.run(
            {
              runId,
              kind: 'chat',
              userId,
              conversationId,
              currentMessageId,
              sessionId,
              locale,
              message,
              signal: abort.signal,
            },
            emit,
          );

          if (result.stopReason === 'error') {
            failure = '这次回答没有走完，请再试一次。';
          }

          await persistAssistant();
          controller.enqueue(
            frame({
              type: 'turn-end',
              conversationId,
              runId,
              stopReason: result.stopReason,
              modelTurns: result.modelTurns,
              toolCalls: result.toolCalls,
              // Proposals raised during this turn come back with the turn so
              // the client can render the accept/decline cards without a
              // second round trip.
              pendingMemories: (await prismaAgentMemoryStore.list(userId, 'PENDING')).map(
                (memory) => ({ id: memory.id, content: memory.content }),
              ),
              pendingPlanChanges: (
                await prismaPlanProposalStore.list(userId, 'PENDING')
              ).map((proposal) => ({
                id: proposal.id,
                kind: proposal.kind,
                diff: proposal.diff,
              })),
              pendingLogs: (await prismaLogProposalStore.list(userId, 'PENDING')).map(
                (proposal) => ({ id: proposal.id, summary: proposal.summary }),
              ),
            }),
          );

          // Compaction runs after the turn is handed back, so a long thread
          // never makes the trainee wait for its own summary. The client is
          // told separately, which is also when it shows the notice.
          try {
            const compaction = await compactConversation(userId, conversationId);
            if (compaction.compacted) {
              controller.enqueue(frame({ type: 'context-compacted' }));
            }
          } catch {
            // A failed compaction only costs context budget; the conversation
            // itself is intact and the next turn tries again.
          }
        } catch (error) {
          failure = error instanceof Error ? error.message : '对话运行失败。';
          controller.enqueue(frame({ type: 'error', message: failure }));
        } finally {
          await persistAssistant();
          controller.close();
        }
      },
      cancel() {
        abort.abort();
      },
    });

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        Connection: 'keep-alive',
        'X-Conversation-Id': conversationId,
        'X-Run-Id': runId,
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
