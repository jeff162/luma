// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- DetailPanelShell + chart components + paging hooks + sizing helpers live together as the detail-panel kit */

/*
 * Shared chrome for every floating detail panel (AccountDetail, CategoryDetail, MonthDetail,
 * TagDetail, TransactionDetail, ImportBatchDetail, the duplicate-detection dialog). Three
 * non-obvious design points:
 *
 *   - `useDetailPanelChrome` does drag via direct-DOM writes (requestAnimationFrame-batched)
 *     and only commits the final position to React state on mouseup. This skips React
 *     reconciliation per mousemove — crucial for dialogs hosting large tables. Trade-off
 *     documented at the drag effect itself.
 *
 *   - `DetailPanelShell` claims a slot in `PanelStackContext` so z-index ordering and click-
 *     to-focus work across panels rendered in different parts of the tree (e.g., the App-
 *     level duplicate dialog and route-mounted batch/account panels coordinate via one stack).
 *
 *   - `usePagedTransactions` backs lists that infinite-scroll as the user nears the bottom.
 *     `activeKey` resets pagination — consumers include filters (date range, search) in the
 *     key so changing a filter starts over at page 1.
 */

import { useEffect, useRef, useState } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, LabelList,
} from 'recharts'
import { monthLabel } from '../lib/utils.js'
import { formatSignedAxisTick, formatSignedMoneyAmount } from '../lib/moneyDisplay.js'
import { getFloatingPanelSurfaceStyle, getFloatingPanelHeaderBackground } from './ui.jsx'
import { usePanelStackSlot } from '../contexts/PanelStackContext.jsx'
import { isEditableTarget } from '../lib/uiInteractions.js'

export const DETAIL_PAGE_SIZE = 100
// Default panel width fits the full transaction-table column set (date, merchant,
// category, account, amount) plus chrome and a vertical scrollbar gutter without
// clipping the rightmost column on a typical desktop window.
export const DETAIL_PANEL_WIDTH = 'min(960px, calc(100vw - 32px))'
export const DETAIL_PANEL_MIN_WIDTH = 480
export const DETAIL_PANEL_MIN_HEIGHT = 320
export const DETAIL_LIST_MAX_HEIGHT = 312
export const DETAIL_MONTH_SECTION_MIN_HEIGHT = 420
export const DETAIL_WINDOW_MONTHS = 18
export const DETAIL_TOP_PADDING = '120px'
export const DETAIL_MAX_VISIBLE_ROWS = 7
export const DETAIL_STACK_OFFSET = 28
export const DETAIL_FLOATING_TOP_GUTTER = 72
export const DETAIL_FLOATING_EDGE_GUTTER = 24
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
  const gutter = DETAIL_FLOATING_EDGE_GUTTER
  const topGutter = DETAIL_FLOATING_TOP_GUTTER
  const maxX = Math.max(gutter, window.innerWidth - (rect?.width || 200) - gutter)
  const maxY = Math.max(topGutter, window.innerHeight - (rect?.height || 60) - gutter)
  return {
    x: Math.max(gutter, Math.min(maxX, pos.x)),
    y: Math.max(topGutter, Math.min(maxY, pos.y)),
  }
}

