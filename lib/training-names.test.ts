import { describe, expect, it } from 'vitest';
import { getTrainingDisplayName } from '@/i18n/training-names';

describe('getTrainingDisplayName', () => {
  it('keeps stored names unchanged in English and unsupported locales', () => {
    const name = 'Day 2 · Day 1';
    expect(getTrainingDisplayName(name, 'en')).toBe(name);
    expect(getTrainingDisplayName(name, 'de')).toBe(name);
  });

  it('localizes imported day, week and plan names for display', () => {
    expect(getTrainingDisplayName('Day 2 · Day 1', 'zh-CN')).toBe('第 2 天 · 第 1 天');
    expect(getTrainingDisplayName('Day 3 · Week 5 · New plan', 'zh-CN')).toBe(
      '第 3 天 · 第 5 周 · 新计划',
    );
  });

  it('preserves date suffixes and quoted week counts', () => {
    expect(getTrainingDisplayName('New plan · 2 weeks (2026-04-23)', 'zh-CN')).toBe(
      '新计划 · 2 周 (2026-04-23)',
    );
  });

  it('does not partially translate arbitrary user-defined names', () => {
    expect(getTrainingDisplayName('Upper body - Upper body body', 'zh-CN')).toBe(
      'Upper body - Upper body body',
    );
  });

  it('localizes the deterministic personalized plan title and every split day', () => {
    expect(getTrainingDisplayName('Personalized Plan', 'zh-CN')).toBe('个性化方案');
    for (const [stored, localized] of [
      ['Full Body A', '全身 A'],
      ['Full Body B', '全身 B'],
      ['Full Body C', '全身 C'],
      ['Upper A', '上肢 A'],
      ['Upper B', '上肢 B'],
      ['Upper', '上肢'],
      ['Lower A', '下肢 A'],
      ['Lower B', '下肢 B'],
      ['Lower', '下肢'],
      ['Push', '推'],
      ['Pull', '拉'],
      ['Legs', '腿'],
    ] as const) {
      expect(getTrainingDisplayName(stored, 'zh-CN'), stored).toBe(localized);
    }
  });

  it('keeps database identity intact for Chinese: only the display name changes', () => {
    // The stored name is what the database keeps; localization is display-only.
    const stored = 'Personalized Plan · Day 3';
    expect(getTrainingDisplayName(stored, 'zh-CN')).toBe('个性化方案 · 第 3 天');
    expect(getTrainingDisplayName('My own block', 'zh-CN')).toBe('My own block');
  });
});
