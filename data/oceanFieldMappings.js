// ═════════════════════════════════════════════════════════════════════════════
//  data/oceanFieldMappings.js
//
//  OCEAN EVENT → OTU FIELD MAPPING TABLE
//  Source: ocean-order-event-out.json + transformer config (2026-05-19)
//  Reference: Shippeo → Logward Ocean Events Mapping CSV
//
//  Structure:
//    TYPE_1_DIRECT        — fields always written on EVERY event
//    TYPE_2_CONDITIONAL   — per-event / place-type / situation-type field sets
//    TYPE_3_TSP_SLOT      — transhipment slot logic (dynamic N / N-1 slot)
//    REQUIRED_FIELDS      — mandatory fields that MUST be non-null
//    ALL_EVENTS           — flat list of every testable event name
//
//  Discriminators for TYPE_2_CONDITIONAL:
//    events[]       — situation.event (one or more)
//    placeType      — event_site.place_type
//    situationType  — situation.type ('actual' | 'estimated')
//    dataSource     — situation_justification.data_source ('external' | 'shippeo' | null/any)
//    transhipment   — true | false | undefined (undefined = any)
//
//  Used by:
//    tests/ocean/TC001_OceanTracking_Mapping.spec.js  — webhook + field assertion loop
// ═════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
//  REQUIRED FIELDS
//  These must be non-null on the OTU after ANY event.
// ─────────────────────────────────────────────────────────────────────────────
const REQUIRED_FIELDS = [
  'containerNumber',
  'bookingNumber',
];

// ─────────────────────────────────────────────────────────────────────────────
//  TYPE 1 — DIRECT (written on EVERY event)
//
//  Each entry: { atuField, source, required? }
//    atuField  — field name on the OTU object
//    source    — dot-path in the Shippeo payload
//    required  — if true, value must be non-null
// ─────────────────────────────────────────────────────────────────────────────
// NOTE: containerNumber, bookingNumber, billOfLadingNumber, carrierScac are
// set during OTU CREATION (Orders-In) — they are NOT updated by webhook events.
const TYPE_1_DIRECT = [
  // ── Carrier-updated locode (written from every webhook event) ───────────────
  { atuField: 'carrierUpdatedLocodePol', source: 'loading_site.unlocode'  },
  { atuField: 'carrierUpdatedLocodePod', source: 'delivery_site.unlocode' },

  // ── Timezone ────────────────────────────────────────────────────────────────
  { atuField: 'datetime_timezone',       source: 'event_site.timezone' },
];

