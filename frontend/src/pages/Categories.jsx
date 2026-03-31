import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api.js'
import { PageHeader, Spinner, EmptyState, CategoryMarker } from '../components/ui.jsx'
import CategoryPicker from '../components/CategoryPicker.jsx'
import { useFilters } from '../lib/FilterContext.jsx'
import TransactionListTable from '../components/TransactionListTable.jsx'
import { usePagedTransactions } from '../components/detailShared.jsx'

const SECTION_META = {
  income: { label: 'Income' },
  expense: { label: 'Expense' },
}

const SECTION_STORAGE_KEY_PREFIX = 'fintrack.categories.collapsedSections'
const GROUP_STORAGE_KEY_PREFIX = 'fintrack.categories.collapsedGroups'
const SECTION_PREF_KEY = 'ui.categories.collapsedSections'
const GROUP_PREF_KEY = 'ui.categories.collapsedGroups'

function getSectionStorageKey(instanceId, userId) {
  return instanceId && userId ? `${SECTION_STORAGE_KEY_PREFIX}.${instanceId}.${userId}` : null
}

function getGroupStorageKey(instanceId, userId) {
  return instanceId && userId ? `${GROUP_STORAGE_KEY_PREFIX}.${instanceId}.${userId}` : null
}

function normalizeType(value) {
  return value === 'income' ? 'income' : 'expense'
}

function DeleteConfirm({ label, onConfirm, onCancel }) {
  const ref = useRef(null)

  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) onCancel()
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [onCancel])

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

function DeleteCategoryDialog({ category, preview, categories, replacementId, onReplacementChange, mode, onModeChange, onConfirm, onCancel, saving }) {
  const ref = useRef(null)

  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) onCancel()
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [onCancel])

  const canConfirm = mode === 'unassigned' || !!replacementId

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      zIndex: 900,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
      background: 'rgba(15, 23, 42, 0.28)',
      backdropFilter: 'blur(2px)',
    }}>
      <div
        ref={ref}
        style={{
          width: 'min(560px, 100%)',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 14,
          boxShadow: '0 16px 40px rgba(0,0,0,0.2)',
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', background: 'var(--surface2)' }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>Delete category</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
            "{category?.name}" is assigned to {preview?.txn_count} transaction{preview?.txn_count === 1 ? '' : 's'}.
          </div>
        </div>

        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
            Choose where those transactions should go before deleting this category.
          </div>

          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
            <input
              type="radio"
              checked={mode === 'replace'}
              onChange={() => onModeChange('replace')}
              style={{ marginTop: 2, accentColor: 'var(--accent)' }}
            />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Move transactions to another category</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
                Pick the category that should replace this one.
              </div>
            </div>
          </label>

          {mode === 'replace' ? (
            <div style={{ paddingLeft: 24 }}>
              <CategoryPicker
                value={replacementId}
                categories={categories}
                onChange={onReplacementChange}
                placeholder="Choose replacement category…"
              />
            </div>
          ) : null}

          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
            <input
              type="radio"
              checked={mode === 'unassigned'}
              onChange={() => onModeChange('unassigned')}
              style={{ marginTop: 2, accentColor: 'var(--accent)' }}
            />
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Mark transactions as unassigned</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
                Remove the category from those transactions.
              </div>
            </div>
          </label>
        </div>

        <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border)', background: 'var(--surface2)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={onCancel}
            style={{
              background: 'transparent',
              color: 'var(--muted)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '8px 14px',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!canConfirm || saving}
            style={{
              background: canConfirm && !saving ? 'color-mix(in srgb, var(--accent) 88%, #ffffff 12%)' : 'var(--surface)',
              color: canConfirm && !saving ? '#fff' : 'var(--muted)',
              border: canConfirm && !saving ? 'none' : '1px solid var(--border)',
              borderRadius: 8,
              padding: '8px 16px',
              fontSize: 13,
              fontWeight: 500,
              cursor: !canConfirm || saving ? 'not-allowed' : 'pointer',
              opacity: !canConfirm || saving ? 0.6 : 1,
            }}
          >
            {saving ? 'Deleting…' : 'Delete category'}
          </button>
        </div>
      </div>
    </div>
  )
}

function EditableName({ value, isSelected, onSave, onFirstClick, disabled = false }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const inputRef = useRef(null)

  useEffect(() => {
    if (!isSelected) setEditing(false)
  }, [isSelected])

  function handleClick(e) {
    if (disabled) {
      e.preventDefault()
      e.stopPropagation()
      return
    }
    e.stopPropagation()
    if (!isSelected) {
      onFirstClick()
      return
    }
    if (!editing) {
      setDraft(value)
      setEditing(true)
      setTimeout(() => inputRef.current?.select(), 0)
    }
  }

  function commit() {
    setEditing(false)
    if (draft.trim() && draft.trim() !== value) onSave(draft.trim())
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          }
          if (e.key === 'Escape') setEditing(false)
          e.stopPropagation()
        }}
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg)',
          color: 'var(--text)',
          border: '1px solid var(--accent)',
          borderRadius: 4,
          padding: '1px 6px',
          fontSize: 'inherit',
          fontWeight: 'inherit',
          width: Math.max(80, draft.length * 8 + 16),
          outline: 'none',
        }}
      />
    )
  }

  return (
    <span
      onClick={handleClick}
      title={disabled ? undefined : isSelected ? 'Click to rename' : 'Click to select'}
      style={{ cursor: disabled ? 'default' : isSelected ? 'text' : 'default', flex: 1 }}
    >
      {value}
    </span>
  )
}

let dragItem = null

