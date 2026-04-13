// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { refreshTaskBadge } from '../App.jsx'
import { Card, Button, Spinner, AppConfirmDialog, AppNoticeDialog, AppTextEntryDialog } from '../components/ui.jsx'
import AccountDetail from '../components/AccountDetail.jsx'
import { useDismissibleLayer, useDismissiblePopup, useTransientTextEdit } from '../lib/uiInteractions.js'
import TransientTextInput from '../components/TransientTextInput.jsx'
import { ACCOUNT_TYPES } from '../lib/accountTypes.js'

const ACCOUNTS_SECTIONS_PREF_KEY = 'ui.accounts.sections'
const ACCOUNTS_SECTIONS_STORAGE_KEY_PREFIX = 'fintrack.accounts.sections'
const LEGACY_ACCOUNT_OWNERS_PREF_KEY = 'ui.accounts.accountOwnersExpanded'
const LEGACY_ACCOUNT_OWNERS_STORAGE_KEY_PREFIX = 'fintrack.accounts.accountOwnersExpanded'
const ACCOUNT_ROW_COLUMNS = '22px 24px minmax(0, 1.5fr) minmax(118px, 0.46fr) minmax(138px, 0.56fr) 28px'
const ACCOUNT_ROW_GAP = 10
const ACCOUNT_ROW_PADDING = '6px 10px'
const ACCOUNT_CONTROL_HEIGHT = 26
const ACCOUNT_SECTION_DEFAULTS = {
  accountList: true,
  dataSources: true,
  accountOwners: true,
}


function accountTypeIcon(type) {
  const map = { depository: '🏦', credit: '💳', investment: '📈', loan: '🏠', other: '📁' }
  return map[type] || '🏦'
}

function hasSameMergeFields(source, target) {
  return (source?.owner_id || '') === (target?.owner_id || '') && (source?.type || 'other') === (target?.type || 'other')
}

// "Shared" only becomes an assignable owner when there are multiple personal owners; otherwise it would just duplicate the sole-owner default.
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

function getAccountsSectionsStorageKey(dbInstanceId, userId) {
  return dbInstanceId && userId
    ? `${ACCOUNTS_SECTIONS_STORAGE_KEY_PREFIX}.${dbInstanceId}.${userId}`
    : ''
}

function getLegacyAccountOwnersStorageKey(dbInstanceId, userId) {
  return dbInstanceId && userId
    ? `${LEGACY_ACCOUNT_OWNERS_STORAGE_KEY_PREFIX}.${dbInstanceId}.${userId}`
    : ''
}

function isObjectLike(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function getSectionExpanded(sectionState, sectionKey) {
  return sectionState?.[sectionKey] ?? ACCOUNT_SECTION_DEFAULTS[sectionKey] ?? true
}

function formatCountSummary(count, singular, plural = `${singular}s`) {
  if (!count) return `No ${plural}`
  return `${count} ${count === 1 ? singular : plural}`
}

function SectionCard({ title, summary = '', headerCenter = null, expanded, onExpandedChange, disabled = false, width, children, style }) {
  return (
    <Card style={{
      width: width ? `${width}px` : 'fit-content',
      maxWidth: '100%',
      opacity: disabled ? 0.55 : 1,
      pointerEvents: disabled ? 'none' : 'auto',
      padding: 0,
      ...style,
    }}>
      <button
        type="button"
        onClick={() => onExpandedChange?.(!expanded)}
        style={{
          display: 'grid',
          alignItems: 'center',
          gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)',
          columnGap: 12,
          width: '100%',
          background: 'none',
          border: 'none',
          padding: '12px 16px',
          color: 'var(--text)',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0, justifySelf: 'start' }}>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>{expanded ? '−' : '+'}</span>
          <span style={{ fontSize: 14, fontWeight: 600 }}>{title}</span>
        </span>
        <span style={{ minWidth: 0, justifySelf: 'center' }}>
          {headerCenter}
        </span>
        {summary ? (
          <span style={{
            fontSize: 12,
            color: 'var(--muted)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            justifySelf: 'end',
          }}>
            {summary}
          </span>
        ) : <span />}
      </button>
      {expanded ? (
        <div style={{ borderTop: '1px solid var(--border)' }}>
          {children}
        </div>
      ) : null}
    </Card>
  )
}

