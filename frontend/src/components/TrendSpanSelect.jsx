// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef } from 'react'
import { format } from 'date-fns'
import { getFormControlStyle } from './ui.jsx'
import {
  TREND_SPAN_ALL, TREND_SPAN_PRESET_OPTIONS,
  parseTrendSpan, trendSpanFloorMonth, trendSpanSince,
} from '../lib/trendSpan.js'

/*
 * The chooser for how much history a trend chart draws — see `lib/trendSpan.js` for what the value
 * means and why the three charts share one. Presentational: the setting is read and persisted once by
 * the page, so every chart in a frame moves together.
 *
 * The presets carry the ordinary answers and `Since…` the exact one, spelled out across plain selects:
 * `Since… | Jan | 2022` reads as one sentence, and the left select stops repeating a date already shown
 * beside it. Picking `Since…` seeds the fields from the span currently in force — so the chart does not
 * move before a year is chosen — and focuses the year, which is the field that pick was about.
 *
 * **Selects rather than `<input type="month">`**, which this shipped with first and which was the wrong
 * control twice over: its year has to be scrolled with nothing on screen to suggest that it can be, and
 * the panel it opens is browser chrome — not sizeable, not styleable, and not consistent about whether
 * a year can be typed into it. A select is unmistakably a list, and the years it offers are the ones
 * the ledger actually covers.
 *
 * **The month is offered only where a month changes the answer.** A whole-year chart rounds the floor
 * out to the year containing it (`trendSpanFloorYear`), so a month field there is a control with no
 * effect. The stored month rides along through a year change rather than being reset, so a month picked
 * on the single-period trend survives a visit to the annual charts.
 *
 * `grain` is the bucket the chart it sits on draws, which is also what makes the seed the floor actually
 * in force: a year chart showing the last 5 years starts in January five years back, not in the month
 * five years back.
 */

const SINCE_OPTION = '__since__'

const MONTH_NAMES = Array.from({ length: 12 }, (_, index) => format(new Date(2000, index, 1), 'MMM'))

// Newest first, as the app's other year pickers list them: the years the data covers, plus the year in
// force so a stored value is never missing from its own list.
function yearOptions(month, dataFirstMonth, dataLastMonth) {
  const years = new Set([Number(month.slice(0, 4))])
  const first = dataFirstMonth ? Number(dataFirstMonth.slice(0, 4)) : null
  const last = dataLastMonth ? Number(dataLastMonth.slice(0, 4)) : null
  if (first !== null && last !== null) {
    for (let year = first; year <= last; year++) years.add(year)
  }
  return [...years].sort((a, b) => b - a)
}

export default function TrendSpanSelect({
  value,
  onChange,
  dataFirstMonth = null,
  dataLastMonth = null,
  grain = 'month',
  ariaLabel = 'History shown',
}) {
  const span = parseTrendSpan(value)
  const isSince = span.kind === 'since'
  const yearRef = useRef(null)
  const focusYearRef = useRef(false)

  useEffect(() => {
    if (!focusYearRef.current || !isSince) return
    focusYearRef.current = false
    yearRef.current?.focus()
  }, [isSince])

  // The month the chart is already floored at, so switching to Since… changes nothing until a year is
  // picked. All data falls back to where the data starts, which is that floor in all but name; with no
  // data at all there is nothing to seed from and the entry is unofferable rather than inert.
  const sinceSeed = trendSpanFloorMonth(value, dataLastMonth, grain) || dataFirstMonth || dataLastMonth
  const fieldStyle = { ...getFormControlStyle({ size: 'sm', clickable: true }), borderRadius: 8 }

  function handleSelect(next) {
    if (next !== SINCE_OPTION) {
      onChange(next)
      return
    }
    focusYearRef.current = true
    onChange(trendSpanSince(sinceSeed))
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <select
        value={isSince ? SINCE_OPTION : (value || TREND_SPAN_ALL)}
        onChange={event => handleSelect(event.target.value)}
        aria-label={ariaLabel}
        style={fieldStyle}
      >
        {TREND_SPAN_PRESET_OPTIONS.map(option => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
        <option value={SINCE_OPTION} disabled={!isSince && !sinceSeed}>Since…</option>
      </select>
      {isSince && grain !== 'year' && (
        <select
          value={span.month.slice(5)}
          onChange={event => onChange(trendSpanSince(`${span.month.slice(0, 4)}-${event.target.value}`))}
          aria-label="Earliest month shown"
          style={fieldStyle}
        >
          {MONTH_NAMES.map((name, index) => (
            <option key={name} value={String(index + 1).padStart(2, '0')}>{name}</option>
          ))}
        </select>
      )}
      {isSince && (
        <select
          ref={yearRef}
          value={span.month.slice(0, 4)}
          onChange={event => onChange(trendSpanSince(`${event.target.value}-${span.month.slice(5)}`))}
          aria-label="Earliest year shown"
          style={fieldStyle}
        >
          {yearOptions(span.month, dataFirstMonth, dataLastMonth).map(year => (
            <option key={year} value={String(year)}>{year}</option>
          ))}
        </select>
      )}
    </span>
  )
}
