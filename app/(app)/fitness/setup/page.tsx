import { getTranslations } from 'next-intl/server';
import { requireSession } from '@/lib/auth';
import { getCurrentAssessment } from '@/lib/fitness/assessment-store';
import { AssessmentWizard } from '@/components/fitness/assessment-wizard';

// The assessment lives inside the authenticated app shell: a constrained page
// section with a compact heading, no marketing hero and no nested card shell.
export default async function FitnessSetupPage() {
  const t = await getTranslations('fitness');
  const auth = await requireSession();
  const current = await getCurrentAssessment(auth.userId);

  return (
    <main className="flex-1 px-4 py-6">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('assessment.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('assessment.subtitle')}</p>
        </div>
        <AssessmentWizard
          savedAssessment={current.assessment}
          unit={current.unit}
          onboardingRequired={current.onboardingRequired}
        />
      </div>
    </main>
  );
}
