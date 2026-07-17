// ─────────────────────────────────────────────────────────────────────────────
//  helpers/ocean/oceanPayloadFactory.js
//
//  Builds Shippeo webhook payloads for OCEAN tracking tests.
//
//  Dynamic date generation:
//    Every run generates UNIQUE dates (offset from module-load time) so the BE
//    always treats them as new events and updates OTU.lastChangedAt.
//    runDate(plusSeconds) → ISO-8601 UTC string, unique per run.
//
//  Exported date buckets (used by TC001):
//    PRE_DATES   — Pre-carriage stage event dates
//    POL_DATES   — Port of Loading stage event dates
//    TSP_DATES   — Transhipment stage event dates (2 TSP ports)
//    POD_DATES   — Port of Discharge stage event dates
//    DEL_DATES   — Delivery (destination inland) stage event dates
// ─────────────────────────────────────────────────────────────────────────────

const { CONFIG }                          = require('./oceanConfig');
const { SITE, toLoadingSite, toEventSite } = require('./oceanSites');

// ── Dynamic date base (frozen at module load — shared across test files) ──────
const _RUN_BASE_MS = Date.now();

/**
 * Return a fresh ISO-8601 UTC date string offset by `plusSeconds` from the
 * moment this module was loaded.  Unique across test runs by construction.
 *
 * @param [plusSeconds=0]
 */
const runDate = (plusSeconds = 0) =>
  new Date(_RUN_BASE_MS + plusSeconds * 1000).toISOString();

// ── Real-world shipping timeline helper ───────────────────────────────────────
// d(days, hours) → offset in seconds from run base.
// Reflects an actual China→Europe ocean shipment (~46 days total).
const d = (days, hours = 0) => days * 86400 + hours * 3600;

// ── Pre-Carriage dates (Suzhou inland depot → Shanghai port) ─────────────────
// Day 1–5: Empty container picked up from depot, stuffed, trucked to port.
const PRE_DATES = {
  actualGateOutEmpty:      runDate(d(1, 6)),   // Day 1 06:00 — empty container leaves depot
  estimatedGateOutEmpty:   runDate(d(1, 0)),   // Day 1 00:00 — estimated version (sent before actual)
  actualDepartureFromOrig: runDate(d(3, 8)),   // Day 3 08:00 — truck departs shipper premises
  estimatedDeptFromOrig:   runDate(d(2, 0)),   // Day 2 00:00 — estimated version
  actualLoadedAtOrigin:    runDate(d(3, 12)),  // Day 3 12:00 — container fully stuffed & sealed
  estimatedLoadedAtOrigin: runDate(d(2, 12)),  // Day 2 12:00 — estimated version
};

// ── Port of Loading dates (Shanghai) ─────────────────────────────────────────
// Day 5–7: Container arrives at Shanghai port, gets loaded onto ocean vessel.
const POL_DATES = {
  actualGateIn:    runDate(d(5, 8)),   // Day 5  08:00 — container enters port gate
  estimatedGateIn: runDate(d(4, 0)),   // Day 4  00:00 — estimated version
  actualLoad:      runDate(d(6, 14)),  // Day 6  14:00 — container loaded onto vessel
  estimatedLoad:   runDate(d(5, 0)),   // Day 5  00:00 — estimated version
  actualDeparture: runDate(d(7, 22)),  // Day 7  22:00 — vessel departs Shanghai
  estimatedDept:   runDate(d(6, 0)),   // Day 6  00:00 — estimated version
  predictedDept:   runDate(d(6, 12)),  // Day 6  12:00 — Shippeo predicted version
};

// ── TSP dates ─────────────────────────────────────────────────────────────────
// TSP1 — Singapore (~11 days from Shanghai, Day 18–20)
// TSP2 — Jebel Ali, UAE (~12 days from Singapore, Day 32–34)
const TSP_DATES = {
  tsp1ActualArrival:   runDate(d(18, 6)),   // Day 18 06:00 — vessel arrives Singapore
  tsp1ActualDischarge: runDate(d(18, 14)),  // Day 18 14:00 — container unloaded from vessel
  tsp1ActualLoad:      runDate(d(19, 10)),  // Day 19 10:00 — container loaded onto next vessel
  tsp1ActualDeparture: runDate(d(20, 2)),   // Day 20 02:00 — vessel departs Singapore

  tsp2ActualArrival:   runDate(d(32, 8)),   // Day 32 08:00 — vessel arrives Jebel Ali
  tsp2ActualDischarge: runDate(d(32, 18)),  // Day 32 18:00 — container unloaded
  tsp2ActualLoad:      runDate(d(33, 14)),  // Day 33 14:00 — container loaded onto next vessel
  tsp2ActualDeparture: runDate(d(34, 6)),   // Day 34 06:00 — vessel departs Jebel Ali

  tsp1EstArrival:   runDate(d(16, 0)),  // estimated arrival at TSP1 (sent before actual)
  tsp1PredArrival:  runDate(d(17, 0)),  // Shippeo predicted arrival at TSP1
  tsp1EstDeparture: runDate(d(18, 0)),  // estimated departure from TSP1
};

