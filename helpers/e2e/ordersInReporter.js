// ─────────────────────────────────────────────────────────────────────────────
//  helpers/e2e/ordersInReporter.js
//
//  Generates a standalone HTML report for the Ocean Orders-In flow.
//  Covers three verification stages:
//    1. Object Creation    — what was sent to Logward and what was returned
//    2. Tracking Scheduler — Auto Tracking Conditions status (active / valid)
//    3. MongoDB Document   — Shippeo order created in the tracking database
//
//  Usage (called from E2E test afterAll):
//    const { generateOrdersInReport } = require('./helpers/e2e/ordersInReporter');
//    await generateOrdersInReport(reportData, 'playwright-report/e2e/orders-in-report.html');
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────

function badge(passed) {
  return passed
    ? `<span class="badge pass">✅ PASSED</span>`
    : `<span class="badge fail">❌ FAILED</span>`;
}

function row(label, value, note = '') {
  const display = value == null || value === '' ? '<span class="empty">—</span>' : `<span class="value">${value}</span>`;
  const noteHtml = note ? `<span class="note">${note}</span>` : '';
  return `
    <tr>
      <td class="label">${label}</td>
      <td>${display}${noteHtml}</td>
    </tr>`;
}

function statusRow(label, value, okValue, okText, failText) {
  const ok   = value === okValue;
  const icon = ok ? '✅' : '❌';
  const text = ok ? okText : failText;
  return `
    <tr>
      <td class="label">${label}</td>
      <td><span class="value">${value ?? '—'}</span> <span class="${ok ? 'ok' : 'notok'}">${icon} ${text}</span></td>
    </tr>`;
}

// ─────────────────────────────────────────────────────────────────────────────

