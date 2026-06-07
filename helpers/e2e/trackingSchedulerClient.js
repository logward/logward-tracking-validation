// ─────────────────────────────────────────────────────────────────────────────
//  helpers/e2e/trackingSchedulerClient.js
//
//  Verifies Auto Tracking Conditions via the Tracking Scheduler API.
//
//  Endpoint:
//    GET <TRACKING_BASE_URL>/tracking/tracking_schedule/<schemaType>/<objectCode>
//    Authorization: Bearer <token>
//
//  Response: array of tracking schedule objects, each with `active` and `valid`.
//    active = 1  → Auto Tracking Conditions satisfied
//    valid  = 1  → All required tracking fields are populated
//
//  Usage in E2E:
//    const rec = await pollUntilSchedulerActive('TransportUnitOcean', objectCode);
//    expect(rec.active).toBe(1);
//    expect(rec.valid).toBe(1);
// ─────────────────────────────────────────────────────────────────────────────

const { request } = require('@playwright/test');
const { E2E_CONFIG } = require('./e2eConfig');

const headers = () => ({
  'Authorization': `Bearer ${E2E_CONFIG.ADMIN_TOKEN}`,
  'accept':        'application/json',
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch the tracking schedule record for a given schemaType + objectCode.
 * Returns the first element of the response array, or null if empty/failed.
 *
 * @param schemaType  e.g. 'TransportUnitOcean'
 * @param objectCode  Logward internal object code (returned by create)
 */
async function getTrackingSchedule(schemaType, objectCode) {
  const ctx = await request.newContext({ baseURL: E2E_CONFIG.TRACKING_BASE_URL });
  try {
    const res = await ctx.get(
      `/api/tracking/track/schedule/${schemaType}/${objectCode}`,
      { headers: headers() }
    );

    const status = res.status();
    const raw    = await res.text();
    console.log(`  [scheduler] GET HTTP ${status} → ${raw.slice(0, 300)}`);

    if (!res.ok()) return null;

    const body = raw ? JSON.parse(raw) : null;
    if (!body) return null;
    // Response is wrapped: { data: { active, valid, ... } } — unwrap it
    const payload = body.data ?? body;
    const records = Array.isArray(payload) ? payload : [payload];
    return records[0] ?? null;

  } finally {
    await ctx.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Poll until the tracking schedule has active=1 AND valid=1, or timeout.
 *
 * @param schemaType
 * @param objectCode
 * @param [timeoutMs]
 */
async function pollUntilSchedulerActive(
  schemaType,
  objectCode,
  timeoutMs = E2E_CONFIG.SCHEDULER_TIMEOUT_MS
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const rec = await getTrackingSchedule(schemaType, objectCode).catch(() => null);

    if (rec) {
      const r = rec;
      console.log(`  [scheduler ⏳] ${schemaType}/${objectCode} → active=${r.active} valid=${r.valid}`);
      if (r.active === 1 && r.valid === 1) {
        console.log(`  [scheduler ✅] active=1 valid=1`);
        return r;
      }
    } else {
      console.log(`  [scheduler ⏳] No record yet for ${schemaType}/${objectCode}`);
    }

    await new Promise(r => setTimeout(r, E2E_CONFIG.POLL_INTERVAL_MS));
  }

  console.warn(`  [scheduler ⚠️] Timed out after ${timeoutMs}ms`);
  return getTrackingSchedule(schemaType, objectCode).catch(() => null);
}

module.exports = { getTrackingSchedule, pollUntilSchedulerActive };
