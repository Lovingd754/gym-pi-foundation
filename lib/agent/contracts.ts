import type { AgentSkill } from './skills';

export type FitnessAgentRunKind = 'chat' | 'weekly-review';

// Every tool the agent can be given. The list is here, next to the run contract,
// because a run's tool set is part of what the run was: skills narrow it.
export type FitnessAgentToolName =
  | 'get_current_plan'
  | 'get_recent_training'
  | 'get_memories'
  | 'propose_memory'
  | 'propose_plan_change'
  | 'log_workout';

export type FitnessAgentStopReason =
  | 'completed'
  | 'cancelled'
  | 'timeout'
  | 'model-limit'
  | 'tool-limit'
  | 'safety-stop'
  | 'error';

export type FitnessAgentStreamEvent =
  // What the turn was understood to be, emitted before the model runs so the
  // interface can show the agent's own reading of the request as it works.
  | { type: 'intent'; skill: AgentSkill; routedBy: 'RULE' | 'MODEL' | 'FALLBACK' }
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-start'; toolCallId: string; toolName: string }
  | { type: 'tool-end'; toolCallId: string; toolName: string; isError: boolean }
  | { type: 'run-end'; stopReason: FitnessAgentStopReason };

export interface FitnessAgentRunInput {
  runId: string;
  kind: FitnessAgentRunKind;
  userId: string;
  conversationId?: string;
  // Already persisted by the caller; omitted from history before prompt().
  currentMessageId?: string;
  sessionId?: string;
  // The interface language the trainee is reading. Tool summaries are written
  // in it so the model answers in the trainee's own vocabulary.
  locale?: string;
  message: string;
  signal?: AbortSignal;
}

export interface FitnessAgentRunResult {
  text: string;
  stopReason: FitnessAgentStopReason;
  modelTurns: number;
  toolCalls: number;
  provider: string;
  model: string;
  // What the run cost in tokens, summed over its model turns. Reported by the
  // provider, so a deployment without cost metadata still gets the counts.
  usage: FitnessAgentUsage;
  // The skill the turn was routed to, and who decided: a rule, the model, or the
  // fallback. Recorded so a misroute is a measurable event, not a mystery.
  skill: AgentSkill;
  routedBy: 'RULE' | 'MODEL' | 'FALLBACK';
}

export interface FitnessAgentUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  // Cost as reported by the provider, in millionths of a US dollar: an integer
  // so money is never a float. Zero when the provider has no price table.
  costMicroUsd: number;
}

export const EMPTY_AGENT_USAGE: FitnessAgentUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  totalTokens: 0,
  costMicroUsd: 0,
});

export type FitnessAgentEventSink = (event: FitnessAgentStreamEvent) => void | Promise<void>;

export interface FitnessAgentRuntime {
  run(input: FitnessAgentRunInput, emit?: FitnessAgentEventSink): Promise<FitnessAgentRunResult>;
}
