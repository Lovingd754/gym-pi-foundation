import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/prisma/generated/client';
import type { GeneratedProgram } from '@/lib/schemas/program-generation';

import { materializeProgram, type MaterializeFitnessOptions } from './program-generation';

type Json = Record<string, unknown>;

function fakeTx() {
  const calls = {
    programs: [] as Json[],
    workouts: [] as Json[],
    exerciseUpserts: [] as Array<{ create: Json; update: unknown }>,
    programExercises: [] as Json[],
    nestedTransactions: 0,
  };
  const tx = {
    program: {
      create: vi.fn(async ({ data }: { data: Json }) => {
        calls.programs.push(data);
        return { id: 'program-1', ...data };
      }),
    },
    workout: {
      create: vi.fn(async ({ data }: { data: Json }) => {
        calls.workouts.push(data);
        return { id: `workout-${calls.workouts.length}`, ...data };
      }),
    },
    exercise: {
      upsert: vi.fn(async ({ create, update }: { create: Json; update: unknown }) => {
        calls.exerciseUpserts.push({ create, update });
        return { id: `exercise-${calls.exerciseUpserts.length}`, ...create };
      }),
    },
    programExercise: {
      create: vi.fn(async ({ data }: { data: Json }) => {
        calls.programExercises.push(data);
        return { id: `pe-${calls.programExercises.length}`, ...data };
      }),
    },
    $transaction: () => {
      calls.nestedTransactions += 1;
      throw new Error('materializeProgram must not open its own transaction');
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, calls };
}

function exercise(overrides: Json = {}) {
  return {
    name: 'Bench Press',
    muscleGroup: 'CHEST',
    category: 'COMPOUND',
    equipmentType: 'BARBELL',
    targetSets: 4,
    targetRepsMin: 6,
    targetRepsMax: 10,
    targetRIR: 2,
    restSec: 150,
    ...overrides,
  };
}

function generatedProgram(): GeneratedProgram {
  return {
    name: 'Personalized Plan',
    description: null,
    phase: 'personalized-recomp',
    workouts: [
      {
        name: 'Full Body A',
        dayOfWeek: 1,
        exercises: [exercise({ notes: 'catalog:bench_press' })],
      },
      {
        name: 'Full Body B',
        dayOfWeek: 3,
        exercises: [exercise({ name: 'Back Squat', notes: 'catalog:back_squat' })],
      },
    ],
  } as GeneratedProgram;
}

const fitnessOptions: MaterializeFitnessOptions = {
  loadGuidance: [
    { catalogKey: 'bench_press', source: 'APP_HISTORY', initialLoadKg: 82.5 },
    { catalogKey: 'back_squat', source: 'CALIBRATION', initialLoadKg: null },
  ],
  introRir: 3,
  introDurationDays: 14,
  activatedAt: new Date('2026-09-18T06:00:00.000Z'),
};

describe('materializeProgram without fitness options', () => {
  it('preserves the legacy path', async () => {
    const { tx, calls } = fakeTx();

    const programId = await materializeProgram(tx, 'user-1', generatedProgram());

    expect(programId).toBe('program-1');
    expect(calls.nestedTransactions).toBe(0);
    expect(calls.programs[0]).toMatchObject({ userId: 'user-1', isActive: false });
    expect(calls.workouts.map((workout) => workout.order)).toEqual([1, 2]);
    expect(calls.workouts.map((workout) => workout.dayOfWeek)).toEqual([1, 3]);
    expect(calls.exerciseUpserts[0]!.update).toEqual({});
    expect(calls.programExercises[0]).toMatchObject({
      targetRIR: 2,
      initialLoadKg: null,
      initialLoadSource: null,
      progressionRuleVersion: null,
      introTargetRIR: null,
      introEndsAt: null,
    });
  });
});

describe('materializeProgram with fitness options', () => {
  it('maps catalog notes to managed load and progression metadata', async () => {
    const { tx, calls } = fakeTx();

    await materializeProgram(tx, 'user-1', generatedProgram(), { fitness: fitnessOptions });

    expect(calls.nestedTransactions).toBe(0);
    expect(calls.programExercises[0]).toMatchObject({
      targetRIR: 2,
      initialLoadKg: 82.5,
      initialLoadSource: 'APP_HISTORY',
      progressionRuleVersion: 'double-progression-v2',
      introTargetRIR: 3,
    });
    expect((calls.programExercises[0]!.introEndsAt as Date).toISOString()).toBe(
      '2026-10-02T06:00:00.000Z',
    );
    expect(calls.programExercises[1]).toMatchObject({
      initialLoadKg: null,
      initialLoadSource: 'CALIBRATION',
      introTargetRIR: 3,
    });
  });

  it('leaves the intro fields null for a non-novice plan', async () => {
    const { tx, calls } = fakeTx();

    await materializeProgram(tx, 'user-1', generatedProgram(), {
      fitness: { ...fitnessOptions, introRir: null, introDurationDays: 0 },
    });

    expect(calls.programExercises[0]).toMatchObject({
      targetRIR: 2,
      introTargetRIR: null,
      introEndsAt: null,
      progressionRuleVersion: 'double-progression-v2',
    });
  });

  it('writes usesBodyweight on create but never overwrites an existing exercise', async () => {
    const { tx, calls } = fakeTx();

    await materializeProgram(tx, 'user-1', generatedProgram(), { fitness: fitnessOptions });

    expect(calls.exerciseUpserts[0]!.create.usesBodyweight).toBe(false);
    expect(calls.exerciseUpserts[0]!.update).toEqual({});
  });

  it('rejects an unknown, duplicate, or unmapped catalog key before writing', async () => {
    const scenarios: Array<[string, GeneratedProgram, MaterializeFitnessOptions]> = [
      [
        'unknown key',
        {
          ...generatedProgram(),
          workouts: [
            {
              name: 'Full Body A',
              dayOfWeek: 1,
              exercises: [exercise({ notes: 'catalog:not_a_real_key' })],
            },
          ],
        } as GeneratedProgram,
        fitnessOptions,
      ],
      [
        'duplicate key in one workout',
        {
          ...generatedProgram(),
          workouts: [
            {
              name: 'Full Body A',
              dayOfWeek: 1,
              exercises: [
                exercise({ notes: 'catalog:bench_press' }),
                exercise({ name: 'Bench Press B', notes: 'catalog:bench_press' }),
              ],
            },
          ],
        } as GeneratedProgram,
        fitnessOptions,
      ],
      [
        'missing load guidance',
        generatedProgram(),
        { ...fitnessOptions, loadGuidance: [fitnessOptions.loadGuidance[0]!] },
      ],
    ];

    for (const [label, program, options] of scenarios) {
      const { tx, calls } = fakeTx();
      await expect(
        materializeProgram(tx, 'user-1', program, { fitness: options }),
        label,
      ).rejects.toThrow();
      expect(calls.programs, label).toHaveLength(0);
      expect(calls.programExercises, label).toHaveLength(0);
    }
  });
});
