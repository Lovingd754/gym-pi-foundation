import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { requireSession } from '@/lib/auth';
import { resolveFitnessDashboardEntry } from '@/lib/fitness/dashboard-entry';

// The conversation is the product's front door, so this route is only a
// decision: assessment first for an account that has never done it, the chat
// otherwise. The dashboard that used to live here was a second, competing home
// screen; its one irreplaceable job - sending a new trainee into the assessment
// - is what remains.
export default async function RootPage() {
  const session = await requireSession();

  const [fitnessUser, fitnessProfile, activeFitnessPlan] = await Promise.all([
    db.user.findUnique({
      where: { id: session.userId },
      select: { fitnessOnboardingRequired: true },
    }),
    db.fitnessProfile.findUnique({ where: { userId: session.userId }, select: { id: true } }),
    db.fitnessPlanVersion.findFirst({
      where: { userId: session.userId, status: 'ACTIVE' },
      select: { id: true },
    }),
  ]);

  const fitnessEntry = resolveFitnessDashboardEntry({
    onboardingRequired: fitnessUser?.fitnessOnboardingRequired ?? false,
    hasProfile: Boolean(fitnessProfile),
    hasActivePlan: Boolean(activeFitnessPlan),
  });
  if (fitnessEntry === 'REQUIRED_REDIRECT') redirect('/fitness/setup');

  redirect('/chat');
}
