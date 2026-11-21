// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, Tooltip, XAxis, YAxis } from 'recharts'
import { CLICKABLE_CHART_EVENTS, clickedDataIndex } from '../lib/chartInteraction.js'
import {
  CHART_TOOLTIP_CONTENT_STYLE, CHART_TOOLTIP_ITEM_STYLE, CHART_TOOLTIP_LABEL_STYLE, formatSignedAxisTick,
} from '../lib/moneyDisplay.js'
import {
  bucketAnchorMonth, bucketIndexAtScroll, centeredScrollLeft, trendPlotLayout, trendScrollTargetIndex,
} from '../lib/trendPlotLayout.js'
import AxisAvgPill from './AxisAvgPill.jsx'
import ClippedBar from './ClippedBar.jsx'
import PanningChartTooltip from './PanningChartTooltip.jsx'

/*
 * The bar chart under a Dashboard Single-period report: one bar per bucket of history, the selected
 * period's buckets highlighted, a click on a bucket making it the period. The Expenses, Income and Cash
 * flow frames and the Net worth frame all draw it, so a fix to its axis, panning or scroll position
 * reaches each of them.
 *
 * It is drawn as *two* charts side by side so the value axis can stay put while the plot pans: a fixed
 * column carrying only the axis, and the scrolling plot with its own axis hidden. The two share one
 * vertical geometry — height, top and bottom margins, and the space the category axis reserves — because
 * that is what makes their scales identical and their gridlines line up. Change any of these and both
 * charts must change together, or the axis quietly starts describing a scale the bars are not drawn to.
 *
 * `data` are the buckets: `label` (the axis), `fullLabel` (the tooltip), `bucketStart`/`bucketEnd` months,
 * `rangeStart`/`rangeEnd` days, `isSelected`, and the drawn figure under `plotted` (with `__clipped` /
 * `__clippedValue` where an outlier is drawn torn off, see ClippedBar). `average` draws a reference line
 * with its pill in the axis column. `fillOf(bucket)` colours a bar; `formatter` and `name` are the
 * tooltip's.
 */

const CHART_HEIGHT = 224
const CHART_MARGIN_Y = 6
const XAXIS_HEIGHT = 48
// The sticky column, and the axis inside it. The column is the wider of the two by enough to hold the
// average pill, which is drawn over the tick labels rather than in the plot so that it stays visible at
// any pan position; the remaining few pixels are the gap the plot would otherwise butt straight up
// against.
const AXIS_COLUMN_WIDTH = 76
const AXIS_LABEL_WIDTH = 60

