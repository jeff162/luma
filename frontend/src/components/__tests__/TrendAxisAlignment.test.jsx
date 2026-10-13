// @vitest-environment jsdom

/*
 * The single-period trend chart is drawn as two charts: a fixed column carrying only the value axis, so
 * it stays readable while the plot pans, and the scrolling plot with its own axis hidden.
 *
 * That only works while the two agree on a vertical scale, and nothing in either chart says so — they
 * agree because they are given the same height, the same top and bottom margins, the same category-axis
 * height, and the same data and domain. Drift in any of those is invisible in a green suite and silent
 * on screen: the axis simply starts describing a scale the bars are not drawn to, which is worse than
 * having no axis at all. This renders both and asserts they still line up.
 *
 * The layout constants are duplicated here on purpose. Importing them from the page would make the test
 * agree with whatever the page currently says, which is the one thing it must not do.
 */

import { describe, it, expect } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { BarChart, Bar, CartesianGrid, XAxis, YAxis } from 'recharts'

const HEIGHT = 224
const MARGIN_Y = 6
const XAXIS_HEIGHT = 48
const AXIS_COLUMN_WIDTH = 76
const AXIS_LABEL_WIDTH = 60

const data = [
  { label: 'a', plotted: 27792 }, { label: 'b', plotted: -27792 },
  { label: 'c', plotted: 4000 }, { label: 'd', plotted: -9000 },
  { label: 'e', plotted: 12000 }, { label: 'f', plotted: -3000 },
]

function axisColumn(domain, allowDataOverflow) {
  return (
    <BarChart width={AXIS_COLUMN_WIDTH} height={HEIGHT} data={data}
      margin={{ top: MARGIN_Y, right: 0, bottom: MARGIN_Y, left: 0 }}>
      <YAxis width={AXIS_LABEL_WIDTH} domain={domain} allowDataOverflow={allowDataOverflow} />
      <XAxis dataKey="label" height={XAXIS_HEIGHT} tick={false} axisLine={false} />
      <Bar dataKey="plotted" fillOpacity={0} isAnimationActive={false} />
    </BarChart>
  )
}

function scrollingPlot(domain, allowDataOverflow, width = 600) {
  return (
    <BarChart width={width} height={HEIGHT} data={data}
      margin={{ top: MARGIN_Y, right: 12, bottom: MARGIN_Y, left: 0 }}>
      <CartesianGrid strokeDasharray="3 3" />
      <XAxis dataKey="label" interval={0} height={XAXIS_HEIGHT} />
      <YAxis hide domain={domain} allowDataOverflow={allowDataOverflow} />
      <Bar dataKey="plotted" isAnimationActive={false} />
    </BarChart>
  )
}

// Where the axis says a value sits: the y of each tick mark, by its label. recharts draws the marks and
// the label text in separate layers, in the same order, so the two are paired by position.
function tickPositions(container) {
  const marks = [...container.querySelectorAll('.recharts-yAxis-tick-lines .recharts-cartesian-axis-tick line')]
  const labels = [...container.querySelectorAll('.recharts-yAxis-tick-labels text')]
  expect(labels.length).toBe(marks.length)
  return Object.fromEntries(marks.map((mark, i) => [labels[i].textContent, Number(mark.getAttribute('y1'))]))
}

// Where the plot actually draws zero: the baseline every bar starts from.
function zeroLineFromBars(container) {
  const bars = [...container.querySelectorAll('.recharts-bar-rectangle path')]
    .map(p => p.getAttribute('d'))
    .map(d => d.match(/^M ([\d.-]+),([\d.-]+) h ([\d.-]+) v ([\d.-]+)/))
    .filter(Boolean)
    .map(([, , y, , h]) => ({ top: Number(y), bottom: Number(y) + Number(h) }))
  expect(bars.length).toBeGreaterThan(1)
  // A rising bar's bottom and a falling bar's top are both the zero line, so the value the whole set
  // shares is it.
  const counts = new Map()
  for (const { top, bottom } of bars) {
    for (const edge of [top.toFixed(2), bottom.toFixed(2)]) counts.set(edge, (counts.get(edge) || 0) + 1)
  }
  const [edge] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  return Number(edge)
}

function measure(domain, allowDataOverflow, width) {
  cleanup()
  const zeroTick = tickPositions(render(axisColumn(domain, allowDataOverflow)).container)['0']
  cleanup()
  const baseline = zeroLineFromBars(render(scrollingPlot(domain, allowDataOverflow, width)).container)
  return { zeroTick, baseline }
}

describe('the trend chart’s detached value axis', () => {
  it('puts its zero tick exactly where the plot draws the baseline', () => {
    const { zeroTick, baseline } = measure(undefined, false)
    expect(zeroTick).toBeCloseTo(baseline, 1)
  })

  it('agrees with the plot under an explicitly clamped domain too', () => {
    // The clamped case is the one that matters most: an axis describing an unclamped scale beside bars
    // drawn to a clamped one would misreport every value on the chart. The domain is a rounded one, as
    // computeClampedDomain produces — recharts pins ticks to the exact ends it is given, so an unrounded
    // domain has no zero tick to compare against in the first place.
    const { zeroTick, baseline } = measure([-30000, 30000], true)
    expect(zeroTick).toBeCloseTo(baseline, 1)
  })

  it('stays aligned however wide the scrolling plot grows', () => {
    // The plot's width is the bucket count times a fixed bar width, so it varies by an order of
    // magnitude between a short window and an all-time run. None of that may move the vertical scale.
    const narrow = measure(undefined, false, 420)
    const wide = measure(undefined, false, 8160)
    expect(narrow.baseline).toBeCloseTo(wide.baseline, 1)
    expect(wide.zeroTick).toBeCloseTo(wide.baseline, 1)
  })

  it('drifts if the two stop sharing a vertical geometry', () => {
    // Proof that the checks above can fail: give the column a different category-axis height, which is
    // the most plausible way for the two to drift, and the axis no longer describes the plot.
    cleanup()
    const column = render(
      <BarChart width={AXIS_COLUMN_WIDTH} height={HEIGHT} data={data}
        margin={{ top: MARGIN_Y, right: 0, bottom: MARGIN_Y, left: 0 }}>
        <YAxis width={AXIS_LABEL_WIDTH} />
        <XAxis dataKey="label" height={XAXIS_HEIGHT + 20} tick={false} axisLine={false} />
        <Bar dataKey="plotted" fillOpacity={0} isAnimationActive={false} />
      </BarChart>,
    ).container

    const drifted = tickPositions(column)['0']
    cleanup()
    const baseline = zeroLineFromBars(render(scrollingPlot(undefined, false)).container)
    expect(drifted).not.toBeCloseTo(baseline, 1)
  })

  it('renders a real axis in the column, which `hide` on the series would prevent', () => {
    // `<Bar hide>` looks like the obvious way to draw an invisible series and drops it from the domain
    // entirely, leaving the column blank.
    cleanup()
    const ticks = tickPositions(render(axisColumn(undefined, false)).container)
    expect(Object.keys(ticks).length).toBeGreaterThan(2)
    expect(ticks['0']).toBeGreaterThan(0)
  })
})
