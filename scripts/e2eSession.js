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

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
rl.on('close', () => {}); // prevent early exit when stdin is piped and reaches EOF
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
  // POL and POD are fixed for the entire session — picked once at OTU creation.
  polSite:          null,  // { unlocode, city, country, timezone }
  podSite:          null,
  // TSP slot registry — each slot gets a locode assigned the first time it's used.
  tspSlots:         { 1: null, 2: null, 3: null, 4: null },
  // TSP vessel registry — each leg gets a vessel assigned once.
  // In positive flow: no two legs share the same vessel IMO.
  tspVesselsByLeg:  { 1: null, 2: null, 3: null, 4: null },
  shippeoShipment:  null,   // set after Shippeo verification
  shippeoVerified:  false,
  startTime:        Date.now(),
  events:           [],
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

async function pollOTUChanged(objectCode, baseline, timeoutMs = 25000, settleMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2500));
    const otu = await getOTU(objectCode).catch(() => null);
    if (otu?.lastChangedAt && otu.lastChangedAt !== baseline) {
      // First change detected — settle phase: wait up to settleMs for writes to finish,
      // but exit early if lastChangedAt fires again (fresher snapshot available).
      const settleDeadline = Date.now() + settleMs;
      let latestChangedAt = otu.lastChangedAt;
      let latest = otu;
      while (Date.now() < settleDeadline) {
        await new Promise(r => setTimeout(r, 1000));
        const fresh = await getOTU(objectCode).catch(() => null);
        if (fresh) latest = fresh;
        if (fresh?.lastChangedAt && fresh.lastChangedAt !== latestChangedAt) return fresh;
      }
      return latest;
    }
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
  const now = new Date();
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() + daysFromToday);
  // Keep current seconds+ms so re-running the same event always sends a new unique timestamp
  d.setUTCHours(hours, 0, now.getUTCSeconds(), now.getUTCMilliseconds());
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
    placeType = 'transhipment', payloadPlaceType, unlocode, timezone, city, country,
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
      place_type: payloadPlaceType || placeType,
    },
    // carrier field — uses whatever SCAC was set on the OTU at creation time
    carrier: { scacs: session.carrierScac ? [session.carrierScac] : [] },
    // resources: both 'vessel' and 'milestoneVessel' required (confirmed from working Postman payload)
    resources: vessel ? [
      { qualifier: 'vessel',          identifiers: [{ qualifier: 'IMO', value: vessel.imo }, { qualifier: 'MMSI', value: vessel.mmsi || '636023646' }, { qualifier: 'LABEL', value: vessel.name }] },
      { qualifier: 'milestoneVessel', identifiers: [{ qualifier: 'IMO', value: vessel.imo }, { qualifier: 'MMSI', value: vessel.mmsi || '636023646' }, { qualifier: 'LABEL', value: vessel.name }] },
    ] : [],
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
  'actualGateInPol':             { stage: 'POL', event: 'container_gate_in_full',   placeType: 'loading' },
  'estimatedGateInPol':          { stage: 'POL', event: 'container_gate_in_full',   placeType: 'loading', sitType: 'estimated', dataSource: 'external' },
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
  // Slot 1
  'actualArrivalTsp1':      { event: 'container_arrived',  sitType: 'actual',    dataSource: null },
  'actualDischargeTsp1':    { event: 'container_unloaded', sitType: 'actual',    dataSource: null },
  'actualLoadTsp1':         { event: 'container_loaded',   sitType: 'actual',    dataSource: null },
  'actualDepartureTsp1':    { event: 'container_departed', sitType: 'actual',    dataSource: null },
  'estimatedArrivalTsp1':   { event: 'container_arrived',  sitType: 'estimated', dataSource: 'external' },
  'predictedArrivalTsp1':   { event: 'container_arrived',  sitType: 'estimated', dataSource: 'shippeo' },
  'estimatedDischargeTsp1': { event: 'container_unloaded', sitType: 'estimated', dataSource: 'external' },
  'predictedDischargeTsp1': { event: 'container_unloaded', sitType: 'estimated', dataSource: 'shippeo' },
  'estimatedLoadTsp1':      { event: 'container_loaded',   sitType: 'estimated', dataSource: 'external' },
  'predictedLoadTsp1':      { event: 'container_loaded',   sitType: 'estimated', dataSource: 'shippeo' },
  'estimatedDepartureTsp1': { event: 'container_departed', sitType: 'estimated', dataSource: 'external' },
  'predictedDepartureTsp1': { event: 'container_departed', sitType: 'estimated', dataSource: 'shippeo' },
  'tsp1Locode':             { event: 'container_arrived',  sitType: 'actual',    dataSource: null },
  // Slot 2
  'actualArrivalTsp2':      { event: 'container_arrived',  sitType: 'actual',    dataSource: null },
  'actualDischargeTsp2':    { event: 'container_unloaded', sitType: 'actual',    dataSource: null },
  'actualLoadTsp2':         { event: 'container_loaded',   sitType: 'actual',    dataSource: null },
  'actualDepartureTsp2':    { event: 'container_departed', sitType: 'actual',    dataSource: null },
  'estimatedArrivalTsp2':   { event: 'container_arrived',  sitType: 'estimated', dataSource: 'external' },
  'predictedArrivalTsp2':   { event: 'container_arrived',  sitType: 'estimated', dataSource: 'shippeo' },
  'estimatedDischargeTsp2': { event: 'container_unloaded', sitType: 'estimated', dataSource: 'external' },
  'predictedDischargeTsp2': { event: 'container_unloaded', sitType: 'estimated', dataSource: 'shippeo' },
  'estimatedLoadTsp2':      { event: 'container_loaded',   sitType: 'estimated', dataSource: 'external' },
  'predictedLoadTsp2':      { event: 'container_loaded',   sitType: 'estimated', dataSource: 'shippeo' },
  'estimatedDepartureTsp2': { event: 'container_departed', sitType: 'estimated', dataSource: 'external' },
  'predictedDepartureTsp2': { event: 'container_departed', sitType: 'estimated', dataSource: 'shippeo' },
  'tsp2Locode':             { event: 'container_arrived',  sitType: 'actual',    dataSource: null },
  // Slot 3
  'actualArrivalTsp3':      { event: 'container_arrived',  sitType: 'actual',    dataSource: null },
  'actualDischargeTsp3':    { event: 'container_unloaded', sitType: 'actual',    dataSource: null },
  'actualLoadTsp3':         { event: 'container_loaded',   sitType: 'actual',    dataSource: null },
  'actualDepartureTsp3':    { event: 'container_departed', sitType: 'actual',    dataSource: null },
  'estimatedArrivalTsp3':   { event: 'container_arrived',  sitType: 'estimated', dataSource: 'external' },
  'predictedArrivalTsp3':   { event: 'container_arrived',  sitType: 'estimated', dataSource: 'shippeo' },
  'estimatedDischargeTsp3': { event: 'container_unloaded', sitType: 'estimated', dataSource: 'external' },
  'predictedDischargeTsp3': { event: 'container_unloaded', sitType: 'estimated', dataSource: 'shippeo' },
  'estimatedLoadTsp3':      { event: 'container_loaded',   sitType: 'estimated', dataSource: 'external' },
  'predictedLoadTsp3':      { event: 'container_loaded',   sitType: 'estimated', dataSource: 'shippeo' },
  'estimatedDepartureTsp3': { event: 'container_departed', sitType: 'estimated', dataSource: 'external' },
  'predictedDepartureTsp3': { event: 'container_departed', sitType: 'estimated', dataSource: 'shippeo' },
  'tsp3Locode':             { event: 'container_arrived',  sitType: 'actual',    dataSource: null },
  // Slot 4
  'actualArrivalTsp4':      { event: 'container_arrived',  sitType: 'actual',    dataSource: null },
  'actualDischargeTsp4':    { event: 'container_unloaded', sitType: 'actual',    dataSource: null },
  'actualLoadTsp4':         { event: 'container_loaded',   sitType: 'actual',    dataSource: null },
  'actualDepartureTsp4':    { event: 'container_departed', sitType: 'actual',    dataSource: null },
  'estimatedArrivalTsp4':   { event: 'container_arrived',  sitType: 'estimated', dataSource: 'external' },
  'predictedArrivalTsp4':   { event: 'container_arrived',  sitType: 'estimated', dataSource: 'shippeo' },
  'estimatedDischargeTsp4': { event: 'container_unloaded', sitType: 'estimated', dataSource: 'external' },
  'predictedDischargeTsp4': { event: 'container_unloaded', sitType: 'estimated', dataSource: 'shippeo' },
  'estimatedLoadTsp4':      { event: 'container_loaded',   sitType: 'estimated', dataSource: 'external' },
  'predictedLoadTsp4':      { event: 'container_loaded',   sitType: 'estimated', dataSource: 'shippeo' },
  'estimatedDepartureTsp4': { event: 'container_departed', sitType: 'estimated', dataSource: 'external' },
  'predictedDepartureTsp4': { event: 'container_departed', sitType: 'estimated', dataSource: 'shippeo' },
  'tsp4Locode':             { event: 'container_arrived',  sitType: 'actual',    dataSource: null },
  // Vessel
  'leg1VesselImoNumber':    { event: 'container_arrived',  sitType: 'actual',    dataSource: null },
  'leg2VesselImoNumber':    { event: 'container_loaded',   sitType: 'actual',    dataSource: null },
  'leg3VesselImoNumber':    { event: 'container_loaded',   sitType: 'actual',    dataSource: null },
  'leg4VesselImoNumber':    { event: 'container_loaded',   sitType: 'actual',    dataSource: null },
  'leg5VesselImoNumber':    { event: 'container_loaded',   sitType: 'actual',    dataSource: null },
  'leg5VesselName':         { event: 'container_loaded',   sitType: 'actual',    dataSource: null },
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
  { imo: '9864239', mmsi: '636023646', name: 'ZEUS LUMOS'           },
  { imo: '9781726', mmsi: '477203700', name: 'MSC GAIA'             },
  { imo: '9839284', mmsi: '255806296', name: 'EVER ALOT'            },
  { imo: '9312280', mmsi: '566929000', name: 'MAERSK ESSEN'         },
  { imo: '9776418', mmsi: '215668000', name: 'CMA CGM LOUIS BLERIOT'},
  { imo: '9354923', mmsi: '477295600', name: 'COSCO SHIPPING ROSE'  },
  { imo: '9795045', mmsi: '477870600', name: 'HAPAG LLOYD BERLIN'   },
  { imo: '9525243', mmsi: '219021000', name: 'MAERSK STOCKHOLM'     },
];

function pickRandom(pool) { return pool[Math.floor(Math.random() * pool.length)]; }

