// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- shared category-tree row component + tree-traversal helpers used by callers */

import { useEffect, useRef, useState } from 'react'
import { CategoryMarker, HighlightedText, Button, IconButton } from './ui.jsx'
import { useDismissibleLayer, useTransientTextEdit } from '../lib/uiInteractions.js'
import { DRAG_SOURCE_STYLE, startPointerDrag, useDropZone } from '../lib/pointerDrag.js'
import TransientTextInput from './TransientTextInput.jsx'

/*
 * These primitives keep every tree surface on the same interaction contract: rows select before they rename,
 * deletes confirm inline, and a dragged row is a target for rows and end lanes alike, which need not share a
 * parent state owner because the drag carries its own item (lib/pointerDrag.js).
 */

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
      <Button
        size="compact"
        variant="danger"
        onMouseDown={e => {
          e.stopPropagation()
          onConfirm()
        }}
      >
        Delete
      </Button>
      <Button
        size="compact"
        variant="quiet"
        onMouseDown={e => {
          e.stopPropagation()
          onCancel()
        }}
      >
        Cancel
      </Button>
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
  highlightQuery = '',
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
      <HighlightedText text={value} query={highlightQuery} />
    </span>
  )
}

// Bottom-right undo toast shared by the tree's bulk actions (move, delete) and the reimbursements
// board's pairings. The caller supplies the title/description for the action; the toast owns the 6s
// auto-dismiss and Undo/Dismiss chrome. `zIndex` is raised by a caller inside a dialog — the default
// sits below `AppDialog`, where the toast would be hidden behind the surface that raised it.
export function UndoToast({ title, description, onUndo, onDismiss, zIndex = 850 }) {
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
      zIndex,
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
          {title}
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
          {description}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button onClick={onUndo} style={{ flex: 1 }}>
            Undo
          </Button>
          <Button variant="secondary" onClick={onDismiss}>
            Dismiss
          </Button>
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
  bulkSelectMode = false,
  bulkChecked = false,
  bulkSelectable = true,
  isCollapsed = false,
  canCollapse = false,
  renameDisabled = false,
  allowSelectionWhenRenameDisabled = false,
  showDelete = true,
  acceptDrop = true,
  nameStyle = null,
  highlightQuery = '',
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
  const canDrag = draggable && !bulkSelectMode

  const dropRef = useDropZone({
    accepts: item => (
      acceptDrop
      && item.id !== cat.id
      && !item.childIds?.includes(cat.id)
      && !(isChild && item.isGroup)
    ),
    onEnter: () => setDragOver(true),
    onLeave: () => setDragOver(false),
    onDrop: (item, point, element) => {
      const rect = element.getBoundingClientRect()
      onDropRow?.(item, cat, point.clientY < rect.top + rect.height / 2 ? 'before' : 'after')
    },
  })

  return (
    <div
      ref={dropRef}
      onPointerDown={canDrag ? event => startPointerDrag(event, {
        onStart: () => onDragStartRow?.(cat) ?? {
          id: cat.id,
          parentId: cat.parent_id,
          isGroup: !cat.parent_id,
          categoryType: normalizeCategoryType(cat.category_type),
        },
      }) : undefined}
      onClick={e => {
        if (bulkSelectMode) return
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
        ...DRAG_SOURCE_STYLE,
        cursor: canDrag ? 'grab' : 'default',
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
      {bulkSelectMode ? (
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
        disabled={bulkSelectMode || renameDisabled}
        allowSelectionWhenDisabled={allowSelectionWhenRenameDisabled && !bulkSelectMode}
        textStyle={nameStyle}
        highlightQuery={highlightQuery}
        autoEditToken={autoEditToken}
        autoEditPlaceholder={autoEditPlaceholder}
        onAutoEditConsumed={onAutoEditConsumed}
        onCancelEdit={onCancelEdit}
      />
      {trailingContent ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>{trailingContent}</span> : null}
      {bulkSelectMode || !showDelete ? null : !confirmDelete ? (
        <IconButton
          size="compact"
          aria-label="Delete"
          onClick={e => {
            e.stopPropagation()
            setConfirmDelete(true)
          }}
          style={{ flexShrink: 0 }}
        >
          x
        </IconButton>
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

function DropLane({ label, accepts, onDrop }) {
  const [active, setActive] = useState(false)
  const dropRef = useDropZone({
    accepts,
    onEnter: () => setActive(true),
    onLeave: () => setActive(false),
    onDrop,
  })
  return (
    <div
      ref={dropRef}
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
  return (
    <DropLane
      label={`Move to ${group.name}`}
      accepts={item => !item.isGroup}
      onDrop={item => onDropEnd(item, group)}
    />
  )
}

export function SectionEndDropZone({ sectionMeta, sectionType, onDropEnd }) {
  return (
    <DropLane
      label={`Move group to end of ${sectionMeta[sectionType].label}`}
      accepts={item => item.isGroup}
      onDrop={item => onDropEnd(item, sectionType)}
    />
  )
}
