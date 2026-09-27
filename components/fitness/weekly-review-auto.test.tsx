import { render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WeeklyReviewAuto } from './weekly-review-auto';
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
afterEach(() => vi.unstubAllGlobals());
it('automatic review prepares a draft without activating it', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'DUE' }) })
    .mockResolvedValueOnce({ ok: true });
  vi.stubGlobal('fetch', fetcher);
  render(<WeeklyReviewAuto enabled />);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({ activate: false });
});
