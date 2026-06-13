#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  scripts/runEventTests.js
//
//  Interactive CLI to run Direct Shipment and/or TSP event mapping tests.
//
//  Usage:
//    node scripts/runEventTests.js
//
//  It will ask:
//    1. Run Direct Shipment tests? → all OR a specific Logward key
//    2. Run TSP tests? → all OR a specific Logward key
//  Then builds and runs the Playwright command automatically.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const readline = require('readline');
const { execSync } = require('child_process');

// ─────────────────────────────────────────────────────────────────────────────
//  ALL Logward field keys mapped to their test groups
// ─────────────────────────────────────────────────────────────────────────────

const DIRECT_FIELDS = {
  // ── Pre-Carriage ────────────────────────────────────────────────────────────
  'actualGateOutEmptyDepot':       { stage: 'Pre-Carriage', desc: 'Actual date container left the depot (empty)',            groups: ['PC'] },
  'estimatedGateOutEmptyDepot':    { stage: 'Pre-Carriage', desc: 'Estimated date container leaves depot (empty)',           groups: ['PC'] },
  'depotPreLocation':              { stage: 'Pre-Carriage', desc: 'City where container was picked up',                      groups: ['PC'] },
  'depotPreCountry':               { stage: 'Pre-Carriage', desc: 'Country where container was picked up (ISO code)',        groups: ['PC'] },
  'motGateOutEmpty':               { stage: 'Pre-Carriage', desc: 'Transport mode at depot gate-out (ocean/road/rail)',      groups: ['PC'] },
  'actualDepartureFromOrigin':     { stage: 'Pre-Carriage', desc: 'Actual departure date from inland origin',                groups: ['PC'] },
  'estimatedDepartureFromOrigin':  { stage: 'Pre-Carriage', desc: 'Estimated departure date from inland origin',            groups: ['PC'] },
  'pickUpOriginLocation':          { stage: 'Pre-Carriage', desc: 'City of pickup from origin',                             groups: ['PC'] },
  'pickUpOriginCountry':           { stage: 'Pre-Carriage', desc: 'Country of pickup from origin (ISO code)',               groups: ['PC'] },
  'motPickUpOrigin':               { stage: 'Pre-Carriage', desc: 'Transport mode at origin pickup',                        groups: ['PC'] },
  'actualLoadedAtOrigin':          { stage: 'Pre-Carriage', desc: 'Actual date container was loaded at origin',             groups: ['PC'] },
  'estimatedLoadedAtOrigin':       { stage: 'Pre-Carriage', desc: 'Estimated date container loaded at origin',              groups: ['PC'] },

  // ── Port of Loading (POL) ───────────────────────────────────────────────────
  'actualGateInPol':               { stage: 'POL', desc: 'Actual date container arrived at loading port',                   groups: ['POL'] },
  'estimatedGateInPol':            { stage: 'POL', desc: 'Estimated date container arrives at loading port',               groups: ['POL'] },
  'actualLoadPol':                 { stage: 'POL', desc: 'Actual date container was loaded onto vessel at POL',            groups: ['POL'] },
  'estimatedLoadPol':              { stage: 'POL', desc: 'Estimated date container loaded onto vessel',                    groups: ['POL'] },
  'actualDeparturePol':            { stage: 'POL', desc: 'Actual vessel departure from loading port',                      groups: ['POL'] },
  'estimatedDeparturePol':         { stage: 'POL', desc: 'Estimated vessel departure from loading port',                   groups: ['POL'] },
  'predictedDeparturePol':         { stage: 'POL', desc: 'Shippeo-predicted vessel departure',                             groups: ['POL'] },
  'leg1Mot':                       { stage: 'POL', desc: 'Transport mode for the first ocean leg',                         groups: ['POL'] },
  'leg1VesselImoNumber':           { stage: 'POL', desc: 'IMO number of the vessel on leg 1 (from container_loaded)',      groups: ['POL', 'DS'] },
  'leg1VesselName':                { stage: 'POL', desc: 'Name of the vessel on leg 1',                                    groups: ['POL', 'DS'] },
  'carrierUpdatedLocodePol':       { stage: 'POL', desc: 'Loading port UN/LOCODE (updated with every event)',              groups: ['D', 'DS'] },

  // ── Port of Discharge (POD) ─────────────────────────────────────────────────
  'actualArrivalPod':              { stage: 'POD', desc: 'Actual arrival at port of discharge',                            groups: ['POD'] },
  'estimatedArrivalPod':           { stage: 'POD', desc: 'Estimated arrival at POD (from eta_event, external)',            groups: ['POD'] },
  'predictedArrivalPod':           { stage: 'POD', desc: 'Shippeo-predicted arrival at POD (from eta_event, shippeo)',     groups: ['POD'] },
  'actualDischargePod':            { stage: 'POD', desc: 'Actual date container was discharged from vessel',               groups: ['POD'] },
  'estimatedDischargePod':         { stage: 'POD', desc: 'Estimated discharge date',                                       groups: ['POD'] },
  'predictedDischargePod':         { stage: 'POD', desc: 'Shippeo-predicted discharge date',                               groups: ['POD'] },
  'actualGateOutPod':              { stage: 'POD', desc: 'Actual date container left the discharge port',                  groups: ['POD'] },
  'estimatedGateOutPod':           { stage: 'POD', desc: 'Estimated date container leaves discharge port',                 groups: ['POD'] },
  'predictedGateOutPod':           { stage: 'POD', desc: 'Shippeo-predicted gate-out at discharge',                        groups: ['POD'] },
  'actualEmptyReturn':             { stage: 'POD', desc: 'Actual date empty container was returned',                       groups: ['POD'] },
  'estimatedEmptyReturn':          { stage: 'POD', desc: 'Estimated empty container return date',                          groups: ['POD'] },
  'motEmptyReturn':                { stage: 'POD', desc: 'Transport mode for empty container return',                      groups: ['POD'] },
  'motGateOutPod':                 { stage: 'POD', desc: 'Transport mode at discharge port gate-out',                      groups: ['POD'] },
  'carrierUpdatedLocodePod':       { stage: 'POD', desc: 'Discharge port UN/LOCODE (updated with every event)',            groups: ['D', 'DS'] },
  'trackingArrivingVesselImo':     { stage: 'POD', desc: 'IMO number of vessel arriving at discharge (eta/arrived/unloaded)', groups: ['DS'] },
  'trackingArrivingVesselVesselName': { stage: 'POD', desc: 'Name of vessel arriving at discharge',                        groups: ['DS'] },

  // ── Delivery ────────────────────────────────────────────────────────────────
  'actualArrivalDestination':      { stage: 'Delivery', desc: 'Actual arrival at final delivery destination',              groups: ['DEL'] },
  'estimatedArrivalDestination':   { stage: 'Delivery', desc: 'Estimated arrival at final destination',                    groups: ['DEL'] },
  'destinationCity':               { stage: 'Delivery', desc: 'City of final delivery destination',                        groups: ['DEL'] },
  'destinationCountry':            { stage: 'Delivery', desc: 'Country of final delivery destination (ISO code)',          groups: ['DEL'] },

  // ── Always-on / Other ───────────────────────────────────────────────────────
  'datetime_timezone':             { stage: 'Other', desc: 'Timezone of the event site (written with every event)',        groups: ['D'] },
};

