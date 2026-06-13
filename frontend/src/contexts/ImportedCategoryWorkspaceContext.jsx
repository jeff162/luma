// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- provider + hook + renderer + nav-bar pill live together by design */

// App-level state for the "Group Imported Categories" workspace. It used to live inside the
// Import/Export page tree, so it could only be opened from there and unmounted the moment the user
// navigated away. Hoisting it here lets the Categories page (and the Import page) open the same
// workspace, lets it survive route changes, and lets the user minimize it to a nav-bar pill while they
// work elsewhere — mirroring UnifiedDuplicatesViewerContext.
//
// The workspace is a full-screen modal, so "minimize then navigate then restore" is how it coexists
// with other pages (it can't be seen through). Its entire dataset derives from the category list, which
// the provider fetches on open and on restore so the draft reconciles against the current tree each time
// it becomes visible. The in-progress grouping draft is persisted (useUserPreference), so minimize /
// navigate never loses it.

import { createContext, lazy, Suspense, useCallback, useContext, useMemo, useState } from 'react'
import { api } from '../lib/api.js'
import { useUserPreference } from '../lib/UserPreferencesContext.jsx'
import { AppConfirmDialog, AppNoticeDialog } from '../components/ui.jsx'
import { ActionCountBadge } from '../components/importExport/importPresentational.jsx'
import { SYSTEM_CATEGORY_WORKSPACE_DRAFT_PREF_KEY, UNASSIGNED_CATEGORY_SYSTEM_KEY } from '../lib/importExport/constants.js'
import {
  normalizeImportCategoryValue,
  sanitizeCategoryWorkspaceDraftToSourceValues,
} from '../lib/importExport/categoryWorkspaceDraft.js'
import { getImportedCategoryWorkCounts } from '../lib/importExport/importedCategoryWork.js'

// Lazy so the workspace component (and anything it pulls in) stays out of the eager App bundle; it only
// loads the first time the user opens the workspace.
const CategoryImportWorkspace = lazy(() => import('../components/CategoryImportWorkspace.jsx'))

// Broadcast after the workspace mutates categories (apply / delete) so other surfaces that hold their
// own category copy — the Import page, the Categories page — re-fetch. Exported for any future mutation
// site that should fan out the same way.
const CATEGORIES_CHANGED_EVENT = 'fintrack:categories-changed'
export function notifyCategoriesChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(CATEGORIES_CHANGED_EVENT))
}

const ImportedCategoryWorkspaceContext = createContext(null)

export function useImportedCategoryWorkspace() {
  const ctx = useContext(ImportedCategoryWorkspaceContext)
  if (!ctx) {
    throw new Error('useImportedCategoryWorkspace must be used inside <ImportedCategoryWorkspaceProvider>')
  }
  return ctx
}

