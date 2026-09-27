import { describe, expect, it } from 'vitest';
import { groupSessionsByDay, summarizeSessionExercises } from './history-summary';

const strength = (
  exerciseName: string,
  overrides: Partial<Parameters<typeof summarizeSessionExercises>[0][number]> = {},
) => ({
  weight: 60,
  reps: 8,
  isWarmup: false,
  durationSec: null,
  distanceM: null,
  usesBodyweight: false,
  exerciseName,
  exerciseCategory: 'COMPOUND',
  ...overrides,
});

describe('summarizeSessionExercises', () => {
  it('collapses a movement to one line: heaviest set plus its set count', () => {
    const lines = summarizeSessionExercises([
      strength('Bench Press', { weight: 60, reps: 8 }),
      strength('Bench Press', { weight: 70, reps: 5 }),
      strength('Bench Press', { weight: 70, reps: 5 }),
    ]);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      name: 'Bench Press',
      topWeightKg: 70,
      reps: 5,
      workingSets: 3,
      isCardio: false,
    });
  });

  it('keeps the order the movements were logged in', () => {
    const lines = summarizeSessionExercises([strength('Squat'), strength('Bench Press')]);
    expect(lines.map((line) => line.name)).toEqual(['Squat', 'Bench Press']);
  });

  it('does not let warmups inflate the set count or the reported weight', () => {
    const lines = summarizeSessionExercises([
      strength('Squat', { weight: 100, reps: 5, isWarmup: true }),
      strength('Squat', { weight: 80, reps: 5 }),
    ]);

    expect(lines[0]).toMatchObject({ topWeightKg: 80, reps: 5, workingSets: 1 });
  });

  it('still counts a movement that only has warmup sets', () => {
    const lines = summarizeSessionExercises([
      strength('Squat', { weight: 40, reps: 10, isWarmup: true }),
    ]);
    expect(lines[0]).toMatchObject({ topWeightKg: 40, workingSets: 1 });
  });

  it('sums distance and duration for cardio instead of reporting a weight', () => {
    const lines = summarizeSessionExercises([
      {
        ...strength('Running', { weight: 0, reps: 1 }),
        exerciseCategory: 'CARDIO',
        durationSec: 750,
        distanceM: 2500,
      },
      {
        ...strength('Running', { weight: 0, reps: 1 }),
        exerciseCategory: 'CARDIO',
        durationSec: 750,
        distanceM: 1000,
      },
    ]);

    expect(lines[0]).toMatchObject({
      isCardio: true,
      topWeightKg: null,
      reps: null,
      durationSec: 1500,
      distanceM: 3500,
      workingSets: 2,
    });
  });

  it('marks a zero load on a bodyweight movement as bodyweight', () => {
    const lines = summarizeSessionExercises([
      strength('Pull-up', { weight: 0, reps: 6, usesBodyweight: true }),
    ]);
    expect(lines[0]).toMatchObject({ topWeightKg: 0, usesBodyweight: true });
  });
});

describe('groupSessionsByDay', () => {
  it('groups sessions by UTC day, keeping the newest first', () => {
    const days = groupSessionsByDay([
      { id: 'b', startedAt: new Date('2026-09-19T18:00:00Z') },
      { id: 'a', startedAt: new Date('2026-09-19T07:00:00Z') },
      { id: 'c', startedAt: new Date('2026-09-17T09:00:00Z') },
    ]);

    expect(days.map((day) => day.key)).toEqual(['2026-09-19', '2026-09-17']);
    expect(days[0]!.sessions.map((session) => session.id)).toEqual(['b', 'a']);
  });
});
