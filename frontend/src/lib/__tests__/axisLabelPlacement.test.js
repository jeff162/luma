import { describe, it, expect } from 'vitest'
import { placeAvgPillY, TICK_CLEARANCE, AVG_PILL_HEIGHT } from '../axisLabelPlacement.js'

/*
 * The geometry these are written against is the trend chart's real one, measured from a rendered
 * column: a plot area from y=6 to y=170 with five ticks 41px apart. Numbers rather than a derived
 * layout, so a change in the chart cannot quietly redefine what these assert.
 */
const PLOT_TOP = 6
const PLOT_BOTTOM = 170
const TICKS = [6, 47, 88, 129, 170]
const plot = { plotTop: PLOT_TOP, plotBottom: PLOT_BOTTOM }

// Non-overlap in the plain geometric sense — half the pill plus half the tick text — so these check the
// property rather than restating the constant that implements it.
const NO_OVERLAP = (AVG_PILL_HEIGHT + 11) / 2

describe('placing the average pill beside axis ticks', () => {
  it('leaves it on its own line when no label is near', () => {
    const placed = placeAvgPillY({ lineY: 67.5, tickYs: TICKS, ...plot })
    expect(placed).toEqual({ y: 67.5, nudged: false })
  })

  it('steps clear of a label it would otherwise sit on, the short way', () => {
    // 8px above the zero tick: the pill overlaps it, and the nearer clear height is just above.
    const placed = placeAvgPillY({ lineY: 80, tickYs: TICKS, ...plot })
    expect(placed.nudged).toBe(true)
    expect(placed.y).toBeCloseTo(88 - TICK_CLEARANCE, 5)
    expect(Math.abs(placed.y - 80)).toBeLessThan(Math.abs(88 + TICK_CLEARANCE - 80))
  })

  it('never moves further than the clearance it needed', () => {
    // The worst case is a line landing exactly on a tick, which still only has to clear that one tick.
    for (const tick of TICKS) {
      const placed = placeAvgPillY({ lineY: tick, tickYs: TICKS, ...plot })
      expect(placed.nudged).toBe(true)
      expect(Math.abs(placed.y - tick)).toBeLessThanOrEqual(TICK_CLEARANCE + 1e-9)
    }
  })

  it('keeps the whole pill on the chart at the ends of the axis', () => {
    // Against the bottom tick, one of the two clear heights is off the plot; the other must be taken.
    const low = placeAvgPillY({ lineY: 168, tickYs: TICKS, ...plot })
    expect(low.y).toBeGreaterThanOrEqual(PLOT_TOP + AVG_PILL_HEIGHT / 2)
    expect(low.y).toBeLessThanOrEqual(PLOT_BOTTOM - AVG_PILL_HEIGHT / 2)

    const high = placeAvgPillY({ lineY: 8, tickYs: TICKS, ...plot })
    expect(high.y).toBeGreaterThanOrEqual(PLOT_TOP + AVG_PILL_HEIGHT / 2)
    expect(high.y).toBeLessThanOrEqual(PLOT_BOTTOM - AVG_PILL_HEIGHT / 2)
  })

  it('draws nothing for an average that falls outside the axis', () => {
    // Real case: an all-negative chart scales itself to the data and excludes zero, so the scale puts
    // y=0 above the top of the plot. Anything off the axis has no honest place on the chart.
    expect(placeAvgPillY({ lineY: -76, tickYs: TICKS, ...plot })).toBeNull()
    expect(placeAvgPillY({ lineY: 240, tickYs: TICKS, ...plot })).toBeNull()
    expect(placeAvgPillY({ lineY: NaN, tickYs: TICKS, ...plot })).toBeNull()
  })

  it('clears every label wherever on the axis the average happens to fall', () => {
    // The claim the whole approach rests on: with the clearance inside half the tick spacing, a clear
    // height always exists. A sweep is the honest way to check it — the failures would otherwise be
    // whichever averages nobody thought to try.
    for (let lineY = PLOT_TOP; lineY <= PLOT_BOTTOM; lineY += 0.5) {
      const placed = placeAvgPillY({ lineY, tickYs: TICKS, ...plot })
      expect(placed).not.toBeNull()
      const nearest = Math.min(...TICKS.map(t => Math.abs(t - placed.y)))
      expect(nearest).toBeGreaterThanOrEqual(NO_OVERLAP)
      expect(Math.abs(placed.y - lineY)).toBeLessThanOrEqual(TICK_CLEARANCE + 1e-9)
    }
  })

  it('stays on its line rather than leaving the plot when no clear height exists', () => {
    // An axis crowded past what this was designed for: overlapping a label is a legibility cost, but
    // moving the pill somewhere it does not belong would misreport where the average is.
    const crowded = [6, 16, 26, 36, 46, 56, 66, 76, 86]
    const placed = placeAvgPillY({ lineY: 50, tickYs: crowded, ...plot })
    expect(placed.nudged).toBe(false)
    expect(placed.y).toBe(50)
  })

  it('does not fight ticks it was not given', () => {
    expect(placeAvgPillY({ lineY: 88, tickYs: [], ...plot })).toEqual({ y: 88, nudged: false })
  })
})
