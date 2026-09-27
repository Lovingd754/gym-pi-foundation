import { Prisma } from '@/prisma/generated/client';
import { db } from '@/lib/db';
import { ApiError } from '@/lib/api';

import { activateFitnessPlan } from './activate-plan';
import { evaluateEligibility } from './eligibility';
import { hashAuditValue } from '@/lib/agent/audit-hash';
import {
  buildPersistedCalculationInput,
  createDerivedPlanVersion,
  loadCalculationState,
  type PersistedCalculationInput,
} from './plan-store';
import { parseFitnessPlanContent } from './plan-schema';
import { requestWeeklyStrategy } from './weekly-strategy';
import { requestDetailedStrength } from './detailed-strength';
import { weeklyConstraints } from './weekly-activities';
import { getWeeklyActivities } from './weekly-activities-store';
import { applyWeeklyStrategy } from './weekly-strategy-apply';
import {
  addDays,
  isoWeekStartDate,
  isoWeekdayInTimeZone,
  localCalendarDate,
  startOfLocalDayUtc,
} from './time-zone';
import { reviewWeek, type WeekEvidence, type WeeklyAdjustment } from './weekly-review';

// ============================================================
// Running the weekly review against a real account
// ============================================================
// The rules live in weekly-review.ts and know nothing about the database. This
// module is the part that knows: it reads the last seven days of sessions,
// cardio, weigh-ins and waist measurements, hands them to the rules, and stores
// the result as the next version of the plan.

export type WeeklyReviewState =
  | { status: 'NO_ACTIVE_PLAN' }
  | {
      status: 'WAITING';
      weekStart: string;
      nextReviewDate: string;
      lastReview: WeeklyReviewSummary | null;
    }
  | {
      status: 'REVIEWED';
      weekStart: string;
      nextReviewDate: string;
      lastReview: WeeklyReviewSummary;
    }
  | {
      status: 'DRAFT_READY';
      planId: string;
      version: number;
      lastReview: WeeklyReviewSummary | null;
    }
  | {
      status: 'DUE';
      weekStart: string;
      weekEnd: string;
      evidence: WeekEvidence;
      lastReview: WeeklyReviewSummary | null;
    };

// What the review concluded, kept so the screen can show it as long as it is
// the latest thing that happened to the plan.
export type WeeklyReviewSummary = {
  // The seven days the review looked at, and the trainee's week it belongs to.
  weekStart: string;
  weekEnd: string;
  reviewedWeek: string;
  reviewedAt: string;
  evidence: WeekEvidence;
  adjustments: WeeklyAdjustment[];
  unchanged: boolean;
  activated: boolean;
  planId: string | null;
  modelSource?: 'MODEL';
  rationale?: string;
};

export type WeeklyReviewOutcome =
  | {
      created: false;
      reason: 'NO_ACTIVE_PLAN' | 'NOT_DUE' | 'NO_EVIDENCE' | 'UNCHANGED';
      evidence: WeekEvidence | null;
      adjustments: WeeklyAdjustment[];
    }
  | {
      created: true;
      planId: string;
      version: number;
      programId: string | null;
      activated: boolean;
      evidence: WeekEvidence;
      adjustments: WeeklyAdjustment[];
    };

// How far back to look for a weigh-in when the week itself has none: enough to
// cover a fortnightly scale habit without reaching into last month.
const WEIGH_IN_LOOKBACK_DAYS = 14;

