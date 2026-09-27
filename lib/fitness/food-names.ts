// The languages the meal copy is written in. Kept separate so the food tables
// do not import anything from the UI layer.
export type Lang = 'zh' | 'en';

export function langFromLocale(locale: string): Lang {
  return locale.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}
