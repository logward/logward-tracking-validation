#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  scripts/runAirEventsOutSession.js
//
//  Interactive E2E Events-Out test session for Logward ↔ Shippeo air tracking.
//
//  Usage:
//    node scripts/runAirEventsOutSession.js
//
//  Session stays alive until user types "finish" or "end test".
//  Generates a consolidated HTML report at the end.
//
//  Event blocks:
//    D  — goods_delivery_compliant_compliant  (seed event + identifier fields)
//    T2 — Type 2 exact-match events           (8 events)
//    T3 — Type 3 starts-with events           (6 events)
//    T4 — Type 4 hub slot events              (4 hubs × arrived/left + 2 OR aliases)
//    T5 — Type 5 routing events               (manifested/eta_event/received_from_flight × loading/delivery/hubs)
//    N  — Negative / Auth tests
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const readline  = require('readline');
const https     = require('https');
const fs        = require('fs');
const path      = require('path');

const { getAdminToken } = require('../helpers/shared/cognitoAuth');
const { pickHubs }      = require('../helpers/air/airSites');

// ─────────────────────────────────────────────────────────────────────────────
//  Env / Config
// ─────────────────────────────────────────────────────────────────────────────

const WEBHOOK_HOST      = 'qa.logward.engineering';
const WEBHOOK_PATH      = '/api/integration-hub/tracking/shippeo/air_tracking';
const WEBHOOK_CLIENT_ID = 'Vbc1r8621FLbtFFl2E';
const WEBHOOK_TOKEN     = process.env.QA_WEBHOOK_TOKEN;

const ATU_UPSERT_HOST   = 'qa.logward.engineering';
const ATU_UPSERT_PATH   = '/api/tower/data/airTransportUnit/upsert';
const ATU_GET_HOST      = 'qa-admin.logward.engineering';
const ATU_GET_BASE_PATH = '/api/tower/data/airTransportUnit';

// ─────────────────────────────────────────────────────────────────────────────
//  Terminal colours
// ─────────────────────────────────────────────────────────────────────────────

