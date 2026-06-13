# GROUP TSP — Transhipment Tests (Old Flow + New Flow)
**File:** `E2E_Ocean.spec.js`
**Source:** `QA_Ocean_Routing_Complete.docx` | Branch: DP-449
**Updated:** 2026-06-13

---

## Core Rules — New Flow

```
1. ROUTING
   Container in legacy S3 list → OLD FLOW
   Container NOT in list       → NEW FLOW

2. TSP TRIGGER
   event_site.place_type = "transhipment" → TSP logic runs
   Any other place_type                   → TSP logic skipped entirely

3. SLOT ASSIGNMENT (locode-based)
   Pass 1 — REUSE: scan tsp1Locode → tsp4Locode for event_site.unlocode match → reuse slot N
   Pass 2 — CLAIM: no match → first empty slot → write locode → slot N
   Error  — all 4 slots full → log error, nothing written

4. DATE FIELD
   Slot number is always N (same slot as matched/claimed locode)
   Field NAME depends on situation.event:
     container_arrived  → XxxArrivalTsp{N}
     container_unloaded → XxxDischargeTsp{N}
     container_loaded   → XxxLoadTsp{N}
     container_departed → XxxDepartureTsp{N}

   Where Xxx is determined by situation.type + data_source:
     actual   + data_source absent/null → actual    (e.g. actualArrivalTsp1)
     actual   + data_source = anything  → NOT written
     estimated + data_source = external → estimated  (e.g. estimatedArrivalTsp1)
     estimated + data_source = shippeo  → predicted  (e.g. predictedArrivalTsp1)
     estimated + data_source absent/null/other → NOT written

5. LOCODE FIELD (tspNLocode)
   Written on ALL 4 events (arrived/unloaded/loaded/departed)
   Written at slot N (matched or claimed)

6. VESSEL FIELD (legNVesselImoNumber / legNVesselName)
   Written on ALL 4 events
   NON-INCREMENT (container_arrived, container_unloaded) → vessel at N
   INCREMENT     (container_loaded, container_departed)  → vessel at N+1
   Slot 4 INCREMENT → N+1=5 does not exist → vessel silently skipped, date still written at N=4

7. TIMEZONE
   All dates from Shippeo arrive in UTC
   Transformer converts UTC → local time using event_site.timezone BEFORE storing in BE
   datetime_timezone is used for conversion only — NEVER stored in BE

8. NOT MAPPED IN TSP EVENTS
   carrierUpdatedLocodePol / carrierUpdatedLocodePod → non-TSP events only (ignored for transhipment)
   billOfLadingNumber / bookingNumber / containerNumber / SCAC → not mapped
```

---

## Old Flow vs New Flow (for cross-contamination tests)

| | Old Flow | New Flow |
|---|---|---|
| **Container** | `MSCU1234567` (in legacy S3 list) | `generateContainerRef()` — fresh per test |
| **Slot key** | Vessel IMO / name | Port locode |
| **tspNLocode** | Written — but DUPLICATE locodes possible when vessel substituted (same port ends up in two slots) | Written — no duplicates (locode is the key, same port always reuses same slot) |
| **Vessel** | Always at N — new vessel = new slot (no N+1) | NON-INCR at N · INCREMENT at N+1 — new vessel updates in place |
| **Date fields** | Written at N | Written at N |
| **Vessel substitution result** | Same locode in tsp1 AND tsp2 (false extra slot) | Slot reused via Pass 1 · vessel updated via N+1 · no duplicate locode |

---

## Data Pools & Helpers

```js
const TSP_LOCODES = [
  { unlocode: 'SGSIN', timezone: 'Asia/Singapore'    },
  { unlocode: 'MYPKG', timezone: 'Asia/Kuala_Lumpur' },
  { unlocode: 'AEJEA', timezone: 'Asia/Dubai'        },
  { unlocode: 'CNSHA', timezone: 'Asia/Shanghai'     },
  { unlocode: 'DEHAM', timezone: 'Europe/Berlin'     },
  { unlocode: 'HKHKG', timezone: 'Asia/Hong_Kong'    },
  { unlocode: 'KRPUS', timezone: 'Asia/Seoul'        },
  { unlocode: 'NLRTM', timezone: 'Europe/Amsterdam'  },
];

const VESSELS = [
  { imo: '9293167', mmsi: '636023646', name: 'MSC RONIT R'    },
  { imo: '9864239', mmsi: '636023647', name: 'ZEUS LUMOS'      },
  { imo: '9999001', mmsi: '636023648', name: 'EVER GIVEN'      },
  { imo: '9999002', mmsi: '636023649', name: 'MAERSK IOWA'     },
  { imo: '9999003', mmsi: '636023650', name: 'COSCO STAR'      },
  { imo: '9999004', mmsi: '636023651', name: 'EVERGREEN TITAN' },
  { imo: '9999005', mmsi: '636023652', name: 'MSC OSCAR'       },
  { imo: '9999006', mmsi: '636023653', name: 'CMA CGM MARCO'   },
];

// Realistic logistics timeline relative to today
const STAGE_DATES = {
  actualArrivalTsp1:     stageDate(-12, 14),
  actualDischargeTsp1:   stageDate(-11, 8),
  actualLoadTsp1:        stageDate(-10, 22),
  actualDepartureTsp1:   stageDate(-10, 23),
  actualArrivalTsp2:     stageDate(-5,  6),
  actualDischargeTsp2:   stageDate(-4,  10),
  actualLoadTsp2:        stageDate(-3,  14),
  actualDepartureTsp2:   stageDate(-3,  15),
  estimatedArrivalTsp:   stageDate(5,   8),
  predictedArrivalTsp:   stageDate(6,   8),
  estimatedDischargeTsp: stageDate(5,   10),
  estimatedLoadTsp:      stageDate(4,   8),
  estimatedDepartureTsp: stageDate(4,   12),
};

function stageDate(daysFromToday, hours = 8) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  d.setUTCHours(hours, 0, 0, 0);
  return d.toISOString();
}

// Mirrors what the transformer does — UTC in, local time stored in BE
function toLocalTime(isoUtc, timezone) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).format(new Date(isoUtc)).replace('T', ' ');
}

// Fresh container ref per test — prevents state bleed between runs
function generateContainerRef() {
  return `TCKU${Date.now().toString().slice(-7)}`;
}

function pick(pool, excludeUnlocode = null) {
  const filtered = excludeUnlocode
    ? pool.filter(p => p.unlocode !== excludeUnlocode)
    : pool;
  return filtered[Math.floor(Math.random() * filtered.length)];
}

function pickVessel(excludeImo = null) {
  const filtered = excludeImo
    ? VESSELS.filter(v => v.imo !== excludeImo)
    : VESSELS;
  return filtered[Math.floor(Math.random() * filtered.length)];
}
```

---

## Canonical Base Payload

```json
{
  "order":  { "edi_reference": "[containerRef]", "reference": "[containerRef]" },
  "tour":   { "edi_reference": "[containerRef]", "reference": "[containerRef]" },
  "loading_site":  { "unlocode": "CNNGB" },
  "delivery_site": { "unlocode": "NLRTM" },
  "cargo": { "reference": "[containerRef]", "qualifier": "CONTAINER" },
  "situation": {
    "event": "container_arrived",
    "date":  "[STAGE_DATES.actualArrivalTsp1]",
    "type":  "actual",
    "transport_mode": "ocean"
  },
  "situation_justification": {
    "data_source": null,
    "platform_type": "ocean"
  },
  "event_site": {
    "unlocode":   "[tsp.unlocode]",
    "timezone":   "[tsp.timezone]",
    "place_type": "transhipment"
  },
  "resources": [{
    "qualifier": "milestoneVessel",
    "identifiers": [
      { "qualifier": "IMO",   "value": "[vessel.imo]"  },
      { "qualifier": "MMSI",  "value": "[vessel.mmsi]" },
      { "qualifier": "LABEL", "value": "[vessel.name]" }
    ]
  }]
}
```

> `loading_site` and `delivery_site` are included in payload but `carrierUpdatedLocodePol/Pod` are NOT asserted in TSP tests — they are only mapped on non-TSP events.

---

## ══════════════════════════════════════════
## SECTION 1 — NEW FLOW TESTS
## ══════════════════════════════════════════

---

## NEW — ROUTING

### NEW-R-01 — Non-legacy container → new flow · locode slot fields populated

