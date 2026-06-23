// ─────────────────────────────────────────────────────────────────────────────
//  helpers/e2e/shippeoAuth.js
//
//  Auto-refreshing Shippeo access token.
//
//  How it works:
//    1. In-memory cached token   — instant, no network
//    2. Static access_token      — valid on run start
//    3. Disk cache refresh_token — survives process restarts within 4h window
//    4. Config refresh_token     — manual seed fallback
//
//  The refresh_token chain is self-sustaining within a session:
//    Every refresh call returns a new refresh_token → saved to disk cache
//    → used for the next refresh → chain never breaks while tests are running
//
//  Only breaks when idle > 4h (overnight). When that happens:
//    Run:  node helpers/e2e/seedShippeoToken.js
//    This opens a browser window, you log in once, token chain starts again.
//
//  Permanent fix (ask Shippeo team):
//    Option A: Enable grant_type=password on client 4571962d-46de-4590-b196-2d46deb59066
//    Option B: Provide a service account with native Shippeo IAM (not Google SSO)
// ─────────────────────────────────────────────────────────────────────────────

const https = require('https');
const fs    = require('fs');
const path  = require('path');

let _cachedAccessToken  = null;
let _accessExpMs        = 0;
let _cachedRefreshToken = null;

const TOKEN_URL = 'https://auth.shippeo.com/auth/main/oauth/token';
const CLIENT_ID  = '4571962d-46de-4590-b196-2d46deb59066';
const SCOPE      = 'openid roles profile offline_access full_profile termsOfUse:1.0';
const CACHE_FILE = path.resolve(__dirname, '../../.shippeo-token-cache.json');
const BUFFER_MS  = 120_000;

// ─────────────────────────────────────────────────────────────────────────────

function decodeJwtPayload(token) {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(part, 'base64').toString('utf8'));
  } catch { return {}; }
}

function tokenExpiresAt(token) {
  const { exp } = decodeJwtPayload(token);
  return exp ? exp * 1000 : 0;
}

function formatExpiry(ms) {
  if (!ms) return 'unknown';
  const mins = Math.round((ms - Date.now()) / 60000);
  return `${new Date(ms).toISOString()}  (${mins > 0 ? `in ${mins} min` : 'EXPIRED'})`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Disk cache
// ─────────────────────────────────────────────────────────────────────────────

function loadCachedRefreshToken() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    return JSON.parse(raw).refresh_token || null;
  } catch { return null; }
}

function saveCachedRefreshToken(refreshToken) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ refresh_token: refreshToken }, null, 2), 'utf8');
  } catch (e) {
    console.warn(`  [shippeoAuth] Could not save token cache: ${e.message}`);
  }
}

