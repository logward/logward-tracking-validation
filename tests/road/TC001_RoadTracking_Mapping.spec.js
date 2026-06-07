// =============================================================================
// TC001_RoadTracking_Mapping.spec.js
//
// API Automation — Road Tracking Mapping Verification (Shippeo → Logward)
//
// RTU under test:
//   roadShipmentReference  : <FILL_IN>
//   roadCustomerReference  : <FILL_IN>
//   code                   : <FILL_IN>
//
// ─── MAPPING TYPES ───────────────────────────────────────────────────────────
//
//  (Define road mapping types here based on the Road Events Mapping doc)
//
// HOW TO RUN:
//   npx playwright test --project=road
//   npx playwright test "tests/road/TC001_RoadTracking_Mapping.spec.js"
//
// BEFORE RUNNING — refresh the admin token (expires every ~1 hour):
//   export ROAD_ADMIN_TOKEN="eyJ..."
// =============================================================================

// @ts-check
const { test, expect, request } = require('@playwright/test');
const { checkTokenExpiry }       = require('../../helpers/tokenHelper');
const { pollUntil }              = require('../../helpers/pollHelper');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
  WEBHOOK_BASE_URL:  'https://qa.logward.engineering',
  WEBHOOK_PATH:      '/api/integration-hub/tracking/shippeo/road_tracking', // TODO: confirm path
  WEBHOOK_CLIENT_ID: '<FILL_IN>',

  // Long-lived webhook token — override via ROAD_WEBHOOK_TOKEN env var
  WEBHOOK_TOKEN: process.env.ROAD_WEBHOOK_TOKEN || '<FILL_IN>',

  ADMIN_BASE_URL: 'https://qa-admin.logward.engineering',

  // ⚠️  Cognito access token — expires every ~1 hour.
  //     When the test fails with HTTP 401 on the GET call, refresh this token:
  //       1. Log in to qa-admin.logward.engineering in your browser
  //       2. Copy the accessToken from DevTools → Application → Cookies
  //          OR from Network tab → any admin API request → Authorization header
  //       3. export ROAD_ADMIN_TOKEN="eyJ..."   (paste the fresh token)
  //       4. Re-run the test
  ADMIN_TOKEN: process.env.ROAD_ADMIN_TOKEN || '<FILL_IN>',

  // RTU under test — UPDATE-ONLY service, RTU must pre-exist in BE
  SHIPMENT_REF: '<FILL_IN>',
  CUSTOMER_REF: '<FILL_IN>',
  OBJECT_CODE:  '<FILL_IN>',

  SCHEMA_TYPE:      'roadTransportUnit', // TODO: confirm schema type
  POLL_INTERVAL_MS: 3000,
  POLL_TIMEOUT_MS:  30000,
};
// ─────────────────────────────────────────────────────────────────────────────

// ── Token expiry check ────────────────────────────────────────────────────────
checkTokenExpiry(CONFIG.ADMIN_TOKEN, 'ROAD_ADMIN_TOKEN', 'ROAD ADMIN');
// ─────────────────────────────────────────────────────────────────────────────

// ─── API HELPERS ─────────────────────────────────────────────────────────────
const webhookHeaders = () => ({
  'Content-Type':  'application/json',
  'ClientId':      CONFIG.WEBHOOK_CLIENT_ID,
  'Authorization': `Bearer ${CONFIG.WEBHOOK_TOKEN}`,
});
const adminHeaders = () => ({
  'Authorization': `Bearer ${CONFIG.ADMIN_TOKEN}`,
  'accept':        'application/json',
});

async function sendWebhook(ctx, payload) {
  return ctx.post(CONFIG.WEBHOOK_PATH, { headers: webhookHeaders(), data: payload });
}

async function getRTU(ctx) {
  const res = await ctx.get(
    `/api/tower/data/${CONFIG.SCHEMA_TYPE}/${CONFIG.OBJECT_CODE}`,
    { headers: adminHeaders() }
  );

  if (res.status() === 401) {
    throw new Error(
      `GET RTU → HTTP 401 Unauthorized.\n` +
      `  The ROAD_ADMIN_TOKEN has expired (Cognito tokens last ~1 hour).\n` +
      `  Fix:\n` +
      `    1. Log in to https://qa-admin.logward.engineering\n` +
      `    2. Copy the fresh Bearer token from DevTools → Network → any request → Authorization header\n` +
      `    3. export ROAD_ADMIN_TOKEN="eyJ..."\n` +
      `    4. Re-run the test`
    );
  }

  if (res.status() !== 200) {
    throw new Error(`GET RTU /${CONFIG.SCHEMA_TYPE}/${CONFIG.OBJECT_CODE} → HTTP ${res.status()}`);
  }

  const body = await res.json();
  return body.data ?? body;
}

/**
 * Poll RTU until changedAt differs from `baseline` (i.e. backend processed the webhook).
 */
async function waitForUpdate(ctx, baseline) {
  return pollUntil(
    () => getRTU(ctx),
    rtu => rtu.changedAt !== baseline,
    { intervalMs: CONFIG.POLL_INTERVAL_MS, timeoutMs: CONFIG.POLL_TIMEOUT_MS, label: 'RTU changedAt update' }
  );
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── SHARED CONTEXT ──────────────────────────────────────────────────────────
let webhookCtx, adminCtx;

test.beforeAll(async () => {
  webhookCtx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });
  adminCtx   = await request.newContext({ baseURL: CONFIG.ADMIN_BASE_URL });
});

test.afterAll(async () => {
  await webhookCtx?.dispose();
  await adminCtx?.dispose();
});
// ─────────────────────────────────────────────────────────────────────────────

// ─── PLACEHOLDER TESTS ───────────────────────────────────────────────────────
// TODO: Add road tracking mapping test cases following the Road Events Mapping doc.
//
// Pattern (same as AIR tests):
//   1. GET RTU → capture baseline changedAt
//   2. POST webhook with a Shippeo road event payload
//   3. Assert webhook returns 2xx
//   4. Poll RTU until changedAt changes
//   5. Assert mapped fields on the updated RTU
//
// Example structure:
//
// test('Type 1 — Direct fields: truck_departed', async () => {
//   const baseline = (await getRTU(adminCtx)).changedAt;
//   const payload  = makePayload('truck_departed', '2025-07-24T10:00:00+00:00', toEventSite(SITE.XXX));
//   const res      = await sendWebhook(webhookCtx, payload);
//   expect(res.status()).toBe(200);
//   const rtu = await waitForUpdate(adminCtx, baseline);
//   expect(rtu.someField).toBe('expectedValue');
// });

test.skip('TC001 — Road Tracking Mapping (placeholder)', async () => {
  // TODO: implement once Road Events Mapping doc is available
});
// ─────────────────────────────────────────────────────────────────────────────
