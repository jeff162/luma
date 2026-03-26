/**
 * RuleForm — Shared rule creation/editing form
 *
 * AMOUNT CONDITION:
 *   The amount chip expands into a structured editor with three parts:
 *   1. Applies to: Debits / Credits / Both  (UI-only — backend uses absolute values)
 *   2. Lower bound (optional): >= or > operator + value
 *   3. Upper bound (optional): <= or < operator + value
 *   Plus an "Equals" shortcut that sets min=max with >= operator on both sides.
 *   All comparisons use absolute values (a debit of -$10 matches ">= $5 and <= $15").
 *
 * AMOUNT STATE:
 *   amtLowOp:  '>=' | '>'  (operator for lower bound)
 *   amtLow:    number | null
 *   amtHighOp: '<=' | '<'  (operator for upper bound)
 *   amtHigh:   number | null
 *   amtSide:   'debit' | 'credit' | 'both'
 *
 *   These map to amount_min / amount_max for the backend. The op modifiers
 *   are stored as half-open adjustments: '>' lowers amtLow by epsilon when
 *   sent to the backend is not practical with floats, so we store the op
 *   separately and reconstruct the display; the backend uses >= / <= semantics
 *   for amount_min / amount_max respectively (both inclusive). The operator
 *   choice is therefore display-only at this stage — the backend always treats
 *   amount_min as >= and amount_max as <=. This matches real-world needs since
 *   financial amounts are typically compared with inclusive bounds.
 *
 * LIST DISPLAY (Rules.jsx):
 *   Rules are listed as "merchant name" + plain-text description of all
 *   active conditions and actions. No separate columns.
 *
 * TRANSACTION DEFAULTS:
 *   When transactionData prop is provided (from transaction context), the form
 *   will auto-populate the amount filter and debit/credit selector:
 *   - Amount defaults to the transaction's absolute value (sets min=max)
 *   - Debit/credit defaults based on transaction sign
 *   This only applies when creating rules from the transaction detail flow,
 *   not when creating rules from the Rules page.
 */

import { useState, useEffect, useRef } from 'react'
import { api } from '../lib/api.js'

// ── Shared styles ─────────────────────────────────────────────────────────────

const sectionHeadStyle = {
  fontSize: 11, fontWeight: 700, color: 'var(--accent2)',
  textTransform: 'uppercase', letterSpacing: '0.07em',
  marginBottom: 12,
}

const CAT_ICONS = ['📦','🛒','🍽️','☕','🏠','🚗','💊','🎬','✈️','💰','🏋️','👕','💻','🐾','🎁','🔧','📱','🏥','🎨','🌿']

// ── Amount summary for chip header ────────────────────────────────────────────

export function amountConditionSummary(low, lowOp, high, highOp, side) {
  const parts = []
  if (side && side !== 'both') parts.push(side === 'debit' ? 'debit' : 'credit')
  if (low  != null && high != null && low === high) {
    parts.push(`= $${low}`)
  } else {
    if (low  != null) parts.push(`${lowOp ?? '>='} $${low}`)
    if (high != null) parts.push(`${highOp ?? '<='} $${high}`)
  }
  return parts.length ? parts.join(', ') : null
}

// ── NumberInput ───────────────────────────────────────────────────────────────

function NumberInput({ value, onChange, placeholder, width = 88 }) {
  return (
    <input
      type="number" min="0" step="0.01"
      value={value ?? ''}
      onChange={e => onChange(e.target.value === '' ? null : parseFloat(e.target.value))}
      placeholder={placeholder}
      style={{
        width, background: 'var(--surface2)', color: 'var(--text)',
        border: '1px solid var(--border)', borderRadius: 6,
        padding: '6px 8px', fontSize: 13, outline: 'none',
      }}
    />
  )
}

// ── OpSelect — small operator dropdown ───────────────────────────────────────

