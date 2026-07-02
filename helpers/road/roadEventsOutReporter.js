// ─────────────────────────────────────────────────────────────────────────────
//  helpers/road/roadEventsOutReporter.js
//
//  Custom Playwright reporter for RoadEventsOut.spec.js
//  Generates a clean HTML report showing pass/fail per block and test.
//
//  Registered in playwright.config.js under the "road" project:
//    reporter: [['./helpers/road/roadEventsOutReporter.js', { outputFile: '...' }]]
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const fs   = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
//  Field descriptions — used in tooltip/sidebar
// ─────────────────────────────────────────────────────────────────────────────

const FIELD_DESCRIPTIONS = {
  truckDrivingToPickUpLocation:       'Truck driving to pickup location (EML/CFM/DRIVING_TO_LOAD)',
  actualArrivalAtPickUpLocation:      'Arrived at pickup location (EML/ARS/ARR_LOAD)',
  loaded:                             'Goods loaded (ECH/CFM/CON_LOAD)',
  actualDeparturePolRoad:             'Left loading site (ECH/DES/LEFT_LOADING_SITE)',
  truckDrivingToDeliveryLocation:     'Truck driving to delivery (MLV/CFM/DRIVING_TO_UNLOAD)',
  actualArrivalPodRoad:               'Arrived at delivery location (LIV/ARS/ARR_UNLOAD)',
  delivered:                          'Goods delivered (LIV/CFM/CON_UNLOAD)',
  truckDepartureFromDeliveryLocation: 'Left delivery location (LIV/DES/DRIVER_LEFT_UNLOAD)',
  predictedArrivalAtPickUpLocation:   'Predicted ETA at pickup — requires order.etd (COM/CFM/ETA_EVENT)',
  predictedArrivalAtDeliveryLocation: 'Predicted ETA at delivery — requires order.eta (COM/CFM/ETA_EVENT)',
};

const EVENT_CONDITIONS = [
  { sitCode: 'EML', justCode: 'CFM', event: 'DRIVING_TO_LOAD',    field: 'truckDrivingToPickUpLocation',       test: 'RD-P-01' },
  { sitCode: 'EML', justCode: 'ARS', event: 'ARR_LOAD',           field: 'actualArrivalAtPickUpLocation',      test: 'RD-P-02' },
  { sitCode: 'ECH', justCode: 'CFM', event: 'CON_LOAD',           field: 'loaded',                             test: 'RD-P-03' },
  { sitCode: 'ECH', justCode: 'DES', event: 'LEFT_LOADING_SITE',  field: 'actualDeparturePolRoad',             test: 'RD-P-04' },
  { sitCode: 'MLV', justCode: 'CFM', event: 'DRIVING_TO_UNLOAD',  field: 'truckDrivingToDeliveryLocation',     test: 'RD-P-05' },
  { sitCode: 'LIV', justCode: 'ARS', event: 'ARR_UNLOAD',         field: 'actualArrivalPodRoad',               test: 'RD-P-06' },
  { sitCode: 'LIV', justCode: 'CFM', event: 'CON_UNLOAD',         field: 'delivered',                          test: 'RD-P-07' },
  { sitCode: 'LIV', justCode: 'DES', event: 'DRIVER_LEFT_UNLOAD', field: 'truckDepartureFromDeliveryLocation', test: 'RD-P-08' },
  { sitCode: 'COM', justCode: 'CFM', event: 'ETA_EVENT (etd)',     field: 'predictedArrivalAtPickUpLocation',   test: 'RD-P-09' },
  { sitCode: 'COM', justCode: 'CFM', event: 'ETA_EVENT (eta)',     field: 'predictedArrivalAtDeliveryLocation', test: 'RD-P-10' },
];

// ─────────────────────────────────────────────────────────────────────────────
//  Utility
// ─────────────────────────────────────────────────────────────────────────────

