/**
 * Settings.jsx — Owner and category ownership management
 *
 * Two sections on one page:
 *
 * 1. OWNERS — Create / rename / recolor / delete named owners (e.g. Alice, Bob, Shared).
 *    Deleting an owner NULLs out owner_id on all related accounts, categories, and
 *    transactions (handled server-side via ON DELETE SET NULL).
 *
 * 2. CATEGORY GROUPS → OWNER — Tag each spending group (Food & Drink, Transportation,
 *    etc.) with an owner to indicate whose domain it belongs to. This drives the
 *    Dashboard split-by-owner view: "Shared" groups appear in both columns, personal
 *    groups appear only in that person's column.
 *    Leaf categories silently inherit the group's owner (stored in DB, not shown here).
 */

import { useState, useEffect, useRef } from 'react'
import { api } from '../lib/api.js'
import { Card, PageHeader, Button, Spinner, EmptyState } from '../components/ui.jsx'
import { PASSWORD_POLICIES, passwordPolicyHelpText, validatePasswordForPolicy } from '../lib/passwordPolicy.js'
import { SECURITY_PROFILES, getSecurityProfile } from '../lib/securityProfiles.js'

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
        <button
          type="button"
          onClick={() => setEditing(true)}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            margin: 0,
            cursor: 'text',
            font: 'inherit',
            color: 'inherit',
            textAlign: 'left',
            flex: 1,
          }}
        >
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: '4px 10px',
            borderRadius: 999,
            border: '1px solid var(--border)',
            background: 'var(--surface2)',
            fontSize: 13,
            lineHeight: 1.2,
          }}>
            {owner.name}
          </span>
        </button>
        <div style={{ display: 'flex', gap: 6 }}>
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

function AuthModeSection({ authEnabled, onEnabled, embedded = false }) {
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
  )
}

