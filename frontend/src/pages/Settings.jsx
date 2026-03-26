/**
 * Settings.jsx — Owner management
 *
 * Three sections on one page:
 *
 * 1. OWNERS — Create / rename / recolor / delete named owners (e.g. Alice, Bob, Shared).
 *    Deleting an owner NULLs out owner_id on all related accounts, categories, and
 *    transactions (handled server-side via ON DELETE SET NULL).
 *
 * 2. ACCOUNTS → OWNER — Assign each linked account to an owner. Changing an account's
 *    owner propagates to all its transactions immediately (backend PATCH /accounts/:id
 *    writes owner_id onto every txn for that account).
 *
 * 3. CATEGORY GROUPS → OWNER — Tag each spending group (Food & Drink, Transportation,
 *    etc.) with an owner to indicate whose domain it belongs to. This drives the
 *    Dashboard split-by-owner view: "Shared" groups appear in both columns, personal
 *    groups appear only in that person's column.
 *    Leaf categories silently inherit the group's owner (stored in DB, not shown here).
 */

import { useState, useEffect, useRef } from 'react'
import { api } from '../lib/api.js'
import { refreshTaskBadge } from '../App.jsx'
import { Card, PageHeader, Button, Spinner, EmptyState } from '../components/ui.jsx'

// ── Small reusable owner badge ────────────────────────────────────────────────

function OwnerDot({ name }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      {name && <span style={{ fontSize: 13, color: 'var(--text)' }}>{name}</span>}
    </span>
  )
}

// ── Owner CRUD ────────────────────────────────────────────────────────────────

function OwnerRow({ owner, onSave, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [name, setName]       = useState(owner.name)

  async function save() {
    if (!name.trim()) return
    await onSave(owner.id, { name: name.trim() })
    setEditing(false)
  }

  function cancel() {
    setName(owner.name)
    setEditing(false)
  }

  if (!editing) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '10px 16px', borderBottom: '1px solid var(--border)',
      }}>
        <OwnerDot name={owner.name} />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button onClick={() => setEditing(true)} style={{
            background: 'none', color: 'var(--muted)',
            cursor: 'pointer', fontSize: 12, padding: '2px 8px',
            borderRadius: 4, border: '1px solid var(--border)',
          }}>Edit</button>
          <button onClick={() => onDelete(owner.id)} style={{
            background: 'none', color: 'var(--danger)',
            cursor: 'pointer', fontSize: 13, padding: '2px 8px',
            borderRadius: 4, border: '1px solid transparent',
          }}>×</button>
        </div>
      </div>
    )
  }

  return (
    <div style={{
      padding: '12px 16px', borderBottom: '1px solid var(--border)',
      background: 'var(--surface2)', display: 'flex', gap: 10, alignItems: 'center',
    }}>
      <input
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel() }}
        autoFocus
        style={{
          flex: 1, background: 'var(--surface)', color: 'var(--text)',
          border: '1px solid var(--accent)', borderRadius: 6,
          padding: '7px 10px', fontSize: 13, outline: 'none',
        }}
      />
      <Button small onClick={save} disabled={!name.trim()}>Save</Button>
      <Button small variant="ghost" onClick={cancel}>Cancel</Button>
    </div>
  )
}

function AddOwnerForm({ onAdd, onCancel }) {
  const [name, setName]   = useState('')

  async function handleAdd() {
    if (!name.trim()) return
    await onAdd({ name: name.trim() })
    setName('')
  }

  return (
    <div style={{
      padding: '12px 16px', background: 'var(--surface2)',
      borderBottom: '2px solid var(--border)',
      display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
    }}>
      <input
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') handleAdd() }}
        autoFocus
        placeholder="Owner name (e.g. Alice, Bob, Shared)"
        style={{
          flex: 1, minWidth: 160, background: 'var(--surface)', color: 'var(--text)',
          border: '1px solid var(--accent)', borderRadius: 6,
          padding: '7px 10px', fontSize: 13, outline: 'none',
        }}
      />
      <Button small onClick={handleAdd} disabled={!name.trim()}>Add owner</Button>
      <Button small variant="ghost" onClick={onCancel}>Cancel</Button>
    </div>
  )
}

// ── Owner select dropdown (shared by account and category rows) ───────────────

function OwnerSelect({ value, owners, onChange, placeholder = 'Unassigned' }) {
  return (
    <select
      value={value || ''}
      onChange={e => onChange(e.target.value || null)}
      style={{
        background: 'var(--surface2)', color: 'var(--text)',
        border: '1px solid var(--border)', borderRadius: 6,
        padding: '5px 8px', fontSize: 13, cursor: 'pointer',
        minWidth: 130,
      }}
    >
      <option value="">— {placeholder} —</option>
      {owners.map(o => (
        <option key={o.id} value={o.id}>{o.name}</option>
      ))}
    </select>
  )
}

// ── Custom owner dropdown — opens immediately without a 3rd click ─────────────
// Renders as an absolutely-positioned list that closes on outside-click or
// on any selection. Used instead of <select> so the 2nd click opens it directly.

