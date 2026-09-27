import type { FitnessAgentRunKind } from './contracts';

// These are runaway guards, not usage quotas. Model spend is deliberately
// unmetered for this demo: the numbers only exist so a looping agent cannot
// burn a request forever. They must never be surfaced to the user as an
// allowance or a plan tier.
export interface AgentRunLimits {
  readonly maxModelTurns: number;
  readonly maxToolCalls: number;
  readonly timeoutMs: number;
}

const CHAT_GUARDS = Object.freeze({
  maxModelTurns: 16,
  maxToolCalls: 40,
  timeoutMs: 300_000,
});

const WEEKLY_REVIEW_GUARDS = Object.freeze({
  maxModelTurns: 24,
  maxToolCalls: 60,
  timeoutMs: 600_000,
});

export function getAgentRunLimits(kind: FitnessAgentRunKind): AgentRunLimits {
  return kind === 'weekly-review' ? WEEKLY_REVIEW_GUARDS : CHAT_GUARDS;
}
