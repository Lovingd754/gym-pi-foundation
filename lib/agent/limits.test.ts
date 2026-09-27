import { describe, expect, it } from 'vitest';
import { getAgentRunLimits } from './limits';

describe('agent run limits', () => {
  it('keeps generous runaway guards for interactive chat', () => {
    expect(getAgentRunLimits('chat')).toEqual({
      maxModelTurns: 16,
      maxToolCalls: 40,
      timeoutMs: 300_000,
    });
  });

  it('keeps generous runaway guards for the weekly review', () => {
    expect(getAgentRunLimits('weekly-review')).toEqual({
      maxModelTurns: 24,
      maxToolCalls: 60,
      timeoutMs: 600_000,
    });
  });

  it('returns immutable objects', () => {
    expect(Object.isFrozen(getAgentRunLimits('chat'))).toBe(true);
    expect(Object.isFrozen(getAgentRunLimits('weekly-review'))).toBe(true);
  });
});
