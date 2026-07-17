# Direct Shipment Field Mapping Tests
**File:** `E2E_Ocean.spec.js`  
**Source:** `Ocean_Events_Out_Mapping.xlsx` → *Copy of Shippeo → Logward Mapping* (non-greyed rows, TSP block rows 60–96 excluded)  
**Stages:** Pre-Carriage · POL · POD · Delivery · Other  
**Updated:** 2026-06-11

---

## Active Mappings

No slot logic. Every field maps directly from a single Shippeo payload field to a single Logward OTU field.

### Pre-Carriage

| # | Logward Field | Shippeo Event | Sit. Type | Data Source | Shippeo Field Path |
|---|---|---|---|---|---|
| 4 | `actualDepartureFromOrigin` | `container_departed` | `actual` | — | `situation.date` |
| 5 | `actualGateOutEmptyDepot` | `container_gate_out_empty` | `actual` | — | `situation.date` |
| 6 | `actualLoadedAtOrigin` | `container_loaded` | `actual` | — | `situation.date` |
| 7 | `depotPreCountry` | `container_gate_out_empty` | `actual` | — | `event_site.country` |
| 8 | `depotPreLocation` | `container_gate_out_empty` | `actual` | — | `event_site.city` |
| 9 | `estimatedDepartureFromOrigin` | `container_departed` | `estimated` | `external` | `situation.date` |
| 10 | `estimatedGateOutEmptyDepot` | `container_gate_out_empty` | `estimated` | `external` | `situation.date` |
| 11 | `estimatedLoadedAtOrigin` | `container_loaded` | `estimated` | `external` | `situation.date` |
| 12 | `motGateOutEmpty` | `container_gate_out_empty` | `actual` | — | `situation.transport_mode` |
| 13 | `motPickUpOrigin` | `container_departed` | `actual` | — | `situation.transport_mode` |
| 14 | `pickUpOriginCountry` | `container_departed` | `actual` | — | `event_site.country` |
| 15 | `pickUpOriginLocation` | `container_departed` | `actual` | — | `event_site.city` |

### POL (Port of Loading)

| # | Logward Field | Shippeo Event | Sit. Type | Data Source | Shippeo Field Path |
|---|---|---|---|---|---|
| 16 | `actualDeparturePol` | `container_departed` | `actual` | — | `situation.date` |
| 17 | `actualGateInPol` | `container_gate_out_full` | `actual` | — | `situation.date` |
| 18 | `actualLoadPol` | `container_loaded` | `actual` | — | `situation.date` |
| 19 | `carrierUpdatedLocodePol` | (any) | any | — | `loading_site.unlocode` |
| 20 | `estimatedDeparturePol` | `container_departed` | `estimated` | `external` | `situation.date` |
| 21 | `estimatedGateInPol` | `container_gate_out_full` | `estimated` | `external` | `situation.date` |
| 22 | `estimatedLoadPol` | `container_loaded` | `estimated` | `external` | `situation.date` |
| 23 | `leg1Mot` | `container_loaded` **+ `container_departed`** ⚠️ | any | — | `situation.transport_mode` |
| 24 | `leg1VesselImoNumber` | `container_loaded` **+ `container_departed`** | any | — | `resources[milestoneVessel].identifiers[IMO].value` |
| 25 | `leg1VesselName` | `container_loaded` **+ `container_departed`** | any | — | `resources[milestoneVessel].identifiers[LABEL].value` |
| 26 | `predictedDeparturePol` | `container_departed` | `estimated` | `shippeo` | `situation.date` |

> ⚠️ **Spec Gap — Discovered via automated testing (2026-06-16)**
> `leg1Mot`, `leg1VesselImoNumber`, and `leg1VesselName` were originally specced as mapping only on `container_loaded`.
> Backend confirmed they also map on `container_departed + loading` (verified: `leg1Mot = "ocean"` written when `container_departed + loading` sent with transport_mode).
> All three fields have **no DS or type condition** — they map regardless of estimated/actual/shippeo.
> Spec updated to reflect actual backend behaviour. Original Excel mapping sheet row 23–25 needs correction.

### POD (Port of Discharge)

| # | Logward Field | Shippeo Event | Sit. Type | Data Source | Shippeo Field Path |
|---|---|---|---|---|---|
| 42 | `actualArrivalPod` | `container_arrived` | `actual` | — | `situation.date` |
| 43 | `actualDischargePod` | `container_unloaded` | `actual` | — | `situation.date` |
| 44 | `actualEmptyReturn` | `container_gate_in_empty` | `actual` | — | `situation.date` |
| 45 | `actualGateOutPod` | `container_gate_out_full` | `actual` | — | `situation.date` |
| 46 | `carrierUpdatedLocodePod` | (any) | any | — | `delivery_site.unlocode` |
| 47 | `estimatedArrivalPod` | `eta_event` | `estimated` | `external` | `situation.date` |
| 48 | `estimatedDischargePod` | `container_unloaded` | `estimated` | `external` | `situation.date` |
| 49 | `estimatedEmptyReturn` | `container_gate_in_empty` | `estimated` | `external` | `situation.date` |
| 50 | `estimatedGateOutPod` | `container_gate_out_full` | `estimated` | `external` | `situation.date` |
| 51 | `motEmptyReturn` | `container_gate_in_empty` | `actual` | — | `situation.transport_mode` |
| 52 | `motGateOutPod` | `container_gate_out_full` | `estimated` | — | `situation.transport_mode` |
| 53 | `predictedArrivalPod` | `eta_event` | `estimated` | `shippeo` | `situation.date` |
| 54 | `predictedDischargePod` | `container_unloaded` | `estimated` | `shippeo` | `situation.date` |
| 55 | `predictedGateOutPod` | `container_gate_out_full` | `estimated` | `shippeo` | `situation.date` |
| — | `trackingArrivingVesselImo` | `eta_event` · `container_arrived` · `container_unloaded` | `estimated` + `actual` | — | `resources[milestoneVessel].identifiers[IMO].value` |
| — | `trackingArrivingVesselVesselName` | `eta_event` · `container_arrived` · `container_unloaded` | `estimated` + `actual` | — | `resources[milestoneVessel].identifiers[LABEL].value` |

### Delivery

| # | Logward Field | Shippeo Event | Sit. Type | Data Source | Shippeo Field Path |
|---|---|---|---|---|---|
| 56 | `actualArrivalDestination` | `container_arrived` | `actual` | — | `situation.date` |
| 57 | `destinationCity` | `container_arrived` | `actual` | — | `event_site.city` |
| 58 | `destinationCountry` | `container_arrived` | `actual` | — | `event_site.country` |
| 59 | `estimatedArrivalDestination` | `container_arrived` | `estimated` | `external` | `situation.date` |

### Other

| # | Logward Field | Shippeo Event | Sit. Type | Data Source | Shippeo Field Path |
|---|---|---|---|---|---|
| 60 | `datetime_timezone` | (any) | any | — | `event_site.timezone` |

---

## Random Data Pools

### POL / POD are fixed per OTU

`loading_site` and `delivery_site` are **stable shipment identifiers** — they do not change event-to-event. The carrier sets them once when the shipment is created. Every event Shippeo sends for that shipment carries the same `loading_site` and `delivery_site` block.

This means:
- Pick **once per test** at OTU creation time from the pools below
- Send the **same** `loading_site` and `delivery_site` on every subsequent event in that test
- `carrierUpdatedLocodePol` and `carrierUpdatedLocodePod` should be consistent across all events for that OTU

The random pick still proves the mapping reads live from the payload — if Logward hardcoded a default locode it would fail. A port correction mid-shipment is rare but testable (see DS-E-04 and the dedicated POL/POD change tests below).

```js
// ─── POOLS ────────────────────────────────────────────────────────────────
// IMPORTANT: country values MUST be ISO 3166-1 alpha-2 codes (2 letters: "CN", "NL", "DE")
// Never send full country names ("China", "Netherlands", "INDIA") — these are invalid
// and should be caught by DS-N-09b / DS-N-09c negative tests.

const POL_LOCODES = [
  { unlocode: 'CNNGB', name: 'Ningbo',     country: 'CN' },
  { unlocode: 'CNSHA', name: 'Shanghai',   country: 'CN' },
  { unlocode: 'CNTAO', name: 'Qingdao',    country: 'CN' },
  { unlocode: 'CNSZX', name: 'Shenzhen',   country: 'CN' },
  { unlocode: 'HKHKG', name: 'Hong Kong',  country: 'HK' },
  { unlocode: 'KRPUS', name: 'Busan',      country: 'KR' },
  { unlocode: 'SGSIN', name: 'Singapore',  country: 'SG' },
  { unlocode: 'JPYOK', name: 'Yokohama',   country: 'JP' },
  { unlocode: 'TWTPE', name: 'Taipei',     country: 'TW' },
  { unlocode: 'MYPKG', name: 'Port Klang', country: 'MY' },
];

const POD_LOCODES = [
  { unlocode: 'NLRTM', name: 'Rotterdam',   country: 'NL' },
  { unlocode: 'DEHAM', name: 'Hamburg',     country: 'DE' },
  { unlocode: 'BEANR', name: 'Antwerp',     country: 'BE' },
  { unlocode: 'GBFXT', name: 'Felixstowe',  country: 'GB' },
  { unlocode: 'FRLEH', name: 'Le Havre',    country: 'FR' },
  { unlocode: 'ESBCN', name: 'Barcelona',   country: 'ES' },
  { unlocode: 'ITGOA', name: 'Genoa',       country: 'IT' },
  { unlocode: 'AEJEA', name: 'Jebel Ali',   country: 'AE' },
  { unlocode: 'USLAX', name: 'Los Angeles', country: 'US' },
  { unlocode: 'USNYC', name: 'New York',    country: 'US' },
];

const VESSELS = [
  { imo: '9864239', name: 'ZEUS LUMOS'      },
  { imo: '9999001', name: 'EVER GIVEN'      },
  { imo: '9999002', name: 'MAERSK IOWA'     },
  { imo: '9999003', name: 'COSCO STAR'      },
  { imo: '9999004', name: 'EVERGREEN TITAN' },
  { imo: '9999005', name: 'MSC OSCAR'       },
  { imo: '9999006', name: 'CMA CGM MARCO'   },
  { imo: '9999007', name: 'HAPAG EXPRESS'   },
];

const TIMEZONES = [
  'Asia/Shanghai',
  'Asia/Singapore',
  'Asia/Kolkata',
  'Europe/Amsterdam',
  'Europe/London',
  'America/New_York',
  'America/Los_Angeles',
  'UTC',
];

// Realistic logistics timeline — dates generated relative to today at runtime
// Past dates = already happened  |  Future dates = expected/predicted
const STAGE_DATES = {
  // Pre-Carriage (past)
  gateOutEmpty:                   stageDate(-20, 8),
  estimatedGateOutEmpty:          stageDate(-22, 8),
  departureFromOrigin:            stageDate(-18, 14),
  estimatedDepartureFromOrigin:   stageDate(-20, 14),
  loadedAtOrigin:                 stageDate(-17, 10),
  estimatedLoadedAtOrigin:        stageDate(-19, 10),

  // POL (past)
  gateInPol:                      stageDate(-16, 6),
  estimatedGateInPol:             stageDate(-18, 6),
  loadPol:                        stageDate(-15, 22),
  estimatedLoadPol:               stageDate(-17, 22),
  departurePol:                   stageDate(-14, 4),
  estimatedDeparturePol:          stageDate(-16, 4),
  predictedDeparturePol:          stageDate(-15, 4),

  // POD (future)
  estimatedArrivalPod:            stageDate(10, 8),
  predictedArrivalPod:            stageDate(11, 8),
  actualArrivalPod:               stageDate(12, 6),
  // UTC offset variants of actualArrivalPod — same logical UTC time, different offset notation
  actualArrivalPodPlus0200:       stageDate(12, 8),   // +02:00 → same UTC as actualArrivalPod
  actualArrivalPodPlus0530:       stageDate(12, 11, 30), // +05:30 → same UTC
  actualArrivalPodMinus0500:      stageDate(12, 1),   // -05:00 → same UTC
  estimatedDischargePod:          stageDate(13, 8),
  predictedDischargePod:          stageDate(14, 8),
  actualDischargePod:             stageDate(13, 10),
  estimatedGateOutPod:            stageDate(14, 10),
  predictedGateOutPod:            stageDate(15, 10),
  actualGateOutPod:               stageDate(14, 14),
  estimatedEmptyReturn:           stageDate(20, 9),
  actualEmptyReturn:              stageDate(21, 9),

  // Delivery (future)
  estimatedArrivalDestination:    stageDate(16, 8),
  actualArrivalDestination:       stageDate(17, 16),
};

function stageDate(daysFromToday, hours = 8, minutes = 0) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  d.setUTCHours(hours, minutes, 0, 0);
  return d.toISOString(); // "2026-06-12T08:00:00.000Z"
}

function toStoredUtc(isoDate) {
  return new Date(isoDate)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19); // "2026-06-12 08:00:00"
}

// Pick a random item from a pool, optionally excluding one entry by unlocode
function pick(pool, excludeUnlocode = null) {
  const filtered = excludeUnlocode
    ? pool.filter(p => p.unlocode !== excludeUnlocode)
    : pool;
  return filtered[Math.floor(Math.random() * filtered.length)];
}
```

