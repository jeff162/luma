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
 * Column reorder tracks the mouse directly rather than using HTML5 drag-and-drop: during a native
 * drag the browser auto-scrolls whatever scrollable box the pointer nears — the report's rows, or the
 * page under a floating panel — and no drag event can switch that off. The only scrolling a column
 * move wants is horizontal: holding a pill near the left/right edge of the nearest
 * horizontally-scrollable ancestor scrolls that ancestor via requestAnimationFrame, so a column can
 * be dragged past the viewport edge when the table is wider than its container.
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

// Past this many pixels of movement a press on a pill is a column move; short of it, a click (sort).
const REORDER_THRESHOLD = 4

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
  // The in-progress column move: { key, startX, startY, active, clientX, clientY, pill, ghost,
  // nextColumns, cancel, removeListeners }. Like resize, it never touches React state, so moving a column re-renders nothing until the
  // drop. Its window listeners live only for the one gesture; `cancel` removes them.
  const reorderState = useRef(null)
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
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onColumnsChange, gridTemplateColumns, contentMinWidth])

  useEffect(() => () => {
    if (dragScrollFrame.current) window.cancelAnimationFrame(dragScrollFrame.current)
    reorderState.current?.cancel()
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
    if (typeof onColumnsChange !== 'function' || event.button !== 0) return
    // Stops the press from starting a text selection; the click that sorts still fires.
    event.preventDefault()
    const state = {
      key: columnKey,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      clientX: event.clientX,
      clientY: event.clientY,
      pill: event.currentTarget,
      ghost: null,
      nextColumns: null,
      cancel: () => endReorder(state),
    }
    reorderState.current = state

    function onMove(moveEvent) {
      state.clientX = moveEvent.clientX
      state.clientY = moveEvent.clientY
      if (!state.active) {
        if (Math.hypot(moveEvent.clientX - state.startX, moveEvent.clientY - state.startY) < REORDER_THRESHOLD) return
        state.active = true
        state.ghost = createReorderGhost(state.pill)
        state.pill.style.opacity = '0.5'
        document.body.style.cursor = 'grabbing'
      }
      state.ghost.style.transform = `translate(${moveEvent.clientX - state.startX}px, ${moveEvent.clientY - state.startY}px)`
      updateReorderTarget()
      updateEdgeScroll(moveEvent.clientX, moveEvent.clientY)
    }

    function onUp() {
      endReorder(state)
      if (!state.active) return
      // Releasing over the pill it started on would otherwise read as a click and sort the column.
      const swallowClick = clickEvent => clickEvent.stopPropagation()
      window.addEventListener('click', swallowClick, { capture: true, once: true })
      window.setTimeout(() => window.removeEventListener('click', swallowClick, { capture: true }), 0)
      if (state.nextColumns) onColumnsChange(state.nextColumns)
    }

    function onKeyDown(keyEvent) {
      if (keyEvent.key !== 'Escape') return
      keyEvent.preventDefault()
      endReorder(state)
    }

    state.removeListeners = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('keydown', onKeyDown)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('keydown', onKeyDown)
  }

  // The translucent copy of the pill that follows the pointer, standing in for the browser's drag image.
  // It hangs off <body> because the table often sits in a floating panel, and a `position: fixed` element
  // inside a transformed ancestor is placed relative to that ancestor.
  function createReorderGhost(pill) {
    const rect = pill.getBoundingClientRect()
    const ghost = pill.cloneNode(true)
    ghost.removeAttribute('title')
    Object.assign(ghost.style, {
      position: 'fixed',
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      margin: '0',
      boxSizing: 'border-box',
      letterSpacing: window.getComputedStyle(pill).letterSpacing,
      opacity: '0.75',
      boxShadow: '0 4px 12px rgba(0, 0, 0, 0.18)',
      pointerEvents: 'none',
      zIndex: '10000',
    })
    document.body.appendChild(ghost)
    return ghost
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
    if (!state?.active || !marker) return
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
      marker.style.left = `${target.x - headerRect.left - 1.5}px`
    } else {
      marker.style.display = 'none'
    }
  }

  // Ends the gesture and undoes its visual state; applying the drop, if any, is the caller's job.
  function endReorder(state) {
    state.removeListeners()
    if (reorderState.current === state) reorderState.current = null
    stopDragScroll()
    if (!state.active) return
    state.ghost.remove()
    state.pill.style.opacity = ''
    document.body.style.cursor = ''
    if (dropMarkerRef.current) dropMarkerRef.current.style.display = 'none'
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
