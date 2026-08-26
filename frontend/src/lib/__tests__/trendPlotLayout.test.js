import { describe, it, expect } from 'vitest'
import {
  trendPlotLayout, centeredScrollLeft, TREND_BAR_WIDTH, TREND_PLOT_MIN_WIDTH,
  bucketAnchorMonth, bucketIndexAtScroll, bucketIndexHoldingMonth, trendScrollTargetIndex,
} from '../trendPlotLayout.js'
import { monthsInRange } from '../trendBuckets.js'

describe('sizing the trend plot', () => {
  it('gives each bucket its bar width once there are enough to scroll', () => {
    const layout = trendPlotLayout(136, 900)
    expect(layout.width).toBe(136 * TREND_BAR_WIDTH)
    expect(layout.bucketPitch).toBe(TREND_BAR_WIDTH)
  })

  it('stretches to fill a viewport the buckets do not', () => {
    // Twelve years in a wide card: the plot fills the space rather than leaving the card half empty,
    // which is what makes the pitch differ from the bar width.
    const layout = trendPlotLayout(12, 1200)
    expect(layout.width).toBe(1200)
    expect(layout.bucketPitch).toBe(100)
  })

  it('never draws narrower than it can be read at', () => {
    expect(trendPlotLayout(3, 200).width).toBe(TREND_PLOT_MIN_WIDTH)
    expect(trendPlotLayout(0, 0).width).toBe(TREND_PLOT_MIN_WIDTH)
  })

  it('survives being asked before the viewport has been measured', () => {
    // The container is measured after mount, so the first render asks with nothing. A plot that scrolls
    // gets the same width either way — the viewport only ever matters when the buckets do not fill it.
    expect(trendPlotLayout(136, 0)).toEqual(trendPlotLayout(136, 900))
  })
})

describe('scrolling a bucket into view', () => {
  const viewportWidth = 900
  const visible = (scrollLeft, centre, width) => centre >= scrollLeft && centre <= scrollLeft + width

  it('centres a bucket in the middle of a long run', () => {
    const layout = trendPlotLayout(136, viewportWidth)
    const scrollLeft = centeredScrollLeft({ index: 60, layout, viewportWidth })
    expect(scrollLeft).toBe(60.5 * TREND_BAR_WIDTH - viewportWidth / 2)
  })

  it('does not scroll past either end', () => {
    const layout = trendPlotLayout(136, viewportWidth)
    expect(centeredScrollLeft({ index: 0, layout, viewportWidth })).toBe(0)
    expect(centeredScrollLeft({ index: 135, layout, viewportWidth }))
      .toBe(layout.width - viewportWidth)
  })

  it('has nowhere to scroll when everything already fits', () => {
    const layout = trendPlotLayout(12, 1200)
    expect(centeredScrollLeft({ index: 11, layout, viewportWidth: 1200 })).toBe(0)
  })

  it('finds a bucket in a plot that is stretched *and* scrollable', () => {
    // The case the bar-width arithmetic got wrong, and the reason the two are derived together now: a
    // narrow panel with few buckets is stretched to the minimum width, so the pitch is not the bar
    // width, and the minimum still exceeds the viewport, so the plot scrolls. Both conditions at once
    // are what made it reachable rather than merely latent.
    const narrowViewport = 200
    const layout = trendPlotLayout(3, narrowViewport)
    expect(layout.width).toBe(TREND_PLOT_MIN_WIDTH)
    expect(layout.bucketPitch).toBe(140)

    const drawnCentre = 2.5 * layout.bucketPitch
    const scrollLeft = centeredScrollLeft({ index: 2, layout, viewportWidth: narrowViewport })
    expect(drawnCentre).toBeGreaterThanOrEqual(scrollLeft)
    expect(drawnCentre).toBeLessThanOrEqual(scrollLeft + narrowViewport)

    // And the arithmetic it replaced leaves that same bucket off screen — stated here so the check
    // above is known to be testing something.
    const byBarWidth = Math.max(0, Math.min(
      2.5 * TREND_BAR_WIDTH - narrowViewport / 2,
      layout.width - narrowViewport,
    ))
    expect(visible(byBarWidth, drawnCentre, narrowViewport)).toBe(false)
  })
})

