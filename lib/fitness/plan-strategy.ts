import type { LlmMessage } from '@/lib/llm';
import { getLlmProviderFor } from '@/lib/llm/settings';
import { STRENGTH_EXERCISE_CATALOG } from './exercise-catalog';
import { exerciseCatalogKeys, type ExerciseCatalogKey } from './exercise-keys';

// ============================================================
// Plan strategy (model-owned, rule-bounded)
// ============================================================
// The plan generator is deterministic, which is what makes it safe but also
// what makes it deaf to anything the trainee says in their own words. The
// strategy is the one place a model gets a say, and it is deliberately narrow:
// it may only pick catalog exercises to avoid or prefer and pick one of three
// cardio stances. Every number - sets, reps, calories, minutes, bedtime - is
// still computed by the rules.
//
// Everything here is best-effort. A missing key, a dead provider or a
// hallucinated exercise key all resolve to the neutral strategy, which is the
// plan the app produced before this existed. The product must stay useful
// without a model, so a strategy is an improvement, never a dependency.

export type CardioPreference = 'MINIMAL' | 'STANDARD' | 'MORE';

export interface PlanStrategy {
  avoidCatalogKeys: ExerciseCatalogKey[];
  preferCatalogKeys: ExerciseCatalogKey[];
  cardioPreference: CardioPreference;
  // One short sentence the trainee sees on the preview: why the plan looks the
  // way it does. Null when no model shaped it.
  rationale: string | null;
  // 'MODEL' when a model produced this, 'DEFAULT' when it fell back.
  source: 'MODEL' | 'DEFAULT';
}

export const NEUTRAL_STRATEGY: PlanStrategy = Object.freeze({
  avoidCatalogKeys: [],
  preferCatalogKeys: [],
  cardioPreference: 'STANDARD',
  rationale: null,
  source: 'DEFAULT',
});

const catalogKeySet = new Set<string>(exerciseCatalogKeys);
const RATIONALE_MAX_CHARS = 240;

export const STRATEGY_PROMPT_MARKER = 'PLAN-STRATEGY';

function catalogKey(value: unknown): ExerciseCatalogKey | null {
  return typeof value === 'string' && catalogKeySet.has(value)
    ? (value as ExerciseCatalogKey)
    : null;
}

