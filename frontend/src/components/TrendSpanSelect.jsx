// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { getFormControlStyle } from './ui.jsx'
import { TREND_SPAN_ALL, TREND_SPAN_PRESET_OPTIONS, parseTrendSpan } from '../lib/trendSpan.js'

/*
 * The chooser for how far back a trend chart reaches — see `lib/trendSpan.js` for what the value means
 * and why the three charts share one. Presentational: the setting is read and persisted once by the
 * page, so every chart in a frame moves together.
 *
 * Presets only. The span is a limit counted back from where the page ends the chart, so it never names a
 * date of its own; a start date here would be a second period selector competing with the date filter.
 */
export default function TrendSpanSelect({ value, onChange, ariaLabel = 'History shown' }) {
  const span = parseTrendSpan(value)
  const current = span.kind === 'years' ? `${span.years}y` : TREND_SPAN_ALL
  const fieldStyle = { ...getFormControlStyle({ size: 'sm', clickable: true }), borderRadius: 8 }
  return (
    <select value={current} onChange={event => onChange(event.target.value)} aria-label={ariaLabel} style={fieldStyle}>
      {TREND_SPAN_PRESET_OPTIONS.map(option => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  )
}
