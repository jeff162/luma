// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- shared category-tree row component + tree-traversal helpers used by callers */

import { useEffect, useRef, useState } from 'react'
import { CategoryMarker } from './ui.jsx'
import { useDismissibleLayer, useTransientTextEdit } from '../lib/uiInteractions.js'
import TransientTextInput from './TransientTextInput.jsx'

/*
 * These primitives keep every tree surface on the same interaction contract: rows select before they rename,
 * deletes confirm inline, and drag/drop shares one transient payload because rows, lanes, and end zones do not
 * all live under a single parent state owner.
 */
let dragItem = null

export function setCategoryTreeDragItem(item) {
  dragItem = item
}

export function clearCategoryTreeDragItem() {
  dragItem = null
}

export function getCategoryTreeDragItem() {
  return dragItem
}

export function normalizeCategoryType(value) {
  return value === 'income' ? 'income' : 'expense'
}

function DeleteConfirm({ label, onConfirm, onCancel }) {
  const ref = useRef(null)
  useDismissibleLayer({
    open: true,
    onClose: onCancel,
    refs: [ref],
  })

  return (
    <div
      ref={ref}
      style={{
        position: 'absolute',
        right: 0,
        top: '50%',
        transform: 'translateY(-50%)',
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: '5px 8px',
        boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ fontSize: 12, color: 'var(--muted)' }}>{label}</span>
      <button
        onMouseDown={e => {
          e.stopPropagation()
          onConfirm()
        }}
        style={{
          background: '#ef4444',
          color: '#fff',
          border: 'none',
          borderRadius: 5,
          padding: '3px 9px',
          fontSize: 12,
          cursor: 'pointer',
          fontWeight: 600,
        }}
      >
        Delete
      </button>
      <button
        onMouseDown={e => {
          e.stopPropagation()
          onCancel()
        }}
        style={{
          background: 'none',
          border: '1px solid var(--border)',
          color: 'var(--muted)',
          borderRadius: 5,
          padding: '3px 8px',
          fontSize: 12,
          cursor: 'pointer',
        }}
      >
        Cancel
      </button>
    </div>
  )
}

