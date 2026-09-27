import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('next-intl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next-intl')>();
  const messages = (await import('@/messages/zh-CN')).default;
  const translator = actual.createTranslator({ locale: 'zh-CN', messages });
  const translate = translator as unknown as {
    (key: string, values?: Record<string, unknown>): string;
    rich: (key: string, values?: Record<string, unknown>) => React.ReactNode;
    raw: (key: string) => unknown;
    has: (key: string) => boolean;
  };
  return {
    ...actual,
    useLocale: () => 'zh-CN',
    useFormatter: () => actual.createFormatter({ locale: 'zh-CN', timeZone: 'UTC' }),
    useTranslations: (namespace?: string) => {
      const keyFor = (key: string) => (namespace ? `${namespace}.${key}` : key);
      const scoped = (key: string, values?: Record<string, unknown>) =>
        translate(keyFor(key), values);
      scoped.rich = (key: string, values?: Record<string, unknown>) =>
        translate.rich(keyFor(key), values);
      scoped.raw = (key: string) => translate.raw(keyFor(key));
      scoped.has = (key: string) => translate.has(keyFor(key));
      return scoped;
    },
  };
});

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn(), replace: vi.fn() }),
}));

import { PlanPreview } from './plan-preview';
import { PlanHistory } from './plan-history';
import { buildBaselinePlan } from '@/lib/fitness/baseline-plan';
import { evaluateEligibility } from '@/lib/fitness/eligibility';
import { STRENGTH_EXERCISE_CATALOG } from '@/lib/fitness/exercise-catalog';
import { createAssessmentInputSchema, type AssessmentInput } from '@/lib/fitness/schemas';
import type { FitnessPlanContent } from '@/lib/fitness/plan-schema';

const NOW = new Date('2026-09-16T12:00:00.000Z');

