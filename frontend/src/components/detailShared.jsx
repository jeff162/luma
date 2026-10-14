// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- DetailPanelShell + chart components + paging hooks + sizing helpers live together as the detail-panel kit */

/*
 * Shared chrome for every floating detail panel (AccountDetail, CategoryDetail, PeriodDetail,
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
 *   - `usePagedTransactions` backs lists paged by position: drawn whole, fetched where scrolled to.
 *     `activeKey` resets pagination — consumers include filters (date range, search) in the
 *     key so changing a filter starts over at page 1.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, LabelList,
} from 'recharts'
import { CLICKABLE_CHART_EVENTS } from '../lib/chartInteraction.js'
import { monthLabel } from '../lib/utils.js'
import { useUserPreference } from '../lib/UserPreferencesContext.jsx'
import { formatSignedAxisTick, formatSignedMoneyAmount } from '../lib/moneyDisplay.js'
import { getFloatingPanelSurfaceStyle, getFloatingPanelHeaderBackground } from './ui.jsx'
import { usePanelStackSlot } from '../contexts/PanelStackContext.jsx'
import { isEditableTarget } from '../lib/uiInteractions.js'
import { downloadMatchingTransactions, walkTransactionPages } from '../lib/allMatchingTransactions.js'
import { leadingRows } from '../lib/rowSlots.js'
import { usePagedRowSlots } from '../lib/usePagedRowSlots.js'

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

function readViewport() {
  return { width: window.innerWidth, height: window.innerHeight }
}

// The size a panel may actually occupy in a given viewport. Takes the viewport rather than reading the
// window, so a render can re-derive it from state and a live gesture can pass the current one.
function clampPanelSize(next, view) {
  if (!next) return null
  const maxWidth = Math.max(DETAIL_PANEL_MIN_WIDTH, view.width - DETAIL_FLOATING_EDGE_GUTTER * 2)
  const maxHeight = Math.max(DETAIL_PANEL_MIN_HEIGHT, view.height - DETAIL_FLOATING_TOP_GUTTER - DETAIL_FLOATING_EDGE_GUTTER)
  return {
    width: Math.max(DETAIL_PANEL_MIN_WIDTH, Math.min(maxWidth, next.width)),
    height: Math.max(DETAIL_PANEL_MIN_HEIGHT, Math.min(maxHeight, next.height)),
  }
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
    // Called once when a drag or resize gesture ends (not on a plain header click), with the final
    // { pos, size }. Lets a caller persist panel geometry without subscribing to a per-gesture
    // `dragging`/`resizing` flag — subscribing to that flag would re-render the caller (and its
    // large body) twice on every header click. See the drag note below.
    onGestureEnd = null,
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
  //
  // The size asked for is held apart from the size rendered, and the clamp is applied on the way out
  // rather than written back into state. A clamp that wrote back is lossy: shrinking the window would
  // overwrite the user's size with the smaller one, and growing it again had nothing left to restore.
  // Keeping the request intact means the panel gives room back as the window shrinks and takes it
  // straight back as the window grows, up to whatever the user originally set.
  const [desiredSize, setDesiredSize] = useState(initialSize)
  const [viewport, setViewport] = useState(readViewport)
  const size = useMemo(() => clampPanelSize(desiredSize, viewport), [desiredSize, viewport])
  const panelRef = useRef(null)
  const dragOffset = useRef({ x: 0, y: 0 })
  const resizeStart = useRef({ x: 0, y: 0, left: 0, top: 0, width: 0, height: 0, dir: 'se' })
  const hasDragged = useRef(false)
  // Teardown for the window listeners + cursor cosmetics of an in-flight gesture. Held in a ref so
  // the unmount effect can end a gesture cleanly if the panel closes while a drag/resize is live.
  const gestureCleanup = useRef(null)

  // Gesture cosmetics go straight to the DOM instead of React state so that starting or ending a
  // drag/resize does NOT re-render this hook's consumer. The consumer owns the panel body (often a
  // large list), and a state toggle here re-rendered every row twice per header click. userSelect:none
  // stops the drag from selecting header/body text; the grabbing cursor goes on <body> so it wins over
  // the header's own cursor without threading a ref down to it.
  function setGestureCosmetics(active, grabCursor = false) {
    if (panelRef.current) panelRef.current.style.userSelect = active ? 'none' : ''
    if (grabCursor) document.body.style.cursor = active ? 'grabbing' : ''
  }

  // Direct-DOM drag: each mousemove writes `left`/`top` on panelRef (rAF-batched) instead of driving
  // React state, so mid-drag never reconciles the (potentially huge) panel body. We keep the whole
  // gesture — start, move, and end — off React state; the only state write is the single setPos on
  // release so later renders read an up-to-date position. This is why a plain click on a header
  // control (e.g. the × close button) costs zero re-renders: no movement, no setPos. For dialogs with
  // large bodies (the duplicate-detection report renders thousands of rows) a per-gesture state toggle
  // used to re-render every row twice per click on the header.
  function onDragStart(e) {
    if (!panelRef.current) return
    const rect = panelRef.current.getBoundingClientRect()
    dragOffset.current = {
      x: e.clientX - (pos ? pos.x : rect.left),
      y: e.clientY - (pos ? pos.y : rect.top),
    }
    hasDragged.current = false
    e.preventDefault()

    let pendingFrame = null
    let lastEvent = null
    let lastWritten = null
    function applyFrame() {
      pendingFrame = null
      if (!lastEvent || !panelRef.current) return
      const r = panelRef.current.getBoundingClientRect()
      const next = clampPanelPosition({
        x: lastEvent.clientX - dragOffset.current.x,
        y: lastEvent.clientY - dragOffset.current.y,
      }, r)
      panelRef.current.style.left = `${next.x}px`
      panelRef.current.style.top  = `${next.y}px`
      lastWritten = next
    }
    function onMove(ev) {
      if (!hasDragged.current) {
        if (!pos && panelRef.current) {
          const r = panelRef.current.getBoundingClientRect()
          setPos({ x: r.left, y: r.top })
          dragOffset.current = { x: ev.clientX - r.left, y: ev.clientY - r.top }
        }
        hasDragged.current = true
      }
      lastEvent = { clientX: ev.clientX, clientY: ev.clientY }
      if (!pendingFrame) pendingFrame = requestAnimationFrame(applyFrame)
    }
    function teardown() {
      if (pendingFrame) { cancelAnimationFrame(pendingFrame); pendingFrame = null }
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setGestureCosmetics(false, true)
      gestureCleanup.current = null
    }
    function onUp() {
      if (pendingFrame) { cancelAnimationFrame(pendingFrame); applyFrame() }
      teardown()
      if (lastWritten) setPos(lastWritten)
      // Only a real move persists geometry; a plain click (no drag) leaves the saved position alone.
      if (hasDragged.current) onGestureEnd?.({ pos: lastWritten || pos, size })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    setGestureCosmetics(true, true)
    gestureCleanup.current = teardown
  }

  // Resize converts the panel into floating mode (matching drag) so size and
  // position stay coherent: once the user has explicitly sized a panel, it
  // should stick at that geometry regardless of where it was originally docked.
  // `dir` is the handle's edge/corner ('n','s','e','w','ne','nw','se','sw'); dragging a
  // west/north edge also moves the panel's origin so the opposite edge stays anchored.
  function onResizeStart(e, dir = 'se') {
    if (!panelRef.current) return
    const rect = panelRef.current.getBoundingClientRect()
    resizeStart.current = {
      x: e.clientX, y: e.clientY,
      left: rect.left, top: rect.top,
      width: rect.width, height: rect.height,
      dir,
    }
    // Resize does drive React state each frame (unlike drag) because width/height changes must reflow
    // the body — there's no direct-DOM shortcut. But the start/stop of the gesture stays off state so
    // it doesn't add two extra full re-renders bracketing the resize.
    let seededPos = pos
    if (!size) setDesiredSize({ width: rect.width, height: rect.height })
    if (!pos) { seededPos = { x: rect.left, y: rect.top }; setPos(seededPos) }
    e.preventDefault()
    e.stopPropagation()

    let lastGeom = { pos: seededPos, size: size || { width: rect.width, height: rect.height } }
    function onMove(ev) {
      const { x, y, left, top, width, height, dir: d } = resizeStart.current
      const dx = ev.clientX - x
      const dy = ev.clientY - y
      let nextWidth = width
      let nextHeight = height
      if (d.includes('e')) nextWidth = width + dx
      if (d.includes('w')) nextWidth = width - dx
      if (d.includes('s')) nextHeight = height + dy
      if (d.includes('n')) nextHeight = height - dy
      const clamped = clampPanelSize({ width: nextWidth, height: nextHeight }, readViewport())
      setDesiredSize(clamped)
      lastGeom = { ...lastGeom, size: clamped }
      // West/north edges grow the panel toward the origin, so move left/top by however much the
      // clamped size actually changed — that keeps the opposite (east/south) edge pinned in place.
      // Clamp against the *new* size (not the panel's stale pre-resize rect) so a horizontal/vertical
      // viewport clamp doesn't drag the anchored edge off its mark.
      if (d.includes('w') || d.includes('n')) {
        const nextLeft = d.includes('w') ? left + (width - clamped.width) : left
        const nextTop = d.includes('n') ? top + (height - clamped.height) : top
        const nextPos = clampPanelPosition({ x: nextLeft, y: nextTop }, clamped)
        setPos(nextPos)
        lastGeom = { ...lastGeom, pos: nextPos }
      }
    }
    function teardown() {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setGestureCosmetics(false)
      gestureCleanup.current = null
    }
    function onUp() {
      teardown()
      onGestureEnd?.(lastGeom)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    setGestureCosmetics(true)
    gestureCleanup.current = teardown
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

  // If the panel unmounts while a drag/resize is still in flight (rare — e.g. an Escape-to-close
  // bound elsewhere fires mid-gesture), tear down the live window listeners and restore body cursor.
  useEffect(() => () => { gestureCleanup.current?.() }, [])

  useEffect(() => {
    function handleResize() {
      setPos(prev => clampPanelPosition(prev, panelRef.current?.getBoundingClientRect()))
      // Only the viewport is recorded; the rendered size falls out of it. The requested size is left
      // untouched so the panel can grow back into a window that is enlarged again.
      setViewport(prev => {
        const next = readViewport()
        return prev.width === next.width && prev.height === next.height ? prev : next
      })
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

  return { pos, size, panelRef, onDragStart, onResizeStart }
}

// Restore + persist a floating panel's geometry across opens, keyed by a per-user preference. Returns
// the `{ initialPosition, initialSize }` to seed `useDetailPanelChrome` with and the `onGestureEnd`
// that saves the final pos/size after each drag/resize. Saved geometry is shape { pos, size, viewport }:
// the viewport is snapshotted at save time so a restore on a different-sized browser scales pos/size
// proportionally (a panel saved bottom-right on 1920×1080 stays bottom-right on 1280×720, just smaller);
// min sizes are re-enforced after scaling so an aggressive shrink can't produce an unusable panel, and
// the chrome hook's own clamp pass is the final safety net. Shared by every detached report dialog.
export function useRestorablePanelGeometry(prefKey, { fallbackWidth = 1280, fallbackHeight = 720, edgeGutter = 48, topGutter = 160 } = {}) {
  const [savedPanel, setSavedPanel] = useUserPreference(prefKey, null)
  const { initialPosition, initialSize } = useMemo(() => {
    const hasWindow = typeof window !== 'undefined'
    const fallbackSize = {
      width:  Math.min(fallbackWidth,  (hasWindow ? window.innerWidth  : fallbackWidth)  - edgeGutter),
      height: Math.min(fallbackHeight, (hasWindow ? window.innerHeight : fallbackHeight) - topGutter),
    }
    if (!savedPanel || !hasWindow) return { initialPosition: null, initialSize: fallbackSize }
    const savedViewport = savedPanel.viewport
    if (!savedViewport?.width || !savedViewport?.height) {
      // Legacy save (pre-viewport-scaling): use as-is. Hook clamping handles overflow.
      return { initialPosition: savedPanel.pos || null, initialSize: savedPanel.size || fallbackSize }
    }
    const scaleX = window.innerWidth / savedViewport.width
    const scaleY = window.innerHeight / savedViewport.height
    const scaledSize = savedPanel.size ? {
      width:  Math.max(DETAIL_PANEL_MIN_WIDTH,  Math.round(savedPanel.size.width  * scaleX)),
      height: Math.max(DETAIL_PANEL_MIN_HEIGHT, Math.round(savedPanel.size.height * scaleY)),
    } : fallbackSize
    const scaledPos = savedPanel.pos ? {
      x: Math.round(savedPanel.pos.x * scaleX),
      y: Math.round(savedPanel.pos.y * scaleY),
    } : null
    return { initialPosition: scaledPos, initialSize: scaledSize }
  }, [savedPanel, fallbackWidth, fallbackHeight, edgeGutter, topGutter])
  const onGestureEnd = ({ pos: gPos, size: gSize }) => {
    if (!gPos && !gSize) return
    setSavedPanel({ pos: gPos || null, size: gSize || null, viewport: { width: window.innerWidth, height: window.innerHeight } })
  }
  return { initialPosition, initialSize, onGestureEnd }
}

// Gates a detail panel's reveal on its geometry going quiet, returning a `revealed` flag for
// DetailPanelShell. These panels reflow in stages as they open — a spinner gives way to a chart, the
// chart does a second measure/draw pass, a month list lands, and a grown panel trips the shell's
// position clamp. Revealing on a data-loaded flag alone still shows some of that settling, so once the
// caller's primary data is in (`dataReady`) we watch `panelRef` with a ResizeObserver and reveal only
// after it has held a stable size briefly. A hard cap guarantees a slow/never-quiet body still appears.
// `revealed` latches true, so later in-place updates (source/date changes) never re-hide the panel.
// Hold the panel at opacity 0 (DetailPanelShell does) rather than unmounting it so it lays out and
// measures while hidden — that's what lets this settle before the first visible frame.
export function usePanelReveal(panelRef, dataReady) {
  const [revealed, setRevealed] = useState(false)
  useEffect(() => {
    if (revealed || !dataReady) return undefined
    const el = panelRef.current
    if (!el) return undefined
    const SETTLE_MS = 90
    const HARD_CAP_MS = 1200
    let settleTimer
    const arm = () => { clearTimeout(settleTimer); settleTimer = setTimeout(() => setRevealed(true), SETTLE_MS) }
    const observer = new ResizeObserver(arm)
    observer.observe(el)
    arm() // in case the size is already stable and no further resize fires
    const cap = setTimeout(() => setRevealed(true), HARD_CAP_MS)
    return () => { observer.disconnect(); clearTimeout(settleTimer); clearTimeout(cap) }
  }, [revealed, dataReady, panelRef])
  return revealed
}

// The detail panels drill from a monthly trend chart into a scoped transaction list. By default the
// list shows the one month whose bar is selected, but the user can widen it to the selected bar's
// calendar year or the whole charted span via DetailRangeControl. These helpers turn (mode, anchor
// month, trend) into the concrete pieces every consumer needs — the fetch params, a stable cache key,
// the section label, and the count/total — so month/year/all-time behaves identically across the three
// panels (merchant, category, account).
export const DETAIL_RANGE_OPTIONS = [
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
  { value: 'all', label: 'All time' },
]

// A stable identity for the current window, used both as the paged-fetch cache key and (crucially) to
// memoize the range so clicking a *different bar within the same window* — any bar in all-time mode, a
// same-year bar in year mode — does not churn the fetch and reload identical rows. In month mode the
// anchor month IS the window, so it varies per click as expected.
export function detailRangeStableKey(mode, selectedMonth) {
  if (mode === 'all') return 'all'
  if (mode === 'year') return selectedMonth ? selectedMonth.slice(0, 4) : ''
  return selectedMonth || ''
}

// The window a given mode resolves to, derived from the anchor month and the charted trend:
//   month → the anchor's calendar month
//   year  → the anchor's calendar year
//   all   → the full span the chart is showing (its first..last month), so the list, the footer
//           count/total (summed from the same trend rows), and the chart always agree — even where the
//           trend itself is capped below the true history (the category drawer's month window; an
//           account's trend is its full history).
// Month-end upper bounds use `${month}-31`: transaction dates compare lexically, so it includes every
// day of that month without needing the real last day.
export function computeDetailRange(mode, selectedMonth, trend) {
  const rows = Array.isArray(trend) ? trend : []
  let params
  let windowRows
  let label
  if (mode === 'all') {
    const first = rows[0]?.month
    const last = rows[rows.length - 1]?.month
    params = (first && last) ? { date_start: `${first}-01`, date_end: `${last}-31` } : {}
    windowRows = rows
    label = 'All time'
  } else if (mode === 'year') {
    const yr = selectedMonth ? selectedMonth.slice(0, 4) : ''
    params = yr ? { date_start: `${yr}-01-01`, date_end: `${yr}-12-31` } : {}
    windowRows = rows.filter(r => (r.month || '').slice(0, 4) === yr)
    label = yr
  } else {
    params = selectedMonth ? { month: selectedMonth } : {}
    windowRows = rows.filter(r => r.month === selectedMonth)
    label = selectedMonth ? monthLabel(selectedMonth) : ''
  }
  const count = windowRows.reduce((sum, r) => sum + (Number(r?.count) || 0), 0)
  const total = windowRows.reduce((sum, r) => sum + (Number(r?.total) || 0), 0)
  return { params, count, total, label }
}

// Which chart bars read as "in the current window", so the highlight tracks the range choice: the one
// selected month, every bar in the selected year, or every bar in all-time mode.
export function detailRangeActiveMonth(mode, selectedMonth) {
  if (mode === 'all') return () => true
  if (mode === 'year') {
    const yr = selectedMonth ? selectedMonth.slice(0, 4) : ''
    return month => (month || '').slice(0, 4) === yr
  }
  return month => month === selectedMonth
}

// Segmented Month · Year · All time control for the transaction-list header. The clicked bar stays the
// anchor in every mode; this only changes how wide a window around it the list shows.
export function DetailRangeControl({ mode, onChange }) {
  return (
    <div
      role="group"
      aria-label="Transaction range"
      style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 999, overflow: 'hidden' }}
    >
      {DETAIL_RANGE_OPTIONS.map(opt => {
        const active = opt.value === mode
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            aria-pressed={active}
            style={{
              border: 'none', cursor: 'pointer', fontSize: 12, padding: '3px 11px', lineHeight: 1.4,
              background: active ? 'var(--accent)' : 'transparent',
              color: active ? '#fff' : 'var(--muted)',
              fontWeight: active ? 600 : 500,
            }}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

// Detail lists open newest-first, matching the ledger's default.
export const DETAIL_SORT_DEFAULT = { key: 'date', dir: 'desc' }
// Date and amount read most-useful biggest-first; text columns start A→Z. Mirrors the ledger's
// getInitialSortDirection so a column's first-click direction is the same everywhere.
function detailInitialSortDir(key) {
  return key === 'date' || key === 'amount' ? 'desc' : 'asc'
}

// Backs the detail panels' transaction lists: paged by position (DETAIL_PAGE_SIZE per page, see
// lib/usePagedRowSlots.js) with **server-side sort**. `loadPage(offset, limit, sort)` does the fetch and must
// forward `sort` to the API (`sort_by`/`sort_dir`) — sorting has to happen server-side because a client-side
// sort over a partly loaded list orders only the rows that happen to be loaded. Changing the sort re-pages
// from the first row in the new order. `activeKey` starts the list over — consumers include their filters
// (date range, search) in the key so changing a filter starts over.
// `total`/`sumAmount` are the server aggregates over the whole filtered set, for a header count/total that
// stays correct past the loaded pages; consumers that derive those from a trend (category/account) ignore
// them. `rows` are the loaded rows and `setRows` edits them as a plain list would be edited. Feed
// `sortState`/`onSort` into TransactionListTable's controlled-sort props and `paging` into its `paging` prop,
// which draws the whole list and fetches the pages scrolled to.
export function usePagedTransactions({ activeKey, loadPage, exportParams = null }) {
  const [loading, setLoading] = useState(false)
  const [sumAmount, setSumAmount] = useState(0)
  const [sortState, setSortState] = useState(DETAIL_SORT_DEFAULT)
  // `reload()` bumps this to re-run the query already on screen — the Refresh affordance every list that
  // lets rows linger owes the user (`ui-patterns.md` → *Transaction lists*). It is separate from
  // `activeKey` because the query has not changed: what changed is the ledger under it.
  const [reloadNonce, setReloadNonce] = useState(0)
  const [reloading, setReloading] = useState(false)
  const reload = useCallback(() => setReloadNonce(n => n + 1), [])
  // The query the last load ran for. A load of the same one is a reload, and a reload must not blank the
  // list: hosts render a spinner in place of the table while `loading`, so reusing that flag would replace
  // the rows the user is looking at with a spinner. A reload also keeps the reader's place.
  const loadedQueryRef = useRef(null)

  // Header clicks pass a column key; re-clicking the same key flips direction. The load effect depends on
  // the page fetch, which closes over sortState, so a sort change re-pages from the first row.
  const onSort = useCallback(key => {
    setSortState(prev => (prev && prev.key === key
      ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: detailInitialSortDir(key) }))
  }, [])

  const fetchPage = useCallback((offset, limit) => loadPage(offset, limit, sortState), [loadPage, sortState])
  const paged = usePagedRowSlots({ fetchPage, pageSize: DETAIL_PAGE_SIZE })
  const { rows, slots, total, setRows, setTotal, reset, clear, paging } = paged

  useEffect(() => {
    if (!activeKey) {
      clear()
      setLoading(false)
      setReloading(false)
      setSumAmount(0)
      loadedQueryRef.current = null
      return
    }
    const query = `${activeKey}\u0000${sortState.key}\u0000${sortState.dir}`
    const isReload = loadedQueryRef.current === query
    loadedQueryRef.current = query
    if (isReload) setReloading(true)
    else setLoading(true)
    reset({ fromTop: !isReload }).then(({ status, response }) => {
      if (status === 'stale') return
      if (status === 'ok') setSumAmount(Number(response?.sum_amount || 0))
      // A new query that failed must not leave the previous one's rows under its heading.
      else if (!isReload) { clear(); setSumAmount(0) }
      setLoading(false)
      setReloading(false)
    })
  }, [activeKey, sortState.key, sortState.dir, reset, clear, reloadNonce])

  // What the list's copy button takes (`CopyTransactionsButton`'s loadRows / total / onDownload), so a copy
  // reaches past the pages scrolled to. Further rows come through the same `loadPage`, in the list's sort.
  // The download needs the filter itself: `exportParams` is the object the host fetches with — the one it
  // already hands bulk edit — and without it the copy dialog offers no download.
  const loadRows = useCallback(({ limit } = {}) => {
    const leading = leadingRows(slots, Math.min(limit ?? Infinity, total))
    if (leading) return Promise.resolve(leading)
    return walkTransactionPages((pageOffset, pageLimit) => loadPage(pageOffset, pageLimit, sortState), { maxRows: limit })
  }, [slots, total, loadPage, sortState])
  const copy = useMemo(() => ({
    loadRows,
    total,
    onDownload: exportParams
      ? () => downloadMatchingTransactions({ ...exportParams, sort_by: sortState.key, sort_dir: sortState.dir })
      : null,
  }), [loadRows, total, exportParams, sortState])

  return {
    rows,
    setRows,
    loading,
    reload,
    reloading,
    paging,
    total,
    setTotal,
    sumAmount,
    sortState,
    onSort,
    copy,
  }
}

function YearTick({ x, y, payload, onSelect }) {
  if (!payload?.value) return null
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const monthName = months[parseInt(payload.value.slice(5), 10) - 1] ?? ''
  return (
    <g
      onClick={onSelect ? () => onSelect(payload.value) : undefined}
      style={onSelect ? { cursor: 'pointer' } : undefined}
    >
      {/* Transparent hit box so the whole tick cell — not just the glyphs — selects the month. */}
      <rect x={x - 18} y={y} width={36} height={20} fill="transparent" />
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

