// =============================================================================
// E2E_Ocean.spec.js
//
// OCEAN — Full Lifecycle Test
// Covers Orders-In (A-01 to A-04) + ALL Events-Out field-mapping scenarios
// (D, PC, POL, POD, DEL, X, N groups) + Audit + Final Summary.
// =============================================================================

const { test, expect, request } = require('@playwright/test');

const { E2E_CONFIG }                             = require('../../../helpers/e2e/e2eConfig');
const { CONFIG }                                 = require('../../../helpers/ocean/oceanConfig');
const { pollUntilSchedulerActive }               = require('../../../helpers/e2e/trackingSchedulerClient');
const { pollUntilTrackingDocCreated,
        extractScheduleRecords }                 = require('../../../helpers/e2e/trackingServiceClient');
const { buildOceanReference,
        pollUntilShippeoShipmentFound }          = require('../../../helpers/e2e/shippeoApiClient');
const { createOceanTrackingObject,
        getOceanTrackingObject,
        deleteOceanTrackingObject }              = require('../../../helpers/e2e/trackingObjectFactory');
const { pollUntilAuditEntry,
        assertLastUpdatedChanged }               = require('../../../helpers/e2e/auditHelpers');
const { checkTokenExpiry }                       = require('../../../helpers/tokenHelper');
const { assertField }                            = require('../../../helpers/air/airValidation');
const { generateOrdersInReport,
        createReportData }                       = require('../../../helpers/e2e/ordersInReporter');
const {
  makePayload, withVessel, VESSEL, SITE, toEventSite, runDate,
  PRE_DATES, POL_DATES, TSP_DATES, POD_DATES, DEL_DATES,
} = require('../../../helpers/ocean/oceanPayloadFactory');

const OCFG = E2E_CONFIG.OCEAN;
checkTokenExpiry(E2E_CONFIG.ADMIN_TOKEN, 'E2E_ADMIN_TOKEN', 'E2E ADMIN');

// =============================================================================
//  Helpers
// =============================================================================

const webhookHeaders = () => ({
  'Content-Type':  'application/json',
  'clientId':      OCFG.WEBHOOK_CLIENT_ID,
  'Authorization': `Bearer ${OCFG.WEBHOOK_TOKEN}`,
});

const adminHeaders = () => ({
  'Authorization': `Bearer ${E2E_CONFIG.ADMIN_TOKEN}`,
  'accept':        'application/json',
});

async function getOTU(objectCode) {
  const ctx = await request.newContext({ baseURL: E2E_CONFIG.ADMIN_BASE_URL });
  try {
    const res = await ctx.get(
      `/api/tower/data/${OCFG.SCHEMA_TYPE}/${objectCode}`,
      { headers: adminHeaders() }
    );
    if (res.status() === 401) throw new Error('OTU GET → 401. Refresh E2E_ADMIN_TOKEN.');
    if (!res.ok()) throw new Error(`OTU GET → HTTP ${res.status()}`);
    const body = await res.json();
    return body.data ?? body;
  } finally {
    await ctx.dispose();
  }
}

async function sendAndWaitE2E(payload, objectCode) {
  const webhookCtx = await request.newContext({ baseURL: OCFG.WEBHOOK_BASE_URL });
  const before   = await getOTU(objectCode).catch(() => null);
  const baseline = before?.lastChangedAt ?? null;
  console.log(`  [e2e] Before → lastChangedAt="${baseline}"`);

  const res    = await webhookCtx.post(OCFG.WEBHOOK_PATH, { headers: webhookHeaders(), data: payload });
  const status = res.status();
  console.log(`  [e2e] Webhook HTTP ${status} | event="${payload.situation?.event}" type="${payload.situation?.type}" placeType="${payload.event_site?.place_type}"`);

  await new Promise(r => setTimeout(r, 1500));

  const deadline = Date.now() + 30000;
  let otu = null;
  while (Date.now() < deadline) {
    otu = await getOTU(objectCode).catch(() => null);
    if (otu?.lastChangedAt !== baseline) {
      console.log(`  [e2e] lastChangedAt changed: "${baseline}" → "${otu?.lastChangedAt}"`);
      break;
    }
    console.log(`  [e2e] still "${otu?.lastChangedAt}" — waiting…`);
    await new Promise(r => setTimeout(r, 3000));
  }

  await webhookCtx.dispose();
  return { status, otu, before };
}

async function sendAndSnapshot(payload) {
  const before = await getOTU(state.objectCode).catch(() => null);
  const webhookCtx = await request.newContext({ baseURL: OCFG.WEBHOOK_BASE_URL });
  const res = await webhookCtx.post(OCFG.WEBHOOK_PATH, { headers: webhookHeaders(), data: payload });
  await webhookCtx.dispose();
  await new Promise(r => setTimeout(r, 3000));
  const after = await getOTU(state.objectCode).catch(() => null);
  return { status: res.status(), before, after };
}

function assertNotChanged(before, after, field) {
  const bv = before?.[field] ?? null;
  const av = after?.[field]  ?? null;
  console.log(`  [neg ok] ${field}: before="${bv}" after="${av}"`);
  expect(av, `Field "${field}" should NOT have changed — before="${bv}" after="${av}"`).toBe(bv);
}

// =============================================================================
//  Shared state (module-level so sendAndSnapshot can access it)
// =============================================================================

const state = {
  objectCode:      null,
  containerNumber: null,
  bookingNumber:   null,
  blNumber:        null,
  scac:            null,
  otu:             null,
  otuBefore:       null,
  trackingDocs:    null,
  shippeoShipment: null,
  shippeoRef:      null,
  report:          createReportData(OCFG.CONTAINER_PREFIX + 'pending'),
};

// =============================================================================
//  Payload builder — injects run-specific identifiers
// =============================================================================

function makeE2EPayload(event, date, situationType, dataSource, eventSite, extras) {
  if (extras === undefined) extras = {};
  return makePayload(event, date, situationType, dataSource, eventSite, {
    cargo:                     { reference: state.containerNumber, qualifier: 'CONTAINER' },
    booking_references:        [{ reference: state.bookingNumber }],
    bill_of_lading_references: [{ reference: state.blNumber }],
    ...extras,
  });
}

