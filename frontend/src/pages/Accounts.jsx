// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api.js'
import { notifyAccountsChanged } from '../App.jsx'
import { Button, Spinner, Toggle, AppConfirmDialog, AppNoticeDialog, AppTextEntryDialog, FilterChip, IconButton } from '../components/ui.jsx'
import { useAccountDetailPanels } from '../components/accounts/useAccountDetailPanels.jsx'
import SectionCard from '../components/SectionCard.jsx'
import PillTableHeader from '../components/PillTableHeader.jsx'
import TagPickerWithCreate from '../components/TagPickerWithCreate.jsx'
import FeatureExplainer from '../help/FeatureExplainer.jsx'
import { useDismissibleLayer, useDismissiblePopup, useTransientTextEdit } from '../lib/uiInteractions.js'
import TransientTextInput from '../components/TransientTextInput.jsx'
import AccountRemovalDialog from '../components/accounts/AccountRemovalDialog.jsx'
import { ActionMenu, ActionMenuButton } from '../components/ActionMenu.jsx'
import { ACCOUNT_TYPES } from '../lib/accountTypes.js'
import { useAppSession } from '../lib/AppSessionContext.jsx'
import { useUserPreferences } from '../lib/UserPreferencesContext.jsx'
import { useColumnPreference } from '../lib/useColumnPreference.js'
import { dividerIsDraggable, moveDivider } from '../lib/columnDividers.js'
import { localStore, sessionStore } from '../lib/browserStorage.js'
import { DRAG_SOURCE_STYLE, preventPressDefaults, startPointerDrag, useDropZone } from '../lib/pointerDrag.js'
import { useAnchoredPopup } from '../lib/anchoredPopup.js'

const ACCOUNTS_SECTIONS_PREF_KEY = 'ui.accounts.sections'
const ACCOUNTS_SECTIONS_STORAGE_KEY_PREFIX = 'luma.accounts.sections'
const LEGACY_ACCOUNT_OWNERS_PREF_KEY = 'ui.accounts.accountOwnersExpanded'
const LEGACY_ACCOUNT_OWNERS_STORAGE_KEY_PREFIX = 'luma.accounts.accountOwnersExpanded'
const ACCOUNTS_COLLAPSED_PREF_KEY = 'ui.accounts.collapsedGroups'
const ACCOUNTS_COLLAPSED_STORAGE_KEY_PREFIX = 'luma.accounts.collapsedGroups'
const ACCOUNTS_SORT_PREF_KEY = 'ui.accounts.sort'
const ACCOUNTS_SORT_STORAGE_KEY_PREFIX = 'luma.accounts.sort'
const ACCOUNTS_COLUMNS_PREF_KEY = 'ui.accounts.columns'

// Account-list column geometry. Name is the fluid filler (`minmax(0, 1fr)`) so the table always fits
// its container with no horizontal scrollbar: the divider between Name and Type trades width between
// those two, and the dividers after it follow the shared rule in `lib/columnDividers.js`. The
// drag-handle and delete gutters stay fixed, so Tags is resized from its left divider. Widths/order
// persist via the shared useColumnPreference model. Order MUST match the header config and the cell
// order rendered by AccountRow/DraftAccountRow.
const ACCOUNT_COLUMN_DEFAULTS = [
  { key: 'drag', width: 22, resizable: false },
  { key: 'name', width: 'minmax(0, 1fr)' },
  { key: 'type', width: 110, minWidth: 90 },
  { key: 'owner', width: 116, minWidth: 96 },
  { key: 'tags', width: 112, minWidth: 84 },
  { key: 'actions', width: 28, resizable: false },
]

// Numeric widths render as pixels; string widths (the Name filler) pass through so the column flexes.
function buildAccountGridTemplate(columns) {
  return columns
    .map(column => (typeof column.width === 'number' ? `${column.width}px` : column.width))
    .join(' ')
}

const ACCOUNT_ROW_CHILD_INDENT = 28
const ACCOUNT_ROW_GAP = 10
const ACCOUNT_ROW_PADDING = '3px 10px'
const ACCOUNT_CONTROL_HEIGHT = 22
const ACCOUNT_DETACH_DROP_ZONE_WIDTH = 84
// The account list is the only thing on its own tab now, so it isn't constrained to share a width with
// the sparse Owners panel — give it modestly more room for long account names.
const ACCOUNTS_SECTION_BASE_WIDTH = 720
// In-page tabs (mirroring the Import page). The active tab is session-scoped: it sticks while the
// app is open but resets to Accounts next launch (a within-session convenience, not a durable preference).
const ACCOUNT_TABS = [['accounts', 'Accounts'], ['owners', 'Owners']]
const ACCOUNTS_TAB_STORAGE_KEY = 'luma.accounts.tab'
const ACCOUNT_TYPE_ORDER = Object.fromEntries(ACCOUNT_TYPES.map((type, index) => [type.value, index]))
const ACCOUNT_SORT_KEYS = ['name', 'type', 'owner']
const DEFAULT_ACCOUNT_SORT_DIRECTIONS = { name: 'asc', type: 'asc', owner: 'asc' }
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

function getAccountsCollapsedStorageKey(dbInstanceId, userId) {
  return dbInstanceId && userId
    ? `${ACCOUNTS_COLLAPSED_STORAGE_KEY_PREFIX}.${dbInstanceId}.${userId}`
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

function normalizeSortDirection(value) {
  return value === 'desc' ? 'desc' : 'asc'
}

function normalizeAccountSortDirections(value, fallbackDir = 'asc') {
  const nextDirections = { ...DEFAULT_ACCOUNT_SORT_DIRECTIONS }
  if (isObjectLike(value)) {
    for (const key of ACCOUNT_SORT_KEYS) {
      if (value[key]) nextDirections[key] = normalizeSortDirection(value[key])
    }
  }
  nextDirections.type = normalizeSortDirection(nextDirections.type || fallbackDir)
  return nextDirections
}

function compareAccountNames(a, b) {
  return (a.name || '').localeCompare(b.name || '')
}

function buildAccountSortComparator(sortKey, sortDir) {
  return (a, b) => {
    const nameCmp = compareAccountNames(a, b)
    const typeCmp = (ACCOUNT_TYPE_ORDER[a.type] ?? 99) - (ACCOUNT_TYPE_ORDER[b.type] ?? 99)
    const ownerCmp = (a.owner_name || '').localeCompare(b.owner_name || '')
    const dir = sortDir === 'asc' ? 1 : -1
    if (sortKey === 'type') return dir * (typeCmp || ownerCmp || nameCmp)
    if (sortKey === 'owner') return dir * (ownerCmp || typeCmp || nameCmp)
    return dir * (nameCmp || typeCmp || ownerCmp)
  }
}

function orderAccountsForDisplay(rows, sortKey, sortDir) {
  const visibleRoots = []
  const hiddenRows = []
  const childrenByParent = new Map()

  for (const row of rows) {
    if (row.trashed_at) {
      hiddenRows.push(row)
      continue
    }
    if (row.parent_account_id) {
      const list = childrenByParent.get(row.parent_account_id) || []
      list.push(row)
      childrenByParent.set(row.parent_account_id, list)
      continue
    }
    visibleRoots.push(row)
  }

  const orderedVisibleRows = []
  const sortedRoots = [...visibleRoots].sort(buildAccountSortComparator(sortKey, sortDir))
  const placedChildIds = new Set()
  const visibleRootIds = new Set(sortedRoots.map(row => row.id))

  for (const root of sortedRoots) {
    orderedVisibleRows.push(root)
    const sortedChildren = [...(childrenByParent.get(root.id) || [])].sort(compareAccountNames)
    for (const child of sortedChildren) {
      placedChildIds.add(child.id)
      orderedVisibleRows.push(child)
    }
  }

  const orphanChildren = []
  for (const [parentId, children] of childrenByParent.entries()) {
    if (visibleRootIds.has(parentId)) continue
    orphanChildren.push(...children)
  }

  return [
    ...orderedVisibleRows,
    ...orphanChildren.filter(child => !placedChildIds.has(child.id)).sort(compareAccountNames),
    ...hiddenRows,
  ]
}

function reconcileAccountOrder(previousRows, nextRows) {
  const nextById = new Map(nextRows.map(row => [row.id, row]))
  const orderedRows = []
  const seenIds = new Set()

  for (const row of previousRows) {
    const next = nextById.get(row.id)
    if (!next) continue
    orderedRows.push(next)
    seenIds.add(row.id)
  }

  for (const row of nextRows) {
    if (seenIds.has(row.id)) continue
    orderedRows.push(row)
  }

  return orderedRows
}

function OwnerFilterPill({ label, count, active, onClick }) {
  return <FilterChip selected={active} count={count} onClick={onClick}>{label}</FilterChip>
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
  const selectedLabel = options.find(o => o.value === (value || ''))?.label || placeholder

  useDismissiblePopup({
    open,
    setOpen,
    anchorRef: wrapRef,
    popupRef: listRef,
    disabled,
  })
  const { popupStyle: listPlacementStyle, contentRef: listContentRef } = useAnchoredPopup({
    open,
    anchorRef: wrapRef,
    anchorWidth: 'atLeast',
    minWidth: minOpenWidth,
  })

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
            ...listPlacementStyle,
            width: 'max-content',
            maxWidth: 240,
            background: 'var(--surface2)',
            border: '1.5px solid color-mix(in srgb, var(--text) 22%, var(--border))',
            borderRadius: 10,
            boxShadow: '0 2px 8px rgba(0,0,0,0.12), 0 12px 40px rgba(0,0,0,0.36)',
            padding: 4,
            zIndex: 200,
          }}
        >
          <div ref={listContentRef}>
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
        </div>
      ) : null}
    </div>
  )
}

