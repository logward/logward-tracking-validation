// @ts-nocheck
// =============================================================================
// TC003_ValidationReport.spec.js
//
// AIR TRACKING — WEBHOOK → ATU FULL VALIDATION REPORT
//
// Sends every tracked event (one at a time), captures what was sent and what
// the ATU wrote, then prints a clean per-event breakdown to the console.
//
//  Run:
//    npx playwright test tests/air/TC003_ValidationReport.spec.js --project=air
//
//  ⚠️  Always specify the file path — avoids TC001/TC002 running in parallel.
//  ⚠️  Refresh AIR_ADMIN_TOKEN before running (Cognito, expires ~1 h).
//
//  Events covered:
//    goods_delivery_compliant_compliant  (+situation_code, +justification_code)
//    Type 2 Exact       — 8 events
//    Type 3 Starts-With — 6 events (date + justification suffix each)
//    Type 4 Hub         — 8 events (DXB/FRA/SIN/AMS × arrived/left)
//    Type 4 OR-alias    — 2 events (goods_arrived_at_delivery_hub / goods_left_delivery_hub)
//    Type 5 Loading     — 3 events (manifested / eta_event / received_from_flight)
//    Type 5 Delivery    — 3 events (manifested / eta_event / received_from_flight)
//    Type 5 Hub         — 12 events (3 events × DXB/FRA/SIN/AMS)
//
//  Note: `booked` is a PASS-THROUGH (no ATU writes, no lastChangedAt update) — excluded.
//
//  Result:
//    Pass  → all ATU fields match what was sent
//    Fail  → one or more ATU fields are wrong or missing (error thrown at end)
// =============================================================================

const { test, request } = require('@playwright/test');
const { CONFIG }              = require('../../helpers/air/airConfig');
const { sendAndWait, getATU } = require('../../helpers/air/airApiHelpers');
const { valuesMatch }         = require('../../helpers/air/airValidation');
const { checkTokenExpiry }    = require('../../helpers/tokenHelper');
const { resolveHubSlot }      = require('../../helpers/air/airHubHelpers');
const {
  makePayload,
  MAIN_EVENT, MAIN_DATE, MAIN_PAYLOAD,
  MAIN_SITUATION_CODE, MAIN_JUSTIFICATION_CODE,
  SITE, toEventSite,
  T2_DATES, T3_DATES, T4_DATES, T5_DATES,
} = require('../../helpers/air/airPayloadFactory');

checkTokenExpiry(CONFIG.ADMIN_TOKEN, 'AIR_ADMIN_TOKEN', 'AIR ADMIN');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @typedef {{ field: string, expected: any, actual: any }} FieldCheck
 * @typedef {{ section: string, sent: Record<string,string>, checks: FieldCheck[] }} Section
 */

/** @type {Section[]} */
const REPORT_SECTIONS = [];

// ─────────────────────────────────────────────────────────────────────────────
// Core helper — send webhook, poll ATU, record result
// Accepts a static fieldMap object OR a factory function fieldMapFn(atu) → object.
// Returns the fresh ATU (useful for hub slot resolution in calling code).
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @param {string}               sectionLabel     display title
 * @param {object}               payload          full Shippeo webhook payload
 * @param {Record<string,string>} sent            webhook conditions shown in report
 * @param {Record<string,any> | ((atu: any) => Record<string,any>)} fieldMapOrFn
 *   Static ATU field → expected value map, OR a function that receives the ATU
 *   and returns the map (use when field names depend on resolved hub slot).
 * @returns {Promise<any>}  the ATU object returned by the BE
 */
async function fire(sectionLabel, payload, sent, fieldMapOrFn) {
  const { atu } = await sendAndWait(payload);
  const fieldMap = typeof fieldMapOrFn === 'function' ? fieldMapOrFn(atu) : fieldMapOrFn;
  REPORT_SECTIONS.push({
    section: sectionLabel,
    sent,
    checks: Object.entries(fieldMap).map(([field, expected]) => ({
      field,
      expected,
      actual: atu?.[field],
    })),
  });
  return atu;
}

// ─────────────────────────────────────────────────────────────────────────────
// Report printer
// ─────────────────────────────────────────────────────────────────────────────
const SEP  = '═'.repeat(90);
const TAIL = '─'.repeat(89);

function fmtVal(v) {
  if (v === undefined) return '(missing from ATU)';
  if (v === null)      return 'null';
  return String(v);
}

function statusIcon(actual, expected) {
  if (actual === undefined) return '⬜';
  return valuesMatch(actual, expected) ? '✅' : '❌';
}

/**
 * Print the full per-event report and return { passed, failed, missing }.
 * @param {object|null} latestATU  final ATU snapshot (for identifier section)
 */
