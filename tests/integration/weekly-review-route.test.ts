import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { getCurrentUserId } from '@/lib/auth';
import { saveAssessment } from '@/lib/fitness/assessment-store';
import type { AssessmentInput } from '@/lib/fitness/schemas';
import type { PersistedCalculationInput } from '@/lib/fitness/plan-store';

vi.mock('@/lib/auth', () => ({ getCurrentUserId: vi.fn() }));
const mockUserId = vi.mocked(getCurrentUserId);

import { POST as postPreview } from '@/app/api/fitness/plans/preview/route';
import { POST as postActivate } from '@/app/api/fitness/plans/[id]/activate/route';
import { GET as getReview, POST as postReview } from '@/app/api/fitness/plans/weekly-review/route';

const DAY_MS = 86_400_000;

const baseInput: AssessmentInput = {
  profile: {
    ageYears: 30,
    displaySex: 'FEMALE',
    energyEquationReference: 'FEMALE',
    heightCm: 170,
    weightKg: 70,
    trainingAgeMonths: 18,
  },
  goal: { type: 'FAT_LOSS', desiredWeeklyRatePct: -0.5 },
  schedule: {
    weeklyFrequency: 3,
    availableWeekdays: [1, 3, 5],
    sessionDurationMin: 60,
    equipmentTypes: ['BARBELL', 'CABLE', 'DUMBBELL', 'MACHINE', 'BODYWEIGHT'],
    recentMainLifts: [{ catalogKey: 'bench_press', weightKg: 40, reps: 8, rir: 2 }],
  },
  lifestyle: {
    activityLevel: 'MODERATE',
    currentModerateActivityMin: 120,
    habitualSleepMin: 480,
    bedtimeMin: 1380,
    wakeTimeMin: 420,
    timeZone: 'UTC',
  },
  health: {
    urgentSignals: [],
    clearanceSignals: [],
    temporarySignals: [],
    scopeSignals: [],
    healthChangedSinceClearance: false,
    attested: true,
  },
};

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function idParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

// The plan is activated, then moved back in time so its week has turned over -
// which is the only thing that makes a review due.
async function activatedPlan(suffix: string, planAgeDays = 8) {
  const user = await db.user.create({
    data: { email: `${suffix}@weekly-review.test`, passwordHash: 'test-password-hash' },
  });
  await saveAssessment(user.id, baseInput, new Date());
  mockUserId.mockResolvedValue(user.id);

  const preview = await postPreview(jsonRequest('http://test.local/api/fitness/plans/preview', {}));
  const { plan, activationRevision } = (await preview.json()) as {
    plan: { id: string };
    activationRevision: number;
  };
  const activated = await postActivate(
    jsonRequest('http://test.local/api/fitness/plans/x/activate', {
      expectedRevision: activationRevision,
    }),
    idParams(plan.id),
  );
  expect(activated.status).toBe(200);

  await db.fitnessPlanVersion.update({
    where: { id: plan.id },
    data: { activatedAt: new Date(Date.now() - planAgeDays * DAY_MS) },
  });
  return { user, planId: plan.id };
}

// A finished session carrying one working set, on a given date.
async function logSession(userId: string, startedAt: Date) {
  // A strength movement, not whatever the catalog happens to list first: cardio
  // sets are stored in a different shape and do not count as a training day.
  const exercise = await db.exercise.findFirstOrThrow({
    where: { userId, category: { not: 'CARDIO' } },
  });
  const session = await db.session.create({
    data: { userId, startedAt, finishedAt: new Date(startedAt.getTime() + 45 * 60_000) },
  });
  await db.set.create({
    data: {
      sessionId: session.id,
      exerciseId: exercise.id,
      setNumber: 1,
      weight: 40,
      reps: 8,
      completedAt: startedAt,
    },
  });
  return session;
}

// Within the last seven days there is exactly one Monday and one Wednesday, and
// picking those two makes the numbers below deterministic however the suite is
// scheduled.
function dayOfWeekInWindow(windowStart: Date, weekday: number): Date {
  for (let offset = 0; offset < 7; offset += 1) {
    const candidate = new Date(windowStart.getTime() + offset * DAY_MS);
    const isoWeekday = candidate.getUTCDay() === 0 ? 7 : candidate.getUTCDay();
    if (isoWeekday === weekday) return new Date(candidate.getTime() + 12 * 60 * 60_000);
  }
  throw new Error(`no ${weekday} in the window`);
}

function windowStartOf(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 7));
}

beforeEach(() => {
  mockUserId.mockReset();
});

