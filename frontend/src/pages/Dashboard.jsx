// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  BarChart, Bar, ComposedChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, ReferenceLine,
} from 'recharts'
import { api } from '../lib/api.js'
import { CLICKABLE_CHART_EVENTS, clickedDataIndex } from '../lib/chartInteraction.js'
import { CHART_PALETTE } from '../lib/chartPalette.js'
import { amountFilterParams, selectionsOfType, selectionsToParams } from '../lib/filterParams.js'
import { applyCategoryChange } from '../lib/txnMutations.js'
import TransactionDetail from '../components/TransactionDetail.jsx'
import PeriodDetail from '../components/PeriodDetail.jsx'
import TagDetail from '../components/TagDetail.jsx'
import { ActionMenu, ActionMenuButton } from '../components/ActionMenu.jsx'
import FeatureExplainer from '../help/FeatureExplainer.jsx'
import { useFilters, describeDateFilter } from '../lib/FilterContext.jsx'
import { useDismissibleLayer } from '../lib/uiInteractions.js'
import { useAfterLedgerSync } from '../contexts/SyncStatusContext.jsx'
import { formatCurrency, monthLabel, lastNMonths } from '../lib/utils.js'
import {
  shiftMonth, monthsInRange, lastDayOfMonthISO, trendsWindowRange, trendsWindowMonths, resolveTrendsWindowKey,
  trendsWindowOptions, isTrendsYearWindow, rowsMonthSpan,
  TREND_GRAIN_SAME_SPAN, calendarTrendBuckets, sameSpanTrendBuckets, trendGrainOptions, effectiveTrendGrain, trendGrainNoun,
} from '../lib/trendBuckets.js'
import {
  TREND_SPAN_ALL, TREND_SPAN_PREF_KEY,
  describeTrendSpan, trendSpanFloorMonth, trendSpanFloorYear,
} from '../lib/trendSpan.js'
import TrendSpanSelect from '../components/TrendSpanSelect.jsx'
import TrendsWindowSelect from '../components/TrendsWindowSelect.jsx'
import PanningChartFrame from '../components/PanningChartFrame.jsx'
import { periodReportKey } from '../lib/periodReportScope.js'
import {
  CHART_TOOLTIP_CONTENT_STYLE,
  CHART_TOOLTIP_ITEM_STYLE,
  CHART_TOOLTIP_LABEL_STYLE,
  formatMoneyMagnitude,
  formatSignedAxisTick,
  formatSignedMoneyAmount,
} from '../lib/moneyDisplay.js'
import { AppDialog, Button, Card, Input, PageHeader, Select, SegmentedToggle, RefreshButton, Spinner, StaleWhileRefreshing, EmptyState, FilterConflictNote, CategoryMarker, getFormControlStyle, IconButton, LinkButton } from '../components/ui.jsx'
import { computeReportSpendingConflicts, describeReportConflicts, resolveConflictSelectionIds } from '../lib/reportFilterConflicts.js'
import { useDashboardDefaultPeriod, DASHBOARD_DEFAULT_PERIOD_OPTIONS } from '../lib/dashboardDefaultPeriod.js'
import { TagGlyph } from '../components/TagUi.jsx'
import { format, subMonths } from 'date-fns'
import TransactionListTable from '../components/TransactionListTable.jsx'
import CopyTransactionsButton from '../components/CopyTransactionsButton.jsx'
import TransactionListToolbar from '../components/TransactionListToolbar.jsx'
import { useBulkTransactionEditing, BulkEditChrome } from '../lib/useBulkTransactionEditing.jsx'
import { useTransactionTableLayout } from '../lib/transactionTablePreferences.js'
import { usePagedTransactions } from '../components/detailShared.jsx'
import { useUserPreference, useDeferredPreference } from '../lib/UserPreferencesContext.jsx'
import { useTags } from '../lib/useTags.js'
import { OTHER_SLICE_COLOR, OTHER_SLICE_KEY, computeSlicePages } from '../lib/longTailSlices.js'
import CashFlowSankey from '../components/CashFlowSankey.jsx'
import { INFLOW, OUTFLOW, buildCashFlowGraph } from '../lib/cashFlowGraph.js'
import { buildCashFlowAnnualSeries, buildCashFlowTrendSeries } from '../lib/cashFlowTrend.js'
import { clampBarValue, computeClampedDomain } from '../lib/chartOutliers.js'
import ClippedBar from '../components/ClippedBar.jsx'
import PanningChartTooltip from '../components/PanningChartTooltip.jsx'
import {
  trendPlotLayout, centeredScrollLeft, bucketAnchorMonth, bucketIndexAtScroll, trendScrollTargetIndex,
} from '../lib/trendPlotLayout.js'
import { periodAverage, seriesDateRange } from '../lib/periodAverage.js'
import AvgPill from '../components/AvgPill.jsx'
import { avgPillText, avgPillWidth } from '../lib/axisLabelPlacement.js'
import AxisAvgPill from '../components/AxisAvgPill.jsx'
import { preventPressDefaults } from '../lib/pointerDrag.js'

const DASHBOARD_CATEGORY_TXN_TABLE_PREF_KEY = 'ui.dashboard.categoryTransactions.columns'
const DASHBOARD_GROUP_TXN_TABLE_PREF_KEY = 'ui.dashboard.groupTransactions.columns'
const DASHBOARD_SPENDING_VIEW_BY_PREF_KEY = 'ui.dashboard.spendingViewBy'
const DASHBOARD_VIEW_PREF_KEY = 'ui.dashboard.view'
// Left-panel ("Total per month") width fraction of the Trends month/annual split; the user drags the
// divider to rebalance and it persists. Defaults to giving the monthly chart a little more room than
// the annual one (its month labels are tighter than 4-digit years). Clamped to [MIN, MAX].
const DASHBOARD_TRENDS_SPLIT_PREF_KEY = 'ui.dashboard.trendsSplit'
// The trend chart is drawn as *two* charts side by side so the value axis can stay put while the plot
// pans: a fixed column carrying only the axis, and the scrolling plot with its own axis hidden. The two
// share one vertical geometry — height, top and bottom margins, and the space the category axis
// reserves — because that is what makes their scales identical and their gridlines line up. Change any
// of these and both charts must change together, or the axis quietly starts describing a scale the bars
// are not drawn to.
const TREND_CHART_HEIGHT = 224
const TREND_CHART_MARGIN_Y = 6
const TREND_XAXIS_HEIGHT = 48
// The sticky column, and the axis inside it. The column is the wider of the two by enough to hold the
// average pill, which is drawn over the tick labels rather than in the plot so that it stays visible at
// any pan position; the remaining few pixels are the gap the plot would otherwise butt straight up
// against.
const TREND_AXIS_COLUMN_WIDTH = 76
const TREND_AXIS_LABEL_WIDTH = 60
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
// A slot written by more than one caller (its scope effect, the in-place refresh after an edit or a sync,
// a drill) receives overlapping requests routinely, and only the newest may land. The ticket counts calls
// rather than comparing the query: two loads of one query still differ when the ledger changed between
// them, and an older answer arriving last would otherwise win.
function useLatestRequest() {
  const seq = useRef(0)
  return useCallback(() => {
    const ticket = ++seq.current
    return () => ticket === seq.current
  }, [])
}