**Setup:** `containerRef = generateContainerRef()`, `tsp = pick(TSP_LOCODES)`, `vessel = pick(VESSELS)`
**Payload changes:**
```json
"situation": { "event": "container_arrived", "date": STAGE_DATES.actualArrivalTsp1, "type": "actual" },
"situation_justification": { "data_source": null },
"event_site": { "unlocode": "[tsp.unlocode]", "timezone": "[tsp.timezone]", "place_type": "transhipment" }
```
**Assert:**
```
tsp1Locode          = [tsp.unlocode]                                             ✅
actualArrivalTsp1   = toLocalTime(STAGE_DATES.actualArrivalTsp1, tsp.timezone)  ✅
leg1VesselImoNumber = [vessel.imo]                                               ✅
leg1VesselName      = [vessel.name]                                               ✅
tsp2Locode          = null                                                       ✅
```

---

### NEW-R-02 — Legacy container → old flow · new flow fields NOT populated

**Payload changes:**
```json
"order": { "reference": "MSCU1234567" },
"cargo": { "reference": "MSCU1234567", "qualifier": "CONTAINER" },
"situation": { "event": "container_arrived", "type": "actual" },
"situation_justification": { "data_source": null },
"event_site": { "unlocode": "[tsp.unlocode]", "timezone": "[tsp.timezone]", "place_type": "transhipment" }
```
**Assert — confirm old flow runs, new flow logic NOT applied:**
```
tsp1Locode          = [tsp.unlocode]                                             ✅  (old flow writes locode)
actualArrivalTsp1   = toLocalTime(STAGE_DATES.actualArrivalTsp1, tsp.timezone)  ✅  (old flow writes date fields)
leg1VesselImoNumber = [vessel.imo]                                               ✅  (old flow vessel at N — no N+1)
leg1VesselName      = [vessel.name]                                              ✅
leg2VesselImoNumber = null                                                       ✅  (N+1 NOT applied — confirms old flow)
leg2VesselName      = null                                                       ✅
```

---

## NEW — POSITIVE TESTS — Slot Assignment (all 4 events × actual)

### NEW-P-01 — `container_arrived` actual · first event claims slot 1

**Setup:** `containerRef = generateContainerRef()`, `tsp = pick(TSP_LOCODES)`, `vessel = pick(VESSELS)`
**Payload changes:**
```json
"situation": { "event": "container_arrived", "date": STAGE_DATES.actualArrivalTsp1, "type": "actual" },
"situation_justification": { "data_source": null },
"event_site": { "unlocode": "[tsp.unlocode]", "timezone": "[tsp.timezone]", "place_type": "transhipment" }
```
**Assert:**
```
tsp1Locode          = [tsp.unlocode]                                             ✅  (Pass 2: claimed)
tsp2Locode          = null                                                       ✅
tsp3Locode          = null                                                       ✅
tsp4Locode          = null                                                       ✅
actualArrivalTsp1   = toLocalTime(STAGE_DATES.actualArrivalTsp1, tsp.timezone)  ✅  (date at N=1)
leg1VesselImoNumber = [vessel.imo]                                               ✅  (NON-INCREMENT → N=1)
leg1VesselName      = [vessel.name]                                              ✅
leg2VesselImoNumber = null                                                       ✅
```

---

### NEW-P-02 — `container_unloaded` actual · slot 1 claimed

**Setup:** `containerRef = generateContainerRef()`, `tsp = pick(TSP_LOCODES)`, `vessel = pick(VESSELS)`
**Payload changes:**
```json
"situation": { "event": "container_unloaded", "date": STAGE_DATES.actualDischargeTsp1, "type": "actual" },
"situation_justification": { "data_source": null },
"event_site": { "unlocode": "[tsp.unlocode]", "timezone": "[tsp.timezone]", "place_type": "transhipment" }
```
**Assert:**
```
tsp1Locode           = [tsp.unlocode]                                              ✅
actualDischargeTsp1  = toLocalTime(STAGE_DATES.actualDischargeTsp1, tsp.timezone) ✅  (date at N=1)
leg1VesselImoNumber  = [vessel.imo]                                                ✅  (NON-INCREMENT → N=1)
leg1VesselName       = [vessel.name]                                               ✅
leg2VesselImoNumber  = null                                                        ✅
```

---

### NEW-P-03 — `container_loaded` actual · slot 1 claimed · vessel at N+1=2

**Setup:** `containerRef = generateContainerRef()`, `tsp = pick(TSP_LOCODES)`, `vessel = pick(VESSELS)`
**Payload changes:**
```json
"situation": { "event": "container_loaded", "date": STAGE_DATES.actualLoadTsp1, "type": "actual" },
"situation_justification": { "data_source": null },
"event_site": { "unlocode": "[tsp.unlocode]", "timezone": "[tsp.timezone]", "place_type": "transhipment" }
```
**Assert:**
```
tsp1Locode          = [tsp.unlocode]                                             ✅  (locode at N=1)
actualLoadTsp1      = toLocalTime(STAGE_DATES.actualLoadTsp1, tsp.timezone)     ✅  (date at N=1)
leg2VesselImoNumber = [vessel.imo]                                               ✅  (INCREMENT → N+1=2)
leg2VesselName      = [vessel.name]                                              ✅
leg1VesselImoNumber = null                                                       ✅  (slot 1 vessel NOT written by loaded)
```

---

### NEW-P-04 — `container_departed` actual · slot 1 claimed · vessel at N+1=2

**Setup:** `containerRef = generateContainerRef()`, `tsp = pick(TSP_LOCODES)`, `vessel = pick(VESSELS)`
**Payload changes:**
```json
"situation": { "event": "container_departed", "date": STAGE_DATES.actualDepartureTsp1, "type": "actual" },
"situation_justification": { "data_source": null },
"event_site": { "unlocode": "[tsp.unlocode]", "timezone": "[tsp.timezone]", "place_type": "transhipment" }
```
**Assert:**
```
tsp1Locode          = [tsp.unlocode]                                               ✅
actualDepartureTsp1 = toLocalTime(STAGE_DATES.actualDepartureTsp1, tsp.timezone)  ✅  (date at N=1)
leg2VesselImoNumber = [vessel.imo]                                                 ✅  (INCREMENT → N+1=2)
leg2VesselName      = [vessel.name]                                                ✅
leg1VesselImoNumber = null                                                         ✅
```

---

## NEW — POSITIVE TESTS — Slot REUSE (Pass 1)

### NEW-P-05 — Same locode again → reuses slot 1 · no new slot claimed

**Setup:** `containerRef = generateContainerRef()`, `tsp = pick(TSP_LOCODES)`, `vessel = pick(VESSELS)`

**Step 1 — arrive at TSP:**
```json
"situation": { "event": "container_arrived", "date": STAGE_DATES.actualArrivalTsp1, "type": "actual" },
"situation_justification": { "data_source": null }
```

**Step 2 — unload at same TSP (same locode):**
```json
"situation": { "event": "container_unloaded", "date": STAGE_DATES.actualDischargeTsp1, "type": "actual" },
"situation_justification": { "data_source": null }
```
**Assert after Step 2:**
```
tsp1Locode          = [tsp.unlocode]                                              ✅  (Pass 1: reused)
tsp2Locode          = null                                                        ✅  (no new slot)
actualArrivalTsp1   = toLocalTime(STAGE_DATES.actualArrivalTsp1, tsp.timezone)   ✅  (unchanged)
actualDischargeTsp1 = toLocalTime(STAGE_DATES.actualDischargeTsp1, tsp.timezone) ✅  (added)
```

---

### NEW-P-06 — Full slot 1 journey: arrive → unload → load → depart · all fields at correct slots

**Setup:** `containerRef = generateContainerRef()`, `tsp = pick(TSP_LOCODES)`, `vessel1 = pick(VESSELS)`, `vessel2 = pickVessel(excludeImo: vessel1.imo)`

| Step | Event | data_source | Vessel | Date field | Vessel field |
|---|---|---|---|---|---|
| 1 | `container_arrived` | null | `vessel1` | `actualArrivalTsp1` → N=1 | `leg1Vessel` → N=1 |
| 2 | `container_unloaded` | null | `vessel1` | `actualDischargeTsp1` → N=1 | `leg1Vessel` → N=1 |
| 3 | `container_loaded` | null | `vessel2` | `actualLoadTsp1` → N=1 | `leg2Vessel` → N+1=2 |
| 4 | `container_departed` | null | `vessel2` | `actualDepartureTsp1` → N=1 | `leg2Vessel` → N+1=2 |

