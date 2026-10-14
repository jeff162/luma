// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * A server-paged list that is the whole result's height from its first response and fetches the page
 * being looked at, rather than appending pages as the reader nears the bottom.
 *
 * Appending is what made a dragged scrollbar lag the mouse: the scroll height grew under the drag each
 * time a page landed, so the thumb shrank and jumped back up while the pointer kept going. Here the list
 * holds one slot per row of the result (lib/rowSlots.js), WindowedRows draws an unloaded slot as a
 * placeholder, and the page is fetched by its offset as the viewport reaches it.
 *
 * Shared by the Transactions ledger and `usePagedTransactions` (the detail panels and drill-down lists),
 * so the paging behaves identically everywhere. The host owns the query: it passes `fetchPage`, and calls
 * `reset` when the query changes or the ledger under it has. Spread `paging` onto the WindowedRows that
 * draws `paging.slots` (TransactionListTable takes it as its `paging` prop).
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { applyToLoaded, firstMissingPage, loadedRows, pagesCovering, placeRows } from './rowSlots.js'
import { transactionRowKey } from './splitRows.js'

/**
 * @param {object} options
 * @param {(offset: number, limit: number) => Promise<{transactions: object[], total: number}>} options.fetchPage
 *   One page of the host's query. Its identity is the query's: rows fetched with one are never placed
 *   among rows from another.
 * @param {number} options.pageSize Rows per page. Fixed, because a page is found by its offset.
 * @param {number} [options.prefetchRows] Rows past either edge of the viewport fetched before they show.
 * @param {(rows: object[]) => void} [options.onRowsLoaded] Told of every batch of rows that arrives.
 */
