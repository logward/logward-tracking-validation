#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  scripts/runAirOrdersIn.js
//
//  Interactive wrapper for AirOrdersIn tests.
//  Asks which tracking key to test, then runs all groups (positive, negative,
//  edge cases) for both IATA and Inland site types automatically.
//
//  Usage:
//    node scripts/runAirOrdersIn.js
//    node scripts/runAirOrdersIn.js --group "GROUP P"
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const readline     = require('readline');
const { execSync } = require('child_process');

const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(res => rl.question(q, res));

const TRACKING_KEYS = {
  '1': { key: 'mawb',        label: 'MAWB  (masterAirWaybillNumber)' },
  '2': { key: 'hawb',        label: 'HAWB  (houseAirWaybillNumber + freightForwarderEdiRef)' },
  '3': { key: 'customerref', label: 'Customer Reference  (airCustomerReference + freightForwarderEdiRef)' },
};

async function main() {
  const groupArg = process.argv.includes('--group')
    ? process.argv[process.argv.indexOf('--group') + 1]
    : null;

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║     Air Orders-In — Test Runner          ║');
  console.log('╚══════════════════════════════════════════╝\n');

  console.log('Which tracking key are you testing?\n');
  Object.entries(TRACKING_KEYS).forEach(([k, v]) => console.log(`  ${k}) ${v.label}`));
  const choice = (await ask('\n  Enter 1, 2 or 3: ')).trim();
  const cfg    = TRACKING_KEYS[choice];

  rl.close();

  if (!cfg) {
    console.error('\n  ✖  Invalid choice. Exiting.\n');
    process.exit(1);
  }

  console.log('\n──────────────────────────────────────────────');
  console.log(`  Tracking key : ${cfg.label}`);
  console.log(`  Site types   : IATA + Inland (both covered automatically)`);
  if (groupArg) console.log(`  Group filter : ${groupArg}`);
  console.log('──────────────────────────────────────────────\n');

  const grepArg = groupArg ? `--grep "${groupArg}"` : '';
  const cmd     = `npx playwright test --project=air AirOrdersIn --reporter=list ${grepArg}`.trim();

  console.log(`  Running: ${cmd}\n`);

  execSync(cmd, {
    stdio: 'inherit',
    cwd:   process.cwd(),
    env:   { ...process.env, AIR_TRACKING_KEY: cfg.key },
  });
}

main().catch(e => {
  console.error('\n  ✖  ' + e.message);
  rl.close();
  process.exit(1);
});