**Assert after all 4:**
```
tsp1Locode          = [tsp.unlocode]                                               ✅
tsp2Locode          = null                                                         ✅
actualArrivalTsp1   = toLocalTime(STAGE_DATES.actualArrivalTsp1,   tsp.timezone)  ✅
actualDischargeTsp1 = toLocalTime(STAGE_DATES.actualDischargeTsp1, tsp.timezone)  ✅
actualLoadTsp1      = toLocalTime(STAGE_DATES.actualLoadTsp1,      tsp.timezone)  ✅
actualDepartureTsp1 = toLocalTime(STAGE_DATES.actualDepartureTsp1, tsp.timezone)  ✅
leg1VesselImoNumber = [vessel1.imo]   ✅  (set by arrived/unloaded)
leg1VesselName      = [vessel1.name]  ✅
leg2VesselImoNumber = [vessel2.imo]   ✅  (set by loaded/departed — N+1)
leg2VesselName      = [vessel2.name]  ✅
```

---

## NEW — POSITIVE TESTS — Slot CLAIM (Pass 2)

### NEW-P-07 — Different locode → claims slot 2

**Setup:** `containerRef = generateContainerRef()`, `tsp1 = pick(TSP_LOCODES)`, `tsp2 = pick(TSP_LOCODES, excludeUnlocode: tsp1.unlocode)`, `vessel1 = pick(VESSELS)`, `vessel2 = pickVessel(excludeImo: vessel1.imo)`

**Step 1 — arrive at TSP1:**
```json
"event_site": { "unlocode": "[tsp1.unlocode]", "timezone": "[tsp1.timezone]", "place_type": "transhipment" },
"resources": [vessel1]
```

**Step 2 — arrive at TSP2 (different locode):**
```json
"situation": { "event": "container_arrived", "date": STAGE_DATES.actualArrivalTsp2, "type": "actual" },
"situation_justification": { "data_source": null },
"event_site": { "unlocode": "[tsp2.unlocode]", "timezone": "[tsp2.timezone]", "place_type": "transhipment" },
"resources": [vessel2]
```
**Assert after Step 2:**
```
tsp1Locode          = [tsp1.unlocode]                                             ✅  (unchanged)
tsp2Locode          = [tsp2.unlocode]                                             ✅  (Pass 2: slot 2 claimed)
tsp3Locode          = null                                                        ✅
actualArrivalTsp1   = toLocalTime(STAGE_DATES.actualArrivalTsp1, tsp1.timezone)  ✅  (slot 1 unchanged)
actualArrivalTsp2   = toLocalTime(STAGE_DATES.actualArrivalTsp2, tsp2.timezone)  ✅  (slot 2 written)
leg1VesselImoNumber = [vessel1.imo]   ✅  (slot 1 unchanged)
leg2VesselImoNumber = [vessel2.imo]   ✅  (NON-INCREMENT → N=2)
```

---

### NEW-P-08 — All 4 slots populated with 4 different locodes

**Setup:** `containerRef = generateContainerRef()`, `tsp1–tsp4` all different, `vessel1–vessel4` all different

| Step | unlocode | Expected slot | Date field |
|---|---|---|---|
| 1 | `tsp1.unlocode` | slot 1 | `actualArrivalTsp1` |
| 2 | `tsp2.unlocode` | slot 2 | `actualArrivalTsp2` |
| 3 | `tsp3.unlocode` | slot 3 | `actualArrivalTsp3` |
| 4 | `tsp4.unlocode` | slot 4 | `actualArrivalTsp4` |

**Assert:**
```
tsp1Locode = [tsp1.unlocode]  actualArrivalTsp1 = toLocalTime(STAGE_DATES.actualArrivalTsp1, tsp1.timezone)  ✅
tsp2Locode = [tsp2.unlocode]  actualArrivalTsp2 = toLocalTime(STAGE_DATES.actualArrivalTsp2, tsp2.timezone)  ✅
tsp3Locode = [tsp3.unlocode]  actualArrivalTsp3 = toLocalTime(...)  ✅
tsp4Locode = [tsp4.unlocode]  actualArrivalTsp4 = toLocalTime(...)  ✅
```

---

## NEW — POSITIVE TESTS — Estimated & Predicted (all 4 events)

### NEW-P-09 — `container_arrived` estimated external → `estimatedArrivalTsp1`

**Setup:** `containerRef = generateContainerRef()`, `tsp = pick(TSP_LOCODES)`, `vessel = pick(VESSELS)`
**Payload changes:**
```json
"situation": { "event": "container_arrived", "date": STAGE_DATES.estimatedArrivalTsp, "type": "estimated" },
"situation_justification": { "data_source": "external" }
```
**Assert:**
```
estimatedArrivalTsp1 = toLocalTime(STAGE_DATES.estimatedArrivalTsp, tsp.timezone)  ✅
actualArrivalTsp1    = null                                                          ✅  (actual not written)
predictedArrivalTsp1 = null                                                          ✅
tsp1Locode           = [tsp.unlocode]                                               ✅
leg1VesselImoNumber  = [vessel.imo]                                                  ✅  (NON-INCREMENT → N=1)
```

---

### NEW-P-10 — `container_arrived` estimated shippeo → `predictedArrivalTsp1`

**Payload changes:**
```json
"situation": { "event": "container_arrived", "date": STAGE_DATES.predictedArrivalTsp, "type": "estimated" },
"situation_justification": { "data_source": "shippeo" }
```
**Assert:**
```
predictedArrivalTsp1 = toLocalTime(STAGE_DATES.predictedArrivalTsp, tsp.timezone)  ✅
estimatedArrivalTsp1 = null                                                          ✅
actualArrivalTsp1    = null                                                          ✅
tsp1Locode           = [tsp.unlocode]                                               ✅
leg1VesselImoNumber  = [vessel.imo]                                                  ✅
```

---

### NEW-P-11 — `container_unloaded` estimated external → `estimatedDischargeTsp1`

**Payload changes:**
```json
"situation": { "event": "container_unloaded", "date": STAGE_DATES.estimatedDischargeTsp, "type": "estimated" },
"situation_justification": { "data_source": "external" }
```
**Assert:**
```
estimatedDischargeTsp1 = toLocalTime(STAGE_DATES.estimatedDischargeTsp, tsp.timezone)  ✅
actualDischargeTsp1    = null                                                             ✅
tsp1Locode             = [tsp.unlocode]                                                  ✅
leg1VesselImoNumber    = [vessel.imo]                                                    ✅
```

---

### NEW-P-12 — `container_unloaded` estimated shippeo → `predictedDischargeTsp1`

**Payload changes:**
```json
"situation": { "event": "container_unloaded", "date": STAGE_DATES.estimatedDischargeTsp, "type": "estimated" },
"situation_justification": { "data_source": "shippeo" }
```
**Assert:**
```
predictedDischargeTsp1 = toLocalTime(STAGE_DATES.estimatedDischargeTsp, tsp.timezone)  ✅
estimatedDischargeTsp1 = null                                                             ✅
tsp1Locode             = [tsp.unlocode]                                                  ✅
leg1VesselImoNumber    = [vessel.imo]                                                    ✅
```

---

### NEW-P-13 — `container_loaded` estimated external → `estimatedLoadTsp1` · vessel at N+1=2

**Payload changes:**
```json
"situation": { "event": "container_loaded", "date": STAGE_DATES.estimatedLoadTsp, "type": "estimated" },
"situation_justification": { "data_source": "external" }
```
**Assert:**
```
estimatedLoadTsp1   = toLocalTime(STAGE_DATES.estimatedLoadTsp, tsp.timezone)  ✅
actualLoadTsp1      = null                                                       ✅
tsp1Locode          = [tsp.unlocode]                                            ✅
leg2VesselImoNumber = [vessel.imo]                                              ✅  (INCREMENT → N+1=2)
leg1VesselImoNumber = null                                                       ✅
```

---

### NEW-P-14 — `container_loaded` estimated shippeo → `predictedLoadTsp1` · vessel at N+1=2

