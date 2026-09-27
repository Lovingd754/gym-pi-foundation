import { NextResponse } from 'next/server';
import { handleApiError, requireApiUserId } from '@/lib/api';
import { prismaPlanProposalStore } from '@/lib/agent/plan-proposals';

export interface PlanProposalPayload {
  pending: { id: string; kind: string; diff: { label: string; before: string; after: string }[] }[];
}

// GET /api/agent/plan-proposals: the changes waiting on the trainee.
export async function GET() {
  try {
    const userId = await requireApiUserId();
    const pending = await prismaPlanProposalStore.list(userId, 'PENDING');

    const payload: PlanProposalPayload = {
      pending: pending.map((proposal) => ({
        id: proposal.id,
        kind: proposal.kind,
        diff: proposal.diff,
      })),
    };
    return NextResponse.json(payload);
  } catch (err) {
    return handleApiError(err);
  }
}
