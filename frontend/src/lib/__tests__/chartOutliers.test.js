import { describe, it, expect } from 'vitest'
import {
  BOUND_MULTIPLE,
  CLAMP_HEADROOM,
  ENGAGE_MULTIPLE,
  TEAR_GAP,
  clampBarValue,
  clippedBarGeometry,
  computeClampedDomain,
  tornSegmentPath,
} from '../chartOutliers.js'

// A ledger's real shape, reproduced with invented figures: a long run of ordinary months, a December
// each year carrying a bonus, and one month of miscategorised transfers. What makes it the interesting
// case is that the largest month is only ~1.6x the next largest, so any "one bar dwarfs the rest" test
// waves it through while 90% of the months stay unreadable.
function heavyTailedLedger() {
  const ordinary = Array.from({ length: 125 }, (_, i) => (i % 2 ? 1 : -1) * (1500 + (i % 12) * 550))
  const decembers = [92000, 99000, 102000, 113000, 121000, 128000, 134000, 138000, 141000]
  return [...ordinary, ...decembers, -222000]
}

const spanOf = domain => domain[1] - domain[0]

describe('computeClampedDomain leaves ordinary data alone', () => {
  it('does nothing when the largest bar is merely the tallest', () => {
    expect(computeClampedDomain([100, 90, 80, 40, 10, 30, 60]).clamped).toBe(false)
  })

  it('does nothing to merely spiky data, where the peak is a few times the ordinary bar', () => {
    // Five ordinary bars around 100 and a peak at four times that. Real, but not off the scale.
    expect(computeClampedDomain([100, 90, 80, 110, 95, 400]).clamped).toBe(false)
  })

  it('engages once the peak clears the ordinary scale by the engage multiple', () => {
    // p75 of these is 100, so the boundary sits at 100 x ENGAGE_MULTIPLE.
    const base = [80, 90, 95, 100, 100, 100]
    const below = computeClampedDomain([...base, 100 * ENGAGE_MULTIPLE])
    const above = computeClampedDomain([...base, 100 * ENGAGE_MULTIPLE + 1])
    expect(below.clamped).toBe(false)
    expect(above.clamped).toBe(true)
  })

  it('does nothing with too few bars to describe a distribution', () => {
    // A percentile of four values is not a statement about a tail, and four bars are all readable.
    expect(computeClampedDomain([-215000, -2000, -1000, -500]).clamped).toBe(false)
    expect(computeClampedDomain([-215000, -2000]).clamped).toBe(false)
    expect(computeClampedDomain([]).clamped).toBe(false)
  })

  it('does nothing when the giants are numerous enough to be the distribution', () => {
    // Half the bars far above the other half is a shape, not a tail: the ordinary scale rises to meet
    // them, so the engage test refuses without any separate rule about how much may be torn.
    const bimodal = [...Array.from({ length: 8 }, () => 1000), ...Array.from({ length: 8 }, () => 90000)]
    expect(computeClampedDomain(bimodal).clamped).toBe(false)
  })

  it('still clamps for the one torn bar in a short series', () => {
    expect(computeClampedDomain([-215000, -3000, -2000, -1000, -1500, -2500]).clamped).toBe(true)
  })

  it('can never tear more than a quarter of the bars, whatever the data', () => {
    // The property the bound's percentile buys, asserted rather than assumed — it is what makes this
    // safe to switch on everywhere without a second rule policing how much gets clipped.
    const shapes = [
      [...Array.from({ length: 30 }, () => 1000), ...Array.from({ length: 10 }, (_, i) => 50000 * (i + 1))],
      [...Array.from({ length: 12 }, (_, i) => 100 * (i + 1)), 900000, 40000, 250000],
      [-31, -1271, 23416, -267, 4032, 3107, 5053, 3117, -222063, -3090, -5054, -8956],
      Array.from({ length: 60 }, (_, i) => (i % 7 === 0 ? 80000 : 900) * (i % 2 ? 1 : -1)),
    ]
    for (const values of shapes) {
      const { clamped, bound } = computeClampedDomain(values)
      if (!clamped) continue
      const torn = values.filter(v => clampBarValue(v, bound).clipped).length
      expect(torn / values.length).toBeLessThanOrEqual(0.25)
    }
  })

  it('ignores non-numeric entries rather than clamping around them', () => {
    const withJunk = [100, 90, null, undefined, 'x', 80, 110, 95, NaN]
    expect(computeClampedDomain(withJunk)).toEqual(computeClampedDomain([100, 90, 80, 110, 95]))
  })
})

