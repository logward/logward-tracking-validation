// ─────────────────────────────────────────────────────────────────────────────
//  helpers/ocean/oceanTspHelpers.js
//
//  TSP (transhipment) slot resolution for OCEAN tracking tests.
//
//  Slot assignment (1–4) — used by events with place_type: "transhipment":
//
//    Arrival / discharge events  → slot N
//      ① scan tsp_Locode_1–4: UNLOCODE match → reuse slot
//      ② first slot where tsp_Locode_N is empty → assign it
//      ③ all 4 occupied, no match → return null (overflow)
//
//    Departure / loading events  → date/locode written at slot N-1
//      (date marks the END of the previous leg, vessel belongs to the next leg)
//
//  Vessel leg assignment:
//    Arrival/discharge:  vessel → leg_VesselImoNumber_N   (vessel brought the container HERE)
//    Departure/loading:  vessel → leg_VesselImoNumber_N   (vessel takes it to the NEXT hop)
//      where N is the vessel leg index (POL departure = leg1; first TSP departure = leg2, etc.)
//
//  Fields written per slot N (arrival/discharge):
//    tsp_Locode_N             ← event_site.unlocode
//    actualArrivalTsp_N       ← situation.date     (actual)
//    estimatedArrivalTsp_N    ← situation.date     (estimated external)
//    predictedArrivalTsp_N    ← situation.date     (estimated shippeo)
//    actualDischargeTsp_N     ← situation.date     (actual)
//    estimatedDischargeTsp_N  ← situation.date     (estimated external)
//    predictedDischargeTsp_N  ← situation.date     (estimated shippeo)
//    leg_VesselImoNumber_N    ← milestoneVessel IMO
//    leg_VesselName_N         ← milestoneVessel LABEL
//
//  Fields written per slot N-1 (departure/loading):
//    tsp_Locode_{N-1}          ← event_site.unlocode  (same port, different slot position)
//    actualDepartureTsp_{N-1}  ← situation.date       (actual)
//    estimatedDepartureTsp_{N-1} ← situation.date     (estimated external)
//    predictedDepartureTsp_{N-1} ← situation.date     (estimated shippeo)
//    actualLoadTsp_{N-1}       ← situation.date       (actual)
//    estimatedLoadTsp_{N-1}    ← situation.date       (estimated external)
//    predictedLoadTsp_{N-1}    ← situation.date       (estimated shippeo)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determine which TSP slot (1–4) an event_site maps to.
 * Matching is done on UNLOCODE (case-insensitive).
 * Falls back to the first empty slot when no match is found.
 *
 * For ARRIVAL / DISCHARGE events: use the returned slot directly.
 * For DEPARTURE / LOADING events: the date/locode go to slot (N-1).
 *
 * Called AFTER sendAndWait so the BE has already written tsp_Locode_N.
 *
 * @param otu       OTU object from the BE
 * @param unlocode  event_site.unlocode - slot number (1–4), or null if overflow
 */
function resolveTspSlot(otu, unlocode) {
  const u = (unlocode || '').toUpperCase();

  // ① Existing UNLOCODE match → reuse that slot
  for (let n = 1; n <= 4; n++) {
    const slotU = (otu[`tsp_Locode_${n}`] || '').toUpperCase();
    if (slotU && slotU === u) return n;
  }

  // ② First empty slot (tsp_Locode_N not yet set)
  for (let n = 1; n <= 4; n++) {
    if (!otu[`tsp_Locode_${n}`]) return n;
  }

  // ③ All 4 slots occupied, no match → overflow
  return null;
}

/**
 * Given an arrival/discharge event at a transhipment port, return the OTU
 * field names for the date and locode at slot N.
 *
 * @param n              Slot number (1–4)
 * @param event
 * @param situationType
 * @param dataSource
 */
function tspArrivalFields(n, event, situationType, dataSource) {
  let dateField;
  if (event === 'container_arrived') {
    if   (situationType === 'actual')                    dateField = `actualArrivalTsp_${n}`;
    else if (dataSource === 'shippeo')                   dateField = `predictedArrivalTsp_${n}`;
    else                                                 dateField = `estimatedArrivalTsp_${n}`;
  } else {
    if   (situationType === 'actual')                    dateField = `actualDischargeTsp_${n}`;
    else if (dataSource === 'shippeo')                   dateField = `predictedDischargeTsp_${n}`;
    else                                                 dateField = `estimatedDischargeTsp_${n}`;
  }
  return { dateField, locodeField: `tsp_Locode_${n}` };
}

/**
 * Given a departure/loading event at a transhipment port, return the OTU
 * field names for the date and locode at slot N-1.
 *
 * @param n              Slot N resolved by resolveTspSlot()
 * @param event
 * @param situationType
 * @param dataSource
 */
function tspDepartureFields(n, event, situationType, dataSource) {
  const prevSlot = n > 1 ? n - 1 : null;
  if (prevSlot === null) return { dateField: null, locodeField: null, prevSlot: null };

  let dateField;
  if (event === 'container_departed') {
    if   (situationType === 'actual')    dateField = `actualDepartureTsp_${prevSlot}`;
    else if (dataSource === 'shippeo')   dateField = `predictedDepartureTsp_${prevSlot}`;
    else                                 dateField = `estimatedDepartureTsp_${prevSlot}`;
  } else {
    if   (situationType === 'actual')    dateField = `actualLoadTsp_${prevSlot}`;
    else if (dataSource === 'shippeo')   dateField = `predictedLoadTsp_${prevSlot}`;
    else                                 dateField = `estimatedLoadTsp_${prevSlot}`;
  }
  return { dateField, locodeField: `tsp_Locode_${prevSlot}`, prevSlot };
}

/**
 * Vessel leg field names for a departure/loading event from TSP slot N.
 * The vessel belongs to the NEXT leg, index = N (range 2–5; leg1 is the POL leg).
 *
 * @param n  Slot resolved by resolveTspSlot()
 */
function tspVesselLegFields(n) {
  return {
    imoField:  `leg_VesselImoNumber_${n}`,
    nameField: `leg_VesselName_${n}`,
  };
}

module.exports = {
  resolveTspSlot,
  tspArrivalFields,
  tspDepartureFields,
  tspVesselLegFields,
};
