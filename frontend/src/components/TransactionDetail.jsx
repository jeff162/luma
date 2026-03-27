/**
 * TransactionDetail — Payee spending history panel
 *
 * CONCEPT: Rather than showing a single transaction in isolation, this panel
 * shows the full history of spending at a given payee. "payee" is derived from
 * merchant_name (cleaned) or raw_name (from Plaid), whichever is set.
 *
 * OPENING BEHAVIOR:
 *   - Opens as a bottom sheet (full-width, slides up from bottom)
 *   - On first drag of the header, snaps to a floating window at its current
 *     position. The backdrop disappears so the user can interact with the page
 *     behind it while keeping the panel open.
 *   - Dragging is constrained to the viewport bounds.
 *
 * DRAG IMPLEMENTATION:
 *   pos=null means bottom-sheet mode. pos={x,y} means floating mode.
 *   onDragStart captures the mouse offset relative to the panel corner.
 *   mousemove/mouseup listeners are added to window (not the element) so
 *   fast mouse movement doesn't lose the drag target.
 *
 * AUTO-SELECT:
 *   The most recent month with data is selected automatically when the panel
 *   opens, so the transaction table is populated immediately without requiring
 *   a click. The clicked transaction's month is highlighted in the chart.
 *
 * YEAR BOUNDARIES:
 *   The YearTick component renders a dashed vertical line and year label
 *   whenever the year changes between adjacent bars. This makes multi-year
 *   data readable without cluttering the x-axis.
 *
 * CATEGORY EDITING:
 *   Each row in the month transaction table has an InlineCatEdit component
 *   that allows changing the category. Changes are saved via
 *   api.overrideCategory() and update local state (monthTxns) optimistically.
 *   The panel does not force a reload of the parent page — changed categories
 *   may appear stale in the background until the user navigates away and back.
 *
 * MERCHANT RENAME:
 *   Editing the merchant name in the header updates just that one transaction.
 *   To rename future transactions automatically, create a categorization rule
 *   with the "Rename merchant to" field set — rules now handle both categorization
 *   and merchant name normalization in a single mechanism.
 */

import { useState, useEffect, useRef } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
         ResponsiveContainer, Cell, LabelList } from 'recharts'
import { api } from '../lib/api.js'
import { formatCurrency, formatDate, monthLabel } from '../lib/utils.js'
import { Spinner, Badge } from './ui.jsx'
import { MerchantCell } from './TransactionRow.jsx'
import { useFilters } from '../lib/FilterContext.jsx'
import RuleSuggestionToast from './RuleSuggestionToast.jsx'

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildGroups(flatCats) {
  const groups = flatCats.filter(c => !c.parent_id)
  return groups.map(g => ({
    value: g.id, label: g.name, icon: g.icon,
    options: flatCats.filter(c => c.parent_id === g.id)
      .map(c => ({ value: c.id, label: c.name, icon: c.icon })),
  })).filter(g => g.options.length > 0)
}

// ── Year-aware X axis tick ─────────────────────────────────────────────────────

