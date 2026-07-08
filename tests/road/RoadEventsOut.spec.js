// @ts-check
// ─────────────────────────────────────────────────────────────────────────────
//  tests/road/RoadEventsOut.spec.js
//  Road Tracking — Events-Out Field Mapping Tests
//
//  Source: docs/Road_Events_Out_Tests.md
//  Source: _LIDL__Events-out_Mapping_-_Road.xlsx
//
//  Webhook lookup:   order.reference → RTU transportOrderId
//  Condition match:  situation_code + justification_code + situation.event (all exact, case-sensitive)
//  Field mapped:     situation.date → Logward event field (datetime)
//
//  Run all:
//    npx playwright test --project=road RoadEventsOut --reporter=list
//  Run single block:
//    npx playwright test --project=road RoadEventsOut -g "BLOCK A"
//    npx playwright test --project=road RoadEventsOut -g "BLOCK P"
//    npx playwright test --project=road RoadEventsOut -g "BLOCK N"
//    npx playwright test --project=road RoadEventsOut -g "BLOCK E"
//  Run single test:
//    npx playwright test --project=road RoadEventsOut -g "RD-P-01"
//
//  Block summary:
//    BLOCK A  — Orders-In gates (RTU create → scheduler → GET)
//    BLOCK P  — Positive: 10 event conditions + field mapping
//    BLOCK N  — Negative: wrong codes, missing fields, auth, empty body
//    BLOCK E  — Edge cases: date overwrite, full journey, ETA variants
// ─────────────────────────────────────────────────────────────────────────────

const { test, expect, request } = require('@playwright/test');
const { CONFIG }                = require('../../helpers/road/roadConfig');
const { getAdminToken }         = require('../../helpers/shared/cognitoAuth');
const { createRoadTrackingObject, getRoadTrackingObject } = require('../../helpers/road/roadTrackingObjectFactory');
const { pollUntilSchedulerActive } = require('../../helpers/shared/trackingSchedulerClient');
const { makeRoadPayload }       = require('../../helpers/road/roadPayloadFactory');
const { LOADING_SITES, DELIVERY_SITES, STAGE_DATES, pick } = require('../../helpers/road/roadSites');

// ─────────────────────────────────────────────────────────────────────────────
//  Module-level state — populated in BLOCK A, used in BLOCK E-06 (full journey)
// ─────────────────────────────────────────────────────────────────────────────

const state = {
  rtuCode:        null,
  orderRef:       null,
  loadSite:       null,
  delSite:        null,
};

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

// Road webhook: x-api-key (gateway) + Cognito admin Bearer (same token as RTU create/read).
// Road is unique — ocean/air use long-lived webhook tokens; road uses the Cognito admin token.
async function webhookHeaders() {
  const token = await getAdminToken();
  return {
    'Content-Type':  'application/json',
    'x-api-key':     CONFIG.WEBHOOK_API_KEY,
    'Authorization': `Bearer ${token}`,
  };
}

/** Normalize a date value to UTC ISO string for comparison. */
function normDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// QA backend server runs in IST (UTC+5:30). Datetime strings received in the webhook
// payload are stripped of timezone info and treated as IST before storage.
// Result: stored UTC = sent UTC − 5h30m (regardless of RTU pickUpTimeZone/deliveryTimeZone).
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/**
 * Assert a date field on an RTU matches the expected ISO date.
 * Applies the QA backend IST offset: expected stored = sent UTC − 5h30m.
 */
function assertDate(rtu, field, sentDate) {
  const actual = normDate(rtu?.[field]);
  if (sentDate === null) {
    expect(actual, `RTU.${field} should be null`).toBeNull();
  } else {
    const expected = new Date(new Date(sentDate).getTime() - IST_OFFSET_MS).toISOString();
    expect(actual, `RTU.${field}`).toBe(expected);
  }
}

/**
 * POST a road webhook and poll the RTU until lastChangedAt advances.
 * Returns the updated RTU object.
 *
 * @param {string}      orderRef
 * @param {string}      event
 * @param {string}      sitCode
 * @param {string}      justCode
 * @param {string|null} date
 * @param {object}      loadSite
 * @param {object}      delSite
 * @param {object}      [orderOverrides]
 * @param {{ rtuCode: string }} [opts]
 */
