import type { AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  Type,
} from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import { AgentContextError } from './context';
import { getAgentRunLimits } from './limits';
import { AgentConfigurationError } from './models';
import type { AgentRunStore } from './run-store';
import { PiFitnessAgentRuntime } from './pi-runtime';
import type { TaskStateStore } from './task-state-store';
import { advanceTask, taskAfterTool } from './task-state';

// Guards, not quotas: the tests derive their expectations from the same source
// of truth so a guard change never silently weakens the loop protections.
const CHAT_GUARDS = getAgentRunLimits('chat');

function createAuditStore() {
  return {
    startRun: vi.fn(async () => {}),
    configureRun: vi.fn(async () => {}),
    startTool: vi.fn(async () => {}),
    finishTool: vi.fn(async () => {}),
    finishRun: vi.fn(async () => {}),
  } satisfies AgentRunStore;
}

function createReadTool(
  execute = vi.fn(async () => ({
    content: [{ type: 'text' as const, text: '{"contextVersion":1}' }],
    details: { contextVersion: 1 },
  })),
) {
  const parameters = Type.Object({}, { additionalProperties: false });
  const tool: AgentTool<typeof parameters> = {
    name: 'get_current_plan',
    label: 'Get training context',
    description: 'Read context',
    parameters,
    executionMode: 'parallel',
    execute,
  };
  return { tool, execute };
}

function createRuntime(options?: {
  taskStateStore?: TaskStateStore;
  tools?: AgentTool[];
  responseRate?: number;
  scheduleTimeout?: (callback: () => void, milliseconds: number) => () => void;
}) {
  const faux = fauxProvider(
    options?.responseRate ? { tokensPerSecond: options.responseRate } : undefined,
  );
  const models = createModels();
  models.setProvider(faux.provider);
  const audit = createAuditStore();
  const readTool = createReadTool();
  const runtime = new PiFitnessAgentRuntime({
    getModelRequest: async () => ({ provider: 'faux', model: 'faux-1' }),
    resolveModel: async () => ({
      model: faux.getModel(),
      streamFn: models.streamSimple.bind(models) as StreamFn,
    }),
    loadTurns: async () => ({ summary: null, memories: [], turns: [] }),
    createTools: () => options?.tools ?? [readTool.tool],
    audit,
    taskStateStore: options?.taskStateStore,
    // The real router asks a model for a message no pattern matches; a unit
    // test injects the answer instead of taking the network out for a walk.
    routeIntent: async () => ({ skill: 'review', source: 'RULE', matched: 'test' }),
    scheduleTimeout: options?.scheduleTimeout,
  });
  return { faux, audit, readTool, runtime };
}

const input = {
  runId: 'run_test',
  kind: 'chat' as const,
  userId: 'user_test',
  conversationId: 'conversation_test',
  message: 'Review my training',
};

