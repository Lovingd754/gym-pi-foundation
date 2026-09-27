import { describe, expect, it } from 'vitest';
import { programTemplates } from '@/lib/programs/templates';
import { exerciseNameDictionaries, getExerciseDisplayName } from '@/i18n/exercise-names';
import { STRENGTH_EXERCISE_CATALOG } from '@/lib/fitness/exercise-catalog';
import { EXERCISE_CATALOG } from '@/lib/exercise-catalog';
import zhCN from '@/messages/zh-CN';

describe('exercise name localization', () => {
  it('keeps English and unknown custom names unchanged', () => {
    expect(getExerciseDisplayName('Bench Press', 'en')).toBe('Bench Press');
    expect(getExerciseDisplayName('我自己的动作', 'zh-CN')).toBe('我自己的动作');
  });

  it('matches known names case-insensitively', () => {
    expect(getExerciseDisplayName('bEnCh PrEsS', 'zh-CN')).toBe('卧推');
  });

  it('covers every canonical catalog exercise in Simplified Chinese', () => {
    const missing = STRENGTH_EXERCISE_CATALOG.map((entry) => entry.name).filter(
      (name) => getExerciseDisplayName(name, 'zh-CN') === name,
    );
    expect(missing).toEqual([]);
  });

  // The library the trainee logs from is a different, much larger catalog than
  // the plan generator's. A movement missing from the dictionary shows its
  // English name to a Chinese trainee, which reads as a half-translated app.
  it('covers every movement in the default library in Simplified Chinese', () => {
    const missing = EXERCISE_CATALOG.map((entry) => entry.name).filter(
      (name) => getExerciseDisplayName(name, 'zh-CN') === name,
    );
    expect(missing).toEqual([]);
  });

  // A plan or an import writes an alternate wording ("Military Press") into the
  // trainee's own library, where it is displayed like any other row. The
  // "A · B" wording is what imported files call a movement and is allowed to
  // stay English; the plain ones are not.
  it('covers the alternate wordings a plan or an import can materialize', () => {
    const missing = STRENGTH_EXERCISE_CATALOG.flatMap((entry) => entry.aliases)
      .filter((alias) => !alias.includes('·'))
      .filter((alias) => getExerciseDisplayName(alias, 'zh-CN') === alias);
    expect(missing).toEqual([]);
  });

  it('keeps the Chinese dictionary aligned with the fitness message table', () => {
    const dictionary = exerciseNameDictionaries['zh-CN']!;
    for (const entry of STRENGTH_EXERCISE_CATALOG) {
      expect(dictionary[entry.name], entry.name).toBe(zhCN.fitness.exerciseNames[entry.key]);
    }
  });

  it('covers every exercise used by built-in program templates in Chinese', () => {
    const names = new Set(
      programTemplates.flatMap((template) =>
        template.program.workouts.flatMap((workout) =>
          workout.exercises.map((exercise) => exercise.name),
        ),
      ),
    );
    for (const locale of ['zh-CN', 'en'] as const) {
      const missing = [...names].filter(
        (name) => locale === 'zh-CN' && getExerciseDisplayName(name, locale) === name,
      );
      expect(missing, locale).toEqual([]);
    }
  });
});