### Per-test setup pattern

```js
// At the start of each test — pick ONCE, use for ALL events in that test
const pol     = pick(POL_LOCODES);   // fixed loading port for this OTU
const pod     = pick(POD_LOCODES);   // fixed discharge port for this OTU
const vessel  = pick(VESSELS);
const timezone = pick(TIMEZONES);

// Every event in the test sends:
//   loading_site:  { unlocode: pol.unlocode,  name: pol.name,  country: pol.country  }
//   delivery_site: { unlocode: pod.unlocode,  name: pod.name,  country: pod.country  }
//   event_site.timezone: timezone
//   resources[milestoneVessel]: vessel.imo + vessel.name
```

---

## How Every Test Is Structured

Shippeo sends **one complete webhook payload**. Logward processes all fields in one pass. Every test therefore:

1. Picks random `pol`, `pod`, `vessel`, `timezone` from the pools above
2. Sends **one** webhook
3. Fetches the OTU
4. Asserts **every field** written from that payload — both the stage-specific target field AND the always-on fields (`carrierUpdatedLocodePol`, `carrierUpdatedLocodePod`, `leg1VesselImoNumber`, `leg1VesselName`, `datetime_timezone`)
5. Asserts key fields from other stages are **null** — proves no cross-contamination

```
[pol]      = pick(POL_LOCODES)      → loading_site.unlocode  → carrierUpdatedLocodePol
[pod]      = pick(POD_LOCODES)      → delivery_site.unlocode → carrierUpdatedLocodePod
[vessel]   = pick(VESSELS)          → milestoneVessel IMO + LABEL → leg1VesselImoNumber + leg1VesselName
[timezone] = pick(TIMEZONES)        → event_site.timezone    → datetime_timezone
```

---

## POSITIVE TESTS — Pre-Carriage

### DS-PC-P-01 — `container_gate_out_empty` actual → `actualGateOutEmptyDepot` + `depotPreLocation` + `depotPreCountry` + `motGateOutEmpty`

**Mappings:** Rows 5, 7, 8, 12  
**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`, `timezone = pick(TIMEZONES)`  
**Payload changes:**
```json
"situation": {
  "event": "container_gate_out_empty",
  "date": STAGE_DATES.gateOutEmpty,
  "type": "actual",
  "transport_mode": "road"
},
"loading_site":  { "unlocode": "[pol.unlocode]" },
"delivery_site": { "unlocode": "[pod.unlocode]" },
"event_site": {
  "city": "Ningbo",
  "country": "CN",
  "timezone": "[timezone]",
  "place_type": "origin_inland_location"
},
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "[vessel.imo]"  },
  { "qualifier": "LABEL", "value": "[vessel.name]" }
]}]
```
**Assert:**
```
actualGateOutEmptyDepot = toStoredUtc(STAGE_DATES.gateOutEmpty)  ✅  (situation.date)
depotPreLocation        = "Ningbo"                ✅  (event_site.city)
depotPreCountry         = "CN"                    ✅  (event_site.country)
motGateOutEmpty         = "road"                  ✅  (situation.transport_mode)
carrierUpdatedLocodePol = [pol.unlocode]          ✅  (loading_site.unlocode — always-on)
carrierUpdatedLocodePod = [pod.unlocode]          ✅  (delivery_site.unlocode — always-on)
leg1VesselImoNumber     = [vessel.imo]            ✅  (milestoneVessel IMO — always-on)
leg1VesselName          = [vessel.name]           ✅  (milestoneVessel LABEL — always-on)
datetime_timezone       = [timezone]              ✅  (event_site.timezone — always-on)

actualDepartureFromOrigin = null  ✅  (wrong event — container_departed required)
actualLoadedAtOrigin      = null  ✅  (wrong event — container_loaded required)
actualGateInPol           = null  ✅  (wrong place_type — loading required)
actualArrivalPod          = null  ✅  (wrong place_type — discharge required)
```

---

### DS-PC-P-02 — `container_departed` actual → `actualDepartureFromOrigin` + `pickUpOriginLocation` + `pickUpOriginCountry` + `motPickUpOrigin`

**Mappings:** Rows 4, 13, 14, 15  
**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`, `timezone = pick(TIMEZONES)`  
**Payload changes:**
```json
"situation": {
  "event": "container_departed",
  "date": STAGE_DATES.departureFromOrigin,
  "type": "actual",
  "transport_mode": "rail"
},
"loading_site":  { "unlocode": "[pol.unlocode]" },
"delivery_site": { "unlocode": "[pod.unlocode]" },
"event_site": {
  "city": "Shanghai",
  "country": "CN",
  "timezone": "[timezone]",
  "place_type": "origin_inland_location"
},
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "[vessel.imo]"  },
  { "qualifier": "LABEL", "value": "[vessel.name]" }
]}]
```
**Assert:**
```
actualDepartureFromOrigin = toStoredUtc(STAGE_DATES.departureFromOrigin)  ✅
pickUpOriginLocation      = "Shanghai"              ✅
pickUpOriginCountry       = "CN"                    ✅
motPickUpOrigin           = "rail"                  ✅
carrierUpdatedLocodePol   = [pol.unlocode]          ✅
carrierUpdatedLocodePod   = [pod.unlocode]          ✅
leg1VesselImoNumber       = [vessel.imo]            ✅
leg1VesselName            = [vessel.name]           ✅
datetime_timezone         = [timezone]              ✅

actualGateOutEmptyDepot   = null  ✅  (wrong event)
actualDeparturePol        = null  ✅  (wrong place_type — loading required)
```

---

### DS-PC-P-03 — `container_loaded` actual → `actualLoadedAtOrigin`

**Mapping:** Row 6  
**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`, `timezone = pick(TIMEZONES)`  
**Payload changes:**
```json
"situation": {
  "event": "container_loaded",
  "date": STAGE_DATES.loadedAtOrigin,
  "type": "actual",
  "transport_mode": "ocean"
},
"loading_site":  { "unlocode": "[pol.unlocode]" },
"delivery_site": { "unlocode": "[pod.unlocode]" },
"event_site": { "timezone": "[timezone]", "place_type": "origin_inland_location" },
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "[vessel.imo]"  },
  { "qualifier": "LABEL", "value": "[vessel.name]" }
]}]
```
**Assert:**
```
actualLoadedAtOrigin    = toStoredUtc(STAGE_DATES.loadedAtOrigin)  ✅
carrierUpdatedLocodePol = [pol.unlocode]          ✅
carrierUpdatedLocodePod = [pod.unlocode]          ✅
leg1VesselImoNumber     = [vessel.imo]            ✅
leg1VesselName          = [vessel.name]           ✅
datetime_timezone       = [timezone]              ✅

actualLoadPol           = null  ✅  (wrong place_type)
```

---

### DS-PC-P-04 — `container_gate_out_empty` estimated external → `estimatedGateOutEmptyDepot`

**Mapping:** Row 10  
**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`, `timezone = pick(TIMEZONES)`  
**Payload changes:**
```json
"situation": { "event": "container_gate_out_empty", "date": STAGE_DATES.estimatedGateOutEmpty, "type": "estimated" },
"situation_justification": { "data_source": "external" },
"loading_site":  { "unlocode": "[pol.unlocode]" },
"delivery_site": { "unlocode": "[pod.unlocode]" },
"event_site": { "timezone": "[timezone]", "place_type": "origin_inland_location" },
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "[vessel.imo]"  },
  { "qualifier": "LABEL", "value": "[vessel.name]" }
]}]
```
**Assert:**
```
estimatedGateOutEmptyDepot = toStoredUtc(STAGE_DATES.estimatedGateOutEmpty)  ✅
actualGateOutEmptyDepot    = null                    ✅  (separate field)
carrierUpdatedLocodePol    = [pol.unlocode]          ✅
carrierUpdatedLocodePod    = [pod.unlocode]          ✅
leg1VesselImoNumber        = [vessel.imo]            ✅
leg1VesselName             = [vessel.name]           ✅
datetime_timezone          = [timezone]              ✅
```

