import { describe, it, expect, vi, beforeEach } from 'vitest';
import { db } from '@/lib/db';
import { getCurrentUserId } from '@/lib/auth';

// Backup export/restore completeness (issue #168): the export must carry every
// user-owned model/field, the restore must be a lossless, ownership-scoped
// round trip, version 1 files must keep importing, and a malformed or
// oversized file must be rejected without partially written data.

// Auth is read through getCurrentUserId (via requireApiUserId in @/lib/api).
vi.mock('@/lib/auth', () => ({ getCurrentUserId: vi.fn() }));
const mockUserId = vi.mocked(getCurrentUserId);
const EQUIPMENT_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const EQUIPMENT_PNG_BASE64 = 'iVBORw0KGgo=';

import { GET as getBackup, POST as postBackup } from '@/app/api/backup/route';
import { hashAuditValue } from '@/lib/agent/audit-hash';
import { buildBaselinePlan } from '@/lib/fitness/baseline-plan';
import { evaluateEligibility } from '@/lib/fitness/eligibility';
import { STRENGTH_EXERCISE_CATALOG } from '@/lib/fitness/exercise-catalog';
import { buildPersistedCalculationInput } from '@/lib/fitness/plan-store';
import { createAssessmentInputSchema, type AssessmentInput } from '@/lib/fitness/schemas';

// A genuinely valid v6 fitness record: the plan content and the stored
// calculation input are produced by the same pure builders production uses, so
// the round trip proves the real payload survives rather than a hand-written
// stub that only looks similar.
function fitnessArtifactsAt(now: Date) {
  const assessment = createAssessmentInputSchema(now).parse({
    profile: {
      ageYears: 34,
      displaySex: 'MALE',
      energyEquationReference: 'MALE',
      heightCm: 181,
      weightKg: 82.5,
      bodyFatPct: 17.5,
      trainingAgeMonths: 40,
    },
    goal: {
      type: 'HYPERTROPHY',
      desiredWeeklyRatePct: 0.2,
      targetWeightKg: 86,
      targetDate: '2026-12-01',
    },
    schedule: {
      weeklyFrequency: 4,
      availableWeekdays: [1, 3, 5, 6],
      sessionDurationMin: 75,
      equipmentTypes: ['BARBELL', 'CABLE'],
      recentMainLifts: [{ catalogKey: 'bench_press', weightKg: 85, reps: 8, rir: 2 }],
    },
    lifestyle: {
      activityLevel: 'MODERATE',
      avgDailySteps: 9000,
      currentModerateActivityMin: 120,
      habitualSleepMin: 450,
      bedtimeMin: 1380,
      wakeTimeMin: 420,
      timeZone: 'Europe/Paris',
    },
    health: {
      urgentSignals: [],
      clearanceSignals: [],
      temporarySignals: [],
      scopeSignals: [],
      healthChangedSinceClearance: false,
      attested: true,
    },
  } as AssessmentInput);
  const eligibility = evaluateEligibility(assessment, now);
  const loadGuidance = STRENGTH_EXERCISE_CATALOG.map((entry) => ({
    catalogKey: entry.key,
    source: 'CALIBRATION' as const,
    initialLoadKg: null,
  }));
  const gymConstraints = { unavailableExerciseNames: [] };
  const content = buildBaselinePlan({ assessment, eligibility, gymConstraints, loadGuidance, now });
  const input = buildPersistedCalculationInput(
    {
      profileId: 'profile',
      profileUpdatedAt: now,
      screeningId: 'screening',
      goalId: 'goal',
      assessment,
      eligibility,
      gymConstraints,
      loadGuidance,
      activePlan: null,
      activationRevision: 0,
    },
    '2026-06-01',
  );
  return { content, input, inputHash: hashAuditValue(input) };
}

function actAs(userId: string) {
  mockUserId.mockResolvedValue(userId);
}

function jsonReq(body: unknown): Request {
  return new Request('http://test.local/api/backup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Order-insensitive deep normalization: sorts every array (the export order of
// sets depends on regenerated cuids) and every object key, so two dumps can be
// compared field-for-field.
function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) {
    return v.map(sortDeep).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  }
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .map(([k, val]) => [k, sortDeep(val)] as const)
        .sort(([a], [b]) => (a < b ? -1 : 1)),
    );
  }
  return v;
}

// Strips the fields that legitimately differ between two accounts/exports.
function comparable(dump: Record<string, unknown>): unknown {
  const { exportedAt: _exportedAt, user: _user, ...rest } = dump;
  return sortDeep(rest);
}

