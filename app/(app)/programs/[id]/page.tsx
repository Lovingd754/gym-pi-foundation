import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { requireSession } from '@/lib/auth';
import { ensureExerciseCatalog } from '@/lib/exercise-catalog-sync';
import { getFitnessPlan } from '@/lib/fitness/plan-store';
import { getWeeklyReviewState } from '@/lib/fitness/weekly-review-store';
import { ProgramDetailView } from '@/components/programs/program-detail-view';
import { ManagedProgramView } from '@/components/fitness/managed-program-view';

interface Props {
  params: Promise<{ id: string }>;
}

export default async function ProgramDetailPage(props: Props) {
  const params = await props.params;
  const session = await requireSession();

  const program = await db.program.findFirst({
    where: { id: params.id, userId: session.userId },
    include: {
      // Managed (personalized) programs are versioned prescriptions: the detail
      // view hides its structure mutation commands for them.
      fitnessPlanVersion: { select: { id: true, version: true, content: true } },
      workouts: {
        orderBy: { order: 'asc' },
        include: {
          exercises: {
            orderBy: { order: 'asc' },
            include: { exercise: true },
          },
        },
      },
    },
  });

  if (!program) notFound();

  await ensureExerciseCatalog(session.userId);
  const exercisesCatalog = await db.exercise.findMany({
    where: { userId: session.userId },
    orderBy: [{ muscleGroup: 'asc' }, { name: 'asc' }],
  });

  // An activated personalized plan gets a read-only screen instead of the
  // generic program editor: the whole prescription, not only the workouts.
  if (program.fitnessPlanVersion) {
    const [stored, profile, reviewState, user] = await Promise.all([
      getFitnessPlan(session.userId, program.fitnessPlanVersion.id),
      db.fitnessProfile.findUnique({
        where: { userId: session.userId },
        select: { timeZone: true },
      }),
      getWeeklyReviewState(session.userId),
      db.user.findUnique({
        where: { id: session.userId },
        select: { weeklyAutoReplan: true },
      }),
    ]);
    if (!stored) notFound();
    return (
      <main className="flex-1 px-4 py-6">
        <ManagedProgramView
          program={{ ...program, fitnessPlanVersion: program.fitnessPlanVersion }}
          plan={stored.plan}
          reviewState={reviewState}
          weeklyAutoReplan={user?.weeklyAutoReplan ?? false}
          todayWeekday={isoWeekdayInTimeZone(new Date(), profile?.timeZone ?? 'UTC')}
        />
      </main>
    );
  }

  return (
    <main className="flex-1 px-4 py-6">
      <ProgramDetailView program={program} catalog={exercisesCatalog} />
    </main>
  );
}

// 1 = Monday ... 7 = Sunday, in the user's own time zone rather than the
// server's, because "today's workout" is a local-calendar question.
function isoWeekdayInTimeZone(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
  }).formatToParts(now);
  const weekday = parts.find((part) => part.type === 'weekday')?.value ?? 'Mon';
  const index = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(weekday);
  return index < 0 ? 1 : index + 1;
}