---

### DS-PC-P-05 — `container_departed` estimated external → `estimatedDepartureFromOrigin`

**Mapping:** Row 9  
**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`, `timezone = pick(TIMEZONES)`  
**Payload changes:**
```json
"situation": { "event": "container_departed", "date": STAGE_DATES.estimatedDepartureFromOrigin, "type": "estimated" },
"situation_justification": { "data_source": "external" },
"loading_site":  { "unlocode": "[pol.unlocode]" },
"delivery_site": { "unlocode": "[pod.unlocode]" },
"event_site": { "timezone": "[timezone]", "place_type": "origin_inland_location" },
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "[vessel.imo]"  },
  { "qualifier": "LABEL", "value": "[vessel.name]" }
]}]
```
**Assert:**
```
estimatedDepartureFromOrigin = toStoredUtc(STAGE_DATES.estimatedDepartureFromOrigin)  ✅
actualDepartureFromOrigin    = null                    ✅
carrierUpdatedLocodePol      = [pol.unlocode]          ✅
carrierUpdatedLocodePod      = [pod.unlocode]          ✅
leg1VesselImoNumber          = [vessel.imo]            ✅
leg1VesselName               = [vessel.name]           ✅
datetime_timezone            = [timezone]              ✅
```

---

### DS-PC-P-06 — `container_loaded` estimated external → `estimatedLoadedAtOrigin`

**Mapping:** Row 11  
**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`, `timezone = pick(TIMEZONES)`  
**Payload changes:**
```json
"situation": { "event": "container_loaded", "date": STAGE_DATES.estimatedLoadedAtOrigin, "type": "estimated" },
"situation_justification": { "data_source": "external" },
"loading_site":  { "unlocode": "[pol.unlocode]" },
"delivery_site": { "unlocode": "[pod.unlocode]" },
"event_site": { "timezone": "[timezone]", "place_type": "origin_inland_location" },
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "[vessel.imo]"  },
  { "qualifier": "LABEL", "value": "[vessel.name]" }
]}]
```
**Assert:**
```
estimatedLoadedAtOrigin = toStoredUtc(STAGE_DATES.estimatedLoadedAtOrigin)  ✅
actualLoadedAtOrigin    = null                    ✅
carrierUpdatedLocodePol = [pol.unlocode]          ✅
carrierUpdatedLocodePod = [pod.unlocode]          ✅
leg1VesselImoNumber     = [vessel.imo]            ✅
leg1VesselName          = [vessel.name]           ✅
datetime_timezone       = [timezone]              ✅
```

---

## POSITIVE TESTS — POL

### DS-POL-P-01 — `container_gate_out_full` actual → `actualGateInPol`

**Mapping:** Row 17  
**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`, `timezone = pick(TIMEZONES)`  
**Payload changes:**
```json
"situation": { "event": "container_gate_out_full", "date": STAGE_DATES.estimatedDepartureFromOrigin, "type": "actual" },
"loading_site":  { "unlocode": "[pol.unlocode]" },
"delivery_site": { "unlocode": "[pod.unlocode]" },
"event_site": { "timezone": "[timezone]", "place_type": "loading" },
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "[vessel.imo]"  },
  { "qualifier": "LABEL", "value": "[vessel.name]" }
]}]
```
**Assert:**
```
actualGateInPol         = toStoredUtc(STAGE_DATES.estimatedDepartureFromOrigin)  ✅
carrierUpdatedLocodePol = [pol.unlocode]          ✅
carrierUpdatedLocodePod = [pod.unlocode]          ✅
leg1VesselImoNumber     = [vessel.imo]            ✅
leg1VesselName          = [vessel.name]           ✅
datetime_timezone       = [timezone]              ✅

actualGateOutEmptyDepot = null  ✅  (wrong place_type — origin required)
actualArrivalPod        = null  ✅  (wrong place_type — discharge required)
```

---

### DS-POL-P-02 — `container_loaded` actual → `actualLoadPol` + `leg1VesselImoNumber` + `leg1VesselName` + `leg1Mot`

**Mappings:** Rows 18, 23, 24, 25  
**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`, `timezone = pick(TIMEZONES)`  
**Payload changes:**
```json
"situation": {
  "event": "container_loaded",
  "date": STAGE_DATES.loadPol,
  "type": "actual",
  "transport_mode": "ocean"
},
"loading_site":  { "unlocode": "[pol.unlocode]" },
"delivery_site": { "unlocode": "[pod.unlocode]" },
"event_site": { "timezone": "[timezone]", "place_type": "loading" },
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "[vessel.imo]"  },
  { "qualifier": "LABEL", "value": "[vessel.name]" }
]}]
```
**Assert:**
```
actualLoadPol           = toStoredUtc(STAGE_DATES.loadPol)  ✅
leg1Mot                 = "ocean"                 ✅
leg1VesselImoNumber     = [vessel.imo]            ✅
leg1VesselName          = [vessel.name]           ✅
carrierUpdatedLocodePol = [pol.unlocode]          ✅
carrierUpdatedLocodePod = [pod.unlocode]          ✅
datetime_timezone       = [timezone]              ✅

actualLoadedAtOrigin    = null  ✅  (wrong place_type — origin required)
actualDischargePod      = null  ✅  (wrong place_type — discharge required)
```

---

### DS-POL-P-03 — `container_departed` actual → `actualDeparturePol`

**Mapping:** Row 16  
**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`, `timezone = pick(TIMEZONES)`  
**Payload changes:**
```json
"situation": { "event": "container_departed", "date": STAGE_DATES.departurePol, "type": "actual" },
"loading_site":  { "unlocode": "[pol.unlocode]" },
"delivery_site": { "unlocode": "[pod.unlocode]" },
"event_site": { "timezone": "[timezone]", "place_type": "loading" },
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "[vessel.imo]"  },
  { "qualifier": "LABEL", "value": "[vessel.name]" }
]}]
```
**Assert:**
```
actualDeparturePol      = toStoredUtc(STAGE_DATES.departurePol)  ✅
carrierUpdatedLocodePol = [pol.unlocode]          ✅
carrierUpdatedLocodePod = [pod.unlocode]          ✅
leg1VesselImoNumber     = [vessel.imo]            ✅
leg1VesselName          = [vessel.name]           ✅
datetime_timezone       = [timezone]              ✅

actualDepartureFromOrigin = null  ✅  (wrong place_type — origin required)
```

---

### DS-POL-P-04 — `container_gate_out_full` estimated external → `estimatedGateInPol`

**Mapping:** Row 21  
**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`, `timezone = pick(TIMEZONES)`  
**Payload changes:**
```json
"situation": { "event": "container_gate_out_full", "date": STAGE_DATES.estimatedGateInPol, "type": "estimated" },
"situation_justification": { "data_source": "external" },
"loading_site":  { "unlocode": "[pol.unlocode]" },
"delivery_site": { "unlocode": "[pod.unlocode]" },
"event_site": { "timezone": "[timezone]", "place_type": "loading" },
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "[vessel.imo]"  },
  { "qualifier": "LABEL", "value": "[vessel.name]" }
]}]
```
**Assert:**
```
estimatedGateInPol      = toStoredUtc(STAGE_DATES.estimatedGateInPol)  ✅
actualGateInPol         = null                    ✅
carrierUpdatedLocodePol = [pol.unlocode]          ✅
carrierUpdatedLocodePod = [pod.unlocode]          ✅
leg1VesselImoNumber     = [vessel.imo]            ✅
leg1VesselName          = [vessel.name]           ✅
datetime_timezone       = [timezone]              ✅
```

---

### DS-POL-P-05 — `container_loaded` estimated external → `estimatedLoadPol`

**Mapping:** Row 22  
**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`, `timezone = pick(TIMEZONES)`  
**Payload changes:**
```json
"situation": { "event": "container_loaded", "date": STAGE_DATES.estimatedLoadPol, "type": "estimated" },
"situation_justification": { "data_source": "external" },
"loading_site":  { "unlocode": "[pol.unlocode]" },
"delivery_site": { "unlocode": "[pod.unlocode]" },
"event_site": { "timezone": "[timezone]", "place_type": "loading" },
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "[vessel.imo]"  },
  { "qualifier": "LABEL", "value": "[vessel.name]" }
]}]
```
**Assert:**
```
estimatedLoadPol        = toStoredUtc(STAGE_DATES.estimatedLoadPol)  ✅
actualLoadPol           = null                    ✅
carrierUpdatedLocodePol = [pol.unlocode]          ✅
carrierUpdatedLocodePod = [pod.unlocode]          ✅
leg1VesselImoNumber     = [vessel.imo]            ✅
leg1VesselName          = [vessel.name]           ✅
datetime_timezone       = [timezone]              ✅
```

---

### DS-POL-P-06 — `container_departed` estimated external → `estimatedDeparturePol`

**Mapping:** Row 20  
**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`, `timezone = pick(TIMEZONES)`  
**Payload changes:**
```json
"situation": { "event": "container_departed", "date": STAGE_DATES.estimatedDeparturePol, "type": "estimated" },
"situation_justification": { "data_source": "external" },
"loading_site":  { "unlocode": "[pol.unlocode]" },
"delivery_site": { "unlocode": "[pod.unlocode]" },
"event_site": { "timezone": "[timezone]", "place_type": "loading" },
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "[vessel.imo]"  },
  { "qualifier": "LABEL", "value": "[vessel.name]" }
]}]
```
**Assert:**
```
estimatedDeparturePol   = toStoredUtc(STAGE_DATES.estimatedDeparturePol)  ✅
actualDeparturePol      = null                    ✅
carrierUpdatedLocodePol = [pol.unlocode]          ✅
carrierUpdatedLocodePod = [pod.unlocode]          ✅
leg1VesselImoNumber     = [vessel.imo]            ✅
leg1VesselName          = [vessel.name]           ✅
datetime_timezone       = [timezone]              ✅
```

---

### DS-POL-P-07 — `container_departed` estimated shippeo → `predictedDeparturePol`

