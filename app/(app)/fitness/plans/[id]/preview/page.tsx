import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth';
import { db } from '@/lib/db';
import { PlanPreview } from '@/components/fitness/plan-preview';

interface Props {
  params: Promise<{ id: string }>;
}

// The page only proves ownership and passes the id: the client component reads
// the plan through the API, so a revision conflict can refresh through the same
// path instead of needing a full navigation.
export default async function FitnessPlanPreviewPage(props: Props) {
  const params = await props.params;
  const session = await requireSession();
  const owned = await db.fitnessPlanVersion.findFirst({
    where: { id: params.id, userId: session.userId },
    select: { id: true },
  });
  if (!owned) notFound();

  return (
    <main className="flex-1 px-4 py-6">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <PlanPreview planId={owned.id} />
      </div>
    </main>
  );
}
