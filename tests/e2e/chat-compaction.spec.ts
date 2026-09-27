import { expect, test } from '@playwright/test';

// Long-thread compaction, driven through the real UI. The demo provider
// answers the summarizer prompt with a digest, so this exercises the same path
// a hosted model takes: fold the old exchanges, keep the recent ones, and tell
// the trainee what happened.
test.use({ extraHTTPHeaders: { 'x-forwarded-for': '10.111.1.21' } });

// Compaction folds anything older than the newest 12 messages, and only once
// more than 30 are unfolded. One turn adds two messages, so the sixteenth turn
// is the first that can cross the threshold.
const TURNS_TO_TRIGGER = 16;

test('a long conversation is compacted without losing the transcript', async ({ page }) => {
  const registerRes = await page.request.post('/api/auth/register', {
    data: {
      displayName: 'Compaction E2E',
      email: `e2e-compact-${Date.now()}@test.dev`,
      password: 'supersecret',
    },
  });
  expect(registerRes.ok()).toBeTruthy();

  await page.goto('/chat');
  const composer = page.getByPlaceholder('Message the coach…');
  const messages = page.getByTestId('agent-message');

  for (let turn = 1; turn <= TURNS_TO_TRIGGER; turn += 1) {
    const before = await messages.count();
    await composer.fill(`Question ${turn}: what should I train today?`);
    await composer.press('Enter');
    // The send button turns into a stop button for the duration of the turn;
    // waiting for it to go away is what makes the next send land, and it is
    // also the honest way to wait for the whole turn (tool call included).
    await expect(page.getByTitle('Stop')).toBeHidden({ timeout: 20_000 });
    // Each turn appends the question and its answer.
    await expect(messages).toHaveCount(before + 2, { timeout: 20_000 });
  }

  // The trainee is told the older part of the thread is now a digest...
  await expect(page.getByTestId('agent-notice')).toContainText(
    'Earlier messages were summarized',
  );
  // ...while the transcript itself is untouched: the first question is still
  // there to scroll back to.
  await expect(messages.first()).toContainText('Question 1:');
});
