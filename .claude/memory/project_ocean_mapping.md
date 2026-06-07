---
name: project-ocean-mapping
description: Ocean tracking mapping implementation — files created, endpoint, token config
metadata:
  type: project
---

Ocean tracking mapping built to match the air tracking pattern.

**Why:** User asked to build ocean mapping using the same technique as air, based on CSV mapping sheet and a provided curl.

**Files created:**
- `data/oceanFieldMappings.js` — TYPE_1_DIRECT (6 direct fields), TYPE_2_CONDITIONAL (31 conditional entries), TYPE_3_TSP_SLOT (transhipment slot logic)
- `helpers/ocean/oceanConfig.js` — endpoint: `sandbox-admin.logward.com`, path: `/api/integration-hub/tracking/shippeo/ocean_order_event_out`, clientId: `0010Q00001iPMHnQAO`
- `helpers/ocean/oceanSites.js` — UNLOCODE-based sites: NGB_INLAND, NGB_POL, SGP_TSP1, PKG_TSP2, JEA_TSP3, HAM_TSP4, RTM_POD, RTM_INLAND
- `helpers/ocean/oceanPayloadFactory.js` — makePayload(event, date, situationType, dataSource, eventSite, extras) + withVessel()
- `helpers/ocean/oceanApiHelpers.js` — sendAndWait, getOTU, pollUntilUpdated (mirrors airApiHelpers)
- `helpers/ocean/oceanTspHelpers.js` — resolveTspSlot (by UNLOCODE), tspArrivalFields, tspDepartureFields, tspVesselLegFields
- `tests/ocean/TC001_OceanTracking_Mapping.spec.js` — full test suite covering all stages

**Key differences from air:**
- Discriminators are event + place_type + situation.type + data_source (not just event name)
- TSP slots use UNLOCODE matching (not IATA)
- Departure/loading events at TSP write to slot N-1 (date/locode)
- Arrival/discharge events at TSP write to slot N

**Still needs:**
- `OBJECT_CODE` filled in `oceanConfig.js` (Logward internal OTU code)
- `BOL_NUMBER` filled (bill_of_lading_references value)
- `OCEAN_ADMIN_TOKEN` env var (refreshed every 1h)

**How to apply:** When user asks to add more events, run tests, or debug failures, refer to these files.
