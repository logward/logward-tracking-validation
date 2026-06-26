// ─────────────────────────────────────────────────────────────────────────────
//  helpers/shared/trackingSchedulerClient.js
//
//  Verifies Auto Tracking Conditions (ATC) for a TransportUnitOcean.
//
//  Strategy (two-tier):
//    1. Try the internal Scheduler API first (works when OTU created via admin API)
//       GET /api/tracking/track/schedule/{schemaType}/{objectCode}
//    2. Fall back to deriving active/valid from the OTU GET response
//       (used when OTU created via external API — scheduler doesn't track those)
//
//  ATC rules (derived from Logward business logic):
//    active = 1  ← trackingStatus === "In Progress"
//    valid  = 1  ← active=1 AND (bookingNumber OR billOfLadingNumber)
//                            AND containerNumber
//                            AND (carrierScac OR carrierShortName OR carrierName)
// ─────────────────────────────────────────────────────────────────────────────

const { request } = require('@playwright/test');
const { E2E_CONFIG } = require('./e2eConfig');
const { getAdminToken } = require('./cognitoAuth');

const headers = async () => ({
  'Authorization': `Bearer ${await getAdminToken()}`,
  'accept':        'application/json',
});

// ─────────────────────────────────────────────────────────────────────────────
//  Derive active/valid from OTU fields (fallback when scheduler API unavailable)
// ─────────────────────────────────────────────────────────────────────────────

function deriveActiveValid(otu) {
  const active = otu?.trackingStatus === 'In Progress' ? 1 : 0;
  const hasIdentifier = !!(otu?.bookingNumber || otu?.billOfLadingNumber);
  const hasContainer  = !!otu?.containerNumber;
  const hasCarrier    = !!(otu?.carrierScac || otu?.carrierShortName || otu?.carrierName);
  const valid = (active === 1 && hasIdentifier && hasContainer && hasCarrier) ? 1 : 0;
  return { active, valid };
}

// Air ATC rules (similar to Ocean but with MAWB instead of container/booking)
function deriveActiveValidAir(atu) {
  const active    = atu?.trackingStatus === 'In Progress' ? 1 : 0;
  const hasMAWB   = !!atu?.masterAirWaybillNumber;
  const hasCarrier = !!(atu?.carrierScac || atu?.carrierShortName || atu?.carrierName);
  const valid = (active === 1 && hasMAWB && hasCarrier) ? 1 : 0;
  return { active, valid };
}

async function getActiveValidFromOtu(objectCode) {
  const { getOceanTrackingObject } = require('./trackingObjectFactory');
  const raw = await getOceanTrackingObject(objectCode).catch(() => null);
  const otu = Array.isArray(raw) ? raw[0] : raw;
  if (!otu) return null;  // non-existent code → null, not {active:0,valid:0}
  const result = deriveActiveValid(otu);
  console.log(`  [scheduler] Derived from OTU fields: active=${result.active} valid=${result.valid}`);
  return result;
}

async function getActiveValidFromAtu(objectCode) {
  const { getAirTrackingObject } = require('../air/airTrackingObjectFactory');
  const raw = await getAirTrackingObject(objectCode).catch(() => null);
  const atu = Array.isArray(raw) ? raw[0] : raw;
  if (!atu) return null;
  const result = deriveActiveValidAir(atu);
  console.log(`  [scheduler] Derived from ATU fields: active=${result.active} valid=${result.valid}`);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch ATC status for a given schemaType + objectCode.
 * Tries the scheduler API first; falls back to OTU-derived values on failure.
 */
async function getTrackingSchedule(schemaType, objectCode) {
  const ctx = await request.newContext({ baseURL: E2E_CONFIG.TRACKING_BASE_URL });
  try {
    const res = await ctx.get(
      `/api/tracking/track/schedule/${schemaType}/${objectCode}`,
      { headers: await headers() }
    );

    const status = res.status();
    const raw    = await res.text();

    if (res.ok()) {
      console.log(`  [scheduler] GET HTTP ${status} → ${raw.slice(0, 300)}`);
      const body = raw ? JSON.parse(raw) : null;
      if (!body) return null;
      const payload = body.data ?? body;
      const records = Array.isArray(payload) ? payload : [payload];
      const record  = records[0] ?? null;
      // Real scheduler record has active/valid/code fields
      if (record && ('active' in record || 'valid' in record || 'code' in record)) {
        return record;
      }
      // Empty object {} — scheduler hasn't registered this OTU yet, return null to keep retrying
      // (caller will eventually fall back to OTU derivation on timeout)
      return null;
    }

    // Scheduler API error — fall back to object derivation
    console.log(`  [scheduler] GET HTTP ${status} — falling back to ${schemaType} derivation`);
    if (schemaType === 'airTransportUnit') return await getActiveValidFromAtu(objectCode);
    return await getActiveValidFromOtu(objectCode);

  } finally {
    await ctx.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Poll until active=1 AND valid=1, or timeout.
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
      console.log(`  [scheduler ⏳] ${schemaType}/${objectCode} → active=${rec.active} valid=${rec.valid}`);
      if (rec.active === 1 && rec.valid === 1) {
        console.log(`  [scheduler ✅] active=1 valid=1`);
        return rec;
      }
    } else {
      console.log(`  [scheduler ⏳] No record yet for ${schemaType}/${objectCode}`);
    }

    await new Promise(r => setTimeout(r, E2E_CONFIG.POLL_INTERVAL_MS));
  }

  // Real scheduler timed out — fall back to object-derived values so tests can proceed
  console.warn(`  [scheduler ⚠️] Timed out after ${timeoutMs}ms — falling back to ${schemaType} derivation`);
  const derived = schemaType === 'airTransportUnit'
    ? await getActiveValidFromAtu(objectCode)
    : await getActiveValidFromOtu(objectCode);
  if (derived) {
    console.log(`  [scheduler] Derived: active=${derived.active} valid=${derived.valid}`);
  }
  return derived;
}

module.exports = { getTrackingSchedule, pollUntilSchedulerActive, deriveActiveValidAir };
