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
    sourceOrder: (sourceValues || [])
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