// Seeds a user with at least one row in every exported model, exercising all
// the fields issue #168 found missing.
async function seedFullUser(email: string) {
  const user = await db.user.create({
    data: {
      email,
      passwordHash: 'x',
      displayName: 'Julien',
      bodyweight: 82.5,
      sex: 'MALE',
      heightCm: 181,
      goal: 'HYPERTROPHY',
      weeklyFrequency: 4,
      unit: 'LB',
      deloadUntil: new Date('2026-07-05T00:00:00.000Z'),
    },
  });
  const bench = await db.exercise.create({
    data: {
      userId: user.id,
      name: 'Bench Press',
      muscleGroup: 'CHEST',
      category: 'COMPOUND',
      equipmentType: 'BARBELL',
    },
  });
  const pullup = await db.exercise.create({
    data: {
      userId: user.id,
      name: 'Pull-up',
      muscleGroup: 'BACK_WIDTH',
      category: 'COMPOUND',
      usesBodyweight: true,
      equipmentType: 'BODYWEIGHT',
    },
  });
  const running = await db.exercise.create({
    data: {
      userId: user.id,
      name: 'Running',
      muscleGroup: 'OTHER',
      category: 'CARDIO',
      equipmentType: 'CARDIO',
    },
  });
  const gym = await db.gym.create({
    data: {
      userId: user.id,
      name: 'Basement',
      dumbbellWeights: [10, 12, 14, 16, 19],
      plateWeights: [1.25, 2.5, 5, 10, 20],
      barWeights: [20],
      exerciseConfigs: {
        create: { exerciseId: running.id, isAvailable: false, weightOptions: [] },
      },
    },
  });
  await db.user.update({ where: { id: user.id }, data: { activeGymId: gym.id } });
  const equipment = await db.gymEquipment.create({
    data: {
      gymId: gym.id,
      name: 'Competition bench station',
      equipmentType: 'BARBELL',
      description: 'Flat bench with uprights and safety arms.',
      manufacturer: 'GymCo',
      modelName: 'Bench Pro',
      quantity: 2,
      weightOptions: [20, 40, 60, 80, 100],
      imageData: EQUIPMENT_PNG,
      imageMimeType: 'image/png',
      exerciseLinks: { create: { exerciseId: bench.id } },
    },
  });
  const program = await db.program.create({
    data: {
      userId: user.id,
      name: 'Block 1',
      phase: 'accumulation',
      isActive: true,
      startDate: new Date('2026-05-01T00:00:00.000Z'),
      workouts: {
        create: [
          {
            name: 'Upper A',
            dayOfWeek: 1,
            order: 1,
            exercises: {
              create: [
                {
                  exerciseId: bench.id,
                  order: 1,
                  targetSets: 3,
                  targetRepsMin: 5,
                  targetRepsMax: 8,
                  targetRIR: 2,
                  restSec: 120,
                  supersetGroup: 1,
                },
                {
                  exerciseId: pullup.id,
                  order: 2,
                  targetSets: 3,
                  targetRepsMin: 6,
                  targetRepsMax: 10,
                  targetRIR: 2,
                  restSec: 120,
                  supersetGroup: 1,
                },
              ],
            },
          },
        ],
      },
    },
    include: { workouts: true },
  });
  await db.session.create({
    data: {
      userId: user.id,
      programId: program.id,
      workoutId: program.workouts[0]?.id ?? null,
      startedAt: new Date('2026-06-01T10:00:00.000Z'),
      finishedAt: new Date('2026-06-01T11:00:00.000Z'),
      notes: 'good session',
      gymId: gym.id,
      sets: {
        create: [
          {
            exerciseId: bench.id,
            gymEquipmentId: equipment.id,
            equipmentNameSnapshot: 'Competition bench station',
            equipmentLoadSnapshot: {
              version: 1,
              equipmentType: 'BARBELL',
              manufacturer: 'GymCo',
              modelName: 'Bench Pro',
              weightOptions: [20, 40, 60, 80, 100],
            },
            setNumber: 1,
            weight: 100,
            reps: 5,
            rir: 2,
            isDropSet: true,
            notes: 'top set',
            completedAt: new Date('2026-06-01T10:10:00.000Z'),
          },
          {
            exerciseId: running.id,
            setNumber: 1,
            weight: 0,
            reps: 1,
            durationSec: 1800,
            distanceM: 5000,
            avgHr: 152,
            maxHr: 181,
            completedAt: new Date('2026-06-01T10:50:00.000Z'),
          },
        ],
      },
    },
  });
  await db.coachSession.create({
    data: {
      userId: user.id,
      weekStart: new Date('2026-06-01T00:00:00.000Z'),
      weekEnd: new Date('2026-06-07T00:00:00.000Z'),
      prompt: 'week summary',
      response: 'keep going',
      createdAt: new Date('2026-06-07T18:00:00.000Z'),
    },
  });
  await db.exerciseGoal.create({
    data: {
      userId: user.id,
      exerciseId: bench.id,
      targetWeight: 120,
      targetReps: 5,
      createdAt: new Date('2026-05-15T09:00:00.000Z'),
      achievedAt: new Date('2026-06-01T10:10:00.000Z'),
    },
  });
  await db.bodyweightEntry.createMany({
    data: [
      {
        userId: user.id,
        weightKg: 83.1,
        measuredAt: new Date('2026-05-20T07:00:00.000Z'),
        note: 'morning',
      },
      { userId: user.id, weightKg: 82.5, measuredAt: new Date('2026-06-05T07:00:00.000Z') },
    ],
  });
  await db.readinessCheckin.create({
    data: {
      userId: user.id,
      readiness: 4,
      sleepQuality: 3,
      soreness: { QUADS: 4, CHEST: 2 },
      note: 'legs heavy',
      createdAt: new Date('2026-06-01T09:00:00.000Z'),
    },
  });
  await db.conversation.create({
    data: {
      userId: user.id,
      title: 'Plateau on bench',
      createdAt: new Date('2026-06-02T08:00:00.000Z'),
      updatedAt: new Date('2026-06-02T08:05:00.000Z'),
      messages: {
        create: [
          {
            role: 'USER',
            content: 'My bench is stuck.',
            createdAt: new Date('2026-06-02T08:00:00.000Z'),
          },
          {
            role: 'ASSISTANT',
            content: 'Try a back-off set.',
            createdAt: new Date('2026-06-02T08:05:00.000Z'),
          },
        ],
      },
    },
  });
  // v6: the personalized-planning record, incl. managed ProgramExercise fields
  // and two plan versions (one superseded, one active) linked to the program.
  const artifacts = fitnessArtifactsAt(new Date('2026-06-01T09:00:00.000Z'));
  const fitnessProfile = await db.fitnessProfile.create({
    data: {
      userId: user.id,
      ageYears: 34,
      displaySex: 'MALE',
      energyEquationReference: 'MALE',
      bodyFatPct: 17.5,
      trainingAgeMonths: 40,
      weeklyFrequency: 4,
      availableWeekdays: [1, 3, 5, 6],
      sessionDurationMin: 75,
      equipmentTypes: ['BARBELL', 'CABLE', 'BODYWEIGHT'],
      recentMainLifts: [{ catalogKey: 'bench_press', weightKg: 85, reps: 8, rir: 2 }],
      activityLevel: 'MODERATE',
      avgDailySteps: 9000,
      currentModerateActivityMin: 120,
      habitualSleepMin: 450,
      bedtimeMin: 1380,
      wakeTimeMin: 420,
      timeZone: 'Europe/Paris',
    },
  });
  const firstScreening = await db.healthScreening.create({
    data: {
      userId: user.id,
      screeningVersion: 'health-v1',
      rulesVersion: 'baseline-v1',
      answers: {
        urgentSignals: [],
        clearanceSignals: [],
        temporarySignals: [],
        scopeSignals: [],
        healthChangedSinceClearance: false,
        attested: true,
      },
      status: 'ELIGIBLE',
      reasonCodes: ['ELIGIBLE_GENERAL_POPULATION'],
      attestedAt: new Date('2026-05-01T08:00:00.000Z'),
      createdAt: new Date('2026-05-01T08:00:00.000Z'),
    },
  });
  const secondScreening = await db.healthScreening.create({
    data: {
      userId: user.id,
      screeningVersion: 'health-v1',
      rulesVersion: 'baseline-v1',
      answers: {
        urgentSignals: [],
        clearanceSignals: ['KNOWN_HEART_MURMUR'],
        temporarySignals: [],
        scopeSignals: [],
        healthChangedSinceClearance: false,
        clearance: { date: '2026-06-01', unrestricted: true, restrictions: null },
        attested: true,
      },
      status: 'ELIGIBLE',
      reasonCodes: ['ELIGIBLE_GENERAL_POPULATION'],
      attestedAt: new Date('2026-06-01T08:00:00.000Z'),
      clearanceDate: new Date('2026-06-01T00:00:00.000Z'),
      clearanceUnrestricted: true,
      clearanceRestrictions: null,
      createdAt: new Date('2026-06-01T08:00:00.000Z'),
    },
  });
  const supersededGoal = await db.fitnessGoal.create({
    data: {
      userId: user.id,
      type: 'FAT_LOSS',
      desiredWeeklyRatePct: -0.4,
      targetWeightKg: 78,
      targetDate: new Date('2026-09-01T00:00:00.000Z'),
      status: 'SUPERSEDED',
      createdAt: new Date('2026-05-01T08:00:00.000Z'),
      supersededAt: new Date('2026-06-01T08:00:00.000Z'),
    },
  });
  const activeGoal = await db.fitnessGoal.create({
    data: {
      userId: user.id,
      type: 'HYPERTROPHY',
      desiredWeeklyRatePct: 0.2,
      targetWeightKg: 86,
      targetDate: new Date('2026-12-01T00:00:00.000Z'),
      status: 'ACTIVE',
      createdAt: new Date('2026-06-01T08:00:00.000Z'),
    },
  });
  await db.fitnessPlanVersion.create({
    data: {
      userId: user.id,
      profileId: fitnessProfile.id,
      healthScreeningId: firstScreening.id,
      goalId: supersededGoal.id,
      version: 1,
      status: 'SUPERSEDED',
      rulesVersion: 'baseline-v1',
      inputHash: artifacts.inputHash,
      profileUpdatedAt: fitnessProfile.updatedAt,
      input: artifacts.input,
      content: artifacts.content,
      createdAt: new Date('2026-05-01T09:00:00.000Z'),
    },
  });
  const activePlan = await db.fitnessPlanVersion.create({
    data: {
      userId: user.id,
      profileId: fitnessProfile.id,
      healthScreeningId: secondScreening.id,
      goalId: activeGoal.id,
      version: 2,
      status: 'ACTIVE',
      rulesVersion: 'baseline-v1',
      inputHash: artifacts.inputHash,
      profileUpdatedAt: fitnessProfile.updatedAt,
      input: artifacts.input,
      content: artifacts.content,
      programId: program.id,
      createdAt: new Date('2026-06-01T09:00:00.000Z'),
      activatedAt: new Date('2026-06-01T09:05:00.000Z'),
    },
  });
  await db.fitnessPlanActivation.create({
    data: {
      userId: user.id,
      planVersionId: activePlan.id,
      revision: 1,
      activatedAt: new Date('2026-06-01T09:05:00.000Z'),
    },
  });
  await db.programExercise.updateMany({
    where: { workout: { programId: program.id } },
    data: {
      initialLoadKg: 85,
      initialLoadSource: 'APP_HISTORY',
      progressionRuleVersion: 'double-progression-v2',
      introTargetRIR: 3,
      introEndsAt: new Date('2026-06-15T09:05:00.000Z'),
    },
  });
  return user;
}