**Payload changes:**
```json
"situation": { "event": "container_loaded", "date": STAGE_DATES.estimatedLoadTsp, "type": "estimated" },
"situation_justification": { "data_source": "shippeo" }
```
**Assert:**
```
predictedLoadTsp1   = toLocalTime(STAGE_DATES.estimatedLoadTsp, tsp.timezone)  ✅
estimatedLoadTsp1   = null                                                       ✅
tsp1Locode          = [tsp.unlocode]                                            ✅
leg2VesselImoNumber = [vessel.imo]                                              ✅  (INCREMENT → N+1=2)
leg1VesselImoNumber = null                                                       ✅
```

---

### NEW-P-15 — `container_departed` estimated external → `estimatedDepartureTsp1` · vessel at N+1=2

**Payload changes:**
```json
"situation": { "event": "container_departed", "date": STAGE_DATES.estimatedDepartureTsp, "type": "estimated" },
"situation_justification": { "data_source": "external" }
```
**Assert:**
```
estimatedDepartureTsp1 = toLocalTime(STAGE_DATES.estimatedDepartureTsp, tsp.timezone)  ✅
actualDepartureTsp1    = null                                                             ✅
tsp1Locode             = [tsp.unlocode]                                                  ✅
leg2VesselImoNumber    = [vessel.imo]                                                    ✅  (INCREMENT → N+1=2)
leg1VesselImoNumber    = null                                                             ✅
```

---

### NEW-P-16 — `container_departed` estimated shippeo → `predictedDepartureTsp1` · vessel at N+1=2

**Payload changes:**
```json
"situation": { "event": "container_departed", "date": STAGE_DATES.estimatedDepartureTsp, "type": "estimated" },
"situation_justification": { "data_source": "shippeo" }
```
**Assert:**
```
predictedDepartureTsp1 = toLocalTime(STAGE_DATES.estimatedDepartureTsp, tsp.timezone)  ✅
estimatedDepartureTsp1 = null                                                             ✅
tsp1Locode             = [tsp.unlocode]                                                  ✅
leg2VesselImoNumber    = [vessel.imo]                                                    ✅
leg1VesselImoNumber    = null                                                             ✅
```

---

### NEW-P-17 — actual + estimated + predicted coexist independently on same slot

Send `container_arrived` 3 times at same locode (slot 1 reused each time):

**Event 1 — actual:**
```json
"situation": { "event": "container_arrived", "date": STAGE_DATES.actualArrivalTsp1, "type": "actual" },
"situation_justification": { "data_source": null }
```
**Event 2 — estimated external:**
```json
"situation": { "event": "container_arrived", "date": STAGE_DATES.estimatedArrivalTsp, "type": "estimated" },
"situation_justification": { "data_source": "external" }
```
**Event 3 — predicted shippeo:**
```json
"situation": { "event": "container_arrived", "date": STAGE_DATES.predictedArrivalTsp, "type": "estimated" },
"situation_justification": { "data_source": "shippeo" }
```
**Assert:**
```
actualArrivalTsp1    = toLocalTime(STAGE_DATES.actualArrivalTsp1,   tsp.timezone)  ✅
estimatedArrivalTsp1 = toLocalTime(STAGE_DATES.estimatedArrivalTsp, tsp.timezone)  ✅
predictedArrivalTsp1 = toLocalTime(STAGE_DATES.predictedArrivalTsp, tsp.timezone)  ✅
tsp1Locode           = [tsp.unlocode]                                               ✅
tsp2Locode           = null                                                         ✅  (no new slot)
```

---

### NEW-P-18 — Estimated at slot 2 (not just slot 1)

**Setup:** `tsp2` already in slot 2  
**Payload changes:**
```json
"situation": { "event": "container_arrived", "date": STAGE_DATES.estimatedArrivalTsp, "type": "estimated" },
"situation_justification": { "data_source": "external" },
"event_site": { "unlocode": "[tsp2.unlocode]", "timezone": "[tsp2.timezone]", "place_type": "transhipment" }
```
**Assert:**
```
estimatedArrivalTsp2 = toLocalTime(STAGE_DATES.estimatedArrivalTsp, tsp2.timezone)  ✅
estimatedArrivalTsp1 = null                                                           ✅  (slot 1 not touched)
```

---

## NEW — POSITIVE TESTS — Vessel Slot Logic

### NEW-V-01 — Slot 2 journey · NON-INCR at N=2 · INCREMENT at N+1=3

**Setup:** `tsp2` in slot 2, `vessel2 = pick(VESSELS)`, `vessel3 = pickVessel(excludeImo: vessel2.imo)`

**Step 1 — `container_arrived` at slot 2:**
```json
"event_site": { "unlocode": "[tsp2.unlocode]", "place_type": "transhipment" },
"resources": [vessel2]
```
**Assert:** `leg2VesselImoNumber = vessel2.imo` ✅ · `leg3VesselImoNumber = null` ✅

**Step 2 — `container_departed` at slot 2 with vessel3:**
```json
"resources": [vessel3]
```
**Assert:**
```
leg3VesselImoNumber = [vessel3.imo]   ✅  (N+1=3)
leg2VesselImoNumber = [vessel2.imo]   ✅  (unchanged from step 1)
actualDepartureTsp2 = toLocalTime(STAGE_DATES.actualDepartureTsp2, tsp2.timezone)  ✅
```

---

### NEW-V-02 — Slot 4 INCREMENT → N+1=5 out of range · vessel silently skipped · date written

**Setup:** `containerRef = generateContainerRef()`, `tsp1–tsp4` all different, fill all 4 slots  
**Payload changes:**
```json
"situation": { "event": "container_departed", "date": STAGE_DATES.actualDepartureTsp1, "type": "actual" },
"situation_justification": { "data_source": null },
"event_site": { "unlocode": "[tsp4.unlocode]", "timezone": "[tsp4.timezone]", "place_type": "transhipment" }
```
**Assert:**
```
actualDepartureTsp4 = toLocalTime(STAGE_DATES.actualDepartureTsp1, tsp4.timezone)  ✅  (date at N=4)
leg5VesselImoNumber = null                                                           ✅  (slot 5 doesn't exist)
leg5VesselName      = null                                                           ✅
leg4VesselImoNumber = null                                                           ✅  (departed doesn't write at N)
```
**HTTP:** `200` ✅ (no crash)

---

### NEW-V-03 — Vessel change NON-INCREMENT · leg N updated in place · no new slot

**Setup:** `tsp` in slot 1, `vessel1 = pick(VESSELS)`, `vessel2 = pickVessel(excludeImo: vessel1.imo)`

**Step 1:** `container_arrived` with `vessel1` → `leg1VesselImoNumber = vessel1.imo`
**Step 2:** `container_arrived` with `vessel2` (same locode → slot 1 reused)  
**Assert:**
```
leg1VesselImoNumber = [vessel2.imo]   ✅  (updated in place)
leg1VesselName      = [vessel2.name]  ✅
leg2VesselImoNumber = null            ✅  (no new slot)
```

---

### NEW-V-04 — Vessel change INCREMENT · leg N+1 updated in place · no new slot

**Step 1:** `container_departed` with `vessel1` → `leg2VesselImoNumber = vessel1.imo`  
**Step 2:** `container_departed` with `vessel2` (same locode → slot 1 reused)  
**Assert:**
```
leg2VesselImoNumber = [vessel2.imo]   ✅  (updated in place)
leg3VesselImoNumber = null            ✅  (no new slot)
```

---

### NEW-V-05 — Null vessel IMO · vessel name still written

```json
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": null },
  { "qualifier": "LABEL", "value": "[vessel.name]" }
]}]
```
**Assert:**
```
leg1VesselImoNumber = null           ✅
leg1VesselName      = [vessel.name]  ✅
tsp1Locode          = [tsp.unlocode] ✅  (locode/date unaffected)
actualArrivalTsp1   = toLocalTime(STAGE_DATES.actualArrivalTsp1, tsp.timezone)  ✅
```

---

### NEW-V-06 — Null vessel name · IMO still written

```json
"resources": [{ "qualifier": "milestoneVessel", "identifiers": [
  { "qualifier": "IMO",   "value": "[vessel.imo]" },
  { "qualifier": "LABEL", "value": null }
]}]
```
**Assert:**
```
leg1VesselImoNumber = [vessel.imo]  ✅
leg1VesselName      = null          ✅
```

---

### NEW-V-07 — Missing resources block · vessel null · locode + date still written

