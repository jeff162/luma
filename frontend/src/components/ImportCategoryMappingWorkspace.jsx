import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import {
  cloneImportCategoryMappingSnapshot,
  createImportCategoryMappingDraftState,
} from '../lib/importCategoryMappingState.js'
import { Button, CategoryMarker } from './ui.jsx'
import {
  CategoryTreeRow,
  clearCategoryTreeDragItem,
  normalizeCategoryType,
  setCategoryTreeDragItem,
} from './CategoryTreePrimitives.jsx'

function createTempId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

function findNode(tree, nodeId) {
  for (const sectionType of ['income', 'expense']) {
    for (const group of tree[sectionType]) {
      if (group.id === nodeId) return { node: group, group: null, sectionType }
      for (const child of group.children) {
        if (child.id === nodeId) return { node: child, group, sectionType }
      }
    }
  }
  return null
}

function findLastIndex(items, predicate) {
  for (let idx = items.length - 1; idx >= 0; idx -= 1) {
    if (predicate(items[idx])) return idx
  }
  return -1
}

function statusPill(label, tone) {
  const colors = tone === 'new'
    ? {
        background: 'color-mix(in srgb, #0ea5e9 18%, var(--surface))',
        border: 'color-mix(in srgb, #0ea5e9 42%, var(--border))',
        color: '#075985',
      }
    : {
        background: 'color-mix(in srgb, var(--accent) 18%, var(--surface))',
        border: 'color-mix(in srgb, var(--accent) 42%, var(--border))',
        color: 'var(--accent2)',
      }
  return (
    <span
      style={{
        borderRadius: 999,
        border: `1px solid ${colors.border}`,
        background: colors.background,
        color: colors.color,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.03em',
        padding: '3px 8px',
        textTransform: 'lowercase',
        display: 'inline-flex',
        alignItems: 'center',
        lineHeight: 1,
      }}
    >
      {label}
    </span>
  )
}

function sourceChip(label, selected) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        maxWidth: '100%',
        padding: '3px 9px',
        borderRadius: 999,
        border: `1px solid ${selected ? 'color-mix(in srgb, var(--accent) 44%, var(--border))' : 'color-mix(in srgb, var(--border) 82%, transparent)'}`,
        background: selected
          ? 'color-mix(in srgb, var(--accent) 12%, var(--surface))'
          : 'color-mix(in srgb, var(--surface2) 78%, var(--surface))',
        boxShadow: selected ? '0 0 0 2px color-mix(in srgb, var(--accent) 12%, transparent)' : 'none',
      }}
    >
      <CategoryMarker kind="category" />
      <span
        style={{
          fontSize: 12,
          fontWeight: 500,
          color: 'var(--text)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
    </span>
  )
}

