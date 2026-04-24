// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api.js'
import { PageHeader, Spinner, EmptyState, CategoryMarker, OverlayBackdrop, FloatingPanel, FloatingPanelHeader, DialogActions, Button } from '../components/ui.jsx'
import CategoryDetail from '../components/CategoryDetail.jsx'
import CategoryPicker from '../components/CategoryPicker.jsx'
import {
  BulkMoveToast,
  CategoryTreeRow,
  GroupEndDropZone,
  SectionEndDropZone,
  normalizeCategoryType,
} from '../components/CategoryTreePrimitives.jsx'
import { useAppSession } from '../lib/AppSessionContext.jsx'
import { useFilters } from '../lib/FilterContext.jsx'
import TransactionListTable from '../components/TransactionListTable.jsx'
import { usePagedTransactions } from '../components/detailShared.jsx'
import { ESCAPE_BEHAVIOR, useDismissibleLayer, useEscapeAction } from '../lib/uiInteractions.js'
import { useUserPreferences } from '../lib/UserPreferencesContext.jsx'

const SECTION_META = {
  income: { label: 'Income' },
  expense: { label: 'Expense' },
}

const SECTION_STORAGE_KEY_PREFIX = 'fintrack.categories.collapsedSections'
const GROUP_STORAGE_KEY_PREFIX = 'fintrack.categories.collapsedGroups'
const MATCHING_TXN_COLUMNS_STORAGE_KEY_PREFIX = 'fintrack.categories.matching-txn-columns'
const SECTION_PREF_KEY = 'ui.categories.collapsedSections'
const GROUP_PREF_KEY = 'ui.categories.collapsedGroups'
const MATCHING_TXN_COLUMNS_PREF_KEY = 'ui.categories.matchingTransactions.columns'
const UNASSIGNED_CATEGORY_SYSTEM_KEY = 'unassigned'
const SYNTHETIC_UNCATEGORIZED_EXPENSE_CATEGORY_ID = '__uncategorized_expense__'
const SYNTHETIC_UNCATEGORIZED_EXPENSE_CATEGORY_NAME = 'Uncategorized'
const SYNTHETIC_UNCATEGORIZED_INCOME_GROUP_ID = '__uncategorized_income_group__'
const SYNTHETIC_UNCATEGORIZED_INCOME_CATEGORY_ID = '__uncategorized_income__'
const SYNTHETIC_UNCATEGORIZED_INCOME_CATEGORY_NAME = 'Other Income'
const CATEGORY_SECTION_TYPES = ['income', 'expense']
const EMPTY_USAGE_SUMMARY = {
  txn_count: 0,
  rule_count: 0,
  profile_mapping_count: 0,
  batch_mapping_count: 0,
  is_in_use: false,
}
const MATCHING_TXN_COLUMN_DEFAULTS = [
  { key: 'date', width: 96 },
  { key: 'merchant', width: 260 },
  { key: 'category', width: 150 },
  { key: 'account', width: 140 },
  { key: 'amount', width: 108 },
]

function getSectionStorageKey(instanceId, userId) {
  return instanceId && userId ? `${SECTION_STORAGE_KEY_PREFIX}.${instanceId}.${userId}` : null
}

function getMatchingTxnColumnsStorageKey(instanceId, userId) {
  return instanceId && userId ? `${MATCHING_TXN_COLUMNS_STORAGE_KEY_PREFIX}.${instanceId}.${userId}` : null
}

function defaultMatchingTxnColumnConfig() {
  return MATCHING_TXN_COLUMN_DEFAULTS.map(column => ({ ...column }))
}

function normalizeMatchingTxnColumnConfig(value) {
  if (!Array.isArray(value)) return null
  const byKey = new Map(value.map(column => [column?.key, column]))
  const hasAllColumns = MATCHING_TXN_COLUMN_DEFAULTS.every(column => byKey.has(column.key))
  if (!hasAllColumns || byKey.size !== MATCHING_TXN_COLUMN_DEFAULTS.length) return null
  return MATCHING_TXN_COLUMN_DEFAULTS.map(column => ({
    key: column.key,
    width: Number(byKey.get(column.key)?.width) || column.width,
  }))
}

/*
 * Ownership is intentionally tri-state: groups can resolve from "no explicit owner" to shared or sole-owner,
 * while child categories only inherit when owner_id is null. Explicit child ownership must survive later group-owner changes.
 */
function isSharedOwner(owner) {
  return !!owner?.is_shared || (owner?.name || '').trim().toLowerCase() === 'shared'
}

function getPersonalOwners(owners) {
  return owners.filter(owner => !isSharedOwner(owner))
}

function getSharedOwner(owners) {
  return owners.find(isSharedOwner) || null
}

function getEffectiveGroupOwnerId(group, owners) {
  if (!group) return ''
  if (group.owner_id) return group.owner_id
  const personalOwners = getPersonalOwners(owners)
  if (personalOwners.length === 1) return personalOwners[0].id
  if (personalOwners.length > 1) return getSharedOwner(owners)?.id || ''
  return ''
}

function getEffectiveCategoryOwnerId(category, flatCats, owners) {
  if (!category) return ''
  if (!category.parent_id) return getEffectiveGroupOwnerId(category, owners)
  if (category.owner_id) return category.owner_id
  const parentGroup = flatCats.find(cat => cat.id === category.parent_id)
  return getEffectiveGroupOwnerId(parentGroup, owners)
}

function getFullCategoryRecord(cat, flatCats) {
  if (!cat) return null
  return flatCats.find(item => item.id === cat.id) || cat
}

function isProtectedSystemCategory(cat) {
  return cat?.system_key === UNASSIGNED_CATEGORY_SYSTEM_KEY
}

function isSyntheticUncategorizedCategory(cat) {
  return cat?.synthetic_kind === 'uncategorized'
}

function isSyntheticUncategorizedIncomeGroup(cat) {
  return cat?.synthetic_kind === 'uncategorized_income_group'
}

function isSystemCategory(cat) {
  return isProtectedSystemCategory(cat) || isSyntheticUncategorizedCategory(cat) || isSyntheticUncategorizedIncomeGroup(cat)
}

function buildSyntheticUncategorizedCategory(group, txnCount, options = {}) {
  if (!group || !txnCount) return null
  return {
    id: options.id || SYNTHETIC_UNCATEGORIZED_EXPENSE_CATEGORY_ID,
    parent_id: group.id,
    parent_name: group.name,
    name: options.name || SYNTHETIC_UNCATEGORIZED_EXPENSE_CATEGORY_NAME,
    category_type: options.category_type || group.category_type,
    synthetic_kind: 'uncategorized',
    txn_count: Number(txnCount || 0),
  }
}

function buildSyntheticUncategorizedIncomeGroup(txnCount) {
  if (!txnCount) return null
  const syntheticGroup = {
    id: SYNTHETIC_UNCATEGORIZED_INCOME_GROUP_ID,
    parent_id: null,
    name: 'Unassigned',
    category_type: 'income',
    system_key: UNASSIGNED_CATEGORY_SYSTEM_KEY,
    synthetic_kind: 'uncategorized_income_group',
    children: [],
  }
  const syntheticChild = buildSyntheticUncategorizedCategory(syntheticGroup, txnCount, {
    id: SYNTHETIC_UNCATEGORIZED_INCOME_CATEGORY_ID,
    name: SYNTHETIC_UNCATEGORIZED_INCOME_CATEGORY_NAME,
    category_type: 'income',
  })
  syntheticGroup.children = syntheticChild ? [syntheticChild] : []
  return syntheticGroup
}

function getDirectTxnCount(cat, categoryUsage) {
  return Number(categoryUsage?.[cat?.id]?.txn_count || 0)
}

function getGroupStorageKey(instanceId, userId) {
  return instanceId && userId ? `${GROUP_STORAGE_KEY_PREFIX}.${instanceId}.${userId}` : null
}

