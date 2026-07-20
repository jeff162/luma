// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../lib/api.js'
import { Badge, Button, CategoryMarker, SectionEyebrow, getFormControlStyle } from './ui.jsx'
import { useDismissibleLayer } from '../lib/uiInteractions.js'
import TransientTextInput from './TransientTextInput.jsx'

/*
 * CategoryPicker is a hybrid search-and-create control: it preserves group context while searching,
 * biases matches toward the currently selected group, and can branch directly into creating a missing
 * category or group so recategorization never dead-ends on "no results".
 */
function renderHighlightedCategoryName(name, query) {
  if (!query) return name

  const label = String(name || '')
  const normalizedLabel = label.toLowerCase()
  const normalizedQuery = String(query || '').toLowerCase()
  if (!normalizedQuery) return label

  const parts = []
  let searchFrom = 0
  let key = 0

  while (searchFrom < label.length) {
    const matchIndex = normalizedLabel.indexOf(normalizedQuery, searchFrom)
    if (matchIndex === -1) {
      parts.push(label.slice(searchFrom))
      break
    }

    if (matchIndex > searchFrom) {
      parts.push(label.slice(searchFrom, matchIndex))
    }

    parts.push(
      <span
        key={`match-${key}`}
        style={{
          background: 'color-mix(in srgb, var(--accent) 16%, var(--surface2))',
          boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--accent) 36%, transparent)',
          borderRadius: 4,
          padding: '0 2px',
          fontWeight: 600,
        }}
      >
        {label.slice(matchIndex, matchIndex + normalizedQuery.length)}
      </span>,
    )

    searchFrom = matchIndex + normalizedQuery.length
    key += 1
  }

  return parts
}

