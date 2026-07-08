// ─────────────────────────────────────────────────────────────────────────────
//  helpers/shared/seedShippeoToken.js
//
//  One-time token seeder. Run this when the Shippeo token chain expires
//  (after being idle for >4 hours, e.g. overnight).
//
//  Usage:
//    node helpers/shared/seedShippeoToken.js
//
//  What it does:
//    1. Opens a visible Chrome browser at inthebackofthetruck.shippeo.io
//    2. You log in normally (Google SSO works fine in visible mode)
//    3. Intercepts the /oauth/token response
//    4. Saves refresh_token + access_token to .shippeo-token-cache.json
//    5. From that point, auto-refresh handles everything for the rest of the day
//
//  You only need to run this ONCE per session start (e.g. morning).
//  The chain self-sustains as long as tests run within 4-hour windows.
//
//  Note: the credentials-based flow in shippeoAuth.js (SHIPPEO_USERNAME/
//  PASSWORD) only works for accounts with a native Shippeo password. Accounts
//  that log in via Google SSO have no native password, so getShippeoToken()
//  will warn and fall back to the refresh token this script seeds.
// ─────────────────────────────────────────────────────────────────────────────

const { chromium } = require('@playwright/test');
const fs   = require('fs');
const path = require('path');

const CACHE_FILE = path.resolve(__dirname, '../../.shippeo-token-cache.json');
const LOGIN_URL  = 'https://inthebackofthetruck.shippeo.io';

function decodeJwtPayload(token) {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(part, 'base64').toString('utf8'));
  } catch { return {}; }
}

function formatExpiry(token) {
  const { exp } = decodeJwtPayload(token);
  if (!exp) return 'unknown';
  const ms   = exp * 1000;
  const mins = Math.round((ms - Date.now()) / 60000);
  return `${new Date(ms).toISOString()}  (in ${mins} min)`;
}

(async () => {
  console.log('\n  ╔══ Shippeo Token Seeder ══════════════════════════════════════╗');
  console.log('  ║  A browser window will open.                                 ║');
  console.log('  ║  Log in to Shippeo normally (Google SSO is fine).            ║');
  console.log('  ║  The window will close automatically after login.            ║');
  console.log('  ╚══════════════════════════════════════════════════════════════╝\n');

  const browser = await chromium.launch({
    headless: false,
    args: ['--window-size=800,600'],
  });

  const context = await browser.newContext();
  let tokenData = null;

  // Intercept /oauth/token response to capture tokens
  await context.route('**/oauth/token', async (route) => {
    const response = await route.fetch();
    try {
      const body = await response.json();
      if (body.refresh_token && body.access_token) {
        tokenData = body;
        console.log('  ✅ Token captured!');
      }
    } catch { /* ignore */ }
    await route.fulfill({ response });
  });

  const page = await context.newPage();
  await page.goto(LOGIN_URL);

  console.log('  ⏳ Waiting for you to log in...\n');

  // Wait until token is captured (up to 3 minutes)
  const deadline = Date.now() + 3 * 60 * 1000;
  while (!tokenData && Date.now() < deadline) {
    await page.waitForTimeout(1000);
  }

  await browser.close();

  if (!tokenData) {
    console.error('\n  ❌ No token captured. Did you complete the login?');
    process.exit(1);
  }

  // Save to cache
  fs.writeFileSync(CACHE_FILE, JSON.stringify({ refresh_token: tokenData.refresh_token }, null, 2), 'utf8');

  console.log('\n  ╔══ Token saved ════════════════════════════════════════════════╗');
  console.log(`  ║  Access token  expires: ${formatExpiry(tokenData.access_token).padEnd(38)}║`);
  console.log(`  ║  Refresh token expires: ${formatExpiry(tokenData.refresh_token).padEnd(38)}║`);
  console.log('  ║                                                               ║');
  console.log('  ║  Auto-refresh is now active. Run your tests normally.         ║');
  console.log('  ╚═══════════════════════════════════════════════════════════════╝\n');

})().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
