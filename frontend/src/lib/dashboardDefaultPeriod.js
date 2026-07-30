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
 * The user picks the default period from the gear menu: Year to date, Last 12 months, or All time. On
 * the very first visit (no stored choice yet) the *initial* value is computed for them — Last 12 months
 * when there's data in the last 12 months, else All time — so loading a pile of old historical data
 * doesn't open the Dashboard on an empty window. That's only a one-time seed: it's persisted as a
 * normal concrete choice, so "automatic" is never an ongoing mode the user has to reason about. The
 * check needs the server (there's no date-bounds endpoint), so it's a one-shot probe, module-cached.
 */

import { useEffect, useMemo, useState } from 'react'
import { startOfYear, subYears, format } from 'date-fns'
import { api } from './api.js'
import { useUserPreference } from './UserPreferencesContext.jsx'

export const DASHBOARD_DEFAULT_PERIOD_PREF_KEY = 'ui.dashboard.defaultPeriod'

// The selectable defaults, in gear-menu order. "Automatic" is not here — it's only the first-visit seed
// (see initialDefaultPref), not a choice the user keeps.
export const DASHBOARD_DEFAULT_PERIOD_OPTIONS = [
  { value: 'ytd', label: 'Year to date' },
  { value: 'last12m', label: 'Last 12 months' },
  { value: 'all', label: 'All time' },
]

const fmt = d => format(d, 'yyyy-MM-dd')

// Resolve a concrete preference into an effective date object the filter machinery understands, or
// `null` for all-time. Every option ends at *today* — the choice is only how far back it starts. `null`
// (all-time) is deliberately indistinguishable from "no default" downstream: `getDate()` returns it and
// the chip shows no default badge, which is correct.
export function resolveDashboardDefaultDate(pref) {
  const today = new Date()
  switch (pref) {
    case 'ytd':
      return { start: fmt(startOfYear(today)), end: fmt(today), preset: 'Year to date' }
    case 'last12m':
      return { start: fmt(subYears(today, 1)), end: fmt(today), preset: 'Last 12 months' }
    case 'all':
    default:
      return null
  }
}

// The concrete default to seed on first visit, from the current-year-data probe: Last 12 months when
// there's recent data, otherwise All time.
export function initialDefaultPref(hasCurrentYearData) {
  return hasCurrentYearData ? 'last12m' : 'all'
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

// Reads the default-period preference and resolves it to an effective date. Until the user (or the
// first-visit seed) has established a concrete choice, `pending` is true and the Dashboard holds its
// first paint; once a concrete value exists the resolve is synchronous.
export function useDashboardDefaultPeriod() {
  // `null` = no choice stored yet → seed it from the probe on first visit.
  const [storedPref, setStoredPref] = useUserPreference(DASHBOARD_DEFAULT_PERIOD_PREF_KEY, null)
  const [hasCurrentYearData, setHasCurrentYearData] = useState(cachedHasCurrentYearData)

  // Probe only while there's no stored choice yet (that's the only thing the probe feeds).
  useEffect(() => {
    if (storedPref != null) return
    let cancelled = false
    probeCurrentYearData().then(result => { if (!cancelled) setHasCurrentYearData(result) })
    return () => { cancelled = true }
  }, [storedPref])

  // First visit: once the probe answers, persist the computed default as a normal concrete choice, so
  // it survives reloads and never re-evaluates behind the user's back.
  useEffect(() => {
    if (storedPref == null && hasCurrentYearData !== undefined) {
      setStoredPref(initialDefaultPref(hasCurrentYearData))
    }
  }, [storedPref, hasCurrentYearData, setStoredPref])

  // Effective choice: the stored one, or the computed seed while it's still being established.
  const pref = storedPref ?? (hasCurrentYearData === undefined ? undefined : initialDefaultPref(hasCurrentYearData))
  const defaultDate = useMemo(() => (pref ? resolveDashboardDefaultDate(pref) : null), [pref])
  const pending = storedPref == null && hasCurrentYearData === undefined

  return { pref, setPref: setStoredPref, defaultDate, pending }
}
