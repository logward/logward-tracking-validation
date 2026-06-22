# Ocean Tracking — End-to-End Test Automation
### Logward ↔ Shippeo Integration | QA Automation Overview

---

## 1. What We're Testing

The ocean tracking integration between **Logward** (TMS) and **Shippeo** (visibility platform). When a shipment is created in Logward, it should automatically appear in Shippeo and receive live tracking events that map back to the correct Logward fields.

```
Logward (create OTU)
       ↓
   Scheduler (ATC check)
       ↓
   MongoDB (xtrackings)
       ↓
   Shippeo (order created)
       ↓
   Webhook Events (Shippeo → Logward)
       ↓
   Logward OTU fields updated ✅
```

---

## 2. Test Architecture

| Item | Detail |
|---|---|
| **Framework** | Playwright (API testing — no browser UI) |
| **Mode** | Serial (gated flow — stop on first gate failure) |
| **Environment** | QA (`qa-admin.logward.engineering`) |
| **Test files** | `OceanOrdersIn.spec.js` — 43 scenarios |
| | `E2E_Ocean.spec.js` — 152 scenarios |
| **Total tests** | **195 automated test scenarios** |
| **Report** | Auto-generated HTML flow report per run |

---

## 3. The Gate Chain (Orders-In)

Every positive scenario must pass **5 gates in sequence**. If any gate fails, the subsequent gates are automatically skipped — preventing false positives.

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐     ┌──────────────────┐     ┌────────────────────┐
│  1. Create OTU  │ ──▶ │  2. Scheduler    │ ──▶ │  3. MongoDB     │ ──▶ │  4. Shippeo      │ ──▶ │  5. Events → OTU   │
│                 │     │                  │     │                 │     │                  │     │                    │
│  POST upsert    │     │  active = 1 ✅   │     │  error: false   │     │  Shipment found  │     │  4 events sent     │
│  TransportUnit  │     │  valid  = 1 ✅   │     │  doc in         │     │  by reference    │     │  Fields populated  │
│  Ocean          │     │                  │     │  xtrackings ✅  │     │  in Shippeo ✅   │     │  in Logward ✅     │
└─────────────────┘     └──────────────────┘     └─────────────────┘     └──────────────────┘     └────────────────────┘
```

### Gate 2 — Scheduler (Auto Tracking Conditions)

| Condition | active | valid |
|---|---|---|
| `trackingStatus = In Progress` | 1 | — |
| `(BN or BL) + CN + SCAC present` | — | 1 |
| Both conditions met | **1** | **1** → Shippeo order created |

### Gate 4 — Shippeo Search

The test searches Shippeo's debug API using the `uniqueReference` format:
- `BookingNumber_ContainerNumber` (when BN present)
- `BLNumber_ContainerNumber` (when only BL present)

---

## 4. Orders-In Test Scenarios (`OceanOrdersIn.spec.js`)

### GROUP P — Full Positive Flow (S-01 to S-03)
All 5 gates pass end-to-end including live Shippeo verification and 4 event mapping assertions.

| ID | Scenario | active | valid |
|---|---|---|---|
| S-01 | BN + BL + CN + SCAC + InProgress | 1 | 1 |
| S-02 | BN + CN + SCAC + InProgress (no BL) | 1 | 1 |
| S-03 | BL + CN + SCAC + InProgress (no BN) | 1 | 1 |

### GROUP U — Update Scenarios (S-18 to S-23)
OTU created with incomplete fields → updated to meet ATC → tracking activates.

| ID | Scenario |
|---|---|
| S-18 | CN + SCAC + InProgress → **add BN** → valid=1 |
| S-19 | CN + SCAC + InProgress → **add BL** → valid=1 |
| S-20 | CN + SCAC + InProgress → **add BN + BL** → valid=1 |
| S-21 | BN + CN + SCAC (no status) → **add InProgress** → valid=1 |
| S-22 | BN + CN + InProgress (no SCAC) → **add SCAC** → valid=1 |
| S-23 | BN + SCAC + InProgress → **CN auto-generated** → valid=1 |

### GROUP N1 — Flow Stops at Scheduler: active=0 valid=0 (S-04 to S-09)
OTU created with wrong/missing status. Scheduler confirms active=0, flow stops correctly.

| ID | Scenario |
|---|---|
| S-04 | No fields at all |
| S-05 | CN only |
| S-06 | BN + CN only |
| S-07 | BN + CN + SCAC (no status) |
| S-08 | BN + CN + SCAC + Status="New" |
| S-09 | BN + CN + SCAC + Status="Completed" |

### GROUP N2 — Flow Stops at Scheduler: active=1 valid=0 (S-10 to S-17)
Status is InProgress (active=1) but tracking fields incomplete (valid=0).

| ID | Scenario |
|---|---|
| S-10 | InProgress only |
| S-11 | BN + InProgress (no CN, no SCAC) |
| S-12 | BL + InProgress (no CN, no SCAC) |
| S-13 | CN + InProgress (no BN/BL, no SCAC) |
| S-14 | BN + SCAC + InProgress — CN auto-generated → valid=1 (edge) |
| S-15 | SCAC + InProgress (no BN/BL) |
| S-16 | BL + SCAC + InProgress — CN auto-generated → valid=1 (edge) |
| S-17 | BN + BL + InProgress (no SCAC) |

### GROUP S — Shippeo Standalone (S-36 to S-37)
Direct Shippeo API behavior tests.

| ID | Scenario |
|---|---|
| S-36 | Wrong reference → Shippeo returns empty result |
| S-37 | Expired Shippeo token → HTTP 401 |

### GROUP A — API & Auth Negative Tests (S-38 to S-43)

| ID | Scenario |
|---|---|
| S-38 | Expired admin token → HTTP 401 |
| S-39 | Wrong account token → 400/401 |
| S-40 | Empty body → HTTP 400 |
| S-41 | Missing containerNumber → HTTP 400 |
| S-42 | Scheduler for non-existent code → null/empty |
| S-43 | MongoDB with all wrong identifiers → empty result |

---

## 5. Events-Out Field Mapping (`E2E_Ocean.spec.js`)

### How Event Mapping is Tested

1. A webhook event is sent from Shippeo to Logward with **random location data** (from a pool of 10 real ports)
2. Logward processes the event and updates the OTU
3. The test fetches the OTU and asserts the **exact field values** match what was sent

> Using random locations proves the mapping reads live from the payload — not hardcoded defaults.

**Example assertion output:**
```
[locations] e1=Singapore(SG)  e2=Busan  e3=Yokohama  e4=Dubai
[locations] loading=BEANR  delivery=AEJEA

