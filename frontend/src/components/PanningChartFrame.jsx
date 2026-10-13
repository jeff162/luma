// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef } from 'react'

/*
 * A chart whose bars keep a readable width however many there are: it is given a minimum width, and
 * once that exceeds the card the row scrolls sideways (with the app's styled scrollbar) rather than
 * squashing every bar in. The card's width is the natural cap, so a chart that fits does not scroll.
 *
 * The scroll starts at the right edge, where the most recent periods are, and returns there whenever
 * `pinKey` changes — a new window, frame or drill is a new chart, and it should open on its newest end
 * rather than wherever the last one was left. A chart inside it puts its value axis on the right, where
 * that default view keeps it in sight, and takes `PanningChartTooltip` for its tooltip.
 */
export default function PanningChartFrame({ minWidth, height, pinKey, children }) {
  const scrollRef = useRef(null)
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [pinKey])
  return (
    <div ref={scrollRef} style={{ overflowX: 'auto', overflowY: 'hidden' }}>
      <div style={{ minWidth, height }}>{children}</div>
    </div>
  )
}
