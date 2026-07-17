#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  scripts/runRoadEventsOutSession.js
//
//  Interactive E2E Events-Out session for Logward Road tracking.
//
//  Usage:
//    node scripts/runRoadEventsOutSession.js
//
//  What it does:
//    1. Auto-creates 1 RTU with full valid fields (active=1 valid=1)
//    2. Interactive loop — pick which event to fire:
//         d1–d8  → 8 standard road events
//         eta1   → ETA_EVENT with etd (pickup ETA)
//         eta2   → ETA_EVENT with eta (delivery ETA)
//         all    → fire all 8 standard events in sequence
//         neg    → run a negative test on a fresh temp RTU
//         stat   → show current RTU field state
//         fin    → generate HTML report + exit
//    3. After each event: polls RTU, shows which field was written + value
//    4. On "fin": opens a consolidated HTML report
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const readline = require('readline');
const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const { spawnSync } = require('child_process');

const { getAdminToken }  = require('../helpers/shared/cognitoAuth');
const { CONFIG }         = require('../helpers/road/roadConfig');
const { LOADING_SITES, DELIVERY_SITES, STAGE_DATES, stageDate, pick } = require('../helpers/road/roadSites');

// ─────────────────────────────────────────────────────────────────────────────
//  Terminal colours
// ─────────────────────────────────────────────────────────────────────────────

const C = {
  reset:   '\x1b[0m',  bold:    '\x1b[1m',  dim:     '\x1b[2m',
  cyan:    '\x1b[36m', green:   '\x1b[32m', yellow:  '\x1b[33m',
  red:     '\x1b[31m', white:   '\x1b[97m', gray:    '\x1b[90m',
  magenta: '\x1b[35m', orange:  '\x1b[33m', blue:    '\x1b[34m',
};

const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on('close', () => {});
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
  rtuCode:    null,
  orderRef:   null,
  loadSite:   null,
  delSite:    null,
  startTime:  Date.now(),
  events:     [],  // { label, sitCode, justCode, event, field, date, httpStatus, valueBefore, valueAfter, pass }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Event definitions
// ─────────────────────────────────────────────────────────────────────────────

const EVENTS = {
  d1:   { label: 'DRIVING_TO_LOAD',    sitCode: 'EML', justCode: 'CFM', event: 'DRIVING_TO_LOAD',    field: 'truckDrivingToPickUpLocation',       dateKey: 'drivingToLoad' },
  d2:   { label: 'ARR_LOAD',           sitCode: 'EML', justCode: 'ARS', event: 'ARR_LOAD',           field: 'actualArrivalAtPickUpLocation',      dateKey: 'arrivedAtPickUp' },
  d3:   { label: 'CON_LOAD',           sitCode: 'ECH', justCode: 'CFM', event: 'CON_LOAD',           field: 'loaded',                             dateKey: 'loaded' },
  d4:   { label: 'LEFT_LOADING_SITE',  sitCode: 'ECH', justCode: 'DES', event: 'LEFT_LOADING_SITE',  field: 'actualDeparturePolRoad',             dateKey: 'leftLoading' },
  d5:   { label: 'DRIVING_TO_UNLOAD',  sitCode: 'MLV', justCode: 'CFM', event: 'DRIVING_TO_UNLOAD',  field: 'truckDrivingToDeliveryLocation',     dateKey: 'drivingToDelivery' },
  d6:   { label: 'ARR_UNLOAD',         sitCode: 'LIV', justCode: 'ARS', event: 'ARR_UNLOAD',         field: 'actualArrivalPodRoad',               dateKey: 'arrivedAtDelivery' },
  d7:   { label: 'CON_UNLOAD',         sitCode: 'LIV', justCode: 'CFM', event: 'CON_UNLOAD',         field: 'delivered',                          dateKey: 'delivered' },
  d8:   { label: 'DRIVER_LEFT_UNLOAD', sitCode: 'LIV', justCode: 'DES', event: 'DRIVER_LEFT_UNLOAD', field: 'truckDepartureFromDeliveryLocation', dateKey: 'leftDelivery' },
  eta1: { label: 'ETA_EVENT (pickup)', sitCode: 'COM', justCode: 'CFM', event: 'ETA_EVENT',          field: 'predictedArrivalAtPickUpLocation',   dateKey: 'etaPickUp',  etd: true },
  eta2: { label: 'ETA_EVENT (delivery)',sitCode: 'COM', justCode: 'CFM', event: 'ETA_EVENT',         field: 'predictedArrivalAtDeliveryLocation', dateKey: 'etaDelivery',eta: true },
};

