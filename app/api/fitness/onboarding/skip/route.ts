import { db } from '@/lib/db';
import { handleApiError, parseJsonBody, requireApiUserId } from '@/lib/api';
import { planPreviewRequestSchema } from '@/lib/fitness/schemas';
import { lockFitnessUser } from '@/lib/fitness/user-lock';

export async function POST(req: Request) {
  try {
    const userId = await requireApiUserId();
    await parseJsonBody(req, planPreviewRequestSchema, { maxBytes: 1_024 });
    await db.$transaction(async (tx) => {
      await lockFitnessUser(tx, userId);
      await tx.user.update({
        where: { id: userId },
        data: { fitnessOnboardingRequired: false },
      });
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    return handleApiError(error);
  }
}