describe('weekly review', () => {
  it('does not run before the plan has finished its week', async () => {
    const { user } = await activatedPlan('review-fresh', 0);

    const response = await postReview(
      jsonRequest('http://test.local/api/fitness/plans/weekly-review', {}),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { created: boolean; reason: string };
    expect(body).toMatchObject({ created: false, reason: 'NOT_DUE' });

    const state = (await (await getReview()).json()) as { status: string };
    expect(state.status).toBe('WAITING');
    expect(user.id).toBeTruthy();
  });

  it('creates a model-shaped version when the week left no completion evidence', async () => {
    await activatedPlan('review-empty');

    const response = await postReview(
      jsonRequest('http://test.local/api/fitness/plans/weekly-review', { activate: true }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      created: boolean;
      reason: string;
      adjustments: { code: string }[];
      planId: string;
    };
    expect(body.created).toBe(true);
    const fresh = await db.fitnessPlanVersion.findUniqueOrThrow({ where: { id: body.planId } });
    expect(fresh.strategy).toMatchObject({ source: 'MODEL' });
    expect(
      (fresh.input as unknown as PersistedCalculationInput).weeklyReview?.strategy.rationale,
    ).toEqual(expect.any(String));

    // The review still remembers that it ran, so the question is not asked again
    // every time the trainee opens the app.
    const state = (await (await getReview()).json()) as { status: string };
    expect(state.status).toBe('WAITING');
  });

  it('reviews a real week, records what it saw, and applies the result', async () => {
    const { user, planId } = await activatedPlan('review-week');
    const windowStart = windowStartOf(new Date());
    await logSession(user.id, dayOfWeekInWindow(windowStart, 1));
    await logSession(user.id, dayOfWeekInWindow(windowStart, 3));
    await db.bodyweightEntry.create({
      data: { userId: user.id, weightKg: 70, measuredAt: dayOfWeekInWindow(windowStart, 1) },
    });
    await db.bodyweightEntry.create({
      // Two kilos down in a week is well over the pace a fat-loss goal asks for:
      // the review should notice and ease off.
      data: { userId: user.id, weightKg: 68, measuredAt: new Date() },
    });

    const response = await postReview(
      jsonRequest('http://test.local/api/fitness/plans/weekly-review', { activate: true }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      created: boolean;
      activated: boolean;
      planId: string;
      version: number;
      evidence: { completedSessions: number; plannedSessions: number };
      adjustments: { code: string }[];
    };
    expect(body.created).toBe(true);
    expect(body.activated).toBe(true);
    expect(body.evidence).toMatchObject({ completedSessions: 2, plannedSessions: 3 });

    // The new version replaced the old one, and it is the one in use.
    const newPlan = await db.fitnessPlanVersion.findUniqueOrThrow({
      where: { id: body.planId },
    });
    expect(newPlan.status).toBe('ACTIVE');
    expect(newPlan.version).toBeGreaterThan(
      (await db.fitnessPlanVersion.findUniqueOrThrow({ where: { id: planId } })).version,
    );
    expect((await db.fitnessPlanVersion.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
      'SUPERSEDED',
    );

    // The review's own numbers travelled with the version: the weight it read is
    // the weight the calories were computed from.
    const stored = newPlan.input as unknown as PersistedCalculationInput;
    expect(stored.assessment.profile.weightKg).toBeCloseTo(68, 5);
    const codes = body.adjustments.map((entry) => entry.code);
    expect(codes).toContain('PACE_SLOWER');
    // The current model strategy chooses cardio; intermediate rules-only
    // reductions must not claim a change absent from the final draft.
    const previousPlan = await db.fitnessPlanVersion.findUniqueOrThrow({ where: { id: planId } });
    const beforeCardio = (previousPlan.content as { cardio: { additionalWeeklyMin: number } })
      .cardio.additionalWeeklyMin;
    const afterCardio = (newPlan.content as { cardio: { additionalWeeklyMin: number } }).cardio
      .additionalWeeklyMin;
    const cardioAdjustment = body.adjustments.find(
      (entry) => entry.code === 'CARDIO_REDUCED' || entry.code === 'CARDIO_INCREASED',
    );
    expect(cardioAdjustment).toEqual(
      beforeCardio === afterCardio
        ? undefined
        : {
            kind: 'CARDIO',
            code: afterCardio < beforeCardio ? 'CARDIO_REDUCED' : 'CARDIO_INCREASED',
            before: beforeCardio,
            after: afterCardio,
          },
    );
    expect(newPlan.strategy).toMatchObject({ source: 'MODEL' });

    // Applying the review materialized a program, exactly like any activation.
    const program = await db.program.findFirst({
      where: { userId: user.id, isActive: true },
      select: { id: true, fitnessPlanVersion: { select: { id: true } } },
    });
    expect(program?.fitnessPlanVersion?.id).toBe(body.planId);

    const state = (await (await getReview()).json()) as {
      status: string;
      lastReview: { evidence: { completedSessions: number }; activated: boolean } | null;
    };
    expect(state.status).toBe('WAITING');
    expect(state.lastReview?.activated).toBe(true);
    expect(state.lastReview?.evidence.completedSessions).toBe(2);
  });

  it('leaves the new version as a draft when activation is not requested', async () => {
    const { user } = await activatedPlan('review-manual');
    const windowStart = windowStartOf(new Date());
    await logSession(user.id, dayOfWeekInWindow(windowStart, 1));
    await logSession(user.id, dayOfWeekInWindow(windowStart, 3));
    await db.bodyweightEntry.create({
      data: { userId: user.id, weightKg: 70, measuredAt: dayOfWeekInWindow(windowStart, 1) },
    });
    await db.bodyweightEntry.create({
      data: { userId: user.id, weightKg: 69.6, measuredAt: new Date() },
    });

    const body = (await (
      await postReview(jsonRequest('http://test.local/api/fitness/plans/weekly-review', {}))
    ).json()) as { created: boolean; activated: boolean; planId: string };
    expect(body).toMatchObject({ created: true, activated: false });
    expect(
      (await db.fitnessPlanVersion.findUniqueOrThrow({ where: { id: body.planId } })).status,
    ).toBe('DRAFT');

    // And the screen knows there is a draft waiting rather than asking for
    // another one.
    const state = (await (await getReview()).json()) as { status: string; planId: string };
    expect(state).toMatchObject({ status: 'DRAFT_READY', planId: body.planId });
  });
});
