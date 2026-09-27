import type { AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentModels, getAgentModelRequest } from './models';
import { PiFitnessAgentRuntime } from './pi-runtime';
import type { AgentRunStore } from './run-store';
import type { FitnessAgentStreamEvent } from './contracts';

afterEach(() => {
  vi.unstubAllEnvs();
});

function createAuditStore() {
  return {
    startRun: vi.fn(async () => {}),
    configureRun: vi.fn(async () => {}),
    startTool: vi.fn(async () => {}),
    finishTool: vi.fn(async () => {}),
    finishRun: vi.fn(async () => {}),
  } satisfies AgentRunStore;
}

function createSummaryTool(execute = vi.fn(async () => ({
  content: [{ type: 'text' as const, text: '本周计划：周一胸推 3 组、周三硬拉 4 组。' }],
  details: {},
}))) {
  const parameters = Type.Object({}, { additionalProperties: false });
  const tool: AgentTool<typeof parameters> = {
    name: 'get_current_plan',
    label: '读取当前计划',
    description: 'Read the current plan summary',
    parameters,
    executionMode: 'parallel',
    execute,
  };
  return { tool, execute };
}

function createDemoRuntime(tools: AgentTool[], audit: AgentRunStore) {
  return new PiFitnessAgentRuntime({
    getModelRequest: getAgentModelRequest,
    // No user in these tests: the deployment default is what is exercised.
    async resolveModel() {
      const models = createAgentModels();
      const request = await getAgentModelRequest();
      const model = models.getModel(request.provider, request.model);
      if (!model) throw new Error('demo model missing');
      return {
        model,
        streamFn: models.streamSimple.bind(models) as StreamFn,
      };
    },
    loadTurns: async () => ({ summary: null, memories: [], turns: [] }),
    createTools: () => tools,
    audit,
  });
}

describe('demo agent provider', () => {
  it('runs the full agent loop without credentials', async () => {
    vi.stubEnv('LLM_PROVIDER', 'demo');
    const audit = createAuditStore();
    const { tool, execute } = createSummaryTool();
    const runtime = createDemoRuntime([tool], audit);
    const events: FitnessAgentStreamEvent[] = [];

    const result = await runtime.run(
      {
        runId: 'run_demo',
        kind: 'chat',
        userId: 'user_1',
        message: '我今天该练什么？',
      },
      (event) => {
        events.push(event);
      },
    );

    expect(result.stopReason).toBe('completed');
    expect(result.provider).toBe('demo');
    expect(result.model).toBe('demo-agent');
    expect(result.toolCalls).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);

    const eventTypes = events.map((event) => event.type);
    expect(eventTypes).toContain('tool-start');
    expect(eventTypes).toContain('tool-end');
    expect(eventTypes.at(-1)).toBe('run-end');
    expect(events.filter((event) => event.type === 'text-delta').length).toBeGreaterThan(1);
    expect(result.text).toContain('演示模式');
    expect(result.text).toContain('本周计划');
  });

  it('answers a small-talk turn without reaching for a tool', async () => {
    vi.stubEnv('LLM_PROVIDER', 'demo');
    const audit = createAuditStore();
    const { tool, execute } = createSummaryTool();
    const runtime = createDemoRuntime([tool], audit);

    const result = await runtime.run({
      runId: 'run_demo_smalltalk',
      kind: 'chat',
      userId: 'user_1',
      message: '你好',
    });

    expect(result.stopReason).toBe('completed');
    expect(result.toolCalls).toBe(0);
    expect(execute).not.toHaveBeenCalled();
    expect(result.text).toContain('演示模式');
  });

  it('reports the resolved demo model through the run audit', async () => {
    vi.stubEnv('LLM_PROVIDER', 'demo');
    const audit = createAuditStore();
    const { tool } = createSummaryTool();
    const runtime = createDemoRuntime([tool], audit);

    await runtime.run({
      runId: 'run_demo_audit',
      kind: 'chat',
      userId: 'user_1',
      message: '这周怎么安排？',
    });

    expect(audit.configureRun).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'demo', model: 'demo-agent' }),
    );
  });
});
