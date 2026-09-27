// Opens a freshly generated plan preview in a real browser and prints the food
// section, which is the only way to tell whether the meal copy reads like
// something a person would act on.
import { chromium } from 'playwright';

const BASE = process.env.CHECK_BASE ?? 'http://localhost:3030';

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
    targetDate: '2027-03-01',
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
  softConstraints: '膝盖怕深蹲，不太想做有氧',
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
const context = await browser.newContext();
const page = await context.newPage();
const problems = [];
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(message.text().slice(0, 200));
});
page.on('pageerror', (error) => problems.push(String(error).slice(0, 200)));

const register = await context.request.post(`${BASE}/api/auth/register`, {
  data: {
    displayName: '餐食检查',
    email: `meal-${Date.now()}@test.dev`,
    password: 'supersecret',
  },
});
if (!register.ok()) throw new Error(`register failed: ${register.status()}`);

const saved = await context.request.put(`${BASE}/api/fitness/assessment`, { data: assessment });
if (!saved.ok()) throw new Error(`assessment failed: ${saved.status()} ${await saved.text()}`);

const preview = await context.request.post(`${BASE}/api/fitness/plans/preview`, { data: {} });
if (!preview.ok()) throw new Error(`preview failed: ${preview.status()} ${await preview.text()}`);
const plan = (await preview.json()).plan;
console.log(`plan v${plan.version} status=${plan.status} meals=${plan.content.nutrition.meals?.length}`);

await page.goto(`${BASE}/fitness/plans/${plan.id}/preview`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

const text = await page.locator('main').innerText();
const start = text.indexOf('饮食');
console.log('\n=== nutrition section as rendered ===\n');
console.log(start >= 0 ? text.slice(start, start + 1200) : text.slice(0, 1200));

// Activate it, then ask the assistant about a meal. The chat is the main window,
// so the meal split has to reach the model, not just the preview page.
const activation = await context.request.post(
  `${BASE}/api/fitness/plans/${plan.id}/activate`,
  { data: { expectedRevision: 0 } },
);
if (!activation.ok()) throw new Error(`activate failed: ${activation.status()} ${await activation.text()}`);

await page.goto(`${BASE}/chat`, { waitUntil: 'networkidle' });
await page.getByPlaceholder('和教练说点什么…').fill('我午餐没吃够，现在该怎么办？');
await page.getByPlaceholder('和教练说点什么…').press('Enter');
// The send button turns into a stop button for the whole turn, tool call
// included; a real answer through DeepSeek takes ten to twenty seconds.
await page
  .getByTitle('停止')
  .waitFor({ state: 'hidden', timeout: 60_000 })
  .catch(() => console.log('(answer still streaming after 60s)'));
const chat = await page.locator('main').innerText();
const question = chat.indexOf('我午餐没吃够');
console.log('\n=== chat answer ===\n');
console.log(question >= 0 ? chat.slice(question, question + 1500) : chat.slice(0, 1500));

console.log('\n=== problems ===');
console.log(problems.length ? problems.join('\n') : '(none)');

await browser.close();
