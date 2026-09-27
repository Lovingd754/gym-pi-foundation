import { buildBaselinePlan } from './baseline-plan';
import { applyPlanChange } from './plan-change';
import { PACE_ORDER, paceToRate, rateToPace, type GoalPace } from './pace';
import type { FitnessPlanContent } from './plan-schema';
import type { PlanStrategy } from './plan-strategy';
import type { EligibilityDecision } from './eligibility';
import type { InitialLoadGuidance } from './load-evidence';
import type { AssessmentInput } from './schemas';

// ============================================================
// The weekly review
// ============================================================
// A plan is a guess about the next seven days, and the seven days that just
// happened are the evidence that says how good the guess was. This module turns
// that evidence into the next version of the plan: the same rules that built
// the first one, run again with what actually happened.
//
// Three properties, matching the rest of the planning code:
//
//   - Pure. Everything arrives in `input`; nothing here reads a clock, a
//     database, a locale or a model.
//   - Conservative. A week is a small sample, so the review never changes more
//     than one step per lever, and it changes nothing when the week went to
//     plan. A trainee who did everything asked gets their plan back unchanged,
//     which is the honest answer and keeps the version history readable.
//   - Explainable. Every change comes with a stable code the interface renders
//     as a sentence, so "why did my calories change" has an answer that is not
//     "the app decided".
//
// What it deliberately does NOT do: touch sets, reps or effort targets. Those
// are the per-session autoregulation's job, and rewriting them weekly on the
// strength of one week would trade a real signal for noise.

export type WeeklyAdjustmentCode =
  | 'PACE_FASTER'
  | 'PACE_SLOWER'
  | 'RECALCULATED'
  | 'TRAINING_DAYS_REDUCED'
  | 'TRAINING_DAYS_MOVED'
  | 'CARDIO_REDUCED'
  | 'CARDIO_INCREASED'
  | 'LOADS_REFRESHED'
  | 'LOADS_UNCHANGED'
  | 'ON_TRACK'
  | 'NO_EVIDENCE'
  | 'NO_WEIGHT_DATA';

export type WeeklyAdjustment =
  | {
      kind: 'CALORIES';
      code: 'PACE_FASTER' | 'PACE_SLOWER' | 'RECALCULATED';
      before: NumericRange;
      after: NumericRange;
    }
  | {
      kind: 'TRAINING_DAYS';
      code: 'TRAINING_DAYS_REDUCED' | 'TRAINING_DAYS_MOVED';
      before: number[];
      after: number[];
    }
  | { kind: 'CARDIO'; code: 'CARDIO_REDUCED' | 'CARDIO_INCREASED'; before: number; after: number }
  | { kind: 'LOADS'; code: 'LOADS_REFRESHED' | 'LOADS_UNCHANGED'; refreshed: number }
  | { kind: 'KEEP'; code: 'ON_TRACK' | 'NO_EVIDENCE' | 'NO_WEIGHT_DATA' };

export interface NumericRange {
  min: number;
  max: number;
}

// One week, as the logs describe it. Dates are the trainee's local calendar
// dates; the window is [windowStart, windowEnd).
export interface WeekEvidence {
  windowStart: string;
  windowEnd: string;
  plannedSessions: number;
  completedSessions: number;
  // Weekdays (1 = Monday) with at least one finished session, and the planned
  // training weekdays that had none.
  trainedWeekdays: number[];
  missedWeekdays: number[];
  cardioPlannedMin: number;
  cardioCompletedMin: number;
  weightStartKg: number | null;
  weightEndKg: number | null;
  waistStartCm: number | null;
  waistEndCm: number | null;
}

export interface WeeklyReviewInput {
  previousContent: FitnessPlanContent;
  // The assessment the previous plan was built from. It is the base the review
  // adjusts - the trainee's own answers are never rewritten, only the
  // prescription that follows from them.
  previousAssessment: AssessmentInput;
  eligibility: EligibilityDecision;
  gymConstraints: { unavailableExerciseNames: string[] };
  // Starting loads refreshed from what was actually lifted (see
  // lib/fitness/load-evidence.ts).
  loadGuidance: InitialLoadGuidance[];
  strategy?: PlanStrategy;
  evidence: WeekEvidence;
  now: Date;
}

export interface WeeklyReviewResult {
  content: FitnessPlanContent;
  // The assessment the new content was built from, so the caller can store it
  // alongside the plan and show the plain-language energy summary.
  assessment: AssessmentInput;
  adjustments: WeeklyAdjustment[];
  // True when nothing the trainee can see moved: no calorie target, no training
  // day, no cardio minute. The caller should not create a new version for an
  // unchanged week - a plan that regenerates itself every Monday for no reason
  // is noise, and it buries the weeks that did change.
  unchanged: boolean;
}

