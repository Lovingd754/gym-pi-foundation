import { StringEnum, Type } from '@earendil-works/pi-ai';
import { db } from '@/lib/db';
import { STRENGTH_EXERCISE_CATALOG } from '@/lib/fitness/exercise-catalog';
import { getExerciseDisplayName } from '@/i18n/exercise-names';
import {
  PlanChangeError,
  applyPlanChange,
  type PlanChange,
  type PlanChangeDiffRow,
} from '@/lib/fitness/plan-change';
import { parseFitnessPlanContent } from '@/lib/fitness/plan-schema';
import {
  prismaApplyPlanChangeDependencies,
  prismaPlanProposalStore,
  type PlanProposalStore,
} from '../plan-proposals';
import { loadToolLabels, type ToolLabels } from './labels';
import {
  defineSummaryTool,
  summaryLines,
  type SummaryDraft,
  type SummaryToolContext,
} from './summary';
import { fillTemplate } from './current-plan';

// A deliberately flat schema: one enum plus optional fields, which every
// provider serializes the same way. The combination is validated in code,
// where the refusal can say what was missing.
const parameters = Type.Object(
  {
    changeType: StringEnum(['swap_exercise', 'move_training_day', 'set_cardio_minutes'], {
      description: 'Which kind of change to propose.',
    }),
    exerciseName: Type.Optional(
      Type.String({
        description: 'swap_exercise: the movement to replace, named as the plan lists it.',
      }),
    ),
    substituteName: Type.Optional(
      Type.String({
        description:
          'swap_exercise: optional. Leave it out and the rules pick an equivalent movement the trainee has the equipment for.',
      }),
    ),
    fromWeekday: Type.Optional(
      Type.Number({ minimum: 1, maximum: 7, description: 'move_training_day: 1 = Monday.' }),
    ),
    toWeekday: Type.Optional(
      Type.Number({ minimum: 1, maximum: 7, description: 'move_training_day: 1 = Monday.' }),
    ),
    cardioMinutes: Type.Optional(
      Type.Number({
        minimum: 0,
        maximum: 300,
        description: 'set_cardio_minutes: the new weekly total, between 0 and 300.',
      }),
    ),
  },
  { additionalProperties: false },
);

// The model names movements the way the trainee reads them ("高脚杯深蹲"), while
// the rules match the catalog. Bridging that here keeps a localized name usable
// as input instead of forcing the model to speak catalog English.
export function resolveCatalogName(name: string, locale: string): string {
  const wanted = name.trim().toLowerCase();
  const direct = STRENGTH_EXERCISE_CATALOG.find((entry) =>
    [entry.name, ...entry.aliases].some((candidate) => candidate.trim().toLowerCase() === wanted),
  );
  if (direct) return direct.name;

  const localized = STRENGTH_EXERCISE_CATALOG.find(
    (entry) => getExerciseDisplayName(entry.name, locale).trim().toLowerCase() === wanted,
  );
  return localized?.name ?? name;
}

export interface PlanChangeToolParams {
  // A plain string: the value arrives from a model, so anything is possible and
  // an unknown one has to be refused rather than assumed away.
  changeType: string;
  exerciseName?: string;
  substituteName?: string;
  fromWeekday?: number;
  toWeekday?: number;
  cardioMinutes?: number;
}

export function buildChange(params: PlanChangeToolParams): PlanChange {
  if (params.changeType === 'swap_exercise') {
    if (!params.exerciseName?.trim()) {
      throw new PlanChangeError('EXERCISE_NOT_IN_PLAN', { missing: 'exerciseName' });
    }
    return {
      kind: 'SWAP_EXERCISE',
      from: params.exerciseName,
      ...(params.substituteName?.trim() ? { to: params.substituteName } : {}),
    };
  }
  if (params.changeType === 'move_training_day') {
    if (params.fromWeekday === undefined || params.toWeekday === undefined) {
      throw new PlanChangeError('DAY_NOT_A_TRAINING_DAY', { missing: 'fromWeekday/toWeekday' });
    }
    return { kind: 'MOVE_TRAINING_DAY', from: params.fromWeekday, to: params.toWeekday };
  }
  if (params.cardioMinutes === undefined) {
    throw new PlanChangeError('CARDIO_OUT_OF_RANGE', { missing: 'cardioMinutes' });
  }
  if (params.changeType === 'set_cardio_minutes') {
    return { kind: 'SET_CARDIO_MINUTES', minutes: params.cardioMinutes };
  }
  throw new PlanChangeError('UNSUPPORTED_CHANGE', { changeType: params.changeType });
}

export function renderDiff(
  labels: ToolLabels,
  rows: PlanChangeDiffRow[],
): { label: string; before: string; after: string }[] {
  return rows.map((row) => {
    if (row.kind === 'exercise') {
      return {
        label: fillTemplate(labels.text('agent.change.exerciseRow', '{weekday} · {day}'), {
          weekday: labels.weekday(row.dayOfWeek),
          day: labels.workoutDay(row.dayName),
        }),
        before: labels.exercise(row.before),
        after: labels.exercise(row.after),
      };
    }
    if (row.kind === 'trainingDay') {
      return {
        label: labels.text('agent.change.trainingDayRow', 'Training day'),
        before: labels.weekday(row.before),
        after: labels.weekday(row.after),
      };
    }
    return {
      label: labels.text('agent.change.cardioRow', 'Cardio per week'),
      before: fillTemplate(labels.text('agent.plan.minutes', '{m} min'), { m: row.before }),
      after: fillTemplate(labels.text('agent.plan.minutes', '{m} min'), { m: row.after }),
    };
  });
}

