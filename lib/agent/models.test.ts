import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAgentModelRequest, resolveAgentModel } from './models';

// The resolver reads the trainee's stored choice; with no user it falls back to
// whatever the deployment configured, which is what these tests exercise.

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveAgentModel', () => {
  it('describes the requested model without requiring credentials', async () => {
    vi.stubEnv('LLM_PROVIDER', 'anthropic');
    vi.stubEnv('ANTHROPIC_MODEL', 'claude-opus-4-7');

    expect(await getAgentModelRequest()).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
    });
  });

  it('uses a stable placeholder for unsupported provider models', async () => {
    vi.stubEnv('LLM_PROVIDER', 'codex-lb');

    expect(await getAgentModelRequest()).toEqual({
      provider: 'codex-lb',
      model: 'unresolved',
    });
  });

  it('routes the demo provider to the built-in scripted model', async () => {
    vi.stubEnv('LLM_PROVIDER', 'demo');

    expect(await getAgentModelRequest()).toEqual({
      provider: 'demo',
      model: 'demo-agent',
    });
  });

  it('resolves the existing Anthropic default through Pi', async () => {
    vi.stubEnv('LLM_PROVIDER', 'anthropic');
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    vi.stubEnv('ANTHROPIC_MODEL', 'claude-opus-4-7');

    const resolved = await resolveAgentModel();

    expect(resolved.model.provider).toBe('anthropic');
    expect(resolved.model.id).toBe('claude-opus-4-7');
  });

  it('resolves the existing OpenRouter default through Pi', async () => {
    vi.stubEnv('LLM_PROVIDER', 'openrouter');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('OPENROUTER_MODEL', 'anthropic/claude-sonnet-4.5');

    const resolved = await resolveAgentModel();

    expect(resolved.model.provider).toBe('openrouter');
    expect(resolved.model.id).toBe('anthropic/claude-sonnet-4.5');
  });

  it('resolves the keyless demo provider so the loop runs without credentials', async () => {
    vi.stubEnv('LLM_PROVIDER', 'demo');

    const resolved = await resolveAgentModel();

    expect(resolved.model.provider).toBe('demo');
    expect(resolved.model.id).toBe('demo-agent');
  });

  it('rejects the legacy codex-lb provider only on the Pi path', async () => {
    vi.stubEnv('LLM_PROVIDER', 'codex-lb');

    await expect(resolveAgentModel()).rejects.toEqual(
      expect.objectContaining({
        code: 'PI_PROVIDER_UNSUPPORTED',
      }),
    );
  });

  it('rejects a model absent from the pinned Pi catalog', async () => {
    vi.stubEnv('LLM_PROVIDER', 'openrouter');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('OPENROUTER_MODEL', 'not-a-catalog-model');

    await expect(resolveAgentModel()).rejects.toEqual(
      expect.objectContaining({
        code: 'PI_MODEL_UNAVAILABLE',
      }),
    );
  });

  it('rejects missing provider credentials before a run starts', async () => {
    vi.stubEnv('LLM_PROVIDER', 'anthropic');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('ANTHROPIC_OAUTH_TOKEN', '');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '');

    await expect(resolveAgentModel()).rejects.toEqual(
      expect.objectContaining({
        code: 'PI_AUTH_MISSING',
      }),
    );
  });
});
