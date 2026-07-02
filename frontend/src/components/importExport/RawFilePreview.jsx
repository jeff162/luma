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
      } else {
        setSize({
          w: Math.max(320, startRef.current.w + dx),
          h: Math.max(160, startRef.current.h + dy),
        })
      }
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

  function startResize(e) {
    if (embedded) return
    startRef.current = { w: size.w, h: size.h, mx: e.clientX, my: e.clientY }
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
            {!embedded ? (headerRowIndex >= 0 ? ' · drag to move · resize ↘' : 'drag to move · resize ↘') : ''}
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
        borderRadius: '0 0 10px 10px',
        background: embedded ? 'color-mix(in srgb, var(--bg) 82%, var(--surface2))' : 'transparent',
      }}>
        {rawLines.map((line, i) => {
          const actualLineIndex = lineNumberOffset + i
          const isHeader = actualLineIndex === headerRowIndex
          const isData = actualLineIndex > headerRowIndex && actualLineIndex <= headerRowIndex + 4
          const dimmed = !isHeader && !isData && actualLineIndex > headerRowIndex
          return (
            <div key={i} style={{
              display: 'flex', alignItems: 'baseline',
              background: isHeader
                ? 'color-mix(in srgb, var(--accent) 18%, var(--surface2))'
                : embedded
                  ? 'color-mix(in srgb, var(--bg) 88%, transparent)'
                  : 'transparent',
              borderBottom: `1px solid ${embedded ? 'color-mix(in srgb, var(--border) 76%, var(--bg))' : 'var(--border)'}`,
              opacity: dimmed ? (embedded ? 0.62 : 0.25) : 1,
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
              {isHeader && <span style={{ marginLeft: 'auto', padding: '3px 8px', flexShrink: 0, fontSize: 10, color: 'var(--accent2)', fontFamily: 'sans-serif', fontWeight: 600 }}>← header</span>}
            </div>
          )
        })}
      </div>

      {!embedded ? (
        <div
          onMouseDown={startResize}
          style={{
            position: 'absolute', right: 0, bottom: 0,
            width: 18, height: 18, cursor: 'nwse-resize',
            display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end',
            padding: '3px', color: 'var(--muted)', fontSize: 12, lineHeight: 1,
            borderRadius: '0 0 10px 0',
          }}
        >⌟</div>
      ) : null}
    </div>
  )
}