function BulkMoveToast({ move, onUndo, onDismiss }) {
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

function CategoryRow({
  cat,
  isChild,
  isSelected,
  bulkMoveMode = false,
  bulkChecked = false,
  isCollapsed = false,
  canCollapse = false,
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

  function canAcceptDrop() {
    if (!dragItem || dragItem.id === cat.id) return false
    if (dragItem.childIds?.includes(cat.id)) return false
    if (isChild && dragItem.isGroup) return false
    return true
  }

  return (
    <div
      draggable={!bulkMoveMode}
      onDragStart={e => {
        if (bulkMoveMode) {
          e.preventDefault()
          return
        }
        dragItem = onDragStartRow?.(cat) ?? {
          id: cat.id,
          parentId: cat.parent_id,
          isGroup: !cat.parent_id,
          categoryType: normalizeType(cat.category_type),
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
        onDropRow(dragItem, cat, dropPosition)
        dragItem = null
      }}
      onClick={e => {
        if (bulkMoveMode) return
        if (!confirmDelete) onSelect(cat, e)
      }}
      onContextMenu={e => {
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
        cursor: 'grab',
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
      {canCollapse ? (
        <button
          onClick={e => {
            e.stopPropagation()
            onToggleCollapse?.(cat.id)
          }}
          title={isCollapsed ? 'Expand group' : 'Collapse group'}
          style={{
            background: 'none',
            border: '1px solid var(--border)',
            color: 'var(--muted)',
            cursor: 'pointer',
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
          }}
        >
          {isCollapsed ? '+' : '-'}
        </button>
      ) : (
        <span style={{ width: 19, flexShrink: 0 }} />
      )}
      {bulkMoveMode ? (
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
      ) : null}
      <span style={{ color: 'var(--border)', fontSize: 10, flexShrink: 0, marginLeft: isChild ? 0 : -2 }}>...</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', marginRight: isChild ? 0 : 2 }}>
        <CategoryMarker kind={isChild ? 'category' : 'group'} />
      </span>
      <EditableName
        value={cat.name}
        isSelected={isSelected}
        onSave={name => onRename(cat.id, name)}
        onFirstClick={() => onSelect(cat)}
        disabled={bulkMoveMode}
      />
      {bulkMoveMode ? null : !confirmDelete ? (
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

function GroupEndDropZone({ group, onDropEnd }) {
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

function SectionEndDropZone({ sectionType, onDropEnd }) {
  const [dragOver, setDragOver] = useState(false)

  return (
    <DropLane
      label={`Move group to end of ${SECTION_META[sectionType].label}`}
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

function ContextMenu({
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
  onAddRule,
  onStartBulkMove,
  onMoveHere,
  onCancelBulkMove,
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
    padding: '6px 14px',
    fontSize: 12,
    cursor: 'pointer',
    borderRadius: 6,
    display: 'block',
    width: '100%',
    textAlign: 'left',
    background: 'none',
    border: 'none',
    color: 'var(--text)',
  }

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        left,
        top,
        zIndex: 500,
        visibility: menuHeight ? 'visible' : 'hidden',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: 3,
        boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
        minWidth: menuW,
      }}
    >
      {bulkMoveMode && canMoveHere ? (
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
            Move here
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
            Cancel bulk move
          </button>
        </>
      ) : bulkMoveMode ? (
        <div style={{ ...itemStyle, color: 'var(--muted)', cursor: 'default', opacity: 0.7 }}>
          Select categories, then choose a destination group
        </div>
      ) : target.groupId ? (
        <button
          style={itemStyle}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
          onMouseDown={e => {
            e.preventDefault()
            onAddCategory(target)
          }}
        >
          + Add category to "{target.groupName}"
        </button>
      ) : (
        <div style={{ ...itemStyle, color: 'var(--muted)', cursor: 'default', opacity: 0.55 }}>
          + Add category (right-click a group)
        </div>
      )}
      {!bulkMoveMode ? (
        <button
          style={itemStyle}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
          onMouseDown={e => {
            e.preventDefault()
            onAddGroup(target)
          }}
        >
          + New {SECTION_META[target.sectionType].label.toLowerCase()} group
        </button>
      ) : null}
      {!bulkMoveMode ? (
        target.categoryId ? (
          <button
            style={itemStyle}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
          onMouseDown={e => {
            e.preventDefault()
            onAddRule(target)
          }}
        >
          Add categorization rule
        </button>
        ) : null
      ) : null}
      <div style={{ height: 1, background: 'var(--border)', margin: '3px 0' }} />
      <button
        style={itemStyle}
        onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)' }}
        onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
        onMouseDown={e => {
          e.preventDefault()
          onExpandAll(target)
        }}
      >
        Expand all
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
        Collapse all
      </button>
      <div style={{ height: 1, background: 'var(--border)', margin: '3px 0' }} />
      <button
        style={itemStyle}
        onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)' }}
        onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
        onMouseDown={e => {
          e.preventDefault()
          onAlphabetize(target)
        }}
      >
        Alphabetize
      </button>
      {!bulkMoveMode ? (
        <button
          style={itemStyle}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
          onMouseDown={e => {
            e.preventDefault()
            onStartBulkMove(target)
          }}
        >
          Bulk move
        </button>
      ) : !canMoveHere ? (
        <button
          style={itemStyle}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
          onMouseDown={e => {
            e.preventDefault()
            onCancelBulkMove()
          }}
        >
          Cancel bulk move
        </button>
      ) : null}
    </div>
  )
}

function InlineAddForm({ label, value, onNameChange, onSubmit, onCancel }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 6,
        alignItems: 'center',
        padding: '8px 10px 8px 38px',
        borderTop: '1px solid var(--border)',
        flexWrap: 'wrap',
        background: 'var(--surface2)',
      }}
    >
      <input
        autoFocus
        value={value}
        onChange={e => onNameChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') onSubmit()
          if (e.key === 'Escape') onCancel()
        }}
        placeholder={label}
        style={{
          flex: 1,
          background: 'var(--surface)',
          color: 'var(--text)',
          border: '1px solid var(--border)',
          borderRadius: 999,
          padding: '6px 12px',
          fontSize: 13,
          outline: 'none',
        }}
      />
      <button
        onClick={onSubmit}
        style={{
          background: 'var(--accent)',
          color: '#fff',
          border: 'none',
          borderRadius: 999,
          padding: '6px 12px',
          fontSize: 12,
          cursor: 'pointer',
        }}
      >
        Add
      </button>
      <button
        onClick={onCancel}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--muted)',
          cursor: 'pointer',
          fontSize: 14,
          width: 28,
          height: 28,
          borderRadius: 999,
        }}
      >
        x
      </button>
    </div>
  )
}

function ScrollFade({ top, bottom }) {
  return (
    <>
      {top ? (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 20,
            background: 'linear-gradient(to bottom, color-mix(in srgb, var(--surface) 96%, transparent), transparent)',
            pointerEvents: 'none',
            zIndex: 5,
          }}
        />
      ) : null}
      {bottom ? (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: 24,
            background: 'linear-gradient(to top, color-mix(in srgb, var(--surface) 96%, transparent), transparent)',
            pointerEvents: 'none',
            zIndex: 5,
          }}
        />
      ) : null}
    </>
  )
}

