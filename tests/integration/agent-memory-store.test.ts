import { describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { prismaAgentMemoryStore } from '@/lib/agent/memory-store';

async function createUser(email: string) {
  return db.user.create({ data: { email, passwordHash: 'test-password-hash' } });
}

describe('prismaAgentMemoryStore', () => {
  it('keeps a proposal out of the confirmed list until it is accepted', async () => {
    const user = await createUser('memory@example.com');

    const proposed = await prismaAgentMemoryStore.propose({
      userId: user.id,
      content: '  不喜欢   练有氧 ',
    });

    expect(proposed).toEqual({ id: proposed.id, status: 'PENDING', created: true });
    expect(await prismaAgentMemoryStore.list(user.id, 'ACTIVE')).toEqual([]);
    expect((await prismaAgentMemoryStore.list(user.id, 'PENDING')).map((m) => m.content)).toEqual([
      '不喜欢 练有氧',
    ]);

    expect(await prismaAgentMemoryStore.confirm(user.id, proposed.id)).toBe(true);
    expect(await prismaAgentMemoryStore.list(user.id, 'PENDING')).toEqual([]);
    expect((await prismaAgentMemoryStore.list(user.id, 'ACTIVE')).map((m) => m.content)).toEqual([
      '不喜欢 练有氧',
    ]);
  });

  it('reuses an identical proposal instead of stacking cards', async () => {
    const user = await createUser('memory-dedupe@example.com');

    const first = await prismaAgentMemoryStore.propose({
      userId: user.id,
      content: '只在午休健身',
    });
    const second = await prismaAgentMemoryStore.propose({
      userId: user.id,
      content: '只在午休健身',
    });

    expect(second).toEqual({ id: first.id, status: 'PENDING', created: false });
    expect(await prismaAgentMemoryStore.list(user.id, 'PENDING')).toHaveLength(1);
  });

  it('does not re-propose something already confirmed', async () => {
    const user = await createUser('memory-active@example.com');
    const proposed = await prismaAgentMemoryStore.propose({
      userId: user.id,
      content: '膝盖怕深蹲',
    });
    await prismaAgentMemoryStore.confirm(user.id, proposed.id);

    const again = await prismaAgentMemoryStore.propose({
      userId: user.id,
      content: '膝盖怕深蹲',
    });

    expect(again).toEqual({ id: proposed.id, status: 'ACTIVE', created: false });
  });

  it('deletes a declined proposal instead of parking it', async () => {
    const user = await createUser('memory-dismiss@example.com');
    const proposed = await prismaAgentMemoryStore.propose({
      userId: user.id,
      content: '周末去郊区健身房',
    });

    expect(await prismaAgentMemoryStore.dismiss(user.id, proposed.id)).toBe(true);

    expect(await prismaAgentMemoryStore.list(user.id, 'PENDING')).toEqual([]);
    expect(await prismaAgentMemoryStore.list(user.id, 'ACTIVE')).toEqual([]);
    // A second decision on the same row is a no-op, so the API can answer 404
    // without pretending something changed.
    expect(await prismaAgentMemoryStore.dismiss(user.id, proposed.id)).toBe(false);
  });

  it('never lets one trainee act on another trainee’s note', async () => {
    const owner = await createUser('memory-owner@example.com');
    const stranger = await createUser('memory-stranger@example.com');
    const proposed = await prismaAgentMemoryStore.propose({
      userId: owner.id,
      content: '怕高翻',
    });

    expect(await prismaAgentMemoryStore.confirm(stranger.id, proposed.id)).toBe(false);
    expect(await prismaAgentMemoryStore.dismiss(stranger.id, proposed.id)).toBe(false);
    expect(await prismaAgentMemoryStore.remove(stranger.id, proposed.id)).toBe(false);
    expect(await db.agentMemory.count()).toBe(1);
  });

  it('keeps the note when its conversation is deleted', async () => {
    const user = await createUser('memory-provenance@example.com');
    const conversation = await db.agentConversation.create({
      data: { userId: user.id, title: 'Provenance' },
    });
    const proposed = await prismaAgentMemoryStore.propose({
      userId: user.id,
      conversationId: conversation.id,
      content: '出差时住酒店健身房',
    });
    await prismaAgentMemoryStore.confirm(user.id, proposed.id);

    await db.agentConversation.delete({ where: { id: conversation.id } });

    const stored = await db.agentMemory.findUniqueOrThrow({ where: { id: proposed.id } });
    expect(stored.content).toBe('出差时住酒店健身房');
    expect(stored.sourceConversationId).toBeNull();
  });

  it('removes a confirmed note on request', async () => {
    const user = await createUser('memory-remove@example.com');
    const proposed = await prismaAgentMemoryStore.propose({
      userId: user.id,
      content: '早上练不动',
    });
    await prismaAgentMemoryStore.confirm(user.id, proposed.id);

    expect(await prismaAgentMemoryStore.remove(user.id, proposed.id)).toBe(true);
    expect(await prismaAgentMemoryStore.list(user.id, 'ACTIVE')).toEqual([]);
  });
});
