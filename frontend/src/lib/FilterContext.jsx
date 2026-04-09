// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

/*
 * Filters live above individual pages so the shared FilterBar can preserve one cross-app view of
 * "what the user is looking at" while each screen translates the same typed selections into its own API params.
 */

import { createContext, useContext, useState } from 'react'

const DEFAULT_FILTERS = {
  date: null,
  selections: [],
}

const FilterContext = createContext(null)

export function FilterProvider({ children }) {
  const [filters, setFilters] = useState(DEFAULT_FILTERS)

  function setDate(date) { setFilters(f => ({ ...f, date })) }
  function clearDate()   { setFilters(f => ({ ...f, date: null })) }

  function addSelection(sel) {
    setFilters(f => ({
      ...f,
      // Repeated picks can come from different entry points; dedupe them into one shared active filter chip.
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
