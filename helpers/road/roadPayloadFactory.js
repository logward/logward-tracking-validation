// ─────────────────────────────────────────────────────────────────────────────
//  helpers/road/roadPayloadFactory.js
//
//  Builds Shippeo → Logward road webhook payloads.
//  Source: _LIDL__Events-out_Mapping_-_Road.xlsx + live curl from QA
//
//  Lookup:   order.reference = RTU transportOrderId  (exact match)
//  Condition check (all 3 exact, case-sensitive):
//    situation_code + justification_code + situation.event
//
//  ETA_EVENT routing:
//    order.etd present → predictedArrivalAtPickUpLocation
//    order.eta present → predictedArrivalAtDeliveryLocation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a road webhook payload.
 *
 * @param {string}      event              situation.event value
 * @param {string}      situationCode      situation_code (exact, case-sensitive)
 * @param {string|null} justificationCode  justification_code (exact, case-sensitive)
 * @param {string|null} date              situation.date (ISO datetime or null)
 * @param {string}      orderRef          RTU transportOrderId — used as order.reference (lookup key)
 * @param {object}      loadSite          From LOADING_SITES pool
 * @param {object}      delSite           From DELIVERY_SITES pool
 * @param {object}      [orderOverrides]  Override order fields (e.g. eta/etd)
 */
function makeRoadPayload(event, situationCode, justificationCode, date, orderRef, loadSite, delSite, orderOverrides = {}) {
  return {
    date_transmission: new Date().toISOString(),

    owner: {
      organization: { id: 'Q2JK9RVN', name: 'LIDL' },
      agency:       { id: 'Q27K7Z42', name: 'LIDL_Road', siret: null },
    },

    order: {
      edi_reference:     `E2E-EDI-${orderRef}`,
      reference:         orderRef,   // ← Logward looks up the RTU by this field
      eta:               null,
      etd:               null,
      url:               'https://view.shippeo.com/orderPublic/test',
      shippeo_reference: 'NPG8WVVV',
      ...orderOverrides,
    },

    tour: {
      edi_reference: `E2E-TOUR-${orderRef}`,
      reference:     `E2E-TOUR-${orderRef}`,
    },

    situation: {
      event:              event,
      situation_code:     situationCode,
      justification_code: justificationCode,
      input_date:         date,
      date:               date,
    },

    situation_justification: {
      theoretical_distance: 2717,
      position: { lat: 48.718822, lng: 9.543809 },
      pair:       { id: 'NGEMD8KM', type: 'hashid' },
      attributes: { mean: 'ba1f585a38050167', driver: 'ba1f585a38050167' },
    },

    loading_site: {
      id:           null,
      externalID:   null,
      name:         loadSite.name,
      address_line: loadSite.address,
      zipcode:      loadSite.zipcode,
      city:         loadSite.city,
      country:      loadSite.country,
      position:     { lat: loadSite.lat, lng: loadSite.lng },
      iata_code:    null,
    },

    delivery_site: {
      id:           null,
      externalID:   null,
      name:         delSite.name,
      address_line: delSite.address,
      zipcode:      delSite.zipcode,
      city:         delSite.city,
      country:      delSite.country,
      position:     { lat: delSite.lat, lng: delSite.lng },
      iata_code:    null,
    },

    carrier: {
      organization: { id: 'JNRJ56N8', name: 'E2E Test Carrier' },
      agency:       { id: 'LNGW9XN3', name: 'E2E Test Agency', siret: null },
    },
  };
}

module.exports = { makeRoadPayload };
