#!/usr/bin/env node
// daily-tracking-summary.mjs
// Usage: node daily-tracking-summary.mjs <session-report-url> <flow-report-url>
// URLs may be github.com/<owner>/<repo>/blob/<branch>/<path> or raw.githubusercontent.com/...
// Output dir defaults to ~/daily-summaries; override with SUMMARY_DIR env var.
//
// Writes for each run-date:
//   YYYY-MM-DD.html  → polished, self-contained report (open in browser / screenshot for meetings)
//   YYYY-MM-DD.md    → 3–6 bullet summary (paste into Slack / chat)
//   YYYY-MM-DD.json  → failure-key sidecar (used by next day's run for the diff line)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';

const OUT_DIR = process.env.SUMMARY_DIR || path.join(os.homedir(), 'daily-summaries');

// ─────────────────────────── fetch helpers ───────────────────────────
const blobToRaw = (u) => {
  const m = u.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}` : u;
};
const fetchText = async (u) => {
  const res = await fetch(u);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${u}`);
  return res.text();
};

// ─────────────────────────── string helpers ──────────────────────────
const decode = (s) => s
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
const stripTags = (s) => decode(String(s).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const fmtDuration = (raw) => {
  if (!raw) return '';
  const m = String(raw).match(/^([\d.]+)\s*s$/i);
  if (!m) return raw;
  const total = parseFloat(m[1]);
  const min = Math.floor(total / 60);
  const sec = Math.round(total - min * 60);
  return min ? `${min}m ${sec}s` : `${sec}s`;
};
const pct = (num, den) => {
  const n = Number(num), d = Number(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
  return (n / d) * 100;
};

// ─────────────────────────── parsers ─────────────────────────────────
const titleOf = (html) => {
  const m = html.match(/<title>([^<]+)<\/title>/i);
  return m ? decode(m[1]).trim() : '';
};
const detectKind = (html) => {
  if (/class="event-card/.test(html) || /Session Report/i.test(html)) return 'session';
  if (/class="scenario\b/.test(html) || /Flow Report/i.test(html)) return 'flow';
  return 'unknown';
};

function parseSession(html) {
  const stats = {};
  for (const m of html.matchAll(/<div class="stat[^"]*"><strong[^>]*>([^<]+)<\/strong>\s*([^<]+)<\/div>/g)) {
    stats[m[2].trim()] = m[1].trim();
  }

  const overall = /<div class="banner ok"/.test(html) ? 'pass'
    : /<div class="banner fail"/.test(html) ? 'fail' : 'unknown';

  // OTU context box
  const otu = [];
  const otuBox = html.match(/<div class="otu-box">([\s\S]*?)<\/div>\s*<\/div>/);
  if (otuBox) {
    for (const m of otuBox[1].matchAll(/<div class="field-item">([^<]+)<span>([\s\S]*?)<\/span>/g)) {
      otu.push({ label: stripTags(m[1]), value: stripTags(m[2]) });
    }
  }

  // Every event card (pass and fail), for breakdown stats
  // Also capture special cards: slot-limit, legacy, wrong-event
  const events = [];
  for (const m of html.matchAll(/<div class="event-card[^"]*">([\s\S]*?)(?=<div class="event-card|<div class="footer|<\/body>)/g)) {
    const card = m[1];
    const status = (() => {
      if (/class="event-card pass"/.test(card)) return 'pass';
      if (/class="event-card fail"/.test(card)) return 'fail';
      // Legacy/wrong-event/slot-limit cards use custom badge text
      const badge = (card.match(/class="badge[^"]*">([^<]+)</) || [])[1] || '';
      if (/NEW FLOW (OK|CONFIRMED)|PASSED|passed/i.test(badge) || /NEW FLOW (OK|CONFIRMED)/i.test(card)) return 'pass';
      if (/OLD FLOW DETECTED|FAILED/i.test(badge)) return 'fail';
      return 'pass'; // informational cards (slot-limit) are not failures
    })();
    // Capture ALL flow badge types: POSITIVE, NEGATIVE, WRONG EVENT, LEGACY TEST, SLOT LIMIT
    const flowBadge = (card.match(/<span class="flow-[^"]*">([^<]+)<\/span>/) || [])[1] || '';
    const ts = (card.match(/<span class="ts">([^<]+)<\/span>/) || [])[1] || '';
    events.push({
      status,
      seq:   (card.match(/<span class="seq">([^<]+)<\/span>/) || [])[1] || '',
      flow:  flowBadge,
      name:  (card.match(/<span class="event-name">([^<]+)<\/span>/) || [])[1] || '',
      place: (card.match(/<span class="place-type">([^<]+)<\/span>/) || [])[1] || '',
      sit:   (card.match(/<span class="sit-type">([^<]+)<\/span>/) || [])[1] || '',
      http:  (card.match(/<span class="http">([^<]+)<\/span>/) || [])[1] || '',
      duration: (card.match(/<span class="duration">([^<]+)<\/span>/) || [])[1] || '',
      ts,
    });
  }

  // Extract execution date from first event timestamp (HH:MM:SS UTC → use title date)
  const execDate = (() => {
    const m = html.match(/<title>[^—]*—\s*([^<]+)<\/title>/i);
    return m ? decode(m[1]).trim() : '';
  })();

  // Failures: pull the rich assertion detail for the first failing/blocked row
  const failures = [];
  for (const m of html.matchAll(/<div class="event-card fail">([\s\S]*?)(?=<div class="event-card |<div class="footer|<\/body>)/g)) {
    const card = m[1];
    const header = {
      seq: (card.match(/<span class="seq">([^<]+)<\/span>/) || [])[1] || '?',
      flow: (card.match(/<span class="flow-(?:pos|neg)">([^<]+)<\/span>/) || [])[1] || '',
      name: (card.match(/<span class="event-name">([^<]+)<\/span>/) || [])[1] || '',
      place: (card.match(/<span class="place-type">([^<]+)<\/span>/) || [])[1] || '',
      sit: (card.match(/<span class="sit-type">([^<]+)<\/span>/) || [])[1] || '',
      ts: (card.match(/<span class="ts">([^<]+)<\/span>/) || [])[1] || '',
    };

    const assertions = [];
    for (const tr of card.matchAll(/<tr class="(fail|blocked)">([\s\S]*?)<\/tr>/g)) {
      const kind = tr[1];
      const row = tr[2];
      const field = (row.match(/<code class="field-name">([^<]+)<\/code>/) || [])[1] || '';
      const summary = (row.match(/<div class="cond-summary[^"]*">([\s\S]*?)<\/div>/) || [])[1] || '';
      const exp = row.match(/<td><code>([^<]+)<\/code><\/td>\s*<td><code class="exp">([^<]+)<\/code>/);
      assertions.push({
        kind,
        field,
        summary: stripTags(summary),
        actual: exp ? exp[1] : '',
        expected: exp ? exp[2] : '',
      });
    }
    failures.push({ ...header, assertions });
  }

  // Flow type breakdown
  const flowBreakdown = {};
  for (const e of events) {
    const key = e.flow || 'UNKNOWN';
    if (!flowBreakdown[key]) flowBreakdown[key] = { total: 0, passed: 0, failed: 0 };
    flowBreakdown[key].total++;
    if (e.status === 'pass' || e.status === 'passed') flowBreakdown[key].passed++;
    else flowBreakdown[key].failed++;
  }

  return { kind: 'session', stats, overall, otu, events, failures, flowBreakdown, execDate };
}

function parseFlow(html) {
  const stats = {};
  for (const m of html.matchAll(/<div class="meta-item"><strong[^>]*>([^<]+)<\/strong>([^<]+)<\/div>/g)) {
    stats[m[2].trim()] = m[1].trim();
  }
  const overall = /<div class="overall ok"/.test(html) ? 'pass'
    : /<div class="overall fail"/.test(html) ? 'fail' : 'unknown';

  // Group breakdown: <span class="group-label">..</span> <span class="group-counts">N passed · M total</span>
  const groups = [];
  for (const m of html.matchAll(/<span class="group-label">([\s\S]*?)<\/span>\s*<span class="group-counts">([\s\S]*?)<\/span>/g)) {
    const label = stripTags(m[1]);
    const countsTxt = stripTags(m[2]);
    const passed = Number((countsTxt.match(/(\d+)\s*passed/) || [])[1] ?? 0);
    const failed = Number((countsTxt.match(/(\d+)\s*failed/) || [])[1] ?? 0);
    const total = Number((countsTxt.match(/(\d+)\s*total/) || [])[1] ?? passed + failed);
    groups.push({ label, passed, failed, total, raw: countsTxt });
  }

  // Every scenario, for completeness
  const scenarios = [];
  for (const m of html.matchAll(/<div class="scenario (pass|fail|partial|skipped|pending)">([\s\S]*?)(?=<div class="scenario |<div class="group-section|<div class="footer|<\/body>)/g)) {
    const status = m[1];
    const card = m[2];
    scenarios.push({
      status,
      sid: (card.match(/<span class="sid">([^<]+)<\/span>/) || [])[1] || '',
      stype: stripTags((card.match(/<span class="stype[^"]*">([\s\S]*?)<\/span>/) || [])[1] || ''),
      sgroup: stripTags((card.match(/<span class="sgroup">([\s\S]*?)<\/span>/) || [])[1] || ''),
      sname: stripTags((card.match(/<span class="sname">([\s\S]*?)<\/span>/) || [])[1] || ''),
    });
  }

  // Failures (fail + partial) with the first stop-banner as the reason
  const failures = [];
  for (const m of html.matchAll(/<div class="scenario (fail|partial)">([\s\S]*?)(?=<div class="scenario |<div class="group-section|<div class="footer|<\/body>)/g)) {
    const status = m[1];
    const card = m[2];
    const stops = [...card.matchAll(/<div class="stop-banner">([\s\S]*?)<\/div>/g)].map(x => stripTags(x[1]));
    failures.push({
      status,
      sid: (card.match(/<span class="sid">([^<]+)<\/span>/) || [])[1] || '?',
      stype: stripTags((card.match(/<span class="stype[^"]*">([\s\S]*?)<\/span>/) || [])[1] || ''),
      sgroup: stripTags((card.match(/<span class="sgroup">([\s\S]*?)<\/span>/) || [])[1] || ''),
      sname: stripTags((card.match(/<span class="sname">([\s\S]*?)<\/span>/) || [])[1] || ''),
      reason: stops[0] || '',
    });
  }

  return { kind: 'flow', stats, overall, groups, scenarios, failures };
}

const parseReport = (html) => {
  const kind = detectKind(html);
  if (kind === 'session') return { ...parseSession(html), title: titleOf(html) };
  if (kind === 'flow')    return { ...parseFlow(html),    title: titleOf(html) };
  return { kind: 'unknown', title: titleOf(html), stats: {}, overall: 'unknown', failures: [] };
};

const pickDate = (r) => {
  const m = (r.title || '').match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : new Date().toISOString().slice(0, 10);
};

const sessionKey = (f) => `session:${f.name}@${f.place}`;
const flowKey = (f) => `flow:${f.sid}`;

// ─────────────────────── diff vs previous run ────────────────────────
function findPrev(today) {
  if (!fs.existsSync(OUT_DIR)) return null;
  const files = fs.readdirSync(OUT_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f < `${today}.json`)
    .sort();
  if (!files.length) return null;
  try { return JSON.parse(fs.readFileSync(path.join(OUT_DIR, files.at(-1)), 'utf8')); }
  catch { return null; }
}

function computeDiff(today, prev) {
  if (!prev) return null;
  const prevSet = new Set(prev.failureKeys || []);
  const todaySet = new Set(today);
  return {
    date: prev.date,
    newFails: [...todaySet].filter(k => !prevSet.has(k)),
    recovered: [...prevSet].filter(k => !todaySet.has(k)),
    stillFailing: [...todaySet].filter(k => prevSet.has(k)),
  };
}

// ─────────────────────── markdown (chat) summary ─────────────────────
function buildMarkdown(reports, diff, date, wrongEventReport = null) {
  const session = reports.find(r => r.kind === 'session');
  const flow    = reports.find(r => r.kind === 'flow');
  const lines = [`# Daily Tracking Summary — ${date}`, ''];

  if (session) {
    const t = session.stats['Events Run'] ?? '?';
    const p = session.stats['Passed'] ?? '?';
    const f = session.stats['Failed'] ?? '?';
    const d = session.stats['Duration'] ? ` (${fmtDuration(session.stats['Duration'])})` : '';
    const icon = session.overall === 'pass' ? '✅' : '🔴';
    lines.push(`- **Events session:** ${p}/${t} passed${f !== '0' ? `, ${f} failed` : ''}${d} ${icon}`);

    // Flow type breakdown
    const fb = session.flowBreakdown || {};
    const ORDER = ['POSITIVE', 'NEGATIVE', 'WRONG EVENT', 'LEGACY TEST', 'SLOT LIMIT', 'UNKNOWN'];
    const parts = ORDER.filter(k => fb[k]).map(k => {
      const b = fb[k];
      const icon2 = b.failed ? '🔴' : '✅';
      return `${k.toLowerCase()}: ${b.passed}/${b.total} ${icon2}`;
    });
    if (parts.length) lines.push(`  - _Flow breakdown:_ ${parts.join(' · ')}`);
    if (session.execDate) lines.push(`  - _Run date:_ ${session.execDate}`);
  }

  if (flow) {
    const t = flow.stats['Total Scenarios'] ?? flow.stats['Total'] ?? '?';
    const p = flow.stats['Passed'] ?? '?';
    const f = flow.stats['Failed'] ?? '?';
    const icon = flow.overall === 'pass' ? '✅' : '🔴';
    lines.push(`- **Ocean Orders-In flow:** ${p}/${t} scenarios passed${f !== '0' ? `, ${f} failed` : ''} ${icon}`);
  } else {
    lines.push(`- **Ocean Orders-In flow:** ⏭ Skipped — no Orders-In report provided`);
  }

  const fails = [];
  if (session) for (const f of session.failures) {
    const seq = String(f.seq).startsWith('#') ? f.seq : `#${f.seq}`;
    const a = f.assertions[0];
    const reason = a ? `${a.field}${a.summary ? ` — ${a.summary}` : ''}${a.actual && a.expected ? ` (actual ${a.actual}, expected ${a.expected})` : ''}` : '';
    fails.push(`${seq} \`${f.name}\` (${f.flow}${f.place ? `, ${f.place}` : ''})${reason ? ` — ${reason}` : ''}`);
  }
  if (flow) for (const f of flow.failures) {
    fails.push(`${f.sid} ${f.status} — ${f.sname}${f.reason ? ` (${f.reason})` : ''}`);
  }
  if (fails.length === 0) lines.push(`- **Failures:** none 🎉`);
  else {
    lines.push(`- **Failures:**`);
    for (const x of fails.slice(0, 6)) lines.push(`  - ${x}`);
    if (fails.length > 6) lines.push(`  - …and ${fails.length - 6} more`);
  }

  if (wrongEventReport) {
    const t = wrongEventReport.events.length;
    const p = wrongEventReport.events.filter(e => e.pass !== false).length;
    const icon = p === t ? '✅' : '🔴';
    lines.push(`- **Wrong-Event verification:** ${p}/${t} checks passed ${icon}`);
    lines.push(`  - _Run date:_ ${wrongEventReport.execDate || ''}`);
  }

  if (diff) {
    const parts = [];
    if (diff.newFails.length) parts.push(`+${diff.newFails.length} new`);
    if (diff.recovered.length) parts.push(`-${diff.recovered.length} recovered`);
    if (diff.stillFailing.length) parts.push(`${diff.stillFailing.length} still failing`);
    lines.push(`- **Vs ${diff.date}:** ${parts.length ? parts.join(', ') : 'no change'}`);
  } else {
    lines.push(`- **Vs prior:** first run — no baseline yet`);
  }
  return lines.join('\n');
}

// ─────────────────────── HTML report (meeting) ───────────────────────
function donut(percent, label) {
  const r = 42, c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, percent));
  const dash = (p / 100) * c;
  const color = p >= 99.5 ? '#16a34a' : p >= 90 ? '#65a30d' : p >= 70 ? '#d97706' : '#dc2626';
  return `
  <svg viewBox="0 0 100 100" class="donut" aria-label="${esc(label)} ${p.toFixed(1)}%">
    <circle cx="50" cy="50" r="${r}" stroke="#e5e7eb" stroke-width="12" fill="none"/>
    <circle cx="50" cy="50" r="${r}" stroke="${color}" stroke-width="12" fill="none"
            stroke-linecap="round"
            stroke-dasharray="${dash.toFixed(2)} ${c.toFixed(2)}"
            transform="rotate(-90 50 50)"/>
    <text x="50" y="49" text-anchor="middle" font-size="18" font-weight="700" fill="#0f172a">${p.toFixed(p % 1 ? 1 : 0)}%</text>
    <text x="50" y="64" text-anchor="middle" font-size="8" fill="#64748b" letter-spacing="0.5">${esc(label).toUpperCase()}</text>
  </svg>`;
}

function statusPill(overall) {
  if (overall === 'pass') return `<span class="pill pill-pass">PASS</span>`;
  if (overall === 'fail') return `<span class="pill pill-fail">FAIL</span>`;
  return `<span class="pill pill-warn">UNKNOWN</span>`;
}

function buildHtml(reports, diff, date, urls, wrongEventReport = null) {
  const session = reports.find(r => r.kind === 'session');
  const flow    = reports.find(r => r.kind === 'flow');

  // hero KPIs
  const totalRun =
    Number(session?.stats?.['Events Run'] || 0) +
    Number(flow?.stats?.['Total Scenarios'] || flow?.stats?.['Total'] || 0);
  const totalPass =
    Number(session?.stats?.['Passed'] || 0) +
    Number(flow?.stats?.['Passed'] || 0);
  const totalFail =
    Number(session?.stats?.['Failed'] || 0) +
    Number(flow?.stats?.['Failed'] || 0);
  const overallPct = pct(totalPass, totalRun);
  const overallOk = totalFail === 0 && totalRun > 0;
  const heroIcon = overallOk ? '✅' : '⚠️';
  const heroText = overallOk
    ? 'All checks passed'
    : `${totalFail} failure${totalFail === 1 ? '' : 's'} across today's run`;

  // session card
  const sessionHtml = session ? (() => {
    const t = Number(session.stats['Events Run'] || 0);
    const p = Number(session.stats['Passed'] || 0);
    const f = Number(session.stats['Failed'] || 0);
    const sessionPct = pct(p, t) ?? 0;
    const dur = fmtDuration(session.stats['Duration'] || '');
    const positive = session.events.filter(e => e.flow === 'POSITIVE').length;
    const negative = session.events.filter(e => e.flow === 'NEGATIVE').length;
    return `
    <section class="card">
      <header class="card-head">
        <div>
          <div class="card-eyebrow">Session report</div>
          <h2>${esc(session.title.replace(/—.*$/, '').trim()) || 'E2E Session'}</h2>
        </div>
        ${statusPill(session.overall)}
      </header>
      <div class="card-body">
        <div class="donut-wrap">${donut(sessionPct, 'pass rate')}</div>
        <dl class="kvs">
          <div><dt>Events run</dt><dd>${t}</dd></div>
          <div><dt>Passed</dt><dd class="ok">${p}</dd></div>
          <div><dt>Failed</dt><dd class="${f ? 'bad' : 'muted'}">${f}</dd></div>
          ${dur ? `<div><dt>Duration</dt><dd>${esc(dur)}</dd></div>` : ''}
          ${session.execDate ? `<div><dt>Run date</dt><dd>${esc(session.execDate)}</dd></div>` : ''}
        </dl>
      </div>
      ${(() => {
        const fb = session.flowBreakdown || {};
        const ORDER = [
          { key: 'POSITIVE',    dot: '🟢', label: 'Positive Flow' },
          { key: 'NEGATIVE',    dot: '🔴', label: 'Negative Flow' },
          { key: 'WRONG EVENT', dot: '🟠', label: 'Wrong Event' },
          { key: 'LEGACY TEST', dot: '🟣', label: 'Legacy Test' },
          { key: 'SLOT LIMIT',  dot: '🟡', label: 'Slot Limit (expected)' },
        ];
        const rows = ORDER.filter(({key}) => fb[key]).map(({key, dot, label}) => {
          const b = fb[key];
          const barPct = b.total ? ((b.passed / b.total) * 100).toFixed(1) : 0;
          const barColor = b.failed ? '#ef4444' : '#22c55e';
          const failNote = b.failed ? ` · <span style="color:#dc2626">${b.failed} failed</span>` : '';
          return `
          <div class="flow-group">
            <div class="flow-group-row">
              <span class="flow-group-label">${dot} ${esc(label)}</span>
              <span class="flow-group-count">${b.passed}/${b.total}${failNote}</span>
            </div>
            <div class="bar"><div class="bar-fill" style="width:${barPct}%;background:${barColor}"></div></div>
          </div>`;
        }).join('');
        return rows ? `<div class="flow-groups-wrap" style="padding:0 20px 16px;border-top:1px solid #f1f5f9;">${rows}</div>` : '';
      })()}
      ${session.otu.length ? `
      <div class="chips">
        ${session.otu.map(o => `<span class="chip"><b>${esc(o.label)}</b>${esc(o.value)}</span>`).join('')}
      </div>` : ''}
    </section>`;
  })() : '';

  // flow card (or skipped notice)

  const flowHtml = !flow ? `
    <section class="card" style="border-left:4px solid #f59e0b;">
      <header class="card-head">
        <div>
          <div class="card-eyebrow">Flow report</div>
          <h2>Ocean Orders-In Flow</h2>
        </div>
        <span class="pill pill-warn">SKIPPED</span>
      </header>
      <div class="card-body" style="color:#92400e;font-size:.9rem;padding:20px;">
        ⏭ No Orders-In report provided for this run. Run <code>npx playwright test --project=ocean OceanOrdersIn</code> to generate one.
      </div>
    </section>` : (() => {
    const t = Number(flow.stats['Total Scenarios'] || flow.stats['Total'] || 0);
    const p = Number(flow.stats['Passed'] || 0);
    const f = Number(flow.stats['Failed'] || 0);
    const flowPct = pct(p, t) ?? 0;
    const env = flow.stats['Environment'] || '';
    const generated = flow.stats['Generated At'] || '';
    return `
    <section class="card">
      <header class="card-head">
        <div>
          <div class="card-eyebrow">Flow report</div>
          <h2>${esc(flow.title.replace(/—.*$/, '').trim()) || 'Ocean Orders-In Flow'}</h2>
        </div>
        ${statusPill(flow.overall)}
      </header>
      <div class="card-body">
        <div class="donut-wrap">${donut(flowPct, 'pass rate')}</div>
        <dl class="kvs">
          <div><dt>Scenarios</dt><dd>${t}</dd></div>
          <div><dt>Passed</dt><dd class="ok">${p}</dd></div>
          <div><dt>Failed</dt><dd class="${f ? 'bad' : 'muted'}">${f}</dd></div>
          ${env ? `<div><dt>Environment</dt><dd>${esc(env)}</dd></div>` : ''}
          ${generated ? `<div><dt>Generated</dt><dd>${esc(generated)}</dd></div>` : ''}
        </dl>
      </div>
      ${flow.groups.length ? `
      <div class="groups">
        ${flow.groups.map(g => {
          const groupPct = pct(g.passed, g.total) ?? 0;
          const fillColor = g.failed ? '#ef4444' : '#22c55e';
          return `
            <div class="group">
              <div class="group-row">
                <span class="group-label">${esc(g.label)}</span>
                <span class="group-counts">${g.passed}/${g.total}${g.failed ? ` · ${g.failed} failed` : ''}</span>
              </div>
              <div class="bar"><div class="bar-fill" style="width:${groupPct.toFixed(1)}%;background:${fillColor}"></div></div>
            </div>`;
        }).join('')}
      </div>` : ''}
    </section>`;
  })();

  // wrong-event card
  const wrongEventHtmlCard = wrongEventReport ? (() => {
    const t = wrongEventReport.events.length;
    const p = wrongEventReport.events.filter(e => e.pass !== false).length;
    const f = t - p;
    const wePct = t ? ((p/t)*100).toFixed(1) : 0;
    return `
    <section class="card" style="border-left:4px solid #f59e0b;">
      <header class="card-head">
        <div>
          <div class="card-eyebrow">Wrong-Event Verification</div>
          <h2>TSP Unknown Event Names</h2>
        </div>
        ${f === 0 ? '<span class="pill pill-pass">ALL PASS</span>' : '<span class="pill pill-fail">FAILED</span>'}
      </header>
      <div class="card-body">
        <div class="donut-wrap">${donut(Number(wePct), 'pass rate')}</div>
        <dl class="kvs">
          <div><dt>Checks run</dt><dd>${t}</dd></div>
          <div><dt>Passed</dt><dd class="ok">${p}</dd></div>
          <div><dt>Failed</dt><dd class="${f ? 'bad' : 'muted'}">${f}</dd></div>
          ${wrongEventReport.execDate ? `<div><dt>Run date</dt><dd>${esc(wrongEventReport.execDate)}</dd></div>` : ''}
        </dl>
      </div>
      <div class="flow-groups-wrap" style="padding:0 20px 16px;border-top:1px solid #f1f5f9;">
        <div class="flow-group" style="margin-top:12px">
          <div class="flow-group-row">
            <span class="flow-group-label">🟠 Wrong event names (arrived_container, container_unload, etc.)</span>
            <span class="flow-group-count">${p}/${t} — backend rejects unknown events entirely</span>
          </div>
          <div class="bar"><div class="bar-fill" style="width:${wePct}%;background:${f ? '#ef4444' : '#22c55e'}"></div></div>
        </div>
      </div>
    </section>`;
  })() : '';

  // failures section
  const sessionFails = session?.failures ?? [];
  const flowFails = flow?.failures ?? [];
  const failureCount = sessionFails.length + flowFails.length;
  const failuresHtml = failureCount === 0
    ? `<section class="panel panel-ok">
         <h2>Failures</h2>
         <p class="muted big">🎉 No failures today.</p>
       </section>`
    : `<section class="panel panel-fail">
         <h2>Failures <span class="count">${failureCount}</span></h2>
         ${sessionFails.map(f => {
           const seq = String(f.seq).startsWith('#') ? f.seq : `#${f.seq}`;
           return `
           <article class="failure">
             <header>
               <span class="seq">${esc(seq)}</span>
               <span class="ev-name">${esc(f.name)}</span>
               ${f.flow ? `<span class="tag tag-${f.flow.toLowerCase()}">${esc(f.flow)}</span>` : ''}
               ${f.place ? `<span class="tag tag-neutral">${esc(f.place)}</span>` : ''}
               ${f.sit ? `<span class="tag tag-neutral">${esc(f.sit)}</span>` : ''}
               ${f.ts ? `<span class="ts">${esc(f.ts)}</span>` : ''}
             </header>
             ${f.assertions.length ? `
             <table class="atable">
               <thead><tr><th></th><th>Field</th><th>Why</th><th>Actual</th><th>Expected</th></tr></thead>
               <tbody>
                 ${f.assertions.slice(0, 5).map(a => `
                   <tr class="${a.kind === 'blocked' ? 'row-blocked' : 'row-fail'}">
                     <td>${a.kind === 'blocked' ? '🚫' : '❌'}</td>
                     <td><code>${esc(a.field)}</code></td>
                     <td>${esc(a.summary)}</td>
                     <td>${a.actual ? `<code>${esc(a.actual)}</code>` : '<span class="muted">—</span>'}</td>
                     <td>${a.expected ? `<code class="exp">${esc(a.expected)}</code>` : '<span class="muted">—</span>'}</td>
                   </tr>`).join('')}
                 ${f.assertions.length > 5 ? `<tr><td colspan="5" class="muted">…and ${f.assertions.length - 5} more assertions</td></tr>` : ''}
               </tbody>
             </table>` : ''}
           </article>`;
         }).join('')}
         ${flowFails.map(f => `
           <article class="failure">
             <header>
               <span class="seq">${esc(f.sid)}</span>
               <span class="ev-name">${esc(f.sname || '(no name)')}</span>
               ${f.stype ? `<span class="tag tag-neutral">${esc(f.stype)}</span>` : ''}
               ${f.sgroup ? `<span class="tag tag-neutral">${esc(f.sgroup)}</span>` : ''}
               <span class="tag ${f.status === 'partial' ? 'tag-warn' : 'tag-negative'}">${esc(f.status.toUpperCase())}</span>
             </header>
             ${f.reason ? `<p class="reason">⛔ ${esc(f.reason)}</p>` : ''}
           </article>`).join('')}
       </section>`;

  // diff section
  const diffHtml = (() => {
    if (!diff) {
      return `<section class="panel">
        <h2>Vs prior run</h2>
        <p class="muted">First run captured — tomorrow's report will compare against today.</p>
      </section>`;
    }
    const block = (title, items, cls) => items.length
      ? `<div class="diff-block ${cls}">
           <h3>${esc(title)} <span class="count">${items.length}</span></h3>
           <ul>${items.map(k => `<li><code>${esc(k)}</code></li>`).join('')}</ul>
         </div>`
      : '';
    const blocks = [
      block('🆕 New failures', diff.newFails, 'd-new'),
      block('✅ Recovered', diff.recovered, 'd-ok'),
      block('⚠️ Still failing', diff.stillFailing, 'd-still'),
    ].join('');
    return `<section class="panel">
      <h2>Vs ${esc(diff.date)}</h2>
      ${blocks || '<p class="muted">No change since last run.</p>'}
    </section>`;
  })();

  const css = `
    *,*::before,*::after{box-sizing:border-box}
    html,body{margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Inter,sans-serif;
         background:#f6f7fb;color:#0f172a;font-size:14px;line-height:1.5;}
    .wrap{max-width:1100px;margin:0 auto;padding:24px;}
    .hero{background:linear-gradient(135deg,#1e293b 0%,#0f172a 50%,#312e81 100%);
          color:#fff;border-radius:14px;padding:28px 32px;box-shadow:0 10px 30px -10px rgba(15,23,42,.35);}
    .hero .eyebrow{font-size:.72rem;letter-spacing:.18em;text-transform:uppercase;color:#94a3b8;}
    .hero h1{font-size:1.8rem;margin:4px 0 12px;font-weight:700;letter-spacing:-.01em;}
    .hero .summary{display:flex;align-items:center;gap:10px;font-size:1rem;color:#e2e8f0;}
    .hero .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-top:22px;}
    .kpi{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);
         border-radius:10px;padding:14px 16px;}
    .kpi label{display:block;font-size:.7rem;letter-spacing:.12em;color:#94a3b8;text-transform:uppercase;margin-bottom:6px;}
    .kpi value{display:block;font-size:1.6rem;font-weight:700;}
    .kpi.ok value{color:#86efac}
    .kpi.bad value{color:#fca5a5}
    .kpi.dim value{color:#cbd5e1}

    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(440px,1fr));gap:18px;margin-top:18px;}
    .card{background:#fff;border-radius:12px;border:1px solid #e2e8f0;
          box-shadow:0 1px 2px rgba(15,23,42,.04);overflow:hidden;}
    .card-head{display:flex;justify-content:space-between;align-items:flex-start;
               padding:18px 20px;border-bottom:1px solid #f1f5f9;}
    .card-eyebrow{font-size:.68rem;letter-spacing:.16em;text-transform:uppercase;color:#64748b;}
    .card-head h2{margin:2px 0 0;font-size:1.05rem;font-weight:700;}
    .card-body{display:flex;align-items:center;gap:20px;padding:18px 20px;}
    .donut-wrap{flex:0 0 130px}
    .donut{width:130px;height:130px}
    .kvs{display:grid;grid-template-columns:1fr 1fr;gap:8px 18px;margin:0;flex:1;}
    .kvs > div{display:flex;flex-direction:column;}
    .kvs dt{font-size:.7rem;color:#64748b;text-transform:uppercase;letter-spacing:.08em;}
    .kvs dd{margin:0;font-size:1rem;font-weight:600;}
    .kvs dd.ok{color:#16a34a}
    .kvs dd.bad{color:#dc2626}
    .kvs dd.muted{color:#94a3b8}

    .pill{display:inline-block;padding:4px 12px;border-radius:999px;font-size:.7rem;font-weight:700;letter-spacing:.08em;}
    .pill-pass{background:#dcfce7;color:#166534}
    .pill-fail{background:#fee2e2;color:#991b1b}
    .pill-warn{background:#fef3c7;color:#92400e}

    .chips{display:flex;flex-wrap:wrap;gap:6px;padding:14px 20px 18px;border-top:1px solid #f1f5f9;}
    .chip{background:#f1f5f9;color:#334155;padding:4px 10px;border-radius:6px;font-size:.75rem;}
    .chip b{margin-right:6px;color:#64748b;font-weight:600;}

    .groups{padding:6px 20px 18px;border-top:1px solid #f1f5f9;}
    .group{margin-top:12px}
    .group-row{display:flex;justify-content:space-between;font-size:.78rem;margin-bottom:4px;}
    .group-label{font-weight:600;color:#334155}
    .group-counts{color:#64748b}
    .bar{background:#f1f5f9;height:8px;border-radius:4px;overflow:hidden;}\n    .flow-groups-wrap{}\n    .flow-group{margin-top:12px}\n    .flow-group-row{display:flex;justify-content:space-between;font-size:.82rem;margin-bottom:5px;}\n    .flow-group-label{font-weight:600;color:#334155;font-size:.88rem;}\n    .flow-group-count{color:#64748b;font-size:.82rem;}
    .bar-fill{height:100%;border-radius:4px;transition:width .4s ease;}

    .panel{background:#fff;border-radius:12px;border:1px solid #e2e8f0;padding:20px 22px;margin-top:18px;
           box-shadow:0 1px 2px rgba(15,23,42,.04);}
    .panel h2{font-size:1rem;margin:0 0 12px;display:flex;align-items:center;gap:10px;}
    .panel h2 .count{background:#fee2e2;color:#991b1b;font-size:.72rem;font-weight:700;
                     padding:2px 10px;border-radius:10px;}
    .panel-ok h2 .count, .d-ok h3 .count{background:#dcfce7;color:#166534}
    .panel.panel-fail{border-left:4px solid #ef4444}
    .panel.panel-ok{border-left:4px solid #22c55e}
    .muted{color:#94a3b8}
    .big{font-size:1.05rem;}

    .failure{background:#fffbfb;border:1px solid #fee2e2;border-radius:10px;padding:14px 16px;margin-bottom:10px;}
    .failure header{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:8px;}
    .failure .seq{background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:6px;font-weight:700;font-size:.78rem;}
    .failure .ev-name{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:700;color:#0f172a;}
    .failure .ts{margin-left:auto;font-size:.75rem;color:#94a3b8;}
    .tag{font-size:.7rem;font-weight:700;letter-spacing:.05em;padding:2px 8px;border-radius:10px;}
    .tag-positive{background:#dcfce7;color:#166534}
    .tag-negative{background:#fee2e2;color:#991b1b}
    .tag-update{background:#dbeafe;color:#1e40af}
    .tag-neutral{background:#e2e8f0;color:#475569;text-transform:none;font-weight:600;}
    .tag-warn{background:#fef3c7;color:#92400e}

    .atable{width:100%;border-collapse:collapse;margin-top:6px;font-size:.82rem;}
    .atable th{text-align:left;padding:6px 8px;color:#64748b;font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;
               border-bottom:1px solid #fee2e2;}
    .atable td{padding:8px 8px;border-bottom:1px solid #fff5f5;vertical-align:top;}
    .atable tr.row-blocked{background:#fffbeb}
    .atable code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#f8fafc;padding:1px 6px;border-radius:4px;font-size:.78rem;}
    .atable code.exp{background:#fee2e2;color:#991b1b;}
    .reason{margin:6px 0 0;color:#991b1b;font-size:.85rem;}

    .diff-block{margin-top:12px;}
    .diff-block h3{font-size:.85rem;margin:0 0 6px;display:flex;align-items:center;gap:8px;}
    .diff-block .count{background:#fee2e2;color:#991b1b;font-size:.7rem;font-weight:700;padding:2px 8px;border-radius:10px;}
    .diff-block ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:6px;}
    .diff-block li code{background:#f8fafc;border:1px solid #e2e8f0;padding:3px 8px;border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.78rem;}
    .d-new li code{background:#fee2e2;border-color:#fecaca;color:#991b1b}
    .d-ok li code{background:#dcfce7;border-color:#bbf7d0;color:#166534}
    .d-still li code{background:#fef3c7;border-color:#fde68a;color:#92400e}

    .sources{margin-top:18px;font-size:.78rem;color:#64748b;}
    .sources a{color:#475569;text-decoration:none;border-bottom:1px dotted #94a3b8;word-break:break-all;}

    @media (max-width:640px){
      .hero .kpis{grid-template-columns:repeat(2,1fr)}
      .card-body{flex-direction:column;align-items:flex-start}
      .donut-wrap{align-self:center}
    }
    @page{size:A4;margin:14mm 12mm;}
    @media print{
      body{background:#fff;font-size:12px;}
      .wrap{max-width:none;padding:0;}
      .hero{box-shadow:none;border-radius:10px;page-break-inside:avoid;}
      .card,.panel{box-shadow:none;page-break-inside:avoid;}
      .grid{grid-template-columns:1fr 1fr;}
      .failure{page-break-inside:avoid;}
      .sources a{border-bottom:none;color:#475569;}
    }
  `;

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Tracking Daily Summary — ${esc(date)}</title>
<style>${css}</style>
</head><body>
<div class="wrap">
  <div class="hero">
    <div class="eyebrow">Daily Tracking Summary</div>
    <h1>${esc(date)} · Logward x Shippeo E2E</h1>
    <div class="summary"><span style="font-size:1.4rem">${heroIcon}</span><span>${esc(heroText)}</span></div>
    <div class="kpis">
      <div class="kpi"><label>Overall</label><value class="${overallOk ? 'ok' : 'bad'}">${overallOk ? 'PASS' : 'FAIL'}</value></div>
      <div class="kpi dim"><label>Pass rate</label><value>${overallPct != null ? overallPct.toFixed(1) + '%' : '—'}</value></div>
      <div class="kpi dim"><label>Tests run</label><value>${totalRun}</value></div>
      <div class="kpi ${totalFail ? 'bad' : 'ok'}"><label>Failures</label><value>${totalFail}</value></div>
    </div>
  </div>

  <div class="grid">
    ${sessionHtml}
    ${flowHtml}
    ${wrongEventHtmlCard}
  </div>

  ${failuresHtml}
  ${diffHtml}

  <div class="sources">
    Sources:
    ${urls.map(u => `<div><a href="${esc(u)}">${esc(u)}</a></div>`).join('')}
    <div style="margin-top:6px">Generated ${new Date().toISOString()}</div>
  </div>
</div>
</body></html>`;
}

// ─────────────────────────── PDF (headless Chrome) ──────────────────
function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  for (const cmd of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']) {
    try {
      const out = execSync(`command -v ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      if (out) return out;
    } catch {}
  }
  return null;
}

function renderPdf(htmlPath, pdfPath) {
  return new Promise((resolve, reject) => {
    const chrome = findChrome();
    if (!chrome) return reject(new Error('Chrome/Chromium not found. Set CHROME_PATH or install Chrome.'));
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-pdf-header-footer',
      `--print-to-pdf=${pdfPath}`,
      `file://${htmlPath}`,
    ];
    const child = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      // Older Chrome builds reject --headless=new; retry with --headless.
      if (code !== 0 && /unrecognized command line/i.test(stderr) || /--headless=new/i.test(stderr) && code !== 0) {
        const retryArgs = args.map(a => a === '--headless=new' ? '--headless' : a);
        const retry = spawn(chrome, retryArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
        let rErr = '';
        retry.stderr.on('data', d => { rErr += d.toString(); });
        retry.on('error', reject);
        retry.on('close', rCode => rCode === 0 ? resolve() : reject(new Error(`Chrome PDF exit ${rCode}: ${rErr || stderr}`)));
        return;
      }
      if (code === 0 && fs.existsSync(pdfPath)) resolve();
      else reject(new Error(`Chrome PDF exit ${code}: ${stderr.slice(0, 400)}`));
    });
  });
}

// ─────────────────────────── main ────────────────────────────────────
async function main() {
  const urls = process.argv.slice(2);
  if (urls.length < 1 || urls.length > 3) {
    console.error('Usage: node daily-tracking-summary.mjs <session-report-url> <flow-report-url>');
    process.exit(2);
  }
  // Fetch all URLs, auto-classify: session with ONLY wrong-event badges = wrong-event report
  // A session that also has POSITIVE/NEGATIVE/LEGACY flows is a main session (mixed run)
  const allHtmls = await Promise.all(urls.map(blobToRaw).map(fetchText));
  const isWrongEventSession = (h) => {
    const hasWrong = (h.match(/<span class="flow-wrong"/g) || []).length > 3;
    const hasPositive = /<span class="flow-pos"/.test(h);
    const hasNegative = /<span class="flow-neg"/.test(h);
    const hasLegacy = /<span class="flow-legacy"/.test(h);
    return hasWrong && !hasPositive && !hasNegative && !hasLegacy;
  };
  const mainHtmls    = allHtmls.filter(h => !isWrongEventSession(h));
  const wrongEventHtmlRaw = allHtmls.find(h => isWrongEventSession(h)) || null;
  const reports      = mainHtmls.slice(0, 2).map(parseReport);
  const wrongEventReport = wrongEventHtmlRaw ? parseSession(wrongEventHtmlRaw) : null;
  const date = reports.map(pickDate).sort()[0] || new Date().toISOString().slice(0, 10);

  const todayKeys = [];
  for (const r of reports) {
    if (r.kind === 'session') for (const f of r.failures) todayKeys.push(sessionKey(f));
    if (r.kind === 'flow')    for (const f of r.failures) todayKeys.push(flowKey(f));
  }
  const prev = findPrev(date);
  const diff = computeDiff(todayKeys, prev);

  const html = buildHtml(reports, diff, date, urls, wrongEventReport);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const htmlPath = path.join(OUT_DIR, `${date}.html`);
  const pdfPath  = path.join(OUT_DIR, `${date}.pdf`);
  fs.writeFileSync(htmlPath, html);
  fs.writeFileSync(path.join(OUT_DIR, `${date}.json`), JSON.stringify({ date, failureKeys: todayKeys }, null, 2));

  let pdfOk = false;
  try {
    await renderPdf(htmlPath, pdfPath);
    pdfOk = true;
  } catch (e) {
    console.error(`⚠️  PDF generation skipped: ${e.message}`);
  }

  // Quick one-line console summary so terminal output stays useful
  const tl = buildMarkdown(reports, diff, date, wrongEventReport);
  process.stdout.write(tl + '\n');
  console.error(`\n📄 HTML → ${htmlPath}`);
  if (pdfOk) console.error(`📕 PDF  → ${pdfPath}`);
  console.error(`💡 Open: open "${htmlPath}"${pdfOk ? `  •  open "${pdfPath}"` : ''}`);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
