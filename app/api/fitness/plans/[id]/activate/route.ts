import { NextResponse } from 'next/server';
import { handleApiError, parseJsonBody, requireApiUserId } from '@/lib/api';
import { activateFitnessPlan } from '@/lib/fitness/activate-plan';
import { planActivationRequestSchema } from '@/lib/fitness/schemas';

interface Props {
  params: Promise<{ id: string }>;
}

export async function POST(req: Request, props: Props) {
  try {
    const userId = await requireApiUserId();
    const { id } = await props.params;
    const { expectedRevision } = await parseJsonBody(req, planActivationRequestSchema, {
      maxBytes: 1024,
    });
    return NextResponse.json(await activateFitnessPlan({ userId, planId: id, expectedRevision }));
  } catch (error) {
    return handleApiError(error);
  }
}
