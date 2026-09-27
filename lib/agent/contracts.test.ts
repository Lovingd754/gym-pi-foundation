import { describe, expectTypeOf, it } from 'vitest';
import type {
  FitnessAgentRunInput,
  FitnessAgentRunResult,
  FitnessAgentRuntime,
  FitnessAgentStreamEvent,
} from './contracts';

describe('FitnessAgentRuntime contract', () => {
  it('does not expose Pi types to application callers', () => {
    expectTypeOf<FitnessAgentRuntime['run']>().toBeFunction();
    expectTypeOf<FitnessAgentRunInput>().toHaveProperty('userId');
    expectTypeOf<FitnessAgentRunResult>().toHaveProperty('stopReason');
    expectTypeOf<FitnessAgentStreamEvent>().toMatchTypeOf<
      | { type: 'intent'; skill: string; routedBy: string }
      | { type: 'text-delta'; delta: string }
      | { type: 'tool-start'; toolCallId: string; toolName: string }
      | { type: 'tool-end'; toolCallId: string; toolName: string; isError: boolean }
      | { type: 'run-end'; stopReason: string }
    >();
  });
});