**Mapping:** Row 26  
**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`, `timezone = pick(TIMEZONES)`  
**Payload changes:**
```json
"situation": { "event": "container_departed", "date": STAGE_DATES.predictedDeparturePol, "type": "estimated" },
"situation_justification": { "data_source": "shippeo" },
"loading_site":  { "unlocode": "[pol.unlocode]" },
"delivery_site": { "unlocode": "[pod.unlocode]" },
"event_site": { "timezone": "[timezone]", "place_type": "loading" },
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "[vessel.imo]"  },
  { "qualifier": "LABEL", "value": "[vessel.name]" }
]}]
```
**Assert:**
```
predictedDeparturePol   = toStoredUtc(STAGE_DATES.predictedDeparturePol)  ✅
estimatedDeparturePol   = null                    ✅
carrierUpdatedLocodePol = [pol.unlocode]          ✅
carrierUpdatedLocodePod = [pod.unlocode]          ✅
leg1VesselImoNumber     = [vessel.imo]            ✅
leg1VesselName          = [vessel.name]           ✅
datetime_timezone       = [timezone]              ✅
```

---

## POSITIVE TESTS — POD

### DS-POD-P-01 — `container_arrived` actual → `actualArrivalPod`

**Mapping:** Row 42  
**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`, `timezone = pick(TIMEZONES)`  
**Payload changes:**
```json
"situation": { "event": "container_arrived", "date": STAGE_DATES.actualArrivalPod, "type": "actual" },
"loading_site":  { "unlocode": "[pol.unlocode]" },
"delivery_site": { "unlocode": "[pod.unlocode]" },
"event_site": { "timezone": "[timezone]", "place_type": "discharge" },
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "[vessel.imo]"  },
  { "qualifier": "LABEL", "value": "[vessel.name]" }
]}]
```
**Assert:**
```
actualArrivalPod        = toStoredUtc(STAGE_DATES.actualArrivalPod)  ✅
carrierUpdatedLocodePol = [pol.unlocode]          ✅
carrierUpdatedLocodePod = [pod.unlocode]          ✅
leg1VesselImoNumber     = [vessel.imo]            ✅
leg1VesselName          = [vessel.name]           ✅
datetime_timezone       = [timezone]              ✅

actualArrivalDestination = null  ✅  (wrong place_type — destination required)
actualGateInPol          = null  ✅  (wrong place_type — loading required)
```

---

### DS-POD-P-02 — `container_unloaded` actual → `actualDischargePod`

**Mapping:** Row 43  
**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`, `timezone = pick(TIMEZONES)`  
**Payload changes:**
```json
"situation": { "event": "container_unloaded", "date": STAGE_DATES.actualDischargePod, "type": "actual" },
"loading_site":  { "unlocode": "[pol.unlocode]" },
"delivery_site": { "unlocode": "[pod.unlocode]" },
"event_site": { "timezone": "[timezone]", "place_type": "discharge" },
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "[vessel.imo]"  },
  { "qualifier": "LABEL", "value": "[vessel.name]" }
]}]
```
**Assert:**
```
actualDischargePod      = toStoredUtc(STAGE_DATES.actualDischargePod)  ✅
carrierUpdatedLocodePol = [pol.unlocode]          ✅
carrierUpdatedLocodePod = [pod.unlocode]          ✅
leg1VesselImoNumber     = [vessel.imo]            ✅
leg1VesselName          = [vessel.name]           ✅
datetime_timezone       = [timezone]              ✅
```

---

### DS-POD-P-03 — `container_gate_out_full` actual → `actualGateOutPod`

**Mapping:** Row 45  
**Setup:** `pol = pick(POL_LOCADES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`, `timezone = pick(TIMEZONES)`  
**Payload changes:**
```json
"situation": { "event": "container_gate_out_full", "date": STAGE_DATES.actualGateOutPod, "type": "actual" },
"loading_site":  { "unlocode": "[pol.unlocode]" },
"delivery_site": { "unlocode": "[pod.unlocode]" },
"event_site": { "timezone": "[timezone]", "place_type": "discharge" },
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "[vessel.imo]"  },
  { "qualifier": "LABEL", "value": "[vessel.name]" }
]}]
```
**Assert:**
```
actualGateOutPod        = toStoredUtc(STAGE_DATES.actualGateOutPod)  ✅
carrierUpdatedLocodePol = [pol.unlocode]          ✅
carrierUpdatedLocodePod = [pod.unlocode]          ✅
leg1VesselImoNumber     = [vessel.imo]            ✅
leg1VesselName          = [vessel.name]           ✅
datetime_timezone       = [timezone]              ✅
```

---

### DS-POD-P-04 — `container_gate_in_empty` actual → `actualEmptyReturn` + `motEmptyReturn`

**Mappings:** Rows 44, 51  
**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`, `timezone = pick(TIMEZONES)`  
**Payload changes:**
```json
"situation": { "event": "container_gate_in_empty", "date": STAGE_DATES.actualEmptyReturn, "type": "actual", "transport_mode": "road" },
"loading_site":  { "unlocode": "[pol.unlocode]" },
"delivery_site": { "unlocode": "[pod.unlocode]" },
"event_site": { "timezone": "[timezone]", "place_type": "discharge" },
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "[vessel.imo]"  },
  { "qualifier": "LABEL", "value": "[vessel.name]" }
]}]
```
**Assert:**
```
actualEmptyReturn       = toStoredUtc(STAGE_DATES.actualEmptyReturn)  ✅
motEmptyReturn          = "road"                  ✅
carrierUpdatedLocodePol = [pol.unlocode]          ✅
carrierUpdatedLocodePod = [pod.unlocode]          ✅
leg1VesselImoNumber     = [vessel.imo]            ✅
leg1VesselName          = [vessel.name]           ✅
datetime_timezone       = [timezone]              ✅
```

---

### DS-POD-P-05 — `eta_event` estimated external → `estimatedArrivalPod`

**Mapping:** Row 47  
**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`, `timezone = pick(TIMEZONES)`  
**Payload changes:**
```json
"situation": { "event": "eta_event", "date": STAGE_DATES.estimatedArrivalPod, "type": "estimated" },
"situation_justification": { "data_source": "external" },
"loading_site":  { "unlocode": "[pol.unlocode]" },
"delivery_site": { "unlocode": "[pod.unlocode]" },
"event_site": { "timezone": "[timezone]", "place_type": "discharge" },
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "[vessel.imo]"  },
  { "qualifier": "LABEL", "value": "[vessel.name]" }
]}]
```
**Assert:**
```
estimatedArrivalPod     = toStoredUtc(STAGE_DATES.estimatedArrivalPod)  ✅
actualArrivalPod        = null                    ✅
predictedArrivalPod     = null                    ✅
carrierUpdatedLocodePol = [pol.unlocode]          ✅
carrierUpdatedLocodePod = [pod.unlocode]          ✅
leg1VesselImoNumber     = [vessel.imo]            ✅
leg1VesselName          = [vessel.name]           ✅
datetime_timezone       = [timezone]              ✅
```

---

### DS-POD-P-06 — `eta_event` estimated shippeo → `predictedArrivalPod`

**Mapping:** Row 53  
**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`, `timezone = pick(TIMEZONES)`  
**Payload changes:**
```json
"situation": { "event": "eta_event", "date": STAGE_DATES.predictedArrivalPod, "type": "estimated" },
"situation_justification": { "data_source": "shippeo" },
"loading_site":  { "unlocode": "[pol.unlocode]" },
"delivery_site": { "unlocode": "[pod.unlocode]" },
"event_site": { "timezone": "[timezone]", "place_type": "discharge" },
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "[vessel.imo]"  },
  { "qualifier": "LABEL", "value": "[vessel.name]" }
]}]
```
**Assert:**
```
predictedArrivalPod     = toStoredUtc(STAGE_DATES.predictedArrivalPod)  ✅
estimatedArrivalPod     = null                    ✅
carrierUpdatedLocodePol = [pol.unlocode]          ✅
carrierUpdatedLocodePod = [pod.unlocode]          ✅
leg1VesselImoNumber     = [vessel.imo]            ✅
leg1VesselName          = [vessel.name]           ✅
datetime_timezone       = [timezone]              ✅
```

---

### DS-POD-P-07 — `container_unloaded` estimated external → `estimatedDischargePod`

**Mapping:** Row 48  
**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`, `timezone = pick(TIMEZONES)`  
**Payload changes:**
```json
"situation": { "event": "container_unloaded", "date": STAGE_DATES.estimatedDischargePod, "type": "estimated" },
"situation_justification": { "data_source": "external" },
"loading_site":  { "unlocode": "[pol.unlocode]" },
"delivery_site": { "unlocode": "[pod.unlocode]" },
"event_site": { "timezone": "[timezone]", "place_type": "discharge" },
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "[vessel.imo]"  },
  { "qualifier": "LABEL", "value": "[vessel.name]" }
]}]
```
**Assert:**
```
estimatedDischargePod   = toStoredUtc(STAGE_DATES.estimatedDischargePod)  ✅
actualDischargePod      = null                    ✅
predictedDischargePod   = null                    ✅
carrierUpdatedLocodePol = [pol.unlocode]          ✅
carrierUpdatedLocodePod = [pod.unlocode]          ✅
leg1VesselImoNumber     = [vessel.imo]            ✅
leg1VesselName          = [vessel.name]           ✅
datetime_timezone       = [timezone]              ✅
```

---

### DS-POD-P-08 — `container_unloaded` estimated shippeo → `predictedDischargePod`

**Mapping:** Row 54  
**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`, `timezone = pick(TIMEZONES)`  
**Payload changes:**
```json
"situation": { "event": "container_unloaded", "date": STAGE_DATES.predictedDischargePod, "type": "estimated" },
"situation_justification": { "data_source": "shippeo" },
"loading_site":  { "unlocode": "[pol.unlocode]" },
"delivery_site": { "unlocode": "[pod.unlocode]" },
"event_site": { "timezone": "[timezone]", "place_type": "discharge" },
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "[vessel.imo]"  },
  { "qualifier": "LABEL", "value": "[vessel.name]" }
]}]
```
**Assert:**
```
predictedDischargePod   = toStoredUtc(STAGE_DATES.predictedDischargePod)  ✅
estimatedDischargePod   = null                    ✅
carrierUpdatedLocodePol = [pol.unlocode]          ✅
carrierUpdatedLocodePod = [pod.unlocode]          ✅
leg1VesselImoNumber     = [vessel.imo]            ✅
leg1VesselName          = [vessel.name]           ✅
datetime_timezone       = [timezone]              ✅
```

---

### DS-POD-P-09 — `container_gate_out_full` estimated external → `estimatedGateOutPod` + `motGateOutPod`

