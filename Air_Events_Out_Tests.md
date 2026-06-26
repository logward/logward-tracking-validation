# Air Tracking — Events-Out Field Mapping Tests (V3)
**File:** `E2E_Air.spec.js`
**Source:** `Air_Events_Out_TestCases.csv` + `Air_Events_Mapping_Structured_v3.csv` + `air_tracking_qa_guide.docx`
**Updated:** 2026-06-13

---

## Core Rules (V3)

```
IDENTIFIER (single field, 1 API call):
  clientReference = order.client_reference
  BE OR filter: masterAirWaybillNumber | houseAirWaybillNumber | airCustomerReference = clientReference
  No match → HTTP 200, silent drop

ALWAYS-ON (every event):
  situationEvent, situationDate, situationInputDate
  orderReference, orderUrl, consignmentReference

TYPE 2 — Exact match → date only (+ SC/JC for compliant events)
TYPE 3 — Starts-with → date + justification suffix only
TYPE 4 — Hub OR + slot → arrived: date + 6 hub site fields · left: date only
TYPE 5 — Routing (manifested/eta_event/received_from_flight) → IATA compare → loading/delivery/hub date only

HUB SLOT ASSIGNMENT:
  Pass 1 — scan hubSiteIata_stop1..4 for IATA+country match → reuse that stop
  Pass 2 — first empty stop → claim it, write date + 6 hub site fields
  T5 CAN also create a slot if no prior T4 event (writes date + 6 hub site fields)
  Max 4 stops — 5th unique IATA → silent drop

NOT MAPPED (red):
  loadingBookedDate, deliveryBookedDate, hubBookedDate_stop1..4 → booked event dropped entirely
  All per-event site fields for loading/delivery events (V3 removes these)
  organizationId/Name, agencyId/Name, dateTransmission, justificationCode, situationCode, tags
```

---

## Data Pools & Helpers

```js
// Single identifier field — V3
function generateClientRef() {
  return `${Math.floor(Math.random()*900+100)}-${Math.floor(Math.random()*90000000+10000000)}`;
}

const LOADING_IATA  = [
  { iata: "BLR", country: "IN" }, { iata: "DEL", country: "IN" },
  { iata: "BOM", country: "IN" }, { iata: "MAA", country: "IN" },
  { iata: "HYD", country: "IN" },
];
const DELIVERY_IATA = [
  { iata: "BHM", country: "US" }, { iata: "JFK", country: "US" },
  { iata: "LAX", country: "US" }, { iata: "LHR", country: "GB" },
  { iata: "FRA", country: "DE" },
];
const HUB_IATA = [
  { iata: "DXB", country: "AE", city: "Dubai",     description: "Dubai Intl Airport",  address: "Dubai Airport Rd", zip: "00000" },
  { iata: "DOH", country: "QA", city: "Doha",      description: "Hamad Intl Airport",  address: "Airport Rd",       zip: "22222" },
  { iata: "SIN", country: "SG", city: "Singapore", description: "Changi Airport",      address: "Airport Blvd",     zip: "819643" },
  { iata: "AMS", country: "NL", city: "Amsterdam", description: "Schiphol Airport",    address: "Evert van de Beekstraat", zip: "1118CP" },
  { iata: "CDG", country: "FR", city: "Paris",     description: "Charles de Gaulle",   address: "BP 20101",         zip: "95711" },
];

const STAGE_DATES = {
  manifested:             stageDate(-9,  10),
  receivedFromShipper:    stageDate(-8,  14),
  loadingArrived:         stageDate(-7,  6),
  loadingCompliant:       stageDate(-7,  22),
  loadingLeft:            stageDate(-6,  4),
  hub1Arrived:            stageDate(-5,  10),
  hub1Left:               stageDate(-5,  18),
  hub2Arrived:            stageDate(-4,  8),
  hub2Left:               stageDate(-4,  16),
  eta:                    stageDate(2,   8),
  deliveryArrived:        stageDate(3,   6),
  deliveryCompliant:      stageDate(3,   14),
  deliveryLeft:           stageDate(4,   8),
  documentationDelivered: stageDate(5,   10),
  consigneeNotified:      stageDate(5,   12),
};

function stageDate(daysFromToday, hours = 8) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  d.setUTCHours(hours, 0, 0, 0);
  return d.toISOString();
}

function pick(pool) {
  return pool[Math.floor(Math.random() * pool.length)];
}
```

---

## Canonical Base Payload

```json
{
  "order": {
    "edi_reference":    "[clientRef]",
    "reference":        "[clientRef]",
    "url":              "https://view.shippeo.com/orderPublic/test",
    "client_reference": "[clientRef]"
  },
  "situation": {
    "event":              "[event]",
    "situation_code":     null,
    "justification_code": null,
    "date":               "[STAGE_DATES.xxx]",
    "input_date":         "[STAGE_DATES.xxx]"
  },
  "situation_justification": {
    "attributes": { "consignmentReference": "CSN-001" }
  },
  "loading_site":  { "iata_code": "[loadIata.iata]", "country": "[loadIata.country]" },
  "delivery_site": { "iata_code": "[delIata.iata]",  "country": "[delIata.country]"  },
  "event_site": {
    "iata_code": "[iata]",
    "country":   "[country]",
    "description":  "Test Airport",
    "address_line": "1 Airport Road",
    "city":         "Test City",
    "zipcode":      "10001"
  }
}
```

---

## ══════════════════════════════════
## LOADING SITE TESTS
## ══════════════════════════════════

## LS — POSITIVE

