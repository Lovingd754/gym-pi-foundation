import { describe, expect, it } from 'vitest';
import { Agent } from '@earendil-works/pi-agent-core';
import { createModels, Type } from '@earendil-works/pi-ai';

describe('pinned Pi dependencies', () => {
  it('exports the runtime and schema APIs used by GymPi', () => {
    expect(typeof Agent).toBe('function');
    expect(typeof createModels).toBe('function');
    expect(Type.Object({}).type).toBe('object');
  });
});
