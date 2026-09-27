import Link from 'next/link';
import { CalendarDays, ChevronRight, MoonStar } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';
import type { Exercise, Program, ProgramExercise, Workout } from '@/lib/prisma-client';
import { Badge } from '@/components/ui/badge';
import { StartWorkoutButton } from '@/components/session/start-workout-button';
import { PlanLifestyleSections } from '@/components/fitness/plan-lifestyle-sections';
import { WeeklyReviewCard } from '@/components/fitness/weekly-review-card';
import { getTrainingDisplayName } from '@/i18n/training-names';
import { getExerciseDisplayName } from '@/i18n/exercise-names';
import type { FitnessPlanView } from '@/lib/fitness/plan-store';
import type { WeeklyReviewState } from '@/lib/fitness/weekly-review-store';

type ProgramExerciseWithExercise = ProgramExercise & { exercise: Exercise };
type WorkoutWithExercises = Workout & { exercises: ProgramExerciseWithExercise[] };
export type ManagedProgram = Program & {
  workouts: WorkoutWithExercises[];
  fitnessPlanVersion: { id: string; version: number; content: unknown };
};

// The landing screen for an activated personalized plan: what to do today, the
// week, and one way in. The prescription itself is read-only here - the plan was
// confirmed in the preview, and changing it means generating a new version - so
// none of the structure editing commands from the generic program screen appear.
export async function ManagedProgramView({
  program,
  plan,
  reviewState,
  weeklyAutoReplan,
  todayWeekday,
}: {
  program: ManagedProgram;
  // The stored plan version this program was materialized from. The screen
  // shows the whole prescription - training, food, cardio, sleep - because the
  // trainee comes back here between sessions to check what they are supposed to
  // be doing, and "what do I eat" is part of that.
  plan: FitnessPlanView;
  // Where the weekly review stands for this account, and whether it runs on its
  // own. The plan screen is where the trainee sees what the review concluded.
  reviewState: WeeklyReviewState;
  weeklyAutoReplan: boolean;
  // 1 = Monday through 7 = Sunday, resolved by the page in the user's time zone.
  todayWeekday: number;
}) {
  const t = await getTranslations('fitness');
  const locale = await getLocale();
  const content = plan.content;
  const workoutByStrengthIndex = new Map(
    program.workouts.map((workout) => [workout.order - 1, workout]),
  );
  const today = content.schedule.days.find((day) => day.dayOfWeek === todayWeekday) ?? null;
  const todayWorkout =
    today?.strengthDayIndex == null
      ? null
      : (workoutByStrengthIndex.get(today.strengthDayIndex) ?? null);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">
            {getTrainingDisplayName(program.name, locale)}
          </h1>
          <Badge variant="secondary">
            {t('plan.managedBadge', { version: program.fitnessPlanVersion.version })}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {t('plan.strength.summary', {
            split: t(`plan.splits.${content.strength.split}` as never),
            days: content.strength.days.length,
            sets: content.strength.weeklyTargetSets,
          })}
        </p>
      </header>

      <section className="flex flex-col gap-3 border-t border-border pt-4">
        <h2 className="text-sm font-medium">{t('plan.todayTitle')}</h2>
        {todayWorkout ? (
          <div className="flex flex-col gap-3 rounded-md border border-border p-4">
            <p className="text-lg font-medium">
              {getTrainingDisplayName(todayWorkout.name, locale)}
            </p>
            <ul className="flex flex-col gap-1 text-sm">
              {todayWorkout.exercises.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-baseline gap-2">
                  <span>{getExerciseDisplayName(entry.exercise.name, locale)}</span>
                  <span className="numeric text-muted-foreground">
                    {t('plan.setsRepsRir', {
                      sets: entry.targetSets,
                      reps:
                        entry.targetRepsMin === entry.targetRepsMax
                          ? entry.targetRepsMin
                          : `${entry.targetRepsMin}-${entry.targetRepsMax}`,
                      rir: entry.targetRIR,
                    })}
                  </span>
                </li>
              ))}
            </ul>
            <StartWorkoutButton workoutId={todayWorkout.id} />
          </div>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <MoonStar className="size-4" />
            {today && today.cardioMin > 0
              ? t('plan.cardioToday', { minutes: today.cardioMin })
              : t('plan.restToday')}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-2 border-t border-border pt-4">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <CalendarDays className="size-4" />
          {t('plan.sections.schedule')}
        </h2>
        <ul className="flex flex-col">
          {content.schedule.days.map((day) => {
            const workout =
              day.strengthDayIndex == null
                ? null
                : (workoutByStrengthIndex.get(day.strengthDayIndex) ?? null);
            return (
              <li
                key={day.dayOfWeek}
                className={`flex flex-wrap items-baseline gap-2 border-b border-border py-2 text-sm last:border-b-0 ${
                  day.dayOfWeek === todayWeekday ? 'font-medium' : ''
                }`}
              >
                <span className="w-10 shrink-0 text-muted-foreground">
                  {t(`assessment.weekdays.${day.dayOfWeek}` as never)}
                </span>
                <span className="flex-1">
                  {workout
                    ? getTrainingDisplayName(workout.name, locale)
                    : day.cardioMin > 0
                      ? t('plan.cardioToday', { minutes: day.cardioMin })
                      : t('plan.restToday')}
                </span>
                {workout && (
                  <span className="numeric text-xs text-muted-foreground">
                    {t('plan.exerciseCount', { count: workout.exercises.length })}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <PlanLifestyleSections content={content} energy={plan.energy} />

      <WeeklyReviewCard initial={reviewState} automatic={weeklyAutoReplan} />

      <div className="flex flex-col gap-2 border-t border-border pt-4">
        <Link
          href={`/fitness/plans/${plan.id}/preview`}
          className="flex items-center justify-between gap-3 rounded-md border border-border p-3 text-sm transition-colors hover:bg-accent/40"
        >
          <span>{t('plan.fullPlanLink')}</span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        </Link>
        <Link
          href="/fitness/plans"
          className="flex items-center justify-between gap-3 rounded-md border border-border p-3 text-sm transition-colors hover:bg-accent/40"
        >
          <span>{t('plan.historyLink')}</span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        </Link>
      </div>

      <p className="border-t border-border pt-4 text-xs text-muted-foreground">{t('disclaimer')}</p>
    </div>
  );
}
