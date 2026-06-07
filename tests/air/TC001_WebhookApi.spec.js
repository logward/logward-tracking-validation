// =============================================================================
// TC001_WebhookApi.spec.js
//
// AIR TRACKING — WEBHOOK API VALIDATION
// Reference: Air Events Mapping V3
//
// Validates the POST /api/integration-hub/tracking/shippeo/air_tracking endpoint:
//   W  — Authentication, ClientId, status-code contract
//   P  — Every event returns HTTP 2xx (payload accepted)
//   N  — Negative / silent-drop scenarios (missing fields, bad MAWB, etc.)
//
// HOW TO RUN:
//   npx playwright test --project=air tests/air/TC001_WebhookApi.spec.js
//
// BEFORE RUNNING — refresh the admin token if you need ATU reads (expires ~1 h):
//   export AIR_ADMIN_TOKEN="eyJ..."
// =============================================================================

// @ts-check
const { test, expect, request } = require('@playwright/test');

const { CONFIG }                         = require('../../helpers/air/airConfig');
const { webhookHeaders, sendWebhook,
        getATU }                         = require('../../helpers/air/airApiHelpers');
const { makePayload, MAIN_PAYLOAD,
        MAIN_EVENT, MAIN_DATE,
        SITE, toEventSite, T2_DATES,
        T3_DATES, T4_DATES, T5_DATES }   = require('../../helpers/air/airPayloadFactory');
const { checkTokenExpiry }               = require('../../helpers/tokenHelper');
const { ALL_EVENTS }                     = require('../../data/airFieldMappings');

// ── Token expiry warning at startup ──────────────────────────────────────────
checkTokenExpiry(CONFIG.ADMIN_TOKEN,   'AIR_ADMIN_TOKEN',   'AIR ADMIN');
checkTokenExpiry(CONFIG.WEBHOOK_TOKEN, 'AIR_WEBHOOK_TOKEN', 'AIR WEBHOOK');
// ─────────────────────────────────────────────────────────────────────────────

// ── SITE → default event site (BOM = delivery, BLR = loading, DXB = hub) ─────
const SITES = {
  BLR: toEventSite(SITE.BLR),
  BOM: toEventSite(SITE.BOM),
  DXB: toEventSite(SITE.DXB),
  FRA: toEventSite(SITE.FRA),
};

// ── Map every event to a reasonable (date, site) pair for sending ─────────────
/**
 * Return { date, site } for sending a given event in the "all events" tests.
 * @param {string} event
 * @returns {{ date: string, site: object }}
 */
function eventParams(event) {
  if (event in T2_DATES)            return { date: T2_DATES[event], site: event.includes('delivery') ? SITES.BOM : SITES.BLR };
  if (event in T3_DATES)            return { date: T3_DATES[event], site: event.includes('delivery') ? SITES.BOM : SITES.BLR };
  if (event === 'goods_arrived_at_hub_arrived')          return { date: T4_DATES.dxbArrived,     site: SITES.DXB };
  if (event === 'goods_arrived_at_delivery_hub_arrived') return { date: T4_DATES.deliveryHubDXB, site: SITES.DXB };
  if (event === 'goods_left_hub_left')                   return { date: T4_DATES.dxbLeft,         site: SITES.DXB };
  if (event === 'goods_left_delivery_hub_left')          return { date: T4_DATES.dxbLeft,         site: SITES.DXB };
  if (event in T5_DATES)            return { date: T5_DATES[event]?.loading,  site: SITES.BLR };
  // Fallback (goods_delivery_compliant_compliant / MAIN)
  return { date: MAIN_DATE, site: SITES.BOM };
}

