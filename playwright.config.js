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
//    npx playwright test --project=ocean -g "A-0" → Orders-In only
//    npx playwright test --project=ocean -g "B-0" → Events-Out only
//
//  TOKENS (refresh before running — Cognito tokens expire every ~1 hour):
//    export E2E_ADMIN_TOKEN="eyJ..."
//    export AIR_ADMIN_TOKEN="eyJ..."
//
//  REPORTS:
//    Each run creates its own folder: playwright-report/runs/YYYY-MM-DD_HH-MM-SS/
//    Open all reports:  npx playwright show-report playwright-report/runs/<timestamp>/ocean
//    List all runs:     ls playwright-report/runs/
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });

const { defineConfig } = require('@playwright/test');

// ── Unique folder per run ─────────────────────────────────────────────────────
// Computed once at startup — every report from this run goes into the same folder.
// If PLAYWRIGHT_RUN_DIR is already set (e.g. by runOceanFull.js), reuse it so
// multi-suite runners can direct both suites into the same output directory.
const RUN_TS  = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
const RUN_DIR = process.env.PLAYWRIGHT_RUN_DIR || `playwright-report/runs/${RUN_TS}`;

process.env.PLAYWRIGHT_RUN_DIR = RUN_DIR;

console.log(`\n  📁 Reports folder: ${RUN_DIR}\n`);

module.exports = defineConfig({
  fullyParallel: false,
  workers:       1,
  retries:       0,
  timeout:       60000,

  use: {
    headless:   true,
    trace:      'on-first-retry',
    screenshot: 'only-on-failure',
  },

  reporter: [
    ['html', { outputFolder: `${RUN_DIR}/all`, open: 'never' }],
    ['list'],
  ],

  projects: [
    {
      name: 'air',
      testDir: './tests/air',
      reporter: [
        ['html', { outputFolder: `${RUN_DIR}/air`, open: 'never' }],
        ['list'],
      ],
    },
    {
      name: 'ocean',
      testDir: './tests/ocean',
      timeout: 600000,  // 10 min — covers NEW-V-07 with 12 sequential events
      retries: 1,       // auto-retry once on transient failures (502, Shippeo slow)
      reporter: [
        ['html', { outputFolder: `${RUN_DIR}/ocean`, open: 'never' }],
        ['./helpers/shared/eventsOutReporter.js', { outputFile: `${RUN_DIR}/ocean/events-out-report.html` }],
        ['list'],
      ],
    },
    {
      name: 'road',
      testDir: './tests/road',
      timeout: 180000,  // 3 min — road backend async processing can take 30-90s
      reporter: [
        ['html', { outputFolder: `${RUN_DIR}/road`, open: 'never' }],
        ['./helpers/road/roadEventsOutReporter.js', { outputFile: `${RUN_DIR}/road/road-events-out-report.html` }],
        ['list'],
      ],
    },
  ],
});
