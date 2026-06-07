# Logward Tracking Mapping — API Automation

Pure API tests verifying the **Shippeo → Logward** tracking event mapping for all transport modes.

---

## Project Structure

```
Logward_Tracking_Mapping/
├── playwright.config.js          ← Main config (3 projects: air, ocean, road)
├── package.json
├── .env.example                  ← Copy to .env and fill in tokens
│
├── helpers/
│   ├── tokenHelper.js            ← JWT expiry check (shared)
│   └── pollHelper.js             ← Generic polling utility (shared)
│
└── tests/
    ├── air/
    │   └── TC001_AirTracking_Mapping.spec.js     ✅ Complete
    ├── ocean/
    │   └── TC001_OceanTracking_Mapping.spec.js   🚧 Placeholder
    └── road/
        └── TC001_RoadTracking_Mapping.spec.js    🚧 Placeholder
```

---

## Setup

```bash
cd Logward_Tracking_Mapping
npm install
```

---

## Running Tests

### All tracking types
```bash
npx playwright test
```

### Individual transport modes
```bash
npx playwright test --project=air
npx playwright test --project=ocean
npx playwright test --project=road
```

### npm scripts
```bash
npm run test:air
npm run test:ocean
npm run test:road
```

---

## Tokens

Cognito admin tokens **expire every ~1 hour**. Before running, export fresh tokens:

```bash
export AIR_ADMIN_TOKEN="eyJ..."
export OCEAN_ADMIN_TOKEN="eyJ..."
export ROAD_ADMIN_TOKEN="eyJ..."
```

**Where to get a fresh token:**
1. Log in to [qa-admin.logward.engineering](https://qa-admin.logward.engineering)
2. Open DevTools → Network → any API request → `Authorization` header
3. Copy the `Bearer eyJ...` value (without the word `Bearer`)

Webhook tokens are long-lived (~2027) and baked into each test file's `CONFIG`. Override via env var if needed.

---

## Adding New Tests

Each transport mode follows the same pattern:

1. **GET** the transport unit → capture baseline `changedAt`
2. **POST** a Shippeo webhook payload
3. **Assert** webhook returns `2xx`
4. **Poll** the transport unit until `changedAt` changes
5. **Assert** mapped fields on the updated transport unit

See `tests/air/TC001_AirTracking_Mapping.spec.js` for a full reference implementation.

---

## Reports

```bash
npm run report:air
npm run report:ocean
npm run report:road
```
