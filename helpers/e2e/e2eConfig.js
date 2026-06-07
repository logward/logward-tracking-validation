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
    adminToken: process.env.QA_ADMIN_TOKEN ||
      'eyJraWQiOiJIOU5CdVoyb3NWN0hpTG9WaEtPWC8xZENkdHlBNmdOMzd0N3NQL0MyT0xRPSIsImFsZyI6IlJTMjU2In0.eyJzdWIiOiJjMzUwOWFhMy02NDM0LTQ0ODktYjcwOC01OTQ3NTRiMjk0ZjgiLCJjb2duaXRvOmdyb3VwcyI6WyJDdXN0b21lckFkbWluIl0sImlzcyI6Imh0dHBzOi8vY29nbml0by1pZHAuZXUtY2VudHJhbC0xLmFtYXpvbmF3cy5jb20vZXUtY2VudHJhbC0xX0dJbDFpelQ3QiIsImNsaWVudF9pZCI6Im1ocTZoN3Y2bjJjZHZqOW1zam9vcThraDQiLCJvcmlnaW5fanRpIjoiZTRkYzg0OWQtOGU3Ni00ZDc3LWEwNGQtYWZlYmZlMjQzYTVhIiwiZXZlbnRfaWQiOiJkNGUyZDg1Mi1lNGZjLTRmNjEtYTJhYS02Y2ZhYWY5YWEyNDAiLCJ0b2tlbl91c2UiOiJhY2Nlc3MiLCJzY29wZSI6ImF3cy5jb2duaXRvLnNpZ25pbi51c2VyLmFkbWluIiwiYXV0aF90aW1lIjoxNzgwODM4NjMyLCJleHAiOjE3ODA4NDIyMzIsImlhdCI6MTc4MDgzODYzMiwianRpIjoiOGQwZjY3YjctNDgwMC00NDMyLWFkNGYtNDc0ZTM0ODBkZDViIiwidXNlcm5hbWUiOiJjMzUwOWFhMy02NDM0LTQ0ODktYjcwOC01OTQ3NTRiMjk0ZjgifQ.Nzv1HkXbfDnK3gxXZkA3KAh7HjAu70tNCt-a7Znsqu0sOtNaDhykfaaBRk2UTmpPy7CiGu-tvmanx9jbeymHFv5gmTwxJFAEOMDHo5n1byL1Cay1dYtBRlmkBXvUSqsfct6mJqSn2BhRu8Hm9PBsYf6oETR2VcF0SoqZcqRfO6VaM3bKASzW3m4lg8t-GY2y0eaCRClJ2ekNyGsLBmLB9LE7qSupW_azjB8JiNnridt_yh1SII12pMEfqQAlm7-j3r--sXupvjwsWAgo-jWadsl7VduESC-jgMYMCJfwjL10suzu8Uk7fBTnOSnZzPLN3__Zo9dFzCTRLyAVnniSNg',

    webhookToken: process.env.QA_WEBHOOK_TOKEN ||
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2NvdW50SWQiOiIwMDEwUTAwMDAwVFpvc1FRQVQiLCJjb2RlIjoidjEyQkhtNVhHUWdaIiwiZXhwIjoxODA4NTkxNDAwLCJpc3MiOiJodHRwczovL2NvZ25pdG8taWRwLmV1LWNlbnRyYWwtMS5hbWF6b25hd3MuY29tL2V1LWNlbnRyYWwtMV9HSWwxaXpUN0IiLCJhdWQiOiJsb2d3YXJkLmNvbSJ9.BHqHsfrYweYeHyHrgziLqvJmm2Q5vh6tO59va4nF2tw',
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
    adminUrl:        'https://qa-admin.logward.engineering',
    trackingUrl:     'https://qa-admin.logward.engineering',
    webhookUrl:      'https://qa.logward.engineering',
    webhookPath:     '/api/integration-hub/tracking/shippeo/ocean_order_event_out',
    webhookClientId: '0010Q00001iPMHnQAO',
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

  // ── Admin API (Orders-In: create / read tracking objects) ─────────────────
  ADMIN_BASE_URL: ENV.adminUrl,
  ADMIN_TOKEN:    ENV_TOKENS.adminToken,
  ACCOUNT_ID:     ENV.accountId,

  // ── Tracking Service API (scheduler + MongoDB verification) ───────────────
  TRACKING_BASE_URL: ENV.trackingUrl,

  // ── Audit API ─────────────────────────────────────────────────────────────
  AUDIT_PATH: '/api/tower/audit',

  // ── Shippeo Partner API (verify shipment is searchable in Shippeo) ────────
  SHIPPEO: {
    baseUrl:        process.env.SHIPPEO_API_BASE_URL || 'https://api.shippeo.com',
    token:          process.env.SHIPPEO_API_TOKEN    || '<FILL_IN>',
    searchPath:     '/v2/orders',
    searchParamKey: 'reference',
  },

  // ── OCEAN shipment identifiers ────────────────────────────────────────────
  // Override any value via environment variable if needed
  OCEAN: {
    SCHEMA_TYPE:   'TransportUnitOcean',
    UPSERT_PATH:   '/api/tower/data/TransportUnitOcean/upsert',
    CREATE_NEW:    true,

    BOOKING_NUMBER:     process.env.E2E_OCEAN_BOOKING || 'E2EBOOK001',
    BL_NUMBER:          process.env.E2E_OCEAN_BL      || 'E2EBL001',
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
  SCHEDULER_TIMEOUT_MS: 30000,
  MONGO_TIMEOUT_MS:     60000,
  SHIPPEO_TIMEOUT_MS:   120000,
  AUDIT_TIMEOUT_MS:     30000,

};

module.exports = { E2E_CONFIG };
