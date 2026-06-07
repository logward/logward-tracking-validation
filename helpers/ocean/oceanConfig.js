// ─────────────────────────────────────────────────────────────────────────────
//  helpers/ocean/oceanConfig.js
//
//  Ocean tracking config — single source of truth for all ocean tests.
//
//  Tokens and URLs are pulled from E2E_CONFIG (helpers/e2e/e2eConfig.js).
//  To switch environment or refresh tokens, update e2eConfig.js only.
//
//  OBJECT_CODE and CONTAINER_NUMBER are set at runtime:
//    TC001: set manually via OCEAN_OBJECT_CODE env var or direct edit
//    TC002: auto-set in beforeAll by createOceanTrackingObject()
// ─────────────────────────────────────────────────────────────────────────────

const { E2E_CONFIG } = require('../e2e/e2eConfig');

const CONFIG = {
  // ── Webhook (Shippeo → Logward ingestion) ──────────────────────────────────
  WEBHOOK_BASE_URL:  E2E_CONFIG.OCEAN.WEBHOOK_BASE_URL,
  WEBHOOK_PATH:      E2E_CONFIG.OCEAN.WEBHOOK_PATH,
  WEBHOOK_CLIENT_ID: E2E_CONFIG.OCEAN.WEBHOOK_CLIENT_ID,
  WEBHOOK_TOKEN:     E2E_CONFIG.OCEAN.WEBHOOK_TOKEN,

  // ── Admin API (read OTU state) ─────────────────────────────────────────────
  ADMIN_BASE_URL: E2E_CONFIG.ADMIN_BASE_URL,
  ADMIN_TOKEN:    E2E_CONFIG.ADMIN_TOKEN,

  // ── OTU identifiers ────────────────────────────────────────────────────────
  // OBJECT_CODE and CONTAINER_NUMBER are overwritten at runtime by the test
  // beforeAll (TC002) or manually via env var (TC001).
  CONTAINER_NUMBER: process.env.OCEAN_CONTAINER_NUMBER || E2E_CONFIG.OCEAN.CONTAINER_PREFIX + '0000000',
  BOL_NUMBER:       E2E_CONFIG.OCEAN.BL_NUMBER,
  BOOKING_REF:      E2E_CONFIG.OCEAN.BOOKING_NUMBER,
  OBJECT_CODE:      process.env.OCEAN_OBJECT_CODE      || '<SET_AT_RUNTIME>',

  SCHEMA_TYPE: E2E_CONFIG.OCEAN.SCHEMA_TYPE,

  // ── Polling ────────────────────────────────────────────────────────────────
  POLL_INTERVAL_MS: 3000,
  POLL_TIMEOUT_MS:  30000,
};

module.exports = { CONFIG };
