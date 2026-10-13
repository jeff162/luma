// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * What a chart whose whole column is the click target needs from recharts.
 *
 * Such a chart puts `onClick` on the chart rather than on its bars, and recharts answers with the point
 * the *tooltip* is on — the hover state, not the click's own position. By default it updates that state
 * a frame after the pointer moves, so a click arriving in the same frame as the move that reached it is
 * told nothing is active. A mouse rarely does that; a tap always does, since the browser delivers a
 * tap's move and click together. `CLICKABLE_CHART_EVENTS` turns the deferral off, and belongs on every
 * chart that reads `clickedDataIndex` or the active label in its `onClick`.
 */
export const CLICKABLE_CHART_EVENTS = { throttledEvents: [] }

/*
 * The index of the data point under a chart-level click, as a number, or null when the click landed
 * outside the plot.
 *
 * recharts reports the index as a string ("3"). A string still indexes an array, which is what hides
 * the difference: it goes wrong only where the index is compared, type-checked or stored. Every chart
 * click handler reads the index through here.
 */
export function clickedDataIndex(state) {
  const raw = state?.activeTooltipIndex
  if (raw == null || raw === '') return null
  const index = Number(raw)
  return Number.isInteger(index) && index >= 0 ? index : null
}
