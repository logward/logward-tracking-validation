// @ts-check
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

// ─────────────────────────────────────────────────────────────────────────────
//  helpers/air/airConfig.js
//
//  Centralised config for all AIR tracking tests.
//  Driven by E2E_ENV in .env — set to qa | sandbox | prod.
//
//  Webhook tokens — shared with ocean, set per environment in .env:
//    QA_WEBHOOK_TOKEN      ← QA
//    SANDBOX_WEBHOOK_TOKEN ← Sandbox
//    PROD_WEBHOOK_TOKEN    ← Production
// ─────────────────────────────────────────────────────────────────────────────

const SELECTED_ENV = (process.env.E2E_ENV || 'qa').toLowerCase();

const ENVIRONMENTS = {
  qa: {
    label:           'QA',
    webhookBaseUrl:  'https://qa.logward.engineering',
    adminUpsertUrl:  'https://qa.logward.engineering',
    adminGetUrl:     'https://qa-admin.logward.engineering',
    webhookPath:     '/api/integration-hub/tracking/shippeo/air_tracking',
    webhookClientId: 'Vbc1r8621FLbtFFl2E',
    accountId:       'Vbc1r8621FLbtFFl2E',
    webhookToken:    process.env.QA_WEBHOOK_TOKEN,
  },
  sandbox: {
    label:           'Sandbox',
    webhookBaseUrl:  'https://sandbox-admin.logward.com',
    adminUpsertUrl:  'https://sandbox-admin.logward.com',
    adminGetUrl:     'https://sandbox-admin.logward.com',
    webhookPath:     '/api/integration-hub/tracking/shippeo/air_tracking',
    webhookClientId: 'wCQU29iqXuWMYkTcU6',
    accountId:       'wCQU29iqXuWMYkTcU6',
    webhookToken:    process.env.SANDBOX_WEBHOOK_TOKEN,
  },
  prod: {
    label:           'Production',
    webhookBaseUrl:  'https://admin.logward.com',
    adminUpsertUrl:  'https://admin.logward.com',
    adminGetUrl:     'https://admin.logward.com',
    webhookPath:     '/api/integration-hub/tracking/shippeo/air_tracking',
    webhookClientId: 'xxfRocp5CMRQXD56uy',
    accountId:       'xxfRocp5CMRQXD56uy',
    webhookToken:    process.env.PROD_WEBHOOK_TOKEN,
  },
};

const ENV = ENVIRONMENTS[SELECTED_ENV];
if (!ENV) throw new Error(`Unknown E2E_ENV "${SELECTED_ENV}". Valid options: qa | sandbox | prod`);

const CONFIG = {
  ENV_NAME:  SELECTED_ENV,
  ENV_LABEL: ENV.label,

  // ── Webhook (Shippeo → Logward ingestion) ──────────────────────────────────
  WEBHOOK_BASE_URL:  ENV.webhookBaseUrl,
  WEBHOOK_PATH:      ENV.webhookPath,
  WEBHOOK_CLIENT_ID: ENV.webhookClientId,
  WEBHOOK_TOKEN:     ENV.webhookToken,

  // ── Admin API (create/update ATU) — uses cognitoAuth.js automatically ──────
  ADMIN_UPSERT_BASE_URL: ENV.adminUpsertUrl,
  ADMIN_BASE_URL:        ENV.adminGetUrl,

  // ── Schema — same across all environments ──────────────────────────────────
  SCHEMA_TYPE: 'airTransportUnit',
  UPSERT_PATH: '/api/tower/data/airTransportUnit/upsert',
  GET_PATH:    '/api/tower/data/airTransportUnit',

  // ── Polling ────────────────────────────────────────────────────────────────
  POLL_INTERVAL_MS: 3000,
  POLL_TIMEOUT_MS:  30000,

  // ── Legacy fixed identifiers (used by TC001/TC002 static tests) ───────────
  CUSTOMER_REF: 'CARGO-TRACK-1209',
  MAWB_NUMBER:  '',
  OBJECT_CODE:  'e825ce4610cc',
};

module.exports = { CONFIG };
