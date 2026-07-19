// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Spinner, EmptyState, SelectAllCheckbox } from '../ui.jsx'
import PillGridTable from '../PillGridTable.jsx'
import { useColumnPreference } from '../../lib/useColumnPreference.js'

// The shared match-report table: a sortable list where each row is one match entry (typically a left
// record ↔ a matched right record, via TransactionMatchCell). Extracted from the duplicate-detection
// report so any "did these records match?" report — duplicate detection, Amazon reconciliation, … —
// renders in one consistent format.
//
// Scope is deliberately just the *table*: the pill header (sort / drag-to-reorder / resize, geometry
// persisted per user), the optional select-all / per-row checkboxes, and the rows themselves.
// Everything policy-shaped stays in the report that uses it, because it differs per report:
//   - sort is **controlled** — the report passes already-sorted `entries` + the current `sortState` and
//     owns `onHeaderClick` (the duplicate report sorts with a Kind tiebreaker and a date-defaults-desc
//     toggle; reconciliation sorts plainly);
//   - selection is **controlled** — the report owns `selectedIds` and the toggles (so it can drive its own
//     bulk bar); a report with no bulk actions just passes `selectable={false}`;
//   - per-row actions, the bulk-action bar, filters, and the surrounding chrome (floating panel, account
//     scoping) all stay in the report — per-row actions ride in a column's `render`.
//
// A `column` is { key, label, width?, minWidth?, align?, sortable?, render(entry) }.
// `getRowId(entry, index)` gets the index too, so a report whose entries have no natural id can key off
// position without scanning the list for it (that scan is O(n) per row, which windowing calls per
// mounted row — it was O(n²) on the entry count).
//
// **Rows are windowed** (@tanstack/react-virtual, measured heights): only the rows in/near the viewport
// are in the DOM, so node count is bounded by the viewport rather than the entry count. A single
// reconciliation bucket can hold thousands of entries, which as plain DOM cost multi-second renders.
// Two consequences worth knowing before changing this file:
//   - **Column widths must not depend on which rows are mounted.** The old `<table>` auto-sized its
//     columns from row content, which under windowing makes widths jump as the user scrolls. Widths now
//     come from the persisted geometry through PillGridTable's `--pgt-grid` template, exactly as the
//     duplicate-rows dialog does — that fixed template is what makes windowing safe here.
//   - **Sort and selection stay driven from the full `entries` list**, never from the mounted subset;
//     select-all still means all filtered entries, not the ~30 on screen.

// Geometry (what persists and what the grid template is built from) has to be a stable reference for
// useColumnPreference, but a consumer rebuilds its `columns` array every render because the `render`
// closures capture live state (pending flags, row action handlers). So we split them here: geometry is
// memoized against a signature of just the persisted fields, and the renderers are zipped back on by key
// each render. That keeps the consumer API a single `columns` array.
const GEOMETRY_FIELDS = ['key', 'label', 'width', 'minWidth', 'align', 'sortable', 'draggable', 'resizable']

function geometrySignature(columns, selectable) {
  return JSON.stringify([selectable, columns.map(col => GEOMETRY_FIELDS.map(field => col[field] ?? null))])
}

const SELECT_COLUMN_KEY = '__select__'
const SELECT_COLUMN_WIDTH = 34

