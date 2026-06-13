// ─────────────────────────────────────────────────────────────────────────────
//  helpers/ocean/oceanEventsValidator.js
//
//  Shared mapping assertion helper for Ocean Events-Out tests.
//  Used by OceanOrdersIn.spec.js and E2E_Ocean.spec.js.
//
//  Core idea:
//    - Pick RANDOM locations from a pool each run (not hardcoded)
//    - Send those specific locations in the webhook event
//    - Assert the OTU stored EXACTLY those values (proves mapping is live)
//
//  Functions:
//    pickRandom(pool)                      — pick a random item from array
//    randomSite(placeType)                 — random location as event_site
//    randomLoadingOrDeliverySite()         — random loading/delivery site
//    assertMappingCondition(otu, spec)     — core assertion with console output
//    buildGateOutEmptySpec(eventSite, loadingUnlocode, deliveryUnlocode)
//    buildDeparturePOLSpec()
//    buildArrivalPODSpec()
//    buildDeliveryArrivalSpec(eventSite)
// ─────────────────────────────────────────────────────────────────────────────

const { expect } = require('@playwright/test');

// ─────────────────────────────────────────────────────────────────────────────
//  Vessel pool — real container vessels with IMO + MMSI
// ─────────────────────────────────────────────────────────────────────────────

const VESSEL_POOL = [
  { imo: '9864239',  mmsi: '636023646', name: 'ZEUS LUMOS'          },
  { imo: '9781726',  mmsi: '477203700', name: 'MSC GAIA'            },
  { imo: '9839284',  mmsi: '255806296', name: 'EVER ALOT'           },
  { imo: '9312280',  mmsi: '566929000', name: 'MAERSK ESSEN'        },
  { imo: '9776418',  mmsi: '215668000', name: 'CMA CGM LOUIS BLERIOT'},
  { imo: '9354923',  mmsi: '477295600', name: 'COSCO SHIPPING ROSE' },
  { imo: '9795045',  mmsi: '477870600', name: 'HAPAG LLOYD BERLIN'  },
  { imo: '9525243',  mmsi: '219021000', name: 'MAERSK STOCKHOLM'    },
  { imo: '9678098',  mmsi: '563085500', name: 'MSC ANNA'            },
  { imo: '9702154',  mmsi: '255805938', name: 'CMA CGM TITAN'       },
  { imo: '9726978',  mmsi: '538005999', name: 'ONE MINATO'          },
  { imo: '9776444',  mmsi: '215667000', name: 'CMA CGM JEAN MERMOZ' },
  { imo: '9839296',  mmsi: '255806297', name: 'EVER ACE'            },
  { imo: '9723397',  mmsi: '477491700', name: 'COSCO SHIPPING VIRGO'},
  { imo: '9525231',  mmsi: '219020000', name: 'MAERSK SENTOSA'      },
  { imo: '9302516',  mmsi: '636018156', name: 'MSC ISTANBUL'        },
  { imo: '9756918',  mmsi: '477777800', name: 'COSCO SHIPPING GEMINI'},
  { imo: '9839271',  mmsi: '255806295', name: 'EVER ALLEY'          },
  { imo: '9795007',  mmsi: '477870400', name: 'HAPAG LLOYD GENOVA'  },
  { imo: '9678103',  mmsi: '563085600', name: 'MSC MAYA'            },
];

/**
 * Pick a random vessel from the pool.
 */
function randomVessel() {
  return VESSEL_POOL[Math.floor(Math.random() * VESSEL_POOL.length)];
}

/**
 * Build the resources array (vessel + milestoneVessel) for a webhook payload.
 */
