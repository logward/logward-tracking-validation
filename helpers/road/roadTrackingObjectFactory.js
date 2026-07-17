// @ts-check
// ─────────────────────────────────────────────────────────────────────────────
//  helpers/road/roadTrackingObjectFactory.js
//
//  Creates, reads, and updates Road Transport Units (RTUs) via the Admin API.
//
//  Upsert endpoint:
//    POST /api/tower/data/TransportUnitRoad/upsert?createNew=true
//    Body: { "data": [{ ...fields }] }
//
//  ATC rules (Road):
//    active = 1  ← trackingStatus === "In Progress"
//    valid  = 1  ← active=1 AND all required road fields present:
//                  carrierId,
//                  transportOrderId, licensePlateTruck, loadType,
//                  pickupAddressName, pickupAddressStreet, pickupAddressZipcode,
//                  pickupAddressCity, pickupAddressCountry,
//                  deliveryLocationName, deliveryLocationStreet, deliveryLocationZipcode,
//                  deliveryLocationCity, deliveryLocationCountry,
//                  pickUpStartDate, pickUpEndDate, pickUpTimeZone,
//                  deliveryStartDate, deliveryEndDate, deliveryTimeZone
//
//  Date constraints:
//    pickUpStartDate < pickUpEndDate < deliveryStartDate < deliveryEndDate
//    Pickup and delivery addresses must differ (city/country)
// ─────────────────────────────────────────────────────────────────────────────

const { request } = require('@playwright/test');
const { CONFIG }  = require('./roadConfig');
const { getAdminToken } = require('../shared/cognitoAuth');

const _RUN_TS = Date.now();
let   _counter = 0;

// ── Header factory ────────────────────────────────────────────────────────────

const adminHeaders = async () => ({
  'Authorization': `Bearer ${await getAdminToken()}`,
  'Content-Type':  'application/json',
  'accept':        'application/json, text/plain, */*',
});

// ── Date helpers ──────────────────────────────────────────────────────────────

function fmtDate(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/**
 * Generate a set of road shipment dates that satisfy:
 *   pickUpStartDate < pickUpEndDate < deliveryStartDate < deliveryEndDate
 *
 * @param baseOffsetDays  Days from today for pickUpStartDate (default 22)
 */
function roadDates(baseOffsetDays = 22) {
  const base = new Date();
  const add = days => {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + days);
    d.setUTCHours(9, 0, 0, 0);
    return fmtDate(d);
  };
  return {
    pickUpStartDate:   add(baseOffsetDays),
    pickUpEndDate:     add(baseOffsetDays + 2),
    deliveryStartDate: add(baseOffsetDays + 5),
    deliveryEndDate:   add(baseOffsetDays + 7),
  };
}

// ── ID generator ──────────────────────────────────────────────────────────────

function nextRTUIds() {
  _counter++;
  const seq = String(_counter).padStart(2, '0');
  const ts  = String(_RUN_TS).slice(-5);
  return {
    transportOrderId:  `E2ERDT${seq}${ts}`,
    licensePlateTruck: `E2ELPT${seq}${ts}`,
  };
}

// ── Payload builder ───────────────────────────────────────────────────────────

const PICKUP_DEFAULT = {
  pickupAddressName:    'Test Pickup Depot',
  pickupAddressStreet:  'MG Road',
  pickupAddressZipcode: '560001',
  pickupAddressCity:    'Bangalore',
  pickupAddressCountry: 'IN',
  pickUpTimeZone:       'Asia/Kolkata',
};

const DELIVERY_DEFAULT = {
  deliveryLocationName:    'Test Delivery Hub',
  deliveryLocationStreet:  'Hauptstrasse 10',
  deliveryLocationZipcode: '60311',
  deliveryLocationCity:    'Frankfurt',
  deliveryLocationCountry: 'DE',
  deliveryTimeZone:        'Europe/Berlin',
};

/**
 * Build the RTU upsert payload.
 * Pass null for a field to explicitly exclude it (simulates missing required field).
 *
 * @param [overrides]
 * @returns {{ data: object[], transportOrderId: string, licensePlateTruck: string }}
 */
