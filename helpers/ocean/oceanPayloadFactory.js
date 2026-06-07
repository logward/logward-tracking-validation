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

// ── Pre-Carriage dates ────────────────────────────────────────────────────────
const PRE_DATES = {
  actualGateOutEmpty:      runDate(1800),   // +30m
  estimatedGateOutEmpty:   runDate(3600),   // +1h
  actualDepartureFromOrig: runDate(7200),   // +2h
  estimatedDeptFromOrig:   runDate(10800),  // +3h
  actualLoadedAtOrigin:    runDate(14400),  // +4h
  estimatedLoadedAtOrigin: runDate(18000),  // +5h
};

// ── POL dates ─────────────────────────────────────────────────────────────────
const POL_DATES = {
  actualGateIn:      runDate(21600),  // +6h
  estimatedGateIn:   runDate(25200),  // +7h
  actualLoad:        runDate(28800),  // +8h
  estimatedLoad:     runDate(32400),  // +9h
  actualDeparture:   runDate(36000),  // +10h
  estimatedDept:     runDate(39600),  // +11h
  predictedDept:     runDate(43200),  // +12h
};

// ── TSP dates (2 transhipment ports) ─────────────────────────────────────────
const TSP_DATES = {
  tsp1ActualArrival:    runDate(50400),  // +14h  TSP1 (Singapore) arrive
  tsp1ActualDischarge:  runDate(54000),  // +15h  TSP1 unloaded
  tsp1ActualLoad:       runDate(57600),  // +16h  TSP1 loaded (onto next vessel)
  tsp1ActualDeparture:  runDate(61200),  // +17h  TSP1 departed
  tsp2ActualArrival:    runDate(64800),  // +18h  TSP2 (Port Klang) arrive
  tsp2ActualDischarge:  runDate(68400),  // +19h  TSP2 unloaded
  tsp2ActualLoad:       runDate(72000),  // +20h  TSP2 loaded
  tsp2ActualDeparture:  runDate(75600),  // +21h  TSP2 departed

  tsp1EstArrival:   runDate(79200),   // +22h
  tsp1PredArrival:  runDate(82800),   // +23h
  tsp1EstDeparture: runDate(86400),   // +24h
};

// ── POD dates ─────────────────────────────────────────────────────────────────
const POD_DATES = {
  estimatedArrival:  runDate(90000),   // +25h  (eta_event)
  predictedArrival:  runDate(93600),   // +26h  (eta_event, shippeo)
  actualArrival:     runDate(97200),   // +27h
  estimatedDischarge:runDate(100800),  // +28h
  predictedDischarge:runDate(104400),  // +29h
  actualDischarge:   runDate(108000),  // +30h
  actualGateOut:     runDate(111600),  // +31h
  estimatedGateOut:  runDate(115200),  // +32h
  predictedGateOut:  runDate(118800),  // +33h
  actualEmptyReturn: runDate(122400),  // +34h
  estEmptyReturn:    runDate(126000),  // +35h
};

// ── Delivery dates ────────────────────────────────────────────────────────────
const DEL_DATES = {
  estimatedArrival: runDate(129600),  // +36h
  actualArrival:    runDate(133200),  // +37h
  actualEmptyReturn:runDate(136800),  // +38h
  estEmptyReturn:   runDate(140400),  // +39h
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
    booking_references:        [{ reference: CONFIG.BOOKING_REF }],
    bill_of_lading_references: [{ reference: CONFIG.BOL_NUMBER }],
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
