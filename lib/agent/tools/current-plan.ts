import { Type } from '@earendil-works/pi-ai';
import { db } from '@/lib/db';
import { parseFitnessPlanContent, type FitnessPlanContent } from '@/lib/fitness/plan-schema';
import { loadToolLabels, type ToolLabels } from './labels';
import {
  defineSummaryTool,
  minutesToClock,
  summaryDate,
  summaryLines,
  type SummaryDraft,
  type SummaryToolContext,
} from './summary';

const parameters = Type.Object(
  {
    dayOfWeek: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: 7,
        description:
          'ISO weekday to focus on (1 = Monday ... 7 = Sunday). Omit to use today in the trainee time zone.',
      }),
    ),
  },
  { additionalProperties: false },
);

export interface CurrentPlanSnapshot {
  version: number;
  status: string;
  activatedAt: Date | null;
  goalType: string;
  desiredWeeklyRatePct: number;
  timeZone: string;
  content: FitnessPlanContent;
}

export interface CurrentPlanDependencies {
  loadSnapshot(userId: string): Promise<CurrentPlanSnapshot | null>;
}

const defaultDependencies: CurrentPlanDependencies = {
  async loadSnapshot(userId) {
    const [activation, profile] = await Promise.all([
      db.fitnessPlanActivation.findUnique({
        where: { userId },
        select: {
          planVersion: {
            select: {
              version: true,
              status: true,
              content: true,
              activatedAt: true,
              goal: { select: { type: true, desiredWeeklyRatePct: true } },
            },
          },
        },
      }),
      db.fitnessProfile.findUnique({ where: { userId }, select: { timeZone: true } }),
    ]);

    const version = activation?.planVersion;
    if (!version || version.status !== 'ACTIVE') return null;

    return {
      version: version.version,
      status: version.status,
      activatedAt: version.activatedAt,
      goalType: version.goal.type,
      desiredWeeklyRatePct: version.goal.desiredWeeklyRatePct,
      timeZone: profile?.timeZone ?? 'UTC',
      content: parseFitnessPlanContent(version.content),
    };
  },
};

const WEEKDAY_INDEX: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

export function isoWeekdayInTimeZone(now: Date, timeZone: string): number {
  try {
    const label = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(now);
    return WEEKDAY_INDEX[label] ?? 1;
  } catch {
    // An unusable stored time zone must not break the tool: fall back to UTC
    // and let the plan itself stay authoritative.
    return WEEKDAY_INDEX[
      new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(now)
    ] as number;
  }
}

// `{token}` substitution over the message catalog. Plain string replacement is
// enough here: these templates carry values, never plurals.
export function fillTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}

function range(min: number, max: number): string {
  return min === max ? String(min) : `${min}–${max}`;
}

function duration(labels: ToolLabels, minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return fillTemplate(labels.text('agent.plan.minutes', '{m} min'), { m: rest });
  if (rest === 0)
    return fillTemplate(labels.text('agent.plan.hours', '{h} h'), { h: hours });
  return fillTemplate(labels.text('agent.plan.hoursMinutes', '{h} h {m} min'), {
    h: hours,
    m: rest,
  });
}

function describeExercise(
  labels: ToolLabels,
  exercise: FitnessPlanContent['strength']['days'][number]['exercises'][number],
): string {
  const name = labels.exercise(exercise.name);
  const reps = range(exercise.targetRepsMin, exercise.targetRepsMax);
  const template = labels.text(
    exercise.targetRIR === undefined ? 'agent.plan.exerciseNoRir' : 'agent.plan.exercise',
    '{sets} × {reps}',
  );
  const detail = fillTemplate(template, {
    sets: exercise.targetSets,
    reps,
    rir: exercise.targetRIR ?? '',
  });
  return `${name} ${detail}`;
}