function assessment(overrides: Partial<AssessmentInput['profile']> = {}): AssessmentInput {
  return createAssessmentInputSchema(NOW).parse({
    profile: {
      ageYears: 30,
      displaySex: 'FEMALE',
      energyEquationReference: 'UNSPECIFIED',
      heightCm: 170,
      weightKg: 70,
      trainingAgeMonths: 3,
      ...overrides,
    },
    goal: {
      type: 'RECOMP',
      desiredWeeklyRatePct: 0,
    },
    schedule: {
      weeklyFrequency: 3,
      availableWeekdays: [1, 3, 5],
      sessionDurationMin: 60,
      equipmentTypes: ['BARBELL', 'BODYWEIGHT'],
      recentMainLifts: [{ catalogKey: 'bench_press', weightKg: 60, reps: 8, rir: 2 }],
    },
    lifestyle: {
      activityLevel: 'MODERATE',
      currentModerateActivityMin: 120,
      habitualSleepMin: 420,
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
  } as AssessmentInput);
}

function content(overrides: Partial<AssessmentInput['profile']> = {}): FitnessPlanContent {
  const value = assessment(overrides);
  const eligibility = evaluateEligibility(value, NOW);
  const loadGuidance = STRENGTH_EXERCISE_CATALOG.map((entry) =>
    entry.key === 'bench_press'
      ? { catalogKey: entry.key, source: 'APP_HISTORY' as const, initialLoadKg: 60 }
      : { catalogKey: entry.key, source: 'CALIBRATION' as const, initialLoadKg: null },
  );
  return buildBaselinePlan({
    assessment: value,
    eligibility,
    gymConstraints: { unavailableExerciseNames: [] },
    loadGuidance,
    now: NOW,
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function mockPlan(plan: Record<string, unknown>, activationRevision = 0) {
  return jsonResponse(200, { plan, activationRevision });
}

beforeEach(() => {
  push.mockReset();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PlanPreview', () => {
  it('reserves the layout while loading', () => {
    vi.mocked(fetch).mockReturnValue(new Promise(() => {}));
    render(<PlanPreview planId="plan-1" />);
    expect(screen.getByTestId('plan-preview-loading')).toBeInTheDocument();
  });

  it('renders the schedule, nutrition, cardio, sleep and rationale in Chinese', async () => {
    const planContent = content();
    vi.mocked(fetch).mockResolvedValue(
      mockPlan({
        id: 'plan-1',
        version: 1,
        status: 'DRAFT',
        content: planContent,
        comparison: null,
      }),
    );
    render(<PlanPreview planId="plan-1" />);

    expect(await screen.findByRole('heading', { name: '你的基础方案' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '一周安排' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '饮食' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '睡眠' })).toBeInTheDocument();
    // Localized rationale, never a raw reason code.
    expect(screen.getByText('为什么这样安排')).toBeInTheDocument();
    expect(screen.queryByText('ELIGIBLE_GENERAL_POPULATION')).not.toBeInTheDocument();
    // Chinese exercise names, not the English catalog identity.
    expect(screen.queryByText('Bench Press')).not.toBeInTheDocument();
    expect(screen.getAllByText(/卧推/).length).toBeGreaterThan(0);
    // Talk test wording travels with the cardio section.
    expect(screen.getByText(/能完整说出一句短句/)).toBeInTheDocument();
  });

  it('shows app history in kilograms and a calibration note without a fabricated load', async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockPlan({
        id: 'plan-1',
        version: 1,
        status: 'DRAFT',
        content: content(),
        comparison: null,
      }),
    );
    render(<PlanPreview planId="plan-1" />);

    expect(await screen.findByText(/60 kg · 来自你的训练记录/)).toBeInTheDocument();
    expect(screen.getAllByText(/先用一组刻意偏轻的校准组/).length).toBeGreaterThan(0);
  });

  it('explains the two-week intro for a novice and omits it otherwise', async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockPlan({
        id: 'plan-1',
        version: 1,
        status: 'DRAFT',
        content: content(),
        comparison: null,
      }),
    );
    const { unmount } = render(<PlanPreview planId="plan-1" />);
    expect(await screen.findByText(/前两周为 RIR 3/)).toBeInTheDocument();
    unmount();

    vi.mocked(fetch).mockResolvedValue(
      mockPlan({
        id: 'plan-2',
        version: 1,
        status: 'DRAFT',
        content: content({ trainingAgeMonths: 24 }),
        comparison: null,
      }),
    );
    render(<PlanPreview planId="plan-2" />);
    await screen.findByRole('heading', { name: '你的基础方案' });
    expect(screen.queryByText(/前两周为 RIR 3/)).not.toBeInTheDocument();
  });

  it('renders a single value for equal endpoints and a range with the explanation otherwise', async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockPlan({
        id: 'plan-1',
        version: 1,
        status: 'DRAFT',
        content: content(),
        comparison: null,
      }),
    );
    const { unmount } = render(<PlanPreview planId="plan-1" />);
    // Look for the daily line specifically: the per-meal lines carry "千卡" too,
    // so a bare /千卡/ match is no longer unique.
    const calorieLines = await screen.findAllByText(/千卡/);
    expect(
      calorieLines.some((node) => /^每天 .*千卡$/.test(node.textContent ?? '')),
    ).toBe(true);
    expect(screen.getByText(/按两种公式的区间显示/)).toBeInTheDocument();
    unmount();

    vi.mocked(fetch).mockResolvedValue(
      mockPlan({
        id: 'plan-3',
        version: 1,
        status: 'DRAFT',
        content: content({ energyEquationReference: 'FEMALE' }),
        comparison: null,
      }),
    );
    render(<PlanPreview planId="plan-3" />);
    await screen.findByRole('heading', { name: '你的基础方案' });
    expect(screen.queryByText(/按两种公式的区间显示/)).not.toBeInTheDocument();
  });

  it('shows only changed headline metrics for a replacement preview', async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockPlan(
        {
          id: 'plan-2',
          version: 2,
          status: 'DRAFT',
          content: content(),
          comparison: {
            previousPlanId: 'plan-1',
            changes: [{ metric: 'CARDIO_MINUTES', before: 30, after: 40 }],
          },
        },
        1,
      ),
    );
    render(<PlanPreview planId="plan-2" />);

    expect(await screen.findByText('变化内容')).toBeInTheDocument();
    expect(screen.getByText('每周有氧')).toBeInTheDocument();
    expect(screen.getByText('30 → 40')).toBeInTheDocument();
  });

  it('renders no diff section for an initial preview', async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockPlan({
        id: 'plan-1',
        version: 1,
        status: 'DRAFT',
        content: content(),
        comparison: null,
      }),
    );
    render(<PlanPreview planId="plan-1" />);

    await screen.findByRole('heading', { name: '你的基础方案' });
    expect(screen.queryByText('变化内容')).not.toBeInTheDocument();
  });

  it('sends the current activation revision exactly once while pending', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    let resolveActivation: (value: Response) => void = () => {};
    fetchMock
      .mockResolvedValueOnce(
        mockPlan(
          {
            id: 'plan-1',
            version: 1,
            status: 'DRAFT',
            content: content(),
            comparison: null,
          },
          4,
        ),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveActivation = resolve;
          }),
      );
    render(<PlanPreview planId="plan-1" />);

    const confirm = await screen.findByRole('button', { name: /使用这份方案/ });
    await user.click(confirm);
    await user.click(confirm);
    await user.click(confirm);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, init] = fetchMock.mock.calls[1]!;
    expect(JSON.parse(init!.body as string)).toEqual({ expectedRevision: 4 });

    resolveActivation(
      jsonResponse(200, { planId: 'plan-1', programId: 'program-9', activationRevision: 5 }),
    );
    await waitFor(() => expect(push).toHaveBeenCalledWith('/programs/program-9'));
  });

  it('refreshes and asks for a fresh confirmation on a revision conflict', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(
        mockPlan({
          id: 'plan-1',
          version: 1,
          status: 'DRAFT',
          content: content(),
          comparison: null,
        }),
      )
      .mockResolvedValueOnce(jsonResponse(409, { error: 'ACTIVATION_REVISION_CONFLICT' }))
      .mockResolvedValueOnce(
        mockPlan(
          {
            id: 'plan-1',
            version: 1,
            status: 'DRAFT',
            content: content(),
            comparison: null,
          },
          2,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { planId: 'plan-1', programId: 'program-7', activationRevision: 3 }),
      );
    render(<PlanPreview planId="plan-1" />);

    await user.click(await screen.findByRole('button', { name: /使用这份方案/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/刷新后再确认/);
    // The refreshed revision is what the next confirmation would send.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await user.click(screen.getByRole('button', { name: /使用这份方案/ }));
    expect(JSON.parse(fetchMock.mock.calls[3]![1]!.body as string)).toEqual({
      expectedRevision: 2,
    });
    await waitFor(() => expect(push).toHaveBeenCalledWith('/programs/program-7'));
  });

  it('routes back to setup when the assessment went stale', async () => {
    const user = userEvent.setup();
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        mockPlan({
          id: 'plan-1',
          version: 1,
          status: 'DRAFT',
          content: content(),
          comparison: null,
        }),
      )
      .mockResolvedValueOnce(jsonResponse(409, { error: 'PLAN_INPUT_STALE' }));
    render(<PlanPreview planId="plan-1" />);

    await user.click(await screen.findByRole('button', { name: /使用这份方案/ }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/fitness/setup'));
  });

  it('keeps a superseded version readable but without an enabled confirm', async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockPlan({
        id: 'plan-1',
        version: 1,
        status: 'SUPERSEDED',
        content: content(),
        comparison: null,
      }),
    );
    render(<PlanPreview planId="plan-1" />);

    await screen.findByRole('heading', { name: '你的基础方案' });
    expect(screen.getByText('已替换')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /使用这份方案/ })).not.toBeInTheDocument();
    expect(screen.getAllByText('该版本仅供查看。').length).toBeGreaterThan(0);
  });

  it('links Edit Assessment to setup without touching the draft', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      mockPlan({
        id: 'plan-1',
        version: 1,
        status: 'DRAFT',
        content: content(),
        comparison: null,
      }),
    );
    render(<PlanPreview planId="plan-1" />);

    const edit = await screen.findByRole('link', { name: '修改评估' });
    expect(edit).toHaveAttribute('href', '/fitness/setup');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('PlanHistory', () => {
  it('lists versions newest first with status, date and goal', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(200, {
        plans: [
          {
            id: 'plan-2',
            version: 2,
            status: 'ACTIVE',
            goal: { type: 'RECOMP', desiredWeeklyRatePct: 0 },
            createdAt: '2026-09-16T12:00:00.000Z',
            activatedAt: '2026-09-16T12:05:00.000Z',
            programId: 'program-1',
          },
          {
            id: 'plan-1',
            version: 1,
            status: 'SUPERSEDED',
            goal: { type: 'FAT_LOSS', desiredWeeklyRatePct: -0.4 },
            createdAt: '2026-09-01T12:00:00.000Z',
            activatedAt: null,
            programId: null,
          },
        ],
      }),
    );
    render(<PlanHistory />);

    const items = await screen.findAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText('v2')).toBeInTheDocument();
    expect(within(items[0]!).getByText('使用中')).toBeInTheDocument();
    expect(within(items[0]!).getByText('增肌减脂同步')).toBeInTheDocument();
    expect(within(items[0]!).getByRole('link')).toHaveAttribute(
      'href',
      '/fitness/plans/plan-2/preview',
    );
    expect(within(items[1]!).getByText('已替换')).toBeInTheDocument();

    // The history never carries screening answers or the stored input snapshot.
    expect(document.body.textContent).not.toContain('attested');
    expect(document.body.textContent).not.toContain('clearanceRestrictions');
  });

  it('shows an empty state when no plan exists', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { plans: [] }));
    render(<PlanHistory />);
    expect(await screen.findByText('还没有个性化方案。')).toBeInTheDocument();
  });
});
