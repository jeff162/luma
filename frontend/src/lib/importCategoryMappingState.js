import { normalizeCategoryType } from '../components/CategoryTreePrimitives.jsx'

function cloneTree(tree) {
  return {
    income: (tree.income || []).map(group => ({
      ...group,
      children: (group.children || []).map(child => ({ ...child })),
    })),
    expense: (tree.expense || []).map(group => ({
      ...group,
      children: (group.children || []).map(child => ({ ...child })),
    })),
  }
}

export function cloneImportCategoryMappingSnapshot(snapshot) {
  return {
    tree: cloneTree(snapshot.tree),
    sourceOrder: [...(snapshot.sourceOrder || [])],
    setAsideOrder: [...(snapshot.setAsideOrder || [])],
    mappings: Object.fromEntries(Object.entries(snapshot.mappings || {}).map(([key, value]) => [key, { ...value }])),
    selectedNodeId: snapshot.selectedNodeId || null,
    selectedSourceIds: [...(snapshot.selectedSourceIds || [])],
    collapsedGroups: { ...(snapshot.collapsedGroups || {}) },
  }
}

function buildDraftTree(flatCategories, initialAssignments) {
  const groups = { income: [], expense: [] }

  for (const cat of flatCategories || []) {
    if (cat.parent_id) continue
    const categoryType = normalizeCategoryType(cat.category_type)
    groups[categoryType].push({
      id: cat.id,
      name: cat.name,
      categoryType,
      isNew: false,
      importBadge: null,
      children: [],
    })
  }

  for (const group of [...groups.income, ...groups.expense]) {
    group.children = (flatCategories || [])
      .filter(cat => cat.parent_id === group.id)
      .map(cat => ({
        id: cat.id,
        parentId: group.id,
        name: cat.name,
        categoryType: group.categoryType,
        isNew: false,
        importBadge: null,
      }))
  }

  for (const targetId of Object.values(initialAssignments || {})) {
    for (const sectionType of ['income', 'expense']) {
      for (const group of groups[sectionType]) {
        if (group.id === targetId) group.importBadge = group.importBadge || 'mapped'
        for (const child of group.children) {
          if (child.id === targetId) child.importBadge = child.importBadge || 'mapped'
        }
      }
    }
  }

  return groups
}

function getInitialSnapshot(existingCategories, sourceValues, initialAssignments) {
  const tree = buildDraftTree(existingCategories, initialAssignments)
  const sourceOrder = (sourceValues || [])
    .filter(value => value && !initialAssignments?.[value])
    .slice()
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))

  return {
    tree,
    sourceOrder,
    setAsideOrder: [],
    mappings: Object.fromEntries(
      Object.entries(initialAssignments || {}).map(([rawValue, targetId]) => [
        rawValue,
        { rawValue, targetId, resolution: 'existing' },
      ]),
    ),
    selectedNodeId: null,
    selectedSourceIds: [],
    collapsedGroups: {},
  }
}

export function createImportCategoryMappingDraftState(existingCategories, sourceValues, initialAssignments) {
  return {
    snapshot: getInitialSnapshot(existingCategories, sourceValues, initialAssignments),
    undoStack: [],
    redoStack: [],
    selectionAnchor: null,
    activeSection: 'expense',
  }
}
