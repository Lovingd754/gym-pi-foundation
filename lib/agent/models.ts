import { createModels, createProvider, type Api, type Model } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { resolveLlmChoice, type ResolvedLlmChoice } from '@/lib/llm/settings';
import { createDemoAgentProvider, DEMO_AGENT_MODEL_ID, DEMO_AGENT_PROVIDER_ID } from './demo-model';

export type AgentConfigurationCode =
  | 'PI_PROVIDER_UNSUPPORTED'
  | 'PI_MODEL_UNAVAILABLE'
  | 'PI_AUTH_MISSING';

export class AgentConfigurationError extends Error {
  constructor(readonly code: AgentConfigurationCode) {
    super(code);
    this.name = 'AgentConfigurationError';
  }
}

export interface ResolvedAgentModel {
  models: ReturnType<typeof createModels>;
  model: Model<Api>;
}

export interface AgentModelRequest {
  provider: string;
  model: string;
}

export function createAgentModels(): ReturnType<typeof createModels> {
  const models = createModels();
  models.setProvider(anthropicProvider());
  models.setProvider(openrouterProvider());
  models.setProvider(deepseekProvider());
  models.setProvider(createDemoAgentProvider());
  return models;
}

interface AgentProviderDefinition {
  // Pi's provider id differs from ours for one entry only: our demo model is a
  // local provider, not a hosted one.
  piProvider: string;
  defaultModel: string;
  modelEnvVar?: string;
  // Set when the endpoint may be replaced by the trainee's own.
  openAiCompatible?: boolean;
}

const AGENT_PROVIDERS: Record<string, AgentProviderDefinition> = {
  [DEMO_AGENT_PROVIDER_ID]: { piProvider: DEMO_AGENT_PROVIDER_ID, defaultModel: DEMO_AGENT_MODEL_ID },
  deepseek: {
    piProvider: 'deepseek',
    defaultModel: 'deepseek-v4-flash',
    modelEnvVar: 'DEEPSEEK_MODEL',
  },
  anthropic: {
    piProvider: 'anthropic',
    defaultModel: 'claude-opus-4-7',
    modelEnvVar: 'ANTHROPIC_MODEL',
  },
  openrouter: {
    piProvider: 'openrouter',
    defaultModel: 'anthropic/claude-sonnet-4.5',
    modelEnvVar: 'OPENROUTER_MODEL',
    openAiCompatible: true,
  },
  openai: {
    piProvider: 'openai',
    defaultModel: 'gpt-5.1',
    modelEnvVar: 'OPENAI_MODEL',
    openAiCompatible: true,
  },
  custom: {
    piProvider: 'custom',
    defaultModel: '',
    openAiCompatible: true,
  },
};

// The trainee's own choice wins over the deployment default, so switching models
// in settings changes what actually answers them.
export async function getAgentModelRequest(userId?: string): Promise<AgentModelRequest> {
  const choice = await resolveLlmChoice(userId);
  const definition = AGENT_PROVIDERS[choice.provider];
  if (!definition) return { provider: choice.provider, model: 'unresolved' };
  if (definition.modelEnvVar === undefined && choice.model === null) {
    return { provider: choice.provider, model: definition.defaultModel };
  }
  return {
    provider: choice.provider,
    model:
      choice.model ??
      (definition.modelEnvVar ? process.env[definition.modelEnvVar]?.trim() : undefined) ??
      definition.defaultModel,
  };
}

export function modelRequestFor(choice: ResolvedLlmChoice, request: AgentModelRequest) {
  return { choice, request };
}

export async function resolveAgentModel(userId?: string): Promise<ResolvedAgentModel> {
  const choice = await resolveLlmChoice(userId);
  const request = await getAgentModelRequest(userId);
  const provider = request.provider;
  const definition = AGENT_PROVIDERS[provider];
  if (!definition) {
    throw new AgentConfigurationError('PI_PROVIDER_UNSUPPORTED');
  }

  const models = createAgentModels();
  // A trainee-supplied endpoint is registered per run: its base URL and key are
  // theirs, so it cannot live in the shared provider table.
  if (definition.openAiCompatible && choice.baseUrl) {
    models.setProvider(
      createProvider({
        id: definition.piProvider,
        name: definition.piProvider,
        baseUrl: choice.baseUrl,
        auth: {
          apiKey: {
            name: `${definition.piProvider} key`,
            resolve: async () => ({
              auth: choice.apiKey ? { apiKey: choice.apiKey } : {},
              source: choice.apiKey ? 'stored credential' : 'no key',
            }),
          },
        },
        models: [
          {
            id: request.model,
            name: request.model,
            api: 'openai-completions',
            provider: definition.piProvider,
            baseUrl: choice.baseUrl,
            reasoning: false,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 8_192,
          },
        ],
        api: openAICompletionsApi(),
      }),
    );
  }
  const model = models.getModel(definition.piProvider, request.model);
  if (!model) {
    throw new AgentConfigurationError('PI_MODEL_UNAVAILABLE');
  }
  if (!(await models.getAuth(model))) {
    throw new AgentConfigurationError('PI_AUTH_MISSING');
  }
  return { models, model };
}
