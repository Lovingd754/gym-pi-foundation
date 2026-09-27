import { AnthropicProvider } from './anthropic';
import { CodexLbProvider } from './codex-lb';
import { CustomProvider } from './custom';
import { DeepSeekProvider } from './deepseek';
import { OpenAiProvider } from './openai';
import { OpenRouterProvider } from './openrouter';
import { DemoProvider } from './demo';
import type { LlmProvider } from './types';

export * from './types';
export type LlmProviderId = LlmProvider['id'];

// Reads LLM_PROVIDER (case-insensitive). Defaults to 'anthropic'; an
// unrecognized value also falls back to 'anthropic'. 'demo' serves canned
// responses (no key needed), useful to try the AI screens.
export function resolveProviderId(): LlmProviderId {
  const raw = process.env.LLM_PROVIDER?.trim().toLowerCase();
  if (raw === 'codex-lb' || raw === 'codex_lb' || raw === 'codexlb') return 'codex-lb';
  if (raw === 'openrouter') return 'openrouter';
  if (raw === 'deepseek') return 'deepseek';
  if (raw === 'openai') return 'openai';
  if (raw === 'demo') return 'demo';
  return 'anthropic';
}

// Builds a provider for an explicit choice. `model`, `baseUrl` and `apiKey` are
// the per-user overrides stored in the database; anything undefined means
// "whatever the deployment configured".
export function createLlmProvider(choice: {
  provider: LlmProviderId;
  model?: string | null;
  baseUrl?: string | null;
  apiKey?: string | null;
}): LlmProvider {
  const options = {
    ...(choice.model ? { model: choice.model } : {}),
    ...(choice.baseUrl ? { baseUrl: choice.baseUrl } : {}),
    ...(choice.apiKey ? { apiKey: choice.apiKey } : {}),
  };
  switch (choice.provider) {
    case 'codex-lb':
      return new CodexLbProvider(options);
    case 'openrouter':
      return new OpenRouterProvider(options);
    case 'deepseek':
      return new DeepSeekProvider(options);
    case 'openai':
      return new OpenAiProvider(options);
    case 'custom':
      // Only reachable with a stored choice: an anonymous custom provider has
      // nothing to point at, so it falls back to the deployment default.
      if (!choice.baseUrl) return new AnthropicProvider();
      return new CustomProvider({
        model: choice.model ?? '',
        baseUrl: choice.baseUrl,
        ...(choice.apiKey ? { apiKey: choice.apiKey } : {}),
      });
    case 'demo':
      return new DemoProvider();
    default:
      return new AnthropicProvider(options);
  }
}

export function getLlmProvider(): LlmProvider {
  return createLlmProvider({ provider: resolveProviderId() });
}
