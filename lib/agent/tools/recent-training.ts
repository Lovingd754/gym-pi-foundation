import { Type } from '@earendil-works/pi-ai';
import { db } from '@/lib/db';
import { loadToolLabels, type ToolLabels } from './labels';
import {
  defineSummaryTool,
  summaryDate,
  summaryLines,
  type SummaryDraft,
  type SummaryToolContext,
} from './summary';
import { fillTemplate, isoWeekdayInTimeZone } from './current-plan';

const parameters = Type.Object(
  {
    limit: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: 10,
        description: 'How many of the most recent finished sessions to summarize. Defaults to 3.',
      }),
    ),
  },
  { additionalProperties: false },
);

const DEFAULT_LIMIT = 3;

export interface RecentSet {
  weight: number;
  reps: number;
  durationSec: number | null;
  distanceM: number | null;
  isWarmup: boolean;
  exercise: { name: string; category: string };
}

export interface RecentSession {
  startedAt: Date;
  finishedAt: Date | null;
  workoutName: string | null;
  sets: RecentSet[];
}

export interface RecentTrainingDependencies {
  loadHistory(
    userId: string,
    limit: number,
  ): Promise<{ timeZone: string; sessions: RecentSession[] }>;
}

const defaultDependencies: RecentTrainingDependencies = {
  async loadHistory(userId, limit) {
    const [profile, sessions] = await Promise.all([
      db.fitnessProfile.findUnique({ where: { userId }, select: { timeZone: true } }),
      db.session.findMany({
        where: { userId, finishedAt: { not: null } },
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        take: limit,
        select: {
          startedAt: true,
          finishedAt: true,
          workout: { select: { name: true } },
          sets: {
            where: { isWarmup: false },
            orderBy: [{ exerciseId: 'asc' }, { setNumber: 'asc' }],
            select: {
              weight: true,
              reps: true,
              durationSec: true,
              distanceM: true,
              exercise: { select: { name: true, category: true } },
            },
          },
        },
      }),
    ]);

    return {
      timeZone: profile?.timeZone ?? 'UTC',
      sessions: sessions.map((session) => ({
        startedAt: session.startedAt,
        finishedAt: session.finishedAt,
        workoutName: session.workout?.name ?? null,
        sets: session.sets.map((set) => ({
          weight: set.weight,
          reps: set.reps,
          durationSec: set.durationSec,
          distanceM: set.distanceM,
          // Warm-ups are already filtered out by the query; the flag stays on
          // the row shape so a caller cannot forget it exists.
          isWarmup: false,
          exercise: { name: set.exercise.name, category: set.exercise.category },
        })),
      })),
    };
  },
};

interface StrengthGroup {
  name: string;
  sets: number;
  topWeight: number;
  topReps: number;
}

function groupStrengthSets(sets: RecentSet[]): StrengthGroup[] {
  const groups = new Map<string, StrengthGroup>();
  for (const set of sets) {
    if (set.durationSec !== null) continue;
    const group = groups.get(set.exercise.name) ?? {
      name: set.exercise.name,
      sets: 0,
      topWeight: 0,
      topReps: 0,
    };
    group.sets += 1;
    // "Top set" is the heaviest working set; ties on weight go to the set with
    // more reps, which is what a trainee would call their best set that day.
    if (
      set.weight > group.topWeight ||
      (set.weight === group.topWeight && set.reps > group.topReps)
    ) {
      group.topWeight = set.weight;
      group.topReps = set.reps;
    }
    groups.set(set.exercise.name, group);
  }
  return [...groups.values()];
}

function describeStrengthGroup(labels: ToolLabels, group: StrengthGroup): string {
  const name = labels.exercise(group.name);
  if (group.topWeight > 0) {
    return fillTemplate(labels.text('agent.training.topSet', '{name}: {sets} sets, top {weight} kg x {reps}'), {
      name,
      sets: group.sets,
      weight: group.topWeight,
      reps: group.topReps,
    });
  }
  if (group.topReps > 0) {
    return fillTemplate(
      labels.text('agent.training.topSetBodyweight', '{name}: {sets} sets, top {reps} bodyweight reps'),
      { name, sets: group.sets, reps: group.topReps },
    );
  }
  return fillTemplate(labels.text('agent.training.setsOnly', '{name}: {sets} sets'), {
    name,
    sets: group.sets,
  });
}

