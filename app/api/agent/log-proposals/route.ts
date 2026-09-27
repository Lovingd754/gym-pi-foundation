import { NextResponse } from 'next/server';
import { handleApiError, requireApiUserId } from '@/lib/api';
import { prismaLogProposalStore } from '@/lib/agent/log-proposals';

export interface LogProposalPayload {
  pending: { id: string; summary: { label: string; value: string }[] }[];
}

// GET /api/agent/log-proposals: the sets the trainee described but has not
// confirmed.
export async function GET() {
  try {
    const userId = await requireApiUserId();
    const pending = await prismaLogProposalStore.list(userId, 'PENDING');

    const payload: LogProposalPayload = {
      pending: pending.map((proposal) => ({ id: proposal.id, summary: proposal.summary })),
    };
    return NextResponse.json(payload);
  } catch (err) {
    return handleApiError(err);
  }
}
