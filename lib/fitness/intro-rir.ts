import type { ProgramExercise } from '@/lib/prisma-client';

export function resolveProgramExerciseRir<T extends ProgramExercise>(
  programExercise: T,
  sessionStartedAt: Date,
): T {
  if (Number.isNaN(sessionStartedAt.getTime())) {
    throw new RangeError('sessionStartedAt must be a valid date');
  }

  const useIntroRir =
    programExercise.progressionRuleVersion === 'double-progression-v2' &&
    programExercise.introTargetRIR !== null &&
    programExercise.introEndsAt !== null &&
    sessionStartedAt.getTime() < programExercise.introEndsAt.getTime();

  return {
    ...programExercise,
    targetRIR: useIntroRir ? programExercise.introTargetRIR! : programExercise.targetRIR,
  };
}