// TSP fields — New Flow (branch DP-449, locode-based slots, INCREMENT vessel logic)
const TSP_FIELDS = {
  // ── Actual dates ─────────────────────────────────────────────────────────────
  'actualArrivalTsp1':    { stage: 'Actual Dates',  desc: 'Actual arrival at TSP port 1 (stored as local time)' },
  'actualArrivalTsp2':    { stage: 'Actual Dates',  desc: 'Actual arrival at TSP port 2' },
  'actualArrivalTsp3':    { stage: 'Actual Dates',  desc: 'Actual arrival at TSP port 3' },
  'actualArrivalTsp4':    { stage: 'Actual Dates',  desc: 'Actual arrival at TSP port 4' },
  'actualDepartureTsp1':  { stage: 'Actual Dates',  desc: 'Actual departure from TSP port 1' },
  'actualDepartureTsp2':  { stage: 'Actual Dates',  desc: 'Actual departure from TSP port 2' },
  'actualDepartureTsp3':  { stage: 'Actual Dates',  desc: 'Actual departure from TSP port 3' },
  'actualDischargeTsp1':  { stage: 'Actual Dates',  desc: 'Actual discharge at TSP port 1' },
  'actualDischargeTsp2':  { stage: 'Actual Dates',  desc: 'Actual discharge at TSP port 2' },
  'actualDischargeTsp3':  { stage: 'Actual Dates',  desc: 'Actual discharge at TSP port 3' },
  'actualLoadTsp1':       { stage: 'Actual Dates',  desc: 'Actual load at TSP port 1' },
  'actualLoadTsp2':       { stage: 'Actual Dates',  desc: 'Actual load at TSP port 2' },
  'actualLoadTsp3':       { stage: 'Actual Dates',  desc: 'Actual load at TSP port 3' },
  // ── Estimated & Predicted dates ──────────────────────────────────────────────
  'estimatedArrivalTsp1': { stage: 'Estimated/Predicted', desc: 'Estimated arrival at TSP port 1 (external data source)' },
  'estimatedDischargeTsp1':{ stage: 'Estimated/Predicted',desc: 'Estimated discharge at TSP port 1' },
  'estimatedLoadTsp1':    { stage: 'Estimated/Predicted', desc: 'Estimated load at TSP port 1' },
  'estimatedDepartureTsp1':{ stage: 'Estimated/Predicted',desc: 'Estimated departure at TSP port 1' },
  'predictedArrivalTsp1': { stage: 'Estimated/Predicted', desc: 'Shippeo-predicted arrival at TSP port 1' },
  'predictedDischargeTsp1':{ stage: 'Estimated/Predicted',desc: 'Shippeo-predicted discharge at TSP port 1' },
  'predictedLoadTsp1':    { stage: 'Estimated/Predicted', desc: 'Shippeo-predicted load at TSP port 1' },
  'predictedDepartureTsp1':{ stage: 'Estimated/Predicted',desc: 'Shippeo-predicted departure at TSP port 1' },
  // ── Locode ───────────────────────────────────────────────────────────────────
  'tsp1Locode':   { stage: 'Locode (slot key)', desc: 'UN/LOCODE of TSP port 1 — also the slot key in new flow' },
  'tsp2Locode':   { stage: 'Locode (slot key)', desc: 'UN/LOCODE of TSP port 2' },
  'tsp3Locode':   { stage: 'Locode (slot key)', desc: 'UN/LOCODE of TSP port 3' },
  'tsp4Locode':   { stage: 'Locode (slot key)', desc: 'UN/LOCODE of TSP port 4' },
  // ── Vessel (INCREMENT logic: loaded/departed → N+1) ──────────────────────────
  'leg1VesselImoNumber': { stage: 'Vessel (N / N+1)', desc: 'IMO at slot 1 — arrived/unloaded write at N=1, loaded/departed write at N+1=2' },
  'leg2VesselImoNumber': { stage: 'Vessel (N / N+1)', desc: 'IMO at slot 2' },
  'leg3VesselImoNumber': { stage: 'Vessel (N / N+1)', desc: 'IMO at slot 3' },
  'leg4VesselImoNumber': { stage: 'Vessel (N / N+1)', desc: 'IMO at slot 4' },
  'leg1VesselName':      { stage: 'Vessel (N / N+1)', desc: 'Vessel name at slot 1' },
  'leg2VesselName':      { stage: 'Vessel (N / N+1)', desc: 'Vessel name at slot 2' },
};