// Extract the TSP slot number from a field name.
// e.g. actualArrivalTsp1 → 1 · tsp2Locode → 2 · predictedLoadTsp3 → 3
function getTspSlotFromField(fieldKey) {
  // Standard TSP date/locode fields: actualArrivalTsp1 → 1, tsp3Locode → 3
  const tspMatch = fieldKey.match(/[Tt]sp(\d)/);
  if (tspMatch) return parseInt(tspMatch[1]);

  // Leg vessel fields — map to SOURCE SLOT (the slot that writes to that leg):
  //   leg1Vessel: container_arrived NON-INCR at slot 1 → leg1
  //   leg2Vessel: container_loaded  INCREMENT at slot 1 → leg2 (N+1=2)
  //   leg3Vessel: container_loaded  INCREMENT at slot 2 → leg3 (N+1=3)
  //   leg4Vessel: container_loaded  INCREMENT at slot 3 → leg4 (N+1=4)
  const legMatch = fieldKey.match(/^leg(\d)Vessel/);
  if (legMatch) {
    const leg = parseInt(legMatch[1]);
    // NON-INCR (leg1): source slot = leg number
    // INCREMENT (leg2-4): source slot = leg - 1
    const meta = TSP_FIELDS[fieldKey];
    const isIncr = meta && (meta.event === 'container_loaded' || meta.event === 'container_departed');
    return isIncr ? leg - 1 : leg;
  }

  return null;
}

// Get or assign a locode for a TSP slot.
// If the slot already has a locode (from a prior event this session), reuses it.
// If not, picks a random locode not used by other slots.
function getOrAssignTspSlot(slotNum) {
  if (session.tspSlots[slotNum]) {
    info(`Slot ${slotNum} reusing locode: ${session.tspSlots[slotNum].unlocode} (set by earlier event)`);
    return session.tspSlots[slotNum];
  }
  const used = Object.values(session.tspSlots).filter(Boolean).map(s => s.unlocode);
  const pool = TSP_LOCODES.filter(l => !used.includes(l.unlocode));
  const chosen = pool.length ? pickRandom(pool) : pickRandom(TSP_LOCODES);
  session.tspSlots[slotNum] = chosen;
  info(`Slot ${slotNum} assigned new locode: ${chosen.unlocode}`);
  return chosen;
}

// Get or assign a vessel for a specific leg slot.
// Ensures no two legs share the same vessel IMO in positive flow.
function getOrAssignVesselForLeg(legNum) {
  if (session.tspVesselsByLeg[legNum]) {
    return session.tspVesselsByLeg[legNum];
  }
  // Exclude all vessels already assigned to other legs
  const usedImos = Object.values(session.tspVesselsByLeg)
    .filter(Boolean)
    .map(v => v.imo);
  const available = VESSELS.filter(v => !usedImos.includes(v.imo));
  const chosen    = available.length ? pickRandom(available) : pickRandom(VESSELS);
  session.tspVesselsByLeg[legNum] = chosen;
  return chosen;
}

// Detect which slot a given locode will land in, based on the OTU's current state.
// TSP new-flow logic: Pass 1 = REUSE existing slot; Pass 2 = CLAIM first empty slot.
function detectTargetSlot(locode, otuBefore) {
  const current = [
    otuBefore?.tsp1Locode, otuBefore?.tsp2Locode,
    otuBefore?.tsp3Locode, otuBefore?.tsp4Locode,
  ];
  // Pass 1: reuse existing slot
  const existingIdx = current.findIndex(l => l === locode);
  if (existingIdx !== -1) return existingIdx + 1;
  // Pass 2: first empty slot
  const emptyIdx = current.findIndex(l => !l);
  if (emptyIdx !== -1) return emptyIdx + 1;
  return null; // all 4 slots full
}

// ─────────────────────────────────────────────────────────────────────────────
//  Event execution + assertion
// ─────────────────────────────────────────────────────────────────────────────

async function executeEvent(eventOpts) {
  const cn     = eventOpts.containerNumber || session.containerNumber;
  const vessel = eventOpts.vessel || pickRandom(VESSELS);
  // actual events use past dates (already happened); estimated/predicted use future dates
  const resolvedSitTypeForDate = eventOpts.sitType || eventOpts.situationType || 'actual';
  const defaultDate = resolvedSitTypeForDate === 'actual' ? stageDate(-5, 8) : stageDate(10, 8);
  const date   = eventOpts.date || defaultDate;
  const pType  = eventOpts.placeType || 'transhipment';

  // Pick site with city + country — critical for field mapping
  let site;
  if (pType === 'transhipment') {
    const tspRaw = eventOpts.tsp || pickRandom(TSP_LOCODES);
    site = { unlocode: tspRaw.unlocode, city: null, country: null, timezone: tspRaw.timezone };
  } else {
    const pool = DIRECT_SITES[pType] || DIRECT_SITES['discharge'];
    site = eventOpts.site || pickRandom(pool);
    // Don't print here — selectAndRunEvents already prints the site
  }

  // Use session's fixed POL and POD — these are set once at OTU creation and never change.
  // In real world: loading port and discharge port are fixed for the entire shipment lifecycle.
  const polSite = session.polSite || pickRandom(DIRECT_SITES['loading']);
  const podSite = session.podSite || pickRandom(DIRECT_SITES['discharge']);

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

  // Detect which TSP slot the locode actually lands in (based on OTU state before event)
  const targetSlot = pType === 'transhipment'
    ? detectTargetSlot(merged.unlocode, otuBefore)
    : null;
  if (targetSlot) console.log(`  ${C.gray}→ Locode ${merged.unlocode} lands in slot ${targetSlot}${C.reset}`);

  // Build assertions — pass otuBefore + targetSlot for dynamic slot assertion
  const assertions = buildAssertions(merged, otuAfter, { date, site, vessel, polSite, podSite, otuBefore, isNegative, targetSlot });

  const allPass = assertions.every(a => a.pass);
  const resolvedSitType = eventOpts.situationType || eventOpts.sitType || 'actual';
  const result  = { timestamp: new Date().toISOString(), event: eventOpts.event, placeType: eventOpts.placeType || 'transhipment', payloadPlaceType: eventOpts.payloadPlaceType ?? null, situationType: resolvedSitType, dataSource: eventOpts.dataSource, flowType: eventOpts.flowType, negativeStrategy: eventOpts.negativeStrategy ?? null, webhookStatus: wh.status, assertions, pass: allPass && wh.status === 200, duration };
  session.events.push(result);
  return result;
}

// Returns all Logward fields that would be written by a given event+placeType in positive mode.
// Used by negative tests to assert none of them changed.
// Explains WHY a field maps — shown in terminal and report for every assertion.
// Format: { condition, source } — what conditions must be true AND what source field provides the value.
const FIELD_MAPPING_CONDITIONS = {
  // Pre-Carriage
  actualGateOutEmptyDepot:      { condition: 'event=container_gate_out_empty + place_type=origin_inland + type=actual',     source: 'situation.date' },
  estimatedGateOutEmptyDepot:   { condition: 'event=container_gate_out_empty + place_type=origin_inland + type=estimated + DS=external', source: 'situation.date' },
  depotPreLocation:             { condition: 'event=container_gate_out_empty + place_type=origin_inland + event_site.city present',   source: 'event_site.city' },
  depotPreCountry:              { condition: 'event=container_gate_out_empty + place_type=origin_inland + event_site.country present', source: 'event_site.country' },
  motGateOutEmpty:              { condition: 'event=container_gate_out_empty + place_type=origin_inland + transport_mode present',     source: 'situation.transport_mode' },
  actualDepartureFromOrigin:    { condition: 'event=container_departed + place_type=origin_inland + type=actual',            source: 'situation.date' },
  estimatedDepartureFromOrigin: { condition: 'event=container_departed + place_type=origin_inland + type=estimated + DS=external',    source: 'situation.date' },
  pickUpOriginLocation:         { condition: 'event=container_departed + place_type=origin_inland + event_site.city present',          source: 'event_site.city' },
  pickUpOriginCountry:          { condition: 'event=container_departed + place_type=origin_inland + event_site.country present',       source: 'event_site.country' },
  motPickUpOrigin:              { condition: 'event=container_departed + place_type=origin_inland + transport_mode present',           source: 'situation.transport_mode' },
  actualLoadedAtOrigin:         { condition: 'event=container_loaded + place_type=origin_inland + type=actual',              source: 'situation.date' },
  estimatedLoadedAtOrigin:      { condition: 'event=container_loaded + place_type=origin_inland + type=estimated + DS=external',       source: 'situation.date' },
  // POL
  actualGateInPol:              { condition: 'event=container_gate_in_full + place_type=loading + type=actual',             source: 'situation.date' },
  estimatedGateInPol:           { condition: 'event=container_gate_in_full + place_type=loading + type=estimated + DS=external',      source: 'situation.date' },
  actualLoadPol:                { condition: 'event=container_loaded + place_type=loading + type=actual',                    source: 'situation.date' },
  estimatedLoadPol:             { condition: 'event=container_loaded + place_type=loading + type=estimated + DS=external',             source: 'situation.date' },
  leg1Mot:                      { condition: 'event=container_loaded/container_departed + place_type=loading + transport_mode present', source: 'situation.transport_mode' },
  leg1VesselImoNumber:          { condition: 'event=container_loaded/container_departed + place_type=loading + milestoneVessel.IMO present',   source: 'resources[milestoneVessel].IMO' },
  leg1VesselName:               { condition: 'event=container_loaded/container_departed + place_type=loading + milestoneVessel.LABEL present', source: 'resources[milestoneVessel].LABEL' },
  actualDeparturePol:           { condition: 'event=container_departed + place_type=loading + type=actual',                  source: 'situation.date' },
  estimatedDeparturePol:        { condition: 'event=container_departed + place_type=loading + type=estimated + DS=external',           source: 'situation.date' },
  predictedDeparturePol:        { condition: 'event=container_departed + place_type=loading + type=estimated + DS=shippeo',            source: 'situation.date' },
  // POD
  actualArrivalPod:             { condition: 'event=container_arrived + place_type=discharge + type=actual',                 source: 'situation.date' },
  estimatedArrivalPod:          { condition: 'event=eta_event + place_type=discharge + type=estimated + DS=external',                  source: 'situation.date' },
  predictedArrivalPod:          { condition: 'event=eta_event + place_type=discharge + type=estimated + DS=shippeo',                   source: 'situation.date' },
  actualDischargePod:           { condition: 'event=container_unloaded + place_type=discharge + type=actual',                source: 'situation.date' },
  estimatedDischargePod:        { condition: 'event=container_unloaded + place_type=discharge + type=estimated + DS=external',         source: 'situation.date' },
  predictedDischargePod:        { condition: 'event=container_unloaded + place_type=discharge + type=estimated + DS=shippeo',          source: 'situation.date' },
  // Maps for all three discharge events regardless of type/DS — vessel data always written when milestoneVessel is present
  // Maps for: container_arrived+actual | container_unloaded+actual/estimated | eta_event+estimated
  // Does NOT map for: container_arrived+estimated (spec: actual only when vessel arrives)
  trackingArrivingVesselImo:       { condition: 'event=container_arrived/container_unloaded/eta_event + place_type=discharge + milestoneVessel.IMO present',   source: 'resources[milestoneVessel].IMO' },
  trackingArrivingVesselVesselName:{ condition: 'event=container_arrived/container_unloaded/eta_event + place_type=discharge + milestoneVessel.LABEL present', source: 'resources[milestoneVessel].LABEL' },
  actualGateOutPod:             { condition: 'event=container_gate_out_full + place_type=discharge + type=actual',           source: 'situation.date' },
  estimatedGateOutPod:          { condition: 'event=container_gate_out_full + place_type=discharge + type=estimated + DS=external',    source: 'situation.date' },
  predictedGateOutPod:          { condition: 'event=container_gate_out_full + place_type=discharge + type=estimated + DS=shippeo',     source: 'situation.date' },
  motGateOutPod:                { condition: 'event=container_gate_out_full + place_type=discharge + transport_mode present',          source: 'situation.transport_mode' },
  actualEmptyReturn:            { condition: 'event=container_gate_in_empty + place_type=discharge + type=actual',           source: 'situation.date' },
  estimatedEmptyReturn:         { condition: 'event=container_gate_in_empty + place_type=discharge + type=estimated + DS=external',    source: 'situation.date' },
  motEmptyReturn:               { condition: 'event=container_gate_in_empty + place_type=discharge + transport_mode present',          source: 'situation.transport_mode' },
  // Delivery
  actualArrivalDestination:    { condition: 'event=container_arrived + place_type=destination + type=actual',               source: 'situation.date' },
  estimatedArrivalDestination: { condition: 'event=container_arrived + place_type=destination + type=estimated + DS=external',        source: 'situation.date' },
  destinationCity:             { condition: 'event=container_arrived + place_type=destination + event_site.city present',             source: 'event_site.city' },
  destinationCountry:          { condition: 'event=container_arrived + place_type=destination + event_site.country present',          source: 'event_site.country' },
  // Always-on
  carrierUpdatedLocodePol:     { condition: 'any event + loading_site.unlocode present',                                              source: 'loading_site.unlocode' },
  carrierUpdatedLocodePod:     { condition: 'any event + delivery_site.unlocode present',                                             source: 'delivery_site.unlocode' },
  datetime_timezone:           { condition: 'any event + event_site.timezone present',                                                source: 'event_site.timezone' },
  // TSP — locode fields (all 4 slots, no DS/type condition)
  tsp1Locode:  { condition: 'event=container_arrived/container_unloaded/container_loaded/container_departed + place_type=transhipment + event_site.unlocode present', source: 'event_site.unlocode' },
  tsp2Locode:  { condition: 'event=container_arrived/container_unloaded/container_loaded/container_departed + place_type=transhipment + event_site.unlocode present', source: 'event_site.unlocode' },
  tsp3Locode:  { condition: 'event=container_arrived/container_unloaded/container_loaded/container_departed + place_type=transhipment + event_site.unlocode present', source: 'event_site.unlocode' },
  tsp4Locode:  { condition: 'event=container_arrived/container_unloaded/container_loaded/container_departed + place_type=transhipment + event_site.unlocode present', source: 'event_site.unlocode' },
  // TSP — actual date fields
  actualArrivalTsp1:    { condition: 'event=container_arrived + place_type=transhipment + type=actual',    source: 'situation.date' },
  actualArrivalTsp2:    { condition: 'event=container_arrived + place_type=transhipment + type=actual',    source: 'situation.date' },
  actualArrivalTsp3:    { condition: 'event=container_arrived + place_type=transhipment + type=actual',    source: 'situation.date' },
  actualArrivalTsp4:    { condition: 'event=container_arrived + place_type=transhipment + type=actual',    source: 'situation.date' },
  actualDischargeTsp1:  { condition: 'event=container_unloaded + place_type=transhipment + type=actual',   source: 'situation.date' },
  actualDischargeTsp2:  { condition: 'event=container_unloaded + place_type=transhipment + type=actual',   source: 'situation.date' },
  actualLoadTsp1:       { condition: 'event=container_loaded + place_type=transhipment + type=actual',     source: 'situation.date' },
  actualLoadTsp2:       { condition: 'event=container_loaded + place_type=transhipment + type=actual',     source: 'situation.date' },
  actualDepartureTsp1:  { condition: 'event=container_departed + place_type=transhipment + type=actual',   source: 'situation.date' },
  actualDepartureTsp2:  { condition: 'event=container_departed + place_type=transhipment + type=actual',   source: 'situation.date' },
  // TSP — estimated/predicted date fields
  estimatedArrivalTsp1: { condition: 'event=container_arrived + place_type=transhipment + type=estimated + DS=external',  source: 'situation.date' },
  predictedArrivalTsp1: { condition: 'event=container_arrived + place_type=transhipment + type=estimated + DS=shippeo',   source: 'situation.date' },
  estimatedDischargeTsp1:{ condition: 'event=container_unloaded + place_type=transhipment + type=estimated + DS=external', source: 'situation.date' },
  predictedDischargeTsp1:{ condition: 'event=container_unloaded + place_type=transhipment + type=estimated + DS=shippeo',  source: 'situation.date' },
  estimatedLoadTsp1:    { condition: 'event=container_loaded + place_type=transhipment + type=estimated + DS=external',    source: 'situation.date' },
  predictedLoadTsp1:    { condition: 'event=container_loaded + place_type=transhipment + type=estimated + DS=shippeo',     source: 'situation.date' },
  estimatedDepartureTsp1:{ condition: 'event=container_departed + place_type=transhipment + type=estimated + DS=external', source: 'situation.date' },
  predictedDepartureTsp1:{ condition: 'event=container_departed + place_type=transhipment + type=estimated + DS=shippeo',  source: 'situation.date' },
  // TSP — vessel fields handled separately in TSP slot block (no entry here to avoid duplicate key overwriting POL definitions above)
};

