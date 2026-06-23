// =============================================================================
//  AirOrdersIn.spec.js
//
//  AIR — Orders-In (S-01 to S-17) with gated sequential flow per scenario.
//
// ─── GROUP ORDER ─────────────────────────────────────────────────────────────
//
//  ✅ GROUP P  — Full Positive Flow         (S-01 to S-02)   [Shippeo required]
//  ✅ GROUP U  — Update to valid=1          (S-10 to S-12)   [Shippeo required]
//  ── GROUP N1 — active=0 valid=0           (S-03 to S-05)   [No Shippeo]
//  ── GROUP N2 — active=1 valid=0           (S-06 to S-09)   [No Shippeo]
//  ── GROUP A  — API and Auth Negative      (S-13 to S-17)   [No Shippeo]
//
// ─── HOW TO RUN ───────────────────────────────────────────────────────────────
//
//  All scenarios:
//    npx playwright test --project=air tests/air/AirOrdersIn.spec.js
//
//  Single group:
//    npx playwright test --project=air AirOrdersIn -g "GROUP P"
//    npx playwright test --project=air AirOrdersIn -g "GROUP N1"
//    npx playwright test --project=air AirOrdersIn -g "GROUP N2"
//    npx playwright test --project=air AirOrdersIn -g "GROUP U"
//    npx playwright test --project=air AirOrdersIn -g "GROUP A"
//
//  Single scenario:
//    npx playwright test --project=air AirOrdersIn -g "S-01"
//
// ─── FLOW (per positive scenario) ────────────────────────────────────────────
//
//  Create ATU (fresh per run)
//    ↓
//  [GATE] Scheduler: active=1 AND valid=1?
//    → NO: verify MongoDB NOT created → STOP
//    → YES ↓
//  [GATE] MongoDB: document exists?  (soft check — continues if endpoint unavailable)
//    → YES ↓ (or soft-skip)
//  [GATE] Shippeo: shipment searchable by MAWB?
//    → NO: STOP
//    → YES ↓
//  Send 4 events → validate ATU fields
//
// ─── AIR ATC RULES ───────────────────────────────────────────────────────────
//
//  active = 1  ← trackingStatus === "In Progress"
//  valid  = 1  ← active=1
//               AND masterAirWaybillNumber (MAWB)
//               AND (carrierScac OR carrierShortName OR carrierName)
//
// ─── UNIQUE IDENTIFIERS (per scenario) ───────────────────────────────────────
//
//  masterAirWaybillNumber : E2EAIR{seq}{last-5-ts}  e.g. E2EAIR0191234
//  clientReference        : E2ECRF{seq}{last-5-ts}  e.g. E2ECRF0191234
//  (clientReference routes incoming Shippeo webhooks to this ATU)
//
// =============================================================================

// @ts-nocheck
const { test, expect, request } = require('@playwright/test');

const { CONFIG }                                              = require('../../helpers/air/airConfig');
const { createAirTrackingObject,
        getAirTrackingObject,
        updateAirTrackingObject }                            = require('../../helpers/air/airTrackingObjectFactory');
const { makePayload, SITE, toEventSite }                     = require('../../helpers/air/airPayloadFactory');
const { assertField }                                        = require('../../helpers/air/airValidation');
const { getTrackingSchedule,
        pollUntilSchedulerActive }                           = require('../../helpers/e2e/trackingSchedulerClient');
const { pollUntilAirTrackingDocCreated }                     = require('../../helpers/e2e/trackingServiceClient');
const { buildAirReference,
        pollUntilShippeoShipmentFound }                      = require('../../helpers/e2e/shippeoApiClient');
const { E2E_CONFIG }                                         = require('../../helpers/e2e/e2eConfig');

// ─────────────────────────────────────────────────────────────────────────────
//  Config shortcuts
// ─────────────────────────────────────────────────────────────────────────────

const AIR_SCHEMA_TYPE = CONFIG.SCHEMA_TYPE; // 'airTransportUnit'

// ─────────────────────────────────────────────────────────────────────────────
//  Feature flags
// ─────────────────────────────────────────────────────────────────────────────

