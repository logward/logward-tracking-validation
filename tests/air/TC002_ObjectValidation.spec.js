// =============================================================================
// TC002_ObjectValidation.spec.js
//
// AIR TRACKING — ATU OBJECT FIELD VALIDATION (per-event, per-timestamp)
// Reference: Air Events Mapping V3 / data/airFieldMappings.js
//
// ─── TEST STRUCTURE ───────────────────────────────────────────────────────────
//
//  D-01  Loading + Delivery Site (12 fields in 1 test, GET-only — no webhook)
//        On fresh ATU: auto-seeds via received_from_shipper (one-time only)
//  D-03  Identifiers             (GET-only — no webhook)
//
//  goods_delivery_compliant_compliant (own beforeAll → 1 webhook)
//    deliveryCompliantDate              ← individual test
//    deliveryCompliantSituationCode     ← individual test (null)
//    deliveryCompliantJustificationCode ← individual test (null)
//
//  Each TYPE 2 event   (own beforeAll → 1 webhook each)
//    <event>Date        ← individual test
//
//  Each TYPE 3 event   (own beforeAll → 1 webhook each)
//    <event>Date           ← individual test
//    <event>Justification  ← individual test (full event name written by BE)
//
//  Hub Slot  (own beforeAll → 1 webhook each, skipped for now)
//    hubArrivedDate_stopN / hubLeftDate_stopN  ← individual tests
//
//  Each TYPE 5 routing event (own beforeAll → 1 webhook each)
//    loading<X>Date   ← individual test  (event_site.iata == loadingSiteIata)
//    delivery<X>Date  ← individual test  (event_site.iata == deliverySiteIata)
//    hub<X>Date_stopN ← individual test  (event_site.iata = neither → hub)
//
//  NOTE: Event-specific site fields (deliveryCompliantSiteIata, loadingBookedSiteIata,
//        hubArrivedSiteIata_stop*, etc.) do NOT exist in the ATU schema.
//        Only loadingSite* and deliverySite* (Type 1 Direct) are stored.
//
// ─── GRANULAR RUN EXAMPLES ───────────────────────────────────────────────────
//  npx playwright test tests/air/TC002_ObjectValidation.spec.js --project=air -g "D-01"
//  npx playwright test tests/air/TC002_ObjectValidation.spec.js --project=air -g "loadingBookedDate"
//  npx playwright test tests/air/TC002_ObjectValidation.spec.js --project=air -g "deliveryBookedDate"
//  npx playwright test tests/air/TC002_ObjectValidation.spec.js --project=air -g "delivery"
//  npx playwright test tests/air/TC002_ObjectValidation.spec.js --project=air          (full suite)
//
//  ⚠️  Always specify the file path to avoid TC001 also running and sending duplicate webhooks.
//
// BEFORE RUNNING — refresh the admin token (Cognito, expires every ~1 hour):
//   export AIR_ADMIN_TOKEN="eyJ..."
// =============================================================================

// @ts-nocheck   (payload shapes are dynamic; runtime behaviour is correct)
const { test, expect, request } = require('@playwright/test');

const { CONFIG }               = require('../../helpers/air/airConfig');
const { sendAndWait, getATU }  = require('../../helpers/air/airApiHelpers');
const { resolveHubSlot }       = require('../../helpers/air/airHubHelpers');
const { assertField, valuesMatch } = require('../../helpers/air/airValidation');
const { checkTokenExpiry }     = require('../../helpers/tokenHelper');
const {
  makePayload,
  runDate,
  MAIN_EVENT, MAIN_DATE, MAIN_PAYLOAD,
  MAIN_SITUATION_CODE, MAIN_JUSTIFICATION_CODE,
  SITE, toEventSite,
  T2_DATES, T3_DATES, T4_DATES, T5_DATES,
} = require('../../helpers/air/airPayloadFactory');

// ── Token expiry warning at startup ──────────────────────────────────────────
checkTokenExpiry(CONFIG.ADMIN_TOKEN, 'AIR_ADMIN_TOKEN', 'AIR ADMIN');
// ─────────────────────────────────────────────────────────────────────────────

const MP = /** @type {any} */ (MAIN_PAYLOAD);

// ─────────────────────────────────────────────────────────────────────────────
// Shared GET-only helper: reads current ATU without sending any webhook.
// Used by D-01 and D-03 so those tests never trigger timestamp writes.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchATU() {
  const ctx = await request.newContext({ baseURL: CONFIG.ADMIN_BASE_URL });
  const atu = await getATU(ctx).catch(() => null);
  await ctx.dispose();
  return atu;
}

