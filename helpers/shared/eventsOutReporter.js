// ─────────────────────────────────────────────────────────────────────────────
//  helpers/shared/eventsOutReporter.js
//
//  Custom Playwright reporter for OceanEventsOut.spec.js
//  Generates a clear, human-readable HTML report for:
//    - Direct Shipment field mapping tests (DS-PC, DS-POL, DS-POD, DS-DEL, DS-N, DS-E)
//    - TSP Transhipment tests (TSP-P, TSP-N, TSP-E)
//
//  Usage — add to playwright.config.js ocean project:
//    reporter: [['./helpers/shared/eventsOutReporter.js'], ['list']]
//
//  Or run manually after a test run:
//    node helpers/shared/eventsOutReporter.js <playwright-json-output.json>
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const fs   = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
//  Human-readable lookup tables
// ─────────────────────────────────────────────────────────────────────────────

const EVENT_LABELS = {
  container_gate_out_empty:  'Container Gate Out (empty) 📦',
  container_gate_out_full:   'Container Gate Out (full) 📦',
  container_gate_in_empty:   'Container Gate In (empty) 📦',
  container_gate_in_full:    'Container Gate In (full) 📦',
  container_arrived:         'Container Arrived 🚢',
  container_departed:        'Container Departed 🚢',
  container_loaded:          'Container Loaded 🏗',
  container_unloaded:        'Container Unloaded 🏗',
  eta_event:                 'ETA Update ⏰',
  container_inspected:       'Container Inspected 🔍',
};

const PLACE_LABELS = {
  origin_inland_location:      'Pre-Carriage (depot/inland)',
  loading:                     'Port of Loading (POL)',
  discharge:                   'Port of Discharge (POD)',
  destination_inland_location: 'Delivery (destination)',
  transhipment:                'Transhipment Port',
};

const TYPE_LABELS = {
  actual:    '✅ Actual',
  estimated: '📅 Estimated',
  predicted: '🔮 Predicted',
};

const DATASOURCE_LABELS = {
  external: 'External (forwarder/carrier)',
  shippeo:  'Shippeo (predicted)',
  null:     '— (actual, no source required)',
};

