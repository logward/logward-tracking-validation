// ─────────────────────────────────────────────────────────────────────────────
//  helpers/shared/cognitoAuth.js
//
//  Auto-refreshing Logward Cognito admin token.
//  Uses amazon-cognito-identity-js to authenticate programmatically —
//  same flow as the Logward frontend login, no DevTools needed.
//
//  Setup: add credentials once in e2eConfig.js COGNITO section:
//    username: 'your.email@logward.com'
//    password: 'your-password'
//
//  Token lifetime: ~1 hour (Cognito access token)
//  Auto-refreshes: yes — re-authenticates when token has < 2 min left
// ─────────────────────────────────────────────────────────────────────────────

const {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
} = require('amazon-cognito-identity-js');
const fs   = require('fs');
const path = require('path');

// Cache file is per-environment — qa and prod tokens must never mix.
function cacheFileFor(envName) {
  return path.resolve(__dirname, `../../.cognito-token-cache.${envName}.json`);
}

// In-memory cache, also keyed per-environment.
const _cachedTokens = {}; // envName -> { token, expMs }

function loadCachedToken(envName) {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFileFor(envName), 'utf8'));
    return raw.token && raw.expMs ? raw : null;
  } catch { return null; }
}

function saveCachedToken(envName, token, expMs) {
  try {
    fs.writeFileSync(cacheFileFor(envName), JSON.stringify({ token, expMs }, null, 2), 'utf8');
  } catch { /* ignore */ }
}

const BUFFER_MS = 120_000; // refresh 2 min before expiry

// ─────────────────────────────────────────────────────────────────────────────

function decodeJwtExpiry(token) {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const { exp } = JSON.parse(Buffer.from(part, 'base64').toString('utf8'));
    return exp ? exp * 1000 : 0;
  } catch { return 0; }
}

function formatExpiry(ms) {
  const mins = Math.round((ms - Date.now()) / 60000);
  return `${new Date(ms).toISOString()}  (${mins > 0 ? `in ${mins} min` : 'EXPIRED'})`;
}

// ─────────────────────────────────────────────────────────────────────────────

function authenticateWithCognito(username, password, userPoolId, clientId) {
  return new Promise((resolve, reject) => {
    const pool = new CognitoUserPool({ UserPoolId: userPoolId, ClientId: clientId });
    const user = new CognitoUser({ Username: username, Pool: pool });
    const auth = new AuthenticationDetails({ Username: username, Password: password });

    user.authenticateUser(auth, {
      onSuccess(session) {
        resolve(session.getAccessToken().getJwtToken());
      },
      onFailure(err) {
        reject(new Error(`Cognito login failed: ${err.message || err}`));
      },
      newPasswordRequired() {
        reject(new Error('Cognito: new password required — log in via browser first to complete setup'));
      },
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a valid Logward Cognito access token.
 * Auto-authenticates when the token has < 2 min remaining.
 */
async function getAdminToken() {
  const { E2E_CONFIG } = require('./e2eConfig');
  const envName = E2E_CONFIG.ENV_NAME;
  const pool    = E2E_CONFIG.COGNITO_POOL;

  // 0. No known Cognito pool for this environment (e.g. sandbox) — use the
  //    manually-pasted ADMIN_TOKEN instead of logging in.
  if (!pool) {
    if (E2E_CONFIG.ADMIN_TOKEN) return E2E_CONFIG.ADMIN_TOKEN;
    throw new Error(
      `\n  ╔══ No Cognito pool or ADMIN_TOKEN for env "${envName}" ═══════╗\n` +
      '  ║  Either add a pool to COGNITO_POOLS in e2eConfig.js,         ║\n' +
      '  ║  or paste a static admin token into the TOKENS section.      ║\n' +
      '  ╚══════════════════════════════════════════════════════════════╝\n'
    );
  }

  const cognito = E2E_CONFIG.COGNITO;

  // 1. Return in-memory cached token if still valid
  const memCached = _cachedTokens[envName];
  if (memCached && Date.now() < memCached.expMs - BUFFER_MS) {
    return memCached.token;
  }

  // 2. Try disk cache — survives across describe block boundaries in Playwright
  const diskCached = loadCachedToken(envName);
  if (diskCached && Date.now() < diskCached.expMs - BUFFER_MS) {
    _cachedTokens[envName] = diskCached;
    return diskCached.token;
  }

  // 3. Authenticate via Cognito using credentials (retry once on network error)
  if (!cognito?.username || !cognito?.password || cognito.password.startsWith('<')) {
    throw new Error(
      '\n  ╔══ Cognito credentials needed ════════════════════════════════╗\n' +
      '  ║  Admin token expired and no credentials set.                 ║\n' +
      '  ║                                                              ║\n' +
      '  ║  Add to e2eConfig.js COGNITO section:                        ║\n' +
      '  ║    username: "your.email@logward.com"                        ║\n' +
      '  ║    password: "your-password"                                 ║\n' +
      '  ╚══════════════════════════════════════════════════════════════╝\n'
    );
  }

  console.log(`\n  [cognitoAuth] Logging in as ${cognito.username} (${envName} pool)...`);

  // Retry once on transient network errors
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const token = await authenticateWithCognito(cognito.username, cognito.password, pool.userPoolId, pool.clientId);
      const expMs = decodeJwtExpiry(token) || (Date.now() + 55 * 60 * 1000);
      _cachedTokens[envName] = { token, expMs };
      saveCachedToken(envName, token, expMs);
      console.log(`  [cognitoAuth] ✅ Logged in — token expires ${formatExpiry(expMs)}`);
      return token;
    } catch (e) {
      lastErr = e;
      if (attempt < 2 && e.message.includes('Network')) {
        console.warn(`  [cognitoAuth] Network error, retrying in 3s...`);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }
  throw lastErr;
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = { getAdminToken };