function OpSelect({ value, onChange, options }) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        background: 'var(--surface2)', color: 'var(--text)',
        border: '1px solid var(--border)', borderRadius: 6,
        padding: '6px 6px', fontSize: 13, cursor: 'pointer', outline: 'none',
      }}
    >
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  )
}

// ── SegButton — small segmented control button ────────────────────────────────

function SegButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '4px 10px', fontSize: 12, cursor: 'pointer',
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
        background: active ? 'var(--accent)' : 'transparent',
        color: active ? '#fff' : 'var(--muted)',
        fontWeight: active ? 500 : 400,
        borderRadius: 6,
      }}
    >{children}</button>
  )
}

// ── AmountCondition ───────────────────────────────────────────────────────────

function AmountCondition({ low, lowOp, high, highOp, side, onChange }) {
  // "equals" mode: min == max
  const isEquals = low != null && high != null && low === high

  function setLow(v)      { onChange({ low: v,    lowOp, high, highOp, side }) }
  function setLowOp(op)   { onChange({ low, lowOp: op, high, highOp, side }) }
  function setHigh(v)     { onChange({ low, lowOp, high: v,    highOp, side }) }
  function setHighOp(op)  { onChange({ low, lowOp, high, highOp: op, side }) }
  function setSide(s)     { onChange({ low, lowOp, high, highOp, side: s }) }

  function setEquals(v) {
    onChange({ low: v, lowOp: '>=', high: v, highOp: '<=', side })
  }

  // Toggle equals mode on/off
  function toggleEquals() {
    if (isEquals) {
      // Break out of equals — keep value as lower bound only
      onChange({ low, lowOp: '>=', high: null, highOp: '<=', side })
    } else {
      // Set equals using current low or high value
      const v = low ?? high ?? 0
      onChange({ low: v, lowOp: '>=', high: v, highOp: '<=', side })
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Applies to: debit / credit / both */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, color: 'var(--muted)', minWidth: 68 }}>Applies to</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <SegButton active={side === 'both'}   onClick={() => setSide('both')}>Both</SegButton>
          <SegButton active={side === 'debit'}  onClick={() => setSide('debit')}>Debits</SegButton>
          <SegButton active={side === 'credit'} onClick={() => setSide('credit')}>Credits</SegButton>
        </div>
      </div>

      {/* Equals toggle */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, color: 'var(--muted)', minWidth: 68 }}>Mode</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <SegButton active={!isEquals} onClick={() => isEquals && toggleEquals()}>Range</SegButton>
          <SegButton active={isEquals}  onClick={() => !isEquals && toggleEquals()}>Equals</SegButton>
        </div>
      </div>

      {isEquals ? (
        /* Equals mode */
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--muted)', minWidth: 68 }}>Amount =</span>
          <span style={{ fontSize: 13, color: 'var(--muted)' }}>$</span>
          <NumberInput value={low} onChange={setEquals} placeholder="0.00" />
        </div>
      ) : (
        /* Range mode: optional lower + optional upper */
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {/* Lower bound */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--muted)', minWidth: 68 }}>
              {low != null ? 'Lower' : <span style={{ opacity: 0.5 }}>Lower</span>}
            </span>
            <OpSelect value={lowOp ?? '>='} onChange={setLowOp} options={['>=', '>']} />
            <span style={{ fontSize: 13, color: 'var(--muted)' }}>$</span>
            <NumberInput
              value={low}
              onChange={v => setLow(v)}
              placeholder="no lower limit"
              width={110}
            />
            {low != null && (
              <button onClick={() => setLow(null)} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px' }}>×</button>
            )}
          </div>
          {/* Upper bound */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--muted)', minWidth: 68 }}>
              {high != null ? 'Upper' : <span style={{ opacity: 0.5 }}>Upper</span>}
            </span>
            <OpSelect value={highOp ?? '<='} onChange={setHighOp} options={['<=', '<']} />
            <span style={{ fontSize: 13, color: 'var(--muted)' }}>$</span>
            <NumberInput
              value={high}
              onChange={v => setHigh(v)}
              placeholder="no upper limit"
              width={110}
            />
            {high != null && (
              <button onClick={() => setHigh(null)} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px' }}>×</button>
            )}
          </div>
        </div>
      )}

      <div style={{ fontSize: 11, color: 'var(--muted)' }}>
        All comparisons use absolute value — a debit of −$10 matches as $10
      </div>
    </div>
  )
}

