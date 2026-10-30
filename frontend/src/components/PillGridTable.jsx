// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Header-only table: owns the sortable/draggable/resizable column row, but the body is
 * consumer-provided via `renderBody({ columns, gridTemplateColumns })`. The pill header is
 * meant to be pinned by the consumer via `headerStyle={{ position: 'sticky', top: 0, ... }}`
 * inside an outer scroll container the consumer owns; this component does not provide its
 * own scroll viewport. See `TransactionListTable.jsx`, `Transactions.jsx`, and `Rules.jsx`
 * for canonical consumers.
 *
 * Column reorder is a pointer drag (lib/pointerDrag.js) with no drop zones: the target is worked out
 * from the header cells under the pointer. The only scrolling a column move wants is horizontal:
 * holding a pill near the left/right edge of the nearest horizontally-scrollable ancestor scrolls that
 * ancestor via requestAnimationFrame, so a column can be dragged past the viewport edge when the table
 * is wider than its container.
 */

import { useEffect, useMemo, useRef } from 'react'
import PillTableHeader from './PillTableHeader.jsx'
import { dividerIsDraggable, moveDivider } from '../lib/columnDividers.js'
import { preventPressDefaults, startPointerDrag } from '../lib/pointerDrag.js'
import { cssRect, toCssPx } from '../lib/displaySize.js'

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