### LS-P-01 — `received_from_shipper` → `receivedFromShipperDate`

**Setup:** `clientRef = generateClientRef()`, `loadIata = pick(LOADING_IATA)`, `delIata = pick(DELIVERY_IATA)`

**Payload changes:**
```json
"situation": { "event": "received_from_shipper", "date": "[STAGE_DATES.receivedFromShipper]" },
"event_site": { "iata_code": "[loadIata.iata]", "country": "[loadIata.country]" }
```
**Assert:**
```
receivedFromShipperDate = [STAGE_DATES.receivedFromShipper]  ✅
situationEvent          = "received_from_shipper"            ✅  (always-on)
situationDate           = [STAGE_DATES.receivedFromShipper]  ✅  (always-on)
orderReference          = [clientRef]                        ✅  (always-on)
```

---

### LS-P-02 — `goods_arrived_at_loading_arrived` → `loadingArrivedDate`

**Payload changes:**
```json
"situation": { "event": "goods_arrived_at_loading_arrived", "date": "[STAGE_DATES.loadingArrived]" },
"event_site": { "iata_code": "[loadIata.iata]", "country": "[loadIata.country]" }
```
**Assert:**
```
loadingArrivedDate = [STAGE_DATES.loadingArrived]  ✅
```

---

### LS-P-03 — `goods_loading_compliant_compliant` → `loadingCompliantDate` + `situationCode` + `justificationCode`

**Payload changes:**
```json
"situation": {
  "event": "goods_loading_compliant_compliant",
  "date":  "[STAGE_DATES.loadingCompliant]",
  "situation_code":     "OK",
  "justification_code": "CFM"
}
```
**Assert:**
```
loadingCompliantDate              = [STAGE_DATES.loadingCompliant]  ✅
loadingCompliantSituationCode     = "OK"                            ✅
loadingCompliantJustificationCode = "CFM"                           ✅
```

---

### LS-P-04 — `goods_left_loading_left` → `loadingLeftDate`

**Payload changes:**
```json
"situation": { "event": "goods_left_loading_left", "date": "[STAGE_DATES.loadingLeft]" }
```
**Assert:**
```
loadingLeftDate = [STAGE_DATES.loadingLeft]  ✅
```

---

### LS-P-05 — `goods_loading_non_compliant_damaged` → `loadingNonCompliantDate` + justification = "damaged"

**Payload changes:**
```json
"situation": { "event": "goods_loading_non_compliant_damaged", "date": "[STAGE_DATES.loadingLeft]" }
```
**Assert:**
```
loadingNonCompliantDate          = [STAGE_DATES.loadingLeft]  ✅
loadingNonCompliantJustification = "damaged"                   ✅
```

---

### LS-P-06 — `goods_loading_non_realised_cancelled` → `loadingNonRealisedDate` + justification = "cancelled"

**Assert:**
```
loadingNonRealisedDate          = [date]       ✅
loadingNonRealisedJustification = "cancelled"  ✅
```

---

### LS-P-07 — `goods_loading_refused_oversize` → `loadingRefusedDate` + justification = "oversize"

**Assert:**
```
loadingRefusedDate          = [date]      ✅
loadingRefusedJustification = "oversize"  ✅
```

---

### LS-P-08 — `manifested` · event_site = loading IATA → `loadingManifestedDate`

**Setup:** ATU `loadingSiteIata = loadIata.iata`, `loadingSiteCountry = loadIata.country`

**Payload changes:**
```json
"situation": { "event": "manifested", "date": "[STAGE_DATES.manifested]" },
"event_site": { "iata_code": "[loadIata.iata]", "country": "[loadIata.country]" }
```
**IATA check:** `event_site.iata_code == loadingSiteIata AND event_site.country == loadingSiteCountry` → **loading**

**Assert:**
```
loadingManifestedDate  = [STAGE_DATES.manifested]  ✅
deliveryManifestedDate = null                       ✅
```

---

### LS-P-09 — `eta_event` · event_site = loading IATA → `loadingETADate`

**Assert:**
```
loadingETADate  = [STAGE_DATES.eta]  ✅
deliveryETADate = null               ✅
```

---

### LS-P-10 — `received_from_flight` · event_site = loading IATA → `loadingReceivedFromFlightDate`

**Assert:**
```
loadingReceivedFromFlightDate  = [date]  ✅
deliveryReceivedFromFlightDate = null    ✅
```

---

## LS — NEGATIVE

### LS-N-01 — `manifested` · event_site = unknown IATA · no field written

```json
"event_site": { "iata_code": "XYZ", "country": "XX" }
```
**Assert:**
```
loadingManifestedDate  = null  ✅  (no match — unknown IATA)
deliveryManifestedDate = null  ✅
```

---

### LS-N-02 — Unknown event name → ATU unchanged

```json
"situation": { "event": "goods_loading_invalid_event" }
```
**Assert:** ATU `lastChangedAt` unchanged ✅

---

### LS-N-03 — Wrong `order.client_reference` → no ATU matched

```json
"order": { "client_reference": "WRONG-REF-999" }
```
**Assert:** `receivedFromShipperDate` unchanged ✅

---

### LS-N-04 — Missing Authorization header → HTTP 401

**Assert HTTP:** `401` · ATU unchanged ✅

---

### LS-N-05 — Invalid Bearer token → HTTP 401

**Assert HTTP:** `401`

---

## LS — EDGE CASES

### LS-E-01 — `received_from_shipper` sent twice · later date overwrites