**Mappings:** Rows 50, 52  
**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`, `timezone = pick(TIMEZONES)`  
**Payload changes:**
```json
"situation": { "event": "container_gate_out_full", "date": STAGE_DATES.estimatedGateOutPod, "type": "estimated", "transport_mode": "ocean" },
"situation_justification": { "data_source": "external" },
"loading_site":  { "unlocode": "[pol.unlocode]" },
"delivery_site": { "unlocode": "[pod.unlocode]" },
"event_site": { "timezone": "[timezone]", "place_type": "discharge" },
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "[vessel.imo]"  },
  { "qualifier": "LABEL", "value": "[vessel.name]" }
]}]
```
**Assert:**
```
estimatedGateOutPod     = toStoredUtc(STAGE_DATES.estimatedGateOutPod)  ✅
motGateOutPod           = "ocean"                 ✅
carrierUpdatedLocodePol = [pol.unlocode]          ✅
carrierUpdatedLocodePod = [pod.unlocode]          ✅
leg1VesselImoNumber     = [vessel.imo]            ✅
leg1VesselName          = [vessel.name]           ✅
datetime_timezone       = [timezone]              ✅
```

---

### DS-POD-P-10 — `container_gate_out_full` estimated shippeo → `predictedGateOutPod`

**Mapping:** Row 55  
**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`, `timezone = pick(TIMEZONES)`  
**Payload changes:**
```json
"situation": { "event": "container_gate_out_full", "date": STAGE_DATES.predictedGateOutPod, "type": "estimated" },
"situation_justification": { "data_source": "shippeo" },
"loading_site":  { "unlocode": "[pol.unlocode]" },
"delivery_site": { "unlocode": "[pod.unlocode]" },
"event_site": { "timezone": "[timezone]", "place_type": "discharge" },
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "[vessel.imo]"  },
  { "qualifier": "LABEL", "value": "[vessel.name]" }
]}]
```
**Assert:**
```
predictedGateOutPod     = toStoredUtc(STAGE_DATES.predictedGateOutPod)  ✅
estimatedGateOutPod     = null                    ✅
carrierUpdatedLocodePol = [pol.unlocode]          ✅
carrierUpdatedLocodePod = [pod.unlocode]          ✅
leg1VesselImoNumber     = [vessel.imo]            ✅
leg1VesselName          = [vessel.name]           ✅
datetime_timezone       = [timezone]              ✅
```

---

### DS-POD-P-11 — `container_gate_in_empty` estimated external → `estimatedEmptyReturn`

**Mapping:** Row 49  
**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`, `timezone = pick(TIMEZONES)`  
**Payload changes:**
```json
"situation": { "event": "container_gate_in_empty", "date": STAGE_DATES.estimatedEmptyReturn, "type": "estimated" },
"situation_justification": { "data_source": "external" },
"loading_site":  { "unlocode": "[pol.unlocode]" },
"delivery_site": { "unlocode": "[pod.unlocode]" },
"event_site": { "timezone": "[timezone]", "place_type": "discharge" },
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "[vessel.imo]"  },
  { "qualifier": "LABEL", "value": "[vessel.name]" }
]}]
```
**Assert:**
```
estimatedEmptyReturn    = toStoredUtc(STAGE_DATES.estimatedEmptyReturn)  ✅
actualEmptyReturn       = null                    ✅
carrierUpdatedLocodePol = [pol.unlocode]          ✅
carrierUpdatedLocodePod = [pod.unlocode]          ✅
leg1VesselImoNumber     = [vessel.imo]            ✅
leg1VesselName          = [vessel.name]           ✅
datetime_timezone       = [timezone]              ✅
```

---

### DS-POD-P-12 — `container_unloaded` actual at discharge → `trackingArrivingVesselImo` + `trackingArrivingVesselVesselName`

**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`, `timezone = pick(TIMEZONES)`  
**Payload changes:**
```json
"situation": { "event": "container_unloaded", "date": STAGE_DATES.actualDischargePod, "type": "actual" },
"loading_site":  { "unlocode": "[pol.unlocode]" },
"delivery_site": { "unlocode": "[pod.unlocode]" },
"event_site": { "timezone": "[timezone]", "place_type": "discharge" },
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "[vessel.imo]"  },
  { "qualifier": "LABEL", "value": "[vessel.name]" }
]}]
```
**Assert:**
```
trackingArrivingVesselImo        = [vessel.imo]            ✅
trackingArrivingVesselVesselName = [vessel.name]           ✅
actualDischargePod               = toStoredUtc(STAGE_DATES.actualDischargePod)  ✅
carrierUpdatedLocodePol          = [pol.unlocode]          ✅
carrierUpdatedLocodePod          = [pod.unlocode]          ✅
datetime_timezone                = [timezone]              ✅
```

---

### DS-POD-P-13 — `container_unloaded` estimated at discharge → `trackingArrivingVesselImo` + `trackingArrivingVesselVesselName`

**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`, `timezone = pick(TIMEZONES)`  
**Payload changes:**
```json
"situation": { "event": "container_unloaded", "date": STAGE_DATES.estimatedDischargePod, "type": "estimated" },
"situation_justification": { "data_source": "external" },
"loading_site":  { "unlocode": "[pol.unlocode]" },
"delivery_site": { "unlocode": "[pod.unlocode]" },
"event_site": { "timezone": "[timezone]", "place_type": "discharge" },
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "[vessel.imo]"  },
  { "qualifier": "LABEL", "value": "[vessel.name]" }
]}]
```
**Assert:**
```
trackingArrivingVesselImo        = [vessel.imo]            ✅
trackingArrivingVesselVesselName = [vessel.name]           ✅
estimatedDischargePod            = toStoredUtc(STAGE_DATES.estimatedDischargePod)  ✅
actualDischargePod               = null                    ✅
carrierUpdatedLocodePol          = [pol.unlocode]          ✅
carrierUpdatedLocodePod          = [pod.unlocode]          ✅
datetime_timezone                = [timezone]              ✅
```

---

### DS-POD-P-14 — `container_arrived` actual at discharge → `trackingArrivingVesselImo` + `trackingArrivingVesselVesselName`

**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`, `timezone = pick(TIMEZONES)`  
**Payload changes:**
```json
"situation": { "event": "container_arrived", "date": STAGE_DATES.actualArrivalPod, "type": "actual" },
"loading_site":  { "unlocode": "[pol.unlocode]" },
"delivery_site": { "unlocode": "[pod.unlocode]" },
"event_site": { "timezone": "[timezone]", "place_type": "discharge" },
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "[vessel.imo]"  },
  { "qualifier": "LABEL", "value": "[vessel.name]" }
]}]
```
**Assert:**
```
trackingArrivingVesselImo        = [vessel.imo]            ✅
trackingArrivingVesselVesselName = [vessel.name]           ✅
actualArrivalPod                 = toStoredUtc(STAGE_DATES.actualArrivalPod)  ✅
carrierUpdatedLocodePol          = [pol.unlocode]          ✅
carrierUpdatedLocodePod          = [pod.unlocode]          ✅
datetime_timezone                = [timezone]              ✅
```

---

### DS-POD-P-15 — `eta_event` estimated at discharge → `trackingArrivingVesselImo` + `trackingArrivingVesselVesselName`

**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`, `timezone = pick(TIMEZONES)`  
**Payload changes:**
```json
"situation": { "event": "eta_event", "date": STAGE_DATES.estimatedArrivalPod, "type": "estimated" },
"situation_justification": { "data_source": "external" },
"loading_site":  { "unlocode": "[pol.unlocode]" },
"delivery_site": { "unlocode": "[pod.unlocode]" },
"event_site": { "timezone": "[timezone]", "place_type": "discharge" },
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "[vessel.imo]"  },
  { "qualifier": "LABEL", "value": "[vessel.name]" }
]}]
```
**Assert:**
```
trackingArrivingVesselImo        = [vessel.imo]            ✅
trackingArrivingVesselVesselName = [vessel.name]           ✅
estimatedArrivalPod              = toStoredUtc(STAGE_DATES.estimatedArrivalPod)  ✅
carrierUpdatedLocodePol          = [pol.unlocode]          ✅
carrierUpdatedLocodePod          = [pod.unlocode]          ✅
datetime_timezone                = [timezone]              ✅
```

---

## POSITIVE TESTS — Delivery

### DS-DEL-P-01 — `container_arrived` actual → `actualArrivalDestination` + `destinationCity` + `destinationCountry`

**Mappings:** Rows 56, 57, 58  
**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`, `timezone = pick(TIMEZONES)`  
**Payload changes:**
```json
"situation": { "event": "container_arrived", "date": STAGE_DATES.actualArrivalDestination, "type": "actual" },
"loading_site":  { "unlocode": "[pol.unlocode]" },
"delivery_site": { "unlocode": "[pod.unlocode]" },
"event_site": {
  "city": "Hamburg",
  "country": "DE",
  "timezone": "[timezone]",
  "place_type": "destination_inland_location"
},
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "[vessel.imo]"  },
  { "qualifier": "LABEL", "value": "[vessel.name]" }
]}]
```
**Assert:**
```
actualArrivalDestination = toStoredUtc(STAGE_DATES.actualArrivalDestination)  ✅
destinationCity          = "Hamburg"               ✅
destinationCountry       = "DE"                    ✅
carrierUpdatedLocodePol  = [pol.unlocode]          ✅
carrierUpdatedLocodePod  = [pod.unlocode]          ✅
leg1VesselImoNumber      = [vessel.imo]            ✅
leg1VesselName           = [vessel.name]           ✅
datetime_timezone        = [timezone]              ✅

actualArrivalPod         = null  ✅  (wrong place_type — discharge required)
```

---

### DS-DEL-P-02 — `container_arrived` estimated external → `estimatedArrivalDestination`

**Mapping:** Row 59  
**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`, `timezone = pick(TIMEZONES)`  
**Payload changes:**
```json
"situation": { "event": "container_arrived", "date": STAGE_DATES.estimatedArrivalDestination, "type": "estimated" },
"situation_justification": { "data_source": "external" },
"loading_site":  { "unlocode": "[pol.unlocode]" },
"delivery_site": { "unlocode": "[pod.unlocode]" },
"event_site": { "city": "Hamburg", "country": "DE", "timezone": "[timezone]", "place_type": "destination_inland_location" },
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "[vessel.imo]"  },
  { "qualifier": "LABEL", "value": "[vessel.name]" }
]}]
```
**Assert:**
```
estimatedArrivalDestination = toStoredUtc(STAGE_DATES.estimatedArrivalDestination)  ✅
actualArrivalDestination    = null                    ✅
carrierUpdatedLocodePol     = [pol.unlocode]          ✅
carrierUpdatedLocodePod     = [pod.unlocode]          ✅
leg1VesselImoNumber         = [vessel.imo]            ✅
leg1VesselName              = [vessel.name]           ✅
datetime_timezone           = [timezone]              ✅
```

---

## NEGATIVE TESTS

### DS-N-01 — `estimated` without `data_source` → no estimated or predicted field written

**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`, `timezone = pick(TIMEZONES)`
```json
"situation": { "event": "container_gate_out_empty", "type": "estimated" },
"situation_justification": { "data_source": null },
"event_site": { "place_type": "origin_inland_location" }
```
**Assert:**
```
estimatedGateOutEmptyDepot = null             ✅
actualGateOutEmptyDepot    = null             ✅
carrierUpdatedLocodePol    = [pol.unlocode]   ✅  (always-on — still written)
carrierUpdatedLocodePod    = [pod.unlocode]   ✅
datetime_timezone          = [timezone]       ✅
```