function YearTick({ x, y, width, payload, data }) {
  if (!payload?.value) return null
  const idx   = data.findIndex(d => d.month === payload.value)
  const next  = data[idx + 1]
  const year  = payload.value.slice(0, 4)

  // Show year label right-aligned with the LAST bar of that year:
  // either this is the last item, or the next item is a different year
  const isLastOfYear = !next || next.month.slice(0, 4) !== year

  // 3-letter month abbreviation
  const monthNum  = parseInt(payload.value.slice(5), 10) - 1
  const MONTHS    = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const monthName = MONTHS[monthNum] ?? ''

  return (
    <g>
      {isLastOfYear && (
        <text
          x={x + (width / 2) - 2}
          y={-10}
          textAnchor="end"
          fill="var(--muted)"
          fontSize={10}
          fontWeight={600}
        >
          {year}
        </text>
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

// ── Inline category editor for detail rows ────────────────────────────────────

function InlineCatEdit({ t, categories, onSaved, onRulePrompt }) {
  const [editing, setEditing] = useState(false)
  const groups = buildGroups(categories)

  async function handleChange(e) {
    const catId = e.target.value
    setEditing(false)
    await api.overrideCategory(t.id, catId)
    const cat = categories.find(c => c.id === catId)
    onSaved(t.id, cat)
    if (cat && onRulePrompt) {
      const merchantName = t.merchant_name || t.raw_name
      if (merchantName) {
        onRulePrompt({
          merchantName,
          categoryId:    cat.id,
          categoryName:  cat.name,
          categoryColor: cat.color,
          categoryIcon:  cat.icon,
        })
      }
    }
  }

  if (editing) {
    return (
      <select
        autoFocus
        defaultValue={t.category_id || ''}
        onChange={handleChange}
        onBlur={() => setEditing(false)}
        style={{
          background: 'var(--surface2)', color: 'var(--text)',
          border: '1px solid var(--accent)', borderRadius: 6,
          padding: '3px 6px', fontSize: 12, cursor: 'pointer', outline: 'none',
        }}
      >
        <option value="">— Uncategorized —</option>
        {groups.map(g => (
          <optgroup key={g.value} label={`${g.icon} ${g.label}`}>
            {g.options.map(o => (
              <option key={o.value} value={o.value}>{o.icon} {o.label}</option>
            ))}
          </optgroup>
        ))}
      </select>
    )
  }

  return (
    <div onClick={() => setEditing(true)} style={{ cursor: 'pointer' }}>
      {t.category_name ? (
        <Badge label={t.category_name} color={t.category_color} icon={t.category_icon} />
      ) : (
        <span style={{ color: 'var(--muted)', fontSize: 12 }}>Uncategorized</span>
      )}
    </div>
  )
}

const inputStyle = {
  background: 'var(--surface2)', color: 'var(--text)',
  border: '1px solid var(--border)', borderRadius: 6,
  padding: '5px 8px', fontSize: 13, outline: 'none',
}

// ── Main component ────────────────────────────────────────────────────────────

export default function TransactionDetail({ txn, categories, onClose, onRulePrompt: externalRulePrompt }) {
  const { filters } = useFilters()
  const dateStart = filters.date?.start || null
  const dateEnd   = filters.date?.end   || null
  const [pos, setPos]                   = useState(null) // null = bottom sheet, {x,y} = floating
  const [dragging, setDragging]         = useState(false)
  const dragOffset                      = useRef({ x: 0, y: 0 })
  const [trend, setTrend]               = useState([])
  const [windowEnd, setWindowEnd]       = useState(null)  // null = latest month
  const [editingName, setEditingName]   = useState(false)
  const [nameDraft, setNameDraft]       = useState('')
  const [displayName, setDisplayName]   = useState(txn.merchant_name || txn.raw_name)
  const [selectedMonth, setSelectedMonth] = useState(null)
  const [monthTxns, setMonthTxns]       = useState([])
  const [trendLoading, setTrendLoading] = useState(true)
  const [txnLoading, setTxnLoading]     = useState(false)
  const [rulePrompt, setRulePrompt]     = useState(null)
  const panelRef = useRef(null)

  const payee    = txn.merchant_name || txn.raw_name

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
    if (!dragging) return
    function onMove(e) {
      if (!hasDragged.current) {
        // First actual movement: snap from bottom-sheet to floating
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
      const x = Math.max(0, Math.min(window.innerWidth  - 200, e.clientX - dragOffset.current.x))
      const y = Math.max(0, Math.min(window.innerHeight - 60,  e.clientY - dragOffset.current.y))
      setPos(prev => prev ? { x, y } : prev)
    }
    function onUp() { setDragging(false) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [dragging, pos])
  const txnMonth = txn.date.slice(0, 7)

  // Load trend using the active date filter range, or all history if no filter set
  useEffect(() => {
    setTrendLoading(true)
    api.getPayeeTrend(payee, dateStart, dateEnd).then(rows => {
      setTrend(rows)
      setWindowEnd(null)  // reset to latest on each load
      setTrendLoading(false)
      if (rows.length > 0) {
        setSelectedMonth(rows[rows.length - 1].month)
      }
    })
  }, [payee, dateStart, dateEnd])

  // Load transactions for selected month
  useEffect(() => {
    if (!selectedMonth) return
    setTxnLoading(true)
    api.getTransactions({ month: selectedMonth, search: payee, limit: 100 }).then(d => {
      setMonthTxns(d.transactions.filter(t =>
        (t.merchant_name || t.raw_name) === payee
      ))
      setTxnLoading(false)
    })
  }, [selectedMonth, payee])

  // Close on outside click
  useEffect(() => {
    function h(e) {
      if (panelRef.current && !panelRef.current.contains(e.target)) onClose()
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [onClose])

  async function saveMerchantName() {
    const name = nameDraft.trim()
    if (!name || name === displayName) { setEditingName(false); return }
    await api.updateMerchant(txn.id, name)
    setDisplayName(name)
    setEditingName(false)
  }

  // Update a single transaction's category in local state
  function handleCatSaved(txnId, cat) {
    setMonthTxns(prev => prev.map(t =>
      t.id !== txnId ? t : {
        ...t,
        category_id:    cat?.id    ?? null,
        category_name:  cat?.name  ?? null,
        category_color: cat?.color ?? null,
        category_icon:  cat?.icon  ?? null,
        category_overridden: 1,
      }
    ))
  }

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
        left:   pos ? pos.x : undefined,
        top:    pos ? pos.y : undefined,
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

        {/* Header — drag handle */}
        <div
          onMouseDown={onDragStart}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '16px 24px', borderBottom: '1px solid var(--border)', flexShrink: 0,
            cursor: dragging ? 'grabbing' : 'grab',
          }}
        >
          <div style={{ flex: 1 }}>
            {editingName ? (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  autoFocus
                  value={nameDraft}
                  onChange={e => setNameDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') saveMerchantName(); if (e.key === 'Escape') setEditingName(false) }}
                  style={{
                    fontSize: 17, fontWeight: 600, background: 'var(--surface2)',
                    color: 'var(--text)', border: '1px solid var(--accent)',
                    borderRadius: 6, padding: '3px 8px', outline: 'none', minWidth: 220,
                  }}
                />
                <button onClick={saveMerchantName} style={{
                  background: 'var(--accent)', color: '#fff', border: 'none',
                  borderRadius: 6, padding: '4px 12px', fontSize: 13, cursor: 'pointer',
                }}>Save</button>
                <button onClick={() => setEditingName(false)} style={{
                  background: 'none', border: '1px solid var(--border)', color: 'var(--muted)',
                  borderRadius: 6, padding: '4px 10px', fontSize: 13, cursor: 'pointer',
                }}>Cancel</button>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ fontSize: 17, fontWeight: 600 }}>{displayName}</div>
                <button
                  onClick={() => { setNameDraft(displayName); setEditingName(true); setShowRenameRule(false) }}
                  title="Edit merchant name"
                  style={{
                    background: 'none', border: 'none', color: 'var(--muted)',
                    cursor: 'pointer', fontSize: 13, padding: '2px 4px',
                  }}
                >✎</button>
              </div>
            )}
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
              Spending history{dateStart || dateEnd
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

          {/* Chart */}
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
            Spending at {payee}{dateStart || dateEnd ? '' : ' — all time'}
          </div>

          {trendLoading ? <Spinner /> : trend.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--muted)', padding: '16px 0' }}>
              No history found for this payee.
            </div>
          ) : (() => {
            // ── Window calculation ────────────────────────────────────────
            const WINDOW = 18
            const endIdx   = windowEnd
              ? trend.findIndex(d => d.month === windowEnd)
              : trend.length - 1
            const safeEnd  = endIdx === -1 ? trend.length - 1 : endIdx
            const startIdx = Math.max(0, safeEnd - WINDOW + 1)
            const visible  = trend.slice(startIdx, safeEnd + 1)
            const canPrev  = startIdx > 0
            const canNext  = safeEnd < trend.length - 1
            const needsNav = trend.length > WINDOW

            function shiftWindow(dir) {
              // dir: -1 = older, +1 = newer
              const newEnd = Math.max(WINDOW - 1, Math.min(trend.length - 1, safeEnd + dir * WINDOW))
              setWindowEnd(trend[newEnd].month)
            }

            return (
              <div style={{ position: 'relative' }}>
                {/* Prev / Next nav arrows — only shown when data exceeds window */}
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
                        transition: 'background 0.15s',
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
                        transition: 'background 0.15s',
                      }}
                    >›</button>
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
                      <XAxis
                        dataKey="month"
                        tick={<YearTick data={visible} />}
                        tickLine={false}
                        axisLine={false}
                        height={30}
                        interval={0}
                        minTickGap={0}
                      />
                      <YAxis
                        tickFormatter={v => `$${v >= 1000 ? (v/1000).toFixed(1)+'k' : v}`}
                        tick={{ fill: 'var(--muted)', fontSize: 10 }}
                        axisLine={false} tickLine={false} width={44}
                      />
                      <Tooltip content={<CustomTooltip />} cursor={{ fill: 'var(--surface2)', opacity: 0.5 }} />
                      <Bar dataKey="total" radius={[3,3,0,0]} maxBarSize={42}>
                        {visible.map((entry, i) => (
                          <Cell key={i}
                            fill={entry.month === selectedMonth ? 'var(--accent2)' : 'var(--accent)'}
                            opacity={selectedMonth && entry.month !== selectedMonth ? 0.4 : 1}
                          />
                        ))}
                        <LabelList
                          dataKey="count"
                          position="insideTop"
                          style={{ fill: 'rgba(255,255,255,0.75)', fontSize: 9, fontWeight: 600 }}
                          formatter={v => v > 1 ? v : ''}
                        />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                {/* Window indicator */}
                {needsNav && (
                  <div style={{ textAlign: 'center', fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>
                    {visible[0]?.month?.slice(0,7).replace('-',' ')} – {visible[visible.length-1]?.month?.slice(0,7).replace('-',' ')}
                    {' '}· {trend.length} months total
                  </div>
                )}
              </div>
            )
          })()}

          {/* Month transactions */}
          {selectedMonth && (
            <div style={{ marginTop: 24 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
                {monthLabel(selectedMonth)} · {payee}
              </div>

              {txnLoading ? <Spinner /> : monthTxns.length === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--muted)' }}>No transactions found.</div>
              ) : (
                <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                  <div style={{
                    display: 'grid', gridTemplateColumns: '110px 1fr 140px 160px 110px',
                    padding: '7px 14px', fontSize: 11, fontWeight: 600,
                    color: 'var(--muted)', textTransform: 'uppercase',
                    letterSpacing: '0.05em', background: 'var(--surface2)',
                    borderBottom: '1px solid var(--border)',
                  }}>
                    <span>Date</span>
                    <span>Description</span>
                    <span>Account</span>
                    <span>Category</span>
                    <span style={{ textAlign: 'right' }}>Amount</span>
                  </div>

                  {monthTxns.map(t => (
                    <div key={t.id} style={{
                      display: 'grid', gridTemplateColumns: '110px 1fr 140px 160px 110px',
                      padding: '9px 14px', alignItems: 'center', fontSize: 13,
                      borderBottom: '1px solid var(--border)',
                      background: t.id === txn.id
                        ? 'color-mix(in srgb, var(--accent) 8%, transparent)'
                        : 'transparent',
                    }}>
                      <span style={{ color: 'var(--muted)', fontSize: 12 }}>{formatDate(t.date)}</span>
                      <MerchantCell
                        txn={t}
                        onOpenDetail={() => {}}
                        onRename={(id, name) => setMonthTxns(prev =>
                          prev.map(x => x.id === id ? { ...x, merchant_name: name } : x)
                        )}
                      />
                      <span style={{ color: 'var(--muted)', fontSize: 12,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {t.account_name}{t.account_mask ? ` ···${t.account_mask}` : ''}
                      </span>
                      <InlineCatEdit
                        t={t}
                        categories={categories}
                        onSaved={handleCatSaved}
                        onRulePrompt={p => {
                          setRulePrompt(p)
                          externalRulePrompt?.(p)
                        }}
                      />
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
      {rulePrompt && (
        <RuleSuggestionToast
          prompt={rulePrompt}
          onDismiss={() => setRulePrompt(null)}
        />
      )}
    </div>
  )
}