// ─────────────────────────────────────────────────────────────────────────────
//  TYPE 2 — CONDITIONAL (per event + place_type + situation.type)
//
//  Each entry:
//    stage          — human-readable stage label (Pre-Carriage | POL | POD | Delivery)
//    events[]       — situation.event values (OR logic)
//    placeType      — event_site.place_type
//    situationType  — 'actual' | 'estimated' (situation.type)
//    dataSource?    — 'external' | 'shippeo' | null  (undefined = any)
//    transhipment?  — true = TSP route, false = direct (undefined = any)
//    fields[]       — { atuField, source }
// ─────────────────────────────────────────────────────────────────────────────
const TYPE_2_CONDITIONAL = [

  // ══════════════════════════════════════════════════════════════════════════
  //  PRE-CARRIAGE
  // ══════════════════════════════════════════════════════════════════════════

  {
    stage: 'Pre-Carriage',
    events: ['container_gate_out_empty'],
    placeType: 'origin_inland_location',
    situationType: 'actual',
    fields: [
      { atuField: 'actualGateOutEmptyDepot', source: 'situation.date'           },
      { atuField: 'depotPreCountry',         source: 'event_site.country'       },
      { atuField: 'depotPreLocation',        source: 'event_site.city'          },
      { atuField: 'motGateOutEmpty',         source: 'situation.transport_mode' },
    ],
  },
  {
    stage: 'Pre-Carriage',
    events: ['container_gate_out_empty'],
    placeType: 'origin_inland_location',
    situationType: 'estimated',
    dataSource: 'external',
    fields: [
      { atuField: 'estimatedGateOutEmptyDepot', source: 'situation.date'           },
      { atuField: 'depotPreCountry',            source: 'event_site.country'       },
      { atuField: 'depotPreLocation',           source: 'event_site.city'          },
      { atuField: 'motGateOutEmpty',            source: 'situation.transport_mode' },
    ],
  },

  // gate_out_empty at loading place_type (no transhipment only)
  {
    stage: 'Pre-Carriage',
    events: ['container_gate_out_empty'],
    placeType: 'loading',
    situationType: 'actual',
    transhipment: false,
    fields: [
      { atuField: 'actualGateOutEmptyDepot', source: 'situation.date'           },
      { atuField: 'depotPreCountry',         source: 'event_site.country'       },
      { atuField: 'depotPreLocation',        source: 'event_site.city'          },
      { atuField: 'motGateOutEmpty',         source: 'situation.transport_mode' },
    ],
  },
  {
    stage: 'Pre-Carriage',
    events: ['container_gate_out_empty'],
    placeType: 'loading',
    situationType: 'estimated',
    dataSource: 'external',
    transhipment: false,
    fields: [
      { atuField: 'estimatedGateOutEmptyDepot', source: 'situation.date'           },
      { atuField: 'depotPreCountry',            source: 'event_site.country'       },
      { atuField: 'depotPreLocation',           source: 'event_site.city'          },
      { atuField: 'motGateOutEmpty',            source: 'situation.transport_mode' },
    ],
  },

  {
    stage: 'Pre-Carriage',
    events: ['container_departed'],
    placeType: 'origin_inland_location',
    situationType: 'actual',
    fields: [
      { atuField: 'actualDepartureFromOrigin', source: 'situation.date'           },
      { atuField: 'motPickUpOrigin',           source: 'situation.transport_mode' },
      { atuField: 'pickUpOriginCountry',       source: 'event_site.country'       },
      { atuField: 'pickUpOriginLocation',      source: 'event_site.city'          },
    ],
  },
  {
    stage: 'Pre-Carriage',
    events: ['container_departed'],
    placeType: 'origin_inland_location',
    situationType: 'estimated',
    dataSource: 'external',
    fields: [
      { atuField: 'estimatedDepartureFromOrigin', source: 'situation.date'           },
      { atuField: 'motPickUpOrigin',              source: 'situation.transport_mode' },
      { atuField: 'pickUpOriginCountry',          source: 'event_site.country'       },
      { atuField: 'pickUpOriginLocation',         source: 'event_site.city'          },
    ],
  },

  {
    stage: 'Pre-Carriage',
    events: ['container_loaded'],
    placeType: 'origin_inland_location',
    situationType: 'actual',
    fields: [
      { atuField: 'actualLoadedAtOrigin', source: 'situation.date' },
    ],
  },
  {
    stage: 'Pre-Carriage',
    events: ['container_loaded'],
    placeType: 'origin_inland_location',
    situationType: 'estimated',
    dataSource: 'external',
    fields: [
      { atuField: 'estimatedLoadedAtOrigin', source: 'situation.date' },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  //  POL — Port of Loading
  // ══════════════════════════════════════════════════════════════════════════

  {
    stage: 'POL',
    events: ['container_gate_out_full', 'container_arrived', 'container_gate_in_full'],
    placeType: 'loading',
    situationType: 'actual',
    fields: [
      { atuField: 'actualGateInPol', source: 'situation.date' },
    ],
  },
  {
    stage: 'POL',
    events: ['container_gate_out_full', 'container_arrived', 'container_gate_in_full'],
    placeType: 'loading',
    situationType: 'estimated',
    dataSource: 'external',
    fields: [
      { atuField: 'estimatedGateInPol', source: 'situation.date' },
    ],
  },

  {
    stage: 'POL',
    events: ['container_loaded'],
    placeType: 'loading',
    situationType: 'actual',
    fields: [
      { atuField: 'actualLoadPol', source: 'situation.date' },
    ],
  },
  {
    stage: 'POL',
    events: ['container_loaded'],
    placeType: 'loading',
    situationType: 'estimated',
    dataSource: 'external',
    fields: [
      { atuField: 'estimatedLoadPol', source: 'situation.date' },
    ],
  },

  {
    stage: 'POL',
    events: ['container_departed'],
    placeType: 'loading',
    situationType: 'actual',
    fields: [
      { atuField: 'actualDeparturePol', source: 'situation.date' },
    ],
  },
  {
    stage: 'POL',
    events: ['container_departed'],
    placeType: 'loading',
    situationType: 'estimated',
    dataSource: 'external',
    fields: [
      { atuField: 'estimatedDeparturePol', source: 'situation.date' },
    ],
  },
  {
    stage: 'POL',
    events: ['container_departed'],
    placeType: 'loading',
    situationType: 'estimated',
    dataSource: 'shippeo',
    fields: [
      { atuField: 'predictedDeparturePol', source: 'situation.date' },
    ],
  },

  // POL vessel + leg1 — written when transhipment route, TSP level 1
  // (leg1 = first ocean leg: POL → first TSP or POL → POD on direct routes)
  {
    stage: 'POL',
    events: ['container_loaded', 'container_departed'],
    placeType: 'loading',
    transhipment: true,
    notes: 'TSP level 1 — leg1 vessel and MOT from first loading/departure at POL',
    fields: [
      { atuField: 'leg1Mot',             source: 'situation.transport_mode'                            },
      { atuField: 'leg1VesselImoNumber', source: 'resources[milestoneVessel].identifiers[IMO].value'   },
      { atuField: 'leg1VesselName',      source: 'resources[milestoneVessel].identifiers[LABEL].value' },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  //  POD — Port of Discharge
  // ══════════════════════════════════════════════════════════════════════════

  {
    stage: 'POD',
    events: ['eta_event'],
    placeType: 'discharge',
    situationType: 'estimated',
    dataSource: 'external',
    fields: [
      { atuField: 'estimatedArrivalPod', source: 'situation.date' },
    ],
  },
  {
    stage: 'POD',
    events: ['eta_event'],
    placeType: 'discharge',
    situationType: 'estimated',
    dataSource: 'shippeo',
    fields: [
      { atuField: 'predictedArrivalPod', source: 'situation.date' },
    ],
  },
  {
    stage: 'POD',
    events: ['container_arrived'],
    placeType: 'discharge',
    situationType: 'actual',
    fields: [
      { atuField: 'actualArrivalPod', source: 'situation.date' },
    ],
  },

  {
    stage: 'POD',
    events: ['container_unloaded'],
    placeType: 'discharge',
    situationType: 'actual',
    fields: [
      { atuField: 'actualDischargePod', source: 'situation.date' },
    ],
  },
  {
    stage: 'POD',
    events: ['container_unloaded'],
    placeType: 'discharge',
    situationType: 'estimated',
    dataSource: 'external',
    fields: [
      { atuField: 'estimatedDischargePod', source: 'situation.date' },
    ],
  },
  {
    stage: 'POD',
    events: ['container_unloaded'],
    placeType: 'discharge',
    situationType: 'estimated',
    dataSource: 'shippeo',
    fields: [
      { atuField: 'predictedDischargePod', source: 'situation.date' },
    ],
  },

  {
    stage: 'POD',
    events: ['container_gate_out_full', 'container_gate_in_full', 'container_departed'],
    placeType: 'discharge',
    situationType: 'actual',
    fields: [
      { atuField: 'actualGateOutPod', source: 'situation.date'           },
      { atuField: 'motGateOutPod',    source: 'situation.transport_mode' },
    ],
  },
  {
    stage: 'POD',
    events: ['container_gate_out_full', 'container_gate_in_full', 'container_departed'],
    placeType: 'discharge',
    situationType: 'estimated',
    dataSource: 'external',
    fields: [
      { atuField: 'estimatedGateOutPod', source: 'situation.date' },
    ],
  },
  {
    stage: 'POD',
    events: ['container_gate_out_full'],
    placeType: 'discharge',
    situationType: 'estimated',
    dataSource: 'shippeo',
    fields: [
      { atuField: 'predictedGateOutPod', source: 'situation.date' },
    ],
  },

  {
    stage: 'POD',
    events: ['container_gate_in_empty'],
    placeType: 'discharge',
    situationType: 'actual',
    fields: [
      { atuField: 'actualEmptyReturn', source: 'situation.date'           },
      { atuField: 'motEmptyReturn',    source: 'situation.transport_mode' },
    ],
  },
  {
    stage: 'POD',
    events: ['container_gate_in_empty'],
    placeType: 'discharge',
    situationType: 'estimated',
    dataSource: 'external',
    fields: [
      { atuField: 'estimatedEmptyReturn', source: 'situation.date'           },
      { atuField: 'motEmptyReturn',       source: 'situation.transport_mode' },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  //  DELIVERY — Destination inland location (post-carriage)
  // ══════════════════════════════════════════════════════════════════════════

  {
    stage: 'Delivery',
    events: ['container_arrived'],
    placeType: 'destination_inland_location',
    situationType: 'actual',
    fields: [
      { atuField: 'actualArrivalDestination', source: 'situation.date'    },
      { atuField: 'destinationCity',          source: 'event_site.city'   },
      { atuField: 'destinationCountry',       source: 'event_site.country'},
    ],
  },
  {
    stage: 'Delivery',
    events: ['container_arrived'],
    placeType: 'destination_inland_location',
    situationType: 'estimated',
    dataSource: 'external',
    fields: [
      { atuField: 'estimatedArrivalDestination', source: 'situation.date'    },
      { atuField: 'destinationCity',             source: 'event_site.city'   },
      { atuField: 'destinationCountry',          source: 'event_site.country'},
    ],
  },

  {
    stage: 'Delivery',
    events: ['container_gate_in_empty'],
    placeType: 'destination_inland_location',
    situationType: 'actual',
    fields: [
      { atuField: 'actualEmptyReturn', source: 'situation.date'           },
      { atuField: 'motEmptyReturn',    source: 'situation.transport_mode' },
    ],
  },
  {
    stage: 'Delivery',
    events: ['container_gate_in_empty'],
    placeType: 'destination_inland_location',
    situationType: 'estimated',
    dataSource: 'external',
    fields: [
      { atuField: 'estimatedEmptyReturn', source: 'situation.date'           },
      { atuField: 'motEmptyReturn',       source: 'situation.transport_mode' },
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
//  TYPE 3 — TSP SLOT (transhipment, dynamic slot assignment by UNLOCODE)
//
//  Events: container_arrived | container_unloaded | container_departed | container_loaded
//  place_type: transhipment
//
//  Slot assignment (see oceanTspHelpers.js — resolveTspSlot):
//    ① scan tsp_Locode_1–4: UNLOCODE match → reuse slot N
//    ② first empty slot → assign it
//    ③ all 4 occupied, no match → silent drop (overflow)
//
//  Arrival/discharge events  → date + locode written at slot N
//  Departure/loading events  → date + locode written at slot N-1
//
//  Vessel legs (milestoneVessel):
//    Arrival/discharge  → leg_VesselImoNumber_N   (vessel that brought the container)
//    Departure/loading  → leg_VesselImoNumber_N   (vessel that will take it next)
//                         (N here is the leg index, not the TSP slot; see tspVesselLegFields)
// ─────────────────────────────────────────────────────────────────────────────
const TYPE_3_TSP_SLOT = {
  // Events where date/locode are written at slot N (arrival at this TSP)
  slotN_events: ['container_arrived', 'container_unloaded'],

  // Events where date/locode are written at slot N-1 (departure FROM this TSP)
  slotN1_events: ['container_departed', 'container_loaded'],

  // Fields at slot N — date field name depends on event + situationType + dataSource
  dateFieldAtN: (event, n, situationType, dataSource) => {
    const prefix =
      event === 'container_arrived'  ? (situationType === 'actual' ? 'actualArrivalTsp_'    : dataSource === 'shippeo' ? 'predictedArrivalTsp_'    : 'estimatedArrivalTsp_')
    : event === 'container_unloaded' ? (situationType === 'actual' ? 'actualDischargeTsp_'  : dataSource === 'shippeo' ? 'predictedDischargeTsp_'  : 'estimatedDischargeTsp_')
    : null;
    return prefix ? `${prefix}${n}` : null;
  },

  // Fields at slot N-1 — date field name depends on event + situationType + dataSource
  dateFieldAtN1: (event, prevSlot, situationType, dataSource) => {
    const prefix =
      event === 'container_departed' ? (situationType === 'actual' ? 'actualDepartureTsp_'  : dataSource === 'shippeo' ? 'predictedDepartureTsp_'  : 'estimatedDepartureTsp_')
    : event === 'container_loaded'   ? (situationType === 'actual' ? 'actualLoadTsp_'        : dataSource === 'shippeo' ? 'predictedLoadTsp_'        : 'estimatedLoadTsp_')
    : null;
    return prefix ? `${prefix}${prevSlot}` : null;
  },

  // Fixed field names (slot-indexed)
  locodeField:    (n)   => `tsp_Locode_${n}`,
  vesselImoField: (n)   => `leg_VesselImoNumber_${n}`,
  vesselNameField:(n)   => `leg_VesselName_${n}`,
};

// ─────────────────────────────────────────────────────────────────────────────
//  FLAT LIST OF ALL TESTABLE EVENTS
// ─────────────────────────────────────────────────────────────────────────────
const ALL_EVENTS = [
  // Pre-Carriage
  'container_gate_out_empty',
  'container_departed',
  'container_loaded',

  // POL
  'container_gate_out_full',
  'container_arrived',
  'container_gate_in_full',

  // TSP (also re-uses container_arrived, container_unloaded, container_departed, container_loaded)
  'container_unloaded',

  // POD
  'eta_event',
  'container_gate_in_empty',
];

module.exports = {
  REQUIRED_FIELDS,
  TYPE_1_DIRECT,
  TYPE_2_CONDITIONAL,
  TYPE_3_TSP_SLOT,
  ALL_EVENTS,
};