function SecurityProfileSection({ authEnabled, securityProfile, passwordPolicy, onChange }) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const currentProfile = getSecurityProfile(securityProfile)

  async function handleChange(nextProfile) {
    setSaving(true)
    setError('')
    try {
      const resp = await api.saveSecurityProfile(nextProfile)
      onChange?.(resp)
    } catch (err) {
      setError(err.message || 'Failed to save security mode')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card style={{ padding: 20 }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Security mode</div>
      <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, marginBottom: 14 }}>
        Choose the deployment model this FinTrack instance is meant for. This does not force auth on or off by itself, but it sets expectations for password strength and sign-in protection.
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        {SECURITY_PROFILES.map(option => (
          <label
            key={option.value}
            style={{
              display: 'grid',
              gap: 4,
              padding: '12px 14px',
              border: `1px solid ${securityProfile === option.value ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 12,
              background: securityProfile === option.value
                ? 'color-mix(in srgb, var(--accent) 7%, var(--surface2))'
                : 'var(--surface2)',
              cursor: saving ? 'default' : 'pointer',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input
                type="radio"
                name="security-profile"
                checked={securityProfile === option.value}
                onChange={() => handleChange(option.value)}
                disabled={saving}
              />
              <span style={{ fontSize: 13, fontWeight: 600 }}>{option.label}</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, paddingLeft: 24 }}>
              {option.summary}
            </div>
          </label>
        ))}
      </div>

      <div style={{ marginTop: 14, padding: 12, borderRadius: 10, background: 'var(--surface2)', border: '1px solid var(--border)' }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Current recommendation</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
          {currentProfile.recommendedAuth
            ? `This mode usually should have sign-in protection enabled. Suggested password policy: ${currentProfile.suggestedPasswordPolicy.replace('_', ' ')}.`
            : 'This mode can reasonably stay in local no-login mode if the app is only exposed on localhost.'}
        </div>
        {authEnabled && (
          <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6, marginTop: 6 }}>
            Active password policy: {passwordPolicyHelpText(passwordPolicy)}
          </div>
        )}
      </div>

      {error && (
        <div style={{ marginTop: 12, color: '#ef4444', fontSize: 13 }}>
          {error}
        </div>
      )}
    </Card>
  )
}

function UserAdminSection({ passwordPolicy, embedded = false }) {
  const [viewer, setViewer] = useState(null)
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [savingUserId, setSavingUserId] = useState(null)
  const [deletingUserId, setDeletingUserId] = useState(null)
  const [editingUserId, setEditingUserId] = useState(null)
  const [error, setError] = useState('')
  const [form, setForm] = useState({
    username: '',
    display_name: '',
    password: '',
    role: 'member',
  })
  const [editForm, setEditForm] = useState({
    username: '',
    display_name: '',
    password: '',
    role: 'member',
    status: 'active',
  })
  const [newUserId, setNewUserId] = useState(null)
  const userRowRefs = useRef(new Map())
  const editRowRefs = useRef(new Map())
  const userTableHeaderRef = useRef(null)

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

  useEffect(() => {
    if (!newUserId) return
    const row = userRowRefs.current.get(newUserId)
    if (!row) return
    row.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    setNewUserId(null)
  }, [users, newUserId])

  useEffect(() => {
    if (!editingUserId) return
    const row = editRowRefs.current.get(editingUserId)
    if (!row) return
    row.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [editingUserId])

  async function handleCreate(e) {
    e.preventDefault()
    setCreating(true)
    setError('')
    try {
      const resp = await api.createUser(form)
      setNewUserId(resp?.user?.id || null)
      setForm({ username: '', display_name: '', password: '', role: 'member' })
      await load()
    } catch (err) {
      setError(err.message || 'Failed to create user')
    } finally {
      setCreating(false)
    }
  }

  function startEditing(user) {
    setEditingUserId(user.id)
    setEditForm({
      username: user.username || '',
      display_name: user.display_name || '',
      password: '',
      role: user.role || 'member',
      status: user.status || 'active',
    })
    setError('')
  }

  function cancelEditing() {
    setEditingUserId(null)
    setEditForm({
      username: '',
      display_name: '',
      password: '',
      role: 'member',
      status: 'active',
    })
  }

  async function handleSaveUser(userId) {
    setSavingUserId(userId)
    setError('')
    try {
      const payload = {
        username: editForm.username,
        display_name: editForm.display_name,
        role: editForm.role,
        status: editForm.status,
        ...(editForm.password ? { password: editForm.password } : {}),
      }
      await api.updateUser(userId, payload)
      cancelEditing()
      await load()
    } catch (err) {
      setError(err.message || 'Failed to update user')
    } finally {
      setSavingUserId(null)
    }
  }

  async function handleDeleteUser(user) {
    if (!confirm(`Delete ${user.display_name || user.username}? This removes their sign-in account from this FinTrack instance.`)) return
    setDeletingUserId(user.id)
    setError('')
    try {
      await api.deleteUser(user.id)
      if (editingUserId === user.id) cancelEditing()
      await load()
      userTableHeaderRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } catch (err) {
      setError(err.message || 'Failed to delete user')
    } finally {
      setDeletingUserId(null)
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
      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface2)' }}>
          <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
            Use this area when more than one person needs their own sign-in for the same FinTrack installation, such as a shared household system or a password-protected home server.
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
          <Button small type="submit" disabled={creating || !form.username.trim() || !validatePasswordForPolicy(form.password, passwordPolicy)}>
            {creating ? 'Creating...' : 'Add user'}
          </Button>
        </form>
        <div style={{ padding: '10px 16px', color: 'var(--muted)', fontSize: 12, borderBottom: '1px solid var(--border)' }}>
          Password policy: {passwordPolicyHelpText(passwordPolicy)}
        </div>

        {error && (
          <div style={{ padding: '10px 16px', color: '#ef4444', fontSize: 13, borderBottom: '1px solid var(--border)' }}>
            {error}
          </div>
        )}

        <div ref={userTableHeaderRef} style={{ display: 'grid', gridTemplateColumns: '1.4fr 120px 1fr 1fr auto', padding: '8px 16px', fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid var(--border)', gap: 10 }}>
          <span>User</span><span>Role</span><span>Status</span><span>Last login</span><span />
        </div>
        {users.map(user => (
          editingUserId === user.id ? (
            <div
              key={user.id}
              ref={node => {
                if (node) editRowRefs.current.set(user.id, node)
                else editRowRefs.current.delete(user.id)
              }}
              style={{ padding: 16, borderBottom: '1px solid var(--border)', display: 'grid', gap: 12, background: 'var(--surface2)' }}
            >
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 120px 120px', gap: 10 }}>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Username</label>
                  <input value={editForm.username} onChange={e => setEditForm(prev => ({ ...prev, username: e.target.value }))} style={inputStyle} />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Display name</label>
                  <input value={editForm.display_name} onChange={e => setEditForm(prev => ({ ...prev, display_name: e.target.value }))} style={inputStyle} />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>New password</label>
                  <input type="password" value={editForm.password} onChange={e => setEditForm(prev => ({ ...prev, password: e.target.value }))} placeholder="Leave blank to keep current" style={inputStyle} />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Role</label>
                  <select value={editForm.role} onChange={e => setEditForm(prev => ({ ...prev, role: e.target.value }))} style={{ ...inputStyle, cursor: 'pointer' }}>
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Status</label>
                  <select value={editForm.status} onChange={e => setEditForm(prev => ({ ...prev, status: e.target.value }))} style={{ ...inputStyle, cursor: 'pointer' }}>
                    <option value="active">Active</option>
                    <option value="disabled">Disabled</option>
                  </select>
                </div>
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                {editForm.password ? passwordPolicyHelpText(passwordPolicy) : 'Leave the password field empty to keep the existing password.'}
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <Button
                  small
                  onClick={() => handleSaveUser(user.id)}
                  disabled={savingUserId === user.id || !editForm.username.trim() || !editForm.display_name.trim() || (editForm.password && !validatePasswordForPolicy(editForm.password, passwordPolicy))}
                >
                  {savingUserId === user.id ? 'Saving...' : 'Save changes'}
                </Button>
                <Button small variant="ghost" onClick={cancelEditing}>Cancel</Button>
                {viewer?.id !== user.id && (
                  <Button small variant="ghost" onClick={() => handleDeleteUser(user)} disabled={deletingUserId === user.id}>
                    {deletingUserId === user.id ? 'Deleting...' : 'Delete user'}
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div
              key={user.id}
              ref={node => {
                if (node) userRowRefs.current.set(user.id, node)
                else userRowRefs.current.delete(user.id)
              }}
              style={{ display: 'grid', gridTemplateColumns: '1.4fr 120px 1fr 1fr auto', padding: '10px 16px', fontSize: 13, borderBottom: '1px solid var(--border)', alignItems: 'center', gap: 10 }}
            >
              <div>
                <div style={{ fontWeight: 500 }}>
                  {user.username}
                  <span style={{ fontWeight: 400, color: 'var(--muted)' }}>
                    {` - ${user.display_name || user.username}`}
                  </span>
                  {viewer?.id === user.id ? ' (you)' : ''}
                </div>
              </div>
              <span style={{ textTransform: 'capitalize' }}>{user.role}</span>
              <span style={{ textTransform: 'capitalize' }}>{user.status}</span>
              <span style={{ color: 'var(--muted)' }}>{user.last_login_at || 'Never'}</span>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button small variant="ghost" onClick={() => startEditing(user)}>Edit</Button>
              </div>
            </div>
          )
        ))}
      </Card>
  )
}

function PasswordPolicyPanel({ passwordPolicy, onChange }) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleChange(nextPolicy) {
    setSaving(true)
    setError('')
    try {
      const resp = await api.savePasswordPolicy(nextPolicy)
      onChange?.(resp.password_policy || nextPolicy)
    } catch (err) {
      setError(err.message || 'Failed to save password policy')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ display: 'grid', gap: 8, marginBottom: 18 }}>
      <div style={{ fontSize: 14, fontWeight: 600 }}>Password policy</div>
      <div style={{ fontSize: 13, color: 'var(--muted)' }}>
        Choose how strictly FinTrack should validate passwords for new sign-ins and user accounts.
      </div>
      <div style={{ display: 'grid', gap: 6, paddingLeft: 14 }}>
        {PASSWORD_POLICIES.map(option => (
          <label
            key={option.value}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '8px 12px',
              border: `1px solid ${passwordPolicy === option.value ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 999,
              background: passwordPolicy === option.value
                ? 'color-mix(in srgb, var(--accent) 8%, var(--surface2))'
                : 'var(--surface2)',
              cursor: saving ? 'default' : 'pointer',
            }}
          >
            <input
              type="radio"
              name="password-policy"
              checked={passwordPolicy === option.value}
              onChange={() => handleChange(option.value)}
              disabled={saving}
            />
            <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>{option.label}</span>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{option.hint}</span>
          </label>
        ))}
      </div>
      {error && (
        <div style={{ color: '#ef4444', fontSize: 13 }}>
          {error}
        </div>
      )}
    </div>
  )
}