---

### DS-N-02 — `estimated` with `data_source: "carrier"` → no field written

```json
"situation_justification": { "data_source": "carrier" }
```
**Assert:** `estimatedGateOutEmptyDepot = null` ✅ · always-on fields still written ✅

---

### DS-N-03 — Wrong `place_type` for Pre-Carriage: `container_gate_out_empty` at `loading`

```json
"situation": { "event": "container_gate_out_empty", "type": "actual" },
"event_site": { "place_type": "loading" }
```
**Assert:**
```
actualGateOutEmptyDepot = null    ✅  (origin_inland_location required)
actualGateInPol         = <date>  ✅  (loading event correctly mapped instead)
carrierUpdatedLocodePol = [pol.unlocode]  ✅
carrierUpdatedLocodePod = [pod.unlocode]  ✅
```

---

### DS-N-04 — Wrong `place_type` for POL: `container_loaded` at `origin_inland_location`

```json
"situation": { "event": "container_loaded", "type": "actual" },
"event_site": { "place_type": "origin_inland_location" }
```
**Assert:**
```
actualLoadPol        = null    ✅
actualLoadedAtOrigin = <date>  ✅
```

---

### DS-N-05 — Wrong `place_type` for POD: `container_arrived` at `loading`

```json
"situation": { "event": "container_arrived", "type": "actual" },
"event_site": { "place_type": "loading" }
```
**Assert:**
```
actualArrivalPod = null    ✅
actualGateInPol  = <date>  ✅
```

---

### DS-N-06 — Wrong `place_type` for Delivery: `container_arrived` at `discharge`

```json
"situation": { "event": "container_arrived", "type": "actual" },
"event_site": { "city": "Hamburg", "country": "DE", "place_type": "discharge" }
```
**Assert:**
```
actualArrivalDestination = null    ✅
destinationCity          = null    ✅
actualArrivalPod         = <date>  ✅
```

---

### DS-N-07 — `situation.date: null` → date field not written · always-on fields still written

```json
"situation": { "event": "container_arrived", "date": null, "type": "actual" },
"loading_site":  { "unlocode": "[pol.unlocode]" },
"delivery_site": { "unlocode": "[pod.unlocode]" },
"event_site": { "timezone": "[timezone]", "place_type": "discharge" }
```
**Assert:**
```
actualArrivalPod        = null           ✅
carrierUpdatedLocodePol = [pol.unlocode] ✅  (always-on — still written)
carrierUpdatedLocodePod = [pod.unlocode] ✅
datetime_timezone       = [timezone]     ✅
```

---

### DS-N-08 — `event_site.city: null` → location not written · other fields still written

```json
"situation": { "event": "container_gate_out_empty", "type": "actual" },
"event_site": { "city": null, "country": "CN", "timezone": "[timezone]", "place_type": "origin_inland_location" }
```
**Assert:**
```
depotPreLocation        = null           ✅
depotPreCountry         = "CN"           ✅
actualGateOutEmptyDepot = <date>         ✅
datetime_timezone       = [timezone]     ✅
```

---

### DS-N-09 — `event_site.country: null` → country not written · other fields still written

```json
"event_site": { "city": "Ningbo", "country": null, "place_type": "origin_inland_location" }
```
**Assert:**
```
depotPreCountry  = null      ✅
depotPreLocation = "Ningbo"  ✅
```

---

### DS-N-09b — `event_site.country` sent as full name instead of ISO code → field not written / stored incorrectly

Country must always be a 2-letter ISO code (`"CN"`, `"NL"`, `"DE"`). Sending `"INDIA"` or `"Netherlands"` is invalid data.

```json
"situation": { "event": "container_gate_out_empty", "type": "actual" },
"event_site": {
  "city": "Mumbai",
  "country": "INDIA",
  "place_type": "origin_inland_location"
}
```
**Assert:**
```
depotPreCountry = null   ✅  (full name rejected — not stored)
```
> If the system stores `"INDIA"` instead of rejecting it, this test fails and flags a data quality bug.

---

### DS-N-09c — `delivery_site.country` sent as full name → `carrierUpdatedLocodePod` unaffected but country not written

`carrierUpdatedLocodePod` reads from `delivery_site.unlocode`, not country — so the locode is still written. The test verifies the bad country value does not pollute any country field.

```json
"delivery_site": { "unlocode": "[pod.unlocode]", "name": "Rotterdam", "country": "Netherlands" }
```
**Assert:**
```
carrierUpdatedLocodePod = [pod.unlocode]  ✅  (unlocode unaffected)
```
> If any country field gets `"Netherlands"` stored, this test flags it.

---

### DS-N-10 — `loading_site.unlocode: null` → `carrierUpdatedLocodePol` not written

```json
"loading_site": { "unlocode": null }
```
**Assert:** `carrierUpdatedLocodePol = null` ✅

---

### DS-N-11 — `delivery_site.unlocode: null` → `carrierUpdatedLocodePod` not written

```json
"delivery_site": { "unlocode": null }
```
**Assert:** `carrierUpdatedLocodePod = null` ✅

---

### DS-N-12 — `situation.transport_mode: null` → mot field not written

```json
"situation": { "event": "container_gate_out_empty", "type": "actual", "transport_mode": null }
```
**Assert:** `motGateOutEmpty = null` ✅

---

### DS-N-13 — Unknown `situation.event` → no stage field written · always-on fields still written

```json
"situation": { "event": "container_inspected", "type": "actual" },
"loading_site":  { "unlocode": "[pol.unlocode]" },
"delivery_site": { "unlocode": "[pod.unlocode]" },
"event_site": { "timezone": "[timezone]" }
```
**HTTP:** `200` (silently ignored)  
**Assert:**
```
carrierUpdatedLocodePol = [pol.unlocode]  ✅  (always-on — still written)
carrierUpdatedLocodePod = [pod.unlocode]  ✅
datetime_timezone       = [timezone]      ✅
actualGateOutEmptyDepot = null            ✅
actualArrivalPod        = null            ✅
```

---

### DS-N-14 — Expired webhook token → HTTP 401

**Assert HTTP:** `401` · OTU unchanged ✅

---

### DS-N-15 — Tampered webhook token → HTTP 403

**Assert HTTP:** `403`

---

### DS-N-16 — Wrong `clientId` → HTTP 401

**Assert HTTP:** `401`

---

### DS-N-17 — Container not in Logward → HTTP 200 · no OTU mutated

```json
"order": { "reference": "UNKNOWN999" },
"cargo": { "reference": "UNKNOWN999", "qualifier": "CONTAINER" }
```
**Assert HTTP:** `200` · no OTU created or updated ✅

---

### DS-N-18 — Empty request body → HTTP 400

**Assert HTTP:** `400`

---

## EDGE CASES

### DS-E-01 — Same event twice · later date wins

**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`, `timezone = pick(TIMEZONES)`  
**Step 1:** `container_arrived` actual `discharge` · `date: STAGE_DATES.actualArrivalPod`  
**Step 2:** Same event · `date: STAGE_DATES.actualDischargePod` (later)  
**Assert:**
```
actualArrivalPod        = toStoredUtc(STAGE_DATES.actualDischargePod)  ✅
carrierUpdatedLocodePol = [pol.unlocode]          ✅
carrierUpdatedLocodePod = [pod.unlocode]          ✅
```

---

### DS-E-02 — Same event twice · earlier date does not overwrite

**Step 1:** `date: STAGE_DATES.actualDischargePod` → stored  
**Step 2:** `date: STAGE_DATES.actualArrivalPod` (earlier)  
**Assert:** `actualArrivalPod = toStoredUtc(STAGE_DATES.actualDischargePod)` ✅

---

### DS-E-03 — actual + estimated + predicted fields coexist independently

**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`, `timezone = pick(TIMEZONES)`  
Three `eta_event` sends at `discharge`, same `pol/pod/vessel/timezone` each time:

**Event 1 — estimated external:**
```json
"situation": { "event": "eta_event", "date": STAGE_DATES.estimatedArrivalPod, "type": "estimated" },
"situation_justification": { "data_source": "external" }
```
**Event 2 — estimated shippeo:**
```json
"situation": { "event": "eta_event", "date": STAGE_DATES.predictedArrivalPod, "type": "estimated" },
"situation_justification": { "data_source": "shippeo" }
```
**Event 3 — actual `container_arrived`:**
```json
"situation": { "event": "container_arrived", "date": STAGE_DATES.actualArrivalPod, "type": "actual" }
```
**Assert:**
```
estimatedArrivalPod     = toStoredUtc(STAGE_DATES.estimatedArrivalPod)  ✅
predictedArrivalPod     = toStoredUtc(STAGE_DATES.predictedArrivalPod)  ✅
actualArrivalPod        = toStoredUtc(STAGE_DATES.actualArrivalPod)  ✅
carrierUpdatedLocodePol = [pol.unlocode]          ✅  (same across all 3 — consistent)
carrierUpdatedLocodePod = [pod.unlocode]          ✅
leg1VesselImoNumber     = [vessel.imo]            ✅
datetime_timezone       = [timezone]              ✅
```

---

### DS-E-04 — Same POL + POD consistent across multiple events for same OTU

