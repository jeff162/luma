// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * The Dashboard's *default* time period — what the shared date filter means on the Dashboard when the
 * user hasn't picked a range. This is a per-user **setting** (persisted, expected to survive reloads),
 * deliberately distinct from the ephemeral **filter** (an explicit range the user picks, which is
 * shared across pages and never persisted). Keeping them separate is what resolves the old tension:
 * the filter starts unset everywhere, and only the Dashboard reinterprets "unset" as this default —
 * the Transactions page always treats unset as all-time, so the default never leaks across pages.
 *
 * `auto` is the shipped default: Last 12 months when there's data in the current year, else All time —
 * so loading a pile of old historical data and then cleaning it up doesn't open the Dashboard on an
 * empty 12-month window. That check needs the server (there's no date-bounds endpoint), so it's a
 * one-shot probe, module-cached for the session and invalidated when transactions change.
 */

import { useEffect, useMemo, useState } from 'react'
import { startOfYear, subYears, format } from 'date-fns'
import { api } from './api.js'
import { useUserPreference } from './UserPreferencesContext.jsx'

export const DASHBOARD_DEFAULT_PERIOD_PREF_KEY = 'ui.dashboard.defaultPeriod'

// Order here is the order shown in the gear menu.
export const DASHBOARD_DEFAULT_PERIOD_OPTIONS = [
  { value: 'auto', label: 'Automatic' },
  { value: 'ytd', label: 'Year to date' },
  { value: 'last12m', label: 'Last 12 months' },
  { value: 'all', label: 'All time' },
]

const fmt = d => format(d, 'yyyy-MM-dd')

// Resolve a preference (+ the current-year-data probe result, for 'auto') into an effective date object
// the filter machinery understands, or `null` for all-time. Every option ends at *today* — the choice
// is only how far back it starts. `null` (all-time) is deliberately indistinguishable from "no default"
// downstream: `getDate()` returns it, and the chip shows no default badge, which is correct.
export function resolveDashboardDefaultDate(pref, hasCurrentYearData) {
  const today = new Date()
  switch (pref) {
    case 'ytd':
      return { start: fmt(startOfYear(today)), end: fmt(today), preset: 'Year to date' }
    case 'last12m':
      return { start: fmt(subYears(today, 1)), end: fmt(today), preset: 'Last 12 months' }
    case 'all':
      return null
    case 'auto':
    default:
      // Unknown current-year data (probe pending) resolves to all-time; the caller holds the paint
      // until it settles, so this fallback only shows if the probe genuinely can't answer.
      return hasCurrentYearData ? resolveDashboardDefaultDate('last12m') : null
  }
}

// Session cache for the "is there data in the current year?" probe. `undefined` = not yet known.
let cachedHasCurrentYearData
let inflightProbe = null

function probeCurrentYearData() {
  if (cachedHasCurrentYearData !== undefined) return Promise.resolve(cachedHasCurrentYearData)
  if (!inflightProbe) {
    const yearStart = `${new Date().getFullYear()}-01-01`
    inflightProbe = api.getTransactions({ date_start: yearStart, limit: 1 })
      .then(resp => { cachedHasCurrentYearData = (resp?.total || resp?.transactions?.length || 0) > 0 })
      .catch(() => { cachedHasCurrentYearData = false })
      .finally(() => { inflightProbe = null })
      .then(() => cachedHasCurrentYearData)
  }
  return inflightProbe
}

function invalidateCurrentYearProbe() {
  cachedHasCurrentYearData = undefined
  inflightProbe = null
}

// Reads the default-period preference and resolves it to an effective date. `pending` is true only
// while the 'auto' probe hasn't answered yet (the Dashboard uses it to hold the first paint); it's
// always false for the explicit presets, which resolve synchronously.
export function useDashboardDefaultPeriod() {
  const [pref, setPref] = useUserPreference(DASHBOARD_DEFAULT_PERIOD_PREF_KEY, 'auto')
  const [hasCurrentYearData, setHasCurrentYearData] = useState(cachedHasCurrentYearData)

  useEffect(() => {
    if (pref !== 'auto') return
    let cancelled = false
    probeCurrentYearData().then(result => { if (!cancelled) setHasCurrentYearData(result) })
    // A transaction import/cleanup can change whether the current year has data; re-probe so the
    // default follows suit on the next Dashboard visit.
    const onChange = () => { invalidateCurrentYearProbe(); probeCurrentYearData().then(r => { if (!cancelled) setHasCurrentYearData(r) }) }
    window.addEventListener('luma:transactions-changed', onChange)
    return () => { cancelled = true; window.removeEventListener('luma:transactions-changed', onChange) }
  }, [pref])

  const defaultDate = useMemo(
    () => resolveDashboardDefaultDate(pref, hasCurrentYearData),
    [pref, hasCurrentYearData],
  )
  const pending = pref === 'auto' && hasCurrentYearData === undefined

  return { pref, setPref, defaultDate, pending }
}
