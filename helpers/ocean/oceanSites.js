// ─────────────────────────────────────────────────────────────────────────────
//  helpers/ocean/oceanSites.js
//
//  UNLOCODE site definitions for OCEAN tracking tests.
//  Provides raw SITE objects + shape-converters used in payloads:
//    toLoadingSite(s)   → loading_site / delivery_site shape
//    toEventSite(s, pt) → event_site shape (pt = place_type override)
//
//  NOTE: UNLOCODEs are CASE-SENSITIVE (uppercase 5-char code).
// ─────────────────────────────────────────────────────────────────────────────

const SITE = {
  NGB_INLAND: {                           // Pre-carriage origin inland depot
    id: '2Y7D58Y2', externalID: null,
    unlocode: 'CNNIN',
    name: 'Ningbo Inland Depot',
    city: 'Ningbo', country: 'CN',
    timezone: 'Asia/Shanghai',
    place_type: 'origin_inland_location',
    position: { lat: 29.868, lng: 121.544 },
  },
  NGB_POL: {                              // Port of Loading — Ningbo, China
    id: '2Y7D58Y2', externalID: null,
    unlocode: 'CNNGB',
    name: 'Ningbo',
    city: 'Ningbo', country: 'CN',
    timezone: 'Asia/Shanghai',
    place_type: 'loading',
    position: { lat: 29.746020011188, lng: 122.74509247087 },
  },
  SGP_TSP1: {                             // Transhipment port 1 — Singapore
    id: 'SGP001', externalID: null,
    unlocode: 'SGSIN',
    name: 'Singapore',
    city: 'Singapore', country: 'SG',
    timezone: 'Asia/Singapore',
    place_type: 'transhipment',
    position: { lat: 1.2897, lng: 103.8501 },
  },
  PKG_TSP2: {                             // Transhipment port 2 — Port Klang, Malaysia
    id: 'PKG002', externalID: null,
    unlocode: 'MYPKG',
    name: 'Port Klang',
    city: 'Port Klang', country: 'MY',
    timezone: 'Asia/Kuala_Lumpur',
    place_type: 'transhipment',
    position: { lat: 3.0319, lng: 101.3951 },
  },
  JEA_TSP3: {                             // Transhipment port 3 — Jebel Ali, UAE
    id: 'JEA003', externalID: null,
    unlocode: 'AEJEA',
    name: 'Jebel Ali',
    city: 'Dubai', country: 'AE',
    timezone: 'Asia/Dubai',
    place_type: 'transhipment',
    position: { lat: 25.0099, lng: 55.0547 },
  },
  HAM_TSP4: {                             // Transhipment port 4 — Hamburg, Germany
    id: 'HAM004', externalID: null,
    unlocode: 'DEHAM',
    name: 'Hamburg',
    city: 'Hamburg', country: 'DE',
    timezone: 'Europe/Berlin',
    place_type: 'transhipment',
    position: { lat: 53.5511, lng: 9.9937 },
  },
  RTM_POD: {                              // Port of Discharge — Rotterdam, Netherlands
    id: 'N9P6MMY2', externalID: null,
    unlocode: 'NLRTM',
    name: 'Rotterdam',
    city: 'Rotterdam', country: 'NL',
    timezone: 'Europe/Amsterdam',
    place_type: 'discharge',
    position: { lat: 52.019370028819, lng: 3.7608814384063 },
  },
  RTM_INLAND: {                           // Post-carriage destination inland
    id: 'RTM_INN', externalID: null,
    unlocode: 'NLROT',
    name: 'Rotterdam Inland',
    city: 'Rotterdam', country: 'NL',
    timezone: 'Europe/Amsterdam',
    place_type: 'destination_inland_location',
    position: { lat: 51.9225, lng: 4.4792 },
  },
};

/**
 * Convert a SITE entry → loading_site / delivery_site shape.
 * Includes id, externalID, unlocode, name, city, country, position.
 *
 * @param s  SITE entry
 */
function toLoadingSite(s) {
  return {
    id:         s.id,
    externalID: s.externalID,
    unlocode:   s.unlocode,
    name:       s.name,
    address_line: null,
    zipcode:    '',
    city:       s.city,
    country:    s.country,
    position:   s.position,
  };
}

/**
 * Convert a SITE entry → event_site shape.
 * Includes unlocode, name, city, country, timezone, place_type.
 * Optionally override place_type.
 *
 * @param s          SITE entry
 * @param [placeType]  Override the default place_type (optional)
 */
function toEventSite(s, placeType) {
  return {
    id:           s.id,
    externalID:   s.externalID,
    unlocode:     s.unlocode,
    name:         s.name,
    address_line: null,
    zipcode:      '',
    city:         s.city,
    country:      s.country,
    timezone:     s.timezone,
    position:     s.position,
    place_type:   placeType || s.place_type,
  };
}

module.exports = { SITE, toLoadingSite, toEventSite };
