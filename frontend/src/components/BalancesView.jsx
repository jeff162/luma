// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, ReferenceLine, ResponsiveContainer,
  Tooltip as ChartTooltip, XAxis, YAxis,
} from 'recharts'
import { api } from '../lib/api.js'
import { useFilters, describeDateFilter } from '../lib/FilterContext.jsx'
import { useOwnerLens } from '../lib/OwnerLensContext.jsx'
import { amountFilterParams, selectionsToParams } from '../lib/filterParams.js'
import { useAfterLedgerChange } from '../contexts/SyncStatusContext.jsx'
import { unusualBalanceColor } from '../lib/accountTypes.js'
import { CLICKABLE_CHART_EVENTS, clickedDataIndex } from '../lib/chartInteraction.js'
import {
  BALANCE_WARNING_COLOR,
  CHART_TOOLTIP_CONTENT_STYLE,
  CHART_TOOLTIP_ITEM_STYLE,
  CHART_TOOLTIP_LABEL_STYLE,
  formatMoneyMagnitude,
  formatSignedAxisTick,
  formatSignedMoneyAmount,
} from '../lib/moneyDisplay.js'
import {
  TREND_GRAINS, calendarTrendBuckets, defaultTrendGrain, resolveTrendsWindowKey, rowsMonthSpan,
  trendGrainOptions, trendsWindowOptions, trendsWindowRange,
} from '../lib/trendBuckets.js'
import { TREND_SPAN_ALL, TREND_SPAN_PREF_KEY, trendSpanFloorMonth } from '../lib/trendSpan.js'
import { useUserPreference } from '../lib/UserPreferencesContext.jsx'
import { formatDate, monthLabel } from '../lib/utils.js'
import { accountColor, bridgeRows, buildBridge, describeHistoryFlag, groupByType } from '../lib/balanceTotals.js'
import { useAccountDetailPanels } from './accounts/useAccountDetailPanels.jsx'
import { useHistoryFlagRemedies } from './accounts/useHistoryFlagRemedies.jsx'
import Breadcrumb from './Breadcrumb.jsx'
import PanningChartFrame from './PanningChartFrame.jsx'
import PanningChartTooltip from './PanningChartTooltip.jsx'
import SummaryTotalCard from './SummaryTotalCard.jsx'
import TrendPlot from './TrendPlot.jsx'
import TrendSpanSelect from './TrendSpanSelect.jsx'
import TrendsWindowSelect from './TrendsWindowSelect.jsx'
import { Button, Card, EmptyState, LinkButton, LoadFailed, Select, Spinner, StaleWhileRefreshing, Tooltip, getFormControlStyle } from './ui.jsx'
import { useViewLoad } from '../lib/useViewLoad.js'

/*
 * The Dashboard's Balances frame: the household's position across the accounts it counts, from the
 * balances they stated (`backend/services/balance_totals.py`), grouped and coloured by account type
 * (`lib/balanceTotals.js`).
 *
 * Single period reads like the Expenses frame: headline cards, a chart beside its key, and the history
 * underneath. The chart is a bridge from the total at the period's opening to its end, one step per type;
 * the key is the account table. Trends shows each month's end as bars by type, held above zero and owed
 * below, with the total across them. A type drills into its accounts in both, and an account opens its
 * report.
 *
 * Only the owner filters apply. The Dashboard's other filters select transactions, and a balance belongs to
 * an account, so a note says so whenever one of them is set rather than leaving the figure to look
 * filtered.
 */

const OWNER_PARAM_KEYS = ['owner_ids', 'exclude_owner_ids', 'owner_lens']
// Bars keep a readable width past this many months by panning, as the cash-flow months do.
// The Trends chart's bars keep a readable width past this many months by panning, as the cash-flow months
// do.
const MONTHS_FIT = 36
const MONTH_BAR_WIDTH = 24
const CHART_HEIGHT = 260

function currentMonth() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

