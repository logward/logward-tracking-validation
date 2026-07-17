// @ts-check
// ─────────────────────────────────────────────────────────────────────────────
//  helpers/air/airSites.js
//
//  IATA site definitions for AIR tracking tests.
//  Provides raw SITE objects + two shape-converters used in payloads:
//    toStaticSite(s)  → loading_site / delivery_site shape
//    toEventSite(s)   → event_site shape
//
//  NOTE: IATA codes are CASE-SENSITIVE (per QA guide).
// ─────────────────────────────────────────────────────────────────────────────

/** @type {Record<string, any>} */
const SITE = {
  BLR: {                                        // Loading / origin airport
    id: '2Y9GR6Y2', externalID: null,
    description: 'BLR Airport',
    name:         'BLR Airport',
    address_line: 'Whitefield',
    city: 'Bengaluru', zipcode: '560066', country: 'IN',
    position: { lat: 48.69073, lng: 9.193624, latitude: 48.69073, longitude: 9.193624 },
    iata_code: 'BLR',
  },
  BOM: {                                        // Delivery / destination airport
    id: 'N5JP9YM2', externalID: null,
    description: 'Mumbai International Airport',
    name:         'Mumbai International Airport',
    address_line: 'MG ROAD',
    city: 'Mumbai', zipcode: '35212', country: 'IN',
    position: { lat: 33.5635078, lng: -86.751541268647, latitude: 33.5635078, longitude: -86.751541268647 },
    iata_code: 'BOM',
  },
  DXB: {                                        // Hub stop 1 (intermediate)
    id: 'DXB001', externalID: null,
    description: 'Dubai International Airport',
    name:         'Dubai International Airport',
    address_line: 'Airport Road',
    city: 'Dubai', zipcode: '00000', country: 'AE',
    position: { lat: 25.2528, lng: 55.3644, latitude: 25.2528, longitude: 55.3644 },
    iata_code: 'DXB',
  },
  FRA: {                                        // Hub stop 2 (intermediate)
    id: 'FRA001', externalID: null,
    description: 'Frankfurt Airport',
    name:         'Frankfurt Airport',
    address_line: 'Airport Blvd',
    city: 'Frankfurt', zipcode: '560066', country: 'DE',
    position: { lat: 50.0379, lng: 8.5622, latitude: 50.0379, longitude: 8.5622 },
    iata_code: 'FRA',
  },
  SIN: {                                        // Hub stop 3 (intermediate)
    id: 'SIN001', externalID: null,
    description: 'Singapore Changi Airport',
    name:         'Singapore Changi Airport',
    address_line: 'Airport Boulevard',
    city: 'Singapore', zipcode: '819642', country: 'SG',
    position: { lat: 1.3644, lng: 103.9915, latitude: 1.3644, longitude: 103.9915 },
    iata_code: 'SIN',
  },
  AMS: {                                        // Hub stop 4 (intermediate)
    id: 'AMS001', externalID: null,
    description: 'Amsterdam Airport Schiphol',
    name:         'Amsterdam Airport Schiphol',
    address_line: 'Whitefield',
    city: 'Amsterdam', zipcode: '1118CP', country: 'NL',
    position: { lat: 52.3105, lng: 4.7683, latitude: 52.3105, longitude: 4.7683 },
    iata_code: 'AMS',
  },
};

/**
 * Convert a SITE entry → loading_site / delivery_site shape.
 * New slim format — only iata_code + country (routing use only).
 *
 * @param {any} s  SITE entry
 */
function toStaticSite(s) {
  return {
    iata_code: s.iata_code,
    country:   s.country,
  };
}

/**
 * Convert a SITE entry → event_site shape.
 * Includes description, address, city, zipcode, country for hub site field writes.
 * No id, externalID, position or name.
 *
 * @param {any} s  SITE entry
 */
function toEventSite(s) {
  return {
    iata_code:    s.iata_code,
    country:      s.country,
    description:  s.description,
    address_line: s.address_line,
    city:         s.city,
    zipcode:      s.zipcode,
  };
}

