// ─────────────────────────────────────────────────────────────────────────────
//  helpers/e2e/auditHelpers.js
//
//  Audit History helpers for Events-Out verification.
//
//  Confirmed endpoint (from network tab):
//    GET /api/tower/audit/{objectCode}?schemaType=TUContainer&isAdmin=true&p=0&s=100
//    Authorization: Bearer {admin_token}
//
//  Response: { data: [ { event, placeType, milestone, createdAt, ... }, ... ] }
// ─────────────────────────────────────────────────────────────────────────────

const { request, expect } = require('@playwright/test');
const { E2E_CONFIG } = require('./e2eConfig');

const adminHeaders = () => ({
  'Authorization': `Bearer ${E2E_CONFIG.ADMIN_TOKEN}`,
  'accept':        'application/json',
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch the audit history for a tracking object.
 * objectCode is in the URL path — not a query param.
 *
 * @param objectCode  Logward internal object code
 * @param schemaType  e.g. 'TUContainer' (default)
 * @returns Array of audit entries (empty array on error/no entries)
 */
async function getAuditHistory(objectCode, schemaType = E2E_CONFIG.OCEAN.SCHEMA_TYPE) {
  const ctx = await request.newContext({ baseURL: E2E_CONFIG.ADMIN_BASE_URL });
  try {
    const res = await ctx.get(`/api/tower/audit/${objectCode}`, {
      headers: adminHeaders(),
      params:  {
        schemaType,
        isAdmin: true,
        p:       0,
        s:       100,
      },
    });

    if (!res.ok()) {
      console.warn(`  [audit] GET → HTTP ${res.status()} for objectCode="${objectCode}"`);
      return [];
    }

    const body = await res.json();
    const entries = Array.isArray(body) ? body : (body.data ?? body.entries ?? body.results ?? []);
    console.log(`  [audit] Found ${entries.length} entries for objectCode="${objectCode}"`);
    return entries;

  } finally {
    await ctx.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Poll the audit history until an entry matching `criteria` appears, or timeout.
 *
 * @param objectCode
 * @param criteria    Partial match: { event?, placeType?, milestone? }
 * @param [timeoutMs]
 */
async function pollUntilAuditEntry(objectCode, criteria, timeoutMs = E2E_CONFIG.AUDIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const entries = await getAuditHistory(objectCode).catch(() => []);
    const match   = findAuditEntry(entries, criteria);
    if (match) {
      console.log(`  [audit ✅] Entry found:`, JSON.stringify(criteria));
      return match;
    }
    console.log(`  [audit ⏳] No match yet for:`, JSON.stringify(criteria));
    await new Promise(r => setTimeout(r, E2E_CONFIG.POLL_INTERVAL_MS));
  }

  console.warn(`  [audit ⚠️] Timed out after ${timeoutMs}ms.`);
  const entries = await getAuditHistory(objectCode).catch(() => []);
  return findAuditEntry(entries, criteria);
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find the first audit entry that matches all non-undefined criteria fields.
 *
 * Matching is case-insensitive for strings.
 *
 * @param entries
 * @param criteria  { event?, placeType?, milestone?, situationType? }
 */
function findAuditEntry(entries, criteria) {
  return entries.find(e => {
    for (const [key, val] of Object.entries(criteria)) {
      if (val === undefined) continue;
      const actual = (e[key] ?? '').toString().toLowerCase();
      if (actual !== val.toString().toLowerCase()) return false;
    }
    return true;
  });
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Assert that an audit entry matching `criteria` exists in `entries`.
 * Logs ✅ / ❌ and calls Playwright's expect() for failure reporting.
 *
 * @param entries
 * @param criteria
 */
function assertAuditEntry(entries, criteria) {
  const match = findAuditEntry(entries, criteria);
  const ok    = !!match;
  console.log(
    `  ${ok ? '✅' : '❌'} [audit] criteria=${JSON.stringify(criteria)}` +
    (match ? `  matched: ${JSON.stringify(match)}` : '  — NOT FOUND')
  );
  expect(ok, `Expected audit entry: ${JSON.stringify(criteria)}`).toBe(true);
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Assert lastUpdated / lastChangedAt has changed compared to `baseline`.
 *
 * @param otu       Latest OTU snapshot
 * @param baseline  lastChangedAt value BEFORE the webhook
 */
function assertLastUpdatedChanged(otu, baseline) {
  const current = otu?.lastChangedAt ?? null;
  const ok      = current !== null && current !== baseline;
  console.log(
    `  ${ok ? '✅' : '❌'} [lastUpdated] baseline="${baseline}" → current="${current}"`
  );
  expect(ok, `Expected lastChangedAt to change from "${baseline}"`).toBe(true);
}

module.exports = {
  getAuditHistory,
  pollUntilAuditEntry,
  findAuditEntry,
  assertAuditEntry,
  assertLastUpdatedChanged,
};
