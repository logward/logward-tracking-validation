// ─────────────────────────────────────────────────────────────────────────────
//  helpers/tokenHelper.js
//
//  Shared token utilities for all tracking mapping tests.
//  Decodes a Cognito access-token JWT and warns if it is expired or near expiry.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check a Cognito JWT and log its remaining lifetime.
 *
 * @param token      Raw JWT string
 * @param envVarName Name of the env-var the caller should set to refresh (e.g. "AIR_ADMIN_TOKEN")
 * @param label      Short label shown in log lines (e.g. "AIR ADMIN")
 */
function checkTokenExpiry(token, envVarName, label = 'ADMIN') {
  try {
    const payload  = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    const expiresAt = new Date(payload.exp * 1000);
    const now       = new Date();
    const minsLeft  = Math.floor((expiresAt - now) / 60000);

    if (minsLeft <= 0) {
      console.warn(`\n⚠️  ${label}_TOKEN is EXPIRED (expired ${Math.abs(minsLeft)} min ago at ${expiresAt.toISOString()})`);
      console.warn(`   Requests requiring this token will return HTTP 401.`);
      console.warn(`   Refresh:\n     export ${envVarName}="eyJ..."\n`);
    } else if (minsLeft < 15) {
      console.warn(`\n⚠️  ${label}_TOKEN expires in ${minsLeft} min (${expiresAt.toISOString()}) — consider refreshing before running.\n`);
    } else {
      console.log(`[Token] ${label}_TOKEN valid for ${minsLeft} min (expires ${expiresAt.toISOString()})`);
    }
  } catch {
    // ignore decode errors — non-JWT tokens or malformed values
  }
}

module.exports = { checkTokenExpiry };
