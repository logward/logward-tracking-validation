# Road Tracking — Events-Out Field Mapping Tests
**File:** `E2E_Road.spec.js`
**Source:** `_LIDL__Events-out_Mapping_-_Road.xlsx`
**Updated:** 2026-06-13

---

## How It Works

```
Shippeo POST → Validate account → Lookup RTO in BE → Check conditions → Map fields → PATCH RTO

LOOKUP: order.reference (or order.edi_reference)
No match → HTTP 200, event silently dropped

CONDITION CHECK (all 3 must match):
  situation_code  = exact value
  justification_code = exact value
  situation.event = exact value

Only when all 3 match → event name written to Logward field
```

---

## Event Condition Mapping

| situation_code | justification_code | situation.event | Logward Field | Description |
|---|---|---|---|---|
| `EML` | `CFM` | `DRIVING_TO_LOAD` | `truckDrivingToPickUpLocation` | Truck driving to pickup |
| `EML` | `ARS` | `ARR_LOAD` | `actualArrivalAtPickUpLocation` | Arrived at pickup |
| `ECH` | `CFM` | `CON_LOAD` | `loaded` | Loaded |
| `ECH` | `DES` | `LEFT_LOADING_SITE` | `actualDeparturePolRoad` | Left loading site |
| `MLV` | `CFM` | `DRIVING_TO_UNLOAD` | `truckDrivingToDeliveryLocation` | Driving to delivery |
| `LIV` | `ARS` | `ARR_UNLOAD` | `actualArrivalPodRoad` | Arrived at delivery |
| `LIV` | `CFM` | `CON_UNLOAD` | `delivered` | Delivered |
| `LIV` | `DES` | `DRIVER_LEFT_UNLOAD` | `truckDepartureFromDeliveryLocation` | Left delivery |
| `COM` | `CFM` | `ETA_EVENT` | `predictedArrivalAtPickUpLocation` | ETA at pickup (`order.etd` present) |
| `COM` | `CFM` | `ETA_EVENT` | `predictedArrivalAtDeliveryLocation` | ETA at delivery (`order.eta` present) |

---

## Field Mapping (all events)

| Logward Field | Shippeo Source | Type |
|---|---|---|
| `eventTime` | `situation.date` | ISO datetime |

> Only the timestamp field is mapped. Loading/delivery site fields are **not mapped**.

---

## Data Pools & Helpers

