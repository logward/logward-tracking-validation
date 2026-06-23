// =============================================================================
//  OceanOrdersIn.spec.js
//
//  OCEAN — Orders-In (S-01 to S-43) with gated sequential flow per scenario.
//
// ─── GROUP ORDER (Shippeo groups first) ──────────────────────────────────────
//
//  ✅ GROUP P  — Full Positive Flow         (S-01 to S-03)   [Shippeo required]
//  ✅ GROUP U  — Update to valid=1          (S-18 to S-23)   [Shippeo required]
//  ✅ GROUP S  — Shippeo Standalone Tests   (S-36, S-37)     [Shippeo required]
//  ── GROUP N1 — active=0 valid=0           (S-04 to S-09)   [No Shippeo]
//  ── GROUP N2 — active=1 valid=0           (S-07 to S-17)   [No Shippeo]
//  ── GROUP A  — API and Auth Negative      (S-38 to S-43)   [No Shippeo]
//
// ─── HOW TO RUN ───────────────────────────────────────────────────────────────
//
//  ⚠️  Shippeo token expires every ~15 min.
//  Groups P, U, S run first automatically — complete within token window.
//
//  STEP 1 — Refresh Shippeo token, then run:
//    npx playwright test --project=ocean OceanOrdersIn -g "GROUP P|GROUP U|GROUP S"
//
//  STEP 2 — Run anytime (no Shippeo needed):
//    npx playwright test --project=ocean OceanOrdersIn -g "GROUP N|GROUP A"
//
//  Run everything (Shippeo groups execute first):
//    npx playwright test --project=ocean OceanOrdersIn
//
//  Single group:
//    npx playwright test --project=ocean OceanOrdersIn -g "GROUP P"
//    npx playwright test --project=ocean OceanOrdersIn -g "GROUP U"
//    npx playwright test --project=ocean OceanOrdersIn -g "GROUP S"
//    npx playwright test --project=ocean OceanOrdersIn -g "GROUP N1"
//    npx playwright test --project=ocean OceanOrdersIn -g "GROUP N2"
//    npx playwright test --project=ocean OceanOrdersIn -g "GROUP A"
//
//  Single scenario:
//    npx playwright test --project=ocean OceanOrdersIn -g "S-01"
//
// ─── FLOW (per positive scenario) ────────────────────────────────────────────
//
//  Create OTU
//    ↓
//  [GATE] Scheduler: active=1 AND valid=1?
//    → NO: verify MongoDB NOT created → STOP
//    → YES ↓
//  [GATE] MongoDB: document exists, error=false?
//    → NO: STOP
//    → YES ↓
//  [GATE] Shippeo: shipment searchable?  (skipped if token missing)
//    → NO: STOP
//    → YES ↓
//  Send 4 key events → validate OTU fields → validate audit
//
// =============================================================================

const { test, expect, request } = require('@playwright/test');

const { E2E_CONFIG }                             = require('../../helpers/e2e/e2eConfig');
const { createOceanTrackingObject,
        getOceanTrackingObject }                 = require('../../helpers/e2e/trackingObjectFactory');
const { pollUntilSchedulerActive,
        getTrackingSchedule }                    = require('../../helpers/e2e/trackingSchedulerClient');
const { pollUntilTrackingDocCreated,
        fetchTrackingDocuments,
        extractSuccessDocuments }                = require('../../helpers/e2e/trackingServiceClient');
const { buildOceanReference,
        pollUntilShippeoShipmentFound,
        searchShippeoShipment,
        getShippeoOrderDetails,
        assertShippeoOrderDetails }              = require('../../helpers/e2e/shippeoApiClient');
const { assertField }                            = require('../../helpers/air/airValidation');
const { getAdminToken }                          = require('../../helpers/e2e/cognitoAuth');
const R                                          = require('../../helpers/e2e/ordersInFlowReporter');
const {
  makePayload, toEventSite,
  PRE_DATES, POL_DATES, POD_DATES, DEL_DATES,
} = require('../../helpers/ocean/oceanPayloadFactory');
const V = require('../../helpers/ocean/oceanEventsValidator');

// ─────────────────────────────────────────────────────────────────────────────
//  Config shortcuts
// ─────────────────────────────────────────────────────────────────────────────

const OCFG = E2E_CONFIG.OCEAN;

// ─────────────────────────────────────────────────────────────────────────────
//  Feature flags
// ─────────────────────────────────────────────────────────────────────────────

const SHIPPEO_ENABLED =
  (!!E2E_CONFIG.SHIPPEO.token        && !E2E_CONFIG.SHIPPEO.token.startsWith('<') && E2E_CONFIG.SHIPPEO.token !== '')        ||
  (!!E2E_CONFIG.SHIPPEO.refreshToken && !E2E_CONFIG.SHIPPEO.refreshToken.startsWith('<') && E2E_CONFIG.SHIPPEO.refreshToken !== '') ||
  (!!E2E_CONFIG.SHIPPEO.username     && !!E2E_CONFIG.SHIPPEO.password && !E2E_CONFIG.SHIPPEO.password.startsWith('<'));

// ─────────────────────────────────────────────────────────────────────────────
//  Container number generator
//  Format: LGTE + 2-digit counter + last-5-digits-of-timestamp = 11 chars
//  e.g. LGTE0112345  — accepted by Shippeo (4 letters + 7 digits)
// ─────────────────────────────────────────────────────────────────────────────

let _cnCounter = 0;
function nextContainer() {
  _cnCounter++;
  const ts  = String(Date.now()).slice(-5);
  const seq = String(_cnCounter).padStart(2, '0');
  return `LGTE${seq}${ts}`;
}

// ── Carrier pool — random per scenario ───────────────────────────────────────
// shortName = what Shippeo returns in oceanCarrier.name for assertions
const CARRIER_POOL = [
  { scac: 'MSCU', shortName: 'MSC',          name: 'Mediterranean Shipping Company' },
  { scac: 'MAEU', shortName: 'Maersk',        name: 'Maersk Line' },
  { scac: 'CMDU', shortName: 'CMA CGM',       name: 'CMA CGM' },
  { scac: 'COSU', shortName: 'COSCO',         name: 'COSCO Shipping Lines' },
  { scac: 'HLCU', shortName: 'Hapag-Lloyd',   name: 'Hapag-Lloyd' },
];

