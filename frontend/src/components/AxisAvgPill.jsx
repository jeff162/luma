// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import AvgPill from './AvgPill.jsx'
import { avgPillText, placeAvgPillY } from '../lib/axisLabelPlacement.js'

/*
 * The average pill, drawn in a chart's value-axis column instead of on the line inside the plot.
 *
 * Rendered through recharts' `<Customized>`, which hands over the chart's resolved internals — the
 * y-axis `scale` and the `niceTicks` it actually drew. Both matter:
 *
 * - The **scale** converts the average straight to a pixel height, so the pill needs no domain of its
 *   own and stays correct whether the axis was clamped to an explicit domain or scaled itself.
 * - **`niceTicks` is the rendered tick set**, which is the part worth being careful about: the scale's
 *   own `ticks()` returns a *different*, denser set on an auto-scaled axis, and placing the pill around
 *   those would dodge labels that were never drawn while sitting on ones that were.
 *
 * Drawing here rather than through a `<ReferenceLine label>` is also what puts the pill over the tick
 * labels at all. In this column the axis takes nearly the whole width and the plot area is a sliver, so
 * a label positioned off the plot's viewBox would land in that sliver and be clipped by the surface.
 * `<Customized>` renders into the chart root, where `x` is simply a coordinate in the column.
 */

// A small inset from the column's left edge, so the pill is not flush against the card.
const PILL_X = 2

export default function AxisAvgPill({ value, columnWidth, yAxisMap, offset }) {
  const amount = Number(value)
  const axis = yAxisMap && yAxisMap[Object.keys(yAxisMap)[0]]
  if (!axis || typeof axis.scale !== 'function' || !Number.isFinite(amount)) return null

  const placed = placeAvgPillY({
    lineY: axis.scale(amount),
    tickYs: (axis.niceTicks || []).map(tick => axis.scale(tick)),
    plotTop: offset?.top,
    plotBottom: Number.isFinite(offset?.top) && Number.isFinite(offset?.height)
      ? offset.top + offset.height
      : undefined,
  })
  if (!placed) return null

  const room = Number.isFinite(columnWidth) ? columnWidth - PILL_X * 2 : Infinity
  return <AvgPill x={PILL_X} centerY={placed.y} text={avgPillText(amount, { maxWidth: room })} />
}
