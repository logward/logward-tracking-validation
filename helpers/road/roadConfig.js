// @ts-check
// @ts-check
// ─────────────────────────────────────────────────────────────────────────────
//  helpers/road/roadConfig.js
//
//  Centralised config for all ROAD tracking tests.
//  Driven by E2E_ENV in .env — set to qa | sandbox | prod.
//
//  Road webhook auth (QA):
//    POST  /api/shippeo/roadData/{base64-user-slug}
//    Headers:
//      x-api-key:     <hardcoded per env — gateway-level key>
//      Authorization: Bearer <Cognito admin token — same token used for RTU
//                             create/read, auto-fetched via cognitoAuth.js>
//
//  Road uses Cognito auth (NOT a separate long-lived webhook token like ocean/air).
//  Lookup:  order.reference = RTU transportOrderId
// ─────────────────────────────────────────────────────────────────────────────

const SELECTED_ENV = (process.env.E2E_ENV || 'qa').toLowerCase();

const ENVIRONMENTS = {
  qa: {
    label:           'QA',
    adminUpsertUrl:  'https://qa.logward.engineering',
    adminGetUrl:     'https://qa-admin.logward.engineering',
    webhookBaseUrl:  'https://qa.logward.engineering',
    webhookPath:     '/api/shippeo/roadData/bGlkbC1sb2d3YXJkLXJvYWQtdGVzdC5hcGktdXNlcg==',
    webhookApiKey:   process.env.QA_ROAD_API_KEY || '',
  },
  sandbox: {
    label:           'Sandbox',
    adminUpsertUrl:  'https://sandbox-admin.logward.com',
    adminGetUrl:     'https://sandbox-admin.logward.com',
    webhookBaseUrl:  'https://sandbox-admin.logward.com',
    // Was 'lidl-logward-road-sandbox.api-user' — switched to the 'test.api-user'
    // slug (same as qa) after confirming it manually against the sandbox host.
    // Note: this did NOT resolve the low event-processing success rate seen on
    // sandbox (~1/5 to ~2/10 in testing) — that looks like backend-side
    // flakiness, not a URL config issue. Kept anyway since it's the
    // confirmed-working slug and removes one variable.
    webhookPath:     '/api/shippeo/roadData/bGlkbC1sb2d3YXJkLXJvYWQtdGVzdC5hcGktdXNlcg==',
    webhookApiKey:   process.env.SANDBOX_ROAD_API_KEY || '',
  },
  prod: {
    label:           'Production',
    adminUpsertUrl:  'https://admin.logward.com',
    adminGetUrl:     'https://admin.logward.com',
    webhookBaseUrl:  'https://admin.logward.com',
    webhookPath:     '/api/shippeo/roadData/bGlkbC1sb2d3YXJkLXJvYWQucGFwaS11c2Vy',
    webhookApiKey:   process.env.PROD_ROAD_API_KEY || '',
  },
};

const ENV = ENVIRONMENTS[SELECTED_ENV];
if (!ENV) throw new Error(`Unknown E2E_ENV "${SELECTED_ENV}". Valid options: qa | sandbox | prod`);

const CONFIG = {
  ENV_NAME:  SELECTED_ENV,
  ENV_LABEL: ENV.label,

  // ── Road Webhook ───────────────────────────────────────────────────────────
  //  x-api-key:  gateway-level key (hardcoded per env)
  //  Bearer:     Cognito admin token via cognitoAuth.js — same token as RTU API
  //              Road is unique: ocean/air use long-lived webhook tokens; road uses Cognito.
  WEBHOOK_BASE_URL: ENV.webhookBaseUrl,
  WEBHOOK_PATH:     ENV.webhookPath,
  WEBHOOK_API_KEY:  ENV.webhookApiKey,

  // ── Admin API ──────────────────────────────────────────────────────────────
  ADMIN_UPSERT_BASE_URL: ENV.adminUpsertUrl,
  ADMIN_BASE_URL:        ENV.adminGetUrl,

  // ── Schema ─────────────────────────────────────────────────────────────────
  SCHEMA_TYPE: 'TransportUnitRoad',
  UPSERT_PATH: '/api/tower/data/TransportUnitRoad/upsert',
  GET_PATH:    '/api/tower/data/TransportUnitRoad',
  SCHED_PATH:  '/api/tracking/track/schedule/TransportUnitRoad',

  // ── Polling ────────────────────────────────────────────────────────────────
  POLL_INTERVAL_MS: 3000,
  POLL_TIMEOUT_MS:  90000,
};

module.exports = { CONFIG };