/**
 * Build a PARTIAL event_site for targeted single-field updates.
 *
 * iata_code + country are always set (required for hub routing / slot resolution).
 * Only the fields present in `overrides` get their value — every other hub site
 * field is sent as null so the BE writes null instead of the stale value.
 *
 * Usage:
 *   toPartialEventSite(SITE.AMS, { address_line: 'Whitefield' })
 *   // → { iata_code:'AMS', country:'NL', description:null, address_line:'Whitefield', city:null, zipcode:null }
 *
 * @param {any}    s          SITE entry (for iata_code + country)
 * @param {object} overrides  Only the field(s) you want to update, e.g. { zipcode: '560066' }
 */
function toPartialEventSite(s, overrides = {}) {
  return {
    iata_code:    s.iata_code,
    country:      s.country,
    description:  overrides.description  ?? null,
    address_line: overrides.address_line ?? null,
    city:         overrides.city         ?? null,
    zipcode:      overrides.zipcode      ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  HUB_POOL — 10 real international cargo-hub airports.
//  Used by AirEventsOut.spec.js: 4 are picked randomly each run so hub-slot logic
//  is proven with different airport combinations, not just the same 4 codes.
//
//  Shape matches toEventSite() output: iata_code, country, description,
//  address_line, city, zipcode — no id / position needed.
// ─────────────────────────────────────────────────────────────────────────────

const HUB_POOL = [
  { iata_code: 'DXB', country: 'AE', description: 'Dubai International Airport',        address_line: 'Airport Road',              city: 'Dubai',            zipcode: '00000'   },
  { iata_code: 'FRA', country: 'DE', description: 'Frankfurt Airport',                   address_line: 'Airport Blvd',              city: 'Frankfurt',        zipcode: '60547'   },
  { iata_code: 'SIN', country: 'SG', description: 'Singapore Changi Airport',            address_line: 'Airport Boulevard',         city: 'Singapore',        zipcode: '819642'  },
  { iata_code: 'AMS', country: 'NL', description: 'Amsterdam Airport Schiphol',          address_line: 'Evert van de Beekstraat',   city: 'Amsterdam',        zipcode: '1118CP'  },
  { iata_code: 'CDG', country: 'FR', description: 'Paris Charles de Gaulle Airport',     address_line: 'Route de l\'Aeroport',      city: 'Roissy-en-France', zipcode: '95700'   },
  { iata_code: 'LHR', country: 'GB', description: 'London Heathrow Airport',             address_line: 'Longford',                  city: 'London',           zipcode: 'TW6 1EW' },
  { iata_code: 'DOH', country: 'QA', description: 'Hamad International Airport',         address_line: 'Airport Street',            city: 'Doha',             zipcode: '00000'   },
  { iata_code: 'HKG', country: 'HK', description: 'Hong Kong International Airport',     address_line: 'Lantau Island',             city: 'Hong Kong',        zipcode: '999077'  },
  { iata_code: 'NRT', country: 'JP', description: 'Tokyo Narita International Airport',  address_line: '1-1 Furugome',              city: 'Narita',           zipcode: '282-0004'},
  { iata_code: 'ICN', country: 'KR', description: 'Seoul Incheon International Airport', address_line: '272 Gonghang-ro',           city: 'Incheon',          zipcode: '22382'   },
];

/**
 * Pick one random item from any array.
 *
 * @template T
 * @param {T[]} pool
 * @returns {T}
 */
function pickRandom(pool) {
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Pick `n` unique hubs from HUB_POOL (no repeats within a run).
 * Shuffles a copy of the pool and returns the first `n` entries.
 *
 * @param {number} [n=4]
 * @returns {typeof HUB_POOL}
 */
function pickHubs(n = 4) {
  const copy = [...HUB_POOL];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

module.exports = { SITE, toStaticSite, toEventSite, toPartialEventSite, HUB_POOL, pickRandom, pickHubs };