export async function getWeeklyReviewState(
  userId: string,
  now: Date = new Date(),
): Promise<WeeklyReviewState> {
  const active = await activePlanRow(userId);
  if (!active) return { status: 'NO_ACTIVE_PLAN' };

  const lastReview = await lastReviewSummary(userId);
  const timeZone = timeZoneOf(active.input);
  const currentWeekStart = isoWeekStartDate(now, timeZone);
  const planWeekStart = active.activatedAt
    ? isoWeekStartDate(active.activatedAt, timeZone)
    : currentWeekStart;

  if (planWeekStart >= currentWeekStart) {
    return {
      status: 'WAITING',
      weekStart: currentWeekStart,
      nextReviewDate: addDays(currentWeekStart, 7),
      lastReview,
    };
  }

  const reviewedWeek = await reviewedWeekOf(userId);

  // A review that was generated but not confirmed is what the trainee sees
  // instead of being asked to generate it again.
  const draft = await db.fitnessPlanVersion.findFirst({
    where: {
      userId,
      status: 'DRAFT',
      version: { gt: active.version },
      createdAt: { gte: active.activatedAt ?? active.createdAt },
    },
    orderBy: { version: 'desc' },
    select: { id: true, version: true },
  });
  if (draft) {
    return { status: 'DRAFT_READY', planId: draft.id, version: draft.version, lastReview };
  }

  // Already reviewed for the week that just ended: the answer is known and the
  // plan either changed then or was confirmed to need no change.
  if (reviewedWeek === currentWeekStart && lastReview) {
    return {
      status: 'REVIEWED',
      weekStart: currentWeekStart,
      nextReviewDate: addDays(currentWeekStart, 7),
      lastReview,
    };
  }

  const window = reviewWindow(now, timeZone);
  const evidence = withPlanned(
    await gatherWeekEvidence(userId, window, timeZone),
    parseFitnessPlanContent(active.content),
  );
  return { status: 'DUE', weekStart: window.start, weekEnd: window.end, evidence, lastReview };
}