const C = {
  reset:   '\x1b[0m',  bold:    '\x1b[1m',  dim:     '\x1b[2m',
  cyan:    '\x1b[36m', green:   '\x1b[32m', yellow:  '\x1b[33m',
  red:     '\x1b[31m', white:   '\x1b[97m', gray:    '\x1b[90m',
  magenta: '\x1b[35m', blue:    '\x1b[34m',
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
rl.on('close', () => {});
const ask = q => new Promise(res => rl.question(q, a => res(a.trim())));

function banner(text, icon = '✈') {
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
  code:       null,   // ATU Logward object code
  mawb:       null,   // masterAirWaybillNumber
  clientRef:  null,   // routing key for webhook ingestion
  hubs:       null,   // [hub0, hub1, hub2, hub3] — 4 unique airports, fixed per session
  startTime:  Date.now(),
  events:     [],
  logs:       [],
};

function log(msg) {
  session.logs.push({ ts: new Date().toISOString(), msg });
  dim(msg);
}

// ─────────────────────────────────────────────────────────────────────────────
//  HTTPS helpers (no Playwright dependency)
// ─────────────────────────────────────────────────────────────────────────────

async function httpGet(hostname, pathname, token) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path: pathname, method: 'GET',
        headers: { Authorization: `Bearer ${token}`, accept: 'application/json' } },
      res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
          catch { resolve({ status: res.statusCode, body: d }); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function httpPost(hostname, pathname, headers, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path: pathname, method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
          catch { resolve({ status: res.statusCode, body: d }); }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  ATU unique ID generation
// ─────────────────────────────────────────────────────────────────────────────

const _RUN_TS = Date.now();
let _counter  = 0;

function nextATUIds() {
  _counter++;
  const seq = String(_counter).padStart(2, '0');
  const ts  = String(_RUN_TS).slice(-5);
  return {
    mawb:            `E2EAIR${seq}${ts}`,
    clientReference: `E2ECRF${seq}${ts}`,
  };
}

function extractCode(body) {
  if (body?.meta?.params?.code) return String(body.meta.params.code);
  if (body?.data && Array.isArray(body.data) && body.data[0]?.code) return String(body.data[0].code);
  if (Array.isArray(body) && body[0]?.code) return String(body[0].code);
  if (body?.code)       return String(body.code);
  if (body?.data?.code) return String(body.data.code);
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ATU CRUD
// ─────────────────────────────────────────────────────────────────────────────

async function createATU(overrides = {}) {
  const token = await getAdminToken();
  const { mawb, clientReference } = nextATUIds();

  const fields = {
    masterAirWaybillNumber: mawb,
    clientReference,
    mot:                'AIR',
    trackingStatus:     'In Progress',
    loadingSiteIata:    'BLR',
    deliverySiteIata:   'BOM',
    loadingSiteCountry: 'IN',
    deliverySiteCountry:'IN',
    ...overrides,
  };

  Object.keys(fields).forEach(k => { if (fields[k] == null) delete fields[k]; });

  const res = await httpPost(
    ATU_UPSERT_HOST,
    `${ATU_UPSERT_PATH}?createNew=true`,
    { Authorization: `Bearer ${token}`, accept: 'application/json' },
    { data: [fields] }
  );

  if (res.status === 401) throw new Error('ATU create → HTTP 401 (Cognito token expired)');
  if (res.status >= 300)  throw new Error(`ATU create → HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);

  const code = extractCode(res.body);
  if (!code) throw new Error(`ATU create OK (${res.status}) but no code in response: ${JSON.stringify(res.body).slice(0, 300)}`);

  return { code, mawb: fields.masterAirWaybillNumber ?? mawb, clientReference: fields.clientReference ?? clientReference };
}

async function getATU(code) {
  const token = await getAdminToken();
  const res   = await httpGet(ATU_GET_HOST, `${ATU_GET_BASE_PATH}/${code}`, token);
  if (res.status >= 300) return null;
  return res.body?.data ?? res.body;
}

async function pollATUChanged(code, prevChangedAt, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let atu = null;

  while (Date.now() < deadline) {
    atu = await getATU(code).catch(() => null);
    if (atu?.lastChangedAt !== prevChangedAt) {
      // Settle time — hub-slot fields arrive slightly after lastChangedAt
      await new Promise(r => setTimeout(r, 4000));
      atu = await getATU(code).catch(() => atu);
      break;
    }
    process.stdout.write(`\r  ${C.gray}polling… (${Math.ceil((deadline - Date.now()) / 1000)}s left)${C.reset}  `);
    await new Promise(r => setTimeout(r, 3000));
  }
  process.stdout.write('\r' + ' '.repeat(50) + '\r');

  if (atu?.lastChangedAt === prevChangedAt) {
    warn('No ATU update in 45s — retrying after 30s…');
    await new Promise(r => setTimeout(r, 30_000));

    // Retry the webhook
    return null;
  }
  return atu;
}

async function sendWebhook(payload, customHeaders = {}) {
  const headers = {
    Authorization: `Bearer ${WEBHOOK_TOKEN}`,
    ClientId:      WEBHOOK_CLIENT_ID,
    ...customHeaders,
  };
  return httpPost(WEBHOOK_HOST, WEBHOOK_PATH, headers, payload);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Sites
// ─────────────────────────────────────────────────────────────────────────────

const SITES = {
  BLR: { iata_code: 'BLR', country: 'IN', description: 'BLR Airport',                 address_line: 'Whitefield', city: 'Bengaluru', zipcode: '560066' },
  BOM: { iata_code: 'BOM', country: 'IN', description: 'Mumbai International Airport', address_line: 'MG ROAD',   city: 'Mumbai',    zipcode: '35212'  },
};

function toEventSite(site) {
  return {
    iata_code:    site.iata_code,
    country:      site.country,
    description:  site.description,
    address_line: site.address_line,
    city:         site.city,
    zipcode:      site.zipcode,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Payload builder
// ─────────────────────────────────────────────────────────────────────────────

function stageDate(offsetHours = -1) {
  return new Date(Date.now() + offsetHours * 3_600_000).toISOString();
}

function buildPayload(event, date, eventSite, extras = {}) {
  const payload = {
    order: {
      edi_reference:    session.mawb,
      reference:        session.mawb,
      url:              'https://view.shippeo.com/orderPublic/test',
      client_reference: session.clientRef,
    },
    situation: {
      event,
      situation_code:     null,
      justification_code: null,
      date,
    },
    situation_justification: { attributes: { consignmentReference: 'SESSION-001' } },
    loading_site:  { iata_code: 'BLR', country: 'IN' },
    delivery_site: { iata_code: 'BOM', country: 'IN' },
    event_site: eventSite,
  };
  // Allow extras to override any top-level key (e.g. situation with situation_code)
  Object.assign(payload, extras);
  return payload;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Hub slot resolution
// ─────────────────────────────────────────────────────────────────────────────

function resolveHubSlot(atu, iataCode, country) {
  // Check if this airport already occupies a slot
  for (let n = 1; n <= 4; n++) {
    if (atu[`hubSiteIata_stop${n}`] === iataCode && atu[`hubSiteCountry_stop${n}`] === country) return n;
  }
  // Return first empty slot
  for (let n = 1; n <= 4; n++) {
    if (!atu[`hubSiteIata_stop${n}`]) return n;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Date comparison (epoch-based, ±1s tolerance for ISO string variations)
// ─────────────────────────────────────────────────────────────────────────────

function datesMatch(a, b) {
  if (!a || !b) return false;
  try { return Math.abs(new Date(a).getTime() - new Date(b).getTime()) < 1500; }
  catch { return a === b; }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Event definitions
// ─────────────────────────────────────────────────────────────────────────────

const T2_EVENTS = {
  'received_from_shipper':             { field: 'receivedFromShipperDate',    site: 'BLR' },
  'goods_arrived_at_loading_arrived':  { field: 'loadingArrivedDate',         site: 'BLR' },
  'goods_loading_compliant_compliant': { field: 'loadingCompliantDate',       site: 'BLR' },
  'goods_left_loading_left':           { field: 'loadingLeftDate',            site: 'BLR' },
  'goods_arrived_at_delivery_arrived': { field: 'deliveryArrivedDate',        site: 'BOM' },
  'goods_left_delivery_left':          { field: 'deliveryLeftDate',           site: 'BOM' },
  'documentation_delivered':           { field: 'documentationDeliveredDate', site: 'BOM' },
  'consignee_notified':                { field: 'consigneeNotifiedDate',      site: 'BOM' },
};

const T3_EVENTS = {
  'goods_loading_non_compliant_damaged':          { dateField: 'loadingNonCompliantDate',  justField: 'loadingNonCompliantJustification',  suffix: 'damaged',           site: 'BLR' },
  'goods_loading_non_realised_cancelled':         { dateField: 'loadingNonRealisedDate',   justField: 'loadingNonRealisedJustification',   suffix: 'cancelled',         site: 'BLR' },
  'goods_loading_refused_oversize':               { dateField: 'loadingRefusedDate',       justField: 'loadingRefusedJustification',       suffix: 'oversize',          site: 'BLR' },
  'goods_delivery_non_compliant_pilferage':       { dateField: 'deliveryNonCompliantDate', justField: 'deliveryNonCompliantJustification', suffix: 'pilferage',         site: 'BOM' },
  'goods_delivery_non_realised_recipient_closed': { dateField: 'deliveryNonRealisedDate',  justField: 'deliveryNonRealisedJustification',  suffix: 'recipient_closed',  site: 'BOM' },
  'goods_delivery_refused_not_ordered':           { dateField: 'deliveryRefusedDate',      justField: 'deliveryRefusedJustification',      suffix: 'not_ordered',       site: 'BOM' },
};

// T5 routing event → field prefix lookup
const T5_FIELDS = {
  'manifested':           { loading: 'loadingManifestedDate',         delivery: 'deliveryManifestedDate',         hubPrefix: 'hubManifested'          },
  'eta_event':            { loading: 'loadingETADate',                delivery: 'deliveryETADate',                hubPrefix: 'hubETA'                 },
  'received_from_flight': { loading: 'loadingReceivedFromFlightDate', delivery: 'deliveryReceivedFromFlightDate', hubPrefix: 'hubReceivedFromFlight'   },
};

// ─────────────────────────────────────────────────────────────────────────────
//  Core event executor
// ─────────────────────────────────────────────────────────────────────────────

async function fireAndWait(payload, retryPayload = null) {
  const before  = await getATU(session.code).catch(() => null);
  const baseline = before?.lastChangedAt ?? null;

  const wh = await sendWebhook(payload);
  console.log(`  ${C.gray}→ Webhook HTTP ${wh.status} | event="${payload.situation?.event}"${C.reset}`);

  await new Promise(r => setTimeout(r, 1500));

  let after = await pollATUChanged(session.code, baseline);

  if (!after || after?.lastChangedAt === baseline) {
    // Single retry
    warn('No ATU update — retrying webhook…');
    const retry = retryPayload || payload;
    await sendWebhook(retry);
    await new Promise(r => setTimeout(r, 1500));
    after = await pollATUChanged(session.code, baseline);
  }

  return { status: wh.status, before, after };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Assertion helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeAssertion(field, expected, actual, opts = {}) {
  const pass = datesMatch(actual, expected) || actual === expected;
  return { field, expected, actual: actual ?? null, pass, ...opts };
}

function hubSiteAssertions(atu, slot, hub) {
  return [
    makeAssertion(`hubSiteDescription_stop${slot}`, hub.description,  atu?.[`hubSiteDescription_stop${slot}`]),
    makeAssertion(`hubSiteIata_stop${slot}`,        hub.iata_code,    atu?.[`hubSiteIata_stop${slot}`]),
    makeAssertion(`hubSiteAddressLine_stop${slot}`, hub.address_line, atu?.[`hubSiteAddressLine_stop${slot}`]),
    makeAssertion(`hubSiteCity_stop${slot}`,        hub.city,         atu?.[`hubSiteCity_stop${slot}`]),
    makeAssertion(`hubSiteZipcode_stop${slot}`,     hub.zipcode,      atu?.[`hubSiteZipcode_stop${slot}`]),
    makeAssertion(`hubSiteCountry_stop${slot}`,     hub.country,      atu?.[`hubSiteCountry_stop${slot}`]),
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
//  Print event result to terminal
// ─────────────────────────────────────────────────────────────────────────────

function printEventResult(result) {
  const allPass = result.assertions.every(a => a.pass);
  const badge   = allPass ? `${C.green}PASSED${C.reset}` : `${C.red}FAILED${C.reset}`;
  console.log(`\n  ${C.bold}${result.event}${C.reset} [${result.block}] → ${badge}`);

  for (const a of result.assertions) {
    const icon = a.pass ? `${C.green}✅` : `${C.red}❌`;
    console.log(`    ${icon}${C.reset} ${a.field.padEnd(46)} ${a.pass ? C.green + String(a.actual ?? '—').slice(0, 50) : C.red + 'expected: ' + String(a.expected ?? '—').slice(0, 40) + ' | got: ' + String(a.actual ?? '—').slice(0, 40)}${C.reset}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Push to session event log
// ─────────────────────────────────────────────────────────────────────────────

function pushEvent(event, block, webhookStatus, assertions, extra = {}) {
  const pass = assertions.every(a => a.pass);
  session.events.push({
    timestamp: new Date().toISOString(),
    event,
    block,
    webhookStatus,
    pass,
    assertions,
    ...extra,
  });
  const allPass = session.events.filter(e => e.pass).length;
  const total   = session.events.length;
  console.log(`  ${C.gray}Session: ${allPass}/${total} passed${C.reset}`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  D Block — D-01: goods_delivery_compliant_compliant
// ─────────────────────────────────────────────────────────────────────────────

async function runDBlock() {
  banner('D-01 — goods_delivery_compliant_compliant (seed event)', '📦');

  if (!session.code) { err('No ATU — run setup first'); return; }

  const date = stageDate(-0.5);
  const sc   = 'LIV';
  const jc   = 'CFM';

  const payload = buildPayload('goods_delivery_compliant_compliant', date, toEventSite(SITES.BOM), {
    situation: {
      event:              'goods_delivery_compliant_compliant',
      situation_code:     sc,
      justification_code: jc,
      date,
    },
    situation_justification: { attributes: { consignmentReference: 'SESSION-D01' } },
  });

  info('Sending goods_delivery_compliant_compliant…');
  const { status, after } = await fireAndWait(payload);

  const assertions = [
    makeAssertion('deliveryCompliantDate',               date, after?.deliveryCompliantDate),
    makeAssertion('deliveryCompliantSituationCode',      sc,   after?.deliveryCompliantSituationCode),
    makeAssertion('deliveryCompliantJustificationCode',  jc,   after?.deliveryCompliantJustificationCode),
    makeAssertion('orderReference',  session.mawb,             after?.orderReference),
    makeAssertion('orderUrl',        'https://view.shippeo.com/orderPublic/test', after?.orderUrl),
  ];

  printEventResult({ event: 'goods_delivery_compliant_compliant', block: 'D', assertions });
  pushEvent('goods_delivery_compliant_compliant', 'D', status, assertions);
}

// ─────────────────────────────────────────────────────────────────────────────
//  T2 Block — Type 2 exact-match events
// ─────────────────────────────────────────────────────────────────────────────

function listT2() {
  console.log(`\n  ${C.bold}${C.yellow}T2 Events${C.reset}`);
  for (const [event, meta] of Object.entries(T2_EVENTS)) {
    console.log(`    ${C.cyan}${event.padEnd(46)}${C.reset} → ${meta.field}  [${meta.site}]`);
  }
}

async function runT2Event(event, meta) {
  console.log(`\n  ${C.bold}${C.magenta}► T2: ${event}${C.reset}`);
  const date    = stageDate(-1);
  const site    = SITES[meta.site];
  const payload = buildPayload(event, date, toEventSite(site));

  info(`Sending ${event}…`);
  const { status, after } = await fireAndWait(payload);

  const assertions = [ makeAssertion(meta.field, date, after?.[meta.field]) ];
  printEventResult({ event, block: 'T2', assertions });
  pushEvent(event, 'T2', status, assertions);
}

async function runT2Block() {
  banner('T2 — Type 2 Exact-Match Events');
  if (!session.code) { err('No ATU — run setup first'); return; }

  listT2();
  const ans = await ask(`\n${C.bold}  Which event(s)? (all / comma-separated keys): ${C.reset}`);
  const keys = ans === 'all' ? Object.keys(T2_EVENTS) : ans.split(',').map(s => s.trim()).filter(k => T2_EVENTS[k]);

  if (!keys.length) { warn('No valid events selected.'); return; }

  for (const event of keys) {
    await runT2Event(event, T2_EVENTS[event]);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  T3 Block — Type 3 starts-with events (date + justification suffix)
// ─────────────────────────────────────────────────────────────────────────────

function listT3() {
  console.log(`\n  ${C.bold}${C.yellow}T3 Events${C.reset}`);
  for (const [event, meta] of Object.entries(T3_EVENTS)) {
    console.log(`    ${C.cyan}${event.padEnd(52)}${C.reset} → ${meta.dateField}  justification="${meta.suffix}"  [${meta.site}]`);
  }
}

async function runT3Event(event, meta) {
  console.log(`\n  ${C.bold}${C.magenta}► T3: ${event}${C.reset}`);
  const date    = stageDate(-1);
  const site    = SITES[meta.site];
  const payload = buildPayload(event, date, toEventSite(site));

  info(`Sending ${event}…`);
  const { status, after } = await fireAndWait(payload);

  const assertions = [
    makeAssertion(meta.dateField, date,        after?.[meta.dateField]),
    makeAssertion(meta.justField, meta.suffix, after?.[meta.justField]),
  ];
  printEventResult({ event, block: 'T3', assertions });
  pushEvent(event, 'T3', status, assertions);
}

async function runT3Block() {
  banner('T3 — Type 3 Starts-With Events');
  if (!session.code) { err('No ATU — run setup first'); return; }

  listT3();
  const ans = await ask(`\n${C.bold}  Which event(s)? (all / comma-separated keys): ${C.reset}`);
  const keys = ans === 'all' ? Object.keys(T3_EVENTS) : ans.split(',').map(s => s.trim()).filter(k => T3_EVENTS[k]);

  if (!keys.length) { warn('No valid events selected.'); return; }

  for (const event of keys) {
    await runT3Event(event, T3_EVENTS[event]);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  T4 Block — Type 4 hub slot events
// ─────────────────────────────────────────────────────────────────────────────

function listT4() {
  console.log(`\n  ${C.bold}${C.yellow}T4 Hub Slots (this session)${C.reset}`);
  session.hubs.forEach((h, i) => {
    console.log(`    ${C.cyan}stop${i + 1}${C.reset} = ${C.bold}${h.iata_code}${C.reset} (${h.city}, ${h.country})`);
  });
  console.log(`\n  ${C.yellow}Events:${C.reset}`);
  console.log(`    arrived  → goods_arrived_at_hub_arrived    (writes hubArrivedDate_stopN + hub site fields)`);
  console.log(`    left     → goods_left_hub_left             (writes hubLeftDate_stopN)`);
  console.log(`    or-arr   → goods_arrived_at_delivery_hub_arrived  (OR-alias for arrived)`);
  console.log(`    or-left  → goods_left_delivery_hub_left           (OR-alias for left)`);
}

const T4_EVENT_MAP = {
  arrived:  'goods_arrived_at_hub_arrived',
  left:     'goods_left_hub_left',
  'or-arr': 'goods_arrived_at_delivery_hub_arrived',
  'or-left':'goods_left_delivery_hub_left',
};

async function runT4HubEvent(event, hub, isArrived) {
  console.log(`\n  ${C.bold}${C.magenta}► T4: ${event} @ ${hub.iata_code} (${hub.city})${C.reset}`);
  const date    = stageDate(-2);
  const payload = buildPayload(event, date, toEventSite(hub));

  info(`Sending ${event} @ ${hub.iata_code}…`);
  const { status, after } = await fireAndWait(payload);

  const slot = after ? resolveHubSlot(after, hub.iata_code, hub.country) : null;
  if (slot === null) {
    err(`Could not resolve hub slot for ${hub.iata_code}`);
    pushEvent(event, 'T4', status, [{ field: `hub?Date_stop?`, expected: date, actual: null, pass: false }]);
    return;
  }

  console.log(`  ${C.gray}→ Hub ${hub.iata_code} resolved to stop${slot}${C.reset}`);

  const dateField  = isArrived ? `hubArrivedDate_stop${slot}` : `hubLeftDate_stop${slot}`;
  const dateAssert = makeAssertion(dateField, date, after?.[dateField]);

  // Site fields only on arrived (first write creates the slot + populates site fields)
  const siteAsserts = isArrived ? hubSiteAssertions(after, slot, hub) : [];
  const assertions  = [dateAssert, ...siteAsserts];

  printEventResult({ event, block: 'T4', assertions });
  pushEvent(event, 'T4', status, assertions, { hub: hub.iata_code, slot });
}

async function runT4Block() {
  banner('T4 — Type 4 Hub Slot Events');
  if (!session.code) { err('No ATU — run setup first'); return; }
  if (!session.hubs) { err('Hub pool not set — create ATU first'); return; }

  listT4();

  const slotAns = await ask(`\n${C.bold}  Which hub(s)? (stop1 / stop2 / stop3 / stop4 / all): ${C.reset}`);
  const slotIdx = slotAns === 'all'
    ? [0, 1, 2, 3]
    : slotAns.split(',').map(s => {
        const m = s.trim().match(/^stop([1-4])$/i);
        return m ? parseInt(m[1], 10) - 1 : null;
      }).filter(n => n !== null && n >= 0 && n <= 3);

  if (!slotIdx.length) { warn('No valid hub slots selected.'); return; }

  const evAns = await ask(`${C.bold}  Which event(s)? (arrived / left / or-arr / or-left / all): ${C.reset}`);
  const evKeys = evAns === 'all'
    ? ['arrived', 'left', 'or-arr', 'or-left']
    : evAns.split(',').map(s => s.trim()).filter(k => T4_EVENT_MAP[k]);

  if (!evKeys.length) { warn('No valid events selected.'); return; }

  for (const idx of slotIdx) {
    const hub = session.hubs[idx];
    for (const evKey of evKeys) {
      const event     = T4_EVENT_MAP[evKey];
      const isArrived = evKey === 'arrived' || evKey === 'or-arr';
      await runT4HubEvent(event, hub, isArrived);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  T5 Block — Type 5 routing events
// ─────────────────────────────────────────────────────────────────────────────

function listT5() {
  console.log(`\n  ${C.bold}${C.yellow}T5 Events${C.reset}`);
  for (const [event, fields] of Object.entries(T5_FIELDS)) {
    console.log(`    ${C.cyan}${event.padEnd(25)}${C.reset}  loading→${fields.loading.padEnd(35)} delivery→${fields.delivery}`);
    console.log(`    ${' '.repeat(25)}  hub→${fields.hubPrefix}Date_stopN`);
  }
  console.log(`\n  ${C.yellow}Contexts:${C.reset}`);
  console.log(`    loading  → sends event_site = BLR/IN  → prefix "loading"`);
  console.log(`    delivery → sends event_site = BOM/IN  → prefix "delivery"`);
  console.log(`    hubs     → sends event_site = each session hub → prefix "hub" + slot`);
}

async function runT5Simple(event, context, site, expectedField) {
  console.log(`\n  ${C.bold}${C.magenta}► T5: ${event} — ${context} (${site.iata_code}/${site.country})${C.reset}`);
  const date    = stageDate(-1);
  const payload = buildPayload(event, date, toEventSite(site));

  info(`Sending ${event} @ ${site.iata_code}…`);
  const { status, after } = await fireAndWait(payload);

  const assertions = [ makeAssertion(expectedField, date, after?.[expectedField]) ];
  printEventResult({ event, block: 'T5', assertions });
  pushEvent(event, 'T5', status, assertions, { context });
}

async function runT5Hub(event, hub, hubFieldPrefix) {
  console.log(`\n  ${C.bold}${C.magenta}► T5: ${event} — hub @ ${hub.iata_code}${C.reset}`);
  const date    = stageDate(-1);
  const payload = buildPayload(event, date, toEventSite(hub));

  info(`Sending ${event} @ ${hub.iata_code}…`);
  const { status, after } = await fireAndWait(payload);

  const slot = after ? resolveHubSlot(after, hub.iata_code, hub.country) : null;
  if (slot === null) {
    err(`Could not resolve hub slot for ${hub.iata_code}`);
    pushEvent(event, 'T5', status, [{ field: `${hubFieldPrefix}Date_stop?`, expected: date, actual: null, pass: false }], { context: 'hub', hub: hub.iata_code });
    return;
  }

  console.log(`  ${C.gray}→ Hub ${hub.iata_code} resolved to stop${slot}${C.reset}`);

  const dateField  = `${hubFieldPrefix}Date_stop${slot}`;
  const dateAssert = makeAssertion(dateField, date, after?.[dateField]);
  const siteAsserts= hubSiteAssertions(after, slot, hub);
  const assertions = [dateAssert, ...siteAsserts];

  printEventResult({ event, block: 'T5', assertions });
  pushEvent(event, 'T5', status, assertions, { context: 'hub', hub: hub.iata_code, slot });
}

async function runT5Block() {
  banner('T5 — Type 5 Routing Events');
  if (!session.code) { err('No ATU — run setup first'); return; }
  if (!session.hubs) { err('Hub pool not set — create ATU first'); return; }

  listT5();

  const evAns = await ask(`\n${C.bold}  Which event(s)? (manifested / eta_event / received_from_flight / all): ${C.reset}`);
  const evKeys = evAns === 'all'
    ? Object.keys(T5_FIELDS)
    : evAns.split(',').map(s => s.trim()).filter(k => T5_FIELDS[k]);

  if (!evKeys.length) { warn('No valid T5 events selected.'); return; }

  const ctxAns = await ask(`${C.bold}  Context(s)? (loading / delivery / hubs / all): ${C.reset}`);
  const ctxKeys = ctxAns === 'all'
    ? ['loading', 'delivery', 'hubs']
    : ctxAns.split(',').map(s => s.trim()).filter(c => ['loading', 'delivery', 'hubs'].includes(c));

  if (!ctxKeys.length) { warn('No valid contexts selected.'); return; }

  for (const event of evKeys) {
    const fields = T5_FIELDS[event];

    for (const ctx of ctxKeys) {
      if (ctx === 'loading') {
        await runT5Simple(event, 'loading', SITES.BLR, fields.loading);
      } else if (ctx === 'delivery') {
        await runT5Simple(event, 'delivery', SITES.BOM, fields.delivery);
      } else if (ctx === 'hubs') {
        for (const hub of session.hubs) {
          await runT5Hub(event, hub, fields.hubPrefix);
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  N Block — Negative / Auth tests
// ─────────────────────────────────────────────────────────────────────────────

async function runNegativeBlock() {
  banner('N — Negative & Auth Tests', '🚫');
  if (!session.code) { err('No ATU — run setup first'); return; }

  console.log(`\n  ${C.bold}${C.yellow}Negative tests:${C.reset}`);
  console.log(`    1  N-01 — Wrong clientReference → ATU unchanged`);
  console.log(`    2  N-02 — Unknown event name → ATU unchanged`);
  console.log(`    3  N-03 — Missing Authorization header → HTTP 401`);
  console.log(`    4  N-04 — Invalid Bearer token → HTTP 401`);
  console.log(`    all    — Run all 4`);

  const ans = await ask(`\n${C.bold}  Which test(s)? (1 / 2 / 3 / 4 / all): ${C.reset}`);
  const selected = ans === 'all' ? [1, 2, 3, 4] : ans.split(',').map(s => parseInt(s.trim(), 10)).filter(n => n >= 1 && n <= 4);

  if (!selected.length) { warn('No valid tests selected.'); return; }

  // ── N-01 — Wrong clientReference ─────────────────────────────────────────
  if (selected.includes(1)) {
    console.log(`\n  ${C.bold}${C.magenta}► N-01: Wrong clientReference${C.reset}`);
    const before = await getATU(session.code);
    const date   = stageDate(-1);
    const payload = buildPayload('received_from_shipper', date, toEventSite(SITES.BLR));
    payload.order.client_reference = 'WRONG_REF_DOES_NOT_EXIST_SESSION';

    const wh = await sendWebhook(payload);
    await new Promise(r => setTimeout(r, 5000));
    const after = await getATU(session.code);

    const unchanged = after?.receivedFromShipperDate === before?.receivedFromShipperDate;
    const pass = unchanged;
    const icon = pass ? `${C.green}✅` : `${C.red}❌`;
    console.log(`  ${icon}${C.reset} HTTP ${wh.status} | receivedFromShipperDate unchanged: ${pass ? 'yes ✅' : 'CHANGED ❌'}`);

    pushEvent('received_from_shipper [WRONG clientRef]', 'N', wh.status, [{
      field: 'receivedFromShipperDate', expected: `unchanged (was: ${before?.receivedFromShipperDate ?? 'null'})`,
      actual: after?.receivedFromShipperDate ?? null, pass,
      negativeCheck: true,
    }], { negativeStrategy: 'wrong client_reference → event not routed → ATU unchanged' });
  }

  // ── N-02 — Unknown event name ─────────────────────────────────────────────
  if (selected.includes(2)) {
    console.log(`\n  ${C.bold}${C.magenta}► N-02: Unknown event name${C.reset}`);
    const before = await getATU(session.code);
    const date   = stageDate(-1);
    const payload = buildPayload('unknown_event_xyz_session', date, toEventSite(SITES.BLR));

    const wh = await sendWebhook(payload);
    await new Promise(r => setTimeout(r, 5000));
    const after = await getATU(session.code);

    const unchanged = after?.lastChangedAt === before?.lastChangedAt;
    const icon = unchanged ? `${C.green}✅` : `${C.red}❌`;
    console.log(`  ${icon}${C.reset} HTTP ${wh.status} | ATU lastChangedAt unchanged: ${unchanged ? 'yes ✅' : 'CHANGED ❌'}`);

    pushEvent('unknown_event_xyz_session', 'N', wh.status, [{
      field: 'lastChangedAt', expected: `unchanged (was: ${before?.lastChangedAt ?? 'null'})`,
      actual: after?.lastChangedAt ?? null, pass: unchanged,
      negativeCheck: true,
    }], { negativeStrategy: 'unknown event name → backend ignores event → ATU unchanged' });
  }

  // ── N-03 — Missing Authorization header ──────────────────────────────────
  if (selected.includes(3)) {
    console.log(`\n  ${C.bold}${C.magenta}► N-03: Missing Authorization header${C.reset}`);
    const payload = buildPayload('received_from_shipper', stageDate(-1), toEventSite(SITES.BLR));
    const wh = await sendWebhook(payload, { Authorization: '' });  // empty bearer

    const pass = wh.status === 401;
    const icon = pass ? `${C.green}✅` : `${C.red}❌`;
    console.log(`  ${icon}${C.reset} HTTP ${wh.status} ${pass ? '(401 expected ✅)' : `(expected 401 ❌)`}`);

    pushEvent('received_from_shipper [no auth]', 'N', wh.status, [{
      field: 'HTTP status', expected: '401', actual: String(wh.status), pass,
      negativeCheck: true,
    }], { negativeStrategy: 'missing/empty Authorization → HTTP 401' });
  }

  // ── N-04 — Invalid Bearer token ───────────────────────────────────────────
  if (selected.includes(4)) {
    console.log(`\n  ${C.bold}${C.magenta}► N-04: Invalid Bearer token${C.reset}`);
    const payload = buildPayload('received_from_shipper', stageDate(-1), toEventSite(SITES.BLR));
    const wh = await sendWebhook(payload, { Authorization: 'Bearer invalid_token_abc123' });

    const pass = wh.status === 401 || wh.status === 403;
    const icon = pass ? `${C.green}✅` : `${C.red}❌`;
    console.log(`  ${icon}${C.reset} HTTP ${wh.status} ${pass ? '(4xx expected ✅)' : `(expected 401/403 ❌)`}`);

    pushEvent('received_from_shipper [bad token]', 'N', wh.status, [{
      field: 'HTTP status', expected: '401 or 403', actual: String(wh.status), pass,
      negativeCheck: true,
    }], { negativeStrategy: 'invalid bearer token → HTTP 401/403' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  ATU setup
// ─────────────────────────────────────────────────────────────────────────────

async function setupATUAuto() {
  banner('ATU SETUP — Auto Create');
  info('Creating airTransportUnit with MAWB + clientRef + BLR/BOM + In Progress…');

  const r = await createATU();
  session.code      = r.code;
  session.mawb      = r.mawb;
  session.clientRef = r.clientReference;
  session.hubs      = pickHubs(4);

  ok(`ATU created → code=${r.code}`);
  info(`MAWB       : ${r.mawb}`);
  info(`clientRef  : ${r.clientReference}`);
  info(`Loading    : BLR/IN  |  Delivery: BOM/IN`);
  info(`Hub pool   : ${session.hubs.map((h, i) => `stop${i+1}=${h.iata_code}(${h.city})`).join('  ')}`);
  return true;
}

async function setupATUManual() {
  banner('ATU SETUP — Manual Entry');
  const code      = await ask(`${C.cyan}  ATU Object Code (from Logward): ${C.reset}`);
  const mawb      = await ask(`${C.cyan}  MAWB (masterAirWaybillNumber): ${C.reset}`);
  const clientRef = await ask(`${C.cyan}  clientReference (routing key): ${C.reset}`);

  if (!code || !mawb || !clientRef) { err('All fields required for manual entry.'); return false; }

  session.code      = code;
  session.mawb      = mawb;
  session.clientRef = clientRef;
  session.hubs      = pickHubs(4);

  ok(`Using ATU → code=${code}`);
  info(`MAWB: ${mawb}  |  clientRef: ${clientRef}`);
  info(`Hub pool: ${session.hubs.map((h, i) => `stop${i+1}=${h.iata_code}(${h.city})`).join('  ')}`);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
//  HTML Report
// ─────────────────────────────────────────────────────────────────────────────

function generateReport() {
  const now      = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const duration = ((Date.now() - session.startTime) / 1000).toFixed(1);
  const passed   = session.events.filter(e => e.pass).length;
  const failed   = session.events.filter(e => !e.pass).length;
  const total    = session.events.length;

  const blockColors = { D: '#e9d8fd', T2: '#bee3f8', T3: '#b2f5ea', T4: '#feebc8', T5: '#c6f6d5', N: '#fed7d7' };
  const blockText   = { D: '#553c9a', T2: '#2b6cb0', T3: '#234e52', T4: '#7b341e', T5: '#22543d', N: '#9b2335' };

  const eventRows = session.events.map((e, i) => {
    const bc = blockColors[e.block] || '#edf2f7';
    const bt = blockText[e.block]   || '#2d3748';
    const isNeg = e.negativeStrategy || e.block === 'N';

    const assertRows = e.assertions.map(a => {
      const negCheck = a.negativeCheck;
      if (negCheck && a.pass) {
        return `<tr class="blocked">
          <td>🚫</td>
          <td><span class="blocked-label">BLOCKED</span><br><code class="field-name">${a.field}</code></td>
          <td><div class="cond-summary blocked">Correctly rejected — no ATU change as expected</div></td>
          <td><code>${String(a.actual ?? '—').slice(0, 60)}</code></td>
          <td></td>
        </tr>`;
      }
      const label    = negCheck ? '❗ UNEXPECTEDLY MAPPED' : '✔ SHOULD MAP';
      const labelCls = negCheck ? 'unexpected-label' : 'pos-label';
      return `<tr class="${a.pass ? 'pass' : 'fail'}">
        <td>${a.pass ? '✅' : '❌'}</td>
        <td><span class="${labelCls}">${label}</span><br><code class="field-name">${a.field}</code></td>
        <td><div class="cond-summary ${a.pass ? 'pos' : 'neg'}">${a.pass ? 'Field mapped correctly' : 'Field did not map as expected'}</div></td>
        <td><code>${String(a.actual ?? '—').slice(0, 60)}</code></td>
        <td>${a.pass ? '' : `<code class="exp">${String(a.expected ?? '—').slice(0, 60)}</code>`}</td>
      </tr>`;
    }).join('');

    const strategyBadge = e.negativeStrategy
      ? `<div class="neg-strategy">🔀 <b>Strategy:</b> ${e.negativeStrategy}</div>` : '';
    const hubBadge = e.hub
      ? `<span class="hub-badge">${e.hub}${e.slot ? ` → stop${e.slot}` : ''}</span>` : '';

    return `
    <div class="event-card ${e.pass ? 'pass' : 'fail'}">
      <div class="event-header">
        <span class="seq">#${i+1}</span>
        <span class="block-badge" style="background:${bc};color:${bt}">${e.block}</span>
        ${isNeg ? `<span class="flow-neg">NEGATIVE</span>` : `<span class="flow-pos">POSITIVE</span>`}
        <span class="event-name">${e.event}</span>
        ${hubBadge}
        <span class="http">HTTP ${e.webhookStatus}</span>
        <span class="ts">${e.timestamp.slice(11, 19)} UTC</span>
        <span class="badge ${e.pass ? 'pass' : 'fail'}">${e.pass ? 'PASSED' : 'FAILED'}</span>
      </div>
      ${strategyBadge}
      <table class="assertions">
        <thead><tr><th></th><th>Assertion · Field</th><th>Result</th><th>Actual value</th><th>Expected (on fail)</th></tr></thead>
        <tbody>${assertRows}</tbody>
      </table>
    </div>`;
  }).join('');

  const hubPoolHtml = session.hubs
    ? session.hubs.map((h, i) => `<div class="field-item">stop${i+1} <span>${h.iata_code} (${h.city})</span></div>`).join('')
    : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>Air E2E Session Report — ${now}</title>
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
    .banner-bar{margin:16px 40px;padding:12px 20px;border-radius:8px;font-weight:600;font-size:.9rem;}
    .banner-bar.ok{background:#f0fff4;border:1.5px solid #68d391;color:#276749;}
    .banner-bar.fail{background:#fff5f5;border:1.5px solid #fc8181;color:#9b2335;}
    .atu-box{margin:0 40px 16px;background:#fff;border-radius:8px;border:1px solid #e2e8f0;padding:14px 20px;font-size:.82rem;}
    .atu-box h3{font-weight:700;margin-bottom:8px;color:#4a5568;}
    .atu-box .fields{display:flex;flex-wrap:wrap;gap:12px;}
    .atu-box .field-item{background:#edf2f7;padding:4px 10px;border-radius:4px;}
    .atu-box .field-item span{font-weight:700;color:#2d3748;}
    .events{margin:0 40px 32px;display:flex;flex-direction:column;gap:12px;}
    .event-card{background:#fff;border-radius:8px;border:1px solid #e2e8f0;overflow:hidden;}
    .event-card.pass{border-left:4px solid #68d391;} .event-card.fail{border-left:4px solid #fc8181;}
    .event-header{display:flex;align-items:center;gap:8px;padding:10px 16px;background:#fafafa;flex-wrap:wrap;}
    .seq{background:#edf2f7;padding:2px 8px;border-radius:4px;font-weight:700;font-size:.75rem;}
    .block-badge{padding:2px 8px;border-radius:10px;font-size:.72rem;font-weight:700;}
    .event-name{font-weight:700;font-size:.85rem;color:#2d3748;}
    .hub-badge{font-size:.75rem;background:#ebf4ff;color:#2b6cb0;padding:2px 8px;border-radius:10px;}
    .http{font-size:.75rem;color:#718096;}
    .ts{font-size:.72rem;color:#a0aec0;margin-left:auto;}
    .badge{padding:2px 10px;border-radius:10px;font-size:.72rem;font-weight:700;}
    .badge.pass{background:#c6f6d5;color:#22543d;} .badge.fail{background:#fed7d7;color:#9b2335;}
    .flow-pos{background:#c6f6d5;color:#22543d;padding:2px 8px;border-radius:10px;font-size:.72rem;font-weight:700;}
    .flow-neg{background:#fed7d7;color:#9b2335;padding:2px 8px;border-radius:10px;font-size:.72rem;font-weight:700;}
    .neg-strategy{background:#fffbeb;border:1px solid #f6e05e;border-radius:6px;padding:8px 14px;margin:8px 0 4px;font-size:.8rem;color:#744210;}
    .assertions{width:100%;border-collapse:collapse;table-layout:fixed;}
    .assertions thead tr{background:#f7fafc;}
    .assertions th{padding:6px 14px;text-align:left;font-size:.7rem;text-transform:uppercase;color:#a0aec0;border-bottom:1px solid #e2e8f0;}
    .assertions th:nth-child(1){width:36px;} .assertions th:nth-child(2){width:24%;} .assertions th:nth-child(3){width:28%;} .assertions th:nth-child(4){width:26%;} .assertions th:nth-child(5){width:20%;}
    .assertions td{padding:7px 14px;border-bottom:1px solid #f7fafc;font-size:.78rem;word-break:break-word;vertical-align:top;}
    .assertions td:first-child{text-align:center;padding:7px 4px;width:36px;}
    .assertions tr.fail td{background:#fff5f5;} tr.blocked td{background:#fffbeb;}
    .field-name{font-family:monospace;font-weight:700;color:#2b6cb0;font-size:.82rem;}
    .pos-label{display:inline-block;background:#c6f6d5;color:#22543d;padding:1px 6px;border-radius:3px;font-size:.7rem;font-weight:700;}
    .unexpected-label{display:inline-block;background:#fed7d7;color:#9b2335;padding:1px 6px;border-radius:3px;font-size:.7rem;font-weight:700;}
    .blocked-label{display:inline-block;background:#fef3c7;color:#92400e;padding:1px 6px;border-radius:3px;font-size:.7rem;font-weight:700;}
    .cond-summary{font-size:.72rem;padding:3px 6px;border-radius:3px;font-weight:600;}
    .cond-summary.pos{background:#c6f6d5;color:#22543d;} .cond-summary.neg{background:#fed7d7;color:#9b2335;}
    .cond-summary.blocked{background:#fef3c7;color:#92400e;}
    code{font-family:monospace;background:#f7fafc;padding:1px 5px;border-radius:3px;font-size:.77rem;}
    .exp{background:#fff5f5;color:#e53e3e;}
    .footer{text-align:center;padding:16px;font-size:.75rem;color:#a0aec0;}
  </style>
</head>
<body>
<script id="qa-summary" type="application/json">${JSON.stringify({ type: 'Air-Events-Out', passed, failed, total, duration: duration + 's', date: now })}</script>
<div class="hdr">
  <h1>✈ Air E2E Session Report — Events-Out</h1>
  <p class="sub">Interactive session: ${now}</p>
  <div class="stats">
    <div class="stat"><strong>${total}</strong>Events Run</div>
    <div class="stat pass"><strong>${passed}</strong>Passed</div>
    <div class="stat fail"><strong>${failed}</strong>Failed</div>
    <div class="stat"><strong>${duration}s</strong>Duration</div>
  </div>
</div>
<div class="banner-bar ${failed === 0 ? 'ok' : 'fail'}">
  ${failed === 0 ? '✅ All events passed' : `❌ ${failed} event(s) failed`}
</div>
<div class="atu-box">
  <h3>ATU Details</h3>
  <div class="fields">
    <div class="field-item">Object Code <span>${session.code || '—'}</span></div>
    <div class="field-item">MAWB <span>${session.mawb || '—'}</span></div>
    <div class="field-item">clientReference <span>${session.clientRef || '—'}</span></div>
    <div class="field-item">Loading <span>BLR / IN</span></div>
    <div class="field-item">Delivery <span>BOM / IN</span></div>
    ${hubPoolHtml}
  </div>
</div>
<div class="events">${eventRows || '<p style="padding:20px 40px;color:#a0aec0">No events executed.</p>'}</div>
<div class="footer">Logward QA Automation — Air E2E Session Report · ${now}</div>
</body>
</html>`;

  const dir  = path.resolve('playwright-report', 'sessions');
  const file = path.join(dir, `air-session-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.html`);
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
  console.log(`${C.bold}${C.white}║  Logward Air — Interactive E2E Events-Out Test Session     ║${C.reset}`);
  console.log(`${C.bold}${C.white}║  Type "finish" or "end test" at any time to close          ║${C.reset}`);
  console.log(`${C.bold}${C.white}╚════════════════════════════════════════════════════════════╝${C.reset}\n`);

  if (!WEBHOOK_TOKEN) {
    warn('QA_WEBHOOK_TOKEN is not set in .env — webhook calls will fail (HTTP 401).');
  }

  // ── ATU Setup ─────────────────────────────────────────────────────────────
  banner('ATU SETUP');
  const setupAns = await ask(`${C.bold}Create new ATU or use existing? (create / manual): ${C.reset}`);
  let setupOk;
  if (setupAns.toLowerCase() === 'manual') {
    setupOk = await setupATUManual();
  } else {
    setupOk = await setupATUAuto();
  }
  if (!setupOk) { err('ATU setup failed. Exiting.'); rl.close(); return; }

  // ── Main event loop ───────────────────────────────────────────────────────
  info(`\nSession active. ATU: ${session.code} | MAWB: ${session.mawb}`);
  info(`Hub pool: ${session.hubs.map((h, i) => `stop${i+1}=${h.iata_code}`).join('  ')}`);
  console.log(`${C.gray}Type "finish" or "end test" at any prompt to close and generate report.${C.reset}`);

  while (true) {
    console.log(`\n${'─'.repeat(62)}`);
    const blockAns = await ask(`\n${C.bold}Block? (d / t2 / t3 / t4 / t5 / negative / finish): ${C.reset}`);

    const cmd = blockAns.toLowerCase().trim();
    if (cmd === 'finish' || cmd === 'end test') break;

    switch (cmd) {
      case 'd':        await runDBlock();        break;
      case 't2':       await runT2Block();       break;
      case 't3':       await runT3Block();       break;
      case 't4':       await runT4Block();       break;
      case 't5':       await runT5Block();       break;
      case 'negative': await runNegativeBlock(); break;
      default:
        warn(`Unknown block "${cmd}". Use: d / t2 / t3 / t4 / t5 / negative / finish`);
    }

    // Running tally
    const passed = session.events.filter(e => e.pass).length;
    const total  = session.events.length;
    console.log(`\n  ${C.bold}Session so far: ${passed}/${total} passed${C.reset}`);
  }

  // ── Generate report ───────────────────────────────────────────────────────
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