```js
function generateOrderRef() {
  return `E2ERDT${Math.floor(Math.random() * 9000000 + 1000000)}`;
}

const LOADING_SITES = [
  { name: "Oosterhout",  address: "Energieweg 10",    zipcode: "4906 CG", city: "Oosterhout",  country: "NL", lat: 51.658647, lng: 4.840261  },
  { name: "Rotterdam",   address: "Waalhaven ZZ 15",  zipcode: "3089 JH", city: "Rotterdam",   country: "NL", lat: 51.893712, lng: 4.445623  },
  { name: "Hamburg",     address: "Hafenstrasse 12",  zipcode: "20459",   city: "Hamburg",     country: "DE", lat: 53.545445, lng: 9.918592  },
  { name: "Antwerp",     address: "Kaai 203",         zipcode: "2030",    city: "Antwerp",     country: "BE", lat: 51.236775, lng: 4.415369  },
  { name: "Lyon",        address: "Quai de la Saone", zipcode: "69001",   city: "Lyon",        country: "FR", lat: 45.764043, lng: 4.835659  },
];

const DELIVERY_SITES = [
  { name: "Stuttgart LIDL", address: "Strutstrasse 21",  zipcode: "73061", city: "Ebersbach an der Fils", country: "DE", lat: 48.719202, lng: 9.511021 },
  { name: "Munich LIDL",    address: "Landsberger Str.", zipcode: "80339", city: "Munich",                country: "DE", lat: 48.135125, lng: 11.581981 },
  { name: "Berlin LIDL",    address: "Karl-Marx-Str.",   zipcode: "12043", city: "Berlin",                country: "DE", lat: 52.486450, lng: 13.432220 },
  { name: "Vienna LIDL",    address: "Praterstrasse 1",  zipcode: "1020",  city: "Vienna",                country: "AT", lat: 48.218812, lng: 16.412899 },
  { name: "Prague LIDL",    address: "Vaclavske nam.",   zipcode: "11000", city: "Prague",                country: "CZ", lat: 50.081656, lng: 14.420016 },
];

const STAGE_DATES = {
  drivingToLoad:       stageDate(-3, 6),
  arrivedAtPickUp:     stageDate(-2, 10),
  loaded:              stageDate(-2, 14),
  leftLoading:         stageDate(-2, 16),
  drivingToDelivery:   stageDate(-1, 8),
  arrivedAtDelivery:   stageDate(0,  9),
  delivered:           stageDate(0,  11),
  leftDelivery:        stageDate(0,  12),
  etaPickUp:           stageDate(-1, 6),
  etaDelivery:         stageDate(0,  7),
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
  "date_transmission": "2025-07-15T09:56:35+02:00",
  "owner": {
    "organization": { "id": "Q2JK9RVN", "name": "LIDL" },
    "agency": { "id": "Q27K7Z42", "name": "LIDL_Road", "siret": null }
  },
  "order": {
    "edi_reference": "[orderRef]",
    "reference":     "[orderRef]",
    "eta": null,
    "etd": null,
    "url": "https://view.shippeo.com/orderPublic/test",
    "shippeo_reference": "NPG8WVVV"
  },
  "tour": {
    "edi_reference": "[orderRef]",
    "reference":     "[orderRef]"
  },
  "situation": {
    "event":              "[event]",
    "situation_code":     "[situation_code]",
    "justification_code": "[justification_code]",
    "input_date":         "[STAGE_DATES.xxx]",
    "date":               "[STAGE_DATES.xxx]"
  },
  "situation_justification": {
    "theoretical_distance": 2717,
    "position": { "lat": 48.718822, "lng": 9.543809 }
  },
  "loading_site": {
    "name":         "[loadSite.name]",
    "address_line": "[loadSite.address]",
    "zipcode":      "[loadSite.zipcode]",
    "city":         "[loadSite.city]",
    "country":      "[loadSite.country]",
    "position": { "lat": "[loadSite.lat]", "lng": "[loadSite.lng]" }
  },
  "delivery_site": {
    "name":         "[delSite.name]",
    "address_line": "[delSite.address]",
    "zipcode":      "[delSite.zipcode]",
    "city":         "[delSite.city]",
    "country":      "[delSite.country]",
    "position": { "lat": "[delSite.lat]", "lng": "[delSite.lng]" }
  }
}
```

---

## ══════════════════════════════════
## POSITIVE TESTS
## ══════════════════════════════════

### RD-P-01 — `DRIVING_TO_LOAD` · EML/CFM → `truckDrivingToPickUpLocation` + all field mappings

**Setup:** `orderRef = generateOrderRef()`, `loadSite = pick(LOADING_SITES)`, `delSite = pick(DELIVERY_SITES)`

**Payload changes:**
```json
"situation": {
  "event": "DRIVING_TO_LOAD",
  "situation_code":     "EML",
  "justification_code": "CFM",
  "date": "[STAGE_DATES.drivingToLoad]"
}
```
**Assert:**
```
truckDrivingToPickUpLocation = [STAGE_DATES.drivingToLoad]  ✅
```

---

### RD-P-02 — `ARR_LOAD` · EML/ARS → `actualArrivalAtPickUpLocation`

**Setup:** `orderRef = generateOrderRef()`, `loadSite = pick(LOADING_SITES)`, `delSite = pick(DELIVERY_SITES)`

