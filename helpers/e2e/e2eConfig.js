// ╔══════════════════════════════════════════════════════════════════════════╗
//  LOGWARD E2E TEST CONFIGURATION
//  Ocean Tracking — Orders-In + Events-Out
//
//  HOW TO RUN:
//    npx playwright test --project=e2e          ← runs on QA (default)
//    npx playwright test --project=e2e -g "A-0" ← Orders-In only
//    npx playwright test --project=e2e -g "B-0" ← Events-Out only
//
//  TO SWITCH ENVIRONMENT:
//    Change STEP 1 below  OR  set env variable before running:
//      E2E_ENV=sandbox npx playwright test --project=e2e
//      E2E_ENV=prod    npx playwright test --project=e2e
// ╚══════════════════════════════════════════════════════════════════════════╝

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 1 — SELECT ENVIRONMENT
//  Options: 'qa' | 'sandbox' | 'prod'
// ─────────────────────────────────────────────────────────────────────────────
const SELECTED_ENV = process.env.E2E_ENV || 'qa';

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 2 — PASTE TOKENS
//
//  Admin token  : expires every ~1 hour
//    How to get : Log in to the admin URL for your environment
//                 → DevTools → Network tab → click any request
//                 → copy the Authorization header value (after "Bearer ")
//
//  Webhook token: long-lived (expires in years), provided by Logward team
//
//  Only update the environment you are running against.
// ─────────────────────────────────────────────────────────────────────────────
const TOKENS = {

  // ── QA ────────────────────────────────────────────────────────────────────
  qa: {
    // ── Webhook token — long-lived (expires 2027) ─────────────────────────
    // Used by: Events-Out webhook (Shippeo → Logward)
    webhookToken: process.env.QA_WEBHOOK_TOKEN,
  },

  // ── Sandbox ───────────────────────────────────────────────────────────────
  sandbox: {
    adminToken:   process.env.SANDBOX_ADMIN_TOKEN   || '<paste Sandbox admin token here>',
    webhookToken: process.env.SANDBOX_WEBHOOK_TOKEN || '<paste Sandbox webhook token here>',
  },

  // ── Production ────────────────────────────────────────────────────────────
  prod: {
    adminToken:   process.env.PROD_ADMIN_TOKEN   || '<paste Prod admin token here>',
    webhookToken: process.env.PROD_WEBHOOK_TOKEN || '<paste Prod webhook token here>',
  },

};