```json
// resources key absent entirely
```
**Assert:**
```
leg1VesselImoNumber = null                                                       ✅
leg1VesselName      = null                                                       ✅
tsp1Locode          = [tsp.unlocode]                                             ✅
actualArrivalTsp1   = toLocalTime(STAGE_DATES.actualArrivalTsp1, tsp.timezone)  ✅
```

---

## NEW — POSITIVE TESTS — Timezone Conversion

### NEW-TZ-01 — UTC → local time · port timezone applied correctly

**Setup:** `containerRef = generateContainerRef()`, `tsp = pick(TSP_LOCODES)`, `vessel = pick(VESSELS)`  
Pick any UTC date as input:
```js
// Pick any fixed UTC date — the point is verifying the conversion, not the date itself
const utcDate = stageDate(-12, 6);  // e.g. 06:00 UTC, 12 days ago
const expectedLocal = toLocalTime(utcDate, tsp.timezone);
```
**Payload changes:**
```json
"situation": { "event": "container_arrived", "date": "[utcDate]", "type": "actual" },
"situation_justification": { "data_source": null },
"event_site": { "unlocode": "[tsp.unlocode]", "timezone": "[tsp.timezone]", "place_type": "transhipment" }
```
**Assert:**
```
actualArrivalTsp1 = toLocalTime(utcDate, tsp.timezone)  ✅  (UTC converted to tsp port local time)
```
> e.g. tsp = SGSIN (Asia/Singapore UTC+8): `06:00 UTC` → `14:00 local`  
> e.g. tsp = AEJEA (Asia/Dubai UTC+4): `06:00 UTC` → `10:00 local`  
> e.g. tsp = NLRTM (Europe/Amsterdam UTC+1 winter): `06:00 UTC` → `07:00 local`

---

### NEW-TZ-02 — Later UTC date same port · local time recalculated correctly

**Setup:** Same `tsp` from NEW-TZ-01. Different UTC input date.
```js
const utcDate2 = stageDate(-10, 10);  // different date, same port
```
**Payload changes:**
```json
"situation": { "event": "container_arrived", "date": "[utcDate2]", "type": "actual" },
"event_site": { "unlocode": "[tsp.unlocode]", "timezone": "[tsp.timezone]", "place_type": "transhipment" }
```
**Assert:**
```
actualArrivalTsp1 = toLocalTime(utcDate2, tsp.timezone)  ✅
```

---

### NEW-TZ-03 — Two different ports · each uses its own timezone

**Setup:** `tsp1 = pick(TSP_LOCODES)`, `tsp2 = pick(TSP_LOCODES, excludeUnlocode: tsp1.unlocode)`, two containers
```js
const utcDate = stageDate(-10, 10);
```
Send same UTC date to two different containers at two different TSP ports.  
**Assert:**
```
Container 1: actualArrivalTsp1 = toLocalTime(utcDate, tsp1.timezone)  ✅
Container 2: actualArrivalTsp1 = toLocalTime(utcDate, tsp2.timezone)  ✅
```
> Proves each event's conversion uses ITS OWN port timezone, not a global default.

---

### NEW-TZ-04 — DST boundary · same port · summer vs winter date

**Setup:** `containerRef = generateContainerRef()`, `tsp = pick(TSP_LOCODES)` — pick a port in a DST-observing timezone (e.g. NLRTM = Europe/Amsterdam, DEHAM = Europe/Berlin)
```js
// Use fixed known-DST dates to make summer vs winter assertion deterministic
// These dates are intentionally fixed — DST is calendar-dependent
// June 15 = always summer (DST active in Europe) · January 15 = always winter (DST inactive)
const summerUtc = "2025-06-15T10:00:00+00:00";
const winterUtc = "2025-01-15T10:00:00+00:00";
```
Send two events at the same port — one summer date, one winter date.  
**Assert:**
```
summer event: actualArrivalTsp1 = toLocalTime(summerUtc, tsp.timezone)  ✅
winter event: actualArrivalTsp1 = toLocalTime(winterUtc, tsp.timezone)  ✅
```
> e.g. NLRTM (Amsterdam): summer = UTC+2 (+2h offset) · winter = UTC+1 (+1h offset)  
> Both must differ — confirms DST is applied correctly, not a fixed offset.

---

### NEW-TZ-05 — `datetime_timezone` never stored in BE

**Assert:**
```
datetime_timezone in BE response = not present / null  ✅
actualArrivalTsp1 = local time value                   ✅
```

---

### NEW-TZ-06 — All date fields in same payload converted using same timezone

Send `container_unloaded` which writes `actualDischargeTsp1`.  
**Assert:**
```
actualDischargeTsp1 = toLocalTime(STAGE_DATES.actualDischargeTsp1, tsp.timezone)  ✅
```
> Confirms conversion is not selective — every date field in the payload uses the same timezone.

---

## NEW — NEGATIVE TESTS

### NEW-N-01 — `place_type` not transhipment · TSP logic entirely skipped

```json
"event_site": { "unlocode": "SGSIN", "timezone": "Asia/Singapore", "place_type": "loading" }
```
**Assert:**
```
tsp1Locode        = null  ✅
actualArrivalTsp1 = null  ✅
leg1VesselImoNumber = null  ✅
```

---

### NEW-N-02 — `actual` with `data_source: "external"` → date NOT written

```json
"situation": { "event": "container_arrived", "type": "actual" },
"situation_justification": { "data_source": "external" }
```
**Assert:**
```
actualArrivalTsp1    = null  ✅  (actual requires data_source absent/null)
estimatedArrivalTsp1 = null  ✅
tsp1Locode           = [tsp.unlocode]  ✅  (locode still written)
```

---

### NEW-N-03 — `actual` with `data_source: "shippeo"` → date NOT written

```json
"situation_justification": { "data_source": "shippeo" }
```
**Assert:**
```
actualArrivalTsp1    = null  ✅
predictedArrivalTsp1 = null  ✅
tsp1Locode           = [tsp.unlocode]  ✅
```

---

### NEW-N-04 — `estimated` with `data_source` absent → date NOT written

```json
"situation": { "event": "container_arrived", "type": "estimated" },
"situation_justification": { "data_source": null }
```
**Assert:**
```
estimatedArrivalTsp1 = null  ✅
predictedArrivalTsp1 = null  ✅
actualArrivalTsp1    = null  ✅
tsp1Locode           = [tsp.unlocode]  ✅  (locode still written)
```

---

### NEW-N-05 — `estimated` with `data_source: "carrier"` → date NOT written

```json
"situation_justification": { "data_source": "carrier" }
```
**Assert:**
```
estimatedArrivalTsp1 = null  ✅
predictedArrivalTsp1 = null  ✅
```

---

### NEW-N-06 — All 4 slots full → 5th locode not written · error logged

Pre-fill all 4 `tspNLocode` with 4 different locodes.  
Send 5th event with new locode.  
**Assert:**
```
tsp1..tsp4Locode = original values unchanged  ✅
No 5th slot written                           ✅
Error logged: "TSP slots full"                ✅
```

---

### NEW-N-07 — `event_site.unlocode` null → no slot assigned · nothing written

```json
"event_site": { "unlocode": null, "timezone": "[tsp.timezone]", "place_type": "transhipment" }
```
**Assert:**
```
tsp1Locode        = null  ✅
actualArrivalTsp1 = null  ✅
```

---

### NEW-N-08 — `situation.date` null → date not written · locode still claimed

```json
"situation": { "event": "container_arrived", "date": null, "type": "actual" },
"situation_justification": { "data_source": null },
"event_site": { "unlocode": "[tsp.unlocode]", "timezone": "[tsp.timezone]", "place_type": "transhipment" }
```
**Assert:**
```
tsp1Locode        = [tsp.unlocode]  ✅  (slot claimed)
actualArrivalTsp1 = null            ✅  (null date not stored)
```

---

### NEW-N-09 — `event_site.timezone` missing → dates remain in UTC · error logged

**Setup:** `containerRef = generateContainerRef()`, `tsp = pick(TSP_LOCODES)`, `vessel = pick(VESSELS)`
```json
"event_site": { "unlocode": "[tsp.unlocode]", "place_type": "transhipment" }
// timezone key absent
```
**Assert:**
```
actualArrivalTsp1 = UTC value of situation.date (no conversion applied)  ✅
```

---

