import type { Locale } from '@/i18n/config';

interface TrainingNameRules {
  phrases: Readonly<Record<string, string>>;
  day: (number: string) => string;
  week: (number: string) => string;
  weeks: (count: number) => string;
}

// Program and workout identity remains exactly as imported or entered by the
// user. These rules only localize common generated names at display time.
const rulesByLocale: Partial<Record<Locale, TrainingNameRules>> = {
  // The personalized flow stores a deterministic English Program title and
  // English day labels; these rules are display-only and never touch the
  // database identity.
  'zh-CN': {
    phrases: {
      'Personalized Plan': '个性化方案',
      'New plan': '新计划',
      'Full Body Hybrid': '全身混合',
      'Full Body A': '全身 A',
      'Full Body B': '全身 B',
      'Full Body C': '全身 C',
      'Full Body': '全身',
      'Upper A': '上肢 A',
      'Upper B': '上肢 B',
      Upper: '上肢',
      'Lower A': '下肢 A',
      'Lower B': '下肢 B',
      Lower: '下肢',
      Push: '推',
      Pull: '拉',
      Legs: '腿',
    },
    day: (number) => `第 ${number} 天`,
    week: (number) => `第 ${number} 周`,
    weeks: (count) => `${count} 周`,
  },
};

export function getTrainingDisplayName(name: string, locale: string): string {
  const rules = rulesByLocale[locale as Locale];
  if (!rules) return name;

  return name
    .split(/(\s*·\s*)/)
    .map((part) => (part.includes('·') ? part : localizeSegment(part, rules)))
    .join('');
}

function localizeSegment(segment: string, rules: TrainingNameRules): string {
  const leading = segment.match(/^\s*/)?.[0] ?? '';
  const trailing = segment.match(/\s*$/)?.[0] ?? '';
  const value = segment.trim();
  const phrase = Object.entries(rules.phrases).find(
    ([source]) => source.toLocaleLowerCase('en-US') === value.toLocaleLowerCase('en-US'),
  );
  const localized = (phrase?.[1] ?? value)
    .replace(/\bDay\s+(\d+)\b/gi, (_, number: string) => rules.day(number))
    .replace(/\bWeek\s+(\d+)\b/gi, (_, number: string) => rules.week(number))
    .replace(/\b(\d+)\s+weeks?\b/gi, (_, count: string) => rules.weeks(Number(count)));
  return `${leading}${localized}${trailing}`;
}
