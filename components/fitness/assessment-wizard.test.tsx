import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// The wizard renders Chinese copy for the new flow, so this suite swaps the
// shared English translator for the Simplified Chinese bundle.
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

import { AssessmentWizard, type AssessmentWizardProps } from './assessment-wizard';

type SavedAssessment = NonNullable<AssessmentWizardProps['savedAssessment']>;

const savedAssessment: SavedAssessment = {
  profile: {
    ageYears: 30,
    displaySex: 'FEMALE',
    energyEquationReference: 'FEMALE',
    heightCm: 170,
    weightKg: 70,
    waistCm: 81,
    bodyFatPct: null,
    trainingAgeMonths: 18,
  },
  goal: {
    type: 'RECOMP',
    desiredWeeklyRatePct: 0,
    targetWeightKg: null,
    targetDate: null,
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
    avgDailySteps: 9000,
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
    clearance: null,
    attested: true,
  },
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const eligibleAssessmentResponse = {
  assessment: {
    eligibility: { status: 'ELIGIBLE', reasonCodes: ['ELIGIBLE_GENERAL_POPULATION'] },
  },
};

function renderWizard(overrides: Partial<AssessmentWizardProps> = {}) {
  return render(
    <AssessmentWizard savedAssessment={null} unit="KG" onboardingRequired={false} {...overrides} />,
  );
}

// The saved assessment is already valid, so the four Continue clicks walk the
// wizard to the health step without touching any field.
async function advanceToHealth(user: ReturnType<typeof userEvent.setup>) {
  for (let step = 0; step < 4; step += 1) {
    await user.click(screen.getByRole('button', { name: '下一步' }));
  }
}

beforeEach(() => {
  push.mockReset();
  vi.stubGlobal('fetch', vi.fn());
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AssessmentWizard first run', () => {
  it('offers the deferral command only for required onboarding', async () => {
    renderWizard({ onboardingRequired: true });
    expect(screen.getByRole('button', { name: '稍后设置' })).toBeInTheDocument();
  });

  it('hides the deferral command for voluntary setup and for editing', () => {
    renderWizard({ onboardingRequired: false });
    expect(screen.queryByRole('button', { name: '稍后设置' })).not.toBeInTheDocument();
  });

  it('calls the skip endpoint, returns to the conversation and posts no assessment', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(jsonResponse(204, null));
    renderWizard({ onboardingRequired: true });

    await user.click(screen.getByRole('button', { name: '稍后设置' }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/chat'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/fitness/onboarding/skip');
  });
});

describe('AssessmentWizard saved assessment', () => {
  it('pre-fills a saved assessment and starts at step one', () => {
    renderWizard({ savedAssessment, onboardingRequired: false });

    expect(screen.getByRole('heading', { name: '身体情况' })).toBeInTheDocument();
    expect(screen.getByLabelText(/年龄/)).toHaveValue('30');
    expect(screen.getByLabelText(/身高/)).toHaveValue('170');
    expect(screen.getByRole('button', { name: '上一步' })).toBeDisabled();
  });

  it('renders five stable progress segments with aria-current on the active one', async () => {
    const user = userEvent.setup();
    renderWizard({ savedAssessment, onboardingRequired: false });

    expect(screen.getAllByTestId(/step-segment-/)).toHaveLength(5);
    expect(screen.getByTestId('step-segment-0')).toHaveAttribute('aria-current', 'step');

    await user.click(screen.getByRole('button', { name: '下一步' }));
    expect(screen.getByTestId('step-segment-1')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByTestId('step-segment-0')).not.toHaveAttribute('aria-current');
  });

  it('keeps input when navigating back', async () => {
    const user = userEvent.setup();
    renderWizard({ savedAssessment, onboardingRequired: false });
    const age = screen.getByLabelText(/年龄/);
    await user.clear(age);
    await user.type(age, '41');
    await user.click(screen.getByRole('button', { name: '下一步' }));

    await user.click(screen.getByRole('button', { name: '上一步' }));
    expect(screen.getByLabelText(/年龄/)).toHaveValue('41');
  });

  it('does not advance past an invalid step and focuses the first invalid control', async () => {
    const user = userEvent.setup();
    renderWizard({ savedAssessment, onboardingRequired: false });
    const age = screen.getByLabelText(/年龄/);
    await user.clear(age);
    await user.type(age, '999');

    await user.click(screen.getByRole('button', { name: '下一步' }));

    expect(screen.getByRole('heading', { name: '身体情况' })).toBeInTheDocument();
    expect(age).toHaveAttribute('aria-invalid', 'true');
    expect(age).toHaveFocus();
    const describedBy = age.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent('不能大于 120');
  });

  it('does not submit on Enter before the final step', async () => {
    const user = userEvent.setup();
    renderWizard({ savedAssessment, onboardingRequired: false });

    await user.type(screen.getByLabelText(/年龄/), '{Enter}');

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe('AssessmentWizard health step', () => {
  it('shows only the four group questions until one is answered yes', async () => {
    const user = userEvent.setup();
    renderWizard({ savedAssessment, onboardingRequired: false });
    await advanceToHealth(user);

    expect(screen.getByText('现在是否有以下情况？')).toBeInTheDocument();
    expect(screen.getByText('医生是否告知过你有以下情况？')).toBeInTheDocument();
    expect(screen.getByText('是否有临时情况？')).toBeInTheDocument();
    expect(screen.getByText('是否有以下情况？')).toBeInTheDocument();
    expect(screen.queryByLabelText('发热或急性感染')).not.toBeInTheDocument();
  });

  it('reveals only the selected group drill-down and the clearance fields', async () => {
    const user = userEvent.setup();
    renderWizard({ savedAssessment, onboardingRequired: false });
    await advanceToHealth(user);

    const temporaryGroup = screen.getByText('是否有临时情况？').closest('fieldset')!;
    await user.click(within(temporaryGroup).getAllByRole('button')[0]!);
    expect(screen.getByLabelText('发热或急性感染')).toBeInTheDocument();
    expect(screen.queryByLabelText('心脏或血管疾病')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('医生许可')).not.toBeInTheDocument();

    const clearanceGroup = screen.getByText('医生是否告知过你有以下情况？').closest('fieldset')!;
    await user.click(within(clearanceGroup).getAllByRole('button')[0]!);
    expect(screen.getByLabelText('心脏或血管疾病')).toBeInTheDocument();
    expect(screen.getByLabelText('许可日期')).toBeInTheDocument();
  });

  it('toggles a drill-down checkbox with a click', async () => {
    const user = userEvent.setup();
    renderWizard({ savedAssessment, onboardingRequired: false });
    await advanceToHealth(user);

    const temporaryGroup = screen.getByText('是否有临时情况？').closest('fieldset')!;
    await user.click(within(temporaryGroup).getAllByRole('button')[0]!);
    const option = screen.getByLabelText('发热或急性感染') as HTMLInputElement;
    await user.click(option);
    expect(option).toBeChecked();
  });

  it('shows the clearance fields when the saved assessment already had one', async () => {
    renderWizard({
      savedAssessment: {
        ...savedAssessment,
        health: {
          ...savedAssessment.health,
          clearance: { date: '2026-01-05', unrestricted: true, restrictions: null },
        },
      },
      onboardingRequired: false,
    });

    const user = userEvent.setup();
    await advanceToHealth(user);
    expect(screen.getByText('现在是否有以下情况？')).toBeInTheDocument();
    expect(screen.getByLabelText('许可日期')).toHaveValue('2026-01-05');
  });
});

describe('AssessmentWizard submission', () => {
  it('sends one payload, previews when eligible, and navigates to the preview', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, eligibleAssessmentResponse))
      .mockResolvedValueOnce(jsonResponse(201, { plan: { id: 'plan-1' } }));
    renderWizard({ savedAssessment, onboardingRequired: false });
    await advanceToHealth(user);
    await user.click(screen.getByRole('button', { name: '生成方案' }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/fitness/plans/plan-1/preview'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/fitness/assessment');
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/fitness/plans/preview');
    // The payload is canonical kilograms, whatever unit the user typed.
    const payload = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(payload.profile.weightKg).toBe(70);
    expect(payload.lifestyle.habitualSleepMin).toBe(480);
    expect(payload.health.attested).toBe(true);
  });

  it.each([
    ['TEMPORARY_HOLD', '暂时先搁置'],
    ['OUT_OF_SCOPE', '超出本应用的服务范围'],
    ['URGENT_ACTION', '请先就医'],
  ])('renders the %s action and never previews', async (status, action) => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        assessment: { eligibility: { status, reasonCodes: ['HOLD_ACUTE_ILLNESS'] } },
      }),
    );
    renderWizard({ savedAssessment, onboardingRequired: false });
    await advanceToHealth(user);

    await user.click(screen.getByRole('button', { name: '生成方案' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(action);
    expect(screen.getByText(/不构成医学诊断或治疗/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('explains an unsatisfiable session length without dropping the eligible assessment', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, eligibleAssessmentResponse))
      .mockResolvedValueOnce(
        jsonResponse(422, {
          error: 'SESSION_DURATION_UNSATISFIABLE',
          minimumDurationMin: 42,
        }),
      );
    renderWizard({ savedAssessment, onboardingRequired: false });
    await advanceToHealth(user);

    await user.click(screen.getByRole('button', { name: '生成方案' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('42');
    expect(alert).toHaveTextContent(/延长单次时长/);
    expect(push).not.toHaveBeenCalled();
  });

  it('suggests a qualified nutrition review instead of editing truthful inputs', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, eligibleAssessmentResponse))
      .mockResolvedValueOnce(jsonResponse(422, { error: 'NUTRITION_MINIMUM_UNSATISFIABLE' }));
    renderWizard({ savedAssessment, onboardingRequired: false });
    await advanceToHealth(user);

    await user.click(screen.getByRole('button', { name: '生成方案' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/专业营养师/);
    expect(alert).not.toHaveTextContent(/体重|腰围/);
  });

  it('preserves form state after an API failure and allows a retry', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(500, { error: 'Server error.' }))
      .mockResolvedValueOnce(jsonResponse(200, eligibleAssessmentResponse))
      .mockResolvedValueOnce(jsonResponse(201, { plan: { id: 'plan-2' } }));
    renderWizard({ savedAssessment, onboardingRequired: false });
    await advanceToHealth(user);

    await user.click(screen.getByRole('button', { name: '生成方案' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '生成方案' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/fitness/plans/plan-2/preview'));
  });
});

describe('AssessmentWizard units and independence', () => {
  it('converts pound input to canonical kilograms', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, eligibleAssessmentResponse))
      .mockResolvedValueOnce(jsonResponse(201, { plan: { id: 'plan-3' } }));
    renderWizard({
      savedAssessment: {
        ...savedAssessment,
        profile: { ...savedAssessment.profile, weightKg: 70 },
      },
      unit: 'LB',
      onboardingRequired: false,
    });
    await advanceToHealth(user);

    await user.click(screen.getByRole('button', { name: '生成方案' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const payload = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    // 70 kg is shown as ~154.3 lb and must round-trip back to 70 kg.
    expect(payload.profile.weightKg).toBeCloseTo(70, 1);
  });

  it('keeps sex and the energy equation independent', async () => {
    const user = userEvent.setup();
    renderWizard({ savedAssessment, onboardingRequired: false });

    await user.click(screen.getByRole('button', { name: '男' }));

    // Changing sex must not silently change the selected energy equation.
    const equation = screen.getByRole('button', { name: '女性公式' });
    expect(equation).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '男' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('explains the unspecified energy equation without blocking progress', async () => {
    const user = userEvent.setup();
    renderWizard({ savedAssessment, onboardingRequired: false });

    await user.click(screen.getByRole('button', { name: '未指定（按区间规划）' }));
    expect(screen.getByText(/按两种公式的区间显示/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '下一步' }));
    expect(screen.getByRole('heading', { name: '目标' })).toBeInTheDocument();
  });

  it('labels every icon-only control', async () => {
    const user = userEvent.setup();
    renderWizard({ savedAssessment, onboardingRequired: false });

    // The remove-lift command lives on the training step.
    await user.click(screen.getByRole('button', { name: '下一步' }));
    await user.click(screen.getByRole('button', { name: '下一步' }));
    expect(screen.getByRole('button', { name: '删除该动作' })).toBeInTheDocument();
  });

  it('keeps the recent-lift list an array while a row is edited', async () => {
    const user = userEvent.setup();
    renderWizard({ savedAssessment, onboardingRequired: false });
    // step 0 -> 1 -> 2
    await user.click(screen.getByRole('button', { name: '下一步' }));
    await user.click(screen.getByRole('button', { name: '下一步' }));

    const weight = screen.getByLabelText(/工作重量/);
    await user.clear(weight);
    await user.type(weight, '72.5');

    // Adding another row proves the list is still a real array after the edit.
    await user.click(screen.getByRole('button', { name: '添加动作' }));
    const weights = screen.getAllByLabelText(/工作重量/);
    expect(weights).toHaveLength(2);
    expect(weights[0]).toHaveValue('72.5');
    await user.type(weights[1]!, '40');
    await user.click(screen.getByRole('button', { name: '下一步' }));
    expect(screen.getByRole('heading', { name: '日常作息' })).toBeInTheDocument();
  });
});
