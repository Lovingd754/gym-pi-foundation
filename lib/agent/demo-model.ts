import {
  createAssistantMessageEventStream,
  createProvider,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type Provider,
  type SimpleStreamOptions,
  type StreamOptions,
  type TextContent,
  type ToolCall,
  type Usage,
} from '@earendil-works/pi-ai';

// A keyless Pi provider for `LLM_PROVIDER=demo`.
//
// The agent loop is real - system prompt, tools, tool execution, streaming,
// persistence and audit all run exactly as they do with a hosted model. Only
// the model itself is replaced by a small deterministic script, so the whole
// product can be demonstrated (and tested) without an API key.

export const DEMO_AGENT_PROVIDER_ID = 'demo';
export const DEMO_AGENT_API = 'demo-agent';
export const DEMO_AGENT_MODEL_ID = 'demo-agent';

const DEMO_DELAY_MS = 12;
const DEMO_CHUNK_SIZE = 24;
const TOOL_RESULT_EXCERPT_LIMIT = 240;
const QUESTION_EXCERPT_LIMIT = 120;

const DEMO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const DEMO_MODEL: Model<Api> = {
  id: DEMO_AGENT_MODEL_ID,
  name: '演示模型（内置脚本）',
  api: DEMO_AGENT_API,
  provider: DEMO_AGENT_PROVIDER_ID,
  baseUrl: 'http://localhost/demo',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_192,
};

// Questions that should visibly exercise a tool call during a demo. Anything
// else is answered straight from the script, which keeps the demo honest about
// the fact that a real model decides when to reach for data.
const DATA_QUESTION_PATTERN =
  /计划|训练|练|今天|明天|饮食|吃|蛋白|热量|有氧|睡|体重|记录|进度|组|重量|怎么|多少|能不能|可以吗|plan|train|workout|sleep|eat|food|calorie|cardio|weight|today|tomorrow|record/i;

// "Remember that I hate running" style turns. The scripted provider uses them
// to exercise the memory proposal path - including the confirmation card - so
// the whole feature is demonstrable without a model key.
const REMEMBER_PATTERN = /记住|记一下|记下来|remember/i;

// Change requests. The scripted provider answers them with the same two steps a
// real model takes: read the plan, then propose one concrete change.
const CHANGE_PATTERN =
  /换|替代|替换|挪|改到|改成|不想练|少做|swap|replace|reschedule|move my/i;