**Step 1:** `receivedFromShipperDate = T1`
**Step 2:** Same event, date = T2 (T2 > T1)
**Assert:** `receivedFromShipperDate = T2` ✅

---

### LS-E-02 — Type 3 suffix changes on second send · both date and justification updated

**Step 1:** `goods_loading_non_compliant_damaged` → justification = "damaged"
**Step 2:** `goods_loading_non_compliant_oversize` → justification = "oversize"
**Assert:**
```
loadingNonCompliantJustification = "oversize"  ✅  (updated)
loadingNonCompliantDate          = [T2 date]   ✅  (updated)
```

---

### LS-E-03 — `goods_loading_compliant_compliant` with null situation_code and justification_code

```json
"situation": { "event": "goods_loading_compliant_compliant", "situation_code": null, "justification_code": null }
```
**Assert:**
```
loadingCompliantDate              = [date]  ✅
loadingCompliantSituationCode     = null    ✅
loadingCompliantJustificationCode = null    ✅
```

---

## ══════════════════════════════════
## DELIVERY SITE TESTS
## ══════════════════════════════════

## DS — POSITIVE

### DS-P-01 — `goods_arrived_at_delivery_arrived` → `deliveryArrivedDate`

**Setup:** `clientRef = generateClientRef()`, `loadIata = pick(LOADING_IATA)`, `delIata = pick(DELIVERY_IATA)`

**Payload changes:**
```json
"situation": { "event": "goods_arrived_at_delivery_arrived", "date": "[STAGE_DATES.deliveryArrived]" },
"event_site": { "iata_code": "[delIata.iata]", "country": "[delIata.country]" }
```
**Assert:**
```
deliveryArrivedDate = [STAGE_DATES.deliveryArrived]  ✅
```

---

### DS-P-02 — `goods_left_delivery_left` → `deliveryLeftDate`

**Assert:**
```
deliveryLeftDate = [STAGE_DATES.deliveryLeft]  ✅
```

---

### DS-P-03 — `goods_delivery_compliant_compliant` → date + SC + JC + `orderReference` + `orderUrl`

**Payload changes:**
```json
"situation": {
  "event": "goods_delivery_compliant_compliant",
  "date":  "[STAGE_DATES.deliveryCompliant]",
  "situation_code":     "LIV",
  "justification_code": "CFM"
},
"order": { "reference": "[clientRef]-REF", "url": "https://view.shippeo.com/test", "client_reference": "[clientRef]" }
```
**Assert:**
```
deliveryCompliantDate              = [STAGE_DATES.deliveryCompliant]  ✅
deliveryCompliantSituationCode     = "LIV"                            ✅
deliveryCompliantJustificationCode = "CFM"                            ✅
orderReference                     = "[clientRef]-REF"                ✅
orderUrl                           = "https://view.shippeo.com/test"  ✅
```

---

### DS-P-04 — `documentation_delivered` → `documentationDeliveredDate`

**Assert:**
```
documentationDeliveredDate = [STAGE_DATES.documentationDelivered]  ✅
```

---

### DS-P-05 — `consignee_notified` → `consigneeNotifiedDate`

**Assert:**
```
consigneeNotifiedDate = [STAGE_DATES.consigneeNotified]  ✅
```

---

### DS-P-06 — `goods_delivery_non_compliant_pilferage` → date + justification = "pilferage"

**Assert:**
```
deliveryNonCompliantDate          = [date]       ✅
deliveryNonCompliantJustification = "pilferage"  ✅
```

---

### DS-P-07 — `goods_delivery_non_realised_recipient_closed` → justification = "recipient_closed"

**Assert:**
```
deliveryNonRealisedDate          = [date]             ✅
deliveryNonRealisedJustification = "recipient_closed" ✅
```

---

### DS-P-08 — `goods_delivery_refused_not_ordered` → justification = "not_ordered"

**Assert:**
```
deliveryRefusedDate          = [date]         ✅
deliveryRefusedJustification = "not_ordered"  ✅
```

---

### DS-P-09 — `manifested` · event_site = delivery IATA → `deliveryManifestedDate`

**IATA check:** `event_site.iata_code == deliverySiteIata AND country == deliverySiteCountry` → **delivery**

**Assert:**
```
deliveryManifestedDate = [STAGE_DATES.manifested]  ✅
loadingManifestedDate  = null                      ✅
```

---

### DS-P-10 — `eta_event` · event_site = delivery IATA → `deliveryETADate`

**Assert:**
```
deliveryETADate = [STAGE_DATES.eta]  ✅
loadingETADate  = null               ✅
```

---

### DS-P-11 — `received_from_flight` · event_site = delivery IATA → `deliveryReceivedFromFlightDate`

**Assert:**
```
deliveryReceivedFromFlightDate = [date]  ✅
loadingReceivedFromFlightDate  = null   ✅
```

---

## DS — NEGATIVE

### DS-N-01 — `manifested` · event_site = unknown IATA → no field written

```json
"event_site": { "iata_code": "XYZ", "country": "XX" }
```
**Assert:** `deliveryManifestedDate = null` ✅

---

### DS-N-02 — Unknown event name → ATU unchanged

**Assert:** ATU `lastChangedAt` unchanged ✅

---

### DS-N-03 — Wrong `order.client_reference` → no ATU matched

**Assert:** `deliveryArrivedDate` unchanged ✅

---

### DS-N-04 — Missing Authorization header → HTTP 401

**Assert HTTP:** `401` ✅

---

### DS-N-05 — Invalid Bearer token → HTTP 401

**Assert HTTP:** `401`

---

## DS — EDGE CASES