export default function BalancesView({ mode, dateStart, dateEnd, periodLabel, categories, trendWindow, onTrendWindowChange }) {
  const { filters } = useFilters()
  const { params: ownerLensParams } = useOwnerLens()
  const ownerParams = useMemo(() => {
    const all = { ...selectionsToParams(filters.selections), ...ownerLensParams }
    return Object.fromEntries(OWNER_PARAM_KEYS.filter(key => all[key]).map(key => [key, all[key]]))
  }, [filters.selections, ownerLensParams])
  const otherFiltersSet = filters.selections.some(s => s.type !== 'owner')
    || Object.keys(amountFilterParams(filters.amount)).length > 0

  const { openAccountDetail, panelsNode } = useAccountDetailPanels({ accounts: null, categories })
  // The open type, shared by both modes as the Expenses frame's group drill is.
  const [drillType, setDrillType] = useState(null)

  const load = useCallback(() => Promise.all([
    mode === 'single'
      ? api.getBalanceTotals({ ...ownerParams, date_start: dateStart, date_end: dateEnd })
      : Promise.resolve(null),
    api.getBalanceTotalsByMonth(ownerParams),
  ]), [mode, ownerParams, dateStart, dateEnd])
  const { data, loading, busy, error, reload: refresh } = useViewLoad(load, { view: 'Balances' })
  const [period = null, history = null] = data || []

  // A sync, an edit or a dismissed flag moves what is shown, so the figures are re-read in place.
  useAfterLedgerChange(refresh)
  useEffect(() => {
    window.addEventListener('luma:transactions-changed', refresh)
    return () => window.removeEventListener('luma:transactions-changed', refresh)
  }, [refresh])

  // The flag's remedies open dialogs from links inside a tooltip, so the dialogs are rendered here.
  const { actionsFor, dialogs: remedyDialogs } = useHistoryFlagRemedies(refresh)
  const flagActions = useCallback(
    account => actionsFor({ id: account.account_id, type: account.type, balanceTotalsFrom: account.balance_totals_from }, account.history_flag),
    [actionsFor],
  )

  // A drill into a type the filters have since emptied falls back to the overview.
  const accounts = mode === 'single' ? period?.accounts : history?.accounts
  const openType = drillType && accounts?.some(a => a.type === drillType) ? drillType : null
  const ready = mode === 'single' ? period && history : history
  return (
    <>
      {otherFiltersSet ? (
        <div data-testid="balances-filter-note" style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
          Balances are filtered by owner only. The other filters do not apply.
        </div>
      ) : null}
      {!ready ? (error ? <LoadFailed what="balances" onRetry={refresh} /> : busy ? <Spinner /> : null) : (
        <StaleWhileRefreshing refreshing={loading}>
          {error ? <LoadFailed what="balances" onRetry={refresh} inline /> : null}
          {mode === 'trends' ? (
            <BalancesTrends
              history={history}
              openType={openType}
              onDrill={setDrillType}
              trendWindow={trendWindow}
              onTrendWindowChange={onTrendWindowChange}
              onOpenAccount={openAccountDetail}
              flagActions={flagActions}
            />
          ) : (
            <BalancesPeriod
              result={period}
              history={history}
              periodLabel={periodLabel}
              dateStart={dateStart}
              dateEnd={dateEnd}
              openType={openType}
              onDrill={setDrillType}
              onOpenAccount={openAccountDetail}
              flagActions={flagActions}
            />
          )}
        </StaleWhileRefreshing>
      )}
      {panelsNode}
      {remedyDialogs}
    </>
  )
}

// --- Single period ------------------------------------------------------------------------------------

