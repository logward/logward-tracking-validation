# Logward Tracking Mapping — Claude Code Context

Playwright API test automation for the **Logward ↔ Shippeo** ocean and air tracking integrations.
No browser UI — pure HTTP API testing. `workers: 1`, serial execution.

---

## Project Structure

```
tests/
  ocean/
    OceanOrdersIn.spec.js  — 43 Orders-In scenarios (S-01 to S-43), 105 tests
    OceanEventsOut.spec.js — 152+ Events-Out field mapping tests
  air/
    AirOrdersIn.spec.js    — Air Orders-In: positive, negative, edge cases (all tracking key types)
    AirEventsOut.spec.js   — Air full lifecycle: Orders-In gates + all Events-Out field mapping
scripts/
  runAirOrdersIn.js           — Interactive runner: prompts for tracking key type, then runs AirOrdersIn
  runAirEventsOutSession.js   — Long-running air session: stays alive, pick blocks interactively, HTML report at end
  runOceanEventsOut.js        — Interactive CLI to pick and run ocean Events-Out test groups
  runOceanEventsOutSession.js — Long-running ocean session: stays alive across runs, consolidated HTML report at end
  publishReports.js           — Publish generated HTML reports
helpers/
  shared/                  — Shared infrastructure used by both ocean and air tests
    e2eConfig.js           — ALL tokens and URLs live here (single source of truth)
    cognitoAuth.js         — Auto-login for Logward admin (kvsm.vikas@logward.com)
    shippeoAuth.js         — Auto-refresh Shippeo token (headless seeder or disk cache)
    seedShippeoToken.js    — Run once per session: opens browser, captures Shippeo token
    trackingObjectFactory.js   — Create/read TransportUnitOcean via external API
    trackingSchedulerClient.js — Scheduler API + OTU/ATU-derived fallback
    trackingServiceClient.js   — MongoDB xtrackings check (ocean + air)
    shippeoApiClient.js    — Shippeo search + order details assertions
    ordersInFlowReporter.js — HTML report generator for Orders-In flow
    ordersInReporter.js    — HTML report variant for Orders-In
    eventsOutReporter.js   — HTML report for OceanEventsOut.spec.js
    auditHelpers.js        — Query the Logward audit log API
  ocean/                   — Ocean-specific helpers
    oceanEventsValidator.js — Random location pool (10 ports) + vessel pool (20 vessels) + mapping assertions
    oceanPayloadFactory.js  — Webhook payload builder (makePayload, buildTspPayload)
    oceanSites.js           — Port/location constants (SITE.NGB_POL, SITE.RTM_POD etc.)
    oceanConfig.js          — Ocean-specific config shortcuts
  air/                     — Air-specific helpers
    airConfig.js           — Air-specific config (URLs, paths, webhook token per env)
    airSites.js            — IATA site constants (SITE.BLR/BOM) + HUB_POOL (10 airports) + pickHubs()
    airPayloadFactory.js   — Webhook payload builder + all date buckets (T2/T3/T4/T5_DATES)
    airTrackingObjectFactory.js — Create/read/update airTransportUnit via admin API (Cognito auth)
    airHubHelpers.js       — resolveHubSlot() + resolvePrefix() for Type 4/5 routing
    airValidation.js       — assertField() + valuesMatch()
docs/
  Ocean_E2E_Testing_Overview.md    — Full E2E test overview (for demos/presentations)
  TSP_Transhipment_Tests_3.md     — TSP transhipment test spec (76 tests, source of truth, branch DP-449)
  Direct_Shipment_Tests_1.md      — Direct shipment field mapping spec (73 tests)
```

---

## How to Run

### Ocean

```bash
# All Orders-In (43 scenarios, ~10 min)
npx playwright test --project=ocean OceanOrdersIn --reporter=list

# Single group
npx playwright test --project=ocean OceanOrdersIn -g "GROUP P"
npx playwright test --project=ocean OceanOrdersIn -g "GROUP U"
npx playwright test --project=ocean OceanOrdersIn -g "GROUP N1"
npx playwright test --project=ocean OceanOrdersIn -g "GROUP N2"
npx playwright test --project=ocean OceanOrdersIn -g "GROUP S"
npx playwright test --project=ocean OceanOrdersIn -g "GROUP A"

# Single scenario
npx playwright test --project=ocean OceanOrdersIn --grep "GROUP P \| Full Positive Flow.*S-01"

# Full E2E (Events-Out field mapping, ~45 min)
npx playwright test --project=ocean OceanEventsOut --reporter=list

# Open latest report
open playwright-report/runs/$(ls playwright-report/runs/ | tail -1)/ocean/ordersIn-flow-report.html
```