### DS-E-01 — `goods_arrived_at_delivery_arrived` sent twice · later date overwrites

**Assert:** `deliveryArrivedDate = T2` ✅

---

### DS-E-02 — Type 3 suffix changes on second send · both updated

**Step 1:** `goods_delivery_non_compliant_pilferage` → justification = "pilferage"
**Step 2:** `goods_delivery_non_compliant_theft` → justification = "theft"
**Assert:**
```
deliveryNonCompliantJustification = "theft"   ✅
deliveryNonCompliantDate          = [T2 date] ✅
```

---

### DS-E-03 — `goods_delivery_compliant_compliant` with null SC and JC

**Assert:**
```
deliveryCompliantDate              = [date]  ✅
deliveryCompliantSituationCode     = null    ✅
deliveryCompliantJustificationCode = null    ✅
```

---

## ══════════════════════════════════
## HUB EVENTS TESTS
## ══════════════════════════════════

## HUB — POSITIVE

### HUB-P-01 — `goods_arrived_at_hub_arrived` · stop1 claimed · 7 fields written

**Setup:** `clientRef = generateClientRef()`, `loadIata = pick(LOADING_IATA)`, `delIata = pick(DELIVERY_IATA)`, `hub1 = pick(HUB_IATA)`. Fresh ATU.

**Payload changes:**
```json
"situation": { "event": "goods_arrived_at_hub_arrived", "date": "[STAGE_DATES.hub1Arrived]" },
"event_site": {
  "iata_code":    "[hub1.iata]",
  "country":      "[hub1.country]",
  "description":  "[hub1.description]",
  "address_line": "[hub1.address]",
  "city":         "[hub1.city]",
  "zipcode":      "[hub1.zip]"
}
```
**Assert:**
```
hubArrivedDate_stop1     = [STAGE_DATES.hub1Arrived]  ✅
hubSiteIata_stop1        = [hub1.iata]                ✅
hubSiteDescription_stop1 = [hub1.description]         ✅
hubSiteAddressLine_stop1 = [hub1.address]             ✅
hubSiteCity_stop1        = [hub1.city]                ✅
hubSiteZipcode_stop1     = [hub1.zip]                 ✅
hubSiteCountry_stop1     = [hub1.country]             ✅
hubArrivedDate_stop2     = null                       ✅
```

---

### HUB-P-02 — `goods_left_hub_left` · stop1 already assigned → `hubLeftDate_stop1` only

**Payload changes:**
```json
"situation": { "event": "goods_left_hub_left", "date": "[STAGE_DATES.hub1Left]" },
"event_site": { "iata_code": "[hub1.iata]", "country": "[hub1.country]" }
```
**Assert:**
```
hubLeftDate_stop1 = [STAGE_DATES.hub1Left]  ✅
hubLeftDate_stop2 = null                    ✅
```

---

### HUB-P-03 — `goods_arrived_at_hub_arrived` · stop2 claimed · 7 fields written

**Setup:** `hub2 = pick(HUB_IATA)` different from `hub1`. Stop1 already taken.

**Assert:**
```
hubArrivedDate_stop2     = [STAGE_DATES.hub2Arrived]  ✅
hubSiteIata_stop2        = [hub2.iata]                ✅
hubSiteDescription_stop2 = [hub2.description]         ✅
hubSiteCity_stop2        = [hub2.city]                ✅
hubSiteCountry_stop2     = [hub2.country]             ✅
hubSiteAddressLine_stop2 = [hub2.address]             ✅
hubSiteZipcode_stop2     = [hub2.zip]                 ✅
hubSiteIata_stop1        = [hub1.iata]                ✅  (stop1 unchanged)
```

---

### HUB-P-04 — `goods_left_hub_left` · stop2 → `hubLeftDate_stop2`

**Assert:** `hubLeftDate_stop2 = [STAGE_DATES.hub2Left]` ✅

---

### HUB-P-05 — `goods_arrived_at_hub_arrived` · stop3 claimed · 7 fields written

**Setup:** `hub3 = pick(HUB_IATA)` different from hub1, hub2.

**Assert:**
```
hubArrivedDate_stop3     = [date]          ✅
hubSiteIata_stop3        = [hub3.iata]     ✅
hubSiteCity_stop3        = [hub3.city]     ✅
hubSiteCountry_stop3     = [hub3.country]  ✅
```

---

### HUB-P-06 — `goods_left_hub_left` · stop3 → `hubLeftDate_stop3`

**Assert:** `hubLeftDate_stop3 = [date]` ✅

---

### HUB-P-07 — `goods_arrived_at_hub_arrived` · stop4 claimed · 7 fields written

**Assert:**
```
hubArrivedDate_stop4 = [date]         ✅
hubSiteIata_stop4    = [hub4.iata]    ✅
hubSiteCity_stop4    = [hub4.city]    ✅
```

---

### HUB-P-08 — `goods_left_hub_left` · stop4 → `hubLeftDate_stop4`

**Assert:** `hubLeftDate_stop4 = [date]` ✅

---

### HUB-P-09 — `goods_arrived_at_delivery_hub_arrived` (OR alias) → same as `goods_arrived_at_hub_arrived`

**Payload changes:**
```json
"situation": { "event": "goods_arrived_at_delivery_hub_arrived", "date": "[new date]" },
"event_site": { "iata_code": "[hub1.iata]", "country": "[hub1.country]" }
```
**Assert:** `hubArrivedDate_stop1 = [new date]` ✅ (overwrites P-01 date — same field)

---

### HUB-P-10 — `goods_left_delivery_hub_left` (OR alias) → same as `goods_left_hub_left`

