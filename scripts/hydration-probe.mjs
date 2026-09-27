// Prints the full text of any hydration warning on a page, since the browser
// console only shows the first lines of it.
import { chromium } from 'playwright';

const BASE = process.env.CHECK_BASE ?? 'http://localhost:3030';
const path = process.argv[2] ?? '/chat';

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage();
const messages = [];
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') {
    messages.push(message.text());
  }
});
page.on('pageerror', (error) => messages.push(`pageerror: ${String(error)}`));

// Optional sign-in so authenticated pages can be probed too; the credentials
// come from the environment and are never printed.
if (process.env.PROBE_EMAIL && process.env.PROBE_PASSWORD) {
  // Sign in through the API so the probe does not depend on a form having
  // hydrated: the response cookie lands in this browser context either way.
  const login = await page.request.post(`${BASE}/api/auth/login`, {
    data: { email: process.env.PROBE_EMAIL, password: process.env.PROBE_PASSWORD },
  });
  if (!login.ok()) throw new Error(`probe sign-in failed: ${login.status()}`);
  messages.length = 0;
}

await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);

console.log(`=== ${path}: ${messages.length} console message(s) ===`);
for (const text of messages) console.log(`\n---\n${text.slice(0, 2000)}`);
await browser.close();