function keyList(value: unknown): ExerciseCatalogKey[] {
  if (!Array.isArray(value)) return [];
  const keys: ExerciseCatalogKey[] = [];
  for (const entry of value) {
    const key = catalogKey(entry);
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

// Anything the model gets wrong is dropped rather than rejected: a strategy is
// a hint, and a plan built from a partially-understood hint is still a plan the
// rules guarantee.
export function parseStrategy(value: unknown): PlanStrategy {
  if (typeof value !== 'object' || value === null) return NEUTRAL_STRATEGY;
  const record = value as Record<string, unknown>;

  // The model writes the short form (avoid/prefer/cardio); the stored form uses
  // the field names the app reads. One validator accepts both so a round trip
  // through the database cannot drift from the prompt contract.
  const avoid = keyList(record.avoid ?? record.avoidCatalogKeys);
  const prefer = keyList(record.prefer ?? record.preferCatalogKeys).filter(
    (key) => !avoid.includes(key),
  );
  const cardio = record.cardio ?? record.cardioPreference;
  const cardioPreference: CardioPreference =
    cardio === 'MINIMAL' || cardio === 'MORE' || cardio === 'STANDARD' ? cardio : 'STANDARD';
  const rationale =
    typeof record.rationale === 'string' && record.rationale.trim() !== ''
      ? record.rationale.trim().slice(0, RATIONALE_MAX_CHARS)
      : null;

  if (avoid.length === 0 && prefer.length === 0 && cardioPreference === 'STANDARD' && !rationale) {
    return NEUTRAL_STRATEGY;
  }
  return {
    avoidCatalogKeys: avoid,
    preferCatalogKeys: prefer,
    cardioPreference,
    rationale,
    source: 'MODEL',
  };
}

export interface StrategyRequestInput {
  // Whose model choice to use. Absent falls back to the deployment default.
  userId?: string;
  goalType: string;
  weeklyFrequency: number;
  trainingAgeMonths: number;
  equipmentTypes: readonly string[];
  softConstraints: string | null;
  safetyNotes: readonly string[];
}

export function buildStrategyPrompt(input: StrategyRequestInput): {
  system: string;
  messages: LlmMessage[];
} {
  const catalog = STRENGTH_EXERCISE_CATALOG.map(
    (entry) => `${entry.key} | ${entry.name} | ${entry.muscleGroup} | ${entry.movementPattern}`,
  ).join('\n');

  const system = `You shape the strategy of one personalized training plan. ${STRATEGY_PROMPT_MARKER}

Reply with a single JSON object and nothing else:
{"avoid": [], "prefer": [], "cardio": "STANDARD", "rationale": ""}

Rules:
- "avoid" and "prefer" may only contain keys from the catalog below. Invent nothing.
- Use "avoid" only for a movement the trainee said they cannot or will not do (an injury they named, equipment they lack, a movement they dislike). Do not avoid a movement pattern just because it is hard.
- Use "prefer" only for movements the trainee asked for or that fit around a constraint. Prefer at most 4 keys.
- "cardio" is one of MINIMAL, STANDARD, MORE. Use MINIMAL only when the trainee said they dislike or cannot do cardio; MORE only when they asked for more.
- "rationale" is one sentence for the trainee, in their language, explaining the shape of the plan. No numbers, no jargon, no promises.
- Never invent sets, reps, calories, minutes or times. Those are computed elsewhere.
- If the trainee said nothing that bears on movement choice or cardio, return empty lists and STANDARD, and use the rationale to explain what the plan is built around. An empty answer is a valid answer.

Catalog (key | name | muscle group | movement pattern):
${catalog}`;

  const facts = [
    `Goal: ${input.goalType}`,
    `Training days per week: ${input.weeklyFrequency}`,
    `Training experience in months: ${input.trainingAgeMonths}`,
    `Available equipment: ${input.equipmentTypes.join(', ') || 'bodyweight only'}`,
    input.safetyNotes.length > 0
      ? `Cannot use: ${input.safetyNotes.join(', ')}`
      : 'Cannot use: nothing recorded',
    `Trainee's own words: ${input.softConstraints?.trim() || '(nothing said)'}`,
  ].join('\n');

  return { system, messages: [{ role: 'user', content: facts }] };
}

export function extractStrategyJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

export interface StrategyDependencies {
  complete(input: {
    system: string;
    messages: LlmMessage[];
    userId?: string;
    thinking?: boolean;
  }): Promise<string>;
}

const defaultDependencies: StrategyDependencies = {
  async complete({ system, messages, userId }) {
    const provider = await getLlmProviderFor(userId);
    // Generous on purpose: a reasoning model spends the first part of this
    // budget thinking, and an unused budget costs nothing.
    const result = await provider.complete({ system, messages, maxTokens: 3000 });
    return result.text;
  },
};

export async function requestPlanStrategy(
  input: StrategyRequestInput,
  dependencies: StrategyDependencies = defaultDependencies,
): Promise<PlanStrategy> {
  // Always ask. Building a plan is a decision the trainee expects the assistant
  // to be part of, and a model with nothing to go on can still make a judgement
  // call about the cardio stance and say why - which is more than the rules
  // alone can offer. A failed or unusable answer still falls back to neutral.
  try {
    const prompt = buildStrategyPrompt(input);
    const text = await dependencies.complete({ ...prompt, userId: input.userId });
    const strategy = parseStrategy(extractStrategyJson(text));
    if (strategy.source === 'DEFAULT') {
      // Degrading to the rules-only plan is correct, but it must leave a trace:
      // silently ignoring the model is how a plan ends up looking fine while
      // the thing that was supposed to shape it never ran.
      console.warn('[agent] plan strategy answer was unusable; using the neutral plan');
    }
    return strategy;
  } catch (error) {
    console.warn(
      '[agent] plan strategy call failed; using the neutral plan:',
      error instanceof Error ? error.message : error,
    );
    return NEUTRAL_STRATEGY;
  }
}