function reorderColumns(columns, sourceKey, targetKey, dropAfter) {
  const sourceIndex = columns.findIndex(column => column.key === sourceKey)
  if (sourceIndex === -1 || !columns.some(column => column.key === targetKey)) return null
  const nextColumns = [...columns]
  const [movedColumn] = nextColumns.splice(sourceIndex, 1)
  // Recompute the target's index after removing the source (removal shifts everything to its
  // right), then insert on the side the cursor is on. Doing both makes the drop land where it's
  // aimed in either direction.
  const adjustedTargetIndex = nextColumns.findIndex(column => column.key === targetKey)
  if (adjustedTargetIndex === -1) return null
  nextColumns.splice(adjustedTargetIndex + (dropAfter ? 1 : 0), 0, movedColumn)
  const unchanged = nextColumns.every((column, index) => column.key === columns[index].key)
  return unchanged ? null : nextColumns
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
  const dropMarkerRef = useRef(null)
  const columnsRef = useRef(columns)
  columnsRef.current = columns
  // The column move in progress: { key, clientX, clientY, pill, nextColumns }. Like resize, it never
  // touches React state, so moving a column re-renders nothing until the drop.
  const reorderState = useRef(null)
  const resizeState = useRef(null)
  const dragScrollFrame = useRef(null)
  const dragScrollState = useRef({ direction: 0, container: null })
  // A column resize is a continuous gesture. The committed widths are published as the `--pgt-grid`
  // CSS variable on the root; the header and body consume it via `var(--pgt-grid)`. During a drag we
  // mutate that variable (and the min-width) DIRECTLY on the DOM per frame — no React state, so
  // nothing re-renders (not this table's body, not the preference consumers the controlled `columns`
  // flows through); the browser just re-lays-out via CSS. We commit once via onColumnsChange on
  // release. `liveResizeRef` holds the latest widths for that commit.
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
      const nextColumns = moveDivider(startColumns, key, toCssPx(event.clientX - startX))

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

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
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
      // The columns slide under a held pointer, so the drop position moves with them.
      updateReorderTarget()
      dragScrollFrame.current = window.requestAnimationFrame(step)
    }
    dragScrollFrame.current = window.requestAnimationFrame(step)
  }

  function updateEdgeScroll(clientX, clientY) {
    const scrollContainer = findHorizontalScrollParent(rootRef.current)
    if (!scrollContainer) return
    const rect = scrollContainer.getBoundingClientRect()
    if (clientY < rect.top || clientY > rect.bottom) {
      stopDragScroll()
      return
    }
    const threshold = 36
    const maxScrollLeft = scrollContainer.scrollWidth - scrollContainer.clientWidth
    if (clientX <= rect.left + threshold && scrollContainer.scrollLeft > 0) {
      startDragScroll(scrollContainer, -1)
      return
    }
    if (clientX >= rect.right - threshold && scrollContainer.scrollLeft < maxScrollLeft - 1) {
      startDragScroll(scrollContainer, 1)
      return
    }
    stopDragScroll()
  }

  function startReorder(event, columnKey) {
    if (typeof onColumnsChange !== 'function') return
    // Stops the press from starting a text selection; the click that sorts still fires.
    preventPressDefaults(event)
    const state = {
      key: columnKey,
      clientX: event.clientX,
      clientY: event.clientY,
      pill: event.currentTarget,
      nextColumns: null,
    }
    startPointerDrag(event, {
      onStart: () => {
        reorderState.current = state
        state.pill.style.opacity = '0.5'
        return columnKey
      },
      onMove: point => {
        state.clientX = point.clientX
        state.clientY = point.clientY
        updateReorderTarget()
        updateEdgeScroll(point.clientX, point.clientY)
      },
      onEnd: ({ cancelled }) => {
        if (reorderState.current === state) reorderState.current = null
        stopDragScroll()
        state.pill.style.opacity = ''
        if (dropMarkerRef.current) dropMarkerRef.current.style.display = 'none'
        if (!cancelled && state.nextColumns) onColumnsChange(state.nextColumns)
      },
      preview: reorderPreview,
    })
  }

  // The translucent copy of the pill that follows the pointer.
  function reorderPreview(pill) {
    const rect = cssRect(pill)
    const ghost = pill.cloneNode(true)
    ghost.removeAttribute('title')
    Object.assign(ghost.style, {
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      margin: '0',
      boxSizing: 'border-box',
      letterSpacing: window.getComputedStyle(pill).letterSpacing,
      opacity: '0.75',
      boxShadow: '0 4px 12px rgba(0, 0, 0, 0.18)',
    })
    return { element: ghost }
  }

  // The drop target is the header cell under the pointer; which half of it the pointer is over decides
  // whether the column lands before or after it, so aiming "in the gap" between two columns resolves the
  // same way in either direction. Off the header row there is no target, and releasing there cancels.
  //
  // The marker sits midway between the two neighbouring pills rather than on the cell boundary: pills
  // are narrower than their cells, so a boundary can sit flush against one pill and read as part of it.
  function updateReorderTarget() {
    const state = reorderState.current
    const marker = dropMarkerRef.current
    if (!state || !marker) return
    const header = marker.parentElement
    const headerRect = header.getBoundingClientRect()
    let target = null
    if (state.clientY >= headerRect.top && state.clientY <= headerRect.bottom) {
      const cells = [...header.querySelectorAll('[data-pill-column]')]
      const pillRect = cell => cell.querySelector('button').getBoundingClientRect()
      const index = cells.findIndex(cell => {
        const rect = cell.getBoundingClientRect()
        return state.clientX >= rect.left && state.clientX <= rect.right
      })
      if (index !== -1) {
        const rect = cells[index].getBoundingClientRect()
        const dropAfter = state.clientX > rect.left + rect.width / 2
        const before = dropAfter ? cells[index] : cells[index - 1]
        const after = dropAfter ? cells[index + 1] : cells[index]
        const gapLeft = before ? pillRect(before).right : null
        const gapRight = after ? pillRect(after).left : null
        const x = gapLeft !== null && gapRight !== null
          ? (gapLeft + gapRight) / 2
          : gapLeft !== null ? gapLeft + 5 : gapRight - 5
        target = { key: cells[index].dataset.pillColumn, dropAfter, x }
      }
    }
    state.nextColumns = target ? reorderColumns(columnsRef.current, state.key, target.key, target.dropAfter) : null
    if (state.nextColumns) {
      marker.style.display = 'block'
      marker.style.left = `${toCssPx(target.x - headerRect.left) - 1.5}px`
    } else {
      marker.style.display = 'none'
    }
  }

  function startResize(event, columnKey) {
    if (typeof onColumnsChange !== 'function') return
    preventPressDefaults(event)
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
      resizable: typeof onColumnsChange === 'function' && dividerIsDraggable(columns, index),
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
    >
      <PillTableHeader
        columns={headerColumns}
        gridTemplateColumns={GRID_TEMPLATE_VAR}
        sortState={sortState}
        onSort={onSort}
        onStartReorder={typeof onColumnsChange === 'function' ? startReorder : undefined}
        onStartResize={typeof onColumnsChange === 'function' ? startResize : undefined}
        edgeWidth={edgeWidth}
        style={headerStyle}
        overlay={typeof onColumnsChange === 'function' ? (
          <div
            ref={dropMarkerRef}
            style={{
              display: 'none',
              position: 'absolute',
              top: 2,
              bottom: 2,
              width: 3,
              borderRadius: 2,
              background: 'var(--accent)',
              boxShadow: '0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent)',
              pointerEvents: 'none',
            }}
          />
        ) : null}
      />
      {renderBody?.({ columns, gridTemplateColumns: GRID_TEMPLATE_VAR })}
    </div>
  )
}
