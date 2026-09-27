import { describe, expect, it, vi } from 'vitest';
import type { AgentMemoryStore, AgentMemoryView } from '../memory-store';
import { createMemoriesTool, createProposeMemoryTool } from './memories';

function memory(content: string, status: 'PENDING' | 'ACTIVE' = 'ACTIVE'): AgentMemoryView {
  return { id: content, content, status, createdAt: new Date('2026-09-19T10:00:00.000Z') };
}

function store(overrides: Partial<AgentMemoryStore> = {}): AgentMemoryStore {
  return {
    propose: vi.fn(async () => ({ id: 'memory_1', status: 'PENDING' as const, created: true })),
    confirm: vi.fn(async () => true),
    dismiss: vi.fn(async () => true),
    list: vi.fn(async () => []),
    remove: vi.fn(async () => true),
    ...overrides,
  };
}

function textOf(result: { content: unknown }): string {
  const [block] = result.content as Array<{ type: string; text?: string }>;
  return block?.text ?? '';
}

const context = { userId: 'user_1', conversationId: 'conversation_1', locale: 'zh-CN' };

describe('get_memories', () => {
  it('reads only confirmed notes', async () => {
    const list = vi.fn(async () => [memory('不喜欢练有氧'), memory('膝盖怕深蹲')]);
    const tool = createMemoriesTool(context, store({ list }));

    const text = textOf(await tool.execute('call_1', {}));

    expect(list).toHaveBeenCalledWith('user_1', 'ACTIVE');
    expect(text).toContain('不喜欢练有氧');
    expect(text).toContain('膝盖怕深蹲');
    expect(text).toContain('2');
  });

  it('says nothing is remembered rather than returning an empty list', async () => {
    const tool = createMemoriesTool(context, store());

    expect(textOf(await tool.execute('call_2', {}))).toContain('还没有记住');
  });
});

describe('propose_memory', () => {
  it('records the proposal and tells the model it is not saved yet', async () => {
    const propose = vi.fn(async () => ({
      id: 'memory_1',
      status: 'PENDING' as const,
      created: true,
    }));
    const tool = createProposeMemoryTool(context, store({ propose }));

    const result = await tool.execute('call_1', { content: '不喜欢练有氧' });
    const text = textOf(result);

    expect(propose).toHaveBeenCalledWith({
      userId: 'user_1',
      conversationId: 'conversation_1',
      content: '不喜欢练有氧',
    });
    expect(text).toContain('还没有保存');
    expect(text).toContain('由用户决定');
    expect(result.details).toEqual({ memoryId: 'memory_1', status: 'PENDING' });
  });

  it('tells the model not to re-propose a note that is already confirmed', async () => {
    const tool = createProposeMemoryTool(
      context,
      store({
        propose: async () => ({ id: 'memory_1', status: 'ACTIVE' as const, created: false }),
      }),
    );

    expect(textOf(await tool.execute('call_1', { content: '不喜欢练有氧' }))).toContain(
      '已经是用户确认记住的内容',
    );
  });

  it('tells the model not to re-propose a note that is already waiting', async () => {
    const tool = createProposeMemoryTool(
      context,
      store({
        propose: async () => ({ id: 'memory_1', status: 'PENDING' as const, created: false }),
      }),
    );

    expect(textOf(await tool.execute('call_1', { content: '不喜欢练有氧' }))).toContain(
      '等用户确认',
    );
  });

  it('translates a rejected note into guidance the model can act on', async () => {
    const tool = createProposeMemoryTool(
      context,
      store({
        propose: async () => {
          const { AgentMemoryContentError } = await import('../memory-store');
          throw new AgentMemoryContentError('MEMORY_TOO_LONG');
        },
      }),
    );

    await expect(tool.execute('call_1', { content: 'x' })).rejects.toThrow(/one sentence/);
  });

  it('exposes no model-controlled identifier', () => {
    const tool = createProposeMemoryTool(context, store());

    expect(Object.keys(tool.parameters.properties ?? {})).toEqual(['content']);
    expect(JSON.stringify(tool.parameters)).not.toContain('userId');
  });
});