function BalancesPeriod({ result, history, periodLabel, dateStart, dateEnd, openType, onDrill, onOpenAccount, flagActions }) {
  const { totals, accounts } = result
  const hasOpening = !!result.opening_date
  const groups = groupByType(accounts)
  const openGroup = openType ? groups.find(g => g.type === openType) : null
  // The bridge's steps are the types, or inside one type its accounts.
  const bridgeGroups = openGroup
    ? openGroup.accounts.map(a => ({ key: a.account_id, label: a.name, color: accountColor(a), accounts: [a] }))
    : groups.map(g => ({ key: g.type, label: g.label, color: g.color, accounts: g.accounts }))
  // The totals are named by their date alone; the chart's title says what they are totals of.
  const steps = buildBridge(bridgeGroups, {
    hasOpening,
    openingLabel: hasOpening ? formatDate(result.opening_date) : null,
    closingLabel: formatDate(result.date),
  })
  return (
    <>
      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <SummaryTotalCard label={`Total · ${formatDate(result.date)}`} value={totals.net}
          color={totals.net < 0 ? 'var(--danger)' : undefined} />
        <SummaryTotalCard label="Assets" value={totals.assets} format={formatMoneyMagnitude} />
        <SummaryTotalCard label="Liabilities" value={totals.liabilities} format={formatMoneyMagnitude} />
        {result.change == null ? null : (
          <SummaryTotalCard label={`Change · ${periodLabel}`} value={result.change}
            color={result.change < 0 ? 'var(--danger)' : 'var(--success)'} />
        )}
      </div>
      {openGroup ? <Breadcrumb items={['Overview', openGroup.label]} onNavigate={() => onDrill(null)} /> : null}
      {accounts.length === 0 ? (
        <EmptyState message="No accounts count toward the balance totals." />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 20, marginBottom: 24 }}>
          <Card>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>
              {hasOpening ? 'Change' : (openGroup ? openGroup.label : 'Total')} by {openGroup ? 'account' : 'category'}
            </div>
            <BridgeChart steps={steps} series={bridgeGroups} onDrill={openGroup ? null : onDrill} />
          </Card>
          <Card>
            <AccountTable
              groups={openGroup ? [openGroup] : groups}
              drilled={!!openGroup}
              columns={[
                { label: 'Balance', of: a => a.balance?.amount ?? null },
                ...(hasOpening
                  ? [{ label: 'Change', of: a => (a.balance && a.opening != null ? a.balance.amount - a.opening : null) }]
                  : []),
              ]}
              onDrill={onDrill}
              onOpenAccount={onOpenAccount}
              flagActions={flagActions}
            />
          </Card>
        </div>
      )}
      <HistoryStrip history={history} openGroup={openGroup} dateStart={dateStart} dateEnd={dateEnd} />
    </>
  )
}