async function countsFor(userId: string) {
  return {
    exercises: await db.exercise.count({ where: { userId } }),
    programs: await db.program.count({ where: { userId } }),
    sessions: await db.session.count({ where: { userId } }),
    sets: await db.set.count({ where: { session: { userId } } }),
    coachSessions: await db.coachSession.count({ where: { userId } }),
    goals: await db.exerciseGoal.count({ where: { userId } }),
    bodyweightEntries: await db.bodyweightEntry.count({ where: { userId } }),
    readinessCheckins: await db.readinessCheckin.count({ where: { userId } }),
    conversations: await db.conversation.count({ where: { userId } }),
    messages: await db.message.count({ where: { conversation: { userId } } }),
    gyms: await db.gym.count({ where: { userId } }),
    gymConfigs: await db.gymExerciseConfig.count({ where: { gym: { userId } } }),
    gymEquipment: await db.gymEquipment.count({ where: { gym: { userId } } }),
    gymEquipmentLinks: await db.gymEquipmentExercise.count({
      where: { equipment: { gym: { userId } } },
    }),
    fitnessProfiles: await db.fitnessProfile.count({ where: { userId } }),
    screenings: await db.healthScreening.count({ where: { userId } }),
    fitnessGoals: await db.fitnessGoal.count({ where: { userId } }),
    planVersions: await db.fitnessPlanVersion.count({ where: { userId } }),
    activations: await db.fitnessPlanActivation.count({ where: { userId } }),
    managedProgramExercises: await db.programExercise.count({
      where: { workout: { program: { userId } }, progressionRuleVersion: { not: null } },
    }),
  };
}

