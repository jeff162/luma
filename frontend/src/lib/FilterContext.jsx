// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- context provider + useFilters hook + helper utilities live in one file by design */

/*
 * Filters live above individual pages so the shared FilterBar can preserve one cross-app view of
 * "what the user is looking at" while each screen translates the same typed selections into its own API params.
 */

import { createContext, useContext, useState, useCallback } from 'react'

const DEFAULT_FILTERS = {
  date: null,
  selections: [],
}

const FilterContext = createContext(null)

export function FilterProvider({ children, initialDate = null, initialSelections = [] }) {
  const [filters, setFilters] = useState({ date: initialDate, selections: initialSelections })
  // A page-scoped *default* period (currently only the Dashboard registers one). `filters.date` is the
  // user's explicit pick; when it's unset, a registered default is what `getDate()` falls back to — so
  // "unset" can mean different things per page (a Dashboard default vs. all-time on Transactions)
  // without the default ever leaking into the shared explicit filter. Explicit "All time" is a truthy
  // sentinel ({start:null,end:null}), so it overrides the default rather than reading as unset.
  const [dashboardDefaultDate, setDashboardDefaultDate] = useState(null)
  // Pages that don't honor the date chip (e.g. the Dashboard's Trends tab, which always queries a
  // fixed lookback window) can flip this to false so the chip renders in a muted/inert state and
  // the user isn't left wondering why their date selection has no effect.
  const [dateApplies, setDateApplies] = useState(true)

  function setDate(date) { setFilters(f => ({ ...f, date })) }
  // Clearing returns to *unset*, not to a hardcoded all-time — so on a page with a registered default
  // (the Dashboard) it falls back to that default. To force all-time, pick the explicit "All time"
  // preset (the truthy sentinel).
  function clearDate()   { setFilters(f => ({ ...f, date: null })) }

  // The effective period a page should honor: the user's explicit pick if set, otherwise the page's
  // registered default (null => all-time). This is the read counterpart to setDate — **this is the
  // default reader; prefer it over reading `filters.date` directly** so the default is applied uniformly.
  const getDate = useCallback(
    () => filters.date || dashboardDefaultDate,
    [filters.date, dashboardDefaultDate],
  )
  // The user's *explicit* pick only, deliberately ignoring any registered page default. This is the
  // rare exception to "always use getDate()": use it only where a page default must NEVER leak in — the
  // Transactions ledger, which must stay all-time when the filter is unset no matter what default the
  // Dashboard (or any future page) has registered. Reach for getDate() everywhere else.
  const getRawDate = useCallback(() => filters.date, [filters.date])
  // True when the effective date comes from the registered default rather than an explicit pick — the
  // chip uses this to render the period muted with a "· default" hint.
  const dateIsDefault = !filters.date && !!dashboardDefaultDate
  // A page registers its default on mount and clears it (setDefaultDate(null)) on unmount, so a default
  // is only ever in effect on the page that set it.
  const setDefaultDate = useCallback(d => setDashboardDefaultDate(d || null), [])

  // Each selection carries a mode: 'include' (the default — narrow *to* it) or 'exclude' ('is not' —
  // narrow *away* from it). Pages split selections by both type and mode into the include vs exclude
  // API params; the backend ANDs excludes on as NULL-safe negations. Tags are include-only for now.
  function addSelection(sel) {
    const withMode = { mode: 'include', ...sel }
    setFilters(f => ({
      ...f,
      // Repeated picks can come from different entry points; dedupe by id. If the item is already a
      // chip, adopt the incoming mode so clicking include on an excluded chip (or vice versa) flips it.
      selections: f.selections.find(s => s.id === withMode.id)
        ? f.selections.map(s => (s.id === withMode.id ? { ...s, mode: withMode.mode } : s))
        : [...f.selections, withMode],
    }))
  }

  function removeSelection(id) {
    setFilters(f => ({ ...f, selections: f.selections.filter(s => s.id !== id) }))
  }

  function setSelectionMode(id, mode) {
    setFilters(f => ({ ...f, selections: f.selections.map(s => (s.id === id ? { ...s, mode } : s)) }))
  }

  function toggleSelectionMode(id) {
    setFilters(f => ({
      ...f,
      selections: f.selections.map(s => (
        s.id === id ? { ...s, mode: s.mode === 'exclude' ? 'include' : 'exclude' } : s
      )),
    }))
  }

  // Batch helpers used by "select all" affordances (e.g. the [Income]/[Expense] super-group rows
  // in the filter picker). Doing this as a single state update avoids the flicker and the chip
  // reordering you'd get from N consecutive addSelection calls.
  function addSelections(items) {
    setFilters(f => {
      const existing = new Set(f.selections.map(s => s.id))
      const additions = items
        .filter(item => !existing.has(item.id))
        .map(item => ({ mode: 'include', ...item }))
      if (!additions.length) return f
      return { ...f, selections: [...f.selections, ...additions] }
    })
  }

  function removeSelections(ids) {
    const idSet = new Set(ids)
    setFilters(f => ({ ...f, selections: f.selections.filter(s => !idSet.has(s.id)) }))
  }

  function clearSelections() { setFilters(f => ({ ...f, selections: [] })) }
  function clearAll()        { setFilters(DEFAULT_FILTERS) }

  return (
    <FilterContext.Provider value={{
      filters, setDate, clearDate, getDate, getRawDate, dateIsDefault, setDefaultDate,
      addSelection, addSelections, removeSelection, removeSelections, clearSelections, clearAll,
      setSelectionMode, toggleSelectionMode,
      dateApplies, setDateApplies,
    }}>
      {children}
    </FilterContext.Provider>
  )
}

export function useFilters() {
  return useContext(FilterContext)
}

export function resolveDateRange(date) {
  if (!date) return { start: null, end: null }
  return { start: date.start, end: date.end }
}

// Chart-style views need the covered month buckets, not just the endpoints, so empty months still render in-range.
export function resolveDateMonths(date) {
  if (!date) return null
  const months = []
  const [sy, sm] = date.start.slice(0, 7).split('-').map(Number)
  const [ey, em] = date.end.slice(0, 7).split('-').map(Number)
  let y = sy, m = sm
  while (y < ey || (y === ey && m <= em)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`)
    m++; if (m > 12) { m = 1; y++ }
  }
  return months
}
