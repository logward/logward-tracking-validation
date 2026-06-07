// @ts-check
// ─────────────────────────────────────────────────────────────────────────────
//  helpers/air/airApiHelpers.js
//
//  HTTP helpers for AIR tracking tests:
//    webhookHeaders()      → Authorization + ClientId headers for POST
//    adminHeaders()        → Authorization header for GET
//    sendWebhook(ctx, p)   → POST to the Shippeo air_tracking endpoint
//    getATU(ctx)           → GET /api/tower/data/airTransportUnit/:code
//    pollUntilUpdated(...) → poll until ATU.changedAt differs from baseline
//    sendAndWait(payload)  → all-in-one: snapshot → POST → poll → return ATU
// ─────────────────────────────────────────────────────────────────────────────

const { request } = require('@playwright/test');
const { CONFIG }  = require('./airConfig');

// ── Header factories ──────────────────────────────────────────────────────────
const webhookHeaders = () => ({
  'Content-Type':  'application/json',
  'ClientId':      CONFIG.WEBHOOK_CLIENT_ID,
  'Authorization': `Bearer ${CONFIG.WEBHOOK_TOKEN}`,
});

const adminHeaders = () => ({
  'Authorization': `Bearer ${CONFIG.ADMIN_TOKEN}`,
  'accept':        'application/json',
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST a Shippeo payload to the air_tracking webhook.
 *
 * @param {import('@playwright/test').APIRequestContext} ctx
 * @param {object} payload
 */
async function sendWebhook(ctx, payload) {
  return ctx.post(CONFIG.WEBHOOK_PATH, { headers: webhookHeaders(), data: payload });
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET the ATU from the admin API.
 * Throws an actionable error on HTTP 401 (expired Cognito token).
 *
 * @param {import('@playwright/test').APIRequestContext} ctx
 * @returns {Promise<object>}
 */
async function getATU(ctx) {
  const res = await ctx.get(
    `/api/tower/data/${CONFIG.SCHEMA_TYPE}/${CONFIG.OBJECT_CODE}`,
    { headers: adminHeaders() }
  );

  if (res.status() === 401) {
    throw new Error(
      `GET ATU → HTTP 401 Unauthorized.\n` +
      `  The AIR_ADMIN_TOKEN has expired (Cognito tokens last ~1 hour).\n` +
      `  Fix:\n` +
      `    1. Log in to https://qa-admin.logward.engineering\n` +
      `    2. Copy the Bearer token from DevTools → Network → any request → Authorization header\n` +
      `    3. export AIR_ADMIN_TOKEN="eyJ..."\n` +
      `    4. Re-run the test`
    );
  }

  if (res.status() !== 200) {
    throw new Error(
      `GET ATU /airTransportUnit/${CONFIG.OBJECT_CODE} → HTTP ${res.status()}`
    );
  }

  const body = await res.json();
  return body.data ?? body;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Poll the ATU until ATU.changedAt differs from `baseline`.
 *
 * Strategy:
 *   Gate 1 (changedAt): confirms the BE wrote the ATU after our webhook.
 *   Workers = 1 (serial) → no concurrent writes possible.
 *
 * Falls back to the latest snapshot on timeout so field assertions show the
 * actual vs expected diff rather than a null error.
 *
 * @param {import('@playwright/test').APIRequestContext} ctx
 * @param {string | null} baseline  ATU.changedAt before the webhook was sent
 * @returns {Promise<object>}
 */
async function pollUntilUpdated(ctx, baseline) {
  const deadline = Date.now() + CONFIG.POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const atu = await getATU(ctx).catch(() => null);
    if (atu) {
      if (atu.lastChangedAt !== baseline) {
        console.log(`  [poll ✅] lastChangedAt changed: ${baseline} → ${atu.lastChangedAt}`);
        return atu;
      }
      console.log(`  [poll ⏳] lastChangedAt still "${atu.lastChangedAt}" (baseline="${baseline}") — waiting…`);
    }
    await new Promise(r => setTimeout(r, CONFIG.POLL_INTERVAL_MS));
  }

  // Timeout — return latest snapshot for diff
  console.warn(`  [poll ⚠️] Timed out after ${CONFIG.POLL_TIMEOUT_MS}ms. Returning latest snapshot.`);
  return getATU(ctx).catch(() => null);
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * All-in-one helper:
 *   ① Snapshot ATU (record changedAt as baseline)
 *   ② POST webhook payload
 *   ③ Brief stabilisation delay
 *   ④ Poll until ATU.changedAt changes (confirms BE processed the event)
 *   ⑤ Return { status, atu, before }
 *
 * Creates and disposes its own APIRequestContext instances so it can be used
 * inside beforeAll/test without requiring shared context setup.
 *
 * @param {object} payload  Full Shippeo webhook payload (built via makePayload())
 * @returns {Promise<{ status: number, atu: object | null, before: object | null }>}
 */
async function sendAndWait(payload) {
  const adminCtx   = await request.newContext({ baseURL: CONFIG.ADMIN_BASE_URL });
  const webhookCtx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });

  // Snapshot BEFORE
  const before   = await getATU(adminCtx).catch(() => null);
  const baseline = before?.lastChangedAt ?? null;
  console.log(`  [sendAndWait] ATU before → code=${before?.code} lastChangedAt=${baseline}`);

  // Fire webhook
  const res    = await sendWebhook(webhookCtx, payload);
  const status = res.status();
  console.log(`  [sendAndWait] Webhook HTTP ${status} | event="${payload.situation?.event}" date="${payload.situation?.date}"`);

  // Brief stabilisation (give the service time to start processing)
  await new Promise(r => setTimeout(r, 1500));

  // Poll until changedAt changes
  const atu = await pollUntilUpdated(adminCtx, baseline);
  console.log(`  [sendAndWait] ATU after  → lastChangedAt=${atu?.lastChangedAt}`);

  await adminCtx.dispose();
  await webhookCtx.dispose();
  return { status, atu, before };
}

module.exports = {
  webhookHeaders,
  adminHeaders,
  sendWebhook,
  getATU,
  pollUntilUpdated,
  sendAndWait,
};
