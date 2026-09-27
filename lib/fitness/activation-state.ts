import type { Prisma } from '@/prisma/generated/client';

export type FitnessActivationState = {
  revision: number;
  planVersionId: string | null;
};

// The activation row may legitimately exist with a null plan pointer (created
// by an older revision of the flow), so a missing row and a null pointer both
// resolve to "no active plan, revision zero".
export async function getActivationState(
  client: Prisma.TransactionClient,
  userId: string,
): Promise<FitnessActivationState> {
  const row = await client.fitnessPlanActivation.findUnique({
    where: { userId },
    select: { revision: true, planVersionId: true },
  });
  return { revision: row?.revision ?? 0, planVersionId: row?.planVersionId ?? null };
}

// Switching back to a hand-made (legacy) Program retires personalized planning:
// the plan the pointer referenced becomes SUPERSEDED, the pointer is cleared and
// the revision advances so any in-flight confirmation built against the old
// revision is rejected instead of silently activating a stale plan.
export async function deactivateFitnessPlanForLegacyProgram(
  tx: Prisma.TransactionClient,
  userId: string,
  now: Date,
): Promise<void> {
  // A user who never had fitness state keeps the pre-existing behavior exactly:
  // no activation row is invented for them.
  const row = await tx.fitnessPlanActivation.findUnique({
    where: { userId },
    select: { revision: true, planVersionId: true },
  });
  if (!row) return;

  if (row.planVersionId) {
    await tx.fitnessPlanVersion.updateMany({
      where: { id: row.planVersionId, userId, status: 'ACTIVE' },
      data: { status: 'SUPERSEDED' },
    });
  }
  await tx.fitnessPlanActivation.update({
    where: { userId },
    data: { planVersionId: null, revision: row.revision + 1, activatedAt: now },
  });
}
