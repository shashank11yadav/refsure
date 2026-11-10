import { defineConfig } from '@playwright/test';

// End-to-end tests: real Chromium with the built extension loaded, arXiv and OpenReview pages
// served from tests/fixtures, every lookup API answered by tests/e2e/fakeApi.ts (nothing leaves the machine).
// `npm run test:e2e` builds the extension first when `.output/chrome-mv3` is missing or older than `src/`.
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  globalSetup: './tests/e2e/globalSetup.ts',
  // One browser at a time: each test launches its own Chromium profile and several run for a while.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir: 'test-results',
});
