// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pill table headers keep sort, move, and resize on one shared surface.
// Resize belongs to the column on the left of a divider so dragging it changes
// that column's width without silently reallocating space into its neighbor.
export default function PillTableHeader({
  columns,
  gridTemplateColumns,
  sortState = null,
  onSort,
  onStartReorder,
  onStartResize,
  edgeWidth = 8,
  style,
  overlay = null,
}) {
  // The resize grip lives on a column's right edge. Shared by the plain and custom-render branches so a
  // custom-rendered column (e.g. one with an action button in its header) is resizable like any other.
  function resizeHandle(col) {
    if (col.resizable === false || typeof onStartResize !== 'function') return null
    return (
      <button
        type="button"
        onMouseDown={event => onStartResize(event, col.key)}
        title={col.resizeRightTitle || `Drag to resize ${col.label || col.key}`}
        style={{
          position: 'absolute',
          right: 0,
          top: 0,
          bottom: 0,
          width: edgeWidth,
          border: 'none',
          background: 'transparent',
          padding: 0,
          cursor: 'col-resize',
        }}
      />
    )
  }

  return (
    <div style={{
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
              <button
                type="button"
                onClick={() => { if (canSort) onSort(col.key) }}
                onContextMenu={event => col.onContextMenu?.(event, col)}
                onMouseDown={canReorder ? event => onStartReorder(event, col.key) : undefined}
                title={col.title}
                style={{
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
                  borderRadius: 999,
                  border: `1px solid ${pillBorder}`,
                  width: 'fit-content',
                }}
              >
                {col.align === 'end' ? (
                  <>
                    {sortGlyph ? (
                      <span style={{ fontSize: 10, opacity: 0.95, color: 'var(--accent2)', flexShrink: 0 }}>
                        {sortGlyph}
                      </span>
                    ) : null}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {col.label}
                    </span>
                  </>
                ) : (
                  <>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {col.label}
                    </span>
                    {sortGlyph ? (
                      <span style={{ fontSize: 10, opacity: 0.95, color: 'var(--accent2)', flexShrink: 0 }}>
                        {sortGlyph}
                      </span>
                    ) : null}
                  </>
                )}
              </button>
            </div>
            {canResize ? resizeHandle(col) : null}
          </div>
        )
      })}
      {overlay}
    </div>
  )
}
