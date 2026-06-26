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

const CACHE_FILE = path.resolve(__dirname, '../../.cognito-token-cache.json');

let _cachedToken  = null;
let _tokenExpMs   = 0;

function loadCachedToken() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return raw.token && raw.expMs ? raw : null;
  } catch { return null; }
}

function saveCachedToken(token, expMs) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ token, expMs }, null, 2), 'utf8');
  } catch { /* ignore */ }
}

const BUFFER_MS   = 120_000; // refresh 2 min before expiry

// Cognito pool config — same pool the Logward frontend uses
const USER_POOL_ID = 'eu-central-1_GIl1izT7B';
const CLIENT_ID    = 'mhq6h7v6n2cdvj9msjooq8kh4';

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

function authenticateWithCognito(username, password) {
  return new Promise((resolve, reject) => {
    const pool = new CognitoUserPool({ UserPoolId: USER_POOL_ID, ClientId: CLIENT_ID });
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
  const cognito = E2E_CONFIG.COGNITO;

  // 1. Return in-memory cached token if still valid
  if (_cachedToken && Date.now() < _tokenExpMs - BUFFER_MS) {
    return _cachedToken;
  }

  // 2. Try disk cache — survives across describe block boundaries in Playwright
  if (!_cachedToken) {
    const cached = loadCachedToken();
    if (cached && Date.now() < cached.expMs - BUFFER_MS) {
      _cachedToken = cached.token;
      _tokenExpMs  = cached.expMs;
      return _cachedToken;
    }
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

  console.log(`\n  [cognitoAuth] Logging in as ${cognito.username}...`);

  // Retry once on transient network errors
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      _cachedToken = await authenticateWithCognito(cognito.username, cognito.password);
      _tokenExpMs  = decodeJwtExpiry(_cachedToken) || (Date.now() + 55 * 60 * 1000);
      saveCachedToken(_cachedToken, _tokenExpMs);
      console.log(`  [cognitoAuth] ✅ Logged in — token expires ${formatExpiry(_tokenExpMs)}`);
      return _cachedToken;
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