export function usePagedRowSlots({ fetchPage, pageSize, prefetchRows = Math.floor(pageSize / 2), onRowsLoaded = null }) {
  const [state, setState] = useState({ slots: [], total: 0 })
  // **The ticket counts calls, not queries, and that distinction is the whole rule.** The ledger used to
  // compare a key built from the resolved filter params, which answers "did the filters change while this
  // was in flight" and is blind to the case where they did not. Two loads of the *same* query overlap
  // (StrictMode runs a mount effect twice in dev; a sync, the refresh button and a bulk edit all re-load
  // with unchanged filters), both committed, and whichever landed last won by arrival order rather than
  // recency. A counter cannot collide. Page fetches carry it too, so a page of a previous answer is
  // dropped rather than placed into this one.
  const seqRef = useRef(0)
  // The fetch in flight, so pages are fetched one at a time: a drag down the scrollbar passes many pages,
  // and when each lands the next is chosen from where the viewport is *then*, so the pages dragged past
  // are never requested. A token rather than a flag, so a reset that takes over can't be released by the
  // stale fetch it replaced.
  const inFlightRef = useRef(null)
  // The `fetchPage` the slots were filled by. Until a reset commits under a new one, the slots belong to
  // the previous query and no page of the new one may be placed among them.
  const slotsFetchRef = useRef(null)
  // The rows in the viewport, as WindowedRows last reported them.
  const rangeRef = useRef(null)
  // The row a reset brings back to the top of the viewport. Holding the scroll offset is not enough: the
  // rows above it are unloaded again and sized by estimate, so the same offset lands on a different row.
  const anchorRef = useRef(null)
  const apiRef = useRef(null)
  const onRowsLoadedRef = useRef(onRowsLoaded)
  useEffect(() => { onRowsLoadedRef.current = onRowsLoaded })

  // Run the query again and replace the list with its answer. `fromTop` starts at the first row, for a new
  // query; otherwise the pages under the viewport are fetched and the reader stays on the row they were
  // on. The rows on screen stay until the answer replaces them. Resolves `{ status }` and never rejects:
  // 'ok' (with the first page's `response`), 'stale' (a later reset or clear took over) or 'failed' (the
  // list is left as it was).
  const reset = useCallback(async ({ fromTop = false } = {}) => {
    const seq = ++seqRef.current
    const token = {}
    inFlightRef.current = token
    const range = fromTop ? null : rangeRef.current
    // Every page the viewport overlaps, so a viewport straddling two pages isn't half placeholders.
    const pages = range ? pagesCovering(range.startIndex, range.endIndex, range.endIndex + 1, pageSize) : [0]
    let responses = null
    try {
      responses = await Promise.all(pages.map(page => fetchPage(page * pageSize, pageSize)))
    } catch {
      responses = null
    }
    if (inFlightRef.current === token) inFlightRef.current = null
    if (seqRef.current !== seq) return { status: 'stale' }
    if (!responses) return { status: 'failed' }

    const total = Number(responses[0]?.total || 0)
    const slots = responses.reduce(
      (acc, response, i) => placeRows(acc, total, pages[i] * pageSize, response?.transactions || [], transactionRowKey),
      [],
    )
    slotsFetchRef.current = fetchPage
    if (fromTop && rangeRef.current) {
      const { startIndex, endIndex } = rangeRef.current
      rangeRef.current = { startIndex: 0, endIndex: endIndex - startIndex }
    }
    anchorRef.current = fromTop ? 0 : (range?.startIndex ?? null)
    setState({ slots, total })
    onRowsLoadedRef.current?.(responses.flatMap(response => response?.transactions || []))
    return { status: 'ok', response: responses[0] }
  }, [fetchPage, pageSize])

  // Empty the list and drop anything in flight, for a host with nothing to show.
  const clear = useCallback(() => {
    seqRef.current += 1
    inFlightRef.current = null
    slotsFetchRef.current = null
    setState(prev => (prev.slots.length || prev.total ? { slots: [], total: 0 } : prev))
  }, [])

  // Fetch the page the viewport most needs: one it shows that is not loaded, failing that one just past
  // either edge. Each landing changes the slots, which runs this again through the effect below, and so
  // walks on to the next page wanted.
  const fetchMissingPage = useCallback(() => {
    const range = rangeRef.current
    if (!range || inFlightRef.current || slotsFetchRef.current !== fetchPage) return
    const page = firstMissingPage(state.slots, range.startIndex, range.endIndex, pageSize)
      ?? firstMissingPage(state.slots, range.startIndex - prefetchRows, range.endIndex + prefetchRows, pageSize)
    if (page == null) return
    const seq = seqRef.current
    const token = {}
    inFlightRef.current = token
    const release = () => { if (inFlightRef.current === token) inFlightRef.current = null }
    fetchPage(page * pageSize, pageSize).then(response => {
      release()
      if (seqRef.current !== seq) return
      const rows = response?.transactions || []
      // The response's total, not the list's: if the ledger changed underneath, the list is resized to
      // what the server holds now.
      const total = Number(response?.total || 0)
      setState(prev => ({ slots: placeRows(prev.slots, total, page * pageSize, rows, transactionRowKey), total }))
      onRowsLoadedRef.current?.(rows)
    }, release)
  }, [state.slots, fetchPage, pageSize, prefetchRows])

  useEffect(() => {
    fetchMissingPage()
  }, [fetchMissingPage])

  const onRangeChange = useCallback(range => {
    rangeRef.current = range
    fetchMissingPage()
  }, [fetchMissingPage])

  useLayoutEffect(() => {
    if (anchorRef.current == null) return
    apiRef.current?.scrollToIndex(anchorRef.current, { align: 'start' })
    anchorRef.current = null
  }, [state])

  // An edit to the loaded rows, written as hosts write one against a plain list (see applyToLoaded).
  const setRows = useCallback(update => setState(prev => {
    const slots = applyToLoaded(prev.slots, update, transactionRowKey)
    return slots === prev.slots ? prev : { ...prev, slots }
  }), [])

  // The count a host shows. Hosts adjust it themselves (a trash, a row leaving a series while it stays
  // listed), so it is not the number of slots; each page that arrives resets it to the server's.
  const setTotal = useCallback(update => setState(prev => ({
    ...prev,
    total: typeof update === 'function' ? update(prev.total) : update,
  })), [])

  const rows = useMemo(() => loadedRows(state.slots), [state.slots])
  const paging = useMemo(() => ({ slots: state.slots, onRangeChange, apiRef }), [state.slots, onRangeChange])

  return { slots: state.slots, rows, total: state.total, setRows, setTotal, reset, clear, paging }
}