### NEW-N-10 — `event_site.timezone` null → dates remain in UTC · error logged

**Setup:** `containerRef = generateContainerRef()`, `tsp = pick(TSP_LOCODES)`, `vessel = pick(VESSELS)`
```json
"event_site": { "unlocode": "[tsp.unlocode]", "timezone": null, "place_type": "transhipment" }
```
**Assert:** `actualArrivalTsp1 = UTC value` ✅

---

### NEW-N-11 — `event_site.timezone` invalid string → dates remain in UTC · ValueError logged

**Setup:** `containerRef = generateContainerRef()`, `tsp = pick(TSP_LOCODES)`, `vessel = pick(VESSELS)`
```json
"event_site": { "unlocode": "[tsp.unlocode]", "timezone": "Mars/Olympus", "place_type": "transhipment" }
```
**Assert:** `actualArrivalTsp1 = UTC value` ✅

---

### NEW-N-12 — Expired webhook token → HTTP 401

**Assert HTTP:** `401` · OTU unchanged ✅

---

### NEW-N-13 — Tampered webhook token → HTTP 403

**Assert HTTP:** `403`

---

### NEW-N-14 — Empty request body → HTTP 400

**Assert HTTP:** `400`

---

### NEW-N-15 — Container not in Logward → HTTP 200 · no OTU mutated

```json
"order": { "reference": "[unknownRef]" },
"cargo": { "reference": "[unknownRef]", "qualifier": "CONTAINER" }
```
**Assert HTTP:** `200` · no OTU created ✅

---

## NEW — EDGE CASES

### NEW-E-01 — Same locode twice · later date wins

**Setup:** `containerRef = generateContainerRef()`, `tsp = pick(TSP_LOCODES)`, `vessel = pick(VESSELS)`

**Step 1:** `container_arrived` date = T1  
**Step 2:** Same locode, date = T2 (T2 > T1)  
**Assert:**
```
tsp1Locode        = [tsp.unlocode]                ✅  (reused)
tsp2Locode        = null                           ✅
actualArrivalTsp1 = toLocalTime(T2, tsp.timezone)  ✅  (later wins)
```

---

### NEW-E-02 — Same locode twice · earlier date does not overwrite

**Setup:** `containerRef = generateContainerRef()`, `tsp = pick(TSP_LOCODES)`, `vessel = pick(VESSELS)`

**Step 1:** date = T2 → stored  
**Step 2:** date = T1 (T1 < T2)  
**Assert:** `actualArrivalTsp1 = toLocalTime(T2, tsp.timezone)` ✅

---

### NEW-E-03 — `container_unloaded` same port twice · later date wins on `actualDischargeTsp1`

**Setup:** `containerRef = generateContainerRef()`, `tsp = pick(TSP_LOCODES)`, `vessel = pick(VESSELS)`

**Step 1:** `container_unloaded` actual at `[tsp.unlocode]`, date = T1 → `actualDischargeTsp1 = toLocalTime(T1, tsp.timezone)`  
**Step 2:** Same event, same locode, date = T2 (T2 > T1)  
**Assert:**
```
actualDischargeTsp1 = toLocalTime(T2, tsp.timezone)  ✅  (later wins)
tsp1Locode          = [tsp.unlocode]                  ✅  (reused — no new slot)
tsp2Locode          = null                            ✅
```

---

### NEW-E-04 — `container_loaded` same port twice · later date wins on `actualLoadTsp1`

**Setup:** `containerRef = generateContainerRef()`, `tsp = pick(TSP_LOCODES)`, `vessel = pick(VESSELS)`

**Step 1:** `container_loaded` actual at `[tsp.unlocode]`, date = T1 → `actualLoadTsp1 = toLocalTime(T1, tsp.timezone)`  
**Step 2:** Same event, same locode, date = T2 (T2 > T1)  
**Assert:**
```
actualLoadTsp1      = toLocalTime(T2, tsp.timezone)  ✅  (later wins)
tsp1Locode          = [tsp.unlocode]                  ✅
tsp2Locode          = null                            ✅
leg2VesselImoNumber = [vessel.imo]                    ✅  (INCREMENT → N+1=2, updated in place)
```

---

### NEW-E-05 — `container_departed` same port twice · later date wins on `actualDepartureTsp1`

**Setup:** `containerRef = generateContainerRef()`, `tsp = pick(TSP_LOCODES)`, `vessel = pick(VESSELS)`

**Step 1:** `container_departed` actual at `[tsp.unlocode]`, date = T1 → `actualDepartureTsp1 = toLocalTime(T1, tsp.timezone)`  
**Step 2:** Same event, same locode, date = T2 (T2 > T1)  
**Assert:**
```
actualDepartureTsp1 = toLocalTime(T2, tsp.timezone)  ✅  (later wins)
tsp1Locode          = [tsp.unlocode]                  ✅
tsp2Locode          = null                            ✅
leg2VesselImoNumber = [vessel.imo]                    ✅  (INCREMENT → N+1=2)
```

---

### NEW-E-06 — Different events at same port · each field updated independently · no cross-overwrite

**Setup:** `containerRef = generateContainerRef()`, `tsp = pick(TSP_LOCODES)`, `vessel = pick(VESSELS)`

Send all 4 event types at the same locode (slot 1 reused each time):

| Step | Event | data_source | Date | Field written |
|---|---|---|---|---|
| 1 | `container_arrived` | null | T1 | `actualArrivalTsp1` |
| 2 | `container_unloaded` | null | T2 | `actualDischargeTsp1` |
| 3 | `container_loaded` | null | T3 | `actualLoadTsp1` |
| 4 | `container_departed` | null | T4 | `actualDepartureTsp1` |

**Assert after all 4:**
```
actualArrivalTsp1   = toLocalTime(T1, tsp.timezone)  ✅  (not overwritten by unload/load/depart)
actualDischargeTsp1 = toLocalTime(T2, tsp.timezone)  ✅  (not overwritten by others)
actualLoadTsp1      = toLocalTime(T3, tsp.timezone)  ✅
actualDepartureTsp1 = toLocalTime(T4, tsp.timezone)  ✅
tsp1Locode          = [tsp.unlocode]                  ✅  (slot 1 reused all 4 times)
tsp2Locode          = null                            ✅  (no new slot claimed)
```

---

### NEW-E-07 — `estimatedArrivalTsp1` updated when same estimated event resent with later date

**Setup:** `containerRef = generateContainerRef()`, `tsp = pick(TSP_LOCODES)`, `vessel = pick(VESSELS)`

**Step 1:** `container_arrived` estimated external at `[tsp.unlocode]`, date = T1  
**Step 2:** Same event, same locode, same data_source, date = T2 (T2 > T1)  
**Assert:**
```
estimatedArrivalTsp1 = toLocalTime(T2, tsp.timezone)  ✅  (later wins)
actualArrivalTsp1    = null                            ✅  (actual not touched)
predictedArrivalTsp1 = null                            ✅
```

---

### NEW-E-08 — `predictedArrivalTsp1` updated when same predicted event resent with later date

**Setup:** `containerRef = generateContainerRef()`, `tsp = pick(TSP_LOCODES)`, `vessel = pick(VESSELS)`

**Step 1:** `container_arrived` estimated shippeo at `[tsp.unlocode]`, date = T1  
**Step 2:** Same event, same locode, same data_source, date = T2 (T2 > T1)  
**Assert:**
```
predictedArrivalTsp1 = toLocalTime(T2, tsp.timezone)  ✅  (later wins)
estimatedArrivalTsp1 = null                            ✅  (estimated not touched)
actualArrivalTsp1    = null                            ✅
```

---

### NEW-E-09 — Estimated then actual at same port · both fields written independently · neither overwrites the other

**Setup:** `containerRef = generateContainerRef()`, `tsp = pick(TSP_LOCODES)`, `vessel = pick(VESSELS)`

**Step 1:** `container_arrived` estimated external, date = T1 → `estimatedArrivalTsp1 = T1`  
**Step 2:** `container_arrived` actual, date = T2 → `actualArrivalTsp1 = T2`  
**Assert:**
```
estimatedArrivalTsp1 = toLocalTime(T1, tsp.timezone)  ✅  (NOT overwritten by actual)
actualArrivalTsp1    = toLocalTime(T2, tsp.timezone)  ✅
predictedArrivalTsp1 = null                            ✅
tsp1Locode           = [tsp.unlocode]                  ✅  (slot 1 reused both times)
tsp2Locode           = null                            ✅
```