beforeEach(() => {
  mockUserId.mockReset();
});

describe('GET /api/backup - export completeness (issue #168)', () => {
  it('exports version 6 with the fitness record and all earlier backup fields', async () => {
    const user = await seedFullUser('a@test.dev');
    actAs(user.id);

    const res = await getBackup();
    expect(res.status).toBe(200);
    const dump = await res.json();

    expect(dump.version).toBe(6);
    expect(dump.profile).toMatchObject({
      displayName: 'Julien',
      bodyweight: 82.5,
      sex: 'MALE',
      heightCm: 181,
      goal: 'HYPERTROPHY',
      weeklyFrequency: 4,
      unit: 'LB',
      deloadUntil: '2026-07-05T00:00:00.000Z',
      activeGymName: 'Basement',
    });

    const pullup = dump.exercises.find((e: { name: string }) => e.name === 'Pull-up');
    expect(pullup.usesBodyweight).toBe(true);
    expect(pullup.equipmentType).toBe('BODYWEIGHT');
    expect(dump.gyms).toEqual([
      {
        name: 'Basement',
        dumbbellWeights: [10, 12, 14, 16, 19],
        plateWeights: [1.25, 2.5, 5, 10, 20],
        barWeights: [20],
        equipment: [
          {
            name: 'Competition bench station',
            equipmentType: 'BARBELL',
            description: 'Flat bench with uprights and safety arms.',
            manufacturer: 'GymCo',
            modelName: 'Bench Pro',
            quantity: 2,
            weightOptions: [20, 40, 60, 80, 100],
            imageUrl: null,
            imageMimeType: 'image/png',
            imageBase64: EQUIPMENT_PNG_BASE64,
            exerciseNames: ['Bench Press'],
          },
        ],
        exerciseConfigs: [{ exerciseName: 'Running', isAvailable: false, weightOptions: [] }],
      },
    ]);
    expect(dump.sessions[0].gymName).toBe('Basement');

    const sets = dump.sessions[0].sets as Array<Record<string, unknown>>;
    const benchSet = sets.find((s) => s.exerciseName === 'Bench Press');
    expect(benchSet).toMatchObject({
      gymEquipmentName: 'Competition bench station',
      equipmentNameSnapshot: 'Competition bench station',
      equipmentLoadSnapshot: {
        version: 1,
        equipmentType: 'BARBELL',
        manufacturer: 'GymCo',
        modelName: 'Bench Pro',
        weightOptions: [20, 40, 60, 80, 100],
      },
    });
    const cardio = sets.find((s) => s.exerciseName === 'Running');
    expect(cardio).toMatchObject({ durationSec: 1800, distanceM: 5000, avgHr: 152, maxHr: 181 });

    const peGroups = dump.programs[0].workouts[0].exercises.map(
      (pe: { supersetGroup: number | null }) => pe.supersetGroup,
    );
    expect(peGroups).toEqual([1, 1]);

    expect(dump.exerciseGoals).toEqual([
      {
        exerciseName: 'Bench Press',
        targetWeight: 120,
        targetReps: 5,
        createdAt: '2026-05-15T09:00:00.000Z',
        achievedAt: '2026-06-01T10:10:00.000Z',
      },
    ]);
    expect(dump.bodyweightEntries).toHaveLength(2);
    expect(dump.readinessCheckins).toEqual([
      {
        readiness: 4,
        sleepQuality: 3,
        soreness: { QUADS: 4, CHEST: 2 },
        note: 'legs heavy',
        createdAt: '2026-06-01T09:00:00.000Z',
      },
    ]);
    expect(dump.conversations).toHaveLength(1);
    expect(dump.conversations[0].messages).toHaveLength(2);

    // v6: the planning record rides along, referencing rows by array index and
    // never by database id.
    expect(dump.fitness.profile).toMatchObject({
      ageYears: 34,
      energyEquationReference: 'MALE',
      sessionDurationMin: 75,
      timeZone: 'Europe/Paris',
    });
    expect(dump.fitness.screenings).toHaveLength(2);
    expect(dump.fitness.screenings[1]).toMatchObject({
      status: 'ELIGIBLE',
      clearanceUnrestricted: true,
    });
    expect(dump.fitness.goals.map((goal: { status: string }) => goal.status)).toEqual([
      'SUPERSEDED',
      'ACTIVE',
    ]);
    expect(dump.fitness.plans.map((plan: { version: number }) => plan.version)).toEqual([1, 2]);
    expect(dump.fitness.plans.map((plan: { status: string }) => plan.status)).toEqual([
      'SUPERSEDED',
      'ACTIVE',
    ]);
    expect(dump.fitness.plans[1]).toMatchObject({
      screeningIndex: 1,
      goalIndex: 1,
      programIndex: 0,
    });
    expect(dump.fitness.activation).toMatchObject({ planVersionIndex: 1, revision: 1 });
    // The stored planning input is preserved verbatim (it is the user's record)
    // but the export is still id-free.
    expect(dump.fitness.plans[1].input.calculationDate).toBe('2026-06-01');
    expect(dump.fitness.plans[1].content.schemaVersion).toBe(1);
    expect(JSON.stringify(dump)).not.toContain(user.id);

    const managed = dump.programs[0].workouts[0].exercises[0];
    expect(managed).toMatchObject({
      initialLoadKg: 85,
      initialLoadSource: 'APP_HISTORY',
      progressionRuleVersion: 'double-progression-v2',
      introTargetRIR: 3,
      introEndsAt: '2026-06-15T09:05:00.000Z',
    });
  });

  it('rejects image-heavy exports before materializing an unrestorable backup', async () => {
    const user = await db.user.create({
      data: { email: 'export-budget@test.dev', passwordHash: 'x' },
    });
    const gym = await db.gym.create({
      data: { userId: user.id, name: 'Image-heavy gym' },
    });
    const maxImage = new Uint8Array(5 * 1024 * 1024);
    maxImage.set(EQUIPMENT_PNG);
    await db.gymEquipment.createMany({
      data: Array.from({ length: 8 }, (_, index) => ({
        gymId: gym.id,
        name: 'Image station ' + index,
        equipmentType: 'MACHINE' as const,
        imageData: maxImage,
        imageMimeType: 'image/png',
      })),
    });
    actAs(user.id);
    const materializeGyms = vi.spyOn(db.gym, 'findMany');

    const response = await getBackup();

    expect(response.status).toBe(413);
    expect(materializeGyms).not.toHaveBeenCalled();
    materializeGyms.mockRestore();
    expect(await response.json()).toEqual({
      error:
        'This backup is larger than the maximum restorable backup size. Reduce uploaded gym equipment images and try again.',
    });
  });
});

