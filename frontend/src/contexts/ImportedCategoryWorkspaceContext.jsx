// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- provider + hook + renderer + nav-bar pill live together by design */

// App-level state for the "Group Imported Categories" workspace. It used to live inside the
// Import page tree, so it could only be opened from there and unmounted the moment the user
// navigated away. Hoisting it here lets the Categories page (and the Import page) open the same
// workspace, lets it survive route changes, and lets the user minimize it to a nav-bar pill while they
// work elsewhere — mirroring UnifiedDuplicatesViewerContext.
//
// The workspace is a full-screen modal, so "minimize then navigate then restore" is how it coexists
// with other pages (it can't be seen through). Its entire dataset derives from the category list, which
// the provider fetches on open and on restore so the draft reconciles against the current tree each time
// it becomes visible. The in-progress grouping draft is shared tenant state saved to the backend, so
// minimize / navigate never loses it.

import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { AppConfirmDialog, AppDialog, AppNoticeDialog, Button } from '../components/ui.jsx'
import { ActionCountBadge } from '../components/importExport/importPresentational.jsx'
import { UNASSIGNED_CATEGORY_SYSTEM_KEY } from '../lib/importExport/constants.js'
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
const CATEGORIES_CHANGED_EVENT = 'luma:categories-changed'
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
  // The workspace draft is shared tenant-wide state (one shared category tree being organized), not a
  // per-user preference, so it loads from the backend (import_workflow_state) rather than ui_preference.
  // A ref tracks the current value so setDraft can support functional updaters and write through without
  // a side effect inside the state updater.
  //
  // Saving is revisioned, because the draft is one record that two tabs or two members can be editing at
  // once. Each save names the revision it was edited from, and the server refuses a stale one with what it
  // holds. Saves run one at a time, and edits made while one is in flight coalesce into the next, so a burst
  // of drags sends the latest arrangement once instead of racing several requests. A refusal stops saving
  // and asks which version to keep (`draftConflict`); any other failure is shown, and the next edit retries.
  const [draft, setDraftState] = useState(null)
  const draftRef = useRef(null)
  const revisionRef = useRef(0)
  const pendingSaveRef = useRef(undefined)
  const savingRef = useRef(false)
  const draftConflictRef = useRef(null)
  const [draftConflict, setDraftConflict] = useState(null)
  // Bumped when the other version of a conflicting draft is loaded, so an open workspace re-seeds from it
  // instead of keeping the arrangement it was initialized with.
  const [draftEpoch, setDraftEpoch] = useState(0)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [notice, setNotice] = useState(null)
  const applyDraftValue = useCallback((value) => {
    draftRef.current = value ?? null
    setDraftState(value ?? null)
  }, [])
  useEffect(() => {
    let cancelled = false
    api.getCategoryWorkspaceDraft()
      .then(res => {
        if (cancelled) return
        revisionRef.current = Number(res?.revision) || 0
        applyDraftValue(res?.draft ?? null)
      })
      .catch(() => { /* keep null on failure; the workspace re-seeds from the live category flags */ })
    return () => { cancelled = true }
  }, [applyDraftValue])
  const flushDraftSaves = useCallback(async () => {
    if (savingRef.current) return
    savingRef.current = true
    try {
      while (pendingSaveRef.current !== undefined && !draftConflictRef.current) {
        const next = pendingSaveRef.current
        pendingSaveRef.current = undefined
        try {
          const saved = await api.saveCategoryWorkspaceDraft(next, revisionRef.current)
          revisionRef.current = Number(saved?.revision) || revisionRef.current + 1
        } catch (error) {
          if (error?.status === 409 && error?.detail?.code === 'draft_conflict') {
            const conflict = { draft: error.detail.draft ?? null, revision: Number(error.detail.revision) || 0 }
            draftConflictRef.current = conflict
            setDraftConflict(conflict)
          } else {
            // Keep the unsaved arrangement queued, so the next edit carries it.
            if (pendingSaveRef.current === undefined) pendingSaveRef.current = next
            setNotice(prev => prev || {
              title: 'Could not save the category draft',
              description: error?.message || 'The arrangement is kept here and is saved again with the next change.',
            })
          }
          break
        }
      }
    } finally {
      savingRef.current = false
    }
  }, [])
  const setDraft = useCallback((nextOrUpdater) => {
    const next = (typeof nextOrUpdater === 'function' ? nextOrUpdater(draftRef.current) : nextOrUpdater) ?? null
    applyDraftValue(next)
    pendingSaveRef.current = next
    flushDraftSaves()
  }, [applyDraftValue, flushDraftSaves])
  // Resolving a refused save. Keeping this window's arrangement saves it again over the revision the refusal
  // reported; loading the other one adopts what the server holds and re-seeds the open workspace from it.
  const keepMyDraft = useCallback(() => {
    const conflict = draftConflictRef.current
    if (!conflict) return
    revisionRef.current = conflict.revision
    draftConflictRef.current = null
    setDraftConflict(null)
    pendingSaveRef.current = draftRef.current
    flushDraftSaves()
  }, [flushDraftSaves])
  const loadOtherDraft = useCallback(() => {
    const conflict = draftConflictRef.current
    if (!conflict) return
    revisionRef.current = conflict.revision
    draftConflictRef.current = null
    pendingSaveRef.current = undefined
    setDraftConflict(null)
    applyDraftValue(conflict.draft)
    setDraftEpoch(epoch => epoch + 1)
  }, [applyDraftValue])

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
  // Leaves already parked live (set_aside = 1). The durable truth for which categories sit in the
  // Set Aside list, so the workspace seeds them there even with no persisted draft for this profile.
  const parkedSourceValues = useMemo(
    () => workspaceUnassignedCategories.filter(c => c.set_aside).map(c => c.name).filter(Boolean),
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

  // The workspace saves its draft as soon as it mounts, so a window that sat idle while someone else arranged
  // would be refused on that very first save. Showing it re-reads the shared draft first — unless this window
  // has an unsaved change or an unresolved refusal of its own, which a re-read must not paper over.
  const reloadDraft = useCallback(async () => {
    const busy = () => pendingSaveRef.current !== undefined || savingRef.current || !!draftConflictRef.current
    if (busy()) return
    try {
      const res = await api.getCategoryWorkspaceDraft()
      if (busy()) return
      revisionRef.current = Number(res?.revision) || 0
      applyDraftValue(res?.draft ?? null)
    } catch {
      // Keep this window's copy; a stale one is caught by the revision check on its next save.
    }
  }, [applyDraftValue])
  const open = useCallback(async () => {
    refreshCategories()
    await reloadDraft()
    setPanel({ open: true, minimized: false })
  }, [refreshCategories, reloadDraft])
  const close = useCallback(() => setPanel({ open: false, minimized: false }), [])
  const minimize = useCallback(() => setPanel(prev => (prev.open ? { ...prev, minimized: true } : prev)), [])
  const restore = useCallback(async () => {
    refreshCategories()
    await reloadDraft()
    setPanel(prev => (prev.open ? { ...prev, minimized: false } : prev))
  }, [refreshCategories, reloadDraft])

  // Commit a draft as one server transaction: the groups it names, the categories placed in them, and the
  // set-aside list land together or not at all (`POST /categories/imported-workspace/apply`). Parking is
  // not deletion — a parked leaf stays active — and any leaf not listed as parked is un-parked by the same
  // call. The plan names categories by id, resolved from the draft's labels against this window's copy of
  // the tree; one that stopped waiting after that copy was taken is refused by the server rather than
  // applied around, and a refusal reloads the tree so the next attempt starts from what is really there.
  const applyDraft = useCallback(async (draftToApply) => {
    const sourceCategoryMap = new Map(
      workspaceUnassignedCategories.map(category => [normalizeImportCategoryValue(category.name), category]),
    )
    const groups = []
    for (const sectionType of ['income', 'expense']) {
      for (const draftGroup of draftToApply?.snapshot?.tree?.[sectionType] || []) {
        const groupName = String(draftGroup.name || '').trim()
        if (!groupName) continue
        const categories = []
        for (const draftChild of draftGroup.children || []) {
          const liveCategory = sourceCategoryMap.get(normalizeImportCategoryValue(draftChild.sourceValue || draftChild.name))
          if (!liveCategory) continue
          categories.push({ id: liveCategory.id, name: String(draftChild.name || draftChild.sourceValue || '').trim() || null })
        }
        groups.push({ name: groupName, category_type: sectionType, categories })
      }
    }
    const setAsideIds = (draftToApply?.snapshot?.setAsideOrder || [])
      .map(value => sourceCategoryMap.get(normalizeImportCategoryValue(value))?.id)
      .filter(Boolean)
    try {
      const result = await api.applyImportedCategoryWorkspace({ groups, set_aside_ids: setAsideIds })
      const refreshedCategories = Array.isArray(result?.categories) ? result.categories : await api.getCategories()
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
      refreshCategories()
      setNotice({
        title: 'Could not organize imported categories',
        description: error?.message || 'Please try again.',
      })
    }
  }, [workspaceUnassignedCategories, refreshCategories, setDraft])

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
    parkedSourceValues,
    workspaceUnassignedCategories,
    existingCategories,
    draft,
    effectiveDraft,
    setDraft,
    draftConflict,
    keepMyDraft,
    loadOtherDraft,
    draftEpoch,
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
    sourceValues, parkedSourceValues, workspaceUnassignedCategories, existingCategories, draft, effectiveDraft, setDraft,
    draftConflict, keepMyDraft, loadOtherDraft, draftEpoch,
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
            key={ctx.draftEpoch}
            sourceValues={ctx.sourceValues}
            parkedSourceValues={ctx.parkedSourceValues}
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
      {/* No dismissal: each way out discards one of the two arrangements, so leaving has to be a choice. */}
      {ctx.draftConflict ? (
        <AppDialog
          title="The category draft changed somewhere else"
          description="Another window or another member saved a different arrangement of these imported categories while this one was being edited. Keep this arrangement to replace it, or load the other one and continue from there."
          width="min(480px, 100%)"
          actions={(
            <>
              <Button variant="ghost" onClick={ctx.loadOtherDraft}>Load the other arrangement</Button>
              <Button onClick={ctx.keepMyDraft}>Keep this arrangement</Button>
            </>
          )}
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