### Air

```bash
# AirOrdersIn — interactive runner (prompts for tracking key)
node scripts/runAirOrdersIn.js
# → asks: 1) MAWB  2) HAWB  3) Customer Reference
# → runs all groups (positive, negative, edge cases) for both IATA and Inland site types

# AirOrdersIn — single group (tracking key set via env)
AIR_TRACKING_KEY=mawb npx playwright test --project=air AirOrdersIn -g "GROUP P"
AIR_TRACKING_KEY=hawb npx playwright test --project=air AirOrdersIn -g "GROUP N2"

# E2E Air — full lifecycle (creates fresh ATU, all event blocks, ~30 min)
npx playwright test --project=air AirEventsOut --reporter=list

# E2E Air — single block
npx playwright test --project=air AirEventsOut -g "BLOCK T2"
npx playwright test --project=air AirEventsOut -g "BLOCK T4"
npx playwright test --project=air AirEventsOut -g "BLOCK T5"
npx playwright test --project=air AirEventsOut -g "BLOCK N"

# E2E Air — single event
npx playwright test --project=air AirEventsOut -g "received_from_shipper"
npx playwright test --project=air AirEventsOut -g "manifested — hub"

# Air Events-Out interactive session (creates ATU, pick blocks, runs webhook, asserts, HTML report)
node scripts/runAirEventsOutSession.js
# → asks: create / manual ATU setup
# → hub pool (4 random airports) printed at start
# → loop: pick block (d / t2 / t3 / t4 / t5 / negative / finish)
# → type "finish" to close and open HTML report
```

---

## Token Setup (IMPORTANT — read before every session)

All tokens are in `helpers/shared/e2eConfig.js`. Never edit any other file for tokens.

### Logward Admin Token (Cognito)
**Fully automatic** — `cognitoAuth.js` logs in as `kvsm.vikas@logward.com` automatically.
Credentials stored in `e2eConfig.js` → `COGNITO.username / password`.
Token cached to `.cognito-token-cache.json` — survives across describe blocks.
No manual steps needed.

### Shippeo Token
**Semi-automatic** — seed once per day when expired:
```bash
node helpers/shared/seedShippeoToken.js
# Browser opens → log in → closes automatically → token saved to .shippeo-token-cache.json
```
After seeding, auto-refreshes every 15 min for the rest of the session.
If cache is stale (overnight): `rm .shippeo-token-cache.json` then re-seed.

### Webhook Token
Long-lived (expires 2027) — already in config. No action needed.

---

## Key Architecture Decisions

### URLs (QA environment)
- **OTU create/update**: `qa.logward.engineering/api/tower/data/TransportUnitOcean/upsert` + Cognito token
- **OTU read**: `qa-admin.logward.engineering/api/tower/data/TransportUnitOcean/{code}` + Cognito token
- **ATU create/update**: `qa.logward.engineering/api/tower/data/airTransportUnit/upsert` + Cognito token
- **ATU read**: `qa-admin.logward.engineering/api/tower/data/airTransportUnit/{code}` + Cognito token
- **Scheduler**: `qa.logward.engineering/api/tracking/track/schedule/...` + Cognito token
- **MongoDB check**: `qa.logward.engineering/api/tracking/...` + Cognito token
- **Webhook (ocean events)**: `qa.logward.engineering/api/integration-hub/tracking/shippeo/ocean_order_event_out` + webhook token
- **Webhook (air events)**: `qa.logward.engineering/api/integration-hub/tracking/shippeo/air_tracking` + webhook token
- **Shippeo search**: `api.shippeo.com/core/orders/debug/search` + auto-refreshed Shippeo token
- **Shippeo details**: `api.shippeo.com/core/ocean/order/{hashid}/debug/details` + Shippeo token

