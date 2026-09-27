import { expect, test, type Page } from '@playwright/test';

// The other way to record: a few taps, no conversation, no workout in progress.
test.use({ extraHTTPHeaders: { 'x-forwarded-for': '10.111.1.51' } });

async function signUp(page: Page) {
  await page.goto('/signup');
  await page.getByLabel('Name').fill('Quick Log E2E');
  await page.getByLabel('Email').fill(`e2e-quick-log-${Date.now()}@test.dev`);
  await page.getByLabel('Password').fill('supersecret');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL('/fitness/setup');
}

test('a lifter can record a set in a few taps and see it in the history', async ({ page }) => {
  await signUp(page);
  const exerciseRes = await page.request.post('/api/exercises', {
    data: { name: 'Bench Press', muscleGroup: 'CHEST', category: 'COMPOUND' },
  });
  expect(exerciseRes.ok()).toBeTruthy();

  // Reachable from the chat, which is where a trainee would reach for either
  // way of recording something.
  await page.goto('/chat');
  await page.getByRole('link', { name: 'Quick log' }).click();
  await expect(page).toHaveURL('/log');

  // Nothing to show before anything is logged.
  await expect(page.getByText('Nothing logged today yet.')).toBeVisible();

  // The picker opens on the movements this account trains, so the library's
  // 130-odd movements are reached by search rather than by scrolling. `exact`
  // matters: the starter catalog also ships "Barbell bench press".
  await page.getByLabel('Search movements').fill('Bench Press');
  await page.getByRole('button', { name: 'Bench Press', exact: true }).click();
  await page.getByLabel('Weight (kg)').fill('60');
  await page.getByLabel('Reps').fill('8');
  await page.getByLabel('Sets').fill('3');
  await page.getByRole('button', { name: 'Log it' }).click();

  // The form shows its own result instead of sending the trainee to history.
  await expect(page.getByRole('button', { name: 'Delete this set' })).toHaveCount(3);

  const csv = await page.request.get('/api/history/csv');
  expect(await csv.text()).toContain('Bench Press');
});
