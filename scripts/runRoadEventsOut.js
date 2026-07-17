#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  scripts/runRoadEventsOut.js
//
//  Interactive E2E Events-Out test session for Logward ↔ Shippeo road tracking.
//
//  Usage:
//    node scripts/runRoadEventsOut.js
//
//  Creates ONE RTU at startup, then fires events on demand against that same RTU.
//  Session stays alive until user types "finish".
//  Generates a consolidated HTML report at the end.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const readline = require('readline');
const https    = require('https');
const fs       = require('fs');
const path     = require('path');

const { getAdminToken }  = require('../helpers/shared/cognitoAuth');
const { CONFIG: RCFG }   = require('../helpers/road/roadConfig');

// ─────────────────────────────────────────────────────────────────────────────
//  Config — sourced from helpers/road/roadConfig.js
// ─────────────────────────────────────────────────────────────────────────────

function _host(url) { return new URL(url).hostname; }

const CFG = {
  upsertHost:  _host(RCFG.ADMIN_UPSERT_BASE_URL),
  upsertPath:  RCFG.UPSERT_PATH,
  getHost:     _host(RCFG.ADMIN_BASE_URL),
  getPath:     RCFG.GET_PATH,
  schedHost:   _host(RCFG.ADMIN_UPSERT_BASE_URL),
  schedPath:   RCFG.SCHED_PATH,
  webhookHost: _host(RCFG.WEBHOOK_BASE_URL),
  webhookPath: RCFG.WEBHOOK_PATH,
  webhookKey:  RCFG.WEBHOOK_API_KEY,
};

// Backend converts to IST (−5h30m) and truncates milliseconds to .000Z.
const IST_MS = (5 * 60 + 30) * 60 * 1000;  // 19800000ms

// ─────────────────────────────────────────────────────────────────────────────
//  Terminal colours
// ─────────────────────────────────────────────────────────────────────────────

const C = {
  reset:   '\x1b[0m',  bold:    '\x1b[1m',  dim:    '\x1b[2m',
  cyan:    '\x1b[36m', green:   '\x1b[32m', yellow: '\x1b[33m',
  red:     '\x1b[31m', white:   '\x1b[97m', gray:   '\x1b[90m',
  magenta: '\x1b[35m', blue:    '\x1b[34m',
};

// Buffer all stdin lines upfront so piped input works even while async ops run.
const _inputQueue = [];
let   _waitingAsk = null;
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
rl.on('line',  line => {
  if (_waitingAsk) { const r = _waitingAsk; _waitingAsk = null; r(line.trim()); }
  else             { _inputQueue.push(line.trim()); }
});
rl.on('close', () => { if (_waitingAsk) { _waitingAsk(''); } });
const ask = q => new Promise(res => {
  process.stdout.write(q);
  if (_inputQueue.length > 0) res(_inputQueue.shift());
  else                        _waitingAsk = res;
});

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
  rtuCode:   null,
  orderRef:  null,
  loadSite:  null,
  delSite:   null,
  startTime: Date.now(),
  events:    [],
};

// ─────────────────────────────────────────────────────────────────────────────
//  Field definitions  (what the user types to fire an event)
// ─────────────────────────────────────────────────────────────────────────────

const ROAD_FIELDS = {
  truckDrivingToPickUpLocation:       { event: 'DRIVING_TO_LOAD',    sitCode: 'EML', justCode: 'CFM', daysOffset: -3, hours: 6  },
  actualArrivalAtPickUpLocation:      { event: 'ARR_LOAD',           sitCode: 'EML', justCode: 'ARS', daysOffset: -2, hours: 10 },
  loaded:                             { event: 'CON_LOAD',           sitCode: 'ECH', justCode: 'CFM', daysOffset: -2, hours: 14 },
  actualDeparturePolRoad:             { event: 'LEFT_LOADING_SITE',  sitCode: 'ECH', justCode: 'DES', daysOffset: -2, hours: 16 },
  truckDrivingToDeliveryLocation:     { event: 'DRIVING_TO_UNLOAD',  sitCode: 'MLV', justCode: 'CFM', daysOffset: -1, hours: 8  },
  actualArrivalPodRoad:               { event: 'ARR_UNLOAD',         sitCode: 'LIV', justCode: 'ARS', daysOffset: -1, hours: 14 },
  delivered:                          { event: 'CON_UNLOAD',         sitCode: 'LIV', justCode: 'CFM', daysOffset: 0,  hours: 9  },
  truckDepartureFromDeliveryLocation: { event: 'DRIVER_LEFT_UNLOAD', sitCode: 'LIV', justCode: 'DES', daysOffset: 0,  hours: 11 },
  predictedArrivalAtPickUpLocation:   { event: 'ETA_EVENT',          sitCode: 'COM', justCode: 'CFM', daysOffset: 2,  hours: 8,  etdOnly: true, note: 'order.etd set → pickup ETA'   },
  predictedArrivalAtDeliveryLocation: { event: 'ETA_EVENT',          sitCode: 'COM', justCode: 'CFM', daysOffset: 3,  hours: 8,  etaOnly: true, note: 'order.eta set → delivery ETA' },
};