export function MatchReport({
  columns = [],
  entries = [],
  getRowId,
  getRowStripe,
  sortState = null,
  onHeaderClick,
  selectable = false,
  selectedIds = null,
  onToggleRow,
  onToggleAll,
  allVisibleSelected = false,
  someVisibleSelected = false,
  loading = false,
  error = '',
  emptyMessage = 'Nothing to show.',
  // Distinct per report, so each one remembers its own column layout.
  columnsPrefKey,
  // Only a first-paint guess; every mounted row is measured and the estimate is corrected.
  estimatedRowHeight = 56,
}) {
  const scrollRef = useRef(null)

  const signature = geometrySignature(columns, selectable)
  const defaultColumns = useMemo(
    () => {
      const geometry = columns.map(col => ({
        key: col.key,
        label: col.label,
        // A column that never carried an explicit width used to be auto-sized by the browser from its
        // content; under a fixed template it needs a real starting width. These are first-open defaults
        // only — the user's own resize wins from then on.
        width: typeof col.width === 'number' ? col.width : 200,
        minWidth: col.minWidth ?? 64,
        align: col.align === 'right' ? 'end' : col.align,
        sortable: col.sortable !== false,
      }))
      if (!selectable) return geometry
      return [
        { key: SELECT_COLUMN_KEY, label: '', width: SELECT_COLUMN_WIDTH, minWidth: SELECT_COLUMN_WIDTH, align: 'center', sortable: false, draggable: false, resizable: false },
        ...geometry,
      ]
    },
    // Rebuilding only when the persisted fields actually change is the point — see the note above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signature],
  )

  const [cols, handleColumnsChange] = useColumnPreference(columnsPrefKey, defaultColumns)

  const renderers = useMemo(
    () => new Map(columns.map(col => [col.key, col.render])),
    [columns],
  )

  const rowVirtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimatedRowHeight,
    // Entry identity, not list position, so a re-sort or a filter change re-keys the measurement cache
    // instead of reusing the previous row's height at that index.
    getItemKey: useCallback(index => getRowId(entries[index], index), [entries, getRowId]),
    overscan: 10,
  })

  // A column resize changes how much row content wraps, so every cached row height is stale. The live
  // drag mutates the CSS var straight on the DOM (PillGridTable never re-renders during the gesture) and
  // the per-row ResizeObserver catches that; this covers the committed change, which does re-render.
  const gridSignature = cols.map(col => col.width).join(',')
  useEffect(() => {
    rowVirtualizer.measure()
  }, [gridSignature, rowVirtualizer])

  const headerColumns = useMemo(
    () => cols.map(col => (
      col.key === SELECT_COLUMN_KEY
        ? {
          ...col,
          cellPadding: '0',
          render: () => (
            <SelectAllCheckbox
              checked={allVisibleSelected}
              indeterminate={someVisibleSelected}
              onChange={onToggleAll}
              title={allVisibleSelected ? 'Deselect all visible' : 'Select all visible'}
            />
          ),
        }
        : {
          ...col,
          title: col.draggable === false ? col.label : `Click to sort. Drag to move ${col.label || 'column'}`,
        }
    )),
    [cols, allVisibleSelected, someVisibleSelected, onToggleAll],
  )

  if (loading) return <div style={{ padding: '12px 16px' }}><Spinner /></div>
  if (error) return <div style={{ padding: '12px 16px', color: 'var(--danger)' }}>{error}</div>
  if (entries.length === 0) return <div style={{ padding: '12px 16px' }}><EmptyState message={emptyMessage} /></div>

  const virtualRows = rowVirtualizer.getVirtualItems()

  return (
    <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
      <PillGridTable
        columns={headerColumns}
        onColumnsChange={handleColumnsChange}
        sortState={sortState}
        onSort={onHeaderClick}
        headerStyle={{
          padding: '6px 8px',
          background: 'var(--surface)',
          position: 'sticky',
          top: 0,
          zIndex: 2,
          boxShadow: '0 1px 0 var(--border)',
        }}
        renderBody={({ gridTemplateColumns }) => (
          // The spacer carries the full scroll height; the inner wrapper is offset to the first mounted
          // row so each row can be measured at its natural height (the dynamic-measurement pattern —
          // per-row absolute positioning fights ResizeObserver).
          <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative', fontSize: 12 }}>
            <div style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualRows[0]?.start ?? 0}px)`,
            }}>
              {virtualRows.map(virtualRow => {
                const entry = entries[virtualRow.index]
                const id = getRowId(entry, virtualRow.index)
                const stripe = getRowStripe ? getRowStripe(entry) : 'var(--border)'
                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={rowVirtualizer.measureElement}
                    style={{
                      display: 'grid',
                      gridTemplateColumns,
                      alignItems: 'center',
                      borderBottom: '1px solid color-mix(in srgb, var(--border) 60%, transparent)',
                      borderLeft: `3px solid ${stripe}`,
                    }}
                  >
                    {cols.map(col => (
                      col.key === SELECT_COLUMN_KEY ? (
                        <div key={col.key} style={{ padding: '6px 0', textAlign: 'center' }}>
                          <input type="checkbox" checked={!!selectedIds?.has(id)} onChange={() => onToggleRow?.(entry)} />
                        </div>
                      ) : (
                        <div
                          key={col.key}
                          style={{
                            padding: '6px 8px',
                            minWidth: 0,
                            textAlign: col.align === 'end' ? 'right' : col.align === 'center' ? 'center' : 'left',
                          }}
                        >
                          {renderers.get(col.key)?.(entry)}
                        </div>
                      )
                    ))}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      />
    </div>
  )
}