const ALL_ROAD_FIELDS = [
  'truckDrivingToPickUpLocation',
  'actualArrivalAtPickUpLocation',
  'loaded',
  'actualDeparturePolRoad',
  'truckDrivingToDeliveryLocation',
  'actualArrivalPodRoad',
  'delivered',
  'truckDepartureFromDeliveryLocation',
  'predictedArrivalAtPickUpLocation',
  'predictedArrivalAtDeliveryLocation',
];

// ─────────────────────────────────────────────────────────────────────────────
//  HTTP helpers (native, no Playwright)
// ─────────────────────────────────────────────────────────────────────────────

function httpRequest(method, hostname, path, headers, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = bodyObj ? JSON.stringify(bodyObj) : null;
    const reqHeaders = { ...headers };
    if (body) reqHeaders['Content-Length'] = Buffer.byteLength(body);

    const req = https.request({ hostname, path, method, headers: reqHeaders }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  RTU helpers
// ─────────────────────────────────────────────────────────────────────────────

let _rtuCounter = 0;
const _RUN_TS   = String(Date.now()).slice(-5);

function nextOrderRef() {
  _rtuCounter++;
  return `E2ERDT${String(_rtuCounter).padStart(2,'0')}${_RUN_TS}`;
}

function fmtDate(d) {
  const p = n => String(n).padStart(2,'0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function roadDates(offsetDays = 22) {
  const base = new Date();
  const add = days => {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + days);
    d.setUTCHours(9, 0, 0, 0);
    return fmtDate(d);
  };
  return {
    pickUpStartDate:   add(offsetDays),
    pickUpEndDate:     add(offsetDays + 2),
    deliveryStartDate: add(offsetDays + 5),
    deliveryEndDate:   add(offsetDays + 7),
  };
}

async function createRTU(loadSite, delSite, overrides = {}) {
  const token   = await getAdminToken();
  const orderRef = nextOrderRef();
  const plate    = `E2ELPT${String(_rtuCounter).padStart(2,'0')}${_RUN_TS}`;
  const dates    = roadDates();

  const fields = {
    mot: 'ROAD', modeOfTransport: 'Truck', orderStatus: 'Active',
    trackingStatus: 'In Progress', loadType: 'ftl', carrierId: 'C1',
    transportOrderId:  orderRef,
    licensePlateTruck: plate,
    pickupAddressName:    loadSite.name,
    pickupAddressStreet:  loadSite.address,
    pickupAddressZipcode: loadSite.zipcode,
    pickupAddressCity:    loadSite.city,
    pickupAddressCountry: loadSite.country,
    pickUpTimeZone:      'Europe/Amsterdam',
    deliveryLocationName:    delSite.name,
    deliveryLocationStreet:  delSite.address,
    deliveryLocationZipcode: delSite.zipcode,
    deliveryLocationCity:    delSite.city,
    deliveryLocationCountry: delSite.country,
    deliveryTimeZone:    'Europe/Berlin',
    ...dates,
    ...overrides,
  };

  const url = new URL(CONFIG.ADMIN_UPSERT_BASE_URL + CONFIG.UPSERT_PATH + '?createNew=true');
  const res = await httpRequest('POST', url.hostname, url.pathname + url.search, {
    'Authorization': `Bearer ${token}`,
    'Content-Type':  'application/json',
    'accept':        'application/json',
  }, { data: [fields] });

  const code = res.body?.meta?.params?.code
    || (Array.isArray(res.body?.data) ? res.body.data[0]?.code : null)
    || res.body?.data?.code || null;

  return { code, orderRef, plate, status: res.status };
}

async function getRTU(code) {
  const token = await getAdminToken();
  const url   = new URL(CONFIG.ADMIN_BASE_URL + CONFIG.GET_PATH + '/' + code);
  const res   = await httpRequest('GET', url.hostname, url.pathname, {
    'Authorization': `Bearer ${token}`,
    'accept':        'application/json',
  }, null);
  return res.body?.data ?? res.body;
}

async function pollRTUChanged(code, baseline, timeoutMs = CONFIG.POLL_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, CONFIG.POLL_INTERVAL_MS));
    const rtu = await getRTU(code).catch(() => null);
    const changed = rtu?.lastChangedAt ?? null;
    if (changed && changed !== baseline) {
      dim(`RTU updated (lastChangedAt: ${changed})`);
      return rtu;
    }
    process.stdout.write(`  ${C.gray}⏳ polling...${C.reset}\r`);
  }
  process.stdout.write('\n');
  warn(`Timed out after ${timeoutMs}ms — returning latest RTU`);
  return await getRTU(code).catch(() => null);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Webhook
