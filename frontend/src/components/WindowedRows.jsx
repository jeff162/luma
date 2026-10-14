// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Render-windowing for a long row list: only the rows in/near the viewport are mounted, so DOM node
 * count is bounded by the viewport rather than the dataset. Shared by every long list in the app
 * (MatchReport, TransactionListTable, the Transactions ledger) so windowing behaves identically
 * everywhere and the measurement/anchoring subtleties live in one place.
 *
 * The caller owns the scroll container and passes it in as `scrollRef` — this component renders only
 * the body, so it drops straight into a `PillGridTable` `renderBody` without disturbing the
 * sticky-header + single-outer-scroll-container contract (see ui-patterns.md).
 *
 * Two things a caller must get right:
 *   - **Column widths must not depend on which rows are mounted.** Feed widths from the shared grid
 *     template (`--pgt-grid` via useColumnPreference), never from content auto-sizing, or columns will
 *     visibly jump as rows mount and unmount. Pass the template string as `measureKey` so a committed
 *     column resize re-measures rows whose content re-wrapped at the new width.
 *   - **Don't put `content-visibility: auto` on a windowed row.** It makes an off-screen row report its
 *     `contain-intrinsic-size` placeholder instead of its true height, which feeds the virtualizer a
 *     wrong measurement. It is also redundant here: windowing already keeps unmounted rows out of
 *     layout entirely.
 */

import { useEffect, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

const UNLOADED_KEY_PREFIX = 'unloaded:'
const AVERAGE_SAMPLE_ROWS = 50

export default function WindowedRows({
  scrollRef,
  items = [],
  getItemKey,
  // A first-paint guess only. Every mounted row is measured, and once some are, their average stands in
  // for the rows not yet drawn (see averageRef).
  estimateSize = 44,
  overscan = 10,
  // Change this whenever something outside the row data alters row heights (the grid template being
  // the usual one) to drop the cached measurements.
  measureKey = '',
  renderRow,
  // Optional imperative handle: `apiRef.current.scrollToIndex(index, { align })` scrolls a given item
  // into view even when it isn't currently mounted (a jump-nav can't rely on scrollIntoView, because the
  // target row may not be in the DOM). Used by the Rules page A–Z rail.
  apiRef = null,
  // Optional: reports the index of the topmost item at the viewport edge as the user scrolls, so a caller
  // can highlight the current section. Fired only when the top index changes.
  onTopIndexChange = null,
  // Optional: reports `{ startIndex, endIndex }`, the items in the viewport (overscan excluded), whenever
  // that range changes, so a caller holding a partly loaded list can fetch the rows being looked at. In
  // such a list an item not loaded yet is `undefined`, drawn as a placeholder the height of an average row,
  // and an item that is `null` is drawn as nothing (lib/rowSlots.js); neither reaches `getItemKey` or
  // `renderRow`.
  onRangeChange = null,
}) {
  // The average height of the rows measured so far, which sizes every row not drawn yet. A fixed guess is
  // only right for the fonts it was tuned against: where rows draw a couple of pixels taller, the list
  // grows by that much for every row drawn the first time, and a dragged scrollbar thumb falls behind the
  // pointer until the whole list has been seen. Sampled from the first rows only, because rows in one
  // list are alike and a recount on every scroll would cost a pass over every row measured.
  const averageRef = useRef(null)
  const sampledRef = useRef(0)
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef?.current ?? null,
    estimateSize: () => averageRef.current ?? estimateSize,
    onChange: instance => {
      if (sampledRef.current >= AVERAGE_SAMPLE_ROWS) return
      let sum = 0
      let count = 0
      instance.itemSizeCache.forEach((size, key) => {
        if (String(key).startsWith(UNLOADED_KEY_PREFIX)) return
        sum += size
        count += 1
      })
      if (count === 0) return
      sampledRef.current = count
      averageRef.current = sum / count
    },
    // Item identity, not list position, so a re-sort or a filter change re-keys the measurement cache
    // instead of reusing whatever row previously sat at that index.
    getItemKey: index => (items[index] == null ? `${UNLOADED_KEY_PREFIX}${index}` : getItemKey(items[index], index)),
    overscan,
  })

  useEffect(() => {
    averageRef.current = null
    sampledRef.current = 0
    virtualizer.measure()
  }, [measureKey, virtualizer])

  useEffect(() => {
    if (!apiRef) return undefined
    apiRef.current = {
      scrollToIndex: (index, options = { align: 'start' }) => virtualizer.scrollToIndex(index, options),
    }
    return () => { apiRef.current = null }
  }, [apiRef, virtualizer])

  const virtualRows = virtualizer.getVirtualItems()

  // Track the topmost item at the viewport edge (past overscan) for the current-section highlight.
  const lastTopIndexRef = useRef(null)
  useEffect(() => {
    if (!onTopIndexChange) return
    const offset = virtualizer.scrollOffset ?? 0
    const top = virtualRows.find(r => r.start + r.size > offset + 1) ?? virtualRows[0]
    const topIndex = top?.index ?? null
    if (topIndex != null && topIndex !== lastTopIndexRef.current) {
      lastTopIndexRef.current = topIndex
      onTopIndexChange(topIndex)
    }
  })

  const lastRangeRef = useRef(null)
  useEffect(() => {
    if (!onRangeChange || !virtualizer.range) return
    const { startIndex, endIndex } = virtualizer.range
    const last = lastRangeRef.current
    if (last && last.startIndex === startIndex && last.endIndex === endIndex) return
    lastRangeRef.current = { startIndex, endIndex }
    onRangeChange(lastRangeRef.current)
  })

  return (
    // The spacer carries the full scroll height so the scrollbar reflects the whole list; the inner
    // wrapper is offset to the first mounted row so each row can be measured at its natural height.
    // (Positioning each row absolutely instead would fight the ResizeObserver that measures them.)
    <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
      <div style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        transform: `translateY(${virtualRows[0]?.start ?? 0}px)`,
      }}>
        {virtualRows.map(virtualRow => (
          // An unloaded slot is not measured: it takes the size the virtualizer already gives it, so its
          // placeholder never changes the list's height when it mounts. (An empty `null` slot is measured,
          // at zero; neither counts toward the average.)
          <div
            key={virtualRow.key}
            data-index={virtualRow.index}
            ref={items[virtualRow.index] === undefined ? undefined : virtualizer.measureElement}
          >
            {items[virtualRow.index] === undefined
              ? <UnloadedRow height={virtualRow.size} />
              : items[virtualRow.index] === null ? null : renderRow(items[virtualRow.index], virtualRow.index)}
          </div>
        ))}
      </div>
    </div>
  )
}

// A row whose data has not arrived: the row's height and rule, so nothing shifts when it does.
function UnloadedRow({ height }) {
  return (
    <div style={{
      height,
      boxSizing: 'border-box',
      padding: '0 14px',
      display: 'flex',
      alignItems: 'center',
      borderBottom: '1px solid var(--border)',
    }}>
      <div style={{ width: '40%', height: 10, borderRadius: 4, background: 'var(--surface2)' }} />
    </div>
  )
}
