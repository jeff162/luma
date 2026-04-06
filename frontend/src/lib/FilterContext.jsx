// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * FilterContext — Global filter state for FinTrack
 *
 * DESIGN PATTERN:
 * All filtering (date range, accounts, groups, categories, payees) lives in a
 * single React context at the app level (App.jsx wraps everything in
 * <FilterProvider>). Every page reads from this context via useFilters() rather
 * than managing its own local filter state.
 *
 * WHY: This lets filters persist across navigation. If you filter to "Chase
 * Checking" on the Transactions page and switch to Dashboard, the filter stays.
 * It also means the FilterBar component (rendered once in App.jsx) controls all
 * pages simultaneously.
 *
 * STRUCTURE:
 *   filters.date        — { start, end, preset } | null
 *                         start/end are 'YYYY-MM-DD' strings.
 *                         preset is a human label like 'Last 30 days' | null.
 *
 *   filters.selections  — Array of { type, id, label }
 *                         type is one of: 'account' | 'group' | 'category' | 'payee'
 *                         id is the DB id (or 'payee:<name>' for payees)
 *                         Selections are OR'd within a type, AND'd across types.
 *
 * HOW PAGES CONSUME IT:
 *   const { filters } = useFilters()
 *   const accountIds = filters.selections.filter(s => s.type === 'account').map(s => s.id)
 *   // Then pass to API calls as account_ids=accountIds.join(',')
 *
 * ADDING NEW FILTER TYPES:
 *   1. Add the type string to the selections array (no schema change needed)
 *   2. Add a tab to FilterBar.jsx's FilterPopover
 *   3. Handle the new type in each page's API call construction
 *
 * HELPER FUNCTIONS:
 *   resolveDateRange(date)  → { start, end } — extract YYYY-MM-DD strings
 *   resolveDateMonths(date) → ['YYYY-MM', ...] — all months in the range
 */

/**
 * FilterContext.jsx — Global filter state shared across all pages.
 *
 * DESIGN PRINCIPLES:
 * - A single FilterProvider wraps the entire app in App.jsx, so all pages
 *   read from and write to the same filter state. Navigating between pages
 *   does not reset filters.
 * - Filters are never stored in individual page components. Pages only read
 *   from this context and pass filter params to API calls.
 * - The date filter holds a preset label (e.g. "Last month"), start, and end
 *   as YYYY-MM-DD strings. The backend accepts date_start/date_end directly.
 *   When no date filter is set, API calls omit the date param entirely,
 *   returning all-time data.
 * - The selections array holds typed filter items:
 *     { type: 'account'|'group'|'category'|'payee', id, label }
 *   Each type maps to a different backend filter param (account_ids,
 *   group_ids, category_ids, payees). Multiple items of the same or
 *   different types can be active simultaneously.
 * - Helper functions resolveDateRange() and resolveDateMonths() convert
 *   the date filter into forms convenient for API calls and chart logic.
 *
 * TO ADD A NEW FILTER TYPE:
 *   1. Add a new type string to the selections items (e.g. 'tag')
 *   2. Handle it in FilterBar.jsx (new tab in the filter popover)
 *   3. Handle it in the backend query builder in transactions.py
 *   4. Pass it through in each page's API call params
 */

import { createContext, useContext, useState } from 'react'

const DEFAULT_FILTERS = {
  date:       null,   // { preset: string|null, start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' }
  selections: [],     // [{ type, id, label }]
}

const FilterContext = createContext(null)

export function FilterProvider({ children }) {
  const [filters, setFilters] = useState(DEFAULT_FILTERS)

  function setDate(date) { setFilters(f => ({ ...f, date })) }
  function clearDate()   { setFilters(f => ({ ...f, date: null })) }

  function addSelection(sel) {
    setFilters(f => ({
      ...f,
      selections: f.selections.find(s => s.id === sel.id)
        ? f.selections
        : [...f.selections, sel],
    }))
  }

  function removeSelection(id) {
    setFilters(f => ({ ...f, selections: f.selections.filter(s => s.id !== id) }))
  }

  function clearSelections() { setFilters(f => ({ ...f, selections: [] })) }
  function clearAll()        { setFilters(DEFAULT_FILTERS) }

  return (
    <FilterContext.Provider value={{
      filters, setDate, clearDate,
      addSelection, removeSelection, clearSelections, clearAll,
    }}>
      {children}
    </FilterContext.Provider>
  )
}

export function useFilters() {
  return useContext(FilterContext)
}

/** Returns { start, end } as YYYY-MM-DD strings, or nulls if no date filter set. */
export function resolveDateRange(date) {
  if (!date) return { start: null, end: null }
  return { start: date.start, end: date.end }
}

/**
 * Returns an array of all YYYY-MM month strings covered by the date range,
 * or null if no date filter is set. Used by chart components that need to
 * iterate months.
 */
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
