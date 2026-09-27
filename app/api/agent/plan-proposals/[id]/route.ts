import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiError, handleApiError, parseJsonBody, requireApiUserId } from '@/lib/api';
import {
  PlanProposalStaleError,
  applyPlanProposal,
  prismaPlanProposalStore,
} from '@/lib/agent/plan-proposals';
import { PlanChangeError } from '@/lib/fitness/plan-change';

const bodySchema = z.object({ action: z.enum(['apply', 'dismiss']) });

interface Params {
  params: Promise<{ id: string }>;
}

// POST /api/agent/plan-proposals/[id]: the trainee's decision.
//
// This is the only path that turns a proposal into a plan. The agent runs
// outside this endpoint and cannot reach it, so a model can never apply its own
// suggestion - and applying goes through the same activation path as a
// generated plan, never a direct write.
export async function POST(req: Request, props: Params) {
  try {
    const userId = await requireApiUserId();
    const { id } = await props.params;
    const { action } = await parseJsonBody(req, bodySchema);

    if (action === 'dismiss') {
      const dismissed = await prismaPlanProposalStore.dismiss(userId, id);
      if (!dismissed) throw new ApiError(404, '这条改动已经处理过了。');
      return NextResponse.json({ ok: true, status: 'DISMISSED' });
    }

    const result = await applyPlanProposal(userId, id);
    return NextResponse.json({ ok: true, status: 'APPLIED', ...result });
  } catch (err) {
    if (err instanceof PlanProposalStaleError) {
      return handleApiError(new ApiError(409, 'PLAN_PROPOSAL_STALE'));
    }
    if (err instanceof PlanChangeError) {
      // The plan moved under the proposal; the trainee should ask again rather
      // than get a half-applied change.
      return handleApiError(new ApiError(409, 'PLAN_CHANGE_REFUSED', { code: err.code }));
    }
    return handleApiError(err);
  }
}
