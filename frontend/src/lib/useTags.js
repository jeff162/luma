// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Shared tag-list cache.
 *
 * The full tag list is read-only reference data that a dozen surfaces need to populate their tag
 * pickers (the transaction editor, bulk edit, rule editor, filter bar, …). Each used to keep its own
 * `useState(null)` + fetch-with-cancelled-flag effect, so every surface both re-implemented the same
 * effect and hit `GET /tags` again. `useTags()` centralizes both: one module-level cache, one fetch
 * shared across all consumers, and a subscription so every open picker updates together.
 *
 * Invalidation is explicit, not signal-driven: tags only change from the tag manager (`TagsDialog`)
 * (create/edit/delete → call `invalidateTags()`) and the inline "+ New tag" in `TagPickerWithCreate`
 * (→ `addTagToCache()`). Listening to the global `luma:data-mutated` signal would refetch tags on
 * every unrelated transaction edit, so the two real mutation sites notify this cache directly instead.
 *
 * Not for per-row use. `TransactionAmountCell` renders once per ledger row and fetches lazily only
 * when its picker opens; subscribing thousands of rows here would be a listener storm. Panel-level
 * consumers (mounted once) are the intended callers.
 */

import { useEffect, useState } from 'react'
import { api } from './api.js'

let cache = null          // null = never loaded; array = loaded (possibly empty)
let inflight = null       // dedupes concurrent initial fetches into one request
const listeners = new Set()

function emit() {
  for (const listener of listeners) listener(cache)
}

function loadTags(force = false) {
  if (cache !== null && !force) return Promise.resolve(cache)
  if (!inflight) {
    inflight = api.getTags()
      .then(rows => { cache = Array.isArray(rows) ? rows : [] })
      .catch(() => { cache = [] })
      .finally(() => { inflight = null; emit() })
  }
  return inflight
}

// Refetch the tag list and notify every mounted consumer. Call after a tag create/edit/delete.
export function invalidateTags() {
  return loadTags(true)
}

// Optimistically merge a just-created tag so open pickers show it before a refetch lands.
export function addTagToCache(tag) {
  if (!tag?.id) return
  if (cache === null) cache = []
  if (!cache.some(existing => existing.id === tag.id)) {
    cache = [...cache, tag]
    emit()
  }
}

// Shared tag list for a picker. Returns the cached tags (empty array until the first load resolves),
// a `loading` flag for the initial fetch, and `addTag` to fold in an inline-created tag.
export function useTags() {
  const [tags, setTags] = useState(cache || [])
  const [loading, setLoading] = useState(cache === null)

  useEffect(() => {
    const listener = next => { setTags(next || []); setLoading(false) }
    listeners.add(listener)
    if (cache !== null) {
      setTags(cache)
      setLoading(false)
    } else {
      loadTags()
    }
    return () => { listeners.delete(listener) }
  }, [])

  return { tags, loading, addTag: addTagToCache, reload: invalidateTags }
}
