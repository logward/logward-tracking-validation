// ─────────────────────────────────────────────────────────────────────────────
//  helpers/e2e/seedShippeoToken.js
//
//  Fetches a Shippeo token via the credentials API and prints it.
//  Useful for verifying credentials or grabbing a token for manual use.
//
//  Usage:
//    node helpers/e2e/seedShippeoToken.js
//
//  Requires SHIPPEO_USERNAME and SHIPPEO_PASSWORD to be set in .env
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const { fetchTokenFromCredentials } = require('./shippeoAuth');
const { E2E_CONFIG } = require('./e2eConfig');

(async () => {
  const username = process.env.SHIPPEO_USERNAME;
  const password = process.env.SHIPPEO_PASSWORD;
  const baseUrl  = E2E_CONFIG.SHIPPEO.baseUrl;

  if (!username || !password) {
    console.error('\n  ❌ SHIPPEO_USERNAME and SHIPPEO_PASSWORD must be set in .env');
    process.exit(1);
  }

  console.log(`\n  Fetching Shippeo token for ${username} from ${baseUrl}...`);

  try {
    const token = await fetchTokenFromCredentials(username, password, baseUrl);
    console.log('\n  ✅ Token obtained:');
    console.log(`  ${token}`);
  } catch (e) {
    console.error(`\n  ❌ Failed: ${e.message}`);
    process.exit(1);
  }
})();