async function sendAndWait(orderRef, event, sitCode, justCode, date, loadSite, delSite, orderOverrides = {}, opts = {}) {
  const rtuCode = opts.rtuCode ?? state.rtuCode;
  if (!rtuCode) throw new Error('sendAndWait: no rtuCode — BLOCK A must run first');

  // Capture baseline
  const baseline = await getRoadTrackingObject(rtuCode);
  const baselineChanged = baseline?.lastChangedAt ?? null;
  console.log(`  [sendAndWait] Baseline lastChangedAt: ${baselineChanged}`);

  // Build + POST webhook
  const payload = makeRoadPayload(event, sitCode, justCode, date, orderRef, loadSite, delSite, orderOverrides);
  const ctx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });
  try {
    const res = await ctx.post(CONFIG.WEBHOOK_PATH, {
      headers: await webhookHeaders(),
      data:    payload,
    });
    const status = res.status();
    const body   = await res.text();
    console.log(`  [webhook] POST ${event} (${sitCode}/${justCode}) → HTTP ${status} ${body.slice(0, 200)}`);
    expect(status, `Webhook POST should return 2xx`).toBeGreaterThanOrEqual(200);
    expect(status, `Webhook POST should return 2xx`).toBeLessThan(300);
  } finally {
    await ctx.dispose();
  }

  // Poll until RTU updated (lastChangedAt changes)
  const deadline = Date.now() + CONFIG.POLL_TIMEOUT_MS;
  let rtu = null;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, CONFIG.POLL_INTERVAL_MS));
    rtu = await getRoadTrackingObject(rtuCode);
    const changed = rtu?.lastChangedAt ?? null;
    if (changed !== baselineChanged) {
      console.log(`  [poll ✅] RTU updated (lastChangedAt: ${changed})`);
      return rtu;
    }
    console.log(`  [poll ⏳] lastChangedAt unchanged (${changed})`);
  }

  // Timed out — return last fetched RTU (may be unchanged)
  console.warn(`  [poll ⚠️] Timed out after ${CONFIG.POLL_TIMEOUT_MS}ms — returning last RTU`);
  return rtu;
}

/**
 * Create a fresh RTU for an isolated test.
 * Waits for the ATC scheduler to confirm active=1 valid=1 before returning —
 * this ensures the backend has indexed the RTU before any webhook is fired.
 * Returns { rtuCode, orderRef, loadSite, delSite }.
 */
async function createFreshRTU() {
  const loadSite = pick(LOADING_SITES);
  const delSite  = pick(DELIVERY_SITES);
  const result   = await createRoadTrackingObject({
    pickupAddressName:    loadSite.name,
    pickupAddressStreet:  loadSite.address,
    pickupAddressZipcode: loadSite.zipcode,
    pickupAddressCity:    loadSite.city,
    pickupAddressCountry: loadSite.country,
    deliveryLocationName:    delSite.name,
    deliveryLocationStreet:  delSite.address,
    deliveryLocationZipcode: delSite.zipcode,
    deliveryLocationCity:    delSite.city,
    deliveryLocationCountry: delSite.country,
  });
  console.log(`  [createFreshRTU] code=${result.code} orderRef=${result.transportOrderId} load=${loadSite.city} del=${delSite.city}`);

  // Wait for ATC to confirm active=1 valid=1 before firing any webhook
  const rec = await pollUntilSchedulerActive(CONFIG.SCHEMA_TYPE, result.code);
  console.log(`  [createFreshRTU] scheduler active=${rec?.active} valid=${rec?.valid}`);

  return { rtuCode: result.code, orderRef: result.transportOrderId, loadSite, delSite };
}

// ─────────────────────────────────────────────────────────────────────────────
//  BLOCK A — Orders-In gates
// ─────────────────────────────────────────────────────────────────────────────

test.describe('BLOCK A — Orders-In gates', () => {

  test('A-01 — Create RTU with full valid fields → response has code', async () => {
    state.loadSite = pick(LOADING_SITES);
    state.delSite  = pick(DELIVERY_SITES);

    const result = await createRoadTrackingObject({
      pickupAddressName:    state.loadSite.name,
      pickupAddressStreet:  state.loadSite.address,
      pickupAddressZipcode: state.loadSite.zipcode,
      pickupAddressCity:    state.loadSite.city,
      pickupAddressCountry: state.loadSite.country,
      deliveryLocationName:    state.delSite.name,
      deliveryLocationStreet:  state.delSite.address,
      deliveryLocationZipcode: state.delSite.zipcode,
      deliveryLocationCity:    state.delSite.city,
      deliveryLocationCountry: state.delSite.country,
    });

    expect(result.code, 'RTU code should be truthy').toBeTruthy();
    expect(result.transportOrderId, 'transportOrderId should start with E2E').toMatch(/^E2E/);

    state.rtuCode  = result.code;
    state.orderRef = result.transportOrderId;

    console.log(`  [A-01 ✅] RTU created: code=${state.rtuCode}  orderRef=${state.orderRef}`);
    console.log(`  [A-01]    loadSite=${state.loadSite.city} (${state.loadSite.country})  delSite=${state.delSite.city} (${state.delSite.country})`);
  });

  test('A-02 — Scheduler active=1 valid=1', async () => {
    expect(state.rtuCode, 'BLOCK A-01 must run first').toBeTruthy();

    const rec = await pollUntilSchedulerActive(CONFIG.SCHEMA_TYPE, state.rtuCode);
    expect(rec, 'Scheduler record should exist').toBeTruthy();
    expect(rec.active, 'active should be 1').toBe(1);
    expect(rec.valid,  'valid should be 1').toBe(1);

    console.log(`  [A-02 ✅] active=${rec.active} valid=${rec.valid}`);
  });

  test('A-03 — GET RTU by code returns all required fields', async () => {
    expect(state.rtuCode, 'BLOCK A-01 must run first').toBeTruthy();

    const rtu = await getRoadTrackingObject(state.rtuCode);
    expect(rtu, 'RTU GET should return data').toBeTruthy();

    const required = [
      'transportOrderId', 'licensePlateTruck', 'loadType',
      'pickupAddressName', 'pickupAddressCity', 'pickupAddressCountry',
      'deliveryLocationName', 'deliveryLocationCity', 'deliveryLocationCountry',
      'pickUpStartDate', 'pickUpEndDate', 'deliveryStartDate', 'deliveryEndDate',
      'trackingStatus',
    ];
    for (const field of required) {
      expect(rtu[field], `RTU.${field} should be present`).toBeTruthy();
    }

    console.log(`  [A-03 ✅] All required fields present on RTU`);
  });

});

