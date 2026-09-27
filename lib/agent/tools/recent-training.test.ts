import { describe, expect, it, vi } from 'vitest';
import { loadToolLabels } from './labels';
import {
  createRecentTrainingTool,
  summarizeRecentTraining,
  type RecentSession,
} from './recent-training';
import { SUMMARY_CHAR_LIMIT } from './summary';

function session(overrides: Partial<RecentSession> = {}): RecentSession {
  return {
    startedAt: new Date('2026-09-18T10:00:00.000Z'),
    finishedAt: new Date('2026-09-18T10:52:00.000Z'),
    workoutName: 'Full Body A',
    sets: [
      { weight: 24, reps: 10, durationSec: null, distanceM: null, isWarmup: false, exercise: { name: 'Goblet Squat', category: 'COMPOUND' } },
      { weight: 24, reps: 8, durationSec: null, distanceM: null, isWarmup: false, exercise: { name: 'Goblet Squat', category: 'COMPOUND' } },
      { weight: 18, reps: 9, durationSec: null, distanceM: null, isWarmup: false, exercise: { name: 'Lat Pulldown', category: 'COMPOUND' } },
    ],
    ...overrides,
  };
}

describe('summarizeRecentTraining', () => {
  it('reports the heaviest working set per exercise with localized names', async () => {
    const labels = await loadToolLabels('zh-CN');
    const text = summarizeRecentTraining(labels, [session()], 'Asia/Shanghai');

    expect(text).toContain('最近 1 次已完成的训练');
    expect(text).toContain('2026/09/18');
    expect(text).toContain('全身 A');
    expect(text).toContain('52 分钟');
    expect(text).toContain('高脚杯深蹲：2 组，最重 24 公斤 × 10 次');
    expect(text).toContain('高位下拉：1 组，最重 18 公斤 × 9 次');
  });

  it('passes a custom exercise name through untouched', async () => {
    const labels = await loadToolLabels('zh-CN');
    const text = summarizeRecentTraining(
      labels,
      [
        session({
          sets: [
            { weight: 30, reps: 8, durationSec: null, distanceM: null, isWarmup: false, exercise: { name: '我自己的动作', category: 'COMPOUND' } },
          ],
        }),
      ],
      'Asia/Shanghai',
    );

    expect(text).toContain('我自己的动作：1 组，最重 30 公斤 × 8 次');
  });

  it('ties on weight go to the set with more reps', async () => {
    const labels = await loadToolLabels('zh-CN');
    const text = summarizeRecentTraining(
      labels,
      [
        session({
          sets: [
            { weight: 20, reps: 6, durationSec: null, distanceM: null, isWarmup: false, exercise: { name: 'Goblet Squat', category: 'COMPOUND' } },
            { weight: 20, reps: 12, durationSec: null, distanceM: null, isWarmup: false, exercise: { name: 'Goblet Squat', category: 'COMPOUND' } },
          ],
        }),
      ],
      'Asia/Shanghai',
    );

    expect(text).toContain('最重 20 公斤 × 12 次');
  });

  it('describes a cardio-only session without inventing exercises', async () => {
    const labels = await loadToolLabels('zh-CN');
    const text = summarizeRecentTraining(
      labels,
      [
        session({
          workoutName: null,
          sets: [
            { weight: 0, reps: 0, durationSec: 1800, distanceM: 5200, isWarmup: false, exercise: { name: 'Treadmill', category: 'CARDIO' } },
          ],
        }),
      ],
      'Asia/Shanghai',
    );

    expect(text).toContain('有氧 30 分钟');
    expect(text).toContain('5.2 公里');
    expect(text).not.toContain('0 个动作');
  });

  it('reports bodyweight work as reps rather than invented load', async () => {
    const labels = await loadToolLabels('zh-CN');
    const text = summarizeRecentTraining(
      labels,
      [
        session({
          sets: [
            { weight: 0, reps: 9, durationSec: null, distanceM: null, isWarmup: false, exercise: { name: 'Pull-up', category: 'COMPOUND' } },
          ],
        }),
      ],
      'Asia/Shanghai',
    );

    expect(text).toContain('最重 9 次自重');
  });

  it('states plainly that nothing is recorded yet', async () => {
    const labels = await loadToolLabels('zh-CN');

    expect(summarizeRecentTraining(labels, [], 'Asia/Shanghai')).toContain('还没有已完成的训练记录');
  });

  it('stays inside the summary budget with many sessions', async () => {
    const labels = await loadToolLabels('zh-CN');
    const many = Array.from({ length: 10 }, () => session());
    const text = summarizeRecentTraining(labels, many, 'Asia/Shanghai');

    expect(text.length).toBeLessThanOrEqual(SUMMARY_CHAR_LIMIT);
  });
});

describe('createRecentTrainingTool', () => {
  it('defaults to three sessions and forwards an explicit limit', async () => {
    const loadHistory = vi.fn(async () => ({ timeZone: 'Asia/Shanghai', sessions: [] }));
    const tool = createRecentTrainingTool(
      { userId: 'user_1', locale: 'zh-CN' },
      { loadHistory },
    );

    await tool.execute('call_1', {});
    await tool.execute('call_2', { limit: 7 });

    expect(loadHistory).toHaveBeenNthCalledWith(1, 'user_1', 3);
    expect(loadHistory).toHaveBeenNthCalledWith(2, 'user_1', 7);
  });

  it('exposes no model-controlled identifier', () => {
    const tool = createRecentTrainingTool(
      { userId: 'user_1', locale: 'zh-CN' },
      { loadHistory: async () => ({ timeZone: 'UTC', sessions: [] }) },
    );

    expect(tool.name).toBe('get_recent_training');
    expect(Object.keys(tool.parameters.properties ?? {})).toEqual(['limit']);
    expect(JSON.stringify(tool.parameters)).not.toContain('userId');
  });
});
