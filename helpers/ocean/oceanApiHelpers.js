// ─────────────────────────────────────────────────────────────────────────────
//  helpers/ocean/oceanApiHelpers.js
//
//  HTTP helpers for OCEAN tracking tests:
//    webhookHeaders()       → Authorization + clientId headers for POST
//    adminHeaders()         → Authorization header for GET
//    sendWebhook(ctx, p)    → POST to the Shippeo ocean_order_event_out endpoint
//    getOTU(ctx)            → GET /api/tower/data/oceanTransportUnit/:code
//    pollUntilUpdated(...)  → poll until OTU.lastChangedAt differs from baseline
//    sendAndWait(payload)   → all-in-one: snapshot → POST → poll → return OTU
// ─────────────────────────────────────────────────────────────────────────────

const { request } = require('@playwright/test');
const { CONFIG }  = require('./oceanConfig');

// ── Header factories ──────────────────────────────────────────────────────────
const webhookHeaders = () => ({
  'Content-Type':  'application/json',
  'clientId':      CONFIG.WEBHOOK_CLIENT_ID,
  'Authorization': `Bearer ${CONFIG.WEBHOOK_TOKEN}`,
});

const adminHeaders = () => ({
  'Authorization': `Bearer ${CONFIG.ADMIN_TOKEN}`,
  'accept':        'application/json',
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST a Shippeo payload to the ocean tracking webhook.
 *
 * @param ctx
 * @param payload
 */
async function sendWebhook(ctx, payload) {
  return ctx.post(CONFIG.WEBHOOK_PATH, { headers: webhookHeaders(), data: payload });
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET the OTU from the admin API.
 * Throws an actionable error on HTTP 401 (expired Cognito token).
 *
 * @param ctx
 */
async function getOTU(ctx) {
  const res = await ctx.get(
    `/api/tower/data/${CONFIG.SCHEMA_TYPE}/${CONFIG.OBJECT_CODE}`,
    { headers: adminHeaders() }
  );

  if (res.status() === 401) {
    throw new Error(
      `GET OTU → HTTP 401 Unauthorized.\n` +
      `  The OCEAN_ADMIN_TOKEN has expired (Cognito tokens last ~1 hour).\n` +
      `  Fix:\n` +
      `    1. Log in to https://sandbox-admin.logward.com\n` +
      `    2. Copy the Bearer token from DevTools → Network → any request → Authorization header\n` +
      `    3. export OCEAN_ADMIN_TOKEN="eyJ..."\n` +
      `    4. Re-run the test`
    );
  }

  if (res.status() !== 200) {
    throw new Error(
      `GET OTU /oceanTransportUnit/${CONFIG.OBJECT_CODE} → HTTP ${res.status()}`
    );
  }

  const body = await res.json();
  return body.data ?? body;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Poll the OTU until OTU.lastChangedAt differs from `baseline`.
 *
 * Falls back to the latest snapshot on timeout so field assertions show the
 * actual vs expected diff rather than a null error.
 *
 * @param ctx
 * @param baseline  OTU.lastChangedAt before the webhook was sent
 */
async function pollUntilUpdated(ctx, baseline) {
  const deadline = Date.now() + CONFIG.POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const otu = await getOTU(ctx).catch(() => null);
    if (otu) {
      if (otu.lastChangedAt !== baseline) {
        console.log(`  [poll ✅] lastChangedAt changed: ${baseline} → ${otu.lastChangedAt}`);
        return otu;
      }
      console.log(`  [poll ⏳] lastChangedAt still "${otu.lastChangedAt}" (baseline="${baseline}") — waiting…`);
    }
    await new Promise(r => setTimeout(r, CONFIG.POLL_INTERVAL_MS));
  }

  console.warn(`  [poll ⚠️] Timed out after ${CONFIG.POLL_TIMEOUT_MS}ms. Returning latest snapshot.`);
  return getOTU(ctx).catch(() => null);
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * All-in-one helper:
 *   ① Snapshot OTU (record lastChangedAt as baseline)
 *   ② POST webhook payload
 *   ③ Brief stabilisation delay
 *   ④ Poll until OTU.lastChangedAt changes (confirms BE processed the event)
 *   ⑤ Return { status, otu, before }
 *
 * Creates and disposes its own APIRequestContext instances so it can be used
 * inside beforeAll/test without requiring shared context setup.
 *
 * @param payload  Full Shippeo webhook payload (built via makePayload())
 */
async function sendAndWait(payload) {
  const adminCtx   = await request.newContext({ baseURL: CONFIG.ADMIN_BASE_URL });
  const webhookCtx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });

  // Snapshot BEFORE
  const before   = await getOTU(adminCtx).catch(() => null);
  const baseline = before?.lastChangedAt ?? null;
  console.log(`  [sendAndWait] OTU before → code=${before?.code} lastChangedAt=${baseline}`);

  // Fire webhook
  const res    = await sendWebhook(webhookCtx, payload);
  const status = res.status();
  console.log(`  [sendAndWait] Webhook HTTP ${status} | event="${payload.situation?.event}" type="${payload.situation?.type}" placeType="${payload.event_site?.place_type}" date="${payload.situation?.date}"`);

  // Brief stabilisation (give the service time to start processing)
  await new Promise(r => setTimeout(r, 1500));

  // Poll until lastChangedAt changes
  const otu = await pollUntilUpdated(adminCtx, baseline);
  console.log(`  [sendAndWait] OTU after  → lastChangedAt=${otu?.lastChangedAt}`);

  await adminCtx.dispose();
  await webhookCtx.dispose();
  return { status, otu, before };
}

module.exports = {
  webhookHeaders,
  adminHeaders,
  sendWebhook,
  getOTU,
  pollUntilUpdated,
  sendAndWait,
};
