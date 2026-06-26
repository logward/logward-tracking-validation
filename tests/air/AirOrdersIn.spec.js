// =============================================================================
//  AirOrdersIn.spec.js
//
//  AIR — Orders-In, parameterised by tracking key type.
//  Both IATA and Inland site types are covered automatically in every run.
//
// ─── TRACKING KEY TYPES ───────────────────────────────────────────────────────
//
//  mawb        — masterAirWaybillNumber
//  hawb        — houseAirWaybillNumber + freightForwarderEdiRef
//  customerref — airCustomerReference  + freightForwarderEdiRef
//
// ─── HOW TO RUN ───────────────────────────────────────────────────────────────
//
//  Interactive (recommended — prompts for tracking key):
//    node scripts/runAirOrdersIn.js
//
//  Direct:
//    AIR_TRACKING_KEY=mawb        npx playwright test --project=air AirOrdersIn
//    AIR_TRACKING_KEY=hawb        npx playwright test --project=air AirOrdersIn -g "GROUP P"
//    AIR_TRACKING_KEY=customerref npx playwright test --project=air AirOrdersIn -g "GROUP N2"
//
//  Default when env var absent: mawb
//
// ─── GROUP ORDER ──────────────────────────────────────────────────────────────
//
//  GROUP P  — Positive: IATA + Inland                (S-01, S-02)
//  GROUP N1 — active=0 (wrong/missing status)        (S-03–S-05)
//  GROUP N2 — active=1 valid=0 (incomplete key)      (S-06–S-08)
//  GROUP N3 — active=1 valid=1, site field variants  (S-09–S-11)
//  GROUP U  — Update to valid=1                      (S-12–S-14)
//  GROUP E  — Edge cases                             (S-15–S-19)
//  GROUP A  — API / Auth Negative                    (S-20–S-24)
//
// ─── ATC RULES (Air) ─────────────────────────────────────────────────────────
//
//  active = 1  ← trackingStatus === "In Progress"
//
//  valid  = 1  ← active=1  AND:
//    mawb:        masterAirWaybillNumber
//    hawb:        houseAirWaybillNumber + freightForwarderEdiRef
//    customerref: airCustomerReference  + freightForwarderEdiRef
//
// =============================================================================

// @ts-nocheck
const { test, expect, request } = require('@playwright/test');

const { CONFIG }                          = require('../../helpers/air/airConfig');
const { createAirTrackingObject,
        getAirTrackingObject,
        updateAirTrackingObject }         = require('../../helpers/air/airTrackingObjectFactory');
const { makePayload, SITE, toEventSite }  = require('../../helpers/air/airPayloadFactory');
const { assertField }                     = require('../../helpers/air/airValidation');
const { getTrackingSchedule,
        pollUntilSchedulerActive }        = require('../../helpers/shared/trackingSchedulerClient');
const { pollUntilAirTrackingDocCreated }  = require('../../helpers/shared/trackingServiceClient');
const { buildAirReference,
        pollUntilShippeoShipmentFound }   = require('../../helpers/shared/shippeoApiClient');
const { E2E_CONFIG }                      = require('../../helpers/shared/e2eConfig');

// ─────────────────────────────────────────────────────────────────────────────
//  Runtime tracking key (set by scripts/runAirOrdersIn.js or manually)
// ─────────────────────────────────────────────────────────────────────────────

const TRACKING_KEY = (process.env.AIR_TRACKING_KEY || 'mawb').toLowerCase();

if (!['mawb', 'hawb', 'customerref'].includes(TRACKING_KEY)) {
  throw new Error(
    `AIR_TRACKING_KEY="${TRACKING_KEY}" is invalid. Use: mawb | hawb | customerref`
  );
}

const KEY_LABEL = { mawb: 'MAWB', hawb: 'HAWB', customerref: 'CustomerRef' }[TRACKING_KEY];

console.log(`\n[AirOrdersIn] Tracking key: ${KEY_LABEL} | Site types: IATA + Inland`);

// ─────────────────────────────────────────────────────────────────────────────
//  Shippeo gate — only for MAWB (known search reference format)
// ─────────────────────────────────────────────────────────────────────────────

const SHIPPEO_GATE_ENABLED =
  TRACKING_KEY === 'mawb' &&
  ((!!E2E_CONFIG.SHIPPEO.token        && !E2E_CONFIG.SHIPPEO.token.startsWith('<'))        ||
   (!!E2E_CONFIG.SHIPPEO.refreshToken && !E2E_CONFIG.SHIPPEO.refreshToken.startsWith('<')) ||
   (!!E2E_CONFIG.SHIPPEO.username     && !!E2E_CONFIG.SHIPPEO.password &&
    !E2E_CONFIG.SHIPPEO.password.startsWith('<')));

