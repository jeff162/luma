// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useEffect, useRef, useCallback, useLayoutEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api.js'
import { PageHeader, Spinner, EmptyState, CategoryMarker, OverlayBackdrop, FloatingPanel, FloatingPanelHeader, DialogActions, Button, AppConfirmDialog, AppNoticeDialog, Tooltip, RefreshButton, SearchInput } from '../components/ui.jsx'
import { useBulkTransactionEditing, BulkEditChrome } from '../lib/useBulkTransactionEditing.jsx'
import { useBusyIndicator, PAINT_GATE_DELAY_MS } from '../lib/useBusyIndicator.js'
import CategoryDetail from '../components/CategoryDetail.jsx'
import CategoryPicker from '../components/CategoryPicker.jsx'
import {
  UndoToast,
  CategoryTreeRow,
  GroupEndDropZone,
  SectionEndDropZone,
  normalizeCategoryType,
} from '../components/CategoryTreePrimitives.jsx'
import { useAppSession } from '../lib/AppSessionContext.jsx'
import TransactionListTable from '../components/TransactionListTable.jsx'
import ReimbursementsReportDialog from '../components/ReimbursementsReportDialog.jsx'
import TransactionDetail from '../components/TransactionDetail.jsx'
import { makeRowReconciler, applyCategoryChange } from '../lib/txnMutations.js'
import { usePagedTransactions } from '../components/detailShared.jsx'
import TagPickerWithCreate from '../components/TagPickerWithCreate.jsx'
import { TagGlyph } from '../components/TagUi.jsx'
import FeatureExplainer from '../help/FeatureExplainer.jsx'
import { ESCAPE_BEHAVIOR, useDismissibleLayer, useEscapeAction } from '../lib/uiInteractions.js'
import { useUserPreferences, useUserPreference } from '../lib/UserPreferencesContext.jsx'
import { useTransactionTableLayout } from '../lib/transactionTablePreferences.js'
import { localStore } from '../lib/browserStorage.js'
import { useImportedCategoryWorkspace } from '../contexts/ImportedCategoryWorkspaceContext.jsx'
import { getImportedCategoryWorkCounts } from '../lib/importExport/importedCategoryWork.js'
import { ActionCountBadge } from '../components/importExport/importPresentational.jsx'
import {
  UNASSIGNED_CATEGORY_SYSTEM_KEY,
  categoryCapabilities,
  isReimbursableSelection,
  showsCategoryControls,
} from '../lib/categoryCapabilities.js'

const SECTION_META = {
  income: { label: 'Income' },
  expense: { label: 'Expense' },
}

const LEFT_PANEL_WIDTH_STORAGE_KEY_PREFIX = 'luma.categories.left-panel-width'
const SECTION_PREF_KEY = 'ui.categories.collapsedSections'
const GROUP_PREF_KEY = 'ui.categories.collapsedGroups'
// Stable default so the preference value keeps a constant identity when nothing is stored yet.
const EMPTY_COLLAPSE_STATE = {}
const MATCHING_TXN_COLUMNS_PREF_KEY = 'ui.categories.matchingTransactions.columns'
const LEFT_PANEL_WIDTH_PREF_KEY = 'ui.categories.leftPanelWidth'

// Split between the category tree and the detail panel. The tree is the fixed-ish navigator;
// the divider lets the user trade width with the detail panel, persisted like other view prefs.
const DEFAULT_LEFT_PANEL_WIDTH = 280
const MIN_LEFT_PANEL_WIDTH = 200
const MIN_RIGHT_PANEL_WIDTH = 360
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

function getLeftPanelWidthStorageKey(instanceId, userId) {
  return instanceId && userId ? `${LEFT_PANEL_WIDTH_STORAGE_KEY_PREFIX}.${instanceId}.${userId}` : null
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


function DeleteCategoryDialog({ category, preview, categories, replacementId, onReplacementChange, mode, onModeChange, onConfirm, onCancel, saving }) {
  const ref = useRef(null)
  useDismissibleLayer({
    open: true,
    onClose: onCancel,
    refs: [ref],
  })

  const canConfirm = mode === 'unassigned' || !!replacementId
  const isGroup = !!category && category.parent_id == null

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
            <div style={{ fontSize: 16, fontWeight: 600 }}>{isGroup ? 'Delete group' : 'Delete category'}</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
              {isGroup
                ? <>&quot;{category?.name}&quot; and its categories are assigned to {preview?.txn_count} transaction{preview?.txn_count === 1 ? '' : 's'}.</>
                : <>&quot;{category?.name}&quot; is assigned to {preview?.txn_count} transaction{preview?.txn_count === 1 ? '' : 's'}.</>}
            </div>
          </div>
        </FloatingPanelHeader>

        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
            Choose where those transactions should go before deleting this {isGroup ? 'group' : 'category'}.
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

          <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            {isGroup
              ? <>The group is removed. Its categories move to <strong>Inactive</strong>, where you can recover them later.</>
              : <>The category isn&apos;t erased — it moves to <strong>Inactive</strong>, where you can recover it later.
                While inactive, future imports that use this label come in uncategorized instead of recreating it.</>}
          </div>
        </div>

        <DialogActions>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={!canConfirm || saving}>
            {saving ? 'Deleting…' : (isGroup ? 'Delete group' : 'Delete category')}
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
  bulkSelectMode,
  selectionCount,
  canMoveHere,
  onAddCategory,
  onAddGroup,
  onExpandAll,
  onCollapseAll,
  onAlphabetize,
  onAddRule,
  onStartBulkSelect,
  onMoveHere,
  onBulkDelete,
  onCancelBulkSelect,
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
      {bulkSelectMode ? (
        <>
          {selectionCount > 0 ? (
            <>
              {canMoveHere ? (
                <button
                  style={itemStyle}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
                  onMouseDown={e => {
                    e.preventDefault()
                    onMoveHere(target)
                  }}
                >
                  Move to here{target.groupName ? ` (${target.groupName})` : ''}
                </button>
              ) : (
                <div style={{ ...itemStyle, color: 'var(--muted)', cursor: 'default', opacity: 0.7 }}>
                  Move to here — right-click a group
                </div>
              )}
              <button
                style={itemStyle}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
                onMouseDown={e => {
                  e.preventDefault()
                  onBulkDelete()
                }}
              >
                Bulk delete
              </button>
            </>
          ) : (
            <div style={{ ...itemStyle, color: 'var(--muted)', cursor: 'default', opacity: 0.7 }}>
              Select categories, then choose an action
            </div>
          )}
          {divider}
          <button
            style={itemStyle}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
            onMouseDown={e => {
              e.preventDefault()
              onCancelBulkSelect()
            }}
          >
            Cancel
          </button>
        </>
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
              + Add category to &quot;{target.groupName}&quot;
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
              onStartBulkSelect(target)
            }}
          >
            Bulk select
          </button>
        </>
      )}
    </div>
  )
}

