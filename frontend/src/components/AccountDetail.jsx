/**
 * AccountDetail — Account spending history panel
 *
 * Opens as a bottom sheet (same drag-to-float behaviour as TransactionDetail).
 * Shows a monthly bar chart of all spending on the account, then a transaction
 * list for whichever month is selected.
 *
 * Props:
 *   account  — { id, name, mask }  (derived from the txn row)
 *   onClose  — () => void
 */

import { useState, useEffect, useRef } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
         ResponsiveContainer, Cell, LabelList } from 'recharts'
import { api } from '../lib/api.js'
import { formatCurrency, formatDate, monthLabel } from '../lib/utils.js'
import { Spinner, Badge } from './ui.jsx'
import { MerchantCell } from './TransactionRow.jsx'
import { useFilters } from '../lib/FilterContext.jsx'

// ── Year-boundary X tick ──────────────────────────────────────────────────────

function YearTick({ x, y, width, payload, data }) {
  if (!payload?.value) return null
  const idx  = data.findIndex(d => d.month === payload.value)
  const next = data[idx + 1]
  const year = payload.value.slice(0, 4)
  const isLastOfYear = !next || next.month.slice(0, 4) !== year
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const monthName = MONTHS[parseInt(payload.value.slice(5), 10) - 1] ?? ''
  return (
    <g>
      {isLastOfYear && (
        <text x={x + (width / 2) - 2} y={-10} textAnchor="end"
          fill="var(--muted)" fontSize={10} fontWeight={600}>{year}</text>
      )}
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

// ── Main component ────────────────────────────────────────────────────────────

export default function AccountDetail({ account, onClose }) {
  const { filters } = useFilters()
  const dateStart = filters.date?.start || null
  const dateEnd   = filters.date?.end   || null

  const [pos, setPos]               = useState(null)
  const [dragging, setDragging]     = useState(false)
  const dragOffset                  = useRef({ x: 0, y: 0 })
  const hasDragged                  = useRef(false)
  const panelRef                    = useRef(null)

  const [trend, setTrend]           = useState([])
  const [windowEnd, setWindowEnd]   = useState(null)
  const [selectedMonth, setSelectedMonth] = useState(null)
  const [monthTxns, setMonthTxns]   = useState([])
  const [trendLoading, setTrendLoading] = useState(true)
  const [txnLoading, setTxnLoading] = useState(false)

  const displayName = `${account.name}${account.mask ? ` ···${account.mask}` : ''}`

  // ── Drag ─────────────────────────────────────────────────────────────────

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
    if (!dragging) return
    function onMove(e) {
      if (!hasDragged.current) {
        if (!pos && panelRef.current) {
          const rect = panelRef.current.getBoundingClientRect()
          setPos({ x: rect.left, y: rect.top })
          dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }
        }
        hasDragged.current = true
      }
      const x = Math.max(0, Math.min(window.innerWidth  - 200, e.clientX - dragOffset.current.x))
      const y = Math.max(0, Math.min(window.innerHeight - 60,  e.clientY - dragOffset.current.y))
      setPos(prev => prev ? { x, y } : prev)
    }
    function onUp() { setDragging(false) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [dragging, pos])

  // ── Close on outside click ────────────────────────────────────────────────

  useEffect(() => {
    function h(e) {
      if (panelRef.current && !panelRef.current.contains(e.target)) onClose()
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [onClose])

  // ── Load trend ────────────────────────────────────────────────────────────
  // Uses getMonthlyByGroup with account_id to get per-month totals for this account.
  // We want a flat month→total series regardless of group, so we sum across groups
  // client-side. If getMonthlyByGroup doesn't support account_id filtering that
  // way, fall back to getTransactions grouped by month manually.

  useEffect(() => {
    setTrendLoading(true)
    // getTransactions with account_ids, pull up to 2 years of data and aggregate
    api.getTransactions({
      account_ids: String(account.id),
      limit: 2000,
      ...(dateStart ? { date_start: dateStart } : {}),
      ...(dateEnd   ? { date_end:   dateEnd   } : {}),
    }).then(d => {
      // Aggregate by month client-side
      const byMonth = {}
      for (const t of d.transactions) {
        const m = t.date.slice(0, 7)
        if (!byMonth[m]) byMonth[m] = { month: m, total: 0, count: 0 }
        byMonth[m].total += t.amount
        byMonth[m].count += 1
      }
      const rows = Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month))
      setTrend(rows)
      setWindowEnd(null)
      setTrendLoading(false)
      if (rows.length > 0) setSelectedMonth(rows[rows.length - 1].month)
    })
  }, [account.id, dateStart, dateEnd])

  // ── Load transactions for selected month ──────────────────────────────────

  useEffect(() => {
    if (!selectedMonth) return
    setTxnLoading(true)
    api.getTransactions({
      account_ids: String(account.id),
      month:       selectedMonth,
      limit:       200,
    }).then(d => {
      setMonthTxns(d.transactions)
      setTxnLoading(false)
    })
  }, [selectedMonth, account.id])

  // ── Chart window ──────────────────────────────────────────────────────────

  const WINDOW = 18
  const endIdx   = windowEnd ? trend.findIndex(d => d.month === windowEnd) : trend.length - 1
  const safeEnd  = endIdx === -1 ? trend.length - 1 : endIdx
  const startIdx = Math.max(0, safeEnd - WINDOW + 1)
  const visible  = trend.slice(startIdx, safeEnd + 1)
  const canPrev  = startIdx > 0
  const canNext  = safeEnd < trend.length - 1
  const needsNav = trend.length > WINDOW

  function shiftWindow(dir) {
    const newEnd = Math.max(WINDOW - 1, Math.min(trend.length - 1, safeEnd + dir * WINDOW))
    setWindowEnd(trend[newEnd].month)
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 400,
      background: pos ? 'transparent' : 'rgba(0,0,0,0.5)',
      display: pos ? 'block' : 'flex',
      alignItems: 'flex-end', justifyContent: 'center',
      pointerEvents: pos ? 'none' : 'auto',
    }}>
      <div ref={panelRef} style={{
        position: pos ? 'fixed' : 'relative',
        left: pos ? pos.x : undefined,
        top:  pos ? pos.y : undefined,
        background: 'var(--surface)',
        borderRadius: pos ? 12 : '12px 12px 0 0',
        width: pos ? 820 : '100%',
        maxWidth: pos ? 820 : 960,
        maxHeight: '85vh',
        display: 'flex', flexDirection: 'column',
        boxShadow: pos ? '0 8px 40px rgba(0,0,0,0.5)' : '0 -8px 32px rgba(0,0,0,0.4)',
        pointerEvents: 'auto',
        userSelect: dragging ? 'none' : 'auto',
        zIndex: 401,
      }}>

        {/* Header */}
        <div
          onMouseDown={onDragStart}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '16px 24px', borderBottom: '1px solid var(--border)', flexShrink: 0,
            cursor: dragging ? 'grabbing' : 'grab',
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 17, fontWeight: 600 }}>🏦 {displayName}</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
              Account spending history
              {dateStart || dateEnd
                ? ` · ${dateStart ? dateStart.slice(0,7) : ''}${dateStart && dateEnd ? ' – ' : ''}${dateEnd ? dateEnd.slice(0,7) : ''}`
                : ' · all time'}
            </div>
          </div>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: 'var(--muted)',
            cursor: 'pointer', fontSize: 22, padding: '0 4px', lineHeight: 1,
          }}>×</button>
        </div>

        {/* Scrollable body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>

          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
            Monthly spending — {displayName}
          </div>

          {trendLoading ? <Spinner /> : trend.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--muted)', padding: '16px 0' }}>
              No history found for this account.
            </div>
          ) : (
            <div style={{ position: 'relative' }}>
              {needsNav && (
                <>
                  <button onClick={() => shiftWindow(-1)} disabled={!canPrev} title="Show older months"
                    style={{
                      position: 'absolute', left: -8, top: 0, bottom: 0, zIndex: 10,
                      width: 28, border: 'none', borderRadius: '6px 0 0 6px',
                      background: canPrev ? 'color-mix(in srgb, var(--accent) 15%, var(--surface2))' : 'transparent',
                      color: canPrev ? 'var(--accent2)' : 'var(--border)',
                      cursor: canPrev ? 'pointer' : 'default',
                      fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>‹</button>
                  <button onClick={() => shiftWindow(1)} disabled={!canNext} title="Show newer months"
                    style={{
                      position: 'absolute', right: -8, top: 0, bottom: 0, zIndex: 10,
                      width: 28, border: 'none', borderRadius: '0 6px 6px 0',
                      background: canNext ? 'color-mix(in srgb, var(--accent) 15%, var(--surface2))' : 'transparent',
                      color: canNext ? 'var(--accent2)' : 'var(--border)',
                      cursor: canNext ? 'pointer' : 'default',
                      fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>›</button>
                </>
              )}

              <div style={{ height: 160, margin: needsNav ? '0 20px' : '0' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={visible}
                    margin={{ top: 28, right: 8, bottom: 8, left: 8 }}
                    onClick={e => e?.activePayload?.[0] && setSelectedMonth(e.activePayload[0].payload.month)}
                    style={{ cursor: 'pointer' }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="month" tick={<YearTick data={visible} />}
                      tickLine={false} axisLine={false} height={30} interval={0} minTickGap={0} />
                    <YAxis
                      tickFormatter={v => `$${v >= 1000 ? (v/1000).toFixed(1)+'k' : v}`}
                      tick={{ fill: 'var(--muted)', fontSize: 10 }}
                      axisLine={false} tickLine={false} width={44} />
                    <Tooltip content={<CustomTooltip />} cursor={{ fill: 'var(--surface2)', opacity: 0.5 }} />
                    <Bar dataKey="total" radius={[3,3,0,0]} maxBarSize={42}>
                      {visible.map((entry, i) => (
                        <Cell key={i}
                          fill={entry.month === selectedMonth ? 'var(--accent2)' : 'var(--accent)'}
                          opacity={selectedMonth && entry.month !== selectedMonth ? 0.4 : 1}
                        />
                      ))}
                      <LabelList dataKey="count" position="insideTop"
                        style={{ fill: 'rgba(255,255,255,0.75)', fontSize: 9, fontWeight: 600 }}
                        formatter={v => v > 1 ? v : ''} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {needsNav && (
                <div style={{ textAlign: 'center', fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>
                  {visible[0]?.month?.slice(0,7)} – {visible[visible.length-1]?.month?.slice(0,7)}
                  {' '}· {trend.length} months total
                </div>
              )}
            </div>
          )}

          {/* Month transaction list */}
          {selectedMonth && (
            <div style={{ marginTop: 24 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
                {monthLabel(selectedMonth)} · {displayName}
              </div>

              {txnLoading ? <Spinner /> : monthTxns.length === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--muted)' }}>No transactions found.</div>
              ) : (
                <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                  <div style={{
                    display: 'grid', gridTemplateColumns: '110px 1fr 160px 110px',
                    padding: '7px 14px', fontSize: 11, fontWeight: 600,
                    color: 'var(--muted)', textTransform: 'uppercase',
                    letterSpacing: '0.05em', background: 'var(--surface2)',
                    borderBottom: '1px solid var(--border)',
                  }}>
                    <span>Date</span>
                    <span>Merchant</span>
                    <span>Category</span>
                    <span style={{ textAlign: 'right' }}>Amount</span>
                  </div>

                  {monthTxns.map(t => (
                    <div key={t.id} style={{
                      display: 'grid', gridTemplateColumns: '110px 1fr 160px 110px',
                      padding: '9px 14px', alignItems: 'center', fontSize: 13,
                      borderBottom: '1px solid var(--border)',
                    }}>
                      <span style={{ color: 'var(--muted)', fontSize: 12 }}>{formatDate(t.date)}</span>
                      <MerchantCell txn={t} onOpenDetail={() => {}} onRename={() => {}} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={t.category_name || 'Uncategorized'}>
                        {t.category_name
                          ? <Badge label={t.category_name} color={t.category_color} icon={t.category_icon} />
                          : <span style={{ color: 'var(--muted)', fontSize: 12 }}>Uncategorized</span>}
                      </span>
                      <span style={{
                        textAlign: 'right', fontWeight: 600,
                        color: t.amount < 0 ? 'var(--success)' : 'var(--text)',
                      }}>
                        {t.amount < 0 ? '+' : null}{formatCurrency(t.amount)}
                      </span>
                    </div>
                  ))}

                  <div style={{
                    padding: '8px 14px', fontSize: 13, fontWeight: 600,
                    textAlign: 'right', borderTop: '1px solid var(--border)',
                    background: 'var(--surface2)',
                  }}>
                    Total: {formatCurrency(monthTxns.reduce((s, t) => s + t.amount, 0))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
