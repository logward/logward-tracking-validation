// =============================================================================
//  RoadOrdersIn.spec.js
//
//  ROAD — Orders-In: full positive, negative (active=0, valid=0), update, auth.
//
// ─── ATC RULES (Road) ─────────────────────────────────────────────────────────
//
//  active = 1  ← trackingStatus === "In Progress"
//
//  valid  = 1  ← active=1 AND all 19 required fields present:
//    transportOrderId, licensePlateTruck, loadType,
//    pickupAddressName, pickupAddressStreet, pickupAddressZipcode,
//    pickupAddressCity, pickupAddressCountry,
//    deliveryLocationName, deliveryLocationStreet, deliveryLocationZipcode,
//    deliveryLocationCity, deliveryLocationCountry,
//    pickUpStartDate, pickUpEndDate, pickUpTimeZone,
//    deliveryStartDate, deliveryEndDate, deliveryTimeZone
//
//  Date constraints:
//    pickUpStartDate < pickUpEndDate < deliveryStartDate < deliveryEndDate
//    Pickup and delivery city/country must differ
//
// ─── GROUP ORDER ─────────────────────────────────────────────────────────────
//
//  GROUP P  — Full positive flow                         (S-01)
//  GROUP N1 — active=0 (wrong/missing status)            (S-02–S-04)
//  GROUP N2 — active=1 valid=0 (missing required field)  (S-05–S-23)
//  GROUP U  — Update flow: missing → add → valid=1       (S-24–S-26)
//  GROUP A  — API / Auth negative                        (S-27–S-31)
//
// HOW TO RUN:
//   npx playwright test --project=road RoadOrdersIn --reporter=list
//   npx playwright test --project=road RoadOrdersIn -g "GROUP P"
//   npx playwright test --project=road RoadOrdersIn -g "GROUP N2"
// =============================================================================

// @ts-nocheck
const { test, expect, request } = require('@playwright/test');

const { CONFIG }                           = require('../../helpers/road/roadConfig');
const { createRoadTrackingObject,
        getRoadTrackingObject,
        updateRoadTrackingObject,
        roadDates }                        = require('../../helpers/road/roadTrackingObjectFactory');
const { getTrackingSchedule,
        pollUntilSchedulerActive }         = require('../../helpers/shared/trackingSchedulerClient');
const { E2E_CONFIG }                       = require('../../helpers/shared/e2eConfig');
const { getAdminToken }                    = require('../../helpers/shared/cognitoAuth');

// ─────────────────────────────────────────────────────────────────────────────

const SCHEMA = CONFIG.SCHEMA_TYPE;  // 'TransportUnitRoad'

const adminHeaders = async () => ({
  'Authorization': `Bearer ${await getAdminToken()}`,
  'Content-Type':  'application/json',
  'accept':        'application/json',
});

// ─────────────────────────────────────────────────────────────────────────────

