#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  scripts/e2eSession.js
//
//  Interactive E2E Events-Out test session for Logward ↔ Shippeo ocean tracking.
//
//  Usage:
//    node scripts/e2eSession.js
//
//  Session stays alive until user types "finish" or "end test".
//  Generates a consolidated HTML report at the end.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const readline  = require('readline');
const https     = require('https');
const fs        = require('fs');
const path      = require('path');
const { spawn } = require('child_process');

const { getAdminToken }    = require('../helpers/e2e/cognitoAuth');
const { getShippeoToken }  = require('../helpers/e2e/shippeoAuth');
const { E2E_CONFIG }       = require('../helpers/e2e/e2eConfig');

// ─────────────────────────────────────────────────────────────────────────────
//  Terminal colours
// ─────────────────────────────────────────────────────────────────────────────

const C = {
  reset:   '\x1b[0m',  bold:    '\x1b[1m',  dim:    '\x1b[2m',
  cyan:    '\x1b[36m', green:   '\x1b[32m', yellow: '\x1b[33m',
  red:     '\x1b[31m', white:   '\x1b[97m', gray:   '\x1b[90m',
  magenta: '\x1b[35m', blue:    '\x1b[34m',
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(res => rl.question(q, a => res(a.trim())));

function banner(text, icon = '▶') {
  console.log(`\n${C.bold}${C.cyan}${icon} ${text}${C.reset}`);
  console.log(C.gray + '─'.repeat(60) + C.reset);
}

function ok(msg)   { console.log(`  ${C.green}✅ ${msg}${C.reset}`); }
function err(msg)  { console.log(`  ${C.red}❌ ${msg}${C.reset}`); }
function info(msg) { console.log(`  ${C.cyan}ℹ  ${msg}${C.reset}`); }
function warn(msg) { console.log(`  ${C.yellow}⚠  ${msg}${C.reset}`); }
function dim(msg)  { console.log(`  ${C.gray}${msg}${C.reset}`); }

// ─────────────────────────────────────────────────────────────────────────────
//  Session state
// ─────────────────────────────────────────────────────────────────────────────

const session = {
  objectCode:       null,
  containerNumber:  null,
  bookingNumber:    null,
  blNumber:         null,
  carrierScac:      null,
  carrierShortName: null,
  carrierName:      null,
  trackingStatus:   'In Progress',
  shippeoShipment:  null,   // set after Shippeo verification
  shippeoVerified:  false,
  startTime:        Date.now(),
  events:           [],   // { timestamp, event, placeType, fields, status, assertions, duration }
  logs:             [],
};

function log(msg) {
  session.logs.push({ ts: new Date().toISOString(), msg });
  dim(msg);
}

// ─────────────────────────────────────────────────────────────────────────────
//  HTTPS helpers (no Playwright dependency)
// ─────────────────────────────────────────────────────────────────────────────

async function httpGet(hostname, path, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET', headers: { Authorization: `Bearer ${token}`, accept: 'application/json' } }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject); req.end();
  });
}

async function httpPost(hostname, path, headers, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const req  = https.request({ hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) } }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  OTU helpers
// ─────────────────────────────────────────────────────────────────────────────

async function createOTU(fields) {
  const token = await getAdminToken();
  const payload = { data: [{ mot: 'OCEAN', trackingStatus: 'In Progress', tsTracking: false, forwarderInputNeeded: 'No', ...fields }] };
  const url = new URL(E2E_CONFIG.ADMIN_BASE_URL + E2E_CONFIG.OCEAN.UPSERT_PATH + '?createNew=true');
  const res = await httpPost(url.hostname, url.pathname + url.search, { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', accept: 'application/json' }, payload);
  const code = res.body?.meta?.params?.code || res.body?.data?.[0]?.code || null;
  return { code, status: res.status, raw: res.body };
}

async function getOTU(objectCode) {
  const token = await getAdminToken();
  const url   = new URL(E2E_CONFIG.ADMIN_GET_URL + E2E_CONFIG.OCEAN.GET_PATH + '/' + objectCode);
  const res   = await httpGet(url.hostname, url.pathname, token);
  return res.body?.data ?? res.body;
}

async function pollOTUChanged(objectCode, baseline, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2500));
    const otu = await getOTU(objectCode).catch(() => null);
    if (otu?.lastChangedAt && otu.lastChangedAt !== baseline) return otu;
  }
  return await getOTU(objectCode).catch(() => null);
}

async function sendWebhook(payload) {
  const url = new URL(E2E_CONFIG.OCEAN.WEBHOOK_BASE_URL + E2E_CONFIG.OCEAN.WEBHOOK_PATH);
  return httpPost(url.hostname, url.pathname, {
    'Content-Type':  'application/json',
    'clientId':      E2E_CONFIG.OCEAN.WEBHOOK_CLIENT_ID,
    'Authorization': `Bearer ${E2E_CONFIG.OCEAN.WEBHOOK_TOKEN}`,
  }, payload);
}

async function searchShippeo(reference) {
  const token = await getShippeoToken();
  const url   = new URL(E2E_CONFIG.SHIPPEO.baseUrl + E2E_CONFIG.SHIPPEO.searchPath + '?' + E2E_CONFIG.SHIPPEO.searchParamKey + '=' + reference);
  const res   = await httpGet(url.hostname, url.pathname + url.search, token);
  const results = Array.isArray(res.body) ? res.body : (res.body?.data ?? []);
  return results.length ? results[0] : null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Payload builders
// ─────────────────────────────────────────────────────────────────────────────

function stageDate(daysFromToday, hours = 8) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  d.setUTCHours(hours, 0, 0, 0);
  return d.toISOString();
}

function toLocalTime(isoUtc, timezone) {
  if (!isoUtc || !timezone) return null;
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(isoUtc)).replace('T', ' ');
}