// A week with no sessions, no cardio and no weigh-in is not evidence of
// anything - it may be a holiday, a flu, or simply not using the app. The
// review says so and leaves the plan alone rather than "adapting" to a blank.
export function hasWeekEvidence(evidence: WeekEvidence): boolean {
  return (
    evidence.completedSessions > 0 ||
    evidence.cardioCompletedMin > 0 ||
    weightChanged(evidence) !== null
  );
}

export function reviewWeek(input: WeeklyReviewInput): WeeklyReviewResult {
  const { evidence } = input;
  if (!hasWeekEvidence(evidence)) {
    return {
      content: input.previousContent,
      assessment: input.previousAssessment,
      adjustments: [{ kind: 'KEEP', code: 'NO_EVIDENCE' }],
      unchanged: true,
    };
  }

  const adjustments: WeeklyAdjustment[] = [];

  // A week with no training logged at all says something about the body (if
  // there was a weigh-in) but nothing about which days work or how much cardio
  // fits: restructuring the plan on that would be guessing. Only a week where
  // the trainee actually showed up can move the schedule.
  const engaged = evidence.completedSessions > 0 || evidence.cardioCompletedMin > 0;

  // 1. Where the week went: the days they actually trained are the days the next
  //    plan uses.
  const weekdays = engaged ? reviewTrainingDays(input, adjustments) : unchangedTrainingDays(input);

  // 2. Whether the body did what the goal asked for. This is the lever that has
  //    to move weekly - a calorie target that never changes is a guess that is
  //    never corrected.
  const decision = reviewRate(input, adjustments);

  const assessment: AssessmentInput = {
    ...input.previousAssessment,
    profile: {
      ...input.previousAssessment.profile,
      // The body moved; the calorie and protein maths has to start from what it
      // is now, not from what it was when the plan was written.
      ...(evidence.weightEndKg === null ? {} : { weightKg: evidence.weightEndKg }),
      ...(evidence.waistEndCm === null ? {} : { waistCm: evidence.waistEndCm }),
    },
    goal: { ...input.previousAssessment.goal, desiredWeeklyRatePct: decision.rate },
    schedule: {
      ...input.previousAssessment.schedule,
      // The generator only knows four frequencies (2, 3, 4 or 5 days); the
      // weekday list decides which one it is.
      weeklyFrequency: weekdays.length as 2 | 3 | 4 | 5,
      availableWeekdays: weekdays,
    },
  };

  let content = buildBaselinePlan({
    assessment,
    eligibility: input.eligibility,
    gymConstraints: input.gymConstraints,
    loadGuidance: input.loadGuidance,
    now: input.now,
    ...(input.strategy ? { strategy: input.strategy } : {}),
  });

  const before = input.previousContent.nutrition.caloriesKcal;
  const after = content.nutrition.caloriesKcal;
  const caloriesMoved = JSON.stringify(before) !== JSON.stringify(after);
  // Calories move for two reasons: the pace was stepped up or down, or the
  // trainee's bodyweight changed enough to move the same prescription. Both are
  // worth a line, and neither is worth a line when the number came out the same.
  if (caloriesMoved) {
    adjustments.push({
      kind: 'CALORIES',
      code: decision.code ?? 'RECALCULATED',
      before,
      after,
    });
  }

  // 3. Cardio: what was prescribed against what was done.
  content = engaged ? reviewCardio(content, input, adjustments, { caloriesMoved }) : content;

  // 4. Starting loads: only meaningful while the plan is young, but refreshing
  //    them costs nothing and keeps the "start here" number honest.
  adjustments.push(describeLoadRefresh(input));

  const moved = adjustments.some(
    (adjustment) => adjustment.kind !== 'LOADS' && adjustment.kind !== 'KEEP',
  );
  if (!moved) {
    adjustments.push({ kind: 'KEEP', code: 'ON_TRACK' });
  }

  return {
    content,
    assessment,
    adjustments,
    unchanged: !moved,
  };
}

// ---------------------------------------------------------- training days

function reviewTrainingDays(input: WeeklyReviewInput, adjustments: WeeklyAdjustment[]): number[] {
  const planned = input.previousContent.strength.days
    .map((day) => day.dayOfWeek)
    .filter((day): day is number => day !== null && day !== undefined)
    .sort((left, right) => left - right);
  const trained = [...new Set(input.evidence.trainedWeekdays)].sort((a, b) => a - b);
  const missed = input.evidence.missedWeekdays;

  // Two or more missed days is a pattern, not a bad Tuesday: the plan asked for
  // more days than the week had room for, so it asks for one fewer.
  if (missed.length >= 2 && planned.length > 2) {
    const next =
      trained.length >= planned.length - 1
        ? trained
        : fillFrom(planned, trained, planned.length - 1);
    adjustments.push({
      kind: 'TRAINING_DAYS',
      code: 'TRAINING_DAYS_REDUCED',
      before: planned,
      after: next,
    });
    return next;
  }

  // One missed day, but they trained on a day the plan called a rest day: the
  // plan had the wrong weekday, not too many of them.
  const extra = trained.filter((day) => !planned.includes(day));
  if (missed.length >= 1 && extra.length > 0) {
    const replacement = extra[0]!;
    const next = [...planned.filter((day) => day !== missed[0]), replacement].sort((a, b) => a - b);
    adjustments.push({
      kind: 'TRAINING_DAYS',
      code: 'TRAINING_DAYS_MOVED',
      before: planned,
      after: next,
    });
    return next;
  }

  return planned;
}

