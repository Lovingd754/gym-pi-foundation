import { STRENGTH_EXERCISE_CATALOG, type StrengthCatalogExercise } from './exercise-catalog';
import { parseFitnessPlanContent, type FitnessPlanContent } from './plan-schema';

// ============================================================
// Plan changes
// ============================================================
// The agent decides *what* should change ("this movement is the problem",
// "move Wednesday"). These rules decide whether that change is allowed and
// what the numbers become afterwards. Three properties hold for every change:
//
//   - The plan is never edited in place. A change produces new content that is
//     re-parsed, and the caller turns it into a new plan version.
//   - The schedule is recomputed from the strength days and cardio sessions,
//     never hand-patched, so the derived fields cannot drift out of sync.
//   - Anything the rules cannot justify is refused with a stable code the
//     agent can explain, rather than a plan that quietly got worse.

export type PlanChange =
  | { kind: 'SWAP_EXERCISE'; from: string; to?: string }
  | { kind: 'MOVE_TRAINING_DAY'; from: number; to: number }
  | { kind: 'SET_CARDIO_MINUTES'; minutes: number };

export type PlanChangeCode =
  | 'UNSUPPORTED_CHANGE'
  | 'EXERCISE_NOT_IN_PLAN'
  | 'NO_SUITABLE_SUBSTITUTE'
  | 'SUBSTITUTE_NOT_SUITABLE'
  | 'DAY_NOT_A_TRAINING_DAY'
  | 'DAY_ALREADY_TRAINING'
  | 'DAY_NOT_AVAILABLE'
  | 'CARDIO_OUT_OF_RANGE'
  | 'PLAN_INVALID_AFTER_CHANGE';

export class PlanChangeError extends Error {
  constructor(
    readonly code: PlanChangeCode,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = 'PlanChangeError';
  }
}

// What the trainee's own profile and gym allow. The rules need this to keep a
// change inside the equipment they actually have.
export interface PlanChangeConstraints {
  availableWeekdays: readonly number[];
  equipmentTypes: readonly string[];
  unavailableExerciseNames: readonly string[];
}

export type PlanChangeDiffRow =
  | { kind: 'exercise'; dayOfWeek: number; dayName: string; before: string; after: string }
  | { kind: 'trainingDay'; before: number; after: number }
  | { kind: 'cardio'; before: number; after: number; days: number[] };

export interface PlanChangeResult {
  content: FitnessPlanContent;
  diff: PlanChangeDiffRow[];
  // The catalog key the rules picked, when the model left the choice to them.
  resolvedExercise?: { catalogKey: string; name: string };
}

export const MAX_CARDIO_MINUTES = 300;

export function applyPlanChange(
  content: FitnessPlanContent,
  change: PlanChange,
  constraints: PlanChangeConstraints,
): PlanChangeResult {
  switch (change.kind) {
    case 'SWAP_EXERCISE':
      return swapExercise(content, change, constraints);
    case 'MOVE_TRAINING_DAY':
      return moveTrainingDay(content, change, constraints);
    case 'SET_CARDIO_MINUTES':
      return setCardioMinutes(content, change);
  }
}

function swapExercise(
  content: FitnessPlanContent,
  change: Extract<PlanChange, { kind: 'SWAP_EXERCISE' }>,
  constraints: PlanChangeConstraints,
): PlanChangeResult {
  const target = findExercise(content, change.from);
  if (!target) throw new PlanChangeError('EXERCISE_NOT_IN_PLAN', { from: change.from });

  const day = content.strength.days[target.dayIndex];
  if (!day) throw new PlanChangeError('EXERCISE_NOT_IN_PLAN', { from: change.from });
  const existing = day.exercises[target.exerciseIndex];
  if (!existing) throw new PlanChangeError('EXERCISE_NOT_IN_PLAN', { from: change.from });

  const currentCatalog = catalogEntryFor(existing.name, existing.notes);
  const replacement = change.to
    ? resolveRequested(content, day.exercises, change.to, constraints)
    : chooseSubstitute(content, day.exercises, currentCatalog, constraints);

  const exercises = [...day.exercises];
  exercises[target.exerciseIndex] = {
    ...existing,
    name: replacement.name,
    muscleGroup: replacement.muscleGroup,
    category: replacement.category,
    equipmentType: replacement.equipmentType,
    usesBodyweight: replacement.usesBodyweight,
    // The movement changes; the prescription (sets, reps, effort) stays. Those
    // numbers belong to the rules, and re-deriving them is the plan
    // generator's job, not a swap's.
    restSec: replacement.defaultRestSec,
    // Downstream code keys catalog exercises off this note.
    notes: `catalog:${replacement.key}`,
  };

  const strength = {
    ...content.strength,
    days: content.strength.days.map((day_, index) =>
      index === target.dayIndex ? { ...day_, exercises } : day_,
    ),
  };

  const next = revalidate({ ...content, strength });
  return {
    content: next,
    diff: [
      {
        kind: 'exercise',
        dayOfWeek: day.dayOfWeek ?? 0,
        dayName: day.name,
        before: existing.name,
        after: replacement.name,
      },
    ],
    resolvedExercise: { catalogKey: replacement.key, name: replacement.name },
  };
}