function describeDay(
  labels: ToolLabels,
  content: FitnessPlanContent,
  day: FitnessPlanContent['schedule']['days'][number],
): string {
  const label = labels.weekday(day.dayOfWeek);
  if (day.strengthDayIndex === null) {
    const kind = labels.text(
      day.cardioMin > 0 ? 'fitness.plan.schedule.cardio' : 'fitness.plan.schedule.rest',
      day.cardioMin > 0 ? 'cardio' : 'rest',
    );
    return day.cardioMin > 0 ? `${label} · ${kind} ${duration(labels, day.cardioMin)}` : `${label} · ${kind}`;
  }

  const strengthDay = content.strength.days[day.strengthDayIndex];
  if (!strengthDay) return `${label} · ${labels.text('agent.plan.rest', 'rest')}`;

  const dayName = labels.workoutDay(strengthDay.name);
  const exercises = strengthDay.exercises.map((exercise) => describeExercise(labels, exercise));
  const cardioSuffix =
    day.cardioMin > 0 ? ` + ${duration(labels, day.cardioMin)} ${labels.text('fitness.plan.schedule.cardio', 'cardio')}` : '';
  return `${label} · ${dayName}${cardioSuffix}\n    ${exercises.join('\n    ')}`;
}

export function summarizePlan(
  labels: ToolLabels,
  snapshot: CurrentPlanSnapshot,
  focusWeekday: number,
  now: Date,
): string {
  const { content } = snapshot;
  const activated = snapshot.activatedAt
    ? fillTemplate(labels.text('agent.plan.activated', ' · active since {date}'), {
        date: summaryDate(snapshot.activatedAt, labels.locale),
      })
    : '';

  const focusDay = content.schedule.days.find((day) => day.dayOfWeek === focusWeekday);
  const focus = focusDay
    ? fillTemplate(labels.text('agent.plan.focus', '{weekday}: {what}'), {
        weekday: labels.weekday(focusWeekday),
        what: describeFocus(labels, content, focusDay),
      })
    : null;

  const strength = fillTemplate(labels.text('agent.plan.strength', 'Strength ({split})'), {
    split: labels.split(content.strength.split),
    days: content.strength.days.length,
    sets: content.strength.weeklyTargetSets,
    minutes: content.strength.days[0]?.estimatedDurationMin ?? 0,
  });

  const dayLines = [...content.schedule.days]
    .sort((left, right) => left.dayOfWeek - right.dayOfWeek)
    .map((day) => describeDay(labels, content, day));

  const cardio =
    content.cardio.additionalWeeklyMin === 0
      ? labels.text('agent.plan.cardioNone', 'Cardio: none')
      : fillTemplate(labels.text('agent.plan.cardio', 'Cardio: {minutes} min per week'), {
          minutes: content.cardio.additionalWeeklyMin,
        });

  const nutrition = fillTemplate(labels.text('agent.plan.nutrition', 'Nutrition per day'), {
    calories: range(content.nutrition.caloriesKcal.min, content.nutrition.caloriesKcal.max),
    protein: range(content.nutrition.proteinG.min, content.nutrition.proteinG.max),
    carbs: range(content.nutrition.carbsG.min, content.nutrition.carbsG.max),
    fat: range(content.nutrition.fatG.min, content.nutrition.fatG.max),
  });

  // The meal split travels with the daily total, because "I did not finish
  // lunch" is only answerable if the model knows what lunch was meant to be.
  const mealLines = (content.nutrition.meals ?? []).map((meal) =>
    fillTemplate(
      labels.text('agent.plan.meal', '{name}: {calories} kcal · protein {protein} g'),
      {
        name: labels.text(`fitness.plan.nutrition.meals.${meal.key}`, meal.key),
        calories: `${meal.caloriesKcal.min}–${meal.caloriesKcal.max}`,
        protein: `${meal.proteinG.min}–${meal.proteinG.max}`,
        carbs: `${meal.carbsG.min}–${meal.carbsG.max}`,
        fat: `${meal.fatG.min}–${meal.fatG.max}`,
      },
    ),
  );

  const transition =
    content.sleep.initialTargetMin === content.sleep.longTermMin &&
    content.sleep.initialTargetMax === content.sleep.longTermMax
      ? null
      : fillTemplate(labels.text('agent.plan.sleepTransition', 'Next two weeks: {from} to {to}'), {
          from: duration(labels, content.sleep.initialTargetMin),
          to: duration(labels, content.sleep.initialTargetMax),
        });

  const sleep = [
    fillTemplate(labels.text('agent.plan.sleep', 'Sleep: {target}'), {
      target: fillTemplate(labels.text('agent.plan.hoursRange', '{min}–{max} h'), {
        min: content.sleep.longTermMin / 60,
        max: content.sleep.longTermMax / 60,
      }),
      bedtime: minutesToClock(content.sleep.suggestedBedtimeMin),
      wake: minutesToClock(content.sleep.wakeTimeMin),
    }),
    transition,
  ]
    .filter((line): line is string => Boolean(line))
    .join(' · ');

  return summaryLines(
    fillTemplate(labels.text('agent.plan.header', 'Plan: {status}'), {
      status: labels.planStatus(snapshot.status),
      version: snapshot.version,
      activated,
    }),
    fillTemplate(labels.text('agent.plan.goal', 'Goal: {goal}'), {
      goal: labels.goalType(snapshot.goalType),
      rate: snapshot.desiredWeeklyRatePct,
    }),
    focus,
    `(${labels.text('fitness.plan.sections.schedule', 'Week')}, ${summaryDate(now, labels.locale)})`,
    strength,
    ...dayLines,
    '',
    cardio,
    nutrition,
    ...mealLines,
    sleep,
  );
}