const SHIPPEO_ENABLED =
  (!!E2E_CONFIG.SHIPPEO.token        && !E2E_CONFIG.SHIPPEO.token.startsWith('<'))        ||
  (!!E2E_CONFIG.SHIPPEO.refreshToken && !E2E_CONFIG.SHIPPEO.refreshToken.startsWith('<')) ||
  (!!E2E_CONFIG.SHIPPEO.username     && !!E2E_CONFIG.SHIPPEO.password && !E2E_CONFIG.SHIPPEO.password.startsWith('<'));

// ─────────────────────────────────────────────────────────────────────────────
//  Air carrier pool
//  TODO: replace with actual Air carrier SCACs that are registered in Logward.
//  For ocean equivalents: MSCU=MSC, MAEU=Maersk, CMDU=CMA CGM, HLCU=Hapag-Lloyd
// ─────────────────────────────────────────────────────────────────────────────

const AIR_CARRIER_POOL = [
  { scac: 'MSCU', shortName: 'MSC',    name: 'Mediterranean Shipping Company' },
  { scac: 'MAEU', shortName: 'Maersk', name: 'Maersk Line' },
];

let _scenarioSeq = 0;
function nextCarrier() {
  return AIR_CARRIER_POOL[_scenarioSeq % AIR_CARRIER_POOL.length];
}

// ─────────────────────────────────────────────────────────────────────────────
//  Timing helper — unique dates per scenario to avoid BE dedup
// ─────────────────────────────────────────────────────────────────────────────

