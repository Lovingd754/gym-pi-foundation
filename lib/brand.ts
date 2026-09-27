// Product identity in one place.
//
// 渐进 (Progression) is the name we chose because it carries the whole thesis:
// progressive overload for the body, progressive planning for the plan itself,
// and a product that moves one deliberate step at a time instead of pretending
// to know more than the evidence supports.
//
// The Chinese wordmark is the product's own name and stays the same in every
// locale shown as a wordmark; `nameEn` is what non-Chinese locales read in
// titles and metadata. `slug` is only for machine-readable artifacts (backup
// file names, the web manifest).
export const BRAND = {
  name: '渐进',
  nameEn: 'Progression',
  slug: 'progression',
} as const;

export function brandName(locale: string): string {
  return locale.toLowerCase().startsWith('zh') ? BRAND.name : BRAND.nameEn;
}
