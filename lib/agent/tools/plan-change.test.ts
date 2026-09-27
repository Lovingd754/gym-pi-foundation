import { describe, expect, it, vi } from 'vitest';
import { buildBaselinePlan, type BaselinePlanInput } from '@/lib/fitness/baseline-plan';
import { evaluateEligibility } from '@/lib/fitness/eligibility';
import { STRENGTH_EXERCISE_CATALOG } from '@/lib/fitness/exercise-catalog';
import type { InitialLoadGuidance } from '@/lib/fitness/load-evidence';
import { parseFitnessPlanContent } from '@/lib/fitness/plan-schema';
import { createAssessmentInputSchema, type AssessmentInput } from '@/lib/fitness/schemas';
import type { PlanProposalStore } from '../plan-proposals';
import { loadToolLabels } from './labels';
import { buildChange, createPlanChangeTool, renderDiff, resolveCatalogName } from './plan-change';

const NOW = new Date('2026-09-19T04:00:00.000Z');

function assessment(): AssessmentInput {
  return createAssessmentInputSchema(NOW).parse({
    profile: {
      displayName: undefined,
      ageYears: 30,
      displaySex: 'PREFER_NOT_TO_SAY',
      energyEquationReference: 'UNSPECIFIED',
      heightCm: 170,
      weightKg: 82,
      trainingAgeMonths: 3,
    },
    goal: {
      type: 'FAT_LOSS',
      desiredWeeklyRatePct: -0.5,
      targetWeightKg: 74,
      targetDate: '2027-03-01',
    },
    schedule: {
      weeklyFrequency: 3,
      availableWeekdays: [1, 3, 5],
      sessionDurationMin: 60,
      equipmentTypes: ['DUMBBELL', 'BODYWEIGHT'],
      recentMainLifts: [{ catalogKey: 'goblet_squat', weightKg: 24, reps: 10, rir: 2 }],
    },
    lifestyle: {
      activityLevel: 'SEDENTARY',
      avgDailySteps: 5000,
      currentModerateActivityMin: 40,
      habitualSleepMin: 380,
      bedtimeMin: 1430,
      wakeTimeMin: 420,
      timeZone: 'Asia/Shanghai',
    },
    health: {
      urgentSignals: [],
      clearanceSignals: [],
      temporarySignals: [],
      scopeSignals: [],
      healthChangedSinceClearance: false,
      attested: true,
    },
  });
}

function planContent(): unknown {
  const value = assessment();
  const guidance: InitialLoadGuidance[] = STRENGTH_EXERCISE_CATALOG.map((entry) =>
    entry.key === 'goblet_squat'
      ? { catalogKey: entry.key, source: 'USER_REPORTED' as const, initialLoadKg: 24 }
      : { catalogKey: entry.key, source: 'CALIBRATION' as const, initialLoadKg: null },
  );
  const input = {
    assessment: value,
    eligibility: evaluateEligibility(value, NOW),
    gymConstraints: { unavailableExerciseNames: [] },
    loadGuidance: guidance,
    now: NOW,
  } satisfies BaselinePlanInput;
  return buildBaselinePlan(input);
}

const constraints = {
  availableWeekdays: [1, 2, 3, 4, 5],
  equipmentTypes: ['DUMBBELL', 'BODYWEIGHT'],
  unavailableExerciseNames: [],
};

function store(overrides: Partial<PlanProposalStore> = {}): PlanProposalStore {
  return {
    propose: vi.fn(async () => ({ id: 'proposal_1', created: true })),
    list: vi.fn(async () => []),
    loadPending: vi.fn(async () => null),
    markApplied: vi.fn(async () => {}),
    dismiss: vi.fn(async () => true),
    ...overrides,
  };
}

function tool(overrides: Partial<PlanProposalStore> = {}) {
  return createPlanChangeTool(
    { userId: 'user_1', conversationId: 'conversation_1', locale: 'zh-CN' },
    {
      loadActivePlan: async () => ({ id: 'plan_1', content: planContent() }),
      loadConstraints: async () => constraints,
    },
    store(overrides),
  );
}

function textOf(result: { content: unknown }): string {
  const [block] = result.content as Array<{ type: string; text?: string }>;
  return block?.text ?? '';
}

describe('resolveCatalogName', () => {
  it('accepts the name the trainee reads as well as the catalog name', () => {
    expect(resolveCatalogName('Goblet Squat', 'zh-CN')).toBe('Goblet Squat');
    expect(resolveCatalogName('高脚杯深蹲', 'zh-CN')).toBe('Goblet Squat');
  });

  it('passes an unknown name through so the rules can refuse it', () => {
    expect(resolveCatalogName('Barbell Clean', 'zh-CN')).toBe('Barbell Clean');
  });
});

