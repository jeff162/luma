// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- re-exports the draft-state factory so callers can import both component + helper from one place */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Button } from './ui.jsx'
import TransientTextInput from './TransientTextInput.jsx'
import { api } from '../lib/api.js'
import {
  getSharedPillCornerRemoveButtonStyle,
  getSharedPillLabelStyle,
  getSharedPillStyle,
} from './pillStyles.js'
import {
  clearCategoryTreeDragItem,
  getCategoryTreeDragItem,
  setCategoryTreeDragItem,
} from './CategoryTreePrimitives.jsx'
import {
  cloneCategoryImportSnapshot,
  createCategoryImportDraftState,
  reconcileSnapshotGroupsWithCategories,
} from '../lib/categoryImportState.js'
import { ESCAPE_BEHAVIOR, useDismissibleLayer, useEscapeAction } from '../lib/uiInteractions.js'

export { createCategoryImportDraftState }

const DEFAULT_LEFT_PANEL_WIDTH = 320
const MIN_LEFT_PANEL_WIDTH = 280
const MIN_RIGHT_PANEL_WIDTH = 360
const GROUP_COLUMN_WIDTH = 300
const GROUP_COLUMN_GAP = 18
const GROUP_CARD_GAP = 16

function estimateGroupCardHeight(group, collapsed) {
  if (collapsed) return 58
  const childCount = group.children?.length || 0
  if (!childCount) return 132
  const estimatedRows = Math.max(1, Math.ceil(childCount / 2))
  return 52 + (estimatedRows * 34) + 18
}

function buildGroupColumns(groups, collapsedGroups, availableHeight, measuredGroupHeights = {}) {
  if (!groups?.length) return []
  // Balance the right pane into measured columns so large imports stay scannable without pushing drag targets far below the fold.
  const targetHeight = Math.max(320, availableHeight || 720)
  const columns = []
  let currentColumn = []
  let currentHeight = 0

  for (const group of groups) {
    const estimatedHeight = measuredGroupHeights[group.id] ?? estimateGroupCardHeight(group, !!collapsedGroups?.[group.id])
    const nextHeight = currentColumn.length > 0
      ? currentHeight + GROUP_CARD_GAP + estimatedHeight
      : estimatedHeight
    if (currentColumn.length > 0 && nextHeight > targetHeight) {
      columns.push(currentColumn)
      currentColumn = [group]
      currentHeight = estimatedHeight
    } else {
      currentColumn.push(group)
      currentHeight = nextHeight
    }
  }

  if (currentColumn.length > 0) columns.push(currentColumn)
  return columns
}

function createTempId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

function clampOverlayPosition(x, y, width, height, padding = 12) {
  if (typeof window === 'undefined') return { x, y }
  const maxX = Math.max(padding, window.innerWidth - width - padding)
  const maxY = Math.max(padding, window.innerHeight - height - padding)
  return {
    x: Math.min(Math.max(x, padding), maxX),
    y: Math.min(Math.max(y, padding), maxY),
  }
}

function autoScrollContainer(container, clientY, threshold = 48, maxStep = 22) {
  if (!container) return
  const rect = container.getBoundingClientRect()
  if (clientY < rect.top || clientY > rect.bottom) return

  let delta = 0
  if (clientY < rect.top + threshold) {
    const intensity = 1 - ((clientY - rect.top) / threshold)
    delta = -Math.ceil(maxStep * intensity)
  } else if (clientY > rect.bottom - threshold) {
    const intensity = 1 - ((rect.bottom - clientY) / threshold)
    delta = Math.ceil(maxStep * intensity)
  }

  if (delta) container.scrollTop += delta
}

function findNode(tree, nodeId) {
  for (const sectionType of ['income', 'expense']) {
    for (const group of tree[sectionType] || []) {
      if (group.id === nodeId) return { node: group, group: null, sectionType }
      for (const child of group.children || []) {
        if (child.id === nodeId) return { node: child, group, sectionType }
      }
    }
  }
  return null
}

function sortSection(tree, sectionType) {
  tree[sectionType] = (tree[sectionType] || [])
    .map(group => ({
      ...group,
      children: (group.children || [])
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

function sanitizeSnapshot(snapshot, sourceValues) {
  // Drafts can outlive truncated previews or later source changes, so strip stale claims and return orphaned values to the inbox.
  const next = cloneCategoryImportSnapshot(snapshot)
  const validSourceValues = new Set((sourceValues || []).filter(Boolean))
  const claimed = new Set()

  for (const sectionType of ['income', 'expense']) {
    next.tree[sectionType] = (next.tree[sectionType] || [])
      .map(group => ({
        ...group,
        name: String(group.name || '').trim(),
        children: (group.children || [])
          .filter(child => {
            const sourceValue = String(child?.sourceValue || child?.name || '').trim()
            if (!sourceValue || !validSourceValues.has(sourceValue) || claimed.has(sourceValue)) return false
            claimed.add(sourceValue)
            return true
          })
          .map(child => ({
            ...child,
            name: String(child.name || child.sourceValue || '').trim(),
            sourceValue: String(child.sourceValue || child.name || '').trim(),
            imported: !!child.imported,
          })),
      }))
    sortSection(next.tree, sectionType)
  }

  const remaining = (sourceValues || []).filter(value => !claimed.has(value))
  const remainingSet = new Set(remaining)

  next.sourceOrder = (next.sourceOrder || []).filter(value => remainingSet.has(value))
  next.setAsideOrder = (next.setAsideOrder || []).filter(value => remainingSet.has(value))
  for (const value of remaining) {
    if (!next.sourceOrder.includes(value) && !next.setAsideOrder.includes(value)) {
      next.sourceOrder.push(value)
    }
  }
  next.sourceOrder.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  next.setAsideOrder.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  next.selectedSourceIds = (next.selectedSourceIds || []).filter(value => remainingSet.has(value))
  if (next.selectedNodeId && !findNode(next.tree, next.selectedNodeId)) next.selectedNodeId = null
  return next
}

function snapshotsMatch(left, right) {
  return JSON.stringify(left || null) === JSON.stringify(right || null)
}

function pillNoDragZone() {
  return (
    <span
      data-pill-no-drag="true"
      style={{
        width: 0,
        alignSelf: 'stretch',
        marginLeft: -6,
        marginRight: -2,
        cursor: 'default',
        flexShrink: 0,
      }}
    />
  )
}

function SourceChip({ label, selected, grouped = false, groupCount = 0, showCount = false }) {
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <span style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 10px',
        borderRadius: 999,
        border: `1px dashed ${selected ? 'color-mix(in srgb, white 74%, var(--accent))' : 'color-mix(in srgb, var(--accent) 28%, var(--border))'}`,
        background: selected
          ? 'linear-gradient(180deg, color-mix(in srgb, #7c83ff 28%, var(--surface)), color-mix(in srgb, #7c83ff 18%, var(--surface)))'
          : 'linear-gradient(180deg, color-mix(in srgb, var(--surface2) 92%, var(--surface)), color-mix(in srgb, var(--surface2) 68%, var(--surface)))',
        boxShadow: selected
          ? '0 0 0 2px color-mix(in srgb, white 12%, transparent), 0 10px 22px rgba(15, 23, 42, 0.22)'
          : '0 5px 16px rgba(15, 23, 42, 0.08)',
        transform: selected ? 'translateY(-1px) scale(1.035)' : 'none',
        transformOrigin: 'center',
        outline: grouped ? '2px dashed color-mix(in srgb, var(--accent) 42%, var(--border))' : 'none',
        outlineOffset: grouped ? 2 : 0,
        userSelect: 'none',
      }}>
        {pillNoDragZone()}
        <span title={label} style={{ fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap', color: 'var(--text)', fontStyle: 'italic' }}>{label}</span>
      </span>
      {showCount && groupCount > 1 ? (
        <span style={{
          position: 'absolute',
          left: -8,
          top: -10,
          minWidth: 20,
          height: 20,
          borderRadius: 999,
          display: 'grid',
          placeItems: 'center',
          padding: '0 6px',
          background: 'var(--accent)',
          color: '#fff',
          fontSize: 11,
          fontWeight: 700,
          border: '1px solid color-mix(in srgb, white 18%, var(--accent))',
          boxShadow: '0 8px 18px rgba(15, 23, 42, 0.24)',
        }}>{groupCount}</span>
      ) : null}
    </span>
  )
}

function SetAsideTray({ count, selected, collapsed, onToggle, onDrop, onContextMenu, children }) {
  return (
    <div
      style={{
        marginTop: 12,
        borderRadius: 16,
        border: selected
          ? '1px solid color-mix(in srgb, var(--accent) 28%, var(--border))'
          : '1px solid var(--border)',
        background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface2) 70%, var(--surface)), color-mix(in srgb, var(--surface) 88%, black))',
        boxShadow: '0 10px 24px rgba(15, 23, 42, 0.16)',
        overflow: 'hidden',
      }}
    >
      <div
        onContextMenu={onContextMenu}
        style={{
          padding: '10px 11px 9px',
          borderBottom: collapsed ? 'none' : '1px solid color-mix(in srgb, var(--border) 78%, transparent)',
          background: selected ? 'color-mix(in srgb, var(--accent) 10%, var(--surface))' : 'linear-gradient(180deg, color-mix(in srgb, var(--surface2) 86%, var(--surface)), color-mix(in srgb, var(--surface2) 62%, var(--surface)))',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              onClick={event => {
                event.stopPropagation()
                onToggle()
              }}
              style={{ width: 20, height: 20, borderRadius: 6, border: '1px solid var(--border)', background: 'color-mix(in srgb, var(--surface2) 70%, var(--surface))', color: 'var(--muted)', cursor: 'pointer' }}
            >
              {collapsed ? '+' : '-'}
            </button>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>Set Aside</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ borderRadius: 999, border: '1px solid var(--border)', padding: '2px 8px', fontSize: 10, fontWeight: 700, color: 'var(--muted)', minWidth: 22, textAlign: 'center' }}>{count}</span>
        </div>
      </div>
      {!collapsed ? (
        <div
          onDragOver={event => {
            const item = getCategoryTreeDragItem()
            if (!item?.isSource) return
            event.preventDefault()
          }}
          onDrop={onDrop}
          onContextMenu={onContextMenu}
          style={{ padding: '10px', minHeight: 72, overflow: 'hidden' }}
        >
          {children}
        </div>
      ) : null}
    </div>
  )
}