function makeTagReportId() {
  return `tr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}
// The display-without-save report's id. It lives only in session state and never enters the catalog.
const TRANSIENT_TAG_REPORT_ID = '__transient__'

// The frame selector: which cross-cutting question the Single and Trends modes are answering. Cash flow
// is a *frame*, not a top-level mode, because it wants the same period, compare and trend machinery the
// other two use.
const DASHBOARD_VIEW_SPENDING = 'spending'
const DASHBOARD_VIEW_INCOME = 'income'
const DASHBOARD_VIEW_CASH_FLOW = 'cash_flow'

const DASHBOARD_VIEW_OPTIONS = [
  { value: DASHBOARD_VIEW_SPENDING, label: 'Expenses' },
  { value: DASHBOARD_VIEW_INCOME, label: 'Income' },
  { value: DASHBOARD_VIEW_CASH_FLOW, label: 'Cash flow' },
]

const DASHBOARD_MODE_OPTIONS = [
  { value: 'single', label: 'Single period' },
  { value: 'compare', label: 'Compare' },
  { value: 'trends', label: 'Trends' },
]

// Compare mode has no cash-flow form (its two-period breakdown is specified for spending and income
// only), and the frame selector is hidden there — so a persisted cash-flow preference has to be read as
// spending for that mode rather than leaking into loaders that have no branch for it.
function frameForMode(view, mode) {
  if (mode === 'compare' && view === DASHBOARD_VIEW_CASH_FLOW) return DASHBOARD_VIEW_SPENDING
  return view
}


// Turn the server's per-signature buckets (`[{ signature_tag_ids, total, count }]` from
// /summary/by-tag-signature) into display rows: name each by its tags (Other / Untagged for the empty
// signature), sink Other to the bottom and sort the rest by total desc, then assign palette colors. The
// bucketing itself is done server-side so the report can't truncate on large periods — only naming,
// coloring, and ordering stay on the client. The signature id (sorted ids joined by `|`) is a stable
// React key.
function buildTagSignatureRows(buckets, tagsById) {
  const rows = (buckets || []).map(b => {
    const ids = (b.signature_tag_ids || []).slice().sort()
    const isOther = ids.length === 0
    return {
      signature_id: isOther ? OTHER_SLICE_KEY : ids.join('|'),
      signature_tag_ids: ids,
      signature_name: isOther
        ? 'Other / Untagged'
        : ids.map(id => tagsById.get(id)?.name || '?').join(' + '),
      signature_color: isOther ? OTHER_SLICE_COLOR : null,
      is_other: isOther,
      // Signed net (the server no longer ABSes it): a signature whose refunds outweigh its spend reads
      // negative. The pie floors wedge geometry at zero; the list/tooltip show this true value.
      total: Number(b.total) || 0,
      count: Number(b.count) || 0,
    }
  })
  rows.sort((a, b) => {
    if (a.is_other && !b.is_other) return 1
    if (b.is_other && !a.is_other) return -1
    return b.total - a.total
  })
  let paletteIndex = 0
  for (const row of rows) {
    if (row.is_other) continue
    row.signature_color = CHART_PALETTE[paletteIndex % CHART_PALETTE.length]
    paletteIndex++
  }
  return rows
}

function periodLabel(p) {
  if (!p) return ''
  if (p.type === 'month') return monthLabel(p.month)
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
    { value: 'prior_month', label: 'Prior month' },
    { value: 'prior_year', label: 'Prior year' },
    { value: 'custom', label: 'Custom…' },
  ]
  if (periodA.type === 'year') return [
    { value: 'prior_year', label: 'Prior year' },
    { value: 'custom', label: 'Custom…' },
  ]
  if (periodA.type === 'custom') return [
    { value: 'prior_period', label: 'Prior period' },
    { value: 'prior_year', label: 'Prior year' },
    { value: 'custom', label: 'Custom…' },
  ]
  return []
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

// Do two date-filter values name the same period? Null-safe, and blind to the preset label.
function sameDateRange(a, b) {
  if (!a || !b) return !a && !b
  return (a.start ?? null) === (b.start ?? null) && (a.end ?? null) === (b.end ?? null)
}

// All-time lower bound for the trend fetch: passing an explicit (ancient) start makes the backend skip
// its rolling "last N months" window and return every month of data, which the calendar grains bucket
// whole and the same-span mode reads to know how far back the data goes.
const ALL_TIME_START = '1900-01-01'

// The chart rows for a bucket list, totalled by `totalOf(bucket, index)` — from the monthly rows for a
// calendar grain, from the matching `range-trend` row for same-span buckets.
function trendChartRows(buckets, totalOf) {
  return buckets.map((b, index) => ({
    bucketStart: b.start,
    bucketEnd: b.end,
    rangeStart: b.rangeStart,
    rangeEnd: b.rangeEnd,
    isSelected: b.isSelected,
    label: b.label ?? bucketLabel(b),
    fullLabel: b.fullLabel ?? b.label ?? bucketLabel(b),
    total: totalOf(b, index),
  }))
}

function monthlyBucketTotal(monthlyRows) {
  return b => (monthlyRows || []).reduce(
    (sum, r) => (r.month >= b.start && r.month <= b.end ? sum + (Number(r.total) || 0) : sum),
    0,
  )
}

// Empty buckets at either end are dropped — a calendar grain's first quarter or year can start before
// the data does, and same-span buckets can run past today — keeping the selection in place even when it
// is itself empty.
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

const now = new Date()
const thisM = format(now, 'yyyy-MM')
const lastM = format(subMonths(now, 1), 'yyyy-MM')
const thisY = String(now.getFullYear())
const lastY = String(now.getFullYear() - 1)

const PRESET_OPTIONS = [
  { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: 'this_year', label: 'This year' },
  { value: 'last_year', label: 'Last year' },
  { value: 'custom', label: 'Custom…' },
]

function presetToPeriod(preset) {
  if (preset === 'this_month') return { type: 'month', month: thisM }
  if (preset === 'last_month') return { type: 'month', month: lastM }
  if (preset === 'this_year') return { type: 'year', year: thisY }
  if (preset === 'last_year') return { type: 'year', year: lastY }
  return null
}

const RECENT_MONTHS = lastNMonths(24).map(m => ({ value: m, label: monthLabel(m) }))

// The period/compare/drill dropdowns share the app's form-control styling (components/ui.jsx). MD keeps
// its slightly rounder radius (8 vs the helper's 6) so the look is unchanged; SM is the compact
// month-range select that stretches to fill its row.
const DASH_SELECT_MD = { ...getFormControlStyle({ size: 'md', clickable: true }), borderRadius: 8 }

// The Trends forms' monthly bar charts fit their card up to a window's worth of months and pan past it
// (`PanningChartFrame`), each bar then keeping the width given here. The half-width Total per month
// card holds a year of staggered month labels; the full-width cash-flow chart holds three.
const TOTAL_PER_MONTH_FIT = 12
const TOTAL_PER_MONTH_BAR_WIDTH = 30
const CASH_FLOW_MONTHS_FIT = 36
const CASH_FLOW_MONTH_BAR_WIDTH = 24
const DASH_SELECT_SM = { ...getFormControlStyle({ size: 'sm', clickable: true }), flex: 1 }

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
  // Clamp to [0, 100]: a net-refund row has a negative signed value, which must read as an empty bar
  // rather than a negative width. The row's numeric label still shows the true signed amount.
  const pct = total > 0 ? Math.max(Math.min((value / total) * 100, 100), 0) : 0
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

// Reference-line label for the average line on the charts that scale to fit: a single "Avg $X" pill
// that sits on the line just inside the plot area. The single-period trend chart does not use this —
// it pans horizontally, so its pill goes in the sticky axis column instead (see AxisAvgPill).
function AvgReferenceLabel({ viewBox, value, align = 'left' }) {
  if (!viewBox) return null
  const labelY = viewBox.y ?? 0
  const innerX = viewBox.x ?? 0
  const innerW = viewBox.width ?? 0
  const text = avgPillText(value)
  // `align='right'` hugs the right edge of the plot area — used by the horizontally-scrolling annual
  // chart so the pill (and the right-side axis) stay visible in its default right-pinned view.
  const pillX = align === 'right' ? (innerX + innerW - avgPillWidth(text) - 2) : (innerX + 2)
  return <AvgPill x={pillX} centerY={labelY} text={text} />
}

// Annual totals can span many years, so the row pans (`PanningChartFrame`) rather than squashing every
// year in, re-pinned to its newest end whenever the data changes (e.g. switching spending/income or
// drilling a group).
function AnnualTotalsChart({ data, avg, selectedYear, onSelectYear }) {
  // Clicking a year's column focuses the monthly charts on that year (drives the window chooser). The
  // active year's bar is highlighted so it's clear which one the charts above are showing.
  const selectable = typeof onSelectYear === 'function'
  return (
    <PanningChartFrame minWidth={Math.max(260, data.length * 46)} height={180} pinKey={data}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          {...CLICKABLE_CHART_EVENTS}
          onClick={selectable ? (state => {
            const year = data[clickedDataIndex(state)]?.year
            if (year) onSelectYear(year)
          }) : undefined}
          style={selectable ? { cursor: 'pointer' } : undefined}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="year" tick={{ fill: 'var(--muted)', fontSize: 11 }} interval={0} />
          {/* Axis on the RIGHT so the $ scale stays visible in the default right-pinned (recent-years)
              view; with a left axis it scrolls off-screen until the user drags back to the start. */}
          <YAxis orientation="right" tickFormatter={formatSignedAxisTick} tick={{ fill: 'var(--muted)', fontSize: 11 }} />
          {/* This row pans, so the card is placed against what is visible — see PanningChartTooltip. */}
          <Tooltip
            content={<PanningChartTooltip />}
            isAnimationActive={false}
            formatter={v => formatSignedMoneyAmount(v)}
            contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
            labelStyle={CHART_TOOLTIP_LABEL_STYLE}
            itemStyle={CHART_TOOLTIP_ITEM_STYLE}
          />
          <Bar
            dataKey="total"
            radius={[3, 3, 0, 0]}
            name="Total"
          >
            {data.map(d => (
              <Cell
                key={d.year}
                fill={String(d.year) === String(selectedYear) ? 'var(--accent2)' : 'var(--accent)'}
              />
            ))}
          </Bar>
          {data.length > 1 && avg != null && (
            <ReferenceLine
              y={avg}
              stroke="var(--accent2)"
              strokeDasharray="4 4"
              label={<AvgReferenceLabel value={avg} align="right" />}
            />
          )}
        </BarChart>
      </ResponsiveContainer>
    </PanningChartFrame>
  )
}

function Breadcrumb({ items, onNavigate }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, marginBottom: 16 }}>
      {items.map((item, i) => (
        <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {i > 0 && <span style={{ color: 'var(--muted)' }}>›</span>}
          {i < items.length - 1 ? (
            <LinkButton onClick={() => onNavigate(i)} style={{ fontSize: 13 }}>{item}</LinkButton>
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
 *
 * Given a `report` it opens on that report's tags. A saved report is edited in place
 * (Save → `onSaveTags`, keeping its id and name); the transient one keeps the new-report
 * actions, since it has nothing to save over. Tags that no longer exist are not listed,
 * so saving drops them — the deliberate rebuild the missing-tags toast asks for.
 */
function TagReportBuilder({ availableTags, report = null, onClose, onDisplay, onSave, onSaveTags }) {
  const originalIds = report?.tagIds || []
  const [selectedIds, setSelectedIds] = useState(() => {
    const knownIds = new Set(availableTags.map(t => t.id))
    return new Set(originalIds.filter(id => knownIds.has(id)))
  })
  const [savePromptOpen, setSavePromptOpen] = useState(false)
  const hasSelection = selectedIds.size > 0
  const editingSaved = !!report && report.id !== TRANSIENT_TAG_REPORT_ID
  const changed = selectedIds.size !== originalIds.length || originalIds.some(id => !selectedIds.has(id))

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

  function handleConfirmSave(name) {
    if (!hasSelection) return
    onSave({ name, tagIds: Array.from(selectedIds) })
    onClose()
  }

  function handleSaveTags() {
    if (!hasSelection || !changed) return
    onSaveTags(Array.from(selectedIds))
    onClose()
  }

  const sortedTags = [...availableTags].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
  const title = editingSaved ? `Edit tag report · ${report.name}` : report ? 'Edit tag report' : 'New tag report'

  return (
    <>
      <AppDialog
        title={title}
        description="Pick the tags you want as wedges. Transactions matching multiple selected tags get their own combination wedge; everything else falls into Other / Untagged."
        width="min(480px, 100%)"
        onClose={onClose}
        actions={editingSaved ? (
          <>
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button onClick={handleSaveTags} disabled={!hasSelection || !changed}>Save</Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button variant="secondary" onClick={handleDisplay} disabled={!hasSelection}>Display</Button>
            <Button onClick={handleSaveAndDisplay} disabled={!hasSelection}>Save &amp; display</Button>
          </>
        )}
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
        <SaveTagReportDialog
          zIndex={1300}
          onCancel={() => setSavePromptOpen(false)}
          onSave={handleConfirmSave}
        />
      )}
    </>
  )
}

/*
 * Name prompt for saving a tag selection as a named report — the builder's "Save & display" step,
 * and "Save as…" on the unsaved custom report.
 */
function SaveTagReportDialog({ zIndex, onCancel, onSave }) {
  const [name, setName] = useState('')
  const trimmed = name.trim()
  return (
    <AppDialog
      title="Save tag report"
      description="The name will appear in the Spending-by picker."
      width="min(380px, 100%)"
      zIndex={zIndex}
      onClose={onCancel}
      actions={
        <>
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button onClick={() => onSave(trimmed)} disabled={!trimmed}>Save</Button>
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
  )
}

/*
 * Gear beside the "Dashboard" title: sets the per-user *default period* — what the shared date filter
 * means on the Dashboard when the user hasn't picked a range. A setting (persisted), not a filter, and
 * it never applies to other pages. The menu is the concrete periods (Year to date / Last 12 months /
 * All time); the first-visit seed picks the initial one automatically (see useDashboardDefaultPeriod).
 */
function DashboardDefaultPeriodGear({ pref, setPref }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef(null)
  const popRef = useRef(null)
  useDismissibleLayer({ open, onClose: () => setOpen(false), refs: [btnRef, popRef], closeOnScrollResize: true })
  return (
    <div style={{ position: 'relative' }}>
      <IconButton
        ref={btnRef}
        onClick={() => setOpen(v => !v)}
        aria-label="Dashboard default period"
        title="Set the Dashboard's default time period"
        style={{ fontSize: 16 }}
      >⚙</IconButton>
      {open && (
        <div
          ref={popRef}
          style={{
            position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 1400,
            minWidth: 220, background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 10, boxShadow: '0 18px 44px rgba(15, 23, 42, 0.28)', padding: '8px 0',
          }}
        >
          <div style={{
            padding: '4px 14px 8px', fontSize: 11, fontWeight: 600, color: 'var(--muted)',
            textTransform: 'uppercase', letterSpacing: '0.05em'
          }}>
            Default period
          </div>
          {DASHBOARD_DEFAULT_PERIOD_OPTIONS.map(opt => {
            const selected = pref === opt.value
            return (
              <div
                key={opt.value}
                onClick={() => { setPref(opt.value); setOpen(false) }}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                  padding: '7px 14px', cursor: 'pointer', fontSize: 13,
                  background: selected ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent',
                }}
              >
                <span style={{ fontWeight: selected ? 600 : 400 }}>{opt.label}</span>
                {selected && <span style={{ color: 'var(--accent2)', fontSize: 11 }}>✓</span>}
              </div>
            )
          })}
        </div>
      )}
    </div>
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
      <IconButton aria-label="Dismiss" onClick={onDismiss} style={{ position: 'absolute', top: 6, right: 8, fontSize: 18 }}>×</IconButton>
      <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.45, marginBottom: 8, paddingRight: 14 }}>
        Some tags in <strong>{reportName}</strong> no longer exist and have been ignored. Use <em>Edit tags…</em> on the report to rebuild it deliberately.
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <LinkButton onClick={onSuppress} style={{ padding: '4px 6px', fontSize: 12 }}>
          Don&apos;t remind me again
        </LinkButton>
      </div>
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
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
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
  const [customEnd, setCustomEnd] = useState(thisM)

  function applyPreset(p) {
    setPreset(p)
    if (p !== 'custom') onChange(presetToPeriod(p))
  }

  function applyCustom() {
    if (customStart && customEnd) {
      const start = customStart < customEnd ? customStart : customEnd
      const end = customStart < customEnd ? customEnd : customStart
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
        style={DASH_SELECT_MD}
      >
        {PRESET_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {preset === 'custom' && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <select
            value={customStart}
            onChange={e => setCustomStart(e.target.value)}
            style={DASH_SELECT_SM}
          >
            {RECENT_MONTHS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>to</span>
          <select
            value={customEnd}
            onChange={e => setCustomEnd(e.target.value)}
            style={DASH_SELECT_SM}
          >
            {RECENT_MONTHS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <Button size="compact" onClick={applyCustom}>Go</Button>
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
        style={DASH_SELECT_MD}
      >
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {mode === 'custom' && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <select
            value={customStart}
            onChange={e => onCustomStartChange(e.target.value)}
            style={DASH_SELECT_SM}
          >
            {RECENT_MONTHS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>to</span>
          <select
            value={customEnd}
            onChange={e => onCustomEndChange(e.target.value)}
            style={DASH_SELECT_SM}
          >
            {RECENT_MONTHS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <Button size="compact" onClick={onCustomApply}>Go</Button>
        </div>
      )}
    </div>
  )
}


function assignColors(rows, colorKey) {
  return rows.map((r, i) => ({
    ...r,
    [colorKey]: CHART_PALETTE[i % CHART_PALETTE.length],
    _chartColor: CHART_PALETTE[i % CHART_PALETTE.length],
  }))
}

// The headline figures above a Single-mode breakdown. Every one of them is scope-signed — a period that
// net-refunded reads negative rather than being flattened to a magnitude.
function SummaryTotalCard({ label, value, color }) {
  return (
    <Card style={{ padding: '14px 24px' }}>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color }}>{formatSignedMoneyAmount(value)}</div>
    </Card>
  )
}

function CompareRow({ label, color, kind = 'category', a, b, maxVal, onClick }) {
  const diff = a - b
  // A percent change is only meaningful against a positive prior period. When B <= 0 (a net refund, or
  // no activity) fall back to the absolute dollar change, which is always meaningful — e.g. a category
  // that swung from a -$741 refund to +$2,960 of spend shows "▲ +$3,701", not a nonsensical percent.
  const diffPct = b > 0 ? ((a - b) / b) * 100 : null
  const badgeText = diffPct !== null
    ? `${Math.abs(diffPct).toFixed(0)}%`
    : (diff !== 0 ? `${diff > 0 ? '+' : '-'}${formatCurrency(diff)}` : null)
  // Bars floor at zero: a net-refund period (negative total) renders an empty bar rather than a broken
  // negative width; the true signed amount is shown in the text below.
  const barPct = v => `${maxVal > 0 ? Math.max((v / maxVal) * 100, 0) : 0}%`
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
        {badgeText !== null && (
          <span style={{
            fontSize: 11, fontWeight: 600, padding: '1px 6px', borderRadius: 99,
            background: diff > 0 ? 'color-mix(in srgb, var(--danger) 13%, transparent)' : 'color-mix(in srgb, var(--success) 13%, transparent)',
            color: diff > 0 ? 'var(--danger)' : 'var(--success)',
          }}>
            {diff > 0 ? '▲' : '▼'} {badgeText}
          </span>
        )}
        {onClick && <span style={{ color: 'var(--muted)', fontSize: 14 }}>›</span>}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{ height: 5, background: 'var(--surface2)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ width: barPct(a), height: '100%', background: color, opacity: 1, borderRadius: 3 }} />
          </div>
          <div style={{ height: 5, background: 'var(--surface2)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ width: barPct(b), height: '100%', background: color, opacity: 0.35, borderRadius: 3 }} />
          </div>
        </div>
        <div style={{ textAlign: 'right', minWidth: 120 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{formatSignedMoneyAmount(a)}</span>
          <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 6 }}>vs {formatSignedMoneyAmount(b)}</span>
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

/*
 * The cash-flow frame's Trends form: what came in and what went out, year by year above and month by
 * month below.
 *
 * Where the spending and income trends stack one side of the ledger, cash flow has two sides that must
 * stay legible against each other — so both charts draw **diverging bars around a zero centerline**,
 * money in above and money out below, with the net as a line across them and the average net as the
 * usual reference line. Reading a period is then one glance: how tall each half is, and which side the
 * line sits on.
 *
 * The two charts are stacked rather than set side by side as the other frames' monthly and annual charts
 * are: nothing else shares this page, so each gets the full width. The yearly chart is the way into the
 * monthly one — clicking a year sets the monthly chart's window to it, and that year's bars are the
 * highlighted ones. The window chooser sits on the monthly chart's card, since that chart is all it
 * moves; the yearly chart's span chooser sits on its own for the same reason.
 *
 * The bars come pre-netted per category from `/summary/monthly-cash-flow` (per month, and per year at
 * `granularity=year`), which is what makes a period's two halves the same figures as that period's
 * Sankey sides rather than a separate gross reading of the same ledger. The net line is
 * `inflow - outflow` by construction, so it cannot drift from the bars it is drawn over.
 */
function CashFlowTrendsPanel({ rows, annualRows, selectedYear, onYearChange, span, onSpanChange, loading, onOpenMonth, onOpenSinglePeriod }) {
  // Window selection and row shaping are pure and live in lib/cashFlowTrend.js, where they can be
  // exercised without a chart — the diverging-bar sign contract below depends on them.
  const { windowOptions, effectiveWindow, chartData, avgNet } = buildCashFlowTrendSeries(rows, selectedYear)
  // The yearly chart is bounded by the shared trend span, the monthly one by its own window chooser.
  const annualMonths = (rows || []).map(r => r?.month).filter(Boolean).sort()
  const annual = buildCashFlowAnnualSeries(
    annualRows,
    trendSpanFloorYear(span, annualMonths[annualMonths.length - 1] || null),
  )

  const lastClickRef = useRef({ idx: -1, time: 0 })
  function handleMonthClick(idx) {
    const monthKey = chartData[idx].monthKey
    if (!onOpenSinglePeriod) {
      onOpenMonth(monthKey)
      return
    }
    // Same split the single-period trend uses: one click opens the month's transactions, a double-click
    // takes the whole single-period view there. Recharts gives a Bar no dblclick event, so the second
    // click is detected against a short window.
    const now = Date.now()
    const prev = lastClickRef.current
    if (prev.idx === idx && now - prev.time < 400) {
      lastClickRef.current = { idx: -1, time: 0 }
      onOpenSinglePeriod(monthKey)
    } else {
      lastClickRef.current = { idx, time: now }
      onOpenMonth(monthKey)
    }
  }

  // First load gets the spinner; a reload keeps what is on screen rather than swapping it for one.
  // Keyed on the incoming rows, not the derived series, so a year selection that happens to be empty
  // does not read as still-loading.
  if (loading && (rows || []).length === 0) return <Spinner />

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Yearly trend</div>
          <TrendSpanSelect
            value={span}
            onChange={onSpanChange}
            dataFirstMonth={annualMonths[0] || null}
            dataLastMonth={annualMonths[annualMonths.length - 1] || null}
            grain="year"
          />
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
          {annual.avgNet == null ? null : (
            <>Avg net: <span style={{ color: 'var(--accent2)', fontWeight: 600 }}>{formatSignedMoneyAmount(annual.avgNet)}/yr</span>{' · '}</>
          )}
          {'click a year to show its months below'}
        </div>
        {annual.chartData.length === 0 ? (
          <EmptyState message="No cash flow for this selection" />
        ) : (
          <CashFlowDivergingChart
            data={annual.chartData}
            xKey="year"
            height={220}
            avgNet={annual.avgNet}
            // A window that is not a year highlights none and dims none.
            isHighlighted={isTrendsYearWindow(effectiveWindow) ? d => d.year === effectiveWindow : undefined}
            onSelect={idx => onYearChange(annual.chartData[idx].year)}
          />
        )}
      </Card>

      <Card>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Monthly trend</div>
          <TrendsWindowSelect value={effectiveWindow} options={windowOptions} onChange={onYearChange} compact />
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
          {avgNet == null ? null : (
            <>Avg net: <span style={{ color: 'var(--accent2)', fontWeight: 600 }}>{formatSignedMoneyAmount(avgNet)}/mo</span>{' · '}</>
          )}
          {'click a month to open a transaction report'}
        </div>
        {chartData.length === 0 ? (
          <EmptyState message="No cash flow for this selection" />
        ) : (
          <CashFlowDivergingChart
            data={chartData}
            xKey="month"
            height={320}
            avgNet={avgNet}
            onSelect={handleMonthClick}
            panMinWidth={chartData.length > CASH_FLOW_MONTHS_FIT ? chartData.length * CASH_FLOW_MONTH_BAR_WIDTH : null}
          />
        )}
      </Card>
    </div>
  )
}

// One cash-flow period chart: money in above zero, money out below, the net across them and the average
// net as a reference line. `isHighlighted` (optional) dims every other period's bars. `panMinWidth`
// (optional) is the width the bars need when there are too many to fit the card: the chart then pans.
function CashFlowDivergingChart({ data, xKey, height, avgNet, isHighlighted, onSelect, panMinWidth = null }) {
  function handleClick(state) {
    const idx = clickedDataIndex(state)
    if (idx == null || !data[idx]) return
    onSelect(idx)
  }
  const dimmed = d => (isHighlighted ? !isHighlighted(d) : false)
  const pans = panMinWidth != null
  const chart = (
    <ResponsiveContainer width="100%" height={pans ? '100%' : height}>
      <ComposedChart data={data} {...CLICKABLE_CHART_EVENTS} onClick={handleClick} style={{ cursor: 'pointer' }}
        stackOffset="sign" margin={{ top: 8, right: 12, bottom: 6, left: pans ? 24 : 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        {/* Every period gets a label up to a dozen; past that, thin them out rather than letting them
            overlap. A panning chart's bars have a fixed width, so it labels every third. */}
        <XAxis dataKey={xKey} tick={{ fill: 'var(--muted)', fontSize: 10 }}
          interval={pans ? 2 : data.length <= 12 ? 0 : Math.floor(data.length / 12)} />
        <YAxis orientation={pans ? 'right' : 'left'} tickFormatter={formatSignedAxisTick} tick={{ fill: 'var(--muted)', fontSize: 11 }} />
        <Tooltip
          {...(pans ? { content: <PanningChartTooltip />, isAnimationActive: false } : {})}
          // The series names carry the direction, so the two bars read as magnitudes; only the net is signed.
          formatter={(value, name, item) => {
            if (name === 'Money in') return [formatMoneyMagnitude(value), name]
            if (name === 'Money out') return [formatMoneyMagnitude(item?.payload?.outflowMagnitude ?? 0), name]
            return [formatSignedMoneyAmount(value), name]
          }}
          contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
          labelStyle={CHART_TOOLTIP_LABEL_STYLE}
          itemStyle={CHART_TOOLTIP_ITEM_STYLE}
        />
        <ReferenceLine y={0} stroke="var(--muted)" />
        {/* The diverging pair, and the two things holding it up — both silent if broken.
            `stackOffset="sign"` on the chart above keeps separate positive and negative
            accumulators, so money in stacks up from zero and money out stacks down from zero.
            Without it recharts' default chains the second bar from the *top of the first*
            regardless of sign, which draws money out downward from the money-in bar and lands it
            exactly on the net: the chart then shows money in, the net twice over (as the
            unoverlapped remainder of the first bar, and as whatever crosses below zero), and money
            out nowhere at all — with correct tooltips throughout. The prop reads like a removable
            nicety and is not one. It also requires `outflow` to arrive **negative**, which is the
            contract `buildCashFlowTrendSeries` and `buildCashFlowAnnualSeries` are written to;
            magnitude rides along separately as `outflowMagnitude` for the tooltip. */}
        <Bar dataKey="inflow" name="Money in" stackId="cashflow" fill="var(--success)" fillOpacity={0.75}>
          {data.map(d => <Cell key={d[xKey]} fillOpacity={dimmed(d) ? 0.3 : 0.75} />)}
        </Bar>
        <Bar dataKey="outflow" name="Money out" stackId="cashflow" fill="var(--danger)" fillOpacity={0.65}>
          {data.map(d => <Cell key={d[xKey]} fillOpacity={dimmed(d) ? 0.25 : 0.65} />)}
        </Bar>
        <Line type="monotone" dataKey="net" name="Net" stroke="var(--accent)" strokeWidth={2} dot={false} />
        {avgNet == null ? null : (
          <ReferenceLine y={avgNet} stroke="var(--accent2)" strokeDasharray="4 4"
            label={<AvgReferenceLabel value={avgNet} align={pans ? 'right' : 'left'} />} />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  )
  if (!pans) return chart
  return (
    <PanningChartFrame minWidth={panMinWidth} height={height} pinKey={`${data.length}:${data[0]?.[xKey]}`}>
      {chart}
    </PanningChartFrame>
  )
}

function TrendsPanel({ rows, groups, onYearChange, trendWindow, span, onSpanChange, drillGroup, pickedGroup = drillGroup, onDrillGroup, onClearDrill, loading, viewIsIncome, onOpenMonth, onOpenReport, onOpenSinglePeriod }) {
  const lastBarClickRef = useRef({ key: null, time: 0 })
  const lastAreaClickRef = useRef({ idx: -1, time: 0 })
  // Sort state for the "Monthly averages by group" report at the bottom. Defaults to total
  // descending to match the natural "biggest-first" reading users expect from a spending list.
  const [sortKey, setSortKey] = useState('total')
  const [sortDir, setSortDir] = useState('desc')

  // Draggable divider between "Total per month" (left) and "Annual totals" (right): a persisted
  // left-panel width fraction. The continuous drag goes through useDeferredPreference so it only
  // persists once on release (setPreference writes on every call); we wire the cursor→fraction math
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
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    const priorUserSelect = document.body.style.userSelect
    document.body.style.userSelect = 'none'  // suppress text selection while dragging
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
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
  // Blank until the first series arrives: a spinner, or the empty states that charts with no rows would
  // draw, would each flash for what is almost always a few milliseconds. A reload keeps the tab on screen
  // instead (StaleWhileRefreshing below). Swapping it out for a loading state collapsed the page, which
  // threw a drill started from the averages table at the bottom back up to the top.
  if (rows == null || !trendWindow) return null

  const normalizedRows = rows.filter(r =>
    typeof r?.month === 'string' &&
    /^\d{4}-\d{2}$/.test(r.month)
  )

  // The window — a rolling run of months, all data or a year, see `trendsWindowRange` — is resolved by
  // the page, which also fetches the group picker's options for it. A window longer than a year does not
  // compress the monthly bars: Total per month pans instead.
  const effectiveYear = trendWindow.key
  // Also the range a report opened from one of this window's figures lists, so the two cannot disagree.
  const reportWindow = trendWindow
  const filteredRows = normalizedRows.filter(r => r.month >= reportWindow.startMonth && r.month <= reportWindow.endMonth)


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
  const allViewRows = normalizedRows.filter(r => viewSeriesIds.has(r.series_id))
  const dataStartMonth = allViewRows.reduce((min, r) => (min === null || r.month < min ? r.month : min), null)
  // Every month the charts and averages run across, months with no rows included — a gap drawn as
  // adjacent bars, and an average taken over only the months that had spending, both overstated how
  // steady and how large it was. Floored at this view's first month of data, as the run rate is.
  const allMonths = trendsWindowMonths(trendWindow, thisM, dataStartMonth)

  // Stacked bands are floored at zero: a group that net-refunded a month (negative net) would otherwise
  // stack below the axis and muddle the stack, so it renders as no-spend instead. The band's *true*
  // signed net rides along under `${id}__net` so the tooltip can show the accurate figure even where the
  // drawn band is clamped to zero. Every numeric total below (bar chart, annual, averages) uses the real
  // signed net, not this floored value.
  const chartData = allMonths.map(m => {
    const entry = { month: monthLabel(m), monthKey: m }
    for (const s of series) {
      const row = filteredRows.find(r => r.month === m && r.series_id === s.id)
      const net = row ? row.total : 0
      entry[s.id] = Math.max(net, 0)
      entry[`${s.id}__net`] = net
    }
    return entry
  })

  // Every per-month figure on this tab divides by the days the window covers, not by how many month
  // buckets were drawn (`periodAverage.js`). The span is the window's — the first and last transaction
  // anywhere in it — rather than each series' own, deliberately: a column of Avg/mo where one row
  // divided by three months and the next by twelve would not be comparable down the column, and a group
  // that bought nothing in a month did have that month. Months the axis filled in carry no dates and so
  // cannot widen the span.
  const monthsShown = new Set(allMonths)
  const { firstDate: windowFirstDate, lastDate: windowLastDate } =
    seriesDateRange(filteredRows.filter(r => monthsShown.has(r.month)))

  const avgBySeries = series.map(s => {
    const totals = allMonths.map(m => {
      const r = filteredRows.find(x => x.month === m && x.series_id === s.id)
      return r ? r.total : 0
    })
    const total = totals.reduce((a, b) => a + b, 0)
    const avg = periodAverage(total, windowFirstDate, windowLastDate, 'month')
    return { ...s, avg, total }
  }).sort((a, b) => b.total - a.total)
  // The by-group chart keeps one order for the whole window, so a group holds its place as the pointer
  // moves across months: the tooltip lists it largest first, and the bands stack smallest at the bottom,
  // so the two read the same way down the chart. Colors stay with the group, not the rank.
  const seriesRank = new Map(avgBySeries.map((s, i) => [s.id, i]))
  const stackedSeries = [...avgBySeries].reverse()

  // Annual totals cover every year in the dataset the span reaches, independent of the window chooser up
  // top. Drilling into one year shouldn't collapse this chart down to a single bar, and the span is the
  // only thing that narrows it — set on the chart itself, since it is the chart it governs here.
  // Whole years: a span starting mid-year draws the year containing it (`lib/trendSpan.js`), and the
  // average below divides by the days those rows actually span, so a part year counts as its own length.
  const dataLastMonth = allViewRows.reduce((max, r) => (max === null || r.month > max ? r.month : max), null)
  const annualFloorYear = trendSpanFloorYear(span, dataLastMonth)
  const annualRows = annualFloorYear
    ? allViewRows.filter(r => r.month.slice(0, 4) >= annualFloorYear)
    : allViewRows
  const yearMap = {}
  for (const r of annualRows) {
    const yr = r.month.slice(0, 4)
    yearMap[yr] = (yearMap[yr] || 0) + r.total
  }
  const annualData = Object.entries(yearMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([year, total]) => ({ year, total }))
  // Per elapsed year, not per bar. A plain mean breaks every January: the current year is a two-week
  // stub drawn beside full years, and the line whose job is "what a typical year looks like" is dragged
  // down by it, recovering slowly over the next twelve months. For full years the two agree.
  const { firstDate: annualFirstDate, lastDate: annualLastDate } = seriesDateRange(annualRows)
  const annualAvg = periodAverage(
    annualData.reduce((s, r) => s + r.total, 0), annualFirstDate, annualLastDate, 'year',
  )

  // Trailing-12-month run rate per month, computed over the *full* view series (not the year-filtered
  // view), so the line for the first on-screen month can reach back into prior, off-screen months. A
  // 12-month window counts each annual bill once, quarterly four times, etc. — the amortized monthly
  // burn — so it reads as the spending trend rather than the lumpy month-to-month total.
  const fullMonthlyMap = {}
  for (const r of allViewRows) fullMonthlyMap[r.month] = (fullMonthlyMap[r.month] || 0) + r.total

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
  const overallAvg = periodAverage(
    monthlyTotal.reduce((s, r) => s + r.total, 0), windowFirstDate, windowLastDate, 'month',
  )
  const latestRunRate = [...monthlyTotal].reverse().find(r => r.runRate != null)?.runRate ?? null

  function handleMonthBarClick(d) {
    if (!d?.monthKey || !onOpenMonth) return
    // Recharts doesn't surface a dblclick event on a chart, so detect it manually with a short window
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

  // Same double-click trick on the top area chart, where Recharts gives us the index of the point
  // under the cursor, which maps back to its month.
  function handleAreaClick(state) {
    const idx = clickedDataIndex(state)
    if (idx == null || !onOpenSinglePeriod) return
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

  const windowOptions = trendsWindowOptions(normalizedRows.map(r => r.month.slice(0, 4)))
  const monthlyTotalPans = monthlyTotal.length > TOTAL_PER_MONTH_FIT

  // The averages table's trailing column carries the group rows' drill chevron.
  const averagesColumns = '1fr 100px 100px 100px 20px'

  // The groups with transactions in the window, alphabetically. A drilled group with none there stays
  // listed, so changing the year leaves the picker naming what the charts show rather than going blank.
  // The picker shows `pickedGroup` — the drill asked for — while everything else shows `drillGroup`, the
  // group whose figures are on screen: an input answers the choice at once, and the output changes when
  // the figures do, rather than the select snapping back until they arrive.
  const pickerGroups = pickedGroup && !groups.some(g => g.group_id === pickedGroup.series_id)
    ? [...groups, { group_id: pickedGroup.series_id, group_name: pickedGroup.series_name }]
    : groups
  const groupOptions = [
    { value: '', label: 'All groups' },
    ...[...pickerGroups]
      .sort((a, b) => String(a.group_name || '').localeCompare(String(b.group_name || '')))
      .map(g => ({ value: g.group_id, label: g.group_name })),
  ]

  return (
    <StaleWhileRefreshing refreshing={loading} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <TrendsWindowSelect value={effectiveYear} options={windowOptions} onChange={onYearChange} />
        <select
          value={pickedGroup?.series_id || ''}
          onChange={e => {
            if (!e.target.value) { onClearDrill(); return }
            const g = groups.find(x => x.group_id === e.target.value)
            if (g) onDrillGroup({ series_id: g.group_id, series_name: g.group_name, series_color: g.group_color })
          }}
          style={DASH_SELECT_MD}
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
              {...CLICKABLE_CHART_EVENTS}
              onClick={onOpenSinglePeriod ? handleAreaClick : undefined}
              style={onOpenSinglePeriod ? { cursor: 'pointer' } : undefined}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="month" tick={{ fill: 'var(--muted)', fontSize: 10 }}
                interval={Math.floor(allMonths.length / 8)} />
              <YAxis tickFormatter={formatSignedAxisTick} tick={{ fill: 'var(--muted)', fontSize: 11 }} />
              <Tooltip
                formatter={(v, name, item) => {
                  const s = series.find(x => x.id === name)
                  // Show the true signed net (`__net`), not the zero-floored value the band is drawn at.
                  const net = item?.payload?.[`${name}__net`]
                  return [formatSignedMoneyAmount(net ?? v), s ? s.name : name]
                }}
                itemSorter={item => seriesRank.get(item.dataKey)}
                offset={20}
                contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
                labelStyle={CHART_TOOLTIP_LABEL_STYLE}
                itemStyle={CHART_TOOLTIP_ITEM_STYLE}
              />
              {stackedSeries.map(s => (
                <Area key={s.id} type="monotone" dataKey={s.id}
                  stroke={s.color} fill={s.color} fillOpacity={0.15}
                  strokeWidth={1.5} stackId="1" name={s.id} />
              ))}
              {overallAvg == null ? null : (
                <ReferenceLine
                  y={overallAvg}
                  stroke="var(--accent2)"
                  strokeDasharray="4 4"
                  label={<AvgReferenceLabel value={overallAvg} />}
                />
              )}
            </AreaChart>
          </ResponsiveContainer>
        )}
      </Card>

      <div ref={splitRowRef} style={{ display: 'grid', gridTemplateColumns: `${leftFr}fr 16px ${1 - leftFr}fr`, position: 'relative', zIndex: 1, minWidth: 0 }}>
        <Card style={{ position: 'relative', zIndex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Total per month</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
            {latestRunRate != null
              ? <>12-mo run rate: <span style={{ color: 'var(--accent2)', fontWeight: 600 }}>{formatSignedMoneyAmount(latestRunRate)}/mo</span></>
              : overallAvg == null ? null : <>Avg: {formatSignedMoneyAmount(overallAvg)}/mo</>}
            {' · double-click a bar to open that month'}
          </div>
          {/* Up to a year of bars fits the panel, with no scroll, so the tooltip's built-in edge-flip
              happens at the visible panel edge. A longer window pans instead of squashing its bars, and
              then takes the panning tooltip and a right-hand axis — see PanningChartFrame. */}
          <PanningChartFrame
            minWidth={monthlyTotalPans ? monthlyTotal.length * TOTAL_PER_MONTH_BAR_WIDTH : 0}
            height={180}
            pinKey={`${effectiveYear}:${monthlyTotal.length}:${drillGroup?.series_id || ''}:${viewIsIncome}`}
          >
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={monthlyTotal}
                // With the axis on the right there is nothing on the left to hold the first label's overhang.
                margin={{ top: 6, right: 12, bottom: 6, left: monthlyTotalPans ? 24 : 0 }}
                {...CLICKABLE_CHART_EVENTS}
                onClick={onOpenMonth ? (state => handleMonthBarClick(monthlyTotal[clickedDataIndex(state)])) : undefined}
                style={onOpenMonth ? { cursor: 'pointer' } : undefined}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis
                  dataKey="month"
                  interval={0}
                  tickLine={false}
                  height={monthlyTotal.length > 8 ? 40 : 22}
                  tick={<StaggeredMonthTick />}
                />
                <YAxis orientation={monthlyTotalPans ? 'right' : 'left'} tickFormatter={formatSignedAxisTick} tick={{ fill: 'var(--muted)', fontSize: 10 }} />
                <Tooltip
                  {...(monthlyTotalPans ? { content: <PanningChartTooltip />, isAnimationActive: false } : {})}
                  formatter={v => formatSignedMoneyAmount(v)}
                  allowEscapeViewBox={{ x: false, y: false }}
                  contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
                  labelStyle={CHART_TOOLTIP_LABEL_STYLE}
                  itemStyle={CHART_TOOLTIP_ITEM_STYLE}
                />
                <Bar
                  dataKey="total"
                  fill="var(--accent)"
                  radius={[3, 3, 0, 0]}
                  name="Total"
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
          </PanningChartFrame>
        </Card>

        <div
          role="separator"
          aria-orientation="vertical"
          title="Drag to resize · double-click to reset"
          onPointerDown={event => { preventPressDefaults(event); setSplitLive(leftFr) }}
          onDoubleClick={resetSplit}
          style={{ cursor: 'col-resize', display: 'flex', alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch', touchAction: 'none' }}
        >
          <div style={{
            width: 4, height: 44, borderRadius: 3,
            background: draggingSplit ? 'var(--accent)' : 'var(--border)',
            transition: 'background 0.15s',
          }} />
        </div>

        <Card style={{ position: 'relative', zIndex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{viewIsIncome ? 'Annual income totals' : 'Annual totals'}</div>
            <TrendSpanSelect
              value={span}
              onChange={onSpanChange}
              dataFirstMonth={dataStartMonth}
              dataLastMonth={dataLastMonth}
              grain="year"
            />
          </div>
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
          <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 8 }}>{trendWindow.label.toLowerCase()}</span>
          {!drillGroup && (
            <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--muted)', marginLeft: 8 }}>· click a group to see its categories</span>
          )}
        </div>
        {/* The group picker above is a long way up from here, so the drill offers its way back in place. */}
        {drillGroup && <Breadcrumb items={['All groups', drillGroup.series_name]} onNavigate={onClearDrill} />}
        <div style={{
          display: 'grid', gridTemplateColumns: averagesColumns,
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
          <span />
        </div>
        {(() => {
          const sign = sortDir === 'asc' ? 1 : -1
          return [...avgBySeries].sort((a, b) => {
            if (sortKey === 'name') return sign * String(a.name || '').localeCompare(String(b.name || ''))
            // `avg` is null where the window is under a month; sort those as zero rather than
            // letting NaN comparisons shuffle the table into an arbitrary order.
            if (sortKey === 'avg') return sign * ((a.avg ?? 0) - (b.avg ?? 0))
            return sign * (a.total - b.total)
          })
        })().map(s => {
          const grandTotal = avgBySeries.reduce((sum, x) => sum + x.total, 0)
          const pct = grandTotal > 0 ? (s.total / grandTotal * 100).toFixed(1) : 0
          // A group row drills to its categories — the same drill as the group picker above — and a
          // category row, the bottom of the hierarchy, opens the transactions behind its figure.
          const drillsToCategories = !drillGroup
          const drill = () => onDrillGroup({ series_id: s.id, series_name: s.name, series_color: s.color })
          return (
            <div
              key={s.id}
              role={drillsToCategories ? 'button' : undefined}
              tabIndex={drillsToCategories ? 0 : undefined}
              aria-label={drillsToCategories ? `Show the categories in ${s.name}` : undefined}
              onClick={drillsToCategories ? drill : undefined}
              onKeyDown={drillsToCategories ? event => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); drill() }
              } : undefined}
              style={{
                display: 'grid', gridTemplateColumns: averagesColumns,
                padding: '5px 12px', alignItems: 'center',
                borderBottom: '1px solid var(--border)', fontSize: 13,
                cursor: drillsToCategories ? 'pointer' : 'default',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.color, flexShrink: 0 }} />
                <CategoryMarker kind={drillGroup ? 'category' : 'group'} />
                <span>{s.name}</span>
                {!drillsToCategories && onOpenReport && (
                  <IconButton
                    size="compact"
                    tone="accent"
                    onClick={() => onOpenReport(
                      { start: reportWindow.start, end: reportWindow.end, label: reportWindow.label },
                      { kind: 'category', id: s.id, name: s.name },
                    )}
                    aria-label={`Open the transactions behind ${s.name}`}
                    title="Open the transactions behind this total"
                    style={{ flexShrink: 0 }}
                  >↗</IconButton>
                )}
              </div>
              <span style={{ textAlign: 'right', fontWeight: 600 }}>
                {s.avg == null ? '—' : formatSignedMoneyAmount(s.avg)}
              </span>
              <span style={{ textAlign: 'right', color: 'var(--muted)' }}>{formatSignedMoneyAmount(s.total)}</span>
              <span style={{ textAlign: 'right', color: 'var(--muted)' }}>{pct}%</span>
              <span style={{ textAlign: 'right', color: 'var(--muted)', fontSize: 14 }}>{drillsToCategories ? '›' : null}</span>
            </div>
          )
        })}
      </Card>
    </StaleWhileRefreshing>
  )
}


export default function Dashboard() {
  /*
   * Dashboard runs three analysis modes over the same global filters, but each mode keeps its own drill state.
   * Resetting that state on mode changes avoids carrying breadcrumbs into views that summarize the same data differently.
   */
  const { filters, setDateApplies, pinDateFromChart, removeSelections, setDefaultDate,
    goBackDate, canGoBackDate, previousDate } = useFilters()
  // The Dashboard's configurable default period: what "unset" means here (Transactions treats unset as
  // all-time). Registered into the shared filter so the date chip can show it; the Dashboard itself uses
  // the local `defaultDate` for scope to avoid a first-render all-time→default refetch.
  const { pref: defaultPeriodPref, setPref: setDefaultPeriodPref, defaultDate: dashboardDefaultDate, pending: defaultPeriodPending } = useDashboardDefaultPeriod()
  useEffect(() => {
    setDefaultDate(dashboardDefaultDate)
    return () => setDefaultDate(null)
  }, [dashboardDefaultDate, setDefaultDate])
  // Effective period: explicit pick wins; otherwise the Dashboard's default (null => all-time).
  const effectiveDate = filters.date || dashboardDefaultDate
  // Hold the first paint until the 'auto' probe answers, rather than flashing all-time then the default.
  // Only bites on the first Dashboard visit of a session (the probe is cached after) and never when the
  // user has an explicit date or a non-auto default.
  const dateResolving = defaultPeriodPending && !filters.date
  const [mode, setMode] = useState('single')
  // When the user double-clicks a month in the Trends top chart with a group drill active,
  // we stash the group id here and consume it after Single mode re-runs its groupRows fetch.
  // The drill can't be applied synchronously because Single mode needs the new groupRows
  // (scoped to the just-set date filter) before drillToCategories can find a matching row.
  const [pendingSingleDrill, setPendingSingleDrill] = useState(null)
  const [groupRows, setGroupRows] = useState([])
  const [incomeRows, setIncomeRows] = useState([])
  const [catRows, setCatRows] = useState([])
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
  const { tags: availableTags } = useTags()
  // null when closed; `{ reportId }` opens it on that report's tags, `{ reportId: null }` starts a new one.
  const [tagBuilder, setTagBuilder] = useState(null)
  const [tagSignatureBuckets, setTagSignatureBuckets] = useState([])
  const [tagModeLoading, setTagModeLoading] = useState(false)
  const [detailTagSignatures, setDetailTagSignatures] = useState([])
  const [missingTagsToastReportId, setMissingTagsToastReportId] = useState(null)
  const [pickerMenuOpen, setPickerMenuOpen] = useState(null)
  const [renameTargetId, setRenameTargetId] = useState(null)
  const [saveAsOpen, setSaveAsOpen] = useState(false)
  const [deleteTargetId, setDeleteTargetId] = useState(null)
  const [showAllSpendingRows, setShowAllSpendingRows] = useState(false)
  const [otherDrillDepth, setOtherDrillDepth] = useState(0)
  // The trend plot is handed an explicit width rather than discovering one after it has drawn, so the
  // only measurement left is the viewport it may have to stretch to fill. Observing it here — once, on
  // the scroll container itself — is what keeps a re-bucket free of any measure-then-redraw: this width
  // does not change when the grain does. A callback ref rather than an effect, because the container
  // mounts and unmounts with the drill level and a ref assignment does not re-run effects.
  const trendScrollRef = useRef(null)
  const trendViewportObserver = useRef(null)
  // The month under the middle of the viewport, kept up to date as the plot is panned. Read only when
  // the bucket set is rebuilt, so it is deliberately the value from *before* that happened.
  const trendAnchorMonth = useRef(null)
  const [trendViewportWidth, setTrendViewportWidth] = useState(0)
  const attachTrendScroll = useCallback(node => {
    trendViewportObserver.current?.disconnect()
    trendViewportObserver.current = null
    trendScrollRef.current = node
    if (!node) return
    setTrendViewportWidth(node.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    // clientWidth, not the observed content rect: a horizontal scrollbar costs height, not width, so
    // this cannot feed back into the width that decides whether the scrollbar is there.
    const observer = new ResizeObserver(() => setTrendViewportWidth(node.clientWidth))
    observer.observe(node)
    trendViewportObserver.current = observer
  }, [])
  // The cash-flow diagram has two independent tails — a ledger usually has a handful of income buckets
  // and a great many expense ones — so each side pages into its own tail rather than sharing the pie's
  // single depth.
  const [cashFlowDepths, setCashFlowDepths] = useState({ [INFLOW]: 0, [OUTFLOW]: 0 })
  // `dashboardView` is the user's persisted frame; `activeFrame` is the one this mode can actually
  // render, which differs only in Compare (see frameForMode).
  const activeFrame = frameForMode(dashboardView, mode)
  const viewIsIncome = activeFrame === DASHBOARD_VIEW_INCOME
  const viewIsCashFlow = activeFrame === DASHBOARD_VIEW_CASH_FLOW


  useEffect(() => {
    setShowAllSpendingRows(false)
    setOtherDrillDepth(0)
    setCashFlowDepths({ [INFLOW]: 0, [OUTFLOW]: 0 })
  }, [spendingViewBy, activeFrame])

  // Only Single period reads the shared date chip: Compare takes its two periods from its own pickers and
  // Trends queries its own full-history window, so mute the date button on both. Restore on unmount so
  // other pages see the chip as live again.
  useEffect(() => {
    setDateApplies(mode === 'single')
    return () => setDateApplies(true)
  }, [mode, setDateApplies])

  // Filter derivation is hoisted ahead of the tag-mode fetch effect so the effect's
  // dependency expression can read these without a temporal dead zone.
  const dateStart = effectiveDate?.start || null
  const dateEnd = effectiveDate?.end || null
  // The period shown on the single-view totals cards. The effective period (explicit pick or the
  // Dashboard default) drives it; a rangeless value (all-time, explicit or default) reads "All time".
  const singlePeriodLabel = (effectiveDate && effectiveDate.start && effectiveDate.end)
    ? (effectiveDate.preset || `${effectiveDate.start} → ${effectiveDate.end}`)
    : 'All time'
  // The chip row becomes parameters through the shared facet registry (lib/filterParams.js), which
  // splits each facet by mode so an exclude chip can never leak into an include list and invert its
  // own meaning.
  const facetParams = useMemo(() => selectionsToParams(filters.selections), [filters.selections])
  // A single account selection also fills the singular `account_id` some endpoints take; two or more
  // has no singular form, so those fall back to `account_ids` alone. So does one account beside an
  // account-type chip: the two widen each other, and the account alone would narrow to it.
  const accountSelections = selectionsOfType(filters.selections, 'account')
  const accountTypeSelections = selectionsOfType(filters.selections, 'account_type')
  const accountId = accountSelections.length === 1 && accountTypeSelections.length === 0
    ? accountSelections[0].id
    : undefined
  // Tags and owners travel as arguments of their own on the totals/trend calls.
  const { tag_ids: tagIds, owner_ids: ownerIds } = facetParams
  // The cross-cutting filters (beyond date/tag/owner) that the summary, trend, and list endpoints accept.
  // Passed as trailing opts to every totals/trend call and spread into drill lists so the filter chips
  // narrow the whole dashboard, not just bits of it. Keys match both the summary opts and the list params.
  // Taken as "every other facet" rather than listed: the list this replaces had not been told about
  // the attribute filter, so those chips narrowed the ledger and left the Dashboard's totals alone. The
  // FilterBar's amount filter rides along for the same reason.
  const summaryFilters = useMemo(
    () => ({
      ...Object.fromEntries(Object.entries(facetParams).filter(([key]) => key !== 'tag_ids' && key !== 'owner_ids')),
      ...amountFilterParams(filters.amount),
    }),
    [facetParams, filters.amount],
  )

  // Picker resolution is hoisted ahead of the tag-mode fetch effect so the effect's
  // dependency expression can read activeTagReport without hitting a temporal dead zone.
  const savedTagReports = Array.isArray(tagReports) ? tagReports : []
  const allTagReports = transientTagReport
    ? [...savedTagReports, transientTagReport]
    : savedTagReports
  // A tag report is not a cash-flow breakdown: a signature bucket mixes income and expense categories,
  // so it has no single direction to net and no `category_type` to read one from. The cash-flow frame
  // therefore offers only the two structural breakdowns, and a persisted tag-report selection reads as
  // group here rather than being carried into a diagram that cannot express it. The selection itself is
  // left alone, so switching back to Expenses restores the report.
  const spendingViewByOptions = viewIsCashFlow
    ? SPENDING_VIEW_BY_BUILTIN_OPTIONS
    : [
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
  // Derive the refetch key from the exact params the fetch sends (including everything in
  // summaryFilters — the include *and* exclude_* facets), so it can't drift out of sync when a filter
  // dimension is added. Hand-listing only the include facets is what let a lone exclusion change (e.g.
  // negating or clearing a tag chip) leave the tag-report data stale.
  // Derive the refetch key from the exact params the fetch sends — the report's own tags plus everything
  // in summaryFilters (include *and* exclude_* facets) — so it can't drift out of sync when a filter
  // dimension is added. Hand-listing only the include facets is what let a lone exclusion change (e.g.
  // negating or clearing a tag chip) leave the tag-report data stale.
  const tagModeFetchKey = activeTagReport
    ? JSON.stringify({
      reportTags: (activeTagReport.tagIds || []).join(','),
      view: activeFrame, dateStart, dateEnd,
      accountId, tagIds, ownerIds, ...summaryFilters,
    })
    : null
  // One ticket per slot the in-place refresh shares with a scope effect or a drill (see useLatestRequest).
  const beginSingleTotals = useLatestRequest()
  const beginCompareTotals = useLatestRequest()
  const beginCashFlowTrend = useLatestRequest()
  const beginTrendGroups = useLatestRequest()
  const beginTagSignatureBuckets = useLatestRequest()
  const beginGroupCategories = useLatestRequest()
  const beginCompareCategories = useLatestRequest()

  // The tag report's pie is aggregated server-side (/summary/by-tag-signature) so it can't truncate on a
  // large period the way the old client-side aggregation over a capped /transactions fetch did. The
  // report's tags define the slices (selected_tag_ids); the shared filters narrow the rows. Extracted as
  // a callback so both the scope-change effect and the `luma:transactions-changed` handler can reload it.
  // Resolves to null when a newer load has started since, which callers leave unapplied.
  const loadTagSignatureBuckets = useCallback(() => {
    const isLatest = beginTagSignatureBuckets()
    return api.getTagSignatureTotals(
      (activeTagReport?.tagIds || []).join(','),
      {
        date_start: dateStart || undefined,
        date_end: dateEnd || undefined,
        account_id: accountId || undefined,
        owner_ids: ownerIds,
        tag_ids: tagIds,
        exclude_income: !viewIsIncome,
        exclude_expense: viewIsIncome,
      },
      summaryFilters,
    ).then(resp => (isLatest() ? (Array.isArray(resp) ? resp : []) : null))
  }, [activeTagReport, dateStart, dateEnd, accountId, ownerIds, tagIds, viewIsIncome, summaryFilters, beginTagSignatureBuckets])
  useEffect(() => {
    if (mode !== 'single' || !activeTagReport) {
      setTagSignatureBuckets([])
      setTagModeLoading(false)
      return
    }
    let cancelled = false
    setTagModeLoading(true)
    loadTagSignatureBuckets().then(buckets => {
      if (cancelled) return
      if (buckets) setTagSignatureBuckets(buckets)
      setTagModeLoading(false)
    }).catch(() => {
      if (cancelled) return
      setTagSignatureBuckets([])
      setTagModeLoading(false)
    })
    return () => { cancelled = true }
    // `tagModeFetchKey` serializes the report's tag ids and every filter the loader reads, and is null
    // whenever there is no active report — so it subsumes both `activeTagReport` and the loader's
    // identity, which would otherwise refetch on any parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, tagModeFetchKey])

  // Surface a one-shot toast when the active tag report references tag IDs that no longer
  // exist (the user deleted a tag elsewhere). The server aggregation simply omits those
  // IDs from the signatures, so the data displays correctly; the toast just
  // notifies the user that something changed so they can rebuild the report deliberately.
  // The user can dismiss for the session (auto-fade or X) or suppress permanently for this
  // preset via "Don't remind me again", which sets dismissedMissingWarning on the record.
  // Keyed on the report's tag *ids* as well as its identity: editing a saved report's tag set leaves the
  // id and the suppression flag untouched, and without the set in the key the warning it should raise
  // (or clear) waits for the next unrelated change to the tag list.
  const activeReportTagsKey = (activeTagReport?.tagIds || []).join(',')
  useEffect(() => {
    if (!activeTagReport || availableTags.length === 0) {
      setMissingTagsToastReportId(null)
      return
    }
    if (activeTagReport.dismissedMissingWarning) {
      setMissingTagsToastReportId(null)
      return
    }
    if (activeTagReport.id === TRANSIENT_TAG_REPORT_ID) {
      setMissingTagsToastReportId(null)
      return
    }
    const knownIds = new Set(availableTags.map(t => t.id))
    const hasMissing = (activeTagReport.tagIds || []).some(id => !knownIds.has(id))
    setMissingTagsToastReportId(hasMissing ? activeTagReport.id : null)
    // The three fields read above are keyed individually; the report object's identity churns on every
    // parent render, so depending on it directly would re-run this on renders that changed nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTagReport?.id, activeTagReport?.dismissedMissingWarning, activeReportTagsKey, availableTags])
  const [detailTxns, setDetailTxns] = useState([])
  const [detailPeriods, setDetailPeriods] = useState([])
  const [categories, setCategories] = useState([])
  // The single-view trend is derived (memo below) from the raw all-time monthly rows, so a calendar grain
  // re-buckets without re-fetching; the same-span grain reads its own day-precise totals, held with the
  // ranges they answer so a stale answer is never drawn against a newer bucket set. See the single-period
  // section of lib/trendBuckets.js for the two modes.
  const [singleTrendRows, setSingleTrendRows] = useState([])
  const [spanTrend, setSpanTrend] = useState({ key: null, rows: [] })
  // The chooser's pick; null follows the selection's default. A pick survives the navigation the chart
  // itself does — a bar click, the back-step — and is dropped when the period is chosen any other way,
  // where it would describe a different selection. `keepTrendGrainForDateRef` names the date such a
  // chart navigation is about to set, which is how the reset below tells the two apart.
  const [trendGrainChoice, setTrendGrainChoice] = useState(null)
  // How far back every multi-period chart on the page reaches — the single-period trend here, and the
  // Annual totals / Yearly trend charts on the Trends tab. One persisted setting for all of them, read
  // here so the charts in a frame always agree about it (`lib/trendSpan.js`).
  const [trendSpanPref, setTrendSpanPref] = useUserPreference(TREND_SPAN_PREF_KEY, TREND_SPAN_ALL)
  const keepTrendGrainForDateRef = useRef(undefined)
  // The date a drilled trend's bar (or its back-step) is about to set, so that change keeps the drill.
  const keepDrillForDateRef = useRef(undefined)
  const [level, setLevel] = useState('groups')
  const [selectedGroup, setSelectedGroup] = useState(null)
  const [selectedCat, setSelectedCat] = useState(null)

  // A quiet note when the filter removes a slice the active spending report breaks down: a slice a chip
  // `≠`-excludes (category report `≠ Groceries`, a Business tag report `≠ Business`, an excluded
  // category inside the drilled group), or — for tag reports — a report tag a tag *include* filter
  // narrows away. Purely client-side (report axis + chips both live here) and like-for-like only, so an
  // indirect account/owner filter never triggers it.
  const reportConflicts = useMemo(() => computeReportSpendingConflicts({
    reportKind: activeTagReport ? 'tag' : activeSpendingViewBy,
    view: viewIsIncome ? 'income' : 'expense',
    reportTagIds: activeTagReport?.tagIds || [],
    selectedGroupId: level !== 'groups' && selectedGroup ? selectedGroup.group_id : null,
    selections: filters.selections,
    categories,
    tagsById: new Map(availableTags.map(t => [t.id, t])),
  }), [activeTagReport, activeSpendingViewBy, viewIsIncome, level, selectedGroup,
    filters.selections, categories, availableTags])
  const reportConflictText = describeReportConflicts(reportConflicts)
  // Label the action after what it actually does. A tag-report conflict clears the tag chips (a missing
  // tag has no chip of its own to drop), so say "Clear tag filter" rather than promising a report
  // outcome; group/category conflicts drop just the offending exclude chip.
  const reportConflictIsTag = reportConflicts.some(c => c.facet === 'tag')
  const reportConflictActionLabel = reportConflictIsTag
    ? 'Clear tag filter'
    : (reportConflicts.length === 1 ? 'Clear exclusion' : 'Clear exclusions')

  // The two single-period drill transaction lists page through the shared usePagedTransactions with
  // server-side sort — same as the floating detail panels — so drilling a busy group/category over a long
  // range isn't truncated at a fetch cap and column sort reorders the whole result. Each is keyed on the
  // drill selection: it fetches when a group/category is selected and clears when the user navigates back
  // up. The bulk-edit filterParams (below) mirror these fetch params so "select all matching" resolves the
  // same rows server-side. dateStart/dateEnd are the resolved global-filter range (matching the params).
  const selectedGroupFilterParams = useMemo(() => ({
    ...summaryFilters,
    date_start: dateStart || undefined,
    date_end: dateEnd || undefined,
    group_ids: selectedGroup?.group_id,
    account_id: accountId || undefined,
    tag_ids: tagIds,
    owner_ids: ownerIds,
  }), [summaryFilters, dateStart, dateEnd, selectedGroup, accountId, tagIds, ownerIds])
  const selectedGroupLoadPage = useCallback((offset, limit, sort) => (
    api.getTransactions({ ...selectedGroupFilterParams, limit, offset, sort_by: sort.key, sort_dir: sort.dir })
  ), [selectedGroupFilterParams])
  const groupTxnPaged = usePagedTransactions({
    activeKey: selectedGroup ? JSON.stringify(selectedGroupFilterParams) : null,
    loadPage: selectedGroupLoadPage,
    exportParams: selectedGroupFilterParams,
  })
  const groupTxnData = groupTxnPaged.rows
  const setGroupTxnData = groupTxnPaged.setRows
  const groupTxnDataTotal = groupTxnPaged.total

  const selectedCatFilterParams = useMemo(() => ({
    ...summaryFilters,
    date_start: dateStart || undefined,
    date_end: dateEnd || undefined,
    category_id: selectedCat?.category_id,
    account_id: accountId || undefined,
    tag_ids: tagIds,
    owner_ids: ownerIds,
  }), [summaryFilters, dateStart, dateEnd, selectedCat, accountId, tagIds, ownerIds])
  const selectedCatLoadPage = useCallback((offset, limit, sort) => (
    api.getTransactions({ ...selectedCatFilterParams, limit, offset, sort_by: sort.key, sort_dir: sort.dir })
  ), [selectedCatFilterParams])
  const catTxnPaged = usePagedTransactions({
    activeKey: selectedCat ? JSON.stringify(selectedCatFilterParams) : null,
    loadPage: selectedCatLoadPage,
    exportParams: selectedCatFilterParams,
  })
  const txnData = catTxnPaged.rows
  const setTxnData = catTxnPaged.setRows
  const txnDataTotal = catTxnPaged.total

  // Bulk edit for the two single-period drill tables. filterParams mirror the paged fetch above so
  // "select all matching" resolves the same rows server-side; rows reconcile in place.
  const selectedCatBulk = useBulkTransactionEditing({
    rows: txnData,
    setRows: setTxnData,
    total: txnDataTotal,
    filterParams: selectedCatFilterParams,
    categories,
    availableTags,
    onRowsTrashed: count => catTxnPaged.setTotal(prev => Math.max(0, prev - count)),
  })
  const selectedGroupBulk = useBulkTransactionEditing({
    rows: groupTxnData,
    setRows: setGroupTxnData,
    total: groupTxnDataTotal,
    filterParams: selectedGroupFilterParams,
    categories,
    availableTags,
    onRowsTrashed: count => groupTxnPaged.setTotal(prev => Math.max(0, prev - count)),
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
  const [cmpCatsA, setCmpCatsA] = useState([])
  const [cmpCatsB, setCmpCatsB] = useState([])
  const [cmpGroup, setCmpGroup] = useState(null)
  const [cmpLevel, setCmpLevel] = useState('groups')

  // null = "auto": let TrendsPanel resolve the default from the data (trailing 12 months if those
  // months have data, else the most recent year present) so a stale/imported dataset doesn't land on
  // an empty trailing window. An explicit pick from the dropdown overrides it.
  const [trendYear, setTrendYear] = useState(null)
  // The group the user asked to drill into. It keys the fetch, and nothing on screen: the panel draws
  // `shownTrendGroup` — the group the series on screen was fetched for — so a drill switches the title,
  // the picker, the averages table and the charts in one frame, when the group's series arrives. Setting
  // the group first and the rows later drew the group's title and category arrows over the previous
  // rows, where a click opened a category report for a *group*. The Single period and Compare drills
  // already wait for their data before switching level; this is the same rule.
  const [trendGroup, setTrendGroup] = useState(null)
  // null until the first series arrives, which TrendsPanel renders as nothing rather than as empty charts.
  const [trendSeries, setTrendSeries] = useState(null)
  const trendRows = trendSeries?.rows ?? null
  const shownTrendGroup = trendSeries?.group ?? null
  // Only the newest request may land: drilling into one group and then another must not let the first
  // group's slower answer overwrite the second's.
  const trendSeriesRequestRef = useRef(0)
  const [cashFlowTrendRows, setCashFlowTrendRows] = useState([])
  const [cashFlowAnnualRows, setCashFlowAnnualRows] = useState([])
  const [trendGroups, setTrendGroups] = useState([])
  const [trendLoading, setTrendLoading] = useState(false)
  // The window the Trends tab shows, resolved here rather than inside TrendsPanel because the group picker's
  // options are fetched for it. Null until the series first arrives, since the default depends on the data.
  const trendWindow = useMemo(
    () => (trendRows
      ? trendsWindowRange(resolveTrendsWindowKey(trendRows, trendYear, thisM), thisM, rowsMonthSpan(trendRows))
      : null),
    [trendRows, trendYear],
  )
  const trendWindowStart = trendWindow?.start
  const trendWindowEnd = trendWindow?.end

  const [loading, setLoading] = useState(true)
  const [drillLoading, setDrillLoading] = useState(false)
  // Whether there are figures worth holding on screen through a reload. Empty on the very first load
  // and on a filter that genuinely matches nothing, which are the two cases where a spinner is the
  // honest thing to show — there is no previous answer being superseded.
  const hasTotals = groupRows.length > 0 || incomeRows.length > 0
    || cmpGroupsA.length > 0 || cmpGroupsB.length > 0
  const multiDetailMode = detailTxns.length > 1
  // The category column stays even though a drilled list is one category throughout: it is the only
  // interactive cell in the table (recategorize, split, rule prompt, drill), so hiding it as redundant
  // took the row-level edits with it. The account column is hidden on account-scoped lists for the same
  // "constant here" reason and that one is fine — plain text, nothing to lose.
  const [categoryTxnColumns, setCategoryTxnColumns] = useTransactionTableLayout({
    preferenceKey: DASHBOARD_CATEGORY_TXN_TABLE_PREF_KEY,
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
  // Range-scoped transaction drawer for a trend bar (or the selected period, via the header link).
  // `start`/`end` are inclusive ISO dates, `label` the human range name shown in the panel header.
  // `scope` narrows the report to one slice of the breakdown it was opened from ({ kind: 'category' |
  // 'group', id, name }; see lib/periodReportScope.js), so the list is the rows behind that slice's figure.
  function openPeriodDetail({ start, end, label }, view, scope = null) {
    if (!start || !end) return
    const key = periodReportKey({ start, end, view, scope })
    setDetailPeriods(prev => [
      ...prev.filter(item => item.key !== key),
      { key, start, end, label, view: view || 'spending', scope },
    ])
  }

  // A single month bar (the Trends tab's monthly drill) is just a one-month range.
  function openMonthDetail(month, view, scope = null) {
    if (!month) return
    openPeriodDetail({ start: `${month}-01`, end: lastDayOfMonthISO(month), label: monthLabel(month) }, view, scope)
  }

  function closePeriodDetail(key) {
    setDetailPeriods(prev => prev.filter(item => item.key !== key))
  }

  // Tag-signature detail panels stack like the other floating drawers. The key encodes
  // the report id + signature so the same wedge double-click focuses the existing panel. The report
  // and signature ids are kept beside it so the panel's header can be re-read from the *live* wedge
  // rather than this opening snapshot (see the lookup at the render site).
  function openTagDetail(row, report) {
    if (!row || !report) return
    const key = `tag::${report.id}::${row.signature_id}`
    setDetailTagSignatures(prev => [
      ...prev.filter(item => item.key !== key),
      {
        key,
        reportId: report.id,
        signatureId: row.signature_id,
        signature: row,
        reportTagIds: report.tagIds || [],
        reportName: report.name,
        view: activeFrame,
        accountId: accountId || null,
        dateStart,
        dateEnd,
        filterTagIds: tagIds || null,
        ownerIds: ownerIds || null,
        filters: summaryFilters,
      },
    ])
  }

  function closeTagDetail(key) {
    setDetailTagSignatures(prev => prev.filter(item => item.key !== key))
  }

  // Factored out of the effect so a transaction edit can refresh the breakdown/trend *in place* without
  // the drill-reset that a real mode/filter navigation does. The top-half summary respects the selected
  // date slice; the bottom-half trend reads all of history and only highlights the slice.
  const loadSingleTotals = useCallback(async () => {
    const isLatest = beginSingleTotals()
    const isIncomeView = activeFrame === DASHBOARD_VIEW_INCOME
    // The cash-flow frame reports both directions, so neither side is excluded from the category
    // breakdown it reads; the spending and income frames each keep to their own half.
    const isCashFlowView = activeFrame === DASHBOARD_VIEW_CASH_FLOW
    const [g, tr, c] = await Promise.all([
      api.getGroupTotals(null, accountId || undefined, dateStart, dateEnd, ownerIds, undefined, tagIds, summaryFilters),
      api.getMonthlyTrend(120, undefined, accountId || undefined, ALL_TIME_START, undefined, tagIds, activeFrame, ownerIds, summaryFilters),
      api.getCategoryTotals(null, accountId || undefined, dateStart, dateEnd, ownerIds, undefined, tagIds,
        !isCashFlowView && !isIncomeView, !isCashFlowView && isIncomeView, summaryFilters),
    ])
    if (!isLatest()) return
    setGroupRows(g.filter(r => r.category_type !== 'income'))
    setIncomeRows(g.filter(r => r.category_type === 'income'))
    setSingleTrendRows(tr)
    setTopCatRows(c)
  }, [accountId, dateStart, dateEnd, ownerIds, tagIds, summaryFilters, activeFrame, beginSingleTotals])

  // The trend follows the drill: an open group or category charts its own history, in the scope the
  // detail panels use (`category_id`, with `__group__` for a group), so its bars are the rows the list
  // beneath them lists. Null at the top level, where the trend is the frame's total.
  const trendScopeId = level === 'transactions' && selectedCat
    ? selectedCat.category_id
    : level === 'categories' && selectedGroup
      ? `__group__${selectedGroup.group_id}`
      : null
  const trendScopeName = trendScopeId
    ? (level === 'transactions' ? selectedCat.category_name : selectedGroup.group_name)
    : null
  const [drillTrend, setDrillTrend] = useState({ key: null, rows: [] })
  const drillTrendRequestRef = useRef(0)
  const loadDrillTrend = useCallback(async () => {
    if (!trendScopeId) return
    const request = ++drillTrendRequestRef.current
    const rows = await api.getMonthlyTrend(120, trendScopeId, accountId || undefined, ALL_TIME_START, undefined, tagIds, activeFrame, ownerIds, summaryFilters)
    if (request === drillTrendRequestRef.current) setDrillTrend({ key: trendScopeId, rows })
  }, [trendScopeId, accountId, tagIds, activeFrame, ownerIds, summaryFilters])
  useEffect(() => {
    if (mode !== 'single') return
    loadDrillTrend().catch(() => { })
  }, [mode, loadDrillTrend])
  // Null while a drilled scope's rows are in flight, so the bars of the scope just left are never drawn
  // under the new one's name.
  const trendMonthlyRows = trendScopeId
    ? (drillTrend.key === trendScopeId ? drillTrend.rows : null)
    : singleTrendRows

  // The trend keys on the *explicit* pick, not the Dashboard default: with no chip it is not tied to a
  // period, so it opens monthly with nothing highlighted, and an explicit "All time" is rangeless and
  // reads the same way.
  const trendGrain = effectiveTrendGrain(trendGrainChoice, filters.date)
  const trendIsSameSpan = trendGrain === TREND_GRAIN_SAME_SPAN
  const trendDataMonths = useMemo(() => {
    const months = (trendMonthlyRows || []).map(r => r.month).filter(Boolean).sort()
    return { firstMonth: months[0] || null, lastMonth: months[months.length - 1] || null }
  }, [trendMonthlyRows])
  // How much history the chart draws, as a floor on where the *data* starts — see `lib/trendSpan.js`.
  // Both bucket builders take it from `firstMonth`, so one floor governs the calendar grains and the
  // repeated spans alike, and the same-span request asks the server for only the buckets being drawn.
  // The selection is deliberately not floored: `calendarTrendBuckets` widens to it either way, so a
  // period older than the span is still on the chart rather than captioning bars that exclude it.
  const trendSpanMonths = useMemo(() => {
    // Whole buckets of the grain on screen, except in same-span mode, whose buckets are the user's own
    // window and have no calendar width to count in.
    const floor = trendSpanFloorMonth(
      trendSpanPref, trendDataMonths.lastMonth, trendIsSameSpan ? 'month' : trendGrain,
    )
    const firstMonth = floor && trendDataMonths.firstMonth && floor > trendDataMonths.firstMonth
      ? floor
      : trendDataMonths.firstMonth
    return { firstMonth, lastMonth: trendDataMonths.lastMonth }
  }, [trendDataMonths, trendSpanPref, trendGrain, trendIsSameSpan])
  const spanBuckets = useMemo(
    // Built only once the scope's months are known, so a drill does not ask for the buckets of the
    // scope it left.
    () => (trendIsSameSpan && trendMonthlyRows ? sameSpanTrendBuckets({ date: filters.date, ...trendSpanMonths }) : []),
    [trendIsSameSpan, trendMonthlyRows, filters.date, trendSpanMonths],
  )
  const spanRanges = spanBuckets.map(b => `${b.rangeStart}:${b.rangeEnd}`).join(',')
  const spanKey = spanRanges ? `${trendScopeId || ''}|${spanRanges}` : ''
  const spanRequestRef = useRef(0)
  const loadSpanTrend = useCallback(async () => {
    if (!spanKey) return
    const request = ++spanRequestRef.current
    const ranges = spanRanges.split(',').map(pair => {
      const [start, end] = pair.split(':')
      return { start, end }
    })
    const rows = await api.getRangeTrend(ranges, accountId || undefined, tagIds, activeFrame, ownerIds,
      { ...summaryFilters, category_id: trendScopeId || undefined })
    if (request === spanRequestRef.current) setSpanTrend({ key: spanKey, rows })
  }, [spanKey, spanRanges, trendScopeId, accountId, tagIds, activeFrame, ownerIds, summaryFilters])
  useEffect(() => {
    if (mode !== 'single' || dateResolving) return
    loadSpanTrend().catch(() => { })
  }, [mode, dateResolving, loadSpanTrend])

  useEffect(() => {
    const keep = keepTrendGrainForDateRef.current
    keepTrendGrainForDateRef.current = undefined
    if (keep !== undefined && sameDateRange(keep, filters.date)) return
    setTrendGrainChoice(null)
  }, [filters.date])

  // Null while the same-span totals for the current buckets are still in flight; the chart then keeps
  // the bars it had rather than drawing the new buckets empty.
  const computedTrend = useMemo(() => {
    if (trendIsSameSpan) {
      if (spanTrend.key !== spanKey) return null
      return trimEmptyTrendBuckets(trendChartRows(spanBuckets, (b, i) => Number(spanTrend.rows[i]?.total) || 0))
    }
    if (!trendMonthlyRows) return null
    const buckets = calendarTrendBuckets({ ...trendSpanMonths, grain: trendGrain, date: filters.date, fallbackMonth: thisM })
    return trimEmptyTrendBuckets(trendChartRows(buckets, monthlyBucketTotal(trendMonthlyRows)))
  }, [trendIsSameSpan, spanTrend, spanKey, spanBuckets, trendSpanMonths, trendGrain, filters.date, trendMonthlyRows])
  const [heldTrend, setHeldTrend] = useState([])
  useEffect(() => { if (computedTrend) setHeldTrend(computedTrend) }, [computedTrend])
  const trend = computedTrend ?? heldTrend

  // The trend chart pans by native horizontal scroll, and the bucket set is replaced under it in two
  // quite different ways — which is what decides where the plot should then be scrolled to.
  //
  // **A bar click picks a period**, and the picked period is what to show. The same goes for any bucket
  // set with a selection in it — after a grain change too, since the highlighted run is what the reader
  // is following. A selection spanning several buckets is centred on the middle one.
  //
  // **With nothing selected, changing the grain re-cuts the same data.** The reader is still looking at
  // whatever they were looking at — and scrolling to the newest bucket, which is the only sensible
  // index-based answer, throws them to the far end of the chart every time. The month under the middle
  // of the viewport is carried across instead, so month, quarter and year views of the same period stay
  // on that period.
  //
  // `useLayoutEffect` so it lands before paint instead of as a visible jump, and keyed on the bucket set
  // rather than on every render so it never fights the user's own scrolling. The offset is computed from
  // the same layout the plot is drawn at, not from the bar width: those are the same number only while
  // the buckets are what sets the width, and a stretched plot spreads its bars over the extra room.
  //
  // "The bucket set" is which periods are drawn and which are selected, not the array holding them: the
  // totals reload on every ledger change, and a reload that brings back the same buckets must leave the
  // pan alone. So the effect is keyed on `trendBucketsKey` and reads the buckets through a ref.
  const trendSelectedIndex = useMemo(() => {
    const selected = trend.flatMap((b, i) => (b.isSelected ? [i] : []))
    return selected.length ? selected[Math.floor((selected.length - 1) / 2)] : -1
  }, [trend])
  const trendPlot = useMemo(
    () => trendPlotLayout(trend.length, trendViewportWidth),
    [trend.length, trendViewportWidth],
  )
  const rememberTrendAnchor = useCallback(() => {
    const el = trendScrollRef.current
    if (!el || trend.length === 0) return
    const index = bucketIndexAtScroll({
      scrollLeft: el.scrollLeft, viewportWidth: el.clientWidth, layout: trendPlot, bucketCount: trend.length,
    })
    if (index >= 0) trendAnchorMonth.current = bucketAnchorMonth(trend[index])
  }, [trend, trendPlot])
  const trendBucketsKey = trend.map(b => `${b.rangeStart}:${b.rangeEnd}:${b.isSelected ? 1 : 0}`).join(',')
  const latestTrend = useRef(trend)
  useLayoutEffect(() => { latestTrend.current = trend }, [trend])
  useLayoutEffect(() => {
    const el = trendScrollRef.current
    const buckets = latestTrend.current
    if (!el || buckets.length === 0) return
    const index = trendScrollTargetIndex({
      buckets, selectedIndex: trendSelectedIndex, anchorMonth: trendAnchorMonth.current,
    })
    el.scrollLeft = centeredScrollLeft({ index, layout: trendPlot, viewportWidth: el.clientWidth })
  }, [trendBucketsKey, trendSelectedIndex, trendPlot])

  // In-place loaders for the Compare and Trends aggregates, shared by their mode effects and the
  // transaction-change refresh so an edit updates them without resetting the user's drill.
  const loadCompareTotals = useCallback(async () => {
    if (!periodA || !periodB) return
    const isLatest = beginCompareTotals()
    const [a, b] = await Promise.all([
      fetchPeriodGroupTotals(periodA, accountId, tagIds, ownerIds, summaryFilters),
      fetchPeriodGroupTotals(periodB, accountId, tagIds, ownerIds, summaryFilters),
    ])
    if (!isLatest()) return
    setCmpGroupsA(a)
    setCmpGroupsB(b)
  }, [periodA, periodB, accountId, tagIds, ownerIds, summaryFilters, beginCompareTotals])

  const loadTrendSeries = useCallback(async () => {
    // Fetch the full visible history (20-year bound) so the window chooser and Annual totals can reach
    // every year in the data; the per-window monthly charts then slice this down via the window chooser.
    const request = ++trendSeriesRequestRef.current
    const group = trendGroup
    const rows = await api.getMonthlyByGroup(240, accountId || undefined, group?.series_id || undefined, tagIds, ownerIds, summaryFilters)
    if (request === trendSeriesRequestRef.current) setTrendSeries({ group, rows })
  }, [accountId, trendGroup, tagIds, ownerIds, summaryFilters])

  // The cash-flow trends form reads its own endpoint rather than the by-group series: its bars are the
  // per-category nets re-bucketed by direction, which is not something the group series can be summed
  // into. Same 20-year window as the other trends, so the window chooser reaches every year in the data. The
  // yearly rows are a second call rather than a sum of the monthly ones — see buildCashFlowAnnualSeries.
  const loadCashFlowTrend = useCallback(async () => {
    const isLatest = beginCashFlowTrend()
    const [rows, yearRows] = await Promise.all([
      api.getMonthlyCashFlow(240, accountId || undefined, tagIds, ownerIds, summaryFilters),
      api.getMonthlyCashFlow(240, accountId || undefined, tagIds, ownerIds, { ...summaryFilters, granularity: 'year' }),
    ])
    if (!isLatest()) return
    setCashFlowTrendRows(rows)
    setCashFlowAnnualRows(yearRows)
  }, [accountId, tagIds, ownerIds, summaryFilters, beginCashFlowTrend])

  // The picker offers the groups with transactions in the window on screen, under the same filters — the
  // groups the averages table lists at "All groups". Keyed on the window's dates rather than the object,
  // so a reload that resolves to the same window does not refetch.
  const loadTrendGroups = useCallback(async () => {
    if (!trendWindowStart || !trendWindowEnd) return
    const wantIncome = activeFrame === DASHBOARD_VIEW_INCOME
    const isLatest = beginTrendGroups()
    const g = await api.getGroupTotals(undefined, accountId || undefined, trendWindowStart, trendWindowEnd, ownerIds, undefined, tagIds, summaryFilters)
    if (!isLatest()) return
    setTrendGroups(g.filter(r => (wantIncome ? r.category_type === 'income' : r.category_type !== 'income')))
  }, [accountId, ownerIds, tagIds, summaryFilters, activeFrame, trendWindowStart, trendWindowEnd, beginTrendGroups])

  useEffect(() => {
    if (mode !== 'single') return
    // Hold the fetch until the default period resolves, so we don't load all-time and then reload the
    // default. Re-runs when dateResolving flips (the dep) even if the resolved period is also all-time.
    if (dateResolving) return
    // A bar of a drilled trend moves the period *for* the open group or category, so that pin keeps the
    // drill and refreshes it in place; any other change returns to the top level.
    const keep = keepDrillForDateRef.current
    keepDrillForDateRef.current = undefined
    if (keep !== undefined && sameDateRange(keep, filters.date) && level !== 'groups') {
      loadSingleTotals().catch(() => { })
      if (selectedGroup?.group_id) {
        const isLatest = beginGroupCategories()
        api.getCategoryTotalsInGroup(null, selectedGroup.group_id, accountId || undefined, dateStart, dateEnd, ownerIds, tagIds, summaryFilters)
          .then(rows => { if (isLatest()) setCatRows(rows) })
          .catch(() => { })
      }
      return
    }
    setLoading(true)
    setLevel('groups'); setSelectedGroup(null); setSelectedCat(null); setOtherDrillDepth(0)
    // A rejection here used to strand the spinner forever, because nothing cleared it: the dashboard sat
    // loading with no error and no way out but a reload. What is on screen stays on screen — the loaders
    // write their state only on success — and the app's own unreachable-backend handling says so when
    // that is the reason.
    loadSingleTotals().catch(() => { }).then(() => setLoading(false))
    // Keyed on the loader (every filter) and not on the drill it reads: keying on the drill would reset
    // the very drill the user just made.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, loadSingleTotals, dateResolving])

  // Recategorizing (here or from a detail panel) changes the aggregates, so refresh the breakdown/trend
  // and the open group's category totals in place — otherwise a moved transaction lingers in the list. A
  // sync that brought rows in changes them the same way.
  const refreshTotalsInPlace = useCallback(() => {
    if (mode === 'single') {
      loadSingleTotals()
      loadSpanTrend()
      loadDrillTrend()
      if (selectedGroup?.group_id) {
        const isLatest = beginGroupCategories()
        api.getCategoryTotalsInGroup(null, selectedGroup.group_id, accountId || undefined, dateStart, dateEnd, ownerIds, tagIds, summaryFilters)
          .then(rows => { if (isLatest()) setCatRows(rows) })
      }
      // The tag report is a separate data path from the group/category totals above, so refresh its
      // buckets too — otherwise recategorizing a transaction out of a tagged category (e.g. from the
      // TagDetail panel) leaves the wedges stale.
      if (activeTagReport) {
        loadTagSignatureBuckets().then(buckets => { if (buckets) setTagSignatureBuckets(buckets) }).catch(() => { })
      }
    } else if (mode === 'compare') {
      loadCompareTotals()
      if (cmpGroup?.group_id) {
        const isLatest = beginCompareCategories()
        Promise.all([
          fetchPeriodCatTotals(periodA, cmpGroup.group_id, accountId, tagIds, ownerIds, summaryFilters),
          fetchPeriodCatTotals(periodB, cmpGroup.group_id, accountId, tagIds, ownerIds, summaryFilters),
        ]).then(([a, b]) => { if (isLatest()) { setCmpCatsA(a); setCmpCatsB(b) } })
      }
    } else if (mode === 'trends') {
      if (viewIsCashFlow) loadCashFlowTrend()
      else { loadTrendSeries(); loadTrendGroups() }
    }
  }, [mode, viewIsCashFlow, loadSingleTotals, loadSpanTrend, loadDrillTrend, loadCompareTotals, loadTrendSeries, loadCashFlowTrend, loadTrendGroups, selectedGroup, cmpGroup, periodA, periodB, accountId, dateStart, dateEnd, ownerIds, tagIds, summaryFilters, activeTagReport, loadTagSignatureBuckets, beginGroupCategories, beginCompareCategories])
  useEffect(() => {
    window.addEventListener('luma:transactions-changed', refreshTotalsInPlace)
    return () => window.removeEventListener('luma:transactions-changed', refreshTotalsInPlace)
  }, [refreshTotalsInPlace])
  useAfterLedgerSync(refreshTotalsInPlace)

  useEffect(() => {
    api.getCategories().then(setCategories)
  }, [])

  useEffect(() => {
    if (mode !== 'compare' || !periodA || !periodB) return
    setLoading(true)
    setCmpLevel('groups'); setCmpGroup(null)
    loadCompareTotals().catch(() => { }).then(() => setLoading(false))
  }, [mode, periodA, periodB, loadCompareTotals])

  useEffect(() => {
    if (mode !== 'trends') return
    // Only the load this effect run started may clear the flag: a superseded one finishing first would
    // otherwise drop the refreshing state while the drill the user just made is still on its way.
    let current = true
    setTrendLoading(true)
    const load = viewIsCashFlow ? loadCashFlowTrend : loadTrendSeries
    // A failed first load settles on empty — the panel's own "no data" state — instead of staying blank.
    load()
      .catch(() => { if (!viewIsCashFlow) setTrendSeries(prev => prev ?? { group: null, rows: [] }) })
      .then(() => { if (current) setTrendLoading(false) })
    return () => { current = false }
  }, [mode, viewIsCashFlow, loadTrendSeries, loadCashFlowTrend])

  useEffect(() => {
    // The group drill belongs to the spending/income forms; the cash-flow form has no group selector, so
    // it does not need the list behind one.
    if (mode !== 'trends' || viewIsCashFlow) return
    // The drill dropdown lists only the side of the ledger the user is currently viewing —
    // expense groups in spending mode, income groups in income mode (handled inside loadTrendGroups).
    loadTrendGroups()
  }, [mode, viewIsCashFlow, loadTrendGroups])

  // Clear an active drill when the user toggles between spending and income — a drilled
  // expense group has no meaning in income view (and vice versa), so jump back to "all groups".
  useEffect(() => {
    if (mode === 'trends') setTrendGroup(null)
    // Keyed only on the frame; mode changes are unrelated and should not retrigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFrame])

  const drillToCategories = useCallback(async (group) => {
    const groupId = group.group_id ?? group.payload?.group_id
    const groupRow = groupRows.find(r => r.group_id === groupId) || group
    setDrillLoading(true)
    // Selecting the group keys the paged group-transaction list (usePagedTransactions), which fetches on
    // its own; here we only need the category breakdown that the pie/list render from.
    setSelectedGroup(groupRow)
    // `finally`, so a failure propagates exactly as it did before — the spinner is the only thing this
    // changes. `setLevel` not having run is what leaves the view where it started.
    try {
      const isLatest = beginGroupCategories()
      const rows = await api.getCategoryTotalsInGroup(null, groupId, accountId || undefined, dateStart, dateEnd, ownerIds, tagIds, summaryFilters)
      if (isLatest()) setCatRows(rows)
      setLevel('categories')
    } finally {
      setDrillLoading(false)
    }
  }, [groupRows, accountId, dateStart, dateEnd, tagIds, ownerIds, summaryFilters, beginGroupCategories])

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
  // trend-group drill so a "this group, this month" view comes up in one gesture. The period is pinned
  // the same way a single-period bar click pins it — the click moved the period as a side effect of
  // drilling, so it is recorded for the back-step on the card it lands on.
  function openSinglePeriodForMonth(month) {
    if (!month) return
    const [y, m] = month.split('-').map(Number)
    const lastDay = new Date(y, m, 0).getDate()
    const start = `${month}-01`
    const end = `${month}-${String(lastDay).padStart(2, '0')}`
    pinDateFromChart({ start, end, preset: monthLabel(month) })
    if (shownTrendGroup?.series_id) setPendingSingleDrill(shownTrendGroup.series_id)
    setMode('single')
  }

  function drillToTransactions(cat) {
    const categoryId = cat.category_id ?? cat.payload?.category_id
    const catRow = catRows.find(r => r.category_id === categoryId) || cat
    // Selecting the category keys the paged category-transaction list (usePagedTransactions), which
    // fetches on its own — including the synthetic uncategorized-bucket ids the summary can surface, so
    // the selected row's id is forwarded as-is rather than collapsed back to a single label.
    setSelectedCat(catRow)
    setLevel('transactions')
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
    const groupId = group.group_id
    const groupRow = cmpGroupsA.find(r => r.group_id === groupId) ||
      cmpGroupsB.find(r => r.group_id === groupId) || group
    setDrillLoading(true)
    setCmpGroup(groupRow)
    try {
      const isLatest = beginCompareCategories()
      const [a, b] = await Promise.all([
        fetchPeriodCatTotals(periodA, groupId, accountId, tagIds, ownerIds, summaryFilters),
        fetchPeriodCatTotals(periodB, groupId, accountId, tagIds, ownerIds, summaryFilters),
      ])
      if (isLatest()) {
        setCmpCatsA(a)
        setCmpCatsB(b)
      }
      setCmpLevel('categories')
    } finally {
      setDrillLoading(false)
    }
  }

  const pieGroupRows = viewIsIncome ? incomeRows : groupRows
  // The drill tiles show the selected row's figure from the lists as they stand, not from the copy taken
  // when it was drilled into: an edit refreshes the lists in place, and a copy would keep the old total.
  // A row the refreshed list no longer holds has nothing left in the period.
  const selectedGroupTotal = selectedGroup
    ? [...groupRows, ...incomeRows].find(r => r.group_id === selectedGroup.group_id)?.total ?? 0
    : 0
  const selectedCatTotal = selectedCat
    ? (selectedGroup ? catRows : topCatRows).find(r => r.category_id === selectedCat.category_id)?.total ?? 0
    : 0
  const coloredGroupRows = assignColors(pieGroupRows, 'group_color')
  const coloredCatRows = assignColors(catRows, 'category_color')
  const coloredTopCatRows = assignColors(topCatRows, 'category_color')
  const totalSpend = groupRows.reduce((s, r) => s + r.total, 0)
  const totalIncome = incomeRows.reduce((s, r) => s + r.total, 0)
  const pieGroupTotal = pieGroupRows.reduce((s, r) => s + r.total, 0)

  // The cash-flow frame reads the *same* period summary the other two frames read — no extra fetch —
  // and re-projects it onto the one axis this frame reports (positive = money in). Its breakdown
  // granularity follows the same group/category selector; the two group lists are recombined because
  // cash flow spans both sides of the ledger rather than one of them.
  const cashFlowGraph = useMemo(() => {
    if (!viewIsCashFlow) return null
    const byCategory = activeSpendingViewBy === SPENDING_VIEW_BY_CATEGORY
    return buildCashFlowGraph(
      byCategory ? topCatRows : [...groupRows, ...incomeRows],
      {
        keyField: byCategory ? 'category_id' : 'group_id',
        nameField: byCategory ? 'category_name' : 'group_name',
        palette: CHART_PALETTE,
        depths: cashFlowDepths,
      },
    )
  }, [viewIsCashFlow, activeSpendingViewBy, topCatRows, groupRows, incomeRows, cashFlowDepths])

  const tagsById = useMemo(() => {
    const map = new Map()
    for (const tag of availableTags) map.set(tag.id, tag)
    return map
  }, [availableTags])
  const tagSignatureRows = useMemo(
    () => activeTagReport ? buildTagSignatureRows(tagSignatureBuckets, tagsById) : [],
    [activeTagReport, tagSignatureBuckets, tagsById],
  )
  const tagSignatureTotal = tagSignatureRows.reduce((s, r) => s + r.total, 0)

  // An open TagDetail's header count and total are the server's bucket for that wedge, so that the panel
  // and the pie state the same figure. That only holds if the panel re-reads the wedge: the aggregates
  // refresh under it on every transaction change (refreshTotalsInPlace), and a panel still rendering its
  // opening snapshot would sit beside a pie it no longer agrees with. A signature that has emptied out
  // drops from the refreshed rows entirely, which is a count of zero rather than a missing answer — the
  // rows left on screen are the edited ones lingering (ui-patterns: an edited transaction lingers). With
  // the report no longer the active breakdown nothing is refreshing behind the panel, so its snapshot is
  // still the last thing the server said about that wedge and stands.
  function liveTagSignature(entry) {
    if (!activeTagReport || activeTagReport.id !== entry.reportId) return entry.signature
    return tagSignatureRows.find(row => row.signature_id === entry.signatureId)
      || { ...entry.signature, count: 0, total: 0 }
  }

  // A cash-flow node's click goes wherever that node's own kind of thing already goes: a collapsed tail
  // pages its own side one level deeper, and a bucket takes the same drill its pie wedge would — groups
  // to their categories, categories to their transactions. Passing the node's underlying summary row
  // (rather than the node) is what lets those handlers keep reading the fields they already read; an
  // income group is not in `groupRows`, so the row it falls back to has to be a real summary row.
  function handleCashFlowNodeClick(node) {
    if (!node) return
    if (node.isOther) {
      setCashFlowDepths(prev => ({ ...prev, [node.side]: (prev[node.side] || 0) + 1 }))
      return
    }
    if (!node.row) return
    if (activeSpendingViewBy === SPENDING_VIEW_BY_CATEGORY) drillToTransactions(node.row)
    else drillToCategories(node.row)
  }

  function handleSpendingViewByChange(value) {
    if (value === NEW_TAG_REPORT_OPTION) {
      setTagBuilder({ reportId: null })
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
    }).catch(() => { })
  }

  function handleDisplayTagReportTransient(tagIds) {
    const transient = { id: TRANSIENT_TAG_REPORT_ID, name: 'Custom (unsaved)', tagIds }
    setTransientTagReport(transient)
    setSpendingViewBy(`${TAG_REPORT_PREFIX}${transient.id}`)
  }

  function handleRenameTagReport(id, newName) {
    const cleaned = String(newName || '').trim()
    if (!cleaned) return
    setTagReports(savedTagReports.map(r => r.id === id ? { ...r, name: cleaned } : r))
  }

  // A deliberate rebuild resets the missing-tags suppression: it dismissed the old tag set's gaps, not
  // any a later tag deletion opens in the new one.
  function handleEditTagReportTags(id, tagIds) {
    setTagReports(savedTagReports.map(r => {
      if (r.id !== id) return r
      const { dismissedMissingWarning: _dismissed, ...rest } = r
      return { ...rest, tagIds }
    }))
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
  if (selectedCat) singleCrumbs.push(selectedCat.category_name)

  const cmpCrumbs = [periodLabel(periodA) + ' vs ' + periodLabel(periodB)]
  if (cmpGroup) cmpCrumbs.push(cmpGroup.group_name)

  // Hold the paint until the 'auto' default resolves on first visit, so the Dashboard doesn't flash an
  // all-time view before snapping to the default. Only the single-period view is scoped by the effective
  // date; Compare/Trends have their own windows. Brief, and cached after the first visit of a session.
  if (dateResolving && mode === 'single') {
    return <div data-browser-context-passthrough="true" style={{ height: '100%' }} />
  }

  return (
    <div data-browser-context-passthrough="true" style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '32px 32px 0', flexShrink: 0 }}>
        <PageHeader
          title="Dashboard"
          help={<FeatureExplainer topic="page-dashboard" placement="bottom-left" />}
          titleAdornment={(
            <DashboardDefaultPeriodGear
              pref={defaultPeriodPref}
              setPref={setDefaultPeriodPref}
            />
          )}
          leftAdornment={(mode === 'single' || mode === 'trends') && (
            <SegmentedToggle
              value={dashboardView}
              options={DASHBOARD_VIEW_OPTIONS}
              onChange={setDashboardView}
              ariaLabel="Choose dashboard frame"
            />
          )}
        >
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <SegmentedToggle
              value={mode}
              options={DASHBOARD_MODE_OPTIONS}
              onChange={setMode}
              ariaLabel="Choose dashboard analysis mode"
            />
          </div>
        </PageHeader>
      </div>

      {/* Small top padding so a focusable control sitting at the very top of this scroll area (e.g. the
          Trends window chooser) isn't clipped at the overflow edge — its focus outline needs room above the
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

        {/* First load gets the spinner; a reload keeps the figures up but visibly not-current, because
            these numbers answer a question the user has just changed — leaving the previous period’s
            totals standing as if they were the new ones is worse than a flicker. See
            `StaleWhileRefreshing`. */}
        {loading && !hasTotals ? <Spinner /> : (
          <StaleWhileRefreshing refreshing={loading}>
            {mode === 'single' && (
              <>

                <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
                  {viewIsCashFlow ? (
                    <>
                      {/* Money out leads, as spending does on the other two frames — the cards are read
                          as a row across frames, so a consistent reading order matters more here than
                          mirroring the diagram below, which runs sources-left to destinations-right. */}
                      <SummaryTotalCard label={`Money out · ${singlePeriodLabel}`}
                        value={cashFlowGraph?.outflowTotal || 0} />
                      <SummaryTotalCard label={`Money in · ${singlePeriodLabel}`}
                        value={cashFlowGraph?.inflowTotal || 0} color="var(--success)" />
                      {/* Signed on the cash axis, so a period that spent more than it took in reads
                          negative rather than being flattened into a magnitude. */}
                      <SummaryTotalCard label={`Net · ${singlePeriodLabel}`}
                        value={cashFlowGraph?.net || 0}
                        color={(cashFlowGraph?.net || 0) < 0 ? 'var(--danger)' : 'var(--success)'} />
                    </>
                  ) : (
                    <>
                      <SummaryTotalCard label={`Total spending · ${singlePeriodLabel}`} value={totalSpend} />
                      {totalIncome > 0 && (
                        <SummaryTotalCard label={`Total income · ${singlePeriodLabel}`} value={totalIncome}
                          color="var(--success)" />
                      )}
                    </>
                  )}
                  {selectedGroup && level !== 'groups' && (
                    <Card style={{ padding: '14px 24px' }}>
                      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 2 }}>{selectedGroup.group_name}</div>
                      <div style={{ fontSize: 28, fontWeight: 700 }}>{formatSignedMoneyAmount(selectedGroupTotal)}</div>
                    </Card>
                  )}
                  {selectedCat && level === 'transactions' && (
                    <Card style={{ padding: '14px 24px' }}>
                      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 2 }}>{selectedCat.category_name}</div>
                      <div style={{ fontSize: 28, fontWeight: 700 }}>{formatSignedMoneyAmount(selectedCatTotal)}</div>
                    </Card>
                  )}
                </div>

                {(level !== 'groups' || otherDrillDepth > 0) && <Breadcrumb items={singleCrumbs} onNavigate={singleNavigate} />}

                {reportConflictText && (
                  <FilterConflictNote
                    style={{ marginBottom: 16 }}
                    actionLabel={reportConflictActionLabel}
                    onAction={() => removeSelections(resolveConflictSelectionIds(reportConflicts, filters.selections))}
                  >
                    {reportConflictText}
                  </FilterConflictNote>
                )}

                {/* A drill keeps the current breakdown on screen until the group's categories arrive, so
                    the page does not collapse around a spinner and spring back. */}
                {level !== 'transactions' && (
                  <StaleWhileRefreshing refreshing={drillLoading}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 24 }}>
                      {/* The diagram wants the full row: it is one wide picture rather than a chart paired
                          with a legend, and its node labels already carry the names and figures the
                          breakdown list carries for the pie. */}
                      {level === 'groups' && viewIsCashFlow && (
                        <Card style={{ gridColumn: '1 / -1' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, fontSize: 14, fontWeight: 600 }}>
                            <span>Cash flow by</span>
                            <Select
                              value={activeSpendingViewBy}
                              onChange={handleSpendingViewByChange}
                              options={spendingViewByOptions}
                              aria-label="Choose dashboard cash-flow breakdown"
                            />
                            <FeatureExplainer topic="dashboard-cash-flow" placement="bottom-left" />
                          </div>
                          <CashFlowSankey
                            graph={cashFlowGraph}
                            depths={cashFlowDepths}
                            onNodeClick={handleCashFlowNodeClick}
                            onBack={side => setCashFlowDepths(prev => ({ ...prev, [side]: Math.max((prev[side] || 0) - 1, 0) }))}
                          />
                        </Card>
                      )}
                      {level === 'groups' && !viewIsCashFlow && (() => {
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
                        // `pieValue` floors each wedge's geometry at zero so a net-refund bucket (negative
                        // signed total) can't draw a broken/negative sector; the list and tooltip still show
                        // the true signed `total`. Same floor-the-geometry-keep-the-number rule as the trend
                        // charts.
                        const pieData = (otherSlice ? [...pageRows, otherSlice] : pageRows)
                          .map(r => ({ ...r, pieValue: Math.max(Number(r.total) || 0, 0) }))
                        const expansionAvailable = allRows.length > pageRows.length
                        const listRows = showAllSpendingRows ? allRows : pieData
                        // A filter can leave nothing in this view (e.g. an income-only include chip on the
                        // expense view). The header stays so the breakdown can still be switched.
                        const isEmpty = allRows.length === 0 && !(viewIsTag && tagModeLoading)

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
                            <Card style={isEmpty ? { gridColumn: '1 / -1' } : undefined}>
                              <div
                                style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, fontSize: 14, fontWeight: 600 }}
                                onContextMenu={event => {
                                  if (!activeTagReport) return
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
                                {activeTagReport && (
                                  <ActionMenuButton
                                    title="Manage this tag report"
                                    open={pickerMenuOpen?.id === activeTagReport.id}
                                    onOpen={rect => setPickerMenuOpen({ id: activeTagReport.id, anchorRect: rect })}
                                  />
                                )}
                              </div>
                              {viewIsTag && tagModeLoading ? (
                                <div style={{ height: 220, display: 'grid', placeItems: 'center' }}>
                                  <Spinner />
                                </div>
                              ) : isEmpty ? (
                                <EmptyState message={viewIsIncome ? 'No income for this selection' : 'No spending for this selection'} />
                              ) : (
                                <ResponsiveContainer width="100%" height={220}>
                                  <PieChart>
                                    {/* Static: the sweep-in runs for a second and a half, and it would
                                        replay on every filter, period and drill-down step. */}
                                    <Pie data={pieData} dataKey="pieValue" nameKey={rowName}
                                      cx="50%" cy="50%" innerRadius={55} outerRadius={95} paddingAngle={2}
                                      isAnimationActive={false}
                                      onClick={d => d && handleSliceClick(d)} style={{ cursor: 'pointer' }}>
                                      {pieData.map((r, i) => <Cell key={i} fill={r[rowColor]} />)}
                                    </Pie>
                                    <Tooltip
                                      // Show the true signed total, not the zero-floored wedge geometry.
                                      formatter={(v, name, item) => formatSignedMoneyAmount(item?.payload?.total ?? v)}
                                      contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
                                      labelStyle={CHART_TOOLTIP_LABEL_STYLE}
                                      itemStyle={CHART_TOOLTIP_ITEM_STYLE}
                                    />
                                  </PieChart>
                                </ResponsiveContainer>
                              )}
                              {!isEmpty && (
                                <div style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'center', marginTop: 4 }}>
                                  {viewIsTag || viewIsCategory ? 'Click to see transactions' : 'Click to drill down'}
                                </div>
                              )}
                            </Card>
                            {!isEmpty && <Card>
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
                                        {formatSignedMoneyAmount(r.total)}
                                      </span>
                                      <span style={{ color: 'var(--muted)', fontSize: 14, flexShrink: 0 }}>›</span>
                                    </div>
                                  )
                                })}
                              </div>
                              {expansionAvailable && (
                                <div style={{ textAlign: 'center', marginTop: 10 }}>
                                  <LinkButton onClick={() => setShowAllSpendingRows(v => !v)} style={{ padding: '4px 8px', fontSize: 13 }}>
                                    {showAllSpendingRows
                                      ? 'Show less'
                                      : `Show all ${viewIsTag ? 'wedges' : viewIsCategory ? 'categories' : 'groups'}`}
                                  </LinkButton>
                                </div>
                              )}
                            </Card>}
                          </>
                        )
                      })()}

                      {/* Empty when an in-place refresh (recategorizing, a sync) moved the group's last
                          transactions out; a filter change returns to the top level instead. */}
                      {level === 'categories' && selectedGroup && (
                        <>
                          <Card style={catRows.length === 0 ? { gridColumn: '1 / -1' } : undefined}>
                            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
                              <CategoryMarker kind="group" />
                              <span>{selectedGroup.group_name}</span>
                            </div>
                            {catRows.length === 0 ? (
                              <EmptyState message={viewIsIncome ? 'No income for this selection' : 'No spending for this selection'} />
                            ) : (
                              <>
                                <ResponsiveContainer width="100%" height={220}>
                                  <PieChart>
                                    {/* `pieValue` floors wedge geometry at zero so a net-refund category can't
                                      draw a negative sector; tooltip/list show the true signed total. */}
                                    <Pie data={coloredCatRows.map(c => ({ ...c, pieValue: Math.max(Number(c.total) || 0, 0) }))}
                                      dataKey="pieValue" nameKey="category_name"
                                      cx="50%" cy="50%" innerRadius={55} outerRadius={95} paddingAngle={2}
                                      isAnimationActive={false}
                                      onClick={d => d && drillToTransactions(d)} style={{ cursor: 'pointer' }}>
                                      {coloredCatRows.map((c, i) => <Cell key={i} fill={c._chartColor} />)}
                                    </Pie>
                                    <Tooltip
                                      formatter={(v, name, item) => formatSignedMoneyAmount(item?.payload?.total ?? v)}
                                      contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
                                      labelStyle={CHART_TOOLTIP_LABEL_STYLE}
                                      itemStyle={CHART_TOOLTIP_ITEM_STYLE}
                                    />
                                  </PieChart>
                                </ResponsiveContainer>
                                <div style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'center', marginTop: 4 }}>Click to see transactions</div>
                              </>
                            )}
                          </Card>
                          {catRows.length > 0 && <Card>
                            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>Categories</div>
                            {coloredCatRows.map(c => (
                              <div key={c.category_id} onClick={() => drillToTransactions(c)} style={{
                                display: 'flex', alignItems: 'center', gap: 10,
                                padding: '8px 0', borderBottom: '1px solid var(--border)', cursor: 'pointer',
                              }}>
                                <span style={{ width: 10, height: 10, borderRadius: '50%', background: c.category_color, flexShrink: 0 }} />
                                <span style={{ fontSize: 14, flex: 1 }}>{c.category_name}</span>
                                <SpendBar value={c.total} total={catRows.reduce((s, r) => s + r.total, 0)} color={c.category_color} />
                                <span style={{ fontSize: 12, color: 'var(--muted)', minWidth: 52, textAlign: 'right' }}>{c.count} txns</span>
                                <span style={{ fontSize: 13, fontWeight: 600, minWidth: 70, textAlign: 'right' }}>{formatSignedMoneyAmount(c.total)}</span>
                                <span style={{ color: 'var(--muted)', fontSize: 16 }}>›</span>
                              </div>
                            ))}
                          </Card>}
                        </>
                      )}
                    </div>
                  </StaleWhileRefreshing>
                )}

                {(() => {
                  const trendTotal = trend.reduce((s, r) => s + (Number(r.total) || 0), 0)
                  const trendBucketMean = trend.length > 0 ? trendTotal / trend.length : 0
                  // Per elapsed time at the grain on screen, so a part-finished month, quarter or year
                  // at the end sits below the line rather than pulling it down (see periodAverage.js).
                  // **Same-span mode keeps the mean of its buckets**, and that is not an oversight: its
                  // buckets are the user's own window repeated — Jan 1 to Oct 7 in each year — so they
                  // are equal by construction and the newest is full by definition of the span.
                  // Comparing like with like is the whole point of the mode, and a day-rate would undo
                  // it. `trimEmptyTrendBuckets` already drops an oldest bucket reaching past the data.
                  const trendSpan = trendIsSameSpan
                    ? null
                    : seriesDateRange(
                      (trendMonthlyRows || []).filter(r => (
                        r.month >= trend[0]?.bucketStart && r.month <= trend[trend.length - 1]?.bucketEnd
                      )),
                    )
                  const trendAvg = trendIsSameSpan
                    ? trendBucketMean
                    : periodAverage(trendTotal, trendSpan?.firstDate, trendSpan?.lastDate, trendGrain)
                  // One exceptional period would otherwise own the whole axis and flatten every other
                  // bar against zero — a ledger produces those routinely (a house purchase, a tax
                  // settlement, a run of miscategorised transfers). The axis is bounded to what the
                  // ordinary bars can be read against and the outlier is drawn torn off at the frame
                  // with its real figure on it; `total` stays true everywhere it is read. Engages only
                  // when there genuinely is an outlier, so the usual chart is untouched.
                  const trendClamp = computeClampedDomain(trend.map(r => r.total), { average: trendAvg ?? trendBucketMean })
                  const trendData = trend.map(r => {
                    const { plotted, clipped } = clampBarValue(r.total, trendClamp.bound)
                    return { ...r, plotted, __clipped: clipped, __clippedValue: r.total }
                  })
                  const grainWord = trendGrain === 'year' ? 'Yearly' : trendGrain === 'quarter' ? 'Quarterly' : 'Monthly'
                  function handleTrendBarClick(d) {
                    if (!d) return
                    const date = { start: d.rangeStart, end: d.rangeEnd, preset: d.fullLabel }
                    // The bar that *is* the selection (a same-span bar, or Last month's own month) would
                    // only rename it — "Year to date" to its dates — and record a step back to itself.
                    if (sameDateRange(date, filters.date)) return
                    // Clicking a bar re-pins the date filter onto it so the rest of the page re-renders with
                    // it as the new "selected period." Pinned through the recording setter, so the header's
                    // back-step can undo it — a FilterBar pick is a visible choice and does not record.
                    // The period's transactions open from the header's "View transactions" button, not a
                    // bar double-click (Recharts bars can't be double-clicked reliably).
                    keepTrendGrainForDateRef.current = date
                    keepDrillForDateRef.current = date
                    pinDateFromChart(date)
                  }
                  function handleTrendBack() {
                    keepTrendGrainForDateRef.current = previousDate
                    keepDrillForDateRef.current = previousDate
                    goBackDate()
                  }
                  // The header link opens the transaction drawer for the whole selected period (day-precise
                  // dates, not the bar's month range), so it's available even when no single bar is focused.
                  function openSelectedPeriodTransactions() {
                    // Opens the effective period (explicit pick or the Dashboard default). A rangeless
                    // all-time value has no bounded period to open, so the link is inert there.
                    if (!effectiveDate || !effectiveDate.start || !effectiveDate.end) return
                    const sM = effectiveDate.start.slice(0, 7)
                    const eM = effectiveDate.end.slice(0, 7)
                    const label = effectiveDate.preset
                      || (sM === eM ? monthLabel(sM) : `${monthLabel(sM)} – ${monthLabel(eM)}`)
                    openPeriodDetail({ start: effectiveDate.start, end: effectiveDate.end, label }, activeFrame)
                  }
                  return (
                    <Card style={trendScopeId ? { marginBottom: 24 } : undefined}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
                        <div style={{ fontSize: 14, fontWeight: 600 }}>
                          {trendScopeName ? `Trend · ${trendScopeName}` : 'Trend'}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          {/* Clicking a bar re-pins the period, which is a navigation the user did not
                              necessarily read as one — and the FilterBar shows where they are now, not
                              where they were. Naming the destination is the part that makes this
                              answerable rather than just reversible. Armed only by those pins: an
                              explicit FilterBar change clears the history, so this never offers to
                              step back over a period the user chose themselves. */}
                          {canGoBackDate && (
                            <Button
                              variant="secondary"
                              onClick={handleTrendBack}
                              title={`Return to ${describeDateFilter(previousDate)}`}
                            >
                              ← Back to {describeDateFilter(previousDate)}
                            </Button>
                          )}
                          {/* A drill already lists its period's transactions beneath the chart. */}
                          {!trendScopeId && effectiveDate && effectiveDate.start && effectiveDate.end && (
                            <Button
                              variant="secondary"
                              size="compact"
                              onClick={openSelectedPeriodTransactions}
                              title="Open the transactions for the selected period"
                            >
                              View transactions ↗
                            </Button>
                          )}
                          <TrendSpanSelect
                            value={trendSpanPref}
                            onChange={setTrendSpanPref}
                            dataFirstMonth={trendDataMonths.firstMonth}
                            dataLastMonth={trendDataMonths.lastMonth}
                            grain={trendIsSameSpan ? 'month' : trendGrain}
                          />
                          <select
                            value={trendGrain}
                            onChange={e => setTrendGrainChoice(e.target.value)}
                            aria-label="Trend bucket size"
                            style={{
                              background: 'var(--surface2)', color: 'var(--text)',
                              border: '1px solid var(--border)', borderRadius: 8,
                              padding: '4px 8px', fontSize: 12, cursor: 'pointer',
                            }}
                          >
                            {trendGrainOptions(filters.date).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        </div>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
                        {trendIsSameSpan
                          ? `The selected span, repeated each ${trendGrainNoun(filters.date)}`
                          : `${grainWord} totals ${describeTrendSpan(trendSpanPref)}`}
                        {' · click a bar to focus it · scroll horizontally to pan'}
                      </div>
                      <StaleWhileRefreshing refreshing={computedTrend == null} style={{ display: 'flex', alignItems: 'flex-start' }}>
                        {/* The value axis, held out of the scroll so it stays readable at any pan
                            position. It is a chart rather than hand-drawn labels so that recharts works
                            out the ticks — the same ticks, from the same data and domain, that the plot
                            beside it is scaled to. */}
                        <div style={{ width: TREND_AXIS_COLUMN_WIDTH, height: TREND_CHART_HEIGHT, flexShrink: 0 }}>
                          {/* Sized, not measured — see the plot below. This box was never responsive at
                              all: it is a constant beside a constant. */}
                          <BarChart
                            width={TREND_AXIS_COLUMN_WIDTH}
                            height={TREND_CHART_HEIGHT}
                            data={trendData}
                            margin={{ top: TREND_CHART_MARGIN_Y, right: 0, bottom: TREND_CHART_MARGIN_Y, left: 0 }}
                          >
                            <YAxis
                              width={TREND_AXIS_LABEL_WIDTH}
                              tickFormatter={formatSignedAxisTick}
                              tick={{ fill: 'var(--muted)', fontSize: 11 }}
                              domain={trendClamp.domain}
                              allowDataOverflow={trendClamp.clamped}
                            />
                            {/* Draws nothing; it reserves exactly the height the plot's category axis
                                reserves, which is what keeps the two vertical scales in step. */}
                            <XAxis dataKey="label" height={TREND_XAXIS_HEIGHT} tick={false} axisLine={false} />
                            {/* Invisible rather than hidden: `hide` drops the series from the domain
                                altogether and the axis comes out blank. */}
                            <Bar dataKey="plotted" fillOpacity={0} isAnimationActive={false} />
                            {/* The average's pill lives here rather than on its line in the plot,
                                where it would pan out of view and stay out on a long timeline. It
                                reads the same scale the ticks were drawn from, and steps aside from
                                any tick label it would otherwise sit on. */}
                            {trend.length > 1 && trendAvg != null && (
                              <AxisAvgPill value={trendAvg} columnWidth={TREND_AXIS_COLUMN_WIDTH} />
                            )}
                          </BarChart>
                        </div>
                        <div
                          ref={attachTrendScroll}
                          onScroll={rememberTrendAnchor}
                          style={{ flex: 1, minWidth: 0, overflowX: 'auto', overflowY: 'hidden' }}
                        >
                          {/* Given its width rather than left to discover one. `<ResponsiveContainer>`
                            measures its own box with a ResizeObserver and holds the result in state, so
                            a re-bucket draws once at the *previous* bucket set's width and is corrected
                            only after paint — a stale-width frame whose look depends on which way the
                            grain went and where the plot was scrolled. The width is not responsive
                            anyway: it is the bucket count, and the viewport only when the buckets do
                            not fill it. */}
                          <div style={{ width: trendPlot.width, height: TREND_CHART_HEIGHT }}>
                            <BarChart
                              width={trendPlot.width}
                              height={TREND_CHART_HEIGHT}
                              data={trendData}
                              margin={{ top: TREND_CHART_MARGIN_Y, right: 12, bottom: TREND_CHART_MARGIN_Y, left: 0 }}
                              // On the chart, not the bar: the target is the whole hovered column, so a
                              // short bar is as easy to pick as a tall one.
                              {...CLICKABLE_CHART_EVENTS}
                              onClick={state => handleTrendBarClick(trendData[clickedDataIndex(state)])}
                              style={{ cursor: 'pointer' }}
                            >
                              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                              <XAxis
                                dataKey="label"
                                interval={0}
                                tick={<TrendBucketTick />}
                                height={TREND_XAXIS_HEIGHT}
                              />
                              {/* Hidden, not absent: the scale still has to be computed here, and it is
                                identical to the column's because the domain and data are. */}
                              <YAxis
                                hide
                                domain={trendClamp.domain}
                                allowDataOverflow={trendClamp.clamped}
                              />
                              <Tooltip
                                // The plot pans, so the card is placed against what is visible rather than
                                // against the whole canvas — see PanningChartTooltip.
                                content={<PanningChartTooltip />}
                                isAnimationActive={false}
                                // The drawn value is clamped; the tooltip reports the real one.
                                formatter={(v, name, item) => formatSignedMoneyAmount(item?.payload?.total ?? v)}
                                // The axis label is cut to fit a bar; the card names the exact range.
                                labelFormatter={(label, payload) => payload?.[0]?.payload?.fullLabel ?? label}
                                contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
                                labelStyle={CHART_TOOLTIP_LABEL_STYLE}
                                itemStyle={CHART_TOOLTIP_ITEM_STYLE}
                              />
                              {/* Static, like the axis column beside it. Re-bucketing replaces the whole
                                series, so the default grow-in plays in full on every grain change — and
                                with the axis in its own chart it would be an animation running against
                                a scale that had already snapped. */}
                              <Bar
                                dataKey="plotted"
                                radius={[4, 4, 0, 0]}
                                shape={<ClippedBar />}
                                name={trendScopeName || (viewIsCashFlow ? 'Net' : viewIsIncome ? 'Income' : 'Spending')}
                                isAnimationActive={false}
                              >
                                {trendData.map((entry, idx) => (
                                  <Cell
                                    key={idx}
                                    fill={entry.isSelected
                                      ? 'var(--accent)'
                                      : 'color-mix(in srgb, var(--accent) 45%, var(--surface2))'}
                                  />
                                ))}
                              </Bar>
                              {/* Unlabelled: the pill naming this line is in the sticky axis column,
                                which is the only part of the chart that does not pan away. */}
                              {trendData.length > 1 && trendAvg != null && (
                                <ReferenceLine y={trendAvg} stroke="var(--accent2)" strokeDasharray="4 4" />
                              )}
                            </BarChart>
                          </div>
                        </div>
                      </StaleWhileRefreshing>
                    </Card>
                  )
                })()}

                {level === 'transactions' && selectedCat && (
                  <Card style={{ padding: 0, overflow: 'hidden' }}>
                    {/* Empty only once the fetch has answered: a trend bar can move the period to one
                      the category had nothing in. */}
                    {txnData.length === 0 ? (
                      catTxnPaged.loading
                        ? <Spinner />
                        : <EmptyState message={viewIsIncome ? 'No income for this selection' : 'No spending for this selection'} />
                    ) : (
                      <>
                        <TransactionListToolbar rows={txnData} copy={catTxnPaged.copy} title={selectedCat.category_name} bulk={selectedCatBulk} onRefresh={catTxnPaged.reload} refreshing={catTxnPaged.reloading} style={{ marginBottom: 0, padding: '8px 12px 0' }} />
                        <div style={{ padding: '0 12px' }}>
                          <BulkEditChrome controller={selectedCatBulk} />
                        </div>
                        <TransactionListTable
                          rows={txnData}
                          categories={categories}
                          {...selectedCatBulk.tableProps}
                          onCategorySave={(txnId, catId, catObj) => {
                            const cat = catObj || categories.find(c => c.id === catId)
                            applyCategoryChange(txnId, cat, (patch, id) => setTxnData(prev => prev.map(
                              x => x.id === id ? { ...x, ...patch } : x)))
                          }}
                          onRowsChange={setTxnData}
                          onTransactionOpenDetail={openTransactionDetail}
                          onTrashed={txnId => { reconcileDetailEdit(txnId, null); catTxnPaged.setTotal(prev => Math.max(0, prev - 1)) }}
                          columnConfig={categoryTxnColumns}
                          onColumnConfigChange={setCategoryTxnColumns}
                          paging={catTxnPaged.paging}
                          sortState={catTxnPaged.sortState}
                          onSort={catTxnPaged.onSort}
                        />
                      </>
                    )}
                  </Card>
                )}

                {level === 'categories' && selectedGroup && groupTxnData.length > 0 && (
                  <Card style={{ padding: 0, overflow: 'hidden' }}>
                    <div style={{
                      padding: '12px 16px', fontSize: 14, fontWeight: 600,
                      borderBottom: '1px solid var(--border)',
                      display: 'flex', alignItems: 'center', gap: 8,
                    }}>
                      <span>
                        {selectedGroup.group_name} · {groupTxnDataTotal} transactions
                        <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--muted)', marginLeft: 8 }}>
                          Click a category above to filter
                        </span>
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
                        <RefreshButton
                          onRefresh={groupTxnPaged.reload}
                          loading={groupTxnPaged.reloading}
                          title="Refresh — re-query the list and drop transactions that no longer match"
                        />
                        <CopyTransactionsButton rows={groupTxnData} {...groupTxnPaged.copy} title={selectedGroup.group_name} tooltip="Copy the transactions shown" />
                        <Button variant="secondary" onClick={selectedGroupBulk.toggle}>
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
                        applyCategoryChange(txnId, cat, (patch, id) => setGroupTxnData(prev => prev.map(
                          x => x.id === id ? { ...x, ...patch } : x)))
                      }}
                      onRowsChange={setGroupTxnData}
                      onTransactionOpenDetail={openTransactionDetail}
                      onTrashed={txnId => { reconcileDetailEdit(txnId, null); groupTxnPaged.setTotal(prev => Math.max(0, prev - 1)) }}
                      columnConfig={groupTxnColumns}
                      onColumnConfigChange={setGroupTxnColumns}
                      maxHeight={320}
                      paging={groupTxnPaged.paging}
                      sortState={groupTxnPaged.sortState}
                      onSort={groupTxnPaged.onSort}
                    />
                  </Card>
                )}
              </>
            )}

            {mode === 'trends' && viewIsCashFlow && (
              <CashFlowTrendsPanel
                rows={cashFlowTrendRows}
                annualRows={cashFlowAnnualRows}
                selectedYear={trendYear}
                onYearChange={setTrendYear}
                span={trendSpanPref}
                onSpanChange={setTrendSpanPref}
                loading={trendLoading}
                onOpenMonth={month => openMonthDetail(month, activeFrame)}
                onOpenSinglePeriod={openSinglePeriodForMonth}
              />
            )}

            {mode === 'trends' && !viewIsCashFlow && (
              <TrendsPanel
                rows={trendRows}
                trendWindow={trendWindow}
                groups={trendGroups}
                onYearChange={setTrendYear}
                span={trendSpanPref}
                onSpanChange={setTrendSpanPref}
                drillGroup={shownTrendGroup}
                pickedGroup={trendGroup}
                onDrillGroup={g => setTrendGroup(g)}
                onClearDrill={() => setTrendGroup(null)}
                loading={trendLoading}
                viewIsIncome={viewIsIncome}
                // With a group drilled the month bars are that group's totals, so a month's report is
                // scoped to the group as well.
                onOpenMonth={month => openMonthDetail(month, activeFrame, shownTrendGroup
                  ? { kind: 'group', id: shownTrendGroup.series_id, name: shownTrendGroup.series_name }
                  : null)}
                onOpenReport={(range, scope) => openPeriodDetail(range, activeFrame, scope)}
                onOpenSinglePeriod={openSinglePeriodForMonth}
              />
            )}

            {mode === 'compare' && (
              <>
                <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
                  <Card style={{ padding: '14px 24px' }}>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 2 }}>{periodLabel(periodA)}</div>
                    <div style={{ fontSize: 28, fontWeight: 700 }}>{formatSignedMoneyAmount(cmpTotalA)}</div>
                  </Card>
                  <Card style={{ padding: '14px 24px' }}>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 2 }}>{periodLabel(periodB)}</div>
                    <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--muted)' }}>{formatSignedMoneyAmount(cmpTotalB)}</div>
                    {(() => {
                      // Mirror CompareRow: percent vs a positive prior total, else the absolute dollar
                      // change (a whole-period total going <= 0 is vanishingly rare, but keep it accurate).
                      const diff = cmpTotalA - cmpTotalB
                      const text = cmpTotalB > 0
                        ? `${Math.abs((diff / cmpTotalB) * 100).toFixed(0)}%`
                        : (diff !== 0 ? `${diff > 0 ? '+' : '-'}${formatCurrency(diff)}` : null)
                      if (text === null) return null
                      return (
                        <div style={{ fontSize: 12, marginTop: 2, color: diff > 0 ? 'var(--danger)' : 'var(--success)' }}>
                          {diff > 0 ? '▲' : '▼'} {text} vs {periodLabel(periodA)}
                        </div>
                      )
                    })()}
                  </Card>
                </div>

                {cmpLevel !== 'groups' && (
                  <Breadcrumb
                    items={cmpCrumbs}
                    onNavigate={() => { setCmpLevel('groups'); setCmpGroup(null) }}
                  />
                )}

                {/* A drill keeps the current breakdown on screen until the group's figures arrive, so the
                    page does not collapse around a spinner and spring back. */}
                <StaleWhileRefreshing refreshing={drillLoading}>
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
                </StaleWhileRefreshing>
              </>
            )}
          </StaleWhileRefreshing>
        )}
      </div>
      {detailTxns.map((txn, index) => (
        <TransactionDetail
          key={txn.id}
          txn={txn}
          categories={categories}
          forceFloating={multiDetailMode}
          stackIndex={index}
          isTopmost={index === detailTxns.length - 1 && detailPeriods.length === 0}
          onClose={() => closeTransactionDetail(txn.id)}
          onReconcile={reconcileDetailEdit}
          dateStart={dateStart || undefined}
          dateEnd={dateEnd || undefined}
        />
      ))}
      {detailPeriods.map((entry, index) => (
        <PeriodDetail
          key={entry.key}
          start={entry.start}
          end={entry.end}
          label={entry.label}
          view={entry.view}
          accountId={accountId || undefined}
          tagIds={tagIds}
          ownerIds={ownerIds}
          filters={summaryFilters}
          scope={entry.scope}
          categories={categories}
          forceFloating={detailTxns.length + detailPeriods.length + detailTagSignatures.length > 1}
          stackIndex={detailTxns.length + index}
          isTopmost={index === detailPeriods.length - 1 && detailTagSignatures.length === 0}
          onClose={() => closePeriodDetail(entry.key)}
        />
      ))}
      {detailTagSignatures.map((entry, index) => (
        <TagDetail
          key={entry.key}
          signature={liveTagSignature(entry)}
          reportTagIds={entry.reportTagIds}
          reportName={entry.reportName}
          view={entry.view}
          accountId={entry.accountId || undefined}
          dateStart={entry.dateStart || undefined}
          dateEnd={entry.dateEnd || undefined}
          filterTagIds={entry.filterTagIds || undefined}
          ownerIds={entry.ownerIds || undefined}
          filters={entry.filters}
          categories={categories}
          forceFloating={detailTxns.length + detailPeriods.length + detailTagSignatures.length > 1}
          stackIndex={detailTxns.length + detailPeriods.length + index}
          isTopmost={index === detailTagSignatures.length - 1}
          onClose={() => closeTagDetail(entry.key)}
        />
      ))}
      {tagBuilder && (() => {
        const report = tagBuilder.reportId ? allTagReports.find(r => r.id === tagBuilder.reportId) : null
        if (tagBuilder.reportId && !report) return null
        return (
          <TagReportBuilder
            availableTags={availableTags}
            report={report}
            onClose={() => setTagBuilder(null)}
            onDisplay={handleDisplayTagReportTransient}
            onSave={handleSaveTagReport}
            onSaveTags={tagIds => handleEditTagReportTags(report.id, tagIds)}
          />
        )
      })()}
      {/* Deleting a saved report drops it from the preference list with nothing to restore it from,
          which is what `danger` is reserved for — see ActionMenu. The unsaved custom report has
          nothing to rename or delete (picking anything else discards it); it offers a way to keep it. */}
      {pickerMenuOpen && (
        <ActionMenu
          anchorRect={pickerMenuOpen.anchorRect}
          align="start"
          minWidth={140}
          onClose={() => setPickerMenuOpen(null)}
          items={pickerMenuOpen.id === TRANSIENT_TAG_REPORT_ID ? [
            { label: 'Edit tags…', onClick: () => setTagBuilder({ reportId: pickerMenuOpen.id }) },
            { label: 'Save as…', onClick: () => setSaveAsOpen(true) },
          ] : [
            { label: 'Rename', onClick: () => setRenameTargetId(pickerMenuOpen.id) },
            { label: 'Edit tags…', onClick: () => setTagBuilder({ reportId: pickerMenuOpen.id }) },
            { label: 'Delete', danger: true, onClick: () => setDeleteTargetId(pickerMenuOpen.id) },
          ]}
        />
      )}
      {saveAsOpen && transientTagReport && (
        <SaveTagReportDialog
          onCancel={() => setSaveAsOpen(false)}
          onSave={name => {
            handleSaveTagReport({ name, tagIds: transientTagReport.tagIds })
            setSaveAsOpen(false)
          }}
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
                <Button variant="secondary" onClick={() => setDeleteTargetId(null)}>Cancel</Button>
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
