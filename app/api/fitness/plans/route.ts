import { NextResponse } from 'next/server';
import { handleApiError, requireApiUserId } from '@/lib/api';
import { listFitnessPlans } from '@/lib/fitness/plan-store';

export async function GET() {
  try {
    const userId = await requireApiUserId();
    return NextResponse.json({ plans: await listFitnessPlans(userId) });
  } catch (error) {
    return handleApiError(error);
  }
}
