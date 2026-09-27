import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUMMARY_CHAR_LIMIT, defineSummaryTool, summaryLines } from './summary';

const TOOLS_DIR = path.join(process.cwd(), 'lib', 'agent', 'tools');

function tool(overrides: { text: string; name?: string }) {
  return defineSummaryTool<never, { ok: boolean }>(
    {
      // The base class is exercised directly; parameter types are irrelevant
      // to the rules being tested.
      name: overrides.name ?? 'test_tool',
      label: 'Test',
      description: 'Test tool',
      parameters: {} as never,
      summarize: () => ({ text: overrides.text, details: { ok: true } }),
    },
    { userId: 'user_1', locale: 'zh-CN' },
  );
}

function textOf(result: { content: unknown }): string {
  const [block] = result.content as Array<{ type: string; text?: string }>;
  return block?.text ?? '';
}

describe('summary tool contract', () => {
  it('returns a single bounded text block instead of a payload', async () => {
    const result = await tool({ text: '一行摘要' }).execute('call_1', {} as never);

    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe('text');
    expect(textOf(result)).toBe('一行摘要');
    expect(result.details).toEqual({ ok: true });
  });

  it('truncates long summaries and says so', async () => {
    const result = await tool({ text: '字'.repeat(SUMMARY_CHAR_LIMIT * 2) }).execute(
      'call_2',
      {} as never,
    );
    const text = textOf(result);

    expect(text.length).toBeLessThanOrEqual(SUMMARY_CHAR_LIMIT);
    expect(text.endsWith('（内容过长，已截断）')).toBe(true);
  });

  it('normalizes trailing whitespace and blank-line runs', async () => {
    const result = await tool({ text: '甲   \n\n\n\n乙\t\n' }).execute('call_3', {} as never);

    expect(textOf(result)).toBe('甲\n\n乙');
  });

  it('refuses an empty summary instead of sending an empty tool result', async () => {
    await expect(tool({ text: '   \n  ' }).execute('call_4', {} as never)).rejects.toThrow(
      /empty summary/,
    );
  });

  it('aborts before summarizing when the run is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      tool({ text: '不会到这里' }).execute('call_5', {} as never, controller.signal),
    ).rejects.toThrow();
  });

  // Architecture guard, not a style rule: the one tool that shipped before this
  // contract dumped an entire database payload into the transcript, which is
  // cheap to write and expensive to notice. Serializing inside a tool module is
  // now a test failure, so a future tool has to move that work out of the
  // summary path deliberately.
  it('keeps raw serialization out of every tool module', () => {
    const offenders = readdirSync(TOOLS_DIR)
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .filter((file) => {
        const source = readFileSync(path.join(TOOLS_DIR, file), 'utf8');
        return /JSON\.stringify\s*\(/.test(source);
      });

    expect(offenders).toEqual([]);
  });
});

describe('summaryLines', () => {
  it('drops empty and falsy sections', () => {
    expect(summaryLines('甲', '', null, undefined, false, '乙')).toBe('甲\n乙');
  });
});