**Assert:** `hubLeftDate_stop1 = [date]` ✅

---

### HUB-P-11 — `manifested` · T5 · event_site = hub1 IATA → `hubManifestedDate_stop1`

Stop1 already assigned from HUB-P-01.

**Payload changes:**
```json
"situation": { "event": "manifested", "date": "[STAGE_DATES.manifested]" },
"event_site": { "iata_code": "[hub1.iata]", "country": "[hub1.country]" }
```
**Assert:**
```
hubManifestedDate_stop1  = [STAGE_DATES.manifested]  ✅
loadingManifestedDate    = null                      ✅
deliveryManifestedDate   = null                      ✅
```

---

### HUB-P-12 — `eta_event` · T5 · hub1 IATA → `hubETADate_stop1`

**Assert:** `hubETADate_stop1 = [STAGE_DATES.eta]` ✅

---

### HUB-P-13 — `received_from_flight` · T5 · hub1 IATA → `hubReceivedFromFlightDate_stop1`

**Assert:** `hubReceivedFromFlightDate_stop1 = [date]` ✅

---

### HUB-P-14 — `manifested` · T5 · hub2 IATA → `hubManifestedDate_stop2`

**Assert:** `hubManifestedDate_stop2 = [date]` ✅ · `hubManifestedDate_stop1` unchanged ✅

---

### HUB-P-15 — `eta_event` · T5 · hub2 IATA → `hubETADate_stop2`

**Assert:** `hubETADate_stop2 = [date]` ✅

---

### HUB-P-16 — `received_from_flight` · T5 · hub2 IATA → `hubReceivedFromFlightDate_stop2`

**Assert:** `hubReceivedFromFlightDate_stop2 = [date]` ✅

---

### HUB-P-17 — `manifested` · T5 · hub3 → `hubManifestedDate_stop3`

**Assert:** `hubManifestedDate_stop3 = [date]` ✅

---

### HUB-P-18 — `eta_event` · T5 · hub3 → `hubETADate_stop3`

**Assert:** `hubETADate_stop3 = [date]` ✅

---

### HUB-P-19 — `received_from_flight` · T5 · hub3 → `hubReceivedFromFlightDate_stop3`

**Assert:** `hubReceivedFromFlightDate_stop3 = [date]` ✅

---

### HUB-P-20 — `manifested` · T5 · hub4 → `hubManifestedDate_stop4`

**Assert:** `hubManifestedDate_stop4 = [date]` ✅

---

### HUB-P-21 — `eta_event` · T5 · hub4 → `hubETADate_stop4`

**Assert:** `hubETADate_stop4 = [date]` ✅

---

### HUB-P-22 — `received_from_flight` · T5 · hub4 → `hubReceivedFromFlightDate_stop4`

**Assert:** `hubReceivedFromFlightDate_stop4 = [date]` ✅

---

## HUB — NEGATIVE

### HUB-N-01 — `goods_arrived_at_hub_arrived` · 5th unique hub → all slots full → silent drop

Fill stops 1–4. Send 5th `goods_arrived_at_hub_arrived` with new IATA.
**Assert:**
```
hubArrivedDate_stop1..4 = original values unchanged  ✅
```
**Assert HTTP:** `200` ✅

---

### HUB-N-02 — `manifested` · T5 · 5th unique hub → slots full → no field written

Fill stops 1–4 via T4. Send `manifested` for 5th unique hub IATA.
**Assert:**
```
hubManifestedDate_stop1..4 = null  ✅  (no slot resolved)
```

---

### HUB-N-03 — Wrong `order.client_reference` → no ATU matched

**Assert:** `hubArrivedDate_stop1` unchanged ✅

---

### HUB-N-04 — Missing Authorization header → HTTP 401

**Assert HTTP:** `401` ✅

---

### HUB-N-05 — Invalid Bearer token → HTTP 401

**Assert HTTP:** `401`

---

### HUB-N-06 — Unknown event name → ATU unchanged

```json
"situation": { "event": "goods_hub_invalid_event" }
```
**Assert:** ATU `lastChangedAt` unchanged ✅

---

## HUB — EDGE CASES

### HUB-E-01 — `goods_arrived_at_hub_arrived` · same IATA+country · stop REUSED · stop2 NOT created

**Step 1:** hub1 → stop1 claimed (HUB-P-01)
**Step 2:** Same hub1 IATA+country, new date T2
**Assert:**
```
hubArrivedDate_stop1 = T2           ✅  (Pass 1: reused — later wins)
hubSiteIata_stop2    = null         ✅  (stop2 NOT created)
```

---

### HUB-E-02 — Arrived + left same hub · same stop resolved both times

**Step 1:** `goods_arrived_at_hub_arrived` for hub1 → stop1
**Step 2:** `goods_left_hub_left` for hub1 → stop1
**Assert:**
```
hubArrivedDate_stop1 = [arrived date]  ✅
hubLeftDate_stop1    = [left date]     ✅
hubSiteIata_stop1    = [hub1.iata]     ✅
```

---

### HUB-E-03 — Both OR aliases for arrived · same hub · latest date wins

**Step 1:** `goods_arrived_at_hub_arrived` → `hubArrivedDate_stop1 = T1`
**Step 2:** `goods_arrived_at_delivery_hub_arrived` same hub → `hubArrivedDate_stop1 = T2`
**Assert:** `hubArrivedDate_stop1 = T2` ✅ (both OR-aliases write same field)

---

### HUB-E-04 — T4 then T5 same hub · both date fields written at same stop

