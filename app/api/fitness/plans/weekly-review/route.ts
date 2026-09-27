import { NextResponse } from 'next/server';
import { handleApiError, parseJsonBody, requireApiUserId } from '@/lib/api';
import { getWeeklyReviewState, runWeeklyReview } from '@/lib/fitness/weekly-review-store';
import { z } from 'zod';

// The weekly review of the plan in use.
//
// GET  - is a review due, and what did last week look like?
// POST - run it. `activate: false` (or absent) leaves the result as a draft for
//        the trainee to confirm on the preview screen; `activate: true` is the
//        explicit confirmed path, which applies it and returns the new program.
//        Automatic browser reviews always leave a draft for confirmation.

const requestSchema = z
  .object({
    activate: z.boolean().optional(),
    force: z.boolean().optional(),
  })
  .strict();

export async function GET() {
  try {
    const userId = await requireApiUserId();
    return NextResponse.json(await getWeeklyReviewState(userId));
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request) {
  try {
    const userId = await requireApiUserId();
    const body = await parseJsonBody(req, requestSchema);
    const outcome = await runWeeklyReview({
      userId,
      activate: body.activate ?? false,
      force: body.force ?? false,
    });
    return NextResponse.json(outcome);
  } catch (err) {
    return handleApiError(err);
  }
}
