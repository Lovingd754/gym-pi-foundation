import { defineConfig, devices } from '@playwright/test';
import { localeCookieName } from './i18n/config';

// End to end tests. The web server runs a production build against the test
// database (docker-compose.test.yml). Build the app and apply migrations
// first; in CI the e2e job does both before invoking Playwright.
const PORT = 3031;
const TEST_DB =
  process.env.E2E_DATABASE_URL ??
  'postgresql://gympi_test:gympi_test@localhost:5434/gympi_test';

// The suite is written against the English copy, so it pins the app language
// instead of inheriting the product default. That keeps selector changes a
// deliberate act: a spec that wants another language asks for it explicitly
// (see fitness-setup.spec.ts, which switches to Chinese mid-test).
const ENGLISH_COOKIE_STATE = {
  cookies: [
    {
      name: localeCookieName,
      value: 'en',
      domain: 'localhost',
      path: '/',
      expires: -1,
      httpOnly: false,
      secure: false,
      sameSite: 'Lax' as const,
    },
  ],
  origins: [],
};

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  // One worker on purpose. Every spec signs up through the app's real per-IP
  // registration rate limit and shares one test database, so parallel workers
  // starve each other's buckets and produce failures that move between runs.
  // The suite takes about half a minute either way.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
    storageState: ENGLISH_COOKIE_STATE,
    // PLAYWRIGHT_CHANNEL lets a machine without the bundled Chromium revision
    // run the suite against an installed browser (msedge / chrome) instead of
    // downloading one; CI keeps the default bundled build.
    ...(process.env.PLAYWRIGHT_CHANNEL
      ? { channel: process.env.PLAYWRIGHT_CHANNEL as 'chrome' | 'msedge' }
      : {}),
  },
  webServer: {
    // LLM_PROVIDER=demo serves canned coach responses, so the AI flows (chat,
    // in-session chat) are E2E-testable without any API key (issue #111).
    // The environment is passed through Playwright's own `env` option rather
    // than shell `VAR=value` prefixes, which cmd.exe cannot parse on Windows.
    command: `next start -p ${PORT}`,
    env: {
      DATABASE_URL: TEST_DB,
      JWT_SECRET: 'e2e-test-secret-at-least-32-characters',
      LLM_PROVIDER: 'demo',
    },
    url: `http://localhost:${PORT}/login`,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