export function ImportedCategoryWorkspaceProvider({ children }) {
  const [panel, setPanel] = useState({ open: false, minimized: false })
  const [categories, setCategories] = useState([])
  const [draft, setDraft] = useUserPreference(SYSTEM_CATEGORY_WORKSPACE_DRAFT_PREF_KEY, null)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [notice, setNotice] = useState(null)

  // The workspace inputs derive entirely from the live category list (same memos that used to live in
  // ImportExport): the protected Unassigned group, its still-pending imported leaves (the pool), and the
  // rest of the tree (the group drop targets).
  const unassignedGroup = useMemo(
    () => categories.find(c => !c.parent_id && c.system_key === UNASSIGNED_CATEGORY_SYSTEM_KEY) || null,
    [categories],
  )
  const workspaceUnassignedCategories = useMemo(
    () => (unassignedGroup
      ? categories
        .filter(c => c.parent_id === unassignedGroup.id && c.import_pending)
        .slice()
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }))
      : []),
    [categories, unassignedGroup],
  )
  const sourceValues = useMemo(
    () => workspaceUnassignedCategories.map(c => c.name).filter(Boolean),
    [workspaceUnassignedCategories],
  )
  const existingCategories = useMemo(
    () => categories.filter(c => c.id !== unassignedGroup?.id && c.parent_id !== unassignedGroup?.id),
    [categories, unassignedGroup],
  )
  const effectiveDraft = useMemo(
    () => sanitizeCategoryWorkspaceDraftToSourceValues(draft, sourceValues),
    [draft, sourceValues],
  )
  const counts = useMemo(() => getImportedCategoryWorkCounts(categories, draft), [categories, draft])

  const refreshCategories = useCallback(async () => {
    try {
      setCategories(await api.getCategories())
    } catch {
      // Keep the prior snapshot on a fetch failure rather than blanking the workspace.
    }
  }, [])

  const open = useCallback(() => {
    refreshCategories()
    setPanel({ open: true, minimized: false })
  }, [refreshCategories])
  const close = useCallback(() => setPanel({ open: false, minimized: false }), [])
  const minimize = useCallback(() => setPanel(prev => (prev.open ? { ...prev, minimized: true } : prev)), [])
  const restore = useCallback(() => {
    refreshCategories()
    setPanel(prev => (prev.open ? { ...prev, minimized: false } : prev))
  }, [refreshCategories])

  // Commit a draft: create/rename groups, move leaves into them, reconcile the set-aside flag, then
  // refresh categories, re-anchor the persisted draft, close, and fan out the category change. Moved
  // verbatim from ImportExport; the page's global spinner is replaced by the workspace's own apply state.
  const applyDraft = useCallback(async (draftToApply) => {
    try {
      const sourceCategoryMap = new Map(
        workspaceUnassignedCategories.map(category => [normalizeImportCategoryValue(category.name), category]),
      )
      const groupKeyToCategory = new Map(
        existingCategories
          .filter(category => !category.parent_id)
          .map(category => [
            `${category.category_type === 'income' ? 'income' : 'expense'}::${String(category.name || '').trim().toLowerCase()}`,
            category,
          ]),
      )

      for (const sectionType of ['income', 'expense']) {
        for (const draftGroup of draftToApply?.snapshot?.tree?.[sectionType] || []) {
          const groupName = String(draftGroup.name || '').trim()
          if (!groupName) continue
          const groupKey = `${sectionType}::${groupName.toLowerCase()}`
          let liveGroup = groupKeyToCategory.get(groupKey)
          if (!liveGroup) {
            liveGroup = await api.createCategory({ name: groupName, category_type: sectionType })
            groupKeyToCategory.set(groupKey, liveGroup)
          }
          for (const draftChild of draftGroup.children || []) {
            const sourceKey = normalizeImportCategoryValue(draftChild.sourceValue || draftChild.name)
            const liveCategory = sourceCategoryMap.get(sourceKey)
            if (!liveCategory) continue
            const nextName = String(draftChild.name || draftChild.sourceValue || '').trim()
            const patch = {}
            if (liveCategory.parent_id !== liveGroup.id) patch.parent_id = liveGroup.id
            if (nextName && nextName !== liveCategory.name) patch.name = nextName
            if (Object.keys(patch).length > 0) await api.updateCategory(liveCategory.id, patch)
          }
        }
      }

      // Parking ("set aside") is NOT a deletion: it moves a pending leaf out of the "needs sorting" pool
      // but leaves it active. Reconcile the flag from the parked list — listed leaves get parked; any
      // currently-parked leaf no longer listed (restored to the pool, or grouped) is un-parked.
      const setAsideKeys = new Set(
        (draftToApply?.snapshot?.setAsideOrder || []).map(value => normalizeImportCategoryValue(value)),
      )
      for (const key of setAsideKeys) {
        const liveCategory = sourceCategoryMap.get(key)
        if (liveCategory && !liveCategory.set_aside) await api.setCategoryAside(liveCategory.id)
      }
      for (const liveCategory of workspaceUnassignedCategories) {
        if (liveCategory.set_aside && !setAsideKeys.has(normalizeImportCategoryValue(liveCategory.name))) {
          await api.restoreCategoryToPool(liveCategory.id)
        }
      }

      const refreshedCategories = await api.getCategories()
      const refreshedUnassignedGroup = refreshedCategories.find(category => (
        !category.parent_id && category.system_key === UNASSIGNED_CATEGORY_SYSTEM_KEY
      )) || null
      const refreshedUnassignedSourceValues = refreshedUnassignedGroup
        ? refreshedCategories
          .filter(category => category.parent_id === refreshedUnassignedGroup.id && category.import_pending)
          .map(category => category.name)
          .filter(Boolean)
        : []
      setCategories(refreshedCategories)
      setDraft(sanitizeCategoryWorkspaceDraftToSourceValues(draftToApply, refreshedUnassignedSourceValues))
      setPanel({ open: false, minimized: false })
      notifyCategoriesChanged()
    } catch (error) {
      setNotice({
        title: 'Could not organize imported categories',
        description: error?.message || 'Please try again.',
      })
    }
  }, [workspaceUnassignedCategories, existingCategories, setDraft])

  // Delete a pending leaf from the workspace (the Delete… action) — same delete flow as the Categories
  // page (clears its transactions). The confirm shows the affected transaction count.
  const requestDelete = useCallback(async (sourceValuesToDelete) => {
    const keys = new Set((sourceValuesToDelete || []).map(value => normalizeImportCategoryValue(value)))
    const targets = workspaceUnassignedCategories.filter(c => keys.has(normalizeImportCategoryValue(c.name)))
    if (!targets.length) return
    let txnCount = 0
    try {
      const previews = await Promise.all(targets.map(target => api.getCategoryDeletePreview(target.id)))
      txnCount = previews.reduce((sum, preview) => sum + Number(preview?.txn_count || 0), 0)
    } catch {
      txnCount = null
    }
    setPendingDelete({ targets, txnCount })
  }, [workspaceUnassignedCategories])

  const confirmDelete = useCallback(async () => {
    const targets = pendingDelete?.targets || []
    setPendingDelete(null)
    if (!targets.length) return
    try {
      for (const target of targets) {
        await api.deleteCategory(target.id, { replacement_category_id: null })
      }
      setCategories(await api.getCategories())
      notifyCategoriesChanged()
    } catch (error) {
      setNotice({ title: 'Could not delete category', description: error?.message || 'Please try again.' })
    }
  }, [pendingDelete])

  // The workspace calls this when it mutates categories inline; mirror into the provider snapshot and
  // fan out so the pages refresh too.
  const handleCategoriesChanged = useCallback((next) => {
    setCategories(next || [])
    notifyCategoriesChanged()
  }, [])

  const value = useMemo(() => ({
    isOpen: panel.open,
    minimized: panel.minimized,
    open, close, minimize, restore,
    pendingCount: counts.pending,
    totalCount: counts.total,
    sourceValues,
    workspaceUnassignedCategories,
    existingCategories,
    effectiveDraft,
    setDraft,
    applyDraft,
    requestDelete,
    confirmDelete,
    pendingDelete,
    setPendingDelete,
    handleCategoriesChanged,
    notice,
    setNotice,
  }), [
    panel.open, panel.minimized, open, close, minimize, restore, counts.pending, counts.total,
    sourceValues, workspaceUnassignedCategories, existingCategories, effectiveDraft, setDraft,
    applyDraft, requestDelete, confirmDelete, pendingDelete, handleCategoriesChanged, notice,
  ])

  return (
    <ImportedCategoryWorkspaceContext.Provider value={value}>
      {children}
    </ImportedCategoryWorkspaceContext.Provider>
  )
}

