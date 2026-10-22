// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// A list order that holds still while the user works through the list.
//
// Acting on a row usually changes what it sorts by: a restored duplicate becomes a review item, a
// resolved suggestion drops its group's row count. Re-sorting after the reload moves the row out from
// under the cursor and shifts every row between its old and new place, so the next click lands on
// something else. The order is sorted once, then kept: rows already on screen keep their places, rows
// that are gone drop out, and rows that are new go at the end in sorted order. It is sorted afresh only
// when `resetKey` changes, which the caller ties to whatever the user does to ask for a new order (a
// sort header, a filter, a new open).
//
// `include` narrows which rows a fresh sort lists. A row already listed stays even after it stops
// matching, so acting on a row under a filter leaves it in place to show the result instead of pulling
// the rows below up into its slot. `getId` must name the row across whatever the action changes about
// it, or the row reads as gone and new and moves to the end.

import { useMemo, useRef } from 'react'

// The ordering itself, separate from the hook so it can be checked without rendering.
export function stableOrder(previousIds, items, { getId, compare, include }) {
  const matching = include ? items.filter(include) : items
  if (!previousIds) return [...matching].sort(compare)
  const byId = new Map(items.map(item => [getId(item), item]))
  const kept = previousIds.map(id => byId.get(id)).filter(Boolean)
  const listed = new Set(previousIds)
  const added = matching.filter(item => !listed.has(getId(item))).sort(compare)
  return [...kept, ...added]
}

export function useStableOrder(items, { getId, compare, include, resetKey }) {
  const frozenRef = useRef({ resetKey: undefined, ids: null })
  return useMemo(() => {
    const frozen = frozenRef.current
    const previousIds = frozen.ids && Object.is(frozen.resetKey, resetKey) ? frozen.ids : null
    const ordered = stableOrder(previousIds, items, { getId, compare, include })
    frozenRef.current = { resetKey, ids: ordered.map(getId) }
    return ordered
  }, [items, getId, compare, include, resetKey])
}
