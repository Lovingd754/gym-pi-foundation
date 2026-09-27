import { describe, expect, it } from 'vitest';
import type { ProgramExercise } from '@/lib/prisma-client';

import { resolveProgramExerciseRir } from './intro-rir';

const exercise = {
  id: 'pe-1',
  workoutId: 'workout-1',
  exerciseId: 'exercise-1',
  order: 0,
  targetSets: 3,
  targetRepsMin: 6,
  targetRepsMax: 10,
  targetRIR: 2,
  restSec: 150,
  tempo: null,
  notes: null,
  supersetGroup: null,
  autoregulationMode: 'PRESERVE_RIR',
  fatigueRate: null,
  loadAdjustmentPct: null,
  initialLoadKg: null,
  initialLoadSource: null,
  progressionRuleVersion: 'double-progression-v2',
  introTargetRIR: 3,
  introEndsAt: new Date('2026-02-15T00:00:00.000Z'),
} satisfies ProgramExercise;

describe('resolveProgramExerciseRir', () => {
  it('uses the intro target before the boundary without mutating the input', () => {
    const result = resolveProgramExerciseRir(exercise, new Date('2026-02-14T23:59:59.999Z'));

    expect(result).not.toBe(exercise);
    expect(result.targetRIR).toBe(3);
    expect(exercise.targetRIR).toBe(2);
  });

  it.each(['2026-02-15T00:00:00.000Z', '2026-02-16T00:00:00.000Z'])(
    'uses steady RIR at or after the boundary: %s',
    (startedAt) => {
      expect(resolveProgramExerciseRir(exercise, new Date(startedAt)).targetRIR).toBe(2);
    },
  );

  it('leaves legacy null intro fields unchanged', () => {
    const legacy = {
      ...exercise,
      progressionRuleVersion: null,
      introTargetRIR: null,
      introEndsAt: null,
    };
    expect(resolveProgramExerciseRir(legacy, new Date('2026-01-01T00:00:00.000Z'))).toEqual(legacy);
  });

  it('rejects an invalid session timestamp', () => {
    expect(() => resolveProgramExerciseRir(exercise, new Date(Number.NaN))).toThrow(RangeError);
  });
});
