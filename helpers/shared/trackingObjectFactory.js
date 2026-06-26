// ─────────────────────────────────────────────────────────────────────────────
//  helpers/shared/trackingObjectFactory.js
//
//  Creates and reads Logward tracking objects via the Admin API.
//
//  OCEAN upsert endpoint (confirmed from curl):
//    POST /api/tower/data/TUContainer/upsert?createNew=true
//    Body: { "data": [{ ...fields }] }
//
//  VALID creation combos (Auto Tracking Conditions):
//    Option A: containerNumber + bookingNumber + carrierScac
//    Option B: containerNumber + billOfLadingNumber + carrierScac
//    Option C: containerNumber + bookingNumber + billOfLadingNumber + carrierScac
//
//  Container number is generated uniquely per run:
//    Format: {PREFIX}{7-digit epoch tail}   e.g. LGTE1234567
//    Override prefix via E2E_OCEAN_CONTAINER_PREFIX env var.
//
//  Response code extraction:
//    Handles: { data: [{ code }] }  |  [{ code }]  |  { code }
// ─────────────────────────────────────────────────────────────────────────────

const { request } = require('@playwright/test');
const { E2E_CONFIG } = require('./e2eConfig');
const { getAdminToken } = require('./cognitoAuth');

// ── Frozen run timestamp (module-load time, same pattern as payload factories) ─
const _RUN_TS = Date.now();