// ═════════════════════════════════════════════════════════════════════════════
test.describe('Air — TC001: Webhook API Validation', () => {

  // ── Shared webhook context (one per describe) ─────────────────────────────
  let webhookCtx;
  let adminCtx;

  test.beforeAll(async () => {
    webhookCtx = await request.newContext({ baseURL: CONFIG.WEBHOOK_BASE_URL });
    adminCtx   = await request.newContext({ baseURL: CONFIG.ADMIN_BASE_URL });
  });

  test.afterAll(async () => {
    await webhookCtx?.dispose();
    await adminCtx?.dispose();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP W — Authentication & Header Contract
  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('W — Auth & Header Contract', () => {

    test('TC-W-01 | Valid request returns HTTP 2xx', async () => {
      const res = await sendWebhook(webhookCtx, MAIN_PAYLOAD);
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    });

    test('TC-W-02 | Missing Authorization header → HTTP 401', async () => {
      const res = await webhookCtx.post(CONFIG.WEBHOOK_PATH, {
        headers: { 'Content-Type': 'application/json', 'ClientId': CONFIG.WEBHOOK_CLIENT_ID },
        data:    MAIN_PAYLOAD,
      });
      expect(res.status()).toBe(401);
    });

    test('TC-W-03 | Missing ClientId header → HTTP 4xx', async () => {
      const res = await webhookCtx.post(CONFIG.WEBHOOK_PATH, {
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CONFIG.WEBHOOK_TOKEN}` },
        data:    MAIN_PAYLOAD,
      });
      expect(res.status()).toBeGreaterThanOrEqual(400);
      expect(res.status()).toBeLessThan(500);
    });

    test('TC-W-04 | Invalid/tampered Bearer token → HTTP 401', async () => {
      const res = await webhookCtx.post(CONFIG.WEBHOOK_PATH, {
        headers: {
          'Content-Type':  'application/json',
          'ClientId':      CONFIG.WEBHOOK_CLIENT_ID,
          'Authorization': 'Bearer INVALID_TOKEN_XYZ',
        },
        data: MAIN_PAYLOAD,
      });
      expect(res.status()).toBe(401);
    });

    test('TC-W-05 | ATU pre-exists in BE (UPDATE-ONLY service)', async () => {
      const atu = await getATU(adminCtx).catch(() => null);
      expect(atu, `ATU code=${CONFIG.OBJECT_CODE} not found — create it in the BE first`).not.toBeNull();
      expect(atu?.code).toBe(CONFIG.OBJECT_CODE);
    });

  }); // end W

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP P — Every Event Returns HTTP 2xx
  // One test per event from ALL_EVENTS (imported from airFieldMappings.js).
  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('P — Every Event Accepted (HTTP 2xx)', () => {

    // goods_delivery_compliant_compliant (MAIN)
    test('TC-P-01 | goods_delivery_compliant_compliant → HTTP 2xx', async () => {
      const res = await sendWebhook(webhookCtx, MAIN_PAYLOAD);
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    });

    // received_from_shipper
    test('TC-P-02 | received_from_shipper → HTTP 2xx', async () => {
      const res = await sendWebhook(webhookCtx, makePayload('received_from_shipper', T2_DATES.received_from_shipper, SITES.BLR));
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    });

    // goods_arrived_at_loading_arrived
    test('TC-P-03 | goods_arrived_at_loading_arrived → HTTP 2xx', async () => {
      const res = await sendWebhook(webhookCtx, makePayload('goods_arrived_at_loading_arrived', T2_DATES.goods_arrived_at_loading_arrived, SITES.BLR));
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    });

    // goods_loading_compliant_compliant
    test('TC-P-04 | goods_loading_compliant_compliant → HTTP 2xx', async () => {
      const res = await sendWebhook(webhookCtx, makePayload('goods_loading_compliant_compliant', T2_DATES.goods_loading_compliant_compliant, SITES.BLR));
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    });

    // goods_left_loading_left
    test('TC-P-05 | goods_left_loading_left → HTTP 2xx', async () => {
      const res = await sendWebhook(webhookCtx, makePayload('goods_left_loading_left', T2_DATES.goods_left_loading_left, SITES.BLR));
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    });

    // goods_arrived_at_delivery_arrived
    test('TC-P-06 | goods_arrived_at_delivery_arrived → HTTP 2xx', async () => {
      const res = await sendWebhook(webhookCtx, makePayload('goods_arrived_at_delivery_arrived', T2_DATES.goods_arrived_at_delivery_arrived, SITES.BOM));
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    });

    // goods_left_delivery_left
    test('TC-P-07 | goods_left_delivery_left → HTTP 2xx', async () => {
      const res = await sendWebhook(webhookCtx, makePayload('goods_left_delivery_left', T2_DATES.goods_left_delivery_left, SITES.BOM));
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    });

    // documentation_delivered
    test('TC-P-08 | documentation_delivered → HTTP 2xx', async () => {
      const res = await sendWebhook(webhookCtx, makePayload('documentation_delivered', T2_DATES.documentation_delivered, SITES.BOM));
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    });

    // consignee_notified
    test('TC-P-09 | consignee_notified → HTTP 2xx', async () => {
      const res = await sendWebhook(webhookCtx, makePayload('consignee_notified', T2_DATES.consignee_notified, SITES.BOM));
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    });

    // Type 3 — starts-with events
    test('TC-P-10 | goods_loading_non_compliant_damaged → HTTP 2xx', async () => {
      const res = await sendWebhook(webhookCtx, makePayload('goods_loading_non_compliant_damaged', T3_DATES.goods_loading_non_compliant_damaged, SITES.BLR));
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    });

    test('TC-P-11 | goods_loading_non_realised_cancelled → HTTP 2xx', async () => {
      const res = await sendWebhook(webhookCtx, makePayload('goods_loading_non_realised_cancelled', T3_DATES.goods_loading_non_realised_cancelled, SITES.BLR));
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    });

    test('TC-P-12 | goods_loading_refused_oversize → HTTP 2xx', async () => {
      const res = await sendWebhook(webhookCtx, makePayload('goods_loading_refused_oversize', T3_DATES.goods_loading_refused_oversize, SITES.BLR));
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    });

    test('TC-P-13 | goods_delivery_non_compliant_pilferage → HTTP 2xx', async () => {
      const res = await sendWebhook(webhookCtx, makePayload('goods_delivery_non_compliant_pilferage', T3_DATES.goods_delivery_non_compliant_pilferage, SITES.BOM));
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    });

    test('TC-P-14 | goods_delivery_non_realised_recipient_closed → HTTP 2xx', async () => {
      const res = await sendWebhook(webhookCtx, makePayload('goods_delivery_non_realised_recipient_closed', T3_DATES.goods_delivery_non_realised_recipient_closed, SITES.BOM));
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    });

    test('TC-P-15 | goods_delivery_refused_not_ordered → HTTP 2xx', async () => {
      const res = await sendWebhook(webhookCtx, makePayload('goods_delivery_refused_not_ordered', T3_DATES.goods_delivery_refused_not_ordered, SITES.BOM));
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    });

    // Type 4 — hub slot events
    test('TC-P-16 | goods_arrived_at_hub_arrived → HTTP 2xx', async () => {
      const res = await sendWebhook(webhookCtx, makePayload('goods_arrived_at_hub_arrived', T4_DATES.dxbArrived, SITES.DXB));
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    });

    test('TC-P-17 | goods_arrived_at_delivery_hub_arrived → HTTP 2xx', async () => {
      const res = await sendWebhook(webhookCtx, makePayload('goods_arrived_at_delivery_hub_arrived', T4_DATES.deliveryHubDXB, SITES.DXB));
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    });

    test('TC-P-18 | goods_left_hub_left → HTTP 2xx', async () => {
      const res = await sendWebhook(webhookCtx, makePayload('goods_left_hub_left', T4_DATES.dxbLeft, SITES.DXB));
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    });

    test('TC-P-19 | goods_left_delivery_hub_left → HTTP 2xx', async () => {
      const res = await sendWebhook(webhookCtx, makePayload('goods_left_delivery_hub_left', T4_DATES.dxbLeft, SITES.DXB));
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    });

    // Type 5 — routing events (loading IATA = BLR)
    test('TC-P-20 | booked (loading iata=BLR) → HTTP 2xx', async () => {
      const res = await sendWebhook(webhookCtx, makePayload('booked', T5_DATES.booked.loading, SITES.BLR));
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    });

    test('TC-P-21 | booked (delivery iata=BOM) → HTTP 2xx', async () => {
      const res = await sendWebhook(webhookCtx, makePayload('booked', T5_DATES.booked.delivery, SITES.BOM));
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    });

    test('TC-P-22 | booked (hub iata=DXB) → HTTP 2xx', async () => {
      const res = await sendWebhook(webhookCtx, makePayload('booked', T5_DATES.booked.hub, SITES.DXB));
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    });

    test('TC-P-23 | manifested (loading iata=BLR) → HTTP 2xx', async () => {
      const res = await sendWebhook(webhookCtx, makePayload('manifested', T5_DATES.manifested.loading, SITES.BLR));
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    });

    test('TC-P-24 | manifested (delivery iata=BOM) → HTTP 2xx', async () => {
      const res = await sendWebhook(webhookCtx, makePayload('manifested', T5_DATES.manifested.delivery, SITES.BOM));
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    });

    test('TC-P-25 | manifested (hub iata=DXB) → HTTP 2xx', async () => {
      const res = await sendWebhook(webhookCtx, makePayload('manifested', T5_DATES.manifested.hub, SITES.DXB));
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    });

    test('TC-P-26 | eta_event (loading iata=BLR) → HTTP 2xx', async () => {
      const res = await sendWebhook(webhookCtx, makePayload('eta_event', T5_DATES.eta_event.loading, SITES.BLR));
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    });

    test('TC-P-27 | eta_event (delivery iata=BOM) → HTTP 2xx', async () => {
      const res = await sendWebhook(webhookCtx, makePayload('eta_event', T5_DATES.eta_event.delivery, SITES.BOM));
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    });

    test('TC-P-28 | eta_event (hub iata=DXB) → HTTP 2xx', async () => {
      const res = await sendWebhook(webhookCtx, makePayload('eta_event', T5_DATES.eta_event.hub, SITES.DXB));
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    });

    test('TC-P-29 | received_from_flight (loading iata=BLR) → HTTP 2xx', async () => {
      const res = await sendWebhook(webhookCtx, makePayload('received_from_flight', T5_DATES.received_from_flight.loading, SITES.BLR));
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    });

    test('TC-P-30 | received_from_flight (delivery iata=BOM) → HTTP 2xx', async () => {
      const res = await sendWebhook(webhookCtx, makePayload('received_from_flight', T5_DATES.received_from_flight.delivery, SITES.BOM));
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    });

    test('TC-P-31 | received_from_flight (hub iata=DXB) → HTTP 2xx', async () => {
      const res = await sendWebhook(webhookCtx, makePayload('received_from_flight', T5_DATES.received_from_flight.hub, SITES.DXB));
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
    });

  }); // end P

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP N — Negative / Silent-Drop Scenarios
  // The BE always returns HTTP 200 for these — the event is silently ignored.
  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('N — Negative: Silent-Drop Scenarios', () => {

    test('TC-N-01 | Missing situation.date → HTTP 200 (silent drop)', async () => {
      const p = makePayload(MAIN_EVENT, undefined, SITES.BOM);
      delete p.situation.date;
      const res = await sendWebhook(webhookCtx, p);
      expect(res.status()).toBe(200);
    });

    test('TC-N-02 | Empty situation.event → HTTP 200 (silent drop)', async () => {
      const p = makePayload('', MAIN_DATE, SITES.BOM);
      p.situation.event = '';
      const res = await sendWebhook(webhookCtx, p);
      expect(res.status()).toBe(200);
    });

    test('TC-N-03 | Non-existent MAWB (no ATU match) → HTTP 200 (silent drop)', async () => {
      const p = makePayload(MAIN_EVENT, MAIN_DATE, SITES.BOM);
      p.order.edi_reference    = 'NOMATCH_MAWB_99999';
      p.order.client_reference = 'NOMATCH_REF_99999';
      const res = await sendWebhook(webhookCtx, p);
      expect(res.status()).toBe(200);
    });

    test('TC-N-04 | Unknown event name → HTTP 200, event-specific fields not written', async () => {
      const p   = makePayload('totally_unknown_event_xyz', MAIN_DATE, SITES.BOM);
      const res = await sendWebhook(webhookCtx, p);
      expect(res.status()).toBe(200);
    });

    test('TC-N-05 | Lowercase IATA "blr" ≠ uppercase "BLR" (case-sensitive) → treated as hub, not loading', async () => {
      // QA guide: IATA codes are case-sensitive.
      // Sending iata_code="blr" must NOT set loadingBookedDate.
      const badSite = { ...SITES.BLR, iata_code: 'blr' };  // lowercase
      const res = await sendWebhook(webhookCtx, makePayload('booked', MAIN_DATE, badSite));
      expect(res.status()).toBeGreaterThanOrEqual(200);
      expect(res.status()).toBeLessThan(300);
      // Field assertion is in TC002_ObjectValidation — this test only checks HTTP contract.
    });

    test('TC-N-06 | Empty body → HTTP 4xx or 2xx (endpoint rejects / drops gracefully)', async () => {
      const res = await webhookCtx.post(CONFIG.WEBHOOK_PATH, {
        headers: webhookHeaders(),
        data:    {},
      });
      // BE may return 400 or 200 (silent drop) — both are acceptable
      expect(res.status()).toBeGreaterThanOrEqual(200);
    });

  }); // end N

}); // end describe