// =============================================================================
test.describe('Air — TC002: ATU Object Field Validation (All Events)', () => {

  // D-01 removed — loading/delivery site address fields no longer written by webhook events.

  // ═══════════════════════════════════════════════════════════════════════════
  // D-03 — Identifiers  (GET-only — NO webhook sent)
  //
  //  clientReference ← order.client_reference  (primary identifier; new single field)
  //  orderReference, consignmentReference, orderUrl  ← DIRECT fields (written every event)
  //
  //  Removed: masterAirWaybillNumber, houseAirWaybillNumber, airCustomerReference
  //  (schema change — replaced by single clientReference field)
  //
  //  npx playwright test --project=air -g "D-03"
  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('D-03 | Identifiers (GET-only, no webhook)', () => {

    /** @type {any} */ let atu = null;

    test.beforeAll(async () => {
      console.log('\n[D-03] Reading ATU (GET-only — no webhook) …');
      atu = await fetchATU();
    });

    test.beforeEach(() => { if (!atu) test.skip(); });

    test('D-03 | Identifiers — clientReference | orderRef | consignmentRef | orderUrl', () => {
      assertField(atu, 'clientReference',      MP.order.client_reference);
      assertField(atu, 'orderReference',       MP.order.reference);
      assertField(atu, 'consignmentReference', MP.situation_justification.attributes.consignmentReference);
      assertField(atu, 'orderUrl',             MP.order.url);
    });

  }); // end D-03

  // ═══════════════════════════════════════════════════════════════════════════
  // goods_delivery_compliant_compliant  (own beforeAll → 1 webhook)
  //
  //  Also covers D-04 (Situation metadata) and D-05 (Tags) since those fields
  //  reflect the most-recently-sent event — they are validated here against the
  //  known MAIN_PAYLOAD values.
  //
  //  npx playwright test --project=air -g "goods_delivery_compliant_compliant"
  //  npx playwright test --project=air -g "D-04"
  //  npx playwright test --project=air -g "D-05"
  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('goods_delivery_compliant_compliant', () => {

    /** @type {any} */ let mainATU = null;

    test.beforeAll(async () => {
      console.log(`\n[goods_delivery_compliant] Sending MAIN event: ${MAIN_EVENT} …`);
      ({ atu: mainATU } = await sendAndWait(MAIN_PAYLOAD));
      console.log(`[goods_delivery_compliant] mainATU changedAt=${mainATU?.changedAt}`);
    });

    test.beforeEach(() => { if (!mainATU) test.skip(); });

    // ── Event-specific fields ─────────────────────────────────────────────────
    test('deliveryCompliantDate ← situation.date', () =>
      assertField(mainATU, 'deliveryCompliantDate', MP.situation.date));

    test('deliveryCompliantSituationCode ← situation.situation_code', () =>
      assertField(mainATU, 'deliveryCompliantSituationCode', MAIN_SITUATION_CODE));

    test('deliveryCompliantJustificationCode ← situation.justification_code', () =>
      assertField(mainATU, 'deliveryCompliantJustificationCode', MAIN_JUSTIFICATION_CODE));

  }); // end goods_delivery_compliant_compliant

  // ═══════════════════════════════════════════════════════════════════════════
  // TYPE 2 EXACT — each event has its own describe + beforeAll
  //
  //  Date field   → individual test
  //  Site fields  → one combined test (description|iata|address|city|zipcode|country)
  //
  //  npx playwright test --project=air -g "receivedFromShipperDate"
  //  npx playwright test --project=air -g "loadingArrivedDate"
  //  … etc.
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── received_from_shipper ──────────────────────────────────────────────────
  test.describe('received_from_shipper', () => {
    /** @type {any} */ let atu = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('received_from_shipper', T2_DATES.received_from_shipper, toEventSite(SITE.BLR))));
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('receivedFromShipperDate ← situation.date', () =>
      assertField(atu, 'receivedFromShipperDate', T2_DATES.received_from_shipper));

  });

  // ─── goods_arrived_at_loading_arrived ─────────────────────────────────────
  test.describe('goods_arrived_at_loading_arrived', () => {
    /** @type {any} */ let atu = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('goods_arrived_at_loading_arrived', T2_DATES.goods_arrived_at_loading_arrived, toEventSite(SITE.BLR))));
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('loadingArrivedDate ← situation.date', () =>
      assertField(atu, 'loadingArrivedDate', T2_DATES.goods_arrived_at_loading_arrived));

  });

  // ─── goods_loading_compliant_compliant ────────────────────────────────────
  test.describe('goods_loading_compliant_compliant', () => {
    /** @type {any} */ let atu = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('goods_loading_compliant_compliant', T2_DATES.goods_loading_compliant_compliant, toEventSite(SITE.BLR))));
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('loadingCompliantDate ← situation.date', () =>
      assertField(atu, 'loadingCompliantDate', T2_DATES.goods_loading_compliant_compliant));

  });

  // ─── goods_left_loading_left ──────────────────────────────────────────────
  test.describe('goods_left_loading_left', () => {
    /** @type {any} */ let atu = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('goods_left_loading_left', T2_DATES.goods_left_loading_left, toEventSite(SITE.BLR))));
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('loadingLeftDate ← situation.date', () =>
      assertField(atu, 'loadingLeftDate', T2_DATES.goods_left_loading_left));

  });

  // ─── goods_arrived_at_delivery_arrived ────────────────────────────────────
  test.describe('goods_arrived_at_delivery_arrived', () => {
    /** @type {any} */ let atu = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('goods_arrived_at_delivery_arrived', T2_DATES.goods_arrived_at_delivery_arrived, toEventSite(SITE.BOM))));
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('deliveryArrivedDate ← situation.date', () =>
      assertField(atu, 'deliveryArrivedDate', T2_DATES.goods_arrived_at_delivery_arrived));

  });

  // ─── goods_left_delivery_left ─────────────────────────────────────────────
  test.describe('goods_left_delivery_left', () => {
    /** @type {any} */ let atu = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('goods_left_delivery_left', T2_DATES.goods_left_delivery_left, toEventSite(SITE.BOM))));
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('deliveryLeftDate ← situation.date', () =>
      assertField(atu, 'deliveryLeftDate', T2_DATES.goods_left_delivery_left));

  });

  // ─── documentation_delivered ──────────────────────────────────────────────
  test.describe('documentation_delivered — delivery event', () => {
    /** @type {any} */ let atu = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('documentation_delivered', T2_DATES.documentation_delivered, toEventSite(SITE.BOM))));
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('documentationDeliveredDate ← situation.date', () =>
      assertField(atu, 'documentationDeliveredDate', T2_DATES.documentation_delivered));

  });

  // ─── consignee_notified ───────────────────────────────────────────────────
  test.describe('consignee_notified — delivery event', () => {
    /** @type {any} */ let atu = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('consignee_notified', T2_DATES.consignee_notified, toEventSite(SITE.BOM))));
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('consigneeNotifiedDate ← situation.date', () =>
      assertField(atu, 'consigneeNotifiedDate', T2_DATES.consignee_notified));

  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TYPE 3 STARTS-WITH — each event has its own describe + beforeAll
  //
  //  Date          → individual test
  //  Site fields   → combined test
  //  Justification → individual test  (suffix extracted from event name)
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── goods_loading_non_compliant_* ───────────────────────────────────────
  test.describe('goods_loading_non_compliant_* (example: _damaged)', () => {
    /** @type {any} */ let atu = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('goods_loading_non_compliant_damaged', T3_DATES.goods_loading_non_compliant_damaged, toEventSite(SITE.BLR))));
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('loadingNonCompliantDate ← situation.date', () =>
      assertField(atu, 'loadingNonCompliantDate', T3_DATES.goods_loading_non_compliant_damaged));


    test('loadingNonCompliantJustification = reason suffix', () =>
      assertField(atu, 'loadingNonCompliantJustification', 'damaged'));
  });

  // ─── goods_loading_non_realised_* ────────────────────────────────────────
  test.describe('goods_loading_non_realised_* (example: _cancelled)', () => {
    /** @type {any} */ let atu = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('goods_loading_non_realised_cancelled', T3_DATES.goods_loading_non_realised_cancelled, toEventSite(SITE.BLR))));
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('loadingNonRealisedDate ← situation.date', () =>
      assertField(atu, 'loadingNonRealisedDate', T3_DATES.goods_loading_non_realised_cancelled));


    test('loadingNonRealisedJustification = reason suffix', () =>
      assertField(atu, 'loadingNonRealisedJustification', 'cancelled'));
  });

  // ─── goods_loading_refused_* ─────────────────────────────────────────────
  test.describe('goods_loading_refused_* (example: _oversize)', () => {
    /** @type {any} */ let atu = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('goods_loading_refused_oversize', T3_DATES.goods_loading_refused_oversize, toEventSite(SITE.BLR))));
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('loadingRefusedDate ← situation.date', () =>
      assertField(atu, 'loadingRefusedDate', T3_DATES.goods_loading_refused_oversize));


    test('loadingRefusedJustification = reason suffix', () =>
      assertField(atu, 'loadingRefusedJustification', 'oversize'));
  });

  // ─── goods_delivery_non_compliant_* ──────────────────────────────────────
  test.describe('goods_delivery_non_compliant_* (example: _pilferage)', () => {
    /** @type {any} */ let atu = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('goods_delivery_non_compliant_pilferage', T3_DATES.goods_delivery_non_compliant_pilferage, toEventSite(SITE.BOM))));
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('deliveryNonCompliantDate ← situation.date', () =>
      assertField(atu, 'deliveryNonCompliantDate', T3_DATES.goods_delivery_non_compliant_pilferage));


    test('deliveryNonCompliantJustification = reason suffix', () =>
      assertField(atu, 'deliveryNonCompliantJustification', 'pilferage'));
  });

  // ─── goods_delivery_non_realised_* ───────────────────────────────────────
  test.describe('goods_delivery_non_realised_* (example: _recipient_closed)', () => {
    /** @type {any} */ let atu = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('goods_delivery_non_realised_recipient_closed', T3_DATES.goods_delivery_non_realised_recipient_closed, toEventSite(SITE.BOM))));
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('deliveryNonRealisedDate ← situation.date', () =>
      assertField(atu, 'deliveryNonRealisedDate', T3_DATES.goods_delivery_non_realised_recipient_closed));


    test('deliveryNonRealisedJustification = reason suffix', () =>
      assertField(atu, 'deliveryNonRealisedJustification', 'recipient_closed'));
  });

  // ─── goods_delivery_refused_* ─────────────────────────────────────────────
  test.describe('goods_delivery_refused_* (example: _not_ordered)', () => {
    /** @type {any} */ let atu = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('goods_delivery_refused_not_ordered', T3_DATES.goods_delivery_refused_not_ordered, toEventSite(SITE.BOM))));
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('deliveryRefusedDate ← situation.date', () =>
      assertField(atu, 'deliveryRefusedDate', T3_DATES.goods_delivery_refused_not_ordered));


    test('deliveryRefusedJustification = reason suffix', () =>
      assertField(atu, 'deliveryRefusedJustification', 'not_ordered'));
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TYPE 4 — HUB SLOT (5 separate describe blocks — 1 webhook each)
  //
  // Slot assignment rule (BE):
  //   scan stop1–4 for matching IATA → reuse that slot
  //   else first empty slot → assign it
  //
  //  --grep "hubArrivedDate"                      → 1 webhook (DXB arrived)
  //  --grep "hubLeftDate"                         → 1 webhook (DXB left)
  //  --grep "hubArrivedSiteIata.*FRA"             → 1 webhook (FRA arrived)
  //  --grep "goods_arrived_at_delivery_hub"       → 1 webhook (OR alias arrived)
  //  --grep "goods_left_delivery_hub"             → 1 webhook (OR alias left)
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── goods_arrived_at_hub_arrived (DXB) ──────────────────────────────────
  test.describe('goods_arrived_at_hub_arrived — DXB', () => {
    /** @type {any} */        let atu  = null;
    /** @type {number|null} */ let slot = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('goods_arrived_at_hub_arrived', T4_DATES.dxbArrived, toEventSite(SITE.DXB))));
      slot = atu ? resolveHubSlot(atu, SITE.DXB.iata_code, SITE.DXB.country) : null;
      console.log(`  DXB arrived → stop${slot}`);
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('hubArrivedDate (DXB) ← situation.date', () => {
      expect(slot, 'DXB slot must be assigned').not.toBeNull();
      assertField(atu, `hubArrivedDate_stop${slot}`, T4_DATES.dxbArrived);
    });
    test('hubSite fields (DXB) ← event_site', () => {
      expect(slot, 'DXB slot must be assigned').not.toBeNull();
      assertField(atu, `hubSiteDescription_stop${slot}`, SITE.DXB.description);
      assertField(atu, `hubSiteIata_stop${slot}`,        SITE.DXB.iata_code);
      assertField(atu, `hubSiteAddressLine_stop${slot}`, SITE.DXB.address_line);
      assertField(atu, `hubSiteCity_stop${slot}`,        SITE.DXB.city);
      assertField(atu, `hubSiteZipcode_stop${slot}`,     SITE.DXB.zipcode);
      assertField(atu, `hubSiteCountry_stop${slot}`,     SITE.DXB.country);
    });
  });

  // ─── goods_left_hub_left (DXB) ───────────────────────────────────────────
  test.describe('goods_left_hub_left — DXB', () => {
    /** @type {any} */        let atu  = null;
    /** @type {number|null} */ let slot = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('goods_left_hub_left', T4_DATES.dxbLeft, toEventSite(SITE.DXB))));
      slot = atu ? resolveHubSlot(atu, SITE.DXB.iata_code, SITE.DXB.country) : null;
      console.log(`  DXB left → stop${slot}`);
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('hubLeftDate (DXB) ← situation.date', () => {
      expect(slot, 'DXB slot must be assigned').not.toBeNull();
      assertField(atu, `hubLeftDate_stop${slot}`, T4_DATES.dxbLeft);
    });
    test('hubSite fields (DXB) ← event_site', () => {
      expect(slot, 'DXB slot must be assigned').not.toBeNull();
      assertField(atu, `hubSiteDescription_stop${slot}`, SITE.DXB.description);
      assertField(atu, `hubSiteIata_stop${slot}`,        SITE.DXB.iata_code);
      assertField(atu, `hubSiteAddressLine_stop${slot}`, SITE.DXB.address_line);
      assertField(atu, `hubSiteCity_stop${slot}`,        SITE.DXB.city);
      assertField(atu, `hubSiteZipcode_stop${slot}`,     SITE.DXB.zipcode);
      assertField(atu, `hubSiteCountry_stop${slot}`,     SITE.DXB.country);
    });
  });

  // ─── goods_arrived_at_hub_arrived (FRA) ──────────────────────────────────
  test.describe('goods_arrived_at_hub_arrived — FRA', () => {
    /** @type {any} */        let atu  = null;
    /** @type {number|null} */ let slot = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('goods_arrived_at_hub_arrived', T4_DATES.fraArrived, toEventSite(SITE.FRA))));
      slot = atu ? resolveHubSlot(atu, SITE.FRA.iata_code, SITE.FRA.country) : null;
      console.log(`  FRA arrived → stop${slot}`);
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('hubArrivedDate (FRA) ← situation.date', () => {
      expect(slot, 'FRA slot must be assigned').not.toBeNull();
      assertField(atu, `hubArrivedDate_stop${slot}`, T4_DATES.fraArrived);
    });
    test('hubSite fields (FRA) ← event_site', () => {
      expect(slot, 'FRA slot must be assigned').not.toBeNull();
      assertField(atu, `hubSiteDescription_stop${slot}`, SITE.FRA.description);
      assertField(atu, `hubSiteIata_stop${slot}`,        SITE.FRA.iata_code);
      assertField(atu, `hubSiteAddressLine_stop${slot}`, SITE.FRA.address_line);
      assertField(atu, `hubSiteCity_stop${slot}`,        SITE.FRA.city);
      assertField(atu, `hubSiteZipcode_stop${slot}`,     SITE.FRA.zipcode);
      assertField(atu, `hubSiteCountry_stop${slot}`,     SITE.FRA.country);
    });
  });

  // ─── goods_left_hub_left (FRA) ───────────────────────────────────────────
  test.describe('goods_left_hub_left — FRA', () => {
    /** @type {any} */        let atu  = null;
    /** @type {number|null} */ let slot = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('goods_left_hub_left', T4_DATES.fraLeft, toEventSite(SITE.FRA))));
      slot = atu ? resolveHubSlot(atu, SITE.FRA.iata_code, SITE.FRA.country) : null;
      console.log(`  FRA left → stop${slot}`);
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('hubLeftDate (FRA) ← situation.date', () => {
      expect(slot, 'FRA slot must be assigned').not.toBeNull();
      assertField(atu, `hubLeftDate_stop${slot}`, T4_DATES.fraLeft);
    });
    test('hubSite fields (FRA) ← event_site', () => {
      expect(slot, 'FRA slot must be assigned').not.toBeNull();
      assertField(atu, `hubSiteDescription_stop${slot}`, SITE.FRA.description);
      assertField(atu, `hubSiteIata_stop${slot}`,        SITE.FRA.iata_code);
      assertField(atu, `hubSiteAddressLine_stop${slot}`, SITE.FRA.address_line);
      assertField(atu, `hubSiteCity_stop${slot}`,        SITE.FRA.city);
      assertField(atu, `hubSiteZipcode_stop${slot}`,     SITE.FRA.zipcode);
      assertField(atu, `hubSiteCountry_stop${slot}`,     SITE.FRA.country);
    });
  });

  // ─── goods_arrived_at_hub_arrived (SIN) ──────────────────────────────────
  test.describe('goods_arrived_at_hub_arrived — SIN', () => {
    /** @type {any} */        let atu  = null;
    /** @type {number|null} */ let slot = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('goods_arrived_at_hub_arrived', T4_DATES.sinArrived, toEventSite(SITE.SIN))));
      slot = atu ? resolveHubSlot(atu, SITE.SIN.iata_code, SITE.SIN.country) : null;
      console.log(`  SIN arrived → stop${slot}`);
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('hubArrivedDate (SIN) ← situation.date', () => {
      expect(slot, 'SIN slot must be assigned').not.toBeNull();
      assertField(atu, `hubArrivedDate_stop${slot}`, T4_DATES.sinArrived);
    });
    test('hubSite fields (SIN) ← event_site', () => {
      expect(slot, 'SIN slot must be assigned').not.toBeNull();
      assertField(atu, `hubSiteDescription_stop${slot}`, SITE.SIN.description);
      assertField(atu, `hubSiteIata_stop${slot}`,        SITE.SIN.iata_code);
      assertField(atu, `hubSiteAddressLine_stop${slot}`, SITE.SIN.address_line);
      assertField(atu, `hubSiteCity_stop${slot}`,        SITE.SIN.city);
      assertField(atu, `hubSiteZipcode_stop${slot}`,     SITE.SIN.zipcode);
      assertField(atu, `hubSiteCountry_stop${slot}`,     SITE.SIN.country);
    });
  });

  // ─── goods_left_hub_left (SIN) ────────────────────────────────────────────
  test.describe('goods_left_hub_left — SIN', () => {
    /** @type {any} */        let atu  = null;
    /** @type {number|null} */ let slot = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('goods_left_hub_left', T4_DATES.sinLeft, toEventSite(SITE.SIN))));
      slot = atu ? resolveHubSlot(atu, SITE.SIN.iata_code, SITE.SIN.country) : null;
      console.log(`  SIN left → stop${slot}`);
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('hubLeftDate (SIN) ← situation.date', () => {
      expect(slot, 'SIN slot must be assigned').not.toBeNull();
      assertField(atu, `hubLeftDate_stop${slot}`, T4_DATES.sinLeft);
    });
    test('hubSite fields (SIN) ← event_site', () => {
      expect(slot, 'SIN slot must be assigned').not.toBeNull();
      assertField(atu, `hubSiteDescription_stop${slot}`, SITE.SIN.description);
      assertField(atu, `hubSiteIata_stop${slot}`,        SITE.SIN.iata_code);
      assertField(atu, `hubSiteAddressLine_stop${slot}`, SITE.SIN.address_line);
      assertField(atu, `hubSiteCity_stop${slot}`,        SITE.SIN.city);
      assertField(atu, `hubSiteZipcode_stop${slot}`,     SITE.SIN.zipcode);
      assertField(atu, `hubSiteCountry_stop${slot}`,     SITE.SIN.country);
    });
  });

  // ─── goods_arrived_at_hub_arrived (AMS) ──────────────────────────────────
  test.describe('goods_arrived_at_hub_arrived — AMS', () => {
    /** @type {any} */        let atu  = null;
    /** @type {number|null} */ let slot = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('goods_arrived_at_hub_arrived', T4_DATES.amsArrived, toEventSite(SITE.AMS))));
      slot = atu ? resolveHubSlot(atu, SITE.AMS.iata_code, SITE.AMS.country) : null;
      console.log(`  AMS arrived → stop${slot}`);
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('hubArrivedDate (AMS) ← situation.date', () => {
      expect(slot, 'AMS slot must be assigned').not.toBeNull();
      assertField(atu, `hubArrivedDate_stop${slot}`, T4_DATES.amsArrived);
    });
    test('hubSite fields (AMS) ← event_site', () => {
      expect(slot, 'AMS slot must be assigned').not.toBeNull();
      assertField(atu, `hubSiteDescription_stop${slot}`, SITE.AMS.description);
      assertField(atu, `hubSiteIata_stop${slot}`,        SITE.AMS.iata_code);
      assertField(atu, `hubSiteAddressLine_stop${slot}`, SITE.AMS.address_line);
      assertField(atu, `hubSiteCity_stop${slot}`,        SITE.AMS.city);
      assertField(atu, `hubSiteZipcode_stop${slot}`,     SITE.AMS.zipcode);
      assertField(atu, `hubSiteCountry_stop${slot}`,     SITE.AMS.country);
    });
  });

  // ─── goods_left_hub_left (AMS) ────────────────────────────────────────────
  test.describe('goods_left_hub_left — AMS', () => {
    /** @type {any} */        let atu  = null;
    /** @type {number|null} */ let slot = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('goods_left_hub_left', T4_DATES.amsLeft, toEventSite(SITE.AMS))));
      slot = atu ? resolveHubSlot(atu, SITE.AMS.iata_code, SITE.AMS.country) : null;
      console.log(`  AMS left → stop${slot}`);
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('hubLeftDate (AMS) ← situation.date', () => {
      expect(slot, 'AMS slot must be assigned').not.toBeNull();
      assertField(atu, `hubLeftDate_stop${slot}`, T4_DATES.amsLeft);
    });
    test('hubSite fields (AMS) ← event_site', () => {
      expect(slot, 'AMS slot must be assigned').not.toBeNull();
      assertField(atu, `hubSiteDescription_stop${slot}`, SITE.AMS.description);
      assertField(atu, `hubSiteIata_stop${slot}`,        SITE.AMS.iata_code);
      assertField(atu, `hubSiteAddressLine_stop${slot}`, SITE.AMS.address_line);
      assertField(atu, `hubSiteCity_stop${slot}`,        SITE.AMS.city);
      assertField(atu, `hubSiteZipcode_stop${slot}`,     SITE.AMS.zipcode);
      assertField(atu, `hubSiteCountry_stop${slot}`,     SITE.AMS.country);
    });
  });

  // ─── goods_arrived_at_delivery_hub_arrived (OR alias) ────────────────────
  test.describe('[hub] OR-alias arrived — DXB', () => {
    /** @type {any} */        let atu  = null;
    /** @type {number|null} */ let slot = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('goods_arrived_at_delivery_hub_arrived', T4_DATES.deliveryHubDXB, toEventSite(SITE.DXB))));
      slot = atu ? resolveHubSlot(atu, SITE.DXB.iata_code, SITE.DXB.country) : null;
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('hubArrivedDate (DXB OR alias) ← situation.date', () => {
      expect(slot, 'DXB slot must be assigned').not.toBeNull();
      assertField(atu, `hubArrivedDate_stop${slot}`, T4_DATES.deliveryHubDXB);
    });
    test('hubSite fields (DXB OR alias) ← event_site', () => {
      expect(slot, 'DXB slot must be assigned').not.toBeNull();
      assertField(atu, `hubSiteDescription_stop${slot}`, SITE.DXB.description);
      assertField(atu, `hubSiteIata_stop${slot}`,        SITE.DXB.iata_code);
      assertField(atu, `hubSiteAddressLine_stop${slot}`, SITE.DXB.address_line);
      assertField(atu, `hubSiteCity_stop${slot}`,        SITE.DXB.city);
      assertField(atu, `hubSiteZipcode_stop${slot}`,     SITE.DXB.zipcode);
      assertField(atu, `hubSiteCountry_stop${slot}`,     SITE.DXB.country);
    });
  });

  // ─── goods_left_delivery_hub_left (OR alias) ─────────────────────────────
  test.describe('[hub] OR-alias left — DXB', () => {
    /** @type {any} */        let atu  = null;
    /** @type {number|null} */ let slot = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('goods_left_delivery_hub_left', T4_DATES.deliveryHubLeft, toEventSite(SITE.DXB))));
      slot = atu ? resolveHubSlot(atu, SITE.DXB.iata_code, SITE.DXB.country) : null;
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('hubLeftDate (DXB OR alias) ← situation.date', () => {
      expect(slot, 'DXB slot must be assigned').not.toBeNull();
      assertField(atu, `hubLeftDate_stop${slot}`, T4_DATES.deliveryHubLeft);
    });
    test('hubSite fields (DXB OR alias) ← event_site', () => {
      expect(slot, 'DXB slot must be assigned').not.toBeNull();
      assertField(atu, `hubSiteDescription_stop${slot}`, SITE.DXB.description);
      assertField(atu, `hubSiteIata_stop${slot}`,        SITE.DXB.iata_code);
      assertField(atu, `hubSiteAddressLine_stop${slot}`, SITE.DXB.address_line);
      assertField(atu, `hubSiteCity_stop${slot}`,        SITE.DXB.city);
      assertField(atu, `hubSiteZipcode_stop${slot}`,     SITE.DXB.zipcode);
      assertField(atu, `hubSiteCountry_stop${slot}`,     SITE.DXB.country);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TYPE 5 ROUTING — 3 events × 3 contexts (loading | delivery | hub)
  //
  // Prefix rule (IATA + Country both must match):
  //   event_site.iata_code == ATU.loadingSiteIata   AND
  //   event_site.country   == ATU.loadingSiteCountry  → "loading" prefix
  //
  //   event_site.iata_code == ATU.deliverySiteIata  AND
  //   event_site.country   == ATU.deliverySiteCountry → "delivery" prefix
  //
  //   anything else → "hub" prefix + slot
  //
  //  NOTE: booked is now a pass-through event with no date field (removed).
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── manifested / loading ─────────────────────────────────────────────────
  test.describe('manifested — loading (event_site = BLR/IN → loading prefix)', () => {
    /** @type {any} */ let atu = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('manifested', T5_DATES.manifested.loading, toEventSite(SITE.BLR))));
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('loadingManifestedDate ← situation.date', () =>
      assertField(atu, 'loadingManifestedDate', T5_DATES.manifested.loading));
  });

  // ─── manifested / delivery ────────────────────────────────────────────────
  test.describe('manifested — delivery (event_site = BOM/IN → delivery prefix)', () => {
    /** @type {any} */ let atu = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('manifested', T5_DATES.manifested.delivery, toEventSite(SITE.BOM))));
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('deliveryManifestedDate ← situation.date', () =>
      assertField(atu, 'deliveryManifestedDate', T5_DATES.manifested.delivery));
  });

  // ─── manifested / hub (DXB) ───────────────────────────────────────────────
  test.describe('manifested — hub (DXB)', () => {
    /** @type {any} */        let atu     = null;
    /** @type {number|null} */ let hubSlot = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('manifested', T5_DATES.manifested.hub, toEventSite(SITE.DXB))));
      hubSlot = atu ? resolveHubSlot(atu, SITE.DXB.iata_code, SITE.DXB.country) : null;
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('hubManifestedDate_stopN ← situation.date', () => {
      if (!hubSlot) return test.skip();
      assertField(atu, `hubManifestedDate_stop${hubSlot}`, T5_DATES.manifested.hub);
    });
    test('hubSite fields (DXB) ← event_site', () => {
      if (!hubSlot) return test.skip();
      assertField(atu, `hubSiteDescription_stop${hubSlot}`, SITE.DXB.description);
      assertField(atu, `hubSiteIata_stop${hubSlot}`,        SITE.DXB.iata_code);
      assertField(atu, `hubSiteAddressLine_stop${hubSlot}`, SITE.DXB.address_line);
      assertField(atu, `hubSiteCity_stop${hubSlot}`,        SITE.DXB.city);
      assertField(atu, `hubSiteZipcode_stop${hubSlot}`,     SITE.DXB.zipcode);
      assertField(atu, `hubSiteCountry_stop${hubSlot}`,     SITE.DXB.country);
    });
  });

  // ─── manifested / hub (FRA) ───────────────────────────────────────────────
  test.describe('manifested — hub (FRA)', () => {
    /** @type {any} */        let atu     = null;
    /** @type {number|null} */ let hubSlot = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('manifested', T5_DATES.manifested.hubFRA, toEventSite(SITE.FRA))));
      hubSlot = atu ? resolveHubSlot(atu, SITE.FRA.iata_code, SITE.FRA.country) : null;
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('hubManifestedDate_stopN ← situation.date', () => {
      if (!hubSlot) return test.skip();
      assertField(atu, `hubManifestedDate_stop${hubSlot}`, T5_DATES.manifested.hubFRA);
    });
    test('hubSite fields (FRA) ← event_site', () => {
      if (!hubSlot) return test.skip();
      assertField(atu, `hubSiteDescription_stop${hubSlot}`, SITE.FRA.description);
      assertField(atu, `hubSiteIata_stop${hubSlot}`,        SITE.FRA.iata_code);
      assertField(atu, `hubSiteAddressLine_stop${hubSlot}`, SITE.FRA.address_line);
      assertField(atu, `hubSiteCity_stop${hubSlot}`,        SITE.FRA.city);
      assertField(atu, `hubSiteZipcode_stop${hubSlot}`,     SITE.FRA.zipcode);
      assertField(atu, `hubSiteCountry_stop${hubSlot}`,     SITE.FRA.country);
    });
  });

  // ─── manifested / hub (SIN) ───────────────────────────────────────────────
  test.describe('manifested — hub (SIN)', () => {
    /** @type {any} */        let atu     = null;
    /** @type {number|null} */ let hubSlot = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('manifested', T5_DATES.manifested.hubSIN, toEventSite(SITE.SIN))));
      hubSlot = atu ? resolveHubSlot(atu, SITE.SIN.iata_code, SITE.SIN.country) : null;
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('hubManifestedDate_stopN ← situation.date', () => {
      if (!hubSlot) return test.skip();
      assertField(atu, `hubManifestedDate_stop${hubSlot}`, T5_DATES.manifested.hubSIN);
    });
    test('hubSite fields (SIN) ← event_site', () => {
      if (!hubSlot) return test.skip();
      assertField(atu, `hubSiteDescription_stop${hubSlot}`, SITE.SIN.description);
      assertField(atu, `hubSiteIata_stop${hubSlot}`,        SITE.SIN.iata_code);
      assertField(atu, `hubSiteAddressLine_stop${hubSlot}`, SITE.SIN.address_line);
      assertField(atu, `hubSiteCity_stop${hubSlot}`,        SITE.SIN.city);
      assertField(atu, `hubSiteZipcode_stop${hubSlot}`,     SITE.SIN.zipcode);
      assertField(atu, `hubSiteCountry_stop${hubSlot}`,     SITE.SIN.country);
    });
  });

  // ─── manifested / hub (AMS) ───────────────────────────────────────────────
  test.describe('manifested — hub (AMS)', () => {
    /** @type {any} */        let atu     = null;
    /** @type {number|null} */ let hubSlot = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('manifested', T5_DATES.manifested.hubAMS, toEventSite(SITE.AMS))));
      hubSlot = atu ? resolveHubSlot(atu, SITE.AMS.iata_code, SITE.AMS.country) : null;
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('hubManifestedDate_stopN ← situation.date', () => {
      if (!hubSlot) return test.skip();
      assertField(atu, `hubManifestedDate_stop${hubSlot}`, T5_DATES.manifested.hubAMS);
    });
    test('hubSite fields (AMS) ← event_site', () => {
      if (!hubSlot) return test.skip();
      assertField(atu, `hubSiteDescription_stop${hubSlot}`, SITE.AMS.description);
      assertField(atu, `hubSiteIata_stop${hubSlot}`,        SITE.AMS.iata_code);
      assertField(atu, `hubSiteAddressLine_stop${hubSlot}`, SITE.AMS.address_line);
      assertField(atu, `hubSiteCity_stop${hubSlot}`,        SITE.AMS.city);
      assertField(atu, `hubSiteZipcode_stop${hubSlot}`,     SITE.AMS.zipcode);
      assertField(atu, `hubSiteCountry_stop${hubSlot}`,     SITE.AMS.country);
    });
  });

  // ─── eta_event / loading ──────────────────────────────────────────────────
  test.describe('eta_event — loading (event_site = BLR/IN → loading prefix)', () => {
    /** @type {any} */ let atu = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('eta_event', T5_DATES.eta_event.loading, toEventSite(SITE.BLR))));
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('loadingETADate ← situation.date', () =>
      assertField(atu, 'loadingETADate', T5_DATES.eta_event.loading));
  });

  // ─── eta_event / delivery ─────────────────────────────────────────────────
  test.describe('eta_event — delivery (event_site = BOM/IN → delivery prefix)', () => {
    /** @type {any} */ let atu = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('eta_event', T5_DATES.eta_event.delivery, toEventSite(SITE.BOM))));
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('deliveryETADate ← situation.date', () =>
      assertField(atu, 'deliveryETADate', T5_DATES.eta_event.delivery));
  });

  // ─── eta_event / hub (DXB) ────────────────────────────────────────────────
  test.describe('eta_event — hub (DXB)', () => {
    /** @type {any} */        let atu     = null;
    /** @type {number|null} */ let hubSlot = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('eta_event', T5_DATES.eta_event.hub, toEventSite(SITE.DXB))));
      hubSlot = atu ? resolveHubSlot(atu, SITE.DXB.iata_code, SITE.DXB.country) : null;
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('hubETADate_stopN ← situation.date', () => {
      if (!hubSlot) return test.skip();
      assertField(atu, `hubETADate_stop${hubSlot}`, T5_DATES.eta_event.hub);
    });
    test('hubSite fields (DXB) ← event_site', () => {
      if (!hubSlot) return test.skip();
      assertField(atu, `hubSiteDescription_stop${hubSlot}`, SITE.DXB.description);
      assertField(atu, `hubSiteIata_stop${hubSlot}`,        SITE.DXB.iata_code);
      assertField(atu, `hubSiteAddressLine_stop${hubSlot}`, SITE.DXB.address_line);
      assertField(atu, `hubSiteCity_stop${hubSlot}`,        SITE.DXB.city);
      assertField(atu, `hubSiteZipcode_stop${hubSlot}`,     SITE.DXB.zipcode);
      assertField(atu, `hubSiteCountry_stop${hubSlot}`,     SITE.DXB.country);
    });
  });

  // ─── eta_event / hub (FRA) ────────────────────────────────────────────────
  test.describe('eta_event — hub (FRA)', () => {
    /** @type {any} */        let atu     = null;
    /** @type {number|null} */ let hubSlot = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('eta_event', T5_DATES.eta_event.hubFRA, toEventSite(SITE.FRA))));
      hubSlot = atu ? resolveHubSlot(atu, SITE.FRA.iata_code, SITE.FRA.country) : null;
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('hubETADate_stopN ← situation.date', () => {
      if (!hubSlot) return test.skip();
      assertField(atu, `hubETADate_stop${hubSlot}`, T5_DATES.eta_event.hubFRA);
    });
    test('hubSite fields (FRA) ← event_site', () => {
      if (!hubSlot) return test.skip();
      assertField(atu, `hubSiteDescription_stop${hubSlot}`, SITE.FRA.description);
      assertField(atu, `hubSiteIata_stop${hubSlot}`,        SITE.FRA.iata_code);
      assertField(atu, `hubSiteAddressLine_stop${hubSlot}`, SITE.FRA.address_line);
      assertField(atu, `hubSiteCity_stop${hubSlot}`,        SITE.FRA.city);
      assertField(atu, `hubSiteZipcode_stop${hubSlot}`,     SITE.FRA.zipcode);
      assertField(atu, `hubSiteCountry_stop${hubSlot}`,     SITE.FRA.country);
    });
  });

  // ─── eta_event / hub (SIN) ────────────────────────────────────────────────
  test.describe('eta_event — hub (SIN)', () => {
    /** @type {any} */        let atu     = null;
    /** @type {number|null} */ let hubSlot = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('eta_event', T5_DATES.eta_event.hubSIN, toEventSite(SITE.SIN))));
      hubSlot = atu ? resolveHubSlot(atu, SITE.SIN.iata_code, SITE.SIN.country) : null;
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('hubETADate_stopN ← situation.date', () => {
      if (!hubSlot) return test.skip();
      assertField(atu, `hubETADate_stop${hubSlot}`, T5_DATES.eta_event.hubSIN);
    });
    test('hubSite fields (SIN) ← event_site', () => {
      if (!hubSlot) return test.skip();
      assertField(atu, `hubSiteDescription_stop${hubSlot}`, SITE.SIN.description);
      assertField(atu, `hubSiteIata_stop${hubSlot}`,        SITE.SIN.iata_code);
      assertField(atu, `hubSiteAddressLine_stop${hubSlot}`, SITE.SIN.address_line);
      assertField(atu, `hubSiteCity_stop${hubSlot}`,        SITE.SIN.city);
      assertField(atu, `hubSiteZipcode_stop${hubSlot}`,     SITE.SIN.zipcode);
      assertField(atu, `hubSiteCountry_stop${hubSlot}`,     SITE.SIN.country);
    });
  });

  // ─── eta_event / hub (AMS) ────────────────────────────────────────────────
  test.describe('eta_event — hub (AMS)', () => {
    /** @type {any} */        let atu     = null;
    /** @type {number|null} */ let hubSlot = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('eta_event', T5_DATES.eta_event.hubAMS, toEventSite(SITE.AMS))));
      hubSlot = atu ? resolveHubSlot(atu, SITE.AMS.iata_code, SITE.AMS.country) : null;
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('hubETADate_stopN ← situation.date', () => {
      if (!hubSlot) return test.skip();
      assertField(atu, `hubETADate_stop${hubSlot}`, T5_DATES.eta_event.hubAMS);
    });
    test('hubSite fields (AMS) ← event_site', () => {
      if (!hubSlot) return test.skip();
      assertField(atu, `hubSiteDescription_stop${hubSlot}`, SITE.AMS.description);
      assertField(atu, `hubSiteIata_stop${hubSlot}`,        SITE.AMS.iata_code);
      assertField(atu, `hubSiteAddressLine_stop${hubSlot}`, SITE.AMS.address_line);
      assertField(atu, `hubSiteCity_stop${hubSlot}`,        SITE.AMS.city);
      assertField(atu, `hubSiteZipcode_stop${hubSlot}`,     SITE.AMS.zipcode);
      assertField(atu, `hubSiteCountry_stop${hubSlot}`,     SITE.AMS.country);
    });
  });

  // ─── received_from_flight / loading ───────────────────────────────────────
  test.describe('received_from_flight — loading (event_site = BLR/IN → loading prefix)', () => {
    /** @type {any} */ let atu = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('received_from_flight', T5_DATES.received_from_flight.loading, toEventSite(SITE.BLR))));
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('loadingReceivedFromFlightDate ← situation.date', () =>
      assertField(atu, 'loadingReceivedFromFlightDate', T5_DATES.received_from_flight.loading));
  });

  // ─── received_from_flight / delivery ──────────────────────────────────────
  test.describe('received_from_flight — delivery (event_site = BOM/IN → delivery prefix)', () => {
    /** @type {any} */ let atu = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('received_from_flight', T5_DATES.received_from_flight.delivery, toEventSite(SITE.BOM))));
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('deliveryReceivedFromFlightDate ← situation.date', () =>
      assertField(atu, 'deliveryReceivedFromFlightDate', T5_DATES.received_from_flight.delivery));
  });

  // ─── received_from_flight / hub (DXB) ────────────────────────────────────
  test.describe('received_from_flight — hub (DXB)', () => {
    /** @type {any} */        let atu     = null;
    /** @type {number|null} */ let hubSlot = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('received_from_flight', T5_DATES.received_from_flight.hub, toEventSite(SITE.DXB))));
      hubSlot = atu ? resolveHubSlot(atu, SITE.DXB.iata_code, SITE.DXB.country) : null;
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('hubReceivedFromFlightDate_stopN ← situation.date', () => {
      if (!hubSlot) return test.skip();
      assertField(atu, `hubReceivedFromFlightDate_stop${hubSlot}`, T5_DATES.received_from_flight.hub);
    });
    test('hubSite fields (DXB) ← event_site', () => {
      if (!hubSlot) return test.skip();
      assertField(atu, `hubSiteDescription_stop${hubSlot}`, SITE.DXB.description);
      assertField(atu, `hubSiteIata_stop${hubSlot}`,        SITE.DXB.iata_code);
      assertField(atu, `hubSiteAddressLine_stop${hubSlot}`, SITE.DXB.address_line);
      assertField(atu, `hubSiteCity_stop${hubSlot}`,        SITE.DXB.city);
      assertField(atu, `hubSiteZipcode_stop${hubSlot}`,     SITE.DXB.zipcode);
      assertField(atu, `hubSiteCountry_stop${hubSlot}`,     SITE.DXB.country);
    });
  });

  // ─── received_from_flight / hub (FRA) ────────────────────────────────────
  test.describe('received_from_flight — hub (FRA)', () => {
    /** @type {any} */        let atu     = null;
    /** @type {number|null} */ let hubSlot = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('received_from_flight', T5_DATES.received_from_flight.hubFRA, toEventSite(SITE.FRA))));
      hubSlot = atu ? resolveHubSlot(atu, SITE.FRA.iata_code, SITE.FRA.country) : null;
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('hubReceivedFromFlightDate_stopN ← situation.date', () => {
      if (!hubSlot) return test.skip();
      assertField(atu, `hubReceivedFromFlightDate_stop${hubSlot}`, T5_DATES.received_from_flight.hubFRA);
    });
    test('hubSite fields (FRA) ← event_site', () => {
      if (!hubSlot) return test.skip();
      assertField(atu, `hubSiteDescription_stop${hubSlot}`, SITE.FRA.description);
      assertField(atu, `hubSiteIata_stop${hubSlot}`,        SITE.FRA.iata_code);
      assertField(atu, `hubSiteAddressLine_stop${hubSlot}`, SITE.FRA.address_line);
      assertField(atu, `hubSiteCity_stop${hubSlot}`,        SITE.FRA.city);
      assertField(atu, `hubSiteZipcode_stop${hubSlot}`,     SITE.FRA.zipcode);
      assertField(atu, `hubSiteCountry_stop${hubSlot}`,     SITE.FRA.country);
    });
  });

  // ─── received_from_flight / hub (SIN) ────────────────────────────────────
  test.describe('received_from_flight — hub (SIN)', () => {
    /** @type {any} */        let atu     = null;
    /** @type {number|null} */ let hubSlot = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('received_from_flight', T5_DATES.received_from_flight.hubSIN, toEventSite(SITE.SIN))));
      hubSlot = atu ? resolveHubSlot(atu, SITE.SIN.iata_code, SITE.SIN.country) : null;
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('hubReceivedFromFlightDate_stopN ← situation.date', () => {
      if (!hubSlot) return test.skip();
      assertField(atu, `hubReceivedFromFlightDate_stop${hubSlot}`, T5_DATES.received_from_flight.hubSIN);
    });
    test('hubSite fields (SIN) ← event_site', () => {
      if (!hubSlot) return test.skip();
      assertField(atu, `hubSiteDescription_stop${hubSlot}`, SITE.SIN.description);
      assertField(atu, `hubSiteIata_stop${hubSlot}`,        SITE.SIN.iata_code);
      assertField(atu, `hubSiteAddressLine_stop${hubSlot}`, SITE.SIN.address_line);
      assertField(atu, `hubSiteCity_stop${hubSlot}`,        SITE.SIN.city);
      assertField(atu, `hubSiteZipcode_stop${hubSlot}`,     SITE.SIN.zipcode);
      assertField(atu, `hubSiteCountry_stop${hubSlot}`,     SITE.SIN.country);
    });
  });

  // ─── received_from_flight / hub (AMS) ────────────────────────────────────
  test.describe('received_from_flight — hub (AMS)', () => {
    /** @type {any} */        let atu     = null;
    /** @type {number|null} */ let hubSlot = null;
    test.beforeAll(async () => {
      ({ atu } = await sendAndWait(makePayload('received_from_flight', T5_DATES.received_from_flight.hubAMS, toEventSite(SITE.AMS))));
      hubSlot = atu ? resolveHubSlot(atu, SITE.AMS.iata_code, SITE.AMS.country) : null;
    });
    test.beforeEach(() => { if (!atu) test.skip(); });

    test('hubReceivedFromFlightDate_stopN ← situation.date', () => {
      if (!hubSlot) return test.skip();
      assertField(atu, `hubReceivedFromFlightDate_stop${hubSlot}`, T5_DATES.received_from_flight.hubAMS);
    });
    test('hubSite fields (AMS) ← event_site', () => {
      if (!hubSlot) return test.skip();
      assertField(atu, `hubSiteDescription_stop${hubSlot}`, SITE.AMS.description);
      assertField(atu, `hubSiteIata_stop${hubSlot}`,        SITE.AMS.iata_code);
      assertField(atu, `hubSiteAddressLine_stop${hubSlot}`, SITE.AMS.address_line);
      assertField(atu, `hubSiteCity_stop${hubSlot}`,        SITE.AMS.city);
      assertField(atu, `hubSiteZipcode_stop${hubSlot}`,     SITE.AMS.zipcode);
      assertField(atu, `hubSiteCountry_stop${hubSlot}`,     SITE.AMS.country);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SUMMARY — final ATU field state report (printed to console, always passes)
  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('S — Final ATU Field State Report', () => {

    test('TC-S-01 | Print complete ATU field map after all events', async () => {
      const ctx    = await request.newContext({ baseURL: CONFIG.ADMIN_BASE_URL });
      const latest = await getATU(ctx).catch(() => null);
      await ctx.dispose();
      if (!latest) { console.log('[S-01] ATU not available'); return; }

      /** @param {string} key @param {any} exp */
      const chk = (key, exp) => {
        const actual = /** @type {any} */ (latest)[key];
        if (actual === undefined) return `  ⬜ ${key}: NOT IN RESPONSE`;
        return valuesMatch(actual, exp)
          ? `  ✅ ${key}: "${actual}"`
          : `  ❌ ${key}: actual="${actual}" | expected="${exp}"`;
      };

      console.log('\n══════════════════════════════════════════════════════════');
      console.log('  AIR — Final ATU Field State Report');
      console.log(`  code=${latest.code}  lastChangedAt=${latest.lastChangedAt}`);
      console.log('══════════════════════════════════════════════════════════');

      console.log('\n── Identifiers (direct fields) ──');
      [
        ['orderReference',       MP.order.reference],
        ['consignmentReference', MP.situation_justification.attributes.consignmentReference],
        ['orderUrl',             MP.order.url],
      ].forEach(([k, v]) => console.log(chk(String(k), v)));

      console.log('\n── Type 2 Exact (date fields) ──');
      [
        ['deliveryCompliantDate',       MAIN_DATE],
        ['receivedFromShipperDate',     T2_DATES.received_from_shipper],
        ['loadingArrivedDate',          T2_DATES.goods_arrived_at_loading_arrived],
        ['loadingCompliantDate',        T2_DATES.goods_loading_compliant_compliant],
        ['loadingLeftDate',             T2_DATES.goods_left_loading_left],
        ['deliveryArrivedDate',         T2_DATES.goods_arrived_at_delivery_arrived],
        ['deliveryLeftDate',            T2_DATES.goods_left_delivery_left],
        ['documentationDeliveredDate',  T2_DATES.documentation_delivered],
        ['consigneeNotifiedDate',       T2_DATES.consignee_notified],
      ].forEach(([k, v]) => console.log(chk(String(k), v)));

      console.log('\n── Type 3 Justifications (reason suffix) ──');
      [
        ['loadingNonCompliantJustification',  'damaged'],
        ['loadingNonRealisedJustification',   'cancelled'],
        ['loadingRefusedJustification',       'oversize'],
        ['deliveryNonCompliantJustification', 'pilferage'],
        ['deliveryNonRealisedJustification',  'recipient_closed'],
        ['deliveryRefusedJustification',      'not_ordered'],
      ].forEach(([k, v]) => console.log(chk(String(k), v)));

      console.log('\n── Type 5 Routing (loading/delivery date fields) ──');
      [
        ['loadingManifestedDate',           T5_DATES.manifested.loading],
        ['deliveryManifestedDate',          T5_DATES.manifested.delivery],
        ['loadingETADate',                  T5_DATES.eta_event.loading],
        ['deliveryETADate',                 T5_DATES.eta_event.delivery],
        ['loadingReceivedFromFlightDate',   T5_DATES.received_from_flight.loading],
        ['deliveryReceivedFromFlightDate',  T5_DATES.received_from_flight.delivery],
      ].forEach(([k, v]) => console.log(chk(String(k), v)));

      console.log('\n── Hub Slots (stop1–stop4) ──');
      for (let n = 1; n <= 4; n++) {
        const iata = /** @type {any} */ (latest)[`hubSiteIata_stop${n}`];
        const country = /** @type {any} */ (latest)[`hubSiteCountry_stop${n}`];
        if (iata) {
          console.log(`  ℹ️  stop${n}: iata="${iata}" country="${country}"  desc="${/** @type {any} */ (latest)[`hubSiteDescription_stop${n}`]}"  arrived="${/** @type {any} */ (latest)[`hubArrivedDate_stop${n}`]}"  left="${/** @type {any} */ (latest)[`hubLeftDate_stop${n}`]}"`);
        } else {
          console.log(`  ⬜ stop${n}: empty`);
        }
      }
      console.log('══════════════════════════════════════════════════════════\n');
    });

  }); // end S

}); // end TC002