**Step 1:** `goods_arrived_at_hub_arrived` → stop1 created → `hubArrivedDate_stop1`
**Step 2:** `manifested` same hub IATA → stop1 resolved → `hubManifestedDate_stop1`
**Assert:**
```
hubArrivedDate_stop1    = [T1 date]  ✅
hubManifestedDate_stop1 = [T2 date]  ✅  (same stop, different field)
hubSiteIata_stop1       = [hub1.iata] ✅
```

---

### HUB-E-05 — T5 is FIRST event for this hub (no prior T4) · slot created + site fields written

Fresh ATU. No T4 event sent. Send `manifested` for hub IATA.

**Payload changes:**
```json
"situation": { "event": "manifested", "date": "[STAGE_DATES.manifested]" },
"event_site": {
  "iata_code":    "[hub1.iata]",
  "country":      "[hub1.country]",
  "description":  "[hub1.description]",
  "address_line": "[hub1.address]",
  "city":         "[hub1.city]",
  "zipcode":      "[hub1.zip]"
}
```
**Assert:**
```
hubManifestedDate_stop1  = [STAGE_DATES.manifested]  ✅  (T5 creates slot)
hubSiteIata_stop1        = [hub1.iata]               ✅  (site fields written by T5)
hubSiteDescription_stop1 = [hub1.description]        ✅
hubSiteCity_stop1        = [hub1.city]               ✅
hubSiteCountry_stop1     = [hub1.country]            ✅
hubSiteAddressLine_stop1 = [hub1.address]            ✅
hubSiteZipcode_stop1     = [hub1.zip]                ✅
hubArrivedDate_stop1     = null                      ✅  (no T4 sent)
```

---

## ══════════════════════════════════
## ADDITIONAL TESTS — GAPS FROM OCEAN MD
## ══════════════════════════════════

## ALWAYS-ON — asserted in every positive

> Every positive test below verifies always-on fields fire alongside event-specific fields.
> The full 6-field always-on check lives in LS-P-01. All other positives assert the 3 key ones.

---

## NULL FIELD TESTS

### AIR-X-N-01 — `situation.date = null` → event-specific date not written · always-on still written

**Setup:** `clientRef = generateClientRef()`, `loadIata = pick(LOADING_IATA)`, `delIata = pick(DELIVERY_IATA)`

**Payload changes:**
```json
"situation": { "event": "goods_arrived_at_loading_arrived", "date": null }
```
**Assert:**
```
loadingArrivedDate = null                          ✅  (null date not stored)
situationEvent     = "goods_arrived_at_loading_arrived"  ✅  (always-on still written)
situationDate      = null                          ✅  (always-on written even if null)
```

---

### AIR-X-N-02 — `situation.date = null` on hub arrived → hub site fields still written · date null

```json
"situation": { "event": "goods_arrived_at_hub_arrived", "date": null },
"event_site": { "iata_code": "[hub1.iata]", "country": "[hub1.country]", "city": "[hub1.city]", "description": "[hub1.description]", "address_line": "[hub1.address]", "zipcode": "[hub1.zip]" }
```
**Assert:**
```
hubArrivedDate_stop1     = null            ✅  (null date not stored)
hubSiteIata_stop1        = [hub1.iata]    ✅  (site fields still written)
hubSiteCity_stop1        = [hub1.city]    ✅
hubSiteCountry_stop1     = [hub1.country] ✅
```

---

### AIR-X-N-03 — Null hub `event_site` fields → hub site fields not written · date still written

```json
"situation": { "event": "goods_arrived_at_hub_arrived", "date": "[STAGE_DATES.hub1Arrived]" },
"event_site": { "iata_code": "[hub1.iata]", "country": "[hub1.country]", "city": null, "description": null, "address_line": null, "zipcode": null }
```
**Assert:**
```
hubArrivedDate_stop1     = [STAGE_DATES.hub1Arrived]  ✅  (date written)
hubSiteIata_stop1        = [hub1.iata]                ✅
hubSiteCity_stop1        = null                       ✅  (null not stored)
hubSiteDescription_stop1 = null                       ✅
hubSiteAddressLine_stop1 = null                       ✅
hubSiteZipcode_stop1     = null                       ✅
hubSiteCountry_stop1     = [hub1.country]             ✅  (not null — still written)
```

---

### AIR-X-N-04 — Empty request body → HTTP 400

**Assert HTTP:** `400`

---

## DATE CONFLICT TESTS

### AIR-X-E-01 — Loading event sent twice · earlier date does NOT overwrite

**Step 1:** `goods_arrived_at_loading_arrived`, date = T2 → `loadingArrivedDate = T2`
**Step 2:** Same event, date = T1 (T1 < T2)
**Assert:**
```
loadingArrivedDate = T2  ✅  (original kept — earlier does not overwrite)
```

---

### AIR-X-E-02 — Delivery event sent twice · earlier date does NOT overwrite

**Step 1:** `goods_arrived_at_delivery_arrived`, date = T2
**Step 2:** Same event, date = T1 (T1 < T2)
**Assert:**
```
deliveryArrivedDate = T2  ✅
```

---

### AIR-X-E-03 — Hub arrived sent twice · earlier date does NOT overwrite

**Step 1:** `goods_arrived_at_hub_arrived` hub1, date = T2
**Step 2:** Same event same hub1, date = T1 (T1 < T2)
**Assert:**
```
hubArrivedDate_stop1 = T2  ✅  (Pass 1: slot reused · earlier does not overwrite)
hubSiteIata_stop2    = null ✅  (no new slot)
```

