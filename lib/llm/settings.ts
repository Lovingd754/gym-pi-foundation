import { db } from '@/lib/db';
import { createLlmProvider, resolveProviderId, type LlmProviderId } from './index';

// ============================================================
// Which model thinks for this trainee
// ============================================================
// Two layers, deployment first: the environment picks the default for the whole
// install, and a trainee may override it for their own account. The override is
// stored on the user row, so it follows them across devices and reaches every
// server-side model call.
//
// Nothing here restricts the model name. The list below is *suggestions* - what
// the picker shows as examples - because the trainee may be pointing at a relay,
// a gateway or a local server that serves something we have never heard of. A
// closed list would make the feature useless for exactly the case it exists for.

export interface ModelSuggestion {
  id: string;
  label: string;
}

export interface ProviderOption {
  provider: LlmProviderId;
  label: string;
  // The environment variable that has to hold a key for this provider to work
  // without a per-user key.
  apiKeyEnvVar: string;
  defaultModel: string;
  defaultBaseUrl: string;
  // Whether the endpoint is required rather than optional.
  needsEndpoint: boolean;
}

export const PROVIDER_OPTIONS: readonly ProviderOption[] = [
  {
    provider: 'deepseek',
    label: 'DeepSeek',
    apiKeyEnvVar: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-v4-flash',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    needsEndpoint: false,
  },
  {
    provider: 'anthropic',
    label: 'Anthropic',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-opus-4-7',
    defaultBaseUrl: 'https://api.anthropic.com',
    needsEndpoint: false,
  },
  {
    provider: 'openai',
    label: 'OpenAI',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    defaultModel: 'gpt-5.1',
    defaultBaseUrl: 'https://api.openai.com/v1',
    needsEndpoint: false,
  },
  {
    provider: 'openrouter',
    label: 'OpenRouter',
    apiKeyEnvVar: 'OPENROUTER_API_KEY',
    defaultModel: 'anthropic/claude-sonnet-4.5',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    needsEndpoint: false,
  },
  {
    provider: 'custom',
    label: '自定义（中转站／自建网关）',
    apiKeyEnvVar: '',
    defaultModel: '',
    defaultBaseUrl: '',
    needsEndpoint: true,
  },
  {
    provider: 'demo',
    label: '演示模型（无需密钥）',
    apiKeyEnvVar: '',
    defaultModel: 'demo-agent',
    defaultBaseUrl: '',
    needsEndpoint: false,
  },
] as const;

