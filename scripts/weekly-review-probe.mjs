// Manual probe for the weekly review, in a real browser, in Chinese.
//
//   phase 1 (no PROBE_EMAIL): sign up, generate a plan, activate it, and print
//                             the plan screen. Prints the account it made.
//   phase 2 (PROBE_EMAIL set): log back in and print the plan screen again,
//                             which is where the automatic review shows up.
//
// Between the two phases, backdate the activation and seed a week of evidence
// (scripts/weekly-review-probe-seed.mjs) - a review cannot be due otherwise.
import { chromium } from 'playwright';

const BASE = process.env.CHECK_BASE ?? 'http://localhost:3030';
const email = process.env.PROBE_EMAIL ?? `weekly-review-${Date.now()}@test.dev`;
const password = process.env.PROBE_PASSWORD ?? 'supersecret';

const assessment = {
  profile: {
    ageYears: 34,
    displaySex: 'FEMALE',
    energyEquationReference: 'FEMALE',
    heightCm: 166,
    weightKg: 72,
    trainingAgeMonths: 18,
  },
  goal: {
    type: 'FAT_LOSS',
    desiredWeeklyRatePct: -0.5,
    targetWeightKg: 66,
    targetDate: '2027-06-01',
  },
  schedule: {
    weeklyFrequency: 3,
    availableWeekdays: [1, 3, 5],
    sessionDurationMin: 60,
    equipmentTypes: ['DUMBBELL', 'BARBELL', 'MACHINE', 'CABLE'],
    recentMainLifts: [{ catalogKey: 'goblet_squat', weightKg: 30, reps: 10, rir: 2 }],
  },
  lifestyle: {
    activityLevel: 'MODERATE',
    avgDailySteps: 8000,
    currentModerateActivityMin: 60,
    habitualSleepMin: 430,
    bedtimeMin: 1380,
    wakeTimeMin: 420,
    timeZone: 'Asia/Shanghai',
  },
  health: {
    urgentSignals: [],
    clearanceSignals: [],
    temporarySignals: [],
    scopeSignals: [],
    healthChangedSinceClearance: false,
    attested: true,
  },
};

const browser = await chromium.launch({ channel: 'msedge' });
const context = await browser.newContext({
  viewport: { width: 420, height: 1000 },
  extraHTTPHeaders: { 'x-forwarded-for': '10.251.77.4' },
});
const page = await context.newPage();
const problems = [];
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(`console: ${message.text().slice(0, 200)}`);
});
page.on('pageerror', (error) => problems.push(`pageerror: ${String(error).slice(0, 200)}`));

async function signIn() {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 40_000 });
}

async function reportPlanScreen(label) {
  const program = await page.request.get(`${BASE}/api/programs`);
  const programs = (await program.json()) ?? [];
  const active = Array.isArray(programs)
    ? (programs.find((entry) => entry.isActive) ?? programs[0])
    : null;
  if (!active?.id) throw new Error('no program to open');
  await page.goto(`${BASE}/programs/${active.id}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(label === 'after the review' ? 4000 : 1200);
  const text = (await page.locator('main').innerText()).replace(/[ \t]+/g, ' ');
  console.log(`\n[${label}] ${page.url()}\n${text.slice(0, 1200)}`);
  await page.screenshot({
    path: `test-results/weekly-review-${label.replace(/\s+/g, '-')}.png`,
    fullPage: true,
  });
}

try {
  if (!process.env.PROBE_EMAIL) {
    const register = await context.request.post(`${BASE}/api/auth/register`, {
      data: { displayName: '每周复评检查', email, password },
    });
    if (!register.ok()) throw new Error(`register failed: ${register.status()}`);
    const saved = await context.request.put(`${BASE}/api/fitness/assessment`, { data: assessment });
    if (!saved.ok()) throw new Error(`assessment failed: ${saved.status()} ${await saved.text()}`);
    const preview = await context.request.post(`${BASE}/api/fitness/plans/preview`, { data: {} });
    const plan = (await preview.json()).plan;
    const activated = await context.request.post(`${BASE}/api/fitness/plans/${plan.id}/activate`, {
      data: { expectedRevision: 0 },
    });
    if (!activated.ok()) throw new Error(`activate failed: ${activated.status()}`);
    console.log(`created ${email} with plan v${plan.version}`);
    // Registering already signed this browser context in, so the plan screen is
    // one navigation away and the login form is not on the way.
    await reportPlanScreen('fresh plan');
  } else {
    await signIn();
    await reportPlanScreen('after the review');
  }
} catch (error) {
  problems.push(`script: ${error instanceof Error ? error.message : String(error)}`);
  await page.screenshot({ path: 'test-results/weekly-review-failure.png' }).catch(() => {});
} finally {
  console.log('\n=== problems ===');
  console.log(problems.length ? problems.join('\n') : '(none)');
  await browser.close();
}