export default function Categories() {
  const navigate = useNavigate()
  const { filters } = useFilters()
  const [dbInstanceId, setDbInstanceId] = useState('')
  const [userId, setUserId] = useState('')
  const [tree, setTree] = useState([])
  const [flatCats, setFlatCats] = useState([])
  const [owners, setOwners] = useState([])
  const [matchingTxnsTotal, setMatchingTxnsTotal] = useState(0)
  const [selected, setSelected] = useState(null)
  const [selectedCategoryIds, setSelectedCategoryIds] = useState([])
  const [loading, setLoading] = useState(true)
  const [newName, setNewName] = useState('')
  const [contextMenu, setContextMenu] = useState(null)
  const [inlineForm, setInlineForm] = useState(null)
  const [collapsedSections, setCollapsedSections] = useState({})
  const [collapsedGroups, setCollapsedGroups] = useState({})
  const [collapseStateLoaded, setCollapseStateLoaded] = useState(false)
  const [listScrollState, setListScrollState] = useState({ top: false, bottom: false })
  const [deleteDialog, setDeleteDialog] = useState(null)
  const [deleteMode, setDeleteMode] = useState('replace')
  const [deleteReplacementId, setDeleteReplacementId] = useState('')
  const [deleteSaving, setDeleteSaving] = useState(false)
  const [bulkMoveToast, setBulkMoveToast] = useState(null)
  const [bulkMoveMode, setBulkMoveMode] = useState(false)

  const listRef = useRef(null)
  const dragScrollRef = useRef(null)
  const selectedRef = useRef(null)

  useEffect(() => {
    selectedRef.current = selected
  }, [selected])

  useEffect(() => {
    let cancelled = false
    Promise.all([
      api.getAuthStatus().catch(() => null),
      api.getUserPreferences().catch(() => ({ preferences: {} })),
    ]).then(([status, prefResp]) => {
      if (cancelled) return
      const nextDbInstanceId = status?.db_instance_id || ''
      const nextUserId = status?.preference_profile?.id || status?.user?.id || ''
      setDbInstanceId(nextDbInstanceId)
      setUserId(nextUserId)
      const sectionPrefs = prefResp?.preferences?.[SECTION_PREF_KEY]
      const groupPrefs = prefResp?.preferences?.[GROUP_PREF_KEY]
      if (sectionPrefs && typeof sectionPrefs === 'object') setCollapsedSections(sectionPrefs)
      if (groupPrefs && typeof groupPrefs === 'object') setCollapsedGroups(groupPrefs)
      const sectionStorageKey = getSectionStorageKey(nextDbInstanceId, nextUserId)
      const groupStorageKey = getGroupStorageKey(nextDbInstanceId, nextUserId)
      if (!sectionPrefs && sectionStorageKey) {
        const savedSections = JSON.parse(window.localStorage.getItem(sectionStorageKey) || 'null')
        if (savedSections && typeof savedSections === 'object') setCollapsedSections(savedSections)
      }
      if (!groupPrefs && groupStorageKey) {
        const savedGroups = JSON.parse(window.localStorage.getItem(groupStorageKey) || 'null')
        if (savedGroups && typeof savedGroups === 'object') setCollapsedGroups(savedGroups)
      }
      setCollapseStateLoaded(true)
    })
    .catch(() => {
      if (cancelled) return
      setDbInstanceId('')
      setUserId('')
      setCollapseStateLoaded(true)
    })
    return () => { cancelled = true }
  }, [])

  const loadCategories = useCallback(async (selectedId = selectedRef.current?.id) => {
    const [nextTree, nextFlat] = await Promise.all([
      api.getCategoryTree(),
      api.getCategories(),
    ])
    setTree(nextTree)
    setFlatCats(nextFlat)
    setLoading(false)
    if (selectedId) setSelected(nextFlat.find(cat => cat.id === selectedId) || null)
    setSelectedCategoryIds(prev => prev.filter(id => nextFlat.some(cat => cat.id === id && cat.parent_id)))
  }, [])

  useEffect(() => { loadCategories() }, [loadCategories])
  useEffect(() => { api.getOwners().then(setOwners) }, [])
  useEffect(() => {
    if (!collapseStateLoaded) return
    const storageKey = getSectionStorageKey(dbInstanceId, userId)
    if (!storageKey) return
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(collapsedSections))
    } catch {
      // Ignore storage failures in environments that block localStorage.
    }
    api.saveUserPreference(SECTION_PREF_KEY, collapsedSections).catch(() => {})
  }, [dbInstanceId, userId, collapsedSections, collapseStateLoaded])
  useEffect(() => {
    if (!collapseStateLoaded) return
    const storageKey = getGroupStorageKey(dbInstanceId, userId)
    if (!storageKey) return
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(collapsedGroups))
    } catch {
      // Ignore storage failures in environments that block localStorage.
    }
    api.saveUserPreference(GROUP_PREF_KEY, collapsedGroups).catch(() => {})
  }, [dbInstanceId, userId, collapsedGroups, collapseStateLoaded])

  const groupsBySection = {
    income: tree.filter(group => normalizeType(group.category_type) === 'income'),
    expense: tree.filter(group => normalizeType(group.category_type) === 'expense'),
  }

  const visibleChildIds = ['income', 'expense'].flatMap(sectionType => {
    if (collapsedSections[sectionType]) return []
    return groupsBySection[sectionType].flatMap(group => (
      collapsedGroups[group.id] ? [] : (group.children || []).map(child => child.id)
    ))
  })

  useEffect(() => {
    if (!tree.length || !collapseStateLoaded) return
    const sectionStorageKey = getSectionStorageKey(dbInstanceId, userId)
    const groupStorageKey = getGroupStorageKey(dbInstanceId, userId)
    setCollapsedSections(prev => {
      if (sectionStorageKey && window.localStorage.getItem(sectionStorageKey) !== null) return prev
      return { income: true, expense: true }
    })
    setCollapsedGroups(prev => {
      if (groupStorageKey && window.localStorage.getItem(groupStorageKey) !== null) return prev
      const next = {}
      tree.forEach(group => { next[group.id] = true })
      return next
    })
  }, [dbInstanceId, userId, tree, collapseStateLoaded])
  useEffect(() => {
    updateScrollState(listRef, setListScrollState)
  }, [tree, selected, loading, inlineForm, collapsedSections, collapsedGroups])

  function childrenForGroup(groupId) {
    return flatCats.filter(cat => cat.parent_id === groupId)
  }

  function handleListDragOver(e) {
    const el = listRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const zone = 48
    const speed = 8
    cancelAnimationFrame(dragScrollRef.current)
    if (e.clientY < rect.top + zone) {
      const scroll = () => {
        el.scrollTop -= speed
        dragScrollRef.current = requestAnimationFrame(scroll)
      }
      dragScrollRef.current = requestAnimationFrame(scroll)
    } else if (e.clientY > rect.bottom - zone) {
      const scroll = () => {
        el.scrollTop += speed
        dragScrollRef.current = requestAnimationFrame(scroll)
      }
      dragScrollRef.current = requestAnimationFrame(scroll)
    }
  }

  function handleListDragLeave() {
    cancelAnimationFrame(dragScrollRef.current)
  }

  function updateScrollState(ref, setter) {
    const el = ref.current
    if (!el) return
    const maxScrollTop = el.scrollHeight - el.clientHeight
    setter({
      top: el.scrollTop > 4,
      bottom: maxScrollTop - el.scrollTop > 4,
    })
  }

  async function persistGroupOrder(sectionType, ids) {
    await Promise.all(
      ids.map((id, index) => api.updateCategory(id, {
        parent_id: null,
        category_type: sectionType,
        sort_order: index,
      }))
    )
  }

  async function persistChildOrder(parentId, ids, movedId) {
    await Promise.all(
      ids.map((id, index) => api.updateCategory(id, {
        sort_order: index,
        ...(id === movedId ? { parent_id: parentId } : {}),
      }))
    )
  }

  async function persistChildrenState(parentId, ids) {
    await Promise.all(
      ids.map((id, index) => api.updateCategory(id, {
        parent_id: parentId,
        sort_order: index,
      }))
    )
  }

  async function moveGroup(dragged, sectionType, targetIndex = null) {
    const fromSection = normalizeType(dragged.categoryType)
    const targetIds = groupsBySection[sectionType].map(group => group.id).filter(id => id !== dragged.id)
    const insertAt = targetIndex == null ? targetIds.length : targetIndex
    targetIds.splice(insertAt, 0, dragged.id)
    await persistGroupOrder(sectionType, targetIds)
    if (fromSection !== sectionType) {
      const sourceIds = groupsBySection[fromSection].map(group => group.id).filter(id => id !== dragged.id)
      await persistGroupOrder(fromSection, sourceIds)
    }
    await loadCategories(dragged.id)
  }

  async function moveChild(dragged, parentId, targetIndex = null) {
    const sourceParentId = dragged.parentId
    const targetIds = childrenForGroup(parentId).map(cat => cat.id).filter(id => id !== dragged.id)
    const insertAt = targetIndex == null ? targetIds.length : targetIndex
    targetIds.splice(insertAt, 0, dragged.id)
    await persistChildOrder(parentId, targetIds, dragged.id)
    if (sourceParentId && sourceParentId !== parentId) {
      const sourceIds = childrenForGroup(sourceParentId).map(cat => cat.id).filter(id => id !== dragged.id)
      await persistChildOrder(sourceParentId, sourceIds, null)
    }
    await loadCategories(dragged.id)
  }

  async function moveChildrenBatch(childIds, targetParentId) {
    const orderedChildIds = visibleChildIds.filter(id => childIds.includes(id))
    if (!orderedChildIds.length) return

    const parentSnapshots = {}
    const sourceParentIds = [...new Set(
      orderedChildIds
        .map(id => flatCats.find(cat => cat.id === id)?.parent_id)
        .filter(Boolean)
    )]
    const affectedParentIds = [...new Set([...sourceParentIds, targetParentId])]

    affectedParentIds.forEach(parentId => {
      parentSnapshots[parentId] = childrenForGroup(parentId).map(cat => cat.id)
    })

    const targetIds = childrenForGroup(targetParentId)
      .map(cat => cat.id)
      .filter(id => !orderedChildIds.includes(id))
      .concat(orderedChildIds)

    for (const parentId of sourceParentIds) {
      if (parentId === targetParentId) continue
      const remainingIds = childrenForGroup(parentId)
        .map(cat => cat.id)
        .filter(id => !orderedChildIds.includes(id))
      await persistChildrenState(parentId, remainingIds)
    }

    await persistChildrenState(targetParentId, targetIds)

    const targetGroup = flatCats.find(cat => cat.id === targetParentId)
    setBulkMoveToast({
      count: orderedChildIds.length,
      targetGroupName: targetGroup?.name || 'group',
      snapshots: parentSnapshots,
      selectedIds: orderedChildIds,
    })

    await loadCategories(orderedChildIds[0])
    setSelectedCategoryIds(orderedChildIds)
    setBulkMoveMode(false)
  }

  async function handleDropRow(dragged, targetCat, dropPosition = 'after') {
    cancelAnimationFrame(dragScrollRef.current)
    if (dragged.childIds?.length > 1) {
      const targetParentId = targetCat.parent_id || targetCat.id
      if (!targetParentId) return
      await moveChildrenBatch(dragged.childIds, targetParentId)
      return
    }
    if (dragged.id === targetCat.id) return
    if (dragged.isGroup) {
      const targetGroup = targetCat.parent_id
        ? flatCats.find(cat => cat.id === targetCat.parent_id)
        : targetCat
      if (!targetGroup) return
      const sectionType = normalizeType(targetGroup.category_type)
      const baseIndex = groupsBySection[sectionType].findIndex(group => group.id === targetGroup.id)
      const targetIndex = dropPosition === 'before' ? baseIndex : baseIndex + 1
      await moveGroup(dragged, sectionType, targetIndex)
      return
    }
    if (targetCat.parent_id) {
      const siblings = childrenForGroup(targetCat.parent_id)
      const baseIndex = siblings.findIndex(cat => cat.id === targetCat.id)
      const targetIndex = dropPosition === 'before' ? baseIndex : baseIndex + 1
      await moveChild(dragged, targetCat.parent_id, targetIndex)
      return
    }
    await moveChild(dragged, targetCat.id, 0)
  }

  async function handleGroupDropEnd(dragged, group) {
    cancelAnimationFrame(dragScrollRef.current)
    if (dragged.childIds?.length > 1) {
      await moveChildrenBatch(dragged.childIds, group.id)
      return
    }
    if (dragged.isGroup) return
    await moveChild(dragged, group.id)
  }

  async function handleSectionDropEnd(dragged, sectionType) {
    cancelAnimationFrame(dragScrollRef.current)
    if (!dragged.isGroup) return
    await moveGroup(dragged, sectionType)
  }

  async function handleRename(id, name) {
    await api.updateCategory(id, { name })
    await loadCategories(id)
  }

  async function handleOwnerChange(groupId, ownerId) {
    await api.updateCategory(groupId, { owner_id: ownerId || null })
    const leaves = childrenForGroup(groupId)
    await Promise.all(leaves.map(cat => api.updateCategory(cat.id, { owner_id: ownerId || null })))
    await loadCategories(groupId)
  }

  async function handleExcludeChange(groupId, exclude) {
    await api.updateCategory(groupId, { exclude_from_totals: exclude ? 1 : 0 })
    await loadCategories(groupId)
  }

  async function handleDelete(id) {
    const category = flatCats.find(cat => cat.id === id)
    const preview = await api.getCategoryDeletePreview(id)
    if (!preview.txn_count) {
      await api.deleteCategory(id)
      if (preview.affected_category_ids.includes(selected?.id)) setSelected(null)
      setSelectedCategoryIds(prev => prev.filter(catId => !preview.affected_category_ids.includes(catId)))
      await loadCategories()
      return
    }
    setDeleteDialog({ category, preview })
    setDeleteMode('replace')
    setDeleteReplacementId('')
  }

  async function confirmDeleteDialog() {
    if (!deleteDialog) return
    if (deleteMode === 'replace' && !deleteReplacementId) return
    setDeleteSaving(true)
    try {
      await api.deleteCategory(deleteDialog.category.id, {
        replacement_category_id: deleteMode === 'replace' ? deleteReplacementId : null,
      })
      if (deleteDialog.preview.affected_category_ids.includes(selected?.id)) setSelected(null)
      setSelectedCategoryIds(prev => prev.filter(catId => !deleteDialog.preview.affected_category_ids.includes(catId)))
      setDeleteDialog(null)
      setDeleteReplacementId('')
      await loadCategories()
    } finally {
      setDeleteSaving(false)
    }
  }

  function closeDeleteDialog() {
    if (deleteSaving) return
    setDeleteDialog(null)
    setDeleteReplacementId('')
    setDeleteMode('replace')
  }

  function selectCategory(cat, event) {
    if (bulkMoveMode) {
      setSelected(cat)
      return
    }
    setSelected(cat)
    setInlineForm(null)

    if (!cat.parent_id) {
      setSelectedCategoryIds([])
      return
    }

    setSelectedCategoryIds([cat.id])
  }

  function getDragPayload(cat) {
    if (bulkMoveMode) return null
    if (!cat.parent_id) {
      return {
        id: cat.id,
        parentId: cat.parent_id,
        isGroup: true,
        categoryType: normalizeType(cat.category_type),
      }
    }
    const multiSelected = selectedCategoryIds.includes(cat.id) && selectedCategoryIds.length > 1
    if (multiSelected) {
      return {
        id: cat.id,
        childIds: selectedCategoryIds.slice(),
        parentId: cat.parent_id,
        isGroup: false,
        categoryType: normalizeType(cat.category_type),
      }
    }
    return {
      id: cat.id,
      parentId: cat.parent_id,
      isGroup: false,
      categoryType: normalizeType(cat.category_type),
    }
  }

  function toggleSection(sectionType) {
    setCollapsedSections(prev => ({ ...prev, [sectionType]: !prev[sectionType] }))
  }

  function toggleGroup(groupId) {
    setCollapsedGroups(prev => ({ ...prev, [groupId]: !prev[groupId] }))
  }

  function expandAll(target) {
    const nextGroups = {}
    tree.forEach(group => { nextGroups[group.id] = false })
    setCollapsedSections({ income: false, expense: false })
    setCollapsedGroups(nextGroups)
    setContextMenu(null)
  }

  function collapseAll(target) {
    const nextGroups = {}
    tree.forEach(group => { nextGroups[group.id] = true })
    setCollapsedGroups(nextGroups)
    setCollapsedSections({ income: true, expense: true })
    setContextMenu(null)
  }

  async function alphabetize(target) {
    const sectionGroups = groupsBySection[target.sectionType] || []
    const allGroupsCollapsedInSection = sectionGroups.length > 0 && sectionGroups.every(group => !!collapsedGroups[group.id])

    if (target.groupId && !allGroupsCollapsedInSection) {
      const siblings = childrenForGroup(target.groupId)
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      await persistChildOrder(target.groupId, siblings.map(cat => cat.id), null)
      await loadCategories(target.groupId)
    } else {
      const groups = groupsBySection[target.sectionType]
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      await persistGroupOrder(target.sectionType, groups.map(group => group.id))
      await loadCategories()
    }
    setContextMenu(null)
  }

  function openGroupForm(sectionType) {
    setContextMenu(null)
    setBulkMoveMode(false)
    setSelected(null)
    setSelectedCategoryIds([])
    setNewName('')
    setInlineForm({ mode: 'group', sectionType, anchorGroupId: null, insertPosition: 'after' })
  }

  function openGroupFormNear(sectionType, anchorGroupId = null, insertPosition = 'after') {
    setContextMenu(null)
    setBulkMoveMode(false)
    setSelected(null)
    setSelectedCategoryIds([])
    setNewName('')
    setInlineForm({ mode: 'group', sectionType, anchorGroupId, insertPosition })
  }

  function openCategoryForm(group) {
    setContextMenu(null)
    setBulkMoveMode(false)
    setSelected(group)
    setSelectedCategoryIds([])
    setNewName('')
    setInlineForm({
      mode: 'category',
      sectionType: normalizeType(group.category_type),
      parentId: group.id,
      groupName: group.name,
    })
  }

  async function submitInlineForm() {
    if (!inlineForm || !newName.trim()) return
    if (inlineForm.mode === 'group') {
      const created = await api.createCategory({
        name: newName.trim(),
        category_type: inlineForm.sectionType,
        sort_order: groupsBySection[inlineForm.sectionType].length,
      })
      const nextIds = groupsBySection[inlineForm.sectionType].map(group => group.id)
      const anchorIndex = inlineForm.anchorGroupId
        ? nextIds.findIndex(id => id === inlineForm.anchorGroupId)
        : -1
      const insertAt = anchorIndex === -1
        ? nextIds.length
        : inlineForm.insertPosition === 'before'
          ? anchorIndex
          : anchorIndex + 1
      nextIds.splice(insertAt, 0, created.id)
      await persistGroupOrder(inlineForm.sectionType, nextIds)
    } else {
      await api.createCategory({
        name: newName.trim(),
        parent_id: inlineForm.parentId,
        sort_order: childrenForGroup(inlineForm.parentId).length,
      })
    }
    const keepSelectedId = inlineForm.mode === 'category' ? inlineForm.parentId : null
    setNewName('')
    setInlineForm(null)
    await loadCategories(keepSelectedId)
  }

  async function undoBulkMove() {
    if (!bulkMoveToast) return
    const entries = Object.entries(bulkMoveToast.snapshots)
    for (const [parentId, ids] of entries) {
      await persistChildrenState(parentId, ids)
    }
    const restoreId = bulkMoveToast.selectedIds?.[0] || null
    setBulkMoveToast(null)
    await loadCategories(restoreId)
    setSelectedCategoryIds(bulkMoveToast.selectedIds || [])
  }

  function openContextMenu(e, cat, sectionTypeOverride = null) {
    const group = cat?.parent_id ? flatCats.find(item => item.id === cat.parent_id) : cat
    const sectionType = sectionTypeOverride || normalizeType(group?.category_type)
    const rect = e.currentTarget?.getBoundingClientRect?.()
    const insertPosition = rect && e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      sectionType,
      groupId: group?.id || null,
      groupName: group?.name || '',
      categoryId: cat?.parent_id ? cat.id : null,
      categoryName: cat?.parent_id ? cat.name : '',
      scope: group?.id ? 'group' : 'section',
      insertPosition,
    })
  }

  function openRuleCreator(target) {
    setContextMenu(null)
    navigate('/rules', {
      state: {
        openRuleCreator: {
          initialValues: {
            catId: target.categoryId,
          },
        },
      },
    })
  }

  function startBulkMove(target) {
    setContextMenu(null)
    setInlineForm(null)
    setBulkMoveMode(true)
    if (!selected?.parent_id && target.groupId) {
      const group = flatCats.find(cat => cat.id === target.groupId)
      if (group) setSelected(group)
    }
    setSelectedCategoryIds([])
  }

  function cancelBulkMove() {
    setContextMenu(null)
    setBulkMoveMode(false)
    setSelectedCategoryIds([])
  }

  function toggleBulkChecked(cat) {
    if (!bulkMoveMode) return
    if (cat.parent_id) {
      setSelected(cat)
      setSelectedCategoryIds(prev => (
        prev.includes(cat.id)
          ? prev.filter(id => id !== cat.id)
          : [...prev, cat.id]
      ))
      return
    }

    const childIds = (cat.children || []).map(child => child.id)
    const allChecked = childIds.length > 0 && childIds.every(id => selectedCategoryIds.includes(id))
    setSelected(cat)
    setSelectedCategoryIds(prev => {
      const base = prev.filter(id => !childIds.includes(id))
      return allChecked ? base : [...base, ...childIds]
    })
  }

  async function moveSelectedCategoriesHere(target) {
    const targetParentId = target.groupId
    if (!targetParentId || selectedCategoryIds.length === 0) {
      setContextMenu(null)
      return
    }
    setContextMenu(null)
    await moveChildrenBatch(selectedCategoryIds, targetParentId)
  }

  const parentCategory = selected?.parent_id ? flatCats.find(cat => cat.id === selected.parent_id) : null
  const selectedGroupType = normalizeType(selected?.category_type)
  const selectedCategories = selectedCategoryIds
    .map(id => flatCats.find(cat => cat.id === id))
    .filter(Boolean)
  const isMultiCategorySelection = selectedCategories.length > 1
  const multiSelectionGroupIds = [...new Set(selectedCategories.map(cat => cat.parent_id).filter(Boolean))]
  const multiSelectionGroups = multiSelectionGroupIds
    .map(id => flatCats.find(cat => cat.id === id))
    .filter(Boolean)
  const selectedCategoryIdSet = new Set(selectedCategoryIds)
  const categoryOwners = owners.filter(owner => owner.name.toLowerCase() !== 'shared')
  const deleteReplacementCategories = deleteDialog
    ? flatCats.filter(cat => !deleteDialog.preview.affected_category_ids.includes(cat.id))
    : flatCats
  const selectedCategoryFilter = isMultiCategorySelection
    ? null
    : selected
      ? (selected.parent_id ? selected.id : `__group__${selected.id}`)
      : null
  const selectedCategoryIdsFilter = isMultiCategorySelection
    ? selectedCategories.map(cat => cat.id).join(',')
    : null
  const matchingTxnsKey = selectedCategoryFilter
    ? `${selectedCategoryFilter}|${filters.date?.start || ''}|${filters.date?.end || ''}`
    : selectedCategoryIdsFilter
      ? `${selectedCategoryIdsFilter}|${filters.date?.start || ''}|${filters.date?.end || ''}`
      : null

  const loadMatchingTxnPage = useCallback((offset, limit) => (
    api.getTransactions({
      category_id: selectedCategoryFilter,
      category_ids: selectedCategoryIdsFilter || undefined,
      date_start: filters.date?.start || undefined,
      date_end: filters.date?.end || undefined,
      limit,
      offset,
    })
  ), [selectedCategoryFilter, selectedCategoryIdsFilter, filters.date?.start, filters.date?.end])

  const {
    rows: pagedMatchingTxns,
    setRows: setPagedMatchingTxns,
    loading: matchingTxnsLoading,
    loadingMore: matchingTxnsLoadingMore,
    listRef: matchingTxnsListRef,
  } = usePagedTransactions({
    activeKey: matchingTxnsKey,
    loadPage: loadMatchingTxnPage,
  })

  function addMatchingCategory(cat) {
    setFlatCats(prev => prev.find(existing => existing.id === cat.id) ? prev : [...prev, cat])
  }

  async function saveMatchingTxnCategory(txnId, catId, catObj) {
    await api.overrideCategory(txnId, catId)
    const cat = catObj || flatCats.find(c => c.id === catId)
    setPagedMatchingTxns(prev => prev.map(txn =>
      txn.id === txnId ? {
        ...txn,
        category_id: catId,
        category_name: cat?.name ?? null,
        category_color: cat?.color ?? null,
        category_overridden: 1,
      } : txn
    ))
  }

  useEffect(() => {
    if (!matchingTxnsKey) {
      setMatchingTxnsTotal(0)
      return
    }
    let cancelled = false
    api.getTransactions({
      category_id: selectedCategoryFilter,
      category_ids: selectedCategoryIdsFilter || undefined,
      date_start: filters.date?.start || undefined,
      date_end: filters.date?.end || undefined,
      limit: 1,
      offset: 0,
    }).then(result => {
      if (cancelled) return
      setMatchingTxnsTotal(result.total || 0)
    }).catch(() => {
      if (cancelled) return
      setMatchingTxnsTotal(0)
    })
    return () => { cancelled = true }
  }, [matchingTxnsKey, selectedCategoryFilter, selectedCategoryIdsFilter, filters.date?.start, filters.date?.end])

  return (
    <div style={{ padding: 32, display: 'flex', flexDirection: 'column', height: '100%', boxSizing: 'border-box' }}>
      <PageHeader title="Categories" />
      <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 20, flex: 1, minHeight: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
            <div
              ref={listRef}
              onDragOver={handleListDragOver}
              onDragLeave={handleListDragLeave}
              onScroll={() => updateScrollState(listRef, setListScrollState)}
              style={{
                flex: 1,
                overflowY: 'auto',
                minHeight: 0,
                height: '100%',
                border: '1px solid var(--border)',
                borderRadius: 10,
                background: 'var(--surface)',
                scrollbarWidth: 'thin',
                scrollbarColor: 'color-mix(in srgb, var(--border) 85%, transparent) transparent',
              }}
            >
            {!loading && bulkMoveMode ? (
              <div style={{
                position: 'sticky',
                top: 0,
                zIndex: 2,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '8px 11px',
                background: 'color-mix(in srgb, var(--accent) 10%, var(--surface))',
                borderBottom: '1px solid var(--border)',
              }}>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                  Select categories to move, then right-click a group and choose <strong>Move here</strong>.
                </div>
                <button
                  onClick={cancelBulkMove}
                  style={{
                    background: 'none',
                    border: '1px solid var(--border)',
                    color: 'var(--muted)',
                    borderRadius: 999,
                    padding: '4px 10px',
                    fontSize: 12,
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                >
                  Done
                </button>
              </div>
            ) : null}
            {loading ? <Spinner /> : ['income', 'expense'].map(sectionType => {
              const sectionGroups = groupsBySection[sectionType]
              const sectionMeta = SECTION_META[sectionType]
              const showSectionForm =
                inlineForm?.mode === 'group' &&
                inlineForm.sectionType === sectionType &&
                !inlineForm.anchorGroupId
              const sectionCollapsed = !!collapsedSections[sectionType]

              return (
                <div
                  key={sectionType}
                  onContextMenu={e => {
                    e.preventDefault()
                    openContextMenu(e, null, sectionType)
                  }}
                  style={{ borderBottom: sectionType === 'income' ? '1px solid var(--border)' : 'none' }}
                >
                  <div
                    style={{
                      padding: '5px 11px 4px',
                      background: 'color-mix(in srgb, var(--surface2) 70%, transparent)',
                      borderBottom: '1px solid var(--border)',
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 8,
                      cursor: 'pointer',
                    }}
                    onClick={() => toggleSection(sectionType)}
                  >
                    <button
                      onClick={e => {
                        e.stopPropagation()
                        toggleSection(sectionType)
                      }}
                      title={sectionCollapsed ? `Expand ${sectionMeta.label}` : `Collapse ${sectionMeta.label}`}
                      style={{
                        background: 'var(--surface)',
                        border: '1px solid var(--border)',
                        color: 'var(--muted)',
                        cursor: 'pointer',
                        fontSize: 12,
                        width: 21,
                        height: 21,
                        padding: 0,
                        marginTop: 1,
                        flexShrink: 0,
                        borderRadius: 5,
                        display: 'grid',
                        placeItems: 'center',
                        lineHeight: 1,
                      }}
                    >
                      {sectionCollapsed ? '+' : '-'}
                    </button>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 700, lineHeight: 1.1 }}>
                        {sectionMeta.label}
                      </div>
                    </div>
                  </div>

                  {!sectionCollapsed && sectionGroups.length === 0 && !showSectionForm ? (
                    <div style={{ padding: '12px', fontSize: 12, color: 'var(--muted)' }}>
                      No {sectionMeta.label.toLowerCase()} groups yet. Right-click here to add one.
                    </div>
                  ) : null}

                  {!sectionCollapsed ? sectionGroups.map(group => {
                    const groupCollapsed = !!collapsedGroups[group.id]
                    const showGroupFormBefore =
                      inlineForm?.mode === 'group' &&
                      inlineForm.sectionType === sectionType &&
                      inlineForm.anchorGroupId === group.id &&
                      inlineForm.insertPosition === 'before'
                    const showGroupFormAfter =
                      inlineForm?.mode === 'group' &&
                      inlineForm.sectionType === sectionType &&
                      inlineForm.anchorGroupId === group.id &&
                      inlineForm.insertPosition !== 'before'
                    return (
                    <div key={group.id}>
                      {showGroupFormBefore ? (
                        <InlineAddForm
                          label={`${sectionMeta.label} group name`}
                          value={newName}
                          onNameChange={setNewName}
                          onSubmit={submitInlineForm}
                          onCancel={() => setInlineForm(null)}
                        />
                      ) : null}
                      <CategoryRow
                        cat={group}
                        isChild={false}
                        isSelected={selected?.id === group.id}
                        bulkMoveMode={bulkMoveMode}
                        bulkChecked={(group.children || []).length > 0 && (group.children || []).every(child => selectedCategoryIdSet.has(child.id))}
                        isCollapsed={groupCollapsed}
                        canCollapse={true}
                        onToggleCollapse={toggleGroup}
                        onSelect={selectCategory}
                        onRename={handleRename}
                        onDelete={handleDelete}
                        onToggleBulkChecked={toggleBulkChecked}
                        onDropRow={handleDropRow}
                        onOpenContextMenu={openContextMenu}
                        onDragStartRow={getDragPayload}
                      />
                      {!groupCollapsed ? (group.children || []).map(child => (
                        <CategoryRow
                          key={child.id}
                          cat={child}
                          isChild={true}
                          isSelected={selectedCategoryIds.includes(child.id)}
                          bulkMoveMode={bulkMoveMode}
                          bulkChecked={selectedCategoryIdSet.has(child.id)}
                          onSelect={selectCategory}
                          onRename={handleRename}
                          onDelete={handleDelete}
                          onToggleBulkChecked={toggleBulkChecked}
                          onDropRow={handleDropRow}
                          onOpenContextMenu={openContextMenu}
                          onDragStartRow={getDragPayload}
                        />
                      )) : null}

                      {!groupCollapsed && inlineForm?.mode === 'category' && inlineForm.parentId === group.id ? (
                        <InlineAddForm
                          label={`New category in ${group.name}`}
                          value={newName}
                          onNameChange={setNewName}
                          onSubmit={submitInlineForm}
                          onCancel={() => setInlineForm(null)}
                        />
                      ) : null}

                      <GroupEndDropZone group={group} onDropEnd={handleGroupDropEnd} />
                      {showGroupFormAfter ? (
                        <InlineAddForm
                          label={`${sectionMeta.label} group name`}
                          value={newName}
                          onNameChange={setNewName}
                          onSubmit={submitInlineForm}
                          onCancel={() => setInlineForm(null)}
                        />
                      ) : null}
                    </div>
                    )
                  }) : null}

                  {!sectionCollapsed && showSectionForm ? (
                    <InlineAddForm
                      label={`${sectionMeta.label} group name`}
                      value={newName}
                      onNameChange={setNewName}
                      onSubmit={submitInlineForm}
                      onCancel={() => setInlineForm(null)}
                    />
                  ) : null}

                  {!sectionCollapsed ? <SectionEndDropZone sectionType={sectionType} onDropEnd={handleSectionDropEnd} /> : null}
                </div>
              )
            })}
            </div>
            <ScrollFade top={listScrollState.top} bottom={listScrollState.bottom} />
          </div>

        </div>

        <div style={{ position: 'relative', minHeight: 0 }}>
          <div
            style={{
              overflow: 'hidden',
              minHeight: 0,
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              border: '1px solid var(--border)',
              borderRadius: 10,
              background: 'var(--surface)',
              padding: 20,
              scrollbarWidth: 'thin',
              scrollbarColor: 'color-mix(in srgb, var(--border) 85%, transparent) transparent',
            }}
          >
          {!selected ? (
            <EmptyState message="Select a category or group to view details" />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
              {isMultiCategorySelection ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <CategoryMarker kind="category" size={8} />
                    <h2 style={{ fontSize: 16, fontWeight: 600 }}>{selectedCategories.length} selected categories</h2>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                    {selectedCategories.map(cat => (
                      <span
                        key={cat.id}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 5,
                          padding: '2px 8px',
                          borderRadius: 999,
                          border: '1px solid var(--border)',
                          background: 'var(--surface2)',
                          fontSize: 12,
                        }}
                      >
                        <CategoryMarker kind="category" />
                        {cat.name}
                      </span>
                    ))}
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>
                    {multiSelectionGroups.length === 1
                      ? `Subcategories of ${multiSelectionGroups[0]?.name || '-'}`
                      : `${multiSelectionGroups.length} groups represented`}
                  </div>
                </>
              ) : (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                    <CategoryMarker kind={selected.parent_id ? 'category' : 'group'} size={selected.parent_id ? 8 : 10} />
                    <h2 style={{ fontSize: 16, fontWeight: 600 }}>{selected.name}</h2>
                  </div>

                  {selected.parent_id ? (
                    <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>
                      Subcategory of {parentCategory?.name || '-'}
                      {parentCategory?.exclude_from_totals ? ' (excluded from totals)' : ''}
                    </div>
                  ) : (
                    <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>
                      {SECTION_META[selectedGroupType].label} group - {(tree.find(group => group.id === selected.id)?.children || []).length} subcategories
                    </div>
                  )}
                </>
              )}

              {!isMultiCategorySelection && (
              <>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 16,
                  flexWrap: 'wrap',
                  marginBottom: 20,
                  padding: '10px 14px',
                  background: 'var(--surface2)',
                  borderRadius: 8,
                  border: '1px solid var(--border)',
                }}
              >
                {owners.length > 0 ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '1 1 160px' }}>
                    <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>Owner</span>
                    <select
                      value={selected.owner_id || ''}
                      onChange={e => handleOwnerChange(selected.id, e.target.value || null)}
                      style={{
                        flex: 1,
                        background: 'var(--surface)',
                        color: 'var(--text)',
                        border: '1px solid var(--border)',
                        borderRadius: 6,
                        padding: '4px 8px',
                        fontSize: 12,
                        cursor: 'pointer',
                      }}
                    >
                      <option value="">- Shared -</option>
                      {categoryOwners.map(owner => (
                        <option key={owner.id} value={owner.id}>{owner.name}</option>
                      ))}
                    </select>
                  </div>
                ) : null}

                {!selected.parent_id ? (
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 12,
                      color: 'var(--muted)',
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                      userSelect: 'none',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={!!selected.exclude_from_totals}
                      onChange={e => handleExcludeChange(selected.id, e.target.checked)}
                      style={{ accentColor: 'var(--accent)', width: 14, height: 14, cursor: 'pointer' }}
                    />
                    Exclude from totals
                  </label>
                ) : null}
              </div>

              </>
              )}

              <div style={{ marginTop: 22, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>
                    Matching transactions
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {matchingTxnsTotal} total{matchingTxnsTotal > pagedMatchingTxns.length ? ` · showing ${pagedMatchingTxns.length}` : ''}
                  </div>
                </div>

                {matchingTxnsLoading ? <Spinner /> : pagedMatchingTxns.length === 0 ? (
                  <div style={{
                    padding: '14px 16px',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    background: 'var(--surface2)',
                    fontSize: 13,
                    color: 'var(--muted)',
                  }}>
                    No transactions currently match this {selected.parent_id ? 'category' : 'group'}.
                  </div>
                ) : (
                  <TransactionListTable
                    rows={pagedMatchingTxns}
                    categories={flatCats}
                    onCategorySave={saveMatchingTxnCategory}
                    onAddCategory={addMatchingCategory}
                    onRowsChange={setPagedMatchingTxns}
                    scrollRef={matchingTxnsListRef}
                    fillHeight={true}
                  />
                )}
                {matchingTxnsLoadingMore ? (
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
                    Loading more transactions…
                  </div>
                ) : null}
              </div>
            </div>
          )}
          </div>
        </div>
      </div>

      {contextMenu ? (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          target={contextMenu}
          bulkMoveMode={bulkMoveMode}
          canMoveHere={!!contextMenu.groupId && selectedCategoryIds.length > 0}
          onAddCategory={target => {
            const group = flatCats.find(cat => cat.id === target.groupId)
            if (group) openCategoryForm(group)
          }}
          onAddGroup={target => openGroupFormNear(target.sectionType, target.groupId || null, target.insertPosition || 'after')}
          onExpandAll={expandAll}
          onCollapseAll={collapseAll}
          onAlphabetize={alphabetize}
          onAddRule={openRuleCreator}
          onStartBulkMove={startBulkMove}
          onMoveHere={moveSelectedCategoriesHere}
          onCancelBulkMove={cancelBulkMove}
          onClose={() => setContextMenu(null)}
        />
      ) : null}

      {bulkMoveToast ? (
        <BulkMoveToast
          move={bulkMoveToast}
          onUndo={undoBulkMove}
          onDismiss={() => setBulkMoveToast(null)}
        />
      ) : null}

      {deleteDialog ? (
        <DeleteCategoryDialog
          category={deleteDialog.category}
          preview={deleteDialog.preview}
          categories={deleteReplacementCategories}
          replacementId={deleteReplacementId}
          onReplacementChange={setDeleteReplacementId}
          mode={deleteMode}
          onModeChange={setDeleteMode}
          onConfirm={confirmDeleteDialog}
          onCancel={closeDeleteDialog}
          saving={deleteSaving}
        />
      ) : null}
    </div>
  )
}
