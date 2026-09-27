import { NextResponse } from 'next/server';
import { handleApiError, requireApiUserId } from '@/lib/api';
import { getFitnessPlan } from '@/lib/fitness/plan-store';

interface Props {
  params: Promise<{ id: string }>;
}

// Ownership-scoped read: another user's plan id resolves to 404, never 403, so
// the route never confirms that someone else's plan exists.
export async function GET(_req: Request, props: Props) {
  try {
    const userId = await requireApiUserId();
    const { id } = await props.params;
    const result = await getFitnessPlan(userId, id);
    if (!result) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
    return NextResponse.json(result);
  } catch (error) {
    return handleApiError(error);
  }
}