function DeleteCategoryDialog({ category, preview, categories, replacementId, onReplacementChange, mode, onModeChange, onConfirm, onCancel, saving }) {
  const ref = useRef(null)
  useDismissibleLayer({
    open: true,
    onClose: onCancel,
    refs: [ref],
  })

  const canConfirm = mode === 'unassigned' || !!replacementId

  return (
    <OverlayBackdrop zIndex={900} tint="rgba(15, 23, 42, 0.28)">
      <FloatingPanel
        ref={ref}
        style={{
          width: 'min(560px, 100%)',
        }}
      >
        <FloatingPanelHeader style={{ padding: '16px 20px' }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>Delete category</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
              "{category?.name}" is assigned to {preview?.txn_count} transaction{preview?.txn_count === 1 ? '' : 's'}.
            </div>
          </div>
        </FloatingPanelHeader>

        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
            Choose where those transactions should go before deleting this category.
          </div>

          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
            <input
              type="radio"
              checked={mode === 'replace'}
              onChange={() => onModeChange('replace')}
              style={{ marginTop: 2, accentColor: 'var(--accent)' }}
            />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Move transactions to another category</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
                Pick the category that should replace this one.
              </div>
            </div>
          </label>

          {mode === 'replace' ? (
            <div style={{ paddingLeft: 24 }}>
              <CategoryPicker
                value={replacementId}
                categories={categories}
                onChange={onReplacementChange}
                placeholder="Choose replacement category…"
              />
            </div>
          ) : null}

          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
            <input
              type="radio"
              checked={mode === 'unassigned'}
              onChange={() => onModeChange('unassigned')}
              style={{ marginTop: 2, accentColor: 'var(--accent)' }}
            />
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Mark transactions as unassigned</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
                Remove the category from those transactions.
              </div>
            </div>
          </label>
        </div>

        <DialogActions>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={!canConfirm || saving}>
            {saving ? 'Deleting…' : 'Delete category'}
          </Button>
        </DialogActions>
      </FloatingPanel>
    </OverlayBackdrop>
  )
}

function ContextMenu({
  x,
  y,
  target,
  bulkMoveMode,
  canMoveHere,
  onAddCategory,
  onAddGroup,
  onExpandAll,
  onCollapseAll,
  onAlphabetize,
  onAddRule,
  onStartBulkMove,
  onMoveHere,
  onCancelBulkMove,
  onDelete,
  onClose,
}) {
  const ref = useRef(null)
  const [menuHeight, setMenuHeight] = useState(0)
  useDismissibleLayer({
    open: true,
    onClose,
    refs: [ref],
  })

  useLayoutEffect(() => {
    if (!ref.current) return
    setMenuHeight(ref.current.getBoundingClientRect().height || 0)
  }, [target])

  const menuW = 220
  const viewportPadding = 8
  const left = Math.max(viewportPadding, Math.min(x, window.innerWidth - menuW - viewportPadding))
  const wouldOverflowBottom = menuHeight > 0 && y + menuHeight + viewportPadding > window.innerHeight
  const top = wouldOverflowBottom
    ? Math.max(viewportPadding, y - menuHeight)
    : Math.max(viewportPadding, Math.min(y, window.innerHeight - menuHeight - viewportPadding))
  const itemStyle = {
    padding: '4px 11px',
    fontSize: 12,
    cursor: 'pointer',
    borderRadius: 5,
    display: 'block',
    width: '100%',
    textAlign: 'left',
    background: 'none',
    border: 'none',
    color: 'var(--text)',
  }
  const divider = <div style={{ height: 1, background: 'var(--border)', margin: '2px 0' }} />

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        left,
        top,
        zIndex: 500,
        visibility: menuHeight ? 'visible' : 'hidden',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: 3,
        boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
        minWidth: menuW,
      }}
    >
      {bulkMoveMode ? (
        canMoveHere ? (
          <>
            <button
              style={itemStyle}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
              onMouseDown={e => {
                e.preventDefault()
                onMoveHere(target)
              }}
            >
              Move here
            </button>
            <button
              style={itemStyle}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
              onMouseDown={e => {
                e.preventDefault()
                onCancelBulkMove()
              }}
            >
              Cancel bulk move
            </button>
          </>
        ) : (
          <>
            <div style={{ ...itemStyle, color: 'var(--muted)', cursor: 'default', opacity: 0.7 }}>
              Select categories, then choose a destination group
            </div>
            {divider}
            <button
              style={itemStyle}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
              onMouseDown={e => {
                e.preventDefault()
                onCancelBulkMove()
              }}
            >
              Cancel bulk move
            </button>
          </>
        )
      ) : (
        <>
          {target.groupId ? (
            <button
              style={itemStyle}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
              onMouseDown={e => {
                e.preventDefault()
                onAddCategory(target)
              }}
            >
              + Add category to "{target.groupName}"
            </button>
          ) : (
            <div style={{ ...itemStyle, color: 'var(--muted)', cursor: 'default', opacity: 0.55 }}>
              + Add category (right-click a group)
            </div>
          )}
          <button
            style={itemStyle}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
            onMouseDown={e => {
              e.preventDefault()
              onAddGroup(target)
            }}
          >
            + New {SECTION_META[target.sectionType].label.toLowerCase()} group
          </button>

          {divider}
          <button
            style={itemStyle}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
            onMouseDown={e => {
              e.preventDefault()
              onExpandAll(target)
            }}
          >
            Expand
          </button>
          <button
            style={itemStyle}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
            onMouseDown={e => {
              e.preventDefault()
              onCollapseAll(target)
            }}
          >
            Collapse
          </button>
          <button
            style={itemStyle}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
            onMouseDown={e => {
              e.preventDefault()
              onAlphabetize(target)
            }}
          >
            Alphabetize
          </button>
          {target.categoryId ? (
            <button
              style={itemStyle}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
              onMouseDown={e => {
                e.preventDefault()
                onAddRule(target)
              }}
            >
              Add categorization rule
            </button>
          ) : null}
          {target.removableId ? (
            <button
              style={{ ...itemStyle, color: target.removeInUse ? 'var(--danger)' : 'var(--text)' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
              onMouseDown={e => {
                e.preventDefault()
                onDelete(target)
              }}
            >
              Remove
            </button>
          ) : null}

          {divider}
          <button
            style={itemStyle}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
            onMouseDown={e => {
              e.preventDefault()
              onStartBulkMove(target)
            }}
          >
            Bulk move
          </button>
        </>
      )}
    </div>
  )
}

function InlineAddForm({ label, value, onNameChange, onSubmit, onCancel, indent = 'category' }) {
  if (indent === 'category') {
    return (
      <InlineCategoryDraftRow
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    )
  }

  return (
    <InlineGroupDraftRow
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  )
}

function InlineGroupDraftRow({ onSubmit, onCancel }) {
  const draftGroup = {
    id: '__new-group__',
    name: '',
    parent_id: null,
    category_type: 'expense',
    children: [],
  }
  return (
    <CategoryTreeRow
      cat={draftGroup}
      isChild={false}
      isSelected={true}
      draggable={false}
      renameDisabled={false}
      showDelete={false}
      canCollapse={false}
      isCollapsed={false}
      autoEditToken={1}
      autoEditPlaceholder="Group name"
      onAutoEditConsumed={() => {}}
      onCancelEdit={onCancel}
      onToggleCollapse={() => {}}
      onSelect={() => {}}
      onRename={(_, name) => onSubmit(name)}
      onDelete={() => {}}
      trailingContent={
        <button
          onMouseDown={e => {
            e.preventDefault()
            e.stopPropagation()
          }}
          onClick={e => {
            e.preventDefault()
            e.stopPropagation()
            onCancel()
          }}
          title="Cancel"
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--muted)',
            cursor: 'pointer',
            fontSize: 12,
            padding: '1px 2px',
            borderRadius: 4,
            flexShrink: 0,
            lineHeight: 1,
          }}
        >
          x
        </button>
      }
    />
  )
}

function InlineCategoryDraftRow({ onSubmit, onCancel }) {
  const draftCategory = {
    id: '__new-category__',
    name: '',
    parent_id: '__draft-parent__',
    category_type: 'expense',
  }
  return (
    <CategoryTreeRow
      cat={draftCategory}
      isChild={true}
      isSelected={true}
      draggable={false}
      renameDisabled={false}
      showDelete={false}
      autoEditToken={1}
      autoEditPlaceholder="category name"
      onAutoEditConsumed={() => {}}
      onCancelEdit={onCancel}
      onSelect={() => {}}
      onRename={(_, name) => onSubmit(name)}
      onDelete={() => {}}
      trailingContent={
        <button
          onMouseDown={e => {
            e.preventDefault()
            e.stopPropagation()
          }}
          onClick={e => {
            e.preventDefault()
            e.stopPropagation()
            onCancel()
          }}
          title="Cancel"
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--muted)',
            cursor: 'pointer',
            fontSize: 12,
            padding: '1px 2px',
            borderRadius: 4,
            flexShrink: 0,
            lineHeight: 1,
          }}
        >
          x
        </button>
      }
    />
  )
}

function ScrollFade({ top, bottom }) {
  return (
    <>
      {top ? (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 20,
            background: 'linear-gradient(to bottom, color-mix(in srgb, var(--surface) 96%, transparent), transparent)',
            pointerEvents: 'none',
            zIndex: 5,
          }}
        />
      ) : null}
      {bottom ? (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: 24,
            background: 'linear-gradient(to top, color-mix(in srgb, var(--surface) 96%, transparent), transparent)',
            pointerEvents: 'none',
            zIndex: 5,
          }}
        />
      ) : null}
    </>
  )
}

/*
 * The tree has two overlapping modes: single-focus selection drives the detail pane, while bulk move temporarily
 * turns categories into an additive selection set. Keeping both selection shapes avoids rebuilding the page around one mode.
 */