function AccountSecuritySection({ passwordPolicy, onPasswordPolicyChange, embedded = false }) {
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

  if (loading) return <Spinner />
  if (!currentUser) return null

  const inputStyle = {
    background: 'var(--surface)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: 6,
    padding: '7px 10px', fontSize: 13, width: '100%', outline: 'none',
  }

  return (
      <Card style={{ padding: 20 }}>
        <PasswordPolicyPanel passwordPolicy={passwordPolicy} onChange={onPasswordPolicyChange} />

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
  )
}

function PlaidTokenProtectionSection({ embedded = false }) {
  const [currentUser, setCurrentUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function load() {
    setLoading(true)
    try {
      const resp = await api.getCurrentUser()
      setCurrentUser(resp.user)
      setError('')
    } catch (err) {
      setError(err.message || 'Failed to load Plaid token protection')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function setPrivacyMode(nextMode) {
    setSaving(true)
    setError('')
    try {
      const resp = await api.setPrivacyMode(nextMode)
      setCurrentUser(resp.user)
    } catch (err) {
      setError(err.message || 'Failed to update token protection')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <Spinner />
  if (!currentUser) return null

  return (
      <Card style={{ padding: 20 }}>
        <div style={{ display: 'grid', gap: 12, padding: 14, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface2)' }}>
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
            This only protects Plaid tokens on disk. It does not change what FinTrack can display after you sign in.
          </div>
        </div>
        {error && (
          <div style={{ marginTop: 14, color: '#ef4444', fontSize: 13 }}>
            {error}
          </div>
        )}
      </Card>
  )
}

function StickySection({ title, description, actions, children, defaultCollapsed = true, scrollContainerRef = null }) {
  const [open, setOpen] = useState(!defaultCollapsed)
  const sectionRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const node = sectionRef.current
    if (!node) return

    const scrollAfterLayout = () => {
      const scrollParent = scrollContainerRef?.current
      if (!scrollParent) {
        node.scrollIntoView({ behavior: 'smooth', block: 'start' })
        return
      }
      const padding = 12
      const sectionTop = node.offsetTop
      const sectionBottom = sectionTop + node.offsetHeight
      const viewTop = scrollParent.scrollTop
      const viewBottom = viewTop + scrollParent.clientHeight

      let targetTop = null

      // If the section header ends up above the visible viewport, bring it back.
      if (sectionTop < viewTop + padding) {
        targetTop = Math.max(0, sectionTop - padding)
      }
      // If the section grows below the visible viewport, scroll just enough to reveal it.
      else if (sectionBottom > viewBottom - padding) {
        targetTop = Math.max(0, sectionBottom - scrollParent.clientHeight + padding)
      }

      if (targetTop !== null && Math.abs(targetTop - scrollParent.scrollTop) > 2) {
        scrollParent.scrollTo({ top: targetTop, behavior: 'smooth' })
      }
    }

    let timeoutId = null
    let frame2 = null
    const frame = window.requestAnimationFrame(() => {
      frame2 = window.requestAnimationFrame(() => {
        timeoutId = window.setTimeout(scrollAfterLayout, 0)
      })
    })

    return () => {
      window.cancelAnimationFrame(frame)
      if (frame2 !== null) window.cancelAnimationFrame(frame2)
      if (timeoutId !== null) window.clearTimeout(timeoutId)
    }
  }, [open])

  return (
    <section ref={sectionRef} style={{ marginBottom: 24, display: 'grid', justifyItems: 'start' }}>
      <div
        style={{
          padding: '8px 0 8px',
          width: '100%',
        }}
      >
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '9px 14px',
          border: '1px solid var(--border)',
          borderRadius: 999,
          background: 'var(--surface)',
          maxWidth: '100%',
          boxShadow: '0 1px 0 rgba(15, 23, 42, 0.03)',
        }}>
          <button
            type="button"
            onClick={() => setOpen(prev => !prev)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              background: 'none',
              border: 'none',
              padding: 0,
              margin: 0,
              color: 'inherit',
              cursor: 'pointer',
              textAlign: 'left',
              flex: 1,
              minWidth: 0,
            }}
          >
            <span style={{
              width: 22,
              height: 22,
              borderRadius: 999,
              border: '1px solid var(--border)',
              display: 'grid',
              placeItems: 'center',
              fontSize: 14,
              color: 'var(--muted)',
              background: 'var(--surface2)',
              lineHeight: 1,
              flexShrink: 0,
            }}>
              {open ? '-' : '+'}
            </span>
            <span style={{ display: 'grid', gap: description ? 2 : 0, minWidth: 0 }}>
              <span style={{ fontSize: 16, fontWeight: 600 }}>{title}</span>
              {description ? <span style={{ fontSize: 13, color: 'var(--muted)' }}>{description}</span> : null}
            </span>
          </button>
          {open && actions ? <div style={{ flexShrink: 0 }}>{actions}</div> : null}
        </div>
      </div>
      {open ? <div style={{ marginTop: 5, width: '100%', paddingLeft: 25 }}>{children}</div> : null}
    </section>
  )
}

function BackupRecipientsSection() {
  const [recipients, setRecipients] = useState([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({ label: '', public_key: '' })
  const fileInputRef = useRef(null)
  const [editingRecipientId, setEditingRecipientId] = useState(null)
  const [editingLabel, setEditingLabel] = useState('')

  async function load() {
    setLoading(true)
    try {
      setRecipients(await api.getBackupRecipients())
      setError('')
    } catch (err) {
      setError(err.message || 'Failed to load backup recipients')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function loadPublicKeyFile(file) {
    if (!file) return
    try {
      const text = await file.text()
      setForm(prev => ({
        label: prev.label || file.name.replace(/\.[^.]+$/, ''),
        public_key: text,
      }))
      setError('')
    } catch {
      setError('Failed to read public key file')
    }
  }

  async function handlePublicKeyDrop(e) {
    e.preventDefault()
    const file = e.dataTransfer.files?.[0]
    if (file) {
      await loadPublicKeyFile(file)
      return
    }
    const text = e.dataTransfer.getData('text/plain')
    if (text) {
      setForm(prev => ({ ...prev, public_key: text.trim() }))
    }
  }

  async function handleCreate(e) {
    e.preventDefault()
    setCreating(true)
    setError('')
    try {
      const created = await api.createBackupRecipient(form)
      setRecipients(prev => [created, ...prev])
      setForm({ label: '', public_key: '' })
    } catch (err) {
      setError(err.message || 'Failed to save backup recipient')
    } finally {
      setCreating(false)
    }
  }

  async function toggleRecipient(recipient) {
    try {
      const updated = await api.updateBackupRecipient(recipient.id, { enabled: !recipient.enabled })
      setRecipients(prev => prev.map(item => item.id === recipient.id ? updated : item))
    } catch (err) {
      setError(err.message || 'Failed to update recipient')
    }
  }

  function beginEditRecipient(recipient) {
    setEditingRecipientId(recipient.id)
    setEditingLabel(recipient.label || '')
  }

  async function commitRecipientLabel(recipient) {
    const next = editingLabel.trim()
    setEditingRecipientId(null)
    if (!next || next === recipient.label) return
    try {
      const updated = await api.updateBackupRecipient(recipient.id, { label: next })
      setRecipients(prev => prev.map(item => item.id === recipient.id ? updated : item))
    } catch (err) {
      setError(err.message || 'Failed to update recipient')
      setEditingRecipientId(recipient.id)
    }
  }

  async function removeRecipient(recipient) {
    if (!confirm(`Delete backup recipient "${recipient.label}"?`)) return
    try {
      await api.deleteBackupRecipient(recipient.id)
      setRecipients(prev => prev.filter(item => item.id !== recipient.id))
    } catch (err) {
      setError(err.message || 'Failed to delete recipient')
    }
  }

  const inputStyle = {
    background: 'var(--surface)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: 6,
    padding: '7px 10px', fontSize: 13, width: '100%', outline: 'none',
  }

  return (
      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '14px 16px 0', color: 'var(--muted)', fontSize: 13 }}>
          Used to encrypt backup files for external storage. A matching private key file needs to be provided during the restore; only public keys are stored.
        </div>
        <form onSubmit={handleCreate} style={{ display: 'grid', gap: 10, padding: 16, borderBottom: '1px solid var(--border)' }}>
          <input
            value={form.label}
            onChange={e => setForm(prev => ({ ...prev, label: e.target.value }))}
            placeholder="Recipient label (e.g. email)"
            style={inputStyle}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept=".pub,.pem,.txt,.key"
            onChange={e => loadPublicKeyFile(e.target.files?.[0])}
            style={{ display: 'none' }}
          />
          {!form.public_key.trim() ? (
            <div
              onClick={() => fileInputRef.current?.click()}
              onDragOver={e => e.preventDefault()}
              onDrop={handlePublicKeyDrop}
              style={{
                border: '2px dashed var(--border)',
                borderRadius: 12,
                padding: '40px 28px',
                textAlign: 'center',
                cursor: 'pointer',
                background: 'var(--surface2)',
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent)' }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)' }}
            >
              <div style={{ fontSize: 32, marginBottom: 12 }}>📂</div>
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>
                Drop a public key file here, or click to browse
              </div>
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                RSA public keys only.
              </div>
            </div>
          ) : (
            <textarea
              value={form.public_key}
              onChange={e => setForm(prev => ({ ...prev, public_key: e.target.value }))}
              rows={5}
              onDragOver={e => e.preventDefault()}
              onDrop={handlePublicKeyDrop}
              style={{
                ...inputStyle,
                minHeight: 120,
                resize: 'vertical',
                fontFamily: 'monospace',
                borderRadius: 10,
                lineHeight: 1.5,
              }}
            />
          )}
          <div>
            <Button small type="submit" disabled={creating || !form.label.trim() || !form.public_key.trim()}>
              {creating ? 'Saving...' : 'Add recipient'}
            </Button>
        </div>
      </form>

      {error && <div style={{ padding: '10px 16px', color: '#ef4444', fontSize: 13, borderBottom: '1px solid var(--border)' }}>{error}</div>}
      {loading ? <Spinner /> : recipients.length === 0 ? (
        <div style={{ padding: '18px 16px', color: 'var(--muted)', fontSize: 13 }}>
          No backup recipients yet. Add an RSA public key here to enable encrypted backups for cloud storage.
        </div>
      ) : (
        recipients.map(recipient => (
          <div key={recipient.id} style={{ display: 'grid', gridTemplateColumns: '1fr 120px 90px', gap: 10, padding: '12px 16px', alignItems: 'center', borderBottom: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
              {editingRecipientId === recipient.id ? (
                <input
                  autoFocus
                  value={editingLabel}
                  onChange={e => setEditingLabel(e.target.value)}
                  onBlur={() => commitRecipientLabel(recipient)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      commitRecipientLabel(recipient)
                    }
                    if (e.key === 'Escape') {
                      setEditingRecipientId(null)
                    }
                  }}
                  style={{
                    background: 'var(--surface)',
                    color: 'var(--text)',
                    border: '1px solid var(--accent)',
                    borderRadius: 999,
                    padding: '4px 10px',
                    fontSize: 13,
                    fontWeight: 600,
                    lineHeight: 1.2,
                    minWidth: 120,
                    outline: 'none',
                  }}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => beginEditRecipient(recipient)}
                  style={{
                    background: 'var(--surface2)',
                    color: 'var(--text)',
                    border: '1px solid var(--border)',
                    borderRadius: 999,
                    padding: '4px 10px',
                    fontSize: 13,
                    fontWeight: 600,
                    lineHeight: 1.2,
                    whiteSpace: 'nowrap',
                    cursor: 'text',
                  }}
                >
                  {recipient.label}
                </button>
              )}
              <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'monospace', lineHeight: 1.2, wordBreak: 'break-all', minWidth: 0 }}>
                {recipient.fingerprint}
              </div>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--muted)', cursor: 'pointer' }}>
              <input type="checkbox" checked={!!recipient.enabled} onChange={() => toggleRecipient(recipient)} />
              Enabled
            </label>
            <button
              type="button"
              onClick={() => removeRecipient(recipient)}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--danger)',
                cursor: 'pointer',
                fontSize: 16,
                lineHeight: 1,
                width: 28,
                height: 28,
                borderRadius: 999,
              }}
            >
              ×
            </button>
          </div>
        ))
      )}
    </Card>
  )
}

