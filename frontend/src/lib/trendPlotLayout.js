// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * How wide the single-period trend plot is, and where each bucket sits inside it.
 *
 * The chart pans by native horizontal scroll, so two things have to agree: the width the plot is drawn
 * at, and the arithmetic that scrolls a chosen bucket into view. They were separately derived — the
 * width from `max(floor, buckets × bar width)`, the scroll offset from `bucket index × bar width` — and
 * that is only the same number while the buckets are what sets the width. **Once the plot is stretched
 * to fill a viewport wider than its buckets need, recharts spreads the bars over the extra room and the
 * bucket pitch is no longer the bar width**, so the scroll arithmetic is pointing at the wrong place. It
 * happens to be harmless in the common stretched case, because a plot that fits its viewport cannot
 * scroll at all — but the floor makes it reachable: six buckets in a narrow enough panel gives content
 * wider than the viewport *and* a pitch that is not the bar width. Deriving both from one place removes
 * the class rather than the instance.
 *
 * Nothing here measures the chart. The width is computed from the bucket count and the viewport, which
 * is what lets the chart be handed an explicit size instead of discovering one after it has drawn —
 * see the note on `<ResponsiveContainer>` in `docs/ui-patterns.md`.
 *
 * The second half of the module is the other direction: which bucket the reader is looking at, and
 * which bucket in a *different* set covers the same time. Changing the grain rebuilds the bucket set
 * around the same data, so scrolling by index throws the reader somewhere unrelated — anchoring on the
 * month under the middle of the viewport is what keeps month, quarter and year views of the same period
 * on the same period.
 */

import { monthsInRange } from './trendBuckets.js'

// The room one bucket gets before the plot has to scroll. Also the unit the scroll offset is computed
// in whenever the buckets are what sets the width.
export const TREND_BAR_WIDTH = 60
// Below this the plot is too cramped to read even with only a bucket or two in it.
export const TREND_PLOT_MIN_WIDTH = 420

/*
 * The plot's drawn width and the horizontal distance between bucket centres.
 *
 * `viewportWidth` is the visible width of the scroll container, and 0 is a fine value for it — before
 * the container has been measured the plot simply takes its buckets' width, which is what it would have
 * had anyway in every case where it scrolls.
 */
export function trendPlotLayout(bucketCount, viewportWidth = 0) {
  const buckets = Math.max(0, Math.floor(Number(bucketCount) || 0))
  const viewport = Math.max(0, Number(viewportWidth) || 0)
  const width = Math.max(buckets * TREND_BAR_WIDTH, viewport, TREND_PLOT_MIN_WIDTH)
  return { width, bucketPitch: buckets > 0 ? width / buckets : TREND_BAR_WIDTH }
}

/*
 * The scroll offset that puts a bucket in the middle of the viewport, clamped to the scrollable range.
 *
 * Takes the layout rather than a bucket width so it cannot drift from what was drawn.
 */
export function centeredScrollLeft({ index, layout, viewportWidth }) {
  const centre = (Math.max(0, index) + 0.5) * layout.bucketPitch
  const furthest = Math.max(0, layout.width - viewportWidth)
  return Math.max(0, Math.min(centre - viewportWidth / 2, furthest))
}

// --- Where the reader is looking -------------------------------------------------------------------

/*
 * The month at the centre of a bucket, which is what a position in one bucket set means in another.
 *
 * A bucket's *start* is the obvious choice and reads badly across a grain change: anchoring the year
 * 2019 on 2019-01 and then centring a monthly plot there fills half the viewport with 2018. The middle
 * month puts the same span under the same part of the screen at every grain.
 */
export function bucketAnchorMonth(bucket) {
  if (!bucket || !bucket.bucketStart) return null
  const months = monthsInRange(bucket.bucketStart, bucket.bucketEnd || bucket.bucketStart)
  return months.length > 0 ? months[Math.floor((months.length - 1) / 2)] : bucket.bucketStart
}

// Which bucket sits under the middle of the viewport at a given scroll offset.
export function bucketIndexAtScroll({ scrollLeft, viewportWidth, layout, bucketCount }) {
  const count = Math.max(0, Math.floor(Number(bucketCount) || 0))
  if (count === 0 || !layout || !(layout.bucketPitch > 0)) return -1
  const centre = (Number(scrollLeft) || 0) + (Number(viewportWidth) || 0) / 2
  return Math.min(count - 1, Math.max(0, Math.floor(centre / layout.bucketPitch)))
}

/*
 * Which bucket of a set covers a month — the nearest one on that side when none does.
 *
 * Total by construction: a month before the first bucket answers the first, one after the last answers
 * the last, and one in a gap answers the bucket that follows it. An anchor from a set that spanned more
 * time than this one is the ordinary case rather than an error — the year view of a ledger reaches back
 * further than a fifteen-month window does — so there is no "not found" for a caller to mishandle.
 */
export function bucketIndexHoldingMonth(buckets, month) {
  if (!month || !buckets || buckets.length === 0) return -1
  const found = buckets.findIndex(bucket => month <= (bucket.bucketEnd || bucket.bucketStart))
  return found >= 0 ? found : buckets.length - 1
}

/*
 * Which bucket to scroll to when the bucket set has just been replaced.
 *
 * The whole rule in one place, because it is a rule rather than a calculation: a picked period wins,
 * since the reader asked for it; failing that the place they were already looking; and only with no
 * history at all — a first render — the newest bucket the chart opens on.
 */
export function trendScrollTargetIndex({ buckets, selectedIndex, anchorMonth }) {
  if (!buckets || buckets.length === 0) return -1
  if (selectedIndex >= 0) return selectedIndex
  const anchored = bucketIndexHoldingMonth(buckets, anchorMonth)
  return anchored >= 0 ? anchored : buckets.length - 1
}