// Negative test definitions
const NEGATIVE_TESTS = {
  n01: { desc: 'Wrong situation_code (XXX)',                event: 'DRIVING_TO_LOAD',  sitCode: 'XXX', justCode: 'CFM', targetField: 'truckDrivingToPickUpLocation', failKey: 'situation.situation_code',     failReq: 'EML',            failSent: 'XXX'            },
  n02: { desc: 'Wrong justification_code (XXX)',            event: 'DRIVING_TO_LOAD',  sitCode: 'EML', justCode: 'XXX', targetField: 'truckDrivingToPickUpLocation', failKey: 'situation.justification_code', failReq: 'CFM',            failSent: 'XXX'            },
  n03: { desc: 'Wrong situation.event name',                event: 'UNKNOWN_EVENT',    sitCode: 'EML', justCode: 'CFM', targetField: 'truckDrivingToPickUpLocation', failKey: 'situation.event',              failReq: 'DRIVING_TO_LOAD',failSent: 'UNKNOWN_EVENT'  },
  n04: { desc: 'ETA_EVENT — no eta/etd set',                event: 'ETA_EVENT',        sitCode: 'COM', justCode: 'CFM', targetField: 'predictedArrivalAtPickUpLocation', noEtaEtd: true, failKey: 'order.etd/eta', failReq: 'present', failSent: 'null' },
  n05: { desc: 'Unknown orderRef — silently dropped',       event: 'DRIVING_TO_LOAD',  sitCode: 'EML', justCode: 'CFM', targetField: null, unknownRef: true, expectStatus: 200 },
  n06: { desc: 'Null situation_code',                       event: 'DRIVING_TO_LOAD',  sitCode: null,  justCode: 'CFM', targetField: 'truckDrivingToPickUpLocation', failKey: 'situation.situation_code',     failReq: 'EML',            failSent: 'null'           },
  n07: { desc: 'Null justification_code',                   event: 'DRIVING_TO_LOAD',  sitCode: 'EML', justCode: null,  targetField: 'truckDrivingToPickUpLocation', failKey: 'situation.justification_code', failReq: 'CFM',            failSent: 'null'           },
  n08: { desc: 'Correct conditions, date=null',             event: 'DRIVING_TO_LOAD',  sitCode: 'EML', justCode: 'CFM', targetField: 'truckDrivingToPickUpLocation', nullDate: true },
  n09: { desc: 'Lowercase situation.event (case-sensitive)',event: 'driving_to_load',  sitCode: 'EML', justCode: 'CFM', targetField: 'truckDrivingToPickUpLocation', failKey: 'situation.event',              failReq: 'DRIVING_TO_LOAD',failSent: 'driving_to_load'},
  n10: { desc: 'Lowercase situation_code (case-sensitive)', event: 'DRIVING_TO_LOAD',  sitCode: 'eml', justCode: 'CFM', targetField: 'truckDrivingToPickUpLocation', failKey: 'situation.situation_code',     failReq: 'EML',            failSent: 'eml'            },
  n11: { desc: 'Missing Authorization → HTTP 200 (x-api-key only enforced)', event: 'DRIVING_TO_LOAD', sitCode: 'EML', justCode: 'CFM', targetField: null, noAuth: true,    expectStatus: 200 },
  n12: { desc: 'Invalid Bearer token → HTTP 200 (x-api-key only enforced)', event: 'DRIVING_TO_LOAD', sitCode: 'EML', justCode: 'CFM', targetField: null, badToken: true,  expectStatus: 200 },
  n13: { desc: 'Empty request body → HTTP 200 (accepted silently)',          event: null,              sitCode: null,  justCode: null,  targetField: null, emptyBody: true, expectStatus: 200 },
};

// ─────────────────────────────────────────────────────────────────────────────
//  Site pools
// ─────────────────────────────────────────────────────────────────────────────

const LOADING_SITES = [
  { name: 'Oosterhout', address: 'Energieweg 10',    zipcode: '4906 CG', city: 'Oosterhout', country: 'NL', lat: 51.658648, lng: 4.840261 },
  { name: 'Rotterdam',  address: 'Waalhaven ZZ 15',  zipcode: '3089 JH', city: 'Rotterdam',  country: 'NL', lat: 51.893712, lng: 4.445623 },
  { name: 'Hamburg',    address: 'Hafenstrasse 12',  zipcode: '20459',   city: 'Hamburg',    country: 'DE', lat: 53.545445, lng: 9.918592 },
  { name: 'Antwerp',    address: 'Kaai 203',         zipcode: '2030',    city: 'Antwerp',    country: 'BE', lat: 51.236775, lng: 4.415369 },
  { name: 'Lyon',       address: 'Quai de la Saone', zipcode: '69001',   city: 'Lyon',       country: 'FR', lat: 45.764043, lng: 4.835659 },
];

const DELIVERY_SITES = [
  { name: 'Stuttgart LIDL', address: 'Strutstrasse 21',  zipcode: '73061', city: 'Ebersbach', country: 'DE', lat: 48.719203, lng: 9.511021 },
  { name: 'Munich LIDL',    address: 'Landsberger Str.', zipcode: '80339', city: 'Munich',    country: 'DE', lat: 48.135125, lng: 11.581981 },
  { name: 'Berlin LIDL',    address: 'Karl-Marx-Str.',   zipcode: '12043', city: 'Berlin',    country: 'DE', lat: 52.486450, lng: 13.432220 },
  { name: 'Vienna LIDL',    address: 'Praterstrasse 1',  zipcode: '1020',  city: 'Vienna',    country: 'AT', lat: 48.218812, lng: 16.412899 },
  { name: 'Prague LIDL',    address: 'Vaclavske nam.',   zipcode: '11000', city: 'Prague',    country: 'CZ', lat: 50.081656, lng: 14.420016 },
];

function pickRandom(pool) { return pool[Math.floor(Math.random() * pool.length)]; }

// ─────────────────────────────────────────────────────────────────────────────
//  Date helpers
// ─────────────────────────────────────────────────────────────────────────────

function stageDate(daysFromToday, hours = 8) {
  const now = new Date();
  const d   = new Date(now);
  d.setUTCDate(d.getUTCDate() + daysFromToday);
  d.setUTCHours(hours, 0, now.getUTCSeconds(), now.getUTCMilliseconds());
  return d.toISOString();
}

function fmtDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function roadDates(offsetDays = 22) {
  const add = days => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + days);
    d.setUTCHours(9, 0, 0, 0);
    return fmtDate(d);
  };
  return { pickUpStartDate: add(offsetDays), pickUpEndDate: add(offsetDays+2), deliveryStartDate: add(offsetDays+5), deliveryEndDate: add(offsetDays+7) };
}

// ─────────────────────────────────────────────────────────────────────────────
//  HTTPS helpers (no Playwright dependency)
// ─────────────────────────────────────────────────────────────────────────────

async function httpGet(hostname, urlPath, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path: urlPath, method: 'GET', headers: { Authorization: `Bearer ${token}`, accept: 'application/json' } }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } });
    });
    req.on('error', reject); req.end();
  });
}

async function httpPost(hostname, urlPath, headers, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = bodyObj ? JSON.stringify(bodyObj) : '';
    const req  = https.request({ hostname, path: urlPath, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) } }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } });
    });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  RTU helpers
// ─────────────────────────────────────────────────────────────────────────────

const _RUN_TS = Date.now();
let _counter  = 0;

