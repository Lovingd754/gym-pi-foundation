import { test, expect, type Page } from '@playwright/test';

// The complete personalized slice: signup -> assessment -> preview -> one
// explicit confirmation -> managed Program -> execution -> replacement.
// Dedicated client IP so UI signups stay out of the shared rate-limit bucket.
test.use({ extraHTTPHeaders: { 'x-forwarded-for': '10.111.1.9' } });

async function signUp(page: Page, prefix: string) {
  await page.goto('/signup');
  await page.getByLabel('Name').fill('Fitness E2E');
  await page.getByLabel('Email').fill(`e2e-${prefix}-${Date.now()}@test.dev`);
  await page.getByLabel('Password').fill('supersecret');
  await page.getByRole('button', { name: 'Create account' }).click();
}

async function switchToChinese(page: Page) {
  await page.getByRole('button', { name: 'Change language' }).click();
  await page.getByRole('menuitem', { name: 'Simplified Chinese' }).click();
  await expect(page.getByRole('button', { name: '切换语言' })).toBeVisible();
}

// Walks the five steps of the assessment with an eligible fat-loss profile.
async function completeAssessment(page: Page, opts: { frequency?: 3 | 4 } = {}) {
  await page.getByLabel('年龄').fill('30');
  await page.getByLabel('身高').fill('170');
  await page.getByLabel(/^体重/).fill('82');
  await page.getByLabel('连续训练时长').fill('3');
  await page.getByRole('button', { name: '下一步' }).click();

  // `exact` matters: "增肌减脂同步" contains "减脂" as a substring.
  await page.getByRole('button', { name: '减脂', exact: true }).click();
  await page.getByRole('button', { name: '下一步' }).click();

  await page.getByRole('button', { name: String(opts.frequency ?? 3), exact: true }).click();
  await page.getByRole('button', { name: '哑铃', exact: true }).click();
  await page.getByRole('button', { name: '下一步' }).click();

  // Leave the list empty: the preview must say "calibration", not invent a load.
  await page.getByRole('button', { name: '下一步' }).click();

  await page.getByRole('checkbox', { name: /我如实作答/ }).click();
  await page.getByRole('button', { name: '生成方案' }).click();
}

test('a new lifter gets a personalized plan and trains it', async ({ page }) => {
  await signUp(page, 'fitness');

  // 1. The first dashboard load lands in setup, and the flow is Chinese.
  await expect(page).toHaveURL('/fitness/setup');
  await switchToChinese(page);

  // 2. Eligible fat-loss assessment.
  await completeAssessment(page);

  // 3. Preview: a calorie range, three strength days, two cardio sessions,
  //    a two-week sleep target and a calibration note instead of a load.
  await expect(page).toHaveURL(/\/fitness\/plans\/.+\/preview$/);
  await expect(page.getByRole('heading', { name: '你的基础方案' })).toBeVisible();
  await expect(page.getByText(/每天 \d+–\d+ 千卡/)).toBeVisible();
  await expect(page.getByText(/每周 3 天/)).toBeVisible();
  await expect(page.getByText(/每周额外 \d+ 分钟/)).toBeVisible();
  await expect(page.getByText(/校准/).first()).toBeVisible();

  // 4. Leaving the preview and re-submitting the same answers must reuse the
  //    same draft (saving is append-only, so screening/goal rows change identity
  //    even when nothing the plan depends on changed).
  const previewUrl = page.url();
  await page.goto('/fitness/setup');
  for (let step = 0; step < 4; step += 1) {
    await page.getByRole('button', { name: '下一步' }).click();
  }
  await page.getByRole('button', { name: '生成方案' }).click();
  await expect(page).toHaveURL(previewUrl);

  // 5. One explicit confirmation activates a managed Program.
  await page.getByRole('button', { name: /使用这份方案/ }).click();
  await expect(page).toHaveURL(/\/programs\/.+/, { timeout: 30_000 });
  await expect(page.getByText(/个性化方案 v\d+/)).toBeVisible();
  // The landing screen is the lean read-only one: today, the week, and one way
  // in - not the generic program editor.
  await expect(page.getByRole('heading', { name: '今天' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '一周安排' })).toBeVisible();
  expect(await page.getByText('周一').count()).toBeGreaterThan(0);
  // The plan screen shows the whole prescription, not only the workouts: the
  // food used to be visible in the preview and then vanish once the plan was
  // in use, which is exactly where a trainee looks for it.
  await expect(page.getByRole('heading', { name: '饮食' })).toBeVisible();
  await expect(page.getByText(/每天 \d+–\d+ 千卡/)).toBeVisible();
  await expect(page.getByText(/蛋白质 \d+/)).toBeVisible();
  await expect(page.getByText(/一天怎么分到每餐/)).toBeVisible();
  await expect(page.getByRole('heading', { name: '睡眠' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '每周复评' })).toBeVisible();
  // Structure commands are gone for a managed program.
  await expect(page.getByRole('button', { name: 'Add a session' })).toHaveCount(0);

  // The shell has no dashboard any more: `/` sends a signed-in trainee to the
  // conversation, and the active plan is one navigation away.
  await page.goto('/');
  await expect(page).toHaveURL('/chat');
  await page.goto('/programs');
  await expect(page.getByRole('link', { name: /个性化方案/ }).first()).toBeVisible();
});