function GroupCard({
  group,
  collapsed,
  showPreviouslyImportedBadge,
  selectedNodeId,
  selectedChildIds,
  dragChildIds,
  dragLeadId,
  editingId,
  editingValue,
  setEditingId,
  setEditingValue,
  commitEdit,
  onToggleCollapse,
  onRemoveGroup,
  onRemoveChild,
  onDeleteImportedChild,
  onDropGroup,
  onChildDragStart,
  onChildDragEnd,
  onSelectChild,
  onContextMenu,
}) {
  const activeChildren = group.children.filter(child => !child.imported)
  const importedChildren = group.children.filter(child => child.imported)
  const renderedChildren = showPreviouslyImportedBadge ? [...activeChildren, ...importedChildren] : group.children

  return (
    <div
      data-group-card="true"
      data-group-id={group.id}
      onContextMenu={onContextMenu}
      onDragOver={event => event.preventDefault()}
      onDrop={event => {
        event.preventDefault()
        onDropGroup(group.id)
      }}
      style={{ breakInside: 'avoid', WebkitColumnBreakInside: 'avoid', pageBreakInside: 'avoid', display: 'inline-block', width: '100%', borderRadius: 16, border: selectedNodeId === group.id ? '1px solid color-mix(in srgb, var(--accent) 28%, var(--border))' : '1px solid var(--border)', background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface2) 70%, var(--surface)), color-mix(in srgb, var(--surface) 88%, black))', boxShadow: '0 10px 24px rgba(15, 23, 42, 0.16)', overflow: 'hidden' }}
    >
      <div style={{ padding: '8px 10px 8px', borderBottom: collapsed ? 'none' : '1px solid color-mix(in srgb, var(--border) 78%, transparent)', background: selectedNodeId === group.id ? 'color-mix(in srgb, var(--accent) 10%, var(--surface))' : 'linear-gradient(180deg, color-mix(in srgb, var(--surface2) 86%, var(--surface)), color-mix(in srgb, var(--surface2) 62%, var(--surface)))', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 7 }}>
        <div style={{ minWidth: 0, flex: 1, display: 'flex', alignItems: 'center', gap: 7 }}>
          <button
            type="button"
            onClick={() => onToggleCollapse(group.id)}
            style={{
              border: '1px solid color-mix(in srgb, var(--border) 82%, transparent)',
              background: 'color-mix(in srgb, var(--surface) 80%, transparent)',
              color: 'var(--muted)',
              borderRadius: 999,
              width: 20,
              height: 20,
              padding: 0,
              fontSize: 10.5,
              lineHeight: 1,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              flexShrink: 0,
            }}
            title={collapsed ? 'Expand group' : 'Collapse group'}
          >
            {collapsed ? '▸' : '▾'}
          </button>
          {editingId === group.id ? (
            <TransientTextInput
              placeholder="Group name"
              value={editingValue}
              onChange={setEditingValue}
              onCommit={commitEdit}
              onCancel={() => {
                setEditingId(null)
                setEditingValue('')
              }}
              style={{ background: 'var(--bg)', color: 'var(--text)', border: '1px solid color-mix(in srgb, var(--accent) 55%, var(--border))', borderRadius: 8, padding: '4px 8px', fontSize: 14, fontWeight: 650, outline: 'none', width: '100%' }}
            />
          ) : (
            <div onClick={() => { setEditingId(group.id); setEditingValue(group.name || '') }} style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 7, fontSize: 13.5, fontWeight: 650, color: 'color-mix(in srgb, var(--text) 88%, var(--muted))', cursor: 'text' }}>
              <span title={group.name} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{group.name}</span>
              {collapsed ? (
                <span style={{
                  flexShrink: 0,
                  minWidth: 20,
                  height: 20,
                  borderRadius: 999,
                  border: '1px solid color-mix(in srgb, var(--accent) 30%, var(--border))',
                  background: 'linear-gradient(180deg, color-mix(in srgb, var(--accent) 16%, var(--surface2)), color-mix(in srgb, var(--accent) 8%, var(--surface)))',
                  color: 'var(--accent2)',
                  fontSize: 10,
                  fontWeight: 700,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 4px 10px rgba(15, 23, 42, 0.14), inset 0 0 0 1px color-mix(in srgb, white 10%, transparent)',
              }}>
                  {group.children.length}
                </span>
              ) : null}
            </div>
          )}
        </div>
        <button onClick={() => onRemoveGroup(group.id)} style={{ border: '1px solid color-mix(in srgb, var(--muted) 42%, var(--border))', background: 'color-mix(in srgb, var(--surface) 82%, transparent)', color: 'var(--muted)', borderRadius: 999, width: 19, height: 19, padding: 0, fontSize: 11.5, fontWeight: 700, lineHeight: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>×</button>
      </div>
      {!collapsed ? (
      <div style={{ padding: '10px', minHeight: 86 }}>
        {renderedChildren.length === 0 ? (
          <div style={{ minHeight: 72, borderRadius: 14, border: '1px dashed color-mix(in srgb, var(--border) 85%, transparent)', background: 'color-mix(in srgb, var(--surface2) 58%, var(--surface))', display: 'grid', placeItems: 'center', textAlign: 'center', padding: 12, fontSize: 12, color: 'var(--muted)' }}>&lt;drop file categories here&gt;</div>
        ) : (
          <>
            {showPreviouslyImportedBadge && activeChildren.length === 0 && importedChildren.length > 0 ? (
              <div
                style={{
                  display: 'grid',
                  placeItems: 'center',
                  minHeight: 34,
                  marginBottom: 10,
                  color: 'var(--muted)',
                  fontSize: 12,
                }}
              >
                <span>
                  &lt;<span style={{ fontStyle: 'italic' }}>empty</span>&gt;
                </span>
              </div>
            ) : null}
            {renderedChildren.map((child, index) => (
              <div key={child.id} style={{ display: 'inline' }}>
                {showPreviouslyImportedBadge && importedChildren.length > 0 && index === activeChildren.length ? (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      margin: '2px 0 10px',
                      width: '100%',
                      clear: 'both',
                    }}
                  >
                    <span style={{ flex: 1, height: 1, background: 'color-mix(in srgb, var(--border) 72%, transparent)' }} />
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        height: 16,
                        padding: '0 7px',
                        borderRadius: 999,
                        border: '1px solid color-mix(in srgb, var(--accent) 24%, var(--border))',
                        background: 'color-mix(in srgb, var(--accent) 8%, var(--surface))',
                        color: 'var(--muted)',
                        fontSize: 9,
                        fontWeight: 700,
                        letterSpacing: 0.08,
                        lineHeight: 1,
                        textTransform: 'lowercase',
                      }}
                    >
                      previously imported
                    </span>
                    <span style={{ flex: 1, height: 1, background: 'color-mix(in srgb, var(--border) 72%, transparent)' }} />
                  </div>
                ) : null}
                <div
                  draggable={!child.imported}
                  onClick={event => {
                    onSelectChild(child.id, group.id, event)
                  }}
                  onDragOver={event => event.preventDefault()}
                  onDrop={event => {
                    event.preventDefault()
                    onDropGroup(group.id)
                  }}
                  onDragStart={event => {
                    if (child.imported) {
                      event.preventDefault()
                      return
                    }
                    onChildDragStart(child.id, event)
                  }}
                  onDragEnd={() => {
                    if (child.imported) return
                    onChildDragEnd()
                  }}
                  style={{
                    position: 'relative',
                    ...getSharedPillStyle({ tone: selectedChildIds.includes(child.id) ? 'selected' : 'default' }),
                    outline: dragChildIds.includes(child.id) ? '2px dashed color-mix(in srgb, var(--accent) 42%, var(--border))' : 'none',
                    outlineOffset: dragChildIds.includes(child.id) ? 2 : 0,
                    marginRight: 8,
                    marginBottom: 8,
                    cursor: child.imported ? 'pointer' : 'pointer',
                    opacity: child.imported ? 0.9 : 1,
                    display: 'inline-flex',
                  }}
                >
                  {dragChildIds.includes(child.id) && dragLeadId === child.id ? (
                    <span style={{
                      position: 'absolute',
                      left: -8,
                      top: -10,
                      minWidth: 20,
                      height: 20,
                      borderRadius: 999,
                      display: 'grid',
                      placeItems: 'center',
                      padding: '0 6px',
                      background: 'var(--accent)',
                      color: '#fff',
                      fontSize: 11,
                      fontWeight: 700,
                      border: '1px solid color-mix(in srgb, white 18%, var(--accent))',
                      boxShadow: '0 8px 18px rgba(15, 23, 42, 0.24)',
                    }}>{dragChildIds.length}</span>
                  ) : null}
                  <span title={child.name} style={{ ...getSharedPillLabelStyle({ italic: true }), display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span>{child.name}</span>
                  </span>
                  <button
                    onClick={() => {
                      if (child.imported) onDeleteImportedChild(group, child)
                      else onRemoveChild(child.id)
                    }}
                    style={getSharedPillCornerRemoveButtonStyle()}
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </>
        )}
      </div>
      ) : null}
    </div>
  )
}

export default function CategoryImportWorkspace({
  sourceValues,
  parkedSourceValues = [],
  sourceMeta,
  existingCategories = [],
  initialDraftState,
  onDraftStateChange,
  onApply,
  onClose,
  onCategoriesChanged,
  onDeleteSources,
  title = 'Import Categories From File',
  description = 'Organize the categories from the imported data into groups.',
  sourceHeading = 'File Categories',
  applyLabel = 'Add imported categories',
  applyPendingLabel = 'Adding…',
  remainingItemLabelSingular = 'file category',
  remainingItemLabelPlural = 'file categories',
}) {
  /*
   * This workspace is a reversible staging area, not the live category tree. Every gesture mutates a sanitized
   * draft snapshot with undo/redo while the left column tracks raw import values that can be grouped, parked in
   * Set Aside, or returned to the inbox before anything is written on Apply.
   */
  const computedInitialDraftState = useMemo(
    () => createCategoryImportDraftState(sourceValues, existingCategories),
    [existingCategories, sourceValues],
  )
  const [showPreviouslyImportedBadge] = useState(() => {
    const initialSnapshot = sanitizeSnapshot((initialDraftState || computedInitialDraftState).snapshot, sourceValues)
    // Only show previously imported categories as muted context while unresolved source values remain to be sorted.
    return initialSnapshot.sourceOrder.length > 0
  })
  const hasPersistedLeftPanelWidth = initialDraftState?.leftPanelWidth != null
  const [snapshot, setSnapshot] = useState(() => sanitizeSnapshot((initialDraftState || computedInitialDraftState).snapshot, sourceValues))
  // Undo/redo are session-scoped: they start empty on every open and are NOT restored from the
  // persisted draft. Restoring a prior session's history made Undo look active when the user had
  // done nothing this session — and worse, undoing after a previous Apply would roll the draft back
  // to a state that no longer matches what was already committed. Empty stacks => the buttons sit
  // disabled (dimmed) until there's something to undo.
  const [undoStack, setUndoStack] = useState([])
  const [redoStack, setRedoStack] = useState([])
  const [selectionAnchor, setSelectionAnchor] = useState(initialDraftState?.selectionAnchor || null)
  const [selectedBucketCategoryIds, setSelectedBucketCategoryIds] = useState(initialDraftState?.selectedBucketCategoryIds || [])
  const [bucketSelectionAnchor, setBucketSelectionAnchor] = useState(initialDraftState?.bucketSelectionAnchor || null)
  const [activeSection, setActiveSection] = useState(initialDraftState?.activeSection || 'expense')
  const [leftPanelWidth, setLeftPanelWidth] = useState(initialDraftState?.leftPanelWidth ?? null)
  const [editingId, setEditingId] = useState(null)
  const [editingValue, setEditingValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [panelMenu, setPanelMenu] = useState(null)
  const [groupMenu, setGroupMenu] = useState(null)
  const [sourceMenu, setSourceMenu] = useState(null)
  const [deleteImportedDialog, setDeleteImportedDialog] = useState(null)
  const [deleteImportedSaving, setDeleteImportedSaving] = useState(false)
  const [floatingGroupDraft, setFloatingGroupDraft] = useState(null)
  const [dragSourceGroupIds, setDragSourceGroupIds] = useState([])
  const [dragSourceLeadId, setDragSourceLeadId] = useState(null)
  const [dragChildIds, setDragChildIds] = useState([])
  const [dragLeadId, setDragLeadId] = useState(null)
  const [measuredGroupHeights, setMeasuredGroupHeights] = useState({})
  const contentLayoutRef = useRef(null)
  const sourceScrollRef = useRef(null)
  const rightPanelScrollRef = useRef(null)
  const panelMenuRef = useRef(null)
  const groupMenuRef = useRef(null)
  const sourceMenuRef = useRef(null)
  const floatingGroupDraftRef = useRef(null)
  const [rightPanelHeight, setRightPanelHeight] = useState(720)
  const sourceValuesKey = useMemo(() => JSON.stringify(sourceValues || []), [sourceValues])
  const existingGroupsKey = useMemo(
    () => JSON.stringify(
      (existingCategories || [])
        .filter(category => !category?.parent_id)
        .map(category => [category.id, String(category.name || '').trim(), category.category_type]),
    ),
    [existingCategories],
  )

  useEffect(() => {
    setSnapshot(prev => {
      const next = sanitizeSnapshot(prev, sourceValues)
      return snapshotsMatch(prev, next) ? prev : next
    })
    // Keyed on the stringified sourceValuesKey rather than sourceValues itself so a
    // parent re-render that hands us a fresh array with the same contents doesn't
    // pointlessly re-run sanitizeSnapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceValuesKey])

  useEffect(() => {
    // The draft's group columns are seeded once; merge in groups created on the Categories page after
    // seeding (and drop deleted ones) so newly-made groups are usable drop targets. Keyed on the
    // group id/name/type signature so an unchanged category list does not churn the snapshot.
    setSnapshot(prev => {
      const next = reconcileSnapshotGroupsWithCategories(prev, existingCategories)
      return snapshotsMatch(prev, next) ? prev : next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingGroupsKey])

  useDismissibleLayer({
    open: !!panelMenu,
    onClose: () => setPanelMenu(null),
    refs: [panelMenuRef],
    closeOnScrollResize: true,
  })

  useDismissibleLayer({
    open: !!groupMenu,
    onClose: () => setGroupMenu(null),
    refs: [groupMenuRef],
    closeOnScrollResize: true,
  })

  useDismissibleLayer({
    open: !!sourceMenu,
    onClose: () => setSourceMenu(null),
    refs: [sourceMenuRef],
    closeOnScrollResize: true,
  })

  useDismissibleLayer({
    open: !!floatingGroupDraft,
    onClose: () => {
      if (floatingGroupDraft?.name.trim()) {
        finalizeFloatingGroupDraft()
        return
      }
      setFloatingGroupDraft(null)
    },
    refs: [floatingGroupDraftRef],
    closeOnScrollResize: true,
  })

  useEscapeAction(
    () => {
      if (deleteImportedSaving) return
      setDeleteImportedDialog(null)
    },
    {
      enabled: !!deleteImportedDialog,
      escapeBehavior: ESCAPE_BEHAVIOR.CUSTOM,
    },
  )

  useEffect(() => {
    const element = rightPanelScrollRef.current
    if (!element) return undefined

    function updateHeight() {
      const next = Math.max(320, element.clientHeight - 24)
      setRightPanelHeight(prev => (Math.abs(prev - next) > 1 ? next : prev))
    }

    updateHeight()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateHeight) : null
    observer?.observe(element)
    window.addEventListener('resize', updateHeight)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', updateHeight)
    }
  }, [])

  useEscapeAction(event => {
    const hasSelection =
      (snapshot.selectedSourceIds || []).length > 0 ||
      selectedBucketCategoryIds.length > 0 ||
      !!snapshot.selectedNodeId ||
      !!selectionAnchor ||
      !!bucketSelectionAnchor

    if (!hasSelection) return

    event.preventDefault()
    event.stopPropagation()
    setSnapshot(prev => ({
      ...prev,
      selectedSourceIds: [],
      selectedNodeId: null,
    }))
    setSelectedBucketCategoryIds([])
    setSelectionAnchor(null)
    setBucketSelectionAnchor(null)
  }, {
    enabled:
      (snapshot.selectedSourceIds || []).length > 0 ||
      selectedBucketCategoryIds.length > 0 ||
      !!snapshot.selectedNodeId ||
      !!selectionAnchor ||
      !!bucketSelectionAnchor,
    ignoreEditableTarget: true,
    escapeBehavior: ESCAPE_BEHAVIOR.CLEAR_SELECTION,
  })

  const buildDraftState = useCallback(() => ({
    snapshot: sanitizeSnapshot(snapshot, sourceValues),
    // Undo/redo history is intentionally not persisted (session-scoped — see above).
    undoStack: [],
    redoStack: [],
    selectionAnchor,
    selectedBucketCategoryIds,
    bucketSelectionAnchor,
    activeSection,
    leftPanelWidth,
  }), [
    snapshot, sourceValues,
    selectionAnchor, selectedBucketCategoryIds, bucketSelectionAnchor,
    activeSection, leftPanelWidth,
  ])

  useEffect(() => {
    onDraftStateChange?.(buildDraftState())
  }, [buildDraftState, onDraftStateChange])

  function applySnapshotChange(mutator) {
    // Funnel every structural edit through one path so undo/redo always captures a clean, source-aware snapshot.
    const next = cloneCategoryImportSnapshot(snapshot)
    mutator(next)
    setUndoStack(prev => [...prev, cloneCategoryImportSnapshot(snapshot)])
    setRedoStack([])
    setSnapshot(sanitizeSnapshot(next, sourceValues))
  }

  function addGroup(sectionType) {
    const id = createTempId('group')
    applySnapshotChange(next => {
      next.tree[sectionType].push({ id, name: '', categoryType: sectionType, children: [], pending: true })
      next.collapsedGroups = { ...(next.collapsedGroups || {}), [id]: true }
      next.selectedNodeId = id
      sortSection(next.tree, sectionType)
    })
    setEditingId(id)
    setEditingValue('')
  }

  function startFloatingGroupDraft(sectionType, x, y) {
    const position = clampOverlayPosition(x, y, 250, 140)
    clearSourceSelection()
    setEditingId(null)
    setEditingValue('')
    setFloatingGroupDraft({
      id: createTempId('group'),
      sectionType,
      x: position.x,
      y: position.y,
      name: '',
    })
  }

  function finalizeFloatingGroupDraft() {
    if (!floatingGroupDraft?.name.trim()) return
    const { id, sectionType, name } = floatingGroupDraft
    applySnapshotChange(next => {
      next.tree[sectionType].push({ id, name: name.trim(), categoryType: sectionType, children: [], pending: true })
      next.collapsedGroups = { ...(next.collapsedGroups || {}), [id]: true }
      next.selectedNodeId = id
      sortSection(next.tree, sectionType)
    })
    setFloatingGroupDraft(null)
  }

  function commitEdit() {
    const value = editingValue.trim()
    if (!editingId) return
    if (!value) {
      removeNode(editingId)
      setEditingId(null)
      setEditingValue('')
      return
    }
    applySnapshotChange(next => {
      const info = findNode(next.tree, editingId)
      if (!info?.node) return
      info.node.name = value
      sortSection(next.tree, info.sectionType)
    })
    setEditingId(null)
    setEditingValue('')
  }

  function removeNode(nodeId) {
    applySnapshotChange(next => {
      for (const sectionType of ['income', 'expense']) {
        const groupIndex = next.tree[sectionType].findIndex(group => group.id === nodeId)
        if (groupIndex >= 0) {
          const [removedGroup] = next.tree[sectionType].splice(groupIndex, 1)
          if (next.collapsedGroups) delete next.collapsedGroups[nodeId]
          for (const child of removedGroup.children || []) {
            if (child.sourceValue && !next.sourceOrder.includes(child.sourceValue) && !next.setAsideOrder.includes(child.sourceValue)) {
              next.sourceOrder.push(child.sourceValue)
            }
          }
          next.sourceOrder.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
          next.selectedNodeId = null
          return
        }
        for (const group of next.tree[sectionType]) {
          const childIndex = group.children.findIndex(child => child.id === nodeId)
          if (childIndex >= 0) {
            const [removedChild] = group.children.splice(childIndex, 1)
            if (removedChild.sourceValue && !next.sourceOrder.includes(removedChild.sourceValue) && !next.setAsideOrder.includes(removedChild.sourceValue)) {
              next.sourceOrder.push(removedChild.sourceValue)
              next.sourceOrder.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
            }
            next.selectedNodeId = group.id
            return
          }
        }
      }
    })
  }

  function resolveLiveImportedCategory(group, child) {
    const groupName = String(group?.name || '').trim().toLowerCase()
    const childName = String(child?.name || child?.sourceValue || '').trim().toLowerCase()
    const groupType = group?.categoryType === 'income' ? 'income' : 'expense'
    const liveGroup = (existingCategories || []).find(category => (
      !category?.parent_id &&
      String(category.name || '').trim().toLowerCase() === groupName &&
      (category.category_type === 'income' ? 'income' : 'expense') === groupType
    ))
    if (!liveGroup) return null
    return (existingCategories || []).find(category => (
      category?.parent_id === liveGroup.id &&
      String(category.name || '').trim().toLowerCase() === childName
    )) || null
  }

  async function finishDeleteImportedChild(dialog) {
    const target = dialog || deleteImportedDialog
    if (!target?.items?.length) return
    setDeleteImportedSaving(true)
    try {
      for (const item of target.items) {
        if (item.liveCategoryId) {
          await api.deleteCategory(item.liveCategoryId)
        }
      }
      const refreshedCategories = await api.getCategories()
      onCategoriesChanged?.(refreshedCategories)
      applySnapshotChange(next => {
        const childIds = new Set(target.items.map(item => item.childId))
        for (const sectionType of ['income', 'expense']) {
          for (const group of next.tree[sectionType] || []) {
            const removedChildren = (group.children || []).filter(child => childIds.has(child.id))
            if (!removedChildren.length) continue
            group.children = group.children.filter(child => !childIds.has(child.id))
            for (const removedChild of removedChildren) {
              if (removedChild.sourceValue && !next.sourceOrder.includes(removedChild.sourceValue) && !next.setAsideOrder.includes(removedChild.sourceValue)) {
                next.sourceOrder.push(removedChild.sourceValue)
              }
            }
            next.sourceOrder.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
          }
        }
        next.selectedNodeId = null
      })
      setSelectedBucketCategoryIds([])
      setBucketSelectionAnchor(null)
      setDeleteImportedDialog(null)
    } finally {
      setDeleteImportedSaving(false)
    }
  }

  async function handleDeleteImportedChild(group, child) {
    const selectedImportedIds = selectedBucketCategoryIds.includes(child.id)
      ? selectedBucketCategoryIds.filter(id => findNode(snapshot.tree, id)?.node?.imported)
      : []
    const targetIds = selectedImportedIds.length > 0 ? selectedImportedIds : [child.id]
    const targetItems = targetIds
      .map(id => {
        const info = findNode(snapshot.tree, id)
        if (!info?.group || !info?.node?.imported) return null
        const liveCategory = resolveLiveImportedCategory(info.group, info.node)
        return {
          childId: id,
          childName: info.node.name,
          liveCategoryId: liveCategory?.id || null,
        }
      })
      .filter(Boolean)

    if (!targetItems.length) return

    const previewItems = []
    for (const item of targetItems) {
      if (!item.liveCategoryId) {
        previewItems.push({ ...item, preview: { txn_count: 0 } })
        continue
      }
      const preview = await api.getCategoryDeletePreview(item.liveCategoryId)
      previewItems.push({ ...item, preview })
    }

    const impactedItems = previewItems.filter(item => (item.preview?.txn_count || 0) > 0)
    if (impactedItems.length) {
      setDeleteImportedDialog({
        items: previewItems,
        impactedItems,
        totalTxnCount: impactedItems.reduce((sum, item) => sum + (item.preview?.txn_count || 0), 0),
      })
      return
    }
    await finishDeleteImportedChild({
      items: previewItems,
    })
  }

  function toggleGroupCollapse(groupId) {
    applySnapshotChange(next => {
      next.collapsedGroups = {
        ...(next.collapsedGroups || {}),
        [groupId]: !next.collapsedGroups?.[groupId],
      }
    })
  }

  function setAllGroupsCollapsed(sectionType, collapsed) {
    applySnapshotChange(next => {
      next.collapsedGroups = { ...(next.collapsedGroups || {}) }
      for (const group of next.tree[sectionType] || []) {
        next.collapsedGroups[group.id] = collapsed
      }
    })
    setPanelMenu(null)
  }

  function clearSourceSelection() {
    setSnapshot(prev => ({ ...prev, selectedSourceIds: [] }))
    setSelectionAnchor(null)
  }

  function clearBucketSelection(clearNode = true) {
    setSelectedBucketCategoryIds([])
    setBucketSelectionAnchor(null)
    if (clearNode) setSnapshot(prev => ({ ...prev, selectedNodeId: null }))
  }

  function clampLeftPanelWidth(value) {
    const layoutWidth = contentLayoutRef.current?.getBoundingClientRect?.().width || 0
    const maxWidth = layoutWidth
      ? Math.max(MIN_LEFT_PANEL_WIDTH, layoutWidth - MIN_RIGHT_PANEL_WIDTH - 8)
      : 560
    return Math.min(Math.max(value, MIN_LEFT_PANEL_WIDTH), maxWidth)
  }

  function startResizeDivider(event) {
    event.preventDefault()
    const layoutRect = contentLayoutRef.current?.getBoundingClientRect?.()
    if (!layoutRect) return

    function handlePointerMove(moveEvent) {
      const nextWidth = clampLeftPanelWidth(moveEvent.clientX - layoutRect.left)
      setLeftPanelWidth(nextWidth)
    }

    function stopResize() {
      window.removeEventListener('mousemove', handlePointerMove)
      window.removeEventListener('mouseup', stopResize)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', handlePointerMove)
    window.addEventListener('mouseup', stopResize)
  }

  function handleSelectSource(sourceValue, event) {
    clearBucketSelection()
    const activeIds = snapshot.sourceOrder.includes(sourceValue)
      ? snapshot.sourceOrder
      : snapshot.setAsideOrder.includes(sourceValue)
        ? snapshot.setAsideOrder
        : null
    const idx = activeIds ? activeIds.indexOf(sourceValue) : -1
    if (idx === -1) return

    if (!event.shiftKey && !event.ctrlKey && !event.metaKey && snapshot.selectedSourceIds.length === 1 && snapshot.selectedSourceIds[0] === sourceValue) {
      setSnapshot(prev => ({ ...prev, selectedSourceIds: [] }))
      setSelectionAnchor(null)
      return
    }

    if (event.shiftKey && selectionAnchor && activeIds.includes(selectionAnchor)) {
      const anchorIdx = activeIds.indexOf(selectionAnchor)
      const start = Math.min(anchorIdx, idx)
      const end = Math.max(anchorIdx, idx)
      setSnapshot(prev => ({ ...prev, selectedSourceIds: activeIds.slice(start, end + 1) }))
      return
    }

    if (event.ctrlKey || event.metaKey) {
      const currentLocation = sourceSelectionLocation()
      const itemLocation = snapshot.setAsideOrder.includes(sourceValue) ? 'setAside' : 'active'
      if (currentLocation && currentLocation !== itemLocation) return
      setSnapshot(prev => ({
        ...prev,
        selectedSourceIds: prev.selectedSourceIds.includes(sourceValue)
          ? prev.selectedSourceIds.filter(value => value !== sourceValue)
          : [...prev.selectedSourceIds, sourceValue],
      }))
      setSelectionAnchor(sourceValue)
      return
    }
    setSnapshot(prev => ({ ...prev, selectedSourceIds: [sourceValue] }))
    setSelectionAnchor(sourceValue)
  }

  function sourceSelectionLocation() {
    if (!(snapshot.selectedSourceIds || []).length) return null
    const setAside = new Set(snapshot.setAsideOrder || [])
    return snapshot.selectedSourceIds.every(id => setAside.has(id)) ? 'setAside' : 'active'
  }

  function openSourceMenuAt(sourceValue, event) {
    event.preventDefault()
    event.stopPropagation()
    setPanelMenu(null)
    setGroupMenu(null)
    clearBucketSelection()

    const inSetAside = snapshot.setAsideOrder.includes(sourceValue)
    const currentLocation = sourceSelectionLocation()
    const alreadySelected = snapshot.selectedSourceIds.includes(sourceValue)

    if (!alreadySelected || (currentLocation && currentLocation !== (inSetAside ? 'setAside' : 'active'))) {
      setSnapshot(prev => ({ ...prev, selectedSourceIds: [sourceValue] }))
      setSelectionAnchor(sourceValue)
    }

    const position = clampOverlayPosition(event.clientX, event.clientY, 168, 52)
    setSourceMenu({ x: position.x, y: position.y, mode: inSetAside ? 'restore' : 'setAside' })
  }

  function handleSourceDragStart(sourceValue, event) {
    if (event.target?.closest?.('[data-pill-no-drag="true"]')) {
      event.preventDefault()
      return
    }
    const sourceIds = snapshot.selectedSourceIds.includes(sourceValue) ? [...snapshot.selectedSourceIds] : [sourceValue]
    flushSync(() => {
      clearBucketSelection()
      if (!snapshot.selectedSourceIds.includes(sourceValue)) {
        setSnapshot(prev => ({ ...prev, selectedSourceIds: [sourceValue] }))
        setSelectionAnchor(sourceValue)
      }
      setDragSourceGroupIds(sourceIds.length > 1 ? sourceIds : [])
      setDragSourceLeadId(sourceValue)
    })
    setCategoryTreeDragItem({ id: `source:${sourceValue}`, isSource: true, sourceIds, fromSetAside: (snapshot.setAsideOrder || []).includes(sourceValue) })
    const dragElement = event.currentTarget
    if (dragElement instanceof HTMLElement) {
      const rect = dragElement.getBoundingClientRect()
      event.dataTransfer.setDragImage(
        dragElement,
        Math.min(Math.max(rect.width * 0.82, 44), Math.max(44, rect.width - 12)),
        Math.min(Math.max(rect.height * 0.3, 10), Math.max(10, rect.height - 10)),
      )
    }
    event.dataTransfer.effectAllowed = 'move'
  }

  function handleSelectCategory(nodeId, groupId, event) {
    const info = findNode(snapshot.tree, nodeId)
    if (!info?.group) return
    clearSourceSelection()
    const groupChildren = info.group.children || []
    const currentSelectionGroupId = selectedBucketCategoryIds.length > 0
      ? findNode(snapshot.tree, selectedBucketCategoryIds[0])?.group?.id || null
      : null
    const isModifierSelection = event.shiftKey || event.ctrlKey || event.metaKey
    if (isModifierSelection && currentSelectionGroupId && currentSelectionGroupId !== groupId) return
    if (event.shiftKey && bucketSelectionAnchor) {
      const anchorInfo = findNode(snapshot.tree, bucketSelectionAnchor)
      if (anchorInfo?.group?.id === groupId) {
        const anchorIndex = groupChildren.findIndex(child => child.id === bucketSelectionAnchor)
        const currentIndex = groupChildren.findIndex(child => child.id === nodeId)
        if (anchorIndex >= 0 && currentIndex >= 0) {
          setSelectedBucketCategoryIds(groupChildren.slice(Math.min(anchorIndex, currentIndex), Math.max(anchorIndex, currentIndex) + 1).map(child => child.id))
          setSnapshot(prev => ({ ...prev, selectedNodeId: nodeId }))
          return
        }
      }
    }
    if (event.ctrlKey || event.metaKey) {
      const isSelected = selectedBucketCategoryIds.includes(nodeId)
      const nextSelectedIds = isSelected
        ? selectedBucketCategoryIds.filter(id => id !== nodeId)
        : [...selectedBucketCategoryIds, nodeId]
      setSelectedBucketCategoryIds(nextSelectedIds)
      setBucketSelectionAnchor(nextSelectedIds.length ? nextSelectedIds[nextSelectedIds.length - 1] : null)
      setSnapshot(prev => ({ ...prev, selectedNodeId: nextSelectedIds.length ? nextSelectedIds[nextSelectedIds.length - 1] : null }))
      return
    }
    setSelectedBucketCategoryIds([nodeId])
    setBucketSelectionAnchor(nodeId)
    setSnapshot(prev => ({ ...prev, selectedNodeId: nodeId }))
  }

  function handleChildDragStart(childId, event) {
    if (event.target?.closest?.('[data-pill-no-drag="true"]')) {
      event.preventDefault()
      return
    }
    const info = findNode(snapshot.tree, childId)
    if (!info?.group) return
    clearSourceSelection()
    const childIds = selectedBucketCategoryIds.includes(childId)
      ? selectedBucketCategoryIds.filter(id => findNode(snapshot.tree, id)?.group?.id === info.group.id)
      : [childId]
    flushSync(() => {
      if (!selectedBucketCategoryIds.includes(childId)) {
        setSelectedBucketCategoryIds([childId])
        setBucketSelectionAnchor(childId)
        setSnapshot(prev => ({ ...prev, selectedNodeId: childId }))
      }
      setDragChildIds(childIds.length > 1 ? childIds : [])
      setDragLeadId(childId)
    })
    setCategoryTreeDragItem({ id: childId, ids: childIds, isSource: false, parentId: info.group.id })
    const dragElement = event.currentTarget
    if (dragElement instanceof HTMLElement) {
      const rect = dragElement.getBoundingClientRect()
      event.dataTransfer.setDragImage(
        dragElement,
        Math.min(Math.max(rect.width * 0.82, 44), Math.max(44, rect.width - 12)),
        Math.min(Math.max(rect.height * 0.3, 10), Math.max(10, rect.height - 10)),
      )
    }
    event.dataTransfer.effectAllowed = 'move'
  }

  function handleChildDragEnd() {
    clearCategoryTreeDragItem()
    setDragChildIds([])
    setDragLeadId(null)
  }

  function applyAddSourceToGroup(sourceIds, groupId) {
    applySnapshotChange(next => {
      const info = findNode(next.tree, groupId)
      if (!info?.node || info.node.parentId) return
      const existingNames = new Set((info.node.children || []).map(child => child.name.toLowerCase()))
      for (const sourceValue of sourceIds) {
        if (existingNames.has(sourceValue.toLowerCase())) continue
        info.node.children.push({ id: createTempId('category'), parentId: groupId, name: sourceValue, sourceValue })
      }
      info.node.children.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      next.sourceOrder = next.sourceOrder.filter(value => !sourceIds.includes(value))
      next.setAsideOrder = (next.setAsideOrder || []).filter(value => !sourceIds.includes(value))
      next.selectedSourceIds = []
      next.selectedNodeId = groupId
    })
    setSelectionAnchor(null)
  }

  function moveChildToGroup(childIds, groupId) {
    applySnapshotChange(next => {
      const ids = Array.isArray(childIds) ? childIds : [childIds]
      const moving = []
      for (const childId of ids) {
        for (const sectionType of ['income', 'expense']) {
          for (const group of next.tree[sectionType]) {
            const index = group.children.findIndex(child => child.id === childId)
            if (index >= 0) {
              moving.push(group.children.splice(index, 1)[0])
              break
            }
          }
          if (moving.some(child => child.id === childId)) break
        }
      }
      if (!moving.length) return
      const target = findNode(next.tree, groupId)
      if (!target?.node || target.node.parentId) return
      for (const child of moving) {
        child.parentId = groupId
        target.node.children.push(child)
      }
      target.node.children.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      next.selectedNodeId = moving[moving.length - 1]?.id || groupId
    })
    const ids = Array.isArray(childIds) ? childIds : [childIds]
    setSelectedBucketCategoryIds([...ids])
    setBucketSelectionAnchor(ids[ids.length - 1] || null)
  }

  function returnChildrenToSourcePool(childIds) {
    applySnapshotChange(next => {
      const ids = Array.isArray(childIds) ? childIds : [childIds]
      const removedChildren = []
      for (const childId of ids) {
        for (const sectionType of ['income', 'expense']) {
          for (const group of next.tree[sectionType]) {
            const index = group.children.findIndex(child => child.id === childId)
            if (index >= 0) {
              removedChildren.push(group.children.splice(index, 1)[0])
              break
            }
          }
          if (removedChildren.some(child => child.id === childId)) break
        }
      }
      if (!removedChildren.length) return
      for (const removedChild of removedChildren) {
        if (removedChild.sourceValue && !next.sourceOrder.includes(removedChild.sourceValue) && !next.setAsideOrder.includes(removedChild.sourceValue)) {
          next.sourceOrder.push(removedChild.sourceValue)
        }
      }
      next.sourceOrder.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      next.selectedNodeId = null
    })
    setSelectedBucketCategoryIds([])
    setBucketSelectionAnchor(null)
  }

  function handleDropOnGroup(groupId) {
    const item = getCategoryTreeDragItem()
    if (!item) return
    if (item.isSource) applyAddSourceToGroup(item.sourceIds || [], groupId)
    else moveChildToGroup(item.ids || item.id, groupId)
    clearCategoryTreeDragItem()
    setDragSourceGroupIds([])
    setDragSourceLeadId(null)
    setDragChildIds([])
    setDragLeadId(null)
  }

  function moveSelectedSourcesToSetAside() {
    if (!snapshot.selectedSourceIds.length) return
    applySnapshotChange(next => {
      const moving = next.selectedSourceIds.filter(value => next.sourceOrder.includes(value))
      next.sourceOrder = next.sourceOrder.filter(value => !moving.includes(value))
      next.setAsideOrder = Array.from(new Set([...(next.setAsideOrder || []), ...moving])).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      next.selectedSourceIds = []
    })
    setSelectionAnchor(null)
    setSourceMenu(null)
  }

  function restoreSelectedSources() {
    if (!snapshot.selectedSourceIds.length) return
    applySnapshotChange(next => {
      const restoring = next.selectedSourceIds.filter(value => (next.setAsideOrder || []).includes(value))
      next.setAsideOrder = (next.setAsideOrder || []).filter(value => !restoring.includes(value))
      next.sourceOrder = Array.from(new Set([...(next.sourceOrder || []), ...restoring])).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      next.selectedSourceIds = []
    })
    setSelectionAnchor(null)
    setSourceMenu(null)
  }

  function deleteSelectedSources() {
    const selected = [...(snapshot.selectedSourceIds || [])]
    setSourceMenu(null)
    if (!selected.length || typeof onDeleteSources !== 'function') return
    // Deletion is owned by the parent: it confirms first, then runs the real category-delete flow.
    // Do NOT mutate the draft here — if the user cancels, the item must stay exactly where it is
    // (a premature removal makes it an untracked source value that the reconciler floats into the
    // pool). On confirm, the refreshed source-value list drops it from the columns automatically.
    onDeleteSources(selected)
  }

  function handleDropOnSourcePool() {
    const item = getCategoryTreeDragItem()
    if (!item) return
    if (item.isSource && item.fromSetAside) {
      applySnapshotChange(next => {
        const restoring = (item.sourceIds || []).filter(value => (next.setAsideOrder || []).includes(value))
        next.setAsideOrder = (next.setAsideOrder || []).filter(value => !restoring.includes(value))
        next.sourceOrder = Array.from(new Set([...(next.sourceOrder || []), ...restoring])).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
        next.selectedSourceIds = []
      })
      clearCategoryTreeDragItem()
      setDragSourceGroupIds([])
      setDragSourceLeadId(null)
      setSelectionAnchor(null)
      return
    }
    if (item.isSource) return
    returnChildrenToSourcePool(item.ids || item.id)
    clearCategoryTreeDragItem()
    setDragChildIds([])
    setDragLeadId(null)
  }

  function handleDropOnSetAside() {
    const item = getCategoryTreeDragItem()
    if (!item?.isSource) return
    applySnapshotChange(next => {
      const moving = (item.sourceIds || []).filter(value => next.sourceOrder.includes(value))
      next.sourceOrder = next.sourceOrder.filter(value => !moving.includes(value))
      next.setAsideOrder = Array.from(new Set([...(next.setAsideOrder || []), ...moving])).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      next.selectedSourceIds = []
    })
    clearCategoryTreeDragItem()
    setDragSourceGroupIds([])
    setDragSourceLeadId(null)
    setSelectionAnchor(null)
  }

  const groups = useMemo(() => snapshot.tree[activeSection] || [], [snapshot.tree, activeSection])
  const remainingCount = snapshot.sourceOrder.length
  const processedCount = Math.max(0, (sourceValues || []).filter(Boolean).length - remainingCount)
  const remainingItemLabel = remainingCount === 1 ? remainingItemLabelSingular : remainingItemLabelPlural
  const processedItemLabel = processedCount === 1 ? remainingItemLabelSingular : remainingItemLabelPlural
  const hasWorkToApply = useMemo(() => {
    // Applying should be a no-op if the draft only mirrors what is already live. Set-aside is
    // committed on Apply (it sets the live category's set_aside flag), so it is work *only* when the
    // draft's parked set differs from what is already flagged live (`parkedSourceValues`) —
    // otherwise reopening a workspace that simply still has parked items would leave Apply lit with
    // nothing to do.
    const liveSetAside = new Set((parkedSourceValues || []).map(value => String(value || '').trim().toLowerCase()))
    const draftSetAside = (snapshot.setAsideOrder || []).map(value => String(value || '').trim().toLowerCase())
    if (draftSetAside.length !== liveSetAside.size || draftSetAside.some(name => !liveSetAside.has(name))) return true
    const liveGroupsByKey = new Map(
      (existingCategories || [])
        .filter(category => !category?.parent_id)
        .map(category => [
          `${category.category_type === 'income' ? 'income' : 'expense'}::${String(category.name || '').trim().toLowerCase()}`,
          category,
        ]),
    )
    const liveChildNamesByGroupId = new Map()
    for (const category of (existingCategories || []).filter(item => !!item?.parent_id)) {
      const names = liveChildNamesByGroupId.get(category.parent_id) || new Set()
      names.add(String(category.name || '').trim().toLowerCase())
      liveChildNamesByGroupId.set(category.parent_id, names)
    }

    return ['income', 'expense'].some(sectionType => (
      (snapshot.tree[sectionType] || []).some(group => {
        const groupName = String(group.name || '').trim()
        if (!groupName) return false
        const liveGroup = liveGroupsByKey.get(`${sectionType}::${groupName.toLowerCase()}`)
        if (!liveGroup) return true
        const liveChildNames = liveChildNamesByGroupId.get(liveGroup.id) || new Set()
        return (group.children || []).some(child => {
          const childName = String(child.name || child.sourceValue || '').trim().toLowerCase()
          return !!childName && !liveChildNames.has(childName)
        })
      })
    ))
  }, [existingCategories, snapshot.tree, snapshot.setAsideOrder, parkedSourceValues])
  const sourceSelectionInSetAside = snapshot.selectedSourceIds.length > 0 && snapshot.selectedSourceIds.every(value => (snapshot.setAsideOrder || []).includes(value))
  const setAsideCollapsed = !!snapshot.collapsedGroups?.__setAside
  const activeGroupMenuGroup = groupMenu ? groups.find(group => group.id === groupMenu.groupId) || null : null

  useEffect(() => {
    const element = rightPanelScrollRef.current
    if (!element || !groups.length) return undefined

    const frame = requestAnimationFrame(() => {
      const nextHeights = {}
      for (const node of element.querySelectorAll('[data-group-card="true"][data-group-id]')) {
        const groupId = node.getAttribute('data-group-id')
        if (!groupId) continue
        nextHeights[groupId] = Math.round(node.getBoundingClientRect().height)
      }
      setMeasuredGroupHeights(prev => {
        const prevKeys = Object.keys(prev)
        const nextKeys = Object.keys(nextHeights)
        if (prevKeys.length === nextKeys.length && nextKeys.every(key => prev[key] === nextHeights[key])) {
          return prev
        }
        return nextHeights
      })
    })

    return () => cancelAnimationFrame(frame)
  }, [activeSection, groups, snapshot.collapsedGroups, selectedBucketCategoryIds.length])

  const groupColumns = useMemo(
    () => buildGroupColumns(groups, snapshot.collapsedGroups, rightPanelHeight, measuredGroupHeights),
    [groups, measuredGroupHeights, rightPanelHeight, snapshot.collapsedGroups],
  )

  useEffect(() => {
    if (hasPersistedLeftPanelWidth || leftPanelWidth != null) return
    const layoutWidth = contentLayoutRef.current?.getBoundingClientRect?.().width || 0
    if (!layoutWidth) return
    const rightColumnCount = Math.max(1, groupColumns.length || 1)
    const desiredRightWidth = Math.max(
      MIN_RIGHT_PANEL_WIDTH,
      (rightColumnCount * GROUP_COLUMN_WIDTH) + (Math.max(0, rightColumnCount - 1) * GROUP_COLUMN_GAP) + 24,
    )
    const computedWidth = clampLeftPanelWidth(layoutWidth - 8 - desiredRightWidth)
    setLeftPanelWidth(computedWidth)
  }, [groupColumns.length, hasPersistedLeftPanelWidth, leftPanelWidth, rightPanelHeight])

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(15, 23, 42, 0.44)', padding: 20, display: 'flex', alignItems: 'stretch', justifyContent: 'center' }}>
      <div style={{ width: 'min(1240px, 100%)', background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface2) 55%, var(--surface)), var(--surface))', border: '1px solid var(--border)', borderRadius: 18, boxShadow: '0 32px 88px rgba(15, 23, 42, 0.3)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '18px 22px 14px', borderBottom: '1px solid var(--border)', background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface2) 84%, var(--surface)), color-mix(in srgb, var(--surface2) 62%, var(--surface)))' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 18 }}>
            <div>
              <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 6 }}>{title}</div>
              <div style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 700, lineHeight: 1.55 }}>
                {description}
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
                {remainingCount > 0 ? `${remainingCount} ${remainingItemLabel} still need a group.` : `${processedCount} ${processedItemLabel} organized.`}
              </div>
              {sourceMeta?.truncated ? (
                <div style={{ marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 12, border: '1px solid color-mix(in srgb, #f59e0b 34%, var(--border))', background: 'color-mix(in srgb, #f59e0b 10%, var(--surface2))', color: 'color-mix(in srgb, #f59e0b 72%, var(--text))', fontSize: 11, lineHeight: 1.4 }}>
                  <span>This column has {sourceMeta.total_count} unique values. Showing the first {sourceMeta.limit} here.</span>
                </div>
              ) : null}
            </div>
            <div style={{ display: 'grid', gap: 8, minWidth: 'min(320px, 100%)', justifyItems: 'stretch', flex: '0 0 auto' }}>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <div style={{ display: 'inline-flex', gap: 4, padding: 4, borderRadius: 999, background: 'color-mix(in srgb, var(--surface2) 60%, var(--surface))', border: '1px solid color-mix(in srgb, var(--border) 82%, transparent)' }}>
                  <Button variant="ghost" onClick={async () => { setSaving(true); try { await onApply(buildDraftState()) } finally { setSaving(false) } }} disabled={saving || !hasWorkToApply}>
                    {saving ? applyPendingLabel : applyLabel}
                  </Button>
                  <Button variant="ghost" onClick={onClose}>Close</Button>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <div style={{ display: 'inline-flex', gap: 4, padding: 4, borderRadius: 999, background: 'color-mix(in srgb, var(--surface2) 60%, var(--surface))', border: '1px solid color-mix(in srgb, var(--border) 82%, transparent)' }}>
                  <Button variant="ghost" onClick={() => { if (!redoStack.length) return; const next = redoStack[redoStack.length - 1]; setUndoStack(prev => [...prev, cloneCategoryImportSnapshot(snapshot)]); setRedoStack(prev => prev.slice(0, -1)); setSnapshot(cloneCategoryImportSnapshot(next)) }} disabled={redoStack.length === 0}>Redo</Button>
                  <Button variant="ghost" onClick={() => { if (!undoStack.length) return; const next = undoStack[undoStack.length - 1]; setRedoStack(prev => [...prev, cloneCategoryImportSnapshot(snapshot)]); setUndoStack(prev => prev.slice(0, -1)); setSnapshot(cloneCategoryImportSnapshot(next)) }} disabled={undoStack.length === 0}>Undo</Button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div ref={contentLayoutRef} style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: `${leftPanelWidth ?? DEFAULT_LEFT_PANEL_WIDTH}px 8px minmax(0, 1fr)` }}>
          <div style={{ minHeight: 0, display: 'flex', flexDirection: 'column', background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface) 88%, black), color-mix(in srgb, var(--surface) 96%, black))' }}>
            <div style={{ padding: '16px 16px 12px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 4 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{sourceHeading}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  <button onClick={() => { if (!snapshot.selectedSourceIds.length) return; if (sourceSelectionInSetAside) restoreSelectedSources(); else moveSelectedSourcesToSetAside() }} disabled={snapshot.selectedSourceIds.length === 0} style={{ background: 'color-mix(in srgb, var(--surface2) 70%, var(--surface))', border: '1px solid var(--border)', borderRadius: 999, padding: '4px 10px', fontSize: 11, color: snapshot.selectedSourceIds.length === 0 ? 'color-mix(in srgb, var(--muted) 62%, transparent)' : 'var(--muted)', cursor: snapshot.selectedSourceIds.length === 0 ? 'default' : 'pointer', opacity: snapshot.selectedSourceIds.length === 0 ? 0.72 : 1 }}>{sourceSelectionInSetAside ? 'restore' : 'set aside'}</button>
                  <button onClick={() => { if (!snapshot.selectedSourceIds.length) return; setSnapshot(prev => ({ ...prev, selectedSourceIds: [] })); setSelectionAnchor(null) }} disabled={snapshot.selectedSourceIds.length === 0} style={{ background: 'color-mix(in srgb, var(--surface2) 70%, var(--surface))', border: '1px solid var(--border)', borderRadius: 999, padding: '4px 10px', fontSize: 11, color: snapshot.selectedSourceIds.length === 0 ? 'color-mix(in srgb, var(--muted) 62%, transparent)' : 'var(--muted)', cursor: snapshot.selectedSourceIds.length === 0 ? 'default' : 'pointer', opacity: snapshot.selectedSourceIds.length === 0 ? 0.72 : 1 }}>clear selection</button>
                  {typeof onDeleteSources === 'function' ? (
                    <button onClick={deleteSelectedSources} disabled={snapshot.selectedSourceIds.length === 0} style={{ background: 'color-mix(in srgb, var(--surface2) 70%, var(--surface))', border: '1px solid var(--border)', borderRadius: 999, padding: '4px 10px', fontSize: 11, color: snapshot.selectedSourceIds.length === 0 ? 'color-mix(in srgb, var(--muted) 62%, transparent)' : 'color-mix(in srgb, var(--danger) 55%, var(--muted))', cursor: snapshot.selectedSourceIds.length === 0 ? 'default' : 'pointer', opacity: snapshot.selectedSourceIds.length === 0 ? 0.72 : 1 }}>delete</button>
                  ) : null}
                </div>
              </div>
            </div>
            <div
              ref={sourceScrollRef}
              onDragOver={event => {
                autoScrollContainer(sourceScrollRef.current, event.clientY)
                const item = getCategoryTreeDragItem()
                if (!item) return
                if (!item.isSource || item.fromSetAside) event.preventDefault()
              }}
              onDrop={event => { event.preventDefault(); handleDropOnSourcePool() }}
              onContextMenu={event => {
                if (!snapshot.selectedSourceIds.length || sourceSelectionInSetAside) return
                event.preventDefault()
                setPanelMenu(null)
                setGroupMenu(null)
                const position = clampOverlayPosition(event.clientX, event.clientY, 168, 52)
                setSourceMenu({ x: position.x, y: position.y, mode: 'setAside' })
              }}
              style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 12, background: 'color-mix(in srgb, var(--surface) 92%, black)' }}
            >
              {snapshot.sourceOrder.length > 0 ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', alignContent: 'flex-start', gap: 8 }}>
                  {snapshot.sourceOrder.map(sourceValue => {
                    const showDragCount = dragSourceGroupIds.length > 1 && dragSourceLeadId === sourceValue
                    return (
                      <button key={sourceValue} type="button" draggable onClick={event => handleSelectSource(sourceValue, event)} onContextMenu={event => openSourceMenuAt(sourceValue, event)} onDragStart={event => handleSourceDragStart(sourceValue, event)} onDragEnd={() => { clearCategoryTreeDragItem(); setDragSourceGroupIds([]); setDragSourceLeadId(null) }} style={{ border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', color: 'var(--text)', outline: 'none' }}>
                        <SourceChip label={sourceValue} selected={snapshot.selectedSourceIds.includes(sourceValue)} grouped={dragSourceGroupIds.includes(sourceValue)} groupCount={dragSourceGroupIds.length} showCount={showDragCount} />
                      </button>
                    )
                  })}
                </div>
              ) : (
                <div style={{ minHeight: 36, display: 'grid', placeItems: 'center', textAlign: 'center', padding: '6px 0 2px', fontSize: 12, color: 'var(--muted)' }}>&lt;none&gt;</div>
              )}
              <SetAsideTray
                count={(snapshot.setAsideOrder || []).length}
                selected={sourceSelectionInSetAside}
                collapsed={setAsideCollapsed}
                onToggle={() => setSnapshot(prev => ({ ...prev, collapsedGroups: { ...prev.collapsedGroups, __setAside: !prev.collapsedGroups?.__setAside } }))}
                onDrop={event => {
                  event.preventDefault()
                  handleDropOnSetAside()
                }}
                onContextMenu={event => {
                  if (!snapshot.selectedSourceIds.length || !sourceSelectionInSetAside) return
                  event.preventDefault()
                  setPanelMenu(null)
                  setGroupMenu(null)
                  const position = clampOverlayPosition(event.clientX, event.clientY, 168, 52)
                  setSourceMenu({ x: position.x, y: position.y, mode: 'restore' })
                }}
              >
                  {(snapshot.setAsideOrder || []).length > 0 ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignContent: 'flex-start', gap: 8 }}>
                      {snapshot.setAsideOrder.map(sourceValue => {
                        const showDragCount = dragSourceGroupIds.length > 1 && dragSourceLeadId === sourceValue
                        return (
                          <button key={`aside:${sourceValue}`} type="button" draggable onClick={event => handleSelectSource(sourceValue, event)} onContextMenu={event => openSourceMenuAt(sourceValue, event)} onDragStart={event => handleSourceDragStart(sourceValue, event)} onDragEnd={() => { clearCategoryTreeDragItem(); setDragSourceGroupIds([]); setDragSourceLeadId(null) }} style={{ border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', color: 'var(--text)', outline: 'none' }}>
                            <SourceChip label={sourceValue} selected={snapshot.selectedSourceIds.includes(sourceValue)} grouped={dragSourceGroupIds.includes(sourceValue)} groupCount={dragSourceGroupIds.length} showCount={showDragCount} />
                          </button>
                        )
                      })}
                    </div>
                  ) : (
                    <div style={{ minHeight: 52, borderRadius: 14, border: '1px dashed color-mix(in srgb, var(--border) 85%, transparent)', background: 'color-mix(in srgb, var(--surface2) 58%, var(--surface))', display: 'grid', placeItems: 'center', textAlign: 'center', padding: 12, fontSize: 12, color: 'var(--muted)' }}>&lt;empty&gt;</div>
                  )}
              </SetAsideTray>
            </div>
          </div>

          <div
            onMouseDown={startResizeDivider}
            title="Drag to resize panels"
            style={{
              minHeight: 0,
              cursor: 'col-resize',
              background: 'linear-gradient(180deg, color-mix(in srgb, var(--border) 72%, transparent), color-mix(in srgb, var(--border) 38%, transparent))',
              boxShadow: 'inset 1px 0 0 color-mix(in srgb, white 6%, transparent), inset -1px 0 0 color-mix(in srgb, black 14%, transparent)',
            }}
          />

          <div style={{ minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '14px 16px 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ display: 'inline-flex', gap: 4, padding: 4, borderRadius: 999, background: 'color-mix(in srgb, var(--surface2) 74%, var(--surface))', border: '1px solid var(--border)' }}>
                  {['expense', 'income'].map(section => (
                    <button key={section} onClick={() => setActiveSection(section)} style={{ border: 'none', background: activeSection === section ? 'color-mix(in srgb, var(--surface) 82%, black)' : 'transparent', color: activeSection === section ? 'var(--text)' : 'var(--muted)', borderRadius: 999, padding: '7px 14px', fontSize: 12, fontWeight: activeSection === section ? 700 : 600, cursor: 'pointer', textTransform: 'capitalize' }}>{section}</button>
                  ))}
                </div>
                <button type="button" onClick={() => addGroup(activeSection)} style={{ border: '1px solid color-mix(in srgb, var(--accent) 28%, var(--border))', background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface2) 86%, var(--surface)), color-mix(in srgb, var(--surface2) 62%, var(--surface)))', color: 'var(--text)', borderRadius: 999, padding: '8px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer', boxShadow: '0 6px 14px rgba(15, 23, 42, 0.12)' }}>+ New group</button>
              </div>
            </div>
            <div
              ref={rightPanelScrollRef}
              style={{ flex: 1, minHeight: 0, overflowX: 'auto', overflowY: 'auto', padding: 12, background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface2) 34%, var(--surface)), var(--surface))' }}
              onDragOver={event => {
                autoScrollContainer(rightPanelScrollRef.current, event.clientY)
              }}
              onContextMenu={event => {
                if (event.target.closest('[data-group-card="true"]')) return
                event.preventDefault()
                clearSourceSelection()
                setSnapshot(prev => ({ ...prev, selectedNodeId: null }))
                setGroupMenu(null)
                const position = clampOverlayPosition(event.clientX, event.clientY, 170, 88)
                setPanelMenu({ x: position.x, y: position.y, sectionType: activeSection })
              }}
            >
              {groups.length === 0 ? (
                <div style={{ minHeight: 180, borderRadius: 18, border: '1px dashed color-mix(in srgb, var(--border) 84%, transparent)', background: 'color-mix(in srgb, var(--surface2) 62%, var(--surface))', display: 'grid', placeItems: 'center', padding: 20, textAlign: 'center', color: 'var(--muted)' }}>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6, color: 'var(--text)' }}>No {activeSection} groups yet</div>
                    <div style={{ fontSize: 13, lineHeight: 1.55 }}>Create a group, then drag file categories into it.</div>
                  </div>
                </div>
              ) : (
                <div style={{ minHeight: '100%', width: 'max-content', minWidth: '100%', display: 'flex', alignItems: 'flex-start', gap: GROUP_COLUMN_GAP }}>
                  {groupColumns.map((columnGroups, columnIndex) => (
                    <div key={`column:${columnIndex}`} style={{ width: GROUP_COLUMN_WIDTH, minWidth: GROUP_COLUMN_WIDTH, display: 'flex', flexDirection: 'column', gap: GROUP_CARD_GAP }}>
                      {columnGroups.map(group => (
                        <GroupCard
                          key={group.id}
                          group={group}
                          collapsed={!!snapshot.collapsedGroups?.[group.id]}
                          showPreviouslyImportedBadge={showPreviouslyImportedBadge}
                          selectedNodeId={snapshot.selectedNodeId}
                          selectedChildIds={selectedBucketCategoryIds}
                          dragChildIds={dragChildIds}
                          dragLeadId={dragLeadId}
                          editingId={editingId}
                          editingValue={editingValue}
                          setEditingId={setEditingId}
                          setEditingValue={setEditingValue}
                          commitEdit={commitEdit}
                          onToggleCollapse={toggleGroupCollapse}
                          onRemoveGroup={removeNode}
                          onRemoveChild={removeNode}
                          onDeleteImportedChild={handleDeleteImportedChild}
                          onDropGroup={handleDropOnGroup}
                          onChildDragStart={handleChildDragStart}
                          onChildDragEnd={handleChildDragEnd}
                          onSelectChild={handleSelectCategory}
                          onContextMenu={event => {
                            event.preventDefault()
                            event.stopPropagation()
                            clearSourceSelection()
                            setPanelMenu(null)
                            setSnapshot(prev => ({ ...prev, selectedNodeId: group.id }))
                            const position = clampOverlayPosition(event.clientX, event.clientY, 170, 52)
                            setGroupMenu({ x: position.x, y: position.y, groupId: group.id })
                          }}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
        {panelMenu ? (
          <div
            ref={panelMenuRef}
            style={{
              position: 'fixed',
              left: panelMenu.x,
              top: panelMenu.y,
              zIndex: 1300,
              minWidth: 170,
              background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface2) 86%, var(--surface)), color-mix(in srgb, var(--surface2) 62%, var(--surface)))',
              border: '1px solid var(--border)',
              borderRadius: 12,
              boxShadow: '0 18px 42px rgba(15, 23, 42, 0.32)',
              padding: 6,
            }}
            onMouseDown={event => event.stopPropagation()}
          >
            <button
              onClick={() => {
                startFloatingGroupDraft(panelMenu.sectionType, panelMenu.x, panelMenu.y)
                setPanelMenu(null)
              }}
              style={{
                width: '100%',
                textAlign: 'left',
                border: 'none',
                background: 'transparent',
                color: 'var(--text)',
                borderRadius: 8,
                padding: '8px 10px',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              + New group
            </button>
            <div style={{ height: 1, background: 'color-mix(in srgb, var(--border) 82%, transparent)', margin: '4px 2px' }} />
            <button
              onClick={() => setAllGroupsCollapsed(panelMenu.sectionType, false)}
              style={{
                width: '100%',
                textAlign: 'left',
                border: 'none',
                background: 'transparent',
                color: 'var(--text)',
                borderRadius: 8,
                padding: '8px 10px',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Expand all
            </button>
            <button
              onClick={() => setAllGroupsCollapsed(panelMenu.sectionType, true)}
              style={{
                width: '100%',
                textAlign: 'left',
                border: 'none',
                background: 'transparent',
                color: 'var(--text)',
                borderRadius: 8,
                padding: '8px 10px',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Collapse all
            </button>
          </div>
        ) : null}
        {groupMenu ? (
          <div
            ref={groupMenuRef}
            style={{
              position: 'fixed',
              left: groupMenu.x,
              top: groupMenu.y,
              zIndex: 1300,
              minWidth: 170,
              background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface2) 86%, var(--surface)), color-mix(in srgb, var(--surface2) 62%, var(--surface)))',
              border: '1px solid var(--border)',
              borderRadius: 12,
              boxShadow: '0 18px 42px rgba(15, 23, 42, 0.32)',
              padding: 6,
            }}
            onMouseDown={event => event.stopPropagation()}
          >
            <button
              onClick={() => {
                if (!activeGroupMenuGroup) return
                toggleGroupCollapse(groupMenu.groupId)
                setGroupMenu(null)
              }}
              style={{
                width: '100%',
                textAlign: 'left',
                border: 'none',
                background: 'transparent',
                color: 'var(--text)',
                borderRadius: 8,
                padding: '8px 10px',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {snapshot.collapsedGroups?.[groupMenu.groupId] ? 'Expand' : 'Collapse'}
            </button>
          </div>
        ) : null}
        {sourceMenu ? (
          <div
            ref={sourceMenuRef}
            style={{
              position: 'fixed',
              left: sourceMenu.x,
              top: sourceMenu.y,
              zIndex: 1300,
              minWidth: 168,
              background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface2) 86%, var(--surface)), color-mix(in srgb, var(--surface2) 62%, var(--surface)))',
              border: '1px solid var(--border)',
              borderRadius: 12,
              boxShadow: '0 18px 42px rgba(15, 23, 42, 0.32)',
              padding: 6,
            }}
            onMouseDown={event => event.stopPropagation()}
          >
            <button
              onClick={() => {
                if (sourceMenu.mode === 'restore') restoreSelectedSources()
                else moveSelectedSourcesToSetAside()
              }}
              style={{
                width: '100%',
                textAlign: 'left',
                border: 'none',
                background: 'transparent',
                color: 'var(--text)',
                borderRadius: 8,
                padding: '8px 10px',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {sourceMenu.mode === 'restore' ? 'Restore' : 'Set aside'}
            </button>
            {typeof onDeleteSources === 'function' ? (
              <button
                onClick={deleteSelectedSources}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--danger)',
                  borderRadius: 8,
                  padding: '8px 10px',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Delete…
              </button>
            ) : null}
          </div>
        ) : null}
        {floatingGroupDraft ? (
          <div
            ref={floatingGroupDraftRef}
            data-floating-group-draft="true"
            style={{
              position: 'fixed',
              left: floatingGroupDraft.x,
              top: floatingGroupDraft.y,
              zIndex: 1301,
              width: 250,
              borderRadius: 16,
              border: '1px solid color-mix(in srgb, var(--accent) 28%, var(--border))',
              background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface2) 82%, var(--surface)), color-mix(in srgb, var(--surface) 88%, black))',
              boxShadow: '0 22px 52px rgba(15, 23, 42, 0.34)',
              overflow: 'hidden',
            }}
            onMouseDown={event => event.stopPropagation()}
          >
            <div
              style={{
                padding: '10px 11px 9px',
                borderBottom: '1px solid color-mix(in srgb, var(--border) 78%, transparent)',
                background: 'color-mix(in srgb, var(--accent) 10%, var(--surface))',
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                gap: 8,
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button
                    disabled
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: 6,
                      border: '1px solid var(--border)',
                      background: 'color-mix(in srgb, var(--surface2) 70%, var(--surface))',
                      color: 'var(--muted)',
                      opacity: 0.65,
                      cursor: 'default',
                    }}
                  >
                    -
                  </button>
                  <TransientTextInput
                    placeholder="Group name"
                    value={floatingGroupDraft.name}
                    onChange={value => setFloatingGroupDraft(prev => (prev ? { ...prev, name: value } : prev))}
                    onCommit={() => {
                      if (floatingGroupDraft?.name.trim()) {
                        finalizeFloatingGroupDraft()
                        return
                      }
                    }}
                    onBlurCommit={false}
                    onCancel={() => setFloatingGroupDraft(null)}
                    style={{
                      background: 'var(--bg)',
                      color: 'var(--text)',
                      border: '1px solid color-mix(in srgb, var(--accent) 55%, var(--border))',
                      borderRadius: 8,
                      padding: '4px 8px',
                      fontSize: 14,
                      fontWeight: 700,
                      outline: 'none',
                      width: '100%',
                    }}
                  />
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button
                  onMouseDown={event => {
                    event.preventDefault()
                    event.stopPropagation()
                  }}
                  onClick={() => setFloatingGroupDraft(null)}
                  style={{
                    border: '1px solid color-mix(in srgb, var(--muted) 42%, var(--border))',
                    background: 'color-mix(in srgb, var(--surface) 82%, transparent)',
                    color: 'var(--muted)',
                    borderRadius: 999,
                    width: 20,
                    height: 20,
                    padding: 0,
                    fontSize: 12,
                    fontWeight: 700,
                    lineHeight: 1,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    boxShadow: '0 0 0 1px color-mix(in srgb, var(--bg) 60%, transparent)',
                  }}
                >
                  <span>×</span>
                </button>
              </div>
            </div>
            <div style={{ padding: 12 }}>
              <div style={{ minHeight: 72, borderRadius: 14, border: '1px dashed color-mix(in srgb, var(--border) 85%, transparent)', background: 'color-mix(in srgb, var(--surface2) 58%, var(--surface))', display: 'grid', placeItems: 'center', textAlign: 'center', padding: 12, fontSize: 12, color: 'var(--muted)' }}>&lt;empty&gt;</div>
            </div>
          </div>
        ) : null}
        {deleteImportedDialog ? (
          <div
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 1400,
              background: 'rgba(15, 23, 42, 0.38)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 20,
            }}
          >
            <div
              style={{
                width: 'min(540px, 100%)',
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 16,
                boxShadow: '0 24px 60px rgba(15, 23, 42, 0.24)',
                overflow: 'hidden',
              }}
              onMouseDown={event => event.stopPropagation()}
            >
              <div
                style={{
                  padding: '16px 18px 12px',
                  borderBottom: '1px solid var(--border)',
                  background: 'color-mix(in srgb, var(--surface2) 82%, var(--surface))',
                }}
              >
                <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text)', marginBottom: 6 }}>
                  Delete imported categor{deleteImportedDialog.items.length === 1 ? 'y' : 'ies'}?
                </div>
                <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
                  {deleteImportedDialog.impactedItems.length === 1 ? (
                    <>
                      &quot;{deleteImportedDialog.impactedItems[0].childName}&quot; is assigned to {deleteImportedDialog.impactedItems[0].preview.txn_count} transaction{deleteImportedDialog.impactedItems[0].preview.txn_count === 1 ? '' : 's'}.
                    </>
                  ) : (
                    <>
                      {deleteImportedDialog.impactedItems.length} categories are assigned to {deleteImportedDialog.totalTxnCount} transactions.
                    </>
                  )}
                </div>
              </div>
              <div style={{ padding: '16px 18px', display: 'grid', gap: 12 }}>
                {deleteImportedDialog.impactedItems.length > 1 ? (
                  <div
                    style={{
                      display: 'grid',
                      gap: 6,
                      padding: '10px 12px',
                      borderRadius: 12,
                      border: '1px solid color-mix(in srgb, var(--border) 85%, transparent)',
                      background: 'color-mix(in srgb, var(--surface2) 78%, var(--surface))',
                    }}
                  >
                    {deleteImportedDialog.impactedItems.map(item => (
                      <div key={item.childId} style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.45 }}>
                        • <strong style={{ color: 'var(--text)' }}>{item.childName}</strong> — {item.preview.txn_count} transaction{item.preview.txn_count === 1 ? '' : 's'}
                      </div>
                    ))}
                  </div>
                ) : null}
                <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.6 }}>
                  Continuing will change the affected transaction{deleteImportedDialog.totalTxnCount === 1 ? '' : 's'} to uncategorized, and they will need to be categorized again.
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.55 }}>
                  That part of the operation cannot be undone from this workspace.
                </div>
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  gap: 10,
                  padding: '0 18px 18px',
                }}
              >
                <Button
                  variant="ghost"
                  onClick={() => setDeleteImportedDialog(null)}
                  disabled={deleteImportedSaving}
                >
                  Cancel
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => finishDeleteImportedChild()}
                  disabled={deleteImportedSaving}
                >
                  {deleteImportedSaving ? 'Deleting…' : 'Continue'}
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
