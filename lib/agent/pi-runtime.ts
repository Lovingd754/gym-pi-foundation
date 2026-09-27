import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
} from '@earendil-works/pi-agent-core';
import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai';
import {
  AgentContextError,
  loadConversationContext,
  toPiMessages,
  type ConversationContext,
} from './context';
import type {
  FitnessAgentEventSink,
  FitnessAgentRunInput,
  FitnessAgentRunResult,
  FitnessAgentRuntime,
  FitnessAgentStopReason,
  FitnessAgentUsage,
} from './contracts';
import { EMPTY_AGENT_USAGE } from './contracts';
import { getAgentRunLimits } from './limits';
import { routeIntent, type IntentRoute } from './intent';
import { toolsForSkill, type AgentSkill } from './skills';
import {
  AgentConfigurationError,
  getAgentModelRequest,
  resolveAgentModel,
  type AgentModelRequest,
} from './models';
import { prismaAgentRunStore, type AgentRunStore, type StoredRunStatus } from './run-store';
import { buildSystemPrompt } from './system-prompt';
import { createFitnessAgentTools, type FitnessAgentToolScope } from './tools';
import { advanceTask, taskAfterTool, taskSkill, type AgentTaskState } from './task-state';
import { prismaTaskStateStore, type TaskStateStore } from './task-state-store';

interface RuntimeModel {
  model: Model<Api>;
  streamFn: StreamFn;
}

interface PiRuntimeDependencies {
  // The trainee's model choice is read here, once per run, so a run's audit row
  // and its actual model agree.
  getModelRequest(userId?: string): Promise<AgentModelRequest>;
  resolveModel(userId: string | undefined, signal?: AbortSignal): Promise<RuntimeModel>;
  loadTurns(
    userId: string,
    conversationId?: string,
    signal?: AbortSignal,
    currentMessageId?: string,
  ): Promise<ConversationContext>;
  createTools(scope: FitnessAgentToolScope): AgentTool[];
  audit: AgentRunStore;
  taskStateStore?: TaskStateStore;
  // Which skill this turn is about. Injectable so the loop can be tested (and
  // measured) without a classifier.
  routeIntent?(message: string, userId?: string): Promise<IntentRoute>;
  nowMs?: () => number;
  scheduleTimeout?: (callback: () => void, milliseconds: number) => () => void;
}

function defaultScheduleTimeout(callback: () => void, milliseconds: number): () => void {
  const handle = setTimeout(callback, milliseconds);
  return () => clearTimeout(handle);
}

class RunInterruptedError extends Error {
  constructor() {
    super('Fitness agent run interrupted');
    this.name = 'RunInterruptedError';
  }
}

function callAsync<T>(callback: () => T | Promise<T>): Promise<T> {
  return Promise.resolve().then(callback);
}

function waitForRun<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new RunInterruptedError());

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new RunInterruptedError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function settleBestEffort(promise: Promise<unknown>): void {
  void promise.catch(() => {});
}

function storedRunStatus(reason: FitnessAgentStopReason): StoredRunStatus {
  if (reason === 'completed') return 'completed';
  if (reason === 'cancelled') return 'cancelled';
  if (reason === 'error') return 'failed';
  return 'degraded';
}

function runErrorCode(reason: FitnessAgentStopReason): string | undefined {
  const codes: Partial<Record<FitnessAgentStopReason, string>> = {
    cancelled: 'AGENT_CANCELLED',
    timeout: 'AGENT_TIMEOUT',
    'model-limit': 'AGENT_MODEL_LIMIT',
    'tool-limit': 'AGENT_TOOL_LIMIT',
    'safety-stop': 'AGENT_TOOL_NOT_ALLOWED',
    error: 'PI_RUN_ERROR',
  };
  return codes[reason];
}

function caughtErrorCode(error: unknown): string {
  if (error instanceof AgentContextError || error instanceof AgentConfigurationError) {
    return error.code;
  }
  return 'PI_RUN_ERROR';
}

function lastAssistantMessage(messages: AgentMessage[]): AssistantMessage | undefined {
  return messages
    .slice()
    .reverse()
    .find((message): message is AssistantMessage => message.role === 'assistant');
}

export class PiFitnessAgentRuntime implements FitnessAgentRuntime {
  constructor(private readonly dependencies: PiRuntimeDependencies) {}

