import Link from 'next/link';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { ChevronRight, History as HistoryIcon } from 'lucide-react';
import { db } from '@/lib/db';
import { requireSession } from '@/lib/auth';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { formatWeight } from '@/lib/units';
import { formatDistance } from '@/lib/cardio';
import { groupSessionsByDay, summarizeSessionExercises } from '@/lib/history-summary';
import { HistoryFilters } from '@/components/history/history-filters';
import { getExerciseDisplayName } from '@/i18n/exercise-names';
import { getTrainingDisplayName } from '@/i18n/training-names';

interface SearchParams {
  programId?: string;
  month?: string; // YYYY-MM
}

export default async function HistoryPage(props: { searchParams: Promise<SearchParams> }) {
  const t = await getTranslations('history');
  const locale = await getLocale();
  const format = await getFormatter();
  const searchParams = await props.searchParams;
  const session = await requireSession();

  const hasActiveFilters = Boolean(searchParams.programId || searchParams.month);

  // Filters: program and month (YYYY-MM).
  const programFilter = searchParams.programId ? { programId: searchParams.programId } : {};

  let dateFilter: { startedAt?: { gte: Date; lt: Date } } = {};
  if (searchParams.month && /^\d{4}-\d{2}$/.test(searchParams.month)) {
    const [yStr, mStr] = searchParams.month.split('-');
    const y = Number(yStr);
    const m = Number(mStr);
    dateFilter = {
      startedAt: {
        gte: new Date(Date.UTC(y, m - 1, 1)),
        lt: new Date(Date.UTC(y, m, 1)),
      },
    };
  }

  const [sessions, programs, user] = await Promise.all([
    db.session.findMany({
      where: {
        userId: session.userId,
        finishedAt: { not: null },
        ...programFilter,
        ...dateFilter,
      },
      orderBy: { startedAt: 'desc' },
      include: {
        workout: { select: { name: true } },
        program: { select: { name: true } },
        sets: {
          select: {
            weight: true,
            reps: true,
            isWarmup: true,
            durationSec: true,
            distanceM: true,
            exercise: { select: { usesBodyweight: true, name: true, category: true } },
          },
        },
      },
      take: 100,
    }),
    db.program.findMany({
      where: { userId: session.userId },
      orderBy: [{ isActive: 'desc' }, { startDate: 'desc' }],
      select: { id: true, name: true },
    }),
    db.user.findUnique({
      where: { id: session.userId },
      select: { unit: true },
    }),
  ]);
  const unit = user?.unit ?? 'KG';

  return (
    <main className="flex-1 px-4 py-6">
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <div className="flex items-center gap-3">
          <HistoryIcon className="size-6" />
          <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
        </div>

        <HistoryFilters
          programs={programs}
          selectedProgramId={searchParams.programId}
          selectedMonth={searchParams.month}
        />

        {sessions.length === 0 ? (
          hasActiveFilters ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                {t('noFiltered')}
              </CardContent>
            </Card>
          ) : (
            <EmptyState
              icon={HistoryIcon}
              title={t('emptyTitle')}
              description={t('emptyDescription')}
              action={{ label: t('firstSession'), href: '/session/new' }}
            />
          )
        ) : (
          // One heading per day (the date belongs to the day, not to a single
          // card), then one row per movement inside that day's card. Minutes
          // and tonnage are gone on purpose: they made every line a mix of
          // numbers in different units. See lib/history-summary.ts.
          <div className="flex flex-col gap-6">
            {groupSessionsByDay(sessions).map((day) => (
              <section key={day.key} className="flex flex-col gap-2">
                <h2 className="px-1 text-sm font-semibold text-muted-foreground">
                  {format.dateTime(day.date, { day: '2-digit', month: 'long', year: 'numeric' })}
                  <span className="ml-1.5 font-normal">
                    {format.dateTime(day.date, { weekday: 'long' })}
                  </span>
                </h2>
                {day.sessions.map((s) => {
                  const lines = summarizeSessionExercises(
                    s.sets.map((set) => ({
                      weight: set.weight,
                      reps: set.reps,
                      isWarmup: set.isWarmup,
                      durationSec: set.durationSec,
                      distanceM: set.distanceM,
                      usesBodyweight: set.exercise.usesBodyweight,
                      exerciseName: set.exercise.name,
                      exerciseCategory: set.exercise.category,
                    })),
                  );
                  const isCardio = lines.length > 0 && lines.every((line) => line.isCardio);
                  return (
                    <Link
                      key={s.id}
                      href={`/history/${s.id}`}
                      className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Card className="transition-colors hover:bg-accent/40">
                        <CardContent className="p-0">
                          <div className="flex items-center justify-between gap-3 px-4 py-2.5">
                            <p className="truncate text-sm font-medium">
                              {s.workout?.name
                                ? getTrainingDisplayName(s.workout.name, locale)
                                : isCardio
                                  ? t('cardio')
                                  : t('freeSession')}
                            </p>
                            <div className="flex shrink-0 items-center gap-2">
                              {s.program && (
                                <Badge variant="secondary">
                                  {getTrainingDisplayName(s.program.name, locale)}
                                </Badge>
                              )}
                              <ChevronRight className="size-4 text-muted-foreground" />
                            </div>
                          </div>
                          {lines.length === 0 ? (
                            <p className="border-t border-border px-4 py-2.5 text-sm text-muted-foreground">
                              {t('detail.noSets')}
                            </p>
                          ) : (
                            <ul className="divide-y divide-border border-t border-border">
                              {lines.map((line) => (
                                <li
                                  key={line.name}
                                  className="flex items-baseline justify-between gap-3 px-4 py-1.5"
                                >
                                  <span className="min-w-0 flex-1 truncate text-sm">
                                    {getExerciseDisplayName(line.name, locale)}
                                  </span>
                                  <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                                    {line.isCardio
                                      ? line.distanceM > 0
                                        ? formatDistance(line.distanceM)
                                        : ''
                                      : t('setSummary', {
                                          weight:
                                            line.usesBodyweight && !line.topWeightKg
                                              ? t('bodyweightLoad')
                                              : formatWeight(line.topWeightKg ?? 0, unit, {
                                                  decimals: 1,
                                                  locale,
                                                }),
                                          reps: line.reps ?? 0,
                                          sets: line.workingSets,
                                        })}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </CardContent>
                      </Card>
                    </Link>
                  );
                })}
              </section>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