function getMappingCondition(field) {
  const m = FIELD_MAPPING_CONDITIONS[field];
  if (!m) return { condition: field, source: '—' };
  return m;
}

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
      'container_gate_in_full':   ['actualGateInPol', 'estimatedGateInPol'],
      'container_loaded':         ['actualLoadPol', 'estimatedLoadPol', 'leg1Mot', 'leg1VesselImoNumber', 'leg1VesselName'],
      'container_departed':       ['actualDeparturePol', 'estimatedDeparturePol', 'predictedDeparturePol', 'leg1Mot', 'leg1VesselImoNumber', 'leg1VesselName'],
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

// Returns fields that have NO data_source condition — they map regardless of DS.
// These should be positively asserted even in negative tests.
function getDSFreeFields(event, placeType) {
  const map = {
    'origin_inland_location': {
      'container_gate_out_empty': ['depotPreLocation', 'depotPreCountry', 'motGateOutEmpty'],
      'container_departed':       ['pickUpOriginLocation', 'pickUpOriginCountry', 'motPickUpOrigin'],
      'container_loaded':         [],
    },
    'loading': {
      'container_gate_in_full':   [],
      'container_loaded':         ['leg1Mot', 'leg1VesselImoNumber', 'leg1VesselName'],
      'container_departed':       ['leg1Mot', 'leg1VesselImoNumber', 'leg1VesselName'],
    },
    'discharge': {
      'container_arrived':        ['trackingArrivingVesselImo', 'trackingArrivingVesselVesselName'],
      'eta_event':                ['trackingArrivingVesselImo', 'trackingArrivingVesselVesselName'],
      'container_unloaded':       ['trackingArrivingVesselImo', 'trackingArrivingVesselVesselName'],
      'container_gate_out_full':  ['motGateOutPod'],
      'container_gate_in_empty':  ['motEmptyReturn'],
    },
    'destination_inland_location': {
      'container_arrived':        ['destinationCity', 'destinationCountry'],
    },
    'transhipment': {
      // tspNLocode has no DS condition
      'container_arrived':        ['tsp1Locode'],
      'container_unloaded':       ['tsp1Locode'],
      'container_loaded':         ['tsp1Locode'],
      'container_departed':       ['tsp1Locode'],
    },
  };
  return map[placeType]?.[event] || [];
}

