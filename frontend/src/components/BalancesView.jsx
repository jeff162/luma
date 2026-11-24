// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, LineChart, ReferenceLine, ResponsiveContainer,
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
import {
  accountColor, balanceTypeLabel, bridgeAxis, bridgeRows, buildBridge, describeBalanceChange, describeHistoryFlag, groupByType, isOwedBalanceType, unusualBalanceBarColor,
} from '../lib/balanceTotals.js'
import {
  BALANCE_ARRANGEMENT_PREF_KEY, accountDropAt, arrangedAccountsOfType, balanceTableCopy, moveAccount, moveSection, resolveArrangement,
  sameArrangement, sectionDropAt, setSectionCollapsed, setSectionNote,
} from '../lib/balanceArrangement.js'
import { cssPoint, cssRect } from '../lib/displaySize.js'
import { DRAG_SOURCE_STYLE, startPointerDrag, useDropZone } from '../lib/pointerDrag.js'
import { cornerTabStyle } from '../lib/cornerTab.js'
import { copyShare } from '../lib/transactionShare.js'
import { useFlash } from '../lib/useFlash.js'
import { CopyGlyph } from './CopyTransactionsButton.jsx'
import TransientTextInput from './TransientTextInput.jsx'
import { useAccountDetailPanels } from './accounts/useAccountDetailPanels.jsx'
import { useHistoryFlagRemedies } from './accounts/useHistoryFlagRemedies.jsx'
import Breadcrumb from './Breadcrumb.jsx'
import PanningChartFrame from './PanningChartFrame.jsx'
import PanningChartTooltip from './PanningChartTooltip.jsx'
import SummaryTotalCard from './SummaryTotalCard.jsx'
import TrendPlot from './TrendPlot.jsx'
import TrendSpanSelect from './TrendSpanSelect.jsx'
import TrendsWindowSelect from './TrendsWindowSelect.jsx'
import { Button, Card, EmptyState, IconButton, LinkButton, LoadFailed, Select, Spinner, StaleWhileRefreshing, Tooltip, getFormControlStyle } from './ui.jsx'
import { useViewLoad } from '../lib/useViewLoad.js'

/*
 * The Dashboard's Balances frame: the household's position across the accounts it counts, from the
 * balances they stated (`backend/services/balance_totals.py`), grouped and coloured by account type
 * (`lib/balanceTotals.js`).
 *
 * Single period reads like the Expenses frame: headline cards, a chart beside its key, and the history
 * underneath. The chart is a curve of the total across the period over a bridge from the total at the
 * period's opening to its end, one step per type: the path first, then what moved it. The key is the
 * account table. Trends shows each month's end as bars by type, held above zero and owed below, with the
 * total across them. In both, a type drills into its accounts and an account opens its report, from a chart
 * as from the table. Inside credit cards or loans the history's value axis is turned over, so what is owed grows
 * upward, and a bar on the wrong side of zero for its type takes the table's warning colour.
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

export default function BalancesView({ mode, dateStart, dateEnd, periodLabel, categories, trendWindow, onTrendWindowChange, onHide }) {
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

  const load = useCallback(() => {
    const periodParams = { ...ownerParams, date_start: dateStart, date_end: dateEnd }
    return Promise.all([
      mode === 'single' ? api.getBalanceTotals(periodParams) : Promise.resolve(null),
      api.getBalanceTotalsByMonth(ownerParams),
      mode === 'single' ? api.getBalanceTotalsByDay(periodParams) : Promise.resolve(null),
    ])
  }, [mode, ownerParams, dateStart, dateEnd])
  const { data, loading, busy, error, reload: refresh } = useViewLoad(load, { view: 'Balances' })
  const [period = null, history = null, curve = null] = data || []

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
          {history.any_balance === false ? (
            // Nothing anywhere to total, so neither form has a figure to draw, and the frame can be hidden
            // until a balance arrives (`lib/balancesFrame.js`).
            <EmptyState
              message="None of the accounts have any balance information so this page has nothing to display."
              action={onHide ? <Button onClick={onHide}>Hide Balances Page</Button> : null}
            />
          ) : mode === 'trends' ? (
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
              curve={curve}
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

const CARD_TITLE_STYLE = { fontSize: 14, fontWeight: 600, marginBottom: 14 }

function BalancesPeriod({ result, history, curve, periodLabel, dateStart, dateEnd, openType, onDrill, onOpenAccount, flagActions }) {
  const { totals, accounts } = result
  const hasOpening = !!result.opening_date
  const groups = groupByType(accounts)
  const { arrangement, sections, arrange } = useBalanceArrangement(accounts, history.existing_account_ids)
  const openGroup = drilledGroup(groups, sections, openType)
  // The bridge's steps are the types, or inside one type its accounts.
  const bridgeGroups = openGroup
    ? openGroup.accounts.map(a => ({ key: a.account_id, label: a.name, type: a.type, color: accountColor(a), accounts: [a] }))
    : groups.map(g => ({ key: g.type, label: g.label, type: g.type, color: g.color, accounts: g.accounts }))
  // The totals are named by their date alone; the chart's title says what they are totals of.
  // The curve's title says what is charted, so the bridge's heading names only the period it breaks down.
  const bridgeTitle = hasOpening ? `Change · ${periodLabel}` : `Balance · ${formatDate(result.date)}`
  const curvePoints = curve?.points?.length >= 2 ? curve.points : null
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
        // Each card takes its own height, so a short table beside the bridge and its curve leaves space under
        // the table rather than stretching the bridge's card.
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', alignItems: 'start', gap: 20, marginBottom: 24 }}>
          <Card>
            {/* The curve takes the card's title, and the bridge under it a heading of its own. */}
            {curvePoints ? (
              <>
                <div style={CARD_TITLE_STYLE}>{balanceTitle(openGroup)}</div>
                <BalanceCurve points={curvePoints} openGroup={openGroup} />
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)', marginTop: 12, paddingTop: 12, marginBottom: 10, borderTop: '1px solid var(--border)' }}>
                  {bridgeTitle}
                </div>
              </>
            ) : <div style={CARD_TITLE_STYLE}>{bridgeTitle}</div>}
            <BridgeChart steps={steps} series={bridgeGroups} onSelect={key => selectSeries(openGroup, key, onDrill, onOpenAccount)}
              reversed={!!openGroup && isOwedBalanceType(openGroup.type)} changes={hasOpening} />
          </Card>
          <AccountTable
            sections={openGroup ? [openGroup] : sections}
            drilled={!!openGroup}
            arrangement={arrangement} onArrange={arrange}
            columns={[
              { label: 'Balance', of: a => a.balance?.amount ?? null },
              ...(hasOpening
                ? [{ label: 'Change', change: true, of: a => (a.balance && a.opening != null ? a.balance.amount - a.opening : null) }]
                : []),
            ]}
            onDrill={onDrill}
            onOpenAccount={onOpenAccount}
            flagActions={flagActions}
          />
        </div>
      )}
      <HistoryStrip history={history} openGroup={openGroup} dateStart={dateStart} dateEnd={dateEnd} />
    </>
  )
}

