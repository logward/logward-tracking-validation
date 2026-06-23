#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  scripts/publishReports.js
//
//  Commits all HTML reports + a summary index page to the current branch.
//  Share the index link with teammates — one link, all reports listed.
//
//  Usage:
//    node scripts/publishReports.js
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const ROOT          = path.resolve(__dirname, '..');
const SESSIONS_DIR  = path.join(ROOT, 'playwright-report', 'sessions');
const RUNS_DIR      = path.join(ROOT, 'playwright-report', 'runs');
const SUMMARIES_DIR = path.join(ROOT, 'playwright-report', 'summaries');
const REPO          = 'logward/logward-tracking-validation';

function run(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }).trim();
}

function collectReports(branch) {
  const reports = [];

  if (fs.existsSync(SESSIONS_DIR)) {
    fs.readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.html'))
      .sort().reverse()
      .forEach(f => {
        const date = f.replace('session-', '').replace('.html', '').replace('T', ' ').slice(0, 16);
        const filePath = `playwright-report/sessions/${f}`;
        const url = `https://htmlpreview.github.io/?https://github.com/${REPO}/blob/${branch}/${filePath}`;
        reports.push({ type: 'Events-Out', date, url, filePath });
      });
  }

  if (fs.existsSync(RUNS_DIR)) {
    fs.readdirSync(RUNS_DIR).sort().reverse().forEach(runDir => {
      const oceanDir = path.join(RUNS_DIR, runDir, 'ocean');
      if (!fs.existsSync(oceanDir)) return;
      fs.readdirSync(oceanDir).filter(f => f.endsWith('.html')).forEach(f => {
        const date = runDir.replace('T', ' ').slice(0, 16);
        const filePath = `playwright-report/runs/${runDir}/ocean/${f}`;
        const url = `https://htmlpreview.github.io/?https://github.com/${REPO}/blob/${branch}/${filePath}`;
        reports.push({ type: 'Orders-In', date, url, filePath });
      });
    });
  }

  if (fs.existsSync(SUMMARIES_DIR)) {
    fs.readdirSync(SUMMARIES_DIR)
      .filter(f => f.endsWith('.html'))
      .sort().reverse()
      .forEach(f => {
        const date = f.replace('summary-', '').replace('.html', '');
        const filePath = `playwright-report/summaries/${f}`;
        const url = `https://htmlpreview.github.io/?https://github.com/${REPO}/blob/${branch}/${filePath}`;
        reports.push({ type: 'Daily Summary', date, url, filePath });
      });
  }

  return reports;
}

function buildIndex(reports, branch) {
  const indexUrl = `https://htmlpreview.github.io/?https://github.com/${REPO}/blob/${branch}/reports-index.html`;

  const rows = reports.map(r => `
    <tr>
      <td><span class="badge ${r.type === 'Events-Out' ? 'ev' : r.type === 'Daily Summary' ? 'ds' : 'oi'}">${r.type}</span></td>
      <td class="date">${r.date} UTC</td>
      <td><a href="${r.url}" target="_blank">Open Report →</a></td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>Logward QA — Test Reports</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f2f5;color:#1a1a2e;font-size:14px;}
    .hdr{background:linear-gradient(135deg,#1a1a2e,#0f3460);color:#fff;padding:28px 40px;}
    .hdr h1{font-size:1.5rem;font-weight:700;}
    .hdr p{color:#a0aec0;margin-top:6px;font-size:.85rem;}
    .body{max-width:960px;margin:32px auto;padding:0 20px;}
    .summary{display:flex;gap:16px;margin-bottom:24px;flex-wrap:wrap;}
    .stat{background:#fff;border-radius:8px;padding:16px 24px;box-shadow:0 1px 4px rgba(0,0,0,.08);min-width:140px;}
    .stat .n{font-size:2rem;font-weight:700;color:#2b6cb0;}
    .stat .l{font-size:.78rem;color:#718096;margin-top:2px;}
    table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);}
    th{background:#2d3748;color:#fff;padding:11px 16px;text-align:left;font-size:.78rem;text-transform:uppercase;letter-spacing:.05em;}
    td{padding:11px 16px;border-bottom:1px solid #e2e8f0;font-size:.875rem;}
    tr:last-child td{border-bottom:none;}
    tr:hover td{background:#f7fafc;}
    a{color:#3182ce;text-decoration:none;font-weight:600;}
    a:hover{text-decoration:underline;}
    .badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:.7rem;font-weight:700;}
    .badge.ev{background:#c6f6d5;color:#22543d;}
    .badge.oi{background:#bee3f8;color:#2a4365;}
    .badge.ds{background:#e9d8fd;color:#44337a;}
    .date{color:#718096;font-size:.82rem;white-space:nowrap;}
  </style>
</head>
<body>
  <div class="hdr">
    <h1>Logward QA — Test Reports</h1>
    <p>Ocean Tracking · Logward ↔ Shippeo Integration · Branch: ${branch}</p>
  </div>
  <div class="body">
    <div class="summary">
      <div class="stat"><div class="n">${reports.length}</div><div class="l">Total Reports</div></div>
      <div class="stat"><div class="n">${reports.filter(r=>r.type==='Events-Out').length}</div><div class="l">Events-Out Sessions</div></div>
      <div class="stat"><div class="n">${reports.filter(r=>r.type==='Orders-In').length}</div><div class="l">Orders-In Runs</div></div>
    </div>
    <table>
      <thead><tr><th>Type</th><th>Date (UTC)</th><th>Report</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</body>
</html>`;
}

function main() {
  const branch = run('git rev-parse --abbrev-ref HEAD');
  console.log(`\n📋 Branch: ${branch}`);

  const reports = collectReports(branch);
  console.log(`📁 Found ${reports.length} report(s)`);

  if (!reports.length) {
    console.log('⚠  No HTML reports found.');
    return;
  }

  // Write summary index
  const indexPath = path.join(ROOT, 'reports-index.html');
  fs.writeFileSync(indexPath, buildIndex(reports, branch));

  // Stage all report files + index
  const filesToAdd = reports.map(r => `"${r.filePath}"`).join(' ');
  execSync(`git add -f ${filesToAdd} "reports-index.html"`, { cwd: ROOT, stdio: 'inherit' });

  try {
    run(`git commit -m "chore: publish ${reports.length} reports + index [${new Date().toISOString().slice(0,16)}]"`);
  } catch {
    console.log('ℹ  Nothing new to commit — already up to date.');
  }

  execSync(`git push origin ${branch}`, { cwd: ROOT, stdio: 'inherit' });

  const indexUrl = `https://htmlpreview.github.io/?https://github.com/${REPO}/blob/${branch}/reports-index.html`;

  console.log('\n✅ Reports published!\n');
  console.log('━'.repeat(60));
  console.log('📌 SHARE THIS LINK — all reports in one page:');
  console.log(`\n   ${indexUrl}\n`);
  console.log('━'.repeat(60));
  console.log(`\n   Latest Events-Out : ${reports.find(r=>r.type==='Events-Out')?.url}`);
  console.log(`   Latest Orders-In  : ${reports.find(r=>r.type==='Orders-In')?.url}`);
  console.log('');
}

main();
