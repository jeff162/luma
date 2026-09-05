// @vitest-environment jsdom

/*
 * The trend plot draws at the size it is given, in the commit it is given it.
 *
 * Both halves are regressions waiting to happen, and neither shows up as a broken-looking chart —
 * only as motion. `<ResponsiveContainer>` looks like the obvious wrapper for a chart in a flexible
 * card, and it does not compute a size: it measures its own box with a ResizeObserver and keeps the
 * result in state, so a chart inside one draws first at whatever it measured last. Re-bucketing a
 * trend replaces the whole series *and* the width, so that stale frame is a squeezed or stretched
 * chart that corrects itself after paint. Recharts' bar animation is the same kind of thing from the
 * other direction: the default grows every bar from zero on each data change, against an axis in a
 * separate chart that has already snapped to the new scale.
 *
 * jsdom reports no layout at all, which makes it exactly the right place to check this: a chart that
 * needs to be measured renders nothing here, and one that was told its size renders in full.
 *
 * The chart is reconstructed rather than imported, as in the alignment test beside it — the page's
 * copy is inline JSX in a 3,000-line component. What is pinned is the recharts behaviour that makes
 * the page's configuration the right one.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, ResponsiveContainer } from 'recharts'
import { trendPlotLayout } from '../../lib/trendPlotLayout.js'

const HEIGHT = 224
const MARGIN_Y = 6
const XAXIS_HEIGHT = 48

const data = Array.from({ length: 12 }, (_, i) => ({ label: `b${i}`, plotted: -(1000 + i * 250) }))

function plot({ width, animated = false }) {
  return (
    <BarChart width={width} height={HEIGHT} data={data}
      margin={{ top: MARGIN_Y, right: 12, bottom: MARGIN_Y, left: 0 }}>
      <CartesianGrid strokeDasharray="3 3" />
      <XAxis dataKey="label" interval={0} height={XAXIS_HEIGHT} />
      <YAxis hide />
      <Bar dataKey="plotted" isAnimationActive={animated} />
    </BarChart>
  )
}

// Every bar's box, from the path recharts draws: "M x,y h w v h ...".
function bars(container) {
  return [...container.querySelectorAll('.recharts-bar-rectangle path')]
    .map(p => p.getAttribute('d').match(/^M ([\d.-]+),([\d.-]+) h ([\d.-]+) v ([\d.-]+)/))
    .filter(Boolean)
    .map(([, x, y, w, h]) => ({ x: Number(x), y: Number(y), width: Number(w), height: Number(h) }))
}

describe('the trend plot’s first paint', () => {
  it('draws every bar at its final height straight away', () => {
    cleanup()
    const drawn = bars(render(plot({ width: 900 })).container)
    expect(drawn).toHaveLength(data.length)
    for (const bar of drawn) expect(Math.abs(bar.height)).toBeGreaterThan(0)
  })

  it('would draw nothing yet if the bars animated in', () => {
    // The control for the check above. With the entry animation on, the first paint puts a wrapper in
    // place for every bar and draws none of them — in the page that resolves over the 400ms following
    // each re-bucket, which is the motion this chart is not supposed to have.
    cleanup()
    const { container } = render(plot({ width: 900, animated: true }))
    expect(container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(data.length)
    expect(bars(container)).toHaveLength(0)
  })

  it('fills the width it was handed', () => {
    cleanup()
    const layout = trendPlotLayout(data.length, 1200)
    const drawn = bars(render(plot({ width: layout.width })).container)
    const rightmost = Math.max(...drawn.map(bar => bar.x + bar.width))
    expect(rightmost).toBeGreaterThan(layout.width - 40)
    expect(rightmost).toBeLessThanOrEqual(layout.width)
  })

  it('re-lays out to a new width in the same render, with nothing in between', () => {
    // The grain change: twelve years become a hundred and thirty-six months, and the plot is eight
    // times wider. Nothing may be drawn at the old width first.
    cleanup()
    const view = render(plot({ width: trendPlotLayout(12, 900).width }))
    const before = Math.max(...bars(view.container).map(bar => bar.x + bar.width))

    const wide = trendPlotLayout(136, 900).width
    view.rerender(plot({ width: wide }))
    const after = Math.max(...bars(view.container).map(bar => bar.x + bar.width))

    expect(before).toBeLessThan(1000)
    expect(after).toBeGreaterThan(wide * 0.97)
  })

  it('draws nothing at all when it has to be measured first', () => {
    // Why the plot is not wrapped in one. With no layout to observe, `<ResponsiveContainer>` never
    // resolves a size — the same state the real chart is in for the frame after its width changes.
    cleanup()
    // jsdom has no ResizeObserver; a stub that never reports is precisely the un-measured state.
    globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
    // Recharts warns that it was handed a zero width and height, which is the state under test rather
    // than a fault — asserted below so silencing it cannot hide the case going away.
    const unmeasured = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { container } = render(
      <div style={{ width: 900, height: HEIGHT }}>
        <ResponsiveContainer width="100%" height="100%">{plot({ width: 900 })}</ResponsiveContainer>
      </div>,
    )
    expect(bars(container)).toHaveLength(0)
    expect(unmeasured).toHaveBeenCalledWith(expect.stringContaining('should be greater than 0'))
    unmeasured.mockRestore()
  })
})
