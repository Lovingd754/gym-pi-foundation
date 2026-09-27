import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { handleApiError, parseJsonBody, requireApiUserId } from '@/lib/api';
import { generatedProgramSchema } from '@/lib/schemas/program-generation';
import { materializeProgram } from '@/lib/program-generation';
import { deactivateFitnessPlanForLegacyProgram } from '@/lib/fitness/activation-state';
import { lockFitnessUser } from '@/lib/fitness/user-lock';

// Instantiating a template goes through the same persistence helper as the
// AI generator so exercise upserts never overwrite user-authored metadata.
// Unlike the generator flow, a picked template becomes the active program.
export async function POST(req: Request) {
  try {
    const userId = await requireApiUserId();
    const data = await parseJsonBody(req, generatedProgramSchema);

    // Template activation also retires personalized planning, atomically: a
    // hand-made Program becomes the active one in the same commit that clears
    // the fitness pointer.
    const programId = await db.$transaction(async (tx) => {
      await lockFitnessUser(tx, userId);
      const created = await materializeProgram(tx, userId, data);
      await deactivateFitnessPlanForLegacyProgram(tx, userId, new Date());
      await tx.program.updateMany({
        where: { userId, isActive: true, id: { not: created } },
        data: { isActive: false },
      });
      await tx.program.update({ where: { id: created }, data: { isActive: true } });
      return created;
    });

    return NextResponse.json({ id: programId }, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
