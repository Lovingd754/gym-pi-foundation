// Two languages, maintained on purpose: the product is Chinese-first with
// English as the alternative. French and Russian were trimmed rather than
// carried half-translated.
export const locales = ['zh-CN', 'en'] as const;

export type Locale = (typeof locales)[number];

// Chinese is the product's primary language: the audience, the copy, and the
// agent's tool summaries are written for it first. English stays a first-class
// locale the trainee can switch to, and the e2e suite pins itself to English
// so its assertions do not depend on this default.
export const defaultLocale: Locale = 'zh-CN';
export const localeCookieName = 'gympi.locale';
export const localeCookieMaxAge = 60 * 60 * 24 * 365;

export function isLocale(value: string | null | undefined): value is Locale {
  return locales.includes(value as Locale);
}

export const localeLabels: Record<Locale, string> = {
  'zh-CN': '简体中文',
  en: 'English',
};
