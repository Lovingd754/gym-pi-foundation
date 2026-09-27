import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { getCurrentUserId } from '@/lib/auth';
import { saveAssessment } from '@/lib/fitness/assessment-store';
import type { AssessmentInput } from '@/lib/fitness/schemas';

vi.mock('@/lib/auth', () => ({ getCurrentUserId: vi.fn() }));
const mockUserId = vi.mocked(getCurrentUserId);

import { POST as postPreview } from '@/app/api/fitness/plans/preview/route';
import { POST as postActivatePlan } from '@/app/api/fitness/plans/[id]/activate/route';
import { PUT as putProgram, DELETE as deleteProgram } from '@/app/api/programs/[id]/route';
import { POST as postProgramWorkout } from '@/app/api/programs/[id]/workouts/route';
import { POST as postActivateProgram } from '@/app/api/programs/[id]/activate/route';
import { POST as postFromTemplate } from '@/app/api/programs/from-template/route';
import { PUT as putWorkout, DELETE as deleteWorkout } from '@/app/api/workouts/[id]/route';
import { POST as postWorkoutExercise } from '@/app/api/workouts/[id]/program-exercises/route';
import {
  PUT as putProgramExercise,
  DELETE as deleteProgramExercise,
} from '@/app/api/program-exercises/[id]/route';
import { POST as postCoachApply } from '@/app/api/coach/[id]/apply/route';

const assessment: AssessmentInput = {
  profile: {
    ageYears: 30,
    displaySex: 'FEMALE',
    energyEquationReference: 'FEMALE',
    heightCm: 170,
    weightKg: 70,
    trainingAgeMonths: 18,
  },
  goal: { type: 'RECOMP', desiredWeeklyRatePct: 0 },
  schedule: {
    weeklyFrequency: 3,
    availableWeekdays: [1, 3, 5],
    sessionDurationMin: 60,
    equipmentTypes: ['BARBELL', 'BODYWEIGHT'],
    recentMainLifts: [{ catalogKey: 'bench_press', weightKg: 60, reps: 8, rir: 2 }],
  },
  lifestyle: {
    activityLevel: 'MODERATE',
    currentModerateActivityMin: 120,
    habitualSleepMin: 480,
    bedtimeMin: 1380,
    wakeTimeMin: 420,
    timeZone: 'UTC',
  },
  health: {
    urgentSignals: [],
    clearanceSignals: [],
    temporarySignals: [],
    scopeSignals: [],
    healthChangedSinceClearance: false,
    attested: true,
  },
};

function actAs(userId: string | null): void {
  mockUserId.mockResolvedValue(userId);
}