describe('POST /api/backup - restore round trip (issue #168)', () => {
  it('restores an export losslessly into a second user, ownership-scoped', async () => {
    const userA = await seedFullUser('a@test.dev');
    actAs(userA.id);
    const dumpA = await (await getBackup()).json();
    const countsA = await countsFor(userA.id);

    const userB = await db.user.create({
      data: { email: 'b@test.dev', passwordHash: 'x' },
    });
    actAs(userB.id);
    const res = await postBackup(jsonReq({ payload: dumpA, confirmReplace: true }));
    expect(res.status).toBe(200);

    // Field-for-field lossless round trip (ids regenerated, so compare the
    // re-export of user B against user A's export).
    const dumpB = await (await getBackup()).json();
    expect(comparable(dumpB)).toEqual(comparable(dumpA));

    // Ownership-scoped: user A's data is untouched, user B owns a full copy.
    expect(await countsFor(userA.id)).toEqual(countsA);
    expect(await countsFor(userB.id)).toEqual(countsA);

    // JSON null convention is preserved by restore: a set with no equipment
    // snapshot stores JSON null, not SQL NULL, matching the normal set writer.
    const [restoredNullState] = await db.$queryRaw<
      Array<{ isDbNull: boolean; isJsonNull: boolean }>
    >`
      SELECT
        s."equipmentLoadSnapshot" IS NULL AS "isDbNull",
        s."equipmentLoadSnapshot" = 'null'::jsonb AS "isJsonNull"
      FROM "Set" s
      JOIN "Session" sess ON sess."id" = s."sessionId"
      JOIN "Exercise" e ON e."id" = s."exerciseId"
      WHERE sess."userId" = ${userB.id} AND e."name" = 'Running'
      LIMIT 1
    `;
    expect(restoredNullState).toEqual({ isDbNull: false, isJsonNull: true });

    // The goal was re-linked to user B's own copy of the exercise.
    const goalB = await db.exerciseGoal.findFirst({
      where: { userId: userB.id },
      include: { exercise: true },
    });
    expect(goalB?.exercise.userId).toBe(userB.id);
    expect(goalB?.exercise.name).toBe('Bench Press');

    // The profile (including deload state) was restored onto user B.
    const profileB = await db.user.findUnique({ where: { id: userB.id } });
    expect(profileB?.displayName).toBe('Julien');
    expect(profileB?.unit).toBe('LB');
    expect(profileB?.deloadUntil?.toISOString()).toBe('2026-07-05T00:00:00.000Z');
    const activeGymB = await db.gym.findFirst({ where: { id: profileB?.activeGymId ?? '' } });
    expect(activeGymB?.name).toBe('Basement');
    expect(profileB?.email).toBe('b@test.dev');

    // v6: the fitness record survives with its relations re-linked to user B's
    // own rows, and the activated plan still points at the restored Program.
    const planB = await db.fitnessPlanVersion.findFirstOrThrow({
      where: { userId: userB.id, status: 'ACTIVE' },
      include: { profile: true, healthScreening: true, goal: true, program: true },
    });
    expect(planB.profile.userId).toBe(userB.id);
    expect(planB.healthScreening.userId).toBe(userB.id);
    expect(planB.goal.userId).toBe(userB.id);
    expect(planB.program?.userId).toBe(userB.id);
    expect(planB.program?.isActive).toBe(true);
    expect(planB.inputHash).toBe(hashAuditValue(planB.input as never));

    const activationB = await db.fitnessPlanActivation.findUniqueOrThrow({
      where: { userId: userB.id },
    });
    expect(activationB.planVersionId).toBe(planB.id);
    expect(activationB.revision).toBe(1);
    expect(
      await db.fitnessPlanVersion.count({ where: { userId: userB.id, status: 'ACTIVE' } }),
    ).toBe(1);
    const managedB = await db.programExercise.findFirstOrThrow({
      where: { workout: { program: { userId: userB.id } }, progressionRuleVersion: { not: null } },
    });
    expect(managedB).toMatchObject({
      initialLoadKg: 85,
      initialLoadSource: 'APP_HISTORY',
      progressionRuleVersion: 'double-progression-v2',
      introTargetRIR: 3,
    });
    expect(managedB.introEndsAt?.toISOString()).toBe('2026-06-15T09:05:00.000Z');
  });

  it('still restores a version 1 backup (fields and models added in v2 absent)', async () => {
    const user = await db.user.create({
      data: { email: 'v1@test.dev', passwordHash: 'x', displayName: 'Keep Me' },
    });
    actAs(user.id);

    // Shape produced by the pre-#168 route: no profile, no v2 models, sets
    // and program exercises without the v2 fields.
    const v1Payload = {
      version: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      user: { email: 'v1@test.dev', createdAt: '2025-01-01T00:00:00.000Z' },
      exercises: [
        {
          name: 'Squat',
          muscleGroup: 'QUADS',
          category: 'COMPOUND',
          defaultRestSec: 180,
          notes: null,
        },
      ],
      programs: [
        {
          name: 'Old Block',
          description: null,
          phase: 'base',
          isActive: false,
          startDate: '2025-11-01T00:00:00.000Z',
          endDate: null,
          workouts: [
            {
              name: 'Legs',
              dayOfWeek: 2,
              order: 1,
              exercises: [
                {
                  exerciseName: 'Squat',
                  order: 1,
                  targetSets: 4,
                  targetRepsMin: 5,
                  targetRepsMax: 8,
                  targetRIR: 1,
                  restSec: 180,
                  tempo: null,
                  notes: null,
                },
              ],
            },
          ],
        },
      ],
      sessions: [
        {
          programName: 'Old Block',
          workoutName: 'Legs',
          startedAt: '2025-11-03T10:00:00.000Z',
          finishedAt: null,
          notes: null,
          sets: [
            {
              exerciseName: 'Squat',
              setNumber: 1,
              weight: 140,
              reps: 5,
              rir: 1,
              notes: null,
              isWarmup: false,
              isDropSet: false,
              completedAt: '2025-11-03T10:15:00.000Z',
            },
          ],
        },
      ],
      coachSessions: [],
    };

    const res = await postBackup(jsonReq({ payload: v1Payload, confirmReplace: true }));
    expect(res.status).toBe(200);

    const counts = await countsFor(user.id);
    expect(counts.exercises).toBe(1);
    expect(counts.programs).toBe(1);
    expect(counts.sets).toBe(1);
    expect(counts.goals).toBe(0);
    expect(counts.bodyweightEntries).toBe(0);
    expect(counts.readinessCheckins).toBe(0);
    expect(counts.conversations).toBe(0);

    // v2 fields default to their pre-#168 values.
    const squat = await db.exercise.findFirst({ where: { userId: user.id } });
    expect(squat?.usesBodyweight).toBe(false);
    const pe = await db.programExercise.findFirst({
      where: { workout: { program: { userId: user.id } } },
    });
    expect(pe?.supersetGroup).toBeNull();
    const set = await db.set.findFirst({ where: { session: { userId: user.id } } });
    expect(set?.durationSec).toBeNull();
    expect(set?.avgHr).toBeNull();
    expect(set?.maxHr).toBeNull();

    // No profile in a v1 file: the account's profile is left alone.
    const profile = await db.user.findUnique({ where: { id: user.id } });
    expect(profile?.displayName).toBe('Keep Me');
  });
});

