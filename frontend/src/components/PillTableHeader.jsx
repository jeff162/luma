// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useLayoutEffect, useRef, useState } from 'react'
import { useCoarsePointer } from '../lib/deviceLayout.js'
import { DRAG_SOURCE_STYLE } from '../lib/pointerDrag.js'
import { TOUCH_GRIP_WIDTH, TouchResizeMark } from './ui.jsx'
import { ActionMenu } from './ActionMenu.jsx'

// Pill table headers keep sort, move, and resize on one shared surface. A column's `resizable` puts a
// grip on its right edge; dragging it moves that one divider (`lib/columnDividers.js`).
//
// A column whose cell shows several things (a date, a name and an amount) lists them as `sortFields`
// ([{ key, label }]). Its pill names the one it sorts by, `sortState.field` while it is the sorted column
// and the first otherwise. Its pill is split, as a `SplitButton` is: the body flips the direction (so each
// field stays two clicks) and moves the column, and a full-height caret segment at its end opens a menu
// of the fields, picked through `onSortField(columnKey, fieldKey)`. The caret is a visible control rather
// than a right-click, which a touch screen has no way to make, and it is a segment rather than a glyph
// inside the body because a glyph is too small to aim at.
//
// A column's `badge` is a node pinned to its pill's top-right corner — a control that acts on the column
// as a whole (the Accounts Tags column's edit pencil) rather than on sorting.
export default function PillTableHeader({
  columns,
  gridTemplateColumns,
  sortState = null,
  onSort,
  onSortField,
  onStartReorder,
  onStartResize,
  edgeWidth = 8,
  style,
  overlay = null,
}) {
  const coarsePointer = useCoarsePointer()
  const headerRef = useRef(null)
  const [fieldMenu, setFieldMenu] = useState(null)   // { col, anchor } while a column's ▾ menu is open
  // On a touch screen each grip straddles its divider, taking half its width from each neighbouring
  // column, and marks the divider where it meets the header's bottom border. Hosts set their own header
  // padding, so the mark measures how far below the grip that border sits.
  const [borderOffset, setBorderOffset] = useState(0)
  useLayoutEffect(() => {
    if (!coarsePointer || !headerRef.current) return
    setBorderOffset(parseFloat(window.getComputedStyle(headerRef.current).paddingBottom) || 0)
  }, [coarsePointer, style])

  // The resize grip lives on a column's right edge. Shared by the plain and custom-render branches so a
  // custom-rendered column (e.g. one with an action button in its header) is resizable like any other.
  function resizeHandle(col) {
    if (col.resizable === false || typeof onStartResize !== 'function') return null
    return (
      <button
        type="button"
        onPointerDown={event => onStartResize(event, col.key)}
        title={col.resizeRightTitle || `Drag to resize ${col.label || col.key}`}
        style={{
          position: 'absolute',
          right: coarsePointer ? -TOUCH_GRIP_WIDTH / 2 : 0,
          top: 0,
          bottom: 0,
          width: coarsePointer ? TOUCH_GRIP_WIDTH : edgeWidth,
          zIndex: 1,
          border: 'none',
          background: 'transparent',
          padding: 0,
          cursor: 'col-resize',
          touchAction: 'none',
        }}
      >
        <TouchResizeMark top={`calc(100% + ${borderOffset + 0.5}px)`} />
      </button>
    )
  }

  return (
    <div ref={headerRef} style={{
      // Positions `overlay` (the reorder drop marker); a sticky `style` overrides it and positions it too.
      position: 'relative',
      display: 'grid',
      gridTemplateColumns,
      padding: '8px 14px',
      fontSize: 11,
      fontWeight: 600,
      color: 'var(--muted)',
      borderBottom: '1px solid var(--border)',
      letterSpacing: '0.01em',
      ...style,
    }}>
      {columns.map(col => {
        if (col.kind === 'spacer') {
          return (
            <div
              key={col.key}
              style={{
                minWidth: 0,
                padding: col.cellPadding ?? '0 6px',
                height: col.height ?? 20,
              }}
            />
          )
        }

        if (typeof col.render === 'function') {
          return (
            <div
              key={col.key}
              style={{
                minWidth: 0,
                padding: col.cellPadding ?? '0 6px',
                height: col.height ?? 20,
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
                justifyContent: col.align === 'end'
                  ? 'flex-end'
                  : col.align === 'center'
                    ? 'center'
                    : 'flex-start',
              }}
            >
              {col.render()}
              {resizeHandle(col)}
            </div>
          )
        }

        const isSorted = !!sortState && sortState.key === col.key
        const sortGlyph = isSorted ? (sortState.dir === 'asc' ? '↑' : '↓') : null
        const canSort = col.sortable !== false && typeof onSort === 'function'
        const fields = canSort && typeof onSortField === 'function' && col.sortFields?.length ? col.sortFields : null
        const field = fields
          ? (fields.find(f => isSorted && f.key === sortState.field) || fields[0])
          : null
        const glyphNode = sortGlyph ? (
          <span style={{ fontSize: 10, opacity: 0.95, color: 'var(--accent2)', flexShrink: 0 }}>
            {sortGlyph}
          </span>
        ) : null
        const canResize = col.resizable !== false && typeof onStartResize === 'function'
        const canReorder = col.draggable !== false && typeof onStartReorder === 'function'
        const alignment = col.align === 'end'
          ? 'flex-end'
          : col.align === 'center'
            ? 'center'
            : 'flex-start'
        const leadingInset = col.leadingInset ?? 0
        const trailingInset = col.trailingInset ?? 0
        const maxPillWidth = '100%'
        const pillBorder = isSorted
          ? 'color-mix(in srgb, var(--accent) 52%, var(--border))'
          : 'var(--border)'

        return (
          <div
            key={col.key}
            data-pill-column={col.key}
            style={{
              minWidth: 0,
              padding: col.cellPadding ?? '0 6px',
              position: 'relative',
              height: col.height ?? 20,
            }}
          >
            <div style={{
              position: 'absolute',
              left: leadingInset,
              right: trailingInset,
              top: 0,
              bottom: 0,
              display: 'flex',
              alignItems: 'stretch',
              justifyContent: alignment,
              minWidth: 0,
            }}>
              <span style={{ display: 'inline-flex', alignItems: 'stretch', minWidth: 0, maxWidth: maxPillWidth, position: col.badge ? 'relative' : undefined }}>
              <button
                type="button"
                onClick={() => { setFieldMenu(null); if (canSort) onSort(col.key) }}
                onContextMenu={event => col.onContextMenu?.(event, col)}
                onPointerDown={canReorder ? event => onStartReorder(event, col.key) : undefined}
                title={col.title}
                style={{
                  ...(canReorder ? DRAG_SOURCE_STYLE : null),
                  background: isSorted
                    ? 'color-mix(in srgb, var(--accent) 15%, var(--surface2))'
                    : 'var(--surface2)',
                  margin: 0,
                  minWidth: 0,
                  maxWidth: maxPillWidth,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: alignment,
                  gap: 6,
                  padding: col.contentPadding ?? '0 9px',
                  color: isSorted ? 'var(--accent)' : 'var(--muted)',
                  cursor: canReorder ? 'grab' : (canSort || col.onContextMenu ? 'pointer' : 'default'),
                  font: 'inherit',
                  letterSpacing: 'inherit',
                  fontSize: col.fontSize ?? 11,
                  fontWeight: 600,
                  borderRadius: fields ? '999px 0 0 999px' : 999,
                  border: `1px solid ${pillBorder}`,
                  width: 'fit-content',
                }}
              >
                {field ? (
                  // A split pill's arrow goes before the field it applies to, clear of the caret segment.
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {col.label} · {glyphNode ? <>{glyphNode} </> : null}{field.label}
                  </span>
                ) : col.align === 'end' ? (
                  <>
                    {glyphNode}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {col.label}
                    </span>
                  </>
                ) : (
                  <>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {col.label}
                    </span>
                    {glyphNode}
                  </>
                )}
              </button>
              {fields ? (
                <button
                  type="button"
                  aria-label={`Sort ${col.label} by…`}
                  aria-haspopup="menu"
                  aria-expanded={fieldMenu?.col.key === col.key}
                  title={`Sort ${col.label} by…`}
                  // Anchored under the whole split pill; a second press on the caret closes it.
                  onClick={event => {
                    const anchor = event.currentTarget.parentElement
                    setFieldMenu(open => (open?.col.key === col.key ? null : { col, anchor }))
                  }}
                  // A press here is aimed at the menu, so it never starts a column move.
                  onPointerDown={event => event.stopPropagation()}
                  style={{
                    flexShrink: 0,
                    // The two segments share their middle border, so the caret steps back over the body's edge.
                    marginLeft: -1,
                    minWidth: coarsePointer ? 32 : 22,
                    padding: 0,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    border: `1px solid ${pillBorder}`,
                    borderRadius: '0 999px 999px 0',
                    background: isSorted
                      ? 'color-mix(in srgb, var(--accent) 15%, var(--surface2))'
                      : 'var(--surface2)',
                    color: isSorted ? 'var(--accent)' : 'var(--muted)',
                    font: 'inherit',
                    fontSize: 10,
                    cursor: 'pointer',
                  }}
                >
                  ▾
                </button>
              ) : null}
              {col.badge ? (
                <span style={{ position: 'absolute', top: -6, right: -10, display: 'inline-flex' }}>
                  {col.badge}
                </span>
              ) : null}
              </span>
            </div>
            {canResize ? resizeHandle(col) : null}
          </div>
        )
      })}
      {overlay}
      {fieldMenu ? (
        <ActionMenu
          anchorElement={fieldMenu.anchor}
          align="start"
          minWidth={140}
          label={`Sort ${fieldMenu.col.label} by`}
          items={fieldMenu.col.sortFields.map(f => ({
            key: f.key,
            label: f.label,
            checked: !!sortState && sortState.key === fieldMenu.col.key
              ? f.key === (sortState.field || fieldMenu.col.sortFields[0].key)
              : false,
            onClick: () => onSortField(fieldMenu.col.key, f.key),
          }))}
          onClose={() => setFieldMenu(null)}
        />
      ) : null}
    </div>
  )
}