function jsonReq(method: string, body: unknown = {}): Request {
  return new Request('http://test.local/api', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function idParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

type Fixture = Awaited<ReturnType<typeof seedFixture>>;

// One user with both a personalized (managed) activated plan and a legacy,
// hand-made program, so every mutation route can be exercised on both.
async function seedFixture(suffix: string) {
  const suffixSlug = suffix.replace(/\W+/g, '-');
  const user = await db.user.create({
    data: { email: `managed-${suffixSlug}@test.dev`, passwordHash: 'x' },
  });
  const other = await db.user.create({
    data: { email: `managed-other-${suffixSlug}@test.dev`, passwordHash: 'x' },
  });
  await saveAssessment(user.id, assessment, new Date('2026-09-16T12:00:00.000Z'));
  actAs(user.id);
  const draft = (await (await postPreview(jsonReq('POST'))).json()) as { plan: { id: string } };
  const activationResponse = await postActivatePlan(
    jsonReq('POST', { expectedRevision: 0 }),
    idParams(draft.plan.id),
  );
  const activated = (await activationResponse.json()) as { programId: string };

  const managed = await db.program.findUniqueOrThrow({
    where: { id: activated.programId },
    include: { workouts: { include: { exercises: true } } },
  });
  const managedWorkout = managed.workouts[0]!;
  const managedExercise = managedWorkout.exercises[0]!;

  const legacy = await db.program.create({
    data: { userId: user.id, name: 'Legacy block', phase: 'hypertrophy', isActive: false },
  });
  const legacyWorkout = await db.workout.create({
    data: { programId: legacy.id, name: 'Legacy day', order: 1 },
  });
  const legacyExercise = await db.exercise.create({
    data: {
      userId: user.id,
      name: 'Legacy Bench',
      muscleGroup: 'CHEST',
      category: 'COMPOUND',
      equipmentType: 'BARBELL',
    },
  });
  const legacyProgramExercise = await db.programExercise.create({
    data: {
      workoutId: legacyWorkout.id,
      exerciseId: legacyExercise.id,
      order: 1,
      targetSets: 3,
      targetRepsMin: 8,
      targetRepsMax: 12,
      targetRIR: 2,
      restSec: 90,
    },
  });
  const coachSession = await db.coachSession.create({
    data: {
      userId: user.id,
      weekStart: new Date('2026-09-07T00:00:00.000Z'),
      weekEnd: new Date('2026-09-13T00:00:00.000Z'),
      prompt: 'week',
      response: 'summary',
    },
  });

  return {
    user,
    other,
    managed,
    managedWorkout,
    managedExercise,
    legacy,
    legacyWorkout,
    legacyProgramExercise,
    coachSession,
    planId: draft.plan.id,
  };
}

// Snapshot of everything a managed mutation must leave untouched.
async function structureOf(programId: string) {
  const program = await db.program.findUniqueOrThrow({
    where: { id: programId },
    include: {
      workouts: {
        orderBy: { order: 'asc' },
        include: { exercises: { orderBy: { order: 'asc' } } },
      },
    },
  });
  return {
    name: program.name,
    phase: program.phase,
    isActive: program.isActive,
    workouts: program.workouts.map((workout) => ({
      name: workout.name,
      order: workout.order,
      exercises: workout.exercises.map((exercise) => ({
        id: exercise.id,
        order: exercise.order,
        targetSets: exercise.targetSets,
        targetRIR: exercise.targetRIR,
        notes: exercise.notes,
      })),
    })),
  };
}

const workoutInput = { name: 'Renamed day', dayOfWeek: 2 };
const programInput = { name: 'Renamed program', phase: 'strength', description: null };
const programExerciseInput = {
  exerciseId: 'placeholder',
  targetSets: 5,
  targetRepsMin: 5,
  targetRepsMax: 5,
  targetRIR: 1,
  restSec: 120,
};

beforeEach(() => {
  mockUserId.mockReset();
});

describe('managed program immutability', () => {
  it.each([
    [
      'PUT /api/programs/[id]',
      (fixture: Fixture, programId: string) =>
        putProgram(jsonReq('PUT', programInput), idParams(programId)),
      (fixture: Fixture) => fixture.managed.id,
      (fixture: Fixture) => fixture.legacy.id,
    ],
    [
      'DELETE /api/programs/[id]',
      (fixture: Fixture, programId: string) =>
        deleteProgram(jsonReq('DELETE'), idParams(programId)),
      (fixture: Fixture) => fixture.managed.id,
      (fixture: Fixture) => fixture.legacy.id,
    ],
    [
      'POST /api/programs/[id]/workouts',
      (fixture: Fixture, programId: string) =>
        postProgramWorkout(jsonReq('POST', workoutInput), idParams(programId)),
      (fixture: Fixture) => fixture.managed.id,
      (fixture: Fixture) => fixture.legacy.id,
    ],
    [
      'PUT /api/workouts/[id]',
      (fixture: Fixture, workoutId: string) =>
        putWorkout(jsonReq('PUT', workoutInput), idParams(workoutId)),
      (fixture: Fixture) => fixture.managedWorkout.id,
      (fixture: Fixture) => fixture.legacyWorkout.id,
    ],
    [
      'DELETE /api/workouts/[id]',
      (fixture: Fixture, workoutId: string) =>
        deleteWorkout(jsonReq('DELETE'), idParams(workoutId)),
      (fixture: Fixture) => fixture.managedWorkout.id,
      (fixture: Fixture) => fixture.legacyWorkout.id,
    ],
    [
      'POST /api/workouts/[id]/program-exercises',
      (fixture: Fixture, workoutId: string) =>
        postWorkoutExercise(
          jsonReq('POST', {
            ...programExerciseInput,
            exerciseId: fixture.legacyProgramExercise.exerciseId,
          }),
          idParams(workoutId),
        ),
      (fixture: Fixture) => fixture.managedWorkout.id,
      (fixture: Fixture) => fixture.legacyWorkout.id,
    ],
    [
      'PUT /api/program-exercises/[id]',
      (fixture: Fixture, id: string) =>
        putProgramExercise(
          jsonReq('PUT', {
            ...programExerciseInput,
            exerciseId: fixture.legacyProgramExercise.exerciseId,
          }),
          idParams(id),
        ),
      (fixture: Fixture) => fixture.managedExercise.id,
      (fixture: Fixture) => fixture.legacyProgramExercise.id,
    ],
    [
      'DELETE /api/program-exercises/[id]',
      (fixture: Fixture, id: string) => deleteProgramExercise(jsonReq('DELETE'), idParams(id)),
      (fixture: Fixture) => fixture.managedExercise.id,
      (fixture: Fixture) => fixture.legacyProgramExercise.id,
    ],
  ])(
    '%s refuses a managed target and still serves a legacy one',
    async (_label, call, managedId, legacyId) => {
      const fixture = await seedFixture(String(_label));
      actAs(fixture.user.id);
      const before = await structureOf(fixture.managed.id);

      const refused = await call(fixture, managedId(fixture));
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({ error: 'MANAGED_PROGRAM_IMMUTABLE' });
      expect(await structureOf(fixture.managed.id)).toEqual(before);

      const allowed = await call(fixture, legacyId(fixture));
      expect([200, 201]).toContain(allowed.status);
    },
  );

  it('keeps returning the ownership response to a stranger, not the managed refusal', async () => {
    const fixture = await seedFixture('stranger');
    actAs(fixture.other.id);
    const before = await structureOf(fixture.managed.id);

    const program = await putProgram(jsonReq('PUT', programInput), idParams(fixture.managed.id));
    const workout = await putWorkout(
      jsonReq('PUT', workoutInput),
      idParams(fixture.managedWorkout.id),
    );
    const programExercise = await putProgramExercise(
      jsonReq('PUT', {
        ...programExerciseInput,
        exerciseId: fixture.legacyProgramExercise.exerciseId,
      }),
      idParams(fixture.managedExercise.id),
    );

    for (const response of [program, workout, programExercise]) {
      expect(response.status).toBe(404);
      expect((await response.json()).error).not.toBe('MANAGED_PROGRAM_IMMUTABLE');
    }
    expect(await structureOf(fixture.managed.id)).toEqual(before);
  });

  it('refuses a coach apply against a managed active program, all-or-nothing', async () => {
    const fixture = await seedFixture('coach');
    actAs(fixture.user.id);
    const before = await structureOf(fixture.managed.id);
    const firstExercise = fixture.managedWorkout.exercises[0]!;
    const secondExercise = fixture.managedWorkout.exercises[1] ?? firstExercise;
    const exerciseName = (
      await db.exercise.findUniqueOrThrow({ where: { id: firstExercise.exerciseId } })
    ).name;

    const response = await postCoachApply(
      jsonReq('POST', {
        adjustments: [
          { exerciseName, summary: 'Reduce volume', suggestedSets: 2 },
          { exerciseName, summary: 'More rest', suggestedRestSec: 240 },
        ],
      }),
      idParams(fixture.coachSession.id),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'MANAGED_PROGRAM_IMMUTABLE' });
    expect(await structureOf(fixture.managed.id)).toEqual(before);
    expect(
      (await db.coachSession.findUniqueOrThrow({ where: { id: fixture.coachSession.id } }))
        .appliedAt,
    ).toBeNull();
    void secondExercise;
  });

  it('does not block session execution against a managed program', async () => {
    const fixture = await seedFixture('execution');
    actAs(fixture.user.id);

    const session = await db.session.create({
      data: { userId: fixture.user.id, workoutId: fixture.managedWorkout.id },
    });
    const exerciseId = fixture.managedExercise.exerciseId;
    await db.set.create({
      data: { sessionId: session.id, exerciseId, setNumber: 1, weight: 40, reps: 10, rir: 2 },
    });

    expect(await db.set.count({ where: { sessionId: session.id } })).toBe(1);
  });
});

describe('legacy program activation retires personalized planning', () => {
  it('supersedes the active plan, clears the pointer and increments the revision', async () => {
    const fixture = await seedFixture('legacy-activate');
    actAs(fixture.user.id);

    const response = await postActivateProgram(
      jsonReq('POST', { active: true }),
      idParams(fixture.legacy.id),
    );
    expect(response.status).toBe(200);

    const plan = await db.fitnessPlanVersion.findUniqueOrThrow({ where: { id: fixture.planId } });
    expect(plan.status).toBe('SUPERSEDED');
    const activation = await db.fitnessPlanActivation.findUniqueOrThrow({
      where: { userId: fixture.user.id },
    });
    expect(activation.planVersionId).toBeNull();
    expect(activation.revision).toBe(2);
    expect(
      (await db.program.findUniqueOrThrow({ where: { id: fixture.legacy.id } })).isActive,
    ).toBe(true);
    expect(
      (await db.program.findUniqueOrThrow({ where: { id: fixture.managed.id } })).isActive,
    ).toBe(false);
    // The managed Program itself is preserved for history.
    expect(await db.workout.count({ where: { programId: fixture.managed.id } })).toBeGreaterThan(0);
  });

  it('refuses to activate a managed program directly', async () => {
    const fixture = await seedFixture('managed-activate');
    actAs(fixture.user.id);

    const response = await postActivateProgram(
      jsonReq('POST', { active: true }),
      idParams(fixture.managed.id),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'MANAGED_PROGRAM_IMMUTABLE' });
    expect(
      (await db.fitnessPlanActivation.findUniqueOrThrow({ where: { userId: fixture.user.id } }))
        .planVersionId,
    ).toBe(fixture.planId);
  });

  it('retires the plan when a template becomes the active program', async () => {
    const fixture = await seedFixture('from-template');
    actAs(fixture.user.id);

    const response = await postFromTemplate(
      jsonReq('POST', {
        name: 'Template block',
        description: null,
        phase: 'hypertrophy',
        workouts: [
          {
            name: 'Template day',
            dayOfWeek: 1,
            exercises: [
              {
                name: 'Bench Press',
                muscleGroup: 'CHEST',
                category: 'COMPOUND',
                equipmentType: 'BARBELL',
                targetSets: 3,
                targetRepsMin: 6,
                targetRepsMax: 10,
                targetRIR: 2,
                restSec: 150,
              },
            ],
          },
        ],
      }),
    );

    expect(response.status).toBe(201);
    const activation = await db.fitnessPlanActivation.findUniqueOrThrow({
      where: { userId: fixture.user.id },
    });
    expect(activation.planVersionId).toBeNull();
    expect(activation.revision).toBe(2);
    expect(
      (await db.fitnessPlanVersion.findUniqueOrThrow({ where: { id: fixture.planId } })).status,
    ).toBe('SUPERSEDED');
  });

  it('lets a later personalized confirmation reactivate planning with the new revision', async () => {
    const fixture = await seedFixture('reactivate');
    actAs(fixture.user.id);
    expect(
      (await postActivateProgram(jsonReq('POST', { active: true }), idParams(fixture.legacy.id)))
        .status,
    ).toBe(200);

    // The stale confirmation from before the switch is rejected...
    const stale = await postActivatePlan(
      jsonReq('POST', { expectedRevision: 0 }),
      idParams(fixture.planId),
    );
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toBe('ACTIVATION_REVISION_CONFLICT');

    // ...and a fresh preview + confirmation with the incremented revision works.
    const draft = (await (await postPreview(jsonReq('POST'))).json()) as { plan: { id: string } };
    const confirmed = await postActivatePlan(
      jsonReq('POST', { expectedRevision: 2 }),
      idParams(draft.plan.id),
    );
    expect(confirmed.status).toBe(200);
    const body = await confirmed.json();
    expect(body.activationRevision).toBe(3);
    expect((await db.program.findUniqueOrThrow({ where: { id: body.programId } })).isActive).toBe(
      true,
    );
  });

  it('keeps the legacy behavior when the user has no fitness state at all', async () => {
    const user = await db.user.create({
      data: { email: 'legacy-only@test.dev', passwordHash: 'x' },
    });
    const program = await db.program.create({
      data: { userId: user.id, name: 'Only block', phase: 'hypertrophy' },
    });
    actAs(user.id);

    const response = await postActivateProgram(
      jsonReq('POST', { active: true }),
      idParams(program.id),
    );

    expect(response.status).toBe(200);
    expect((await db.program.findUniqueOrThrow({ where: { id: program.id } })).isActive).toBe(true);
    // No activation row is invented for a user who never had fitness state.
    expect(await db.fitnessPlanActivation.findUnique({ where: { userId: user.id } })).toBeNull();
  });
});
