import { defaultLocale, isLocale } from '@/i18n/config';
import { muscleGroupMessageKeys } from '@/i18n/enum-keys';
import { getExerciseDisplayName } from '@/i18n/exercise-names';
import { loadMessages } from '@/i18n/messages';

// ============================================================
// Vocabulary for tool summaries
// ============================================================
// Tool output is prose the model paraphrases back to the trainee, so it has to
// read in the trainee's language and avoid raw enum values. Everything here is
// display-only and reuses the existing message catalog and exercise dictionary
// rather than introducing a second vocabulary that could drift.

type Bag = Record<string, unknown>;

function readPath(root: unknown, path: string): string | undefined {
  let node: unknown = root;
  for (const segment of path.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Bag)[segment];
  }
  return typeof node === 'string' ? node : undefined;
}

export interface ToolLabels {
  readonly locale: string;
  text(path: string, fallback: string): string;
  exercise(name: string): string;
  muscleGroup(group: string): string;
  weekday(isoWeekday: number): string;
  goalType(type: string): string;
  split(key: string): string;
  workoutDay(name: string): string;
  planStatus(status: string): string;
}

export async function loadToolLabels(locale: string): Promise<ToolLabels> {
  const safeLocale = isLocale(locale) ? locale : defaultLocale;
  const messages = (await loadMessages(safeLocale)) as unknown as Bag;

  const text = (path: string, fallback: string): string => readPath(messages, path) ?? fallback;

  return {
    locale: safeLocale,
    text,
    exercise: (name) => getExerciseDisplayName(name, safeLocale),
    muscleGroup: (group) => {
      const key = (muscleGroupMessageKeys as Record<string, string>)[group];
      if (!key) return group;
      return text(`exercises.muscleGroups.${key}`, group);
    },
    weekday: (isoWeekday) => text(`fitness.assessment.weekdays.${isoWeekday}`, String(isoWeekday)),
    goalType: (type) => text(`fitness.assessment.goalTypes.${type}`, type),
    split: (key) => text(`fitness.plan.splits.${key}`, key),
    workoutDay: (name) => text(`fitness.plan.days.${name}`, name),
    planStatus: (status) => text(`fitness.plan.statuses.${status}`, status),
  };
}

// The catalog stores day names in English and the message catalog localizes
// the ones the generator can emit. Any other name (an imported program, a
// legacy workout) is the trainee's own text and is passed through unchanged.
export function localizeWorkoutDay(labels: ToolLabels, name: string): string {
  return labels.workoutDay(name);
}