// ─────────────────────────────────────────────────────────────────────────────

function buildPayload(eventDef, orderRef, loadSite, delSite, dateOverride) {
  const date = dateOverride ?? STAGE_DATES[eventDef.dateKey] ?? stageDate(-1, 8);
  const orderExtra = {};
  if (eventDef.etd) orderExtra.etd = date;
  if (eventDef.eta) orderExtra.eta = date;

  return {
    date_transmission: new Date().toISOString(),
    owner: {
      organization: { id: 'Q2JK9RVN', name: 'LIDL' },
      agency:       { id: 'Q27K7Z42', name: 'LIDL_Road', siret: null },
    },
    order: {
      edi_reference:     `E2E-EDI-${orderRef}`,
      reference:         orderRef,
      eta:               null,
      etd:               null,
      url:               'https://view.shippeo.com/orderPublic/test',
      shippeo_reference: 'NPG8WVVV',
      ...orderExtra,
    },
    tour: {
      edi_reference: `E2E-TOUR-${orderRef}`,
      reference:     `E2E-TOUR-${orderRef}`,
    },
    situation: {
      event:              eventDef.event,
      situation_code:     eventDef.sitCode,
      justification_code: eventDef.justCode,
      input_date:         date,
      date:               date,
    },
    situation_justification: {
      theoretical_distance: 2717,
      position: { lat: 48.718822, lng: 9.543809 },
      pair:       { id: 'NGEMD8KM', type: 'hashid' },
      attributes: { mean: 'ba1f585a38050167', driver: 'ba1f585a38050167' },
    },
    loading_site: {
      id: null, externalID: null,
      name: loadSite.name, address_line: loadSite.address,
      zipcode: loadSite.zipcode, city: loadSite.city, country: loadSite.country,
      position: { lat: loadSite.lat, lng: loadSite.lng }, iata_code: null,
    },
    delivery_site: {
      id: null, externalID: null,
      name: delSite.name, address_line: delSite.address,
      zipcode: delSite.zipcode, city: delSite.city, country: delSite.country,
      position: { lat: delSite.lat, lng: delSite.lng }, iata_code: null,
    },
    carrier: {
      organization: { id: 'JNRJ56N8', name: 'E2E Test Carrier' },
      agency:       { id: 'LNGW9XN3', name: 'E2E Test Agency', siret: null },
    },
  };
}

