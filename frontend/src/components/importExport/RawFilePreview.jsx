// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Monospace viewer for the raw CSV lines around the detected header row, used to
// let the user inspect skipped leading rows, suspected footer/non-transaction
// tails, and validation errors. Two modes: a draggable/resizable floating panel
// (default) and an `embedded` inline variant that drops the drag/resize chrome
// and renders against a darker surface for in-flow review steps. Self-contained:
// owns its own position/size/drag state.

import { useEffect, useRef, useState } from 'react'

export function RawFilePreview({
  rawLines,
  headerRowIndex,
  onClose,
  lineNumberOffset = 0,
  title = 'Raw file',
  note = null,
  embedded = false,
  embeddedHeight = 320,
  onLoadMore = null,
  canLoadMore = false,
  loadingMore = false,
}) {
  const [pos, setPos] = useState({ x: Math.max(0, window.innerWidth - 560), y: 80 })
  const [size, setSize] = useState({ w: 520, h: 320 })
  const [dragState, setDragState] = useState(null)
  const startRef = useRef({})

  useEffect(() => {
    if (embedded) return
    if (!dragState) return
    function onMove(e) {
      const dx = e.clientX - startRef.current.mx
      const dy = e.clientY - startRef.current.my
      if (dragState === 'move') {
        setPos({
          x: Math.max(0, Math.min(window.innerWidth - 200, startRef.current.x + dx)),
          y: Math.max(0, Math.min(window.innerHeight - 60, startRef.current.y + dy)),
        })
        return
      }
      // Resize from any edge/corner: an east/south edge grows width/height directly, while a
      // west/north edge grows toward the pointer by moving the panel origin and inversely sizing —
      // so the opposite edge stays put and the user never has to reposition the window first.
      const MIN_W = 320
      const MIN_H = 160
      const { dir, x: sx, y: sy, w: sw, h: sh } = startRef.current
      let x = sx
      let y = sy
      let w = sw
      let h = sh
      if (dir.includes('e')) w = Math.max(MIN_W, sw + dx)
      if (dir.includes('s')) h = Math.max(MIN_H, sh + dy)
      if (dir.includes('w')) {
        w = Math.max(MIN_W, sw - dx)
        x = sx + (sw - w)
        if (x < 0) { w += x; x = 0 }
      }
      if (dir.includes('n')) {
        h = Math.max(MIN_H, sh - dy)
        y = sy + (sh - h)
        if (y < 0) { h += y; y = 0 }
      }
      setPos({ x, y })
      setSize({ w, h })
    }
    function onUp() { setDragState(null) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [dragState, embedded])

  function startMove(e) {
    if (embedded) return
    startRef.current = { x: pos.x, y: pos.y, mx: e.clientX, my: e.clientY }
    setDragState('move')
    e.preventDefault()
  }

  function startResize(e, dir) {
    if (embedded) return
    startRef.current = { dir, x: pos.x, y: pos.y, w: size.w, h: size.h, mx: e.clientX, my: e.clientY }
    setDragState('resize')
    e.preventDefault()
    e.stopPropagation()
  }

  if (!rawLines?.length) return null

  const containerBackground = embedded
    ? 'color-mix(in srgb, var(--surface2) 85%, var(--bg))'
    : 'var(--surface)'
  const containerBorder = embedded
    ? '1px solid color-mix(in srgb, var(--accent2) 18%, var(--border))'
    : '1px solid var(--border)'
  const containerShadow = embedded
    ? 'inset 0 1px 0 rgba(255,255,255,0.05), 0 14px 36px rgba(15, 23, 42, 0.22)'
    : '0 8px 32px rgba(0,0,0,0.35)'
  const headerBackground = embedded
    ? 'linear-gradient(180deg, color-mix(in srgb, var(--surface2) 62%, var(--accent) 8%), color-mix(in srgb, var(--surface2) 88%, var(--bg)))'
    : 'var(--surface2)'
  const noteBackground = embedded
    ? 'color-mix(in srgb, var(--warning) 18%, var(--surface2))'
    : 'color-mix(in srgb, var(--warning) 10%, var(--surface2))'
  const noteBorderColor = embedded
    ? 'color-mix(in srgb, var(--warning) 28%, var(--border))'
    : 'var(--border)'

  return (
    <div style={{
      position: embedded ? 'relative' : 'fixed',
      left: embedded ? undefined : pos.x,
      top: embedded ? undefined : pos.y,
      zIndex: embedded ? 'auto' : 1105,
      width: embedded ? '100%' : size.w,
      background: containerBackground,
      border: containerBorder, borderRadius: 10,
      boxShadow: containerShadow,
      display: 'flex', flexDirection: 'column',
      userSelect: dragState ? 'none' : 'auto',
      overflow: 'hidden',
    }}>
      <div onMouseDown={startMove} style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '8px 12px', cursor: embedded ? 'default' : 'grab',
        borderBottom: '1px solid var(--border)',
        background: headerBackground, borderRadius: '10px 10px 0 0', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {!embedded ? <span style={{ fontSize: 12, color: 'var(--muted)' }}>⠿</span> : null}
          <span style={{ fontSize: 13, fontWeight: 600 }}>{title}</span>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            {headerRowIndex >= 0 ? `header on line ${headerRowIndex + 1}` : ''}
          </span>
        </div>
        {onClose ? (
          <button
            onMouseDown={e => e.stopPropagation()}
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 2px' }}
          >×</button>
        ) : null}
      </div>

      {note && (
        <div style={{
          padding: '10px 12px',
          fontSize: 12,
          color: 'var(--warning)',
          background: noteBackground,
          borderBottom: `1px solid ${noteBorderColor}`,
          fontWeight: 500,
        }}>
          {note}
        </div>
      )}
      <div style={{
        fontFamily: 'monospace', fontSize: 12,
        overflowY: 'auto', overflowX: 'auto',
        height: embedded ? embeddedHeight : size.h,
        borderRadius: onLoadMore ? 0 : '0 0 10px 10px',
        background: embedded ? 'color-mix(in srgb, var(--bg) 82%, var(--surface2))' : 'transparent',
      }}>
        {rawLines.map((line, i) => {
          const actualLineIndex = lineNumberOffset + i
          const isHeader = actualLineIndex === headerRowIndex
          // Rows above the detected header are pre-header/skip lines — given a subtle muted cue (not a
          // dim) so the "header region" reads clearly without hurting readability of the data below.
          const isPreHeader = headerRowIndex >= 0 && actualLineIndex < headerRowIndex
          const rowBackground = isHeader
            ? 'color-mix(in srgb, var(--accent) 18%, var(--surface2))'
            : isPreHeader
              ? 'color-mix(in srgb, var(--muted) 12%, var(--surface2))'
              : embedded
                ? 'color-mix(in srgb, var(--bg) 88%, transparent)'
                : 'transparent'
          // Every row reserves the 3px left rail so text stays aligned; only header/pre-header color it.
          const railColor = isHeader
            ? 'var(--accent)'
            : isPreHeader
              ? 'color-mix(in srgb, var(--muted) 45%, transparent)'
              : 'transparent'
          return (
            <div key={i} style={{
              display: 'flex', alignItems: 'baseline',
              background: rowBackground,
              borderLeft: `3px solid ${railColor}`,
              borderBottom: `1px solid ${embedded ? 'color-mix(in srgb, var(--border) 76%, var(--bg))' : 'var(--border)'}`,
            }}>
              <span style={{
                minWidth: 42,
                padding: '4px 7px',
                textAlign: 'right',
                flexShrink: 0,
                fontSize: 10,
                color: embedded ? 'color-mix(in srgb, var(--muted) 62%, var(--text))' : 'var(--muted)',
                borderRight: `1px solid ${embedded ? 'color-mix(in srgb, var(--border) 76%, var(--bg))' : 'var(--border)'}`,
                background: embedded ? 'color-mix(in srgb, var(--bg) 76%, var(--surface2))' : 'var(--surface2)',
                fontWeight: isHeader ? 600 : 400,
              }}>{actualLineIndex + 1}</span>
              <span style={{
                padding: '4px 10px',
                whiteSpace: 'pre',
                color: 'var(--text)',
                fontWeight: isHeader ? 600 : 400,
              }}>{line || ' '}</span>
              {isHeader ? (
                <span style={{ marginLeft: 'auto', padding: '3px 8px', flexShrink: 0, fontSize: 10, color: 'var(--accent2)', fontFamily: 'sans-serif', fontWeight: 600 }}>← header</span>
              ) : isPreHeader ? (
                <span style={{ marginLeft: 'auto', padding: '3px 8px', flexShrink: 0, fontSize: 10, color: 'var(--muted)', fontFamily: 'sans-serif' }}>before header</span>
              ) : null}
            </div>
          )
        })}
      </div>

      {onLoadMore ? (
        <div style={{
          padding: '6px 10px', flexShrink: 0,
          borderTop: '1px solid var(--border)', background: headerBackground,
          display: 'flex', justifyContent: 'center', borderRadius: '0 0 10px 10px',
        }}>
          {canLoadMore ? (
            <button
              onMouseDown={e => e.stopPropagation()}
              onClick={onLoadMore}
              disabled={loadingMore}
              style={{
                background: 'none', border: '1px solid var(--border)', borderRadius: 6,
                color: 'var(--text)', cursor: loadingMore ? 'default' : 'pointer',
                fontSize: 12, padding: '4px 12px',
              }}
            >{loadingMore ? 'Loading…' : 'Load more'}</button>
          ) : (
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>Entire file loaded</span>
          )}
        </div>
      ) : null}

      {!embedded ? RESIZE_HANDLES.map(handle => (
        <div
          key={handle.dir}
          onMouseDown={e => startResize(e, handle.dir)}
          style={{ position: 'absolute', ...handle.style, zIndex: handle.corner ? 2 : 1 }}
        />
      )) : null}
    </div>
  )
}

// Eight resize grips — four edges plus four corners — so the panel can be sized from any side without
// first repositioning it. Edges are thin strips; corners are small squares layered above the edges.
const EDGE = 6
const CORNER = 14
const RESIZE_HANDLES = [
  { dir: 'n', style: { top: 0, left: 0, right: 0, height: EDGE, cursor: 'ns-resize' } },
  { dir: 's', style: { bottom: 0, left: 0, right: 0, height: EDGE, cursor: 'ns-resize' } },
  { dir: 'w', style: { top: 0, bottom: 0, left: 0, width: EDGE, cursor: 'ew-resize' } },
  { dir: 'e', style: { top: 0, bottom: 0, right: 0, width: EDGE, cursor: 'ew-resize' } },
  { dir: 'nw', corner: true, style: { top: 0, left: 0, width: CORNER, height: CORNER, cursor: 'nwse-resize' } },
  { dir: 'ne', corner: true, style: { top: 0, right: 0, width: CORNER, height: CORNER, cursor: 'nesw-resize' } },
  { dir: 'sw', corner: true, style: { bottom: 0, left: 0, width: CORNER, height: CORNER, cursor: 'nesw-resize' } },
  { dir: 'se', corner: true, style: { bottom: 0, right: 0, width: CORNER, height: CORNER, cursor: 'nwse-resize' } },
]
