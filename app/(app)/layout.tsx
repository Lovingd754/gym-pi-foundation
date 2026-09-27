import { NotebookPen } from 'lucide-react';
import { getLocale } from 'next-intl/server';
import { LogoutButton } from '@/components/auth/logout-button';
import { NavLinks } from '@/components/shared/nav-links';
import { OfflineIndicator } from '@/components/shared/offline-indicator';
import { SyncBootstrap } from '@/components/shared/sync-bootstrap';
import { WeeklyReviewAuto } from '@/components/fitness/weekly-review-auto';
import { ThemeToggle } from '@/components/shared/theme-toggle';
import { LanguageSelector } from '@/components/shared/language-selector';
import Link from 'next/link';
import { db } from '@/lib/db';
import { getCurrentSession } from '@/lib/auth';
import { brandName } from '@/lib/brand';

// Layout for protected routes (post-login).
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const name = brandName(await getLocale());
  // The weekly review runs from the shell so it is not tied to which screen the
  // trainee opens first. Unauthenticated renders (the layout wraps the auth
  // pages too) simply have nobody to review.
  const session = await getCurrentSession();
  const weeklyAutoReplan = session
    ? ((
        await db.user.findUnique({
          where: { id: session.userId },
          select: { weeklyAutoReplan: true },
        })
      )?.weeklyAutoReplan ?? false)
    : false;
  return (
    <div className="flex min-h-screen flex-col">
      <WeeklyReviewAuto enabled={weeklyAutoReplan} />
      <SyncBootstrap />
      <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur">
        <div className="flex items-center justify-between px-4 py-3">
          <Link href="/" className="flex items-center gap-2">
            <NotebookPen className="size-5" />
            <span className="text-base font-semibold tracking-tight">{name}</span>
          </Link>
          <div className="flex items-center gap-2">
            <OfflineIndicator />
            <LanguageSelector />
            <ThemeToggle />
            <LogoutButton />
          </div>
        </div>
        <NavLinks />
      </header>
      {children}
    </div>
  );
}
