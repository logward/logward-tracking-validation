// =============================================================================
//  AirEventsOut.spec.js
//
//  AIR — Full Lifecycle Test
//  Orders-In (A-01 to A-04)  +  ALL Events-Out field-mapping groups
//
//  Creates a FRESH ATU each run — no pre-seeded data needed.
//  All webhook payloads are automatically injected with the new ATU's
//  clientReference and MAWB so every event routes to the correct ATU.
//
// ─── BLOCK / GROUP ORDER ─────────────────────────────────────────────────────
//
//  BLOCK A  — Orders-In gate             (A-01 to A-04)
//  BLOCK D  — Identifiers                (D-01)
//  BLOCK T2 — Type 2 exact events        (9 events, 1 webhook each)
//  BLOCK T3 — Type 3 starts-with events  (6 events, 1 webhook each)
//  BLOCK T4 — Type 4 hub slot events     (10 hub events: 4 random hubs × arrived/left + 2 OR aliases)
//  BLOCK T5 — Type 5 routing events      (3 events × loading/delivery/hub per hub)
//  BLOCK N    — Negative / Auth            (N-01 to N-05)
//  BLOCK NULL — Null field handling       (NULL-01 to NULL-04)
//  BLOCK EDGE — Edge cases               (EDGE-01 to EDGE-06)
//  BLOCK AON  — Always-on field checks   (AON-01 to AON-04)
//  BLOCK S    — Final ATU field state summary
//
// ─── HOW TO RUN ───────────────────────────────────────────────────────────────
//
//  Full run:
//    npx playwright test --project=air AirEventsOut --reporter=list
//
//  Single block:
//    npx playwright test --project=air AirEventsOut -g "BLOCK T2"
//    npx playwright test --project=air AirEventsOut -g "BLOCK T4"
//    npx playwright test --project=air AirEventsOut -g "BLOCK N"
//
//  Single event:
//    npx playwright test --project=air AirEventsOut -g "received_from_shipper"
//    npx playwright test --project=air AirEventsOut -g "manifested — hub \(DXB\)"
//
// ─── ROUTING ─────────────────────────────────────────────────────────────────
//
//  Events are routed to the fresh ATU via order.client_reference = clientRef.
//  order.edi_reference = MAWB (masterAirWaybillNumber) — matches ATC lookup.
//
// =============================================================================

// @ts-nocheck
const { test, expect, request } = require('@playwright/test');

const { CONFIG }                          = require('../../helpers/air/airConfig');
const { createAirTrackingObject }         = require('../../helpers/air/airTrackingObjectFactory');
const { resolveHubSlot }                  = require('../../helpers/air/airHubHelpers');
const { assertField, valuesMatch }        = require('../../helpers/air/airValidation');
const { getAdminToken }                   = require('../../helpers/shared/cognitoAuth');
const { pollUntilSchedulerActive }        = require('../../helpers/shared/trackingSchedulerClient');
const { pollUntilAirTrackingDocCreated }  = require('../../helpers/shared/trackingServiceClient');
const { buildAirReference,
        pollUntilShippeoShipmentFound }   = require('../../helpers/shared/shippeoApiClient');
const { E2E_CONFIG }                      = require('../../helpers/shared/e2eConfig');
const {
  makePayload,
  runDate,
  SITE, toEventSite, toPartialEventSite,
  T2_DATES, T3_DATES, T4_DATES, T5_DATES,
} = require('../../helpers/air/airPayloadFactory');
const { pickHubs } = require('../../helpers/air/airSites');

// ─────────────────────────────────────────────────────────────────────────────
//  Hub pool — 4 unique airports chosen at random each run.
//  Slot assignment: HUBS[0]=stop1, HUBS[1]=stop2, HUBS[2]=stop3, HUBS[3]=stop4.
//  T4_DATES keys are positional: dxb*=slot1, fra*=slot2, sin*=slot3, ams*=slot4.
// ─────────────────────────────────────────────────────────────────────────────
const HUBS = pickHubs(4);

// ─────────────────────────────────────────────────────────────────────────────
//  Shared run state — populated by A-01 and used by all subsequent blocks
// ─────────────────────────────────────────────────────────────────────────────

const state = {
  code:         null,   // Logward object code (used for GET + webhook routing)
  mawb:         null,   // masterAirWaybillNumber (generated per run)
  clientRef:    null,   // clientReference (webhook routing key)
  atu:          null,   // last fetched ATU snapshot
};

// ─────────────────────────────────────────────────────────────────────────────
//  Shippeo gate flag
// ─────────────────────────────────────────────────────────────────────────────

const SHIPPEO_ENABLED =
  (!!E2E_CONFIG.SHIPPEO.token        && !E2E_CONFIG.SHIPPEO.token.startsWith('<'))        ||
  (!!E2E_CONFIG.SHIPPEO.refreshToken && !E2E_CONFIG.SHIPPEO.refreshToken.startsWith('<')) ||
  (!!E2E_CONFIG.SHIPPEO.username     && !!E2E_CONFIG.SHIPPEO.password &&
   !E2E_CONFIG.SHIPPEO.password.startsWith('<'));

// ─────────────────────────────────────────────────────────────────────────────
//  Headers (Cognito auto-refresh for long E2E runs)
// ─────────────────────────────────────────────────────────────────────────────

const adminHeaders = async () => ({
  'Authorization': `Bearer ${await getAdminToken()}`,
  'Content-Type':  'application/json',
  accept:          'application/json',
});

const webhookHeaders = () => ({
  'Content-Type':  'application/json',
  'ClientId':      CONFIG.WEBHOOK_CLIENT_ID,
  'Authorization': `Bearer ${CONFIG.WEBHOOK_TOKEN}`,
});

// ─────────────────────────────────────────────────────────────────────────────
//  ATU GET helper
// ─────────────────────────────────────────────────────────────────────────────

