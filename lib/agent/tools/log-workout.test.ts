import { describe, expect, it, vi } from 'vitest';
import type { LogProposalStore } from '../log-proposals';
import { createLogWorkoutTool, resolveExercise } from './log-workout';

const EXERCISES = [
  { id: 'ex_bench', name: 'Bench Press' },
  { id: 'ex_squat', name: 'Back Squat' },
  { id: 'ex_row', name: 'One-arm Dumbbell Row' },
];

function store(overrides: Partial<LogProposalStore> = {}): LogProposalStore {
  return {
    propose: vi.fn(async () => ({ id: 'log_1' })),
    list: vi.fn(async () => []),
    loadPending: vi.fn(async () => null),
    markApplied: vi.fn(async () => {}),
    dismiss: vi.fn(async () => true),
    ...overrides,
  };
}

function tool(
  overrides: Partial<LogProposalStore> = {},
  unit: 'KG' | 'LB' = 'KG',
  exercises = EXERCISES,
) {
  return createLogWorkoutTool(
    { userId: 'user_1', conversationId: 'conversation_1', locale: 'zh-CN' },
    {
      loadExercises: async () => exercises,
      loadUnit: async () => unit,
    },
    store(overrides),
  );
}

function textOf(result: { content: unknown }): string {
  const [block] = result.content as Array<{ type: string; text?: string }>;
  return block?.text ?? '';
}

describe('resolveExercise', () => {
  it('matches the stored name', () => {
    expect(resolveExercise(EXERCISES, 'Bench Press', 'zh-CN')?.id).toBe('ex_bench');
  });

  it('matches the name the trainee actually reads', () => {
    // The catalog row is "Bench Press"; a Chinese trainee types 卧推.
    expect(resolveExercise(EXERCISES, '卧推', 'zh-CN')?.id).toBe('ex_bench');
  });

  it('accepts an unambiguous partial name', () => {
    expect(resolveExercise(EXERCISES, '深蹲', 'zh-CN')?.id).toBe('ex_squat');
  });

  it('refuses an ambiguous or unknown name rather than guessing', () => {
    // Two movements contain 推, so the short form tells us nothing.
    const ambiguous = [...EXERCISES, { id: 'ex_db_bench', name: 'Dumbbell Bench Press' }];
    expect(resolveExercise(ambiguous, '推', 'zh-CN')).toBeNull();
    expect(resolveExercise(EXERCISES, 'Barbell Clean', 'zh-CN')).toBeNull();
    expect(resolveExercise(EXERCISES, '  ', 'zh-CN')).toBeNull();
  });
});

describe('log_workout', () => {
  it('prepares the entry and says nothing is saved yet', async () => {
    const propose = vi.fn(async () => ({ id: 'log_9' }));
    const result = await tool({ propose }).execute('call_1', {
      exerciseName: '卧推',
      weight: 60,
      reps: 8,
      sets: 3,
    });

    expect(propose).toHaveBeenCalledWith({
      userId: 'user_1',
      conversationId: 'conversation_1',
      entry: { exerciseId: 'ex_bench', weight: 60, reps: 8, sets: 3, rir: null },
      summary: [
        { label: '动作', value: '卧推' },
        { label: '每组', value: '60 kg × 8' },
        { label: '组数', value: '3' },
      ],
    });
    expect(textOf(result)).toContain('还没有保存');
    expect(result.details).toEqual({ proposalId: 'log_9' });
  });

  it('converts the trainee unit into the kilograms the app stores', async () => {
    const propose = vi.fn(async (_input: unknown) => ({ id: 'log_lb' }));
    await tool({ propose }, 'LB').execute('call_1', {
      exerciseName: 'Bench Press',
      weight: 135,
      reps: 5,
      sets: 3,
    });

    const call = propose.mock.calls[0]?.[0] as unknown as { entry: { weight: number } };
    // 135 lb is 61.2 kg, to the nearest half kilo the app rounds to.
    expect(call.entry.weight).toBeCloseTo(61.2, 1);
  });

  it('carries the effort cue through when the trainee gave one', async () => {
    const propose = vi.fn(async (_input: unknown) => ({ id: 'log_rir' }));
    const result = await tool({ propose }).execute('call_1', {
      exerciseName: 'Bench Press',
      weight: 60,
      reps: 8,
      sets: 3,
      rir: 2,
    });

    const call = propose.mock.calls[0]?.[0] as unknown as {
      entry: { rir: number | null };
      summary: { label: string }[];
    };
    expect(call.entry.rir).toBe(2);
    expect(call.summary.map((row) => row.label)).toContain('余力');
    expect(textOf(result)).toContain('留 2 次余力');
  });

  it('prepares nothing when the movement is not in the catalog', async () => {
    const propose = vi.fn();
    const result = await tool({ propose }).execute('call_1', {
      exerciseName: 'Barbell Clean',
      weight: 60,
      reps: 5,
      sets: 3,
    });

    expect(propose).not.toHaveBeenCalled();
    expect(textOf(result)).toContain('动作库里');
    expect(result.details).toEqual({ proposalId: null });
  });

  it('exposes no model-controlled identifier and no kg conversion duty', () => {
    const parameters = tool().parameters;

    expect(Object.keys(parameters.properties ?? {})).toEqual([
      'exerciseName',
      'weight',
      'reps',
      'sets',
      'rir',
    ]);
    expect(JSON.stringify(parameters)).not.toContain('userId');
  });
});