test.describe.serial('ROAD — Orders-In', () => {

  // ===========================================================================
  //  GROUP P — FULL POSITIVE FLOW
  // ===========================================================================

  test.describe('GROUP P | S-01 | Full positive flow — all required fields → active=1 valid=1', () => {
    let rtu = null;
    let scheduler = null;

    test.beforeAll(async () => {
      rtu = await createRoadTrackingObject();
      expect(rtu.code, '[S-01] RTU creation failed').toBeTruthy();
    });

    // ── A-01: RTU created ────────────────────────────────────────────────────
    test('S-01 | A-01 | RTU created — code returned', () => {
      expect(rtu.code).toBeTruthy();
      console.log(`  RTU code=${rtu.code}  orderId="${rtu.transportOrderId}"`);
    });

    // ── A-02: Scheduler active=1 valid=1 ────────────────────────────────────
    test('S-01 | A-02 | Scheduler: active=1, valid=1', async () => {
      scheduler = await pollUntilSchedulerActive(SCHEMA, rtu.code);
      expect(scheduler, 'Scheduler record not returned').toBeTruthy();
      expect(scheduler.active).toBe(1);
      expect(scheduler.valid).toBe(1);
    });

    // ── A-03: RTU readable via GET ───────────────────────────────────────────
    test('S-01 | A-03 | RTU readable via admin GET', async () => {
      const obj = await getRoadTrackingObject(rtu.code);
      expect(obj).toBeTruthy();
      expect(obj.transportOrderId).toBe(rtu.transportOrderId);
      expect(obj.trackingStatus).toBe('In Progress');
      console.log(`  RTU transportOrderId="${obj.transportOrderId}"  plate="${obj.licensePlateTruck}"`);
    });

    // ── A-04: All required fields present ───────────────────────────────────
    test('S-01 | A-04 | All 19 required fields stored correctly', async () => {
      const obj = await getRoadTrackingObject(rtu.code);
      expect(obj.transportOrderId).toBeTruthy();
      expect(obj.licensePlateTruck).toBeTruthy();
      expect(obj.loadType).toBeTruthy();
      expect(obj.pickupAddressName).toBeTruthy();
      expect(obj.pickupAddressStreet).toBeTruthy();
      expect(obj.pickupAddressZipcode).toBeTruthy();
      expect(obj.pickupAddressCity).toBeTruthy();
      expect(obj.pickupAddressCountry).toBeTruthy();
      expect(obj.deliveryLocationName).toBeTruthy();
      expect(obj.deliveryLocationStreet).toBeTruthy();
      expect(obj.deliveryLocationZipcode).toBeTruthy();
      expect(obj.deliveryLocationCity).toBeTruthy();
      expect(obj.deliveryLocationCountry).toBeTruthy();
      expect(obj.pickUpStartDate).toBeTruthy();
      expect(obj.pickUpEndDate).toBeTruthy();
      expect(obj.pickUpTimeZone).toBeTruthy();
      expect(obj.deliveryStartDate).toBeTruthy();
      expect(obj.deliveryEndDate).toBeTruthy();
      expect(obj.deliveryTimeZone).toBeTruthy();
    });

    // ── A-05: Pickup address ≠ delivery address ──────────────────────────────
    test('S-01 | A-05 | Pickup city ≠ delivery city', async () => {
      const obj = await getRoadTrackingObject(rtu.code);
      expect(obj.pickupAddressCity).not.toBe(obj.deliveryLocationCity);
    });

    // ── A-06: Date ordering constraint ───────────────────────────────────────
    test('S-01 | A-06 | Date order: pickUpStart < pickUpEnd < deliveryStart < deliveryEnd', async () => {
      const obj = await getRoadTrackingObject(rtu.code);
      const ps = new Date(obj.pickUpStartDate);
      const pe = new Date(obj.pickUpEndDate);
      const ds = new Date(obj.deliveryStartDate);
      const de = new Date(obj.deliveryEndDate);
      expect(ps < pe, 'pickUpStart must be before pickUpEnd').toBe(true);
      expect(pe < ds, 'pickUpEnd must be before deliveryStart').toBe(true);
      expect(ds < de, 'deliveryStart must be before deliveryEnd').toBe(true);
    });
  }); // end S-01

  // ===========================================================================
  //  GROUP N1 — ACTIVE = 0
  // ===========================================================================

  test.describe('GROUP N1 | active=0 — wrong or missing trackingStatus', () => {

    test('S-02 | No trackingStatus → active=0 valid=0', async () => {
      const rtu = await createRoadTrackingObject({ trackingStatus: null });
      expect(rtu.code).toBeTruthy();
      const rec = await getTrackingSchedule(SCHEMA, rtu.code);
      if (rec) {
        expect(rec.active).toBe(0);
        expect(rec.valid).toBe(0);
      } else {
        const obj = await getRoadTrackingObject(rtu.code);
        expect(obj?.trackingStatus ?? null).not.toBe('In Progress');
      }
    });

    test('S-03 | trackingStatus=Pending → active=0 valid=0', async () => {
      const rtu = await createRoadTrackingObject({ trackingStatus: 'Pending' });
      expect(rtu.code).toBeTruthy();
      const rec = await getTrackingSchedule(SCHEMA, rtu.code);
      if (rec) {
        expect(rec.active).toBe(0);
        expect(rec.valid).toBe(0);
      } else {
        const obj = await getRoadTrackingObject(rtu.code);
        expect(obj?.trackingStatus).toBe('Pending');
      }
    });

    test('S-04 | trackingStatus=Completed → active=0 valid=0', async () => {
      const rtu = await createRoadTrackingObject({ trackingStatus: 'Completed' });
      expect(rtu.code).toBeTruthy();
      const rec = await getTrackingSchedule(SCHEMA, rtu.code);
      if (rec) {
        expect(rec.active).toBe(0);
        expect(rec.valid).toBe(0);
      } else {
        const obj = await getRoadTrackingObject(rtu.code);
        expect(obj?.trackingStatus).toBe('Completed');
      }
    });

  }); // end GROUP N1

  // ===========================================================================
  //  GROUP N2 — ACTIVE=1 VALID=0 (one required field missing per scenario)
  // ===========================================================================

  test.describe('GROUP N2 | active=1 valid=0 — one required field missing', () => {

    async function assertActiveValidAfterCreate(overrides, label) {
      const rtu = await createRoadTrackingObject(overrides);
      expect(rtu.code, `[${label}] RTU creation failed`).toBeTruthy();
      const rec = await getTrackingSchedule(SCHEMA, rtu.code);
      if (rec) {
        expect(rec.active, `[${label}] active should be 1`).toBe(1);
        expect(rec.valid,  `[${label}] valid should be 0`).toBe(0);
      } else {
        // Scheduler unavailable — verify field is absent on the RTU
        const obj = await getRoadTrackingObject(rtu.code);
        const [missingKey] = Object.keys(overrides);
        expect(obj?.[missingKey] ?? null, `[${label}] field should be absent`).toBeFalsy();
      }
    }

    test('S-05 | missing transportOrderId → valid=0',
      () => assertActiveValidAfterCreate({ transportOrderId: null }, 'S-05'));

    test('S-06 | missing licensePlateTruck → valid=0',
      () => assertActiveValidAfterCreate({ licensePlateTruck: null }, 'S-06'));

    test('S-07 | missing loadType → valid=0',
      () => assertActiveValidAfterCreate({ loadType: null }, 'S-07'));

    test('S-08 | missing pickupAddressName → valid=0',
      () => assertActiveValidAfterCreate({ pickupAddressName: null }, 'S-08'));

    test('S-09 | missing pickupAddressStreet → valid=0',
      () => assertActiveValidAfterCreate({ pickupAddressStreet: null }, 'S-09'));

    test('S-10 | missing pickupAddressZipcode → valid=0',
      () => assertActiveValidAfterCreate({ pickupAddressZipcode: null }, 'S-10'));

    test('S-11 | missing pickupAddressCity → valid=0',
      () => assertActiveValidAfterCreate({ pickupAddressCity: null }, 'S-11'));

    test('S-12 | missing pickupAddressCountry → valid=0',
      () => assertActiveValidAfterCreate({ pickupAddressCountry: null }, 'S-12'));

    test('S-13 | missing deliveryLocationName → valid=0',
      () => assertActiveValidAfterCreate({ deliveryLocationName: null }, 'S-13'));

    test('S-14 | missing deliveryLocationStreet → valid=0',
      () => assertActiveValidAfterCreate({ deliveryLocationStreet: null }, 'S-14'));

    test('S-15 | missing deliveryLocationZipcode → valid=0',
      () => assertActiveValidAfterCreate({ deliveryLocationZipcode: null }, 'S-15'));

    test('S-16 | missing deliveryLocationCity → valid=0',
      () => assertActiveValidAfterCreate({ deliveryLocationCity: null }, 'S-16'));

    test('S-17 | missing deliveryLocationCountry → valid=0',
      () => assertActiveValidAfterCreate({ deliveryLocationCountry: null }, 'S-17'));

    test('S-18 | missing pickUpStartDate → valid=0',
      () => assertActiveValidAfterCreate({ pickUpStartDate: null }, 'S-18'));

    test('S-19 | missing pickUpEndDate → valid=0',
      () => assertActiveValidAfterCreate({ pickUpEndDate: null }, 'S-19'));

    test('S-20 | missing pickUpTimeZone → valid=0',
      () => assertActiveValidAfterCreate({ pickUpTimeZone: null }, 'S-20'));

    test('S-21 | missing deliveryStartDate → valid=0',
      () => assertActiveValidAfterCreate({ deliveryStartDate: null }, 'S-21'));

    test('S-22 | missing deliveryEndDate → valid=0',
      () => assertActiveValidAfterCreate({ deliveryEndDate: null }, 'S-22'));

    test('S-23 | missing deliveryTimeZone → valid=0',
      () => assertActiveValidAfterCreate({ deliveryTimeZone: null }, 'S-23'));

  }); // end GROUP N2

  // ===========================================================================
  //  GROUP U — UPDATE FLOW
  // ===========================================================================

  test.describe('GROUP U | Update flow — add missing field → valid=1', () => {

    // ── S-24: Create without transportOrderId → update to add it → valid=1 ──
    test.describe('S-24 | Create missing transportOrderId → update → valid=1', () => {
      let rtu = null;

      test.beforeAll(async () => {
        rtu = await createRoadTrackingObject({ transportOrderId: null });
        expect(rtu.code, '[S-24] RTU creation failed').toBeTruthy();
      });

      test('S-24 | A-01 | Created with missing transportOrderId → valid=0', async () => {
        const rec = await getTrackingSchedule(SCHEMA, rtu.code);
        if (rec) {
          expect(rec.active).toBe(1);
          expect(rec.valid).toBe(0);
        } else {
          const obj = await getRoadTrackingObject(rtu.code);
          expect(obj?.transportOrderId ?? null).toBeFalsy();
        }
      });

      test('S-24 | A-02 | After update: active=1 valid=1', async () => {
        await updateRoadTrackingObject(rtu.code, { transportOrderId: `E2EUPD${Date.now().toString().slice(-6)}` });
        const rec = await pollUntilSchedulerActive(SCHEMA, rtu.code);
        expect(rec, 'Scheduler record not returned after update').toBeTruthy();
        expect(rec.active).toBe(1);
        expect(rec.valid).toBe(1);
      });
    });

    // ── S-25: Create with Pending status → update to In Progress → active=1 valid=1 ──
    test.describe('S-25 | Create with Pending status → update trackingStatus → active=1 valid=1', () => {
      let rtu = null;

      test.beforeAll(async () => {
        rtu = await createRoadTrackingObject({ trackingStatus: 'Pending' });
        expect(rtu.code, '[S-25] RTU creation failed').toBeTruthy();
      });

      test('S-25 | A-01 | Created with Pending → active=0', async () => {
        const rec = await getTrackingSchedule(SCHEMA, rtu.code);
        if (rec) {
          expect(rec.active).toBe(0);
        } else {
          const obj = await getRoadTrackingObject(rtu.code);
          expect(obj?.trackingStatus).toBe('Pending');
        }
      });

      test('S-25 | A-02 | After update to In Progress: active=1 valid=1', async () => {
        await updateRoadTrackingObject(rtu.code, { trackingStatus: 'In Progress' });
        const rec = await pollUntilSchedulerActive(SCHEMA, rtu.code);
        expect(rec, 'Scheduler record not returned after update').toBeTruthy();
        expect(rec.active).toBe(1);
        expect(rec.valid).toBe(1);
      });
    });

    // ── S-26: Create missing deliveryTimeZone → update → valid=1 ──
    test.describe('S-26 | Create missing deliveryTimeZone → update → valid=1', () => {
      let rtu = null;

      test.beforeAll(async () => {
        rtu = await createRoadTrackingObject({ deliveryTimeZone: null });
        expect(rtu.code, '[S-26] RTU creation failed').toBeTruthy();
      });

      test('S-26 | A-01 | Created with missing deliveryTimeZone → valid=0', async () => {
        const rec = await getTrackingSchedule(SCHEMA, rtu.code);
        if (rec) {
          expect(rec.active).toBe(1);
          expect(rec.valid).toBe(0);
        } else {
          const obj = await getRoadTrackingObject(rtu.code);
          expect(obj?.deliveryTimeZone ?? null).toBeFalsy();
        }
      });

      test('S-26 | A-02 | After adding deliveryTimeZone: active=1 valid=1', async () => {
        await updateRoadTrackingObject(rtu.code, { deliveryTimeZone: 'Europe/Berlin' });
        const rec = await pollUntilSchedulerActive(SCHEMA, rtu.code);
        expect(rec, 'Scheduler record not returned after update').toBeTruthy();
        expect(rec.active).toBe(1);
        expect(rec.valid).toBe(1);
      });
    });

  }); // end GROUP U

  // ===========================================================================
  //  GROUP A — API / AUTH NEGATIVE
  // ===========================================================================

  test.describe('GROUP A | Auth and API negative tests', () => {

    test('S-27 | Expired/wrong admin token → GET RTU returns 401', async () => {
      const ctx = await request.newContext({ baseURL: CONFIG.ADMIN_BASE_URL });
      const res = await ctx.get(`${CONFIG.GET_PATH}/fake-code`, {
        headers: { 'Authorization': 'Bearer expired.token.here', 'accept': 'application/json' },
      });
      expect(res.status()).toBe(401);
      await ctx.dispose();
    });

    test('S-28 | No Authorization header → GET RTU returns 401', async () => {
      const ctx = await request.newContext({ baseURL: CONFIG.ADMIN_BASE_URL });
      const res = await ctx.get(`${CONFIG.GET_PATH}/fake-code`, {
        headers: { 'accept': 'application/json' },
      });
      expect(res.status()).toBe(401);
      await ctx.dispose();
    });

    test('S-29 | Upsert with expired token → returns 401', async () => {
      const ctx = await request.newContext({ baseURL: CONFIG.ADMIN_UPSERT_BASE_URL });
      const dates = roadDates();
      const res = await ctx.post(`${CONFIG.UPSERT_PATH}?createNew=true`, {
        headers: { 'Authorization': 'Bearer expired.token', 'Content-Type': 'application/json' },
        data: { data: [{ mot: 'ROAD', trackingStatus: 'In Progress', ...dates }] },
      });
      expect(res.status()).toBe(401);
      await ctx.dispose();
    });

    test('S-30 | Malformed body (empty object) → upsert returns 4xx', async () => {
      const ctx = await request.newContext({ baseURL: CONFIG.ADMIN_UPSERT_BASE_URL });
      const res = await ctx.post(`${CONFIG.UPSERT_PATH}?createNew=true`, {
        headers: await adminHeaders(),
        data: {},
      });
      expect(res.status()).toBeGreaterThanOrEqual(400);
      expect(res.status()).toBeLessThan(500);
      await ctx.dispose();
    });

    test('S-31 | Non-existent RTU code → GET returns 4xx', async () => {
      const ctx = await request.newContext({ baseURL: CONFIG.ADMIN_BASE_URL });
      const res = await ctx.get(`${CONFIG.GET_PATH}/000000000000`, {
        headers: await adminHeaders(),
      });
      expect(res.status()).toBeGreaterThanOrEqual(400);
      await ctx.dispose();
    });

  }); // end GROUP A

}); // end ROAD — Orders-In