function fmtDuration(ms) {
  if (!ms) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function blockLabel(titlePath) {
  const full = titlePath.join(' › ');
  if (full.includes('BLOCK A')) return 'BLOCK A';
  if (full.includes('BLOCK P')) return 'BLOCK P';
  if (full.includes('BLOCK N')) return 'BLOCK N';
  if (full.includes('BLOCK E') || full.includes('BLOCK E')) return 'BLOCK E';
  return 'Other';
}

function testId(title) {
  const m = title.match(/^(RD-[A-Z]-\d+|A-\d+|E-\d+-\w+|E-06-\w+)/);
  return m ? m[1] : title.slice(0, 30);
}

// ─────────────────────────────────────────────────────────────────────────────
//  HTML generation
// ─────────────────────────────────────────────────────────────────────────────

function generateHTML(results, totalDurationMs) {
  const passed  = results.filter(r => r.status === 'passed').length;
  const failed  = results.filter(r => r.status === 'failed').length;
  const skipped = results.filter(r => r.status === 'skipped' || r.status === 'timedOut').length;
  const total   = results.length;
  const passRate = total ? Math.round((passed / total) * 100) : 0;

  // Group by block
  const blocks = {};
  for (const r of results) {
    const b = blockLabel(r.titlePath);
    if (!blocks[b]) blocks[b] = [];
    blocks[b].push(r);
  }

  const BLOCK_ORDER = ['BLOCK A', 'BLOCK P', 'BLOCK N', 'BLOCK E', 'Other'];
  const BLOCK_META = {
    'BLOCK A': { label: 'Orders-In Gates',    desc: 'Create RTU → Scheduler active=1 valid=1 → GET all required fields',  icon: '🏁' },
    'BLOCK P': { label: 'Positive Events',    desc: 'All 10 event conditions: 8 standard + 2 ETA_EVENT variants',          icon: '✅' },
    'BLOCK N': { label: 'Negative / Auth',    desc: 'Wrong codes, missing fields, case-sensitivity, auth, empty body',     icon: '🚫' },
    'BLOCK E': { label: 'Edge Cases',         desc: 'Date overwrite, earlier no-overwrite, both ETAs, full 8-event journey', icon: '🔬' },
    'Other':   { label: 'Other',              desc: '',                                                                     icon: '📋' },
  };

  function renderBlock(blockKey) {
    const tests = blocks[blockKey];
    if (!tests || !tests.length) return '';
    const meta      = BLOCK_META[blockKey] || { label: blockKey, desc: '', icon: '📋' };
    const bPassed   = tests.filter(t => t.status === 'passed').length;
    const bFailed   = tests.filter(t => t.status === 'failed').length;
    const bSkipped  = tests.filter(t => t.status === 'skipped' || t.status === 'timedOut').length;
    const bTotal    = tests.length;
    const bAllPass  = bFailed === 0 && bSkipped === 0;
    const bDuration = tests.reduce((sum, t) => sum + (t.duration || 0), 0);

    const rows = tests.map(t => {
      const statusClass = t.status === 'passed' ? 'pass' : (t.status === 'failed' ? 'fail' : 'skip');
      const statusIcon  = t.status === 'passed' ? '✅' : (t.status === 'failed' ? '❌' : '⏭');
      const tid         = testId(t.title);
      const errorHtml   = t.error
        ? `<div class="error-msg">${escHtml(t.error.slice(0, 400))}</div>`
        : '';

      return `
        <tr class="test-row ${statusClass}">
          <td class="td-id"><span class="badge ${statusClass}">${statusIcon} ${escHtml(tid)}</span></td>
          <td class="td-title">${escHtml(t.title.replace(/^RD-[A-Z]-\d+\s*—\s*/, '').replace(/^[AE]-\d+[-\w]*\s*—\s*/, ''))}</td>
          <td class="td-dur">${fmtDuration(t.duration)}</td>
        </tr>
        ${t.error ? `<tr class="error-row ${statusClass}"><td colspan="3">${errorHtml}</td></tr>` : ''}
      `;
    }).join('');

    return `
    <div class="block-card ${bAllPass ? 'block-pass' : 'block-fail'}">
      <div class="block-header">
        <span class="block-icon">${meta.icon}</span>
        <div class="block-title-group">
          <h2 class="block-title">${escHtml(blockKey)} — ${escHtml(meta.label)}</h2>
          ${meta.desc ? `<p class="block-desc">${escHtml(meta.desc)}</p>` : ''}
        </div>
        <div class="block-stats">
          <span class="stat pass-stat">${bPassed} passed</span>
          ${bFailed  ? `<span class="stat fail-stat">${bFailed} failed</span>` : ''}
          ${bSkipped ? `<span class="stat skip-stat">${bSkipped} skipped</span>` : ''}
          <span class="stat dur-stat">${fmtDuration(bDuration)}</span>
        </div>
      </div>
      <table class="test-table">
        <thead><tr><th>ID</th><th>Test</th><th>Duration</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }

  const blocksHTML = BLOCK_ORDER
    .filter(b => blocks[b] && blocks[b].length)
    .map(renderBlock)
    .join('\n');

  const conditionRows = EVENT_CONDITIONS.map(c => `
    <tr>
      <td><code>${c.sitCode}</code></td>
      <td><code>${c.justCode}</code></td>
      <td><code>${c.event}</code></td>
      <td class="field-name"><code>${c.field}</code></td>
      <td>${c.test}</td>
    </tr>`).join('');

  const runDate = new Date().toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Road Events-Out Test Report</title>
<style>
  :root {
    --bg:       #0f1117;
    --surface:  #1a1d27;
    --card:     #20242f;
    --border:   #2d3142;
    --text:     #e2e4f0;
    --muted:    #7b7f96;
    --pass:     #22c55e;
    --fail:     #ef4444;
    --skip:     #f59e0b;
    --accent:   #6366f1;
    --accent2:  #818cf8;
    --road:     #f97316;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', system-ui, sans-serif; font-size: 14px; line-height: 1.5; }

  /* ── Header ── */
  .page-header {
    background: linear-gradient(135deg, #1a1d27 0%, #20242f 60%, #16192a 100%);
    border-bottom: 2px solid var(--road);
    padding: 32px 40px 24px;
  }
  .page-header h1 { font-size: 26px; font-weight: 700; color: var(--road); letter-spacing: -0.5px; }
  .page-header .subtitle { color: var(--muted); margin-top: 4px; font-size: 13px; }
  .run-meta { display: flex; gap: 24px; margin-top: 20px; flex-wrap: wrap; }
  .run-meta-item { font-size: 12px; color: var(--muted); }
  .run-meta-item strong { color: var(--text); }

  /* ── Summary bar ── */
  .summary-bar {
    display: flex; align-items: center; gap: 0;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 0 40px;
  }
  .summary-segment {
    flex: 1; padding: 16px 0;
    text-align: center;
    border-right: 1px solid var(--border);
  }
  .summary-segment:last-child { border-right: none; }
  .summary-big { font-size: 28px; font-weight: 700; }
  .summary-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px; }
  .summary-segment.pass .summary-big { color: var(--pass); }
  .summary-segment.fail .summary-big { color: var(--fail); }
  .summary-segment.skip .summary-big { color: var(--skip); }
  .summary-segment.rate .summary-big { color: var(--accent2); }

  /* ── Progress bar ── */
  .progress-bar { height: 4px; background: var(--border); }
  .progress-fill { height: 100%; background: var(--pass); transition: width 0.3s; }
  .progress-fill.has-fail { background: linear-gradient(90deg, var(--pass) ${passRate}%, var(--fail) ${passRate}%); }

  /* ── Content ── */
  .content { padding: 32px 40px; max-width: 1200px; margin: 0 auto; }
  h2.section-heading { font-size: 15px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 20px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }

  /* ── Block cards ── */
  .block-card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; margin-bottom: 20px; overflow: hidden; }
  .block-card.block-pass { border-left: 4px solid var(--pass); }
  .block-card.block-fail { border-left: 4px solid var(--fail); }
  .block-header { display: flex; align-items: flex-start; gap: 14px; padding: 18px 20px; border-bottom: 1px solid var(--border); background: rgba(255,255,255,0.02); }
  .block-icon { font-size: 24px; flex-shrink: 0; margin-top: 2px; }
  .block-title-group { flex: 1; }
  .block-title { font-size: 16px; font-weight: 600; color: var(--text); }
  .block-desc { font-size: 12px; color: var(--muted); margin-top: 4px; }
  .block-stats { display: flex; gap: 10px; align-items: center; flex-shrink: 0; }
  .stat { font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 20px; }
  .pass-stat { background: rgba(34,197,94,0.12); color: var(--pass); }
  .fail-stat { background: rgba(239,68,68,0.12); color: var(--fail); }
  .skip-stat { background: rgba(245,158,11,0.12); color: var(--skip); }
  .dur-stat  { background: rgba(99,102,241,0.10); color: var(--accent2); }

  /* ── Test table ── */
  .test-table { width: 100%; border-collapse: collapse; }
  .test-table th { font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; padding: 10px 16px; text-align: left; background: rgba(0,0,0,0.2); }
  .test-table td { padding: 10px 16px; border-top: 1px solid var(--border); vertical-align: top; }
  .test-row:hover td { background: rgba(255,255,255,0.02); }
  .test-row.pass .td-id { color: var(--pass); }
  .test-row.fail .td-id { color: var(--fail); }
  .test-row.skip .td-id { color: var(--skip); }
  .td-id { white-space: nowrap; width: 160px; }
  .td-dur { white-space: nowrap; width: 80px; text-align: right; color: var(--muted); font-size: 12px; }
  .badge { font-size: 12px; font-weight: 600; }
  .error-row td { padding: 0 16px 12px; }
  .error-msg { font-family: monospace; font-size: 12px; background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.2); color: #fca5a5; border-radius: 6px; padding: 10px 14px; white-space: pre-wrap; word-break: break-all; }

  /* ── Condition table ── */
  .condition-card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; margin-bottom: 32px; }
  .condition-table { width: 100%; border-collapse: collapse; }
  .condition-table th { font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; padding: 10px 16px; text-align: left; background: rgba(0,0,0,0.2); border-bottom: 1px solid var(--border); }
  .condition-table td { padding: 9px 16px; border-top: 1px solid var(--border); font-size: 13px; }
  .condition-table code { font-family: monospace; font-size: 12px; background: rgba(99,102,241,0.12); color: var(--accent2); padding: 1px 6px; border-radius: 4px; }
  .field-name code { color: var(--road); background: rgba(249,115,22,0.1); }

  /* ── Footer ── */
  .page-footer { text-align: center; color: var(--muted); font-size: 12px; padding: 32px; border-top: 1px solid var(--border); margin-top: 20px; }
</style>
</head>
<body>

<div class="page-header">
  <h1>🚛 Road Events-Out — Field Mapping Report</h1>
  <p class="subtitle">Logward ↔ Shippeo Road Tracking · QA Environment</p>
  <div class="run-meta">
    <div class="run-meta-item"><strong>Run date:</strong> ${runDate}</div>
    <div class="run-meta-item"><strong>Duration:</strong> ${fmtDuration(totalDurationMs)}</div>
    <div class="run-meta-item"><strong>Webhook:</strong> /api/integration-hub/tracking/shippeo/road_tracking</div>
    <div class="run-meta-item"><strong>Condition check:</strong> situation_code + justification_code + situation.event (all exact, case-sensitive)</div>
  </div>
</div>

<div class="progress-bar">
  <div class="progress-fill ${failed ? 'has-fail' : ''}" style="width:${passRate}%"></div>
</div>

<div class="summary-bar">
  <div class="summary-segment">
    <div class="summary-big">${total}</div>
    <div class="summary-label">Total</div>
  </div>
  <div class="summary-segment pass">
    <div class="summary-big">${passed}</div>
    <div class="summary-label">Passed</div>
  </div>
  <div class="summary-segment fail">
    <div class="summary-big">${failed}</div>
    <div class="summary-label">Failed</div>
  </div>
  <div class="summary-segment skip">
    <div class="summary-big">${skipped}</div>
    <div class="summary-label">Skipped</div>
  </div>
  <div class="summary-segment rate">
    <div class="summary-big">${passRate}%</div>
    <div class="summary-label">Pass Rate</div>
  </div>
</div>

<div class="content">

  <h2 class="section-heading">Event Condition Mapping Reference</h2>
  <div class="condition-card">
    <table class="condition-table">
      <thead><tr><th>situation_code</th><th>justification_code</th><th>situation.event</th><th>Logward Field Written</th><th>Test</th></tr></thead>
      <tbody>${conditionRows}</tbody>
    </table>
  </div>

  <h2 class="section-heading">Test Results by Block</h2>
  ${blocksHTML}

</div>

<div class="page-footer">
  Generated by Logward Road Events-Out Reporter · Playwright · ${runDate}
</div>

</body>
</html>`;
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Playwright Reporter class
// ─────────────────────────────────────────────────────────────────────────────

class RoadEventsOutReporter {
  constructor(options) {
    const runDir = process.env.PLAYWRIGHT_RUN_DIR || 'playwright-report';
    this.outputFile = options?.outputFile || path.join(runDir, 'road', 'road-events-out-report.html');
    this.results    = [];
    this.startTime  = Date.now();
  }

  onBegin(_config, _suite) {
    // nothing needed
  }

  onTestEnd(test, result) {
    // Capture title path — array of describe names + test name
    const titlePath = [];
    let suite = test.parent;
    while (suite) {
      if (suite.title) titlePath.unshift(suite.title);
      suite = suite.parent;
    }
    titlePath.push(test.title);

    const errorMsg = result.errors?.[0]?.message || result.error?.message || null;

    this.results.push({
      title:     test.title,
      titlePath,
      status:    result.status,
      duration:  result.duration,
      error:     errorMsg,
    });
  }

  onEnd(_fullResult) {
    const totalDuration = Date.now() - this.startTime;
    if (this.results.length === 0) return;

    const html = generateHTML(this.results, totalDuration);
    const dir  = path.dirname(this.outputFile);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.outputFile, html, 'utf8');
    console.log(`\n  📊 Road Events-Out Report: ${this.outputFile}`);
    console.log(`     open ${this.outputFile}`);
  }
}

module.exports = RoadEventsOutReporter;
