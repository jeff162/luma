// @vitest-environment jsdom

/*
 * The average pill in the trend chart's sticky value-axis column.
 *
 * Two things have to hold for it to be worth putting there at all. It must sit at the height its own
 * reference line is drawn at in the plot beside it — otherwise it names a value the chart does not
 * show — and it must not land on top of a tick label, which is the whole reason the column was not an
 * obvious home for it. Neither is visible in a green suite: a pill 20px off its line still looks like a
 * pill, and one covering half a tick still looks like a pill on an axis.
 *
 * The layout constants are duplicated here on purpose, as in the alignment test next door: importing
 * them from the page would make this agree with whatever the page currently says.
 */

import { describe, it, expect } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { BarChart, Bar, XAxis, YAxis, ReferenceLine, CartesianGrid, Customized } from 'recharts'
import AxisAvgPill from '../AxisAvgPill.jsx'
import { AVG_PILL_HEIGHT, AXIS_TICK_TEXT_HEIGHT } from '../../lib/axisLabelPlacement.js'
import { formatSignedAxisTick } from '../../lib/moneyDisplay.js'

const HEIGHT = 224
const MARGIN_Y = 6
const XAXIS_HEIGHT = 48
const AXIS_COLUMN_WIDTH = 76
const AXIS_LABEL_WIDTH = 60

// Two shapes with no tick anywhere near the average, and two where the average lands within a couple of
// pixels of one — which is not a contrived case: a net cash-flow average sits near zero by its nature,
// and zero is always a tick on an axis that straddles it.
const SHAPES = {
  // Chosen so the average lands mid-gap between two ticks, 20.5px from each: the case where the pill
  // must *not* move, which is the only way the agreement with the plot's line can be checked exactly.
  'monthly spend, auto scale': {
    values: [-4200, -5100, -3800, -6200, -4900, -5400, -3100, -7200, -4400, -5900, -4700, -8100],
    domain: undefined,
    clamped: false,
  },
  'yearly totals, auto scale': {
    values: [-52000, -61000, -48000, -70000, -55000],
    domain: undefined,
    clamped: false,
  },
  'clamped all-time, average beside zero': {
    values: [-30000, 30000, -9000, 12000, -3000, 4000],
    domain: [-30000, 30000],
    clamped: true,
  },
  'cash-flow net, average beside zero': {
    values: [1200, -3400, 800, -900, 2100, -450, 1750, -2200],
    domain: undefined,
    clamped: false,
  },
  // Six-figure yearly buckets, where the full "Avg $X" label no longer fits the column and the word
  // has to be dropped. Without a shape this size that branch never runs.
  'yearly totals, six figures': {
    values: [-233000, -198000, -256000, -241000, -212000],
    domain: undefined,
    clamped: false,
  },
}

const dataFor = values => values.map((v, i) => ({ label: `b${i}`, plotted: v }))
const averageOf = values => values.reduce((s, v) => s + v, 0) / values.length

function axisColumn({ values, domain, clamped }) {
  const data = dataFor(values)
  return (
    <BarChart width={AXIS_COLUMN_WIDTH} height={HEIGHT} data={data}
      margin={{ top: MARGIN_Y, right: 0, bottom: MARGIN_Y, left: 0 }}>
      <YAxis width={AXIS_LABEL_WIDTH} tickFormatter={formatSignedAxisTick}
        tick={{ fontSize: 11 }} domain={domain} allowDataOverflow={clamped} />
      <XAxis dataKey="label" height={XAXIS_HEIGHT} tick={false} axisLine={false} />
      <Bar dataKey="plotted" fillOpacity={0} isAnimationActive={false} />
      <Customized component={
        <AxisAvgPill value={averageOf(values)} columnWidth={AXIS_COLUMN_WIDTH} />
      } />
    </BarChart>
  )
}

function scrollingPlot({ values, domain, clamped }, width = 600) {
  const data = dataFor(values)
  return (
    <BarChart width={width} height={HEIGHT} data={data}
      margin={{ top: MARGIN_Y, right: 12, bottom: MARGIN_Y, left: 0 }}>
      <CartesianGrid strokeDasharray="3 3" />
      <XAxis dataKey="label" interval={0} height={XAXIS_HEIGHT} />
      <YAxis hide domain={domain} allowDataOverflow={clamped} />
      <Bar dataKey="plotted" isAnimationActive={false} />
      <ReferenceLine y={averageOf(values)} strokeDasharray="4 4" />
    </BarChart>
  )
}

