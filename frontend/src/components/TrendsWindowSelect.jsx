// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { getFormControlStyle } from './ui.jsx'

/*
 * The chooser for which months a Trends form's monthly charts cover — the options are
 * `trendsWindowOptions` (`lib/trendBuckets.js`), the same list in every frame. Presentational: the page
 * holds the pick, which is shared across the frames.
 *
 * It sits where what it governs is. On the spending and income forms that is the top of the page, since
 * the monthly charts and the averages table all follow it; on the cash-flow form it is the monthly
 * chart's own card, `compact` beside the title, because that chart is the only thing it moves.
 */
export default function TrendsWindowSelect({ value, options, onChange, compact = false }) {
  return (
    <select
      value={value}
      onChange={event => onChange(event.target.value)}
      aria-label="Months shown"
      style={{ ...getFormControlStyle({ size: compact ? 'sm' : 'md', clickable: true }), borderRadius: 8 }}
    >
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  )
}