function moveTrainingDay(
  content: FitnessPlanContent,
  change: Extract<PlanChange, { kind: 'MOVE_TRAINING_DAY' }>,
  constraints: PlanChangeConstraints,
): PlanChangeResult {
  const index = content.strength.days.findIndex((day) => day.dayOfWeek === change.from);
  if (index === -1) throw new PlanChangeError('DAY_NOT_A_TRAINING_DAY', { from: change.from });
  if (!constraints.availableWeekdays.includes(change.to)) {
    throw new PlanChangeError('DAY_NOT_AVAILABLE', { to: change.to });
  }
  if (content.strength.days.some((day) => day.dayOfWeek === change.to)) {
    throw new PlanChangeError('DAY_ALREADY_TRAINING', { to: change.to });
  }

  const strength = {
    ...content.strength,
    days: content.strength.days.map((day, dayIndex) =>
      dayIndex === index ? { ...day, dayOfWeek: change.to } : day,
    ),
  };

  const next = revalidate(withRecomputedSchedule({ ...content, strength }));
  return {
    content: next,
    diff: [{ kind: 'trainingDay', before: change.from, after: change.to }],
  };
}

function setCardioMinutes(
  content: FitnessPlanContent,
  change: Extract<PlanChange, { kind: 'SET_CARDIO_MINUTES' }>,
): PlanChangeResult {
  const minutes = Math.round(change.minutes);
  if (minutes < 0 || minutes > MAX_CARDIO_MINUTES || !Number.isFinite(minutes)) {
    throw new PlanChangeError('CARDIO_OUT_OF_RANGE', { minutes: change.minutes });
  }

  // Keep the days the trainee already does cardio on; fall back to the rest
  // days so a plan that had none can gain some.
  const existingDays = [...new Set(content.cardio.sessions.map((session) => session.dayOfWeek))];
  const strengthDays = new Set(content.strength.days.map((day) => day.dayOfWeek));
  const restDays = [1, 2, 3, 4, 5, 6, 7].filter((day) => !strengthDays.has(day));
  const dayPool = existingDays.length > 0 ? existingDays : restDays;

  const sessions =
    minutes === 0
      ? []
      : allocate(minutes, Math.min(3, Math.max(1, dayPool.length))).map((durationMin, index) => ({
          dayOfWeek: dayPool[index] ?? dayPool[0] ?? 1,
          durationMin,
          mode: 'LOW_IMPACT' as const,
          intensity: 'MODERATE' as const,
          rpeMin: 3 as const,
          rpeMax: 5 as const,
        }));

  const cardio = {
    additionalWeeklyMin: sessions.reduce((total, session) => total + session.durationMin, 0),
    sessions,
  };

  const next = revalidate(withRecomputedSchedule({ ...content, cardio }));
  return {
    content: next,
    diff: [
      {
        kind: 'cardio',
        before: content.cardio.additionalWeeklyMin,
        after: cardio.additionalWeeklyMin,
        days: sessions.map((session) => session.dayOfWeek),
      },
    ],
  };
}

// The schedule is derived, so it is rebuilt rather than patched. Everything
// downstream (today's workout, the managed program) reads it.
function withRecomputedSchedule(content: FitnessPlanContent): FitnessPlanContent {
  const strengthByDay = new Map<number, number>();
  content.strength.days.forEach((day, index) => {
    if (day.dayOfWeek !== null && day.dayOfWeek !== undefined) {
      strengthByDay.set(day.dayOfWeek, index);
    }
  });

  const cardioByDay = new Map<number, number>();
  for (const session of content.cardio.sessions) {
    cardioByDay.set(
      session.dayOfWeek,
      (cardioByDay.get(session.dayOfWeek) ?? 0) + session.durationMin,
    );
  }

  const days = [1, 2, 3, 4, 5, 6, 7].map((dayOfWeek) => {
    const strengthDayIndex = strengthByDay.get(dayOfWeek) ?? null;
    const cardioMin = cardioByDay.get(dayOfWeek) ?? 0;
    const kind =
      strengthDayIndex !== null
        ? cardioMin > 0
          ? ('STRENGTH_AND_CARDIO' as const)
          : ('STRENGTH' as const)
        : cardioMin > 0
          ? ('CARDIO' as const)
          : ('REST' as const);
    return { dayOfWeek, kind, strengthDayIndex, cardioMin };
  });

  return { ...content, schedule: { days } };
}

