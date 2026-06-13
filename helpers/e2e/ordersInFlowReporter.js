// ─────────────────────────────────────────────────────────────────────────────
//  helpers/e2e/ordersInFlowReporter.js
//
//  Generates a step-by-step HTML report for OceanOrdersIn tests.
//  Shows the full gated flow per scenario — readable by anyone.
//
//  Usage:
//    const R = require('./helpers/e2e/ordersInFlowReporter');
//    R.startScenario('S-01', 'BN+BL+CN+SCAC+InProgress', 'GROUP P', 'positive', fields);
//    R.step('S-01', 'create',    { status:'pass', objectCode, containerNumber, ... });
//    R.step('S-01', 'scheduler', { status:'pass', active:1, valid:1 });
//    R.step('S-01', 'mongodb',   { status:'pass', found:true, uniqueReference, ... });
//    R.step('S-01', 'shippeo',   { status:'pass', found:true, organisation, ... });
//    R.step('S-01', 'events',    { status:'pass', fields:{...} });
//    R.generateReport('playwright-report/runs/.../ocean/ordersIn-flow-report.html');
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');

const _scenarios = new Map();   // id → scenarioData

// ─────────────────────────────────────────────────────────────────────────────

function startScenario(id, name, group, type, fields) {
  _scenarios.set(id, {
    id, name, group, type,
    fields,             // what was created (bookingNumber, blNumber, etc.)
    steps:  {},         // step → data
    status: 'pending',
    stoppedAt: null,
  });
}

function step(id, stepName, data) {
  const s = _scenarios.get(id);
  if (!s) return;
  s.steps[stepName] = data;
  if (data.status === 'fail') {
    s.status    = 'failed';
    s.stoppedAt = s.stoppedAt || stepName;
  } else {
    s.status = resolveStatus(s);
  }
}

// Determine the true overall status of a scenario.
//   passed  — all expected steps ran and passed
//   failed  — at least one step failed
//   partial — some steps ran/passed but not all expected ones completed
//   skipped — all executed steps were skipped (e.g. SHIPPEO_ENABLED=false)
//   pending — no steps have run yet
function resolveStatus(s) {
  if (s.status === 'failed') return 'failed';
  const st = s.steps;
  const stepValues = Object.values(st);

  // All recorded steps are 'skip' → scenario was skipped
  if (stepValues.length > 0 && stepValues.every(d => d.status === 'skip')) return 'skipped';

  if (s.type === 'positive') {
    const allFive = ['create','scheduler','mongodb','shippeo','events']
      .every(k => st[k]?.status === 'pass');
    if (allFive) return 'passed';
    // Any step skipped while others passed → partial
    const anySkipped = stepValues.some(d => d.status === 'skip');
    if (anySkipped && stepValues.some(d => d.status === 'pass')) return 'partial';
    // Steps ran but not all 5 reached → partial
    if (st.create || st.scheduler || st.mongodb) return 'partial';
    return 'pending';
  }
  // negative / update — passed once their required steps pass
  if (st.create?.status === 'pass' || st.scheduler?.status === 'pass') return 'passed';
  return 'pending';
}

// ─────────────────────────────────────────────────────────────────────────────

function ico(status) {
  if (status === 'pass')    return '<span class="ico pass">✅</span>';
  if (status === 'fail')    return '<span class="ico fail">❌</span>';
  if (status === 'skip')    return '<span class="ico skip">⏭</span>';
  if (status === 'stop')    return '<span class="ico stop">⛔</span>';
  return '<span class="ico pending">⏳</span>';
}

function badge(status) {
  const map = { passed:'pass', failed:'fail', pending:'pending', partial:'warn', skipped:'skip' };
  const cls = map[status] || 'pending';
  const lbl = status.toUpperCase();
  return `<span class="badge ${cls}">${lbl}</span>`;
}

function row(label, value, extra='') {
  if (value === null || value === undefined || value === '') return '';
  return `<tr><td class="lbl">${label}</td><td>${value}${extra ? ` <span class="note">${extra}</span>` : ''}</td></tr>`;
}

function stepCard(icon, title, cls, content) {
  return `
    <div class="step-card ${cls}">
      <div class="step-title">${icon} ${title}</div>
      <div class="step-body">${content}</div>
    </div>`;
}

