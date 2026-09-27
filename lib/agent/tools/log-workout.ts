import { Type } from '@earendil-works/pi-ai';
import { db } from '@/lib/db';
import { ensureExerciseCatalog } from '@/lib/exercise-catalog-sync';
import { getExerciseDisplayName } from '@/i18n/exercise-names';
import { fromDisplayWeight, unitLabel } from '@/lib/units';
import {
  prismaLogProposalStore,
  type LogProposalEntry,
  type LogProposalStore,
} from '../log-proposals';
import { loadToolLabels } from './labels';
import {
  defineSummaryTool,
  summaryLines,
  type SummaryDraft,
  type SummaryToolContext,
} from './summary';
import { fillTemplate } from './current-plan';

// Mirrors the bounds the set form enforces (lib/schemas/set.ts) so a sentence
// cannot propose a set the manual form would refuse. Weight is bounded in the
// trainee's own unit because that is how they said it; the conversion happens
// here, once, and the canonical kilograms are what get stored.
const parameters = Type.Object(
  {
    exerciseName: Type.String({
      description: 'The movement as the trainee named it, in their own words.',
    }),
    weight: Type.Number({
      minimum: 0,
      maximum: 2000,
      description: 'The load in the trainee’s display unit. Use 0 for bodyweight-only work.',
    }),
    reps: Type.Number({ minimum: 1, maximum: 100, description: 'Reps per set.' }),
    sets: Type.Number({ minimum: 1, maximum: 20, description: 'How many sets.' }),
    rir: Type.Optional(
      Type.Number({
        minimum: 0,
        maximum: 5,
        description: 'Reps left in reserve, only when the trainee said it.',
      }),
    ),
  },
  { additionalProperties: false },
);

export interface LogWorkoutDependencies {
  loadExercises(userId: string): Promise<{ id: string; name: string }[]>;
  loadUnit(userId: string): Promise<'KG' | 'LB'>;
}

const defaultDependencies: LogWorkoutDependencies = {
  async loadExercises(userId) {
    // The trainee may name a movement the library only just gained; adding it
    // before matching keeps "昨天做了北欧腿弯举" from failing on a stale library.
    await ensureExerciseCatalog(userId);
    return db.exercise.findMany({
      where: { userId },
      select: { id: true, name: true },
    });
  },
  async loadUnit(userId) {
    const user = await db.user.findUnique({ where: { id: userId }, select: { unit: true } });
    return user?.unit ?? 'KG';
  },
};

// The trainee says 卧推, the catalog row says "Bench Press". Matching both the
// stored name and its localized display name is what makes the chat usable in
// the language the interface is in.
export function resolveExercise(
  exercises: readonly { id: string; name: string }[],
  spokenName: string,
  locale: string,
): { id: string; name: string } | null {
  const wanted = spokenName.trim().toLowerCase();
  if (wanted === '') return null;
  const exact = exercises.find(
    (exercise) =>
      exercise.name.trim().toLowerCase() === wanted ||
      getExerciseDisplayName(exercise.name, locale).trim().toLowerCase() === wanted,
  );
  if (exact) return exact;
  // A looser pass: the trainee rarely types the full name ("卧推" for
  // "Barbell bench press"), so a unique prefix or substring match is accepted -
  // but only when it is unambiguous.
  const partial = exercises.filter((exercise) => {
    const display = getExerciseDisplayName(exercise.name, locale).toLowerCase();
    return display.includes(wanted) || exercise.name.toLowerCase().includes(wanted);
  });
  return partial.length === 1 ? partial[0]! : null;
}

export function createLogWorkoutTool(
  context: SummaryToolContext,
  dependencies: LogWorkoutDependencies = defaultDependencies,
  store: LogProposalStore = prismaLogProposalStore,
) {
  return defineSummaryTool<typeof parameters, { proposalId: string | null }>(
    {
      name: 'log_workout',
      label: 'Log a set the trainee described',
      description:
        'Record sets the trainee says they did (for example "bench 60 kg for 8, three sets"). This only puts the entry forward for them to confirm: say you have prepared it to log, never that it is saved. The app owns the units and the limits.',
      parameters,
      async summarize(params, ctx): Promise<SummaryDraft<{ proposalId: string | null }>> {
        const labels = await loadToolLabels(ctx.locale);
        const [exercises, unit] = await Promise.all([
          dependencies.loadExercises(ctx.userId),
          dependencies.loadUnit(ctx.userId),
        ]);

        const exercise = resolveExercise(exercises, params.exerciseName, ctx.locale);
        if (!exercise) {
          // Not an error: the trainee may simply not have this exercise yet, and
          // the agent should say so rather than log something close enough.
          return {
            text: labels.text(
              'agent.log.unknownExercise',
              'That movement is not in the trainee’s exercise catalog yet, so nothing was prepared. Ask them to add it, or use a movement they already have.',
            ),
            details: { proposalId: null },
          };
        }

        const entry: LogProposalEntry = {
          exerciseId: exercise.id,
          weight: fromDisplayWeight(params.weight, unit),
          reps: Math.round(params.reps),
          sets: Math.round(params.sets),
          rir: params.rir === undefined ? null : Math.round(params.rir),
        };

        // The card shows what the trainee said, in their unit: reading their own
        // numbers back is what makes the confirmation meaningful.
        const summary = [
          {
            label: labels.text('agent.log.exerciseRow', 'Movement'),
            value: getExerciseDisplayName(exercise.name, ctx.locale),
          },
          {
            label: labels.text('agent.log.volumeRow', 'Each set'),
            value: fillTemplate(labels.text('agent.log.volume', '{weight} {unit} × {reps}'), {
              weight: params.weight,
              unit: unitLabel(unit),
              reps: entry.reps,
            }),
          },
          {
            label: labels.text('agent.log.setsRow', 'Sets'),
            value: String(entry.sets),
          },
          ...(entry.rir === null
            ? []
            : [
                {
                  label: labels.text('agent.log.rirRow', 'Effort'),
                  value: fillTemplate(labels.text('agent.log.rir', '{rir} reps left in reserve'), {
                    rir: entry.rir,
                  }),
                },
              ]),
        ];

        const proposal = await store.propose({
          userId: ctx.userId,
          conversationId: ctx.conversationId,
          entry,
          summary,
        });

        return {
          text: summaryLines(
            labels.text(
              'agent.log.prepared',
              'The entry is ready for the trainee to confirm. It is NOT saved yet: say you have prepared it to log, never that it is recorded.',
            ),
            '',
            ...summary.map((row) => `${row.label}: ${row.value}`),
          ),
          details: { proposalId: proposal.id },
        };
      },
    },
    context,
  );
}