describe('POST /api/backup - malformed and oversized input (issue #168)', () => {
  it('rejects out-of-bounds values without touching existing data', async () => {
    const user = await seedFullUser('victim@test.dev');
    actAs(user.id);
    const before = await countsFor(user.id);
    const dump = await (await getBackup()).json();

    dump.sessions[0].sets[0].avgHr = 999; // out of the 40..250 range
    const res = await postBackup(jsonReq({ payload: dump, confirmReplace: true }));
    expect(res.status).toBe(400);

    // Validation failed before the transaction: nothing was deleted.
    expect(await countsFor(user.id)).toEqual(before);
  });

  it('rejects an out-of-bounds max HR without touching existing data (issue #203)', async () => {
    const user = await seedFullUser('victim-maxhr@test.dev');
    actAs(user.id);
    const before = await countsFor(user.id);
    const dump = await (await getBackup()).json();

    dump.sessions[0].sets[0].maxHr = 999; // out of the 40..250 range
    const res = await postBackup(jsonReq({ payload: dump, confirmReplace: true }));
    expect(res.status).toBe(400);
    expect(await countsFor(user.id)).toEqual(before);
  });

  it('rejects an out-of-range date as a clean 400, not a Prisma 500', async () => {
    const user = await seedFullUser('victim-date@test.dev');
    actAs(user.id);
    const before = await countsFor(user.id);
    const dump = await (await getBackup()).json();

    // Year 275760 parses in JS Date but is far outside PostgreSQL's range;
    // it must be rejected by validation, not 500 deep in Prisma.
    dump.sessions[0].startedAt = '+275760-09-13T00:00:00.000Z';
    const res = await postBackup(jsonReq({ payload: dump, confirmReplace: true }));
    expect(res.status).toBe(400);
    expect(await countsFor(user.id)).toEqual(before);
  });

  it('rejects a non-JSON body and a missing confirmReplace', async () => {
    const user = await seedFullUser('victim2@test.dev');
    actAs(user.id);
    const before = await countsFor(user.id);

    const notJson = await postBackup(
      new Request('http://test.local/api/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json {{{',
      }),
    );
    expect(notJson.status).toBe(400);

    const dump = await (await getBackup()).json();
    const noConfirm = await postBackup(jsonReq({ payload: dump, confirmReplace: false }));
    expect(noConfirm.status).toBe(400);

    expect(await countsFor(user.id)).toEqual(before);
  });

  it('rolls back the whole restore when a row fails mid-transaction', async () => {
    const user = await seedFullUser('victim3@test.dev');
    actAs(user.id);
    const before = await countsFor(user.id);
    const dump = await (await getBackup()).json();
    const pristine = JSON.parse(JSON.stringify(dump));

    // Passes Zod but violates the (userId, name) unique constraint during the
    // restore: the transaction must roll back, leaving the user's previous
    // data fully intact (not wiped, not partially replaced).
    dump.exercises.push({ ...dump.exercises[0] });
    const res = await postBackup(jsonReq({ payload: dump, confirmReplace: true }));
    expect(res.status).toBe(409);

    expect(await countsFor(user.id)).toEqual(before);
    const dumpAfter = await (await getBackup()).json();
    expect(comparable(dumpAfter)).toEqual(comparable(pristine));
  });

  it('rejects an oversized body with 413 while reading it', async () => {
    const user = await db.user.create({
      data: { email: 'big@test.dev', passwordHash: 'x' },
    });
    actAs(user.id);

    // 50 MiB cap: a body just past it must be cut off during the read.
    const oversized = '{"payload": "' + 'x'.repeat(50 * 1024 * 1024) + '"}';
    const res = await postBackup(
      new Request('http://test.local/api/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: oversized,
      }),
    );
    expect(res.status).toBe(413);
  });

  it('rejects an array past its cap (oversized backup shape)', async () => {
    const user = await db.user.create({
      data: { email: 'flood@test.dev', passwordHash: 'x' },
    });
    actAs(user.id);

    const entries = Array.from({ length: 20001 }, (_, i) => ({
      weightKg: 80,
      measuredAt: new Date(1700000000000 + i * 1000).toISOString(),
      note: null,
    }));
    const res = await postBackup(
      jsonReq({
        payload: {
          version: 2,
          exercises: [],
          programs: [],
          sessions: [],
          bodyweightEntries: entries,
        },
        confirmReplace: true,
      }),
    );
    expect(res.status).toBe(400);
    expect(await db.bodyweightEntry.count({ where: { userId: user.id } })).toBe(0);
  });
});