// "60 kg for 8, three sets" style. The scripted provider turns it into the same
// log_workout call a real model would make, so the confirmation card is
// demonstrable without a key.
const LOG_VOLUME_PATTERN =
  /(\d+(?:\.\d+)?)\s*(?:公斤|kg|千克|磅|lb)\s*[×x*]?\s*(\d+)\s*次(?:\s*[×x*]?\s*(\d+)\s*组)?/i;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}…`;
}

function messageText(content: string | readonly unknown[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) => {
      if (typeof block !== 'object' || block === null) return '';
      const record = block as { type?: string; text?: string };
      return record.type === 'text' ? (record.text ?? '') : '';
    })
    .join('\n');
}

function lastUserText(context: Context): string | undefined {
  for (const message of context.messages.slice().reverse()) {
    if (message.role === 'user') return messageText(message.content as string | unknown[]);
  }
  return undefined;
}

// The tool result of the current turn, if the loop already ran one. Presence is
// what tells the script it is the second model turn.
function currentToolResult(context: Context): { toolName: string; text: string } | undefined {
  for (const message of context.messages.slice().reverse()) {
    if (message.role === 'user') return undefined;
    if (message.role === 'toolResult') {
      return { toolName: message.toolName, text: messageText(message.content as unknown[]) };
    }
  }
  return undefined;
}

function hasCalledTool(context: Context, name: string): boolean {
  return context.messages.some(
    (message) =>
      message.role === 'assistant' &&
      message.content.some((block) => block.type === 'toolCall' && block.name === name),
  );
}

// The demo reads the movement out of the plan summary it just fetched. A real
// model would simply name what it read; the script needs the indented line
// format that summarizePlan() emits.
function firstExerciseName(planSummary: string): string | undefined {
  const match = /^\s{4,}(.+?)\s+\d+/m.exec(planSummary);
  return match?.[1]?.trim();
}

function pickTool(context: Context): string | undefined {
  const names = (context.tools ?? []).map((tool) => tool.name);
  if (names.length === 0) return undefined;

  const preferred = ['get_current_plan', 'get_recent_training', 'get_memories'];
  return preferred.find((name) => names.includes(name)) ?? names[0];
}

function composeAnswer(context: Context): string {
  const question = lastUserText(context) ?? '';
  const toolResult = currentToolResult(context);
  const lines = [
    '（演示模式）当前没有配置模型密钥，所以这条回复来自内置脚本，用来跑通完整的对话流程。',
  ];

  if (toolResult) {
    lines.push(`工具返回：${truncate(toolResult.text, TOOL_RESULT_EXCERPT_LIMIT)}`);
  }

  if (question) {
    lines.push(
      `你的问题是「${truncate(question, QUESTION_EXCERPT_LIMIT)}」。配置模型密钥后，这里会由真实模型结合你的计划、最近训练和记忆来回答，需要改方案时还会先给你差异卡片。`,
    );
  } else {
    lines.push(
      '配置模型密钥后，这里会由真实模型结合你的计划、最近训练和记忆来回答，需要改方案时还会先给你差异卡片。',
    );
  }

  return lines.join('\n\n');
}

// The sentence the trainee would want kept: the message with the "remember
// this" wrapper stripped off, bounded to what the memory store accepts.
function memoryCandidate(question: string): string {
  const trimmed = question.trim();
  const marker = /(记住|记一下|记下来|remember)/i.exec(trimmed);
  const tail = marker ? trimmed.slice(marker.index + marker[0].length) : trimmed;
  const cleaned = tail.replace(/^[\s:：,，。.、-]+/, '').trim();
  const candidate = cleaned === '' ? trimmed : cleaned;
  return candidate.length <= 200 ? candidate : `${candidate.slice(0, 199)}…`;
}

// Demo-only extraction: the exercise is whatever the trainee put in front of the
// load, with the usual lead-in words removed. A real model reads the sentence.
export function demoLogEntry(question: string): {
  exerciseName: string;
  weight: number;
  reps: number;
  sets: number;
} | null {
  const match = LOG_VOLUME_PATTERN.exec(question);
  if (!match || match.index === undefined) return null;
  const before = question
    .slice(0, match.index)
    .replace(/^(今天|昨天|刚才|刚刚|我|练了|做了|记一下|记录一下)[\s，,、:：]*/g, '')
    .trim();
  const exerciseName = before.split(/[\s，,、:：]/).filter(Boolean).pop() ?? '';
  if (exerciseName === '') return null;
  const weight = Number(match[1]);
  const reps = Number(match[2]);
  const sets = match[3] ? Number(match[3]) : 1;
  if (!Number.isFinite(weight) || !Number.isFinite(reps) || reps < 1) return null;
  return { exerciseName, weight, reps, sets: Math.max(1, sets) };
}

function decide(context: Context): AssistantMessage {
  const question = lastUserText(context) ?? '';
  const alreadyRanTool = currentToolResult(context) !== undefined;
  const toolName = alreadyRanTool ? undefined : pickTool(context);

  if (!alreadyRanTool && REMEMBER_PATTERN.test(question)) {
    return {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: `demo-tool-${Date.now().toString(36)}`,
          name: 'propose_memory',
          arguments: { content: memoryCandidate(question) },
        } satisfies ToolCall,
      ],
      api: DEMO_AGENT_API,
      provider: DEMO_AGENT_PROVIDER_ID,
      model: DEMO_AGENT_MODEL_ID,
      usage: DEMO_USAGE,
      stopReason: 'toolUse',
      timestamp: Date.now(),
    };
  }

  if (!alreadyRanTool) {
    const entry = demoLogEntry(question);
    if (entry) {
      return {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: `demo-tool-${Date.now().toString(36)}`,
            name: 'log_workout',
            arguments: entry,
          } satisfies ToolCall,
        ],
        api: DEMO_AGENT_API,
        provider: DEMO_AGENT_PROVIDER_ID,
        model: DEMO_AGENT_MODEL_ID,
        usage: DEMO_USAGE,
        stopReason: 'toolUse',
        timestamp: Date.now(),
      };
    }
  }

  if (alreadyRanTool && CHANGE_PATTERN.test(question)) {
    const result = currentToolResult(context);
    if (result?.toolName === 'get_current_plan' && !hasCalledTool(context, 'propose_plan_change')) {
      const exerciseName = firstExerciseName(result.text);
      if (exerciseName) {
        return {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: `demo-tool-${Date.now().toString(36)}`,
              name: 'propose_plan_change',
              arguments: { changeType: 'swap_exercise', exerciseName },
            } satisfies ToolCall,
          ],
          api: DEMO_AGENT_API,
          provider: DEMO_AGENT_PROVIDER_ID,
          model: DEMO_AGENT_MODEL_ID,
          usage: DEMO_USAGE,
          stopReason: 'toolUse',
          timestamp: Date.now(),
        };
      }
    }
  }

  if (!alreadyRanTool && CHANGE_PATTERN.test(question)) {
    return {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: `demo-tool-${Date.now().toString(36)}`,
          name: 'get_current_plan',
          arguments: {},
        } satisfies ToolCall,
      ],
      api: DEMO_AGENT_API,
      provider: DEMO_AGENT_PROVIDER_ID,
      model: DEMO_AGENT_MODEL_ID,
      usage: DEMO_USAGE,
      stopReason: 'toolUse',
      timestamp: Date.now(),
    };
  }

  if (toolName && DATA_QUESTION_PATTERN.test(question)) {
    const toolCall: ToolCall = {
      type: 'toolCall',
      id: `demo-tool-${Date.now().toString(36)}`,
      name: toolName,
      arguments: {},
    };
    return {
      role: 'assistant',
      content: [toolCall],
      api: DEMO_AGENT_API,
      provider: DEMO_AGENT_PROVIDER_ID,
      model: DEMO_AGENT_MODEL_ID,
      usage: DEMO_USAGE,
      stopReason: 'toolUse',
      timestamp: Date.now(),
    };
  }

  return {
    role: 'assistant',
    content: [{ type: 'text', text: composeAnswer(context) }],
    api: DEMO_AGENT_API,
    provider: DEMO_AGENT_PROVIDER_ID,
    model: DEMO_AGENT_MODEL_ID,
    usage: DEMO_USAGE,
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

function chunkText(text: string): string[] {
  if (text === '') return [''];
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += DEMO_CHUNK_SIZE) {
    chunks.push(text.slice(index, index + DEMO_CHUNK_SIZE));
  }
  return chunks;
}

function abortedMessage(partial: AssistantMessage): AssistantMessage {
  return {
    ...partial,
    stopReason: 'aborted',
    errorMessage: 'Request was aborted',
    timestamp: Date.now(),
  };
}

function streamScripted(
  message: AssistantMessage,
  options?: StreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const signal = options?.signal;

  queueMicrotask(async () => {
    const partial: AssistantMessage = { ...message, content: [], stopReason: 'pending' };

    if (signal?.aborted) {
      const aborted = abortedMessage(partial);
      stream.push({ type: 'error', reason: 'aborted', error: aborted });
      stream.end(aborted);
      return;
    }

    stream.push({ type: 'start', partial: { ...partial } });

    for (const [index, block] of message.content.entries()) {
      if (block.type === 'text') {
        partial.content = [...partial.content, { type: 'text', text: '' }];
        stream.push({ type: 'text_start', contentIndex: index, partial: { ...partial } });
        for (const chunk of chunkText(block.text)) {
          await delay(DEMO_DELAY_MS);
          if (signal?.aborted) {
            const aborted = abortedMessage(partial);
            stream.push({ type: 'error', reason: 'aborted', error: aborted });
            stream.end(aborted);
            return;
          }
          (partial.content[index] as TextContent).text += chunk;
          stream.push({
            type: 'text_delta',
            contentIndex: index,
            delta: chunk,
            partial: { ...partial },
          });
        }
        stream.push({
          type: 'text_end',
          contentIndex: index,
          content: block.text,
          partial: { ...partial },
        });
        continue;
      }

      if (block.type === 'toolCall') {
        partial.content = [
          ...partial.content,
          { type: 'toolCall', id: block.id, name: block.name, arguments: block.arguments },
        ];
        stream.push({ type: 'toolcall_start', contentIndex: index, partial: { ...partial } });
        stream.push({
          type: 'toolcall_delta',
          contentIndex: index,
          delta: JSON.stringify(block.arguments),
          partial: { ...partial },
        });
        stream.push({
          type: 'toolcall_end',
          contentIndex: index,
          toolCall: block,
          partial: { ...partial },
        });
      }
    }

    const final: AssistantMessage = { ...message, timestamp: message.timestamp };
    const reason = message.stopReason === 'toolUse' ? 'toolUse' : 'stop';
    stream.push({ type: 'done', reason, message: final });
    stream.end(final);
  });

  return stream;
}

export function createDemoAgentProvider(): Provider {
  return createProvider({
    id: DEMO_AGENT_PROVIDER_ID,
    name: '演示（内置脚本）',
    baseUrl: DEMO_MODEL.baseUrl,
    auth: {
      apiKey: {
        name: '演示模式（无需密钥）',
        // Keyless by design: reporting a resolved credential is what makes
        // Models.getAuth() treat the provider as configured.
        resolve: async () => ({ auth: {}, source: 'demo' }),
      },
    },
    models: [DEMO_MODEL],
    api: {
      stream: (model, context, options) => streamScripted(decide(context), options),
      streamSimple: (model, context, options: SimpleStreamOptions | undefined) =>
        streamScripted(decide(context), options),
    },
  });
}

export const demoAgentModel: Model<Api> = DEMO_MODEL;
