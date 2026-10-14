// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useState } from 'react'

// Key for the render-only leading select column injected into bulk-capable transaction tables.
export const BULK_SELECT_COLUMN_KEY = '__bulk_select__'

/*
 * Selection state for bulk transaction operations, shared by any table that wants bulk edit.
 *
 * Two modes so "select all" can mean every row matching the current filter, not just the rows that
 * happen to be loaded in a scroll region:
 *   - explicit:  `allMatching=false`, an `ids` Set of individually checked rows.
 *   - all-matching: `allMatching=true`, plus an `excluded` Set of rows unchecked after select-all.
 * The bulk API resolves all-matching server-side from the caller-supplied filter, so it covers
 * non-visible rows. `total` (the filtered result count, which the page already knows) is passed in
 * where a count is needed rather than stored here.
 */
export function useTransactionSelection() {
  const [allMatching, setAllMatching] = useState(false)
  const [ids, setIds] = useState(() => new Set())
  const [excluded, setExcluded] = useState(() => new Set())

  const isSelected = useCallback(
    id => (allMatching ? !excluded.has(id) : ids.has(id)),
    [allMatching, ids, excluded],
  )

  const toggle = useCallback(id => {
    if (allMatching) {
      setExcluded(prev => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    } else {
      setIds(prev => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    }
  }, [allMatching])

  const clear = useCallback(() => {
    setAllMatching(false)
    setIds(new Set())
    setExcluded(new Set())
  }, [])

  const selectAllMatching = useCallback(() => {
    setAllMatching(true)
    setIds(new Set())
    setExcluded(new Set())
  }, [])

  const selectedCount = useCallback(
    total => (allMatching ? Math.max(0, (total || 0) - excluded.size) : ids.size),
    [allMatching, excluded, ids],
  )

  // Build the API `selection` payload. In all-matching mode the caller passes the list's current
  // filter params so the server resolves the same rows the user is looking at.
  const toSelectionPayload = useCallback(
    filterParams => (
      allMatching
        ? { mode: 'filter', filter: filterParams || {}, exclude_ids: [...excluded] }
        : { mode: 'ids', ids: [...ids] }
    ),
    [allMatching, excluded, ids],
  )

  return {
    allMatching,
    excludedCount: excluded.size,
    isSelected,
    toggle,
    clear,
    selectAllMatching,
    selectedCount,
    toSelectionPayload,
  }
}
