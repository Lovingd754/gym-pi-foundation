import { describe, expect, it, vi } from 'vitest';
import { buildBaselinePlan, type BaselinePlanInput } from '@/lib/fitness/baseline-plan';
import { evaluateEligibility } from '@/lib/fitness/eligibility';
import { STRENGTH_EXERCISE_CATALOG } from '@/lib/fitness/exercise-catalog';
import type { InitialLoadGuidance } from '@/lib/fitness/load-evidence';
import { parseFitnessPlanContent } from '@/lib/fitness/plan-schema';
import { createAssessmentInputSchema, type AssessmentInput } from '@/lib/fitness/schemas';
import {
  createCurrentPlanTool,
  isoWeekdayInTimeZone,
  summarizePlan,
  type CurrentPlanSnapshot,
} from './current-plan';
import { loadToolLabels } from './labels';
import { SUMMARY_CHAR_LIMIT } from './summary';

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

function guidance(): InitialLoadGuidance[] {
  return STRENGTH_EXERCISE_CATALOG.map((entry) =>
    entry.key === 'goblet_squat'
      ? { catalogKey: entry.key, source: 'USER_REPORTED' as const, initialLoadKg: 24 }
      : { catalogKey: entry.key, source: 'CALIBRATION' as const, initialLoadKg: null },
  );
}

function snapshot(): CurrentPlanSnapshot {
  const value = assessment();
  const input = {
    assessment: value,
    eligibility: evaluateEligibility(value, NOW),
    gymConstraints: { unavailableExerciseNames: [] },
    loadGuidance: guidance(),
    now: NOW,
  } satisfies BaselinePlanInput;

  return {
    version: 2,
    status: 'ACTIVE',
    activatedAt: new Date('2026-09-18T02:00:00.000Z'),
    goalType: 'FAT_LOSS',
    desiredWeeklyRatePct: -0.5,
    timeZone: 'Asia/Shanghai',
    content: parseFitnessPlanContent(buildBaselinePlan(input)),
  };
}

describe('summarizePlan', () => {
  it('writes a plain-language summary with no raw enum values or jargon', async () => {
    const labels = await loadToolLabels('zh-CN');
    const text = summarizePlan(labels, snapshot(), 1, NOW);

    expect(text).toContain('方案：');
    expect(text).toContain('减脂');
    expect(text).toContain('力量训练（');
    expect(text).toContain('饮食（每天）：');
    expect(text).toContain('睡眠：每晚 7–9 小时');
    // The trainee never sees these; neither should the model's source text.
    expect(text).not.toContain('FAT_LOSS');
    expect(text).not.toContain('FULL_BODY');
    expect(text).not.toContain('RIR');
    expect(text).not.toContain('HYPERTROPHY');
  });

  it('names the focus day the model asked about', async () => {
    const labels = await loadToolLabels('zh-CN');
    const text = summarizePlan(labels, snapshot(), 3, NOW);

    expect(text).toContain('周三的重点：');
  });

  it('stays inside the summary budget', async () => {
    const labels = await loadToolLabels('zh-CN');
    const text = summarizePlan(labels, snapshot(), 1, NOW);

    expect(text.length).toBeLessThanOrEqual(SUMMARY_CHAR_LIMIT);
  });

  it('answers in English for an English reader', async () => {
    const labels = await loadToolLabels('en');
    const text = summarizePlan(labels, snapshot(), 1, NOW);

    expect(text).toContain('Goal:');
    expect(text).toContain('Sleep: 7–9 h');
  });
});

describe('createCurrentPlanTool', () => {
  it('exposes no model-controlled identifier and declares parallel execution', async () => {
    const tool = createCurrentPlanTool(
      { userId: 'user_1', locale: 'zh-CN' },
      { loadSnapshot: async () => null },
      () => NOW,
    );

    expect(tool.name).toBe('get_current_plan');
    expect(tool.executionMode).toBe('parallel');
    expect(Object.keys(tool.parameters.properties ?? {})).toEqual(['dayOfWeek']);
    expect(JSON.stringify(tool.parameters)).not.toContain('userId');
  });

  it('says so plainly when no plan is active', async () => {
    const tool = createCurrentPlanTool(
      { userId: 'user_1', locale: 'zh-CN' },
      { loadSnapshot: async () => null },
      () => NOW,
    );

    const result = await tool.execute('call_1', {});
    const block = result.content[0];
    const text = block?.type === 'text' ? block.text : '';

    expect(text).toContain('还没有生效的个性化方案');
    expect(result.details).toEqual({ planVersion: null });
  });

  it('uses today in the plan time zone when no weekday is given', async () => {
    const loadSnapshot = vi.fn(async () => snapshot());
    const tool = createCurrentPlanTool(
      { userId: 'user_1', locale: 'zh-CN' },
      { loadSnapshot },
      () => NOW,
    );

    const result = await tool.execute('call_2', {});
    const block = result.content[0];
    const text = block?.type === 'text' ? block.text : '';

    expect(loadSnapshot).toHaveBeenCalledWith('user_1');
    // 2026-09-19 04:00 UTC is Saturday in Shanghai.
    expect(text).toContain('周六');
    expect(result.details).toEqual({ planVersion: 2 });
  });
});

describe('isoWeekdayInTimeZone', () => {
  it('resolves the local weekday across the date line', () => {
    const instant = new Date('2026-09-19T20:00:00.000Z');

    expect(isoWeekdayInTimeZone(instant, 'UTC')).toBe(6);
    expect(isoWeekdayInTimeZone(instant, 'Asia/Shanghai')).toBe(7);
  });

  it('falls back to UTC instead of throwing on a corrupt time zone', () => {
    expect(isoWeekdayInTimeZone(NOW, 'Not/AZone')).toBe(6);
  });
});