// The plan's own weekdays, for a week that carries no information about them.
function unchangedTrainingDays(input: WeeklyReviewInput): number[] {
  return input.previousContent.strength.days
    .map((day) => day.dayOfWeek)
    .filter((day): day is number => day !== null && day !== undefined)
    .sort((left, right) => left - right);
}

// Keeps the days that were actually used, then tops up from the planned days in
// weekday order so the count matches the new frequency (the assessment schema
// requires at least as many available days as training days).
function fillFrom(planned: readonly number[], trained: readonly number[], count: number): number[] {
  const chosen = [...trained];
  for (const day of planned) {
    if (chosen.length >= count) break;
    if (!chosen.includes(day)) chosen.push(day);
  }
  return chosen.sort((left, right) => left - right);
}

// ---------------------------------------------------------- calories

// How much slower than the target still counts as on track. Losing at half the
// requested rate is not "stalled", but not losing at all is, and one week of
// scale noise should never move a calorie target on its own.
const STALL_FRACTION = 0.5;
const TOO_FAST_FRACTION = 1.6;
// Weight is noisy: a recomp counts a stable waist as progress even when the
// scale does not move.
const RECOMP_WAIST_TOLERANCE_CM = 0.5;
// Outside this band the scale is drifting away from maintenance rather than
// holding still, which is the one thing recomp is trying not to do.
const RECOMP_DRIFT_PCT = 0.2;

interface RateDecision {
  rate: number;
  code: 'PACE_FASTER' | 'PACE_SLOWER' | null;
}

function reviewRate(input: WeeklyReviewInput, adjustments: WeeklyAdjustment[]): RateDecision {
  const goalType = input.previousAssessment.goal.type;
  const currentRate = input.previousAssessment.goal.desiredWeeklyRatePct;
  const observed = observedWeeklyRatePct(input.evidence);

  if (observed === null) {
    adjustments.push({ kind: 'KEEP', code: 'NO_WEIGHT_DATA' });
    return { rate: currentRate, code: null };
  }

  const direction = stepDirection(goalType, currentRate, observed, input.evidence);
  if (direction === 0) return { rate: currentRate, code: null };

  const pace = rateToPace(goalType, currentRate);
  const index = PACE_ORDER.indexOf(pace);
  const nextPace: GoalPace =
    goalType === 'RECOMP'
      ? // Recomp has no "faster" to push for: a drift moves back toward
        // maintenance, which is the middle of the three choices.
        PACE_ORDER[clamp(index + Math.sign(1 - index), 0, PACE_ORDER.length - 1)]!
      : PACE_ORDER[clamp(index + direction, 0, PACE_ORDER.length - 1)]!;
  if (nextPace === pace) return { rate: currentRate, code: null };

  const nextRate = paceToRate(goalType, nextPace);
  return { rate: nextRate, code: direction > 0 ? 'PACE_FASTER' : 'PACE_SLOWER' };
}

// +1 = push harder (a bigger deficit, or a bigger surplus), -1 = ease off.
//
// The comparison is a ratio against the rate the trainee asked for, because
// "half of what I asked for" means the same thing whether the goal is losing
// 0.5% a week or gaining 0.2%.
function stepDirection(
  goalType: AssessmentInput['goal']['type'],
  currentRate: number,
  observed: number,
  evidence: WeekEvidence,
): -1 | 0 | 1 {
  if (goalType === 'RECOMP') {
    // Recomp works when the scale holds still; the number that matters is the
    // tape, so a stable waist is progress even with a flat weight.
    const waistDelta = waistChangeCm(evidence);
    if (waistDelta !== null && waistDelta <= -RECOMP_WAIST_TOLERANCE_CM) return 0;
    if (observed > RECOMP_DRIFT_PCT) return -1;
    if (observed < -RECOMP_DRIFT_PCT) return -1;
    return 0;
  }

  if (currentRate === 0) return 0;
  const ratio = observed / currentRate;
  if (ratio < STALL_FRACTION) return 1;
  if (ratio > TOO_FAST_FRACTION) return -1;
  return 0;
}

