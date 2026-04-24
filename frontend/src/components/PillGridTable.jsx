// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useMemo, useRef } from 'react'
import PillTableHeader from './PillTableHeader.jsx'

function buildGridTemplate(columns) {
  return columns.map(column => `${column.width}px`).join(' ')
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
  fillHeight = false,
  renderBody,
}) {
  const rootRef = useRef(null)
  const dragColKey = useRef(null)
  const resizeState = useRef(null)
  const dragScrollFrame = useRef(null)
  const dragScrollState = useRef({ direction: 0, container: null })

  const gridTemplateColumns = useMemo(
    () => buildGridTemplate(columns),
    [columns],
  )
  const contentMinWidth = useMemo(
    () => columns.reduce((sum, column) => sum + Number(column.width || 0), 0),
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

      onColumnsChange(nextColumns)
    }

    function onUp() {
      resizeState.current = null
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
        const { startColumns } = resizeState.current
        resizeState.current = null
        stopDragScroll()
        onColumnsChange(startColumns.map(column => ({ ...column })))
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
  }, [onColumnsChange])

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

  function handleHeaderDrop(targetKey) {
    const sourceKey = dragColKey.current
    dragColKey.current = null
    stopDragScroll()
    if (!sourceKey || sourceKey === targetKey || typeof onColumnsChange !== 'function') return
    const nextColumns = [...columns]
    const sourceIndex = nextColumns.findIndex(column => column.key === sourceKey)
    const targetIndex = nextColumns.findIndex(column => column.key === targetKey)
    if (sourceIndex === -1 || targetIndex === -1) return
    const [movedColumn] = nextColumns.splice(sourceIndex, 1)
    nextColumns.splice(targetIndex, 0, movedColumn)
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
        ...(fillHeight ? { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, height: '100%' } : null),
        ...contentStyle,
      }}
      ref={rootRef}
      onDragOverCapture={handleRootDragOver}
      onDragLeave={stopDragScroll}
      onDropCapture={stopDragScroll}
    >
      <PillTableHeader
        columns={headerColumns}
        gridTemplateColumns={gridTemplateColumns}
        sortState={sortState}
        onSort={onSort}
        onDropColumn={typeof onColumnsChange === 'function' ? handleHeaderDrop : undefined}
        onDragStartColumn={typeof onColumnsChange === 'function' ? (key => { dragColKey.current = key }) : undefined}
        onDragEndColumn={typeof onColumnsChange === 'function' ? (() => { dragColKey.current = null; stopDragScroll() }) : undefined}
        onStartResize={typeof onColumnsChange === 'function' ? startResize : undefined}
        edgeWidth={edgeWidth}
        style={headerStyle}
      />
      {renderBody?.({ columns, gridTemplateColumns })}
    </div>
  )
}
