import { z } from 'zod';
import type { AgentSkill } from './skills';

const schema = z
  .object({
    kind: z.enum(['log', 'plan', 'memory']),
    phase: z.enum(['COLLECTING', 'PENDING_CONFIRMATION', 'NEEDS_REVISION']),
    fields: z.record(z.string(), z.union([z.string().max(500), z.number().finite()])),
    missing: z.array(z.string().max(40)).max(8),
    pending: z
      .object({
        id: z.string().max(128),
        tool: z.enum(['log_workout', 'propose_plan_change', 'propose_memory']),
      })
      .nullable(),
    lastCorrection: z.string().max(500).nullable(),
  })
  .strict();
export type AgentTaskState = z.infer<typeof schema>;
export function parseTaskState(raw: unknown): AgentTaskState | null {
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
export function isTaskCorrection(message: string): boolean {
  return /改成|改为|更正|不是.{0,30}(?:是|而是)|刚才.{0,30}(?:错|改)|\b(?:actually|correct|change it to)\b/i.test(
    message,
  );
}
export function taskSkill(state: AgentTaskState | null, message: string): AgentSkill | null {
  const slotReply =
    state?.kind === 'log' &&
    /^(?:是|每组|做了)?\s*(?:\d+(?:\.\d+)?\s*(?:kg|公斤|千克|磅|lbs?|次|组|reps?|sets?)\s*[,，、 ]*)+$/i.test(
      message.trim(),
    );
  if (
    !state ||
    !(isTaskCorrection(message) || slotReply) ||
    /[?？]|合适|可以吗|怎么样|是否|\b(?:should|would|could|appropriate)\b/i.test(message) ||
    /计划|有氧|训练日|换动作|\bcardio\b/i.test(message)
  )
    return null;
  return state.kind === 'memory' ? 'general' : state.kind;
}
export function advanceTask(
  previous: AgentTaskState | null,
  message: string,
  skill: AgentSkill,
): AgentTaskState | null {
  const correction = !!previous && isTaskCorrection(message);
  if (previous?.kind === 'memory' && correction && skill === 'general')
    return {
      ...structuredClone(previous),
      phase: previous.pending ? 'NEEDS_REVISION' : 'COLLECTING',
      lastCorrection: message.slice(0, 500),
    };
  const kind = taskSkill(previous, message) ?? skill;
  if (kind !== 'log' && kind !== 'plan') return previous;
  const explicitNew = kind === 'log' && !taskSkill(previous, message) && !correction;
  const state: AgentTaskState =
    previous?.kind === kind && !explicitNew
      ? structuredClone(previous)
      : { kind, phase: 'COLLECTING', fields: {}, missing: [], pending: null, lastCorrection: null };
  const weight = /(-?\d+(?:\.\d+)?)\s*(kg|公斤|千克|磅|lbs?)(?![a-z])/i.exec(message);
  const reps = /(-?\d+)\s*(?:次|reps?\b)/i.exec(message);
  const sets = /(-?\d+)\s*(?:组|sets?\b)/i.exec(message);
  const exercise =
    /(?:杠铃|哑铃|上斜|下斜)?卧推|深蹲|硬拉|引体向上|俯卧撑|(?:barbell |dumbbell |incline )?bench(?: press)?|squat|deadlift|push[ -]?ups?/i.exec(
      message,
    );
  if (kind === 'log') {
    if (exercise) state.fields.exerciseName = exercise[0];
    if (weight) {
      state.fields.weight = Number(weight[1]);
      state.fields.weightUnit = /磅|lb/i.test(weight[2]!) ? 'LB' : 'KG';
    }
    if (reps) state.fields.reps = Number(reps[1]);
    if (sets) state.fields.sets = Number(sets[1]);
    state.missing = ['exerciseName', 'weight', 'reps', 'sets'].filter(
      (key) => state.fields[key] === undefined,
    );
  } else {
    state.fields.request = message.slice(0, 500);
    state.missing = [];
  }
  if (
    correction ||
    (state.pending && JSON.stringify(state.fields) !== JSON.stringify(previous?.fields))
  ) {
    state.lastCorrection = message.slice(0, 500);
    state.phase = state.pending ? 'NEEDS_REVISION' : 'COLLECTING';
  } else if (!state.pending) state.phase = 'COLLECTING';
  return state;
}
export function taskAfterTool(
  previous: AgentTaskState | null,
  tool: string,
  args: unknown,
  details: unknown,
): AgentTaskState | null {
  if (!['log_workout', 'propose_plan_change', 'propose_memory'].includes(tool)) return previous;
  const payload = details as { proposalId?: unknown; memoryId?: unknown; status?: string } | null;
  const id = tool === 'propose_memory' ? payload?.memoryId : payload?.proposalId;
  if (tool === 'propose_memory' && payload?.status !== 'PENDING') return previous;
  if (typeof id !== 'string' || id.length > 128) return previous;
  const kind = tool === 'log_workout' ? 'log' : tool === 'propose_plan_change' ? 'plan' : 'memory';
  const fields: AgentTaskState['fields'] = {};
  if (args && typeof args === 'object')
    for (const [key, value] of Object.entries(args)) {
      if (
        [
          'exerciseName',
          'weight',
          'reps',
          'sets',
          'rir',
          'changeType',
          'fromWeekday',
          'toWeekday',
          'substituteName',
          'cardioMinutes',
          'content',
        ].includes(key) &&
        ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'string')
      )
        fields[key] = typeof value === 'string' ? value.slice(0, 500) : value;
    }
  if (tool === 'log_workout' && fields.weight !== undefined) fields.weightUnit = 'USER_DEFAULT';
  return {
    kind,
    phase: 'PENDING_CONFIRMATION',
    fields: { ...(previous?.kind === kind ? previous.fields : {}), ...fields },
    missing: [],
    pending: { id, tool: tool as NonNullable<AgentTaskState['pending']>['tool'] },
    lastCorrection: previous?.kind === kind ? previous.lastCorrection : null,
  };
}
