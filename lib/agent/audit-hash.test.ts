import { describe, expect, it, vi } from 'vitest';
import { hashAuditValue } from './audit-hash';

describe('hashAuditValue', () => {
  it('is stable across nested object key order', () => {
    const first = {
      sessionId: 'session-secret',
      filters: { end: '2026-09-13', start: '2026-09-01' },
    };
    const second = {
      filters: { start: '2026-09-01', end: '2026-09-13' },
      sessionId: 'session-secret',
    };

    expect(hashAuditValue(first)).toBe(hashAuditValue(second));
    expect(hashAuditValue(first)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not return the sensitive source value', () => {
    expect(hashAuditValue({ message: 'private health note' })).not.toContain('private health note');
  });

  it('uses locale-independent ordinal key ordering', () => {
    const localeCompare = vi.spyOn(String.prototype, 'localeCompare');

    hashAuditValue({ ä: 1, z: 2, 阿: 3 });

    expect(localeCompare).not.toHaveBeenCalled();
  });
});