function buildPayload(cn, eventOpts) {
  const {
    event,
    date,
    // Accept both 'situationType' and 'sitType' (DIRECT_FIELDS/TSP_FIELDS use sitType)
    situationType: _st, sitType: _stt,
    dataSource = null,
    placeType = 'transhipment', unlocode, timezone, city, country,
    vessel, bookingNumber, blNumber, loadingUnlocode, deliveryUnlocode,
  } = eventOpts;
  const situationType = _st || _stt || 'actual';

  // Use provided loading/delivery locodes or defaults
  const polUnlocode = loadingUnlocode || 'CNNGB';
  const podUnlocode = deliveryUnlocode || 'NLRTM';

  return {
    date_transmission: new Date().toISOString(),
    owner: { organization: { id: 'Q2JK9RVN', name: 'LIDL' }, agency: { id: '82V85L72', name: 'LIDL_Ocean', siret: null } },
    order: { edi_reference: cn, reference: cn, url: 'https://view.shippeo.com/test' },
    tour:  { edi_reference: cn, reference: cn },
    loading_site:  { id: polUnlocode, externalID: null, unlocode: polUnlocode, name: polUnlocode, address_line: null, zipcode: '', city: null, country: null, position: { lat: 0, lng: 0 } },
    delivery_site: { id: podUnlocode, externalID: null, unlocode: podUnlocode, name: podUnlocode, address_line: null, zipcode: '', city: null, country: null, position: { lat: 0, lng: 0 } },
    situation: { event, date: date || stageDate(-5, 8), input_date: date || stageDate(-5, 8), type: situationType, transport_mode: 'ocean' },
    situation_justification: { position: null, attributes: {}, data_source: dataSource, platform_type: 'ocean' },
    // event_site includes city + country so all co-mapped fields get values
    event_site: {
      id: unlocode, externalID: null,
      unlocode: unlocode,
      name: city || unlocode,
      address_line: null, zipcode: '',
      city:    city    || null,   // depotPreLocation, pickUpOriginLocation, destinationCity
      country: country || null,   // depotPreCountry, pickUpOriginCountry, destinationCountry
      timezone: timezone || null,
      position: { lat: 0, lng: 0 },
      place_type: placeType,
    },
    resources: vessel ? [{ qualifier: 'milestoneVessel', identifiers: [{ qualifier: 'IMO', value: vessel.imo }, { qualifier: 'MMSI', value: vessel.mmsi || '636023646' }, { qualifier: 'LABEL', value: vessel.name }] }] : [],
    tags: [], handling_units: [],
    booking_references:        bookingNumber ? [{ reference: bookingNumber }] : (session.bookingNumber ? [{ reference: session.bookingNumber }] : []),
    bill_of_lading_references: blNumber     ? [{ active: 'True', identifier: blNumber }] : (session.blNumber ? [{ active: 'True', identifier: session.blNumber }] : []),
    items: [],
    cargo: { reference: cn, qualifier: 'CONTAINER' },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Field definitions
// ─────────────────────────────────────────────────────────────────────────────

const DIRECT_FIELDS = {
  // ── Pre-Carriage ────────────────────────────────────────────────────────────
  'actualGateOutEmptyDepot':     { stage: 'Pre-Carriage', event: 'container_gate_out_empty', placeType: 'origin_inland_location' },
  'estimatedGateOutEmptyDepot':  { stage: 'Pre-Carriage', event: 'container_gate_out_empty', placeType: 'origin_inland_location', sitType: 'estimated', dataSource: 'external' },
  'actualDepartureFromOrigin':   { stage: 'Pre-Carriage', event: 'container_departed',       placeType: 'origin_inland_location' },
  'estimatedDepartureFromOrigin':{ stage: 'Pre-Carriage', event: 'container_departed',       placeType: 'origin_inland_location', sitType: 'estimated', dataSource: 'external' },
  'actualLoadedAtOrigin':        { stage: 'Pre-Carriage', event: 'container_loaded',         placeType: 'origin_inland_location' },
  'estimatedLoadedAtOrigin':     { stage: 'Pre-Carriage', event: 'container_loaded',         placeType: 'origin_inland_location', sitType: 'estimated', dataSource: 'external' },
  // ── Port of Loading ─────────────────────────────────────────────────────────
  'actualGateInPol':             { stage: 'POL', event: 'container_gate_out_full',  placeType: 'loading' },
  'estimatedGateInPol':          { stage: 'POL', event: 'container_gate_out_full',  placeType: 'loading', sitType: 'estimated', dataSource: 'external' },
  'actualLoadPol':               { stage: 'POL', event: 'container_loaded',         placeType: 'loading' },
  'estimatedLoadPol':            { stage: 'POL', event: 'container_loaded',         placeType: 'loading', sitType: 'estimated', dataSource: 'external' },
  'actualDeparturePol':          { stage: 'POL', event: 'container_departed',       placeType: 'loading' },
  'estimatedDeparturePol':       { stage: 'POL', event: 'container_departed',       placeType: 'loading', sitType: 'estimated', dataSource: 'external' },
  'predictedDeparturePol':       { stage: 'POL', event: 'container_departed',       placeType: 'loading', sitType: 'estimated', dataSource: 'shippeo' },
  // ── Port of Discharge ───────────────────────────────────────────────────────
  'actualArrivalPod':            { stage: 'POD', event: 'container_arrived',        placeType: 'discharge' },
  'estimatedArrivalPod':         { stage: 'POD', event: 'eta_event',                placeType: 'discharge', sitType: 'estimated', dataSource: 'external' },
  'predictedArrivalPod':         { stage: 'POD', event: 'eta_event',                placeType: 'discharge', sitType: 'estimated', dataSource: 'shippeo' },
  'actualDischargePod':          { stage: 'POD', event: 'container_unloaded',       placeType: 'discharge' },
  'estimatedDischargePod':       { stage: 'POD', event: 'container_unloaded',       placeType: 'discharge', sitType: 'estimated', dataSource: 'external' },
  'predictedDischargePod':       { stage: 'POD', event: 'container_unloaded',       placeType: 'discharge', sitType: 'estimated', dataSource: 'shippeo' },
  'actualGateOutPod':            { stage: 'POD', event: 'container_gate_out_full',  placeType: 'discharge' },
  'estimatedGateOutPod':         { stage: 'POD', event: 'container_gate_out_full',  placeType: 'discharge', sitType: 'estimated', dataSource: 'external' },
  'predictedGateOutPod':         { stage: 'POD', event: 'container_gate_out_full',  placeType: 'discharge', sitType: 'estimated', dataSource: 'shippeo' },
  'actualEmptyReturn':           { stage: 'POD', event: 'container_gate_in_empty',  placeType: 'discharge' },
  'estimatedEmptyReturn':        { stage: 'POD', event: 'container_gate_in_empty',  placeType: 'discharge', sitType: 'estimated', dataSource: 'external' },
  // ── Delivery ────────────────────────────────────────────────────────────────
  'actualArrivalDestination':    { stage: 'Delivery', event: 'container_arrived',   placeType: 'destination_inland_location' },
  'estimatedArrivalDestination': { stage: 'Delivery', event: 'container_arrived',   placeType: 'destination_inland_location', sitType: 'estimated', dataSource: 'external' },
};

const TSP_FIELDS = {
  'actualArrivalTsp1':    { event: 'container_arrived',  sitType: 'actual',     dataSource: null },
  'actualDischargeTsp1':  { event: 'container_unloaded', sitType: 'actual',     dataSource: null },
  'actualLoadTsp1':       { event: 'container_loaded',   sitType: 'actual',     dataSource: null },
  'actualDepartureTsp1':  { event: 'container_departed', sitType: 'actual',     dataSource: null },
  'estimatedArrivalTsp1': { event: 'container_arrived',  sitType: 'estimated',  dataSource: 'external' },
  'predictedArrivalTsp1': { event: 'container_arrived',  sitType: 'estimated',  dataSource: 'shippeo' },
  'estimatedLoadTsp1':    { event: 'container_loaded',   sitType: 'estimated',  dataSource: 'external' },
  'predictedLoadTsp1':    { event: 'container_loaded',   sitType: 'estimated',  dataSource: 'shippeo' },
  'tsp1Locode':           { event: 'container_arrived',  sitType: 'actual',     dataSource: null },
  'leg1VesselImoNumber':  { event: 'container_arrived',  sitType: 'actual',     dataSource: null },
  'leg2VesselImoNumber':  { event: 'container_loaded',   sitType: 'actual',     dataSource: null },
};

const TSP_LOCODES = [
  { unlocode: 'SGSIN', timezone: 'Asia/Singapore'    },
  { unlocode: 'MYPKG', timezone: 'Asia/Kuala_Lumpur' },
  { unlocode: 'AEJEA', timezone: 'Asia/Dubai'        },
  { unlocode: 'CNSHA', timezone: 'Asia/Shanghai'     },
  { unlocode: 'DEHAM', timezone: 'Europe/Berlin'     },
];

// Direct event sites — include city + country so depotPreLocation/Country etc. map correctly
const DIRECT_SITES = {
  origin_inland_location: [
    { unlocode: 'CNNGB', city: 'Ningbo',    country: 'CN', timezone: 'Asia/Shanghai'   },
    { unlocode: 'CNSHA', city: 'Shanghai',  country: 'CN', timezone: 'Asia/Shanghai'   },
    { unlocode: 'KRPUS', city: 'Busan',     country: 'KR', timezone: 'Asia/Seoul'      },
    { unlocode: 'DEHAM', city: 'Hamburg',   country: 'DE', timezone: 'Europe/Berlin'   },
  ],
  loading: [
    { unlocode: 'CNNGB', city: 'Ningbo',    country: 'CN', timezone: 'Asia/Shanghai'   },
    { unlocode: 'SGSIN', city: 'Singapore', country: 'SG', timezone: 'Asia/Singapore'  },
    { unlocode: 'KRPUS', city: 'Busan',     country: 'KR', timezone: 'Asia/Seoul'      },
  ],
  discharge: [
    { unlocode: 'NLRTM', city: 'Rotterdam', country: 'NL', timezone: 'Europe/Amsterdam'},
    { unlocode: 'DEHAM', city: 'Hamburg',   country: 'DE', timezone: 'Europe/Berlin'   },
    { unlocode: 'GBFXT', city: 'Felixstowe',country: 'GB', timezone: 'Europe/London'   },
  ],
  destination_inland_location: [
    { unlocode: 'DEHAM', city: 'Hamburg',   country: 'DE', timezone: 'Europe/Berlin'   },
    { unlocode: 'NLAMS', city: 'Amsterdam', country: 'NL', timezone: 'Europe/Amsterdam'},
    { unlocode: 'GBLON', city: 'London',    country: 'GB', timezone: 'Europe/London'   },
  ],
};

const VESSELS = [
  { imo: '9864239', mmsi: '636023646', name: 'ZEUS LUMOS'  },
  { imo: '9999001', mmsi: '636023648', name: 'EVER GIVEN'  },
  { imo: '9999002', mmsi: '636023649', name: 'MAERSK IOWA' },
];

function pickRandom(pool) { return pool[Math.floor(Math.random() * pool.length)]; }

// ─────────────────────────────────────────────────────────────────────────────
//  Event execution + assertion
// ─────────────────────────────────────────────────────────────────────────────

async function executeEvent(eventOpts) {
  const cn     = eventOpts.containerNumber || session.containerNumber;
  const vessel = eventOpts.vessel || pickRandom(VESSELS);
  const date   = eventOpts.date  || stageDate(-5, 8);
  const pType  = eventOpts.placeType || 'transhipment';

  // Pick site with city + country — critical for field mapping
  let site;
  if (pType === 'transhipment') {
    const tspRaw = eventOpts.tsp || pickRandom(TSP_LOCODES);
    site = { unlocode: tspRaw.unlocode, city: null, country: null, timezone: tspRaw.timezone };
  } else {
    const pool = DIRECT_SITES[pType] || DIRECT_SITES['discharge'];
    site = eventOpts.site || pickRandom(pool);
    console.log(`  ${C.gray}→ Site: ${site.unlocode} (${site.city}, ${site.country})${C.reset}`);
  }

  // Pick random loading (POL) and delivery (POD) locodes for carrierUpdatedLocode fields
  const polSite = pickRandom(DIRECT_SITES['loading']);
  const podSite = pickRandom(DIRECT_SITES['discharge']);

  const merged = {
    ...eventOpts,
    unlocode: site.unlocode,
    // Respect explicitly passed city/country (including null for negative tests).
    // 'city' in eventOpts is true even when city === null — don't override with site.city.
    city:    'city'    in eventOpts ? eventOpts.city    : site.city,
    country: 'country' in eventOpts ? eventOpts.country : site.country,
    timezone: site.timezone,
    vessel,
    date,
    loadingUnlocode:  polSite.unlocode,
    deliveryUnlocode: podSite.unlocode,
  };

  const payload   = buildPayload(cn, merged);
  const otuBefore = await getOTU(session.objectCode).catch(() => null);
  const baseline  = otuBefore?.lastChangedAt ?? null;

  console.log(`\n  ${C.dim}Sending webhook...${C.reset}`);
  const t0 = Date.now();
  const wh = await sendWebhook(payload);
  console.log(`  ${C.gray}HTTP ${wh.status}${C.reset}`);

  // For negative tests: wait briefly then fetch OTU — field should NOT change
  // For positive tests: poll until OTU changes
  const isNegative = eventOpts.flowType === 'negative';
  let otuAfter;
  if (isNegative) {
    await new Promise(r => setTimeout(r, 5000));  // brief wait to let any (unwanted) change propagate
    otuAfter = await getOTU(session.objectCode).catch(() => null);
  } else {
    otuAfter = await pollOTUChanged(session.objectCode, baseline, 25000);
  }
  const duration = Date.now() - t0;

  // Build assertions — pass otuBefore for before/after comparison in negative tests
  const assertions = buildAssertions(merged, otuAfter, { date, site, vessel, polSite, podSite, otuBefore, isNegative });

  const allPass = assertions.every(a => a.pass);
  const resolvedSitType = eventOpts.situationType || eventOpts.sitType || 'actual';
  const result  = { timestamp: new Date().toISOString(), event: eventOpts.event, placeType: eventOpts.placeType || 'transhipment', situationType: resolvedSitType, dataSource: eventOpts.dataSource, flowType: eventOpts.flowType, webhookStatus: wh.status, assertions, pass: allPass && wh.status === 200, duration };
  session.events.push(result);
  return result;
}

// Returns all Logward fields that would be written by a given event+placeType in positive mode.
// Used by negative tests to assert none of them changed.
function getExpectedFields(event, placeType) {
  // Vessel maps ONLY for: POL (container_loaded at loading), POD (discharge events), TSP
  // Pre-Carriage and Delivery: vessel in payload but NOT written to leg1Vessel fields
  const map = {
    'origin_inland_location': {
      // No vessel fields — vessel is in payload but NOT mapped for Pre-Carriage
      'container_gate_out_empty': ['actualGateOutEmptyDepot', 'estimatedGateOutEmptyDepot', 'depotPreLocation', 'depotPreCountry', 'motGateOutEmpty'],
      'container_departed':       ['actualDepartureFromOrigin', 'estimatedDepartureFromOrigin', 'pickUpOriginLocation', 'pickUpOriginCountry', 'motPickUpOrigin'],
      'container_loaded':         ['actualLoadedAtOrigin', 'estimatedLoadedAtOrigin'],
    },
    'loading': {
      'container_gate_out_full':  ['actualGateInPol', 'estimatedGateInPol'],
      'container_loaded':         ['actualLoadPol', 'estimatedLoadPol', 'leg1Mot', 'leg1VesselImoNumber', 'leg1VesselName'],
      'container_departed':       ['actualDeparturePol', 'estimatedDeparturePol', 'predictedDeparturePol'],
    },
    'discharge': {
      'container_arrived':        ['actualArrivalPod', 'trackingArrivingVesselImo', 'trackingArrivingVesselVesselName'],
      'eta_event':                ['estimatedArrivalPod', 'predictedArrivalPod', 'trackingArrivingVesselImo', 'trackingArrivingVesselVesselName'],
      'container_unloaded':       ['actualDischargePod', 'estimatedDischargePod', 'predictedDischargePod', 'trackingArrivingVesselImo', 'trackingArrivingVesselVesselName'],
      'container_gate_out_full':  ['actualGateOutPod', 'estimatedGateOutPod', 'predictedGateOutPod', 'motGateOutPod'],
      'container_gate_in_empty':  ['actualEmptyReturn', 'estimatedEmptyReturn', 'motEmptyReturn'],
    },
    'destination_inland_location': {
      // No vessel fields — vessel is in payload but NOT mapped for Delivery
      'container_arrived':        ['actualArrivalDestination', 'estimatedArrivalDestination', 'destinationCity', 'destinationCountry'],
    },
    'transhipment': {
      'container_arrived':        ['tsp1Locode', 'actualArrivalTsp1', 'estimatedArrivalTsp1', 'predictedArrivalTsp1', 'leg1VesselImoNumber', 'leg1VesselName'],
      'container_unloaded':       ['tsp1Locode', 'actualDischargeTsp1', 'estimatedDischargeTsp1', 'predictedDischargeTsp1', 'leg1VesselImoNumber', 'leg1VesselName'],
      'container_loaded':         ['tsp1Locode', 'actualLoadTsp1', 'estimatedLoadTsp1', 'predictedLoadTsp1', 'leg2VesselImoNumber', 'leg2VesselName'],
      'container_departed':       ['tsp1Locode', 'actualDepartureTsp1', 'estimatedDepartureTsp1', 'predictedDepartureTsp1', 'leg2VesselImoNumber', 'leg2VesselName'],
    },
  };
  return map[placeType]?.[event] || [];
}

function buildAssertions(opts, otu, { date, site, vessel, polSite, podSite, otuBefore, isNegative }) {
  const assertions = [];

  // ── Positive helpers ────────────────────────────────────────────────────────
  const checkTruthy = (field) => {
    const actual = otu?.[field] ?? null;
    assertions.push({ field, expected: 'set', actual, pass: !!actual });
  };
  const checkExact = (field, expected) => {
    const actual = otu?.[field] ?? null;
    const pass   = actual === expected;
    assertions.push({ field, expected, actual, pass });
  };

  // ── Negative helper: field must NOT have changed ───────────────────────────
  // Universal rule: before === after means this event did not write the field.
  // Works even if a prior positive event already set the field.
  const checkNotChanged = (field) => {
    const before = otuBefore?.[field] ?? null;
    const after  = otu?.[field] ?? null;
    const pass   = before === after;
    assertions.push({
      field,
      expected: `unchanged (was: ${before ?? 'null'})`,
      actual:   after,
      pass,
      negativeCheck: true,
    });
  };

  const pType = opts.placeType || 'transhipment';
  const event = opts.event;
  const sitType   = opts.sitType   || 'actual';
  const dataSource= opts.dataSource ?? null;

  // ── If negative flow: assert ALL mappable fields for this event are unchanged ─
  if (isNegative) {
    // Determine which fields this event WOULD have written in positive mode
    const wouldWrite = getExpectedFields(event, pType);
    for (const field of wouldWrite) {
      checkNotChanged(field);
    }
    // Always-on fields (carrierUpdatedLocode) still update — just show them as info
    if (polSite) assertions.push({ field: 'carrierUpdatedLocodePol', expected: polSite.unlocode, actual: otu?.carrierUpdatedLocodePol, pass: true, info: true });
    if (podSite) assertions.push({ field: 'carrierUpdatedLocodePod', expected: podSite.unlocode, actual: otu?.carrierUpdatedLocodePod, pass: true, info: true });
    return assertions;
  }

  // ── TSP events ────────────────────────────────────────────────────────────
  if (pType === 'transhipment') {
    checkExact('tsp1Locode', site.unlocode);
    if (sitType === 'actual' && !dataSource) {
      if (event === 'container_arrived')  checkTruthy('actualArrivalTsp1');
      if (event === 'container_unloaded') checkTruthy('actualDischargeTsp1');
      if (event === 'container_loaded')   checkTruthy('actualLoadTsp1');
      if (event === 'container_departed') checkTruthy('actualDepartureTsp1');
      if (event === 'container_arrived' || event === 'container_unloaded') {
        checkExact('leg1VesselImoNumber', vessel.imo);
        checkExact('leg1VesselName', vessel.name);
      } else {
        checkExact('leg2VesselImoNumber', vessel.imo);
        checkExact('leg2VesselName', vessel.name);
      }
    } else if (sitType === 'estimated' && dataSource === 'external') {
      if (event === 'container_arrived')  checkTruthy('estimatedArrivalTsp1');
      if (event === 'container_unloaded') checkTruthy('estimatedDischargeTsp1');
      if (event === 'container_loaded')   checkTruthy('estimatedLoadTsp1');
      if (event === 'container_departed') checkTruthy('estimatedDepartureTsp1');
    } else if (sitType === 'estimated' && dataSource === 'shippeo') {
      if (event === 'container_arrived')  checkTruthy('predictedArrivalTsp1');
      if (event === 'container_unloaded') checkTruthy('predictedDischargeTsp1');
      if (event === 'container_loaded')   checkTruthy('predictedLoadTsp1');
      if (event === 'container_departed') checkTruthy('predictedDepartureTsp1');
    }
    return assertions;
  }

  // ── Direct events — always-on locode fields (every event) ────────────────
  if (polSite) checkExact('carrierUpdatedLocodePol', polSite.unlocode);
  if (podSite) checkExact('carrierUpdatedLocodePod', podSite.unlocode);

  // ── Vessel: only maps for POL (loading) and POD (discharge) ──────────────
  // Pre-Carriage and Delivery events carry vessel in payload but DO NOT write leg1Vessel
  const vesselMapsHere = (pType === 'loading' || pType === 'discharge');
  if (vesselMapsHere) {
    if (pType === 'loading' && event === 'container_loaded') {
      // leg1Vessel written by container_loaded at loading only
      checkExact('leg1VesselImoNumber', vessel.imo);
      checkExact('leg1VesselName', vessel.name);
    } else if (pType === 'discharge') {
      // trackingArrivingVessel written by arrived/unloaded/eta at discharge
      checkExact('trackingArrivingVesselImo', vessel.imo);
      checkExact('trackingArrivingVesselVesselName', vessel.name);
    }
  } else {
    // Pre-Carriage / Delivery: vessel in payload but NOT mapped → show as info
    assertions.push({ field: 'leg1VesselImoNumber', expected: 'not mapped (Pre-Carriage/Delivery)', actual: otu?.leg1VesselImoNumber ?? null, pass: true, info: true });
  }

  // ── Pre-Carriage ──────────────────────────────────────────────────────────
  if (pType === 'origin_inland_location') {
    if (event === 'container_gate_out_empty') {
      if (sitType === 'actual') {
        checkTruthy('actualGateOutEmptyDepot');
        // Co-mapped from same event: city → depotPreLocation, country → depotPreCountry, transport_mode → motGateOutEmpty
        if (site.city)    checkExact('depotPreLocation', site.city);
        if (site.country) checkExact('depotPreCountry', site.country);
        checkExact('motGateOutEmpty', 'ocean');
      } else if (sitType === 'estimated' && dataSource === 'external') {
        checkTruthy('estimatedGateOutEmptyDepot');
        // Not asserting actualGateOutEmptyDepot is null — prior actual event in session may have set it
      }
    }
    if (event === 'container_departed') {
      if (sitType === 'actual') {
        checkTruthy('actualDepartureFromOrigin');
        // Co-mapped: city → pickUpOriginLocation, country → pickUpOriginCountry, transport_mode → motPickUpOrigin
        if (site.city)    checkExact('pickUpOriginLocation', site.city);
        if (site.country) checkExact('pickUpOriginCountry', site.country);
        checkExact('motPickUpOrigin', 'ocean');
      } else if (sitType === 'estimated' && dataSource === 'external') {
        checkTruthy('estimatedDepartureFromOrigin');
      }
    }
    if (event === 'container_loaded') {
      if (sitType === 'actual') checkTruthy('actualLoadedAtOrigin');
      else if (sitType === 'estimated' && dataSource === 'external') checkTruthy('estimatedLoadedAtOrigin');
    }
  }

  // ── POL ───────────────────────────────────────────────────────────────────
  if (pType === 'loading') {
    if (event === 'container_gate_out_full') {
      if (sitType === 'actual') checkTruthy('actualGateInPol');
      else if (sitType === 'estimated' && dataSource === 'external') checkTruthy('estimatedGateInPol');
    }
    if (event === 'container_loaded') {
      if (sitType === 'actual') {
        checkTruthy('actualLoadPol');
        // Co-mapped: transport_mode → leg1Mot, vessel → leg1VesselImoNumber/Name (already checked above)
        checkExact('leg1Mot', 'ocean');
      } else if (sitType === 'estimated' && dataSource === 'external') {
        checkTruthy('estimatedLoadPol');
        // Not asserting actualLoadPol is null — prior actual event may have set it
      }
    }
    if (event === 'container_departed') {
      if (sitType === 'actual') checkTruthy('actualDeparturePol');
      else if (sitType === 'estimated' && dataSource === 'external') checkTruthy('estimatedDeparturePol');
      else if (sitType === 'estimated' && dataSource === 'shippeo')  checkTruthy('predictedDeparturePol');
    }
  }

  // ── POD ───────────────────────────────────────────────────────────────────
  if (pType === 'discharge') {
    if (event === 'container_arrived') {
      if (sitType === 'actual') checkTruthy('actualArrivalPod');
    }
    if (event === 'eta_event') {
      if (sitType === 'estimated' && dataSource === 'external') {
        checkTruthy('estimatedArrivalPod');
        // Not asserting actualArrivalPod is null — prior actual event may have set it
      } else if (sitType === 'estimated' && dataSource === 'shippeo') {
        checkTruthy('predictedArrivalPod');
      }
    }
    if (event === 'container_unloaded') {
      if (sitType === 'actual') checkTruthy('actualDischargePod');
      else if (sitType === 'estimated' && dataSource === 'external') checkTruthy('estimatedDischargePod');
      else if (sitType === 'estimated' && dataSource === 'shippeo')  checkTruthy('predictedDischargePod');
    }
    if (event === 'container_gate_out_full') {
      if (sitType === 'actual') {
        checkTruthy('actualGateOutPod');
        checkExact('motGateOutPod', 'ocean');   // motGateOutPod maps on any gate_out_full at discharge
      } else if (sitType === 'estimated' && dataSource === 'external') {
        checkTruthy('estimatedGateOutPod');
        checkExact('motGateOutPod', 'ocean');
      } else if (sitType === 'estimated' && dataSource === 'shippeo') checkTruthy('predictedGateOutPod');
    }
    if (event === 'container_gate_in_empty') {
      if (sitType === 'actual') {
        checkTruthy('actualEmptyReturn');
        checkExact('motEmptyReturn', 'ocean');
      } else if (sitType === 'estimated' && dataSource === 'external') checkTruthy('estimatedEmptyReturn');
    }
  }

  // ── Delivery ──────────────────────────────────────────────────────────────
  if (pType === 'destination_inland_location') {
    if (event === 'container_arrived') {
      if (sitType === 'actual') {
        checkTruthy('actualArrivalDestination');
        // Co-mapped: city → destinationCity, country → destinationCountry
        if (site.city)    checkExact('destinationCity', site.city);
        if (site.country) checkExact('destinationCountry', site.country);
      } else if (sitType === 'estimated' && dataSource === 'external') {
        checkTruthy('estimatedArrivalDestination');
        // Not asserting actualArrivalDestination is null — prior actual event may have set it
      }
    }
  }

  return assertions;
}

function printEventResult(result) {
  const box = '─'.repeat(58);
  console.log(`\n  ${C.bold}┌${box}┐${C.reset}`);
  console.log(`  ${C.bold}│ EVENT RESULT${C.reset}`);
  console.log(`  ${C.bold}├${box}┤${C.reset}`);
  console.log(`  ${C.bold}│${C.reset}  Event    : ${C.cyan}${result.event}${C.reset}`);
  console.log(`  ${C.bold}│${C.reset}  PlaceType: ${C.cyan}${result.placeType}${C.reset}`);
  console.log(`  ${C.bold}│${C.reset}  Type     : ${result.situationType}${result.dataSource ? ` (${result.dataSource})` : ''}`);
  console.log(`  ${C.bold}│${C.reset}  HTTP     : ${result.webhookStatus === 200 ? C.green + '200 ✅' : C.red + result.webhookStatus + ' ❌'}${C.reset}`);
  console.log(`  ${C.bold}│${C.reset}  Duration : ${result.duration}ms`);
  console.log(`  ${C.bold}├${box}┤${C.reset}`);
  console.log(`  ${C.bold}│ ASSERTIONS${C.reset}`);
  for (const a of result.assertions) {
    if (a.info) {
      // Info-only assertions (always-on fields in negative mode) — show but don't judge
      console.log(`  ${C.bold}│${C.reset}  ${C.gray}ℹ  ${a.field.padEnd(28)} got: ${String(a.actual ?? 'null').slice(0,35)}${C.reset}`);
      continue;
    }
    const icon   = a.pass ? `${C.green}✅` : `${C.red}❌`;
    const actual = String(a.actual ?? 'null').slice(0, 35);
    const exp    = String(a.expected ?? 'null').slice(0, 35);
    // Negative checks show "unchanged" label
    const label  = a.negativeCheck ? `${C.yellow}[NOT CHANGED]${C.reset} ` : '';
    console.log(`  ${C.bold}│${C.reset}  ${icon}${C.reset} ${label}${a.field.padEnd(28)} ${C.gray}got: ${actual}${C.reset}`);
    if (!a.pass) console.log(`  ${C.bold}│${C.reset}     ${' '.repeat(28)} ${C.red}exp: ${exp}${C.reset}`);
  }
  const overall = result.pass ? `${C.green}✅ PASSED` : `${C.red}❌ FAILED`;
  console.log(`  ${C.bold}├${box}┤${C.reset}`);
  console.log(`  ${C.bold}│${C.reset}  Overall  : ${overall}${C.reset}`);
  console.log(`  ${C.bold}└${box}┘${C.reset}`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  OTU Setup
// ─────────────────────────────────────────────────────────────────────────────

async function setupOtuCode() {
  banner('OTU SETUP — Create via Code');
  console.log(`${C.gray}Creating TransportUnitOcean with BN + BL + CN + SCAC + InProgress...${C.reset}`);

  const ts = String(Date.now()).slice(-5);
  const cn = `LGTE01${ts}`;
  const bn = `SESBN${ts}`;
  const bl = `SESBL${ts}`;

  const r = await createOTU({ containerNumber: cn, bookingNumber: bn, billOfLadingNumber: bl, carrierScac: 'MSCU', carrierShortName: 'MSC', carrierName: 'Mediterranean Shipping Company' });
  if (!r.code) { err('Failed to create OTU'); return false; }

  session.objectCode      = r.code;
  session.containerNumber = cn;
  session.bookingNumber   = bn;
  session.blNumber        = bl;
  session.carrierScac     = 'MSCU';
  session.carrierShortName= 'MSC';
  session.carrierName     = 'Mediterranean Shipping Company';

  ok(`OTU created → code=${r.code} CN=${cn}`);
  info(`Booking: ${bn}  |  BL: ${bl}  |  SCAC: MSCU`);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Shippeo backoffice verification
//  Polls until the shipment appears in Shippeo, then shows full order details.
//  Blocks event execution if shipment not found.
// ─────────────────────────────────────────────────────────────────────────────

async function verifyShippeoCreation() {
  banner('SHIPPEO BACKOFFICE VERIFICATION', '🚢');

  const ref = session.bookingNumber
    ? `${session.bookingNumber}_${session.containerNumber}`
    : `${session.blNumber}_${session.containerNumber}`;

  info(`Searching Shippeo for reference: ${C.bold}${ref}${C.reset}`);
  info('Polling every 10s (timeout 3 min)...');

  const deadline = Date.now() + 180_000;
  let shipment   = null;
  let attempt    = 0;

  while (Date.now() < deadline) {
    attempt++;
    process.stdout.write(`  ${C.gray}[attempt ${attempt}] searching...${C.reset}\r`);
    try {
      shipment = await searchShippeo(ref);
    } catch (e) {
      process.stdout.write(`\n`);
      warn(`Shippeo search error: ${e.message}`);
    }
    if (shipment) break;
    await new Promise(r => setTimeout(r, 10_000));
  }

  process.stdout.write('\n');

  if (!shipment) {
    err(`Shipment NOT found in Shippeo after 3 min (ref: ${ref})`);
    const proceed = await ask(`${C.yellow}  Shippeo verification failed. Proceed with events anyway? (Y/N): ${C.reset}`);
    if (proceed.toLowerCase() !== 'y') {
      warn('Aborting session — shipment must be in Shippeo before sending events.');
      return false;
    }
    warn('Proceeding without Shippeo confirmation.');
    return true;
  }

  // Shippeo found — show details
  ok(`Shipment found in Shippeo ✅`);
  console.log('');
  console.log(`  ${C.bold}${C.cyan}Shippeo Order Details${C.reset}`);
  console.log(`  ${'─'.repeat(50)}`);
  console.log(`  Order ID       : ${C.bold}${shipment.id || '—'}${C.reset}`);
  console.log(`  Hash ID        : ${C.bold}${shipment.hashid || '—'}${C.reset}`);
  console.log(`  Reference      : ${shipment.reference || ref}`);
  console.log(`  Organisation   : ${shipment.organization?.name || '—'}`);
  console.log(`  Agency         : ${shipment.agency?.name || '—'}`);
  console.log(`  Transport Mode : ${shipment.transportMode || '—'}`);
  console.log(`  Created At     : ${shipment.createdAt || '—'}`);

  // Also fetch debug details if hashid available
  if (shipment.hashid) {
    try {
      const shippeoToken = await getShippeoToken();
      const detailsUrl   = new URL(`https://api.shippeo.com/core/ocean/order/${shipment.hashid}/debug/details`);
      const details      = await httpGet(detailsUrl.hostname, detailsUrl.pathname, shippeoToken);
      const d            = details.body;

      if (d && d.container) {
        console.log('');
        console.log(`  ${C.bold}${C.cyan}Order Details Validation${C.reset}`);
        console.log(`  ${'─'.repeat(50)}`);
        const checks = [
          { label: 'container.reference',  actual: d.container?.reference,        expected: session.containerNumber },
          { label: 'scacAtCreation',        actual: d.scacAtCreation,              expected: session.carrierScac },
          { label: 'oceanCarrier.name',     actual: d.oceanCarrier?.name,          expected: null },  // info only
          { label: 'bookingReferenceList',  actual: (d.bookingReferenceList||[]).map(b=>b.reference).join(', '), expected: session.bookingNumber || null },
          { label: 'billOfLadingList',      actual: (d.billOfLadingList||[]).map(b=>b.reference).join(', '),    expected: session.blNumber || null },
        ];
        for (const c of checks) {
          if (c.expected === null) {
            console.log(`  ${C.gray}ℹ  ${c.label.padEnd(30)} = ${c.actual || '—'}${C.reset}`);
          } else {
            const pass = c.actual?.includes(c.expected) || c.actual === c.expected;
            const icon = pass ? `${C.green}✅` : `${C.red}❌`;
            console.log(`  ${icon}${C.reset} ${c.label.padEnd(30)} ${pass ? C.green : C.red}${c.actual || '—'}${C.reset}`);
            if (!pass) console.log(`     ${' '.repeat(30)} ${C.gray}expected: ${c.expected}${C.reset}`);
          }
        }
      }
    } catch { /* details fetch optional */ }
  }

  session.shippeoShipment = shipment;
  console.log('');
  ok('Shippeo verification complete — ready to send events');
  return true;
}

async function setupOtuManual() {
  banner('OTU SETUP — Manual Entry');
  const cn = await ask(`${C.cyan}  Container Number (e.g. LGTE0112345): ${C.reset}`);
  const bn = await ask(`${C.cyan}  Booking Number   (leave blank if none): ${C.reset}`);
  const bl = await ask(`${C.cyan}  Bill of Lading   (leave blank if none): ${C.reset}`);
  const sc = await ask(`${C.cyan}  Carrier SCAC     (e.g. MSCU): ${C.reset}`);
  const code = await ask(`${C.cyan}  Object Code      (from Logward, if known — leave blank to create): ${C.reset}`);

  session.containerNumber  = cn || session.containerNumber;
  session.bookingNumber    = bn || null;
  session.blNumber         = bl || null;
  session.carrierScac      = sc || 'MSCU';

  if (code) {
    session.objectCode = code;
    ok(`Using existing OTU → code=${code}`);
  } else {
    info('Creating OTU with provided details...');
    const r = await createOTU({ containerNumber: cn, bookingNumber: bn || undefined, billOfLadingNumber: bl || undefined, carrierScac: sc || 'MSCU' });
    if (!r.code) { err('Failed to create OTU'); return false; }
    session.objectCode = r.code;
    ok(`OTU created → code=${r.code}`);
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Event selection
// ─────────────────────────────────────────────────────────────────────────────

function listFields(fields, title) {
  console.log(`\n  ${C.bold}${C.yellow}${title}${C.reset}`);
  for (const [key, meta] of Object.entries(fields)) {
    const stage = meta.stage ? `${C.gray}[${meta.stage}]${C.reset} ` : '';
    const info  = meta.event ? `${C.dim}← ${meta.event}${C.reset}` : '';
    console.log(`    ${C.cyan}${key.padEnd(34)}${C.reset} ${stage}${info}`);
  }
}

async function selectAndRunEvents(flowType) {
  banner(`SELECT EVENTS — ${flowType.toUpperCase()}`);

  const typeAns = await ask(`\n${C.bold}  Event type? (tsp / direct / all): ${C.reset}`);
  const runTsp    = typeAns === 'tsp'    || typeAns === 'all';
  const runDirect = typeAns === 'direct' || typeAns === 'all';

  if (runTsp)    listFields(TSP_FIELDS,    'TSP Event Fields');
  if (runDirect) listFields(DIRECT_FIELDS, 'Direct Event Fields');

  const fieldAns = await ask(`\n${C.bold}  Which field(s)? (all / comma-separated names): ${C.reset}`);
  const allFields = { ...(runTsp ? TSP_FIELDS : {}), ...(runDirect ? DIRECT_FIELDS : {}) };
  const selected  = fieldAns === 'all' ? Object.keys(allFields) : fieldAns.split(',').map(s => s.trim()).filter(k => allFields[k]);

  if (!selected.length) { warn('No valid fields selected.'); return; }

  const isNegative = flowType === 'negative';
  if (isNegative) {
    console.log(`\n  ${C.yellow}⚠ NEGATIVE MODE: events will be sent as estimated + null dataSource`);
    console.log(`  ${C.yellow}  Location fields (city/country) will be null`);
    console.log(`  ${C.yellow}  Assertion: target field must NOT change (before === after)${C.reset}`);
  }

  info(`Running ${selected.length} event(s): ${selected.join(', ')}`);

  for (const fieldKey of selected) {
    const meta = allFields[fieldKey];
    if (!meta) continue;

    console.log(`\n  ${C.bold}${C.magenta}► ${fieldKey}  ${isNegative ? C.yellow + '[NEGATIVE]' : ''}${C.reset}`);

    const pType = meta.placeType || 'transhipment';

    // Vessel fields (leg1VesselImoNumber/Name) only map for POL/POD/TSP.
    // If selected for Pre-Carriage or Delivery → auto-switch to negative (vessel NOT mapped there).
    const vesselFieldsForNonMapping = ['leg1VesselImoNumber', 'leg1VesselName', 'leg2VesselImoNumber', 'leg2VesselName'];
    const nonVesselPlaceTypes = ['origin_inland_location', 'destination_inland_location'];
    const autoNegative = isNegative || (vesselFieldsForNonMapping.includes(fieldKey) && nonVesselPlaceTypes.includes(pType));
    if (autoNegative && !isNegative) {
      console.log(`  ${C.yellow}⚠ Auto-switching to NEGATIVE — vessel does not map for ${pType}${C.reset}`);
    }

    // ── Apply universal negative condition ──────────────────────────────────
    // Negative: estimated + null dataSource → no date field written
    //           city: null, country: null   → no location field written
    const eventOpts = {
      event:      meta.event,
      placeType:  pType,
      sitType:    autoNegative ? 'estimated'              : (meta.sitType   || 'actual'),
      dataSource: autoNegative ? null                     : (meta.dataSource ?? null),
      date:       stageDate(-5, 8),
      flowType:   autoNegative ? 'negative' : flowType,
      targetField: fieldKey,
    };

    if (pType === 'transhipment') {
      const tsp = pickRandom(TSP_LOCODES);
      eventOpts.tsp      = tsp;
      eventOpts.unlocode = tsp.unlocode;
      eventOpts.timezone = tsp.timezone;
      eventOpts.vessel   = pickRandom(VESSELS);
      console.log(`  ${C.gray}→ TSP port: ${tsp.unlocode} (${tsp.timezone})  Vessel: ${eventOpts.vessel.name}${C.reset}`);
    } else {
      const pool = DIRECT_SITES[pType] || DIRECT_SITES['discharge'];
      const site = pickRandom(pool);
      eventOpts.site     = site;
      eventOpts.unlocode = site.unlocode;
      // Negative: null city/country so location co-mapped fields also not written
      eventOpts.city     = autoNegative ? null : site.city;
      eventOpts.country  = autoNegative ? null : site.country;
      eventOpts.timezone = site.timezone;
      eventOpts.vessel   = pickRandom(VESSELS);
      if (!autoNegative) {
        console.log(`  ${C.gray}→ Site: ${site.unlocode} (${site.city}, ${site.country})  Vessel: ${eventOpts.vessel.name}${C.reset}`);
      } else {
        console.log(`  ${C.gray}→ Site: ${site.unlocode} (city=null, country=null)  Vessel: ${eventOpts.vessel.name}${C.reset}`);
      }
    }

    const result = await executeEvent(eventOpts);
    printEventResult(result);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Complete E2E flow (spawns Playwright)
// ─────────────────────────────────────────────────────────────────────────────

async function runCompleteE2E() {
  banner('COMPLETE E2E FLOW', '🚀');
  info('Creating OTU...');

  const ok2 = await setupOtuCode();
  if (!ok2) return;

  // Shippeo backoffice verification (required before events)
  const verified = await verifyShippeoCreation();
  if (!verified) return;

  // Spawn Playwright for all Events-Out
  info('Running all Events-Out tests via Playwright...');
  await spawnPlaywright(`A-01|A-02|A-03|PC-|POL-|POD-|DEL-|NEW-P|NEW-V|NEW-TZ`);
}

function spawnPlaywright(grepPattern) {
  return new Promise(resolve => {
    const args = ['playwright', 'test', '--project=ocean', 'E2E_Ocean', '--grep', grepPattern, '--reporter=list'];
    const child = spawn('npx', args, { stdio: 'inherit', cwd: process.cwd() });
    child.on('close', code => {
      if (code === 0) ok('Playwright tests completed successfully');
      else warn(`Playwright exited with code ${code}`);
      resolve(code);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  HTML Report generation
// ─────────────────────────────────────────────────────────────────────────────

function generateReport() {
  const now      = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const duration = ((Date.now() - session.startTime) / 1000).toFixed(1);
  const passed   = session.events.filter(e => e.pass).length;
  const failed   = session.events.filter(e => !e.pass).length;
  const total    = session.events.length;

  const eventRows = session.events.map((e, i) => {
    const assertRows = e.assertions.map(a =>
      `<tr class="${a.pass ? 'pass' : 'fail'}">
        <td>${a.pass ? '✅' : '❌'}</td>
        <td class="field">${a.field}</td>
        <td><code>${String(a.actual ?? '—').slice(0,50)}</code></td>
        <td>${a.pass ? '' : `<code class="exp">${String(a.expected ?? '—').slice(0,50)}</code>`}</td>
       </tr>`
    ).join('');
    return `
    <div class="event-card ${e.pass ? 'pass' : 'fail'}">
      <div class="event-header">
        <span class="seq">#${i+1}</span>
        <span class="event-name">${e.event}</span>
        <span class="place-type">${e.placeType}</span>
        <span class="sit-type">${e.situationType}${e.dataSource ? ` · ${e.dataSource}` : ''}</span>
        <span class="http">HTTP ${e.webhookStatus}</span>
        <span class="duration">${e.duration}ms</span>
        <span class="ts">${e.timestamp.slice(11,19)} UTC</span>
        <span class="badge ${e.pass ? 'pass' : 'fail'}">${e.pass ? 'PASSED' : 'FAILED'}</span>
      </div>
      <table class="assertions">
        <thead><tr><th></th><th>Field</th><th>Actual</th><th>Expected (on fail)</th></tr></thead>
        <tbody>${assertRows}</tbody>
      </table>
    </div>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>E2E Session Report — ${now}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f2f5;color:#1a1a2e;font-size:13px;}
    .hdr{background:linear-gradient(135deg,#1a1a2e,#0f3460);color:#fff;padding:24px 40px;}
    .hdr h1{font-size:1.5rem;font-weight:700;}
    .hdr .sub{color:#a0aec0;margin-top:4px;}
    .stats{display:flex;gap:24px;margin-top:14px;flex-wrap:wrap;}
    .stat{font-size:.78rem;color:#cbd5e0;}
    .stat strong{display:block;font-size:1rem;}
    .stat.pass strong{color:#9ae6b4;} .stat.fail strong{color:#fc8181;}
    .banner{margin:16px 40px;padding:12px 20px;border-radius:8px;font-weight:600;font-size:.9rem;}
    .banner.ok{background:#f0fff4;border:1.5px solid #68d391;color:#276749;}
    .banner.fail{background:#fff5f5;border:1.5px solid #fc8181;color:#9b2335;}
    .otu-box{margin:0 40px 16px;background:#fff;border-radius:8px;border:1px solid #e2e8f0;padding:14px 20px;font-size:.82rem;}
    .otu-box h3{font-weight:700;margin-bottom:8px;color:#4a5568;}
    .otu-box .fields{display:flex;flex-wrap:wrap;gap:12px;}
    .otu-box .field-item{background:#edf2f7;padding:4px 10px;border-radius:4px;}
    .otu-box .field-item span{font-weight:700;color:#2d3748;}
    .events{margin:0 40px 32px;display:flex;flex-direction:column;gap:12px;}
    .event-card{background:#fff;border-radius:8px;border:1px solid #e2e8f0;overflow:hidden;}
    .event-card.pass{border-left:4px solid #68d391;} .event-card.fail{border-left:4px solid #fc8181;}
    .event-header{display:flex;align-items:center;gap:8px;padding:10px 16px;background:#fafafa;flex-wrap:wrap;}
    .seq{background:#edf2f7;padding:2px 8px;border-radius:4px;font-weight:700;font-size:.75rem;}
    .event-name{font-weight:700;font-size:.85rem;color:#2d3748;}
    .place-type,.sit-type{font-size:.75rem;background:#ebf4ff;color:#2b6cb0;padding:2px 8px;border-radius:10px;}
    .http{font-size:.75rem;color:#718096;}
    .duration{font-size:.72rem;color:#a0aec0;}
    .ts{font-size:.72rem;color:#a0aec0;margin-left:auto;}
    .badge{padding:2px 10px;border-radius:10px;font-size:.72rem;font-weight:700;}
    .badge.pass{background:#c6f6d5;color:#22543d;} .badge.fail{background:#fed7d7;color:#9b2335;}
    .assertions{width:100%;border-collapse:collapse;}
    .assertions thead tr{background:#f7fafc;}
    .assertions th{padding:6px 14px;text-align:left;font-size:.7rem;text-transform:uppercase;color:#a0aec0;border-bottom:1px solid #e2e8f0;}
    .assertions td{padding:7px 14px;border-bottom:1px solid #f7fafc;font-size:.78rem;}
    .assertions tr.pass td{} .assertions tr.fail td{background:#fff5f5;}
    .assertions .field{font-family:monospace;font-weight:600;color:#2b6cb0;}
    code{font-family:monospace;background:#f7fafc;padding:1px 5px;border-radius:3px;font-size:.77rem;}
    .exp{background:#fff5f5;color:#e53e3e;}
    .footer{text-align:center;padding:16px;font-size:.75rem;color:#a0aec0;}
  </style>
</head>
<body>
<div class="hdr">
  <h1>🌊 E2E Session Report — Events-Out</h1>
  <p class="sub">Interactive session: ${now}</p>
  <div class="stats">
    <div class="stat"><strong>${total}</strong>Events Run</div>
    <div class="stat pass"><strong>${passed}</strong>Passed</div>
    <div class="stat fail"><strong>${failed}</strong>Failed</div>
    <div class="stat"><strong>${duration}s</strong>Duration</div>
  </div>
</div>
<div class="banner ${failed === 0 ? 'ok' : 'fail'}">
  ${failed === 0 ? '✅ All events passed' : `❌ ${failed} event(s) failed`}
</div>
<div class="otu-box">
  <h3>OTU Details</h3>
  <div class="fields">
    <div class="field-item">Object Code <span>${session.objectCode || '—'}</span></div>
    <div class="field-item">Container No <span>${session.containerNumber || '—'}</span></div>
    <div class="field-item">Booking No <span>${session.bookingNumber || '—'}</span></div>
    <div class="field-item">Bill of Lading <span>${session.blNumber || '—'}</span></div>
    <div class="field-item">SCAC <span>${session.carrierScac || '—'}</span></div>
    <div class="field-item">Shippeo Verified <span>${session.shippeoVerified ? '✅ Yes' : '—'}</span></div>
    ${session.shippeoShipment ? `<div class="field-item">Shippeo Order ID <span>${session.shippeoShipment.id || '—'}</span></div>` : ''}
  </div>
</div>
<div class="events">${eventRows || '<p style="padding:20px 40px;color:#a0aec0">No events executed.</p>'}</div>
<div class="footer">Logward QA Automation — E2E Session Report · ${now}</div>
</body>
</html>`;

  const dir  = path.resolve('playwright-report', 'sessions');
  const file = path.join(dir, `session-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.html`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, html, 'utf8');
  return file;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.clear();
  console.log(`\n${C.bold}${C.white}╔════════════════════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.bold}${C.white}║  Logward Ocean — Interactive E2E Events-Out Test Session   ║${C.reset}`);
  console.log(`${C.bold}${C.white}║  Type "finish" or "end test" at any time to close          ║${C.reset}`);
  console.log(`${C.bold}${C.white}╚════════════════════════════════════════════════════════════╝${C.reset}\n`);

  // ── Step 1: E2E or targeted? ─────────────────────────────────────────────
  const e2eAns = await ask(`${C.bold}Run the COMPLETE E2E flow (create OTU + Shippeo + all events)? (Y/N): ${C.reset}`);

  if (e2eAns.toLowerCase() === 'y') {
    await runCompleteE2E();
    // Skip to report
  } else {
    // ── Step 2: Code or manual? ──────────────────────────────────────────
    banner('OTU SETUP');
    const setupAns = await ask(`${C.bold}Create OTU through CODE or enter details MANUALLY? (code/manual): ${C.reset}`);
    let setupOk;
    if (setupAns.toLowerCase() === 'manual') setupOk = await setupOtuManual();
    else                                      setupOk = await setupOtuCode();
    if (!setupOk) { err('OTU setup failed. Exiting.'); rl.close(); return; }

    // ── Shippeo backoffice verification (required before sending any events) ─
    const shippeoOk = await verifyShippeoCreation();
    if (!shippeoOk) { err('Cannot send events without Shippeo confirmation. Exiting.'); rl.close(); return; }
    session.shippeoVerified = true;

    // ── Main event loop ──────────────────────────────────────────────────
    info(`\nSession active. OTU: ${session.objectCode} | CN: ${session.containerNumber}`);
    console.log(`${C.gray}Type "finish" or "end test" to close and generate report.${C.reset}`);

    while (true) {
      console.log(`\n${'─'.repeat(62)}`);
      const flowAns = await ask(`\n${C.bold}Flow type? (positive / negative / edge / finish): ${C.reset}`);

      if (flowAns.toLowerCase() === 'finish' || flowAns.toLowerCase() === 'end test') break;

      const validFlows = ['positive', 'negative', 'edge'];
      if (!validFlows.includes(flowAns.toLowerCase())) {
        warn(`Unknown flow "${flowAns}". Use: positive / negative / edge`);
        continue;
      }

      await selectAndRunEvents(flowAns);

      // Summary after this batch
      const total  = session.events.length;
      const passed = session.events.filter(e => e.pass).length;
      console.log(`\n  ${C.bold}Session so far: ${passed}/${total} passed${C.reset}`);
    }
  }

  // ── Generate report ──────────────────────────────────────────────────────
  banner('SESSION COMPLETE', '📊');
  const total  = session.events.length;
  const passed = session.events.filter(e => e.pass).length;
  const failed = total - passed;

  console.log(`\n  Events executed : ${total}`);
  console.log(`  ${C.green}Passed          : ${passed}${C.reset}`);
  if (failed) console.log(`  ${C.red}Failed          : ${failed}${C.reset}`);
  console.log(`  Duration        : ${((Date.now() - session.startTime) / 1000).toFixed(1)}s`);

  if (total > 0) {
    const reportFile = generateReport();
    ok(`Report saved → ${reportFile}`);
    // Open report
    const { execSync } = require('child_process');
    try { execSync(`open "${reportFile}"`); } catch {}
  } else {
    info('No events executed — no report generated.');
  }

  rl.close();
  console.log(`\n${C.gray}Session ended. Goodbye.${C.reset}\n`);
}

main().catch(e => { console.error(e); rl.close(); process.exit(1); });