// ── Header factory — uses Cognito auto-login ───────────────────────────────────
const adminHeaders = async () => ({
  'Authorization': `Bearer ${await getAdminToken()}`,
  'Content-Type':  'application/json',
  'accept':        'application/json, text/plain, */*',
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a unique container number for this test run.
 * Format: {PREFIX}{last-7-digits-of-epoch}  →  e.g. "LGTE1234567"
 *
 * Uses the module-load timestamp so the number is stable within one run
 * (same value if called multiple times in the same spec).
 */
function oceanContainerForRun() {
  const suffix = String(_RUN_TS).slice(-7);
  return `${E2E_CONFIG.OCEAN.CONTAINER_PREFIX}${suffix}`;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the Ocean upsert request payload.
 *
 * Merges default fields from E2E_CONFIG.OCEAN with any caller overrides.
 * The payload is always wrapped in { data: [{ ... }] } as required by the API.
 *
 * Default uses Option C (booking + BL + SCAC + container) — the broadest combo.
 * Remove bookingNumber or billOfLadingNumber if your ATC uses a narrower option.
 *
 * @param [overrides]  Field overrides (e.g. { trackingStatus: 'Active' })
 */
function buildOceanUpsertPayload(overrides = {}) {
  const containerNumber = oceanContainerForRun();
  const cfg = E2E_CONFIG.OCEAN;

  const fields = {
    containerNumber,
    bookingNumber:        cfg.BOOKING_NUMBER,
    billOfLadingNumber:   cfg.BL_NUMBER,
    carrierScac:          cfg.SCAC,
    carrierShortName:     cfg.CARRIER_SHORT_NAME,
    carrierName:          cfg.CARRIER_NAME,
    mot:                  'OCEAN',
    trackingStatus:       'In Progress',
    tsTracking:           false,
    forwarderInputNeeded: 'No',
    ...overrides,
  };

  // Remove null/undefined values so they are not sent in the payload.
  // This allows callers to explicitly exclude fields by passing null.
  Object.keys(fields).forEach(k => {
    if (fields[k] === null || fields[k] === undefined) delete fields[k];
  });

  // Return the actual container number that was used (may differ from auto-generated)
  const actualContainerNumber = fields.containerNumber || containerNumber;
  return { data: [fields], containerNumber: actualContainerNumber };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract the object code from the upsert response.
 *
 * Handles multiple response shapes:
 *   { data: [{ code: "..." }] }   ← most likely (array upsert)
 *   [{ code: "..." }]              ← bare array
 *   { code: "..." }                ← flat object
 *   { data: { code: "..." } }      ← nested object (fallback)
 *
 * @param body
 */
function extractCode(body) {
  // Confirmed response shape from Logward upsert API:
  // { data: {...}, meta: { params: { code: "4e0b4c417078" }, message: "Object Saved..." } }
  if (body?.meta?.params?.code) return String(body.meta.params.code);

  // Fallback shapes
  if (body?.data && Array.isArray(body.data) && body.data[0]?.code) return String(body.data[0].code);
  if (Array.isArray(body) && body[0]?.code) return String(body[0].code);
  if (body?.code)       return String(body.code);
  if (body?.data?.code) return String(body.data.code);
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new Ocean tracking object via the admin upsert API.
 *
 * @param [overrides]  Optional field overrides for this run
 *   code            — Logward internal object code (use for scheduler/GET queries)
 *   containerNumber — the unique container number used (use for Shippeo search + webhook)
 */
async function createOceanTrackingObject(overrides = {}) {
  const cfg = E2E_CONFIG.OCEAN;
  const { data, containerNumber } = buildOceanUpsertPayload(overrides);

  const ctx = await request.newContext({ baseURL: E2E_CONFIG.ADMIN_BASE_URL });

  try {
    const url = `${cfg.UPSERT_PATH}?createNew=${cfg.CREATE_NEW}`;

    const d = data[0];
    console.log(`  [factory] POST ${url}`);
    console.log(`  [factory] containerNumber="${containerNumber}" booking="${d.bookingNumber}" BL="${d.billOfLadingNumber}" SCAC="${d.carrierScac}"`);

    const res = await ctx.post(url, {
      headers: await adminHeaders(),
      data:    { data },
    });

    if (res.status() === 401) {
      throw new Error(
        `Create TUContainer → HTTP 401 Unauthorized.\n` +
        `  Cognito token may have expired. cognitoAuth.js will re-login automatically on next run.`
      );
    }

    if (!res.ok()) {
      const body = await res.text();
      throw new Error(`Create TUContainer → HTTP ${res.status()}\n  ${body}`);
    }

    const body = await res.json();
    console.log(`  [factory] Response:`, JSON.stringify(body).slice(0, 300));

    const code = extractCode(body);

    if (!code) {
      throw new Error(
        `TUContainer upsert succeeded (HTTP ${res.status()}) but no code found in response.\n` +
        `  Response: ${JSON.stringify(body)}\n` +
        `  Update extractCode() in trackingObjectFactory.js to handle this shape.`
      );
    }

    console.log(`  [factory ✅] Created TUContainer → code="${code}" container="${containerNumber}"`);
    return { code, containerNumber };

  } finally {
    await ctx.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read a TUContainer by its internal code (GET).
 * Used to snapshot the object state before sending Events-Out webhooks.
 *
 * @param code  Logward internal object code
 */
async function getOceanTrackingObject(code) {
  const ctx = await request.newContext({ baseURL: E2E_CONFIG.ADMIN_GET_URL });
  try {
    const res = await ctx.get(
      `${E2E_CONFIG.OCEAN.GET_PATH}/${code}`,
      { headers: await adminHeaders() }
    );
    if (!res.ok()) return null;
    const body = await res.json();
    return body.data ?? body;
  } finally {
    await ctx.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Delete a TUContainer by code (optional test cleanup).
 *
 * @param code
 */
async function deleteOceanTrackingObject(code) {
  const ctx = await request.newContext({ baseURL: E2E_CONFIG.ADMIN_GET_URL });
  try {
    const res = await ctx.delete(
      `${E2E_CONFIG.OCEAN.GET_PATH}/${code}`,
      { headers: adminHeaders() }
    );
    console.log(`  [factory] DELETE TUContainer/${code} → HTTP ${res.status()}`);
  } finally {
    await ctx.dispose();
  }
}

module.exports = {
  oceanContainerForRun,
  buildOceanUpsertPayload,
  createOceanTrackingObject,
  getOceanTrackingObject,
  deleteOceanTrackingObject,
};