describe('computeClampedDomain on a heavy-tailed ledger', () => {
  const ledger = heavyTailedLedger()

  it('clamps even though the top two bars are close in size', () => {
    // The case the previous largest-vs-next-largest rule missed entirely: 222k against 141k is a ratio
    // of 1.6, while the median month is a fiftieth of either.
    const [biggest, second] = [...ledger].map(Math.abs).sort((a, b) => b - a)
    expect(biggest / second).toBeLessThan(2)
    expect(computeClampedDomain(ledger).clamped).toBe(true)
  })

  it('bounds the axis to the ordinary months rather than to the tail', () => {
    const { bound } = computeClampedDomain(ledger)
    const ordinaryMonth = 4000
    expect(bound).toBeLessThan(50000)
    expect(bound).toBeGreaterThan(ordinaryMonth)
  })

  it('makes an ordinary month legible, which is the whole point', () => {
    const { domain } = computeClampedDomain(ledger)
    const unclamped = Math.max(...ledger) - Math.min(...ledger)
    const ordinaryMonth = 4000
    // It is the improvement that matters, not an absolute share: on the raw axis such a month is
    // roughly one percent tall, which is the complaint that started this.
    expect(ordinaryMonth / unclamped).toBeLessThan(0.02)
    expect(ordinaryMonth / spanOf(domain)).toBeGreaterThan(5 * (ordinaryMonth / unclamped))
  })

  it('tears only the tail, not a meaningful share of the chart', () => {
    const { bound } = computeClampedDomain(ledger)
    const clipped = ledger.filter(v => clampBarValue(v, bound).clipped)
    expect(clipped.length).toBeGreaterThan(0)
    expect(clipped.length / ledger.length).toBeLessThan(0.15)
  })
})

describe('computeClampedDomain with a lone outlier', () => {
  // Nine years, one of them a run of miscategorised transfers. The rule still has to catch the case it
  // was originally written for.
  const years = [-215000, 10000, -3000, -2500, -2000, -1800, -1500, -1200, -900]

  it('clamps to the ordinary years', () => {
    const { clamped, bound } = computeClampedDomain(years)
    expect(clamped).toBe(true)
    expect(bound).toBeCloseTo(3000 * BOUND_MULTIPLE)
  })

  it('keeps the average reference line inside the axis', () => {
    // A mean is dragged toward the extremes, so a bound taken from the ordinary bars alone would leave
    // the average line off the chart entirely.
    const average = years.reduce((s, v) => s + v, 0) / years.length
    const { domain, bound } = computeClampedDomain(years, { average })
    expect(Math.abs(average)).toBeGreaterThan(3000 * BOUND_MULTIPLE)
    expect(bound).toBeCloseTo(Math.abs(average) * CLAMP_HEADROOM)
    expect(average).toBeGreaterThan(domain[0])
    expect(average).toBeLessThan(domain[1])
  })

  it('keeps zero on the axis of an unclamped all-negative chart', () => {
    // Left to recharts, an all-negative axis runs from the lowest bar to the highest and leaves out zero.
    expect(computeClampedDomain([-11653.16]).domain).toEqual(['auto', 0])
    expect(computeClampedDomain([-400, -350, 0]).domain).toEqual(['auto', 0])
    expect(computeClampedDomain([400, 350]).domain).toBeUndefined()
    expect(computeClampedDomain([-400, 350]).domain).toBeUndefined()
  })

  it('rounds the axis ends outward, so the ticks and the zero survive an explicit domain', () => {
    // Recharts pins ticks to the exact ends of a domain it is given, so unrounded ends produce an axis
    // of arbitrary numbers with no zero on it. Outward rounding only ever adds headroom.
    const { domain, bound } = computeClampedDomain(years)
    // The raw bound is 12,000 and the real positive extent 8,000; both round outward, never inward.
    expect(domain[0]).toBeLessThanOrEqual(-bound)
    expect(domain).toEqual([-15000, 10000])
  })

  it('always spans zero, so the baseline stays where the eye expects it', () => {
    const negative = computeClampedDomain([-215000, -3000, -2000, -1000, -1500, -2500])
    const positive = computeClampedDomain([215000, 3000, 2000, 1000, 1500, 2500])
    expect(negative.domain[1]).toBe(0)
    expect(negative.domain[0]).toBeLessThan(0)
    expect(positive.domain[0]).toBe(0)
    expect(positive.domain[1]).toBeGreaterThan(0)
  })

  it('leaves an untouched side at its true extent instead of forcing symmetry', () => {
    // The outlier is negative and the positive side is ordinary, so the positive extent is real data and
    // must not be padded out to match the clamped side.
    const { domain } = computeClampedDomain([-215000, 8000, -3000, -2000, -1000, -2500])
    // Rounded outward from the real 8000 extent, not padded out to match the clamped negative side.
    expect(domain[1]).toBe(10000)
    expect(domain[1]).toBeLessThan(Math.abs(domain[0]))
    expect(domain[0]).toBeGreaterThan(-215000)
  })
})