export async function runWeeklyReview(input: {
  userId: string;
  activate?: boolean;
  now?: Date;
  // Forces the review even if the plan's week has not turned over yet: the plan
  // screen offers "regenerate this week" as an explicit command.
  force?: boolean;
}): Promise<WeeklyReviewOutcome> {
  const now = input.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new RangeError('now must be a valid date');

  const active = await activePlanRow(input.userId);
  if (!active) {
    return { created: false, reason: 'NO_ACTIVE_PLAN', evidence: null, adjustments: [] };
  }
  const timeZone = timeZoneOf(active.input);

  if (!input.force) {
    const currentWeekStart = isoWeekStartDate(now, timeZone);
    const planWeekStart = active.activatedAt
      ? isoWeekStartDate(active.activatedAt, timeZone)
      : currentWeekStart;
    if (planWeekStart >= currentWeekStart) {
      const window = reviewWindow(now, timeZone);
      return {
        created: false,
        reason: 'NOT_DUE',
        evidence: await gatherWeekEvidence(input.userId, window, timeZone),
        adjustments: [],
      };
    }
  }

  const window = reviewWindow(now, timeZone);
  const previousContent = parseFitnessPlanContent(active.content);
  const evidence = withPlanned(
    await gatherWeekEvidence(input.userId, window, timeZone),
    previousContent,
  );

  // The review starts from the trainee's *current* answers, not from the copy
  // the plan was written with: a weigh-in, a new goal or a shorter session all
  // belong in this week's plan.
  const state = await db.$transaction((tx) => loadCalculationState(tx, input.userId, now));
  const stored = buildPersistedCalculationInput(
    state,
    localCalendarDate(now, state.assessment.lifestyle.timeZone),
  );
  const eligibility = evaluateEligibility(state.assessment, now);
  if (eligibility.status !== 'ELIGIBLE') {
    throw new ApiError(409, 'FITNESS_NOT_ELIGIBLE', {
      eligibilityStatus: eligibility.status,
      reasonCodes: eligibility.reasonCodes,
    });
  }

  // The freshest evidence for the starting loads comes with the state: a week of
  // logged sets is the best available statement of what the trainee can lift.
  const loadGuidance = state.loadGuidance;
  const activities = await getWeeklyActivities(input.userId, now);
  const constraints = {
    ...weeklyConstraints(
      state.assessment.schedule.availableWeekdays,
      state.assessment.schedule.equipmentTypes,
      activities.activities,
    ),
    equipmentTypes: state.assessment.schedule.equipmentTypes,
    sessionDurationMin: null,
    activities: activities.activities,
  };
  if (constraints.availableWeekdays.length < 2)
    throw new ApiError(409, 'WEEKLY_SCHEDULE_INFEASIBLE', {
      availableWeekdays: constraints.availableWeekdays,
      message:
        'This week has fewer than two feasible training days. Keep recovery days free and make at least two days available before regenerating.',
    });
  if (constraints.availableWeekdays.length === 2) {
    const gap = Math.abs(constraints.availableWeekdays[0]! - constraints.availableWeekdays[1]!);
    if (gap === 1 || gap === 6)
      throw new ApiError(409, 'WEEKLY_SCHEDULE_INFEASIBLE', {
        availableWeekdays: constraints.availableWeekdays,
        message:
          'The only two available days are consecutive. Full body sessions need a recovery day between them. Make two separated days available before regenerating.',
      });
  }
  const [memories, recovery] = await Promise.all([
    db.agentMemory.findMany({
      where: { userId: input.userId, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { content: true },
    }),
    db.readinessCheckin.findMany({
      where: { userId: input.userId, createdAt: { gte: window.startInstant, lte: now } },
      orderBy: { createdAt: 'desc' },
      take: 14,
      select: { readiness: true, sleepQuality: true, soreness: true, note: true, createdAt: true },
    }),
  ]);
  const strategy = await requestWeeklyStrategy({
    userId: input.userId,
    constraints,
    context: {
      previousPlan: previousContent,
      assessment: state.assessment,
      evidence,
      loadGuidance,
      activeMemories: memories.map((m) => m.content.slice(0, 500)),
      recovery: recovery.map((r) => ({ ...r, note: r.note?.slice(0, 500) })),
      currentWeekActivities: activities,
    },
  });

  const result = reviewWeek({
    previousContent,
    previousAssessment: state.assessment,
    eligibility,
    gymConstraints: state.gymConstraints,
    loadGuidance,
    evidence,
    now,
  });
  const selectedConstraints = {
    ...weeklyConstraints(
      strategy.weekdays,
      state.assessment.schedule.equipmentTypes,
      activities.activities,
    ),
    availableWeekdays: constraints.availableWeekdays,
    activities: activities.activities,
    previousCardioMin: previousContent.cardio.additionalWeeklyMin,
  };
  const shaped = applyWeeklyStrategy(
    {
      assessment: result.assessment,
      eligibility,
      gymConstraints: state.gymConstraints,
      loadGuidance,
      now,
    },
    strategy,
    selectedConstraints,
  );
  shaped.content = await requestDetailedStrength({
    userId: input.userId,
    base: shaped.content,
    calculation: {
      assessment: shaped.assessment,
      eligibility,
      gymConstraints: state.gymConstraints,
      loadGuidance,
      now,
    },
    strategy,
    constraints: selectedConstraints,
    context: {
      previousPlan: previousContent,
      evidence,
      activeMemories: memories.map((m) => m.content.slice(0, 500)),
      recovery: recovery.map((r) => ({ ...r, note: r.note?.slice(0, 500) })),
    },
  });
  // Describe the actual shaped draft, rather than the rules' intermediate
  // schedule and cardio choices that the model just replaced.
  const calorieAdjustment = result.adjustments.find((a) => a.kind === 'CALORIES');
  result.adjustments = result.adjustments.filter((a) => a.kind === 'LOADS');
  if (
    JSON.stringify(previousContent.nutrition.caloriesKcal) !==
    JSON.stringify(shaped.content.nutrition.caloriesKcal)
  )
    result.adjustments.push({
      kind: 'CALORIES',
      code: calorieAdjustment?.kind === 'CALORIES' ? calorieAdjustment.code : 'RECALCULATED',
      before: previousContent.nutrition.caloriesKcal,
      after: shaped.content.nutrition.caloriesKcal,
    });
  const beforeDays = previousContent.strength.days
    .map((d) => d.dayOfWeek)
    .filter((d): d is number => d != null);
  if (JSON.stringify(beforeDays) !== JSON.stringify(strategy.weekdays))
    result.adjustments.push({
      kind: 'TRAINING_DAYS',
      code:
        strategy.weekdays.length < beforeDays.length
          ? 'TRAINING_DAYS_REDUCED'
          : 'TRAINING_DAYS_MOVED',
      before: beforeDays,
      after: strategy.weekdays,
    });
  const beforeCardio = previousContent.cardio.additionalWeeklyMin;
  const afterCardio = shaped.content.cardio.additionalWeeklyMin;
  if (beforeCardio !== afterCardio)
    result.adjustments.push({
      kind: 'CARDIO',
      code: afterCardio < beforeCardio ? 'CARDIO_REDUCED' : 'CARDIO_INCREASED',
      before: beforeCardio,
      after: afterCardio,
    });

  // Whatever the outcome, the review remembers that it ran for this week: a
  // week that needed no change is a result too, and re-deriving it on every page
  // load would be work nobody asked for.
  const summary: WeeklyReviewSummary = {
    weekStart: window.start,
    weekEnd: window.end,
    reviewedWeek: isoWeekStartDate(now, timeZone),
    reviewedAt: now.toISOString(),
    evidence,
    adjustments: result.adjustments,
    unchanged: false,
    activated: false,
    planId: null,
    modelSource: 'MODEL',
    rationale: strategy.rationale ?? undefined,
  };

  const created = await createDerivedPlanVersion({
    userId: input.userId,
    basePlanId: active.id,
    content: shaped.content,
    strategy,
    weeklyActivities: activities,
    // The adjusted assessment travels with the version so the plain-language
    // summary on the preview reads it back; the input hash stays the base's,
    // which is what proves the trainee's own answers have not changed since.
    storedInput: {
      ...stored,
      assessment: shaped.assessment,
      loadGuidance,
      weeklyReview: { activities, strategy },
    },
    inputHash: hashAuditValue(stored),
  });

  if (!input.activate) {
    await storeSummary(input.userId, { ...summary, planId: created.id });
    return {
      created: true,
      planId: created.id,
      version: created.version,
      programId: null,
      activated: false,
      evidence,
      adjustments: result.adjustments,
    };
  }

  const activated = await activateFitnessPlan({
    userId: input.userId,
    planId: created.id,
    expectedRevision: await activationRevision(input.userId),
    now,
  });
  await storeSummary(input.userId, {
    ...summary,
    planId: created.id,
    activated: true,
  });
  return {
    created: true,
    planId: created.id,
    version: created.version,
    programId: activated.programId,
    activated: true,
    evidence,
    adjustments: result.adjustments,
  };
}

async function storeSummary(userId: string, summary: WeeklyReviewSummary): Promise<void> {
  const data = {
    // The trainee's week the review belongs to, which is what stops the same
    // week from being reviewed twice.
    lastReviewWeek: summary.reviewedWeek,
    lastReviewedAt: new Date(summary.reviewedAt),
    lastReviewSummary: summary as unknown as Prisma.InputJsonValue,
  };
  await db.fitnessPlanActivation.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });
}

