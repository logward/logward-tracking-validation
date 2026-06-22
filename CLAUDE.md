# Logward Tracking Mapping — Claude Code Context

Playwright API test automation for the **Logward ↔ Shippeo** ocean tracking integration.
No browser UI — pure HTTP API testing. `workers: 1`, serial execution.

---

## Project Structure

```
tests/
  e2e/ocean/
    OceanOrdersIn.spec.js   — 43 Orders-In scenarios (S-01 to S-43), 105 tests
    E2E_Ocean.spec.js       — 152+ Events-Out field mapping tests
helpers/
  e2e/
    e2eConfig.js            — ALL tokens and URLs live here (single source of truth)
    cognitoAuth.js          — Auto-login for Logward admin (kvsm.vikas@logward.com)
    shippeoAuth.js          — Auto-refresh Shippeo token (headless seeder or disk cache)
    seedShippeoToken.js     — Run once per session: opens browser, captures Shippeo token
    trackingObjectFactory.js — Create/read TUContainer via external API
    trackingSchedulerClient.js — Scheduler API + OTU-derived fallback
    trackingServiceClient.js   — MongoDB xtrackings check
    shippeoApiClient.js     — Shippeo search + order details assertions
    ordersInFlowReporter.js — HTML report generator for Orders-In
  ocean/
    oceanEventsValidator.js — Random location pool (10 ports) + vessel pool (20 vessels) + mapping assertions
    oceanPayloadFactory.js  — Webhook payload builder (makePayload, buildTspPayload)
    oceanSites.js           — Port/location constants (SITE.NGB_POL, SITE.RTM_POD etc.)
    oceanConfig.js          — Ocean-specific config shortcuts
docs/
  Ocean_E2E_Testing_Overview.md    — Full E2E test overview (for demos/presentations)
  TSP_Transhipment_Tests_3.md     — TSP transhipment test spec (76 tests, source of truth, branch DP-449)
  Direct_Shipment_Tests_1.md      — Direct shipment field mapping spec (73 tests)
```

---

## How to Run

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
npx playwright test --project=ocean E2E_Ocean --reporter=list

# Open latest report
open playwright-report/runs/$(ls playwright-report/runs/ | tail -1)/ocean/ordersIn-flow-report.html
```

---

## Token Setup (IMPORTANT — read before every session)

All tokens are in `helpers/e2e/e2eConfig.js`. Never edit any other file for tokens.

### Logward Admin Token (Cognito)
**Fully automatic** — `cognitoAuth.js` logs in as `kvsm.vikas@logward.com` automatically.
Credentials stored in `e2eConfig.js` → `COGNITO.username / password`.
Token cached to `.cognito-token-cache.json` — survives across describe blocks.
No manual steps needed.

// ### Shippeo Token
// **Semi-automatic** — seed once per day when expired:
// ```bash
// node helpers/e2e/seedShippeoToken.js
// # Browser opens → log in → closes automatically → token saved to .shippeo-token-cache.json
// ```
// After seeding, auto-refreshes every 15 min for the rest of the session.
// If cache is stale (overnight): `rm .shippeo-token-cache.json` then re-seed.

### Webhook Token
Long-lived (expires 2027) — already in config. No action needed.

---

## Key Architecture Decisions

### URLs (QA environment)
- **OTU create/update**: `qa.logward.engineering/api/tower/data/TUContainer/upsert` + Cognito token
- **OTU read**: `qa-admin.logward.engineering/api/tower/data/TUContainer/{code}` + Cognito token
- **Scheduler**: `qa.logward.engineering/api/tracking/track/schedule/...` + Cognito token
- **MongoDB check**: `qa.logward.engineering/api/tracking/...` + Cognito token
- **Webhook (events)**: `qa.logward.engineering/api/integration-hub/tracking/shippeo/ocean_order_event_out` + webhook token
- **Shippeo search**: `api.shippeo.com/core/orders/debug/search` + auto-refreshed Shippeo token
- **Shippeo details**: `api.shippeo.com/core/ocean/order/{hashid}/debug/details` + Shippeo token

### Scheduler Fallback
The real scheduler API (`/api/tracking/track/schedule/...`) returns HTTP 500 for some OTU states.
`trackingSchedulerClient.js` falls back to deriving `active`/`valid` from the OTU GET response.
Rule: `active=1` if `trackingStatus=In Progress`; `valid=1` if active + (BN or BL) + CN + SCAC.

### Random Data per Run
- **Booking/BL numbers**: unique per scenario (`E2EBOOK01xxxx` with timestamp suffix)
- **Container numbers**: unique per scenario (`LGTE{seq}{ts}`)
- **Carrier SCAC**: random from pool of 5 (MSCU, MAEU, CMDU, COSU, HLCU)
- **Event locations**: random from pool of 10 real ports (proves live mapping)
- **Vessels**: random from pool of 20 real vessels

### Known Webhook Issue
`clientId: Vbc1r8621FLbtFFl2E` + webhook token (`accountId: 0010Q00000TZosQQAT`) must be used together.
If the webhook returns `UnauthorisedClient`, check that `OCEAN.WEBHOOK_TOKEN` in `e2eConfig.js`
still has `accountId: 0010Q00000TZosQQAT` (not the external API token).

---

## Test Groups — Orders-In

| Group | Scenarios | What it tests |
|---|---|---|
| GROUP P | S-01–S-03 | Full positive flow: Create → Scheduler → MongoDB → Shippeo (search + details) → 4 Events + mapping assertions |
| GROUP U | S-18–S-23 | Update flow: create with missing fields → update → valid=1 → Shippeo → Events |
| GROUP S | S-36–S-37 | Shippeo standalone: wrong reference, expired token |
| GROUP N1 | S-04–S-09 | active=0 valid=0 — wrong/missing status, flow stops at scheduler |
| GROUP N2 | S-10–S-17 | active=1 valid=0 — InProgress but incomplete tracking fields |
| GROUP A | S-38–S-43 | API/auth negative: expired token, wrong token, malformed body |

### ATC Rules (Auto Tracking Conditions)
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

## Test Groups — Events-Out (E2E_Ocean.spec.js)

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

## Common Commands / Debugging

```bash
# Check if Shippeo token works
node -e "const {getShippeoToken}=require('./helpers/e2e/shippeoAuth'); getShippeoToken().then(t=>console.log('OK',t.slice(0,30)+'...')).catch(e=>console.error('FAIL:',e.message))"

# Check if Cognito token works
node -e "const {getAdminToken}=require('./helpers/e2e/cognitoAuth'); getAdminToken().then(t=>console.log('OK',t.slice(0,30)+'...')).catch(e=>console.error('FAIL:',e.message))"

# Clear Shippeo token cache (when chain expires overnight)
rm .shippeo-token-cache.json

# Clear Cognito token cache
rm .cognito-token-cache.json

# Syntax check a file
node --check helpers/e2e/e2eConfig.js
```

---

## Files NOT to edit directly

- `.shippeo-token-cache.json` — managed by `shippeoAuth.js`
- `.cognito-token-cache.json` — managed by `cognitoAuth.js`
- `playwright-report/` — auto-generated
- `test-results/` — auto-generated
