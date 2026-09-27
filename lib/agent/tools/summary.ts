import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Static, TSchema } from 'typebox';

// ============================================================
// Summary-only tool contract
// ============================================================
// Every tool the agent can call is built here. The point of the base class is
// that a tool *cannot* hand the model a raw payload: `summarize()` returns
// prose, the base bounds it, and the result carries a single text block.
//
// Why this is a contract and not a convention: dumping a whole database row
// into the transcript is cheap to write and expensive to debug (it burns
// context, leaks internal identifiers, and hides the one fact the model
// needed). Making the return type a string means the mistake is a type error.
// `summary.test.ts` additionally asserts that no tool module serializes an
// object, so the rule survives future edits.

// Roughly a page of prose. Big enough for a week of training plus today's
// nutrition and sleep targets, small enough that one tool result can never
// dominate the conversation window.
export const SUMMARY_CHAR_LIMIT = 1800;

const TRUNCATION_NOTICE = '\n…（内容过长，已截断）';

export interface SummaryToolContext {
  userId: string;
  // The training session attached to the conversation, when there is one.
  sessionId?: string;
  // The conversation the run belongs to. Provenance for anything a tool
  // writes, never used to widen read scope.
  conversationId?: string;
  // The locale the trainee is reading the app in. Tool output feeds the model,
  // which then answers the trainee, so labels follow the interface language.
  locale: string;
  signal?: AbortSignal;
}

export interface SummaryDraft<TDetails> {
  // Human-readable prose. Never a serialized object.
  text: string;
  // Structured bookkeeping for logs and UI. Deliberately not sent to the
  // model - the runtime only forwards `content`.
  details: TDetails;
}

export interface SummaryToolSpec<TParameters extends TSchema, TDetails> {
  name: string;
  label: string;
  description: string;
  parameters: TParameters;
  summarize: (
    params: Static<TParameters>,
    context: SummaryToolContext,
  ) => Promise<SummaryDraft<TDetails>> | SummaryDraft<TDetails>;
}

export function defineSummaryTool<TParameters extends TSchema, TDetails>(
  spec: SummaryToolSpec<TParameters, TDetails>,
  context: SummaryToolContext,
): AgentTool<TParameters, TDetails> {
  return {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters,
    executionMode: 'parallel',
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      const draft = await spec.summarize(params, {
        ...context,
        ...(signal ? { signal } : {}),
      });
      signal?.throwIfAborted();

      const text = bound(draft.text);
      if (text === '') {
        throw new Error(`Tool ${spec.name} produced an empty summary`);
      }
      return {
        content: [{ type: 'text' as const, text }],
        details: draft.details,
      };
    },
  };
}

// Collapses the padding that makes hand-built summaries drift, then enforces
// the hard ceiling. Truncation is announced rather than silent so the model can
// say "there is more" instead of inventing the missing part.
function bound(text: string): string {
  const normalized = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (normalized.length <= SUMMARY_CHAR_LIMIT) return normalized;
  const kept = normalized.slice(0, SUMMARY_CHAR_LIMIT - TRUNCATION_NOTICE.length);
  return `${kept.trimEnd()}${TRUNCATION_NOTICE}`;
}

// Joins summary lines, dropping empty ones so callers can build with optional
// sections without threading conditionals through every branch.
export function summaryLines(...lines: Array<string | null | undefined | false>): string {
  return lines.filter((line): line is string => typeof line === 'string' && line.trim() !== '').join('\n');
}

// `2026-09-19` from a date the trainee would recognize as "that day".
export function summaryDate(value: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

export function minutesToClock(totalMinutes: number): string {
  const wrapped = ((totalMinutes % 1440) + 1440) % 1440;
  const hours = Math.floor(wrapped / 60);
  const minutes = wrapped % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}
