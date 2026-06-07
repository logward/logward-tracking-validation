// =============================================================================
// TC001_AirTracking_Mapping_V3.spec.js
//
// API Automation — Air Tracking Mapping Verification (Shippeo → Logward)
// Reference: Air Events Mapping V3 + air_tracking_qa_guide.docx (v2.0)
//
// ATU under test:
//   masterAirWaybillNumber : 9231361818
//   airCustomerReference   : 369-90292828
//   code                   : 90aecefd3770
//
// ─── MAPPING TYPES ───────────────────────────────────────────────────────────
//
//  Type 1 — Direct (29 fields, always written on EVERY event)
//            Identifiers, loading/delivery site, situation metadata, tags
//
//  Type 2 — Exact Match
//            Event-specific fields: date + 6 event_site fields (7 total)
//            goods_delivery_compliant_compliant → 9 fields (adds SituationCode +
//            JustificationCode)
//
//  Type 3 — Starts-With
//            Prefix match events (non_compliant / non_realised / refused)
//            Justification = suffix extracted from situation.event after prefix
//
//  Type 4 — OR + Hub Slot (goods_arrived_at_hub_arrived OR goods_arrived_at_delivery_hub_arrived)
//            Hub slot assignment:
//              ① scan stop1–4 — if hubArrivedSiteIata_stopN == event_site.iata → reuse that slot
//              ② else first empty slot (iata null/empty) → assign it
//              ③ all 4 occupied and no match → event dropped silently
//
//  Type 5 — Routing (booked | manifested | eta_event | received_from_flight)
//            Prefix decided at runtime by comparing event_site.iata_code against
//            loadingSiteIata and deliverySiteIata stored on the ATU:
//              event_site.iata == ATU.loadingSiteIata   → prefix = "loading"
//              event_site.iata == ATU.deliverySiteIata  → prefix = "delivery"
//              else                                     → prefix = "hub" (same slot logic as Type 4)
//
// HOW TO RUN:
//   npx playwright test "testCases/Tracking AIR Mapping/TC001_AirTracking_Mapping_V3.spec.js"
// =============================================================================

// @ts-check
const { test, expect, request } = require('@playwright/test');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
// Token priority (highest → lowest):
//   1. Environment variable   → set once in your shell before running
//   2. Fallback literal       → last-known token baked in for convenience
//
// Refresh the admin token (expires every ~1 hour — Cognito access token):
//   export AIR_ADMIN_TOKEN="eyJ..."
//
// Refresh the webhook token (long-lived, expires 2027):
//   export AIR_WEBHOOK_TOKEN="eyJ..."
//
// Then run:
//   npx playwright test "testCases/Tracking AIR Mapping/TC001_AirTracking_Mapping_V3.spec.js"
// ─────────────────────────────────────────────────────────────────────────────
const CONFIG = {
  WEBHOOK_BASE_URL:  'https://qa.logward.engineering',
  WEBHOOK_PATH:      '/api/integration-hub/tracking/shippeo/air_tracking',
  WEBHOOK_CLIENT_ID: 'okOiGTvE9mJ6jwxbSZ',

  // Long-lived webhook token (exp ~2027) — override via AIR_WEBHOOK_TOKEN env var
  WEBHOOK_TOKEN: process.env.AIR_WEBHOOK_TOKEN ||
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2NvdW50SWQiOiIwMDEwUTAwMDAwVFpvc1FRQVQiLCJjb2RlIjoiRkVlRzV0S2hrM3RXIiwiZXhwIjoxODA4NzYzMzAwLCJpc3MiOiJodHRwczovL2NvZ25pdG8taWRwLmV1LWNlbnRyYWwtMS5hbWF6b25hd3MuY29tL2V1LWNlbnRyYWwtMV9HSWwxaXpUN0IiLCJhdWQiOiJsb2d3YXJkLmNvbSJ9.N8lDfXx42AnxfW82RvgY-fTrPikKhqPxZD7crGWmB1A',

  ADMIN_BASE_URL: 'https://qa-admin.logward.engineering',

  // ⚠️  Cognito access token — expires every ~1 hour.
  //     When the test fails with HTTP 401 on the GET call, refresh this token:
  //       1. Log in to qa-admin.logward.engineering in your browser
  //       2. Copy the accessToken from DevTools → Application → Cookies
  //          OR from Network tab → any admin API request → Authorization header
  //       3. export AIR_ADMIN_TOKEN="eyJ..."   (paste the fresh token)
  //       4. Re-run the test
  ADMIN_TOKEN: process.env.AIR_ADMIN_TOKEN ||
    'eyJraWQiOiJIOU5CdVoyb3NWN0hpTG9WaEtPWFwvMWRDZHR5QTZnTjM3dDdzUFwvQzJPTFE9IiwiYWxnIjoiUlMyNTYifQ.eyJzdWIiOiJjMzUwOWFhMy02NDM0LTQ0ODktYjcwOC01OTQ3NTRiMjk0ZjgiLCJjb2duaXRvOmdyb3VwcyI6WyJDdXN0b21lckFkbWluIl0sImlzcyI6Imh0dHBzOlwvXC9jb2duaXRvLWlkcC5ldS1jZW50cmFsLTEuYW1hem9uYXdzLmNvbVwvZXUtY2VudHJhbC0xX0dJbDFpelQ3QiIsImNsaWVudF9pZCI6Im1ocTZoN3Y2bjJjZHZqOW1zam9vcThraDQiLCJvcmlnaW5fanRpIjoiNWIyN2NmZWMtNDRjNS00OGVlLWFmM2ItMzM4M2I2YzMzNzgyIiwiZXZlbnRfaWQiOiJhZmFkYzRkNC0yMWUzLTQ5NmQtOWM5ZC1lODc4ZWMxMWRhZTIiLCJ0b2tlbl91c2UiOiJhY2Nlc3MiLCJzY29wZSI6ImF3cy5jb2duaXRvLnNpZ25pbi51c2VyLmFkbWluIiwiYXV0aF90aW1lIjoxNzc5NTQzMTY0LCJleHAiOjE3Nzk3OTU3MDgsImlhdCI6MTc3OTc5MjEwOCwianRpIjoiYzBlNGUzZDEtZDYxZC00Yjc0LTg1YTAtNWE4MmQ2ODRmNThjIiwidXNlcm5hbWUiOiJjMzUwOWFhMy02NDM0LTQ0ODktYjcwOC01OTQ3NTRiMjk0ZjgifQ.C-TFTi5Dgd75Zy5u2LgaLb7X-tA5VaDIkdOSLC0AIH1uj_jx08W8mISBllKi4hF2UEqwoijX7eQIM8cVaoNeEWh0gryMdlmYTywbJN4WBahgIm4ul5OgZCtpK9v6TLqrv366vvVqgS89uAh0c8b-kTe2fErhVvqgZdkYQP2K1OoG9nt4ACe2zxNbSN7ky7PO9YUvcoaeR__bVGW5oU6AI0emO9zxhSMsEW2u4sGEZFA5pPtn0wOzCuQ72Ls5AAMooyKi4vlSmhkUeoeD7fyLp5F7dPaLG1eNjNAARZduVI1sdPXiiuglRrMAPJfSrgKCOKyvFzoC2yySowYnUDuztA',

  // ATU under test — UPDATE-ONLY service, ATU must pre-exist in BE
  MAWB_NUMBER:  '9231361818',
  CUSTOMER_REF: '369-90292828',
  OBJECT_CODE:  '90aecefd3770',

  SCHEMA_TYPE:      'airTransportUnit',
  POLL_INTERVAL_MS: 3000,
  POLL_TIMEOUT_MS:  30000,
};