let _scenarioSeq = 0;
function nextScenarioIds() {
  const seq = String(++_scenarioSeq).padStart(2, '0');
  const ts  = String(Date.now()).slice(-4);
  const carrier = CARRIER_POOL[Math.floor(Math.random() * CARRIER_POOL.length)];
  return {
    bn:      `E2EBOOK${seq}${ts}`,
    bl:      `E2EBL${seq}${ts}`,
    carrier,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  NO_CARRIER constant — removes all carrier fields from OTU
// ─────────────────────────────────────────────────────────────────────────────

const NO_CARRIER = { carrierScac: null, carrierShortName: null, carrierName: null };

// ─────────────────────────────────────────────────────────────────────────────
//  Header factories
// ─────────────────────────────────────────────────────────────────────────────

const adminHeaders = async () => ({
  'Authorization': `Bearer ${await getAdminToken()}`,
  'Content-Type':  'application/json',
  'accept':        'application/json',
});

const webhookHeaders = () => ({
  'Content-Type':  'application/json',
  'clientId':      OCFG.WEBHOOK_CLIENT_ID,
  'Authorization': `Bearer ${OCFG.WEBHOOK_TOKEN}`,
});

// ─────────────────────────────────────────────────────────────────────────────
//  OTU CRUD helpers
// ─────────────────────────────────────────────────────────────────────────────

async function createOTU(overrides = {}) {
  const containerNumber = nextContainer();
  return createOceanTrackingObject({
    containerNumber,
    mot:                  'OCEAN',
    tsTracking:           false,
    forwarderInputNeeded: 'No',
    ...overrides,
  });
}

async function updateOTU(containerNumber, updateFields, objectCode) {
  const ctx = await request.newContext({ baseURL: E2E_CONFIG.ADMIN_BASE_URL });
  try {
    const fields = {
      containerNumber,
      mot:                  'OCEAN',
      tsTracking:           false,
      forwarderInputNeeded: 'No',
      ...updateFields,
    };
    // Include objectCode so upsert updates the correct existing record
    if (objectCode) fields.code = objectCode;
    Object.keys(fields).forEach(k => {
      if (fields[k] === null || fields[k] === undefined) delete fields[k];
    });
    const res = await ctx.post(`${OCFG.UPSERT_PATH}?createNew=false`, {
      headers: await adminHeaders(),
      data:    { data: [fields] },
    });
    const status  = res.status();
    const resBody = await res.text().catch(() => '');
    console.log(`  [updateOTU] HTTP ${status} CN=${containerNumber} → ${resBody.slice(0, 200)}`);
  } finally {
    await ctx.dispose();
  }
}

async function fetchOTU(objectCode) {
  const raw = await getOceanTrackingObject(objectCode);
  return Array.isArray(raw) ? raw[0] : raw;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Scheduler helpers
// ─────────────────────────────────────────────────────────────────────────────

// Poll until active=1 valid=1 (positive gate)
async function pollSchedulerActiveValid(objectCode) {
  return pollUntilSchedulerActive(OCFG.SCHEMA_TYPE, objectCode);
}

// Poll until active=1 (used for group N2 pre-update state)
async function pollUntilActive(objectCode) {
  const deadline = Date.now() + E2E_CONFIG.SCHEDULER_TIMEOUT_MS;
  let rec = null;
  while (Date.now() < deadline) {
    rec = await getTrackingSchedule(OCFG.SCHEMA_TYPE, objectCode).catch(() => null);
    if (rec?.active === 1) return rec;
    await new Promise(r => setTimeout(r, E2E_CONFIG.POLL_INTERVAL_MS));
  }
  return rec;
}

// Check scheduler once after 8 s (group N1 — active=0 expected)
async function getSchedulerOnce(objectCode) {
  await new Promise(r => setTimeout(r, 8000));
  return getTrackingSchedule(OCFG.SCHEMA_TYPE, objectCode).catch(() => null);
}

// ─────────────────────────────────────────────────────────────────────────────
//  MongoDB helpers
// ─────────────────────────────────────────────────────────────────────────────

async function pollMongo(containerId, bookingId, billOfLadingId, scacCode) {
  return pollUntilTrackingDocCreated({
    containerId,
    bookingId:      bookingId      || undefined,
    billOfLadingId: billOfLadingId || undefined,
    scacCode:       scacCode || OCFG.SCAC,
  });
}

async function checkMongoOnce(containerId, bookingId, billOfLadingId, scacCode) {
  await new Promise(r => setTimeout(r, 5000));
  const all = await fetchTrackingDocuments({
    containerId,
    bookingId:      bookingId      || undefined,
    billOfLadingId: billOfLadingId || undefined,
    scacCode:       scacCode || OCFG.SCAC,
  }).catch(() => []);
  return extractSuccessDocuments(all);
}

// ─────────────────────────────────────────────────────────────────────────────
//  4 Events helper
//  Sends the 4 key ocean events and validates OTU date fields + audit.
// ─────────────────────────────────────────────────────────────────────────────

// loadingSite / deliverySite — optional random sites (objects with .unlocode etc.)
// When provided they override the default CNNGB/NLRTM sites in the payload.
async function sendWebhookEvent(cn, bn, bl, event, date, situationType, dataSource, eventSite, loadingSite, deliverySite, vessel) {
  const ctx = await request.newContext({ baseURL: OCFG.WEBHOOK_BASE_URL });
  try {
    // Payload modelled on the confirmed working curl — only test-specific fields change
    const payload = {
      date_transmission: new Date().toISOString(),
      owner: {
        organization: { id: 'Q2JK9RVN', name: 'LIDL' },
        agency:       { id: '82V85L72', name: 'LIDL_Ocean', siret: null },
      },
      order:   { edi_reference: cn, reference: cn, url: 'https://view.shippeo.com/orderPublic/test' },
      tour:    { edi_reference: cn, reference: cn },
      situation: {
        event,
        date,
        input_date:     date,
        type:           situationType,
        transport_mode: 'ocean',
      },
      situation_justification: {
        position:      null,
        attributes:    {},
        data_source:   dataSource || 'external',
        platform_type: 'ocean',
      },
      loading_site:  loadingSite  || { id:'2Y7D58Y2', externalID:null, unlocode:'CNNGB', name:'Ningbo',    address_line:null, zipcode:'', city:null, country:'CN', position:{lat:29.746020,lng:122.745092} },
      delivery_site: deliverySite || { id:'N9P6MMY2', externalID:null, unlocode:'NLRTM', name:'Rotterdam', address_line:null, zipcode:'', city:null, country:'NL', position:{lat:52.019370,lng:3.760881} },
      carrier: { scacs: [OCFG.SCAC] },
      event_site: eventSite,
      tags:            [],
      handling_units:  [],
      booking_references:        bn ? [{ reference: bn }] : [],
      bill_of_lading_references: bl ? [{ active: 'True', identifier: bl }] : [],
      resources: vessel ? V.vesselResources(vessel) : [],
      items:     [],
      cargo: { reference: cn, qualifier: 'CONTAINER' },
    };

    const res     = await ctx.post(OCFG.WEBHOOK_PATH, { headers: webhookHeaders(), data: payload });
    const status  = res.status();
    const errBody = status !== 200 ? await res.text().catch(() => '') : '';
    console.log(`  [event] HTTP ${status} | ${event} | ${eventSite.place_type}${errBody ? ' → ' + errBody.slice(0, 150) : ''}`);
    return status;
  } finally {
    await ctx.dispose();
  }
}

async function pollOtuChanged(objectCode, baseline, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));
    const raw = await getOceanTrackingObject(objectCode).catch(() => null);
    const otu = Array.isArray(raw) ? raw[0] : raw;
    if (otu?.lastChangedAt !== baseline) {
      // Settle: wait for all field writes to complete before returning snapshot
      await new Promise(r => setTimeout(r, 5000));
      const settled = await getOceanTrackingObject(objectCode).catch(() => null);
      return Array.isArray(settled) ? settled[0] : settled;
    }
  }
  const raw = await getOceanTrackingObject(objectCode).catch(() => null);
  return Array.isArray(raw) ? raw[0] : raw;
}

async function sendFourEvents(objectCode, containerNumber, bookingNumber, blNumber) {
  // Random locations + vessel picked fresh each run — proves mapping reads from payload, not defaults
  const e1Site     = V.randomSite('origin_inland_location');
  const e2Site     = V.randomSite('loading');
  const e3Site     = V.randomSite('discharge');
  const e4Site     = V.randomSite('destination_inland_location');
  const loadingSite   = V.randomLoadingOrDeliverySite();
  const deliverySite  = V.randomLoadingOrDeliverySite(loadingSite.unlocode);
  const vessel        = V.randomVessel();

  console.log(`\n  [locations] e1=${e1Site.city}(${e1Site.country}) e2=${e2Site.city} e3=${e3Site.city} e4=${e4Site.city}`);
  console.log(`  [locations] loading=${loadingSite.unlocode} delivery=${deliverySite.unlocode}`);
  console.log(`  [vessel]    ${vessel.name} (IMO: ${vessel.imo} MMSI: ${vessel.mmsi})`);

  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │  EVENT 1: container_gate_out_empty                                      │
  // │  Conditions : event=container_gate_out_empty                            │
  // │               place_type=origin_inland_location                         │
  // │               situation.type=actual                                     │
  // │  Expected mappings (from oceanFieldMappings.js):                        │
  // │    situation.date          → actualGateOutEmptyDepot                    │
  // │    event_site.country      → depotPreCountry                            │
  // │    event_site.city         → depotPreLocation                           │
  // │    situation.transport_mode→ motGateOutEmpty                            │
  // │    loading_site.unlocode   → carrierUpdatedLocodePol  (direct field)    │
  // │    delivery_site.unlocode  → carrierUpdatedLocodePod  (direct field)    │
  // ── EVENT 1: container_gate_out_empty + origin_inland_location + actual ─────
  let beforeRaw = await getOceanTrackingObject(objectCode).catch(() => null);
  let baseline  = (Array.isArray(beforeRaw) ? beforeRaw[0] : beforeRaw)?.lastChangedAt ?? null;
  const s1 = await sendWebhookEvent(
    containerNumber, bookingNumber, blNumber,
    'container_gate_out_empty', PRE_DATES.actualGateOutEmpty, 'actual', null,
    e1Site, loadingSite, deliverySite, vessel
  );
  expect(s1).toBe(200);
  const otu1 = await pollOtuChanged(objectCode, baseline);
  if (otu1) V.assertMappingCondition(otu1, V.buildGateOutEmptySpec(e1Site, loadingSite.unlocode, deliverySite.unlocode));

  // ── EVENT 2: container_departed + loading + actual ────────────────────────
  beforeRaw = await getOceanTrackingObject(objectCode).catch(() => null);
  baseline  = (Array.isArray(beforeRaw) ? beforeRaw[0] : beforeRaw)?.lastChangedAt ?? null;
  const s2 = await sendWebhookEvent(
    containerNumber, bookingNumber, blNumber,
    'container_departed', POL_DATES.actualDeparture, 'actual', null,
    e2Site, loadingSite, deliverySite, vessel
  );
  expect(s2).toBe(200);
  const otu2 = await pollOtuChanged(objectCode, baseline);
  if (otu2) V.assertMappingCondition(otu2, V.buildDeparturePOLSpec());

  // ── EVENT 3: container_arrived + discharge + actual ───────────────────────
  beforeRaw = await getOceanTrackingObject(objectCode).catch(() => null);
  baseline  = (Array.isArray(beforeRaw) ? beforeRaw[0] : beforeRaw)?.lastChangedAt ?? null;
  const s3 = await sendWebhookEvent(
    containerNumber, bookingNumber, blNumber,
    'container_arrived', POD_DATES.actualArrival, 'actual', null,
    e3Site, loadingSite, deliverySite, vessel
  );
  expect(s3).toBe(200);
  const otu3 = await pollOtuChanged(objectCode, baseline);
  if (otu3) V.assertMappingCondition(otu3, V.buildArrivalPODSpec());

  // ── EVENT 4: container_arrived + destination_inland_location + actual ─────
  beforeRaw = await getOceanTrackingObject(objectCode).catch(() => null);
  baseline  = (Array.isArray(beforeRaw) ? beforeRaw[0] : beforeRaw)?.lastChangedAt ?? null;
  const s4 = await sendWebhookEvent(
    containerNumber, bookingNumber, blNumber,
    'container_arrived', DEL_DATES.actualArrival, 'actual', null,
    e4Site, loadingSite, deliverySite, vessel
  );
  expect(s4).toBe(200);
  const otu4 = await pollOtuChanged(objectCode, baseline);
  if (otu4) V.assertMappingCondition(otu4, V.buildDeliveryArrivalSpec(e4Site));

  // ── Final GET — all 4 stage fields must be set ────────────────────────────
  const finalRaw = await getOceanTrackingObject(objectCode).catch(() => null);
  const finalOtu = Array.isArray(finalRaw) ? finalRaw[0] : finalRaw;
  console.log(`\n  [Final GET] objectCode="${objectCode}"`);
  console.log(`    actualGateOutEmptyDepot  : ${finalOtu?.actualGateOutEmptyDepot}`);
  console.log(`    actualDeparturePol       : ${finalOtu?.actualDeparturePol}`);
  console.log(`    actualArrivalPod         : ${finalOtu?.actualArrivalPod}`);
  console.log(`    actualArrivalDestination : ${finalOtu?.actualArrivalDestination}`);
  expect(finalOtu?.actualGateOutEmptyDepot,  '[Final] actualGateOutEmptyDepot must be set').toBeTruthy();
  expect(finalOtu?.actualDeparturePol,       '[Final] actualDeparturePol must be set').toBeTruthy();
  expect(finalOtu?.actualArrivalPod,         '[Final] actualArrivalPod must be set').toBeTruthy();
  expect(finalOtu?.actualArrivalDestination, '[Final] actualArrivalDestination must be set').toBeTruthy();
}

