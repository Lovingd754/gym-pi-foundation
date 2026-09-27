'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Check, LibraryBig, Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ExerciseFormDialog } from '@/components/exercises/exercise-form-dialog';
import { useExerciseName } from '@/components/shared/use-exercise-name';
import { cn } from '@/lib/utils';

// An empty search shows the movements they actually train; once they type, the
// whole library is searched. Both are capped so the chip list stays a list and
// not a wall, and the cap is reported rather than silent.
const RECENT_LIMIT = 12;
const SEARCH_LIMIT = 40;

export interface QuickLogExerciseView {
  id: string;
  name: string;
  category: string;
  lastWeight: number | null;
  lastReps: number | null;
  lastSets: number | null;
}

export interface QuickLogSetView {
  id: string;
  exerciseName: string;
  setNumber: number;
  weight: number;
  reps: number;
}

// A few taps to record what just happened. The form deliberately keeps the
// numbers after a save - the common case is another set of the same movement -
// and shows today's entries underneath so the result is visible without leaving
// the screen.
export function QuickLog({
  exercises,
  todaySets,
  unitLabel,
}: {
  exercises: QuickLogExerciseView[];
  todaySets: QuickLogSetView[];
  unitLabel: string;
}) {
  const t = useTranslations('quickLog');
  const exerciseName = useExerciseName();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [weight, setWeight] = useState('');
  const [reps, setReps] = useState('8');
  const [sets, setSets] = useState('3');
  const [saving, setSaving] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  // Only prefill when the selection changes, never on a data refresh: the
  // trainee's own edits must survive their last save.
  const prefilledFor = useRef<string | null>(null);

  const strength = exercises.filter((exercise) => exercise.category !== 'CARDIO');
  const needle = query.trim().toLowerCase();
  const matches =
    needle === ''
      ? strength
      : strength.filter((exercise) => exerciseName(exercise.name).toLowerCase().includes(needle));
  const limit = needle === '' ? RECENT_LIMIT : SEARCH_LIMIT;
  const visible = matches.slice(0, limit);
  const hidden = matches.length - visible.length;
  const selected = strength.find((exercise) => exercise.id === selectedId) ?? null;

  function select(exercise: QuickLogExerciseView) {
    setSelectedId(exercise.id);
    if (prefilledFor.current === exercise.id) return;
    prefilledFor.current = exercise.id;
    setWeight(exercise.lastWeight === null ? '' : String(exercise.lastWeight));
    setReps(exercise.lastReps === null ? '8' : String(exercise.lastReps));
    setSets(exercise.lastSets === null ? '3' : String(exercise.lastSets));
  }

  async function save() {
    if (!selected || saving) return;
    const weightValue = Number(weight === '' ? 0 : weight);
    const repsValue = Number(reps);
    const setsValue = Number(sets);
    if (
      !Number.isFinite(weightValue) ||
      weightValue < 0 ||
      !Number.isInteger(repsValue) ||
      repsValue < 1 ||
      !Number.isInteger(setsValue) ||
      setsValue < 1
    ) {
      toast.error(t('invalid'));
      return;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          exerciseId: selected.id,
          weight: weightValue,
          reps: repsValue,
          sets: setsValue,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success(t('saved'));
      router.refresh();
    } catch {
      toast.error(t('saveError'));
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    try {
      const res = await fetch(`/api/sets/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success(t('deleted'));
      router.refresh();
    } catch {
      toast.error(t('deleteError'));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-base">{t('chooseExercise')}</CardTitle>
            <Button asChild variant="ghost" size="sm" className="shrink-0 text-muted-foreground">
              <Link href="/exercises">
                <LibraryBig className="size-4" />
                <span className="ml-1.5">{t('openLibrary')}</span>
              </Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {strength.length === 0 ? (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-muted-foreground">
                {exercises.length === 0 ? t('noExercises') : t('noStrengthExercises')}
              </p>
              <Button variant="outline" className="min-h-tap" onClick={() => setCreateOpen(true)}>
                <Plus className="size-4" />
                <span className="ml-2">{t('addExercise')}</span>
              </Button>
            </div>
          ) : (
            <>
              <div className="flex gap-2">
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t('search')}
                  aria-label={t('search')}
                  className="h-11"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-11 shrink-0"
                  onClick={() => setCreateOpen(true)}
                  aria-label={t('addExercise')}
                  title={t('addExercise')}
                >
                  <Plus className="size-4" />
                </Button>
              </div>
              {visible.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('noMatch')}</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {visible.map((exercise) => (
                    <button
                      key={exercise.id}
                      type="button"
                      aria-pressed={exercise.id === selectedId}
                      onClick={() => select(exercise)}
                      className={cn(
                        'h-10 rounded-md border px-3 text-sm transition-colors',
                        exercise.id === selectedId
                          ? 'border-primary bg-secondary text-secondary-foreground'
                          : 'border-border hover:bg-accent',
                      )}
                    >
                      {exerciseName(exercise.name)}
                    </button>
                  ))}
                </div>
              )}
              {hidden > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t('moreMatches', { count: hidden })}
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <div className="grid grid-cols-3 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="quick-weight" className="text-sm">
                {t('weight')} ({unitLabel})
              </Label>
              <Input
                id="quick-weight"
                inputMode="decimal"
                value={weight}
                onChange={(event) => setWeight(event.target.value)}
                className="h-11"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="quick-reps" className="text-sm">
                {t('reps')}
              </Label>
              <Input
                id="quick-reps"
                inputMode="numeric"
                value={reps}
                onChange={(event) => setReps(event.target.value)}
                className="h-11"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="quick-sets" className="text-sm">
                {t('sets')}
              </Label>
              <Input
                id="quick-sets"
                inputMode="numeric"
                value={sets}
                onChange={(event) => setSets(event.target.value)}
                className="h-11"
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{t('bodyweight')}</p>
          <Button onClick={() => void save()} disabled={!selected || saving} className="h-11">
            {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            {saving ? t('saving') : t('save')}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t('todayTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          {todaySets.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('todayEmpty')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {todaySets.map((set) => (
                <li
                  key={set.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm"
                >
                  <span className="flex items-center gap-2">
                    <Check className="size-3.5 text-muted-foreground" />
                    {exerciseName(set.exerciseName)}
                  </span>
                  <span className="flex items-center gap-3 text-muted-foreground">
                    {set.weight === 0 ? 'BW' : `${set.weight} ${unitLabel}`} × {set.reps}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void remove(set.id)}
                      aria-label={t('deleteSet')}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* The library is 100+ movements, so anything not in the default list is
          one dialog away instead of a dead end. */}
      <ExerciseFormDialog open={createOpen} onOpenChange={setCreateOpen} mode="create" />
    </div>
  );
}