function buildAssertions(opts, otu, { date, site, vessel, polSite, podSite, otuBefore, isNegative, targetSlot }) {
  const assertions = [];

  const pType      = opts.placeType  || 'transhipment';
  const event      = opts.event;
  const sentType   = opts.situationType || opts.sitType || 'actual';
  const sentDS     = opts.dataSource ?? null;
  const sentCity   = opts.city    ?? null;
  const sentCountry= opts.country ?? null;

  // ── Build sent-conditions block for a field ──────────────────────────────
  // Shows: what was REQUIRED vs what was SENT, with match/mismatch per condition.
  // This lets anyone reading the output understand WHY a field mapped or didn't.
  function buildSentConditions(field, forNegative) {
    const m = FIELD_MAPPING_CONDITIONS[field];
    if (!m) return [];

    // Parse required conditions from the condition string
    // Format: "event=X + place_type=Y + type=Z + DS=W"
    const condStr = m.condition;
    const conditions = [];

    // situation.event
    const evMatch = condStr.match(/event=([^\s+]+)/);
    if (evMatch && evMatch[1] !== 'any') {
      conditions.push({
        key:      'situation.event',
        required: evMatch[1],
        sent:     event,
        match:    evMatch[1].includes('/') ? evMatch[1].split('/').includes(event) : event === evMatch[1],
      });
    }

    // place_type
    const ptMatch = condStr.match(/place_type=([^\s+]+)/);
    if (ptMatch && ptMatch[1] !== 'any') {
      conditions.push({
        key:      'event_site.place_type',
        required: ptMatch[1].replace('origin_inland','origin_inland_location').replace('destination','destination_inland_location'),
        sent:     pType,
        match:    pType.includes(ptMatch[1].split('/')[0]),
      });
    }

    // situation.type
    // Use ' type=' (with space) to avoid matching 'place_type=' by mistake
    const typeMatch = condStr.match(/ type=([^\s+]+)/);
    if (typeMatch) {
      conditions.push({
        key:      'situation.type',
        required: typeMatch[1],
        sent:     sentType,
        match:    sentType === typeMatch[1],
      });
    }

    // data_source — only check for estimated/predicted fields.
    // actual type fields have NO DS condition — they map regardless of data_source.
    const requiredType = typeMatch?.[1];
    const dsMatch = condStr.match(/DS=([^\s+]+)/);
    if (dsMatch && requiredType !== 'actual') {
      const reqDS = dsMatch[1] === 'null' ? null : dsMatch[1];
      conditions.push({
        key:      'situation_justification.data_source',
        required: reqDS === null ? 'null (absent)' : reqDS,
        sent:     sentDS === null ? 'null (absent)' : sentDS,
        match:    sentDS === reqDS,
      });
    }

    // Source value (city, country, transport_mode, vessel, unlocode)
    if (m.source === 'event_site.city') {
      conditions.push({ key: 'event_site.city', required: 'present', sent: sentCity ?? 'null', match: !!sentCity });
    } else if (m.source === 'event_site.country') {
      conditions.push({ key: 'event_site.country', required: 'present', sent: sentCountry ?? 'null', match: !!sentCountry });
    } else if (m.source === 'situation.transport_mode') {
      conditions.push({ key: 'situation.transport_mode', required: 'present', sent: 'ocean', match: true });
    } else if (m.source.includes('milestoneVessel')) {
      conditions.push({ key: m.source, required: 'present', sent: vessel ? vessel.imo : 'null', match: !!vessel });
    } else if (m.source === 'loading_site.unlocode') {
      conditions.push({ key: 'loading_site.unlocode', required: 'present', sent: polSite?.unlocode ?? 'null', match: !!polSite?.unlocode });
    } else if (m.source === 'delivery_site.unlocode') {
      conditions.push({ key: 'delivery_site.unlocode', required: 'present', sent: podSite?.unlocode ?? 'null', match: !!podSite?.unlocode });
    } else if (m.source === 'event_site.unlocode') {
      conditions.push({ key: 'event_site.unlocode', required: 'present', sent: opts.unlocode ?? 'null', match: !!opts.unlocode });
    }

    return conditions;
  }

  // ── Positive helpers ────────────────────────────────────────────────────────
  const checkTruthy = (field) => {
    const actual = otu?.[field] ?? null;
    const { condition, source } = getMappingCondition(field);
    const sentConditions = buildSentConditions(field, false);
    assertions.push({ field, expected: 'set', actual, pass: !!actual, condition, source, sentConditions });
  };
  const checkExact = (field, expected) => {
    const actual = otu?.[field] ?? null;
    const pass   = actual === expected;
    const { condition, source } = getMappingCondition(field);
    const sentConditions = buildSentConditions(field, false);
    assertions.push({ field, expected, actual, pass, condition, source, sentConditions });
  };

  // ── Negative helper: field must NOT have changed ───────────────────────────
  const checkNotChanged = (field) => {
    const before = otuBefore?.[field] ?? null;
    const after  = otu?.[field] ?? null;
    const pass   = before === after;
    const { condition, source } = getMappingCondition(field);
    const sentConditions = buildSentConditions(field, true);
    // Find which condition caused the block
    const mismatch = sentConditions.find(c => !c.match);
    const blockReason = mismatch
      ? `${mismatch.key} sent="${mismatch.sent}" but required="${mismatch.required}"`
      : `conditions not met`;
    assertions.push({
      field,
      expected: `unchanged (was: ${before ?? 'null'})`,
      actual:   after,
      pass,
      negativeCheck: true,
      condition,
      source,
      sentConditions,
      negativeReason: `Blocked — ${blockReason}`,
    });
  };

  // ── Helper: did ALL conditions for this field match what was sent? ─────────
  function allConditionsMet(field) {
    const conds = buildSentConditions(field, false);
    return conds.length > 0 && conds.every(c => c.match);
  }

  // ── Helper: what exact value should this field hold when it maps? ─────────
  function getExpectedValue(field) {
    const m = FIELD_MAPPING_CONDITIONS[field];
    if (!m) return null;
    const src = m.source;
    if (src === 'event_site.city')              return sentCity;
    if (src === 'event_site.country')           return sentCountry;
    if (src === 'situation.transport_mode')     return 'ocean';
    if (src.includes('milestoneVessel].IMO'))   return vessel?.imo   ?? null;
    if (src.includes('milestoneVessel].LABEL')) return vessel?.name  ?? null;
    if (src === 'loading_site.unlocode')        return polSite?.unlocode ?? null;
    if (src === 'delivery_site.unlocode')       return podSite?.unlocode ?? null;
    if (src === 'event_site.unlocode')          return site?.unlocode    ?? null;
    return null; // situation.date → use checkTruthy
  }

  // ── Helper: is this field relevant to the event that was sent? ───────────
  // Only check fields whose event condition matches (or is 'any').
  // Fields for completely different events are irrelevant and skipped.
  function isRelevantToEvent(field) {
    const m = FIELD_MAPPING_CONDITIONS[field];
    if (!m) return false;
    const evMatch = m.condition.match(/event=([^\s+]+)/);
    if (!evMatch) return true;                        // no event condition → always relevant
    const required = evMatch[1];
    if (required === 'any') return true;              // any event → always relevant
    // Multi-event fields like 'arrived/unloaded/eta'
    if (required.includes('/')) return required.split('/').includes(event);
    return required === event;
  }

  // ── Helper: assert one field purely from its conditions ───────────────────
  // ALL conditions met  → field SHOULD map → positive assert
  // ANY condition fails → field SHOULD NOT map → checkNotChanged
  // Fields for a different event: evaluated silently (affect pass/fail but not printed)
  //
  // Special blocks on trackingArrivingVesselImo / trackingArrivingVesselVesselName only:
  //   1. container_arrived + estimated → vessel does NOT map (spec: actual arrival only)
  //   2. TSHG (Tailwind) + eta_event + external DS → vessel does NOT map
  //      TSHG + eta_event + shippeo DS → vessel DOES map (shippeo provides confirmed vessel)
  const trackingVesselFields = ['trackingArrivingVesselImo', 'trackingArrivingVesselVesselName'];
  const arrivedEstimatedBlock = event === 'container_arrived' && sentType !== 'actual';
  const tshgEtaExternalBlock  = session.carrierScac === 'TSHG'
    && event === 'eta_event'
    && sentDS === 'external';

  function assertDirect(field) {
    const relevant = isRelevantToEvent(field);
    // forceNotChanged applies to trackingArrivingVesselImo + trackingArrivingVesselVesselName only
    const forceNotChanged = trackingVesselFields.includes(field) && (arrivedEstimatedBlock || tshgEtaExternalBlock);
    const met = !forceNotChanged && allConditionsMet(field);
    if (met) {
      const exp = getExpectedValue(field);
      if (exp === null) {
        checkTruthy(field);
      } else {
        checkExact(field, exp);
      }
    } else {
      checkNotChanged(field);
    }
    // Mark the last pushed assertion as silent if it belongs to a different event
    if (!relevant && assertions.length) {
      assertions[assertions.length - 1].silent = true;
    }
  }

  // ── TSP events — slot-aware (same conditions apply to all 4 slots) ────────
  if (pType === 'transhipment') {
    const S = targetSlot || 1;
    const isIncrement = event === 'container_loaded' || event === 'container_departed';
    const VS = isIncrement ? S + 1 : S;
    console.log(`  ${C.gray}→ Asserting slot ${S} (vessel slot ${VS})${C.reset}`);

    // tspNLocode assertion:
    // - Positive: assert locode was claimed (checkExact)
    // - Negative for locode/vessel (payloadPlaceType="Port"): assert locode NOT changed (checkNotChanged)
    // - Negative for date fields (estimated+null DS): skip locode — negative payload may not trigger claiming
    if (opts.payloadPlaceType && opts.payloadPlaceType !== 'transhipment') {
      checkNotChanged(`tsp${S}Locode`);
    } else if (!isNegative) {
      checkExact(`tsp${S}Locode`, site.unlocode);
    }
    // else: negative date-field test — locode claim is unreliable, skip assertion

    // Date fields — type/DS specific
    if (sentType === 'actual' && !sentDS) {
      if (event === 'container_arrived')  checkTruthy(`actualArrivalTsp${S}`);
      if (event === 'container_unloaded') checkTruthy(`actualDischargeTsp${S}`);
      if (event === 'container_loaded')   checkTruthy(`actualLoadTsp${S}`);
      if (event === 'container_departed') checkTruthy(`actualDepartureTsp${S}`);
    } else if (sentType === 'estimated' && sentDS === 'external') {
      if (event === 'container_arrived')  checkTruthy(`estimatedArrivalTsp${S}`);
      if (event === 'container_unloaded') checkTruthy(`estimatedDischargeTsp${S}`);
      if (event === 'container_loaded')   checkTruthy(`estimatedLoadTsp${S}`);
      if (event === 'container_departed') checkTruthy(`estimatedDepartureTsp${S}`);
    } else if (sentType === 'estimated' && sentDS === 'shippeo') {
      if (event === 'container_arrived')  checkTruthy(`predictedArrivalTsp${S}`);
      if (event === 'container_unloaded') checkTruthy(`predictedDischargeTsp${S}`);
      if (event === 'container_loaded')   checkTruthy(`predictedLoadTsp${S}`);
      if (event === 'container_departed') checkTruthy(`predictedDepartureTsp${S}`);
    }

    // Vessel fields: no type/DS condition — assert outside type branches
    // Skip in negative date-field tests — vessel may not have been set by prior events
    // VS=5 is valid: INCREMENT from TSP4 (slot 4) → leg5 vessel
    if (VS <= 5) {
      // TSP-specific conditions for vessel (not the direct POL condition from FIELD_MAPPING_CONDITIONS)
      const isIncr = event === 'container_loaded' || event === 'container_departed';
      const tspVesselConditions = [
        { key: 'event_site.place_type', required: 'transhipment', sent: pType, match: pType === 'transhipment' },
        { key: 'situation.event', required: isIncr ? 'container_loaded/container_departed (INCREMENT → leg N+1)' : 'container_arrived/container_unloaded (NON-INCREMENT → leg N)', sent: event, match: true },
        { key: 'resources[milestoneVessel].IMO', required: 'present', sent: vessel?.imo ?? 'null', match: !!vessel },
      ];

      if (opts.payloadPlaceType && opts.payloadPlaceType !== 'transhipment') {
        checkNotChanged(`leg${VS}VesselImoNumber`);
        checkNotChanged(`leg${VS}VesselName`);
      } else if (!isNegative && vessel) {
        // Push with TSP-specific conditions so display shows correct rule (not POL rule)
        const imoActual = otu?.[`leg${VS}VesselImoNumber`] ?? null;
        const nameActual = otu?.[`leg${VS}VesselName`] ?? null;
        assertions.push({ field: `leg${VS}VesselImoNumber`, expected: vessel.imo, actual: imoActual, pass: imoActual === vessel.imo, condition: `place_type=transhipment + ${isIncr ? 'INCREMENT' : 'NON-INCREMENT'} event + milestoneVessel.IMO present`, source: 'resources[milestoneVessel].IMO', sentConditions: tspVesselConditions });
        assertions.push({ field: `leg${VS}VesselName`,      expected: vessel.name, actual: nameActual, pass: nameActual === vessel.name, condition: `place_type=transhipment + ${isIncr ? 'INCREMENT' : 'NON-INCREMENT'} event + milestoneVessel.LABEL present`, source: 'resources[milestoneVessel].LABEL', sentConditions: [...tspVesselConditions.slice(0,2), { key: 'resources[milestoneVessel].LABEL', required: 'present', sent: vessel?.imo ?? 'null', match: !!vessel }] });
      }
      // else: negative date-field test — vessel assertion skipped
    }
    return assertions;
  }

  // ── Direct events (Pre-Carriage / POL / POD / Delivery) ──────────────────
  // Every field is evaluated purely by its declared conditions.
  // No if-pType / if-event branching — the conditions themselves decide.
  const DIRECT_FIELDS_TO_CHECK = [
    // Pre-Carriage
    'actualGateOutEmptyDepot', 'estimatedGateOutEmptyDepot',
    'depotPreLocation', 'depotPreCountry', 'motGateOutEmpty',
    'actualDepartureFromOrigin', 'estimatedDepartureFromOrigin',
    'pickUpOriginLocation', 'pickUpOriginCountry', 'motPickUpOrigin',
    'actualLoadedAtOrigin', 'estimatedLoadedAtOrigin',
    // POL
    'actualGateInPol', 'estimatedGateInPol',
    'actualLoadPol', 'estimatedLoadPol', 'leg1Mot',
    'leg1VesselImoNumber', 'leg1VesselName',
    'actualDeparturePol', 'estimatedDeparturePol', 'predictedDeparturePol',
    // POD
    'actualArrivalPod', 'estimatedArrivalPod', 'predictedArrivalPod',
    'trackingArrivingVesselImo', 'trackingArrivingVesselVesselName',
    'actualDischargePod', 'estimatedDischargePod', 'predictedDischargePod',
    'actualGateOutPod', 'estimatedGateOutPod', 'predictedGateOutPod', 'motGateOutPod',
    'actualEmptyReturn', 'estimatedEmptyReturn', 'motEmptyReturn',
    // Delivery
    'actualArrivalDestination', 'estimatedArrivalDestination',
    'destinationCity', 'destinationCountry',
    // Always-on
    'carrierUpdatedLocodePol', 'carrierUpdatedLocodePod',
  ];

  for (const field of DIRECT_FIELDS_TO_CHECK) {
    assertDirect(field);
  }

  return assertions;
}

