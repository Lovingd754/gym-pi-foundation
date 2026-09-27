// Manual usability probe: drives the running dev server in a real browser the
// way a person would, in the default (Chinese) locale, and reports what the
// screen actually shows. Not part of the test suite.
import { chromium } from 'playwright';

const BASE = process.env.CHECK_BASE ?? 'http://localhost:3030';
const stamp = Date.now();
const email = `probe-${stamp}@test.dev`;

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage();
const problems = [];
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(`console: ${message.text().slice(0, 300)}`);
});
page.on('pageerror', (error) => problems.push(`pageerror: ${String(error).slice(0, 300)}`));

async function report(label) {
  const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 400);
  console.log(`\n[${label}] ${page.url()}\n  ${text}`);
}

try {
  const signupResponse = await page.goto(`${BASE}/signup`, { waitUntil: 'domcontentloaded' });
  console.log(`signup navigation status: ${signupResponse?.status()} -> ${page.url()}`);
  await page.waitForTimeout(2000);
  console.log(`body text now: ${(await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 200)}`);
  console.log(`inputs on page: ${await page.locator('input').count()}`);
  await page.getByLabel(/姓名|Name/).fill('可用性检查');
  await page.getByLabel(/邮箱|Email/).fill(email);
  await page.getByLabel(/^密码|^Password/).fill('supersecret');
  await page.getByRole('button', { name: /创建账号|Create account/ }).click();
  // A new account is sent into the assessment, so any URL that is not the
  // signup form means it worked.
  await page.waitForURL((url) => !url.pathname.startsWith('/signup'), { timeout: 40_000 });
  await page.waitForLoadState('networkidle').catch(() => {});
  await report('after signup');

  await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await report('chat page');

  const composer = page.getByPlaceholder(/和教练说点什么|Message the coach/);
  console.log(`\ncomposer found: ${await composer.count()}`);
  if (await composer.count()) {
    await composer.fill('我今天该练什么？');
    await composer.press('Enter');
    await page.waitForTimeout(8000);
    await report('after one message');
    const bubbles = await page.getByTestId('agent-message').count();
    console.log(`message bubbles: ${bubbles}`);
    const notices = await page.getByTestId('agent-notice').count();
    console.log(`notices: ${notices}`);
  }

  await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await report('settings page');
  const modelCard = await page.getByText('用哪个模型替你思考').count();
  console.log(`\nmodel card present: ${modelCard}`);
  const buttons = await page.locator('button[aria-pressed]').allInnerTexts();
  console.log(`choice buttons: ${JSON.stringify(buttons)}`);
} catch (error) {
  problems.push(`script: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  console.log('\n=== problems ===');
  console.log(problems.length ? problems.join('\n') : '(none)');
  await browser.close();
}
