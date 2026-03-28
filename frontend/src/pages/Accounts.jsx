import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { refreshTaskBadge } from '../App.jsx'
import { Card, Button, Spinner, EmptyState } from '../components/ui.jsx'

const ACCOUNT_TYPES = [
  { value: 'depository', label: 'Checking / savings' },
  { value: 'credit', label: 'Credit card' },
  { value: 'investment', label: 'Investment' },
  { value: 'loan', label: 'Loan' },
  { value: 'other', label: 'Other' },
]

function accountTypeIcon(type) {
  const map = { depository: '🏦', credit: '💳', investment: '📈', loan: '🏠', other: '📁' }
  return map[type] || '🏦'
}

function HeaderPill({ children, style }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 'fit-content',
      minWidth: 0,
      height: 22,
      padding: '0 10px',
      borderRadius: 999,
      background: 'var(--surface2)',
      border: '1px solid var(--border)',
      color: 'var(--muted)',
      fontSize: 11,
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: '0.05em',
      whiteSpace: 'nowrap',
      ...style,
    }}>
      {children}
    </span>
  )
}

function controlStyle(extra = {}) {
  return {
    width: '100%',
    background: 'var(--surface2)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '6px 10px',
    fontSize: 13,
    ...extra,
  }
}

function PillSelect({ value, options, onChange, placeholder = '—', minOpenWidth = 132 }) {
  const [open, setOpen] = useState(false)
  const selectRef = useRef(null)
  const selectedLabel = options.find(o => o.value === (value || ''))?.label || placeholder

  useEffect(() => {
    if (open) selectRef.current?.focus()
  }, [open])

  if (open) {
    return (
      <div style={{ position: 'relative', width: '100%', height: 28, zIndex: 20, overflow: 'visible' }}>
        <select
          ref={selectRef}
          value={value || ''}
          onChange={e => {
            onChange(e.target.value || '')
            setOpen(false)
          }}
          onBlur={() => setOpen(false)}
          onKeyDown={e => {
            if (e.key === 'Escape') setOpen(false)
          }}
          style={controlStyle({
            position: 'absolute',
            left: 0,
            top: 0,
            minWidth: minOpenWidth,
            width: 'auto',
            height: 28,
            padding: '0 8px',
            fontSize: 12,
            borderRadius: 999,
            appearance: 'none',
            WebkitAppearance: 'none',
            MozAppearance: 'none',
            boxShadow: '0 10px 24px rgba(0, 0, 0, 0.14)',
            zIndex: 30,
          })}
        >
          {options.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 'fit-content',
        maxWidth: '100%',
        height: 28,
        background: 'var(--surface2)',
        color: 'var(--text)',
        border: '1px solid var(--border)',
        borderRadius: 999,
        padding: '0 9px',
        fontSize: 12,
        lineHeight: 1.1,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        position: 'relative',
        zIndex: 1,
      }}
      title="Click to change"
    >
      {selectedLabel}
    </button>
  )
}

function DraftAccountRow({ owners, onCreate, onCancel, creating }) {
  const [name, setName] = useState('')
  const [type, setType] = useState('depository')
  const [ownerId, setOwnerId] = useState('')
  const [ownerError, setOwnerError] = useState('')
  const nameRef = useRef(null)

  useEffect(() => {
    nameRef.current?.focus()
  }, [])

  useEffect(() => {
    if (owners.length === 1) {
      setOwnerId(owners[0].id)
      setOwnerError('')
    }
  }, [owners])

  async function submit() {
    const trimmed = name.trim()
    if (!trimmed || creating) return
    if (owners.length > 1 && !ownerId) {
      setOwnerError('Select an owner before creating this account.')
      return
    }
    setOwnerError('')
    await onCreate({ name: trimmed, type, owner_id: ownerId || null })
    setName('')
    setType('depository')
    setOwnerId(owners.length === 1 ? owners[0]?.id || '' : '')
  }

  return (
    <div style={{ borderBottom: '1px solid var(--border)', background: 'color-mix(in srgb, var(--surface2) 65%, var(--surface))' }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: '24px minmax(0, 1.62fr) minmax(124px, 0.5fr) minmax(154px, 0.7fr) 28px',
        gap: 16,
        alignItems: 'center',
        padding: '9px 12px',
      }}>
        <div style={{ fontSize: 18, lineHeight: 1, textAlign: 'center', color: 'var(--muted)' }}>＋</div>

        <input
          ref={nameRef}
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') onCancel()
          }}
          placeholder="Account name"
          style={controlStyle({
            minWidth: 0,
            padding: '0 9px',
            fontSize: 12,
            height: 28,
            boxSizing: 'border-box',
          })}
        />

        <PillSelect
          value={type}
          options={ACCOUNT_TYPES}
          onChange={setType}
          minOpenWidth={160}
        />

        <PillSelect
          value={ownerId}
          placeholder={owners.length > 1 ? 'Owner required' : 'Owner'}
          options={owners.map(o => ({ value: o.id, label: o.name }))}
          onChange={value => {
            setOwnerId(value)
            setOwnerError('')
          }}
          minOpenWidth={138}
        />

        <button
          type="button"
          onClick={onCancel}
          title="Cancel new account"
          style={{
            background: 'none',
            border: '1px solid var(--border)',
            color: 'var(--muted)',
            cursor: 'pointer',
            fontSize: 18,
            width: 28,
            height: 28,
            lineHeight: 1,
            padding: 0,
            borderRadius: 6,
            justifySelf: 'end',
          }}
        >
          ×
        </button>
        {ownerError && (
          <div style={{ gridColumn: '2 / span 3', fontSize: 11, color: 'var(--danger)', paddingTop: 2 }}>
            {ownerError}
          </div>
        )}
      </div>
    </div>
  )
}