---

## eta_event_external — LOADING AND HUB

### AIR-X-E-04 — `eta_event_external` · event_site = loading → `loadingETADate` (OR with eta_event)

**Setup:** `clientRef = generateClientRef()`, `loadIata = pick(LOADING_IATA)`, `delIata = pick(DELIVERY_IATA)`

**Payload changes:**
```json
"situation": { "event": "eta_event_external", "date": "[STAGE_DATES.eta]" },
"event_site": { "iata_code": "[loadIata.iata]", "country": "[loadIata.country]" }
```
**Assert:**
```
loadingETADate  = [STAGE_DATES.eta]  ✅
deliveryETADate = null               ✅
```

---

### AIR-X-E-05 — `eta_event_external` · event_site = hub → `hubETADate_stop1` (OR with eta_event)

**Payload changes:**
```json
"situation": { "event": "eta_event_external", "date": "[STAGE_DATES.eta]" },
"event_site": { "iata_code": "[hub1.iata]", "country": "[hub1.country]" }
```
**Assert:**
```
hubETADate_stop1 = [STAGE_DATES.eta]  ✅
loadingETADate   = null               ✅
deliveryETADate  = null               ✅
```

---

## FULL JOURNEY TEST

### AIR-X-E-06 — Full journey: all events on one ATU in sequence · no cross-contamination

**Setup:** `clientRef = generateClientRef()`, `loadIata = pick(LOADING_IATA)`, `delIata = pick(DELIVERY_IATA)`, `hub1 = pick(HUB_IATA)`, `hub2 = pick(HUB_IATA, exclude: hub1)`

| Step | Event | Event site | Expected field |
|---|---|---|---|
| 1 | `received_from_shipper` | loadIata | `receivedFromShipperDate` |
| 2 | `goods_arrived_at_loading_arrived` | loadIata | `loadingArrivedDate` |
| 3 | `goods_loading_compliant_compliant` | loadIata | `loadingCompliantDate` |
| 4 | `goods_left_loading_left` | loadIata | `loadingLeftDate` |
| 5 | `manifested` | loadIata | `loadingManifestedDate` |
| 6 | `eta_event` | loadIata | `loadingETADate` |
| 7 | `received_from_flight` | loadIata | `loadingReceivedFromFlightDate` |
| 8 | `goods_arrived_at_hub_arrived` | hub1 | `hubArrivedDate_stop1` + 6 hub site fields |
| 9 | `goods_left_hub_left` | hub1 | `hubLeftDate_stop1` |
| 10 | `manifested` | hub1 | `hubManifestedDate_stop1` |
| 11 | `goods_arrived_at_hub_arrived` | hub2 | `hubArrivedDate_stop2` + 6 hub site fields |
| 12 | `goods_arrived_at_delivery_arrived` | delIata | `deliveryArrivedDate` |
| 13 | `goods_delivery_compliant_compliant` | delIata | `deliveryCompliantDate` |
| 14 | `goods_left_delivery_left` | delIata | `deliveryLeftDate` |
| 15 | `manifested` | delIata | `deliveryManifestedDate` |
| 16 | `eta_event` | delIata | `deliveryETADate` |
| 17 | `received_from_flight` | delIata | `deliveryReceivedFromFlightDate` |
| 18 | `documentation_delivered` | delIata | `documentationDeliveredDate` |
| 19 | `consignee_notified` | delIata | `consigneeNotifiedDate` |

**Assert after all 19 steps:**
```
receivedFromShipperDate        = [step1 date]   ✅
loadingArrivedDate             = [step2 date]   ✅
loadingCompliantDate           = [step3 date]   ✅
loadingLeftDate                = [step4 date]   ✅
loadingManifestedDate          = [step5 date]   ✅
loadingETADate                 = [step6 date]   ✅
loadingReceivedFromFlightDate  = [step7 date]   ✅
hubArrivedDate_stop1           = [step8 date]   ✅
hubSiteIata_stop1              = [hub1.iata]    ✅
hubLeftDate_stop1              = [step9 date]   ✅
hubManifestedDate_stop1        = [step10 date]  ✅
hubArrivedDate_stop2           = [step11 date]  ✅
hubSiteIata_stop2              = [hub2.iata]    ✅
deliveryArrivedDate            = [step12 date]  ✅
deliveryCompliantDate          = [step13 date]  ✅
deliveryLeftDate               = [step14 date]  ✅
deliveryManifestedDate         = [step15 date]  ✅
deliveryETADate                = [step16 date]  ✅
deliveryReceivedFromFlightDate = [step17 date]  ✅
documentationDeliveredDate     = [step18 date]  ✅
consigneeNotifiedDate          = [step19 date]  ✅
```
**Also verify no cross-contamination:**
```
loadingArrivedDate  ≠ deliveryArrivedDate  ✅
hubArrivedDate_stop1 ≠ hubArrivedDate_stop2  ✅
```

---

## ALWAYS-ON FIELDS — asserted alongside every positive

Below are condensed checks confirming always-on fires with representative events from each group:

### AIR-X-P-01 — Always-on with T2 delivery event

```json
"situation": { "event": "goods_arrived_at_delivery_arrived", "date": "[STAGE_DATES.deliveryArrived]" }
```
**Assert:**
```
deliveryArrivedDate  = [STAGE_DATES.deliveryArrived]  ✅
situationEvent       = "goods_arrived_at_delivery_arrived"  ✅
situationDate        = [STAGE_DATES.deliveryArrived]  ✅
situationInputDate   = [STAGE_DATES.deliveryArrived]  ✅
orderReference       = [clientRef]                    ✅
consignmentReference = "CSN-001"                      ✅
orderUrl             = [order.url]                    ✅
```

