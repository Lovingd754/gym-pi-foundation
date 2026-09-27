import { describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { prismaAgentRunStore } from '@/lib/agent/run-store';

describe('prismaAgentRunStore', () => {
  it('persists only hashes and stable metadata', async () => {
    const user = await db.user.create({
      data: {
        email: 'run-store@example.com',
        passwordHash: 'test-password-hash',
      },
    });
    const conversation = await db.agentConversation.create({
      data: { userId: user.id, title: 'Run store' },
    });

    await prismaAgentRunStore.startRun({
      runId: 'run_store',
      userId: user.id,
      kind: 'chat',
      provider: 'requested-provider',
      model: 'requested-model',
      input: { message: 'private shoulder note' },
    });
    await prismaAgentRunStore.configureRun({
      runId: 'run_store',
      conversationId: conversation.id,
      provider: 'faux',
      model: 'faux',
    });
    await prismaAgentRunStore.startTool({
      runId: 'run_store',
      toolCallId: 'call_store',
      toolName: 'get_training_context',
      args: { privateValue: 'private bodyweight' },
      authorizationAllowed: true,
    });
    await prismaAgentRunStore.finishTool({
      runId: 'run_store',
      toolCallId: 'call_store',
      status: 'succeeded',
      durationMs: 7,
      result: { privateResult: 'private workout history' },
    });
    await prismaAgentRunStore.finishRun({
      runId: 'run_store',
      status: 'completed',
      stopReason: 'completed',
      modelTurns: 2,
      toolCalls: 1,
      usage: {
        inputTokens: 1200,
        outputTokens: 240,
        cachedTokens: 0,
        totalTokens: 1440,
        costMicroUsd: 350,
      },
    });

    const row = await db.agentRun.findUniqueOrThrow({
      where: { id: 'run_store' },
      include: { toolInvocations: true },
    });
    const serialized = JSON.stringify(row);

    expect(row.status).toBe('COMPLETED');
    expect(row.stopReason).toBe('COMPLETED');
    expect(row.conversationId).toBe(conversation.id);
    expect(row.provider).toBe('faux');
    expect(row.model).toBe('faux');
    expect(row.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.toolInvocations[0]?.status).toBe('SUCCEEDED');
    expect(row.toolInvocations[0]?.resultHash).toMatch(/^[a-f0-9]{64}$/);
    // The run's bill travels with its audit row.
    expect(row.totalTokens).toBe(1440);
    expect(row.costMicroUsd).toBe(350);
    expect(serialized).not.toContain('private shoulder note');
    expect(serialized).not.toContain('private bodyweight');
    expect(serialized).not.toContain('private workout history');
  });

  it('does not duplicate a retried tool-start record', async () => {
    const user = await db.user.create({
      data: {
        email: 'run-store-retry@example.com',
        passwordHash: 'test-password-hash',
      },
    });
    await prismaAgentRunStore.startRun({
      runId: 'run_retry',
      userId: user.id,
      kind: 'chat',
      provider: 'faux',
      model: 'faux',
      input: { message: 'hello' },
    });
    const input = {
      runId: 'run_retry',
      toolCallId: 'call_retry',
      toolName: 'get_training_context',
      args: {},
      authorizationAllowed: true,
    } as const;

    await prismaAgentRunStore.startTool(input);
    await prismaAgentRunStore.startTool(input);

    expect(
      await db.toolInvocation.count({
        where: { runId: 'run_retry', toolCallId: 'call_retry' },
      }),
    ).toBe(1);
  });
});
