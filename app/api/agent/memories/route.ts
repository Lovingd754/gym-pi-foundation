import { NextResponse } from 'next/server';
import { handleApiError, requireApiUserId } from '@/lib/api';
import { prismaAgentMemoryStore } from '@/lib/agent/memory-store';

export interface AgentMemoryPayload {
  pending: { id: string; content: string }[];
  active: { id: string; content: string; createdAt: string }[];
}

// GET /api/agent/memories
//
// Everything the chat and the settings panel need: the proposals waiting on the
// trainee and the notes they have already accepted. Pending and active are
// separate lists because only one of them is visible to the model.
export async function GET() {
  try {
    const userId = await requireApiUserId();
    const [pending, active] = await Promise.all([
      prismaAgentMemoryStore.list(userId, 'PENDING'),
      prismaAgentMemoryStore.list(userId, 'ACTIVE'),
    ]);

    const payload: AgentMemoryPayload = {
      pending: pending.map((memory) => ({ id: memory.id, content: memory.content })),
      active: active.map((memory) => ({
        id: memory.id,
        content: memory.content,
        createdAt: memory.createdAt.toISOString(),
      })),
    };
    return NextResponse.json(payload);
  } catch (err) {
    return handleApiError(err);
  }
}