function HeaderPill({ children, style }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'flex-start',
      width: 'fit-content',
      minWidth: 0,
      height: 20,
      padding: '0 9px',
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
  const [menuPos, setMenuPos] = useState({ left: 0, top: 0, width: minOpenWidth })
  const selectedLabel = options.find(o => o.value === (value || ''))?.label || placeholder

  const { openUp } = useDismissiblePopup({
    open,
    setOpen,
    anchorRef: wrapRef,
    popupRef: listRef,
    placementDeps: [options.length],
    disabled,
  })

  useEffect(() => {
    if (!open || !listRef.current || !wrapRef.current) return
    const rect = wrapRef.current.getBoundingClientRect()
    setMenuPos({
      left: rect.left,
      top: rect.bottom + 4,
      width: Math.max(minOpenWidth, rect.width),
    })
  }, [minOpenWidth, open, options.length])

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
          height: ACCOUNT_CONTROL_HEIGHT,
          background: 'var(--surface2)',
          color: 'var(--text)',
          border: '1px solid var(--border)',
          borderRadius: 999,
          padding: '0 8px',
          fontSize: 11,
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
        gridTemplateColumns: ACCOUNT_ROW_COLUMNS,
        gap: ACCOUNT_ROW_GAP,
        alignItems: 'center',
        padding: ACCOUNT_ROW_PADDING,
      }}>
        <div />
        <div style={{ fontSize: 20, lineHeight: 1, textAlign: 'center', transform: 'translateY(-2px)' }}>
          {accountTypeIcon(type)}
        </div>

        <div style={{ minWidth: 0 }}>
          <TransientTextInput
            ref={nameRef}
            value={name}
            onChange={setName}
            onCommit={submit}
            onCancel={onCancel}
            restoreOnEscape
            onBlurCommit={false}
            placeholder="Account name"
            style={controlStyle({
              minWidth: 0,
              padding: '0 9px',
              fontSize: 12,
              height: ACCOUNT_CONTROL_HEIGHT,
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
            fontSize: 16,
            width: 28,
            height: ACCOUNT_CONTROL_HEIGHT,
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
        <div style={{ padding: '0 10px 2px 10px', fontSize: 11, color: 'var(--danger)' }}>
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
      <TransientTextInput
        value={draft}
        onChange={onDraftChange}
        onCommit={onCommitEdit}
        onCancel={onCancelEdit}
        restoreOnEscape
        style={controlStyle({
          width: Math.max(78, draft.length * 8 + 28),
          minWidth: 78,
          maxWidth: 180,
          height: ACCOUNT_CONTROL_HEIGHT,
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
  const visibleOwners = getPersonalOwners(owners)
  const ownersSummary = formatCountSummary(visibleOwners.length, 'owner')
  const [editingOwnerId, setEditingOwnerId] = useState(null)
  const [ownerDraft, setOwnerDraft] = useState('')
  const [creatingOwner, setCreatingOwner] = useState(false)
  const [newOwnerDraft, setNewOwnerDraft] = useState('')
  const [ownerMenu, setOwnerMenu] = useState(null)
  const newOwnerInputRef = useRef(null)
  const ownerMenuRef = useRef(null)

  useEffect(() => {
    if (disabled) {
      setEditingOwnerId(null)
      setOwnerDraft('')
      setCreatingOwner(false)
      setNewOwnerDraft('')
      setOwnerMenu(null)
    }
  }, [disabled])

  useDismissibleLayer({
    open: !!ownerMenu,
    onClose: () => setOwnerMenu(null),
    refs: [ownerMenuRef],
    closeOnBlur: true,
  })

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
    <SectionCard
      title="Account Owners"
      summary={ownersSummary}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      disabled={disabled}
      width={width}
      style={{
      marginTop: 12,
    }}
    >
      <div style={{ padding: '12px 16px 14px' }}>
          {visibleOwners.length > 0 ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              {visibleOwners.map(owner => (
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
                  <TransientTextInput
                    ref={newOwnerInputRef}
                    value={newOwnerDraft}
                    onChange={setNewOwnerDraft}
                    onCommit={submitNewOwner}
                    onCancel={() => {
                      setCreatingOwner(false)
                      setNewOwnerDraft('')
                    }}
                    restoreOnEscape
                    onBlurCommit={false}
                    placeholder="name"
                    style={controlStyle({
                      width: 104,
                      minWidth: 0,
                      background: 'var(--surface)',
                      border: '1px solid var(--accent)',
                      borderRadius: 999,
                      padding: '0 8px',
                      fontSize: 11,
                      height: 22,
                      boxSizing: 'border-box',
                    })}
                  />
                  <Button small onClick={submitNewOwner} disabled={!newOwnerDraft.trim()} style={{ height: 22, padding: '0 9px', borderRadius: 999, fontSize: 11 }}>
                    Add
                  </Button>
                  <Button
                    small
                    variant="ghost"
                    style={{ height: 22, padding: '0 8px', borderRadius: 999, fontSize: 11 }}
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
                  style={{ height: ACCOUNT_CONTROL_HEIGHT, borderRadius: 999 }}
                >
                  +New owner
                </Button>
              )}
            </div>
          ) : creatingOwner ? (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <TransientTextInput
                ref={newOwnerInputRef}
                value={newOwnerDraft}
                onChange={setNewOwnerDraft}
                onCommit={submitNewOwner}
                onCancel={() => {
                  setCreatingOwner(false)
                  setNewOwnerDraft('')
                }}
                restoreOnEscape
                onBlurCommit={false}
                placeholder="name"
                style={controlStyle({
                  width: 104,
                  minWidth: 0,
                  background: 'var(--surface)',
                  border: '1px solid var(--accent)',
                  borderRadius: 999,
                  padding: '0 8px',
                  fontSize: 11,
                  height: 22,
                  boxSizing: 'border-box',
                })}
              />
              <Button small onClick={submitNewOwner} disabled={!newOwnerDraft.trim()} style={{ height: 22, padding: '0 9px', borderRadius: 999, fontSize: 11 }}>
                Add
              </Button>
              <Button
                small
                variant="ghost"
                style={{ height: 22, padding: '0 8px', borderRadius: 999, fontSize: 11 }}
                onClick={() => {
                  setCreatingOwner(false)
                  setNewOwnerDraft('')
                }}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button small variant="ghost" onClick={() => setCreatingOwner(true)} style={{ height: ACCOUNT_CONTROL_HEIGHT, borderRadius: 999 }}>
              +New owner
            </Button>
          )}
          {ownerMenu ? (
            <div
              ref={ownerMenuRef}
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
    </SectionCard>
  )
}

function AccountRow({
  account,
  parentAccount = null,
  hasChildren = false,
  owners,
  onSave,
  onRequestDelete,
  confirmingDelete,
  onCancelDelete,
  onOpenDetail,
  onCreateOwnerForAccount,
  onRequestRenameOwner,
  onRequestDeleteOwner,
  onRequestTrash,
  interactionDisabled = false,
  dragDisabled = false,
  dropActive = false,
  onDragStart,
  onDragEnd,
  onDragOverTarget,
  onDragLeaveTarget,
  onDropOnTarget,
}) {
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
  const ownerMenuRef = useRef(null)
  const {
    editing: editingName,
    setEditing: setEditingName,
    draft: nameDraft,
    setDraft: setNameDraft,
    beginEdit: beginEditingName,
    cancelEdit: cancelEditingName,
    commitEdit: commitName,
  } = useTransientTextEdit(account.name || '', {
    onCommit: async nextName => {
      setSavingName(true)
      try {
        await savePatch({ name: nextName })
      } finally {
        setSavingName(false)
      }
    },
  })

  const isChild = !!parentAccount

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
    function updatePosition() {
      if (!ownerAnchorRef.current) return
      const rect = ownerAnchorRef.current.getBoundingClientRect()
      setOwnerCreatePos({
        left: rect.left,
        top: rect.top + rect.height / 2,
      })
    }
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      cancelAnimationFrame(focusId)
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [showOwnerCreate])

  useDismissibleLayer({
    open: showOwnerCreate,
    onClose: () => {
      setShowOwnerCreate(false)
      setOwnerDraft('')
      setOwnerCreatePos(null)
    },
    refs: [ownerCreateRef, ownerAnchorRef],
  })

  useDismissibleLayer({
    open: !!ownerMenu,
    onClose: () => setOwnerMenu(null),
    refs: [ownerMenuRef],
    closeOnBlur: true,
  })

  const typeValue = account.type || 'other'
  const displayOwnerId = account.owner_id || ''
  const personalOwners = getPersonalOwners(owners)
  const assignableOwners = getAssignableOwners(owners)
  const parentDisplayName = parentAccount?.display_name || parentAccount?.name || ''
  const detailAccount = parentAccount || account
  const canShowOwnerControls = !isChild
  const ownerEditDisabled = interactionDisabled || isChild || hasChildren
  const typeEditDisabled = interactionDisabled || isChild || hasChildren
  const canDrag = !interactionDisabled && !dragDisabled
  const deleteDisabled = interactionDisabled || (!isChild && hasChildren)

  async function savePatch(patch) {
    await onSave(account.id, patch)
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
    setOwnerMenu(null)
    onRequestRenameOwner(current || { id: account.owner_id, name: account.owner_name || '' })
  }

  async function handleDeleteOwner() {
    if (!account.owner_id) return
    const current = owners.find(o => o.id === account.owner_id)
    if (isSharedOwner(current)) return
    setOwnerMenu(null)
    onRequestDeleteOwner(current || { id: account.owner_id, name: account.owner_name || 'owner' })
  }

  return (
    <div
      ref={rowRef}
      onDragOver={event => {
        if (!onDragOverTarget || interactionDisabled) return
        onDragOverTarget(event, account)
      }}
      onDragLeave={event => {
        if (!onDragLeaveTarget || event.currentTarget.contains(event.relatedTarget)) return
        onDragLeaveTarget(event, account)
      }}
      onDrop={event => {
        if (!onDropOnTarget) return
        onDropOnTarget(event, account)
      }}
      style={{
        position: 'relative',
        borderBottom: '1px solid var(--border)',
        background: dropActive ? 'color-mix(in srgb, var(--accent) 10%, var(--surface))' : 'transparent',
      }}
    >
      <div style={{
          display: 'grid',
          gridTemplateColumns: ACCOUNT_ROW_COLUMNS,
        gap: ACCOUNT_ROW_GAP,
        alignItems: 'center',
        padding: ACCOUNT_ROW_PADDING,
      }}>
        <button
          type="button"
          draggable={canDrag}
          onDragStart={event => onDragStart?.(event, account)}
          onDragEnd={() => onDragEnd?.()}
          onClick={event => event.preventDefault()}
          title={canDrag ? (isChild ? 'Drag to regroup or pull out' : 'Drag to merge into another account') : undefined}
          style={{
            background: 'none',
            border: 'none',
            color: canDrag ? 'var(--muted)' : 'color-mix(in srgb, var(--muted) 55%, transparent)',
            cursor: canDrag ? 'grab' : 'default',
            fontSize: 14,
            padding: 0,
            width: 22,
            lineHeight: 1,
          }}
        >
          ⋮⋮
        </button>

        <div style={{ fontSize: 20, lineHeight: 1, textAlign: 'center', transform: 'translateY(-2px)', opacity: isChild ? 0.55 : 1 }}>
          {accountTypeIcon(typeValue)}
        </div>

        <div style={{ minWidth: 0 }}>
          {editingName ? (
            <TransientTextInput
              value={nameDraft}
              onChange={setNameDraft}
              onCommit={commitName}
              onCancel={cancelEditingName}
              restoreOnEscape
              style={controlStyle({
                minWidth: 0,
                padding: '0 9px',
                fontSize: 12,
                height: ACCOUNT_CONTROL_HEIGHT,
                boxSizing: 'border-box',
              })}
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                if (interactionDisabled) return
                beginEditingName(account.name || '')
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
              {isChild ? (
                <span style={{ color: 'var(--muted)', flexShrink: 0, fontSize: 12 }}>↳</span>
              ) : null}
              <span style={{
                fontWeight: 500,
                fontSize: 12,
                lineHeight: `${ACCOUNT_CONTROL_HEIGHT}px`,
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
                  onOpenDetail?.({ id: detailAccount.id, name: detailAccount.display_name || detailAccount.name, mask: detailAccount.mask })
                }}
                title={interactionDisabled ? undefined : 'View account detail'}
                style={{
                  color: 'var(--accent2)',
                  cursor: interactionDisabled ? 'default' : 'pointer',
                  fontSize: 10,
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
          <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {isChild ? (
              <span>Merged display name: {parentDisplayName || account.display_name || account.name}</span>
            ) : (
              <>
                {account.institution && <span>{account.institution} · </span>}
                {account.mask && <span>···{account.mask}</span>}
                {hasChildren ? <span> · {hasChildren === 1 ? '1 merged account' : `${hasChildren} merged accounts`}</span> : null}
              </>
            )}
          </div>
        </div>

        {isChild ? (
          <div style={{ fontSize: 11, color: 'var(--muted)' }}> </div>
        ) : (
          <PillSelect
            value={typeValue}
            options={ACCOUNT_TYPES}
            onChange={changeType}
            minOpenWidth={160}
            disabled={typeEditDisabled}
          />
        )}

        <div ref={ownerAnchorRef} style={{ display: 'flex', justifyContent: 'center', minWidth: 0, position: 'relative' }}>
          {!canShowOwnerControls ? (
            <div style={{ fontSize: 11, color: 'var(--muted)' }} />
          ) : assignableOwners.length > 0 ? (
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
              disabled={ownerEditDisabled}
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                if (ownerEditDisabled) return
                setOwnerDraft('')
                setShowOwnerCreate(true)
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 'fit-content',
                maxWidth: '100%',
                height: ACCOUNT_CONTROL_HEIGHT,
                background: 'var(--surface2)',
                color: 'var(--text)',
                border: '1px solid var(--border)',
                borderRadius: 999,
                padding: '0 9px',
                fontSize: 11,
                lineHeight: 1.1,
                cursor: ownerEditDisabled ? 'default' : 'pointer',
                whiteSpace: 'nowrap',
                opacity: ownerEditDisabled ? 0.6 : 1,
              }}
              title={ownerEditDisabled ? undefined : 'Create and assign owner'}
            >
              Assign owner
            </button>
          )}
          {showOwnerCreate && canShowOwnerControls ? (
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
              <TransientTextInput
                ref={ownerInputRef}
                value={ownerDraft}
                onChange={setOwnerDraft}
                onCommit={submitCreateOwner}
                onCancel={() => {
                  setShowOwnerCreate(false)
                  setOwnerDraft('')
                }}
                restoreOnEscape
                onBlurCommit={false}
                placeholder="name"
                style={controlStyle({
                  width: 104,
                  minWidth: 0,
                  background: 'var(--surface)',
                  border: '1px solid var(--accent)',
                  borderRadius: 999,
                  padding: '0 8px',
                  fontSize: 11,
                  height: 22,
                  boxSizing: 'border-box',
                })}
              />
              <Button
                small
                onClick={submitCreateOwner}
                disabled={!ownerDraft.trim() || creatingOwner}
                style={{ height: 22, padding: '0 9px', borderRadius: 999, fontSize: 11 }}
              >
                {creatingOwner ? 'Adding...' : 'Add'}
              </Button>
              <Button
                small
                variant="ghost"
                style={{ height: 22, padding: '0 8px', borderRadius: 999, fontSize: 11 }}
                onClick={() => {
                  setShowOwnerCreate(false)
                  setOwnerDraft('')
                }}
              >
                Cancel
              </Button>
            </div>
          ) : null}
          {ownerMenu && canShowOwnerControls ? (
            <div
              ref={ownerMenuRef}
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
            if (deleteDisabled) return
            if (isChild) {
              onRequestTrash?.(account)
              return
            }
            onRequestDelete(account.id)
          }}
          title={deleteDisabled ? (!isChild && hasChildren ? 'Trash or ungroup the merged child accounts first' : undefined) : (isChild ? 'Send child account to trash' : 'Delete account')}
          style={{
            background: 'none',
            border: '1px solid var(--border)',
            color: isChild ? 'var(--danger)' : 'var(--muted)',
            cursor: deleteDisabled ? 'default' : 'pointer',
            fontSize: 16,
            width: 28,
            height: ACCOUNT_CONTROL_HEIGHT,
            lineHeight: 1,
            padding: 0,
            borderRadius: 6,
            justifySelf: 'end',
            opacity: deleteDisabled ? 0.45 : 1,
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
          bottom: 6,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '8px 12px',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          boxShadow: '0 12px 30px rgba(0, 0, 0, 0.14)',
          fontSize: 12,
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
  /*
   * This page keeps three account states in one workspace:
   * - top-level rows are the selectable physical accounts used everywhere else in the app
   * - child rows preserve historical account numbers while sharing the parent's display identity
   * - trash is only the reversible holding state before permanent cleanup happens from Settings
   */
  const [accounts, setAccounts] = useState([])
  const [owners, setOwners] = useState([])
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [pendingTrashAccount, setPendingTrashAccount] = useState(null)
  const [noticeDialog, setNoticeDialog] = useState(null)
  const [pendingOwnerDelete, setPendingOwnerDelete] = useState(null)
  const [ownerRenameDialog, setOwnerRenameDialog] = useState(null)
  const [showCreateAccount, setShowCreateAccount] = useState(false)
  const [creatingAccount, setCreatingAccount] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const [detailAccounts, setDetailAccounts] = useState([])
  const [dbInstanceId, setDbInstanceId] = useState('')
  const [userId, setUserId] = useState('')
  const [sectionExpandedState, setSectionExpandedState] = useState({})
  const [sectionStateLoaded, setSectionStateLoaded] = useState(false)
  const [draggingAccountId, setDraggingAccountId] = useState(null)
  const [dropTargetAccountId, setDropTargetAccountId] = useState(null)
  const [rootDropActive, setRootDropActive] = useState(false)
  const [movingAccountId, setMovingAccountId] = useState(null)
  const listRef = useRef(null)
  const accountsPanelRef = useRef(null)
  const [accountsPanelWidth, setAccountsPanelWidth] = useState(null)

  function openAccountDetail(account) {
    if (!account?.id) return
    setDetailAccounts(prev => [
      ...prev.filter(item => item.id !== account.id),
      account,
    ])
  }

  function closeAccountDetail(accountId) {
    setDetailAccounts(prev => prev.filter(item => item.id !== accountId))
  }

  function getAccountDetailInitialPosition() {
    if (!accountsPanelRef.current || typeof window === 'undefined') return null
    const rect = accountsPanelRef.current.getBoundingClientRect()
    const panelWidth = Math.min(820, window.innerWidth - 32)
    const gutter = 20
    const fitsToRight = rect.right + gutter + panelWidth <= window.innerWidth - 16
    const fallbackOffset = Math.min(Math.max(rect.width * 0.42, 260), 420)
    const maxVisibleX = Math.max(16, window.innerWidth - panelWidth - 16)
    return {
      x: fitsToRight ? rect.right + gutter : Math.min(rect.left + fallbackOffset, maxVisibleX),
      y: Math.max(96, Math.round(rect.top)),
    }
  }

  const loadData = () => {
    setLoading(true)
    Promise.all([api.getAccounts({ include_children: true }), api.getOwners(), api.getCategories()])
      .then(([a, o, c]) => {
        setAccounts(a)
        setOwners(o)
        setCategories(c)
      })
      .finally(() => setLoading(false))
  }

  async function reloadAccounts() {
    const rows = await api.getAccounts({ include_children: true })
    setAccounts(rows)
    return rows
  }

  useEffect(() => { loadData() }, [])

  useEffect(() => {
    setDetailAccounts(current => current.map(detail => {
      const nextAccount = accounts.find(account => account.id === detail.id)
      return nextAccount
        ? { ...detail, name: nextAccount.display_name || nextAccount.name, mask: nextAccount.mask }
        : detail
    }))
  }, [accounts])

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

      const storageKey = getAccountsSectionsStorageKey(nextDbInstanceId, nextUserId)
      const prefValue = prefResp?.preferences?.[ACCOUNTS_SECTIONS_PREF_KEY]
      const nextSectionState = isObjectLike(prefValue) ? prefValue : {}

      if (!isObjectLike(prefValue) && storageKey) {
        try {
          const raw = window.localStorage.getItem(storageKey)
          const parsed = raw ? JSON.parse(raw) : null
          if (isObjectLike(parsed)) {
            Object.assign(nextSectionState, parsed)
          }
        } catch {
          // Ignore storage failures in restricted environments.
        }
      }

      if (nextSectionState.accountOwners === undefined) {
        const legacyPrefValue = prefResp?.preferences?.[LEGACY_ACCOUNT_OWNERS_PREF_KEY]
        if (typeof legacyPrefValue === 'boolean') {
          nextSectionState.accountOwners = legacyPrefValue
        } else {
          const legacyStorageKey = getLegacyAccountOwnersStorageKey(nextDbInstanceId, nextUserId)
          if (legacyStorageKey) {
            try {
              const raw = window.localStorage.getItem(legacyStorageKey)
              if (raw !== null) nextSectionState.accountOwners = raw === 'true'
            } catch {
              // Ignore storage failures in restricted environments.
            }
          }
        }
      }

      setSectionExpandedState(nextSectionState)
      setSectionStateLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Accounts-page section collapse state is profile-scoped UI state, so one person's workspace shape restores cleanly without affecting others.
  useEffect(() => {
    if (!sectionStateLoaded) return
    const storageKey = getAccountsSectionsStorageKey(dbInstanceId, userId)
    if (storageKey) {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(sectionExpandedState))
      } catch {
        // Ignore storage failures in restricted environments.
      }
    }
    api.saveUserPreference(ACCOUNTS_SECTIONS_PREF_KEY, sectionExpandedState).catch(() => {})
  }, [dbInstanceId, userId, sectionExpandedState, sectionStateLoaded])

  function bindSection(sectionKey) {
    return {
      expanded: getSectionExpanded(sectionExpandedState, sectionKey),
      onExpandedChange: value => setSectionExpandedState(prev => ({ ...prev, [sectionKey]: value })),
    }
  }

  useEffect(() => {
    if (!accountsPanelRef.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => {
      const entry = entries[0]
      if (!entry) return
      const nextWidth = Math.round(entry.contentRect.width)
      if (!getSectionExpanded(sectionExpandedState, 'accountList') && accountsPanelWidth && nextWidth < accountsPanelWidth) return
      // Mirror the table width into the lower cards so the page still reads as one
      // anchored column even when account rows reflow or the create row appears.
      setAccountsPanelWidth(nextWidth)
    })
    observer.observe(accountsPanelRef.current)
    return () => observer.disconnect()
  }, [accounts.length, accountsPanelWidth, loading, sectionExpandedState, showCreateAccount])

  useEffect(() => {
    if (!showCreateAccount) return
    clearDragState()
  }, [showCreateAccount])

  const connectBank = async () => {
    try {
      const { link_token } = await api.getLinkToken()
      // Load Plaid only on demand so normal account-page visits do not pull in a
      // third-party banking script unless the user actually starts a connection flow.
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
      setNoticeDialog({
        title: 'Could not start Plaid Link',
        description: e.message,
      })
    }
  }

  function openCreateAccount() {
    setContextOpen(false)
    setShowCreateAccount(true)
  }

  const createAccount = async (data) => {
    setCreatingAccount(true)
    try {
      await api.createAccount(data)
      setShowCreateAccount(false)
      await reloadAccounts()
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
      setNoticeDialog({
        title: 'Sync failed',
        description: e.message,
      })
    } finally {
      setSyncing(false)
    }
  }

  async function saveAccount(accountId, patch) {
    await api.updateAccount(accountId, patch)
    await reloadAccounts()
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
    reloadAccounts().catch(() => {})
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
    await reloadAccounts()
    refreshTaskBadge()
  }

  function clearDragState() {
    setDraggingAccountId(null)
    setDropTargetAccountId(null)
    setRootDropActive(false)
  }

  function canAttachAccount(source, target) {
    if (!source || !target) return false
    if (source.id === target.id) return false
    if (source.trashed_at || target.trashed_at) return false
    if (target.parent_account_id) return false
    if ((childAccountsByParent.get(source.id) || []).length > 0) return false
    return hasSameMergeFields(source, target)
  }

  async function attachAccount(source, target) {
    if (!canAttachAccount(source, target)) return
    setMovingAccountId(source.id)
    try {
      await api.attachAccount(source.id, target.id)
      await reloadAccounts()
      refreshTaskBadge()
    } catch (error) {
      setNoticeDialog({
        title: 'Could not merge accounts',
        description: error.message,
      })
    } finally {
      setMovingAccountId(null)
      clearDragState()
    }
  }

  async function detachAccount(account) {
    if (!account?.parent_account_id) return
    setMovingAccountId(account.id)
    try {
      await api.detachAccount(account.id)
      await reloadAccounts()
      refreshTaskBadge()
    } catch (error) {
      setNoticeDialog({
        title: 'Could not ungroup account',
        description: error.message,
      })
    } finally {
      setMovingAccountId(null)
      clearDragState()
    }
  }

  async function confirmTrashChildAccount() {
    if (!pendingTrashAccount?.id) return
    const account = pendingTrashAccount
    setPendingTrashAccount(null)
    setMovingAccountId(account.id)
    try {
      await api.trashAccount(account.id)
      await reloadAccounts()
      refreshTaskBadge()
    } catch (error) {
      setNoticeDialog({
        title: 'Could not send account to trash',
        description: error.message,
      })
    } finally {
      setMovingAccountId(null)
    }
  }

  function handleAccountDragStart(event, account) {
    if (movingAccountId || showCreateAccount) {
      event.preventDefault()
      return
    }
    setDraggingAccountId(account.id)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', account.id)
  }

  function handleAccountDragEnd() {
    clearDragState()
  }

  function handleAccountDragOverTarget(event, target) {
    if (showCreateAccount || movingAccountId) return
    if (!draggingAccount || !canAttachAccount(draggingAccount, target)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDropTargetAccountId(target.id)
    setRootDropActive(false)
  }

  function handleAccountDropOnTarget(event, target) {
    if (!draggingAccount || !canAttachAccount(draggingAccount, target)) return
    event.preventDefault()
    attachAccount(draggingAccount, target)
  }

  function handleAccountDragLeaveTarget() {
    setDropTargetAccountId(null)
  }

  function handleRootDropZoneDragOver(event) {
    if (!draggingAccount?.parent_account_id || showCreateAccount || movingAccountId) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setRootDropActive(true)
    setDropTargetAccountId(null)
  }

  function handleRootDropZoneDrop(event) {
    if (!draggingAccount?.parent_account_id) return
    event.preventDefault()
    detachAccount(draggingAccount)
  }

  const activeAccounts = accounts.filter(account => !account.trashed_at)
  const rootAccounts = activeAccounts.filter(account => !account.parent_account_id)
  const childAccountsByParent = activeAccounts.reduce((map, account) => {
    if (!account.parent_account_id) return map
    const list = map.get(account.parent_account_id) || []
    list.push(account)
    map.set(account.parent_account_id, list)
    return map
  }, new Map())
  const draggingAccount = draggingAccountId ? activeAccounts.find(account => account.id === draggingAccountId) : null

  const ownerCount = owners.length
  const unownedCount = rootAccounts.filter(a => !a.owner_id).length
  const hasPlaidConnected = rootAccounts.some(a => a.plaid_item_id && a.plaid_item_id !== 'csv_import' && a.plaid_item_id !== 'manual')
  const mergedChildCount = activeAccounts.length - rootAccounts.length
  const accountListSummary = rootAccounts.length
    ? `${formatCountSummary(rootAccounts.length, 'account')}${mergedChildCount ? `, ${formatCountSummary(mergedChildCount, 'merged account')}` : ''}`
    : 'No accounts'
  const dataSourcesSummary = hasPlaidConnected ? formatCountSummary(1, 'data provider') : 'No data providers'
  const accountListSection = bindSection('accountList')
  const dataSourcesSection = bindSection('dataSources')
  const ownersSection = bindSection('accountOwners')
  const ownerWarning = ownerCount > 0 && unownedCount > 0 ? `${unownedCount} account${unownedCount > 1 ? 's' : ''} need${unownedCount === 1 ? 's' : ''} an owner assigned` : ''
  const renameOwnerName = ownerRenameDialog?.name || ''

  async function confirmOwnerRename() {
    if (!ownerRenameDialog?.id || !renameOwnerName.trim()) return
    const ownerId = ownerRenameDialog.id
    const nextName = renameOwnerName.trim()
    setOwnerRenameDialog(null)
    await saveOwner(ownerId, { name: nextName })
  }

  async function confirmOwnerDelete() {
    if (!pendingOwnerDelete) return
    const owner = pendingOwnerDelete
    setPendingOwnerDelete(null)
    await deleteOwner(owner)
  }

  return (
    <div data-browser-context-passthrough="true" style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {noticeDialog ? (
        <AppNoticeDialog
          title={noticeDialog.title}
          description={noticeDialog.description}
          onClose={() => setNoticeDialog(null)}
        />
      ) : null}

      {ownerRenameDialog ? (
        <AppTextEntryDialog
          title="Rename owner"
          description="Choose the name this owner should use across accounts and categories."
          label="Owner name"
          value={renameOwnerName}
          onChange={value => setOwnerRenameDialog(prev => prev ? { ...prev, name: value } : prev)}
          placeholder="Owner name"
          confirmLabel="Save"
          confirmDisabled={!renameOwnerName.trim()}
          onConfirm={confirmOwnerRename}
          onCancel={() => setOwnerRenameDialog(null)}
          width="min(460px, 100%)"
        />
      ) : null}

      {pendingOwnerDelete ? (
        <AppConfirmDialog
          title="Delete owner?"
          description={`Delete "${pendingOwnerDelete.name || 'owner'}"? Their accounts and categories will become unassigned.`}
          confirmLabel="Delete"
          confirmVariant="danger"
          borderColor="color-mix(in srgb, var(--danger) 35%, var(--border))"
          onConfirm={confirmOwnerDelete}
          onCancel={() => setPendingOwnerDelete(null)}
          width="min(500px, 100%)"
        />
      ) : null}

      {pendingTrashAccount ? (
        <AppConfirmDialog
          title="Send merged account to trash?"
          description={`Hide "${pendingTrashAccount.name}" for now? It will stay recoverable in Settings until the trash is emptied.`}
          confirmLabel="Send to trash"
          confirmVariant="danger"
          borderColor="color-mix(in srgb, var(--danger) 35%, var(--border))"
          onConfirm={confirmTrashChildAccount}
          onCancel={() => setPendingTrashAccount(null)}
          width="min(560px, 100%)"
        />
      ) : null}

      <div style={{ padding: '24px 32px 0', flexShrink: 0 }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 18,
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

        {loading ? <Spinner /> : (
          <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start' }}>
            <div ref={accountsPanelRef} style={{ position: 'relative', width: 'fit-content', maxWidth: '100%' }}>
              <SectionCard
                title="Account List"
                summary={accountListSummary}
                headerCenter={ownerWarning ? (
                  <span style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '4px 10px',
                    borderRadius: 999,
                    background: 'color-mix(in srgb, var(--warning, #f59e0b) 10%, var(--surface2))',
                    border: '1px solid var(--border)',
                    fontSize: 12,
                    color: 'var(--text)',
                    opacity: showCreateAccount ? 0.55 : 1,
                  }}>
                    <span>⚠️</span>
                    <span style={{ whiteSpace: 'nowrap' }}>{ownerWarning}</span>
                  </span>
                ) : null}
                expanded={accountListSection.expanded}
                onExpandedChange={accountListSection.onExpandedChange}
                style={{ overflow: 'hidden', alignSelf: 'flex-start' }}
              >
                {rootAccounts.length === 0 && !showCreateAccount ? (
                  <div style={{ padding: '12px 16px 14px', fontSize: 14, color: 'var(--muted)', lineHeight: 1.4 }}>
                    No accounts yet.
                  </div>
                ) : (
                  <>
                    <div style={{
                      display: 'grid',
                      gridTemplateColumns: ACCOUNT_ROW_COLUMNS,
                      gap: ACCOUNT_ROW_GAP,
                      padding: '6px 10px',
                      borderBottom: '1px solid var(--border)',
                      background: 'var(--surface2)',
                      alignItems: 'center',
                    }}>
                      <span />
                      <span />
                      <HeaderPill>Account</HeaderPill>
                      <HeaderPill style={{ marginLeft: 6 }}>Type</HeaderPill>
                      <div style={{ display: 'flex', justifyContent: 'center' }}>
                        <HeaderPill>Owner</HeaderPill>
                      </div>
                      <span />
                    </div>
                    <div ref={listRef} style={{ maxHeight: 640, overflowY: 'auto' }}>
                      {draggingAccount?.parent_account_id ? (
                        <div
                          onDragOver={handleRootDropZoneDragOver}
                          onDrop={handleRootDropZoneDrop}
                          style={{
                            margin: '8px 10px 0',
                            padding: '8px 12px',
                            borderRadius: 10,
                            border: `1px dashed ${rootDropActive ? 'var(--accent)' : 'var(--border)'}`,
                            background: rootDropActive ? 'color-mix(in srgb, var(--accent) 10%, var(--surface2))' : 'color-mix(in srgb, var(--surface2) 60%, var(--surface))',
                            color: rootDropActive ? 'var(--text)' : 'var(--muted)',
                            fontSize: 12,
                          }}
                        >
                          Drop here to keep this account on its own again.
                        </div>
                      ) : null}
                      {rootAccounts.map(root => {
                        const children = childAccountsByParent.get(root.id) || []
                        const rootDragDisabled = movingAccountId === root.id || children.length > 0
                        return (
                          <div key={root.id}>
                            <AccountRow
                              account={root}
                              hasChildren={children.length}
                              owners={owners}
                              onSave={saveAccount}
                              onRequestDelete={requestDelete}
                              confirmingDelete={confirmDeleteId === root.id}
                              onCancelDelete={cancelOrConfirmDelete}
                              onOpenDetail={openAccountDetail}
                              onCreateOwnerForAccount={createOwnerForAccount}
                              onRequestRenameOwner={owner => setOwnerRenameDialog({
                                id: owner.id,
                                name: owner.name || '',
                              })}
                              onRequestDeleteOwner={owner => setPendingOwnerDelete(owner)}
                              onRequestTrash={setPendingTrashAccount}
                              interactionDisabled={showCreateAccount || !!movingAccountId}
                              dragDisabled={rootDragDisabled}
                              dropActive={dropTargetAccountId === root.id}
                              onDragStart={handleAccountDragStart}
                              onDragEnd={handleAccountDragEnd}
                              onDragOverTarget={handleAccountDragOverTarget}
                              onDragLeaveTarget={handleAccountDragLeaveTarget}
                              onDropOnTarget={handleAccountDropOnTarget}
                            />
                            {children.map(child => (
                              <AccountRow
                                key={child.id}
                                account={child}
                                parentAccount={root}
                                owners={owners}
                                onSave={saveAccount}
                                onRequestDelete={requestDelete}
                                confirmingDelete={false}
                                onCancelDelete={cancelOrConfirmDelete}
                                onOpenDetail={openAccountDetail}
                                onCreateOwnerForAccount={createOwnerForAccount}
                                onRequestRenameOwner={owner => setOwnerRenameDialog({
                                  id: owner.id,
                                  name: owner.name || '',
                                })}
                                onRequestDeleteOwner={owner => setPendingOwnerDelete(owner)}
                                onRequestTrash={setPendingTrashAccount}
                                interactionDisabled={showCreateAccount || !!movingAccountId}
                                dragDisabled={movingAccountId === child.id}
                                onDragStart={handleAccountDragStart}
                                onDragEnd={handleAccountDragEnd}
                                onDragOverTarget={handleAccountDragOverTarget}
                                onDragLeaveTarget={handleAccountDragLeaveTarget}
                                onDropOnTarget={handleAccountDropOnTarget}
                              />
                            ))}
                          </div>
                        )
                      })}
                      {showCreateAccount && (
                        <DraftAccountRow
                          owners={owners}
                          creating={creatingAccount}
                          onCreate={createAccount}
                          onCancel={() => setShowCreateAccount(false)}
                        />
                      )}
                    </div>
                  </>
                )}
              </SectionCard>
            {showCreateAccount && accountListSection.expanded && (
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
            <div style={{ width: '100%', display: accountListSection.expanded ? 'flex' : 'none', justifyContent: 'flex-end', marginTop: 6 }}>
              <Button small onClick={() => setShowCreateAccount(true)} disabled={showCreateAccount}>
                +New account
              </Button>
            </div>
          </div>
        )}

        <SectionCard
          title="Data Sources"
          summary={dataSourcesSummary}
          expanded={dataSourcesSection.expanded}
          onExpandedChange={dataSourcesSection.onExpandedChange}
          disabled={showCreateAccount}
          width={accountsPanelWidth}
          style={{
          marginTop: 18,
        }}
        >
          <div style={{ padding: '12px 16px 14px' }}>
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
          </div>
        </SectionCard>

        <OwnersPanel
          owners={owners}
          onCreateOwner={createOwner}
          onSaveOwner={saveOwner}
          onDeleteOwner={owner => setPendingOwnerDelete(owner)}
          disabled={showCreateAccount}
          width={accountsPanelWidth}
          expanded={ownersSection.expanded}
          onExpandedChange={ownersSection.onExpandedChange}
        />

        {detailAccounts.map((account, index) => (
          <AccountDetail
            key={account.id}
            account={account}
            categories={categories}
            forceFloating
            stackIndex={index}
            initialPosition={getAccountDetailInitialPosition()}
            isTopmost={index === detailAccounts.length - 1}
            onClose={() => closeAccountDetail(account.id)}
          />
        ))}
      </div>
    </div>
  )
}
