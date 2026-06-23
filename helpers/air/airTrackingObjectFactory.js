// @ts-check
// ─────────────────────────────────────────────────────────────────────────────
//  helpers/air/airTrackingObjectFactory.js
//
//  Creates and reads Air Transport Units (ATUs) via the Admin API.
//
//  Upsert endpoint:
//    POST /api/tower/data/airTransportUnit/upsert?createNew=true
//    Body: { "data": [{ ...fields }] }
//
//  ATC rules (Air — similar to Ocean):
//    active = 1  ← trackingStatus === "In Progress"
//    valid  = 1  ← active=1 AND masterAirWaybillNumber
//                            AND (carrierScac OR carrierShortName OR carrierName)
//
//  Unique identifiers generated per run:
//    masterAirWaybillNumber : E2EAIR{seq}{last-5-ts}   e.g. E2EAIR0191234
//    clientReference        : E2ECRF{seq}{last-5-ts}   e.g. E2ECRF0191234
//    (clientReference is the routing key for incoming webhooks)
// ─────────────────────────────────────────────────────────────────────────────

const { request } = require('@playwright/test');
const { CONFIG }  = require('./airConfig');
const { getAdminToken } = require('../e2e/cognitoAuth');

const _RUN_TS = Date.now();
let   _counter = 0;

// ── Header factories ──────────────────────────────────────────────────────────

const adminHeaders = async () => ({
  'Authorization': `Bearer ${await getAdminToken()}`,
  'Content-Type':  'application/json',
  'accept':        'application/json, text/plain, */*',
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a unique MAWB + clientReference pair for this scenario.
 * Both share the same counter/timestamp so they stay paired.
 *
 * @returns {{ mawb: string, clientReference: string }}
 */
function nextATUIds() {
  _counter++;
  const seq = String(_counter).padStart(2, '0');
  const ts  = String(_RUN_TS).slice(-5);
  return {
    mawb:            `E2EAIR${seq}${ts}`,
    clientReference: `E2ECRF${seq}${ts}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the ATU upsert payload.
 * Merges generated MAWB/clientRef with any caller overrides.
 * Strips null/undefined fields so the API ignores missing ones.
 *
 * @param [overrides]  Field overrides (e.g. { trackingStatus: 'Pending' })
 * @returns {{ data: object[], mawb: string, clientReference: string }}
 */
function buildAirUpsertPayload(overrides = {}) {
  const { mawb, clientReference } = nextATUIds();

  const fields = {
    masterAirWaybillNumber: mawb,
    clientReference,
    mot:           'AIR',
    trackingStatus: 'In Progress',
    ...overrides,
  };

  // Pass null to explicitly exclude a field from creation payload
  Object.keys(fields).forEach(k => {
    if (fields[k] === null || fields[k] === undefined) delete fields[k];
  });

  return {
    data:            [fields],
    mawb:            fields.masterAirWaybillNumber ?? mawb,
    clientReference: fields.clientReference        ?? clientReference,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract the Logward object code from an upsert response.
 * Handles the same shapes as the Ocean factory.
 *
 * @param body
 */
function extractCode(body) {
  if (body?.meta?.params?.code) return String(body.meta.params.code);
  if (body?.data && Array.isArray(body.data) && body.data[0]?.code) return String(body.data[0].code);
  if (Array.isArray(body) && body[0]?.code) return String(body[0].code);
  if (body?.code)       return String(body.code);
  if (body?.data?.code) return String(body.data.code);
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a fresh ATU via the admin upsert API.
 *
 * @param [overrides]  Optional field overrides for this scenario.
 *   Pass null to explicitly strip a field (e.g. { masterAirWaybillNumber: null }).
 * @returns {{ code: string, mawb: string, clientReference: string }}
 */
async function createAirTrackingObject(overrides = {}) {
  const { data, mawb, clientReference } = buildAirUpsertPayload(overrides);
  const ctx = await request.newContext({ baseURL: CONFIG.ADMIN_UPSERT_BASE_URL });

  try {
    const url = `${CONFIG.UPSERT_PATH}?createNew=true`;
    console.log(`  [airFactory] POST ${url}`);
    console.log(`  [airFactory] mawb="${mawb}" clientRef="${clientReference}"`);

    const res = await ctx.post(url, {
      headers: await adminHeaders(),
      data:    { data },
    });

    if (res.status() === 401) {
      throw new Error('Create airTransportUnit → HTTP 401. cognitoAuth.js will re-login automatically.');
    }
    if (!res.ok()) {
      const body = await res.text();
      throw new Error(`Create airTransportUnit → HTTP ${res.status()}\n  ${body}`);
    }

    const body = await res.json();
    console.log(`  [airFactory] Response:`, JSON.stringify(body).slice(0, 300));

    const code = extractCode(body);
    if (!code) {
      throw new Error(
        `airTransportUnit upsert OK (HTTP ${res.status()}) but no code in response.\n` +
        `  ${JSON.stringify(body)}\n` +
        `  Update extractCode() if the response shape differs.`
      );
    }

    console.log(`  [airFactory ✅] Created ATU → code="${code}" mawb="${mawb}" clientRef="${clientReference}"`);
    return { code, mawb, clientReference };

  } finally {
    await ctx.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read an ATU by its internal Logward code (GET).
 *
 * @param code  Logward internal object code
 */
async function getAirTrackingObject(code) {
  const ctx = await request.newContext({ baseURL: CONFIG.ADMIN_BASE_URL });
  try {
    const res = await ctx.get(
      `${CONFIG.GET_PATH}/${code}`,
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
 * Update an existing ATU by code (upsert with createNew=false).
 *
 * @param code          Logward internal object code
 * @param updateFields  Fields to set (null removes a field)
 */
async function updateAirTrackingObject(code, updateFields = {}) {
  const ctx = await request.newContext({ baseURL: CONFIG.ADMIN_UPSERT_BASE_URL });
  try {
    const fields = { code, ...updateFields };
    Object.keys(fields).forEach(k => {
      if (fields[k] === null || fields[k] === undefined) delete fields[k];
    });
    const res = await ctx.post(`${CONFIG.UPSERT_PATH}?createNew=false`, {
      headers: await adminHeaders(),
      data:    { data: [fields] },
    });
    console.log(`  [airFactory] UPDATE ATU code=${code} → HTTP ${res.status()}`);
    const body = await res.text().catch(() => '');
    if (!res.ok()) {
      throw new Error(`Update airTransportUnit → HTTP ${res.status()}\n  ${body}`);
    }
  } finally {
    await ctx.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  nextATUIds,
  buildAirUpsertPayload,
  createAirTrackingObject,
  getAirTrackingObject,
  updateAirTrackingObject,
};
