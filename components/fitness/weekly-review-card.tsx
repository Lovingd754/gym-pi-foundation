'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertTriangle, CalendarCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import type { WeeklyReviewState } from '@/lib/fitness/weekly-review-store';
import type { WeekEvidence, WeeklyAdjustment } from '@/lib/fitness/weekly-review';
import { WeeklyActivitiesEditor } from './weekly-activities-editor';

// ============================================================
// What last week looked like, and what that changed
// ============================================================
// A plan that never reacts to the weeks it was wrong about is a wish, not a
// plan. This card is the trainee-facing half of the weekly review: the numbers
// the review actually looked at, the adjustments it made in plain language, and
// the two ways to run it - automatically, or on demand.

export function WeeklyReviewCard({
  initial,
  automatic,
}: {
  initial: WeeklyReviewState;
  automatic: boolean;
}) {
  const t = useTranslations('fitness');
  const router = useRouter();
  const [state, setState] = useState<WeeklyReviewState>(initial);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [failureCode, setFailureCode] = useState<string | null>(null);

  // The automatic review runs in the shell, so the first render can land in the
  // middle of it (a draft exists, the summary does not yet). Following the
  // server's state instead of freezing the first one means the card shows what
  // the review concluded as soon as the shell refreshes the page.
  useEffect(() => {
    setState(initial);
  }, [initial]);

  const run = useCallback(
    async ({ activate, force }: { activate: boolean; force: boolean }) => {
      setBusy(true);
      setFailed(false);
      setFailureCode(null);
      try {
        const response = await fetch('/api/fitness/plans/weekly-review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ activate, force }),
        });
        if (!response.ok) {
          const error = (await response.json().catch(() => ({}))) as { error?: string };
          setFailureCode(error.error ?? null);
          setFailed(true);
          return;
        }
        const outcome = (await response.json()) as {
          created: boolean;
          planId?: string;
          activated?: boolean;
        };
        // The manual path stops at the preview: the trainee sees the changes and
        // confirms them, exactly like any other replacement plan.
        if (outcome.created && !outcome.activated && outcome.planId) {
          router.push(`/fitness/plans/${outcome.planId}/preview`);
          return;
        }
        const refreshed = await fetch('/api/fitness/plans/weekly-review');
        if (refreshed.ok) setState((await refreshed.json()) as WeeklyReviewState);
        router.refresh();
      } catch {
        setFailed(true);
      } finally {
        setBusy(false);
      }
    },
    [router],
  );

  if (state.status === 'NO_ACTIVE_PLAN') return null;

  const summary = state.lastReview;
  const evidence = 'evidence' in state ? state.evidence : (summary?.evidence ?? null);

  return (
    <Card>
      <CardHeader className="pb-3">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <CalendarCheck className="size-4" />
          {t('plan.review.title')}
        </h2>
        <p className="text-xs text-muted-foreground">{t('plan.review.description')}</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <WeeklyActivitiesEditor
          busy={busy}
          onGenerate={() => run({ activate: false, force: true })}
        />
        {numberSummary(t, evidence)}

        {summary ? (
          <div className="flex flex-col gap-2 border-t border-border pt-3">
            <p className="text-xs font-medium text-muted-foreground">
              {t('plan.review.adjustmentsTitle')}
            </p>
            {summary.rationale ? <p>{summary.rationale}</p> : null}
            <ul className="flex flex-col gap-1">
              {summary.adjustments
                // "Starting loads stay as they are" is a footnote, not a change;
                // printing it next to the changes buries them.
                .filter((adjustment) => adjustment.code !== 'LOADS_UNCHANGED')
                .map((adjustment) => (
                  <li key={adjustment.code}>{describeAdjustment(t, adjustment)}</li>
                ))}
            </ul>
            {summary.activated ? (
              <p className="text-xs text-muted-foreground">{t('plan.review.applied')}</p>
            ) : summary.planId ? (
              <Button asChild variant="outline" size="sm" className="self-start">
                <Link href={`/fitness/plans/${summary.planId}/preview`}>
                  {t('plan.review.confirmDraft')}
                </Link>
              </Button>
            ) : null}
          </div>
        ) : null}

        {failed ? (
          <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
            <AlertTriangle className="size-4" />
            {failureCode === 'WEEKLY_SCHEDULE_INFEASIBLE'
              ? t('plan.review.infeasible')
              : failureCode === 'WEEKLY_MODEL_UNAVAILABLE'
                ? t('plan.review.modelUnavailable')
                : t('plan.review.failed')}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <span className="text-xs text-muted-foreground">
            {state.status === 'WAITING'
              ? t('plan.review.nextReview', { date: state.nextReviewDate })
              : automatic
                ? t('plan.review.autoOn')
                : t('plan.review.autoOff')}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

// The review only ever reports changes it made, so this renders every code the
// rules can emit - an unhandled one would show up as a blank line.
function describeAdjustment(
  t: ReturnType<typeof useTranslations<'fitness'>>,
  adjustment: WeeklyAdjustment,
): string {
  const key = `plan.review.adjustments.${adjustment.code}` as const;
  switch (adjustment.kind) {
    case 'CALORIES':
      return t(key, {
        before: formatRange(adjustment.before),
        after: formatRange(adjustment.after),
      });
    case 'TRAINING_DAYS':
      return t(key, {
        before: formatWeekdays(t, adjustment.before),
        after: formatWeekdays(t, adjustment.after),
        missed: adjustment.before.length - adjustment.after.length,
      });
    case 'CARDIO':
      return t(key, { before: adjustment.before, after: adjustment.after });
    case 'LOADS':
      return t(key, { count: adjustment.refreshed });
    case 'KEEP':
      return t(key);
  }
}

function numberSummary(
  t: ReturnType<typeof useTranslations<'fitness'>>,
  evidence: WeekEvidence | null,
) {
  if (!evidence) return null;
  return (
    <ul className="flex flex-col gap-1">
      <li>
        {t('plan.review.sessions', {
          done: evidence.completedSessions,
          planned: evidence.plannedSessions,
        })}
      </li>
      {evidence.cardioPlannedMin > 0 ? (
        <li>
          {t('plan.review.cardio', {
            done: evidence.cardioCompletedMin,
            planned: evidence.cardioPlannedMin,
          })}
        </li>
      ) : null}
      {evidence.weightStartKg !== null && evidence.weightEndKg !== null ? (
        <li>
          {t('plan.review.weight', {
            from: evidence.weightStartKg,
            to: evidence.weightEndKg,
            delta: formatDelta(evidence.weightEndKg - evidence.weightStartKg),
          })}
        </li>
      ) : null}
      {evidence.waistStartCm !== null && evidence.waistEndCm !== null ? (
        <li>
          {t('plan.review.waist', {
            from: evidence.waistStartCm,
            to: evidence.waistEndCm,
            delta: formatDelta(evidence.waistEndCm - evidence.waistStartCm),
          })}
        </li>
      ) : null}
    </ul>
  );
}

function formatRange(range: { min: number; max: number }): string {
  return range.min === range.max ? String(range.min) : `${range.min}-${range.max}`;
}

function formatWeekdays(
  t: ReturnType<typeof useTranslations<'fitness'>>,
  days: readonly number[],
): string {
  return days.map((day) => t(`assessment.weekdays.${day}` as never)).join('、');
}

function formatDelta(value: number): string {
  return `${value > 0 ? '+' : ''}${Math.round(value * 10) / 10}`;
}
