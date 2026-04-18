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
const ACCOUNTS_ORDER_PREF_KEY = 'ui.accounts.order'
const ACCOUNTS_ORDER_STORAGE_KEY_PREFIX = 'fintrack.accounts.order'
const ACCOUNTS_COLLAPSED_PREF_KEY = 'ui.accounts.collapsedGroups'
const ACCOUNTS_COLLAPSED_STORAGE_KEY_PREFIX = 'fintrack.accounts.collapsedGroups'
const ACCOUNTS_CHILD_ORDER_PREF_KEY = 'ui.accounts.childOrder'
const ACCOUNTS_CHILD_ORDER_STORAGE_KEY_PREFIX = 'fintrack.accounts.childOrder'
const ACCOUNTS_SORT_PREF_KEY = 'ui.accounts.sort'
const ACCOUNTS_SORT_STORAGE_KEY_PREFIX = 'fintrack.accounts.sort'
const ACCOUNT_ROW_COLUMNS = '22px minmax(0, 1.5fr) minmax(118px, 0.46fr) minmax(138px, 0.56fr) 28px'
const ACCOUNT_ROW_CHILD_INDENT = 28
const ACCOUNT_ROW_GAP = 10
const ACCOUNT_ROW_PADDING = '3px 10px'
const ACCOUNT_CONTROL_HEIGHT = 22
const ACCOUNT_SECTION_DEFAULTS = {
  accountList: false,
  dataSources: false,
  accountOwners: false,
}


// "Shared" only becomes an assignable owner when there are multiple personal owners; otherwise it would just duplicate the sole-owner default.
function isSharedOwner(owner) {
  return !!owner?.is_shared || (owner?.name || '').trim().toLowerCase() === 'shared'
}

// Two accounts are owner-compatible if they share the same owner, or if either owner is the
// shared owner — a shared account can be grouped with any personal account of the same type
// since shared ownership often reflects a life-stage change, not a permanent categorization.
function ownersAreCompatible(source, target, owners) {
  const sourceOwnerId = source?.owner_id || ''
  const targetOwnerId = target?.owner_id || ''
  if (sourceOwnerId === targetOwnerId) return true
  const sourceOwner = owners.find(o => o.id === sourceOwnerId)
  const targetOwner = owners.find(o => o.id === targetOwnerId)
  return isSharedOwner(sourceOwner) || isSharedOwner(targetOwner)
}

