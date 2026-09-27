'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { supportedAssessmentEquipmentValues } from '@/lib/fitness/exercise-keys';
import type { WeeklyActivity } from '@/lib/fitness/weekly-activities';

export function WeeklyActivitiesEditor({
  busy,
  onGenerate,
}: {
  busy: boolean;
  onGenerate: () => Promise<void> | void;
}) {
  const t = useTranslations('fitness');
  const [weekStart, setWeekStart] = useState('');
  const [activities, setActivities] = useState<WeeklyActivity[]>([]);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void fetch('/api/fitness/weekly-activities')
      .then(async (response) => {
        if (!response.ok) throw new Error('Activities unavailable');
        const data = (await response.json()) as { weekStart: string; activities: WeeklyActivity[] };
        if (!cancelled) {
          setWeekStart(data.weekStart);
          setActivities(data.activities);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  function update(dayOfWeek: number, patch: Partial<WeeklyActivity>) {
    setActivities((previous) => {
      const existing = previous.find((a) => a.dayOfWeek === dayOfWeek);
      // Preserve additional events for the same day received from other clients.
      const next = { dayOfWeek, description: '', unavailable: false, ...existing, ...patch };
      return existing ? previous.map((a) => (a === existing ? next : a)) : [...previous, next];
    });
  }
  async function generate() {
    setSaving(true);
    setFailed(false);
    try {
      const response = await fetch('/api/fitness/weekly-activities', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          weekStart,
          activities: activities.filter(
            (a) =>
              a.description.trim() ||
              a.unavailable ||
              a.availableMinutes !== undefined ||
              a.equipmentTypes !== undefined,
          ),
        }),
      });
      if (!response.ok) throw new Error('Activities not saved');
      await onGenerate();
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="flex flex-col gap-3">
      <p className="font-medium">
        {t('plan.review.activities.title')} {weekStart}
      </p>
      <p className="text-xs text-muted-foreground">{t('plan.review.activities.hint')}</p>
      {weekStart ? (
        <fieldset disabled={busy || saving} className="flex flex-col gap-3">
          {[1, 2, 3, 4, 5, 6, 7].map((day) => {
            const activity = activities.find((a) => a.dayOfWeek === day);
            const label = t(`assessment.weekdays.${day}` as never);
            return (
              <div key={day} className="flex flex-wrap items-center gap-2 rounded border p-2">
                <span className="w-12 text-xs">{label}</span>
                <input
                  className="min-w-0 flex-1 rounded border p-2"
                  maxLength={500}
                  aria-label={`${label} ${t('plan.review.activities.description')}`}
                  placeholder={t('plan.review.activities.description')}
                  value={activity?.description ?? ''}
                  onChange={(event) => update(day, { description: event.target.value })}
                />
                <label className="text-xs">
                  <input
                    type="checkbox"
                    checked={activity?.unavailable ?? false}
                    onChange={(event) => update(day, { unavailable: event.target.checked })}
                    aria-label={`${label} ${t('plan.review.activities.unavailable')}`}
                  />{' '}
                  {t('plan.review.activities.unavailable')}
                </label>
                <input
                  type="number"
                  min={0}
                  max={180}
                  className="w-24 rounded border p-2"
                  placeholder={t('plan.review.activities.minutes')}
                  aria-label={`${label} ${t('plan.review.activities.minutes')}`}
                  value={activity?.availableMinutes ?? ''}
                  onChange={(event) =>
                    update(day, {
                      availableMinutes:
                        event.target.value === '' ? undefined : Number(event.target.value),
                    })
                  }
                />
                <select
                  className="rounded border p-2 text-xs"
                  multiple
                  aria-label={`${label} ${t('plan.review.activities.equipment')}`}
                  value={activity?.equipmentTypes ?? []}
                  onChange={(event) =>
                    update(day, {
                      equipmentTypes: Array.from(
                        event.target.selectedOptions,
                        (option) => option.value,
                      ) as WeeklyActivity['equipmentTypes'],
                    })
                  }
                >
                  {supportedAssessmentEquipmentValues.map((equipment) => (
                    <option key={equipment} value={equipment}>
                      {t(`assessment.equipment.${equipment}` as never)}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </fieldset>
      ) : null}
      {failed ? (
        <p role="alert" className="text-destructive">
          {t('plan.review.activities.failed')}
        </p>
      ) : null}
      <Button
        type="button"
        className="self-start"
        disabled={!weekStart || busy || saving}
        onClick={() => void generate()}
      >
        {busy || saving ? t('plan.review.running') : t('plan.review.generate')}
      </Button>
    </section>
  );
}