function OwnerDropdown({ value, owners, onSelect, onClose }) {
  const ref = useRef(null)

  useEffect(() => {
    function handler(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    // Use mousedown so the click that opened us doesn't immediately close us
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  const options = [{ id: '', name: '— Unassigned —' }, ...owners]

  return (
    <div ref={ref} style={{
      position: 'absolute', top: 0, left: 0, zIndex: 200,
      background: 'var(--surface)', border: '1px solid var(--accent)',
      borderRadius: 8, boxShadow: '0 4px 20px rgba(0,0,0,0.25)',
      minWidth: 160, overflow: 'hidden',
    }}>
      {options.map(o => (
        <div
          key={o.id}
          onMouseDown={e => { e.stopPropagation(); onSelect(o.id || null) }}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '8px 12px', fontSize: 13, cursor: 'pointer',
            background: o.id === (value || '') ? 'color-mix(in srgb, var(--accent) 12%, var(--surface2))' : 'transparent',
            color: o.id ? 'var(--text)' : 'var(--muted)',
          }}
          onMouseEnter={e => e.currentTarget.style.background = 'var(--surface2)'}
          onMouseLeave={e => e.currentTarget.style.background = o.id === (value || '') ? 'color-mix(in srgb, var(--accent) 12%, var(--surface2))' : 'transparent'}
        >
          {o.name}
        </div>
      ))}
    </div>
  )
}

// ── Account assignment ────────────────────────────────────────────────────────
// UX: first click selects the row (highlights it), second click on a field edits it.
// Name is always editable (display name can differ from underlying account name).
// Owner opens a dropdown on click of the owner cell.

function AccountRow({ account, owners, selected, onSelect, onRename, onAssign }) {
  const [editingName,  setEditingName]  = useState(false)
  const [editingOwner, setEditingOwner] = useState(false)
  const [nameDraft,    setNameDraft]    = useState(account.name)
  const ownerObj = owners.find(o => o.id === account.owner_id)

  function handleRowClick(e) {
    if (e.target.tagName === 'INPUT') return
    if (!selected) {
      onSelect(account.id)
    }
  }

  function handleNameClick(e) {
    e.stopPropagation()
    if (!selected) { onSelect(account.id); return }
    setEditingName(true)
    setNameDraft(account.name)
  }

  function handleOwnerClick(e) {
    e.stopPropagation()
    if (!selected) { onSelect(account.id); return }
    setEditingOwner(true)
  }

  async function commitName() {
    setEditingName(false)
    const trimmed = nameDraft.trim()
    if (trimmed && trimmed !== account.name) {
      await api.updateAccount(account.id, { name: trimmed })
      onRename(account.id, trimmed)
    }
  }

  async function commitOwner(ownerId) {
    setEditingOwner(false)
    await onAssign(account.id, ownerId || null)
  }

  const isUnowned = !account.owner_id

  return (
    <div
      onClick={handleRowClick}
      style={{
        display: 'grid', gridTemplateColumns: '1fr 110px 170px',
        padding: '9px 16px', alignItems: 'center',
        borderBottom: '1px solid var(--border)',
        background: selected
          ? 'color-mix(in srgb, var(--accent) 8%, var(--surface2))'
          : isUnowned
            ? 'color-mix(in srgb, #f59e0b 4%, transparent)'
            : 'transparent',
        cursor: selected ? 'default' : 'pointer',
        outline: selected ? `1px solid var(--accent)` : 'none',
        outlineOffset: -1,
      }}
    >
      {/* Name cell */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        {editingName ? (
          <input
            autoFocus
            value={nameDraft}
            onChange={e => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={e => {
              if (e.key === 'Enter') commitName()
              if (e.key === 'Escape') { setEditingName(false); setNameDraft(account.name) }
              e.stopPropagation()
            }}
            onClick={e => e.stopPropagation()}
            style={{
              flex: 1, background: 'var(--surface)', color: 'var(--text)',
              border: '1px solid var(--accent)', borderRadius: 6,
              padding: '3px 8px', fontSize: 13, outline: 'none',
            }}
          />
        ) : (
          <div
            onClick={handleNameClick}
            title={selected ? 'Click to edit name' : 'Click to select'}
            style={{ minWidth: 0 }}
          >
            <div style={{
              fontSize: 13, fontWeight: 500,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              textDecoration: selected ? 'underline dotted var(--muted)' : 'none',
              cursor: selected ? 'text' : 'pointer',
            }}>
              {account.name}
            </div>
            {account.mask && (
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>···{account.mask}</div>
            )}
          </div>
        )}
        {isUnowned && !selected && (
          <span style={{ fontSize: 11, color: '#f59e0b', fontWeight: 500, flexShrink: 0 }}>⚠</span>
        )}
      </div>

      {/* Type cell */}
      <span style={{ fontSize: 12, color: 'var(--muted)', textTransform: 'capitalize' }}>
        {account.subtype || account.type || '—'}
      </span>

      {/* Owner cell — custom dropdown so it opens on the 2nd click without a 3rd */}
      <div onClick={handleOwnerClick} style={{ position: 'relative', cursor: selected ? 'pointer' : 'default' }}>
        {editingOwner ? (
          <OwnerDropdown
            value={account.owner_id}
            owners={owners}
            onSelect={ownerId => commitOwner(ownerId)}
            onClose={() => setEditingOwner(false)}
          />
        ) : (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '4px 8px', borderRadius: 6, fontSize: 13,
            border: selected ? '1px solid var(--border)' : '1px solid transparent',
            background: selected ? 'var(--surface2)' : 'transparent',
            color: ownerObj ? 'var(--text)' : 'var(--muted)',
          }}>
            {ownerObj ? ownerObj.name : <span style={{ opacity: 0.5 }}>Unassigned</span>}
            {selected && <span style={{ marginLeft: 'auto', opacity: 0.4, fontSize: 11 }}>▾</span>}
          </div>
        )}
      </div>
    </div>
  )
}

function AccountAssignment({ owners }) {
  const [accounts,    setAccounts]    = useState([])
  const [selectedId,  setSelectedId]  = useState(null)

  useEffect(() => { api.getAccounts().then(setAccounts) }, [])

  // Deselect when clicking outside
  useEffect(() => {
    function handler(e) {
      if (!e.target.closest('[data-account-table]')) setSelectedId(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  function renameAccount(accountId, name) {
    setAccounts(prev => prev.map(a => a.id === accountId ? { ...a, name } : a))
  }

  async function assignOwner(accountId, ownerId) {
    await api.updateAccount(accountId, { owner_id: ownerId || '' })
    refreshTaskBadge()
    const ownerObj = owners.find(o => o.id === ownerId)
    setAccounts(prev => prev.map(a =>
      a.id === accountId
        ? { ...a, owner_id: ownerId ?? null,
            owner_name:  ownerObj?.name  ?? null,
            owner_color: ownerObj?.color ?? null,
          }
        : a
    ))
  }

  if (accounts.length === 0) return <EmptyState message="No accounts linked yet — connect one on the Accounts page" />

  const unownedCount = accounts.filter(a => !a.owner_id).length

  return (
    <>
      {unownedCount > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '10px 16px',
          background: 'color-mix(in srgb, var(--warning, #f59e0b) 10%, var(--surface2))',
          borderBottom: '1px solid var(--border)', fontSize: 13,
        }}>
          <span>⚠️</span>
          <span>
            {unownedCount} account{unownedCount > 1 ? 's' : ''} without an owner.
            Assign each below — use <strong>Shared</strong> for joint accounts.
          </span>
        </div>
      )}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 110px 170px',
        padding: '7px 16px', fontSize: 11, fontWeight: 600,
        color: 'var(--muted)', textTransform: 'uppercase',
        letterSpacing: '0.05em', borderBottom: '1px solid var(--border)',
        background: 'var(--surface2)',
      }}>
        <span>Account</span><span>Type</span><span>Owner</span>
      </div>
      <div data-account-table>
        {accounts.map(a => (
          <AccountRow
            key={a.id}
            account={a}
            owners={owners}
            selected={selectedId === a.id}
            onSelect={setSelectedId}
            onRename={renameAccount}
            onAssign={assignOwner}
          />
        ))}
      </div>
      {selectedId && (
        <div style={{ padding: '6px 16px', fontSize: 11, color: 'var(--muted)', borderTop: '1px solid var(--border)' }}>
          Click the name to rename · click the owner to change assignment · click elsewhere to deselect
        </div>
      )}
    </>
  )
}

