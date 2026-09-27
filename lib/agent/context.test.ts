import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConversationContext } from './context';

const mocks = vi.hoisted(() => ({ findFirst: vi.fn(), findMany: vi.fn(), list: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: {
  agentConversation: { findFirst: mocks.findFirst },
  agentMessage: { findMany: mocks.findMany },
} }));
vi.mock('./memory-store', () => ({ prismaAgentMemoryStore: { list: mocks.list } }));

describe('conversation context boundaries', () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({
    id: `message-${index}`, role: 'USER', content: `text-${index}`,
    createdAt: new Date(index * 1000),
  }));
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue([]);
    mocks.findFirst.mockImplementation(async (query) => ({
      contextSummary: null, summarizedThrough: null,
      messages: rows.slice().reverse().slice(0, query.select.messages?.take ?? rows.length),
    }));
    mocks.findMany.mockImplementation(async (query) => rows.filter((row) =>
      row.id !== query.where.id?.not &&
      (!query.where.createdAt || row.createdAt > query.where.createdAt.gt),
    ));
  });
  it('keeps all history before the compaction threshold instead of dropping the first ten messages', async () => {
    const context = await loadConversationContext('user', 'conversation');
    expect(context.turns.map((turn) => turn.content)).toEqual(rows.map((row) => row.content));
  });
  it('excludes only the current persisted message by ID and keeps repeated wording', async () => {
    rows[28]!.content = rows[29]!.content;
    const context = await loadConversationContext('user', 'conversation', undefined, 'message-29');
    expect(context.turns).toHaveLength(29);
    expect(context.turns.at(-1)?.content).toBe(rows[29]!.content);
  });
  it('loads only messages after the summary boundary', async () => {
    mocks.findFirst.mockResolvedValue({
      contextSummary: 'Earlier facts', summarizedThrough: rows[20]!.createdAt,
      messages: rows.slice().reverse(),
    });
    const context = await loadConversationContext('user', 'conversation');
    expect(context.summary).toBe('Earlier facts');
    expect(context.turns.map((turn) => turn.content)).toEqual(rows.slice(21).map((row) => row.content));
  });
});