**Setup once:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`, `timezone = pick(TIMEZONES)`

Send 3 different events, all using the same `loading_site` and `delivery_site`:

| Step | Event | place_type |
|---|---|---|
| 1 | `container_gate_out_empty` actual | `origin_inland_location` |
| 2 | `container_loaded` actual | `loading` |
| 3 | `container_arrived` actual | `discharge` |

**Assert after each step:**
```
carrierUpdatedLocodePol = [pol.unlocode]  ✅  (same value — never changes)
carrierUpdatedLocodePod = [pod.unlocode]  ✅  (same value — never changes)
```

---

### DS-E-04b — POL port correction: `loading_site.unlocode` changes → `carrierUpdatedLocodePol` updated

**Setup:** `pol1 = pick(POL_LOCODES)`, `pol2 = pick(POL_LOCODES, excludeUnlocode: pol1.unlocode)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`, `timezone = pick(TIMEZONES)`

**Step 1 — original POL:**
```json
"loading_site":  { "unlocode": "[pol1.unlocode]", "name": "[pol1.name]", "country": "[pol1.country]" },
"delivery_site": { "unlocode": "[pod.unlocode]" },
"event_site":    { "place_type": "loading" }
```
**Assert after Step 1:**
```
carrierUpdatedLocodePol = [pol1.unlocode]  ✅
carrierUpdatedLocodePod = [pod.unlocode]   ✅
```

**Step 2 — corrected POL:**
```json
"loading_site":  { "unlocode": "[pol2.unlocode]", "name": "[pol2.name]", "country": "[pol2.country]" }
```
**Assert after Step 2:**
```
carrierUpdatedLocodePol = [pol2.unlocode]  ✅  (overwritten with corrected port)
carrierUpdatedLocodePod = [pod.unlocode]   ✅  (unchanged)
```

---

### DS-E-04c — POD port correction: `delivery_site.unlocode` changes → `carrierUpdatedLocodePod` updated

**Setup:** `pol = pick(POL_LOCODES)`, `pod1 = pick(POD_LOCODES)`, `pod2 = pick(POD_LOCODES, excludeUnlocode: pod1.unlocode)`, `vessel = pick(VESSELS)`, `timezone = pick(TIMEZONES)`

**Step 1 — original POD:**
```json
"loading_site":  { "unlocode": "[pol.unlocode]" },
"delivery_site": { "unlocode": "[pod1.unlocode]", "name": "[pod1.name]", "country": "[pod1.country]" }
```
**Assert after Step 1:**
```
carrierUpdatedLocodePol = [pol.unlocode]   ✅
carrierUpdatedLocodePod = [pod1.unlocode]  ✅
```

**Step 2 — corrected POD:**
```json
"delivery_site": { "unlocode": "[pod2.unlocode]", "name": "[pod2.name]", "country": "[pod2.country]" }
```
**Assert after Step 2:**
```
carrierUpdatedLocodePod = [pod2.unlocode]  ✅  (overwritten with corrected port)
carrierUpdatedLocodePol = [pol.unlocode]   ✅  (unchanged)
```

---

### DS-E-04d — POL correction does not affect POD and vice versa

**Setup:** `pol1`, `pol2`, `pod1`, `pod2` all different, `vessel = pick(VESSELS)`, `timezone = pick(TIMEZONES)`

**Step 1:** Send with `pol1` + `pod1`  
**Step 2:** Send with `pol2` + `pod1` (only POL changes)  
**Step 3:** Send with `pol2` + `pod2` (only POD changes)

**Assert after Step 2:**
```
carrierUpdatedLocodePol = [pol2.unlocode]  ✅  (updated)
carrierUpdatedLocodePod = [pod1.unlocode]  ✅  (unchanged)
```
**Assert after Step 3:**
```
carrierUpdatedLocodePol = [pol2.unlocode]  ✅  (unchanged)
carrierUpdatedLocodePod = [pod2.unlocode]  ✅  (updated)
```

---

### DS-E-04e — `leg1` vessel change: new `container_loaded` at loading → `leg1VesselImoNumber` + `leg1VesselName` updated in place

**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `timezone = pick(TIMEZONES)`  
`vessel1 = pick(VESSELS)`, `vessel2 = pick(VESSELS, excludeImo: vessel1.imo)`

**Step 1 — original vessel:**
```json
"situation": { "event": "container_loaded", "type": "actual", "transport_mode": "ocean" },
"event_site": { "place_type": "loading" },
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "[vessel1.imo]"  },
  { "qualifier": "LABEL", "value": "[vessel1.name]" }
]}]
```
**Assert after Step 1:**
```
leg1VesselImoNumber = [vessel1.imo]   ✅
leg1VesselName      = [vessel1.name]  ✅
leg2VesselImoNumber = null            ✅
leg2VesselName      = null            ✅
```

**Step 2 — corrected vessel:**
```json
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "[vessel2.imo]"  },
  { "qualifier": "LABEL", "value": "[vessel2.name]" }
]}]
```
**Assert after Step 2:**
```
leg1VesselImoNumber = [vessel2.imo]   ✅  (overwritten in place)
leg1VesselName      = [vessel2.name]  ✅  (overwritten in place)
leg2VesselImoNumber = null            ✅  (no new leg created)
leg2VesselName      = null            ✅
leg3VesselImoNumber = null            ✅
leg4VesselImoNumber = null            ✅
```

---

### DS-E-04f — `leg1` vessel IMO-only correction

**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel1 = pick(VESSELS)`, `timezone = pick(TIMEZONES)`

**Step 1:** `container_loaded` actual with `vessel1.imo` + `vessel1.name`  
**Step 2:** Same event, different IMO, same name:
```json
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "9999099" },
  { "qualifier": "LABEL", "value": "[vessel1.name]" }
]}]
```
**Assert after Step 2:**
```
leg1VesselImoNumber = "9999099"       ✅  (IMO updated)
leg1VesselName      = [vessel1.name]  ✅  (name unchanged)
leg2VesselImoNumber = null            ✅
```

---

### DS-E-04g — `leg1` vessel name-only correction

**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel1 = pick(VESSELS)`, `timezone = pick(TIMEZONES)`

**Step 1:** `container_loaded` actual with `vessel1.imo` + `vessel1.name`  
**Step 2:** Same event, same IMO, different name:
```json
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "[vessel1.imo]" },
  { "qualifier": "LABEL", "value": "UPDATED VESSEL NAME" }
]}]
```
**Assert after Step 2:**
```
leg1VesselImoNumber = [vessel1.imo]         ✅  (unchanged)
leg1VesselName      = "UPDATED VESSEL NAME" ✅  (updated)
leg2VesselImoNumber = null                  ✅
```

---

### DS-E-04h — `leg1` vessel change does NOT create a new leg slot

**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel1 = pick(VESSELS)`, `vessel2 = pick(VESSELS, excludeImo: vessel1.imo)`, `timezone = pick(TIMEZONES)`

Send `container_loaded` actual at `loading` twice — `vessel1` then `vessel2`.

**Assert after second send:**
```
leg1VesselImoNumber = [vessel2.imo]   ✅  (updated in place)
leg1VesselName      = [vessel2.name]  ✅  (updated in place)
leg2VesselImoNumber = null            ✅  (NOT created — no TSP logic on direct shipments)
leg2VesselName      = null            ✅
leg3VesselImoNumber = null            ✅
leg4VesselImoNumber = null            ✅
```

---

### DS-E-04i — `trackingArrivingVessel` change: new `container_unloaded` at discharge → updated in place

**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `timezone = pick(TIMEZONES)`  
`vessel1 = pick(VESSELS)`, `vessel2 = pick(VESSELS, excludeImo: vessel1.imo)`

**Step 1 — original vessel:**
```json
"situation": { "event": "container_unloaded", "type": "actual" },
"event_site": { "place_type": "discharge" },
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "[vessel1.imo]"  },
  { "qualifier": "LABEL", "value": "[vessel1.name]" }
]}]
```
**Assert after Step 1:**
```
trackingArrivingVesselImo        = [vessel1.imo]   ✅
trackingArrivingVesselVesselName = [vessel1.name]  ✅
```

**Step 2 — corrected vessel:**
```json
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "[vessel2.imo]"  },
  { "qualifier": "LABEL", "value": "[vessel2.name]" }
]}]
```
**Assert after Step 2:**
```
trackingArrivingVesselImo        = [vessel2.imo]   ✅  (overwritten in place)
trackingArrivingVesselVesselName = [vessel2.name]  ✅  (overwritten in place)
leg2VesselImoNumber              = null            ✅  (no new leg created)
leg2VesselName                   = null            ✅
```

---

### DS-E-04j — `trackingArrivingVessel` IMO-only correction

**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel1 = pick(VESSELS)`, `timezone = pick(TIMEZONES)`

**Step 1:** `container_unloaded` actual with `vessel1.imo` + `vessel1.name`  
**Step 2:** Same event, different IMO, same name:
```json
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "9999099" },
  { "qualifier": "LABEL", "value": "[vessel1.name]" }
]}]
```
**Assert after Step 2:**
```
trackingArrivingVesselImo        = "9999099"       ✅  (IMO updated)
trackingArrivingVesselVesselName = [vessel1.name]  ✅  (name unchanged)
```

---

### DS-E-04k — `trackingArrivingVessel` name-only correction

**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel1 = pick(VESSELS)`, `timezone = pick(TIMEZONES)`

**Step 1:** `container_unloaded` actual with `vessel1.imo` + `vessel1.name`  
**Step 2:** Same event, same IMO, different name:
```json
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "[vessel1.imo]" },
  { "qualifier": "LABEL", "value": "CORRECTED VESSEL NAME" }
]}]
```
**Assert after Step 2:**
```
trackingArrivingVesselImo        = [vessel1.imo]           ✅  (unchanged)
trackingArrivingVesselVesselName = "CORRECTED VESSEL NAME" ✅  (updated)
```

---

### DS-E-04l — `trackingArrivingVessel` change does NOT create a new leg slot

**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel1 = pick(VESSELS)`, `vessel2 = pick(VESSELS, excludeImo: vessel1.imo)`, `timezone = pick(TIMEZONES)`

Send `container_unloaded` at `discharge` twice — `vessel1` then `vessel2`.

**Assert after second send:**
```
trackingArrivingVesselImo        = [vessel2.imo]   ✅  (updated in place)
trackingArrivingVesselVesselName = [vessel2.name]  ✅  (updated in place)
leg2VesselImoNumber              = null            ✅  (NOT created)
leg2VesselName                   = null            ✅
leg3VesselImoNumber              = null            ✅
leg4VesselImoNumber              = null            ✅
```

---

### DS-E-04m — `leg1Vessel` and `trackingArrivingVessel` are completely independent

`leg1VesselImoNumber/Name` is written by `container_loaded` at `loading`.  
`trackingArrivingVesselImo/VesselName` is written by `container_unloaded` at `discharge`.  
A vessel correction on either one must never affect the other.

**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `timezone = pick(TIMEZONES)`  
`vessel1 = pick(VESSELS)`, `vessel2 = pick(VESSELS, excludeImo: vessel1.imo)`

**Step 1 — `container_loaded` actual at `loading` with `vessel1`:**
```json
"situation": { "event": "container_loaded", "type": "actual" },
"event_site": { "place_type": "loading" },
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "[vessel1.imo]"  },
  { "qualifier": "LABEL", "value": "[vessel1.name]" }
]}]
```

**Step 2 — `container_unloaded` actual at `discharge` with `vessel2`:**
```json
"situation": { "event": "container_unloaded", "type": "actual" },
"event_site": { "place_type": "discharge" },
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "[vessel2.imo]"  },
  { "qualifier": "LABEL", "value": "[vessel2.name]" }
]}]
```

**Assert after both steps:**
```
leg1VesselImoNumber              = [vessel1.imo]   ✅  (set at loading — not touched by discharge event)
leg1VesselName                   = [vessel1.name]  ✅
trackingArrivingVesselImo        = [vessel2.imo]   ✅  (set at discharge — not touched by loading event)
trackingArrivingVesselVesselName = [vessel2.name]  ✅
```

---

### DS-E-05 — UTC conversion: positive offset (+02:00)

**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`
```json
"situation": { "event": "container_arrived", "date": STAGE_DATES.actualArrivalPodPlus0200  // same logical time as actualArrivalPod expressed as +02:00, "type": "actual" },
"event_site": { "place_type": "discharge" }
```
`STAGE_DATES.actualArrivalPodPlus0200` → UTC = `toStoredUtc(STAGE_DATES.actualArrivalPod)`  
**Assert:**
```
actualArrivalPod        = toStoredUtc(STAGE_DATES.actualArrivalPod)  ✅
carrierUpdatedLocodePol = [pol.unlocode]          ✅
carrierUpdatedLocodePod = [pod.unlocode]          ✅
```