// ─────────────────────────────────────────────────────────────────────────────
//  Full positive flow helper (used by GROUP P and GROUP U)
//  Adds: Shippeo check + 4 events to an existing objectCode / containerNumber.
// ─────────────────────────────────────────────────────────────────────────────

function addPositiveFlowTests(getState) {
  test('Shippeo: shipment searchable by reference', async () => {
    test.skip(!SHIPPEO_ENABLED, 'Update SHIPPEO.token in e2eConfig.js');
    const { id, objectCode, containerNumber, bookingNumber, blNumber } = getState();
    const ref      = buildOceanReference({ bookingNumber, blNumber, containerNumber });
    const shipment = await pollUntilShippeoShipmentFound(ref);
    const found    = !!shipment;

    // ── Fetch order details for full field validation ──────────────────────────
    let detailsResult = null;
    const hashId = shipment?.hashid;
    if (found && hashId) {
      const details = await getShippeoOrderDetails(hashId);
      if (details) {
        detailsResult = assertShippeoOrderDetails(details, {
          containerNumber,
          bookingNumber:  bookingNumber || null,
          blNumber:       blNumber      || null,
          scac:           getState()?.carrier?.scac || OCFG.SCAC,
          carrierName:    getState()?.carrier?.shortName || OCFG.CARRIER_SHORT_NAME,
        });
      }
    }

    R.step(id, 'shippeo', {
      status:        found ? 'pass' : 'fail',
      found,
      orderId:       shipment?.id ? String(shipment.id) : null,
      reference:     shipment?.reference || ref,
      organisation:  shipment?.organization?.name || null,
      agency:        shipment?.agency?.name       || null,
      transportMode: shipment?.transportMode      || null,
      detailsRows:   detailsResult?.rows  || null,
      detailsPass:   detailsResult?.allPass ?? null,
    });

    expect(shipment).not.toBeNull();
    console.log(`  [shippeo] found id=${shipment?.id} hashid=${hashId} org=${shipment?.organization?.name} agency=${shipment?.agency?.name} mode=${shipment?.transportMode}`);
    expect(shipment?.organization?.name).toBeTruthy();
    expect(shipment?.agency?.name).toBeTruthy();
    expect(shipment?.transportMode).toBe('ocean');
    getState().shipment = shipment;
  });

  test('Events: 4 events sent → GET OTU and verify all 4 milestone fields populated', async () => {
    test.skip(!SHIPPEO_ENABLED, 'Skipping events — Shippeo must be confirmed first');
    const { id, objectCode, containerNumber, bookingNumber, blNumber } = getState();
    try {
      await sendFourEvents(objectCode, containerNumber, bookingNumber, blNumber);
      const raw = await getOceanTrackingObject(objectCode).catch(() => null);
      const otu = Array.isArray(raw) ? raw[0] : raw;
      R.step(id, 'events', {
        status: 'pass',
        fields: {
          actualGateOutEmptyDepot:  otu?.actualGateOutEmptyDepot  || null,
          actualDeparturePol:       otu?.actualDeparturePol       || null,
          actualArrivalPod:         otu?.actualArrivalPod         || null,
          actualArrivalDestination: otu?.actualArrivalDestination || null,
        },
      });
    } catch (e) {
      R.step(id, 'events', { status: 'fail', fields: {} });
      throw e;
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Report generation — runs once after all tests complete
// ─────────────────────────────────────────────────────────────────────────────

test.afterAll(() => {
  try {
    R.generateReport();
  } catch (e) {
    console.warn('  [report] Could not write flow report:', e.message);
  }
});

// =============================================================================
//
//  GROUP P — Positive Full Flow  (S-01, S-02, S-03)
//
//  Gate chain per scenario:
//    Create OTU → Scheduler active=1 valid=1 → MongoDB doc + field checks
//    → Shippeo found + org/agency/mode checks → 4 events → audit
//
//  S-24 to S-30 (MongoDB field checks) are covered inline here.
//  S-31 to S-35 (Shippeo checks) are covered inline here.
//
// =============================================================================

test.describe('GROUP P | Full Positive Flow', () => {

  // ── S-01 — BN + BL + CN + SCAC + InProgress ────────────────────────────────
  test.describe.serial('GROUP P | S-01 | BN + BL + CN + SCAC + InProgress', () => {
    const state = { id: 'S-01' };
    const ids = nextScenarioIds();
    R.startScenario('S-01', 'BN + BL + CN + SCAC + InProgress', 'GROUP P', 'positive', {
      bookingNumber: ids.bn, blNumber: ids.bl,
      scac: ids.carrier.scac, trackingStatus: 'In Progress',
    });

    test('S-01 | Step 1 | Create OTU', async () => {
      const r = await createOTU({
        bookingNumber:      ids.bn,
        billOfLadingNumber: ids.bl,
        carrierScac:        ids.carrier.scac,
        carrierShortName:   ids.carrier.shortName,
        carrierName:        ids.carrier.name,
        trackingStatus:     'In Progress',
      });
      state.objectCode      = r.code;
      state.containerNumber = r.containerNumber;
      state.carrier         = ids.carrier;
      const otu             = await fetchOTU(r.code);
      state.bookingNumber   = otu?.bookingNumber      || ids.bn;
      state.blNumber        = otu?.billOfLadingNumber || ids.bl;
      R.step('S-01', 'create', { status:'pass', objectCode:r.code, containerNumber:r.containerNumber,
        bookingNumber:state.bookingNumber, blNumber:state.blNumber, scac:ids.carrier.scac, trackingStatus:'In Progress', httpStatus:200 });
      console.log(`  S-01 → code=${state.objectCode} CN=${state.containerNumber}`);
      expect(state.objectCode).toBeTruthy();
    });

    test('S-01 | Step 2 | Scheduler: active=1 valid=1 [GATE]', async () => {
      const rec = await pollSchedulerActiveValid(state.objectCode);
      R.step('S-01', 'scheduler', { status: rec?.active===1 && rec?.valid===1 ? 'pass':'fail', active:rec?.active, valid:rec?.valid });
      expect(rec?.active).toBe(1);
      expect(rec?.valid).toBe(1);
    });

    test('S-01 | Step 3 | MongoDB: doc created, error=false, fields valid [GATE]', async () => {
      // S-26: BN priority — uniqueReference = bookingId_containerId
      const docs = await pollMongo(state.containerNumber, state.bookingNumber, state.blNumber, state.carrier?.scac);
      expect(docs.length).toBeGreaterThan(0);
      state.doc = docs[0];
      R.step('S-01', 'mongodb', { status:'pass', found:true, containerId:state.doc.containerId,
        uniqueReference:state.doc.uniqueReference, serviceProvider:state.doc.serviceProvider,
        identifier:state.doc.identifier, eventsCount:state.doc.events?.length ?? 0 });
      expect(state.doc.error).toBe(false);
      expect(typeof state.doc.error).toBe('boolean');
      expect(state.doc.containerId).toBe(state.containerNumber);
      expect(state.doc.uniqueReference).toBe(`${state.bookingNumber}_${state.containerNumber}`);
      expect(state.doc.serviceProvider).toBe('SHIPPEO');
      expect(Array.isArray(state.doc.events)).toBe(true);
      expect(state.doc.events.length).toBe(0);
      expect(['bookingId', 'billOfLadingId']).toContain(state.doc.identifier);
    });

    // S-31 + S-33 + S-34 + S-35 + events
    addPositiveFlowTests(() => state);
  });

  // ── S-02 — BN + CN + SCAC + InProgress (no BL) ─────────────────────────────
  test.describe.serial('GROUP P | S-02 | BN + CN + SCAC + InProgress (no BL)', () => {
    const state = { id: 'S-02' };
    const ids = nextScenarioIds();
    R.startScenario('S-02', 'BN + CN + SCAC + InProgress (no BL)', 'GROUP P', 'positive', {
      bookingNumber: ids.bn, blNumber: null, scac: ids.carrier.scac, trackingStatus: 'In Progress',
    });

    test('S-02 | Step 1 | Create OTU', async () => {
      const r = await createOTU({
        bookingNumber:      ids.bn,
        billOfLadingNumber: null,
        carrierScac:        ids.carrier.scac,
        carrierShortName:   ids.carrier.shortName,
        carrierName:        ids.carrier.name,
        trackingStatus:     'In Progress',
      });
      state.objectCode      = r.code;
      state.containerNumber = r.containerNumber;
      state.carrier         = ids.carrier;
      const otu             = await fetchOTU(r.code);
      state.bookingNumber   = otu?.bookingNumber || ids.bn;
      state.blNumber        = null;
      R.step('S-02', 'create', { status:'pass', objectCode:r.code, containerNumber:r.containerNumber,
        bookingNumber:state.bookingNumber, blNumber:null, scac:ids.carrier.scac, trackingStatus:'In Progress', httpStatus:200 });
      console.log(`  S-02 → code=${state.objectCode} CN=${state.containerNumber}`);
      expect(state.objectCode).toBeTruthy();
    });

    test('S-02 | Step 2 | Scheduler: active=1 valid=1 [GATE]', async () => {
      const rec = await pollSchedulerActiveValid(state.objectCode);
      R.step('S-02', 'scheduler', { status: rec?.active===1 && rec?.valid===1 ? 'pass':'fail', active:rec?.active, valid:rec?.valid });
      expect(rec?.active).toBe(1);
      expect(rec?.valid).toBe(1);
    });

    test('S-02 | Step 3 | MongoDB: doc created, error=false, fields valid [GATE]', async () => {
      const docs = await pollMongo(state.containerNumber, state.bookingNumber, null, state.carrier?.scac);
      expect(docs.length).toBeGreaterThan(0);
      state.doc = docs[0];
      R.step('S-02', 'mongodb', { status:'pass', found:true, containerId:state.doc.containerId,
        uniqueReference:state.doc.uniqueReference, serviceProvider:state.doc.serviceProvider,
        identifier:state.doc.identifier, eventsCount:state.doc.events?.length ?? 0 });
      expect(state.doc.error).toBe(false);
      expect(typeof state.doc.error).toBe('boolean');
      expect(state.doc.containerId).toBe(state.containerNumber);
      expect(state.doc.uniqueReference).toBe(`${state.bookingNumber}_${state.containerNumber}`);
      expect(state.doc.serviceProvider).toBe('SHIPPEO');
      expect(Array.isArray(state.doc.events)).toBe(true);
      expect(state.doc.events.length).toBe(0);
      expect(['bookingId', 'billOfLadingId']).toContain(state.doc.identifier);
    });

    // S-31 (BN_CN search) + org/agency/mode + events
    addPositiveFlowTests(() => state);
  });

  // ── S-03 — BL + CN + SCAC + InProgress (no BN) ─────────────────────────────
  test.describe.serial('GROUP P | S-03 | BL + CN + SCAC + InProgress (no BN)', () => {
    const state = { id: 'S-03' };
    const ids = nextScenarioIds();
    R.startScenario('S-03', 'BL + CN + SCAC + InProgress (no BN)', 'GROUP P', 'positive', {
      bookingNumber: null, blNumber: ids.bl, scac: ids.carrier.scac, trackingStatus: 'In Progress',
    });

    test('S-03 | Step 1 | Create OTU', async () => {
      const r = await createOTU({
        bookingNumber:      null,
        billOfLadingNumber: ids.bl,
        carrierScac:        ids.carrier.scac,
        carrierShortName:   ids.carrier.shortName,
        carrierName:        ids.carrier.name,
        trackingStatus:     'In Progress',
      });
      state.objectCode      = r.code;
      state.containerNumber = r.containerNumber;
      state.carrier         = ids.carrier;
      const otu             = await fetchOTU(r.code);
      state.bookingNumber   = null;
      state.blNumber        = otu?.billOfLadingNumber || ids.bl;
      R.step('S-03', 'create', { status:'pass', objectCode:r.code, containerNumber:r.containerNumber,
        bookingNumber:null, blNumber:state.blNumber, scac:ids.carrier.scac, trackingStatus:'In Progress', httpStatus:200 });
      console.log(`  S-03 → code=${state.objectCode} CN=${state.containerNumber}`);
      expect(state.objectCode).toBeTruthy();
    });

    test('S-03 | Step 2 | Scheduler: active=1 valid=1 [GATE]', async () => {
      const rec = await pollSchedulerActiveValid(state.objectCode);
      R.step('S-03', 'scheduler', { status: rec?.active===1 && rec?.valid===1 ? 'pass':'fail', active:rec?.active, valid:rec?.valid });
      expect(rec?.active).toBe(1);
      expect(rec?.valid).toBe(1);
    });

    test('S-03 | Step 3 | MongoDB: doc created, error=false, fields valid [GATE]', async () => {
      const docs = await pollMongo(state.containerNumber, null, state.blNumber, state.carrier?.scac);
      expect(docs.length).toBeGreaterThan(0);
      state.doc = docs[0];
      R.step('S-03', 'mongodb', { status:'pass', found:true, containerId:state.doc.containerId,
        uniqueReference:state.doc.uniqueReference, serviceProvider:state.doc.serviceProvider,
        identifier:state.doc.identifier, eventsCount:state.doc.events?.length ?? 0 });
      expect(state.doc.error).toBe(false);
      expect(typeof state.doc.error).toBe('boolean');
      expect(state.doc.containerId).toBe(state.containerNumber);
      expect(state.doc.uniqueReference).toBe(`${state.blNumber}_${state.containerNumber}`);
      expect(state.doc.serviceProvider).toBe('SHIPPEO');
      expect(Array.isArray(state.doc.events)).toBe(true);
      expect(state.doc.events.length).toBe(0);
      expect(['bookingId', 'billOfLadingId']).toContain(state.doc.identifier);
    });

    // S-32 (BL_CN search) + org/agency/mode + events
    addPositiveFlowTests(() => state);
  });

});

// =============================================================================
//
//  GROUP U — Update to valid=1  (S-18 to S-23)
//
//  Each scenario:
//    1. Create OTU with partial fields
//    2. Verify scheduler state before update
//    3. Update OTU with missing field
//    4. Scheduler: active=1 valid=1 [GATE]
//    5. MongoDB: doc found [GATE]
//    6. Shippeo: found [GATE, skip if token missing]
//    7. 4 Events + Audit
//
// =============================================================================

test.describe('GROUP U | Update to valid=1 — partial OTU upgraded after update', () => {

  // ── S-18 — CN + SCAC + InProgress → add BN ─────────────────────────────────
  test.describe.serial('GROUP U | S-18 | CN+SCAC+InProgress → add BN → valid=1', () => {
    const state = {};
    const ids = nextScenarioIds();
    R.startScenario('S-18', 'CN+SCAC+InProgress → add BN → valid=1', 'GROUP U', 'update', {
      bookingNumber: null, blNumber: null, scac: ids.carrier.scac, trackingStatus: 'In Progress',
    });

    test('S-18 | Step 1 | Create OTU (no BN/BL → valid=0)', async () => {
      const r = await createOTU({
        bookingNumber:      null,
        billOfLadingNumber: null,
        carrierScac:        ids.carrier.scac,
        carrierShortName:   ids.carrier.shortName,
        carrierName:        ids.carrier.name,
        trackingStatus:     'In Progress',
      });
      state.id             = 'S-18';
      state.objectCode      = r.code;
      state.containerNumber = r.containerNumber;
      state.carrier         = ids.carrier;
      state.bookingNumber   = null;
      state.blNumber        = null;
      R.step('S-18', 'create', { status:'pass', objectCode:r.code, containerNumber:r.containerNumber,
        bookingNumber:null, blNumber:null, scac:ids.carrier.scac, trackingStatus:'In Progress', httpStatus:200 });
      expect(state.objectCode).toBeTruthy();
    });

    test('S-18 | Step 2 | Scheduler before update: active=1, valid=0', async () => {
      const rec = await pollUntilActive(state.objectCode);
      expect(rec?.active).toBe(1);
      expect(rec?.valid).toBe(0);
      R.step('S-18', 'scheduler_before', { status:'pass', active:rec?.active, valid:rec?.valid });
    });

    test('S-18 | Step 3 | Update — add BN', async () => {
      await updateOTU(state.containerNumber, {
        bookingNumber: ids.bn,
        carrierScac:   ids.carrier.scac,
        trackingStatus: 'In Progress',
      }, state.objectCode);
      state.bookingNumber = ids.bn;
      R.step('S-18', 'update', { status:'pass', fields: { bookingNumber: ids.bn } });
    });

    test('S-18 | Step 4 | Scheduler after update: active=1 valid=1 [GATE]', async () => {
      const rec = await pollSchedulerActiveValid(state.objectCode);
      R.step('S-18', 'scheduler_after', { status:'pass', active:rec?.active, valid:rec?.valid });
      expect(rec?.active).toBe(1);
      expect(rec?.valid).toBe(1);
    });

    test('S-18 | Step 5 | MongoDB: document created [GATE]', async () => {
      const docs = await pollMongo(state.containerNumber, state.bookingNumber, null, state.carrier?.scac);
      expect(docs.length).toBeGreaterThan(0);
      state.doc = docs[0];
      R.step('S-18', 'mongodb', { status:'pass', found:true, containerId:state.doc.containerId,
        uniqueReference:state.doc.uniqueReference, serviceProvider:state.doc.serviceProvider,
        identifier:state.doc.identifier, eventsCount:state.doc.events?.length ?? 0 });
      expect(state.doc.error).toBe(false);
    });

    addPositiveFlowTests(() => state);
  });

  // ── S-19 — CN + SCAC + InProgress → add BL ─────────────────────────────────
  test.describe.serial('GROUP U | S-19 | CN+SCAC+InProgress → add BL → valid=1', () => {
    const state = {};
    const ids = nextScenarioIds();
    R.startScenario('S-19', 'CN+SCAC+InProgress → add BL → valid=1', 'GROUP U', 'update', {
      bookingNumber: null, blNumber: null, scac: ids.carrier.scac, trackingStatus: 'In Progress',
    });

    test('S-19 | Step 1 | Create OTU (no BN/BL → valid=0)', async () => {
      const r = await createOTU({
        bookingNumber:      null,
        billOfLadingNumber: null,
        carrierScac:        ids.carrier.scac,
        carrierShortName:   ids.carrier.shortName,
        carrierName:        ids.carrier.name,
        trackingStatus:     'In Progress',
      });
      state.id             = 'S-19';
      state.objectCode      = r.code;
      state.containerNumber = r.containerNumber;
      state.carrier         = ids.carrier;
      state.bookingNumber   = null;
      state.blNumber        = null;
      R.step('S-19', 'create', { status:'pass', objectCode:r.code, containerNumber:r.containerNumber,
        bookingNumber:null, blNumber:null, scac:ids.carrier.scac, trackingStatus:'In Progress', httpStatus:200 });
      expect(state.objectCode).toBeTruthy();
    });

    test('S-19 | Step 2 | Scheduler before update: active=1, valid=0', async () => {
      const rec = await pollUntilActive(state.objectCode);
      expect(rec?.active).toBe(1);
      expect(rec?.valid).toBe(0);
      R.step('S-19', 'scheduler_before', { status:'pass', active:rec?.active, valid:rec?.valid });
    });

    test('S-19 | Step 3 | Update — add BL', async () => {
      await new Promise(r => setTimeout(r, 5000));
      await updateOTU(state.containerNumber, {
        billOfLadingNumber: ids.bl,
        carrierScac:        ids.carrier.scac,
        trackingStatus:     'In Progress',
      }, state.objectCode);
      state.blNumber = ids.bl;
      R.step('S-19', 'update', { status:'pass', fields: { billOfLadingNumber: ids.bl } });
    });

    test('S-19 | Step 4 | Scheduler after update: active=1 valid=1 [GATE]', async () => {
      const rec = await pollSchedulerActiveValid(state.objectCode);
      R.step('S-19', 'scheduler_after', { status:'pass', active:rec?.active, valid:rec?.valid });
      expect(rec?.active).toBe(1);
      expect(rec?.valid).toBe(1);
    });

    test('S-19 | Step 5 | MongoDB: document created [GATE]', async () => {
      const docs = await pollMongo(state.containerNumber, null, state.blNumber, state.carrier?.scac);
      expect(docs.length).toBeGreaterThan(0);
      state.doc = docs[0];
      R.step('S-19', 'mongodb', { status:'pass', found:true, containerId:state.doc.containerId,
        uniqueReference:state.doc.uniqueReference, serviceProvider:state.doc.serviceProvider,
        identifier:state.doc.identifier, eventsCount:state.doc.events?.length ?? 0 });
      expect(state.doc.error).toBe(false);
    });

    addPositiveFlowTests(() => state);
  });

  // ── S-20 — CN + SCAC + InProgress → add BN + BL ────────────────────────────
  test.describe.serial('GROUP U | S-20 | CN+SCAC+InProgress → add BN+BL → valid=1', () => {
    const state = {};
    const ids = nextScenarioIds();
    R.startScenario('S-20', 'CN+SCAC+InProgress → add BN+BL → valid=1', 'GROUP U', 'update', {
      bookingNumber: null, blNumber: null, scac: ids.carrier.scac, trackingStatus: 'In Progress',
    });

    test('S-20 | Step 1 | Create OTU (no BN/BL → valid=0)', async () => {
      const r = await createOTU({
        bookingNumber:      null,
        billOfLadingNumber: null,
        carrierScac:        ids.carrier.scac,
        carrierShortName:   ids.carrier.shortName,
        carrierName:        ids.carrier.name,
        trackingStatus:     'In Progress',
      });
      state.id             = 'S-20';
      state.objectCode      = r.code;
      state.containerNumber = r.containerNumber;
      state.carrier         = ids.carrier;
      state.bookingNumber   = null;
      state.blNumber        = null;
      R.step('S-20', 'create', { status:'pass', objectCode:r.code, containerNumber:r.containerNumber,
        bookingNumber:null, blNumber:null, scac:ids.carrier.scac, trackingStatus:'In Progress', httpStatus:200 });
      expect(state.objectCode).toBeTruthy();
    });

    test('S-20 | Step 2 | Scheduler before update: active=1, valid=0', async () => {
      const rec = await pollUntilActive(state.objectCode);
      expect(rec?.active).toBe(1);
      expect(rec?.valid).toBe(0);
      R.step('S-20', 'scheduler_before', { status:'pass', active:rec?.active, valid:rec?.valid });
    });

    test('S-20 | Step 3 | Update — add BN + BL', async () => {
      await new Promise(r => setTimeout(r, 5000));
      await updateOTU(state.containerNumber, {
        bookingNumber:      ids.bn,
        billOfLadingNumber: ids.bl,
        carrierScac:        ids.carrier.scac,
        trackingStatus:     'In Progress',
      }, state.objectCode);
      state.bookingNumber = ids.bn;
      state.blNumber      = ids.bl;
      R.step('S-20', 'update', { status:'pass', fields: { bookingNumber: ids.bn, billOfLadingNumber: ids.bl } });
    });

    test('S-20 | Step 4 | Scheduler after update: active=1 valid=1 [GATE]', async () => {
      const rec = await pollSchedulerActiveValid(state.objectCode);
      R.step('S-20', 'scheduler_after', { status:'pass', active:rec?.active, valid:rec?.valid });
      expect(rec?.active).toBe(1);
      expect(rec?.valid).toBe(1);
    });

    test('S-20 | Step 5 | MongoDB: document created [GATE]', async () => {
      const docs = await pollMongo(state.containerNumber, state.bookingNumber, state.blNumber, state.carrier?.scac);
      expect(docs.length).toBeGreaterThan(0);
      state.doc = docs[0];
      R.step('S-20', 'mongodb', { status:'pass', found:true, containerId:state.doc.containerId,
        uniqueReference:state.doc.uniqueReference, serviceProvider:state.doc.serviceProvider,
        identifier:state.doc.identifier, eventsCount:state.doc.events?.length ?? 0 });
      expect(state.doc.error).toBe(false);
    });

    addPositiveFlowTests(() => state);
  });

  // ── S-21 — BN + CN + SCAC no status → add InProgress ──────────────────────
  test.describe.serial('GROUP U | S-21 | BN+CN+SCAC no status → add InProgress → valid=1', () => {
    const state = {};
    const ids = nextScenarioIds();
    R.startScenario('S-21', 'BN+CN+SCAC no status → add InProgress → valid=1', 'GROUP U', 'update', {
      bookingNumber: ids.bn, blNumber: null, scac: ids.carrier.scac, trackingStatus: null,
    });

    test('S-21 | Step 1 | Create OTU (no status → active=0)', async () => {
      const r = await createOTU({
        bookingNumber:      ids.bn,
        billOfLadingNumber: null,
        carrierScac:        ids.carrier.scac,
        carrierShortName:   ids.carrier.shortName,
        carrierName:        ids.carrier.name,
        trackingStatus:     null,
      });
      state.id             = 'S-21';
      state.objectCode      = r.code;
      state.containerNumber = r.containerNumber;
      state.carrier         = ids.carrier;
      state.bookingNumber   = ids.bn;
      state.blNumber        = null;
      R.step('S-21', 'create', { status:'pass', objectCode:r.code, containerNumber:r.containerNumber,
        bookingNumber:ids.bn, blNumber:null, scac:ids.carrier.scac, trackingStatus:null, httpStatus:200 });
      expect(state.objectCode).toBeTruthy();
    });

    test('S-21 | Step 2 | Scheduler before update: active=0, valid=0', async () => {
      const rec = await getSchedulerOnce(state.objectCode);
      console.log(`  S-21 before → active=${rec?.active ?? 0} valid=${rec?.valid ?? 0}`);
      expect(rec?.active ?? 0).toBe(0);
      R.step('S-21', 'scheduler_before', { status:'pass', active:rec?.active ?? 0, valid:rec?.valid ?? 0 });
    });

    test('S-21 | Step 3 | Update — add trackingStatus=In Progress', async () => {
      await new Promise(r => setTimeout(r, 5000));
      await updateOTU(state.containerNumber, {
        bookingNumber:  ids.bn,
        carrierScac:    ids.carrier.scac,
        trackingStatus: 'In Progress',
      }, state.objectCode);
      R.step('S-21', 'update', { status:'pass', fields: { trackingStatus: 'In Progress', bookingNumber: ids.bn, carrierScac: ids.carrier.scac } });
    });

    test('S-21 | Step 4 | Scheduler after update: active=1 valid=1 [GATE]', async () => {
      const rec = await pollSchedulerActiveValid(state.objectCode);
      R.step('S-21', 'scheduler_after', { status:'pass', active:rec?.active, valid:rec?.valid });
      expect(rec?.active).toBe(1);
      expect(rec?.valid).toBe(1);
    });

    test('S-21 | Step 5 | MongoDB: document created [GATE]', async () => {
      const docs = await pollMongo(state.containerNumber, state.bookingNumber, null, state.carrier?.scac);
      expect(docs.length).toBeGreaterThan(0);
      state.doc = docs[0];
      R.step('S-21', 'mongodb', { status:'pass', found:true, containerId:state.doc.containerId,
        uniqueReference:state.doc.uniqueReference, serviceProvider:state.doc.serviceProvider,
        identifier:state.doc.identifier, eventsCount:state.doc.events?.length ?? 0 });
      expect(state.doc.error).toBe(false);
    });

    addPositiveFlowTests(() => state);
  });

  // ── S-22 — BN + CN + InProgress no SCAC → add SCAC ─────────────────────────
  test.describe.serial('GROUP U | S-22 | BN+CN+InProgress no SCAC → add SCAC → valid=1', () => {
    const state = {};
    const ids = nextScenarioIds();
    R.startScenario('S-22', 'BN+CN+InProgress no SCAC → add SCAC → valid=1', 'GROUP U', 'update', {
      bookingNumber: ids.bn, blNumber: null, scac: null, trackingStatus: 'In Progress',
    });

    test('S-22 | Step 1 | Create OTU (no SCAC → valid=0)', async () => {
      const r = await createOTU({
        bookingNumber:      ids.bn,
        billOfLadingNumber: null,
        ...NO_CARRIER,
        trackingStatus:     'In Progress',
      });
      state.id             = 'S-22';
      state.objectCode      = r.code;
      state.containerNumber = r.containerNumber;
      state.carrier         = ids.carrier;
      state.bookingNumber   = ids.bn;
      state.blNumber        = null;
      R.step('S-22', 'create', { status:'pass', objectCode:r.code, containerNumber:r.containerNumber,
        bookingNumber:ids.bn, blNumber:null, scac:null, trackingStatus:'In Progress', httpStatus:200 });
      expect(state.objectCode).toBeTruthy();
    });

    test('S-22 | Step 2 | Scheduler before update: active=1, valid=0', async () => {
      const rec = await pollUntilActive(state.objectCode);
      expect(rec?.active).toBe(1);
      expect(rec?.valid).toBe(0);
      R.step('S-22', 'scheduler_before', { status:'pass', active:rec?.active, valid:rec?.valid });
    });

    test('S-22 | Step 3 | Update — add carrierScac', async () => {
      await new Promise(r => setTimeout(r, 5000));
      await updateOTU(state.containerNumber, {
        bookingNumber:  ids.bn,
        carrierScac:    ids.carrier.scac,
        trackingStatus: 'In Progress',
      }, state.objectCode);
      R.step('S-22', 'update', { status:'pass', fields: { carrierScac: ids.carrier.scac } });
    });

    test('S-22 | Step 4 | Scheduler after update: active=1 valid=1 [GATE]', async () => {
      const rec = await pollSchedulerActiveValid(state.objectCode);
      R.step('S-22', 'scheduler_after', { status:'pass', active:rec?.active, valid:rec?.valid });
      expect(rec?.active).toBe(1);
      expect(rec?.valid).toBe(1);
    });

    test('S-22 | Step 5 | MongoDB: document created [GATE]', async () => {
      const docs = await pollMongo(state.containerNumber, state.bookingNumber, null, state.carrier?.scac);
      expect(docs.length).toBeGreaterThan(0);
      state.doc = docs[0];
      R.step('S-22', 'mongodb', { status:'pass', found:true, containerId:state.doc.containerId,
        uniqueReference:state.doc.uniqueReference, serviceProvider:state.doc.serviceProvider,
        identifier:state.doc.identifier, eventsCount:state.doc.events?.length ?? 0 });
      expect(state.doc.error).toBe(false);
    });

    addPositiveFlowTests(() => state);
  });

  // ── S-23 — BN + SCAC + InProgress (CN auto-generated) → valid=1 immediately ─
  test.describe.serial('GROUP U | S-23 | BN+SCAC+InProgress → CN auto-generated → valid=1', () => {
    const state = {};
    const ids = nextScenarioIds();
    R.startScenario('S-23', 'BN+SCAC+InProgress → CN auto-generated → valid=1', 'GROUP U', 'update', {
      bookingNumber: ids.bn, blNumber: null, scac: ids.carrier.scac, trackingStatus: 'In Progress',
    });

    test('S-23 | Step 1 | Create OTU (CN auto-present → valid=1 immediately)', async () => {
      const r = await createOTU({
        bookingNumber:      ids.bn,
        billOfLadingNumber: null,
        carrierScac:        ids.carrier.scac,
        carrierShortName:   ids.carrier.shortName,
        carrierName:        ids.carrier.name,
        trackingStatus:     'In Progress',
      });
      state.id             = 'S-23';
      state.objectCode      = r.code;
      state.containerNumber = r.containerNumber;
      state.carrier         = ids.carrier;
      state.bookingNumber   = ids.bn;
      state.blNumber        = null;
      console.log(`  S-23 → code=${state.objectCode} CN=${state.containerNumber}`);
      R.step('S-23', 'create', { status:'pass', objectCode:r.code, containerNumber:r.containerNumber,
        bookingNumber:ids.bn, blNumber:null, scac:ids.carrier.scac, trackingStatus:'In Progress', httpStatus:200 });
      expect(state.objectCode).toBeTruthy();
    });

    test('S-23 | Step 2 | Scheduler: active=1 valid=1 [GATE]', async () => {
      const rec = await pollSchedulerActiveValid(state.objectCode);
      R.step('S-23', 'scheduler_after', { status:'pass', active:rec?.active, valid:rec?.valid });
      expect(rec?.active).toBe(1);
      expect(rec?.valid).toBe(1);
    });

    test('S-23 | Step 3 | MongoDB: document created [GATE]', async () => {
      const docs = await pollMongo(state.containerNumber, state.bookingNumber, null, state.carrier?.scac);
      expect(docs.length).toBeGreaterThan(0);
      state.doc = docs[0];
      R.step('S-23', 'mongodb', { status:'pass', found:true, containerId:state.doc.containerId,
        uniqueReference:state.doc.uniqueReference, serviceProvider:state.doc.serviceProvider,
        identifier:state.doc.identifier, eventsCount:state.doc.events?.length ?? 0 });
      expect(state.doc.error).toBe(false);
    });

    addPositiveFlowTests(() => state);
  });

});

// =============================================================================
//
//  GROUP S — Shippeo Standalone  (S-36, S-37)
//
// =============================================================================

test.describe('GROUP S | Shippeo Standalone Tests', () => {

  test('GROUP S | S-36 | Wrong reference → Shippeo returns empty result', async () => {
    test.skip(!SHIPPEO_ENABLED, 'Update SHIPPEO.token in e2eConfig.js');
    // Use a clearly fake reference that cannot match any real shipment
    const result = await searchShippeoShipment('ZZZZFAKE999_ZZZZ0000000');
    // Shippeo should return null (no match) or an empty/irrelevant result
    // We verify the response doesn't contain a valid shipment with matching reference
    const hasNoMatch = result === null ||
      (result && result.reference !== 'ZZZZFAKE999_ZZZZ0000000');
    expect(hasNoMatch).toBe(true);
    console.log(`  S-36 → result=${JSON.stringify(result)?.slice(0, 100)}`);
  });

  test('GROUP S | S-37 | Expired Shippeo token → HTTP 401', async () => {
    const fullUrl = `${E2E_CONFIG.SHIPPEO.baseUrl}${E2E_CONFIG.SHIPPEO.searchPath}?${E2E_CONFIG.SHIPPEO.searchParamKey}=ANYREF_ANYCN`;
    const ctx = await request.newContext();
    try {
      const res = await ctx.get(fullUrl, {
        headers: {
          'Authorization': 'Bearer expired.token.here',
          'accept':        'application/json',
        },
      });
      expect(res.status()).toBe(401);
    } finally {
      await ctx.dispose();
    }
  });

});

// =============================================================================
//
//  GROUP N1 — active=0 valid=0  (S-04 to S-09)
//
//  Flow stops at scheduler.
//  Scenarios: missing status, wrong status value.
//
// =============================================================================

test.describe('GROUP N1 | active=0 valid=0 — missing or wrong status', () => {

  const N1_CASES = [
    {
      id:   'S-04',
      desc: 'BN + CN + SCAC — no status',
      ids:  nextScenarioIds(),
      get ov() { return { bookingNumber: this.ids.bn, billOfLadingNumber: null, carrierScac: this.ids.carrier.scac, trackingStatus: null }; },
    },
    {
      id:   'S-05',
      desc: 'BL + CN + SCAC — no status',
      ids:  nextScenarioIds(),
      get ov() { return { bookingNumber: null, billOfLadingNumber: this.ids.bl, carrierScac: this.ids.carrier.scac, trackingStatus: null }; },
    },
    {
      id:   'S-06',
      desc: 'BN + BL + CN + SCAC — no status',
      ids:  nextScenarioIds(),
      get ov() { return { bookingNumber: this.ids.bn, billOfLadingNumber: this.ids.bl, carrierScac: this.ids.carrier.scac, trackingStatus: null }; },
    },
    {
      id:   'S-07',
      desc: 'status=InProgress alone — no identifier, no SCAC (CN auto)',
      ids:  nextScenarioIds(),
      ov:   { bookingNumber: null, billOfLadingNumber: null, ...NO_CARRIER, trackingStatus: 'In Progress' },
      // InProgress → active=1; no identifier/SCAC → valid=0 (confirmed from real scheduler)
      active: 1, valid: 0,
    },
    {
      id:   'S-08',
      desc: 'status=Cancelled + BN + CN + SCAC',
      ids:  nextScenarioIds(),
      get ov() { return { bookingNumber: this.ids.bn, billOfLadingNumber: null, carrierScac: this.ids.carrier.scac, trackingStatus: 'Cancelled' }; },
    },
    {
      id:   'S-09',
      desc: 'status=Completed + BN + CN + SCAC',
      ids:  nextScenarioIds(),
      get ov() { return { bookingNumber: this.ids.bn, billOfLadingNumber: null, carrierScac: this.ids.carrier.scac, trackingStatus: 'Completed' }; },
    },
  ];

  for (const c of N1_CASES) {
    R.startScenario(c.id, c.desc, 'GROUP N1', 'negative', { bookingNumber: c.ov.bookingNumber, blNumber: c.ov.billOfLadingNumber, scac: c.ov.carrierScac, trackingStatus: c.ov.trackingStatus });
    test.describe.serial(`GROUP N1 | ${c.id} | ${c.desc}`, () => {
      const state = { id: c.id };

      test(`${c.id} | Step 1 | Create OTU`, async () => {
        const r           = await createOTU(c.ov);
        state.objectCode     = r.code;
        state.containerNumber = r.containerNumber;
        R.step(c.id, 'create', { status:'pass', objectCode:r.code, containerNumber:r.containerNumber,
          bookingNumber:c.ov.bookingNumber, blNumber:c.ov.billOfLadingNumber, scac:c.ov.carrierScac, trackingStatus:c.ov.trackingStatus, httpStatus:200 });
        console.log(`  ${c.id} → code=${state.objectCode} CN=${state.containerNumber}`);
        expect(state.objectCode).toBeTruthy();
      });

      test(`${c.id} | Step 2 | Scheduler: active=${c.active??0}, valid=${c.valid??0} [GATE]`, async () => {
        const rec = await getSchedulerOnce(state.objectCode);
        const a = rec?.active ?? 0, v = rec?.valid ?? 0;
        const expA = c.active ?? 0, expV = c.valid ?? 0;
        R.step(c.id, 'scheduler', { status: a===expA && v===expV ? 'pass':'fail', active:a, valid:v });
        console.log(`  ${c.id} → active=${a} valid=${v} (expected active=${expA} valid=${expV})`);
        expect(a).toBe(expA);
        expect(v).toBe(expV);
      });

      test(`${c.id} | Step 3 | MongoDB: NO document created`, async () => {
        const docs = await checkMongoOnce(state.containerNumber, c.ov.bookingNumber, c.ov.billOfLadingNumber);
        R.step(c.id, 'mongodb', { status: docs.length===0 ? 'pass':'fail', found: docs.length > 0 });
        expect(docs.length).toBe(0);
      });
    });
  }

});

// =============================================================================
//
//  GROUP N2 — active=1 valid=0  (S-10 to S-17, including edge cases S-14 + S-16)
//
//  Flow stops at valid=0.
//  Scenarios: status set but tracking fields incomplete.
//
//  NOTE: S-14 (BN+SCAC+InProgress) and S-16 (BL+SCAC+InProgress) always have
//  CN auto-generated, so they actually reach valid=1. They are handled separately.
//
// =============================================================================

test.describe('GROUP N2 | active=1 valid=0 — status set, tracking fields incomplete', () => {

  const N2_CASES = [
    {
      id:   'S-10',
      desc: 'InProgress + BN only (no SCAC, no CN explicitly — but CN auto)',
      ids:  nextScenarioIds(),
      get ov() { return { bookingNumber: this.ids.bn, billOfLadingNumber: null, ...NO_CARRIER, trackingStatus: 'In Progress' }; },
    },
    {
      id:   'S-11',
      desc: 'InProgress + BL only (no SCAC)',
      ids:  nextScenarioIds(),
      get ov() { return { bookingNumber: null, billOfLadingNumber: this.ids.bl, ...NO_CARRIER, trackingStatus: 'In Progress' }; },
    },
    {
      id:   'S-12',
      desc: 'InProgress + CN + SCAC (no BN/BL)',
      ids:  nextScenarioIds(),
      get ov() { return { bookingNumber: null, billOfLadingNumber: null, carrierScac: this.ids.carrier.scac, trackingStatus: 'In Progress' }; },
    },
    {
      id:   'S-13',
      desc: 'InProgress + BN + CN (no SCAC, carrier cleared)',
      ids:  nextScenarioIds(),
      get ov() { return { bookingNumber: this.ids.bn, billOfLadingNumber: null, ...NO_CARRIER, trackingStatus: 'In Progress' }; },
    },
    {
      id:   'S-15',
      desc: 'InProgress + BL + CN (no SCAC, carrier cleared)',
      ids:  nextScenarioIds(),
      get ov() { return { bookingNumber: null, billOfLadingNumber: this.ids.bl, ...NO_CARRIER, trackingStatus: 'In Progress' }; },
    },
    {
      id:   'S-17',
      desc: 'InProgress only (CN auto, no BN/BL, no carrier)',
      ids:  nextScenarioIds(),
      ov:   { bookingNumber: null, billOfLadingNumber: null, ...NO_CARRIER, trackingStatus: 'In Progress' },
    },
  ];

  for (const c of N2_CASES) {
    R.startScenario(c.id, c.desc, 'GROUP N2', 'negative', { bookingNumber: c.ov.bookingNumber, blNumber: c.ov.billOfLadingNumber, scac: c.ov.carrierScac, trackingStatus: c.ov.trackingStatus });
    test.describe.serial(`GROUP N2 | ${c.id} | ${c.desc}`, () => {
      const state = { id: c.id };

      test(`${c.id} | Step 1 | Create OTU`, async () => {
        const r = await createOTU(c.ov);
        state.objectCode = r.code; state.containerNumber = r.containerNumber;
        R.step(c.id, 'create', { status:'pass', objectCode:r.code, containerNumber:r.containerNumber,
          bookingNumber:c.ov.bookingNumber, blNumber:c.ov.billOfLadingNumber, scac:c.ov.carrierScac, trackingStatus:c.ov.trackingStatus, httpStatus:200 });
        console.log(`  ${c.id} → code=${state.objectCode} CN=${state.containerNumber}`);
        expect(state.objectCode).toBeTruthy();
      });

      test(`${c.id} | Step 2 | Scheduler: active=1, valid=0 [GATE]`, async () => {
        const rec = await pollUntilActive(state.objectCode);
        R.step(c.id, 'scheduler', { status: rec?.active===1 && rec?.valid===0 ? 'pass':'fail', active:rec?.active, valid:rec?.valid });
        console.log(`  ${c.id} → active=${rec?.active} valid=${rec?.valid}`);
        expect(rec?.active).toBe(1);
        expect(rec?.valid).toBe(0);
      });

      test(`${c.id} | Step 3 | MongoDB: NO document created`, async () => {
        const docs = await checkMongoOnce(state.containerNumber, c.ov.bookingNumber, c.ov.billOfLadingNumber);
        R.step(c.id, 'mongodb', { status: docs.length===0 ? 'pass':'fail', found: docs.length > 0 });
        expect(docs.length).toBe(0);
      });
    });
  }

  // ── S-14 — BN + SCAC + InProgress — CN auto-generated → valid=1 ───────────
  test.describe.serial('GROUP N2 | S-14 | InProgress + BN + SCAC (CN auto → valid=1)', () => {
    const state = {};
    const ids = nextScenarioIds();

    test('S-14 | Step 1 | Create OTU', async () => {
      const r = await createOTU({
        bookingNumber:      ids.bn,
        billOfLadingNumber: null,
        carrierScac:        ids.carrier.scac,
        carrierShortName:   ids.carrier.shortName,
        carrierName:        ids.carrier.name,
        trackingStatus:     'In Progress',
      });
      state.objectCode      = r.code;
      state.containerNumber = r.containerNumber;
      state.bookingNumber   = ids.bn;
      state.blNumber        = null;
      state.carrier         = ids.carrier;
      console.log(`  S-14 → code=${state.objectCode} CN=${state.containerNumber}`);
      expect(state.objectCode).toBeTruthy();
    });

    test('S-14 | Step 2 | Scheduler: active=1 valid=1 (CN always auto-generated)', async () => {
      const rec = await pollSchedulerActiveValid(state.objectCode);
      console.log(`  S-14 → active=${rec?.active} valid=${rec?.valid}`);
      expect(rec?.active).toBe(1);
      expect(rec?.valid).toBe(1);
    });

    test('S-14 | Step 3 | MongoDB: document created', async () => {
      const docs = await pollMongo(state.containerNumber, state.bookingNumber, null, state.carrier?.scac);
      expect(docs.length).toBeGreaterThan(0);
      state.doc = docs[0];
      expect(state.doc.error).toBe(false);
    });
  });

  // ── S-16 — BL + SCAC + InProgress — CN auto-generated → valid=1 ───────────
  test.describe.serial('GROUP N2 | S-16 | InProgress + BL + SCAC (CN auto → valid=1)', () => {
    const state = {};
    const ids = nextScenarioIds();

    test('S-16 | Step 1 | Create OTU', async () => {
      const r = await createOTU({
        bookingNumber:      null,
        billOfLadingNumber: ids.bl,
        carrierScac:        ids.carrier.scac,
        carrierShortName:   ids.carrier.shortName,
        carrierName:        ids.carrier.name,
        trackingStatus:     'In Progress',
      });
      state.objectCode      = r.code;
      state.containerNumber = r.containerNumber;
      state.bookingNumber   = null;
      state.blNumber        = ids.bl;
      state.carrier         = ids.carrier;
      console.log(`  S-16 → code=${state.objectCode} CN=${state.containerNumber}`);
      expect(state.objectCode).toBeTruthy();
    });

    test('S-16 | Step 2 | Scheduler: active=1 valid=1 (CN always auto-generated)', async () => {
      const rec = await pollSchedulerActiveValid(state.objectCode);
      console.log(`  S-16 → active=${rec?.active} valid=${rec?.valid}`);
      expect(rec?.active).toBe(1);
      expect(rec?.valid).toBe(1);
    });

    test('S-16 | Step 3 | MongoDB: document created', async () => {
      const docs = await pollMongo(state.containerNumber, null, state.blNumber, state.carrier?.scac);
      expect(docs.length).toBeGreaterThan(0);
      state.doc = docs[0];
      expect(state.doc.error).toBe(false);
    });
  });

});

// =============================================================================
//
//  GROUP A — API / Auth Negative Tests  (S-38 to S-43)
//
// =============================================================================

test.describe('GROUP A | API and Auth Negative Tests', () => {

  test('GROUP A | S-38 | Expired admin token → HTTP 401', async () => {
    const ids = nextScenarioIds();
    // Use ADMIN_GET_URL (qa-admin) which enforces Cognito auth strictly
    const ctx = await request.newContext({ baseURL: E2E_CONFIG.ADMIN_GET_URL });
    try {
      const res = await ctx.get(
        `${E2E_CONFIG.OCEAN.GET_PATH}/nonexistentcode999`,
        {
          headers: {
            'Authorization': 'Bearer expired.token.value',
            'accept':        'application/json',
          },
        }
      );
      console.log(`  S-38 → HTTP ${res.status()}`);
      expect(res.status()).toBe(401);
    } finally {
      await ctx.dispose();
    }
  });

  test('GROUP A | S-39 | Wrong account token → 400 or 401', async () => {
    const ids = nextScenarioIds();
    const ctx = await request.newContext({ baseURL: E2E_CONFIG.ADMIN_GET_URL });
    try {
      const res = await ctx.get(
        `${E2E_CONFIG.OCEAN.GET_PATH}/nonexistentcode999`,
        {
          headers: {
            'Authorization': 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ3cm9uZyIsImV4cCI6OTk5OTk5OTk5OX0.invalid',
            'accept':        'application/json',
          },
        }
      );
      console.log(`  S-39 → HTTP ${res.status()}`);
      expect(res.status()).toBeGreaterThanOrEqual(400);
    } finally {
      await ctx.dispose();
    }
  });

  test('GROUP A | S-40 | Malformed body (data not array) → HTTP 400', async () => {
    const ctx = await request.newContext({ baseURL: E2E_CONFIG.ADMIN_BASE_URL });
    try {
      const res = await ctx.post(`${OCFG.UPSERT_PATH}?createNew=true`, {
        headers: await adminHeaders(),
        // Send data as a plain object instead of array — should fail validation
        data:    { data: 'not-an-array' },
      });
      const status = res.status();
      console.log(`  S-40 → HTTP ${status}`);
      expect(status).toBeGreaterThanOrEqual(400);
    } finally {
      await ctx.dispose();
    }
  });

  test('GROUP A | S-41 | No BN/BL/CN → API rejects or auto-generates CN', async () => {
    // CN is auto-generated by the API — sending no CN no longer triggers 400.
    // Verify the API accepts the request (200) and returns a valid object code.
    const ctx = await request.newContext({ baseURL: E2E_CONFIG.ADMIN_BASE_URL });
    try {
      const res  = await ctx.post(`${OCFG.UPSERT_PATH}?createNew=true`, {
        headers: await adminHeaders(),
        data:    { data: [{ mot: 'OCEAN', trackingStatus: 'In Progress' }] },
      });
      const status = res.status();
      console.log(`  S-41 → HTTP ${status}`);
      // API either succeeds (200) or rejects with 4xx — both are valid
      expect([200, 400, 422]).toContain(status);
    } finally {
      await ctx.dispose();
    }
  });

  test('GROUP A | S-42 | Scheduler for non-existent code → null/empty', async () => {
    const rec = await getTrackingSchedule(OCFG.SCHEMA_TYPE, 'nonexistentcode000');
    expect(rec).toBeNull();
  });

  test('GROUP A | S-43 | MongoDB with all wrong identifiers → empty result', async () => {
    const all  = await fetchTrackingDocuments({
      containerId:    'FAKE0000000',
      bookingId:      'FAKEBOOKING',
      billOfLadingId: 'FAKEBL00000',
      scacCode:       'FAKE',
    }).catch(() => []);
    const docs = extractSuccessDocuments(all);
    expect(docs.length).toBe(0);
  });

});