describe('buildChange', () => {
  it('requires the fields each change kind needs', () => {
    expect(() => buildChange({ changeType: 'swap_exercise' })).toThrow();
    expect(() => buildChange({ changeType: 'move_training_day', fromWeekday: 1 })).toThrow();
    expect(() => buildChange({ changeType: 'set_cardio_minutes' })).toThrow();
    expect(() => buildChange({ changeType: 'delete_everything' })).toThrow();
  });

  it('treats a blank substitute as leave-it-to-the-rules', () => {
    expect(
      buildChange({
        changeType: 'swap_exercise',
        exerciseName: 'Goblet Squat',
        substituteName: '  ',
      }),
    ).toEqual({ kind: 'SWAP_EXERCISE', from: 'Goblet Squat' });
  });
});

describe('renderDiff', () => {
  it('localizes the exercise and day names the card shows', async () => {
    const labels = await loadToolLabels('zh-CN');

    const rows = renderDiff(labels, [
      {
        kind: 'exercise',
        dayOfWeek: 1,
        dayName: 'Full Body A',
        before: 'Goblet Squat',
        after: 'Leg Press',
      },
      { kind: 'trainingDay', before: 3, after: 4 },
      { kind: 'cardio', before: 90, after: 45, days: [3] },
    ]);

    expect(rows[0]).toEqual({ label: '周一 · 全身 A', before: '高脚杯深蹲', after: '腿举' });
    expect(rows[1]).toEqual({ label: '训练日', before: '周三', after: '周四' });
    expect(rows[2]).toEqual({ label: '每周有氧', before: '90 分钟', after: '45 分钟' });
  });
});

describe('propose_plan_change', () => {
  it('records a proposal and tells the model the plan has not changed', async () => {
    const propose = vi.fn(async () => ({ id: 'proposal_9', created: true }));
    const result = await tool({ propose }).execute('call_1', {
      changeType: 'swap_exercise',
      exerciseName: '高脚杯深蹲',
    });

    expect(propose).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user_1',
        conversationId: 'conversation_1',
        kind: 'SWAP_EXERCISE',
        basePlanId: 'plan_1',
        change: expect.objectContaining({ kind: 'SWAP_EXERCISE', from: 'Goblet Squat' }),
        diff: [expect.objectContaining({ before: '高脚杯深蹲' })],
      }),
    );
    expect(textOf(result)).toContain('还没有生效');
    expect(result.details).toEqual({ proposalId: 'proposal_9', kind: 'SWAP_EXERCISE' });
  });

  it('explains a refusal instead of proposing something the rules rejected', async () => {
    const propose = vi.fn();

    await expect(
      tool({ propose }).execute('call_1', {
        changeType: 'swap_exercise',
        exerciseName: 'Barbell Clean',
      }),
    ).rejects.toThrow(/not in the active plan/);
    expect(propose).not.toHaveBeenCalled();
  });

  it('says so plainly when there is no plan to change', async () => {
    const propose = vi.fn();
    const toolWithoutPlan = createPlanChangeTool(
      { userId: 'user_1', locale: 'zh-CN' },
      { loadActivePlan: async () => null, loadConstraints: async () => constraints },
      store({ propose }),
    );

    const result = await toolWithoutPlan.execute('call_1', {
      changeType: 'set_cardio_minutes',
      cardioMinutes: 30,
    });

    expect(textOf(result)).toContain('还没有生效的方案');
    expect(propose).not.toHaveBeenCalled();
  });

  it('exposes no model-controlled identifier', () => {
    const parameters = tool().parameters;

    expect(Object.keys(parameters.properties ?? {})).toEqual([
      'changeType',
      'exerciseName',
      'substituteName',
      'fromWeekday',
      'toWeekday',
      'cardioMinutes',
    ]);
    expect(JSON.stringify(parameters)).not.toContain('userId');
  });

  it('carries a move through with both weekdays', async () => {
    const propose = vi.fn(async () => ({ id: 'proposal_2', created: true }));
    await tool({ propose }).execute('call_1', {
      changeType: 'move_training_day',
      fromWeekday: 1,
      toWeekday: 2,
    });

    expect(propose).toHaveBeenCalledWith(
      expect.objectContaining({
        change: { kind: 'MOVE_TRAINING_DAY', from: 1, to: 2 },
        diff: [{ label: '训练日', before: '周一', after: '周二' }],
      }),
    );
  });

  it('reports the cardio total the plan will land on', async () => {
    const propose = vi.fn(async (_input: unknown) => ({ id: 'proposal_3', created: true }));
    await tool({ propose }).execute('call_1', {
      changeType: 'set_cardio_minutes',
      cardioMinutes: 45,
    });

    const call = propose.mock.calls[0]?.[0] as unknown as { diff: { after: string }[] };
    expect(call.diff[0]?.after).toBe('45 分钟');
  });

  it('accepts the movement the plan itself lists', async () => {
    const parsed = parseFitnessPlanContent(planContent());
    const firstExercise = parsed.strength.days[0]?.exercises[0]?.name ?? '';

    await expect(
      tool().execute('call_1', { changeType: 'swap_exercise', exerciseName: firstExercise }),
    ).resolves.toBeDefined();
  });
});