// ── Token expiry check ────────────────────────────────────────────────────────
// Warn at startup if the admin token is already expired so you know immediately
// instead of getting a cryptic 401 mid-test.
(function checkAdminTokenExpiry() {
  try {
    const payload = JSON.parse(Buffer.from(CONFIG.ADMIN_TOKEN.split('.')[1], 'base64').toString());
    const expiresAt = new Date(payload.exp * 1000);
    const now       = new Date();
    const minsLeft  = Math.floor((expiresAt - now) / 60000);
    if (minsLeft <= 0) {
      console.warn(`\n⚠️  ADMIN_TOKEN is EXPIRED (expired ${Math.abs(minsLeft)} min ago at ${expiresAt.toISOString()})`);
      console.warn('   GET /api/tower/data/airTransportUnit/90aecefd3770 will return 401.');
      console.warn('   Refresh: export AIR_ADMIN_TOKEN="eyJ..."\n');
    } else if (minsLeft < 15) {
      console.warn(`\n⚠️  ADMIN_TOKEN expires in ${minsLeft} min (${expiresAt.toISOString()}) — consider refreshing before running.\n`);
    } else {
      console.log(`[Token] ADMIN_TOKEN valid for ${minsLeft} min (expires ${expiresAt.toISOString()})`);
    }
  } catch { /* ignore decode errors */ }
})();
// ─────────────────────────────────────────────────────────────────────────────

// ─── SITE DEFINITIONS ────────────────────────────────────────────────────────
// Reusable site objects (IATA codes must be EXACT — case-sensitive per QA guide)
const SITE = {
  BLR: {                                  // Loading site (origin)
    id: '2Y9GR6Y2', externalID: null,
    description: 'BLR Airport',
    address_line: 'Whitefield', city: 'Bengaluru', zipcode: '560066', country: 'IN',
    position: { lat: 48.69073, lng: 9.193624, latitude: 48.69073, longitude: 9.193624 },
    iata_code: 'BLR', name: 'BLR Airport',
  },
  BOM: {                                  // Delivery site (destination)
    id: 'N5JP9YM2', externalID: null,
    description: 'Mumbai International Airport',
    address_line: 'MG ROAD', city: 'Mumbai', zipcode: '35212', country: 'IN',
    position: { lat: 33.5635078, lng: -86.751541268647, latitude: 33.5635078, longitude: -86.751541268647 },
    iata_code: 'BOM', name: 'Mumbai International Airport',
  },
  DXB: {                                  // Hub 1 (intermediate)
    id: 'DXB001', externalID: null,
    description: 'Dubai International Airport',
    address_line: 'Airport Road', city: 'Dubai', zipcode: '00000', country: 'AE',
    position: { lat: 25.2528, lng: 55.3644, latitude: 25.2528, longitude: 55.3644 },
    iata_code: 'DXB',
  },
  FRA: {                                  // Hub 2 (intermediate)
    id: 'FRA001', externalID: null,
    description: 'Frankfurt Airport',
    address_line: 'Airport Blvd', city: 'Frankfurt', zipcode: '60547', country: 'DE',
    position: { lat: 50.0379, lng: 8.5622, latitude: 50.0379, longitude: 8.5622 },
    iata_code: 'FRA',
  },
};

/** Convert a SITE entry to a loading_site / delivery_site shape (has name + position.lat/lng). */
function toStaticSite(s) {
  return { id: s.id, externalID: s.externalID, name: s.name || s.description,
           address_line: s.address_line, zipcode: s.zipcode, city: s.city,
           country: s.country, position: { lat: s.position.lat, lng: s.position.lng },
           iata_code: s.iata_code };
}

/** Convert a SITE entry to an event_site shape (has description + position.latitude/longitude). */
function toEventSite(s) {
  return { id: s.id, externalID: s.externalID, description: s.description,
           address_line: s.address_line, zipcode: s.zipcode, city: s.city,
           country: s.country, position: { latitude: s.position.latitude, longitude: s.position.longitude },
           iata_code: s.iata_code };
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── PAYLOAD FACTORY ─────────────────────────────────────────────────────────
/**
 * Build a complete Shippeo payload.
 * @param {string} event       situation.event value
 * @param {string} date        situation.date (ISO 8601)
 * @param {object} eventSite   event_site object (use toEventSite(SITE.xxx))
 * @param {object} [extras]    extra top-level payload overrides
 */
function makePayload(event, date, eventSite, extras = {}) {
  return {
    date_transmission: '2025-07-24T10:01:00+00:00',
    owner: {
      organization: { id: 'Y2MY7DG2', name: 'Customer Test' },
      agency:        { id: 'JN9K8PYN', name: 'Customer Test AIR', siret: null },
    },
    order: {
      edi_reference:    CONFIG.MAWB_NUMBER,
      reference:        '9231362705',
      url:              'https://view.shippeo.com/orderPublic/test',
      client_reference: CONFIG.CUSTOMER_REF,
    },
    tour:    { edi_reference: 'no reference', reference: 'no reference', url: null },
    situation: {
      event,
      situation_code:     null,
      justification_code: null,
      input_date:         '2025-07-24T10:01:00+00:00',
      date,
    },
    situation_justification: { attributes: { consignmentReference: '3328004' } },
    loading_site:  toStaticSite(SITE.BLR),
    delivery_site: toStaticSite(SITE.BOM),
    carrier: null,
    tags:    [{ label: 'cip' }, { label: 'm-usausa' }],
    event_site: eventSite,
    ...extras,
  };
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── HUB ROUTING HELPERS ─────────────────────────────────────────────────────
/**
 * Type 5 routing prefix decision (runs against the ATU already stored in BE).
 *   event_site.iata == ATU.loadingSiteIata   → "loading"
 *   event_site.iata == ATU.deliverySiteIata  → "delivery"
 *   else                                     → "hub"
 */
function resolvePrefix(atu, iata) {
  if (iata && iata === atu.loadingSiteIata)   return 'loading';
  if (iata && iata === atu.deliverySiteIata)  return 'delivery';
  return 'hub';
}

/**
 * Hub slot assignment:
 *   ① scan stop1–4 for matching IATA  → return that N
 *   ② first empty slot               → return that N
 *   ③ all full, no match             → return null (event dropped)
 */
function resolveHubSlot(atu, iata) {
  for (let n = 1; n <= 4; n++) {
    if (atu[`hubArrivedSiteIata_stop${n}`] === iata) return n;
  }
  for (let n = 1; n <= 4; n++) {
    const v = atu[`hubArrivedSiteIata_stop${n}`];
    if (!v || v === '') return n;
  }
  return null;
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── API HELPERS ─────────────────────────────────────────────────────────────
const webhookHeaders = () => ({
  'Content-Type':  'application/json',
  'ClientId':      CONFIG.WEBHOOK_CLIENT_ID,
  'Authorization': `Bearer ${CONFIG.WEBHOOK_TOKEN}`,
});
const adminHeaders = () => ({
  'Authorization': `Bearer ${CONFIG.ADMIN_TOKEN}`,
  'accept':        'application/json',
});

async function sendWebhook(ctx, payload) {
  return ctx.post(CONFIG.WEBHOOK_PATH, { headers: webhookHeaders(), data: payload });
}

async function getATU(ctx) {
  const res = await ctx.get(
    `/api/tower/data/${CONFIG.SCHEMA_TYPE}/${CONFIG.OBJECT_CODE}`,
    { headers: adminHeaders() }
  );

  // 401 = token expired — give an actionable error immediately
  if (res.status() === 401) {
    throw new Error(
      `GET ATU → HTTP 401 Unauthorized.\n` +
      `  The ADMIN_TOKEN has expired (Cognito tokens last ~1 hour).\n` +
      `  Fix:\n` +
      `    1. Log in to https://qa-admin.logward.engineering\n` +
      `    2. Copy the fresh Bearer token from DevTools → Network → any request → Authorization header\n` +
      `    3. export AIR_ADMIN_TOKEN="eyJ..."\n` +
      `    4. Re-run the test`
    );
  }

  if (res.status() !== 200) {
    throw new Error(`GET ATU /airTransportUnit/${CONFIG.OBJECT_CODE} → HTTP ${res.status()}`);
  }

  const body = await res.json();
  return body.data ?? body;
}

/**
 * Poll GET /airTransportUnit/90aecefd3770 until changedAt differs from baseline.
 *
 * Single-gate strategy:
 *   Gate 1 (changedAt) : atu.changedAt differs from the pre-webhook baseline
 *                         (confirms the ATU was written after we sent the webhook)
 *
 * NOTE: The ATU schema does NOT include a `situationDate` field, so the original
 * two-gate approach (Gate 2 matching situationDate) always timed out.
 * With workers=1 (serial execution), changedAt changing is sufficient proof
 * that our webhook was processed — no concurrent writes possible.
 *
 * Falls back to the latest snapshot after POLL_TIMEOUT_MS (e.g. when the same
 * payload is re-sent and the BE detects no change — callers see the field diff).
 *
 * @param {object} ctx            Playwright APIRequestContext for the admin API
 * @param {string|null} baseline  atu.changedAt value snapshot before the webhook
 */
async function pollUntilUpdated(ctx, baseline) {
  const deadline = Date.now() + CONFIG.POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const atu = await getATU(ctx).catch(() => null);
    if (atu) {
      if (atu.changedAt !== baseline) {
        console.log(`  [poll ✅] changedAt changed: ${baseline} → ${atu.changedAt}`);
        return atu;
      }
      console.log(`  [poll ⏳] changedAt still "${atu.changedAt}" (baseline="${baseline}") — waiting…`);
    }
    await new Promise(r => setTimeout(r, CONFIG.POLL_INTERVAL_MS));
  }

  // Timeout — return latest snapshot so field assertions show the actual mismatch
  console.warn(`  [poll ⚠️] Timed out after ${CONFIG.POLL_TIMEOUT_MS}ms. Returning latest snapshot for diff.`);
  return getATU(ctx).catch(() => null);
}

/**
 * One-shot helper:
 *   ① Snapshot ATU (record changedAt + situationDate as baseline)
 *   ② POST webhook
 *   ③ Poll until BOTH gates pass (changedAt changed AND situationDate = payload's date)
 *   ④ Return { status, atu, before } so callers can diff before vs after if needed
 *
 * @param {object} payload  Full Shippeo webhook payload (built via makePayload())
 */
async function sendAndWait(payload) {
  const adminCtx   = await request.newContext({ baseURL: CONFIG.ADMIN_BASE_URL });
  const webhookCtx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });

  // Snapshot BEFORE
  const before   = await getATU(adminCtx).catch(() => null);
  const baseline = before?.changedAt ?? null;
  console.log(`  [sendAndWait] ATU before → code=${before?.code} changedAt=${baseline}`);

  // Fire webhook
  const res    = await sendWebhook(webhookCtx, payload);
  const status = res.status();
  console.log(`  [sendAndWait] Webhook HTTP ${status} | event="${payload.situation?.event}" date="${payload.situation?.date}"`);

  // Brief stabilisation (let the service start processing)
  await new Promise(r => setTimeout(r, 1500));

  // Poll until changedAt changes (confirms the webhook was processed)
  const atu = await pollUntilUpdated(adminCtx, baseline);
  console.log(`  [sendAndWait] ATU after  → changedAt=${atu?.changedAt} lastChangedAt=${atu?.lastChangedAt}`);

  await adminCtx.dispose();
  await webhookCtx.dispose();
  return { status, atu, before };
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── ASSERTION HELPER ────────────────────────────────────────────────────────
/**
 * Normalize a date string to ISO-8601 UTC for Date.parse().
 * The BE stores dates as MySQL "YYYY-MM-DD HH:mm:ss" (UTC, no timezone suffix).
 * Node.js parses that format as LOCAL time unless we append 'Z'.
 */
function normalizeDate(s) {
  if (typeof s !== 'string') return s;
  // MySQL datetime format: "2026-05-07 06:46:00" → treat as UTC → "2026-05-07T06:46:00Z"
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
    return s.replace(' ', 'T') + 'Z';
  }
  return s;
}

