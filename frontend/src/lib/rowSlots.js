// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * A server-paged list held as one slot per row of the whole result, loaded or not.
 *
 * The list is sized to the server's `total` from the first response, so the scroll height (and so the
 * scrollbar thumb) is the whole list's from the start, and a page is fetched for wherever the reader is
 * rather than for the end of what is already loaded. An unloaded slot is `undefined`.
 *
 * A slot can also be `null`: loaded, but holding no row because its row is already listed in another
 * slot. Offsets are only as stable as the ledger under them, so an edit that moves a row in the sort
 * (or a row arriving) between two page fetches can bring one row back in a second page. Listing it
 * twice would give two list items one key; leaving the slot unloaded would fetch the same page forever.
 *
 * The array never has holes: a hole is skipped by `every`, `filter` and `map`, so a check such as "are
 * the first n rows loaded" would pass over exactly the rows it is asking about. Every array built here is
 * filled explicitly.
 */

/**
 * The slots for a list of `total` rows: the old slots kept where they still fit, `rows` placed at `offset`.
 * With `keyOf`, a row already listed outside the page's own slots is placed as `null`.
 */
export function placeRows(slots, total, offset, rows, keyOf = null) {
  const next = new Array(total).fill(undefined)
  const kept = Math.min(slots.length, total)
  for (let i = 0; i < kept; i += 1) next[i] = slots[i]
  const end = Math.min(total, offset + rows.length)
  const listedElsewhere = new Set()
  if (keyOf) {
    next.forEach((row, i) => {
      if (row != null && (i < offset || i >= end)) listedElsewhere.add(keyOf(row))
    })
  }
  for (let i = offset; i < end; i += 1) {
    const row = rows[i - offset]
    next[i] = keyOf && listedElsewhere.has(keyOf(row)) ? null : row
  }
  return next
}

/** The page indexes that rows `start..end` (inclusive) fall in, clamped to the list. */
export function pagesCovering(start, end, total, pageSize) {
  if (total <= 0) return []
  const first = Math.floor(Math.max(0, start) / pageSize)
  const last = Math.floor(Math.min(total - 1, Math.max(0, end)) / pageSize)
  const pages = []
  for (let page = first; page <= last; page += 1) pages.push(page)
  return pages
}

/** The first page among rows `start..end` that still has an unloaded slot, or null. */
export function firstMissingPage(slots, start, end, pageSize) {
  for (const page of pagesCovering(start, end, slots.length, pageSize)) {
    const pageEnd = Math.min(slots.length, (page + 1) * pageSize)
    for (let i = page * pageSize; i < pageEnd; i += 1) {
      if (slots[i] === undefined) return page
    }
  }
  return null
}

/** The loaded rows, in list order. */
export function loadedRows(slots) {
  return slots.filter(row => row != null)
}

/** The rows in the first `count` slots if every one of them is loaded, otherwise null. */
export function leadingRows(slots, count) {
  const leading = slots.slice(0, count)
  return leading.length === count && leading.every(row => row !== undefined) ? loadedRows(leading) : null
}

/**
 * The slots after `update`, an edit written against the loaded rows alone, as hosts write them: a `map`
 * that patches rows, a `filter` that drops them, or a prepend that adds one.
 *
 * Rows are matched back to their slots by `keyOf`. A row the edit kept replaces its slot. A row it dropped
 * is taken out rather than emptied, so the rows after it close up exactly as they do on the server, which
 * no longer returns the row, and a page fetched afterwards lands at the offsets it is placed at. A row new
 * to the list goes in just before the loaded row it precedes in the edit's answer, or after the last
 * loaded row.
 */
export function applyToLoaded(slots, update, keyOf) {
  const loaded = loadedRows(slots)
  const next = typeof update === 'function' ? update(loaded) : update
  if (next === loaded) return slots
  const loadedKeys = new Set(loaded.map(keyOf))
  const kept = new Map()
  const addedBefore = new Map()
  let added = []
  for (const row of next) {
    const key = keyOf(row)
    if (!loadedKeys.has(key)) {
      added.push(row)
      continue
    }
    kept.set(key, row)
    if (added.length) {
      addedBefore.set(key, added)
      added = []
    }
  }
  const result = []
  let lastLoaded = -1
  for (const row of slots) {
    if (row == null) {
      result.push(row)
      continue
    }
    const key = keyOf(row)
    if (addedBefore.has(key)) result.push(...addedBefore.get(key))
    if (kept.has(key)) {
      result.push(kept.get(key))
      lastLoaded = result.length - 1
    }
  }
  if (added.length) result.splice(lastLoaded + 1, 0, ...added)
  return result
}