---

### NEW-E-10 — Slot 1 and slot 2 fully independent · updating one does not touch other

**Step 1:** `container_arrived` at `tsp1` → `actualArrivalTsp1 = T1`  
**Step 2:** `container_arrived` at `tsp2` → `actualArrivalTsp2 = T2`  
**Assert:**
```
actualArrivalTsp1 = toLocalTime(T1, tsp1.timezone)  ✅  (unchanged)
actualArrivalTsp2 = toLocalTime(T2, tsp2.timezone)  ✅
tsp1Locode = [tsp1.unlocode]  ✅
tsp2Locode = [tsp2.unlocode]  ✅
```

---

### NEW-E-11 — Out-of-order · slot assigned by system arrival order, not physical journey order

**Setup:** `containerRef = generateContainerRef()`, `tsp1 = pick(TSP_LOCODES)`, `tsp2 = pick(TSP_LOCODES, excludeUnlocode: tsp1.unlocode)`, `vessel = pick(VESSELS)`

Fresh OTU. Send `tsp2.unlocode` event BEFORE any `tsp1.unlocode` event.  
**Assert:**
```
tsp1Locode = [tsp2.unlocode]  ✅  (Pass 2: first empty slot = 1, regardless of physical order)
tsp2Locode = null             ✅
```

---

### NEW-E-12 — Non-TSP event does not consume TSP slot

**Setup:** `containerRef = generateContainerRef()`, `tsp = pick(TSP_LOCODES)`, `vessel = pick(VESSELS)`

Send `container_arrived` with `place_type: "discharge"`.  
**Assert:**
```
tsp1Locode        = null  ✅
actualArrivalTsp1 = null  ✅
```

---

### NEW-E-13 — Timezone change between two events · each uses its own timezone

Two sends at same locode (slot 1 reused):

**Step 1:** `timezone: "Asia/Singapore"`, UTC `06:00` → stored `14:00`, date = T1  
**Step 2:** Same locode, `timezone: "America/Guayaquil"`, UTC `14:00` → stored `09:00`, date = T2 (T2 > T1)  
**Assert:**
```
actualArrivalTsp1 = "...<date2> 09:00:00"  ✅  (later date wins, converted with Step 2 timezone)
```

---

### NEW-E-14 — Vessel substitution at same port · updates in place · no false leg (new flow fix)

**Setup:** `tsp` in slot 1, `vessel1 = pick(VESSELS)`, `vessel2 = pickVessel(excludeImo: vessel1.imo)`

**Step 1 — original vessel arrives:**
```json
"situation": { "event": "container_arrived", "type": "actual" },
"situation_justification": { "data_source": null },
"resources": [vessel1]
```
**Assert:** `leg1VesselImoNumber = vessel1.imo` ✅ · `leg2VesselImoNumber = null` ✅

**Step 2 — vessel substituted, same port:**
```json
"situation": { "event": "container_loaded", "type": "actual" },
"situation_justification": { "data_source": null },
"resources": [vessel2]
```
**Assert:**
```
tsp1Locode          = [tsp.unlocode]   ✅  (same port → Pass 1 → slot 1 reused)
leg2VesselImoNumber = [vessel2.imo]    ✅  (INCREMENT → N+1=2, correct next leg vessel)
leg2VesselName      = [vessel2.name]   ✅
leg3VesselImoNumber = null             ✅  (NO false new leg — confirms new flow fix)
leg1VesselImoNumber = [vessel1.imo]    ✅  (slot 1 vessel preserved from arrived event)
actualLoadTsp1      = toLocalTime(STAGE_DATES.actualLoadTsp1, tsp.timezone)  ✅
```

---

## NEW — OLD FLOW CONTAMINATION TESTS

> These tests confirm old flow logic **never** runs on new flow containers.

### NEW-X-01 — Vessel substitution on new flow container does NOT create false leg (old flow would)

Already covered in NEW-E-07. This is the primary contamination check.

---

### NEW-X-02 — New flow container · vessel slot key is locode NOT vessel · different vessel same port reuses slot

**Setup:** `tsp` in slot 1, `vessel1 = pick(VESSELS)`, `vessel2 = pickVessel(excludeImo: vessel1.imo)`

Send `container_arrived` with `vessel1` → slot 1 claimed by locode.  
Send `container_arrived` again at same locode with `vessel2`.  
**Assert:**
```
tsp1Locode          = [tsp.unlocode]   ✅  (locode is the key — slot reused)
tsp2Locode          = null             ✅  (vessel change does NOT claim new slot — no duplicate locode)
leg1VesselImoNumber = [vessel2.imo]    ✅  (vessel updated in place)
```
> **Key difference from old flow:** In old flow, vessel2 would trigger Pass 2 → `tsp2Locode = [tsp.unlocode]` (duplicate).  
> In new flow, locode match in Pass 1 prevents any new slot being claimed — `tsp2Locode` stays null.

---

### NEW-X-03 — New flow container · `container_loaded` writes vessel at N+1 (old flow would write at N)

**Setup:** `tsp` in slot 1, `vessel = pick(VESSELS)`

Send `container_loaded` actual.  
**Assert:**
```
leg2VesselImoNumber = [vessel.imo]   ✅  (N+1=2 — new flow INCREMENT logic)
leg1VesselImoNumber = null           ✅  (old flow would have written here — confirms NOT happening)
```

---

### NEW-X-04 — New flow container · `container_departed` writes vessel at N+1 (old flow would write at N)

Send `container_departed` actual.  
**Assert:**
```
leg2VesselImoNumber = [vessel.imo]   ✅  (N+1=2)
leg1VesselImoNumber = null           ✅  (old flow would have written here)
```

---

## ⚠️ KNOWN BUG

### TSP-BUG-01 — Multi-slot: second locode should claim slot 2 but does not

**Status:** Known bug — test written to confirm when fixed.

**Steps:**
1. `container_arrived` actual at `SGSIN` → `tsp1Locode = SGSIN` ✅
2. `container_arrived` actual at `MYPKG` → expected `tsp2Locode = MYPKG`

**Expected (after fix):**
```
tsp1Locode        = [tsp1.unlocode]  ✅
tsp2Locode        = [tsp2.unlocode]  ✅
actualArrivalTsp1 = <date1>  ✅
actualArrivalTsp2 = <date2>  ✅
```

**Current (known bug):**
```
tsp1Locode        = [tsp1.unlocode]  ✅
tsp2Locode        = null     ❌
actualArrivalTsp1 = <date2>  ❌  (overwritten)
actualArrivalTsp2 = null     ❌
```

---

## ══════════════════════════════════════════
## SECTION 2 — OLD FLOW TESTS
## ══════════════════════════════════════════

> Old flow uses vessel IMO/name as the slot key. Same field names as new flow. No N+1 logic.

---

## OLD — ROUTING

### OLD-R-01 — Legacy container → old flow · vessel-based slot · no N+1

**Setup:** `vessel = pick(VESSELS)`, `tsp = pick(TSP_LOCODES)`
**Payload changes:**
```json
"order": { "reference": "MSCU1234567" },
"cargo": { "reference": "MSCU1234567", "qualifier": "CONTAINER" },
"situation": { "event": "container_arrived", "type": "actual" },
"situation_justification": { "data_source": null },
"event_site": { "unlocode": "[tsp.unlocode]", "timezone": "[tsp.timezone]", "place_type": "transhipment" }
```
**Assert:**
```
tsp1Locode          = [tsp.unlocode]                                             ✅  (locode written — same as new flow)
actualArrivalTsp1   = toLocalTime(STAGE_DATES.actualArrivalTsp1, tsp.timezone)  ✅
leg1VesselImoNumber = [vessel.imo]                                               ✅  (vessel at N=1)
leg1VesselName      = [vessel.name]                                              ✅
leg2VesselImoNumber = null                                                       ✅  (N+1 NOT applied — old flow)
```

---

## OLD — POSITIVE TESTS

### OLD-P-01 — Same vessel again → reuses leg1 slot (Pass 1 match) · tspNLocode also written