function printEventResult(result) {
  const box = '─'.repeat(58);
  console.log(`\n  ${C.bold}┌${box}┐${C.reset}`);
  console.log(`  ${C.bold}│ EVENT RESULT${C.reset}`);
  console.log(`  ${C.bold}├${box}┤${C.reset}`);
  console.log(`  ${C.bold}│${C.reset}  Event         : ${C.cyan}${result.event}${C.reset}`);
  console.log(`  ${C.bold}│${C.reset}  PlaceType     : ${C.cyan}${result.placeType}${C.reset}`);
  if (result.payloadPlaceType) {
    console.log(`  ${C.bold}│${C.reset}  Payload PT    : ${C.yellow}${result.payloadPlaceType}${C.reset} ${C.gray}(sent in webhook — differs from assertion place_type)${C.reset}`);
  }
  console.log(`  ${C.bold}│${C.reset}  Type          : ${result.situationType}${result.dataSource ? ` (${result.dataSource})` : ''}`);
  console.log(`  ${C.bold}│${C.reset}  HTTP     : ${result.webhookStatus === 200 ? C.green + '200 ✅' : C.red + result.webhookStatus + ' ❌'}${C.reset}`);
  console.log(`  ${C.bold}│${C.reset}  Duration : ${result.duration}ms`);
  if (result.negativeStrategy) {
    console.log(`  ${C.bold}├${box}┤${C.reset}`);
    console.log(`  ${C.bold}│ NEGATIVE STRATEGY${C.reset}`);
    console.log(`  ${C.bold}│${C.reset}  ${C.yellow}${result.negativeStrategy}${C.reset}`);
  }
  console.log(`  ${C.bold}├${box}┤${C.reset}`);
  console.log(`  ${C.bold}│ ASSERTIONS${C.reset}`);
  for (const a of result.assertions) {
    if (a.silent && a.pass) continue;  // hide silent passes — show silent failures so user knows what changed
    if (a.info) {
      console.log(`  ${C.bold}│${C.reset}  ${C.gray}ℹ  ${a.field.padEnd(28)} got: ${String(a.actual ?? 'null').slice(0,35)}${C.reset}`);
      continue;
    }

    const actual = String(a.actual ?? 'null').slice(0, 40);
    const exp    = String(a.expected ?? 'null').slice(0, 40);

    if (a.negativeCheck && a.pass) {
      // Field was correctly blocked — show compact one-liner with the failing condition
      const mismatch = a.sentConditions?.find(c => !c.match);
      if (mismatch) {
        console.log(`  ${C.bold}│${C.reset}  ${C.yellow}🚫 [BLOCKED]${C.reset} ${C.bold}${a.field}${C.reset}`);
        console.log(`  ${C.bold}│${C.reset}       ${C.gray}sent: ${mismatch.key}="${mismatch.sent}"  required: "${mismatch.required}"${C.reset}`);
        console.log(`  ${C.bold}│${C.reset}`);
      }
      continue;
    }

    const icon  = a.pass ? `${C.green}✅` : `${C.red}❌`;
    const label = a.negativeCheck
      ? `${C.red}[UNEXPECTEDLY MAPPED]${C.reset} `
      : `${C.cyan}[SHOULD MAP]${C.reset} `;

    console.log(`  ${C.bold}│${C.reset}  ${icon}${C.reset} ${label}${C.bold}${a.field}${C.reset}`);

    if (a.sentConditions && a.sentConditions.length) {
      console.log(`  ${C.bold}│${C.reset}       ${C.gray}CONDITIONS TO MAP THIS FIELD:${C.reset}`);
      for (const c of a.sentConditions) {
        const cIcon = c.match ? `${C.green}✅` : `${C.red}❌`;
        console.log(`  ${C.bold}│${C.reset}         ${cIcon}${C.reset} ${C.gray}${c.key.padEnd(42)} required: ${String(c.required).padEnd(15)} sent: ${c.sent}${C.reset}`);
      }
    }

    const allCondMet = a.sentConditions?.every(c => c.match) ?? true;
    if (!a.negativeCheck && allCondMet) {
      console.log(`  ${C.bold}│${C.reset}       ${C.green}→ All conditions met — field SHOULD map${C.reset}`);
    } else if (a.negativeCheck && !a.pass) {
      console.log(`  ${C.bold}│${C.reset}       ${C.red}→ Field was written unexpectedly — check backend logic${C.reset}`);
    }

    console.log(`  ${C.bold}│${C.reset}       ${C.gray}GOT         : ${actual}${C.reset}`);
    if (!a.pass) {
      console.log(`  ${C.bold}│${C.reset}       ${C.red}EXPECTED    : ${exp}${C.reset}`);
    }
    console.log(`  ${C.bold}│${C.reset}`);
  }
  const overall = result.pass ? `${C.green}✅ PASSED` : `${C.red}❌ FAILED`;
  console.log(`  ${C.bold}├${box}┤${C.reset}`);
  console.log(`  ${C.bold}│${C.reset}  Overall  : ${overall}${C.reset}`);
  console.log(`  ${C.bold}└${box}┘${C.reset}`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  OTU Setup
// ─────────────────────────────────────────────────────────────────────────────

const CARRIER_PROFILES = {
  MSCU: { shortName: 'MSC',      name: 'Mediterranean Shipping Company' },
  MAEU: { shortName: 'Maersk',   name: 'Maersk Line'                    },
  CMDU: { shortName: 'CMA CGM',  name: 'CMA CGM'                        },
  COSU: { shortName: 'COSCO',    name: 'COSCO Shipping'                 },
  HLCU: { shortName: 'Hapag-Lloyd', name: 'Hapag-Lloyd'                 },
  TSHG: { shortName: 'Tailwind', name: 'Tailwind Shipping'              },
};

async function setupOtuCode(carrierScac = 'MSCU') {
  const carrier = CARRIER_PROFILES[carrierScac] || { shortName: carrierScac, name: carrierScac };
  banner(`OTU SETUP — Create via Code (${carrierScac})`);
  console.log(`${C.gray}Creating TransportUnitOcean with BL + CN + SCAC=${carrierScac} + InProgress (no BN)...${C.reset}`);

  const ts = String(Date.now()).slice(-5);
  const cn = `LGTE01${ts}`;
  const bl = `SESBL${ts}`;

  const r = await createOTU({ containerNumber: cn, billOfLadingNumber: bl, carrierScac, carrierShortName: carrier.shortName, carrierName: carrier.name });
  if (!r.code) { err('Failed to create OTU'); return false; }

  session.objectCode      = r.code;
  session.containerNumber = cn;
  session.bookingNumber   = null;
  session.blNumber        = bl;
  session.carrierScac     = carrierScac;
  session.carrierShortName= carrier.shortName;
  session.carrierName     = carrier.name;

  // Fix POL and POD for the entire session — realistic, never changes mid-session
  session.polSite = pickRandom(DIRECT_SITES['loading']);
  session.podSite = pickRandom(DIRECT_SITES['discharge']);

  ok(`OTU created → code=${r.code} CN=${cn}`);
  info(`BL: ${bl}  |  SCAC: ${carrierScac}  |  BN: none`);
  info(`POL: ${session.polSite.unlocode} (${session.polSite.city})  |  POD: ${session.podSite.unlocode} (${session.podSite.city})`);
  info(`These stay fixed for all events in this session (real-world: set at booking)`);
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
  const cn   = await ask(`${C.cyan}  Container Number (e.g. LGTE0112345): ${C.reset}`);
  const bn   = await ask(`${C.cyan}  Booking Number   (leave blank if none): ${C.reset}`);
  const bl   = await ask(`${C.cyan}  Bill of Lading   (leave blank if none): ${C.reset}`);
  const sc   = await ask(`${C.cyan}  Carrier SCAC     (e.g. MSCU): ${C.reset}`);
  const code = await ask(`${C.cyan}  Object Code      (from Logward, if known — leave blank to create): ${C.reset}`);

  // Ask for fixed POL and POD — stays constant for all events
  console.log(`\n  ${C.gray}Loading ports (POL): ${DIRECT_SITES['loading'].map(s=>s.unlocode).join(', ')}${C.reset}`);
  const polInput = await ask(`${C.cyan}  POL unlocode (leave blank for random): ${C.reset}`);
  console.log(`  ${C.gray}Discharge ports (POD): ${DIRECT_SITES['discharge'].map(s=>s.unlocode).join(', ')}${C.reset}`);
  const podInput = await ask(`${C.cyan}  POD unlocode (leave blank for random): ${C.reset}`);

  session.containerNumber  = cn || session.containerNumber;
  session.bookingNumber    = bn || null;
  session.blNumber         = bl || null;
  session.carrierScac      = sc || 'MSCU';
  // Fix POL/POD for entire session
  session.polSite = DIRECT_SITES['loading'].find(s => s.unlocode === polInput.toUpperCase()) || pickRandom(DIRECT_SITES['loading']);
  session.podSite = DIRECT_SITES['discharge'].find(s => s.unlocode === podInput.toUpperCase()) || pickRandom(DIRECT_SITES['discharge']);

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
  info(`POL fixed: ${session.polSite.unlocode} (${session.polSite.city})  |  POD fixed: ${session.podSite.unlocode} (${session.podSite.city})`);
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
    console.log(`\n  ${C.yellow}⚠ NEGATIVE MODE`);
    console.log(`  ${C.yellow}  actualXxx    → estimated + null DS  (wrong type → actual not written; DS irrelevant for actual)`);
    console.log(`  ${C.yellow}  estimatedXxx → estimated + carrier  (carrier DS ≠ external → not written)`);
    console.log(`  ${C.yellow}  predictedXxx → estimated + carrier  (carrier DS ≠ shippeo  → not written)`);
    console.log(`  ${C.yellow}  DS-free fields (locode/mot/vessel) → always map (no type or DS condition)${C.reset}`);
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

    // ── Negative condition per field type ───────────────────────────────────
    //  actualXxx    positive: actual + null     → negative: actual    + carrier
    //  estimatedXxx positive: estimated + external → negative: estimated + carrier
    //  predictedXxx positive: estimated + shippeo  → negative: estimated + carrier
    //
    //  All use "carrier" DS to block the field.
    //  carrierUpdatedLocodePol/Pod: always-on → still maps in all cases.

    const positiveType = meta.sitType || 'actual';

    // DS-free TSP fields: tspNLocode and legN vessel fields have no type/DS condition.
    // Only way to block them: send place_type="Port" (not in the known system set).
    // For vessel: keep placeType=transhipment for assertions (so TSP block runs + checks
    // checkNotChanged), but send payloadPlaceType="Port" in the actual webhook.
    const dsFreeLocodeFields = ['tsp1Locode','tsp2Locode','tsp3Locode','tsp4Locode'];
    const dsFreeVesselFields = ['leg1VesselImoNumber','leg1VesselName','leg2VesselImoNumber','leg2VesselName','leg3VesselImoNumber','leg3VesselName','leg4VesselImoNumber','leg4VesselName','leg5VesselImoNumber','leg5VesselName'];
    const isTspLocode = pType === 'transhipment' && dsFreeLocodeFields.includes(fieldKey);
    const isTspVessel = pType === 'transhipment' && dsFreeVesselFields.includes(fieldKey);

    const negSitType      = 'estimated';
    const negDS           = positiveType === 'actual' ? null : 'carrier';
    // For locode: change placeType itself (no TSP block needed)
    // For vessel: keep placeType=transhipment (TSP block must run), use payloadPlaceType="Port"
    const negPlaceType    = isTspLocode ? 'Port' : pType;
    const negPayloadPlace = isTspVessel ? 'Port' : null;

    let negativeStrategy = null;
    if (autoNegative) {
      const posDS = meta.dataSource ?? null;
      if (isTspLocode) {
        negativeStrategy = `place_type: transhipment → "Port" (payload)  |  Reason: tspNLocode has no type/DS condition — "Port" is not a recognised system place_type so no rule matches → locode blocked`;
      } else if (isTspVessel) {
        negativeStrategy = `payload place_type: transhipment → "Port"  |  Assertions keep transhipment  |  Reason: vessel has no type/DS condition — "Port" prevents backend writing vessel, TSP block still runs checkNotChanged`;
      } else if (positiveType === 'actual') {
        negativeStrategy = `type: actual → estimated  |  DS: null → null  |  Reason: actual fields have no DS condition — wrong type blocks them`;
      } else if (positiveType === 'estimated' && posDS === 'external') {
        negativeStrategy = `type: estimated (unchanged)  |  DS: external → carrier  |  Reason: DS=carrier ≠ external → field blocked`;
      } else if (positiveType === 'estimated' && posDS === 'shippeo') {
        negativeStrategy = `type: estimated (unchanged)  |  DS: shippeo → carrier  |  Reason: DS=carrier ≠ shippeo → field blocked`;
      }
    }

    const eventOpts = {
      event:            meta.event,
      placeType:        autoNegative ? negPlaceType    : pType,
      payloadPlaceType: autoNegative ? negPayloadPlace : null,
      sitType:          autoNegative ? negSitType      : positiveType,
      dataSource:       autoNegative ? negDS           : (meta.dataSource ?? null),
      date: (negSitType || meta.sitType || 'actual') === 'actual' ? stageDate(-5, 8) : stageDate(10, 8),
      flowType:         autoNegative ? 'negative' : flowType,
      targetField:      fieldKey,
      negativeStrategy,
    };

    if (pType === 'transhipment') {
      // Extract slot number from field name (e.g. actualArrivalTsp1 → slot 1)
      const slotNum = getTspSlotFromField(fieldKey);
      // Reuse the same locode if this slot was used before; assign a new one otherwise
      const tsp = slotNum ? getOrAssignTspSlot(slotNum) : pickRandom(TSP_LOCODES);
      eventOpts.tsp      = tsp;
      eventOpts.unlocode = tsp.unlocode;
      eventOpts.timezone = tsp.timezone;
      eventOpts.slotNum  = slotNum;

      // Determine which leg this vessel will go to (NON-INCR → legN, INCR → legN+1)
      const isIncrement = (meta.event === 'container_loaded' || meta.event === 'container_departed');
      const vesselLeg   = slotNum ? (isIncrement ? slotNum + 1 : slotNum) : null;

      // Pick unique vessel for this leg — leg5 is valid (INCREMENT from TSP4 → leg5)
      eventOpts.vessel = !autoNegative && vesselLeg && vesselLeg <= 5
        ? getOrAssignVesselForLeg(vesselLeg)
        : pickRandom(VESSELS);
      console.log(`  ${C.gray}→ TSP slot ${slotNum || '?'}: ${tsp.unlocode} (${tsp.timezone})  Vessel leg${vesselLeg || '?'}: ${eventOpts.vessel.name}${C.reset}`);
    } else {
      // POL events must happen at the session's fixed POL port.
      // POD events must happen at the session's fixed POD port.
      // Other stages (Pre-Carriage, Delivery) pick randomly from their pool.
      let site;
      if (pType === 'loading') {
        site = session.polSite || pickRandom(DIRECT_SITES['loading']);
      } else if (pType === 'discharge') {
        site = session.podSite || pickRandom(DIRECT_SITES['discharge']);
      } else {
        site = pickRandom(DIRECT_SITES[pType] || DIRECT_SITES['discharge']);
      }
      eventOpts.site     = site;
      eventOpts.unlocode = site.unlocode;
      eventOpts.city     = site.city;
      eventOpts.country  = site.country;
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
    const assertRows = e.assertions.filter(a => !a.info && !a.silent).map(a => {

      // ── Blocked correctly (negativeCheck + pass) — compact row ──────────
      if (a.negativeCheck && a.pass) {
        const mismatch = a.sentConditions?.find(c => !c.match);
        const reason = mismatch
          ? `sent <code>${mismatch.key}</code> = <b>"${mismatch.sent}"</b> but required <b>"${mismatch.required}"</b>`
          : 'Conditions not met';
        return `<tr class="blocked">
          <td>🚫</td>
          <td><span class="blocked-label">BLOCKED</span><br><code class="field-name">${a.field}</code></td>
          <td class="cond-cell"><div class="cond-summary blocked">Not sent because: ${reason}</div></td>
          <td><code>${String(a.actual ?? '—').slice(0,50)}</code></td>
          <td></td>
        </tr>`;
      }

      // ── Normal assertion (SHOULD MAP or UNEXPECTEDLY MAPPED) ─────────────
      const label    = a.negativeCheck ? '❗ UNEXPECTEDLY MAPPED' : '✔ SHOULD MAP';
      const labelCls = a.negativeCheck ? 'unexpected-label' : 'pos-label';

      const condRows = (a.sentConditions || []).map(c => {
        const cIcon = c.match ? '✅' : '❌';
        const rowCls = c.match ? '' : 'cond-fail';
        return `<tr class="cond-row ${rowCls}">
          <td>${cIcon}</td>
          <td class="cond-key">${c.key}</td>
          <td class="cond-required">required: <code>${c.required}</code></td>
          <td class="cond-sent">sent: <code>${c.sent}</code></td>
        </tr>`;
      }).join('');

      const condBlock = condRows ? `
        <div class="cond-block">
          <div class="cond-title">Conditions to map this field:</div>
          <table class="cond-table">${condRows}</table>
        </div>` : '';

      const summary = a.negativeCheck
        ? `<div class="cond-summary neg">⚠ Field was written unexpectedly — check backend logic</div>`
        : (a.sentConditions?.every(c => c.match)
            ? `<div class="cond-summary pos">All conditions met → field should map</div>`
            : `<div class="cond-summary warn">Condition check incomplete</div>`);

      return `<tr class="${a.pass ? 'pass' : 'fail'}">
        <td>${a.pass ? '✅' : '❌'}</td>
        <td><span class="${labelCls}">${label}</span><br><code class="field-name">${a.field}</code>
            ${a.source ? `<br><span class="source">source: ${a.source}</span>` : ''}</td>
        <td class="cond-cell">${condBlock}${summary}</td>
        <td><code>${String(a.actual ?? '—').slice(0,50)}</code></td>
        <td>${a.pass ? '' : `<code class="exp">${String(a.expected ?? '—').slice(0,50)}</code>`}</td>
       </tr>`;
    }).join('');
    // ── TSP slot limit — info card ───────────────────────────────────────────
    if (e.flowType === 'slot-limit') {
      const info = e.slotLimitInfo || {};
      return `
      <div class="event-card" style="border-left:4px solid #f6e05e;background:#fffff0;">
        <div class="event-header">
          <span class="seq">#${i+1}</span>
          <span class="flow-slot-limit">SLOT LIMIT</span>
          <span class="event-name">${info.field || e.event}</span>
          <span class="place-type">transhipment · slot ${info.slot} → leg${info.vesselLeg}</span>
          <span class="badge" style="background:#fefcbf;color:#744210;">SKIPPED</span>
        </div>
        <div style="padding:14px 18px;font-size:.83rem;color:#744210;background:#fffbeb;border-top:1px solid #f6e05e;">
          <b>⚠ TSP Slot Limit Reached</b><br><br>
          ${info.message || 'Logward supports max 4 TSP slots (leg1–leg4). This event would write beyond the supported range.'}
        </div>
      </div>`;
    }

    // ── Legacy flow verification — special card ─────────────────────────────
    if (e.flowType === 'legacy') {
      const steps = (e.legacyResults || []).map(r => {
        const oldFlowMsg = r.oldFlowActive
          ? `<div class="legacy-fail">❌ Old flow detected — backend created tsp2Locode="${r.got}" using old vessel-based logic</div>`
          : '';
        return `<tr class="${r.pass ? 'pass' : 'fail'}">
          <td>${r.pass ? '✅' : '❌'}</td>
          <td><b>Step ${r.step}</b><br><span style="font-size:.8rem">${r.label}</span></td>
          <td>${r.check}</td>
          <td><code>${r.got}</code>${oldFlowMsg}</td>
          <td>${r.pass ? '' : `<code class="exp">${r.expected}</code>`}</td>
        </tr>`;
      }).join('');
      const verdict = e.pass
        ? `<div class="legacy-pass">✅ NEW FLOW CONFIRMED — Old vessel-based slot logic is NOT active</div>`
        : `<div class="legacy-fail">❌ OLD FLOW DETECTED — Backend still assigns slots based on vessel, not locode</div>`;
      return `
      <div class="event-card ${e.pass ? 'pass' : 'fail'}">
        <div class="event-header">
          <span class="seq">#${i+1}</span>
          <span class="flow-legacy">LEGACY TEST</span>
          <span class="event-name">Old TSP Flow Verification</span>
          <span class="badge ${e.pass ? 'pass' : 'fail'}">${e.pass ? 'NEW FLOW OK' : 'OLD FLOW DETECTED'}</span>
        </div>
        <div style="padding:12px 16px;font-size:.82rem;color:#4a5568;background:#f7fafc;border-bottom:1px solid #e2e8f0;">
          <b>Test:</b> Send same locode twice with different vessels → tsp2Locode must stay <code>null</code><br>
          <b>If old flow:</b> tsp2Locode gets created (slot assigned per vessel) — backend bug<br>
          <b>If new flow:</b> tsp2Locode stays null (slot reused by locode) — correct
        </div>
        ${verdict}
        <table class="assertions">
          <thead><tr><th></th><th>Step</th><th>Assertion</th><th>Got</th><th>Expected (on fail)</th></tr></thead>
          <tbody>${steps}</tbody>
        </table>
      </div>`;
    }

    const flowBadge = e.flowType === 'negative'    ? `<span class="flow-neg">NEGATIVE</span>`
                   : e.flowType === 'wrong-event' ? `<span class="flow-wrong">WRONG EVENT</span>`
                   : e.flowType === 'legacy'      ? `<span class="flow-legacy">LEGACY TEST</span>`
                   : e.flowType === 'slot-limit'  ? `<span class="flow-slot-limit">SLOT LIMIT</span>`
                   :                                `<span class="flow-pos">POSITIVE</span>`;
    const strategyBadge = e.negativeStrategy
      ? `<div class="neg-strategy">🔀 <b>Negative strategy:</b> ${e.negativeStrategy}</div>`
      : '';
    return `
    <div class="event-card ${e.pass ? 'pass' : 'fail'}">
      <div class="event-header">
        <span class="seq">#${i+1}</span>
        ${flowBadge}
        <span class="event-name">${e.event}</span>
        <span class="place-type">${e.placeType}</span>
        ${e.payloadPlaceType ? `<span class="payload-pt" title="Actual place_type sent in webhook payload">payload PT: ${e.payloadPlaceType}</span>` : ''}
        <span class="sit-type">${e.situationType}${e.dataSource ? ` · DS=${e.dataSource}` : ' · DS=null'}</span>
        <span class="http">HTTP ${e.webhookStatus}</span>
        <span class="duration">${e.duration}ms</span>
        <span class="ts">${e.timestamp.slice(11,19)} UTC</span>
        <span class="badge ${e.pass ? 'pass' : 'fail'}">${e.pass ? 'PASSED' : 'FAILED'}</span>
      </div>
      ${strategyBadge}
      <table class="assertions">
        <thead><tr><th></th><th>Assertion Type · Field</th><th>Why it maps / Why blocked</th><th>Actual value</th><th>Expected (on fail)</th></tr></thead>
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
    .assertions{width:100%;border-collapse:collapse;table-layout:fixed;}
    .assertions thead tr{background:#f7fafc;}
    .assertions th{padding:6px 14px;text-align:left;font-size:.7rem;text-transform:uppercase;color:#a0aec0;border-bottom:1px solid #e2e8f0;overflow:hidden;}
    .assertions th:nth-child(1){width:3%;}
    .assertions th:nth-child(2){width:22%;}
    .assertions th:nth-child(3){width:42%;}
    .assertions th:nth-child(4){width:18%;}
    .assertions th:nth-child(5){width:15%;}
    .assertions td{padding:7px 14px;border-bottom:1px solid #f7fafc;font-size:.78rem;word-break:break-word;overflow-wrap:anywhere;vertical-align:top;}
    .assertions tr.pass td{} .assertions tr.fail td{background:#fff5f5;}
    .assertions .field-name{font-family:monospace;font-weight:700;color:#2b6cb0;font-size:.82rem;}
    .pos-label{display:inline-block;background:#c6f6d5;color:#22543d;padding:1px 6px;border-radius:3px;font-size:.7rem;font-weight:700;}
    .neg-label{display:inline-block;background:#fed7d7;color:#9b2335;padding:1px 6px;border-radius:3px;font-size:.7rem;font-weight:700;}
    .flow-pos{background:#c6f6d5;color:#22543d;padding:2px 8px;border-radius:10px;font-size:.72rem;font-weight:700;}
    .flow-neg{background:#fed7d7;color:#9b2335;padding:2px 8px;border-radius:10px;font-size:.72rem;font-weight:700;}
    .flow-wrong{background:#feebc8;color:#7b341e;padding:2px 8px;border-radius:10px;font-size:.72rem;font-weight:700;}
    .flow-slot-limit{background:#fefcbf;color:#744210;padding:2px 8px;border-radius:10px;font-size:.72rem;font-weight:700;}
    .neg-strategy{background:#fffbeb;border:1px solid #f6e05e;border-radius:6px;padding:8px 14px;margin:8px 0 4px;font-size:.8rem;color:#744210;}
    .payload-pt{background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:10px;font-size:.72rem;font-weight:700;cursor:help;}
    .flow-legacy{background:#e9d8fd;color:#553c9a;padding:2px 8px;border-radius:10px;font-size:.72rem;font-weight:700;}
    .legacy-pass{background:#c6f6d5;color:#22543d;padding:10px 16px;font-weight:700;font-size:.85rem;}
    .legacy-fail{background:#fed7d7;color:#9b2335;padding:10px 16px;font-weight:700;font-size:.85rem;margin-top:4px;border-radius:4px;}
    .cond-cell{max-width:400px;vertical-align:top;overflow:hidden;}
    .cond-block{background:#f7fafc;border:1px solid #e2e8f0;border-radius:4px;padding:6px 8px;margin-bottom:4px;overflow:hidden;}
    .cond-title{font-size:.7rem;font-weight:700;color:#4a5568;margin-bottom:4px;text-transform:uppercase;letter-spacing:.04em;}
    .cond-table{width:100%;border-collapse:collapse;font-size:.72rem;table-layout:fixed;}
    .cond-table td{padding:2px 4px;vertical-align:top;word-break:break-word;overflow-wrap:anywhere;}
    .cond-row.cond-fail td{background:#fff5f5;}
    .cond-key{font-family:monospace;color:#2d3748;font-weight:600;white-space:nowrap;width:36%;}
    .cond-required{color:#718096;width:34%;}
    .cond-sent{color:#2d3748;width:30%;}
    .cond-summary{font-size:.72rem;padding:3px 6px;border-radius:3px;margin-top:3px;font-weight:600;}
    .cond-summary.pos{background:#c6f6d5;color:#22543d;}
    .cond-summary.neg{background:#fed7d7;color:#9b2335;}
    .cond-summary.warn{background:#fefcbf;color:#744210;}
    .cond-summary.blocked{background:#fef3c7;color:#92400e;}
    .blocked-label{display:inline-block;background:#fef3c7;color:#92400e;padding:1px 6px;border-radius:3px;font-size:.7rem;font-weight:700;}
    .unexpected-label{display:inline-block;background:#fed7d7;color:#9b2335;padding:1px 6px;border-radius:3px;font-size:.7rem;font-weight:700;}
    tr.blocked td{background:#fffbeb;}
    .reason-cell{max-width:280px;}
    .reason{color:#4a5568;font-size:.75rem;line-height:1.4;}
    .source{color:#718096;font-size:.7rem;font-style:italic;}
    .assertions .field{font-family:monospace;font-weight:600;color:#2b6cb0;}
    code{font-family:monospace;background:#f7fafc;padding:1px 5px;border-radius:3px;font-size:.77rem;}
    .exp{background:#fff5f5;color:#e53e3e;}
    .footer{text-align:center;padding:16px;font-size:.75rem;color:#a0aec0;}
  </style>
</head>
<body>
<script id="qa-summary" type="application/json">${JSON.stringify({ type: 'Events-Out', passed, failed, total, duration: duration + 's', date: now })}</script>
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

// ─────────────────────────────────────────────────────────────────────────────
//  Legacy Flow Verification
//  Tests that the OLD TSP vessel-based slot logic is NOT active.
//
//  In OLD flow: slots were assigned sequentially per vessel — sending the same
//  locode with a different vessel would create a new slot.
//
//  In NEW flow (DP-449): slots are locode-based — same locode always REUSES
//  the same slot regardless of vessel.
//
//  Test: Send same locode twice with different vessels → tsp2Locode MUST be null.
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
//  Wrong Event Verification
//  Tests that misspelt / reversed event names do NOT write date fields.
//  tspNLocode is still claimed (event=any), but date fields require exact event.
//
//  Wrong event pairs tested:
//    container_arrived    → arrived_container
//    container_unloaded   → container_unload      (missing 'd')
//    container_loaded     → container_load        (missing 'ed')
//    container_departed   → departed_container
// ─────────────────────────────────────────────────────────────────────────────
async function runWrongEventVerification() {
  banner('WRONG EVENT VERIFICATION — TSP Negative (all 4 slots)', '❌');

  if (!session.objectCode) { err('No session OTU — run OTU setup first'); return; }

  const WRONG_EVENTS = [
    { correct: 'container_arrived',  wrong: 'arrived_container',  dateField: 'actualArrivalTsp',    label: 'Arrival' },
    { correct: 'container_unloaded', wrong: 'container_unload',   dateField: 'actualDischargeTsp',  label: 'Discharge' },
    { correct: 'container_loaded',   wrong: 'container_load',     dateField: 'actualLoadTsp',       label: 'Load' },
    { correct: 'container_departed', wrong: 'departed_container', dateField: 'actualDepartureTsp',  label: 'Departure' },
  ];

  // Use session OTU — already Shippeo-registered, no wait needed, results in main report
  const cn = session.containerNumber;
  const bn = session.bookingNumber;
  const bl = session.blNumber;
  info(`Using session OTU: ${session.objectCode} (${cn}) — Shippeo already registered`);

  const results = [];

  for (let slot = 1; slot <= 4; slot++) {
    const vessel    = pickRandom(VESSELS);
    const tspTarget = TSP_LOCODES[slot - 1];

    // Run all 4 wrong-event checks on session OTU
    for (const { correct, wrong, dateField, label } of WRONG_EVENTS) {
      // Snapshot BEFORE — locode and date field current state
      const otuBefore = await getOTU(session.objectCode).catch(() => null);
      const dateKey   = `${dateField}${slot}`;
      const locodeKey = `tsp${slot}Locode`;
      const dateBefore   = otuBefore?.[dateKey]   ?? null;
      const locodeBefore = otuBefore?.[locodeKey] ?? null;

      const wrongPayload = buildPayload(cn, {
        event: wrong, placeType: 'transhipment', sitType: 'actual', dataSource: null,
        date: stageDate(-5, 8), unlocode: tspTarget.unlocode, timezone: tspTarget.timezone,
        vessel, loadingUnlocode: session.polSite?.unlocode, deliveryUnlocode: session.podSite?.unlocode,
        bookingNumber: bn, blNumber: bl,
      });
      await sendWebhook(wrongPayload);
      await new Promise(res => setTimeout(res, 3000));

      const otuAfter = await getOTU(session.objectCode).catch(() => null);
      const dateAfter   = otuAfter?.[dateKey]   ?? null;
      const locodeAfter = otuAfter?.[locodeKey] ?? null;

      // Date must NOT change (unknown event doesn't write any date field)
      // Locode must NOT change from before (unknown event doesn't claim a slot)
      const dateNotChanged   = dateAfter === dateBefore;
      const locodeNotChanged = locodeAfter === locodeBefore;
      const pass = dateNotChanged && locodeNotChanged;

      results.push({ slot, label, correct, wrong, dateKey, locodeKey,
        dateBefore, dateAfter, locodeBefore, locodeAfter,
        dateNotChanged, locodeNotChanged, pass });

      const icon = pass ? `${C.green}✅` : `${C.red}❌`;
      console.log(`  ${icon}${C.reset} Slot ${slot} | ${label.padEnd(10)} | wrong="${wrong}" | ${dateKey}: ${dateBefore ?? 'null'}→${dateAfter ?? 'null'} ${dateNotChanged ? '✅' : '❌'} | ${locodeKey}: ${locodeBefore ?? 'null'}→${locodeAfter ?? 'null'} ${locodeNotChanged ? '✅' : '❌'}`);
    }
  }

  // Summary box
  const allPass = results.every(r => r.pass);
  const box = '─'.repeat(58);
  console.log(`\n  ${C.bold}┌${box}┐${C.reset}`);
  console.log(`  ${C.bold}│ WRONG EVENT VERIFICATION RESULT${C.reset}`);
  console.log(`  ${C.bold}├${box}┤${C.reset}`);

  const failed = results.filter(r => !r.pass);
  if (failed.length) {
    failed.forEach(r => {
      if (!r.dateNotChanged)   console.log(`  ${C.bold}│${C.reset}  ${C.red}❌ Slot ${r.slot} ${r.label}: ${r.dateKey} changed (${r.dateBefore ?? 'null'} → ${r.dateAfter ?? 'null'}) — backend accepted unknown event${C.reset}`);
      if (!r.locodeNotChanged) console.log(`  ${C.bold}│${C.reset}  ${C.red}❌ Slot ${r.slot} ${r.label}: ${r.locodeKey} changed (${r.locodeBefore ?? 'null'} → ${r.locodeAfter ?? 'null'}) — backend accepted unknown event${C.reset}`);
    });
  }

  const verdict = allPass
    ? `${C.green}✅ All ${results.length} wrong-event checks passed — backend correctly ignores unknown events`
    : `${C.red}❌ ${failed.length} check(s) failed — backend accepted an unknown event name`;

  console.log(`  ${C.bold}├${box}┤${C.reset}`);
  console.log(`  ${C.bold}│${C.reset}  ${verdict}${C.reset}`);
  console.log(`  ${C.bold}└${box}┘${C.reset}`);

  // Push to session events for HTML report
  results.forEach(r => {
    session.events.push({
      timestamp: new Date().toISOString(),
      event: `wrong-event: ${r.wrong}`,
      placeType: 'transhipment',
      situationType: 'actual',
      dataSource: null,
      flowType: 'wrong-event',
      webhookStatus: 200,
      pass: r.pass,
      duration: 0,
      assertions: [
        {
          field: r.dateKey,
          expected: `unchanged (was: ${r.dateBefore ?? 'null'})`,
          actual: r.dateAfter,
          pass: r.dateNotChanged,
          negativeCheck: true,
          silent: false,
          sentConditions: [
            { key: 'situation.event', required: r.correct, sent: r.wrong, match: false },
          ],
          negativeReason: `Wrong event "${r.wrong}" — backend rejects unknown event, ${r.dateKey} not written`,
        },
        {
          field: r.locodeKey,
          expected: `unchanged (was: ${r.locodeBefore ?? 'null'})`,
          actual: r.locodeAfter,
          pass: r.locodeNotChanged,
          negativeCheck: true,
          silent: false,
          sentConditions: [
            { key: 'situation.event', required: 'container_arrived/container_unloaded/container_loaded/container_departed', sent: r.wrong, match: false },
          ],
          negativeReason: `Wrong event "${r.wrong}" — backend rejects entire payload, ${r.locodeKey} not claimed`,
        },
      ],
      negativeStrategy: `situation.event: "${r.correct}" → "${r.wrong}" (misspelt/reversed) — backend rejects unknown event entirely`,
      payloadPlaceType: null,
    });
  });
}

async function runLegacyFlowVerification() {
  banner('LEGACY FLOW VERIFICATION — Old TSP Vessel-Based Logic', '🔬');

  if (!session.objectCode) { err('No session OTU — run OTU setup first'); return; }

  // Read current OTU to find an already-claimed TSP slot with a locode
  const currentOtu = await getOTU(session.objectCode).catch(() => null);
  const slots = [
    { n: 1, locode: currentOtu?.tsp1Locode },
    { n: 2, locode: currentOtu?.tsp2Locode },
    { n: 3, locode: currentOtu?.tsp3Locode },
    { n: 4, locode: currentOtu?.tsp4Locode },
  ];
  const takenSlots  = slots.filter(s => s.locode);
  const emptySlots  = slots.filter(s => !s.locode);

  if (!takenSlots.length) {
    warn('No TSP locodes assigned on session OTU yet. Run at least one TSP positive event first.');
    return;
  }

  // Pick a taken slot — send the SAME locode with a different vessel
  const targetSlot  = takenSlots[takenSlots.length - 1]; // use last assigned slot
  const nextEmptyN  = emptySlots.length ? emptySlots[0].n : null;
  const tsp         = TSP_LOCODES.find(l => l.unlocode === targetSlot.locode) || TSP_LOCODES[0];
  const vessel2     = pickRandom(VESSELS);

  info(`Using session OTU: ${session.objectCode}`);
  info(`Target slot: ${C.bold}${targetSlot.n}${C.reset} → locode already = ${C.bold}${targetSlot.locode}${C.reset}`);
  info(`Vessel 2: ${vessel2.name} (IMO: ${vessel2.imo}) — different from current leg${targetSlot.n}Vessel`);
  console.log('');
  console.log(`  ${C.gray}Expected (NEW flow): same locode → slot ${targetSlot.n} REUSED → tsp${nextEmptyN}Locode stays null${C.reset}`);
  console.log(`  ${C.yellow}Old flow symptom:   same locode → slot ${nextEmptyN} CREATED (old vessel-based logic)${C.reset}`);
  console.log('');

  const legacyResults = [];

  // ── Step 1: snapshot before — read existing vessel from OTU ──────────────
  const existingVesselImo  = currentOtu?.[`leg${targetSlot.n}VesselImoNumber`] ?? null;
  const existingVesselName = currentOtu?.[`leg${targetSlot.n}VesselName`]      ?? null;
  const existingVesselStr  = existingVesselImo
    ? `${existingVesselName || 'unknown'} (IMO: ${existingVesselImo})`
    : 'none';

  const step1Pass = true;
  legacyResults.push({
    step: 1,
    label: `Slot ${targetSlot.n} has locode "${targetSlot.locode}" with vessel: ${existingVesselStr}`,
    check: `tsp${targetSlot.n}Locode = "${targetSlot.locode}"`,
    got: targetSlot.locode, expected: targetSlot.locode,
    pass: step1Pass, http: 200,
  });
  console.log(`  ${C.green}✅${C.reset} Step 1: tsp${targetSlot.n}Locode = "${targetSlot.locode}"  leg${targetSlot.n}Vessel = ${existingVesselStr}`);

  // ── Step 2: Send SAME locode with different vessel ───────────────────────
  info(`Step 2: container_arrived + ${targetSlot.locode} + vessel 2 (SAME locode, DIFFERENT vessel)...`);

  const payload2 = buildPayload(session.containerNumber, {
    event: 'container_arrived', placeType: 'transhipment', sitType: 'actual', dataSource: null,
    date: stageDate(-9, 8), unlocode: targetSlot.locode, timezone: tsp.timezone,
    city: null, country: null, vessel: vessel2,
    loadingUnlocode: session.polSite?.unlocode, deliveryUnlocode: session.podSite?.unlocode,
    bookingNumber: session.bookingNumber, blNumber: session.blNumber,
  });
  const wh2 = await sendWebhook(payload2);
  await new Promise(r => setTimeout(r, 5000));
  const otuAfter2 = await getOTU(session.objectCode).catch(() => null);

  // NEW flow: next empty slot locode must remain null (target slot REUSED)
  // OLD flow: next empty slot would get the locode (wrongly created new slot)
  const nextSlotLocode = nextEmptyN ? (otuAfter2?.[`tsp${nextEmptyN}Locode`] ?? null) : null;
  const step2Pass    = nextSlotLocode === null;
  const oldFlowActive = nextSlotLocode === targetSlot.locode;

  legacyResults.push({
    step: 2,
    label: `Send ${targetSlot.locode} again with vessel 2 (${vessel2.name}) — tsp${nextEmptyN}Locode MUST stay null`,
    check: `tsp${nextEmptyN}Locode = null (slot NOT created)`,
    got: nextSlotLocode ?? 'null', expected: 'null',
    pass: step2Pass,
    oldFlowActive,
    http: wh2.status,
  });

  // ── Print results ──────────────────────────────────────────────────────────
  console.log('');
  const box = '─'.repeat(58);
  console.log(`\n  ${C.bold}┌${box}┐${C.reset}`);
  console.log(`  ${C.bold}│ LEGACY FLOW VERIFICATION RESULT${C.reset}`);
  console.log(`  ${C.bold}├${box}┤${C.reset}`);
  console.log(`  ${C.bold}│${C.reset}  Locode tested : ${tsp.unlocode}`);
  console.log(`  ${C.bold}│${C.reset}  Existing leg  : leg${targetSlot.n}Vessel (from OTU)`);
  console.log(`  ${C.bold}│${C.reset}  Vessel 2      : ${vessel2.name} (${vessel2.imo})`);
  console.log(`  ${C.bold}├${box}┤${C.reset}`);

  for (const r of legacyResults) {
    const icon = r.pass ? `${C.green}✅` : `${C.red}❌`;
    console.log(`  ${C.bold}│${C.reset}  ${icon}${C.reset} Step ${r.step}: ${r.label}`);
    console.log(`  ${C.bold}│${C.reset}       Check: ${r.check}`);
    console.log(`  ${C.bold}│${C.reset}       GOT  : ${r.got}${!r.pass ? C.red + '  ← UNEXPECTED' + C.reset : ''}`);
    console.log(`  ${C.bold}│${C.reset}`);
  }

  const allPass = legacyResults.every(r => r.pass);
  const verdict = allPass
    ? `${C.green}✅ NEW FLOW CONFIRMED — Old vessel-based logic is NOT active`
    : oldFlowActive
      ? `${C.red}❌ OLD FLOW DETECTED — tsp2Locode was created! Backend still uses old logic`
      : `${C.red}❌ UNEXPECTED RESULT — check backend behaviour`;

  console.log(`  ${C.bold}├${box}┤${C.reset}`);
  console.log(`  ${C.bold}│${C.reset}  ${verdict}${C.reset}`);
  console.log(`  ${C.bold}└${box}┘${C.reset}`);

  // Push to session events for HTML report
  session.events.push({
    timestamp: new Date().toISOString(),
    event: 'LEGACY_FLOW_VERIFICATION',
    placeType: 'transhipment',
    situationType: 'actual',
    dataSource: null,
    flowType: 'legacy',
    webhookStatus: wh2.status,
    legacyResults,
    pass: allPass,
    duration: 0,
    assertions: [],
    negativeStrategy: null,
    payloadPlaceType: null,
  });
}

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
    const setupAns = await ask(`${C.bold}Create OTU through CODE, CODE-TSHG (Tailwind), or MANUAL? (code/code-tshg/manual): ${C.reset}`);
    let setupOk;
    if      (setupAns.toLowerCase() === 'manual')    setupOk = await setupOtuManual();
    else if (setupAns.toLowerCase() === 'code-tshg') setupOk = await setupOtuCode('TSHG');
    else                                              setupOk = await setupOtuCode();
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
      const flowAns = await ask(`\n${C.bold}Flow type? (positive / negative / edge / legacy / wrong-event / finish): ${C.reset}`);

      if (flowAns.toLowerCase() === 'finish' || flowAns.toLowerCase() === 'end test') break;

      const validFlows = ['positive', 'negative', 'edge', 'legacy', 'wrong-event'];
      if (!validFlows.includes(flowAns.toLowerCase())) {
        warn(`Unknown flow "${flowAns}". Use: positive / negative / edge / legacy / wrong-event`);
        continue;
      }

      if (flowAns.toLowerCase() === 'legacy') {
        await runLegacyFlowVerification();
      } else if (flowAns.toLowerCase() === 'wrong-event') {
        await runWrongEventVerification();
      } else {
        await selectAndRunEvents(flowAns);
      }

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
