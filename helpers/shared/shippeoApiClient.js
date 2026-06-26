// ─────────────────────────────────────────────────────────────────────────────
//  helpers/shared/shippeoApiClient.js
//
//  Shippeo Partner API client for Orders-In verification.
//  Used to confirm that an order created in Logward was successfully
//  synchronized to Shippeo and is searchable.
//
//  Ocean search formats (from the E2E strategy doc):
//    Scenario 1 (Booking + Container):  "BookingNumber_ContainerNumber"
//    Scenario 2 (Booking + BL + Container): "BookingNumber_BLNumber_ContainerNumber"
//    Scenario 3 (BL + Container):       "BLNumber_ContainerNumber"
//
//  Air search:
//    masterAirWaybillNumber | houseAirWaybillNumber | airCustomerReference
//
//  Road search:
//    TransportOrderId
//
//  ⚠️  Adjust SHIPPEO.searchPath and SHIPPEO.searchParamKey in e2eConfig.js
//  to match the actual Shippeo API specification.
// ─────────────────────────────────────────────────────────────────────────────

const { request } = require('@playwright/test');
const { E2E_CONFIG } = require('./e2eConfig');
const { getShippeoToken } = require('./shippeoAuth');

// ── Header factory ────────────────────────────────────────────────────────────
const shippeoHeaders = async () => ({
  'Authorization': `Bearer ${await getShippeoToken()}`,
  'Content-Type':  'application/json',
  'accept':        'application/json',
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the Shippeo search reference for Ocean.
 *
 * Mirrors the `uniqueReference` field in the xtrackings MongoDB collection:
 *   bookingId_containerId       ← when booking number was used to register
 *   billOfLadingId_containerId  ← when BL number was used to register
 *
 * Preference: bookingNumber > blNumber (pass both if available; the service
 * uses whichever was set as the primary identifier at order creation).
 *
 * @param ids
 */
function buildOceanReference({ bookingNumber, blNumber, containerNumber }) {
  if (bookingNumber) return `${bookingNumber}_${containerNumber}`;
  if (blNumber)      return `${blNumber}_${containerNumber}`;
  throw new Error('buildOceanReference: either bookingNumber or blNumber is required');
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Search Shippeo for a shipment using the provided reference string.
 *
 * Returns the first matching shipment object, or null if not found.
 *
 * @param reference  The search reference (e.g. "BOOK123_CNT001")
 */
async function searchShippeoShipment(reference) {
  const ctx = await request.newContext({ baseURL: E2E_CONFIG.SHIPPEO.baseUrl });

  try {
    const url    = E2E_CONFIG.SHIPPEO.searchPath;
    const params = { [E2E_CONFIG.SHIPPEO.searchParamKey]: reference };

    const res = await ctx.get(url, {
      headers: await shippeoHeaders(),
      params,
    });

    console.log(`  [shippeo] Search "${reference}" → HTTP ${res.status()}`);

    if (!res.ok()) {
      console.warn(`  [shippeo] Non-OK response: ${res.status()} ${await res.text()}`);
      return null;
    }

    const body = await res.json();
    // Handle both array and paginated { data: [...] } response shapes
    const results = Array.isArray(body) ? body : (body.data ?? body.orders ?? body.shipments ?? []);
    return results.length > 0 ? results[0] : null;

  } finally {
    await ctx.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Poll Shippeo until the shipment is found, or timeout.
 *
 * @param reference
 * @param [timeoutMs]
 */
async function pollUntilShippeoShipmentFound(reference, timeoutMs = E2E_CONFIG.SHIPPEO_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const shipment = await searchShippeoShipment(reference).catch(() => null);
    if (shipment) {
      console.log(`  [shippeo ✅] Shipment found for reference="${reference}"`);
      return shipment;
    }
    console.log(`  [shippeo ⏳] Not yet found — reference="${reference}". Retrying…`);
    await new Promise(r => setTimeout(r, E2E_CONFIG.POLL_INTERVAL_MS));
  }

  console.warn(`  [shippeo ⚠️] Timed out after ${timeoutMs}ms.`);
  return searchShippeoShipment(reference).catch(() => null);
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch Shippeo order debug details by hashId.
 * URL: GET /core/ocean/order/{hashId}/debug/details
 *
 * @param hashId  e.g. "JXRX7P7J" — from search result's `hashid` field
 */
async function getShippeoOrderDetails(hashId) {
  const ctx = await request.newContext({ baseURL: E2E_CONFIG.SHIPPEO.baseUrl });
  try {
    const path = `/core/ocean/order/${hashId}/debug/details`;
    const res  = await ctx.get(path, { headers: await shippeoHeaders() });
    console.log(`  [shippeo-details] GET ${path} → HTTP ${res.status()}`);
    if (!res.ok()) {
      console.warn(`  [shippeo-details] Non-OK: ${await res.text().catch(() => '')}`);
      return null;
    }
    return await res.json();
  } finally {
    await ctx.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Assert that a Shippeo order's details match the OTU identifiers we created.
 * Skips status field as requested.
 *
 * Returns a structured result for the HTML report.
 *
 * @param details   Response from getShippeoOrderDetails()
 * @param expected  { containerNumber, bookingNumber, blNumber, scac, carrierName }
 * @returns         { allPass, rows: [{label, expected, actual, pass, skipped}] }
 */
function assertShippeoOrderDetails(details, { containerNumber, bookingNumber, blNumber, scac, carrierName }) {
  const { expect } = require('@playwright/test');
  const BAR = '─'.repeat(66);
  const rows = [];

  function check(label, actual, expected, skipReason) {
    if (skipReason) {
      rows.push({ label, expected: '—', actual: '—', pass: true, skipped: true, skipReason });
      console.log(`  ${label.padEnd(32)} — skipped (${skipReason})`);
      return;
    }
    const pass = actual === expected;
    rows.push({ label, expected, actual, pass, skipped: false });
    console.log(`  ${label.padEnd(32)} = "${actual}"  ${pass ? '✅' : '❌'}  (expected: "${expected}")`);
    expect(pass, `[Shippeo Details] ${label}: expected "${expected}" got "${actual}"`).toBe(true);
  }

  function checkContains(label, list, expectedValue, skipReason) {
    if (skipReason) {
      rows.push({ label, expected: '—', actual: '—', pass: true, skipped: true, skipReason });
      console.log(`  ${label.padEnd(32)} — skipped (${skipReason})`);
      return;
    }
    const actual  = (list || []).join(', ');
    const pass    = (list || []).includes(expectedValue);
    rows.push({ label, expected: expectedValue, actual, pass, skipped: false });
    console.log(`  ${label.padEnd(32)} = [${actual}]  ${pass ? '✅' : '❌'}  (should contain: "${expectedValue}")`);
    expect(pass, `[Shippeo Details] ${label}: should contain "${expectedValue}", got [${actual}]`).toBe(true);
  }

  console.log(`\n  ${BAR}`);
  console.log(`  SHIPPEO ORDER DETAILS ASSERTION`);
  console.log(`  ${BAR}`);

  check('container.reference',      details?.container?.reference,          containerNumber);
  check('cargo.reference',           details?.cargo?.reference,              containerNumber);
  check('scacAtCreation',            details?.scacAtCreation,                scac);
  checkContains('oceanCarrier.scacList', details?.oceanCarrier?.scacList,    scac);
  check('oceanCarrier.name',         details?.oceanCarrier?.name,            carrierName || null,
        carrierName ? null : 'carrierName not provided');

  checkContains('bookingReferenceList',
    (details?.bookingReferenceList || []).map(b => b.reference),
    bookingNumber, bookingNumber ? null : 'no BN on this scenario');

  checkContains('billOfLadingList',
    (details?.billOfLadingList || []).map(b => b.reference),
    blNumber, blNumber ? null : 'no BL on this scenario');

  console.log(`  ${BAR}`);

  const allPass = rows.every(r => r.pass);
  return { allPass, rows };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the Shippeo search reference for Air.
 * Air shipments are searched by masterAirWaybillNumber directly.
 *
 * @param {{ mawb: string }} ids
 */
function buildAirReference({ mawb }) {
  return mawb;
}

module.exports = {
  buildOceanReference,
  buildAirReference,
  searchShippeoShipment,
  pollUntilShippeoShipmentFound,
  getShippeoOrderDetails,
  assertShippeoOrderDetails,
};
