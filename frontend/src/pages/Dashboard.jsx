// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useState, useEffect, useMemo, useRef } from 'react'
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  BarChart, Bar, ComposedChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, ReferenceLine,
} from 'recharts'
import { api } from '../lib/api.js'
import { txnMutations, reconcileRowsAfterRuleApply } from '../lib/txnMutations.js'
import TransactionDetail from '../components/TransactionDetail.jsx'
import MonthDetail from '../components/MonthDetail.jsx'
import TagDetail from '../components/TagDetail.jsx'
import RuleSuggestionToast from '../components/RuleSuggestionToast.jsx'
import FeatureExplainer from '../help/FeatureExplainer.jsx'
import { useFilters } from '../lib/FilterContext.jsx'
import { formatCurrency, monthLabel, lastNMonths } from '../lib/utils.js'
import {
  CHART_TOOLTIP_CONTENT_STYLE,
  CHART_TOOLTIP_ITEM_STYLE,
  CHART_TOOLTIP_LABEL_STYLE,
  formatSignedAxisTick,
  formatSignedMoneyAmount,
} from '../lib/moneyDisplay.js'
import { AppDialog, Button, Card, Input, PageHeader, Select, Spinner, EmptyState, CategoryMarker } from '../components/ui.jsx'
import { TagGlyph } from '../components/TagUi.jsx'
import { format, subMonths } from 'date-fns'
import TransactionListTable from '../components/TransactionListTable.jsx'
import CopyTransactionsButton from '../components/CopyTransactionsButton.jsx'
import { useBulkTransactionEditing, BulkEditChrome } from '../lib/useBulkTransactionEditing.jsx'
import { useTransactionTableLayout } from '../lib/transactionTablePreferences.js'
import { useUserPreference, useDeferredPreference } from '../lib/UserPreferencesContext.jsx'

const DASHBOARD_CATEGORY_TXN_TABLE_PREF_KEY = 'ui.dashboard.categoryTransactions.columns'
const DASHBOARD_GROUP_TXN_TABLE_PREF_KEY = 'ui.dashboard.groupTransactions.columns'
const DASHBOARD_SPENDING_VIEW_BY_PREF_KEY = 'ui.dashboard.spendingViewBy'
const DASHBOARD_VIEW_PREF_KEY = 'ui.dashboard.view'
// Left-panel ("Total per month") width fraction of the Trends month/annual split; the user drags the
// divider to rebalance and it persists. Defaults to giving the monthly chart a little more room than
// the annual one (its month labels are tighter than 4-digit years). Clamped to [MIN, MAX].
const DASHBOARD_TRENDS_SPLIT_PREF_KEY = 'ui.dashboard.trendsSplit'
const TRENDS_SPLIT_DEFAULT = 0.56
const TRENDS_SPLIT_MIN = 0.3
const TRENDS_SPLIT_MAX = 0.75

const SPENDING_VIEW_BY_GROUP = 'group'
const SPENDING_VIEW_BY_CATEGORY = 'category'
const TAG_REPORT_PREFIX = 'tag:'
const NEW_TAG_REPORT_OPTION = '__new_tag_report__'

const SPENDING_VIEW_BY_BUILTIN_OPTIONS = [
  { value: SPENDING_VIEW_BY_GROUP, label: 'group' },
  { value: SPENDING_VIEW_BY_CATEGORY, label: 'category' },
]