// The schema is the last word: a change that breaks an invariant (a weekday
// collision, cardio minutes that no longer add up) is refused here rather than
// stored and discovered later.
function revalidate(content: FitnessPlanContent): FitnessPlanContent {
  try {
    return parseFitnessPlanContent(content);
  } catch {
    throw new PlanChangeError('PLAN_INVALID_AFTER_CHANGE');
  }
}

function findExercise(
  content: FitnessPlanContent,
  name: string,
): { dayIndex: number; exerciseIndex: number } | null {
  const wanted = name.trim().toLowerCase();
  for (let dayIndex = 0; dayIndex < content.strength.days.length; dayIndex += 1) {
    const day = content.strength.days[dayIndex];
    if (!day) continue;
    for (let exerciseIndex = 0; exerciseIndex < day.exercises.length; exerciseIndex += 1) {
      const exercise = day.exercises[exerciseIndex];
      if (!exercise) continue;
      const catalog = catalogEntryFor(exercise.name, exercise.notes);
      const candidates = [exercise.name, catalog?.name, ...(catalog?.aliases ?? [])];
      if (
        candidates.some((candidate) => candidate?.trim().toLowerCase() === wanted)
      ) {
        return { dayIndex, exerciseIndex };
      }
    }
  }
  return null;
}

function catalogEntryFor(
  name: string,
  notes: string | null | undefined,
): StrengthCatalogExercise | undefined {
  const key = notes?.startsWith('catalog:') ? notes.slice('catalog:'.length) : null;
  if (key) {
    const byKey = STRENGTH_EXERCISE_CATALOG.find((entry) => entry.key === key);
    if (byKey) return byKey;
  }
  const wanted = name.trim().toLowerCase();
  return STRENGTH_EXERCISE_CATALOG.find((entry) =>
    [entry.name, ...entry.aliases].some((candidate) => candidate.trim().toLowerCase() === wanted),
  );
}

function equipmentAllowed(
  entry: StrengthCatalogExercise,
  constraints: PlanChangeConstraints,
): boolean {
  return (
    constraints.equipmentTypes.includes(entry.equipmentType) &&
    !constraints.unavailableExerciseNames.some(
      (name) => name.trim().toLowerCase() === entry.name.trim().toLowerCase(),
    )
  );
}

function chooseSubstitute(
  content: FitnessPlanContent,
  dayExercises: FitnessPlanContent['strength']['days'][number]['exercises'],
  current: StrengthCatalogExercise | undefined,
  constraints: PlanChangeConstraints,
): StrengthCatalogExercise {
  const used = new Set(
    dayExercises.map((exercise) => catalogEntryFor(exercise.name, exercise.notes)?.key ?? exercise.name),
  );
  const pattern = current?.movementPattern;

  const candidates = STRENGTH_EXERCISE_CATALOG.filter((entry) => {
    if (!equipmentAllowed(entry, constraints)) return false;
    if (used.has(entry.key)) return false;
    if (pattern) return entry.movementPattern === pattern;
    if (current) return entry.muscleGroup === current.muscleGroup;
    // Unknown movement: keep it in the same muscle group as whatever the plan
    // put there, which is the safest available signal.
    return true;
  }).sort((left, right) => left.priority - right.priority || left.name.localeCompare(right.name));

  const substitute = candidates[0];
  if (!substitute) {
    throw new PlanChangeError('NO_SUITABLE_SUBSTITUTE', { from: current?.name ?? '' });
  }
  return substitute;
}

function resolveRequested(
  content: FitnessPlanContent,
  dayExercises: FitnessPlanContent['strength']['days'][number]['exercises'],
  requested: string,
  constraints: PlanChangeConstraints,
): StrengthCatalogExercise {
  const wanted = requested.trim().toLowerCase();
  const entry = STRENGTH_EXERCISE_CATALOG.find((candidate) =>
    [candidate.name, ...candidate.aliases].some((name) => name.trim().toLowerCase() === wanted),
  );
  if (!entry) throw new PlanChangeError('SUBSTITUTE_NOT_SUITABLE', { to: requested });
  if (!equipmentAllowed(entry, constraints)) {
    throw new PlanChangeError('SUBSTITUTE_NOT_SUITABLE', { to: requested });
  }
  const used = dayExercises.some(
    (exercise) => catalogEntryFor(exercise.name, exercise.notes)?.key === entry.key,
  );
  if (used) throw new PlanChangeError('SUBSTITUTE_NOT_SUITABLE', { to: requested });
  return entry;
}

// Splits `total` into `count` whole minutes that add back up to `total`, as
// evenly as possible with the remainder on the first sessions.
export function allocate(total: number, count: number): number[] {
  if (count <= 0) return [];
  const base = Math.floor(total / count);
  const remainder = total - base * count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}