function nextIds() {
  _counter++;
  const seq = String(_counter).padStart(2, '0');
  const ts  = String(_RUN_TS).slice(-5);
  return { transportOrderId: `E2ERDT${seq}${ts}`, licensePlateTruck: `E2ELPT${seq}${ts}` };
}

async function createRTU(loadSite, delSite) {
  const token = await getAdminToken();
  const { transportOrderId, licensePlateTruck } = nextIds();
  const dates = roadDates();

  const fields = {
    mot: 'ROAD', modeOfTransport: 'Truck', orderStatus: 'Active',
    trackingStatus: 'In Progress', loadType: 'ftl', carrierId: 'C1',
    transportOrderId, licensePlateTruck,
    pickupAddressName:    loadSite.name,    pickupAddressStreet:  loadSite.address,
    pickupAddressZipcode: loadSite.zipcode, pickupAddressCity:    loadSite.city,
    pickupAddressCountry: loadSite.country, pickUpTimeZone:       'Europe/Amsterdam',
    deliveryLocationName:    delSite.name,    deliveryLocationStreet:  delSite.address,
    deliveryLocationZipcode: delSite.zipcode, deliveryLocationCity:    delSite.city,
    deliveryLocationCountry: delSite.country, deliveryTimeZone:        'Europe/Berlin',
    ...dates,
  };

  const res = await httpPost(CFG.upsertHost, `${CFG.upsertPath}?createNew=true`,
    { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', accept: 'application/json' },
    { data: [fields] }
  );

  if (res.status !== 200 && res.status !== 201)
    throw new Error(`RTU create → HTTP ${res.status}: ${JSON.stringify(res.body).slice(0,200)}`);

  const code =
    res.body?.meta?.params?.code ||
    res.body?.data?.[0]?.code   ||
    res.body?.data?.code        || null;

  if (!code) throw new Error(`RTU created but no code returned: ${JSON.stringify(res.body).slice(0,200)}`);
  return { code, transportOrderId };
}

async function getRTU(code) {
  const token = await getAdminToken();
  const res   = await httpGet(CFG.getHost, `${CFG.getPath}/${code}`, token);
  return res.body?.data ?? res.body;
}

async function pollRTUChanged(code, baseline) {
  const deadline = Date.now() + 300000;  // 5 min — backend can take 90s+
  let rtu = null;
  let polls = 0;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));
    rtu = await getRTU(code).catch(() => null);
    polls++;
    if (rtu?.lastChangedAt && rtu.lastChangedAt !== baseline) {
      // Settle phase — wait briefly for all writes to finish
      const settle = Date.now() + 5000;
      let latest = rtu;
      while (Date.now() < settle) {
        await new Promise(r => setTimeout(r, 1000));
        const fresh = await getRTU(code).catch(() => null);
        if (fresh) latest = fresh;
        if (fresh?.lastChangedAt && fresh.lastChangedAt !== rtu.lastChangedAt) return fresh;
      }
      return latest;
    }
    process.stdout.write(`  ${C.gray}⏳ poll ${polls} — waiting for RTU update...${C.reset}\r`);
  }
  process.stdout.write('\n');
  return rtu;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Scheduler poll (active=1 valid=1)
// ─────────────────────────────────────────────────────────────────────────────

async function pollSchedulerActive(code) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const token = await getAdminToken();
      const res   = await httpGet(CFG.schedHost, `${CFG.schedPath}/${code}`, token);
      const rec   = res.body?.data ?? res.body;
      if (rec?.active === 1 && rec?.valid === 1) return rec;
    } catch (_) {}

    // Fallback: derive from RTU fields
    try {
      const rtu    = await getRTU(code);
      const active = rtu?.trackingStatus === 'In Progress' ? 1 : 0;
      const valid  = (active &&
        rtu?.carrierId && rtu?.transportOrderId && rtu?.licensePlateTruck &&
        rtu?.pickupAddressName && rtu?.pickupAddressCity && rtu?.pickupAddressCountry &&
        rtu?.deliveryLocationName && rtu?.deliveryLocationCity && rtu?.deliveryLocationCountry &&
        rtu?.pickUpStartDate && rtu?.pickUpEndDate && rtu?.deliveryStartDate && rtu?.deliveryEndDate) ? 1 : 0;
      if (active === 1 && valid === 1) return { active, valid, derived: true };
    } catch (_) {}

    process.stdout.write(`  ${C.gray}⏳ waiting for active=1 valid=1...${C.reset}\r`);
    await new Promise(r => setTimeout(r, 3000));
  }
  process.stdout.write('\n');
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Webhook
// ─────────────────────────────────────────────────────────────────────────────