MAPPING ASSERTION
situation.event           = "container_gate_out_empty"
event_site.place_type     = "origin_inland_location"
situation.type            = "actual"
──────────────────────────────────────────────────────────────
situation.date        → actualGateOutEmptyDepot   = "2026-06-10 03:16:43"  ✅
event_site.country    → depotPreCountry           = "SG"                   ✅
event_site.city       → depotPreLocation          = "Singapore"            ✅
loading_site.unlocode → carrierUpdatedLocodePol   = "BEANR"               ✅
delivery_site.unlocode→ carrierUpdatedLocodePod   = "AEJEA"               ✅
```

### Orders-In Gate (A-01 to A-04)

| Test | What is verified |
|---|---|
| A-01 | Create `TUContainer` → all stored fields correct |
| A-02 | Scheduler: `active=1`, `valid=1` |
| A-03 | MongoDB `xtrackings` doc exists, `error=false` |
| A-04 | Shippeo: shipment searchable by reference |

### GROUP D — Direct Fields (D-01 to D-08)

Mapping of `loading_site.unlocode`, `delivery_site.unlocode`, `event_site.timezone` directly to OTU fields.

| Tests | Scenarios |
|---|---|
| D-01 to D-03 | Positive — locode + timezone written correctly |
| D-04 to D-05 | Edge — fields update when new unlocode arrives |
| D-06 to D-08 | Negative — null site fields don't crash, field stays null |

### GROUP PC — Pre-Carriage (PC-01 to PC-32)

Events covering depot to port of loading leg.

| Event | Situation | place_type | Fields Mapped |
|---|---|---|---|
| `container_gate_out_empty` | actual | origin_inland / loading | `actualGateOutEmptyDepot`, `depotPreCountry`, `depotPreLocation`, `motGateOutEmpty` |
| `container_gate_out_empty` | estimated (external) | origin_inland | `estimatedGateOutEmptyDepot` |
| `container_departed` | actual | origin_inland | `actualDepartureFromOrigin`, `motPickUpOrigin`, `pickUpOriginCountry/Location` |
| `container_departed` | estimated (external) | origin_inland | `estimatedDepartureFromOrigin` |
| `container_loaded` | actual | origin_inland | `actualLoadedAtOrigin` |
| `container_loaded` | estimated (external) | origin_inland | `estimatedLoadedAtOrigin` |

> **32 tests** covering positive, negative (wrong place_type), and edge cases (null city/country).

### GROUP POL — Port of Loading (POL-01 to POL-27)

Events at the loading port including vessel data.

| Event | Situation | Fields Mapped |
|---|---|---|
| `container_gate_out_full` | actual | `actualGateOutFullPol` |
| `container_arrived` | actual | `actualArrivalPol` |
| `container_gate_in_full` | actual | `actualGateInPol` |
| `container_loaded` | actual + vessel | `actualLoadPol`, `leg1VesselImoNumber`, `leg1VesselName` |
| `container_departed` | actual / estimated / predicted | `actualDeparturePol`, `estimatedDeparturePol`, `predictedDeparturePol` |
| Transhipment events | actual | `tsp1ActualArrival`, `tsp1VesselImoNumber` etc. |

> **27 tests** including vessel resource mapping, transhipment scenarios, and edge cases.

### GROUP POD — Port of Discharge (POD-01 to POD-30)

Events at destination port.

| Event | Situation | Fields Mapped |
|---|---|---|
| `eta_event` | estimated / predicted | `estimatedArrivalPod`, `predictedArrivalPod` |
| `container_arrived` | actual | `actualArrivalPod` |
| `container_unloaded` | actual / estimated / predicted | `actualDischargePod`, `estimatedDischargePod` |
| `container_gate_out_full` | actual | `actualGateOutFullPod` |
| `container_gate_in_full` | actual | `actualGateInPod`, `motGateOutPod` |
| `container_gate_out_empty` | actual | `actualEmptyReturn` |

> **30 tests** including ETA update logic, gate-out/in sequences, and negative cases.

### GROUP DEL — Delivery (DEL-01 to DEL-16)

Events at the final destination (destination inland).

| Event | Situation | Fields Mapped |
|---|---|---|
| `container_arrived` | actual | `actualArrivalDestination`, `destinationCity`, `destinationCountry` |
| `container_arrived` | estimated (external) | `estimatedArrivalDestination` |
| `container_gate_in_empty` | actual | `actualEmptyReturn` |
| `container_gate_in_empty` | estimated (external) | `estimatedEmptyReturn` |

> **16 tests** including edge case where delivery date overwrites POD date for `actualEmptyReturn`.

### GROUP X — Cross-Field & Edge Cases (X-01 to X-13)

| Test | What is verified |
|---|---|
| X-01 | Direct fields written on estimated events |
| X-02 | Direct fields written regardless of place_type |
| X-04 | Same event twice with different dates → latest date wins |
| X-05 | Same event twice with same date → field unchanged |
| X-06 | `actualEmptyReturn` from POD then delivery → delivery wins |
| X-07 | `depotPreCountry` overwritten by later event |
| X-09 | `transport_mode = "rail"` → `motGateOutEmpty = "rail"` |
| X-10 | Date far future (2099) maps correctly |
| X-11 | Date in past (2020) maps correctly |
| X-12 | Date with timezone offset (+02:00) stored correctly |

### GROUP N — Negative / API Tests (N-01 to N-16)

Verifies the system rejects invalid requests correctly.

| Tests | Scenarios |
|---|---|
| N-01 to N-03 | Empty body, wrong container format, missing event → HTTP 400 |
| N-04 to N-06 | Unknown event type, unknown place_type → no field updated |
| N-07 to N-09 | Null date, null transport_mode → field stays null |
| N-10 to N-13 | Wrong clientId, expired webhook token, tampered token → HTTP 401/403 |
| N-14 to N-16 | Container not in Logward → 200 (ignored), no OTU updated |

---

## 6. Token Management (Fully Automated)

| Token | Expires | How Managed |
|---|---|---|
| Logward Admin Token | ~1 hour | Paste in `e2eConfig.js` before run |
| Shippeo Access Token | 15 minutes | **Auto-refreshed** by `shippeoAuth.js` |
| Shippeo Refresh Token | ~4 hours | **Persisted** to `.shippeo-token-cache.json`, chained automatically |

The Shippeo token chain is self-sustaining once seeded. On every Shippeo API call, the helper checks token expiry, refreshes if needed, and saves the new refresh token — no manual intervention.

---

## 7. Test Infrastructure

```
helpers/
├── e2e/
│   ├── e2eConfig.js              ← Central config (tokens, URLs, timeouts)
│   ├── shippeoAuth.js            ← Auto-refresh Shippeo token
│   ├── shippeoApiClient.js       ← Shippeo search API calls
│   ├── trackingObjectFactory.js  ← Create/read Logward OTUs
│   ├── trackingSchedulerClient.js← Scheduler API (active/valid)
│   ├── trackingServiceClient.js  ← MongoDB xtrackings check
│   └── ordersInFlowReporter.js   ← HTML report generator
├── ocean/
│   ├── oceanConfig.js            ← Ocean-specific config
│   ├── oceanPayloadFactory.js    ← Build Shippeo webhook payloads
│   ├── oceanSites.js             ← Port/location definitions
│   ├── oceanEventsValidator.js   ← Random location pool + mapping assertions
│   └── oceanFieldMappings.js     ← Field mapping rules
tests/
└── e2e/ocean/
    ├── OceanOrdersIn.spec.js     ← 43 Orders-In scenarios
    └── E2E_Ocean.spec.js         ← 152 Events-Out field mapping scenarios