// ── Category group assignment ─────────────────────────────────────────────────

function GroupOwnerCell({ group, owners, onAssign }) {
  const [editing, setEditing] = useState(false)
  const ownerObj = owners.find(o => o.id === group.owner_id)

  async function handleChange(ownerId) {
    setEditing(false)
    await onAssign(group.id, ownerId || null)
  }

  if (editing) {
    // For categories, null owner_id means "Shared" (shown in both Dashboard columns).
    // Filter out any owner literally named "Shared" to avoid it appearing twice —
    // the "— Shared —" option at the top already represents that state.
    const categoryOwners = owners.filter(o => o.name.toLowerCase() !== 'shared')
    return (
      <select
        autoFocus
        value={group.owner_id || ''}
        onChange={e => handleChange(e.target.value || null)}
        onBlur={() => setEditing(false)}
        style={{
          background: 'var(--surface2)', color: 'var(--text)',
          border: '1px solid var(--accent)', borderRadius: 6,
          padding: '5px 8px', fontSize: 13, cursor: 'pointer',
          width: '100%',
        }}
      >
        <option value="">— Shared —</option>
        {categoryOwners.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    )
  }

  return (
    <button
      onClick={() => setEditing(true)}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        background: 'none', border: '1px solid var(--border)',
        borderRadius: 6, padding: '4px 10px', cursor: 'pointer',
        fontSize: 13, color: ownerObj ? 'var(--text)' : 'var(--muted)',
        width: '100%', textAlign: 'left',
      }}
    >
      {ownerObj ? ownerObj.name : <span style={{ opacity: 0.5 }}>Shared</span>}
      <span style={{ marginLeft: 'auto', opacity: 0.4, fontSize: 11 }}>▾</span>
    </button>
  )
}

function CategoryGroupAssignment({ owners }) {
  const [categories, setCategories] = useState([])

  useEffect(() => { api.getCategories().then(setCategories) }, [])

  const groups = categories.filter(c => !c.parent_id)

  async function assignOwner(groupId, ownerId) {
    await api.updateCategory(groupId, { owner_id: ownerId || null })
    const leaves = categories.filter(c => c.parent_id === groupId)
    await Promise.all(leaves.map(c => api.updateCategory(c.id, { owner_id: ownerId || null })))
    const ownerObj = owners.find(o => o.id === ownerId)
    setCategories(prev => prev.map(c => {
      if (c.id === groupId || c.parent_id === groupId) {
        return { ...c, owner_id: ownerId ?? null,
          owner_name:  ownerObj?.name  ?? null,
          owner_color: ownerObj?.color ?? null,
        }
      }
      return c
    }))
  }

  if (groups.length === 0) return <Spinner />

  return (
    <>
      <div style={{
        padding: '8px 16px 6px', fontSize: 12, color: 'var(--muted)',
        borderBottom: '1px solid var(--border)',
      }}>
        Tag each spending group with an owner. "Shared" groups appear in both columns
        of the Dashboard split view; personal groups appear only under that person.
        Leaf categories silently inherit the group's owner.
      </div>
      <div style={{
        display: 'grid', gridTemplateColumns: '40px 1fr 160px',
        padding: '8px 16px', fontSize: 11, fontWeight: 600,
        color: 'var(--muted)', textTransform: 'uppercase',
        letterSpacing: '0.05em', borderBottom: '1px solid var(--border)',
      }}>
        <span></span><span>Group</span><span>Owner</span>
      </div>
      {groups.map(g => (
        <div key={g.id} style={{
          display: 'grid', gridTemplateColumns: '40px 1fr 160px',
          padding: '10px 16px', alignItems: 'center',
          borderBottom: '1px solid var(--border)',
        }}>
          <span style={{ fontSize: 18 }}>{g.icon}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14 }}>{g.name}</span>
          </div>
          <GroupOwnerCell group={g} owners={owners} onAssign={assignOwner} />
        </div>
      ))}
    </>
  )
}

