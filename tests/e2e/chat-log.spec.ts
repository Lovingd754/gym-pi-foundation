import { expect, test } from '@playwright/test';

// A trainee describes a set in the chat. The agent prepares it, the trainee
// confirms, and only then does it reach their training history.
test.use({ extraHTTPHeaders: { 'x-forwarded-for': '10.111.1.41' } });

test('a set described in the chat is only logged after the trainee confirms it', async ({
  page,
}) => {
  const registerRes = await page.request.post('/api/auth/register', {
    data: {
      displayName: 'Chat Log E2E',
      email: `e2e-chat-log-${Date.now()}@test.dev`,
      password: 'supersecret',
    },
  });
  expect(registerRes.ok()).toBeTruthy();

  // The movement has to exist in the trainee's own catalog first: the agent
  // resolves against their exercises, it never invents one.
  const exerciseRes = await page.request.post('/api/exercises', {
    data: { name: '卧推', muscleGroup: 'CHEST', category: 'COMPOUND' },
  });
  expect(exerciseRes.ok()).toBeTruthy();

  await page.goto('/chat');
  const composer = page.getByPlaceholder('Message the coach…');
  await composer.fill('今天卧推 60 公斤 8 次 3 组');
  await composer.press('Enter');

  const card = page.getByTestId('log-proposal-card');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText('卧推');
  await expect(card).toContainText('60 kg');

  // Nothing has been written yet.
  const before = await page.request.get('/api/history/csv');
  expect(await before.text()).not.toContain('60');

  await page.getByRole('button', { name: 'Log it' }).click();
  await expect(card).toBeHidden({ timeout: 20_000 });

  // The confirmed set is now in the training history.
  const after = await page.request.get('/api/history/csv');
  expect(await after.text()).toContain('卧推');
});
