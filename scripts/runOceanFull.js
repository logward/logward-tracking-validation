#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  scripts/runOceanFull.js
//
//  Runs OceanOrdersIn + OceanEventsOut in sequence and produces ONE
//  consolidated HTML report combining both:
//    - Tab 1: Orders-In Flow (S-01 to S-43 — create → scheduler → mongo → shippeo → events)
//    - Tab 2: Events-Out Field Mapping (all stages: D, PC, POL, POD, DEL, TSP, X, N)
//
//  Usage:
//    node scripts/runOceanFull.js              ← both suites
//    node scripts/runOceanFull.js --orders-in  ← Orders-In only
//    node scripts/runOceanFull.js --events-out ← Events-Out only
//    node scripts/runOceanFull.js -g "GROUP P" ← pass a grep filter to Orders-In
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { execSync } = require('child_process');
const fs           = require('fs');
const path         = require('path');

const ROOT = path.resolve(__dirname, '..');

// ── Session directory shared by both suites ───────────────────────────────────
const ts         = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
const SESSION_ID = `ocean-full-${ts}`;
const RUN_DIR    = path.join(ROOT, 'playwright-report', 'runs', SESSION_ID);
const OUT_FILE   = path.join(ROOT, 'playwright-report', 'sessions', `${SESSION_ID}.html`);

// ── CLI flags ─────────────────────────────────────────────────────────────────
const args       = process.argv.slice(2);
const onlyOI     = args.includes('--orders-in');
const onlyEO     = args.includes('--events-out');
const grepIdx    = args.indexOf('-g');
const grepFilter = grepIdx !== -1 ? args[grepIdx + 1] : null;
const runOI      = !onlyEO;
const runEO      = !onlyOI;

// ── Helpers ───────────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m', bold: '\x1b[1m',
  cyan:   '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', gray: '\x1b[90m',
};
function banner(t) { console.log(`\n${C.bold}${C.cyan}▶ ${t}${C.reset}\n${'─'.repeat(60)}`); }
function ok(m)     { console.log(`  ${C.green}✅ ${m}${C.reset}`); }
function fail(m)   { console.log(`  ${C.red}❌ ${m}${C.reset}`); }
function info(m)   { console.log(`  ${C.cyan}ℹ  ${m}${C.reset}`); }

function runSuite(label, specFile, grepArg) {
  banner(label);
  const grepPart = grepArg ? ` --grep "${grepArg}"` : '';
  const cmd = `npx playwright test --project=ocean ${specFile}${grepPart} --reporter=list`;
  info(`Running: ${cmd}`);
  try {
    execSync(cmd, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_RUN_DIR: RUN_DIR } });
    ok(`${label} complete`);
  } catch {
    fail(`${label} finished with test failures — report will still be generated`);
  }
}

// ── Run suites ────────────────────────────────────────────────────────────────
const ENV_NAME = process.env.E2E_ENV || 'qa';
console.log(`\n${C.bold}Ocean Full Report Runner${C.reset}`);
info(`Environment: ${C.bold}${ENV_NAME.toUpperCase()}${C.reset}`);
info(`Session:  ${SESSION_ID}`);
info(`Run dir:  ${RUN_DIR}`);
info(`Output:   ${OUT_FILE}\n`);

if (runOI) runSuite('Orders-In',  'OceanOrdersIn', grepFilter);
if (runEO) runSuite('Events-Out', 'OceanEventsOut', null);

// ── Read generated report files ───────────────────────────────────────────────
const OI_FILE = path.join(RUN_DIR, 'ocean', 'ordersIn-flow-report.html');
const EO_FILE = path.join(RUN_DIR, 'ocean', 'events-out-report.html');

const oiExists = fs.existsSync(OI_FILE);
const eoExists = fs.existsSync(EO_FILE);

if (!oiExists && !eoExists) {
  fail('No reports found. Make sure at least one suite ran.');
  process.exit(1);
}

const oiHtml = oiExists ? fs.readFileSync(OI_FILE, 'utf8') : null;
const eoHtml = eoExists ? fs.readFileSync(EO_FILE, 'utf8') : null;

// ── Parse quick stats from HTML (simple regex — no DOM parser needed) ─────────
function parseStats(html) {
  if (!html) return { passed: '—', failed: '—', total: '—' };
  const nums = [...html.matchAll(/<strong[^>]*>(\d+)<\/strong>/g)].map(m => parseInt(m[1]));
  return { total: nums[0] || '—', passed: nums[1] || '—', failed: nums[2] || '—' };
}
const oiStats = parseStats(oiHtml);
const eoStats = parseStats(eoHtml);

// ── Encode HTML for srcdoc (only & needs escaping in srcdoc attribute) ────────
function toSrcdoc(html) {
  return html ? html.replace(/&/g, '&amp;') : '';
}