// ── Import profiles section ───────────────────────────────────────────────────

const AMOUNT_CONVENTIONS = [
  { value: 'single_signed',   label: 'Single column — negative = debit' },
  { value: 'single_unsigned', label: 'Single column — always positive + direction column' },
  { value: 'two_column',      label: 'Two columns — separate debit / credit' },
]

const DATE_FORMATS = [
  { value: '%m/%d/%Y', label: 'MM/DD/YYYY' },
  { value: '%Y-%m-%d', label: 'YYYY-MM-DD' },
  { value: '%d/%m/%Y', label: 'DD/MM/YYYY' },
  { value: '%m-%d-%Y', label: 'MM-DD-YYYY' },
  { value: '%b %d, %Y', label: 'Mon DD, YYYY' },
]

function ProfileForm({ profile, accounts, onSave, onCancel }) {
  const isNew = !profile?.id
  const [name,       setName]       = useState(profile?.name || '')
  const [filePattern,setFilePattern]= useState(profile?.filename_pattern || '')
  const [headerFp,   setHeaderFp]   = useState(profile?.header_fingerprint || '')
  const [accountId,  setAccountId]  = useState(profile?.account_id || '')
  const [dateFormat, setDateFormat] = useState(profile?.date_format || '%m/%d/%Y')
  const [amtConv,    setAmtConv]    = useState(profile?.amount_convention || 'single_signed')
  const [skipRows,   setSkipRows]   = useState(profile?.skip_rows ?? 0)
  const [applyCat,   setApplyCat]   = useState(profile?.apply_categorization !== false)
  const [notes,      setNotes]      = useState(profile?.notes || '')
  // Column map fields
  const cm = profile?.column_map || {}
  const [colDate,   setColDate]   = useState(cm.date || '')
  const [colAmount, setColAmount] = useState(cm.amount || '')
  const [colDebit,  setColDebit]  = useState(cm.debit || '')
  const [colCredit, setColCredit] = useState(cm.credit || '')
  const [colDir,    setColDir]    = useState(cm.direction || '')
  const [colDesc,   setColDesc]   = useState(cm.description || '')
  const [colNotes,  setColNotes]  = useState(cm.notes || '')

  const inputStyle = {
    background: 'var(--surface)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: 6,
    padding: '6px 10px', fontSize: 13, width: '100%', outline: 'none',
  }
  const selStyle = { ...inputStyle, cursor: 'pointer' }

  function handleSave() {
    if (!name.trim() || !colDate.trim() || !colDesc.trim()) return
    const column_map = {
      date: colDate, description: colDesc,
      ...(amtConv === 'two_column'
        ? { debit: colDebit, credit: colCredit }
        : { amount: colAmount }),
      ...(amtConv === 'single_unsigned' && colDir ? { direction: colDir } : {}),
      ...(colNotes ? { notes: colNotes } : {}),
    }
    onSave({
      name: name.trim(),
      filename_pattern:   filePattern.trim() || null,
      header_fingerprint: headerFp.trim()    || null,
      column_map, account_id: accountId || null,
      date_format: dateFormat, amount_convention: amtConv,
      skip_rows: parseInt(skipRows) || 0,
      apply_categorization: applyCat,
      notes: notes.trim() || null,
    })
  }

  return (
    <div style={{
      padding: '16px', background: 'var(--surface2)',
      borderBottom: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)' }}>
        {isNew ? 'New import profile' : `Edit: ${profile.name}`}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 3 }}>
            Profile name *
          </label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Chase Checking" style={inputStyle} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 3 }}>
            Default account
          </label>
          <select value={accountId} onChange={e => setAccountId(e.target.value)} style={selStyle}>
            <option value="">— None —</option>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.name}{a.mask ? ` ···${a.mask}` : ''}</option>)}
          </select>
        </div>
        <div>
          <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 3 }}>
            Filename pattern (auto-detect)
          </label>
          <input value={filePattern} onChange={e => setFilePattern(e.target.value)}
            placeholder="e.g. Chase" style={inputStyle} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 3 }}>
            Header fingerprint (auto-detect)
          </label>
          <input value={headerFp} onChange={e => setHeaderFp(e.target.value)}
            placeholder="Paste header row from CSV" style={inputStyle} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 3 }}>Date format</label>
          <select value={dateFormat} onChange={e => setDateFormat(e.target.value)} style={selStyle}>
            {DATE_FORMATS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </div>
        <div>
          <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 3 }}>Amount convention</label>
          <select value={amtConv} onChange={e => setAmtConv(e.target.value)} style={selStyle}>
            {AMOUNT_CONVENTIONS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </div>
      </div>

      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginTop: 4 }}>
        Column names (enter the exact column header from the CSV)
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
        <div>
          <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 3 }}>Date column *</label>
          <input value={colDate} onChange={e => setColDate(e.target.value)} placeholder="e.g. Transaction Date" style={inputStyle} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 3 }}>Description column *</label>
          <input value={colDesc} onChange={e => setColDesc(e.target.value)} placeholder="e.g. Description" style={inputStyle} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 3 }}>Notes column</label>
          <input value={colNotes} onChange={e => setColNotes(e.target.value)} placeholder="optional" style={inputStyle} />
        </div>
        {amtConv === 'two_column' ? (
          <>
            <div>
              <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 3 }}>Debit column *</label>
              <input value={colDebit} onChange={e => setColDebit(e.target.value)} placeholder="e.g. Debit" style={inputStyle} />
            </div>
            <div>
              <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 3 }}>Credit column *</label>
              <input value={colCredit} onChange={e => setColCredit(e.target.value)} placeholder="e.g. Credit" style={inputStyle} />
            </div>
          </>
        ) : (
          <div>
            <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 3 }}>Amount column *</label>
            <input value={colAmount} onChange={e => setColAmount(e.target.value)} placeholder="e.g. Amount" style={inputStyle} />
          </div>
        )}
        {amtConv === 'single_unsigned' && (
          <div>
            <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 3 }}>Direction column</label>
            <input value={colDir} onChange={e => setColDir(e.target.value)} placeholder="e.g. Type" style={inputStyle} />
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={applyCat} onChange={e => setApplyCat(e.target.checked)} />
          Apply categorization rules by default
        </label>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <Button small onClick={handleSave} disabled={!name.trim() || !colDate.trim() || !colDesc.trim()}>
            {isNew ? 'Create profile' : 'Save changes'}
          </Button>
          <Button small variant="ghost" onClick={onCancel}>Cancel</Button>
        </div>
      </div>
    </div>
  )
}