function buildHtml(d) {
  const overallPassed = d.objectCreation.passed && d.scheduler.passed && d.mongoDb.passed && d.shippeo.passed;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Ocean Orders-In Report — ${d.generatedAt}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #f4f6f9; color: #1a1a2e; }

    /* ── Header ── */
    .header {
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 60%, #0f3460 100%);
      color: white; padding: 36px 48px;
    }
    .header h1 { font-size: 1.8rem; font-weight: 700; letter-spacing: -0.5px; }
    .header .sub { font-size: 0.95rem; color: #a0aec0; margin-top: 6px; }
    .header .meta { margin-top: 20px; display: flex; gap: 32px; flex-wrap: wrap; }
    .header .meta-item { font-size: 0.82rem; color: #cbd5e0; }
    .header .meta-item strong { color: white; display: block; font-size: 0.9rem; }

    /* ── Overall status banner ── */
    .overall {
      margin: 24px 48px 0;
      padding: 16px 24px;
      border-radius: 10px;
      font-size: 1rem;
      font-weight: 600;
      display: flex; align-items: center; gap: 12px;
    }
    .overall.pass { background: #f0fff4; border: 1.5px solid #68d391; color: #276749; }
    .overall.fail { background: #fff5f5; border: 1.5px solid #fc8181; color: #9b2335; }
    .overall .icon { font-size: 1.4rem; }

    /* ── Section ── */
    .sections { padding: 24px 48px 48px; display: flex; flex-direction: column; gap: 28px; }
    .section { background: white; border-radius: 12px; box-shadow: 0 1px 4px rgba(0,0,0,.08); overflow: hidden; }

    /* ── Section header ── */
    .section-header {
      padding: 20px 28px;
      border-bottom: 1px solid #edf2f7;
      display: flex; align-items: flex-start; gap: 16px;
    }
    .section-icon { font-size: 1.8rem; line-height: 1; }
    .section-title { flex: 1; }
    .section-title h2 { font-size: 1.1rem; font-weight: 700; color: #1a1a2e; }
    .section-title p { font-size: 0.85rem; color: #718096; margin-top: 4px; line-height: 1.5; }

    /* ── Badge ── */
    .badge { padding: 4px 12px; border-radius: 20px; font-size: 0.8rem; font-weight: 700; white-space: nowrap; }
    .badge.pass { background: #c6f6d5; color: #22543d; }
    .badge.fail { background: #fed7d7; color: #9b2335; }

    /* ── Table ── */
    .section-body { padding: 20px 28px; }
    table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
    tr:not(:last-child) td { border-bottom: 1px solid #f7fafc; }
    td { padding: 10px 8px; vertical-align: top; }
    td.label { width: 220px; color: #4a5568; font-weight: 600; white-space: nowrap; }
    .value { color: #1a1a2e; font-family: 'SFMono-Regular', Consolas, monospace;
             background: #f7fafc; padding: 2px 7px; border-radius: 4px; font-size: 0.84rem; }
    .empty { color: #a0aec0; font-style: italic; }
    .note { margin-left: 8px; font-size: 0.78rem; color: #718096; }
    .ok    { color: #276749; font-size: 0.82rem; }
    .notok { color: #9b2335; font-size: 0.82rem; }

    /* ── Error box ── */
    .error-box { margin-top: 16px; background: #fff5f5; border: 1px solid #fc8181;
                 border-radius: 8px; padding: 12px 16px; font-size: 0.84rem;
                 color: #9b2335; white-space: pre-wrap; }

    /* ── Flow diagram ── */
    .flow {
      padding: 0 28px 24px;
      display: flex; align-items: center; gap: 0; flex-wrap: wrap;
    }
    .flow-step {
      display: flex; align-items: center; gap: 8px;
      font-size: 0.8rem; font-weight: 600; padding: 7px 14px;
      border-radius: 6px; white-space: nowrap;
    }
    .flow-step.done  { background: #c6f6d5; color: #22543d; }
    .flow-step.fail  { background: #fed7d7; color: #9b2335; }
    .flow-step.skip  { background: #edf2f7; color: #718096; }
    .flow-arrow { color: #a0aec0; font-size: 1rem; padding: 0 4px; }

    /* ── Footer ── */
    .footer { text-align: center; padding: 20px; font-size: 0.78rem; color: #a0aec0; }
  </style>
</head>
<body>

<!-- ══ HEADER ══════════════════════════════════════════════════════════════ -->
<div class="header">
  <h1>🌊 Ocean Tracking — Orders-In Report</h1>
  <p class="sub">End-to-End validation: Logward object creation → Auto Tracking Conditions → Shippeo sync</p>
  <div class="meta">
    <div class="meta-item"><strong>${d.generatedAt}</strong>Generated At</div>
    <div class="meta-item"><strong>${d.runId}</strong>Run ID</div>
    <div class="meta-item"><strong>${d.mode}</strong>Transport Mode</div>
    <div class="meta-item"><strong>${d.objectCreation.containerNumber ?? '—'}</strong>Container Number</div>
    <div class="meta-item"><strong>${d.objectCreation.objectCode ?? '—'}</strong>Object Code</div>
  </div>
</div>

<!-- ══ OVERALL STATUS ══════════════════════════════════════════════════════ -->
<div class="overall ${overallPassed ? 'pass' : 'fail'}">
  <span class="icon">${overallPassed ? '✅' : '❌'}</span>
  <span>Orders-In ${overallPassed ? 'PASSED' : 'FAILED'} —
    ${[d.objectCreation.passed, d.scheduler.passed, d.mongoDb.passed, d.shippeo.passed].filter(Boolean).length} of 4 checks passed
  </span>
</div>

<!-- ══ FLOW SUMMARY ════════════════════════════════════════════════════════ -->
<div class="sections">
  <div class="section">
    <div class="section-header">
      <div class="section-icon">🔄</div>
      <div class="section-title">
        <h2>Orders-In Flow</h2>
        <p>The three steps required for a shipment to be registered in Logward and synced to Shippeo.</p>
      </div>
    </div>
    <div class="flow" style="padding: 20px 28px;">
      <div class="flow-step ${d.objectCreation.passed ? 'done' : 'fail'}">
        📦 Object Created
      </div>
      <span class="flow-arrow">→</span>
      <div class="flow-step ${d.scheduler.passed ? 'done' : (d.objectCreation.passed ? 'fail' : 'skip')}">
        📅 ATC Activated
      </div>
      <span class="flow-arrow">→</span>
      <div class="flow-step ${d.mongoDb.passed ? 'done' : (d.scheduler.passed ? 'fail' : 'skip')}">
        🗄️ Mongo Synced
      </div>
      <span class="flow-arrow">→</span>
      <div class="flow-step ${d.shippeo.passed ? 'done' : (d.mongoDb.passed ? 'fail' : 'skip')}">
        🚢 Shippeo Verified
      </div>
    </div>
  </div>

<!-- ══ SECTION 1: OBJECT CREATION ════════════════════════════════════════ -->
  <div class="section">
    <div class="section-header">
      <div class="section-icon">📦</div>
      <div class="section-title">
        <h2>Step 1 — Tracking Object Creation</h2>
        <p>
          A new <strong>Ocean Transport Unit (OTU)</strong> is created in Logward with the shipment's
          key identifiers. This is the record that holds all tracking milestones for the shipment.
          The system needs at minimum: Container Number + (Booking Number or Bill of Lading) + SCAC Code.
        </p>
      </div>
      ${badge(d.objectCreation.passed)}
    </div>
    <div class="section-body">
      <table>
        ${row('Container Number',  d.objectCreation.containerNumber,  'Unique container ID — auto-generated for this test run')}
        ${row('Booking Number',    d.objectCreation.bookingNumber)}
        ${row('Bill of Lading',    d.objectCreation.blNumber)}
        ${row('Carrier SCAC',      d.objectCreation.scac,             'Standard Carrier Alpha Code — identifies the shipping line')}
        ${row('Carrier',           d.objectCreation.carrier)}
        ${row('Mode of Transport', d.objectCreation.mot)}
        ${row('Tracking Status',   d.objectCreation.trackingStatus)}
        ${row('Logward Object Code', d.objectCreation.objectCode,     'Internal Logward ID — used for all subsequent API calls')}
        ${row('HTTP Response',     d.objectCreation.httpStatus ? `${d.objectCreation.httpStatus} OK` : null)}
      </table>
      ${d.objectCreation.errorMessage ? `<div class="error-box">⚠️ Error: ${d.objectCreation.errorMessage}</div>` : ''}
    </div>
  </div>

<!-- ══ SECTION 2: TRACKING SCHEDULER ════════════════════════════════════ -->
  <div class="section">
    <div class="section-header">
      <div class="section-icon">📅</div>
      <div class="section-title">
        <h2>Step 2 — Auto Tracking Conditions (Scheduler)</h2>
        <p>
          After the object is created, Logward evaluates <strong>Auto Tracking Conditions (ATC)</strong>.
          These are rules that determine whether the shipment has enough information to be sent to Shippeo
          for tracking. Two flags must be <strong>true (1)</strong>:
          <br/>• <strong>Active</strong> — all Auto Tracking Conditions are satisfied
          <br/>• <strong>Valid</strong> — all required tracking fields (container, SCAC, etc.) are populated
        </p>
      </div>
      ${badge(d.scheduler.passed)}
    </div>
    <div class="section-body">
      <table>
        ${statusRow('Active',  d.scheduler.active,  1, 'Auto Tracking Conditions satisfied', 'Conditions NOT satisfied — check ATC configuration')}
        ${statusRow('Valid',   d.scheduler.valid,   1, 'All required tracking fields populated', 'Missing required fields — check container / SCAC')}
        ${row('Scheduler Record Code', d.scheduler.schedulerCode)}
        ${row('Object Code (ref)',      d.objectCreation.objectCode)}
        ${row('Last Tracking Attempted', d.scheduler.lastTrackingAttemptedAt)}
        ${row('Last Successfully Tracked', d.scheduler.lastTrackedAt ?? 'Not yet tracked')}
      </table>
      ${d.scheduler.errorMessage ? `<div class="error-box">⚠️ Error: ${d.scheduler.errorMessage}</div>` : ''}
    </div>
  </div>

<!-- ══ SECTION 3: MONGODB / SHIPPEO SYNC ════════════════════════════════ -->
  <div class="section">
    <div class="section-header">
      <div class="section-icon">🗄️</div>
      <div class="section-title">
        <h2>Step 3 — Shippeo Order Sync (MongoDB Verification)</h2>
        <p>
          Once ATC conditions are met, Logward automatically creates a tracking order in
          <strong>Shippeo</strong>. The result is stored in Logward's tracking database (MongoDB).
          A document with <strong>error: false</strong> confirms the order was successfully
          created in Shippeo and is ready to receive shipment events.
        </p>
      </div>
      ${badge(d.mongoDb.passed)}
    </div>
    <div class="section-body">
      <table>
        ${statusRow('Document Found', d.mongoDb.found ? 'Yes' : 'No', 'Yes', 'Order exists in MongoDB', 'Order not yet created — Shippeo sync may still be pending')}
        ${statusRow('Error Status',   d.mongoDb.error === false ? 'false' : (d.mongoDb.error == null ? null : 'true'), 'false', 'No error — order created successfully in Shippeo', 'Error during Shippeo order creation')}
        ${row('Container ID',      d.mongoDb.containerId)}
        ${row('Booking ID',        d.mongoDb.bookingId)}
        ${row('Bill of Lading ID', d.mongoDb.billOfLadingId)}
        ${row('SCAC Code',         d.mongoDb.scacCode)}
        ${row('Service Provider',  d.mongoDb.serviceProvider, 'Tracking provider — Shippeo for ocean')}
        ${row('Identifier Type',   d.mongoDb.identifier,      'Which field Shippeo uses as the primary identifier')}
        ${row('Unique Reference',  d.mongoDb.uniqueReference, 'Format: bookingId_containerId or blId_containerId')}
        ${row('Created At',        d.mongoDb.createdAt)}
        ${row('Events Received',   d.mongoDb.eventsCount != null ? String(d.mongoDb.eventsCount) : null, 'Number of shipment milestone events received from Shippeo')}
      </table>
      ${d.mongoDb.errorMessage ? `<div class="error-box">⚠️ Error: ${d.mongoDb.errorMessage}</div>` : ''}
    </div>
  </div>

<!-- ══ SECTION 4: SHIPPEO VERIFICATION ══════════════════════════════════════ -->
  <div class="section">
    <div class="section-header">
      <div class="section-icon">🚢</div>
      <div class="section-title">
        <h2>Step 4 — Shippeo Order Verification</h2>
        <p>
          Confirms the shipment is <strong>visible and searchable in Shippeo</strong> using the
          Shippeo backoffice debug API. A successful result means Shippeo has registered the
          order and it is ready to receive tracking events.
        </p>
      </div>
      ${badge(d.shippeo.passed)}
    </div>
    <div class="section-body">
      <table>
        ${statusRow('Shipment Found', d.shippeo.found ? 'Yes' : 'No', 'Yes', 'Order exists in Shippeo', 'Order not found — sync may be pending or failed')}
        ${row('Search Reference',   d.shippeo.reference,    'Format used to search: bookingId_containerId')}
        ${row('Order ID',           d.shippeo.orderId,      'Shippeo internal order ID')}
        ${row('Hash ID',            d.shippeo.hashId,       'Shippeo hash ID')}
        ${row('Organisation',       d.shippeo.organisation)}
        ${row('Agency',             d.shippeo.agency)}
        ${row('Order Created At',   d.shippeo.createdAt)}
        ${row('Transport Mode',     d.shippeo.transportMode)}
      </table>
      ${d.shippeo.errorMessage ? `<div class="error-box">⚠️ Error: ${d.shippeo.errorMessage}</div>` : ''}
    </div>
  </div>

</div><!-- /sections -->

<div class="footer">
  Logward QA Automation — Ocean Orders-In Report &nbsp;·&nbsp; ${d.generatedAt}
</div>

</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate and write the Orders-In HTML report.
 *
 * @param data
 * @param [outputPath]  Defaults to playwright-report/e2e/orders-in-report.html - Absolute path to the written file
 */
function generateOrdersInReport(data, outputPath) {
  let dest;
  if (outputPath) {
    dest = path.resolve(outputPath);
  } else {
    // Use the same run folder as playwright.config.js so all reports stay together
    const runDir = process.env.PLAYWRIGHT_RUN_DIR || 'playwright-report/runs/latest';
    dest = path.resolve(runDir, 'ocean', 'orders-in-report.html');
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buildHtml(data), 'utf8');
  console.log(`\n  📊 Orders-In report → ${dest}\n`);
  return dest;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a report data skeleton with all fields null.
 * Fill in fields progressively as each test step runs.
 *
 * @param containerNumber
 */
function createReportData(containerNumber) {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const runId = `ocean-${Date.now().toString(36).toUpperCase()}`;
  return {
    runId,
    generatedAt: now,
    mode:        'OCEAN',
    objectCreation: {
      passed: false, httpStatus: null, objectCode: null,
      containerNumber, bookingNumber: null, blNumber: null,
      scac: null, carrier: null, mot: null, trackingStatus: null, errorMessage: null,
    },
    scheduler: {
      passed: false, active: null, valid: null, schedulerCode: null,
      lastTrackingAttemptedAt: null, lastTrackedAt: null, errorMessage: null,
    },
    mongoDb: {
      passed: false, found: false, containerId: null, bookingId: null,
      billOfLadingId: null, scacCode: null, serviceProvider: null,
      identifier: null, error: null, uniqueReference: null,
      createdAt: null, eventsCount: null, errorMessage: null,
    },
    shippeo: {
      passed: false, found: false, reference: null, orderId: null,
      hashId: null, organisation: null, agency: null,
      createdAt: null, transportMode: null, errorMessage: null,
    },
  };
}

module.exports = { generateOrdersInReport, createReportData };
