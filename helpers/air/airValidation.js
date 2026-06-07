// @ts-check
// ─────────────────────────────────────────────────────────────────────────────
//  helpers/air/airValidation.js
//
//  Object validation utilities — used by TC002_ObjectValidation.spec.js.
//
//  Handles:
//    • ISO-8601 and MySQL "YYYY-MM-DD HH:mm:ss" datetime comparison (UTC, ±1s)
//    • null / undefined / empty-string equivalence
//    • Array equality (JSON-serialised)
//    • Plain string equality (trimmed)
//
//  assertField(atu, key, expected)
//    Logs ✅ / ❌ per field and calls Playwright's expect() so the test fails
//    with a human-readable diff if there is a mismatch.
// ─────────────────────────────────────────────────────────────────────────────

const { expect } = require('@playwright/test');

/**
 * Normalise a BE date string to ISO-8601 UTC so Date.parse() can compare it.
 * MySQL stores: "2026-05-07 06:46:00" (UTC, no TZ suffix).
 * Node.js parses that as LOCAL time unless we append 'Z'.
 *
 * @param {any} s
 * @returns {any}
 */
function normalizeDate(s) {
  if (typeof s !== 'string') return s;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
    return s.replace(' ', 'T') + 'Z';
  }
  return s;
}

/**
 * Deep-equal comparison with datetime awareness.
 *
 * Dates are compared at SECOND precision because:
 *   • payload dates may include sub-second components (.000Z)
 *   • the BE stores dates as MySQL "YYYY-MM-DD HH:mm:ss" (no ms)
 *
 * @param {any} actual
 * @param {any} expected
 * @returns {boolean}
 */
function valuesMatch(actual, expected) {
  // null / undefined / empty-string treated as equivalent
  if (expected == null) return actual == null || actual === undefined || actual === '';

  // Array — JSON comparison
  if (Array.isArray(expected)) return JSON.stringify(actual) === JSON.stringify(expected);

  // Date strings — normalise to UTC ms then compare at seconds precision
  const eMs = Date.parse(String(expected));
  if (!isNaN(eMs)) {
    const aMs = Date.parse(normalizeDate(String(actual)));
    if (!isNaN(aMs)) return Math.floor(eMs / 1000) === Math.floor(aMs / 1000);
  }

  // Plain string — trimmed equality
  return String(actual ?? '').trim() === String(expected).trim();
}

/**
 * Assert that `atu[key]` matches `expected`.
 * Logs a labelled ✅ / ❌ line and calls expect() so Playwright reports a
 * proper failure with actual vs expected diff.
 *
 * @param {object | null | undefined} atu       The ATU snapshot from the BE
 * @param {string}                    key       ATU field name
 * @param {any}                       expected  Expected value (string | null | array)
 */
function assertField(atu, key, expected) {
  const actual = atu?.[key];
  const ok     = valuesMatch(actual, expected);
  console.log(`  ${ok ? '✅' : '❌'} [${key}]  actual="${actual}"  expected="${expected}"`);
  expect(
    ok,
    `Field "${key}": expected=${JSON.stringify(expected)}, got=${JSON.stringify(actual)}`
  ).toBe(true);
}

module.exports = { normalizeDate, valuesMatch, assertField };
