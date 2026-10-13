// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { DefaultZIndexes, ZIndexLayer, usePlotArea, useYAxisScale, useYAxisTicks } from 'recharts'
import AvgPill from './AvgPill.jsx'
import { avgPillText, placeAvgPillY } from '../lib/axisLabelPlacement.js'

/*
 * The average pill, drawn in a chart's value-axis column instead of on the line inside the plot.
 *
 * Rendered as a child of the chart, where recharts' hooks hand over what the chart resolved — the
 * y-axis scale and the ticks it actually drew. Both matter:
 *
 * - The **scale** converts the average straight to a pixel height, so the pill needs no domain of its
 *   own and stays correct whether the axis was clamped to an explicit domain or scaled itself.
 * - **`useYAxisTicks` is the rendered tick set**, which is the part worth being careful about: placing
 *   the pill around any other set would dodge labels that were never drawn while sitting on ones that
 *   were.
 *
 * Drawing here rather than through a `<ReferenceLine label>` is also what puts the pill over the tick
 * labels at all. In this column the axis takes nearly the whole width and the plot area is a sliver, so
 * a label positioned off the plot's viewBox would land in that sliver and be clipped by the surface.
 * A chart child draws in the chart root, where `x` is simply a coordinate in the column — and in its own
 * layer above recharts' label layer, which is where the tick text is drawn and would otherwise cover it.
 */

// A small inset from the column's left edge, so the pill is not flush against the card.
const PILL_X = 2

export default function AxisAvgPill({ value, columnWidth }) {
  const scale = useYAxisScale()
  const ticks = useYAxisTicks()
  const plotArea = usePlotArea()
  const amount = Number(value)
  if (typeof scale !== 'function' || !Number.isFinite(amount)) return null

  const placed = placeAvgPillY({
    lineY: scale(amount),
    tickYs: (ticks || []).map(tick => tick.coordinate),
    plotTop: plotArea?.y,
    plotBottom: Number.isFinite(plotArea?.y) && Number.isFinite(plotArea?.height)
      ? plotArea.y + plotArea.height
      : undefined,
  })
  if (!placed) return null

  const room = Number.isFinite(columnWidth) ? columnWidth - PILL_X * 2 : Infinity
  return (
    <ZIndexLayer zIndex={DefaultZIndexes.label + 1}>
      <g className="axis-avg-pill">
        <AvgPill x={PILL_X} centerY={placed.y} text={avgPillText(amount, { maxWidth: room })} />
      </g>
    </ZIndexLayer>
  )
}
