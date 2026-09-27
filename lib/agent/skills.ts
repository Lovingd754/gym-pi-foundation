import type { FitnessAgentToolName } from './contracts';

// ============================================================
// Skills: one capability, one prompt fragment, one set of tools
// ============================================================
// The agent used to answer every turn with the whole rulebook and every tool it
// owns. That works, and it costs: the plans/rules for changing a plan, logging a
// set and answering a question are all in the window even when only one of them
// applies, and a model choosing between six tools has more ways to choose wrong
// than one choosing between five.
//
// A skill is the narrow version of that: the rules a capability needs, plus the
// proposal tools it is allowed to reach for. It is deliberately thin - three
// skills and a fallback - because the evidence that this is worth its weight is
// a token measurement, not an argument.
//
// Two rules keep a misroute cheap:
//   - Read tools are always available. Answering with too much context is
//     recoverable; a turn that cannot read the plan is not.
//   - propose_memory is always available too. It cannot change anything - it
//     writes a pending note the trainee accepts or dismisses - so gating it
//     would only lose the fact they just told us.
// What a skill actually gates is the two tools that touch real data:
// log_workout and propose_plan_change.

export const AGENT_SKILL_IDS = ['log', 'plan', 'review'] as const;

export type RoutedSkillId = (typeof AGENT_SKILL_IDS)[number];
// 'general' is the fallback: every tool, every rule - the behaviour the agent
// had before skills existed. A turn that cannot be classified runs here.
export type AgentSkill = RoutedSkillId | 'general';

export const ALWAYS_AVAILABLE_TOOLS: readonly FitnessAgentToolName[] = Object.freeze([
  'get_current_plan',
  'get_recent_training',
  'get_memories',
  'propose_memory',
]);

const PROPOSAL_TOOLS: Record<AgentSkill, readonly FitnessAgentToolName[]> = Object.freeze({
  log: ['log_workout'],
  plan: ['propose_plan_change'],
  review: [],
  general: ['log_workout', 'propose_plan_change'],
});

export function toolsForSkill(skill: AgentSkill): readonly FitnessAgentToolName[] {
  return [...ALWAYS_AVAILABLE_TOOLS, ...PROPOSAL_TOOLS[skill]];
}

// Names the interface can show while a turn is running ("已识别：调整计划").
export const SKILL_LABELS: Record<AgentSkill, string> = Object.freeze({
  log: '记录训练',
  plan: '调整计划',
  review: '查询复盘',
  general: '综合处理',
});

export { skillPrompt } from './system-prompt';
