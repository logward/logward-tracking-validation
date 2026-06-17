// ─────────────────────────────────────────────────────────────────────────────
//  helpers/ocean/oceanSites.js
//
//  Real-world UNLOCODE site definitions for OCEAN tracking tests.
//
//  Journey narrative — China factory → Europe warehouse (≈ 46 days):
//
//    [Pre-Carriage]
//    Day  1  Gate out empty container from inland depot  → SZV_INLAND (Suzhou, CN)
//    Day  3  Pickup / Departure from origin              → SZV_INLAND (Suzhou, CN)
//
//    [Port of Loading]
//    Day  5  Gate In port                                → SHA_POL (Shanghai, CN)
//    Day  7  Vessel loaded + Departed                    → SHA_POL (Shanghai, CN)
//
//    [Transhipment 1 — Asia hub]
//    Day 18  Arrived + Discharged                        → SGP_TSP1 (Singapore)
//    Day 20  Loaded + Departed                           → SGP_TSP1 (Singapore)
//
//    [Transhipment 2 — Middle East hub]
//    Day 32  Arrived + Discharged                        → JEA_TSP2 (Jebel Ali, UAE)
//    Day 34  Loaded + Departed                           → JEA_TSP2 (Jebel Ali, UAE)
//
//    [Transhipment 3 — Mediterranean hub, optional]
//    Day 40  Arrived + Discharged                        → ALG_TSP3 (Algeciras, ES)
//    Day 41  Loaded + Departed                           → ALG_TSP3 (Algeciras, ES)
//
//    [Port of Discharge]
//    Day 44  Arrived + Discharged                        → RTM_POD (Rotterdam, NL)
//
//    [Post-Carriage / Delivery]
//    Day 46  Gate out full + Delivered to consignee      → DUI_INLAND (Duisburg, DE)
//
//  NOTE: UNLOCODEs are CASE-SENSITIVE (uppercase 5-char code).
//
//  Shape converters:
//    toLoadingSite(s)   → loading_site / delivery_site shape
//    toEventSite(s, pt) → event_site shape (pt = optional place_type override)
// ─────────────────────────────────────────────────────────────────────────────