describe('POST /api/backup - fitness record (v6)', () => {
  type BackupDump = {
    version: number;
    fitness: {
      profile: Record<string, unknown> | null;
      screenings: Array<Record<string, unknown>>;
      goals: Array<Record<string, unknown>>;
      plans: Array<Record<string, unknown>>;
      activation: {
        planVersionIndex: number | null;
        revision: number;
        activatedAt: string;
      } | null;
    };
  };

  // A complete v6 export, produced by the real route, mutated per case.
  async function v6Dump(email: string) {
    const source = await seedFullUser(email);
    actAs(source.id);
    return (await (await getBackup()).json()) as BackupDump;
  }

  async function freshUser(email: string) {
    return db.user.create({ data: { email, passwordHash: 'x' } });
  }

  it.each([
    [
      'an unknown screening status',
      (payload: BackupDump) => {
        payload.fitness.screenings[0]!.status = 'MAYBE';
      },
    ],
    [
      'plan content that violates the plan schema',
      (payload: BackupDump) => {
        payload.fitness.plans[0]!.content = { schemaVersion: 1 };
      },
    ],
    [
      'a plan referencing a missing screening',
      (payload: BackupDump) => {
        payload.fitness.plans[0]!.screeningIndex = 99;
      },
    ],
    [
      'a plan referencing a missing goal',
      (payload: BackupDump) => {
        payload.fitness.plans[0]!.goalIndex = 99;
      },
    ],
    [
      'a plan referencing a missing program',
      (payload: BackupDump) => {
        payload.fitness.plans[0]!.programIndex = 99;
      },
    ],
    [
      'a duplicate plan version',
      (payload: BackupDump) => {
        payload.fitness.plans[1]!.version = payload.fitness.plans[0]!.version;
      },
    ],
    [
      'an activation pointing at a superseded plan',
      (payload: BackupDump) => {
        payload.fitness.activation!.planVersionIndex = 0;
      },
    ],
    [
      'two ACTIVE plans',
      (payload: BackupDump) => {
        payload.fitness.plans[0]!.status = 'ACTIVE';
      },
    ],
    [
      'an ACTIVE plan with no activation row',
      (payload: BackupDump) => {
        payload.fitness.activation = null;
      },
    ],
  ])('rejects %s without importing anything', async (label, mutate) => {
    const slug = label.replace(/\W+/g, '-');
    const payload = await v6Dump(`v6-reject-${slug}@test.dev`);
    mutate(payload);
    const target = await freshUser(`v6-target-${slug}@test.dev`);
    actAs(target.id);

    const response = await postBackup(jsonReq({ payload, confirmReplace: true }));
    expect(response.status, label).toBe(400);
    expect(await countsFor(target.id), label).toMatchObject({
      programs: 0,
      exercises: 0,
      fitnessProfiles: 0,
      screenings: 0,
      fitnessGoals: 0,
      planVersions: 0,
      activations: 0,
    });
  });

  it('rolls profile, screenings, goals, plans, links and activation back together', async () => {
    const dump = await v6Dump('v6-rollback-source@test.dev');
    const target = await freshUser('v6-rollback-target@test.dev');
    actAs(target.id);
    expect((await postBackup(jsonReq({ payload: dump, confirmReplace: true }))).status).toBe(200);
    const before = await countsFor(target.id);

    const broken = structuredClone(dump);
    broken.fitness.plans[1]!.version = broken.fitness.plans[0]!.version;
    const response = await postBackup(jsonReq({ payload: broken, confirmReplace: true }));

    expect(response.status).toBe(400);
    expect(await countsFor(target.id)).toEqual(before);
    // The pre-existing restore is intact, links included.
    const plan = await db.fitnessPlanVersion.findFirstOrThrow({
      where: { userId: target.id, status: 'ACTIVE' },
      include: { program: true },
    });
    expect(plan.program?.isActive).toBe(true);
  });

  it('preserves a null activation pointer and its revision', async () => {
    const dump = await v6Dump('v6-null-pointer@test.dev');
    // An inactive personalized state: no ACTIVE plan, pointer null, revision 3.
    for (const plan of dump.fitness.plans) {
      plan.status = 'SUPERSEDED';
      plan.programIndex = null;
      plan.activatedAt = null;
    }
    dump.fitness.activation = {
      planVersionIndex: null,
      revision: 3,
      activatedAt: '2026-06-01T09:05:00.000Z',
    };
    const target = await freshUser('v6-null-pointer-target@test.dev');
    actAs(target.id);

    expect((await postBackup(jsonReq({ payload: dump, confirmReplace: true }))).status).toBe(200);

    const activation = await db.fitnessPlanActivation.findUniqueOrThrow({
      where: { userId: target.id },
    });
    expect(activation.planVersionId).toBeNull();
    // A stale confirmation therefore stays stale after the restore.
    expect(activation.revision).toBe(3);
    expect(
      await db.fitnessPlanVersion.count({ where: { userId: target.id, status: 'ACTIVE' } }),
    ).toBe(0);
  });

  it('marks a v6 import complete even when the file carries no planning profile', async () => {
    const dump = await v6Dump('v6-no-profile@test.dev');
    dump.fitness.profile = null;
    dump.fitness.plans = [];
    dump.fitness.activation = null;
    dump.fitness.goals = [];
    dump.fitness.screenings = [];
    const target = await freshUser('v6-no-profile-target@test.dev');
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: target.id } })).fitnessOnboardingRequired,
    ).toBe(true);
    actAs(target.id);

    expect((await postBackup(jsonReq({ payload: dump, confirmReplace: true }))).status).toBe(200);

    // The importing account must land in the app rather than being sent through
    // the source account's onboarding flow.
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: target.id } })).fitnessOnboardingRequired,
    ).toBe(false);
  });

  it('imports a v5 file without any fitness data and leaves managed fields null', async () => {
    const dump = await v6Dump('v5-legacy@test.dev');
    const legacy = structuredClone(dump) as Record<string, unknown>;
    legacy.version = 5;
    delete legacy.fitness;
    for (const program of legacy.programs as Array<{
      workouts: Array<{ exercises: Array<Record<string, unknown>> }>;
    }>) {
      for (const workout of program.workouts) {
        for (const exercise of workout.exercises) {
          delete exercise.initialLoadKg;
          delete exercise.initialLoadSource;
          delete exercise.progressionRuleVersion;
          delete exercise.introTargetRIR;
          delete exercise.introEndsAt;
        }
      }
    }
    const target = await freshUser('v5-target@test.dev');
    actAs(target.id);

    expect((await postBackup(jsonReq({ payload: legacy, confirmReplace: true }))).status).toBe(200);

    expect(await db.fitnessProfile.count({ where: { userId: target.id } })).toBe(0);
    expect(await db.fitnessPlanVersion.count({ where: { userId: target.id } })).toBe(0);
    const managed = await db.programExercise.findFirstOrThrow({
      where: { workout: { program: { userId: target.id } } },
    });
    expect(managed.initialLoadKg).toBeNull();
    expect(managed.initialLoadSource).toBeNull();
    expect(managed.progressionRuleVersion).toBeNull();
    expect(managed.introTargetRIR).toBeNull();
    expect(managed.introEndsAt).toBeNull();
  });
});