async function sendWebhook(payload) {
  const token = await getAdminToken();
  const url   = new URL(CONFIG.WEBHOOK_BASE_URL + CONFIG.WEBHOOK_PATH);
  return httpRequest('POST', url.hostname, url.pathname, {
    'Content-Type':  'application/json',
    'x-api-key':     CONFIG.WEBHOOK_API_KEY,
    'Authorization': `Bearer ${token}`,
  }, payload);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Event execution
// ─────────────────────────────────────────────────────────────────────────────

async function fireEvent(eventDef, rtuCode, orderRef, loadSite, delSite) {
  const rtuBefore = await getRTU(rtuCode).catch(() => null);
  const baseline  = rtuBefore?.lastChangedAt ?? null;
  const dateSent  = STAGE_DATES[eventDef.dateKey] ?? stageDate(-1, 8);

  const valueBefore = rtuBefore?.[eventDef.field] ?? null;

  dim(`Sending ${eventDef.label} (${eventDef.sitCode}/${eventDef.justCode})...`);

  const payload = buildPayload(eventDef, orderRef, loadSite, delSite);
  const t0  = Date.now();
  const wh  = await sendWebhook(payload);
  const dur = Date.now() - t0;

  const statusOk = wh.status >= 200 && wh.status < 300;
  console.log(`  ${C.gray}HTTP ${wh.status}${C.reset}${statusOk ? '' : ` ${C.red}← unexpected${C.reset}`}  (${dur}ms)`);

  let rtuAfter = rtuBefore;
  if (statusOk) {
    rtuAfter = await pollRTUChanged(rtuCode, baseline);
  }

  const valueAfter = rtuAfter?.[eventDef.field] ?? null;
  const pass = statusOk && valueAfter !== null && valueAfter !== valueBefore;

  // Print result
  const box = '─'.repeat(56);
  console.log(`\n  ${C.bold}┌${box}┐${C.reset}`);
  console.log(`  ${C.bold}│ ${eventDef.label.padEnd(54)} │${C.reset}`);
  console.log(`  ${C.bold}├${box}┤${C.reset}`);
  console.log(`  ${C.bold}│${C.reset}  Condition  : ${C.cyan}${eventDef.sitCode}/${eventDef.justCode}/${eventDef.event}${C.reset}`);
  console.log(`  ${C.bold}│${C.reset}  Field      : ${C.magenta}${eventDef.field}${C.reset}`);
  console.log(`  ${C.bold}│${C.reset}  Date sent  : ${dateSent}`);
  if (valueBefore !== null) {
    console.log(`  ${C.bold}│${C.reset}  Before     : ${C.gray}${valueBefore}${C.reset}`);
  }
  const icon = pass ? `${C.green}✅` : `${C.red}❌`;
  console.log(`  ${C.bold}│${C.reset}  After      : ${icon} ${C.reset}${valueAfter ?? 'null (not written)'}`);
  if (!pass && statusOk) {
    console.log(`  ${C.bold}│${C.reset}  ${C.yellow}⚠  Field did not update — check condition match or backend${C.reset}`);
  }
  console.log(`  ${C.bold}└${box}┘${C.reset}`);

  session.events.push({
    label:       eventDef.label,
    sitCode:     eventDef.sitCode,
    justCode:    eventDef.justCode,
    event:       eventDef.event,
    field:       eventDef.field,
    dateSent,
    httpStatus:  wh.status,
    valueBefore,
    valueAfter,
    pass,
    duration:    dur,
    ts:          new Date().toISOString(),
    negative:    false,
  });

  return { pass, valueAfter };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Negative test (uses fresh temp RTU)
// ─────────────────────────────────────────────────────────────────────────────

const NEG_TESTS = {
  n1: { desc: 'Wrong situation_code (XXX)', sitCode: 'XXX', justCode: 'CFM', event: 'DRIVING_TO_LOAD', field: 'truckDrivingToPickUpLocation', expectNull: true },
  n2: { desc: 'Wrong justification_code (XXX)', sitCode: 'EML', justCode: 'XXX', event: 'DRIVING_TO_LOAD', field: 'truckDrivingToPickUpLocation', expectNull: true },
  n3: { desc: 'Wrong event name (UNKNOWN_EVENT)', sitCode: 'EML', justCode: 'CFM', event: 'UNKNOWN_EVENT', field: 'truckDrivingToPickUpLocation', expectNull: true },
  n4: { desc: 'Lowercase event (case-sensitive)', sitCode: 'EML', justCode: 'CFM', event: 'driving_to_load', field: 'truckDrivingToPickUpLocation', expectNull: true },
  n5: { desc: 'Lowercase situation_code (case-sensitive)', sitCode: 'eml', justCode: 'CFM', event: 'DRIVING_TO_LOAD', field: 'truckDrivingToPickUpLocation', expectNull: true },
  n6: { desc: 'ETA_EVENT — no eta, no etd → nothing written', sitCode: 'COM', justCode: 'CFM', event: 'ETA_EVENT', field: 'predictedArrivalAtDeliveryLocation', expectNull: true, noEta: true },
};

async function runNegativeTest(key) {
  const neg = NEG_TESTS[key];
  if (!neg) { warn(`Unknown negative test "${key}". Valid: ${Object.keys(NEG_TESTS).join(', ')}`); return; }

  banner(`NEGATIVE — ${neg.desc}`, '🚫');
  info('Creating fresh temp RTU...');
  const loadSite = pick(LOADING_SITES);
  const delSite  = pick(DELIVERY_SITES);
  const { code, orderRef, status } = await createRTU(loadSite, delSite);
  if (!code) { err(`Failed to create temp RTU (HTTP ${status})`); return; }
  info(`Temp RTU: code=${code}  orderRef=${orderRef}`);

  await new Promise(r => setTimeout(r, 2000)); // brief settle

  const rtuBefore   = await getRTU(code).catch(() => null);
  const valueBefore = rtuBefore?.[neg.field] ?? null;

  const fakeDef = {
    label: neg.desc, sitCode: neg.sitCode, justCode: neg.justCode,
    event: neg.event, field: neg.field, dateKey: 'drivingToLoad',
    ...(neg.noEta ? {} : {}),
  };
  const payload = buildPayload(fakeDef, orderRef, loadSite, delSite);
  if (neg.noEta) {
    payload.order.eta = null;
    payload.order.etd = null;
  }

  dim(`Sending with ${neg.sitCode}/${neg.justCode}/${neg.event}...`);
  const wh = await sendWebhook(payload);
  console.log(`  ${C.gray}HTTP ${wh.status}${C.reset}`);

  await new Promise(r => setTimeout(r, CONFIG.POLL_INTERVAL_MS * 2));
  const rtuAfter  = await getRTU(code).catch(() => null);
  const valueAfter = rtuAfter?.[neg.field] ?? null;

  const pass = neg.expectNull ? (valueAfter === null || valueAfter === valueBefore) : (valueAfter !== null);

  const icon = pass ? `${C.green}✅` : `${C.red}❌`;
  console.log(`  ${icon} ${C.reset}${neg.field}: ${valueAfter ?? 'null (not written)'}  ${pass ? '← correct, condition blocked' : '← UNEXPECTED — field was written!'}`);

  session.events.push({
    label:      `[NEG] ${neg.desc}`,
    sitCode:    neg.sitCode,
    justCode:   neg.justCode,
    event:      neg.event,
    field:      neg.field,
    dateSent:   STAGE_DATES.drivingToLoad,
    httpStatus: wh.status,
    valueBefore,
    valueAfter,
    pass,
    duration:   0,
    ts:         new Date().toISOString(),
    negative:   true,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  RTU field state display
// ─────────────────────────────────────────────────────────────────────────────

async function showRTUState(rtuCode) {
  banner('RTU FIELD STATE', '📋');
  const rtu = await getRTU(rtuCode).catch(() => null);
  if (!rtu) { err('Could not fetch RTU'); return; }

  const fieldLabels = {
    truckDrivingToPickUpLocation:       'truckDrivingToPickUpLocation       [d1 EML/CFM]',
    actualArrivalAtPickUpLocation:      'actualArrivalAtPickUpLocation      [d2 EML/ARS]',
    loaded:                             'loaded                             [d3 ECH/CFM]',
    actualDeparturePolRoad:             'actualDeparturePolRoad             [d4 ECH/DES]',
    truckDrivingToDeliveryLocation:     'truckDrivingToDeliveryLocation     [d5 MLV/CFM]',
    actualArrivalPodRoad:               'actualArrivalPodRoad               [d6 LIV/ARS]',
    delivered:                          'delivered                          [d7 LIV/CFM]',
    truckDepartureFromDeliveryLocation: 'truckDepartureFromDeliveryLocation [d8 LIV/DES]',
    predictedArrivalAtPickUpLocation:   'predictedArrivalAtPickUpLocation   [eta1 COM/CFM/etd]',
    predictedArrivalAtDeliveryLocation: 'predictedArrivalAtDeliveryLocation [eta2 COM/CFM/eta]',
  };

  let setCount = 0;
  for (const [field, label] of Object.entries(fieldLabels)) {
    const val = rtu[field] ?? null;
    if (val) {
      setCount++;
      console.log(`  ${C.green}✅${C.reset} ${C.bold}${label}${C.reset}`);
      console.log(`     ${C.gray}= ${val}${C.reset}`);
    } else {
      console.log(`  ${C.gray}⬜ ${label}${C.reset}`);
    }
  }
  console.log(`\n  ${C.bold}${setCount}/${ALL_ROAD_FIELDS.length} fields set${C.reset}  |  RTU code: ${C.cyan}${rtuCode}${C.reset}  |  lastChangedAt: ${C.gray}${rtu.lastChangedAt ?? '—'}${C.reset}`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  HTML report
// ─────────────────────────────────────────────────────────────────────────────

async function generateReport(rtuCode) {
  const rtu = await getRTU(rtuCode).catch(() => null);
  const totalDuration = Date.now() - session.startTime;
  const passed  = session.events.filter(e => e.pass).length;
  const failed  = session.events.filter(e => !e.pass).length;
  const runDate = new Date().toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' });

  const fmtDur = ms => ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  const eventRows = session.events.map((e, i) => {
    const statusClass = e.pass ? 'pass' : 'fail';
    const icon = e.pass ? '✅' : '❌';
    const negBadge = e.negative ? `<span class="neg-badge">NEG</span>` : '';
    return `
    <tr class="${statusClass}">
      <td class="td-num">${i + 1}</td>
      <td>${negBadge}<strong>${esc(e.label)}</strong></td>
      <td><code>${esc(e.sitCode)}</code> / <code>${esc(e.justCode)}</code> / <code>${esc(e.event)}</code></td>
      <td><code class="field">${esc(e.field)}</code></td>
      <td class="td-val">${esc(e.dateSent)}</td>
      <td class="td-val ${e.valueAfter ? 'has-val' : 'no-val'}">${esc(e.valueAfter ?? '—')}</td>
      <td class="td-status">${icon}</td>
    </tr>`;
  }).join('');

  const fieldStateRows = ALL_ROAD_FIELDS.map(field => {
    const val = rtu?.[field] ?? null;
    const icon = val ? '✅' : '⬜';
    const cls  = val ? 'pass' : 'empty';
    return `<tr class="${cls}"><td>${icon}</td><td><code>${esc(field)}</code></td><td class="td-val">${esc(val ?? '—')}</td></tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Road Events-Out Session Report</title>
<style>
  :root {
    --bg: #0f1117; --surface: #1a1d27; --card: #20242f; --border: #2d3142;
    --text: #e2e4f0; --muted: #7b7f96; --pass: #22c55e; --fail: #ef4444;
    --accent: #6366f1; --accent2: #818cf8; --road: #f97316;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', system-ui, sans-serif; font-size: 14px; line-height: 1.5; }
  .page-header { background: linear-gradient(135deg, #1a1d27 0%, #20242f 60%, #16192a 100%); border-bottom: 2px solid var(--road); padding: 28px 36px 20px; }
  .page-header h1 { font-size: 24px; font-weight: 700; color: var(--road); }
  .page-header .sub { color: var(--muted); font-size: 13px; margin-top: 4px; }
  .meta { display: flex; gap: 24px; flex-wrap: wrap; margin-top: 16px; }
  .meta-item { font-size: 12px; color: var(--muted); } .meta-item strong { color: var(--text); }
  .summary { display: flex; background: var(--surface); border-bottom: 1px solid var(--border); }
  .seg { flex: 1; padding: 16px; text-align: center; border-right: 1px solid var(--border); }
  .seg:last-child { border-right: none; }
  .seg .big { font-size: 28px; font-weight: 700; }
  .seg .lbl { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
  .seg.pass .big { color: var(--pass); } .seg.fail .big { color: var(--fail); } .seg.info .big { color: var(--accent2); }
  .content { padding: 28px 36px; max-width: 1300px; margin: 0 auto; }
  h2 { font-size: 14px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; margin: 28px 0 14px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
  table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; margin-bottom: 28px; }
  th { font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; padding: 10px 14px; text-align: left; background: rgba(0,0,0,0.2); }
  td { padding: 9px 14px; border-top: 1px solid var(--border); vertical-align: top; }
  tr.pass td:first-child { border-left: 3px solid var(--pass); }
  tr.fail td:first-child { border-left: 3px solid var(--fail); }
  tr.empty td:first-child { border-left: 3px solid var(--border); }
  .td-num { width: 36px; color: var(--muted); font-size: 12px; }
  .td-status { width: 48px; text-align: center; font-size: 16px; }
  .td-val { font-size: 12px; font-family: monospace; color: var(--muted); }
  .td-val.has-val { color: var(--pass); }
  .td-val.no-val { color: var(--muted); }
  code { font-family: monospace; font-size: 12px; background: rgba(99,102,241,0.12); color: var(--accent2); padding: 1px 6px; border-radius: 4px; }
  code.field { color: var(--road); background: rgba(249,115,22,0.1); }
  .neg-badge { background: rgba(239,68,68,0.15); color: #fca5a5; font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 4px; margin-right: 6px; text-transform: uppercase; }
  .rtu-box { background: var(--card); border: 1px solid var(--border); border-left: 4px solid var(--road); border-radius: 8px; padding: 16px 20px; margin-bottom: 20px; font-size: 13px; }
  .rtu-box strong { color: var(--road); }
  .footer { text-align: center; color: var(--muted); font-size: 12px; padding: 28px; border-top: 1px solid var(--border); margin-top: 12px; }
</style>
</head>
<body>
<div class="page-header">
  <h1>🚛 Road Events-Out — Session Report</h1>
  <p class="sub">Logward ↔ Shippeo Road Tracking · QA Environment · Interactive Session</p>
  <div class="meta">
    <div class="meta-item"><strong>Run date:</strong> ${runDate}</div>
    <div class="meta-item"><strong>Duration:</strong> ${fmtDur(totalDuration)}</div>
    <div class="meta-item"><strong>RTU code:</strong> ${esc(session.rtuCode)}</div>
    <div class="meta-item"><strong>orderRef:</strong> ${esc(session.orderRef)}</div>
    <div class="meta-item"><strong>Load site:</strong> ${esc(session.loadSite?.city)} (${esc(session.loadSite?.country)})</div>
    <div class="meta-item"><strong>Delivery site:</strong> ${esc(session.delSite?.city)} (${esc(session.delSite?.country)})</div>
  </div>
</div>

<div class="summary">
  <div class="seg info"><div class="big">${session.events.length}</div><div class="lbl">Events Fired</div></div>
  <div class="seg pass"><div class="big">${passed}</div><div class="lbl">Passed</div></div>
  <div class="seg fail"><div class="big">${failed}</div><div class="lbl">Failed</div></div>
  <div class="seg info"><div class="big">${fmtDur(totalDuration)}</div><div class="lbl">Duration</div></div>
</div>

<div class="content">

  <div class="rtu-box">
    <strong>RTU:</strong> ${esc(session.rtuCode)} &nbsp;·&nbsp;
    <strong>orderRef:</strong> ${esc(session.orderRef)} &nbsp;·&nbsp;
    <strong>Load:</strong> ${esc(session.loadSite?.name)} (${esc(session.loadSite?.city)}, ${esc(session.loadSite?.country)}) &nbsp;·&nbsp;
    <strong>Delivery:</strong> ${esc(session.delSite?.name)} (${esc(session.delSite?.city)}, ${esc(session.delSite?.country)})
  </div>

  <h2>Events Fired (${session.events.length})</h2>
  <table>
    <thead>
      <tr>
        <th>#</th><th>Event</th><th>Conditions (sit / just / event)</th>
        <th>Logward Field</th><th>Date Sent</th><th>Value Written</th><th>Result</th>
      </tr>
    </thead>
    <tbody>${eventRows}</tbody>
  </table>

  <h2>Final RTU Field State</h2>
  <table>
    <thead><tr><th></th><th>Field</th><th>Value</th></tr></thead>
    <tbody>${fieldStateRows}</tbody>
  </table>

</div>
<div class="footer">Generated by Logward Road Events-Out Session Reporter · ${runDate}</div>
</body>
</html>`;

  const runTs  = new Date().toISOString().slice(0,19).replace(/:/g,'-');
  const outDir = path.join(process.cwd(), 'playwright-report', 'runs', runTs, 'road');
  const outFile = path.join(outDir, 'road-session-report.html');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, html, 'utf8');

  console.log(`\n  ${C.green}📊 Report saved: ${outFile}${C.reset}`);
  spawnSync('open', [outFile], { stdio: 'ignore' });
  console.log(`  ${C.gray}(opened in browser)${C.reset}`);
  return outFile;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main
// ─────────────────────────────────────────────────────────────────────────────

function printMenu() {
  console.log(`\n${C.bold}${C.cyan}  Pick an event to fire:${C.reset}`);
  console.log(`  ${C.gray}${'─'.repeat(68)}${C.reset}`);
  for (const [key, def] of Object.entries(EVENTS)) {
    const pad = key.padEnd(5);
    const lbl = def.label.padEnd(22);
    const cond = `${def.sitCode}/${def.justCode}`;
    const field = def.field;
    console.log(`  ${C.cyan}${pad}${C.reset} ${lbl} ${C.gray}${cond.padEnd(10)}${C.reset} → ${C.magenta}${field}${C.reset}`);
  }
  console.log(`  ${C.gray}${'─'.repeat(68)}${C.reset}`);
  console.log(`  ${C.cyan}all${C.reset}  → fire all 8 standard events (d1–d8) in sequence`);
  console.log(`  ${C.cyan}neg${C.reset}  → run a negative test on a fresh temp RTU`);
  console.log(`  ${C.cyan}stat${C.reset} → show current RTU field state`);
  console.log(`  ${C.cyan}fin${C.reset}  → generate HTML report and exit\n`);
}

async function main() {
  console.log(`\n${C.bold}${C.white}╔══════════════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.bold}${C.white}║  Logward Road Events-Out — Session Runner            ║${C.reset}`);
  console.log(`${C.bold}${C.white}║  1 RTU · fire events interactively · HTML report     ║${C.reset}`);
  console.log(`${C.bold}${C.white}╚══════════════════════════════════════════════════════╝${C.reset}`);

  // ── Create RTU ──────────────────────────────────────────────────────────────
  banner('CREATING RTU', '🏗');

  session.loadSite = pick(LOADING_SITES);
  session.delSite  = pick(DELIVERY_SITES);

  info(`Load site    : ${session.loadSite.name} (${session.loadSite.city}, ${session.loadSite.country})`);
  info(`Delivery site: ${session.delSite.name} (${session.delSite.city}, ${session.delSite.country})`);
  info('Creating RTU with trackingStatus=In Progress and all required fields...');

  const { code, orderRef, status } = await createRTU(session.loadSite, session.delSite);
  if (!code) {
    err(`Failed to create RTU (HTTP ${status})`);
    process.exit(1);
  }

  session.rtuCode  = code;
  session.orderRef = orderRef;

  ok(`RTU created → code=${C.bold}${code}${C.reset}${C.green}  orderRef=${C.bold}${orderRef}${C.reset}`);
  info('Waiting for scheduler active=1 valid=1...');

  // Poll scheduler
  const schedulerDeadline = Date.now() + 45000;
  let schedulerOk = false;
  while (Date.now() < schedulerDeadline) {
    await new Promise(r => setTimeout(r, 4000));
    process.stdout.write(`  ${C.gray}⏳ checking scheduler...${C.reset}\r`);
    try {
      const { getTrackingSchedule } = require('../helpers/shared/trackingSchedulerClient');
      const rec = await getTrackingSchedule(CONFIG.SCHEMA_TYPE, code);
      if (rec && rec.active === 1 && rec.valid === 1) {
        process.stdout.write('\n');
        ok(`Scheduler: active=1 valid=1 ✅`);
        schedulerOk = true;
        break;
      }
    } catch { /* retry */ }
  }
  if (!schedulerOk) {
    process.stdout.write('\n');
    warn('Scheduler did not confirm in time — continuing anyway (RTU is valid)');
  }

  // ── Interactive loop ────────────────────────────────────────────────────────
  banner('SESSION STARTED — type a command below', '🚀');
  info(`RTU: ${C.bold}${code}${C.reset}  orderRef: ${C.bold}${orderRef}${C.reset}`);
  info(`Load: ${session.loadSite.city} (${session.loadSite.country})  |  Delivery: ${session.delSite.city} (${session.delSite.country})`);

  while (true) {
    printMenu();
    const input = (await ask(`${C.cyan}▶ Command: ${C.reset}`)).toLowerCase().trim();

    if (input === 'fin' || input === 'finish') {
      banner('FINISHING SESSION', '🏁');
      await showRTUState(session.rtuCode);
      await generateReport(session.rtuCode);
      rl.close();
      break;
    }

    if (input === 'stat') {
      await showRTUState(session.rtuCode);
      continue;
    }

    if (input === 'all') {
      banner('FIRING ALL 8 STANDARD EVENTS', '🔁');
      for (const key of ['d1','d2','d3','d4','d5','d6','d7','d8']) {
        const def = EVENTS[key];
        info(`\n[${key}] ${def.label} (${def.sitCode}/${def.justCode})`);
        await fireEvent(def, session.rtuCode, session.orderRef, session.loadSite, session.delSite);
        await new Promise(r => setTimeout(r, 1000));
      }
      continue;
    }

    if (input === 'neg') {
      console.log(`\n  ${C.bold}Negative tests:${C.reset}`);
      for (const [k, n] of Object.entries(NEG_TESTS)) {
        console.log(`  ${C.cyan}${k.padEnd(4)}${C.reset} ${n.desc}`);
      }
      const negKey = await ask(`${C.cyan}▶ Which negative test (n1–n6): ${C.reset}`);
      await runNegativeTest(negKey.toLowerCase());
      continue;
    }

    if (EVENTS[input]) {
      await fireEvent(EVENTS[input], session.rtuCode, session.orderRef, session.loadSite, session.delSite);
      continue;
    }

    warn(`Unknown command "${input}". Type a valid key or "fin" to finish.`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
