// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import {
  cloneImportCategoryMappingSnapshot,
  createImportCategoryMappingDraftState,
} from '../lib/importCategoryMappingStateLegacy.js'
import { Button } from './ui.jsx'
import {
  clearCategoryTreeDragItem,
  getCategoryTreeDragItem,
  setCategoryTreeDragItem,
} from './CategoryTreePrimitives.jsx'

export { createImportCategoryMappingDraftState }

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

function sanitizeSnapshotForPersistence(snapshot) {
  const next = cloneImportCategoryMappingSnapshot(snapshot)
  const removedIds = new Set()
  const removedSourceValues = []

  for (const sectionType of ['income', 'expense']) {
    next.tree[sectionType] = (next.tree[sectionType] || [])
      .filter(group => {
        const keepGroup = !(group?.isNew && !String(group?.name || '').trim())
        if (!keepGroup) removedIds.add(group.id)
        return keepGroup
      })
      .map(group => {
        const keptChildren = (group.children || []).filter(child => {
          const removeChild = child?.isNew && !String(child?.name || '').trim()
          if (removeChild) {
            removedIds.add(child.id)
            const mappedSource = child?.sourceId || child?.sourceValue || child?.name
            if (child?.importBadge === 'new' && mappedSource) removedSourceValues.push(mappedSource)
          }
          return !removeChild
        })
        return { ...group, children: keptChildren }
      })
  }

  for (const rawValue of Object.keys(next.mappings || {})) {
    const mapping = next.mappings[rawValue]
    if (mapping?.targetId && removedIds.has(mapping.targetId)) delete next.mappings[rawValue]
  }

  // setAsideOrder is part of the reusable mapping workspace state. It is not
  // transient UI chrome and should stay separate from sourceOrder so provider-
  // level "set aside" decisions can survive save/restore with the import profile.
  if (removedSourceValues.length) {
    const existing = new Set([...(next.sourceOrder || []), ...(next.setAsideOrder || [])])
    next.sourceOrder = Array.from(new Set([...(next.sourceOrder || []), ...removedSourceValues.filter(value => !existing.has(value) || (next.sourceOrder || []).includes(value))]))
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  }

  if (next.selectedNodeId && removedIds.has(next.selectedNodeId)) next.selectedNodeId = null

  return next
}

function statusPill(label) {
  const background = 'color-mix(in srgb, var(--surface2) 88%, #0f172a)'
  const color = '#a5f3fc'
  const text = String(label || '').trim().slice(0, 1).toLowerCase() || 'f'
  return (
    <span
      title={label}
      aria-label={label}
      style={{
        width: 15,
        height: 15,
        borderRadius: 999,
        border: '1px solid color-mix(in srgb, #67e8f9 30%, var(--border))',
        background,
        color,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 9,
        fontWeight: 700,
        lineHeight: 1,
        textTransform: 'lowercase',
        flexShrink: 0,
      }}
    >
      {text}
    </span>
  )
}

function removeTone(isInUse) {
  return isInUse
    ? 'color-mix(in srgb, #f59e0b 72%, var(--text))'
    : 'var(--muted)'
}

