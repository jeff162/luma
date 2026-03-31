/**
 * FilterBar — Global filter controls, rendered once in App.jsx
 *
 * DESIGN: Two buttons sit at the top of every page. Their state lives in
 * FilterContext (not here) so filters persist across navigation.
 *
 * DATE BUTTON:
 *   Shows "Date" when unset, or the active preset/range label when set.
 *   Highlighted (accent border + tinted background) when active.
 *   Dropdown offers preset ranges (MTD, last month, YTD, etc.) and a custom
 *   date range with two <input type="date"> fields.
 *
 * FILTER BUTTON:
 *   Shows "Filter" with a count badge when selections are active.
 *   Dropdown has four tabs: Accounts, Groups, Categories, Payee.
 *   - Accounts/Groups/Categories: toggle items on/off, ✓ marks selected
 *   - Payee: live search against actual transactions via api.getTransactions()
 *   Multiple items across multiple tabs can be selected simultaneously.
 *
 * CHIPS:
 *   Active filter selections render as dismissible chips in the bar so the
 *   user can see and remove individual filters without opening the dropdown.
 *   A "Clear all" button appears on the right when anything is active.
 *
 * POPOVER PATTERN:
 *   Each button tracks its own open/close state. Opening one closes the other.
 *   Popovers close on outside click via a mousedown listener on document.
 *   Popovers use position:absolute relative to their trigger button so they
 *   stay anchored correctly regardless of scroll position.
 *
 * EXTENDING:
 *   To add a new filter type (e.g. amount range):
 *   1. Add a tab to FilterPopover with the appropriate UI
 *   2. Add the selection type to FilterContext selections array
 *   3. Handle the new type in each page's API call construction
 */

import { useState, useRef, useEffect } from 'react'
import { format, subDays, subMonths, subYears, startOfMonth, endOfMonth,
         startOfYear, endOfYear } from 'date-fns'
import { useFilters } from '../lib/FilterContext.jsx'
import { api } from '../lib/api.js'
import { getTxnMerchantLabel } from './TransactionRow.jsx'
import { CategoryMarker } from './ui.jsx'

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
  useEffect(() => {
    function h(e) { if (ref.current && !ref.current.contains(e.target)) onClose() }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [onClose])
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
  { id: 'owners',     label: 'Owners'     },
  { id: 'payee',      label: 'Payee'      },
]

function FilterPopover({ onClose }) {
  const { filters, addSelection, removeSelection, clearSelections } = useFilters()
  const [tab, setTab]                       = useState('accounts')
  const [categories, setCategories]         = useState([])
  const [accounts, setAccounts]             = useState([])
  const [owners, setOwners]                 = useState([])
  const [payeeSearch, setPayeeSearch]       = useState('')
  const [payeeSuggestions, setPayeeSuggestions] = useState([])

  useEffect(() => {
    api.getCategories().then(setCategories)
    api.getAccounts().then(setAccounts)
    api.getOwners().then(setOwners)
  }, [])

  useEffect(() => {
    if (!payeeSearch.trim()) { setPayeeSuggestions([]); return }
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
      {/* Tabs */}
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

        {/* Accounts */}
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

        {/* Groups */}
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

        {/* Categories */}
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

        {/* Owners */}
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

        {/* Payee */}
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
      {/* Date button — left side */}
      <div style={{ position: 'relative', flexShrink: 0 }}>
        <FilterButton
          active={hasDate}
          onClick={() => { setShowDate(v => !v); setShowFilter(false) }}
        >
          📅 {dateLabel(filters.date)}
        </FilterButton>
        {showDate && <DatePickerPopover onClose={() => setShowDate(false)} />}
      </div>

      {/* Filter button */}
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

      {/* Active chips */}
      {filters.selections.map(s => (
        <FilterChip key={s.id} sel={s} onRemove={removeSelection} />
      ))}

      {/* Clear all — right side */}
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