---

### AIR-X-P-02 — Always-on with T3 event

```json
"situation": { "event": "goods_loading_non_compliant_damaged" }
```
**Assert:**
```
loadingNonCompliantDate = [date]  ✅
situationEvent          = "goods_loading_non_compliant_damaged"  ✅
orderReference          = [clientRef]  ✅
```

---

### AIR-X-P-03 — Always-on with T4 hub arrived

```json
"situation": { "event": "goods_arrived_at_hub_arrived" }
```
**Assert:**
```
hubArrivedDate_stop1 = [date]      ✅
situationEvent       = "goods_arrived_at_hub_arrived"  ✅
orderReference       = [clientRef] ✅
```

---

### AIR-X-P-04 — Always-on with T5 routing

```json
"situation": { "event": "manifested" }
```
**Assert:**
```
loadingManifestedDate = [date]      ✅
situationEvent        = "manifested" ✅
orderReference        = [clientRef] ✅
situationDate         = [date]      ✅
```

---

## Summary

| Group | IDs | Count | Coverage |
|---|---|---|---|
| Loading Site — Positive | LS-P-01 to LS-P-10 | 10 | T2 all events · T3 all prefixes · T5 loading routing |
| Loading Site — Negative | LS-N-01 to LS-N-05 | 5 | Unknown IATA · unknown event · wrong clientRef · auth |
| Loading Site — Edge | LS-E-01 to LS-E-03 | 3 | Date overwrite · T3 suffix change · null SC/JC |
| Delivery Site — Positive | DS-P-01 to DS-P-11 | 11 | T2 all events · T3 all prefixes · T5 delivery routing |
| Delivery Site — Negative | DS-N-01 to DS-N-05 | 5 | Unknown IATA · unknown event · wrong clientRef · auth |
| Delivery Site — Edge | DS-E-01 to DS-E-03 | 3 | Date overwrite · T3 suffix change · null SC/JC |
| Hub Events — Positive | HUB-P-01 to HUB-P-22 | 22 | All 4 stops T4 arrived+left · OR aliases · T5 all 3 events × all 4 stops |
| Hub Events — Negative | HUB-N-01 to HUB-N-06 | 6 | T4+T5 overflow · wrong clientRef · auth · unknown event |
| Hub Events — Edge | HUB-E-01 to HUB-E-05 | 5 | Slot REUSE · arrived+left same stop · OR aliases latest wins · T4+T5 same stop · T5 creates slot |
| Additional — Null Fields | AIR-X-N-01 to AIR-X-N-04 | 4 | Null date · null hub site fields · empty body HTTP 400 |
| Additional — Date Conflict | AIR-X-E-01 to AIR-X-E-03 | 3 | Earlier date does not overwrite (loading/delivery/hub) |
| Additional — eta_event_external | AIR-X-E-04 to AIR-X-E-05 | 2 | OR condition at loading + hub |
| Additional — Full Journey | AIR-X-E-06 | 1 | All 19 events in sequence · no cross-contamination |
| Additional — Always-On | AIR-X-P-01 to AIR-X-P-04 | 4 | Always-on verified with T2/T3/T4/T5 events |
| **Total** | | **84** | |

---

## Pass / Fail Checklist

| # | Check | Pass | Fail |
|---|---|---|---|
| 1 | Single `clientReference` lookup (1 API call) | ATU found via OR filter | 3 separate calls or silent drop |
| 2 | Wrong `client_reference` → nothing written | ATU unchanged | Fields written to wrong ATU |
| 3 | Always-on fields on every event | `situationEvent`, `situationDate`, `orderReference` etc present | Any missing |
| 4 | `booked` event → nothing mapped | All booked fields null | Any booked field written |
| 5 | T2 events → date only (no site fields) | Only date written | Site fields written |
| 6 | T3 suffix extracted correctly | `"damaged"` not full event name | Full name stored |
| 7 | T4 arrived → date + 6 hub site fields at correct stop | All 7 fields at stop N | Site fields missing or wrong stop |
| 8 | T4 left → date only at correct stop | `hubLeftDate_stopN` only | Extra fields written |
| 9 | Hub slot REUSE same IATA+country | stop2 null | Duplicate stop created |
| 10 | T5 routing — IATA compare | Correct loading/delivery/hub prefix | Wrong prefix |
| 11 | T5 creates hub slot when no prior T4 | Slot + site fields written | Nothing written |
| 12 | T4 + T5 same hub → both date fields at same stop | Both fields populated | Wrong stop used |
| 13 | 5th hub silently dropped | No new stop, HTTP 200 | Crash or overwrite |
| 14 | OR aliases → same field | `goods_arrived_at_delivery_hub_arrived` = same as `goods_arrived_at_hub_arrived` | Different fields |
| 15 | Null `situation.date` → date field null · always-on still written | Date null · `situationEvent` present | Crash or date written |
| 16 | Earlier date does not overwrite | Original date kept | Earlier date overwrites |
| 17 | `eta_event_external` = `eta_event` at loading + hub | Loading/hub ETA date written | Empty |
| 18 | Full journey — all events · no cross-contamination | All 19 fields populated correctly | Any field missing or wrong |

---

*Source: `Air_Events_Out_TestCases.csv` + `Air_Events_Mapping_Structured_v3.csv` + `air_tracking_qa_guide.docx` | Logward QA | 2026-06-13*