function ImportProfilesSection() {
  const [profiles,  setProfiles]  = useState([])
  const [accounts,  setAccounts]  = useState([])
  const [loading,   setLoading]   = useState(true)
  const [showAdd,   setShowAdd]   = useState(false)
  const [editId,    setEditId]    = useState(null)

  useEffect(() => {
    Promise.all([api.getImportProfiles(), api.getAccounts()]).then(([p, a]) => {
      setProfiles(p); setAccounts(a); setLoading(false)
    })
  }, [])

  async function handleSave(data) {
    if (editId) {
      await api.updateImportProfile(editId, data)
      setEditId(null)
    } else {
      await api.createImportProfile(data)
      setShowAdd(false)
    }
    api.getImportProfiles().then(setProfiles)
  }

  async function handleDelete(id) {
    if (!confirm('Delete this import profile?')) return
    await api.deleteImportProfile(id)
    setProfiles(prev => prev.filter(p => p.id !== id))
  }

  const amtLabel = v => AMOUNT_CONVENTIONS.find(c => c.value === v)?.label.split(' — ')[0] || v

  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      {showAdd && (
        <ProfileForm accounts={accounts} onSave={handleSave} onCancel={() => setShowAdd(false)} />
      )}

      {loading ? <Spinner /> : profiles.length === 0 && !showAdd ? (
        <div style={{ padding: '20px 16px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
          No import profiles yet.
          <button onClick={() => setShowAdd(true)} style={{
            marginLeft: 8, background: 'var(--accent)', color: '#fff',
            border: 'none', borderRadius: 6, padding: '5px 12px', fontSize: 13, cursor: 'pointer',
          }}>+ Create first profile</button>
        </div>
      ) : (
        <>
          {profiles.map(p => (
            <div key={p.id}>
              {editId === p.id ? (
                <ProfileForm profile={p} accounts={accounts} onSave={handleSave} onCancel={() => setEditId(null)} />
              ) : (
                <div style={{
                  display: 'grid', gridTemplateColumns: '1fr 140px 130px 100px',
                  padding: '10px 16px', alignItems: 'center', fontSize: 13,
                  borderBottom: '1px solid var(--border)',
                }}>
                  <div>
                    <div style={{ fontWeight: 500 }}>{p.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                      {p.filename_pattern && <span>📁 {p.filename_pattern} · </span>}
                      {p.account_name && <span>🏦 {p.account_name}</span>}
                    </div>
                  </div>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>{p.date_format}</span>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>{amtLabel(p.amount_convention)}</span>
                  <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                    <button onClick={() => setEditId(p.id)} style={{
                      background: 'none', border: '1px solid var(--border)',
                      borderRadius: 6, color: 'var(--muted)', cursor: 'pointer',
                      fontSize: 12, padding: '3px 8px',
                    }}>Edit</button>
                    <button onClick={() => handleDelete(p.id)} style={{
                      background: 'none', border: 'none',
                      color: 'var(--danger)', cursor: 'pointer', fontSize: 14, padding: '2px 6px',
                    }}>×</button>
                  </div>
                </div>
              )}
            </div>
          ))}
          {!showAdd && (
            <div
              onClick={() => setShowAdd(true)}
              style={{
                padding: '10px 16px', textAlign: 'center', cursor: 'pointer',
                fontSize: 13, color: 'var(--muted)', borderTop: '1px solid var(--border)',
              }}
            >+ New profile</div>
          )}
        </>
      )}
    </Card>
  )
}

// ── Main Settings page ────────────────────────────────────────────────────────

function AuthModeSection({ authEnabled, onEnabled }) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  if (authEnabled) return null

  async function enableAuthMode() {
    setSaving(true)
    setError('')
    try {
      const resp = await api.enableAuth()
      onEnabled?.(resp)
      window.location.reload()
    } catch (err) {
      setError(err.message || 'Failed to enable sign-in protection')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Sign-in protection</div>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14 }}>
        This instance is currently running in local single-user mode without login. Enable sign-in protection when you want user accounts, 2FA, or separate tenant workspaces.
      </div>

      <Card style={{ padding: 20 }}>
        <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
          Turning this on switches FinTrack into authenticated mode. You&apos;ll then create the first user account and use that account to manage any additional users.
        </div>
        <div style={{ marginTop: 14 }}>
          <Button small onClick={enableAuthMode} disabled={saving}>
            {saving ? 'Enabling...' : 'Enable sign-in protection'}
          </Button>
        </div>
        {error && (
          <div style={{ marginTop: 12, color: '#ef4444', fontSize: 13 }}>
            {error}
          </div>
        )}
      </Card>
    </div>
  )
}