// A bridge laid on its side, so its steps read top to bottom with their names beside them and their figures
// in a column at the right. The two totals are drawn as what each group makes of them, in the groups'
// colours, so the bars between them read as the change in those same parts.
function BridgeChart({ steps, series, onDrill }) {
  const data = bridgeRows(steps).map(row => ({
    ...row,
    figure: formatSignedMoneyAmount(row.value),
    drillable: !!onDrill && row.kind === 'step' && !row.key.startsWith('__'),
  }))
  function handleClick(state) {
    const row = data[clickedDataIndex(state)]
    if (row?.drillable) onDrill(row.key)
  }
  const stepFill = row => (row.kind === 'step' ? (row.color || 'var(--muted)') : 'transparent')
  return (
    <ResponsiveContainer width="100%" height={data.length * 34 + 30}>
      <BarChart data={data} layout="vertical" stackOffset="sign" margin={{ top: 4, right: 8, bottom: 4, left: 8 }}
        {...CLICKABLE_CHART_EVENTS} onClick={handleClick}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
        <XAxis type="number" tickFormatter={formatSignedAxisTick} tick={{ fill: 'var(--muted)', fontSize: 11 }} />
        <YAxis yAxisId="names" type="category" dataKey="label" width={120} interval={0}
          tick={{ fill: 'var(--text)', fontSize: 12 }} />
        <YAxis yAxisId="figures" orientation="right" type="category" dataKey="figure" width={84} interval={0}
          axisLine={false} tickLine={false} tick={{ fill: 'var(--text)', fontSize: 11 }} />
        <ReferenceLine yAxisId="names" x={0} stroke="var(--muted)" />
        <ChartTooltip
          cursor={{ fill: 'var(--surface2)' }}
          content={({ active, payload }) => {
            const row = active ? payload?.[0]?.payload : null
            if (!row) return null
            return (
              <div style={{ ...CHART_TOOLTIP_CONTENT_STYLE, padding: '8px 10px', fontSize: 12 }}>
                <div style={CHART_TOOLTIP_LABEL_STYLE}>{row.label} · {formatSignedMoneyAmount(row.value)}</div>
                {row.kind === 'total' ? series.filter(s => row[`part:${s.key}`]).map(s => (
                  <div key={s.key}>{s.label} {formatSignedMoneyAmount(row[`part:${s.key}`])}</div>
                )) : null}
                {row.drillable ? <div style={{ color: 'var(--muted)', marginTop: 4 }}>Click to see its accounts</div> : null}
              </div>
            )
          }}
        />
        {/* The order is the stack's, outward from zero: a step's spacer before the step. */}
        <Bar yAxisId="names" dataKey="spacerHeld" stackId="bridge" fill="transparent" isAnimationActive={false} />
        <Bar yAxisId="names" dataKey="spacerOwed" stackId="bridge" fill="transparent" isAnimationActive={false} />
        {series.map(s => (
          <Bar key={s.key} yAxisId="names" dataKey={`part:${s.key}`} name={s.label} stackId="bridge" fill={s.color}
            fillOpacity={0.85} isAnimationActive={false} maxBarSize={22}
            onClick={onDrill ? () => onDrill(s.key) : undefined}
            style={{ cursor: onDrill ? 'pointer' : 'default' }} />
        ))}
        {['stepHeld', 'stepOwed'].map(key => (
          <Bar key={key} yAxisId="names" dataKey={key} stackId="bridge" isAnimationActive={false} maxBarSize={22}>
            {data.map(row => (
              <Cell key={row.key} fill={stepFill(row)} fillOpacity={0.9}
                style={{ cursor: row.drillable ? 'pointer' : 'default' }} />
            ))}
          </Bar>
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}

// The history under the period's figures, drawn by the plot the Expenses trend uses (`TrendPlot`), with
// the same two controls: how far back it reaches (the Dashboard's one span setting, counted back from the
// period's end) and the bucket size. A balance is a figure on a date rather than a sum, so a quarter or a
// year is its balance at its last month's end, or today for the current one. The buckets the period covers
// are highlighted, and a click makes that bucket the period.
function HistoryStrip({ history, openGroup, dateStart, dateEnd }) {
  const { pinDateFromChart, canGoBackDate, goBackDate, previousDate } = useFilters()
  const [spanPref, setSpanPref] = useUserPreference(TREND_SPAN_PREF_KEY, TREND_SPAN_ALL)
  const [grainChoice, setGrainChoice] = useState(null)
  const points = history.points
  if (!points.length) return null
  const period = dateStart && dateEnd ? { start: dateStart, end: dateEnd } : null
  const grain = TREND_GRAINS.includes(grainChoice) ? grainChoice : defaultTrendGrain(period)
  const lastPointMonth = points[points.length - 1].month
  const endMonth = dateEnd && dateEnd.slice(0, 7) < lastPointMonth ? dateEnd.slice(0, 7) : lastPointMonth
  const floor = trendSpanFloorMonth(spanPref, endMonth, grain)
  const firstMonth = floor && floor > points[0].month ? floor : points[0].month
  const valueOf = point => (openGroup ? sumBalances(point, openGroup.accounts) : point.net)
  const data = calendarTrendBuckets({ firstMonth, lastMonth: endMonth, grain, date: period, fallbackMonth: endMonth })
    .map(bucket => {
      // The bucket's last figure: its last month's end, or the latest it has.
      const inside = points.filter(p => p.month >= bucket.start && p.month <= bucket.end)
      const point = inside[inside.length - 1]
      const label = bucketLabel(bucket, grain)
      return {
        ...bucket,
        bucketStart: bucket.start,
        bucketEnd: bucket.end,
        label,
        fullLabel: point ? formatDate(point.date) : label,
        plotted: point ? valueOf(point) : null,
        periodLabel: label,
      }
    })
  const color = openGroup ? openGroup.color : 'var(--accent)'
  const grainWord = { month: 'month', quarter: 'quarter', year: 'year' }[grain]
  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>
          {openGroup ? openGroup.label : 'Total'} by {grainWord}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {canGoBackDate ? (
            <Button variant="secondary" onClick={goBackDate} title={`Return to ${describeDateFilter(previousDate)}`}>
              ← Back to {describeDateFilter(previousDate)}
            </Button>
          ) : null}
          <TrendSpanSelect value={spanPref} onChange={setSpanPref} />
          <select
            value={grain}
            onChange={event => setGrainChoice(event.target.value)}
            aria-label="Trend bucket size"
            style={{ ...getFormControlStyle({ size: 'sm', clickable: true }), borderRadius: 8 }}
          >
            {trendGrainOptions(null).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
      </div>
      <TrendPlot
        data={data}
        name={openGroup ? openGroup.label : 'Total'}
        formatter={value => formatSignedMoneyAmount(value)}
        fillOf={bucket => (bucket.isSelected ? color : `color-mix(in srgb, ${color} 45%, var(--surface2))`)}
        onBucketClick={bucket => pinDateFromChart({ start: bucket.rangeStart, end: bucket.rangeEnd, preset: bucket.periodLabel })}
      />
    </Card>
  )
}

// A bucket's name on the axis and as the period it becomes when clicked.
function bucketLabel(bucket, grain) {
  if (grain === 'year') return bucket.start.slice(0, 4)
  if (grain === 'quarter') return `Q${Math.floor((Number(bucket.start.slice(5)) - 1) / 3) + 1} ${bucket.start.slice(0, 4)}`
  return monthLabel(bucket.start)
}

function sumBalances(point, accounts) {
  return accounts.reduce((sum, a) => sum + (point.balances[a.account_id] ?? 0), 0)
}

// --- The account table: the charts' key ---------------------------------------------------------------

// Grouped by type, each type's row carrying its subtotal and opening its accounts. Inside a type every
// account takes its own colour, as it does in that type's charts. `columns` are the figures each row
// shows, the first of them the account's balance as of something.
function AccountTable({ groups, drilled, columns, onDrill, onOpenAccount, flagActions }) {
  const template = `minmax(0, 1fr) ${columns.map(() => 'auto').join(' ')}`
  return (
    <div role="table" aria-label="Balances by account"
      style={{ display: 'grid', gridTemplateColumns: template, columnGap: 20, rowGap: 6, alignItems: 'baseline', fontSize: 13 }}>
      <div role="row" style={{ display: 'contents', fontSize: 12, color: 'var(--muted)' }}>
        <div role="columnheader">{drilled ? 'Account' : 'Type'}</div>
        {columns.map((col, index) => <div key={index} role="columnheader" style={{ textAlign: 'right' }}>{col.label}</div>)}
      </div>
      {groups.map(group => (
        <GroupRows key={group.type} group={group} drilled={drilled} columns={columns}
          onDrill={onDrill} onOpenAccount={onOpenAccount} flagActions={flagActions} />
      ))}
    </div>
  )
}

const FIGURE_STYLE = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }

function columnTotal(accounts, col) {
  const values = accounts.map(col.of).filter(v => v != null)
  return values.length ? values.reduce((s, v) => s + v, 0) : null
}

function GroupRows({ group, drilled, columns, onDrill, onOpenAccount, flagActions }) {
  return (
    <>
      {drilled ? null : (
        <div role="row" style={{ display: 'contents', fontWeight: 600 }}>
          <div role="cell" style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 6 }}>
            <Swatch color={group.color} />
            <LinkButton onClick={() => onDrill(group.type)} title={`See the ${group.label} accounts`} style={{ fontWeight: 600 }}>
              {group.label}
            </LinkButton>
          </div>
          {columns.map((col, index) => {
            const value = columnTotal(group.accounts, col)
            return <div key={index} role="cell" style={{ ...FIGURE_STYLE, paddingTop: 6 }}>{value == null ? '' : formatSignedMoneyAmount(value)}</div>
          })}
        </div>
      )}
      {group.accounts.map(account => (
        <div role="row" key={account.account_id} style={{ display: 'contents' }}>
          <div role="cell" style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, paddingLeft: drilled ? 0 : 18 }}>
            {drilled ? <Swatch color={accountColor(account)} /> : null}
            <LinkButton onClick={() => onOpenAccount({ id: account.account_id, name: account.name })}
              style={{ overflowWrap: 'anywhere', textAlign: 'left' }}>
              {account.name}
            </LinkButton>
            <AccountWarning account={account} flagActions={flagActions} />
          </div>
          {columns.map((col, index) => (
            <div key={index} role="cell" style={FIGURE_STYLE}>
              {index === 0
                ? <AccountFigure account={account} value={col.of(account)} />
                : (col.of(account) == null ? '' : formatSignedMoneyAmount(col.of(account)))}
            </div>
          ))}
        </div>
      ))}
    </>
  )
}