function observedWeeklyRatePct(evidence: WeekEvidence): number | null {
  const start = evidence.weightStartKg;
  const end = evidence.weightEndKg;
  if (start === null || end === null || start <= 0) return null;
  if (start === end) return 0;
  const days = daysBetween(evidence.windowStart, evidence.windowEnd);
  if (days <= 0) return null;
  return ((end - start) / start) * 100 * (7 / days);
}

function weightChanged(evidence: WeekEvidence): number | null {
  const start = evidence.weightStartKg;
  const end = evidence.weightEndKg;
  if (start === null || end === null) return null;
  return end - start;
}

function waistChangeCm(evidence: WeekEvidence): number | null {
  if (evidence.waistStartCm === null || evidence.waistEndCm === null) return null;
  return evidence.waistEndCm - evidence.waistStartCm;
}

// ---------------------------------------------------------- cardio

// Below half of the prescription, the plan asked for a week the trainee does not
// have; above all of it, there is room to ask for a little more when the goal
// needs it. Both stay inside the 20-300 minute band the change rules allow.
const CARDIO_SKIPPED_FRACTION = 0.5;
const CARDIO_STEP = 0.25;
const CARDIO_MIN_MINUTES = 20;
const CARDIO_MAX_MINUTES = 300;

// Cardio is the cheapest lever for a fat-loss stall and the first thing a busy
// week drops, so it gets both reactions: less when it clearly did not fit, and
// a little more when it did fit and the scale still did not move.
//
// The "more" only ever happens once the calorie lever is spent: two changes in
// one week make it impossible to tell which one worked.
function needsMoreCardio(
  goalType: AssessmentInput['goal']['type'],
  rate: number,
  observed: number | null,
  caloriesMoved: boolean,
): boolean {
  if (caloriesMoved) return false;
  if (observed === null) return false;
  if (goalType === 'FAT_LOSS') {
    return rate === 0 ? observed >= 0 : observed / rate < STALL_FRACTION;
  }
  if (goalType === 'RECOMP') return observed > RECOMP_DRIFT_PCT;
  return false;
}

function reviewCardio(
  content: FitnessPlanContent,
  input: WeeklyReviewInput,
  adjustments: WeeklyAdjustment[],
  options: { caloriesMoved: boolean },
): FitnessPlanContent {
  const planned = content.cardio.additionalWeeklyMin;
  if (planned === 0) return content;

  const completed = input.evidence.cardioCompletedMin;
  const goalType = input.previousAssessment.goal.type;
  const rate = input.previousAssessment.goal.desiredWeeklyRatePct;
  const observed = observedWeeklyRatePct(input.evidence);

  let target: number | null = null;
  if (completed < planned * CARDIO_SKIPPED_FRACTION) {
    target = roundTo5(Math.max(CARDIO_MIN_MINUTES, planned * (1 - CARDIO_STEP)));
  } else if (
    completed >= planned &&
    needsMoreCardio(goalType, rate, observed, options.caloriesMoved)
  ) {
    target = roundTo5(Math.min(CARDIO_MAX_MINUTES, planned * (1 + CARDIO_STEP)));
  }
  if (target === null || target === planned) return content;

  const next = applyPlanChange(
    content,
    { kind: 'SET_CARDIO_MINUTES', minutes: target },
    {
      availableWeekdays: [1, 2, 3, 4, 5, 6, 7],
      equipmentTypes: input.previousAssessment.schedule.equipmentTypes,
      unavailableExerciseNames: input.gymConstraints.unavailableExerciseNames,
    },
  ).content;
  adjustments.push({
    kind: 'CARDIO',
    code: target < planned ? 'CARDIO_REDUCED' : 'CARDIO_INCREASED',
    before: planned,
    after: next.cardio.additionalWeeklyMin,
  });
  return next;
}

// ---------------------------------------------------------- loads

function describeLoadRefresh(input: WeeklyReviewInput): WeeklyAdjustment {
  const previous = new Map(
    input.previousContent.loadGuidance.map((entry) => [entry.catalogKey, entry.initialLoadKg]),
  );
  const refreshed = input.loadGuidance.filter((entry) => {
    if (!input.previousContent.loadGuidance.some((old) => old.catalogKey === entry.catalogKey)) {
      return false;
    }
    return previous.get(entry.catalogKey) !== entry.initialLoadKg;
  }).length;
  return {
    kind: 'LOADS',
    code: refreshed > 0 ? 'LOADS_REFRESHED' : 'LOADS_UNCHANGED',
    refreshed,
  };
}

// ---------------------------------------------------------- helpers

function roundTo5(value: number): number {
  return Math.round(value / 5) * 5;
}

function daysBetween(startIso: string, endIso: string): number {
  const start = Date.parse(`${startIso}T00:00:00.000Z`);
  const end = Date.parse(`${endIso}T00:00:00.000Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.round((end - start) / 86_400_000);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
