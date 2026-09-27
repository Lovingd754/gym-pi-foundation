import { getTranslations } from 'next-intl/server';
import { requireSession } from '@/lib/auth';
import { PlanHistory } from '@/components/fitness/plan-history';

export default async function FitnessPlansPage() {
  const t = await getTranslations('fitness');
  await requireSession();

  return (
    <main className="flex-1 px-4 py-6">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <h1 className="text-xl font-semibold tracking-tight">{t('plan.historyTitle')}</h1>
        <PlanHistory />
      </div>
    </main>
  );
}