function Swatch({ color }) {
  return <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 2, background: color, flexShrink: 0 }} />
}

function AccountFigure({ account, value }) {
  if (!account.has_balance) return <span style={{ color: 'var(--muted)' }}>No balance</span>
  if (value == null) {
    return (
      <Tooltip content="Its history starts after this date." align="right">
        <span style={{ color: 'var(--muted)' }}>—</span>
      </Tooltip>
    )
  }
  return (
    <span style={{ color: unusualBalanceColor(account.type, value) || undefined }}>
      {formatSignedMoneyAmount(value)}
    </span>
  )
}

// One ⚠ for whatever is wrong with an account's figures: a balance not restated recently, or a history its
// transactions do not explain, which can be dismissed from here.
function AccountWarning({ account, flagActions }) {
  const flag = account.history_flag
  const stale = account.balance?.stale
  if (!flag && !stale) return null
  return (
    <Tooltip
      interactive={!!flag}
      maxWidth={320}
      content={(
        <div style={{ display: 'grid', gap: 6 }}>
          {stale ? <div>No balance stated since {formatDate(account.balance.as_of_date)}.</div> : null}
          {flag ? <div>{describeHistoryFlag(flag)}</div> : null}
          {flag ? <div>{flagActions(account)}</div> : null}
        </div>
      )}
    >
      <span role="img" aria-label="Warning" style={{ color: BALANCE_WARNING_COLOR }}>⚠</span>
    </Tooltip>
  )
}

