import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WeeklyActivitiesEditor } from './weekly-activities-editor';

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
afterEach(() => vi.unstubAllGlobals());

it('saves current-week constraints before requesting a draft', async () => {
  const generate = vi.fn();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ weekStart: '2026-09-21', activities: [] }),
    })
    .mockResolvedValueOnce({ ok: true });
  vi.stubGlobal('fetch', fetcher);
  render(<WeeklyActivitiesEditor busy={false} onGenerate={generate} />);
  await screen.findByLabelText('assessment.weekdays.2 plan.review.activities.description');
  fireEvent.change(
    screen.getByLabelText('assessment.weekdays.2 plan.review.activities.description'),
    { target: { value: 'Business travel' } },
  );
  fireEvent.click(
    screen.getByLabelText('assessment.weekdays.2 plan.review.activities.unavailable'),
  );
  fireEvent.click(screen.getByRole('button', { name: 'plan.review.generate' }));
  await waitFor(() => expect(generate).toHaveBeenCalledOnce());
  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({
    weekStart: '2026-09-21',
    activities: [{ dayOfWeek: 2, description: 'Business travel', unavailable: true }],
  });
});

it('does not generate when saving constraints fails', async () => {
  const generate = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ weekStart: '2026-09-21', activities: [] }),
      })
      .mockResolvedValueOnce({ ok: false }),
  );
  render(<WeeklyActivitiesEditor busy={false} onGenerate={generate} />);
  await screen.findByLabelText('assessment.weekdays.2 plan.review.activities.description');
  fireEvent.click(screen.getByRole('button', { name: 'plan.review.generate' }));
  await screen.findByRole('alert');
  expect(generate).not.toHaveBeenCalled();
});
