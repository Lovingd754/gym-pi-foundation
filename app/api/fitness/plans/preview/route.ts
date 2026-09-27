import { NextResponse } from 'next/server';
import { handleApiError, parseJsonBody, requireApiUserId } from '@/lib/api';
import { planPreviewRequestSchema } from '@/lib/fitness/schemas';
import { createOrReuseDraft } from '@/lib/fitness/plan-store';
import { getFitnessPlan } from '@/lib/fitness/plan-store';
import { applyPlanStrategy } from '@/lib/fitness/plan-strategy-apply';

// Preview is idempotent: an unchanged calculation input reuses the existing
// draft (200), and only a real change allocates the next version (201).
//
// The draft is built by the rules first. The model's strategy is applied on top
// of it, once, and only to a draft that has never been shaped - so a second
// preview of the same answers neither re-asks a model nor changes the plan the
// trainee is looking at.
export async function POST(req: Request) {
  try {
    const userId = await requireApiUserId();
    await parseJsonBody(req, planPreviewRequestSchema, { maxBytes: 1024 });
    const { plan, created, activationRevision } = await createOrReuseDraft(userId);

    // Only a draft this request created gets shaped. A reused draft is the same
    // plan the trainee already saw: re-asking a model could quietly change it,
    // and re-shaping a neutral one would mean paying for every preview.
    let shaped = plan;
    if (created && plan.strategy === null && plan.status === 'DRAFT') {
      const applied = await applyPlanStrategy(userId, plan.id);
      if (applied.reshaped) {
        const refreshed = await getFitnessPlan(userId, plan.id);
        if (refreshed) shaped = refreshed.plan;
      }
    }

    return NextResponse.json({ plan: shaped, activationRevision }, { status: created ? 201 : 200 });
  } catch (error) {
    return handleApiError(error);
  }
}