// --- Trends -------------------------------------------------------------------------------------------

function BalancesTrends({ history, openType, onDrill, trendWindow, onTrendWindowChange, onOpenAccount, flagActions }) {
  const thisMonth = currentMonth()
  const { points, accounts } = history
  const range = trendsWindowRange(resolveTrendsWindowKey(points, trendWindow, thisMonth), thisMonth, rowsMonthSpan(points))
  const shown = points.filter(p => p.month >= range.startMonth && p.month <= range.endMonth)
  const groups = groupByType(accounts.filter(a => a.has_balance))
  const openGroup = openType ? groups.find(g => g.type === openType) : null
  // A series per type, or inside one type per account.
  const series = openGroup
    ? openGroup.accounts.map(a => ({ key: a.account_id, label: a.name, color: accountColor(a), accounts: [a] }))
    : groups.map(g => ({ key: g.type, label: g.label, color: g.color, accounts: g.accounts }))
  const data = shown.map(point => ({
    month: point.month,
    date: point.date,
    uncovered: point.uncovered,
    total: openGroup ? sumBalances(point, openGroup.accounts) : point.net,
    ...Object.fromEntries(series.map(s => [s.key, sumBalances(point, s.accounts)])),
  }))
  const firstPoint = shown[0]
  const lastPoint = shown[shown.length - 1]
  const noBalance = accounts.filter(a => !a.has_balance).length
  const pans = data.length > MONTHS_FIT
  const totalLabel = openGroup ? openGroup.label : 'Total'
  const chart = (
    <ResponsiveContainer width="100%" height={pans ? '100%' : CHART_HEIGHT}>
      {/* `stackOffset="sign"` keeps what is held stacking up from zero and what is owed stacking down from
          it; without it a negative series would be drawn from the top of the positive ones. */}
      <ComposedChart data={data} stackOffset="sign" margin={{ top: 8, right: 12, bottom: 6, left: pans ? 24 : 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis dataKey="month" tickFormatter={monthLabel} tick={{ fill: 'var(--muted)', fontSize: 10 }}
          interval={pans ? 2 : data.length <= 12 ? 0 : Math.floor(data.length / 12)} />
        <YAxis orientation={pans ? 'right' : 'left'} tickFormatter={formatSignedAxisTick} tick={{ fill: 'var(--muted)', fontSize: 11 }} />
        <ReferenceLine y={0} stroke="var(--muted)" />
        <ChartTooltip
          content={<PanningChartTooltip />}
          isAnimationActive={false}
          cursor={{ fill: 'var(--surface2)' }}
          labelFormatter={(month, payload) => {
            const point = payload?.[0]?.payload
            const note = point?.uncovered ? ` · ${point.uncovered} not yet covered` : ''
            return `${point ? formatDate(point.date) : month}${note}`
          }}
          formatter={value => formatSignedMoneyAmount(value)}
          // In the table's order, the total last, rather than by name.
          itemSorter={item => (item.dataKey === 'total' ? series.length : series.findIndex(s => s.key === item.dataKey))}
          contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
          labelStyle={CHART_TOOLTIP_LABEL_STYLE}
          itemStyle={CHART_TOOLTIP_ITEM_STYLE}
        />
        {series.map(s => (
          <Bar key={s.key} dataKey={s.key} name={s.label} stackId="balances" fill={s.color} fillOpacity={0.85}
            isAnimationActive={false} />
        ))}
        <Line type="linear" dataKey="total" name={totalLabel} stroke="var(--text)" strokeWidth={2}
          dot={data.length === 1} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  )
  const typeOptions = [{ value: '', label: 'All sources' }, ...groups.map(g => ({ value: g.type, label: g.label }))]
  return (
    <>
      {openGroup ? <Breadcrumb items={['Overview', openGroup.label]} onNavigate={() => onDrill(null)} /> : null}
      <Card style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{totalLabel} by month</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Select value={openType || ''} onChange={value => onDrill(value || null)} options={typeOptions}
              aria-label="Account type shown" style={{ width: 'auto' }} />
            <TrendsWindowSelect value={range.key} compact
              options={trendsWindowOptions(points.map(p => p.month.slice(0, 4)))}
              onChange={onTrendWindowChange} />
          </div>
        </div>
        {data.length === 0 ? (
          <EmptyState message={points.length ? 'No balances in these months.' : 'No account has a balance yet.'} />
        ) : pans ? (
          <PanningChartFrame minWidth={data.length * MONTH_BAR_WIDTH} height={CHART_HEIGHT} pinKey={`${data.length}:${data[0].month}`}>
            {chart}
          </PanningChartFrame>
        ) : chart}
        {noBalance && !openGroup ? (
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
            {noBalance === 1 ? '1 account has' : `${noBalance} accounts have`} no balance and
            {noBalance === 1 ? ' is' : ' are'} not counted.
          </div>
        ) : null}
      </Card>
      {firstPoint ? (
        <Card style={{ maxWidth: 760 }}>
          <AccountTable
            groups={openGroup ? [openGroup] : groups}
            drilled={!!openGroup}
            onDrill={onDrill}
            onOpenAccount={onOpenAccount}
            flagActions={flagActions}
            columns={[
              { label: formatDate(firstPoint.date), of: a => firstPoint.balances[a.account_id] ?? null },
              { label: formatDate(lastPoint.date), of: a => lastPoint.balances[a.account_id] ?? null },
              {
                label: 'Change',
                // An account whose history starts inside the window starts it at zero, as on Single period.
                of: a => (lastPoint.balances[a.account_id] != null
                  ? lastPoint.balances[a.account_id] - (firstPoint.balances[a.account_id] ?? 0)
                  : null),
              },
            ]}
          />
        </Card>
      ) : null}
    </>
  )
}
