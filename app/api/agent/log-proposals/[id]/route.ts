import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiError, handleApiError, parseJsonBody, requireApiUserId } from '@/lib/api';
import { applyLogProposal, prismaLogProposalStore } from '@/lib/agent/log-proposals';

const bodySchema = z.object({ action: z.enum(['log', 'dismiss']) });

interface Params {
  params: Promise<{ id: string }>;
}

// POST /api/agent/log-proposals/[id]: the trainee's decision.
//
// This is the only path that writes a chat-described set into their history.
// The agent runs outside this endpoint and cannot reach it, and the write goes
// through the same set schema the manual form uses.
export async function POST(req: Request, props: Params) {
  try {
    const userId = await requireApiUserId();
    const { id } = await props.params;
    const { action } = await parseJsonBody(req, bodySchema);

    if (action === 'dismiss') {
      const dismissed = await prismaLogProposalStore.dismiss(userId, id);
      if (!dismissed) throw new ApiError(404, '这条记录已经处理过了。');
      return NextResponse.json({ ok: true, status: 'DISMISSED' });
    }

    const result = await applyLogProposal(userId, id);
    return NextResponse.json({ ok: true, status: 'APPLIED', ...result });
  } catch (err) {
    return handleApiError(err);
  }
}
