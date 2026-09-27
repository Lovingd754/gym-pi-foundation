import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { isLocale, locales } from '@/i18n/config';
import englishMessages from '@/messages/en';
import chineseMessages from '@/messages/zh-CN';

function messageKeys(value: unknown, prefix = ''): string[] {
  if (typeof value === 'string') return [prefix];
  if (!value || typeof value !== 'object') return [];

  return Object.entries(value).flatMap(([key, child]) =>
    messageKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe('i18n configuration', () => {
  it('recognizes only supported locales', () => {
    expect(locales).toEqual(['zh-CN', 'en']);
    expect(isLocale('en')).toBe(true);
    expect(isLocale('zh-CN')).toBe(true);
    expect(isLocale('fr')).toBe(false);
    expect(isLocale('ru')).toBe(false);
    expect(isLocale('de')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });

  it('keeps every locale dictionary structurally complete', () => {
    expect(messageKeys(chineseMessages).sort()).toEqual(messageKeys(englishMessages).sort());
  });

  it('uses the Chinese copy the product is written in', () => {
    const t = createTranslator({ locale: 'zh-CN', messages: chineseMessages });

    expect(t('navigation.chat')).toBe('对话');
    expect(t('settings.title')).toBe('设置');
    expect(t('common.actions.save')).toBe('保存');
  });
});
