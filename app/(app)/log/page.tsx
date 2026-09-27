import { ClipboardCheck } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { requireSession } from '@/lib/auth';
import { db } from '@/lib/db';
import { loadQuickLogState } from '@/lib/quick-log';
import { unitLabel } from '@/lib/units';
import { QuickLog } from '@/components/log/quick-log';

export default async function QuickLogPage() {
  const t = await getTranslations('quickLog');
  const auth = await requireSession();

  const [state, user] = await Promise.all([
    loadQuickLogState(auth.userId),
    db.user.findUnique({ where: { id: auth.userId }, select: { unit: true } }),
  ]);

  return (
    <main className="flex-1 px-4 py-6">
      <div className="mx-auto flex max-w-2xl flex-col gap-4">
        <div className="flex items-center gap-3">
          <ClipboardCheck className="size-6" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
            <p className="text-xs text-muted-foreground">{t('subtitle')}</p>
          </div>
        </div>

        <QuickLog
          exercises={state.exercises}
          todaySets={state.todaySets}
          unitLabel={unitLabel(user?.unit ?? 'KG')}
        />
      </div>
    </main>
  );
}
