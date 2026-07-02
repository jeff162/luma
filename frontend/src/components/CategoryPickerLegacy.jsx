// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { Badge, CategoryMarker } from './ui.jsx'

function NewCategoryForm({ groups, mode, defaultGroupId, defaultName = '', onSave, onCreateGroup, onCancel }) {
  const [name, setName] = useState(defaultName)
  const [groupId, setGroupId] = useState(defaultGroupId ?? '')
  const [newGroupName, setNewGroupName] = useState('')
  const [categoryType, setCategoryType] = useState('expense')
  const [saving, setSaving] = useState(false)
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

  async function handleSave() {
    if (mode === 'leaf' && !groupId) return
    if (creatingNewGroup && !newGroupName.trim()) return
    if (!creatingNewGroup && !name.trim()) return
    setSaving(true)
    if (mode === 'group') {
      const created = await api.createCategory({ name: name.trim(), parent_id: null, category_type: categoryType })
      await onSave(created)
      setSaving(false)
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
      setSaving(false)
      return
    }

    const created = await api.createCategory({ name: name.trim(), parent_id: groupId })
    await onSave(created)
    setSaving(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} onMouseDown={e => e.stopPropagation()}>
      {canChooseGroup ? (
        creatingNewGroup ? (
          <>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                ref={groupNameInputRef}
                value={newGroupName}
                onChange={e => setNewGroupName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onCancel() }}
                placeholder="New group name..."
                style={{ flex: 1, background: 'var(--surface2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', fontSize: 13, outline: 'none' }}
              />
              <button
                type="button"
                onClick={() => setGroupId('')}
                title="Choose an existing group instead"
                style={{
                  flexShrink: 0,
                  background: 'var(--surface2)',
                  color: 'var(--muted)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: '6px 9px',
                  fontSize: 11,
                  cursor: 'pointer',
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
          <select value={groupId} onChange={e => setGroupId(e.target.value)} style={{ background: 'var(--surface2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 8px', fontSize: 12 }}>
            <option value="">Group name...</option>
            {groups.map(g => <option key={g.id} value={g.id}>{g.category_type === 'income' ? 'Income' : 'Expense'} • {g.name}</option>)}
            <option value="__new_group__">New group...</option>
          </select>
        )
      ) : null}
      {mode === 'group' && (
        <select value={categoryType} onChange={e => setCategoryType(e.target.value)} style={{ background: 'var(--surface2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 8px', fontSize: 12 }}>
          <option value="expense">Expense</option>
          <option value="income">Income</option>
        </select>
      )}
      {!creatingNewGroup ? (
        <input
          ref={inputRef}
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onCancel() }}
          placeholder={mode === 'group' ? 'Group name…' : 'Category name…'}
          style={{ background: 'var(--surface2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', fontSize: 13, outline: 'none' }}
        />
      ) : null}
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={handleSave} disabled={saving || (!creatingNewGroup && !name.trim()) || (creatingNewGroup && !newGroupName.trim())} style={{ flex: 1, background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, padding: '5px 0', fontSize: 12, cursor: saving || (!creatingNewGroup && !name.trim()) || (creatingNewGroup && !newGroupName.trim()) ? 'not-allowed' : 'pointer', opacity: saving || (!creatingNewGroup && !name.trim()) || (creatingNewGroup && !newGroupName.trim()) ? 0.5 : 1 }}>{saving ? 'Saving…' : 'Create'}</button>
        <button onClick={onCancel} style={{ background: 'var(--surface2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 10px', fontSize: 12, cursor: 'pointer' }}>Cancel</button>
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
  style,
  onOpenChange,
}) {
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(null)
  const [query, setQuery] = useState(initialQuery || '')
  const [cursor, setCursor] = useState(0)
  const [panelPosition, setPanelPosition] = useState(null)
  const ref = useRef(null)
  const inputRef = useRef(null)
  const panelRef = useRef(null)
  const groups = categories.filter(c => !c.parent_id)
  const leaves = categories.filter(c => c.parent_id)
  const selected = categories.find(c => c.id === value)
  const selectedGroupId = selected?.parent_id ?? null
  const filtered = useMemo(() => {
    const trimmedQuery = query.trim().toLowerCase()
    if (!trimmedQuery) return leaves

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
      .map(item => item.category)
  }, [leaves, query, selectedGroupId])

  useEffect(() => {
    setCursor(0)
  }, [query])

  useEffect(() => {
    if (!open || !panelRef.current) return
    if (!query.trim()) return
    panelRef.current.scrollTop = 0
  }, [open, query])

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
    onOpenChange?.(open)
  }, [open, onOpenChange])

  useLayoutEffect(() => {
    if (!open || !ref.current) {
      setPanelPosition(null)
      return
    }

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

  useEffect(() => {
    if (!open) return
    function h(e) {
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false)
        setCreating(null)
      }
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

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

  function handleKeyDown(e) {
    e.stopPropagation()
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      e.preventDefault()
      setOpen(true)
      return
    }
    if (e.key === 'Escape') {
      setOpen(false)
      setCreating(null)
      return
    }
    if (creating || !open) return
    if (e.key === 'Enter' && query.trim() && filtered.length === 0) {
      e.preventDefault()
      setCreating({ type: 'leaf', groupId: null, defaultName: query.trim() })
      return
    }
    if (filtered.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor(c => Math.min(c + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor(c => Math.max(c - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      pick(filtered[cursor])
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
            value={query}
            onFocus={() => setOpen(true)}
            onChange={e => { setQuery(e.target.value); setOpen(true); setCreating(null) }}
            onKeyDown={handleKeyDown}
            onMouseDown={e => e.stopPropagation()}
            placeholder={selected ? selected.name : placeholder}
            style={{ flex: 1, background: 'none', color: 'var(--text)', border: 'none', outline: 'none', fontSize: 13, minWidth: 0, lineHeight: 1.2, padding: 0 }}
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              setOpen(true)
              setCreating(null)
              setTimeout(() => inputRef.current?.focus(), 0)
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
          type="button"
          onClick={() => {
            setOpen(v => !v)
            setCreating(null)
            setTimeout(() => inputRef.current?.focus(), 0)
          }}
          style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 11, padding: '0 2px', lineHeight: 1 }}
          title="Browse categories"
        >
          {open ? '▴' : '▾'}
        </button>
      </div>
      {open && (
        <div
          ref={panelRef}
          style={{
            position: 'fixed',
            left: panelPosition?.left ?? 8,
            top: panelPosition?.top ?? 'auto',
            bottom: panelPosition?.bottom ?? 'auto',
            width: panelPosition?.width ?? (compact ? 280 : 340),
            zIndex: 300,
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
              {query.trim() ? (
                <>
                  {filtered.map((c, idx) => {
                    const parent = groups.find(g => g.id === c.parent_id)
                    const active = idx === cursor
                    const selectedRow = value === c.id
                    return (
                      <div
                        key={c.id}
                        data-picker-row-active={active ? 'true' : 'false'}
                        onMouseDown={e => { e.preventDefault(); pick(c) }}
                        onMouseEnter={() => setCursor(idx)}
                        style={{
                          padding: '5px 10px',
                          fontSize: 13,
                          cursor: 'pointer',
                          background: active ? 'color-mix(in srgb, var(--accent) 12%, var(--surface2))' : 'transparent',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          minWidth: 0,
                        }}
                      >
                        <CategoryMarker kind="category" />
                        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {c.name}
                        </span>
                        {parent && (
                          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0 }}>
                            {parent.name}
                          </span>
                        )}
                        {selectedRow ? <span style={{ color: 'var(--accent2)', fontSize: 11, flexShrink: 0 }}>✓</span> : null}
                      </div>
                    )
                  })}
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
              ) : groups.map(g => {
                const kids = leaves.filter(c => c.parent_id === g.id)
                const creatingHere = creating?.type === 'leaf' && creating.groupId === g.id
                return (
                  <div key={g.id}>
                    <div style={{ padding: '5px 10px 1px', fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: 7 }}>
                      <CategoryMarker kind="group" />
                      <span>{g.name}</span>
                    </div>
                    {kids.map(c => (
                      <div
                      key={c.id}
                      onMouseDown={e => { e.preventDefault(); pick(c) }}
                      style={{ padding: '5px 10px 5px 24px', fontSize: 13, cursor: 'pointer', background: value === c.id ? 'color-mix(in srgb, var(--accent) 12%, var(--surface2))' : 'transparent', display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--surface2)'}
                      onMouseLeave={e => e.currentTarget.style.background = value === c.id ? 'color-mix(in srgb, var(--accent) 12%, var(--surface2))' : 'transparent'}
                    >
                      <CategoryMarker kind="category" />
                      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {c.name}
                      </span>
                      {value === c.id && <span style={{ marginLeft: 'auto', color: 'var(--accent2)', fontSize: 11 }}>✓</span>}
                    </div>
                    ))}
                    {creatingHere ? (
                      <div style={{ padding: '4px 10px 6px 18px' }}>
                        <NewCategoryForm
                          groups={groups}
                          mode="leaf"
                          defaultGroupId={g.id}
                          defaultName={creating.defaultName ?? query.trim()}
                          onSave={handleCreated}
                          onCancel={() => setCreating(null)}
                        />
                      </div>
                    ) : (
                      <div
                        onMouseDown={e => { e.stopPropagation(); setCreating({ type: 'leaf', groupId: g.id }) }}
                        style={{ padding: '4px 10px 5px 24px', fontSize: 12, color: 'var(--accent2)', cursor: 'pointer', opacity: 0.8 }}
                        onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                        onMouseLeave={e => e.currentTarget.style.opacity = '0.8'}
                      >
                        ＋ New category in {g.name}
                      </div>
                    )}
                  </div>
                )
              })}
              {!query.trim() && (
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
        </div>
      )}
    </div>
  )
}
