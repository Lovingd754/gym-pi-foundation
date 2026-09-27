import { expect, it } from 'vitest';
import { advanceTask, taskAfterTool, taskSkill, parseTaskState } from './task-state';
import { buildSystemPrompt } from './system-prompt';
it('collects a partial log and merges a slot-only follow-up', () => {
  const state = advanceTask(null, '记录卧推60kg', 'log');
  expect(state?.missing).toEqual(['reps', 'sets']);
  expect(taskSkill(state, '8次3组')).toBe('log');
  const filled = advanceTask(state, '8次3组', 'general');
  expect(filled?.fields).toMatchObject({
    exerciseName: '卧推',
    weight: 60,
    weightUnit: 'KG',
    reps: 8,
    sets: 3,
  });
  expect(filled?.missing).toEqual([]);
});
it('marks correction unresolved until a successful proposal replaces it', () => {
  const pending = taskAfterTool(
    advanceTask(null, '记录卧推60kg8次3组', 'log'),
    'log_workout',
    { exerciseName: '卧推', weight: 60, reps: 8, sets: 3 },
    { proposalId: 'old' },
  );
  const correction = advanceTask(pending, '刚才改成55kg', 'general');
  expect(correction).toMatchObject({
    phase: 'NEEDS_REVISION',
    fields: { weight: 55 },
    pending: { id: 'old' },
  });
  expect(taskSkill(pending, '刚才改成55kg')).toBe('log');
  expect(taskAfterTool(correction, 'log_workout', {}, { proposalId: null })).toEqual(correction);
  expect(
    taskAfterTool(correction, 'log_workout', { weight: 55 }, { proposalId: 'new' }),
  ).toMatchObject({
    phase: 'PENDING_CONFIRMATION',
    pending: { id: 'new' },
    fields: { weight: 55 },
  });
  expect(buildSystemPrompt(null, [], 'log', correction)).toContain(
    'old proposal has NOT been corrected',
  );
});
it('does not reuse log slots for a new explicit log or steal a plan correction', () => {
  const old = advanceTask(null, '记录卧推60kg8次3组', 'log');
  expect(advanceTask(old, '记录深蹲', 'log')?.missing).toContain('weight');
  expect(taskSkill(old, '有氧改成60分钟')).toBeNull();
  expect(taskSkill(old, '刚才改成55kg合适吗？')).toBeNull();
  expect(advanceTask(old, '腿举80kg8次3组', 'log')?.missing).toContain('exerciseName');
  expect(advanceTask(null, '记录卧推-60kg', 'log')?.fields.weight).toBe(-60);
  expect(parseTaskState({ kind: 'invented' })).toBeNull();
});
it('only tracks pending memories, never reclassifies an ACTIVE memory as pending', () => {
  expect(
    taskAfterTool(
      null,
      'propose_memory',
      { content: 'Preference' },
      { memoryId: 'm', status: 'ACTIVE' },
    ),
  ).toBeNull();
  expect(
    taskAfterTool(
      null,
      'propose_memory',
      { content: 'Preference' },
      { memoryId: 'm', status: 'PENDING' },
    )?.kind,
  ).toBe('memory');
  const pending = taskAfterTool(
    null,
    'propose_memory',
    { content: 'Preference' },
    { memoryId: 'm', status: 'PENDING' },
  );
  expect(advanceTask(pending, '偏好改成哑铃', 'general')?.phase).toBe('NEEDS_REVISION');
});