function arrow(active) {
  return `<div class="arrow ${active ? '' : 'dim'}">→</div>`;
}

// ─────────────────────────────────────────────────────────────────────────────

function renderScenario(s) {
  const overall = s.status === 'passed' ? 'pass' : s.status === 'failed' ? 'fail' : 'pending';

  // ── CREATE step ────────────────────────────────────────────────────────────
  const cr = s.steps.create || {};
  const createContent = `<table>
    ${row('Object Code',    cr.objectCode,      'Logward internal ID')}
    ${row('Container No.',  cr.containerNumber)}
    ${row('Booking No.',    cr.bookingNumber  || '—')}
    ${row('Bill of Lading', cr.blNumber       || '—')}
    ${row('SCAC',           cr.scac           || '—')}
    ${row('Status',         cr.trackingStatus || '—')}
    ${row('HTTP Response',  cr.httpStatus ? cr.httpStatus + ' OK' : null)}
  </table>`;
  const createCard = stepCard(ico(cr.status || 'pending'), '1. Create OTU', cr.status || 'pending', createContent);

  // ── SCHEDULER step (positive/negative: single check; update: before + after) ─
  const isUpdate = s.type === 'update';
  const scBefore = s.steps.scheduler_before || {};
  const scAfter  = s.steps.scheduler_after  || {};
  const sc       = isUpdate ? scAfter : (s.steps.scheduler || {});

  function schedulerContent(rec, stoppedLabel) {
    if (!rec.status) return `<span class="dim">${stoppedLabel || 'Not reached'}</span>`;
    const content = `<table>
      ${row('active', rec.active,
        rec.active === 1 ? '✅ ATC conditions satisfied' : '❌ ATC conditions NOT met')}
      ${row('valid',  rec.valid,
        rec.valid  === 1 ? '✅ All required tracking fields present' : '❌ Required fields missing')}
    </table>`;
    if (rec.active !== 1 || rec.valid !== 1) {
      return content + `<div class="stop-banner">⛔ FLOW STOPPED — No Shippeo order will be created</div>`;
    }
    return content;
  }

  // For update scenarios: show before-update scheduler card
  let schBeforeCard = null;
  if (isUpdate) {
    const beforeStatus = scBefore.status || 'pending';
    schBeforeCard = stepCard(ico(beforeStatus), '2. Scheduler (before update)', beforeStatus,
      schedulerContent(scBefore, 'Not reached'));
  }

  // Main scheduler card (after update for update type, only check for others)
  const schContent  = schedulerContent(sc, s.stoppedAt && s.stoppedAt !== 'scheduler' ? 'Flow stopped at scheduler' : 'Not reached');
  const schStatus   = sc.status || (s.stoppedAt && s.stoppedAt !== 'scheduler' ? 'skip' : 'pending');
  const schCardNum  = isUpdate ? '4. Scheduler (after update)' : '2. Scheduler Check';
  const schCard     = stepCard(ico(schStatus), schCardNum, schStatus, schContent);

  // ── UPDATE step (only for 'update' type scenarios) ─────────────────────────
  const up = s.steps.update || {};
  let upCard = null;
  if (s.type === 'update') {
    let upContent = '';
    if (up.status) {
      const fields = up.fields || {};
      const fieldRows = Object.entries(fields)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => row(k, String(v), '→ field added/updated'))
        .join('');
      upContent = `<table>${fieldRows || row('fields', '(no changes recorded)', '')}</table>`;
    } else {
      upContent = '<span class="dim">Not reached</span>';
    }
    const upStatus = up.status || (s.stoppedAt ? 'skip' : 'pending');
    upCard = stepCard(ico(upStatus), '3. OTU Update', upStatus, upContent);
  }

  // ── MONGODB step ───────────────────────────────────────────────────────────
  const mg = s.steps.mongodb || {};
  let mgContent = '';
  if (mg.status) {
    if (mg.found === false) {
      mgContent = `<div class="stop-banner">⛔ No MongoDB document — Shippeo order was NOT created</div>`;
    } else {
      mgContent = `<table>
        ${row('Document found',    'Yes',          '✅')}
        ${row('error field',       'false',        '✅ Shippeo order created successfully')}
        ${row('containerId',       mg.containerId)}
        ${row('uniqueReference',   mg.uniqueReference, 'Format: bookingId_containerId or blId_containerId')}
        ${row('serviceProvider',   mg.serviceProvider)}
        ${row('identifier',        mg.identifier,  'Which field Shippeo uses as primary key')}
        ${row('events at creation', mg.eventsCount != null ? String(mg.eventsCount) : null, 'Should be 0 — no events received yet')}
      </table>`;
    }
  } else {
    const reason = s.stoppedAt === 'scheduler' ? 'Flow stopped at scheduler — not checked (correct)' : 'Not reached';
    mgContent = `<span class="dim">${reason}</span>`;
  }
  const mgStatus = mg.status || (s.stoppedAt ? 'skip' : 'pending');
  const mgCardNum = s.type === 'update' ? '4.' : '3.';
  const mgCard = stepCard(ico(mgStatus), `${mgCardNum} MongoDB Check`, mgStatus, mgContent);

  // ── SHIPPEO step ───────────────────────────────────────────────────────────
  const sh = s.steps.shippeo || {};
  let shContent = '';
  if (sh.status === 'skip') {
    shContent = '<span class="dim">Skipped — Shippeo token not set</span>';
  } else if (sh.status) {
    if (!sh.found) {
      shContent = `<div class="stop-banner">⛔ Shipment NOT found in Shippeo</div>`;
    } else {
      // ── Search result fields ───────────────────────────────────────────────
      shContent = `<table>
        ${row('Shipment found',   'Yes',          '✅')}
        ${row('Order ID',         sh.orderId)}
        ${row('Reference',        sh.reference)}
        ${row('Organisation',     sh.organisation)}
        ${row('Agency',           sh.agency)}
        ${row('Transport Mode',   sh.transportMode)}
      </table>`;

      // ── Details validation table ───────────────────────────────────────────
      if (sh.detailsRows && sh.detailsRows.length) {
        const allPass = sh.detailsPass !== false;
        shContent += `
        <div style="margin-top:8px;font-weight:700;font-size:.75rem;color:#4a5568;">
          Order Details Validation ${allPass ? '✅' : '❌'}
        </div>
        <table style="margin-top:4px;">
          ${sh.detailsRows.map(r => {
            if (r.skipped) {
              return `<tr>
                <td class="lbl" style="color:#a0aec0">${r.label}</td>
                <td style="color:#a0aec0;font-style:italic">skipped — ${r.skipReason}</td>
              </tr>`;
            }
            const icon = r.pass ? '✅' : '❌';
            const valColor = r.pass ? '' : 'color:#e53e3e;font-weight:600';
            return `<tr>
              <td class="lbl">${r.label}</td>
              <td style="${valColor}">${icon} ${r.actual || '—'}</td>
            </tr>`;
          }).join('')}
        </table>`;
      }
    }
  } else {
    const reason = s.stoppedAt ? 'Flow stopped earlier — not checked (correct)' : 'Not reached';
    shContent = `<span class="dim">${reason}</span>`;
  }
  const shStatus = sh.status || (s.stoppedAt ? 'skip' : 'pending');
  const shCardNum = s.type === 'update' ? '5.' : '4.';
  const shCard = stepCard(ico(shStatus), `${shCardNum} Shippeo Check`, shStatus, shContent);

  // ── EVENTS step ────────────────────────────────────────────────────────────
  const ev = s.steps.events || {};
  let evContent = '';
  if (ev.status === 'skip') {
    evContent = '<span class="dim">Skipped — webhook not configured</span>';
  } else if (ev.status) {
    const f = ev.fields || {};
    evContent = `<table>
      ${row('Event 1 — Pre-Carriage',  f.actualGateOutEmptyDepot,  'container_gate_out_empty → actualGateOutEmptyDepot')}
      ${row('Event 2 — POL Departure', f.actualDeparturePol,       'container_departed → actualDeparturePol')}
      ${row('Event 3 — POD Arrival',   f.actualArrivalPod,         'container_arrived (discharge) → actualArrivalPod')}
      ${row('Event 4 — Delivery',      f.actualArrivalDestination, 'container_arrived (destination) → actualArrivalDestination')}
    </table>`;
    if (ev.status === 'fail') {
      evContent += `<div class="stop-banner">❌ One or more fields not populated after events</div>`;
    }
  } else {
    const reason = s.stoppedAt ? 'Flow stopped earlier — events not sent (correct)' : 'Not reached';
    evContent = `<span class="dim">${reason}</span>`;
  }
  const evStatus = ev.status || (s.stoppedAt ? 'skip' : 'pending');
  const evCardNum = s.type === 'update' ? '6.' : '5.';
  const evCard = stepCard(ico(evStatus), `${evCardNum} Events → OTU Fields`, evStatus, evContent);

  // ── Assemble ───────────────────────────────────────────────────────────────
  const typeLabel = { positive:'Full Flow', negative:'Negative', update:'Update Flow' }[s.type] || s.type;
  const a1 = isUpdate
    ? (scAfter.status && scAfter.active === 1 && scAfter.valid === 1)
    : (s.steps.scheduler && (sc.active === 1 && sc.valid === 1));
  const a2 = a1 && s.steps.mongodb?.found;
  const a3 = a2 && s.steps.shippeo?.found;

  // Re-resolve status so CSS class reflects partial/skipped correctly
  const derivedStatus = resolveStatus(s);
  const cssClass = { passed:'pass', failed:'fail', partial:'partial', skipped:'skipped', pending:'pending' }[derivedStatus] || 'pending';

  return `
  <div class="scenario ${cssClass}">
    <div class="scenario-header">
      <div class="scenario-meta">
        <span class="sid">${s.id}</span>
        <span class="stype ${s.type}">${typeLabel}</span>
        <span class="sgroup">${s.group}</span>
      </div>
      <div class="sname">${s.name}</div>
      ${badge(derivedStatus)}
    </div>
    <div class="flow-row">
      ${createCard}
      ${isUpdate
        ? `${arrow(!!scBefore.status)}${schBeforeCard}${arrow(!!s.steps.update)}${upCard}${arrow(a1)}${schCard}`
        : `${arrow(!!sc.status)}${schCard}`
      }
      ${arrow(a1 || isUpdate)}
      ${mgCard}
      ${arrow(a2)}
      ${shCard}
      ${arrow(a3)}
      ${evCard}
    </div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────

function buildHtml(meta) {
  const all      = [..._scenarios.values()];
  const passed   = all.filter(s => s.status === 'passed').length;
  const failed   = all.filter(s => s.status === 'failed').length;
  const partial  = all.filter(s => s.status === 'partial').length;
  const skipped  = all.filter(s => s.status === 'skipped').length;
  const total    = all.length;
  const overallOk = failed === 0 && partial === 0;

  const groups = ['GROUP P', 'GROUP U', 'GROUP N1', 'GROUP N2', 'GROUP S', 'GROUP A'];
  const sections = groups.map(g => {
    const gScenarios = all.filter(s => s.group === g);
    if (!gScenarios.length) return '';
    const gPass    = gScenarios.filter(s => s.status === 'passed').length;
    const gFail    = gScenarios.filter(s => s.status === 'failed').length;
    const gPartial = gScenarios.filter(s => s.status === 'partial').length;
    const gSkipped = gScenarios.filter(s => s.status === 'skipped').length;
    const gLabel = {
      'GROUP P':  '🟢 Full Positive Flow (S-01 to S-03)',
      'GROUP U':  '🔄 Update Scenarios (S-18 to S-23)',
      'GROUP N1': '🔴 active=0 valid=0 — Flow stops at Scheduler (S-04 to S-09)',
      'GROUP N2': '🟡 active=1 valid=0 — Flow stops at Scheduler (S-07 to S-17)',
      'GROUP S':  '🚢 Shippeo Standalone (S-36, S-37)',
      'GROUP A':  '🔒 API & Auth Negative (S-38 to S-43)',
    }[g] || g;
    const countParts = [
      gPass    ? `${gPass} passed`    : '',
      gFail    ? `${gFail} failed`    : '',
      gPartial ? `${gPartial} partial`: '',
      gSkipped ? `${gSkipped} skipped`: '',
    ].filter(Boolean).join(' · ') + ` · ${gScenarios.length} total`;
    return `
      <div class="group-section">
        <div class="group-header">
          <span class="group-label">${gLabel}</span>
          <span class="group-counts">${countParts}</span>
        </div>
        ${gScenarios.map(renderScenario).join('\n')}
      </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Ocean Orders-In Flow Report — ${meta.generatedAt}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f2f5;color:#1a1a2e;font-size:13px;}

    /* ── Header ── */
    .hdr{background:linear-gradient(135deg,#1a1a2e,#0f3460);color:#fff;padding:28px 40px;}
    .hdr h1{font-size:1.6rem;font-weight:700;}
    .hdr .sub{color:#a0aec0;margin-top:4px;font-size:.85rem;}
    .hdr .meta{display:flex;gap:32px;margin-top:16px;flex-wrap:wrap;}
    .hdr .meta-item strong{display:block;font-size:.9rem;}
    .hdr .meta-item{font-size:.78rem;color:#cbd5e0;}

    /* ── Overall banner ── */
    .overall{margin:20px 40px 0;padding:14px 20px;border-radius:8px;font-weight:600;display:flex;align-items:center;gap:10px;font-size:.95rem;}
    .overall.ok{background:#f0fff4;border:1.5px solid #68d391;color:#276749;}
    .overall.fail{background:#fff5f5;border:1.5px solid #fc8181;color:#9b2335;}

    /* ── Group sections ── */
    .group-section{margin:20px 40px 0;}
    .group-header{background:#fff;border-radius:8px 8px 0 0;border:1px solid #e2e8f0;padding:12px 18px;display:flex;justify-content:space-between;align-items:center;}
    .group-label{font-weight:700;font-size:.9rem;}
    .group-counts{font-size:.8rem;color:#718096;}

    /* ── Scenario card ── */
    .scenario{background:#fff;border:1px solid #e2e8f0;border-top:none;padding:16px 18px;overflow:hidden;}
    .scenario:last-child{border-radius:0 0 8px 8px;margin-bottom:20px;}
    .scenario.pass{border-left:3px solid #68d391;}
    .scenario.fail{border-left:3px solid #fc8181;}
    .scenario.partial{border-left:3px solid #f6ad55;}
    .scenario.skipped{border-left:3px solid #b794f4;}
    .scenario.pending{border-left:3px solid #a0aec0;}

    .scenario-header{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap;}
    .sid{font-weight:700;font-size:.85rem;background:#edf2f7;padding:2px 8px;border-radius:4px;white-space:nowrap;}
    .stype{font-size:.75rem;padding:2px 8px;border-radius:10px;font-weight:600;white-space:nowrap;}
    .stype.positive{background:#c6f6d5;color:#22543d;}
    .stype.negative{background:#fed7d7;color:#9b2335;}
    .stype.update{background:#bee3f8;color:#2a4365;}
    .sgroup{font-size:.75rem;color:#718096;}
    .sname{flex:1;font-weight:600;font-size:.88rem;}

    .badge{padding:3px 10px;border-radius:12px;font-size:.72rem;font-weight:700;white-space:nowrap;}
    .badge.pass{background:#c6f6d5;color:#22543d;}
    .badge.fail{background:#fed7d7;color:#9b2335;}
    .badge.pending{background:#e2e8f0;color:#4a5568;}
    .badge.warn{background:#fefcbf;color:#744210;}
    .badge.skip{background:#e9d8fd;color:#553c9a;}

    /* ── Flow row ── */
    .flow-row{display:flex;align-items:flex-start;gap:0;overflow-x:auto;padding-bottom:8px;}
    .arrow{font-size:1.2rem;color:#68d391;padding:28px 6px 0;flex-shrink:0;font-weight:700;}
    .arrow.dim{color:#cbd5e0;}

    /* ── Step cards ── */
    .step-card{border:1px solid #e2e8f0;border-radius:8px;min-width:190px;max-width:260px;width:260px;flex-shrink:0;overflow:hidden;}
    .step-card.pass{border-color:#9ae6b4;}
    .step-card.fail{border-color:#fc8181;}
    .step-card.skip{border-color:#e2e8f0;opacity:.65;}
    .step-card.pending{border-color:#e2e8f0;opacity:.5;}
    .step-card.stop{border-color:#fc8181;}

    .step-title{padding:8px 10px;font-weight:700;font-size:.78rem;border-bottom:1px solid #f7fafc;display:flex;align-items:center;gap:6px;}
    .step-card.pass .step-title{background:#f0fff4;}
    .step-card.fail .step-title{background:#fff5f5;}
    .step-card.skip .step-title{background:#f7fafc;}
    .step-card.pending .step-title{background:#f7fafc;}
    .step-card.stop .step-title{background:#fff5f5;}

    .step-body{padding:8px 10px;font-size:.75rem;}
    .step-body table{width:100%;border-collapse:collapse;table-layout:fixed;}
    .step-body td{padding:2px 0;vertical-align:top;word-break:break-word;overflow-wrap:anywhere;}
    .step-body .lbl{color:#718096;white-space:normal;padding-right:6px;font-weight:600;width:88px;min-width:88px;}
    .step-body .note{color:#a0aec0;font-size:.68rem;display:block;margin-top:1px;line-height:1.3;}
    .stop-banner{background:#fff5f5;border:1px solid #fc8181;border-radius:4px;padding:6px 8px;color:#9b2335;font-size:.75rem;margin-top:6px;font-weight:600;}
    .dim{color:#a0aec0;font-size:.78rem;font-style:italic;}
    .ico{font-size:.85rem;}
    .ico.pass{color:#38a169;}
    .ico.fail{color:#e53e3e;}
    .ico.skip{color:#a0aec0;}
    .ico.stop{color:#e53e3e;}
    .ico.pending{color:#a0aec0;}

    /* ── Footer ── */
    .footer{text-align:center;padding:20px;font-size:.75rem;color:#a0aec0;margin-bottom:20px;}
  </style>
</head>
<body>

<div class="hdr">
  <h1>🌊 Ocean Orders-In — Full Flow Report</h1>
  <p class="sub">Step-by-step verification: Create → Scheduler → MongoDB → Shippeo → Events</p>
  <div class="meta">
    <div class="meta-item"><strong>${meta.generatedAt}</strong>Generated At</div>
    <div class="meta-item"><strong>${meta.environment}</strong>Environment</div>
    <div class="meta-item"><strong>${total}</strong>Total Scenarios</div>
    <div class="meta-item"><strong style="color:#9ae6b4">${passed}</strong>Passed</div>
    <div class="meta-item"><strong style="color:#fc8181">${failed}</strong>Failed</div>
    ${partial  ? `<div class="meta-item"><strong style="color:#ed8936">${partial}</strong>Partial</div>`  : ''}
    ${skipped  ? `<div class="meta-item"><strong style="color:#9f7aea">${skipped}</strong>Skipped</div>` : ''}
  </div>
</div>

<div class="overall ${overallOk ? 'ok' : 'fail'}">
  <span>${overallOk ? '✅' : '❌'}</span>
  <span>Orders-In ${overallOk ? 'ALL PASSED' : 'HAS ISSUES'} —
    ${passed} passed
    ${failed  ? ` · <strong>${failed} failed</strong>`   : ''}
    ${partial ? ` · <strong>${partial} partial</strong>` : ''}
    ${skipped ? ` · ${skipped} skipped`                  : ''}
    of ${total} total
  </span>
</div>

${sections}

<div class="footer">Logward QA Automation — Ocean Orders-In Flow Report · ${meta.generatedAt}</div>

</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────

function generateReport(outputPath) {
  const now  = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const dest = outputPath
    ? path.resolve(outputPath)
    : path.resolve(
        process.env.PLAYWRIGHT_RUN_DIR || 'playwright-report/runs/latest',
        'ocean', 'ordersIn-flow-report.html'
      );

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buildHtml({ generatedAt: now, environment: 'QA' }), 'utf8');
  console.log(`\n  📊 Orders-In Flow Report → ${dest}\n`);
  return dest;
}

function resetAll() {
  _scenarios.clear();
}

module.exports = { startScenario, step, generateReport, resetAll };