function EnvironmentSection({ authEnabled, currentUser }) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [settings, setSettings] = useState({
    plaid_client_id: '',
    plaid_secret: '',
    plaid_env: 'sandbox',
    fintrack_use_log_files: false,
    env_file_path: '',
    env_file_present: false,
  })

  const canManage = !authEnabled || currentUser?.role === 'admin'

  useEffect(() => {
    if (!canManage) {
      setLoading(false)
      return
    }

    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const resp = await api.getEnvironmentSettings()
        if (!cancelled) {
          setSettings({
            plaid_client_id: resp.plaid_client_id || '',
            plaid_secret: resp.plaid_secret || '',
            plaid_env: resp.plaid_env || 'sandbox',
            fintrack_use_log_files: !!resp.fintrack_use_log_files,
            env_file_path: resp.env_file_path || '',
            env_file_present: !!resp.env_file_present,
          })
          setError('')
        }
      } catch (err) {
        if (!cancelled) setError(err.message || 'Failed to load environment settings')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [canManage])

  if (!canManage) return null

  const inputStyle = {
    background: 'var(--surface)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: 6,
    padding: '7px 10px', fontSize: 13, width: '100%', outline: 'none',
  }

  async function handleSave(e) {
    e.preventDefault()
    setSaving(true)
    setSaved(false)
    setError('')
    try {
      const resp = await api.saveEnvironmentSettings({
        plaid_client_id: settings.plaid_client_id,
        plaid_secret: settings.plaid_secret,
        plaid_env: settings.plaid_env,
        fintrack_use_log_files: settings.fintrack_use_log_files,
      })
      setSettings(prev => ({
        ...prev,
        ...(resp.settings || {}),
      }))
      setSaved(true)
    } catch (err) {
      setError(err.message || 'Failed to save environment settings')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      {loading ? <Spinner /> : (
        <form onSubmit={handleSave} style={{ display: 'grid', gap: 14, padding: 16 }}>
          <div style={{ display: 'grid', gap: 10, padding: 14, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface2)' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)' }}>Plaid credentials</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 160px', gap: 10 }}>
              <div>
                <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Plaid client ID</label>
                <input
                  value={settings.plaid_client_id}
                  onChange={e => setSettings(prev => ({ ...prev, plaid_client_id: e.target.value }))}
                  placeholder="Optional"
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Plaid secret</label>
                <input
                  type="password"
                  value={settings.plaid_secret}
                  onChange={e => setSettings(prev => ({ ...prev, plaid_secret: e.target.value }))}
                  placeholder="Optional"
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Plaid environment</label>
                <select
                  value={settings.plaid_env}
                  onChange={e => setSettings(prev => ({ ...prev, plaid_env: e.target.value }))}
                  style={{ ...inputStyle, cursor: 'pointer' }}
                >
                  <option value="sandbox">sandbox</option>
                  <option value="development">development</option>
                  <option value="production">production</option>
                </select>
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gap: 10, padding: 14, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface2)' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)' }}>Backend/Frontend console logging</div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={settings.fintrack_use_log_files}
                onChange={e => setSettings(prev => ({ ...prev, fintrack_use_log_files: e.target.checked }))}
              />
              Enable log files at startup
            </label>
          </div>

          <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
            These settings are stored in <code>{settings.env_file_path || '.env'}</code> and take effect after you restart the backend.
          </div>

          {saved && (
            <div style={{ fontSize: 13, color: '#16a34a' }}>
              Saved. Restart the backend to apply the updated environment settings.
            </div>
          )}
          {error && (
            <div style={{ fontSize: 13, color: '#ef4444' }}>
              {error}
            </div>
          )}

          <div>
            <Button small type="submit" disabled={saving}>
              {saving ? 'Saving...' : 'Save environment settings'}
            </Button>
          </div>
        </form>
      )}
    </Card>
  )
}

