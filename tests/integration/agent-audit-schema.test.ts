import { describe, expect, it } from 'vitest';
import { db } from '@/lib/db';

describe('agent persistence schema', () => {
  it('keeps Pi conversations separate and cascades their child rows', async () => {
    const user = await db.user.create({
      data: {
        email: 'audit@example.com',
        passwordHash: 'test-password-hash',
      },
    });
    const conversation = await db.agentConversation.create({
      data: { userId: user.id, title: 'Audit test' },
    });
    const message = await db.agentMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'USER',
        status: 'COMPLETE',
        content: 'Private message',
      },
    });
    const run = await db.agentRun.create({
      data: {
        id: 'run_audit',
        userId: user.id,
        conversationId: conversation.id,
        kind: 'CHAT',
        status: 'RUNNING',
        runtimeVersion: 'pi-agent-core@0.85.1',
        provider: 'faux',
        model: 'faux',
        inputHash: 'a'.repeat(64),
      },
    });
    await db.toolInvocation.create({
      data: {
        runId: run.id,
        toolCallId: 'call_1',
        toolName: 'get_training_context',
        argsHash: 'b'.repeat(64),
        authorizationAllowed: true,
        status: 'SUCCEEDED',
        resultHash: 'c'.repeat(64),
        durationMs: 4,
      },
    });

    expect(await db.toolInvocation.count({ where: { runId: run.id } })).toBe(1);
    await db.agentRun.delete({ where: { id: run.id } });
    expect(await db.toolInvocation.count({ where: { runId: run.id } })).toBe(0);
    await db.agentConversation.delete({ where: { id: conversation.id } });
    expect(await db.agentMessage.count({ where: { id: message.id } })).toBe(0);
  });
});