function describeFocus(
  labels: ToolLabels,
  content: FitnessPlanContent,
  day: FitnessPlanContent['schedule']['days'][number],
): string {
  const cardioSuffix =
    day.cardioMin > 0 ? ` + ${duration(labels, day.cardioMin)} ${labels.text('fitness.plan.schedule.cardio', 'cardio')}` : '';
  if (day.strengthDayIndex === null) {
    return day.cardioMin > 0
      ? `${labels.text('fitness.plan.schedule.cardio', 'cardio')} ${duration(labels, day.cardioMin)}`
      : labels.text('agent.plan.rest', 'rest');
  }
  const strengthDay = content.strength.days[day.strengthDayIndex];
  if (!strengthDay) return labels.text('agent.plan.rest', 'rest');
  return `${labels.workoutDay(strengthDay.name)}${cardioSuffix}`;
}

export function createCurrentPlanTool(
  context: SummaryToolContext,
  dependencies: CurrentPlanDependencies = defaultDependencies,
  now: () => Date = () => new Date(),
) {
  return defineSummaryTool<typeof parameters, { planVersion: number | null }>(
    {
      name: 'get_current_plan',
      label: 'Read current plan',
      description:
        "Read the trainee's active plan as a bounded summary: goal, the weekly schedule with each training day's exercises, cardio minutes, daily nutrition targets and the sleep target. Optionally focus on one weekday (1 = Monday).",
      parameters,
      async summarize(params, ctx): Promise<SummaryDraft<{ planVersion: number | null }>> {
        const labels = await loadToolLabels(ctx.locale);
        const snapshot = await dependencies.loadSnapshot(ctx.userId);
        if (!snapshot) {
          return {
            text: labels.text(
              'agent.plan.noPlan',
              'No active personalized plan yet. The trainee can generate one from the assessment.',
            ),
            details: { planVersion: null },
          };
        }

        const focusWeekday =
          params.dayOfWeek ?? isoWeekdayInTimeZone(now(), snapshot.timeZone);
        return {
          text: summarizePlan(labels, snapshot, focusWeekday, now()),
          details: { planVersion: snapshot.version },
        };
      },
    },
    context,
  );
}