// Saved tag-report shape:
// { id, name, tagIds: string[], dismissedMissingWarning?: boolean }
// The catalog is SHARED tenant state (backend `GET`/`PUT /tags/dashboard-reports`, stored in
// import_workflow_state), so every user/profile sees the same saved reports; only the current
// selection (`spendingViewBy`) is per-user. The picker exposes each saved report as a value of
// `${TAG_REPORT_PREFIX}${id}`, alongside the two built-in `group` and `category` options and a
// `+ Tag report` action that opens the builder.
function makeTagReportId() {
  return `tr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

const DASHBOARD_VIEW_OPTIONS = [
  { value: 'spending', label: 'Expenses' },
  { value: 'income', label: 'Income' },
]

// Slicing model for the single-mode pie chart:
// - Each pie page shows the long-tail items as named wedges, plus one
//   synthetic "Other" wedge carrying whatever's left.
// - Named-wedge count is data-driven: keep peeling items off the tail while
//   the next slice's share of the page's pool total is at least
//   SMALLEST_NAMED_SLICE_MIN_SHARE; once it would drop below that, stop and
//   roll the rest into Other so the smallest wedge stays clickable.
// - MIN_NAMED_SLICES is a safety floor for very flat distributions where
//   nothing meets the threshold; without it we could end up with everything
//   in Other on every page and never make progress.
// - Singletons (Other == 1 item) are absorbed into the named slices so we
//   never show a one-item Other wedge.
// - Clicking Other pages further into the tail; the same rule applies again
//   within that depth's pool.
// - There is intentionally no upper cap on named slices; if a real dataset
//   has many categories above the threshold, that's preferable to forcing
//   the user through extra Other-drill levels.
const MIN_NAMED_SLICES = 10
const SMALLEST_NAMED_SLICE_MIN_SHARE = 0.03
const OTHER_SLICE_KEY = '__other__'
const OTHER_SLICE_COLOR = '#6b7280'

// Build the per-signature buckets that drive the tag-report pie. Each transaction's
// signature is the *sorted* set of selected tag ids it carries; transactions matching
// no selected tags fall into an Other / Untagged bucket. The bucket key is stable
// (sorted ids joined by `|`) so React keys don't churn.
function computeTagSignatureRows(transactions, selectedTagIds, tagsById) {
  const selectedSet = new Set(selectedTagIds)
  const buckets = new Map()
  for (const txn of transactions) {
    const matched = (txn.tags || [])
      .map(t => t.id)
      .filter(id => selectedSet.has(id))
      .sort()
    const signatureKey = matched.length > 0 ? matched.join('|') : OTHER_SLICE_KEY
    let bucket = buckets.get(signatureKey)
    if (!bucket) {
      const isOther = matched.length === 0
      bucket = {
        signature_id: signatureKey,
        signature_tag_ids: matched,
        signature_name: isOther
          ? 'Other / Untagged'
          : matched.map(id => tagsById.get(id)?.name || '?').join(' + '),
        signature_color: isOther ? OTHER_SLICE_COLOR : null,
        is_other: isOther,
        total: 0,
        count: 0,
      }
      buckets.set(signatureKey, bucket)
    }
    bucket.total += Math.abs(Number(txn.amount) || 0)
    bucket.count += 1
  }
  // Real signatures sort by total desc; Other/Untagged always sinks to the bottom of
  // the visible list so the pie reads as "named buckets first, leftover last".
  const rows = Array.from(buckets.values()).sort((a, b) => {
    if (a.is_other && !b.is_other) return 1
    if (b.is_other && !a.is_other) return -1
    return b.total - a.total
  })
  // Assign palette colors to non-Other rows, preserving the OTHER_SLICE_COLOR for the Other row.
  let paletteIndex = 0
  for (const row of rows) {
    if (row.is_other) continue
    row.signature_color = CHART_PALETTE[paletteIndex % CHART_PALETTE.length]
    paletteIndex++
  }
  return rows
}

function computeSlicePages(rows) {
  const pages = []
  let start = 0
  while (start < rows.length) {
    const remaining = rows.slice(start)
    const poolTotal = remaining.reduce((s, r) => s + (Number(r.total) || 0), 0)
    let pageSize = Math.min(MIN_NAMED_SLICES, remaining.length)
    while (pageSize < remaining.length) {
      const nextShare = poolTotal > 0
        ? (Number(remaining[pageSize].total) || 0) / poolTotal
        : 0
      if (nextShare < SMALLEST_NAMED_SLICE_MIN_SHARE) break
      pageSize++
    }
    if (remaining.length - pageSize === 1) pageSize = remaining.length
    pages.push({ start, end: start + pageSize })
    start += pageSize
  }
  return pages.length > 0 ? pages : [{ start: 0, end: 0 }]
}

function monthsInRange(startYM, endYM) {
  const months = []
  let [sy, sm] = startYM.split('-').map(Number)
  let [ey, em] = endYM.split('-').map(Number)
  while (sy < ey || (sy === ey && sm <= em)) {
    months.push(`${sy}-${String(sm).padStart(2, '0')}`)
    sm++; if (sm > 12) { sm = 1; sy++ }
  }
  return months
}

function periodLabel(p) {
  if (!p) return ''
  if (p.type === 'month')  return monthLabel(p.month)
  if (p.type === 'year') {
    // For the current year the period is YTD, so make the range explicit rather than
    // misleadingly showing just "2026" as if it covered the whole year.
    if (String(p.year) === thisY && thisM !== `${p.year}-12`) {
      return `${p.year} (${monthLabel(`${p.year}-01`)} – ${monthLabel(thisM)})`
    }
    return p.year
  }
  if (p.type === 'custom') return `${monthLabel(p.start)} – ${monthLabel(p.end)}`
  return ''
}

function monthsBetween(startYM, endYM) {
  const [sy, sm] = startYM.split('-').map(Number)
  const [ey, em] = endYM.split('-').map(Number)
  return (ey - sy) * 12 + (em - sm) + 1
}

function shiftMonth(ym, deltaMonths) {
  const [y, m] = ym.split('-').map(Number)
  const totalMonthIndex = (y * 12) + (m - 1) + deltaMonths
  const newY = Math.floor(totalMonthIndex / 12)
  const newM = (totalMonthIndex % 12) + 1
  return `${newY}-${String(newM).padStart(2, '0')}`
}

// Resolve any period type to its concrete inclusive month range. The "year" case caps the end
// at the current month when the year is the current year, so this-year-vs-last-year compares
// elapsed-YTD vs same-window-prior-year rather than a partial year vs a full prior year.
function periodMonthRange(p) {
  if (!p) return null
  if (p.type === 'month') return { start: p.month, end: p.month }
  if (p.type === 'year') {
    return {
      start: `${p.year}-01`,
      end: String(p.year) === thisY ? thisM : `${p.year}-12`,
    }
  }
  if (p.type === 'custom') return { start: p.start, end: p.end }
  return null
}

function periodMonths(p) {
  const range = periodMonthRange(p)
  if (!range) return []
  return monthsInRange(range.start, range.end)
}

// Compute the "B" period from A given a relative selection. All results are normalized to
// `type: 'custom'` (with explicit start/end months) so downstream code doesn't have to special-case
// derived periods, and so a year-typed A with YTD truncation propagates into B at the same length.
function derivePriorPeriod(periodA, priorKind) {
  const range = periodMonthRange(periodA)
  if (!range) return null
  const length = monthsBetween(range.start, range.end)
  if (priorKind === 'prior_month' || priorKind === 'prior_period') {
    // Same-length window ending the month immediately before A starts.
    const end = shiftMonth(range.start, -1)
    const start = shiftMonth(end, -(length - 1))
    return { type: 'custom', start, end }
  }
  if (priorKind === 'prior_year') {
    // Shift the whole range back by 12 months — preserves length, including YTD truncation.
    return {
      type: 'custom',
      start: shiftMonth(range.start, -12),
      end: shiftMonth(range.end, -12),
    }
  }
  return null
}

// Which "B" presets are sensible given A's shape. Picking a now-invalid mode is auto-corrected
// to this list's first entry whenever A's type changes.
function priorModeOptionsFor(periodA) {
  if (!periodA) return []
  if (periodA.type === 'month') return [
    { value: 'prior_month',  label: 'Prior month' },
    { value: 'prior_year',   label: 'Prior year'  },
    { value: 'custom',       label: 'Custom…'     },
  ]
  if (periodA.type === 'year') return [
    { value: 'prior_year',   label: 'Prior year'  },
    { value: 'custom',       label: 'Custom…'     },
  ]
  if (periodA.type === 'custom') return [
    { value: 'prior_period', label: 'Prior period' },
    { value: 'prior_year',   label: 'Prior year'   },
    { value: 'custom',       label: 'Custom…'      },
  ]
  return []
}

// Single-page bottom-chart trend: instead of fetching a fixed rolling window, bucket the
// historical timeline by the SELECTED period's length so the trend reads as "this kind of
// slice, over time." The selected period sits as one bar; we show a generous run of earlier
// buckets and a small lookahead so the user can see where they are. Returned bucket ranges
// are inclusive month codes ('YYYY-MM').
function computeTrendBuckets(periodDate, options = {}) {
  const earlierCount = options.earlierCount ?? 11
  const laterCount = options.laterCount ?? 3
  let anchorStart, bucketMonths
  if (periodDate?.start && periodDate?.end) {
    anchorStart = periodDate.start.slice(0, 7)
    // Bucket width tracks the selected period's *duration*, not how many calendar-month labels it
    // touches. Otherwise a ~30-day range straddling a month boundary (e.g. "Last 30 days") counts as
    // two months and inflates every bucket — and the displayed average — vs. an equivalent "Last month".
    const daySpan = Math.round((new Date(periodDate.end) - new Date(periodDate.start)) / 86400000) + 1
    bucketMonths = Math.max(1, Math.round(daySpan / 30.44))
  } else {
    anchorStart = thisM
    bucketMonths = 1
  }
  const anchorEnd = shiftMonth(anchorStart, bucketMonths - 1)
  const buckets = []
  for (let i = earlierCount; i >= 1; i--) {
    const start = shiftMonth(anchorStart, -i * bucketMonths)
    const end = shiftMonth(start, bucketMonths - 1)
    buckets.push({ start, end, isSelected: false })
  }
  buckets.push({ start: anchorStart, end: anchorEnd, isSelected: true })
  for (let i = 1; i <= laterCount; i++) {
    const start = shiftMonth(anchorStart, i * bucketMonths)
    const end = shiftMonth(start, bucketMonths - 1)
    buckets.push({ start, end, isSelected: false })
  }
  return { bucketMonths, buckets }
}

// Human label for one bucket. Single-month buckets just use the month name; full calendar
// years collapse to the year; everything else shows the inclusive month range.
function bucketLabel(b) {
  if (!b) return ''
  if (b.start === b.end) return monthLabel(b.start)
  if (b.start.slice(5) === '01' && b.end.slice(5) === '12' && b.start.slice(0, 4) === b.end.slice(0, 4)) {
    return b.start.slice(0, 4)
  }
  return `${monthLabel(b.start)} – ${monthLabel(b.end)}`
}

function lastDayOfMonthISO(ym) {
  const [y, m] = ym.split('-').map(Number)
  const last = new Date(y, m, 0).getDate()
  return `${ym}-${String(last).padStart(2, '0')}`
}

// All-time lower bound for the trend fetch when no date chip is set: passing an explicit (ancient)
// start makes the backend skip its rolling "last N months" window and return every month of data, so
// the trend matches the all-time totals shown above it rather than an empty current-month window.
const ALL_TIME_START = '1900-01-01'

// Below this many months of data, month/quarter/year bucketing is pointless (a year or so reads fine
// as monthly bars), so the grain selector stays hidden.
const TREND_GRAIN_SELECTOR_MIN_MONTHS = 18

// Inclusive count of calendar months the trend rows actually span (min..max). Drives whether the
// month/quarter/year grain selector is worth showing — it isn't for ~a year or less of data.
function monthSpanOfRows(rows) {
  const months = (rows || []).map(r => r.month).filter(Boolean)
  if (!months.length) return 0
  const min = months.reduce((a, b) => (a < b ? a : b))
  const max = months.reduce((a, b) => (a > b ? a : b))
  return monthsBetween(min, max)
}

// Continuous calendar-grain bucket list spanning the data the trend rows cover (min..max), gaps
// included so the x-axis stays uniform. Used for the no-date "all time" trend, where there's no
// selected period to size buckets against. `grain` is 'month' | 'quarter' | 'year'; quarter/year
// buckets snap to calendar boundaries so labels collapse cleanly (e.g. a Jan–Dec bucket reads "2016").
function calendarBucketsFromRows(rows, grain = 'month') {
  const months = (rows || []).map(r => r.month).filter(Boolean)
  if (!months.length) return [{ start: thisM, end: thisM, isSelected: false }]
  const min = months.reduce((a, b) => (a < b ? a : b))
  const max = months.reduce((a, b) => (a > b ? a : b))
  const size = grain === 'year' ? 12 : grain === 'quarter' ? 3 : 1
  // Snap the first bucket to its calendar boundary so quarters start at Jan/Apr/Jul/Oct and years at
  // January, regardless of which month the data happens to begin in.
  const [minY, minM] = min.split('-').map(Number)
  const startM = grain === 'year' ? 1 : minM - ((minM - 1) % size)
  let cursor = `${minY}-${String(startM).padStart(2, '0')}`
  const buckets = []
  while (cursor <= max) {
    buckets.push({ start: cursor, end: shiftMonth(cursor, size - 1), isSelected: false })
    cursor = shiftMonth(cursor, size)
  }
  return buckets
}

// Folds a flat array of `{ month, total }` rows (the existing monthly-trend response shape) into
// the supplied bucket list so the same backend endpoint serves any bucket size.
function aggregateMonthlyIntoBuckets(monthlyRows, buckets) {
  return buckets.map(b => ({
    bucketStart: b.start,
    bucketEnd: b.end,
    isSelected: b.isSelected,
    label: bucketLabel(b),
    // Carry the month key only when the bucket is a single month — the click-to-open behaviour
    // (which opens MonthDetail) is meaningless on multi-month buckets.
    singleMonth: b.start === b.end ? b.start : null,
    total: (monthlyRows || []).reduce(
      (sum, r) => (r.month >= b.start && r.month <= b.end ? sum + (Number(r.total) || 0) : sum),
      0,
    ),
  }))
}

// The bucket count (earlier + selected + later) is a MAX, not a target. If the user only has
// two years of data the leading buckets are zero-filled placeholders, which is visually noisy
// and makes the actual bars cramped against one edge. Trim leading and trailing zero buckets,
// keeping the selected bucket in place even when it itself happens to be empty.
function trimEmptyTrendBuckets(buckets) {
  if (!buckets.length) return buckets
  let firstKeep = -1
  let lastKeep = -1
  for (let i = 0; i < buckets.length; i++) {
    if (buckets[i].total !== 0 || buckets[i].isSelected) {
      if (firstKeep === -1) firstKeep = i
      lastKeep = i
    }
  }
  if (firstKeep === -1) return buckets
  return buckets.slice(firstKeep, lastKeep + 1)
}

// Multi-line tick used by the trend chart so labels like "Jun 2013 – Jun 2014" don't bleed
// into the bars on either side. Single-segment labels render normally; range labels split on
// the en dash and stack onto two lines so each line fits within the bar's column width.
function TrendBucketTick({ x, y, payload }) {
  const value = String(payload?.value ?? '')
  const parts = value.split(/\s*–\s*/)
  if (parts.length < 2) {
    return (
      <text x={x} y={y + 14} fill="var(--muted)" fontSize={11} textAnchor="middle">
        {value}
      </text>
    )
  }
  return (
    <text fill="var(--muted)" fontSize={11} textAnchor="middle">
      <tspan x={x} y={y + 12}>{parts[0]}</tspan>
      <tspan x={x} y={y + 26}>– {parts[1]}</tspan>
    </text>
  )
}

const now   = new Date()
const thisM = format(now, 'yyyy-MM')
const lastM = format(subMonths(now, 1), 'yyyy-MM')
const thisY = String(now.getFullYear())
const lastY = String(now.getFullYear() - 1)

const PRESET_OPTIONS = [
  { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: 'this_year',  label: 'This year'  },
  { value: 'last_year',  label: 'Last year'  },
  { value: 'custom',     label: 'Custom…'    },
]

function presetToPeriod(preset) {
  if (preset === 'this_month') return { type: 'month', month: thisM }
  if (preset === 'last_month') return { type: 'month', month: lastM }
  if (preset === 'this_year')  return { type: 'year',  year: thisY  }
  if (preset === 'last_year')  return { type: 'year',  year: lastY  }
  return null
}

const RECENT_MONTHS = lastNMonths(24).map(m => ({ value: m, label: monthLabel(m) }))

async function fetchPeriodGroupTotals(period, accountId, tagIds, ownerIds, filters) {
  const months = periodMonths(period)
  const results = await Promise.all(
    months.map(m => api.getGroupTotals(m, accountId || undefined, undefined, undefined, ownerIds, undefined, tagIds, filters))
  )
  const merged = {}
  for (const monthRows of results) {
    for (const row of monthRows) {
      if (!merged[row.group_id]) {
        merged[row.group_id] = { ...row, total: 0, count: 0 }
      }
      merged[row.group_id].total += row.total
      merged[row.group_id].count += row.count
    }
  }
  return Object.values(merged)
    .filter(r => r.category_type !== 'income')
    .sort((a, b) => b.total - a.total)
}

async function fetchPeriodCatTotals(period, groupId, accountId, tagIds, ownerIds, filters) {
  const months = periodMonths(period)
  const results = await Promise.all(
    months.map(m => api.getCategoryTotalsInGroup(m, groupId, accountId || undefined, undefined, undefined, ownerIds, tagIds, filters))
  )
  const merged = {}
  for (const monthRows of results) {
    for (const row of monthRows) {
      if (!merged[row.category_id]) {
        merged[row.category_id] = { ...row, total: 0, count: 0 }
      }
      merged[row.category_id].total += row.total
      merged[row.category_id].count += row.count
    }
  }
  return Object.values(merged).sort((a, b) => b.total - a.total)
}

function SpendBar({ value, total, color }) {
  const pct = total > 0 ? Math.min((value / total) * 100, 100) : 0
  return (
    <div style={{ flex: 1, height: 6, background: 'var(--surface2)', borderRadius: 3, overflow: 'hidden' }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 3, transition: 'width 0.3s' }} />
    </div>
  )
}

// X-axis month tick that staggers every other label onto a second row — with a short connector line so
// it's clear which bar it belongs to — once there are enough months that a single row would collide.
// Keeps every month labeled and legible without rotating or dropping labels.
function StaggeredMonthTick({ x, y, payload, index, visibleTicksCount }) {
  const stagger = (visibleTicksCount ?? 0) > 8
  const lower = stagger && index % 2 === 1
  return (
    <g>
      {lower ? <line x1={x} y1={y} x2={x} y2={y + 11} stroke="var(--border)" /> : null}
      <text x={x} y={y + (lower ? 21 : 10)} textAnchor="middle" fontSize={10} fill="var(--muted)">
        {payload?.value}
      </text>
    </g>
  )
}

// Reference-line label for the average line on the trend charts: a single "Avg $X" pill that sits on
// the line just inside the plot area. Keeping the value inside the pill (rather than in the y-axis tick
// column) means it can't collide with a real axis tick when the average happens to land near one.
function AvgReferenceLabel({ viewBox, value, align = 'left' }) {
  if (!viewBox) return null
  const labelY = viewBox.y ?? 0
  const innerX = viewBox.x ?? 0
  const innerW = viewBox.width ?? 0
  const text = `Avg ${formatSignedAxisTick(value)}`
  const pillH = 15
  // Approximate the rendered text width (no measurement API in SVG here) so the pill hugs the label.
  const pillW = Math.round(text.length * 5.4 + 12)
  // `align='right'` hugs the right edge of the plot area — used by the horizontally-scrolling annual
  // chart so the pill (and the right-side axis) stay visible in its default right-pinned view.
  const pillX = align === 'right' ? (innerX + innerW - pillW - 2) : (innerX + 2)
  return (
    <g style={{ pointerEvents: 'none' }}>
      <rect
        x={pillX}
        y={labelY - pillH / 2}
        width={pillW}
        height={pillH}
        rx={3}
        fill="var(--accent2)"
        opacity={0.92}
      />
      <text
        x={pillX + pillW / 2}
        y={labelY + 3.5}
        fontSize={10}
        fontWeight={600}
        fill="#fff"
        textAnchor="middle"
      >
        {text}
      </text>
    </g>
  )
}

// Annual totals can span many years. Each bar keeps a fixed width and the row scrolls horizontally
// (with the app's styled scrollbar) once the bars exceed the card — so the card width is the natural
// cap rather than squashing every year in. Start the scroll at the right edge so the most recent
// years are in view and older ones are a scroll to the left; re-pin to the right whenever the data
// changes (e.g. switching spending/income or drilling a group).
function AnnualTotalsChart({ data, avg, selectedYear, onSelectYear }) {
  const scrollRef = useRef(null)
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [data])
  // Clicking a year's bar focuses the monthly charts on that year (drives the year picker). The active
  // year's bar is highlighted so it's clear which one the charts above are showing.
  const selectable = typeof onSelectYear === 'function'
  return (
    <div ref={scrollRef} style={{ overflowX: 'auto', overflowY: 'hidden' }}>
      <div style={{ minWidth: Math.max(260, data.length * 46), height: 180 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="year" tick={{ fill: 'var(--muted)', fontSize: 11 }} interval={0} />
            {/* Axis on the RIGHT so the $ scale stays visible in the default right-pinned (recent-years)
                view; with a left axis it scrolls off-screen until the user drags back to the start. */}
            <YAxis orientation="right" tickFormatter={v => `$${(v/1000).toFixed(0)}k`} tick={{ fill: 'var(--muted)', fontSize: 11 }} />
            <Tooltip
              formatter={v => formatCurrency(v)}
              contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
              labelStyle={CHART_TOOLTIP_LABEL_STYLE}
              itemStyle={CHART_TOOLTIP_ITEM_STYLE}
            />
            <Bar
              dataKey="total"
              radius={[3,3,0,0]}
              name="Total"
              onClick={selectable ? (d => d?.year && onSelectYear(d.year)) : undefined}
              style={selectable ? { cursor: 'pointer' } : undefined}
            >
              {data.map(d => (
                <Cell
                  key={d.year}
                  fill={String(d.year) === String(selectedYear) ? 'var(--accent2)' : 'var(--accent)'}
                />
              ))}
            </Bar>
            {data.length > 1 && (
              <ReferenceLine
                y={avg}
                stroke="var(--accent2)"
                strokeDasharray="4 4"
                label={<AvgReferenceLabel value={avg} align="right" />}
              />
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function Breadcrumb({ items, onNavigate }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, marginBottom: 16 }}>
      {items.map((item, i) => (
        <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {i > 0 && <span style={{ color: 'var(--muted)' }}>›</span>}
          {i < items.length - 1 ? (
            <button onClick={() => onNavigate(i)} style={{
              background: 'none', border: 'none', color: 'var(--accent2)',
              cursor: 'pointer', fontSize: 13, padding: 0,
            }}>{item}</button>
          ) : (
            <span style={{ color: 'var(--text)', fontWeight: 500 }}>{item}</span>
          )}
        </span>
      ))}
      </div>
  )
}

/*
 * Modal that lets the user pick a set of tags to drive a tag-breakdown report on the
 * dashboard. Selection is unordered (overlap is handled by combination wedges in the
 * renderer, not by priority). The user can either display the report as a transient
 * preset (gone when they switch to anything else) or name and save it for reuse via
 * the Spending-by picker.
 */
function TagReportBuilder({ availableTags, onClose, onDisplay, onSave }) {
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [name, setName] = useState('')
  const [savePromptOpen, setSavePromptOpen] = useState(false)
  const trimmedName = name.trim()
  const hasSelection = selectedIds.size > 0

  function toggleTag(id) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function handleDisplay() {
    if (!hasSelection) return
    onDisplay(Array.from(selectedIds))
    onClose()
  }

  function handleSaveAndDisplay() {
    if (!hasSelection) return
    setSavePromptOpen(true)
  }

  function handleConfirmSave() {
    const cleaned = trimmedName
    if (!cleaned || !hasSelection) return
    onSave({ name: cleaned, tagIds: Array.from(selectedIds) })
    onClose()
  }

  const sortedTags = [...availableTags].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))

  return (
    <>
      <AppDialog
        title="New tag report"
        description="Pick the tags you want as wedges. Transactions matching multiple selected tags get their own combination wedge; everything else falls into Other / Untagged."
        width="min(480px, 100%)"
        onClose={onClose}
        actions={
          <>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="ghost" onClick={handleDisplay} disabled={!hasSelection}>Display</Button>
            <Button onClick={handleSaveAndDisplay} disabled={!hasSelection}>Save &amp; display</Button>
          </>
        }
      >
        {sortedTags.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--muted)', padding: '8px 0' }}>
            No tags defined yet. Add tags from the Transactions page (or via a rule) before building a tag report.
          </div>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 6,
            maxHeight: '50vh',
            overflowY: 'auto',
          }}>
            {sortedTags.map(tag => {
              const checked = selectedIds.has(tag.id)
              return (
                <label
                  key={tag.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '6px 10px', borderRadius: 8, cursor: 'pointer',
                    background: checked ? 'color-mix(in srgb, var(--accent) 12%, var(--surface2))' : 'var(--surface2)',
                    border: `1px solid ${checked ? 'color-mix(in srgb, var(--accent) 32%, var(--border))' : 'var(--border)'}`,
                    fontSize: 13,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleTag(tag.id)}
                    style={{ cursor: 'pointer' }}
                  />
                  <TagGlyph color={tag.color} size={12} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tag.name}</span>
                </label>
              )
            })}
          </div>
        )}
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          {selectedIds.size === 0 ? 'No tags selected.' : `${selectedIds.size} selected.`}
        </div>
      </AppDialog>
      {savePromptOpen && (
        <AppDialog
          title="Save tag report"
          description="The name will appear in the Spending-by picker."
          width="min(380px, 100%)"
          zIndex={1300}
          onClose={() => setSavePromptOpen(false)}
          actions={
            <>
              <Button variant="ghost" onClick={() => setSavePromptOpen(false)}>Cancel</Button>
              <Button onClick={handleConfirmSave} disabled={!trimmedName}>Save</Button>
            </>
          }
        >
          <Input
            value={name}
            onChange={setName}
            placeholder="e.g. Essentials, Per-owner"
            aria-label="Tag report name"
          />
        </AppDialog>
      )}
    </>
  )
}

/*
 * Bottom-right toast notifying the user that a saved tag report references tag IDs
 * that no longer exist. Auto-fades after a few seconds; the explicit "Don't remind
 * me again" button persists `dismissedMissingWarning: true` on the report.
 */
function MissingTagsToast({ reportName, onDismiss, onSuppress }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 6000)
    return () => clearTimeout(t)
  }, [onDismiss])

  return (
    <div style={{
      position: 'fixed', bottom: 24, right: 24, zIndex: 1500,
      maxWidth: 360, minWidth: 280,
      background: 'var(--surface)',
      border: '1px solid color-mix(in srgb, var(--accent2) 28%, var(--border))',
      borderRadius: 10,
      padding: '12px 14px 10px',
      boxShadow: '0 18px 44px rgba(15, 23, 42, 0.32)',
    }}>
      <button
        onClick={onDismiss}
        title="Dismiss"
        style={{
          position: 'absolute', top: 6, right: 8,
          background: 'none', border: 'none',
          color: 'var(--muted)', cursor: 'pointer',
          fontSize: 18, lineHeight: 1, padding: 2,
        }}
      >×</button>
      <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.45, marginBottom: 8, paddingRight: 14 }}>
        Some tags in <strong>{reportName}</strong> no longer exist and have been ignored. Open the builder to rebuild the report deliberately.
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          onClick={onSuppress}
          style={{
            background: 'none', border: 'none', padding: '4px 6px',
            color: 'var(--accent2)', cursor: 'pointer', fontSize: 12,
          }}
        >
          Don&apos;t remind me again
        </button>
      </div>
    </div>
  )
}

/*
 * Tiny popover menu shown next to the picker when a saved tag report is the active
 * option. Offers Rename and Delete; opening it via right-click on the picker uses
 * the same component. Dismissed on outside click or Escape.
 */
function PickerManageMenu({ anchorRect, onRename, onDelete, onClose }) {
  const ref = useRef(null)

  useEffect(() => {
    function onDocMouseDown(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    function onKeyDown(e) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  if (!anchorRect) return null
  const top = anchorRect.bottom + 4
  const left = anchorRect.left
  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        top, left, zIndex: 1400,
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 4,
        minWidth: 140,
        boxShadow: '0 12px 36px rgba(15, 23, 42, 0.32)',
      }}
    >
      {[
        { label: 'Rename', onClick: onRename },
        { label: 'Delete', onClick: onDelete, danger: true },
      ].map(item => (
        <button
          key={item.label}
          onClick={() => { item.onClick(); onClose() }}
          style={{
            display: 'block', width: '100%', textAlign: 'left',
            background: 'none', border: 'none', padding: '6px 10px',
            cursor: 'pointer', borderRadius: 6, fontSize: 13,
            color: item.danger ? 'var(--danger)' : 'var(--text)',
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

/*
 * Small modal that prompts for a new name. Wraps AppDialog so dismiss/cancel/save
 * behaviors match the rest of the app.
 */
function RenameTagReportDialog({ initialName, onCancel, onSave }) {
  const [name, setName] = useState(initialName || '')
  const trimmed = name.trim()
  return (
    <AppDialog
      title="Rename tag report"
      width="min(380px, 100%)"
      onClose={onCancel}
      actions={
        <>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button onClick={() => onSave(trimmed)} disabled={!trimmed || trimmed === initialName}>Save</Button>
        </>
      }
    >
      <Input value={name} onChange={setName} placeholder="Report name" aria-label="Tag report name" />
    </AppDialog>
  )
}

function PeriodPicker({ label, onChange }) {
  const [preset, setPreset] = useState('this_month')
  const [customStart, setCustomStart] = useState(lastM)
  const [customEnd,   setCustomEnd]   = useState(thisM)

  function applyPreset(p) {
    setPreset(p)
    if (p !== 'custom') onChange(presetToPeriod(p))
  }

  function applyCustom() {
    if (customStart && customEnd) {
      const start = customStart < customEnd ? customStart : customEnd
      const end   = customStart < customEnd ? customEnd   : customStart
      onChange({ type: 'custom', start, end })
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 200 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </div>
      <select
        value={preset}
        onChange={e => applyPreset(e.target.value)}
        style={{
          background: 'var(--surface2)', color: 'var(--text)',
          border: '1px solid var(--border)', borderRadius: 8,
          padding: '7px 10px', fontSize: 13, cursor: 'pointer',
        }}
      >
        {PRESET_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {preset === 'custom' && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <select
            value={customStart}
            onChange={e => setCustomStart(e.target.value)}
            style={{
              flex: 1, background: 'var(--surface2)', color: 'var(--text)',
              border: '1px solid var(--border)', borderRadius: 6,
              padding: '5px 8px', fontSize: 12, cursor: 'pointer',
            }}
          >
            {RECENT_MONTHS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>to</span>
          <select
            value={customEnd}
            onChange={e => setCustomEnd(e.target.value)}
            style={{
              flex: 1, background: 'var(--surface2)', color: 'var(--text)',
              border: '1px solid var(--border)', borderRadius: 6,
              padding: '5px 8px', fontSize: 12, cursor: 'pointer',
            }}
          >
            {RECENT_MONTHS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <button
            onClick={applyCustom}
            style={{
              background: 'var(--accent)', color: '#fff', border: 'none',
              borderRadius: 6, padding: '5px 10px', fontSize: 12, cursor: 'pointer',
            }}
          >Go</button>
        </div>
      )}
      </div>
  )
}

// The B-side picker for Compare. Its options are always "relative to A" — there's no concept
// of "this month/year" here, because B is meaningful only as something to compare against A.
// The shown choices and the resolved period both depend on A's shape, so the picker is
// controlled by the parent (mode + custom-range + setters) and stays in sync via effects there.
function PriorPeriodPicker({ label, aPeriod, mode, customStart, customEnd, onModeChange, onCustomStartChange, onCustomEndChange, onCustomApply }) {
  const options = priorModeOptionsFor(aPeriod)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 200 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </div>
      <select
        value={mode}
        onChange={e => onModeChange(e.target.value)}
        style={{
          background: 'var(--surface2)', color: 'var(--text)',
          border: '1px solid var(--border)', borderRadius: 8,
          padding: '7px 10px', fontSize: 13, cursor: 'pointer',
        }}
      >
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {mode === 'custom' && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <select
            value={customStart}
            onChange={e => onCustomStartChange(e.target.value)}
            style={{
              flex: 1, background: 'var(--surface2)', color: 'var(--text)',
              border: '1px solid var(--border)', borderRadius: 6,
              padding: '5px 8px', fontSize: 12, cursor: 'pointer',
            }}
          >
            {RECENT_MONTHS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>to</span>
          <select
            value={customEnd}
            onChange={e => onCustomEndChange(e.target.value)}
            style={{
              flex: 1, background: 'var(--surface2)', color: 'var(--text)',
              border: '1px solid var(--border)', borderRadius: 6,
              padding: '5px 8px', fontSize: 12, cursor: 'pointer',
            }}
          >
            {RECENT_MONTHS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <button
            onClick={onCustomApply}
            style={{
              background: 'var(--accent)', color: '#fff', border: 'none',
              borderRadius: 6, padding: '5px 10px', fontSize: 12, cursor: 'pointer',
            }}
          >Go</button>
        </div>
      )}
    </div>
  )
}


// Gray is reserved for the synthetic Other slice, so the palette deliberately
// avoids slate / neutral grays that would clash next to Other in the pie.
const CHART_PALETTE = [
  '#6366f1','#ec4899','#f97316','#eab308','#22c55e',
  '#14b8a6','#3b82f6','#a855f7','#ef4444','#d946ef',
  '#fb923c','#84cc16','#06b6d4','#8b5cf6','#f43f5e',
  '#10b981','#f59e0b','#0ea5e9','#e11d48','#0891b2',
]

function assignColors(rows, colorKey) {
  return rows.map((r, i) => ({
    ...r,
    [colorKey]: CHART_PALETTE[i % CHART_PALETTE.length],
    _chartColor: CHART_PALETTE[i % CHART_PALETTE.length],
  }))
}

function CompareRow({ label, color, kind = 'category', a, b, maxVal, onClick }) {
  const diff    = a - b
  const diffPct = b > 0 ? ((a - b) / b) * 100 : null
  return (
    <div
      onClick={onClick}
      style={{
        padding: '9px 0', borderBottom: '1px solid var(--border)',
        cursor: onClick ? 'pointer' : 'default',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
        <span style={{ fontSize: 13, flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
          <CategoryMarker kind={kind} />
          <span>{label}</span>
        </span>
        {diffPct !== null && (
          <span style={{
            fontSize: 11, fontWeight: 600, padding: '1px 6px', borderRadius: 99,
            background: diff > 0 ? 'color-mix(in srgb, var(--danger) 13%, transparent)' : 'color-mix(in srgb, var(--success) 13%, transparent)',
            color: diff > 0 ? 'var(--danger)' : 'var(--success)',
          }}>
            {diff > 0 ? '▲' : '▼'} {Math.abs(diffPct).toFixed(0)}%
          </span>
        )}
        {onClick && <span style={{ color: 'var(--muted)', fontSize: 14 }}>›</span>}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{ height: 5, background: 'var(--surface2)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ width: `${maxVal > 0 ? (a / maxVal) * 100 : 0}%`, height: '100%', background: color, opacity: 1, borderRadius: 3 }} />
          </div>
          <div style={{ height: 5, background: 'var(--surface2)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ width: `${maxVal > 0 ? (b / maxVal) * 100 : 0}%`, height: '100%', background: color, opacity: 0.35, borderRadius: 3 }} />
          </div>
        </div>
        <div style={{ textAlign: 'right', minWidth: 120 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{formatCurrency(a)}</span>
          <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 6 }}>vs {formatCurrency(b)}</span>
        </div>
      </div>
      </div>
  )
}


// Clickable column header. Two visual states: active (renders the current sort indicator) and
// inactive (renders a faint chevron so the header still reads as sortable). The "% of total"
// column reuses the total sort key on purpose — pct is total/grandTotal, so they share an order.
function SortHeader({ label, sortKey, activeKey, activeDir, onSort, align = 'left' }) {
  const active = activeKey === sortKey
  const arrow = active ? (activeDir === 'asc' ? '↑' : '↓') : '↕'
  return (
    <span
      onClick={() => onSort(sortKey)}
      style={{
        textAlign: align,
        cursor: 'pointer',
        userSelect: 'none',
        color: active ? 'var(--text)' : 'var(--muted)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
      }}
    >
      {label}
      <span style={{ fontSize: 10, opacity: active ? 1 : 0.4 }}>{arrow}</span>
    </span>
  )
}

function TrendsPanel({ rows, groups, selectedYear, onYearChange, drillGroup, onDrillGroup, onClearDrill, loading, viewIsIncome, onOpenMonth, onOpenSinglePeriod }) {
  const lastBarClickRef = useRef({ key: null, time: 0 })
  const lastAreaClickRef = useRef({ idx: -1, time: 0 })
  // Sort state for the "Monthly averages by group" report at the bottom. Defaults to total
  // descending to match the natural "biggest-first" reading users expect from a spending list.
  const [sortKey, setSortKey] = useState('total')
  const [sortDir, setSortDir] = useState('desc')

  // Draggable divider between "Total per month" (left) and "Annual totals" (right): a persisted
  // left-panel width fraction. The continuous drag goes through useDeferredPreference so it only
  // persists once on mouse-up (setPreference writes on every call); we wire the cursor→fraction math
  // and the window listeners here.
  const clampSplit = useCallback(
    frac => Math.min(TRENDS_SPLIT_MAX, Math.max(TRENDS_SPLIT_MIN, Number(Number(frac).toFixed(4)))),
    [],
  )
  const { value: splitValue, dragging: draggingSplit, setLive: setSplitLive, commit: commitSplit, reset: resetSplit } =
    useDeferredPreference(DASHBOARD_TRENDS_SPLIT_PREF_KEY, TRENDS_SPLIT_DEFAULT)
  const splitRowRef = useRef(null)
  useEffect(() => {
    if (!draggingSplit) return undefined
    const onMove = event => {
      const el = splitRowRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      if (rect.width <= 0) return
      setSplitLive(clampSplit((event.clientX - rect.left) / rect.width))
    }
    const onUp = () => commitSplit()
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    const priorUserSelect = document.body.style.userSelect
    document.body.style.userSelect = 'none'  // suppress text selection while dragging
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = priorUserSelect
    }
  }, [draggingSplit, setSplitLive, commitSplit, clampSplit])
  const leftFr = clampSplit(Number(splitValue) || TRENDS_SPLIT_DEFAULT)

  function applySort(key) {
    if (key === sortKey) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      // Name is the only column where ascending is the natural default — every numeric column
      // wants biggest-first on its first click.
      setSortDir(key === 'name' ? 'asc' : 'desc')
    }
  }
  if (loading) return <Spinner />

  const normalizedRows = rows.filter(r =>
    typeof r?.month === 'string' &&
    /^\d{4}-\d{2}$/.test(r.month)
  )

  // 'last12' = the trailing 12 calendar months ending this month (the rolling default); otherwise a
  // specific calendar year. The multi-year picture lives in the Annual totals chart, so there's no
  // unbounded "all time" option here to compress the monthly bars.
  const last12Start = shiftMonth(thisM, -11)
  // Resolve the effective window: an explicit dropdown pick (`selectedYear`) always wins; with no pick
  // (`null` = auto) default to last-12-months when that window actually has data, otherwise fall back
  // to the most recent year present so stale/imported data doesn't render a blank trend.
  const dataYears = [...new Set(normalizedRows.map(r => r.month.slice(0, 4)))].sort()
  const last12HasData = normalizedRows.some(r => r.month >= last12Start && r.month <= thisM)
  const effectiveYear = selectedYear
    ?? (last12HasData || dataYears.length === 0 ? 'last12' : dataYears[dataYears.length - 1])
  const filteredRows = effectiveYear === 'last12'
    ? normalizedRows.filter(r => r.month >= last12Start && r.month <= thisM)
    : normalizedRows.filter(r => r.month.startsWith(effectiveYear))

  const allMonths = [...new Set(filteredRows.map(r => r.month))].sort()

  const seriesMap = {}
  for (const r of filteredRows) {
    if (!seriesMap[r.series_id]) {
      seriesMap[r.series_id] = { id: r.series_id, name: r.series_name, color: r.series_color, category_type: r.series_category_type }
    }
  }
  // The backend currently returns NULL for series_color, so the AreaChart was rendering all series
  // with Recharts defaults (transparent/black) on top of each other. Assign palette colors here so
  // each group reads as its own band.
  // Pick income or expense series based on the current view so the trend reads as just one side
  // of the ledger at a time — mirroring the spending/income toggle the single-period view uses.
  const targetType = viewIsIncome ? 'income' : 'expense'
  const series = assignColors(
    Object.values(seriesMap).filter(s => (s.category_type || 'expense') === targetType),
    'color',
  )
  const viewSeriesIds = new Set(series.map(s => s.id))
  const viewRows = filteredRows.filter(r => viewSeriesIds.has(r.series_id))

  const chartData = allMonths.map(m => {
    const entry = { month: monthLabel(m), monthKey: m }
    for (const s of series) {
      const row = filteredRows.find(r => r.month === m && r.series_id === s.id)
      entry[s.id] = row ? row.total : 0
    }
    return entry
  })

  const avgBySeries = series.map(s => {
    const totals = allMonths.map(m => {
      const r = filteredRows.find(x => x.month === m && x.series_id === s.id)
      return r ? r.total : 0
    })
    const avg = totals.reduce((a, b) => a + b, 0) / (totals.length || 1)
    const total = totals.reduce((a, b) => a + b, 0)
    return { ...s, avg, total }
  }).sort((a, b) => b.total - a.total)

  // Annual totals always cover every year in the dataset, independent of the Year dropdown
  // up top. Drilling into one year shouldn't collapse this chart down to a single bar.
  const allViewRows = normalizedRows.filter(r => viewSeriesIds.has(r.series_id))
  const yearMap = {}
  for (const r of allViewRows) {
    const yr = r.month.slice(0, 4)
    yearMap[yr] = (yearMap[yr] || 0) + r.total
  }
  const annualData = Object.entries(yearMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([year, total]) => ({ year, total }))
  const annualAvg = annualData.reduce((s, r) => s + r.total, 0) / (annualData.length || 1)

  // Trailing-12-month run rate per month, computed over the *full* view series (not the year-filtered
  // view), so the line for the first on-screen month can reach back into prior, off-screen months. A
  // 12-month window counts each annual bill once, quarterly four times, etc. — the amortized monthly
  // burn — so it reads as the spending trend rather than the lumpy month-to-month total.
  const fullMonthlyMap = {}
  for (const r of allViewRows) fullMonthlyMap[r.month] = (fullMonthlyMap[r.month] || 0) + r.total
  const dataStartMonth = allViewRows.reduce((min, r) => (min === null || r.month < min ? r.month : min), null)

  const monthlyTotal = allMonths.map(m => {
    let runRate = null
    // Only defined where a full year of preceding data exists, so an incomplete window can't understate it.
    if (dataStartMonth && shiftMonth(m, -11) >= dataStartMonth) {
      let sum = 0
      for (let i = 0; i < 12; i++) sum += fullMonthlyMap[shiftMonth(m, -i)] || 0
      runRate = sum / 12
    }
    return {
      month: monthLabel(m),
      monthKey: m,
      total: viewRows.filter(r => r.month === m).reduce((s, r) => s + r.total, 0),
      runRate,
    }
  })
  const overallAvg = monthlyTotal.reduce((s, r) => s + r.total, 0) / (monthlyTotal.length || 1)
  const latestRunRate = [...monthlyTotal].reverse().find(r => r.runRate != null)?.runRate ?? null

  function handleMonthBarClick(d) {
    if (!d?.monthKey || !onOpenMonth) return
    // Recharts doesn't surface a dblclick event on Bar, so detect it manually with a short window
    // between two single clicks on the same month.
    const now = Date.now()
    const prev = lastBarClickRef.current
    if (prev.key === d.monthKey && now - prev.time < 400) {
      lastBarClickRef.current = { key: null, time: 0 }
      onOpenMonth(d.monthKey)
    } else {
      lastBarClickRef.current = { key: d.monthKey, time: now }
    }
  }

  // Same double-click trick on the top area chart, where Recharts gives us an
  // `activeTooltipIndex` we can use to map back to the month under the cursor.
  function handleAreaClick(state) {
    if (!state || typeof state.activeTooltipIndex !== 'number' || !onOpenSinglePeriod) return
    const idx = state.activeTooltipIndex
    const monthKey = chartData[idx]?.monthKey
    if (!monthKey) return
    const now = Date.now()
    const prev = lastAreaClickRef.current
    if (prev.idx === idx && now - prev.time < 400) {
      lastAreaClickRef.current = { idx: -1, time: 0 }
      onOpenSinglePeriod(monthKey)
    } else {
      lastAreaClickRef.current = { idx, time: now }
    }
  }

  const availableYears = [...new Set(normalizedRows.map(r => r.month.slice(0, 4)))].sort().reverse()
  const yearOptions = [
    { value: 'last12', label: 'Last 12 months' },
    ...availableYears.map(y => ({ value: y, label: y })),
  ]

  const groupOptions = [
    { value: '', label: 'All groups' },
    ...groups.map(g => ({ value: g.group_id, label: g.group_name })),
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          value={effectiveYear}
          onChange={e => onYearChange(e.target.value)}
          style={{
            background: 'var(--surface2)', color: 'var(--text)',
            border: '1px solid var(--border)', borderRadius: 8,
            padding: '7px 10px', fontSize: 13, cursor: 'pointer',
          }}
        >
          {yearOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select
          value={drillGroup?.series_id || ''}
          onChange={e => {
            if (!e.target.value) { onClearDrill(); return }
            const g = groups.find(x => x.group_id === e.target.value)
            if (g) onDrillGroup({ series_id: g.group_id, series_name: g.group_name, series_color: g.group_color })
          }}
          style={{
            background: 'var(--surface2)', color: 'var(--text)',
            border: '1px solid var(--border)', borderRadius: 8,
            padding: '7px 10px', fontSize: 13, cursor: 'pointer',
          }}
        >
          {groupOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {drillGroup && (
          <span style={{ fontSize: 13, color: 'var(--muted)' }}>
            Showing: {drillGroup.series_name}
          </span>
        )}
      </div>

      {/* Lift the top chart's stacking context above the smaller charts beneath it so the hover
          tooltip — which Recharts paints inside this Card — doesn't get covered by sibling SVG
          bars when it extends past the Card's bottom edge. */}
      <Card style={{ position: 'relative', zIndex: 3 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
          {viewIsIncome ? 'Monthly income' : 'Monthly spending'}{drillGroup ? ` · ${drillGroup.series_name}` : ' by group'}
        </div>
        {onOpenSinglePeriod ? (
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
            Double-click a month to open the single-period view for that month.
          </div>
        ) : null}
        {allMonths.length === 0 ? (
          <EmptyState message="No trend data for this selection" />
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart
              data={chartData}
              onClick={onOpenSinglePeriod ? handleAreaClick : undefined}
              style={onOpenSinglePeriod ? { cursor: 'pointer' } : undefined}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="month" tick={{ fill: 'var(--muted)', fontSize: 10 }}
                interval={Math.floor(allMonths.length / 8)} />
              <YAxis tickFormatter={v => `$${(v/1000).toFixed(0)}k`} tick={{ fill: 'var(--muted)', fontSize: 11 }} />
              <Tooltip
                formatter={(v, name) => {
                  const s = series.find(x => x.id === name)
                  return [formatCurrency(v), s ? s.name : name]
                }}
                offset={20}
                contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
                labelStyle={CHART_TOOLTIP_LABEL_STYLE}
                itemStyle={CHART_TOOLTIP_ITEM_STYLE}
              />
              {series.map(s => (
                <Area key={s.id} type="monotone" dataKey={s.id}
                  stroke={s.color} fill={s.color} fillOpacity={0.15}
                  strokeWidth={1.5} stackId="1" name={s.id} />
              ))}
              <ReferenceLine
                y={overallAvg}
                stroke="var(--accent2)"
                strokeDasharray="4 4"
                label={<AvgReferenceLabel value={overallAvg} />}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </Card>

      <div ref={splitRowRef} style={{ display: 'grid', gridTemplateColumns: `${leftFr}fr 16px ${1 - leftFr}fr`, position: 'relative', zIndex: 1, minWidth: 0 }}>
        <Card style={{ position: 'relative', zIndex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Total per month</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
            {latestRunRate != null
              ? <>12-mo run rate: <span style={{ color: 'var(--accent2)', fontWeight: 600 }}>{formatCurrency(latestRunRate)}/mo</span></>
              : <>Avg: {formatCurrency(overallAvg)}/mo</>}
            {' · double-click a bar to open that month'}
          </div>
          {/* Fit the panel (no oversized horizontal scroll) so the tooltip's built-in edge-flip happens at
              the visible panel edge instead of the off-screen far edge of a wider chart. */}
          <div style={{ width: '100%', height: 180 }}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={monthlyTotal} margin={{ top: 6, right: 12, bottom: 6, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis
                    dataKey="month"
                    interval={0}
                    tickLine={false}
                    height={monthlyTotal.length > 8 ? 40 : 22}
                    tick={<StaggeredMonthTick />}
                  />
                  <YAxis tickFormatter={v => `$${(v/1000).toFixed(0)}k`} tick={{ fill: 'var(--muted)', fontSize: 10 }} />
                  <Tooltip
                    formatter={v => formatCurrency(v)}
                    allowEscapeViewBox={{ x: false, y: false }}
                    contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
                    labelStyle={CHART_TOOLTIP_LABEL_STYLE}
                    itemStyle={CHART_TOOLTIP_ITEM_STYLE}
                  />
                  <Bar
                    dataKey="total"
                    fill="var(--accent)"
                    radius={[3,3,0,0]}
                    name="Total"
                    onClick={onOpenMonth ? handleMonthBarClick : undefined}
                    style={onOpenMonth ? { cursor: 'pointer' } : undefined}
                  />
                  {/* Trailing-12-month run rate — the trend line; flat-ish means steady spending, sloped means drifting. */}
                  <Line
                    type="monotone"
                    dataKey="runRate"
                    name="12-mo run rate"
                    stroke="var(--accent2)"
                    strokeWidth={2}
                    dot={false}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
          </div>
        </Card>

        <div
          role="separator"
          aria-orientation="vertical"
          title="Drag to resize · double-click to reset"
          onMouseDown={event => { event.preventDefault(); setSplitLive(leftFr) }}
          onDoubleClick={resetSplit}
          style={{ cursor: 'col-resize', display: 'flex', alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch' }}
        >
          <div style={{
            width: 4, height: 44, borderRadius: 3,
            background: draggingSplit ? 'var(--accent)' : 'var(--border)',
            transition: 'background 0.15s',
          }} />
        </div>

        <Card style={{ position: 'relative', zIndex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{viewIsIncome ? 'Annual income totals' : 'Annual totals'}</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>Click a year to focus the charts above on it</div>
          {annualData.length === 0 ? (
            <EmptyState message="Not enough data" />
          ) : (
            <AnnualTotalsChart data={annualData} avg={annualAvg} selectedYear={effectiveYear} onSelectYear={onYearChange} />
          )}
        </Card>
      </div>

      <Card style={{ position: 'relative', zIndex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>
          Monthly averages{drillGroup ? ` · ${drillGroup.series_name}` : ' by group'}
          <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 8 }}>{effectiveYear === 'last12' ? 'last 12 months' : effectiveYear}</span>
        </div>
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 100px 100px 100px',
          padding: '4px 12px', fontSize: 11, fontWeight: 600,
          color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em',
          borderBottom: '1px solid var(--border)',
        }}>
          <SortHeader label={drillGroup ? 'Category' : 'Group'} sortKey="name"
            activeKey={sortKey} activeDir={sortDir} onSort={applySort} />
          <SortHeader label="Avg/mo" sortKey="avg" align="right"
            activeKey={sortKey} activeDir={sortDir} onSort={applySort} />
          <SortHeader label="Total" sortKey="total" align="right"
            activeKey={sortKey} activeDir={sortDir} onSort={applySort} />
          <SortHeader label={viewIsIncome ? '% of income' : '% of spend'} sortKey="total" align="right"
            activeKey={sortKey} activeDir={sortDir} onSort={applySort} />
        </div>
        {(() => {
          const sign = sortDir === 'asc' ? 1 : -1
          return [...avgBySeries].sort((a, b) => {
            if (sortKey === 'name') return sign * String(a.name || '').localeCompare(String(b.name || ''))
            if (sortKey === 'avg') return sign * (a.avg - b.avg)
            return sign * (a.total - b.total)
          })
        })().map(s => {
          const grandTotal = avgBySeries.reduce((sum, x) => sum + x.total, 0)
          const pct = grandTotal > 0 ? (s.total / grandTotal * 100).toFixed(1) : 0
          return (
            <div key={s.id} style={{
              display: 'grid', gridTemplateColumns: '1fr 100px 100px 100px',
              padding: '5px 12px', alignItems: 'center',
              borderBottom: '1px solid var(--border)', fontSize: 13,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.color, flexShrink: 0 }} />
                <CategoryMarker kind={drillGroup ? 'category' : 'group'} />
                <span>{s.name}</span>
              </div>
              <span style={{ textAlign: 'right', fontWeight: 600 }}>{formatCurrency(s.avg)}</span>
              <span style={{ textAlign: 'right', color: 'var(--muted)' }}>{formatCurrency(s.total)}</span>
              <span style={{ textAlign: 'right', color: 'var(--muted)' }}>{pct}%</span>
            </div>
          )
        })}
      </Card>
      </div>
  )
}


export default function Dashboard() {
  /*
   * Dashboard runs three analysis modes over the same global filters, but each mode keeps its own drill state.
   * Resetting that state on mode changes avoids carrying breadcrumbs into views that summarize the same data differently.
   */
  const { filters, setDateApplies, setDate } = useFilters()
  const [mode, setMode]           = useState('single')
  // When the user double-clicks a month in the Trends top chart with a group drill active,
  // we stash the group id here and consume it after Single mode re-runs its groupRows fetch.
  // The drill can't be applied synchronously because Single mode needs the new groupRows
  // (scoped to the just-set date filter) before drillToCategories can find a matching row.
  const [pendingSingleDrill, setPendingSingleDrill] = useState(null)
  const [groupRows,  setGroupRows]  = useState([])
  const [incomeRows, setIncomeRows] = useState([])
  const [catRows, setCatRows]     = useState([])
  const [topCatRows, setTopCatRows] = useState([])
  const [spendingViewBy, setSpendingViewBy] = useUserPreference(DASHBOARD_SPENDING_VIEW_BY_PREF_KEY, SPENDING_VIEW_BY_GROUP)
  // The saved tag-report catalog is SHARED tenant data (every user sees the same reports), not a
  // per-user preference, so it loads from the backend rather than ui_preference. A ref backs setter
  // updates so functional updaters work and writes go through without a side effect inside setState.
  // `setTagReports` returns the save promise (some callers chain `.then` to set the selection after).
  const [tagReports, setTagReportsState] = useState([])
  const tagReportsRef = useRef([])
  useEffect(() => {
    let cancelled = false
    api.getDashboardTagReports()
      .then(res => {
        if (cancelled) return
        const list = Array.isArray(res?.reports) ? res.reports : []
        tagReportsRef.current = list
        setTagReportsState(list)
      })
      .catch(() => { /* keep empty on failure */ })
    return () => { cancelled = true }
  }, [])
  const setTagReports = useCallback((nextOrUpdater) => {
    const next = (typeof nextOrUpdater === 'function' ? nextOrUpdater(tagReportsRef.current) : nextOrUpdater) || []
    tagReportsRef.current = next
    setTagReportsState(next)
    return api.saveDashboardTagReports(next).catch(() => { /* optimistic; ignore transient save errors */ })
  }, [])
  // Transient (display-without-save) tag report lives only in session state, so it
  // disappears when the user switches to anything else and never persists.
  const [transientTagReport, setTransientTagReport] = useState(null)
  const [dashboardView, setDashboardView] = useUserPreference(DASHBOARD_VIEW_PREF_KEY, 'spending')
  const [availableTags, setAvailableTags] = useState([])
  const [tagBuilderOpen, setTagBuilderOpen] = useState(false)
  const [tagModeTransactions, setTagModeTransactions] = useState([])
  const [tagModeLoading, setTagModeLoading] = useState(false)
  const [detailTagSignatures, setDetailTagSignatures] = useState([])
  const [missingTagsToastReportId, setMissingTagsToastReportId] = useState(null)
  const [pickerMenuOpen, setPickerMenuOpen] = useState(null)
  const [renameTargetId, setRenameTargetId] = useState(null)
  const [deleteTargetId, setDeleteTargetId] = useState(null)
  const [showAllSpendingRows, setShowAllSpendingRows] = useState(false)
  const [otherDrillDepth, setOtherDrillDepth] = useState(0)
  const viewIsIncome = dashboardView === 'income'

  useEffect(() => {
    api.getTags().then(rows => setAvailableTags(Array.isArray(rows) ? rows : [])).catch(() => setAvailableTags([]))
  }, [])

  useEffect(() => {
    setShowAllSpendingRows(false)
    setOtherDrillDepth(0)
  }, [spendingViewBy, dashboardView])

  // The Trends tab queries its own full-history window (not the shared date chip), so mute the date
  // button while the user is here. Restore on unmount so other pages see the chip as live again.
  useEffect(() => {
    setDateApplies(mode !== 'trends')
    return () => setDateApplies(true)
  }, [mode, setDateApplies])

  // Filter derivation is hoisted ahead of the tag-mode fetch effect so the effect's
  // dependency expression can read these without a temporal dead zone.
  const dateStart = filters.date?.start || null
  const dateEnd   = filters.date?.end   || null
  // The period shown on the single-view totals cards. With no date chip the dashboard aggregates over
  // all data, so it reads "All time" rather than implying the current month.
  const singlePeriodLabel = filters.date
    ? (filters.date.preset || `${filters.date.start} → ${filters.date.end}`)
    : 'All time'
  const accountSelections = filters.selections.filter(s => s.type === 'account')
  const accountId = accountSelections.length === 1 ? accountSelections[0].id : undefined
  const tagSelections = filters.selections.filter(s => s.type === 'tag')
  const tagIds = tagSelections.length > 0 ? tagSelections.map(s => s.id).join(',') : undefined
  const ownerSelections = filters.selections.filter(s => s.type === 'owner')
  const ownerIds = ownerSelections.length > 0 ? ownerSelections.map(s => s.id).join(',') : undefined
  const accountIds = accountSelections.length > 0 ? accountSelections.map(s => s.id).join(',') : undefined
  const groupSelections = filters.selections.filter(s => s.type === 'group')
  const groupIds = groupSelections.length > 0 ? groupSelections.map(s => s.id).join(',') : undefined
  const categorySelections = filters.selections.filter(s => s.type === 'category')
  const categoryIds = categorySelections.length > 0 ? categorySelections.map(s => s.id).join(',') : undefined
  const payeeSelections = filters.selections.filter(s => s.type === 'payee')
  const payees = payeeSelections.length > 0 ? payeeSelections.map(s => s.label).join('|') : undefined
  // The cross-cutting filters (beyond date/tag/owner) that the summary, trend, and list endpoints accept.
  // Passed as trailing opts to every totals/trend call and spread into drill lists so the filter chips
  // narrow the whole dashboard, not just bits of it. Keys match both the summary opts and the list params.
  const summaryFilters = useMemo(
    () => ({ account_ids: accountIds, group_ids: groupIds, category_ids: categoryIds, payees }),
    [accountIds, groupIds, categoryIds, payees],
  )

  // Picker resolution is hoisted ahead of the tag-mode fetch effect so the effect's
  // dependency expression can read activeTagReport without hitting a temporal dead zone.
  const savedTagReports = Array.isArray(tagReports) ? tagReports : []
  const allTagReports = transientTagReport
    ? [...savedTagReports, transientTagReport]
    : savedTagReports
  const spendingViewByOptions = [
    ...SPENDING_VIEW_BY_BUILTIN_OPTIONS,
    ...allTagReports.map(r => ({ value: `${TAG_REPORT_PREFIX}${r.id}`, label: r.name })),
    { value: NEW_TAG_REPORT_OPTION, label: '+ Tag report' },
  ]
  const activeSpendingViewBy = spendingViewByOptions.some(opt => opt.value === spendingViewBy)
    && spendingViewBy !== NEW_TAG_REPORT_OPTION
    ? spendingViewBy
    : SPENDING_VIEW_BY_GROUP
  const activeTagReport = activeSpendingViewBy.startsWith(TAG_REPORT_PREFIX)
    ? allTagReports.find(r => `${TAG_REPORT_PREFIX}${r.id}` === activeSpendingViewBy) || null
    : null

  // Tag-report mode aggregates per signature on the frontend, so it needs the period's raw
  // transactions (already scoped to view + filters by the backend). Skipping the fetch when
  // the active mode is group/category keeps the network surface unchanged for those modes.
  const tagModeFetchKey = activeTagReport
    ? `${activeTagReport.id}|${dashboardView}|${dateStart || ''}|${dateEnd || ''}|${accountId || ''}|${tagIds || ''}|${ownerIds || ''}|${accountIds || ''}|${groupIds || ''}|${categoryIds || ''}|${payees || ''}`
    : null
  // The tag report's wedges are computed client-side from these rows, so an edit that changes a
  // transaction's effective tags (recategorizing it into/out of a tagged category) only shows up
  // once these are refetched. Extracted as a callback so both the scope-change effect below and the
  // `luma:transactions-changed` handler can reload it — the same shape as loadSingleTotals.
  const loadTagModeTransactions = useCallback(() => (
    api.getTransactions({
      ...(dateStart ? { date_start: dateStart } : {}),
      ...(dateEnd ? { date_end: dateEnd } : {}),
      ...(accountId ? { account_id: accountId } : {}),
      ...(tagIds ? { tag_ids: tagIds } : {}),
      ...(ownerIds ? { owner_ids: ownerIds } : {}),
      ...summaryFilters,
      view: dashboardView,
      limit: 1000,
    }).then(resp => resp?.transactions || [])
  ), [dateStart, dateEnd, accountId, tagIds, ownerIds, summaryFilters, dashboardView])
  useEffect(() => {
    if (mode !== 'single' || !activeTagReport) {
      setTagModeTransactions([])
      setTagModeLoading(false)
      return
    }
    let cancelled = false
    setTagModeLoading(true)
    loadTagModeTransactions().then(txns => {
      if (cancelled) return
      setTagModeTransactions(txns)
      setTagModeLoading(false)
    }).catch(() => {
      if (cancelled) return
      setTagModeTransactions([])
      setTagModeLoading(false)
    })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, tagModeFetchKey])

  // Surface a one-shot toast when the active tag report references tag IDs that no longer
  // exist (the user deleted a tag elsewhere). The renderer already silently ignores those
  // IDs in computeTagSignatureRows, so the data displays correctly; the toast just
  // notifies the user that something changed so they can rebuild the report deliberately.
  // The user can dismiss for the session (auto-fade or X) or suppress permanently for this
  // preset via "Don't remind me again", which sets dismissedMissingWarning on the record.
  useEffect(() => {
    if (!activeTagReport || availableTags.length === 0) {
      setMissingTagsToastReportId(null)
      return
    }
    if (activeTagReport.dismissedMissingWarning) {
      setMissingTagsToastReportId(null)
      return
    }
    if (activeTagReport.id === '__transient__') {
      setMissingTagsToastReportId(null)
      return
    }
    const knownIds = new Set(availableTags.map(t => t.id))
    const hasMissing = (activeTagReport.tagIds || []).some(id => !knownIds.has(id))
    setMissingTagsToastReportId(hasMissing ? activeTagReport.id : null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTagReport?.id, activeTagReport?.dismissedMissingWarning, availableTags])
  const [txnData, setTxnData]     = useState([])
  const [txnDataTotal, setTxnDataTotal] = useState(0)
  const [groupTxnData, setGroupTxnData] = useState([])
  const [groupTxnDataTotal, setGroupTxnDataTotal] = useState(0)
  const [detailTxns, setDetailTxns]     = useState([])
  const [detailMonths, setDetailMonths] = useState([])
  const [categories, setCategories]     = useState([])
  const [rulePrompt, setRulePrompt]     = useState(null)
  // The single-view trend is derived (memo below) from the raw monthly rows so the user can re-bucket
  // (month/quarter/year) without re-fetching. `trendWindowBuckets` is the period-sized ±window used
  // when a date chip is set; null means the no-chip "all time" case, where the grain selector applies.
  const [singleTrendRows, setSingleTrendRows]           = useState([])
  const [singleTrendWindowBuckets, setSingleTrendWindowBuckets] = useState(null)
  const [trendGrain, setTrendGrain]         = useState('month')
  const [level, setLevel]         = useState('groups')
  const [selectedGroup, setSelectedGroup] = useState(null)
  const [selectedCat,   setSelectedCat]   = useState(null)

  // Bulk edit for the two single-period drill tables. The filter params mirror the drill fetches exactly
  // (category/group + the active date/account/owner/tag scope) so "select all matching" resolves the same
  // rows server-side, including any past the loaded cap; rows reconcile in place.
  const selectedCatBulk = useBulkTransactionEditing({
    rows: txnData,
    setRows: setTxnData,
    total: txnDataTotal,
    filterParams: {
      ...summaryFilters,
      date_start: dateStart || undefined,
      date_end: dateEnd || undefined,
      category_id: selectedCat?.category_id,
      account_id: accountId || undefined,
      tag_ids: tagIds,
      owner_ids: ownerIds,
    },
    categories,
    availableTags,
    onRowsTrashed: count => setTxnDataTotal(prev => Math.max(0, prev - count)),
  })
  const selectedGroupBulk = useBulkTransactionEditing({
    rows: groupTxnData,
    setRows: setGroupTxnData,
    total: groupTxnDataTotal,
    filterParams: {
      ...summaryFilters,
      date_start: dateStart || undefined,
      date_end: dateEnd || undefined,
      group_ids: selectedGroup?.group_id,
      account_id: accountId || undefined,
      tag_ids: tagIds,
      owner_ids: ownerIds,
    },
    categories,
    availableTags,
    onRowsTrashed: count => setGroupTxnDataTotal(prev => Math.max(0, prev - count)),
  })

  const [periodA, setPeriodA] = useState(presetToPeriod('this_month'))
  // B is always conceptually "what to compare A against." We store the selected mode
  // (prior_month / prior_year / prior_period / custom) and an explicit custom range, and
  // derive the concrete periodB below so an A-side change automatically refreshes B.
  const [bMode, setBMode] = useState('prior_month')
  const [bCustomStart, setBCustomStart] = useState(lastM)
  const [bCustomEnd, setBCustomEnd] = useState(lastM)
  const [bCustomApplied, setBCustomApplied] = useState({ start: lastM, end: lastM })
  const periodB = useMemo(() => {
    if (bMode === 'custom') {
      const start = bCustomApplied.start < bCustomApplied.end ? bCustomApplied.start : bCustomApplied.end
      const end = bCustomApplied.start < bCustomApplied.end ? bCustomApplied.end : bCustomApplied.start
      return { type: 'custom', start, end }
    }
    return derivePriorPeriod(periodA, bMode)
  }, [periodA, bMode, bCustomApplied])
  // When A's shape changes (month <-> year <-> custom) the previously-selected B mode may not
  // be valid anymore — auto-correct to the first option of the new option set so the dropdown
  // never displays a value it doesn't actually offer.
  useEffect(() => {
    const valid = new Set(priorModeOptionsFor(periodA).map(o => o.value))
    if (!valid.has(bMode)) {
      const options = priorModeOptionsFor(periodA)
      if (options.length) setBMode(options[0].value)
    }
    // Deliberately keyed only on `periodA?.type` — we want the shape-change
    // auto-correct, NOT a re-evaluation every time periodA's date range or bMode
    // itself shifts (which would fight the user's normal B-mode selection).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodA?.type])
  const [cmpGroupsA, setCmpGroupsA] = useState([])
  const [cmpGroupsB, setCmpGroupsB] = useState([])
  const [cmpCatsA,   setCmpCatsA]   = useState([])
  const [cmpCatsB,   setCmpCatsB]   = useState([])
  const [cmpGroup,   setCmpGroup]   = useState(null)
  const [cmpLevel,   setCmpLevel]   = useState('groups')

  // null = "auto": let TrendsPanel resolve the default from the data (trailing 12 months if those
  // months have data, else the most recent year present) so a stale/imported dataset doesn't land on
  // an empty trailing window. An explicit pick from the dropdown overrides it.
  const [trendYear,  setTrendYear]        = useState(null)
  const [trendGroup,  setTrendGroup]      = useState(null)
  const [trendRows,   setTrendRows]       = useState([])
  const [trendGroups, setTrendGroups]     = useState([])
  const [trendLoading, setTrendLoading]   = useState(false)

  const [loading,      setLoading]      = useState(true)
  const [drillLoading, setDrillLoading] = useState(false)
  const multiDetailMode = detailTxns.length > 1
  const [categoryTxnColumns, setCategoryTxnColumns] = useTransactionTableLayout({
    preferenceKey: DASHBOARD_CATEGORY_TXN_TABLE_PREF_KEY,
    showCategory: false,
  })
  const [groupTxnColumns, setGroupTxnColumns] = useTransactionTableLayout({
    preferenceKey: DASHBOARD_GROUP_TXN_TABLE_PREF_KEY,
  })

  function openTransactionDetail(txn) {
    if (!txn?.id) return
    setDetailTxns(prev => [
      ...prev.filter(item => item.id !== txn.id),
      txn,
    ])
  }

  // Reconcile an edit made inside the payee detail panel back into every place the dashboard holds that
  // row: the two drill tables and the open-panel copies (so reopening the panel shows the change, not a
  // stale snapshot). `patch` null means the row was trashed and should drop.
  function reconcileDetailEdit(txnId, patch) {
    const apply = list => (
      patch === null
        ? list.filter(row => row.id !== txnId)
        : list.map(row => (row.id === txnId ? { ...row, ...patch } : row))
    )
    setTxnData(apply)
    setGroupTxnData(apply)
    setDetailTxns(apply)
  }

  function closeTransactionDetail(txnId) {
    setDetailTxns(prev => prev.filter(item => item.id !== txnId))
  }

  // Month detail panels stack like transaction detail panels: same key (month + view) opens
  // the existing one rather than spawning a duplicate, and each new panel goes on top.
  function openMonthDetail(month, view) {
    if (!month) return
    const key = `${month}::${view || 'spending'}`
    setDetailMonths(prev => [
      ...prev.filter(item => item.key !== key),
      { key, month, view: view || 'spending' },
    ])
  }

  function closeMonthDetail(key) {
    setDetailMonths(prev => prev.filter(item => item.key !== key))
  }

  // Tag-signature detail panels stack like the other floating drawers. The key encodes
  // the report id + signature so the same wedge double-click focuses the existing panel.
  function openTagDetail(row, report) {
    if (!row || !report) return
    const signatureKey = (row.signature_tag_ids || []).slice().sort().join('|') || '__other__'
    const key = `tag::${report.id}::${signatureKey}`
    setDetailTagSignatures(prev => [
      ...prev.filter(item => item.key !== key),
      {
        key,
        signature: row,
        reportTagIds: report.tagIds || [],
        reportName: report.name,
        view: dashboardView,
        accountId: accountId || null,
        dateStart,
        dateEnd,
        filterTagIds: tagIds || null,
      },
    ])
  }

  function closeTagDetail(key) {
    setDetailTagSignatures(prev => prev.filter(item => item.key !== key))
  }

  // Factored out of the effect so a transaction edit can refresh the breakdown/trend *in place* without
  // the drill-reset that a real mode/filter navigation does. The top-half summary respects the selected
  // date slice; the bottom-half trend uses it only for bucket size, always showing a run of buckets.
  const loadSingleTotals = useCallback(async () => {
    const isIncomeView = dashboardView === 'income'
    // With a date chip set, the trend is a fixed window of period-sized buckets centered on the
    // selection. With no chip the dashboard totals cover all data, so fetch the full monthly history
    // (ancient start → backend skips its rolling window) and bucket it month-by-month across the data's
    // span — otherwise the trend sits on an empty current-month window while the totals show all time.
    const hasDate = !!filters.date
    const windowBuckets = hasDate ? computeTrendBuckets(filters.date).buckets : null
    const trendStart = hasDate ? `${windowBuckets[0].start}-01` : ALL_TIME_START
    const trendEnd = hasDate ? lastDayOfMonthISO(windowBuckets[windowBuckets.length - 1].end) : undefined
    const [g, tr, c] = await Promise.all([
      api.getGroupTotals(null, accountId || undefined, dateStart, dateEnd, ownerIds, undefined, tagIds, summaryFilters),
      api.getMonthlyTrend(120, undefined, accountId || undefined, trendStart, trendEnd, tagIds, dashboardView, ownerIds, summaryFilters),
      api.getCategoryTotals(null, accountId || undefined, dateStart, dateEnd, ownerIds, undefined, tagIds, !isIncomeView, isIncomeView, summaryFilters),
    ])
    setGroupRows(g.filter(r => r.category_type !== 'income'))
    setIncomeRows(g.filter(r => r.category_type === 'income'))
    // Store the raw monthly rows (+ the period window, if any) and let the memo below fold them into
    // buckets — so changing the grain re-buckets client-side without another round of fetches.
    setSingleTrendRows(tr)
    setSingleTrendWindowBuckets(windowBuckets)
    setTopCatRows(c)
  }, [accountId, dateStart, dateEnd, ownerIds, tagIds, summaryFilters, dashboardView, filters.date])

  // Grain selector applies only to the no-chip "all time" trend (a date chip already sizes its own
  // buckets), and only once there's enough history that month/quarter/year is a real choice.
  const trendSpanMonths = singleTrendWindowBuckets ? 0 : monthSpanOfRows(singleTrendRows)
  const showTrendGrainSelector = !singleTrendWindowBuckets && trendSpanMonths > TREND_GRAIN_SELECTOR_MIN_MONTHS
  const trend = useMemo(() => {
    const buckets = singleTrendWindowBuckets
      ?? calendarBucketsFromRows(singleTrendRows, showTrendGrainSelector ? trendGrain : 'month')
    return trimEmptyTrendBuckets(aggregateMonthlyIntoBuckets(singleTrendRows, buckets))
  }, [singleTrendRows, singleTrendWindowBuckets, trendGrain, showTrendGrainSelector])

  // In-place loaders for the Compare and Trends aggregates, shared by their mode effects and the
  // transaction-change refresh so an edit updates them without resetting the user's drill.
  const loadCompareTotals = useCallback(async () => {
    if (!periodA || !periodB) return
    const [a, b] = await Promise.all([
      fetchPeriodGroupTotals(periodA, accountId, tagIds, ownerIds, summaryFilters),
      fetchPeriodGroupTotals(periodB, accountId, tagIds, ownerIds, summaryFilters),
    ])
    setCmpGroupsA(a)
    setCmpGroupsB(b)
  }, [periodA, periodB, accountId, tagIds, ownerIds, summaryFilters])

  const loadTrendSeries = useCallback(async () => {
    // Fetch the full visible history (20-year bound) so the year picker and Annual totals can reach
    // every year in the data; the per-window monthly charts then slice this down via the year picker.
    const rows = await api.getMonthlyByGroup(240, accountId || undefined, trendGroup?.series_id || undefined, tagIds, ownerIds, summaryFilters)
    setTrendRows(rows)
  }, [accountId, trendGroup, tagIds, ownerIds, summaryFilters])

  const loadTrendGroups = useCallback(async () => {
    const wantIncome = dashboardView === 'income'
    const g = await api.getGroupTotals(thisM, accountId || undefined, undefined, undefined, ownerIds, undefined, tagIds, summaryFilters)
    setTrendGroups(g.filter(r => (wantIncome ? r.category_type === 'income' : r.category_type !== 'income')))
  }, [accountId, ownerIds, tagIds, summaryFilters, dashboardView])

  useEffect(() => {
    if (mode !== 'single') return
    setLoading(true)
    setLevel('groups'); setSelectedGroup(null); setSelectedCat(null); setOtherDrillDepth(0)
    loadSingleTotals().then(() => setLoading(false))
  }, [mode, loadSingleTotals])

  // Recategorizing (here or from a detail panel) changes the aggregates, so refresh the breakdown/trend
  // and the open group's category totals in place — otherwise a moved transaction lingers in the list.
  useEffect(() => {
    function onTxnChange() {
      if (mode === 'single') {
        loadSingleTotals()
        if (selectedGroup?.group_id) {
          api.getCategoryTotalsInGroup(null, selectedGroup.group_id, accountId || undefined, dateStart, dateEnd, ownerIds, tagIds, summaryFilters)
            .then(setCatRows)
        }
        // The tag report is a separate data path from the group/category totals above, so refresh its
        // underlying rows too — otherwise recategorizing a transaction out of a tagged category (e.g.
        // from the TagDetail panel) leaves the wedges stale.
        if (activeTagReport) {
          loadTagModeTransactions().then(setTagModeTransactions).catch(() => {})
        }
      } else if (mode === 'compare') {
        loadCompareTotals()
        if (cmpGroup?.group_id) {
          Promise.all([
            fetchPeriodCatTotals(periodA, cmpGroup.group_id, accountId, tagIds, ownerIds, summaryFilters),
            fetchPeriodCatTotals(periodB, cmpGroup.group_id, accountId, tagIds, ownerIds, summaryFilters),
          ]).then(([a, b]) => { setCmpCatsA(a); setCmpCatsB(b) })
        }
      } else if (mode === 'trends') {
        loadTrendSeries()
        loadTrendGroups()
      }
    }
    window.addEventListener('luma:transactions-changed', onTxnChange)
    return () => window.removeEventListener('luma:transactions-changed', onTxnChange)
  }, [mode, loadSingleTotals, loadCompareTotals, loadTrendSeries, loadTrendGroups, selectedGroup, cmpGroup, periodA, periodB, accountId, dateStart, dateEnd, ownerIds, tagIds, summaryFilters, activeTagReport, loadTagModeTransactions])

  useEffect(() => {
    api.getCategories().then(setCategories)
  }, [])

  useEffect(() => {
    if (mode !== 'compare' || !periodA || !periodB) return
    setLoading(true)
    setCmpLevel('groups'); setCmpGroup(null)
    loadCompareTotals().then(() => setLoading(false))
  }, [mode, periodA, periodB, loadCompareTotals])

  useEffect(() => {
    if (mode !== 'trends') return
    setTrendLoading(true)
    loadTrendSeries().then(() => setTrendLoading(false))
  }, [mode, loadTrendSeries])

  useEffect(() => {
    if (mode !== 'trends') return
    // The drill dropdown lists only the side of the ledger the user is currently viewing —
    // expense groups in spending mode, income groups in income mode (handled inside loadTrendGroups).
    loadTrendGroups()
  }, [mode, loadTrendGroups])

  // Clear an active drill when the user toggles between spending and income — a drilled
  // expense group has no meaning in income view (and vice versa), so jump back to "all groups".
  useEffect(() => {
    if (mode === 'trends') setTrendGroup(null)
    // Keyed only on dashboardView; mode changes are unrelated and should not retrigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboardView])

  const drillToCategories = useCallback(async (group) => {
    const groupId  = group.group_id ?? group.payload?.group_id
    const groupRow = groupRows.find(r => r.group_id === groupId) || group
    setDrillLoading(true)
    setSelectedGroup(groupRow)
    const [rows, txnResp] = await Promise.all([
      api.getCategoryTotalsInGroup(null, groupId, accountId || undefined, dateStart, dateEnd, ownerIds, tagIds, summaryFilters),
      api.getTransactions({
        ...summaryFilters,
        date_start:  filters.date?.start || undefined,
        date_end:    filters.date?.end   || undefined,
        group_ids:   groupId,
        account_id:  accountId || undefined,
        tag_ids:     tagIds,
        owner_ids:   ownerIds,
        limit: 500,
      }),
    ])
    setCatRows(rows)
    setGroupTxnData(txnResp.transactions)
    setGroupTxnDataTotal(Number(txnResp.total || 0))
    setLevel('categories')
    setDrillLoading(false)
  }, [groupRows, accountId, dateStart, dateEnd, tagIds, ownerIds, summaryFilters, filters.date?.start, filters.date?.end])

  // Consume a pending Single-mode drill once the date-scoped groupRows have loaded. If the
  // queued group isn't present in this slice (e.g. zero spend that month), drop the queue
  // silently rather than leave it dangling.
  useEffect(() => {
    if (mode !== 'single' || !pendingSingleDrill || groupRows.length === 0) return
    const target = groupRows.find(r => r.group_id === pendingSingleDrill)
    setPendingSingleDrill(null)
    if (target) drillToCategories(target)
  }, [drillToCategories, groupRows, pendingSingleDrill, mode])

  // Switch into Single mode focused on the given YYYY-MM month. Optionally preserves the active
  // trend-group drill so a "this group, this month" view comes up in one gesture.
  function openSinglePeriodForMonth(month) {
    if (!month) return
    const [y, m] = month.split('-').map(Number)
    const lastDay = new Date(y, m, 0).getDate()
    const start = `${month}-01`
    const end = `${month}-${String(lastDay).padStart(2, '0')}`
    setDate({ start, end, preset: monthLabel(month) })
    if (trendGroup?.series_id) setPendingSingleDrill(trendGroup.series_id)
    setMode('single')
  }

  async function drillToTransactions(cat) {
    const categoryId = cat.category_id ?? cat.payload?.category_id
    const catRow     = catRows.find(r => r.category_id === categoryId) || cat
    setDrillLoading(true)
    setSelectedCat(catRow)
    const data = await api.getTransactions({
      ...summaryFilters,
      date_start:  filters.date?.start || undefined,
      date_end:    filters.date?.end   || undefined,
      // Summary rows can surface synthetic uncategorized buckets, so the drill path
      // forwards the returned id directly instead of trying to collapse them back to one label.
      category_id: categoryId,
      account_id:  accountId || undefined,
      tag_ids:     tagIds,
      owner_ids:   ownerIds,
      limit: 200,
    })
    setTxnData(data.transactions)
    setTxnDataTotal(Number(data.total || 0))
    setLevel('transactions')
    setDrillLoading(false)
  }

  // Crumb layout: Overview, then one "Other" crumb per Other-drill page peeled off the
  // top-level pie, then the selected group, then the selected category. Index math here
  // shifts by otherDrillDepth so the group/category crumbs land at the right positions
  // regardless of how deep the user paged into the long tail.
  function singleNavigate(i) {
    if (i === 0) {
      setOtherDrillDepth(0)
      setLevel('groups')
      setSelectedGroup(null)
      setSelectedCat(null)
      setShowAllSpendingRows(false)
      return
    }
    if (i <= otherDrillDepth) {
      setOtherDrillDepth(i)
      setLevel('groups')
      setSelectedGroup(null)
      setSelectedCat(null)
      setShowAllSpendingRows(false)
      return
    }
    if (i === otherDrillDepth + 1 && selectedGroup) {
      setLevel('categories')
      setSelectedCat(null)
    }
  }

  async function cmpDrillToCategories(group) {
    const groupId  = group.group_id
    const groupRow = cmpGroupsA.find(r => r.group_id === groupId) ||
                     cmpGroupsB.find(r => r.group_id === groupId) || group
    setDrillLoading(true)
    setCmpGroup(groupRow)
    const [a, b] = await Promise.all([
      fetchPeriodCatTotals(periodA, groupId, accountId, tagIds, ownerIds, summaryFilters),
      fetchPeriodCatTotals(periodB, groupId, accountId, tagIds, ownerIds, summaryFilters),
    ])
    setCmpCatsA(a)
    setCmpCatsB(b)
    setCmpLevel('categories')
    setDrillLoading(false)
  }

  const pieGroupRows = viewIsIncome ? incomeRows : groupRows
  const coloredGroupRows = assignColors(pieGroupRows, 'group_color')
  const coloredCatRows = assignColors(catRows, 'category_color')
  const coloredTopCatRows = assignColors(topCatRows, 'category_color')
  const totalSpend = groupRows.reduce((s, r) => s + r.total, 0)
  const totalIncome = incomeRows.reduce((s, r) => s + r.total, 0)
  const pieGroupTotal = pieGroupRows.reduce((s, r) => s + r.total, 0)

  const tagsById = useMemo(() => {
    const map = new Map()
    for (const tag of availableTags) map.set(tag.id, tag)
    return map
  }, [availableTags])
  const tagSignatureRows = useMemo(
    () => activeTagReport
      ? computeTagSignatureRows(tagModeTransactions, activeTagReport.tagIds || [], tagsById)
      : [],
    [activeTagReport, tagModeTransactions, tagsById],
  )
  const tagSignatureTotal = tagSignatureRows.reduce((s, r) => s + r.total, 0)

  function handleSpendingViewByChange(value) {
    if (value === NEW_TAG_REPORT_OPTION) {
      setTagBuilderOpen(true)
      return
    }
    // Picking anything other than the transient report clears it so it does not linger
    // in the picker after the user moves on.
    if (transientTagReport && value !== `${TAG_REPORT_PREFIX}${transientTagReport.id}`) {
      setTransientTagReport(null)
    }
    setSpendingViewBy(value)
  }

  function handleSaveTagReport({ name, tagIds }) {
    const id = makeTagReportId()
    const next = [...savedTagReports, { id, name, tagIds }]
    setTransientTagReport(null)
    return Promise.resolve(setTagReports(next)).then(() => {
      setSpendingViewBy(`${TAG_REPORT_PREFIX}${id}`)
    }).catch(() => {})
  }

  function handleDisplayTagReportTransient(tagIds) {
    const transient = { id: '__transient__', name: 'Custom (unsaved)', tagIds }
    setTransientTagReport(transient)
    setSpendingViewBy(`${TAG_REPORT_PREFIX}${transient.id}`)
  }

  function handleRenameTagReport(id, newName) {
    const cleaned = String(newName || '').trim()
    if (!cleaned) return
    setTagReports(savedTagReports.map(r => r.id === id ? { ...r, name: cleaned } : r))
  }

  function handleDeleteTagReport(id) {
    setTagReports(savedTagReports.filter(r => r.id !== id))
    if (spendingViewBy === `${TAG_REPORT_PREFIX}${id}`) {
      setSpendingViewBy(SPENDING_VIEW_BY_GROUP)
    }
  }

  function handleDismissMissingWarning(id) {
    setTagReports(savedTagReports.map(r => r.id === id ? { ...r, dismissedMissingWarning: true } : r))
  }



  const allGroupIds = [...new Set([
    ...cmpGroupsA.map(r => r.group_id),
    ...cmpGroupsB.map(r => r.group_id),
  ])]
  const cmpGroups = allGroupIds.map(id => {
    const a = cmpGroupsA.find(r => r.group_id === id) || {}
    const b = cmpGroupsB.find(r => r.group_id === id) || {}
    const base = a.group_id ? a : b
    return { ...base, totalA: a.total || 0, totalB: b.total || 0 }
  }).filter(g => g.category_type !== 'income')
    .sort((a, b) => (b.totalA + b.totalB) - (a.totalA + a.totalB))
  const coloredCmpGroups = assignColors(cmpGroups, 'group_color')

  const cmpMaxGroup = Math.max(...cmpGroups.map(g => Math.max(g.totalA, g.totalB)), 1)

  const allCatIds = [...new Set([
    ...cmpCatsA.map(r => r.category_id),
    ...cmpCatsB.map(r => r.category_id),
  ])]
  const cmpCats = allCatIds.map(id => {
    const a = cmpCatsA.find(r => r.category_id === id) || {}
    const b = cmpCatsB.find(r => r.category_id === id) || {}
    const base = a.category_id ? a : b
    return { ...base, totalA: a.total || 0, totalB: b.total || 0 }
  }).sort((a, b) => (b.totalA + b.totalB) - (a.totalA + a.totalB))
  const coloredCmpCats = assignColors(cmpCats, 'category_color')
  const cmpMaxCat = Math.max(...cmpCats.map(c => Math.max(c.totalA, c.totalB)), 1)

  const cmpTotalA = cmpGroups.reduce((s, g) => s + g.totalA, 0)
  const cmpTotalB = cmpGroups.reduce((s, g) => s + g.totalB, 0)

  const singleCrumbs = ['Overview']
  for (let d = 1; d <= otherDrillDepth; d++) singleCrumbs.push('Other')
  if (selectedGroup) singleCrumbs.push(selectedGroup.group_name)
  if (selectedCat)   singleCrumbs.push(selectedCat.category_name)

  const cmpCrumbs = [periodLabel(periodA) + ' vs ' + periodLabel(periodB)]
  if (cmpGroup) cmpCrumbs.push(cmpGroup.group_name)

  return (
    <div data-browser-context-passthrough="true" style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '32px 32px 0', flexShrink: 0 }}>
      <PageHeader
        title="Dashboard"
        help={<FeatureExplainer topic="how-luma-works" placement="bottom-left" />}
        leftAdornment={(mode === 'single' || mode === 'trends') && (
          <div style={{
            display: 'flex', background: 'var(--surface2)',
            borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden',
          }}>
            {DASHBOARD_VIEW_OPTIONS.map(opt => (
              <button key={opt.value} onClick={() => setDashboardView(opt.value)} style={{
                padding: '7px 14px', border: 'none', fontSize: 13, cursor: 'pointer',
                background: dashboardView === opt.value ? 'var(--accent)' : 'transparent',
                color: dashboardView === opt.value ? '#fff' : 'var(--muted)',
              }}>
                {opt.label}
              </button>
            ))}
          </div>
        )}
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{
            display: 'flex', background: 'var(--surface2)',
            borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden',
          }}>
            {['single', 'compare', 'trends'].map(m => (
              <button key={m} onClick={() => setMode(m)} style={{
                padding: '7px 14px', border: 'none', fontSize: 13, cursor: 'pointer',
                background: mode === m ? 'var(--accent)' : 'transparent',
                color: mode === m ? '#fff' : 'var(--muted)',
              }}>
                {m === 'single' ? 'Single period' : m === 'compare' ? 'Compare' : 'Trends'}
              </button>
            ))}
          </div>
        </div>
      </PageHeader>
      </div>

      {/* Small top padding so a focusable control sitting at the very top of this scroll area (e.g. the
          Trends year picker) isn't clipped at the overflow edge — its focus outline needs room above the
          border box. */}
      <div data-browser-context-passthrough="true" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 32px 32px' }}>

      {mode === 'compare' && (
        <div style={{ display: 'flex', gap: 20, marginBottom: 24, flexWrap: 'wrap' }}>
          <PeriodPicker label="Period A" value={periodA} onChange={setPeriodA} />
          <div style={{ display: 'flex', alignItems: 'center', paddingTop: 24, color: 'var(--muted)', fontSize: 18 }}>vs</div>
          <PriorPeriodPicker
            label="Period B"
            aPeriod={periodA}
            mode={bMode}
            customStart={bCustomStart}
            customEnd={bCustomEnd}
            onModeChange={setBMode}
            onCustomStartChange={setBCustomStart}
            onCustomEndChange={setBCustomEnd}
            onCustomApply={() => setBCustomApplied({ start: bCustomStart, end: bCustomEnd })}
          />
        </div>
      )}

      {loading ? <Spinner /> : (
        <>
          {mode === 'single' && (
            <>

              <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
                <Card style={{ padding: '14px 24px' }}>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 2 }}>
                    Total spending · {singlePeriodLabel}
                  </div>
                  <div style={{ fontSize: 28, fontWeight: 700 }}>{formatCurrency(totalSpend)}</div>
                </Card>
                {totalIncome > 0 && (
                  <Card style={{ padding: '14px 24px' }}>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 2 }}>
                      Total income · {singlePeriodLabel}
                    </div>
                    <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--success)' }}>{formatCurrency(totalIncome)}</div>
                  </Card>
                )}
                {selectedGroup && level !== 'groups' && (
                  <Card style={{ padding: '14px 24px' }}>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 2 }}>{selectedGroup.group_name}</div>
                    <div style={{ fontSize: 28, fontWeight: 700 }}>{formatCurrency(selectedGroup.total)}</div>
                  </Card>
                )}
                {selectedCat && level === 'transactions' && (
                  <Card style={{ padding: '14px 24px' }}>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 2 }}>{selectedCat.category_name}</div>
                    <div style={{ fontSize: 28, fontWeight: 700 }}>{formatCurrency(selectedCat.total)}</div>
                  </Card>
                )}
              </div>

              {(level !== 'groups' || otherDrillDepth > 0) && <Breadcrumb items={singleCrumbs} onNavigate={singleNavigate} />}

              {drillLoading ? <Spinner /> : (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 24 }}>
                  {level === 'groups' && (() => {
                    const viewIsCategory = activeSpendingViewBy === SPENDING_VIEW_BY_CATEGORY
                    const viewIsTag = !!activeTagReport
                    const allRows = viewIsTag
                      ? tagSignatureRows
                      : viewIsCategory
                        ? coloredTopCatRows
                        : coloredGroupRows
                    const listTotal = viewIsTag
                      ? tagSignatureTotal
                      : viewIsCategory
                        ? topCatRows.reduce((s, r) => s + r.total, 0)
                        : pieGroupTotal
                    const rowKey = viewIsTag
                      ? 'signature_id'
                      : viewIsCategory ? 'category_id' : 'group_id'
                    const rowName = viewIsTag
                      ? 'signature_name'
                      : viewIsCategory ? 'category_name' : 'group_name'
                    const rowColor = viewIsTag
                      ? 'signature_color'
                      : viewIsCategory ? 'category_color' : 'group_color'
                    const onRealRowClick = viewIsTag
                      ? (row) => openTagDetail(row, activeTagReport)
                      : viewIsCategory
                        ? drillToTransactions
                        : drillToCategories

                    // Page boundaries are precomputed so each level's named-slice count adapts to its own
                    // pool: deeper Other-pages re-apply the share rule against just what's left in the
                    // tail, not against the original full list.
                    const pages = computeSlicePages(allRows)
                    const safeDepth = Math.min(otherDrillDepth, Math.max(0, pages.length - 1))
                    const currentPage = pages[safeDepth] || { start: 0, end: allRows.length }
                    const pageRows = allRows.slice(currentPage.start, currentPage.end)
                    const remainingRows = allRows.slice(currentPage.end)
                    const otherTotal = remainingRows.reduce((s, r) => s + r.total, 0)
                    // The peeled-off "Other (N)" wedge represents the long tail of the current page,
                    // which is conceptually distinct from the tag-mode natural "Other / Untagged"
                    // signature (transactions matching no selected tag). Tagging it with `_peeledOther`
                    // lets the click handler dispatch correctly without a key clash.
                    const otherSlice = remainingRows.length > 0
                      ? {
                        [rowKey]: OTHER_SLICE_KEY,
                        [rowName]: `Other (${remainingRows.length})`,
                        [rowColor]: OTHER_SLICE_COLOR,
                        total: otherTotal,
                        _peeledOther: true,
                      }
                      : null
                    const pieData = otherSlice ? [...pageRows, otherSlice] : pageRows
                    const expansionAvailable = allRows.length > pageRows.length
                    const listRows = showAllSpendingRows ? allRows : pieData

                    function handleSliceClick(row) {
                      if (!row) return
                      if (row._peeledOther) {
                        setOtherDrillDepth(d => d + 1)
                        setShowAllSpendingRows(false)
                        return
                      }
                      onRealRowClick(row)
                    }

                    return (
                      <>
                        <Card>
                          <div
                            style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, fontSize: 14, fontWeight: 600 }}
                            onContextMenu={event => {
                              if (!activeTagReport || activeTagReport.id === '__transient__') return
                              event.preventDefault()
                              setPickerMenuOpen({
                                id: activeTagReport.id,
                                anchorRect: event.currentTarget.getBoundingClientRect(),
                              })
                            }}
                          >
                            <span>{viewIsIncome ? 'Income by' : 'Spending by'}</span>
                            <Select
                              value={activeSpendingViewBy}
                              onChange={handleSpendingViewByChange}
                              options={spendingViewByOptions}
                              aria-label={viewIsIncome ? 'Choose dashboard income breakdown' : 'Choose dashboard spending breakdown'}
                            />
                            <FeatureExplainer topic="dashboard-tag-reports" placement="bottom-left" />
                            {activeTagReport && activeTagReport.id !== '__transient__' && (
                              <button
                                type="button"
                                title="Manage this tag report"
                                onClick={event => {
                                  const rect = event.currentTarget.getBoundingClientRect()
                                  setPickerMenuOpen({ id: activeTagReport.id, anchorRect: rect })
                                }}
                                style={{
                                  background: 'none', border: 'none',
                                  color: 'var(--muted)', cursor: 'pointer',
                                  padding: '0 6px', fontSize: 18, lineHeight: 1,
                                }}
                              >
                                ⋯
                              </button>
                            )}
                          </div>
                          {viewIsTag && tagModeLoading ? (
                            <div style={{ height: 220, display: 'grid', placeItems: 'center' }}>
                              <Spinner />
                            </div>
                          ) : (
                            <ResponsiveContainer width="100%" height={220}>
                              <PieChart>
                                <Pie data={pieData} dataKey="total" nameKey={rowName}
                                  cx="50%" cy="50%" innerRadius={55} outerRadius={95} paddingAngle={2}
                                  onClick={d => d && handleSliceClick(d)} style={{ cursor: 'pointer' }}>
                                  {pieData.map((r, i) => <Cell key={i} fill={r[rowColor]} />)}
                                </Pie>
                                <Tooltip
                                  formatter={v => formatCurrency(v)}
                                  contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
                                  labelStyle={CHART_TOOLTIP_LABEL_STYLE}
                                  itemStyle={CHART_TOOLTIP_ITEM_STYLE}
                                />
                              </PieChart>
                            </ResponsiveContainer>
                          )}
                          <div style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'center', marginTop: 4 }}>
                            {viewIsTag || viewIsCategory ? 'Click to see transactions' : 'Click to drill down'}
                          </div>
                        </Card>
                        <Card>
                          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>
                            {viewIsTag
                              ? (activeTagReport?.name || 'Tags')
                              : viewIsCategory ? 'Categories' : 'Groups'}
                          </div>
                          <div style={{
                            // CSS multi-column (not grid) so rows fill down the first column and then
                            // the next, instead of left→right across each row. column-width keeps it
                            // responsive: the browser fits as many ~260px columns as the card allows.
                            columnWidth: 260,
                            columnGap: 20,
                          }}>
                            {listRows.map(r => {
                              const isOther = r[rowKey] === OTHER_SLICE_KEY
                              return (
                                <div key={r[rowKey]} onClick={() => handleSliceClick(r)} style={{
                                  display: 'flex', alignItems: 'center', gap: 8,
                                  padding: '5px 0', borderBottom: '1px solid var(--border)', cursor: 'pointer',
                                  minWidth: 0,
                                  breakInside: 'avoid',
                                  fontStyle: isOther ? 'italic' : 'normal',
                                }}>
                                  <span style={{ width: 10, height: 10, borderRadius: '50%', background: r[rowColor], flexShrink: 0 }} />
                                  <span
                                    title={r[rowName]}
                                    style={{
                                      fontSize: 13, flex: 1, minWidth: 0,
                                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                    }}
                                  >
                                    {r[rowName]}
                                  </span>
                                  <div style={{ width: 54, flexShrink: 0 }}>
                                    <SpendBar value={r.total} total={listTotal} color={r[rowColor]} />
                                  </div>
                                  <span style={{ fontSize: 12, fontWeight: 600, minWidth: 68, textAlign: 'right', flexShrink: 0 }}>
                                    {formatCurrency(r.total)}
                                  </span>
                                  <span style={{ color: 'var(--muted)', fontSize: 14, flexShrink: 0 }}>›</span>
                                </div>
                              )
                            })}
                          </div>
                          {expansionAvailable && (
                            <div style={{ textAlign: 'center', marginTop: 10 }}>
                              <button
                                onClick={() => setShowAllSpendingRows(v => !v)}
                                style={{
                                  background: 'none', border: 'none', padding: '4px 8px',
                                  color: 'var(--accent2)', cursor: 'pointer', fontSize: 13,
                                }}
                              >
                                {showAllSpendingRows
                                  ? 'Show less'
                                  : `Show all ${viewIsTag ? 'wedges' : viewIsCategory ? 'categories' : 'groups'}`}
                              </button>
                            </div>
                          )}
                        </Card>
                      </>
                    )
                  })()}

                  {level === 'categories' && selectedGroup && (
                    <>
                      <Card>
                        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
                          <CategoryMarker kind="group" />
                          <span>{selectedGroup.group_name}</span>
                        </div>
                        <ResponsiveContainer width="100%" height={220}>
                          <PieChart>
                            <Pie data={coloredCatRows} dataKey="total" nameKey="category_name"
                              cx="50%" cy="50%" innerRadius={55} outerRadius={95} paddingAngle={2}
                              onClick={d => d && drillToTransactions(d)} style={{ cursor: 'pointer' }}>
                              {coloredCatRows.map((c, i) => <Cell key={i} fill={c._chartColor} />)}
                            </Pie>
                            <Tooltip
                              formatter={v => formatCurrency(v)}
                              contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
                              labelStyle={CHART_TOOLTIP_LABEL_STYLE}
                              itemStyle={CHART_TOOLTIP_ITEM_STYLE}
                            />
                          </PieChart>
                        </ResponsiveContainer>
                        <div style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'center', marginTop: 4 }}>Click to see transactions</div>
                      </Card>
                      <Card>
                        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>Categories</div>
                        {coloredCatRows.map(c => (
                          <div key={c.category_id} onClick={() => drillToTransactions(c)} style={{
                            display: 'flex', alignItems: 'center', gap: 10,
                            padding: '8px 0', borderBottom: '1px solid var(--border)', cursor: 'pointer',
                          }}>
                            <span style={{ width: 10, height: 10, borderRadius: '50%', background: c.category_color, flexShrink: 0 }} />
                            <span style={{ fontSize: 14, flex: 1 }}>{c.category_name}</span>
                            <SpendBar value={c.total} total={catRows.reduce((s,r)=>s+r.total,0)} color={c.category_color} />
                            <span style={{ fontSize: 12, color: 'var(--muted)', minWidth: 52, textAlign: 'right' }}>{c.count} txns</span>
                            <span style={{ fontSize: 13, fontWeight: 600, minWidth: 70, textAlign: 'right' }}>{formatCurrency(c.total)}</span>
                            <span style={{ color: 'var(--muted)', fontSize: 16 }}>›</span>
                          </div>
                        ))}
                      </Card>
                    </>
                  )}

                  {level === 'transactions' && selectedCat && (
                    <div style={{ gridColumn: '1 / -1' }}>
                      <Card style={{ padding: 0, overflow: 'hidden' }}>
                        {txnData.length === 0 ? <EmptyState message="No transactions" /> : (
                          <>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, padding: '8px 12px 0' }}>
                              <CopyTransactionsButton rows={txnData} title={selectedCat.category_name} tooltip="Copy the transactions shown" />
                              <Button variant="ghost" small onClick={selectedCatBulk.toggle}>
                                {selectedCatBulk.bulkMode ? '✕ Done' : 'Bulk Edit'}
                              </Button>
                            </div>
                            <div style={{ padding: '0 12px' }}>
                              <BulkEditChrome controller={selectedCatBulk} />
                            </div>
                            <TransactionListTable
                              rows={txnData}
                              categories={categories}
                              {...selectedCatBulk.tableProps}
                              onCategorySave={(txnId, catId, catObj) => {
                                const cat = catObj || categories.find(c => c.id === catId)
                                setTxnData(prev => prev.map(x => x.id === txnId ? {
                                  ...x,
                                  category_id: catId,
                                  category_name: cat?.name ?? null,
                                  category_color: null,
                                  category_overridden: 1,
                                } : x))
                                txnMutations.setCategory(txnId, catId)
                              }}
                              onRulePrompt={setRulePrompt}
                              onRowsChange={setTxnData}
                              onTransactionOpenDetail={openTransactionDetail}
                              onTrashed={txnId => { reconcileDetailEdit(txnId, null); setTxnDataTotal(prev => Math.max(0, prev - 1)) }}
                              showCategory={false}
                              columnConfig={categoryTxnColumns}
                              onColumnConfigChange={setCategoryTxnColumns}
                            />
                          </>
                        )}
                      </Card>
                    </div>
                  )}
                </div>
              )}

              {level === 'groups' && (() => {
                const trendAvg = trend.length > 0
                  ? trend.reduce((s, r) => s + (Number(r.total) || 0), 0) / trend.length
                  : 0
                const trendBarWidth = 60
                const trendChartMinWidth = Math.max(420, trend.length * trendBarWidth)
                const effectiveGrain = showTrendGrainSelector ? trendGrain : 'month'
                const grainWord = effectiveGrain === 'year' ? 'Yearly' : effectiveGrain === 'quarter' ? 'Quarterly' : 'Monthly'
                function handleTrendBarClick(d) {
                  if (!d) return
                  if (d.singleMonth) {
                    openMonthDetail(d.singleMonth, dashboardView)
                    return
                  }
                  // Multi-month bucket: re-pin the date filter onto that bucket so the rest of
                  // the page re-renders with it as the new "selected period."
                  const start = `${d.bucketStart}-01`
                  const end = lastDayOfMonthISO(d.bucketEnd)
                  setDate({ start, end, preset: d.label })
                }
                return (
                  <Card>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>Trend</div>
                      {showTrendGrainSelector && (
                        <select
                          value={trendGrain}
                          onChange={e => setTrendGrain(e.target.value)}
                          aria-label="Trend bucket size"
                          style={{
                            background: 'var(--surface2)', color: 'var(--text)',
                            border: '1px solid var(--border)', borderRadius: 8,
                            padding: '4px 8px', fontSize: 12, cursor: 'pointer',
                          }}
                        >
                          <option value="month">Monthly</option>
                          <option value="quarter">Quarterly</option>
                          <option value="year">Yearly</option>
                        </select>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
                      {filters.date
                        ? 'Buckets sized to the selected period · scroll horizontally to pan'
                        : `${grainWord} totals across all data · scroll horizontally to pan`}
                    </div>
                    <div style={{ overflowX: 'auto', overflowY: 'hidden' }}>
                      <div style={{ minWidth: trendChartMinWidth, height: 224 }}>
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={trend} margin={{ top: 6, right: 12, bottom: 6, left: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                            <XAxis
                              dataKey="label"
                              interval={0}
                              tick={<TrendBucketTick />}
                              height={48}
                            />
                            <YAxis tickFormatter={formatSignedAxisTick} tick={{ fill: 'var(--muted)', fontSize: 11 }} />
                            <Tooltip
                              formatter={v => formatSignedMoneyAmount(v)}
                              contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
                              labelStyle={CHART_TOOLTIP_LABEL_STYLE}
                              itemStyle={CHART_TOOLTIP_ITEM_STYLE}
                            />
                            <Bar
                              dataKey="total"
                              radius={[4,4,0,0]}
                              name={viewIsIncome ? 'Income' : 'Spending'}
                              onClick={handleTrendBarClick}
                              style={{ cursor: 'pointer' }}
                            >
                              {trend.map((entry, idx) => (
                                <Cell
                                  key={idx}
                                  fill={entry.isSelected
                                    ? 'var(--accent)'
                                    : 'color-mix(in srgb, var(--accent) 45%, var(--surface2))'}
                                />
                              ))}
                            </Bar>
                            {trend.length > 1 && (
                              <ReferenceLine
                                y={trendAvg}
                                stroke="var(--accent2)"
                                strokeDasharray="4 4"
                                label={<AvgReferenceLabel value={trendAvg} />}
                              />
                            )}
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  </Card>
                )
              })()}

              {level === 'categories' && selectedGroup && groupTxnData.length > 0 && (
                <Card style={{ padding: 0, overflow: 'hidden' }}>
                  <div style={{
                    padding: '12px 16px', fontSize: 14, fontWeight: 600,
                    borderBottom: '1px solid var(--border)',
                    display: 'flex', alignItems: 'center', gap: 8,
                  }}>
                    <span>
                      {selectedGroup.group_name} · {groupTxnData.length} transactions
                      <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--muted)', marginLeft: 8 }}>
                        Click a category above to filter
                      </span>
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
                      <CopyTransactionsButton rows={groupTxnData} title={selectedGroup.group_name} tooltip="Copy the transactions shown" />
                      <Button variant="ghost" small onClick={selectedGroupBulk.toggle}>
                        {selectedGroupBulk.bulkMode ? '✕ Done' : 'Bulk Edit'}
                      </Button>
                    </div>
                  </div>
                  <div style={{ padding: '8px 12px 0' }}>
                    <BulkEditChrome controller={selectedGroupBulk} />
                  </div>
                  <TransactionListTable
                    rows={groupTxnData}
                    categories={categories}
                    {...selectedGroupBulk.tableProps}
                    onCategorySave={(txnId, catId, catObj) => {
                      const cat = catObj || categories.find(c => c.id === catId)
                      setGroupTxnData(prev => prev.map(x => x.id === txnId ? {
                        ...x,
                        category_id: catId,
                        category_name: cat?.name ?? null,
                        category_color: null,
                        category_overridden: 1,
                      } : x))
                      txnMutations.setCategory(txnId, catId)
                    }}
                    onRulePrompt={setRulePrompt}
                    onRowsChange={setGroupTxnData}
                    onTransactionOpenDetail={openTransactionDetail}
                    onTrashed={txnId => { reconcileDetailEdit(txnId, null); setGroupTxnDataTotal(prev => Math.max(0, prev - 1)) }}
                    columnConfig={groupTxnColumns}
                    onColumnConfigChange={setGroupTxnColumns}
                    maxHeight={320}
                  />
                </Card>
              )}
            </>
          )}

          {mode === 'trends' && (
            <TrendsPanel
              rows={trendRows}
              groups={trendGroups}
              selectedYear={trendYear}
              onYearChange={setTrendYear}
              drillGroup={trendGroup}
              onDrillGroup={g => setTrendGroup(g)}
              onClearDrill={() => setTrendGroup(null)}
              loading={trendLoading}
              viewIsIncome={viewIsIncome}
              onOpenMonth={month => openMonthDetail(month, dashboardView)}
              onOpenSinglePeriod={openSinglePeriodForMonth}
            />
          )}

          {mode === 'compare' && (
            <>
              <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
                <Card style={{ padding: '14px 24px' }}>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 2 }}>{periodLabel(periodA)}</div>
                  <div style={{ fontSize: 28, fontWeight: 700 }}>{formatCurrency(cmpTotalA)}</div>
                </Card>
                <Card style={{ padding: '14px 24px' }}>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 2 }}>{periodLabel(periodB)}</div>
                  <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--muted)' }}>{formatCurrency(cmpTotalB)}</div>
                  {cmpTotalB > 0 && (
                    <div style={{
                      fontSize: 12, marginTop: 2,
                      color: cmpTotalA > cmpTotalB ? 'var(--danger)' : 'var(--success)',
                    }}>
                      {cmpTotalA > cmpTotalB ? '▲' : '▼'} {Math.abs(((cmpTotalA - cmpTotalB) / cmpTotalB) * 100).toFixed(0)}% vs {periodLabel(periodA)}
                    </div>
                  )}
                </Card>
              </div>

              {cmpLevel !== 'groups' && (
                <Breadcrumb
                  items={cmpCrumbs}
                  onNavigate={() => { setCmpLevel('groups'); setCmpGroup(null) }}
                />
              )}

              {drillLoading ? <Spinner /> : (
                <Card>
                  <div style={{ display: 'flex', gap: 16, marginBottom: 12, fontSize: 12, alignItems: 'center' }}>
                    <span style={{ color: 'var(--text)', fontWeight: 600 }}>
                      {cmpLevel === 'groups' ? 'By group' : cmpGroup?.group_name}
                    </span>
                    <div style={{ display: 'flex', gap: 12, marginLeft: 'auto', fontSize: 11 }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ width: 20, height: 4, background: 'var(--accent)', display: 'inline-block', borderRadius: 2 }} />
                        {periodLabel(periodA)}
                      </span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ width: 20, height: 4, background: 'var(--accent)', opacity: 0.35, display: 'inline-block', borderRadius: 2 }} />
                        {periodLabel(periodB)}
                      </span>
                    </div>
                  </div>

                  {cmpLevel === 'groups' && coloredCmpGroups.map(g => (
                    <CompareRow
                      key={g.group_id}
                      label={g.group_name} color={g.group_color} kind="group"
                      a={g.totalA} b={g.totalB} maxVal={cmpMaxGroup}
                      onClick={() => cmpDrillToCategories(g)}
                    />
                  ))}

                  {cmpLevel === 'categories' && coloredCmpCats.map(c => (
                    <CompareRow
                      key={c.category_id}
                      label={c.category_name} color={c.category_color} kind="category"
                      a={c.totalA} b={c.totalB} maxVal={cmpMaxCat}
                      onClick={null}
                    />
                  ))}
                </Card>
              )}
            </>
          )}
        </>
      )}
      </div>
      {detailTxns.map((txn, index) => (
        <TransactionDetail
          key={txn.id}
          txn={txn}
          categories={categories}
          forceFloating={multiDetailMode}
          stackIndex={index}
          isTopmost={index === detailTxns.length - 1 && detailMonths.length === 0}
          onClose={() => closeTransactionDetail(txn.id)}
          onReconcile={reconcileDetailEdit}
          dateStart={dateStart || undefined}
          dateEnd={dateEnd || undefined}
        />
      ))}
      {detailMonths.map((entry, index) => (
        <MonthDetail
          key={entry.key}
          month={entry.month}
          view={entry.view}
          accountId={accountId || undefined}
          tagIds={tagIds}
          ownerIds={ownerIds}
          filters={summaryFilters}
          categories={categories}
          forceFloating={detailTxns.length + detailMonths.length + detailTagSignatures.length > 1}
          stackIndex={detailTxns.length + index}
          isTopmost={index === detailMonths.length - 1 && detailTagSignatures.length === 0}
          onClose={() => closeMonthDetail(entry.key)}
        />
      ))}
      {detailTagSignatures.map((entry, index) => (
        <TagDetail
          key={entry.key}
          signature={entry.signature}
          reportTagIds={entry.reportTagIds}
          reportName={entry.reportName}
          view={entry.view}
          accountId={entry.accountId || undefined}
          dateStart={entry.dateStart || undefined}
          dateEnd={entry.dateEnd || undefined}
          filterTagIds={entry.filterTagIds || undefined}
          categories={categories}
          forceFloating={detailTxns.length + detailMonths.length + detailTagSignatures.length > 1}
          stackIndex={detailTxns.length + detailMonths.length + index}
          isTopmost={index === detailTagSignatures.length - 1}
          onClose={() => closeTagDetail(entry.key)}
        />
      ))}
      {rulePrompt && (
        <RuleSuggestionToast
          prompt={rulePrompt}
          onSaved={({ applyToExisting, transactionIds }) => {
            // Patch the rule's recategorization onto whichever drill list shows the affected rows, in
            // place — they stay on the page (now with the new category) instead of vanishing on a refilter.
            if (!applyToExisting || !transactionIds?.length) return
            reconcileRowsAfterRuleApply(txnData, transactionIds, setTxnData)
            reconcileRowsAfterRuleApply(groupTxnData, transactionIds, setGroupTxnData)
          }}
          onDismiss={() => setRulePrompt(null)}
        />
      )}
      {tagBuilderOpen && (
        <TagReportBuilder
          availableTags={availableTags}
          onClose={() => setTagBuilderOpen(false)}
          onDisplay={handleDisplayTagReportTransient}
          onSave={handleSaveTagReport}
        />
      )}
      {pickerMenuOpen && (
        <PickerManageMenu
          anchorRect={pickerMenuOpen.anchorRect}
          onRename={() => setRenameTargetId(pickerMenuOpen.id)}
          onDelete={() => setDeleteTargetId(pickerMenuOpen.id)}
          onClose={() => setPickerMenuOpen(null)}
        />
      )}
      {renameTargetId && (() => {
        const target = savedTagReports.find(r => r.id === renameTargetId)
        if (!target) return null
        return (
          <RenameTagReportDialog
            initialName={target.name}
            onCancel={() => setRenameTargetId(null)}
            onSave={(newName) => {
              handleRenameTagReport(renameTargetId, newName)
              setRenameTargetId(null)
            }}
          />
        )
      })()}
      {deleteTargetId && (() => {
        const target = savedTagReports.find(r => r.id === deleteTargetId)
        if (!target) return null
        return (
          <AppDialog
            title="Delete tag report?"
            description={`"${target.name}" will be removed from your saved tag reports. The tags themselves are not affected.`}
            width="min(380px, 100%)"
            onClose={() => setDeleteTargetId(null)}
            actions={
              <>
                <Button variant="ghost" onClick={() => setDeleteTargetId(null)}>Cancel</Button>
                <Button onClick={() => {
                  handleDeleteTagReport(deleteTargetId)
                  setDeleteTargetId(null)
                }}>Delete</Button>
              </>
            }
          />
        )
      })()}
      {missingTagsToastReportId && (() => {
        const target = savedTagReports.find(r => r.id === missingTagsToastReportId)
        if (!target) return null
        return (
          <MissingTagsToast
            reportName={target.name}
            onDismiss={() => setMissingTagsToastReportId(null)}
            onSuppress={() => {
              handleDismissMissingWarning(missingTagsToastReportId)
              setMissingTagsToastReportId(null)
            }}
          />
        )
      })()}
    </div>
  )
}