describe('carrying the reader’s place across a change of grain', () => {
  // Three years of data, cut three ways. `bucketStart`/`bucketEnd` are the month codes the chart's
  // buckets actually carry.
  const monthly = monthsInRange('2018-01', '2020-12').map(m => ({ bucketStart: m, bucketEnd: m }))
  const quarterly = [
    ['01', '03'], ['04', '06'], ['07', '09'], ['10', '12'],
  ].flatMap(([a, b]) => ['2018', '2019', '2020'].map(y => ({ bucketStart: `${y}-${a}`, bucketEnd: `${y}-${b}` })))
    .sort((a, b) => a.bucketStart.localeCompare(b.bucketStart))
  const yearly = ['2018', '2019', '2020']
    .map(y => ({ bucketStart: `${y}-01`, bucketEnd: `${y}-12` }))

  it('anchors a bucket on its middle month, not the month it starts', () => {
    // Anchoring the year 2019 on 2019-01 and centring a monthly plot there would fill half the viewport
    // with 2018.
    expect(bucketAnchorMonth(yearly[1])).toBe('2019-06')
    expect(bucketAnchorMonth(quarterly[5])).toBe('2019-05')
    expect(bucketAnchorMonth(monthly[17])).toBe('2019-06')
  })

  it('reads back the bucket under the middle of the viewport', () => {
    const viewportWidth = 900
    const layout = trendPlotLayout(monthly.length, viewportWidth)
    const scrollLeft = centeredScrollLeft({ index: 17, layout, viewportWidth })
    expect(bucketIndexAtScroll({ scrollLeft, viewportWidth, layout, bucketCount: monthly.length })).toBe(17)
  })

  it('lands on the same period whichever grain it is re-cut at', () => {
    // The point of the whole exercise: centre on June 2019 as a month, and every other grain brings the
    // period covering June 2019 on screen rather than throwing the reader to the newest bucket.
    //
    // On screen, not centred: a bucket set narrower than the viewport cannot be scrolled at all, so
    // asking for one of its buckets in the middle is not a thing the plot can do — and does not need to
    // be, since every bucket is already visible.
    const viewportWidth = 900
    const anchor = bucketAnchorMonth(monthly[17])

    for (const buckets of [quarterly, yearly, monthly]) {
      const index = bucketIndexHoldingMonth(buckets, anchor)
      expect(buckets[index].bucketStart <= anchor && anchor <= buckets[index].bucketEnd).toBe(true)

      const layout = trendPlotLayout(buckets.length, viewportWidth)
      const scrollLeft = centeredScrollLeft({ index, layout, viewportWidth })
      const left = index * layout.bucketPitch
      expect(left).toBeGreaterThanOrEqual(scrollLeft)
      expect(left + layout.bucketPitch).toBeLessThanOrEqual(scrollLeft + viewportWidth)

      // And the reader cannot be walked along by toggling the grain. Re-anchoring from where they
      // landed names a month inside the *same* bucket — a quarter's middle month is May where a month
      // bucket's was June — so the next change starts from the same period rather than one further on
      // each time.
      expect(bucketIndexHoldingMonth(buckets, bucketAnchorMonth(buckets[index]))).toBe(index)
    }
  })

  it('answers the nearest bucket for a month the set does not reach', () => {
    // A year view reaches back further than a fifteen-month window does, so an anchor from outside the
    // set is ordinary rather than an error.
    const window = monthly.slice(24)
    expect(bucketIndexHoldingMonth(window, '2016-03')).toBe(0)
    expect(bucketIndexHoldingMonth(window, '2030-01')).toBe(window.length - 1)
  })

  it('has no answer without an anchor, which is what leaves the newest bucket in charge', () => {
    expect(bucketIndexHoldingMonth(monthly, null)).toBe(-1)
    expect(bucketAnchorMonth(undefined)).toBeNull()
  })
})

describe('choosing where to scroll after the buckets are replaced', () => {
  const buckets = ['2019-01', '2019-02', '2019-03'].map(m => ({ bucketStart: m, bucketEnd: m }))

  it('goes to the period the reader picked, over anywhere they had been', () => {
    // A bar click rebuilds the set around what was clicked; that is what to show, whatever was centred
    // beforehand.
    expect(trendScrollTargetIndex({ buckets, selectedIndex: 0, anchorMonth: '2019-03' })).toBe(0)
  })

  it('keeps the reader where they were when nothing was picked', () => {
    expect(trendScrollTargetIndex({ buckets, selectedIndex: -1, anchorMonth: '2019-02' })).toBe(1)
  })

  it('opens on the newest bucket with no history at all', () => {
    expect(trendScrollTargetIndex({ buckets, selectedIndex: -1, anchorMonth: null })).toBe(2)
  })

  it('has nowhere to go with no buckets', () => {
    expect(trendScrollTargetIndex({ buckets: [], selectedIndex: -1, anchorMonth: '2019-02' })).toBe(-1)
  })
})
