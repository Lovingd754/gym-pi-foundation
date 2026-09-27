'use client';

import { useState } from 'react';
import { CalendarCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

// Whether the weekly review runs itself. It is the trainee's plan, so it is the
// trainee's call: on, a plan that has run its week renews itself and the plan
// screen explains what changed; off, the review is offered and waits.
export function PlanSection({ initialAutoReplan }: { initialAutoReplan: boolean }) {
  const t = useTranslations('settings.plan');
  const [automatic, setAutomatic] = useState(initialAutoReplan);
  const [saving, setSaving] = useState(false);

  async function toggle(next: boolean) {
    const previous = automatic;
    setAutomatic(next);
    setSaving(true);
    try {
      const res = await fetch('/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ weeklyAutoReplan: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success(t('saved'));
    } catch {
      setAutomatic(previous);
      toast.error(t('failed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarCheck className="size-4" />
          {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="weekly-auto-replan" className="text-sm font-normal">
            {t('autoLabel')}
          </Label>
          <Switch
            id="weekly-auto-replan"
            checked={automatic}
            disabled={saving}
            onCheckedChange={(next) => void toggle(next)}
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {automatic ? t('autoOn') : t('autoOff')}
        </p>
      </CardContent>
    </Card>
  );
}
