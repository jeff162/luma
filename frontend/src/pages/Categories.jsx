import { useState, useEffect, useRef, useCallback } from 'react'
import { api } from '../lib/api.js'
import { PageHeader, Spinner, EmptyState } from '../components/ui.jsx'

const SECTION_META = {
  income: { label: 'Income', hint: 'Groups for salary, refunds, investments, and other inflows.' },
  expense: { label: 'Expense', hint: 'Groups for spending, transfers, and everything else.' },
}

const SECTION_STORAGE_KEY = 'fintrack.categories.collapsedSections'
const GROUP_STORAGE_KEY = 'fintrack.categories.collapsedGroups'

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

function EditableName({ value, isSelected, onSave, onFirstClick }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const inputRef = useRef(null)

  useEffect(() => {
    if (!isSelected) setEditing(false)
  }, [isSelected])

  function handleClick(e) {
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
      title={isSelected ? 'Click to rename' : 'Click to select'}
      style={{ cursor: isSelected ? 'text' : 'default', flex: 1 }}
    >
      {value}
    </span>
  )
}

let dragItem = null

function CategoryRow({
  cat,
  isChild,
  isSelected,
  isCollapsed = false,
  canCollapse = false,
  onToggleCollapse,
  onSelect,
  onRename,
  onDelete,
  onDropRow,
  onOpenContextMenu,
}) {
  const [dragOver, setDragOver] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  function canAcceptDrop() {
    if (!dragItem || dragItem.id === cat.id) return false
    if (isChild && dragItem.isGroup) return false
    return true
  }

  return (
    <div
      draggable
      onDragStart={e => {
        dragItem = {
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
      onClick={() => {
        if (!confirmDelete) onSelect(cat)
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
        gap: 6,
        padding: isChild ? '4px 10px 4px 26px' : '6px 10px',
        cursor: 'grab',
        userSelect: 'none',
        borderBottom: '1px solid var(--border)',
        background: dragOver
          ? 'var(--surface2)'
          : isSelected
            ? 'color-mix(in srgb, var(--accent) 12%, var(--surface))'
            : 'transparent',
        fontWeight: isChild ? 400 : 600,
        fontSize: 13,
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
            fontSize: 13,
            width: 22,
            height: 22,
            padding: 0,
            flexShrink: 0,
            borderRadius: 6,
            display: 'grid',
            placeItems: 'center',
            lineHeight: 1,
            backgroundColor: 'var(--surface2)',
          }}
        >
          {isCollapsed ? '+' : '-'}
        </button>
      ) : (
        <span style={{ width: 22, flexShrink: 0 }} />
      )}
      <span style={{ color: 'var(--border)', fontSize: 11, flexShrink: 0 }}>...</span>
      <span style={{ fontSize: 12, marginRight: 1 }}>{cat.icon}</span>
      <EditableName
        value={cat.name}
        isSelected={isSelected}
        onSave={name => onRename(cat.id, name)}
        onFirstClick={() => onSelect(cat)}
      />
      {!confirmDelete ? (
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
            fontSize: 13,
            padding: '1px 3px',
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

function ContextMenu({ x, y, target, onAddCategory, onAddGroup, onClose }) {
  const ref = useRef(null)

  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [onClose])

  const menuW = 220
  const left = Math.min(x, window.innerWidth - menuW - 8)
  const top = Math.min(y, window.innerHeight - 100)
  const itemStyle = {
    padding: '8px 14px',
    fontSize: 13,
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
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: 4,
        boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
        minWidth: menuW,
      }}
    >
      {target.groupId ? (
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
  const [tree, setTree] = useState([])
  const [flatCats, setFlatCats] = useState([])
  const [owners, setOwners] = useState([])
  const [selected, setSelected] = useState(null)
  const [loading, setLoading] = useState(true)
  const [newName, setNewName] = useState('')
  const [contextMenu, setContextMenu] = useState(null)
  const [inlineForm, setInlineForm] = useState(null)
  const [collapsedSections, setCollapsedSections] = useState({})
  const [collapsedGroups, setCollapsedGroups] = useState({})
  const [collapseStateLoaded, setCollapseStateLoaded] = useState(false)
  const [listScrollState, setListScrollState] = useState({ top: false, bottom: false })
  const [detailScrollState, setDetailScrollState] = useState({ top: false, bottom: false })

  const listRef = useRef(null)
  const detailRef = useRef(null)
  const dragScrollRef = useRef(null)
  const selectedRef = useRef(null)

  useEffect(() => {
    selectedRef.current = selected
  }, [selected])

  useEffect(() => {
    try {
      const savedSections = JSON.parse(window.localStorage.getItem(SECTION_STORAGE_KEY) || 'null')
      const savedGroups = JSON.parse(window.localStorage.getItem(GROUP_STORAGE_KEY) || 'null')
      if (savedSections && typeof savedSections === 'object') setCollapsedSections(savedSections)
      if (savedGroups && typeof savedGroups === 'object') setCollapsedGroups(savedGroups)
    } catch {
      // Ignore malformed saved UI state and fall back to defaults.
    } finally {
      setCollapseStateLoaded(true)
    }
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
  }, [])

  useEffect(() => { loadCategories() }, [loadCategories])
  useEffect(() => { api.getOwners().then(setOwners) }, [])
  useEffect(() => {
    if (!collapseStateLoaded) return
    try {
      window.localStorage.setItem(SECTION_STORAGE_KEY, JSON.stringify(collapsedSections))
    } catch {
      // Ignore storage failures in environments that block localStorage.
    }
  }, [collapsedSections, collapseStateLoaded])
  useEffect(() => {
    if (!collapseStateLoaded) return
    try {
      window.localStorage.setItem(GROUP_STORAGE_KEY, JSON.stringify(collapsedGroups))
    } catch {
      // Ignore storage failures in environments that block localStorage.
    }
  }, [collapsedGroups, collapseStateLoaded])

  const groupsBySection = {
    income: tree.filter(group => normalizeType(group.category_type) === 'income'),
    expense: tree.filter(group => normalizeType(group.category_type) === 'expense'),
  }

  useEffect(() => {
    if (!tree.length || !collapseStateLoaded) return
    setCollapsedSections(prev => {
      if (window.localStorage.getItem(SECTION_STORAGE_KEY) !== null) return prev
      return { income: true, expense: true }
    })
    setCollapsedGroups(prev => {
      if (window.localStorage.getItem(GROUP_STORAGE_KEY) !== null) return prev
      const next = {}
      tree.forEach(group => { next[group.id] = true })
      return next
    })
  }, [tree, collapseStateLoaded])
  useEffect(() => {
    updateScrollState(listRef, setListScrollState)
    updateScrollState(detailRef, setDetailScrollState)
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

  async function handleDropRow(dragged, targetCat, dropPosition = 'after') {
    cancelAnimationFrame(dragScrollRef.current)
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
    await api.deleteCategory(id)
    if (selected?.id === id) setSelected(null)
    await loadCategories()
  }

  function selectCategory(cat) {
    setSelected(cat)
    setInlineForm(null)
  }

  function toggleSection(sectionType) {
    setCollapsedSections(prev => ({ ...prev, [sectionType]: !prev[sectionType] }))
  }

  function toggleGroup(groupId) {
    setCollapsedGroups(prev => ({ ...prev, [groupId]: !prev[groupId] }))
  }

  function openGroupForm(sectionType) {
    setContextMenu(null)
    setSelected(null)
    setNewName('')
    setInlineForm({ mode: 'group', sectionType, anchorGroupId: null, insertPosition: 'after' })
  }

  function openGroupFormNear(sectionType, anchorGroupId = null, insertPosition = 'after') {
    setContextMenu(null)
    setSelected(null)
    setNewName('')
    setInlineForm({ mode: 'group', sectionType, anchorGroupId, insertPosition })
  }

  function openCategoryForm(group) {
    setContextMenu(null)
    setSelected(group)
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
        icon: '📦',
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
        icon: '📦',
        parent_id: inlineForm.parentId,
        sort_order: childrenForGroup(inlineForm.parentId).length,
      })
    }
    const keepSelectedId = inlineForm.mode === 'category' ? inlineForm.parentId : null
    setNewName('')
    setInlineForm(null)
    await loadCategories(keepSelectedId)
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
      insertPosition,
    })
  }

  const parentCategory = selected?.parent_id ? flatCats.find(cat => cat.id === selected.parent_id) : null
  const selectedGroupType = normalizeType(selected?.category_type)
  const categoryOwners = owners.filter(owner => owner.name.toLowerCase() !== 'shared')

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
                      padding: '12px 12px 10px',
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
                        fontSize: 13,
                        width: 24,
                        height: 24,
                        padding: 0,
                        marginTop: 1,
                        flexShrink: 0,
                        borderRadius: 6,
                        display: 'grid',
                        placeItems: 'center',
                        lineHeight: 1,
                      }}
                    >
                      {sectionCollapsed ? '+' : '-'}
                    </button>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                        {sectionMeta.label}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                        {sectionMeta.hint}
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
                        isCollapsed={groupCollapsed}
                        canCollapse={true}
                        onToggleCollapse={toggleGroup}
                        onSelect={selectCategory}
                        onRename={handleRename}
                        onDelete={handleDelete}
                        onDropRow={handleDropRow}
                        onOpenContextMenu={openContextMenu}
                      />
                      {!groupCollapsed ? (group.children || []).map(child => (
                        <CategoryRow
                          key={child.id}
                          cat={child}
                          isChild={true}
                          isSelected={selected?.id === child.id}
                          onSelect={selectCategory}
                          onRename={handleRename}
                          onDelete={handleDelete}
                          onDropRow={handleDropRow}
                          onOpenContextMenu={openContextMenu}
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

          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6, lineHeight: 1.5, padding: '0 2px' }}>
            Right-click inside Income or Expense to add a group. Right-click a group to add a category. Drag groups to reorder or move them between sections.
          </div>
        </div>

        <div style={{ position: 'relative', minHeight: 0 }}>
          <div
            ref={detailRef}
            onScroll={() => updateScrollState(detailRef, setDetailScrollState)}
            style={{
              overflowY: 'auto',
              minHeight: 0,
              height: '100%',
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
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                <h2 style={{ fontSize: 16, fontWeight: 600 }}>{selected.icon} {selected.name}</h2>
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

              {!selected.parent_id && inlineForm?.mode !== 'category' ? (
                <button
                  onClick={() => openCategoryForm(selected)}
                  style={{
                    background: 'none',
                    border: '1px solid var(--border)',
                    color: 'var(--muted)',
                    borderRadius: 6,
                    padding: '5px 12px',
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  + Add subcategory
                </button>
              ) : null}

              <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 16, lineHeight: 1.6 }}>
                To set up automatic classification rules for this category, use the <strong>Rules</strong> page.
              </p>
            </>
          )}
          </div>
          <ScrollFade top={detailScrollState.top} bottom={detailScrollState.bottom} />
        </div>
      </div>

      {contextMenu ? (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          target={contextMenu}
          onAddCategory={target => {
            const group = flatCats.find(cat => cat.id === target.groupId)
            if (group) openCategoryForm(group)
          }}
          onAddGroup={target => openGroupFormNear(target.sectionType, target.groupId || null, target.insertPosition || 'after')}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
    </div>
  )
}