async function lastReviewSummary(userId: string): Promise<WeeklyReviewSummary | null> {
  const activation = await db.fitnessPlanActivation.findUnique({
    where: { userId },
    select: { lastReviewSummary: true },
  });
  const stored = activation?.lastReviewSummary as unknown;
  if (!stored || typeof stored !== 'object' || !('weekStart' in stored)) return null;
  return stored as WeeklyReviewSummary;
}

async function reviewedWeekOf(userId: string): Promise<string | null> {
  const activation = await db.fitnessPlanActivation.findUnique({
    where: { userId },
    select: { lastReviewWeek: true },
  });
  return activation?.lastReviewWeek ?? null;
}

// The evidence window: the seven days that just finished, ending with today.
// Anchoring on "the last seven days" rather than on a calendar week is what
// makes the same code path work for the Monday review (which then covers the
// week that ended) and for a trainee who clicks "review now" on a Thursday.
export function reviewWindow(
  now: Date,
  timeZone: string,
): { start: string; end: string; startInstant: Date; endInstant: Date } {
  const end = localCalendarDate(now, timeZone);
  const start = addDays(end, -7);
  return {
    start,
    end,
    startInstant: startOfLocalDayUtc(start, timeZone),
    // Up to right now, not to the start of today: a weigh-in from this morning
    // is part of the week the review is looking at.
    endInstant: now,
  };
}

// The planned half of the week comes from the plan the trainee was actually
// following, so "2 of 4 sessions" compares like with like.
function withPlanned(
  evidence: WeekEvidence,
  content: {
    strength: { days: { dayOfWeek?: number | null }[] };
    cardio: { additionalWeeklyMin: number };
  },
): WeekEvidence {
  const plannedWeekdays = content.strength.days
    .map((day) => day.dayOfWeek)
    .filter((day): day is number => day !== null && day !== undefined);
  return {
    ...evidence,
    plannedSessions: plannedWeekdays.length,
    missedWeekdays: plannedWeekdays.filter((day) => !evidence.trainedWeekdays.includes(day)),
    cardioPlannedMin: content.cardio.additionalWeeklyMin,
  };
}

