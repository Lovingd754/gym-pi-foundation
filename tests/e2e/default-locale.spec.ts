import { expect, test } from '@playwright/test';

// The rest of the suite pins itself to English; this spec is the one place that
// asserts the product's own default, so the two cannot drift apart silently.
test.use({ storageState: { cookies: [], origins: [] } });

test('a first-time visitor lands on the Chinese interface', async ({ page }) => {
  await page.goto('/login');

  await expect(page.getByText('登录', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('查看你的训练记录。')).toBeVisible();
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '切换语言' })).toBeVisible();
});