function DraftAccountRow({ owners, onCreate, onCancel, creating, gridTemplateColumns }) {
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
        onSubmit={e => {
          e.preventDefault()
          submit()
        }}
      >
        <div style={{
          display: 'grid',
          gridTemplateColumns,
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

          {/* The tags cell is free while drafting (tags are added once the account exists), and the
              action track only fits the ⋯ menu, so the submit sits here beside the cancel. */}
          <Button
            type="submit"
            disabled={creating}
            style={{ justifySelf: 'end', height: ACCOUNT_CONTROL_HEIGHT, padding: '0 12px' }}
          >
            {creating ? 'Adding…' : 'Add'}
          </Button>

          <IconButton onClick={onCancel} aria-label="Cancel new account" style={{ width: 28, height: ACCOUNT_CONTROL_HEIGHT }}>
            ×
          </IconButton>
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

// The Owners panel's one column heading. Each switch sits under the "t" of "transactions": its cell
// leads with a hidden copy of the words before it, so the offset is measured by the text itself.
const REVIEW_FLAG_HEADING_LEAD = 'Flag new '
const REVIEW_FLAG_HEADING_REST = 'transactions for review'
const REVIEW_FLAG_HEADING_STYLE = { fontSize: 12, color: 'var(--muted)', whiteSpace: 'pre' }

function OwnersPanel({ owners, onCreateOwner, onSaveOwner, onDeleteOwner, onError = () => { }, disabled = false, width, expanded, onExpandedChange, collapsible = true }) {
  const visibleOwners = getPersonalOwners(owners)
  // Shared gets a row once an account can be assigned to it, since its review flagging is then a choice
  // like any other owner's.
  const ownerRows = getAssignableOwners(owners)
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

  async function setReviewFlagging(owner, enabled) {
    try {
      await onSaveOwner(owner.id, { flag_new_for_review: enabled })
    } catch (error) {
      onError('Could not update owner', error)
    }
  }

  async function submitNewOwner() {
    const trimmed = newOwnerDraft.trim()
    if (!trimmed) return
    try {
      await onCreateOwner(trimmed)
      setCreatingOwner(false)
      setNewOwnerDraft('')
    } catch (error) {
      onError('Could not create owner', error)
    }
  }

  return (
    <SectionCard
      title="Account Owners"
      summary={ownersSummary}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      collapsible={collapsible}
      disabled={disabled}
      width={width}
      style={collapsible ? {
        marginTop: 12,
      } : undefined}
    >
      <div style={{ padding: '12px 16px 14px' }}>
        {visibleOwners.length > 0 ? (
          <div style={{ display: 'grid', gap: 12, justifyItems: 'start' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'max-content max-content', gap: '8px 20px', alignItems: 'center', justifyItems: 'start' }}>
              <span />
              <span style={REVIEW_FLAG_HEADING_STYLE}>{REVIEW_FLAG_HEADING_LEAD}{REVIEW_FLAG_HEADING_REST}</span>
              {ownerRows.map(owner => (
                <Fragment key={owner.id}>
                  <OwnerPill
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
                  <div style={{ display: 'inline-flex', alignItems: 'center' }}>
                    <span aria-hidden="true" style={{ ...REVIEW_FLAG_HEADING_STYLE, visibility: 'hidden' }}>{REVIEW_FLAG_HEADING_LEAD}</span>
                    <Toggle
                      checked={!!owner.flag_new_for_review}
                      onChange={enabled => setReviewFlagging(owner, enabled)}
                      ariaLabel={`${REVIEW_FLAG_HEADING_LEAD}${REVIEW_FLAG_HEADING_REST}: ${owner.name}`}
                      disabled={disabled}
                    />
                  </div>
                </Fragment>
              ))}
            </div>
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
                <Button onClick={submitNewOwner} disabled={!newOwnerDraft.trim()} style={{ height: 22, padding: '0 9px', borderRadius: 999, fontSize: 11 }}>
                  Add
                </Button>
                <Button
                  variant="secondary"
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
                variant="secondary"
                onClick={() => {
                  setEditingOwnerId(null)
                  setOwnerDraft('')
                  setCreatingOwner(true)
                }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  height: ACCOUNT_CONTROL_HEIGHT,
                  borderRadius: 999,
                  lineHeight: 1,
                }}
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
            <Button onClick={submitNewOwner} disabled={!newOwnerDraft.trim()} style={{ height: 22, padding: '0 9px', borderRadius: 999, fontSize: 11 }}>
              Add
            </Button>
            <Button
              variant="secondary"
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
            variant="secondary"
            onClick={() => setCreatingOwner(true)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: ACCOUNT_CONTROL_HEIGHT,
              borderRadius: 999,
              lineHeight: 1,
            }}
          >
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
                try {
                  await onDeleteOwner(owner)
                } catch (error) {
                  onError('Could not delete owner', error)
                }
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

// Tags cell for one account row. Top-level accounts show and edit their own tags; child accounts
// show the parent's tags as muted/inherited (read-only) — a child's own tags are dormant while
// merged (resolved through the effective account on the backend), so they aren't editable here.
function AccountTagsCell({
  account, isChild, parentAccount, allTags, editMode,
  pickerOpen, onOpenPicker, onClosePicker, onSetTags, onTagCreated,
}) {
  const tagsById = new Map((allTags || []).map(tag => [tag.id, tag]))
  const ownTagIds = Array.isArray(account.tag_ids) ? account.tag_ids : []
  const inheritedTagIds = isChild && Array.isArray(parentAccount?.tag_ids) ? parentAccount.tag_ids : []
  const displayTagIds = isChild ? inheritedTagIds : ownTagIds
  const pills = displayTagIds.map(id => tagsById.get(id)).filter(Boolean)
  const editable = !isChild
  // The "+" add-tag control shows in page-wide edit mode, and also for a single row whose picker was
  // opened on its own (via the row's right-click "Edit tags…") — the picker anchors its floating
  // position to this button, so the row needs it rendered even when edit mode is off.
  const showControls = editable && (editMode || pickerOpen)

  // The picker floats beside the "+" rather than dropping down over the column, so the tag column below
  // stays uncovered and the user can open the next row's picker without first closing this one. It opens
  // to the right of the button, kept there by the browser (useAnchoredPopup), and is not clipped by the
  // list's own scroll container the way an absolutely-positioned panel would be on the bottom rows.
  const addButtonRef = useRef(null)
  const { popupStyle: pickerPlacementStyle, contentRef: pickerContentRef } = useAnchoredPopup({
    open: editable && pickerOpen,
    anchorRef: addButtonRef,
    placement: 'beside',
    gap: 6,
  })

  function toggleTag(tag, nextChecked) {
    const next = new Set(ownTagIds)
    if (nextChecked) next.add(tag.id)
    else next.delete(tag.id)
    onSetTags(account.id, Array.from(next))
  }

  return (
    <div style={{ position: 'relative', minWidth: 0, display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
      {pills.map(tag => (
        <span
          key={tag.id}
          title={isChild ? `${tag.name} (inherited from ${parentAccount?.display_name || parentAccount?.name || 'parent account'})` : tag.name}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
            background: tag.color || 'var(--muted)', color: '#fff',
            fontSize: 9, fontWeight: 700, lineHeight: 1, cursor: 'default', userSelect: 'none',
            border: isChild ? '1.5px solid color-mix(in srgb, #0f172a 28%, transparent)' : 'none',
            opacity: isChild ? 0.75 : 1,
          }}
        >
          {((tag.name || '').trim().charAt(0) || '?').toUpperCase()}
        </span>
      ))}
      {showControls ? (
        <button
          ref={addButtonRef}
          type="button"
          onClick={() => onOpenPicker(account.id)}
          title="Add or remove tags"
          style={{
            width: 18, height: 18, borderRadius: '50%', border: '1px dashed var(--border)', background: 'var(--surface)',
            color: 'var(--muted)', cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: 0, flexShrink: 0,
          }}
        >
          +
        </button>
      ) : null}
      {editable && pickerOpen ? (
        <div
          style={{
            ...pickerPlacementStyle,
            zIndex: 520,
            borderRadius: 10,
            boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
          }}
        >
          <div ref={pickerContentRef}>
            <TagPickerWithCreate
              allTags={allTags}
              selectedTagIds={new Set(ownTagIds)}
              onToggleTag={toggleTag}
              onTagCreated={onTagCreated}
              onClose={onClosePicker}
              positioning="relative"
            />
          </div>
        </div>
      ) : null}
    </div>
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
  gridTemplateColumns,
  owners,
  onSave,
  onOpenRowMenu,
  rowMenuAccountId = null,
  renameRequest = 0,
  onOpenDetail,
  onCreateOwnerForAccount,
  onRequestRenameOwner,
  onRequestDeleteOwner,
  onError = () => { },
  interactionDisabled = false,
  dragDisabled = false,
  dropActive = false,
  onDragStart,
  allTags = [],
  tagsEditMode = false,
  tagPickerAccountId = null,
  onOpenTagPicker = () => { },
  onCloseTagPicker = () => { },
  onSetAccountTags = () => { },
  onAccountTagCreated = () => { },
}) {
  const [, setSavingName] = useState(false)
  const [creatingOwner, setCreatingOwner] = useState(false)
  const [ownerDraft, setOwnerDraft] = useState('')
  const [showOwnerCreate, setShowOwnerCreate] = useState(false)
  const [ownerMenu, setOwnerMenu] = useState(null)
  const rowRef = useRef(null)
  const ownerCreateRef = useRef(null)
  const ownerInputRef = useRef(null)
  const ownerAnchorRef = useRef(null)
  const ownerMenuRef = useRef(null)
  // The name button's tooltip shows the edit hint normally, but the full account name when the label is
  // ellipsized by a narrow column — measured on hover so it stays correct as the column/window resizes.
  const nameTextRef = useRef(null)
  const [nameHoverTitle, setNameHoverTitle] = useState('Click to edit name')
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
  }, [interactionDisabled, setEditingName])

  // The ⋯ menu's Rename drives *this* editor rather than opening one of its own — two routes to one
  // action are fine, two rename implementations are not. A counter rather than a flag, as the import
  // picker's new-account field does it, so choosing Rename again on a row already editing re-enters it
  // instead of being swallowed as "no change".
  useEffect(() => {
    if (renameRequest) beginEditingName(account.name || '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renameRequest])

  useEffect(() => {
    if (!interactionDisabled) return
    setShowOwnerCreate(false)
    setOwnerDraft('')
    setOwnerMenu(null)
  }, [interactionDisabled])

  useLayoutEffect(() => {
    if (!showOwnerCreate) return undefined
    const focusId = requestAnimationFrame(() => {
      ownerInputRef.current?.focus()
      ownerInputRef.current?.select?.()
    })
    return () => cancelAnimationFrame(focusId)
  }, [showOwnerCreate])
  // The new-owner field sits over the "Assign owner" chip, kept there by the browser (useAnchoredPopup).
  const { popupStyle: ownerCreatePlacementStyle } = useAnchoredPopup({
    open: showOwnerCreate,
    anchorRef: ownerAnchorRef,
    placement: 'over',
  })

  useDismissibleLayer({
    open: showOwnerCreate,
    onClose: () => {
      setShowOwnerCreate(false)
      setOwnerDraft('')
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
  const assignableOwners = getAssignableOwners(owners)
  // Parents with children may toggle between their personal owner and shared — restricted options
  // are passed in from the parent to enforce this. Children and plain accounts use all assignable owners.
  const effectiveOwnerOptions = restrictedOwnerOptions ?? assignableOwners
  const detailAccount = parentAccount || account
  const canShowOwnerControls = !isChild
  // Allow owner change on parents-with-children but only between personal owner and shared.
  const ownerEditDisabled = interactionDisabled || isChild
  const typeEditDisabled = interactionDisabled || isChild || hasChildren
  const canDrag = !interactionDisabled && !dragDisabled

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
    } catch (error) {
      onError('Could not create owner', error)
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
      <div
        style={{
          display: 'grid',
          gridTemplateColumns,
          gap: ACCOUNT_ROW_GAP,
          alignItems: 'center',
          padding: ACCOUNT_ROW_PADDING,
          paddingLeft: isChild ? `${10 + ACCOUNT_ROW_CHILD_INDENT}px` : undefined,
        }}>
        <button
          type="button"
          onPointerDown={canDrag ? event => onDragStart?.(event, account) : undefined}
          onClick={event => event.preventDefault()}
          title={canDrag ? (isChild ? 'Drag to reorder or pull out to top level' : 'Drag to merge or reorder') : undefined}
          style={{
            ...DRAG_SOURCE_STYLE,
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
              onMouseEnter={() => {
                if (interactionDisabled) return
                const el = nameTextRef.current
                setNameHoverTitle(el && el.scrollWidth > el.clientWidth ? account.name : 'Click to edit name')
              }}
              title={interactionDisabled ? undefined : nameHoverTitle}
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
              <span ref={nameTextRef} style={{
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
          {/* Lines under the account name. The connection detail line (institution · ···mask) comes first so
              it stays paired with the name on line 1; a merged *parent's* expand/collapse control sits below
              it (line 3). Shown for every account — parent, child, or standalone — so becoming part of a
              merged group no longer hides which real account a row maps to. (Costs a row of height on merged
              entries — acceptable given the table stays small.) CSV/manual accounts have no institution/mask,
              so no detail line renders. */}
          <div style={{ marginTop: 2, display: 'grid', gap: 1 }}>
            {(account.institution || account.mask) ? (
              <div style={{ fontSize: 10, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {account.institution && <span>{account.institution} · </span>}
                {account.mask && <span>···{account.mask}</span>}
              </div>
            ) : null}
            {hasChildren && !isChild ? (
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
                  justifySelf: 'start',
                }}
                title={isCollapsed ? 'Show merged accounts' : 'Hide merged accounts'}
              >
                <span style={{ fontSize: 9 }}>{isCollapsed ? '▶' : '▼'}</span>
                <span>{hasChildren === 1 ? '1 merged account' : `${hasChildren} merged accounts`}</span>
              </button>
            ) : null}
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
                e.stopPropagation()
                setOwnerMenu({ x: e.clientX, y: e.clientY })
              }) : null}
              disabled={ownerEditDisabled}
            />
          ) : (
            <FilterChip
              variant="add"
              disabled={ownerEditDisabled}
              onClick={() => {
                setOwnerDraft('')
                setShowOwnerCreate(true)
              }}
              title={ownerEditDisabled ? undefined : 'Create and assign owner'}
              style={{ height: ACCOUNT_CONTROL_HEIGHT, maxWidth: '100%' }}
            >
              Assign owner
            </FilterChip>
          )}
          {showOwnerCreate && canShowOwnerControls ? (
            <div
              ref={ownerCreateRef}
              onMouseDown={e => e.stopPropagation()}
              style={{
                ...ownerCreatePlacementStyle,
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
                onClick={submitCreateOwner}
                disabled={!ownerDraft.trim() || creatingOwner}
                style={{ height: 22, padding: '0 9px', borderRadius: 999, fontSize: 11 }}
              >
                {creatingOwner ? 'Adding...' : 'Add'}
              </Button>
              <Button
                variant="secondary"
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

        <AccountTagsCell
          account={account}
          isChild={isChild}
          parentAccount={parentAccount}
          allTags={allTags}
          editMode={tagsEditMode}
          pickerOpen={tagPickerAccountId === account.id}
          onOpenPicker={onOpenTagPicker}
          onClosePicker={onCloseTagPicker}
          onSetTags={onSetAccountTags}
          onTagCreated={onAccountTagCreated}
        />

        {/* An overflow menu where a one-press × used to be, and the extra press is the point rather
            than tidiness: removing an account is permanent (`AccountRemovalDialog` says why no undo is
            possible), so the protection has to be the path to it. A single-item menu is the right
            shape for exactly one rare, irreversible action — `danger` is reserved for those. */}
        <div style={{ justifySelf: 'end' }}>
          <ActionMenuButton
            open={rowMenuAccountId === account.id}
            disabled={interactionDisabled}
            title={`Actions for ${account.display_name || account.name}`}
            onOpen={element => onOpenRowMenu?.(account, element)}
          />
        </div>
      </div>

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
  const [availableTags, setAvailableTags] = useState([])
  const [tagsEditMode, setTagsEditMode] = useState(false)
  const [tagPickerAccountId, setTagPickerAccountId] = useState(null)
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(true)
  // The row whose ⋯ menu is open, and the account whose removal is being decided.
  const [rowMenu, setRowMenu] = useState(null)
  // A nonce per account rather than a boolean: the row re-enters its name editor whenever this moves,
  // so picking Rename twice works where a flag already set would do nothing.
  const [renameRequest, setRenameRequest] = useState(null)
  const [pendingRemoval, setPendingRemoval] = useState(null)
  const [removalBusy, setRemovalBusy] = useState(false)
  const [noticeDialog, setNoticeDialog] = useState(null)
  const [promoteTagsDialog, setPromoteTagsDialog] = useState(null)
  const [pendingOwnerDelete, setPendingOwnerDelete] = useState(null)
  const [ownerRenameDialog, setOwnerRenameDialog] = useState(null)
  const [showCreateAccount, setShowCreateAccount] = useState(false)
  const [creatingAccount, setCreatingAccount] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  // The list's own right-click menu — Collapse all / Expand all, and nothing row-specific since a
  // row's actions moved into its ⋯ menu. The rows no longer intercept the event, so a right-click
  // anywhere in the list reaches this, including on a child row, which used to get nothing.
  const [listContextMenu, setListContextMenu] = useState(null) // { x, y }
  const { dbInstanceId, preferenceSubjectId: userId } = useAppSession()
  const { preferences, setPreference } = useUserPreferences()
  const [sectionExpandedState, setSectionExpandedState] = useState({})
  const [sectionStateLoaded, setSectionStateLoaded] = useState(false)
  const [draggingAccountId, setDraggingAccountId] = useState(null)
  const [sortKey, setSortKey] = useState('type') // 'name' | 'type' | 'owner'
  const [sortDir, setSortDir] = useState('asc')
  const [sortDirections, setSortDirections] = useState(DEFAULT_ACCOUNT_SORT_DIRECTIONS)
  const [sortLoaded, setSortLoaded] = useState(false)
  const [sortIndicatorActive, setSortIndicatorActive] = useState(true)
  // dropIntent: null | { kind: 'merge', targetId: string } | { kind: 'detach', accountId: string }
  const [dropIntent, setDropIntent] = useState(null)
  const [dragTooltip, setDragTooltip] = useState(null) // { x, y, message }
  const [movingAccountId, setMovingAccountId] = useState(null)
  const [collapsedGroups, setCollapsedGroups] = useState(new Set()) // Set of parent account IDs
  const [collapsedGroupsLoaded, setCollapsedGroupsLoaded] = useState(false)
  // null = no owner filter (show all); empty string = unassigned-only; otherwise the selected owner_id.
  const [ownerFilter, setOwnerFilter] = useState(null)
  const dragTooltipTimerRef = useRef(null)
  const listRef = useRef(null)
  const accountsPanelRef = useRef(null)
  const initialSortSeedRef = useRef('')
  const [accountsPanelWidth, setAccountsPanelWidth] = useState(ACCOUNTS_SECTION_BASE_WIDTH)
  const sectionPanelWidth = accountsPanelWidth

  // Active in-page tab, session-scoped (sticks while the app is open, resets to Accounts next launch). A
  // `?tab=` query param (e.g. from a Tasks deep-link that targets a specific tab) takes precedence on arrival.
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const [tab, setTabState] = useState(() => {
    const fromUrl = searchParams.get('tab')
    if (ACCOUNT_TABS.some(([id]) => id === fromUrl)) return fromUrl
    const stored = sessionStore.get(ACCOUNTS_TAB_STORAGE_KEY)
    return ACCOUNT_TABS.some(([id]) => id === stored) ? stored : 'accounts'
  })
  function setTab(next) {
    setTabState(next)
    sessionStore.set(ACCOUNTS_TAB_STORAGE_KEY, next)
  }
  // Honor a `?tab=` deep-link, then strip it so it doesn't linger in the URL or override later manual tab
  // switches. Runs on arrival and also if a new `?tab=` link is followed while the page is already mounted.
  useEffect(() => {
    const fromUrl = searchParams.get('tab')
    if (!fromUrl) return
    if (ACCOUNT_TABS.some(([id]) => id === fromUrl)) {
      setTabState(fromUrl)
      sessionStore.set(ACCOUNTS_TAB_STORAGE_KEY, fromUrl)
    }
    const next = new URLSearchParams(searchParams)
    next.delete('tab')
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  // Resizable account-list columns. Geometry/order persist through the shared preference model; the
  // header (PillTableHeader), each AccountRow, and the draft-create row all render against the one
  // template string so they stay aligned. During a drag we hold the live widths in component state for
  // an immediate preview (the list is short, so per-frame re-render is fine) and commit once on mouse-up.
  const [accountColumns, onAccountColumnsChange] = useColumnPreference(ACCOUNTS_COLUMNS_PREF_KEY, ACCOUNT_COLUMN_DEFAULTS)
  const [liveAccountColumns, setLiveAccountColumns] = useState(null)
  const columnResizeRef = useRef(null)
  const liveAccountColumnsRef = useRef(null)
  const effectiveAccountColumns = liveAccountColumns || accountColumns
  const accountGridTemplate = useMemo(
    () => buildAccountGridTemplate(effectiveAccountColumns),
    [effectiveAccountColumns],
  )

  const accountDividerDraggable = key => dividerIsDraggable(accountColumns, accountColumns.findIndex(c => c.key === key))

  function startAccountColumnResize(event, key) {
    if (!accountDividerDraggable(key)) return
    preventPressDefaults(event)
    event.stopPropagation()
    columnResizeRef.current = { key, startX: event.clientX, startColumns: accountColumns.map(c => ({ ...c })) }
  }

  useEffect(() => {
    function onMove(event) {
      const state = columnResizeRef.current
      if (!state) return
      const next = moveDivider(state.startColumns, state.key, event.clientX - state.startX)
      liveAccountColumnsRef.current = next
      setLiveAccountColumns(next)
    }
    function onUp() {
      if (!columnResizeRef.current) return
      columnResizeRef.current = null
      const committed = liveAccountColumnsRef.current
      liveAccountColumnsRef.current = null
      setLiveAccountColumns(null)
      if (committed) onAccountColumnsChange(committed)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [onAccountColumnsChange])

  function showAsyncNotice(title, error) {
    setNoticeDialog({
      title,
      description: error?.message || 'Something went wrong.',
    })
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
    Promise.all([api.getAccounts({ include_children: true }), api.getOwners(), api.getCategories(), api.getTags()])
      .then(([a, o, c, t]) => {
        setAccounts(prev => reconcileAccountOrder(prev, a))
        setOwners(o)
        setCategories(c)
        setAvailableTags(Array.isArray(t) ? t : [])
      })
      .finally(() => setLoading(false))
  }

  async function reloadAccounts() {
    const rows = await api.getAccounts({ include_children: true })
    setAccounts(prev => reconcileAccountOrder(prev, rows))
    return rows
  }

  async function handleSetAccountTags(accountId, nextTagIds) {
    setAccounts(prev => prev.map(account => (
      account.id === accountId ? { ...account, tag_ids: nextTagIds } : account
    )))
    try {
      await api.setAccountTags(accountId, nextTagIds)
    } catch (error) {
      setNoticeDialog({ title: 'Could not update account tags', description: error?.message || 'Please try again.' })
      reloadAccounts().catch(() => { })
    }
  }

  async function confirmPromoteTags() {
    const dialog = promoteTagsDialog
    setPromoteTagsDialog(null)
    if (!dialog) return
    await handleSetAccountTags(dialog.targetId, dialog.nextTagIds)
    notifyAccountsChanged()
  }

  function handleAccountTagCreated(created) {
    if (!created?.id) return
    setAvailableTags(prev => (prev.some(tag => tag.id === created.id) ? prev : [...prev, created]))
  }

  const accountTagProps = {
    allTags: availableTags,
    tagsEditMode,
    tagPickerAccountId,
    onOpenTagPicker: setTagPickerAccountId,
    onCloseTagPicker: () => setTagPickerAccountId(null),
    onSetAccountTags: handleSetAccountTags,
    onAccountTagCreated: handleAccountTagCreated,
  }

  useEffect(() => { loadData() }, [])

  const { openAccountDetail, panelsNode: accountDetailPanelsNode } = useAccountDetailPanels({
    accounts, categories, getInitialPosition: getAccountDetailInitialPosition,
  })

  useEffect(() => {
    const prefValue = preferences?.[ACCOUNTS_SECTIONS_PREF_KEY]
    const nextSectionState = isObjectLike(prefValue) ? prefValue : {}

    if (!isObjectLike(prefValue)) {
      const stored = localStore.getJson(getAccountsSectionsStorageKey(dbInstanceId, userId))
      if (isObjectLike(stored)) Object.assign(nextSectionState, stored)
    }

    if (nextSectionState.accountOwners === undefined) {
      const legacyPrefValue = preferences?.[LEGACY_ACCOUNT_OWNERS_PREF_KEY]
      if (typeof legacyPrefValue === 'boolean') {
        nextSectionState.accountOwners = legacyPrefValue
      } else {
        const raw = localStore.get(getLegacyAccountOwnersStorageKey(dbInstanceId, userId))
        if (raw !== null) nextSectionState.accountOwners = raw === 'true'
      }
    }

    setSectionExpandedState(nextSectionState)
    setSectionStateLoaded(true)

    // Load collapsed group state (which parent accounts have their children hidden).
    const collapsedPrefValue = preferences?.[ACCOUNTS_COLLAPSED_PREF_KEY]
    let savedCollapsed = Array.isArray(collapsedPrefValue) ? collapsedPrefValue : null
    if (!savedCollapsed) {
      const stored = localStore.getJson(getAccountsCollapsedStorageKey(dbInstanceId, userId))
      if (Array.isArray(stored)) savedCollapsed = stored
    }
    setCollapsedGroups(new Set(savedCollapsed || []))
    setCollapsedGroupsLoaded(true)

    // Load sort preference — active key plus each column's last-used direction.
    const sortPrefValue = preferences?.[ACCOUNTS_SORT_PREF_KEY]
    let savedSort = isObjectLike(sortPrefValue) ? sortPrefValue : null
    if (!savedSort) {
      const stored = localStore.getJson(getAccountsSortStorageKey(dbInstanceId, userId))
      if (isObjectLike(stored)) savedSort = stored
    }
    if (savedSort?.key) {
      const nextSortKey = ACCOUNT_SORT_KEYS.includes(savedSort.key) ? savedSort.key : 'type'
      const nextSortDirections = normalizeAccountSortDirections(savedSort.directions, savedSort.dir || 'asc')
      setSortKey(nextSortKey)
      setSortDir(nextSortDirections[nextSortKey] || 'asc')
      setSortDirections(nextSortDirections)
    } else {
      setSortDirections(DEFAULT_ACCOUNT_SORT_DIRECTIONS)
    }
    setSortIndicatorActive(true)
    setSortLoaded(true)
    // Seed working state from saved preferences ONCE per identity — not on every `preferences`
    // change. The save effects below persist via setPreference, which updates the in-memory
    // preferences; re-running this loader on that echo rebuilt the collapsed-groups Set and the
    // sort object with fresh identities, which re-fired the saves — an infinite update loop. A
    // [dbInstanceId, userId] dependency still re-seeds on identity switches (the preferences
    // provider is keyed by identity, so this page remounts then).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbInstanceId, userId])

  // Accounts-page section collapse state is profile-scoped UI state, so one person's workspace shape restores cleanly without affecting others.
  useEffect(() => {
    if (!sectionStateLoaded) return
    localStore.setJson(getAccountsSectionsStorageKey(dbInstanceId, userId), sectionExpandedState)
    setPreference(ACCOUNTS_SECTIONS_PREF_KEY, sectionExpandedState)
  }, [dbInstanceId, userId, sectionExpandedState, sectionStateLoaded, setPreference])

  // Collapsed group state is profile-scoped UI state, persisted as an array of collapsed parent IDs.
  useEffect(() => {
    if (!collapsedGroupsLoaded) return
    const collapsed = [...collapsedGroups]
    localStore.setJson(getAccountsCollapsedStorageKey(dbInstanceId, userId), collapsed)
    setPreference(ACCOUNTS_COLLAPSED_PREF_KEY, collapsed)
  }, [dbInstanceId, userId, collapsedGroups, collapsedGroupsLoaded, setPreference])

  // Sort preference is profile-scoped UI state, persisted as the active column plus
  // each header's remembered direction so switching columns reuses the last direction
  // that header sorted with.
  useEffect(() => {
    if (!sortLoaded) return
    const value = { key: sortKey, dir: sortDir, directions: sortDirections }
    localStore.setJson(getAccountsSortStorageKey(dbInstanceId, userId), value)
    setPreference(ACCOUNTS_SORT_PREF_KEY, value)
  }, [dbInstanceId, userId, sortDirections, sortKey, sortDir, sortLoaded, setPreference])

  const applyAccountSort = useCallback((nextSortKey = sortKey, nextSortDir = sortDir) => {
    setAccounts(prev => orderAccountsForDisplay(prev, nextSortKey, nextSortDir))
    setSortIndicatorActive(true)
  }, [sortKey, sortDir])

  function toggleAccountSort(nextSortKey) {
    const rememberedDir = sortDirections[nextSortKey] || 'asc'
    const nextSortDir = sortIndicatorActive && sortKey === nextSortKey
      ? (sortDir === 'asc' ? 'desc' : 'asc')
      : rememberedDir
    const nextSortDirections = { ...sortDirections, [nextSortKey]: nextSortDir }
    setSortKey(nextSortKey)
    setSortDir(nextSortDir)
    setSortDirections(nextSortDirections)
    applyAccountSort(nextSortKey, nextSortDir)
  }

  useEffect(() => {
    if (loading || !sortLoaded) return
    const seed = `${dbInstanceId || 'local'}:${userId || 'default'}`
    if (initialSortSeedRef.current === seed) return
    applyAccountSort(sortKey, sortDir)
    initialSortSeedRef.current = seed
  }, [applyAccountSort, dbInstanceId, loading, sortDir, sortKey, sortLoaded, userId])

  useEffect(() => {
    if (!accountsPanelRef.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => {
      const entry = entries[0]
      if (!entry) return
      const nextWidth = Math.round(entry.contentRect.width)
      // A zero is the panel leaving, not the panel measuring. The observed element lives on the Accounts
      // tab only, so switching to Owners unmounts it and the observer reports 0 on the way
      // out — and this width is handed to the card on *that* tab, which would take it literally and
      // render `width: 0px`, collapsing to their borders. Nothing that disappears has a width worth
      // mirroring, so the last real measurement stands until a real one replaces it.
      if (!nextWidth) return
      if (!getSectionExpanded(sectionExpandedState, 'accountList') && accountsPanelWidth && nextWidth < accountsPanelWidth) return
      // Mirror the table width into the lower cards so the page still reads as one
      // anchored column even when account rows reflow or the create row appears.
      setAccountsPanelWidth(nextWidth)
    })
    observer.observe(accountsPanelRef.current)
    return () => observer.disconnect()
  }, [accounts.length, accountsPanelWidth, loading, sectionExpandedState, showCreateAccount])

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
    } finally {
      setCreatingAccount(false)
    }
  }

  async function saveAccount(accountId, patch) {
    await api.updateAccount(accountId, patch)
    setAccounts(prev => prev.map(account => {
      if (account.id !== accountId) return account
      const nextOwnerId = patch.owner_id !== undefined ? (patch.owner_id || null) : account.owner_id
      const nextOwnerName = patch.owner_id !== undefined
        ? (owners.find(owner => owner.id === nextOwnerId)?.name || '')
        : account.owner_name
      return {
        ...account,
        ...patch,
        owner_id: nextOwnerId,
        owner_name: nextOwnerName,
      }
    }))
    if (patch.name !== undefined || patch.type !== undefined || patch.owner_id !== undefined) {
      setSortIndicatorActive(false)
    }
    notifyAccountsChanged()
  }

  function openRowMenu(account, anchorElement) {
    setRowMenu({ account, anchorElement })
  }

  async function submitRemoval({ mode, targetAccountId, newAccount }) {
    const account = pendingRemoval
    if (!account?.id) return
    setRemovalBusy(true)
    try {
      if (mode === 'trash') {
        await api.trashAccount(account.id)
      } else if (mode === 'reassign') {
        // Creating the stand-in account first, then naming it as the target: the same two steps the
        // import mapping takes for "Create new account…", and the reason the endpoint needs no
        // create-and-reassign mode of its own.
        const target = targetAccountId
          || (await api.createAccount({ name: newAccount.name.trim(), type: newAccount.type }))?.id
        if (!target) throw new Error('Account response did not include an id.')
        await api.deleteAccount(account.id, { transactions: 'reassign', target_account_id: target })
      } else {
        await api.deleteAccount(account.id, { transactions: 'delete' })
      }
      setPendingRemoval(null)
      await reloadAccounts()
      notifyAccountsChanged()
    } catch (error) {
      // The dialog stays open on a refusal so the choice that was refused is still on screen.
      setNoticeDialog({
        title: 'Could not remove account',
        description: error.message,
      })
    } finally {
      setRemovalBusy(false)
    }
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
      setSortIndicatorActive(false)
    }
  }

  async function deleteOwner(owner) {
    if (!owner?.id) return
    await api.deleteOwner(owner.id)
    loadData()
  }

  async function createOwner(name) {
    const owner = await api.createOwner({ name })
    if (!owner?.id) throw new Error('Owner response did not include an id.')
    setOwners(prev => [...prev, owner])
    return owner
  }

  async function createOwnerForAccount(accountId, name) {
    const owner = await createOwner(name)
    if (!owner?.id) throw new Error('Owner response did not include an id.')
    await api.updateAccount(accountId, { owner_id: owner.id })
    setAccounts(prev => prev.map(account => (
      account.id === accountId
        ? { ...account, owner_id: owner.id, owner_name: owner.name }
        : account
    )))
    setSortIndicatorActive(false)
    notifyAccountsChanged()
  }

  function clearDragState() {
    setDraggingAccountId(null)
    setDropIntent(null)
    clearTimeout(dragTooltipTimerRef.current)
    setDragTooltip(null)
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
    // Regrouping always flattens the dragged account's visible group under the new
    // parent, so compatibility is checked against the dragged root account itself.
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
      notifyAccountsChanged()
      // Merging sets the child's own account tags aside — the parent's tags govern its transactions now
      // (see data-model.md). Offer to *promote* only the child's tags the parent lacks, so they keep
      // applying; overlapping tags are already governed by the parent, and identical/no extra tags merge
      // silently. Promotion is one-way (a later detach won't strip the promoted tags).
      const childTagIds = Array.isArray(source.tag_ids) ? source.tag_ids : []
      const parentTagIds = Array.isArray(target.tag_ids) ? target.tag_ids : []
      const missingTagIds = childTagIds.filter(id => !parentTagIds.includes(id))
      if (missingTagIds.length > 0) {
        setPromoteTagsDialog({
          sourceName: source.display_name || source.name,
          targetName: target.display_name || target.name,
          targetId: target.id,
          nextTagIds: [...parentTagIds, ...missingTagIds],
          tagNames: missingTagIds
            .map(id => availableTags.find(t => t.id === id)?.name)
            .filter(Boolean),
        })
      }
    } catch (error) {
      setNoticeDialog({
        title: 'Could not regroup accounts',
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
      notifyAccountsChanged()
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

  // The grip picks the account up; what follows the pointer is a copy of its whole row, so it reads as
  // the account record rather than as the grip.
  function handleAccountDragStart(event, account) {
    startPointerDrag(event, {
      onStart: () => {
        if (movingAccountId || showCreateAccount) return null
        setDraggingAccountId(account.id)
        return account
      },
      onEnd: clearDragState,
      preview: source => {
        const rowEl = source.closest('[data-account-row]')
        if (!rowEl) return {}
        const clone = rowEl.cloneNode(true)
        Object.assign(clone.style, {
          width: `${rowEl.offsetWidth}px`,
          opacity: '0.92',
          borderRadius: '8px',
          boxShadow: '0 8px 24px rgba(0,0,0,0.22)',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
        })
        return { element: clone, offsetX: rowEl.offsetWidth / 2, offsetY: rowEl.offsetHeight / 2 }
      },
    })
  }

  const listDropRef = useDropZone({
    accepts: () => !showCreateAccount && !movingAccountId,
    onOver: (dragged, point) => handleListDragOver(dragged, point),
    onLeave: () => {
      setDropIntent(null)
      dragInvalidSinceRef.current = null
      clearTimeout(dragTooltipTimerRef.current)
      setDragTooltip(null)
    },
    onDrop: (dragged, point) => handleListDrop(dragged, point),
  })
  const attachList = useCallback(element => {
    listRef.current = element
    listDropRef(element)
  }, [listDropRef])

  const dragInvalidSinceRef = useRef(null)

  // Drag-over handler — child accounts can return to top level by being pulled
  // into the left gutter; otherwise drag intent falls back to regroup detection.
  function handleListDragOver(dragged, point) {
    if (!listRef.current) return

    const listRect = listRef.current.getBoundingClientRect()
    const detachZoneRight = listRect.left + ACCOUNT_DETACH_DROP_ZONE_WIDTH
    if (dragged.parent_account_id && point.clientX <= detachZoneRight) {
      setDropIntent({ kind: 'detach', accountId: dragged.id })
      dragInvalidSinceRef.current = null
      clearTimeout(dragTooltipTimerRef.current)
      setDragTooltip(null)
      return
    }
    const el = document.elementFromPoint(
      Math.max(listRect.left + 1, Math.min(point.clientX, listRect.right - 1)),
      point.clientY,
    )
    const rowEl = el?.closest('[data-account-row-id]')
    const targetId = rowEl?.dataset?.accountRowId
    const target = targetId ? activeAccounts.find(a => a.id === targetId) : null

    if (!target) {
      setDropIntent(null)
      dragInvalidSinceRef.current = null
      clearTimeout(dragTooltipTimerRef.current)
      setDragTooltip(null)
      return
    }

    // Within own group — highlight parent but no action.
    const draggingGroupRootId = dragged.parent_account_id || null
    const targetGroupRootId = target.parent_account_id || (childAccountsByParent.get(target.id)?.length > 0 && !collapsedGroups.has(target.id) ? target.id : null)
    if (draggingGroupRootId && draggingGroupRootId === targetGroupRootId) {
      setDropIntent({ kind: 'merge', targetId: draggingGroupRootId })
      dragInvalidSinceRef.current = null
      clearTimeout(dragTooltipTimerRef.current)
      setDragTooltip(null)
      return
    }

    const mergeTarget = resolveDropTarget(target)
    if (canAttachAccount(dragged, mergeTarget)) {
      setDropIntent({ kind: 'merge', targetId: mergeTarget.id })
      dragInvalidSinceRef.current = null
      clearTimeout(dragTooltipTimerRef.current)
      setDragTooltip(null)
      return
    }

    // Cannot merge accounts — show tooltip after delay.
    setDropIntent(null)
    const sourceMissingType = !dragged.type
    const sourceMissingOwner = !dragged.owner_id
    const targetMissingType = !mergeTarget.type
    const targetMissingOwner = !mergeTarget.owner_id
    const sourceMissingFields = sourceMissingType || sourceMissingOwner
    const sourceNeeds = [sourceMissingType ? 'a type' : null, sourceMissingOwner ? 'an owner' : null].filter(Boolean)
    const targetNeeds = [targetMissingType ? 'a type' : null, targetMissingOwner ? 'an owner' : null].filter(Boolean)
    const ownerMismatch = !sourceMissingFields && !(targetMissingType || targetMissingOwner) &&
      !ownersAreCompatible(dragged, mergeTarget, owners)
    const typeMismatch = !sourceMissingFields && !(targetMissingType || targetMissingOwner) &&
      (dragged.type || '') !== (mergeTarget.type || '')
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
        setDragTooltip({ x: point.clientX, y: point.clientY, message: `Can't merge with this account: ${reasons}` })
      }, 600)
    } else if (!reasons) {
      dragInvalidSinceRef.current = null
      clearTimeout(dragTooltipTimerRef.current)
      setDragTooltip(null)
    }
  }

  // Drop handler — child accounts may detach in the left gutter, otherwise drops
  // either merge into another top-level account or no-op within the same group.
  function handleListDrop(dragged, point) {
    const listRect = listRef.current?.getBoundingClientRect()
    if (!listRect) return
    const detachZoneRight = listRect.left + ACCOUNT_DETACH_DROP_ZONE_WIDTH
    if (dragged.parent_account_id && point.clientX <= detachZoneRight) {
      detachAccount(dragged)
      return
    }
    const el = document.elementFromPoint(
      Math.max(listRect.left + 1, Math.min(point.clientX, listRect.right - 1)),
      point.clientY,
    )
    const rowEl = el?.closest('[data-account-row-id]')
    const targetId = rowEl?.dataset?.accountRowId
    const target = targetId ? activeAccounts.find(a => a.id === targetId) : null
    if (!target) { clearDragState(); return }

    // Drop within own group — no-op.
    const draggingGroupRootId = dragged.parent_account_id || null
    const targetGroupRootId = target.parent_account_id || (childAccountsByParent.get(target.id)?.length > 0 && !collapsedGroups.has(target.id) ? target.id : null)
    if (draggingGroupRootId && draggingGroupRootId === targetGroupRootId) {
      clearDragState()
      return
    }

    const mergeTarget = resolveDropTarget(target)
    if (!canAttachAccount(dragged, mergeTarget)) return
    attachAccount(dragged, mergeTarget)
  }

  const activeAccounts = accounts.filter(account => !account.trashed_at)
  const rootAccounts = activeAccounts.filter(account => !account.parent_account_id)
  const orderedRootAccounts = rootAccounts
  const childAccountsByParent = activeAccounts.reduce((map, account) => {
    if (!account.parent_account_id) return map
    const list = map.get(account.parent_account_id) || []
    list.push(account)
    map.set(account.parent_account_id, list)
    return map
  }, new Map())

  const accountCountsByOwnerId = rootAccounts.reduce((counts, account) => {
    const id = account.owner_id || ''
    counts.set(id, (counts.get(id) || 0) + 1)
    return counts
  }, new Map())
  const ownerFilterPills = [
    ...owners
      .filter(owner => accountCountsByOwnerId.has(owner.id))
      .map(owner => ({
        id: owner.id,
        name: owner.name || (isSharedOwner(owner) ? 'Shared' : 'Owner'),
        count: accountCountsByOwnerId.get(owner.id),
      })),
    ...(accountCountsByOwnerId.has('')
      ? [{ id: '', name: 'Unassigned', count: accountCountsByOwnerId.get('') }]
      : []),
  ]
  // Only worth offering pills once there's more than one bucket to choose between.
  const showOwnerFilterRow = ownerFilterPills.length > 1
  const displayRootAccounts = ownerFilter !== null
    ? orderedRootAccounts.filter(account => (account.owner_id || '') === ownerFilter)
    : orderedRootAccounts
  const draggingAccount = draggingAccountId ? activeAccounts.find(account => account.id === draggingAccountId) : null
  const detachDropActive = dropIntent?.kind === 'detach' && !!draggingAccount?.parent_account_id

  const ownerCount = owners.length
  const unownedCount = rootAccounts.filter(a => !a.owner_id).length
  const mergedChildCount = activeAccounts.length - rootAccounts.length
  const accountListSummary = rootAccounts.length
    ? `${formatCountSummary(rootAccounts.length, 'account')}${mergedChildCount ? `, ${formatCountSummary(mergedChildCount, 'merged account')}` : ''}`
    : 'No accounts'
  const ownerWarning = ownerCount > 0 && unownedCount > 0 ? `${unownedCount} account${unownedCount > 1 ? 's' : ''} need${unownedCount === 1 ? 's' : ''} an owner assigned` : ''
  const renameOwnerName = ownerRenameDialog?.name || ''

  async function confirmOwnerRename() {
    if (!ownerRenameDialog?.id || !renameOwnerName.trim()) return
    const ownerId = ownerRenameDialog.id
    const nextName = renameOwnerName.trim()
    setOwnerRenameDialog(null)
    try {
      await saveOwner(ownerId, { name: nextName })
    } catch (error) {
      showAsyncNotice('Could not rename owner', error)
    }
  }

  async function confirmOwnerDelete() {
    if (!pendingOwnerDelete) return
    const owner = pendingOwnerDelete
    setPendingOwnerDelete(null)
    try {
      await deleteOwner(owner)
    } catch (error) {
      showAsyncNotice('Could not delete owner', error)
    }
  }

  return (
    <div data-browser-context-passthrough="true" style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {dragTooltip ? (
        <div style={{
          position: 'fixed',
          left: dragTooltip.x + 14,
          top: dragTooltip.y + 14,
          zIndex: 400,
          background: 'var(--surface)',
          border: '1.5px solid color-mix(in srgb, var(--text) 24%, var(--border))',
          borderRadius: 6,
          padding: '5px 10px',
          fontSize: 12,
          color: 'var(--text)',
          boxShadow: '0 4px 12px rgba(15, 23, 42, 0.35)',
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

      {promoteTagsDialog ? (
        <AppConfirmDialog
          title="Bring tags along?"
          description={`Merging "${promoteTagsDialog.sourceName}" under "${promoteTagsDialog.targetName}" sets its own tags aside — while merged, the tags on "${promoteTagsDialog.targetName}" govern these transactions. "${promoteTagsDialog.sourceName}" has tags that "${promoteTagsDialog.targetName}" doesn't: ${promoteTagsDialog.tagNames.join(', ')}. Promote them so they keep applying? Promotion stays even if you ungroup later.`}
          confirmLabel="Promote tags"
          cancelLabel="Keep separate"
          onConfirm={confirmPromoteTags}
          onCancel={() => setPromoteTagsDialog(null)}
          width="min(480px, 100%)"
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

      {/* The row's actions, in one place. Rename and Edit tags are reachable inline too — by clicking
          the name, and through the tag cell — and are here anyway because those affordances announce
          themselves only on hover, which tells a touch user and a keyboard user nothing. Both drive the
          same editors the inline routes do; what is duplicated is the way in, never the action.
          Remove is separated and `danger`, the one entry that cannot be undone, and a parent refuses
          until its group is broken up — removing a group root means promoting a member in its place,
          which is a separate decision (see `delete_account`). */}
      {rowMenu ? (
        <ActionMenu
          anchorElement={rowMenu.anchorElement}
          onClose={() => setRowMenu(null)}
          minWidth={200}
          items={[
            {
              label: 'Rename…',
              title: 'Edit this account’s name in place.',
              onClick: () => setRenameRequest(prev => ({
                accountId: rowMenu.account.id,
                nonce: (prev?.nonce || 0) + 1,
              })),
            },
            {
              label: 'Edit tags…',
              title: 'Choose the tags attached to this account.',
              onClick: () => setTagPickerAccountId(rowMenu.account.id),
            },
            {
              label: 'Remove account…',
              danger: true,
              separatorBefore: true,
              disabled: accounts.some(a => a.parent_account_id === rowMenu.account.id),
              title: accounts.some(a => a.parent_account_id === rowMenu.account.id)
                ? 'Remove or ungroup the merged child accounts first.'
                : 'Remove this account, choosing where its transactions go. This cannot be undone.',
              onClick: () => setPendingRemoval(rowMenu.account),
            },
          ]}
        />
      ) : null}

      {pendingRemoval ? (
        <AccountRemovalDialog
          account={pendingRemoval}
          accounts={accounts}
          busy={removalBusy}
          onCancel={() => setPendingRemoval(null)}
          onSubmit={submitRemoval}
        />
      ) : null}

      <div style={{ display: 'contents', visibility: (loading || !sectionStateLoaded || !sortLoaded) ? 'hidden' : 'visible' }}>
        <div style={{ padding: '24px 32px 0', flexShrink: 0 }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 12,
            width: 'fit-content',
            maxWidth: '100%',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <FeatureExplainer topic="page-accounts" placement="bottom-left" />
              <h1 style={{ fontSize: 22, fontWeight: 600 }}>Accounts</h1>
            </div>
          </div>
          <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', marginBottom: (tab === 'accounts' && showOwnerFilterRow) ? 16 : 0 }}>
            {ACCOUNT_TABS.map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                style={{
                  padding: '8px 24px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 14,
                  color: tab === id ? 'var(--text)' : 'var(--muted)',
                  borderBottom: tab === id ? '2px solid var(--accent)' : '2px solid transparent',
                  fontWeight: tab === id ? 500 : 400,
                }}
              >
                {label}
              </button>
            ))}
            {tab === 'accounts' ? (
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 6 }}>
                {/* Connections create and feed accounts, so they are reachable from here as well as
                    from the Import page that holds them. */}
                <Button variant="secondary" onClick={() => navigate('/import-export?tab=connections')}>
                  Connections
                </Button>
                <Button onClick={() => setShowCreateAccount(true)} disabled={showCreateAccount}>
                  +New account
                </Button>
              </div>
            ) : null}
          </div>
          {tab === 'accounts' && showOwnerFilterRow ? (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
              marginBottom: 18,
            }}>
              <OwnerFilterPill
                label="All"
                count={rootAccounts.length}
                active={ownerFilter === null}
                onClick={() => setOwnerFilter(null)}
              />
              {ownerFilterPills.map(pill => (
                <OwnerFilterPill
                  key={pill.id || '__unassigned__'}
                  label={pill.name}
                  count={pill.count}
                  active={ownerFilter === pill.id}
                  onClick={() => setOwnerFilter(prev => prev === pill.id ? null : pill.id)}
                />
              ))}
            </div>
          ) : null}
        </div>

        <div data-browser-context-passthrough="true" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 32px 32px' }}>
          {tab === 'accounts' && (
            <>
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
                    <Button onClick={openCreateAccount}>Add account</Button>
                    {orderedRootAccounts.some(r => (childAccountsByParent.get(r.id) || []).length > 0) && (
                      <>
                        <Button variant="secondary" style={{ display: 'block', width: '100%', marginTop: 4 }} onClick={() => {
                          setCollapsedGroups(new Set(orderedRootAccounts.filter(r => (childAccountsByParent.get(r.id) || []).length > 0).map(r => r.id)))
                          setContextOpen(false)
                        }}>Collapse all groups</Button>
                        <Button variant="secondary" style={{ display: 'block', width: '100%', marginTop: 4 }} onClick={() => {
                          setCollapsedGroups(new Set())
                          setContextOpen(false)
                        }}>Expand all groups</Button>
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* Spinner only when there is nothing to keep on screen: `loadData` re-runs after every
                  account mutation, and swapping the whole list for a spinner each time moved everything
                  below it twice per edit. A reload holds the current list until the new one arrives. */}
              {loading && accounts.length === 0 ? <Spinner /> : (
                <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                  <div ref={accountsPanelRef} style={{ position: 'relative', width: 'fit-content', maxWidth: '100%' }}>
                    <SectionCard
                      summary={accountListSummary}
                      collapsible={false}
                      headerCenter={ownerWarning ? (
                        <span style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '4px 10px',
                          borderRadius: 999,
                          background: 'color-mix(in srgb, var(--warning) 10%, var(--surface2))',
                          border: '1px solid var(--border)',
                          fontSize: 12,
                          color: 'var(--text)',
                          opacity: showCreateAccount ? 0.55 : 1,
                        }}>
                          <span>⚠️</span>
                          <span style={{ whiteSpace: 'nowrap' }}>{ownerWarning}</span>
                        </span>
                      ) : null}
                      width={sectionPanelWidth}
                      style={{ overflow: 'hidden', alignSelf: 'flex-start' }}
                    >
                      {rootAccounts.length === 0 && !showCreateAccount ? (
                        <div style={{ padding: '12px 16px 14px', fontSize: 14, color: 'var(--muted)', lineHeight: 1.4 }}>
                          No accounts yet.
                        </div>
                      ) : displayRootAccounts.length === 0 && !showCreateAccount ? (
                        <div style={{ padding: '12px 16px 14px', fontSize: 14, color: 'var(--muted)', lineHeight: 1.4 }}>
                          No accounts match this owner filter.
                        </div>
                      ) : (
                        <>
                          <div
                            onContextMenu={e => {
                              if (!orderedRootAccounts.some(r => (childAccountsByParent.get(r.id) || []).length > 0)) return
                              e.preventDefault()
                              setListContextMenu({ x: e.clientX, y: e.clientY })
                            }}
                            style={{ background: 'var(--surface2)' }}>
                            <PillTableHeader
                              columns={[
                                { key: 'drag', kind: 'spacer', cellPadding: 0 },
                                {
                                  key: 'name',
                                  label: 'Account',
                                  cellPadding: 0,
                                  contentPadding: '0 9px',
                                  leadingInset: 0,
                                  trailingInset: 0,
                                  resizable: accountDividerDraggable('name'),
                                  draggable: false,
                                  title: 'Click to sort accounts by name',
                                },
                                {
                                  key: 'type',
                                  label: 'Type',
                                  cellPadding: 0,
                                  contentPadding: '0 9px',
                                  leadingInset: 0,
                                  trailingInset: 0,
                                  resizable: accountDividerDraggable('type'),
                                  draggable: false,
                                  title: 'Click to sort accounts by type',
                                },
                                {
                                  key: 'owner',
                                  label: 'Owner',
                                  align: 'center',
                                  cellPadding: 0,
                                  contentPadding: '0 9px',
                                  leadingInset: 0,
                                  trailingInset: 0,
                                  resizable: accountDividerDraggable('owner'),
                                  draggable: false,
                                  title: 'Click to sort accounts by owner',
                                },
                                {
                                  key: 'tags',
                                  sortable: false,
                                  resizable: accountDividerDraggable('tags'),
                                  draggable: false,
                                  cellPadding: 0,
                                  contentPadding: '0 9px',
                                  render: () => (
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
                                      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', letterSpacing: 0.3, textTransform: 'uppercase' }}>Tags</span>
                                      <Button
                                        size="compact"
                                        variant="secondary"
                                        pressed={tagsEditMode}
                                        onClick={() => { setTagsEditMode(v => !v); setTagPickerAccountId(null) }}
                                        title={tagsEditMode ? 'Finish editing account tags' : 'Edit account tags (or right-click a row)'}
                                      >
                                        {tagsEditMode ? 'Done' : 'Edit tags'}
                                      </Button>
                                    </div>
                                  ),
                                },
                                { key: 'actions', kind: 'spacer', cellPadding: 0 },
                              ]}
                              gridTemplateColumns={accountGridTemplate}
                              sortState={sortIndicatorActive ? { key: sortKey, dir: sortDir } : null}
                              onSort={toggleAccountSort}
                              onStartResize={startAccountColumnResize}
                              style={{
                                gap: ACCOUNT_ROW_GAP,
                                padding: '6px 10px',
                                alignItems: 'center',
                              }}
                            />
                          </div>
                          <div
                            ref={attachList}
                            onContextMenu={e => {
                              if (!orderedRootAccounts.some(r => (childAccountsByParent.get(r.id) || []).length > 0)) return
                              e.preventDefault()
                              setListContextMenu({ x: e.clientX, y: e.clientY })
                            }}
                            style={{ maxHeight: 640, overflowY: 'auto', position: 'relative' }}
                          >
                            {draggingAccount?.parent_account_id ? (
                              <div
                                aria-hidden="true"
                                style={{
                                  position: 'absolute',
                                  top: 8,
                                  bottom: 8,
                                  left: 8,
                                  width: ACCOUNT_DETACH_DROP_ZONE_WIDTH - 16,
                                  borderRadius: 12,
                                  border: `1px dashed ${detachDropActive ? 'color-mix(in srgb, var(--accent) 58%, var(--border))' : 'color-mix(in srgb, var(--border) 88%, transparent)'}`,
                                  background: detachDropActive
                                    ? 'linear-gradient(180deg, color-mix(in srgb, var(--accent) 14%, var(--surface2)), color-mix(in srgb, var(--accent) 8%, var(--surface)))'
                                    : 'color-mix(in srgb, var(--surface2) 42%, transparent)',
                                  boxShadow: detachDropActive ? 'inset 0 0 0 1px color-mix(in srgb, var(--accent) 10%, transparent)' : 'none',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  textAlign: 'center',
                                  padding: '10px 8px',
                                  color: detachDropActive ? 'var(--accent2)' : 'var(--muted)',
                                  fontSize: 11,
                                  fontWeight: detachDropActive ? 700 : 600,
                                  lineHeight: 1.35,
                                  pointerEvents: 'none',
                                  zIndex: 1,
                                }}
                              >
                                {detachDropActive ? 'Release to ungroup' : 'Pull here to top level'}
                              </div>
                            ) : null}
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
                                {orderedRootAccounts.some(r => (childAccountsByParent.get(r.id) || []).length > 0) ? (
                                  <>
                                    <button type="button" onClick={() => {
                                      setCollapsedGroups(new Set(orderedRootAccounts.filter(r => (childAccountsByParent.get(r.id) || []).length > 0).map(r => r.id)))
                                      setListContextMenu(null)
                                    }} style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', color: 'var(--text)', fontSize: 13, padding: '8px 10px', borderRadius: 6, cursor: 'pointer' }}>
                                      Collapse all
                                    </button>
                                    <button type="button" onClick={() => {
                                      setCollapsedGroups(new Set())
                                      setListContextMenu(null)
                                    }} style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', color: 'var(--text)', fontSize: 13, padding: '8px 10px', borderRadius: 6, cursor: 'pointer' }}>
                                      Expand all
                                    </button>
                                  </>
                                ) : null}
                              </div>
                            )}
                            {displayRootAccounts.map(root => {
                              const children = childAccountsByParent.get(root.id) || []
                              const isCollapsed = collapsedGroups.has(root.id)
                              const rootDragDisabled = !!movingAccountId
                              const groupMergeActive = dropIntent?.kind === 'merge' && dropIntent.targetId === root.id
                              return (
                                <div key={root.id}>
                                  <AccountRow
                                    account={root}
                                    gridTemplateColumns={accountGridTemplate}
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
                                    onOpenRowMenu={openRowMenu}
                                    rowMenuAccountId={rowMenu?.account?.id || null}
                                    renameRequest={renameRequest?.accountId === root.id ? renameRequest.nonce : 0}
                                    onOpenDetail={openAccountDetail}
                                    onCreateOwnerForAccount={createOwnerForAccount}
                                    onRequestRenameOwner={owner => {
                                      if (!owner?.id) return
                                      setOwnerRenameDialog({
                                        id: owner.id,
                                        name: owner.name || '',
                                      })
                                    }}
                                    onRequestDeleteOwner={owner => setPendingOwnerDelete(owner)}
                                    onError={showAsyncNotice}
                                    interactionDisabled={showCreateAccount || !!movingAccountId}
                                    dragDisabled={rootDragDisabled}
                                    dropActive={groupMergeActive}
                                    onDragStart={handleAccountDragStart}
                                    {...accountTagProps}
                                  />
                                  {!isCollapsed && children.map((child, childIdx) => (
                                    <AccountRow
                                      key={child.id}
                                      account={child}
                                      gridTemplateColumns={accountGridTemplate}
                                      parentAccount={root}
                                      isLastChild={childIdx === children.length - 1}
                                      owners={owners}
                                      onSave={saveAccount}
                                      onOpenRowMenu={openRowMenu}
                                      rowMenuAccountId={rowMenu?.account?.id || null}
                                      renameRequest={renameRequest?.accountId === child.id ? renameRequest.nonce : 0}
                                      onOpenDetail={openAccountDetail}
                                      onCreateOwnerForAccount={createOwnerForAccount}
                                      onRequestRenameOwner={owner => {
                                        if (!owner?.id) return
                                        setOwnerRenameDialog({
                                          id: owner.id,
                                          name: owner.name || '',
                                        })
                                      }}
                                      onRequestDeleteOwner={owner => setPendingOwnerDelete(owner)}
                                        onError={showAsyncNotice}
                                      interactionDisabled={showCreateAccount || !!movingAccountId}
                                      dragDisabled={!!movingAccountId}
                                      dropActive={groupMergeActive}
                                      onDragStart={handleAccountDragStart}
                                      {...accountTagProps}
                                    />
                                  ))}
                                </div>
                              )
                            })}
                            {showCreateAccount && (
                              <DraftAccountRow
                                owners={owners}
                                gridTemplateColumns={accountGridTemplate}
                                creating={creatingAccount}
                                onCreate={createAccount}
                                onCancel={() => setShowCreateAccount(false)}
                              />
                            )}
                          </div>
                        </>
                      )}
                    </SectionCard>
                  </div>
                </div>
              )}
            </>
          )}

          {tab === 'owners' && (
            <OwnersPanel
              owners={owners}
              onCreateOwner={createOwner}
              onSaveOwner={saveOwner}
              onDeleteOwner={owner => setPendingOwnerDelete(owner)}
              onError={showAsyncNotice}
              disabled={showCreateAccount}
              width={sectionPanelWidth}
              collapsible={false}
            />
          )}

          {accountDetailPanelsNode}
        </div>
      </div>
    </div>
  )
}