// ─────────────────────────────────────────────────────────────────────────────
//  BLOCK P — Positive: all 10 event conditions
// ─────────────────────────────────────────────────────────────────────────────

test.describe('BLOCK P — Positive event mapping', () => {

  test('RD-P-01 — DRIVING_TO_LOAD · EML/CFM → truckDrivingToPickUpLocation', async () => {
    const { rtuCode, orderRef, loadSite, delSite } = await createFreshRTU();
    const date = STAGE_DATES.drivingToLoad;

    const rtu = await sendAndWait(orderRef, 'DRIVING_TO_LOAD', 'EML', 'CFM', date, loadSite, delSite, {}, { rtuCode });

    assertDate(rtu, 'truckDrivingToPickUpLocation', date);
    console.log(`  [RD-P-01 ✅] truckDrivingToPickUpLocation = ${date}`);
  });

  test('RD-P-02 — ARR_LOAD · EML/ARS → actualArrivalAtPickUpLocation', async () => {
    const { rtuCode, orderRef, loadSite, delSite } = await createFreshRTU();
    const date = STAGE_DATES.arrivedAtPickUp;

    const rtu = await sendAndWait(orderRef, 'ARR_LOAD', 'EML', 'ARS', date, loadSite, delSite, {}, { rtuCode });

    assertDate(rtu, 'actualArrivalAtPickUpLocation', date);
    console.log(`  [RD-P-02 ✅] actualArrivalAtPickUpLocation = ${date}`);
  });

  test('RD-P-03 — CON_LOAD · ECH/CFM → loaded', async () => {
    const { rtuCode, orderRef, loadSite, delSite } = await createFreshRTU();
    const date = STAGE_DATES.loaded;

    const rtu = await sendAndWait(orderRef, 'CON_LOAD', 'ECH', 'CFM', date, loadSite, delSite, {}, { rtuCode });

    assertDate(rtu, 'loaded', date);
    console.log(`  [RD-P-03 ✅] loaded = ${date}`);
  });

  test('RD-P-04 — LEFT_LOADING_SITE · ECH/DES → actualDeparturePolRoad', async () => {
    const { rtuCode, orderRef, loadSite, delSite } = await createFreshRTU();
    const date = STAGE_DATES.leftLoading;

    const rtu = await sendAndWait(orderRef, 'LEFT_LOADING_SITE', 'ECH', 'DES', date, loadSite, delSite, {}, { rtuCode });

    assertDate(rtu, 'actualDeparturePolRoad', date);
    console.log(`  [RD-P-04 ✅] actualDeparturePolRoad = ${date}`);
  });

  test('RD-P-05 — DRIVING_TO_UNLOAD · MLV/CFM → truckDrivingToDeliveryLocation', async () => {
    const { rtuCode, orderRef, loadSite, delSite } = await createFreshRTU();
    const date = STAGE_DATES.drivingToDelivery;

    const rtu = await sendAndWait(orderRef, 'DRIVING_TO_UNLOAD', 'MLV', 'CFM', date, loadSite, delSite, {}, { rtuCode });

    assertDate(rtu, 'truckDrivingToDeliveryLocation', date);
    console.log(`  [RD-P-05 ✅] truckDrivingToDeliveryLocation = ${date}`);
  });

  test('RD-P-06 — ARR_UNLOAD · LIV/ARS → actualArrivalPodRoad', async () => {
    const { rtuCode, orderRef, loadSite, delSite } = await createFreshRTU();
    const date = STAGE_DATES.arrivedAtDelivery;

    const rtu = await sendAndWait(orderRef, 'ARR_UNLOAD', 'LIV', 'ARS', date, loadSite, delSite, {}, { rtuCode });

    assertDate(rtu, 'actualArrivalPodRoad', date);
    console.log(`  [RD-P-06 ✅] actualArrivalPodRoad = ${date}`);
  });

  test('RD-P-07 — CON_UNLOAD · LIV/CFM → delivered', async () => {
    const { rtuCode, orderRef, loadSite, delSite } = await createFreshRTU();
    const date = STAGE_DATES.delivered;

    const rtu = await sendAndWait(orderRef, 'CON_UNLOAD', 'LIV', 'CFM', date, loadSite, delSite, {}, { rtuCode });

    assertDate(rtu, 'delivered', date);
    console.log(`  [RD-P-07 ✅] delivered = ${date}`);
  });

  test('RD-P-08 — DRIVER_LEFT_UNLOAD · LIV/DES → truckDepartureFromDeliveryLocation', async () => {
    const { rtuCode, orderRef, loadSite, delSite } = await createFreshRTU();
    const date = STAGE_DATES.leftDelivery;

    const rtu = await sendAndWait(orderRef, 'DRIVER_LEFT_UNLOAD', 'LIV', 'DES', date, loadSite, delSite, {}, { rtuCode });

    assertDate(rtu, 'truckDepartureFromDeliveryLocation', date);
    console.log(`  [RD-P-08 ✅] truckDepartureFromDeliveryLocation = ${date}`);
  });

  test('RD-P-09 — ETA_EVENT · COM/CFM · order.etd present → predictedArrivalAtPickUpLocation only', async () => {
    const { rtuCode, orderRef, loadSite, delSite } = await createFreshRTU();
    const date = STAGE_DATES.etaPickUp;

    const rtu = await sendAndWait(
      orderRef, 'ETA_EVENT', 'COM', 'CFM', date, loadSite, delSite,
      { etd: date, eta: null },
      { rtuCode }
    );

    assertDate(rtu, 'predictedArrivalAtPickUpLocation',   date);
    assertDate(rtu, 'predictedArrivalAtDeliveryLocation', null);
    console.log(`  [RD-P-09 ✅] predictedArrivalAtPickUpLocation = ${date} | delivery ETA = null`);
  });

  test('RD-P-10 — ETA_EVENT · COM/CFM · order.eta present → predictedArrivalAtDeliveryLocation only', async () => {
    const { rtuCode, orderRef, loadSite, delSite } = await createFreshRTU();
    const date = STAGE_DATES.etaDelivery;

    const rtu = await sendAndWait(
      orderRef, 'ETA_EVENT', 'COM', 'CFM', date, loadSite, delSite,
      { eta: date, etd: null },
      { rtuCode }
    );

    assertDate(rtu, 'predictedArrivalAtDeliveryLocation', date);
    assertDate(rtu, 'predictedArrivalAtPickUpLocation',   null);
    console.log(`  [RD-P-10 ✅] predictedArrivalAtDeliveryLocation = ${date} | pickup ETA = null`);
  });

});

