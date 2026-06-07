// ─────────────────────────────────────────────────────────────────────────────
//  helpers/e2e/trackingServiceClient.js
//
//  Verifies MongoDB order creation via the Tracking Service API.
//
//  Endpoint:
//    POST <TRACKING_BASE_URL>/tracking/shippeo/ocean
//    Authorization: Bearer <token>
//    Body: { bookingNumber, billOfLadingNumber, containerNumber,
//            containerIdentifierKey, scac }
//
//  Response: array of objects of two kinds:
//    1. Tracking schedule objects   → have `active` and `valid` fields
//    2. Tracking MongoDB documents  → have `error` (failed) or no `error` (success)
//
//  For Orders-In verification (A-03) we care about kind 2:
//    A response with at least one non-error tracking document confirms the
//    order was created in MongoDB (xtrackings) and is linked to this shipment.
//
//  Usage in E2E:
//    const docs = await pollUntilTrackingDocCreated({ bookingNumber, containerNumber, scac });
//    expect(docs.length).toBeGreaterThan(0);
// ─────────────────────────────────────────────────────────────────────────────

const { request } = require('@playwright/test');
const { E2E_CONFIG } = require('./e2eConfig');

const headers = () => ({
  'Authorization': `Bearer ${E2E_CONFIG.ADMIN_TOKEN}`,
  'Content-Type':  'application/json',
  'accept':        'application/json',
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the POST body for the tracking service lookup.
 *
 * Ocean lookup combos (matching Auto Tracking Condition):
 *   Option A: containerNumber + bookingNumber + scac
 *   Option B: containerNumber + billOfLadingNumber + scac
 *   Option C: containerNumber + bookingNumber + billOfLadingNumber + scac
 *
 * Field names confirmed from MongoDB xtrackings document:
 *   containerId           — container number (e.g. "GAOU2414715")
 *   bookingId             — booking number   (e.g. "070600145524")
 *   billOfLadingId        — BL number        (e.g. "EGLV070600145524")
 *   scacCode              — carrier SCAC     (e.g. "EGLV")
 *
 * @param identifiers
 */
function buildTrackingServiceBody(identifiers) {
  const { containerId, bookingId, billOfLadingId, scacCode } = identifiers;

  return {
    containerId,
    ...(bookingId      ? { bookingId }      : {}),
    ...(billOfLadingId ? { billOfLadingId } : {}),
    scacCode,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Call the tracking service and return the full response array.
 *
 * @param identifiers
 */
async function fetchTrackingDocuments(identifiers) {
  const ctx  = await request.newContext({ baseURL: E2E_CONFIG.TRACKING_BASE_URL });
  try {
    const reqBody = buildTrackingServiceBody(identifiers);
    console.log(`  [tracking] POST body:`, JSON.stringify(reqBody));

    const res = await ctx.post('api/tracking/track/shippeo/ocean/get', {
      headers: headers(),
      data:    reqBody,
    });

    const status = res.status();
    const raw    = await res.text();
    console.log(`  [tracking] HTTP ${status} → ${raw.slice(0, 400)}`);

    if (!res.ok()) return [];

    const body = raw ? JSON.parse(raw) : null;
    if (!body) return [];
    // Response is wrapped: { data: [...] } — unwrap before returning
    const results = body?.data ?? (Array.isArray(body) ? body : [body]);
    return results;

  } finally {
    await ctx.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * From the mixed response array, extract successful MongoDB tracking documents.
 *
 * A successful tracking document has `error: false` (boolean — confirmed from
 * xtrackings schema).  Schedule records don't have an `error` field at all,
 * so we check `r.error === false` explicitly to avoid false positives.
 *
 * @param results  Raw response from fetchTrackingDocuments
 */
function extractSuccessDocuments(results) {
  return results.filter(r => r && r.error === false);
}

/**
 * From the mixed response array, extract tracking schedule objects.
 * Schedule records have `active` and `valid` fields; tracking docs do not.
 *
 * @param results
 */
function extractScheduleRecords(results) {
  return results.filter(item => item && item.active !== undefined && item.valid !== undefined);
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Poll the tracking service until at least one successful tracking document
 * is returned, confirming the order exists in MongoDB.
 *
 * @param identifiers
 * @param [timeoutMs]  Array of successful tracking documents (non-empty on success)
 */
async function pollUntilTrackingDocCreated(identifiers, timeoutMs = E2E_CONFIG.MONGO_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const all     = await fetchTrackingDocuments(identifiers).catch(() => []);
    const success = extractSuccessDocuments(all);
    // Error docs have error !== false (a string message or truthy object)
    const errDocs = all.filter(r => r && r.error !== false && r.error !== undefined);

    console.log(`  [tracking ⏳] total=${all.length} success=${success.length} errDocs=${errDocs.length}`);

    if (success.length > 0) {
      console.log(`  [tracking ✅] ${success.length} tracking document(s) found in MongoDB`);
      return success;
    }

    if (errDocs.length > 0) {
      console.log(`  [tracking] Error docs:`, JSON.stringify(errDocs));
    }

    await new Promise(r => setTimeout(r, E2E_CONFIG.POLL_INTERVAL_MS));
  }

  console.warn(`  [tracking ⚠️] Timed out after ${timeoutMs}ms`);
  const all = await fetchTrackingDocuments(identifiers).catch(() => []);
  return extractSuccessDocuments(all);
}

module.exports = {
  buildTrackingServiceBody,
  fetchTrackingDocuments,
  extractSuccessDocuments,
  extractScheduleRecords,
  pollUntilTrackingDocCreated,
};
