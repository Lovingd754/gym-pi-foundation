'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

// The conversation is the product's main window and the only way in: `/` now
// redirects to it. Progress, coach and the exercise catalog remain in the
// codebase but out of the shell. Re-adding an entry is this array only.
const LINKS = [
  { href: '/chat', label: 'chat' },
  { href: '/log', label: 'quickLog' },
  { href: '/programs', label: 'programs' },
  { href: '/history', label: 'history' },
  { href: '/settings', label: 'settings' },
] as const;

export function NavLinks() {
  const pathname = usePathname();
  const t = useTranslations('navigation');
  return (
    <nav className="flex gap-1 overflow-x-auto border-t border-border px-2 py-1">
      {LINKS.map((link) => {
        const active = pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            className={cn(
              'rounded-md px-3 py-2 text-sm font-medium transition-colors',
              active
                ? 'bg-secondary text-secondary-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t(link.label)}
          </Link>
        );
      })}
    </nav>
  );
}
