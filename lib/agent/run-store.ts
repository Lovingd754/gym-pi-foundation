import { db } from '@/lib/db';
import { hashAuditValue } from './audit-hash';
import type { FitnessAgentRunKind, FitnessAgentStopReason, FitnessAgentUsage } from './contracts';

export type StoredRunStatus = 'completed' | 'degraded' | 'cancelled' | 'failed';
export type StoredToolStatus = 'succeeded' | 'failed' | 'blocked';

export interface AgentRunStore {
  startRun(input: {
    runId: string;
    userId: string;
    conversationId?: string;
    kind: FitnessAgentRunKind;
    provider: string;
    model: string;
    input: unknown;
  }): Promise<void>;
  configureRun(input: {
    runId: string;
    conversationId?: string;
    provider: string;
    model: string;
  }): Promise<void>;
  startTool(input: {
    runId: string;
    toolCallId: string;
    toolName: string;
    args: unknown;
    authorizationAllowed: boolean;
  }): Promise<void>;
  finishTool(input: {
    runId: string;
    toolCallId: string;
    status: StoredToolStatus;
    durationMs: number;
    result?: unknown;
    errorCode?: string;
  }): Promise<void>;
  finishRun(input: {
    runId: string;
    status: StoredRunStatus;
    stopReason: FitnessAgentStopReason;
    modelTurns: number;
    toolCalls: number;
    usage: FitnessAgentUsage;
    errorCode?: string;
  }): Promise<void>;
}

const runKind = {
  chat: 'CHAT',
  'weekly-review': 'WEEKLY_REVIEW',
} as const;

const runStatus = {
  completed: 'COMPLETED',
  degraded: 'DEGRADED',
  cancelled: 'CANCELLED',
  failed: 'FAILED',
} as const;

const stopReason = {
  completed: 'COMPLETED',
  cancelled: 'CANCELLED',
  timeout: 'TIMEOUT',
  'model-limit': 'MODEL_LIMIT',
  'tool-limit': 'TOOL_LIMIT',
  'safety-stop': 'SAFETY_STOP',
  error: 'ERROR',
} as const;

const toolStatus = {
  succeeded: 'SUCCEEDED',
  failed: 'FAILED',
  blocked: 'BLOCKED',
} as const;

export const prismaAgentRunStore: AgentRunStore = {
  async startRun(input) {
    await db.agentRun.create({
      data: {
        id: input.runId,
        userId: input.userId,
        conversationId: input.conversationId,
        kind: runKind[input.kind],
        runtimeVersion: 'pi-agent-core@0.85.1',
        provider: input.provider,
        model: input.model,
        inputHash: hashAuditValue(input.input),
      },
    });
  },

  async configureRun(input) {
    await db.agentRun.update({
      where: { id: input.runId },
      data: {
        conversationId: input.conversationId,
        provider: input.provider,
        model: input.model,
      },
    });
  },

  async startTool(input) {
    await db.toolInvocation.upsert({
      where: {
        runId_toolCallId: {
          runId: input.runId,
          toolCallId: input.toolCallId,
        },
      },
      update: {},
      create: {
        runId: input.runId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        argsHash: hashAuditValue(input.args),
        authorizationAllowed: input.authorizationAllowed,
      },
    });
  },

  async finishTool(input) {
    await db.toolInvocation.update({
      where: {
        runId_toolCallId: {
          runId: input.runId,
          toolCallId: input.toolCallId,
        },
      },
      data: {
        status: toolStatus[input.status],
        durationMs: input.durationMs,
        resultHash: input.result === undefined ? undefined : hashAuditValue(input.result),
        errorCode: input.errorCode,
      },
    });
  },

  async finishRun(input) {
    await db.agentRun.update({
      where: { id: input.runId },
      data: {
        status: runStatus[input.status],
        stopReason: stopReason[input.stopReason],
        modelTurns: input.modelTurns,
        toolCalls: input.toolCalls,
        // What the run cost. Recorded per run so spend stays observable without
        // asking the provider afterwards.
        inputTokens: input.usage.inputTokens,
        outputTokens: input.usage.outputTokens,
        totalTokens: input.usage.totalTokens,
        costMicroUsd: input.usage.costMicroUsd,
        errorCode: input.errorCode,
        finishedAt: new Date(),
      },
    });
  },
};
