import { expect, type Page } from '@playwright/test';

// A brand-new account is redirected into the personalized assessment on its
// first dashboard load. Legacy-focused specs do not exercise that flow, so they
// defer it explicitly instead of asserting on the dashboard immediately.
//
// fitness-setup.spec.ts deliberately does NOT use this helper: verifying the
// redirect is part of what it tests.
export async function skipRequiredFitnessOnboarding(page: Page): Promise<void> {
  await expect(page).toHaveURL('/fitness/setup');
  await page.getByRole('button', { name: 'Set up later' }).click();
  // Navigate to the destination directly rather than through `/`: that route is
  // only a router for people, and depending on it made these specs race a
  // server redirect.
  await page.goto('/chat');
  await expect(page).toHaveURL('/chat');
}
