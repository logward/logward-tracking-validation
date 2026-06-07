// @ts-check
// ═════════════════════════════════════════════════════════════════════════════
//  data/airFieldMappings.js
//
//  AIR EVENT → ATU FIELD MAPPING TABLE
//  Equivalent to the "Air Events Mapping V3" Excel / Google-Sheets reference.
//
//  Structure:
//    TYPE_1_DIRECT        — 25 fields always written on EVERY event
//    TYPE_2_EXACT         — per-event field sets for exact-match events
//    TYPE_3_STARTS_WITH   — prefix-match events (justification from suffix)
//    TYPE_4_HUB_SLOT      — hub arrived / left (slot assigned dynamically)
//    TYPE_5_ROUTING       — routing events (prefix from IATA comparison)
//    REQUIRED_FIELDS      — mandatory fields that MUST be non-null
//    ALL_EVENTS           — flat list of every testable event name
//
//  Used by:
//    tests/air/TC002_ObjectValidation.spec.js  — field assertion loop
//    tests/air/TC001_WebhookApi.spec.js        — event list for webhook tests
// ═════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
//  REQUIRED FIELDS
//  These must be non-null on the ATU after ANY event.
// ─────────────────────────────────────────────────────────────────────────────
const REQUIRED_FIELDS = [
  'masterAirWaybillNumber',
  'airCustomerReference',
  'situationEvent',
  'situationDate',
];

// ─────────────────────────────────────────────────────────────────────────────
//  TYPE 1 — DIRECT (written on EVERY event, 25 fields)
//
//  Each entry: { atuField, source, required? }
//    atuField  — field name on the ATU object
//    source    — dot-path in the Shippeo payload
//    required  — if true, value must be non-null (MANDATORY)
// ─────────────────────────────────────────────────────────────────────────────
const TYPE_1_DIRECT = [
  // ── Identifiers ─────────────────────────────────────────────────────────────
  { atuField: 'masterAirWaybillNumber',  source: 'order.edi_reference',                                   required: true  },
  { atuField: 'houseAirWaybillNumber',   source: 'order.edi_reference'                                                     },
  { atuField: 'orderReference',          source: 'order.reference'                                                          },
  { atuField: 'airCustomerReference',    source: 'order.client_reference',                                 required: true  },
  { atuField: 'consignmentReference',    source: 'situation_justification.attributes.consignmentReference'                  },
  { atuField: 'orderUrl',               source: 'order.url'                                                                },

  // ── Loading site (origin) ───────────────────────────────────────────────────
  { atuField: 'loadingSiteName',         source: 'loading_site.name'         },
  { atuField: 'loadingSiteIata',         source: 'loading_site.iata_code'    },
  { atuField: 'loadingSiteAddressLine',  source: 'loading_site.address_line' },
  { atuField: 'loadingSiteCity',         source: 'loading_site.city'         },
  { atuField: 'loadingSiteZipcode',      source: 'loading_site.zipcode'      },
  { atuField: 'loadingSiteCountry',      source: 'loading_site.country'      },

  // ── Delivery site (destination) ─────────────────────────────────────────────
  { atuField: 'deliverySiteName',        source: 'delivery_site.name'         },
  { atuField: 'deliverySiteIata',        source: 'delivery_site.iata_code'    },
  { atuField: 'deliverySiteAddressLine', source: 'delivery_site.address_line' },
  { atuField: 'deliverySiteCity',        source: 'delivery_site.city'         },
  { atuField: 'deliverySiteZipcode',     source: 'delivery_site.zipcode'      },
  { atuField: 'deliverySiteCountry',     source: 'delivery_site.country'      },

  // ── Situation metadata ───────────────────────────────────────────────────────
  { atuField: 'situationEvent',          source: 'situation.event',              required: true },
  { atuField: 'situationDate',           source: 'situation.date',               required: true },
  { atuField: 'situationInputDate',      source: 'situation.input_date'                         },
  { atuField: 'situationCode',           source: 'situation.situation_code'                     },
  { atuField: 'justificationCode',       source: 'situation.justification_code'                 },
  { atuField: 'dateTransmission',        source: 'date_transmission'                             },

  // ── Tags ────────────────────────────────────────────────────────────────────
  { atuField: 'tags',                    source: 'tags'                                          },
];