function UserAdminSection() {
  const [viewer, setViewer] = useState(null)
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({
    username: '',
    display_name: '',
    password: '',
    role: 'member',
  })

  async function load() {
    setLoading(true)
    try {
      const me = await api.getCurrentUser()
      setViewer(me.user)
      if (me.user.role === 'admin') {
        const resp = await api.listUsers()
        setUsers(resp.users)
      }
      setError('')
    } catch (err) {
      setError(err.message || 'Failed to load user management')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function handleCreate(e) {
    e.preventDefault()
    setCreating(true)
    setError('')
    try {
      await api.createUser(form)
      setForm({ username: '', display_name: '', password: '', role: 'member' })
      await load()
    } catch (err) {
      setError(err.message || 'Failed to create user')
    } finally {
      setCreating(false)
    }
  }

  if (loading) return <Spinner />
  if (!viewer || viewer.role !== 'admin') return null

  const inputStyle = {
    background: 'var(--surface)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: 6,
    padding: '7px 10px', fontSize: 13, width: '100%', outline: 'none',
  }

  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>User management</div>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14 }}>
        Create additional independent FinTrack users. Each one receives a separate tenant database.
      </div>

      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface2)' }}>
          <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
            Each created user gets an independent tenant database. This keeps financial data isolated without rewriting the core finance schema into a shared multi-tenant table model.
          </div>
        </div>

        <form onSubmit={handleCreate} style={{ padding: 16, borderBottom: '1px solid var(--border)', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 120px auto', gap: 10, alignItems: 'end' }}>
          <div>
            <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Username</label>
            <input value={form.username} onChange={e => setForm(prev => ({ ...prev, username: e.target.value }))} style={inputStyle} />
          </div>
          <div>
            <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Display name</label>
            <input value={form.display_name} onChange={e => setForm(prev => ({ ...prev, display_name: e.target.value }))} style={inputStyle} />
          </div>
          <div>
            <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Password</label>
            <input type="password" value={form.password} onChange={e => setForm(prev => ({ ...prev, password: e.target.value }))} style={inputStyle} />
          </div>
          <div>
            <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Role</label>
            <select value={form.role} onChange={e => setForm(prev => ({ ...prev, role: e.target.value }))} style={{ ...inputStyle, cursor: 'pointer' }}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <Button small type="submit" disabled={creating || !form.username.trim() || form.password.length < 8}>
            {creating ? 'Creating...' : 'Add user'}
          </Button>
        </form>

        {error && (
          <div style={{ padding: '10px 16px', color: '#ef4444', fontSize: 13, borderBottom: '1px solid var(--border)' }}>
            {error}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr 120px 1fr 1fr', padding: '8px 16px', fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid var(--border)' }}>
          <span>User</span><span>Tenant</span><span>Role</span><span>Status</span><span>Last login</span>
        </div>
        {users.map(user => (
          <div key={user.id} style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr 120px 1fr 1fr', padding: '10px 16px', fontSize: 13, borderBottom: '1px solid var(--border)', alignItems: 'center' }}>
            <div>
              <div style={{ fontWeight: 500 }}>{user.display_name || user.username}</div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>{user.username}</div>
            </div>
            <span>{user.tenant_name}</span>
            <span style={{ textTransform: 'capitalize' }}>{user.role}</span>
            <span style={{ textTransform: 'capitalize' }}>{user.status}</span>
            <span style={{ color: 'var(--muted)' }}>{user.last_login_at || 'Never'}</span>
          </div>
        ))}
      </Card>
    </div>
  )
}