// ── POD dates (Rotterdam) ─────────────────────────────────────────────────────
// Day 44–46: Vessel arrives Rotterdam, container discharged, leaves port.
const POD_DATES = {
  estimatedArrival:   runDate(d(42, 0)),   // estimated vessel arrival (ETA)
  predictedArrival:   runDate(d(43, 0)),   // Shippeo predicted arrival
  actualArrival:      runDate(d(44, 7)),   // Day 44 07:00 — vessel berths Rotterdam
  estimatedDischarge: runDate(d(43, 0)),   // estimated container discharge
  predictedDischarge: runDate(d(43, 12)),  // Shippeo predicted discharge
  actualDischarge:    runDate(d(44, 16)),  // Day 44 16:00 — container unloaded from vessel
  actualGateOut:      runDate(d(45, 10)),  // Day 45 10:00 — container exits port gate
  estimatedGateOut:   runDate(d(44, 0)),   // estimated port gate out
  predictedGateOut:   runDate(d(44, 12)),  // Shippeo predicted gate out
  actualEmptyReturn:  runDate(d(52, 9)),   // Day 52 09:00 — empty container returned to depot
  estEmptyReturn:     runDate(d(50, 0)),   // estimated empty return
};

// ── Delivery dates (Duisburg inland warehouse) ────────────────────────────────
// Day 46–47: Container trucked/barged from Rotterdam to inland warehouse.
const DEL_DATES = {
  estimatedArrival:  runDate(d(45, 0)),   // estimated arrival at consignee
  actualArrival:     runDate(d(46, 11)),  // Day 46 11:00 — container delivered to warehouse
  actualEmptyReturn: runDate(d(52, 14)), // Day 52 14:00 — empty returned after unloading
  estEmptyReturn:    runDate(d(51, 0)),   // estimated empty return
};

// ─────────────────────────────────────────────────────────────────────────────
// Default vessel for events that carry vessel data
// ─────────────────────────────────────────────────────────────────────────────
const VESSEL = {
  imoNumber: '9864239',
  mmsi:      '636023646',
  label:     'ZEUS LUMOS',
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a complete Shippeo ocean-tracking webhook payload.
 *
 * @param event          situation.event value
 * @param date           situation.date (ISO 8601)
 * @param situationType  'actual' | 'estimated'
 * @param dataSource     'external' | 'shippeo' | null
 * @param eventSite      event_site object (use toEventSite(SITE.xxx))
 * @param [extras]       optional top-level payload overrides
 */
function makePayload(event, date, situationType, dataSource, eventSite, extras = {}) {
  return {
    date_transmission: new Date(_RUN_BASE_MS).toISOString(),
    owner: {
      organization: { id: 'Q2JK9RVN', name: 'LIDL' },
      agency:       { id: '82V85L72', name: 'LIDL_Ocean', siret: null },
    },
    order: {
      edi_reference: CONFIG.CONTAINER_NUMBER,
      reference:     CONFIG.CONTAINER_NUMBER,
      url:           'https://view.shippeo.com/orderPublic/test',
    },
    tour: {
      edi_reference: CONFIG.CONTAINER_NUMBER,
      reference:     CONFIG.CONTAINER_NUMBER,
    },
    situation: {
      event,
      date,
      input_date:     date,
      type:           situationType,
      transport_mode: 'ocean',
    },
    situation_justification: {
      position:      null,
      attributes:    {},
      data_source:   dataSource,
      platform_type: 'ocean',
    },
    loading_site:  toLoadingSite(SITE.NGB_POL),
    delivery_site: toLoadingSite(SITE.RTM_POD),
    carrier:       { scacs: ['MSCU'] },
    event_site:    eventSite,
    tags:          [],
    handling_units: [],
    // Confirmed from QA webhook curl: BL uses 'identifier' key, booking uses 'reference'
    booking_references:        CONFIG.BOOKING_REF ? [{ reference: CONFIG.BOOKING_REF }] : [],
    bill_of_lading_references: CONFIG.BOL_NUMBER  ? [{ active: 'True', identifier: CONFIG.BOL_NUMBER }] : [],
    resources:     [],
    items:         [],
    cargo: {
      reference:  CONFIG.CONTAINER_NUMBER,
      qualifier:  'CONTAINER',
    },
    ...extras,
  };
}

/**
 * Add vessel (vessel + milestoneVessel) resources to a payload in-place.
 *
 * @param payload
 * @param [imoNumber]
 * @param [mmsi]
 * @param [label]
 */
function withVessel(payload, imoNumber = VESSEL.imoNumber, mmsi = VESSEL.mmsi, label = VESSEL.label) {
  payload.resources = [
    {
      qualifier: 'vessel',
      identifiers: [
        { qualifier: 'IMO',   value: imoNumber },
        { qualifier: 'MMSI',  value: mmsi      },
        { qualifier: 'LABEL', value: label     },
      ],
    },
    {
      qualifier: 'milestoneVessel',
      identifiers: [
        { qualifier: 'IMO',   value: imoNumber },
        { qualifier: 'MMSI',  value: mmsi      },
        { qualifier: 'LABEL', value: label     },
      ],
    },
  ];
  return payload;
}

module.exports = {
  makePayload,
  withVessel,
  runDate,
  VESSEL,
  PRE_DATES,
  POL_DATES,
  TSP_DATES,
  POD_DATES,
  DEL_DATES,
  // Re-export SITE helpers for convenience
  SITE,
  toLoadingSite,
  toEventSite,
};