// ─────────────────────────────────────────────────────────────────────────────
//  BLOCK N — Negative tests
// ─────────────────────────────────────────────────────────────────────────────

test.describe('BLOCK N — Negative / Auth', () => {

  test('RD-N-01 — Wrong situation_code → truckDrivingToPickUpLocation stays null', async () => {
    const { rtuCode, orderRef, loadSite, delSite } = await createFreshRTU();

    // Send wrong situation_code (XXX instead of EML)
    const payload = makeRoadPayload('DRIVING_TO_LOAD', 'XXX', 'CFM', STAGE_DATES.drivingToLoad, orderRef, loadSite, delSite);
    const ctx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });
    try {
      const res = await ctx.post(CONFIG.WEBHOOK_PATH, { headers: await webhookHeaders(), data: payload });
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    } finally { await ctx.dispose(); }

    // Short wait then assert field is null
    await new Promise(r => setTimeout(r, CONFIG.POLL_INTERVAL_MS * 2));
    const rtu = await getRoadTrackingObject(rtuCode);
    assertDate(rtu, 'truckDrivingToPickUpLocation', null);
    console.log(`  [RD-N-01 ✅] Wrong situation_code — field stays null`);
  });

  test('RD-N-02 — Wrong justification_code → truckDrivingToPickUpLocation stays null', async () => {
    const { rtuCode, orderRef, loadSite, delSite } = await createFreshRTU();

    const payload = makeRoadPayload('DRIVING_TO_LOAD', 'EML', 'XXX', STAGE_DATES.drivingToLoad, orderRef, loadSite, delSite);
    const ctx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });
    try {
      const res = await ctx.post(CONFIG.WEBHOOK_PATH, { headers: await webhookHeaders(), data: payload });
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    } finally { await ctx.dispose(); }

    await new Promise(r => setTimeout(r, CONFIG.POLL_INTERVAL_MS * 2));
    const rtu = await getRoadTrackingObject(rtuCode);
    assertDate(rtu, 'truckDrivingToPickUpLocation', null);
    console.log(`  [RD-N-02 ✅] Wrong justification_code — field stays null`);
  });

  test('RD-N-03 — Wrong situation.event → truckDrivingToPickUpLocation stays null', async () => {
    const { rtuCode, orderRef, loadSite, delSite } = await createFreshRTU();

    const payload = makeRoadPayload('UNKNOWN_EVENT', 'EML', 'CFM', STAGE_DATES.drivingToLoad, orderRef, loadSite, delSite);
    const ctx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });
    try {
      const res = await ctx.post(CONFIG.WEBHOOK_PATH, { headers: await webhookHeaders(), data: payload });
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    } finally { await ctx.dispose(); }

    await new Promise(r => setTimeout(r, CONFIG.POLL_INTERVAL_MS * 2));
    const rtu = await getRoadTrackingObject(rtuCode);
    assertDate(rtu, 'truckDrivingToPickUpLocation', null);
    console.log(`  [RD-N-03 ✅] Wrong event name — field stays null`);
  });

  test('RD-N-04 — ETA_EVENT · COM/CFM · no eta no etd → both ETA fields null', async () => {
    const { rtuCode, orderRef, loadSite, delSite } = await createFreshRTU();

    const payload = makeRoadPayload('ETA_EVENT', 'COM', 'CFM', STAGE_DATES.etaDelivery, orderRef, loadSite, delSite, { eta: null, etd: null });
    const ctx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });
    try {
      const res = await ctx.post(CONFIG.WEBHOOK_PATH, { headers: await webhookHeaders(), data: payload });
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    } finally { await ctx.dispose(); }

    await new Promise(r => setTimeout(r, CONFIG.POLL_INTERVAL_MS * 2));
    const rtu = await getRoadTrackingObject(rtuCode);
    assertDate(rtu, 'predictedArrivalAtPickUpLocation',   null);
    assertDate(rtu, 'predictedArrivalAtDeliveryLocation', null);
    console.log(`  [RD-N-04 ✅] ETA_EVENT with no eta/etd — both fields null`);
  });

  test('RD-N-05 — RTO not found → HTTP 200 · event silently dropped', async () => {
    const loadSite = pick(LOADING_SITES);
    const delSite  = pick(DELIVERY_SITES);
    const payload  = makeRoadPayload('DRIVING_TO_LOAD', 'EML', 'CFM', STAGE_DATES.drivingToLoad, 'NONEXISTENT-ORDER-999', loadSite, delSite);

    const ctx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });
    try {
      const res = await ctx.post(CONFIG.WEBHOOK_PATH, { headers: await webhookHeaders(), data: payload });
      expect(res.status(), 'No-match event should still return 200').toBe(200);
      console.log(`  [RD-N-05 ✅] Non-existent order → HTTP 200`);
    } finally { await ctx.dispose(); }
  });

  test('RD-N-06 — Missing situation_code (null) → truckDrivingToPickUpLocation stays null', async () => {
    const { rtuCode, orderRef, loadSite, delSite } = await createFreshRTU();

    const payload = makeRoadPayload('DRIVING_TO_LOAD', null, 'CFM', STAGE_DATES.drivingToLoad, orderRef, loadSite, delSite);
    const ctx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });
    try {
      const res = await ctx.post(CONFIG.WEBHOOK_PATH, { headers: await webhookHeaders(), data: payload });
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    } finally { await ctx.dispose(); }

    await new Promise(r => setTimeout(r, CONFIG.POLL_INTERVAL_MS * 2));
    const rtu = await getRoadTrackingObject(rtuCode);
    assertDate(rtu, 'truckDrivingToPickUpLocation', null);
    console.log(`  [RD-N-06 ✅] Null situation_code — field stays null`);
  });

  test('RD-N-07 — Missing justification_code (null) → truckDrivingToPickUpLocation stays null', async () => {
    const { rtuCode, orderRef, loadSite, delSite } = await createFreshRTU();

    const payload = makeRoadPayload('DRIVING_TO_LOAD', 'EML', null, STAGE_DATES.drivingToLoad, orderRef, loadSite, delSite);
    const ctx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });
    try {
      const res = await ctx.post(CONFIG.WEBHOOK_PATH, { headers: await webhookHeaders(), data: payload });
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    } finally { await ctx.dispose(); }

    await new Promise(r => setTimeout(r, CONFIG.POLL_INTERVAL_MS * 2));
    const rtu = await getRoadTrackingObject(rtuCode);
    assertDate(rtu, 'truckDrivingToPickUpLocation', null);
    console.log(`  [RD-N-07 ✅] Null justification_code — field stays null`);
  });

  test('RD-N-08 — Correct conditions but situation.date null → event field null', async () => {
    const { rtuCode, orderRef, loadSite, delSite } = await createFreshRTU();

    const payload = makeRoadPayload('DRIVING_TO_LOAD', 'EML', 'CFM', null, orderRef, loadSite, delSite);
    const ctx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });
    try {
      const res = await ctx.post(CONFIG.WEBHOOK_PATH, { headers: await webhookHeaders(), data: payload });
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    } finally { await ctx.dispose(); }

    await new Promise(r => setTimeout(r, CONFIG.POLL_INTERVAL_MS * 2));
    const rtu = await getRoadTrackingObject(rtuCode);
    assertDate(rtu, 'truckDrivingToPickUpLocation', null);
    console.log(`  [RD-N-08 ✅] Null date — field stays null`);
  });

  test('RD-N-09 — Wrong case situation.event (lowercase) → field stays null (case-sensitive)', async () => {
    const { rtuCode, orderRef, loadSite, delSite } = await createFreshRTU();

    const payload = makeRoadPayload('driving_to_load', 'EML', 'CFM', STAGE_DATES.drivingToLoad, orderRef, loadSite, delSite);
    const ctx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });
    try {
      const res = await ctx.post(CONFIG.WEBHOOK_PATH, { headers: await webhookHeaders(), data: payload });
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    } finally { await ctx.dispose(); }

    await new Promise(r => setTimeout(r, CONFIG.POLL_INTERVAL_MS * 2));
    const rtu = await getRoadTrackingObject(rtuCode);
    assertDate(rtu, 'truckDrivingToPickUpLocation', null);
    console.log(`  [RD-N-09 ✅] Lowercase event name — case-sensitive check passes`);
  });

  test('RD-N-10 — Wrong case situation_code (lowercase) → field stays null (case-sensitive)', async () => {
    const { rtuCode, orderRef, loadSite, delSite } = await createFreshRTU();

    const payload = makeRoadPayload('DRIVING_TO_LOAD', 'eml', 'CFM', STAGE_DATES.drivingToLoad, orderRef, loadSite, delSite);
    const ctx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });
    try {
      const res = await ctx.post(CONFIG.WEBHOOK_PATH, { headers: await webhookHeaders(), data: payload });
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    } finally { await ctx.dispose(); }

    await new Promise(r => setTimeout(r, CONFIG.POLL_INTERVAL_MS * 2));
    const rtu = await getRoadTrackingObject(rtuCode);
    assertDate(rtu, 'truckDrivingToPickUpLocation', null);
    console.log(`  [RD-N-10 ✅] Lowercase situation_code — case-sensitive check passes`);
  });

  test('RD-N-11 — Missing Authorization header → HTTP 401', async () => {
    const loadSite = pick(LOADING_SITES);
    const delSite  = pick(DELIVERY_SITES);
    const payload  = makeRoadPayload('DRIVING_TO_LOAD', 'EML', 'CFM', STAGE_DATES.drivingToLoad, 'E2ETEST-N11', loadSite, delSite);

    const ctx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });
    try {
      const res = await ctx.post(CONFIG.WEBHOOK_PATH, {
        headers: { 'Content-Type': 'application/json', 'x-api-key': CONFIG.WEBHOOK_API_KEY },
        data:    payload,
      });
      expect(res.status(), 'Missing auth should return 401').toBe(401);
      console.log(`  [RD-N-11 ✅] No Authorization header → 401`);
    } finally { await ctx.dispose(); }
  });

  test('RD-N-12 — Invalid Bearer token → HTTP 401', async () => {
    const loadSite = pick(LOADING_SITES);
    const delSite  = pick(DELIVERY_SITES);
    const payload  = makeRoadPayload('DRIVING_TO_LOAD', 'EML', 'CFM', STAGE_DATES.drivingToLoad, 'E2ETEST-N12', loadSite, delSite);

    const ctx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });
    try {
      const res = await ctx.post(CONFIG.WEBHOOK_PATH, {
        headers: { 'Content-Type': 'application/json', 'x-api-key': CONFIG.WEBHOOK_API_KEY, 'Authorization': 'Bearer INVALID_TOKEN_E2E' },
        data:    payload,
      });
      expect(res.status(), 'Invalid token should return 401').toBe(401);
      console.log(`  [RD-N-12 ✅] Invalid token → 401`);
    } finally { await ctx.dispose(); }
  });

  test('RD-N-13 — Empty request body → HTTP 400', async () => {
    const ctx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });
    try {
      const res = await ctx.post(CONFIG.WEBHOOK_PATH, {
        headers: await webhookHeaders(),
        data:    {},
      });
      expect(res.status(), 'Empty body should return 4xx').toBeGreaterThanOrEqual(400);
      expect(res.status(), 'Empty body should return 4xx').toBeLessThan(500);
      console.log(`  [RD-N-13 ✅] Empty body → HTTP ${res.status()}`);
    } finally { await ctx.dispose(); }
  });

});