**Payload changes:**
```json
"situation": {
  "event": "ARR_LOAD",
  "situation_code":     "EML",
  "justification_code": "ARS",
  "date": "[STAGE_DATES.arrivedAtPickUp]"
}
```
**Assert:**
```
actualArrivalAtPickUpLocation = [STAGE_DATES.arrivedAtPickUp]  ✅
```

---

### RD-P-03 — `CON_LOAD` · ECH/CFM → `loaded`

**Setup:** `orderRef = generateOrderRef()`, `loadSite = pick(LOADING_SITES)`, `delSite = pick(DELIVERY_SITES)`

**Payload changes:**
```json
"situation": {
  "event": "CON_LOAD",
  "situation_code":     "ECH",
  "justification_code": "CFM",
  "date": "[STAGE_DATES.loaded]"
}
```
**Assert:**
```
loaded               = [STAGE_DATES.loaded]  ✅
```

---

### RD-P-04 — `LEFT_LOADING_SITE` · ECH/DES → `actualDeparturePolRoad`

**Setup:** `orderRef = generateOrderRef()`, `loadSite = pick(LOADING_SITES)`, `delSite = pick(DELIVERY_SITES)`

**Payload changes:**
```json
"situation": {
  "event": "LEFT_LOADING_SITE",
  "situation_code":     "ECH",
  "justification_code": "DES",
  "date": "[STAGE_DATES.leftLoading]"
}
```
**Assert:**
```
actualDeparturePolRoad = [STAGE_DATES.leftLoading]  ✅
```

---

### RD-P-05 — `DRIVING_TO_UNLOAD` · MLV/CFM → `truckDrivingToDeliveryLocation`

**Setup:** `orderRef = generateOrderRef()`, `loadSite = pick(LOADING_SITES)`, `delSite = pick(DELIVERY_SITES)`

**Payload changes:**
```json
"situation": {
  "event": "DRIVING_TO_UNLOAD",
  "situation_code":     "MLV",
  "justification_code": "CFM",
  "date": "[STAGE_DATES.drivingToDelivery]"
}
```
**Assert:**
```
truckDrivingToDeliveryLocation = [STAGE_DATES.drivingToDelivery]  ✅
```

---

### RD-P-06 — `ARR_UNLOAD` · LIV/ARS → `actualArrivalPodRoad`

**Setup:** `orderRef = generateOrderRef()`, `loadSite = pick(LOADING_SITES)`, `delSite = pick(DELIVERY_SITES)`

**Payload changes:**
```json
"situation": {
  "event": "ARR_UNLOAD",
  "situation_code":     "LIV",
  "justification_code": "ARS",
  "date": "[STAGE_DATES.arrivedAtDelivery]"
}
```
**Assert:**
```
actualArrivalPodRoad = [STAGE_DATES.arrivedAtDelivery]  ✅
```

---

### RD-P-07 — `CON_UNLOAD` · LIV/CFM → `delivered`

**Setup:** `orderRef = generateOrderRef()`, `loadSite = pick(LOADING_SITES)`, `delSite = pick(DELIVERY_SITES)`

**Payload changes:**
```json
"situation": {
  "event": "CON_UNLOAD",
  "situation_code":     "LIV",
  "justification_code": "CFM",
  "date": "[STAGE_DATES.delivered]"
}
```
**Assert:**
```
delivered            = [STAGE_DATES.delivered]  ✅
```

---

### RD-P-08 — `DRIVER_LEFT_UNLOAD` · LIV/DES → `truckDepartureFromDeliveryLocation`

**Setup:** `orderRef = generateOrderRef()`, `loadSite = pick(LOADING_SITES)`, `delSite = pick(DELIVERY_SITES)`

**Payload changes:**
```json
"situation": {
  "event": "DRIVER_LEFT_UNLOAD",
  "situation_code":     "LIV",
  "justification_code": "DES",
  "date": "[STAGE_DATES.leftDelivery]"
}
```
**Assert:**
```
truckDepartureFromDeliveryLocation = [STAGE_DATES.leftDelivery]  ✅
```