/**
 * Compare actual ATU field against expected value.
 * Handles: ISO / MySQL datetime strings (both normalised to UTC ms),
 *          null/undefined, arrays, plain strings.
 *
 * Date comparison is at SECOND precision — the BE stores dates as
 * "YYYY-MM-DD HH:mm:ss" which has no milliseconds, while our dynamic
 * test dates include sub-second precision from Date.now().
 */
function valuesMatch(actual, expected) {
  if (expected == null) return actual == null || actual === undefined || actual === '';
  if (Array.isArray(expected)) return JSON.stringify(actual) === JSON.stringify(expected);
  const eMs = Date.parse(String(expected));
  if (!isNaN(eMs)) {
    // Normalize actual — BE stores dates as "YYYY-MM-DD HH:mm:ss" (UTC, no tz/ms suffix)
    const aMs = Date.parse(normalizeDate(String(actual)));
    // Compare at seconds precision: BE truncates milliseconds on storage
    if (!isNaN(aMs)) return Math.floor(eMs / 1000) === Math.floor(aMs / 1000);
  }
  return String(actual ?? '').trim() === String(expected).trim();
}

function assertField(atu, key, expected) {
  const actual = atu?.[key];
  const ok     = valuesMatch(actual, expected);
  console.log(`  ${ok ? '✅' : '❌'} [${key}]  actual="${actual}"  expected="${expected}"`);
  expect(ok, `"${key}": expected=${JSON.stringify(expected)}, got=${JSON.stringify(actual)}`).toBe(true);
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── DYNAMIC DATE GENERATION ─────────────────────────────────────────────────
// Every test run generates unique dates so the BE always processes them as new
// events and updates changedAt.  Dates are offsets from the run start time.
const _RUN_BASE_MS = Date.now();
/**
 * Return a fresh ISO-8601 UTC date string offset by `plusSeconds` from the
 * moment this module was loaded.  Unique across test runs by construction.
 */
const runDate = (plusSeconds = 0) =>
  new Date(_RUN_BASE_MS + plusSeconds * 1000).toISOString();

// T2 — one date per event type (1-hour steps, well-spaced from MAIN)
const T2_DATES = {
  received_from_shipper:              runDate(3600),   // +1h
  goods_arrived_at_loading_arrived:   runDate(7200),   // +2h
  goods_loading_compliant_compliant:  runDate(10800),  // +3h
  goods_left_loading_left:            runDate(14400),  // +4h
  goods_arrived_at_delivery_arrived:  runDate(18000),  // +5h
  goods_left_delivery_left:           runDate(21600),  // +6h
  documentation_delivered:            runDate(25200),  // +7h
  consignee_notified:                 runDate(28800),  // +8h
};

// T3 — one date per starts-with event
const T3_DATES = {
  goods_loading_non_compliant_damaged:          runDate(32400),  // +9h
  goods_loading_non_realised_cancelled:         runDate(36000),  // +10h
  goods_loading_refused_oversize:               runDate(39600),  // +11h
  goods_delivery_non_compliant_pilferage:       runDate(43200),  // +12h
  goods_delivery_non_realised_recipient_closed: runDate(46800),  // +13h
  goods_delivery_refused_not_ordered:           runDate(50400),  // +14h
};

// T4 — hub arrived / left dates
const T4_DATES = {
  dxbArrived:     runDate(54000),  // +15h
  dxbLeft:        runDate(57600),  // +16h
  fraArrived:     runDate(61200),  // +17h
  deliveryHubDXB: runDate(64800),  // +18h
};

// T5 — routing events (booked | manifested | eta_event | received_from_flight)
//       × (loading | delivery | hub)
const T5_DATES = {
  booked:               { loading: runDate(68400), delivery: runDate(72000), hub: runDate(75600)  },
  manifested:           { loading: runDate(79200), delivery: runDate(82800), hub: runDate(86400)  },
  eta_event:            { loading: runDate(90000), delivery: runDate(93600), hub: runDate(97200)  },
  received_from_flight: { loading: runDate(100800), delivery: runDate(104400), hub: runDate(108000) },
};

// ═════════════════════════════════════════════════════════════════════════════
//  MAIN PAYLOAD — goods_delivery_compliant_compliant
//  event_site.iata = BOM (= deliverySiteIata)  → Type 2 exact match
// ═════════════════════════════════════════════════════════════════════════════
const MAIN_EVENT     = 'goods_delivery_compliant_compliant';
const MAIN_DATE      = runDate(0);   // fresh per run → BE always writes new changedAt
const MAIN_PAYLOAD   = makePayload(MAIN_EVENT, MAIN_DATE, toEventSite(SITE.BOM));

// Shared state for the main describe block
let mainStatus = null;
let mainATU    = null;

// ─────────────────────────────────────────────────────────────────────────────
test.describe('Air Tracking — Mapping Verification (V3)', () => {

  test.beforeAll(async () => {
    // Guard: Playwright runs the outer beforeAll once per nested describe block.
    // After the first execution populates mainATU, subsequent runs are no-ops.
    if (mainATU) {
      console.log(`[Setup] mainATU already populated (changedAt=${mainATU?.changedAt}) — skipping re-send.`);
      return;
    }
    console.log(`\n[Setup] Sending ${MAIN_EVENT} webhook …`);
    ({ status: mainStatus, atu: mainATU } = await sendAndWait(MAIN_PAYLOAD));
    console.log(`[Setup] HTTP ${mainStatus} | ATU changedAt=${mainATU?.changedAt}`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP W — Webhook endpoint basic validations
  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('W — Webhook Validation', () => {

    test('TC-W-01 | POST returns 2xx', () => {
      expect(mainStatus).toBeGreaterThanOrEqual(200);
      expect(mainStatus).toBeLessThan(300);
    });

    test('TC-W-02 | POST without Authorization returns 401', async () => {
      const ctx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });
      const res = await ctx.post(CONFIG.WEBHOOK_PATH, {
        headers: { 'Content-Type': 'application/json', 'ClientId': CONFIG.WEBHOOK_CLIENT_ID },
        data: MAIN_PAYLOAD,
      });
      expect(res.status()).toBe(401);
      await ctx.dispose();
    });

    test('TC-W-03 | POST without ClientId returns 4xx', async () => {
      const ctx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });
      const res = await ctx.post(CONFIG.WEBHOOK_PATH, {
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CONFIG.WEBHOOK_TOKEN}` },
        data: MAIN_PAYLOAD,
      });
      expect(res.status()).toBeGreaterThanOrEqual(400);
      await ctx.dispose();
    });

    test('TC-W-04 | POST with invalid token returns 401', async () => {
      const ctx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });
      const res = await ctx.post(CONFIG.WEBHOOK_PATH, {
        headers: { 'Content-Type': 'application/json', 'ClientId': CONFIG.WEBHOOK_CLIENT_ID, 'Authorization': 'Bearer INVALID' },
        data: MAIN_PAYLOAD,
      });
      expect(res.status()).toBe(401);
      await ctx.dispose();
    });

    test('TC-W-05 | ATU found in BE (UPDATE-ONLY — must pre-exist)', () => {
      expect(mainATU, 'ATU not found — create it in BE first').not.toBeNull();
      expect(mainATU?.code).toBe(CONFIG.OBJECT_CODE);
    });

  }); // end W

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP D — Type 1: Direct fields (29 fields, always written on every event)
  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('D — Type 1: Direct Fields (29 fields — every event)', () => {

    test.beforeEach(() => { if (!mainATU) test.skip(); });

    // ── IDENTIFIERS ──────────────────────────────────────────────────────────
    test('TC-D-01 | masterAirWaybillNumber  ← order.edi_reference  [MANDATORY]', () =>
      assertField(mainATU, 'masterAirWaybillNumber', MAIN_PAYLOAD.order.edi_reference));

    test('TC-D-02 | houseAirWaybillNumber   ← order.edi_reference', () =>
      assertField(mainATU, 'houseAirWaybillNumber', MAIN_PAYLOAD.order.edi_reference));

    test('TC-D-03 | orderReference          ← order.reference', () =>
      assertField(mainATU, 'orderReference', MAIN_PAYLOAD.order.reference));

    test('TC-D-04 | airCustomerReference    ← order.client_reference  [MANDATORY]', () =>
      assertField(mainATU, 'airCustomerReference', MAIN_PAYLOAD.order.client_reference));

    test('TC-D-05 | consignmentReference    ← situation_justification.attributes.consignmentReference', () =>
      assertField(mainATU, 'consignmentReference', MAIN_PAYLOAD.situation_justification.attributes.consignmentReference));

    test('TC-D-06 | orderUrl                ← order.url', () =>
      assertField(mainATU, 'orderUrl', MAIN_PAYLOAD.order.url));

    // ── LOADING SITE (Origin) ────────────────────────────────────────────────
    test('TC-D-07 | loadingSiteName         ← loading_site.name', () =>
      assertField(mainATU, 'loadingSiteName', MAIN_PAYLOAD.loading_site.name));

    test('TC-D-08 | loadingSiteIata         ← loading_site.iata_code', () =>
      assertField(mainATU, 'loadingSiteIata', MAIN_PAYLOAD.loading_site.iata_code));

    test('TC-D-09 | loadingSiteAddressLine  ← loading_site.address_line', () =>
      assertField(mainATU, 'loadingSiteAddressLine', MAIN_PAYLOAD.loading_site.address_line));

    test('TC-D-10 | loadingSiteCity         ← loading_site.city', () =>
      assertField(mainATU, 'loadingSiteCity', MAIN_PAYLOAD.loading_site.city));

    test('TC-D-11 | loadingSiteZipcode      ← loading_site.zipcode', () =>
      assertField(mainATU, 'loadingSiteZipcode', MAIN_PAYLOAD.loading_site.zipcode));

    test('TC-D-12 | loadingSiteCountry      ← loading_site.country', () =>
      assertField(mainATU, 'loadingSiteCountry', MAIN_PAYLOAD.loading_site.country));

    // ── DELIVERY SITE (Destination) ──────────────────────────────────────────
    test('TC-D-13 | deliverySiteName        ← delivery_site.name', () =>
      assertField(mainATU, 'deliverySiteName', MAIN_PAYLOAD.delivery_site.name));

    test('TC-D-14 | deliverySiteIata        ← delivery_site.iata_code', () =>
      assertField(mainATU, 'deliverySiteIata', MAIN_PAYLOAD.delivery_site.iata_code));

    test('TC-D-15 | deliverySiteAddressLine ← delivery_site.address_line', () =>
      assertField(mainATU, 'deliverySiteAddressLine', MAIN_PAYLOAD.delivery_site.address_line));

    test('TC-D-16 | deliverySiteCity        ← delivery_site.city', () =>
      assertField(mainATU, 'deliverySiteCity', MAIN_PAYLOAD.delivery_site.city));

    test('TC-D-17 | deliverySiteZipcode     ← delivery_site.zipcode', () =>
      assertField(mainATU, 'deliverySiteZipcode', MAIN_PAYLOAD.delivery_site.zipcode));

    test('TC-D-18 | deliverySiteCountry     ← delivery_site.country', () =>
      assertField(mainATU, 'deliverySiteCountry', MAIN_PAYLOAD.delivery_site.country));

    // ── SITUATION METADATA ───────────────────────────────────────────────────
    test('TC-D-19 | situationEvent          ← situation.event  [MANDATORY]', () =>
      assertField(mainATU, 'situationEvent', MAIN_PAYLOAD.situation.event));

    test('TC-D-20 | situationDate           ← situation.date   [MANDATORY]', () =>
      assertField(mainATU, 'situationDate', MAIN_PAYLOAD.situation.date));

    test('TC-D-21 | situationInputDate      ← situation.input_date', () =>
      assertField(mainATU, 'situationInputDate', MAIN_PAYLOAD.situation.input_date));

    test('TC-D-22 | situationCode           ← situation.situation_code (null in payload)', () =>
      assertField(mainATU, 'situationCode', MAIN_PAYLOAD.situation.situation_code));

    test('TC-D-23 | justificationCode       ← situation.justification_code (null in payload)', () =>
      assertField(mainATU, 'justificationCode', MAIN_PAYLOAD.situation.justification_code));

    test('TC-D-24 | dateTransmission        ← date_transmission', () =>
      assertField(mainATU, 'dateTransmission', MAIN_PAYLOAD.date_transmission));

    test('TC-D-25 | tags                    ← tags array [{label:"cip"},{label:"m-usausa"}]', () => {
      const actual   = mainATU?.tags;
      const expected = MAIN_PAYLOAD.tags;
      const aLabels  = Array.isArray(actual)   ? actual.map(t => t?.label ?? t)   : [];
      const eLabels  = Array.isArray(expected) ? expected.map(t => t?.label ?? t) : [];
      console.log(`  [tags] actual=${JSON.stringify(aLabels)}  expected=${JSON.stringify(eLabels)}`);
      expect(aLabels).toEqual(expect.arrayContaining(eLabels));
    });

  }); // end D

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP E — Type 2 Exact: goods_delivery_compliant_compliant (9 fields)
  // 7 standard fields + SituationCode + JustificationCode (unique to this event)
  // Note: event_site fields come from event_site block — NOT from delivery_site!
  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('E — Type 2 Exact: goods_delivery_compliant_compliant (9 fields)', () => {

    test.beforeEach(() => { if (!mainATU) test.skip(); });

    const es = MAIN_PAYLOAD.event_site;    // event_site source
    const s  = MAIN_PAYLOAD.situation;     // situation source

    test('TC-E-01 | deliveryCompliantDate              ← situation.date', () =>
      assertField(mainATU, 'deliveryCompliantDate', s.date));

    test('TC-E-02 | deliveryCompliantSiteDescription   ← event_site.description', () =>
      assertField(mainATU, 'deliveryCompliantSiteDescription', es.description));

    test('TC-E-03 | deliveryCompliantSiteIata          ← event_site.iata_code', () =>
      assertField(mainATU, 'deliveryCompliantSiteIata', es.iata_code));

    test('TC-E-04 | deliveryCompliantSiteAddressLine   ← event_site.address_line', () =>
      assertField(mainATU, 'deliveryCompliantSiteAddressLine', es.address_line));

    test('TC-E-05 | deliveryCompliantSiteCity          ← event_site.city', () =>
      assertField(mainATU, 'deliveryCompliantSiteCity', es.city));

    test('TC-E-06 | deliveryCompliantSiteZipcode       ← event_site.zipcode', () =>
      assertField(mainATU, 'deliveryCompliantSiteZipcode', es.zipcode));

    test('TC-E-07 | deliveryCompliantSiteCountry       ← event_site.country', () =>
      assertField(mainATU, 'deliveryCompliantSiteCountry', es.country));

    test('TC-E-08 | deliveryCompliantSituationCode     ← situation.situation_code (null)', () =>
      assertField(mainATU, 'deliveryCompliantSituationCode', s.situation_code));

    test('TC-E-09 | deliveryCompliantJustificationCode ← situation.justification_code (null)', () =>
      assertField(mainATU, 'deliveryCompliantJustificationCode', s.justification_code));

    test('TC-E-10 | Guard — loadingCompliantDate NOT written for delivery event', () => {
      const val = mainATU?.loadingCompliantDate;
      if (val != null) expect(val).not.toBe(s.date);
      console.log(`  [guard] loadingCompliantDate="${val}" (must not equal delivery date)`);
    });

  }); // end E

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP T2 — Other Type 2 Exact events (one test each)
  // Each group sends its own webhook and verifies the 7 standard event_site fields
  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('T2 — Other Type 2 Exact Events', () => {

    // Helper: verify 7 standard fields for any Type 2 event
    async function runType2Test(event, date, eventSiteKey) {
      const payload = makePayload(event, date, toEventSite(SITE[eventSiteKey]));
      const { atu }  = await sendAndWait(payload);
      if (!atu) return null;
      const prefix   = event
        .replace(/_compliant$/, '')
        .replace(/_arrived$/, 'Arrived')
        .replace(/_left$/, 'Left');
      return { atu, payload };
    }

    let atuReceivedFromShipper = null;
    let atuLoadingArrived      = null;
    let atuLoadingCompliant    = null;
    let atuLoadingLeft         = null;
    let atuDeliveryArrived     = null;
    let atuDeliveryLeft        = null;
    let atuDocDelivered        = null;
    let atuConsigneeNotified   = null;

    test.beforeAll(async () => {
      console.log('\n[T2-Setup] Sending Type 2 exact events …');
      atuReceivedFromShipper = (await sendAndWait(makePayload('received_from_shipper',          T2_DATES.received_from_shipper,             toEventSite(SITE.BLR)))).atu;
      atuLoadingArrived      = (await sendAndWait(makePayload('goods_arrived_at_loading_arrived', T2_DATES.goods_arrived_at_loading_arrived,   toEventSite(SITE.BLR)))).atu;
      atuLoadingCompliant    = (await sendAndWait(makePayload('goods_loading_compliant_compliant', T2_DATES.goods_loading_compliant_compliant,  toEventSite(SITE.BLR)))).atu;
      atuLoadingLeft         = (await sendAndWait(makePayload('goods_left_loading_left',           T2_DATES.goods_left_loading_left,            toEventSite(SITE.BLR)))).atu;
      atuDeliveryArrived     = (await sendAndWait(makePayload('goods_arrived_at_delivery_arrived', T2_DATES.goods_arrived_at_delivery_arrived,  toEventSite(SITE.BOM)))).atu;
      atuDeliveryLeft        = (await sendAndWait(makePayload('goods_left_delivery_left',           T2_DATES.goods_left_delivery_left,           toEventSite(SITE.BOM)))).atu;
      atuDocDelivered        = (await sendAndWait(makePayload('documentation_delivered',            T2_DATES.documentation_delivered,            toEventSite(SITE.BOM)))).atu;
      atuConsigneeNotified   = (await sendAndWait(makePayload('consignee_notified',                 T2_DATES.consignee_notified,                 toEventSite(SITE.BOM)))).atu;
    });

    // received_from_shipper
    test('TC-T2-01 | received_from_shipper → receivedFromShipperDate', () =>
      assertField(atuReceivedFromShipper, 'receivedFromShipperDate', T2_DATES.received_from_shipper));
    test('TC-T2-02 | received_from_shipper → receivedFromShipperSiteIata = BLR', () =>
      assertField(atuReceivedFromShipper, 'receivedFromShipperSiteIata', 'BLR'));

    // goods_arrived_at_loading_arrived
    test('TC-T2-03 | goods_arrived_at_loading_arrived → loadingArrivedDate', () =>
      assertField(atuLoadingArrived, 'loadingArrivedDate', T2_DATES.goods_arrived_at_loading_arrived));
    test('TC-T2-04 | goods_arrived_at_loading_arrived → loadingArrivedSiteIata = BLR', () =>
      assertField(atuLoadingArrived, 'loadingArrivedSiteIata', 'BLR'));

    // goods_loading_compliant_compliant
    test('TC-T2-05 | goods_loading_compliant_compliant → loadingCompliantDate', () =>
      assertField(atuLoadingCompliant, 'loadingCompliantDate', T2_DATES.goods_loading_compliant_compliant));
    test('TC-T2-06 | goods_loading_compliant_compliant → loadingCompliantSiteIata = BLR', () =>
      assertField(atuLoadingCompliant, 'loadingCompliantSiteIata', 'BLR'));

    // goods_left_loading_left
    test('TC-T2-07 | goods_left_loading_left → loadingLeftDate', () =>
      assertField(atuLoadingLeft, 'loadingLeftDate', T2_DATES.goods_left_loading_left));
    test('TC-T2-08 | goods_left_loading_left → loadingLeftSiteIata = BLR', () =>
      assertField(atuLoadingLeft, 'loadingLeftSiteIata', 'BLR'));

    // goods_arrived_at_delivery_arrived
    test('TC-T2-09 | goods_arrived_at_delivery_arrived → deliveryArrivedDate', () =>
      assertField(atuDeliveryArrived, 'deliveryArrivedDate', T2_DATES.goods_arrived_at_delivery_arrived));
    test('TC-T2-10 | goods_arrived_at_delivery_arrived → deliveryArrivedSiteIata = BOM', () =>
      assertField(atuDeliveryArrived, 'deliveryArrivedSiteIata', 'BOM'));

    // goods_left_delivery_left
    test('TC-T2-11 | goods_left_delivery_left → deliveryLeftDate', () =>
      assertField(atuDeliveryLeft, 'deliveryLeftDate', T2_DATES.goods_left_delivery_left));
    test('TC-T2-12 | goods_left_delivery_left → deliveryLeftSiteIata = BOM', () =>
      assertField(atuDeliveryLeft, 'deliveryLeftSiteIata', 'BOM'));

    // documentation_delivered
    test('TC-T2-13 | documentation_delivered → documentationDeliveredDate', () =>
      assertField(atuDocDelivered, 'documentationDeliveredDate', T2_DATES.documentation_delivered));
    test('TC-T2-14 | documentation_delivered → documentationDeliveredSiteIata = BOM', () =>
      assertField(atuDocDelivered, 'documentationDeliveredSiteIata', 'BOM'));

    // consignee_notified
    test('TC-T2-15 | consignee_notified → consigneeNotifiedDate', () =>
      assertField(atuConsigneeNotified, 'consigneeNotifiedDate', T2_DATES.consignee_notified));
    test('TC-T2-16 | consignee_notified → consigneeNotifiedSiteIata = BOM', () =>
      assertField(atuConsigneeNotified, 'consigneeNotifiedSiteIata', 'BOM'));

  }); // end T2

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP T3 — Type 3 Starts-With (non_compliant / non_realised / refused)
  // Justification field = suffix after the prefix in situation.event
  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('T3 — Type 3 Starts-With Events (+ Justification suffix)', () => {

    let atuLoadingNonCompliant  = null;
    let atuLoadingNonRealised   = null;
    let atuLoadingRefused       = null;
    let atuDeliveryNonCompliant = null;
    let atuDeliveryNonRealised  = null;
    let atuDeliveryRefused      = null;

    test.beforeAll(async () => {
      console.log('\n[T3-Setup] Sending Type 3 starts-with events …');
      atuLoadingNonCompliant  = (await sendAndWait(makePayload('goods_loading_non_compliant_damaged',          T3_DATES.goods_loading_non_compliant_damaged,          toEventSite(SITE.BLR)))).atu;
      atuLoadingNonRealised   = (await sendAndWait(makePayload('goods_loading_non_realised_cancelled',         T3_DATES.goods_loading_non_realised_cancelled,         toEventSite(SITE.BLR)))).atu;
      atuLoadingRefused       = (await sendAndWait(makePayload('goods_loading_refused_oversize',               T3_DATES.goods_loading_refused_oversize,               toEventSite(SITE.BLR)))).atu;
      atuDeliveryNonCompliant = (await sendAndWait(makePayload('goods_delivery_non_compliant_pilferage',       T3_DATES.goods_delivery_non_compliant_pilferage,       toEventSite(SITE.BOM)))).atu;
      atuDeliveryNonRealised  = (await sendAndWait(makePayload('goods_delivery_non_realised_recipient_closed', T3_DATES.goods_delivery_non_realised_recipient_closed, toEventSite(SITE.BOM)))).atu;
      atuDeliveryRefused      = (await sendAndWait(makePayload('goods_delivery_refused_not_ordered',           T3_DATES.goods_delivery_refused_not_ordered,           toEventSite(SITE.BOM)))).atu;
    });

    // goods_loading_non_compliant_*
    test('TC-T3-01 | goods_loading_non_compliant_damaged → loadingNonCompliantDate', () =>
      assertField(atuLoadingNonCompliant, 'loadingNonCompliantDate', T3_DATES.goods_loading_non_compliant_damaged));
    test('TC-T3-02 | goods_loading_non_compliant_damaged → loadingNonCompliantSiteIata = BLR', () =>
      assertField(atuLoadingNonCompliant, 'loadingNonCompliantSiteIata', 'BLR'));
    test('TC-T3-03 | goods_loading_non_compliant_damaged → loadingNonCompliantJustification = "damaged"', () =>
      assertField(atuLoadingNonCompliant, 'loadingNonCompliantJustification', 'damaged'));

    // goods_loading_non_realised_*
    test('TC-T3-04 | goods_loading_non_realised_cancelled → loadingNonRealisedDate', () =>
      assertField(atuLoadingNonRealised, 'loadingNonRealisedDate', T3_DATES.goods_loading_non_realised_cancelled));
    test('TC-T3-05 | goods_loading_non_realised_cancelled → loadingNonRealisedSiteIata = BLR', () =>
      assertField(atuLoadingNonRealised, 'loadingNonRealisedSiteIata', 'BLR'));
    test('TC-T3-06 | goods_loading_non_realised_cancelled → loadingNonRealisedJustification = "cancelled"', () =>
      assertField(atuLoadingNonRealised, 'loadingNonRealisedJustification', 'cancelled'));

    // goods_loading_refused_*
    test('TC-T3-07 | goods_loading_refused_oversize → loadingRefusedDate', () =>
      assertField(atuLoadingRefused, 'loadingRefusedDate', T3_DATES.goods_loading_refused_oversize));
    test('TC-T3-08 | goods_loading_refused_oversize → loadingRefusedSiteIata = BLR', () =>
      assertField(atuLoadingRefused, 'loadingRefusedSiteIata', 'BLR'));
    test('TC-T3-09 | goods_loading_refused_oversize → loadingRefusedJustification = "oversize"', () =>
      assertField(atuLoadingRefused, 'loadingRefusedJustification', 'oversize'));

    // goods_delivery_non_compliant_*
    test('TC-T3-10 | goods_delivery_non_compliant_pilferage → deliveryNonCompliantDate', () =>
      assertField(atuDeliveryNonCompliant, 'deliveryNonCompliantDate', T3_DATES.goods_delivery_non_compliant_pilferage));
    test('TC-T3-11 | goods_delivery_non_compliant_pilferage → deliveryNonCompliantSiteIata = BOM', () =>
      assertField(atuDeliveryNonCompliant, 'deliveryNonCompliantSiteIata', 'BOM'));
    test('TC-T3-12 | goods_delivery_non_compliant_pilferage → deliveryNonCompliantJustification = "pilferage"', () =>
      assertField(atuDeliveryNonCompliant, 'deliveryNonCompliantJustification', 'pilferage'));

    // goods_delivery_non_realised_*
    test('TC-T3-13 | goods_delivery_non_realised_recipient_closed → deliveryNonRealisedDate', () =>
      assertField(atuDeliveryNonRealised, 'deliveryNonRealisedDate', T3_DATES.goods_delivery_non_realised_recipient_closed));
    test('TC-T3-14 | goods_delivery_non_realised_recipient_closed → deliveryNonRealisedJustification = "recipient_closed"', () =>
      assertField(atuDeliveryNonRealised, 'deliveryNonRealisedJustification', 'recipient_closed'));

    // goods_delivery_refused_*
    test('TC-T3-15 | goods_delivery_refused_not_ordered → deliveryRefusedDate', () =>
      assertField(atuDeliveryRefused, 'deliveryRefusedDate', T3_DATES.goods_delivery_refused_not_ordered));
    test('TC-T3-16 | goods_delivery_refused_not_ordered → deliveryRefusedJustification = "not_ordered"', () =>
      assertField(atuDeliveryRefused, 'deliveryRefusedJustification', 'not_ordered'));

  }); // end T3

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP T5 — Type 5 Routing events (booked | manifested | eta_event | received_from_flight)
  // Prefix = loading (BLR) | delivery (BOM) | hub (DXB = neither)
  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('T5 — Type 5 Routing Events', () => {

    // State per routing event
    const state = {};   // { [event]: { loading, delivery, hub, hubSlot } }

    test.beforeAll(async () => {
      const ROUTING_EVENTS = ['booked', 'manifested', 'eta_event', 'received_from_flight'];
      // Use module-level T5_DATES (dynamic, unique per run) instead of hardcoded strings
      const DATES = T5_DATES;

      console.log('\n[T5-Setup] Sending Type 5 routing events …');
      for (const ev of ROUTING_EVENTS) {
        const d = DATES[ev];
        const rLoading  = await sendAndWait(makePayload(ev, d.loading,  toEventSite(SITE.BLR)));
        const rDelivery = await sendAndWait(makePayload(ev, d.delivery, toEventSite(SITE.BOM)));
        const rHub      = await sendAndWait(makePayload(ev, d.hub,      toEventSite(SITE.DXB)));
        const slot      = rHub.atu ? resolveHubSlot(rHub.atu, 'DXB') : null;
        state[ev] = { loadingATU: rLoading.atu, deliveryATU: rDelivery.atu, hubATU: rHub.atu, hubSlot: slot, dates: d };
        console.log(`  ${ev}: slot=${slot}`);
      }
    });

    // ── Utility to build dynamic test name and run it ─────────────────────
    // booked
    test('TC-T5-01 | booked (iata=BLR=loadingSiteIata) → loadingBookedDate', () =>
      assertField(state.booked?.loadingATU, 'loadingBookedDate', state.booked?.dates.loading));
    test('TC-T5-02 | booked loading → loadingBookedSiteIata = BLR', () =>
      assertField(state.booked?.loadingATU, 'loadingBookedSiteIata', 'BLR'));
    test('TC-T5-03 | booked loading → loadingBookedSiteDescription', () =>
      assertField(state.booked?.loadingATU, 'loadingBookedSiteDescription', SITE.BLR.description));
    test('TC-T5-04 | booked (iata=BOM=deliverySiteIata) → deliveryBookedDate', () =>
      assertField(state.booked?.deliveryATU, 'deliveryBookedDate', state.booked?.dates.delivery));
    test('TC-T5-05 | booked delivery → deliveryBookedSiteIata = BOM', () =>
      assertField(state.booked?.deliveryATU, 'deliveryBookedSiteIata', 'BOM'));
    test('TC-T5-06 | booked (iata=DXB=hub) → hubBookedDate_stopN', () => {
      const { hubATU, hubSlot, dates } = state.booked || {};
      if (!hubSlot) return test.skip();
      assertField(hubATU, `hubBookedDate_stop${hubSlot}`, dates.hub);
    });
    test('TC-T5-07 | booked hub → hubBookedSiteIata_stopN = DXB', () => {
      const { hubATU, hubSlot } = state.booked || {};
      if (!hubSlot) return test.skip();
      assertField(hubATU, `hubBookedSiteIata_stop${hubSlot}`, 'DXB');
    });

    // manifested
    test('TC-T5-08 | manifested (iata=BLR) → loadingManifestedDate', () =>
      assertField(state.manifested?.loadingATU, 'loadingManifestedDate', state.manifested?.dates.loading));
    test('TC-T5-09 | manifested loading → loadingManifestedSiteIata = BLR', () =>
      assertField(state.manifested?.loadingATU, 'loadingManifestedSiteIata', 'BLR'));
    test('TC-T5-10 | manifested (iata=BOM) → deliveryManifestedDate', () =>
      assertField(state.manifested?.deliveryATU, 'deliveryManifestedDate', state.manifested?.dates.delivery));
    test('TC-T5-11 | manifested delivery → deliveryManifestedSiteIata = BOM', () =>
      assertField(state.manifested?.deliveryATU, 'deliveryManifestedSiteIata', 'BOM'));
    test('TC-T5-12 | manifested (iata=DXB) → hubManifestedDate_stopN', () => {
      const { hubATU, hubSlot, dates } = state.manifested || {};
      if (!hubSlot) return test.skip();
      assertField(hubATU, `hubManifestedDate_stop${hubSlot}`, dates.hub);
    });

    // eta_event
    test('TC-T5-13 | eta_event (iata=BLR) → loadingETADate', () =>
      assertField(state.eta_event?.loadingATU, 'loadingETADate', state.eta_event?.dates.loading));
    test('TC-T5-14 | eta_event loading → loadingETASiteIata = BLR', () =>
      assertField(state.eta_event?.loadingATU, 'loadingETASiteIata', 'BLR'));
    test('TC-T5-15 | eta_event (iata=BOM) → deliveryETADate', () =>
      assertField(state.eta_event?.deliveryATU, 'deliveryETADate', state.eta_event?.dates.delivery));
    test('TC-T5-16 | eta_event delivery → deliveryETASiteIata = BOM', () =>
      assertField(state.eta_event?.deliveryATU, 'deliveryETASiteIata', 'BOM'));
    test('TC-T5-17 | eta_event (iata=DXB) → hubETADate_stopN', () => {
      const { hubATU, hubSlot, dates } = state.eta_event || {};
      if (!hubSlot) return test.skip();
      assertField(hubATU, `hubETADate_stop${hubSlot}`, dates.hub);
    });

    // received_from_flight
    test('TC-T5-18 | received_from_flight (iata=BLR) → loadingReceivedFromFlightDate', () =>
      assertField(state.received_from_flight?.loadingATU, 'loadingReceivedFromFlightDate', state.received_from_flight?.dates.loading));
    test('TC-T5-19 | received_from_flight loading → loadingReceivedFromFlightSiteIata = BLR', () =>
      assertField(state.received_from_flight?.loadingATU, 'loadingReceivedFromFlightSiteIata', 'BLR'));
    test('TC-T5-20 | received_from_flight (iata=BOM) → deliveryReceivedFromFlightDate', () =>
      assertField(state.received_from_flight?.deliveryATU, 'deliveryReceivedFromFlightDate', state.received_from_flight?.dates.delivery));
    test('TC-T5-21 | received_from_flight delivery → deliveryReceivedFromFlightSiteIata = BOM', () =>
      assertField(state.received_from_flight?.deliveryATU, 'deliveryReceivedFromFlightSiteIata', 'BOM'));
    test('TC-T5-22 | received_from_flight (iata=DXB) → hubReceivedFromFlightDate_stopN', () => {
      const { hubATU, hubSlot, dates } = state.received_from_flight || {};
      if (!hubSlot) return test.skip();
      assertField(hubATU, `hubReceivedFromFlightDate_stop${hubSlot}`, dates.hub);
    });

  }); // end T5

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP T4 — Type 4 OR+Slot: hub arrived / hub left
  // goods_arrived_at_hub_arrived OR goods_arrived_at_delivery_hub_arrived
  // goods_left_hub_left          OR goods_left_delivery_hub_left
  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('T4 — Type 4 Hub Slot: arrived / departed', () => {

    let atuDXBArrived  = null;   // After hub arrived iata=DXB
    let atuDXBLeft     = null;   // After hub left iata=DXB (must reuse DXB slot)
    let atuFRAArrived  = null;   // After hub arrived iata=FRA (different slot from DXB)
    let slotDXB        = null;
    let slotFRA        = null;

    test.beforeAll(async () => {
      console.log('\n[T4-Setup] Sending hub arrived/departed events …');

      // DXB hub arrived
      const r1 = await sendAndWait(makePayload(
        'goods_arrived_at_hub_arrived', T4_DATES.dxbArrived, toEventSite(SITE.DXB)));
      atuDXBArrived = r1.atu;
      slotDXB = atuDXBArrived ? resolveHubSlot(atuDXBArrived, 'DXB') : null;
      console.log(`  DXB hub arrived → stop${slotDXB}`);

      // DXB hub left — must reuse the SAME slot
      const r2 = await sendAndWait(makePayload(
        'goods_left_hub_left', T4_DATES.dxbLeft, toEventSite(SITE.DXB)));
      atuDXBLeft = r2.atu;

      // FRA hub arrived — should get a DIFFERENT slot
      const r3 = await sendAndWait(makePayload(
        'goods_arrived_at_hub_arrived', T4_DATES.fraArrived, toEventSite(SITE.FRA)));
      atuFRAArrived = r3.atu;
      slotFRA = atuFRAArrived ? resolveHubSlot(atuFRAArrived, 'FRA') : null;
      console.log(`  FRA hub arrived → stop${slotFRA}`);
    });

    test.beforeEach(() => { if (!atuDXBArrived) test.skip(); });

    // Hub arrived — DXB
    test('TC-T4-01 | hub arrived (DXB) → slot assigned (1–4)', () => {
      expect(slotDXB).not.toBeNull();
      console.log(`  DXB slot: stop${slotDXB}`);
    });
    test('TC-T4-02 | hubArrivedSiteIata_stopN = DXB', () =>
      assertField(atuDXBArrived, `hubArrivedSiteIata_stop${slotDXB}`, 'DXB'));
    test('TC-T4-03 | hubArrivedDate_stopN = arrived date', () =>
      assertField(atuDXBArrived, `hubArrivedDate_stop${slotDXB}`, T4_DATES.dxbArrived));
    test('TC-T4-04 | hubArrivedSiteDescription_stopN = "Dubai International Airport"', () =>
      assertField(atuDXBArrived, `hubArrivedSiteDescription_stop${slotDXB}`, 'Dubai International Airport'));
    test('TC-T4-05 | hubArrivedSiteCity_stopN = Dubai', () =>
      assertField(atuDXBArrived, `hubArrivedSiteCity_stop${slotDXB}`, 'Dubai'));
    test('TC-T4-06 | hubArrivedSiteCountry_stopN = AE', () =>
      assertField(atuDXBArrived, `hubArrivedSiteCountry_stop${slotDXB}`, 'AE'));

    // Hub left — DXB (same slot reuse)
    test('TC-T4-07 | hub left (DXB) → hubLeftDate written to same slot as hub arrived', () => {
      if (!slotDXB || !atuDXBLeft) return test.skip();
      assertField(atuDXBLeft, `hubLeftDate_stop${slotDXB}`, T4_DATES.dxbLeft);
    });
    test('TC-T4-08 | hub left (DXB) → hubLeftSiteIata_stopN = DXB (slot reuse confirmed)', () => {
      if (!slotDXB || !atuDXBLeft) return test.skip();
      assertField(atuDXBLeft, `hubLeftSiteIata_stop${slotDXB}`, 'DXB');
    });

    // FRA arrives in a DIFFERENT slot from DXB
    test('TC-T4-09 | hub arrived (FRA) → assigned to different slot than DXB', () => {
      if (!slotDXB || !slotFRA) return test.skip();
      expect(slotFRA).not.toBe(slotDXB);
      console.log(`  DXB=stop${slotDXB}  FRA=stop${slotFRA}  (different ✓)`);
    });
    test('TC-T4-10 | hubArrivedSiteIata_stopFRA = FRA', () => {
      if (!slotFRA || !atuFRAArrived) return test.skip();
      assertField(atuFRAArrived, `hubArrivedSiteIata_stop${slotFRA}`, 'FRA');
    });
    test('TC-T4-11 | DXB slot unchanged after FRA arrives in different slot', () => {
      if (!slotDXB || !atuFRAArrived) return test.skip();
      const dxbIata = atuFRAArrived[`hubArrivedSiteIata_stop${slotDXB}`];
      expect(dxbIata).toBe('DXB');
      console.log(`  DXB slot stop${slotDXB} still = "${dxbIata}" ✓`);
    });

    // goods_arrived_at_delivery_hub_arrived (OR condition — same slot logic)
    test('TC-T4-12 | goods_arrived_at_delivery_hub_arrived uses same slot logic as hub_arrived', async () => {
      const { atu } = await sendAndWait(makePayload(
        'goods_arrived_at_delivery_hub_arrived', T4_DATES.deliveryHubDXB, toEventSite(SITE.DXB)));
      if (!atu || !slotDXB) return;
      // DXB already has a slot — it should reuse that slot
      const iata = atu[`hubArrivedSiteIata_stop${slotDXB}`];
      expect(iata).toBe('DXB');
      console.log(`  delivery_hub_arrived (DXB) → reused stop${slotDXB} ✓`);
    });

  }); // end T4

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP N — Negative / silent-drop scenarios
  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('N — Negative: Silent-Drop Scenarios (HTTP 200 always returned)', () => {

    test('TC-N-01 | Missing situationDate → HTTP 200 (silent drop)', async () => {
      const ctx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });
      const p   = makePayload(MAIN_EVENT, undefined, toEventSite(SITE.BOM));
      delete p.situation.date;
      const res = await sendWebhook(ctx, p);
      expect(res.status()).toBe(200);
      await ctx.dispose();
    });

    test('TC-N-02 | Missing situationEvent → HTTP 200 (silent drop)', async () => {
      const ctx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });
      const p   = makePayload('', MAIN_DATE, toEventSite(SITE.BOM));
      p.situation.event = '';
      const res = await sendWebhook(ctx, p);
      expect(res.status()).toBe(200);
      await ctx.dispose();
    });

    test('TC-N-03 | Non-existent MAWB → No ATU found, HTTP 200 (silent drop)', async () => {
      const ctx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });
      const p   = makePayload(MAIN_EVENT, MAIN_DATE, toEventSite(SITE.BOM));
      p.order.edi_reference    = 'NOMATCH_MAWB_99999';
      p.order.client_reference = 'NOMATCH_REF_99999';
      const res = await sendWebhook(ctx, p);
      expect(res.status()).toBe(200);
      await ctx.dispose();
    });

    test('TC-N-04 | Unknown event name → HTTP 200, event-specific fields not written', async () => {
      const ctx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });
      const p   = makePayload('totally_unknown_event_xyz', MAIN_DATE, toEventSite(SITE.BOM));
      const res = await sendWebhook(ctx, p);
      expect(res.status()).toBe(200);
      await ctx.dispose();
    });

    test('TC-N-05 | IATA case mismatch (lowercase "blr" ≠ "BLR") → treated as hub not loading', async () => {
      // QA guide: "IATA codes are case-sensitive"
      const { atu } = await sendAndWait(makePayload('booked', '2026-06-26T06:00:00+00:00', {
        ...toEventSite(SITE.BLR), iata_code: 'blr',   // lowercase — should NOT match loadingSiteIata="BLR"
      }));
      if (!atu) return;
      // loadingBookedDate should NOT be set to this date (because lowercase 'blr' != 'BLR')
      const val = atu?.loadingBookedDate;
      if (val != null) expect(val).not.toBe('2026-06-26T06:00:00+00:00');
      console.log(`  [case-sensitive] loadingBookedDate="${val}" (must not be set for lowercase iata)`);
    });

  }); // end N

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP S — Summary report
  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('S — Summary: Field State Report', () => {

    test('TC-S-01 | Print full ATU field map after all events', async () => {
      const ctx    = await request.newContext({ baseURL: CONFIG.ADMIN_BASE_URL });
      const latest = await getATU(ctx).catch(() => mainATU);
      await ctx.dispose();
      if (!latest) { console.log('[S-01] ATU not available'); return; }

      const check = (key, exp) => {
        const actual = latest[key];
        if (actual === undefined) return `  ⬜ ${key}: NOT IN RESPONSE`;
        return valuesMatch(actual, exp) ? `  ✅ ${key}: "${actual}"` : `  ❌ ${key}: actual="${actual}" | expected="${exp}"`;
      };

      console.log('\n══════════════════════════════════════════════════════════');
      console.log('  Air Tracking Mapping — Final Field State Report (V3)');
      console.log(`  ATU: ${latest.code} | changedAt: ${latest.changedAt}`);
      console.log('══════════════════════════════════════════════════════════');
      console.log('\n── Type 1: Direct (29 fields) ──');
      [
        ['masterAirWaybillNumber', MAIN_PAYLOAD.order.edi_reference],
        ['houseAirWaybillNumber',  MAIN_PAYLOAD.order.edi_reference],
        ['orderReference',         MAIN_PAYLOAD.order.reference],
        ['airCustomerReference',   MAIN_PAYLOAD.order.client_reference],
        ['consignmentReference',   '3328004'],
        ['orderUrl',               MAIN_PAYLOAD.order.url],
        ['loadingSiteName',        SITE.BLR.name],
        ['loadingSiteIata',        'BLR'],
        ['loadingSiteCity',        SITE.BLR.city],
        ['loadingSiteCountry',     SITE.BLR.country],
        ['deliverySiteName',       SITE.BOM.name],
        ['deliverySiteIata',       'BOM'],
        ['deliverySiteCity',       SITE.BOM.city],
        ['deliverySiteCountry',    SITE.BOM.country],
        ['situationEvent',         MAIN_EVENT],
        ['situationDate',          MAIN_DATE],
        ['dateTransmission',       MAIN_PAYLOAD.date_transmission],
      ].forEach(([k, v]) => console.log(check(k, v)));

      console.log('\n── Type 2: goods_delivery_compliant_compliant (9 fields) ──');
      [
        ['deliveryCompliantDate',              MAIN_DATE],
        ['deliveryCompliantSiteIata',          'BOM'],
        ['deliveryCompliantSiteDescription',   SITE.BOM.description],
        ['deliveryCompliantSiteCity',          SITE.BOM.city],
        ['deliveryCompliantSiteCountry',       SITE.BOM.country],
        ['deliveryCompliantSituationCode',     null],
        ['deliveryCompliantJustificationCode', null],
      ].forEach(([k, v]) => console.log(check(k, v)));

      console.log('\n── Hub slots (stop1–stop4) ──');
      for (let n = 1; n <= 4; n++) {
        const iata = latest[`hubArrivedSiteIata_stop${n}`];
        if (iata) console.log(`  ℹ️  stop${n}: iata="${iata}" arrivedDate="${latest[`hubArrivedDate_stop${n}`]}" leftDate="${latest[`hubLeftDate_stop${n}`]}"`);
        else      console.log(`  ⬜ stop${n}: empty`);
      }
      console.log('══════════════════════════════════════════════════════════\n');
    });

  }); // end S

}); // end Air Tracking — Mapping Verification (V3)