const FIELD_DESCRIPTIONS = {
  actualGateOutEmptyDepot:       'Actual date container left the depot (empty)',
  estimatedGateOutEmptyDepot:    'Estimated date container leaves depot (empty)',
  depotPreLocation:              'City where container was picked up',
  depotPreCountry:               'Country where container was picked up',
  motGateOutEmpty:               'Transport mode at depot gate-out',
  actualDepartureFromOrigin:     'Actual departure date from inland origin',
  estimatedDepartureFromOrigin:  'Estimated departure date from inland origin',
  pickUpOriginLocation:          'City of pickup from origin',
  pickUpOriginCountry:           'Country of pickup from origin',
  motPickUpOrigin:               'Transport mode at origin pickup',
  actualLoadedAtOrigin:          'Actual date container was loaded at origin',
  estimatedLoadedAtOrigin:       'Estimated date container loaded at origin',
  actualGateInPol:               'Actual date container arrived at loading port',
  estimatedGateInPol:            'Estimated date container arrives at loading port',
  actualLoadPol:                 'Actual date container was loaded onto vessel at POL',
  estimatedLoadPol:              'Estimated date container loaded onto vessel',
  actualDeparturePol:            'Actual vessel departure from loading port',
  estimatedDeparturePol:         'Estimated vessel departure from loading port',
  predictedDeparturePol:         'Shippeo-predicted vessel departure',
  leg1Mot:                       'Transport mode for the first ocean leg',
  leg1VesselImoNumber:           'IMO number of the vessel on leg 1',
  leg1VesselName:                'Name of the vessel on leg 1',
  leg2VesselImoNumber:           'IMO number of the vessel on leg 2',
  leg2VesselName:                'Name of the vessel on leg 2',
  leg3VesselImoNumber:           'IMO number of the vessel on leg 3',
  leg4VesselImoNumber:           'IMO number of the vessel on leg 4',
  actualArrivalPod:              'Actual arrival at port of discharge',
  estimatedArrivalPod:           'Estimated arrival at port of discharge (ETA)',
  predictedArrivalPod:           'Shippeo-predicted arrival at discharge',
  actualDischargePod:            'Actual date container was discharged from vessel',
  estimatedDischargePod:         'Estimated discharge date',
  predictedDischargePod:         'Shippeo-predicted discharge date',
  actualGateOutPod:              'Actual date container left the discharge port',
  estimatedGateOutPod:           'Estimated date container leaves discharge port',
  predictedGateOutPod:           'Shippeo-predicted gate-out at discharge',
  actualEmptyReturn:             'Actual date empty container was returned',
  estimatedEmptyReturn:          'Estimated empty container return date',
  motEmptyReturn:                'Transport mode for empty container return',
  motGateOutPod:                 'Transport mode at discharge port gate-out',
  trackingArrivingVesselImo:        'IMO number of vessel arriving at discharge port',
  trackingArrivingVesselVesselName: 'Name of vessel arriving at discharge port',
  carrierUpdatedLocodePol:       'Loading port UN/LOCODE (always updated)',
  carrierUpdatedLocodePod:       'Discharge port UN/LOCODE (always updated)',
  datetime_timezone:             'Timezone of the event site',
  actualArrivalDestination:      'Actual arrival at final destination',
  estimatedArrivalDestination:   'Estimated arrival at final destination',
  destinationCity:               'City of final delivery destination',
  destinationCountry:            'Country of final delivery destination',
  // TSP fields
  actualArrivalTsp1:             'Actual arrival at transhipment port 1',
  actualArrivalTsp2:             'Actual arrival at transhipment port 2',
  actualArrivalTsp3:             'Actual arrival at transhipment port 3',
  actualArrivalTsp4:             'Actual arrival at transhipment port 4',
  actualDepartureTsp1:           'Actual departure from transhipment port 1',
  actualDepartureTsp2:           'Actual departure from transhipment port 2',
  actualDepartureTsp3:           'Actual departure from transhipment port 3',
  actualDischargeTsp1:           'Actual discharge at transhipment port 1',
  actualDischargeTsp2:           'Actual discharge at transhipment port 2',
  actualDischargeTsp3:           'Actual discharge at transhipment port 3',
  actualLoadTsp1:                'Actual loading at transhipment port 1',
  actualLoadTsp2:                'Actual loading at transhipment port 2',
  actualLoadTsp3:                'Actual loading at transhipment port 3',
  estimatedArrivalTsp1:          'Estimated arrival at transhipment port 1',
  estimatedArrivalTsp2:          'Estimated arrival at transhipment port 2',
  predictedArrivalTsp1:          'Predicted arrival at transhipment port 1',
  predictedArrivalTsp3:          'Predicted arrival at transhipment port 3',
  predictedDischargeTsp3:        'Predicted discharge at transhipment port 3',
  estimatedDepartureTsp2:        'Estimated departure from transhipment port 2',
  predictedDepartureTsp1:        'Predicted departure from transhipment port 1',
  estimatedLoadTsp1:             'Estimated loading at transhipment port 1',
  predictedLoadTsp2:             'Predicted loading at transhipment port 2',
  tsp1Locode:                    'UN/LOCODE of transhipment port 1',
  tsp2Locode:                    'UN/LOCODE of transhipment port 2',
  tsp3Locode:                    'UN/LOCODE of transhipment port 3',
  tsp4Locode:                    'UN/LOCODE of transhipment port 4',
  tsp1Location:                  'City name of transhipment port 1',
  tsp2Location:                  'City name of transhipment port 2',
  tsp3Location:                  'City name of transhipment port 3',
  tsp4Location:                  'City name of transhipment port 4',
  tsp1Country:                   'Country of transhipment port 1',
  tsp2Country:                   'Country of transhipment port 2',
  tsp3Country:                   'Country of transhipment port 3',
  tsp4Country:                   'Country of transhipment port 4',
};

// ─────────────────────────────────────────────────────────────────────────────
//  Test group metadata — human-readable summaries keyed by test ID prefix
// ─────────────────────────────────────────────────────────────────────────────