function buildRoadUpsertPayload(overrides = {}) {
  const { transportOrderId, licensePlateTruck } = nextRTUIds();
  const dates = roadDates();

  const fields = {
    mot:              'ROAD',
    modeOfTransport:  'Truck',
    orderStatus:      'Active',
    trackingStatus:   'In Progress',
    loadType:         'ftl',
    carrierId:        'C1',
    transportOrderId,
    licensePlateTruck,
    ...PICKUP_DEFAULT,
    ...DELIVERY_DEFAULT,
    ...dates,
    ...overrides,
  };

  // null/undefined = intentionally excluded field
  Object.keys(fields).forEach(k => {
    if (fields[k] === null || fields[k] === undefined) delete fields[k];
  });

  return {
    data:              [fields],
    transportOrderId:  fields.transportOrderId  ?? transportOrderId,
    licensePlateTruck: fields.licensePlateTruck ?? licensePlateTruck,
  };
}

// ── Code extractor ────────────────────────────────────────────────────────────

function extractCode(body) {
  if (body?.meta?.params?.code)                                  return String(body.meta.params.code);
  if (body?.data && Array.isArray(body.data) && body.data[0]?.code) return String(body.data[0].code);
  if (Array.isArray(body) && body[0]?.code)                     return String(body[0].code);
  if (body?.code)                                                return String(body.code);
  if (body?.data?.code)                                          return String(body.data.code);
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create a fresh RTU via the admin upsert API.
 *
 * @param [overrides]  Field overrides — pass null to strip a required field.
 * @returns {{ code: string, transportOrderId: string, licensePlateTruck: string }}
 */
async function createRoadTrackingObject(overrides = {}) {
  const { data, transportOrderId, licensePlateTruck } = buildRoadUpsertPayload(overrides);
  const ctx = await request.newContext({ baseURL: CONFIG.ADMIN_UPSERT_BASE_URL });

  try {
    const url = `${CONFIG.UPSERT_PATH}?createNew=true`;
    console.log(`  [roadFactory] POST ${url}`);
    console.log(`  [roadFactory] transportOrderId="${transportOrderId}" plate="${licensePlateTruck}"`);

    const res = await ctx.post(url, {
      headers: await adminHeaders(),
      data:    { data },
    });

    if (res.status() === 401) throw new Error('Create TransportUnitRoad → HTTP 401. cognitoAuth will re-login.');
    if (!res.ok()) {
      const body = await res.text();
      throw new Error(`Create TransportUnitRoad → HTTP ${res.status()}\n  ${body}`);
    }

    const body = await res.json();
    console.log(`  [roadFactory] Response:`, JSON.stringify(body).slice(0, 300));

    const code = extractCode(body);
    if (!code) {
      throw new Error(
        `TransportUnitRoad upsert OK but no code in response.\n` +
        `  ${JSON.stringify(body)}\n` +
        `  Update extractCode() if the response shape differs.`
      );
    }

    console.log(`  [roadFactory ✅] Created RTU → code="${code}" orderId="${transportOrderId}"`);
    return { code, transportOrderId, licensePlateTruck };

  } finally {
    await ctx.dispose();
  }
}

/**
 * Read an RTU by its internal Logward code (GET).
 */
async function getRoadTrackingObject(code) {
  const ctx = await request.newContext({ baseURL: CONFIG.ADMIN_BASE_URL });
  try {
    const res = await ctx.get(`${CONFIG.GET_PATH}/${code}`, { headers: await adminHeaders() });
    if (!res.ok()) return null;
    const body = await res.json();
    return body.data ?? body;
  } finally {
    await ctx.dispose();
  }
}

/**
 * Update an existing RTU by code (upsert with createNew=false).
 */
async function updateRoadTrackingObject(code, updateFields = {}) {
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
    console.log(`  [roadFactory] UPDATE RTU code=${code} → HTTP ${res.status()}`);
    if (!res.ok()) {
      const body = await res.text().catch(() => '');
      throw new Error(`Update TransportUnitRoad → HTTP ${res.status()}\n  ${body}`);
    }
  } finally {
    await ctx.dispose();
  }
}

module.exports = {
  nextRTUIds,
  roadDates,
  buildRoadUpsertPayload,
  createRoadTrackingObject,
  getRoadTrackingObject,
  updateRoadTrackingObject,
};
