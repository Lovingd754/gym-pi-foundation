import { describe, expect, it, vi } from 'vitest';
import { STRENGTH_EXERCISE_CATALOG } from './exercise-catalog';
import {
  NEUTRAL_STRATEGY,
  buildStrategyPrompt,
  extractStrategyJson,
  parseStrategy,
  requestPlanStrategy,
} from './plan-strategy';

describe('parseStrategy', () => {
  it('keeps the keys the catalog knows and drops the rest', () => {
    const strategy = parseStrategy({
      avoid: ['back_squat', 'not_a_real_exercise', 42],
      prefer: ['leg_press', 'back_squat'],
      cardio: 'MINIMAL',
      rationale: '  膝盖不舒服，换成腿举。 ',
    });

    expect(strategy.avoidCatalogKeys).toEqual(['back_squat']);
    // An avoided movement is never also preferred.
    expect(strategy.preferCatalogKeys).toEqual(['leg_press']);
    expect(strategy.cardioPreference).toBe('MINIMAL');
    expect(strategy.rationale).toBe('膝盖不舒服，换成腿举。');
    expect(strategy.source).toBe('MODEL');
  });

  it('falls back to STANDARD for a stance it does not recognize', () => {
    expect(parseStrategy({ cardio: 'EXTREME' }).cardioPreference).toBe('STANDARD');
  });

  it('treats an empty or unusable answer as the neutral strategy', () => {
    expect(parseStrategy({})).toEqual(NEUTRAL_STRATEGY);
    expect(parseStrategy(null)).toEqual(NEUTRAL_STRATEGY);
    expect(parseStrategy('nonsense')).toEqual(NEUTRAL_STRATEGY);
  });

  it('bounds the rationale', () => {
    const strategy = parseStrategy({ rationale: '字'.repeat(500) });

    expect(strategy.rationale?.length).toBeLessThanOrEqual(240);
  });

  it('reads back the stored shape as well as the model shape', () => {
    const stored = {
      avoidCatalogKeys: ['back_squat'],
      preferCatalogKeys: ['leg_press'],
      cardioPreference: 'MORE',
      rationale: 'x',
      source: 'MODEL',
    };

    expect(parseStrategy(stored)).toEqual({
      avoidCatalogKeys: ['back_squat'],
      preferCatalogKeys: ['leg_press'],
      cardioPreference: 'MORE',
      rationale: 'x',
      source: 'MODEL',
    });
  });
});

describe('buildStrategyPrompt', () => {
  it('lists the catalog so the model can only name real keys', () => {
    const prompt = buildStrategyPrompt({
      goalType: 'FAT_LOSS',
      weeklyFrequency: 3,
      trainingAgeMonths: 3,
      equipmentTypes: ['DUMBBELL'],
      softConstraints: '膝盖怕深蹲',
      safetyNotes: [],
    });

    expect(prompt.system).toContain('PLAN-STRATEGY');
    for (const entry of STRENGTH_EXERCISE_CATALOG) {
      expect(prompt.system).toContain(entry.key);
    }
    expect(prompt.system).toContain('Never invent sets, reps, calories');
    expect(prompt.messages[0]?.content).toContain('膝盖怕深蹲');
  });
});

describe('extractStrategyJson', () => {
  it('reads a bare object, a fenced object, and gives up on prose', () => {
    expect(extractStrategyJson('{"cardio":"MORE"}')).toEqual({ cardio: 'MORE' });
    expect(extractStrategyJson('```json\n{"cardio":"MORE"}\n```')).toEqual({ cardio: 'MORE' });
    expect(extractStrategyJson('I think you should train more.')).toBeNull();
  });
});

describe('requestPlanStrategy', () => {
  const input = {
    goalType: 'FAT_LOSS',
    weeklyFrequency: 3 as const,
    trainingAgeMonths: 3,
    equipmentTypes: ['DUMBBELL'],
    softConstraints: '膝盖怕深蹲',
    safetyNotes: [],
  };

  it('returns the parsed strategy', async () => {
    const complete = vi.fn(async () => '```json\n{"avoid":["back_squat"],"cardio":"MINIMAL"}\n```');

    const strategy = await requestPlanStrategy(input, { complete });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(strategy.avoidCatalogKeys).toEqual(['back_squat']);
    expect(strategy.source).toBe('MODEL');
  });

  it('still asks when the trainee said nothing, and stays neutral if the answer is empty', async () => {
    const complete = vi.fn(async () => '{"avoid":[],"prefer":[],"cardio":"STANDARD"}');

    const strategy = await requestPlanStrategy(
      { ...input, softConstraints: '   ', safetyNotes: [] },
      { complete },
    );

    // Building a plan is a decision the assistant is expected to be part of, so
    // the call happens even with nothing to interpret...
    expect(complete).toHaveBeenCalledTimes(1);
    // ...and an empty strategy is a valid answer that changes nothing.
    expect(strategy).toEqual(NEUTRAL_STRATEGY);
  });

  it('falls back to neutral when the provider fails', async () => {
    const strategy = await requestPlanStrategy(input, {
      complete: async () => {
        throw new Error('provider down');
      },
    });

    expect(strategy).toEqual(NEUTRAL_STRATEGY);
  });

  it('falls back to neutral when the model answers with prose', async () => {
    const strategy = await requestPlanStrategy(input, {
      complete: async () => 'Sure! I would avoid squats.',
    });

    expect(strategy).toEqual(NEUTRAL_STRATEGY);
  });
});
