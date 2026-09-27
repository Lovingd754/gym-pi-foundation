import { getLlmProviderFor } from '@/lib/llm/settings';
import type { AgentSkill, RoutedSkillId } from './skills';

// ============================================================
// Which skill is this turn about?
// ============================================================
// The agent's intent recognition used to be implicit: every turn carried every
// tool and every rule, and the model picked. That still happens - the tool call
// *is* the intent - but now a cheap decision in front of it narrows the rules
// and the tools first, and that decision is measurable.
//
// The order is deliberate: patterns are free, deterministic and testable, so
// they answer the turns that are obviously one thing ("把周三挪到周四"). Only
// when nothing matches does a model get asked, because a router call on every
// turn would cost more than the context it saves. When even that fails the turn
// runs as 'general' - every tool, every rule - which is the behaviour that
// existed before skills, so an unclassifiable turn is never a degraded one.

export type IntentSource = 'RULE' | 'MODEL' | 'FALLBACK';

export interface IntentRoute {
  skill: AgentSkill;
  source: IntentSource;
  // The pattern that matched, for the rule path: it makes a misroute
  // reproducible instead of mysterious.
  matched?: string;
  // The router's own words when a model classified the turn.
  reasoning?: string;
}

interface IntentRule {
  skill: RoutedSkillId;
  label: string;
  patterns: readonly RegExp[];
}

// Order matters: the plan patterns run before the logging ones, because "把深蹲
// 换成腿举" and "深蹲 100 公斤 5 次" share a noun and nothing else.
const RULES: readonly IntentRule[] = [
  {
    skill: 'plan',
    label: 'plan-change',
    patterns: [
      /换成|换个|替换|挪到|挪去|改到|调到|减到|加到|去掉|删掉|别安排|不要安排|不想再做|改成/,
      /(这周|下周|今天|明天).{0,6}(练不了|没时间|出差|加班|有事)/,
      /有氧.{0,6}(太多|太少|减|加|调整)/,
      /\b(swap|replace|move|reschedule|reduce|increase)\b.{0,20}\b(plan|day|cardio|session|workout)\b/i,
    ],
  },
  {
    // Where the body stands, not what was lifted: "我体重 71 公斤" is neither a
    // set to log nor a plan change. Put before the logging rules, which would
    // otherwise read the weight as one.
    skill: 'review',
    label: 'body-metric',
    patterns: [/(体重|腰围|体脂|称了|称重)/],
  },
  {
    skill: 'log',
    label: 'log-set',
    patterns: [
      /(做了|练了|完成|记录|记一下|刚做|刚刚做).{0,14}(组|个|次|下)/,
      /\d+(\.\d+)?\s*(公斤|千克|kg|磅|lb|斤)/i,
      /自重.{0,8}\d+\s*(个|次)/,
      /\d+\s*(组|sets?).{0,10}\d+\s*(个|次|reps?)/i,
    ],
  },
  {
    skill: 'review',
    label: 'question',
    patterns: [
      /(我|这|上|今|明).{0,10}(练|计划|安排|吃|睡|有氧).{0,6}(吗|呢|怎么样|多久|多少|什么)/,
      /(怎么|如何|要不要|能不能|该不该|为什么|是不是)/,
      /(记得|记忆|记不记得)/,
      // A question mark after a domain noun is a question, whatever its shape.
      /(计划|安排|训练|练|饮食|吃|睡眠|睡|有氧|体重|腰围|动作|组|记忆)[^?？]{0,12}[?？]/,
      /^\s*(hi|hello|thanks|thank you|ok|okay|bye)\b/i,
      /^\s*(你好|谢谢|好的|嗯|在吗|收到)[。！!～~]*\s*$/,
    ],
  },
];

// No model call, no context: just the patterns. Exported so the evaluation can
// report how much of a turn set the free path covers.
export function routeByRules(message: string): IntentRoute | null {
  const text = message.trim();
  if (text === '') return null;
  // "上周我一共练了几次？" contains a reported-verb and a number, like a logged
  // set does, but it is a question. So on a question the review rules run before
  // the logging ones - intent follows the shape of the sentence, not one word in
  // it - while plan requests keep their priority either way.
  const question = isQuestion(text);
  const ordered = question
    ? [
        ...RULES.filter((rule) => rule.skill !== 'log'),
        ...RULES.filter((rule) => rule.skill === 'log'),
      ]
    : RULES;
  for (const rule of ordered) {
    for (const pattern of rule.patterns) {
      if (pattern.test(text)) {
        return { skill: rule.skill, source: 'RULE', matched: rule.label };
      }
    }
  }
  return null;
}

function isQuestion(text: string): boolean {
  return /[?？]\s*$/.test(text) || /(吗|呢)\s*[。！!？?]*\s*$/.test(text);
}

const CLASSIFY_PROMPT = `Classify ONE message from a fitness-app trainee into exactly one intent.

- "log": they are telling you about sets they did or are doing ("卧推 60 公斤 8 次 3 组", "just did 5 sets of pull-ups").
- "plan": they want their training plan changed ("把周三挪到周四", "有氧减到 60 分钟", "深蹲换个动作").
- "review": they are asking a question about their plan, their training, their body or how they are doing.
- "general": anything else, including small talk and messages too vague to place.

Answer with a single JSON object and nothing else:
{"intent":"log|plan|review|general","reason":"<= 12 words"}`;

export interface RouteIntentDependencies {
  // Kept injectable so the router is testable without a provider.
  classify(input: {
    userId?: string;
    message: string;
  }): Promise<{ intent: string; reason?: string } | null>;
}

const defaultDependencies: RouteIntentDependencies = {
  async classify({ userId, message }) {
    const provider = await getLlmProviderFor(userId);
    const { text } = await provider.complete({
      system: CLASSIFY_PROMPT,
      messages: [{ role: 'user', content: message.slice(0, 500) }],
      // A reasoning model thinks before it answers; the cap only bounds output.
      maxTokens: 1200,
      temperature: 0,
    });
    const match = /\{[\s\S]*\}/.exec(text);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]) as { intent?: unknown; reason?: unknown };
      if (typeof parsed.intent !== 'string') return null;
      return {
        intent: parsed.intent,
        ...(typeof parsed.reason === 'string' ? { reason: parsed.reason } : {}),
      };
    } catch {
      return null;
    }
  },
};

const ROUTED_SKILLS: readonly RoutedSkillId[] = ['log', 'plan', 'review'];

export async function routeIntent(
  message: string,
  options: { userId?: string; dependencies?: RouteIntentDependencies } = {},
): Promise<IntentRoute> {
  const byRule = routeByRules(message);
  if (byRule) return byRule;

  const dependencies = options.dependencies ?? defaultDependencies;
  try {
    const classified = await dependencies.classify({ userId: options.userId, message });
    if (classified && ROUTED_SKILLS.includes(classified.intent as RoutedSkillId)) {
      return {
        skill: classified.intent as RoutedSkillId,
        source: 'MODEL',
        ...(classified.reason ? { reasoning: classified.reason } : {}),
      };
    }
  } catch {
    // A dead provider is not a reason to lose the turn: fall through to general.
  }
  return { skill: 'general', source: 'FALLBACK' };
}