export default function Settings() {
  const [owners, setOwners]   = useState([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [authEnabled, setAuthEnabled] = useState(false)
  const [currentUser, setCurrentUser] = useState(null)
  const [passwordPolicy, setPasswordPolicy] = useState('min_8')
  const [securityProfile, setSecurityProfile] = useState('local_private')
  const [experimentalSecuritySettings, setExperimentalSecuritySettings] = useState(false)
  const settingsScrollRef = useRef(null)

  useEffect(() => {
    Promise.all([api.getOwners(), api.getAuthStatus()]).then(([o, status]) => {
      setOwners(o)
      setAuthEnabled(!!status.auth_enabled)
      setCurrentUser(status.user || null)
      setPasswordPolicy(status.password_policy || 'min_8')
      setSecurityProfile(status.security_profile || 'local_private')
      setExperimentalSecuritySettings(!!status.experimental_security_settings)
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

  const canManageEnvironment = !authEnabled || currentUser?.role === 'admin'
  const showPreAuthSecuritySettings = experimentalSecuritySettings || authEnabled

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '32px 32px 0', flexShrink: 0 }}>
        <PageHeader title="Settings" />
      </div>

      <div ref={settingsScrollRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 32px 32px' }}>

      <StickySection
        title="CSV Import Profiles"
        scrollContainerRef={settingsScrollRef}
      >
        <ImportProfilesSection />
      </StickySection>

      <StickySection
        title="Backup recipients"
        description={
          <>
          RSA public keys
          </>
        }
        scrollContainerRef={settingsScrollRef}
      >
        <BackupRecipientsSection />
      </StickySection>

      {/* ── Section 1: Owners ── */}
      <StickySection
        title="Account Owners"
        actions={owners.length > 0 ? (
          <Button small onClick={() => setShowAdd(v => !v)}>
            {showAdd ? 'Cancel' : '+ New account owner'}
          </Button>
        ) : null}
        scrollContainerRef={settingsScrollRef}
      >
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          {showAdd && (
            <AddOwnerForm onAdd={handleAdd} onCancel={() => setShowAdd(false)} />
          )}
          {loading ? <Spinner /> : owners.length === 0 && !showAdd ? (
            <div style={{ padding: '16px', textAlign: 'left', color: 'var(--muted)', fontSize: 13 }}>
              <div style={{ marginBottom: 10 }}>None.</div>
              <Button small onClick={() => setShowAdd(true)}>
                + New account owner
              </Button>
            </div>
          ) : (
            owners.map(o => (
              <OwnerRow key={o.id} owner={o} onSave={handleSave} onDelete={handleDelete} />
            ))
          )}
        </Card>
      </StickySection>

      {canManageEnvironment && (
        <StickySection
          title="Environment variables (.env)"
          scrollContainerRef={settingsScrollRef}
        >
          <EnvironmentSection authEnabled={authEnabled} currentUser={currentUser} />
        </StickySection>
      )}

      {showPreAuthSecuritySettings && (
        <StickySection
          title="Security model"
          description="Match FinTrack's sign-in posture to how this instance is deployed and who can reach it."
          scrollContainerRef={settingsScrollRef}
        >
          <SecurityProfileSection
            authEnabled={authEnabled}
            securityProfile={securityProfile}
            passwordPolicy={passwordPolicy}
            onChange={resp => {
              setSecurityProfile(resp.security_profile || 'local_private')
            }}
          />
        </StickySection>
      )}

      {showPreAuthSecuritySettings && !authEnabled && (
        <StickySection
          title="Sign-in protection"
          description="Enable login when you want passwords, 2FA, or multiple sign-in accounts for the same installation."
          scrollContainerRef={settingsScrollRef}
        >
          <AuthModeSection
            authEnabled={authEnabled}
            onEnabled={status => {
              setAuthEnabled(!!status.auth_enabled)
              setPasswordPolicy(status.password_policy || 'min_8')
              setSecurityProfile(status.security_profile || 'local_private')
            }}
            embedded
          />
        </StickySection>
      )}

      {authEnabled && (
        <StickySection
          title="Account security"
          description="Manage password requirements and authenticator-based sign-in protection."
          scrollContainerRef={settingsScrollRef}
        >
          <AccountSecuritySection passwordPolicy={passwordPolicy} onPasswordPolicyChange={setPasswordPolicy} embedded />
        </StickySection>
      )}

      {authEnabled && (
        <StickySection
          title="Plaid token protection"
          description="Control how Plaid access tokens are protected on disk for this account."
          scrollContainerRef={settingsScrollRef}
        >
          <PlaidTokenProtectionSection embedded />
        </StickySection>
      )}

      {authEnabled && (
        <StickySection
          title="User management"
          description="Manage who can sign in to this shared FinTrack installation."
          scrollContainerRef={settingsScrollRef}
        >
          <UserAdminSection passwordPolicy={passwordPolicy} embedded />
        </StickySection>
      )}
      </div>
    </div>
  )
}
