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
//  Stage-aware location pools — real ports organised by journey stage.
//
//  Real-world China→Europe container route:
//    Origin Inland → POL (China coast) → TSP hubs → POD (Europe) → Dest Inland
//
//  Using the same pool for every stage caused Hamburg (a European discharge
//  port) to appear as origin inland depot, and the same city to land in both
//  TSP and depot slots. Each pool below only contains locations that are
//  geographically and logistically correct for that stage.
// ─────────────────────────────────────────────────────────────────────────────

// Inland depots / factory areas in Asia — where empty containers are picked up
const INLAND_ORIGIN_POOL = [
  { id: 'SZV001', externalID: null, unlocode: 'CNSZV', name: 'Suzhou Depot',      city: 'Suzhou',      country: 'CN', timezone: 'Asia/Shanghai',   position: { lat: 31.2989, lng: 120.5853 } },
  { id: 'NGB001', externalID: null, unlocode: 'CNNIN', name: 'Ningbo Depot',       city: 'Ningbo',      country: 'CN', timezone: 'Asia/Shanghai',   position: { lat: 29.8680, lng: 121.5440 } },
  { id: 'GZH001', externalID: null, unlocode: 'CNGZH', name: 'Guangzhou Depot',   city: 'Guangzhou',   country: 'CN', timezone: 'Asia/Shanghai',   position: { lat: 23.1291, lng: 113.2644 } },
  { id: 'TJN001', externalID: null, unlocode: 'CNTJN', name: 'Tianjin Depot',     city: 'Tianjin',     country: 'CN', timezone: 'Asia/Shanghai',   position: { lat: 39.3434, lng: 117.3616 } },
  { id: 'HKG001', externalID: null, unlocode: 'CNHKG', name: 'Shenzhen Depot',    city: 'Shenzhen',    country: 'CN', timezone: 'Asia/Shanghai',   position: { lat: 22.5431, lng: 114.0579 } },
];

// Major container ports used as Port of Loading (China coast)
const POL_POOL = [
  { id: 'SHA001', externalID: null, unlocode: 'CNSHA', name: 'Shanghai',           city: 'Shanghai',    country: 'CN', timezone: 'Asia/Shanghai',   position: { lat: 30.6316, lng: 122.0700 } },
  { id: 'NGB002', externalID: null, unlocode: 'CNNGB', name: 'Ningbo',             city: 'Ningbo',      country: 'CN', timezone: 'Asia/Shanghai',   position: { lat: 29.7460, lng: 122.7450 } },
  { id: 'SZX001', externalID: null, unlocode: 'CNSZX', name: 'Shenzhen',           city: 'Shenzhen',    country: 'CN', timezone: 'Asia/Shanghai',   position: { lat: 22.5253, lng: 113.9425 } },
  { id: 'QDO001', externalID: null, unlocode: 'CNQDO', name: 'Qingdao',            city: 'Qingdao',     country: 'CN', timezone: 'Asia/Shanghai',   position: { lat: 36.0671, lng: 120.3826 } },
  { id: 'YOK001', externalID: null, unlocode: 'JPYOK', name: 'Yokohama',           city: 'Yokohama',    country: 'JP', timezone: 'Asia/Tokyo',       position: { lat: 35.4437, lng: 139.6380 } },
  { id: 'PUS001', externalID: null, unlocode: 'KRPUS', name: 'Busan',              city: 'Busan',       country: 'KR', timezone: 'Asia/Seoul',       position: { lat: 35.1796, lng: 129.0756 } },
];

// Transhipment hubs — ports where cargo transfers between vessels
const TSP_PORT_POOL = [
  { id: 'SGP001', externalID: null, unlocode: 'SGSIN', name: 'Singapore',          city: 'Singapore',   country: 'SG', timezone: 'Asia/Singapore',  position: { lat: 1.2897,  lng: 103.8501 } },
  { id: 'PKG001', externalID: null, unlocode: 'MYPKG', name: 'Port Klang',         city: 'Port Klang',  country: 'MY', timezone: 'Asia/Kuala_Lumpur',position: { lat: 3.0319,  lng: 101.3951 } },
  { id: 'JEA001', externalID: null, unlocode: 'AEJEA', name: 'Jebel Ali',          city: 'Dubai',       country: 'AE', timezone: 'Asia/Dubai',       position: { lat: 25.0099, lng: 55.0547  } },
  { id: 'CMB001', externalID: null, unlocode: 'LKCMB', name: 'Colombo',            city: 'Colombo',     country: 'LK', timezone: 'Asia/Colombo',     position: { lat: 6.9271,  lng: 79.8612  } },
  { id: 'ALG001', externalID: null, unlocode: 'ESALG', name: 'Algeciras',          city: 'Algeciras',   country: 'ES', timezone: 'Europe/Madrid',    position: { lat: 36.1281, lng: -5.4541  } },
  { id: 'PSD001', externalID: null, unlocode: 'EGPSD', name: 'Port Said',          city: 'Port Said',   country: 'EG', timezone: 'Africa/Cairo',     position: { lat: 31.2565, lng: 32.2841  } },
];

