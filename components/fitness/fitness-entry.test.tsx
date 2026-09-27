import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));

import { ProgramDetailView, type ProgramFull } from '@/components/programs/program-detail-view';
import type { Exercise } from '@/lib/prisma-client';

const exercise: Exercise = {
  id: 'exercise-1',
  userId: 'user-1',
  name: 'Bench Press',
  muscleGroup: 'CHEST',
  category: 'COMPOUND',
  defaultRestSec: 150,
  notes: null,
  usesBodyweight: false,
  equipmentType: 'BARBELL',
  createdAt: new Date(),
};

function program(overrides: Partial<ProgramFull> = {}): ProgramFull {
  return {
    id: 'program-1',
    userId: 'user-1',
    name: 'Personalized Plan',
    description: null,
    phase: 'personalized-recomp',
    isActive: true,
    startDate: new Date('2026-09-16T00:00:00.000Z'),
    endDate: null,
    createdAt: new Date('2026-09-16T00:00:00.000Z'),
    updatedAt: new Date('2026-09-16T00:00:00.000Z'),
    workouts: [
      {
        id: 'workout-1',
        programId: 'program-1',
        name: 'Full Body A',
        dayOfWeek: 1,
        order: 1,
        exercises: [
          {
            id: 'pe-1',
            workoutId: 'workout-1',
            exerciseId: 'exercise-1',
            order: 1,
            targetSets: 3,
            targetRepsMin: 6,
            targetRepsMax: 10,
            targetRIR: 2,
            restSec: 150,
            tempo: null,
            notes: 'catalog:bench_press',
            supersetGroup: null,
            autoregulationMode: 'PRESERVE_RIR',
            fatigueRate: null,
            loadAdjustmentPct: null,
            initialLoadKg: 60,
            initialLoadSource: 'APP_HISTORY',
            progressionRuleVersion: 'double-progression-v2',
            introTargetRIR: 3,
            introEndsAt: new Date('2026-09-30T00:00:00.000Z'),
            exercise,
          },
        ],
      },
    ],
    ...overrides,
  } as ProgramFull;
}

describe('Program detail for a managed plan', () => {
  it('shows the versioned-plan badge and hides every structure command', () => {
    render(
      <ProgramDetailView
        program={program({ fitnessPlanVersion: { id: 'plan-1', version: 2 } })}
        catalog={[exercise]}
      />,
    );

    expect(screen.getByText('Personalized plan v2')).toBeInTheDocument();
    // Structure mutations are gone...
    expect(screen.queryByRole('button', { name: /^Edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Deactivate|Activate/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add a session/i })).not.toBeInTheDocument();
    // ...while read-only affordances remain.
    expect(screen.getByRole('link', { name: /Print|打印/i })).toBeInTheDocument();
    expect(screen.getByText('Bench Press')).toBeInTheDocument();
  });

  it('keeps every command for a legacy program', () => {
    render(
      <ProgramDetailView program={program({ fitnessPlanVersion: null })} catalog={[exercise]} />,
    );

    expect(screen.getByRole('button', { name: /Deactivate|Activate/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Edit$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add a session/i })).toBeInTheDocument();
    expect(screen.queryByText(/Personalized plan v/)).not.toBeInTheDocument();
  });
});