function vesselResources(vessel) {
  const ids = [
    { qualifier: 'IMO',   value: vessel.imo  },
    { qualifier: 'MMSI',  value: vessel.mmsi },
    { qualifier: 'LABEL', value: vessel.name },
  ];
  return [
    { qualifier: 'vessel',          identifiers: ids },
    { qualifier: 'milestoneVessel', identifiers: ids },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
//  Location pool — real international ports
//  Each entry is compatible with toEventSite() and toLoadingSite() from oceanSites.js
// ─────────────────────────────────────────────────────────────────────────────

const LOCATION_POOL = [
  { id: 'SHA001', externalID: null, unlocode: 'CNSHA', name: 'Shanghai',    city: 'Shanghai',    country: 'CN', timezone: 'Asia/Shanghai',       position: { lat: 31.2304, lng: 121.4737 } },
  { id: 'HAM001', externalID: null, unlocode: 'DEHAM', name: 'Hamburg',     city: 'Hamburg',     country: 'DE', timezone: 'Europe/Berlin',         position: { lat: 53.5511, lng: 9.9937  } },
  { id: 'SGP001', externalID: null, unlocode: 'SGSIN', name: 'Singapore',   city: 'Singapore',   country: 'SG', timezone: 'Asia/Singapore',        position: { lat: 1.2897,  lng: 103.8501 } },
  { id: 'NYC001', externalID: null, unlocode: 'USNYC', name: 'New York',    city: 'New York',    country: 'US', timezone: 'America/New_York',      position: { lat: 40.7128, lng: -74.0060 } },
  { id: 'FXT001', externalID: null, unlocode: 'GBFXT', name: 'Felixstowe',  city: 'Felixstowe',  country: 'GB', timezone: 'Europe/London',          position: { lat: 51.9644, lng: 1.3518  } },
  { id: 'YOK001', externalID: null, unlocode: 'JPYOK', name: 'Yokohama',    city: 'Yokohama',    country: 'JP', timezone: 'Asia/Tokyo',             position: { lat: 35.4437, lng: 139.6380 } },
  { id: 'PUS001', externalID: null, unlocode: 'KRPUS', name: 'Busan',       city: 'Busan',       country: 'KR', timezone: 'Asia/Seoul',             position: { lat: 35.1796, lng: 129.0756 } },
  { id: 'MEL001', externalID: null, unlocode: 'AUMEL', name: 'Melbourne',   city: 'Melbourne',   country: 'AU', timezone: 'Australia/Melbourne',    position: { lat: -37.8136, lng: 144.9631 } },
  { id: 'ANT001', externalID: null, unlocode: 'BEANR', name: 'Antwerp',     city: 'Antwerp',     country: 'BE', timezone: 'Europe/Brussels',        position: { lat: 51.2194, lng: 4.4025  } },
  { id: 'JEA001', externalID: null, unlocode: 'AEJEA', name: 'Jebel Ali',   city: 'Dubai',       country: 'AE', timezone: 'Asia/Dubai',             position: { lat: 25.0099, lng: 55.0547 } },
];

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pick a random item from an array.
 * Excludes optionally — pass excludeUnlocode to avoid picking the same port twice.
 */
function pickRandom(pool, excludeUnlocode) {
  const filtered = excludeUnlocode
    ? pool.filter(l => l.unlocode !== excludeUnlocode)
    : pool;
  return filtered[Math.floor(Math.random() * filtered.length)];
}

/**
 * Return a random location formatted as event_site (with place_type).
 */
function randomSite(placeType) {
  const loc = pickRandom(LOCATION_POOL);
  return {
    id:           loc.id,
    externalID:   null,
    unlocode:     loc.unlocode,
    name:         loc.name,
    address_line: null,
    zipcode:      '',
    city:         loc.city,
    country:      loc.country,
    timezone:     loc.timezone,
    position:     loc.position,
    place_type:   placeType,
  };
}

/**
 * Return a random location formatted as loading_site / delivery_site.
 * Excludes the given unlocode so loading ≠ delivery.
 */
function randomLoadingOrDeliverySite(excludeUnlocode) {
  const loc = pickRandom(LOCATION_POOL, excludeUnlocode);
  return {
    id:           loc.id,
    externalID:   null,
    unlocode:     loc.unlocode,
    name:         loc.name,
    address_line: null,
    zipcode:      '',
    city:         loc.city,
    country:      loc.country,
    position:     loc.position,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Core assertion function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Print the mapping condition and assert each field.
 *
 * @param otu        OTU snapshot from GET after event
 * @param condition  { 'situation.event': '...', 'event_site.place_type': '...', 'situation.type': '...' }
 * @param mappings   [{ source: 'event_site.country', field: 'depotPreCountry', expected: 'DE' }]
 *                   Use type:'date' for date fields (checks truthy, not exact value)
 */
function assertMappingCondition(otu, { condition, mappings }) {
  const BAR = '─'.repeat(66);
  console.log(`\n  ${BAR}`);
  console.log(`  MAPPING ASSERTION`);
  Object.entries(condition).forEach(([k, v]) => {
    console.log(`  ${k.padEnd(26)}= "${v}"`);
  });
  console.log(`  ${BAR}`);

  mappings.forEach(({ source, field, expected, type }) => {
    const actual = otu?.[field];
    let ok;
    if (type === 'date') {
      ok = !!actual && String(actual).length >= 10;
    } else {
      ok = actual === expected;
    }
    const icon = ok ? '✅' : '❌';
    const exp  = type === 'date' ? '<date>' : `"${expected}"`;
    console.log(`  ${source.padEnd(30)} → ${field.padEnd(26)} = "${actual}"  ${icon}`);
    expect(
      ok,
      `[${condition['situation.event']} | ${condition['event_site.place_type']}]\n` +
      `  Shippeo field : ${source}\n` +
      `  Logward key   : ${field}\n` +
      `  Expected       : ${exp}\n` +
      `  Got            : "${actual}"`
    ).toBe(true);
  });
  console.log(`  ${BAR}`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Assertion spec builders — one per event type
// ─────────────────────────────────────────────────────────────────────────────

/**
 * S: container_gate_out_empty + origin_inland_location + actual
 * Maps: date→actualGateOutEmptyDepot, country→depotPreCountry,
 *       city→depotPreLocation, transport_mode→motGateOutEmpty,
 *       loading_site.unlocode→carrierUpdatedLocodePol,
 *       delivery_site.unlocode→carrierUpdatedLocodePod
 */
function buildGateOutEmptySpec(eventSite, loadingUnlocode, deliveryUnlocode) {
  return {
    condition: {
      'situation.event':       'container_gate_out_empty',
      'event_site.place_type': 'origin_inland_location',
      'situation.type':        'actual',
    },
    mappings: [
      { source: 'situation.date',           field: 'actualGateOutEmptyDepot', type: 'date'                        },
      { source: 'event_site.country',       field: 'depotPreCountry',         expected: eventSite.country         },
      { source: 'event_site.city',          field: 'depotPreLocation',        expected: eventSite.city            },
      { source: 'situation.transport_mode', field: 'motGateOutEmpty',         expected: 'ocean'                   },
      { source: 'loading_site.unlocode',    field: 'carrierUpdatedLocodePol', expected: loadingUnlocode           },
      { source: 'delivery_site.unlocode',   field: 'carrierUpdatedLocodePod', expected: deliveryUnlocode          },
    ],
  };
}

/**
 * S: container_departed + loading + actual
 * Maps: date→actualDeparturePol
 */
function buildDeparturePOLSpec() {
  return {
    condition: {
      'situation.event':       'container_departed',
      'event_site.place_type': 'loading',
      'situation.type':        'actual',
    },
    mappings: [
      { source: 'situation.date', field: 'actualDeparturePol', type: 'date' },
    ],
  };
}

/**
 * S: container_arrived + discharge + actual
 * Maps: date→actualArrivalPod
 */
function buildArrivalPODSpec() {
  return {
    condition: {
      'situation.event':       'container_arrived',
      'event_site.place_type': 'discharge',
      'situation.type':        'actual',
    },
    mappings: [
      { source: 'situation.date', field: 'actualArrivalPod', type: 'date' },
    ],
  };
}

/**
 * S: container_arrived + destination_inland_location + actual
 * Maps: date→actualArrivalDestination, city→destinationCity, country→destinationCountry
 */
function buildDeliveryArrivalSpec(eventSite) {
  return {
    condition: {
      'situation.event':       'container_arrived',
      'event_site.place_type': 'destination_inland_location',
      'situation.type':        'actual',
    },
    mappings: [
      { source: 'situation.date',     field: 'actualArrivalDestination', type: 'date'                 },
      { source: 'event_site.city',    field: 'destinationCity',          expected: eventSite.city     },
      { source: 'event_site.country', field: 'destinationCountry',       expected: eventSite.country  },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  LOCATION_POOL,
  pickRandom,
  randomSite,
  randomLoadingOrDeliverySite,
  VESSEL_POOL,
  randomVessel,
  vesselResources,
  assertMappingCondition,
  buildGateOutEmptySpec,
  buildDeparturePOLSpec,
  buildArrivalPODSpec,
  buildDeliveryArrivalSpec,
};
