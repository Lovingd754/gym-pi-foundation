import { describe, expect, it } from 'vitest';
import {
  MEMORY_CONTENT_MAX_CHARS,
  AgentMemoryContentError,
  normalizeMemoryContent,
} from './memory-store';

describe('normalizeMemoryContent', () => {
  it('collapses whitespace so duplicates are recognized as duplicates', () => {
    expect(normalizeMemoryContent('  不喜欢   练有氧 \n')).toBe('不喜欢 练有氧');
  });

  it('rejects an empty note', () => {
    expect(() => normalizeMemoryContent('   ')).toThrow(AgentMemoryContentError);
  });

  it('rejects a note longer than the store accepts', () => {
    expect(() => normalizeMemoryContent('字'.repeat(MEMORY_CONTENT_MAX_CHARS + 1))).toThrow(
      AgentMemoryContentError,
    );
  });

  it('accepts a note exactly at the limit', () => {
    expect(normalizeMemoryContent('字'.repeat(MEMORY_CONTENT_MAX_CHARS))).toHaveLength(
      MEMORY_CONTENT_MAX_CHARS,
    );
  });
});