// `isMonthActive(month)` optionally generalizes the highlight from a single selected month to a whole
// window (a year, or all bars in all-time mode); it defaults to just the selected month so callers that
// don't pass it keep the original single-bar behavior.
export function DetailTrendChart({ trend, selectedMonth, onSelectMonth, isMonthActive = null }) {
  const monthActive = isMonthActive || (month => month === selectedMonth)
  const dimNonActive = !!selectedMonth || !!isMonthActive
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
          {/* Selecting a month happens at the chart level off the active category, so the whole vertical
              column is a hit target — clicking the empty space above a tiny bar still selects its month.
              The month tick below the axis is wired to the same handler for the same reason. */}
          <BarChart
            data={visible}
            margin={{ top: 28, right: 8, bottom: 8, left: 8 }}
            style={{ cursor: 'pointer' }}
            {...CLICKABLE_CHART_EVENTS}
            onClick={state => { if (state?.activeLabel) onSelectMonth?.(state.activeLabel) }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey="month" tick={<YearTick data={visible} onSelect={onSelectMonth} />} tickLine={false} axisLine={false} height={30} interval={0} minTickGap={0} />
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
                  fill={monthActive(entry.month) ? 'var(--accent2)' : 'var(--accent)'}
                  opacity={dimNonActive && !monthActive(entry.month) ? 0.4 : 1}
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

// Resize handles for every edge and corner. Each straddles the panel border (mostly in the exterior
// gutter) so the grab zones don't sit over the body's scrollbar; edges run between the corner squares.
// Only the bottom-right corner shows a visible diagonal grip — the rest are invisible hit areas whose
// cursor advertises them on hover.
const PANEL_RESIZE_HANDLES = [
  { dir: 'n', cursor: 'ns-resize', style: { top: -4, left: 16, right: 16, height: 8 } },
  { dir: 's', cursor: 'ns-resize', style: { bottom: -4, left: 16, right: 16, height: 8 } },
  { dir: 'e', cursor: 'ew-resize', style: { right: -4, top: 16, bottom: 16, width: 8 } },
  { dir: 'w', cursor: 'ew-resize', style: { left: -4, top: 16, bottom: 16, width: 8 } },
  { dir: 'ne', cursor: 'nesw-resize', style: { top: -4, right: -4, width: 16, height: 16 } },
  { dir: 'nw', cursor: 'nwse-resize', style: { top: -4, left: -4, width: 16, height: 16 } },
  { dir: 'se', cursor: 'nwse-resize', style: { bottom: -4, right: -4, width: 16, height: 16 } },
  { dir: 'sw', cursor: 'nesw-resize', style: { bottom: -4, left: -4, width: 16, height: 16 } },
]

export function DetailPanelShell({
  pos,
  size,
  panelRef,
  onDragStart,
  onResizeStart,
  onClose,
  header,
  children,
  isTopmost = true,
  // When false, the panel is laid out and measured but held invisible (opacity 0, non-interactive).
  // A caller whose body reflows as async content loads (chart → month list) uses this to reveal the
  // panel only once it has settled at its final size, so it fades in fully formed instead of visibly
  // growing/repositioning. We hold it at opacity 0 — not display:none — precisely so it DOES lay out
  // while hidden (the position clamp settles and Recharts can measure its container before reveal).
  revealed = true,
  // Take the full height available instead of sizing to content. A panel whose body is one long list
  // needs this: a bounded list inside a content-sized panel can only ever be as tall as the number it
  // was given, so the window growing changes nothing. Filling gives the body a *definite* height, which
  // is what lets an inner `fillHeight` list resolve a percentage height and own its own scroll — the
  // scroll has to stay with the list, since that is what drives its paging. The cost is that a short
  // list leaves empty room below it, so this is for list panels rather than the chart+list ones.
  fillHeight = false,
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
  // The tallest the panel may be: a floating panel leaves the gutters it is dragged within, a docked one
  // sits under the overlay's own top padding.
  const availableHeight = pos
    ? `calc(100vh - ${DETAIL_FLOATING_TOP_GUTTER + DETAIL_FLOATING_EDGE_GUTTER}px)`
    : '85vh'
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
      opacity: revealed ? 1 : 0,
      transition: 'opacity 140ms ease',
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
          // A filling panel takes its cap as its height, so the two stay one number: whatever the
          // viewport allows is both the most it may be and exactly what it is.
          height: explicitSized ? size.height : (fillHeight ? availableHeight : undefined),
          maxHeight: explicitSized ? undefined : availableHeight,
          display: 'flex',
          flexDirection: 'column',
          // 'auto' re-enables interaction inside the pointer-transparent floating backdrop; while the
          // panel is still held invisible (revealed=false) keep it non-interactive so a click can't
          // land on it before it fades in.
          pointerEvents: revealed ? 'auto' : 'none',
          // userSelect during a gesture is toggled imperatively by useDetailPanelChrome (direct DOM)
          // so a drag/resize never re-renders this panel; left unset here it defaults to selectable.
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
            // Grab affordance at rest; the grabbing cursor during an active drag is applied to <body>
            // by useDetailPanelChrome so it wins panel-wide without re-rendering.
            cursor: 'grab',
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
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column' }}>
          {children}
        </div>
        {onResizeStart && PANEL_RESIZE_HANDLES.map(handle => (
          <div
            key={handle.dir}
            onMouseDown={e => onResizeStart(e, handle.dir)}
            title="Drag to resize"
            style={{
              position: 'absolute',
              zIndex: 5,
              cursor: handle.cursor,
              touchAction: 'none',
              ...handle.style,
            }}
          >
            {handle.dir === 'se' && (
              <div style={{
                position: 'absolute',
                right: 8, bottom: 8,
                width: 9, height: 9,
                borderRight: '2px solid var(--muted)',
                borderBottom: '2px solid var(--muted)',
                opacity: 0.55,
              }} />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