function describeSession(labels: ToolLabels, session: RecentSession, timeZone: string): string {
  const weekday = labels.weekday(isoWeekdayInTimeZone(session.startedAt, timeZone));
  const date = `${summaryDate(session.startedAt, labels.locale)} ${weekday}`;
  const name = session.workoutName
    ? labels.workoutDay(session.workoutName)
    : labels.text('agent.training.unstructured', 'Training');

  const minutes = session.finishedAt
    ? Math.max(0, Math.round((session.finishedAt.getTime() - session.startedAt.getTime()) / 60_000))
    : null;
  const duration =
    minutes === null
      ? ''
      : ` · ${fillTemplate(labels.text('agent.plan.minutes', '{m} min'), { m: minutes })}`;

  const cardioSets = session.sets.filter((set) => set.durationSec !== null);
  const strengthGroups = groupStrengthSets(session.sets);

  const details: string[] = [];
  if (cardioSets.length > 0) {
    const totalSeconds = cardioSets.reduce((sum, set) => sum + (set.durationSec ?? 0), 0);
    const totalMeters = cardioSets.reduce((sum, set) => sum + (set.distanceM ?? 0), 0);
    const distance =
      totalMeters > 0
        ? fillTemplate(labels.text('agent.training.distance', ' · {km} km'), {
            km: Math.round((totalMeters / 1000) * 10) / 10,
          })
        : '';
    details.push(
      fillTemplate(labels.text('agent.training.cardio', 'Cardio {duration}{distance}'), {
        duration: fillTemplate(labels.text('agent.plan.minutes', '{m} min'), {
          m: Math.round(totalSeconds / 60),
        }),
        distance,
      }),
    );
  }
  details.push(...strengthGroups.map((group) => describeStrengthGroup(labels, group)));

  // A cardio-only session has no exercises to count, so it gets its own
  // headline instead of "0 exercises".
  const headline =
    strengthGroups.length === 0 && cardioSets.length > 0
      ? fillTemplate(labels.text('agent.training.cardioSession', '{date} · {name}{duration}'), {
          date,
          name,
          duration,
          distance: '',
        })
      : fillTemplate(labels.text('agent.training.session', '{date} · {name}{duration}'), {
          date,
          name,
          duration,
          exercises: strengthGroups.length,
        });

  return summaryLines(headline, details.length > 0 ? `    ${details.join('\n    ')}` : null);
}

export function summarizeRecentTraining(
  labels: ToolLabels,
  sessions: RecentSession[],
  timeZone: string,
): string {
  if (sessions.length === 0) {
    return labels.text('agent.training.empty', 'No finished sessions recorded in the app yet.');
  }

  const header = fillTemplate(labels.text('agent.training.header', 'Last {count} sessions'), {
    count: sessions.length,
  });
  return summaryLines(
    header,
    '',
    ...sessions.map((session) => describeSession(labels, session, timeZone)),
  );
}

export function createRecentTrainingTool(
  context: SummaryToolContext,
  dependencies: RecentTrainingDependencies = defaultDependencies,
) {
  return defineSummaryTool<typeof parameters, { sessionCount: number }>(
    {
      name: 'get_recent_training',
      label: 'Read recent training',
      description:
        'Read the trainee’s most recently finished sessions as a bounded summary: date, session name, duration, and the heaviest working set per exercise. Warm-up sets are excluded.',
      parameters,
      async summarize(params, ctx): Promise<SummaryDraft<{ sessionCount: number }>> {
        const labels = await loadToolLabels(ctx.locale);
        const limit = params.limit ?? DEFAULT_LIMIT;
        const { timeZone, sessions } = await dependencies.loadHistory(ctx.userId, limit);
        return {
          text: summarizeRecentTraining(labels, sessions, timeZone),
          details: { sessionCount: sessions.length },
        };
      },
    },
    context,
  );
}
