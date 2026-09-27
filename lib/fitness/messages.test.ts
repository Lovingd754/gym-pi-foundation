import { describe, expect, it } from 'vitest';

import en from '@/messages/en';
import zhCN from '@/messages/zh-CN';
import { locales, localeLabels } from '@/i18n/config';
import { exerciseNameDictionaries, getExerciseDisplayName } from '@/i18n/exercise-names';
import { getTrainingDisplayName } from '@/i18n/training-names';

import { STRENGTH_EXERCISE_CATALOG } from './exercise-catalog';
import {
  clearanceSignalValues,
  eligibilityReasonCodeValues,
  eligibilityStatusValues,
  scopeSignalValues,
  temporarySignalValues,
  urgentSignalValues,
} from './schemas';

// Flattens a message object into dotted paths so two locales can be compared by
// key set, mirroring how the runtime resolves them.
function flatten(value: unknown, prefix = ''): string[] {
  if (typeof value === 'string') return [prefix];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flatten(child, prefix ? `${prefix}.${key}` : key),
  );
}

function stringsOf(value: unknown, prefix = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[prefix, value]];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    stringsOf(child, prefix ? `${prefix}.${key}` : key),
  );
}

const englishKeys = flatten(en.fitness);
const chineseKeys = flatten(zhCN.fitness);