---

### RD-P-09 — `ETA_EVENT` · COM/CFM · `order.etd` present → `predictedArrivalAtPickUpLocation`

**Setup:** `orderRef = generateOrderRef()`, `loadSite = pick(LOADING_SITES)`, `delSite = pick(DELIVERY_SITES)`

**Payload changes:**
```json
"order": {
  "reference": "[orderRef]",
  "etd": "[STAGE_DATES.etaPickUp]",
  "eta": null
},
"situation": {
  "event": "ETA_EVENT",
  "situation_code":     "COM",
  "justification_code": "CFM",
  "date": "[STAGE_DATES.etaPickUp]"
}
```
**Assert:**
```
predictedArrivalAtPickUpLocation    = [STAGE_DATES.etaPickUp]  ✅
predictedArrivalAtDeliveryLocation  = null                     ✅  (eta absent — delivery ETA not triggered)
```

---

### RD-P-10 — `ETA_EVENT` · COM/CFM · `order.eta` present → `predictedArrivalAtDeliveryLocation`

**Setup:** `orderRef = generateOrderRef()`, `loadSite = pick(LOADING_SITES)`, `delSite = pick(DELIVERY_SITES)`

**Payload changes:**
```json
"order": {
  "reference": "[orderRef]",
  "eta": "[STAGE_DATES.etaDelivery]",
  "etd": null
},
"situation": {
  "event": "ETA_EVENT",
  "situation_code":     "COM",
  "justification_code": "CFM",
  "date": "[STAGE_DATES.etaDelivery]"
}
```
**Assert:**
```
predictedArrivalAtDeliveryLocation = [STAGE_DATES.etaDelivery]  ✅
predictedArrivalAtPickUpLocation   = null                        ✅  (etd absent — pickup ETA not triggered)
```

---

## ══════════════════════════════════
## NEGATIVE TESTS
## ══════════════════════════════════

### RD-N-01 — Wrong `situation_code` → no event field written

Correct event name and justification_code but wrong situation_code. All 3 conditions must match.

**Payload changes:**
```json
"situation": {
  "event": "DRIVING_TO_LOAD",
  "situation_code":     "XXX",
  "justification_code": "CFM"
}
```
**Assert:**
```
truckDrivingToPickUpLocation = null           ✅  (condition mismatch — not written)
```

---

### RD-N-02 — Wrong `justification_code` → no event field written

Correct event and situation_code but wrong justification_code.

**Payload changes:**
```json
"situation": {
  "event": "DRIVING_TO_LOAD",
  "situation_code":     "EML",
  "justification_code": "XXX"
}
```
**Assert:**
```
truckDrivingToPickUpLocation = null  ✅
```

---

### RD-N-03 — Wrong `situation.event` → no event field written

Correct situation_code and justification_code but wrong event name.

**Payload changes:**
```json
"situation": {
  "event": "UNKNOWN_EVENT",
  "situation_code":     "EML",
  "justification_code": "CFM"
}
```
**Assert:**
```
truckDrivingToPickUpLocation = null  ✅
```

---

### RD-N-04 — `ETA_EVENT` · COM/CFM · neither `order.eta` nor `order.etd` present → nothing written

```json
"order": { "reference": "[orderRef]", "eta": null, "etd": null },
"situation": { "event": "ETA_EVENT", "situation_code": "COM", "justification_code": "CFM" }
```
**Assert:**
```
predictedArrivalAtPickUpLocation   = null  ✅
predictedArrivalAtDeliveryLocation = null  ✅
```

---

### RD-N-05 — RTO not found → HTTP 200 · nothing written

```json
"order": { "reference": "NONEXISTENT-ORDER-999" }
```
**Assert HTTP:** `200` · RTO unchanged ✅

