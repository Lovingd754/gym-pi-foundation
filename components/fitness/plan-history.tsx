'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

// The history list is metadata only: the API deliberately omits screening
// answers and the stored calculation input, so nothing sensitive reaches this
// component or the DOM.
type PlanSummary = {
  id: string;
  version: number;
  status: string;
  goal: { type: string; desiredWeeklyRatePct: number };
  createdAt: string;
  activatedAt: string | null;
  programId: string | null;
};

export function PlanHistory() {
  const t = useTranslations('fitness');
  const [plans, setPlans] = useState<PlanSummary[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch('/api/fitness/plans');
        if (!response.ok) {
          setFailed(true);
          return;
        }
        const body = (await response.json()) as { plans: PlanSummary[] };
        setPlans(body.plans);
      } catch {
        setFailed(true);
      }
    })();
  }, []);

  if (failed) {
    return (
      <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
        <AlertTriangle className="size-4" />
        {t('actions.error')}
      </p>
    );
  }

  if (plans === null) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {t('plan.loading')}
      </p>
    );
  }

  if (plans.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('plan.historyEmpty')}</p>;
  }

  return (
    <ul className="flex flex-col gap-2">
      {plans.map((plan) => (
        <li key={plan.id} className="rounded-md border border-border p-3">
          <Link href={`/fitness/plans/${plan.id}/preview`} className="flex flex-col gap-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">v{plan.version}</span>
              <Badge variant={plan.status === 'ACTIVE' ? 'default' : 'secondary'}>
                {t(`plan.statuses.${plan.status}` as never)}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {t(`assessment.goalTypes.${plan.goal.type}` as never)}
              </span>
            </span>
            <span className="text-xs text-muted-foreground">{plan.createdAt.slice(0, 10)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
