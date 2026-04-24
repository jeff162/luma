// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

/*
 * FilterBar owns only the local popover UI. The actual filter meaning lives in FilterContext so every page can
 * interpret the same active chips through its own API calls while the user's current slice survives navigation.
 */

import { useState, useRef, useEffect } from 'react'
import { format, subDays, subMonths, subYears, startOfMonth, endOfMonth,
         startOfYear, endOfYear } from 'date-fns'
import { useFilters } from '../lib/FilterContext.jsx'
import { api } from '../lib/api.js'
import { getTxnMerchantLabel } from './TransactionRow.jsx'
import { CategoryMarker } from './ui.jsx'
import { useDismissibleLayer } from '../lib/uiInteractions.js'
import { TagGlyph } from './TagUi.jsx'

const fmt   = d => format(d, 'yyyy-MM-dd')
const today = new Date()

const DATE_PRESETS = [
  { label: 'Month to date', fn: () => ({ start: fmt(startOfMonth(today)), end: fmt(today) }) },
  { label: 'Last month',    fn: () => ({ start: fmt(startOfMonth(subMonths(today,1))), end: fmt(endOfMonth(subMonths(today,1))) }) },
  { label: 'Year to date',  fn: () => ({ start: fmt(startOfYear(today)),  end: fmt(today) }) },
  { label: 'Last year',     fn: () => ({ start: fmt(startOfYear(subYears(today,1))), end: fmt(endOfYear(subYears(today,1))) }) },
  { label: 'Last 30 days',  fn: () => ({ start: fmt(subDays(today, 29)),  end: fmt(today) }) },
  { label: 'Last 60 days',  fn: () => ({ start: fmt(subDays(today, 59)),  end: fmt(today) }) },
  { label: 'Last 90 days',  fn: () => ({ start: fmt(subDays(today, 89)),  end: fmt(today) }) },
]

function dateLabel(date) {
  if (!date) return 'Date'
  return date.preset || `${date.start} → ${date.end}`
}

const inputStyle = {
  background: 'var(--surface2)', color: 'var(--text)',
  border: '1px solid var(--border)', borderRadius: 6,
  padding: '6px 8px', fontSize: 13, outline: 'none',
}

const rowStyle = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '8px 16px', cursor: 'pointer',
}

function Popover({ children, onClose, style }) {
  const ref = useRef(null)
  useDismissibleLayer({
    open: true,
    onClose,
    refs: [ref],
  })
  return (
    <div ref={ref} style={{
      position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 300,
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
      minWidth: 280, ...style,
    }}>
      {children}
    </div>
  )
}

function DatePickerPopover({ onClose }) {
  const { filters, setDate, clearDate } = useFilters()
  const [customStart, setCustomStart] = useState(filters.date?.start || fmt(startOfMonth(today)))
  const [customEnd,   setCustomEnd]   = useState(filters.date?.end   || fmt(today))

  function applyPreset(p) {
    setDate({ ...p.fn(), preset: p.label })
    onClose()
  }

  function applyCustom() {
    const s = customStart < customEnd ? customStart : customEnd
    const e = customStart < customEnd ? customEnd   : customStart
    setDate({ start: s, end: e, preset: null })
    onClose()
  }

  return (
    <Popover onClose={onClose}>
      <div style={{ padding: '6px 0' }}>
        {DATE_PRESETS.map(p => (
          <div key={p.label} onClick={() => applyPreset(p)} style={{
            ...rowStyle,
            background: filters.date?.preset === p.label ? 'var(--surface2)' : 'transparent',
            justifyContent: 'space-between',
          }}>
            <span style={{ fontSize: 13 }}>{p.label}</span>
            {filters.date?.preset === p.label && <span style={{ color: 'var(--accent2)', fontSize: 11 }}>✓</span>}
          </div>
        ))}
      </div>
      <div style={{ borderTop: '1px solid var(--border)', padding: '12px 16px' }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 8,
          textTransform: 'uppercase', letterSpacing: '0.05em' }}>Custom range</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <input type="date" value={customStart} onChange={e => setCustomStart(e.target.value)}
            style={{ flex: 1, ...inputStyle }} />
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>to</span>
          <input type="date" value={customEnd} onChange={e => setCustomEnd(e.target.value)}
            style={{ flex: 1, ...inputStyle }} />
        </div>
        <button onClick={applyCustom} style={{
          width: '100%', background: 'var(--accent)', color: '#fff',
          border: 'none', borderRadius: 6, padding: '7px 0', fontSize: 13, cursor: 'pointer',
        }}>Apply</button>
      </div>
      {filters.date && (
        <div style={{ borderTop: '1px solid var(--border)', padding: '8px 16px' }}>
          <button onClick={() => { clearDate(); onClose() }} style={{
            background: 'none', border: 'none', color: 'var(--danger)',
            cursor: 'pointer', fontSize: 13, padding: 0,
          }}>✕ Clear date filter</button>
        </div>
      )}
    </Popover>
  )
}

