// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

/*
 * Header-only table: owns the sortable/draggable/resizable column row, but the body is
 * consumer-provided via `renderBody({ columns, gridTemplateColumns })`. The pill header is
 * meant to be pinned by the consumer via `headerStyle={{ position: 'sticky', top: 0, ... }}`
 * inside an outer scroll container the consumer owns; this component does not provide its
 * own scroll viewport. See `TransactionListTable.jsx`, `Transactions.jsx`, and `Rules.jsx`
 * for canonical consumers.
 *
 * Auto-scroll-during-column-drag: holding a header pill near the left/right edge of the
 * nearest horizontally-scrollable ancestor scrolls that ancestor via requestAnimationFrame,
 * so a column can be dragged past the viewport edge when the table is wider than its container.
 */

import { useEffect, useMemo, useRef } from 'react'
import PillTableHeader from './PillTableHeader.jsx'

// The committed grid template is published as this CSS variable on the table root; the header and
// body consume it via var(), so a live resize can update widths by mutating the variable on the DOM
// without re-rendering any React rows. See the resize handler.
const GRID_TEMPLATE_VAR = 'var(--pgt-grid)'

function buildGridTemplate(columns) {
  // Numeric widths are pixel values (the common case for resizable data tables); string
  // widths are passed through so callers can use `1fr`, `minmax(...)`, percentages, etc.
  // when they want a column to flex with available width.
  return columns.map(column => (
    typeof column.width === 'number' ? `${column.width}px` : column.width
  )).join(' ')
}

function getColumnFixedWidth(column) {
  const width = Number(column.width)
  return Number.isFinite(width) ? width : 0
}

function getHeaderPillCellPadding(index, count) {
  if (index === 0) return '0 5px 0 0'
  if (index === count - 1) return '0 0 0 5px'
  return '0 5px'
}

function findHorizontalScrollParent(node) {
  let current = node?.parentElement || null
  while (current) {
    const style = window.getComputedStyle(current)
    const overflowX = style.overflowX || ''
    const canScroll = (overflowX === 'auto' || overflowX === 'scroll') && current.scrollWidth > current.clientWidth
    if (canScroll) return current
    current = current.parentElement
  }
  return null
}

