// @ts-check
// ─────────────────────────────────────────────────────────────────────────────
//  helpers/air/airHubHelpers.js
//
//  Hub routing logic for AIR Type 4 and Type 5 events.
//
//  Type 5 — prefix decision (IATA + Country, both must match):
//    event_site.iata_code == ATU.loadingSiteIata   AND
//    event_site.country   == ATU.loadingSiteCountry  → prefix = "loading"
//
//    event_site.iata_code == ATU.deliverySiteIata  AND
//    event_site.country   == ATU.deliverySiteCountry → prefix = "delivery"
//
//    else                                           → prefix = "hub"
//
//  Hub slot assignment (stops 1–4) — used by Type 4 and Type 5 hub events:
//    ① scan stop1–4: hubSiteIata_stopN == iata AND hubSiteCountry_stopN == country → reuse
//    ② first slot where hubSiteIata_stopN is empty → assign
//    ③ all 4 occupied, no match → return null (overflow / Slack alert on BE)
//
//  Hub site fields written on EVERY hub event (not just first assignment):
//    hubSiteDescription_stopN  ← event_site.description
//    hubSiteIata_stopN         ← event_site.iata_code
//    hubSiteAddressLine_stopN  ← event_site.address_line
//    hubSiteCity_stopN         ← event_site.city
//    hubSiteZipcode_stopN      ← event_site.zipcode
//    hubSiteCountry_stopN      ← event_site.country
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determine the Type 5 routing prefix for a given event_site.
 * Matches on IATA + Country (both must match, case-insensitive).
 *
 * @param {object} atu      ATU object from the BE
 * @param {string} iata     event_site.iata_code
 * @param {string} country  event_site.country
 * @returns {'loading' | 'delivery' | 'hub'}
 */
function resolvePrefix(atu, iata, country) {
  const i = (iata    || '').toUpperCase();
  const c = (country || '').toUpperCase();

  if (i && c &&
      i === (atu.loadingSiteIata    || '').toUpperCase() &&
      c === (atu.loadingSiteCountry || '').toUpperCase()) return 'loading';

  if (i && c &&
      i === (atu.deliverySiteIata    || '').toUpperCase() &&
      c === (atu.deliverySiteCountry || '').toUpperCase()) return 'delivery';

  return 'hub';
}

/**
 * Determine which hub stop (1–4) an event_site maps to.
 * Matches on IATA + Country (both must match, case-insensitive).
 * Falls back to the first empty slot when no match is found.
 *
 * Called AFTER sendAndWait — the BE has already written hubSiteIata_stopN
 * so the returned ATU already contains the assigned slot.
 *
 * @param {object} atu      ATU object from the BE
 * @param {string} iata     event_site.iata_code
 * @param {string} country  event_site.country
 * @returns {number | null}  slot number (1–4) or null if overflow
 */
function resolveHubSlot(atu, iata, country) {
  const i = (iata    || '').toUpperCase();
  const c = (country || '').toUpperCase();

  // ① Existing IATA + Country match → reuse that slot
  for (let n = 1; n <= 4; n++) {
    const slotI = (atu[`hubSiteIata_stop${n}`]    || '').toUpperCase();
    const slotC = (atu[`hubSiteCountry_stop${n}`] || '').toUpperCase();
    if (slotI === i && slotC === c) return n;
  }

  // ② First empty slot (hubSiteIata not yet set)
  for (let n = 1; n <= 4; n++) {
    if (!atu[`hubSiteIata_stop${n}`]) return n;
  }

  // ③ All 4 slots occupied, no match
  return null;
}

module.exports = { resolvePrefix, resolveHubSlot };
