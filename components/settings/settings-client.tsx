'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { useTranslations } from 'next-intl';
import { Languages, Moon, Sun, Monitor } from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { LanguageSelector } from '@/components/shared/language-selector';

export function SettingsClient() {
  const t = useTranslations('settings');
  const common = useTranslations('common');
  const { theme, setTheme } = useTheme();
  // Only the client knows the stored theme, so the selected appearance button
  // must not be decided before mount: the server picked a different one and the
  // difference surfaced as a hydration mismatch on this page.
  const [hydrated, setHydrated] = useState(false);
  const activeTheme = hydrated ? theme : undefined;

  useEffect(() => {
    setHydrated(true);
  }, []);

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Languages className="size-4" />
            {common('language.label')}
          </h2>
          <p className="text-xs text-muted-foreground">{common('language.description')}</p>
        </CardHeader>
        <CardContent>
          <LanguageSelector showLabel />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <h2 className="text-base font-semibold">{t('appearance')}</h2>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <ThemeChoice
              current={activeTheme}
              value="dark"
              icon={<Moon className="size-4" />}
              label={common('theme.dark')}
              onClick={() => setTheme('dark')}
            />
            <ThemeChoice
              current={activeTheme}
              value="light"
              icon={<Sun className="size-4" />}
              label={common('theme.light')}
              onClick={() => setTheme('light')}
            />
            <ThemeChoice
              current={activeTheme}
              value="system"
              icon={<Monitor className="size-4" />}
              label={common('theme.system')}
              onClick={() => setTheme('system')}
            />
          </div>
        </CardContent>
      </Card>

      {/* The session preferences, the plate calculator and the data tools live
          in the components they belong to; the settings screen keeps only what
          the trainee actually changes here. */}
    </>
  );
}

function ThemeChoice({
  current,
  value,
  icon,
  label,
  onClick,
}: {
  current: string | undefined;
  value: 'dark' | 'light' | 'system';
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  const active = current === value;
  return (
    <Button
      type="button"
      variant={active ? 'default' : 'outline'}
      aria-pressed={active}
      onClick={onClick}
      className="min-h-tap"
    >
      {icon}
      <span className="ml-2">{label}</span>
    </Button>
  );
}