// Mounted once near the top of the App tree so the workspace survives route changes. The workspace
// component is lazy; the small confirm/notice dialogs come from the eager ui primitives.
export function ImportedCategoryWorkspaceRenderer() {
  const ctx = useImportedCategoryWorkspace()
  return (
    <>
      {ctx.isOpen && !ctx.minimized ? (
        <Suspense fallback={null}>
          <CategoryImportWorkspace
            sourceValues={ctx.sourceValues}
            parkedSourceValues={ctx.workspaceUnassignedCategories.filter(c => c.set_aside).map(c => c.name).filter(Boolean)}
            sourceMeta={{
              total_count: ctx.totalCount,
              displayed_count: ctx.sourceValues.length,
              truncated: false,
              limit: ctx.sourceValues.length,
            }}
            existingCategories={ctx.existingCategories}
            initialDraftState={ctx.effectiveDraft}
            onDraftStateChange={ctx.setDraft}
            onApply={ctx.applyDraft}
            onClose={ctx.close}
            onMinimize={ctx.minimize}
            onCategoriesChanged={ctx.handleCategoriesChanged}
            onDeleteSources={ctx.requestDelete}
            title="Group Imported Categories"
            description="Organize imported categories into reporting groups."
            sourceHeading="Unassigned Categories"
            applyLabel="Apply assignments"
            applyPendingLabel="Applying…"
            remainingItemLabelSingular="unassigned category"
            remainingItemLabelPlural="unassigned categories"
          />
        </Suspense>
      ) : null}
      {ctx.pendingDelete ? (
        <AppConfirmDialog
          title={ctx.pendingDelete.targets.length === 1
            ? `Delete “${ctx.pendingDelete.targets[0].name}”?`
            : `Delete ${ctx.pendingDelete.targets.length} categories?`}
          description={ctx.pendingDelete.txnCount
            ? `${ctx.pendingDelete.txnCount} transaction${ctx.pendingDelete.txnCount === 1 ? '' : 's'} currently categorized here.`
            : undefined}
          confirmLabel="Delete"
          confirmVariant="danger"
          onConfirm={ctx.confirmDelete}
          onCancel={() => ctx.setPendingDelete(null)}
          width="min(440px, 100%)"
        />
      ) : null}
      {ctx.notice ? (
        <AppNoticeDialog
          title={ctx.notice.title}
          description={ctx.notice.description}
          onClose={() => ctx.setNotice(null)}
        />
      ) : null}
    </>
  )
}

// Nav-bar chip shown while the workspace is minimized; clicking restores it (and re-fetches categories
// so the draft reconciles against any edits made while it was stashed).
export function MinimizedImportedCategoryWorkspaceNavItem() {
  const ctx = useImportedCategoryWorkspace()
  if (!ctx.isOpen || !ctx.minimized) return null
  return (
    <button
      type="button"
      onClick={ctx.restore}
      title={`Restore Group Imported Categories${ctx.pendingCount ? ` (${ctx.pendingCount} left to group)` : ''}`}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 10px',
        margin: '4px 0',
        background: 'color-mix(in srgb, var(--accent) 12%, var(--surface2))',
        color: 'var(--text)',
        border: '1px solid color-mix(in srgb, var(--accent2) 30%, var(--border))',
        borderRadius: 8,
        cursor: 'pointer',
        fontSize: 12,
        textAlign: 'left',
        width: '100%',
        overflow: 'hidden',
      }}
    >
      <span style={{ fontSize: 13, lineHeight: 1, color: 'var(--accent2)' }}>↗</span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        Group categories
      </span>
      <ActionCountBadge count={ctx.pendingCount} tone="warning" />
    </button>
  )
}