// ─────────────────────────────────────────────────────────────────────────────
//  TYPE 2 — EXACT MATCH (per-event field sets)
//
//  Standard 7-field set per event (date + 6 event_site fields).
//  goods_delivery_compliant_compliant adds 2 extra fields = 9 total.
//
//  Each entry:
//    event          — situation.event value (exact match)
//    fields[]       — { atuField, source }
//    site           — SITE key to use for event_site ('BLR' | 'BOM' | 'DXB' | 'FRA')
//    notes?         — extra context
// ─────────────────────────────────────────────────────────────────────────────
const TYPE_2_EXACT = [
  {
    event: 'goods_delivery_compliant_compliant',
    site:  'BOM',
    notes: '9 fields — adds SituationCode + JustificationCode (unique to this event)',
    fields: [
      { atuField: 'deliveryCompliantDate',              source: 'situation.date'               },
      { atuField: 'deliveryCompliantSiteDescription',   source: 'event_site.description'       },
      { atuField: 'deliveryCompliantSiteIata',          source: 'event_site.iata_code'         },
      { atuField: 'deliveryCompliantSiteAddressLine',   source: 'event_site.address_line'      },
      { atuField: 'deliveryCompliantSiteCity',          source: 'event_site.city'              },
      { atuField: 'deliveryCompliantSiteZipcode',       source: 'event_site.zipcode'           },
      { atuField: 'deliveryCompliantSiteCountry',       source: 'event_site.country'           },
      { atuField: 'deliveryCompliantSituationCode',     source: 'situation.situation_code'     },
      { atuField: 'deliveryCompliantJustificationCode', source: 'situation.justification_code' },
    ],
  },
  {
    event: 'received_from_shipper',
    site:  'BLR',
    fields: [
      { atuField: 'receivedFromShipperDate',              source: 'situation.date'          },
      { atuField: 'receivedFromShipperSiteDescription',   source: 'event_site.description'  },
      { atuField: 'receivedFromShipperSiteIata',          source: 'event_site.iata_code'    },
      { atuField: 'receivedFromShipperSiteAddressLine',   source: 'event_site.address_line' },
      { atuField: 'receivedFromShipperSiteCity',          source: 'event_site.city'         },
      { atuField: 'receivedFromShipperSiteZipcode',       source: 'event_site.zipcode'      },
      { atuField: 'receivedFromShipperSiteCountry',       source: 'event_site.country'      },
    ],
  },
  {
    event: 'goods_arrived_at_loading_arrived',
    site:  'BLR',
    fields: [
      { atuField: 'loadingArrivedDate',              source: 'situation.date'          },
      { atuField: 'loadingArrivedSiteDescription',   source: 'event_site.description'  },
      { atuField: 'loadingArrivedSiteIata',          source: 'event_site.iata_code'    },
      { atuField: 'loadingArrivedSiteAddressLine',   source: 'event_site.address_line' },
      { atuField: 'loadingArrivedSiteCity',          source: 'event_site.city'         },
      { atuField: 'loadingArrivedSiteZipcode',       source: 'event_site.zipcode'      },
      { atuField: 'loadingArrivedSiteCountry',       source: 'event_site.country'      },
    ],
  },
  {
    event: 'goods_loading_compliant_compliant',
    site:  'BLR',
    fields: [
      { atuField: 'loadingCompliantDate',              source: 'situation.date'          },
      { atuField: 'loadingCompliantSiteDescription',   source: 'event_site.description'  },
      { atuField: 'loadingCompliantSiteIata',          source: 'event_site.iata_code'    },
      { atuField: 'loadingCompliantSiteAddressLine',   source: 'event_site.address_line' },
      { atuField: 'loadingCompliantSiteCity',          source: 'event_site.city'         },
      { atuField: 'loadingCompliantSiteZipcode',       source: 'event_site.zipcode'      },
      { atuField: 'loadingCompliantSiteCountry',       source: 'event_site.country'      },
    ],
  },
  {
    event: 'goods_left_loading_left',
    site:  'BLR',
    fields: [
      { atuField: 'loadingLeftDate',              source: 'situation.date'          },
      { atuField: 'loadingLeftSiteDescription',   source: 'event_site.description'  },
      { atuField: 'loadingLeftSiteIata',          source: 'event_site.iata_code'    },
      { atuField: 'loadingLeftSiteAddressLine',   source: 'event_site.address_line' },
      { atuField: 'loadingLeftSiteCity',          source: 'event_site.city'         },
      { atuField: 'loadingLeftSiteZipcode',       source: 'event_site.zipcode'      },
      { atuField: 'loadingLeftSiteCountry',       source: 'event_site.country'      },
    ],
  },
  {
    event: 'goods_arrived_at_delivery_arrived',
    site:  'BOM',
    fields: [
      { atuField: 'deliveryArrivedDate',              source: 'situation.date'          },
      { atuField: 'deliveryArrivedSiteDescription',   source: 'event_site.description'  },
      { atuField: 'deliveryArrivedSiteIata',          source: 'event_site.iata_code'    },
      { atuField: 'deliveryArrivedSiteAddressLine',   source: 'event_site.address_line' },
      { atuField: 'deliveryArrivedSiteCity',          source: 'event_site.city'         },
      { atuField: 'deliveryArrivedSiteZipcode',       source: 'event_site.zipcode'      },
      { atuField: 'deliveryArrivedSiteCountry',       source: 'event_site.country'      },
    ],
  },
  {
    event: 'goods_left_delivery_left',
    site:  'BOM',
    fields: [
      { atuField: 'deliveryLeftDate',              source: 'situation.date'          },
      { atuField: 'deliveryLeftSiteDescription',   source: 'event_site.description'  },
      { atuField: 'deliveryLeftSiteIata',          source: 'event_site.iata_code'    },
      { atuField: 'deliveryLeftSiteAddressLine',   source: 'event_site.address_line' },
      { atuField: 'deliveryLeftSiteCity',          source: 'event_site.city'         },
      { atuField: 'deliveryLeftSiteZipcode',       source: 'event_site.zipcode'      },
      { atuField: 'deliveryLeftSiteCountry',       source: 'event_site.country'      },
    ],
  },
  {
    event: 'documentation_delivered',
    site:  'BOM',
    fields: [
      { atuField: 'documentationDeliveredDate',              source: 'situation.date'          },
      { atuField: 'documentationDeliveredSiteDescription',   source: 'event_site.description'  },
      { atuField: 'documentationDeliveredSiteIata',          source: 'event_site.iata_code'    },
      { atuField: 'documentationDeliveredSiteAddressLine',   source: 'event_site.address_line' },
      { atuField: 'documentationDeliveredSiteCity',          source: 'event_site.city'         },
      { atuField: 'documentationDeliveredSiteZipcode',       source: 'event_site.zipcode'      },
      { atuField: 'documentationDeliveredSiteCountry',       source: 'event_site.country'      },
    ],
  },
  {
    event: 'consignee_notified',
    site:  'BOM',
    fields: [
      { atuField: 'consigneeNotifiedDate',              source: 'situation.date'          },
      { atuField: 'consigneeNotifiedSiteDescription',   source: 'event_site.description'  },
      { atuField: 'consigneeNotifiedSiteIata',          source: 'event_site.iata_code'    },
      { atuField: 'consigneeNotifiedSiteAddressLine',   source: 'event_site.address_line' },
      { atuField: 'consigneeNotifiedSiteCity',          source: 'event_site.city'         },
      { atuField: 'consigneeNotifiedSiteZipcode',       source: 'event_site.zipcode'      },
      { atuField: 'consigneeNotifiedSiteCountry',       source: 'event_site.country'      },
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
//  TYPE 3 — STARTS-WITH (non_compliant / non_realised / refused)
//
//  Justification field = suffix AFTER the prefix in situation.event.
//  e.g. "goods_loading_non_compliant_DAMAGED" → justification = "damaged"
//
//  Each entry:
//    prefix         — event name prefix used to match (startsWith)
//    site           — SITE key
//    dateField      — ATU field for situation.date
//    iataField      — ATU field for event_site.iata_code
//    justField      — ATU field for justification suffix
//    eventExample   — a real event name to send in tests
//    suffix         — the suffix part of eventExample (= expected justification value)
// ─────────────────────────────────────────────────────────────────────────────
const TYPE_3_STARTS_WITH = [
  {
    prefix:       'goods_loading_non_compliant_',
    site:         'BLR',
    dateField:    'loadingNonCompliantDate',
    iataField:    'loadingNonCompliantSiteIata',
    justField:    'loadingNonCompliantJustification',
    eventExample: 'goods_loading_non_compliant_damaged',
    suffix:       'damaged',
  },
  {
    prefix:       'goods_loading_non_realised_',
    site:         'BLR',
    dateField:    'loadingNonRealisedDate',
    iataField:    'loadingNonRealisedSiteIata',
    justField:    'loadingNonRealisedJustification',
    eventExample: 'goods_loading_non_realised_cancelled',
    suffix:       'cancelled',
  },
  {
    prefix:       'goods_loading_refused_',
    site:         'BLR',
    dateField:    'loadingRefusedDate',
    iataField:    'loadingRefusedSiteIata',
    justField:    'loadingRefusedJustification',
    eventExample: 'goods_loading_refused_oversize',
    suffix:       'oversize',
  },
  {
    prefix:       'goods_delivery_non_compliant_',
    site:         'BOM',
    dateField:    'deliveryNonCompliantDate',
    iataField:    'deliveryNonCompliantSiteIata',
    justField:    'deliveryNonCompliantJustification',
    eventExample: 'goods_delivery_non_compliant_pilferage',
    suffix:       'pilferage',
  },
  {
    prefix:       'goods_delivery_non_realised_',
    site:         'BOM',
    dateField:    'deliveryNonRealisedDate',
    iataField:    'deliveryNonRealisedSiteIata',
    justField:    'deliveryNonRealisedJustification',
    eventExample: 'goods_delivery_non_realised_recipient_closed',
    suffix:       'recipient_closed',
  },
  {
    prefix:       'goods_delivery_refused_',
    site:         'BOM',
    dateField:    'deliveryRefusedDate',
    iataField:    'deliveryRefusedSiteIata',
    justField:    'deliveryRefusedJustification',
    eventExample: 'goods_delivery_refused_not_ordered',
    suffix:       'not_ordered',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
//  TYPE 4 — HUB SLOT (OR match, dynamic stopN)
//
//  Events matched: goods_arrived_at_hub_arrived  OR  goods_arrived_at_delivery_hub_arrived
//                  goods_left_hub_left           OR  goods_left_delivery_hub_left
//
//  Slot assignment (resolveHubSlot):
//    ① scan stop1–4: IATA match → reuse slot
//    ② first empty  → assign it
//    ③ all full, no match → silent drop
//
//  Fields written at stopN:
//    hubArrivedDate_stopN              ← situation.date
//    hubArrivedSiteIata_stopN          ← event_site.iata_code
//    hubArrivedSiteDescription_stopN   ← event_site.description
//    hubArrivedSiteCity_stopN          ← event_site.city
//    hubArrivedSiteCountry_stopN       ← event_site.country
//    hubLeftDate_stopN                 ← situation.date
//    hubLeftSiteIata_stopN             ← event_site.iata_code
// ─────────────────────────────────────────────────────────────────────────────
const TYPE_4_HUB_SLOT = {
  arrivedEvents: [
    'goods_arrived_at_hub_arrived',
    'goods_arrived_at_delivery_hub_arrived',
  ],
  leftEvents: [
    'goods_left_hub_left',
    'goods_left_delivery_hub_left',
  ],
  arrivedFields: (n) => [
    { atuField: `hubArrivedDate_stop${n}`,            source: 'situation.date'         },
    { atuField: `hubArrivedSiteIata_stop${n}`,        source: 'event_site.iata_code'   },
    { atuField: `hubArrivedSiteDescription_stop${n}`, source: 'event_site.description' },
    { atuField: `hubArrivedSiteCity_stop${n}`,        source: 'event_site.city'        },
    { atuField: `hubArrivedSiteCountry_stop${n}`,     source: 'event_site.country'     },
  ],
  leftFields: (n) => [
    { atuField: `hubLeftDate_stop${n}`,     source: 'situation.date'       },
    { atuField: `hubLeftSiteIata_stop${n}`, source: 'event_site.iata_code' },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
//  TYPE 5 — ROUTING (prefix determined at runtime by IATA comparison)
//
//  Events: booked | manifested | eta_event | received_from_flight
//
//  Prefix decision:
//    event_site.iata == ATU.loadingSiteIata   → "loading"
//    event_site.iata == ATU.deliverySiteIata  → "delivery"
//    else                                     → "hub" (slot logic same as Type 4)
//
//  Each entry:
//    event       — situation.event value
//    fieldSuffix — string appended after "loading" / "delivery" / "hub_stopN"
//    atuFields   — { loading, delivery, hub } each as { dateField, iataField }
// ─────────────────────────────────────────────────────────────────────────────
const TYPE_5_ROUTING = [
  {
    event: 'booked',
    atuFields: {
      loading:  { dateField: 'loadingBookedDate',  iataField: 'loadingBookedSiteIata',  descField: 'loadingBookedSiteDescription'  },
      delivery: { dateField: 'deliveryBookedDate', iataField: 'deliveryBookedSiteIata', descField: 'deliveryBookedSiteDescription' },
      hub:      { dateField: (n) => `hubBookedDate_stop${n}`, iataField: (n) => `hubBookedSiteIata_stop${n}` },
    },
  },
  {
    event: 'manifested',
    atuFields: {
      loading:  { dateField: 'loadingManifestedDate',  iataField: 'loadingManifestedSiteIata'  },
      delivery: { dateField: 'deliveryManifestedDate', iataField: 'deliveryManifestedSiteIata' },
      hub:      { dateField: (n) => `hubManifestedDate_stop${n}`, iataField: (n) => `hubManifestedSiteIata_stop${n}` },
    },
  },
  {
    event: 'eta_event',
    atuFields: {
      loading:  { dateField: 'loadingETADate',  iataField: 'loadingETASiteIata'  },
      delivery: { dateField: 'deliveryETADate', iataField: 'deliveryETASiteIata' },
      hub:      { dateField: (n) => `hubETADate_stop${n}`, iataField: (n) => `hubETASiteIata_stop${n}` },
    },
  },
  {
    event: 'received_from_flight',
    atuFields: {
      loading:  { dateField: 'loadingReceivedFromFlightDate',  iataField: 'loadingReceivedFromFlightSiteIata'  },
      delivery: { dateField: 'deliveryReceivedFromFlightDate', iataField: 'deliveryReceivedFromFlightSiteIata' },
      hub:      { dateField: (n) => `hubReceivedFromFlightDate_stop${n}`, iataField: (n) => `hubReceivedFromFlightSiteIata_stop${n}` },
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
//  FLAT LIST OF ALL TESTABLE EVENTS
//  (used by TC001_WebhookApi.spec.js to send every event and verify HTTP 200)
// ─────────────────────────────────────────────────────────────────────────────
const ALL_EVENTS = [
  // Type 2 exact-match
  'goods_delivery_compliant_compliant',
  'received_from_shipper',
  'goods_arrived_at_loading_arrived',
  'goods_loading_compliant_compliant',
  'goods_left_loading_left',
  'goods_arrived_at_delivery_arrived',
  'goods_left_delivery_left',
  'documentation_delivered',
  'consignee_notified',

  // Type 3 starts-with (representative suffixes)
  'goods_loading_non_compliant_damaged',
  'goods_loading_non_realised_cancelled',
  'goods_loading_refused_oversize',
  'goods_delivery_non_compliant_pilferage',
  'goods_delivery_non_realised_recipient_closed',
  'goods_delivery_refused_not_ordered',

  // Type 4 hub slot
  'goods_arrived_at_hub_arrived',
  'goods_arrived_at_delivery_hub_arrived',
  'goods_left_hub_left',
  'goods_left_delivery_hub_left',

  // Type 5 routing
  'booked',
  'manifested',
  'eta_event',
  'received_from_flight',
];

module.exports = {
  REQUIRED_FIELDS,
  TYPE_1_DIRECT,
  TYPE_2_EXACT,
  TYPE_3_STARTS_WITH,
  TYPE_4_HUB_SLOT,
  TYPE_5_ROUTING,
  ALL_EVENTS,
};