async function gatherWeekEvidence(
  userId: string,
  window: { start: string; end: string; startInstant: Date; endInstant: Date },
  timeZone: string,
): Promise<WeekEvidence> {
  const [sessions, weighIns, waists] = await Promise.all([
    db.session.findMany({
      where: {
        userId,
        finishedAt: { not: null },
        startedAt: { gte: window.startInstant, lt: window.endInstant },
      },
      select: {
        startedAt: true,
        sets: {
          select: {
            isWarmup: true,
            durationSec: true,
            exercise: { select: { category: true } },
          },
        },
      },
    }),
    db.bodyweightEntry.findMany({
      where: {
        userId,
        measuredAt: {
          gte: new Date(window.startInstant.getTime() - WEIGH_IN_LOOKBACK_DAYS * 86_400_000),
          lt: window.endInstant,
        },
      },
      orderBy: [{ measuredAt: 'asc' }, { id: 'asc' }],
      select: { weightKg: true, measuredAt: true },
    }),
    db.bodyMeasurement.findMany({
      where: {
        userId,
        site: 'WAIST',
        measuredAt: {
          gte: new Date(window.startInstant.getTime() - WEIGH_IN_LOOKBACK_DAYS * 86_400_000),
          lt: window.endInstant,
        },
      },
      orderBy: [{ measuredAt: 'asc' }, { id: 'asc' }],
      select: { valueCm: true, measuredAt: true },
    }),
  ]);

  const strengthSessions = sessions.filter((session) =>
    session.sets.some((set) => !set.isWarmup && set.exercise.category !== 'CARDIO'),
  );
  const trainedWeekdays = [
    ...new Set(
      strengthSessions.map((session) => isoWeekdayInTimeZone(session.startedAt, timeZone)),
    ),
  ].sort((left, right) => left - right);

  const cardioCompletedMin = Math.round(
    sessions.reduce(
      (total, session) =>
        total +
        session.sets.reduce(
          (sum, set) =>
            set.exercise.category === 'CARDIO' && !set.isWarmup
              ? sum + (set.durationSec ?? 0)
              : sum,
          0,
        ),
      0,
    ) / 60,
  );

  return {
    windowStart: window.start,
    windowEnd: window.end,
    plannedSessions: 0,
    completedSessions: strengthSessions.length,
    trainedWeekdays,
    // The caller fills the planned side in from the plan itself, so the two
    // halves of "3 of 4 days" always come from the same prescription.
    missedWeekdays: [],
    cardioPlannedMin: 0,
    cardioCompletedMin,
    ...weightTrend(weighIns, window.startInstant),
    ...waistTrend(waists),
  };
}

// The weigh-in nearest the start of the window and the newest one in it, which
// is the same pair a person would compare when they step off the scale.
function weightTrend(
  entries: readonly { weightKg: number; measuredAt: Date }[],
  windowStart: Date,
): Pick<WeekEvidence, 'weightStartKg' | 'weightEndKg'> {
  if (entries.length === 0) return { weightStartKg: null, weightEndKg: null };
  const beforeWindow = entries.filter((entry) => entry.measuredAt <= windowStart);
  const start = beforeWindow.at(-1) ?? entries[0]!;
  const end = entries.at(-1)!;
  if (start.measuredAt.getTime() === end.measuredAt.getTime()) {
    return { weightStartKg: null, weightEndKg: null };
  }
  return { weightStartKg: start.weightKg, weightEndKg: end.weightKg };
}

function waistTrend(
  entries: readonly { valueCm: number; measuredAt: Date }[],
): Pick<WeekEvidence, 'waistStartCm' | 'waistEndCm'> {
  if (entries.length < 2) return { waistStartCm: null, waistEndCm: null };
  return { waistStartCm: entries[0]!.valueCm, waistEndCm: entries.at(-1)!.valueCm };
}

async function activePlanRow(userId: string) {
  return db.fitnessPlanVersion.findFirst({
    where: { userId, status: 'ACTIVE' },
    orderBy: { version: 'desc' },
    select: {
      id: true,
      version: true,
      content: true,
      input: true,
      strategy: true,
      createdAt: true,
      activatedAt: true,
    },
  });
}

async function activationRevision(userId: string): Promise<number> {
  const activation = await db.fitnessPlanActivation.findUnique({
    where: { userId },
    select: { revision: true },
  });
  return activation?.revision ?? 0;
}

function timeZoneOf(input: unknown): string {
  const stored = input as Partial<PersistedCalculationInput> | null;
  return stored?.assessment?.lifestyle?.timeZone ?? 'UTC';
}