---

### RD-N-06 — Missing `situation_code` → no event field written

```json
"situation": { "event": "DRIVING_TO_LOAD", "situation_code": null, "justification_code": "CFM" }
```
**Assert:**
```
truckDrivingToPickUpLocation = null  ✅
```

---

### RD-N-07 — Missing `justification_code` → no event field written

```json
"situation": { "event": "DRIVING_TO_LOAD", "situation_code": "EML", "justification_code": null }
```
**Assert:**
```
truckDrivingToPickUpLocation = null  ✅
```

---

### RD-N-08 — Correct conditions but `situation.date` null → event field null · location fields written

```json
"situation": { "event": "DRIVING_TO_LOAD", "situation_code": "EML", "justification_code": "CFM", "date": null }
```
**Assert:**
```
truckDrivingToPickUpLocation = null            ✅  (null date not stored)
```

---

### RD-N-09 — Wrong case `situation.event` → no event field written (case-sensitive)

```json
"situation": { "event": "driving_to_load", "situation_code": "EML", "justification_code": "CFM" }
```
**Assert:**
```
truckDrivingToPickUpLocation = null  ✅  (event name is case-sensitive)
```

---

### RD-N-10 — Wrong case `situation_code` → no event field written (case-sensitive)

```json
"situation": { "event": "DRIVING_TO_LOAD", "situation_code": "eml", "justification_code": "CFM" }
```
**Assert:**
```
truckDrivingToPickUpLocation = null  ✅
```

---

### RD-N-11 — Missing Authorization header → HTTP 401

**Assert HTTP:** `401` · RTO unchanged ✅

---

### RD-N-12 — Invalid Bearer token → HTTP 401

**Assert HTTP:** `401`

---

### RD-N-13 — Empty request body → HTTP 400

**Assert HTTP:** `400`

---

---

## ══════════════════════════════════
## EDGE CASES
## ══════════════════════════════════

### RD-E-01 — Same event sent twice · later date wins

**Setup:** `orderRef = generateOrderRef()`, `loadSite = pick(LOADING_SITES)`, `delSite = pick(DELIVERY_SITES)`

**Step 1:** `DRIVING_TO_LOAD` EML/CFM, date = T1
**Step 2:** Same conditions, date = T2 (T2 > T1)
**Assert:**
```
truckDrivingToPickUpLocation = T2  ✅
```

---

### RD-E-02 — Same event sent twice · earlier date does NOT overwrite

**Step 1:** date = T2 → stored
**Step 2:** date = T1 (T1 < T2)
**Assert:**
```
truckDrivingToPickUpLocation = T2  ✅  (original kept)
```

---

### RD-E-05 — `ETA_EVENT` with both `order.eta` AND `order.etd` present → both fields written

```json
"order": { "eta": "[STAGE_DATES.etaDelivery]", "etd": "[STAGE_DATES.etaPickUp]" },
"situation": { "event": "ETA_EVENT", "situation_code": "COM", "justification_code": "CFM" }
```
**Assert:**
```
predictedArrivalAtPickUpLocation   = [STAGE_DATES.etaPickUp]    ✅
predictedArrivalAtDeliveryLocation = [STAGE_DATES.etaDelivery]  ✅
```

---

### RD-E-06 — Full journey: all 8 events in sequence on one RTO

**Setup:** `orderRef = generateOrderRef()`, `loadSite = pick(LOADING_SITES)`, `delSite = pick(DELIVERY_SITES)`

