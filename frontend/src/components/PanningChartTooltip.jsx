// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DefaultTooltipContent } from 'recharts'
import { besideOnAxis } from '../lib/floatingPlacement.js'

/*
 * Tooltip content for a Recharts chart that pans inside a horizontally scrolling element — the Dashboard's
 * single-period trend and the Trends tab's annual totals. Recharts keeps a tooltip inside the chart's own
 * box, and for a panning chart that box is the whole scrolled canvas: once panned, a point near the
 * *visible* edge is nowhere near the canvas's, so its card opened into the part the scroll area hides.
 *
 * This renders the same default card, portaled out of the chart and placed beside the pointer in screen
 * space, flipped and clamped inside what can actually be seen: every clipping ancestor and the window
 * horizontally, the window vertically. The placement rule is the one the app's hover tooltip uses
 * (lib/floatingPlacement.js). Like that tooltip it gives way to a scroll, since a card positioned in screen
 * space would otherwise be left pointing at a bar that has moved; it comes back with the next pointer move.
 *
 * Use as `<Tooltip content={<PanningChartTooltip />} isAnimationActive={false} … />`. Every other Tooltip
 * prop (formatter, contentStyle, labelStyle, …) reaches the card unchanged, because Recharts hands them to
 * the content element and they are passed straight through to its default card.
 */

const POINTER_GAP = 12

// The horizontal span of `el` that is not clipped by any ancestor or by the window.
function visibleHorizontalSpan(el) {
  let lo = 0
  let hi = document.documentElement.clientWidth
  for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
    const overflowX = getComputedStyle(node).overflowX
    if (overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'hidden' || overflowX === 'clip') {
      const rect = node.getBoundingClientRect()
      lo = Math.max(lo, rect.left)
      hi = Math.min(hi, rect.right)
    }
  }
  return { lo, hi }
}

export default function PanningChartTooltip(props) {
  const { active, payload, coordinate } = props
  const anchorRef = useRef(null)
  const cardRef = useRef(null)
  const [position, setPosition] = useState(null)
  const [scrolledAtPoint, setScrolledAtPoint] = useState(null)
  const shown = !!active && Array.isArray(payload) && payload.length > 0
  const pointerX = coordinate?.x
  const pointerY = coordinate?.y
  const pointKey = `${pointerX}:${pointerY}`
  const hiddenByScroll = scrolledAtPoint === pointKey

  // Measured once the card is mounted, so its real size decides which side it goes on; it renders hidden
  // until then, so the first frame never shows it at an unplaced spot.
  useLayoutEffect(() => {
    if (!shown || hiddenByScroll) { setPosition(null); return }
    const chart = anchorRef.current?.closest('.recharts-wrapper')
    const card = cardRef.current
    if (!chart || !card || typeof pointerX !== 'number' || typeof pointerY !== 'number') return
    const chartRect = chart.getBoundingClientRect()
    const cardRect = card.getBoundingClientRect()
    const x = chartRect.left + pointerX
    const y = chartRect.top + pointerY
    const { lo, hi } = visibleHorizontalSpan(chart)
    setPosition({
      left: besideOnAxis({ before: x, after: x, size: cardRect.width, lo, hi, gap: POINTER_GAP }),
      top: besideOnAxis({
        before: y, after: y, size: cardRect.height, lo: 0, hi: document.documentElement.clientHeight, gap: POINTER_GAP,
      }),
    })
  }, [shown, hiddenByScroll, pointerX, pointerY, payload])

  useEffect(() => {
    if (!shown) return undefined
    const giveWay = () => setScrolledAtPoint(pointKey)
    window.addEventListener('scroll', giveWay, true)
    return () => window.removeEventListener('scroll', giveWay, true)
  }, [shown, pointKey])

  return (
    <>
      {/* Inside Recharts' own tooltip wrapper, which sits in the chart: how the card finds the chart. */}
      <span ref={anchorRef} aria-hidden="true" style={{ display: 'block', width: 0, height: 0 }} />
      {shown && !hiddenByScroll && createPortal(
        <div
          ref={cardRef}
          style={{
            position: 'fixed',
            left: position?.left ?? 0,
            top: position?.top ?? 0,
            visibility: position ? 'visible' : 'hidden',
            zIndex: 4000,
            pointerEvents: 'none',
          }}
        >
          <DefaultTooltipContent {...props} />
        </div>,
        document.body,
      )}
    </>
  )
}