describe('clampBarValue', () => {
  it('leaves a bar inside the bound alone', () => {
    expect(clampBarValue(-3000, 12500)).toEqual({ plotted: -3000, clipped: false })
  })

  it('draws an outlier to the frame and flags it, keeping its sign', () => {
    expect(clampBarValue(-215000, 12500)).toEqual({ plotted: -12500, clipped: true })
    expect(clampBarValue(215000, 12500)).toEqual({ plotted: 12500, clipped: true })
  })

  it('does not clip a bar sitting exactly on the bound', () => {
    expect(clampBarValue(-12500, 12500).clipped).toBe(false)
  })

  it('passes everything through when there is no bound to clamp to', () => {
    expect(clampBarValue(-215000, null)).toEqual({ plotted: -215000, clipped: false })
    expect(clampBarValue(-215000, undefined)).toEqual({ plotted: -215000, clipped: false })
  })

  it('treats a missing value as zero rather than NaN', () => {
    expect(clampBarValue(undefined, 12500)).toEqual({ plotted: 0, clipped: false })
  })
})

describe('clippedBarGeometry', () => {
  // The exact props recharts hands a Bar shape, measured rather than assumed. A bar below the axis
  // arrives with its FAR edge as `y` and a NEGATIVE height, because recharts anchors every bar at the
  // zero line and extends it toward the value.
  const RISING = { x: 83, y: 5, width: 141, height: 92, value: 27792 }
  const FALLING = { x: 259, y: 189, width: 141, height: -92, value: -27792 }

  it('normalises a negative height, so a falling bar is not drawn end-for-end', () => {
    const falling = clippedBarGeometry(FALLING)
    expect(falling.top).toBe(97)
    expect(falling.bottom).toBe(189)
  })

  it('breaks the bar across its middle, whichever way it runs', () => {
    for (const bar of [RISING, FALLING]) {
      const { top, bottom, segments } = clippedBarGeometry(bar)
      const middle = (top + bottom) / 2
      expect(segments).toHaveLength(2)
      // One piece runs from each end and stops short of the middle, leaving the break between them.
      expect(segments.map(s => s.flatY).sort((a, b) => a - b)).toEqual([top, bottom])
      expect(segments.find(s => s.flatY === top).tornY).toBeCloseTo(middle - TEAR_GAP / 2)
      expect(segments.find(s => s.flatY === bottom).tornY).toBeCloseTo(middle + TEAR_GAP / 2)
    }
  })

  it('never puts the break on the chart frame or on the zero line', () => {
    // Both are where it reads as a rendering fault rather than a deliberate mark — the frame because it
    // is the edge of the plot, the zero line because every other bar shares it.
    for (const bar of [RISING, FALLING]) {
      const { top, bottom, segments } = clippedBarGeometry(bar)
      for (const segment of segments) {
        expect(segment.tornY).toBeGreaterThan(top)
        expect(segment.tornY).toBeLessThan(bottom)
      }
    }
  })

  it('puts the label inside the bar at the value end, not beyond it', () => {
    // The bug this pins: reading the negative height as positive put a falling bar's label above the
    // zero line, outside the bar, where white text sits on the card background and cannot be seen.
    const rising = clippedBarGeometry(RISING)
    const falling = clippedBarGeometry(FALLING)

    expect(rising.labelY).toBeGreaterThan(rising.top)
    expect(rising.labelY).toBeLessThan((rising.top + rising.bottom) / 2)
    expect(falling.labelY).toBeLessThan(falling.bottom)
    expect(falling.labelY).toBeGreaterThan((falling.top + falling.bottom) / 2)
  })

  it('falls back to one torn edge when the bar is too short to break in two', () => {
    const short = clippedBarGeometry({ x: 0, y: 100, width: 40, height: 12, value: 500 })
    expect(short.segments).toHaveLength(1)
    // Torn at the value end, flat where it meets zero.
    expect(short.segments[0].tornY).toBe(short.top)
    expect(short.segments[0].flatY).toBe(short.bottom)
  })

  it('tears a short falling bar at its bottom, not its top', () => {
    const short = clippedBarGeometry({ x: 0, y: 112, width: 40, height: -12, value: -500 })
    expect(short.segments[0].tornY).toBe(short.bottom)
    expect(short.segments[0].flatY).toBe(short.top)
  })
})

describe('tornSegmentPath', () => {
  it('closes, and spans exactly the bar width', () => {
    const d = tornSegmentPath({ x: 10, width: 40, flatY: 100, tornY: 60 })
    expect(d.startsWith('M 10 100')).toBe(true)
    expect(d.endsWith('L 50 100 Z')).toBe(true)
  })

  it('zigzags the torn edge and leaves the flat edge straight', () => {
    const d = tornSegmentPath({ x: 0, width: 50, flatY: 100, tornY: 60 })
    const ys = [...d.matchAll(/[ML] [\d.-]+ ([\d.-]+)/g)].map(m => Number(m[1]))
    // The flat edge contributes only its own y; the torn edge contributes values either side of it.
    expect(ys.filter(v => v === 100)).toHaveLength(2)
    expect(ys.some(v => v > 60 && v < 100)).toBe(true)
    expect(ys.some(v => v < 60)).toBe(true)
  })
})