// A bridge laid on its side, so its steps read top to bottom with their names beside them and their figures
// in a column at the right. The two totals are drawn as what each group makes of them, in the groups'
// colours, so the bars between them read as the change in those same parts. A click on a group's bar, or
// its part of a total, does what its row in the table does (`selectSeries`).
//
// Where the steps are `changes` (the period has an opening), a step's figure is an arrow and an amount as in
// the table (`describeBalanceChange`, by its series' type), so a row says the same thing in both; on the
// overview a card paid down is ↓ while its bar, which moves the total up, goes right. Without an opening
// the steps are balances, and they and the totals keep their sign. Inside a type whose balances run below
// zero the value axis is `reversed`, zero at the left.
function BridgeChart({ steps, series, onSelect, reversed = false, changes = false }) {
  const changeOf = row => (changes && row.kind === 'step'
    ? describeBalanceChange(series.find(s => s.key === row.key)?.type, row.value)
    : null)
  const data = bridgeRows(steps).map(row => ({
    ...row,
    figure: changeOf(row)?.text ?? formatSignedMoneyAmount(row.value),
    change: changeOf(row),
    clickable: row.kind === 'step' && !row.key.startsWith('__'),
  }))
  const axis = bridgeAxis(data)
  function handleClick(state) {
    const row = data[clickedDataIndex(state)]
    if (row?.clickable) onSelect(row.key)
  }
  const stepFill = row => (row.kind === 'step' ? (row.color || 'var(--muted)') : 'transparent')
  return (
    <ResponsiveContainer width="100%" height={data.length * 34 + 30}>
      <BarChart data={data} layout="vertical" stackOffset="sign" margin={{ top: 4, right: 8, bottom: 4, left: 8 }}
        {...CLICKABLE_CHART_EVENTS} onClick={handleClick}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
        <XAxis type="number" reversed={reversed} domain={axis?.domain} ticks={axis?.ticks} interval={0} tickFormatter={formatSignedAxisTick} tick={{ fill: 'var(--muted)', fontSize: 11 }} />
        <YAxis yAxisId="names" type="category" dataKey="label" width={NAME_AXIS_WIDTH} interval={0}
          tick={<BridgeNameTick />} />
        <YAxis yAxisId="figures" orientation="right" type="category" dataKey="figure" width={FIGURE_AXIS_WIDTH} interval={0}
          axisLine={false} tickLine={false} tick={{ fill: 'var(--text)', fontSize: 11 }} />
        <ReferenceLine yAxisId="names" x={0} stroke="var(--muted)" />
        {/* Tied to the names axis, as the bars are. Left to itself the tooltip takes the axis with id 0, which
            this chart does not have, and picks rows that do not match the bars. */}
        <ChartTooltip
          axisId="names"
          cursor={{ fill: 'var(--surface2)' }}
          content={({ active, payload }) => {
            const row = active ? payload?.[0]?.payload : null
            if (!row) return null
            return (
              <div style={{ ...CHART_TOOLTIP_CONTENT_STYLE, padding: '8px 10px', fontSize: 12 }}>
                <div style={CHART_TOOLTIP_LABEL_STYLE}>
                  {row.label} · {row.change?.title ?? row.figure}
                </div>
                {row.kind === 'total' ? series.filter(s => row[`part:${s.key}`]).map(s => (
                  <div key={s.key}>{s.label} {formatSignedMoneyAmount(row[`part:${s.key}`])}</div>
                )) : null}
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
            onClick={() => onSelect(s.key)} style={{ cursor: 'pointer' }} />
        ))}
        {['stepHeld', 'stepOwed'].map(key => (
          <Bar key={key} yAxisId="names" dataKey={key} stackId="bridge" isAnimationActive={false} maxBarSize={22}>
            {data.map(row => (
              <Cell key={row.key} fill={stepFill(row)} fillOpacity={0.9}
                style={{ cursor: row.clickable ? 'pointer' : 'default' }} />
            ))}
          </Bar>
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}

// The total across the period over the bridge, so how it went from the opening figure to the closing one
// shows, not only the two ends; inside a type, that type's balance, in its colour and with its axis turned
// over where its balances run below zero, as its history is drawn. The points are a day apart, or a week
// apart over a long period (`balance_totals_by_day`), and the line is smoothed without overshooting
// (`monotone`), since a free spline would draw highs and lows between them that the figures do not have.
const CURVE_HEIGHT = 100

function BalanceCurve({ points: totals, openGroup }) {
  const points = openGroup ? totals.map(p => ({ ...p, net: sumBalances(p, openGroup.accounts) })) : totals
  const first = points[0].date
  const last = points[points.length - 1].date
  return (
    <div data-testid="balance-curve">
      <ResponsiveContainer width="100%" height={CURVE_HEIGHT}>
        {/* Its plot spans what the bridge's does, between the names and the figures beside it. */}
        <LineChart data={points} margin={{ top: 4, right: 8 + FIGURE_AXIS_WIDTH, bottom: 0, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis dataKey="date" ticks={[first, last]} interval={0} tickLine={false} tick={<CurveDateTick first={first} />} />
          <YAxis reversed={!!openGroup && isOwedBalanceType(openGroup.type)} domain={['auto', 'auto']} tickCount={3} width={NAME_AXIS_WIDTH} tickFormatter={formatSignedAxisTick}
            axisLine={false} tickLine={false} tick={{ fill: 'var(--muted)', fontSize: 11 }} />
          <ChartTooltip
            isAnimationActive={false}
            cursor={{ stroke: 'var(--muted)', strokeDasharray: '3 3' }}
            labelFormatter={day => formatDate(day)}
            formatter={value => [formatSignedMoneyAmount(value), balanceTitle(openGroup)]}
            contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
            labelStyle={CHART_TOOLTIP_LABEL_STYLE}
            itemStyle={CHART_TOOLTIP_ITEM_STYLE}
          />
          <Line type="monotone" dataKey="net" stroke={openGroup ? openGroup.color : 'var(--accent)'} strokeWidth={2} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

// The curve's two dates, set inside the chart's ends rather than centred on them, where they would be cut off.
function CurveDateTick({ x, y, payload, first }) {
  return (
    <text x={x} y={y + 12} textAnchor={payload.value === first ? 'start' : 'end'} fill="var(--muted)" fontSize={11}>
      {formatDate(payload.value)}
    </text>
  )
}

// A step's name beside the bridge: on up to two lines, the second cut short with an ellipsis when the name
// is longer still, the full name in its hover text and the chart's tooltip. The axis's own ticks wrap only
// where the name has spaces and clip a longer line at its start, which loses the front of a long account
// name.
const NAME_AXIS_WIDTH = 120
const FIGURE_AXIS_WIDTH = 100
const NAME_FONT_SIZE = 12
const NAME_LINE_HEIGHT = 14
// What the text may fill: the axis less the tick mark and the gap beside it.
const NAME_TEXT_WIDTH = NAME_AXIS_WIDTH - 12

function BridgeNameTick({ x, y, payload }) {
  const name = String(payload?.value ?? '')
  const lines = fitLines(name, NAME_TEXT_WIDTH, 2)
  const top = y - ((lines.length - 1) * NAME_LINE_HEIGHT) / 2
  return (
    <text x={x} y={top} textAnchor="end" dominantBaseline="central" fill="var(--text)" fontSize={NAME_FONT_SIZE}>
      {lines.join(' ') !== name ? <title>{name}</title> : null}
      {lines.map((line, index) => <tspan key={index} x={x} y={top + index * NAME_LINE_HEIGHT}>{line}</tspan>)}
    </text>
  )
}

let measureContext
function textWidth(text) {
  if (measureContext === undefined) {
    measureContext = document.createElement('canvas').getContext?.('2d') ?? null
    if (measureContext) measureContext.font = `${NAME_FONT_SIZE}px ${getComputedStyle(document.body).fontFamily}`
  }
  // Without a canvas (a test DOM), an average character width.
  return measureContext ? measureContext.measureText(text).width : text.length * NAME_FONT_SIZE * 0.55
}

// `text` broken at spaces into at most `maxLines` lines of `width`, the last ending in an ellipsis where the
// rest does not fit, and a word too long for a line cut the same way.
function fitLines(text, width, maxLines) {
  const clip = line => {
    if (textWidth(line) <= width) return line
    let cut = line
    while (cut.length > 1 && textWidth(`${cut}…`) > width) cut = cut.slice(0, -1)
    return `${cut.trimEnd()}…`
  }
  const words = text.split(/\s+/).filter(Boolean)
  const lines = []
  let current = ''
  for (let i = 0; i < words.length; i++) {
    const candidate = current ? `${current} ${words[i]}` : words[i]
    if (!current || textWidth(candidate) <= width) {
      current = candidate
      continue
    }
    if (lines.length === maxLines - 1) return [...lines, clip(`${current} ${words.slice(i).join(' ')}`)]
    lines.push(clip(current))
    current = words[i]
  }
  return current ? [...lines, clip(current)] : lines
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
  // A bar on the wrong side of zero for the open type takes the colour its figure has in the table.
  const barColor = bucket => (openGroup && bucket.plotted != null
    ? unusualBalanceBarColor(openGroup.type, bucket.plotted) : null) || color
  const grainWord = { month: 'month', quarter: 'quarter', year: 'year' }[grain]
  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>
          {balanceTitle(openGroup)} by {grainWord}
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
        name={balanceTitle(openGroup)}
        formatter={value => formatSignedMoneyAmount(value)}
        fillOf={bucket => (bucket.isSelected ? barColor(bucket) : `color-mix(in srgb, ${barColor(bucket)} 45%, var(--surface2))`)}
        reversed={!!openGroup && isOwedBalanceType(openGroup.type)}
        onBucketClick={bucket => pinDateFromChart({ start: bucket.rangeStart, end: bucket.rangeEnd, preset: bucket.periodLabel })}
      />
    </Card>
  )
}

// What a balance chart is of: the total, or inside a type that type's balance. Never "Total" alone, which
// does not say what is totalled.
function balanceTitle(openGroup) {
  return openGroup ? `${openGroup.label} balance` : 'Balance'
}

// A bucket's name on the axis and as the period it becomes when clicked.
function bucketLabel(bucket, grain) {
  if (grain === 'year') return bucket.start.slice(0, 4)
  if (grain === 'quarter') return `Q${Math.floor((Number(bucket.start.slice(5)) - 1) / 3) + 1} ${bucket.start.slice(0, 4)}`
  return monthLabel(bucket.start)
}

// What a chart's series does when clicked, as its row in the table does: on the overview a type opens its
// accounts, and inside a type an account opens its report.
function selectSeries(openGroup, key, onDrill, onOpenAccount) {
  if (!openGroup) {
    onDrill(key)
    return
  }
  const account = openGroup.accounts.find(a => a.account_id === key)
  if (account) onOpenAccount({ id: account.account_id, name: account.name })
}

function sumBalances(point, accounts) {
  return accounts.reduce((sum, a) => sum + (point.balances[a.account_id] ?? 0), 0)
}

// --- The account table: the charts' key ---------------------------------------------------------------

// The table's arrangement (`lib/balanceArrangement.js`) for the accounts shown, and `arrange`, which applies a
// change to it. A change is made to the saved list brought up to date with these accounts, so the first one
// saves the default arrangement with it.
function useBalanceArrangement(accounts, existingIds) {
  const [saved, setSaved] = useUserPreference(BALANCE_ARRANGEMENT_PREF_KEY, null)
  const { arrangement, sections } = resolveArrangement(saved, accounts, existingIds)
  const arrange = useCallback(change => {
    setSaved(prev => change(resolveArrangement(prev, accounts, existingIds).arrangement))
  }, [setSaved, accounts, existingIds])
  return { arrangement, sections, arrange }
}

// The open type's group, its accounts in the arranged order across every section of the type, so the drilled
// table and the charts beside it list them as the overview did.
function drilledGroup(groups, sections, openType) {
  const group = openType ? groups.find(g => g.type === openType) : null
  return group ? { ...group, id: group.type, accounts: arrangedAccountsOfType(sections, openType) } : null
}

const FIGURE_STYLE = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }
// A heading's collapse toggle, or its grip in edit mode, hangs in the card's padding left of the swatch, so the
// headings and the accounts under them keep the alignment the table has without it. An account's grip sits in
// its indent, under the swatch.
const GUTTER_CONTROL_WIDTH = 14
const GUTTER_CONTROL_GAP = 4
const GUTTER = GUTTER_CONTROL_WIDTH + GUTTER_CONTROL_GAP
const ACCOUNT_INDENT = 18
const DRAG_KINDS = { account: 'balance-account', section: 'balance-section' }

/*
 * In the arranged sections, each heading carrying its section's subtotal and opening the whole type, and a
 * toggle beside it that collapses the section to that row. Drilled into a type, its accounts alone, each in
 * its own colour as in that type's charts. `columns` are the figures each row shows, the first of them the
 * account's balance as of something; one marked `change` is drawn as an arrow and an amount.
 *
 * The card's corner tab copies the table and opens edit mode. Edit mode shows every section open, puts a
 * grip on each account and heading and a note field on each heading. A drag goes through
 * `lib/pointerDrag.js`, the whole table one drop zone. Where it would land is worked out from the rows as
 * laid out (`accountDropAt`, `sectionDropAt`) and marked by a line drawn over the table rather than a row
 * inserted into it, so the rows never move under the pointer while it is deciding. The line is indented
 * where the account joins a section and runs full width where it starts one, and then the copy of the row
 * that follows the pointer says which ("→ New Checking section"). A drop that would leave the table as it
 * is is not marked and does nothing.
 */
function AccountTable({ arrangement, sections, drilled, columns, onArrange, onDrill, onOpenAccount, flagActions, style }) {
  const [editing, setEditing] = useState(false)
  const [copied, flashCopied] = useFlash(COPIED_MESSAGE_MS)
  const [dragging, setDragging] = useState(null)
  const [mark, setMark] = useState(null)
  const frameRef = useRef(null)
  const previewLabelRef = useRef(null)
  const arranging = editing && !drilled

  function placement(item, point) {
    const frame = frameRef.current
    if (!frame) return null
    const layout = []
    for (const cell of frame.querySelectorAll('[data-arrange-cell]')) {
      const { top, bottom } = cssRect(cell)
      const { sectionId, sectionType, accountId } = cell.dataset
      if (accountId == null) {
        layout.push({ id: sectionId, type: sectionType, top, headingBottom: bottom, bottom, rows: [] })
      } else if (layout.length) {
        const current = layout[layout.length - 1]
        current.rows.push({ id: accountId, top, bottom })
        current.bottom = bottom
      }
    }
    const y = cssPoint(point).y
    const found = item.kind === DRAG_KINDS.section ? sectionDropAt(layout, y) : accountDropAt(layout, y, item.type)
    if (!found || sameArrangement(moved(arrangement, item, found.drop), arrangement)) return null
    return {
      ...found,
      top: found.line - cssRect(frame).top,
      label: found.newSection && item.kind === DRAG_KINDS.account ? `New ${balanceTypeLabel(item.type)} section` : null,
    }
  }

  const dropRef = useDropZone({
    accepts: item => item?.kind === DRAG_KINDS.account || item?.kind === DRAG_KINDS.section,
    onOver: (item, point) => showMark(placement(item, point)),
    onLeave: () => showMark(null),
    onDrop: (item, point) => {
      const found = placement(item, point)
      showMark(null)
      if (found) onArrange(current => moved(current, item, found.drop))
    },
  })
  const attachFrame = useCallback(element => {
    frameRef.current = element
    dropRef(element)
  }, [dropRef])

  // The copy that follows the pointer belongs to `pointerDrag`, outside React, so its label is set directly.
  function showMark(found) {
    setMark(found)
    const label = previewLabelRef.current
    if (!label) return
    label.textContent = found?.label ? `→ ${found.label}` : ''
    label.style.display = found?.label ? '' : 'none'
  }

  // What follows the pointer is a copy of the row's name cell, so it reads as the account or the section
  // rather than as the grip.
  function startDrag(event, item) {
    startPointerDrag(event, {
      onStart: () => {
        setDragging(item)
        return item
      },
      onEnd: () => {
        setDragging(null)
        setMark(null)
        previewLabelRef.current = null
      },
      preview: source => {
        const cell = source.closest('[data-arrange-cell]')
        if (!cell) return {}
        const clone = cell.cloneNode(true)
        const computed = window.getComputedStyle(cell)
        Object.assign(clone.style, {
          font: computed.font, color: computed.color,
          width: 'max-content', padding: '4px 8px', opacity: '0.92', borderRadius: '8px',
          boxShadow: '0 8px 24px rgba(0,0,0,0.22)', background: 'var(--surface)', border: '1px solid var(--border)',
        })
        const label = document.createElement('span')
        Object.assign(label.style, { display: 'none', marginLeft: '4px', fontSize: '11px', fontWeight: '600', color: 'var(--muted)' })
        clone.appendChild(label)
        previewLabelRef.current = label
        return { element: clone, offsetX: 12, offsetY: cell.offsetHeight / 2 }
      },
    })
  }

  async function copy() {
    flashCopied(await copyShare(balanceTableCopy(sections, columns)) ? 'Copied' : 'Could not copy')
  }

  const template = `minmax(0, 1fr) ${columns.map(() => 'auto').join(' ')}`
  return (
    <Card style={{ position: 'relative', ...style }}>
      <TableCornerTab copied={copied} onCopy={copy} arranging={arranging} canArrange={!drilled}
        onArrange={() => setEditing(!arranging)} />
      <div ref={attachFrame} style={{ position: 'relative', paddingBottom: arranging ? 32 : 0 }}>
        <div role="table" aria-label="Balances by account"
          style={{ display: 'grid', gridTemplateColumns: template, columnGap: 20, rowGap: 6, alignItems: 'baseline', fontSize: 13 }}>
          <div role="row" style={{ display: 'contents', fontSize: 12, color: 'var(--muted)' }}>
            <div role="columnheader">{drilled ? 'Account' : 'Account type'}</div>
            {columns.map((col, index) => <div key={index} role="columnheader" style={{ textAlign: 'right' }}>{col.label}</div>)}
          </div>
          {sections.map(section => (
            <SectionRows key={section.id} section={section} drilled={drilled} arranging={arranging} dragging={dragging}
              columns={columns} onArrange={onArrange} onStartDrag={startDrag}
              onDrill={onDrill} onOpenAccount={onOpenAccount} flagActions={flagActions} />
          ))}
        </div>
        {mark ? (
          <div aria-hidden="true" style={{
            position: 'absolute', left: mark.indented ? ACCOUNT_INDENT : -GUTTER, right: 0, top: mark.top - 1, height: 2,
            background: 'var(--accent)', borderRadius: 1, pointerEvents: 'none',
          }} />
        ) : null}
      </div>
    </Card>
  )
}

const COPIED_MESSAGE_MS = 1400
const CORNER_BUTTON_STYLE = {
  padding: 0, border: 'none', background: 'none', color: 'inherit', font: 'inherit', cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center',
}

// The table's two quiet actions in one tab set into the card's top-right corner (`cornerTabStyle`), as a
// table's column gear is elsewhere: copy, then the gear that opens edit mode, or Done while it is open.
// Arranging applies only to the overview, so a drilled table offers copy alone.
function TableCornerTab({ copied, onCopy, arranging, canArrange, onArrange }) {
  return (
    <div style={{
      ...cornerTabStyle({ corner: 'top-right', radius: 12 }), display: 'inline-flex', alignItems: 'center', gap: 10,
      minHeight: 20, padding: '2px 10px', boxSizing: 'border-box', fontSize: 11, fontWeight: 500,
      background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--muted)', zIndex: 1,
    }}>
      <button type="button" onClick={onCopy} aria-label="Copy the table" title="Copy the accounts and their balances"
        style={CORNER_BUTTON_STYLE}>
        {copied || <CopyGlyph size={13} />}
      </button>
      {canArrange ? (
        <button type="button" onClick={onArrange} aria-label={arranging ? 'Done arranging' : 'Arrange the table'}
          aria-pressed={arranging} title={arranging ? undefined : 'Arrange the table'} style={CORNER_BUTTON_STYLE}>
          {arranging ? 'Done' : <span aria-hidden="true" style={{ fontSize: 13, lineHeight: 1 }}>⚙︎</span>}
        </button>
      ) : null}
    </div>
  )
}

function moved(arrangement, item, drop) {
  return item.kind === DRAG_KINDS.section ? moveSection(arrangement, item.id, drop) : moveAccount(arrangement, item.id, drop)
}

function columnTotal(accounts, col) {
  const values = accounts.map(col.of).filter(v => v != null)
  return values.length ? values.reduce((s, v) => s + v, 0) : null
}

function SectionRows({ section, drilled, arranging, dragging, columns, onArrange, onStartDrag, onDrill, onOpenAccount, flagActions }) {
  const heading = section.note ? `${section.label} · ${section.note}` : section.label
  const collapsed = !drilled && !arranging && section.collapsed
  const sectionDimmed = dragging?.kind === DRAG_KINDS.section && dragging.id === section.id
  const dim = dimmed => (dimmed ? { opacity: 0.4 } : null)
  return (
    <>
      {drilled ? null : (
        <div role="row" style={{ display: 'contents', fontWeight: 600 }}>
          <div role="cell" data-arrange-cell="" data-section-id={section.id} data-section-type={section.type}
            style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 6, ...dim(sectionDimmed) }}>
            {arranging ? (
              <Grip label={`Move ${heading}`} hanging
                onPointerDown={event => onStartDrag(event, { kind: DRAG_KINDS.section, id: section.id })} />
            ) : (
              <button type="button" onClick={() => onArrange(a => setSectionCollapsed(a, section.id, !collapsed))}
                aria-expanded={!collapsed} aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${heading}`}
                title={collapsed ? 'Expand' : 'Collapse'}
                style={{
                  ...gutterControlStyle(true), padding: 0, border: 'none', background: 'none', color: 'var(--muted)',
                  fontSize: 10, lineHeight: 1, cursor: 'pointer',
                }}>
                {collapsed ? '▸' : '▾'}
              </button>
            )}
            <Swatch color={section.color} />
            <LinkButton onClick={() => onDrill(section.type)} title={`See the ${section.label} accounts`} style={{ fontWeight: 600 }}>
              {section.label}
            </LinkButton>
            {arranging ? (
              <SectionNoteField key={section.note} section={section} onArrange={onArrange} />
            ) : section.note ? (
              <span style={{ fontWeight: 400, color: 'var(--muted)', marginLeft: -4 }}>· {section.note}</span>
            ) : null}
          </div>
          {columns.map((col, index) => {
            const value = columnTotal(section.accounts, col)
            return (
              <div key={index} role="cell" style={{ ...FIGURE_STYLE, paddingTop: 6, ...dim(sectionDimmed) }}>
                <ColumnFigure col={col} type={section.type} value={value} />
              </div>
            )
          })}
        </div>
      )}
      {collapsed ? null : section.accounts.map(account => {
        const dimmed = sectionDimmed || (dragging?.kind === DRAG_KINDS.account && dragging.id === account.account_id)
        return (
          <div role="row" key={account.account_id} style={{ display: 'contents' }}>
            <div role="cell" data-arrange-cell="" data-section-id={section.id} data-account-id={account.account_id}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, minWidth: 0,
                paddingLeft: drilled || arranging ? 0 : ACCOUNT_INDENT, ...dim(dimmed),
              }}>
              {drilled ? <Swatch color={accountColor(account)} /> : null}
              {arranging ? (
                <Grip label={`Move ${account.name}`}
                  onPointerDown={event => onStartDrag(event, { kind: DRAG_KINDS.account, id: account.account_id, type: account.type })} />
              ) : null}
              <LinkButton onClick={() => onOpenAccount({ id: account.account_id, name: account.name })}
                style={{ overflowWrap: 'anywhere', textAlign: 'left' }}>
                {account.name}
              </LinkButton>
              <AccountWarning account={account} flagActions={flagActions} />
            </div>
            {columns.map((col, index) => (
              <div key={index} role="cell" style={{ ...FIGURE_STYLE, ...dim(dimmed) }}>
                {index === 0
                  ? <AccountFigure account={account} value={col.of(account)} />
                  : <ColumnFigure col={col} type={account.type} value={col.of(account)} />}
              </div>
            ))}
          </div>
        )
      })}
    </>
  )
}

// A control in a row's leading gutter, inside a flex cell whose gap is 8: on a heading it hangs left of the
// swatch, on an account it fills the indent.
function gutterControlStyle(hanging) {
  return {
    width: GUTTER_CONTROL_WIDTH, flexShrink: 0,
    marginLeft: hanging ? -GUTTER : 0, marginRight: GUTTER_CONTROL_GAP - 8,
  }
}

function Grip({ label, hanging = false, onPointerDown }) {
  return (
    <button type="button" aria-label={label} title="Drag to move" onPointerDown={onPointerDown}
      onClick={event => event.preventDefault()}
      style={{
        ...DRAG_SOURCE_STYLE, ...gutterControlStyle(hanging), padding: 0, border: 'none', background: 'none',
        color: 'var(--muted)', fontSize: 11, lineHeight: 1, letterSpacing: -3, textAlign: 'left', overflow: 'hidden',
        cursor: 'grab', fontWeight: 400,
      }}>
      ⋮⋮
    </button>
  )
}

// Keyed by the saved note, so a note saved elsewhere (another device) replaces the draft.
function SectionNoteField({ section, onArrange }) {
  const [draft, setDraft] = useState(section.note)
  function commit() {
    if (draft.trim() !== section.note) onArrange(a => setSectionNote(a, section.id, draft))
  }
  return (
    <TransientTextInput value={draft} onChange={setDraft} onCommit={commit} restoreOnEscape autoFocus={false}
      placeholder="Note" aria-label={`Note for ${section.label}`}
      style={{ ...getFormControlStyle({ size: 'compact' }), width: 160, minWidth: 0, fontWeight: 400 }} />
  )
}

// A figure after the first column: a change as an arrow and an amount (`describeBalanceChange`), anything
// else signed.
function ColumnFigure({ col, type, value }) {
  if (value == null) return null
  if (!col.change) return formatSignedMoneyAmount(value)
  const { text, title } = describeBalanceChange(type, value)
  if (!title) return text
  return <Tooltip content={title} align="right"><span>{text}</span></Tooltip>
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
      // Set further off than the cell's gap, so a tap aimed at the ⚠ does not open the account.
      triggerStyle={{ marginLeft: 4 }}
      content={(
        <div style={{ display: 'grid', gap: 6 }}>
          {stale ? <div>No balance stated since {formatDate(account.balance.as_of_date)}.</div> : null}
          {flag ? <div>{describeHistoryFlag(flag)}</div> : null}
          {flag ? <div>{flagActions(account)}</div> : null}
        </div>
      )}
    >
      {/* A button of its own, so a finger has a target and a keyboard can reach the hint. */}
      <IconButton size="compact" aria-label="Balance warning" title="" style={{ color: BALANCE_WARNING_COLOR }}>⚠</IconButton>
    </Tooltip>
  )
}

// --- Trends -------------------------------------------------------------------------------------------

function BalancesTrends({ history, openType, onDrill, trendWindow, onTrendWindowChange, onOpenAccount, flagActions }) {
  const thisMonth = currentMonth()
  const { points, accounts } = history
  const range = trendsWindowRange(resolveTrendsWindowKey(points, trendWindow, thisMonth), thisMonth, rowsMonthSpan(points))
  const shown = points.filter(p => p.month >= range.startMonth && p.month <= range.endMonth)
  const counted = accounts.filter(a => a.has_balance)
  const groups = groupByType(counted)
  const { arrangement, sections, arrange } = useBalanceArrangement(counted, history.existing_account_ids)
  const openGroup = drilledGroup(groups, sections, openType)
  // A series per type, or inside one type per account.
  const series = openGroup
    ? openGroup.accounts.map(a => ({ key: a.account_id, label: a.name, type: a.type, color: accountColor(a), accounts: [a] }))
    : groups.map(g => ({ key: g.type, label: g.label, type: g.type, color: g.color, accounts: g.accounts }))
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
  const totalLabel = balanceTitle(openGroup)
  // Inside credit cards or loans the axis is turned over so what is owed grows upward (`isOwedBalanceType`).
  const reversed = !!openGroup && isOwedBalanceType(openGroup.type)
  const chart = (
    <ResponsiveContainer width="100%" height={pans ? '100%' : CHART_HEIGHT}>
      {/* `stackOffset="sign"` keeps what is held stacking up from zero and what is owed stacking down from
          it; without it a negative series would be drawn from the top of the positive ones. */}
      <ComposedChart data={data} stackOffset="sign" margin={{ top: 8, right: 12, bottom: 6, left: pans ? 24 : 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis dataKey="month" tickFormatter={monthLabel} tick={{ fill: 'var(--muted)', fontSize: 10 }}
          interval={pans ? 2 : data.length <= 12 ? 0 : Math.floor(data.length / 12)} />
        <YAxis reversed={reversed} orientation={pans ? 'right' : 'left'} tickFormatter={formatSignedAxisTick} tick={{ fill: 'var(--muted)', fontSize: 11 }} />
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
        {/* A month on the wrong side of zero for its type takes the colour its figure has in the table. */}
        {series.map(s => (
          <Bar key={s.key} dataKey={s.key} name={s.label} stackId="balances" fill={s.color} fillOpacity={0.85}
            isAnimationActive={false} onClick={() => selectSeries(openGroup, s.key, onDrill, onOpenAccount)}
            style={{ cursor: 'pointer' }}>
            {data.map(row => (
              <Cell key={row.month} fill={unusualBalanceBarColor(s.type, row[s.key]) || s.color} />
            ))}
          </Bar>
        ))}
        <Line type="linear" dataKey="total" name={totalLabel} stroke="var(--text)" strokeWidth={2}
          dot={data.length === 1} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  )
  const typeOptions = [{ value: '', label: 'All account types' }, ...groups.map(g => ({ value: g.type, label: g.label }))]
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
        <AccountTable
          style={{ maxWidth: 760 }}
          sections={openGroup ? [openGroup] : sections}
          drilled={!!openGroup}
          arrangement={arrangement} onArrange={arrange}
          onDrill={onDrill}
          onOpenAccount={onOpenAccount}
          flagActions={flagActions}
          columns={[
            { label: formatDate(firstPoint.date), of: a => firstPoint.balances[a.account_id] ?? null },
            { label: formatDate(lastPoint.date), of: a => lastPoint.balances[a.account_id] ?? null },
            {
              label: 'Change',
              change: true,
              // An account whose history starts inside the window starts it at zero, as on Single period.
              of: a => (lastPoint.balances[a.account_id] != null
                ? lastPoint.balances[a.account_id] - (firstPoint.balances[a.account_id] ?? 0)
                : null),
            },
          ]}
        />
      ) : null}
    </>
  )
}
