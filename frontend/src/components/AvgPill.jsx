// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { AVG_PILL_HEIGHT, avgPillWidth } from '../lib/axisLabelPlacement.js'

/*
 * The filled badge that names an average reference line on a chart.
 *
 * Shared by the two places one is drawn: on the line inside the plot, and in the sticky value-axis
 * column of the trend chart. Keeping the drawing in one place is what lets the two agree on size, which
 * the column relies on — it reserves width for the pill, and `lib/axisLabelPlacement.js` keeps tick
 * labels clear of its height.
 */

export default function AvgPill({ x, centerY, text }) {
  const width = avgPillWidth(text)
  return (
    <g style={{ pointerEvents: 'none' }}>
      <rect
        x={x}
        y={centerY - AVG_PILL_HEIGHT / 2}
        width={width}
        height={AVG_PILL_HEIGHT}
        rx={3}
        fill="var(--accent2)"
        opacity={0.92}
      />
      <text
        x={x + width / 2}
        y={centerY + 3.5}
        fontSize={10}
        fontWeight={600}
        fill="#fff"
        textAnchor="middle"
      >
        {text}
      </text>
    </g>
  )
}
