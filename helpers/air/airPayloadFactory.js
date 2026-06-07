// @ts-check
// ─────────────────────────────────────────────────────────────────────────────
//  helpers/air/airPayloadFactory.js
//
//  Builds Shippeo webhook payloads for AIR tracking tests.
//
//  Dynamic date generation:
//    Every run generates UNIQUE dates (offset from module-load time) so the BE
//    always treats them as new events and updates ATU.changedAt.
//    runDate(plusSeconds) → ISO-8601 UTC string, unique per run.
//
//  Exported date buckets (used by both TC001 & TC002):
//    T2_DATES   — one date per Type 2 exact-match event
//    T3_DATES   — one date per Type 3 starts-with event
//    T4_DATES   — hub arrived / left dates
//    T5_DATES   — routing events × (loading | delivery | hub)
// ─────────────────────────────────────────────────────────────────────────────

const { CONFIG }                     = require('./airConfig');
const { SITE, toStaticSite, toEventSite, toPartialEventSite } = require('./airSites');

// ── Dynamic date base (frozen at module load — shared across both test files) ─
const _RUN_BASE_MS = Date.now();

/**
 * Return a fresh ISO-8601 UTC date string offset by `plusSeconds` from the
 * moment this module was loaded.  Unique across test runs by construction.
 *
 * @param {number} [plusSeconds=0]
 * @returns {string}
 */
const runDate = (plusSeconds = 0) =>
  new Date(_RUN_BASE_MS + plusSeconds * 1000).toISOString();

// ── MAIN event (used in both webhook API tests and field validation tests) ────
const MAIN_EVENT   = 'goods_delivery_compliant_compliant';
const MAIN_DATE    = runDate(1800);  // +30 min — stays ahead of lastChangedAt even after TC001 runs

// ── Type 2 dates (one per event, spaced 1 h apart) ───────────────────────────
const T2_DATES = {
  received_from_shipper:              runDate(3600),   // +1h
  goods_arrived_at_loading_arrived:   runDate(7200),   // +2h
  goods_loading_compliant_compliant:  runDate(10800),  // +3h
  goods_left_loading_left:            runDate(14400),  // +4h
  goods_arrived_at_delivery_arrived:  runDate(18000),  // +5h
  goods_left_delivery_left:           runDate(21600),  // +6h
  documentation_delivered:            runDate(25200),  // +7h
  consignee_notified:                 runDate(28800),  // +8h
};

// ── Type 3 dates (starts-with events) ────────────────────────────────────────
const T3_DATES = {
  goods_loading_non_compliant_damaged:          runDate(32400),  // +9h
  goods_loading_non_realised_cancelled:         runDate(36000),  // +10h
  goods_loading_refused_oversize:               runDate(39600),  // +11h
  goods_delivery_non_compliant_pilferage:       runDate(43200),  // +12h
  goods_delivery_non_realised_recipient_closed: runDate(46800),  // +13h
  goods_delivery_refused_not_ordered:           runDate(50400),  // +14h
};

// ── Type 4 dates (hub slot events) ───────────────────────────────────────────
const T4_DATES = {
  dxbArrived:      runDate(54000),  // +15h      goods_arrived_at_hub_arrived (DXB  → stop1)
  dxbLeft:         runDate(57600),  // +16h      goods_left_hub_left          (DXB  → stop1)
  fraArrived:      runDate(61200),  // +17h      goods_arrived_at_hub_arrived (FRA  → stop2)
  fraLeft:         runDate(62100),  // +17h15m   goods_left_hub_left          (FRA  → stop2)
  sinArrived:      runDate(63000),  // +17h30m   goods_arrived_at_hub_arrived (SIN  → stop3)
  sinLeft:         runDate(63600),  // +17h40m   goods_left_hub_left          (SIN  → stop3)
  amsArrived:      runDate(64200),  // +17h50m   goods_arrived_at_hub_arrived (AMS  → stop4)
  amsLeft:         runDate(64500),  // +17h55m   goods_left_hub_left          (AMS  → stop4)
  deliveryHubDXB:  runDate(64800),  // +18h      goods_arrived_at_delivery_hub_arrived (OR alias)
  deliveryHubLeft: runDate(65400),  // +18h10m   goods_left_delivery_hub_left          (OR alias)
};

// ── Type 5 dates (routing × context) ─────────────────────────────────────────
//  hub     = DXB (stop 1)   hubFRA = FRA (stop 2)
//  hubSIN  = SIN (stop 3)   hubAMS = AMS (stop 4)
const T5_DATES = {
  booked:               { loading: runDate(68400),  delivery: runDate(72000),  hub: runDate(75600),  hubFRA: runDate(76200),  hubSIN: runDate(76800),  hubAMS: runDate(77400)  },
  manifested:           { loading: runDate(79200),  delivery: runDate(82800),  hub: runDate(86400),  hubFRA: runDate(87000),  hubSIN: runDate(87600),  hubAMS: runDate(88200)  },
  eta_event:            { loading: runDate(90000),  delivery: runDate(93600),  hub: runDate(97200),  hubFRA: runDate(97800),  hubSIN: runDate(98400),  hubAMS: runDate(99000)  },
  received_from_flight: { loading: runDate(100800), delivery: runDate(104400), hub: runDate(108000), hubFRA: runDate(108600), hubSIN: runDate(109200), hubAMS: runDate(109800) },
};

// ─────────────────────────────────────────────────────────────────────────────
/**
 * Build a complete Shippeo air-tracking webhook payload.
 *
 * @param {string} event       situation.event value
 * @param {string} date        situation.date (ISO 8601)
 * @param {object} eventSite   event_site object (use toEventSite(SITE.xxx))
 * @param {object} [extras]    optional top-level payload overrides
 * @returns {object}
 */
function makePayload(event, date, eventSite, extras = {}) {
  return {
    order: {
      edi_reference:    CONFIG.MAWB_NUMBER,
      reference:        CONFIG.MAWB_NUMBER,
      url:              'https://view.shippeo.com/orderPublic/test',
      client_reference: CONFIG.CUSTOMER_REF,
    },
    situation: {
      event,
      situation_code:     null,
      justification_code: null,
      date,
    },
    situation_justification: { attributes: { consignmentReference: '3328004' } },
    loading_site:  toStaticSite(SITE.BLR),
    delivery_site: toStaticSite(SITE.BOM),
    event_site: eventSite,
    ...extras,
  };
}

// ── Main payload (shared across both spec files) ──────────────────────────────
// situation_code / justification_code are set here so the BE writes
// deliveryCompliantSituationCode and deliveryCompliantJustificationCode.
const MAIN_SITUATION_CODE     = 'LIV';
const MAIN_JUSTIFICATION_CODE = 'CFM';

const MAIN_PAYLOAD = makePayload(MAIN_EVENT, MAIN_DATE, toEventSite(SITE.BOM), {
  situation: {
    event:              MAIN_EVENT,
    situation_code:     MAIN_SITUATION_CODE,
    justification_code: MAIN_JUSTIFICATION_CODE,
    input_date:         '2025-07-24T10:01:00+00:00',
    date:               MAIN_DATE,
  },
});

module.exports = {
  makePayload,
  runDate,
  MAIN_EVENT,
  MAIN_DATE,
  MAIN_PAYLOAD,
  MAIN_SITUATION_CODE,
  MAIN_JUSTIFICATION_CODE,
  T2_DATES,
  T3_DATES,
  T4_DATES,
  T5_DATES,
  // Re-export SITE helpers for convenience
  SITE,
  toEventSite,
  toStaticSite,
  toPartialEventSite,
};
