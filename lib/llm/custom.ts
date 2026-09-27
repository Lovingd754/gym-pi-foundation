import { OpenAiCompatibleProvider } from './openai-compatible';

// A relay, a gateway, a local server: anything that speaks Chat Completions.
// The trainee supplies the endpoint and the key, and the model name is free
// text because only they know what their endpoint serves.
export class CustomProvider extends OpenAiCompatibleProvider {
  constructor(options: { model: string; baseUrl: string; apiKey?: string }) {
    super({
      id: 'custom',
      label: 'Custom endpoint',
      apiKeyEnvVar: '',
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      model: options.model,
    });
  }
}