export default function PillGridTable({
  columns = [],
  onColumnsChange,
  sortState = null,
  onSort,
  headerStyle,
  contentStyle,
  edgeWidth = 8,
  renderBody,
}) {
  const rootRef = useRef(null)
  const dragColKey = useRef(null)
  const resizeState = useRef(null)
  const dragScrollFrame = useRef(null)
  const dragScrollState = useRef({ direction: 0, container: null })
  // A column resize is a continuous gesture. The committed widths are published as the `--pgt-grid`
  // CSS variable on the root; the header and body consume it via `var(--pgt-grid)`. During a drag we
  // mutate that variable (and the min-width) DIRECTLY on the DOM per frame — no React state, so
  // nothing re-renders (not this table's body, not the preference consumers the controlled `columns`
  // flows through); the browser just re-lays-out via CSS. We commit once via onColumnsChange on
  // mouse-up. `liveResizeRef` holds the latest widths for that commit.
  const liveResizeRef = useRef(null)

  const gridTemplateColumns = useMemo(
    () => buildGridTemplate(columns),
    [columns],
  )
  const contentMinWidth = useMemo(
    () => columns.reduce((sum, column) => sum + getColumnFixedWidth(column), 0),
    [columns],
  )

  useEffect(() => {
    if (typeof onColumnsChange !== 'function') return undefined

    function onMove(event) {
      if (!resizeState.current) return
      const { key, startX, startColumns } = resizeState.current
      const nextColumns = startColumns.map(column => ({ ...column }))
      const currentIndex = nextColumns.findIndex(column => column.key === key)
      if (currentIndex === -1) return
      const currentColumn = nextColumns[currentIndex]
      const currentMinWidth = Number(currentColumn.minWidth || 44)
      const currentStartWidth = Number(currentColumn.width || 0)
      const movement = event.clientX - startX
      const nextCurrentWidth = Math.max(currentMinWidth, Math.min(640, currentStartWidth + movement))
      currentColumn.width = nextCurrentWidth

      // Live preview via the DOM only — no React state, so nothing re-renders during the drag.
      liveResizeRef.current = nextColumns
      if (rootRef.current) {
        rootRef.current.style.setProperty('--pgt-grid', buildGridTemplate(nextColumns))
        rootRef.current.style.minWidth = `${nextColumns.reduce((sum, column) => sum + getColumnFixedWidth(column), 0)}px`
      }
    }

    function onUp() {
      if (!resizeState.current) return
      resizeState.current = null
      const committed = liveResizeRef.current
      liveResizeRef.current = null
      // Persist exactly once, at the end of the gesture; the re-render republishes the var/min-width.
      if (committed) onColumnsChange(committed)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [onColumnsChange])

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key !== 'Escape') return

      if (resizeState.current && typeof onColumnsChange === 'function') {
        // Cancel the in-progress resize: drop the live buffer and revert the DOM var to committed
        // (no commit happened, so nothing re-renders to republish it).
        resizeState.current = null
        liveResizeRef.current = null
        if (rootRef.current) {
          rootRef.current.style.setProperty('--pgt-grid', gridTemplateColumns)
          rootRef.current.style.minWidth = `${contentMinWidth}px`
        }
        stopDragScroll()
        event.preventDefault()
        return
      }

      if (dragColKey.current) {
        dragColKey.current = null
        stopDragScroll()
        event.preventDefault()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onColumnsChange, gridTemplateColumns, contentMinWidth])

  useEffect(() => () => {
    if (dragScrollFrame.current) window.cancelAnimationFrame(dragScrollFrame.current)
  }, [])

  function stopDragScroll() {
    dragScrollState.current = { direction: 0, container: null }
    if (dragScrollFrame.current) {
      window.cancelAnimationFrame(dragScrollFrame.current)
      dragScrollFrame.current = null
    }
  }

  function startDragScroll(container, direction) {
    if (!container || !direction) {
      stopDragScroll()
      return
    }
    dragScrollState.current = { direction, container }
    if (dragScrollFrame.current) return
    const step = () => {
      const { direction: activeDirection, container: activeContainer } = dragScrollState.current
      if (!activeContainer || !activeDirection) {
        dragScrollFrame.current = null
        return
      }
      const previousLeft = activeContainer.scrollLeft
      activeContainer.scrollLeft += activeDirection * 18
      if (activeContainer.scrollLeft === previousLeft) {
        stopDragScroll()
        return
      }
      dragScrollFrame.current = window.requestAnimationFrame(step)
    }
    dragScrollFrame.current = window.requestAnimationFrame(step)
  }

  function handleRootDragOver(event) {
    if (!dragColKey.current) return
    const scrollContainer = findHorizontalScrollParent(rootRef.current)
    if (!scrollContainer) return
    const rect = scrollContainer.getBoundingClientRect()
    const threshold = 36
    const maxScrollLeft = scrollContainer.scrollWidth - scrollContainer.clientWidth
    if (event.clientX <= rect.left + threshold && scrollContainer.scrollLeft > 0) {
      startDragScroll(scrollContainer, -1)
      return
    }
    if (event.clientX >= rect.right - threshold && scrollContainer.scrollLeft < maxScrollLeft - 1) {
      startDragScroll(scrollContainer, 1)
      return
    }
    stopDragScroll()
  }

  function handleHeaderDrop(targetKey, dropAfter) {
    const sourceKey = dragColKey.current
    dragColKey.current = null
    stopDragScroll()
    if (!sourceKey || sourceKey === targetKey || typeof onColumnsChange !== 'function') return
    const sourceIndex = columns.findIndex(column => column.key === sourceKey)
    const targetIndex = columns.findIndex(column => column.key === targetKey)
    if (sourceIndex === -1 || targetIndex === -1) return
    const nextColumns = [...columns]
    const [movedColumn] = nextColumns.splice(sourceIndex, 1)
    // Recompute the target's index after removing the source (removal shifts everything to its
    // right), then insert on the side the cursor was released on. Doing both makes the drop
    // land where it's aimed in either direction.
    const adjustedTargetIndex = nextColumns.findIndex(column => column.key === targetKey)
    nextColumns.splice(adjustedTargetIndex + (dropAfter ? 1 : 0), 0, movedColumn)
    onColumnsChange(nextColumns)
  }

  function startResize(event, columnKey) {
    if (typeof onColumnsChange !== 'function') return
    event.preventDefault()
    event.stopPropagation()
    resizeState.current = {
      key: columnKey,
      startX: event.clientX,
      startColumns: columns.map(column => ({ ...column })),
    }
  }

  const headerColumns = useMemo(
    () => columns.map((column, index) => ({
      ...column,
      sortable: typeof onSort === 'function' ? column.sortable !== false : false,
      draggable: typeof onColumnsChange === 'function' ? column.draggable !== false : false,
      resizable: typeof onColumnsChange === 'function' ? column.resizable !== false : false,
      cellPadding: column.cellPadding ?? getHeaderPillCellPadding(index, columns.length),
      contentPadding: column.contentPadding ?? '0 9px',
    })),
    [columns, onColumnsChange, onSort],
  )

  return (
    <div
      style={{
        minWidth: contentMinWidth,
        '--pgt-grid': gridTemplateColumns,
        ...contentStyle,
      }}
      ref={rootRef}
      onDragOverCapture={handleRootDragOver}
      onDragLeave={stopDragScroll}
      onDropCapture={stopDragScroll}
    >
      <PillTableHeader
        columns={headerColumns}
        gridTemplateColumns={GRID_TEMPLATE_VAR}
        sortState={sortState}
        onSort={onSort}
        onDropColumn={typeof onColumnsChange === 'function' ? handleHeaderDrop : undefined}
        onDragStartColumn={typeof onColumnsChange === 'function' ? (key => { dragColKey.current = key }) : undefined}
        onDragEndColumn={typeof onColumnsChange === 'function' ? (() => { dragColKey.current = null; stopDragScroll() }) : undefined}
        onStartResize={typeof onColumnsChange === 'function' ? startResize : undefined}
        edgeWidth={edgeWidth}
        style={headerStyle}
      />
      {renderBody?.({ columns, gridTemplateColumns: GRID_TEMPLATE_VAR })}
    </div>
  )
}
