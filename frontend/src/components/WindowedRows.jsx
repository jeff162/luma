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

import { useEffect } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

export default function WindowedRows({
  scrollRef,
  items = [],
  getItemKey,
  // A first-paint guess only; every mounted row is measured and the estimate corrected.
  estimateSize = 44,
  overscan = 10,
  // Change this whenever something outside the row data alters row heights (the grid template being
  // the usual one) to drop the cached measurements.
  measureKey = '',
  renderRow,
}) {
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef?.current ?? null,
    estimateSize: () => estimateSize,
    // Item identity, not list position, so a re-sort or a filter change re-keys the measurement cache
    // instead of reusing whatever row previously sat at that index.
    getItemKey: index => getItemKey(items[index], index),
    overscan,
  })

  useEffect(() => {
    virtualizer.measure()
  }, [measureKey, virtualizer])

  const virtualRows = virtualizer.getVirtualItems()

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
          <div key={virtualRow.key} data-index={virtualRow.index} ref={virtualizer.measureElement}>
            {renderRow(items[virtualRow.index], virtualRow.index)}
          </div>
        ))}
      </div>
    </div>
  )
}
