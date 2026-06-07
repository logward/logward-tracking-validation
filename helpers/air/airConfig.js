// @ts-check
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
   * Override via: export AIR_WEBHOOK_TOKEN="eyJ..."
   */
  WEBHOOK_TOKEN: process.env.AIR_WEBHOOK_TOKEN ||
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2NvdW50SWQiOiIwMDEwUTAwMDAwVFpvc1FRQVQiLCJjb2RlIjoiRkVlRzV0S2hrM3RXIiwiZXhwIjoxODA4NzYzMzAwLCJpc3MiOiJodHRwczovL2NvZ25pdG8taWRwLmV1LWNlbnRyYWwtMS5hbWF6b25hd3MuY29tL2V1LWNlbnRyYWwtMV9HSWwxaXpUN0IiLCJhdWQiOiJsb2d3YXJkLmNvbSJ9.N8lDfXx42AnxfW82RvgY-fTrPikKhqPxZD7crGWmB1A',
  // ── Admin API (read ATU state) ─────────────────────────────────────────────
  ADMIN_BASE_URL: 'https://qa-admin.logward.engineering',

  /**
   * ⚠️  Cognito access token — expires every ~1 hour.
   *
   * When tests fail with HTTP 401 on the GET call:
   *   1. Log in to https://qa-admin.logward.engineering
   *   2. Open DevTools → Network → any admin request → Authorization header
   *   3. Copy the Bearer token value
   *   4. export AIR_ADMIN_TOKEN="eyJ..."
   *   5. Re-run the test
   */
  ADMIN_TOKEN: process.env.AIR_ADMIN_TOKEN ||
    'eyJraWQiOiJIOU5CdVoyb3NWN0hpTG9WaEtPWC8xZENkdHlBNmdOMzd0N3NQL0MyT0xRPSIsImFsZyI6IlJTMjU2In0.eyJzdWIiOiJjMzUwOWFhMy02NDM0LTQ0ODktYjcwOC01OTQ3NTRiMjk0ZjgiLCJjb2duaXRvOmdyb3VwcyI6WyJDdXN0b21lckFkbWluIl0sImlzcyI6Imh0dHBzOi8vY29nbml0by1pZHAuZXUtY2VudHJhbC0xLmFtYXpvbmF3cy5jb20vZXUtY2VudHJhbC0xX0dJbDFpelQ3QiIsImNsaWVudF9pZCI6Im1ocTZoN3Y2bjJjZHZqOW1zam9vcThraDQiLCJvcmlnaW5fanRpIjoiM2ZlZjM4YzgtY2ZlZC00ODRkLWFjYWItYzI2NGVkYzNjZjhmIiwiZXZlbnRfaWQiOiI2ZjllMjcxZC1lYzUzLTRhNDItOTYwMy00ZjgzYzQ0ZDk4ZjAiLCJ0b2tlbl91c2UiOiJhY2Nlc3MiLCJzY29wZSI6ImF3cy5jb2duaXRvLnNpZ25pbi51c2VyLmFkbWluIiwiYXV0aF90aW1lIjoxNzgwMDMyNTI4LCJleHAiOjE3ODAwNjMyNDMsImlhdCI6MTc4MDA1OTY0MywianRpIjoiZmUwZjA1OTgtMjc2OC00NzkzLWEzODMtNmRkYjg2YjI1ZGRmIiwidXNlcm5hbWUiOiJjMzUwOWFhMy02NDM0LTQ0ODktYjcwOC01OTQ3NTRiMjk0ZjgifQ.hxcXSO9LD6wo8-So-hW9TnsmGIp-dY3pOcgp_PH3HkHTosiDeqSJEeKjpcJCpM7_386CguFnlCjfHGU1zTwxB6eRoltip7lexNciloqrZ6CixY8CqzY5DPRWcIQbpxunqULC3JvKXCBGSjUv93CFyJpRV_oVMIOnFW1-MnBQpAyGRoaBoL2mp7oZoxtM3amNUgjjtIBn-s0Yw6ZAH7ltGnRFOrpDvn1a9byfhcWQCWKDJooISfVKi79pjGBtAiQ0fhNXAzVNhgbZmAvxog7SerV0jJhAcy1qct5cC-XMlVPG_Ii7LgMqFxSIwXPUG3CsAa4Y1r08A1xvAtk8fgEYxg',
  CUSTOMER_REF:  'CARGO-TRACK-1209',         // clientReference ← order.client_reference  (primary identifier)
  MAWB_NUMBER:   '',  // order.edi_reference / order.reference  (in payload; no ATU field mapping)
  OBJECT_CODE:   'e825ce4610cc',  // Logward internal object code (used for GET /airTransportUnit/:code)

  SCHEMA_TYPE: 'airTransportUnit',

  // ── Polling ────────────────────────────────────────────────────────────────
  POLL_INTERVAL_MS: 3000,
  POLL_TIMEOUT_MS:  30000,
};

module.exports = { CONFIG };
