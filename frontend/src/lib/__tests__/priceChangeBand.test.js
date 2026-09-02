// The band a price-change finding proposes.
//
// Worth pinning because every part of it is a place the obvious implementation is wrong. The stored
// bounds are signed, so for an expense series `band_min` is the larger number to a reader and comparing
// them as stored inverts every test. And the band must be **extended**, never relocated onto the new
// amount: membership is re-derived from the whole ledger on every scan, so a band moved onto the new
// price stops matching the series' own history — measured against the real detector, that drops an
// eight-charge series to one.

import { describe, it, expect } from 'vitest'
import { priceChangeBand } from '../../components/RecurringSignals.jsx'

// A $4 subscription, band pinned at exactly its price, expressed the way the ledger stores it.
const FIXED = { band_min: -4, band_max: -4, amount: -4.4 }

describe('priceChangeBand', () => {
  it('extends the upper end for a rise, keeping the lower one', () => {
    expect(priceChangeBand(FIXED)).toEqual({ low: 4, high: 4.4, movedBound: 'high' })
  })

  it('extends the lower end for a drop — a utility’s cheapest month yet widens the floor', () => {
    expect(priceChangeBand({ band_min: -120, band_max: -80, amount: -62 }))
      .toEqual({ low: 62, high: 120, movedBound: 'low' })
  })

  it('never relocates the band onto the new amount', () => {
    // The whole history has to stay inside it, so the far end is carried across unchanged.
    const band = priceChangeBand({ band_min: -4, band_max: -4, amount: -8 })
    expect(band.low).toBe(4)
    expect(band.high).toBe(8)
  })

  it('reads the stored bounds as magnitudes rather than as signed numbers', () => {
    // band_min is -120 and band_max -80: compared as stored, "min" is the bigger bill.
    expect(priceChangeBand({ band_min: -120, band_max: -80, amount: -150 }))
      .toEqual({ low: 80, high: 150, movedBound: 'high' })
  })

  it('works the same for an income series, where the signs are the other way up', () => {
    expect(priceChangeBand({ band_min: 800, band_max: 900, amount: 1000 }))
      .toEqual({ low: 800, high: 1000, movedBound: 'high' })
  })

  it('proposes nothing when the charge is already inside the band', () => {
    expect(priceChangeBand({ band_min: -120, band_max: -80, amount: -100 })).toBeNull()
    expect(priceChangeBand({ band_min: -120, band_max: -80, amount: -80 })).toBeNull()
  })

  it('proposes nothing when the series has no band to widen', () => {
    expect(priceChangeBand({ band_min: null, band_max: null, amount: -8 })).toBeNull()
  })
})
