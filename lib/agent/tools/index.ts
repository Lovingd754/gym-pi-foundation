import type { AgentTool } from '@earendil-works/pi-agent-core';
import { createCurrentPlanTool } from './current-plan';
import { createMemoriesTool, createProposeMemoryTool } from './memories';
import { createPlanChangeTool } from './plan-change';
import { createLogWorkoutTool } from './log-workout';
import { createRecentTrainingTool } from './recent-training';
import type { SummaryToolContext } from './summary';

export { SUMMARY_CHAR_LIMIT } from './summary';

// Tool scope is captured per run from the authenticated request. Nothing the
// model produces can widen it: `userId` never appears in a tool schema.
export interface FitnessAgentToolScope {
  userId: string;
  sessionId?: string;
  conversationId?: string;
  locale?: string;
}

// The product's target language. A caller that forgets to pass the request
// locale gets Chinese labels rather than raw enum values.
export const DEFAULT_TOOL_LOCALE = 'zh-CN';

export function createFitnessAgentTools(scope: FitnessAgentToolScope): AgentTool[] {
  const context: SummaryToolContext = {
    userId: scope.userId,
    sessionId: scope.sessionId,
    conversationId: scope.conversationId,
    locale: scope.locale ?? DEFAULT_TOOL_LOCALE,
  };

  return [
    createCurrentPlanTool(context),
    createRecentTrainingTool(context),
    createMemoriesTool(context),
    createProposeMemoryTool(context),
    createPlanChangeTool(context),
    createLogWorkoutTool(context),
  ];
}