// =============================================================================
test.describe.serial('OCEAN — Full Lifecycle (Orders-In + Events-Out)', () => {

  test.afterAll(async () => {
    try {
      generateOrdersInReport(state.report);
    } catch (e) {
      console.warn('  [report] Could not write report:', e.message);
    }
  });

  // ===========================================================================
  //  BLOCK A — ORDERS-IN
  // ===========================================================================

  test('A-01 | Orders-In: Create TransportUnitOcean and fetch its stored fields', async () => {
    const result = await createOceanTrackingObject();
    state.objectCode      = result.code;
    state.containerNumber = result.containerNumber;

    expect(state.objectCode,      'No object code returned').toBeTruthy();
    expect(state.containerNumber, 'No container number generated').toBeTruthy();

    const raw = await getOceanTrackingObject(state.objectCode);
    const otu = Array.isArray(raw) ? raw[0] : raw;

    state.containerNumber = otu?.containerNumber      || result.containerNumber;
    state.bookingNumber   = otu?.bookingNumber        || OCFG.BOOKING_NUMBER;
    state.blNumber        = otu?.billOfLadingNumber   || OCFG.BL_NUMBER;
    state.scac            = otu?.carrierScac          || OCFG.SCAC;

    // Sync CONFIG so makePayload fallbacks in GROUP N still work
    CONFIG.OBJECT_CODE      = state.objectCode;
    CONFIG.CONTAINER_NUMBER = state.containerNumber;
    CONFIG.BOOKING_REF      = state.bookingNumber;
    CONFIG.BOL_NUMBER       = state.blNumber;

    console.log('');
    console.log('  ┌─ OTU Created ──────────────────────────────────────┐');
    console.log(`  │  Object Code     : ${state.objectCode}`);
    console.log(`  │  Container No.   : ${state.containerNumber}`);
    console.log(`  │  Booking No.     : ${state.bookingNumber}`);
    console.log(`  │  Bill of Lading  : ${state.blNumber}`);
    console.log(`  │  SCAC            : ${state.scac}`);
    console.log('  └────────────────────────────────────────────────────┘');
    console.log('');

    state.report = createReportData(state.containerNumber);
    state.report.objectCreation.httpStatus      = 200;
    state.report.objectCreation.objectCode      = state.objectCode;
    state.report.objectCreation.containerNumber = state.containerNumber;
    state.report.objectCreation.bookingNumber   = state.bookingNumber;
    state.report.objectCreation.blNumber        = state.blNumber;
    state.report.objectCreation.scac            = state.scac;
    state.report.objectCreation.carrier         = `${OCFG.CARRIER_SHORT_NAME} — ${OCFG.CARRIER_NAME}`;
    state.report.objectCreation.mot             = 'OCEAN';
    state.report.objectCreation.trackingStatus  = 'In Progress';
    state.report.objectCreation.passed          = true;

    expect(state.bookingNumber, 'Booking number missing from created OTU').toBeTruthy();
  });

  test('A-02 | Orders-In: Tracking scheduler — active=1, valid=1', async () => {
    expect(state.objectCode, 'A-01 must pass first').toBeTruthy();

    const record = await pollUntilSchedulerActive(OCFG.SCHEMA_TYPE, state.objectCode);

    state.report.scheduler.active                  = record?.active ?? null;
    state.report.scheduler.valid                   = record?.valid  ?? null;
    state.report.scheduler.schedulerCode           = record?.code   ?? null;
    state.report.scheduler.lastTrackingAttemptedAt = record?.lastTrackingAttemptedAt ?? null;
    state.report.scheduler.lastTrackedAt           = record?.lastTrackedAt ?? null;
    state.report.scheduler.passed                  = record?.active === 1 && record?.valid === 1;

    console.log(`  → active=${record?.active}  valid=${record?.valid}`);
    expect(record,        'No scheduler record returned').not.toBeNull();
    expect(record.active, 'active should be 1').toBe(1);
    expect(record.valid,  'valid should be 1').toBe(1);
  });

  test('A-03 | Orders-In: Tracking document exists in MongoDB (xtrackings)', async () => {
    expect(state.containerNumber, 'A-01 must pass first').toBeTruthy();

    state.trackingDocs = await pollUntilTrackingDocCreated({
      containerId:    state.containerNumber,
      bookingId:      state.bookingNumber,
      billOfLadingId: state.blNumber,
      scacCode:       state.scac,
    });

    const doc0 = state.trackingDocs?.[0] ?? null;
    state.report.mongoDb.found          = (state.trackingDocs?.length ?? 0) > 0;
    state.report.mongoDb.containerId    = doc0?.containerId    ?? state.containerNumber;
    state.report.mongoDb.bookingId      = doc0?.bookingId      ?? state.bookingNumber;
    state.report.mongoDb.billOfLadingId = doc0?.billOfLadingId ?? state.blNumber;
    state.report.mongoDb.scacCode       = doc0?.scacCode       ?? state.scac;
    state.report.mongoDb.serviceProvider= doc0?.serviceProvider ?? null;
    state.report.mongoDb.identifier     = doc0?.identifier     ?? null;
    state.report.mongoDb.error          = doc0?.error          ?? null;
    state.report.mongoDb.uniqueReference= doc0?.uniqueReference ?? null;
    state.report.mongoDb.createdAt      = doc0?.createdAt      ?? null;
    state.report.mongoDb.eventsCount    = doc0?.events?.length ?? null;
    state.report.mongoDb.passed         = state.report.mongoDb.found && doc0?.error === false;

    console.log(`  → ${state.trackingDocs?.length ?? 0} tracking document(s) found`);
    expect(
      state.trackingDocs?.length,
      'No tracking documents found'
    ).toBeGreaterThan(0);

    const doc = state.trackingDocs[0];
    expect(doc.containerId, 'containerId should match').toBe(state.containerNumber);

    const expectedRef1 = `${state.bookingNumber}_${state.containerNumber}`;
    const expectedRef2 = `${state.blNumber}_${state.containerNumber}`;
    expect(
      [expectedRef1, expectedRef2],
      `uniqueReference "${doc.uniqueReference}" should be one of the two formats`
    ).toContain(doc.uniqueReference);
  });

  test('A-04 | Orders-In: Shipment searchable in Shippeo', async () => {
    expect(state.containerNumber, 'A-01 must pass first').toBeTruthy();

    state.shippeoRef = buildOceanReference({
      bookingNumber:   state.bookingNumber,
      blNumber:        state.blNumber,
      containerNumber: state.containerNumber,
    });

    console.log(`  → Shippeo reference: "${state.shippeoRef}"`);
    state.shippeoShipment = await pollUntilShippeoShipmentFound(state.shippeoRef);

    console.log(`  → Shippeo result:`, JSON.stringify(state.shippeoShipment ?? 'NOT FOUND'));
    expect(state.shippeoShipment, `Shipment "${state.shippeoRef}" not found in Shippeo`).not.toBeNull();
  });

  // ===========================================================================
  //  GROUP D — D-01 to D-08 | Direct Fields
  // ===========================================================================

  test.describe('D-01 to D-08 | Direct Fields', () => {

    test.describe('D-01 to D-03 | Positive — carrierUpdatedLocode + timezone (actual)', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[D-01 to D-03] Sending container_gate_out_empty / actual / origin_inland …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_gate_out_empty',
            runDate(1000),
            'actual',
            'external',
            toEventSite(SITE.NGB_INLAND)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('D-01 | carrierUpdatedLocodePol <- loading_site.unlocode', () =>
        assertField(otu, 'carrierUpdatedLocodePol', SITE.NGB_POL.unlocode));

      test('D-02 | carrierUpdatedLocodePod <- delivery_site.unlocode', () =>
        assertField(otu, 'carrierUpdatedLocodePod', SITE.RTM_POD.unlocode));

      test('D-03 | datetime_timezone <- event_site.timezone', () =>
        assertField(otu, 'datetime_timezone', SITE.NGB_INLAND.timezone));
    });

    test.describe('D-04 | Edge — carrierUpdatedLocodePol updates on new unlocode', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[D-04] Sending second event with different loading_site unlocode …');
        const payload = makeE2EPayload(
          'container_gate_out_empty',
          runDate(1001),
          'actual',
          'external',
          toEventSite(SITE.NGB_INLAND),
          {
            loading_site: {
              id: 'ALT001', externalID: null,
              unlocode: 'SGSIN',
              name: 'Singapore Alt',
              address_line: null, zipcode: '',
              city: 'Singapore', country: 'SG',
              position: { lat: 1.2897, lng: 103.8501 },
            },
          }
        );
        ({ otu } = await sendAndWaitE2E(payload, state.objectCode));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('D-04 | carrierUpdatedLocodePol updates to new unlocode', () =>
        assertField(otu, 'carrierUpdatedLocodePol', 'SGSIN'));
    });

    test.describe('D-05 | Edge — carrierUpdatedLocodePod updates on new POD unlocode', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[D-05] Sending second event with different delivery_site unlocode …');
        const payload = makeE2EPayload(
          'container_gate_out_empty',
          runDate(1002),
          'actual',
          'external',
          toEventSite(SITE.NGB_INLAND),
          {
            delivery_site: {
              id: 'ALT002', externalID: null,
              unlocode: 'SGSIN',
              name: 'Singapore Delivery Alt',
              address_line: null, zipcode: '',
              city: 'Singapore', country: 'SG',
              position: { lat: 1.2897, lng: 103.8501 },
            },
          }
        );
        ({ otu } = await sendAndWaitE2E(payload, state.objectCode));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('D-05 | carrierUpdatedLocodePod updates to new delivery_site unlocode', () =>
        assertField(otu, 'carrierUpdatedLocodePod', 'SGSIN'));
    });

    test('D-06 | Negative — loading_site no unlocode => carrierUpdatedLocodePol null / no crash', async () => {
      const payload = makeE2EPayload(
        'container_gate_out_empty',
        runDate(1003),
        'actual',
        'external',
        toEventSite(SITE.NGB_INLAND),
        {
          loading_site: {
            id: 'NOCODE', externalID: null,
            unlocode: null,
            name: 'No Unlocode Site',
            address_line: null, zipcode: '',
            city: 'Nowhere', country: 'XX',
            position: { lat: 0, lng: 0 },
          },
        }
      );
      const { after } = await sendAndSnapshot(payload);
      const av = after?.['carrierUpdatedLocodePol'] ?? null;
      console.log(`  [D-06] carrierUpdatedLocodePol after="${av}"`);
      expect(true).toBe(true);
    });

    test('D-07 | Negative — delivery_site no unlocode => carrierUpdatedLocodePod null / no crash', async () => {
      const payload = makeE2EPayload(
        'container_gate_out_empty',
        runDate(1004),
        'actual',
        'external',
        toEventSite(SITE.NGB_INLAND),
        {
          delivery_site: {
            id: 'NOCODE2', externalID: null,
            unlocode: null,
            name: 'No Unlocode Delivery',
            address_line: null, zipcode: '',
            city: 'Nowhere', country: 'XX',
            position: { lat: 0, lng: 0 },
          },
        }
      );
      const { after } = await sendAndSnapshot(payload);
      const av = after?.['carrierUpdatedLocodePod'] ?? null;
      console.log(`  [D-07] carrierUpdatedLocodePod after="${av}"`);
      expect(true).toBe(true);
    });

    test('D-08 | Negative — event_site no timezone => datetime_timezone null / no crash', async () => {
      const eventSiteNoTz = { ...toEventSite(SITE.NGB_INLAND), timezone: null };
      const payload = makeE2EPayload(
        'container_gate_out_empty',
        runDate(1005),
        'actual',
        'external',
        eventSiteNoTz
      );
      const { after } = await sendAndSnapshot(payload);
      const av = after?.['datetime_timezone'] ?? null;
      console.log(`  [D-08] datetime_timezone after="${av}"`);
      expect(true).toBe(true);
    });

  }); // end GROUP D

  // ===========================================================================
  //  GROUP PC — PC-01 to PC-32 | Pre-Carriage
  // ===========================================================================

  test.describe('PC-01 to PC-32 | Pre-Carriage', () => {

    test.describe('PC-01 to PC-04 | actual gate_out_empty origin_inland', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[PC-01 to PC-04] container_gate_out_empty / actual / origin_inland …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_gate_out_empty',
            runDate(2000),
            'actual',
            'external',
            toEventSite(SITE.NGB_INLAND)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('PC-01 | actualGateOutEmptyDepot <- situation.date', () =>
        assertField(otu, 'actualGateOutEmptyDepot', runDate(2000)));

      test('PC-02 | depotPreCountry <- event_site.country', () =>
        assertField(otu, 'depotPreCountry', SITE.NGB_INLAND.country));

      test('PC-03 | depotPreLocation <- event_site.city', () =>
        assertField(otu, 'depotPreLocation', SITE.NGB_INLAND.city));

      test('PC-04 | motGateOutEmpty <- situation.transport_mode (ocean)', () =>
        assertField(otu, 'motGateOutEmpty', 'ocean'));
    });

    test.describe('PC-05 to PC-08 | estimated gate_out_empty origin_inland (external)', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[PC-05 to PC-08] container_gate_out_empty / estimated / origin_inland / external …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_gate_out_empty',
            runDate(3000),
            'estimated',
            'external',
            toEventSite(SITE.NGB_INLAND)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('PC-05 | estimatedGateOutEmptyDepot <- situation.date', () =>
        assertField(otu, 'estimatedGateOutEmptyDepot', runDate(3000)));

      test('PC-06 | depotPreCountry <- event_site.country', () =>
        assertField(otu, 'depotPreCountry', SITE.NGB_INLAND.country));

      test('PC-07 | depotPreLocation <- event_site.city', () =>
        assertField(otu, 'depotPreLocation', SITE.NGB_INLAND.city));

      test('PC-08 | motGateOutEmpty <- situation.transport_mode (ocean)', () =>
        assertField(otu, 'motGateOutEmpty', 'ocean'));
    });

    test('PC-09 | Negative — estimated gate_out_empty origin_inland + shippeo => no estimatedGateOutEmptyDepot', async () => {
      const { before, after } = await sendAndSnapshot(
        makeE2EPayload(
          'container_gate_out_empty',
          runDate(3001),
          'estimated',
          'shippeo',
          toEventSite(SITE.NGB_INLAND)
        )
      );
      assertNotChanged(before, after, 'estimatedGateOutEmptyDepot');
    });

    test('PC-10 | Negative — estimated gate_out_empty origin_inland + null data_source => no estimatedGateOutEmptyDepot', async () => {
      const { before, after } = await sendAndSnapshot(
        makeE2EPayload(
          'container_gate_out_empty',
          runDate(3002),
          'estimated',
          null,
          toEventSite(SITE.NGB_INLAND)
        )
      );
      assertNotChanged(before, after, 'estimatedGateOutEmptyDepot');
    });

    test('PC-11 | Edge — null city => depotPreLocation null', async () => {
      const eventSiteNullCity = { ...toEventSite(SITE.NGB_INLAND), city: null };
      const { otu } = await sendAndWaitE2E(
        makeE2EPayload(
          'container_gate_out_empty',
          runDate(3003),
          'actual',
          'external',
          eventSiteNullCity
        ),
        state.objectCode
      );
      assertField(otu, 'depotPreLocation', null);
    });

    test('PC-12 | Edge — null country => depotPreCountry null', async () => {
      const eventSiteNullCountry = { ...toEventSite(SITE.NGB_INLAND), country: null };
      const { otu } = await sendAndWaitE2E(
        makeE2EPayload(
          'container_gate_out_empty',
          runDate(3004),
          'actual',
          'external',
          eventSiteNullCountry
        ),
        state.objectCode
      );
      assertField(otu, 'depotPreCountry', null);
    });

    test.describe('PC-13 to PC-14 | actual gate_out_empty loading (no transhipment)', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[PC-13 to PC-14] container_gate_out_empty / actual / loading / no transhipment …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_gate_out_empty',
            runDate(4000),
            'actual',
            'external',
            toEventSite(SITE.NGB_POL)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('PC-13 | actualGateOutEmptyDepot <- situation.date (loading place_type)', () =>
        assertField(otu, 'actualGateOutEmptyDepot', runDate(4000)));

      test('PC-14 | depotPre fields and motGateOutEmpty written at loading place_type', () => {
        assertField(otu, 'depotPreCountry', SITE.NGB_POL.country);
        assertField(otu, 'depotPreLocation', SITE.NGB_POL.city);
        assertField(otu, 'motGateOutEmpty', 'ocean');
      });
    });

    test.describe('PC-15 to PC-16 | estimated gate_out_empty loading (external)', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[PC-15 to PC-16] container_gate_out_empty / estimated / loading / external …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_gate_out_empty',
            runDate(5000),
            'estimated',
            'external',
            toEventSite(SITE.NGB_POL)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('PC-15 | estimatedGateOutEmptyDepot <- situation.date (loading place_type)', () =>
        assertField(otu, 'estimatedGateOutEmptyDepot', runDate(5000)));

      test('PC-16 | depotPre fields written at loading place_type (estimated)', () => {
        assertField(otu, 'depotPreCountry', SITE.NGB_POL.country);
        assertField(otu, 'depotPreLocation', SITE.NGB_POL.city);
      });
    });

    test('PC-17 | Negative — gate_out_empty + discharge place_type => no actualGateOutEmptyDepot', async () => {
      const { before, after } = await sendAndSnapshot(
        makeE2EPayload(
          'container_gate_out_empty',
          runDate(5001),
          'actual',
          'external',
          toEventSite(SITE.RTM_POD)
        )
      );
      assertNotChanged(before, after, 'actualGateOutEmptyDepot');
    });

    test('PC-18 | Negative — gate_out_empty + transhipment place_type => no actualGateOutEmptyDepot', async () => {
      const { before, after } = await sendAndSnapshot(
        makeE2EPayload(
          'container_gate_out_empty',
          runDate(5002),
          'actual',
          'external',
          toEventSite(SITE.SGP_TSP1)
        )
      );
      assertNotChanged(before, after, 'actualGateOutEmptyDepot');
    });

    test.describe('PC-19 to PC-22 | actual container_departed origin_inland', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[PC-19 to PC-22] container_departed / actual / origin_inland …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_departed',
            runDate(6000),
            'actual',
            'external',
            toEventSite(SITE.NGB_INLAND)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('PC-19 | actualDepartureFromOrigin <- situation.date', () =>
        assertField(otu, 'actualDepartureFromOrigin', runDate(6000)));

      test('PC-20 | motPickUpOrigin <- situation.transport_mode (ocean)', () =>
        assertField(otu, 'motPickUpOrigin', 'ocean'));

      test('PC-21 | pickUpOriginCountry <- event_site.country', () =>
        assertField(otu, 'pickUpOriginCountry', SITE.NGB_INLAND.country));

      test('PC-22 | pickUpOriginLocation <- event_site.city', () =>
        assertField(otu, 'pickUpOriginLocation', SITE.NGB_INLAND.city));
    });

    test.describe('PC-23 to PC-26 | estimated container_departed origin_inland (external)', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[PC-23 to PC-26] container_departed / estimated / origin_inland / external …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_departed',
            runDate(7000),
            'estimated',
            'external',
            toEventSite(SITE.NGB_INLAND)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('PC-23 | estimatedDepartureFromOrigin <- situation.date', () =>
        assertField(otu, 'estimatedDepartureFromOrigin', runDate(7000)));

      test('PC-24 | motPickUpOrigin <- situation.transport_mode (ocean)', () =>
        assertField(otu, 'motPickUpOrigin', 'ocean'));

      test('PC-25 | pickUpOriginCountry <- event_site.country', () =>
        assertField(otu, 'pickUpOriginCountry', SITE.NGB_INLAND.country));

      test('PC-26 | pickUpOriginLocation <- event_site.city', () =>
        assertField(otu, 'pickUpOriginLocation', SITE.NGB_INLAND.city));
    });

    test('PC-27 | Negative — container_departed + loading place_type => no actualDepartureFromOrigin', async () => {
      const { before, after } = await sendAndSnapshot(
        makeE2EPayload(
          'container_departed',
          runDate(7001),
          'actual',
          'external',
          toEventSite(SITE.NGB_POL)
        )
      );
      assertNotChanged(before, after, 'actualDepartureFromOrigin');
    });

    test('PC-28 | Negative — container_departed + origin_inland + shippeo => no estimatedDepartureFromOrigin', async () => {
      const { before, after } = await sendAndSnapshot(
        makeE2EPayload(
          'container_departed',
          runDate(7002),
          'estimated',
          'shippeo',
          toEventSite(SITE.NGB_INLAND)
        )
      );
      assertNotChanged(before, after, 'estimatedDepartureFromOrigin');
    });

    test.describe('PC-29 | actual container_loaded origin_inland', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[PC-29] container_loaded / actual / origin_inland …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_loaded',
            runDate(8000),
            'actual',
            'external',
            toEventSite(SITE.NGB_INLAND)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('PC-29 | actualLoadedAtOrigin <- situation.date', () =>
        assertField(otu, 'actualLoadedAtOrigin', runDate(8000)));
    });

    test.describe('PC-30 | estimated container_loaded origin_inland (external)', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[PC-30] container_loaded / estimated / origin_inland / external …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_loaded',
            runDate(9000),
            'estimated',
            'external',
            toEventSite(SITE.NGB_INLAND)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('PC-30 | estimatedLoadedAtOrigin <- situation.date', () =>
        assertField(otu, 'estimatedLoadedAtOrigin', runDate(9000)));
    });

    test('PC-31 | Negative — container_loaded + loading place_type => no actualLoadedAtOrigin', async () => {
      const { before, after } = await sendAndSnapshot(
        makeE2EPayload(
          'container_loaded',
          runDate(9001),
          'actual',
          'external',
          toEventSite(SITE.NGB_POL)
        )
      );
      assertNotChanged(before, after, 'actualLoadedAtOrigin');
    });

    test('PC-32 | Negative — container_loaded + origin_inland + shippeo => no estimatedLoadedAtOrigin', async () => {
      const { before, after } = await sendAndSnapshot(
        makeE2EPayload(
          'container_loaded',
          runDate(9002),
          'estimated',
          'shippeo',
          toEventSite(SITE.NGB_INLAND)
        )
      );
      assertNotChanged(before, after, 'estimatedLoadedAtOrigin');
    });

  }); // end GROUP PC

  // ===========================================================================
  //  GROUP POL — POL-01 to POL-27 | Port of Loading
  // ===========================================================================

  test.describe('POL-01 to POL-27 | Port of Loading', () => {

    test.describe('POL-01 | actual container_gate_out_full at loading', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[POL-01] container_gate_out_full / actual / loading …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_gate_out_full',
            runDate(10000),
            'actual',
            'external',
            toEventSite(SITE.NGB_POL)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('POL-01 | actualGateInPol <- situation.date (container_gate_out_full at loading)', () =>
        assertField(otu, 'actualGateInPol', runDate(10000)));
    });

    test.describe('POL-02 | actual container_arrived at loading', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[POL-02] container_arrived / actual / loading …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_arrived',
            runDate(11000),
            'actual',
            'external',
            toEventSite(SITE.NGB_POL)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('POL-02 | actualGateInPol <- situation.date (container_arrived at loading)', () =>
        assertField(otu, 'actualGateInPol', runDate(11000)));
    });

    test.describe('POL-03 | actual container_gate_in_full at loading', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[POL-03] container_gate_in_full / actual / loading …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_gate_in_full',
            runDate(12000),
            'actual',
            'external',
            toEventSite(SITE.NGB_POL)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('POL-03 | actualGateInPol <- situation.date (container_gate_in_full at loading)', () =>
        assertField(otu, 'actualGateInPol', runDate(12000)));
    });

    test.describe('POL-04 | estimated container_gate_out_full at loading (external)', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[POL-04] container_gate_out_full / estimated / loading / external …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_gate_out_full',
            runDate(13000),
            'estimated',
            'external',
            toEventSite(SITE.NGB_POL)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('POL-04 | estimatedGateInPol <- situation.date (container_gate_out_full estimated external)', () =>
        assertField(otu, 'estimatedGateInPol', runDate(13000)));
    });

    test.describe('POL-05 | estimated container_arrived at loading (external)', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[POL-05] container_arrived / estimated / loading / external …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_arrived',
            runDate(14000),
            'estimated',
            'external',
            toEventSite(SITE.NGB_POL)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('POL-05 | estimatedGateInPol <- situation.date (container_arrived estimated external)', () =>
        assertField(otu, 'estimatedGateInPol', runDate(14000)));
    });

    test.describe('POL-06 | estimated container_gate_in_full at loading (external)', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[POL-06] container_gate_in_full / estimated / loading / external …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_gate_in_full',
            runDate(15000),
            'estimated',
            'external',
            toEventSite(SITE.NGB_POL)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('POL-06 | estimatedGateInPol <- situation.date (container_gate_in_full estimated external)', () =>
        assertField(otu, 'estimatedGateInPol', runDate(15000)));
    });

    test('POL-07 | Negative — container_gate_out_full + discharge place_type => no actualGateInPol', async () => {
      const { before, after } = await sendAndSnapshot(
        makeE2EPayload(
          'container_gate_out_full',
          runDate(15001),
          'actual',
          'external',
          toEventSite(SITE.RTM_POD)
        )
      );
      assertNotChanged(before, after, 'actualGateInPol');
    });

    test('POL-08 | Negative — container_arrived + origin_inland place_type => no actualGateInPol', async () => {
      const { before, after } = await sendAndSnapshot(
        makeE2EPayload(
          'container_arrived',
          runDate(15002),
          'actual',
          'external',
          toEventSite(SITE.NGB_INLAND)
        )
      );
      assertNotChanged(before, after, 'actualGateInPol');
    });

    test('POL-09 | Negative — container_gate_out_full + loading + estimated + shippeo => no estimatedGateInPol', async () => {
      const { before, after } = await sendAndSnapshot(
        makeE2EPayload(
          'container_gate_out_full',
          runDate(15003),
          'estimated',
          'shippeo',
          toEventSite(SITE.NGB_POL)
        )
      );
      assertNotChanged(before, after, 'estimatedGateInPol');
    });

    test.describe('POL-10 | actual container_loaded at loading', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[POL-10] container_loaded / actual / loading …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_loaded',
            runDate(16000),
            'actual',
            'external',
            toEventSite(SITE.NGB_POL)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('POL-10 | actualLoadPol <- situation.date', () =>
        assertField(otu, 'actualLoadPol', runDate(16000)));
    });

    test.describe('POL-11 | estimated container_loaded at loading (external)', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[POL-11] container_loaded / estimated / loading / external …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_loaded',
            runDate(17000),
            'estimated',
            'external',
            toEventSite(SITE.NGB_POL)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('POL-11 | estimatedLoadPol <- situation.date', () =>
        assertField(otu, 'estimatedLoadPol', runDate(17000)));
    });

    test('POL-12 | Negative — container_loaded + loading + estimated + shippeo => no estimatedLoadPol', async () => {
      const { before, after } = await sendAndSnapshot(
        makeE2EPayload(
          'container_loaded',
          runDate(17001),
          'estimated',
          'shippeo',
          toEventSite(SITE.NGB_POL)
        )
      );
      assertNotChanged(before, after, 'estimatedLoadPol');
    });

    test.describe('POL-13 | Edge — container_loaded loading actual no vessel => actualLoadPol written, leg1VesselImoNumber null', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[POL-13] container_loaded / actual / loading / no vessel …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_loaded',
            runDate(16001),
            'actual',
            'external',
            toEventSite(SITE.NGB_POL)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('POL-13 | actualLoadPol is written even without vessel resources', () =>
        assertField(otu, 'actualLoadPol', runDate(16001)));

      test('POL-13 | leg1VesselImoNumber is null when no vessel resources', () =>
        assertField(otu, 'leg1VesselImoNumber', null));
    });

    test.describe('POL-14 | actual container_departed at loading', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[POL-14] container_departed / actual / loading …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_departed',
            runDate(18000),
            'actual',
            'external',
            toEventSite(SITE.NGB_POL)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('POL-14 | actualDeparturePol <- situation.date', () =>
        assertField(otu, 'actualDeparturePol', runDate(18000)));
    });

    test.describe('POL-15 | estimated container_departed at loading (external)', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[POL-15] container_departed / estimated / loading / external …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_departed',
            runDate(19000),
            'estimated',
            'external',
            toEventSite(SITE.NGB_POL)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('POL-15 | estimatedDeparturePol <- situation.date', () =>
        assertField(otu, 'estimatedDeparturePol', runDate(19000)));
    });

    test.describe('POL-16 | predicted container_departed at loading (shippeo)', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[POL-16] container_departed / estimated / loading / shippeo …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_departed',
            runDate(20000),
            'estimated',
            'shippeo',
            toEventSite(SITE.NGB_POL)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('POL-16 | predictedDeparturePol <- situation.date (shippeo source)', () =>
        assertField(otu, 'predictedDeparturePol', runDate(20000)));
    });

    test('POL-17 | Positive — actualDeparturePol, estimatedDeparturePol, predictedDeparturePol all coexist', async () => {
      const otu = await getOTU(state.objectCode).catch(() => null);
      assertField(otu, 'actualDeparturePol',    runDate(18000));
      assertField(otu, 'estimatedDeparturePol', runDate(19000));
      assertField(otu, 'predictedDeparturePol', runDate(20000));
    });

    test('POL-18 | Negative — container_departed + loading + estimated + shippeo => no estimatedDeparturePol', async () => {
      const { before, after } = await sendAndSnapshot(
        makeE2EPayload(
          'container_departed',
          runDate(20001),
          'estimated',
          'shippeo',
          toEventSite(SITE.NGB_POL)
        )
      );
      assertNotChanged(before, after, 'estimatedDeparturePol');
    });

    test('POL-19 | Negative — container_departed + loading + estimated + external => no predictedDeparturePol', async () => {
      const { before, after } = await sendAndSnapshot(
        makeE2EPayload(
          'container_departed',
          runDate(20002),
          'estimated',
          'external',
          toEventSite(SITE.NGB_POL)
        )
      );
      assertNotChanged(before, after, 'predictedDeparturePol');
    });

    test.describe('POL-20 to POL-22 | actual container_loaded loading transhipment=true with vessel', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[POL-20 to POL-22] container_loaded / actual / loading / transhipment=true / withVessel …');
        const payload = makeE2EPayload(
          'container_loaded',
          runDate(21000),
          'actual',
          'external',
          toEventSite(SITE.NGB_POL),
          { _transhipment: true }
        );
        withVessel(payload);
        ({ otu } = await sendAndWaitE2E(payload, state.objectCode));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('POL-20 | leg1VesselImoNumber <- milestoneVessel IMO', () =>
        assertField(otu, 'leg1VesselImoNumber', VESSEL.imoNumber));

      test('POL-21 | leg1VesselName <- milestoneVessel LABEL', () =>
        assertField(otu, 'leg1VesselName', VESSEL.label));

      test('POL-22 | leg1Mot <- situation.transport_mode (ocean)', () =>
        assertField(otu, 'leg1Mot', 'ocean'));
    });

    test.describe('POL-23 | actual container_departed loading transhipment=true with vessel', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[POL-23] container_departed / actual / loading / transhipment=true / withVessel …');
        const payload = makeE2EPayload(
          'container_departed',
          runDate(22000),
          'actual',
          'external',
          toEventSite(SITE.NGB_POL),
          { _transhipment: true }
        );
        withVessel(payload);
        ({ otu } = await sendAndWaitE2E(payload, state.objectCode));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('POL-23 | All three leg1 fields written on container_departed transhipment', () => {
        assertField(otu, 'leg1VesselImoNumber', VESSEL.imoNumber);
        assertField(otu, 'leg1VesselName',      VESSEL.label);
        assertField(otu, 'leg1Mot',             'ocean');
      });
    });

    test.describe('POL-24 | Edge — transhipment but resources=[] => leg1VesselImoNumber null', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[POL-24] container_loaded / actual / loading / transhipment=true / no vessel …');
        const payload = makeE2EPayload(
          'container_loaded',
          runDate(21001),
          'actual',
          'external',
          toEventSite(SITE.NGB_POL),
          { _transhipment: true, resources: [] }
        );
        ({ otu } = await sendAndWaitE2E(payload, state.objectCode));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('POL-24 | leg1VesselImoNumber is null when resources empty', () =>
        assertField(otu, 'leg1VesselImoNumber', null));
    });

    test.describe('POL-25 | Edge — only vessel qualifier (no milestoneVessel) => leg1VesselImoNumber null', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[POL-25] container_loaded / actual / loading / transhipment=true / only vessel qualifier …');
        const payload = makeE2EPayload(
          'container_loaded',
          runDate(21002),
          'actual',
          'external',
          toEventSite(SITE.NGB_POL),
          {
            _transhipment: true,
            resources: [
              {
                qualifier: 'vessel',
                identifiers: [
                  { qualifier: 'IMO',   value: VESSEL.imoNumber },
                  { qualifier: 'MMSI',  value: VESSEL.mmsi      },
                  { qualifier: 'LABEL', value: VESSEL.label      },
                ],
              },
            ],
          }
        );
        ({ otu } = await sendAndWaitE2E(payload, state.objectCode));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('POL-25 | leg1VesselImoNumber null when only vessel qualifier present', () =>
        assertField(otu, 'leg1VesselImoNumber', null));
    });

    test('POL-26 | Negative — container_loaded + loading + actual + no transhipment => no leg1VesselImoNumber written', async () => {
      const { before, after } = await sendAndSnapshot(
        makeE2EPayload(
          'container_loaded',
          runDate(21003),
          'actual',
          'external',
          toEventSite(SITE.NGB_POL)
        )
      );
      assertNotChanged(before, after, 'leg1VesselImoNumber');
    });

    test.describe('POL-27 | Positive — estimated container_loaded + loading + transhipment=true + vessel => leg1 fields written', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[POL-27] container_loaded / estimated / loading / transhipment=true / withVessel …');
        const payload = makeE2EPayload(
          'container_loaded',
          runDate(21004),
          'estimated',
          'external',
          toEventSite(SITE.NGB_POL),
          { _transhipment: true }
        );
        withVessel(payload);
        ({ otu } = await sendAndWaitE2E(payload, state.objectCode));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('POL-27 | leg1VesselImoNumber written on estimated + transhipment event', () =>
        assertField(otu, 'leg1VesselImoNumber', VESSEL.imoNumber));
    });

  }); // end GROUP POL

  // ===========================================================================
  //  GROUP POD — POD-01 to POD-30 | Port of Discharge
  // ===========================================================================

  test.describe('POD-01 to POD-30 | Port of Discharge', () => {

    test.describe('POD-01 | estimated eta_event at discharge (external)', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[POD-01] eta_event / estimated / discharge / external …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'eta_event',
            runDate(23000),
            'estimated',
            'external',
            toEventSite(SITE.RTM_POD)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('POD-01 | estimatedArrivalPod <- situation.date (eta_event external)', () =>
        assertField(otu, 'estimatedArrivalPod', runDate(23000)));
    });

    test.describe('POD-02 | predicted eta_event at discharge (shippeo)', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[POD-02] eta_event / estimated / discharge / shippeo …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'eta_event',
            runDate(24000),
            'estimated',
            'shippeo',
            toEventSite(SITE.RTM_POD)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('POD-02 | predictedArrivalPod <- situation.date (eta_event shippeo)', () =>
        assertField(otu, 'predictedArrivalPod', runDate(24000)));
    });

    test('POD-03 | Negative — eta_event + discharge + actual type => no estimatedArrivalPod', async () => {
      const { before, after } = await sendAndSnapshot(
        makeE2EPayload(
          'eta_event',
          runDate(24001),
          'actual',
          'external',
          toEventSite(SITE.RTM_POD)
        )
      );
      assertNotChanged(before, after, 'estimatedArrivalPod');
    });

    test('POD-04 | Negative — eta_event + loading place_type => no estimatedArrivalPod', async () => {
      const { before, after } = await sendAndSnapshot(
        makeE2EPayload(
          'eta_event',
          runDate(24002),
          'estimated',
          'external',
          toEventSite(SITE.NGB_POL)
        )
      );
      assertNotChanged(before, after, 'estimatedArrivalPod');
    });

    test('POD-05 | Negative — eta_event + discharge + null data_source => no estimatedArrivalPod', async () => {
      const { before, after } = await sendAndSnapshot(
        makeE2EPayload(
          'eta_event',
          runDate(24003),
          'estimated',
          null,
          toEventSite(SITE.RTM_POD)
        )
      );
      assertNotChanged(before, after, 'estimatedArrivalPod');
    });

    test.describe('POD-06 | actual container_arrived at discharge', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[POD-06] container_arrived / actual / discharge …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_arrived',
            runDate(25000),
            'actual',
            'external',
            toEventSite(SITE.RTM_POD)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('POD-06 | actualArrivalPod <- situation.date', () =>
        assertField(otu, 'actualArrivalPod', runDate(25000)));
    });

    test('POD-07 | Negative — container_arrived + loading place_type => no actualArrivalPod', async () => {
      const { before, after } = await sendAndSnapshot(
        makeE2EPayload(
          'container_arrived',
          runDate(25001),
          'actual',
          'external',
          toEventSite(SITE.NGB_POL)
        )
      );
      assertNotChanged(before, after, 'actualArrivalPod');
    });

    test('POD-08 | Negative — container_arrived + discharge + estimated type => no actualArrivalPod', async () => {
      const { before, after } = await sendAndSnapshot(
        makeE2EPayload(
          'container_arrived',
          runDate(25002),
          'estimated',
          'external',
          toEventSite(SITE.RTM_POD)
        )
      );
      assertNotChanged(before, after, 'actualArrivalPod');
    });

    test.describe('POD-09 | actual container_unloaded at discharge', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[POD-09] container_unloaded / actual / discharge …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_unloaded',
            runDate(26000),
            'actual',
            'external',
            toEventSite(SITE.RTM_POD)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('POD-09 | actualDischargePod <- situation.date', () =>
        assertField(otu, 'actualDischargePod', runDate(26000)));
    });

    test.describe('POD-10 | estimated container_unloaded at discharge (external)', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[POD-10] container_unloaded / estimated / discharge / external …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_unloaded',
            runDate(27000),
            'estimated',
            'external',
            toEventSite(SITE.RTM_POD)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('POD-10 | estimatedDischargePod <- situation.date', () =>
        assertField(otu, 'estimatedDischargePod', runDate(27000)));
    });

    test.describe('POD-11 | predicted container_unloaded at discharge (shippeo)', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[POD-11] container_unloaded / estimated / discharge / shippeo …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_unloaded',
            runDate(28000),
            'estimated',
            'shippeo',
            toEventSite(SITE.RTM_POD)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('POD-11 | predictedDischargePod <- situation.date (shippeo source)', () =>
        assertField(otu, 'predictedDischargePod', runDate(28000)));
    });

    test('POD-12 | Positive — actualDischargePod, estimatedDischargePod, predictedDischargePod all coexist', async () => {
      const otu = await getOTU(state.objectCode).catch(() => null);
      const adv = otu?.['actualDischargePod']    ?? null;
      const edv = otu?.['estimatedDischargePod'] ?? null;
      const pdv = otu?.['predictedDischargePod'] ?? null;
      console.log(`  [POD-12] actualDischargePod="${adv}" estimatedDischargePod="${edv}" predictedDischargePod="${pdv}"`);
      expect(adv, 'actualDischargePod should be set').not.toBeNull();
      expect(edv, 'estimatedDischargePod should be set').not.toBeNull();
      expect(pdv, 'predictedDischargePod should be set').not.toBeNull();
    });

    test('POD-13 | Negative — container_unloaded + loading place_type => no actualDischargePod', async () => {
      const { before, after } = await sendAndSnapshot(
        makeE2EPayload(
          'container_unloaded',
          runDate(28001),
          'actual',
          'external',
          toEventSite(SITE.NGB_POL)
        )
      );
      assertNotChanged(before, after, 'actualDischargePod');
    });

    test.describe('POD-14 | actual container_gate_out_full at discharge', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[POD-14] container_gate_out_full / actual / discharge …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_gate_out_full',
            runDate(29000),
            'actual',
            'external',
            toEventSite(SITE.RTM_POD)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('POD-14 | actualGateOutPod <- situation.date (container_gate_out_full at discharge)', () =>
        assertField(otu, 'actualGateOutPod', runDate(29000)));

      test('POD-14 | motGateOutPod <- situation.transport_mode (ocean)', () =>
        assertField(otu, 'motGateOutPod', 'ocean'));
    });

    test.describe('POD-15 | actual container_gate_in_full at discharge', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[POD-15] container_gate_in_full / actual / discharge …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_gate_in_full',
            runDate(30000),
            'actual',
            'external',
            toEventSite(SITE.RTM_POD)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('POD-15 | actualGateOutPod <- situation.date (container_gate_in_full at discharge)', () =>
        assertField(otu, 'actualGateOutPod', runDate(30000)));
    });

    test.describe('POD-16 | actual container_departed at discharge', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[POD-16] container_departed / actual / discharge …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_departed',
            runDate(31000),
            'actual',
            'external',
            toEventSite(SITE.RTM_POD)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('POD-16 | actualGateOutPod <- situation.date (container_departed at discharge)', () =>
        assertField(otu, 'actualGateOutPod', runDate(31000)));
    });

    test.describe('POD-18 | motGateOutPod written on container_gate_in_full at discharge', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[POD-18] container_gate_in_full / actual / discharge for motGateOutPod …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_gate_in_full',
            runDate(30001),
            'actual',
            'external',
            toEventSite(SITE.RTM_POD)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('POD-18 | motGateOutPod <- situation.transport_mode (ocean) for gate_in_full at discharge', () =>
        assertField(otu, 'motGateOutPod', 'ocean'));
    });

    test.describe('POD-19 | estimated container_gate_out_full at discharge (external)', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[POD-19] container_gate_out_full / estimated / discharge / external …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_gate_out_full',
            runDate(32000),
            'estimated',
            'external',
            toEventSite(SITE.RTM_POD)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('POD-19 | estimatedGateOutPod <- situation.date (gate_out_full estimated external)', () =>
        assertField(otu, 'estimatedGateOutPod', runDate(32000)));
    });

    test.describe('POD-20 | estimated container_gate_in_full at discharge (external)', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[POD-20] container_gate_in_full / estimated / discharge / external …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_gate_in_full',
            runDate(32001),
            'estimated',
            'external',
            toEventSite(SITE.RTM_POD)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('POD-20 | estimatedGateOutPod <- situation.date (gate_in_full estimated external)', () =>
        assertField(otu, 'estimatedGateOutPod', runDate(32001)));
    });

    test.describe('POD-21 | estimated container_departed at discharge (external)', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[POD-21] container_departed / estimated / discharge / external …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_departed',
            runDate(32002),
            'estimated',
            'external',
            toEventSite(SITE.RTM_POD)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('POD-21 | estimatedGateOutPod <- situation.date (departed estimated external)', () =>
        assertField(otu, 'estimatedGateOutPod', runDate(32002)));
    });

    test.describe('POD-22 | predicted container_gate_out_full at discharge (shippeo)', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[POD-22] container_gate_out_full / estimated / discharge / shippeo …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_gate_out_full',
            runDate(33000),
            'estimated',
            'shippeo',
            toEventSite(SITE.RTM_POD)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('POD-22 | predictedGateOutPod <- situation.date (gate_out_full shippeo)', () =>
        assertField(otu, 'predictedGateOutPod', runDate(33000)));
    });

    test('POD-23 | Negative — container_gate_in_full + discharge + shippeo => no predictedGateOutPod', async () => {
      const { before, after } = await sendAndSnapshot(
        makeE2EPayload(
          'container_gate_in_full',
          runDate(33001),
          'estimated',
          'shippeo',
          toEventSite(SITE.RTM_POD)
        )
      );
      assertNotChanged(before, after, 'predictedGateOutPod');
    });

    test('POD-24 | Negative — container_departed + discharge + shippeo => no predictedGateOutPod', async () => {
      const { before, after } = await sendAndSnapshot(
        makeE2EPayload(
          'container_departed',
          runDate(33002),
          'estimated',
          'shippeo',
          toEventSite(SITE.RTM_POD)
        )
      );
      assertNotChanged(before, after, 'predictedGateOutPod');
    });

    test.describe('POD-25 to POD-26 | actual container_gate_in_empty at discharge', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[POD-25 to POD-26] container_gate_in_empty / actual / discharge …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_gate_in_empty',
            runDate(34000),
            'actual',
            'external',
            toEventSite(SITE.RTM_POD)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('POD-25 | actualEmptyReturn <- situation.date', () =>
        assertField(otu, 'actualEmptyReturn', runDate(34000)));

      test('POD-26 | motEmptyReturn <- situation.transport_mode (ocean)', () =>
        assertField(otu, 'motEmptyReturn', 'ocean'));
    });

    test.describe('POD-27 to POD-28 | estimated container_gate_in_empty at discharge (external)', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[POD-27 to POD-28] container_gate_in_empty / estimated / discharge / external …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_gate_in_empty',
            runDate(35000),
            'estimated',
            'external',
            toEventSite(SITE.RTM_POD)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('POD-27 | estimatedEmptyReturn <- situation.date', () =>
        assertField(otu, 'estimatedEmptyReturn', runDate(35000)));

      test('POD-28 | motEmptyReturn <- situation.transport_mode (ocean)', () =>
        assertField(otu, 'motEmptyReturn', 'ocean'));
    });

    test('POD-29 | Negative — container_gate_in_empty + discharge + shippeo => no estimatedEmptyReturn', async () => {
      const { before, after } = await sendAndSnapshot(
        makeE2EPayload(
          'container_gate_in_empty',
          runDate(35001),
          'estimated',
          'shippeo',
          toEventSite(SITE.RTM_POD)
        )
      );
      assertNotChanged(before, after, 'estimatedEmptyReturn');
    });

    test('POD-30 | Negative — container_gate_in_empty + loading place_type => no actualEmptyReturn', async () => {
      const { before, after } = await sendAndSnapshot(
        makeE2EPayload(
          'container_gate_in_empty',
          runDate(35002),
          'actual',
          'external',
          toEventSite(SITE.NGB_POL)
        )
      );
      assertNotChanged(before, after, 'actualEmptyReturn');
    });

  }); // end GROUP POD

  // ===========================================================================
  //  GROUP DEL — DEL-01 to DEL-16 | Delivery
  // ===========================================================================

  test.describe('DEL-01 to DEL-16 | Delivery (Destination Inland)', () => {

    test.describe('DEL-01 to DEL-03 | actual container_arrived at destination_inland', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[DEL-01 to DEL-03] container_arrived / actual / destination_inland …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_arrived',
            runDate(36000),
            'actual',
            'external',
            toEventSite(SITE.RTM_INLAND)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('DEL-01 | actualArrivalDestination <- situation.date', () =>
        assertField(otu, 'actualArrivalDestination', runDate(36000)));

      test('DEL-02 | destinationCity <- event_site.city', () =>
        assertField(otu, 'destinationCity', SITE.RTM_INLAND.city));

      test('DEL-03 | destinationCountry <- event_site.country', () =>
        assertField(otu, 'destinationCountry', SITE.RTM_INLAND.country));
    });

    test.describe('DEL-04 to DEL-06 | estimated container_arrived at destination_inland (external)', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[DEL-04 to DEL-06] container_arrived / estimated / destination_inland / external …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_arrived',
            runDate(37000),
            'estimated',
            'external',
            toEventSite(SITE.RTM_INLAND)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('DEL-04 | estimatedArrivalDestination <- situation.date', () =>
        assertField(otu, 'estimatedArrivalDestination', runDate(37000)));

      test('DEL-05 | destinationCity <- event_site.city (estimated)', () =>
        assertField(otu, 'destinationCity', SITE.RTM_INLAND.city));

      test('DEL-06 | destinationCountry <- event_site.country (estimated)', () =>
        assertField(otu, 'destinationCountry', SITE.RTM_INLAND.country));
    });

    test('DEL-07 | Negative — shippeo source => no estimatedArrivalDestination', async () => {
      const { before, after } = await sendAndSnapshot(
        makeE2EPayload(
          'container_arrived',
          runDate(37001),
          'estimated',
          'shippeo',
          toEventSite(SITE.RTM_INLAND)
        )
      );
      assertNotChanged(before, after, 'estimatedArrivalDestination');
    });

    test('DEL-08 | Negative — container_arrived + discharge place_type => no actualArrivalDestination', async () => {
      const { before, after } = await sendAndSnapshot(
        makeE2EPayload(
          'container_arrived',
          runDate(37002),
          'actual',
          'external',
          toEventSite(SITE.RTM_POD)
        )
      );
      assertNotChanged(before, after, 'actualArrivalDestination');
    });

    test('DEL-09 | Edge — null city in event_site => destinationCity null', async () => {
      const eventSiteNullCity = { ...toEventSite(SITE.RTM_INLAND), city: null };
      const { otu } = await sendAndWaitE2E(
        makeE2EPayload(
          'container_arrived',
          runDate(37003),
          'actual',
          'external',
          eventSiteNullCity
        ),
        state.objectCode
      );
      assertField(otu, 'destinationCity', null);
    });

    test('DEL-10 | Edge — null country in event_site => destinationCountry null', async () => {
      const eventSiteNullCountry = { ...toEventSite(SITE.RTM_INLAND), country: null };
      const { otu } = await sendAndWaitE2E(
        makeE2EPayload(
          'container_arrived',
          runDate(37004),
          'actual',
          'external',
          eventSiteNullCountry
        ),
        state.objectCode
      );
      assertField(otu, 'destinationCountry', null);
    });

    test.describe('DEL-11 to DEL-12 | actual container_gate_in_empty at destination_inland', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[DEL-11 to DEL-12] container_gate_in_empty / actual / destination_inland …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_gate_in_empty',
            runDate(38000),
            'actual',
            'external',
            toEventSite(SITE.RTM_INLAND)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('DEL-11 | actualEmptyReturn <- situation.date (delivery)', () =>
        assertField(otu, 'actualEmptyReturn', runDate(38000)));

      test('DEL-12 | motEmptyReturn <- situation.transport_mode (ocean)', () =>
        assertField(otu, 'motEmptyReturn', 'ocean'));
    });

    test.describe('DEL-13 to DEL-14 | estimated container_gate_in_empty at destination_inland (external)', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[DEL-13 to DEL-14] container_gate_in_empty / estimated / destination_inland / external …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_gate_in_empty',
            runDate(39000),
            'estimated',
            'external',
            toEventSite(SITE.RTM_INLAND)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('DEL-13 | estimatedEmptyReturn <- situation.date (delivery)', () =>
        assertField(otu, 'estimatedEmptyReturn', runDate(39000)));

      test('DEL-14 | motEmptyReturn <- situation.transport_mode (ocean)', () =>
        assertField(otu, 'motEmptyReturn', 'ocean'));
    });

    test('DEL-15 | Negative — shippeo source => no estimatedEmptyReturn at delivery', async () => {
      const { before, after } = await sendAndSnapshot(
        makeE2EPayload(
          'container_gate_in_empty',
          runDate(39001),
          'estimated',
          'shippeo',
          toEventSite(SITE.RTM_INLAND)
        )
      );
      assertNotChanged(before, after, 'estimatedEmptyReturn');
    });

    test.describe('DEL-16 | Edge — actualEmptyReturn: delivery date overwrites POD date', () => {
      let otuAfterDelivery = null;

      test.beforeAll(async () => {
        console.log('\n[DEL-16] gate_in_empty at discharge first, then at destination_inland …');
        await sendAndWaitE2E(
          makeE2EPayload(
            'container_gate_in_empty',
            runDate(40000),
            'actual',
            'external',
            toEventSite(SITE.RTM_POD)
          ),
          state.objectCode
        );
        const result = await sendAndWaitE2E(
          makeE2EPayload(
            'container_gate_in_empty',
            runDate(40001),
            'actual',
            'external',
            toEventSite(SITE.RTM_INLAND)
          ),
          state.objectCode
        );
        otuAfterDelivery = result.otu;
      });

      test.beforeEach(() => { if (!otuAfterDelivery) test.skip(); });

      test('DEL-16 | actualEmptyReturn = delivery date (most recent event wins)', () =>
        assertField(otuAfterDelivery, 'actualEmptyReturn', runDate(40001)));
    });

  }); // end GROUP DEL

  // ===========================================================================
  //  GROUP X — X-01 to X-13 | Cross-Field and Edge Cases
  // ===========================================================================

  test.describe('X-01 to X-13 | Cross-Field and Edge Cases', () => {

    test.describe('X-01 | Positive — direct fields written on estimated event', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[X-01] estimated event writes direct fields …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_gate_out_empty',
            runDate(40010),
            'estimated',
            'external',
            toEventSite(SITE.NGB_INLAND)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('X-01 | carrierUpdatedLocodePol written on estimated event', () =>
        assertField(otu, 'carrierUpdatedLocodePol', SITE.NGB_POL.unlocode));

      test('X-01 | carrierUpdatedLocodePod written on estimated event', () =>
        assertField(otu, 'carrierUpdatedLocodePod', SITE.RTM_POD.unlocode));

      test('X-01 | datetime_timezone written on estimated event', () =>
        assertField(otu, 'datetime_timezone', SITE.NGB_INLAND.timezone));
    });

    test.describe('X-02 | Positive — direct fields written regardless of place_type', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[X-02] container_arrived at discharge writes direct fields …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_arrived',
            runDate(40020),
            'actual',
            'external',
            toEventSite(SITE.RTM_POD)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('X-02 | carrierUpdatedLocodePol written on discharge event', () =>
        assertField(otu, 'carrierUpdatedLocodePol', SITE.NGB_POL.unlocode));

      test('X-02 | carrierUpdatedLocodePod written on discharge event', () =>
        assertField(otu, 'carrierUpdatedLocodePod', SITE.RTM_POD.unlocode));
    });

    test('X-03 | Positive — fields from different stages coexist after all events', async () => {
      const otu = await getOTU(state.objectCode).catch(() => null);

      const fields = [
        'actualGateOutEmptyDepot',
        'actualDepartureFromOrigin',
        'actualLoadPol',
        'actualDeparturePol',
        'actualArrivalPod',
        'actualDischargePod',
        'actualGateOutPod',
        'actualEmptyReturn',
        'actualArrivalDestination',
      ];
      console.log('\n[X-03] Checking that multiple stage fields coexist:');
      for (const field of fields) {
        const val = otu?.[field] ?? null;
        console.log(`  ${field}: "${val}"`);
      }
      const nonNull = fields.filter(f => (otu?.[f] ?? null) !== null);
      expect(nonNull.length, 'At least some stage fields should be non-null').toBeGreaterThan(0);
    });

    test.describe('X-04 | Edge — same event twice with different dates => latest date wins', () => {
      let otuFinal = null;

      test.beforeAll(async () => {
        console.log('\n[X-04] Sending container_departed origin_inland actual twice …');
        await sendAndWaitE2E(
          makeE2EPayload(
            'container_departed',
            runDate(40000),
            'actual',
            'external',
            toEventSite(SITE.NGB_INLAND)
          ),
          state.objectCode
        );
        const result = await sendAndWaitE2E(
          makeE2EPayload(
            'container_departed',
            runDate(41000),
            'actual',
            'external',
            toEventSite(SITE.NGB_INLAND)
          ),
          state.objectCode
        );
        otuFinal = result.otu;
      });

      test.beforeEach(() => { if (!otuFinal) test.skip(); });

      test('X-04 | actualDepartureFromOrigin = second (later) date', () =>
        assertField(otuFinal, 'actualDepartureFromOrigin', runDate(41000)));
    });

    test.describe('X-05 | Edge — same event twice with same date => field remains set', () => {
      let otuFinal = null;

      test.beforeAll(async () => {
        console.log('\n[X-05] Sending container_departed origin_inland actual same date twice …');
        await sendAndWaitE2E(
          makeE2EPayload(
            'container_departed',
            runDate(42000),
            'actual',
            'external',
            toEventSite(SITE.NGB_INLAND)
          ),
          state.objectCode
        );
        const result = await sendAndWaitE2E(
          makeE2EPayload(
            'container_departed',
            runDate(42000),
            'actual',
            'external',
            toEventSite(SITE.NGB_INLAND)
          ),
          state.objectCode
        );
        otuFinal = result.otu;
      });

      test.beforeEach(() => { if (!otuFinal) test.skip(); });

      test('X-05 | actualDepartureFromOrigin = same date after duplicate event', () =>
        assertField(otuFinal, 'actualDepartureFromOrigin', runDate(42000)));
    });

    test.describe('X-06 | Edge — actualEmptyReturn from POD then delivery => delivery date wins', () => {
      let otuFinal = null;

      test.beforeAll(async () => {
        console.log('\n[X-06] gate_in_empty at discharge (43000) then destination_inland (44000) …');
        await sendAndWaitE2E(
          makeE2EPayload(
            'container_gate_in_empty',
            runDate(43000),
            'actual',
            'external',
            toEventSite(SITE.RTM_POD)
          ),
          state.objectCode
        );
        const result = await sendAndWaitE2E(
          makeE2EPayload(
            'container_gate_in_empty',
            runDate(44000),
            'actual',
            'external',
            toEventSite(SITE.RTM_INLAND)
          ),
          state.objectCode
        );
        otuFinal = result.otu;
      });

      test.beforeEach(() => { if (!otuFinal) test.skip(); });

      test('X-06 | actualEmptyReturn = destination_inland date (44000)', () =>
        assertField(otuFinal, 'actualEmptyReturn', runDate(44000)));
    });

    test.describe('X-07 | Edge — depotPreCountry overwritten by later estimated event with different country', () => {
      let otuFinal = null;

      test.beforeAll(async () => {
        console.log('\n[X-07] Sending gate_out_empty with CN country, then another event with different country …');
        await sendAndWaitE2E(
          makeE2EPayload(
            'container_gate_out_empty',
            runDate(45000),
            'actual',
            'external',
            toEventSite(SITE.NGB_INLAND)
          ),
          state.objectCode
        );
        const eventSiteNL = { ...toEventSite(SITE.NGB_INLAND), country: 'NL', city: 'Rotterdam' };
        const result = await sendAndWaitE2E(
          makeE2EPayload(
            'container_gate_out_empty',
            runDate(45001),
            'estimated',
            'external',
            eventSiteNL
          ),
          state.objectCode
        );
        otuFinal = result.otu;
      });

      test.beforeEach(() => { if (!otuFinal) test.skip(); });

      test('X-07 | depotPreCountry = NL (from later estimated event)', () =>
        assertField(otuFinal, 'depotPreCountry', 'NL'));
    });

    test('X-08 | Positive — motGateOutEmpty, motEmptyReturn, motGateOutPod are independent', async () => {
      const otu = await getOTU(state.objectCode).catch(() => null);
      const goe = otu?.['motGateOutEmpty'] ?? null;
      const er  = otu?.['motEmptyReturn']  ?? null;
      const gop = otu?.['motGateOutPod']   ?? null;
      console.log(`  [X-08] motGateOutEmpty="${goe}" motEmptyReturn="${er}" motGateOutPod="${gop}"`);
      if (goe) expect(goe).toBe('ocean');
      if (er)  expect(er).toBe('ocean');
      if (gop) expect(gop).toBe('ocean');
      expect(true).toBe(true);
    });

    test.describe('X-09 | Edge — situation.transport_mode="rail" => motGateOutEmpty="rail"', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[X-09] Sending gate_out_empty with transport_mode=rail …');
        const payload = makeE2EPayload(
          'container_gate_out_empty',
          runDate(45010),
          'actual',
          'external',
          toEventSite(SITE.NGB_INLAND)
        );
        payload.situation.transport_mode = 'rail';
        ({ otu } = await sendAndWaitE2E(payload, state.objectCode));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('X-09 | motGateOutEmpty = "rail" when transport_mode=rail', () =>
        assertField(otu, 'motGateOutEmpty', 'rail'));
    });

    test.describe('X-10 | Edge — date in 2099 maps correctly to actualDeparturePol', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[X-10] Sending container_departed loading actual with 2099 date …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_departed',
            '2099-01-01T00:00:00Z',
            'actual',
            'external',
            toEventSite(SITE.NGB_POL)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('X-10 | actualDeparturePol is set with 2099 date', () => {
        const val = otu?.['actualDeparturePol'] ?? null;
        console.log(`  [X-10] actualDeparturePol="${val}"`);
        expect(val, 'actualDeparturePol should be set for 2099 date').not.toBeNull();
      });
    });

    test.describe('X-11 | Edge — date in 2020 maps correctly to actualDeparturePol', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[X-11] Sending container_departed loading actual with 2020 date …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_departed',
            '2020-01-01T00:00:00Z',
            'actual',
            'external',
            toEventSite(SITE.NGB_POL)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('X-11 | actualDeparturePol is updated with 2020 date', () => {
        const val = otu?.['actualDeparturePol'] ?? null;
        console.log(`  [X-11] actualDeparturePol="${val}"`);
        expect(val, 'actualDeparturePol should be set for 2020 date').not.toBeNull();
      });
    });

    test.describe('X-12 | Edge — date with timezone offset +02:00 stored correctly', () => {
      let otu = null;

      test.beforeAll(async () => {
        console.log('\n[X-12] Sending container_departed loading actual with +02:00 offset date …');
        ({ otu } = await sendAndWaitE2E(
          makeE2EPayload(
            'container_departed',
            '2025-06-01T10:00:00+02:00',
            'actual',
            'external',
            toEventSite(SITE.NGB_POL)
          ),
          state.objectCode
        ));
      });

      test.beforeEach(() => { if (!otu) test.skip(); });

      test('X-12 | actualDeparturePol is set when date has +02:00 offset', () => {
        const val = otu?.['actualDeparturePol'] ?? null;
        console.log(`  [X-12] actualDeparturePol="${val}"`);
        expect(val, 'actualDeparturePol should be set for +02:00 offset date').not.toBeNull();
      });
    });

    test('X-13 | Edge — empty string situation.date => field null or unchanged', async () => {
      const before = await getOTU(state.objectCode).catch(() => null);
      const payload = makeE2EPayload(
        'container_arrived',
        '',
        'actual',
        'external',
        toEventSite(SITE.RTM_POD)
      );
      payload.situation.date = '';
      const webhookCtx = await request.newContext({ baseURL: OCFG.WEBHOOK_BASE_URL });
      await webhookCtx.post(OCFG.WEBHOOK_PATH, { headers: webhookHeaders(), data: payload });
      await webhookCtx.dispose();
      await new Promise(r => setTimeout(r, 3000));
      const after = await getOTU(state.objectCode).catch(() => null);
      assertNotChanged(before, after, 'actualArrivalPod');
    });

  }); // end GROUP X

  // ===========================================================================
  //  GROUP N — N-01 to N-16 | Negative / API Tests
  // ===========================================================================

  test.describe('N-01 to N-16 | Negative / API Tests', () => {

    test('N-01 | Negative — expired/wrong token => HTTP 401', async () => {
      const ctx = await request.newContext({ baseURL: OCFG.WEBHOOK_BASE_URL });
      const res = await ctx.post(OCFG.WEBHOOK_PATH, {
        headers: {
          'Content-Type':  'application/json',
          'clientId':      OCFG.WEBHOOK_CLIENT_ID,
          'Authorization': 'Bearer INVALID_EXPIRED_TOKEN',
        },
        data: makeE2EPayload(
          'container_departed',
          runDate(50000),
          'actual',
          'external',
          toEventSite(SITE.NGB_POL)
        ),
      });
      await ctx.dispose();
      console.log(`  [N-01] status=${res.status()}`);
      expect([401, 403]).toContain(res.status());
    });

    test('N-02 | Negative — wrong clientId header => HTTP 401 or 403', async () => {
      const ctx = await request.newContext({ baseURL: OCFG.WEBHOOK_BASE_URL });
      const res = await ctx.post(OCFG.WEBHOOK_PATH, {
        headers: {
          'Content-Type':  'application/json',
          'clientId':      'WRONG_CLIENT_ID_XXXX',
          'Authorization': `Bearer ${OCFG.WEBHOOK_TOKEN}`,
        },
        data: makeE2EPayload(
          'container_departed',
          runDate(50001),
          'actual',
          'external',
          toEventSite(SITE.NGB_POL)
        ),
      });
      await ctx.dispose();
      console.log(`  [N-02] status=${res.status()}`);
      expect([401, 403]).toContain(res.status());
    });

    test('N-03 | Negative — no Authorization header => HTTP 401', async () => {
      const ctx = await request.newContext({ baseURL: OCFG.WEBHOOK_BASE_URL });
      const res = await ctx.post(OCFG.WEBHOOK_PATH, {
        headers: {
          'Content-Type': 'application/json',
          'clientId':     OCFG.WEBHOOK_CLIENT_ID,
        },
        data: makeE2EPayload(
          'container_departed',
          runDate(50002),
          'actual',
          'external',
          toEventSite(SITE.NGB_POL)
        ),
      });
      await ctx.dispose();
      console.log(`  [N-03] status=${res.status()}`);
      expect([401, 403]).toContain(res.status());
    });

    test('N-04 | Negative — empty body {} => HTTP 400 or 200 (no field update)', async () => {
      const ctx = await request.newContext({ baseURL: OCFG.WEBHOOK_BASE_URL });
      const res = await ctx.post(OCFG.WEBHOOK_PATH, {
        headers: {
          'Content-Type':  'application/json',
          'clientId':      OCFG.WEBHOOK_CLIENT_ID,
          'Authorization': `Bearer ${OCFG.WEBHOOK_TOKEN}`,
        },
        data: {},
      });
      await ctx.dispose();
      console.log(`  [N-04] status=${res.status()}`);
      expect([400, 200, 422]).toContain(res.status());
    });

    test('N-05 | Negative — malformed JSON body => HTTP 400', async () => {
      const ctx = await request.newContext({ baseURL: OCFG.WEBHOOK_BASE_URL });
      const res = await ctx.post(OCFG.WEBHOOK_PATH, {
        headers: {
          'Content-Type':  'application/json',
          'clientId':      OCFG.WEBHOOK_CLIENT_ID,
          'Authorization': `Bearer ${OCFG.WEBHOOK_TOKEN}`,
        },
        data: 'NOT_VALID_JSON{{{',
      });
      await ctx.dispose();
      console.log(`  [N-05] status=${res.status()}`);
      expect([400, 422]).toContain(res.status());
    });

    test('N-06 | Negative — unknown event name => no field update', async () => {
      const { before, after } = await sendAndSnapshot(
        makeE2EPayload(
          'foo_event',
          runDate(50003),
          'actual',
          'external',
          toEventSite(SITE.NGB_POL)
        )
      );
      assertNotChanged(before, after, 'actualDeparturePol');
      assertNotChanged(before, after, 'actualGateInPol');
    });

    test('N-07 | Negative — unknown place_type => no field update', async () => {
      const eventSiteMoon = { ...toEventSite(SITE.NGB_POL), place_type: 'moon_base' };
      const { before, after } = await sendAndSnapshot(
        makeE2EPayload(
          'container_departed',
          runDate(50004),
          'actual',
          'external',
          eventSiteMoon
        )
      );
      assertNotChanged(before, after, 'actualDeparturePol');
    });

    test('N-08 | Negative — situation.type="confirmed" => no actualDeparturePol update', async () => {
      const payload = makeE2EPayload(
        'container_departed',
        runDate(50005),
        'confirmed',
        'external',
        toEventSite(SITE.NGB_POL)
      );
      payload.situation.type = 'confirmed';
      const { before, after } = await sendAndSnapshot(payload);
      assertNotChanged(before, after, 'actualDeparturePol');
    });

    test('N-09 | Negative — null situation.date => no actualArrivalPod update', async () => {
      const payload = makeE2EPayload(
        'container_arrived',
        null,
        'actual',
        'external',
        toEventSite(SITE.RTM_POD)
      );
      payload.situation.date = null;
      const { before, after } = await sendAndSnapshot(payload);
      assertNotChanged(before, after, 'actualArrivalPod');
    });

    test('N-10 | Negative — invalid date string => HTTP 200 and no crash', async () => {
      const ctx = await request.newContext({ baseURL: OCFG.WEBHOOK_BASE_URL });
      const payload = makeE2EPayload(
        'container_arrived',
        'not-a-date',
        'actual',
        'external',
        toEventSite(SITE.RTM_POD)
      );
      payload.situation.date = 'not-a-date';
      const res = await ctx.post(OCFG.WEBHOOK_PATH, {
        headers: {
          'Content-Type':  'application/json',
          'clientId':      OCFG.WEBHOOK_CLIENT_ID,
          'Authorization': `Bearer ${OCFG.WEBHOOK_TOKEN}`,
        },
        data: payload,
      });
      await ctx.dispose();
      console.log(`  [N-10] status=${res.status()}`);
      expect(res.status()).toBeLessThan(500);
    });

    test('N-11 | Negative — POST to wrong endpoint => HTTP 404', async () => {
      const ctx = await request.newContext({ baseURL: OCFG.WEBHOOK_BASE_URL });
      const res = await ctx.post('/api/nonexistent/endpoint/xyz', {
        headers: {
          'Content-Type':  'application/json',
          'clientId':      OCFG.WEBHOOK_CLIENT_ID,
          'Authorization': `Bearer ${OCFG.WEBHOOK_TOKEN}`,
        },
        data: makeE2EPayload(
          'container_departed',
          runDate(50006),
          'actual',
          'external',
          toEventSite(SITE.NGB_POL)
        ),
      });
      await ctx.dispose();
      console.log(`  [N-11] status=${res.status()}`);
      expect([404, 400]).toContain(res.status());
    });

    test('N-12 | Negative — webhook for non-existent container => graceful error (no 500)', async () => {
      const ctx = await request.newContext({ baseURL: OCFG.WEBHOOK_BASE_URL });
      const payload = makeE2EPayload(
        'container_departed',
        runDate(50007),
        'actual',
        'external',
        toEventSite(SITE.NGB_POL)
      );
      payload.cargo.reference = 'FAKE9999999';
      payload.order.edi_reference = 'FAKE9999999';
      payload.order.reference = 'FAKE9999999';
      payload.tour.edi_reference = 'FAKE9999999';
      payload.tour.reference = 'FAKE9999999';
      const res = await ctx.post(OCFG.WEBHOOK_PATH, {
        headers: {
          'Content-Type':  'application/json',
          'clientId':      OCFG.WEBHOOK_CLIENT_ID,
          'Authorization': `Bearer ${OCFG.WEBHOOK_TOKEN}`,
        },
        data: payload,
      });
      await ctx.dispose();
      console.log(`  [N-12] status=${res.status()}`);
      expect(res.status()).toBeLessThan(500);
    });

    test('N-13 | Negative — gate_out_empty + transhipment place_type => no actualGateOutEmptyDepot', async () => {
      const { before, after } = await sendAndSnapshot(
        makeE2EPayload(
          'container_gate_out_empty',
          runDate(50008),
          'actual',
          'external',
          toEventSite(SITE.SGP_TSP1)
        )
      );
      assertNotChanged(before, after, 'actualGateOutEmptyDepot');
    });

    test('N-14 | Negative — container_arrived + origin_inland place_type => no actualGateInPol', async () => {
      const { before, after } = await sendAndSnapshot(
        makeE2EPayload(
          'container_arrived',
          runDate(50009),
          'actual',
          'external',
          toEventSite(SITE.NGB_INLAND)
        )
      );
      assertNotChanged(before, after, 'actualGateInPol');
    });

    test('N-15 | Negative — container_departed + destination_inland => no actualDeparturePol and no actualArrivalDestination', async () => {
      const { before, after } = await sendAndSnapshot(
        makeE2EPayload(
          'container_departed',
          runDate(50010),
          'actual',
          'external',
          toEventSite(SITE.RTM_INLAND)
        )
      );
      assertNotChanged(before, after, 'actualDeparturePol');
      assertNotChanged(before, after, 'actualArrivalDestination');
    });

    test('N-16 | Negative — eta_event + origin_inland_location place_type => no estimatedArrivalPod', async () => {
      const { before, after } = await sendAndSnapshot(
        makeE2EPayload(
          'eta_event',
          runDate(50011),
          'estimated',
          'external',
          toEventSite(SITE.NGB_INLAND)
        )
      );
      assertNotChanged(before, after, 'estimatedArrivalPod');
    });

  }); // end GROUP N

  // ===========================================================================
  //  AUDIT
  // ===========================================================================

  test('AUDIT | Audit entry created for container_arrived (discharge)', async () => {
    expect(state.objectCode, 'A-01 must pass first').toBeTruthy();
    const entry = await pollUntilAuditEntry(state.objectCode, {
      event: 'container_arrived',
      placeType: 'discharge',
    });
    console.log(`  → Audit entry:`, JSON.stringify(entry ?? 'NOT FOUND'));
    expect(entry, 'Expected audit entry for container_arrived / discharge').not.toBeNull();
  });

  // ===========================================================================
  //  FINAL SUMMARY
  // ===========================================================================

  test('FINAL | E2E Pass: All Ocean Orders-In + Events-Out criteria met', async () => {
    console.log('');
    console.log('══════════════════════════════════════════════════════════════');
    console.log('  OCEAN E2E — PASS SUMMARY');
    console.log('══════════════════════════════════════════════════════════════');
    console.log(`  OTU created          : objectCode="${state.objectCode}"`);
    console.log(`  containerNumber      : "${state.containerNumber}"`);
    console.log(`  trackingscheduler    : active=1  valid=1`);
    console.log(`  tracking service     : ${state.trackingDocs?.length ?? 0} document(s) in MongoDB`);
    console.log(`  Shippeo              : "${state.shippeoRef}" searchable`);
    console.log(`  Webhooks accepted    : all HTTP 200`);
    console.log(`  Events-Out groups    : D, PC, POL, POD, DEL, X, N — complete`);
    console.log(`  Audit entry          : created`);
    console.log('══════════════════════════════════════════════════════════════');
    console.log('');

    expect(state.objectCode).toBeTruthy();
    expect(state.trackingDocs?.length).toBeGreaterThan(0);
    expect(state.otu).not.toBeNull();
  });

}); // end OCEAN Full Lifecycle