```

---

## 8. How to Run

```bash
# Run all Orders-In scenarios
npx playwright test --project=ocean OceanOrdersIn --reporter=list

# Run specific group
npx playwright test --project=ocean OceanOrdersIn -g "GROUP P"
npx playwright test --project=ocean OceanOrdersIn -g "GROUP N1"

# Run full E2E lifecycle (Orders-In + Events-Out)
npx playwright test --project=ocean E2E_Ocean --reporter=list

# Open the HTML flow report
open playwright-report/runs/<timestamp>/ocean/ordersIn-flow-report.html
```

---

## 9. Summary

| Suite | Tests | Coverage |
|---|---|---|
| **Orders-In** | 43 scenarios | Full ATC gate chain, Shippeo sync, event mapping |
| **Events-Out** | 152 scenarios | Every event type × place_type × situation.type combination |
| **Total** | **195 scenarios** | Orders-In + Events-Out end-to-end |

The automation gives full confidence that:
1. Shipments created in Logward correctly activate tracking in Shippeo
2. Every event type sent from Shippeo maps to the correct Logward field
3. Negative cases (wrong status, missing fields, bad tokens) are rejected correctly
4. Field mapping assertions use random data — impossible to pass by coincidence

---

*Generated: 2026-06-10 | Logward QA Automation — Ocean Tracking*