const FILTER_TABS = [
  { id: 'accounts',   label: 'Accounts'   },
  { id: 'groups',     label: 'Groups'     },
  { id: 'categories', label: 'Categories' },
  { id: 'tags',       label: 'Tags'       },
  { id: 'owners',     label: 'Owners'     },
  { id: 'payee',      label: 'Payee'      },
]

function FilterPopover({ onClose }) {
  const { filters, addSelection, removeSelection, clearSelections } = useFilters()
  const [tab, setTab]                       = useState('accounts')
  const [categories, setCategories]         = useState([])
  const [accounts, setAccounts]             = useState([])
  const [owners, setOwners]                 = useState([])
  const [tags, setTags]                     = useState([])
  const [payeeSearch, setPayeeSearch]       = useState('')
  const [payeeSuggestions, setPayeeSuggestions] = useState([])

  useEffect(() => {
    api.getCategories().then(setCategories)
    api.getAccounts().then(setAccounts)
    api.getOwners().then(setOwners)
    api.getTags().then(setTags)
  }, [])

  useEffect(() => {
    if (!payeeSearch.trim()) { setPayeeSuggestions([]); return }
    // Payees are derived from real transactions because the app does not keep a separate payee directory in sync.
    api.getTransactions({ search: payeeSearch, limit: 10 }).then(d => {
      const seen = new Set()
      const s = []
      for (const t of d.transactions) {
        const name = getTxnMerchantLabel(t)
        if (name && !seen.has(name)) {
          seen.add(name)
          s.push({ type: 'payee', id: `payee:${name}`, label: name })
        }
      }
      setPayeeSuggestions(s)
    })
  }, [payeeSearch])

  const groups = categories.filter(c => !c.parent_id)
  const leaves = categories.filter(c =>  c.parent_id)
  const isSelected = id => !!filters.selections.find(s => s.id === id)

  function toggle(sel) {
    if (isSelected(sel.id)) removeSelection(sel.id)
    else addSelection(sel)
  }

  return (
    <Popover onClose={onClose} style={{ minWidth: 300 }}>
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)' }}>
        {FILTER_TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            flex: 1, padding: '9px 0', border: 'none', background: 'none',
            fontSize: 12, cursor: 'pointer',
            color: tab === t.id ? 'var(--text)' : 'var(--muted)',
            borderBottom: tab === t.id ? '2px solid var(--accent)' : '2px solid transparent',
            fontWeight: tab === t.id ? 500 : 400,
          }}>{t.label}</button>
        ))}
      </div>

      <div style={{ maxHeight: 300, overflowY: 'auto', padding: '6px 0' }}>

        {tab === 'accounts' && accounts.map(a => {
          const sel = { type: 'account', id: a.id, label: `${a.name}${a.mask ? ` ···${a.mask}` : ''}` }
          return (
            <div key={a.id} onClick={() => toggle(sel)} style={{
              ...rowStyle,
              background: isSelected(a.id) ? 'var(--surface2)' : 'transparent',
              justifyContent: 'space-between',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 16 }}>
                  {a.type === 'credit' ? '💳' : a.type === 'investment' ? '📈' : '🏦'}
                </span>
                <div>
                  <div style={{ fontSize: 13 }}>{a.name}</div>
                  {a.mask && <div style={{ fontSize: 11, color: 'var(--muted)' }}>···{a.mask}</div>}
                </div>
              </div>
              {isSelected(a.id) && <span style={{ color: 'var(--accent2)', fontSize: 11 }}>✓</span>}
            </div>
          )
        })}

        {tab === 'groups' && groups.map(g => {
          const sel = { type: 'group', id: g.id, label: g.name }
          return (
            <div key={g.id} onClick={() => toggle(sel)} style={{
              ...rowStyle,
              background: isSelected(g.id) ? 'var(--surface2)' : 'transparent',
              justifyContent: 'space-between',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <CategoryMarker kind="group" />
                <span style={{ fontSize: 13 }}>{g.name}</span>
              </div>
              {isSelected(g.id) && <span style={{ color: 'var(--accent2)', fontSize: 11 }}>✓</span>}
            </div>
          )
        })}

        {tab === 'categories' && groups.map(g => (
          <div key={g.id}>
            <div style={{ padding: '6px 16px 2px', fontSize: 11, fontWeight: 600,
              color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: 8 }}>
              <CategoryMarker kind="group" />
              <span>{g.name}</span>
            </div>
            {leaves.filter(c => c.parent_id === g.id).map(c => {
              const sel = { type: 'category', id: c.id, label: c.name }
              return (
                <div key={c.id} onClick={() => toggle(sel)} style={{
                  ...rowStyle, paddingLeft: 28,
                  background: isSelected(c.id) ? 'var(--surface2)' : 'transparent',
                  justifyContent: 'space-between',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <CategoryMarker kind="category" />
                    <span style={{ fontSize: 13 }}>{c.name}</span>
                  </div>
                  {isSelected(c.id) && <span style={{ color: 'var(--accent2)', fontSize: 11 }}>✓</span>}
                </div>
              )
            })}
          </div>
        ))}

        {tab === 'owners' && (
          owners.length === 0 ? (
            <div style={{ padding: '12px 16px', fontSize: 13, color: 'var(--muted)' }}>
              No owners defined — add them in Settings.
            </div>
          ) : owners.map(o => {
            const sel = { type: 'owner', id: o.id, label: o.name }
            return (
              <div key={o.id} onClick={() => toggle(sel)} style={{
                ...rowStyle,
                background: isSelected(o.id) ? 'var(--surface2)' : 'transparent',
                justifyContent: 'space-between',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13 }}>{o.name}</span>
                </div>
                {isSelected(o.id) && <span style={{ color: 'var(--accent2)', fontSize: 11 }}>✓</span>}
              </div>
            )
          })
        )}

        {tab === 'tags' && (
          tags.length === 0 ? (
            <div style={{ padding: '12px 16px', fontSize: 13, color: 'var(--muted)' }}>
              No tags yet — create them in Settings.
            </div>
          ) : tags.map(tag => {
            const sel = { type: 'tag', id: tag.id, label: tag.name, color: tag.color }
            return (
              <div key={tag.id} onClick={() => toggle(sel)} style={{
                ...rowStyle,
                background: isSelected(tag.id) ? 'var(--surface2)' : 'transparent',
                justifyContent: 'space-between',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <TagGlyph color={tag.color} size={13} />
                  <span style={{ fontSize: 13 }}>{tag.name}</span>
                </div>
                {isSelected(tag.id) && <span style={{ color: 'var(--accent2)', fontSize: 11 }}>✓</span>}
              </div>
            )
          })
        )}

        {tab === 'payee' && (
          <div style={{ padding: '8px 12px' }}>
            <input
              autoFocus
              value={payeeSearch}
              onChange={e => setPayeeSearch(e.target.value)}
              placeholder="Search payee name…"
              style={{ ...inputStyle, width: '100%', marginBottom: 8 }}
            />
            {payeeSuggestions.map(s => (
              <div key={s.id} onClick={() => { toggle(s); setPayeeSearch('') }} style={{
                ...rowStyle, paddingLeft: 0,
                background: isSelected(s.id) ? 'var(--surface2)' : 'transparent',
                justifyContent: 'space-between',
              }}>
                <span style={{ fontSize: 13 }}>{s.label}</span>
                {isSelected(s.id) && <span style={{ color: 'var(--accent2)', fontSize: 11 }}>✓</span>}
              </div>
            ))}
            {payeeSearch && payeeSuggestions.length === 0 && (
              <div style={{ fontSize: 13, color: 'var(--muted)', padding: '6px 0' }}>No matches</div>
            )}
          </div>
        )}
      </div>

      {filters.selections.length > 0 && (
        <div style={{ borderTop: '1px solid var(--border)', padding: '8px 16px' }}>
          <button onClick={clearSelections} style={{
            background: 'none', border: 'none', color: 'var(--danger)',
            cursor: 'pointer', fontSize: 13, padding: 0,
          }}>✕ Clear all filters</button>
        </div>
      )}
    </Popover>
  )
}

function FilterChip({ sel, onRemove }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '3px 8px', borderRadius: 99, fontSize: 12,
      background: 'color-mix(in srgb, var(--accent) 12%, var(--surface2))',
      border: '1px solid var(--accent)', color: 'var(--accent2)',
      whiteSpace: 'nowrap',
    }}>
      {sel.type === 'tag' ? <TagGlyph color={sel.color} size={12} /> : null}
      {sel.label}
      <button onClick={() => onRemove(sel.id)} style={{
        background: 'none', border: 'none', color: 'var(--accent2)',
        cursor: 'pointer', fontSize: 14, padding: 0, lineHeight: 1,
      }}>×</button>
    </span>
  )
}

function FilterButton({ active, count, children, onClick }) {
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '6px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 13,
      border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
      background: active
        ? 'color-mix(in srgb, var(--accent) 12%, var(--surface2))'
        : 'var(--surface2)',
      color: active ? 'var(--accent2)' : 'var(--muted)',
      fontWeight: active ? 500 : 400,
      whiteSpace: 'nowrap',
    }}>
      {children}
      {count > 0 && (
        <span style={{
          background: 'var(--accent)', color: '#fff',
          borderRadius: 99, fontSize: 11, fontWeight: 600,
          padding: '1px 6px',
        }}>{count}</span>
      )}
    </button>
  )
}

