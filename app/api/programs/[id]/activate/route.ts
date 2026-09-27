import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { handleApiError, requireApiUserId } from '@/lib/api';
import { deactivateFitnessPlanForLegacyProgram } from '@/lib/fitness/activation-state';
import { assertProgramEditable } from '@/lib/fitness/managed-program';
import { lockFitnessUser } from '@/lib/fitness/user-lock';

interface Params {
  params: Promise<{ id: string }>;
}

// POST /api/programs/[id]/activate
// Activates this program and deactivates all the others for this user.
// Optional body: { active: boolean } (default true). If active=false,
// we simply deactivate this program (no auto-activation of another one).
export async function POST(req: Request, props: Params) {
  const params = await props.params;
  try {
    const userId = await requireApiUserId();

    const body = (await req.json().catch(() => ({}))) as { active?: boolean };
    const active = body.active !== false;

    // One locked transaction: activating a hand-made Program retires the
    // personalized plan in the same commit, so the active Program and the
    // fitness pointer can never disagree.
    const updated = await db.$transaction(async (tx) => {
      await lockFitnessUser(tx, userId);
      // Ownership first (404), then the managed check - a stranger must not
      // learn that the Program is managed.
      await assertProgramEditable(userId, params.id, 'Program not found.', tx);

      if (active) {
        await deactivateFitnessPlanForLegacyProgram(tx, userId, new Date());
        await tx.program.updateMany({
          where: { userId, isActive: true, id: { not: params.id } },
          data: { isActive: false },
        });
        await tx.program.update({ where: { id: params.id, userId }, data: { isActive: true } });
      } else {
        await tx.program.update({ where: { id: params.id, userId }, data: { isActive: false } });
      }
      return tx.program.findFirst({ where: { id: params.id, userId } });
    });

    return NextResponse.json(updated);
  } catch (err) {
    return handleApiError(err);
  }
}