async function getATU() {
  const ctx = await request.newContext({ baseURL: CONFIG.ADMIN_BASE_URL });
  try {
    const res = await ctx.get(
      `${CONFIG.GET_PATH}/${state.code}`,
      { headers: await adminHeaders() }
    );
    if (!res.ok()) throw new Error(`GET ATU → HTTP ${res.status()}`);
    const body = await res.json();
    return body.data ?? body;
  } finally {
    await ctx.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  E2E payload builder — injects fresh ATU identifiers into every payload
// ─────────────────────────────────────────────────────────────────────────────

function makeE2EPayload(event, date, eventSite, extras = {}) {
  const base = makePayload(event, date, eventSite, extras);
  // Override order block so the event routes to the freshly created ATU
  base.order = {
    ...base.order,
    edi_reference:    state.mawb,
    reference:        state.mawb,
    url:              'https://view.shippeo.com/orderPublic/test',
    client_reference: state.clientRef,
  };
  return base;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Core send-and-wait (snapshot → POST → poll changedAt → return ATU)
// ─────────────────────────────────────────────────────────────────────────────

async function sendAndWaitE2E(payload) {
  const webhookCtx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });
  const before     = await getATU().catch(() => null);
  const baseline   = before?.lastChangedAt ?? null;

  console.log(`  [e2e] Before → lastChangedAt="${baseline}"`);

  const res    = await webhookCtx.post(CONFIG.WEBHOOK_PATH, { headers: webhookHeaders(), data: payload });
  const status = res.status();
  console.log(`  [e2e] Webhook HTTP ${status} | event="${payload.situation?.event}"`);

  await new Promise(r => setTimeout(r, 1500));

  const deadline = Date.now() + 45000;
  let atu = null;
  while (Date.now() < deadline) {
    atu = await getATU().catch(() => null);
    if (atu?.lastChangedAt !== baseline) {
      console.log(`  [e2e] lastChangedAt updated: "${baseline}" → "${atu?.lastChangedAt}"`);
      // Extra settle time — some field writes (hub slots) arrive slightly after changedAt
      await new Promise(r => setTimeout(r, 4000));
      atu = await getATU().catch(() => atu);
      break;
    }
    console.log(`  [e2e] still "${atu?.lastChangedAt}" — waiting…`);
    await new Promise(r => setTimeout(r, 3000));
  }

  // Retry once if ATU did not update — pipeline may need activation time
  if (atu?.lastChangedAt === baseline) {
    console.log('  [e2e] No update in 45s — waiting 30s and retrying…');
    await new Promise(r => setTimeout(r, 30000));
    const res2 = await webhookCtx.post(CONFIG.WEBHOOK_PATH, { headers: webhookHeaders(), data: payload });
    console.log(`  [e2e] Retry HTTP ${res2.status()}`);
    await new Promise(r => setTimeout(r, 1500));
    const d2 = Date.now() + 45000;
    while (Date.now() < d2) {
      atu = await getATU().catch(() => null);
      if (atu?.lastChangedAt !== baseline) break;
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  await webhookCtx.dispose();
  return { status, atu, before };
}

// Convenience wrapper — only returns ATU (used by most test.beforeAll blocks)
async function send(event, date, eventSite, extras = {}) {
  const { atu } = await sendAndWaitE2E(makeE2EPayload(event, date, eventSite, extras));
  return atu;
}

// ─────────────────────────────────────────────────────────────────────────────
//  assertNotChanged — for negative tests
// ─────────────────────────────────────────────────────────────────────────────

function assertNotChanged(before, after, field) {
  const bv = before?.[field] ?? null;
  const av = after?.[field]  ?? null;
  console.log(`  [neg] ${field}: before="${bv}" after="${av}"`);
  expect(av, `"${field}" should NOT have changed`).toBe(bv);
}

// ─────────────────────────────────────────────────────────────────────────────
//  createFreshATU / sendFreshAndWait
//  Used by BLOCK NULL, BLOCK EDGE, and BLOCK AON for isolated test scenarios.
// ─────────────────────────────────────────────────────────────────────────────

async function createFreshATU(loadingSiteIata = 'BLR', deliverySiteIata = 'BOM', loadingSiteCountry = 'IN', deliverySiteCountry = 'IN') {
  const result = await createAirTrackingObject({
    mot:                    'AIR',
    trackingStatus:         'In Progress',
    masterAirWaybillNumber: undefined,
    loadingSiteIata,
    deliverySiteIata,
    loadingSiteCountry,
    deliverySiteCountry,
  });
  return { code: result.code, mawb: result.mawb, clientRef: result.clientReference };
}

async function sendFreshAndWait(xState, event, date, eventSite, extras = {}) {
  const adminCtx   = await request.newContext({ baseURL: CONFIG.ADMIN_BASE_URL });
  const webhookCtx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });

  const getX = async () => {
    const res  = await adminCtx.get(`${CONFIG.GET_PATH}/${xState.code}`, { headers: await adminHeaders() });
    if (!res.ok()) return null;
    const body = await res.json();
    return body.data ?? body;
  };

  const before   = await getX();
  const baseline = before?.lastChangedAt ?? null;

  const payload = makePayload(event, date, eventSite, extras);
  payload.order = {
    ...payload.order,
    edi_reference:    xState.mawb,
    reference:        xState.mawb,
    url:              'https://view.shippeo.com/orderPublic/test',
    client_reference: xState.clientRef,
  };

  const res    = await webhookCtx.post(CONFIG.WEBHOOK_PATH, { headers: webhookHeaders(), data: payload });
  const status = res.status();
  console.log(`  [fresh] HTTP ${status} | event="${event}"`);

  await new Promise(r => setTimeout(r, 1500));
  const deadline = Date.now() + 45000;
  let atu = null;
  while (Date.now() < deadline) {
    atu = await getX();
    if (atu?.lastChangedAt !== baseline) {
      await new Promise(r => setTimeout(r, 4000));
      atu = await getX();
      break;
    }
    await new Promise(r => setTimeout(r, 3000));
  }

  await adminCtx.dispose();
  await webhookCtx.dispose();
  return { status, atu };
}

// =============================================================================
// =============================================================================

test.describe.serial('AIR — Full Lifecycle (Orders-In + Events-Out)', () => {

  // ===========================================================================
  //  BLOCK A — ORDERS-IN
  //
  //  Creates a fresh ATU each run. Subsequent blocks depend on A-01 passing.
  // ===========================================================================

  test('A-01 | Orders-In: Create airTransportUnit and verify stored fields', async () => {
    console.log('\n[A-01] Creating fresh ATU …');
    const result = await createAirTrackingObject({
      mot:                   'AIR',
      trackingStatus:        'In Progress',
      masterAirWaybillNumber: undefined,    // let factory generate
      loadingSiteIata:       'BLR',
      deliverySiteIata:      'BOM',
      loadingSiteCountry:    'IN',
      deliverySiteCountry:   'IN',
    });

    state.code      = result.code;
    state.mawb      = result.mawb;
    state.clientRef = result.clientReference;

    expect(state.code,      '[A-01] No object code returned').toBeTruthy();
    expect(state.mawb,      '[A-01] No MAWB generated').toBeTruthy();
    expect(state.clientRef, '[A-01] No clientReference').toBeTruthy();

    // Read back to confirm storage
    state.atu = await getATU();
    const atu = state.atu;

    console.log('');
    console.log('  ┌─ ATU Created ──────────────────────────────────────────┐');
    console.log(`  │  Object Code      : ${state.code}`);
    console.log(`  │  MAWB             : ${state.mawb}`);
    console.log(`  │  clientReference  : ${state.clientRef}`);
    console.log(`  │  loadingSiteIata  : ${atu?.loadingSiteIata ?? '—'}`);
    console.log(`  │  deliverySiteIata : ${atu?.deliverySiteIata ?? '—'}`);
    console.log(`  │  Hub pool (run)   : ${HUBS.map((h, i) => `stop${i+1}=${h.iata_code}`).join('  ')}`);
    console.log('  └────────────────────────────────────────────────────────┘');
    console.log('');

    expect(atu, '[A-01] ATU not readable after creation').toBeTruthy();
  });

  test('A-02 | Orders-In: Scheduler → active=1, valid=1', async () => {
    expect(state.code, '[A-02] A-01 must pass first').toBeTruthy();

    const rec = await pollUntilSchedulerActive(CONFIG.SCHEMA_TYPE, state.code);
    console.log(`  → active=${rec?.active}  valid=${rec?.valid}`);
    expect(rec,        '[A-02] No scheduler record').not.toBeNull();
    expect(rec.active, '[A-02] active should be 1').toBe(1);
    expect(rec.valid,  '[A-02] valid should be 1').toBe(1);
  });

  test('A-03 | Orders-In: Tracking document exists in MongoDB (xtrackings)', async () => {
    expect(state.mawb, '[A-03] A-01 must pass first').toBeTruthy();

    const docs = await pollUntilAirTrackingDocCreated({ mawb: state.mawb })
      .catch(() => null);

    console.log(`  → ${docs?.length ?? 0} tracking document(s) found`);
    if (!docs?.length) {
      console.warn('  [A-03] MongoDB check skipped or returned no docs — continuing');
      return;
    }
    expect(docs.length, '[A-03] No tracking documents found').toBeGreaterThan(0);
  });

  test('A-04 | Orders-In: Shipment searchable in Shippeo backoffice', async () => {
    if (!SHIPPEO_ENABLED) {
      test.skip(true, 'A-04 skipped — configure Shippeo credentials in .env to enable');
      return;
    }
    expect(state.mawb, '[A-04] A-01 must pass first').toBeTruthy();

    const ref      = buildAirReference({ mawb: state.mawb });
    console.log(`  → Shippeo search reference: "${ref}"`);
    const shipment = await pollUntilShippeoShipmentFound(ref);
    console.log(`  → ${shipment ? `Found: id=${shipment.id}` : 'NOT FOUND'}`);
    expect(shipment, `[A-04] Shipment not found for MAWB="${state.mawb}"`).not.toBeNull();
  });

  // ===========================================================================
  //  BLOCK D — IDENTIFIER FIELDS
  //
  //  Verifies that after the first real event the identifier fields on the ATU
  //  match what was in the webhook payload's order block.
  //  D-01 fires goods_delivery_compliant_compliant as the "seed" event.
  // ===========================================================================

  test.describe('BLOCK D | D-01 — Identifier fields + delivery compliant', () => {

    let atu = null;
    const MAIN_DATE   = runDate(900);   // +15 min from module load
    const MAIN_SC     = 'LIV';
    const MAIN_JC     = 'CFM';

    test.beforeAll(async () => {
      expect(state.code, '[D-01] A-01 must pass first').toBeTruthy();
      console.log('\n[D-01] Sending goods_delivery_compliant_compliant …');
      atu = await send(
        'goods_delivery_compliant_compliant',
        MAIN_DATE,
        toEventSite(SITE.BOM),
        {
          situation: {
            event:              'goods_delivery_compliant_compliant',
            situation_code:     MAIN_SC,
            justification_code: MAIN_JC,
            date:               MAIN_DATE,
          },
          situation_justification: {
            attributes: { consignmentReference: 'E2E-CONSIGNMENT-001' },
          },
        }
      );
    });

    test.beforeEach(() => { if (!atu) test.skip(); });

    test('D-01 | deliveryCompliantDate ← situation.date', () =>
      assertField(atu, 'deliveryCompliantDate', MAIN_DATE));

    test('D-01 | deliveryCompliantSituationCode ← situation.situation_code', () =>
      assertField(atu, 'deliveryCompliantSituationCode', MAIN_SC));

    test('D-01 | deliveryCompliantJustificationCode ← situation.justification_code', () =>
      assertField(atu, 'deliveryCompliantJustificationCode', MAIN_JC));

    test('D-01 | orderReference ← order.reference (MAWB)', () =>
      assertField(atu, 'orderReference', state.mawb));

    test('D-01 | orderUrl ← order.url', () =>
      assertField(atu, 'orderUrl', 'https://view.shippeo.com/orderPublic/test'));

  }); // end BLOCK D

  // ===========================================================================
  //  BLOCK T2 — TYPE 2 EXACT EVENTS
  //
  //  One webhook per event — asserts the mapped date field.
  //  Events at loading site → BLR, delivery site → BOM.
  // ===========================================================================

  test.describe('BLOCK T2 | Type 2 Exact Events', () => {

    // ── received_from_shipper ──────────────────────────────────────────────────
    test.describe('T2 | received_from_shipper', () => {
      let atu = null;
      test.beforeAll(async () => {
        atu = await send('received_from_shipper', T2_DATES.received_from_shipper, toEventSite(SITE.BLR));
      });
      test.beforeEach(() => { if (!atu) test.skip(); });
      test('receivedFromShipperDate ← situation.date', () =>
        assertField(atu, 'receivedFromShipperDate', T2_DATES.received_from_shipper));
    });

    // ── goods_arrived_at_loading_arrived ──────────────────────────────────────
    test.describe('T2 | goods_arrived_at_loading_arrived', () => {
      let atu = null;
      test.beforeAll(async () => {
        atu = await send('goods_arrived_at_loading_arrived', T2_DATES.goods_arrived_at_loading_arrived, toEventSite(SITE.BLR));
      });
      test.beforeEach(() => { if (!atu) test.skip(); });
      test('loadingArrivedDate ← situation.date', () =>
        assertField(atu, 'loadingArrivedDate', T2_DATES.goods_arrived_at_loading_arrived));
    });

    // ── goods_loading_compliant_compliant ─────────────────────────────────────
    test.describe('T2 | goods_loading_compliant_compliant', () => {
      let atu = null;
      test.beforeAll(async () => {
        atu = await send('goods_loading_compliant_compliant', T2_DATES.goods_loading_compliant_compliant, toEventSite(SITE.BLR));
      });
      test.beforeEach(() => { if (!atu) test.skip(); });
      test('loadingCompliantDate ← situation.date', () =>
        assertField(atu, 'loadingCompliantDate', T2_DATES.goods_loading_compliant_compliant));
    });

    // ── goods_left_loading_left ───────────────────────────────────────────────
    test.describe('T2 | goods_left_loading_left', () => {
      let atu = null;
      test.beforeAll(async () => {
        atu = await send('goods_left_loading_left', T2_DATES.goods_left_loading_left, toEventSite(SITE.BLR));
      });
      test.beforeEach(() => { if (!atu) test.skip(); });
      test('loadingLeftDate ← situation.date', () =>
        assertField(atu, 'loadingLeftDate', T2_DATES.goods_left_loading_left));
    });

    // ── goods_arrived_at_delivery_arrived ─────────────────────────────────────
    test.describe('T2 | goods_arrived_at_delivery_arrived', () => {
      let atu = null;
      test.beforeAll(async () => {
        atu = await send('goods_arrived_at_delivery_arrived', T2_DATES.goods_arrived_at_delivery_arrived, toEventSite(SITE.BOM));
      });
      test.beforeEach(() => { if (!atu) test.skip(); });
      test('deliveryArrivedDate ← situation.date', () =>
        assertField(atu, 'deliveryArrivedDate', T2_DATES.goods_arrived_at_delivery_arrived));
    });

    // ── goods_left_delivery_left ──────────────────────────────────────────────
    test.describe('T2 | goods_left_delivery_left', () => {
      let atu = null;
      test.beforeAll(async () => {
        atu = await send('goods_left_delivery_left', T2_DATES.goods_left_delivery_left, toEventSite(SITE.BOM));
      });
      test.beforeEach(() => { if (!atu) test.skip(); });
      test('deliveryLeftDate ← situation.date', () =>
        assertField(atu, 'deliveryLeftDate', T2_DATES.goods_left_delivery_left));
    });

    // ── documentation_delivered ───────────────────────────────────────────────
    test.describe('T2 | documentation_delivered', () => {
      let atu = null;
      test.beforeAll(async () => {
        atu = await send('documentation_delivered', T2_DATES.documentation_delivered, toEventSite(SITE.BOM));
      });
      test.beforeEach(() => { if (!atu) test.skip(); });
      test('documentationDeliveredDate ← situation.date', () =>
        assertField(atu, 'documentationDeliveredDate', T2_DATES.documentation_delivered));
    });

    // ── consignee_notified ────────────────────────────────────────────────────
    test.describe('T2 | consignee_notified', () => {
      let atu = null;
      test.beforeAll(async () => {
        atu = await send('consignee_notified', T2_DATES.consignee_notified, toEventSite(SITE.BOM));
      });
      test.beforeEach(() => { if (!atu) test.skip(); });
      test('consigneeNotifiedDate ← situation.date', () =>
        assertField(atu, 'consigneeNotifiedDate', T2_DATES.consignee_notified));
    });

  }); // end BLOCK T2

  // ===========================================================================
  //  BLOCK T3 — TYPE 3 STARTS-WITH EVENTS (non-compliant / refused)
  //
  //  Each event writes: <prefix><Category>Date  +  <prefix><Category>Justification
  //  Justification = the suffix after the last underscore in the event name.
  // ===========================================================================

  test.describe('BLOCK T3 | Type 3 Starts-With Events', () => {

    // ── goods_loading_non_compliant_* ─────────────────────────────────────────
    test.describe('T3 | goods_loading_non_compliant_damaged', () => {
      let atu = null;
      test.beforeAll(async () => {
        atu = await send('goods_loading_non_compliant_damaged', T3_DATES.goods_loading_non_compliant_damaged, toEventSite(SITE.BLR));
      });
      test.beforeEach(() => { if (!atu) test.skip(); });
      test('loadingNonCompliantDate ← situation.date', () =>
        assertField(atu, 'loadingNonCompliantDate', T3_DATES.goods_loading_non_compliant_damaged));
      test('loadingNonCompliantJustification = "damaged"', () =>
        assertField(atu, 'loadingNonCompliantJustification', 'damaged'));
    });

    // ── goods_loading_non_realised_* ──────────────────────────────────────────
    test.describe('T3 | goods_loading_non_realised_cancelled', () => {
      let atu = null;
      test.beforeAll(async () => {
        atu = await send('goods_loading_non_realised_cancelled', T3_DATES.goods_loading_non_realised_cancelled, toEventSite(SITE.BLR));
      });
      test.beforeEach(() => { if (!atu) test.skip(); });
      test('loadingNonRealisedDate ← situation.date', () =>
        assertField(atu, 'loadingNonRealisedDate', T3_DATES.goods_loading_non_realised_cancelled));
      test('loadingNonRealisedJustification = "cancelled"', () =>
        assertField(atu, 'loadingNonRealisedJustification', 'cancelled'));
    });

    // ── goods_loading_refused_* ───────────────────────────────────────────────
    test.describe('T3 | goods_loading_refused_oversize', () => {
      let atu = null;
      test.beforeAll(async () => {
        atu = await send('goods_loading_refused_oversize', T3_DATES.goods_loading_refused_oversize, toEventSite(SITE.BLR));
      });
      test.beforeEach(() => { if (!atu) test.skip(); });
      test('loadingRefusedDate ← situation.date', () =>
        assertField(atu, 'loadingRefusedDate', T3_DATES.goods_loading_refused_oversize));
      test('loadingRefusedJustification = "oversize"', () =>
        assertField(atu, 'loadingRefusedJustification', 'oversize'));
    });

    // ── goods_delivery_non_compliant_* ────────────────────────────────────────
    test.describe('T3 | goods_delivery_non_compliant_pilferage', () => {
      let atu = null;
      test.beforeAll(async () => {
        atu = await send('goods_delivery_non_compliant_pilferage', T3_DATES.goods_delivery_non_compliant_pilferage, toEventSite(SITE.BOM));
      });
      test.beforeEach(() => { if (!atu) test.skip(); });
      test('deliveryNonCompliantDate ← situation.date', () =>
        assertField(atu, 'deliveryNonCompliantDate', T3_DATES.goods_delivery_non_compliant_pilferage));
      test('deliveryNonCompliantJustification = "pilferage"', () =>
        assertField(atu, 'deliveryNonCompliantJustification', 'pilferage'));
    });

    // ── goods_delivery_non_realised_* ─────────────────────────────────────────
    test.describe('T3 | goods_delivery_non_realised_recipient_closed', () => {
      let atu = null;
      test.beforeAll(async () => {
        atu = await send('goods_delivery_non_realised_recipient_closed', T3_DATES.goods_delivery_non_realised_recipient_closed, toEventSite(SITE.BOM));
      });
      test.beforeEach(() => { if (!atu) test.skip(); });
      test('deliveryNonRealisedDate ← situation.date', () =>
        assertField(atu, 'deliveryNonRealisedDate', T3_DATES.goods_delivery_non_realised_recipient_closed));
      test('deliveryNonRealisedJustification = "recipient_closed"', () =>
        assertField(atu, 'deliveryNonRealisedJustification', 'recipient_closed'));
    });

    // ── goods_delivery_refused_* ──────────────────────────────────────────────
    test.describe('T3 | goods_delivery_refused_not_ordered', () => {
      let atu = null;
      test.beforeAll(async () => {
        atu = await send('goods_delivery_refused_not_ordered', T3_DATES.goods_delivery_refused_not_ordered, toEventSite(SITE.BOM));
      });
      test.beforeEach(() => { if (!atu) test.skip(); });
      test('deliveryRefusedDate ← situation.date', () =>
        assertField(atu, 'deliveryRefusedDate', T3_DATES.goods_delivery_refused_not_ordered));
      test('deliveryRefusedJustification = "not_ordered"', () =>
        assertField(atu, 'deliveryRefusedJustification', 'not_ordered'));
    });

  }); // end BLOCK T3

  // ===========================================================================
  //  BLOCK T4 — TYPE 4 HUB SLOT EVENTS
  //
  //  Hub slots 1–4: DXB → stop1, FRA → stop2, SIN → stop3, AMS → stop4
  //  Both goods_arrived_at_hub_arrived and goods_left_hub_left per hub.
  //  Also covers the OR-alias events (goods_arrived_at_delivery_hub_arrived / left).
  //
  //  Hub site fields written:
  //    hubSiteDescription_stopN ← event_site.description
  //    hubSiteIata_stopN        ← event_site.iata_code
  //    hubSiteAddressLine_stopN ← event_site.address_line
  //    hubSiteCity_stopN        ← event_site.city
  //    hubSiteZipcode_stopN     ← event_site.zipcode
  //    hubSiteCountry_stopN     ← event_site.country
  // ===========================================================================

  test.describe('BLOCK T4 | Type 4 Hub Slot Events', () => {

    function hubDescribe(label, event, dateKey, site) {
      test.describe(`T4 | ${label}`, () => {
        let atu = null;
        let slot = null;
        test.beforeAll(async () => {
          atu  = await send(event, T4_DATES[dateKey], toEventSite(site));
          slot = atu ? resolveHubSlot(atu, site.iata_code, site.country) : null;
          console.log(`  ${label} → stop${slot}`);
        });
        test.beforeEach(() => { if (!atu) test.skip(); });

        test(`${event === 'goods_arrived_at_hub_arrived' || event === 'goods_arrived_at_delivery_hub_arrived' ? 'hubArrivedDate' : 'hubLeftDate'} (${site.iata_code}) ← situation.date`, () => {
          expect(slot, `${site.iata_code} slot must be assigned`).not.toBeNull();
          const field = (event.includes('arrived')) ? `hubArrivedDate_stop${slot}` : `hubLeftDate_stop${slot}`;
          assertField(atu, field, T4_DATES[dateKey]);
        });

        test(`hubSite fields (${site.iata_code}) ← event_site`, () => {
          expect(slot, `${site.iata_code} slot must be assigned`).not.toBeNull();
          assertField(atu, `hubSiteDescription_stop${slot}`, site.description);
          assertField(atu, `hubSiteIata_stop${slot}`,        site.iata_code);
          assertField(atu, `hubSiteAddressLine_stop${slot}`, site.address_line);
          assertField(atu, `hubSiteCity_stop${slot}`,        site.city);
          assertField(atu, `hubSiteZipcode_stop${slot}`,     site.zipcode);
          assertField(atu, `hubSiteCountry_stop${slot}`,     site.country);
        });
      });
    }

    hubDescribe(`goods_arrived_at_hub_arrived — ${HUBS[0].iata_code} (stop1)`, 'goods_arrived_at_hub_arrived', 'dxbArrived', HUBS[0]);
    hubDescribe(`goods_left_hub_left — ${HUBS[0].iata_code} (stop1)`,          'goods_left_hub_left',           'dxbLeft',    HUBS[0]);
    hubDescribe(`goods_arrived_at_hub_arrived — ${HUBS[1].iata_code} (stop2)`, 'goods_arrived_at_hub_arrived', 'fraArrived', HUBS[1]);
    hubDescribe(`goods_left_hub_left — ${HUBS[1].iata_code} (stop2)`,          'goods_left_hub_left',           'fraLeft',    HUBS[1]);
    hubDescribe(`goods_arrived_at_hub_arrived — ${HUBS[2].iata_code} (stop3)`, 'goods_arrived_at_hub_arrived', 'sinArrived', HUBS[2]);
    hubDescribe(`goods_left_hub_left — ${HUBS[2].iata_code} (stop3)`,          'goods_left_hub_left',           'sinLeft',    HUBS[2]);
    hubDescribe(`goods_arrived_at_hub_arrived — ${HUBS[3].iata_code} (stop4)`, 'goods_arrived_at_hub_arrived', 'amsArrived', HUBS[3]);
    hubDescribe(`goods_left_hub_left — ${HUBS[3].iata_code} (stop4)`,          'goods_left_hub_left',           'amsLeft',    HUBS[3]);

    // OR-alias events (delivery_hub → same slot as hub, reuses stop1 site)
    hubDescribe(`[OR alias] goods_arrived_at_delivery_hub_arrived — ${HUBS[0].iata_code}`, 'goods_arrived_at_delivery_hub_arrived', 'deliveryHubDXB',  HUBS[0]);
    hubDescribe(`[OR alias] goods_left_delivery_hub_left — ${HUBS[0].iata_code}`,          'goods_left_delivery_hub_left',          'deliveryHubLeft', HUBS[0]);

  }); // end BLOCK T4

  // ===========================================================================
  //  BLOCK T5 — TYPE 5 ROUTING EVENTS
  //
  //  Prefix resolution (IATA + Country, both must match):
  //    event_site == ATU.loadingSiteIata/Country   → "loading" prefix
  //    event_site == ATU.deliverySiteIata/Country  → "delivery" prefix
  //    anything else                               → "hub" prefix + slot
  //
  //  Events covered: manifested | eta_event | received_from_flight
  //  Contexts:       loading | delivery | hub (DXB, FRA, SIN, AMS)
  // ===========================================================================

  test.describe('BLOCK T5 | Type 5 Routing Events', () => {

    // ── Helper: loading or delivery context ────────────────────────────────────
    function t5Simple(label, event, dateKey, dateContext, site, expectedField) {
      test.describe(`T5 | ${label}`, () => {
        let atu = null;
        test.beforeAll(async () => {
          atu = await send(event, T5_DATES[event === 'eta_event' ? 'eta_event' : event][dateContext], toEventSite(site));
        });
        test.beforeEach(() => { if (!atu) test.skip(); });
        test(`${expectedField} ← situation.date`, () =>
          assertField(atu, expectedField, T5_DATES[event === 'eta_event' ? 'eta_event' : event][dateContext]));
      });
    }

    // ── Helper: hub context ────────────────────────────────────────────────────
    function t5Hub(label, event, dateContext, site, hubFieldPrefix) {
      test.describe(`T5 | ${label}`, () => {
        let atu = null;
        let slot = null;
        const evKey = event === 'eta_event' ? 'eta_event' : event;
        test.beforeAll(async () => {
          atu  = await send(event, T5_DATES[evKey][dateContext], toEventSite(site));
          slot = atu ? resolveHubSlot(atu, site.iata_code, site.country) : null;
          console.log(`  ${label} → stop${slot}`);
        });
        test.beforeEach(() => { if (!atu) test.skip(); });
        test(`${hubFieldPrefix}Date_stopN ← situation.date`, () => {
          if (!slot) return test.skip();
          assertField(atu, `${hubFieldPrefix}Date_stop${slot}`, T5_DATES[evKey][dateContext]);
        });
        test(`hubSite fields (${site.iata_code}) ← event_site`, () => {
          if (!slot) return test.skip();
          assertField(atu, `hubSiteDescription_stop${slot}`, site.description);
          assertField(atu, `hubSiteIata_stop${slot}`,        site.iata_code);
          assertField(atu, `hubSiteAddressLine_stop${slot}`, site.address_line);
          assertField(atu, `hubSiteCity_stop${slot}`,        site.city);
          assertField(atu, `hubSiteZipcode_stop${slot}`,     site.zipcode);
          assertField(atu, `hubSiteCountry_stop${slot}`,     site.country);
        });
      });
    }

    // ── manifested ─────────────────────────────────────────────────────────────
    t5Simple('manifested — loading (BLR/IN)',  'manifested', null, 'loading',  SITE.BLR, 'loadingManifestedDate');
    t5Simple('manifested — delivery (BOM/IN)', 'manifested', null, 'delivery', SITE.BOM, 'deliveryManifestedDate');
    t5Hub(`manifested — hub (${HUBS[0].iata_code})`, 'manifested', 'hub',    HUBS[0], 'hubManifested');
    t5Hub(`manifested — hub (${HUBS[1].iata_code})`, 'manifested', 'hubFRA', HUBS[1], 'hubManifested');
    t5Hub(`manifested — hub (${HUBS[2].iata_code})`, 'manifested', 'hubSIN', HUBS[2], 'hubManifested');
    t5Hub(`manifested — hub (${HUBS[3].iata_code})`, 'manifested', 'hubAMS', HUBS[3], 'hubManifested');

    // ── eta_event ──────────────────────────────────────────────────────────────
    t5Simple('eta_event — loading (BLR/IN)',  'eta_event', null, 'loading',  SITE.BLR, 'loadingETADate');
    t5Simple('eta_event — delivery (BOM/IN)', 'eta_event', null, 'delivery', SITE.BOM, 'deliveryETADate');
    t5Hub(`eta_event — hub (${HUBS[0].iata_code})`, 'eta_event', 'hub',    HUBS[0], 'hubETA');
    t5Hub(`eta_event — hub (${HUBS[1].iata_code})`, 'eta_event', 'hubFRA', HUBS[1], 'hubETA');
    t5Hub(`eta_event — hub (${HUBS[2].iata_code})`, 'eta_event', 'hubSIN', HUBS[2], 'hubETA');
    t5Hub(`eta_event — hub (${HUBS[3].iata_code})`, 'eta_event', 'hubAMS', HUBS[3], 'hubETA');

    // ── received_from_flight ───────────────────────────────────────────────────
    t5Simple('received_from_flight — loading (BLR/IN)',  'received_from_flight', null, 'loading',  SITE.BLR, 'loadingReceivedFromFlightDate');
    t5Simple('received_from_flight — delivery (BOM/IN)', 'received_from_flight', null, 'delivery', SITE.BOM, 'deliveryReceivedFromFlightDate');
    t5Hub(`received_from_flight — hub (${HUBS[0].iata_code})`, 'received_from_flight', 'hub',    HUBS[0], 'hubReceivedFromFlight');
    t5Hub(`received_from_flight — hub (${HUBS[1].iata_code})`, 'received_from_flight', 'hubFRA', HUBS[1], 'hubReceivedFromFlight');
    t5Hub(`received_from_flight — hub (${HUBS[2].iata_code})`, 'received_from_flight', 'hubSIN', HUBS[2], 'hubReceivedFromFlight');
    t5Hub(`received_from_flight — hub (${HUBS[3].iata_code})`, 'received_from_flight', 'hubAMS', HUBS[3], 'hubReceivedFromFlight');

  }); // end BLOCK T5

  // ===========================================================================
  //  BLOCK N — NEGATIVE / AUTH
  //
  //  N-01: Wrong clientReference → event not routed → ATU unchanged
  //  N-02: Unknown event type → not mapped → ATU unchanged
  //  N-03: Missing Authorization → HTTP 401
  //  N-04: Invalid Bearer token → HTTP 401
  //  N-05: Missing ClientId header → HTTP 4xx
  // ===========================================================================

  test.describe('BLOCK N | Negative and Auth', () => {

    let webhookCtx;
    test.beforeAll(async () => {
      webhookCtx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });
    });
    test.afterAll(async () => { await webhookCtx?.dispose(); });

    test('N-01 | Wrong clientReference → ATU not updated', async () => {
      expect(state.code, '[N-01] A-01 must pass first').toBeTruthy();
      const before = await getATU().catch(() => null);

      const payload = makePayload('received_from_shipper', runDate(200000), toEventSite(SITE.BLR));
      payload.order.client_reference = 'WRONG_CLIENT_REF_XYZ';
      payload.order.edi_reference    = 'WRONG_MAWB_XYZ';
      payload.order.reference        = 'WRONG_MAWB_XYZ';

      const res = await webhookCtx.post(CONFIG.WEBHOOK_PATH, { headers: webhookHeaders(), data: payload });
      console.log(`  [N-01] HTTP ${res.status()}`);
      // Webhook may return 200 (silent drop) or 4xx — either is fine
      expect(res.status()).toBeGreaterThanOrEqual(200);

      await new Promise(r => setTimeout(r, 6000));
      const after = await getATU().catch(() => null);
      assertNotChanged(before, after, 'lastChangedAt');
    });

    test('N-02 | Unknown event type → ATU not updated', async () => {
      expect(state.code, '[N-02] A-01 must pass first').toBeTruthy();
      const before = await getATU().catch(() => null);

      const payload = makeE2EPayload('completely_unknown_event_xyz', runDate(210000), toEventSite(SITE.BLR));
      const res = await webhookCtx.post(CONFIG.WEBHOOK_PATH, { headers: webhookHeaders(), data: payload });
      console.log(`  [N-02] HTTP ${res.status()}`);
      expect(res.status()).toBeGreaterThanOrEqual(200);

      await new Promise(r => setTimeout(r, 6000));
      const after = await getATU().catch(() => null);
      assertNotChanged(before, after, 'lastChangedAt');
    });

    test('N-03 | Missing Authorization header → HTTP 401', async () => {
      const res = await webhookCtx.post(CONFIG.WEBHOOK_PATH, {
        headers: { 'Content-Type': 'application/json', 'ClientId': CONFIG.WEBHOOK_CLIENT_ID },
        data:    makeE2EPayload('received_from_shipper', runDate(220000), toEventSite(SITE.BLR)),
      });
      expect(res.status()).toBe(401);
    });

    test('N-04 | Invalid Bearer token → HTTP 401', async () => {
      const res = await webhookCtx.post(CONFIG.WEBHOOK_PATH, {
        headers: {
          'Content-Type':  'application/json',
          'ClientId':      CONFIG.WEBHOOK_CLIENT_ID,
          'Authorization': 'Bearer INVALID_TOKEN_E2E',
        },
        data: makeE2EPayload('received_from_shipper', runDate(230000), toEventSite(SITE.BLR)),
      });
      expect(res.status()).toBe(401);
    });

    test('N-05 | Missing ClientId header → HTTP 4xx', async () => {
      const res = await webhookCtx.post(CONFIG.WEBHOOK_PATH, {
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${CONFIG.WEBHOOK_TOKEN}`,
        },
        data: makeE2EPayload('received_from_shipper', runDate(240000), toEventSite(SITE.BLR)),
      });
      expect(res.status()).toBeGreaterThanOrEqual(400);
      expect(res.status()).toBeLessThan(500);
    });

  }); // end BLOCK N

  // ===========================================================================
  //  BLOCK NULL — NULL FIELD HANDLING
  //
  //  Verifies correct BE behaviour when situation.date or hub site fields are null.
  //  Each test creates a fresh ATU to avoid contamination from prior events.
  // ===========================================================================

  test.describe('BLOCK NULL | Null Field Handling', () => {

    // ── NULL-01: null situation.date → event-specific date not stored, always-on still written
    test.describe('NULL-01 | null situation.date → event date not written · always-on still fires', () => {
      let xState = { code: null, mawb: null, clientRef: null };
      let atu    = null;

      test.beforeAll(async () => {
        xState = await createFreshATU();
        expect(xState.code, '[NULL-01] ATU creation failed').toBeTruthy();
        const r = await sendFreshAndWait(xState, 'goods_arrived_at_loading_arrived', null, toEventSite(SITE.BLR));
        atu = r.atu;
      });
      test.beforeEach(() => { if (!atu) test.skip(); });

      test('NULL-01 | loadingArrivedDate = null (null date not stored)', () =>
        assertField(atu, 'loadingArrivedDate', null));
      test('NULL-01 | situationEvent = "goods_arrived_at_loading_arrived" (always-on written)', () =>
        assertField(atu, 'situationEvent', 'goods_arrived_at_loading_arrived'));
      test('NULL-01 | situationDate = null (always-on written even if null)', () =>
        assertField(atu, 'situationDate', null));
    });

    // ── NULL-02: null date on hub arrived → hub site fields still written, date null
    test.describe('NULL-02 | null situation.date on hub arrived · site fields still written', () => {
      let xState = { code: null, mawb: null, clientRef: null };
      let atu    = null;
      const HUB1 = HUBS[0];

      test.beforeAll(async () => {
        xState = await createFreshATU();
        expect(xState.code, '[NULL-02] ATU creation failed').toBeTruthy();
        const r = await sendFreshAndWait(xState, 'goods_arrived_at_hub_arrived', null, toEventSite(HUB1));
        atu = r.atu;
      });
      test.beforeEach(() => { if (!atu) test.skip(); });

      test('NULL-02 | hubArrivedDate_stop1 = null (null date not stored)', () => {
        const slot = atu ? resolveHubSlot(atu, HUB1.iata_code, HUB1.country) : 1;
        assertField(atu, `hubArrivedDate_stop${slot}`, null);
      });
      test('NULL-02 | hubSiteIata written despite null date', () => {
        const slot = atu ? resolveHubSlot(atu, HUB1.iata_code, HUB1.country) : 1;
        assertField(atu, `hubSiteIata_stop${slot}`, HUB1.iata_code);
      });
      test('NULL-02 | hubSiteCountry written despite null date', () => {
        const slot = atu ? resolveHubSlot(atu, HUB1.iata_code, HUB1.country) : 1;
        assertField(atu, `hubSiteCountry_stop${slot}`, HUB1.country);
      });
      test('NULL-02 | hubSiteCity written despite null date', () => {
        const slot = atu ? resolveHubSlot(atu, HUB1.iata_code, HUB1.country) : 1;
        assertField(atu, `hubSiteCity_stop${slot}`, HUB1.city);
      });
    });

    // ── NULL-03: null hub site city/desc/address/zip → those fields not stored, date + iata + country written
    test.describe('NULL-03 | null hub site city/desc/addr/zip → not stored · date + iata + country written', () => {
      let xState    = { code: null, mawb: null, clientRef: null };
      let atu       = null;
      const HUB1     = HUBS[0];
      const N03_DATE = runDate(113000);

      test.beforeAll(async () => {
        xState = await createFreshATU();
        expect(xState.code, '[NULL-03] ATU creation failed').toBeTruthy();
        // toPartialEventSite: iata_code + country only; city/desc/addr/zip = null
        const r = await sendFreshAndWait(xState, 'goods_arrived_at_hub_arrived', N03_DATE, toPartialEventSite(HUB1, {}));
        atu = r.atu;
      });
      test.beforeEach(() => { if (!atu) test.skip(); });

      test('NULL-03 | hubArrivedDate written (date still stored)', () => {
        const slot = atu ? resolveHubSlot(atu, HUB1.iata_code, HUB1.country) : 1;
        assertField(atu, `hubArrivedDate_stop${slot}`, N03_DATE);
      });
      test('NULL-03 | hubSiteIata written', () => {
        const slot = atu ? resolveHubSlot(atu, HUB1.iata_code, HUB1.country) : 1;
        assertField(atu, `hubSiteIata_stop${slot}`, HUB1.iata_code);
      });
      test('NULL-03 | hubSiteCountry written', () => {
        const slot = atu ? resolveHubSlot(atu, HUB1.iata_code, HUB1.country) : 1;
        assertField(atu, `hubSiteCountry_stop${slot}`, HUB1.country);
      });
      test('NULL-03 | hubSiteCity = null (null not stored)', () => {
        const slot = atu ? resolveHubSlot(atu, HUB1.iata_code, HUB1.country) : 1;
        assertField(atu, `hubSiteCity_stop${slot}`, null);
      });
      test('NULL-03 | hubSiteDescription = null (null not stored)', () => {
        const slot = atu ? resolveHubSlot(atu, HUB1.iata_code, HUB1.country) : 1;
        assertField(atu, `hubSiteDescription_stop${slot}`, null);
      });
      test('NULL-03 | hubSiteAddressLine = null (null not stored)', () => {
        const slot = atu ? resolveHubSlot(atu, HUB1.iata_code, HUB1.country) : 1;
        assertField(atu, `hubSiteAddressLine_stop${slot}`, null);
      });
      test('NULL-03 | hubSiteZipcode = null (null not stored)', () => {
        const slot = atu ? resolveHubSlot(atu, HUB1.iata_code, HUB1.country) : 1;
        assertField(atu, `hubSiteZipcode_stop${slot}`, null);
      });
    });

    // ── NULL-04: Empty request body → HTTP 400
    test('NULL-04 | Empty request body → HTTP 400', async () => {
      const webhookCtx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });
      const res = await webhookCtx.post(CONFIG.WEBHOOK_PATH, { headers: webhookHeaders(), data: {} });
      console.log(`  [NULL-04] HTTP ${res.status()}`);
      expect(res.status()).toBe(400);
      await webhookCtx.dispose();
    });

  }); // end BLOCK NULL

  // ===========================================================================
  //  BLOCK EDGE — EDGE CASES
  //
  //  EDGE-01/02/03 — earlier date does not overwrite (loading, delivery, hub)
  //  EDGE-04/05    — eta_event_external routes correctly (loading, hub)
  //  EDGE-06       — full 19-event journey, no cross-contamination
  // ===========================================================================

  test.describe('BLOCK EDGE | Edge Cases', () => {

    // ── EDGE-01: loading arrived sent twice · earlier date does NOT overwrite
    test.describe('EDGE-01 | Earlier loading arrived date does not overwrite existing', () => {
      let atuAfter = null;
      // Earlier than T2_DATES.goods_arrived_at_loading_arrived (runDate(7200))
      const EARLIER = runDate(100);

      test.beforeAll(async () => {
        expect(state.code, '[EDGE-01] A-01 must pass first').toBeTruthy();
        atuAfter = await send('goods_arrived_at_loading_arrived', EARLIER, toEventSite(SITE.BLR));
      });
      test.beforeEach(() => { if (!atuAfter) test.skip(); });

      test('EDGE-01 | loadingArrivedDate = T2 date (earlier date does not overwrite)', () =>
        assertField(atuAfter, 'loadingArrivedDate', T2_DATES.goods_arrived_at_loading_arrived));
    });

    // ── EDGE-02: delivery arrived sent twice · earlier date does NOT overwrite
    test.describe('EDGE-02 | Earlier delivery arrived date does not overwrite existing', () => {
      let atuAfter = null;
      // Earlier than T2_DATES.goods_arrived_at_delivery_arrived (runDate(18000))
      const EARLIER = runDate(200);

      test.beforeAll(async () => {
        expect(state.code, '[EDGE-02] A-01 must pass first').toBeTruthy();
        atuAfter = await send('goods_arrived_at_delivery_arrived', EARLIER, toEventSite(SITE.BOM));
      });
      test.beforeEach(() => { if (!atuAfter) test.skip(); });

      test('EDGE-02 | deliveryArrivedDate = T2 date (earlier date does not overwrite)', () =>
        assertField(atuAfter, 'deliveryArrivedDate', T2_DATES.goods_arrived_at_delivery_arrived));
    });

    // ── EDGE-03: hub arrived twice same hub on fresh ATU · earlier date no overwrite · no new slot
    test.describe('EDGE-03 | Hub arrived twice same hub · earlier date no overwrite · no new slot', () => {
      let xState         = { code: null, mawb: null, clientRef: null };
      let atuAfterSecond = null;
      const HUB1   = HUBS[0];
      const T2_HUB = runDate(114000);  // later — sent first
      const T1_HUB = runDate(113500);  // earlier — sent second (T1 < T2)

      test.beforeAll(async () => {
        xState = await createFreshATU();
        expect(xState.code, '[EDGE-03] ATU creation failed').toBeTruthy();
        await sendFreshAndWait(xState, 'goods_arrived_at_hub_arrived', T2_HUB, toEventSite(HUB1));
        const r2 = await sendFreshAndWait(xState, 'goods_arrived_at_hub_arrived', T1_HUB, toEventSite(HUB1));
        atuAfterSecond = r2.atu;
      });
      test.beforeEach(() => { if (!atuAfterSecond) test.skip(); });

      test('EDGE-03 | hubArrivedDate_stop1 = T2 (earlier date does not overwrite)', () => {
        const slot = resolveHubSlot(atuAfterSecond, HUB1.iata_code, HUB1.country);
        assertField(atuAfterSecond, `hubArrivedDate_stop${slot}`, T2_HUB);
      });
      test('EDGE-03 | hubSiteIata_stop2 = null (no new slot created)', () =>
        assertField(atuAfterSecond, 'hubSiteIata_stop2', null));
    });

    // ── EDGE-04: eta_event_external at loading → loadingETADate, deliveryETADate null
    test.describe('EDGE-04 | eta_event_external at loading → loadingETADate (not delivery)', () => {
      let xState = { code: null, mawb: null, clientRef: null };
      let atu    = null;
      const ETA_DATE = runDate(116000);

      test.beforeAll(async () => {
        xState = await createFreshATU('BLR', 'BOM', 'IN', 'IN');
        expect(xState.code, '[EDGE-04] ATU creation failed').toBeTruthy();
        const r = await sendFreshAndWait(xState, 'eta_event_external', ETA_DATE, toEventSite(SITE.BLR));
        atu = r.atu;
      });
      test.beforeEach(() => { if (!atu) test.skip(); });

      test('EDGE-04 | loadingETADate ← situation.date (eta_event_external OR alias)', () =>
        assertField(atu, 'loadingETADate', ETA_DATE));
      test('EDGE-04 | deliveryETADate = null (loading event does not touch delivery)', () =>
        assertField(atu, 'deliveryETADate', null));
    });

    // ── EDGE-05: eta_event_external at hub → hubETADate_stop1, loading + delivery null
    test.describe('EDGE-05 | eta_event_external at hub → hubETADate_stop1 (not loading or delivery)', () => {
      let xState = { code: null, mawb: null, clientRef: null };
      let atu    = null;
      const HUB1     = HUBS[0];
      const ETA_DATE = runDate(117000);

      test.beforeAll(async () => {
        xState = await createFreshATU('BLR', 'BOM', 'IN', 'IN');
        expect(xState.code, '[EDGE-05] ATU creation failed').toBeTruthy();
        const r = await sendFreshAndWait(xState, 'eta_event_external', ETA_DATE, toEventSite(HUB1));
        atu = r.atu;
      });
      test.beforeEach(() => { if (!atu) test.skip(); });

      test('EDGE-05 | hubETADate (correct stop) ← situation.date (eta_event_external OR alias)', () => {
        const slot = atu ? resolveHubSlot(atu, HUB1.iata_code, HUB1.country) : 1;
        assertField(atu, `hubETADate_stop${slot}`, ETA_DATE);
      });
      test('EDGE-05 | loadingETADate = null (hub event does not touch loading)', () =>
        assertField(atu, 'loadingETADate', null));
      test('EDGE-05 | deliveryETADate = null (hub event does not touch delivery)', () =>
        assertField(atu, 'deliveryETADate', null));
    });

    // ── EDGE-06: Full 19-event journey on one fresh ATU · no cross-contamination
    test.describe('EDGE-06 | Full journey: 19 events in sequence · no cross-contamination', () => {
      let xState   = { code: null, mawb: null, clientRef: null };
      let finalATU = null;

      const LOAD = SITE.BLR;
      const DEL  = SITE.BOM;
      const HUB1 = HUBS[0];
      const HUB2 = HUBS[1];

      const D = {
        s01: runDate(120000),  s02: runDate(121000),  s03: runDate(122000),
        s04: runDate(123000),  s05: runDate(124000),  s06: runDate(125000),
        s07: runDate(126000),  s08: runDate(127000),  s09: runDate(128000),
        s10: runDate(129000),  s11: runDate(130000),  s12: runDate(131000),
        s13: runDate(132000),  s14: runDate(133000),  s15: runDate(134000),
        s16: runDate(135000),  s17: runDate(136000),  s18: runDate(137000),
        s19: runDate(138000),
      };

      test.beforeAll(async () => {
        xState = await createFreshATU('BLR', 'BOM', 'IN', 'IN');
        expect(xState.code, '[EDGE-06] ATU creation failed').toBeTruthy();
        console.log(`\n[EDGE-06] code=${xState.code}  hub1=${HUB1.iata_code}  hub2=${HUB2.iata_code}`);

        const steps = [
          ['received_from_shipper',              D.s01, toEventSite(LOAD)],
          ['goods_arrived_at_loading_arrived',   D.s02, toEventSite(LOAD)],
          ['goods_loading_compliant_compliant',  D.s03, toEventSite(LOAD)],
          ['goods_left_loading_left',            D.s04, toEventSite(LOAD)],
          ['manifested',                         D.s05, toEventSite(LOAD)],
          ['eta_event',                          D.s06, toEventSite(LOAD)],
          ['received_from_flight',               D.s07, toEventSite(LOAD)],
          ['goods_arrived_at_hub_arrived',       D.s08, toEventSite(HUB1)],
          ['goods_left_hub_left',                D.s09, toEventSite(HUB1)],
          ['manifested',                         D.s10, toEventSite(HUB1)],
          ['goods_arrived_at_hub_arrived',       D.s11, toEventSite(HUB2)],
          ['goods_arrived_at_delivery_arrived',  D.s12, toEventSite(DEL)],
          ['goods_delivery_compliant_compliant', D.s13, toEventSite(DEL)],
          ['goods_left_delivery_left',           D.s14, toEventSite(DEL)],
          ['manifested',                         D.s15, toEventSite(DEL)],
          ['eta_event',                          D.s16, toEventSite(DEL)],
          ['received_from_flight',               D.s17, toEventSite(DEL)],
          ['documentation_delivered',            D.s18, toEventSite(DEL)],
          ['consignee_notified',                 D.s19, toEventSite(DEL)],
        ];

        for (let i = 0; i < steps.length; i++) {
          const [event, date, site] = steps[i];
          console.log(`  [EDGE-06] Step ${i + 1}/19: ${event}`);
          const r = await sendFreshAndWait(xState, event, date, site);
          if (i === steps.length - 1) finalATU = r.atu;
        }
      });
      test.beforeEach(() => { if (!finalATU) test.skip(); });

      // Loading
      test('EDGE-06 | s01 receivedFromShipperDate', () =>
        assertField(finalATU, 'receivedFromShipperDate', D.s01));
      test('EDGE-06 | s02 loadingArrivedDate', () =>
        assertField(finalATU, 'loadingArrivedDate', D.s02));
      test('EDGE-06 | s03 loadingCompliantDate', () =>
        assertField(finalATU, 'loadingCompliantDate', D.s03));
      test('EDGE-06 | s04 loadingLeftDate', () =>
        assertField(finalATU, 'loadingLeftDate', D.s04));
      test('EDGE-06 | s05 loadingManifestedDate', () =>
        assertField(finalATU, 'loadingManifestedDate', D.s05));
      test('EDGE-06 | s06 loadingETADate', () =>
        assertField(finalATU, 'loadingETADate', D.s06));
      test('EDGE-06 | s07 loadingReceivedFromFlightDate', () =>
        assertField(finalATU, 'loadingReceivedFromFlightDate', D.s07));

      // Hub 1
      test('EDGE-06 | s08 hubArrivedDate_stop1 (hub1)', () => {
        const s = resolveHubSlot(finalATU, HUB1.iata_code, HUB1.country);
        assertField(finalATU, `hubArrivedDate_stop${s}`, D.s08);
      });
      test('EDGE-06 | s08 hubSiteIata_stop1 = hub1.iata', () => {
        const s = resolveHubSlot(finalATU, HUB1.iata_code, HUB1.country);
        assertField(finalATU, `hubSiteIata_stop${s}`, HUB1.iata_code);
      });
      test('EDGE-06 | s09 hubLeftDate_stop1 (hub1)', () => {
        const s = resolveHubSlot(finalATU, HUB1.iata_code, HUB1.country);
        assertField(finalATU, `hubLeftDate_stop${s}`, D.s09);
      });
      test('EDGE-06 | s10 hubManifestedDate_stop1 (hub1)', () => {
        const s = resolveHubSlot(finalATU, HUB1.iata_code, HUB1.country);
        assertField(finalATU, `hubManifestedDate_stop${s}`, D.s10);
      });

      // Hub 2
      test('EDGE-06 | s11 hubArrivedDate_stop2 (hub2)', () => {
        const s = resolveHubSlot(finalATU, HUB2.iata_code, HUB2.country);
        assertField(finalATU, `hubArrivedDate_stop${s}`, D.s11);
      });
      test('EDGE-06 | s11 hubSiteIata_stop2 = hub2.iata', () => {
        const s = resolveHubSlot(finalATU, HUB2.iata_code, HUB2.country);
        assertField(finalATU, `hubSiteIata_stop${s}`, HUB2.iata_code);
      });

      // Delivery
      test('EDGE-06 | s12 deliveryArrivedDate', () =>
        assertField(finalATU, 'deliveryArrivedDate', D.s12));
      test('EDGE-06 | s13 deliveryCompliantDate', () =>
        assertField(finalATU, 'deliveryCompliantDate', D.s13));
      test('EDGE-06 | s14 deliveryLeftDate', () =>
        assertField(finalATU, 'deliveryLeftDate', D.s14));
      test('EDGE-06 | s15 deliveryManifestedDate', () =>
        assertField(finalATU, 'deliveryManifestedDate', D.s15));
      test('EDGE-06 | s16 deliveryETADate', () =>
        assertField(finalATU, 'deliveryETADate', D.s16));
      test('EDGE-06 | s17 deliveryReceivedFromFlightDate', () =>
        assertField(finalATU, 'deliveryReceivedFromFlightDate', D.s17));
      test('EDGE-06 | s18 documentationDeliveredDate', () =>
        assertField(finalATU, 'documentationDeliveredDate', D.s18));
      test('EDGE-06 | s19 consigneeNotifiedDate', () =>
        assertField(finalATU, 'consigneeNotifiedDate', D.s19));

      // No cross-contamination
      test('EDGE-06 | loadingArrivedDate != deliveryArrivedDate', () => {
        console.log(`  loading="${finalATU?.loadingArrivedDate}"  delivery="${finalATU?.deliveryArrivedDate}"`);
        expect(finalATU?.loadingArrivedDate).not.toBe(finalATU?.deliveryArrivedDate);
      });
      test('EDGE-06 | hubArrivedDate_stop1 != hubArrivedDate_stop2', () => {
        const s1 = resolveHubSlot(finalATU, HUB1.iata_code, HUB1.country);
        const s2 = resolveHubSlot(finalATU, HUB2.iata_code, HUB2.country);
        const h1 = finalATU?.[`hubArrivedDate_stop${s1}`];
        const h2 = finalATU?.[`hubArrivedDate_stop${s2}`];
        console.log(`  hub1(stop${s1})="${h1}"  hub2(stop${s2})="${h2}"`);
        expect(h1).not.toBe(h2);
      });
    }); // end EDGE-06

  }); // end BLOCK EDGE

  // ===========================================================================
  //  BLOCK AON — ALWAYS-ON FIELD VERIFICATION
  //
  //  Verifies that situationEvent, situationDate, orderReference, orderUrl, and
  //  consignmentReference fire alongside event-specific fields for each type.
  // ===========================================================================

  test.describe('BLOCK AON | Always-On Field Verification', () => {

    // ── AON-01: T2 delivery event — all six always-on fields asserted
    test.describe('AON-01 | Always-on fields with T2 delivery event', () => {
      let atu = null;
      const P01_DATE = runDate(140000);

      test.beforeAll(async () => {
        expect(state.code, '[AON-01] A-01 must pass first').toBeTruthy();
        atu = await send(
          'goods_arrived_at_delivery_arrived',
          P01_DATE,
          toEventSite(SITE.BOM),
          {
            situation: {
              event:              'goods_arrived_at_delivery_arrived',
              situation_code:     null,
              justification_code: null,
              date:               P01_DATE,
              input_date:         P01_DATE,
            },
            situation_justification: {
              attributes: { consignmentReference: 'CSN-001' },
            },
          }
        );
      });
      test.beforeEach(() => { if (!atu) test.skip(); });

      test('AON-01 | deliveryArrivedDate ← situation.date', () =>
        assertField(atu, 'deliveryArrivedDate', P01_DATE));
      test('AON-01 | situationEvent = event name (always-on)', () =>
        assertField(atu, 'situationEvent', 'goods_arrived_at_delivery_arrived'));
      test('AON-01 | situationDate ← situation.date (always-on)', () =>
        assertField(atu, 'situationDate', P01_DATE));
      test('AON-01 | situationInputDate ← situation.input_date (always-on)', () =>
        assertField(atu, 'situationInputDate', P01_DATE));
      test('AON-01 | orderReference = MAWB (always-on)', () =>
        assertField(atu, 'orderReference', state.mawb));
      test('AON-01 | consignmentReference = "CSN-001" (always-on)', () =>
        assertField(atu, 'consignmentReference', 'CSN-001'));
      test('AON-01 | orderUrl = order.url (always-on)', () =>
        assertField(atu, 'orderUrl', 'https://view.shippeo.com/orderPublic/test'));
    });

    // ── AON-02: T3 event — key always-on fields present
    test.describe('AON-02 | Always-on fields with T3 (loading non-compliant)', () => {
      let atu = null;
      const P02_DATE = runDate(141000);

      test.beforeAll(async () => {
        expect(state.code, '[AON-02] A-01 must pass first').toBeTruthy();
        atu = await send('goods_loading_non_compliant_damaged', P02_DATE, toEventSite(SITE.BLR));
      });
      test.beforeEach(() => { if (!atu) test.skip(); });

      test('AON-02 | loadingNonCompliantDate ← situation.date', () =>
        assertField(atu, 'loadingNonCompliantDate', P02_DATE));
      test('AON-02 | situationEvent = event name (always-on)', () =>
        assertField(atu, 'situationEvent', 'goods_loading_non_compliant_damaged'));
      test('AON-02 | orderReference = MAWB (always-on)', () =>
        assertField(atu, 'orderReference', state.mawb));
    });

    // ── AON-03: T4 hub arrived — key always-on fields present
    test.describe('AON-03 | Always-on fields with T4 hub arrived', () => {
      let atu  = null;
      let slot = null;
      const HUB1     = HUBS[0];
      const P03_DATE = runDate(142000);

      test.beforeAll(async () => {
        expect(state.code, '[AON-03] A-01 must pass first').toBeTruthy();
        atu  = await send('goods_arrived_at_hub_arrived', P03_DATE, toEventSite(HUB1));
        slot = atu ? resolveHubSlot(atu, HUB1.iata_code, HUB1.country) : null;
      });
      test.beforeEach(() => { if (!atu) test.skip(); });

      test('AON-03 | hubArrivedDate (correct stop) ← situation.date', () => {
        expect(slot, 'hub slot must be assigned').not.toBeNull();
        assertField(atu, `hubArrivedDate_stop${slot}`, P03_DATE);
      });
      test('AON-03 | situationEvent = event name (always-on)', () =>
        assertField(atu, 'situationEvent', 'goods_arrived_at_hub_arrived'));
      test('AON-03 | orderReference = MAWB (always-on)', () =>
        assertField(atu, 'orderReference', state.mawb));
    });

    // ── AON-04: T5 manifested (loading) — key always-on fields present
    test.describe('AON-04 | Always-on fields with T5 routing (manifested at loading)', () => {
      let atu = null;
      const P04_DATE = runDate(143000);

      test.beforeAll(async () => {
        expect(state.code, '[AON-04] A-01 must pass first').toBeTruthy();
        atu = await send('manifested', P04_DATE, toEventSite(SITE.BLR));
      });
      test.beforeEach(() => { if (!atu) test.skip(); });

      test('AON-04 | loadingManifestedDate ← situation.date', () =>
        assertField(atu, 'loadingManifestedDate', P04_DATE));
      test('AON-04 | situationEvent = "manifested" (always-on)', () =>
        assertField(atu, 'situationEvent', 'manifested'));
      test('AON-04 | orderReference = MAWB (always-on)', () =>
        assertField(atu, 'orderReference', state.mawb));
      test('AON-04 | situationDate ← situation.date (always-on)', () =>
        assertField(atu, 'situationDate', P04_DATE));
    });

  }); // end BLOCK AON

  // ===========================================================================
  //  BLOCK S — FINAL ATU FIELD STATE SUMMARY
  //
  //  Reads the ATU one last time and prints a complete field-state report.
  //  Always passes — purely informational.
  // ===========================================================================

  test.describe('BLOCK S | Final ATU Field State Summary', () => {

    test('S-01 | Print complete ATU field state after all events', async () => {
      if (!state.code) { console.log('[S-01] ATU code not set — skipping summary'); return; }

      const atu = await getATU().catch(() => null);
      if (!atu) { console.log('[S-01] Could not read ATU'); return; }

      const chk = (key, exp) => {
        const actual = atu[key];
        if (actual === undefined) return `  ⬜ ${key}: NOT IN RESPONSE`;
        return valuesMatch(actual, exp)
          ? `  ✅ ${key}: "${actual}"`
          : `  ❌ ${key}: actual="${actual}" | expected="${exp}"`;
      };

      console.log('\n══════════════════════════════════════════════════════════');
      console.log('  AIR E2E — Final ATU Field State Report');
      console.log(`  code=${atu.code}  MAWB=${state.mawb}`);
      console.log(`  lastChangedAt=${atu.lastChangedAt}`);
      console.log('══════════════════════════════════════════════════════════');

      console.log('\n── Identifiers ──');
      ['orderReference', 'orderUrl', 'clientReference'].forEach(k => {
        console.log(`  ℹ️  ${k}: "${atu[k]}"`);
      });

      console.log('\n── Type 2 Exact (date fields) ──');
      [
        ['deliveryCompliantDate',      null],
        ['receivedFromShipperDate',    T2_DATES.received_from_shipper],
        ['loadingArrivedDate',         T2_DATES.goods_arrived_at_loading_arrived],
        ['loadingCompliantDate',       T2_DATES.goods_loading_compliant_compliant],
        ['loadingLeftDate',            T2_DATES.goods_left_loading_left],
        ['deliveryArrivedDate',        T2_DATES.goods_arrived_at_delivery_arrived],
        ['deliveryLeftDate',           T2_DATES.goods_left_delivery_left],
        ['documentationDeliveredDate', T2_DATES.documentation_delivered],
        ['consigneeNotifiedDate',      T2_DATES.consignee_notified],
      ].forEach(([k, v]) => console.log(chk(String(k), v)));

      console.log('\n── Type 3 Justifications ──');
      [
        ['loadingNonCompliantJustification',  'damaged'],
        ['loadingNonRealisedJustification',   'cancelled'],
        ['loadingRefusedJustification',       'oversize'],
        ['deliveryNonCompliantJustification', 'pilferage'],
        ['deliveryNonRealisedJustification',  'recipient_closed'],
        ['deliveryRefusedJustification',      'not_ordered'],
      ].forEach(([k, v]) => console.log(chk(String(k), v)));

      console.log('\n── Type 5 Routing (loading / delivery) ──');
      [
        ['loadingManifestedDate',          T5_DATES.manifested.loading],
        ['deliveryManifestedDate',         T5_DATES.manifested.delivery],
        ['loadingETADate',                 T5_DATES.eta_event.loading],
        ['deliveryETADate',                T5_DATES.eta_event.delivery],
        ['loadingReceivedFromFlightDate',  T5_DATES.received_from_flight.loading],
        ['deliveryReceivedFromFlightDate', T5_DATES.received_from_flight.delivery],
      ].forEach(([k, v]) => console.log(chk(String(k), v)));

      console.log('\n── Hub Slots (stop1–stop4) ──');
      console.log(`  ℹ️  This run: ${HUBS.map((h, i) => `stop${i+1}=${h.iata_code}`).join('  ')}`);
      for (let n = 1; n <= 4; n++) {
        const iata = atu[`hubSiteIata_stop${n}`];
        if (iata) {
          console.log(`  ℹ️  stop${n} (${iata}): arrived="${atu[`hubArrivedDate_stop${n}`]}"  left="${atu[`hubLeftDate_stop${n}`]}"  manifested="${atu[`hubManifestedDate_stop${n}`]}"  eta="${atu[`hubETADate_stop${n}`]}"`);
        } else {
          console.log(`  ⬜ stop${n}: empty`);
        }
      }
      console.log('══════════════════════════════════════════════════════════\n');
    });

  }); // end BLOCK S

}); // end AirEventsOut