### Scheduler Fallback
The real scheduler API (`/api/tracking/track/schedule/...`) returns HTTP 500 for some OTU/ATU states.
`trackingSchedulerClient.js` falls back to deriving `active`/`valid` from the object GET response.
- **Ocean rule**: `active=1` if `trackingStatus=In Progress`; `valid=1` if active + (BN or BL) + CN + SCAC.
- **Air rule**: `active=1` if `trackingStatus=In Progress`; `valid=1` if active + MAWB (for MAWB type) or HAWB+FFD (for HAWB) or customerRef+FFD (for customerRef).

### Random Data per Run
- **Booking/BL numbers**: unique per scenario (`E2EBOOK01xxxx` with timestamp suffix)
- **Container numbers**: unique per scenario (`LGTE{seq}{ts}`)
- **Carrier SCAC**: random from pool of 5 (MSCU, MAEU, CMDU, COSU, HLCU)
- **Ocean event locations**: random from pool of 10 real ports (proves live mapping)
- **Ocean vessels**: random from pool of 20 real vessels
- **Air MAWB/clientRef**: unique per scenario (`E2EAIR{seq}{ts}` / `E2ECRF{seq}{ts}`)
- **Air hub airports**: 4 picked randomly each run from `HUB_POOL` (10 airports) — see below

### Air Hub Pool (`helpers/air/airSites.js`)
`HUB_POOL` contains 10 real international cargo-hub airports:
```
DXB (Dubai, AE)    FRA (Frankfurt, DE)  SIN (Singapore, SG)  AMS (Amsterdam, NL)
CDG (Paris, FR)    LHR (London, GB)     DOH (Doha, QA)       HKG (Hong Kong, HK)
NRT (Tokyo, JP)    ICN (Seoul, KR)
```
`pickHubs(4)` Fisher-Yates shuffles the pool and returns 4 unique airports, frozen for the whole run.
Slots are positional: `HUBS[0]=stop1`, `HUBS[1]=stop2`, `HUBS[2]=stop3`, `HUBS[3]=stop4`.
A-01 prints the selection: `Hub pool (run): stop1=LHR  stop2=DOH  stop3=SIN  stop4=CDG`.

### Air Event Routing
Events route to the correct ATU via `order.client_reference` = `clientReference` (not the MAWB).
`makeE2EPayload()` in `AirEventsOut.spec.js` injects `state.clientRef` and `state.mawb` into every payload automatically.

### Known Webhook Issue (Ocean)
`clientId: Vbc1r8621FLbtFFl2E` + webhook token (`accountId: 0010Q00000TZosQQAT`) must be used together.
If the webhook returns `UnauthorisedClient`, check that `OCEAN.WEBHOOK_TOKEN` in `e2eConfig.js`
still has `accountId: 0010Q00000TZosQQAT` (not the external API token).

---

## Test Groups — Ocean Orders-In

| Group | Scenarios | What it tests |
|---|---|---|
| GROUP P | S-01–S-03 | Full positive flow: Create → Scheduler → MongoDB → Shippeo (search + details) → 4 Events + mapping assertions |
| GROUP U | S-18–S-23 | Update flow: create with missing fields → update → valid=1 → Shippeo → Events |
| GROUP S | S-36–S-37 | Shippeo standalone: wrong reference, expired token |
| GROUP N1 | S-04–S-09 | active=0 valid=0 — wrong/missing status, flow stops at scheduler |
| GROUP N2 | S-10–S-17 | active=1 valid=0 — InProgress but incomplete tracking fields |
| GROUP A | S-38–S-43 | API/auth negative: expired token, wrong token, malformed body |

### ATC Rules — Ocean
- `active=1` when `trackingStatus = "In Progress"`
- `valid=1` when active=1 AND (bookingNumber OR billOfLadingNumber) AND containerNumber AND (carrierScac OR carrierShortName OR carrierName)