const GROUP_META = {
  // ── Direct Shipment ────────────────────────────────────────────────────────
  'DS-PC-P': { stage: 'Pre-Carriage', type: 'positive', icon: '🏭', desc: 'Events before the container reaches the loading port' },
  'DS-POL-P':{ stage: 'Port of Loading', type: 'positive', icon: '⚓', desc: 'Events at the loading port (vessel departure)' },
  'DS-POD-P':{ stage: 'Port of Discharge', type: 'positive', icon: '🏁', desc: 'Events at the discharge port (vessel arrival and unloading)' },
  'DS-DEL-P':{ stage: 'Delivery', type: 'positive', icon: '🚚', desc: 'Events at the final delivery destination' },
  'DS-N':    { stage: 'DS Negative', type: 'negative', icon: '🔴', desc: 'Invalid data, wrong place types, auth failures — should NOT write any stage field' },
  'DS-E':    { stage: 'DS Edge Cases', type: 'edge', icon: '⚠️',  desc: 'Date conflicts, vessel corrections, port corrections, UTC timezone conversion' },
  // ── TSP New Flow ───────────────────────────────────────────────────────────
  'NEW-R':   { stage: 'TSP Routing', type: 'positive', icon: '🔀', desc: 'New vs legacy container routing — confirms new flow activated for non-legacy containers' },
  'NEW-P':   { stage: 'TSP New Flow — Positive', type: 'positive', icon: '✅', desc: 'Slot assignment (REUSE + CLAIM), all 4 events, estimated/predicted, slot 2 scenarios' },
  'NEW-V':   { stage: 'TSP Vessel Logic', type: 'positive', icon: '🚢', desc: 'Vessel at N (non-increment) and N+1 (increment), null vessel, missing resources' },
  'NEW-TZ':  { stage: 'TSP Timezone Conversion', type: 'positive', icon: '🕐', desc: 'UTC → local time using event_site.timezone, DST handling, datetime_timezone not stored' },
  'NEW-N':   { stage: 'TSP New Flow — Negative', type: 'negative', icon: '🔴', desc: 'Wrong place_type, actual+data_source rules, null fields, slots full, auth failures' },
  'NEW-E':   { stage: 'TSP New Flow — Edge Cases', type: 'edge', icon: '⚠️',  desc: 'Date conflict (later wins), field independence, vessel substitution fix, slot isolation' },
  'NEW-X':   { stage: 'TSP Old Flow Contamination', type: 'edge', icon: '🛡',  desc: 'Confirms new flow logic does NOT contaminate with old flow behaviour' },
  'TSP-BUG': { stage: 'TSP Known Bug', type: 'negative', icon: '🐛', desc: 'Known bug — multi-slot second locode not yet fixed (branch DP-449)' },
  // ── TSP Old Flow ───────────────────────────────────────────────────────────
  'OLD-R':   { stage: 'Old Flow — Routing', type: 'positive', icon: '📦', desc: 'Legacy containers (MSCU1234567) routed to old flow — vessel at N, no N+1' },
  'OLD-P':   { stage: 'Old Flow — Positive', type: 'positive', icon: '📦', desc: 'Old flow positive scenarios — vessel-based slot key, no N+1 increment' },
  'OLD-BUG': { stage: 'Old Flow — Bug Baseline', type: 'negative', icon: '🐛', desc: 'Documents known broken behaviour in old flow (duplicate locode from vessel substitution)' },
  'OLD-N':   { stage: 'Old Flow — Negative', type: 'negative', icon: '🔴', desc: 'Old flow negative tests — wrong place_type, expired token, empty body' },
};

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getTestIdPrefix(title) {
  const m = title.match(/^(DS-PC-P|DS-POL-P|DS-POD-P|DS-DEL-P|DS-N|DS-E|NEW-TZ|NEW-BUG|NEW-R|NEW-P|NEW-V|NEW-N|NEW-E|NEW-X|OLD-BUG|OLD-R|OLD-P|OLD-N|TSP-BUG|TSP-P|TSP-N|TSP-E)/);
  return m ? m[1] : null;
}

function getTestId(title) {
  const m = title.match(/^((?:DS|TSP|NEW|OLD)-[A-Z0-9]+-?[A-Za-z0-9]*(?:-[A-Za-z0-9]+)?)\b/);
  return m ? m[1] : null;
}

function extractFieldName(title) {
  // "DS-POD-P-01 | container_arrived actual → actualArrivalPod"
  // "TSP-P-01 | actualArrivalTsp1 written"
  const m = title.match(/\|\s*(.+)$/);
  return m ? m[1].trim() : title;
}

function describeField(name) {
  // Extract Logward field names from assertion descriptions
  const fields = Object.keys(FIELD_DESCRIPTIONS).filter(f => name.includes(f));
  if (fields.length > 0) {
    return fields.map(f => `<span class="field-tag">${f}</span> — ${FIELD_DESCRIPTIONS[f]}`).join('<br>');
  }
  return name;
}

