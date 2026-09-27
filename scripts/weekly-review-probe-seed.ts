/**
 * Probe helper (not part of the test suite): backdates the newest weekly-review
 * probe account's plan by a week and seeds a week of evidence, so the weekly
 * review has something to be due about the next time the browser opens the plan.
 *
 * Run after scripts/weekly-review-probe.mjs has created the account:
 *   npx tsx scripts/weekly-review-probe-seed.ts
 */
import { PrismaClient } from '@/prisma/generated/client';
import { PrismaPg } from '@prisma/adapter-pg';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
const DAY_MS = 86_400_000;

async function main(): Promise<void> {
  const user = await prisma.user.findFirst({
    where: { email: { startsWith: 'weekly-review-' } },
    orderBy: { createdAt: 'desc' },
  });
  if (!user) throw new Error('no probe account yet: run weekly-review-probe.mjs first');

  const activation = await prisma.fitnessPlanActivation.findUniqueOrThrow({
    where: { userId: user.id },
    select: { planVersionId: true },
  });
  if (!activation.planVersionId) throw new Error('the probe account has no active plan');
  await prisma.fitnessPlanVersion.update({
    where: { id: activation.planVersionId },
    data: { activatedAt: new Date(Date.now() - 8 * DAY_MS) },
  });

  const now = new Date();
  const windowStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 7),
  );
  const dayOfWeekInWindow = (weekday: number): Date => {
    for (let offset = 0; offset < 7; offset += 1) {
      const candidate = new Date(windowStart.getTime() + offset * DAY_MS);
      const iso = candidate.getUTCDay() === 0 ? 7 : candidate.getUTCDay();
      if (iso === weekday) return new Date(candidate.getTime() + 12 * 60 * 60 * 1000);
    }
    throw new Error(`no weekday ${weekday} in the window`);
  };

  // Two of the three planned days, no cardio: enough for the review to have an
  // opinion without inventing a dramatic week.
  // A strength movement: cardio sets are stored in a different shape and do not
  // count as a training day.
  const exercise = await prisma.exercise.findFirstOrThrow({
    where: { userId: user.id, category: { not: 'CARDIO' } },
  });
  for (const weekday of [1, 3]) {
    const startedAt = dayOfWeekInWindow(weekday);
    const session = await prisma.session.create({
      data: {
        userId: user.id,
        startedAt,
        finishedAt: new Date(startedAt.getTime() + 45 * 60_000),
      },
    });
    await prisma.set.create({
      data: {
        sessionId: session.id,
        exerciseId: exercise.id,
        setNumber: 1,
        weight: 30,
        reps: 8,
        completedAt: startedAt,
      },
    });
  }

  await prisma.bodyweightEntry.create({
    data: { userId: user.id, weightKg: 72, measuredAt: dayOfWeekInWindow(1) },
  });
  await prisma.bodyweightEntry.create({
    data: { userId: user.id, weightKg: 71.7, measuredAt: new Date() },
  });

  console.log(`seeded two sessions and a weigh-in for ${user.email}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