function SecuritySection() {
  const [currentUser, setCurrentUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [setup, setSetup] = useState(null)
  const [setupCode, setSetupCode] = useState('')
  const [disableCode, setDisableCode] = useState('')
  const [regenCode, setRegenCode] = useState('')
  const [recoveryCodes, setRecoveryCodes] = useState([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function load() {
    setLoading(true)
    try {
      const resp = await api.getCurrentUser()
      setCurrentUser(resp.user)
      setError('')
    } catch (err) {
      setError(err.message || 'Failed to load security settings')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function beginSetup() {
    setSaving(true)
    setError('')
    try {
      const resp = await api.startTwoFactorSetup()
      setSetup(resp)
      setSetupCode('')
    } catch (err) {
      setError(err.message || 'Failed to start authenticator setup')
    } finally {
      setSaving(false)
    }
  }

  async function confirmSetup(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      const resp = await api.confirmTwoFactorSetup(setup.secret, setupCode)
      setCurrentUser(resp.user)
      setRecoveryCodes(resp.recovery_codes || [])
      setSetup(null)
      setSetupCode('')
    } catch (err) {
      setError(err.message || 'Failed to enable authenticator app')
    } finally {
      setSaving(false)
    }
  }

  async function turnOff2fa(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      const resp = await api.disableTwoFactor(disableCode)
      setCurrentUser(resp.user)
      setDisableCode('')
    } catch (err) {
      setError(err.message || 'Failed to disable authenticator app')
    } finally {
      setSaving(false)
    }
  }

  async function regenerateCodes(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      const resp = await api.regenerateRecoveryCodes(regenCode)
      setCurrentUser(resp.user)
      setRecoveryCodes(resp.recovery_codes || [])
      setRegenCode('')
    } catch (err) {
      setError(err.message || 'Failed to regenerate recovery codes')
    } finally {
      setSaving(false)
    }
  }

  async function setPrivacyMode(nextMode) {
    setSaving(true)
    setError('')
    try {
      const resp = await api.setPrivacyMode(nextMode)
      setCurrentUser(resp.user)
    } catch (err) {
      setError(err.message || 'Failed to update privacy mode')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <Spinner />
  if (!currentUser) return null

  const inputStyle = {
    background: 'var(--surface)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: 6,
    padding: '7px 10px', fontSize: 13, width: '100%', outline: 'none',
  }

  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Security</div>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14 }}>
        Protect your account with an authenticator app using standard 6-digit TOTP codes.
      </div>

      <Card style={{ padding: 20 }}>
        <div style={{ display: 'grid', gap: 12, padding: 14, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface2)', marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>Sensitive token protection</div>
              <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
                Optional protection for Plaid access tokens at rest. Local single-user installs usually do not need this if the machine is already encrypted.
              </div>
              <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6 }}>
                Status: {currentUser.privacy_mode === 'server_managed' ? 'Server-managed protection enabled' : 'Off'}
              </div>
            </div>
            <Button
              small
              onClick={() => setPrivacyMode(currentUser.privacy_mode === 'server_managed' ? 'off' : 'server_managed')}
              disabled={saving}
            >
              {currentUser.privacy_mode === 'server_managed' ? 'Turn off' : 'Enable'}
            </Button>
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
            This first step only protects Plaid tokens on disk. It does not change what the app can display after you log in, and it stays optional per account.
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Authenticator app</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
              Status: {currentUser.two_factor_enabled ? 'Enabled' : 'Not enabled'}
            </div>
            {currentUser.two_factor_enabled && (
              <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
                Recovery codes remaining: {currentUser.recovery_code_count}
              </div>
            )}
          </div>
          {!currentUser.two_factor_enabled && !setup && (
            <Button small onClick={beginSetup} disabled={saving}>Set up 2FA</Button>
          )}
        </div>

        {setup && !currentUser.two_factor_enabled && (
          <form onSubmit={confirmSetup} style={{ display: 'grid', gap: 12, padding: 14, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface2)', marginBottom: 14 }}>
            <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
              Add this secret to your authenticator app, then enter the current 6-digit code to confirm.
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>Manual setup key</div>
              <div style={{ fontFamily: 'monospace', fontSize: 14, padding: '10px 12px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, wordBreak: 'break-all' }}>
                {setup.secret}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>Provisioning URI</div>
              <div style={{ fontFamily: 'monospace', fontSize: 11, padding: '10px 12px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, wordBreak: 'break-all' }}>
                {setup.otpauth_uri}
              </div>
            </div>
            <input
              value={setupCode}
              onChange={e => setSetupCode(e.target.value)}
              placeholder="Enter 6-digit code"
              inputMode="numeric"
              style={inputStyle}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <Button small type="submit" disabled={saving || setupCode.trim().length < 6}>
                {saving ? 'Enabling...' : 'Confirm setup'}
              </Button>
              <Button small variant="ghost" type="button" onClick={() => { setSetup(null); setSetupCode(''); setError('') }}>
                Cancel
              </Button>
            </div>
          </form>
        )}

        {currentUser.two_factor_enabled && (
          <div style={{ display: 'grid', gap: 12 }}>
            <form onSubmit={turnOff2fa} style={{ display: 'grid', gap: 12, padding: 14, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface2)' }}>
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                Enter a current authenticator code to disable 2FA for this account.
              </div>
              <input
                value={disableCode}
                onChange={e => setDisableCode(e.target.value)}
                placeholder="Enter 6-digit code"
                inputMode="numeric"
                style={inputStyle}
              />
              <div>
                <Button small type="submit" disabled={saving || disableCode.trim().length < 6}>
                  {saving ? 'Disabling...' : 'Disable 2FA'}
                </Button>
              </div>
            </form>

            <form onSubmit={regenerateCodes} style={{ display: 'grid', gap: 12, padding: 14, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface2)' }}>
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                Regenerate your recovery codes. This invalidates the current set immediately.
              </div>
              <input
                value={regenCode}
                onChange={e => setRegenCode(e.target.value)}
                placeholder="Enter current 6-digit code"
                inputMode="numeric"
                style={inputStyle}
              />
              <div>
                <Button small type="submit" disabled={saving || regenCode.trim().length < 6}>
                  {saving ? 'Regenerating...' : 'Regenerate recovery codes'}
                </Button>
              </div>
            </form>
          </div>
        )}

        {recoveryCodes.length > 0 && (
          <div style={{ marginTop: 14, padding: 14, border: '1px solid #f59e0b', borderRadius: 10, background: 'color-mix(in srgb, #f59e0b 10%, var(--surface))' }}>
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>
              Save these recovery codes somewhere secure. They are shown only once and each code can be used one time.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, marginTop: 12 }}>
              {recoveryCodes.map(code => (
                <div key={code} style={{ fontFamily: 'monospace', fontSize: 13, padding: '8px 10px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 }}>
                  {code}
                </div>
              ))}
            </div>
            <div style={{ marginTop: 12 }}>
              <Button small variant="ghost" type="button" onClick={() => setRecoveryCodes([])}>
                Dismiss codes
              </Button>
            </div>
          </div>
        )}

        {error && (
          <div style={{ marginTop: 14, color: '#ef4444', fontSize: 13 }}>
            {error}
          </div>
        )}
      </Card>
    </div>
  )
}

function StickySection({ title, description, actions, children }) {
  return (
    <section style={{ marginBottom: 32 }}>
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 2,
          padding: '14px 0 14px',
          marginBottom: 14,
          background: 'linear-gradient(to bottom, var(--bg) 82%, transparent)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'start', justifyContent: 'space-between', gap: 12, marginBottom: 4 }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{title}</div>
          {actions ? <div style={{ flexShrink: 0 }}>{actions}</div> : null}
        </div>
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>{description}</div>
      </div>
      {children}
    </section>
  )
}

export default function Settings() {
  const [owners, setOwners]   = useState([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [authEnabled, setAuthEnabled] = useState(false)

  useEffect(() => {
    Promise.all([api.getOwners(), api.getAuthStatus()]).then(([o, status]) => {
      setOwners(o)
      setAuthEnabled(!!status.auth_enabled)
      setLoading(false)
    })
  }, [])

  async function handleAdd(data) {
    const owner = await api.createOwner(data)
    setOwners(prev => [...prev, owner])
    setShowAdd(false)
  }

  async function handleSave(id, data) {
    await api.updateOwner(id, data)
    setOwners(prev => prev.map(o => o.id === id ? { ...o, ...data } : o))
  }

  async function handleDelete(id) {
    if (!confirm('Delete this owner? Their accounts and categories will become unassigned.')) return
    await api.deleteOwner(id)
    setOwners(prev => prev.filter(o => o.id !== id))
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '32px 32px 0', flexShrink: 0 }}>
        <PageHeader title="Settings" />
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 32px 32px' }}>

      <AuthModeSection authEnabled={authEnabled} onEnabled={status => setAuthEnabled(!!status.auth_enabled)} />

      {authEnabled && <SecuritySection />}

      {authEnabled && <UserAdminSection />}

      {/* ── Section 1: Owners ── */}
      <StickySection
        title="Owners"
        actions={
          <Button small onClick={() => setShowAdd(v => !v)}>
            {showAdd ? 'Cancel' : '+ New owner'}
          </Button>
        }
        description={
          <>
          Define the people in your household. Assign accounts and category groups to
          owners below, then use the owner filter on any page or the Dashboard split view.
          </>
        }
      >
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          {showAdd && (
            <AddOwnerForm onAdd={handleAdd} onCancel={() => setShowAdd(false)} />
          )}
          {loading ? <Spinner /> : owners.length === 0 && !showAdd ? (
            <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
              No owners yet — add one to get started.
              <br />
              <button onClick={() => setShowAdd(true)} style={{
                marginTop: 10, background: 'var(--accent)', color: '#fff',
                border: 'none', borderRadius: 6, padding: '7px 14px',
                fontSize: 13, cursor: 'pointer',
              }}>+ Add first owner</button>
            </div>
          ) : (
            owners.map(o => (
              <OwnerRow key={o.id} owner={o} onSave={handleSave} onDelete={handleDelete} />
            ))
          )}
        </Card>
      </StickySection>

      {/* ── Section 2: Account assignment ── */}
      <StickySection
        title="Account ownership"
        description={
          <>
          Assign each linked account to an owner. All transactions on that account
          will be attributed to that owner and can be filtered or split in the Dashboard.
          </>
        }
      >
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          {loading ? <Spinner /> : owners.length === 0 ? (
            <div style={{ padding: '16px', color: 'var(--muted)', fontSize: 13 }}>
              Add at least one owner above before assigning accounts.
            </div>
          ) : (
            <AccountAssignment owners={owners} />
          )}
        </Card>
      </StickySection>

      {/* ── Section 3: Category group assignment ── */}
      <StickySection
        title="Category group ownership"
        description={
          <>
          Tag each spending group with an owner. Use this to mark joint expenses
          (Utilities, Groceries) as "Shared" and personal expenses as individual.
          This drives the Dashboard's "split by owner" view.
          </>
        }
      >
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          {loading ? <Spinner /> : owners.length === 0 ? (
            <div style={{ padding: '16px', color: 'var(--muted)', fontSize: 13 }}>
              Add at least one owner above before tagging category groups.
            </div>
          ) : (
            <CategoryGroupAssignment owners={owners} />
          )}
        </Card>
      </StickySection>

      {/* ── Section 4: Import profiles ── */}
      <StickySection
        title="Import profiles"
        description={
          <>
          Saved column-mapping configurations for recurring CSV imports (e.g. Chase, Riverstone).
          Profiles are auto-detected when you upload a file on the Import page.
          </>
        }
      >
        <ImportProfilesSection />
      </StickySection>
      </div>
    </div>
  )
}