describe('fitness locale parity', () => {
  it.each([['Simplified Chinese', zhCN]])('%s exposes exactly the English key set', (_label, messages) => {
    expect(flatten(messages).sort()).toEqual(flatten(en).sort());
  });

  it('defines the same fitness keys in English and Chinese', () => {
    expect(chineseKeys.sort()).toEqual(englishKeys.sort());
  });

  it('never ships an empty fitness string', () => {
    for (const [key, value] of [...stringsOf(en.fitness), ...stringsOf(zhCN.fitness)]) {
      expect(value.trim(), key).not.toBe('');
    }
  });

  it('covers every eligibility status with a title and a next action', () => {
    for (const status of eligibilityStatusValues) {
      for (const locale of [en.fitness, zhCN.fitness]) {
        const entry = locale.eligibility.statuses[status];
        expect(entry.title.trim()).not.toBe('');
        expect(entry.action.trim()).not.toBe('');
      }
    }
  });

  it('covers every reason code with an English and Chinese title and body', () => {
    const missing: string[] = [];
    for (const code of eligibilityReasonCodeValues) {
      for (const [label, locale] of [
        ['en', en.fitness],
        ['zh-CN', zhCN.fitness],
      ] as const) {
        const entry = (locale.reasons as Record<string, { title: string; body: string }>)[code];
        if (!entry?.title?.trim() || !entry?.body?.trim()) missing.push(`${label}:${code}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('covers every health question with English and Chinese copy', () => {
    const groups = [
      ['urgent', urgentSignalValues],
      ['clearance', clearanceSignalValues],
      ['temporary', temporarySignalValues],
      ['scope', scopeSignalValues],
    ] as const;
    for (const [group, values] of groups) {
      for (const value of values) {
        const enCopy = (en.fitness.assessment.health[group] as Record<string, string>)[value];
        const zhCopy = (zhCN.fitness.assessment.health[group] as Record<string, string>)[value];
        expect(enCopy?.trim(), `en ${group} ${value}`).toBeTruthy();
        expect(zhCopy?.trim(), `zh-CN ${group} ${value}`).toBeTruthy();
      }
    }
  });

  it('covers every comparison metric, feasibility state and load source', () => {
    const metricKeys = Object.keys(en.fitness.plan.metrics);
    expect(metricKeys).toEqual([
      'STRENGTH_FREQUENCY',
      'STRENGTH_SPLIT',
      'TRAINING_DAYS',
      'WEEKLY_TARGET_SETS',
      'EXERCISE_SELECTION',
      'CALORIES',
      'PROTEIN',
      'CARDIO_MINUTES',
      'SLEEP_TARGET',
    ]);
    for (const key of metricKeys) {
      expect(zhCN.fitness.plan.metrics[key as keyof typeof zhCN.fitness.plan.metrics]).toBeTruthy();
    }
    for (const [locale, messages] of [
      ['en', en.fitness],
      ['zh-CN', zhCN.fitness],
    ] as const) {
      for (const state of [
        'WITHIN_RANGE',
        'EARLIER_THAN_SUPPORTED',
        'LATER_THAN_ESTIMATE',
        'MILESTONE',
        'NOT_REQUESTED',
      ]) {
        expect(
          (messages.plan.feasibility as Record<string, string>)[state],
          `${locale} ${state}`,
        ).toBeTruthy();
      }
      for (const source of ['APP_HISTORY', 'USER_REPORTED', 'CALIBRATION']) {
        expect(
          (messages.assessment.loadSource as Record<string, string>)[source],
          `${locale} ${source}`,
        ).toBeTruthy();
      }
    }
  });

  it('uses the exact Chinese confirmation label', () => {
    expect(zhCN.fitness.actions.confirm).toBe('使用这份方案');
  });

  it('states that the guidance is not medical diagnosis or treatment', () => {
    expect(zhCN.fitness.disclaimer).toContain('不构成医学诊断或治疗');
    expect(en.fitness.disclaimer).toContain('not medical diagnosis or treatment');
  });

  it('registers zh-CN with a dynamic loader and a selector label', () => {
    expect(locales).toContain('zh-CN');
    expect(localeLabels['zh-CN']).toBe('简体中文');
    expect(zhCN.common.language.chinese).toBe('简体中文');
    expect(zhCN.navigation.home).toBe('首页');
    expect(zhCN.dashboard.resumeSession).toBe('继续训练');
    expect(zhCN.common.actions.save).toBe('保存');
    expect(zhCN.session.startThis).toBe('开始这次训练');
    expect(zhCN.session.exerciseCard.suggestion).toBe('建议重量：');
  });

  it('translates every namespace rather than falling back to English', () => {
    // A namespace that still shares the English object renders English on a
    // Chinese screen. That is exactly the half-translated bug this guards
    // against, and it is invisible to a key-parity check.
    const stillEnglish = Object.keys(en).filter(
      (key) =>
        (zhCN as Record<string, unknown>)[key] === (en as Record<string, unknown>)[key],
    );
    expect(stillEnglish).toEqual([]);

    expect(zhCN.auth.login.title).toBe('登录');
    expect(zhCN.coach.title).toBe('教练');
    expect(zhCN.exercises.title).toBe('动作库');
    expect(zhCN.history.title).toBe('历史');
    expect(zhCN.programs.title).toBe('训练计划');
    expect(zhCN.progress.title).toBe('进度');
    expect(zhCN.settings.title).toBe('设置');
    // Muscle groups feed both the catalog and the agent's plan summary.
    expect(zhCN.exercises.muscleGroups.quads).toBe('股四头肌');
  });
});

describe('fitness exercise and training name localization', () => {
  it('gives every canonical catalog exercise an English and Chinese name', () => {
    for (const entry of STRENGTH_EXERCISE_CATALOG) {
      const enName = en.fitness.exerciseNames[entry.key];
      const zhName = zhCN.fitness.exerciseNames[entry.key];
      expect(enName, `en ${entry.key}`).toBe(entry.name);
      expect(zhName?.trim(), `zh-CN ${entry.key}`).toBeTruthy();
    }
  });

  it('keeps the exercise dictionary and the Chinese message table in lockstep', () => {
    const dictionary = exerciseNameDictionaries['zh-CN']!;
    for (const entry of STRENGTH_EXERCISE_CATALOG) {
      expect(dictionary[entry.name], entry.name).toBe(zhCN.fitness.exerciseNames[entry.key]);
    }
  });

  it('resolves every canonical catalog name to Chinese for Program and Session screens', () => {
    const unresolved = STRENGTH_EXERCISE_CATALOG.map((entry) => entry.name).filter(
      (name) => getExerciseDisplayName(name, 'zh-CN') === name,
    );
    expect(unresolved).toEqual([]);
  });

  it('resolves every generated plan and workout name to Chinese', () => {
    const names = [en.fitness.plan.programTitle, ...Object.keys(en.fitness.plan.days)];
    const unresolved = names.filter((name) => getTrainingDisplayName(name, 'zh-CN') === name);
    expect(unresolved).toEqual([]);
    expect(getTrainingDisplayName('Personalized Plan', 'zh-CN')).toBe('个性化方案');
    expect(getTrainingDisplayName('Full Body A', 'zh-CN')).toBe('全身 A');
    expect(getTrainingDisplayName('Legs', 'zh-CN')).toBe('腿');
    expect(getTrainingDisplayName('Day 2 · Week 3', 'zh-CN')).toBe('第 2 天 · 第 3 周');
  });
});
