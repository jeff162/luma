// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Rectangle } from 'recharts'
import { clippedBarGeometry, tornSegmentPath } from '../lib/chartOutliers.js'
import { formatSignedAxisTick } from '../lib/moneyDisplay.js'

/*
 * A bar that runs off the end of its axis, drawn so that it says so.
 *
 * Pairs with `lib/chartOutliers.js`: that decides the axis bound, which bars exceed it, and where this
 * one's pieces go. A clipped bar reaches the frame, is broken across the middle, and carries its real
 * figure inside its value end — so it reads as *beyond the scale* rather than as merely the tallest bar,
 * which is the whole point, since the reason for clamping was that one enormous bar made every other bar
 * unreadable.
 *
 * A bar that is not clipped renders through recharts' own `Rectangle` with the props it was given, so
 * the ordinary case — which is nearly every case, since clamping only engages for a genuine tail — is
 * pixel-identical to a chart that never heard of this.
 */

export default function ClippedBar(props) {
  const { payload, value, x, y, width, height, fill } = props
  if (!payload?.__clipped) return <Rectangle {...props} />

  const geometry = clippedBarGeometry({ x, y, width, height, value })
  const trueValue = payload.__clippedValue

  return (
    <g>
      {geometry.segments.map((segment, i) => (
        <path key={i} d={tornSegmentPath({ x: geometry.x, width: geometry.width, ...segment })} fill={fill} />
      ))}
      {Number.isFinite(Number(trueValue)) && (
        // Inert, so it never sits between the cursor and the bar's own click target.
        <text
          x={x + width / 2}
          y={geometry.labelY}
          textAnchor="middle"
          fontSize={10}
          fontWeight={600}
          fill="#fff"
          style={{ pointerEvents: 'none' }}
        >
          {formatSignedAxisTick(trueValue)}
        </text>
      )}
    </g>
  )
}