const SITE = {

  // ── Pre-Carriage ─────────────────────────────────────────────────────────────
  // Inland depot near factories in Suzhou, China.
  // This is where the EMPTY container is picked up before being stuffed.
  // Distinct from Shanghai port — 90 km away.
  SZV_INLAND: {
    id: 'SZV001', externalID: null,
    unlocode: 'CNSZV',
    name: 'Suzhou Container Depot',
    city: 'Suzhou', country: 'CN',
    timezone: 'Asia/Shanghai',
    place_type: 'origin_inland_location',
    position: { lat: 31.2989, lng: 120.5853 },
  },

  // Alternative inland origin — Ningbo depot (for tests that need a different origin city)
  NGB_INLAND: {
    id: 'NGB001', externalID: null,
    unlocode: 'CNNIN',
    name: 'Ningbo Container Depot',
    city: 'Ningbo', country: 'CN',
    timezone: 'Asia/Shanghai',
    place_type: 'origin_inland_location',
    position: { lat: 29.868, lng: 121.544 },
  },

  // ── Port of Loading ───────────────────────────────────────────────────────────
  // Shanghai — world's largest container port.
  // Container trucks 90 km from Suzhou depot to Yangshan deep-water port.
  SHA_POL: {
    id: 'SHA001', externalID: null,
    unlocode: 'CNSHA',
    name: 'Shanghai',
    city: 'Shanghai', country: 'CN',
    timezone: 'Asia/Shanghai',
    place_type: 'loading',
    position: { lat: 30.6316, lng: 122.0700 },
  },

  // Alternative POL — Ningbo-Zhoushan port (2nd largest in China)
  NGB_POL: {
    id: 'NGB002', externalID: null,
    unlocode: 'CNNGB',
    name: 'Ningbo',
    city: 'Ningbo', country: 'CN',
    timezone: 'Asia/Shanghai',
    place_type: 'loading',
    position: { lat: 29.746, lng: 122.745 },
  },

  // ── Transhipment 1 — Asia Pacific Hub ────────────────────────────────────────
  // Singapore — primary Asia-Europe transhipment hub.
  // Vessel changes here from a feeder/regional vessel to a large ocean carrier.
  SGP_TSP1: {
    id: 'SGP001', externalID: null,
    unlocode: 'SGSIN',
    name: 'Singapore',
    city: 'Singapore', country: 'SG',
    timezone: 'Asia/Singapore',
    place_type: 'transhipment',
    position: { lat: 1.2897, lng: 103.8501 },
  },

  // Alternative TSP1 — Port Klang, Malaysia (near Kuala Lumpur)
  PKG_TSP1ALT: {
    id: 'PKG001', externalID: null,
    unlocode: 'MYPKG',
    name: 'Port Klang',
    city: 'Port Klang', country: 'MY',
    timezone: 'Asia/Kuala_Lumpur',
    place_type: 'transhipment',
    position: { lat: 3.0319, lng: 101.3951 },
  },

  // ── Transhipment 2 — Middle East Hub ─────────────────────────────────────────
  // Jebel Ali, Dubai — largest port in Middle East, key Asia-Europe waypoint.
  // All major carriers stop here on the Asia-Europe route.
  JEA_TSP2: {
    id: 'JEA001', externalID: null,
    unlocode: 'AEJEA',
    name: 'Jebel Ali',
    city: 'Dubai', country: 'AE',
    timezone: 'Asia/Dubai',
    place_type: 'transhipment',
    position: { lat: 25.0099, lng: 55.0547 },
  },

  // Alternative TSP2 — Colombo, Sri Lanka (Indian Ocean hub)
  CMB_TSP2ALT: {
    id: 'CMB001', externalID: null,
    unlocode: 'LKCMB',
    name: 'Colombo',
    city: 'Colombo', country: 'LK',
    timezone: 'Asia/Colombo',
    place_type: 'transhipment',
    position: { lat: 6.9271, lng: 79.8612 },
  },

  // ── Transhipment 3 — Mediterranean / Atlantic Hub ────────────────────────────
  // Algeciras, Spain — Mediterranean gateway, vessels split for N.Europe vs Med.
  ALG_TSP3: {
    id: 'ALG001', externalID: null,
    unlocode: 'ESALG',
    name: 'Algeciras',
    city: 'Algeciras', country: 'ES',
    timezone: 'Europe/Madrid',
    place_type: 'transhipment',
    position: { lat: 36.1281, lng: -5.4541 },
  },

  // Alternative TSP3 — Port Said, Egypt (Suez Canal entrance)
  PSD_TSP3ALT: {
    id: 'PSD001', externalID: null,
    unlocode: 'EGPSD',
    name: 'Port Said',
    city: 'Port Said', country: 'EG',
    timezone: 'Africa/Cairo',
    place_type: 'transhipment',
    position: { lat: 31.2565, lng: 32.2841 },
  },

  // ── Port of Discharge ─────────────────────────────────────────────────────────
  // Rotterdam — Europe's largest port. Primary discharge for Asia-Europe trade.
  RTM_POD: {
    id: 'RTM001', externalID: null,
    unlocode: 'NLRTM',
    name: 'Rotterdam',
    city: 'Rotterdam', country: 'NL',
    timezone: 'Europe/Amsterdam',
    place_type: 'discharge',
    position: { lat: 51.9225, lng: 4.4792 },
  },

  // Alternative POD — Antwerp, Belgium (2nd largest European port)
  ANR_POD: {
    id: 'ANR001', externalID: null,
    unlocode: 'BEANR',
    name: 'Antwerp',
    city: 'Antwerp', country: 'BE',
    timezone: 'Europe/Brussels',
    place_type: 'discharge',
    position: { lat: 51.2213, lng: 4.3998 },
  },

  // Alternative POD — Hamburg, Germany
  HAM_POD: {
    id: 'HAM001', externalID: null,
    unlocode: 'DEHAM',
    name: 'Hamburg',
    city: 'Hamburg', country: 'DE',
    timezone: 'Europe/Berlin',
    place_type: 'discharge',
    position: { lat: 53.5511, lng: 9.9937 },
  },

  // ── Post-Carriage / Destination Inland ───────────────────────────────────────
  // Duisburg, Germany — Europe's largest inland container port.
  // Containers arrive here by barge/rail from Rotterdam. Final delivery to warehouse.
  DUI_INLAND: {
    id: 'DUI001', externalID: null,
    unlocode: 'DEDUI',
    name: 'Duisburg Inland Port',
    city: 'Duisburg', country: 'DE',
    timezone: 'Europe/Berlin',
    place_type: 'destination_inland_location',
    position: { lat: 51.4344, lng: 6.7623 },
  },

  // Alternative inland destination — Rotterdam Distribution Centre
  RTM_INLAND: {
    id: 'RTM002', externalID: null,
    unlocode: 'NLROT',
    name: 'Rotterdam Distribution Centre',
    city: 'Rotterdam', country: 'NL',
    timezone: 'Europe/Amsterdam',
    place_type: 'destination_inland_location',
    position: { lat: 51.9225, lng: 4.4792 },
  },

};

/**
 * Convert a SITE entry → loading_site / delivery_site shape.
 */
function toLoadingSite(s) {
  return {
    id:           s.id,
    externalID:   s.externalID,
    unlocode:     s.unlocode,
    name:         s.name,
    address_line: null,
    zipcode:      '',
    city:         s.city,
    country:      s.country,
    position:     s.position,
  };
}

/**
 * Convert a SITE entry → event_site shape.
 * @param s           SITE entry
 * @param [placeType] Override the site's default place_type (optional)
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
