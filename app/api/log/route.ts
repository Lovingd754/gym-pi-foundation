import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { ApiError, handleApiError, parseJsonBody, requireApiUserId } from '@/lib/api';
import { rateLimit } from '@/lib/rate-limit';
import { writeSets } from '@/lib/quick-log';
import { fromDisplayWeight } from '@/lib/units';

// The quick-log form: a few taps, no workout in progress, no model involved.
// Weight arrives in the trainee's own unit (that is what the field shows) and is
// converted here, once, before the shared write path validates it.
const bodySchema = z.object({
  exerciseId: z.string().min(1),
  weight: z.number().min(0).max(2000),
  reps: z.number().int().min(1).max(100),
  sets: z.number().int().min(1).max(20),
  rir: z.number().int().min(0).max(5).optional(),
});

export async function POST(req: Request) {
  try {
    const userId = await requireApiUserId();
    const rl = rateLimit(`quick-log:${userId}`, 60, 60_000);
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'Too many entries. Please wait a moment.' },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
      );
    }

    const body = await parseJsonBody(req, bodySchema, { maxBytes: 2048 });
    const user = await db.user.findUnique({ where: { id: userId }, select: { unit: true } });

    const result = await writeSets(userId, {
      exerciseId: body.exerciseId,
      weight: fromDisplayWeight(body.weight, user?.unit ?? 'KG'),
      reps: body.reps,
      sets: body.sets,
      rir: body.rir ?? null,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof Error && err.message === 'EXERCISE_NOT_FOUND') {
      return handleApiError(new ApiError(404, 'Exercise not found.'));
    }
    return handleApiError(err);
  }
}
