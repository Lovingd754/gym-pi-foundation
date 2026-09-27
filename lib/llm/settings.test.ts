import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LlmChoiceError,
  MODEL_SUGGESTIONS,
  PROVIDER_OPTIONS,
  deploymentChoice,
  isSupportedProvider,
  listProviderOptions,
  providerOption,
  validateChoice,
} from './settings';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('provider options', () => {
  it('offers the hosted providers, a custom endpoint and the demo script', () => {
    const providers = PROVIDER_OPTIONS.map((option) => option.provider);

    expect(providers).toEqual(
      expect.arrayContaining(['deepseek', 'anthropic', 'openai', 'openrouter', 'custom', 'demo']),
    );
  });

  it('treats only the custom endpoint as needing an endpoint', () => {
    expect(providerOption('custom')?.needsEndpoint).toBe(true);
    expect(providerOption('deepseek')?.needsEndpoint).toBe(false);
    expect(providerOption('openai')?.needsEndpoint).toBe(false);
  });

  it('offers model names as examples, never as the only allowed values', () => {
    expect(MODEL_SUGGESTIONS.deepseek?.map((model) => model.id)).toContain('deepseek-v4-flash');
    // The custom provider cannot know what its endpoint serves, so its hint is
    // deliberately generic.
    expect(MODEL_SUGGESTIONS.custom?.length).toBeGreaterThan(0);
  });

  it('reports which providers can run without a per-user key', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key');

    const options = listProviderOptions();

    expect(options.find((option) => option.provider === 'deepseek')?.configured).toBe(true);
    // Demo needs no key by design.
    expect(options.find((option) => option.provider === 'demo')?.configured).toBe(true);
  });

  it('knows which provider ids are real', () => {
    expect(isSupportedProvider('deepseek')).toBe(true);
    expect(isSupportedProvider('not-a-provider')).toBe(false);
  });
});

describe('validateChoice', () => {
  it('accepts a model name the app has never heard of', () => {
    // The whole point of the free-text field: a relay serving something new.
    expect(() =>
      validateChoice({
        provider: 'custom',
        model: 'some-model-from-a-relay',
        baseUrl: 'https://relay.example.com/v1',
      }),
    ).not.toThrow();
  });

  it('requires an endpoint for a custom provider', () => {
    expect(() => validateChoice({ provider: 'custom', model: 'x', baseUrl: null })).toThrow(
      LlmChoiceError,
    );
  });

  it('requires a model name only where the app cannot supply one', () => {
    // The custom endpoint serves something we have never heard of.
    expect(() =>
      validateChoice({ provider: 'custom', model: '  ', baseUrl: 'https://relay.example.com/v1' }),
    ).toThrow(LlmChoiceError);
    // For a known provider a blank field means "that provider's own default".
    expect(() => validateChoice({ provider: 'deepseek', model: '  ', baseUrl: null })).not.toThrow();
    expect(() => validateChoice({ provider: 'demo', model: null, baseUrl: null })).not.toThrow();
  });

  it('refuses an endpoint that is not an http url', () => {
    for (const baseUrl of ['not a url', 'ftp://example.com', 'file:///etc/passwd']) {
      expect(() => validateChoice({ provider: 'custom', model: 'x', baseUrl })).toThrow(
        LlmChoiceError,
      );
    }
  });

  it('refuses an unknown provider', () => {
    expect(() =>
      validateChoice({ provider: 'nope' as never, model: 'x', baseUrl: null }),
    ).toThrow(LlmChoiceError);
  });
});

describe('deploymentChoice', () => {
  it('follows LLM_PROVIDER and carries no overrides', () => {
    vi.stubEnv('LLM_PROVIDER', 'deepseek');

    expect(deploymentChoice()).toEqual({
      provider: 'deepseek',
      model: null,
      baseUrl: null,
      apiKey: null,
      source: 'DEPLOYMENT',
    });
  });

  it('falls back to anthropic for an unknown value', () => {
    vi.stubEnv('LLM_PROVIDER', 'something-else');

    expect(deploymentChoice().provider).toBe('anthropic');
  });
});
