// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

/*
 * Account, category, and transaction detail drawers all share the same interaction model here:
 * open docked, optionally become a remembered floating panel, show a windowed month chart, and lazy-load
 * the selected month's transactions. The leaf components only swap in their own header and query logic.
 */

import { useEffect, useRef, useState } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, LabelList,
} from 'recharts'
import { formatCurrency, monthLabel } from '../lib/utils.js'
import { getFloatingPanelSurfaceStyle, getFloatingPanelHeaderBackground } from './ui.jsx'

export const DETAIL_PAGE_SIZE = 100
export const DETAIL_PANEL_WIDTH = 'min(820px, calc(100vw - 32px))'
export const DETAIL_LIST_MAX_HEIGHT = 312
export const DETAIL_MONTH_SECTION_MIN_HEIGHT = 420
export const DETAIL_WINDOW_MONTHS = 18
export const DETAIL_TOP_PADDING = '120px'
export const DETAIL_MAX_VISIBLE_ROWS = 7
export const DETAIL_STACK_OFFSET = 28
const DETAIL_SECTION_OVERHEAD = 108
export function getDetailMonthSectionHeight(trend = []) {
  const maxCount = trend.reduce((max, row) => Math.max(max, Number(row?.count) || 0), 0)
  const visibleRows = Math.max(1, Math.min(DETAIL_MAX_VISIBLE_ROWS, maxCount || 1))
  // Reserve enough height for the busiest month we might show before the list
  // needs its own scrollbar, while keeping a minimum stable footprint.
  return Math.max(
    DETAIL_MONTH_SECTION_MIN_HEIGHT - DETAIL_LIST_MAX_HEIGHT,
    DETAIL_SECTION_OVERHEAD + Math.round((DETAIL_LIST_MAX_HEIGHT / DETAIL_MAX_VISIBLE_ROWS) * visibleRows)
  )
}

function clampPanelPosition(pos, rect = null) {
  if (!pos) return null
  const maxX = Math.max(0, window.innerWidth - (rect?.width || 200))
  const maxY = Math.max(0, window.innerHeight - (rect?.height || 60))
  return {
    x: Math.max(0, Math.min(maxX, pos.x)),
    y: Math.max(0, Math.min(maxY, pos.y)),
  }
}

function getDefaultPanelPosition(rect, stackIndex = 0) {
  const topPadding = parseInt(DETAIL_TOP_PADDING, 10) || 120
  const centeredX = Math.max(16, Math.round((window.innerWidth - rect.width) / 2))
  const centeredY = Math.max(topPadding, Math.round((window.innerHeight - rect.height) / 2))
  return {
    x: centeredX + (stackIndex * DETAIL_STACK_OFFSET),
    y: centeredY + (stackIndex * DETAIL_STACK_OFFSET),
  }
}

function applyPanelStackOffset(pos, stackIndex = 0) {
  if (!pos) return null
  return {
    x: pos.x + (stackIndex * DETAIL_STACK_OFFSET),
    y: pos.y + (stackIndex * DETAIL_STACK_OFFSET),
  }
}