---

### DS-E-06 — UTC conversion: half-hour offset (+05:30)

**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`
```json
"situation": { "event": "container_arrived", "date": STAGE_DATES.actualArrivalPodPlus0530  // same logical time expressed as +05:30, "type": "actual" },
"event_site": { "place_type": "discharge" }
```
`STAGE_DATES.actualArrivalPodPlus0530` → UTC = `toStoredUtc(STAGE_DATES.actualArrivalPod)`  
**Assert:** `actualArrivalPod = toStoredUtc(STAGE_DATES.actualArrivalPod)` ✅

---

### DS-E-07 — UTC conversion: negative offset (-05:00)

**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`
```json
"situation": { "event": "container_arrived", "date": STAGE_DATES.actualArrivalPodMinus0500  // same logical time expressed as -05:00, "type": "actual" },
"event_site": { "place_type": "discharge" }
```
`STAGE_DATES.actualArrivalPodMinus0500` → UTC = `toStoredUtc(STAGE_DATES.actualArrivalPod)`  
**Assert:** `actualArrivalPod = toStoredUtc(STAGE_DATES.actualArrivalPod)` ✅

---

### DS-E-08 — UTC passthrough (+00:00) stored unchanged

**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`
```json
"situation": { "event": "container_arrived", "date": STAGE_DATES.actualArrivalPod, "type": "actual" },
"event_site": { "place_type": "discharge" }
```
**Assert:** `actualArrivalPod = toStoredUtc(STAGE_DATES.actualArrivalPod)` ✅

---

### DS-E-09 — Date far in future (2099)

**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`, `timezone = pick(TIMEZONES)`
```json
"situation": { "event": "container_arrived", "date": "2099-12-31T23:59:59+00:00", "type": "actual" },
"event_site": { "place_type": "discharge" }
```
**Assert:**
```
actualArrivalPod        = "2099-12-31 23:59:59"  ✅
carrierUpdatedLocodePol = [pol.unlocode]          ✅
carrierUpdatedLocodePod = [pod.unlocode]          ✅
```

---

### DS-E-10 — Vessel IMO null · vessel name still written

**Setup:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `timezone = pick(TIMEZONES)`
```json
"situation": { "event": "container_loaded", "type": "actual" },
"event_site": { "place_type": "loading" },
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": null },
  { "qualifier": "LABEL", "value": "ZEUS LUMOS" }
]}]
```
**Assert:**
```
leg1VesselImoNumber     = null         ✅
leg1VesselName          = "ZEUS LUMOS" ✅
carrierUpdatedLocodePol = [pol.unlocode] ✅
carrierUpdatedLocodePod = [pod.unlocode] ✅
datetime_timezone       = [timezone]     ✅
```

---

### DS-E-11 — Vessel name null · IMO still written

```json
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "9864239" },
  { "qualifier": "LABEL", "value": null }
]}]
```
**Assert:**
```
leg1VesselImoNumber = "9864239"  ✅
leg1VesselName      = null       ✅
```

---

### DS-E-12 — Full journey: Pre-Carriage → POL → POD → Delivery · no stage cross-contamination

**Setup once:** `pol = pick(POL_LOCODES)`, `pod = pick(POD_LOCODES)`, `vessel = pick(VESSELS)`, `timezone = pick(TIMEZONES)`. Same values for all steps.

| Step | Event | place_type | Target fields |
|---|---|---|---|
| 1 | `container_gate_out_empty` actual | `origin_inland_location` | `actualGateOutEmptyDepot` · `depotPreLocation` · `depotPreCountry` · `motGateOutEmpty` |
| 2 | `container_loaded` actual | `loading` | `actualLoadPol` · `leg1VesselImoNumber` · `leg1VesselName` · `leg1Mot` |
| 3 | `container_departed` actual | `loading` | `actualDeparturePol` |
| 4 | `container_arrived` actual | `discharge` | `actualArrivalPod` |
| 5 | `container_unloaded` actual | `discharge` | `actualDischargePod` · `trackingArrivingVesselImo` · `trackingArrivingVesselVesselName` |
| 6 | `container_arrived` actual | `destination_inland_location` | `actualArrivalDestination` · `destinationCity` · `destinationCountry` |

**Assert after all 6 steps:**
```
actualGateOutEmptyDepot          = <step1 date>    ✅
depotPreLocation                 = <city>          ✅
depotPreCountry                  = <country>       ✅
actualLoadPol                    = <step2 date>    ✅
leg1VesselImoNumber              = [vessel.imo]    ✅
leg1VesselName                   = [vessel.name]   ✅
actualDeparturePol               = <step3 date>    ✅
actualArrivalPod                 = <step4 date>    ✅
actualDischargePod               = <step5 date>    ✅
trackingArrivingVesselImo        = [vessel.imo]    ✅
trackingArrivingVesselVesselName = [vessel.name]   ✅
actualArrivalDestination         = <step6 date>    ✅
destinationCity                  = "Hamburg"       ✅
destinationCountry               = "DE"            ✅
carrierUpdatedLocodePol          = [pol.unlocode]  ✅  (consistent across all steps)
carrierUpdatedLocodePod          = [pod.unlocode]  ✅
datetime_timezone                = [timezone]      ✅
```

---

## Summary

| Group | IDs | Count | Coverage |
|---|---|---|---|
| Positive — Pre-Carriage | DS-PC-P-01 to DS-PC-P-06 | 6 | All 12 active Pre-Carriage mappings: dates · city/country · mot · actual + estimated |
| Positive — POL | DS-POL-P-01 to DS-POL-P-07 | 7 | All 11 active POL mappings: dates · vessel IMO + name + mot · actual + estimated + predicted |
| Positive — POD | DS-POD-P-01 to DS-POD-P-15 | 15 | All POD mappings + `trackingArrivingVesselImo/VesselName` via `container_unloaded` (actual + estimated) · `container_arrived` actual · `eta_event` estimated |
| Positive — Delivery | DS-DEL-P-01 to DS-DEL-P-02 | 2 | Arrival date · city · country · estimated |
| Negative | DS-N-01 to DS-N-18 + DS-N-09b/c | 20 | Wrong data_source · wrong place_type per stage · null date/city/country/locode/transport_mode · country as full name not ISO code · unknown event · auth failures |
| Edge Cases | DS-E-01 to DS-E-12 + DS-E-04b–m | 23 | Date conflict · field independence · POL/POD stability · POL/POD correction · POL/POD independent · `leg1` vessel overwrite/IMO-only/name-only/no new slot · `trackingArrivingVessel` overwrite/IMO-only/name-only/no new slot · `leg1` and `trackingArriving` independent · UTC conversion (4 variants) · future date · null vessel · full journey |
| **Total** | | **73** | |

> Every test picks `pol`, `pod`, `vessel`, `timezone` **once per OTU** at test setup and holds them constant across all events. Always-on fields (`carrierUpdatedLocodePol`, `carrierUpdatedLocodePod`, `leg1VesselImoNumber`, `leg1VesselName`, `datetime_timezone`) are asserted in every test. Vessel change tests use `excludeImo` to guarantee a genuinely different vessel is picked.

---

## Payload Factory Reference

```js
buildDirectPayload({
  event,          // e.g. "container_arrived"
  placeType,      // "origin_inland_location" | "loading" | "discharge" | "destination_inland_location"
  situationType,  // "actual" | "estimated"
  dataSource,     // "external" | "shippeo" | null
  date,           // ISO string e.g. STAGE_DATES.gateOutEmpty
  transportMode,  // "ocean" | "road" | "rail" | null
  city,           // event_site.city
  country,        // event_site.country — MUST be ISO 3166-1 alpha-2 code e.g. "CN", "NL", "DE" — never full names
  timezone,       // event_site.timezone   — pick(TIMEZONES)
  loadingLocode,  // loading_site.unlocode — pick(POL_LOCODES).unlocode
  deliveryLocode, // delivery_site.unlocode — pick(POD_LOCODES).unlocode
  vesselImo,      // resources[milestoneVessel] IMO   — pick(VESSELS).imo
  vesselName,     // resources[milestoneVessel] LABEL — pick(VESSELS).name
  containerRef,   // cargo.reference — OTU lookup only, not a mapped field
})

// ─── DATA SOURCE ROUTING ────────────────────────────────────────────────
// actual              → actualXxx     (no data_source check)
// estimated+external  → estimatedXxx
// estimated+shippeo   → predictedXxx
// estimated+other     → nothing written

// ─── PLACE TYPE ROUTING ─────────────────────────────────────────────────
// origin_inland_location      → Pre-Carriage fields
// loading                     → POL fields
// discharge                   → POD fields
// destination_inland_location → Delivery fields

// ─── ALWAYS-ON FIELDS ───────────────────────────────────────────────────
// loading_site.unlocode   → carrierUpdatedLocodePol   (every event)
// delivery_site.unlocode  → carrierUpdatedLocodePod   (every event)
// event_site.timezone     → datetime_timezone         (every event)
// milestoneVessel IMO     → leg1VesselImoNumber       (every event with vessel)
// milestoneVessel LABEL   → leg1VesselName            (every event with vessel)
```

---

*Source: `Ocean_Events_Out_Mapping.xlsx` — Copy of Shippeo → Logward Mapping, active rows (Pre-Carriage · POL · POD · Delivery · Other), TSP block excluded | Logward QA | 2026-06-11*
