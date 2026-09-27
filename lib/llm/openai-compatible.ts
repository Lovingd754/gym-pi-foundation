import {
  LlmError,
  type LlmCompletionRequest,
  type LlmCompletionResult,
  type LlmProvider,
} from './types';

// ============================================================
// Any OpenAI-compatible Chat Completions endpoint
// ============================================================
// DeepSeek, OpenAI, OpenRouter and whatever relay or self-hosted gateway the
// trainee points us at all speak the same wire protocol. One implementation
// means a new endpoint is a row of configuration rather than a new provider.

const DEFAULT_MAX_TOKENS = 8000;

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{
    message?: { role: string; content: string; reasoning_content?: string };
    finish_reason?: string;
  }>;
  usage?: {
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  error?: { message: string };
}

// Parses one SSE line. Returns the text delta, or null for keep-alives, the
// [DONE] sentinel and non-data lines.
export function extractOpenAiDelta(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const payload = trimmed.slice(5).trim();
  if (payload === '' || payload === '[DONE]') return null;
  try {
    const json = JSON.parse(payload) as {
      choices?: Array<{ delta?: { content?: string } }>;
    };
    return json.choices?.[0]?.delta?.content ?? null;
  } catch {
    return null;
  }
}

export interface OpenAiCompatibleOptions {
  id: LlmProvider['id'];
  label: string;
  apiKeyEnvVar: string;
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  // Extra request headers, e.g. OpenRouter's attribution pair.
  headers?: Record<string, string>;
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id: LlmProvider['id'];
  readonly label: string;
  readonly apiKeyEnvVar: string;
  readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(options: OpenAiCompatibleOptions) {
    this.id = options.id;
    this.label = options.label;
    this.apiKeyEnvVar = options.apiKeyEnvVar;
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.headers = options.headers ?? {};
  }

  isConfigured(): boolean {
    // A key is required for every hosted endpoint; a local server may not need
    // one, which is why the custom provider treats an empty key as "no header".
    return this.baseUrl !== '';
  }

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResult> {
    const res = await this.request(req, false);
    const json = (await res.json()) as ChatCompletionResponse;
    if (json.error) throw new LlmError(502, `${this.label}: ${json.error.message}`);
    const choice = json.choices?.[0];
    const text = choice?.message?.content?.trim();
    if (!text) throw new LlmError(502, this.emptyResponseMessage(choice, json));
    return { text, modelUsed: json.model ?? this.model };
  }

  async *stream(req: LlmCompletionRequest): AsyncIterable<string> {
    const res = await this.request(req, true);
    if (!res.body) throw new LlmError(502, `${this.label} returned no response body.`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const delta = extractOpenAiDelta(line);
        if (delta) yield delta;
      }
    }
    const tail = extractOpenAiDelta(buffer);
    if (tail) yield tail;
  }

  private emptyResponseMessage(
    choice: NonNullable<ChatCompletionResponse['choices']>[number] | undefined,
    json: ChatCompletionResponse,
  ): string {
    if (choice?.finish_reason === 'length') {
      // Reasoning models spend the output budget thinking first; an empty answer
      // with finish_reason=length is a budget problem, not a model failure, and
      // saying so is the difference between a five-minute fix and an afternoon.
      const reasoning = json.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
      return `${this.label} stopped at the output limit before writing an answer (${reasoning} tokens of reasoning). Raise maxTokens for this call.`;
    }
    return `Empty response from ${this.label}.`;
  }

  private async request(req: LlmCompletionRequest, stream: boolean): Promise<Response> {
    if (this.baseUrl === '') {
      throw new LlmError(503, `${this.label} has no endpoint configured.`);
    }

    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: req.system },
        ...req.messages.map((message) => ({ role: message.role, content: message.content })),
      ],
      ...(req.temperature != null ? { temperature: req.temperature } : {}),
      ...(this.id === 'deepseek' && req.thinking !== undefined
        ? { thinking: { type: req.thinking ? 'enabled' : 'disabled' } }
        : {}),
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(stream ? { stream: true } : {}),
    };

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          ...this.headers,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new LlmError(
        502,
        `Network failure to ${this.label}: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
    if (!res.ok) {
      const text = await res.text();
      throw new LlmError(res.status, `${this.label} ${res.status}: ${text.slice(0, 500)}`);
    }
    return res;
  }
}
