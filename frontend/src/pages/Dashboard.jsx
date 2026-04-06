// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Dashboard.jsx — Main spending overview with drill-down, compare, and trends
 *
 * MODES:
 *   'single'  — Single period view. Shows spending by group with a donut chart.
 *               Drill down: groups → categories → transactions (3-level state machine).
 *   'compare' — Side-by-side comparison of two user-defined periods.
 *               Uses PeriodPicker (preset + custom month range).
 *   'trends'  — Multi-month area chart + averages. Uses a year selector to
 *               keep the chart readable (one year at a time, or all-time for
 *               the annual totals bar).
 *
 * DRILL-DOWN STATE MACHINE (single mode):
 *   level: 'groups' → 'categories' → 'transactions'
 *   selectedGroup: null → GroupRow object
 *   selectedCat:   null → CategoryRow object
 *
 *   Navigating down: drillToCategories(group) / drillToTransactions(cat)
 *   Navigating up:   singleNavigate(index) via Breadcrumb clicks
 *
 *   At 'categories' level, the bottom panel shows ALL transactions for the
 *   selected group (not just a trend chart) so the user immediately sees
 *   what makes up the group total.
 *
 * DATE FILTERING:
 *   dateStart/dateEnd are derived from the global FilterContext.
 *   When no date filter is set, both are null and the API returns all-time data.
 *   The summary endpoints (by-group, by-category-in-group) accept either
 *   date_start/date_end or the legacy month param.
 *
 * COLOR ASSIGNMENT (assignColors):
 *   Charts use a display-local palette so the currently visible slices/bars
 *   always have strong contrast. This is presentation-only and does not depend
 *   on any stored category color in the database.
 *
 * ACCOUNT FILTERING:
 *   accountId is derived from global filter selections of type 'account'.
 *   Currently only single-account filtering is supported in summary endpoints
 *   (first selected account wins). Multi-account support would require
 *   passing account_ids to the summary endpoints and aggregating server-side.
 */

import { useState, useEffect, useMemo } from 'react'
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  BarChart, Bar, AreaChart, Area, XAxis, YAxis, CartesianGrid, Legend, ReferenceLine,
} from 'recharts'
import { api } from '../lib/api.js'
import { MerchantCell, CategoryCell } from '../components/TransactionRow.jsx'
import AmountDisplay from '../components/AmountDisplay.jsx'
import { Link } from 'react-router-dom'
import TransactionDetail from '../components/TransactionDetail.jsx'
import RuleSuggestionToast from '../components/RuleSuggestionToast.jsx'
import { useFilters, resolveDateMonths } from '../lib/FilterContext.jsx'
import { currentMonth, formatCurrency, formatDate, monthLabel, lastNMonths } from '../lib/utils.js'
import { Card, PageHeader, Select, Spinner, EmptyState, CategoryMarker } from '../components/ui.jsx'
import { format, subMonths, subYears, startOfYear, endOfYear, startOfMonth, endOfMonth } from 'date-fns'

// ── Period helpers ────────────────────────────────────────────────────────────

function monthsInRange(startYM, endYM) {
  // Returns array of 'YYYY-MM' strings between two 'YYYY-MM' values inclusive
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
  if (p.type === 'month')  return monthLabel(p.month)
  if (p.type === 'year')   return p.year
  if (p.type === 'custom') return `${p.start} → ${p.end}`
  return ''
}