// Port of Discharge — European + North American ports
const POD_POOL = [
  { id: 'RTM001', externalID: null, unlocode: 'NLRTM', name: 'Rotterdam',          city: 'Rotterdam',   country: 'NL', timezone: 'Europe/Amsterdam', position: { lat: 51.9225, lng: 4.4792   } },
  { id: 'ANR001', externalID: null, unlocode: 'BEANR', name: 'Antwerp',            city: 'Antwerp',     country: 'BE', timezone: 'Europe/Brussels',  position: { lat: 51.2194, lng: 4.4025   } },
  { id: 'HAM001', externalID: null, unlocode: 'DEHAM', name: 'Hamburg',            city: 'Hamburg',     country: 'DE', timezone: 'Europe/Berlin',    position: { lat: 53.5511, lng: 9.9937   } },
  { id: 'FXT001', externalID: null, unlocode: 'GBFXT', name: 'Felixstowe',         city: 'Felixstowe',  country: 'GB', timezone: 'Europe/London',    position: { lat: 51.9644, lng: 1.3518   } },
  { id: 'GDK001', externalID: null, unlocode: 'DEGDK', name: 'Gdansk',             city: 'Gdansk',      country: 'PL', timezone: 'Europe/Warsaw',    position: { lat: 54.3520, lng: 18.6466  } },
  { id: 'NYC001', externalID: null, unlocode: 'USNYC', name: 'New York',           city: 'New York',    country: 'US', timezone: 'America/New_York', position: { lat: 40.7128, lng: -74.0060 } },
  { id: 'MEL001', externalID: null, unlocode: 'AUMEL', name: 'Melbourne',          city: 'Melbourne',   country: 'AU', timezone: 'Australia/Melbourne',position:{ lat: -37.8136,lng: 144.9631 } },
];

// Inland destination depots — warehouses/distribution centres near consignee
const INLAND_DEST_POOL = [
  { id: 'DUI001', externalID: null, unlocode: 'DEDUI', name: 'Duisburg Depot',     city: 'Duisburg',    country: 'DE', timezone: 'Europe/Berlin',    position: { lat: 51.4344, lng: 6.7623   } },
  { id: 'BRU001', externalID: null, unlocode: 'BEBRU', name: 'Brussels Depot',     city: 'Brussels',    country: 'BE', timezone: 'Europe/Brussels',  position: { lat: 50.8503, lng: 4.3517   } },
  { id: 'FRA001', externalID: null, unlocode: 'DEFRA', name: 'Frankfurt Depot',    city: 'Frankfurt',   country: 'DE', timezone: 'Europe/Berlin',    position: { lat: 50.1109, lng: 8.6821   } },
  { id: 'AMS001', externalID: null, unlocode: 'NLAMS', name: 'Amsterdam Depot',    city: 'Amsterdam',   country: 'NL', timezone: 'Europe/Amsterdam', position: { lat: 52.3676, lng: 4.9041   } },
  { id: 'PAR001', externalID: null, unlocode: 'FRPAR', name: 'Paris Depot',        city: 'Paris',       country: 'FR', timezone: 'Europe/Paris',     position: { lat: 48.8566, lng: 2.3522   } },
];

// Flat pool kept for legacy callers that use randomSite() without a stage
const LOCATION_POOL = [...POL_POOL, ...TSP_PORT_POOL, ...POD_POOL];

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

// Map place_type → the correct geographic pool for that stage.
// Prevents Hamburg (a European discharge port) appearing as an origin inland
// depot, or Singapore (a TSP hub) appearing as a delivery destination.
const POOL_BY_STAGE = {
  'origin_inland_location':      INLAND_ORIGIN_POOL,
  'loading':                     POL_POOL,
  'transhipment':                TSP_PORT_POOL,
  'discharge':                   POD_POOL,
  'destination_inland_location': INLAND_DEST_POOL,
};

/**
 * Return a random location formatted as event_site.
 * Picks from the geographically correct pool for the given place_type.
 * Falls back to LOCATION_POOL if place_type is unknown.
 */
function randomSite(placeType) {
  const pool = POOL_BY_STAGE[placeType] || LOCATION_POOL;
  const loc = pickRandom(pool);
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
 * loading_site picks from POL_POOL; delivery_site picks from POD_POOL.
 * excludeUnlocode prevents the same port being used for both.
 */
function randomLoadingOrDeliverySite(excludeUnlocode, stage = 'loading') {
  const pool = stage === 'discharge' ? POD_POOL : POL_POOL;
  const loc = pickRandom(pool, excludeUnlocode);
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
  INLAND_ORIGIN_POOL,
  POL_POOL,
  TSP_PORT_POOL,
  POD_POOL,
  INLAND_DEST_POOL,
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