function AccountRow({ account, owners, onSave, onRequestDelete, confirmingDelete, onCancelDelete }) {
  const [nameDraft, setNameDraft] = useState(account.name || '')
  const [editingName, setEditingName] = useState(false)
  const [savingName, setSavingName] = useState(false)

  useEffect(() => {
    setNameDraft(account.name || '')
    setEditingName(false)
  }, [account.id, account.name])

  const typeValue = account.type || 'other'

  async function savePatch(patch) {
    await onSave(account.id, patch)
  }

  async function commitName() {
    const trimmed = nameDraft.trim()
    if (!trimmed || trimmed === account.name) {
      setEditingName(false)
      return
    }
    setSavingName(true)
    try {
      await savePatch({ name: trimmed })
    } finally {
      setSavingName(false)
      setEditingName(false)
    }
  }

  async function changeType(type) {
    if (type === typeValue) return
    await savePatch({ type })
  }

  async function changeOwner(owner_id) {
    const next = owner_id || ''
    if (next === (account.owner_id || '')) return
    await savePatch({ owner_id: next })
  }

  const displayOwnerId = account.owner_id || (owners.length === 1 ? owners[0]?.id || '' : '')

  return (
    <div style={{ position: 'relative', borderBottom: '1px solid var(--border)' }}>
      <div style={{
          display: 'grid',
          gridTemplateColumns: '24px minmax(0, 1.62fr) minmax(124px, 0.5fr) minmax(154px, 0.7fr) 28px',
        gap: 16,
        alignItems: 'center',
        padding: '9px 12px',
      }}>
        <div style={{ fontSize: 22, lineHeight: 1, textAlign: 'center', transform: 'translateY(-4px)' }}>{accountTypeIcon(typeValue)}</div>

        <div style={{ minWidth: 0 }}>
          {editingName ? (
            <input
              autoFocus
              value={nameDraft}
              onChange={e => setNameDraft(e.target.value)}
              onBlur={commitName}
              onKeyDown={e => {
                if (e.key === 'Enter') commitName()
                if (e.key === 'Escape') {
                  setNameDraft(account.name || '')
                  setEditingName(false)
                }
              }}
              style={controlStyle({
                minWidth: 0,
                padding: '0 9px',
                fontSize: 12,
                height: 28,
                boxSizing: 'border-box',
              })}
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditingName(true)}
              title="Click to edit name"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                background: 'none',
                border: 'none',
                padding: 0,
                color: 'var(--text)',
                cursor: 'text',
                minWidth: 0,
                width: '100%',
                textAlign: 'left',
              }}
            >
              <span style={{
                fontWeight: 500,
                fontSize: 13,
                lineHeight: '28px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {account.name}
              </span>
            </button>
          )}
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {account.institution && <span>{account.institution} · </span>}
            {account.mask && <span> ···{account.mask}</span>}
          </div>
        </div>

        <PillSelect
          value={typeValue}
          options={ACCOUNT_TYPES}
          onChange={changeType}
          minOpenWidth={160}
        />

        <PillSelect
          value={displayOwnerId}
          placeholder={owners.length > 1 ? 'Owner required' : (owners[0]?.name || 'Owner')}
          options={owners.map(o => ({ value: o.id, label: o.name }))}
          onChange={changeOwner}
          minOpenWidth={138}
        />

        <button
          type="button"
          onClick={() => onRequestDelete(account.id)}
          title="Delete account"
          style={{
            background: 'none',
            border: '1px solid var(--border)',
            color: 'var(--muted)',
            cursor: 'pointer',
            fontSize: 18,
            width: 28,
            height: 28,
            lineHeight: 1,
            padding: 0,
            borderRadius: 6,
            justifySelf: 'end',
          }}
        >
          ×
        </button>
      </div>

      {confirmingDelete && (
        <div style={{
          position: 'absolute',
          left: 62,
          right: 12,
          bottom: 8,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '8px 12px',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          boxShadow: '0 12px 30px rgba(0, 0, 0, 0.14)',
          fontSize: 13,
          zIndex: 10,
        }}>
          <div style={{ color: 'var(--muted)' }}>
            Remove <strong>{account.name}</strong> and all its transactions?
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button small variant="danger" onClick={() => onCancelDelete(account.id, true)}>Remove</Button>
            <Button small variant="ghost" onClick={() => onCancelDelete(account.id, false)}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function Accounts() {
  const [accounts, setAccounts] = useState([])
  const [owners, setOwners] = useState([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [showCreateAccount, setShowCreateAccount] = useState(false)
  const [creatingAccount, setCreatingAccount] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const listRef = useRef(null)

  const loadData = () => {
    setLoading(true)
    Promise.all([api.getAccounts(), api.getOwners()])
      .then(([a, o]) => {
        setAccounts(a)
        setOwners(o)
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => { loadData() }, [])

  const connectBank = async () => {
    try {
      const { link_token } = await api.getLinkToken()
      const script = document.createElement('script')
      script.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js'
      document.head.appendChild(script)
      script.onload = () => {
        const handler = window.Plaid.create({
          token: link_token,
          onSuccess: async (public_token, metadata) => {
            await api.exchangeToken(public_token, metadata.institution?.name)
            loadData()
          },
          onExit: (err) => { if (err) console.error('Plaid Link error', err) },
        })
        handler.open()
      }
    } catch (e) {
      alert('Could not start Plaid Link: ' + e.message)
    }
  }

  function openCreateAccount() {
    setContextOpen(false)
    setShowCreateAccount(true)
  }

  const createAccount = async (data) => {
    setCreatingAccount(true)
    try {
      const created = await api.createAccount(data)
      setShowCreateAccount(false)
      setAccounts(prev => [...prev, created])
      refreshTaskBadge()
    } finally {
      setCreatingAccount(false)
    }
  }

  const sync = async () => {
    setSyncing(true)
    setSyncResult(null)
    try {
      const result = await api.runSync(30)
      setSyncResult(result)
      loadData()
    } catch (e) {
      alert('Sync failed: ' + e.message)
    } finally {
      setSyncing(false)
    }
  }

  async function saveAccount(accountId, patch) {
    await api.updateAccount(accountId, patch)
    const ownerObj = owners.find(o => o.id === patch.owner_id)
    setAccounts(prev => prev.map(a => (
      a.id === accountId
        ? {
            ...a,
            ...(patch.name ? { name: patch.name } : {}),
            ...(patch.type ? { type: patch.type } : {}),
            ...(patch.owner_id !== undefined
              ? {
                  owner_id: patch.owner_id || null,
                  owner_name: ownerObj?.name ?? null,
                  owner_color: ownerObj?.color ?? null,
                }
              : {}),
          }
        : a
    )))
    refreshTaskBadge()
  }

  function requestDelete(accountId) {
    setConfirmDeleteId(accountId)
  }

  async function cancelOrConfirmDelete(accountId, confirm) {
    if (!confirm) {
      setConfirmDeleteId(null)
      return
    }
    setConfirmDeleteId(null)
    setAccounts(prev => prev.filter(a => a.id !== accountId))
    await api.deleteAccount(accountId)
    api.getAccounts().then(setAccounts)
    refreshTaskBadge()
  }

  const ownerCount = owners.length
  const unownedCount = accounts.filter(a => !a.owner_id).length
  const hasPlaidConnected = accounts.some(a => a.plaid_item_id && a.plaid_item_id !== 'csv_import' && a.plaid_item_id !== 'manual')

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '32px 32px 0', flexShrink: 0 }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 24,
          width: 'fit-content',
          maxWidth: '100%',
        }}>
          <h1 style={{ fontSize: 22, fontWeight: 600 }}>Accounts</h1>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 32px 32px' }}>
        <div
          onContextMenu={e => {
            e.preventDefault()
            setContextOpen(prev => !prev)
          }}
          style={{ position: 'relative' }}
        >
          {contextOpen && (
            <div style={{
              position: 'absolute',
              top: 0,
              left: 0,
              zIndex: 40,
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 10,
              boxShadow: '0 14px 36px rgba(0, 0, 0, 0.18)',
              padding: 6,
            }}>
              <Button small onClick={openCreateAccount}>Add account</Button>
            </div>
          )}
        </div>

        {loading ? <Spinner /> : accounts.length === 0 && !showCreateAccount ? (
          <Card style={{ width: '100%', maxWidth: 560, paddingBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 4 }}>
              <Button small onClick={() => setShowCreateAccount(prev => !prev)}>
                {showCreateAccount ? 'Close add row' : '+ Add account'}
              </Button>
            </div>
            <div style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.4, padding: '0 0 2px' }}>
              No accounts yet.
            </div>
          </Card>
        ) : (
          <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start' }}>
            <div style={{ width: 'fit-content', maxWidth: '100%', display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
              <Button small onClick={() => setShowCreateAccount(prev => !prev)}>
                {showCreateAccount ? 'Close add row' : '+ Add account'}
              </Button>
            </div>
            <Card style={{ padding: 0, overflow: 'hidden', width: 'fit-content', maxWidth: '100%', alignSelf: 'flex-start' }}>
              <div style={{
                display: 'grid',
                gridTemplateColumns: '24px minmax(0, 1.62fr) minmax(124px, 0.5fr) minmax(154px, 0.7fr) 28px',
                gap: 16,
                padding: '8px 12px',
                borderBottom: '1px solid var(--border)',
                background: 'var(--surface2)',
                alignItems: 'center',
              }}>
                <span />
                <HeaderPill>Account</HeaderPill>
                <HeaderPill style={{ marginLeft: 6 }}>Type</HeaderPill>
                <HeaderPill style={{ marginLeft: 12 }}>Owner</HeaderPill>
                <span />
              </div>
              <div ref={listRef} style={{ maxHeight: 640, overflowY: 'auto' }}>
                {accounts.map(acc => (
                  <AccountRow
                    key={acc.id}
                    account={acc}
                    owners={owners}
                    onSave={saveAccount}
                    onRequestDelete={requestDelete}
                    confirmingDelete={confirmDeleteId === acc.id}
                    onCancelDelete={cancelOrConfirmDelete}
                  />
                ))}
                {showCreateAccount && (
                  <DraftAccountRow
                    owners={owners}
                    creating={creatingAccount}
                    onCreate={createAccount}
                    onCancel={() => setShowCreateAccount(false)}
                  />
                )}
              </div>
            </Card>
          </div>
        )}

        {ownerCount > 1 && unownedCount > 0 && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginTop: 16,
            padding: '10px 16px',
            background: 'color-mix(in srgb, var(--warning, #f59e0b) 10%, var(--surface2))',
            border: '1px solid var(--border)',
            borderRadius: 8,
            fontSize: 13,
          }}>
            <span>⚠️</span>
            <span>{unownedCount} account{unownedCount > 1 ? 's' : ''} need{unownedCount === 1 ? 's' : ''} an owner assigned.</span>
          </div>
        )}

        <Card style={{ marginTop: 24, width: '100%', maxWidth: 560 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Data provider</h3>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
            <Button small onClick={connectBank}>+ Connect bank</Button>
            <Button variant="ghost" small onClick={sync} disabled={syncing}>
              {syncing ? 'Syncing…' : '↻ Sync now (30 days)'}
            </Button>
          </div>
          {syncResult && (
            <div style={{
              background: 'var(--surface2)', border: '1px solid var(--border)',
              borderRadius: 8, padding: '10px 16px', marginBottom: 12,
              fontSize: 13, color: 'var(--muted)',
            }}>
              Sync complete — {syncResult.added} added, {syncResult.updated} updated, {syncResult.skipped} skipped
            </div>
          )}
          {hasPlaidConnected ? (
            <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
              This data provider is currently running in sandbox mode. Use the provider’s test credentials when the connect dialog opens.
              Switch the provider to development mode in your <code>.env</code> when you’re ready to connect real accounts.
            </p>
          ) : (
            <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
              Connect an account data provider to keep account balances and transactions in sync.
            </p>
          )}
        </Card>
      </div>
    </div>
  )
}
