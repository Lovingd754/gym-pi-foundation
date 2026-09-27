import { NextResponse } from 'next/server';
import { ApiError, handleApiError, requireApiUserId } from '@/lib/api';
import { db } from '@/lib/db';
import {
  AgentConversationNotFoundError,
  loadAgentMessages,
} from '@/lib/agent/conversations';

// GET /api/agent/conversations/[id]: the persisted turns of one thread.
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireApiUserId();
    const { id } = await context.params;

    const messages = await loadAgentMessages(userId, id);
    const conversation = await db.agentConversation.findFirst({
      where: { id, userId },
      select: { contextSummary: true },
    });
    return NextResponse.json({
      messages,
      // The transcript is complete either way; this only says whether the
      // model is reading a digest for the older part of it.
      contextCompressed: Boolean(conversation?.contextSummary),
    });
  } catch (err) {
    if (err instanceof AgentConversationNotFoundError) {
      return handleApiError(new ApiError(404, '找不到这段对话。'));
    }
    return handleApiError(err);
  }
}
