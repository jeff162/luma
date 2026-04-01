import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { refreshTaskBadge } from '../App.jsx'
import { Card, Button, Spinner, EmptyState } from '../components/ui.jsx'
import AccountDetail from '../components/AccountDetail.jsx'

const ACCOUNT_OWNERS_PREF_KEY = 'ui.accounts.accountOwnersExpanded'
const ACCOUNT_OWNERS_STORAGE_KEY_PREFIX = 'fintrack.accounts.accountOwnersExpanded'

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

function isSharedOwner(owner) {
  return !!owner?.is_shared || (owner?.name || '').trim().toLowerCase() === 'shared'
}

function getPersonalOwners(owners) {
  return owners.filter(owner => !isSharedOwner(owner))
}

function getAssignableOwners(owners) {
  const personalOwners = getPersonalOwners(owners)
  if (personalOwners.length <= 1) return personalOwners
  const sharedOwner = owners.find(isSharedOwner)
  return sharedOwner ? [...personalOwners, sharedOwner] : personalOwners
}

function HeaderPill({ children, style }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'flex-start',
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

function PillSelect({ value, options, onChange, placeholder = '—', minOpenWidth = 132, createLabel = null, onCreate = null, onContextMenu = null, disabled = false }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)
  const listRef = useRef(null)
  const [openUp, setOpenUp] = useState(false)
  const [menuPos, setMenuPos] = useState({ left: 0, top: 0, width: minOpenWidth })
  const selectedLabel = options.find(o => o.value === (value || ''))?.label || placeholder

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  useEffect(() => {
    if (!open) return
    function handleClose(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClose)
    return () => document.removeEventListener('mousedown', handleClose)
  }, [open])

  useEffect(() => {
    if (!open || !listRef.current || !wrapRef.current) return
    const rect = wrapRef.current.getBoundingClientRect()
    const listHeight = listRef.current.offsetHeight
    setMenuPos({
      left: rect.left,
      top: rect.bottom + 4,
      width: Math.max(minOpenWidth, rect.width),
    })
    setOpenUp(rect.bottom + listHeight > window.innerHeight - 8)
  }, [open, options.length])

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-flex', width: 'fit-content', maxWidth: '100%', zIndex: open ? 250 : 1 }}>
      <button
        type="button"
        onClick={() => {
          if (disabled) return
          setOpen(prev => !prev)
        }}
        onContextMenu={disabled ? undefined : onContextMenu}
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
          cursor: disabled ? 'default' : 'pointer',
          whiteSpace: 'nowrap',
          opacity: disabled ? 0.6 : 1,
        }}
        title={disabled ? undefined : 'Click to change'}
      >
        {selectedLabel}
      </button>
      {open ? (
        <div
          ref={listRef}
          style={{
            position: 'fixed',
            left: menuPos.left,
            minWidth: menuPos.width,
            width: 'max-content',
            maxWidth: 240,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            boxShadow: '0 10px 24px rgba(0, 0, 0, 0.14)',
            padding: 4,
            zIndex: 200,
            ...(openUp ? { top: Math.max(8, menuPos.top - (listRef.current?.offsetHeight || 0) - 32) } : { top: menuPos.top }),
          }}
        >
          {options.map(option => {
            const active = option.value === (value || '')
            return (
              <button
                key={option.value}
                type="button"
                onMouseDown={e => {
                  e.preventDefault()
                  onChange(option.value || '')
                  setOpen(false)
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  width: '100%',
                  textAlign: 'left',
                  background: active ? 'var(--surface2)' : 'none',
                  border: 'none',
                  color: 'var(--text)',
                  fontSize: 12,
                  padding: '7px 9px',
                  borderRadius: 7,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                <span style={{ flex: 1 }}>{option.label}</span>
                {active ? <span style={{ fontSize: 11, color: 'var(--accent2)' }}>✓</span> : null}
              </button>
            )
          })}
          {createLabel && onCreate ? (
            <>
              <div style={{ height: 1, background: 'var(--border)', margin: '4px 6px' }} />
              <button
                type="button"
                onClick={e => {
                  e.stopPropagation()
                  setOpen(false)
                  onCreate()
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  width: '100%',
                  textAlign: 'left',
                  background: 'none',
                  border: 'none',
                  color: 'var(--accent2)',
                  fontSize: 12,
                  padding: '7px 9px',
                  borderRadius: 7,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  fontWeight: 600,
                }}
              >
                {createLabel}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function DraftAccountRow({ owners, onCreate, onCancel, creating }) {
  const formId = 'draft-account-form'
  const [name, setName] = useState('')
  const [type, setType] = useState('depository')
  const [ownerId, setOwnerId] = useState('')
  const [ownerError, setOwnerError] = useState('')
  const nameRef = useRef(null)
  const personalOwners = getPersonalOwners(owners)
  const assignableOwners = getAssignableOwners(owners)

  useEffect(() => {
    nameRef.current?.focus()
  }, [])

  useEffect(() => {
    if (personalOwners.length === 1) {
      setOwnerId(personalOwners[0].id)
      setOwnerError('')
    }
  }, [personalOwners])

  async function submit() {
    const trimmed = name.trim()
    if (!trimmed || creating) return
    if (personalOwners.length > 1 && !ownerId) {
      setOwnerError('Select an owner before creating this account.')
      return
    }
    setOwnerError('')
    await onCreate({ name: trimmed, type, owner_id: ownerId || null })
    setName('')
    setType('depository')
    setOwnerId(personalOwners.length === 1 ? personalOwners[0]?.id || '' : '')
  }

  return (
    <div style={{ position: 'relative', borderBottom: '1px solid var(--border)', background: 'color-mix(in srgb, var(--surface2) 65%, var(--surface))' }}>
      <form
        id={formId}
        onSubmit={e => {
          e.preventDefault()
          submit()
        }}
      >
      <div style={{
        display: 'grid',
        gridTemplateColumns: '24px minmax(0, 1.5fr) minmax(118px, 0.46fr) minmax(138px, 0.56fr) 28px',
        gap: 12,
        alignItems: 'center',
        padding: '9px 10px',
      }}>
        <div style={{ fontSize: 22, lineHeight: 1, textAlign: 'center', transform: 'translateY(-4px)' }}>
          {accountTypeIcon(type)}
        </div>

        <div style={{ minWidth: 0 }}>
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
        </div>

        <PillSelect
          value={type}
          options={ACCOUNT_TYPES}
          onChange={setType}
          minOpenWidth={160}
        />

        <div style={{ display: 'flex', justifyContent: 'center', minWidth: 0 }}>
          <PillSelect
            value={ownerId}
            placeholder={personalOwners.length > 1 ? 'Owner required' : 'Owner'}
            options={assignableOwners.map(o => ({ value: o.id, label: o.name }))}
            onChange={value => {
              setOwnerId(value)
              setOwnerError('')
            }}
            minOpenWidth={138}
          />
        </div>

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
      </div>
      {ownerError && (
        <div style={{ padding: '0 10px 2px 46px', fontSize: 11, color: 'var(--danger)' }}>
          {ownerError}
        </div>
      )}
      </form>
    </div>
  )
}

function OwnerPill({ owner, editing, draft, onDraftChange, onStartEdit, onCommitEdit, onCancelEdit, onContextMenu }) {
  const shared = isSharedOwner(owner)
  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={e => onDraftChange(e.target.value)}
        onBlur={onCommitEdit}
        onKeyDown={e => {
          if (e.key === 'Enter') onCommitEdit()
          if (e.key === 'Escape') onCancelEdit()
        }}
        style={controlStyle({
          width: Math.max(78, draft.length * 8 + 28),
          minWidth: 78,
          maxWidth: 180,
          height: 28,
          padding: '0 10px',
          borderRadius: 999,
          fontSize: 12,
          boxSizing: 'border-box',
        })}
      />
    )
  }

  return (
    <button
      type="button"
      onClick={onStartEdit}
      onContextMenu={shared ? (e => e.preventDefault()) : onContextMenu}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 28,
        padding: '0 10px',
        borderRadius: 999,
        border: '1px solid var(--border)',
        background: 'var(--surface2)',
        color: 'var(--text)',
        fontSize: 12,
        fontStyle: shared ? 'italic' : 'normal',
        cursor: shared ? 'default' : 'text',
        whiteSpace: 'nowrap',
        opacity: shared ? 0.86 : 1,
      }}
      title={shared ? 'Built-in shared owner' : 'Click to rename'}
      disabled={shared}
    >
      {owner.name}
    </button>
  )
}

function OwnersPanel({ owners, onCreateOwner, onSaveOwner, onDeleteOwner, disabled = false, width, expanded, onExpandedChange }) {
  const [editingOwnerId, setEditingOwnerId] = useState(null)
  const [ownerDraft, setOwnerDraft] = useState('')
  const [creatingOwner, setCreatingOwner] = useState(false)
  const [newOwnerDraft, setNewOwnerDraft] = useState('')
  const [ownerMenu, setOwnerMenu] = useState(null)
  const newOwnerInputRef = useRef(null)

  useEffect(() => {
    if (disabled) {
      setExpanded(false)
      setEditingOwnerId(null)
      setOwnerDraft('')
      setCreatingOwner(false)
      setNewOwnerDraft('')
      setOwnerMenu(null)
    }
  }, [disabled])

  useEffect(() => {
    if (!ownerMenu) return
    function handleClose() {
      setOwnerMenu(null)
    }
    window.addEventListener('mousedown', handleClose)
    window.addEventListener('blur', handleClose)
    return () => {
      window.removeEventListener('mousedown', handleClose)
      window.removeEventListener('blur', handleClose)
    }
  }, [ownerMenu])

  useLayoutEffect(() => {
    if (!creatingOwner) return
    const id = requestAnimationFrame(() => {
      newOwnerInputRef.current?.focus()
      newOwnerInputRef.current?.select?.()
    })
    return () => cancelAnimationFrame(id)
  }, [creatingOwner])

  async function commitEdit() {
    const trimmed = ownerDraft.trim()
    const current = owners.find(o => o.id === editingOwnerId)
    if (!current) {
      setEditingOwnerId(null)
      setOwnerDraft('')
      return
    }
    if (!trimmed || trimmed === current.name) {
      setEditingOwnerId(null)
      setOwnerDraft('')
      return
    }
    await onSaveOwner(current.id, { name: trimmed })
    setEditingOwnerId(null)
    setOwnerDraft('')
  }

  async function submitNewOwner() {
    const trimmed = newOwnerDraft.trim()
    if (!trimmed) return
    await onCreateOwner(trimmed)
    setCreatingOwner(false)
    setNewOwnerDraft('')
  }

  return (
    <Card style={{
      marginTop: 16,
      width: width ? `${width}px` : 'fit-content',
      maxWidth: '100%',
      opacity: disabled ? 0.55 : 1,
      pointerEvents: disabled ? 'none' : 'auto',
      padding: '12px 16px 14px',
    }}>
      <button
        type="button"
        onClick={() => onExpandedChange?.(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-start',
          gap: 8,
          width: '100%',
          background: 'none',
          border: 'none',
          padding: 0,
          color: 'var(--text)',
          cursor: 'pointer',
        }}
      >
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{expanded ? '−' : '+'}</span>
        <span style={{ fontSize: 14, fontWeight: 600 }}>Account Owners</span>
      </button>
      {expanded ? (
        <div style={{ marginTop: 12, paddingLeft: 20 }}>
          {owners.length > 0 ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              {owners.map(owner => (
                <OwnerPill
                  key={owner.id}
                  owner={owner}
                  editing={editingOwnerId === owner.id}
                  draft={ownerDraft}
                  onDraftChange={setOwnerDraft}
                  onStartEdit={() => {
                    setEditingOwnerId(owner.id)
                    setOwnerDraft(owner.name)
                    setCreatingOwner(false)
                    setNewOwnerDraft('')
                  }}
                  onCommitEdit={commitEdit}
                  onCancelEdit={() => {
                    setEditingOwnerId(null)
                    setOwnerDraft('')
                  }}
                  onContextMenu={e => {
                    e.preventDefault()
                    setOwnerMenu({ x: e.clientX, y: e.clientY, owner })
                  }}
                />
              ))}
              {creatingOwner ? (
                <div style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 8px',
                  borderRadius: 999,
                  border: '1px solid var(--border)',
                  background: 'color-mix(in srgb, var(--surface2) 74%, var(--surface))',
                }}>
                  <input
                    ref={newOwnerInputRef}
                    value={newOwnerDraft}
                    onChange={e => setNewOwnerDraft(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') submitNewOwner()
                      if (e.key === 'Escape') {
                        setCreatingOwner(false)
                        setNewOwnerDraft('')
                      }
                    }}
                    placeholder="name"
                    style={controlStyle({
                      width: 104,
                      minWidth: 0,
                      background: 'var(--surface)',
                      border: '1px solid var(--accent)',
                      borderRadius: 999,
                      padding: '0 8px',
                      fontSize: 11,
                      height: 24,
                      boxSizing: 'border-box',
                    })}
                  />
                  <Button small onClick={submitNewOwner} disabled={!newOwnerDraft.trim()} style={{ height: 24, padding: '0 10px', borderRadius: 999, fontSize: 11 }}>
                    Add
                  </Button>
                  <Button
                    small
                    variant="ghost"
                    style={{ height: 24, padding: '0 9px', borderRadius: 999, fontSize: 11 }}
                    onClick={() => {
                      setCreatingOwner(false)
                      setNewOwnerDraft('')
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  small
                  variant="ghost"
                  onClick={() => {
                    setEditingOwnerId(null)
                    setOwnerDraft('')
                    setCreatingOwner(true)
                  }}
                  style={{ height: 28, borderRadius: 999 }}
                >
                  +New owner
                </Button>
              )}
            </div>
          ) : creatingOwner ? (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input
                ref={newOwnerInputRef}
                value={newOwnerDraft}
                onChange={e => setNewOwnerDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') submitNewOwner()
                  if (e.key === 'Escape') {
                    setCreatingOwner(false)
                    setNewOwnerDraft('')
                  }
                }}
                placeholder="name"
                style={controlStyle({
                  width: 104,
                  minWidth: 0,
                  background: 'var(--surface)',
                  border: '1px solid var(--accent)',
                  borderRadius: 999,
                  padding: '0 8px',
                  fontSize: 11,
                  height: 24,
                  boxSizing: 'border-box',
                })}
              />
              <Button small onClick={submitNewOwner} disabled={!newOwnerDraft.trim()} style={{ height: 24, padding: '0 10px', borderRadius: 999, fontSize: 11 }}>
                Add
              </Button>
              <Button
                small
                variant="ghost"
                style={{ height: 24, padding: '0 9px', borderRadius: 999, fontSize: 11 }}
                onClick={() => {
                  setCreatingOwner(false)
                  setNewOwnerDraft('')
                }}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button small variant="ghost" onClick={() => setCreatingOwner(true)} style={{ height: 28, borderRadius: 999 }}>
              +New owner
            </Button>
          )}
          {ownerMenu ? (
            <div
              onMouseDown={e => e.stopPropagation()}
              style={{
                position: 'fixed',
                left: Math.min(ownerMenu.x, window.innerWidth - 160),
                top: Math.min(ownerMenu.y, window.innerHeight - 100),
                zIndex: 260,
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 10,
                boxShadow: '0 14px 36px rgba(0,0,0,0.18)',
                padding: 4,
                minWidth: 150,
              }}
            >
              <button
                onClick={() => {
                  if (isSharedOwner(ownerMenu.owner)) {
                    setOwnerMenu(null)
                    return
                  }
                  setOwnerMenu(null)
                  setCreatingOwner(false)
                  setEditingOwnerId(ownerMenu.owner.id)
                  setOwnerDraft(ownerMenu.owner.name)
                }}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  background: 'none', border: 'none', color: 'var(--text)',
                  fontSize: 13, padding: '8px 10px', borderRadius: 6, cursor: 'pointer',
                }}
              >
                Rename
              </button>
              <button
                onClick={async () => {
                  const owner = ownerMenu.owner
                  setOwnerMenu(null)
                  if (isSharedOwner(owner)) return
                  await onDeleteOwner(owner)
                }}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  background: 'none', border: 'none', color: 'var(--danger)',
                  fontSize: 13, padding: '8px 10px', borderRadius: 6, cursor: 'pointer',
                }}
              >
                Delete
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  )
}