describe('POST /api/backup - gym normalization on import (issue #286)', () => {
  it('normalizes gym weight arrays and skips duplicate gym names instead of failing', async () => {
    const user = await db.user.create({
      data: { email: 'gyms@test.dev', passwordHash: 'x' },
    });
    actAs(user.id);

    // Hand-edited file: unsorted / duplicated / over-precise weights, and the
    // same gym name twice (which the @@unique([userId, name]) constraint would
    // otherwise reject, aborting the whole restore).
    const res = await postBackup(
      jsonReq({
        payload: {
          version: 3,
          profile: { activeGymName: 'Home' },
          exercises: [
            {
              name: 'Bench Press',
              muscleGroup: 'CHEST',
              category: 'COMPOUND',
              defaultRestSec: 120,
            },
          ],
          programs: [],
          sessions: [],
          gyms: [
            {
              name: ' Home ',
              dumbbellWeights: [20, 10, 12.499, 10],
              plateWeights: [],
              barWeights: [20],
              exerciseConfigs: [
                {
                  exerciseName: 'Bench Press',
                  isAvailable: true,
                  weightOptions: [60, 40, 60],
                },
              ],
            },
            {
              name: 'Home',
              dumbbellWeights: [5],
              plateWeights: [],
              barWeights: [],
              exerciseConfigs: [],
            },
          ],
        },
        confirmReplace: true,
      }),
    );
    expect(res.status).toBe(200);

    const gyms = await db.gym.findMany({
      where: { userId: user.id },
      include: { exerciseConfigs: true },
    });
    expect(gyms).toHaveLength(1);
    const gym = gyms[0]!;
    // First occurrence wins, with the same normalization the gym API applies.
    expect(gym.name).toBe('Home');
    expect(gym.dumbbellWeights).toEqual([10, 12.5, 20]);
    expect(gym.barWeights).toEqual([20]);
    expect(gym.exerciseConfigs[0]!.weightOptions).toEqual([40, 60]);

    // The active gym still resolves to the surviving row.
    const profile = await db.user.findUnique({ where: { id: user.id } });
    expect(profile?.activeGymId).toBe(gym.id);
  });
});
