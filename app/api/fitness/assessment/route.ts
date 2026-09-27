import { NextResponse } from 'next/server';
import { handleApiError, parseJsonBody, requireApiUserId } from '@/lib/api';
import { getCurrentAssessment, saveAssessment } from '@/lib/fitness/assessment-store';
import { createAssessmentInputSchema } from '@/lib/fitness/schemas';

export async function GET() {
  try {
    const userId = await requireApiUserId();
    return NextResponse.json(await getCurrentAssessment(userId));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(req: Request) {
  try {
    const userId = await requireApiUserId();
    const now = new Date();
    const input = await parseJsonBody(req, createAssessmentInputSchema(now), {
      maxBytes: 32_768,
    });
    return NextResponse.json(await saveAssessment(userId, input, now));
  } catch (error) {
    return handleApiError(error);
  }
}