export default function Categories() {
  const navigate = useNavigate()
  const { dbInstanceId, preferenceSubjectId: userId } = useAppSession()
  const { preferences } = useUserPreferences()
  const { filters } = useFilters()
  const [tree, setTree] = useState([])
  const [flatCats, setFlatCats] = useState([])
  const [owners, setOwners] = useState([])
  const [categoryUsage, setCategoryUsage] = useState({})
  const [uncategorizedExpenseTxnCount, setUncategorizedExpenseTxnCount] = useState(0)
  const [uncategorizedIncomeTxnCount, setUncategorizedIncomeTxnCount] = useState(0)
  const [matchingTxnsTotal, setMatchingTxnsTotal] = useState(0)
  const [selected, setSelected] = useState(null)
  const [selectedCategoryIds, setSelectedCategoryIds] = useState([])
  const [detailPanels, setDetailPanels] = useState([])
  const [loading, setLoading] = useState(true)
  const [newName, setNewName] = useState('')
  const [contextMenu, setContextMenu] = useState(null)
  const [inlineForm, setInlineForm] = useState(null)
  const [collapsedSections, setCollapsedSections] = useState({})
  const [collapsedGroups, setCollapsedGroups] = useState({})
  const [matchingTxnColumns, setMatchingTxnColumns] = useState(defaultMatchingTxnColumnConfig)
  const [collapseStateLoaded, setCollapseStateLoaded] = useState(false)
  const [matchingTxnColumnsLoaded, setMatchingTxnColumnsLoaded] = useState(false)
  const [listScrollState, setListScrollState] = useState({ top: false, bottom: false })
  const [deleteDialog, setDeleteDialog] = useState(null)
  const [deleteMode, setDeleteMode] = useState('replace')
  const [deleteReplacementId, setDeleteReplacementId] = useState('')
  const [deleteSaving, setDeleteSaving] = useState(false)
  const [bulkMoveToast, setBulkMoveToast] = useState(null)
  const [bulkMoveMode, setBulkMoveMode] = useState(false)

  const listRef = useRef(null)
  const dragScrollRef = useRef(null)
  const selectedRef = useRef(null)

  const sectionStateReady = CATEGORY_SECTION_TYPES.every(sectionType => Object.prototype.hasOwnProperty.call(collapsedSections, sectionType))
  const groupStateReady = tree.length > 0 && tree.every(group => Object.prototype.hasOwnProperty.call(collapsedGroups, group.id))

  useEffect(() => {
    selectedRef.current = selected
  }, [selected])


  // Tree-collapse state is scoped per db/profile so one user's workspace shape does not leak into another's, with localStorage as fallback only.
  useEffect(() => {
      const sectionPrefs = preferences?.[SECTION_PREF_KEY]
      const groupPrefs = preferences?.[GROUP_PREF_KEY]
      const matchingTxnColumnPrefs = normalizeMatchingTxnColumnConfig(preferences?.[MATCHING_TXN_COLUMNS_PREF_KEY])
      if (sectionPrefs && typeof sectionPrefs === 'object') setCollapsedSections(sectionPrefs)
      if (groupPrefs && typeof groupPrefs === 'object') setCollapsedGroups(groupPrefs)
      if (matchingTxnColumnPrefs) setMatchingTxnColumns(matchingTxnColumnPrefs)
      const sectionStorageKey = getSectionStorageKey(dbInstanceId, userId)
      const groupStorageKey = getGroupStorageKey(dbInstanceId, userId)
      const matchingTxnColumnsStorageKey = getMatchingTxnColumnsStorageKey(dbInstanceId, userId)
      if (!sectionPrefs && sectionStorageKey) {
        const savedSections = JSON.parse(window.localStorage.getItem(sectionStorageKey) || 'null')
        if (savedSections && typeof savedSections === 'object') setCollapsedSections(savedSections)
      }
      if (!groupPrefs && groupStorageKey) {
        const savedGroups = JSON.parse(window.localStorage.getItem(groupStorageKey) || 'null')
        if (savedGroups && typeof savedGroups === 'object') setCollapsedGroups(savedGroups)
      }
      if (!matchingTxnColumnPrefs && matchingTxnColumnsStorageKey) {
        const savedColumns = normalizeMatchingTxnColumnConfig(
          JSON.parse(window.localStorage.getItem(matchingTxnColumnsStorageKey) || 'null')
        )
        if (savedColumns) setMatchingTxnColumns(savedColumns)
      }
      setCollapseStateLoaded(true)
      setMatchingTxnColumnsLoaded(true)
  }, [dbInstanceId, preferences, userId])

  const loadCategories = useCallback(async (selectedId = selectedRef.current?.id) => {
    const [nextTree, nextFlat, nextUsage, uncategorizedExpenseResult, uncategorizedIncomeResult] = await Promise.all([
      api.getCategoryTree(),
      api.getCategories(),
      api.getCategoryUsageSummary(),
      api.getTransactions({
        category_id: SYNTHETIC_UNCATEGORIZED_EXPENSE_CATEGORY_ID,
        limit: 1,
        offset: 0,
      }),
      api.getTransactions({
        category_id: SYNTHETIC_UNCATEGORIZED_INCOME_CATEGORY_ID,
        limit: 1,
        offset: 0,
      }),
    ])
    const nextUncategorizedExpenseTxnCount = Number(uncategorizedExpenseResult?.total || 0)
    const nextUncategorizedIncomeTxnCount = Number(uncategorizedIncomeResult?.total || 0)
    setTree(nextTree)
    setFlatCats(nextFlat)
    setCategoryUsage(nextUsage || {})
    setUncategorizedExpenseTxnCount(nextUncategorizedExpenseTxnCount)
    setUncategorizedIncomeTxnCount(nextUncategorizedIncomeTxnCount)
    setLoading(false)
    if (selectedId === SYNTHETIC_UNCATEGORIZED_EXPENSE_CATEGORY_ID) {
      const unassignedGroup = nextTree.find(group => isProtectedSystemCategory(group))
      setSelected(buildSyntheticUncategorizedCategory(unassignedGroup, nextUncategorizedExpenseTxnCount))
    } else if (selectedId === SYNTHETIC_UNCATEGORIZED_INCOME_CATEGORY_ID) {
      const syntheticIncomeGroup = buildSyntheticUncategorizedIncomeGroup(nextUncategorizedIncomeTxnCount)
      setSelected(syntheticIncomeGroup?.children?.[0] || null)
    } else if (selectedId === SYNTHETIC_UNCATEGORIZED_INCOME_GROUP_ID) {
      setSelected(buildSyntheticUncategorizedIncomeGroup(nextUncategorizedIncomeTxnCount))
    } else if (selectedId) {
      setSelected(nextFlat.find(cat => cat.id === selectedId) || null)
    }
    setSelectedCategoryIds(prev => prev.filter(id => nextFlat.some(cat => cat.id === id && cat.parent_id)))
  }, [])

  useEffect(() => { loadCategories() }, [loadCategories])
  useEffect(() => { api.getOwners().then(setOwners) }, [])
  useEscapeAction(event => {
     // Escape unwinds the most specific transient UI first so keyboard users can
     // back out one layer at a time instead of losing the whole tree context at once.
    if (deleteDialog) {
      if (deleteSaving) return
      event.preventDefault()
      closeDeleteDialog()
      return
    }
    if (contextMenu) {
      event.preventDefault()
      setContextMenu(null)
      return
    }
    if (inlineForm) {
      event.preventDefault()
      setInlineForm(null)
      setNewName('')
      return
    }
    if (bulkMoveMode) {
      event.preventDefault()
      cancelBulkMove()
      return
    }
    if (selected || selectedCategoryIds.length > 0) {
      event.preventDefault()
      setSelected(null)
      setSelectedCategoryIds([])
    }
  }, {
    enabled: !!deleteDialog || !!contextMenu || !!inlineForm || bulkMoveMode || !!selected || selectedCategoryIds.length > 0,
    ignoreEditableTarget: false,
    escapeBehavior: ESCAPE_BEHAVIOR.CLEAR_SELECTION,
  })
  useEffect(() => {
    if (!collapseStateLoaded) return
    if (!tree.length || !sectionStateReady) return
    const storageKey = getSectionStorageKey(dbInstanceId, userId)
    if (!storageKey) return
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(collapsedSections))
    } catch {
      // Ignore storage failures in environments that block localStorage.
    }
    api.saveUserPreference(SECTION_PREF_KEY, collapsedSections).catch(() => {})
  }, [dbInstanceId, userId, collapsedSections, collapseStateLoaded, tree.length, sectionStateReady])
  useEffect(() => {
    if (!collapseStateLoaded) return
    if (!groupStateReady) return
    const storageKey = getGroupStorageKey(dbInstanceId, userId)
    if (!storageKey) return
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(collapsedGroups))
    } catch {
      // Ignore storage failures in environments that block localStorage.
    }
    api.saveUserPreference(GROUP_PREF_KEY, collapsedGroups).catch(() => {})
  }, [dbInstanceId, userId, collapsedGroups, collapseStateLoaded, groupStateReady])
  useEffect(() => {
    if (!matchingTxnColumnsLoaded) return
    const storageKey = getMatchingTxnColumnsStorageKey(dbInstanceId, userId)
    if (!storageKey) return
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(matchingTxnColumns))
    } catch {
      // Ignore storage failures in environments that block localStorage.
    }
    api.saveUserPreference(MATCHING_TXN_COLUMNS_PREF_KEY, matchingTxnColumns).catch(() => {})
  }, [dbInstanceId, userId, matchingTxnColumns, matchingTxnColumnsLoaded])

  function getSyntheticUncategorizedChild(group) {
    if (!isProtectedSystemCategory(group)) return null
    return buildSyntheticUncategorizedCategory(group, uncategorizedExpenseTxnCount)
  }

  function getSyntheticIncomeGroup() {
    return buildSyntheticUncategorizedIncomeGroup(uncategorizedIncomeTxnCount)
  }

  function getVisibleChildrenForGroup(group) {
    if (!group) return []
    if (isSyntheticUncategorizedIncomeGroup(group)) return group.children || []
    if (!isProtectedSystemCategory(group)) return group.children || []
    const visibleChildren = (group.children || []).filter(child => getDirectTxnCount(child, categoryUsage) > 0)
    const syntheticChild = getSyntheticUncategorizedChild(group)
    return syntheticChild ? [syntheticChild, ...visibleChildren] : visibleChildren
  }

  function getBulkMovableChildrenForGroup(group) {
    return getVisibleChildrenForGroup(group).filter(child => !isSyntheticUncategorizedCategory(child))
  }

  function shouldShowGroup(group) {
    if (!group) return false
    if (isSyntheticUncategorizedIncomeGroup(group)) return getVisibleChildrenForGroup(group).length > 0
    if (!isProtectedSystemCategory(group)) return true
    return getVisibleChildrenForGroup(group).length > 0
  }

  function getVisibleSubcategoryCount(group) {
    return getVisibleChildrenForGroup(group).length
  }

  function getSectionGroups(sectionType) {
    const sectionGroups = tree.filter(group => (
      normalizeCategoryType(group.category_type) === sectionType &&
      shouldShowGroup(group)
    ))
    const regularGroups = sectionGroups.filter(group => !isProtectedSystemCategory(group))
    const protectedGroups = sectionGroups.filter(isProtectedSystemCategory)
    const groups = [...regularGroups, ...protectedGroups]
    if (sectionType === 'income') {
      const syntheticIncomeGroup = getSyntheticIncomeGroup()
      if (syntheticIncomeGroup) groups.push(syntheticIncomeGroup)
    }
    return groups
  }

  const groupsBySection = {
    income: getSectionGroups('income'),
    expense: getSectionGroups('expense'),
  }

  function getUsageSummaryForNode(cat) {
    if (!cat) {
      return EMPTY_USAGE_SUMMARY
    }
    if (isSyntheticUncategorizedCategory(cat)) {
      return {
        ...EMPTY_USAGE_SUMMARY,
        txn_count: cat.id === SYNTHETIC_UNCATEGORIZED_INCOME_CATEGORY_ID
          ? uncategorizedIncomeTxnCount
          : uncategorizedExpenseTxnCount,
        is_in_use: cat.id === SYNTHETIC_UNCATEGORIZED_INCOME_CATEGORY_ID
          ? uncategorizedIncomeTxnCount > 0
          : uncategorizedExpenseTxnCount > 0,
      }
    }
    if (isSyntheticUncategorizedIncomeGroup(cat)) {
      return {
        ...EMPTY_USAGE_SUMMARY,
        txn_count: uncategorizedIncomeTxnCount,
        is_in_use: uncategorizedIncomeTxnCount > 0,
      }
    }
    const direct = categoryUsage?.[cat.id] || EMPTY_USAGE_SUMMARY
    if (cat.parent_id) return direct
    const aggregate = {
      txn_count: direct.txn_count || 0,
      rule_count: direct.rule_count || 0,
      profile_mapping_count: direct.profile_mapping_count || 0,
      batch_mapping_count: direct.batch_mapping_count || 0,
      is_in_use: !!direct.is_in_use,
    }
    for (const child of cat.children || []) {
      const childUsage = categoryUsage?.[child.id] || {}
      aggregate.txn_count += childUsage.txn_count || 0
      aggregate.rule_count += childUsage.rule_count || 0
      aggregate.profile_mapping_count += childUsage.profile_mapping_count || 0
      aggregate.batch_mapping_count += childUsage.batch_mapping_count || 0
    }
    if (isProtectedSystemCategory(cat)) {
      aggregate.txn_count += uncategorizedExpenseTxnCount
    }
    aggregate.is_in_use = !!(
      aggregate.txn_count ||
      aggregate.rule_count ||
      aggregate.profile_mapping_count ||
      aggregate.batch_mapping_count
    )
    return aggregate
  }

  const visibleChildIds = ['income', 'expense'].flatMap(sectionType => {
    if (collapsedSections[sectionType]) return []
    return groupsBySection[sectionType].flatMap(group => (
      collapsedGroups[group.id] ? [] : getBulkMovableChildrenForGroup(group).map(child => child.id)
    ))
  })

  useEffect(() => {
    if (!tree.length || !collapseStateLoaded) return
    setCollapsedSections(prev => {
      const next = {}
      let changed = false
      CATEGORY_SECTION_TYPES.forEach(sectionType => {
        if (Object.prototype.hasOwnProperty.call(prev, sectionType)) {
          next[sectionType] = !!prev[sectionType]
        } else {
          next[sectionType] = false
          changed = true
        }
      })
      if (!changed && CATEGORY_SECTION_TYPES.every(sectionType => prev[sectionType] === next[sectionType])) return prev
      return next
    })
    setCollapsedGroups(prev => {
      const next = {}
      let changed = false
      tree.forEach(group => {
        if (Object.prototype.hasOwnProperty.call(prev, group.id)) {
          next[group.id] = !!prev[group.id]
        } else {
          next[group.id] = true
          changed = true
        }
      })
      if (!changed && tree.length === Object.keys(prev).length && tree.every(group => prev[group.id] === next[group.id])) return prev
      return next
    })
  }, [tree, collapseStateLoaded])
  useEffect(() => {
    updateScrollState(listRef, setListScrollState)
  }, [tree, selected, loading, inlineForm, collapsedSections, collapsedGroups])

  function childrenForGroup(groupId) {
    return flatCats.filter(cat => cat.parent_id === groupId)
  }

  function handleListDragOver(e) {
    const el = listRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const zone = 48
    const speed = 8
    cancelAnimationFrame(dragScrollRef.current)
    if (e.clientY < rect.top + zone) {
      const scroll = () => {
        el.scrollTop -= speed
        dragScrollRef.current = requestAnimationFrame(scroll)
      }
      dragScrollRef.current = requestAnimationFrame(scroll)
    } else if (e.clientY > rect.bottom - zone) {
      const scroll = () => {
        el.scrollTop += speed
        dragScrollRef.current = requestAnimationFrame(scroll)
      }
      dragScrollRef.current = requestAnimationFrame(scroll)
    }
  }

  function handleListDragLeave() {
    cancelAnimationFrame(dragScrollRef.current)
  }

  function updateScrollState(ref, setter) {
    const el = ref.current
    if (!el) return
    const maxScrollTop = el.scrollHeight - el.clientHeight
    setter({
      top: el.scrollTop > 4,
      bottom: maxScrollTop - el.scrollTop > 4,
    })
  }

  async function persistGroupOrder(sectionType, ids) {
    await Promise.all(
      ids.map((id, index) => api.updateCategory(id, {
        parent_id: null,
        category_type: sectionType,
        sort_order: index,
      }))
    )
  }

  async function persistChildOrder(parentId, ids, movedId) {
    await Promise.all(
      ids.map((id, index) => api.updateCategory(id, {
        sort_order: index,
        ...(id === movedId ? { parent_id: parentId } : {}),
      }))
    )
  }

  async function persistChildrenState(parentId, ids) {
    await Promise.all(
      ids.map((id, index) => api.updateCategory(id, {
        parent_id: parentId,
        sort_order: index,
      }))
    )
  }

  // Reordering is backend-first: every drag updates persisted sort_order immediately so reloads and other surfaces see the same tree order.
  async function moveGroup(dragged, sectionType, targetIndex = null) {
    const fromSection = normalizeCategoryType(dragged.categoryType)
    const targetIds = groupsBySection[sectionType].map(group => group.id).filter(id => id !== dragged.id)
    const insertAt = targetIndex == null ? targetIds.length : targetIndex
    targetIds.splice(insertAt, 0, dragged.id)
    await persistGroupOrder(sectionType, targetIds)
    if (fromSection !== sectionType) {
      const sourceIds = groupsBySection[fromSection].map(group => group.id).filter(id => id !== dragged.id)
      await persistGroupOrder(fromSection, sourceIds)
    }
    await loadCategories(dragged.id)
  }

  async function moveChild(dragged, parentId, targetIndex = null) {
    const sourceParentId = dragged.parentId
    const targetIds = childrenForGroup(parentId).map(cat => cat.id).filter(id => id !== dragged.id)
    const insertAt = targetIndex == null ? targetIds.length : targetIndex
    targetIds.splice(insertAt, 0, dragged.id)
    await persistChildOrder(parentId, targetIds, dragged.id)
    if (sourceParentId && sourceParentId !== parentId) {
      const sourceIds = childrenForGroup(sourceParentId).map(cat => cat.id).filter(id => id !== dragged.id)
      await persistChildOrder(sourceParentId, sourceIds, null)
    }
    await loadCategories(dragged.id)
  }

  // Snapshot every affected parent before the move so undo can restore full sibling order, not just send categories back.
  async function moveChildrenBatch(childIds, targetParentId) {
    const orderedChildIds = visibleChildIds.filter(id => childIds.includes(id))
    if (!orderedChildIds.length) return

    const parentSnapshots = {}
    const sourceParentIds = [...new Set(
      orderedChildIds
        .map(id => flatCats.find(cat => cat.id === id)?.parent_id)
        .filter(Boolean)
    )]
    const affectedParentIds = [...new Set([...sourceParentIds, targetParentId])]

    affectedParentIds.forEach(parentId => {
      parentSnapshots[parentId] = childrenForGroup(parentId).map(cat => cat.id)
    })

    const targetIds = childrenForGroup(targetParentId)
      .map(cat => cat.id)
      .filter(id => !orderedChildIds.includes(id))
      .concat(orderedChildIds)

    for (const parentId of sourceParentIds) {
      if (parentId === targetParentId) continue
      const remainingIds = childrenForGroup(parentId)
        .map(cat => cat.id)
        .filter(id => !orderedChildIds.includes(id))
      await persistChildrenState(parentId, remainingIds)
    }

    await persistChildrenState(targetParentId, targetIds)

    const targetGroup = flatCats.find(cat => cat.id === targetParentId)
    setBulkMoveToast({
      count: orderedChildIds.length,
      targetGroupName: targetGroup?.name || 'group',
      snapshots: parentSnapshots,
      selectedIds: orderedChildIds,
    })

    await loadCategories(orderedChildIds[0])
    setSelectedCategoryIds(orderedChildIds)
    setBulkMoveMode(false)
  }

  async function handleDropRow(dragged, targetCat, dropPosition = 'after') {
    cancelAnimationFrame(dragScrollRef.current)
    if (dragged.childIds?.length > 1) {
      const targetParentId = targetCat.parent_id || targetCat.id
      if (!targetParentId) return
      await moveChildrenBatch(dragged.childIds, targetParentId)
      return
    }
    if (dragged.id === targetCat.id) return
    if (dragged.isGroup) {
      const targetGroup = targetCat.parent_id
        ? flatCats.find(cat => cat.id === targetCat.parent_id)
        : targetCat
      if (!targetGroup) return
      const sectionType = normalizeCategoryType(targetGroup.category_type)
      const baseIndex = groupsBySection[sectionType].findIndex(group => group.id === targetGroup.id)
      const targetIndex = dropPosition === 'before' ? baseIndex : baseIndex + 1
      await moveGroup(dragged, sectionType, targetIndex)
      return
    }
    if (targetCat.parent_id) {
      const siblings = childrenForGroup(targetCat.parent_id)
      const baseIndex = siblings.findIndex(cat => cat.id === targetCat.id)
      const targetIndex = dropPosition === 'before' ? baseIndex : baseIndex + 1
      await moveChild(dragged, targetCat.parent_id, targetIndex)
      return
    }
    await moveChild(dragged, targetCat.id, 0)
  }

  async function handleGroupDropEnd(dragged, group) {
    cancelAnimationFrame(dragScrollRef.current)
    if (dragged.childIds?.length > 1) {
      await moveChildrenBatch(dragged.childIds, group.id)
      return
    }
    if (dragged.isGroup) return
    await moveChild(dragged, group.id)
  }

  async function handleSectionDropEnd(dragged, sectionType) {
    cancelAnimationFrame(dragScrollRef.current)
    if (!dragged.isGroup) return
    await moveGroup(dragged, sectionType)
  }

  async function handleRename(id, name) {
    await api.updateCategory(id, { name })
    await loadCategories(id)
  }

  async function handleOwnerChange(categoryId, ownerId) {
    const target = flatCats.find(cat => cat.id === categoryId)
    if (!target) return
    const effectiveGroupOwnerId = target.parent_id
      ? getEffectiveGroupOwnerId(flatCats.find(cat => cat.id === target.parent_id), owners)
      : getEffectiveGroupOwnerId(target, owners)

    let patch
    if (target.parent_id) {
      patch = ownerId === '__inherit__' || !ownerId
        ? { clear_owner: true }
        : { owner_id: ownerId }
    } else {
      patch = !ownerId || ownerId === effectiveGroupOwnerId
        ? { clear_owner: true }
        : { owner_id: ownerId }
    }

    await api.updateCategory(categoryId, patch)
    await loadCategories(categoryId)
  }

  async function handleExcludeChange(groupId, exclude) {
    await api.updateCategory(groupId, { exclude_from_totals: exclude ? 1 : 0 })
    await loadCategories(groupId)
  }

  async function handleDelete(id) {
    const category = flatCats.find(cat => cat.id === id)
    const preview = await api.getCategoryDeletePreview(id)
    if (!preview.txn_count) {
      await api.deleteCategory(id)
      if (preview.affected_category_ids.includes(selected?.id)) setSelected(null)
      setSelectedCategoryIds(prev => prev.filter(catId => !preview.affected_category_ids.includes(catId)))
      await loadCategories()
      return
    }
    setDeleteDialog({ category, preview })
    setDeleteMode('replace')
    setDeleteReplacementId('')
  }

  async function confirmDeleteDialog() {
    if (!deleteDialog) return
    if (deleteMode === 'replace' && !deleteReplacementId) return
    setDeleteSaving(true)
    try {
      await api.deleteCategory(deleteDialog.category.id, {
        replacement_category_id: deleteMode === 'replace' ? deleteReplacementId : null,
      })
      if (deleteDialog.preview.affected_category_ids.includes(selected?.id)) setSelected(null)
      setSelectedCategoryIds(prev => prev.filter(catId => !deleteDialog.preview.affected_category_ids.includes(catId)))
      setDeleteDialog(null)
      setDeleteReplacementId('')
      await loadCategories()
    } finally {
      setDeleteSaving(false)
    }
  }

  function closeDeleteDialog() {
    if (deleteSaving) return
    setDeleteDialog(null)
    setDeleteReplacementId('')
    setDeleteMode('replace')
  }

  function selectCategory(cat, event) {
    const fullCat = getFullCategoryRecord(cat, flatCats)
    if (!fullCat) return
    if (bulkMoveMode) {
      setSelected(fullCat)
      return
    }
    setSelected(fullCat)
    setInlineForm(null)

    if (!fullCat.parent_id) {
      setSelectedCategoryIds([])
      return
    }

    if (isSyntheticUncategorizedCategory(fullCat)) {
      setSelectedCategoryIds([])
      return
    }

    setSelectedCategoryIds([fullCat.id])
  }

  function getDragPayload(cat) {
    if (bulkMoveMode) return null
    if (isSystemCategory(cat)) return null
    if (!cat.parent_id) {
      return {
        id: cat.id,
        parentId: cat.parent_id,
        isGroup: true,
        categoryType: normalizeCategoryType(cat.category_type),
      }
    }
    const multiSelected = selectedCategoryIds.includes(cat.id) && selectedCategoryIds.length > 1
    if (multiSelected) {
      return {
        id: cat.id,
        childIds: selectedCategoryIds.slice(),
        parentId: cat.parent_id,
        isGroup: false,
        categoryType: normalizeCategoryType(cat.category_type),
      }
    }
    return {
      id: cat.id,
      parentId: cat.parent_id,
      isGroup: false,
      categoryType: normalizeCategoryType(cat.category_type),
    }
  }

  function toggleSection(sectionType) {
    setCollapsedSections(prev => ({ ...prev, [sectionType]: !prev[sectionType] }))
  }

  function toggleGroup(groupId) {
    setCollapsedGroups(prev => ({ ...prev, [groupId]: !prev[groupId] }))
  }

  function expandAll(target) {
    if (target.groupId) {
      setCollapsedGroups(prev => ({ ...prev, [target.groupId]: false }))
    } else {
      const nextGroups = { ...collapsedGroups }
      ;(groupsBySection[target.sectionType] || []).forEach(group => { nextGroups[group.id] = false })
      setCollapsedGroups(nextGroups)
      setCollapsedSections(prev => ({ ...prev, [target.sectionType]: false }))
    }
    setContextMenu(null)
  }

  function collapseAll(target) {
    if (target.groupId) {
      setCollapsedGroups(prev => ({ ...prev, [target.groupId]: true }))
    } else {
      const nextGroups = { ...collapsedGroups }
      ;(groupsBySection[target.sectionType] || []).forEach(group => { nextGroups[group.id] = true })
      setCollapsedGroups(nextGroups)
      setCollapsedSections(prev => ({ ...prev, [target.sectionType]: true }))
    }
    setContextMenu(null)
  }

  async function alphabetize(target) {
    if (target.groupId) {
      const siblings = childrenForGroup(target.groupId)
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      await persistChildOrder(target.groupId, siblings.map(cat => cat.id), null)
      await loadCategories(target.groupId)
    } else {
      const groups = groupsBySection[target.sectionType]
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      await persistGroupOrder(target.sectionType, groups.map(group => group.id))
      await loadCategories()
    }
    setContextMenu(null)
  }

  function openGroupForm(sectionType) {
    setContextMenu(null)
    setBulkMoveMode(false)
    setSelected(null)
    setSelectedCategoryIds([])
    setNewName('')
    setInlineForm({ mode: 'group', sectionType, anchorGroupId: null, insertPosition: 'after' })
  }

  function openGroupFormNear(sectionType, anchorGroupId = null, insertPosition = 'after') {
    setContextMenu(null)
    setBulkMoveMode(false)
    setSelected(null)
    setSelectedCategoryIds([])
    setNewName('')
    setInlineForm({ mode: 'group', sectionType, anchorGroupId, insertPosition })
  }

  function openCategoryForm(group) {
    setContextMenu(null)
    setBulkMoveMode(false)
    setSelected(null)
    setSelectedCategoryIds([])
    setNewName('')
    setInlineForm({
      mode: 'category',
      sectionType: normalizeCategoryType(group.category_type),
      parentId: group.id,
      groupName: group.name,
    })
  }

  async function submitInlineForm(overrideName = null) {
    if (!inlineForm) return
    const activeInlineForm = inlineForm
    const trimmedName = String(overrideName ?? newName).trim()
    if (!trimmedName) return
    let nextSelectedId = null
    if (activeInlineForm.mode === 'group') {
      const created = await api.createCategory({
        name: trimmedName,
        category_type: activeInlineForm.sectionType,
        sort_order: groupsBySection[activeInlineForm.sectionType].length,
      })
      nextSelectedId = created.id
      const nextIds = groupsBySection[activeInlineForm.sectionType].map(group => group.id)
      const anchorIndex = activeInlineForm.anchorGroupId
        ? nextIds.findIndex(id => id === activeInlineForm.anchorGroupId)
        : -1
      const insertAt = anchorIndex === -1
        ? nextIds.length
        : activeInlineForm.insertPosition === 'before'
          ? anchorIndex
          : anchorIndex + 1
      nextIds.splice(insertAt, 0, created.id)
      await persistGroupOrder(activeInlineForm.sectionType, nextIds)
    } else {
      const created = await api.createCategory({
        name: trimmedName,
        parent_id: activeInlineForm.parentId,
        sort_order: childrenForGroup(activeInlineForm.parentId).length,
      })
      nextSelectedId = created.id
    }
    await loadCategories(nextSelectedId)
    setNewName('')
    setInlineForm(null)
    if (activeInlineForm.mode === 'category' && nextSelectedId) {
      setSelectedCategoryIds([nextSelectedId])
    } else {
      setSelectedCategoryIds([])
    }
  }

  async function undoBulkMove() {
    if (!bulkMoveToast) return
    const entries = Object.entries(bulkMoveToast.snapshots)
    for (const [parentId, ids] of entries) {
      await persistChildrenState(parentId, ids)
    }
    const restoreId = bulkMoveToast.selectedIds?.[0] || null
    setBulkMoveToast(null)
    await loadCategories(restoreId)
    setSelectedCategoryIds(bulkMoveToast.selectedIds || [])
  }

  function openContextMenu(e, cat, sectionTypeOverride = null) {
    const fullCat = getFullCategoryRecord(cat, flatCats)
    const group = fullCat?.parent_id ? flatCats.find(item => item.id === fullCat.parent_id) : fullCat
    const sectionType = sectionTypeOverride || normalizeCategoryType(group?.category_type)
    const rect = e.currentTarget?.getBoundingClientRect?.()
    const insertPosition = rect && e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    const usageSummary = fullCat ? getUsageSummaryForNode(fullCat) : null
    if (fullCat) {
      setSelected(fullCat)
      setSelectedCategoryIds(fullCat.parent_id && !isSyntheticUncategorizedCategory(fullCat) ? [fullCat.id] : [])
    }
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      sectionType,
      groupId: group?.id || null,
      groupName: group?.name || '',
      categoryId: fullCat?.parent_id && !isSyntheticUncategorizedCategory(fullCat) ? fullCat.id : null,
      categoryName: fullCat?.parent_id && !isSyntheticUncategorizedCategory(fullCat) ? fullCat.name : '',
      removableId: fullCat && !isSystemCategory(fullCat) ? fullCat.id : null,
      removeInUse: !!usageSummary?.is_in_use,
      scope: group?.id ? 'group' : 'section',
      insertPosition,
    })
  }

  function openRuleCreator(target) {
    setContextMenu(null)
    navigate('/rules', {
      state: {
        openRuleCreator: {
          initialValues: {
            catId: target.categoryId,
          },
        },
      },
    })
  }

  function startBulkMove(target) {
    setContextMenu(null)
    setInlineForm(null)
    setBulkMoveMode(true)
    if (!selected?.parent_id && target.groupId) {
      const group = flatCats.find(cat => cat.id === target.groupId)
      if (group) setSelected(group)
    }
    setSelectedCategoryIds([])
  }

  function cancelBulkMove() {
    setContextMenu(null)
    setBulkMoveMode(false)
    setSelectedCategoryIds([])
  }

  function toggleBulkChecked(cat) {
    if (!bulkMoveMode) return
    if (isSyntheticUncategorizedCategory(cat)) {
      setSelected(cat)
      setSelectedCategoryIds([])
      return
    }
    if (cat.parent_id) {
      setSelected(cat)
      setSelectedCategoryIds(prev => (
        prev.includes(cat.id)
          ? prev.filter(id => id !== cat.id)
          : [...prev, cat.id]
      ))
      return
    }

    const childIds = getBulkMovableChildrenForGroup(cat).map(child => child.id)
    const allChecked = childIds.length > 0 && childIds.every(id => selectedCategoryIds.includes(id))
    setSelected(cat)
    setSelectedCategoryIds(prev => {
      const base = prev.filter(id => !childIds.includes(id))
      return allChecked ? base : [...base, ...childIds]
    })
  }

  async function moveSelectedCategoriesHere(target) {
    const targetParentId = target.groupId
    if (!targetParentId || selectedCategoryIds.length === 0) {
      setContextMenu(null)
      return
    }
    setContextMenu(null)
    await moveChildrenBatch(selectedCategoryIds, targetParentId)
  }

  const parentCategory = selected?.parent_id
    ? (
      flatCats.find(cat => cat.id === selected.parent_id) ||
      (selected.parent_id === SYNTHETIC_UNCATEGORIZED_INCOME_GROUP_ID ? getSyntheticIncomeGroup() : null)
    )
    : null
  const selectedIsSystemCategory = isSystemCategory(selected)
  const personalOwners = getPersonalOwners(owners)
  const sharedOwner = getSharedOwner(owners)
  const effectiveSelectedOwnerId = getEffectiveCategoryOwnerId(selected, flatCats, owners)
  const inheritedOwnerLabel = parentCategory
    ? (owners.find(owner => owner.id === getEffectiveGroupOwnerId(parentCategory, owners))?.name || 'group owner')
    : ''
  const selectedGroupType = normalizeCategoryType(selected?.category_type)
  const selectedCategories = selectedCategoryIds
    .map(id => flatCats.find(cat => cat.id === id))
    .filter(Boolean)
  const isMultiCategorySelection = selectedCategories.length > 1
  const multiSelectionGroupIds = [...new Set(selectedCategories.map(cat => cat.parent_id).filter(Boolean))]
  const multiSelectionGroups = multiSelectionGroupIds
    .map(id => flatCats.find(cat => cat.id === id))
    .filter(Boolean)
  const selectedCategoryIdSet = new Set(selectedCategoryIds)
  const deleteReplacementCategories = deleteDialog
    ? flatCats.filter(cat => !deleteDialog.preview.affected_category_ids.includes(cat.id))
    : flatCats
  const selectedCategoryFilter = isMultiCategorySelection
    ? null
    : selected
      ? (
        isSyntheticUncategorizedIncomeGroup(selected)
          ? SYNTHETIC_UNCATEGORIZED_INCOME_CATEGORY_ID
          : isSyntheticUncategorizedCategory(selected)
            ? selected.id
            : (selected.parent_id ? selected.id : `__group__${selected.id}`)
      )
      : null
  const selectedCategoryIdsFilter = isMultiCategorySelection
    ? selectedCategories.map(cat => cat.id).join(',')
    : null
  const matchingTxnsKey = selectedCategoryFilter
    ? `${selectedCategoryFilter}|${filters.date?.start || ''}|${filters.date?.end || ''}`
    : selectedCategoryIdsFilter
      ? `${selectedCategoryIdsFilter}|${filters.date?.start || ''}|${filters.date?.end || ''}`
      : null

  const loadMatchingTxnPage = useCallback((offset, limit) => (
    api.getTransactions({
      category_id: selectedCategoryFilter,
      category_ids: selectedCategoryIdsFilter || undefined,
      date_start: filters.date?.start || undefined,
      date_end: filters.date?.end || undefined,
      limit,
      offset,
    })
  ), [selectedCategoryFilter, selectedCategoryIdsFilter, filters.date?.start, filters.date?.end])

  const {
    rows: pagedMatchingTxns,
    setRows: setPagedMatchingTxns,
    loading: matchingTxnsLoading,
    loadingMore: matchingTxnsLoadingMore,
    listRef: matchingTxnsListRef,
  } = usePagedTransactions({
    activeKey: matchingTxnsKey,
    loadPage: loadMatchingTxnPage,
  })

  function addMatchingCategory(cat) {
    setFlatCats(prev => prev.find(existing => existing.id === cat.id) ? prev : [...prev, cat])
  }

  async function saveMatchingTxnCategory(txnId, catId, catObj) {
    await api.overrideCategory(txnId, catId)
    const cat = catObj || flatCats.find(c => c.id === catId)
    setPagedMatchingTxns(prev => prev.map(txn =>
      txn.id === txnId ? {
        ...txn,
        category_id: catId,
        category_name: cat?.name ?? null,
        category_color: null,
        category_overridden: 1,
      } : txn
    ))
  }

  function handleMatchingTxnColumnUpdate(nextColumns) {
    const normalized = normalizeMatchingTxnColumnConfig(nextColumns)
    if (normalized) setMatchingTxnColumns(normalized)
  }

  function openDetailPanel(type, item) {
    if (!item?.id) return
    setDetailPanels(prev => [
      ...prev.filter(panel => !(panel.type === type && panel.item?.id === item.id)),
      { type, item },
    ])
  }

  function closeDetailPanel(type, id) {
    setDetailPanels(prev => prev.filter(panel => !(panel.type === type && panel.item?.id === id)))
  }

  useEffect(() => {
    if (!matchingTxnsKey) {
      setMatchingTxnsTotal(0)
      return
    }
    let cancelled = false
    api.getTransactions({
      category_id: selectedCategoryFilter,
      category_ids: selectedCategoryIdsFilter || undefined,
      date_start: filters.date?.start || undefined,
      date_end: filters.date?.end || undefined,
      limit: 1,
      offset: 0,
    }).then(result => {
      if (cancelled) return
      setMatchingTxnsTotal(result.total || 0)
    }).catch(() => {
      if (cancelled) return
      setMatchingTxnsTotal(0)
    })
    return () => { cancelled = true }
  }, [matchingTxnsKey, selectedCategoryFilter, selectedCategoryIdsFilter, filters.date?.start, filters.date?.end])

  return (
    <div data-browser-context-passthrough="true" style={{ padding: 32, display: 'flex', flexDirection: 'column', height: '100%', boxSizing: 'border-box' }}>
      <PageHeader title="Categories" />
      <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 20, flex: 1, minHeight: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
            <div
              ref={listRef}
              onDragOver={handleListDragOver}
              onDragLeave={handleListDragLeave}
              onScroll={() => updateScrollState(listRef, setListScrollState)}
              style={{
                flex: 1,
                overflowY: 'auto',
                minHeight: 0,
                height: '100%',
                border: '1px solid var(--border)',
                borderRadius: 10,
                background: 'var(--surface)',
              }}
            >
            {!loading && bulkMoveMode ? (
              <div style={{
                position: 'sticky',
                top: 0,
                zIndex: 2,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '8px 11px',
                background: 'color-mix(in srgb, var(--accent) 10%, var(--surface))',
                borderBottom: '1px solid var(--border)',
              }}>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                  Select categories to move, then right-click a group and choose <strong>Move here</strong>.
                </div>
                <button
                  onClick={cancelBulkMove}
                  style={{
                    background: 'none',
                    border: '1px solid var(--border)',
                    color: 'var(--muted)',
                    borderRadius: 999,
                    padding: '4px 10px',
                    fontSize: 12,
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                >
                  Done
                </button>
              </div>
            ) : null}
            {loading ? <Spinner /> : ['income', 'expense'].map(sectionType => {
              const sectionGroups = groupsBySection[sectionType]
              const sectionMeta = SECTION_META[sectionType]
              const showSectionForm =
                inlineForm?.mode === 'group' &&
                inlineForm.sectionType === sectionType &&
                !inlineForm.anchorGroupId
              const sectionCollapsed = !!collapsedSections[sectionType]

              return (
                <div
                  key={sectionType}
                  onContextMenu={e => {
                    e.preventDefault()
                    openContextMenu(e, null, sectionType)
                  }}
                  style={{ borderBottom: sectionType === 'income' ? '1px solid var(--border)' : 'none' }}
                >
                  <div
                    style={{
                      padding: '5px 11px 4px',
                      background: 'color-mix(in srgb, var(--surface2) 70%, transparent)',
                      borderBottom: '1px solid var(--border)',
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 8,
                      cursor: 'pointer',
                    }}
                    onClick={() => toggleSection(sectionType)}
                  >
                    <button
                      onClick={e => {
                        e.stopPropagation()
                        toggleSection(sectionType)
                      }}
                      title={sectionCollapsed ? `Expand ${sectionMeta.label}` : `Collapse ${sectionMeta.label}`}
                      style={{
                        background: 'var(--surface)',
                        border: '1px solid var(--border)',
                        color: 'var(--muted)',
                        cursor: 'pointer',
                        fontSize: 12,
                        width: 21,
                        height: 21,
                        padding: 0,
                        marginTop: 1,
                        flexShrink: 0,
                        borderRadius: 5,
                        display: 'grid',
                        placeItems: 'center',
                        lineHeight: 1,
                      }}
                    >
                      {sectionCollapsed ? '+' : '-'}
                    </button>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 700, lineHeight: 1.1 }}>
                        {sectionMeta.label}
                      </div>
                    </div>
                  </div>

                  {!sectionCollapsed && sectionGroups.length === 0 && !showSectionForm ? (
                    <div style={{ padding: '12px', fontSize: 12, color: 'var(--muted)' }}>
                      No {sectionMeta.label.toLowerCase()} groups yet. Right-click here to add one.
                    </div>
                  ) : null}

                  {!sectionCollapsed ? sectionGroups.map(group => {
                    const groupCollapsed = !!collapsedGroups[group.id]
                    const visibleChildren = getVisibleChildrenForGroup(group)
                    const selectableChildren = getBulkMovableChildrenForGroup(group)
                    const showGroupFormBefore =
                      inlineForm?.mode === 'group' &&
                      inlineForm.sectionType === sectionType &&
                      inlineForm.anchorGroupId === group.id &&
                      inlineForm.insertPosition === 'before'
                    const showGroupFormAfter =
                      inlineForm?.mode === 'group' &&
                      inlineForm.sectionType === sectionType &&
                      inlineForm.anchorGroupId === group.id &&
                      inlineForm.insertPosition !== 'before'
                    return (
                    <div key={group.id}>
                        {showGroupFormBefore ? (
                          <InlineAddForm
                            label={`${sectionMeta.label} group name`}
                            value={newName}
                            onNameChange={setNewName}
                            onSubmit={submitInlineForm}
                            onCancel={() => setInlineForm(null)}
                            indent="group"
                          />
                        ) : null}
                      <CategoryTreeRow
                        cat={group}
                        isChild={false}
                        isSelected={selected?.id === group.id}
                        draggable={!isSystemCategory(group)}
                        renameDisabled={isSystemCategory(group)}
                        allowSelectionWhenRenameDisabled={isSystemCategory(group)}
                        showDelete={!isSystemCategory(group)}
                        acceptDrop={!isSystemCategory(group)}
                        nameStyle={isSystemCategory(group) ? { fontStyle: 'italic' } : null}
                        bulkMoveMode={bulkMoveMode}
                        bulkChecked={selectableChildren.length > 0 && selectableChildren.every(child => selectedCategoryIdSet.has(child.id))}
                        isCollapsed={groupCollapsed}
                        canCollapse={visibleChildren.length > 0}
                        onToggleCollapse={toggleGroup}
                        onSelect={selectCategory}
                        onRename={handleRename}
                        onDelete={handleDelete}
                        onToggleBulkChecked={toggleBulkChecked}
                        onDropRow={handleDropRow}
                        onOpenContextMenu={openContextMenu}
                        onDragStartRow={getDragPayload}
                      />
                      {!groupCollapsed ? visibleChildren.map(child => (
                        <CategoryTreeRow
                          key={child.id}
                          cat={child}
                          isChild={true}
                          isSelected={selected?.id === child.id || selectedCategoryIds.includes(child.id)}
                          draggable={!isSystemCategory(child)}
                          renameDisabled={isSystemCategory(child)}
                          allowSelectionWhenRenameDisabled={isSystemCategory(child)}
                          showDelete={!isSystemCategory(child)}
                          acceptDrop={!isSystemCategory(child)}
                          nameStyle={isSystemCategory(child) ? { fontStyle: 'italic' } : null}
                          bulkMoveMode={bulkMoveMode}
                          bulkChecked={selectedCategoryIdSet.has(child.id)}
                          bulkSelectable={!isSystemCategory(child)}
                          onSelect={selectCategory}
                          onRename={handleRename}
                          onDelete={handleDelete}
                          onToggleBulkChecked={toggleBulkChecked}
                          onDropRow={handleDropRow}
                          onOpenContextMenu={isSyntheticUncategorizedCategory(child) ? undefined : openContextMenu}
                          onDragStartRow={getDragPayload}
                        />
                      )) : null}

                        {!groupCollapsed && inlineForm?.mode === 'category' && inlineForm.parentId === group.id ? (
                          <InlineAddForm
                            label={`New category in ${group.name}`}
                            value={newName}
                            onNameChange={setNewName}
                            onSubmit={submitInlineForm}
                            onCancel={() => setInlineForm(null)}
                            indent="category"
                          />
                        ) : null}

                      <GroupEndDropZone group={group} onDropEnd={handleGroupDropEnd} />
                        {showGroupFormAfter ? (
                          <InlineAddForm
                            label={`${sectionMeta.label} group name`}
                            value={newName}
                            onNameChange={setNewName}
                            onSubmit={submitInlineForm}
                            onCancel={() => setInlineForm(null)}
                            indent="group"
                          />
                        ) : null}
                    </div>
                    )
                  }) : null}

                    {!sectionCollapsed && showSectionForm ? (
                      <InlineAddForm
                        label={`${sectionMeta.label} group name`}
                        value={newName}
                        onNameChange={setNewName}
                        onSubmit={submitInlineForm}
                        onCancel={() => setInlineForm(null)}
                        indent="group"
                      />
                    ) : null}

                  {!sectionCollapsed ? <SectionEndDropZone sectionMeta={SECTION_META} sectionType={sectionType} onDropEnd={handleSectionDropEnd} /> : null}
                </div>
              )
            })}
            </div>
            <ScrollFade top={listScrollState.top} bottom={listScrollState.bottom} />
          </div>

        </div>

        <div style={{ position: 'relative', minHeight: 0 }}>
          <div
            style={{
              overflow: 'hidden',
              minHeight: 0,
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              border: '1px solid var(--border)',
              borderRadius: 10,
              background: 'var(--surface)',
              padding: 20,
            }}
          >
          {!selected ? (
            <EmptyState message="Select a category or group to view details" />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
              {isMultiCategorySelection ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <CategoryMarker kind="category" size={8} />
                    <h2 style={{ fontSize: 16, fontWeight: 600 }}>{selectedCategories.length} selected categories</h2>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                    {selectedCategories.map(cat => (
                      <span
                        key={cat.id}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 5,
                          padding: '2px 8px',
                          borderRadius: 999,
                          border: '1px solid var(--border)',
                          background: 'var(--surface2)',
                          fontSize: 12,
                        }}
                      >
                        <CategoryMarker kind="category" />
                        {cat.name}
                      </span>
                    ))}
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>
                    {multiSelectionGroups.length === 1
                      ? `Subcategories of ${multiSelectionGroups[0]?.name || '-'}`
                      : `${multiSelectionGroups.length} groups represented`}
                  </div>
                </>
              ) : (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                    <CategoryMarker kind={selected.parent_id ? 'category' : 'group'} size={selected.parent_id ? 8 : 10} />
                    <h2 style={{ fontSize: 16, fontWeight: 600, fontStyle: selectedIsSystemCategory ? 'italic' : 'normal' }}>{selected.name}</h2>
                  </div>

                      {selected.parent_id ? (
                    <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>
                      Subcategory of {parentCategory?.name || '-'}
                      {parentCategory?.exclude_from_totals ? ' (excluded from totals)' : ''}
                    </div>
                  ) : (
                    <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>
                      {SECTION_META[selectedGroupType].label} group - {getVisibleSubcategoryCount(selected)} subcategories
                    </div>
                  )}
                </>
              )}

              {!isMultiCategorySelection && !selectedIsSystemCategory && (
              <>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 16,
                  flexWrap: 'wrap',
                  marginBottom: 20,
                  padding: '10px 14px',
                  background: 'var(--surface2)',
                  borderRadius: 8,
                  border: '1px solid var(--border)',
                }}
              >
                {personalOwners.length > 1 ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '1 1 160px' }}>
                    <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>Owner</span>
                    <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
                      <select
                        value={selected.parent_id ? (selected.owner_id || '__inherit__') : effectiveSelectedOwnerId}
                        onChange={e => handleOwnerChange(selected.id, e.target.value)}
                        style={{
                          width: '100%',
                          background: 'var(--surface)',
                          color: 'var(--text)',
                          border: '1px solid var(--border)',
                          borderRadius: 6,
                          padding: '4px 28px 4px 8px',
                          fontSize: 12,
                          cursor: 'pointer',
                        }}
                      >
                        {selected.parent_id ? (
                          <option value="__inherit__">{inheritedOwnerLabel}</option>
                        ) : sharedOwner ? (
                          <option value={sharedOwner.id}>{sharedOwner.name}</option>
                        ) : null}
                        {personalOwners.map(owner => (
                          <option key={owner.id} value={owner.id}>{owner.name}</option>
                        ))}
                      </select>
                      {selected.parent_id && !selected.owner_id ? (
                        <span
                          style={{
                            position: 'absolute',
                            left: 8,
                            top: '50%',
                            transform: 'translateY(-50%)',
                            right: 28,
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 6,
                            minWidth: 0,
                            paddingRight: 4,
                            background: 'var(--surface)',
                            pointerEvents: 'none',
                          }}
                        >
                          <span
                            style={{
                              minWidth: 0,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              color: 'var(--text)',
                              fontSize: 12,
                            }}
                          >
                            {inheritedOwnerLabel}
                          </span>
                          <span
                            style={{
                              fontSize: 9.5,
                              color: 'color-mix(in srgb, var(--text) 66%, var(--muted))',
                              padding: '1px 6px',
                              borderRadius: 999,
                              border: '1px solid color-mix(in srgb, var(--border) 92%, transparent)',
                              background: 'color-mix(in srgb, var(--surface2) 92%, var(--surface))',
                              whiteSpace: 'nowrap',
                              fontStyle: 'italic',
                              lineHeight: 1.15,
                              flexShrink: 0,
                            }}
                          >
                            inherited
                          </span>
                        </span>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {!selected.parent_id ? (
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 12,
                      color: 'var(--muted)',
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                      userSelect: 'none',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={!!selected.exclude_from_totals}
                      onChange={e => handleExcludeChange(selected.id, e.target.checked)}
                      style={{ accentColor: 'var(--accent)', width: 14, height: 14, cursor: 'pointer' }}
                    />
                    Exclude from totals
                  </label>
                ) : null}
              </div>

              </>
              )}

              <div style={{ marginTop: 22, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>
                    Matching transactions
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {matchingTxnsTotal} total{matchingTxnsTotal > pagedMatchingTxns.length ? ` · showing ${pagedMatchingTxns.length}` : ''}
                  </div>
                </div>

                {matchingTxnsLoading ? <Spinner /> : pagedMatchingTxns.length === 0 ? (
                  <div style={{
                    padding: '14px 16px',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    background: 'var(--surface2)',
                    fontSize: 13,
                    color: 'var(--muted)',
                  }}>
                    No transactions currently match this {selected.parent_id ? 'category' : 'group'}.
                  </div>
                ) : (
                  <TransactionListTable
                    rows={pagedMatchingTxns}
                    categories={flatCats}
                    onCategorySave={saveMatchingTxnCategory}
                    onCategoryOpenDetail={category => openDetailPanel('category', category)}
                    onAddCategory={addMatchingCategory}
                    onRowsChange={setPagedMatchingTxns}
                    scrollRef={matchingTxnsListRef}
                    fillHeight={true}
                    usePillTable={true}
                    columnConfig={matchingTxnColumns}
                    onColumnConfigChange={handleMatchingTxnColumnUpdate}
                  />
                )}
                {matchingTxnsLoadingMore ? (
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
                    Loading more transactions…
                  </div>
                ) : null}
              </div>
            </div>
          )}
          </div>
        </div>
      </div>

      {detailPanels.map((panel, index) => {
        if (panel.type === 'category') {
          return (
            <CategoryDetail
              key={`category:${panel.item.id}`}
              category={panel.item}
              categories={flatCats}
              forceFloating={true}
              stackIndex={index}
              isTopmost={index === detailPanels.length - 1}
              onClose={() => closeDetailPanel('category', panel.item.id)}
            />
          )
        }
        return null
      })}

      {contextMenu ? (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          target={contextMenu}
          bulkMoveMode={bulkMoveMode}
          canMoveHere={!!contextMenu.groupId && selectedCategoryIds.length > 0}
          onAddCategory={target => {
            const group = flatCats.find(cat => cat.id === target.groupId)
            if (group) openCategoryForm(group)
          }}
          onAddGroup={target => openGroupFormNear(target.sectionType, target.groupId || null, target.insertPosition || 'after')}
          onExpandAll={expandAll}
          onCollapseAll={collapseAll}
          onAlphabetize={alphabetize}
          onAddRule={openRuleCreator}
          onStartBulkMove={startBulkMove}
          onMoveHere={moveSelectedCategoriesHere}
          onCancelBulkMove={cancelBulkMove}
          onDelete={target => {
            const id = target.categoryId || target.groupId
            if (id) handleDelete(id)
            setContextMenu(null)
          }}
          onClose={() => setContextMenu(null)}
        />
      ) : null}

      {bulkMoveToast ? (
        <BulkMoveToast
          move={bulkMoveToast}
          onUndo={undoBulkMove}
          onDismiss={() => setBulkMoveToast(null)}
        />
      ) : null}

      {deleteDialog ? (
        <DeleteCategoryDialog
          category={deleteDialog.category}
          preview={deleteDialog.preview}
          categories={deleteReplacementCategories}
          replacementId={deleteReplacementId}
          onReplacementChange={setDeleteReplacementId}
          mode={deleteMode}
          onModeChange={setDeleteMode}
          onConfirm={confirmDeleteDialog}
          onCancel={closeDeleteDialog}
          saving={deleteSaving}
        />
      ) : null}
    </div>
  )
}
