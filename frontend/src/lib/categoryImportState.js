// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

/*
 * Category import drafts keep a temporary tree and sidebar ordering separate from live categories so users can
 * sort incoming values, set some aside, and undo bulk organization before anything is committed.
 */

function cloneTree(tree) {
  return {
    income: (tree?.income || []).map(group => ({
      ...group,
      children: (group.children || []).map(child => ({ ...child })),
    })),
    expense: (tree?.expense || []).map(group => ({
      ...group,
      children: (group.children || []).map(child => ({ ...child })),
    })),
  }
}

function buildSeededGroupTree(existingCategories) {
  const tree = { income: [], expense: [] }
  const groups = (existingCategories || [])
    // The workspace starts from existing top-level groups; imported values are organized under them as draft children later.
    .filter(category => !category?.parent_id)
    .map(category => ({
      id: category.id,
      name: String(category.name || '').trim(),
      categoryType: category.category_type === 'income' ? 'income' : 'expense',
      children: [],
    }))
    .filter(group => group.name)

  for (const group of groups) {
    tree[group.categoryType].push(group)
  }

  for (const sectionType of ['income', 'expense']) {
    tree[sectionType].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  }

  return tree
}

function normalizeCategoryImportValue(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function findNodeById(tree, nodeId) {
  for (const sectionType of ['income', 'expense']) {
    for (const group of tree?.[sectionType] || []) {
      if (group.id === nodeId) return group
      for (const child of group.children || []) {
        if (child.id === nodeId) return child
      }
    }
  }
  return null
}

function filterPendingSourceValues(sourceValues, existingCategories) {
  const existingLeafNames = new Set(
    (existingCategories || [])
      .filter(category => category?.parent_id)
      .map(category => normalizeCategoryImportValue(category?.name))
      .filter(Boolean),
  )
  const seenValues = new Set()
  return (sourceValues || []).filter(value => {
    const normalized = normalizeCategoryImportValue(value)
    if (!normalized || existingLeafNames.has(normalized) || seenValues.has(normalized)) {
      return false
    }
    seenValues.add(normalized)
    return true
  })
}

function sanitizeSnapshotAgainstExistingCategories(snapshot, existingCategories) {
  const existingLeafNames = new Set(
    (existingCategories || [])
      .filter(category => category?.parent_id)
      .map(category => normalizeCategoryImportValue(category?.name))
      .filter(Boolean),
  )
  if (existingLeafNames.size === 0) return cloneCategoryImportSnapshot(snapshot)

  const nextSnapshot = cloneCategoryImportSnapshot(snapshot)
  const shouldKeepValue = value => !existingLeafNames.has(normalizeCategoryImportValue(value))

  nextSnapshot.sourceOrder = (nextSnapshot.sourceOrder || []).filter(shouldKeepValue)
  nextSnapshot.setAsideOrder = (nextSnapshot.setAsideOrder || []).filter(shouldKeepValue)
  nextSnapshot.selectedSourceIds = (nextSnapshot.selectedSourceIds || []).filter(shouldKeepValue)

  for (const sectionType of ['income', 'expense']) {
    nextSnapshot.tree[sectionType] = (nextSnapshot.tree?.[sectionType] || []).map(group => ({
      ...group,
      children: (group.children || []).filter(child => shouldKeepValue(child?.sourceValue || child?.name)),
    }))
  }

  if (nextSnapshot.selectedNodeId && !findNodeById(nextSnapshot.tree, nextSnapshot.selectedNodeId)) {
    nextSnapshot.selectedNodeId = null
  }

  return nextSnapshot
}

export function cloneCategoryImportSnapshot(snapshot) {
  return {
    tree: cloneTree(snapshot?.tree),
    sourceOrder: [...(snapshot?.sourceOrder || [])],
    setAsideOrder: [...(snapshot?.setAsideOrder || [])],
    selectedSourceIds: [...(snapshot?.selectedSourceIds || [])],
    selectedNodeId: snapshot?.selectedNodeId || null,
    collapsedGroups: { ...(snapshot?.collapsedGroups || {}) },
  }
}

function buildInitialSnapshot(sourceValues, existingCategories) {
  const tree = buildSeededGroupTree(existingCategories)
  const collapsedGroups = {}
  for (const sectionType of ['income', 'expense']) {
    for (const group of tree[sectionType]) {
      // Starting collapsed keeps the first pass focused on triaging imported values instead of scanning a fully expanded tree.
      collapsedGroups[group.id] = true
    }
  }

  return {
    tree,
    sourceOrder: filterPendingSourceValues(sourceValues, existingCategories)
      .filter(Boolean)
      .slice()
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
    setAsideOrder: [],
    selectedSourceIds: [],
    selectedNodeId: null,
    collapsedGroups,
  }
}

export function createCategoryImportDraftState(sourceValues, existingCategories = []) {
  return {
    snapshot: buildInitialSnapshot(sourceValues, existingCategories),
    undoStack: [],
    redoStack: [],
    selectionAnchor: null,
    activeSection: 'expense',
    leftPanelWidth: null,
  }
}

export function sanitizeCategoryImportDraftAgainstExistingCategories(draft, existingCategories = []) {
  if (!draft?.snapshot) return null
  return {
    ...draft,
    snapshot: sanitizeSnapshotAgainstExistingCategories(draft.snapshot, existingCategories),
    undoStack: (draft.undoStack || []).map(entry => sanitizeSnapshotAgainstExistingCategories(entry, existingCategories)),
    redoStack: (draft.redoStack || []).map(entry => sanitizeSnapshotAgainstExistingCategories(entry, existingCategories)),
  }
}