function cacheTokenResponse(data) {
  _cachedAccessToken = data.access_token;
  _accessExpMs       = tokenExpiresAt(_cachedAccessToken) || (Date.now() + 14 * 60 * 1000);
  if (data.refresh_token) {
    _cachedRefreshToken = data.refresh_token;
    saveCachedRefreshToken(data.refresh_token);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Refresh token grant
// ─────────────────────────────────────────────────────────────────────────────

function postForm(body) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(body).toString();
    const url  = new URL(TOKEN_URL);
    const req  = https.request({
      hostname: url.hostname,
      path:     url.pathname,
      method:   'POST',
      headers:  {
        'Content-Type':    'application/x-www-form-urlencoded',
        'Content-Length':  Buffer.byteLength(data),
        'accept':          'application/json, text/plain, */*',
        'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8',
        'origin':          'https://inthebackofthetruck.shippeo.io',
        'referer':         'https://inthebackofthetruck.shippeo.io/',
        'user-agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 300)}`));
        else { try { resolve(JSON.parse(raw)); } catch { reject(new Error(`Non-JSON: ${raw.slice(0, 200)}`)); } }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────

function fetchTokenFromCredentials(username, password, baseUrl) {
  return new Promise((resolve, reject) => {
    const credentials = Buffer.from(`${username}:${password}`).toString('base64');
    const url = new URL(`${baseUrl}/api/tokens`);
    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname,
      method:   'POST',
      headers:  {
        'Authorization': `Basic ${credentials}`,
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 300)}`));
          return;
        }
        try {
          const body  = JSON.parse(raw);
          const token = body?.data?.token;
          if (!token) reject(new Error(`No token in response: ${raw.slice(0, 200)}`));
          else        resolve(token);
        } catch { reject(new Error(`Non-JSON: ${raw.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a valid Shippeo access token, auto-refreshing as needed.
 */
async function getShippeoToken() {
  const { E2E_CONFIG } = require('./e2eConfig');
  const shippeo  = E2E_CONFIG.SHIPPEO;
  const clientId = shippeo.clientId || CLIENT_ID;

  // ── 1. Return in-memory cached token if still valid ───────────────────────
  if (_cachedAccessToken && Date.now() < _accessExpMs - BUFFER_MS) {
    return _cachedAccessToken;
  }

  // ── 2. Try credentials-based API (SHIPPEO_USERNAME + SHIPPEO_PASSWORD) ─────
  const username = shippeo.Username || shippeo.username;
  const password = shippeo.Password || shippeo.password;
  if (username && password && !username.startsWith('<') && !password.startsWith('<')) {
    try {
      console.log(`\n  [shippeoAuth] Fetching token via credentials API...`);
      const token = await fetchTokenFromCredentials(username, password, shippeo.authBaseUrl);
      _cachedAccessToken = token;
      const exp    = tokenExpiresAt(token);
      _accessExpMs = exp || (Date.now() + 55 * 60 * 1000);
      console.log(`  [shippeoAuth] ✅ Token obtained via credentials`);
      console.log(`  [shippeoAuth] Token: ${token}`);
      if (exp) console.log(`  [shippeoAuth] Token expires: ${formatExpiry(exp)}`);
      return _cachedAccessToken;
    } catch (e) {
      console.warn(`  [shippeoAuth] Credentials fetch failed: ${e.message} — falling back to refresh token`);
    }
  }

  // ── 3. Try static access_token from config ────────────────────────────────
  if (!_cachedAccessToken && shippeo.token && shippeo.token !== '' && !shippeo.token.startsWith('<')) {
    const exp = tokenExpiresAt(shippeo.token);
    if (exp - Date.now() > BUFFER_MS) {
      _cachedAccessToken = shippeo.token;
      _accessExpMs       = exp;
      console.log(`\n  [shippeoAuth] Using config access token (expires ${formatExpiry(exp)})`);
      return _cachedAccessToken;
    }
  }

  // ── 4. Try refresh token — disk cache first (freshest), then config ─────────
  const refreshToken = _cachedRefreshToken || loadCachedRefreshToken() ||
    (shippeo.refreshToken && !shippeo.refreshToken.startsWith('<') && shippeo.refreshToken !== ''
      ? shippeo.refreshToken : null);

  if (!refreshToken) {
    throw new Error(
      '\n  ╔══ Shippeo token needed ═══════════════════════════════════════╗\n' +
      '  ║  No valid token found. Set in .env:                          ║\n' +
      '  ║                                                              ║\n' +
      '  ║    SHIPPEO_USERNAME=your.email@shippeo.com                   ║\n' +
      '  ║    SHIPPEO_PASSWORD=your-password                            ║\n' +
      '  ║                                                              ║\n' +
      '  ║  Or seed manually:  node helpers/e2e/seedShippeoToken.js     ║\n' +
      '  ╚══════════════════════════════════════════════════════════════╝\n'
    );
  }

  const refreshExp = tokenExpiresAt(refreshToken);
  if (refreshExp && Date.now() > refreshExp) {
    throw new Error(
      `Shippeo refresh_token expired at ${new Date(refreshExp).toISOString()}.\n` +
      `  Set SHIPPEO_USERNAME + SHIPPEO_PASSWORD in .env, or re-run: node helpers/e2e/seedShippeoToken.js`
    );
  }

  console.log(`\n  [shippeoAuth] Refreshing access token...`);
  try {
    const data = await postForm({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      scope:         SCOPE,
      client_id:     clientId,
    });
    cacheTokenResponse(data);
    console.log(`  [shippeoAuth] ✅ Access token refreshed`);
    console.log(`  [shippeoAuth] Access token expires  : ${formatExpiry(_accessExpMs)}`);
    const rExp = tokenExpiresAt(_cachedRefreshToken || refreshToken);
    const rMins = rExp ? Math.round((rExp - Date.now()) / 60000) : 0;
    if (rMins > 0 && rMins <= 30) {
      console.warn(`  [shippeoAuth] ⚠️  Refresh token expires soon: ${formatExpiry(rExp)}`);
      console.warn(`  [shippeoAuth]    Run: node helpers/e2e/seedShippeoToken.js`);
    } else if (rExp) {
      console.log(`  [shippeoAuth] Refresh token expires : ${formatExpiry(rExp)}`);
    }
    return _cachedAccessToken;
  } catch (e) {
    console.error(`  [shippeoAuth] ❌ Refresh failed: ${e.message}`);
    throw new Error(
      `Shippeo token refresh failed: ${e.message}\n` +
      `  Run:  node helpers/e2e/seedShippeoToken.js  to re-seed the token chain.`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if Shippeo can be used. Never throws.
 */
async function isShippeoAvailable() {
  try { await getShippeoToken(); return true; }
  catch { return false; }
}

module.exports = { getShippeoToken, isShippeoAvailable, fetchTokenFromCredentials };