  async run(
    input: FitnessAgentRunInput,
    emit: FitnessAgentEventSink = () => {},
  ): Promise<FitnessAgentRunResult> {
    const limits = getAgentRunLimits(input.kind);
    const nowMs = this.dependencies.nowMs ?? Date.now;
    const scheduleTimeout = this.dependencies.scheduleTimeout ?? defaultScheduleTimeout;
    let stopReason: FitnessAgentStopReason = 'completed';
    let stableErrorCode: string | undefined;
    let modelTurns = 0;
    let toolCalls = 0;
    let text = '';
    const usage: FitnessAgentUsage = { ...EMPTY_AGENT_USAGE };
    let route: IntentRoute = { skill: 'general', source: 'FALLBACK' };
    let skill: AgentSkill = 'general';
    let taskState: AgentTaskState | null = null;
    let taskRevision = 0;
    let agent: Agent | undefined;
    let terminalStateFrozen = false;
    const runController = new AbortController();
    const runSignal = runController.signal;
    let modelRequest: AgentModelRequest = { provider: 'unresolved', model: 'unresolved' };
    let resolvedRuntime: RuntimeModel | undefined;
    let removeInputAbort = () => {};
    const abortAgent = () => agent?.abort();
    runSignal.addEventListener('abort', abortAgent);
    const cancelTimeout = scheduleTimeout(() => {
      if (!terminalStateFrozen && stopReason === 'completed') stopReason = 'timeout';
      runController.abort();
    }, limits.timeoutMs);

    if (input.signal?.aborted) {
      stopReason = 'cancelled';
      runController.abort();
    } else if (input.signal) {
      const abortFromCaller = () => {
        if (!terminalStateFrozen && stopReason === 'completed') stopReason = 'cancelled';
        runController.abort();
      };
      input.signal.addEventListener('abort', abortFromCaller, { once: true });
      removeInputAbort = () => input.signal?.removeEventListener('abort', abortFromCaller);
    }

    try {
      if (stopReason === 'completed') {
        modelRequest = await this.dependencies.getModelRequest(input.userId);
      }
    } catch (error) {
      stopReason = 'error';
      stableErrorCode = caughtErrorCode(error);
    }

    const auditStart = callAsync(() =>
      this.dependencies.audit.startRun({
        runId: input.runId,
        userId: input.userId,
        kind: input.kind,
        provider: modelRequest.provider,
        model: modelRequest.model,
        input: { message: input.message, sessionId: input.sessionId },
      }),
    );

    try {
      await waitForRun(auditStart, runSignal);
      if (stopReason !== 'completed') throw new RunInterruptedError();

      resolvedRuntime = await waitForRun(
        callAsync(() => this.dependencies.resolveModel(input.userId, runSignal)),
        runSignal,
      );
      const { model, streamFn } = resolvedRuntime;
      modelRequest = {
        provider: model.provider,
        model: model.id,
      };
      const context = await waitForRun(
        callAsync(() =>
          this.dependencies.loadTurns(
            input.userId,
            input.conversationId,
            runSignal,
            input.currentMessageId,
          ),
        ),
        runSignal,
      );
      await waitForRun(
        callAsync(() =>
          this.dependencies.audit.configureRun({
            runId: input.runId,
            conversationId: input.conversationId,
            provider: modelRequest.provider,
            model: modelRequest.model,
          }),
        ),
        runSignal,
      );

      const tools = this.dependencies.createTools({
        userId: input.userId,
        sessionId: input.sessionId,
        conversationId: input.conversationId,
        locale: input.locale,
      });
      // Which skill this turn is about decides which rules it carries and which
      // proposal tools it may reach for. Read tools are in every skill, so a
      // misroute wastes context rather than making the turn unanswerable.
      const router = this.dependencies.routeIntent ?? routeIntent;
      route = await waitForRun(
        callAsync(() => router(input.message, input.userId)),
        runSignal,
      );
      skill = route.skill;
      if (input.conversationId && this.dependencies.taskStateStore) {
        const stored = await waitForRun(
          this.dependencies.taskStateStore.load(input.userId, input.conversationId),
          runSignal,
        );
        taskRevision = stored.revision;
        const continuation = taskSkill(stored.state, input.message);
        if (continuation) {
          skill = continuation;
          route = { skill, source: 'RULE', matched: 'task-state-continuation' };
        }
        taskState = advanceTask(stored.state, input.message, skill);
        if (
          !(await this.dependencies.taskStateStore.save(
            input.userId,
            input.conversationId,
            taskRevision,
            taskState,
          ))
        )
          throw new Error('TASK_STATE_CONFLICT');
        taskRevision++;
      }
      const allowedNames = new Set<string>(toolsForSkill(skill));
      const availableTools = tools.filter((tool) => allowedNames.has(tool.name));
      const permissionByCall = new Map<string, boolean>();
      const startedAtByCall = new Map<string, number>();
      const finishedCalls = new Set<string>();

      // The interface shows what the agent understood before it answers. It is
      // also the cheapest way to see a misroute: the label is wrong before the
      // reply is.
      await waitForRun(
        callAsync(() => emit({ type: 'intent', skill, routedBy: route.source })),
        runSignal,
      );

      agent = new Agent({
        initialState: {
          systemPrompt: buildSystemPrompt(context.summary, context.memories, skill, taskState),
          model,
          tools: availableTools,
          messages: toPiMessages(context.turns, model),
        },
        streamFn,
        sessionId: input.conversationId ?? input.runId,
        toolExecution: 'parallel',
        beforeToolCall: async ({ toolCall }) => {
          if (permissionByCall.get(toolCall.id) === false) {
            return {
              block: true,
              reason:
                stopReason === 'tool-limit' ? 'Tool-call limit reached.' : 'Tool is not allowed.',
              terminate: true,
            };
          }
        },
        afterToolCall: async ({ toolCall, result, isError }) => {
          const startedAt = startedAtByCall.get(toolCall.id) ?? nowMs();
          await waitForRun(
            callAsync(() =>
              this.dependencies.audit.finishTool({
                runId: input.runId,
                toolCallId: toolCall.id,
                status: isError ? 'failed' : 'succeeded',
                durationMs: Math.max(0, nowMs() - startedAt),
                result: result.content,
                errorCode: isError ? 'AGENT_TOOL_FAILED' : undefined,
              }),
            ),
            runSignal,
          );
          finishedCalls.add(toolCall.id);
          if (isError) {
            return {
              content: [{ type: 'text' as const, text: 'AGENT_TOOL_FAILED' }],
              details: {},
              isError: true,
            };
          }
          taskState = taskAfterTool(taskState, toolCall.name, toolCall.arguments, result.details);
          return undefined;
        },
        shouldStopAfterTurn: ({ message }) => {
          if (stopReason !== 'completed') return true;
          if (
            message.role === 'assistant' &&
            message.content.some((content) => content.type === 'toolCall') &&
            modelTurns >= limits.maxModelTurns
          ) {
            stopReason = 'model-limit';
            return true;
          }
          return false;
        },
      });

      agent.subscribe(async (event) => {
        if (event.type === 'turn_start') {
          modelTurns += 1;
          return;
        }
        // One model turn, one assistant message, one usage record: summing here
        // gives the run's whole token bill without touching the audit path.
        if (event.type === 'turn_end' && event.message.role === 'assistant') {
          const turnUsage = event.message.usage;
          usage.inputTokens += turnUsage.input ?? 0;
          usage.outputTokens += turnUsage.output ?? 0;
          usage.cachedTokens += turnUsage.cacheRead ?? 0;
          usage.totalTokens += turnUsage.totalTokens ?? 0;
          usage.costMicroUsd += Math.round((turnUsage.cost?.total ?? 0) * 1_000_000);
          return;
        }
        if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
          const delta = event.assistantMessageEvent.delta;
          text += delta;
          await waitForRun(
            callAsync(() =>
              emit({
                type: 'text-delta',
                delta,
              }),
            ),
            runSignal,
          );
          return;
        }
        if (event.type === 'tool_execution_start') {
          const known = allowedNames.has(event.toolName);
          const allowed = known && toolCalls < limits.maxToolCalls;
          if (allowed) toolCalls += 1;
          permissionByCall.set(event.toolCallId, allowed);
          startedAtByCall.set(event.toolCallId, nowMs());
          if (!known) stopReason = 'safety-stop';
          else if (!allowed) stopReason = 'tool-limit';
          await waitForRun(
            callAsync(() =>
              this.dependencies.audit.startTool({
                runId: input.runId,
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                args: event.args,
                authorizationAllowed: allowed,
              }),
            ),
            runSignal,
          );
          await waitForRun(
            callAsync(() =>
              emit({
                type: 'tool-start',
                toolCallId: event.toolCallId,
                toolName: event.toolName,
              }),
            ),
            runSignal,
          );
          return;
        }
        if (event.type === 'tool_execution_end') {
          if (!finishedCalls.has(event.toolCallId)) {
            const allowed = permissionByCall.get(event.toolCallId) === true;
            if (allowed) stopReason = 'safety-stop';
            const startedAt = startedAtByCall.get(event.toolCallId) ?? nowMs();
            await waitForRun(
              callAsync(() =>
                this.dependencies.audit.finishTool({
                  runId: input.runId,
                  toolCallId: event.toolCallId,
                  status: 'blocked',
                  durationMs: Math.max(0, nowMs() - startedAt),
                  errorCode: allowed
                    ? 'AGENT_TOOL_ARGUMENTS_INVALID'
                    : stopReason === 'tool-limit'
                      ? 'AGENT_TOOL_LIMIT'
                      : 'AGENT_TOOL_NOT_ALLOWED',
                }),
              ),
              runSignal,
            );
            finishedCalls.add(event.toolCallId);
          }
          await waitForRun(
            callAsync(() =>
              emit({
                type: 'tool-end',
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                isError: event.isError,
              }),
            ),
            runSignal,
          );
        }
      });

      await waitForRun(
        callAsync(() => agent?.prompt(input.message)),
        runSignal,
      );
      if (input.conversationId && this.dependencies.taskStateStore) {
        if (
          !(await this.dependencies.taskStateStore.save(
            input.userId,
            input.conversationId,
            taskRevision,
            taskState,
          ))
        )
          throw new Error('TASK_STATE_CONFLICT');
      }
      const finalAssistant = lastAssistantMessage(agent.state.messages);
      if (stopReason === 'completed' && finalAssistant?.stopReason === 'error') {
        stopReason = 'error';
        stableErrorCode = 'PI_PROVIDER_ERROR';
      } else if (stopReason === 'completed' && finalAssistant?.stopReason === 'aborted') {
        stopReason = input.signal?.aborted ? 'cancelled' : 'timeout';
      }
    } catch (error) {
      if (!runSignal.aborted && !(error instanceof RunInterruptedError)) {
        stopReason = 'error';
        stableErrorCode = caughtErrorCode(error);
      }
    }