function pillRemoveButtonStyle(color) {
  return {
    position: 'absolute',
    right: -2,
    top: '50%',
    transform: 'translateY(-50%)',
    border: 'none',
    background: 'transparent',
    color,
    fontSize: 11,
    cursor: 'pointer',
    padding: 0,
    width: 26,
    height: 24,
    borderRadius: 999,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    lineHeight: 1,
    flexShrink: 0,
    zIndex: 3,
  }
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

function pillTrailingNoDragZone() {
  return (
    <span
      data-pill-no-drag="true"
      style={{
        width: 18,
        alignSelf: 'stretch',
        marginLeft: -6,
        marginRight: -8,
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
        <span style={{ fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap', color: 'var(--text)', fontStyle: 'italic' }}>{label}</span>
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
          onDragOver={event => event.preventDefault()}
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

function categoryPillStyle(category, selected, grouped = false) {
  const isNewFromFile = category.importBadge === 'new'
  const isManual = category.isNew && category.importBadge !== 'new'
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '5px 10px',
    borderRadius: 999,
    border: isNewFromFile
      ? `1px dashed ${selected ? 'color-mix(in srgb, white 74%, var(--accent))' : 'color-mix(in srgb, var(--accent) 28%, var(--border))'}`
      : isManual
        ? `1px solid ${selected ? 'color-mix(in srgb, var(--accent) 56%, var(--border))' : 'color-mix(in srgb, var(--accent) 26%, var(--border))'}`
        : snapshotSelectedBorder(selected),
    background: isNewFromFile
      ? (selected
          ? 'linear-gradient(180deg, color-mix(in srgb, #7c83ff 28%, var(--surface)), color-mix(in srgb, #7c83ff 18%, var(--surface)))'
          : 'linear-gradient(180deg, color-mix(in srgb, var(--surface2) 92%, var(--surface)), color-mix(in srgb, var(--surface2) 68%, var(--surface)))')
      : isManual
        ? (selected
            ? 'linear-gradient(180deg, color-mix(in srgb, var(--accent) 24%, var(--surface)), color-mix(in srgb, var(--accent) 16%, var(--surface)))'
            : 'color-mix(in srgb, var(--accent) 8%, var(--surface))')
        : snapshotSelectedBackground(selected),
    boxShadow: selected
      ? (isNewFromFile
          ? '0 0 0 2px color-mix(in srgb, white 12%, transparent), 0 10px 22px rgba(15, 23, 42, 0.22)'
          : '0 0 0 2px color-mix(in srgb, var(--accent) 18%, transparent), 0 10px 22px rgba(15, 23, 42, 0.2)')
      : (isNewFromFile ? '0 5px 16px rgba(15, 23, 42, 0.08)' : '0 4px 12px rgba(15, 23, 42, 0.12)'),
    transform: selected ? 'translateY(-1px) scale(1.03)' : 'none',
    transformOrigin: 'center',
    cursor: 'grab',
    outline: grouped ? '2px dashed color-mix(in srgb, var(--accent) 42%, var(--border))' : 'none',
    outlineOffset: grouped ? 2 : 0,
    userSelect: 'none',
  }
}

function snapshotSelectedBorder(selected) {
  return selected
    ? '1px dashed color-mix(in srgb, white 74%, var(--accent))'
    : '1px solid color-mix(in srgb, var(--border) 82%, transparent)'
}

function snapshotSelectedBackground(selected) {
  return selected
    ? 'linear-gradient(180deg, color-mix(in srgb, var(--accent) 22%, var(--surface)), color-mix(in srgb, var(--accent) 14%, var(--surface)))'
    : 'color-mix(in srgb, var(--surface2) 70%, var(--surface))'
}

function buildMultiDragPreview(categories) {
  if (!categories.length || typeof document === 'undefined') return null
  const visibleDepth = Math.max(1, Math.min(categories.length, 10))
  const width = 220 + (visibleDepth - 1) * 14
  const height = 68 + (visibleDepth - 1) * 11
  const canvas = document.createElement('canvas')
  const scale = window.devicePixelRatio || 1
  canvas.width = width * scale
  canvas.height = height * scale
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.scale(scale, scale)

  function roundRectPath(x, y, w, h, r) {
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.lineTo(x + w - r, y)
    ctx.quadraticCurveTo(x + w, y, x + w, y + r)
    ctx.lineTo(x + w, y + h - r)
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
    ctx.lineTo(x + r, y + h)
    ctx.quadraticCurveTo(x, y + h, x, y + h - r)
    ctx.lineTo(x, y + r)
    ctx.quadraticCurveTo(x, y, x + r, y)
    ctx.closePath()
  }

  for (let i = visibleDepth - 1; i >= 0; i -= 1) {
    const x = 16 + i * 14
    const y = 12 + i * 11
    const w = 170
    const h = 38
    ctx.save()
    ctx.shadowColor = 'rgba(15, 23, 42, 0.22)'
    ctx.shadowBlur = 18
    ctx.shadowOffsetY = 8
    roundRectPath(x, y, w, h, 19)
    ctx.fillStyle = i === 0 ? '#3730a3' : '#262c43'
    ctx.fill()
    ctx.restore()
    roundRectPath(x, y, w, h, 19)
    ctx.lineWidth = 1.5
    ctx.strokeStyle = i === 0 ? '#6366f1' : '#4f5aa8'
    ctx.stroke()

    if (i === 0) {
      ctx.fillStyle = '#f8fafc'
      ctx.font = 'italic 600 12px Segoe UI'
      ctx.textBaseline = 'middle'
      const label = categories[0]?.name || 'category name'
      ctx.fillText(label, x + 16, y + h / 2)
    }
  }

  ctx.save()
  ctx.shadowColor = 'rgba(15, 23, 42, 0.24)'
  ctx.shadowBlur = 16
  ctx.shadowOffsetY = 8
  ctx.beginPath()
  ctx.arc(18, 18, 14, 0, Math.PI * 2)
  ctx.fillStyle = '#5b6cff'
  ctx.fill()
  ctx.restore()
  ctx.fillStyle = '#ffffff'
  ctx.font = '700 12px Segoe UI'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(String(categories.length), 18, 18)

  return canvas
}

function mappedSourcePill(label, compact = false, onRemove = null, dragProps = null) {
  return (
    <span
      draggable={!!dragProps}
      onDragStart={dragProps?.onDragStart}
      onDragEnd={dragProps?.onDragEnd}
      style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      padding: compact ? '2px 7px' : '4px 9px',
      borderRadius: 999,
      border: '1px dashed color-mix(in srgb, var(--accent) 28%, var(--border))',
      background: compact
        ? 'linear-gradient(180deg, color-mix(in srgb, var(--surface2) 98%, var(--surface)), color-mix(in srgb, var(--surface2) 76%, var(--surface)))'
        : 'linear-gradient(180deg, color-mix(in srgb, var(--surface2) 92%, var(--surface)), color-mix(in srgb, var(--surface2) 68%, var(--surface)))',
      color: 'var(--text)',
      maxWidth: '100%',
      fontSize: compact ? 10.5 : 12,
      fontStyle: 'italic',
      whiteSpace: 'nowrap',
      boxShadow: compact ? '0 3px 10px rgba(15, 23, 42, 0.14)' : 'none',
      cursor: dragProps ? 'grab' : 'default',
      userSelect: 'none',
    }}>
      {pillNoDragZone()}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      {pillTrailingNoDragZone()}
      {onRemove ? (
        <button
          onMouseDown={e => {
            e.preventDefault()
            e.stopPropagation()
          }}
          onClick={e => {
            e.stopPropagation()
            onRemove()
          }}
          style={{
            ...pillRemoveButtonStyle('var(--muted)'),
            fontSize: compact ? 10 : 11,
          }}
        >
          x
        </button>
      ) : null}
    </span>
  )
}

function ChoiceDialog({ choice, onChoose, onCancel }) {
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
    <div style={{ position: 'fixed', inset: 0, zIndex: 1400, background: 'rgba(15, 23, 42, 0.24)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div ref={ref} style={{ width: 'min(430px, 100%)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, boxShadow: '0 28px 70px rgba(15, 23, 42, 0.32)', overflow: 'hidden' }}>
        <div style={{ padding: '18px 18px 12px', borderBottom: '1px solid var(--border)', background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface2) 88%, var(--surface)), color-mix(in srgb, var(--surface2) 70%, var(--surface)))' }}>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Place selected categories</div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>{choice.sourceIds.length} file categories were dropped on <strong>{choice.targetName}</strong>.</div>
        </div>
        <div style={{ padding: 16, display: 'grid', gap: 10 }}>
          <button onClick={() => onChoose('group')} style={{ textAlign: 'left', background: 'color-mix(in srgb, var(--surface2) 68%, var(--surface))', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 14px', cursor: 'pointer', color: 'var(--text)' }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>Add all to group</div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>Create these categories in <strong>{choice.groupName}</strong>.</div>
          </button>
          <button onClick={() => onChoose('category')} style={{ textAlign: 'left', background: 'color-mix(in srgb, var(--surface2) 68%, var(--surface))', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 14px', cursor: 'pointer', color: 'var(--text)' }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>Map all to category</div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>Map them all to <strong>{choice.targetName}</strong>.</div>
          </button>
        </div>
      </div>
    </div>
  )
}

export default function ImportCategoryMappingWorkspaceBuckets({ sourceValues, sourceMeta, existingCategories, initialAssignments, initialDraftState, onDraftStateChange, onApply, onClose }) {
  const computedInitialDraftState = useMemo(() => createImportCategoryMappingDraftState(existingCategories, sourceValues, initialAssignments), [existingCategories, initialAssignments, sourceValues])
  const [snapshot, setSnapshot] = useState(() => sanitizeSnapshotForPersistence((initialDraftState || computedInitialDraftState).snapshot))
  const [undoStack, setUndoStack] = useState(() => (initialDraftState?.undoStack || []).map(sanitizeSnapshotForPersistence))
  const [redoStack, setRedoStack] = useState(() => (initialDraftState?.redoStack || []).map(sanitizeSnapshotForPersistence))
  const [selectionAnchor, setSelectionAnchor] = useState(initialDraftState?.selectionAnchor || null)
  const [selectedBucketCategoryIds, setSelectedBucketCategoryIds] = useState(initialDraftState?.selectedBucketCategoryIds || [])
  const [bucketSelectionAnchor, setBucketSelectionAnchor] = useState(initialDraftState?.bucketSelectionAnchor || null)
  const [saving, setSaving] = useState(false)
  const [activeSection, setActiveSection] = useState(initialDraftState?.activeSection || 'expense')
  const [editingId, setEditingId] = useState(null)
  const [editingValue, setEditingValue] = useState('')
  const [pendingChoice, setPendingChoice] = useState(null)
  const [categoryUsage, setCategoryUsage] = useState({})
  const [dragGroupIds, setDragGroupIds] = useState([])
  const [dragSourceGroupIds, setDragSourceGroupIds] = useState([])
  const [dragLeadId, setDragLeadId] = useState(null)
  const [dragSourceLeadId, setDragSourceLeadId] = useState(null)
  const [panelMenu, setPanelMenu] = useState(null)
  const [groupMenu, setGroupMenu] = useState(null)
  const [resetMenu, setResetMenu] = useState(null)
  const [sourceMenu, setSourceMenu] = useState(null)
  const [floatingGroupDraft, setFloatingGroupDraft] = useState(null)
  const sourceScrollRef = useRef(null)
  const bucketScrollRef = useRef(null)

  function buildCurrentDraftState() {
    return {
      snapshot: sanitizeSnapshotForPersistence(snapshot),
      undoStack: undoStack.map(sanitizeSnapshotForPersistence),
      redoStack: redoStack.map(sanitizeSnapshotForPersistence),
      selectionAnchor,
      selectedBucketCategoryIds,
      bucketSelectionAnchor,
      activeSection,
    }
  }

  useEffect(() => {
    onDraftStateChange?.(buildCurrentDraftState())
  }, [activeSection, bucketSelectionAnchor, onDraftStateChange, redoStack, selectedBucketCategoryIds, selectionAnchor, snapshot, undoStack])

  useEffect(() => {
    let cancelled = false
    api.getCategoryUsageSummary().then(summary => { if (!cancelled) setCategoryUsage(summary || {}) }).catch(() => { if (!cancelled) setCategoryUsage({}) })
    return () => { cancelled = true }
  }, [existingCategories])

  useEffect(() => {
    if (!panelMenu) return undefined
    function dismiss() {
      setPanelMenu(null)
    }
    window.addEventListener('mousedown', dismiss)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('mousedown', dismiss)
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [panelMenu])

  useEffect(() => {
    if (!groupMenu) return undefined
    function dismiss() {
      setGroupMenu(null)
    }
    window.addEventListener('mousedown', dismiss)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('mousedown', dismiss)
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [groupMenu])

  useEffect(() => {
    if (!resetMenu) return undefined
    function dismiss() {
      setResetMenu(null)
    }
    window.addEventListener('mousedown', dismiss)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('mousedown', dismiss)
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [resetMenu])

  useEffect(() => {
    if (!sourceMenu) return undefined
    function dismiss() {
      setSourceMenu(null)
    }
    window.addEventListener('mousedown', dismiss)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('mousedown', dismiss)
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [sourceMenu])

  useEffect(() => {
    if (!floatingGroupDraft) return undefined
    function dismiss(event) {
      const target = event.target
      if (target?.closest?.('[data-floating-group-draft="true"]')) return
      if (floatingGroupDraft.name.trim()) {
        finalizeFloatingGroupDraft()
      }
    }
    window.addEventListener('mousedown', dismiss)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('mousedown', dismiss)
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [floatingGroupDraft])

  function applySnapshotChange(mutator) {
    const next = cloneImportCategoryMappingSnapshot(snapshot)
    mutator(next)
    setUndoStack(prev => [...prev, cloneImportCategoryMappingSnapshot(snapshot)])
    setRedoStack([])
    setSnapshot(next)
  }

  function resetCategoriesOnly() {
    applySnapshotChange(next => {
      for (const sectionType of ['income', 'expense']) {
        for (const group of next.tree[sectionType]) group.children = []
      }
      next.mappings = {}
      next.sourceOrder = (sourceValues || []).filter(Boolean).slice().sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      next.selectedSourceIds = []
      next.selectedNodeId = null
    })
    setSelectedBucketCategoryIds([])
    setBucketSelectionAnchor(null)
    setResetMenu(null)
  }

  function resetEntireWorkspace() {
    applySnapshotChange(next => {
      next.tree = { income: [], expense: [] }
      next.mappings = {}
      next.sourceOrder = (sourceValues || []).filter(Boolean).slice().sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      next.selectedSourceIds = []
      next.selectedNodeId = null
      next.collapsedGroups = {}
    })
    setSelectedBucketCategoryIds([])
    setBucketSelectionAnchor(null)
    setResetMenu(null)
  }

  function setAllGroupsCollapsed(sectionType, collapsed) {
    setSnapshot(prev => {
      const nextCollapsed = { ...(prev.collapsedGroups || {}) }
      for (const group of prev.tree[sectionType] || []) {
        nextCollapsed[group.id] = collapsed
      }
      return { ...prev, collapsedGroups: nextCollapsed }
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

  function sourceSelectionLocation(currentSnapshot = snapshot) {
    if (!(currentSnapshot.selectedSourceIds || []).length) return null
    const setAside = new Set(currentSnapshot.setAsideOrder || [])
    return currentSnapshot.selectedSourceIds.every(id => setAside.has(id)) ? 'setAside' : 'active'
  }

  function usageInUse(node) {
    const direct = categoryUsage[node.id] || {}
    if (node.parentId) return !!direct.is_in_use
    return !!((node.children || []).some(child => categoryUsage[child.id]?.is_in_use) || direct.is_in_use)
  }

  function syncMappedPresentation(next) {
    const mappedTargets = new Set(
      Object.values(next.mappings || {})
        .filter(mapping => mapping?.resolution === 'existing' && mapping?.targetId)
        .map(mapping => mapping.targetId),
    )
    for (const sectionType of ['income', 'expense']) {
      for (const group of next.tree[sectionType] || []) {
        for (const child of group.children || []) {
          if (child.importBadge === 'new') continue
          child.importBadge = mappedTargets.has(child.id) ? 'mapped' : null
        }
      }
    }
  }

  function beginEdit(nodeId, currentName) {
    setEditingId(nodeId)
    setEditingValue(currentName)
    setSnapshot(prev => ({ ...prev, selectedNodeId: nodeId }))
  }

  function addGroup(sectionType) {
    const id = createTempId('group')
    applySnapshotChange(next => {
      next.tree[sectionType].push({ id, name: '', categoryType: sectionType, isNew: true, importBadge: null, children: [] })
      next.tree[sectionType].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      next.selectedNodeId = id
    })
    setEditingId(id)
    setEditingValue('')
  }

  function addCategoryToGroup(groupId) {
    const id = createTempId('category')
    applySnapshotChange(next => {
      const info = findNode(next.tree, groupId)
      if (!info?.node) return
      info.node.children.push({ id, parentId: groupId, name: '', categoryType: info.sectionType, isNew: true, importBadge: null })
      next.selectedNodeId = id
    })
    setEditingId(id)
    setEditingValue('')
  }

  function startFloatingGroupDraft(sectionType, x, y) {
    const position = clampOverlayPosition(x, y, 250, 140)
    clearSourceSelection()
    clearBucketSelection()
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
      next.tree[sectionType].push({ id, name: name.trim(), categoryType: sectionType, isNew: true, importBadge: null, children: [] })
      next.tree[sectionType].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      next.selectedNodeId = id
    })
    setFloatingGroupDraft(null)
  }

  function handleNameClick(nodeId, currentName, event) {
    event.stopPropagation()
    const info = findNode(snapshot.tree, nodeId)
    if (info?.group && (event.shiftKey || event.ctrlKey || event.metaKey)) {
      handleSelectCategory(nodeId, info.group.id, event)
      return
    }
    if (info?.group) {
      clearSourceSelection()
      setSelectedBucketCategoryIds([nodeId])
      setBucketSelectionAnchor(nodeId)
      if (snapshot.selectedNodeId === nodeId && selectedBucketCategoryIds.length === 1 && selectedBucketCategoryIds[0] === nodeId) {
        beginEdit(nodeId, currentName)
        return
      }
      setSnapshot(prev => ({ ...prev, selectedNodeId: nodeId }))
      return
    }
    clearSourceSelection()
    clearBucketSelection(false)
    beginEdit(nodeId, currentName)
    return
  }

  function selectGroup(groupId) {
    clearSourceSelection()
    clearBucketSelection(false)
    setSnapshot(prev => ({ ...prev, selectedNodeId: groupId }))
  }

  function commitEdit() {
    if (!editingId || !editingValue.trim()) return setEditingId(null)
    applySnapshotChange(next => {
      const info = findNode(next.tree, editingId)
      if (info?.node) info.node.name = editingValue.trim()
      if (info?.node && !info.node.parentId) {
        next.tree[info.sectionType].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      }
    })
    setEditingId(null)
  }

  function handleEditBlur(event) {
    const value = event.target.value.trim()
    if (value) {
      commitEdit()
      return
    }
    const info = editingId ? findNode(snapshot.tree, editingId) : null
    if (info?.node?.isNew && !info.node.name) {
      requestAnimationFrame(() => {
        event.target?.focus()
      })
      return
    }
    setEditingId(null)
    setEditingValue('')
  }

  function handleSelectSource(id, event) {
    const activeIds = snapshot.sourceOrder.includes(id)
      ? snapshot.sourceOrder
      : snapshot.setAsideOrder.includes(id)
        ? snapshot.setAsideOrder
        : null
    const idx = activeIds ? activeIds.indexOf(id) : -1
    if (idx === -1) return
    clearBucketSelection()
    if (!event.shiftKey && !event.ctrlKey && !event.metaKey && snapshot.selectedSourceIds.length === 1 && snapshot.selectedSourceIds[0] === id) {
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
      const itemLocation = snapshot.setAsideOrder.includes(id) ? 'setAside' : 'active'
      if (currentLocation && currentLocation !== itemLocation) return
      setSnapshot(prev => ({ ...prev, selectedSourceIds: prev.selectedSourceIds.includes(id) ? prev.selectedSourceIds.filter(v => v !== id) : [...prev.selectedSourceIds, id] }))
      setSelectionAnchor(id)
      return
    }
    setSnapshot(prev => ({ ...prev, selectedSourceIds: [id] }))
    setSelectionAnchor(id)
  }

  function handleSourceDragStart(rawValue, event) {
    if (event.target?.closest?.('[data-pill-no-drag="true"]')) {
      event.preventDefault()
      return
    }
    const sourceIds = snapshot.selectedSourceIds.includes(rawValue) ? [...snapshot.selectedSourceIds] : [rawValue]
    if (!snapshot.selectedSourceIds.includes(rawValue)) {
      setSnapshot(prev => ({ ...prev, selectedSourceIds: [rawValue] }))
      setSelectionAnchor(rawValue)
    }
    setDragSourceGroupIds(sourceIds.length > 1 ? sourceIds : [])
    setDragSourceLeadId(rawValue)
    setCategoryTreeDragItem({ id: `source:${sourceIds[0]}`, isSource: true, sourceIds, fromSetAside: snapshot.setAsideOrder.includes(rawValue) })
    event.dataTransfer.effectAllowed = 'move'
  }

  function openSourceMenuAt(rawValue, event) {
    event.preventDefault()
    event.stopPropagation()
    clearBucketSelection()

    const inSetAside = snapshot.setAsideOrder.includes(rawValue)
    const currentLocation = sourceSelectionLocation()
    const alreadySelected = snapshot.selectedSourceIds.includes(rawValue)

    if (!alreadySelected || (currentLocation && currentLocation !== (inSetAside ? 'setAside' : 'active'))) {
      setSnapshot(prev => ({ ...prev, selectedSourceIds: [rawValue] }))
      setSelectionAnchor(rawValue)
    }

    const position = clampOverlayPosition(event.clientX, event.clientY, 168, 52)
    setSourceMenu({ x: position.x, y: position.y, mode: inSetAside ? 'restore' : 'setAside' })
  }

  function handleMappedSourceDragStart(rawValue, event) {
    if (event.target?.closest?.('[data-pill-no-drag="true"]')) {
      event.preventDefault()
      return
    }
    clearBucketSelection()
    setCategoryTreeDragItem({ id: `mapped:${rawValue}`, isSource: true, sourceIds: [rawValue], fromMapped: true })
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
          const start = Math.min(anchorIndex, currentIndex)
          const end = Math.max(anchorIndex, currentIndex)
          setSelectedBucketCategoryIds(groupChildren.slice(start, end + 1).map(child => child.id))
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

  function handleCategoryDragStart(category, event) {
    if (event.target?.closest?.('[data-pill-no-drag="true"]')) {
      event.preventDefault()
      return
    }
    const info = findNode(snapshot.tree, category.id)
    if (!info?.group) return
    clearSourceSelection()
    const categoryIds = selectedBucketCategoryIds.includes(category.id)
      ? selectedBucketCategoryIds.filter(id => findNode(snapshot.tree, id)?.group?.id === info.group.id)
      : [category.id]
    if (!selectedBucketCategoryIds.includes(category.id)) {
      setSelectedBucketCategoryIds([category.id])
      setBucketSelectionAnchor(category.id)
      setSnapshot(prev => ({ ...prev, selectedNodeId: category.id }))
    }
    const createdSourceIds = categoryIds
      .map(id => Object.values(snapshot.mappings || {}).find(mapping => mapping?.resolution === 'create' && mapping?.targetId === id)?.rawValue)
      .filter(Boolean)
    setCategoryTreeDragItem({
      id: category.id,
      ids: categoryIds,
      isSource: false,
      parentId: info.group.id,
      createdSourceIds,
    })
    setDragGroupIds(categoryIds.length > 1 ? categoryIds : [])
    setDragLeadId(category.id)
    if (categoryIds.length > 1) {
      const draggedCategories = categoryIds.map(id => findNode(snapshot.tree, id)?.node).filter(Boolean)
      const preview = buildMultiDragPreview(draggedCategories)
      if (preview) {
        event.dataTransfer.setDragImage(preview, 32, 18)
      }
    }
    event.dataTransfer.effectAllowed = 'move'
  }

  function applyAddSourceToGroup(sourceIds, groupId) {
    applySnapshotChange(next => {
      const info = findNode(next.tree, groupId)
      if (!info?.node || info.node.parentId) return
      for (const rawValue of sourceIds) {
        const childId = createTempId('category')
        info.node.children.push({ id: childId, parentId: groupId, name: rawValue, categoryType: info.sectionType, isNew: true, importBadge: 'new' })
        next.mappings[rawValue] = { rawValue, targetId: childId, resolution: 'create' }
      }
      next.sourceOrder = next.sourceOrder.filter(value => !sourceIds.includes(value))
      next.setAsideOrder = (next.setAsideOrder || []).filter(value => !sourceIds.includes(value))
      next.selectedSourceIds = []
      next.selectedNodeId = groupId
      syncMappedPresentation(next)
      next.tree[info.sectionType].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    })
    setSelectionAnchor(null)
    clearBucketSelection(false)
  }

  function applyMapSourceToCategory(sourceIds, categoryId) {
    applySnapshotChange(next => {
      const info = findNode(next.tree, categoryId)
      if (!info?.group) return
      info.node.importBadge = info.node.importBadge || 'mapped'
      for (const rawValue of sourceIds) next.mappings[rawValue] = { rawValue, targetId: categoryId, resolution: 'existing' }
      next.sourceOrder = next.sourceOrder.filter(value => !sourceIds.includes(value))
      next.setAsideOrder = (next.setAsideOrder || []).filter(value => !sourceIds.includes(value))
      next.selectedSourceIds = []
      next.selectedNodeId = categoryId
      syncMappedPresentation(next)
    })
    setSelectionAnchor(null)
    clearBucketSelection(false)
  }

  function moveCategoryToGroup(categoryIds, groupId) {
    applySnapshotChange(next => {
      const moved = []
      const ids = Array.isArray(categoryIds) ? categoryIds : [categoryIds]
      for (const categoryId of ids) {
        for (const sectionType of ['income', 'expense']) {
          for (const group of next.tree[sectionType]) {
            const idx = group.children.findIndex(child => child.id === categoryId)
            if (idx >= 0) {
              moved.push(group.children.splice(idx, 1)[0])
              break
            }
          }
          if (moved.some(child => child.id === categoryId)) break
        }
      }
      if (!moved.length) return
      const target = findNode(next.tree, groupId)
      if (!target?.node || target.node.parentId) return
      moved.forEach(child => {
        child.parentId = groupId
        child.categoryType = target.sectionType
      })
      target.node.children.push(...moved)
      next.selectedNodeId = moved[moved.length - 1].id
      next.tree[target.sectionType].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    })
    setSelectedBucketCategoryIds(Array.isArray(categoryIds) ? [...categoryIds] : [categoryIds])
    setBucketSelectionAnchor(Array.isArray(categoryIds) ? categoryIds[categoryIds.length - 1] : categoryIds)
  }

  function handleDropOnGroup(group) {
    const item = getCategoryTreeDragItem()
    if (!item) return
    if (item.isSource) applyAddSourceToGroup(item.sourceIds, group.id)
    else moveCategoryToGroup(item.ids || item.id, group.id)
    clearCategoryTreeDragItem()
    setDragGroupIds([])
    setDragSourceGroupIds([])
    setDragLeadId(null)
    setDragSourceLeadId(null)
  }

  function handleDropOnCategory(category) {
    const item = getCategoryTreeDragItem()
    if (!item) return
    if (item.isSource) {
      const info = findNode(snapshot.tree, category.id)
      if ((item.sourceIds || []).length > 1) setPendingChoice({ sourceIds: [...item.sourceIds], categoryId: category.id, groupId: info?.group?.id, targetName: category.name, groupName: info?.group?.name || '' })
      else applyMapSourceToCategory(item.sourceIds, category.id)
    } else {
      const info = findNode(snapshot.tree, category.id)
      if (info?.group) moveCategoryToGroup(item.ids || item.id, info.group.id)
    }
    clearCategoryTreeDragItem()
    setDragGroupIds([])
    setDragSourceGroupIds([])
    setDragLeadId(null)
    setDragSourceLeadId(null)
  }

  function removeNode(nodeId) {
    applySnapshotChange(next => {
      for (const sectionType of ['income', 'expense']) {
        const groups = next.tree[sectionType]
        const groupIndex = groups.findIndex(group => group.id === nodeId)
        if (groupIndex >= 0) {
          const [removedGroup] = groups.splice(groupIndex, 1)
          const removedIds = new Set([removedGroup.id, ...(removedGroup.children || []).map(child => child.id)])
          for (const [rawValue, mapping] of Object.entries(next.mappings)) if (removedIds.has(mapping.targetId)) { delete next.mappings[rawValue]; if (!next.sourceOrder.includes(rawValue)) next.sourceOrder.push(rawValue) }
          break
        }
        for (const group of groups) {
          const childIndex = group.children.findIndex(child => child.id === nodeId)
          if (childIndex >= 0) {
            const [removedChild] = group.children.splice(childIndex, 1)
            for (const [rawValue, mapping] of Object.entries(next.mappings)) if (mapping.targetId === removedChild.id) { delete next.mappings[rawValue]; if (!next.sourceOrder.includes(rawValue)) next.sourceOrder.push(rawValue) }
            break
          }
        }
      }
      next.sourceOrder.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      if (next.selectedNodeId === nodeId) next.selectedNodeId = null
      syncMappedPresentation(next)
    })
    setSelectedBucketCategoryIds(prev => prev.filter(id => id !== nodeId))
    setBucketSelectionAnchor(prev => (prev === nodeId ? null : prev))
  }

  function unmapSource(rawValue) {
    applySnapshotChange(next => {
      delete next.mappings[rawValue]
      if (!next.sourceOrder.includes(rawValue) && !(next.setAsideOrder || []).includes(rawValue)) next.sourceOrder.push(rawValue)
      next.sourceOrder.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      syncMappedPresentation(next)
    })
  }

  function returnMappedSourceToPool(rawValue) {
    unmapSource(rawValue)
    clearCategoryTreeDragItem()
  }

  function returnCreatedSourcesToPool(rawValues) {
    applySnapshotChange(next => {
      const targetIds = new Set(
        rawValues
          .map(rawValue => next.mappings?.[rawValue])
          .filter(mapping => mapping?.resolution === 'create' && mapping?.targetId)
          .map(mapping => mapping.targetId),
      )
      for (const sectionType of ['income', 'expense']) {
        for (const group of next.tree[sectionType] || []) {
          group.children = (group.children || []).filter(child => !targetIds.has(child.id))
        }
      }
      for (const rawValue of rawValues) delete next.mappings[rawValue]
      next.setAsideOrder = (next.setAsideOrder || []).filter(value => !rawValues.includes(value))
      for (const rawValue of rawValues) if (!next.sourceOrder.includes(rawValue)) next.sourceOrder.push(rawValue)
      next.sourceOrder.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      syncMappedPresentation(next)
    })
    clearCategoryTreeDragItem()
  }

  function moveSelectedSourcesToSetAside() {
    if (!snapshot.selectedSourceIds.length) return
    applySnapshotChange(next => {
      const moveIds = next.selectedSourceIds.filter(id => next.sourceOrder.includes(id))
      next.sourceOrder = next.sourceOrder.filter(value => !moveIds.includes(value))
      next.setAsideOrder = Array.from(new Set([...(next.setAsideOrder || []), ...moveIds])).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      next.selectedSourceIds = []
    })
    setSelectionAnchor(null)
    setSourceMenu(null)
  }

  function restoreSelectedSources() {
    if (!snapshot.selectedSourceIds.length) return
    applySnapshotChange(next => {
      const restoreIds = next.selectedSourceIds.filter(id => (next.setAsideOrder || []).includes(id))
      next.setAsideOrder = (next.setAsideOrder || []).filter(value => !restoreIds.includes(value))
      next.sourceOrder = Array.from(new Set([...(next.sourceOrder || []), ...restoreIds])).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      next.selectedSourceIds = []
    })
    setSelectionAnchor(null)
    setSourceMenu(null)
  }

  function handleDropOnSetAside() {
    const item = getCategoryTreeDragItem()
    if (!item?.isSource || item?.fromMapped || item?.createdSourceIds?.length || item?.fromSetAside) return
    applySnapshotChange(next => {
      const moveIds = (item.sourceIds || []).filter(id => next.sourceOrder.includes(id))
      next.sourceOrder = next.sourceOrder.filter(value => !moveIds.includes(value))
      next.setAsideOrder = Array.from(new Set([...(next.setAsideOrder || []), ...moveIds])).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      next.selectedSourceIds = []
    })
    clearCategoryTreeDragItem()
    setDragSourceGroupIds([])
    setDragSourceLeadId(null)
    setSelectionAnchor(null)
  }

  function handleDropOnActiveSourcePool() {
    const item = getCategoryTreeDragItem()
    if (item?.isSource && item?.fromMapped && item.sourceIds?.[0]) return returnMappedSourceToPool(item.sourceIds[0])
    if (item?.createdSourceIds?.length) return returnCreatedSourcesToPool(item.createdSourceIds)
    if (item?.isSource && item?.fromSetAside) {
      applySnapshotChange(next => {
        const restoreIds = (item.sourceIds || []).filter(id => (next.setAsideOrder || []).includes(id))
        next.setAsideOrder = (next.setAsideOrder || []).filter(value => !restoreIds.includes(value))
        next.sourceOrder = Array.from(new Set([...(next.sourceOrder || []), ...restoreIds])).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
        next.selectedSourceIds = []
      })
      clearCategoryTreeDragItem()
      setDragSourceGroupIds([])
      setDragSourceLeadId(null)
      setSelectionAnchor(null)
    }
  }

  const groups = snapshot.tree[activeSection] || []
  const activeGroupMenuGroup = groupMenu ? groups.find(group => group.id === groupMenu.groupId) || null : null
  const activeSourceCount = snapshot.sourceOrder.length
  const processedCount = Math.max(0, (sourceValues || []).filter(Boolean).length - activeSourceCount)
  const sourceSelectionInSetAside = sourceSelectionLocation() === 'setAside'
  const setAsideCollapsed = !!snapshot.collapsedGroups.__setAside
  const mappedSourcesByTarget = useMemo(() => {
    const byTarget = {}
    for (const [rawValue, mapping] of Object.entries(snapshot.mappings || {})) {
      if (mapping?.resolution !== 'existing' || !mapping?.targetId) continue
      ;(byTarget[mapping.targetId] ||= []).push(rawValue)
    }
    Object.values(byTarget).forEach(values => values.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })))
    return byTarget
  }, [snapshot.mappings])

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(15, 23, 42, 0.44)', padding: 20, display: 'flex', alignItems: 'stretch', justifyContent: 'center' }}>
      <div style={{ width: 'min(1280px, 100%)', background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface2) 55%, var(--surface)), var(--surface))', border: '1px solid var(--border)', borderRadius: 18, boxShadow: '0 32px 88px rgba(15, 23, 42, 0.3)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '18px 22px 14px', borderBottom: '1px solid var(--border)', background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface2) 84%, var(--surface)), color-mix(in srgb, var(--surface2) 62%, var(--surface)))' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 18 }}>
            <div>
              <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 6 }}>Map Categories</div>
              <div style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 680, lineHeight: 1.55 }}>
                Map categories from the .csv file, {activeSourceCount > 0 ? `${activeSourceCount} awaiting processing` : `${processedCount} processed`}.
              </div>
              {sourceMeta?.truncated ? (
                <div style={{ marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 12, border: '1px solid color-mix(in srgb, #f59e0b 34%, var(--border))', background: 'color-mix(in srgb, #f59e0b 10%, var(--surface2))', color: 'color-mix(in srgb, #f59e0b 72%, var(--text))', fontSize: 11, lineHeight: 1.4 }}>
                  <span>This column has {sourceMeta.total_count} unique values. Showing the first {sourceMeta.limit} here.</span>
                </div>
              ) : null}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <div style={{ display: 'inline-flex', gap: 4, padding: 4, borderRadius: 999, background: 'color-mix(in srgb, var(--surface2) 60%, var(--surface))', border: '1px solid color-mix(in srgb, var(--border) 82%, transparent)' }}>
                <Button variant="ghost" onClick={onClose}>Keep Draft & Close</Button>
                <Button
                  variant={activeSourceCount === 0 ? 'primary' : 'ghost'}
                  onClick={async () => { setSaving(true); try { await onApply(buildCurrentDraftState()) } finally { setSaving(false) } }}
                  disabled={saving}
                >
                  {saving ? 'Saving…' : 'Save & Close'}
                </Button>
              </div>
              <div style={{ display: 'inline-flex', gap: 4, padding: 4, borderRadius: 999, background: 'color-mix(in srgb, var(--surface2) 60%, var(--surface))', border: '1px solid color-mix(in srgb, var(--border) 82%, transparent)' }}>
                <Button variant="ghost" onClick={() => { if (!redoStack.length) return; const next = redoStack[redoStack.length - 1]; setUndoStack(u => [...u, cloneImportCategoryMappingSnapshot(snapshot)]); setRedoStack(r => r.slice(0, -1)); setSnapshot(cloneImportCategoryMappingSnapshot(next)); setEditingId(null) }} disabled={redoStack.length === 0}>Redo</Button>
                <Button variant="ghost" onClick={() => { if (!undoStack.length) return; const prev = undoStack[undoStack.length - 1]; setRedoStack(r => [...r, cloneImportCategoryMappingSnapshot(snapshot)]); setUndoStack(u => u.slice(0, -1)); setSnapshot(cloneImportCategoryMappingSnapshot(prev)); setEditingId(null) }} disabled={undoStack.length === 0}>Undo</Button>
              </div>
            </div>
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '320px 1fr' }}>
          <div style={{ borderRight: '1px solid var(--border)', minHeight: 0, display: 'flex', flexDirection: 'column', background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface) 88%, black), color-mix(in srgb, var(--surface) 96%, black))' }}>
            <div style={{ padding: '16px 16px 12px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 4 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>File Categories</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  <button
                    onClick={() => {
                      if (!snapshot.selectedSourceIds.length) return
                      if (sourceSelectionInSetAside) restoreSelectedSources()
                      else moveSelectedSourcesToSetAside()
                    }}
                    disabled={snapshot.selectedSourceIds.length === 0}
                    style={{
                      background: 'color-mix(in srgb, var(--surface2) 70%, var(--surface))',
                      border: '1px solid var(--border)',
                      borderRadius: 999,
                      padding: '4px 10px',
                      fontSize: 11,
                      color: snapshot.selectedSourceIds.length === 0 ? 'color-mix(in srgb, var(--muted) 62%, transparent)' : 'var(--muted)',
                      cursor: snapshot.selectedSourceIds.length === 0 ? 'default' : 'pointer',
                      opacity: snapshot.selectedSourceIds.length === 0 ? 0.72 : 1,
                    }}
                  >
                    {sourceSelectionInSetAside ? 'restore' : 'set aside'}
                  </button>
                  <button
                    onClick={() => {
                      if (!snapshot.selectedSourceIds.length) return
                      setSnapshot(prev => ({ ...prev, selectedSourceIds: [] }))
                      setSelectionAnchor(null)
                    }}
                    disabled={snapshot.selectedSourceIds.length === 0}
                    style={{
                      background: 'color-mix(in srgb, var(--surface2) 70%, var(--surface))',
                      border: '1px solid var(--border)',
                      borderRadius: 999,
                      padding: '4px 10px',
                      fontSize: 11,
                      color: snapshot.selectedSourceIds.length === 0 ? 'color-mix(in srgb, var(--muted) 62%, transparent)' : 'var(--muted)',
                      cursor: snapshot.selectedSourceIds.length === 0 ? 'default' : 'pointer',
                      opacity: snapshot.selectedSourceIds.length === 0 ? 0.72 : 1,
                    }}
                  >
                    clear selection
                  </button>
                </div>
              </div>
            </div>
              <div
                style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 12, background: 'color-mix(in srgb, var(--surface) 92%, black)' }}
                ref={sourceScrollRef}
                onDragOver={event => {
                  autoScrollContainer(sourceScrollRef.current, event.clientY)
                  const item = getCategoryTreeDragItem()
                  if ((item?.isSource && item?.fromMapped) || item?.createdSourceIds?.length) event.preventDefault()
                  else if (item?.isSource) event.preventDefault()
                }}
                onDrop={event => {
                  event.preventDefault()
                  handleDropOnActiveSourcePool()
                }}
                onContextMenu={event => {
                  if (!snapshot.selectedSourceIds.length) return
                  event.preventDefault()
                  const position = clampOverlayPosition(event.clientX, event.clientY, 168, 52)
                  setSourceMenu({ x: position.x, y: position.y, mode: sourceSelectionInSetAside ? 'restore' : 'setAside' })
                }}
              >
                {snapshot.sourceOrder.length > 0 ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignContent: 'flex-start', gap: 8 }}>
                    {snapshot.sourceOrder.map(rawValue => {
                      const showDragCount = dragSourceGroupIds.length > 1 && dragSourceLeadId === rawValue
                      return <button key={rawValue} type="button" draggable onClick={event => handleSelectSource(rawValue, event)} onContextMenu={event => openSourceMenuAt(rawValue, event)} onDragStart={event => handleSourceDragStart(rawValue, event)} onDragEnd={() => { clearCategoryTreeDragItem(); setDragSourceGroupIds([]); setDragSourceLeadId(null) }} style={{ border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', color: 'var(--text)', outline: 'none' }}><SourceChip label={rawValue} selected={snapshot.selectedSourceIds.includes(rawValue)} grouped={dragSourceGroupIds.includes(rawValue)} groupCount={dragSourceGroupIds.length} showCount={showDragCount} /></button>
                    })}
                  </div>
                ) : (
                  <div style={{ minHeight: 36, display: 'grid', placeItems: 'center', textAlign: 'center', padding: '6px 0 2px', fontSize: 12, color: 'var(--muted)' }}>&lt;none&gt;</div>
                )}
              <SetAsideTray
                count={(snapshot.setAsideOrder || []).length}
                selected={sourceSelectionInSetAside}
                collapsed={setAsideCollapsed}
                onToggle={() => setSnapshot(prev => ({ ...prev, collapsedGroups: { ...prev.collapsedGroups, __setAside: !prev.collapsedGroups.__setAside } }))}
                onDrop={event => {
                  event.preventDefault()
                  handleDropOnSetAside()
                }}
                onContextMenu={event => {
                  if (!snapshot.selectedSourceIds.length || !sourceSelectionInSetAside) return
                  event.preventDefault()
                  const position = clampOverlayPosition(event.clientX, event.clientY, 168, 52)
                  setSourceMenu({ x: position.x, y: position.y, mode: 'restore' })
                }}
              >
                {(snapshot.setAsideOrder || []).length > 0 ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignContent: 'flex-start', gap: 8 }}>
                  {snapshot.setAsideOrder.map(rawValue => {
                    const showDragCount = dragSourceGroupIds.length > 1 && dragSourceLeadId === rawValue
                    return <button key={`aside:${rawValue}`} type="button" draggable onClick={event => handleSelectSource(rawValue, event)} onContextMenu={event => openSourceMenuAt(rawValue, event)} onDragStart={event => handleSourceDragStart(rawValue, event)} onDragEnd={() => { clearCategoryTreeDragItem(); setDragSourceGroupIds([]); setDragSourceLeadId(null) }} style={{ border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', color: 'var(--text)', outline: 'none' }}><SourceChip label={rawValue} selected={snapshot.selectedSourceIds.includes(rawValue)} grouped={dragSourceGroupIds.includes(rawValue)} groupCount={dragSourceGroupIds.length} showCount={showDragCount} /></button>
                  })}
                  </div>
                ) : (
                  <div style={{ minHeight: 52, borderRadius: 14, border: '1px dashed color-mix(in srgb, var(--border) 85%, transparent)', background: 'color-mix(in srgb, var(--surface2) 58%, var(--surface))', display: 'grid', placeItems: 'center', textAlign: 'center', padding: 12, fontSize: 12, color: 'var(--muted)' }}>&lt;empty&gt;</div>
                )}
              </SetAsideTray>
            </div>
          </div>

          <div style={{ minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '14px 16px 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ display: 'inline-flex', gap: 4, padding: 4, borderRadius: 999, background: 'color-mix(in srgb, var(--surface2) 74%, var(--surface))', border: '1px solid var(--border)' }}>
                  {['expense', 'income'].map(section => <button key={section} onClick={() => setActiveSection(section)} style={{ border: 'none', background: activeSection === section ? 'color-mix(in srgb, var(--surface) 82%, black)' : 'transparent', color: activeSection === section ? 'var(--text)' : 'var(--muted)', borderRadius: 999, padding: '7px 14px', fontSize: 12, fontWeight: activeSection === section ? 700 : 600, cursor: 'pointer', textTransform: 'capitalize' }}>{section}</button>)}
                </div>
                <button
                  type="button"
                  onClick={() => addGroup(activeSection)}
                  style={{
                    border: '1px solid color-mix(in srgb, var(--accent) 28%, var(--border))',
                    background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface2) 86%, var(--surface)), color-mix(in srgb, var(--surface2) 62%, var(--surface)))',
                    color: 'var(--text)',
                    borderRadius: 999,
                    padding: '8px 14px',
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: 'pointer',
                    boxShadow: '0 6px 14px rgba(15, 23, 42, 0.12)',
                  }}
                >
                  + New group
                </button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ position: 'relative', display: 'inline-flex', gap: 8, padding: 4, borderRadius: 999, background: 'color-mix(in srgb, var(--surface2) 60%, var(--surface))', border: '1px solid color-mix(in srgb, var(--border) 82%, transparent)' }}>
                  <button
                    type="button"
                    onClick={event => {
                      event.stopPropagation()
                      const rect = event.currentTarget.getBoundingClientRect()
                      const position = clampOverlayPosition(rect.right - 176, rect.bottom + 6, 176, 90)
                      setResetMenu(current => current ? null : { x: position.x, y: position.y })
                    }}
                    style={{
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--muted)',
                      borderRadius: 999,
                      padding: '7px 12px',
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    Clear…
                  </button>
                  {resetMenu ? (
                    <div
                      style={{
                        position: 'fixed',
                        left: resetMenu.x,
                        top: resetMenu.y,
                        zIndex: 1300,
                        minWidth: 176,
                        background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface2) 86%, var(--surface)), color-mix(in srgb, var(--surface2) 62%, var(--surface)))',
                        border: '1px solid var(--border)',
                        borderRadius: 12,
                        boxShadow: '0 18px 42px rgba(15, 23, 42, 0.32)',
                        padding: 6,
                      }}
                      onMouseDown={event => event.stopPropagation()}
                    >
                      <button
                        onClick={resetCategoriesOnly}
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
                        Clear categories
                      </button>
                      <button
                        onClick={resetEntireWorkspace}
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
                        Clear everything
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            <div
              style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 12, background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface2) 34%, var(--surface)), var(--surface))', position: 'relative' }}
              ref={bucketScrollRef}
              onDragOver={event => {
                autoScrollContainer(bucketScrollRef.current, event.clientY)
              }}
              onContextMenu={event => {
                if (event.target.closest('[data-bucket-card="true"]')) return
                event.preventDefault()
                clearSourceSelection()
                clearBucketSelection()
                const position = clampOverlayPosition(event.clientX, event.clientY, 170, 52)
                setPanelMenu({ x: position.x, y: position.y, sectionType: activeSection })
              }}
            >
              {groups.length === 0 ? <div style={{ minHeight: 180, borderRadius: 18, border: '1px dashed color-mix(in srgb, var(--border) 84%, transparent)', background: 'color-mix(in srgb, var(--surface2) 62%, var(--surface))', display: 'grid', placeItems: 'center', padding: 20, textAlign: 'center', color: 'var(--muted)' }}><div><div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6, color: 'var(--text)' }}>No {activeSection} groups yet</div><div style={{ fontSize: 13, lineHeight: 1.55 }}>Start by creating a group bucket, then drop file categories into it.</div></div></div> : <div style={{ columnWidth: 280, columnGap: 18 }}>
                {groups.map(group => (
                  <div key={group.id} data-bucket-card="true" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); handleDropOnGroup(group) }} style={{ breakInside: 'avoid', WebkitColumnBreakInside: 'avoid', pageBreakInside: 'avoid', display: 'inline-block', width: '100%', marginBottom: 18, borderRadius: 16, border: snapshot.selectedNodeId === group.id ? '1px solid color-mix(in srgb, var(--accent) 28%, var(--border))' : '1px solid var(--border)', background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface2) 70%, var(--surface)), color-mix(in srgb, var(--surface) 88%, black))', boxShadow: '0 10px 24px rgba(15, 23, 42, 0.16)', overflow: 'hidden' }}>
                    <div
                      onClick={() => selectGroup(group.id)}
                      onContextMenu={event => {
                        event.preventDefault()
                        event.stopPropagation()
                        clearSourceSelection()
                        clearBucketSelection(false)
                        setSnapshot(prev => ({ ...prev, selectedNodeId: group.id }))
                        const position = clampOverlayPosition(event.clientX, event.clientY, 170, 94)
                        setGroupMenu({ x: position.x, y: position.y, groupId: group.id })
                      }}
                      style={{ padding: '10px 11px 9px', borderBottom: snapshot.collapsedGroups[group.id] ? 'none' : '1px solid color-mix(in srgb, var(--border) 78%, transparent)', background: snapshot.selectedNodeId === group.id ? 'color-mix(in srgb, var(--accent) 10%, var(--surface))' : 'linear-gradient(180deg, color-mix(in srgb, var(--surface2) 86%, var(--surface)), color-mix(in srgb, var(--surface2) 62%, var(--surface)))', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <button onClick={e => { e.stopPropagation(); setSnapshot(prev => ({ ...prev, collapsedGroups: { ...prev.collapsedGroups, [group.id]: !prev.collapsedGroups[group.id] } })) }} style={{ width: 20, height: 20, borderRadius: 6, border: '1px solid var(--border)', background: 'color-mix(in srgb, var(--surface2) 70%, var(--surface))', color: 'var(--muted)', cursor: 'pointer' }}>{snapshot.collapsedGroups[group.id] ? '+' : '-'}</button>
                          {editingId === group.id ? <input autoFocus placeholder="Group name" value={editingValue} onChange={e => setEditingValue(e.target.value)} onBlur={handleEditBlur} onKeyDown={e => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') { setEditingId(null); setEditingValue('') } }} style={{ background: 'var(--bg)', color: 'var(--text)', border: '1px solid color-mix(in srgb, var(--accent) 55%, var(--border))', borderRadius: 8, padding: '4px 8px', fontSize: 14, fontWeight: 650, outline: 'none', width: '100%' }} /> : <div onClick={e => handleNameClick(group.id, group.name, e)} style={{ fontSize: 14, fontWeight: 650, color: 'color-mix(in srgb, var(--text) 88%, var(--muted))', cursor: 'text' }}>{group.name}</div>}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <button
                          onMouseDown={e => {
                            e.preventDefault()
                            e.stopPropagation()
                          }}
                          onClick={e => { e.stopPropagation(); removeNode(group.id) }}
                          style={{
                            border: `1px solid color-mix(in srgb, ${removeTone(usageInUse(group))} 42%, var(--border))`,
                            background: 'color-mix(in srgb, var(--surface) 82%, transparent)',
                            color: removeTone(usageInUse(group)),
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
                    {!snapshot.collapsedGroups[group.id] ? <div
                      data-group-body="true"
                      style={{ padding: '10px', minHeight: 86, overflow: 'hidden' }}
                      onContextMenu={event => {
                        event.preventDefault()
                        event.stopPropagation()
                        clearSourceSelection()
                        clearBucketSelection(false)
                        setSnapshot(prev => ({ ...prev, selectedNodeId: group.id }))
                        const position = clampOverlayPosition(event.clientX, event.clientY, 170, 94)
                        setGroupMenu({ x: position.x, y: position.y, groupId: group.id })
                      }}
                    >
                      <button
                        onClick={e => {
                          e.stopPropagation()
                          addCategoryToGroup(group.id)
                        }}
                        title="Add category"
                        style={{
                          float: 'right',
                          marginLeft: 8,
                          marginBottom: 8,
                          width: 22,
                          height: 22,
                          borderRadius: 999,
                          border: '1px solid color-mix(in srgb, var(--border) 82%, transparent)',
                          background: 'color-mix(in srgb, var(--surface2) 78%, var(--surface))',
                          color: 'var(--muted)',
                          fontSize: 15,
                          lineHeight: 1,
                          display: 'grid',
                          placeItems: 'center',
                          cursor: 'pointer',
                          boxShadow: '0 4px 12px rgba(15, 23, 42, 0.14)',
                        }}
                      >
                        +
                      </button>
                      {group.children.length === 0 ? <div style={{ minHeight: 72, borderRadius: 14, border: '1px dashed color-mix(in srgb, var(--border) 85%, transparent)', background: 'color-mix(in srgb, var(--surface2) 58%, var(--surface))', display: 'grid', placeItems: 'center', textAlign: 'center', padding: 12, fontSize: 12, color: 'var(--muted)' }}>&lt;empty&gt;</div> : group.children.map(child => {
                        const mappedSources = mappedSourcesByTarget[child.id] || []
                        const selected = selectedBucketCategoryIds.includes(child.id) || snapshot.selectedNodeId === child.id
                        if (mappedSources.length > 1) {
                          return (
                            <div
                              key={child.id}
                              draggable
                              onDragStart={event => handleCategoryDragStart(child, event)}
                              onDragEnd={() => { clearCategoryTreeDragItem(); setDragGroupIds([]); setDragLeadId(null) }}
                              onDragOver={event => event.preventDefault()}
                              onDrop={event => { event.preventDefault(); handleDropOnCategory(child) }}
                              onClick={event => handleSelectCategory(child.id, group.id, event)}
                              style={{
                                display: 'inline-flex',
                                flexDirection: 'column',
                                gap: 6,
                                padding: 8,
                                borderRadius: 14,
                                border: selected
                                  ? '1px solid color-mix(in srgb, var(--accent) 34%, var(--border))'
                                  : '1px solid color-mix(in srgb, var(--border) 82%, transparent)',
                                background: selected
                                  ? 'color-mix(in srgb, var(--accent) 10%, var(--surface))'
                                  : 'color-mix(in srgb, var(--surface2) 58%, var(--surface))',
                                boxShadow: '0 4px 12px rgba(15, 23, 42, 0.12)',
                                verticalAlign: 'top',
                                maxWidth: 250,
                                cursor: 'grab',
                              }}
                            >
                                <div style={{ ...categoryPillStyle(child, selected, dragGroupIds.includes(child.id)), boxShadow: 'none', margin: 0, position: 'relative' }}>
                                  {dragGroupIds.includes(child.id) && dragLeadId === child.id ? (
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
                                    }}>{dragGroupIds.length}</span>
                                  ) : null}
                                {pillNoDragZone()}
                                {editingId === child.id ? null : child.importBadge === 'new' ? statusPill('file') : child.isNew ? (
                                  <span style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    minWidth: 16,
                                    height: 16,
                                    borderRadius: 999,
                                    background: 'color-mix(in srgb, var(--accent) 14%, transparent)',
                                    color: 'color-mix(in srgb, var(--accent) 74%, white)',
                                    fontSize: 11,
                                    fontWeight: 700,
                                    lineHeight: 1,
                                    flexShrink: 0,
                                  }}>
                                    +
                                  </span>
                                ) : null}
                                {editingId === child.id ? <input autoFocus value={editingValue} onChange={e => setEditingValue(e.target.value)} onBlur={handleEditBlur} onKeyDown={e => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') { setEditingId(null); setEditingValue('') } }} style={{ background: 'var(--bg)', color: 'var(--text)', border: '1px solid color-mix(in srgb, var(--accent) 55%, var(--border))', borderRadius: 8, padding: '3px 8px', fontSize: 12, fontWeight: 500, outline: 'none', minWidth: 96 }} /> : <span onClick={e => handleNameClick(child.id, child.name, e)} style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', fontStyle: child.importBadge === 'new' ? 'italic' : 'normal', cursor: selected ? 'text' : 'pointer' }}>{child.name || 'category name'}</span>}
                                {pillTrailingNoDragZone()}
                                <button onMouseDown={e => { e.preventDefault(); e.stopPropagation() }} onClick={e => { e.stopPropagation(); removeNode(child.id) }} style={pillRemoveButtonStyle(removeTone(usageInUse(child)))}>x</button>
                              </div>
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                {mappedSources.map(rawValue => (
                                  <span key={`${child.id}:${rawValue}`}>{mappedSourcePill(rawValue, true, () => unmapSource(rawValue), { onDragStart: event => handleMappedSourceDragStart(rawValue, event), onDragEnd: clearCategoryTreeDragItem })}</span>
                                ))}
                              </div>
                            </div>
                          )
                        }
                        if (mappedSources.length === 1) {
                          return (
                            <div
                              key={child.id}
                              style={{ position: 'relative', display: 'inline-flex', paddingRight: 26, paddingBottom: 18, verticalAlign: 'top' }}
                            >
                              <div
                                draggable
                                onDragStart={event => handleCategoryDragStart(child, event)}
                                onDragEnd={() => { clearCategoryTreeDragItem(); setDragGroupIds([]); setDragLeadId(null) }}
                                onDragOver={event => event.preventDefault()}
                                onDrop={event => { event.preventDefault(); handleDropOnCategory(child) }}
                                onClick={event => handleSelectCategory(child.id, group.id, event)}
                                style={{ ...categoryPillStyle(child, selected, dragGroupIds.includes(child.id)), display: 'inline-flex', position: 'relative', zIndex: 1, verticalAlign: 'top' }}
                              >
                                {dragGroupIds.includes(child.id) && dragLeadId === child.id ? (
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
                                  }}>{dragGroupIds.length}</span>
                                ) : null}
                                {pillNoDragZone()}
                                {editingId === child.id ? null : child.importBadge === 'new' ? statusPill('file') : child.isNew ? (
                                  <span style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    minWidth: 16,
                                    height: 16,
                                    borderRadius: 999,
                                    background: 'color-mix(in srgb, var(--accent) 14%, transparent)',
                                    color: 'color-mix(in srgb, var(--accent) 74%, white)',
                                    fontSize: 11,
                                    fontWeight: 700,
                                    lineHeight: 1,
                                    flexShrink: 0,
                                  }}>
                                    +
                                  </span>
                                ) : null}
                                {editingId === child.id ? <input autoFocus value={editingValue} onChange={e => setEditingValue(e.target.value)} onBlur={handleEditBlur} onKeyDown={e => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') { setEditingId(null); setEditingValue('') } }} style={{ background: 'var(--bg)', color: 'var(--text)', border: '1px solid color-mix(in srgb, var(--accent) 55%, var(--border))', borderRadius: 8, padding: '3px 8px', fontSize: 12, fontWeight: 500, outline: 'none', minWidth: 96 }} /> : <span onClick={e => handleNameClick(child.id, child.name, e)} style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', fontStyle: child.importBadge === 'new' ? 'italic' : 'normal', cursor: selected ? 'text' : 'pointer' }}>{child.name || 'category name'}</span>}
                                {pillTrailingNoDragZone()}
                                <button onMouseDown={e => { e.preventDefault(); e.stopPropagation() }} onClick={e => { e.stopPropagation(); removeNode(child.id) }} style={pillRemoveButtonStyle(removeTone(usageInUse(child)))}>x</button>
                              </div>
                              <div style={{ position: 'absolute', left: 18, top: 14, zIndex: 2 }}>
                                  {mappedSourcePill(mappedSources[0], true, () => unmapSource(mappedSources[0]), { onDragStart: event => handleMappedSourceDragStart(mappedSources[0], event), onDragEnd: clearCategoryTreeDragItem })}
                                </div>
                            </div>
                          )
                        }
                        return <div key={child.id} draggable onDragStart={event => handleCategoryDragStart(child, event)} onDragEnd={() => { clearCategoryTreeDragItem(); setDragGroupIds([]); setDragLeadId(null) }} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); handleDropOnCategory(child) }} onClick={event => handleSelectCategory(child.id, group.id, event)} style={{ ...categoryPillStyle(child, selected, dragGroupIds.includes(child.id)), display: 'inline-flex', marginRight: 8, marginBottom: 8, verticalAlign: 'top', position: 'relative' }}>
                        {dragGroupIds.includes(child.id) && dragLeadId === child.id ? (
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
                          }}>{dragGroupIds.length}</span>
                        ) : null}
                        {pillNoDragZone()}
                        {editingId === child.id ? null : child.importBadge === 'new' ? statusPill('file') : child.isNew ? (
                          <span style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            minWidth: 16,
                            height: 16,
                            borderRadius: 999,
                            background: 'color-mix(in srgb, var(--accent) 14%, transparent)',
                            color: 'color-mix(in srgb, var(--accent) 74%, white)',
                            fontSize: 11,
                            fontWeight: 700,
                            lineHeight: 1,
                            flexShrink: 0,
                          }}>
                            +
                          </span>
                        ) : null}
                        {editingId === child.id ? <input autoFocus value={editingValue} onChange={e => setEditingValue(e.target.value)} onBlur={handleEditBlur} onKeyDown={e => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') { setEditingId(null); setEditingValue('') } }} style={{ background: 'var(--bg)', color: 'var(--text)', border: '1px solid color-mix(in srgb, var(--accent) 55%, var(--border))', borderRadius: 8, padding: '3px 8px', fontSize: 12, fontWeight: 500, outline: 'none', minWidth: 96 }} /> : <span onClick={e => handleNameClick(child.id, child.name, e)} style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', fontStyle: child.importBadge === 'new' ? 'italic' : 'normal', cursor: selected ? 'text' : 'pointer' }}>{child.name || 'category name'}</span>}
                        {pillTrailingNoDragZone()}
                        <button onMouseDown={e => { e.preventDefault(); e.stopPropagation() }} onClick={e => { e.stopPropagation(); removeNode(child.id) }} style={pillRemoveButtonStyle(removeTone(usageInUse(child)))}>x</button>
                      </div>
                    })}
                    </div> : null}
                  </div>
                ))}
              </div>}
              {panelMenu ? (
                <div
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
                      setSnapshot(prev => ({
                        ...prev,
                        collapsedGroups: {
                          ...prev.collapsedGroups,
                          [groupMenu.groupId]: !prev.collapsedGroups[groupMenu.groupId],
                        },
                      }))
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
                    {snapshot.collapsedGroups[groupMenu.groupId] ? 'Expand' : 'Collapse'}
                  </button>
                  <div style={{ height: 1, background: 'color-mix(in srgb, var(--border) 82%, transparent)', margin: '4px 2px' }} />
                  <button
                    onClick={() => {
                      addCategoryToGroup(groupMenu.groupId)
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
                    + Add category
                  </button>
                </div>
              ) : null}
              {sourceMenu ? (
                <div
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
                </div>
              ) : null}
              {floatingGroupDraft ? (
                <div
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
                        <input
                          autoFocus
                          placeholder="Group name"
                          value={floatingGroupDraft.name}
                          onChange={e => setFloatingGroupDraft(prev => prev ? { ...prev, name: e.target.value } : prev)}
                          onBlur={event => {
                            if (floatingGroupDraft?.name.trim()) {
                              finalizeFloatingGroupDraft()
                              return
                            }
                            requestAnimationFrame(() => {
                              event.target?.focus()
                            })
                          }}
                          onKeyDown={e => {
                            if (e.key === 'Enter') finalizeFloatingGroupDraft()
                            if (e.key === 'Escape') setFloatingGroupDraft(null)
                          }}
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
                        onMouseDown={e => {
                          e.preventDefault()
                          e.stopPropagation()
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
            </div>

          </div>
        </div>
      </div>
      <ChoiceDialog choice={pendingChoice} onChoose={mode => { if (!pendingChoice) return; if (mode === 'group') applyAddSourceToGroup(pendingChoice.sourceIds, pendingChoice.groupId); else applyMapSourceToCategory(pendingChoice.sourceIds, pendingChoice.categoryId); setPendingChoice(null) }} onCancel={() => setPendingChoice(null)} />
    </div>
  )
}