function hasSameMergeFields(source, target, owners) {
  return ownersAreCompatible(source, target, owners) && (source?.type || '') === (target?.type || '')
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

function getAccountsOrderStorageKey(dbInstanceId, userId) {
  return dbInstanceId && userId
    ? `${ACCOUNTS_ORDER_STORAGE_KEY_PREFIX}.${dbInstanceId}.${userId}`
    : ''
}

function getAccountsCollapsedStorageKey(dbInstanceId, userId) {
  return dbInstanceId && userId
    ? `${ACCOUNTS_COLLAPSED_STORAGE_KEY_PREFIX}.${dbInstanceId}.${userId}`
    : ''
}

function getAccountsChildOrderStorageKey(dbInstanceId, userId) {
  return dbInstanceId && userId
    ? `${ACCOUNTS_CHILD_ORDER_STORAGE_KEY_PREFIX}.${dbInstanceId}.${userId}`
    : ''
}

function getAccountsSortStorageKey(dbInstanceId, userId) {
  return dbInstanceId && userId
    ? `${ACCOUNTS_SORT_STORAGE_KEY_PREFIX}.${dbInstanceId}.${userId}`
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
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '4px 12px',
          width: '100%',
          background: 'none',
          border: 'none',
          padding: '12px 16px',
          color: 'var(--text)',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>{expanded ? '−' : '+'}</span>
          <span style={{ fontSize: 14, fontWeight: 600 }}>{title}</span>
        </span>
        {headerCenter ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 1, minWidth: 0 }}>
            {headerCenter}
          </span>
        ) : null}
        {summary ? (
          <span style={{
            fontSize: 12,
            color: 'var(--muted)',
            whiteSpace: 'nowrap',
            marginLeft: 'auto',
          }}>
            {summary}
          </span>
        ) : null}
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
            background: 'var(--surface2)',
            border: '1.5px solid color-mix(in srgb, var(--text) 22%, var(--border))',
            borderRadius: 10,
            boxShadow: '0 2px 8px rgba(0,0,0,0.12), 0 12px 40px rgba(0,0,0,0.36)',
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
  isLastChild = false,
  isCollapsed = false,
  onToggleCollapse,
  restrictedOwnerOptions = null,
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
  // Parents with children may toggle between their personal owner and shared — restricted options
  // are passed in from the parent to enforce this. Children and plain accounts use all assignable owners.
  const effectiveOwnerOptions = restrictedOwnerOptions ?? assignableOwners
  const parentDisplayName = parentAccount?.display_name || parentAccount?.name || ''
  const detailAccount = parentAccount || account
  const canShowOwnerControls = !isChild
  // Allow owner change on parents-with-children but only between personal owner and shared.
  const ownerEditDisabled = interactionDisabled || isChild
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
      data-account-row
      data-account-row-id={account.id}
      style={{
        position: 'relative',
        borderBottom: '1px solid var(--border)',
        background: dropActive ? 'color-mix(in srgb, var(--accent) 10%, var(--surface))' : 'transparent',
      }}
    >
      {isChild && (
        <div style={{
          position: 'absolute',
          left: 10,
          top: 0,
          width: 2,
          height: isLastChild ? '50%' : '100%',
          background: 'var(--border)',
          borderRadius: 1,
          pointerEvents: 'none',
        }} />
      )}
      <div style={{
          display: 'grid',
          gridTemplateColumns: ACCOUNT_ROW_COLUMNS,
        gap: ACCOUNT_ROW_GAP,
        alignItems: 'center',
        padding: ACCOUNT_ROW_PADDING,
        paddingLeft: isChild ? `${10 + ACCOUNT_ROW_CHILD_INDENT}px` : undefined,
      }}>
        <button
          type="button"
          draggable={canDrag}
          onDragStart={event => onDragStart?.(event, account)}
          onDragEnd={() => onDragEnd?.()}
          onClick={event => event.preventDefault()}
          title={canDrag ? (isChild ? 'Drag to reorder or pull out to top level' : 'Drag to merge or reorder') : undefined}
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
          {hasChildren && !isChild ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
              <button
                type="button"
                onClick={e => { e.stopPropagation(); onToggleCollapse?.() }}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  color: 'var(--muted)',
                  fontSize: 10,
                  lineHeight: 1,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                }}
                title={isCollapsed ? 'Show merged accounts' : 'Hide merged accounts'}
              >
                <span style={{ fontSize: 9 }}>{isCollapsed ? '▶' : '▼'}</span>
                <span>{hasChildren === 1 ? '1 merged account' : `${hasChildren} merged accounts`}</span>
              </button>
            </div>
          ) : (
            <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {!isChild && (
                <>
                  {account.institution && <span>{account.institution} · </span>}
                  {account.mask && <span>···{account.mask}</span>}
                </>
              )}
            </div>
          )}
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
          ) : effectiveOwnerOptions.length > 0 ? (
            <PillSelect
              value={displayOwnerId}
              placeholder="Assign owner"
              options={effectiveOwnerOptions.map(o => ({ value: o.id, label: o.name }))}
              onChange={changeOwner}
              minOpenWidth={138}
              createLabel={restrictedOwnerOptions ? null : 'Create owner...'}
              onCreate={restrictedOwnerOptions ? null : () => {
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
  const [listContextMenu, setListContextMenu] = useState(null) // { x, y }
  const [detailAccounts, setDetailAccounts] = useState([])
  const [dbInstanceId, setDbInstanceId] = useState('')
  const [userId, setUserId] = useState('')
  const [sectionExpandedState, setSectionExpandedState] = useState({})
  const [sectionStateLoaded, setSectionStateLoaded] = useState(false)
  const [draggingAccountId, setDraggingAccountId] = useState(null)
  const draggingAccountIdRef = useRef(null)
  const [sortKey, setSortKey] = useState('type') // 'name' | 'type' | 'owner'
  const [sortDir, setSortDir] = useState('asc')
  const [sortLoaded, setSortLoaded] = useState(false)
  // dropIntent: null | { kind: 'merge', targetId: string } | { kind: 'reorder', insertAfterId: string | null }
  const [dropIntent, setDropIntent] = useState(null)
  const [dragTooltip, setDragTooltip] = useState(null) // { x, y, message }
  const [movingAccountId, setMovingAccountId] = useState(null)
  const [accountOrder, setAccountOrder] = useState(null) // null until loaded; array of root account IDs
  const [accountOrderLoaded, setAccountOrderLoaded] = useState(false)
  const [collapsedGroups, setCollapsedGroups] = useState(new Set()) // Set of parent account IDs
  const [collapsedGroupsLoaded, setCollapsedGroupsLoaded] = useState(false)
  const [childOrder, setChildOrder] = useState({}) // { [parentId]: childId[] }
  const [childOrderLoaded, setChildOrderLoaded] = useState(false)
  const dragTooltipTimerRef = useRef(null)
  const dragScrollRafRef = useRef(null)
  const listRef = useRef(null)
  const outerScrollRef = useRef(null)
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

      // Load account display order, falling back to localStorage then API order.
      const orderPrefValue = prefResp?.preferences?.[ACCOUNTS_ORDER_PREF_KEY]
      const orderStorageKey = getAccountsOrderStorageKey(nextDbInstanceId, nextUserId)
      let savedOrder = Array.isArray(orderPrefValue) ? orderPrefValue : null
      if (!savedOrder && orderStorageKey) {
        try {
          const raw = window.localStorage.getItem(orderStorageKey)
          const parsed = raw ? JSON.parse(raw) : null
          if (Array.isArray(parsed)) savedOrder = parsed
        } catch {
          // Ignore storage failures in restricted environments.
        }
      }
      setAccountOrder(savedOrder)
      setAccountOrderLoaded(true)

      // Load collapsed group state (which parent accounts have their children hidden).
      const collapsedPrefValue = prefResp?.preferences?.[ACCOUNTS_COLLAPSED_PREF_KEY]
      const collapsedStorageKey = getAccountsCollapsedStorageKey(nextDbInstanceId, nextUserId)
      let savedCollapsed = Array.isArray(collapsedPrefValue) ? collapsedPrefValue : null
      if (!savedCollapsed && collapsedStorageKey) {
        try {
          const raw = window.localStorage.getItem(collapsedStorageKey)
          const parsed = raw ? JSON.parse(raw) : null
          if (Array.isArray(parsed)) savedCollapsed = parsed
        } catch {
          // Ignore storage failures in restricted environments.
        }
      }
      setCollapsedGroups(new Set(savedCollapsed || []))
      setCollapsedGroupsLoaded(true)

      // Load child display order — a map of parentId → ordered array of child IDs.
      const childOrderPrefValue = prefResp?.preferences?.[ACCOUNTS_CHILD_ORDER_PREF_KEY]
      const childOrderStorageKey = getAccountsChildOrderStorageKey(nextDbInstanceId, nextUserId)
      let savedChildOrder = isObjectLike(childOrderPrefValue) ? childOrderPrefValue : null
      if (!savedChildOrder && childOrderStorageKey) {
        try {
          const raw = window.localStorage.getItem(childOrderStorageKey)
          const parsed = raw ? JSON.parse(raw) : null
          if (isObjectLike(parsed)) savedChildOrder = parsed
        } catch {
          // Ignore storage failures in restricted environments.
        }
      }
      setChildOrder(savedChildOrder || {})
      setChildOrderLoaded(true)

      // Load sort preference — key and direction, defaulting to type/asc.
      const sortPrefValue = prefResp?.preferences?.[ACCOUNTS_SORT_PREF_KEY]
      const sortStorageKey = getAccountsSortStorageKey(nextDbInstanceId, nextUserId)
      let savedSort = isObjectLike(sortPrefValue) ? sortPrefValue : null
      if (!savedSort && sortStorageKey) {
        try {
          const raw = window.localStorage.getItem(sortStorageKey)
          const parsed = raw ? JSON.parse(raw) : null
          if (isObjectLike(parsed)) savedSort = parsed
        } catch {
          // Ignore storage failures in restricted environments.
        }
      }
      if (savedSort?.key) {
        setSortKey(savedSort.key)
        setSortDir(savedSort.dir || 'asc')
      }
      setSortLoaded(true)
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

  // Account display order is profile-scoped UI state, persisted the same way as section state.
  useEffect(() => {
    if (!accountOrderLoaded || accountOrder === null) return
    const storageKey = getAccountsOrderStorageKey(dbInstanceId, userId)
    if (storageKey) {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(accountOrder))
      } catch {
        // Ignore storage failures in restricted environments.
      }
    }
    api.saveUserPreference(ACCOUNTS_ORDER_PREF_KEY, accountOrder).catch(() => {})
  }, [dbInstanceId, userId, accountOrder, accountOrderLoaded])

  // Collapsed group state is profile-scoped UI state, persisted as an array of collapsed parent IDs.
  useEffect(() => {
    if (!collapsedGroupsLoaded) return
    const collapsed = [...collapsedGroups]
    const storageKey = getAccountsCollapsedStorageKey(dbInstanceId, userId)
    if (storageKey) {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(collapsed))
      } catch {
        // Ignore storage failures in restricted environments.
      }
    }
    api.saveUserPreference(ACCOUNTS_COLLAPSED_PREF_KEY, collapsed).catch(() => {})
  }, [dbInstanceId, userId, collapsedGroups, collapsedGroupsLoaded])

  // Child display order is profile-scoped UI state, persisted as a map of parentId → childId[].
  useEffect(() => {
    if (!childOrderLoaded) return
    const storageKey = getAccountsChildOrderStorageKey(dbInstanceId, userId)
    if (storageKey) {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(childOrder))
      } catch {
        // Ignore storage failures in restricted environments.
      }
    }
    api.saveUserPreference(ACCOUNTS_CHILD_ORDER_PREF_KEY, childOrder).catch(() => {})
  }, [dbInstanceId, userId, childOrder, childOrderLoaded])

  // Sort preference is profile-scoped UI state, persisted as { key, dir }.
  useEffect(() => {
    if (!sortLoaded) return
    const value = { key: sortKey, dir: sortDir }
    const storageKey = getAccountsSortStorageKey(dbInstanceId, userId)
    if (storageKey) {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(value))
      } catch {
        // Ignore storage failures in restricted environments.
      }
    }
    api.saveUserPreference(ACCOUNTS_SORT_PREF_KEY, value).catch(() => {})
  }, [dbInstanceId, userId, sortKey, sortDir, sortLoaded])

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
    draggingAccountIdRef.current = null
    setDropIntent(null)
    dragInvalidSinceRef.current = null
    clearTimeout(dragTooltipTimerRef.current)
    setDragTooltip(null)
    cancelAnimationFrame(dragScrollRafRef.current)
    dragScrollRafRef.current = null
  }

  // If target is a child account, return its parent instead — dropping anywhere on a
  // parent-child group should be treated as targeting the parent for merge purposes.
  function resolveDropTarget(target) {
    if (!target?.parent_account_id) return target
    return activeAccounts.find(a => a.id === target.parent_account_id) || target
  }

  function canAttachAccount(source, target) {
    if (!source || !target) return false
    if (source.id === target.id) return false
    if (source.trashed_at || target.trashed_at) return false
    if (target.parent_account_id) return false
    // Both accounts must have a type and an owner assigned before they can be merged.
    if (!source.type || !source.owner_id) return false
    if (!target.type || !target.owner_id) return false
    return hasSameMergeFields(source, target, owners)
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

  // Applies a new display order for root accounts, persisting it to preferences.
  // insertAfterId: the account ID to insert the dragged account after, or null for top.
  function reorderAccount(accountId, insertAfterId) {
    setAccountOrder(prev => {
      const allRootIds = rootAccounts.map(a => a.id)
      const base = prev ? [
        ...prev.filter(id => allRootIds.includes(id)),
        ...allRootIds.filter(id => !prev.includes(id)),
      ] : allRootIds
      const without = base.filter(id => id !== accountId)
      if (insertAfterId === null) return [accountId, ...without]
      // insertAfterId may be a child account ID; map it to its root for order purposes.
      const insertAfterRootId = findRootIdForOrderSlot(insertAfterId, rootAccounts, childAccountsByParent)
      if (insertAfterRootId === null) return [accountId, ...without]
      const afterIdx = without.indexOf(insertAfterRootId)
      if (afterIdx === -1) return [...without, accountId]
      return [...without.slice(0, afterIdx + 1), accountId, ...without.slice(afterIdx + 1)]
    })
    clearDragState()
  }

  // Detaches a child account from its parent and places it at the given position
  // in the root order. The detach API call happens first; then we update local order.
  async function detachAndReorder(account, insertAfterId) {
    // Resolve the drop position to a root anchor now, using pre-detach data, so the
    // position is correct even after the account list changes on reload.
    const anchorRootId = findRootIdForOrderSlot(insertAfterId, rootAccounts, childAccountsByParent)
    setMovingAccountId(account.id)
    try {
      await api.detachAccount(account.id)
      const rows = await reloadAccounts()
      const allRootIds = rows.filter(a => !a.parent_account_id && !a.trashed_at).map(a => a.id)
      setAccountOrder(prev => {
        const base = prev ? [
          ...prev.filter(id => allRootIds.includes(id)),
          ...allRootIds.filter(id => !prev.includes(id)),
        ] : allRootIds
        const without = base.filter(id => id !== account.id)
        if (anchorRootId === null) return [account.id, ...without]
        const afterIdx = without.indexOf(anchorRootId)
        if (afterIdx === -1) return [...without, account.id]
        return [...without.slice(0, afterIdx + 1), account.id, ...without.slice(afterIdx + 1)]
      })
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

  // Given an account ID (which may be a child or root), returns the root account ID
  // that controls its position in the order array, or null if not found.
  function findRootIdForOrderSlot(accountId, currentRootAccounts, currentChildsByParent) {
    if (!accountId) return null
    if (currentRootAccounts.find(a => a.id === accountId)) return accountId
    for (const root of currentRootAccounts) {
      const children = currentChildsByParent.get(root.id) || []
      if (children.find(c => c.id === accountId)) return root.id
    }
    return null
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
    draggingAccountIdRef.current = account.id
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', account.id)

    // Clone the row element as the drag ghost so it looks like the account record.
    const rowEl = event.currentTarget.closest('[data-account-row]')
    if (rowEl) {
      const clone = rowEl.cloneNode(true)
      clone.style.position = 'fixed'
      clone.style.top = '-9999px'
      clone.style.left = '-9999px'
      clone.style.width = `${rowEl.offsetWidth}px`
      clone.style.opacity = '0.92'
      clone.style.pointerEvents = 'none'
      clone.style.borderRadius = '8px'
      clone.style.boxShadow = '0 8px 24px rgba(0,0,0,0.22)'
      clone.style.background = 'var(--surface)'
      clone.style.border = '1px solid var(--border)'
      document.body.appendChild(clone)
      event.dataTransfer.setDragImage(clone, rowEl.offsetWidth / 2, rowEl.offsetHeight / 2)
      requestAnimationFrame(() => document.body.removeChild(clone))
    }
  }

  function handleAccountDragEnd() {
    clearDragState()
  }

  // Document-level listener active only during a drag, solely to handle the case where the
  // pointer moves above the list container — which is outside the list's onDragOver target area.
  // In that case we need to scroll the outer page container upward to bring the list into view.
  useEffect(() => {
    if (!draggingAccountId) return
    function onDocDragOver(event) {
      if (!listRef.current || !outerScrollRef.current) return
      const listRect = listRef.current.getBoundingClientRect()
      // Only act when the pointer is above the list top — the container handler covers everything else.
      // Guard: if listRect.top >= 0 the list top is visible, so only act if pointer is above it.
      // If listRect.top < 0 the list has scrolled off the top, so we always want to scroll up.
      if (listRect.top >= 0 && event.clientY >= listRect.top) return
      event.preventDefault()
      const scrollZone = 80
      const dist = listRect.top - event.clientY // positive: how far above the list top the pointer is
      const speed = Math.round(Math.min(dist / scrollZone, 1) * 16)
      cancelAnimationFrame(dragScrollRafRef.current)
      dragScrollRafRef.current = null
      if (speed > 0) {
        const scroll = () => {
          if (!outerScrollRef.current) return
          outerScrollRef.current.scrollTop = Math.max(0, outerScrollRef.current.scrollTop - speed)
          dragScrollRafRef.current = requestAnimationFrame(scroll)
        }
        dragScrollRafRef.current = requestAnimationFrame(scroll)
      }
    }
    document.addEventListener('dragover', onDocDragOver)
    return () => {
      document.removeEventListener('dragover', onDocDragOver)
    }
  }, [draggingAccountId]) // eslint-disable-line react-hooks/exhaustive-deps

  const dragInvalidSinceRef = useRef(null)

  // Single dragover handler on the list container. Handles all drag logic:
  // - auto-scroll (inner list and outer page container)
  // - target row detection via elementFromPoint to eliminate cursor flash at row gaps
  // - left-margin detach/reorder projection
  // - merge vs reorder intent
  // - invalid-hover tooltip
  function handleListDragOver(event) {
    if (!listRef.current || !draggingAccountIdRef.current || showCreateAccount || movingAccountId) return
    event.preventDefault()

    const listRect = listRef.current.getBoundingClientRect()
    const scrollZone = 60

    // --- Inner list scroll ---
    const distFromTop = event.clientY - listRect.top
    const distFromBottom = listRect.bottom - event.clientY
    let speed = 0
    if (distFromTop < scrollZone) speed = -Math.round((1 - Math.max(0, distFromTop) / scrollZone) * 14)
    else if (distFromBottom < scrollZone) speed = Math.round((1 - Math.max(0, distFromBottom) / scrollZone) * 14)

    cancelAnimationFrame(dragScrollRafRef.current)
    dragScrollRafRef.current = null
    if (speed !== 0) {
      const scroll = () => {
        if (!listRef.current) return
        listRef.current.scrollTop += speed
        dragScrollRafRef.current = requestAnimationFrame(scroll)
      }
      dragScrollRafRef.current = requestAnimationFrame(scroll)
    }

    // --- Left-margin projection ---
    // When the pointer is left of the list, project vertical position onto the list.
    // Always a reorder (never a merge). A child will detach+reorder; a root just reorders.
    if (event.clientX < listRect.left) {
      const flat = orderedRootAccounts.flatMap(root => [
        root,
        ...(collapsedGroups.has(root.id) ? [] : (childAccountsByParent.get(root.id) || [])),
      ])
      let insertAfterId = null
      for (const a of flat) {
        const rowEl = listRef.current.querySelector(`[data-account-row-id="${a.id}"]`)
        if (!rowEl) continue
        if (rowEl.getBoundingClientRect().bottom < event.clientY) insertAfterId = a.id
        else break
      }
      setDropIntent({ kind: 'reorder', insertAfterId, isDetach: !!draggingAccount?.parent_account_id })
      dragInvalidSinceRef.current = null
      clearTimeout(dragTooltipTimerRef.current)
      setDragTooltip(null)
      return
    }

    // --- Target row detection via elementFromPoint ---
    // Temporarily hide pointer events on the drag ghost/overlay elements so elementFromPoint
    // finds the actual row underneath. Using a point slightly inside the list bounds.
    const el = document.elementFromPoint(
      Math.max(listRect.left + 1, Math.min(event.clientX, listRect.right - 1)),
      event.clientY,
    )
    const rowEl = el?.closest('[data-account-row-id]')
    const targetId = rowEl?.dataset?.accountRowId
    const target = targetId ? activeAccounts.find(a => a.id === targetId) : null

    if (!target || !draggingAccount) {
      // Pointer is over the list container but not over any row (e.g. below all rows).
      setDropIntent(null)
      dragInvalidSinceRef.current = null
      clearTimeout(dragTooltipTimerRef.current)
      setDragTooltip(null)
      return
    }

    // --- Group interior logic ---
    const targetParentId = target.parent_account_id || null
    const targetGroupRootId = targetParentId
      ? targetParentId
      : ((childAccountsByParent.get(target.id) || []).length > 0 ? target.id : null)
    const draggingGroupRootId = draggingAccount.parent_account_id || null

    // Within own group — children can be reordered via edge zones; center zone is a no-op.
    if (draggingGroupRootId && draggingGroupRootId === targetGroupRootId) {
      event.dataTransfer.dropEffect = 'move'
      // Edge zones on sibling children allow reordering within the group.
      if (draggingAccount.parent_account_id && target.parent_account_id) {
        const rowRect = rowEl.getBoundingClientRect()
        const relY = event.clientY - rowRect.top
        const edgeZone = rowRect.height * 0.28
        if (relY < edgeZone || relY > rowRect.height - edgeZone) {
          const insertAfterId = relY < edgeZone ? getIdBeforeInOrder(target.id) : target.id
          setDropIntent({ kind: 'reorder', insertAfterId, childParentId: draggingGroupRootId })
          dragInvalidSinceRef.current = null
          clearTimeout(dragTooltipTimerRef.current)
          setDragTooltip(null)
          return
        }
      }
      setDropIntent({ kind: 'merge', targetId: draggingGroupRootId })
      event.dataTransfer.dropEffect = 'move'
      dragInvalidSinceRef.current = null
      clearTimeout(dragTooltipTimerRef.current)
      setDragTooltip(null)
      return
    }

    const targetIsInGroup = !!targetGroupRootId
    const rowRect = rowEl.getBoundingClientRect()
    const relY = event.clientY - rowRect.top
    const edgeZone = rowRect.height * 0.28
    const inTopEdge = !targetIsInGroup && relY < edgeZone
    const inBottomEdge = !targetIsInGroup && relY > rowRect.height - edgeZone

    if (inTopEdge || inBottomEdge) {
      event.dataTransfer.dropEffect = 'move'
      const insertAfterId = inTopEdge ? getIdBeforeInOrder(target.id) : target.id
      setDropIntent({ kind: 'reorder', insertAfterId })
      dragInvalidSinceRef.current = null
      clearTimeout(dragTooltipTimerRef.current)
      setDragTooltip(null)
      return
    }

    const mergeTarget = resolveDropTarget(target)
    if (canAttachAccount(draggingAccount, mergeTarget)) {
      event.dataTransfer.dropEffect = 'move'
      setDropIntent({ kind: 'merge', targetId: mergeTarget.id })
      dragInvalidSinceRef.current = null
      clearTimeout(dragTooltipTimerRef.current)
      setDragTooltip(null)
      return
    }

    // Cannot merge — show tooltip after delay.
    event.dataTransfer.dropEffect = 'none'
    setDropIntent(null)
    const sourceMissingType = !draggingAccount.type
    const sourceMissingOwner = !draggingAccount.owner_id
    const targetMissingType = !mergeTarget.type
    const targetMissingOwner = !mergeTarget.owner_id
    const sourceMissingFields = sourceMissingType || sourceMissingOwner
    const targetMissingFields = targetMissingType || targetMissingOwner
    const ownerMismatch = !sourceMissingFields && !targetMissingFields &&
      !ownersAreCompatible(draggingAccount, mergeTarget, owners)
    const typeMismatch = !sourceMissingFields && !targetMissingFields &&
      (draggingAccount.type || '') !== (mergeTarget.type || '')
    const sourceNeeds = [sourceMissingType ? 'a type' : null, sourceMissingOwner ? 'an owner' : null].filter(Boolean)
    const targetNeeds = [targetMissingType ? 'a type' : null, targetMissingOwner ? 'an owner' : null].filter(Boolean)
    const reasons = [
      sourceNeeds.length ? `this account needs ${sourceNeeds.join(' and ')}` : null,
      targetNeeds.length && !sourceMissingFields ? `that account needs ${targetNeeds.join(' and ')}` : null,
      ownerMismatch ? 'different owners' : null,
      typeMismatch ? 'different account types' : null,
    ].filter(Boolean).join(', ')
    if (reasons && dragInvalidSinceRef.current === null) {
      dragInvalidSinceRef.current = Date.now()
      clearTimeout(dragTooltipTimerRef.current)
      dragTooltipTimerRef.current = setTimeout(() => {
        setDragTooltip({ x: event.clientX, y: event.clientY, message: `Can't merge: ${reasons}` })
      }, 600)
    } else if (!reasons) {
      dragInvalidSinceRef.current = null
      clearTimeout(dragTooltipTimerRef.current)
      setDragTooltip(null)
    }
  }

  // Single drop handler on the list container.
  function handleListDrop(event) {
    if (!draggingAccount) return

    // Left-margin drop.
    if (dropIntent?.kind === 'reorder' && dropIntent.isDetach) {
      event.preventDefault()
      if (draggingAccount.parent_account_id) {
        detachAndReorder(draggingAccount, dropIntent.insertAfterId)
      } else {
        reorderAccount(draggingAccount.id, dropIntent.insertAfterId)
      }
      return
    }

    const listRect = listRef.current?.getBoundingClientRect()
    if (!listRect || event.clientX < listRect.left) return

    const el = document.elementFromPoint(
      Math.max(listRect.left + 1, Math.min(event.clientX, listRect.right - 1)),
      event.clientY,
    )
    const rowEl = el?.closest('[data-account-row-id]')
    const targetId = rowEl?.dataset?.accountRowId
    const target = targetId ? activeAccounts.find(a => a.id === targetId) : null
    if (!target) return

    const targetParentId = target.parent_account_id || null
    const targetGroupRootId = targetParentId
      ? targetParentId
      : ((childAccountsByParent.get(target.id) || []).length > 0 ? target.id : null)
    const draggingGroupRootId = draggingAccount.parent_account_id || null

    // Drop within own group — reorder child if edge zone, otherwise no-op.
    if (draggingGroupRootId && draggingGroupRootId === targetGroupRootId) {
      if (dropIntent?.kind === 'reorder' && dropIntent.childParentId) {
        event.preventDefault()
        reorderChild(dropIntent.childParentId, draggingAccount.id, dropIntent.insertAfterId)
      } else {
        clearDragState()
      }
      return
    }

    const targetIsInGroup = !!targetGroupRootId
    const rowRect = rowEl.getBoundingClientRect()
    const relY = event.clientY - rowRect.top
    const edgeZone = rowRect.height * 0.28
    const inTopEdge = !targetIsInGroup && relY < edgeZone
    const inBottomEdge = !targetIsInGroup && relY > rowRect.height - edgeZone

    if (inTopEdge || inBottomEdge) {
      event.preventDefault()
      const insertAfterId = inTopEdge ? getIdBeforeInOrder(target.id) : target.id
      if (draggingAccount.parent_account_id) {
        detachAndReorder(draggingAccount, insertAfterId)
      } else {
        reorderAccount(draggingAccount.id, insertAfterId)
      }
      return
    }

    const mergeTarget = resolveDropTarget(target)
    if (!canAttachAccount(draggingAccount, mergeTarget)) return
    event.preventDefault()
    attachAccount(draggingAccount, mergeTarget)
  }

  // Returns the ID of the item that comes just before targetId in the current flat rendered order
  // (root accounts interleaved with their children), or null if targetId is first.
  function getIdBeforeInOrder(targetId) {
    const flat = orderedRootAccounts.flatMap(root => [
      root,
      ...(orderedChildrenByParent.get(root.id) || []),
    ])
    const idx = flat.findIndex(a => a.id === targetId)
    if (idx <= 0) return null
    return flat[idx - 1].id
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

  // Apply saved display order to root accounts. IDs in accountOrder that no longer exist are
  // dropped; roots not yet in the order are appended in their API-returned order.
  // When a column sort is active it overrides the saved order.
  const typeOrder = Object.fromEntries(ACCOUNT_TYPES.map((t, i) => [t.value, i]))
  const baseOrderedRoots = accountOrder
    ? [
        ...accountOrder.map(id => rootAccounts.find(a => a.id === id)).filter(Boolean),
        ...rootAccounts.filter(a => !accountOrder.includes(a.id)),
      ]
    : rootAccounts
  const orderedRootAccounts = [...baseOrderedRoots].sort((a, b) => {
    let cmp = 0
    if (sortKey === 'name') {
      cmp = (a.name || '').localeCompare(b.name || '')
    } else if (sortKey === 'type') {
      const ai = typeOrder[a.type] ?? 99
      const bi = typeOrder[b.type] ?? 99
      cmp = ai - bi
    } else if (sortKey === 'owner') {
      cmp = (a.owner_name || '').localeCompare(b.owner_name || '')
    }
    return sortDir === 'asc' ? cmp : -cmp
  })

  // Apply saved child order per parent group. Same pattern as root order.
  const orderedChildrenByParent = new Map()
  for (const [parentId, children] of childAccountsByParent.entries()) {
    const savedIds = childOrder[parentId]
    if (savedIds && Array.isArray(savedIds)) {
      orderedChildrenByParent.set(parentId, [
        ...savedIds.map(id => children.find(c => c.id === id)).filter(Boolean),
        ...children.filter(c => !savedIds.includes(c.id)),
      ])
    } else {
      orderedChildrenByParent.set(parentId, children)
    }
  }

  // Reorder a child within its parent group.
  function reorderChild(parentId, childId, insertAfterId) {
    setChildOrder(prev => {
      const allChildren = childAccountsByParent.get(parentId) || []
      const allChildIds = allChildren.map(c => c.id)
      const savedIds = prev[parentId]
      const base = savedIds ? [
        ...savedIds.filter(id => allChildIds.includes(id)),
        ...allChildIds.filter(id => !savedIds.includes(id)),
      ] : allChildIds
      const without = base.filter(id => id !== childId)
      // insertAfterId may be null (insert at top) or the parent ID (also means insert at top,
      // since the parent is the item before the first child in the flat order).
      const effectiveInsertAfterId = insertAfterId === parentId ? null : insertAfterId
      if (effectiveInsertAfterId === null) return { ...prev, [parentId]: [childId, ...without] }
      const afterIdx = without.indexOf(effectiveInsertAfterId)
      // If not found among siblings (shouldn't happen but be safe), insert at top.
      if (afterIdx === -1) return { ...prev, [parentId]: [childId, ...without] }
      return { ...prev, [parentId]: [...without.slice(0, afterIdx + 1), childId, ...without.slice(afterIdx + 1)] }
    })
    clearDragState()
  }

  // Compute the pixel position of the reorder insert line relative to listRef.
  // We read from the DOM on each render during a drag — this is intentional since
  // the drag is already causing re-renders via dropIntent state changes.
  let insertLineTop = null
  let insertLineIsDetach = false
  if (dropIntent?.kind === 'reorder' && listRef.current) {
    const listRect = listRef.current.getBoundingClientRect()
    const { insertAfterId } = dropIntent
    insertLineIsDetach = !!dropIntent.isDetach
    if (insertAfterId === null) {
      insertLineTop = 0
    } else {
      const rowEl = listRef.current.querySelector(`[data-account-row-id="${insertAfterId}"]`)
      if (rowEl) {
        const rowRect = rowEl.getBoundingClientRect()
        insertLineTop = rowRect.bottom - listRect.top + listRef.current.scrollTop
      }
    }
  }

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
      {dragTooltip ? (
        <div style={{
          position: 'fixed',
          left: dragTooltip.x + 14,
          top: dragTooltip.y + 14,
          zIndex: 400,
          background: '#ffffff',
          border: '1.5px solid #000000',
          borderRadius: 6,
          padding: '5px 10px',
          fontSize: 12,
          color: '#000000',
          boxShadow: '0 4px 12px rgba(0,0,0,0.35)',
          pointerEvents: 'none',
          maxWidth: 260,
          lineHeight: 1.4,
        }}>
          {dragTooltip.message}
        </div>
      ) : null}
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

      <div ref={outerScrollRef} data-browser-context-passthrough="true" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 32px 32px' }}>
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
              {orderedRootAccounts.some(r => (childAccountsByParent.get(r.id) || []).length > 0) && (
                <>
                  <Button small variant="ghost" style={{ display: 'block', width: '100%', marginTop: 4 }} onClick={() => {
                    setCollapsedGroups(new Set(orderedRootAccounts.filter(r => (childAccountsByParent.get(r.id) || []).length > 0).map(r => r.id)))
                    setContextOpen(false)
                  }}>Collapse all groups</Button>
                  <Button small variant="ghost" style={{ display: 'block', width: '100%', marginTop: 4 }} onClick={() => {
                    setCollapsedGroups(new Set())
                    setContextOpen(false)
                  }}>Expand all groups</Button>
                </>
              )}
            </div>
          )}
        </div>

        {loading || !sectionStateLoaded || !sortLoaded ? <Spinner /> : (
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
                    <div
                      onContextMenu={e => {
                        if (!orderedRootAccounts.some(r => (childAccountsByParent.get(r.id) || []).length > 0)) return
                        e.preventDefault()
                        setListContextMenu({ x: e.clientX, y: e.clientY })
                      }}
                      style={{
                      display: 'grid',
                      gridTemplateColumns: ACCOUNT_ROW_COLUMNS,
                      gap: ACCOUNT_ROW_GAP,
                      padding: '6px 10px',
                      borderBottom: '1px solid var(--border)',
                      background: 'var(--surface2)',
                      alignItems: 'center',
                    }}>
                      <span />
                      {['name', 'type', 'owner'].map((key) => {
                        const labels = { name: 'Account', type: 'Type', owner: 'Owner' }
                        const active = sortKey === key
                        const indicator = sortDir === 'asc' ? ' ↑' : ' ↓'
                        const el = (
                          <button
                            key={key}
                            type="button"
                            onClick={() => {
                              if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
                              else { setSortKey(key); setSortDir('asc') }
                            }}
                            style={{
                              background: 'none',
                              border: 'none',
                              padding: 0,
                              cursor: 'pointer',
                            }}
                          >
                            <HeaderPill style={active ? {
                              background: 'color-mix(in srgb, var(--accent) 15%, var(--surface2))',
                              color: 'var(--accent)',
                              borderColor: 'color-mix(in srgb, var(--accent) 40%, var(--border))',
                            } : {}}>
                              {labels[key]}{active ? indicator : ''}
                            </HeaderPill>
                          </button>
                        )
                        if (key === 'owner') {
                          return <div key={key} style={{ display: 'flex', justifyContent: 'center' }}>{el}</div>
                        }
                        return <span key={key} style={key === 'type' ? { marginLeft: 6 } : {}}>{el}</span>
                      })}
                      <span />
                    </div>
                    <div
                      ref={listRef}
                      onDragOver={handleListDragOver}
                      onDragLeave={event => {
                        if (!listRef.current?.contains(event.relatedTarget)) {
                          cancelAnimationFrame(dragScrollRafRef.current)
                          dragScrollRafRef.current = null
                        }
                      }}
                      onDrop={handleListDrop}
                      onContextMenu={e => {
                        if (!orderedRootAccounts.some(r => (childAccountsByParent.get(r.id) || []).length > 0)) return
                        e.preventDefault()
                        setListContextMenu({ x: e.clientX, y: e.clientY })
                      }}
                      style={{ maxHeight: 640, overflowY: 'auto', position: 'relative' }}
                    >
                      {listContextMenu && (
                        <div
                          style={{
                            position: 'fixed',
                            left: Math.min(listContextMenu.x, window.innerWidth - 200),
                            top: Math.min(listContextMenu.y, window.innerHeight - 100),
                            zIndex: 300,
                            background: 'var(--surface)',
                            border: '1px solid var(--border)',
                            borderRadius: 10,
                            boxShadow: '0 8px 32px rgba(0,0,0,0.22)',
                            padding: 4,
                            minWidth: 180,
                          }}
                          onMouseLeave={() => setListContextMenu(null)}
                        >
                          <button type="button" onClick={() => {
                            setCollapsedGroups(new Set(orderedRootAccounts.filter(r => (childAccountsByParent.get(r.id) || []).length > 0).map(r => r.id)))
                            setListContextMenu(null)
                          }} style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', color: 'var(--text)', fontSize: 13, padding: '8px 10px', borderRadius: 6, cursor: 'pointer' }}>
                            Collapse all groups
                          </button>
                          <button type="button" onClick={() => {
                            setCollapsedGroups(new Set())
                            setListContextMenu(null)
                          }} style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', color: 'var(--text)', fontSize: 13, padding: '8px 10px', borderRadius: 6, cursor: 'pointer' }}>
                            Expand all groups
                          </button>
                        </div>
                      )}
                      {insertLineTop !== null && (
                        <div style={{
                          position: 'absolute',
                          left: insertLineIsDetach ? 0 : 10,
                          right: 10,
                          top: insertLineTop,
                          height: 2,
                          borderRadius: 1,
                          background: 'var(--accent)',
                          opacity: insertLineIsDetach ? 0.5 : 1,
                          borderTop: insertLineIsDetach ? '2px dashed var(--accent)' : undefined,
                          pointerEvents: 'none',
                          zIndex: 10,
                        }} />
                      )}
                      {orderedRootAccounts.map(root => {
                        const children = orderedChildrenByParent.get(root.id) || []
                        const isCollapsed = collapsedGroups.has(root.id)
                        const rootDragDisabled = movingAccountId === root.id
                        const groupMergeActive = dropIntent?.kind === 'merge' && dropIntent.targetId === root.id
                        return (
                          <div key={root.id}>
                            <AccountRow
                              account={root}
                              hasChildren={children.length}
                              isCollapsed={isCollapsed}
                              onToggleCollapse={() => setCollapsedGroups(prev => {
                                const next = new Set(prev)
                                if (next.has(root.id)) next.delete(root.id)
                                else next.add(root.id)
                                return next
                              })}
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
                              dropActive={groupMergeActive}
                              onDragStart={handleAccountDragStart}
                              onDragEnd={handleAccountDragEnd}
                            />
                            {!isCollapsed && children.map((child, childIdx) => (
                              <AccountRow
                                key={child.id}
                                account={child}
                                parentAccount={root}
                                isLastChild={childIdx === children.length - 1}
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
                                dropActive={groupMergeActive}
                                onDragStart={handleAccountDragStart}
                                onDragEnd={handleAccountDragEnd}
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