### Shippeo Details Assertions (inside GROUP P + U Shippeo step)
After finding shipment by reference, fetches `GET /core/ocean/order/{hashid}/debug/details` and asserts:
- `container.reference` = containerNumber
- `cargo.reference` = containerNumber
- `scacAtCreation` = carrier SCAC
- `oceanCarrier.scacList` contains SCAC
- `oceanCarrier.name` = carrier short name (must match Shippeo's exact name)
- `bookingReferenceList` contains bookingNumber
- `billOfLadingList` contains blNumber

### Carrier name mapping (Shippeo exact names)
```
MSCU → "MSC"
MAEU → "Maersk"
CMDU → "CMA CGM"
COSU → "COSCO"
HLCU → "Hapag-Lloyd"
```

---

## Test Groups — Ocean Events-Out (OceanEventsOut.spec.js)

| Group | Tests | Coverage |
|---|---|---|
| A-01–A-04 | 4 | Orders-In gates |
| D-01–D-08 | 8 | Direct fields (locode, timezone) |
| **TSP-P-01–P-32** | **32** | **Transhipment positive (dates, locode, vessel, combined)** |
| **TSP-N-01–N-17** | **17** | **Transhipment negative** |
| **TSP-E-01–E-11** | **15** | **Transhipment edge cases** |
| PC-01–PC-32 | 32 | Pre-Carriage |
| POL-01–POL-27 | 27 | Port of Loading |
| POD-01–POD-30 | 30 | Port of Discharge |
| DEL-01–DEL-16 | 16 | Delivery |
| X-01–X-13 | 13 | Cross-field edge cases |
| N-01–N-16 | 16 | Negative / API |

### TSP Slot Logic
- `container_arrived` / `container_unloaded` → writes at slot **N** (matched by `event_site.unlocode`)
- `container_departed` / `container_loaded` → writes date/locode at slot **N-1** (vessel at **N**)
- Slot 1 departure → N-1 = 0 → nothing written

---

## Test Groups — Air Orders-In (AirOrdersIn.spec.js)

Run via `node scripts/runAirOrdersIn.js` — prompts for tracking key type only.
Both IATA and Inland site types are covered automatically in every run.

| Group | Scenarios | What it tests |
|---|---|---|
| GROUP P | S-01–S-02 | Full positive flow: IATA sites (S-01) + Inland sites (S-02) → Scheduler → MongoDB → Shippeo → 4 Events |
| GROUP N1 | S-03–S-05 | active=0 — no status, Pending, Completed |
| GROUP N2 | S-06–S-08 | active=1 valid=0 — missing primary key fields (varies by tracking key type) |
| GROUP N3 | S-09–S-11 | valid=1 but missing/partial site fields |
| GROUP U | S-12–S-14 | Update flow: add missing key → valid=1, status Pending→InProgress → valid=1 |
| GROUP E | S-15–S-19 | Edge cases: IATA→Inland update, duplicate primary key, mixed site fields |
| GROUP A | S-20–S-24 | Auth negative: expired/wrong token, malformed body |

### ATC Rules — Air
- `active=1` when `trackingStatus = "In Progress"`
- `valid=1` when active=1 AND:
  - MAWB type → `masterAirWaybillNumber`
  - HAWB type → `houseAirWaybillNumber` + `freightForwarderEdiRef`
  - customerRef type → `airCustomerReference` + `freightForwarderEdiRef`

### ID Generation per Tracking Key
```
MAWB        → masterAirWaybillNumber : E2EAIR{seq}{ts}
HAWB        → houseAirWaybillNumber  : E2EHAW{seq}{ts}
              freightForwarderEdiRef  : E2EFFD{seq}{ts}
customerRef → airCustomerReference   : E2EACR{seq}{ts}
              freightForwarderEdiRef  : E2EFFD{seq}{ts}
clientRef (all types) → clientReference : E2ECRF{seq}{ts}
```

---

## Test Blocks — Air Events-Out (AirEventsOut.spec.js)

Creates a **fresh ATU** each run (MAWB + IATA sites, BLR loading / BOM delivery).
All payloads inject `state.clientRef` and `state.mawb` via `makeE2EPayload()`.
Uses `cognitoAuth.js` (not a static token) so the Cognito token auto-refreshes during the ~30 min run.

| Block | Tests | Coverage |
|---|---|---|
| BLOCK A | A-01–A-04 | Create ATU → Scheduler (active=1 valid=1) → MongoDB → Shippeo search |
| BLOCK D | D-01 | Identifier fields: deliveryCompliantDate, situationCode, justificationCode, orderReference, orderUrl |
| BLOCK T2 | 8 events | Type 2 exact-match events → one date field each |
| BLOCK T3 | 6 events | Type 3 starts-with events → date + justification suffix |
| BLOCK T4 | 10 events | Type 4 hub slot events: 4 random hubs × arrived/left + 2 OR-alias events |
| BLOCK T5 | 18 events | Type 5 routing: manifested / eta_event / received_from_flight × loading / delivery / hub×4 |
| BLOCK N | N-01–N-05 | Negative: wrong clientRef (ATU unchanged), unknown event, missing auth, invalid token, missing ClientId |
| BLOCK S | S-01 | Final ATU field state summary (prints ✅/❌/⬜ for every field group) |

### Air Event Types
- **Type 2** (exact match): event name maps 1-to-1 to a date field
  - `received_from_shipper` → `receivedFromShipperDate`
  - `goods_arrived_at_loading_arrived` → `loadingArrivedDate`
  - `goods_loading_compliant_compliant` → `loadingCompliantDate`
  - `goods_left_loading_left` → `loadingLeftDate`
  - `goods_arrived_at_delivery_arrived` → `deliveryArrivedDate`
  - `goods_left_delivery_left` → `deliveryLeftDate`
  - `documentation_delivered` → `documentationDeliveredDate`
  - `consignee_notified` → `consigneeNotifiedDate`
  - `goods_delivery_compliant_compliant` → `deliveryCompliantDate` + situationCode + justificationCode
- **Type 3** (starts-with): date + justification suffix extracted from event name tail
  - `goods_loading_non_compliant_*` → `loadingNonCompliantDate` + `loadingNonCompliantJustification`
  - `goods_loading_non_realised_*` → `loadingNonRealisedDate` + `loadingNonRealisedJustification`
  - `goods_loading_refused_*` → `loadingRefusedDate` + `loadingRefusedJustification`
  - `goods_delivery_non_compliant_*` → `deliveryNonCompliantDate` + justification
  - `goods_delivery_non_realised_*` → `deliveryNonRealisedDate` + justification
  - `goods_delivery_refused_*` → `deliveryRefusedDate` + justification
- **Type 4** (hub slot): `goods_arrived_at_hub_arrived` / `goods_left_hub_left` → `hubArrivedDate_stopN` / `hubLeftDate_stopN` + 6 hub site fields. Slot N resolved by `resolveHubSlot(atu, iata, country)`.
- **Type 5** (routing): `manifested` / `eta_event` / `received_from_flight` → prefix determined by `resolvePrefix()`:
  - `event_site.iata_code` matches ATU `loadingSiteIata` → `loading` prefix
  - matches `deliverySiteIata` → `delivery` prefix
  - anything else → `hub` prefix + slot

### Hub Slot Logic (Air)
- `resolveHubSlot(atu, iata, country)`: scans `stop1`–`stop4` for matching IATA+country → reuses that slot; else first empty slot; else null (overflow).
- Slots are positional in `T4_DATES` / `T5_DATES`: dxb\*=slot1, fra\*=slot2, sin\*=slot3, ams\*=slot4 — but the airport at each slot is random (see HUB_POOL above).

---

## Common Commands / Debugging

```bash
# Check if Shippeo token works
node -e "const {getShippeoToken}=require('./helpers/shared/shippeoAuth'); getShippeoToken().then(t=>console.log('OK',t.slice(0,30)+'...')).catch(e=>console.error('FAIL:',e.message))"

# Check if Cognito token works
node -e "const {getAdminToken}=require('./helpers/shared/cognitoAuth'); getAdminToken().then(t=>console.log('OK',t.slice(0,30)+'...')).catch(e=>console.error('FAIL:',e.message))"

# See which 4 hub airports will be picked (random each call)
node -e "const {pickHubs}=require('./helpers/air/airSites'); console.log(pickHubs(4).map((h,i)=>'stop'+(i+1)+'='+h.iata_code).join('  '))"

# Clear Shippeo token cache (when chain expires overnight)
rm .shippeo-token-cache.json

# Clear Cognito token cache
rm .cognito-token-cache.json

# Syntax check a file
node --check helpers/shared/e2eConfig.js
node --check tests/air/AirEventsOut.spec.js
```

---

## Files NOT to edit directly

- `.shippeo-token-cache.json` — managed by `shippeoAuth.js`
- `.cognito-token-cache.json` — managed by `cognitoAuth.js`
- `playwright-report/` — auto-generated
- `test-results/` — auto-generated