function InlineAddForm({ onSubmit, onCancel, indent = 'category' }) {
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
      onAutoEditConsumed={() => { }}
      onCancelEdit={onCancel}
      onToggleCollapse={() => { }}
      onSelect={() => { }}
      onRename={(_, name) => onSubmit(name)}
      onDelete={() => { }}
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
      onAutoEditConsumed={() => { }}
      onCancelEdit={onCancel}
      onSelect={() => { }}
      onRename={(_, name) => onSubmit(name)}
      onDelete={() => { }}
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
 * The tree has two overlapping modes: single-focus selection drives the detail pane, while bulk select temporarily
 * turns categories into an additive selection set that the context menu can then move or delete in bulk. Keeping both
 * selection shapes avoids rebuilding the page around one mode.
 */
export default function Categories() {
  const navigate = useNavigate()
  const { dbInstanceId, preferenceSubjectId: userId } = useAppSession()
  const { preferences, setPreference } = useUserPreferences()
  const [tree, setTree] = useState([])
  const [flatCats, setFlatCats] = useState([])
  const [inactiveCategories, setInactiveCategories] = useState([])
  const [pendingHardDelete, setPendingHardDelete] = useState(null)
  const [emptyCleanup, setEmptyCleanup] = useState({ groups: [], categories: [] })
  const [pendingEmptyCleanup, setPendingEmptyCleanup] = useState(false)
  const [emptyCleanupSaving, setEmptyCleanupSaving] = useState(false)
  const [availableTags, setAvailableTags] = useState([])
  const [tagPickerOpenForId, setTagPickerOpenForId] = useState(null)
  const [categoryUsage, setCategoryUsage] = useState({})
  const [uncategorizedExpenseTxnCount, setUncategorizedExpenseTxnCount] = useState(0)
  const [uncategorizedIncomeTxnCount, setUncategorizedIncomeTxnCount] = useState(0)
  const [reimbursementsOpen, setReimbursementsOpen] = useState(false)
  // Notice surface shared by the category-delete-skip path and the (controller-owned) bulk-edit flow's
  // sibling actions. The matching-list bulk edit itself is the shared controller, wired up below.
  const [bulkNotice, setBulkNotice] = useState('')
  const [moveNotice, setMoveNotice] = useState('')
  const [starterNotice, setStarterNotice] = useState('')
  const [addingStarter, setAddingStarter] = useState(false)
  const [selected, setSelected] = useState(null)
  const [selectedCategoryIds, setSelectedCategoryIds] = useState([])
  const [detailPanels, setDetailPanels] = useState([])
  const [loading, setLoading] = useState(true)
  const [newName, setNewName] = useState('')
  const [contextMenu, setContextMenu] = useState(null)
  const [inlineForm, setInlineForm] = useState(null)
  // Section/group collapse is single-source-of-truth: a SPARSE stored map (only entries the user
  // changed). The full "effective" map is derived on read with per-kind defaults (sections expanded,
  // groups collapsed) — the same defaults the old seeding applied, now computed instead of synced,
  // so there's no local mirror / load / save / readiness dance and no feedback loop.
  const [storedCollapsedSections, setStoredCollapsedSections] = useUserPreference(SECTION_PREF_KEY, EMPTY_COLLAPSE_STATE)
  const [storedCollapsedGroups, setStoredCollapsedGroups] = useUserPreference(GROUP_PREF_KEY, EMPTY_COLLAPSE_STATE)
  const [categorySearch, setCategorySearch] = useState('')
  const [leftPanelWidth, setLeftPanelWidth] = useState(null)
  // The same column-layout preference every other transaction table uses (its own key, so this list is
  // tuned separately). Single-source-of-truth by construction: no local mirror or load/save effects,
  // which once formed a feedback cycle that made the column divider jitter.
  const [matchingTxnColumns, setMatchingTxnColumns] = useTransactionTableLayout({
    preferenceKey: MATCHING_TXN_COLUMNS_PREF_KEY,
  })

  // Entry point to the App-level Group Imported Categories workspace. The count is read-only here (the
  // workspace owns the draft); it drives the header button's badge + dim, live without opening anything.
  const { open: openImportedCategoryWorkspace, draft: systemCategoryWorkspaceDraft } = useImportedCategoryWorkspace()
  const importedCategoryWork = getImportedCategoryWorkCounts(flatCats, systemCategoryWorkspaceDraft)
  const [listScrollState, setListScrollState] = useState({ top: false, bottom: false })
  const [deleteDialog, setDeleteDialog] = useState(null)
  const [deleteMode, setDeleteMode] = useState('replace')
  const [deleteReplacementId, setDeleteReplacementId] = useState('')
  const [deleteSaving, setDeleteSaving] = useState(false)
  const [bulkMoveToast, setBulkMoveToast] = useState(null)
  const [bulkDeleteToast, setBulkDeleteToast] = useState(null)
  const [bulkSelectMode, setBulkSelectMode] = useState(false)

  const listRef = useRef(null)
  const dragScrollRef = useRef(null)
  const selectedRef = useRef(null)
  const contentLayoutRef = useRef(null)

  // Effective collapse maps: fill every current section/group, applying the defaults. Reads
  // elsewhere use these full maps exactly as before; toggles write the sparse stored maps above.
  const collapsedSections = useMemo(() => {
    const next = {}
    CATEGORY_SECTION_TYPES.forEach(sectionType => { next[sectionType] = !!storedCollapsedSections[sectionType] })
    return next
  }, [storedCollapsedSections])
  const collapsedGroups = useMemo(() => {
    const next = {}
    tree.forEach(group => { next[group.id] = storedCollapsedGroups[group.id] ?? true })
    return next
  }, [storedCollapsedGroups, tree])

  useEffect(() => {
    selectedRef.current = selected
  }, [selected])


  // Left-panel width is seeded from the saved preference (with localStorage as a legacy fallback).
  useEffect(() => {
    const widthPref = Number(preferences?.[LEFT_PANEL_WIDTH_PREF_KEY])
    if (Number.isFinite(widthPref) && widthPref > 0) {
      setLeftPanelWidth(widthPref)
    } else {
      const savedWidth = Number(localStore.getJson(getLeftPanelWidthStorageKey(dbInstanceId, userId)))
      if (Number.isFinite(savedWidth) && savedWidth > 0) setLeftPanelWidth(savedWidth)
    }
  }, [dbInstanceId, preferences, userId])

  // Re-run after every category change, so two loads overlap routinely; only the newest call may land, or an
  // older answer arriving last would put back the tree and counts from before the change.
  const loadCategoriesSeqRef = useRef(0)
  const loadCategories = useCallback(async (selectedId = selectedRef.current?.id) => {
    const seq = ++loadCategoriesSeqRef.current
    const [nextTree, nextFlat, nextUsage, nextInactive, nextEmptyCleanup, uncategorizedExpenseResult, uncategorizedIncomeResult] = await Promise.all([
      api.getCategoryTree(),
      api.getCategories(),
      api.getCategoryUsageSummary(),
      api.getInactiveCategories(),
      api.getEmptyCleanupPreview(),
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
    if (loadCategoriesSeqRef.current !== seq) return
    const nextUncategorizedExpenseTxnCount = Number(uncategorizedExpenseResult?.total || 0)
    const nextUncategorizedIncomeTxnCount = Number(uncategorizedIncomeResult?.total || 0)
    setTree(nextTree)
    setFlatCats(nextFlat)
    setInactiveCategories(Array.isArray(nextInactive) ? nextInactive : [])
    setEmptyCleanup({
      groups: Array.isArray(nextEmptyCleanup?.groups) ? nextEmptyCleanup.groups : [],
      categories: Array.isArray(nextEmptyCleanup?.categories) ? nextEmptyCleanup.categories : [],
    })
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

  // The Group Imported Categories workspace is App-level and may apply from its own floating surface;
  // refresh the tree when it (or any category mutation) fans out a change so groups appear immediately.
  useEffect(() => {
    function onCategoriesChanged() { loadCategories() }
    window.addEventListener('luma:categories-changed', onCategoriesChanged)
    return () => window.removeEventListener('luma:categories-changed', onCategoriesChanged)
  }, [loadCategories])
  useEffect(() => {
    api.getTags().then(rows => setAvailableTags(Array.isArray(rows) ? rows : [])).catch(() => setAvailableTags([]))
  }, [])
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
    if (bulkSelectMode) {
      event.preventDefault()
      cancelBulkSelect()
      return
    }
    if (selected || selectedCategoryIds.length > 0) {
      event.preventDefault()
      setSelected(null)
      setSelectedCategoryIds([])
    }
  }, {
    enabled: !!deleteDialog || !!contextMenu || !!inlineForm || bulkSelectMode || !!selected || selectedCategoryIds.length > 0,
    ignoreEditableTarget: false,
    escapeBehavior: ESCAPE_BEHAVIOR.CLEAR_SELECTION,
  })

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
    // Under the protected Unassigned group, still-pending imported labels (import_pending) are a
    // filtered fallback bucket: only surface the ones that currently have transactions. But a
    // recovered/settled *system* category (import_pending = 0) is a real category the user chose to
    // keep — it shows regardless of transaction count, otherwise recovering an empty one looks like
    // it vanished.
    const visibleChildren = (group.children || []).filter(
      child => !child.import_pending || getDirectTxnCount(child, categoryUsage) > 0,
    )
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
    if (!group) return 0
    // `selected` comes from the flat category list and carries no `.children`; resolve the
    // matching tree node so child counting (incl. protected-group visibility filtering) works.
    const node = group.children ? group : (tree.find(g => g.id === group.id) || group)
    return getVisibleChildrenForGroup(node).length
  }

  // Left/right split resize. Mirrors the divider in CategoryImportWorkspace: the pointer drag
  // sets the left track width directly, clamped so neither panel collapses below its minimum.
  function clampLeftPanelWidth(value) {
    const layoutWidth = contentLayoutRef.current?.getBoundingClientRect?.().width || 0
    const maxWidth = layoutWidth
      ? Math.max(MIN_LEFT_PANEL_WIDTH, layoutWidth - MIN_RIGHT_PANEL_WIDTH - 8)
      : 560
    return Math.round(Math.min(Math.max(value, MIN_LEFT_PANEL_WIDTH), maxWidth))
  }

  // Persist only on drag-end (not on every move) so a resize is one preference write, not hundreds.
  function persistLeftPanelWidth(width) {
    localStore.setJson(getLeftPanelWidthStorageKey(dbInstanceId, userId), width)
    setPreference(LEFT_PANEL_WIDTH_PREF_KEY, width)
  }

  function startResizeDivider(event) {
    event.preventDefault()
    const layoutRect = contentLayoutRef.current?.getBoundingClientRect?.()
    if (!layoutRect) return
    let nextWidth = leftPanelWidth ?? DEFAULT_LEFT_PANEL_WIDTH

    function handlePointerMove(moveEvent) {
      nextWidth = clampLeftPanelWidth(moveEvent.clientX - layoutRect.left)
      setLeftPanelWidth(nextWidth)
    }

    function stopResize() {
      window.removeEventListener('mousemove', handlePointerMove)
      window.removeEventListener('mouseup', stopResize)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      persistLeftPanelWidth(nextWidth)
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', handlePointerMove)
    window.addEventListener('mouseup', stopResize)
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
    setBulkDeleteToast(null)
    setBulkMoveToast({
      count: orderedChildIds.length,
      targetGroupName: targetGroup?.name || 'group',
      snapshots: parentSnapshots,
      selectedIds: orderedChildIds,
    })

    await loadCategories(orderedChildIds[0])
    setSelectedCategoryIds(orderedChildIds)
    setBulkSelectMode(false)
  }

  // The server refuses some moves — a category holding money a reimbursement claims, a group that still
  // holds categories. Each drop persists several rows at once, so a refusal can leave sibling order half
  // written: the tree is reloaded before the reason is shown.
  async function runMove(move) {
    try {
      await move()
    } catch (err) {
      setMoveNotice(err?.message || 'The category could not be moved.')
      await loadCategories()
    }
  }

  function handleDropRow(dragged, targetCat, dropPosition = 'after') {
    cancelAnimationFrame(dragScrollRef.current)
    return runMove(() => placeDroppedRow(dragged, targetCat, dropPosition))
  }

  async function placeDroppedRow(dragged, targetCat, dropPosition) {
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

  function handleGroupDropEnd(dragged, group) {
    cancelAnimationFrame(dragScrollRef.current)
    return runMove(() => placeAtGroupEnd(dragged, group))
  }

  async function placeAtGroupEnd(dragged, group) {
    if (dragged.childIds?.length > 1) {
      await moveChildrenBatch(dragged.childIds, group.id)
      return
    }
    if (dragged.isGroup) return
    await moveChild(dragged, group.id)
  }

  function handleSectionDropEnd(dragged, sectionType) {
    cancelAnimationFrame(dragScrollRef.current)
    if (!dragged.isGroup) return
    return runMove(() => moveGroup(dragged, sectionType))
  }

  async function handleRename(id, name) {
    await api.updateCategory(id, { name })
    // Matching-list rows carry a denormalized category_name, so patch them in place — otherwise the
    // rename only shows after the list is re-fetched (switching categories away and back).
    const cleanedName = name.trim().replace(/\s+/g, ' ')
    setPagedMatchingTxns(prev => prev.map(txn => (
      txn.category_id === id ? { ...txn, category_name: cleanedName } : txn
    )))
    await loadCategories(id)
  }

  async function handleExcludeChange(groupId, exclude) {
    await api.updateCategory(groupId, { exclude_from_totals: exclude ? 1 : 0 })
    await loadCategories(groupId)
  }

  async function handleToggleCategoryTag(categoryId, tag, present) {
    const target = flatCats.find(cat => cat.id === categoryId)
    if (!target) return
    const current = new Set(Array.isArray(target.tag_ids) ? target.tag_ids : [])
    if (present) current.add(tag.id)
    else current.delete(tag.id)
    const next = Array.from(current)
    // Optimistic local update so the panel reflects the change immediately while the
    // PUT lands; loadCategories then reconciles against authoritative server state.
    setFlatCats(prev => prev.map(c => c.id === categoryId ? { ...c, tag_ids: next } : c))
    setSelected(prev => prev?.id === categoryId ? { ...prev, tag_ids: next } : prev)
    try {
      await api.setCategoryTags(categoryId, next)
    } finally {
      await loadCategories(categoryId)
    }
  }

  function handleCategoryTagCreated(tag) {
    setAvailableTags(prev => {
      if (prev.some(existing => existing.id === tag.id)) return prev
      return [...prev, tag]
    })
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

  async function handleReactivate(id) {
    await api.reactivateCategory(id)
    await loadCategories()
  }

  async function handleHardDelete(id) {
    setPendingHardDelete(null)
    await api.hardDeleteCategory(id)
    await loadCategories()
  }

  async function runEmptyCleanup() {
    setEmptyCleanupSaving(true)
    try {
      await api.runEmptyCleanup()
      setPendingEmptyCleanup(false)
      await loadCategories()
    } finally {
      setEmptyCleanupSaving(false)
    }
  }

  function selectCategory(cat) {
    const fullCat = getFullCategoryRecord(cat, flatCats)
    if (!fullCat) return
    if (bulkSelectMode) {
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
    if (bulkSelectMode) return null
    if (!categoryCapabilities(cat).move) return null
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

  // Toggles flip the *effective* value (which carries the default) and write it to the sparse store.
  function toggleSection(sectionType) {
    setStoredCollapsedSections(prev => ({ ...prev, [sectionType]: !collapsedSections[sectionType] }))
  }

  function toggleGroup(groupId) {
    setStoredCollapsedGroups(prev => ({ ...prev, [groupId]: !collapsedGroups[groupId] }))
  }

  function expandAll(target) {
    if (target.groupId) {
      setStoredCollapsedGroups(prev => ({ ...prev, [target.groupId]: false }))
    } else {
      setStoredCollapsedGroups(prev => {
        const next = { ...prev }
          ; (groupsBySection[target.sectionType] || []).forEach(group => { next[group.id] = false })
        return next
      })
      setStoredCollapsedSections(prev => ({ ...prev, [target.sectionType]: false }))
    }
    setContextMenu(null)
  }

  function collapseAll(target) {
    if (target.groupId) {
      setStoredCollapsedGroups(prev => ({ ...prev, [target.groupId]: true }))
    } else {
      setStoredCollapsedGroups(prev => {
        const next = { ...prev }
          ; (groupsBySection[target.sectionType] || []).forEach(group => { next[group.id] = true })
        return next
      })
      setStoredCollapsedSections(prev => ({ ...prev, [target.sectionType]: true }))
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

  function openGroupFormNear(sectionType, anchorGroupId = null, insertPosition = 'after') {
    setContextMenu(null)
    setBulkSelectMode(false)
    setSelected(null)
    setSelectedCategoryIds([])
    setNewName('')
    setInlineForm({ mode: 'group', sectionType, anchorGroupId, insertPosition })
  }

  function openCategoryForm(group) {
    setContextMenu(null)
    setBulkSelectMode(false)
    setSelected(null)
    setSelectedCategoryIds([])
    setNewName('')
    // The inline add-category form lives inside the group body, which only renders when the group
    // is expanded — and groups default to collapsed. Expand it so the form is actually visible.
    setStoredCollapsedGroups(prev => ({ ...prev, [group.id]: false }))
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
      // During bulk select the checked set IS the payload for "Move to here" / "Bulk delete";
      // right-clicking a target to open this menu must not wipe it (doing so left nothing to act
      // on and collapsed the menu back to the "select categories first" hint).
      if (!bulkSelectMode) {
        setSelectedCategoryIds(fullCat.parent_id && !isSyntheticUncategorizedCategory(fullCat) ? [fullCat.id] : [])
      }
    }
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      sectionType,
      groupId: group?.id || null,
      groupName: group?.name || '',
      categoryId: fullCat?.parent_id && !isSyntheticUncategorizedCategory(fullCat) ? fullCat.id : null,
      categoryName: fullCat?.parent_id && !isSyntheticUncategorizedCategory(fullCat) ? fullCat.name : '',
      removableId: fullCat && categoryCapabilities(fullCat).delete ? fullCat.id : null,
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

  function startBulkSelect(target) {
    setContextMenu(null)
    setInlineForm(null)
    setBulkSelectMode(true)
    if (!selected?.parent_id && target.groupId) {
      const group = flatCats.find(cat => cat.id === target.groupId)
      if (group) setSelected(group)
    }
    setSelectedCategoryIds([])
  }

  function cancelBulkSelect() {
    setContextMenu(null)
    setBulkSelectMode(false)
    setSelectedCategoryIds([])
  }

  function toggleBulkChecked(cat) {
    if (!bulkSelectMode) return
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
    await runMove(() => moveChildrenBatch(selectedCategoryIds, targetParentId))
  }

  // Bulk delete only deletes selected categories that hold no transactions (the immediate,
  // replacement-free delete path). Any still carrying transactions are left untouched and
  // reported, so deletion never silently reassigns or orphans transactions — that decision
  // stays with the per-category delete dialog.
  async function bulkDeleteEmptySelected() {
    setContextMenu(null)
    const cats = selectedCategoryIds
      .map(id => flatCats.find(cat => cat.id === id))
      .filter(Boolean)
    if (cats.length === 0) return
    const empty = cats.filter(cat => (getUsageSummaryForNode(cat).txn_count || 0) === 0)
    const skipped = cats.filter(cat => (getUsageSummaryForNode(cat).txn_count || 0) > 0)
    for (const cat of empty) {
      await api.deleteCategory(cat.id)
    }
    const deletedIds = empty.map(cat => cat.id)
    const deletedIdSet = new Set(deletedIds)
    if (selected && deletedIdSet.has(selected.id)) setSelected(null)
    setSelectedCategoryIds(prev => prev.filter(id => !deletedIdSet.has(id)))
    await loadCategories()
    if (deletedIds.length) {
      // Undo restores the soft-deactivated categories; any skipped (non-empty) ones are noted in
      // the toast subtitle and stay selected so the user can handle them individually.
      setBulkMoveToast(null)
      setBulkDeleteToast({
        deletedIds,
        title: `Deleted ${deletedIds.length} empty categor${deletedIds.length === 1 ? 'y' : 'ies'}`,
        description: skipped.length
          ? `${skipped.length} skipped — still ${skipped.length === 1 ? 'has' : 'have'} transactions`
          : 'Recoverable from the Inactive list',
      })
    } else if (skipped.length) {
      setBulkNotice(`${skipped.length} selected categor${skipped.length === 1 ? 'y' : 'ies'} still ${skipped.length === 1 ? 'has' : 'have'} transactions, so nothing was deleted — delete those individually to choose how to handle their transactions.`)
    }
  }

  async function undoBulkDelete() {
    if (!bulkDeleteToast) return
    const ids = bulkDeleteToast.deletedIds || []
    setBulkDeleteToast(null)
    for (const id of ids) {
      await api.reactivateCategory(id)
    }
    await loadCategories()
  }

  const parentCategory = selected?.parent_id
    ? (
      flatCats.find(cat => cat.id === selected.parent_id) ||
      (selected.parent_id === SYNTHETIC_UNCATEGORIZED_INCOME_GROUP_ID ? getSyntheticIncomeGroup() : null)
    )
    : null
  const selectedCapabilities = categoryCapabilities(selected)
  // The reimbursements review belongs beside the rows it is about, so it is offered from the holding
  // group and its leaves — the one place on this page where "what is still owed back" is the question
  // being asked. Elsewhere it would be a button with no relation to what is on screen.
  const showReimbursements = isReimbursableSelection(selected, parentCategory)
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

  // Bulk "select all matching" must resolve the same rows the matching list shows: scoped by the
  // selected category/categories only (the page has no date filter).
  const matchingFilterParams = {
    category_id: selectedCategoryFilter || undefined,
    category_ids: selectedCategoryIdsFilter || undefined,
  }

  // The Categories page operates on its own scope and intentionally has no filter bar (see
  // shouldShowFilterBar in App.jsx), so the matching-transactions list must NOT inherit the global
  // date filter — doing so silently hid older rows here and disagreed with the all-time delete-impact
  // count. This list is scoped by category only.
  const matchingTxnsBaseKey = selectedCategoryFilter
    ? selectedCategoryFilter
    : selectedCategoryIdsFilter
      ? selectedCategoryIdsFilter
      : null
  const matchingTxnsKey = matchingTxnsBaseKey

  const loadMatchingTxnPage = useCallback((offset, limit, sort) => (
    api.getTransactions({
      category_id: selectedCategoryFilter,
      category_ids: selectedCategoryIdsFilter || undefined,
      limit,
      offset,
      sort_by: sort.key,
      sort_dir: sort.dir,
    })
  ), [selectedCategoryFilter, selectedCategoryIdsFilter])

  const {
    rows: pagedMatchingTxns,
    setRows: setPagedMatchingTxns,
    loading: matchingTxnsLoading,
    reload: reloadMatchingTxns,
    reloading: matchingTxnsReloading,
    total: matchingTxnsTotal,
    setTotal: setMatchingTxnsTotal,
    paging: matchingTxnsPaging,
    sortState: matchingTxnsSortState,
    onSort: onMatchingTxnsSort,
  } = usePagedTransactions({
    activeKey: matchingTxnsKey,
    loadPage: loadMatchingTxnPage,
  })

  // Bulk edit over the matching-transactions list. Scope is the selected category/categories (no date
  // filter), so "select all matching" resolves the same rows server-side; rows reconcile in place.
  const matchingBulk = useBulkTransactionEditing({
    rows: pagedMatchingTxns,
    setRows: setPagedMatchingTxns,
    total: matchingTxnsTotal,
    filterParams: matchingFilterParams,
    categories: flatCats,
    availableTags,
    onRowsTrashed: count => setMatchingTxnsTotal(prev => Math.max(0, prev - count)),
  })

  function addMatchingCategory(cat) {
    setFlatCats(prev => prev.find(existing => existing.id === cat.id) ? prev : [...prev, cat])
  }

  async function saveMatchingTxnCategory(txnId, catId, catObj) {
    const cat = catObj || flatCats.find(c => c.id === catId)
    // Even in the synthetic Unassigned/Uncategorized buckets, a freshly categorized row is left in
    // place (restyled, not removed) so a mis-tap stays visible and correctable; the user prunes the
    // list on demand with the Refresh button. Applying a rule still sweeps rows immediately — undoing
    // that is heavier (edit the rule, restore the other affected txns), so it does not wait.
    // (applyCategoryChange writes through txnMutations, which invalidates the derived counts for us.)
    await applyCategoryChange(txnId, cat, (patch, id) => setPagedMatchingTxns(prev => prev.map(txn =>
      txn.id === id ? { ...txn, ...patch } : txn
    )))
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

  // Search drives the tree's expand state: while a query is active, a group opens iff its name or one of
  // its visible children matches, and the rest collapse — matches are highlighted in place. The persisted
  // collapse state is left untouched so the user's manual layout returns once the search is cleared.
  const normalizedCategoryQuery = categorySearch.trim().toLowerCase()
  const categorySearchActive = normalizedCategoryQuery.length > 0
  const categoryNameMatches = name => String(name || '').toLowerCase().includes(normalizedCategoryQuery)
  const groupHasSearchMatch = group => categoryNameMatches(group.name)
    || getVisibleChildrenForGroup(group).some(child => categoryNameMatches(child.name))
  const sectionHasSearchMatch = sectionType => (groupsBySection[sectionType] || []).some(groupHasSearchMatch)
  const categoryHighlightQuery = categorySearchActive ? categorySearch.trim() : ''
  const emptyCleanupCount = emptyCleanup.groups.length + emptyCleanup.categories.length

  // Paint gate: the first load decides the header's actions and the whole tree, so painting before it
  // lands shows a page that rearranges itself. A load that runs long still paints, on its loading state.
  const loadSlow = useBusyIndicator(loading, { delayMs: PAINT_GATE_DELAY_MS })
  if (loading && !loadSlow) return null

  return (
    <div data-browser-context-passthrough="true" style={{ padding: 32, display: 'flex', flexDirection: 'column', height: '100%', boxSizing: 'border-box' }}>
      <PageHeader title="Categories" help={<FeatureExplainer topic="page-categories" placement="bottom-left" />}>
        {/* Empty-state-only offer: a one-time head start, shown only while the tree has no leaf
            categories. Once any leaf exists (starter set added, imported, or hand-made) it's gone, and
            deleting one category won't bring it back while others remain. */}
        {!loading && !flatCats.some(cat => cat.parent_id) ? (
          <Button
            small
            variant="ghost"
            disabled={addingStarter}
            onClick={async () => {
              setAddingStarter(true)
              try {
                const result = await api.generateStarterSet({ include_leaves: true })
                await loadCategories()
                const added = result?.categories_added || 0
                setStarterNotice(added > 0
                  ? `Added ${added} starter categor${added === 1 ? 'y' : 'ies'}.`
                  : 'All starter categories are already present.')
              } catch (err) {
                setStarterNotice(err?.message || 'Could not add starter categories.')
              } finally {
                setAddingStarter(false)
              }
            }}
            title="Add a set of common categories to get started"
          >
            {addingStarter ? 'Adding…' : 'Add starter categories'}
          </Button>
        ) : null}
        <Tooltip content={importedCategoryWork.total === 0
          ? 'No imported categories are waiting to be grouped'
          : 'Sort imported categories into reporting groups'}>
          <Button
            small
            variant="ghost"
            onClick={openImportedCategoryWorkspace}
            disabled={importedCategoryWork.total === 0}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <span>Group imported categories</span>
              <ActionCountBadge count={importedCategoryWork.pending} tone="warning" />
            </span>
          </Button>
        </Tooltip>
      </PageHeader>
      <div ref={contentLayoutRef} style={{ display: 'grid', gridTemplateColumns: `${leftPanelWidth ?? DEFAULT_LEFT_PANEL_WIDTH}px 8px minmax(0, 1fr)`, flex: 1, minHeight: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <SearchInput
              name="category-search"
              value={categorySearch}
              onChange={setCategorySearch}
              placeholder="Search categories…"
              aria-label="Search categories"
              autoComplete="off"
              wrapperStyle={{ flex: 1, minWidth: 0 }}
              style={{
                padding: '9px 12px',
                border: '1px solid color-mix(in srgb, var(--muted) 50%, var(--border))',
                fontSize: 13,
              }}
            />
            {emptyCleanupCount > 0 ? (
              <button
                onClick={() => setPendingEmptyCleanup(true)}
                title="Delete empty groups and categories"
                style={{
                  flexShrink: 0,
                  whiteSpace: 'nowrap',
                  background: 'var(--surface2)',
                  border: '1px solid color-mix(in srgb, var(--muted) 50%, var(--border))',
                  color: 'var(--muted)',
                  cursor: 'pointer',
                  fontSize: 12,
                  padding: '9px 12px',
                  borderRadius: 8,
                }}
              >
                Delete empty ({emptyCleanupCount})
              </button>
            ) : null}
          </div>
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
                border: '1px solid color-mix(in srgb, var(--muted) 30%, var(--border))',
                borderRadius: 10,
                background: 'var(--surface)',
              }}
            >
              {!loading && bulkSelectMode ? (
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
                    Select categories, then right-click to choose an action.
                  </div>
                  <button
                    onClick={cancelBulkSelect}
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
                    Cancel
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
                const sectionCollapsed = categorySearchActive
                  ? !sectionHasSearchMatch(sectionType)
                  : !!collapsedSections[sectionType]

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
                      const groupCollapsed = categorySearchActive
                        ? !groupHasSearchMatch(group)
                        : !!collapsedGroups[group.id]
                      const groupCapabilities = categoryCapabilities(group)
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
                            draggable={groupCapabilities.move}
                            renameDisabled={!groupCapabilities.rename}
                            allowSelectionWhenRenameDisabled={!groupCapabilities.rename}
                            showDelete={groupCapabilities.delete}
                            acceptDrop={groupCapabilities.acceptDrop}
                            nameStyle={groupCapabilities.systemMark ? { fontStyle: 'italic' } : null}
                            highlightQuery={categoryHighlightQuery}
                            bulkSelectMode={bulkSelectMode}
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
                          {!groupCollapsed ? visibleChildren.map(child => {
                            const childCapabilities = categoryCapabilities(child)
                            return (
                            <CategoryTreeRow
                              key={child.id}
                              cat={child}
                              isChild={true}
                              isSelected={selected?.id === child.id || selectedCategoryIds.includes(child.id)}
                              draggable={childCapabilities.move}
                              renameDisabled={!childCapabilities.rename}
                              allowSelectionWhenRenameDisabled={!childCapabilities.rename}
                              showDelete={childCapabilities.delete}
                              acceptDrop={childCapabilities.acceptDrop}
                              nameStyle={childCapabilities.systemMark ? { fontStyle: 'italic' } : null}
                              highlightQuery={categoryHighlightQuery}
                              bulkSelectMode={bulkSelectMode}
                              bulkChecked={selectedCategoryIdSet.has(child.id)}
                              bulkSelectable={childCapabilities.bulkSelect}
                              onSelect={selectCategory}
                              onRename={handleRename}
                              onDelete={handleDelete}
                              onToggleBulkChecked={toggleBulkChecked}
                              onDropRow={handleDropRow}
                              onOpenContextMenu={isSyntheticUncategorizedCategory(child) ? undefined : openContextMenu}
                              onDragStartRow={getDragPayload}
                            />
                            )
                          }) : null}

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
              {!loading && inactiveCategories.length > 0 ? (
                <div style={{ borderTop: '1px solid var(--border)' }}>
                  <div
                    style={{
                      padding: '5px 11px 4px',
                      background: 'color-mix(in srgb, var(--surface2) 70%, transparent)',
                      borderBottom: '1px solid var(--border)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>Inactive</span>
                      <span style={{ fontSize: 11, color: 'var(--muted)' }}>{inactiveCategories.length}</span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>
                      Set aside or deleted. Imports of these labels stay uncategorized until you recover them.
                    </div>
                  </div>
                  {inactiveCategories.map(cat => (
                    <div
                      key={cat.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                        padding: '4px 11px',
                        borderBottom: '1px solid var(--border)',
                      }}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--muted)', minWidth: 0 }}>
                        <CategoryMarker kind="category" />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cat.name}</span>
                      </span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                        <button
                          onClick={() => handleReactivate(cat.id)}
                          title={`Recover ${cat.name}`}
                          style={{
                            background: 'transparent',
                            border: 'none',
                            color: 'var(--muted)',
                            cursor: 'pointer',
                            fontSize: 12,
                            padding: '2px 4px',
                            borderRadius: 6,
                          }}
                        >
                          Recover
                        </button>
                        <button
                          onClick={() => setPendingHardDelete(cat)}
                          title={`Permanently delete ${cat.name}`}
                          style={{
                            background: 'transparent',
                            border: 'none',
                            color: 'var(--muted)',
                            cursor: 'pointer',
                            fontSize: 12,
                            padding: '2px 4px',
                            borderRadius: 6,
                          }}
                        >
                          Delete forever
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
            <ScrollFade top={listScrollState.top} bottom={listScrollState.bottom} />
          </div>

        </div>

        <div
          onMouseDown={startResizeDivider}
          title="Drag to resize panels"
          style={{
            minHeight: 0,
            cursor: 'col-resize',
            background: 'transparent',
          }}
        />

        <div style={{ position: 'relative', minHeight: 0, minWidth: 0 }}>
          <div
            style={{
              overflow: 'hidden',
              minHeight: 0,
              minWidth: 0,
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              border: '1px solid color-mix(in srgb, var(--muted) 30%, var(--border))',
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
                      <h2 style={{ fontSize: 16, fontWeight: 600, fontStyle: selectedCapabilities.systemMark ? 'italic' : 'normal' }}>{selected.name}</h2>
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

                {!isMultiCategorySelection && showsCategoryControls(selected) && (
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
                      {!selected.parent_id ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <label
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                              fontSize: 12,
                              color: 'var(--muted)',
                              cursor: selectedCapabilities.editExclusion ? 'pointer' : 'default',
                              opacity: selectedCapabilities.editExclusion ? 1 : 0.6,
                              whiteSpace: 'nowrap',
                              userSelect: 'none',
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={!!selected.exclude_from_totals}
                              disabled={!selectedCapabilities.editExclusion}
                              onChange={e => handleExcludeChange(selected.id, e.target.checked)}
                              style={{
                                accentColor: 'var(--accent)',
                                width: 14,
                                height: 14,
                                cursor: selectedCapabilities.editExclusion ? 'pointer' : 'default',
                              }}
                            />
                            Exclude from totals
                            {/* The group holds money owed back, so the exclusion is what makes its
                                periods read correctly and is not the user's to change. Said on the row
                                rather than left to a refused click. */}
                            {selectedCapabilities.editExclusion ? null : (
                              <span style={{ fontStyle: 'italic' }}>- always, for this group</span>
                            )}
                          </label>
                          <FeatureExplainer topic="exclude-from-totals" placement="bottom-left" />
                        </span>
                      ) : null}
                      {(() => {
                        // Tag attachment for the selected category. Direct tags get the
                        // standard pill with an x-to-remove; inherited tags from the parent
                        // group render in muted italic without an x (the user must remove
                        // them at the group level for that change to propagate everywhere).
                        const tagsById = new Map(availableTags.map(t => [t.id, t]))
                        const directTagIds = Array.isArray(selected.tag_ids) ? selected.tag_ids : []
                        const parentCat = selected.parent_id ? flatCats.find(c => c.id === selected.parent_id) : null
                        const inheritedTagIds = parentCat && Array.isArray(parentCat.tag_ids)
                          ? parentCat.tag_ids.filter(id => !directTagIds.includes(id))
                          : []
                        const directTags = directTagIds.map(id => tagsById.get(id)).filter(Boolean)
                        const inheritedTags = inheritedTagIds.map(id => tagsById.get(id)).filter(Boolean)
                        const isPickerOpen = tagPickerOpenForId === selected.id
                        return (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', flex: '1 1 240px', position: 'relative' }}>
                            <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              Tags
                              <FeatureExplainer topic="categories-tags" placement="bottom-left" />
                            </span>
                            {directTags.map(tag => (
                              <span
                                key={tag.id}
                                style={{
                                  display: 'inline-flex', alignItems: 'center', gap: 6,
                                  padding: '3px 6px 3px 8px',
                                  borderRadius: 999,
                                  border: `1px solid color-mix(in srgb, ${tag.color} 32%, var(--border))`,
                                  background: `color-mix(in srgb, ${tag.color} 12%, var(--surface))`,
                                  color: 'var(--text)',
                                  fontSize: 12,
                                  lineHeight: 1.2,
                                }}
                              >
                                <TagGlyph color={tag.color} size={12} />
                                <span>{tag.name}</span>
                                <button
                                  type="button"
                                  onClick={() => handleToggleCategoryTag(selected.id, tag, false)}
                                  title={`Remove ${tag.name}`}
                                  style={{
                                    background: 'none', border: 'none', cursor: 'pointer',
                                    color: 'var(--muted)', fontSize: 14, lineHeight: 1, padding: '0 2px',
                                  }}
                                >×</button>
                              </span>
                            ))}
                            {inheritedTags.map(tag => (
                              <span
                                key={`inh-${tag.id}`}
                                title={`Inherited from group — remove at group level`}
                                style={{
                                  display: 'inline-flex', alignItems: 'center', gap: 6,
                                  padding: '3px 8px',
                                  borderRadius: 999,
                                  border: '1px dashed color-mix(in srgb, var(--border) 92%, transparent)',
                                  background: 'color-mix(in srgb, var(--surface2) 92%, var(--surface))',
                                  color: 'var(--muted)',
                                  fontSize: 12, fontStyle: 'italic', lineHeight: 1.2,
                                }}
                              >
                                <TagGlyph color={tag.color} size={12} />
                                <span>{tag.name}</span>
                              </span>
                            ))}
                            <button
                              type="button"
                              onClick={() => setTagPickerOpenForId(isPickerOpen ? null : selected.id)}
                              style={{
                                background: 'none',
                                border: '1px dashed var(--border)',
                                color: 'var(--accent2)',
                                borderRadius: 999,
                                padding: '3px 10px',
                                fontSize: 12,
                                cursor: 'pointer',
                                lineHeight: 1.2,
                              }}
                            >
                              + Tag
                            </button>
                            {isPickerOpen && (
                              <TagPickerWithCreate
                                allTags={availableTags}
                                selectedTagIds={new Set(directTagIds)}
                                onToggleTag={(tag, present) => handleToggleCategoryTag(selected.id, tag, present)}
                                onTagCreated={handleCategoryTagCreated}
                                onClose={() => setTagPickerOpenForId(null)}
                                align="left"
                              />
                            )}
                          </div>
                        )
                      })()}
                    </div>

                  </>
                )}

                <div style={{ marginTop: 22, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>
                        Matching transactions
                      </div>
                      {/* Categorized rows are left in place so a mis-tap stays correctable; this re-queries the
                        server on demand to drop rows that no longer match the selected category. */}
                      <RefreshButton
                        onRefresh={reloadMatchingTxns}
                        loading={matchingTxnsReloading}
                        disabled={!matchingTxnsKey}
                        title="Refresh — re-query the list and drop transactions that no longer match"
                      />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
                      <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                        {matchingTxnsTotal} total
                      </div>
                      {showReimbursements ? (
                        <Button
                          variant="ghost"
                          small
                          onClick={() => setReimbursementsOpen(true)}
                          title="What is still owed back, and what has come back against it"
                        >
                          Reimbursements
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        small
                        onClick={matchingBulk.toggle}
                        disabled={!matchingTxnsKey || pagedMatchingTxns.length === 0}
                        title="Select multiple transactions to edit at once"
                      >
                        {matchingBulk.bulkMode ? '✕ Done' : 'Bulk Edit'}
                      </Button>
                    </div>
                  </div>

                  <BulkEditChrome controller={matchingBulk} />

                  {matchingTxnsLoading && pagedMatchingTxns.length === 0 ? <Spinner /> : pagedMatchingTxns.length === 0 ? (
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
                      {...matchingBulk.tableProps}
                      onCategorySave={saveMatchingTxnCategory}
                      onCategoryOpenDetail={category => openDetailPanel('category', category)}
                      onTransactionOpenDetail={detailTxn => openDetailPanel('txn', detailTxn)}
                      onAddCategory={addMatchingCategory}
                      onRowsChange={setPagedMatchingTxns}
                      onTrashed={() => setMatchingTxnsTotal(prev => Math.max(0, prev - 1))}
                      // This list is category-scoped, so its rows are the server's *expanded*
                      // allocations. A rewritten split changes which categories those parts are in and
                      // for how much — which no row patch can restate — so the scope is fetched again.
                      onSplitSaved={reloadMatchingTxns}
                      paging={matchingTxnsPaging}
                      sortState={matchingTxnsSortState}
                      onSort={onMatchingTxnsSort}
                      fillHeight={true}
                      columnConfig={matchingTxnColumns}
                      onColumnConfigChange={setMatchingTxnColumns}
                    />
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {reimbursementsOpen && (
        <ReimbursementsReportDialog
          categories={flatCats}
          onAddCategory={addMatchingCategory}
          onClose={() => setReimbursementsOpen(false)}
          // Completing or pairing from in here moves allocations between categories, so the list behind
          // is refetched rather than patched — the change is not confined to the rows on screen.
          onChanged={reloadMatchingTxns}
        />
      )}

      {detailPanels.map((panel, index) => {
        if (panel.type === 'txn') {
          return (
            <TransactionDetail
              key={`txn:${panel.item.id}`}
              txn={panel.item}
              categories={flatCats}
              forceFloating={true}
              stackIndex={index}
              isTopmost={index === detailPanels.length - 1}
              onClose={() => closeDetailPanel('txn', panel.item.id)}
              // Edits saved through txnMutations already invalidated the counts; just reconcile the
              // local row in place (categorized rows linger until the user prunes with Refresh — see
              // saveMatchingTxnCategory). A trash drops the row and decrements the matching total.
              onReconcile={makeRowReconciler(setPagedMatchingTxns, {
                onRemoved: () => setMatchingTxnsTotal(prev => Math.max(0, prev - 1)),
              })}
            />
          )
        }
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
          bulkSelectMode={bulkSelectMode}
          selectionCount={selectedCategoryIds.length}
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
          onStartBulkSelect={startBulkSelect}
          onMoveHere={moveSelectedCategoriesHere}
          onBulkDelete={bulkDeleteEmptySelected}
          onCancelBulkSelect={cancelBulkSelect}
          onDelete={target => {
            const id = target.categoryId || target.groupId
            if (id) handleDelete(id)
            setContextMenu(null)
          }}
          onClose={() => setContextMenu(null)}
        />
      ) : null}

      {bulkMoveToast ? (
        <UndoToast
          title={`Moved ${bulkMoveToast.count} categor${bulkMoveToast.count === 1 ? 'y' : 'ies'}`}
          description={`Added to ${bulkMoveToast.targetGroupName}`}
          onUndo={undoBulkMove}
          onDismiss={() => setBulkMoveToast(null)}
        />
      ) : null}

      {bulkDeleteToast ? (
        <UndoToast
          title={bulkDeleteToast.title}
          description={bulkDeleteToast.description}
          onUndo={undoBulkDelete}
          onDismiss={() => setBulkDeleteToast(null)}
        />
      ) : null}

      {pendingHardDelete && (
        <AppConfirmDialog
          title={`Permanently delete "${pendingHardDelete.name}"?`}
          description="The category will be recreated if it is used in a future import."
          confirmLabel="Delete forever"
          confirmVariant="danger"
          borderColor="color-mix(in srgb, var(--danger) 35%, var(--border))"
          onConfirm={() => handleHardDelete(pendingHardDelete.id)}
          onCancel={() => setPendingHardDelete(null)}
          width="min(520px, 100%)"
        />
      )}

      {pendingEmptyCleanup && (
        <AppConfirmDialog
          title="Delete empty groups and categories?"
          description={`This permanently removes ${emptyCleanupCount} empty item${emptyCleanupCount === 1 ? '' : 's'} — categories not used in transactions or rules, and groups left with no categories.`}
          confirmLabel={emptyCleanupSaving ? 'Deleting…' : 'Delete empty'}
          confirmVariant="danger"
          confirmDisabled={emptyCleanupSaving}
          borderColor="color-mix(in srgb, var(--danger) 35%, var(--border))"
          onConfirm={runEmptyCleanup}
          onCancel={() => setPendingEmptyCleanup(false)}
          width="min(520px, 100%)"
        >
          <div style={{ maxHeight: 240, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13 }}>
            {emptyCleanup.groups.length > 0 ? (
              <div>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Groups ({emptyCleanup.groups.length})</div>
                <div style={{ color: 'var(--muted)' }}>{emptyCleanup.groups.map(group => group.name).join(', ')}</div>
              </div>
            ) : null}
            {emptyCleanup.categories.length > 0 ? (
              <div>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Categories ({emptyCleanup.categories.length})</div>
                <div style={{ color: 'var(--muted)' }}>{emptyCleanup.categories.map(category => category.name).join(', ')}</div>
              </div>
            ) : null}
          </div>
        </AppConfirmDialog>
      )}

      {moveNotice ? (
        <AppNoticeDialog title="Could not move category" description={moveNotice} onClose={() => setMoveNotice('')} />
      ) : null}
      {bulkNotice ? (
        <AppNoticeDialog title="Bulk action" description={bulkNotice} onClose={() => setBulkNotice('')} />
      ) : null}

      {starterNotice ? (
        <AppNoticeDialog title="Starter categories" description={starterNotice} onClose={() => setStarterNotice('')} />
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
