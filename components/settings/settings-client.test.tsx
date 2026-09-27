import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsClient } from './settings-client';

const { setTheme } = vi.hoisted(() => ({ setTheme: vi.fn() }));

vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'dark', setTheme }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

// The screen keeps only what a trainee changes here: the interface language and
// the appearance. The session preferences, the plate calculator and the data
// tools that used to sit below them are gone.
describe('SettingsClient', () => {
  it('offers the appearance choice and applies it', async () => {
    const user = userEvent.setup();
    render(<SettingsClient />);

    const light = await screen.findByRole('button', { name: /light/i });
    await user.click(light);

    expect(setTheme).toHaveBeenCalledWith('light');
  });

  it('marks the appearance that is currently in effect', async () => {
    render(<SettingsClient />);

    const dark = await screen.findByRole('button', { name: /dark/i });
    // Only the client knows the stored theme, so the selection appears after
    // mount rather than in the server render.
    expect(dark).toHaveAttribute('aria-pressed', 'true');
  });
});