describe('PiFitnessAgentRuntime', () => {
  it('persists a new proposal reference only after a successful tool result', async () => {
    const state = taskAfterTool(
      advanceTask(null, '记录卧推60kg8次3组', 'log'),
      'log_workout',
      { weight: 60, reps: 8, sets: 3 },
      { proposalId: 'old' },
    );
    const store = {
      load: vi.fn().mockResolvedValue({ state, revision: 0 }),
      save: vi.fn().mockResolvedValue(true),
    };
    const tool: AgentTool = {
      name: 'log_workout',
      label: 'Prepare log',
      description: 'Prepare',
      parameters: Type.Object({ weight: Type.Number() }),
      execute: async () => ({
        content: [{ type: 'text', text: 'Pending confirmation' }],
        details: { proposalId: 'new' },
      }),
    };
    const { faux, runtime } = createRuntime({ taskStateStore: store, tools: [tool] });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('log_workout', { weight: 55 })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage([fauxText('Prepared for confirmation.')]),
    ]);
    const result = await runtime.run({ ...input, message: '改成55kg' });
    expect(result.stopReason).toBe('completed');
    expect(store.save.mock.calls[1]?.[3]).toMatchObject({
      phase: 'PENDING_CONFIRMATION',
      pending: { id: 'new' },
      fields: { weight: 55 },
    });
  });
  it('loads durable task context, routes a correction to its task and persists revision-needed state', async () => {
    const state = taskAfterTool(
      advanceTask(null, '记录卧推60kg8次3组', 'log'),
      'log_workout',
      { weight: 60, reps: 8, sets: 3 },
      { proposalId: 'pending' },
    );
    const store = {
      load: vi.fn().mockResolvedValue({ state, revision: 2 }),
      save: vi.fn().mockResolvedValue(true),
    };
    const { faux, runtime } = createRuntime({ taskStateStore: store });
    faux.setResponses([fauxAssistantMessage([fauxText('Please confirm the corrected request.')])]);
    const result = await runtime.run({ ...input, message: '刚才改成55kg' });
    expect(result.skill).toBe('log');
    expect(store.save).toHaveBeenCalledTimes(2);
    expect(store.save.mock.calls[1]).toEqual([
      'user_test',
      'conversation_test',
      3,
      expect.objectContaining({
        phase: 'NEEDS_REVISION',
        fields: expect.objectContaining({ weight: 55 }),
      }),
    ]);
  });
  it('executes a read tool, streams text, and completes the audit', async () => {
    const { faux, audit, readTool, runtime } = createRuntime();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('get_current_plan', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxText('Keep the next session conservative.')]),
    ]);
    const events: string[] = [];

    const result = await runtime.run(input, (event) => {
      events.push(event.type);
    });

    expect(readTool.execute).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      text: 'Keep the next session conservative.',
      stopReason: 'completed',
      modelTurns: 2,
      toolCalls: 1,
      provider: 'faux',
    });
    // The turn announces what it understood before it does anything else.
    expect(events[0]).toBe('intent');
    expect(events[1]).toBe('tool-start');
    expect(events.indexOf('tool-start')).toBeLessThan(events.indexOf('tool-end'));
    expect(events.at(-1)).toBe('run-end');
    expect(audit.finishRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run_test',
        status: 'completed',
        stopReason: 'completed',
      }),
    );
  });

  it('blocks tool calls beyond the runaway guard', async () => {
    const { faux, audit, readTool, runtime } = createRuntime();
    faux.setResponses([
      fauxAssistantMessage(
        Array.from({ length: CHAT_GUARDS.maxToolCalls + 1 }, () =>
          fauxToolCall('get_current_plan', {}),
        ),
        { stopReason: 'toolUse' },
      ),
    ]);

    const result = await runtime.run({ ...input, runId: 'run_tool_limit' });

    expect(readTool.execute).toHaveBeenCalledTimes(CHAT_GUARDS.maxToolCalls);
    expect(result.stopReason).toBe('tool-limit');
    expect(result.toolCalls).toBe(CHAT_GUARDS.maxToolCalls);
    expect(audit.finishTool).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'blocked',
        errorCode: 'AGENT_TOOL_LIMIT',
      }),
    );
  });

  it('stops after the runaway guard model-turn count', async () => {
    const { faux, readTool, runtime } = createRuntime();
    faux.setResponses(
      Array.from({ length: CHAT_GUARDS.maxModelTurns }, () =>
        fauxAssistantMessage([fauxToolCall('get_current_plan', {})], { stopReason: 'toolUse' }),
      ),
    );

    const result = await runtime.run({ ...input, runId: 'run_model_limit' });

    expect(readTool.execute).toHaveBeenCalledTimes(CHAT_GUARDS.maxModelTurns);
    expect(result.modelTurns).toBe(CHAT_GUARDS.maxModelTurns);
    expect(result.stopReason).toBe('model-limit');
  });

  it('does not continue after a truncated tool call', async () => {
    const { faux, readTool, runtime } = createRuntime();
    faux.setResponses([
      ...Array.from({ length: 6 }, () =>
        fauxAssistantMessage([fauxToolCall('get_current_plan', {})], {
          stopReason: 'length',
        }),
      ),
      fauxAssistantMessage([fauxText('A seventh model response must never be requested.')]),
    ]);

    const result = await runtime.run({ ...input, runId: 'run_truncated_tool' });

    expect(readTool.execute).not.toHaveBeenCalled();
    expect(faux.state.callCount).toBe(1);
    expect(result.modelTurns).toBe(1);
    expect(result.stopReason).toBe('safety-stop');
  });

  it('blocks and audits an unknown tool name', async () => {
    const { faux, audit, readTool, runtime } = createRuntime();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('write_active_plan', { calories: 1200 })], {
        stopReason: 'toolUse',
      }),
    ]);

    const result = await runtime.run({ ...input, runId: 'run_unknown_tool' });

    expect(readTool.execute).not.toHaveBeenCalled();
    expect(result.stopReason).toBe('safety-stop');
    expect(audit.startTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'write_active_plan',
        authorizationAllowed: false,
      }),
    );
    expect(audit.finishTool).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'blocked',
        errorCode: 'AGENT_TOOL_NOT_ALLOWED',
      }),
    );
  });

  it('blocks schema-invalid arguments before the handler executes', async () => {
    const { faux, audit, readTool, runtime } = createRuntime();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('get_current_plan', { userId: 'other-user' })], {
        stopReason: 'toolUse',
      }),
    ]);

    const result = await runtime.run({
      ...input,
      runId: 'run_invalid_arguments',
    });

    expect(readTool.execute).not.toHaveBeenCalled();
    expect(result.stopReason).toBe('safety-stop');
    expect(audit.finishTool).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'blocked',
        errorCode: 'AGENT_TOOL_ARGUMENTS_INVALID',
      }),
    );
  });

  it('records a tool exception with a stable code and lets Pi explain the fallback', async () => {
    const { faux, audit, readTool, runtime } = createRuntime();
    readTool.execute.mockRejectedValueOnce(new Error('private database failure details'));
    let nextModelContext = '';
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('get_current_plan', {})], { stopReason: 'toolUse' }),
      (context) => {
        nextModelContext = JSON.stringify(context.messages);
        return fauxAssistantMessage([
          fauxText('I could not verify the training context, so no change is advised.'),
        ]);
      },
    ]);

    const result = await runtime.run({
      ...input,
      runId: 'run_tool_failure',
    });

    expect(result.stopReason).toBe('completed');
    expect(nextModelContext).toContain('AGENT_TOOL_FAILED');
    expect(nextModelContext).not.toContain('private database failure details');
    expect(audit.finishTool).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorCode: 'AGENT_TOOL_FAILED',
      }),
    );
  });

  it('honors an already-cancelled caller signal without contacting the model', async () => {
    const { faux, audit, runtime } = createRuntime();
    const controller = new AbortController();
    controller.abort();

    const result = await runtime.run({
      ...input,
      runId: 'run_cancelled',
      signal: controller.signal,
    });

    expect(result.stopReason).toBe('cancelled');
    expect(faux.state.callCount).toBe(0);
    await vi.waitFor(() =>
      expect(audit.finishRun).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'cancelled',
          stopReason: 'cancelled',
          errorCode: 'AGENT_CANCELLED',
        }),
      ),
    );
  });

  it('audits a model configuration failure with requested model metadata', async () => {
    const audit = createAuditStore();
    const runtime = new PiFitnessAgentRuntime({
      getModelRequest: async () => ({ provider: 'anthropic', model: 'claude-opus-4-7' }),
      resolveModel: async () => {
        throw new AgentConfigurationError('PI_AUTH_MISSING');
      },
      loadTurns: async () => ({ summary: null, memories: [], turns: [] }),
      createTools: () => [],
      audit,
    });

    const result = await runtime.run({ ...input, runId: 'run_config_failure' });

    expect(result).toMatchObject({
      stopReason: 'error',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
    });
    expect(audit.startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run_config_failure',
        provider: 'anthropic',
        model: 'claude-opus-4-7',
      }),
    );
    expect(audit.finishRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorCode: 'PI_AUTH_MISSING',
      }),
    );
  });

  it('audits rejected conversation context without linking the unverified conversation', async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const audit = createAuditStore();
    const runtime = new PiFitnessAgentRuntime({
      getModelRequest: async () => ({ provider: 'faux', model: 'faux-1' }),
      resolveModel: async () => ({
        model: faux.getModel(),
        streamFn: models.streamSimple.bind(models) as StreamFn,
      }),
      loadTurns: async () => {
        throw new AgentContextError('CONVERSATION_NOT_FOUND');
      },
      createTools: () => [],
      audit,
    });

    const result = await runtime.run({ ...input, runId: 'run_foreign_context' });

    expect(result.stopReason).toBe('error');
    expect(audit.startRun).toHaveBeenCalledWith(
      expect.not.objectContaining({ conversationId: input.conversationId }),
    );
    expect(audit.configureRun).not.toHaveBeenCalled();
    expect(audit.finishRun).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'CONVERSATION_NOT_FOUND' }),
    );
  });

  it('applies the interactive deadline while model resolution is stalled', async () => {
    let triggerTimeout = () => {};
    let markResolveStarted = () => {};
    const resolveStarted = new Promise<void>((resolve) => {
      markResolveStarted = resolve;
    });
    const audit = createAuditStore();
    const runtime = new PiFitnessAgentRuntime({
      getModelRequest: async () => ({ provider: 'faux', model: 'faux-1' }),
      resolveModel: async (_userId: string | undefined, signal?: AbortSignal) => {
        expect(signal).toBeInstanceOf(AbortSignal);
        markResolveStarted();
        return new Promise(() => {});
      },
      loadTurns: async () => ({ summary: null, memories: [], turns: [] }),
      createTools: () => [],
      audit,
      scheduleTimeout: (callback, milliseconds) => {
        expect(milliseconds).toBe(CHAT_GUARDS.timeoutMs);
        triggerTimeout = callback;
        return () => {};
      },
    });

    const run = runtime.run({ ...input, runId: 'run_preflight_timeout' });
    await resolveStarted;
    triggerTimeout();
    const result = await run;

    expect(result.stopReason).toBe('timeout');
    expect(audit.finishRun).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'AGENT_TIMEOUT' }),
    );
  }, 1_000);

  it('settles at the deadline when a tool ignores cancellation', async () => {
    let triggerTimeout = () => {};
    const { faux, readTool, runtime } = createRuntime({
      scheduleTimeout: (callback) => {
        triggerTimeout = callback;
        return () => {};
      },
    });
    readTool.execute.mockImplementationOnce(async () => new Promise(() => {}));
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('get_current_plan', {})], { stopReason: 'toolUse' }),
    ]);

    const run = runtime.run({ ...input, runId: 'run_stalled_tool' });
    await vi.waitFor(() => expect(readTool.execute).toHaveBeenCalledTimes(1));
    triggerTimeout();
    const result = await run;

    expect(result.stopReason).toBe('timeout');
  }, 1_000);

  it('settles at the deadline when run audit finalization is stalled', async () => {
    let triggerTimeout = () => {};
    const { faux, audit, runtime } = createRuntime({
      scheduleTimeout: (callback) => {
        triggerTimeout = callback;
        return () => {};
      },
    });
    audit.finishRun.mockImplementationOnce(async () => new Promise(() => {}));
    faux.setResponses([fauxAssistantMessage([fauxText('Final answer')])]);
    const runEndReasons: string[] = [];

    const run = runtime.run({ ...input, runId: 'run_stalled_final_audit' }, (event) => {
      if (event.type === 'run-end') runEndReasons.push(event.stopReason);
    });
    await vi.waitFor(() => expect(audit.finishRun).toHaveBeenCalledTimes(1));
    triggerTimeout();
    const result = await run;

    expect(result.stopReason).toBe('completed');
    expect(audit.finishRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed', stopReason: 'completed' }),
    );
    await vi.waitFor(() => expect(runEndReasons).toEqual(['completed']));
  }, 1_000);

  it('settles at the deadline when the run-end event sink is stalled', async () => {
    let triggerTimeout = () => {};
    let markRunEndStarted = () => {};
    const runEndStarted = new Promise<void>((resolve) => {
      markRunEndStarted = resolve;
    });
    const { faux, runtime } = createRuntime({
      scheduleTimeout: (callback) => {
        triggerTimeout = callback;
        return () => {};
      },
    });
    faux.setResponses([fauxAssistantMessage([fauxText('Final answer')])]);
    const runEndReasons: string[] = [];

    const run = runtime.run({ ...input, runId: 'run_stalled_event_sink' }, (event) => {
      if (event.type !== 'run-end') return;
      runEndReasons.push(event.stopReason);
      markRunEndStarted();
      return new Promise(() => {});
    });
    await runEndStarted;
    triggerTimeout();
    const result = await run;

    expect(result.stopReason).toBe('completed');
    expect(runEndReasons).toEqual(['completed']);
  }, 1_000);

  it('aborts the Pi run at the approved interactive timeout', async () => {
    const scheduleTimeout = (callback: () => void, milliseconds: number) => {
      expect(milliseconds).toBe(CHAT_GUARDS.timeoutMs);
      queueMicrotask(callback);
      return () => {};
    };
    const { faux, runtime } = createRuntime({
      responseRate: 1,
      scheduleTimeout,
    });
    faux.setResponses([
      fauxAssistantMessage([fauxText('This response is intentionally slow for cancellation.')]),
    ]);

    const result = await runtime.run({ ...input, runId: 'run_timeout' });

    expect(result.stopReason).toBe('timeout');
  });
});
