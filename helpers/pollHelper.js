// @ts-check
// ─────────────────────────────────────────────────────────────────────────────
//  helpers/pollHelper.js
//
//  Generic polling utility used by all tracking mapping tests.
//  Repeatedly calls fetchFn until conditionFn returns truthy or timeout is hit.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Poll `fetchFn` every `intervalMs` until `conditionFn(result)` is true,
 * or until `timeoutMs` elapses.
 *
 * @template T
 * @param {() => Promise<T>}     fetchFn      Async function that fetches the current state
 * @param {(result: T) => boolean} conditionFn  Returns true when the expected state is reached
 * @param {object}  [opts]
 * @param {number}  [opts.intervalMs=3000]     Polling interval in milliseconds
 * @param {number}  [opts.timeoutMs=30000]     Maximum time to wait in milliseconds
 * @param {string}  [opts.label='']            Label shown in timeout error message
 * @returns {Promise<T>}  The last result returned by fetchFn when condition was met
 * @throws {Error} If the condition is not met within timeoutMs
 */
async function pollUntil(fetchFn, conditionFn, { intervalMs = 3000, timeoutMs = 30000, label = '' } = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await fetchFn();
    if (conditionFn(result)) return result;
    await new Promise(r => setTimeout(r, intervalMs));
  }

  throw new Error(
    `pollUntil timed out after ${timeoutMs}ms${label ? ` waiting for: ${label}` : ''}`
  );
}

module.exports = { pollUntil };