// ─────────────────────────────────────────────────────────────────────────────
//  ENVIRONMENT DEFINITIONS
//  URLs and paths per environment — only change if the URLs change
// ─────────────────────────────────────────────────────────────────────────────
const ENVIRONMENTS = {
  qa: {
    label:           'QA',
    adminUrl:        'https://qa.logward.engineering',       // upsert (create/update)
    adminGetUrl:     'https://qa-admin.logward.engineering', // object GET
    trackingUrl:     'https://qa.logward.engineering',
    webhookUrl:      'https://qa.logward.engineering',
    webhookPath:     '/api/integration-hub/tracking/shippeo/ocean_order_event_out',
    webhookClientId: 'Vbc1r8621FLbtFFl2E',
    accountId:       'Vbc1r8621FLbtFFl2E',
  },
  sandbox: {
    label:           'Sandbox',
    adminUrl:        'https://sandbox-admin.logward.com',
    trackingUrl:     'https://sandbox-admin.logward.com',
    webhookUrl:      'https://sandbox-admin.logward.com',
    webhookPath:     '/api/integration-hub/tracking/shippeo/ocean_order_event_out',
    webhookClientId: '0010Q00001iPMHnQAO',
    accountId:       '<FILL_IN>',
  },
  prod: {
    label:           'Production',
    adminUrl:        'https://admin.logward.com',
    trackingUrl:     'https://admin.logward.com',
    webhookUrl:      'https://admin.logward.com',
    webhookPath:     '/api/integration-hub/tracking/shippeo/ocean_order_event_out',
    webhookClientId: '<FILL_IN>',
    accountId:       '<FILL_IN>',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
//  Resolve selected environment — stop early with a clear message if wrong
// ─────────────────────────────────────────────────────────────────────────────
const ENV = ENVIRONMENTS[SELECTED_ENV];
if (!ENV) throw new Error(`Unknown E2E_ENV "${SELECTED_ENV}". Valid options: qa | sandbox | prod`);
const ENV_TOKENS = TOKENS[SELECTED_ENV];

// ─────────────────────────────────────────────────────────────────────────────
//  FINAL CONFIG  (consumed by all helper files — do not edit below this line)
// ─────────────────────────────────────────────────────────────────────────────
const E2E_CONFIG = {

  // Active environment info (shown in report header and console logs)
  ENV_NAME:  SELECTED_ENV,
  ENV_LABEL: ENV.label,

  // ── Cognito credentials — used by cognitoAuth.js to auto-login ──────────
  // Set once; cognitoAuth.js refreshes the token automatically every ~1h
  COGNITO: {
    username: process.env.LOGWARD_USERNAME,
    password: process.env.LOGWARD_PASSWORD,
  },

  // ── Admin API — all use Cognito token via cognitoAuth.js ─────────────────
  ADMIN_BASE_URL:    ENV.adminUrl,                        // upsert (create/update)
  ADMIN_GET_URL:     ENV.adminGetUrl || ENV.adminUrl,     // object GET
  ACCOUNT_ID:        ENV.accountId,

  // ── Tracking Service API (scheduler + MongoDB verification) ───────────────
  TRACKING_BASE_URL: ENV.trackingUrl,

  // ── Audit API ─────────────────────────────────────────────────────────────
  // Confirmed: GET /api/tower/audit/{objectCode}?schemaType=...&isAdmin=true&p=0&s=100
  AUDIT_PATH: '/api/tower/audit',

  // ── Shippeo Backoffice API ────────────────────────────────────────────────
  // Fully automatic — no manual token steps needed.
  // shippeoAuth.js priority: memory cache → disk cache → headless browser login
  // Headless login fires once per day (~3 sec), then auto-refreshes every 15 min.
  SHIPPEO: {
    baseUrl:        process.env.SHIPPEO_API_BASE_URL || 'https://api.shippeo.com',
    clientId:       process.env.SHIPPEO_CLIENT_ID      || '<paste Shippeo client ID here>',

    // ── Credentials — set once, works forever via headless browser login ──────
    username:       process.env.SHIPPEO_USERNAME,
    password:       process.env.SHIPPEO_PASSWORD,

    // ── Leave blank — tokens obtained automatically ───────────────────────────
    refreshToken:   process.env.SHIPPEO_REFRESH_TOKEN || '',
    token:          process.env.SHIPPEO_API_TOKEN     || '',

    searchPath:     '/core/orders/debug/search',
    searchParamKey: 'reference',
  },

  // ── OCEAN shipment identifiers ────────────────────────────────────────────
  // Override any value via environment variable if needed
  OCEAN: {
    SCHEMA_TYPE:   'TransportUnitOcean',
    UPSERT_PATH:   '/api/tower/data/TransportUnitOcean/upsert',
    GET_PATH:      '/api/tower/data/TransportUnitOcean',
    CREATE_NEW:    true,

    // Last 4 digits of timestamp make these unique per run — avoids routing to stale OTUs
    BOOKING_NUMBER:     process.env.E2E_OCEAN_BOOKING || ('E2EBOOK' + (Date.now() % 10000).toString().padStart(4, '0')),
    BL_NUMBER:          process.env.E2E_OCEAN_BL      || ('E2EBL'   + (Date.now() % 10000).toString().padStart(4, '0')),
    SCAC:               process.env.E2E_OCEAN_SCAC    || 'MSCU',
    CARRIER_SHORT_NAME: 'MSC',
    CARRIER_NAME:       'Mediterranean Shipping Company',

    // Container number is auto-generated each run: prefix + last 7 digits of timestamp
    // e.g. LGTE + 9103891 → LGTE9103891 (unique per run, no manual setup needed)
    CONTAINER_PREFIX: process.env.E2E_OCEAN_CONTAINER_PREFIX || 'LGTE',

    // ── Events-Out webhook (same environment as Orders-In) ────────────────
    WEBHOOK_BASE_URL:  ENV.webhookUrl,
    WEBHOOK_PATH:      ENV.webhookPath,
    WEBHOOK_CLIENT_ID: ENV.webhookClientId,
    WEBHOOK_TOKEN:     ENV_TOKENS.webhookToken,
  },

  // ── Polling timeouts ──────────────────────────────────────────────────────
  POLL_INTERVAL_MS:     10000,
  SCHEDULER_TIMEOUT_MS: 120000,  // 2 min — update scenarios need more time for re-processing
  MONGO_TIMEOUT_MS:     60000,
  SHIPPEO_TIMEOUT_MS:   180000,  // 3 min — Shippeo propagation can be slow
  AUDIT_TIMEOUT_MS:     30000,

};

module.exports = { E2E_CONFIG };
