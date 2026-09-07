// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * What a recurring signal points at, and what accepting its new amount would mean.
 *
 * Both are answers about the finding itself rather than about how it is drawn, which is why they sit
 * apart from the review surface that renders it: the page reads them to build its cards and its
 * actions, and they are the half worth testing on its own.
 */

// Reachability is the point rather than convenience: some kinds could reach nothing at all before this,
// including *Newly detected*, which asks the user to Confirm a series without offering any way to look at
// it. See `ui-patterns.md` on markers opening what they stand for.
export function signalTarget(signal) {
  return signal.series_id ? { type: 'series', id: signal.series_id } : null
}

// The band a price-change finding proposes: the series' current one **extended** to take in the charge,
// never relocated onto it. Membership is re-derived from the whole ledger on every scan, so a band moved
// onto the new amount stops matching the series' own history — measured, it drops an eight-charge series
// to one. Only the end the charge falls outside moves; the other is the user's to change.
export function priceChangeBand(signal) {
  if (signal.band_min == null || signal.band_max == null || signal.amount == null) return null
  // Magnitudes throughout: the stored bounds are signed, so for an expense series `band_min` is the
  // *larger* number to a reader and comparing them as stored inverts every test below.
  const bandLow = Math.min(Math.abs(signal.band_min), Math.abs(signal.band_max))
  const bandHigh = Math.max(Math.abs(signal.band_min), Math.abs(signal.band_max))
  const charge = Math.abs(signal.amount)
  if (charge >= bandLow && charge <= bandHigh) return null  // already inside — nothing to widen
  return charge > bandHigh
    ? { low: bandLow, high: charge, movedBound: 'high' }
    : { low: charge, high: bandHigh, movedBound: 'low' }
}
