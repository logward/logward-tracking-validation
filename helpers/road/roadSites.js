// ─────────────────────────────────────────────────────────────────────────────
//  helpers/road/roadSites.js
//
//  Site pools and date helpers for Road Events-Out tests.
//  Source: _LIDL__Events-out_Mapping_-_Road.xlsx
// ─────────────────────────────────────────────────────────────────────────────

const LOADING_SITES = [
  { name: 'Oosterhout', address: 'Energieweg 10',    zipcode: '4906 CG', city: 'Oosterhout', country: 'NL', lat: 51.658648, lng: 4.840261 },
  { name: 'Rotterdam',  address: 'Waalhaven ZZ 15',  zipcode: '3089 JH', city: 'Rotterdam',  country: 'NL', lat: 51.893712, lng: 4.445623 },
  { name: 'Hamburg',    address: 'Hafenstrasse 12',  zipcode: '20459',   city: 'Hamburg',    country: 'DE', lat: 53.545445, lng: 9.918592 },
  { name: 'Antwerp',    address: 'Kaai 203',         zipcode: '2030',    city: 'Antwerp',    country: 'BE', lat: 51.236775, lng: 4.415369 },
  { name: 'Lyon',       address: 'Quai de la Saone', zipcode: '69001',   city: 'Lyon',       country: 'FR', lat: 45.764043, lng: 4.835659 },
];

const DELIVERY_SITES = [
  { name: 'Stuttgart LIDL', address: 'Strutstrasse 21',  zipcode: '73061', city: 'Ebersbach an der Fils', country: 'DE', lat: 48.719203, lng: 9.511021  },
  { name: 'Munich LIDL',    address: 'Landsberger Str.', zipcode: '80339', city: 'Munich',                country: 'DE', lat: 48.135125, lng: 11.581981 },
  { name: 'Berlin LIDL',    address: 'Karl-Marx-Str.',   zipcode: '12043', city: 'Berlin',                country: 'DE', lat: 52.486450, lng: 13.432220 },
  { name: 'Vienna LIDL',    address: 'Praterstrasse 1',  zipcode: '1020',  city: 'Vienna',                country: 'AT', lat: 48.218812, lng: 16.412899 },
  { name: 'Prague LIDL',    address: 'Vaclavske nam.',   zipcode: '11000', city: 'Prague',                country: 'CZ', lat: 50.081656, lng: 14.420016 },
];

/**
 * Generate a stage date for road event payloads.
 * @param daysFromToday  Negative = past, positive = future
 * @param hours          UTC hour for the date
 */
function stageDate(daysFromToday, hours = 8) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  d.setUTCHours(hours, 0, 0, 0);
  return d.toISOString();
}

function pick(pool) {
  return pool[Math.floor(Math.random() * pool.length)];
}

const STAGE_DATES = {
  drivingToLoad:     stageDate(-3, 6),
  arrivedAtPickUp:   stageDate(-2, 10),
  loaded:            stageDate(-2, 14),
  leftLoading:       stageDate(-2, 16),
  drivingToDelivery: stageDate(-1, 8),
  arrivedAtDelivery: stageDate(0,  9),
  delivered:         stageDate(0,  11),
  leftDelivery:      stageDate(0,  12),
  etaPickUp:         stageDate(-1, 6),
  etaDelivery:       stageDate(0,  7),
};

module.exports = { LOADING_SITES, DELIVERY_SITES, STAGE_DATES, stageDate, pick };
