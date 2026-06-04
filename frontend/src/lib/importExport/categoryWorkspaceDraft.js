// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

// Pure helpers for the imported-category workspace draft that rides inside an
// import draft / saved profile. This is the persisted form of the
// CategoryImportWorkspace tree: cloning it for storage, collecting the set of
// source values it still references, summarizing how many remain unsorted, and
// pruning a saved draft (and its undo/redo stacks) down to the source values a
// given file actually contains so a stale draft can't resurrect categories the
// current file no longer has. Operates on the snapshot shapes owned by
// categoryImportState.js.

import { cloneCategoryImportSnapshot, findNodeById } from '../categoryImportState.js'

export function clonePersistedCategoryWorkspaceDraft(draft) {
  if (!draft?.snapshot) return null
  if (draft?.snapshot?.mappings) return null
  return {
    snapshot: cloneCategoryImportSnapshot(draft.snapshot),
    undoStack: (draft.undoStack || []).map(cloneCategoryImportSnapshot),
    redoStack: (draft.redoStack || []).map(cloneCategoryImportSnapshot),
    selectionAnchor: draft.selectionAnchor || null,
    activeSection: draft.activeSection === 'income' ? 'income' : 'expense',
  }
}

export function collectCategoryWorkspaceSourceValues(draft) {
  const snapshot = draft?.snapshot
  if (!snapshot) return []
  const seen = new Set()
  const ordered = []
  const addValue = value => {
    const normalized = String(value || '').trim()
    if (!normalized || seen.has(normalized)) return
    seen.add(normalized)
    ordered.push(normalized)
  }
    ; (snapshot.sourceOrder || []).forEach(addValue)
    ; (snapshot.setAsideOrder || []).forEach(addValue)
  for (const sectionType of ['income', 'expense']) {
    for (const group of snapshot.tree?.[sectionType] || []) {
      for (const child of group.children || []) {
        addValue(child?.sourceValue || child?.name)
      }
    }
  }
  return ordered
}

export function summarizeCategoryWorkspaceDraft(draft) {
  const sourceValues = collectCategoryWorkspaceSourceValues(draft)
  return {
    sourceValues,
    totalCount: sourceValues.length,
    remainingCount: draft?.snapshot?.sourceOrder?.length || 0,
  }
}

export function sanitizeCategoryWorkspaceSnapshotToSourceValues(snapshot, sourceValues = []) {
  if (!snapshot) return null
  const validValues = new Set(
    (sourceValues || [])
      .map(value => String(value || '').trim())
      .filter(Boolean),
  )
  const shouldKeep = value => validValues.has(String(value || '').trim())
  const nextSnapshot = cloneCategoryImportSnapshot(snapshot)
  nextSnapshot.sourceOrder = (nextSnapshot.sourceOrder || []).filter(shouldKeep)
  nextSnapshot.setAsideOrder = (nextSnapshot.setAsideOrder || []).filter(shouldKeep)
  nextSnapshot.selectedSourceIds = (nextSnapshot.selectedSourceIds || []).filter(shouldKeep)

  for (const sectionType of ['income', 'expense']) {
    nextSnapshot.tree[sectionType] = (nextSnapshot.tree?.[sectionType] || []).map(group => ({
      ...group,
      children: (group.children || []).filter(child => shouldKeep(child?.sourceValue || child?.name)),
    }))
  }

  if (nextSnapshot.selectedNodeId && !findNodeById(nextSnapshot.tree, nextSnapshot.selectedNodeId)) {
    nextSnapshot.selectedNodeId = null
  }
  return nextSnapshot
}

export function sanitizeCategoryWorkspaceDraftToSourceValues(draft, sourceValues = []) {
  if (!draft?.snapshot) return null
  const nextDraft = {
    ...draft,
    snapshot: sanitizeCategoryWorkspaceSnapshotToSourceValues(draft.snapshot, sourceValues),
    undoStack: (draft.undoStack || []).map(entry => sanitizeCategoryWorkspaceSnapshotToSourceValues(entry, sourceValues)).filter(Boolean),
    redoStack: (draft.redoStack || []).map(entry => sanitizeCategoryWorkspaceSnapshotToSourceValues(entry, sourceValues)).filter(Boolean),
    selectionAnchor: draft.selectionAnchor || null,
    activeSection: draft.activeSection === 'income' ? 'income' : 'expense',
    leftPanelWidth: draft.leftPanelWidth ?? null,
  }
  return summarizeCategoryWorkspaceDraft(nextDraft).totalCount > 0 ? nextDraft : null
}

export function normalizeImportCategoryValue(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ')
}
