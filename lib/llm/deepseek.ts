import {
  OpenAiCompatibleProvider,
  extractOpenAiDelta,
  type OpenAiCompatibleOptions,
} from './openai-compatible';

// DeepSeek speaks the OpenAI Chat Completions protocol, so it is the shared
// implementation with DeepSeek's endpoint and key as the defaults.
export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
// Flash is the default because the reasoning models take tens of seconds on a
// plan, and this is a planning assistant rather than a maths olympiad.
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-flash';

export { extractOpenAiDelta as extractDeepSeekDelta };

export class DeepSeekProvider extends OpenAiCompatibleProvider {
  constructor(options: { model?: string; baseUrl?: string; apiKey?: string } = {}) {
    const resolved: OpenAiCompatibleOptions = {
      id: 'deepseek',
      label: 'DeepSeek',
      apiKeyEnvVar: 'DEEPSEEK_API_KEY',
      baseUrl: options.baseUrl || process.env.DEEPSEEK_BASE_URL?.trim() || DEFAULT_DEEPSEEK_BASE_URL,
      apiKey: options.apiKey || process.env.DEEPSEEK_API_KEY?.trim(),
      model: options.model || process.env.DEEPSEEK_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL,
    };
    super(resolved);
  }
}