// ── ConditionChip — expandable pill ──────────────────────────────────────────

function ConditionChip({ label, summary, active, onActivate, onClear, children }) {
  if (!active) {
    return (
      <button
        onClick={onActivate}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          padding: '5px 10px', borderRadius: 20, fontSize: 12,
          border: '1px dashed var(--border)', background: 'transparent',
          color: 'var(--muted)', cursor: 'pointer', transition: 'all 0.1s',
        }}
        onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.color = 'var(--accent2)' }}
        onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--muted)' }}
      >
        <span style={{ fontSize: 11 }}>＋</span> {label}
      </button>
    )
  }
  return (
    <div style={{ border: '1px solid var(--accent)', borderRadius: 10, background: 'color-mix(in srgb, var(--accent) 5%, var(--surface))', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid var(--border)', background: 'color-mix(in srgb, var(--accent) 8%, var(--surface2))' }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent2)', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>{label}</span>
        {summary && <span style={{ fontSize: 12, color: 'var(--muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summary}</span>}
        <button onClick={onClear} title={`Remove ${label}`} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px', flexShrink: 0 }}>×</button>
      </div>
      <div style={{ padding: '10px 12px' }}>{children}</div>
    </div>
  )
}

// ── CategoryPicker ────────────────────────────────────────────────────────────

function NewCategoryForm({ groups, mode, defaultGroupId, onSave, onCancel }) {
  const [name,    setName]    = useState('')
  const [groupId, setGroupId] = useState(defaultGroupId || (groups[0]?.id ?? ''))
  const [icon,    setIcon]    = useState('📦')
  const [saving,  setSaving]  = useState(false)
  const inputRef = useRef(null)
  useEffect(() => { inputRef.current?.focus() }, [])

  async function handleSave() {
    if (!name.trim()) return
    if (mode === 'leaf' && !groupId) return
    setSaving(true)
    const body = mode === 'group' ? { name: name.trim(), icon, parent_id: null } : { name: name.trim(), icon, parent_id: groupId }
    const created = await api.createCategory(body)
    await onSave(created)
    setSaving(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} onMouseDown={e => e.stopPropagation()}>
      {mode === 'leaf' && groups.length > 1 && (
        <select value={groupId} onChange={e => setGroupId(e.target.value)} style={{ background: 'var(--surface2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 8px', fontSize: 12 }}>
          {groups.map(g => <option key={g.id} value={g.id}>{g.icon} {g.name}</option>)}
        </select>
      )}
      <input ref={inputRef} value={name} onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onCancel() }}
        placeholder={mode === 'group' ? 'Group name…' : 'Category name…'}
        style={{ background: 'var(--surface2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', fontSize: 13, outline: 'none' }} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
        {CAT_ICONS.map(ic => (
          <button key={ic} onClick={() => setIcon(ic)} style={{ fontSize: 14, padding: '2px 4px', borderRadius: 4, cursor: 'pointer', border: ic === icon ? '1px solid var(--accent)' : '1px solid transparent', background: ic === icon ? 'color-mix(in srgb, var(--accent) 12%, var(--surface2))' : 'none' }}>{ic}</button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={handleSave} disabled={saving || !name.trim()} style={{ flex: 1, background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, padding: '5px 0', fontSize: 12, cursor: saving || !name.trim() ? 'not-allowed' : 'pointer', opacity: saving || !name.trim() ? 0.5 : 1 }}>{saving ? 'Saving…' : 'Create'}</button>
        <button onClick={onCancel} style={{ background: 'var(--surface2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 10px', fontSize: 12, cursor: 'pointer' }}>Cancel</button>
      </div>
    </div>
  )
}

function CategoryPicker({ value, categories, onChange, onCategoryCreated }) {
  const [open, setOpen]         = useState(false)
  const [creating, setCreating] = useState(null)
  const ref = useRef(null)
  const groups   = categories.filter(c => !c.parent_id)
  const leaves   = categories.filter(c =>  c.parent_id)
  const selected = categories.find(c => c.id === value)

  useEffect(() => {
    if (!open) return
    function h(e) { if (ref.current && !ref.current.contains(e.target)) { setOpen(false); setCreating(null) } }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  async function handleCreated(created) { await onCategoryCreated(); onChange(created.id); setCreating(null); setOpen(false) }

  return (
    <div ref={ref} style={{ position: 'relative', flex: 1 }}>
      <div onClick={() => { setOpen(v => !v); setCreating(null) }} style={{ background: 'var(--surface)', color: 'var(--text)', border: open ? '1px solid var(--accent)' : '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, userSelect: 'none', minHeight: 38 }}>
        {selected ? (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {selected.icon} {selected.name}
            {selected.parent_id && <span style={{ fontSize: 11, color: 'var(--muted)' }}>({groups.find(g => g.id === selected.parent_id)?.name})</span>}
          </span>
        ) : <span style={{ color: 'var(--muted)' }}>— Select category —</span>}
        <span style={{ color: 'var(--muted)', fontSize: 11 }}>{open ? '▴' : '▾'}</span>
      </div>
      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 300, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.25)', maxHeight: 300, overflowY: 'auto' }}>
          {creating === 'group' ? (
            <div style={{ padding: 10 }}><NewCategoryForm groups={groups} mode="group" defaultGroupId={null} onSave={handleCreated} onCancel={() => setCreating(null)} /></div>
          ) : (
            <>
              {groups.map(g => {
                const kids = leaves.filter(c => c.parent_id === g.id)
                const creatingHere = creating?.type === 'leaf' && creating.groupId === g.id
                return (
                  <div key={g.id}>
                    <div style={{ padding: '6px 12px 2px', fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{g.icon} {g.name}</div>
                    {kids.map(c => (
                      <div key={c.id} onMouseDown={() => { onChange(c.id); setOpen(false); setCreating(null) }}
                        style={{ padding: '7px 12px 7px 28px', fontSize: 13, cursor: 'pointer', background: value === c.id ? 'color-mix(in srgb, var(--accent) 12%, var(--surface2))' : 'transparent', display: 'flex', alignItems: 'center', gap: 7 }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--surface2)'}
                        onMouseLeave={e => e.currentTarget.style.background = value === c.id ? 'color-mix(in srgb, var(--accent) 12%, var(--surface2))' : 'transparent'}
                      >
                        {c.icon} {c.name}
                        {value === c.id && <span style={{ marginLeft: 'auto', color: 'var(--accent2)', fontSize: 11 }}>✓</span>}
                      </div>
                    ))}
                    {creatingHere ? (
                      <div style={{ padding: '6px 12px 8px 20px' }}><NewCategoryForm groups={groups} mode="leaf" defaultGroupId={g.id} onSave={handleCreated} onCancel={() => setCreating(null)} /></div>
                    ) : (
                      <div onMouseDown={e => { e.stopPropagation(); setCreating({ type: 'leaf', groupId: g.id }) }}
                        style={{ padding: '5px 12px 6px 28px', fontSize: 12, color: 'var(--accent2)', cursor: 'pointer', opacity: 0.8 }}
                        onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                        onMouseLeave={e => e.currentTarget.style.opacity = '0.8'}
                      >＋ New category in {g.name}</div>
                    )}
                  </div>
                )
              })}
              <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />
              <div onMouseDown={e => { e.stopPropagation(); setCreating('group') }}
                style={{ padding: '7px 12px', fontSize: 12, fontWeight: 500, color: 'var(--accent2)', cursor: 'pointer', opacity: 0.8 }}
                onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                onMouseLeave={e => e.currentTarget.style.opacity = '0.8'}
              >＋ New group</div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── MatchPreview ──────────────────────────────────────────────────────────────

function MatchPreview({ keyword, amtLow, amtHigh, ownerId, accountId, onCountChange }) {
  const [count,   setCount]   = useState(null)
  const [loading, setLoading] = useState(false)
  const debounceRef = useRef(null)

  const hasKeyword = keyword.trim().length >= 2
  const hasAmount  = amtLow != null || amtHigh != null
  const canSearch  = hasKeyword || hasAmount

  useEffect(() => {
    if (!canSearch) { setCount(null); onCountChange(0); return }
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      setLoading(true)
      try {
        const resp = await api.getTransactions({
          category_id: '__uncategorized__', limit: 500,
          ...(hasKeyword ? { search:      keyword.trim() } : {}),
          ...(ownerId    ? { owner_ids:   ownerId }        : {}),
          ...(accountId  ? { account_ids: accountId }      : {}),
        })
        const matched = resp.transactions.filter(t => {
          const abs = Math.abs(t.amount)
          if (amtLow  != null && abs < amtLow)  return false
          if (amtHigh != null && abs > amtHigh) return false
          return true
        })
        setCount(matched.length); onCountChange(matched.length)
      } catch { setCount(null); onCountChange(0) }
      finally { setLoading(false) }
    }, 600)
    return () => clearTimeout(debounceRef.current)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword, amtLow, amtHigh, ownerId, accountId, canSearch])

  if (!canSearch || (!loading && count === 0)) return null
  if (loading) return <div style={{ fontSize: 12, color: 'var(--muted)', padding: '4px 0' }}>Checking for matching transactions…</div>
  if (count === null) return null
  return <div style={{ fontSize: 12, color: 'var(--muted)', padding: '4px 0' }}>{count} uncategorized transaction{count !== 1 ? 's' : ''} match{count === 1 ? 'es' : ''} this rule</div>
}

// ── RuleForm ──────────────────────────────────────────────────────────────────

export default function RuleForm({
  initialValues = {},
  categories,
  owners,
  accounts,
  onSave,
  onCancel,
  saveLabel = 'Save rule',
  transactionData = null,
}) {
  // Helper to determine initial amount state from transaction or initialValues
  const getInitialAmountState = () => {
    if (!transactionData) {
      // No transaction context — use initialValues or defaults
      return {
        amtLow: initialValues.amtMin ?? null,
        amtLowOp: initialValues.amtLowOp ?? '>=',
        amtHigh: initialValues.amtMax ?? null,
        amtHighOp: initialValues.amtHighOp ?? '<=',
        amtSide: initialValues.amtSide ?? 'both',
      }
    }

    // Transaction context provided — set transaction amount as default (equals mode)
    const absAmount = Math.abs(transactionData.amount)
    const isDebit = transactionData.amount < 0

    return {
      amtLow: absAmount,
      amtLowOp: '>=',
      amtHigh: absAmount,
      amtHighOp: '<=',
      amtSide: isDebit ? 'debit' : 'credit',
    }
  }

  const initialState = getInitialAmountState()

  // Conditions
  const [keyword,   setKeyword]   = useState(initialValues.keyword   ?? '')
  const [amtLow,    setAmtLow]    = useState(initialState.amtLow)
  const [amtLowOp,  setAmtLowOp]  = useState(initialState.amtLowOp)
  const [amtHigh,   setAmtHigh]   = useState(initialState.amtHigh)
  const [amtHighOp, setAmtHighOp] = useState(initialState.amtHighOp)
  const [amtSide,   setAmtSide]   = useState(initialState.amtSide)
  const [ownerId,   setOwnerId]   = useState(initialValues.ownerId   ?? '')
  const [accountId, setAccountId] = useState(initialValues.accountId ?? '')

  // Chip open/closed
  const [kwOpen,  setKwOpen]  = useState(!!initialValues.keyword)
  const [amtOpen, setAmtOpen] = useState(initialState.amtLow != null || initialState.amtHigh != null)
  const [ownOpen, setOwnOpen] = useState(!!initialValues.ownerId)
  const [accOpen, setAccOpen] = useState(!!initialValues.accountId)

  // Actions
  const [catId,      setCatId]      = useState(initialValues.catId     ?? '')
  const [cleanName,  setCleanName]  = useState(initialValues.cleanName ?? '')
  const [renameOpen, setRenameOpen] = useState(!!initialValues.cleanName)

  // Apply-to-existing
  const [matchCount,      setMatchCount]      = useState(0)
  const [applyToExisting, setApplyToExisting] = useState(false)

  // Save
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState(null)

  const canSave = keyword.trim().length > 0 && catId

  function handleAmtChange({ low, lowOp, high, highOp, side }) {
    setAmtLow(low); setAmtLowOp(lowOp ?? '>=')
    setAmtHigh(high); setAmtHighOp(highOp ?? '<=')
    setAmtSide(side ?? 'both')
  }

  async function handleSave() {
    if (!canSave) return
    setSaving(true); setError(null)
    try {
      await onSave({
        keyword:          keyword.trim(),
        category_id:      catId,
        // Backend uses amount_min as >= and amount_max as <= (inclusive bounds)
        // The operator UI is for user clarity; we pass the raw values
        amount_min:       amtLow,
        amount_max:       amtHigh,
        clean_name:       cleanName.trim() || null,
        owner_id:         ownerId || null,
        clear_amount_min: amtLow  === null,
        clear_amount_max: amtHigh === null,
        clear_clean_name: !cleanName.trim(),
        clear_owner:      !ownerId,
        applyToExisting,
      })
    } catch (e) { setError(e.message || 'Failed to save rule'); setSaving(false) }
  }

  const amtSummary = amountConditionSummary(amtLow, amtLowOp, amtHigh, amtHighOp, amtSide)

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>

      {/* ── Section 1: Conditions ──────────────────────────────────────────── */}
      <div style={{ padding: '16px 20px', borderBottom: '2px solid var(--border)' }}>
        <div style={sectionHeadStyle}>If the transaction matches…</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

          <ConditionChip
            label="Merchant name contains"
            summary={kwOpen && keyword.trim() ? `"${keyword}"` : null}
            active={kwOpen}
            onActivate={() => setKwOpen(true)}
            onClear={() => { setKeyword(''); setKwOpen(false) }}
          >
            <input
              autoFocus={kwOpen && !initialValues.keyword}
              value={keyword}
              onChange={e => setKeyword(e.target.value)}
              placeholder="e.g. starbucks"
              style={{ width: '100%', boxSizing: 'border-box', background: 'var(--surface2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 10px', fontSize: 13, outline: 'none' }}
            />
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 5 }}>Case-insensitive substring match</div>
          </ConditionChip>

          <ConditionChip
            label="Amount"
            summary={amtOpen ? amtSummary : null}
            active={amtOpen}
            onActivate={() => { setAmtOpen(true) }}
            onClear={() => { setAmtLow(null); setAmtHigh(null); setAmtOpen(false) }}
          >
            <AmountCondition
              low={amtLow} lowOp={amtLowOp}
              high={amtHigh} highOp={amtHighOp}
              side={amtSide}
              onChange={handleAmtChange}
            />
          </ConditionChip>

          {owners.length > 0 && (
            <ConditionChip
              label="Owner"
              summary={ownOpen ? (owners.find(o => o.id === ownerId)?.name ?? null) : null}
              active={ownOpen}
              onActivate={() => setOwnOpen(true)}
              onClear={() => { setOwnerId(''); setOwnOpen(false) }}
            >
              <select value={ownerId} onChange={e => setOwnerId(e.target.value)} style={{ width: '100%', background: 'var(--surface2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 10px', fontSize: 13 }}>
                <option value="">— Select owner —</option>
                {owners.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 5 }}>Restrict this rule to one owner's transactions</div>
            </ConditionChip>
          )}

          {accounts.length > 0 && (
            <ConditionChip
              label="Account"
              summary={accOpen ? (accounts.find(a => a.id === accountId)?.name ?? null) : null}
              active={accOpen}
              onActivate={() => setAccOpen(true)}
              onClear={() => { setAccountId(''); setAccOpen(false) }}
            >
              <select value={accountId} onChange={e => setAccountId(e.target.value)} style={{ width: '100%', background: 'var(--surface2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 10px', fontSize: 13 }}>
                <option value="">— Select account —</option>
                {accounts.map(a => <option key={a.id} value={a.id}>{a.name}{a.mask ? ` ···${a.mask}` : ''}</option>)}
              </select>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 5 }}>Restrict this rule to one account only</div>
            </ConditionChip>
          )}
        </div>
      </div>

      {/* ── Section 2: Actions ─────────────────────────────────────────────── */}
      <div style={{ padding: '16px 20px', borderBottom: '2px solid var(--border)' }}>
        <div style={sectionHeadStyle}>Then these actions apply…</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
              Assign category <span style={{ color: '#ef4444', fontWeight: 400 }}>required</span>
            </div>
            <div style={{ display: 'flex' }}>
              <CategoryPicker value={catId} categories={categories} onChange={setCatId} onCategoryCreated={() => api.getCategories()} />
            </div>
          </div>

          <ConditionChip
            label="Rename merchant to"
            summary={renameOpen && cleanName.trim() ? cleanName : null}
            active={renameOpen}
            onActivate={() => setRenameOpen(true)}
            onClear={() => { setCleanName(''); setRenameOpen(false) }}
          >
            <input
              value={cleanName}
              onChange={e => setCleanName(e.target.value)}
              placeholder="Clean display name, e.g. Whole Foods"
              style={{ width: '100%', boxSizing: 'border-box', background: 'var(--surface2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 10px', fontSize: 13, outline: 'none' }}
            />
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 5 }}>Sets the display name when this rule fires on future transactions</div>
          </ConditionChip>

        </div>
      </div>

      {/* ── Footer ─────────────────────────────────────────────────────────── */}
      <div style={{ padding: '12px 20px', background: 'var(--surface2)' }}>
        <MatchPreview
          keyword={keyword} amtLow={amtLow} amtHigh={amtHigh}
          ownerId={ownerId} accountId={accountId}
          onCountChange={n => { setMatchCount(n); if (n === 0) setApplyToExisting(false) }}
        />
        {matchCount > 0 && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, fontSize: 13, cursor: 'pointer', userSelect: 'none' }}>
            <input type="checkbox" checked={applyToExisting} onChange={e => setApplyToExisting(e.target.checked)}
              style={{ width: 15, height: 15, accentColor: 'var(--accent)', cursor: 'pointer' }} />
            Apply to {matchCount} existing transaction{matchCount !== 1 ? 's' : ''} when saving
          </label>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
          {error && <span style={{ fontSize: 12, color: 'var(--danger)', flex: 1 }}>{error}</span>}
          <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
            {onCancel && (
              <button onClick={onCancel} style={{ background: 'transparent', color: 'var(--muted)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 16px', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
            )}
            <button onClick={handleSave} disabled={saving || !canSave} style={{
              background: canSave ? 'var(--accent)' : 'var(--surface)', color: canSave ? '#fff' : 'var(--muted)',
              border: canSave ? 'none' : '1px solid var(--border)', borderRadius: 8,
              padding: '8px 20px', fontSize: 13, fontWeight: 500,
              cursor: saving || !canSave ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1,
            }}>{saving ? 'Saving…' : saveLabel}</button>
          </div>
        </div>
      </div>

    </div>
  )
}