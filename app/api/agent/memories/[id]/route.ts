import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiError, handleApiError, parseJsonBody, requireApiUserId } from '@/lib/api';
import { prismaAgentMemoryStore } from '@/lib/agent/memory-store';

const bodySchema = z.object({ action: z.enum(['confirm', 'dismiss']) });

interface Params {
  params: Promise<{ id: string }>;
}

// POST /api/agent/memories/[id]: the trainee's decision on a proposal.
//
// This is the only path that can turn a proposal into a memory. The agent runs
// outside this endpoint and has no way to call it, so a model cannot confirm
// its own suggestion.
export async function POST(req: Request, props: Params) {
  try {
    const userId = await requireApiUserId();
    const { id } = await props.params;
    const { action } = await parseJsonBody(req, bodySchema);

    const changed =
      action === 'confirm'
        ? await prismaAgentMemoryStore.confirm(userId, id)
        : await prismaAgentMemoryStore.dismiss(userId, id);

    if (!changed) throw new ApiError(404, '这条内容已经处理过了。');
    return NextResponse.json({ ok: true, status: action === 'confirm' ? 'ACTIVE' : 'DISMISSED' });
  } catch (err) {
    return handleApiError(err);
  }
}

// DELETE /api/agent/memories/[id]: drop a note the trainee no longer wants.
export async function DELETE(_req: Request, props: Params) {
  try {
    const userId = await requireApiUserId();
    const { id } = await props.params;

    const removed = await prismaAgentMemoryStore.remove(userId, id);
    if (!removed) throw new ApiError(404, '找不到这条内容。');
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
