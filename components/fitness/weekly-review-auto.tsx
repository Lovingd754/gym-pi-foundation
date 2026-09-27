'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

// The automatic half of the weekly review.
//
// It sits in the app shell rather than on the plan screen, so a trainee who only
// ever opens the conversation still ends up with a plan that keeps up with them.
// The work happens on the server and records the week it reviewed, so reloading
// the page cannot create the same weekly draft twice. Activation needs confirmation.
export function WeeklyReviewAuto({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const ran = useRef(false);

  useEffect(() => {
    if (!enabled || ran.current) return;
    ran.current = true;
    void (async () => {
      try {
        const state = await fetch('/api/fitness/plans/weekly-review');
        if (!state.ok) return;
        const body = (await state.json()) as { status?: string };
        if (body.status !== 'DUE') return;
        const applied = await fetch('/api/fitness/plans/weekly-review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ activate: false }),
        });
        if (applied.ok) router.refresh();
      } catch {
        // Best effort: the plan screen still offers the review on demand.
      }
    })();
  }, [enabled, router]);

  return null;
}