export default function FilterBar() {
  const { filters, removeSelection, clearAll } = useFilters()
  const [showDate,   setShowDate]   = useState(false)
  const [showFilter, setShowFilter] = useState(false)

  const hasDate       = !!filters.date
  const hasSelections = filters.selections.length > 0
  const hasAny        = hasDate || hasSelections

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      padding: '8px 32px', borderBottom: '1px solid var(--border)',
      background: 'var(--surface)', minHeight: 48,
    }}>
      <div style={{ position: 'relative', flexShrink: 0 }}>
        <FilterButton
          active={hasDate}
          onClick={() => { setShowDate(v => !v); setShowFilter(false) }}
        >
          📅 {dateLabel(filters.date)}
        </FilterButton>
        {showDate && <DatePickerPopover onClose={() => setShowDate(false)} />}
      </div>

      <div style={{ position: 'relative', flexShrink: 0 }}>
        <FilterButton
          active={hasSelections}
          count={hasSelections ? filters.selections.length : 0}
          onClick={() => { setShowFilter(v => !v); setShowDate(false) }}
        >
          🔍 Filter
        </FilterButton>
        {showFilter && <FilterPopover onClose={() => setShowFilter(false)} />}
      </div>

      {filters.selections.map(s => (
        <FilterChip key={s.id} sel={s} onRemove={removeSelection} />
      ))}

      {hasAny && (
        <button onClick={clearAll} style={{
          marginLeft: 'auto', background: 'none', border: 'none',
          color: 'var(--muted)', cursor: 'pointer', fontSize: 12, padding: '4px 8px',
          flexShrink: 0,
        }}>Clear all</button>
      )}
    </div>
  )
}