function printReport(latestATU) {
  let passed = 0, failed = 0, missing = 0;

  console.log('\n' + SEP);
  console.log('  AIR TRACKING — WEBHOOK → ATU VALIDATION REPORT');
  console.log(`  Object  : ${latestATU?.code ?? '—'}  │  MAWB: ${CONFIG.MAWB_NUMBER}  │  CustRef: ${CONFIG.CUSTOMER_REF}`);
  console.log(`  Run at  : ${new Date().toISOString()}`);
  console.log(SEP);

  // ── Per-event sections (populated by fire()) ──────────────────────────────
  for (const { section, sent, checks } of REPORT_SECTIONS) {
    console.log(`\n┌── ${section}`);
    console.log('│');
    console.log('│  Webhook conditions sent:');
    for (const [k, v] of Object.entries(sent)) {
      console.log(`│    ${k.padEnd(36)}= "${v}"`);
    }
    console.log('│');
    console.log('│  ATU field validation:');

    const maxField = Math.max(...checks.map(c => c.field.length), 0);
    for (const chk of checks) {
      const icon = statusIcon(chk.actual, chk.expected);
      const fieldPad    = chk.field.padEnd(maxField + 2);
      const actualStr   = `actual   = "${fmtVal(chk.actual)}"`;
      const expectedStr = `expected = "${fmtVal(chk.expected)}"`;

      if (chk.actual === undefined) missing++;
      else if (icon === '✅') passed++;
      else failed++;

      console.log(`│  ${icon}  ${fieldPad}  ${actualStr.padEnd(52)}  ${expectedStr}`);
    }
    console.log('└' + TAIL);
  }

  // ── Identifiers — GET-only section ────────────────────────────────────────
  const MP = MAIN_PAYLOAD;
  console.log('\n┌── IDENTIFIERS');
  console.log('│   clientReference ← order.client_reference  (primary identifier — new single field)');
  console.log('│   DIRECT fields (written on every event): orderReference, consignmentReference, orderUrl');
  console.log('│   Removed: masterAirWaybillNumber, houseAirWaybillNumber, airCustomerReference');
  console.log('│');
  console.log('│  Webhook conditions sent (order fields on every payload):');
  console.log(`│    order.client_reference                = "${MP.order.client_reference}"`);
  console.log(`│    order.reference                       = "${MP.order.reference}"`);
  console.log(`│    order.url                             = "${MP.order.url}"`);
  console.log(`│    situation_justification.attributes`);
  console.log(`│      .consignmentReference               = "${MP.situation_justification.attributes.consignmentReference}"`);
  console.log('│');
  console.log('│  ATU field validation:');
  const idChecks = [
    ['clientReference',      MP.order.client_reference],
    ['orderReference',       MP.order.reference],
    ['consignmentReference', MP.situation_justification.attributes.consignmentReference],
    ['orderUrl',             MP.order.url],
  ];
  for (const [field, expected] of idChecks) {
    const actual = latestATU?.[field];
    const icon   = statusIcon(actual, expected);
    if (actual === undefined) missing++; else if (icon === '✅') passed++; else failed++;
    console.log(`│  ${icon}  ${field.padEnd(32)}  actual   = "${fmtVal(actual)}"`
      + `  expected = "${fmtVal(expected)}"`);
  }
  console.log('└' + TAIL);

  // ── Summary ────────────────────────────────────────────────────────────────
  const total = passed + failed + missing;
  console.log('\n' + SEP);
  console.log('  SUMMARY');
  console.log(`  Total fields checked : ${total}`);
  console.log(`  ✅  Passed           : ${passed}`);
  console.log(`  ❌  Failed           : ${failed}`);
  console.log(`  ⬜  Missing from ATU : ${missing}`);
  console.log(SEP + '\n');

  return { passed, failed, missing };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hub field map factory — returns all 7 hub event fields for a given slot+site
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @param {number} slot        hub stop number (1–4)
 * @param {object} site        SITE.DXB / SITE.FRA / etc.
 * @param {string} dateField   e.g. 'hubArrivedDate' or 'hubLeftDate' or 'hubManifestedDate'
 * @param {string} dateValue   ISO date string
 */
function hubFields(slot, site, dateField, dateValue) {
  return {
    [`${dateField}_stop${slot}`]:           dateValue,
    [`hubSiteDescription_stop${slot}`]:     site.description,
    [`hubSiteIata_stop${slot}`]:            site.iata_code,
    [`hubSiteAddressLine_stop${slot}`]:     site.address_line,
    [`hubSiteCity_stop${slot}`]:            site.city,
    [`hubSiteZipcode_stop${slot}`]:         site.zipcode,
    [`hubSiteCountry_stop${slot}`]:         site.country,
  };
}

/** Resolve hub slot from ATU; returns 0 (invalid) if not found. */
function slotFor(atu, site) {
  return atu ? (resolveHubSlot(atu, site.iata_code, site.country) ?? 0) : 0;
}

// =============================================================================
// TEST
// =============================================================================
test.describe('Air — TC003: Webhook → ATU Validation Report', () => {

  test('TC-R-01 | Full webhook → ATU validation report (all events)', async () => {

    test.setTimeout(1_200_000); // up to 20 min — sends ~37 sequential webhooks

    // ── goods_delivery_compliant_compliant ──────────────────────────────────
    await fire(
      'goods_delivery_compliant_compliant',
      MAIN_PAYLOAD,
      {
        'situation.event':              MAIN_EVENT,
        'situation.date':               MAIN_DATE,
        'situation.situation_code':     MAIN_SITUATION_CODE,
        'situation.justification_code': MAIN_JUSTIFICATION_CODE,
        'event_site.iata_code':         SITE.BOM.iata_code,
      },
      {
        deliveryCompliantDate:              MAIN_DATE,
        deliveryCompliantSituationCode:     MAIN_SITUATION_CODE,
        deliveryCompliantJustificationCode: MAIN_JUSTIFICATION_CODE,
      },
    );

    // ── TYPE 2 EXACT ──────────────────────────────────────────────────────────

    await fire(
      'received_from_shipper  [Type 2]',
      makePayload('received_from_shipper', T2_DATES.received_from_shipper, toEventSite(SITE.BLR)),
      {
        'situation.event':      'received_from_shipper',
        'situation.date':       T2_DATES.received_from_shipper,
        'event_site.iata_code': SITE.BLR.iata_code,
      },
      { receivedFromShipperDate: T2_DATES.received_from_shipper },
    );

    await fire(
      'goods_arrived_at_loading_arrived  [Type 2]',
      makePayload('goods_arrived_at_loading_arrived', T2_DATES.goods_arrived_at_loading_arrived, toEventSite(SITE.BLR)),
      {
        'situation.event':      'goods_arrived_at_loading_arrived',
        'situation.date':       T2_DATES.goods_arrived_at_loading_arrived,
        'event_site.iata_code': SITE.BLR.iata_code,
      },
      { loadingArrivedDate: T2_DATES.goods_arrived_at_loading_arrived },
    );

    await fire(
      'goods_loading_compliant_compliant  [Type 2]',
      makePayload('goods_loading_compliant_compliant', T2_DATES.goods_loading_compliant_compliant, toEventSite(SITE.BLR)),
      {
        'situation.event':      'goods_loading_compliant_compliant',
        'situation.date':       T2_DATES.goods_loading_compliant_compliant,
        'event_site.iata_code': SITE.BLR.iata_code,
      },
      { loadingCompliantDate: T2_DATES.goods_loading_compliant_compliant },
    );

    await fire(
      'goods_left_loading_left  [Type 2]',
      makePayload('goods_left_loading_left', T2_DATES.goods_left_loading_left, toEventSite(SITE.BLR)),
      {
        'situation.event':      'goods_left_loading_left',
        'situation.date':       T2_DATES.goods_left_loading_left,
        'event_site.iata_code': SITE.BLR.iata_code,
      },
      { loadingLeftDate: T2_DATES.goods_left_loading_left },
    );

    await fire(
      'goods_arrived_at_delivery_arrived  [Type 2]',
      makePayload('goods_arrived_at_delivery_arrived', T2_DATES.goods_arrived_at_delivery_arrived, toEventSite(SITE.BOM)),
      {
        'situation.event':      'goods_arrived_at_delivery_arrived',
        'situation.date':       T2_DATES.goods_arrived_at_delivery_arrived,
        'event_site.iata_code': SITE.BOM.iata_code,
      },
      { deliveryArrivedDate: T2_DATES.goods_arrived_at_delivery_arrived },
    );

    await fire(
      'goods_left_delivery_left  [Type 2]',
      makePayload('goods_left_delivery_left', T2_DATES.goods_left_delivery_left, toEventSite(SITE.BOM)),
      {
        'situation.event':      'goods_left_delivery_left',
        'situation.date':       T2_DATES.goods_left_delivery_left,
        'event_site.iata_code': SITE.BOM.iata_code,
      },
      { deliveryLeftDate: T2_DATES.goods_left_delivery_left },
    );

    await fire(
      'documentation_delivered  [Type 2]',
      makePayload('documentation_delivered', T2_DATES.documentation_delivered, toEventSite(SITE.BOM)),
      {
        'situation.event':      'documentation_delivered',
        'situation.date':       T2_DATES.documentation_delivered,
        'event_site.iata_code': SITE.BOM.iata_code,
      },
      { documentationDeliveredDate: T2_DATES.documentation_delivered },
    );

    await fire(
      'consignee_notified  [Type 2]',
      makePayload('consignee_notified', T2_DATES.consignee_notified, toEventSite(SITE.BOM)),
      {
        'situation.event':      'consignee_notified',
        'situation.date':       T2_DATES.consignee_notified,
        'event_site.iata_code': SITE.BOM.iata_code,
      },
      { consigneeNotifiedDate: T2_DATES.consignee_notified },
    );

    // ── TYPE 3 STARTS-WITH ────────────────────────────────────────────────────
    // Justification → BE writes only the suffix (last segment of event name)

    await fire(
      'goods_loading_non_compliant_damaged  [Type 3]',
      makePayload('goods_loading_non_compliant_damaged', T3_DATES.goods_loading_non_compliant_damaged, toEventSite(SITE.BLR)),
      {
        'situation.event':      'goods_loading_non_compliant_damaged',
        'situation.date':       T3_DATES.goods_loading_non_compliant_damaged,
        'event_site.iata_code': SITE.BLR.iata_code,
      },
      {
        loadingNonCompliantDate:          T3_DATES.goods_loading_non_compliant_damaged,
        loadingNonCompliantJustification: 'damaged',
      },
    );

    await fire(
      'goods_loading_non_realised_cancelled  [Type 3]',
      makePayload('goods_loading_non_realised_cancelled', T3_DATES.goods_loading_non_realised_cancelled, toEventSite(SITE.BLR)),
      {
        'situation.event':      'goods_loading_non_realised_cancelled',
        'situation.date':       T3_DATES.goods_loading_non_realised_cancelled,
        'event_site.iata_code': SITE.BLR.iata_code,
      },
      {
        loadingNonRealisedDate:          T3_DATES.goods_loading_non_realised_cancelled,
        loadingNonRealisedJustification: 'cancelled',
      },
    );

    await fire(
      'goods_loading_refused_oversize  [Type 3]',
      makePayload('goods_loading_refused_oversize', T3_DATES.goods_loading_refused_oversize, toEventSite(SITE.BLR)),
      {
        'situation.event':      'goods_loading_refused_oversize',
        'situation.date':       T3_DATES.goods_loading_refused_oversize,
        'event_site.iata_code': SITE.BLR.iata_code,
      },
      {
        loadingRefusedDate:          T3_DATES.goods_loading_refused_oversize,
        loadingRefusedJustification: 'oversize',
      },
    );

    await fire(
      'goods_delivery_non_compliant_pilferage  [Type 3]',
      makePayload('goods_delivery_non_compliant_pilferage', T3_DATES.goods_delivery_non_compliant_pilferage, toEventSite(SITE.BOM)),
      {
        'situation.event':      'goods_delivery_non_compliant_pilferage',
        'situation.date':       T3_DATES.goods_delivery_non_compliant_pilferage,
        'event_site.iata_code': SITE.BOM.iata_code,
      },
      {
        deliveryNonCompliantDate:          T3_DATES.goods_delivery_non_compliant_pilferage,
        deliveryNonCompliantJustification: 'pilferage',
      },
    );

    await fire(
      'goods_delivery_non_realised_recipient_closed  [Type 3]',
      makePayload('goods_delivery_non_realised_recipient_closed', T3_DATES.goods_delivery_non_realised_recipient_closed, toEventSite(SITE.BOM)),
      {
        'situation.event':      'goods_delivery_non_realised_recipient_closed',
        'situation.date':       T3_DATES.goods_delivery_non_realised_recipient_closed,
        'event_site.iata_code': SITE.BOM.iata_code,
      },
      {
        deliveryNonRealisedDate:          T3_DATES.goods_delivery_non_realised_recipient_closed,
        deliveryNonRealisedJustification: 'recipient_closed',
      },
    );

    await fire(
      'goods_delivery_refused_not_ordered  [Type 3]',
      makePayload('goods_delivery_refused_not_ordered', T3_DATES.goods_delivery_refused_not_ordered, toEventSite(SITE.BOM)),
      {
        'situation.event':      'goods_delivery_refused_not_ordered',
        'situation.date':       T3_DATES.goods_delivery_refused_not_ordered,
        'event_site.iata_code': SITE.BOM.iata_code,
      },
      {
        deliveryRefusedDate:          T3_DATES.goods_delivery_refused_not_ordered,
        deliveryRefusedJustification: 'not_ordered',
      },
    );

    // ── TYPE 4 HUB — DXB (stop 1) ─────────────────────────────────────────────
    // Slot resolved dynamically from the returned ATU

    await fire(
      'goods_arrived_at_hub_arrived  [Type 4 / DXB]',
      makePayload('goods_arrived_at_hub_arrived', T4_DATES.dxbArrived, toEventSite(SITE.DXB)),
      {
        'situation.event':      'goods_arrived_at_hub_arrived',
        'situation.date':       T4_DATES.dxbArrived,
        'event_site.iata_code': SITE.DXB.iata_code,
        'event_site.country':   SITE.DXB.country,
      },
      (atu) => {
        const slot = slotFor(atu, SITE.DXB);
        return hubFields(slot, SITE.DXB, 'hubArrivedDate', T4_DATES.dxbArrived);
      },
    );

    await fire(
      'goods_left_hub_left  [Type 4 / DXB]',
      makePayload('goods_left_hub_left', T4_DATES.dxbLeft, toEventSite(SITE.DXB)),
      {
        'situation.event':      'goods_left_hub_left',
        'situation.date':       T4_DATES.dxbLeft,
        'event_site.iata_code': SITE.DXB.iata_code,
        'event_site.country':   SITE.DXB.country,
      },
      (atu) => {
        const slot = slotFor(atu, SITE.DXB);
        return hubFields(slot, SITE.DXB, 'hubLeftDate', T4_DATES.dxbLeft);
      },
    );

    // ── TYPE 4 HUB — FRA (stop 2) ─────────────────────────────────────────────

    await fire(
      'goods_arrived_at_hub_arrived  [Type 4 / FRA]',
      makePayload('goods_arrived_at_hub_arrived', T4_DATES.fraArrived, toEventSite(SITE.FRA)),
      {
        'situation.event':      'goods_arrived_at_hub_arrived',
        'situation.date':       T4_DATES.fraArrived,
        'event_site.iata_code': SITE.FRA.iata_code,
        'event_site.country':   SITE.FRA.country,
      },
      (atu) => {
        const slot = slotFor(atu, SITE.FRA);
        return hubFields(slot, SITE.FRA, 'hubArrivedDate', T4_DATES.fraArrived);
      },
    );

    await fire(
      'goods_left_hub_left  [Type 4 / FRA]',
      makePayload('goods_left_hub_left', T4_DATES.fraLeft, toEventSite(SITE.FRA)),
      {
        'situation.event':      'goods_left_hub_left',
        'situation.date':       T4_DATES.fraLeft,
        'event_site.iata_code': SITE.FRA.iata_code,
        'event_site.country':   SITE.FRA.country,
      },
      (atu) => {
        const slot = slotFor(atu, SITE.FRA);
        return hubFields(slot, SITE.FRA, 'hubLeftDate', T4_DATES.fraLeft);
      },
    );

    // ── TYPE 4 HUB — SIN (stop 3) ─────────────────────────────────────────────

    await fire(
      'goods_arrived_at_hub_arrived  [Type 4 / SIN]',
      makePayload('goods_arrived_at_hub_arrived', T4_DATES.sinArrived, toEventSite(SITE.SIN)),
      {
        'situation.event':      'goods_arrived_at_hub_arrived',
        'situation.date':       T4_DATES.sinArrived,
        'event_site.iata_code': SITE.SIN.iata_code,
        'event_site.country':   SITE.SIN.country,
      },
      (atu) => {
        const slot = slotFor(atu, SITE.SIN);
        return hubFields(slot, SITE.SIN, 'hubArrivedDate', T4_DATES.sinArrived);
      },
    );

    await fire(
      'goods_left_hub_left  [Type 4 / SIN]',
      makePayload('goods_left_hub_left', T4_DATES.sinLeft, toEventSite(SITE.SIN)),
      {
        'situation.event':      'goods_left_hub_left',
        'situation.date':       T4_DATES.sinLeft,
        'event_site.iata_code': SITE.SIN.iata_code,
        'event_site.country':   SITE.SIN.country,
      },
      (atu) => {
        const slot = slotFor(atu, SITE.SIN);
        return hubFields(slot, SITE.SIN, 'hubLeftDate', T4_DATES.sinLeft);
      },
    );

    // ── TYPE 4 HUB — AMS (stop 4) ─────────────────────────────────────────────

    await fire(
      'goods_arrived_at_hub_arrived  [Type 4 / AMS]',
      makePayload('goods_arrived_at_hub_arrived', T4_DATES.amsArrived, toEventSite(SITE.AMS)),
      {
        'situation.event':      'goods_arrived_at_hub_arrived',
        'situation.date':       T4_DATES.amsArrived,
        'event_site.iata_code': SITE.AMS.iata_code,
        'event_site.country':   SITE.AMS.country,
      },
      (atu) => {
        const slot = slotFor(atu, SITE.AMS);
        return hubFields(slot, SITE.AMS, 'hubArrivedDate', T4_DATES.amsArrived);
      },
    );

    await fire(
      'goods_left_hub_left  [Type 4 / AMS]',
      makePayload('goods_left_hub_left', T4_DATES.amsLeft, toEventSite(SITE.AMS)),
      {
        'situation.event':      'goods_left_hub_left',
        'situation.date':       T4_DATES.amsLeft,
        'event_site.iata_code': SITE.AMS.iata_code,
        'event_site.country':   SITE.AMS.country,
      },
      (atu) => {
        const slot = slotFor(atu, SITE.AMS);
        return hubFields(slot, SITE.AMS, 'hubLeftDate', T4_DATES.amsLeft);
      },
    );

    // ── TYPE 4 HUB — OR alias (DXB) ──────────────────────────────────────────
    // goods_arrived_at_delivery_hub_arrived / goods_left_delivery_hub_left
    // These are OR aliases that map to the same hub slot logic as Type 4.

    await fire(
      'goods_arrived_at_delivery_hub_arrived  [Type 4 OR-alias / DXB]',
      makePayload('goods_arrived_at_delivery_hub_arrived', T4_DATES.deliveryHubDXB, toEventSite(SITE.DXB)),
      {
        'situation.event':      'goods_arrived_at_delivery_hub_arrived',
        'situation.date':       T4_DATES.deliveryHubDXB,
        'event_site.iata_code': SITE.DXB.iata_code,
        'event_site.country':   SITE.DXB.country,
      },
      (atu) => {
        const slot = slotFor(atu, SITE.DXB);
        return hubFields(slot, SITE.DXB, 'hubArrivedDate', T4_DATES.deliveryHubDXB);
      },
    );

    await fire(
      'goods_left_delivery_hub_left  [Type 4 OR-alias / DXB]',
      makePayload('goods_left_delivery_hub_left', T4_DATES.deliveryHubLeft, toEventSite(SITE.DXB)),
      {
        'situation.event':      'goods_left_delivery_hub_left',
        'situation.date':       T4_DATES.deliveryHubLeft,
        'event_site.iata_code': SITE.DXB.iata_code,
        'event_site.country':   SITE.DXB.country,
      },
      (atu) => {
        const slot = slotFor(atu, SITE.DXB);
        return hubFields(slot, SITE.DXB, 'hubLeftDate', T4_DATES.deliveryHubLeft);
      },
    );

    // ── TYPE 5 ROUTING — loading context ─────────────────────────────────────
    // event_site.iata_code == ATU.loadingSiteIata  AND
    // event_site.country   == ATU.loadingSiteCountry  → "loading" prefix
    // (booked is PASS-THROUGH — excluded)

    await fire(
      'manifested  [Type 5 / loading — event_site=BLR/IN]',
      makePayload('manifested', T5_DATES.manifested.loading, toEventSite(SITE.BLR)),
      {
        'situation.event':      'manifested',
        'situation.date':       T5_DATES.manifested.loading,
        'event_site.iata_code': SITE.BLR.iata_code,
        'event_site.country':   SITE.BLR.country + '  →  matches loadingSite IATA+Country → loading prefix',
      },
      { loadingManifestedDate: T5_DATES.manifested.loading },
    );

    await fire(
      'eta_event  [Type 5 / loading — event_site=BLR/IN]',
      makePayload('eta_event', T5_DATES.eta_event.loading, toEventSite(SITE.BLR)),
      {
        'situation.event':      'eta_event',
        'situation.date':       T5_DATES.eta_event.loading,
        'event_site.iata_code': SITE.BLR.iata_code,
        'event_site.country':   SITE.BLR.country + '  →  matches loadingSite IATA+Country → loading prefix',
      },
      { loadingETADate: T5_DATES.eta_event.loading },
    );

    await fire(
      'received_from_flight  [Type 5 / loading — event_site=BLR/IN]',
      makePayload('received_from_flight', T5_DATES.received_from_flight.loading, toEventSite(SITE.BLR)),
      {
        'situation.event':      'received_from_flight',
        'situation.date':       T5_DATES.received_from_flight.loading,
        'event_site.iata_code': SITE.BLR.iata_code,
        'event_site.country':   SITE.BLR.country + '  →  matches loadingSite IATA+Country → loading prefix',
      },
      { loadingReceivedFromFlightDate: T5_DATES.received_from_flight.loading },
    );

    // ── TYPE 5 ROUTING — delivery context ────────────────────────────────────
    // event_site.iata_code == ATU.deliverySiteIata  AND
    // event_site.country   == ATU.deliverySiteCountry  → "delivery" prefix
    // (booked is PASS-THROUGH — excluded)

    await fire(
      'manifested  [Type 5 / delivery — event_site=BOM/IN]',
      makePayload('manifested', T5_DATES.manifested.delivery, toEventSite(SITE.BOM)),
      {
        'situation.event':      'manifested',
        'situation.date':       T5_DATES.manifested.delivery,
        'event_site.iata_code': SITE.BOM.iata_code,
        'event_site.country':   SITE.BOM.country + '  →  matches deliverySite IATA+Country → delivery prefix',
      },
      { deliveryManifestedDate: T5_DATES.manifested.delivery },
    );

    await fire(
      'eta_event  [Type 5 / delivery — event_site=BOM/IN]',
      makePayload('eta_event', T5_DATES.eta_event.delivery, toEventSite(SITE.BOM)),
      {
        'situation.event':      'eta_event',
        'situation.date':       T5_DATES.eta_event.delivery,
        'event_site.iata_code': SITE.BOM.iata_code,
        'event_site.country':   SITE.BOM.country + '  →  matches deliverySite IATA+Country → delivery prefix',
      },
      { deliveryETADate: T5_DATES.eta_event.delivery },
    );

    await fire(
      'received_from_flight  [Type 5 / delivery — event_site=BOM/IN]',
      makePayload('received_from_flight', T5_DATES.received_from_flight.delivery, toEventSite(SITE.BOM)),
      {
        'situation.event':      'received_from_flight',
        'situation.date':       T5_DATES.received_from_flight.delivery,
        'event_site.iata_code': SITE.BOM.iata_code,
        'event_site.country':   SITE.BOM.country + '  →  matches deliverySite IATA+Country → delivery prefix',
      },
      { deliveryReceivedFromFlightDate: T5_DATES.received_from_flight.delivery },
    );

    // ── TYPE 5 ROUTING — hub context (DXB / stop 1) ──────────────────────────
    // event_site does NOT match loadingSite or deliverySite → hub prefix
    // (booked is PASS-THROUGH — excluded)

    await fire(
      'manifested  [Type 5 / hub DXB]',
      makePayload('manifested', T5_DATES.manifested.hub, toEventSite(SITE.DXB)),
      {
        'situation.event':      'manifested',
        'situation.date':       T5_DATES.manifested.hub,
        'event_site.iata_code': SITE.DXB.iata_code,
        'event_site.country':   SITE.DXB.country + '  →  no loading/delivery match → hub prefix',
      },
      (atu) => {
        const slot = slotFor(atu, SITE.DXB);
        return hubFields(slot, SITE.DXB, 'hubManifestedDate', T5_DATES.manifested.hub);
      },
    );

    await fire(
      'eta_event  [Type 5 / hub DXB]',
      makePayload('eta_event', T5_DATES.eta_event.hub, toEventSite(SITE.DXB)),
      {
        'situation.event':      'eta_event',
        'situation.date':       T5_DATES.eta_event.hub,
        'event_site.iata_code': SITE.DXB.iata_code,
        'event_site.country':   SITE.DXB.country + '  →  no loading/delivery match → hub prefix',
      },
      (atu) => {
        const slot = slotFor(atu, SITE.DXB);
        return hubFields(slot, SITE.DXB, 'hubETADate', T5_DATES.eta_event.hub);
      },
    );

    await fire(
      'received_from_flight  [Type 5 / hub DXB]',
      makePayload('received_from_flight', T5_DATES.received_from_flight.hub, toEventSite(SITE.DXB)),
      {
        'situation.event':      'received_from_flight',
        'situation.date':       T5_DATES.received_from_flight.hub,
        'event_site.iata_code': SITE.DXB.iata_code,
        'event_site.country':   SITE.DXB.country + '  →  no loading/delivery match → hub prefix',
      },
      (atu) => {
        const slot = slotFor(atu, SITE.DXB);
        return hubFields(slot, SITE.DXB, 'hubReceivedFromFlightDate', T5_DATES.received_from_flight.hub);
      },
    );

    // ── TYPE 5 ROUTING — hub context (FRA / stop 2) ──────────────────────────

    await fire(
      'manifested  [Type 5 / hub FRA]',
      makePayload('manifested', T5_DATES.manifested.hubFRA, toEventSite(SITE.FRA)),
      {
        'situation.event':      'manifested',
        'situation.date':       T5_DATES.manifested.hubFRA,
        'event_site.iata_code': SITE.FRA.iata_code,
        'event_site.country':   SITE.FRA.country + '  →  no loading/delivery match → hub prefix',
      },
      (atu) => {
        const slot = slotFor(atu, SITE.FRA);
        return hubFields(slot, SITE.FRA, 'hubManifestedDate', T5_DATES.manifested.hubFRA);
      },
    );

    await fire(
      'eta_event  [Type 5 / hub FRA]',
      makePayload('eta_event', T5_DATES.eta_event.hubFRA, toEventSite(SITE.FRA)),
      {
        'situation.event':      'eta_event',
        'situation.date':       T5_DATES.eta_event.hubFRA,
        'event_site.iata_code': SITE.FRA.iata_code,
        'event_site.country':   SITE.FRA.country + '  →  no loading/delivery match → hub prefix',
      },
      (atu) => {
        const slot = slotFor(atu, SITE.FRA);
        return hubFields(slot, SITE.FRA, 'hubETADate', T5_DATES.eta_event.hubFRA);
      },
    );

    await fire(
      'received_from_flight  [Type 5 / hub FRA]',
      makePayload('received_from_flight', T5_DATES.received_from_flight.hubFRA, toEventSite(SITE.FRA)),
      {
        'situation.event':      'received_from_flight',
        'situation.date':       T5_DATES.received_from_flight.hubFRA,
        'event_site.iata_code': SITE.FRA.iata_code,
        'event_site.country':   SITE.FRA.country + '  →  no loading/delivery match → hub prefix',
      },
      (atu) => {
        const slot = slotFor(atu, SITE.FRA);
        return hubFields(slot, SITE.FRA, 'hubReceivedFromFlightDate', T5_DATES.received_from_flight.hubFRA);
      },
    );

    // ── TYPE 5 ROUTING — hub context (SIN / stop 3) ──────────────────────────

    await fire(
      'manifested  [Type 5 / hub SIN]',
      makePayload('manifested', T5_DATES.manifested.hubSIN, toEventSite(SITE.SIN)),
      {
        'situation.event':      'manifested',
        'situation.date':       T5_DATES.manifested.hubSIN,
        'event_site.iata_code': SITE.SIN.iata_code,
        'event_site.country':   SITE.SIN.country + '  →  no loading/delivery match → hub prefix',
      },
      (atu) => {
        const slot = slotFor(atu, SITE.SIN);
        return hubFields(slot, SITE.SIN, 'hubManifestedDate', T5_DATES.manifested.hubSIN);
      },
    );

    await fire(
      'eta_event  [Type 5 / hub SIN]',
      makePayload('eta_event', T5_DATES.eta_event.hubSIN, toEventSite(SITE.SIN)),
      {
        'situation.event':      'eta_event',
        'situation.date':       T5_DATES.eta_event.hubSIN,
        'event_site.iata_code': SITE.SIN.iata_code,
        'event_site.country':   SITE.SIN.country + '  →  no loading/delivery match → hub prefix',
      },
      (atu) => {
        const slot = slotFor(atu, SITE.SIN);
        return hubFields(slot, SITE.SIN, 'hubETADate', T5_DATES.eta_event.hubSIN);
      },
    );

    await fire(
      'received_from_flight  [Type 5 / hub SIN]',
      makePayload('received_from_flight', T5_DATES.received_from_flight.hubSIN, toEventSite(SITE.SIN)),
      {
        'situation.event':      'received_from_flight',
        'situation.date':       T5_DATES.received_from_flight.hubSIN,
        'event_site.iata_code': SITE.SIN.iata_code,
        'event_site.country':   SITE.SIN.country + '  →  no loading/delivery match → hub prefix',
      },
      (atu) => {
        const slot = slotFor(atu, SITE.SIN);
        return hubFields(slot, SITE.SIN, 'hubReceivedFromFlightDate', T5_DATES.received_from_flight.hubSIN);
      },
    );

    // ── TYPE 5 ROUTING — hub context (AMS / stop 4) ──────────────────────────

    await fire(
      'manifested  [Type 5 / hub AMS]',
      makePayload('manifested', T5_DATES.manifested.hubAMS, toEventSite(SITE.AMS)),
      {
        'situation.event':      'manifested',
        'situation.date':       T5_DATES.manifested.hubAMS,
        'event_site.iata_code': SITE.AMS.iata_code,
        'event_site.country':   SITE.AMS.country + '  →  no loading/delivery match → hub prefix',
      },
      (atu) => {
        const slot = slotFor(atu, SITE.AMS);
        return hubFields(slot, SITE.AMS, 'hubManifestedDate', T5_DATES.manifested.hubAMS);
      },
    );

    await fire(
      'eta_event  [Type 5 / hub AMS]',
      makePayload('eta_event', T5_DATES.eta_event.hubAMS, toEventSite(SITE.AMS)),
      {
        'situation.event':      'eta_event',
        'situation.date':       T5_DATES.eta_event.hubAMS,
        'event_site.iata_code': SITE.AMS.iata_code,
        'event_site.country':   SITE.AMS.country + '  →  no loading/delivery match → hub prefix',
      },
      (atu) => {
        const slot = slotFor(atu, SITE.AMS);
        return hubFields(slot, SITE.AMS, 'hubETADate', T5_DATES.eta_event.hubAMS);
      },
    );

    await fire(
      'received_from_flight  [Type 5 / hub AMS]',
      makePayload('received_from_flight', T5_DATES.received_from_flight.hubAMS, toEventSite(SITE.AMS)),
      {
        'situation.event':      'received_from_flight',
        'situation.date':       T5_DATES.received_from_flight.hubAMS,
        'event_site.iata_code': SITE.AMS.iata_code,
        'event_site.country':   SITE.AMS.country + '  →  no loading/delivery match → hub prefix',
      },
      (atu) => {
        const slot = slotFor(atu, SITE.AMS);
        return hubFields(slot, SITE.AMS, 'hubReceivedFromFlightDate', T5_DATES.received_from_flight.hubAMS);
      },
    );

    // ── Fetch latest ATU for identifier section ───────────────────────────────
    const adminCtx  = await request.newContext({ baseURL: CONFIG.ADMIN_BASE_URL });
    const latestATU = await getATU(adminCtx).catch(() => null);
    await adminCtx.dispose();

    // ── Print full report ─────────────────────────────────────────────────────
    const { failed, missing } = printReport(latestATU);

    // Fail the Playwright test if any field is wrong or missing
    if (failed > 0 || missing > 0) {
      throw new Error(
        `Validation report: ${failed} field(s) FAILED, ${missing} field(s) MISSING from ATU.\n` +
        `See the report above for details.`
      );
    }

  }); // end TC-R-01

}); // end TC003
