// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Adaptive long-tail slicing, shared by every categorical breakdown on the Dashboard.
 *
 * A categorical breakdown of a real ledger has a long tail: a handful of buckets carry most of the
 * money and dozens carry slivers. Drawn literally, the slivers are too small to read or click. This
 * splits a magnitude-sorted list into *pages*: each page names the buckets that are big enough to stand
 * on their own and leaves the rest for the next page, which the surface presents as a single "Other (N)"
 * element that drills one page deeper.
 *
 * - **Minimum named slices.** At least this many real buckets are named before any tail is collapsed,
 *   so a very flat distribution still makes progress instead of collapsing to Other at every depth.
 * - **Smallest-slice threshold.** Past that minimum, buckets keep being peeled off while the next one
 *   would still be at least this share of *the current page's* pool. The threshold — not an arbitrary
 *   cap — decides the cutoff, so a dataset with many substantial buckets names all of them.
 * - **Recomputed per page.** Each deeper page re-applies the rule against only what is left, so drilling
 *   never strands the user on a page where everything is once again too small to name.
 * - **Singleton absorption.** A page that would leave exactly one bucket in Other takes it instead;
 *   a one-item Other is worse than one more named item.
 * - **`minShare`, opt-in.** A floor *under* the minimum-named-slices floor: a bucket below this share of
 *   its pool is never named, even where naming it would have made up the minimum. Off by default, since
 *   the two surfaces disagree about what a too-small bucket costs. A hairline pie wedge is invisible but
 *   harmless — the item is still in the legend list beside the chart. A hairline Sankey band costs a
 *   *label row*, which is the scarce resource on that surface, and a side holding fewer buckets than the
 *   minimum would otherwise name every one of them however small: the case that motivated this was an
 *   inflow side of eight whose smallest was 0.0004% of the side and whose label was the only part of it
 *   with any height.
 *
 * Rows are read by `total` and must arrive sorted by the magnitude the surface draws — the caller owns
 * that ordering, since what counts as magnitude differs by surface (a pie floors its wedges at zero,
 * while a cash-flow side is keyed on the absolute value of a signed net).
 */

export const MIN_NAMED_SLICES = 10
export const SMALLEST_NAMED_SLICE_MIN_SHARE = 0.03
export const OTHER_SLICE_KEY = '__other__'
export const OTHER_SLICE_COLOR = '#6b7280'

export function computeSlicePages(rows, { minShare = 0 } = {}) {
  const pages = []
  let start = 0
  while (start < rows.length) {
    const remaining = rows.slice(start)
    const poolTotal = remaining.reduce((s, r) => s + (Number(r.total) || 0), 0)
    const shareOf = index => (poolTotal > 0 ? (Number(remaining[index].total) || 0) / poolTotal : 0)
    let pageSize = Math.min(MIN_NAMED_SLICES, remaining.length)
    while (pageSize < remaining.length) {
      if (shareOf(pageSize) < SMALLEST_NAMED_SLICE_MIN_SHARE) break
      pageSize++
    }
    // Rows arrive sorted by magnitude, so once one falls under the floor every later one does too and
    // the page can be trimmed from its end. At least one bucket is always named: a page of nothing but
    // Other would leave `start` where it was and never terminate, and it would also give the user
    // nothing to click down into.
    if (minShare > 0) {
      while (pageSize > 1 && shareOf(pageSize - 1) < minShare) pageSize--
    }
    if (remaining.length - pageSize === 1) pageSize = remaining.length
    pages.push({ start, end: start + pageSize })
    start += pageSize
  }
  return pages.length > 0 ? pages : [{ start: 0, end: 0 }]
}
