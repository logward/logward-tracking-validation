// ─────────────────────────────────────────────────────────────────────────────
//  helpers/e2e/shippeoApiClient.js
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

// ── Header factory ────────────────────────────────────────────────────────────
const shippeoHeaders = () => ({
  'Authorization': `Bearer ${E2E_CONFIG.SHIPPEO.token}`,
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
      headers: shippeoHeaders(),
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

module.exports = {
  buildOceanReference,
  searchShippeoShipment,
  pollUntilShippeoShipmentFound,
};