function AccountRow({ account, owners, onSave, onRequestDelete, confirmingDelete, onCancelDelete, onOpenDetail, onCreateOwnerForAccount, onRenameOwner, onDeleteOwner, interactionDisabled = false }) {
  const [nameDraft, setNameDraft] = useState(account.name || '')
  const [editingName, setEditingName] = useState(false)
  const [savingName, setSavingName] = useState(false)
  const [creatingOwner, setCreatingOwner] = useState(false)
  const [ownerDraft, setOwnerDraft] = useState('')
  const [showOwnerCreate, setShowOwnerCreate] = useState(false)
  const [ownerCreatePos, setOwnerCreatePos] = useState(null)
  const [ownerMenu, setOwnerMenu] = useState(null)
  const rowRef = useRef(null)
  const ownerCreateRef = useRef(null)
  const ownerInputRef = useRef(null)
  const ownerAnchorRef = useRef(null)

  useEffect(() => {
    setNameDraft(account.name || '')
    setEditingName(false)
  }, [account.id, account.name])

  useEffect(() => {
    if (interactionDisabled) setEditingName(false)
  }, [interactionDisabled])

  useEffect(() => {
    if (!interactionDisabled) return
    setShowOwnerCreate(false)
    setOwnerDraft('')
    setOwnerCreatePos(null)
    setOwnerMenu(null)
  }, [interactionDisabled])

  useLayoutEffect(() => {
    if (!showOwnerCreate) return
    if (ownerAnchorRef.current) {
      const rect = ownerAnchorRef.current.getBoundingClientRect()
      setOwnerCreatePos({
        left: rect.left,
        top: rect.top + rect.height / 2,
      })
    }
    const focusId = requestAnimationFrame(() => {
      ownerInputRef.current?.focus()
      ownerInputRef.current?.select?.()
    })
    function handleClose(e) {
      if (ownerCreateRef.current?.contains(e.target)) return
      setShowOwnerCreate(false)
      setOwnerDraft('')
      setOwnerCreatePos(null)
    }
    function updatePosition() {
      if (!ownerAnchorRef.current) return
      const rect = ownerAnchorRef.current.getBoundingClientRect()
      setOwnerCreatePos({
        left: rect.left,
        top: rect.top + rect.height / 2,
      })
    }
    document.addEventListener('mousedown', handleClose)
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      cancelAnimationFrame(focusId)
      document.removeEventListener('mousedown', handleClose)
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [showOwnerCreate])

  useEffect(() => {
    if (!ownerMenu) return
    function handleClose() {
      setOwnerMenu(null)
    }
    window.addEventListener('mousedown', handleClose)
    window.addEventListener('blur', handleClose)
    return () => {
      window.removeEventListener('mousedown', handleClose)
      window.removeEventListener('blur', handleClose)
    }
  }, [ownerMenu])

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

  async function submitCreateOwner() {
    const trimmed = ownerDraft.trim()
    if (!trimmed || creatingOwner) return
    setShowOwnerCreate(false)
    setOwnerDraft('')
    setCreatingOwner(true)
    try {
      await onCreateOwnerForAccount(account.id, trimmed)
    } finally {
      setCreatingOwner(false)
    }
  }

  async function handleRenameOwner() {
    if (!account.owner_id) return
    const current = owners.find(o => o.id === account.owner_id)
    if (isSharedOwner(current)) return
    const next = window.prompt('Rename owner', current?.name || account.owner_name || '')
    setOwnerMenu(null)
    if (!next || !next.trim()) return
    const trimmed = next.trim()
    await onRenameOwner(account.owner_id, trimmed)
  }

  async function handleDeleteOwner() {
    if (!account.owner_id) return
    const current = owners.find(o => o.id === account.owner_id)
    if (isSharedOwner(current)) return
    setOwnerMenu(null)
    if (!window.confirm(`Delete owner "${current?.name || account.owner_name || 'owner'}"? Their accounts and categories will become unassigned.`)) return
    await onDeleteOwner(current || { id: account.owner_id, name: account.owner_name || 'owner' })
  }

  const displayOwnerId = account.owner_id || ''
  const personalOwners = getPersonalOwners(owners)
  const assignableOwners = getAssignableOwners(owners)

  return (
    <div ref={rowRef} style={{ position: 'relative', borderBottom: '1px solid var(--border)' }}>
      <div style={{
          display: 'grid',
          gridTemplateColumns: '24px minmax(0, 1.5fr) minmax(118px, 0.46fr) minmax(138px, 0.56fr) 28px',
        gap: 12,
        alignItems: 'center',
        padding: '9px 10px',
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
              onClick={() => {
                if (interactionDisabled) return
                setEditingName(true)
              }}
              title={interactionDisabled ? undefined : 'Click to edit name'}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                background: 'none',
                border: 'none',
                padding: 0,
                color: 'var(--text)',
                cursor: interactionDisabled ? 'default' : 'text',
                minWidth: 0,
                width: '100%',
                textAlign: 'left',
                opacity: interactionDisabled ? 0.75 : 1,
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
              <span
                onClick={e => {
                  e.stopPropagation()
                  if (interactionDisabled) return
                  onOpenDetail?.({ id: account.id, name: account.name, mask: account.mask })
                }}
                title={interactionDisabled ? undefined : 'View account detail'}
                style={{
                  color: 'var(--accent2)',
                  cursor: interactionDisabled ? 'default' : 'pointer',
                  fontSize: 11,
                  padding: '3px 5px',
                  opacity: interactionDisabled ? 0.4 : 0.75,
                  lineHeight: 1,
                  flexShrink: 0,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 6,
                }}
              >
                ↗
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
          disabled={interactionDisabled}
        />

        <div ref={ownerAnchorRef} style={{ display: 'flex', justifyContent: 'center', minWidth: 0, position: 'relative' }}>
          {assignableOwners.length > 0 ? (
            <PillSelect
              value={displayOwnerId}
              placeholder="Assign owner"
              options={assignableOwners.map(o => ({ value: o.id, label: o.name }))}
              onChange={changeOwner}
              minOpenWidth={138}
              createLabel="Create owner..."
              onCreate={() => {
                setOwnerDraft('')
                setShowOwnerCreate(true)
              }}
              onContextMenu={account.owner_id && !isSharedOwner(owners.find(o => o.id === account.owner_id)) ? (e => {
                e.preventDefault()
                setOwnerMenu({ x: e.clientX, y: e.clientY })
              }) : null}
              disabled={interactionDisabled}
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                if (interactionDisabled) return
                setOwnerDraft('')
                setShowOwnerCreate(true)
              }}
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
                cursor: interactionDisabled ? 'default' : 'pointer',
                whiteSpace: 'nowrap',
                opacity: interactionDisabled ? 0.6 : 1,
              }}
              title={interactionDisabled ? undefined : 'Create and assign owner'}
            >
              Assign owner
            </button>
          )}
          {showOwnerCreate ? (
            <div
              ref={ownerCreateRef}
              onMouseDown={e => e.stopPropagation()}
              style={{
                position: 'fixed',
                left: ownerCreatePos?.left ?? 0,
                top: ownerCreatePos?.top ?? 0,
                transform: 'translateY(-50%)',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                minWidth: 220,
                padding: '6px 8px',
                background: 'color-mix(in srgb, var(--surface2) 74%, var(--surface))',
                border: '1px solid var(--border)',
                borderRadius: 999,
                boxShadow: '0 12px 26px rgba(0, 0, 0, 0.16)',
                zIndex: 260,
                visibility: ownerCreatePos ? 'visible' : 'hidden',
              }}
            >
              <input
                ref={ownerInputRef}
                value={ownerDraft}
                onChange={e => setOwnerDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') submitCreateOwner()
                  if (e.key === 'Escape') {
                    setShowOwnerCreate(false)
                    setOwnerDraft('')
                  }
                }}
                placeholder="name"
                style={controlStyle({
                  width: 104,
                  minWidth: 0,
                  background: 'var(--surface)',
                  border: '1px solid var(--accent)',
                  borderRadius: 999,
                  padding: '0 8px',
                  fontSize: 11,
                  height: 24,
                  boxSizing: 'border-box',
                })}
              />
              <Button
                small
                onClick={submitCreateOwner}
                disabled={!ownerDraft.trim() || creatingOwner}
                style={{ height: 24, padding: '0 10px', borderRadius: 999, fontSize: 11 }}
              >
                {creatingOwner ? 'Adding...' : 'Add'}
              </Button>
              <Button
                small
                variant="ghost"
                style={{ height: 24, padding: '0 9px', borderRadius: 999, fontSize: 11 }}
                onClick={() => {
                  setShowOwnerCreate(false)
                  setOwnerDraft('')
                }}
              >
                Cancel
              </Button>
            </div>
          ) : null}
          {ownerMenu ? (
            <div
              onMouseDown={e => e.stopPropagation()}
              style={{
                position: 'fixed',
                left: Math.min(ownerMenu.x, window.innerWidth - 160),
                top: Math.min(ownerMenu.y, window.innerHeight - 100),
                zIndex: 260,
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 10,
                boxShadow: '0 14px 36px rgba(0,0,0,0.18)',
                padding: 4,
                minWidth: 150,
              }}
            >
              <button
                onClick={handleRenameOwner}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  background: 'none', border: 'none', color: 'var(--text)',
                  fontSize: 13, padding: '8px 10px', borderRadius: 6, cursor: 'pointer',
                }}
              >
                Rename
              </button>
              <button
                onClick={handleDeleteOwner}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  background: 'none', border: 'none', color: 'var(--danger)',
                  fontSize: 13, padding: '8px 10px', borderRadius: 6, cursor: 'pointer',
                }}
              >
                Delete
              </button>
              <div style={{ height: 1, background: 'var(--border)', margin: '4px 6px' }} />
              <button
                onClick={() => {
                  setOwnerMenu(null)
                  setOwnerDraft('')
                  setShowOwnerCreate(true)
                }}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  background: 'none', border: 'none', color: 'var(--accent2)',
                  fontSize: 13, padding: '8px 10px', borderRadius: 6, cursor: 'pointer',
                  fontWeight: 600,
                }}
              >
                +New owner
              </button>
            </div>
          ) : null}
        </div>

        <button
          type="button"
          onClick={() => {
            if (interactionDisabled) return
            onRequestDelete(account.id)
          }}
          title={interactionDisabled ? undefined : 'Delete account'}
          style={{
            background: 'none',
            border: '1px solid var(--border)',
            color: 'var(--muted)',
            cursor: interactionDisabled ? 'default' : 'pointer',
            fontSize: 18,
            width: 28,
            height: 28,
            lineHeight: 1,
            padding: 0,
            borderRadius: 6,
            justifySelf: 'end',
            opacity: interactionDisabled ? 0.45 : 1,
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
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [showCreateAccount, setShowCreateAccount] = useState(false)
  const [creatingAccount, setCreatingAccount] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const [detailAccount, setDetailAccount] = useState(null)
  const [dbInstanceId, setDbInstanceId] = useState('')
  const [userId, setUserId] = useState('')
  const [ownersPanelExpanded, setOwnersPanelExpanded] = useState(false)
  const [ownersPanelStateLoaded, setOwnersPanelStateLoaded] = useState(false)
  const listRef = useRef(null)
  const accountsPanelRef = useRef(null)
  const [accountsPanelWidth, setAccountsPanelWidth] = useState(null)

  const loadData = () => {
    setLoading(true)
    Promise.all([api.getAccounts(), api.getOwners(), api.getCategories()])
      .then(([a, o, c]) => {
        setAccounts(a)
        setOwners(o)
        setCategories(c)
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => { loadData() }, [])

  useEffect(() => {
    let cancelled = false
    Promise.all([
      api.getAuthStatus().catch(() => null),
      api.getUserPreferences().catch(() => ({ preferences: {} })),
    ]).then(([status, prefResp]) => {
      if (cancelled) return
      const nextDbInstanceId = status?.db_instance_id || ''
      const nextUserId = status?.selected_local_profile_id || status?.user?.id || status?.user_id || ''
      setDbInstanceId(nextDbInstanceId)
      setUserId(nextUserId)

      const prefValue = prefResp?.preferences?.[ACCOUNT_OWNERS_PREF_KEY]
      const storageKey = nextDbInstanceId && nextUserId
        ? `${ACCOUNT_OWNERS_STORAGE_KEY_PREFIX}.${nextDbInstanceId}.${nextUserId}`
        : ''

      if (typeof prefValue === 'boolean') {
        setOwnersPanelExpanded(prefValue)
      } else if (storageKey) {
        try {
          const raw = window.localStorage.getItem(storageKey)
          if (raw !== null) {
            setOwnersPanelExpanded(raw === 'true')
          }
        } catch {
          // Ignore storage failures in restricted environments.
        }
      }

      setOwnersPanelStateLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!ownersPanelStateLoaded) return
    const storageKey = dbInstanceId && userId
      ? `${ACCOUNT_OWNERS_STORAGE_KEY_PREFIX}.${dbInstanceId}.${userId}`
      : ''
    if (storageKey) {
      try {
        window.localStorage.setItem(storageKey, ownersPanelExpanded ? 'true' : 'false')
      } catch {
        // Ignore storage failures in restricted environments.
      }
    }
    api.saveUserPreference(ACCOUNT_OWNERS_PREF_KEY, ownersPanelExpanded).catch(() => {})
  }, [dbInstanceId, userId, ownersPanelExpanded, ownersPanelStateLoaded])

  useEffect(() => {
    if (!accountsPanelRef.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => {
      const entry = entries[0]
      if (!entry) return
      setAccountsPanelWidth(Math.round(entry.contentRect.width))
    })
    observer.observe(accountsPanelRef.current)
    return () => observer.disconnect()
  }, [loading, showCreateAccount, accounts.length])

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

  async function saveOwner(ownerId, data) {
    await api.updateOwner(ownerId, data)
    setOwners(prev => prev.map(o => o.id === ownerId ? { ...o, ...data } : o))
    if (data.name !== undefined) {
      setAccounts(prev => prev.map(account => (
        account.owner_id === ownerId
          ? { ...account, owner_name: data.name }
          : account
      )))
    }
  }

  async function deleteOwner(owner) {
    if (!confirm(`Delete owner "${owner.name}"? Their accounts and categories will become unassigned.`)) return
    await api.deleteOwner(owner.id)
    loadData()
    refreshTaskBadge()
  }

  async function createOwner(name) {
    const owner = await api.createOwner({ name })
    setOwners(prev => [...prev, owner])
    refreshTaskBadge()
    return owner
  }

  async function createOwnerForAccount(accountId, name) {
    const owner = await createOwner(name)
    await api.updateAccount(accountId, { owner_id: owner.id })
    setAccounts(prev => prev.map(account => (
      account.id === accountId
        ? { ...account, owner_id: owner.id, owner_name: owner.name, owner_color: owner.color ?? null }
        : account
    )))
    refreshTaskBadge()
  }

  const ownerCount = owners.length
  const unownedCount = accounts.filter(a => !a.owner_id).length
  const hasPlaidConnected = accounts.some(a => a.plaid_item_id && a.plaid_item_id !== 'csv_import' && a.plaid_item_id !== 'manual')

  return (
    <div data-browser-context-passthrough="true" style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
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

      <div data-browser-context-passthrough="true" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 32px 32px' }}>
        <div
          onContextMenu={e => {
            if (showCreateAccount) return
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
          <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', width: '100%', maxWidth: 560 }}>
            <Card style={{ width: '100%', paddingBottom: 12 }}>
            <div style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.4, padding: '0 0 2px' }}>
              No accounts yet.
            </div>
            </Card>
            <div style={{ width: '100%', display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
              <Button small onClick={() => setShowCreateAccount(true)}>
                +New account
              </Button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start' }}>
            <div ref={accountsPanelRef} style={{ position: 'relative', width: 'fit-content', maxWidth: '100%' }}>
            <Card style={{ padding: 0, overflow: 'hidden', width: 'fit-content', maxWidth: '100%', alignSelf: 'flex-start' }}>
              <div style={{
                display: 'grid',
                gridTemplateColumns: '24px minmax(0, 1.5fr) minmax(118px, 0.46fr) minmax(138px, 0.56fr) 28px',
                gap: 12,
                padding: '8px 10px',
                borderBottom: '1px solid var(--border)',
                background: 'var(--surface2)',
                alignItems: 'center',
              }}>
                <span />
                <HeaderPill>Account</HeaderPill>
                <HeaderPill style={{ marginLeft: 6 }}>Type</HeaderPill>
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <HeaderPill>Owner</HeaderPill>
                </div>
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
                    onOpenDetail={setDetailAccount}
                    onCreateOwnerForAccount={createOwnerForAccount}
                    onRenameOwner={async (ownerId, name) => saveOwner(ownerId, { name })}
                    onDeleteOwner={deleteOwner}
                    interactionDisabled={showCreateAccount}
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
            {showCreateAccount && (
              <div
                style={{
                  position: 'absolute',
                  left: 'calc(100% + 8px)',
                  top: 'calc(100% - 48px)',
                  display: 'flex',
                  alignItems: 'center',
                  padding: '7px 8px',
                  background: 'color-mix(in srgb, var(--surface2) 65%, var(--surface))',
                  border: '1px solid var(--border)',
                  borderRadius: 14,
                  boxShadow: '0 10px 24px rgba(0, 0, 0, 0.10)',
                }}
              >
                <button
                  type="submit"
                  form="draft-account-form"
                  style={{
                    padding: '6px 14px',
                    borderRadius: 10,
                    border: 'none',
                    cursor: creatingAccount ? 'not-allowed' : 'pointer',
                    fontSize: 13,
                    fontWeight: 500,
                    transition: 'opacity 0.15s',
                    opacity: creatingAccount ? 0.5 : 1,
                    background: 'var(--accent)',
                    color: '#fff',
                  }}
                  disabled={creatingAccount}
                >
                  {creatingAccount ? 'Adding...' : 'Add'}
                </button>
              </div>
            )}
            </div>
            <div style={{ width: '100%', display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
              <Button small onClick={() => setShowCreateAccount(true)} disabled={showCreateAccount}>
                +New account
              </Button>
            </div>
          </div>
        )}

        {ownerCount > 0 && unownedCount > 0 && (
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
            opacity: showCreateAccount ? 0.55 : 1,
            pointerEvents: showCreateAccount ? 'none' : 'auto',
          }}>
            <span>⚠️</span>
            <span>{unownedCount} account{unownedCount > 1 ? 's' : ''} need{unownedCount === 1 ? 's' : ''} an owner assigned.</span>
          </div>
        )}

        <Card style={{
          marginTop: 24,
          width: accountsPanelWidth ? `${accountsPanelWidth}px` : 'fit-content',
          maxWidth: '100%',
          opacity: showCreateAccount ? 0.55 : 1,
          pointerEvents: showCreateAccount ? 'none' : 'auto',
        }}>
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

        <OwnersPanel
          owners={owners}
          onCreateOwner={createOwner}
          onSaveOwner={saveOwner}
          onDeleteOwner={deleteOwner}
          disabled={showCreateAccount}
          width={accountsPanelWidth}
          expanded={ownersPanelExpanded}
          onExpandedChange={setOwnersPanelExpanded}
        />

        {detailAccount && (
          <AccountDetail
            account={detailAccount}
            categories={categories}
            onClose={() => setDetailAccount(null)}
          />
        )}
      </div>
    </div>
  )
}