function periodMonths(p) {
  if (p.type === 'month')  return [p.month]
  if (p.type === 'year')   return monthsInRange(`${p.year}-01`, `${p.year}-12`)
  if (p.type === 'custom') return monthsInRange(p.start, p.end)
  return []
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

// ── Fetch totals for a period (sum across all its months) ────────────────────

async function fetchPeriodGroupTotals(period, accountId) {
  const months = periodMonths(period)
  const results = await Promise.all(
    months.map(m => api.getGroupTotals(m, accountId || undefined))
  )
  // Merge by group_id
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

async function fetchPeriodCatTotals(period, groupId, accountId) {
  const months = periodMonths(period)
  const results = await Promise.all(
    months.map(m => api.getCategoryTotalsInGroup(m, groupId, accountId || undefined))
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

// ── Sub-components ────────────────────────────────────────────────────────────

function SpendBar({ value, total, color }) {
  const pct = total > 0 ? Math.min((value / total) * 100, 100) : 0
  return (
    <div style={{ flex: 1, height: 6, background: 'var(--surface2)', borderRadius: 3, overflow: 'hidden' }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 3, transition: 'width 0.3s' }} />
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

function PeriodPicker({ label, value, onChange }) {
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


// Distinct color palette for charts — assigned from the currently displayed rows
const CHART_PALETTE = [
  '#6366f1','#ec4899','#f97316','#eab308','#22c55e',
  '#14b8a6','#3b82f6','#a855f7','#ef4444','#64748b',
  '#fb923c','#84cc16','#06b6d4','#8b5cf6','#f43f5e',
  '#10b981','#f59e0b','#3b82f6','#e11d48','#0891b2',
]

function assignColors(rows, colorKey) {
  return rows.map((r, i) => ({
    ...r,
    [colorKey]: CHART_PALETTE[i % CHART_PALETTE.length],
    _chartColor: CHART_PALETTE[i % CHART_PALETTE.length],
  }))
}

// ── Comparison row ─────────────────────────────────────────────────────────────

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
            background: diff > 0 ? '#ef444422' : '#22c55e22',
            color: diff > 0 ? '#ef4444' : '#22c55e',
          }}>
            {diff > 0 ? '▲' : '▼'} {Math.abs(diffPct).toFixed(0)}%
          </span>
        )}
        {onClick && <span style={{ color: 'var(--muted)', fontSize: 14 }}>›</span>}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {/* Period A bar */}
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


// ── Trends Panel ──────────────────────────────────────────────────────────────

function TrendsPanel({ rows, groups, selectedYear, onYearChange, drillGroup, onDrillGroup, onClearDrill, loading }) {
  if (loading) return <Spinner />

  const normalizedRows = rows.filter(r =>
    typeof r?.month === 'string' &&
    /^\d{4}-\d{2}$/.test(r.month)
  )

  const filteredRows = selectedYear === 'all'
    ? normalizedRows
    : normalizedRows.filter(r => r.month.startsWith(selectedYear))

  // Build a sorted list of all months present
  const allMonths = [...new Set(filteredRows.map(r => r.month))].sort()

  // Build a list of unique series (groups or categories)
  const seriesMap = {}
  for (const r of filteredRows) {
    if (!seriesMap[r.series_id]) {
      seriesMap[r.series_id] = { id: r.series_id, name: r.series_name, color: r.series_color, category_type: r.series_category_type }
    }
  }
  const series = Object.values(seriesMap).filter(s => s.category_type !== 'income')

  // Pivot: [{ month, seriesId: total, ... }]
  const chartData = allMonths.map(m => {
    const entry = { month: monthLabel(m) }
    for (const s of series) {
      const row = filteredRows.find(r => r.month === m && r.series_id === s.id)
      entry[s.id] = row ? row.total : 0
    }
    return entry
  })

  // Averages per series
  const avgBySeries = series.map(s => {
    const totals = allMonths.map(m => {
      const r = filteredRows.find(x => x.month === m && x.series_id === s.id)
      return r ? r.total : 0
    })
    const avg = totals.reduce((a, b) => a + b, 0) / (totals.length || 1)
    const total = totals.reduce((a, b) => a + b, 0)
    return { ...s, avg, total }
  }).sort((a, b) => b.total - a.total)

  // Annual totals: group by year
  const yearMap = {}
  for (const r of filteredRows) {
    const yr = r.month.slice(0, 4)
    yearMap[yr] = (yearMap[yr] || 0) + r.total
  }
  const annualData = Object.entries(yearMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([year, total]) => ({ year, total }))

  // Overall monthly total for the total line
  const monthlyTotal = allMonths.map(m => ({
    month: monthLabel(m),
    total: filteredRows.filter(r => r.month === m).reduce((s, r) => s + r.total, 0),
  }))
  const overallAvg = monthlyTotal.reduce((s, r) => s + r.total, 0) / (monthlyTotal.length || 1)

  const availableYears = [...new Set(normalizedRows.map(r => r.month.slice(0, 4)))].sort().reverse()
  const yearOptions = [
    { value: 'all', label: 'All time' },
    ...availableYears.map(y => ({ value: y, label: y })),
  ]

  const groupOptions = [
    { value: '', label: 'All groups' },
    ...groups.map(g => ({ value: g.group_id, label: g.group_name })),
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Controls */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          value={selectedYear}
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

      {/* Stacked area chart — monthly breakdown by series */}
      <Card>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>
          Monthly spending{drillGroup ? ` · ${drillGroup.series_name}` : ' by group'}
        </div>
        {allMonths.length === 0 ? (
          <EmptyState message="No trend data for this selection" />
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="month" tick={{ fill: 'var(--muted)', fontSize: 10 }}
                interval={Math.floor(allMonths.length / 8)} />
              <YAxis tickFormatter={v => `$${(v/1000).toFixed(0)}k`} tick={{ fill: 'var(--muted)', fontSize: 11 }} />
              <Tooltip formatter={(v, name) => {
                const s = series.find(x => x.id === name)
                return [formatCurrency(v), s ? s.name : name]
              }} contentStyle={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8 }} />
              {series.map(s => (
                <Area key={s.id} type="monotone" dataKey={s.id}
                  stroke={s.color} fill={s.color} fillOpacity={0.15}
                  strokeWidth={1.5} stackId="1" name={s.id} />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        )}
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        {/* Total monthly line with average reference */}
        <Card>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Total per month</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
            Avg: {formatCurrency(overallAvg)}/mo
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={monthlyTotal}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="month" tick={{ fill: 'var(--muted)', fontSize: 10 }}
                interval={Math.floor(monthlyTotal.length / 6)} />
              <YAxis tickFormatter={v => `$${(v/1000).toFixed(0)}k`} tick={{ fill: 'var(--muted)', fontSize: 10 }} />
              <Tooltip formatter={v => formatCurrency(v)}
                contentStyle={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8 }} />
              <Bar dataKey="total" fill="var(--accent)" radius={[3,3,0,0]} name="Total" />
              <ReferenceLine y={overallAvg} stroke="var(--accent2)" strokeDasharray="4 4"
                label={{ value: 'Avg', fill: 'var(--accent2)', fontSize: 10, position: 'right' }} />
            </BarChart>
          </ResponsiveContainer>
        </Card>

        {/* Annual totals */}
        <Card>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>Annual totals</div>
          {annualData.length === 0 ? (
            <EmptyState message="Not enough data" />
          ) : (
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={annualData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="year" tick={{ fill: 'var(--muted)', fontSize: 12 }} />
                <YAxis tickFormatter={v => `$${(v/1000).toFixed(0)}k`} tick={{ fill: 'var(--muted)', fontSize: 11 }} />
                <Tooltip formatter={v => formatCurrency(v)}
                  contentStyle={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8 }} />
                <Bar dataKey="total" fill="var(--accent)" radius={[3,3,0,0]} name="Total" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>
      </div>

      {/* Average per month table */}
      <Card>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>
          Monthly averages{drillGroup ? ` · ${drillGroup.series_name}` : ' by group'}
          <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 8 }}>{selectedYear === 'all' ? 'all time' : selectedYear}</span>
        </div>
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 100px 100px 100px',
          padding: '6px 12px', fontSize: 11, fontWeight: 600,
          color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em',
          borderBottom: '1px solid var(--border)',
        }}>
          <span>{drillGroup ? 'Category' : 'Group'}</span>
          <span style={{ textAlign: 'right' }}>Avg/mo</span>
          <span style={{ textAlign: 'right' }}>Total</span>
          <span style={{ textAlign: 'right' }}>% of spend</span>
        </div>
        {avgBySeries.map(s => {
          const grandTotal = avgBySeries.reduce((sum, x) => sum + x.total, 0)
          const pct = grandTotal > 0 ? (s.total / grandTotal * 100).toFixed(1) : 0
          return (
            <div key={s.id} style={{
              display: 'grid', gridTemplateColumns: '1fr 100px 100px 100px',
              padding: '9px 12px', alignItems: 'center',
              borderBottom: '1px solid var(--border)', fontSize: 14,
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

// ── Owner Split Panel ─────────────────────────────────────────────────────────

function OwnerSplitPanel({ owners, sharedOwnerId, ownerSplitData, onDrill }) {
  const activeOwners = owners.filter(o => ownerSplitData[o.id]?.length > 0)
  if (activeOwners.length === 0) {
    return (
      <Card style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 14, color: 'var(--muted)', textAlign: 'center', padding: '16px 0' }}>
          No owners configured yet. Go to Settings to add owners and tag category groups.
        </div>
      </Card>
    )
  }

  // Collect all group ids across all owners for consistent row display
  const allGroupIds = [...new Set(
    Object.values(ownerSplitData).flatMap(rows => rows.map(r => r.group_id))
  )]

  function isSharedGroup(anyRow) {
    return !!sharedOwnerId && anyRow.group_owner_id === sharedOwnerId
  }

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: `180px repeat(${activeOwners.length}, 1fr)`,
        gap: 12,
        marginBottom: 8,
      }}>
        <div />
        {activeOwners.map(o => {
          const rows = ownerSplitData[o.id] || []
          // For the summary total, only count groups that belong to this owner
          // (not shared ones, to avoid double-counting)
          const personalTotal = rows
            .filter(r => r.group_owner_id === o.id)
            .reduce((s, r) => s + r.total, 0)
          const sharedTotal = rows
            .filter(r => isSharedGroup(r) && r.group_owner_id !== o.id)
            .reduce((s, r) => s + r.total, 0)
          return (
            <Card key={o.id} style={{ padding: '12px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{o.name}</span>
              </div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{formatCurrency(personalTotal + sharedTotal)}</div>
              {sharedTotal > 0 && (
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                  incl. {formatCurrency(sharedTotal)} shared
                </div>
              )}
            </Card>
          )
        })}
      </div>

      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: `180px repeat(${activeOwners.length}, 1fr)`,
          padding: '8px 16px', fontSize: 11, fontWeight: 600,
          color: 'var(--muted)', textTransform: 'uppercase',
          letterSpacing: '0.05em', borderBottom: '1px solid var(--border)',
          gap: 12,
        }}>
          <span>Group</span>
          {activeOwners.map(o => (
            <span key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              {o.name}
            </span>
          ))}
        </div>

        {allGroupIds.map(gid => {
          const anyRow = Object.values(ownerSplitData).flat().find(r => r.group_id === gid)
          if (!anyRow) return null
          const shared = isSharedGroup(anyRow)
          const maxVal = Math.max(
            ...activeOwners.map(o => (ownerSplitData[o.id] || []).find(r => r.group_id === gid)?.total || 0)
          )
          return (
            <div
              key={gid}
              style={{
                display: 'grid',
                gridTemplateColumns: `180px repeat(${activeOwners.length}, 1fr)`,
                padding: '10px 16px', alignItems: 'center',
                borderBottom: '1px solid var(--border)', gap: 12,
                cursor: 'pointer',
                background: shared ? 'color-mix(in srgb, var(--surface2) 40%, transparent)' : 'transparent',
              }}
              onClick={() => onDrill(anyRow)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <CategoryMarker kind="group" />
                <span style={{ fontSize: 13 }}>{anyRow.group_name}</span>
                {shared && (
                  <span style={{ fontSize: 10, color: 'var(--muted)', opacity: 0.7 }}>shared</span>
                )}
              </div>
              {activeOwners.map(o => {
                const row = (ownerSplitData[o.id] || []).find(r => r.group_id === gid)
                const val = row?.total || 0
                return (
                  <div key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ flex: 1, height: 5, background: 'var(--surface2)', borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{
                        width: `${maxVal > 0 ? (val / maxVal) * 100 : 0}%`,
                        height: '100%',
                        background: shared ? anyRow.group_color : 'var(--accent)',
                        borderRadius: 3,
                        opacity: shared ? 0.6 : 1,
                      }} />
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 600, minWidth: 60, textAlign: 'right' }}>
                      {val > 0 ? formatCurrency(val) : <span style={{ color: 'var(--muted)', opacity: 0.4 }}>—</span>}
                    </span>
                  </div>
                )
              })}
            </div>
          )
        })}
      </Card>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function Dashboard() {
  const { filters } = useFilters()
  const [mode, setMode]           = useState('single')   // 'single' | 'compare'

  // Owner split state
  const [splitByOwner, setSplitByOwner] = useState(false)
  const [owners, setOwners]             = useState([])
  const [ownerSplitData, setOwnerSplitData] = useState({}) // { ownerId: groupRows }
  const personalOwners = useMemo(() => owners.filter(owner => !owner.is_shared), [owners])
  const sharedOwnerId = useMemo(() => owners.find(owner => owner.is_shared)?.id || null, [owners])

  // Single mode
  const [groupRows,  setGroupRows]  = useState([])
  const [incomeRows, setIncomeRows] = useState([])
  const [catRows, setCatRows]     = useState([])
  const [txnData, setTxnData]     = useState([])
  const [groupTxnData, setGroupTxnData] = useState([])
  const [detailTxn, setDetailTxn]       = useState(null)
  const [categories, setCategories]     = useState([])
  const [rulePrompt, setRulePrompt]     = useState(null)
  const [trend, setTrend]         = useState([])
  const [level, setLevel]         = useState('groups')
  const [selectedGroup, setSelectedGroup] = useState(null)
  const [selectedCat,   setSelectedCat]   = useState(null)

  // Compare mode
  const [periodA, setPeriodA] = useState(presetToPeriod('this_month'))
  const [periodB, setPeriodB] = useState(presetToPeriod('last_month'))
  const [cmpGroupsA, setCmpGroupsA] = useState([])
  const [cmpGroupsB, setCmpGroupsB] = useState([])
  const [cmpCatsA,   setCmpCatsA]   = useState([])
  const [cmpCatsB,   setCmpCatsB]   = useState([])
  const [cmpGroup,   setCmpGroup]   = useState(null)
  const [cmpLevel,   setCmpLevel]   = useState('groups')

  // Trends mode
  const [trendYear,  setTrendYear]        = useState('all')
  const [trendGroup,  setTrendGroup]      = useState(null)   // drill into a group
  const [trendRows,   setTrendRows]       = useState([])
  const [trendGroups, setTrendGroups]     = useState([])
  const [trendLoading, setTrendLoading]   = useState(false)

  const [loading,      setLoading]      = useState(true)
  const [drillLoading, setDrillLoading] = useState(false)

  // Date params for API calls — use global filter if set, otherwise no date constraint (all time)
  const dateStart = filters.date?.start || null
  const dateEnd   = filters.date?.end   || null

  // Derive account filter from global filter context
  const accountSelections = filters.selections.filter(s => s.type === 'account')
  const accountId = accountSelections.length === 1 ? accountSelections[0].id : undefined

  // Derive owner filter from global filter context.
  // On the Dashboard this filters by CATEGORY owner (whose budget domain),
  // not transaction owner (who spent it). Shared/null-owner groups always show.
  const ownerSelections = filters.selections.filter(s => s.type === 'owner')
  const categoryOwnerIds = ownerSelections.length > 0 ? ownerSelections.map(s => s.id).join(',') : undefined

  // ── Single mode load ────────────────────────────────────────────────────────
  useEffect(() => {
    if (mode !== 'single') return
    setLoading(true)
    setLevel('groups'); setSelectedGroup(null); setSelectedCat(null)
    Promise.all([
      api.getGroupTotals(null, accountId || undefined, dateStart, dateEnd, undefined, categoryOwnerIds),
      api.getMonthlyTrend(12),
    ]).then(([g, tr]) => {
      setGroupRows(g.filter(r => r.category_type !== 'income'))
      setIncomeRows(g.filter(r => r.category_type === 'income'))
      setTrend(tr)
      setLoading(false)
    })
  }, [accountId, categoryOwnerIds, mode, filters, dateStart, dateEnd])

  // ── Load owners (for split toggle) ────────────────────────────────────────
  useEffect(() => {
    api.getOwners().then(setOwners)
  }, [])

  // ── Owner split data load ───────────────────────────────────────────────────
  // Fetches all groups once (no owner filter), then the frontend splits them
  // by group_owner_id. Explicit Shared groups appear in every personal-owner column.
  useEffect(() => {
    if (mode !== 'single' || !splitByOwner || personalOwners.length === 0) return
    api.getGroupTotals(null, accountId || undefined, dateStart, dateEnd)
      .then(allRows => {
        const filtered = allRows.filter(r => r.category_type !== 'income')
        // Build per-owner buckets: each personal owner gets their own groups + shared groups
        const byOwner = {}
        for (const owner of personalOwners) {
          byOwner[owner.id] = filtered.filter(r =>
            r.group_owner_id === owner.id ||
            (sharedOwnerId && r.group_owner_id === sharedOwnerId)
          )
        }
        setOwnerSplitData(byOwner)
      })
  }, [mode, splitByOwner, personalOwners, sharedOwnerId, accountId, dateStart, dateEnd, filters])

  // ── Compare mode load ───────────────────────────────────────────────────────
  useEffect(() => {
    if (mode !== 'compare' || !periodA || !periodB) return
    setLoading(true)
    setCmpLevel('groups'); setCmpGroup(null)
    Promise.all([
      fetchPeriodGroupTotals(periodA, accountId),
      fetchPeriodGroupTotals(periodB, accountId),
    ]).then(([a, b]) => {
      setCmpGroupsA(a)
      setCmpGroupsB(b)
      setLoading(false)
    })
  }, [periodA, periodB, accountId, mode])

  // ── Trends mode load ────────────────────────────────────────────────────────
  useEffect(() => {
    if (mode !== 'trends') return
    setTrendLoading(true)
    api.getMonthlyByGroup(60, accountId || undefined, trendGroup?.series_id || undefined)
      .then(rows => {
        setTrendRows(rows)
        setTrendLoading(false)
      })
  }, [mode, accountId, trendGroup])

  // Also load group list for trends drill selector
  useEffect(() => {
    if (mode !== 'trends') return
    api.getGroupTotals(thisM, accountId || undefined).then(g => {
      setTrendGroups(g.filter(r => r.category_type !== 'income'))
    })
  }, [mode, accountId])

  // ── Single drill ────────────────────────────────────────────────────────────
  async function drillToCategories(group) {
    const groupId  = group.group_id ?? group.payload?.group_id
    const groupRow = groupRows.find(r => r.group_id === groupId) || group
    setDrillLoading(true)
    setSelectedGroup(groupRow)
    const [rows, txnResp] = await Promise.all([
      api.getCategoryTotalsInGroup(null, groupId, accountId || undefined, dateStart, dateEnd),
      api.getTransactions({
        date_start:  filters.date?.start || undefined,
        date_end:    filters.date?.end   || undefined,
        group_ids:   groupId,
        account_id:  accountId || undefined,
        limit: 500,
      }),
    ])
    setCatRows(rows)
    setGroupTxnData(txnResp.transactions)
    setLevel('categories')
    setDrillLoading(false)
  }

  async function drillToTransactions(cat) {
    const categoryId = cat.category_id ?? cat.payload?.category_id
    const catRow     = catRows.find(r => r.category_id === categoryId) || cat
    setDrillLoading(true)
    setSelectedCat(catRow)
    const data = await api.getTransactions({
      date_start:  filters.date?.start || undefined,
      date_end:    filters.date?.end   || undefined,
      category_id: categoryId === 'uncategorized' ? '__uncategorized__' : categoryId,
      account_id:  accountId || undefined,
      limit: 200,
    })
    setTxnData(data.transactions)
    setLevel('transactions')
    setDrillLoading(false)
  }

  function singleNavigate(i) {
    if (i === 0) { setLevel('groups'); setSelectedGroup(null); setSelectedCat(null) }
    if (i === 1) { setLevel('categories'); setSelectedCat(null) }
  }

  // ── Compare drill ───────────────────────────────────────────────────────────
  async function cmpDrillToCategories(group) {
    const groupId  = group.group_id
    const groupRow = cmpGroupsA.find(r => r.group_id === groupId) ||
                     cmpGroupsB.find(r => r.group_id === groupId) || group
    setDrillLoading(true)
    setCmpGroup(groupRow)
    const [a, b] = await Promise.all([
      fetchPeriodCatTotals(periodA, groupId, accountId),
      fetchPeriodCatTotals(periodB, groupId, accountId),
    ])
    setCmpCatsA(a)
    setCmpCatsB(b)
    setCmpLevel('categories')
    setDrillLoading(false)
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  const coloredGroupRows = assignColors(groupRows, 'group_color')
  const coloredCatRows = assignColors(catRows, 'category_color')
  const totalSpend = groupRows.reduce((s, r) => s + r.total, 0)
  const totalIncome = incomeRows.reduce((s, r) => s + r.total, 0)



  // Merge compare groups
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
  if (selectedGroup) singleCrumbs.push(selectedGroup.group_name)
  if (selectedCat)   singleCrumbs.push(selectedCat.category_name)

  const cmpCrumbs = [periodLabel(periodA) + ' vs ' + periodLabel(periodB)]
  if (cmpGroup) cmpCrumbs.push(cmpGroup.group_name)

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div data-browser-context-passthrough="true" style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '32px 32px 0', flexShrink: 0 }}>
      <PageHeader title="Dashboard">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {mode === 'single' && personalOwners.length > 0 && (
            <button
              onClick={() => setSplitByOwner(v => !v)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '7px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 13,
                border: `1px solid ${splitByOwner ? 'var(--accent)' : 'var(--border)'}`,
                background: splitByOwner
                  ? 'color-mix(in srgb, var(--accent) 12%, var(--surface2))'
                  : 'var(--surface2)',
                color: splitByOwner ? 'var(--accent2)' : 'var(--muted)',
                fontWeight: splitByOwner ? 500 : 400,
              }}
            >
              👥 Split by owner
            </button>
          )}
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

      <div data-browser-context-passthrough="true" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 32px 32px' }}>

      {mode === 'compare' && (
        <div style={{ display: 'flex', gap: 20, marginBottom: 24, flexWrap: 'wrap' }}>
          <PeriodPicker label="Period A" value={periodA} onChange={setPeriodA} />
          <div style={{ display: 'flex', alignItems: 'center', paddingTop: 24, color: 'var(--muted)', fontSize: 18 }}>vs</div>
          <PeriodPicker label="Period B" value={periodB} onChange={setPeriodB} />
        </div>
      )}

      {loading ? <Spinner /> : (
        <>
          {/* ── SINGLE MODE ── */}
          {mode === 'single' && (
            <>

              <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
                <Card style={{ padding: '14px 24px' }}>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 2 }}>
                    Total spending · {filters.date ? (filters.date.preset || `${filters.date.start} → ${filters.date.end}`) : monthLabel(thisM)}
                  </div>
                  <div style={{ fontSize: 28, fontWeight: 700 }}>{formatCurrency(totalSpend)}</div>
                </Card>
                {totalIncome > 0 && (
                  <Card style={{ padding: '14px 24px' }}>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 2 }}>
                      Total income · {filters.date ? (filters.date.preset || `${filters.date.start} → ${filters.date.end}`) : monthLabel(thisM)}
                    </div>
                    <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--success, #22c55e)' }}>{formatCurrency(totalIncome)}</div>
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

              {level !== 'groups' && <Breadcrumb items={singleCrumbs} onNavigate={singleNavigate} />}

              {/* ── Owner split view ── */}
              {splitByOwner && level === 'groups' && (
                <OwnerSplitPanel
                  owners={personalOwners}
                  sharedOwnerId={sharedOwnerId}
                  ownerSplitData={ownerSplitData}
                  onDrill={drillToCategories}
                />
              )}

              {drillLoading ? <Spinner /> : (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 24 }}>
                  {level === 'groups' && (
                    <>
                      <Card>
                        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>Spending by group</div>
                        <ResponsiveContainer width="100%" height={220}>
                          <PieChart>
                            <Pie data={coloredGroupRows} dataKey="total" nameKey="group_name"
                              cx="50%" cy="50%" innerRadius={55} outerRadius={95} paddingAngle={2}
                              onClick={d => d && drillToCategories(d)} style={{ cursor: 'pointer' }}>
                              {coloredGroupRows.map((g, i) => <Cell key={i} fill={g.group_color} />)}
                            </Pie>
                            <Tooltip formatter={v => formatCurrency(v)}
                              contentStyle={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8 }}
                              labelStyle={{ color: 'var(--text)' }} />
                          </PieChart>
                        </ResponsiveContainer>
                        <div style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'center', marginTop: 4 }}>Click to drill down</div>
                      </Card>
                      <Card>
                        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>Groups</div>
                        {coloredGroupRows.map(g => (
                          <div key={g.group_id} onClick={() => drillToCategories(g)} style={{
                            display: 'flex', alignItems: 'center', gap: 10,
                            padding: '8px 0', borderBottom: '1px solid var(--border)', cursor: 'pointer',
                          }}>
                            <span style={{ width: 10, height: 10, borderRadius: '50%', background: g.group_color, flexShrink: 0 }} />
                            <span style={{ fontSize: 14, flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
                              <CategoryMarker kind="group" />
                              <span>{g.group_name}</span>
                            </span>
                            <SpendBar value={g.total} total={totalSpend} color={g.group_color} />
                            <span style={{ fontSize: 13, fontWeight: 600, minWidth: 70, textAlign: 'right' }}>{formatCurrency(g.total)}</span>
                            <span style={{ color: 'var(--muted)', fontSize: 16 }}>›</span>
                          </div>
                        ))}
                      </Card>
                    </>
                  )}

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
                            <Tooltip formatter={v => formatCurrency(v)}
                              contentStyle={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8 }}
                              labelStyle={{ color: 'var(--text)' }} />
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
                            <span style={{ fontSize: 14, flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
                              <CategoryMarker kind="category" />
                              <span>{c.category_name}</span>
                            </span>
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
                        <div style={{
                          display: 'grid', gridTemplateColumns: '100px 1fr 160px 120px',
                          padding: '10px 16px', fontSize: 11, fontWeight: 600,
                          color: 'var(--muted)', textTransform: 'uppercase',
                          letterSpacing: '0.05em', borderBottom: '1px solid var(--border)',
                        }}>
                          <span>Date</span><span>Merchant</span><span>Account</span>
                          <span style={{ textAlign: 'right' }}>Amount</span>
                        </div>
                        {txnData.length === 0 ? <EmptyState message="No transactions" /> : txnData.map(txn => (
                          <div key={txn.id} style={{
                            display: 'grid', gridTemplateColumns: '100px 1fr 160px 160px 120px',
                            padding: '10px 16px', alignItems: 'center',
                            borderBottom: '1px solid var(--border)', fontSize: 14,
                          }}>
                            <span style={{ color: 'var(--muted)', fontSize: 13 }}>{formatDate(txn.date)}</span>
                            <MerchantCell
                              txn={txn}
                              onOpenDetail={setDetailTxn}
                              onRename={(id, name) => setTxnData(prev =>
                                prev.map(x => x.id === id ? { ...x, display_name: name } : x)
                              )}
                            />
                            <span style={{ color: 'var(--muted)', fontSize: 13 }}>{txn.account_name}{txn.account_mask ? ` ···${txn.account_mask}` : ''}</span>
                            <CategoryCell
                              txn={txn}
                              categories={categories}
                              onSave={(txnId, catId, catObj) => {
                                const cat = catObj || categories.find(c => c.id === catId)
                                setTxnData(prev => prev.map(x => x.id === txnId ? {
                                  ...x, category_id: catId,
                                  category_name: cat?.name ?? null,
                                  category_color: cat?.color ?? null,
                                  category_overridden: 1,
                                } : x))
                                api.overrideCategory(txnId, catId)
                              }}
                              onRulePrompt={setRulePrompt}
                            />
                            <AmountDisplay amount={txn.amount} isPending={!!txn.is_pending} />
                          </div>
                        ))}
                      </Card>
                    </div>
                  )}
                </div>
              )}

              {level === 'groups' && (
                <Card>
                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>Monthly trend</div>
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={trend.map(r => ({ ...r, month: monthLabel(r.month) }))}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="month" tick={{ fill: 'var(--muted)', fontSize: 11 }} />
                      <YAxis tickFormatter={v => `$${(v/1000).toFixed(0)}k`} tick={{ fill: 'var(--muted)', fontSize: 11 }} />
                      <Tooltip formatter={v => formatCurrency(v)}
                        contentStyle={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8 }}
                        labelStyle={{ color: 'var(--text)' }} />
                      <Bar dataKey="total" fill="var(--accent)" radius={[4,4,0,0]} name="Spending" />
                    </BarChart>
                  </ResponsiveContainer>
                </Card>
              )}

              {level === 'categories' && selectedGroup && groupTxnData.length > 0 && (
                <Card style={{ padding: 0, overflow: 'hidden' }}>
                  <div style={{
                    padding: '12px 16px', fontSize: 14, fontWeight: 600,
                    borderBottom: '1px solid var(--border)',
                  }}>
                    {selectedGroup.group_name} · {groupTxnData.length} transactions
                    <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--muted)', marginLeft: 8 }}>
                      Click a category above to filter
                    </span>
                  </div>
                  <div style={{
                    display: 'grid', gridTemplateColumns: '100px 1fr 140px 150px 110px',
                    padding: '8px 16px', fontSize: 11, fontWeight: 600,
                    color: 'var(--muted)', textTransform: 'uppercase',
                    letterSpacing: '0.05em', borderBottom: '1px solid var(--border)',
                  }}>
                    <span>Date</span><span>Merchant</span><span>Account</span>
                    <span>Category</span><span style={{ textAlign: 'right' }}>Amount</span>
                  </div>
                  <div style={{ maxHeight: 320, overflowY: 'auto' }}>
                    {groupTxnData.map(t => (
                      <div key={t.id} style={{
                        display: 'grid', gridTemplateColumns: '100px 1fr 140px 160px 110px',
                        padding: '9px 16px', alignItems: 'center', fontSize: 13,
                        borderBottom: '1px solid var(--border)',
                      }}>
                        <span style={{ color: 'var(--muted)', fontSize: 12 }}>{formatDate(t.date)}</span>
                        <MerchantCell
                          txn={t}
                          onOpenDetail={setDetailTxn}
                          onRename={(id, name) => setGroupTxnData(prev =>
                            prev.map(x => x.id === id ? { ...x, display_name: name } : x)
                          )}
                        />
                        <span style={{ color: 'var(--muted)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {t.account_name}{t.account_mask ? ` ···${t.account_mask}` : ''}
                        </span>
                        <CategoryCell
                          txn={t}
                          categories={categories}
                          onSave={(txnId, catId, catObj) => {
                            const cat = catObj || categories.find(c => c.id === catId)
                            setGroupTxnData(prev => prev.map(x => x.id === txnId ? {
                              ...x,
                              category_id: catId,
                              category_name: cat?.name ?? null,
                              category_color: cat?.color ?? null,
                              category_overridden: 1,
                            } : x))
                            api.overrideCategory(txnId, catId)
                          }}
                          onRulePrompt={setRulePrompt}
                        />
                        <AmountDisplay amount={t.amount} isPending={!!t.is_pending} />
                      </div>
                    ))}
                  </div>
                </Card>
              )}
            </>
          )}

          {/* ── TRENDS MODE ── */}
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
            />
          )}

          {/* ── COMPARE MODE ── */}
          {mode === 'compare' && (
            <>
              {/* Summary totals */}
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
                      color: cmpTotalA > cmpTotalB ? '#ef4444' : '#22c55e',
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
      {detailTxn && (
        <TransactionDetail
          txn={detailTxn}
          categories={categories}
          onClose={() => setDetailTxn(null)}
        />
      )}
      {rulePrompt && (
        <RuleSuggestionToast
          prompt={rulePrompt}
          onDismiss={() => setRulePrompt(null)}
        />
      )}
    </div>
  )
}
