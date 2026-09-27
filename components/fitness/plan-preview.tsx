'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useTrainingName } from '@/components/shared/use-training-name';
import { useExerciseName } from '@/components/shared/use-exercise-name';
import { PlanLifestyleSections } from '@/components/fitness/plan-lifestyle-sections';
import type { FitnessPlanContent } from '@/lib/fitness/plan-schema';

type PlanView = {
  id: string;
  version: number;
  status: string;
  content: FitnessPlanContent;
  // Present when a model shaped this plan: one sentence explaining why it looks
  // the way it does. Null for a neutral plan.
  strategy?: { rationale: string | null } | null;
  // The targets said in plain language: kilograms per month and what the daily
  // difference is worth in food.
  energy?: {
    direction: 'LOSE' | 'GAIN' | 'MAINTAIN';
    deficitKcal: number;
    monthlyChangeKg: number;
  } | null;
  comparison: {
    previousPlanId: string;
    changes: Array<{ metric: string; before: unknown; after: unknown }>;
  } | null;
};

type LoadedPlan = { plan: PlanView; activationRevision: number };

// The server page passes an id only: the client reads the plan through the same
// API the conflict path re-reads, so a revision clash can refresh in place.
export function PlanPreview({ planId }: { planId: string }) {
  const t = useTranslations('fitness');
  const router = useRouter();
  const trainingName = useTrainingName();
  const exerciseName = useExerciseName();
  const [state, setState] = useState<LoadedPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch(`/api/fitness/plans/${planId}`);
    if (!response.ok) {
      setState(null);
      setLoading(false);
      return;
    }
    setState((await response.json()) as LoadedPlan);
    setLoading(false);
  }, [planId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function confirm() {
    if (!state || confirming) return;
    setConfirming(true);
    setConflict(null);
    try {
      const response = await fetch(`/api/fitness/plans/${planId}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: state.activationRevision }),
      });
      if (response.ok) {
        const activated = (await response.json()) as { programId: string };
        router.push(`/programs/${activated.programId}`);
        return;
      }
      const failure = (await response.json().catch(() => ({}))) as { error?: string };
      if (failure.error === 'ACTIVATION_REVISION_CONFLICT') {
        setConflict(t('actions.revisionConflict'));
        await load();
        return;
      }
      if (failure.error === 'PLAN_INPUT_STALE') {
        router.push('/fitness/setup');
        return;
      }
      if (failure.error === 'WORKOUT_IN_PROGRESS') {
        setConflict(t('actions.workoutInProgress'));
        return;
      }
      setConflict(t('actions.error'));
    } finally {
      setConfirming(false);
    }
  }

  // The loading state reserves the final layout so nothing shifts on arrival.
  if (loading) {
    return (
      <div className="flex min-h-[24rem] flex-col gap-4" data-testid="plan-preview-loading">
        <div className="h-6 w-48 animate-pulse rounded bg-muted" />
        <div className="h-40 animate-pulse rounded-md bg-muted" />
        <div className="h-40 animate-pulse rounded-md bg-muted" />
        <p className="sr-only">{t('plan.loading')}</p>
      </div>
    );
  }

  if (!state) {
    return (
      <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
        <AlertTriangle className="size-4" />
        {t('actions.error')}
      </p>
    );
  }

  const { plan } = state;
  const content = plan.content;
  const isDraft = plan.status === 'DRAFT';

  return (
    <div className="flex flex-col gap-6 pb-24">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold tracking-tight">{t('plan.title')}</h1>
        <Badge variant="secondary">{t(`plan.statuses.${plan.status}` as never)}</Badge>
        {!isDraft && <span className="text-xs text-muted-foreground">{t('plan.readOnly')}</span>}
      </header>

      {conflict && (
        <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
          <AlertTriangle className="size-4" />
          {conflict}
        </p>
      )}

      {/* Summary */}
      <section className="flex flex-col gap-2 border-t border-border pt-4">
        <h2 className="text-sm font-medium">{t('plan.sections.strength')}</h2>
        <p className="text-sm">
          {t('plan.strength.summary', {
            split: t(`plan.splits.${content.strength.split}` as never),
            days: content.strength.days.length,
            sets: content.strength.weeklyTargetSets,
          })}
        </p>
        {content.strength.introRir === 3 && (
          <p className="text-sm text-muted-foreground">{t('plan.strength.introNote')}</p>
        )}
      </section>

      {/* Weekly schedule */}
      <section className="flex flex-col gap-3 border-t border-border pt-4">
        <h2 className="text-sm font-medium">{t('plan.sections.schedule')}</h2>
        {content.schedule.days.map((day) => {
          const strengthDay =
            day.strengthDayIndex === null
              ? null
              : (content.strength.days[day.strengthDayIndex] ?? null);
          return (
            <div key={day.dayOfWeek} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">
                  {t(`assessment.weekdays.${day.dayOfWeek}` as never)}
                  {strengthDay ? ` · ${trainingName(strengthDay.name)}` : ''}
                </p>
                <Badge variant="outline">
                  {day.kind === 'STRENGTH'
                    ? t('plan.schedule.strength')
                    : day.kind === 'CARDIO'
                      ? t('plan.schedule.cardio')
                      : day.kind === 'STRENGTH_AND_CARDIO'
                        ? t('plan.schedule.strengthAndCardio')
                        : t('plan.schedule.rest')}
                </Badge>
              </div>
              {strengthDay && (
                <>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('plan.strength.sessionLength', {
                      minutes: strengthDay.estimatedDurationMin,
                    })}
                  </p>
                  <ul className="mt-2 flex flex-col gap-1 text-sm">
                    {strengthDay.exercises.map((exercise) => (
                      <li
                        key={`${exercise.name}-${exercise.targetSets}`}
                        className="flex flex-wrap gap-2"
                      >
                        <span>{exerciseName(exercise.name)}</span>
                        <span className="text-muted-foreground">
                          {exercise.targetSets} × {exercise.targetRepsMin}-{exercise.targetRepsMax}{' '}
                          · RIR {exercise.targetRIR}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          );
        })}
      </section>

      {/* Nutrition, cardio and sleep: the same block the plan screen shows after
          activation, so the food does not disappear once the plan is in use. */}
      <PlanLifestyleSections content={content} energy={plan.energy} />

      {/* Starting loads */}
      <section className="flex flex-col gap-2 border-t border-border pt-4">
        <h2 className="text-sm font-medium">{t('plan.sections.load')}</h2>
        <ul className="flex flex-col gap-1 text-sm">
          {content.loadGuidance.map((entry) => (
            <li key={entry.catalogKey} className="flex flex-wrap gap-2">
              <span>
                {exerciseName(
                  content.strength.days
                    .flatMap((day) => day.exercises)
                    .find((exercise) => exercise.notes === `catalog:${entry.catalogKey}`)?.name ??
                    entry.catalogKey,
                )}
              </span>
              <span className="text-muted-foreground">
                {entry.initialLoadKg === null
                  ? t('assessment.calibration')
                  : `${entry.initialLoadKg} kg · ${t(`assessment.loadSource.${entry.source}` as never)}`}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {/* Why this plan */}
      {plan.strategy?.rationale ? (
        <section className="flex flex-col gap-2 border-t border-border pt-4">
          <h2 className="text-sm font-medium">{t('plan.sections.rationale')}</h2>
          <p className="text-sm text-muted-foreground">{plan.strategy.rationale}</p>
        </section>
      ) : null}

      {content.reasons.length > 0 && (
        <section className="flex flex-col gap-2 border-t border-border pt-4">
          <h2 className="text-sm font-medium">{t('plan.sections.reasons')}</h2>
          <ul className="flex flex-col gap-2 text-sm">
            {content.reasons.map((reason) => (
              <li key={reason}>
                <p className="font-medium">{t(`reasons.${reason}.title` as never)}</p>
                <p className="text-muted-foreground">{t(`reasons.${reason}.body` as never)}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Replacement diff: only changed metrics, never an empty section. */}
      {plan.comparison && plan.comparison.changes.length > 0 && (
        <section className="flex flex-col gap-2 border-t border-border pt-4">
          <h2 className="text-sm font-medium">{t('diff.title')}</h2>
          <ul className="flex flex-col gap-2 text-sm">
            {plan.comparison.changes.map((change) => (
              <li key={change.metric} className="flex flex-wrap gap-2">
                <span className="font-medium">{t(`plan.metrics.${change.metric}` as never)}</span>
                <span className="text-muted-foreground">
                  {formatComparisonValue(change.before)} → {formatComparisonValue(change.after)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="border-t border-border pt-4 text-xs text-muted-foreground">{t('disclaimer')}</p>

      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-background/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
          <Button asChild variant="outline" className="h-11">
            <Link href="/fitness/setup">{t('actions.editAssessment')}</Link>
          </Button>
          {isDraft ? (
            // Repeated clicks while a confirmation is in flight are ignored by
            // confirm() itself, so the command stays clickable and only ever
            // sends one activation request.
            <Button className="h-11" onClick={() => void confirm()}>
              {confirming ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : (
                <Check className="mr-2 size-4" />
              )}
              {confirming ? t('actions.confirming') : t('actions.confirm')}
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">{t('plan.readOnly')}</span>
          )}
        </div>
      </div>
    </div>
  );
}

function formatComparisonValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ');
  if (value && typeof value === 'object') {
    const range = value as { min?: number; max?: number };
    if (typeof range.min === 'number' && typeof range.max === 'number') {
      return range.min === range.max ? String(range.min) : `${range.min}-${range.max}`;
    }
    return JSON.stringify(value);
  }
  return String(value);
}
