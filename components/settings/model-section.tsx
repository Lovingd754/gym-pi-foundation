'use client';

import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

interface ProviderView {
  provider: string;
  label: string;
  apiKeyEnvVar: string;
  configured: boolean;
  defaultModel: string;
  defaultBaseUrl: string;
  needsEndpoint: boolean;
  suggestions: { id: string; label: string }[];
}

interface CurrentChoice {
  provider: string;
  model: string | null;
  baseUrl: string | null;
  hasKey: boolean;
  source: 'USER' | 'DEPLOYMENT';
}

// Which model thinks for this trainee.
//
// The model name is a text field, not a list: a relay or a local server serves
// whatever it serves, and the app has no business pretending to know. The
// suggestions below the field are examples, and the endpoint and key are there
// so a 中转站 or a self-hosted gateway works without a code change.
export function ModelSection() {
  const t = useTranslations('settings.model');
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [current, setCurrent] = useState<CurrentChoice | null>(null);
  const [deploymentProvider, setDeploymentProvider] = useState<string | null>(null);
  const [provider, setProvider] = useState('deepseek');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/settings/model');
        if (!res.ok) return;
        const body = (await res.json()) as {
          providers: ProviderView[];
          current: CurrentChoice;
          deployment: { provider: string };
        };
        setProviders(body.providers);
        setCurrent(body.current);
        setDeploymentProvider(body.deployment.provider);
        setProvider(body.current.provider);
        setModel(body.current.model ?? '');
        setBaseUrl(body.current.baseUrl ?? '');
      } catch {
        // The section stays empty; the rest of settings still works.
      }
    })();
  }, []);

  const selected = providers.find((entry) => entry.provider === provider);
  const providerLabel =
    providers.find((entry) => entry.provider === (current?.provider ?? deploymentProvider))?.label ??
    current?.provider ??
    deploymentProvider ??
    '—';

  function pick(next: ProviderView) {
    setProvider(next.provider);
    // Switching provider replaces the model with that provider's example, so
    // the field is never left holding a name the new endpoint cannot serve.
    setModel(next.defaultModel);
    setBaseUrl(next.defaultBaseUrl);
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      const res = await fetch('/api/settings/model', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          model: model.trim() || null,
          baseUrl: baseUrl.trim() || null,
          // Only sent when typed: leaving the field blank keeps the stored key,
          // which is why the API treats an absent field differently from null.
          ...(apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        // Only the codes this screen knows how to explain; anything else (a
        // 500, an auth failure) gets the generic line rather than a missing-key
        // error of its own.
        const known = ['UNKNOWN_PROVIDER', 'MODEL_REQUIRED', 'ENDPOINT_REQUIRED', 'INVALID_ENDPOINT'];
        toast.error(
          known.includes(body.error ?? '')
            ? t(`errors.${body.error}` as 'errors.UNKNOWN')
            : t('errors.UNKNOWN'),
        );
        return;
      }
      const body = (await res.json()) as { current: CurrentChoice };
      setCurrent(body.current);
      setApiKey('');
      toast.success(t('saved'));
    } catch {
      toast.error(t('failed'));
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    if (saving) return;
    setSaving(true);
    try {
      const res = await fetch('/api/settings/model', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: null }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { current: CurrentChoice };
      setCurrent(body.current);
      setProvider(body.current.provider);
      setModel('');
      setBaseUrl('');
      setApiKey('');
      toast.success(t('saved'));
    } catch {
      toast.error(t('failed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="size-4" />
          {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2">
          {providers.map((entry) => (
            <button
              key={entry.provider}
              type="button"
              aria-pressed={entry.provider === provider}
              disabled={saving}
              onClick={() => pick(entry)}
              className={cn(
                'h-10 rounded-md border px-3 text-sm transition-colors',
                entry.provider === provider
                  ? 'border-primary bg-secondary text-secondary-foreground'
                  : 'border-border hover:bg-accent',
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="llm-model" className="text-sm">
            {t('model')}
          </Label>
          <Input
            id="llm-model"
            value={model}
            list="llm-model-suggestions"
            placeholder={
              selected?.suggestions[0]?.id ?? t('modelPlaceholder')
            }
            onChange={(event) => setModel(event.target.value)}
            className="h-11"
          />
          <datalist id="llm-model-suggestions">
            {(selected?.suggestions ?? []).map((suggestion) => (
              <option key={suggestion.id} value={suggestion.id}>
                {suggestion.label}
              </option>
            ))}
          </datalist>
          <p className="text-xs text-muted-foreground">{t('modelHelp')}</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="llm-base-url" className="text-sm">
            {t('baseUrl')}
          </Label>
          <Input
            id="llm-base-url"
            value={baseUrl}
            placeholder={selected?.defaultBaseUrl || 'https://your-relay.example.com/v1'}
            onChange={(event) => setBaseUrl(event.target.value)}
            className="h-11"
          />
          <p className="text-xs text-muted-foreground">
            {selected?.needsEndpoint ? t('baseUrlRequired') : t('baseUrlHelp')}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="llm-api-key" className="text-sm">
            {t('apiKey')}
          </Label>
          <Input
            id="llm-api-key"
            type="password"
            value={apiKey}
            autoComplete="off"
            placeholder={
              current?.hasKey
                ? t('apiKeyStored')
                : selected?.apiKeyEnvVar
                  ? t('apiKeyFromEnv', { variable: selected.apiKeyEnvVar })
                  : t('apiKeyPlaceholder')
            }
            onChange={(event) => setApiKey(event.target.value)}
            className="h-11"
          />
          <p className="text-xs text-muted-foreground">{t('apiKeyHelp')}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            data-testid="llm-save"
            onClick={() => void save()}
            disabled={saving}
          >
            {t('save')}
          </Button>
          {current?.source === 'USER' ? (
            <Button type="button" variant="ghost" onClick={() => void reset()} disabled={saving}>
              {t('reset')}
            </Button>
          ) : null}
          <span className="text-xs text-muted-foreground">
            {current?.source === 'USER'
              ? t('inEffectUser', { provider: providerLabel })
              : t('inEffectDeployment', { provider: providerLabel })}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