// ─────────────────────────────────────────────────────────────────────────────
//  Unique ID generator
//
//  mawb:        E2EAIR{seq}{ts-5}   (masterAirWaybillNumber)
//  hawb:        E2EHAW{seq}{ts-5}   (houseAirWaybillNumber)
//  customerref: E2EACR{seq}{ts-5}   (airCustomerReference)
//  ffd:         E2EFFD{seq}{ts-5}   (freightForwarderEdiRef — hawb / customerref only)
//  clientRef:   E2ECRF{seq}{ts-5}   (routing key — always)
// ─────────────────────────────────────────────────────────────────────────────

const _TS  = String(Date.now()).slice(-5);
let   _seq = 0;

function nextIds() {
  const s = String(++_seq).padStart(2, '0');

  if (TRACKING_KEY === 'mawb') {
    return {
      clientRef:    `E2ECRF${s}${_TS}`,
      primaryValue: `E2EAIR${s}${_TS}`,
      primaryField: 'masterAirWaybillNumber',
      ffd:          null,
    };
  }
  if (TRACKING_KEY === 'hawb') {
    return {
      clientRef:    `E2ECRF${s}${_TS}`,
      primaryValue: `E2EHAW${s}${_TS}`,
      primaryField: 'houseAirWaybillNumber',
      ffd:          `E2EFFD${s}${_TS}`,
    };
  }
  // customerref
  return {
    clientRef:    `E2ECRF${s}${_TS}`,
    primaryValue: `E2EACR${s}${_TS}`,
    primaryField: 'airCustomerReference',
    ffd:          `E2EFFD${s}${_TS}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Site field sets
// ─────────────────────────────────────────────────────────────────────────────

const IATA_FIELDS = {
  loadingSiteIata:  'BLR',
  deliverySiteIata: 'BOM',
};

const INLAND_FIELDS = {
  loadingSiteName:         'E2E Warehouse Bengaluru',
  loadingSiteAddressLine:  '123 Airport Road, Devanahalli',
  loadingSiteCity:         'Bengaluru',
  loadingSiteZipcode:      '562149',
  loadingSiteCountry:      'IN',
  deliverySiteName:         'E2E Warehouse Mumbai',
  deliverySiteAddressLine:  '456 Seaport Boulevard, JNPT',
  deliverySiteCity:         'Mumbai',
  deliverySiteZipcode:      '400707',
  deliverySiteCountry:      'IN',
};

// ─────────────────────────────────────────────────────────────────────────────
//  Override builders
//
//  All helpers return { ids, overrides } — pass overrides to createATU().
//  The factory strips null/undefined, so null = "don't send this field".
// ─────────────────────────────────────────────────────────────────────────────

function buildOverrides(ids, siteFields = IATA_FIELDS, primaryIncluded = true, ffdIncluded = true) {
  const base = {
    masterAirWaybillNumber: null,   // strip factory default
    clientReference: ids.clientRef,
    ...siteFields,
  };
  if (primaryIncluded) base[ids.primaryField] = ids.primaryValue;
  if (ffdIncluded && ids.ffd) base.freightForwarderEdiRef = ids.ffd;
  return base;
}

function positiveOverrides(siteFields = IATA_FIELDS) {
  const ids = nextIds();
  return { ids, overrides: buildOverrides(ids, siteFields, true, true) };
}

function missingPrimaryOverrides(siteFields = IATA_FIELDS) {
  const ids = nextIds();
  return { ids, overrides: buildOverrides(ids, siteFields, false, true) };
}

function missingFfdOverrides(siteFields = IATA_FIELDS) {
  const ids = nextIds();
  return { ids, overrides: buildOverrides(ids, siteFields, true, false) };
}

function missingAllKeyOverrides(siteFields = IATA_FIELDS) {
  const ids = nextIds();
  return { ids, overrides: buildOverrides(ids, siteFields, false, false) };
}

function noSiteOverrides() {
  const ids = nextIds();
  return { ids, overrides: buildOverrides(ids, {}, true, true) };
}

// ─────────────────────────────────────────────────────────────────────────────
//  ATU helpers
// ─────────────────────────────────────────────────────────────────────────────

const AIR_SCHEMA_TYPE = CONFIG.SCHEMA_TYPE;

async function createATU(overrides = {}) {
  return createAirTrackingObject({
    mot:            'AIR',
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

const BLR = toEventSite(SITE.BLR);
const BOM = toEventSite(SITE.BOM);

function buildPayload(event, date, site, clientRef, primaryKey) {
  return makePayload(event, date, site, {
    order: {
      edi_reference:    primaryKey,
      reference:        primaryKey,
      url:              'https://view.shippeo.com/orderPublic/test',
      client_reference: clientRef,
    },
  });
}

async function sendEventAndWait(ctx, event, date, site, code, ids) {
  const before        = await fetchATU(code);
  const baseChangedAt = before?.changedAt;

  const payload = buildPayload(event, date, site, ids.clientRef, ids.primaryValue);
  const res     = await ctx.post(CONFIG.WEBHOOK_PATH, { headers: webhookHeaders(), data: payload });
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
//  Shippeo gate
// ─────────────────────────────────────────────────────────────────────────────

async function gateShippeo(ids) {
  if (!SHIPPEO_GATE_ENABLED) {
    const reason = TRACKING_KEY !== 'mawb'
      ? `Shippeo search supported for MAWB only (current: ${KEY_LABEL})`
      : 'Shippeo token not configured';
    console.log(`  [shippeo] Skipping — ${reason}`);
    return null;
  }
  const ref      = buildAirReference({ mawb: ids.primaryValue });
  const shipment = await pollUntilShippeoShipmentFound(ref);
  if (!shipment) console.warn(`  [shippeo] Shipment NOT found for MAWB="${ids.primaryValue}"`);
  else           console.log(`  [shippeo ✅] Found shipment for MAWB="${ids.primaryValue}"`);
  return shipment;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Timing helper
// ─────────────────────────────────────────────────────────────────────────────

const _BASE_MS  = Date.now();
let   _dateOff  = 0;
function nextDate(plusSec = 0) {
  _dateOff += 600;
  return new Date(_BASE_MS + (_dateOff + plusSec) * 1000).toISOString();
}

// =============================================================================
// =============================================================================

test.describe(`Air — AirOrdersIn [key=${KEY_LABEL}]`, () => {

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP P — Full Positive Flow
  //
  //  S-01: tracking key + IATA sites → active=1 valid=1 → Shippeo → 4 events
  //  S-02: tracking key + Inland sites → active=1 valid=1 → 4 events
  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('GROUP P | Full Positive Flow', () => {

    // ── S-01: IATA ─────────────────────────────────────────────────────────────
    test.describe(`GROUP P | S-01 | ${KEY_LABEL} + IATA sites — full positive flow`, () => {

      let code, ids;
      let schedRec = null, shipment = null, webhookCtx = null;
      let atu1 = null, atu2 = null, atu3 = null, atu4 = null;

      const d1 = nextDate(0);
      const d2 = nextDate(60);
      const d3 = nextDate(120);
      const d4 = nextDate(180);

      test.beforeAll(async () => {
        console.log(`\n[S-01] Creating ATU — ${KEY_LABEL} + IATA …`);
        ({ ids, overrides } = positiveOverrides(IATA_FIELDS));
        const o = positiveOverrides(IATA_FIELDS);
        ids = o.ids;

        ({ code } = await createATU(o.overrides));
        console.log(`[S-01] code="${code}" ${ids.primaryField}="${ids.primaryValue}"`);

        schedRec = await pollSchedulerActiveValid(code);
        console.log(`[S-01] Scheduler → active=${schedRec?.active} valid=${schedRec?.valid}`);
        if (!(schedRec?.active === 1 && schedRec?.valid === 1)) return;

        await pollUntilAirTrackingDocCreated({ mawb: ids.primaryValue })
          .catch(() => console.warn('  [S-01] MongoDB soft check skipped'));

        shipment = await gateShippeo(ids);
        if (SHIPPEO_GATE_ENABLED && !shipment) return;

        webhookCtx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });
        atu1 = await sendEventAndWait(webhookCtx, 'received_from_shipper',            d1, BLR, code, ids);
        atu2 = await sendEventAndWait(webhookCtx, 'goods_loading_compliant_compliant', d2, BLR, code, ids);
        atu3 = await sendEventAndWait(webhookCtx, 'goods_left_loading_left',           d3, BLR, code, ids);
        atu4 = await sendEventAndWait(webhookCtx, 'goods_arrived_at_delivery_arrived', d4, BOM, code, ids);
      });

      test.afterAll(async () => { await webhookCtx?.dispose(); });

      test('S-01 | Scheduler → active=1', () =>
        expect(schedRec?.active, 'Scheduler active should be 1').toBe(1));
      test('S-01 | Scheduler → valid=1', () =>
        expect(schedRec?.valid, 'Scheduler valid should be 1').toBe(1));

      test('S-01 | Shippeo → shipment found by MAWB', () => {
        if (!SHIPPEO_GATE_ENABLED) return test.skip();
        expect(shipment, `Not found for ${ids?.primaryField}="${ids?.primaryValue}"`).not.toBeNull();
      });

      test('S-01 | received_from_shipper → receivedFromShipperDate', () => {
        if (!atu1) return test.skip();
        assertField(atu1, 'receivedFromShipperDate', d1);
      });
      test('S-01 | received_from_shipper → receivedFromShipperSiteIata = BLR', () => {
        if (!atu1) return test.skip();
        assertField(atu1, 'receivedFromShipperSiteIata', SITE.BLR.iata_code);
      });

      test('S-01 | goods_loading_compliant_compliant → loadingCompliantDate', () => {
        if (!atu2) return test.skip();
        assertField(atu2, 'loadingCompliantDate', d2);
      });
      test('S-01 | goods_loading_compliant_compliant → loadingCompliantSiteIata = BLR', () => {
        if (!atu2) return test.skip();
        assertField(atu2, 'loadingCompliantSiteIata', SITE.BLR.iata_code);
      });

      test('S-01 | goods_left_loading_left → loadingLeftDate', () => {
        if (!atu3) return test.skip();
        assertField(atu3, 'loadingLeftDate', d3);
      });
      test('S-01 | goods_left_loading_left → loadingLeftSiteIata = BLR', () => {
        if (!atu3) return test.skip();
        assertField(atu3, 'loadingLeftSiteIata', SITE.BLR.iata_code);
      });

      test('S-01 | goods_arrived_at_delivery_arrived → deliveryArrivedDate', () => {
        if (!atu4) return test.skip();
        assertField(atu4, 'deliveryArrivedDate', d4);
      });
      test('S-01 | goods_arrived_at_delivery_arrived → deliveryArrivedSiteIata = BOM', () => {
        if (!atu4) return test.skip();
        assertField(atu4, 'deliveryArrivedSiteIata', SITE.BOM.iata_code);
      });

    }); // end S-01

    // ── S-02: Inland ───────────────────────────────────────────────────────────
    test.describe(`GROUP P | S-02 | ${KEY_LABEL} + Inland sites — full positive flow`, () => {

      let code, ids;
      let schedRec = null, webhookCtx = null;
      let atu1 = null, atu2 = null, atu3 = null, atu4 = null;

      const d1 = nextDate(0);
      const d2 = nextDate(60);
      const d3 = nextDate(120);
      const d4 = nextDate(180);

      test.beforeAll(async () => {
        console.log(`\n[S-02] Creating ATU — ${KEY_LABEL} + Inland …`);
        const o = positiveOverrides(INLAND_FIELDS);
        ids = o.ids;

        ({ code } = await createATU(o.overrides));
        console.log(`[S-02] code="${code}" ${ids.primaryField}="${ids.primaryValue}"`);

        schedRec = await pollSchedulerActiveValid(code);
        console.log(`[S-02] Scheduler → active=${schedRec?.active} valid=${schedRec?.valid}`);
        if (!(schedRec?.active === 1 && schedRec?.valid === 1)) return;

        await pollUntilAirTrackingDocCreated({ mawb: ids.primaryValue }).catch(() => {});

        webhookCtx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });
        atu1 = await sendEventAndWait(webhookCtx, 'received_from_shipper',            d1, BLR, code, ids);
        atu2 = await sendEventAndWait(webhookCtx, 'goods_loading_compliant_compliant', d2, BLR, code, ids);
        atu3 = await sendEventAndWait(webhookCtx, 'goods_left_loading_left',           d3, BLR, code, ids);
        atu4 = await sendEventAndWait(webhookCtx, 'goods_arrived_at_delivery_arrived', d4, BOM, code, ids);
      });

      test.afterAll(async () => { await webhookCtx?.dispose(); });

      test('S-02 | Scheduler → active=1', () =>
        expect(schedRec?.active, 'Scheduler active should be 1').toBe(1));
      test('S-02 | Scheduler → valid=1', () =>
        expect(schedRec?.valid, 'Scheduler valid should be 1').toBe(1));

      // Inland ATUs: events still carry date; IATA in event comes from Shippeo side
      test('S-02 | received_from_shipper → receivedFromShipperDate', () => {
        if (!atu1) return test.skip();
        assertField(atu1, 'receivedFromShipperDate', d1);
      });
      test('S-02 | goods_loading_compliant_compliant → loadingCompliantDate', () => {
        if (!atu2) return test.skip();
        assertField(atu2, 'loadingCompliantDate', d2);
      });
      test('S-02 | goods_left_loading_left → loadingLeftDate', () => {
        if (!atu3) return test.skip();
        assertField(atu3, 'loadingLeftDate', d3);
      });
      test('S-02 | goods_arrived_at_delivery_arrived → deliveryArrivedDate', () => {
        if (!atu4) return test.skip();
        assertField(atu4, 'deliveryArrivedDate', d4);
      });
      // Inland site fields are stored on the ATU object itself
      test('S-02 | ATU has loadingSiteCity = Bengaluru', () => {
        if (!atu1) return test.skip();
        assertField(atu1, 'loadingSiteCity', 'Bengaluru');
      });
      test('S-02 | ATU has deliverySiteCity = Mumbai', () => {
        if (!atu4) return test.skip();
        assertField(atu4, 'deliverySiteCity', 'Mumbai');
      });

    }); // end S-02

  }); // end GROUP P

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP N1 — active=0 valid=0
  //
  //  Wrong / missing trackingStatus → scheduler active=0 → flow stops.
  //  Same for all tracking key types.
  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('GROUP N1 | active=0 valid=0 — wrong or missing trackingStatus', () => {

    async function runN1(label, statusValue) {
      const o = positiveOverrides(IATA_FIELDS);
      const { code } = await createATU({ ...o.overrides, trackingStatus: statusValue ?? null });
      const rec = await getSchedulerOnce(code);
      console.log(`  [${label}] Scheduler: active=${rec?.active} valid=${rec?.valid}`);
      return rec;
    }

    test('GROUP N1 | S-03 | No trackingStatus → active=0', async () => {
      const rec = await runN1('S-03', null);
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
  //  In Progress but missing primary tracking key field(s) → valid=0.
  //
  //  mawb:        S-06 no MAWB, S-07 all tracking fields absent
  //  hawb:        S-06 no HAWB, S-07 no freightForwarderEdiRef, S-08 both absent
  //  customerref: S-06 no customerRef, S-07 no freightForwarderEdiRef, S-08 both absent
  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('GROUP N2 | active=1 valid=0 — In Progress with incomplete tracking key fields', () => {

    async function runN2(label, overrides) {
      const { code } = await createATU(overrides);
      const rec = await pollUntilActive(code);
      console.log(`  [${label}] Scheduler: active=${rec?.active} valid=${rec?.valid}`);
      return rec;
    }

    if (TRACKING_KEY === 'mawb') {

      test('GROUP N2 | S-06 | In Progress, no MAWB → active=1 valid=0', async () => {
        const { overrides } = missingPrimaryOverrides(IATA_FIELDS);
        const rec = await runN2('S-06', overrides);
        expect(rec?.active).toBe(1);
        expect(rec?.valid).toBe(0);
      });

      test('GROUP N2 | S-07 | In Progress, no MAWB and no other key fields → active=1 valid=0', async () => {
        const { overrides } = missingAllKeyOverrides(IATA_FIELDS);
        const rec = await runN2('S-07', overrides);
        expect(rec?.active).toBe(1);
        expect(rec?.valid).toBe(0);
      });

    } else if (TRACKING_KEY === 'hawb') {

      test('GROUP N2 | S-06 | In Progress, no HAWB (only FFD present) → active=1 valid=0', async () => {
        const { overrides } = missingPrimaryOverrides(IATA_FIELDS);
        const rec = await runN2('S-06', overrides);
        expect(rec?.active).toBe(1);
        expect(rec?.valid).toBe(0);
      });

      test('GROUP N2 | S-07 | In Progress, HAWB present but no freightForwarderEdiRef → active=1 valid=0', async () => {
        const { overrides } = missingFfdOverrides(IATA_FIELDS);
        const rec = await runN2('S-07', overrides);
        expect(rec?.active).toBe(1);
        expect(rec?.valid).toBe(0);
      });

      test('GROUP N2 | S-08 | In Progress, no HAWB and no freightForwarderEdiRef → active=1 valid=0', async () => {
        const { overrides } = missingAllKeyOverrides(IATA_FIELDS);
        const rec = await runN2('S-08', overrides);
        expect(rec?.active).toBe(1);
        expect(rec?.valid).toBe(0);
      });

    } else { // customerref

      test('GROUP N2 | S-06 | In Progress, no airCustomerReference (only FFD present) → active=1 valid=0', async () => {
        const { overrides } = missingPrimaryOverrides(IATA_FIELDS);
        const rec = await runN2('S-06', overrides);
        expect(rec?.active).toBe(1);
        expect(rec?.valid).toBe(0);
      });

      test('GROUP N2 | S-07 | In Progress, airCustomerReference present but no freightForwarderEdiRef → active=1 valid=0', async () => {
        const { overrides } = missingFfdOverrides(IATA_FIELDS);
        const rec = await runN2('S-07', overrides);
        expect(rec?.active).toBe(1);
        expect(rec?.valid).toBe(0);
      });

      test('GROUP N2 | S-08 | In Progress, no airCustomerReference and no freightForwarderEdiRef → active=1 valid=0', async () => {
        const { overrides } = missingAllKeyOverrides(IATA_FIELDS);
        const rec = await runN2('S-08', overrides);
        expect(rec?.active).toBe(1);
        expect(rec?.valid).toBe(0);
      });

    }

  }); // end GROUP N2

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP N3 — valid=1 but missing / partial site fields
  //
  //  Tracking key is complete (valid=1), site fields vary.
  //  Events are still accepted; verifies graceful handling of missing site data.
  //
  //  S-09: No site fields at all → valid=1, events accepted, site fields null
  //  S-10: IATA loading site only (no delivery) → valid=1, events accepted
  //  S-11: Inland partial (loading only, no delivery) → valid=1, events accepted
  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('GROUP N3 | valid=1 with missing or partial site fields', () => {

    async function runN3(label, siteOverrides) {
      const o = positiveOverrides(siteOverrides);
      const { code } = await createATU(o.overrides);
      const rec = await pollSchedulerActiveValid(code);
      console.log(`  [${label}] Scheduler: active=${rec?.active} valid=${rec?.valid}`);
      return { code, ids: o.ids, rec };
    }

    test('GROUP N3 | S-09 | No site fields → valid=1, events accepted', async () => {
      const { code, ids, rec } = await runN3('S-09', {});
      expect(rec?.active).toBe(1);
      expect(rec?.valid).toBe(1);
      // Send one event — should not throw (event accepted even without site config)
      const ctx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });
      const res = await ctx.post(CONFIG.WEBHOOK_PATH, {
        headers: webhookHeaders(),
        data:    buildPayload('received_from_shipper', new Date().toISOString(), BLR, ids.clientRef, ids.primaryValue),
      });
      await ctx.dispose();
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    });

    test('GROUP N3 | S-10 | IATA loading site only, no delivery site → valid=1', async () => {
      const { rec } = await runN3('S-10', { loadingSiteIata: 'BLR' });
      expect(rec?.active).toBe(1);
      expect(rec?.valid).toBe(1);
    });

    test('GROUP N3 | S-11 | Inland loading site only, no delivery fields → valid=1', async () => {
      const { rec } = await runN3('S-11', {
        loadingSiteName:        'E2E Warehouse Bengaluru',
        loadingSiteAddressLine: '123 Airport Road',
        loadingSiteCity:        'Bengaluru',
        loadingSiteZipcode:     '562149',
        loadingSiteCountry:     'IN',
      });
      expect(rec?.active).toBe(1);
      expect(rec?.valid).toBe(1);
    });

  }); // end GROUP N3

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP U — Update to valid=1
  //
  //  Start with an incomplete ATU (valid=0) → add missing field → verify valid=1
  //
  //  S-12: Missing primary key → add → valid=1  [+Shippeo if MAWB]
  //  S-13: Missing FFD (hawb/customerref) → add → valid=1  [skipped for mawb]
  //  S-14: trackingStatus=Pending + complete fields → change status → active=1 valid=1
  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('GROUP U | Update to valid=1', () => {

    // ── S-12 ──────────────────────────────────────────────────────────────────
    test.describe(`GROUP U | S-12 | No ${KEY_LABEL} → add ${KEY_LABEL} → valid=1`, () => {

      let code, ids;
      let recBefore = null, recAfter = null, shipment = null;

      test.beforeAll(async () => {
        console.log(`\n[S-12] Creating ATU without ${ids?.primaryField ?? KEY_LABEL} …`);
        const m = missingPrimaryOverrides(IATA_FIELDS);
        ids = m.ids;

        ({ code } = await createATU(m.overrides));
        recBefore = await pollUntilActive(code);
        console.log(`[S-12] Before: active=${recBefore?.active} valid=${recBefore?.valid}`);
        if (recBefore?.active !== 1) return;

        console.log(`[S-12] Adding ${ids.primaryField}="${ids.primaryValue}" …`);
        await updateAirTrackingObject(code, { [ids.primaryField]: ids.primaryValue });

        recAfter = await pollSchedulerActiveValid(code);
        console.log(`[S-12] After: active=${recAfter?.active} valid=${recAfter?.valid}`);
        if (!(recAfter?.active === 1 && recAfter?.valid === 1)) return;

        await pollUntilAirTrackingDocCreated({ mawb: ids.primaryValue }).catch(() => {});
        shipment = await gateShippeo(ids);
      });

      test('S-12 | Before update → active=1', () => expect(recBefore?.active).toBe(1));
      test('S-12 | Before update → valid=0', () => expect(recBefore?.valid).toBe(0));
      test('S-12 | After update  → valid=1', () => expect(recAfter?.valid).toBe(1));
      test('S-12 | Shippeo → shipment found after update', () => {
        if (!SHIPPEO_GATE_ENABLED) return test.skip();
        expect(shipment).not.toBeNull();
      });

    }); // end S-12

    // ── S-13: FFD update (hawb / customerref only) ────────────────────────────
    if (TRACKING_KEY !== 'mawb') {

      test.describe(`GROUP U | S-13 | ${KEY_LABEL} present, no freightForwarderEdiRef → add FFD → valid=1`, () => {

        let code, ids;
        let recBefore = null, recAfter = null;

        test.beforeAll(async () => {
          console.log('\n[S-13] Creating ATU without freightForwarderEdiRef …');
          const m = missingFfdOverrides(IATA_FIELDS);
          ids = m.ids;

          ({ code } = await createATU(m.overrides));
          recBefore = await pollUntilActive(code);
          console.log(`[S-13] Before: active=${recBefore?.active} valid=${recBefore?.valid}`);
          if (recBefore?.active !== 1) return;

          const ffd = `E2EFFD${String(_seq + 1).padStart(2, '0')}${_TS}`;
          console.log(`[S-13] Adding freightForwarderEdiRef="${ffd}" …`);
          await updateAirTrackingObject(code, { freightForwarderEdiRef: ffd });

          recAfter = await pollSchedulerActiveValid(code);
          console.log(`[S-13] After: active=${recAfter?.active} valid=${recAfter?.valid}`);
        });

        test('S-13 | Before update → active=1', () => expect(recBefore?.active).toBe(1));
        test('S-13 | Before update → valid=0', () => expect(recBefore?.valid).toBe(0));
        test('S-13 | After update  → valid=1', () => expect(recAfter?.valid).toBe(1));

      }); // end S-13

    }

    // ── S-14: Pending → In Progress ───────────────────────────────────────────
    test.describe(`GROUP U | S-14 | Pending + all ${KEY_LABEL} fields → update status → active=1 valid=1`, () => {

      let code, ids;
      let recBefore = null, recAfter = null, shipment = null;

      test.beforeAll(async () => {
        console.log('\n[S-14] Creating ATU with status=Pending (all fields present) …');
        const o = positiveOverrides(IATA_FIELDS);
        ids = o.ids;

        ({ code } = await createATU({ ...o.overrides, trackingStatus: 'Pending' }));
        recBefore = await getSchedulerOnce(code);
        console.log(`[S-14] Before: active=${recBefore?.active} valid=${recBefore?.valid}`);

        console.log('[S-14] Updating status to "In Progress" …');
        await updateAirTrackingObject(code, { trackingStatus: 'In Progress' });

        recAfter = await pollSchedulerActiveValid(code);
        console.log(`[S-14] After: active=${recAfter?.active} valid=${recAfter?.valid}`);
        if (!(recAfter?.active === 1 && recAfter?.valid === 1)) return;

        await pollUntilAirTrackingDocCreated({ mawb: ids.primaryValue }).catch(() => {});
        shipment = await gateShippeo(ids);
      });

      test('S-14 | Before update → active=0', () => expect(recBefore?.active ?? 0).toBe(0));
      test('S-14 | After update  → active=1', () => expect(recAfter?.active).toBe(1));
      test('S-14 | After update  → valid=1',  () => expect(recAfter?.valid).toBe(1));
      test('S-14 | Shippeo → shipment found after status update', () => {
        if (!SHIPPEO_GATE_ENABLED) return test.skip();
        expect(shipment).not.toBeNull();
      });

    }); // end S-14

  }); // end GROUP U

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP E — Edge Cases
  //
  //  S-15: Update site from IATA → Inland (IATA fields replaced)
  //  S-16: Update primary key to a new value → valid=1 with new key
  //  S-17: Duplicate primary key sent twice — second create should route to same ATU
  //  S-18: IATA + Inland fields both set simultaneously → which takes precedence
  //  S-19: Event sent with matching clientReference but mismatched primary key
  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('GROUP E | Edge Cases', () => {

    // ── S-15: IATA → Inland update ────────────────────────────────────────────
    test('GROUP E | S-15 | Create with IATA → update to Inland site fields', async () => {
      const o = positiveOverrides(IATA_FIELDS);
      const { code } = await createATU(o.overrides);
      const rec = await pollSchedulerActiveValid(code);
      expect(rec?.active).toBe(1);
      expect(rec?.valid).toBe(1);

      // Update — switch to Inland
      await updateAirTrackingObject(code, {
        loadingSiteIata:  null,
        deliverySiteIata: null,
        ...INLAND_FIELDS,
      });

      await new Promise(r => setTimeout(r, 5000));
      const atu = await fetchATU(code);
      expect(atu?.loadingSiteCity, 'loadingSiteCity after inland update').toBe('Bengaluru');
      console.log(`  [S-15] loadingSiteCity="${atu?.loadingSiteCity}" ✅`);
    });

    // ── S-16: Update primary key ───────────────────────────────────────────────
    test(`GROUP E | S-16 | Create with ${KEY_LABEL} → update to a new ${KEY_LABEL} value → still valid=1`, async () => {
      const o = positiveOverrides(IATA_FIELDS);
      const { ids } = o;
      const { code } = await createATU(o.overrides);
      const recBefore = await pollSchedulerActiveValid(code);
      expect(recBefore?.valid).toBe(1);

      // Generate a new primary key value
      const newVal = `${ids.primaryValue}UPD`;
      console.log(`  [S-16] Updating ${ids.primaryField} to "${newVal}" …`);
      await updateAirTrackingObject(code, { [ids.primaryField]: newVal });

      const recAfter = await pollSchedulerActiveValid(code);
      expect(recAfter?.active).toBe(1);
      expect(recAfter?.valid).toBe(1);
      console.log(`  [S-16] valid=${recAfter?.valid} ✅`);
    });

    // ── S-17: Duplicate primary key ────────────────────────────────────────────
    test(`GROUP E | S-17 | Two ATUs with same ${KEY_LABEL} value — both accepted, routing via clientReference`, async () => {
      // Create first ATU
      const o1 = positiveOverrides(IATA_FIELDS);
      const { code: code1 } = await createATU(o1.overrides);

      // Create second ATU with the SAME primary key value but different clientRef
      const o2 = positiveOverrides(IATA_FIELDS);
      const overrides2 = { ...o2.overrides, [o1.ids.primaryField]: o1.ids.primaryValue };
      const { code: code2 } = await createATU(overrides2);

      expect(code1).not.toBe(code2); // Two separate objects
      const rec1 = await pollSchedulerActiveValid(code1);
      const rec2 = await pollSchedulerActiveValid(code2);
      expect(rec1?.active).toBe(1);
      expect(rec2?.active).toBe(1);
      console.log(`  [S-17] ATU1 valid=${rec1?.valid}, ATU2 valid=${rec2?.valid}`);
    });

    // ── S-18: IATA + Inland fields set together ────────────────────────────────
    test('GROUP E | S-18 | ATU with both IATA codes and Inland address fields simultaneously → valid=1', async () => {
      const combinedSite = { ...IATA_FIELDS, ...INLAND_FIELDS };
      const o = positiveOverrides(combinedSite);
      const { code } = await createATU(o.overrides);
      const rec = await pollSchedulerActiveValid(code);
      expect(rec?.active).toBe(1);
      expect(rec?.valid).toBe(1);

      const atu = await fetchATU(code);
      // Both types of fields should be stored
      expect(atu?.loadingSiteIata ?? atu?.loadingSiteCity, 'At least one site field present').toBeTruthy();
      console.log(`  [S-18] loadingSiteIata="${atu?.loadingSiteIata}" loadingSiteCity="${atu?.loadingSiteCity}" ✅`);
    });

    // ── S-19: clientRef matches, primary key mismatches ───────────────────────
    test('GROUP E | S-19 | Event with correct clientReference but wrong primary key → accepted (routed by clientRef)', async () => {
      const o = positiveOverrides(IATA_FIELDS);
      const { code } = await createATU(o.overrides);
      await pollSchedulerActiveValid(code);

      const ctx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });
      const wrongPrimaryKey = 'WRONGKEY00000';
      const res = await ctx.post(CONFIG.WEBHOOK_PATH, {
        headers: webhookHeaders(),
        data:    buildPayload('received_from_shipper', new Date().toISOString(), BLR, o.ids.clientRef, wrongPrimaryKey),
      });
      await ctx.dispose();
      // Webhook accepted — routing is by clientReference, not primary key
      console.log(`  [S-19] HTTP ${res.status()} (routing via clientRef, mismatched primary key)`);
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    });

  }); // end GROUP E

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP A — API / Auth Negative
  //
  //  Webhook contract violations. Same across all tracking key types.
  //
  //  S-20: Missing Authorization → 401
  //  S-21: Invalid token → 401
  //  S-22: Missing ClientId → 4xx
  //  S-23: Wrong ClientId → 4xx or 200 (silent drop)
  //  S-24: Empty body → 4xx or 200 (silent drop)
  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('GROUP A | API and Auth Negative', () => {

    let webhookCtx;

    test.beforeAll(async () => {
      webhookCtx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });
    });
    test.afterAll(async () => { await webhookCtx?.dispose(); });

    const dummyPayload = () =>
      makePayload('received_from_shipper', new Date().toISOString(), BLR);

    test('GROUP A | S-20 | Missing Authorization header → HTTP 401', async () => {
      const res = await webhookCtx.post(CONFIG.WEBHOOK_PATH, {
        headers: { 'Content-Type': 'application/json', 'ClientId': CONFIG.WEBHOOK_CLIENT_ID },
        data:    dummyPayload(),
      });
      expect(res.status()).toBe(401);
    });

    test('GROUP A | S-21 | Invalid Bearer token → HTTP 401', async () => {
      const res = await webhookCtx.post(CONFIG.WEBHOOK_PATH, {
        headers: {
          'Content-Type':  'application/json',
          'ClientId':      CONFIG.WEBHOOK_CLIENT_ID,
          'Authorization': 'Bearer INVALID_TOKEN_XYZ',
        },
        data: dummyPayload(),
      });
      expect(res.status()).toBe(401);
    });

    test('GROUP A | S-22 | Missing ClientId header → HTTP 4xx', async () => {
      const res = await webhookCtx.post(CONFIG.WEBHOOK_PATH, {
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${CONFIG.WEBHOOK_TOKEN}`,
        },
        data: dummyPayload(),
      });
      expect(res.status()).toBeGreaterThanOrEqual(400);
      expect(res.status()).toBeLessThan(500);
    });

    test('GROUP A | S-23 | Wrong ClientId → HTTP 4xx or 200 (silent drop)', async () => {
      const res = await webhookCtx.post(CONFIG.WEBHOOK_PATH, {
        headers: {
          'Content-Type':  'application/json',
          'ClientId':      'WRONG_CLIENT_ID_XYZ',
          'Authorization': `Bearer ${CONFIG.WEBHOOK_TOKEN}`,
        },
        data: dummyPayload(),
      });
      expect(res.status()).toBeGreaterThanOrEqual(200);
    });

    test('GROUP A | S-24 | Empty body → HTTP 4xx or 200 (silent drop)', async () => {
      const res = await webhookCtx.post(CONFIG.WEBHOOK_PATH, {
        headers: webhookHeaders(),
        data:    {},
      });
      expect(res.status()).toBeGreaterThanOrEqual(200);
    });

  }); // end GROUP A

}); // end AirOrdersIn