**Setup:** `vessel` already in `leg1VesselName`, `tsp = pick(TSP_LOCODES)`.
**Payload changes:**
```json
"situation": { "event": "container_unloaded", "type": "actual" },
"situation_justification": { "data_source": null }
```
**Assert:**
```
leg1VesselName      = [vessel.name]   ✅  (Pass 1: reused — same slot)
leg2VesselName      = null            ✅  (no new slot)
tsp1Locode          = [tsp.unlocode]  ✅  (locode written at slot N=1)
tsp2Locode          = null            ✅  (no duplicate)
```

---

### OLD-P-02 — `container_loaded` · vessel at N (NO N+1 in old flow)

**Payload changes:**
```json
"situation": { "event": "container_loaded", "type": "actual" },
"situation_justification": { "data_source": null }
```
**Assert:**
```
leg1VesselImoNumber = [vessel.imo]   ✅  (old flow — vessel at N, not N+1)
leg2VesselImoNumber = null           ✅  (N+1 NOT applied)
```

---

### OLD-P-03 — `container_departed` · vessel at N (NO N+1 in old flow)

**Payload changes:**
```json
"situation": { "event": "container_departed", "type": "actual" },
"situation_justification": { "data_source": null }
```
**Assert:**
```
leg1VesselImoNumber = [vessel.imo]   ✅  (old flow — N, not N+1)
leg2VesselImoNumber = null           ✅
```

---

## OLD — BUG SCENARIO

### OLD-BUG-01 — Vessel substitution creates false leg (documents known broken behaviour)

**Setup:** `vessel1 = pick(VESSELS)`, `vessel2 = pickVessel(excludeImo: vessel1.imo)`, `tsp = pick(TSP_LOCODES)`

**Step 1 — original vessel:**
```json
"situation": { "event": "container_arrived", "type": "actual" },
"situation_justification": { "data_source": null },
"resources": [vessel1]
```
**Assert:** `leg1VesselName = vessel1.name` ✅ · `leg2VesselName = null` ✅

**Step 2 — vessel substituted, same port:**
```json
"situation": { "event": "container_loaded", "type": "actual" },
"situation_justification": { "data_source": null },
"resources": [vessel2]
```
**Assert — OLD FLOW BROKEN BEHAVIOUR:**
```
leg1VesselName = [vessel1.name]  ✅  (original vessel — unchanged)
leg2VesselName = [vessel2.name]  ✅  (new vessel → Pass 2 claimed leg2 — false extra leg)
tsp1Locode     = [tsp.unlocode]  ✅  (slot 1 locode set from Step 1)
tsp2Locode     = [tsp.unlocode]  ✅  (slot 2 locode = SAME locode as slot 1 — DUPLICATE)
```
> **The real bug:** Same port locode now appears in BOTH `tsp1Locode` AND `tsp2Locode`.  
> Old flow treated the vessel change as a new TSP stop — same port got two slots.  
> This test **passes** when old flow behaves as broken. Baseline for comparison with NEW-E-07.

---

## OLD — NEGATIVE TESTS

### OLD-N-01 — `place_type` not transhipment → no slot written

```json
"event_site": { "place_type": "loading" }
```
**Assert:** `leg1VesselName = null` ✅ · `tsp1Locode = null` ✅

---

### OLD-N-02 — All 4 leg slots full → 5th vessel not written

Pre-fill all 4 `legNVesselName`. Send 5th with new vessel.  
**Assert:** `leg1..leg4VesselName = original values` ✅ · no leg5 ✅

---

### OLD-N-03 — Expired token → HTTP 401

**Assert HTTP:** `401` ✅

---

### OLD-N-04 — Empty body → HTTP 400

**Assert HTTP:** `400` ✅

---

## Summary

| Group | IDs | Count | Coverage |
|---|---|---|---|
| **NEW FLOW** | | | |
| Routing | NEW-R-01 to NEW-R-02 | 2 | New flow populated · old flow not contaminated |
| Positive — Slot (all 4 events actual) | NEW-P-01 to NEW-P-08 | 8 | arrived/unloaded/loaded/departed · REUSE + CLAIM · all 4 slots |
| Positive — Estimated & Predicted | NEW-P-09 to NEW-P-18 | 10 | All 4 events × estimated-external + predicted-shippeo · all 3 types coexist · slot 2 |
| Positive — Vessel | NEW-V-01 to NEW-V-07 | 7 | Slot 2 journey · slot 4 N+1 out-of-range · vessel update in place · null IMO · null name · missing resources |
| Positive — Timezone | NEW-TZ-01 to NEW-TZ-06 | 6 | UTC→local (3 zones) · DST boundary · datetime_timezone dropped · all fields converted |
| Negative | NEW-N-01 to NEW-N-15 | 15 | Wrong place_type · actual+external not written · actual+shippeo not written · estimated+null not written · estimated+carrier not written · slots full · null unlocode · null date · missing/null/invalid timezone · auth · empty body · missing container |
| Edge Cases | NEW-E-01 to NEW-E-14 | 14 | Date conflict (all 4 events) · estimated + predicted updates · field independence (different events same port) · slot independence · out-of-order · non-TSP event · timezone per event · vessel substitution fix |
| Old Flow Contamination | NEW-X-01 to NEW-X-04 | 4 | Vessel substitution no false leg · locode not vessel as key · loaded N+1 not N · departed N+1 not N |
| Known Bug | TSP-BUG-01 | 1 | Multi-slot second locode |
| **OLD FLOW** | | | |
| Routing | OLD-R-01 | 1 | Legacy container → old flow · vessel at N |
| Positive | OLD-P-01 to OLD-P-03 | 3 | REUSE · container_loaded at N · container_departed at N |
| Bug scenario | OLD-BUG-01 | 1 | Vessel substitution creates false leg (baseline) |
| Negative | OLD-N-01 to OLD-N-04 | 4 | Wrong place_type · slots full · auth · empty body |
| **Total** | | **76** | |

---

## Pass / Fail Checklist

| # | Check | Flow | Pass | Fail |
|---|---|---|---|---|
| 1 | Non-legacy container → new flow fields populated | New | `tsp1Locode` set | Empty |
| 2 | Legacy container → old flow · N+1 NOT applied | Old | `leg2VesselImoNumber` null | `leg2VesselImoNumber` set |
| 3 | actual + data_source null → date written | New | `actualArrivalTsp1` set | Empty |
| 4 | actual + data_source external → date NOT written | New | `actualArrivalTsp1` null | Written |
| 5 | actual + data_source shippeo → date NOT written | New | `actualArrivalTsp1` null | Written |
| 6 | estimated + external → estimatedXxx written | New | `estimatedArrivalTsp1` set | Empty |
| 7 | estimated + shippeo → predictedXxx written | New | `predictedArrivalTsp1` set | Empty |
| 8 | estimated + null → nothing written | New | All null | Any written |
| 9 | NON-INCREMENT → vessel at N | New | `leg1Vessel*` set · `leg2Vessel*` null | Wrong slot |
| 10 | INCREMENT → vessel at N+1 | New | `leg2Vessel*` set · `leg1Vessel*` null | Wrong slot |
| 11 | Slot 4 INCREMENT → N+1=5 graceful skip | New | No crash · `actualDepartureTsp4` written | Crash or leg5 set |
| 12 | UTC → local time stored | New | Local time in BE | UTC stored |
| 13 | `datetime_timezone` not in BE | New | Field absent | Field present |
| 14 | DST handled correctly | New | Winter ≠ summer offset | Same offset year-round |
| 15 | Vessel substitution new flow → no false leg | New | `leg3VesselImoNumber` null | `leg3` set |
| 16 | Vessel substitution old flow → false leg + DUPLICATE locode | Old | `leg2VesselName` set AND `tsp1Locode = tsp2Locode` (same port in both slots) | `leg1VesselName` updated |
| 17 | Same locode reuses slot · no duplicate | New | `tsp2Locode` null | `tsp2Locode` = same locode (duplicate) |
| 18 | New flow vessel substitution · tsp2Locode null (not duplicate) | New | `tsp2Locode` null | `tsp2Locode` = same locode as tsp1 |
| 19 | Same event resent at same port · later date wins | New | Updated date stored | Original kept or null |
| 20 | Different events at same port · each field independent | New | All 4 date fields populated correctly | One event overwrites another |
| 18 | Different locode → next slot ⚠️ KNOWN BUG | New | `tsp2Locode = MYPKG` | Empty (current) |

---

*Source: `QA_Ocean_Routing_Complete.docx` | Branch DP-449 | Logward QA | 2026-06-13*