function NewCategoryForm({ groups, mode, defaultGroupId, defaultName = '', onSave, onCreateGroup, onCancel }) {
  const fieldIdBase = useId()
  const [name, setName] = useState(defaultName)
  const [groupId, setGroupId] = useState(defaultGroupId ?? '')
  const [newGroupName, setNewGroupName] = useState('')
  const [categoryType, setCategoryType] = useState('expense')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef(null)
  const groupNameInputRef = useRef(null)
  const creatingNewGroup = mode === 'leaf' && groupId === '__new_group__'
  const canChooseGroup = mode === 'leaf' && groups.length > 1

  useEffect(() => {
    if (creatingNewGroup) {
      groupNameInputRef.current?.focus()
      groupNameInputRef.current?.setSelectionRange(
        groupNameInputRef.current.value.length,
        groupNameInputRef.current.value.length,
      )
      return
    }
    inputRef.current?.focus()
    inputRef.current?.setSelectionRange(
      inputRef.current.value.length,
      inputRef.current.value.length,
    )
  }, [creatingNewGroup])

  useEffect(() => {
    setError('')
  }, [creatingNewGroup, categoryType, groupId, mode])

  async function handleSave() {
    if (mode === 'leaf' && !groupId) return
    if (creatingNewGroup && !newGroupName.trim()) return
    if (!creatingNewGroup && !name.trim()) return
    setSaving(true)
    setError('')
    try {
      if (mode === 'group') {
        const created = await api.createCategory({ name: name.trim(), parent_id: null, category_type: categoryType })
        await onSave(created)
        return
      }

      if (creatingNewGroup) {
        const createdGroup = await api.createCategory({
          name: newGroupName.trim(),
          parent_id: null,
          category_type: categoryType,
        })
        if (name.trim()) {
          const createdCategory = await api.createCategory({
            name: name.trim(),
            parent_id: createdGroup.id,
          })
          await onSave(createdCategory, createdGroup)
        } else {
          await onCreateGroup?.(createdGroup)
        }
        return
      }

      const created = await api.createCategory({ name: name.trim(), parent_id: groupId })
      await onSave(created)
    } catch (err) {
      setError(err?.message || 'Could not create that category')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} onMouseDown={e => e.stopPropagation()}>
      {canChooseGroup ? (
        creatingNewGroup ? (
          <>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <TransientTextInput
                ref={groupNameInputRef}
                id={`${fieldIdBase}-new-group`}
                name="category-picker-new-group-name"
                aria-label="New group name"
                value={newGroupName}
                onChange={nextValue => {
                  if (error) setError('')
                  setNewGroupName(nextValue)
                }}
                onCommit={handleSave}
                onCancel={onCancel}
                restoreOnEscape
                onBlurCommit={false}
                placeholder="New group name..."
                style={{ flex: 1, ...getFormControlStyle({ size: 'md' }) }}
              />
              <button
                type="button"
                onClick={() => setGroupId('')}
                title="Choose an existing group instead"
                style={{
                  flexShrink: 0,
                  ...getFormControlStyle({ size: 'md', clickable: true }),
                  color: 'var(--muted)',
                  padding: '6px 9px',
                  fontSize: 11,
                  lineHeight: 1,
                }}
              >
                ▾
              </button>
            </div>
            <div style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              {['expense', 'income'].map(type => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setCategoryType(type)}
                  style={{
                    background: categoryType === type ? 'color-mix(in srgb, var(--accent) 14%, var(--surface2))' : 'var(--surface2)',
                    color: categoryType === type ? 'var(--accent2)' : 'var(--muted)',
                    border: `1px solid ${categoryType === type ? 'var(--accent)' : 'var(--border)'}`,
                    borderRadius: 999,
                    padding: '4px 10px',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  {type === 'expense' ? 'Expense' : 'Income'}
                </button>
              ))}
            </div>
          </>
        ) : (
          <select
            name="category-picker-group"
            aria-label="Choose category group"
            value={groupId}
            onChange={e => setGroupId(e.target.value)}
            style={{ ...getFormControlStyle({ size: 'sm', clickable: true }) }}
          >
            <option value="">Group name...</option>
            {groups.map(g => <option key={g.id} value={g.id}>{g.category_type === 'income' ? 'Income' : 'Expense'} • {g.name}</option>)}
            <option value="__new_group__">New group...</option>
          </select>
        )
      ) : null}
      {mode === 'group' && (
        <select
          name="category-picker-type"
          aria-label="Choose category type"
          value={categoryType}
          onChange={e => setCategoryType(e.target.value)}
          style={{ ...getFormControlStyle({ size: 'sm', clickable: true }) }}
        >
          <option value="expense">Expense</option>
          <option value="income">Income</option>
        </select>
      )}
      {!creatingNewGroup ? (
        <TransientTextInput
          ref={inputRef}
          id={`${fieldIdBase}-name`}
          name="category-picker-new-name"
          aria-label={mode === 'group' ? 'New group name' : 'New category name'}
          autoComplete="off"
          value={name}
          onChange={nextValue => {
            if (error) setError('')
            setName(nextValue)
          }}
          onCommit={handleSave}
          onCancel={onCancel}
          restoreOnEscape
          onBlurCommit={false}
          placeholder={mode === 'group' ? 'Group name…' : 'Category name…'}
          style={{ ...getFormControlStyle({ size: 'md' }) }}
        />
      ) : null}
      {error ? (
        <div style={{ fontSize: 12, color: 'var(--danger)', lineHeight: 1.3 }}>
          {error}
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 6 }}>
        <Button
          small
          onClick={handleSave}
          disabled={saving || (!creatingNewGroup && !name.trim()) || (creatingNewGroup && !newGroupName.trim())}
          style={{ flex: 1, justifyContent: 'center' }}
        >
          {saving ? 'Saving…' : 'Create'}
        </Button>
        <Button small variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  )
}