function parseError(error) {
  if (!error) return null;
  const msg = error.message || '';
  // Extract "Expected: X, Received: Y" from Playwright errors
  const expected = msg.match(/Expected[:\s]+(.+?)(?:\n|Received)/s);
  const received = msg.match(/Received[:\s]+(.+?)(?:\n|$)/s);
  return {
    summary: msg.split('\n')[0].replace(/\[[0-9;]*m/g, '').trim(),
    expected: expected ? expected[1].trim().replace(/\[[0-9;]*m/g, '') : null,
    received: received ? received[1].trim().replace(/\[[0-9;]*m/g, '') : null,
  };
}

function statusIcon(status) {
  return { passed: '✅', failed: '❌', skipped: '⏭', timedOut: '⏱' }[status] || '❓';
}

function statusClass(status) {
  return { passed: 'pass', failed: 'fail', skipped: 'skip', timedOut: 'timeout' }[status] || 'pending';
}

// ─────────────────────────────────────────────────────────────────────────────
//  Playwright Reporter Class
// ─────────────────────────────────────────────────────────────────────────────

class EventsOutReporter {
  constructor(options = {}) {
    this._outputFile = options.outputFile || null;
    this._suites     = [];   // collected suite results
    this._tests      = [];   // flat list of all test results
    this._startTime  = Date.now();
  }

  onBegin(config, suite) {
    this._rootSuite = suite;
  }

  onTestEnd(test, result) {
    // Only capture OceanEventsOut tests
    const file = test.location?.file || '';
    if (!file.includes('OceanEventsOut')) return;

    const titles = test.titlePath();
    const fullTitle = titles.join(' › ');
    const leafTitle = titles[titles.length - 1] || '';

    this._tests.push({
      id:        getTestId(leafTitle),
      prefix:    getTestIdPrefix(leafTitle),
      fullTitle,
      leafTitle,
      assertion: extractFieldName(leafTitle),
      status:    result.status,
      duration:  result.duration,
      error:     result.error ? parseError(result.error) : null,
      suites:    titles.slice(0, -1),
    });
  }

  onEnd(result) {
    const dest = this._outputFile
      ? path.resolve(this._outputFile)
      : path.resolve(
          process.env.PLAYWRIGHT_RUN_DIR || 'playwright-report/runs/latest',
          'ocean', 'events-out-report.html'
        );

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buildHtml(this._tests, result, Date.now() - this._startTime), 'utf8');
    console.log(`\n  📊 Events-Out Report → ${dest}\n`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  HTML builder
// ─────────────────────────────────────────────────────────────────────────────

function buildHtml(tests, runResult, durationMs) {
  const now      = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const passed   = tests.filter(t => t.status === 'passed').length;
  const failed   = tests.filter(t => t.status === 'failed').length;
  const skipped  = tests.filter(t => t.status === 'skipped').length;
  const total    = tests.length;
  const duration = (durationMs / 1000).toFixed(1);

  // Group by prefix category
  const groups = {};
  for (const t of tests) {
    const key = t.prefix || 'OTHER';
    if (!groups[key]) groups[key] = [];
    groups[key].push(t);
  }

  // Sub-group within each category by test ID
  function groupById(tests) {
    const byId = {};
    for (const t of tests) {
      const id = t.id || 'other';
      if (!byId[id]) byId[id] = [];
      byId[id].push(t);
    }
    return byId;
  }

  function renderTestGroup(id, tests) {
    const allPass  = tests.every(t => t.status === 'passed');
    const anyFail  = tests.some(t => t.status === 'failed');
    const anySkip  = tests.some(t => t.status === 'skipped');
    const cls      = anyFail ? 'fail' : (anySkip && !allPass ? 'partial' : 'pass');

    // Get the parent describe title (one level up from the leaf tests)
    const groupDesc = tests[0]?.suites?.slice(-1)[0] || id || '';

    const assertionRows = tests.map(t => {
      const err    = t.error;
      const errHtml = err ? `
        <div class="error-block">
          <div class="error-summary">${err.summary}</div>
          ${err.expected ? `<div class="error-row"><span class="err-label">Expected:</span> <code>${err.expected}</code></div>` : ''}
          ${err.received ? `<div class="error-row"><span class="err-label">Received:</span> <code class="err-received">${err.received}</code></div>` : ''}
        </div>` : '';

      return `
        <tr class="assertion-row ${statusClass(t.status)}">
          <td class="ico-cell">${statusIcon(t.status)}</td>
          <td class="assertion-text">${describeField(t.assertion)}</td>
          <td class="status-cell"><span class="badge ${statusClass(t.status)}">${t.status.toUpperCase()}</span></td>
        </tr>
        ${err ? `<tr class="error-row-tr"><td colspan="3">${errHtml}</td></tr>` : ''}`;
    }).join('');

    return `
    <div class="test-group ${cls}">
      <div class="test-group-header">
        <span class="group-id">${id || '—'}</span>
        <span class="group-desc">${groupDesc}</span>
        <span class="group-status ${cls}">${anyFail ? '❌ FAILED' : (anySkip && !allPass ? '⏭ PARTIAL' : '✅ PASSED')}</span>
      </div>
      <table class="assertions-table">
        <thead>
          <tr><th>Status</th><th>What was checked</th><th></th></tr>
        </thead>
        <tbody>${assertionRows}</tbody>
      </table>
    </div>`;
  }

  function renderCategory(prefix, tests) {
    const meta     = GROUP_META[prefix] || { stage: prefix, type: 'other', icon: '🔹', desc: '' };
    const byId     = groupById(tests);
    const catPass  = tests.filter(t => t.status === 'passed').length;
    const catFail  = tests.filter(t => t.status === 'failed').length;
    const catSkip  = tests.filter(t => t.status === 'skipped').length;
    const catCls   = catFail > 0 ? 'fail' : (catSkip > 0 && catPass < tests.length ? 'partial' : 'pass');

    const groups = Object.entries(byId)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, ts]) => renderTestGroup(id, ts))
      .join('');

    return `
  <section class="category ${catCls}" id="cat-${prefix.replace(/[^a-zA-Z0-9]/g, '-')}">
    <div class="category-header">
      <div class="cat-title">
        <span class="cat-icon">${meta.icon}</span>
        <span class="cat-stage">${meta.stage}</span>
        <span class="cat-desc">${meta.desc}</span>
      </div>
      <div class="cat-stats">
        <span class="stat pass">${catPass} passed</span>
        ${catFail ? `<span class="stat fail">${catFail} failed</span>` : ''}
        ${catSkip ? `<span class="stat skip">${catSkip} skipped</span>` : ''}
        <span class="stat total">${tests.length} total</span>
      </div>
    </div>
    <div class="category-body">${groups}</div>
  </section>`;
  }

  // Order categories sensibly
  const ORDER = [
    // Direct Shipment
    'DS-PC-P','DS-POL-P','DS-POD-P','DS-DEL-P','DS-N','DS-E',
    // TSP New Flow
    'NEW-R','NEW-P','NEW-V','NEW-TZ','NEW-N','NEW-E','NEW-X','TSP-BUG',
    // TSP Old Flow
    'OLD-R','OLD-P','OLD-BUG','OLD-N',
    // Legacy TSP (old spec fallback)
    'TSP-P','TSP-N','TSP-E',
    'OTHER',
  ];
  const categorySections = ORDER
    .filter(p => groups[p])
    .map(p => renderCategory(p, groups[p]))
    .join('\n');

  // Navigation sidebar
  const navItems = ORDER.filter(p => groups[p]).map(p => {
    const meta = GROUP_META[p] || { icon: '🔹', stage: p };
    const g    = groups[p];
    const fail = g.filter(t => t.status === 'failed').length;
    return `<a href="#cat-${p.replace(/[^a-zA-Z0-9]/g, '-')}" class="nav-item ${fail ? 'nav-fail' : 'nav-pass'}">
      <span>${meta.icon}</span>
      <span class="nav-label">${meta.stage}</span>
      <span class="nav-count ${fail ? 'fail' : 'pass'}">${g.length}</span>
    </a>`;
  }).join('');

  const overallClass = failed > 0 ? 'fail' : 'ok';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Ocean Events-Out Mapping Report — ${now}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f2f5;color:#1a1a2e;font-size:13px;display:flex;flex-direction:column;min-height:100vh;}

    /* ── Header ── */
    .hdr{background:linear-gradient(135deg,#1a1a2e,#0f3460);color:#fff;padding:24px 32px;}
    .hdr h1{font-size:1.5rem;font-weight:700;}
    .hdr .sub{color:#a0aec0;margin-top:4px;font-size:.85rem;}
    .hdr .stats{display:flex;gap:24px;margin-top:16px;flex-wrap:wrap;}
    .hdr .stat-item strong{display:block;font-size:1.1rem;}
    .hdr .stat-item{font-size:.78rem;color:#cbd5e0;}
    .hdr .stat-item.pass strong{color:#9ae6b4;}
    .hdr .stat-item.fail strong{color:#fc8181;}
    .hdr .stat-item.skip strong{color:#f6ad55;}

    /* ── Overall banner ── */
    .banner{margin:16px 32px;padding:12px 20px;border-radius:8px;font-weight:600;font-size:.95rem;display:flex;align-items:center;gap:10px;}
    .banner.ok{background:#f0fff4;border:1.5px solid #68d391;color:#276749;}
    .banner.fail{background:#fff5f5;border:1.5px solid #fc8181;color:#9b2335;}

    /* ── Explanation box ── */
    .explainer{margin:0 32px 16px;padding:14px 18px;background:#fff;border-radius:8px;border-left:4px solid #4299e1;font-size:.82rem;color:#4a5568;line-height:1.6;}
    .explainer strong{color:#2d3748;}

    /* ── Layout ── */
    .layout{display:flex;flex:1;gap:0;}
    .sidebar{width:220px;min-width:220px;background:#fff;border-right:1px solid #e2e8f0;padding:16px 0;position:sticky;top:0;height:calc(100vh - 220px);overflow-y:auto;}
    .sidebar h3{font-size:.72rem;text-transform:uppercase;color:#a0aec0;letter-spacing:.08em;padding:0 16px;margin-bottom:8px;}
    .nav-item{display:flex;align-items:center;gap:8px;padding:8px 16px;text-decoration:none;color:#4a5568;font-size:.8rem;border-left:3px solid transparent;transition:all .15s;}
    .nav-item:hover{background:#f7fafc;color:#2d3748;}
    .nav-item.nav-fail{border-left-color:#fc8181;}
    .nav-item.nav-pass{border-left-color:#68d391;}
    .nav-label{flex:1;}
    .nav-count{font-size:.72rem;padding:1px 6px;border-radius:10px;font-weight:600;}
    .nav-count.pass{background:#c6f6d5;color:#22543d;}
    .nav-count.fail{background:#fed7d7;color:#9b2335;}

    /* ── Main content ── */
    .main{flex:1;padding:0 24px 32px;overflow-x:hidden;}

    /* ── Category ── */
    .category{margin-top:24px;}
    .category-header{background:#fff;border-radius:8px 8px 0 0;border:1px solid #e2e8f0;padding:14px 18px;display:flex;justify-content:space-between;align-items:flex-start;gap:12px;}
    .category.fail .category-header{border-left:4px solid #fc8181;}
    .category.pass .category-header{border-left:4px solid #68d391;}
    .category.partial .category-header{border-left:4px solid #f6ad55;}
    .cat-title{display:flex;align-items:center;gap:10px;flex:1;}
    .cat-icon{font-size:1.2rem;}
    .cat-stage{font-weight:700;font-size:.9rem;}
    .cat-desc{color:#718096;font-size:.8rem;}
    .cat-stats{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
    .stat{font-size:.75rem;padding:2px 8px;border-radius:10px;font-weight:600;white-space:nowrap;}
    .stat.pass{background:#c6f6d5;color:#22543d;}
    .stat.fail{background:#fed7d7;color:#9b2335;}
    .stat.skip{background:#fefcbf;color:#744210;}
    .stat.total{background:#e2e8f0;color:#4a5568;}
    .category-body{border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px;background:#f7fafc;padding:12px;display:flex;flex-direction:column;gap:10px;}

    /* ── Test group ── */
    .test-group{background:#fff;border-radius:8px;border:1px solid #e2e8f0;overflow:hidden;}
    .test-group.pass{border-left:3px solid #68d391;}
    .test-group.fail{border-left:3px solid #fc8181;}
    .test-group.partial{border-left:3px solid #f6ad55;}
    .test-group-header{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #f7fafc;background:#fafafa;}
    .group-id{font-weight:700;font-size:.78rem;background:#edf2f7;padding:2px 8px;border-radius:4px;white-space:nowrap;color:#2d3748;}
    .group-desc{flex:1;font-size:.8rem;color:#4a5568;}
    .group-status{font-size:.75rem;font-weight:700;white-space:nowrap;}
    .group-status.pass{color:#22543d;}
    .group-status.fail{color:#e53e3e;}
    .group-status.partial{color:#744210;}

    /* ── Assertions table ── */
    .assertions-table{width:100%;border-collapse:collapse;}
    .assertions-table thead tr{background:#f7fafc;}
    .assertions-table th{padding:6px 14px;text-align:left;font-size:.72rem;text-transform:uppercase;color:#a0aec0;letter-spacing:.05em;border-bottom:1px solid #e2e8f0;}
    .assertion-row td{padding:8px 14px;border-bottom:1px solid #f7fafc;vertical-align:top;}
    .assertion-row:last-child td{border-bottom:none;}
    .assertion-row.fail td{background:#fff5f5;}
    .assertion-row.skip td{opacity:.6;}
    .ico-cell{width:30px;text-align:center;font-size:.9rem;}
    .assertion-text{font-size:.8rem;line-height:1.5;}
    .status-cell{width:90px;text-align:right;}
    .field-tag{font-family:monospace;background:#ebf4ff;color:#2b6cb0;padding:1px 5px;border-radius:3px;font-size:.78rem;font-weight:600;}
    .badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:.7rem;font-weight:700;}
    .badge.pass{background:#c6f6d5;color:#22543d;}
    .badge.fail{background:#fed7d7;color:#9b2335;}
    .badge.skip{background:#e9d8fd;color:#553c9a;}
    .badge.timeout{background:#fefcbf;color:#744210;}

    /* ── Error block ── */
    .error-block{background:#fff5f5;border:1px solid #fed7d7;border-radius:4px;padding:8px 12px;font-size:.78rem;margin:0 14px 8px;}
    .error-summary{color:#9b2335;font-weight:600;margin-bottom:4px;}
    .error-row{margin-top:3px;display:flex;gap:8px;align-items:flex-start;}
    .err-label{font-weight:600;color:#718096;white-space:nowrap;min-width:70px;}
    code{font-family:monospace;background:#f7fafc;padding:1px 4px;border-radius:3px;font-size:.78rem;}
    .err-received{background:#fff5f5;color:#e53e3e;}
    .error-row-tr td{padding:0;}

    /* ── Footer ── */
    .footer{text-align:center;padding:16px;font-size:.75rem;color:#a0aec0;border-top:1px solid #e2e8f0;background:#fff;}
  </style>
</head>
<body>

<div class="hdr">
  <h1>🌊 Ocean Events-Out — Field Mapping Report</h1>
  <p class="sub">Verifies every Shippeo webhook event is correctly mapped to the right Logward field</p>
  <div class="stats">
    <div class="stat-item"><strong>${total}</strong>Total Tests</div>
    <div class="stat-item pass"><strong>${passed}</strong>Passed</div>
    <div class="stat-item fail"><strong>${failed}</strong>Failed</div>
    <div class="stat-item skip"><strong>${skipped}</strong>Skipped</div>
    <div class="stat-item"><strong>${duration}s</strong>Duration</div>
    <div class="stat-item"><strong>${now}</strong>Run At</div>
  </div>
</div>

<div class="banner ${overallClass}">
  <span>${failed === 0 ? '✅' : '❌'}</span>
  <span>${failed === 0
    ? `All ${passed} field mapping assertions passed`
    : `${failed} mapping assertion${failed > 1 ? 's' : ''} failed — see details below`
  }</span>
</div>

<div class="explainer">
  <strong>How to read this report:</strong><br>
  Each card represents one test scenario (e.g. "When Shippeo sends a container arrival event at the Port of Discharge").
  Inside each card, every row is a specific assertion — a check that a particular Logward field was correctly populated.
  <strong>✅ Green</strong> = field was set correctly.
  <strong>❌ Red</strong> = field had the wrong value or was missing (click to see expected vs received).
  <strong>⏭ Grey</strong> = test was skipped (usually because a prior gate test failed).
</div>

<div class="layout">
  <nav class="sidebar">
    <h3>Sections</h3>
    ${navItems}
  </nav>
  <main class="main">
    ${categorySections}
  </main>
</div>

<div class="footer">Logward QA Automation — Ocean Events-Out Mapping Report · ${now}</div>

</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Export as Playwright reporter
// ─────────────────────────────────────────────────────────────────────────────

module.exports = EventsOutReporter;