export function useDetailPanelChrome(onClose, options = {}) {
  const {
    forceFloating = false,
    stackIndex = 0,
    initialPosition = null,
  } = options
  const [pos, setPos] = useState(null)
  const [dragging, setDragging] = useState(false)
  const panelRef = useRef(null)
  const dragOffset = useRef({ x: 0, y: 0 })
  const hasDragged = useRef(false)

  function onDragStart(e) {
    if (!panelRef.current) return
    const rect = panelRef.current.getBoundingClientRect()
    dragOffset.current = {
      x: e.clientX - (pos ? pos.x : rect.left),
      y: e.clientY - (pos ? pos.y : rect.top),
    }
    hasDragged.current = false
    setDragging(true)
    e.preventDefault()
  }

  useEffect(() => {
    if (!panelRef.current || pos) return
    const rect = panelRef.current.getBoundingClientRect()
    if (forceFloating && initialPosition) {
      setPos(clampPanelPosition(applyPanelStackOffset(initialPosition, stackIndex), rect))
      return
    }
    if (!forceFloating) return
    setPos(clampPanelPosition(getDefaultPanelPosition(rect, stackIndex), rect))
  }, [forceFloating, initialPosition, pos, stackIndex])

  useEffect(() => {
    if (!dragging) return
    function onMove(e) {
      if (!hasDragged.current) {
        if (!pos && panelRef.current) {
          const rect = panelRef.current.getBoundingClientRect()
          setPos({ x: rect.left, y: rect.top })
          dragOffset.current = {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          }
        }
        hasDragged.current = true
      }
      const rect = panelRef.current?.getBoundingClientRect()
      const next = clampPanelPosition({
        x: e.clientX - dragOffset.current.x,
        y: e.clientY - dragOffset.current.y,
      }, rect)
      setPos(prev => (prev ? next : prev))
    }
    function onUp() { setDragging(false) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragging, pos])

  useEffect(() => {
    function handleResize() {
      setPos(prev => clampPanelPosition(prev, panelRef.current?.getBoundingClientRect()))
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  return { pos, dragging, panelRef, onDragStart }
}

export function usePagedMonthTransactions({ selectedMonth, loadPage }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const listRef = useRef(null)

  useEffect(() => {
    if (!selectedMonth) return
    let cancelled = false
    setLoading(true)
    setOffset(0)
    loadPage(selectedMonth, 0, DETAIL_PAGE_SIZE).then(result => {
      if (cancelled) return
      const nextRows = result?.transactions || []
      const total = result?.total || 0
      setRows(nextRows)
      setOffset(nextRows.length)
      setHasMore(nextRows.length < total)
      setLoading(false)
    }).catch(() => {
      if (cancelled) return
      setRows([])
      setOffset(0)
      setHasMore(false)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [selectedMonth, loadPage])

  useEffect(() => {
    if (!selectedMonth || !listRef.current) return
    function onScroll() {
      const el = listRef.current
      if (!el || loading || loadingMore || !hasMore) return
      if (el.scrollHeight - el.scrollTop - el.clientHeight > 240) return
      setLoadingMore(true)
      loadPage(selectedMonth, offset, DETAIL_PAGE_SIZE).then(result => {
        const nextRows = result?.transactions || []
        const total = result?.total || 0
        setRows(prev => [...prev, ...nextRows])
        setOffset(prev => prev + nextRows.length)
        setHasMore(offset + nextRows.length < total)
      }).finally(() => setLoadingMore(false))
    }
    const el = listRef.current
    el.addEventListener('scroll', onScroll)
    onScroll()
    return () => el.removeEventListener('scroll', onScroll)
  }, [selectedMonth, offset, hasMore, loading, loadingMore, loadPage])

  return {
    rows,
    setRows,
    loading,
    loadingMore,
    listRef,
  }
}

export function usePagedTransactions({ activeKey, loadPage }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const listRef = useRef(null)

  useEffect(() => {
    if (!activeKey) {
      setRows([])
      setOffset(0)
      setHasMore(false)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setOffset(0)
    loadPage(0, DETAIL_PAGE_SIZE).then(result => {
      if (cancelled) return
      const nextRows = result?.transactions || []
      const total = result?.total || 0
      setRows(nextRows)
      setOffset(nextRows.length)
      setHasMore(nextRows.length < total)
      setLoading(false)
    }).catch(() => {
      if (cancelled) return
      setRows([])
      setOffset(0)
      setHasMore(false)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [activeKey, loadPage])

  useEffect(() => {
    if (!activeKey || !listRef.current) return
    function onScroll() {
      const el = listRef.current
      if (!el || loading || loadingMore || !hasMore) return
      if (el.scrollHeight - el.scrollTop - el.clientHeight > 240) return
      setLoadingMore(true)
      loadPage(offset, DETAIL_PAGE_SIZE).then(result => {
        const nextRows = result?.transactions || []
        const total = result?.total || 0
        setRows(prev => [...prev, ...nextRows])
        setOffset(prev => prev + nextRows.length)
        setHasMore(offset + nextRows.length < total)
      }).finally(() => setLoadingMore(false))
    }
    const el = listRef.current
    el.addEventListener('scroll', onScroll)
    onScroll()
    return () => el.removeEventListener('scroll', onScroll)
  }, [activeKey, offset, hasMore, loading, loadingMore, loadPage])

  return {
    rows,
    setRows,
    loading,
    loadingMore,
    listRef,
  }
}

function YearTick({ x, y, width, payload, data }) {
  if (!payload?.value) return null
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const monthName = months[parseInt(payload.value.slice(5), 10) - 1] ?? ''
  return (
    <g>
      <text x={x} y={y + 12} textAnchor="middle" fill="var(--muted)" fontSize={10}>
        {monthName}
      </text>
    </g>
  )
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 8, padding: '8px 12px', fontSize: 13,
    }}>
      <div style={{ color: 'var(--muted)', marginBottom: 2 }}>{monthLabel(label)}</div>
      <div style={{ fontWeight: 600 }}>{formatCurrency(payload[0].value)}</div>
      <div style={{ fontSize: 11, color: 'var(--muted)' }}>{payload[0].payload.count} txns</div>
    </div>
  )
}

export function DetailTrendChart({ trend, selectedMonth, onSelectMonth }) {
  const [windowEnd, setWindowEnd] = useState(null)

  useEffect(() => {
    // Fresh trend data should reopen on its newest segment rather than staying stranded in an old scrolled window.
    setWindowEnd(null)
  }, [trend])

  if (!trend.length) {
    return null
  }

  const endIdx = windowEnd ? trend.findIndex(d => d.month === windowEnd) : trend.length - 1
  const safeEnd = endIdx === -1 ? trend.length - 1 : endIdx
  const startIdx = Math.max(0, safeEnd - DETAIL_WINDOW_MONTHS + 1)
  const visible = trend.slice(startIdx, safeEnd + 1)
  const canPrev = startIdx > 0
  const canNext = safeEnd < trend.length - 1
  const needsNav = trend.length > DETAIL_WINDOW_MONTHS
  const yearBreaks = visible.map((entry, index) => index > 0 && entry.month.slice(0, 4) !== visible[index - 1].month.slice(0, 4))
  const yearSegments = []
  for (const entry of visible) {
    const year = entry.month.slice(0, 4)
    const existing = yearSegments.find(segment => segment.year === year)
    if (existing) {
      existing.count += 1
    } else {
      yearSegments.push({ year, count: 1 })
    }
  }

  function shiftWindow(dir) {
    const newEnd = Math.max(
      DETAIL_WINDOW_MONTHS - 1,
      Math.min(trend.length - 1, safeEnd + dir * DETAIL_WINDOW_MONTHS)
    )
    setWindowEnd(trend[newEnd].month)
  }

  return (
    <div style={{ position: 'relative' }}>
      {needsNav && (
        <>
          <button
            onClick={() => shiftWindow(-1)}
            disabled={!canPrev}
            title="Show older months"
            style={{
              position: 'absolute', left: -8, top: 0, bottom: 0, zIndex: 10,
              width: 28, border: 'none', borderRadius: '6px 0 0 6px',
              background: canPrev ? 'color-mix(in srgb, var(--accent) 15%, var(--surface2))' : 'transparent',
              color: canPrev ? 'var(--accent2)' : 'var(--border)',
              cursor: canPrev ? 'pointer' : 'default',
              fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >‹</button>
          <button
            onClick={() => shiftWindow(1)}
            disabled={!canNext}
            title="Show newer months"
            style={{
              position: 'absolute', right: -8, top: 0, bottom: 0, zIndex: 10,
              width: 28, border: 'none', borderRadius: '0 6px 6px 0',
              background: canNext ? 'color-mix(in srgb, var(--accent) 15%, var(--surface2))' : 'transparent',
              color: canNext ? 'var(--accent2)' : 'var(--border)',
              cursor: canNext ? 'pointer' : 'default',
              fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >›</button>
        </>
      )}

      <div style={{ height: 160, margin: needsNav ? '0 20px' : '0', position: 'relative' }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={visible} margin={{ top: 28, right: 8, bottom: 8, left: 8 }} style={{ cursor: 'pointer' }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey="month" tick={<YearTick data={visible} />} tickLine={false} axisLine={false} height={30} interval={0} minTickGap={0} />
            <YAxis
              tickFormatter={v => `$${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v}`}
              tick={{ fill: 'var(--muted)', fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              width={44}
            />
            <Tooltip content={<CustomTooltip />} cursor={{ fill: 'var(--surface2)', opacity: 0.5 }} />
            <Bar dataKey="total" radius={[3, 3, 0, 0]} maxBarSize={42}>
              {visible.map((entry, i) => (
                <Cell
                  key={i}
                  fill={entry.month === selectedMonth ? 'var(--accent2)' : 'var(--accent)'}
                  opacity={selectedMonth && entry.month !== selectedMonth ? 0.4 : 1}
                  onClick={() => onSelectMonth?.(entry.month)}
                />
              ))}
              <LabelList
                dataKey="count"
                position="insideTop"
                style={{ fill: 'rgba(255,255,255,0.75)', fontSize: 9, fontWeight: 600 }}
                formatter={v => (v > 1 ? v : '')}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        <div
          style={{
            position: 'absolute',
            top: '50%',
            right: 8,
            bottom: -8,
            left: 52,
            display: 'grid',
            gridTemplateColumns: `repeat(${visible.length}, minmax(0, 1fr))`,
            pointerEvents: 'none',
          }}
        >
          {visible.map((entry, index) => (
            <div
              key={`${entry.month}-divider`}
              style={{
                borderLeft: yearBreaks[index] ? '1px solid rgba(239, 68, 68, 0.45)' : 'none',
                height: '100%',
              }}
            />
          ))}
        </div>
      </div>

      <div style={{ marginTop: -10 }}>
        <div style={{
          margin: needsNav ? '0 20px' : '0',
          padding: '0 8px 0 52px',
          display: 'grid',
          gridTemplateColumns: `repeat(${visible.length}, minmax(0, 1fr))`,
          fontSize: 10,
          color: 'var(--muted)',
        }}>
          {yearSegments.map(segment => (
            <div
              key={segment.year}
              style={{
                gridColumn: `span ${segment.count}`,
                textAlign: 'center',
                fontWeight: 600,
                letterSpacing: '0.04em',
              }}
            >
              {segment.year}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function DetailPanelShell({ pos, dragging, panelRef, onDragStart, onClose, header, children, isTopmost = true }) {
  const panelSurfaceStyle = getFloatingPanelSurfaceStyle({
    active: !pos || isTopmost,
    radius: 12,
  })
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 400,
      background: pos ? 'transparent' : 'rgba(0,0,0,0.5)',
      display: pos ? 'block' : 'flex',
      alignItems: 'flex-start', justifyContent: 'center',
      padding: pos ? 0 : `${DETAIL_TOP_PADDING} 16px 16px`,
      pointerEvents: pos ? 'none' : 'auto',
      overflowY: 'auto',
    }}>
      <div
        ref={panelRef}
        style={{
          position: pos ? 'fixed' : 'relative',
          left: pos ? pos.x : undefined,
          top: pos ? pos.y : undefined,
          width: DETAIL_PANEL_WIDTH,
          maxWidth: DETAIL_PANEL_WIDTH,
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          pointerEvents: 'auto',
          userSelect: dragging ? 'none' : 'auto',
          zIndex: 401,
          ...panelSurfaceStyle,
        }}
      >
        <div
          onMouseDown={onDragStart}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '16px 24px', borderBottom: '1px solid var(--border)', flexShrink: 0,
            background: getFloatingPanelHeaderBackground(isTopmost),
            cursor: dragging ? 'grabbing' : 'grab',
          }}
        >
          <div style={{ flex: 1 }}>{header}</div>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: 'none', color: 'var(--muted)',
              cursor: 'pointer', fontSize: 22, padding: '0 4px', lineHeight: 1,
            }}
          >×</button>
        </div>

        <div style={{ flex: 1, overflow: 'hidden', padding: '20px 24px', display: 'flex', flexDirection: 'column' }}>
          {children}
        </div>
      </div>
    </div>
  )
}