export interface PlanChangeToolDependencies {
  loadActivePlan(userId: string): Promise<{ id: string; content: unknown } | null>;
  loadConstraints: typeof prismaApplyPlanChangeDependencies.loadConstraints;
}

const defaultDependencies: PlanChangeToolDependencies = {
  async loadActivePlan(userId) {
    const activation = await db.fitnessPlanActivation.findUnique({
      where: { userId },
      select: { planVersionId: true },
    });
    if (!activation?.planVersionId) return null;
    const version = await db.fitnessPlanVersion.findFirst({
      where: { id: activation.planVersionId, userId, status: 'ACTIVE' },
      select: { id: true, content: true },
    });
    return version ?? null;
  },
  loadConstraints: prismaApplyPlanChangeDependencies.loadConstraints,
};

export function createPlanChangeTool(
  context: SummaryToolContext,
  dependencies: PlanChangeToolDependencies = defaultDependencies,
  store: PlanProposalStore = prismaPlanProposalStore,
) {
  return defineSummaryTool<typeof parameters, { proposalId: string | null; kind: string }>(
    {
      name: 'propose_plan_change',
      label: 'Propose a plan change',
      description:
        'Propose one change to the trainee’s active plan: swap a movement, move a training day, or change the weekly cardio minutes. This only creates a proposal the trainee has to confirm, so never say the plan has changed. Name the movement to replace and let the rules pick an equivalent one, or name the replacement explicitly.',
      parameters,
      async summarize(
        params,
        ctx,
      ): Promise<SummaryDraft<{ proposalId: string | null; kind: string }>> {
        const labels = await loadToolLabels(ctx.locale);
        const plan = await dependencies.loadActivePlan(ctx.userId);
        if (!plan) {
          return {
            text: labels.text(
              'agent.change.noPlan',
              'There is no active personalized plan to change yet.',
            ),
            details: { proposalId: null, kind: params.changeType },
          };
        }

        const change = buildChange({
          changeType: params.changeType,
          ...(params.exerciseName === undefined ? {} : { exerciseName: params.exerciseName }),
          ...(params.substituteName === undefined
            ? {}
            : { substituteName: params.substituteName }),
          ...(params.fromWeekday === undefined ? {} : { fromWeekday: params.fromWeekday }),
          ...(params.toWeekday === undefined ? {} : { toWeekday: params.toWeekday }),
          ...(params.cardioMinutes === undefined ? {} : { cardioMinutes: params.cardioMinutes }),
        });

        const resolved: PlanChange =
          change.kind === 'SWAP_EXERCISE'
            ? {
                kind: 'SWAP_EXERCISE',
                from: resolveCatalogName(change.from, ctx.locale),
                ...(change.to ? { to: resolveCatalogName(change.to, ctx.locale) } : {}),
              }
            : change;

        const constraints = await dependencies.loadConstraints(ctx.userId);
        let applied;
        try {
          applied = applyPlanChange(parseFitnessPlanContent(plan.content), resolved, constraints);
        } catch (error) {
          if (error instanceof PlanChangeError) throw new Error(explainRefusal(error));
          throw error;
        }

        const diff = renderDiff(labels, applied.diff);
        const proposal = await store.propose({
          userId: ctx.userId,
          conversationId: ctx.conversationId,
          kind: resolved.kind,
          basePlanId: plan.id,
          change: resolved,
          diff,
        });

        const summary = diff.map((row) => `${row.label}: ${row.before} → ${row.after}`).join('\n');
        return {
          text: summaryLines(
            labels.text(
              'agent.change.proposed',
              'A change has been put forward for the trainee to confirm. It is NOT applied yet: say you have proposed it and that they decide, never that the plan has changed.',
            ),
            '',
            summary,
          ),
          details: { proposalId: proposal.id, kind: resolved.kind },
        };
      },
    },
    context,
  );
}

// The refusal is the model's cue to act: it names what was wrong and what to do
// instead, so the next turn proposes something the rules can accept.
function explainRefusal(error: PlanChangeError): string {
  const where = Object.entries(error.details)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(', ');
  const suffix = where ? ` (${where})` : '';
  switch (error.code) {
    case 'EXERCISE_NOT_IN_PLAN':
      return `That movement is not in the active plan${suffix}. Read the plan with get_current_plan and use a name it lists.`;
    case 'NO_SUITABLE_SUBSTITUTE':
      return `No equivalent movement fits this trainee's equipment${suffix}. Suggest something else, or ask what equipment they have.`;
    case 'SUBSTITUTE_NOT_SUITABLE':
      return `That replacement is not usable here${suffix}: unknown, already in the session, or needs equipment the trainee does not have.`;
    case 'DAY_NOT_A_TRAINING_DAY':
      return `That weekday is not one of the plan's training days${suffix}.`;
    case 'DAY_ALREADY_TRAINING':
      return `That weekday already has a session${suffix}.`;
    case 'DAY_NOT_AVAILABLE':
      return `The trainee is not available that weekday${suffix}. Ask which days work.`;
    case 'CARDIO_OUT_OF_RANGE':
      return `Cardio must be between 0 and 300 minutes per week${suffix}.`;
    case 'PLAN_INVALID_AFTER_CHANGE':
      return 'That change would leave the plan inconsistent, so it was refused. Try a smaller change.';
    case 'UNSUPPORTED_CHANGE':
      return `That is not a change this app can make${suffix}. Use swap_exercise, move_training_day or set_cardio_minutes.`;
  }
}