test('a lifter can replace their plan and keeps the previous one', async ({ page }) => {
  await signUp(page, 'fitness-replace');
  await expect(page).toHaveURL('/fitness/setup');
  await switchToChinese(page);
  await completeAssessment(page);
  await page.getByRole('button', { name: /使用这份方案/ }).click();
  await expect(page).toHaveURL(/\/programs\/.+/);
  const firstProgramUrl = page.url();

  // Reopen setup, change the frequency, and generate a replacement.
  await page.goto('/fitness/setup');
  await expect(page.getByLabel('年龄')).toHaveValue('30');
  // Move to the lifestyle step, where trimming weekly moderate activity changes
  // the headline cardio metric.
  for (let step = 0; step < 3; step += 1) {
    await page.getByRole('button', { name: '下一步' }).click();
  }
  await page.getByLabel(/每周中等强度活动/).fill('30');
  await page.getByRole('button', { name: '下一步' }).click();
  await page.getByRole('button', { name: '生成方案' }).click();
  // Wait for the navigation before reading the URL.
  await expect(page).toHaveURL(/\/fitness\/plans\/.+\/preview$/);
  const replacementPreviewUrl = page.url();

  // The replacement preview names the changed headline metrics...
  await expect(page.getByText('变化内容')).toBeVisible();
  await expect(page.getByText('每周有氧')).toBeVisible();
  // ...and the previous Program is still the active one until confirmation.
  // An activated personalized plan lands on the lean read-only screen, which
  // has no activate/deactivate badge, so the guarantee is read from the API.
  const programId = firstProgramUrl.split('/').pop();
  const programRes = await page.request.get(`/api/programs/${programId}`);
  expect(programRes.ok()).toBeTruthy();
  expect((await programRes.json()).isActive).toBe(true);

  // Re-open the preview by URL so the confirm always reads the current revision
  // instead of a restored snapshot.
  await page.goto(replacementPreviewUrl);
  await page.getByRole('button', { name: /使用这份方案/ }).click();
  await expect(page).toHaveURL(/\/programs\/.+/);

  // History keeps the superseded version reachable and read-only.
  await page.goto('/fitness/plans');
  await expect(page.getByText('v1')).toBeVisible();
  await expect(page.getByText('v2')).toBeVisible();
  await expect(page.getByText('已替换')).toBeVisible();
});

test('an urgent screening answer blocks planning entirely', async ({ page }) => {
  await signUp(page, 'fitness-urgent');
  await expect(page).toHaveURL('/fitness/setup');
  await switchToChinese(page);

  let previewCalls = 0;
  page.on('request', (request) => {
    if (request.url().includes('/api/fitness/plans/preview')) previewCalls += 1;
  });

  // Walk to the health step without submitting, then answer the urgent group.
  await page.getByLabel('年龄').fill('30');
  await page.getByLabel('身高').fill('170');
  await page.getByLabel(/^体重/).fill('82');
  await page.getByLabel('连续训练时长').fill('3');
  for (let step = 0; step < 4; step += 1) {
    await page.getByRole('button', { name: '下一步' }).click();
  }
  const urgentGroup = page.locator('fieldset', { hasText: '现在是否有以下情况？' });
  await urgentGroup.getByRole('button').first().click();
  await page.getByLabel('胸口压迫感或疼痛').check();
  await page.getByRole('checkbox', { name: /我如实作答/ }).click();
  await page.getByRole('button', { name: '生成方案' }).click();

  // Next.js injects its own role="alert" route announcer, so match the content.
  await expect(page.getByRole('alert').filter({ hasText: '请先就医' })).toBeVisible();
  await expect(page.getByText(/不构成医学诊断或治疗/)).toBeVisible();
  expect(previewCalls).toBe(0);
});

test('every step and preview section fits a 360px viewport', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await signUp(page, 'fitness-mobile');
  await expect(page).toHaveURL('/fitness/setup');
  await switchToChinese(page);

  const noOverflow = async () => {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  };

  await noOverflow();
  await page.getByLabel('年龄').fill('30');
  await page.getByLabel('身高').fill('170');
  await page.getByLabel(/^体重/).fill('82');
  await page.getByLabel('连续训练时长').fill('3');
  await noOverflow();
  for (let step = 0; step < 4; step += 1) {
    await page.getByRole('button', { name: '下一步' }).click();
    await noOverflow();
  }
  await page.getByRole('checkbox', { name: /我如实作答/ }).click();
  await page.getByRole('button', { name: '生成方案' }).click();
  await expect(page).toHaveURL(/\/fitness\/plans\/.+\/preview$/);
  await expect(page.getByRole('heading', { name: '你的基础方案' })).toBeVisible();
  await noOverflow();
});