// ─────────────────────────────────────────────────────────────────────────────
//  Display helpers
// ─────────────────────────────────────────────────────────────────────────────

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  magenta:'\x1b[35m',
  white:  '\x1b[97m',
  gray:   '\x1b[90m',
};

function hdr(text) {
  console.log(`\n${C.bold}${C.cyan}${text}${C.reset}`);
  console.log(C.gray + '─'.repeat(text.length) + C.reset);
}

function printFieldList(fields) {
  // Group by stage
  const byStage = {};
  for (const [key, meta] of Object.entries(fields)) {
    const stage = meta.stage || 'Other';
    if (!byStage[stage]) byStage[stage] = [];
    byStage[stage].push({ key, ...meta });
  }

  for (const [stage, items] of Object.entries(byStage)) {
    console.log(`\n  ${C.bold}${C.yellow}${stage}${C.reset}`);
    for (const item of items) {
      console.log(`    ${C.cyan}${item.key.padEnd(38)}${C.reset}${C.gray}${item.desc}${C.reset}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Prompt helpers
// ─────────────────────────────────────────────────────────────────────────────

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, ans => resolve(ans.trim())));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Grep pattern builders
// ─────────────────────────────────────────────────────────────────────────────

function buildDirectGrep(choice) {
  if (choice === 'all') {
    // All direct shipment test groups
    return 'PC-|POL-|POD-|DEL-|DS-PC|DS-POL|DS-POD|DS-DEL|DS-N|DS-E|GROUP DS';
  }
  // Specific field — match tests containing that field name
  return choice;
}

function buildTspGrep(choice) {
  if (choice === 'all') {
    // Matches all new flow (NEW-*), old flow (OLD-*) and bug tests
    return 'NEW-R|NEW-P|NEW-V|NEW-TZ|NEW-N|NEW-E|NEW-X|OLD-R|OLD-P|OLD-BUG|OLD-N|TSP-BUG';
  }
  return choice;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main interactive flow
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(`\n${C.bold}${C.white}╔══════════════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.bold}${C.white}║  Logward Ocean Events-Out — Interactive Test Runner  ║${C.reset}`);
  console.log(`${C.bold}${C.white}╚══════════════════════════════════════════════════════╝${C.reset}`);

  const greps = [];

  // ── DIRECT SHIPMENT ─────────────────────────────────────────────────────────
  hdr('DIRECT SHIPMENT TESTS');
  console.log(`${C.gray}These tests verify field mapping for Pre-Carriage, POL, POD, and Delivery events.${C.reset}`);

  const runDirect = await ask(rl, `\n${C.bold}Run Direct Shipment tests? (Y/n): ${C.reset}`);

  if (runDirect.toLowerCase() !== 'n') {
    console.log(`\n${C.bold}Available Logward field keys:${C.reset}`);
    printFieldList(DIRECT_FIELDS);

    console.log(`\n${C.gray}Type ${C.reset}${C.bold}all${C.reset}${C.gray} to run all direct shipment tests,`);
    console.log(`or type a ${C.reset}${C.bold}field name${C.reset}${C.gray} from the list above (e.g. actualArrivalPod):${C.reset}`);

    let directChoice = '';
    while (true) {
      directChoice = await ask(rl, `${C.cyan}▶ Your choice: ${C.reset}`);
      if (directChoice === 'all') break;
      if (DIRECT_FIELDS[directChoice]) {
        console.log(`${C.green}✓ Will run tests for: ${directChoice} — ${DIRECT_FIELDS[directChoice].desc}${C.reset}`);
        break;
      }
      console.log(`${C.yellow}⚠ "${directChoice}" not found. Try again or type "all".${C.reset}`);
    }

    greps.push({ label: `Direct: ${directChoice}`, pattern: buildDirectGrep(directChoice) });
  }

  // ── TSP TESTS ───────────────────────────────────────────────────────────────
  hdr('TRANSHIPMENT (TSP) TESTS');
  console.log(`${C.gray}These tests verify field mapping for transhipment port events (slots 1–4, N/N-1 logic).${C.reset}`);

  const runTsp = await ask(rl, `\n${C.bold}Run TSP tests? (Y/n): ${C.reset}`);

  if (runTsp.toLowerCase() !== 'n') {
    console.log(`\n${C.bold}Available TSP Logward field keys:${C.reset}`);
    printFieldList(TSP_FIELDS);

    console.log(`\n${C.gray}You can also type a ${C.reset}${C.bold}test group${C.reset}${C.gray} to run an entire group:`);
    console.log(`  ${C.cyan}NEW-R${C.gray}  Routing tests  |  ${C.cyan}NEW-P${C.gray}  Positive (slot assignment)`);
    console.log(`  ${C.cyan}NEW-V${C.gray}  Vessel logic   |  ${C.cyan}NEW-TZ${C.gray} Timezone conversion`);
    console.log(`  ${C.cyan}NEW-N${C.gray}  Negatives      |  ${C.cyan}NEW-E${C.gray}  Edge cases`);
    console.log(`  ${C.cyan}OLD-R${C.gray}  Old flow       |  ${C.cyan}TSP-BUG${C.gray} Known bug${C.reset}`);
    console.log(`\n${C.gray}Or type ${C.reset}${C.bold}all${C.reset}${C.gray} to run all TSP tests:${C.reset}`);

    const TSP_GROUPS = ['NEW-R','NEW-P','NEW-V','NEW-TZ','NEW-N','NEW-E','NEW-X','OLD-R','OLD-P','OLD-BUG','OLD-N','TSP-BUG'];

    let tspChoice = '';
    while (true) {
      tspChoice = await ask(rl, `${C.cyan}▶ Your choice: ${C.reset}`);
      if (tspChoice === 'all') break;
      if (TSP_FIELDS[tspChoice]) {
        console.log(`${C.green}✓ Will run tests for: ${tspChoice} — ${TSP_FIELDS[tspChoice].desc}${C.reset}`);
        break;
      }
      if (TSP_GROUPS.includes(tspChoice)) {
        console.log(`${C.green}✓ Will run test group: ${tspChoice}${C.reset}`);
        break;
      }
      console.log(`${C.yellow}⚠ "${tspChoice}" not found. Try a field name, group name, or "all".${C.reset}`);
    }

    greps.push({ label: `TSP: ${tspChoice}`, pattern: buildTspGrep(tspChoice) });
  }

  rl.close();

  if (greps.length === 0) {
    console.log(`\n${C.yellow}Nothing selected. Exiting.${C.reset}\n`);
    process.exit(0);
  }

  // ── Build and run command ───────────────────────────────────────────────────
  const combinedPattern = greps.map(g => g.pattern).join('|');
  const labels          = greps.map(g => g.label).join(' + ');
  const cmd = `npx playwright test --project=ocean E2E_Ocean --grep "${combinedPattern}" --reporter=list`;

  hdr(`RUNNING: ${labels}`);
  console.log(`${C.gray}Command: ${C.reset}${C.dim}${cmd}${C.reset}\n`);

  try {
    execSync(cmd, { stdio: 'inherit', cwd: process.cwd() });
  } catch (e) {
    // playwright returns non-zero on test failures — that's ok
    process.exit(e.status || 1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