    terminalStateFrozen = true;
    const finishRunAudit = () =>
      this.dependencies.audit.finishRun({
        runId: input.runId,
        status: storedRunStatus(stopReason),
        stopReason,
        modelTurns,
        toolCalls,
        usage,
        errorCode: stableErrorCode ?? runErrorCode(stopReason),
      });
    const finishAudit = auditStart.then(finishRunAudit);

    try {
      if (runSignal.aborted) {
        settleBestEffort(finishAudit);
      } else {
        try {
          await waitForRun(finishAudit, runSignal);
        } catch (error) {
          if (!runSignal.aborted) throw error;
          settleBestEffort(finishAudit);
        }
      }

      const emitRunEnd = callAsync(() => emit({ type: 'run-end', stopReason }));
      if (runSignal.aborted) {
        settleBestEffort(emitRunEnd);
      } else {
        try {
          await waitForRun(emitRunEnd, runSignal);
        } catch (error) {
          if (!runSignal.aborted) throw error;
          settleBestEffort(emitRunEnd);
        }
      }

      return {
        text,
        stopReason,
        modelTurns,
        toolCalls,
        provider: resolvedRuntime?.model.provider ?? modelRequest.provider,
        model: resolvedRuntime?.model.id ?? modelRequest.model,
        usage,
        skill,
        routedBy: route.source,
      };
    } finally {
      cancelTimeout();
      removeInputAbort();
      runSignal.removeEventListener('abort', abortAgent);
    }
  }
}

const productionDependencies: PiRuntimeDependencies = {
  getModelRequest: getAgentModelRequest,
  async resolveModel(userId, signal) {
    signal?.throwIfAborted();
    const resolved = await resolveAgentModel(userId);
    signal?.throwIfAborted();
    return {
      model: resolved.model,
      streamFn: resolved.models.streamSimple.bind(resolved.models) as StreamFn,
    };
  },
  loadTurns: loadConversationContext,
  createTools: createFitnessAgentTools,
  audit: prismaAgentRunStore,
  taskStateStore: prismaTaskStateStore,
  routeIntent: (message, userId) => routeIntent(message, { userId }),
};

// `overrides` exists for the evaluation harness: it needs to see the tool
// arguments and results the audit path deliberately hashes away, and to drive
// the router without a classifier. Production callers pass nothing.
export function createPiFitnessAgentRuntime(
  overrides: Partial<PiRuntimeDependencies> = {},
): FitnessAgentRuntime {
  return new PiFitnessAgentRuntime({
    ...productionDependencies,
    ...(overrides.loadTurns ? { taskStateStore: undefined } : {}),
    ...overrides,
  });
}
