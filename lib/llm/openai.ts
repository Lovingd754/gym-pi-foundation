import { OpenAiCompatibleProvider } from './openai-compatible';

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_OPENAI_MODEL = 'gpt-5.1';

export class OpenAiProvider extends OpenAiCompatibleProvider {
  constructor(options: { model?: string; baseUrl?: string; apiKey?: string } = {}) {
    super({
      id: 'openai',
      label: 'OpenAI',
      apiKeyEnvVar: 'OPENAI_API_KEY',
      baseUrl: options.baseUrl || process.env.OPENAI_BASE_URL?.trim() || DEFAULT_OPENAI_BASE_URL,
      apiKey: options.apiKey || process.env.OPENAI_API_KEY?.trim(),
      model: options.model || process.env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL,
    });
  }
}
