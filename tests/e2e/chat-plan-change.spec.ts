import { expect, test, type Page } from '@playwright/test';

// The agent proposes a change, the trainee confirms it, and the plan actually
// moves to a new version. Nothing about the plan is written before that click.
test.use({ extraHTTPHeaders: { 'x-forwarded-for': '10.111.1.31' } });

async function signUpAndBuildPlan(page: Page) {
  await page.goto('/signup');
  await page.getByLabel('Name').fill('Plan Change E2E');
  await page.getByLabel('Email').fill(`e2e-plan-change-${Date.now()}@test.dev`);
  await page.getByLabel('Password').fill('supersecret');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL('/fitness/setup');

  // Anchored: "Change language" contains "age".
  await page.getByLabel(/^Age/).fill('30');
  await page.getByLabel(/^Height/).fill('170');
  await page.getByLabel(/^Weight/).fill('82');
  await page.getByLabel('Continuous training').fill('3');
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByRole('button', { name: 'Lose fat', exact: true }).click();
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByRole('button', { name: '3', exact: true }).click();
  await page.getByRole('button', { name: 'Dumbbells', exact: true }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByRole('checkbox', { name: /answered honestly/ }).click();
  await page.getByRole('button', { name: 'Generate plan' }).click();
  await expect(page).toHaveURL(/\/fitness\/plans\/.+\/preview$/);
  await page.getByRole('button', { name: /Use this plan/ }).click();
  await expect(page).toHaveURL(/\/programs\/.+/);
}

test('a proposed plan change only lands after the trainee confirms it', async ({ page }) => {
  await signUpAndBuildPlan(page);

  const before = (await (await page.request.get('/api/fitness/plans')).json()) as {
    plans: { version: number; status: string }[];
  };
  expect(before.plans.find((plan) => plan.status === 'ACTIVE')?.version).toBe(1);

  await page.goto('/chat');
  const composer = page.getByPlaceholder('Message the coach…');
  await composer.fill('My knee hates the squat, swap it for something else');
  await composer.press('Enter');

  // The card shows what would change, and the plan has not moved yet.
  const card = page.getByTestId('plan-change-card');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Apply change' })).toBeVisible();
  const pending = (await (await page.request.get('/api/fitness/plans')).json()) as {
    plans: { version: number; status: string }[];
  };
  expect(pending.plans.filter((plan) => plan.status === 'ACTIVE')).toHaveLength(1);
  expect(pending.plans.find((plan) => plan.status === 'ACTIVE')?.version).toBe(1);

  await page.getByRole('button', { name: 'Apply change' }).click();

  await expect(card).toBeHidden({ timeout: 20_000 });
  const after = (await (await page.request.get('/api/fitness/plans')).json()) as {
    plans: { version: number; status: string }[];
  };
  expect(after.plans.find((plan) => plan.status === 'ACTIVE')?.version).toBe(2);
  // The plan the trainee confirmed is kept, not overwritten.
  expect(after.plans.find((plan) => plan.version === 1)?.status).toBe('SUPERSEDED');
});
