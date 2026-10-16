// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// A relative age that stays true while it is on screen.
//
// `formatRelativeTimestamp` is computed at render time, which is the whole objection to relative labels:
// a component that renders once and then sits there goes on claiming "5m ago" an hour later, and nothing
// about the label says it was drawn in the past. A standing surface therefore cannot just format the
// value — it has to re-render as the value ages, which is what this does.
//
// The interval is chosen from the age rather than fixed, because the two costs pull in opposite
// directions: a minute-old timestamp changes its label every minute, while a four-day-old one would not
// change if it were redrawn a thousand times. Waking an idle app every minute to re-render "3d ago" is
// pure waste, so the cadence steps down as the value gets older and stops entirely once the label has
// settled into a date. The interval is also re-derived on every tick, so a label watched across a
// boundary (the hour it crosses from minutes into hours) slows down on its own.

import { useEffect, useMemo, useState } from 'react'
import { formatRelativeTimestamp, formatTimestamp, parseTimestamp } from './utils.js'

const MINUTE = 60 * 1000

// How long the current label can remain correct, given how old the value already is.
function refreshDelay(ageMs) {
  if (ageMs < MINUTE) return 15 * 1000        // "just now" turns over inside the first minute
  if (ageMs < 60 * MINUTE) return MINUTE      // minutes tick
  if (ageMs < 24 * 60 * MINUTE) return 15 * MINUTE  // hours: a quarter-hour is finer than the label
  if (ageMs < 8 * 24 * 60 * MINUTE) return 60 * MINUTE  // days, until it becomes a date
  return null                                 // a short date never changes again; stop the timer
}

// Returns the pair a caller needs: the age to show, and the absolute moment to put on hover. Both are
// null for a missing or unparseable value, so an empty state stays the caller's wording to choose.
export function useRelativeTimestamp(value) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!value) return undefined
    // The same UTC-aware parse the label uses, or the refresh cadence is computed from an age four
    // hours out and the label stops being re-rendered when it actually changes.
    const parsed = parseTimestamp(value)
    if (Number.isNaN(parsed.getTime())) return undefined
    let timer = null
    let alive = true
    const schedule = () => {
      const delay = refreshDelay(Date.now() - parsed.getTime())
      if (delay == null) return
      timer = setTimeout(() => {
        if (!alive) return
        setNow(Date.now())
        schedule()
      }, delay)
    }
    schedule()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [value])

  return useMemo(() => ({
    label: formatRelativeTimestamp(value, now),
    absolute: formatTimestamp(value),
  }), [value, now])
}
