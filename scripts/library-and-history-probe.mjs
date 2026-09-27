// Manual probe for the expanded exercise library and the history list: drives
// the running dev server in a real browser, in the default (Chinese) locale,
// and prints what the screen actually shows. Not part of the test suite.
import { chromium } from 'playwright';

const BASE = process.env.CHECK_BASE ?? 'http://localhost:3030';
const stamp = Date.now();
const email = `probe-library-${stamp}@test.dev`;

const browser = await chromium.launch({ channel: 'msedge' });
// A per-probe IP keeps this out of the real per-IP registration bucket that the
// e2e suite also charges.
const page = await browser.newPage({
  viewport: { width: 420, height: 900 },
  extraHTTPHeaders: { 'x-forwarded-for': '10.231.4.17' },
});
const problems = [];
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(`console: ${message.text().slice(0, 300)}`);
});
page.on('pageerror', (error) => problems.push(`pageerror: ${String(error).slice(0, 300)}`));

async function body() {
  return (await page.locator('body').innerText()).replace(/\s+/g, ' ');
}

try {
  await page.goto(`${BASE}/signup`, { waitUntil: 'domcontentloaded' });
  // The form is client-side; filling it before hydration falls back to a native
  // submit that just reloads /signup.
  await page.getByRole('button', { name: /创建账号|Create account/ }).waitFor();
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.getByLabel(/姓名|Name/).fill('动作库检查');
  await page.getByLabel(/邮箱|Email/).fill(email);
  await page.getByLabel(/^密码|^Password/).fill('supersecret');
  await page.getByRole('button', { name: /创建账号|Create account/ }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/signup'), { timeout: 40_000 });

  // ---------------------------------------------------------- quick log
  await page.goto(`${BASE}/log`, { waitUntil: 'networkidle' });
  console.log('[log] chips on open:', await page.locator('button[aria-pressed]').count());
  await page.getByLabel('搜索动作').fill('深蹲');
  await page.waitForTimeout(300);
  console.log(
    '[log] 深蹲 matches:',
    JSON.stringify(await page.locator('button[aria-pressed]').allInnerTexts()),
  );

  // A movement the library does not have: add it from here.
  await page.getByRole('button', { name: '新建动作' }).click();
  await page.getByRole('dialog').getByLabel('姓名').fill('我自己的壶铃摆动');
  await page.getByRole('dialog').getByRole('button', { name: '新建' }).click();
  await page.waitForTimeout(2500);
  await page.getByLabel('搜索动作').fill('壶铃');
  await page.waitForTimeout(400);
  console.log(
    '[log] after adding a custom movement:',
    JSON.stringify(await page.locator('button[aria-pressed]').allInnerTexts()),
  );

  // Log two movements so the history list has something to show.
  for (const [name, weight, reps, sets] of [
    ['深蹲', '80', '5', '3'],
    ['壶铃', '24', '12', '3'],
  ]) {
    await page.getByLabel('搜索动作').fill(name);
    await page.waitForTimeout(300);
    await page.locator('button[aria-pressed]').first().click();
    await page.getByLabel(/重量/).fill(weight);
    await page.getByLabel('次数').fill(reps);
    await page.getByLabel('组数').fill(sets);
    await page.getByRole('button', { name: '记录' }).click();
    await page.waitForTimeout(1200);
  }

  // ---------------------------------------------------------- library page
  await page.goto(`${BASE}/exercises`, { waitUntil: 'networkidle' });
  console.log('[library] header:', (await body()).slice(0, 120));
  await page.getByLabel('搜索动作').fill('划船');
  await page.waitForTimeout(400);
  const rows = await page.locator('p.line-clamp-2').allInnerTexts();
  console.log('[library] 划船 search:', JSON.stringify(rows));

  // ---------------------------------------------------------- history list
  await page.goto(`${BASE}/history`, { waitUntil: 'networkidle' });
  console.log('\n[history] visible text:\n  ' + (await body()).slice(0, 600));
  console.log(
    '[history] 分钟 appears:',
    (await body()).includes('分钟'),
    '| 组数 badge appears:',
    (await body()).includes('组 ·'),
  );
  await page.screenshot({ path: 'test-results/history-list.png', fullPage: true });
  console.log('[history] screenshot: test-results/history-list.png');
} catch (error) {
  problems.push(`script: ${error instanceof Error ? error.message : String(error)}`);
  await page.screenshot({ path: 'test-results/library-probe-failure.png' }).catch(() => {});
} finally {
  console.log('\n=== problems ===');
  console.log(problems.length ? problems.join('\n') : '(none)');
  await browser.close();
}