export default function TrendPlot({ data, domain, clamped = false, average = null, name, formatter, fillOf, onBucketClick }) {
  // The plot is handed an explicit width rather than discovering one after it has drawn, so the only
  // measurement left is the viewport it may have to stretch to fill. Observing it here — once, on the
  // scroll container itself — is what keeps a re-bucket free of any measure-then-redraw: this width does
  // not change when the grain does. A callback ref rather than an effect, because the container can mount
  // and unmount with what the page shows and a ref assignment does not re-run effects.
  const scrollRef = useRef(null)
  const viewportObserver = useRef(null)
  // The month under the middle of the viewport, kept up to date as the plot is panned. Read only when the
  // bucket set is rebuilt, so it is deliberately the value from *before* that happened.
  const anchorMonth = useRef(null)
  const [viewportWidth, setViewportWidth] = useState(0)
  const attachScroll = useCallback(node => {
    viewportObserver.current?.disconnect()
    viewportObserver.current = null
    scrollRef.current = node
    if (!node) return
    setViewportWidth(node.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    // clientWidth, not the observed content rect: a horizontal scrollbar costs height, not width, so this
    // cannot feed back into the width that decides whether the scrollbar is there.
    const observer = new ResizeObserver(() => setViewportWidth(node.clientWidth))
    observer.observe(node)
    viewportObserver.current = observer
  }, [])

  // The plot pans by native horizontal scroll, and the bucket set is replaced under it in two quite
  // different ways — which is what decides where the plot should then be scrolled to.
  //
  // **A bar click picks a period**, and the picked period is what to show. The same goes for any bucket
  // set with a selection in it — after a grain change too, since the highlighted run is what the reader is
  // following. A selection spanning several buckets is centred on the middle one.
  //
  // **With nothing selected, changing the grain re-cuts the same data.** The reader is still looking at
  // whatever they were looking at — and scrolling to the newest bucket, which is the only sensible
  // index-based answer, throws them to the far end of the chart every time. The month under the middle of
  // the viewport is carried across instead, so month, quarter and year views of the same period stay on
  // that period.
  //
  // `useLayoutEffect` so it lands before paint instead of as a visible jump, and keyed on the bucket set
  // rather than on every render so it never fights the user's own scrolling. The offset is computed from
  // the same layout the plot is drawn at, not from the bar width: those are the same number only while the
  // buckets are what sets the width, and a stretched plot spreads its bars over the extra room.
  //
  // "The bucket set" is which periods are drawn and which are selected, not the array holding them: the
  // figures reload on every ledger change, and a reload that brings back the same buckets must leave the
  // pan alone. So the effect is keyed on `bucketsKey` and reads the buckets through a ref.
  const selectedIndex = useMemo(() => {
    const selected = data.flatMap((b, i) => (b.isSelected ? [i] : []))
    return selected.length ? selected[Math.floor((selected.length - 1) / 2)] : -1
  }, [data])
  const plot = useMemo(() => trendPlotLayout(data.length, viewportWidth), [data.length, viewportWidth])
  const rememberAnchor = useCallback(() => {
    const el = scrollRef.current
    if (!el || data.length === 0) return
    const index = bucketIndexAtScroll({
      scrollLeft: el.scrollLeft, viewportWidth: el.clientWidth, layout: plot, bucketCount: data.length,
    })
    if (index >= 0) anchorMonth.current = bucketAnchorMonth(data[index])
  }, [data, plot])
  const bucketsKey = data.map(b => `${b.rangeStart}:${b.rangeEnd}:${b.isSelected ? 1 : 0}`).join(',')
  const latestData = useRef(data)
  useLayoutEffect(() => { latestData.current = data }, [data])
  useLayoutEffect(() => {
    const el = scrollRef.current
    const buckets = latestData.current
    if (!el || buckets.length === 0) return
    const index = trendScrollTargetIndex({ buckets, selectedIndex, anchorMonth: anchorMonth.current })
    el.scrollLeft = centeredScrollLeft({ index, layout: plot, viewportWidth: el.clientWidth })
  }, [bucketsKey, selectedIndex, plot])

  const showAverage = data.length > 1 && average != null
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start' }}>
      {/* The value axis, held out of the scroll so it stays readable at any pan position. It is a chart
          rather than hand-drawn labels so that recharts works out the ticks — the same ticks, from the
          same data and domain, that the plot beside it is scaled to. */}
      <div style={{ width: AXIS_COLUMN_WIDTH, height: CHART_HEIGHT, flexShrink: 0 }}>
        {/* Sized, not measured — see the plot below. This box was never responsive at all: it is a
            constant beside a constant. */}
        <BarChart
          width={AXIS_COLUMN_WIDTH}
          height={CHART_HEIGHT}
          data={data}
          margin={{ top: CHART_MARGIN_Y, right: 0, bottom: CHART_MARGIN_Y, left: 0 }}
        >
          <YAxis
            width={AXIS_LABEL_WIDTH}
            tickFormatter={formatSignedAxisTick}
            tick={{ fill: 'var(--muted)', fontSize: 11 }}
            domain={domain}
            allowDataOverflow={clamped}
          />
          {/* Draws nothing; it reserves exactly the height the plot's category axis reserves, which is
              what keeps the two vertical scales in step. */}
          <XAxis dataKey="label" height={XAXIS_HEIGHT} tick={false} axisLine={false} />
          {/* Invisible rather than hidden: `hide` drops the series from the domain altogether and the axis
              comes out blank. */}
          <Bar dataKey="plotted" fillOpacity={0} isAnimationActive={false} />
          {/* The average's pill lives here rather than on its line in the plot, where it would pan out of
              view and stay out on a long timeline. It reads the same scale the ticks were drawn from, and
              steps aside from any tick label it would otherwise sit on. */}
          {showAverage ? <AxisAvgPill value={average} columnWidth={AXIS_COLUMN_WIDTH} /> : null}
        </BarChart>
      </div>
      <div
        ref={attachScroll}
        onScroll={rememberAnchor}
        style={{ flex: 1, minWidth: 0, overflowX: 'auto', overflowY: 'hidden' }}
      >
        {/* Given its width rather than left to discover one. `<ResponsiveContainer>` measures its own box
          with a ResizeObserver and holds the result in state, so a re-bucket draws once at the *previous*
          bucket set's width and is corrected only after paint — a stale-width frame whose look depends on
          which way the grain went and where the plot was scrolled. The width is not responsive anyway: it
          is the bucket count, and the viewport only when the buckets do not fill it. */}
        <div style={{ width: plot.width, height: CHART_HEIGHT }}>
          <BarChart
            width={plot.width}
            height={CHART_HEIGHT}
            data={data}
            margin={{ top: CHART_MARGIN_Y, right: 12, bottom: CHART_MARGIN_Y, left: 0 }}
            // On the chart, not the bar: the target is the whole hovered column, so a short bar is as easy
            // to pick as a tall one.
            {...CLICKABLE_CHART_EVENTS}
            onClick={state => {
              const bucket = data[clickedDataIndex(state)]
              if (bucket) onBucketClick?.(bucket)
            }}
            style={{ cursor: 'pointer' }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="label" interval={0} tick={<TrendBucketTick />} height={XAXIS_HEIGHT} />
            {/* Hidden, not absent: the scale still has to be computed here, and it is identical to the
              column's because the domain and data are. */}
            <YAxis hide domain={domain} allowDataOverflow={clamped} />
            <Tooltip
              // The plot pans, so the card is placed against what is visible rather than against the whole
              // canvas — see PanningChartTooltip.
              content={<PanningChartTooltip />}
              isAnimationActive={false}
              formatter={formatter}
              // The axis label is cut to fit a bar; the card names the exact range.
              labelFormatter={(label, payload) => payload?.[0]?.payload?.fullLabel ?? label}
              contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
              labelStyle={CHART_TOOLTIP_LABEL_STYLE}
              itemStyle={CHART_TOOLTIP_ITEM_STYLE}
            />
            {/* Static, like the axis column beside it. Re-bucketing replaces the whole series, so the
              default grow-in plays in full on every grain change — and with the axis in its own chart it
              would be an animation running against a scale that had already snapped. */}
            <Bar dataKey="plotted" radius={[4, 4, 0, 0]} shape={<ClippedBar />} name={name} isAnimationActive={false}>
              {data.map((entry, idx) => <Cell key={idx} fill={fillOf(entry)} />)}
            </Bar>
            {/* Unlabelled: the pill naming this line is in the sticky axis column, which is the only part
              of the chart that does not pan away. */}
            {showAverage ? <ReferenceLine y={average} stroke="var(--accent2)" strokeDasharray="4 4" /> : null}
          </BarChart>
        </div>
      </div>
    </div>
  )
}

// A bucket's axis label, on two lines when it names a range ("Mar 3 – Apr 2").
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