| Step | Event | situation_code | justification_code | Expected field |
|---|---|---|---|---|
| 1 | `DRIVING_TO_LOAD` | `EML` | `CFM` | `truckDrivingToPickUpLocation` |
| 2 | `ARR_LOAD` | `EML` | `ARS` | `actualArrivalAtPickUpLocation` |
| 3 | `CON_LOAD` | `ECH` | `CFM` | `loaded` |
| 4 | `LEFT_LOADING_SITE` | `ECH` | `DES` | `actualDeparturePolRoad` |
| 5 | `DRIVING_TO_UNLOAD` | `MLV` | `CFM` | `truckDrivingToDeliveryLocation` |
| 6 | `ARR_UNLOAD` | `LIV` | `ARS` | `actualArrivalPodRoad` |
| 7 | `CON_UNLOAD` | `LIV` | `CFM` | `delivered` |
| 8 | `DRIVER_LEFT_UNLOAD` | `LIV` | `DES` | `truckDepartureFromDeliveryLocation` |

**Assert after all 8 steps:**
```
truckDrivingToPickUpLocation       = [step1 date]       ✅
actualArrivalAtPickUpLocation      = [step2 date]       ✅
loaded                             = [step3 date]       ✅
actualDeparturePolRoad             = [step4 date]       ✅
truckDrivingToDeliveryLocation     = [step5 date]       ✅
actualArrivalPodRoad               = [step6 date]       ✅
delivered                          = [step7 date]       ✅
truckDepartureFromDeliveryLocation = [step8 date]       ✅
```

---

### RD-E-07 — `ETA_EVENT` conditions partially match — only 2 of 3 → nothing written

**Step 1 — correct conditions (COM/CFM/ETA_EVENT) with eta:**
```json
"situation": { "event": "ETA_EVENT", "situation_code": "COM", "justification_code": "CFM" },
"order":      { "eta": "[STAGE_DATES.etaDelivery]" }
```
**Step 2 — wrong justification_code:**
```json
"situation": { "event": "ETA_EVENT", "situation_code": "COM", "justification_code": "ARS" },
"order":      { "eta": "[STAGE_DATES.etaDelivery]" }
```
**Assert after Step 2:**
```
predictedArrivalAtDeliveryLocation = [Step 1 value]  ✅  (Step 2 condition failed — original kept)
```

---

---

## Summary

| Group | IDs | Count | Coverage |
|---|---|---|---|
| Positive | RD-P-01 to RD-P-10 | 10 | All 8 event conditions + both ETA_EVENT variants (etd/eta) · eventTime mapped from situation.date |
| Negative | RD-N-01 to RD-N-13 | 13 | Wrong situation_code · wrong justification_code · wrong event · ETA neither field · RTO not found · null conditions · null date · case-sensitive checks · auth · empty body |
| Edge Cases | RD-E-01 to RD-E-07 | 7 | Date overwrite · earlier no overwrite · both ETA fields · full journey · partial condition match |
| **Total** | | **30** | |

---

## Pass / Fail Checklist

| # | Check | Pass | Fail |
|---|---|---|---|
| 1 | All 3 conditions must match | Event field written | Event field null |
| 2 | Any 1 condition wrong → nothing written | Event field null | Field written anyway |
| 3 | Conditions case-sensitive | `"eml"` ≠ `"EML"` | Written regardless of case |
| 5 | ETA_EVENT: `order.etd` → pickup ETA | `predictedArrivalAtPickUpLocation` written | Empty |
| 6 | ETA_EVENT: `order.eta` → delivery ETA | `predictedArrivalAtDeliveryLocation` written | Empty |
| 7 | ETA_EVENT: neither eta/etd → nothing | Both null | Either written |
| 8 | ETA_EVENT: both eta+etd → both written | Both fields populated | Only one written |
| 9 | RTO not found → HTTP 200, nothing written | `200` + RTO unchanged | Fields written |
| 10 | Later date overwrites | Updated date stored | Original kept |
| 11 | Earlier date does NOT overwrite | Original date kept | Earlier date stored |
| 13 | Full journey 8 events on one RTO | All 8 date fields populated | Any missing |

---

*Source: `_LIDL__Events-out_Mapping_-_Road.xlsx` | Logward QA | 2026-06-13*