export function EditableName({
  value,
  isSelected,
  onSave,
  onFirstClick,
  disabled = false,
  allowSelectionWhenDisabled = false,
  textStyle = null,
  autoEditToken = 0,
  autoEditPlaceholder = '',
  onAutoEditConsumed,
  onCancelEdit,
}) {
  const [error, setError] = useState('')
  const {
    editing,
    draft,
    setDraft,
    beginEdit,
    cancelEdit,
    commitEdit,
  } = useTransientTextEdit(value, {
    onCommit: onSave,
    onCommitError: error => setError(error?.message || 'Could not save that name'),
  })
  const inputRef = useRef(null)
  const lastAutoEditTokenRef = useRef(0)

  useEffect(() => {
    if (!isSelected) cancelEdit()
  }, [cancelEdit, isSelected])

  useEffect(() => {
    if (!editing) {
      setError('')
    }
  }, [editing])

  useEffect(() => {
    if (!autoEditToken || disabled || !isSelected) return
    if (lastAutoEditTokenRef.current === autoEditToken) return
    lastAutoEditTokenRef.current = autoEditToken
    setError('')
    beginEdit(autoEditPlaceholder ? '' : value)
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
      onAutoEditConsumed?.()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [autoEditPlaceholder, autoEditToken, beginEdit, disabled, isSelected, onAutoEditConsumed, value])

  useEffect(() => {
    if (!editing || !error) return
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [editing, error])

  function handleClick(e) {
    if (disabled) {
      if (allowSelectionWhenDisabled && !isSelected) {
        e.stopPropagation()
        onFirstClick()
        return
      }
      e.preventDefault()
      e.stopPropagation()
      return
    }
    e.stopPropagation()
    if (!isSelected) {
      // Selection is a separate step from rename so keyboard focus, context menus, and bulk actions can target the row first.
      onFirstClick()
      return
    }
    if (!editing) {
      setError('')
      beginEdit(value)
      setTimeout(() => inputRef.current?.select(), 0)
    }
  }

  if (editing) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
        <TransientTextInput
          ref={inputRef}
          value={draft}
          placeholder={autoEditPlaceholder || undefined}
          onChange={nextValue => {
            if (error) setError('')
            setDraft(nextValue)
          }}
          onCommit={commitEdit}
          onCancel={() => {
            setError('')
            cancelEdit()
            onCancelEdit?.()
          }}
          restoreOnEscape
          onKeyDown={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
          aria-invalid={error ? 'true' : undefined}
          title={error || undefined}
          style={{
            background: 'var(--bg)',
            color: 'var(--text)',
            border: `1px solid ${error ? 'var(--danger)' : 'var(--accent)'}`,
            borderRadius: 4,
            padding: '0 6px',
            fontSize: 'inherit',
            fontWeight: 'inherit',
            lineHeight: 1.2,
            flex: 1,
            minWidth: Math.max(80, draft.length * 8 + 16),
            maxWidth: '100%',
            outline: 'none',
          }}
        />
        {error ? (
          <span style={{ fontSize: 11, color: 'var(--danger)', lineHeight: 1.15 }}>
            {error}
          </span>
        ) : null}
      </div>
    )
  }

  return (
    <span
      onClick={handleClick}
      title={disabled ? undefined : isSelected ? 'Click to rename' : 'Click to select'}
      style={{ cursor: disabled ? 'default' : isSelected ? 'text' : 'default', flex: 1, ...(textStyle || {}) }}
    >
      {value}
    </span>
  )
}

export function BulkMoveToast({ move, onUndo, onDismiss }) {
  const timerRef = useRef(null)
  const intervalRef = useRef(null)
  const startRef = useRef(Date.now())
  const [progress, setProgress] = useState(100)

  useEffect(() => {
    startRef.current = Date.now()
    intervalRef.current = setInterval(() => {
      const pct = Math.max(0, 100 - ((Date.now() - startRef.current) / 6000) * 100)
      setProgress(pct)
    }, 50)
    timerRef.current = setTimeout(onDismiss, 6000)
    return () => {
      clearTimeout(timerRef.current)
      clearInterval(intervalRef.current)
    }
  }, [onDismiss])

  return (
    <div style={{
      position: 'fixed',
      right: 24,
      bottom: 24,
      zIndex: 850,
      width: 320,
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 12,
      boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
      overflow: 'hidden',
    }}>
      <div style={{ height: 3, background: 'var(--surface2)' }}>
        <div style={{ height: '100%', width: `${progress}%`, background: 'var(--accent)', transition: 'width 0.1s linear' }} />
      </div>
      <div style={{ padding: '14px 16px' }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
          Moved {move.count} categor{move.count === 1 ? 'y' : 'ies'}
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
          Added to {move.targetGroupName}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={onUndo}
            style={{
              flex: 1,
              background: 'var(--accent)',
              color: '#fff',
              border: 'none',
              borderRadius: 7,
              padding: '7px 0',
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            Undo
          </button>
          <button
            onClick={onDismiss}
            style={{
              background: 'var(--surface2)',
              color: 'var(--muted)',
              border: '1px solid var(--border)',
              borderRadius: 7,
              padding: '7px 11px',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  )
}

export function CategoryTreeRow({
  cat,
  isChild,
  isSelected,
  draggable = true,
  bulkMoveMode = false,
  bulkChecked = false,
  bulkSelectable = true,
  isCollapsed = false,
  canCollapse = false,
  renameDisabled = false,
  allowSelectionWhenRenameDisabled = false,
  showDelete = true,
  acceptDrop = true,
  nameStyle = null,
  trailingContent = null,
  autoEditToken = 0,
  autoEditPlaceholder = '',
  onAutoEditConsumed,
  onCancelEdit,
  onToggleCollapse,
  onSelect,
  onRename,
  onDelete,
  onToggleBulkChecked,
  onDropRow,
  onOpenContextMenu,
  onDragStartRow,
}) {
  const [dragOver, setDragOver] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const showGroupToggleSlot = !isChild
  const canDrag = draggable && !bulkMoveMode

  function canAcceptDrop() {
    if (!acceptDrop) return false
    if (!dragItem || dragItem.id === cat.id) return false
    if (dragItem.childIds?.includes(cat.id)) return false
    if (isChild && dragItem.isGroup) return false
    return true
  }

  return (
    <div
      draggable={canDrag}
      onDragStart={e => {
        if (!canDrag) {
          e.preventDefault()
          return
        }
        dragItem = onDragStartRow?.(cat) ?? {
          id: cat.id,
          parentId: cat.parent_id,
          isGroup: !cat.parent_id,
          categoryType: normalizeCategoryType(cat.category_type),
        }
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragOver={e => {
        if (!canAcceptDrop()) return
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => {
        e.preventDefault()
        setDragOver(false)
        if (!canAcceptDrop()) {
          dragItem = null
          return
        }
        const rect = e.currentTarget.getBoundingClientRect()
        const dropPosition = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
        onDropRow?.(dragItem, cat, dropPosition)
        dragItem = null
      }}
      onClick={e => {
        if (bulkMoveMode) return
        if (!confirmDelete) onSelect(cat, e)
      }}
      onContextMenu={e => {
        if (!onOpenContextMenu) return
        e.preventDefault()
        e.stopPropagation()
        onOpenContextMenu(e, cat)
      }}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: isChild ? 5 : 2,
        padding: isChild ? '2px 9px 2px 46px' : '4px 9px 4px 11px',
        cursor: canDrag ? 'grab' : 'default',
        userSelect: 'none',
        borderBottom: '1px solid var(--border)',
        background: dragOver
          ? 'var(--surface2)'
          : isSelected
            ? 'color-mix(in srgb, var(--accent) 12%, var(--surface))'
            : 'transparent',
        fontWeight: isChild ? 400 : 600,
        fontSize: 12,
        transition: 'background 0.1s',
      }}
    >
      {showGroupToggleSlot ? (
        <button
          onClick={e => {
            e.stopPropagation()
            if (!canCollapse) return
            onToggleCollapse?.(cat.id)
          }}
          title={canCollapse ? (isCollapsed ? 'Expand group' : 'Collapse group') : undefined}
          style={{
            background: 'none',
            border: '1px solid var(--border)',
            color: canCollapse ? 'var(--muted)' : 'transparent',
            cursor: canCollapse ? 'pointer' : 'default',
            fontSize: 12,
            width: 19,
            height: 19,
            padding: 0,
            flexShrink: 0,
            borderRadius: 5,
            display: 'grid',
            placeItems: 'center',
            lineHeight: 1,
            backgroundColor: 'var(--surface2)',
            marginLeft: 29,
            opacity: canCollapse ? 1 : 0.45,
          }}
        >
          {canCollapse ? (isCollapsed ? '+' : '-') : '·'}
        </button>
      ) : (
        <span style={{ width: 19, flexShrink: 0 }} />
      )}
      {bulkMoveMode ? (
        bulkSelectable ? (
        <button
          onClick={e => {
            e.stopPropagation()
            onToggleBulkChecked?.(cat)
          }}
          title={isChild ? (bulkChecked ? 'Deselect category' : 'Select category') : (bulkChecked ? 'Deselect group categories' : 'Select group categories')}
          style={{
            width: 17,
            height: 17,
            flexShrink: 0,
            borderRadius: 4,
            border: `1px solid ${bulkChecked ? 'var(--accent)' : 'var(--border)'}`,
            background: bulkChecked ? 'var(--accent)' : 'var(--surface)',
            color: bulkChecked ? '#fff' : 'transparent',
            display: 'grid',
            placeItems: 'center',
            fontSize: 11,
            lineHeight: 1,
            cursor: 'pointer',
            padding: 0,
          }}
        >
          {bulkChecked ? '✓' : ''}
        </button>
        ) : (
          <span style={{ width: 17, height: 17, flexShrink: 0 }} />
        )
      ) : null}
      <span
        style={{
          color: canDrag ? 'var(--border)' : 'transparent',
          fontSize: 10,
          flexShrink: 0,
          marginLeft: isChild ? 0 : -2,
        }}
      >
        ...
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', marginRight: isChild ? 0 : 2 }}>
        <CategoryMarker kind={isChild ? 'category' : 'group'} />
      </span>
      <EditableName
        value={cat.name}
        isSelected={isSelected}
        onSave={name => onRename(cat.id, name)}
        onFirstClick={() => onSelect(cat)}
        disabled={bulkMoveMode || renameDisabled}
        allowSelectionWhenDisabled={allowSelectionWhenRenameDisabled && !bulkMoveMode}
        textStyle={nameStyle}
        autoEditToken={autoEditToken}
        autoEditPlaceholder={autoEditPlaceholder}
        onAutoEditConsumed={onAutoEditConsumed}
        onCancelEdit={onCancelEdit}
      />
      {trailingContent ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>{trailingContent}</span> : null}
      {bulkMoveMode || !showDelete ? null : !confirmDelete ? (
        <button
          onClick={e => {
            e.stopPropagation()
            setConfirmDelete(true)
          }}
          title="Delete"
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
      ) : (
        <DeleteConfirm
          label={`Delete "${cat.name}"?`}
          onConfirm={() => {
            setConfirmDelete(false)
            onDelete(cat.id)
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  )
}

function DropLane({ label, active, onDragOver, onDragLeave, onDrop }) {
  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{
        height: active ? 24 : 3,
        margin: active ? '2px 8px' : '0 8px',
        borderRadius: 4,
        border: active ? '1px dashed var(--accent)' : 'none',
        background: active ? 'color-mix(in srgb, var(--accent) 20%, transparent)' : 'transparent',
        color: 'var(--accent)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 11,
        transition: 'all 0.15s',
      }}
    >
      {active ? label : ''}
    </div>
  )
}

export function GroupEndDropZone({ group, onDropEnd }) {
  const [dragOver, setDragOver] = useState(false)

  return (
    <DropLane
      label={`Move to ${group.name}`}
      active={dragOver}
      onDragOver={e => {
        if (!dragItem || dragItem.isGroup) return
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => {
        e.preventDefault()
        setDragOver(false)
        if (!dragItem || dragItem.isGroup) return
        onDropEnd(dragItem, group)
        dragItem = null
      }}
    />
  )
}

export function SectionEndDropZone({ sectionMeta, sectionType, onDropEnd }) {
  const [dragOver, setDragOver] = useState(false)

  return (
    <DropLane
      label={`Move group to end of ${sectionMeta[sectionType].label}`}
      active={dragOver}
      onDragOver={e => {
        if (!dragItem || !dragItem.isGroup) return
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => {
        e.preventDefault()
        setDragOver(false)
        if (!dragItem || !dragItem.isGroup) return
        onDropEnd(dragItem, sectionType)
        dragItem = null
      }}
    />
  )
}
