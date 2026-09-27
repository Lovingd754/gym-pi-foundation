import { test, expect, type Page } from '@playwright/test';
import { skipRequiredFitnessOnboarding } from './helpers/fitness-onboarding';

// The conversation is the product's main window. This spec walks a signed-in
// lifter through one full agent turn against the real Pi loop: the reply
// streams in, and the demo provider's scripted tool call renders as a tool
// card. The E2E server runs LLM_PROVIDER=demo, so no key is needed.

async function seedRunningSession(page: Page): Promise<string> {
  const exerciseRes = await page.request.post('/api/exercises', {
    data: { name: 'Chat Bench', muscleGroup: 'CHEST', category: 'COMPOUND' },
  });
  expect(exerciseRes.ok()).toBeTruthy();
  const exercise = await exerciseRes.json();

  const programRes = await page.request.post('/api/programs', {
    data: { name: 'E2E Chat Program', phase: 'Base' },
  });
  expect(programRes.ok()).toBeTruthy();
  const program = await programRes.json();

  const workoutRes = await page.request.post(`/api/programs/${program.id}/workouts`, {
    data: { name: 'Push day' },
  });
  expect(workoutRes.ok()).toBeTruthy();
  const workout = await workoutRes.json();

  const peRes = await page.request.post(`/api/workouts/${workout.id}/program-exercises`, {
    data: {
      exerciseId: exercise.id,
      targetSets: 3,
      targetRepsMin: 6,
      targetRepsMax: 10,
      targetRIR: 2,
      restSec: 90,
    },
  });
  expect(peRes.ok()).toBeTruthy();

  const sessionRes = await page.request.post('/api/sessions', {
    data: { workoutId: workout.id },
  });
  expect(sessionRes.ok()).toBeTruthy();
  const session = await sessionRes.json();
  return session.id as string;
}

test('a lifter gets a streamed, tool-backed answer in the chat', async ({ page }) => {
  // Sign up through the API (fresh user each run; the response cookie lands in
  // the shared browser context). A unique X-Forwarded-For keeps this spec in
  // its own register rate-limit bucket: the suite's parallel UI signups
  // already use up the 5/min per-IP budget, and this flow is not about signup.
  const registerRes = await page.request.post('/api/auth/register', {
    headers: { 'x-forwarded-for': '10.111.0.1' },
    data: {
      displayName: 'Chat E2E',
      email: `e2e-session-chat-${Date.now()}@test.dev`,
      password: 'supersecret',
    },
  });
  expect(registerRes.ok()).toBeTruthy();
  await page.goto('/');
  await skipRequiredFitnessOnboarding(page);

  const sessionId = await seedRunningSession(page);

  await page.goto(`/session/${sessionId}`);
  await expect(page.getByText('Chat Bench').first()).toBeVisible();
  // The runner no longer carries a chat entry point, so the chat is opened
  // directly - optionally with the live workout attached.
  await page.goto(`/chat?sessionId=${sessionId}`);

  // The chat opens with the live session attached and a fresh conversation.
  await expect(page).toHaveURL(new RegExp(`/chat\\?sessionId=${sessionId}`));
  await expect(page.getByRole('button', { name: 'New chat' })).toBeVisible();

  // One turn through the real agent loop: a scripted tool call, then a streamed
  // answer that quotes the tool result back.
  const composer = page.getByPlaceholder('Message the coach…');
  await composer.fill('What should I train today?');
  await composer.press('Enter');

  await expect(page.getByText('Done').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/演示模式/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/工具返回/)).toBeVisible();
});