// Examples only: what the model field shows as a hint and offers in a datalist.
export const MODEL_SUGGESTIONS: Record<string, ModelSuggestion[]> = {
  deepseek: [
    { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash（快）' },
    { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro（更慢，更会推理）' },
  ],
  anthropic: [
    { id: 'claude-opus-4-7', label: 'claude-opus-4-7' },
    { id: 'claude-sonnet-4-5', label: 'claude-sonnet-4-5' },
    { id: 'claude-haiku-4-5', label: 'claude-haiku-4-5' },
  ],
  openai: [
    { id: 'gpt-5.1', label: 'gpt-5.1' },
    { id: 'gpt-5.1-mini', label: 'gpt-5.1-mini' },
  ],
  openrouter: [
    { id: 'anthropic/claude-sonnet-4.5', label: 'anthropic/claude-sonnet-4.5' },
    { id: 'deepseek/deepseek-chat', label: 'deepseek/deepseek-chat' },
    { id: 'openai/gpt-5.1', label: 'openai/gpt-5.1' },
  ],
  custom: [{ id: 'deepseek-v4-flash', label: '照抄上游的模型名即可' }],
  demo: [{ id: 'demo-agent', label: '内置脚本' }],
};

export function providerOption(provider: string): ProviderOption | undefined {
  return PROVIDER_OPTIONS.find((option) => option.provider === provider);
}

export function isSupportedProvider(provider: string): provider is LlmProviderId {
  return providerOption(provider) !== undefined;
}

export interface ResolvedLlmChoice {
  provider: LlmProviderId;
  // Null means "use the provider's own default": the env var or the built-in.
  model: string | null;
  baseUrl: string | null;
  // Present only when the trainee stored one. Never sent to the browser.
  apiKey: string | null;
  source: 'USER' | 'DEPLOYMENT';
}

export function deploymentChoice(): ResolvedLlmChoice {
  return { provider: resolveProviderId(), model: null, baseUrl: null, apiKey: null, source: 'DEPLOYMENT' };
}

export async function resolveLlmChoice(userId?: string): Promise<ResolvedLlmChoice> {
  if (!userId) return deploymentChoice();

  let user: {
    llmProvider: string | null;
    llmModel: string | null;
    llmBaseUrl: string | null;
    llmApiKey: string | null;
  } | null;
  try {
    user = await db.user.findUnique({
      where: { id: userId },
      select: { llmProvider: true, llmModel: true, llmBaseUrl: true, llmApiKey: true },
    });
  } catch {
    // The choice is a preference, not a prerequisite: a lookup that fails must
    // fall back to the deployment default rather than stop the assistant from
    // answering.
    return deploymentChoice();
  }

  const provider = user?.llmProvider;
  if (!provider || !isSupportedProvider(provider)) return deploymentChoice();
  return {
    provider,
    model: user?.llmModel ?? null,
    baseUrl: user?.llmBaseUrl ?? null,
    apiKey: user?.llmApiKey ?? null,
    source: 'USER',
  };
}

// The one call server code should use: resolve the trainee's choice, then build
// the provider that matches it.
export async function getLlmProviderFor(userId?: string) {
  return createLlmProvider(await resolveLlmChoice(userId));
}

export interface LlmChoiceInput {
  provider: LlmProviderId;
  model: string | null;
  baseUrl: string | null;
  // undefined keeps the stored key; null clears it; a string replaces it.
  apiKey?: string | null;
}

export class LlmChoiceError extends Error {
  constructor(readonly code: 'UNKNOWN_PROVIDER' | 'MODEL_REQUIRED' | 'ENDPOINT_REQUIRED' | 'INVALID_ENDPOINT') {
    super(code);
    this.name = 'LlmChoiceError';
  }
}

// The model name and the endpoint are free text. What is validated is only what
// would otherwise fail silently at request time: a missing endpoint for a custom
// provider, or a URL that is not a URL.
export function validateChoice(input: LlmChoiceInput): void {
  const option = providerOption(input.provider);
  if (!option) throw new LlmChoiceError('UNKNOWN_PROVIDER');

  // A model is required only where we cannot supply one: the custom endpoint.
  // For a known provider, a blank field means "use that provider's own default",
  // which is friendlier than refusing to save.
  if (option.defaultModel === '' && !input.model?.trim()) {
    throw new LlmChoiceError('MODEL_REQUIRED');
  }
  if (option.needsEndpoint && !input.baseUrl?.trim()) {
    throw new LlmChoiceError('ENDPOINT_REQUIRED');
  }
  if (input.baseUrl?.trim()) {
    try {
      const url = new URL(input.baseUrl.trim());
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('not http');
      }
    } catch {
      throw new LlmChoiceError('INVALID_ENDPOINT');
    }
  }
}

export async function setUserLlmChoice(userId: string, input: LlmChoiceInput): Promise<void> {
  validateChoice(input);
  await db.user.update({
    where: { id: userId },
    data: {
      llmProvider: input.provider,
      llmModel: input.model?.trim() || null,
      llmBaseUrl: input.baseUrl?.trim() || null,
      ...(input.apiKey === undefined ? {} : { llmApiKey: input.apiKey?.trim() || null }),
    },
  });
}

export async function clearUserLlmChoice(userId: string): Promise<void> {
  await db.user.update({
    where: { id: userId },
    data: { llmProvider: null, llmModel: null, llmBaseUrl: null, llmApiKey: null },
  });
}

// What the interface shows. The API key is deliberately reduced to a boolean:
// it is write-only, so a page can never read a stored secret back out.
export interface ProviderOptionView extends ProviderOption {
  configured: boolean;
  suggestions: ModelSuggestion[];
}

export function listProviderOptions(): ProviderOptionView[] {
  return PROVIDER_OPTIONS.map((option) => ({
    ...option,
    configured: option.provider === 'demo' || createLlmProvider({ provider: option.provider }).isConfigured(),
    suggestions: MODEL_SUGGESTIONS[option.provider] ?? [],
  }));
}

export interface CurrentChoiceView {
  provider: LlmProviderId;
  model: string | null;
  baseUrl: string | null;
  hasKey: boolean;
  source: 'USER' | 'DEPLOYMENT';
}

export function toChoiceView(choice: ResolvedLlmChoice): CurrentChoiceView {
  return {
    provider: choice.provider,
    model: choice.model,
    baseUrl: choice.baseUrl,
    hasKey: choice.apiKey !== null,
    source: choice.source,
  };
}
