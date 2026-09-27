// Extends Vitest's `expect` with @testing-library/jest-dom matchers
// (toBeInTheDocument, toHaveTextContent, ...) for component tests.
import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';
import englishMessages from './messages/en';

// jsdom has no ResizeObserver, and Radix primitives (Switch, Select) mount one
// on layout. A no-op observer keeps those components renderable in tests.
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

// Component tests render isolated client components without app/layout.tsx.
// Provide the same English translator/formatter that the root provider would
// expose so existing assertions remain focused on component behaviour.
vi.mock('next-intl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next-intl')>();
  const translator = actual.createTranslator({ locale: 'en', messages: englishMessages });
  const translate = translator as unknown as {
    (key: string, values?: Record<string, unknown>): string;
    rich: (key: string, values?: Record<string, unknown>) => React.ReactNode;
    raw: (key: string) => unknown;
    has: (key: string) => boolean;
  };
  const formatter = actual.createFormatter({ locale: 'en', timeZone: 'UTC' });

  return {
    ...actual,
    useLocale: () => 'en',
    useFormatter: () => formatter,
    useTranslations: (namespace?: string) => {
      const keyFor = (key: string) => (namespace ? `${namespace}.${key}` : key);
      const scoped = (key: string, values?: Record<string, unknown>) =>
        translate(keyFor(key), values);
      scoped.rich = (key: string, values?: Record<string, unknown>) =>
        translate.rich(keyFor(key), values);
      scoped.raw = (key: string) => translate.raw(keyFor(key));
      scoped.has = (key: string) => translate.has(keyFor(key));
      return scoped;
    },
  };
});