// ─────────────────────────────────────────────────────────────────────────────
//  BLOCK E — Edge Cases
// ─────────────────────────────────────────────────────────────────────────────

test.describe('BLOCK E — Edge Cases', () => {

  test('RD-E-01 — Same event twice · later date wins', async () => {
    const { rtuCode, orderRef, loadSite, delSite } = await createFreshRTU();

    const t1 = STAGE_DATES.drivingToLoad;
    // T2 is one day later than T1
    const t2 = new Date(new Date(t1).getTime() + 86400000).toISOString();

    // Step 1: send T1
    await sendAndWait(orderRef, 'DRIVING_TO_LOAD', 'EML', 'CFM', t1, loadSite, delSite, {}, { rtuCode });
    let rtu = await getRoadTrackingObject(rtuCode);
    assertDate(rtu, 'truckDrivingToPickUpLocation', t1);

    // Step 2: send T2 (later) → should overwrite
    await sendAndWait(orderRef, 'DRIVING_TO_LOAD', 'EML', 'CFM', t2, loadSite, delSite, {}, { rtuCode });
    rtu = await getRoadTrackingObject(rtuCode);
    assertDate(rtu, 'truckDrivingToPickUpLocation', t2);
    console.log(`  [RD-E-01 ✅] Later date T2 overwrote T1`);
  });

  test('RD-E-02 — Same event twice · earlier date does NOT overwrite', async () => {
    const { rtuCode, orderRef, loadSite, delSite } = await createFreshRTU();

    const t2 = STAGE_DATES.drivingToLoad;
    // T1 is one day earlier than T2
    const t1 = new Date(new Date(t2).getTime() - 86400000).toISOString();

    // Step 1: send T2 (later date first)
    await sendAndWait(orderRef, 'DRIVING_TO_LOAD', 'EML', 'CFM', t2, loadSite, delSite, {}, { rtuCode });
    let rtu = await getRoadTrackingObject(rtuCode);
    assertDate(rtu, 'truckDrivingToPickUpLocation', t2);

    // Step 2: send T1 (earlier) → should NOT overwrite T2
    const payload = makeRoadPayload('DRIVING_TO_LOAD', 'EML', 'CFM', t1, orderRef, loadSite, delSite);
    const ctx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });
    try {
      const res = await ctx.post(CONFIG.WEBHOOK_PATH, { headers: await webhookHeaders(), data: payload });
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    } finally { await ctx.dispose(); }

    await new Promise(r => setTimeout(r, CONFIG.POLL_INTERVAL_MS * 3));
    rtu = await getRoadTrackingObject(rtuCode);
    assertDate(rtu, 'truckDrivingToPickUpLocation', t2);
    console.log(`  [RD-E-02 ✅] Earlier date T1 did NOT overwrite T2 — original kept`);
  });

  test('RD-E-05 — ETA_EVENT · both order.eta AND order.etd present → both fields written', async () => {
    const { rtuCode, orderRef, loadSite, delSite } = await createFreshRTU();

    const pickupEta   = STAGE_DATES.etaPickUp;
    const deliveryEta = STAGE_DATES.etaDelivery;

    const rtu = await sendAndWait(
      orderRef, 'ETA_EVENT', 'COM', 'CFM', pickupEta, loadSite, delSite,
      { etd: pickupEta, eta: deliveryEta },
      { rtuCode }
    );

    assertDate(rtu, 'predictedArrivalAtPickUpLocation',   pickupEta);
    assertDate(rtu, 'predictedArrivalAtDeliveryLocation', deliveryEta);
    console.log(`  [RD-E-05 ✅] Both ETA fields written — pickup=${pickupEta} delivery=${deliveryEta}`);
  });

  test.describe('RD-E-06 — Full journey: all 8 events in sequence on the main RTU', () => {

    const journeyDates = {
      step1: STAGE_DATES.drivingToLoad,
      step2: STAGE_DATES.arrivedAtPickUp,
      step3: STAGE_DATES.loaded,
      step4: STAGE_DATES.leftLoading,
      step5: STAGE_DATES.drivingToDelivery,
      step6: STAGE_DATES.arrivedAtDelivery,
      step7: STAGE_DATES.delivered,
      step8: STAGE_DATES.leftDelivery,
    };

    test('E-06-1 — DRIVING_TO_LOAD → truckDrivingToPickUpLocation', async () => {
      expect(state.rtuCode, 'BLOCK A-01 must run first').toBeTruthy();
      await sendAndWait(state.orderRef, 'DRIVING_TO_LOAD', 'EML', 'CFM', journeyDates.step1, state.loadSite, state.delSite);
      const rtu = await getRoadTrackingObject(state.rtuCode);
      assertDate(rtu, 'truckDrivingToPickUpLocation', journeyDates.step1);
      console.log(`  [E-06-1 ✅] truckDrivingToPickUpLocation = ${journeyDates.step1}`);
    });

    test('E-06-2 — ARR_LOAD → actualArrivalAtPickUpLocation', async () => {
      expect(state.rtuCode, 'BLOCK A-01 must run first').toBeTruthy();
      await sendAndWait(state.orderRef, 'ARR_LOAD', 'EML', 'ARS', journeyDates.step2, state.loadSite, state.delSite);
      const rtu = await getRoadTrackingObject(state.rtuCode);
      assertDate(rtu, 'actualArrivalAtPickUpLocation', journeyDates.step2);
      console.log(`  [E-06-2 ✅] actualArrivalAtPickUpLocation = ${journeyDates.step2}`);
    });

    test('E-06-3 — CON_LOAD → loaded', async () => {
      expect(state.rtuCode, 'BLOCK A-01 must run first').toBeTruthy();
      await sendAndWait(state.orderRef, 'CON_LOAD', 'ECH', 'CFM', journeyDates.step3, state.loadSite, state.delSite);
      const rtu = await getRoadTrackingObject(state.rtuCode);
      assertDate(rtu, 'loaded', journeyDates.step3);
      console.log(`  [E-06-3 ✅] loaded = ${journeyDates.step3}`);
    });

    test('E-06-4 — LEFT_LOADING_SITE → actualDeparturePolRoad', async () => {
      expect(state.rtuCode, 'BLOCK A-01 must run first').toBeTruthy();
      await sendAndWait(state.orderRef, 'LEFT_LOADING_SITE', 'ECH', 'DES', journeyDates.step4, state.loadSite, state.delSite);
      const rtu = await getRoadTrackingObject(state.rtuCode);
      assertDate(rtu, 'actualDeparturePolRoad', journeyDates.step4);
      console.log(`  [E-06-4 ✅] actualDeparturePolRoad = ${journeyDates.step4}`);
    });

    test('E-06-5 — DRIVING_TO_UNLOAD → truckDrivingToDeliveryLocation', async () => {
      expect(state.rtuCode, 'BLOCK A-01 must run first').toBeTruthy();
      await sendAndWait(state.orderRef, 'DRIVING_TO_UNLOAD', 'MLV', 'CFM', journeyDates.step5, state.loadSite, state.delSite);
      const rtu = await getRoadTrackingObject(state.rtuCode);
      assertDate(rtu, 'truckDrivingToDeliveryLocation', journeyDates.step5);
      console.log(`  [E-06-5 ✅] truckDrivingToDeliveryLocation = ${journeyDates.step5}`);
    });

    test('E-06-6 — ARR_UNLOAD → actualArrivalPodRoad', async () => {
      expect(state.rtuCode, 'BLOCK A-01 must run first').toBeTruthy();
      await sendAndWait(state.orderRef, 'ARR_UNLOAD', 'LIV', 'ARS', journeyDates.step6, state.loadSite, state.delSite);
      const rtu = await getRoadTrackingObject(state.rtuCode);
      assertDate(rtu, 'actualArrivalPodRoad', journeyDates.step6);
      console.log(`  [E-06-6 ✅] actualArrivalPodRoad = ${journeyDates.step6}`);
    });

    test('E-06-7 — CON_UNLOAD → delivered', async () => {
      expect(state.rtuCode, 'BLOCK A-01 must run first').toBeTruthy();
      await sendAndWait(state.orderRef, 'CON_UNLOAD', 'LIV', 'CFM', journeyDates.step7, state.loadSite, state.delSite);
      const rtu = await getRoadTrackingObject(state.rtuCode);
      assertDate(rtu, 'delivered', journeyDates.step7);
      console.log(`  [E-06-7 ✅] delivered = ${journeyDates.step7}`);
    });

    test('E-06-8 — DRIVER_LEFT_UNLOAD → truckDepartureFromDeliveryLocation', async () => {
      expect(state.rtuCode, 'BLOCK A-01 must run first').toBeTruthy();
      await sendAndWait(state.orderRef, 'DRIVER_LEFT_UNLOAD', 'LIV', 'DES', journeyDates.step8, state.loadSite, state.delSite);
      const rtu = await getRoadTrackingObject(state.rtuCode);
      assertDate(rtu, 'truckDepartureFromDeliveryLocation', journeyDates.step8);
      console.log(`  [E-06-8 ✅] truckDepartureFromDeliveryLocation = ${journeyDates.step8}`);
    });

    test('E-06-final — All 8 date fields set on RTU', async () => {
      expect(state.rtuCode, 'BLOCK A-01 must run first').toBeTruthy();
      const rtu = await getRoadTrackingObject(state.rtuCode);

      const checks = [
        ['truckDrivingToPickUpLocation',       journeyDates.step1],
        ['actualArrivalAtPickUpLocation',      journeyDates.step2],
        ['loaded',                             journeyDates.step3],
        ['actualDeparturePolRoad',             journeyDates.step4],
        ['truckDrivingToDeliveryLocation',     journeyDates.step5],
        ['actualArrivalPodRoad',               journeyDates.step6],
        ['delivered',                          journeyDates.step7],
        ['truckDepartureFromDeliveryLocation', journeyDates.step8],
      ];

      for (const [field, expected] of checks) {
        assertDate(rtu, field, expected);
        console.log(`  [E-06-final] ${field} ✅`);
      }
    });

  });

  test('RD-E-07 — ETA_EVENT: correct then wrong justification_code → delivery ETA keeps first value', async () => {
    const { rtuCode, orderRef, loadSite, delSite } = await createFreshRTU();

    const date = STAGE_DATES.etaDelivery;

    // Step 1: correct conditions → sets predictedArrivalAtDeliveryLocation
    await sendAndWait(
      orderRef, 'ETA_EVENT', 'COM', 'CFM', date, loadSite, delSite,
      { eta: date, etd: null },
      { rtuCode }
    );
    let rtu = await getRoadTrackingObject(rtuCode);
    assertDate(rtu, 'predictedArrivalAtDeliveryLocation', date);

    // Step 2: wrong justification_code (ARS) → condition mismatch → field should keep original
    const t2 = new Date(new Date(date).getTime() + 3600000).toISOString();
    const payload = makeRoadPayload('ETA_EVENT', 'COM', 'ARS', t2, orderRef, loadSite, delSite, { eta: t2, etd: null });
    const ctx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });
    try {
      const res = await ctx.post(CONFIG.WEBHOOK_PATH, { headers: await webhookHeaders(), data: payload });
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    } finally { await ctx.dispose(); }

    await new Promise(r => setTimeout(r, CONFIG.POLL_INTERVAL_MS * 3));
    rtu = await getRoadTrackingObject(rtuCode);
    assertDate(rtu, 'predictedArrivalAtDeliveryLocation', date);
    console.log(`  [RD-E-07 ✅] Wrong justification → original delivery ETA kept`);
  });

});