export default function CategoryPicker({
  value,
  categories,
  onChange,
  onCategoryCreated,
  onAddCategory,
  placeholder = 'Type to search categories…',
  emptyBadgeLabel = 'Choose category',
  initialQuery = '',
  openToken = 0,
  showSelectedBadge = false,
  compact = false,
  // When set, a "Uncategorized" row appears at the top of the open list *while a category is assigned*,
  // emitting onChange(null) so callers that support an unassigned state can clear back to it. Off by
  // default: callers whose value can't be null (or means something else, e.g. bulk-set) shouldn't show it.
  clearable = false,
  style,
  onOpenChange,
  // The dropdown is portaled to <body>; raise this above any modal it's used inside (AppDialog is 1200).
  panelZIndex = 1100,
}) {
  const pickerId = useId()
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(null)
  const [query, setQuery] = useState(initialQuery || '')
  const [cursor, setCursor] = useState(0)
  const [panelPosition, setPanelPosition] = useState(null)
  const ref = useRef(null)
  const inputRef = useRef(null)
  const panelRef = useRef(null)
  const triggerButtonRef = useRef(null)
  const toggleButtonRef = useRef(null)
  const querySnapshotRef = useRef(initialQuery || '')
  const hasReportedInitialOpenStateRef = useRef(false)
  const groups = categories.filter(c => !c.parent_id)
  const leaves = categories.filter(c => c.parent_id)
  const selected = categories.find(c => c.id === value)
  const selectedGroupId = selected?.parent_id ?? null
  const trimmedQuery = query.trim().toLowerCase()
  const matchingItems = useMemo(() => {
    if (!trimmedQuery) return []

    function getMatchRank(category) {
      const categoryName = String(category.name || '').toLowerCase()

      if (categoryName.startsWith(trimmedQuery)) return 0
      if (categoryName.split(/[\s/&-]+/).some(part => part.startsWith(trimmedQuery))) return 1
      if (categoryName.includes(trimmedQuery)) return 2
      return null
    }

    return leaves
      .map(category => ({
        category,
        rank: getMatchRank(category),
        inSelectedGroup: selectedGroupId != null && category.parent_id === selectedGroupId,
      }))
      .filter(item => item.rank != null)
      .sort((a, b) => {
        if (a.rank !== b.rank) return a.rank - b.rank
        if (a.inSelectedGroup !== b.inSelectedGroup) return a.inSelectedGroup ? -1 : 1
        return String(a.category.name || '').localeCompare(String(b.category.name || ''), undefined, { sensitivity: 'base' })
      })
  }, [leaves, trimmedQuery, selectedGroupId])
  const displayGroups = useMemo(() => {
    // Even in search mode, keep matches grouped under their parents so the user can judge context and create in the right place.
    if (!trimmedQuery) {
      return groups.map(group => ({
        group,
        categories: leaves.filter(category => category.parent_id === group.id),
      }))
    }

    const groupEntries = new Map()
    for (const item of matchingItems) {
      const existing = groupEntries.get(item.category.parent_id) ?? {
        categories: [],
        bestRank: item.rank,
      }
      existing.categories.push(item.category)
      existing.bestRank = Math.min(existing.bestRank, item.rank)
      groupEntries.set(item.category.parent_id, existing)
    }

    return groups
      .map(group => {
        const entry = groupEntries.get(group.id)
        return entry ? { group, categories: entry.categories, bestRank: entry.bestRank } : null
      })
      .filter(Boolean)
      .sort((a, b) => {
        const aInSelectedGroup = selectedGroupId != null && a.group.id === selectedGroupId
        const bInSelectedGroup = selectedGroupId != null && b.group.id === selectedGroupId
        if (aInSelectedGroup !== bInSelectedGroup) return aInSelectedGroup ? -1 : 1
        if (a.bestRank !== b.bestRank) return a.bestRank - b.bestRank
        return String(a.group.name || '').localeCompare(String(b.group.name || ''), undefined, { sensitivity: 'base' })
      })
  }, [groups, leaves, matchingItems, selectedGroupId, trimmedQuery])
  const displayedCategories = useMemo(
    () => displayGroups.flatMap(entry => entry.categories),
    [displayGroups],
  )
  const displayedIndexById = useMemo(
    () => new Map(displayedCategories.map((category, index) => [category.id, index])),
    [displayedCategories],
  )

  useEffect(() => {
    setCursor(0)
  }, [query])

  useEffect(() => {
    if (!open || !panelRef.current) return
    if (!trimmedQuery) return
    panelRef.current.scrollTop = 0
  }, [open, trimmedQuery])

  // Opening the (unsearched) list while a category is already chosen: put the keyboard cursor on it and
  // scroll it into view, so the current choice is visibly selected and the user can see the categories
  // around it rather than starting at the top.
  useEffect(() => {
    if (!open || trimmedQuery || value == null) return
    const idx = displayedIndexById.get(value)
    if (idx == null) return
    setCursor(idx)
    const timer = setTimeout(() => {
      panelRef.current?.querySelector('[data-picker-row-selected="true"]')?.scrollIntoView({ block: 'nearest' })
    }, 0)
    return () => clearTimeout(timer)
  }, [open, trimmedQuery, value, displayedIndexById])

  useEffect(() => {
    setQuery(initialQuery || '')
  }, [initialQuery])

  useEffect(() => {
    if (!openToken) return
    setCreating(null)
    setOpen(true)
    setQuery(initialQuery || '')
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [openToken, initialQuery])

  useEffect(() => {
    if (!open) setCreating(null)
  }, [open])

  useEffect(() => {
    if (!hasReportedInitialOpenStateRef.current) {
      hasReportedInitialOpenStateRef.current = true
      return
    }
    onOpenChange?.(open)
  }, [open, onOpenChange])

  function openPicker(nextQuery = query) {
    querySnapshotRef.current = query
    setCreating(null)
    setOpen(true)
    if (nextQuery !== query) {
      setQuery(nextQuery)
    }
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  function closePicker({ restoreQuery = true, focusTarget = 'trigger' } = {}) {
    // Half-typed searches are transient; closing without a pick should restore the last committed label/query.
    if (restoreQuery) {
      setQuery(querySnapshotRef.current)
    }
    setOpen(false)
    setCreating(null)
    if (focusTarget) {
      setTimeout(() => {
        if (focusTarget === 'toggle') toggleButtonRef.current?.focus()
        else triggerButtonRef.current?.focus()
      }, 0)
    }
  }

  useLayoutEffect(() => {
    if (!open || !ref.current) {
      setPanelPosition(null)
      return
    }

    // The panel portals to document.body, so it has to measure against the viewport instead of any clipped parent container.
    const triggerRect = ref.current.getBoundingClientRect()
    const viewportPadding = 8
    const panelGap = 4
    const minPanelWidth = compact ? 280 : 340
    const panelWidth = Math.min(
      Math.max(triggerRect.width, minPanelWidth),
      window.innerWidth - viewportPadding * 2,
    )
    const triggerMidpoint = triggerRect.top + (triggerRect.height / 2)
    const availableBelow = Math.max(0, window.innerHeight - triggerRect.bottom - viewportPadding - panelGap)
    const availableAbove = Math.max(0, triggerRect.top - viewportPadding - panelGap)
    const openUp = triggerMidpoint > (window.innerHeight / 2)
    const availableSpace = openUp ? availableAbove : availableBelow
    const maxHeight = Math.max(0, availableSpace)
    const left = Math.min(
      Math.max(viewportPadding, triggerRect.left),
      window.innerWidth - panelWidth - viewportPadding,
    )
    const top = openUp ? null : triggerRect.bottom + panelGap
    const bottom = openUp ? Math.max(viewportPadding, window.innerHeight - triggerRect.top + panelGap) : null

    setPanelPosition({ left, top, bottom, width: panelWidth, maxHeight })
  }, [open, compact, creating, query, categories.length])

  useEffect(() => {
    if (!open) return
    function handleResize() {
      setPanelPosition(null)
    }
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
    }
  }, [open])

  useDismissibleLayer({
    open,
    onClose: () => closePicker({ focusTarget: null }),
    refs: [ref, panelRef],
  })

  async function handleCreated(created, createdGroup = null) {
    if (createdGroup) onAddCategory?.(createdGroup)
    onAddCategory?.(created)
    await onCategoryCreated?.(created)
    onChange(created.id)
    setQuery(showSelectedBadge ? '' : created.name)
    setCreating(null)
    setOpen(false)
  }

  async function handleGroupCreated(created) {
    onAddCategory?.(created)
    await onCategoryCreated?.(created)
    setQuery('')
    setCreating({ type: 'leaf', groupId: created.id })
    setOpen(true)
  }

  function pick(cat) {
    onChange(cat.id)
    setQuery(showSelectedBadge ? '' : cat.name)
    setOpen(false)
    setCreating(null)
  }

  function clearSelection() {
    onChange(null)
    setQuery('')
    setOpen(false)
    setCreating(null)
  }

  function handleKeyDown(e) {
    e.stopPropagation()
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      e.preventDefault()
      openPicker()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      closePicker()
      return
    }
    if (creating || !open) return
    if (e.key === 'Enter' && query.trim() && displayedCategories.length === 0) {
      e.preventDefault()
      setCreating({ type: 'leaf', groupId: null, defaultName: query.trim() })
      return
    }
    if (displayedCategories.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor(c => Math.min(c + 1, displayedCategories.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor(c => Math.max(c - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      pick(displayedCategories[cursor])
    }
  }

  const closedAsBadge = showSelectedBadge && !open
  const closedEmptyPillStyle = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    borderRadius: 99,
    padding: '2px 8px',
    fontSize: 12,
    fontWeight: 500,
    whiteSpace: 'nowrap',
    border: '1px solid var(--border)',
    background: 'var(--surface2)',
    color: 'var(--muted)',
  }
  const openPillChrome = showSelectedBadge
    ? {
        background: 'var(--surface2)',
        border: '1px solid var(--accent)',
        borderRadius: 99,
        padding: '2px 8px',
        minHeight: 'auto',
      }
    : {
        background: 'var(--surface)',
        border: open ? '1px solid var(--accent)' : '1px solid var(--border)',
        borderRadius: 8,
        padding: '6px 10px',
        minHeight: 38,
      }

  return (
    <div ref={ref} style={{ position: 'relative', flex: 1, ...style }}>
      <div style={{
        background: closedAsBadge ? 'transparent' : openPillChrome.background,
        color: 'var(--text)',
        border: closedAsBadge ? 'none' : openPillChrome.border,
        borderRadius: closedAsBadge ? 0 : openPillChrome.borderRadius,
        padding: closedAsBadge ? 0 : openPillChrome.padding,
        fontSize: 13,
        display: 'flex',
        alignItems: 'center',
        gap: closedAsBadge ? 4 : 6,
        minHeight: closedAsBadge ? 'auto' : openPillChrome.minHeight,
      }}>
        {open ? (
          <input
            ref={inputRef}
            id={`${pickerId}-search`}
            name="category-picker-search"
            aria-label="Search categories"
            autoComplete="off"
            value={query}
            onFocus={() => {
              if (!open) openPicker()
            }}
            onChange={e => { setQuery(e.target.value); setOpen(true); setCreating(null) }}
            onKeyDown={handleKeyDown}
            onMouseDown={e => e.stopPropagation()}
            placeholder={selected ? selected.name : placeholder}
            style={{ flex: 1, background: 'none', color: 'var(--text)', border: 'none', outline: 'none', fontSize: 13, minWidth: 0, lineHeight: 1.2, padding: 0 }}
          />
        ) : (
          <button
            ref={triggerButtonRef}
            type="button"
            onClick={() => {
              openPicker()
            }}
            style={{
              flex: 1,
              minWidth: 0,
              background: 'none',
              border: 'none',
              padding: 0,
              textAlign: 'left',
              color: 'var(--text)',
              cursor: 'pointer',
            }}
          >
            {selected && showSelectedBadge ? (
              <Badge label={selected.name} toneKey={selected.id || selected.name} />
            ) : (
              selected ? (
                <span style={{ color: 'var(--text)', fontSize: 13, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {selected.name}
                </span>
              ) : showSelectedBadge ? (
                <span style={closedEmptyPillStyle}>
                  <CategoryMarker kind="category" />
                  {emptyBadgeLabel}
                </span>
              ) : (
                <span style={{ color: 'var(--muted)', fontSize: 13, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {placeholder}
                </span>
              )
            )}
          </button>
        )}
        <button
          ref={toggleButtonRef}
          type="button"
          onClick={() => {
            if (open) closePicker({ focusTarget: 'toggle' })
            else openPicker()
          }}
          style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 11, padding: '0 2px', lineHeight: 1 }}
          title="Browse categories"
        >
          {open ? '▴' : '▾'}
        </button>
      </div>
      {open && createPortal(
        <div
          ref={panelRef}
          style={{
            position: 'fixed',
            left: panelPosition?.left ?? 8,
            top: panelPosition?.top ?? 'auto',
            bottom: panelPosition?.bottom ?? 'auto',
            width: panelPosition?.width ?? (compact ? 280 : 340),
            zIndex: panelZIndex,
            visibility: panelPosition ? 'visible' : 'hidden',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
            maxHeight: panelPosition?.maxHeight ?? 300,
            overflowY: 'auto',
          }}
        >
          {creating === 'group' ? (
            <div style={{ padding: 8 }}>
              <NewCategoryForm groups={groups} mode="group" defaultGroupId={null} onSave={handleGroupCreated} onCancel={() => setCreating(null)} />
            </div>
          ) : creating?.type === 'leaf' && creating.groupId == null ? (
            <div style={{ padding: 8 }}>
              <NewCategoryForm
                groups={groups}
                mode="leaf"
                defaultGroupId={null}
                defaultName={creating.defaultName ?? query.trim()}
                onSave={handleCreated}
                onCreateGroup={createdGroup => {
                  onAddCategory?.(createdGroup)
                  setQuery('')
                  setCreating({ type: 'leaf', groupId: createdGroup.id, defaultName: creating.defaultName ?? query.trim() })
                  setOpen(true)
                }}
                onCancel={() => setCreating(null)}
              />
            </div>
          ) : (
            <>
              {clearable && value && !trimmedQuery ? (
                <>
                  <div
                    onMouseDown={e => { e.preventDefault(); clearSelection() }}
                    style={{ padding: '6px 10px', fontSize: 13, color: 'var(--muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
                  >
                    <span style={{ fontSize: 12, opacity: 0.75 }} aria-hidden>⊘</span>
                    <span style={{ fontStyle: 'italic' }}>Uncategorized</span>
                  </div>
                  <div style={{ borderTop: '1px solid var(--border)', margin: '2px 0' }} />
                </>
              ) : null}
              {displayGroups.map(({ group, categories: groupCategories }) => {
                const creatingHere = creating?.type === 'leaf' && creating.groupId === group.id
                return (
                  <div key={group.id}>
                    <SectionEyebrow style={{ padding: '5px 10px 1px', display: 'flex', alignItems: 'center', gap: 7 }}>
                      <CategoryMarker kind="group" />
                      <span>{group.name}</span>
                    </SectionEyebrow>
                    {groupCategories.map(c => {
                      const active = trimmedQuery && displayedIndexById.get(c.id) === cursor
                      const selectedRow = value === c.id
                      const background = active
                        ? 'color-mix(in srgb, var(--accent) 12%, var(--surface2))'
                        : (!trimmedQuery && selectedRow)
                          ? 'color-mix(in srgb, var(--accent) 12%, var(--surface2))'
                        : 'transparent'
                      return (
                        <div
                          key={c.id}
                          data-picker-row-active={active ? 'true' : 'false'}
                          data-picker-row-selected={selectedRow ? 'true' : 'false'}
                          onMouseDown={e => { e.preventDefault(); pick(c) }}
                          onMouseEnter={() => {
                            const nextCursor = displayedIndexById.get(c.id)
                            if (nextCursor != null) setCursor(nextCursor)
                          }}
                          style={{ padding: '5px 10px 5px 24px', fontSize: 13, cursor: 'pointer', background, display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}
                        >
                          <CategoryMarker kind="category" />
                          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {renderHighlightedCategoryName(c.name, trimmedQuery)}
                          </span>
                          {selectedRow ? <span style={{ marginLeft: 'auto', color: 'var(--accent2)', fontSize: 11 }}>✓</span> : null}
                        </div>
                      )
                    })}
                    {creatingHere ? (
                      <div style={{ padding: '4px 10px 6px 18px' }}>
                        <NewCategoryForm
                          groups={groups}
                          mode="leaf"
                          defaultGroupId={group.id}
                          defaultName={creating.defaultName ?? query.trim()}
                          onSave={handleCreated}
                          onCancel={() => setCreating(null)}
                        />
                      </div>
                    ) : !trimmedQuery ? (
                      <div
                        onMouseDown={e => { e.stopPropagation(); setCreating({ type: 'leaf', groupId: group.id }) }}
                        style={{ padding: '4px 10px 5px 24px', fontSize: 12, color: 'var(--accent2)', cursor: 'pointer', opacity: 0.8 }}
                        onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                        onMouseLeave={e => e.currentTarget.style.opacity = '0.8'}
                      >
                        ＋ New category in {group.name}
                      </div>
                    ) : null}
                  </div>
                )
              })}
              {trimmedQuery && displayGroups.length === 0 && (
                <div style={{ padding: '10px 12px 8px', fontSize: 12, color: 'var(--muted)' }}>
                  No matching categories
                </div>
              )}
              {trimmedQuery && (
                <>
                  <div style={{ borderTop: '1px solid var(--border)', margin: '2px 0' }} />
                  <div
                    onMouseDown={e => { e.stopPropagation(); setCreating({ type: 'leaf', groupId: null, defaultName: query.trim() }) }}
                    style={{ padding: '5px 10px 6px', fontSize: 12, fontWeight: 600, color: 'var(--accent2)', cursor: 'pointer', opacity: 0.9 }}
                    onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                    onMouseLeave={e => e.currentTarget.style.opacity = '0.9'}
                  >
                    ＋ New category
                  </div>
                </>
              )}
              {!trimmedQuery && (
                <>
                  <div style={{ borderTop: '1px solid var(--border)', margin: '2px 0' }} />
                  <div
                    onMouseDown={e => { e.stopPropagation(); setCreating('group') }}
                    style={{ padding: '5px 10px 6px', fontSize: 11, color: 'var(--muted)', cursor: 'pointer', opacity: 0.8 }}
                    onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                    onMouseLeave={e => e.currentTarget.style.opacity = '0.8'}
                  >
                    ＋ New group
                  </div>
                </>
              )}
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}
