import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Loaded here, and not in the harness: the config runs before any test module
// is imported, and lib/db.ts builds its connection pool the moment it is.
try {
  process.loadEnvFile(path.resolve(__dirname, '.env'));
} catch {
  // CI passes the environment explicitly.
}

// The agent evaluation harness (scripts/agent-eval.eval.ts). It runs against a
// real database and, unless --no-model is passed, a real model, so it is
// deliberately outside the unit and integration suites:
//
//   npx vitest run --config vitest.agent-eval.config.ts
//
// DATABASE_URL and the provider keys come from .env, which the harness loads
// itself (vitest does not).
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
    },
  },
  test: {
    include: ['scripts/**/*.eval.ts'],
    environment: 'node',
    fileParallelism: false,
    // The harness IS its report: its stdout is the result, so it is not
    // intercepted and reprinted per test.
    disableConsoleIntercept: true,
    testTimeout: 1_800_000,
    hookTimeout: 60_000,
  },
});