// ── Build combined HTML ───────────────────────────────────────────────────────
function buildHtml() {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  const tabs = [];
  if (oiHtml) tabs.push({ id: 'oi', label: 'Orders-In Flow', icon: '📋', stats: oiStats, color: '#3182ce' });
  if (eoHtml) tabs.push({ id: 'eo', label: 'Events-Out Mapping', icon: '🗺', stats: eoStats, color: '#38a169' });

  const tabBtns = tabs.map((t, i) => `
    <button class="tab-btn ${i === 0 ? 'active' : ''}" data-tab="${t.id}" onclick="switchTab('${t.id}')">
      <span class="tab-icon">${t.icon}</span>
      <span class="tab-label">${t.label}</span>
      <span class="tab-pill" style="background:${t.color}20;color:${t.color}">${t.stats.passed} passed</span>
    </button>`).join('');

  const frames = tabs.map((t, i) => {
    const src = t.id === 'oi' ? toSrcdoc(oiHtml) : toSrcdoc(eoHtml);
    return `<iframe id="frame-${t.id}" class="report-frame ${i === 0 ? 'active' : ''}"
      srcdoc="${src}"
      sandbox="allow-same-origin allow-scripts"
      title="${t.label}"></iframe>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Ocean Full Report — ${ts}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1923;color:#e2e8f0;display:flex;flex-direction:column;height:100vh;overflow:hidden;}

    /* ── Header ── */
    .hdr{background:linear-gradient(135deg,#0f1923,#1a2940);border-bottom:1px solid #2d3748;padding:16px 28px;flex-shrink:0;}
    .hdr-top{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;}
    .hdr h1{font-size:1.25rem;font-weight:700;color:#fff;display:flex;align-items:center;gap:10px;}
    .hdr .env-badge{font-size:.72rem;background:#2d3748;color:#90cdf4;padding:3px 10px;border-radius:10px;font-weight:600;letter-spacing:.04em;}
    .hdr .meta{font-size:.75rem;color:#718096;margin-top:6px;}

    /* ── Stats row ── */
    .stats-row{display:flex;gap:20px;margin-top:10px;flex-wrap:wrap;}
    .stat-block{display:flex;flex-direction:column;align-items:flex-start;}
    .stat-block .stat-label{font-size:.65rem;text-transform:uppercase;letter-spacing:.08em;color:#718096;}
    .stat-block .stat-vals{display:flex;gap:8px;margin-top:2px;}
    .stat-pill{font-size:.72rem;font-weight:700;padding:2px 8px;border-radius:8px;}
    .stat-pill.pass{background:#22543d;color:#9ae6b4;}
    .stat-pill.fail{background:#742a2a;color:#fc8181;}
    .stat-pill.tot{background:#2d3748;color:#a0aec0;}

    /* ── Tabs ── */
    .tabs{display:flex;gap:4px;background:#0f1923;border-bottom:1px solid #2d3748;padding:0 20px;flex-shrink:0;}
    .tab-btn{display:flex;align-items:center;gap:8px;padding:12px 18px;border:none;background:transparent;color:#718096;cursor:pointer;font-size:.85rem;border-bottom:3px solid transparent;transition:all .15s;white-space:nowrap;}
    .tab-btn:hover{color:#e2e8f0;background:#1a2940;}
    .tab-btn.active{color:#fff;border-bottom-color:#4299e1;}
    .tab-icon{font-size:1rem;}
    .tab-label{font-weight:600;}
    .tab-pill{font-size:.7rem;font-weight:700;padding:2px 8px;border-radius:8px;}

    /* ── Frames ── */
    .frames{flex:1;position:relative;overflow:hidden;}
    .report-frame{position:absolute;inset:0;width:100%;height:100%;border:none;display:none;}
    .report-frame.active{display:block;}

    /* ── Empty state ── */
    .empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:#4a5568;gap:8px;}
    .empty-state .big{font-size:3rem;}
    .empty-state p{font-size:.9rem;}
  </style>
</head>
<body>

<div class="hdr">
  <div class="hdr-top">
    <h1>🌊 Ocean Full Report <span class="env-badge">QA</span></h1>
    <span style="font-size:.75rem;color:#4a5568;">${now}</span>
  </div>
  <div class="stats-row">
    ${oiHtml ? `<div class="stat-block">
      <span class="stat-label">Orders-In</span>
      <div class="stat-vals">
        <span class="stat-pill pass">${oiStats.passed} passed</span>
        ${oiStats.failed !== '—' && oiStats.failed > 0 ? `<span class="stat-pill fail">${oiStats.failed} failed</span>` : ''}
        <span class="stat-pill tot">${oiStats.total} total</span>
      </div>
    </div>` : ''}
    ${eoHtml ? `<div class="stat-block">
      <span class="stat-label">Events-Out</span>
      <div class="stat-vals">
        <span class="stat-pill pass">${eoStats.passed} passed</span>
        ${eoStats.failed !== '—' && eoStats.failed > 0 ? `<span class="stat-pill fail">${eoStats.failed} failed</span>` : ''}
        <span class="stat-pill tot">${eoStats.total} total</span>
      </div>
    </div>` : ''}
  </div>
</div>

<div class="tabs">${tabBtns}</div>

<div class="frames">${frames}</div>

<script>
  function switchTab(id) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
    document.querySelectorAll('.report-frame').forEach(f => f.classList.toggle('active', f.id === 'frame-' + id));
  }
</script>

</body>
</html>`;
}

// ── Write output ──────────────────────────────────────────────────────────────
fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, buildHtml(), 'utf8');

banner('Done');
ok(`Combined report written: ${OUT_FILE}`);
console.log(`\n  ${C.bold}Open locally:${C.reset}`);
console.log(`  open "${OUT_FILE}"\n`);