function pillIn(container) {
  const rect = container.querySelector('.recharts-customized-wrapper rect')
  if (!rect) return null
  const y = Number(rect.getAttribute('y'))
  const text = container.querySelector('.recharts-customized-wrapper text')
  return {
    x: Number(rect.getAttribute('x')),
    width: Number(rect.getAttribute('width')),
    height: Number(rect.getAttribute('height')),
    centerY: y + Number(rect.getAttribute('height')) / 2,
    text: text?.textContent,
  }
}

const tickYsIn = container =>
  [...container.querySelectorAll('.recharts-yAxis .recharts-cartesian-axis-tick line')]
    .map(line => Number(line.getAttribute('y1')))

const renderColumn = shape => { cleanup(); return render(axisColumn(shape)).container }

describe('the average pill in the sticky axis column', () => {
  it.each(Object.entries(SHAPES))('clears every tick label — %s', (_name, shape) => {
    const container = renderColumn(shape)
    const pill = pillIn(container)
    expect(pill).not.toBeNull()

    // Plain geometric non-overlap: half the pill plus half the tick text. Stated here rather than
    // imported so the check is of the drawn result, not of the constant that produced it.
    const needed = (AVG_PILL_HEIGHT + AXIS_TICK_TEXT_HEIGHT) / 2
    for (const tickY of tickYsIn(container)) {
      expect(Math.abs(tickY - pill.centerY)).toBeGreaterThanOrEqual(needed)
    }
  })

  it.each(Object.entries(SHAPES))('stays inside the column — %s', (_name, shape) => {
    // The column's SVG clips at its own width, so a pill that overflows is not merely tight: its text
    // is cut off. The label drops the word "Avg" rather than let that happen.
    const pill = pillIn(renderColumn(shape))
    expect(pill.x).toBeGreaterThanOrEqual(0)
    expect(pill.x + pill.width).toBeLessThanOrEqual(AXIS_COLUMN_WIDTH)
  })

  it.each(Object.entries(SHAPES))('names the average it is drawn beside — %s', (_name, shape) => {
    const pill = pillIn(renderColumn(shape))
    expect(pill.text).toContain(formatSignedAxisTick(averageOf(shape.values)))
  })

  it('sits on its line in the plot when nothing is in the way', () => {
    // The pill and the dashed line it names are drawn by two different charts. They agree only because
    // both read the same scale; nothing enforces it.
    const shape = SHAPES['monthly spend, auto scale']
    cleanup()
    const pill = pillIn(render(axisColumn(shape)).container)
    cleanup()
    const line = render(scrollingPlot(shape)).container.querySelector('.recharts-reference-line line')
    expect(pill.centerY).toBeCloseTo(Number(line.getAttribute('y1')), 1)
  })

  it('gives up its exact height, and only that, to clear a label', () => {
    // The cash-flow case: the average is a few pixels off the zero tick, so the pill has to move — but
    // it has to stay near enough to still read as a label on that line rather than a value of its own.
    const shape = SHAPES['cash-flow net, average beside zero']
    cleanup()
    const pill = pillIn(render(axisColumn(shape)).container)
    cleanup()
    const line = render(scrollingPlot(shape)).container.querySelector('.recharts-reference-line line')
    const drift = Math.abs(pill.centerY - Number(line.getAttribute('y1')))
    expect(drift).toBeGreaterThan(0)
    expect(drift).toBeLessThanOrEqual(15)
  })

  it('is placed around the ticks the axis actually drew', () => {
    // `niceTicks` is what the pill dodges. The scale's own `ticks()` looks like the same thing and is
    // not: on an auto-scaled axis it returns a denser set, and placing the pill around those would step
    // aside from labels that were never drawn while sitting on ones that were.
    cleanup()
    let nice = null
    let scale = null
    render(
      <BarChart width={AXIS_COLUMN_WIDTH} height={HEIGHT} data={dataFor(SHAPES['monthly spend, auto scale'].values)}
        margin={{ top: MARGIN_Y, right: 0, bottom: MARGIN_Y, left: 0 }}>
        <YAxis width={AXIS_LABEL_WIDTH} />
        <XAxis dataKey="label" height={XAXIS_HEIGHT} tick={false} axisLine={false} />
        <Bar dataKey="plotted" fillOpacity={0} isAnimationActive={false} />
        <Customized component={props => {
          const axis = props.yAxisMap[Object.keys(props.yAxisMap)[0]]
          nice = axis.niceTicks
          scale = axis.scale
          return null
        }} />
      </BarChart>,
    )
    const drawn = tickYsIn(document.body)
    expect(nice.map(t => scale(t))).toEqual(drawn)
    expect(scale.ticks(5).length).not.toBe(nice.length)
  })
})