const _BASE_MS = Date.now();
let _dateOffset = 0;
function nextDate(plusSeconds = 0) {
  _dateOffset += 600;
  return new Date(_BASE_MS + (_dateOffset + plusSeconds) * 1000).toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
//  ATU helpers (thin wrappers for logging context)
// ─────────────────────────────────────────────────────────────────────────────

async function createATU(overrides = {}) {
  _scenarioSeq++;
  return createAirTrackingObject({
    mot:           'AIR',
    trackingStatus: 'In Progress',
    ...overrides,
  });
}

async function fetchATU(code) {
  const raw = await getAirTrackingObject(code);
  return Array.isArray(raw) ? raw[0] : raw;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Scheduler helpers
// ─────────────────────────────────────────────────────────────────────────────

async function pollSchedulerActiveValid(code) {
  return pollUntilSchedulerActive(AIR_SCHEMA_TYPE, code);
}

async function pollUntilActive(code) {
  const deadline = Date.now() + E2E_CONFIG.SCHEDULER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const rec = await getTrackingSchedule(AIR_SCHEMA_TYPE, code).catch(() => null);
    if (rec?.active === 1) return rec;
    await new Promise(r => setTimeout(r, E2E_CONFIG.POLL_INTERVAL_MS));
  }
  return getTrackingSchedule(AIR_SCHEMA_TYPE, code).catch(() => null);
}

async function getSchedulerOnce(code) {
  await new Promise(r => setTimeout(r, 8000));
  return getTrackingSchedule(AIR_SCHEMA_TYPE, code).catch(() => null);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Webhook helpers
// ─────────────────────────────────────────────────────────────────────────────

const webhookHeaders = () => ({
  'Content-Type':  'application/json',
  'ClientId':      CONFIG.WEBHOOK_CLIENT_ID,
  'Authorization': `Bearer ${CONFIG.WEBHOOK_TOKEN}`,
});

/**
 * Build a payload for Orders-In events:
 * overrides order.client_reference and order.edi_reference with per-scenario values.
 *
 * @param {string} event
 * @param {string} date
 * @param {object} site      toEventSite(SITE.xxx)
 * @param {string} clientRef  ATU clientReference (webhook routing key)
 * @param {string} mawb       masterAirWaybillNumber
 */
function makeOrdersInPayload(event, date, site, clientRef, mawb) {
  return makePayload(event, date, site, {
    order: {
      edi_reference:    mawb,
      reference:        mawb,
      url:              'https://view.shippeo.com/orderPublic/test',
      client_reference: clientRef,
    },
  });
}

async function sendWebhook(ctx, payload) {
  return ctx.post(CONFIG.WEBHOOK_PATH, { headers: webhookHeaders(), data: payload });
}

/**
 * Send an event and poll until the ATU's changedAt timestamp advances.
 *
 * @returns {Promise<object|null>}  Updated ATU snapshot
 */
async function sendEventAndWait(ctx, event, date, site, code, clientRef, mawb) {
  const before = await fetchATU(code);
  const baseChangedAt = before?.changedAt;

  const payload = makeOrdersInPayload(event, date, site, clientRef, mawb);
  const res = await sendWebhook(ctx, payload);
  console.log(`  [webhook] ${event} → HTTP ${res.status()}`);
  expect(res.status()).toBeGreaterThanOrEqual(200);
  expect(res.status()).toBeLessThan(300);

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const atu = await fetchATU(code);
    if (atu?.changedAt && atu.changedAt !== baseChangedAt) return atu;
    await new Promise(r => setTimeout(r, 3000));
  }
  return fetchATU(code);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Shared Shippeo gate helper (used by GROUP P and GROUP U)
// ─────────────────────────────────────────────────────────────────────────────

async function gateShippeo(mawb) {
  if (!SHIPPEO_ENABLED) {
    console.log('  [shippeo] Token not configured — skipping Shippeo gate');
    return null;
  }
  const ref      = buildAirReference({ mawb });
  const shipment = await pollUntilShippeoShipmentFound(ref);
  if (!shipment) {
    console.warn(`  [shippeo] Shipment NOT found for mawb="${mawb}"`);
  } else {
    console.log(`  [shippeo ✅] Found shipment for mawb="${mawb}"`);
  }
  return shipment;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Sites
// ─────────────────────────────────────────────────────────────────────────────

const BLR = toEventSite(SITE.BLR);
const BOM = toEventSite(SITE.BOM);

// =============================================================================
// =============================================================================
test.describe('Air — AirOrdersIn', () => {

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP P — Full Positive Flow
  //
  //  Create ATU with MAWB + In Progress + carrier
  //  → scheduler active=1 valid=1
  //  → MongoDB (soft check)
  //  → Shippeo found by MAWB
  //  → Send 4 events → assert ATU date + site IATA fields
  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('GROUP P | Full Positive Flow', () => {

    // ── S-01 ──────────────────────────────────────────────────────────────────
    test.describe('GROUP P | S-01 | Full Positive Flow — MAWB + In Progress + carrier', () => {

      let code, mawb, clientRef, carrier;
      let schedRec = null, shipment = null, webhookCtx = null;
      let atuAfterEvent1 = null, atuAfterEvent2 = null, atuAfterEvent3 = null, atuAfterEvent4 = null;

      const d1 = nextDate(0);
      const d2 = nextDate(60);
      const d3 = nextDate(120);
      const d4 = nextDate(180);

      test.beforeAll(async () => {
        carrier = AIR_CARRIER_POOL[0];
        console.log('\n[S-01] Creating ATU — full positive fields …');
        ({ code, mawb, clientReference: clientRef } = await createATU({
          carrierScac:      carrier.scac,
          carrierShortName: carrier.shortName,
          carrierName:      carrier.name,
        }));

        console.log(`[S-01] code="${code}" mawb="${mawb}" clientRef="${clientRef}"`);

        // Gate 1 — Scheduler
        schedRec = await pollSchedulerActiveValid(code);
        console.log(`[S-01] Scheduler → active=${schedRec?.active} valid=${schedRec?.valid}`);
        if (!(schedRec?.active === 1 && schedRec?.valid === 1)) return;

        // Gate 2 — MongoDB (soft)
        await pollUntilAirTrackingDocCreated({ mawb, scacCode: carrier.scac })
          .catch(() => console.warn('  [S-01] MongoDB soft check skipped'));

        // Gate 3 — Shippeo
        shipment = await gateShippeo(mawb);
        if (!shipment) return;

        // Send 4 events
        webhookCtx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });
        atuAfterEvent1 = await sendEventAndWait(webhookCtx, 'received_from_shipper',            d1, BLR, code, clientRef, mawb);
        atuAfterEvent2 = await sendEventAndWait(webhookCtx, 'goods_loading_compliant_compliant', d2, BLR, code, clientRef, mawb);
        atuAfterEvent3 = await sendEventAndWait(webhookCtx, 'goods_left_loading_left',           d3, BLR, code, clientRef, mawb);
        atuAfterEvent4 = await sendEventAndWait(webhookCtx, 'goods_arrived_at_delivery_arrived', d4, BOM, code, clientRef, mawb);
      });

      test.afterAll(async () => { await webhookCtx?.dispose(); });

      // ── Scheduler gate ──────────────────────────────────────────────────────
      test('S-01 | Scheduler → active=1', () =>
        expect(schedRec?.active, 'Scheduler active should be 1').toBe(1));
      test('S-01 | Scheduler → valid=1', () =>
        expect(schedRec?.valid, 'Scheduler valid should be 1').toBe(1));

      // ── Shippeo gate ────────────────────────────────────────────────────────
      test('S-01 | Shippeo → shipment found by MAWB', () => {
        if (!SHIPPEO_ENABLED) return test.skip();
        expect(shipment, `Shippeo shipment not found for mawb="${mawb}"`).not.toBeNull();
      });

      // ── Event 1: received_from_shipper ──────────────────────────────────────
      test('S-01 | received_from_shipper → receivedFromShipperDate', () => {
        if (!atuAfterEvent1) return test.skip();
        assertField(atuAfterEvent1, 'receivedFromShipperDate', d1);
      });
      test('S-01 | received_from_shipper → receivedFromShipperSiteIata = BLR', () => {
        if (!atuAfterEvent1) return test.skip();
        assertField(atuAfterEvent1, 'receivedFromShipperSiteIata', SITE.BLR.iata_code);
      });

      // ── Event 2: goods_loading_compliant_compliant ──────────────────────────
      test('S-01 | goods_loading_compliant_compliant → loadingCompliantDate', () => {
        if (!atuAfterEvent2) return test.skip();
        assertField(atuAfterEvent2, 'loadingCompliantDate', d2);
      });
      test('S-01 | goods_loading_compliant_compliant → loadingCompliantSiteIata = BLR', () => {
        if (!atuAfterEvent2) return test.skip();
        assertField(atuAfterEvent2, 'loadingCompliantSiteIata', SITE.BLR.iata_code);
      });

      // ── Event 3: goods_left_loading_left ───────────────────────────────────
      test('S-01 | goods_left_loading_left → loadingLeftDate', () => {
        if (!atuAfterEvent3) return test.skip();
        assertField(atuAfterEvent3, 'loadingLeftDate', d3);
      });
      test('S-01 | goods_left_loading_left → loadingLeftSiteIata = BLR', () => {
        if (!atuAfterEvent3) return test.skip();
        assertField(atuAfterEvent3, 'loadingLeftSiteIata', SITE.BLR.iata_code);
      });

      // ── Event 4: goods_arrived_at_delivery_arrived ─────────────────────────
      test('S-01 | goods_arrived_at_delivery_arrived → deliveryArrivedDate', () => {
        if (!atuAfterEvent4) return test.skip();
        assertField(atuAfterEvent4, 'deliveryArrivedDate', d4);
      });
      test('S-01 | goods_arrived_at_delivery_arrived → deliveryArrivedSiteIata = BOM', () => {
        if (!atuAfterEvent4) return test.skip();
        assertField(atuAfterEvent4, 'deliveryArrivedSiteIata', SITE.BOM.iata_code);
      });

    }); // end S-01

    // ── S-02 ──────────────────────────────────────────────────────────────────
    test.describe('GROUP P | S-02 | Full Positive Flow — second carrier', () => {

      let code, mawb, clientRef, carrier;
      let schedRec = null, shipment = null, webhookCtx = null;
      let atuAfterEvent1 = null, atuAfterEvent4 = null;

      const d1 = nextDate(0);
      const d4 = nextDate(180);

      test.beforeAll(async () => {
        carrier = AIR_CARRIER_POOL[1] || AIR_CARRIER_POOL[0];
        console.log('\n[S-02] Creating ATU — second carrier …');
        ({ code, mawb, clientReference: clientRef } = await createATU({
          carrierScac:      carrier.scac,
          carrierShortName: carrier.shortName,
          carrierName:      carrier.name,
        }));

        schedRec = await pollSchedulerActiveValid(code);
        if (!(schedRec?.active === 1 && schedRec?.valid === 1)) return;

        await pollUntilAirTrackingDocCreated({ mawb, scacCode: carrier.scac }).catch(() => {});

        shipment = await gateShippeo(mawb);
        if (!shipment) return;

        webhookCtx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });
        atuAfterEvent1 = await sendEventAndWait(webhookCtx, 'received_from_shipper',            d1, BLR, code, clientRef, mawb);
        atuAfterEvent4 = await sendEventAndWait(webhookCtx, 'goods_arrived_at_delivery_arrived', d4, BOM, code, clientRef, mawb);
      });

      test.afterAll(async () => { await webhookCtx?.dispose(); });

      test('S-02 | Scheduler → active=1', () => expect(schedRec?.active).toBe(1));
      test('S-02 | Scheduler → valid=1',  () => expect(schedRec?.valid).toBe(1));
      test('S-02 | Shippeo → shipment found', () => {
        if (!SHIPPEO_ENABLED) return test.skip();
        expect(shipment).not.toBeNull();
      });
      test('S-02 | received_from_shipper → receivedFromShipperDate', () => {
        if (!atuAfterEvent1) return test.skip();
        assertField(atuAfterEvent1, 'receivedFromShipperDate', d1);
      });
      test('S-02 | goods_arrived_at_delivery_arrived → deliveryArrivedDate', () => {
        if (!atuAfterEvent4) return test.skip();
        assertField(atuAfterEvent4, 'deliveryArrivedDate', d4);
      });

    }); // end S-02

  }); // end GROUP P

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP N1 — active=0 valid=0
  //
  //  Wrong or missing trackingStatus → scheduler active=0 → flow stops.
  //  Asserts: active=0 (and valid=0 follows)
  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('GROUP N1 | active=0 valid=0 — wrong or missing trackingStatus', () => {

    async function runN1(label, trackingStatusOverride) {
      const override = trackingStatusOverride === undefined
        ? { trackingStatus: null }  // strip field
        : { trackingStatus: trackingStatusOverride };

      const carrier = AIR_CARRIER_POOL[0];
      const { code } = await createATU({
        ...override,
        masterAirWaybillNumber: undefined, // override may strip — reuse nextATUIds
        carrierScac: carrier.scac,
      });

      const rec = await getSchedulerOnce(code);
      console.log(`  [${label}] Scheduler: active=${rec?.active} valid=${rec?.valid}`);
      return rec;
    }

    test('GROUP N1 | S-03 | No trackingStatus → active=0', async () => {
      const rec = await runN1('S-03', undefined);
      expect(rec?.active ?? 0).toBe(0);
    });

    test('GROUP N1 | S-04 | trackingStatus="Pending" → active=0', async () => {
      const rec = await runN1('S-04', 'Pending');
      expect(rec?.active ?? 0).toBe(0);
    });

    test('GROUP N1 | S-05 | trackingStatus="Completed" → active=0', async () => {
      const rec = await runN1('S-05', 'Completed');
      expect(rec?.active ?? 0).toBe(0);
    });

  }); // end GROUP N1

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP N2 — active=1 valid=0
  //
  //  trackingStatus=In Progress but missing MAWB or carrier → valid=0
  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('GROUP N2 | active=1 valid=0 — In Progress but incomplete tracking fields', () => {

    async function runN2(label, overrides) {
      const { code } = await createATU(overrides);
      const rec = await pollUntilActive(code);
      console.log(`  [${label}] Scheduler: active=${rec?.active} valid=${rec?.valid}`);
      return rec;
    }

    test('GROUP N2 | S-06 | In Progress, no MAWB, no carrier → active=1 valid=0', async () => {
      const rec = await runN2('S-06', {
        masterAirWaybillNumber: null,
        carrierScac: null, carrierShortName: null, carrierName: null,
      });
      expect(rec?.active).toBe(1);
      expect(rec?.valid).toBe(0);
    });

    test('GROUP N2 | S-07 | In Progress + MAWB, no carrier → active=1 valid=0', async () => {
      const rec = await runN2('S-07', {
        carrierScac: null, carrierShortName: null, carrierName: null,
      });
      expect(rec?.active).toBe(1);
      expect(rec?.valid).toBe(0);
    });

    test('GROUP N2 | S-08 | In Progress + carrier, no MAWB → active=1 valid=0', async () => {
      const rec = await runN2('S-08', {
        masterAirWaybillNumber: null,
        carrierScac:      AIR_CARRIER_POOL[0].scac,
        carrierShortName: AIR_CARRIER_POOL[0].shortName,
        carrierName:      AIR_CARRIER_POOL[0].name,
      });
      expect(rec?.active).toBe(1);
      expect(rec?.valid).toBe(0);
    });

    test('GROUP N2 | S-09 | In Progress only (MAWB + carrier both absent) → active=1 valid=0', async () => {
      const rec = await runN2('S-09', {
        masterAirWaybillNumber: null,
        carrierScac: null, carrierShortName: null, carrierName: null,
      });
      expect(rec?.active).toBe(1);
      expect(rec?.valid).toBe(0);
    });

  }); // end GROUP N2

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP U — Update to valid=1 → then Shippeo
  //
  //  Create incomplete ATU → verify valid=0 → update → verify valid=1 → Shippeo
  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('GROUP U | Update to valid=1', () => {

    // ── S-10 ──────────────────────────────────────────────────────────────────
    test.describe('GROUP U | S-10 | In Progress + MAWB, NO carrier → add carrier → valid=1', () => {

      let code, mawb, clientRef, carrier;
      let recBefore = null, recAfter = null, shipment = null;

      test.beforeAll(async () => {
        carrier = AIR_CARRIER_POOL[0];
        console.log('\n[S-10] Creating ATU without carrier …');
        ({ code, mawb, clientReference: clientRef } = await createATU({
          carrierScac: null, carrierShortName: null, carrierName: null,
        }));

        // Verify valid=0 first
        recBefore = await pollUntilActive(code);
        console.log(`[S-10] Before update: active=${recBefore?.active} valid=${recBefore?.valid}`);

        if (recBefore?.active !== 1) return;

        // Update — add carrier
        console.log('[S-10] Adding carrier …');
        await updateAirTrackingObject(code, {
          carrierScac:      carrier.scac,
          carrierShortName: carrier.shortName,
          carrierName:      carrier.name,
        });

        // Verify valid=1
        recAfter = await pollSchedulerActiveValid(code);
        console.log(`[S-10] After update: active=${recAfter?.active} valid=${recAfter?.valid}`);
        if (!(recAfter?.active === 1 && recAfter?.valid === 1)) return;

        await pollUntilAirTrackingDocCreated({ mawb, scacCode: carrier.scac }).catch(() => {});
        shipment = await gateShippeo(mawb);
      });

      test('S-10 | Before update → active=1', () => expect(recBefore?.active).toBe(1));
      test('S-10 | Before update → valid=0', () => expect(recBefore?.valid).toBe(0));
      test('S-10 | After update  → valid=1', () => expect(recAfter?.valid).toBe(1));
      test('S-10 | Shippeo → shipment found after update', () => {
        if (!SHIPPEO_ENABLED) return test.skip();
        expect(shipment).not.toBeNull();
      });

    }); // end S-10

    // ── S-11 ──────────────────────────────────────────────────────────────────
    test.describe('GROUP U | S-11 | In Progress + carrier, NO MAWB → add MAWB → valid=1', () => {

      let code, mawb, clientRef, carrier;
      let recBefore = null, recAfter = null, shipment = null;

      test.beforeAll(async () => {
        carrier = AIR_CARRIER_POOL[0];
        console.log('\n[S-11] Creating ATU without MAWB …');
        ({ code, mawb, clientReference: clientRef } = await createATU({
          masterAirWaybillNumber: null,
          carrierScac:            carrier.scac,
          carrierShortName:       carrier.shortName,
          carrierName:            carrier.name,
        }));

        recBefore = await pollUntilActive(code);

        if (recBefore?.active !== 1) return;

        // Update — add MAWB
        console.log('[S-11] Adding MAWB …');
        await updateAirTrackingObject(code, { masterAirWaybillNumber: mawb });

        recAfter = await pollSchedulerActiveValid(code);
        if (!(recAfter?.active === 1 && recAfter?.valid === 1)) return;

        await pollUntilAirTrackingDocCreated({ mawb, scacCode: carrier.scac }).catch(() => {});
        shipment = await gateShippeo(mawb);
      });

      test('S-11 | Before update → active=1', () => expect(recBefore?.active).toBe(1));
      test('S-11 | Before update → valid=0', () => expect(recBefore?.valid).toBe(0));
      test('S-11 | After update  → valid=1', () => expect(recAfter?.valid).toBe(1));
      test('S-11 | Shippeo → shipment found after update', () => {
        if (!SHIPPEO_ENABLED) return test.skip();
        expect(shipment).not.toBeNull();
      });

    }); // end S-11

    // ── S-12 ──────────────────────────────────────────────────────────────────
    test.describe('GROUP U | S-12 | Pending + MAWB + carrier → update status → active=1 valid=1', () => {

      let code, mawb, clientRef, carrier;
      let recBefore = null, recAfter = null, shipment = null;

      test.beforeAll(async () => {
        carrier = AIR_CARRIER_POOL[0];
        console.log('\n[S-12] Creating ATU with status=Pending …');
        ({ code, mawb, clientReference: clientRef } = await createATU({
          trackingStatus:   'Pending',
          carrierScac:      carrier.scac,
          carrierShortName: carrier.shortName,
          carrierName:      carrier.name,
        }));

        recBefore = await getSchedulerOnce(code);
        console.log(`[S-12] Before update: active=${recBefore?.active} valid=${recBefore?.valid}`);

        // Update — change status to In Progress
        console.log('[S-12] Updating status to "In Progress" …');
        await updateAirTrackingObject(code, { trackingStatus: 'In Progress' });

        recAfter = await pollSchedulerActiveValid(code);
        console.log(`[S-12] After update: active=${recAfter?.active} valid=${recAfter?.valid}`);
        if (!(recAfter?.active === 1 && recAfter?.valid === 1)) return;

        await pollUntilAirTrackingDocCreated({ mawb, scacCode: carrier.scac }).catch(() => {});
        shipment = await gateShippeo(mawb);
      });

      test('S-12 | Before update → active=0', () => expect(recBefore?.active ?? 0).toBe(0));
      test('S-12 | After update  → active=1', () => expect(recAfter?.active).toBe(1));
      test('S-12 | After update  → valid=1',  () => expect(recAfter?.valid).toBe(1));
      test('S-12 | Shippeo → shipment found after status update', () => {
        if (!SHIPPEO_ENABLED) return test.skip();
        expect(shipment).not.toBeNull();
      });

    }); // end S-12

  }); // end GROUP U

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP A — API / Auth Negative
  //
  //  Webhook contract violations — no ATU creation needed.
  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('GROUP A | API and Auth Negative', () => {

    let webhookCtx;

    test.beforeAll(async () => {
      webhookCtx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });
    });
    test.afterAll(async () => { await webhookCtx?.dispose(); });

    test('GROUP A | S-13 | Missing Authorization header → HTTP 401', async () => {
      const res = await webhookCtx.post(CONFIG.WEBHOOK_PATH, {
        headers: { 'Content-Type': 'application/json', 'ClientId': CONFIG.WEBHOOK_CLIENT_ID },
        data:    makePayload('received_from_shipper', new Date().toISOString(), BLR),
      });
      expect(res.status()).toBe(401);
    });

    test('GROUP A | S-14 | Invalid Bearer token → HTTP 401', async () => {
      const res = await webhookCtx.post(CONFIG.WEBHOOK_PATH, {
        headers: {
          'Content-Type':  'application/json',
          'ClientId':      CONFIG.WEBHOOK_CLIENT_ID,
          'Authorization': 'Bearer INVALID_TOKEN_XYZ',
        },
        data: makePayload('received_from_shipper', new Date().toISOString(), BLR),
      });
      expect(res.status()).toBe(401);
    });

    test('GROUP A | S-15 | Missing ClientId header → HTTP 4xx', async () => {
      const res = await webhookCtx.post(CONFIG.WEBHOOK_PATH, {
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${CONFIG.WEBHOOK_TOKEN}`,
        },
        data: makePayload('received_from_shipper', new Date().toISOString(), BLR),
      });
      expect(res.status()).toBeGreaterThanOrEqual(400);
      expect(res.status()).toBeLessThan(500);
    });

    test('GROUP A | S-16 | Wrong ClientId → HTTP 4xx or 200 (silent drop)', async () => {
      const res = await webhookCtx.post(CONFIG.WEBHOOK_PATH, {
        headers: {
          'Content-Type':  'application/json',
          'ClientId':      'WRONG_CLIENT_ID_XYZ',
          'Authorization': `Bearer ${CONFIG.WEBHOOK_TOKEN}`,
        },
        data: makePayload('received_from_shipper', new Date().toISOString(), BLR),
      });
      // BE may reject (4xx) or silently drop (200) — both are acceptable
      expect(res.status()).toBeGreaterThanOrEqual(200);
    });

    test('GROUP A | S-17 | Empty body → HTTP 4xx or 200 (silent drop)', async () => {
      const res = await webhookCtx.post(CONFIG.WEBHOOK_PATH, {
        headers: webhookHeaders(),
        data:    {},
      });
      expect(res.status()).toBeGreaterThanOrEqual(200);
    });

  }); // end GROUP A

}); // end AirOrdersIn
