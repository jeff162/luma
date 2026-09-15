// @vitest-environment jsdom

/*
 * PanningChartTooltip places a chart's hover card against what can be *seen*, not against the chart's own
 * box. For a chart that pans inside a scroll area those differ: the chart is the whole scrolled canvas, and
 * a point near the visible edge is nowhere near the canvas's, so a card placed against the canvas opens into
 * the part the scroll area hides. That was the reported bug, on the Dashboard's single-period trend.
 *
 * jsdom has no layout, so the geometry is stated: a chart 420px wide starting at x=80, inside a scroll area
 * that shows x=100..300, with the window much wider than both. The demo data cannot produce this reliably
 * in a browser — its few months draw the plot at its minimum width, and Recharts' own flip at the canvas
 * edge happens to land in view — so this is where the placement contract is pinned.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import PanningChartTooltip from '../PanningChartTooltip.jsx'

const CARD = { width: 150, height: 60 }
const rect = ({ left, top, width, height }) => ({
  left, top, width, height, right: left + width, bottom: top + height, x: left, y: top,
})

beforeEach(() => {
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1280 })
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 900 })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function measure() {
    if (this.dataset?.rect) return rect(JSON.parse(this.dataset.rect))
    if (this.querySelector?.(':scope > .recharts-default-tooltip')) return rect({ left: 0, top: 0, ...CARD })
    return rect({ left: 0, top: 0, width: 0, height: 0 })
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const PAYLOAD = [{ name: 'Spending', value: 1234, dataKey: 'total', payload: { total: 1234 } }]

function chart(tooltipProps) {
  return (
    <div data-rect={JSON.stringify({ left: 100, top: 200, width: 200, height: 240 })} style={{ overflowX: 'auto' }}>
      <div className="recharts-wrapper" data-rect={JSON.stringify({ left: 80, top: 200, width: 420, height: 224 })}>
        <PanningChartTooltip active payload={PAYLOAD} label="Aug 2026" {...tooltipProps} />
      </div>
    </div>
  )
}

function placedCard() {
  const card = document.body.querySelector(':scope > div > .recharts-default-tooltip')?.parentElement
  if (!card || card.style.visibility === 'hidden') return null
  const left = parseFloat(card.style.left)
  const top = parseFloat(card.style.top)
  return { left, right: left + CARD.width, top, bottom: top + CARD.height }
}

describe('PanningChartTooltip', () => {
  it('keeps a card near the visible right edge inside the visible area, not merely inside the canvas', () => {
    // Pointer at screen x=270: 30px short of the visible edge, 230px short of the canvas's.
    render(chart({ coordinate: { x: 190, y: 40 } }))
    const card = placedCard()
    expect(card).not.toBeNull()
    expect(card.left).toBeGreaterThanOrEqual(100)
    expect(card.right).toBeLessThanOrEqual(300)
  })

  it('stays inside when the hovered bar\'s centre is itself scrolled out of view', () => {
    // Recharts anchors on the hovered bar's centre, not the pointer: a pointer just inside the visible
    // edge can be over a bar whose centre (screen x=340) is past it.
    render(chart({ coordinate: { x: 260, y: 40 } }))
    const card = placedCard()
    expect(card.left).toBeGreaterThanOrEqual(100)
    expect(card.right).toBeLessThanOrEqual(300)
  })

  it('opens beside the pointer on the preferred side when that fits', () => {
    // Pointer at screen x=110, near the visible left edge: the card goes to its right, 12px clear.
    render(chart({ coordinate: { x: 30, y: 40 } }))
    expect(placedCard().left).toBe(122)
  })

  it('renders nothing while the chart has nothing to show', () => {
    render(chart({ coordinate: { x: 30, y: 40 }, active: false }))
    expect(document.body.querySelector('.recharts-default-tooltip')).toBeNull()
  })

  it('gives way to a scroll, and comes back when the pointer moves', () => {
    const { rerender } = render(chart({ coordinate: { x: 30, y: 40 } }))
    expect(placedCard()).not.toBeNull()
    act(() => { window.dispatchEvent(new Event('scroll')) })
    expect(document.body.querySelector('.recharts-default-tooltip')).toBeNull()
    rerender(chart({ coordinate: { x: 60, y: 44 } }))
    expect(placedCard()).not.toBeNull()
  })
})