async function sendWebhook(payload, opts = {}) {
  const token = await getAdminToken();
  let headers = { 'Content-Type': 'application/json', 'x-api-key': CFG.webhookKey, 'Authorization': `Bearer ${token}` };
  if (opts.noAuth)   delete headers['Authorization'];
  if (opts.badToken) headers['Authorization'] = 'Bearer INVALID_TOKEN_FOR_NEGATIVE_TEST';
  return httpPost(CFG.webhookHost, CFG.webhookPath, headers, opts.emptyBody ? null : payload);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Payload builder
// ─────────────────────────────────────────────────────────────────────────────

function buildPayload(eventName, sitCode, justCode, date, orderRef, loadSite, delSite, orderOverrides) {
  return {
    date_transmission: new Date().toISOString(),
    owner: { organization: { id: 'Q2JK9RVN', name: 'LIDL' }, agency: { id: 'Q27K7Z42', name: 'LIDL_Road', siret: null } },
    order: { edi_reference: `E2E-EDI-${orderRef}`, reference: orderRef, eta: null, etd: null, shippeo_reference: 'NPG8WVVV', ...orderOverrides },
    tour:  { edi_reference: `E2E-TOUR-${orderRef}`, reference: `E2E-TOUR-${orderRef}`, url: 'https://view.shippeo.com/orderPublic/test' },
    situation: { event: eventName, situation_code: sitCode, justification_code: justCode, input_date: date, date },
    situation_justification: { theoretical_distance: 2717, position: { lat: 48.718822, lng: 9.543809 } },
    loading_site:  { id: null, externalID: null, name: loadSite.name, address_line: loadSite.address, zipcode: loadSite.zipcode, city: loadSite.city, country: loadSite.country, position: { lat: loadSite.lat, lng: loadSite.lng }, iata_code: null },
    delivery_site: { id: null, externalID: null, name: delSite.name,  address_line: delSite.address,  zipcode: delSite.zipcode,  city: delSite.city,  country: delSite.country,  position: { lat: delSite.lat,  lng: delSite.lng  }, iata_code: null },
    carrier: { organization: { id: 'JNRJ56N8', name: 'E2E Test Carrier' }, agency: { id: 'LNGW9XN3', name: 'E2E Test Agency', siret: null } },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Date normalisation
// ─────────────────────────────────────────────────────────────────────────────

function normDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// Backend applies IST offset (−5h30m) then truncates milliseconds to .000Z.
function expectedStored(sentISO) {
  if (!sentISO) return null;
  const d = new Date(new Date(sentISO).getTime() - IST_MS);
  d.setUTCMilliseconds(0);
  return d.toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
//  Event execution
// ─────────────────────────────────────────────────────────────────────────────

async function executeEvent(fieldKey, fieldMeta) {
  const date = stageDate(fieldMeta.daysOffset, fieldMeta.hours);

  let orderOverrides = {};
  if (fieldMeta.etdOnly) orderOverrides = { etd: date, eta: null };
  if (fieldMeta.etaOnly) orderOverrides = { etd: null, eta: date };

  const payload   = buildPayload(fieldMeta.event, fieldMeta.sitCode, fieldMeta.justCode, date, session.orderRef, session.loadSite, session.delSite, orderOverrides);
  const rtuBefore = await getRTU(session.rtuCode).catch(() => null);
  const baseline  = rtuBefore?.lastChangedAt ?? null;

  console.log(`\n  ${C.dim}Sending webhook...${C.reset}`);
  const t0 = Date.now();
  const wh = await sendWebhook(payload);
  console.log(`  ${C.gray}HTTP ${wh.status}${C.reset}`);

  const rtuAfter = await pollRTUChanged(session.rtuCode, baseline);
  process.stdout.write('\n');
  const duration = Date.now() - t0;

  // Build sentConditions for the positive assertion
  const sentConditions = [
    { key: 'situation.event',              required: fieldMeta.event,    sent: fieldMeta.event,    match: true },
    { key: 'situation.situation_code',     required: fieldMeta.sitCode,  sent: fieldMeta.sitCode,  match: true },
    { key: 'situation.justification_code', required: fieldMeta.justCode, sent: fieldMeta.justCode, match: true },
  ];
  if (fieldMeta.etdOnly) sentConditions.push({ key: 'order.etd', required: 'present', sent: date, match: true });
  if (fieldMeta.etaOnly) sentConditions.push({ key: 'order.eta', required: 'present', sent: date, match: true });

  const actual   = normDate(rtuAfter?.[fieldKey]);
  const expected = expectedStored(date);
  const pass     = actual === expected;

  const assertions = [{ field: fieldKey, expected, actual, pass, negativeCheck: false, sentConditions }];
  const result = {
    timestamp: new Date().toISOString(),
    fieldKey, flowType: 'positive',
    event: fieldMeta.event, sitCode: fieldMeta.sitCode, justCode: fieldMeta.justCode,
    date, webhookStatus: wh.status, assertions,
    pass: wh.status === 200 && pass,
    duration,
  };

  session.events.push(result);
  return result;
}

async function executeNegativeTest(testId, testMeta) {
  const date     = testMeta.nullDate ? null : stageDate(-1, 8);
  const orderRef = testMeta.unknownRef ? 'NONEXISTENT-ORDER-999' : session.orderRef;

  let orderOverrides = {};
  if (testMeta.noEtaEtd) orderOverrides = { etd: null, eta: null };

  const payload   = buildPayload(testMeta.event, testMeta.sitCode, testMeta.justCode, date, orderRef, session.loadSite, session.delSite, orderOverrides);
  const rtuBefore = (!testMeta.noAuth && !testMeta.badToken && !testMeta.emptyBody && !testMeta.unknownRef)
    ? await getRTU(session.rtuCode).catch(() => null)
    : null;

  console.log(`\n  ${C.dim}Sending webhook (negative)...${C.reset}`);
  const t0 = Date.now();
  const wh = await sendWebhook(payload, { noAuth: testMeta.noAuth, badToken: testMeta.badToken, emptyBody: testMeta.emptyBody });
  console.log(`  ${C.gray}HTTP ${wh.status}${C.reset}`);
  const duration = Date.now() - t0;

  const assertions = [];

  // ── Auth / body tests: assert HTTP status only ─────────────────────────────
  if (testMeta.noAuth || testMeta.badToken || testMeta.emptyBody) {
    const pass = wh.status === testMeta.expectStatus;
    assertions.push({ field: 'HTTP status', expected: String(testMeta.expectStatus), actual: String(wh.status), pass, negativeCheck: false, sentConditions: [{ key: 'HTTP status', required: String(testMeta.expectStatus), sent: String(wh.status), match: pass }] });
    const result = { timestamp: new Date().toISOString(), fieldKey: testId, flowType: 'negative', event: testMeta.event, sitCode: testMeta.sitCode, justCode: testMeta.justCode, date, webhookStatus: wh.status, assertions, pass, duration, negativeStrategy: testMeta.desc };
    session.events.push(result);
    return result;
  }

  // ── Unknown ref: just check HTTP 200 ──────────────────────────────────────
  if (testMeta.unknownRef) {
    const pass = wh.status === 200;
    assertions.push({ field: 'HTTP status', expected: '200 (silently dropped)', actual: String(wh.status), pass, negativeCheck: false, sentConditions: [{ key: 'order.reference', required: 'known ref', sent: 'NONEXISTENT-ORDER-999', match: false }] });
    const result = { timestamp: new Date().toISOString(), fieldKey: testId, flowType: 'negative', event: testMeta.event, sitCode: testMeta.sitCode, justCode: testMeta.justCode, date, webhookStatus: wh.status, assertions, pass, duration, negativeStrategy: testMeta.desc };
    session.events.push(result);
    return result;
  }

  // ── Field should NOT change ────────────────────────────────────────────────
  await new Promise(r => setTimeout(r, 5000));
  const rtuAfter = await getRTU(session.rtuCode).catch(() => null);

  if (testMeta.targetField) {
    if (testMeta.nullDate) {
      // n08: conditions match but date=null → field should become null
      const actual = normDate(rtuAfter?.[testMeta.targetField]);
      const pass   = actual === null;
      assertions.push({
        field: testMeta.targetField, expected: 'null', actual: actual ?? 'null', pass, negativeCheck: false,
        sentConditions: [
          { key: 'situation.event',              required: testMeta.event,    sent: testMeta.event,    match: true  },
          { key: 'situation.situation_code',     required: testMeta.sitCode,  sent: testMeta.sitCode,  match: true  },
          { key: 'situation.justification_code', required: testMeta.justCode, sent: testMeta.justCode, match: true  },
          { key: 'situation.date',               required: 'any value',       sent: 'null',            match: false },
        ],
      });
    } else {
      // Standard: field must NOT change
      const fieldBefore = rtuBefore?.[testMeta.targetField] ?? null;
      const fieldAfter  = rtuAfter?.[testMeta.targetField]  ?? null;
      const unchanged   = fieldBefore === fieldAfter;
      assertions.push({
        field: testMeta.targetField,
        expected: `unchanged (was: ${fieldBefore ?? 'null'})`,
        actual:    fieldAfter,
        pass:      unchanged,
        negativeCheck: true,
        sentConditions: testMeta.failKey
          ? [{ key: testMeta.failKey, required: testMeta.failReq, sent: testMeta.failSent, match: false }]
          : [],
        negativeReason: testMeta.failKey
          ? `Blocked — sent ${testMeta.failKey}="${testMeta.failSent}" but required "${testMeta.failReq}"`
          : 'Conditions not met',
      });
    }
  }

  const pass   = wh.status === (testMeta.expectStatus || 200) && assertions.every(a => a.pass);
  const result = { timestamp: new Date().toISOString(), fieldKey: testId, flowType: 'negative', event: testMeta.event, sitCode: testMeta.sitCode, justCode: testMeta.justCode, date, webhookStatus: wh.status, assertions, pass, duration, negativeStrategy: testMeta.desc };
  session.events.push(result);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Print result box (matches ocean session script style exactly)
// ─────────────────────────────────────────────────────────────────────────────

function printEventResult(result) {
  const box = '─'.repeat(58);
  console.log(`\n  ${C.bold}┌${box}┐${C.reset}`);
  console.log(`  ${C.bold}│ EVENT RESULT${C.reset}`);
  console.log(`  ${C.bold}├${box}┤${C.reset}`);
  console.log(`  ${C.bold}│${C.reset}  Field    : ${C.cyan}${result.fieldKey}${C.reset}`);
  console.log(`  ${C.bold}│${C.reset}  Event    : ${C.cyan}${result.event || '—'}${C.reset}`);
  console.log(`  ${C.bold}│${C.reset}  Codes    : ${result.sitCode || 'null'} / ${result.justCode || 'null'}`);
  console.log(`  ${C.bold}│${C.reset}  Date sent: ${result.date || 'null'}`);
  if (result.negativeStrategy) {
    console.log(`  ${C.bold}│${C.reset}  Strategy : ${C.yellow}${result.negativeStrategy}${C.reset}`);
  }
  console.log(`  ${C.bold}│${C.reset}  HTTP     : ${result.webhookStatus === 200 ? C.green + '200 ✅' : C.red + result.webhookStatus + ' ❌'}${C.reset}`);
  console.log(`  ${C.bold}│${C.reset}  Duration : ${result.duration}ms`);
  console.log(`  ${C.bold}├${box}┤${C.reset}`);
  console.log(`  ${C.bold}│ ASSERTIONS${C.reset}`);

  for (const a of result.assertions) {
    const actual = String(a.actual ?? 'null').slice(0, 50);
    const exp    = String(a.expected ?? 'null').slice(0, 50);

    // Correctly blocked in a negative test
    if (a.negativeCheck && a.pass) {
      const mismatch = a.sentConditions?.find(c => !c.match);
      console.log(`  ${C.bold}│${C.reset}  ${C.yellow}🚫 [BLOCKED]${C.reset} ${C.bold}${a.field}${C.reset}`);
      if (mismatch) {
        console.log(`  ${C.bold}│${C.reset}       ${C.gray}sent: ${mismatch.key}="${mismatch.sent}"  required: "${mismatch.required}"${C.reset}`);
      }
      console.log(`  ${C.bold}│${C.reset}`);
      continue;
    }

    const icon  = a.pass ? `${C.green}✅` : `${C.red}❌`;
    const label = a.negativeCheck
      ? `${C.red}[UNEXPECTEDLY MAPPED]${C.reset} `
      : `${C.cyan}[SHOULD MAP]${C.reset} `;

    console.log(`  ${C.bold}│${C.reset}  ${icon}${C.reset} ${label}${C.bold}${a.field}${C.reset}`);

    if (a.sentConditions?.length) {
      console.log(`  ${C.bold}│${C.reset}       ${C.gray}CONDITIONS TO MAP THIS FIELD:${C.reset}`);
      for (const sc of a.sentConditions) {
        const cIcon = sc.match ? `${C.green}✅` : `${C.red}❌`;
        console.log(`  ${C.bold}│${C.reset}         ${cIcon}${C.reset} ${C.gray}${sc.key.padEnd(38)} required: ${String(sc.required).padEnd(20)} sent: ${sc.sent}${C.reset}`);
      }
    }

    if (!a.negativeCheck && a.sentConditions?.every(c => c.match)) {
      console.log(`  ${C.bold}│${C.reset}       ${C.green}→ All conditions met — field SHOULD map${C.reset}`);
    } else if (a.negativeCheck && !a.pass) {
      console.log(`  ${C.bold}│${C.reset}       ${C.red}→ Field was written unexpectedly — check backend logic${C.reset}`);
    }

    console.log(`  ${C.bold}│${C.reset}       ${C.gray}GOT         : ${actual}${C.reset}`);
    if (!a.pass) {
      console.log(`  ${C.bold}│${C.reset}       ${C.red}EXPECTED    : ${exp}${C.reset}`);
      if (!a.negativeCheck && result.flowType === 'positive') {
        console.log(`  ${C.bold}│${C.reset}       ${C.gray}(expected = sent UTC − 5h30m IST, ms truncated to .000Z)${C.reset}`);
      }
    }
    console.log(`  ${C.bold}│${C.reset}`);
  }

  const overall = result.pass ? `${C.green}✅ PASSED` : `${C.red}❌ FAILED`;
  console.log(`  ${C.bold}├${box}┤${C.reset}`);
  console.log(`  ${C.bold}│${C.reset}  Overall  : ${overall}${C.reset}`);
  console.log(`  ${C.bold}└${box}┘${C.reset}`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Field listing helpers
// ─────────────────────────────────────────────────────────────────────────────

function listPositiveFields() {
  console.log(`\n  ${C.bold}${C.yellow}ROAD POSITIVE FIELDS${C.reset}`);
  console.log(`  ${C.gray}${'Field'.padEnd(44)} ${'Event'.padEnd(22)} Codes${C.reset}`);
  console.log(`  ${C.gray}${'─'.repeat(80)}${C.reset}`);
  for (const [key, meta] of Object.entries(ROAD_FIELDS)) {
    const note = meta.note ? `  ${C.gray}(${meta.note})${C.reset}` : '';
    console.log(`    ${C.cyan}${key.padEnd(44)}${C.reset}${C.dim}${meta.event.padEnd(22)}${C.reset}${meta.sitCode}/${meta.justCode}${note}`);
  }
}

function listNegativeTests() {
  console.log(`\n  ${C.bold}${C.yellow}ROAD NEGATIVE TESTS${C.reset}`);
  console.log(`  ${C.gray}${'ID'.padEnd(6)} Description${C.reset}`);
  console.log(`  ${C.gray}${'─'.repeat(70)}${C.reset}`);
  for (const [id, meta] of Object.entries(NEGATIVE_TESTS)) {
    console.log(`    ${C.cyan}${id.padEnd(6)}${C.reset}${meta.desc}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Select and run events (mirrors ocean's selectAndRunEvents exactly)
// ─────────────────────────────────────────────────────────────────────────────

async function selectAndRunEvents(flowType) {
  banner(`SELECT EVENTS — ${flowType.toUpperCase()}`);

  if (flowType === 'positive') {
    listPositiveFields();
    const fieldAns = await ask(`\n${C.bold}  Which field(s)? (all / comma-separated names): ${C.reset}`);
    const selected = fieldAns === 'all'
      ? Object.keys(ROAD_FIELDS)
      : fieldAns.split(',').map(s => s.trim()).filter(k => ROAD_FIELDS[k]);

    if (!selected.length) { warn('No valid fields selected. Check spelling.'); return; }

    info(`Running ${selected.length} event(s): ${selected.join(', ')}`);

    for (const key of selected) {
      console.log(`\n  ${C.bold}${C.magenta}► ${key}${C.reset}`);
      const result = await executeEvent(key, ROAD_FIELDS[key]);
      printEventResult(result);
    }

  } else {
    // negative
    listNegativeTests();
    const testAns = await ask(`\n${C.bold}  Which test(s)? (all / comma-separated IDs like n01,n03): ${C.reset}`);
    const selected = testAns === 'all'
      ? Object.keys(NEGATIVE_TESTS)
      : testAns.split(',').map(s => s.trim()).filter(k => NEGATIVE_TESTS[k]);

    if (!selected.length) { warn('No valid test IDs selected. Use n01–n13.'); return; }

    info(`Running ${selected.length} negative test(s): ${selected.join(', ')}`);

    for (const id of selected) {
      console.log(`\n  ${C.bold}${C.magenta}► ${id} — ${NEGATIVE_TESTS[id].desc}${C.reset}`);
      const result = await executeNegativeTest(id, NEGATIVE_TESTS[id]);
      printEventResult(result);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  RTU setup
// ─────────────────────────────────────────────────────────────────────────────

async function setupRtuCode() {
  banner('RTU SETUP — Create via Code');
  session.loadSite = pickRandom(LOADING_SITES);
  session.delSite  = pickRandom(DELIVERY_SITES);
  dim(`Load: ${session.loadSite.city} (${session.loadSite.country})  →  Delivery: ${session.delSite.city} (${session.delSite.country})`);

  const { code, transportOrderId } = await createRTU(session.loadSite, session.delSite);
  session.rtuCode  = code;
  session.orderRef = transportOrderId;

  ok(`RTU created → code=${code}  orderRef=${transportOrderId}`);
  info('Waiting for active=1 valid=1...');

  const rec = await pollSchedulerActive(code);
  process.stdout.write('\n');

  if (rec) ok(`Scheduler: active=${rec.active}  valid=${rec.valid}${rec.derived ? '  (derived from RTU fields)' : ''}`);
  else     warn('Could not confirm active=1 valid=1 — proceeding anyway');

  return true;
}

async function setupRtuManual() {
  banner('RTU SETUP — Manual Entry');
  session.rtuCode  = (await ask(`${C.cyan}  RTU internal code: ${C.reset}`)).trim();
  session.orderRef = (await ask(`${C.cyan}  transportOrderId (orderRef): ${C.reset}`)).trim();
  session.loadSite = LOADING_SITES[0];
  session.delSite  = DELIVERY_SITES[0];
  ok(`Using RTU code=${session.rtuCode}  orderRef=${session.orderRef}`);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
//  HTML Report (same style as ocean session report)
// ─────────────────────────────────────────────────────────────────────────────

function generateReport() {
  const now      = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const duration = ((Date.now() - session.startTime) / 1000).toFixed(1);
  const passed   = session.events.filter(e => e.pass).length;
  const failed   = session.events.filter(e => !e.pass).length;
  const total    = session.events.length;

  const eventRows = session.events.map((e, i) => {
    const assertRows = e.assertions.map(a => {
      if (a.negativeCheck && a.pass) {
        const mismatch = a.sentConditions?.find(c => !c.match);
        const reason   = mismatch
          ? `sent <code>${mismatch.key}</code> = <b>"${mismatch.sent}"</b> but required <b>"${mismatch.required}"</b>`
          : 'Conditions not met';
        return `<tr class="blocked"><td>🚫</td><td><span class="blocked-label">BLOCKED</span><br><code class="field-name">${a.field}</code></td><td class="cond-cell"><div class="cond-summary blocked">Not written because: ${reason}</div></td><td><code>${String(a.actual ?? '—').slice(0,50)}</code></td><td></td></tr>`;
      }
      const label    = a.negativeCheck ? '❗ UNEXPECTEDLY MAPPED' : '✔ SHOULD MAP';
      const labelCls = a.negativeCheck ? 'unexpected-label' : 'pos-label';
      const condRows = (a.sentConditions || []).map(c => `<tr class="cond-row ${c.match ? '' : 'cond-fail'}"><td>${c.match ? '✅' : '❌'}</td><td class="cond-key">${c.key}</td><td class="cond-required">required: <code>${c.required}</code></td><td class="cond-sent">sent: <code>${c.sent}</code></td></tr>`).join('');
      const condBlock = condRows ? `<div class="cond-block"><div class="cond-title">Conditions to map this field:</div><table class="cond-table">${condRows}</table></div>` : '';
      const summary = a.negativeCheck
        ? `<div class="cond-summary neg">⚠ Field was written unexpectedly</div>`
        : (a.sentConditions?.every(c => c.match) ? `<div class="cond-summary pos">All conditions met → field should map</div>` : `<div class="cond-summary warn">Some conditions not met</div>`);
      return `<tr class="${a.pass ? 'pass' : 'fail'}"><td>${a.pass ? '✅' : '❌'}</td><td><span class="${labelCls}">${label}</span><br><code class="field-name">${a.field}</code></td><td class="cond-cell">${condBlock}${summary}</td><td><code>${String(a.actual ?? '—').slice(0,60)}</code></td><td>${a.pass ? '' : `<code class="exp">${String(a.expected ?? '—').slice(0,60)}</code>`}</td></tr>`;
    }).join('');

    const flowBadge = e.flowType === 'negative' ? `<span class="flow-neg">NEGATIVE</span>` : `<span class="flow-pos">POSITIVE</span>`;
    const stratBadge = e.negativeStrategy ? `<div class="neg-strategy">🔀 <b>Strategy:</b> ${e.negativeStrategy}</div>` : '';

    return `
    <div class="event-card ${e.pass ? 'pass' : 'fail'}">
      <div class="event-header">
        <span class="seq">#${i+1}</span>${flowBadge}
        <span class="event-name">${e.fieldKey}</span>
        <span class="sit-type">${e.event || '—'} · ${e.sitCode || 'null'}/${e.justCode || 'null'}</span>
        <span class="http">HTTP ${e.webhookStatus}</span>
        <span class="duration">${e.duration}ms</span>
        <span class="ts">${e.timestamp.slice(11,19)} UTC</span>
        <span class="badge ${e.pass ? 'pass' : 'fail'}">${e.pass ? 'PASSED' : 'FAILED'}</span>
      </div>${stratBadge}
      <table class="assertions">
        <thead><tr><th></th><th>Assertion · Field</th><th>Why it maps / Why blocked</th><th>Actual value</th><th>Expected (on fail)</th></tr></thead>
        <tbody>${assertRows}</tbody>
      </table>
    </div>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/>
<title>Road E2E Session Report — ${now}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f2f5;color:#1a1a2e;font-size:13px;}
.hdr{background:linear-gradient(135deg,#1a1a2e,#0f3460);color:#fff;padding:24px 40px;}
.hdr h1{font-size:1.5rem;font-weight:700;}.hdr .sub{color:#a0aec0;margin-top:4px;}
.stats{display:flex;gap:24px;margin-top:14px;flex-wrap:wrap;}
.stat{font-size:.78rem;color:#cbd5e0;}.stat strong{display:block;font-size:1rem;}
.stat.pass strong{color:#9ae6b4;}.stat.fail strong{color:#fc8181;}
.banner{margin:16px 40px;padding:12px 20px;border-radius:8px;font-weight:600;font-size:.9rem;}
.banner.ok{background:#f0fff4;border:1.5px solid #68d391;color:#276749;}
.banner.fail{background:#fff5f5;border:1.5px solid #fc8181;color:#9b2335;}
.rtu-box{margin:0 40px 16px;background:#fff;border-radius:8px;border:1px solid #e2e8f0;padding:14px 20px;font-size:.82rem;}
.rtu-box h3{font-weight:700;margin-bottom:8px;color:#4a5568;}
.rtu-box .fields{display:flex;flex-wrap:wrap;gap:12px;}
.rtu-box .field-item{background:#edf2f7;padding:4px 10px;border-radius:4px;}
.rtu-box .field-item span{font-weight:700;color:#2d3748;}
.events{margin:0 40px 32px;display:flex;flex-direction:column;gap:12px;}
.event-card{background:#fff;border-radius:8px;border:1px solid #e2e8f0;overflow:hidden;}
.event-card.pass{border-left:4px solid #68d391;}.event-card.fail{border-left:4px solid #fc8181;}
.event-header{display:flex;align-items:center;gap:8px;padding:10px 16px;background:#fafafa;flex-wrap:wrap;}
.seq{background:#edf2f7;padding:2px 8px;border-radius:4px;font-weight:700;font-size:.75rem;}
.event-name{font-weight:700;font-size:.85rem;color:#2d3748;}
.sit-type{font-size:.75rem;background:#ebf4ff;color:#2b6cb0;padding:2px 8px;border-radius:10px;}
.http{font-size:.75rem;color:#718096;}.duration{font-size:.72rem;color:#a0aec0;}
.ts{font-size:.72rem;color:#a0aec0;margin-left:auto;}
.badge{padding:2px 10px;border-radius:10px;font-size:.72rem;font-weight:700;}
.badge.pass{background:#c6f6d5;color:#22543d;}.badge.fail{background:#fed7d7;color:#9b2335;}
.assertions{width:100%;border-collapse:collapse;table-layout:fixed;}
.assertions thead tr{background:#f7fafc;}
.assertions th{padding:6px 14px;text-align:left;font-size:.7rem;text-transform:uppercase;color:#a0aec0;border-bottom:1px solid #e2e8f0;}
.assertions th:nth-child(1){width:38px;}.assertions th:nth-child(2){width:22%;}.assertions th:nth-child(3){width:44%;}.assertions th:nth-child(4){width:18%;}.assertions th:nth-child(5){width:13%;}
.assertions td{padding:7px 14px;border-bottom:1px solid #f7fafc;font-size:.78rem;word-break:break-word;vertical-align:top;}
.assertions td:first-child{text-align:center;padding:7px 4px;width:38px;}
.assertions tr.fail td{background:#fff5f5;}
.assertions .field-name{font-family:monospace;font-weight:700;color:#2b6cb0;font-size:.82rem;}
.pos-label{display:inline-block;background:#c6f6d5;color:#22543d;padding:1px 6px;border-radius:3px;font-size:.7rem;font-weight:700;}
.unexpected-label{display:inline-block;background:#fed7d7;color:#9b2335;padding:1px 6px;border-radius:3px;font-size:.7rem;font-weight:700;}
.flow-pos{background:#c6f6d5;color:#22543d;padding:2px 8px;border-radius:10px;font-size:.72rem;font-weight:700;}
.flow-neg{background:#fed7d7;color:#9b2335;padding:2px 8px;border-radius:10px;font-size:.72rem;font-weight:700;}
.neg-strategy{background:#fffbeb;border:1px solid #f6e05e;border-radius:6px;padding:8px 14px;margin:8px 0 4px;font-size:.8rem;color:#744210;}
.cond-cell{vertical-align:top;}.cond-block{background:#f7fafc;border:1px solid #e2e8f0;border-radius:4px;padding:6px 8px;margin-bottom:4px;}
.cond-title{font-size:.7rem;font-weight:700;color:#4a5568;margin-bottom:4px;text-transform:uppercase;letter-spacing:.04em;}
.cond-table{width:100%;border-collapse:collapse;font-size:.72rem;}
.cond-table td{padding:2px 6px;vertical-align:top;word-break:break-word;}
.cond-row.cond-fail td{background:#fff5f5;}
.cond-key{font-family:monospace;color:#2d3748;font-weight:600;width:38%;}
.cond-required{color:#718096;width:33%;}.cond-sent{color:#2d3748;width:29%;}
.cond-summary{font-size:.72rem;padding:3px 6px;border-radius:3px;margin-top:3px;font-weight:600;}
.cond-summary.pos{background:#c6f6d5;color:#22543d;}.cond-summary.neg{background:#fed7d7;color:#9b2335;}
.cond-summary.warn{background:#fefcbf;color:#744210;}.cond-summary.blocked{background:#fef3c7;color:#92400e;}
.blocked-label{display:inline-block;background:#fef3c7;color:#92400e;padding:1px 6px;border-radius:3px;font-size:.7rem;font-weight:700;}
tr.blocked td{background:#fffbeb;}
code{font-family:monospace;background:#f7fafc;padding:1px 5px;border-radius:3px;font-size:.77rem;}
.exp{background:#fff5f5;color:#e53e3e;}
.footer{text-align:center;padding:16px;font-size:.75rem;color:#a0aec0;}
</style></head><body>
<div class="hdr">
  <h1>🚛 Road E2E Session Report — Events-Out</h1>
  <p class="sub">Interactive session: ${now}</p>
  <div class="stats">
    <div class="stat"><strong>${total}</strong>Events Run</div>
    <div class="stat pass"><strong>${passed}</strong>Passed</div>
    <div class="stat fail"><strong>${failed}</strong>Failed</div>
    <div class="stat"><strong>${duration}s</strong>Duration</div>
  </div>
</div>
<div class="banner ${failed === 0 ? 'ok' : 'fail'}">${failed === 0 ? '✅ All events passed' : `❌ ${failed} event(s) failed`}</div>
<div class="rtu-box">
  <h3>RTU Details</h3>
  <div class="fields">
    <div class="field-item">Code <span>${session.rtuCode || '—'}</span></div>
    <div class="field-item">orderRef <span>${session.orderRef || '—'}</span></div>
    <div class="field-item">Load <span>${session.loadSite?.city || '—'} (${session.loadSite?.country || '—'})</span></div>
    <div class="field-item">Delivery <span>${session.delSite?.city || '—'} (${session.delSite?.country || '—'})</span></div>
  </div>
</div>
<div class="events">${eventRows || '<p style="padding:20px 40px;color:#a0aec0">No events executed.</p>'}</div>
<div class="footer">Logward QA Automation — Road E2E Session Report · ${now}</div>
</body></html>`;

  const dir  = path.resolve('playwright-report', 'sessions');
  const file = path.join(dir, `road-session-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.html`);
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
  console.log(`${C.bold}${C.white}║  Logward Road — Interactive E2E Events-Out Test Session    ║${C.reset}`);
  console.log(`${C.bold}${C.white}║  Type "finish" at any time to close and generate report    ║${C.reset}`);
  console.log(`${C.bold}${C.white}╚════════════════════════════════════════════════════════════╝\n${C.reset}`);

  // ── Step 1: Code or manual? ──────────────────────────────────────────────
  banner('RTU SETUP');
  const setupAns = await ask(`${C.bold}Create RTU through CODE or MANUAL? (code/manual): ${C.reset}`);

  let setupOk;
  if (setupAns.toLowerCase() === 'manual') setupOk = await setupRtuManual();
  else                                     setupOk = await setupRtuCode();

  if (!setupOk) { err('RTU setup failed. Exiting.'); rl.close(); return; }

  info(`\nSession active. RTU: ${session.rtuCode} | orderRef: ${session.orderRef}`);
  console.log(`${C.gray}Type "finish" to close and generate the report.${C.reset}`);

  // ── Main event loop ──────────────────────────────────────────────────────
  while (true) {
    console.log(`\n${'─'.repeat(62)}`);
    const flowAns = await ask(`\n${C.bold}Flow type? (positive / negative / finish): ${C.reset}`);

    if (flowAns.toLowerCase() === 'finish' || flowAns.toLowerCase() === 'end test') break;

    if (!['positive', 'negative'].includes(flowAns.toLowerCase())) {
      warn(`Unknown flow "${flowAns}". Use: positive / negative / finish`);
      continue;
    }

    await selectAndRunEvents(flowAns.toLowerCase());

    const total  = session.events.length;
    const passed = session.events.filter(e => e.pass).length;
    console.log(`\n  ${C.bold}Session so far: ${passed}/${total} passed${C.reset}`);
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
    try { require('child_process').execSync(`open "${reportFile}"`); } catch {}
  } else {
    info('No events executed — no report generated.');
  }

  rl.close();
  console.log(`\n${C.gray}Session ended. Goodbye.${C.reset}\n`);
}

main().catch(e => { console.error(e); rl.close(); process.exit(1); });