function MultiDropChoiceDialog({ choice, onChoose, onCancel }) {
  const ref = useRef(null)

  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) onCancel()
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [onCancel])

  if (!choice) return null

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1300,
        background: 'rgba(15, 23, 42, 0.24)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      <div
        ref={ref}
        style={{
          width: 'min(420px, 100%)',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 14,
          boxShadow: '0 24px 60px rgba(15, 23, 42, 0.24)',
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: '16px 18px 12px', borderBottom: '1px solid var(--border)', background: 'var(--surface2)' }}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Place selected categories</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
            {choice.sourceIds.length} file categories were dropped on <strong>{choice.targetName}</strong>.
          </div>
        </div>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button
            onClick={() => onChoose('group')}
            style={{
              textAlign: 'left',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 10,
              padding: '10px 12px',
              cursor: 'pointer',
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Add all to group</div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              Create these categories in <strong>{choice.groupName}</strong>.
            </div>
          </button>
          <button
            onClick={() => onChoose('category')}
            style={{
              textAlign: 'left',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 10,
              padding: '10px 12px',
              cursor: 'pointer',
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Map all to category</div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              Map them all to <strong>{choice.targetName}</strong>.
            </div>
          </button>
        </div>
        <div style={{ padding: '10px 16px 14px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end' }}>
          <button
            onClick={onCancel}
            style={{
              background: 'none',
              border: '1px solid var(--border)',
              color: 'var(--muted)',
              borderRadius: 999,
              padding: '5px 12px',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

function MappingContextMenu({
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
  onStartBulkMove,
  onMoveHere,
  onCancelBulkMove,
  onDelete,
  onClose,
}) {
  const ref = useRef(null)
  const [menuHeight, setMenuHeight] = useState(0)

  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [onClose])

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
        zIndex: 1200,
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
              move here
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
              cancel bulk move
            </button>
          </>
        ) : (
          <>
            <div style={{ ...itemStyle, color: 'var(--muted)', cursor: 'default', opacity: 0.7 }}>
              select categories, then choose a destination group
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
              cancel bulk move
            </button>
          </>
        )
      ) : (
        <>
          <button
            style={itemStyle}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
            onMouseDown={e => {
              e.preventDefault()
              onAddGroup(target)
            }}
          >
            + new group
          </button>
          <button
            style={itemStyle}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
            onMouseDown={e => {
              e.preventDefault()
              onAddCategory(target)
            }}
          >
            + add category
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
            expand
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
            collapse
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
            alphabetize
          </button>
          {target.canDelete ? (
            <button
              style={{ ...itemStyle, color: target.removeInUse ? 'var(--danger)' : 'var(--text)' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
              onMouseDown={e => {
                e.preventDefault()
                onDelete(target)
              }}
            >
              remove
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
            bulk move
          </button>
        </>
      )}
    </div>
  )
}

export default function ImportCategoryMappingWorkspace({
  sourceValues,
  existingCategories,
  initialAssignments,
  initialDraftState,
  onDraftStateChange,
  onApply,
  onClose,
}) {
  const computedInitialDraftState = useMemo(
    () => createImportCategoryMappingDraftState(existingCategories, sourceValues, initialAssignments),
    [existingCategories, initialAssignments, sourceValues],
  )
  const [snapshot, setSnapshot] = useState(() => cloneImportCategoryMappingSnapshot((initialDraftState || computedInitialDraftState).snapshot))
  const [undoStack, setUndoStack] = useState(() => (initialDraftState?.undoStack || []).map(cloneImportCategoryMappingSnapshot))
  const [redoStack, setRedoStack] = useState(() => (initialDraftState?.redoStack || []).map(cloneImportCategoryMappingSnapshot))
  const [selectionAnchor, setSelectionAnchor] = useState(initialDraftState?.selectionAnchor || null)
  const [saving, setSaving] = useState(false)
  const [contextMenu, setContextMenu] = useState(null)
  const [autoEditNodeId, setAutoEditNodeId] = useState(null)
  const [autoEditToken, setAutoEditToken] = useState(0)
  const [bulkMoveMode, setBulkMoveMode] = useState(false)
  const [selectedTreeCategoryIds, setSelectedTreeCategoryIds] = useState([])
  const [categoryUsage, setCategoryUsage] = useState({})
  const [pendingDropChoice, setPendingDropChoice] = useState(null)

  const totalSourceCount = (sourceValues || []).filter(Boolean).length
  const processedCount = totalSourceCount - snapshot.sourceOrder.length
  const selectedNodeInfo = snapshot.selectedNodeId ? findNode(snapshot.tree, snapshot.selectedNodeId) : null
  const selectedNode = selectedNodeInfo?.node || null
  const selectedGroup = selectedNodeInfo?.group || (selectedNode && !selectedNode.parentId ? selectedNode : null)
  const canAddToGroup = snapshot.selectedSourceIds.length > 0 && !!selectedNode && !selectedNode.parentId
  const canMapToCategory = snapshot.selectedSourceIds.length > 0 && !!selectedNode && !!selectedNode.parentId

  useEffect(() => {
    let cancelled = false
    api.getCategoryUsageSummary()
      .then(summary => {
        if (!cancelled) setCategoryUsage(summary || {})
      })
      .catch(() => {
        if (!cancelled) setCategoryUsage({})
      })
    return () => { cancelled = true }
  }, [existingCategories])

  function orderedTreeCategoryIds() {
    return ['income', 'expense'].flatMap(sectionType =>
      (snapshot.tree[sectionType] || []).flatMap(group => (group.children || []).map(child => child.id)),
    )
  }

  function resolveGroupInsertionTarget(target = null) {
    const preferred = target || (selectedNodeInfo
      ? {
          sectionType: selectedNodeInfo.sectionType,
          groupId: selectedNodeInfo.group ? selectedNodeInfo.group.id : selectedNodeInfo.node.id,
        }
      : null)
    return {
      sectionType: preferred?.sectionType || selectedNode?.categoryType || 'expense',
      groupId: preferred?.groupId || null,
    }
  }

  function resolveCategoryTarget(target = null) {
    const preferred = target || (selectedNodeInfo
      ? {
          sectionType: selectedNodeInfo.sectionType,
          groupId: selectedNodeInfo.group ? selectedNodeInfo.group.id : selectedNodeInfo.node.id,
        }
      : null)
    return {
      sectionType: preferred?.sectionType || selectedNode?.categoryType || 'expense',
      groupId: preferred?.groupId || null,
    }
  }

  useEffect(() => {
    onDraftStateChange?.({
      snapshot: cloneImportCategoryMappingSnapshot(snapshot),
      undoStack: undoStack.map(cloneImportCategoryMappingSnapshot),
      redoStack: redoStack.map(cloneImportCategoryMappingSnapshot),
      selectionAnchor,
    })
  }, [onDraftStateChange, redoStack, selectionAnchor, snapshot, undoStack])

  function getUsageSummaryForNode(node) {
    if (!node) {
      return { txn_count: 0, rule_count: 0, profile_mapping_count: 0, batch_mapping_count: 0, is_in_use: false }
    }
    const direct = categoryUsage?.[node.id] || { txn_count: 0, rule_count: 0, profile_mapping_count: 0, batch_mapping_count: 0, is_in_use: false }
    if (node.parentId) return direct
    const aggregate = {
      txn_count: direct.txn_count || 0,
      rule_count: direct.rule_count || 0,
      profile_mapping_count: direct.profile_mapping_count || 0,
      batch_mapping_count: direct.batch_mapping_count || 0,
      is_in_use: !!direct.is_in_use,
    }
    for (const child of node.children || []) {
      const childUsage = categoryUsage?.[child.id] || {}
      aggregate.txn_count += childUsage.txn_count || 0
      aggregate.rule_count += childUsage.rule_count || 0
      aggregate.profile_mapping_count += childUsage.profile_mapping_count || 0
      aggregate.batch_mapping_count += childUsage.batch_mapping_count || 0
    }
    aggregate.is_in_use = !!(
      aggregate.txn_count ||
      aggregate.rule_count ||
      aggregate.profile_mapping_count ||
      aggregate.batch_mapping_count
    )
    return aggregate
  }

  function applySnapshotChange(mutator) {
    const next = cloneImportCategoryMappingSnapshot(snapshot)
    mutator(next)
    setUndoStack(prev => [...prev, cloneImportCategoryMappingSnapshot(snapshot)])
    setRedoStack([])
    setSnapshot(next)
  }

  function handleSelectSource(id, event) {
    const currentIndex = snapshot.sourceOrder.indexOf(id)
    if (currentIndex === -1) return

    if (event.shiftKey && selectionAnchor && snapshot.sourceOrder.includes(selectionAnchor)) {
      const anchorIndex = snapshot.sourceOrder.indexOf(selectionAnchor)
      const start = Math.min(anchorIndex, currentIndex)
      const end = Math.max(anchorIndex, currentIndex)
      setSnapshot(prev => ({
        ...prev,
        selectedSourceIds: prev.sourceOrder.slice(start, end + 1),
      }))
      return
    }

    if (event.ctrlKey || event.metaKey) {
      setSnapshot(prev => ({
        ...prev,
        selectedSourceIds: prev.selectedSourceIds.includes(id)
          ? prev.selectedSourceIds.filter(value => value !== id)
          : [...prev.selectedSourceIds, id],
      }))
      setSelectionAnchor(id)
      return
    }

    setSnapshot(prev => ({
      ...prev,
      selectedSourceIds: [id],
    }))
    setSelectionAnchor(id)
  }

  function handleSelectNode(nodeId) {
    setContextMenu(null)
    if (bulkMoveMode) {
      setSnapshot(prev => ({ ...prev, selectedNodeId: nodeId }))
      return
    }
    setSnapshot(prev => ({ ...prev, selectedNodeId: nodeId }))
  }

  function toggleBulkChecked(node) {
    if (!bulkMoveMode) return
    if (node.parentId) {
      setSnapshot(prev => ({ ...prev, selectedNodeId: node.id }))
      setSelectedTreeCategoryIds(prev =>
        prev.includes(node.id) ? prev.filter(id => id !== node.id) : [...prev, node.id],
      )
      return
    }

    const childIds = (node.children || []).map(child => child.id)
    const allChecked = childIds.length > 0 && childIds.every(id => selectedTreeCategoryIds.includes(id))
    setSnapshot(prev => ({ ...prev, selectedNodeId: node.id }))
    setSelectedTreeCategoryIds(prev => {
      const base = prev.filter(id => !childIds.includes(id))
      return allChecked ? base : [...base, ...childIds]
    })
  }

  function toggleGroupCollapse(groupId) {
    setSnapshot(prev => ({
      ...prev,
      collapsedGroups: {
        ...prev.collapsedGroups,
        [groupId]: !prev.collapsedGroups[groupId],
      },
    }))
  }

  function handleRenameNode(nodeId, name) {
    applySnapshotChange(next => {
      const info = findNode(next.tree, nodeId)
      if (!info?.node) return
      info.node.name = name
    })
  }

  function getDragPayload(node) {
    const info = findNode(snapshot.tree, node.id)
    if (!info?.node) return null
    return {
      id: info.node.id,
      parentId: info.group ? info.group.id : null,
      isGroup: !info.group,
      categoryType: info.sectionType,
    }
  }

  function createSourceDragPayload(rawValue) {
    const sourceIds = snapshot.selectedSourceIds.includes(rawValue)
      ? [...snapshot.selectedSourceIds]
      : [rawValue]
    return {
      id: `source:${sourceIds[0]}`,
      isGroup: false,
      isSource: true,
      sourceIds,
    }
  }

  function applyAddSourceToGroup(sourceIds, groupId) {
    if (!groupId || !sourceIds?.length) return
    applySnapshotChange(next => {
      const info = findNode(next.tree, groupId)
      if (!info?.node || info.node.parentId) return
      const group = info.node
      for (const rawValue of sourceIds) {
        const childId = createTempId('category')
        group.children.push({
          id: childId,
          parentId: group.id,
          name: rawValue,
          categoryType: group.categoryType,
          isNew: true,
          importBadge: 'new',
        })
        next.mappings[rawValue] = {
          rawValue,
          targetId: childId,
          resolution: 'create',
        }
      }
      next.sourceOrder = next.sourceOrder.filter(value => !sourceIds.includes(value))
      next.selectedSourceIds = []
      next.selectedNodeId = group.id
    })
    setSelectionAnchor(null)
  }

  function applyMapSourceToCategory(sourceIds, categoryId) {
    if (!categoryId || !sourceIds?.length) return
    applySnapshotChange(next => {
      const info = findNode(next.tree, categoryId)
      if (!info?.node || !info.node.parentId) return
      info.node.importBadge = info.node.importBadge || 'mapped'
      for (const rawValue of sourceIds) {
        next.mappings[rawValue] = {
          rawValue,
          targetId: info.node.id,
          resolution: 'existing',
        }
      }
      next.sourceOrder = next.sourceOrder.filter(value => !sourceIds.includes(value))
      next.selectedSourceIds = []
      next.selectedNodeId = info.node.id
    })
    setSelectionAnchor(null)
  }

  function handleDropRow(dragged, targetNode, dropPosition = 'after') {
    if (!dragged?.id || !targetNode?.id || dragged.id === targetNode.id) return
    if (dragged.isSource) {
      const targetInfo = findNode(snapshot.tree, targetNode.id)
      if (!targetInfo?.node) return
      if (targetInfo.group) {
        if ((dragged.sourceIds || []).length > 1) {
          setPendingDropChoice({
            sourceIds: [...dragged.sourceIds],
            categoryId: targetInfo.node.id,
            groupId: targetInfo.group.id,
            targetName: targetInfo.node.name,
            groupName: targetInfo.group.name,
          })
          return
        }
        applyMapSourceToCategory(dragged.sourceIds, targetInfo.node.id)
        return
      }
      applyAddSourceToGroup(dragged.sourceIds, targetInfo.node.id)
      return
    }
    applySnapshotChange(next => {
      const targetInfo = findNode(next.tree, targetNode.id)
      if (!targetInfo?.node) return

      if (dragged.isGroup) {
        const sourceGroups = next.tree[dragged.categoryType] || []
        const sourceIndex = sourceGroups.findIndex(group => group.id === dragged.id)
        if (sourceIndex === -1) return

        const [movedGroup] = sourceGroups.splice(sourceIndex, 1)
        const targetGroup = targetInfo.group ? targetInfo.group : targetInfo.node
        const targetGroups = next.tree[targetInfo.sectionType] || []
        let insertIndex = targetGroups.findIndex(group => group.id === targetGroup.id)
        if (insertIndex === -1) {
          targetGroups.push(movedGroup)
        } else {
          if (dropPosition === 'after') insertIndex += 1
          targetGroups.splice(insertIndex, 0, movedGroup)
        }
        movedGroup.categoryType = targetInfo.sectionType
        movedGroup.children = movedGroup.children.map(child => ({
          ...child,
          parentId: movedGroup.id,
          categoryType: targetInfo.sectionType,
        }))
        next.selectedNodeId = movedGroup.id
        return
      }

      const sourceInfo = findNode(next.tree, dragged.id)
      if (!sourceInfo?.group) return
      const sourceChildren = sourceInfo.group.children || []
      const sourceIndex = sourceChildren.findIndex(child => child.id === dragged.id)
      if (sourceIndex === -1) return
      const [movedChild] = sourceChildren.splice(sourceIndex, 1)

      if (targetInfo.group) {
        const targetChildren = targetInfo.group.children || []
        let insertIndex = targetChildren.findIndex(child => child.id === targetInfo.node.id)
        if (insertIndex === -1) {
          targetChildren.push(movedChild)
        } else {
          if (dropPosition === 'after') insertIndex += 1
          targetChildren.splice(insertIndex, 0, movedChild)
        }
        movedChild.parentId = targetInfo.group.id
        movedChild.categoryType = targetInfo.sectionType
      } else {
        const targetChildren = targetInfo.node.children || []
        const insertIndex = dropPosition === 'before' ? 0 : targetChildren.length
        targetChildren.splice(insertIndex, 0, movedChild)
        movedChild.parentId = targetInfo.node.id
        movedChild.categoryType = targetInfo.sectionType
      }

      next.selectedNodeId = movedChild.id
    })
  }

  function handleExpandAll(target) {
    setSnapshot(prev => {
      const nextCollapsed = { ...prev.collapsedGroups }
      if (target.groupId) {
        nextCollapsed[target.groupId] = false
      } else {
        for (const group of prev.tree[target.sectionType] || []) nextCollapsed[group.id] = false
      }
      return { ...prev, collapsedGroups: nextCollapsed }
    })
    setContextMenu(null)
  }

  function handleCollapseAll(target) {
    setSnapshot(prev => {
      const nextCollapsed = { ...prev.collapsedGroups }
      if (target.groupId) {
        nextCollapsed[target.groupId] = true
      } else {
        for (const group of prev.tree[target.sectionType] || []) nextCollapsed[group.id] = true
      }
      return { ...prev, collapsedGroups: nextCollapsed }
    })
    setContextMenu(null)
  }

  function handleAlphabetize(target) {
    applySnapshotChange(next => {
      if (target.nodeId) {
        const info = findNode(next.tree, target.nodeId)
        const groupInfo = info?.group ? info.group : (info?.node && !info.node.parentId ? info.node : null)
        if (!groupInfo) return
        const targetInfo = findNode(next.tree, groupInfo.id)
        if (!targetInfo?.node || targetInfo.node.parentId) return
        targetInfo.node.children.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      } else if (target.groupId) {
        const info = findNode(next.tree, target.groupId)
        if (!info?.node || info.node.parentId) return
        info.node.children.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      } else {
        next.tree[target.sectionType].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      }
    })
    setContextMenu(null)
  }

  function startBulkMove(target) {
    setContextMenu(null)
    setBulkMoveMode(true)
    if (target.groupId) {
      setSnapshot(prev => ({ ...prev, selectedNodeId: target.groupId }))
    }
    setSelectedTreeCategoryIds([])
  }

  function cancelBulkMove() {
    setContextMenu(null)
    setBulkMoveMode(false)
    setSelectedTreeCategoryIds([])
  }

  function moveSelectedCategoriesHere(target) {
    if (!target.groupId || selectedTreeCategoryIds.length === 0) return
    applySnapshotChange(next => {
      const orderedIds = orderedTreeCategoryIds().filter(id => selectedTreeCategoryIds.includes(id))
      const movedChildren = []
      for (const sectionType of ['income', 'expense']) {
        for (const group of next.tree[sectionType]) {
          const kept = []
          for (const child of group.children) {
            if (orderedIds.includes(child.id)) movedChildren.push(child)
            else kept.push(child)
          }
          group.children = kept
        }
      }

      const targetInfo = findNode(next.tree, target.groupId)
      if (!targetInfo?.node || targetInfo.node.parentId) return
      const destination = targetInfo.node
      for (const child of movedChildren) {
        child.parentId = destination.id
        child.categoryType = destination.categoryType
        destination.children.push(child)
      }
      next.selectedNodeId = destination.id
    })
    setSelectedTreeCategoryIds([])
    setBulkMoveMode(false)
    setContextMenu(null)
  }

  function handleCreateGroup(target = null) {
    const insertion = resolveGroupInsertionTarget(target)
    const newGroupId = createTempId('group')
    applySnapshotChange(next => {
      const group = {
        id: newGroupId,
        name: 'New Group',
        categoryType: insertion.sectionType,
        isNew: true,
        importBadge: null,
        children: [],
      }
      const groups = next.tree[insertion.sectionType]
      const insertIndex = insertion.groupId
        ? Math.max(0, groups.findIndex(existing => existing.id === insertion.groupId) + 1)
        : groups.length
      groups.splice(insertIndex, 0, group)
      next.selectedNodeId = group.id
    })
    setAutoEditNodeId(newGroupId)
    setAutoEditToken(prev => prev + 1)
    setContextMenu(null)
  }

  function handleCreateCategory(target = null) {
    const insertion = resolveCategoryTarget(target)
    if (!insertion.groupId) return
    const newCategoryId = createTempId('category')
    applySnapshotChange(next => {
      const info = findNode(next.tree, insertion.groupId)
      if (!info?.node || info.node.parentId) return
      const group = info.node
      group.children.push({
        id: newCategoryId,
        parentId: group.id,
        name: 'New Category',
        categoryType: group.categoryType,
        isNew: true,
        importBadge: 'new',
      })
      next.selectedNodeId = newCategoryId
    })
    setAutoEditNodeId(newCategoryId)
    setAutoEditToken(prev => prev + 1)
    setContextMenu(null)
  }

  function handleAddToGroup() {
    if (!canAddToGroup || !selectedGroup) return
    applyAddSourceToGroup(snapshot.selectedSourceIds, selectedGroup.id)
    setContextMenu(null)
  }

  function handleMapToCategory() {
    if (!canMapToCategory || !selectedNode) return
    applyMapSourceToCategory(snapshot.selectedSourceIds, selectedNode.id)
    setContextMenu(null)
  }

  function handleUndo() {
    if (undoStack.length === 0) return
    const previous = undoStack[undoStack.length - 1]
    setRedoStack(prev => [...prev, cloneImportCategoryMappingSnapshot(snapshot)])
    setUndoStack(prev => prev.slice(0, -1))
    setSnapshot(cloneImportCategoryMappingSnapshot(previous))
  }

  function handleRedo() {
    if (redoStack.length === 0) return
    const nextState = redoStack[redoStack.length - 1]
    setUndoStack(prev => [...prev, cloneImportCategoryMappingSnapshot(snapshot)])
    setRedoStack(prev => prev.slice(0, -1))
    setSnapshot(cloneImportCategoryMappingSnapshot(nextState))
  }

  function handleClearAll() {
    applySnapshotChange(next => {
      next.tree = { income: [], expense: [] }
      next.sourceOrder = (sourceValues || []).filter(Boolean).slice().sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      next.mappings = {}
      next.selectedNodeId = null
      next.selectedSourceIds = []
      next.collapsedGroups = {}
    })
    setSelectionAnchor(null)
    setContextMenu(null)
  }

  function handleClearAllCategories() {
    applySnapshotChange(next => {
      const restoreValues = []
      const removedIds = new Set()

      for (const sectionType of ['income', 'expense']) {
        for (const group of next.tree[sectionType]) {
          for (const child of group.children) {
            removedIds.add(child.id)
          }
          group.children = []
        }
      }

      for (const [rawValue, mapping] of Object.entries(next.mappings)) {
        if (removedIds.has(mapping.targetId)) {
          restoreValues.push(rawValue)
          delete next.mappings[rawValue]
        }
      }

      if (restoreValues.length > 0) {
        const merged = [...next.sourceOrder]
        restoreValues
          .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
          .forEach(value => {
            if (!merged.includes(value)) merged.push(value)
          })
        next.sourceOrder = merged.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      }

      if (next.selectedNodeId && removedIds.has(next.selectedNodeId)) {
        next.selectedNodeId = null
      }
    })
    setSelectionAnchor(null)
    setContextMenu(null)
  }

  function handleClearSourceSelection() {
    setSnapshot(prev => ({ ...prev, selectedSourceIds: [] }))
    setSelectionAnchor(null)
  }

  function handleDeleteNode(target) {
    if (!target?.nodeId || !target.canDelete) return
    applySnapshotChange(next => {
      const restoreValues = []
      for (const sectionType of ['income', 'expense']) {
        const groups = next.tree[sectionType]
        const groupIndex = groups.findIndex(group => group.id === target.nodeId)
        if (groupIndex >= 0) {
          const [removedGroup] = groups.splice(groupIndex, 1)
          const removedIds = new Set([removedGroup.id, ...(removedGroup.children || []).map(child => child.id)])
          for (const [rawValue, mapping] of Object.entries(next.mappings)) {
            if (removedIds.has(mapping.targetId)) {
              restoreValues.push(rawValue)
              delete next.mappings[rawValue]
            }
          }
          break
        }
        for (const group of groups) {
          const childIndex = group.children.findIndex(child => child.id === target.nodeId)
          if (childIndex >= 0) {
            const [removedChild] = group.children.splice(childIndex, 1)
            for (const [rawValue, mapping] of Object.entries(next.mappings)) {
              if (mapping.targetId === removedChild.id) {
                restoreValues.push(rawValue)
                delete next.mappings[rawValue]
              }
            }
            break
          }
        }
      }
      if (restoreValues.length > 0) {
        const merged = [...next.sourceOrder]
        restoreValues
          .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
          .forEach(value => {
            if (!merged.includes(value)) merged.push(value)
          })
        next.sourceOrder = merged.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      }
      next.selectedNodeId = null
    })
    setContextMenu(null)
  }

  function openContextMenu(e, node = null, sectionTypeOverride = null) {
    e.preventDefault()
    e.stopPropagation()
    const info = node ? findNode(snapshot.tree, node.id) : null
    const sectionType = sectionTypeOverride || info?.sectionType || node?.categoryType || 'expense'
    const groupId = info?.group ? info.group.id : (node && !node.parentId ? node.id : null)
    const usageSummary = node ? getUsageSummaryForNode(node) : null
    if (node?.id) {
      setSnapshot(prev => ({ ...prev, selectedNodeId: node.id }))
    }
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      sectionType,
      groupId,
      nodeId: node?.id || null,
      canDelete: !!node,
      removeInUse: !!usageSummary?.is_in_use,
    })
  }

  async function handleSave() {
    setSaving(true)
    try {
      await onApply(cloneImportCategoryMappingSnapshot(snapshot))
    } finally {
      setSaving(false)
    }
  }

  function handleSourceDragStart(rawValue, event) {
    const sourceIds = snapshot.selectedSourceIds.includes(rawValue)
      ? [...snapshot.selectedSourceIds]
      : [rawValue]
    if (!snapshot.selectedSourceIds.includes(rawValue)) {
      setSnapshot(prev => ({ ...prev, selectedSourceIds: [rawValue] }))
      setSelectionAnchor(rawValue)
    }
    setCategoryTreeDragItem(createSourceDragPayload(rawValue))
    event.dataTransfer.effectAllowed = 'move'
  }

  function handleSourceDragEnd() {
    clearCategoryTreeDragItem()
  }

  function handlePendingDropChoice(mode) {
    if (!pendingDropChoice) return
    if (mode === 'group') applyAddSourceToGroup(pendingDropChoice.sourceIds, pendingDropChoice.groupId)
    else applyMapSourceToCategory(pendingDropChoice.sourceIds, pendingDropChoice.categoryId)
    setPendingDropChoice(null)
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1100,
        background: 'rgba(15, 23, 42, 0.44)',
        padding: 20,
        display: 'flex',
        alignItems: 'stretch',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          width: 'min(1220px, 100%)',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 16,
          boxShadow: '0 28px 80px rgba(15, 23, 42, 0.24)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: '18px 22px 12px', borderBottom: '1px solid var(--border)', background: 'linear-gradient(to bottom, var(--surface), color-mix(in srgb, var(--surface2) 65%, var(--surface)))' }}>
          <div style={{ display: 'flex', alignItems: 'start', justifyContent: 'space-between', gap: 16 }}>
            <div>
              <div style={{ fontSize: 19, fontWeight: 600, marginBottom: 6 }}>Map Categories</div>
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                Place file categories into the tree by adding them to groups or mapping them to existing categories.
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                {processedCount} of {totalSourceCount} prepared
              </div>
              <Button variant="ghost" onClick={onClose}>Back</Button>
              <Button onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save & Continue Import'}
              </Button>
            </div>
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '320px 1fr', gap: 0 }}>
          <div style={{ borderRight: '1px solid var(--border)', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 4 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>Categories From File</div>
                {snapshot.selectedSourceIds.length > 0 ? (
                  <button
                    type="button"
                    onClick={handleClearSourceSelection}
                    style={{
                      background: 'none',
                      border: '1px solid var(--border)',
                      borderRadius: 999,
                      padding: '3px 8px',
                      fontSize: 11,
                      color: 'var(--muted)',
                      cursor: 'pointer',
                    }}
                  >
                    clear selection
                  </button>
                ) : null}
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                Select one or more categories, then choose where they belong.
              </div>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: 'var(--surface)' }}>
              {snapshot.sourceOrder.length === 0 ? (
                <div style={{ padding: '20px 16px', fontSize: 13, color: 'var(--muted)' }}>
                  All file categories in this list have been processed for now.
                </div>
              ) : (
                <div
                  style={{
                    padding: '12px',
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignContent: 'flex-start',
                    gap: 8,
                  }}
                >
                  {snapshot.sourceOrder.map((rawValue, index) => {
                    const selected = snapshot.selectedSourceIds.includes(rawValue)
                    const isRangeEdge = selectionAnchor && snapshot.selectedSourceIds.length > 1 && (
                      index === snapshot.sourceOrder.indexOf(snapshot.selectedSourceIds[0]) ||
                      index === findLastIndex(snapshot.sourceOrder, value => snapshot.selectedSourceIds.includes(value))
                    )
                    return (
                      <button
                        key={rawValue}
                        type="button"
                        onClick={event => handleSelectSource(rawValue, event)}
                        draggable
                        onDragStart={event => handleSourceDragStart(rawValue, event)}
                        onDragEnd={handleSourceDragEnd}
                        style={{
                          border: 'none',
                          background: 'transparent',
                          color: 'var(--text)',
                          textAlign: 'left',
                          padding: 0,
                          cursor: 'pointer',
                          outline: 'none',
                        }}
                      >
                        <span style={{ boxShadow: isRangeEdge ? '0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent)' : 'none', borderRadius: 999, display: 'inline-flex' }}>
                          {sourceChip(rawValue, selected)}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          <div style={{ minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>Your Category Tree</div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                  The tree uses the same row language as the Categories page, but changes here stay in draft form until saved.
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button variant="ghost" onClick={handleUndo} disabled={undoStack.length === 0}>Undo</Button>
                <Button variant="ghost" onClick={handleRedo} disabled={redoStack.length === 0}>Redo</Button>
                <Button variant="ghost" onClick={handleClearAllCategories}>Clear All Categories</Button>
                <Button variant="ghost" onClick={handleClearAll}>Clear All</Button>
                <Button variant="ghost" onClick={() => handleCreateGroup()}>New Group</Button>
                <Button variant="ghost" onClick={() => handleCreateCategory()} disabled={!resolveCategoryTarget().groupId}>Add Category</Button>
                <Button variant="ghost" onClick={handleAddToGroup} disabled={!canAddToGroup}>Add To Group</Button>
                <Button variant="ghost" onClick={handleMapToCategory} disabled={!canMapToCategory}>Map To Category</Button>
              </div>
            </div>

            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: 'var(--surface)' }}>
              {['income', 'expense'].map(sectionType => {
                const sectionGroups = snapshot.tree[sectionType] || []
                return (
                  <div key={sectionType} style={{ borderBottom: sectionType === 'income' ? '1px solid var(--border)' : 'none' }}>
                    <div
                      onContextMenu={e => openContextMenu(e, null, sectionType)}
                      style={{ padding: '6px 11px 5px', background: 'color-mix(in srgb, var(--surface2) 70%, transparent)', borderBottom: '1px solid var(--border)' }}
                    >
                      <div style={{ fontSize: 14, fontWeight: 700 }}>
                        {sectionType === 'income' ? 'Income' : 'Expense'}
                      </div>
                    </div>
                    {sectionGroups.length === 0 ? (
                      <div style={{ padding: '12px', fontSize: 12, color: 'var(--muted)' }}>
                        No {sectionType} groups yet.
                      </div>
                    ) : sectionGroups.map(group => {
                      const collapsed = !!snapshot.collapsedGroups[group.id]
                      return (
                        <div key={group.id}>
                          <CategoryTreeRow
                            cat={group}
                            isChild={false}
                            isSelected={snapshot.selectedNodeId === group.id}
                            draggable={true}
                            bulkMoveMode={bulkMoveMode}
                            bulkChecked={(group.children || []).length > 0 && (group.children || []).every(child => selectedTreeCategoryIds.includes(child.id))}
                            showDelete={false}
                            canCollapse={group.children.length > 0}
                            isCollapsed={collapsed}
                            onToggleCollapse={toggleGroupCollapse}
                            onSelect={() => handleSelectNode(group.id)}
                            onRename={handleRenameNode}
                            onDelete={() => {}}
                            onToggleBulkChecked={toggleBulkChecked}
                            onDropRow={handleDropRow}
                            onDragStartRow={getDragPayload}
                            onOpenContextMenu={openContextMenu}
                            autoEditToken={autoEditNodeId === group.id ? autoEditToken : 0}
                            autoEditPlaceholder={autoEditNodeId === group.id ? 'Group name' : ''}
                            onAutoEditConsumed={() => {
                              if (autoEditNodeId === group.id) setAutoEditNodeId(null)
                            }}
                            trailingContent={group.importBadge === 'mapped' ? statusPill('mapped', 'mapped') : null}
                          />
                          {!collapsed ? group.children.map(child => (
                            <CategoryTreeRow
                              key={child.id}
                              cat={child}
                              isChild={true}
                              isSelected={bulkMoveMode ? selectedTreeCategoryIds.includes(child.id) : snapshot.selectedNodeId === child.id}
                              draggable={true}
                              bulkMoveMode={bulkMoveMode}
                              bulkChecked={selectedTreeCategoryIds.includes(child.id)}
                              showDelete={false}
                              onSelect={() => handleSelectNode(child.id)}
                              onRename={handleRenameNode}
                              onDelete={() => {}}
                              onToggleBulkChecked={toggleBulkChecked}
                              onDropRow={handleDropRow}
                              onDragStartRow={getDragPayload}
                              onOpenContextMenu={openContextMenu}
                              autoEditToken={autoEditNodeId === child.id ? autoEditToken : 0}
                              autoEditPlaceholder={autoEditNodeId === child.id ? 'category name' : ''}
                              onAutoEditConsumed={() => {
                                if (autoEditNodeId === child.id) setAutoEditNodeId(null)
                              }}
                              trailingContent={child.importBadge === 'new'
                                ? statusPill('new', 'new')
                                : child.importBadge === 'mapped'
                                  ? statusPill('mapped', 'mapped')
                                  : null}
                            />
                          )) : null}
                        </div>
                      )
                    })}
                  </div>
                )
              })}
            </div>

            <div style={{ borderTop: '1px solid var(--border)', padding: '10px 14px', background: 'var(--surface2)', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
                <CategoryMarker kind="category" />
                Drop-in behavior for this first pass is explicit: select on the left, then add or map on the right.
              </div>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                {statusPill('new', 'new')}
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>created from file category</span>
              </div>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                {statusPill('mapped', 'mapped')}
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>mapped to existing category</span>
              </div>
            </div>
          </div>
        </div>
      </div>
      {contextMenu ? (
        <MappingContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          target={contextMenu}
          bulkMoveMode={bulkMoveMode}
          canMoveHere={!!contextMenu.groupId && selectedTreeCategoryIds.length > 0}
          onAddCategory={handleCreateCategory}
          onAddGroup={handleCreateGroup}
          onExpandAll={handleExpandAll}
          onCollapseAll={handleCollapseAll}
          onAlphabetize={handleAlphabetize}
          onStartBulkMove={startBulkMove}
          onMoveHere={moveSelectedCategoriesHere}
          onCancelBulkMove={cancelBulkMove}
          onDelete={handleDeleteNode}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
      <MultiDropChoiceDialog
        choice={pendingDropChoice}
        onChoose={handlePendingDropChoice}
        onCancel={() => setPendingDropChoice(null)}
      />
    </div>
  )
}
