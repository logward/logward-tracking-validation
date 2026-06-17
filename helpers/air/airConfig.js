// @ts-check
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

// ─────────────────────────────────────────────────────────────────────────────
//  helpers/air/airConfig.js
//
//  Centralised config for all AIR tracking tests.
//  Tokens & required identifiers — edit only here, not in every test file.
//
//  Required ENV vars (refresh every ~1 hour for admin token):
//    export AIR_ADMIN_TOKEN="eyJ..."    ← Cognito access token (expires ~1 h)
//    export AIR_WEBHOOK_TOKEN="eyJ..."  ← long-lived webhook JWT (exp ~2027)
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG = {
  // ── Webhook (Shippeo → Logward ingestion) ──────────────────────────────────
  WEBHOOK_BASE_URL:  'https://qa.logward.engineering',
  WEBHOOK_PATH:      '/api/integration-hub/tracking/shippeo/air_tracking',
  WEBHOOK_CLIENT_ID: 'okOiGTvE9mJ6jwxbSZ',

  /**
   * Long-lived webhook JWT (expires ~2027).
   * Set via: AIR_WEBHOOK_TOKEN in .env
   */
  WEBHOOK_TOKEN: process.env.AIR_WEBHOOK_TOKEN,
  // ── Admin API (read ATU state) ─────────────────────────────────────────────
  ADMIN_BASE_URL: 'https://qa-admin.logward.engineering',

  /**
   * ⚠️  Cognito access token — expires every ~1 hour.
   *
   * When tests fail with HTTP 401 on the GET call:
   *   1. Log in to https://qa-admin.logward.engineering
   *   2. Open DevTools → Network → any admin request → Authorization header
   *   3. Copy the Bearer token value and set AIR_ADMIN_TOKEN in .env
   */
  ADMIN_TOKEN: process.env.AIR_ADMIN_TOKEN,
  CUSTOMER_REF:  'CARGO-TRACK-1209',         // clientReference ← order.client_reference  (primary identifier)
  MAWB_NUMBER:   '',  // order.edi_reference / order.reference  (in payload; no ATU field mapping)
  OBJECT_CODE:   'e825ce4610cc',  // Logward internal object code (used for GET /airTransportUnit/:code)

  SCHEMA_TYPE: 'airTransportUnit',

  // ── Polling ────────────────────────────────────────────────────────────────
  POLL_INTERVAL_MS: 3000,
  POLL_TIMEOUT_MS:  30000,
};

module.exports = { CONFIG };