function getDefaultPanelPosition(rect, stackIndex = 0) {
  const gutter = DETAIL_FLOATING_EDGE_GUTTER
  const topGutter = DETAIL_FLOATING_TOP_GUTTER
  const centeredX = Math.max(gutter, Math.round((window.innerWidth - rect.width) / 2))
  const centeredY = Math.max(topGutter, Math.round((window.innerHeight - rect.height) / 2))
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
    initialSize = null,
  } = options
  // When the caller passes a saved position (e.g., restoring a minimized dialog), seed `pos`
  // synchronously so the first paint is already at the correct location. Otherwise the panel
  // would render once at the docked/centered fallback (with backdrop) and then snap to the
  // saved position on the next frame — visible as a flash. We clamp against initialSize (the
  // caller's declared panel size) so a saved position that's now off-screen — because the
  // window was resized smaller — still lands within the viewport. The post-mount window-resize
  // effect / ResizeObserver will re-clamp using the real measured rect; the initial clamp here
  // is the safety net that guarantees enough of the panel is on-screen to grab.
  const [pos, setPos] = useState(() => (
    forceFloating && initialPosition
      ? clampPanelPosition(applyPanelStackOffset(initialPosition, stackIndex), initialSize)
      : null
  ))
  // initialSize lets a caller open the panel at a constrained explicit size so the user has
  // room to drag it around. Without this the panel falls back to a max-height that nearly fills
  // the viewport, which leaves zero vertical drag range (clampPanelPosition locks Y to topGutter).
  const [size, setSize] = useState(initialSize)
  const [dragging, setDragging] = useState(false)
  const [resizing, setResizing] = useState(false)
  const panelRef = useRef(null)
  const dragOffset = useRef({ x: 0, y: 0 })
  const resizeStart = useRef({ x: 0, y: 0, width: 0, height: 0 })
  const hasDragged = useRef(false)

  function clampSize(next) {
    if (!next) return null
    const maxWidth = Math.max(DETAIL_PANEL_MIN_WIDTH, window.innerWidth - DETAIL_FLOATING_EDGE_GUTTER * 2)
    const maxHeight = Math.max(DETAIL_PANEL_MIN_HEIGHT, window.innerHeight - DETAIL_FLOATING_TOP_GUTTER - DETAIL_FLOATING_EDGE_GUTTER)
    return {
      width: Math.max(DETAIL_PANEL_MIN_WIDTH, Math.min(maxWidth, next.width)),
      height: Math.max(DETAIL_PANEL_MIN_HEIGHT, Math.min(maxHeight, next.height)),
    }
  }

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

  // Resize converts the panel into floating mode (matching drag) so size and
  // position stay coherent: once the user has explicitly sized a panel, it
  // should stick at that geometry regardless of where it was originally docked.
  function onResizeStart(e) {
    if (!panelRef.current) return
    const rect = panelRef.current.getBoundingClientRect()
    resizeStart.current = { x: e.clientX, y: e.clientY, width: rect.width, height: rect.height }
    if (!size) setSize({ width: rect.width, height: rect.height })
    if (!pos) setPos({ x: rect.left, y: rect.top })
    setResizing(true)
    e.preventDefault()
    e.stopPropagation()
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
    // Direct-DOM drag: writing `left`/`top` via panelRef on each mousemove (batched through
    // requestAnimationFrame) skips React reconciliation entirely while the user is dragging.
    // For dialogs with large bodies (the duplicate-detection report renders hundreds of table
    // rows), per-mousemove `setState`-driven re-renders were noticeably sluggish — every frame
    // walked the whole subtree even though the only thing changing was the panel position.
    // We commit the final position to React state on mouseup so subsequent renders read the
    // up-to-date pos. Trade-off: an outside re-render in mid-drag would briefly snap the panel
    // back to the last committed pos until the next mousemove. No call site currently triggers
    // such renders during drag, and the next mousemove corrects the position immediately.
    let pendingFrame = null
    let lastEvent = null
    let lastWritten = null
    function applyFrame() {
      pendingFrame = null
      if (!lastEvent || !panelRef.current) return
      const rect = panelRef.current.getBoundingClientRect()
      const next = clampPanelPosition({
        x: lastEvent.clientX - dragOffset.current.x,
        y: lastEvent.clientY - dragOffset.current.y,
      }, rect)
      panelRef.current.style.left = `${next.x}px`
      panelRef.current.style.top  = `${next.y}px`
      lastWritten = next
    }
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
      lastEvent = { clientX: e.clientX, clientY: e.clientY }
      if (!pendingFrame) pendingFrame = requestAnimationFrame(applyFrame)
    }
    function onUp() {
      if (pendingFrame) {
        cancelAnimationFrame(pendingFrame)
        pendingFrame = null
        applyFrame()
      }
      if (lastWritten) setPos(lastWritten)
      setDragging(false)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      if (pendingFrame) cancelAnimationFrame(pendingFrame)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragging, pos])

  useEffect(() => {
    if (!resizing) return
    function onMove(e) {
      const { x, y, width, height } = resizeStart.current
      const next = clampSize({
        width: width + (e.clientX - x),
        height: height + (e.clientY - y),
      })
      setSize(next)
    }
    function onUp() { setResizing(false) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [resizing])

  useEffect(() => {
    function handleResize() {
      setPos(prev => clampPanelPosition(prev, panelRef.current?.getBoundingClientRect()))
      setSize(prev => clampSize(prev))
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    if (typeof ResizeObserver !== 'function') return undefined
    const element = panelRef.current
    if (!element) return undefined

    const observer = new ResizeObserver(() => {
      setPos(prev => clampPanelPosition(prev, element.getBoundingClientRect()))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [panelRef])

  return { pos, size, dragging, resizing, panelRef, onDragStart, onResizeStart }
}

// Defensive append for paged lists: drop any incoming row whose id is already present so a stray
// double-fetch can never render duplicate React keys. The in-flight ref guard should prevent that in
// the first place; this keeps the rendered list correct even if one slips through.
function mergeUniqueById(prev, next) {
  if (!next || next.length === 0) return prev
  const seen = new Set(prev.map(row => row.id))
  const added = next.filter(row => !seen.has(row.id))
  return added.length ? [...prev, ...added] : prev
}

export function usePagedMonthTransactions({ selectedMonth, loadPage }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const listRef = useRef(null)
  // Synchronous re-entry guard — `loadingMore` state flips async, so two scroll events in one tick can
  // both fetch the same offset and append a page twice (duplicate React keys). See usePagedTransactions.
  const loadingMoreRef = useRef(false)

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
      if (!el || loadingMoreRef.current || loading || !hasMore) return
      if (el.scrollHeight - el.scrollTop - el.clientHeight > 240) return
      loadingMoreRef.current = true
      setLoadingMore(true)
      loadPage(selectedMonth, offset, DETAIL_PAGE_SIZE).then(result => {
        const nextRows = result?.transactions || []
        const total = result?.total || 0
        setRows(prev => mergeUniqueById(prev, nextRows))
        setOffset(prev => prev + nextRows.length)
        setHasMore(offset + nextRows.length < total)
      }).finally(() => { loadingMoreRef.current = false; setLoadingMore(false) })
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
  // Synchronous re-entry guard (see comment above): blocks a same-offset double-fetch that would append
  // a page twice and produce duplicate React keys while scrolling.
  const loadingMoreRef = useRef(false)

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
      if (!el || loadingMoreRef.current || loading || !hasMore) return
      if (el.scrollHeight - el.scrollTop - el.clientHeight > 240) return
      loadingMoreRef.current = true
      setLoadingMore(true)
      loadPage(offset, DETAIL_PAGE_SIZE).then(result => {
        const nextRows = result?.transactions || []
        const total = result?.total || 0
        setRows(prev => mergeUniqueById(prev, nextRows))
        setOffset(prev => prev + nextRows.length)
        setHasMore(offset + nextRows.length < total)
      }).finally(() => { loadingMoreRef.current = false; setLoadingMore(false) })
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

function YearTick({ x, y, payload }) {
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
      <div style={{ fontWeight: 600 }}>{formatSignedMoneyAmount(payload[0].value)}</div>
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
              tickFormatter={formatSignedAxisTick}
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

export function DetailPanelShell({
  pos,
  size,
  dragging,
  resizing = false,
  panelRef,
  onDragStart,
  onResizeStart,
  onClose,
  header,
  children,
  isTopmost = true,
}) {
  const stack = usePanelStackSlot()
  const effectiveIsTopmost = stack.isTopmost && isTopmost

  // Escape dismisses the topmost panel, matching the rest of the app's dismissable layers. Gated so
  // it only fires when nothing more specific owns the Escape: only the topmost panel responds, we
  // bail when focus is in a text field (the inline editor cancels its own edit instead — this is what
  // keeps a half-finished note/name edit from nuking the whole panel), and we bail when a modal
  // dialog is open above the panel (the dialog owns Escape). We deliberately do not require focus to
  // be inside the panel: opening a panel by clicking leaves focus on the trigger in the page behind,
  // so a focus-inside rule would make Escape-right-after-open silently do nothing.
  useEffect(() => {
    if (!effectiveIsTopmost) return undefined
    function onKeyDown(event) {
      if (event.key !== 'Escape') return
      if (isEditableTarget(document.activeElement)) return
      if (document.querySelector('[data-modal-overlay]')) return
      event.preventDefault()
      onClose?.()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [effectiveIsTopmost, onClose])

  const panelSurfaceStyle = getFloatingPanelSurfaceStyle({
    active: !pos || effectiveIsTopmost,
    radius: 12,
  })
  const explicitSized = Boolean(size)
  // mousedown anywhere on the panel (header, body, buttons) is the click-to-focus trigger.
  // Using mousedown rather than click means the panel rises immediately, before any nested
  // event listener runs — so the focused panel is on top while the user's actual gesture
  // (button press, drag-to-select) executes against it.
  const onPanelMouseDown = stack.bringToFront
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: stack.zIndex - 1,
      background: pos ? 'transparent' : 'rgba(0,0,0,0.5)',
      display: pos ? 'block' : 'flex',
      alignItems: 'flex-start', justifyContent: 'center',
      padding: pos ? 0 : `${DETAIL_TOP_PADDING} 16px 16px`,
      pointerEvents: pos ? 'none' : 'auto',
      overflowY: 'auto',
    }}>
      <div
        ref={panelRef}
        onMouseDownCapture={onPanelMouseDown}
        style={{
          position: pos ? 'fixed' : 'relative',
          left: pos ? pos.x : undefined,
          top: pos ? pos.y : undefined,
          width: explicitSized ? size.width : DETAIL_PANEL_WIDTH,
          maxWidth: explicitSized ? undefined : DETAIL_PANEL_WIDTH,
          height: explicitSized ? size.height : undefined,
          maxHeight: explicitSized
            ? undefined
            : (pos
              ? `calc(100vh - ${DETAIL_FLOATING_TOP_GUTTER + DETAIL_FLOATING_EDGE_GUTTER}px)`
              : '85vh'),
          display: 'flex',
          flexDirection: 'column',
          pointerEvents: 'auto',
          userSelect: dragging || resizing ? 'none' : 'auto',
          zIndex: stack.zIndex,
          ...panelSurfaceStyle,
        }}
      >
        <div
          onMouseDown={onDragStart}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '16px 24px', borderBottom: '1px solid var(--border)', flexShrink: 0,
            background: getFloatingPanelHeaderBackground(effectiveIsTopmost),
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

        {/* overflow:auto so panels whose total content (header rows + trend chart + selected
            month section) exceeds the panel's max-height let the user scroll to see the rest
            instead of silently clipping at the bottom. The transaction list inside still owns
            its own bounded scroll for the rows; the outer scroll here is for the panel-level
            content stack. */}
        <div style={{ flex: 1, overflow: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column' }}>
          {children}
        </div>
        {onResizeStart && (
          <div
            onMouseDown={onResizeStart}
            title="Drag to resize"
            style={{
              position: 'absolute',
              right: 0, bottom: 0,
              width: 18, height: 18,
              cursor: 'nwse-resize',
              touchAction: 'none',
            }}
          >
            <div style={{
              position: 'absolute',
              right: 4, bottom: 4,
              width: 9, height: 9,
              borderRight: '2px solid var(--muted)',
              borderBottom: '2px solid var(--muted)',
              opacity: 0.55,
            }} />
          </div>
        )}
      </div>
    </div>
  )
}
