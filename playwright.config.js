// @ts-check
// ─────────────────────────────────────────────────────────────────────────────
//  Logward Tracking Mapping — Playwright Config
//  Pure API tests — no browser, no storageState, no login required.
//
//  HOW TO RUN:
//    npx playwright test                          → all tracking types
//    npx playwright test --project=air            → AIR only
//    npx playwright test --project=ocean          → OCEAN only
//    npx playwright test --project=road           → ROAD only
//    npx playwright test --project=e2e            → E2E (Orders-In + Events-Out)
//    npx playwright test --project=e2e -g "A-0"  → E2E Orders-In only
//    npx playwright test --project=e2e -g "B-0"  → E2E Events-Out only
//
//  TOKENS (refresh before running — Cognito tokens expire every ~1 hour):
//    export AIR_ADMIN_TOKEN="eyJ..."
//    export OCEAN_ADMIN_TOKEN="eyJ..."
//    export ROAD_ADMIN_TOKEN="eyJ..."
//    export E2E_ADMIN_TOKEN="eyJ..."
// ─────────────────────────────────────────────────────────────────────────────

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  fullyParallel: false,   // run sequentially — each project shares one ATU object
  workers:       1,
  retries:       0,
  timeout:       60000,   // 60s per test (webhook + poll can take ~30s)

  use: {
    headless:   true,
    trace:      'on-first-retry',
    screenshot: 'only-on-failure',
  },

  reporter: [
    ['html',  { outputFolder: 'playwright-report/all', open: 'never' }],
    ['list'],
  ],

  projects: [
    {
      name: 'air',
      testDir: './tests/air',
      reporter: [
        ['html',  { outputFolder: 'playwright-report/air', open: 'never' }],
        ['list'],
      ],
    },
    {
      name: 'ocean',
      testDir: './tests/e2e/ocean',
      timeout: 180000,
      reporter: [
        ['html',  { outputFolder: 'playwright-report/ocean', open: 'never' }],
        ['list'],
      ],
    },
    {
      name: 'road',
      testDir: './tests/road',
      reporter: [
        ['html',  { outputFolder: 'playwright-report/road', open: 'never' }],
        ['list'],
      ],
    },
    {
      name: 'e2e',
      testDir: './tests/e2e',
      timeout: 180000,   // 3 min per step — scheduler + Shippeo sync can take time
      reporter: [
        ['html',  { outputFolder: 'playwright-report/e2e', open: 'never' }],
        ['list'],
      ],
    },
  ],
});
