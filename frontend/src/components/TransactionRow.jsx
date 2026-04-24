// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { api } from '../lib/api.js'
import { Button, CategoryMarker, SectionEyebrow, getFormControlStyle } from './ui.jsx'
import CategoryDisplay from './CategoryDisplay.jsx'
import { useDismissibleLayer, useTransientTextEdit } from '../lib/uiInteractions.js'
import TransientTextInput from './TransientTextInput.jsx'
import AmountDisplay from './AmountDisplay.jsx'
import { TagGlyph } from './TagUi.jsx'

/*
 * These cells centralize transaction editing semantics across every table in the app. Parents keep the row data;
 * the cells keep transient edit state local and report only committed changes back so each surface can stay
 * optimistic without forking the interaction rules for merchant rename, notes, or recategorization.
 */

const detailButtonStyle = {
  background: 'none',
  border: 'none',
  color: 'var(--accent2)',
  cursor: 'pointer',
  fontSize: 11,
  padding: '3px 5px',
  opacity: 0.75,
  lineHeight: 1,
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 6,
}

export function buildGroups(flatCats) {
  const groups = flatCats.filter(c => !c.parent_id)
  return groups.map(g => ({
    value:   g.id,
    label:   g.name,
    options: flatCats.filter(c => c.parent_id === g.id)
      .map(c => ({ value: c.id, label: c.name })),
  })).filter(g => g.options.length > 0)
}

export function getTxnMerchantLabel(txn) {
  return txn.display_name || txn.merchant_name || txn.raw_name || '—'
}

function getTxnImportedMerchantLabel(txn) {
  return txn.merchant_name || txn.raw_name || txn.display_name || '—'
}

export function getTxnImportSourceLabel(txn) {
  return txn.import_batch_filename || 'Not imported from file'
}

export function NotePopover({ txn, onSave, onClose }) {
  const [draft, setDraft] = useState(txn.notes || '')
  const ref       = useRef(null)
  const textareaRef = useRef(null)

  useEffect(() => {
    textareaRef.current?.focus()
    textareaRef.current?.select()
  }, [])

  useDismissibleLayer({
    open: true,
    onClose,
    refs: [ref],
  })

  function commit() {
    const val = draft.trim() || null
    onSave(val)
    onClose()
  }

  return (
    <div
      ref={ref}
      style={{
        position: 'absolute', zIndex: 500, top: '100%', left: 0,
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
        padding: 12, minWidth: 260, marginTop: 4,
      }}
      onClick={e => e.stopPropagation()}
    >
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 6 }}>
        {txn.notes ? 'Edit note' : 'Add note'}
      </div>
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Escape') { e.stopPropagation(); onClose() }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commit()
        }}
        placeholder="Add a note…"
        rows={3}
        style={{
          width: '100%', resize: 'vertical', background: 'var(--surface2)',
          color: 'var(--text)', border: '1px solid var(--accent)', borderRadius: 6,
          padding: '6px 8px', fontSize: 13, outline: 'none', boxSizing: 'border-box',
        }}
      />
      <div style={{ display: 'flex', gap: 6, marginTop: 8, justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            onClick={commit}
            style={{
              background: 'var(--accent)', color: '#fff', border: 'none',
              borderRadius: 6, padding: '5px 12px', fontSize: 12, cursor: 'pointer',
            }}
          >Save</button>
          <button
            onClick={onClose}
            style={{
              background: 'var(--surface2)', color: 'var(--text)',
              border: '1px solid var(--border)', borderRadius: 6,
              padding: '5px 10px', fontSize: 12, cursor: 'pointer',
            }}
          >Cancel</button>
        </div>
        {txn.notes && (
          <button
            onClick={() => { onSave(null); onClose() }}
            style={{
              background: 'none', border: 'none', color: 'var(--danger)',
              fontSize: 12, cursor: 'pointer', padding: '5px 4px',
            }}
          >Remove</button>
        )}
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
        ⌘/Ctrl+Enter to save
      </div>
    </div>
  )
}

export function NoteCell({ txn, onUpdateNote }) {
  const [showPopover, setShowPopover] = useState(false)
  const hasNote = !!txn.notes

  async function handleSave(val) {
    await api.updateNotes(txn.id, val)
    onUpdateNote?.(txn.id, val)
  }

  return (
    <div
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
      onClick={e => { e.stopPropagation(); setShowPopover(v => !v) }}
    >
      {hasNote ? (
        <span
          title={txn.notes}
          style={{
            fontSize: 13, cursor: 'pointer', opacity: 0.75,
            lineHeight: 1, padding: '0 2px',
          }}
        >📝</span>
      ) : (
        <span
          title="Add note"
          style={{
            fontSize: 11, cursor: 'pointer', opacity: 0,
            color: 'var(--muted)', padding: '0 2px', lineHeight: 1,
            // revealed by parent row hover via CSS class would be ideal,
            // but since we're inline-styling, we show it via the context menu instead
          }}
        >+</span>
      )}
      {showPopover && (
        <NotePopover
          txn={txn}
          onSave={handleSave}
          onClose={() => setShowPopover(false)}
        />
      )}
    </div>
  )
}

export function useContextMenu() {
  const [menu, setMenu] = useState(null)

  function onContextMenu(e, txn) {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, txn })
  }

  function close() { setMenu(null) }

  return { menu, onContextMenu, close }
}

export function ContextMenu({ menu, onClose, onOpenDetail, onEditNote, onOpenRule, ruleActionLabel = 'Rule…' }) {
  const ref = useRef(null)
  useDismissibleLayer({
    open: !!menu,
    onClose,
    refs: [ref],
  })

  const x = Math.min(menu.x, window.innerWidth  - 180)
  const y = Math.min(menu.y, window.innerHeight - 140)

  const item = (label, onClick, danger) => (
    <div
      onClick={() => { onClick(); onClose() }}
      style={{
        padding: '8px 14px', cursor: 'pointer', fontSize: 13,
        color: danger ? 'var(--danger)' : 'var(--text)',
        borderRadius: 6,
      }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--surface2)'}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
    >
      {label}
    </div>
  )

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed', zIndex: 600, left: x, top: y,
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
        padding: '4px', minWidth: 160,
      }}
    >
      {item('✎ Edit transaction…', () => onOpenDetail(menu.txn))}
      {item(ruleActionLabel, () => onOpenRule(menu.txn))}
      <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
      {item(
        menu.txn.notes ? '📝 Edit note' : '📝 Add note',
        () => onEditNote(menu.txn)
      )}
      {menu.txn.notes && item('Remove note', () => onEditNote(menu.txn, true), true)}
    </div>
  )
}

export function MerchantCell({ txn, onOpenDetail, onRename, onUpdateNote }) {
  const [name, setName]         = useState(getTxnMerchantLabel(txn))
  const labelRef = useRef(null)
  const [nameTruncated, setNameTruncated] = useState(false)
  const importedName = getTxnImportedMerchantLabel(txn)
  const renamed = Boolean(txn.display_name && txn.display_name !== importedName)
  const merchantTitle = nameTruncated
    ? (renamed ? `${name}\nOriginally: ${importedName}` : name)
    : (renamed ? `Originally: ${importedName}` : '')

  const {
    editing,
    draft,
    setDraft,
    beginEdit,
    cancelEdit,
    commitEdit,
  } = useTransientTextEdit(name, {
    onCommit: async nextName => {
      setName(nextName)
      await api.updateMerchant(txn.id, nextName)
      onRename?.(txn.id, nextName)
    },
  })

  useEffect(() => {
    if (!editing) setName(getTxnMerchantLabel(txn))
  }, [txn.display_name, txn.merchant_name, txn.raw_name, editing])

  useLayoutEffect(() => {
    if (editing) {
      setNameTruncated(false)
      return undefined
    }
    const element = labelRef.current
    if (!element) return undefined

    function updateTruncation() {
      setNameTruncated(element.scrollWidth > element.clientWidth + 1)
    }

    updateTruncation()

    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(() => updateTruncation())
      observer.observe(element)
      return () => observer.disconnect()
    }

    window.addEventListener('resize', updateTruncation)
    return () => window.removeEventListener('resize', updateTruncation)
  }, [editing, name, onOpenDetail, renamed])

  if (editing) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <TransientTextInput
          value={draft}
          onChange={setDraft}
          onCommit={commitEdit}
          onCancel={cancelEdit}
          restoreOnEscape
          blurOnEscape={false}
          onKeyDown={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
          style={{
            background: 'var(--surface2)', color: 'var(--text)',
            border: '1px solid var(--accent)', borderRadius: 6,
            padding: '2px 7px', fontSize: 13, outline: 'none',
            width: Math.max(120, draft.length * 8 + 16),
          }}
        />
      </div>
    )
  }

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0, maxWidth: '100%' }}>
      <span
        ref={labelRef}
        onClick={e => {
          e.stopPropagation()
          beginEdit(name)
        }}
        style={{
          fontWeight: 500,
          cursor: 'pointer',
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flex: '0 1 auto',
          display: 'inline-block',
          maxWidth: '100%',
        }}
        title={merchantTitle || undefined}
      >
        {name}
      </span>
      {onOpenDetail && (
        <button
          onClick={e => { e.stopPropagation(); onOpenDetail(txn) }}
          title="Open merchant spending report"
          style={{ ...detailButtonStyle, flexShrink: 0 }}
        >↗</button>
      )}
    </div>
  )
}

function NoteGlyph({ size = 13, color = 'currentColor' }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" aria-hidden="true">
      <path
        d="M4 2.5h8a1 1 0 0 1 1 1v9L10.2 10H4a1 1 0 0 1-1-1v-5.5"
        stroke={color}
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
      <path d="M5 6h6M5 8.75h4" stroke={color} strokeWidth="1.15" strokeLinecap="round" />
    </svg>
  )
}

function MarkerButton({ title, onClick, children, active = false }) {
  return (
    <button
      type="button"
      title={title}
      onClick={event => {
        event.stopPropagation()
        onClick?.(event)
      }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 18,
        height: 18,
        borderRadius: 6,
        border: 'none',
        background: active ? 'var(--surface2)' : 'transparent',
        color: active ? 'var(--accent2)' : 'var(--muted)',
        cursor: 'pointer',
        padding: 0,
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  )
}

function TagPickerPopover({ allTags, visibleTagIds, onToggleTag, onClose, loading = false }) {
  const ref = useRef(null)

  useDismissibleLayer({
    open: true,
    onClose,
    refs: [ref],
  })

  return (
    <div
      ref={ref}
      style={{
        position: 'absolute',
        zIndex: 520,
        top: '100%',
        right: 0,
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
        padding: 10,
        minWidth: 220,
        marginTop: 4,
      }}
      onClick={event => event.stopPropagation()}
    >
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 8 }}>
        Transaction tags
      </div>
      {loading ? (
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>Loading tags…</div>
      ) : allTags.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
          No tags yet. Create them in Settings.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 4 }}>
          {allTags.map(tag => {
            const checked = visibleTagIds.has(tag.id)
            return (
              <label
                key={tag.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  cursor: 'pointer',
                  padding: '6px 2px',
                  fontSize: 13,
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggleTag(tag, !checked)}
                />
                <TagGlyph color={tag.color} size={13} />
                <span>{tag.name}</span>
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function TransactionAmountCell({ txn, onUpdateNote, onUpdateTags }) {
  const [showNote, setShowNote] = useState(false)
  const [showTags, setShowTags] = useState(false)
  const [availableTags, setAvailableTags] = useState([])
  const [loadingTags, setLoadingTags] = useState(false)

  const visibleTags = Array.isArray(txn.tags) ? txn.tags : []
  const visibleTagIds = new Set(visibleTags.map(tag => tag.id))

  useEffect(() => {
    if (!showTags || availableTags.length > 0 || loadingTags) return
    let cancelled = false
    setLoadingTags(true)
    api.getTags()
      .then(tags => {
        if (!cancelled) setAvailableTags(tags)
      })
      .finally(() => {
        if (!cancelled) setLoadingTags(false)
      })
    return () => { cancelled = true }
  }, [availableTags.length, loadingTags, showTags])

  async function handleNoteSave(val) {
    await api.updateNotes(txn.id, val)
    onUpdateNote?.(txn.id, val)
  }

  async function handleToggleTag(tag, present) {
    const result = await api.updateTransactionTag(txn.id, tag.id, present)
    onUpdateTags?.(txn.id, result.tags || [])
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, width: '100%', minWidth: 0 }}>
      <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
        <MarkerButton
          title={txn.notes ? 'Edit note' : 'Add note'}
          onClick={() => setShowNote(value => !value)}
          active={!!txn.notes}
        >
          <NoteGlyph size={13} />
        </MarkerButton>
        {visibleTags.map(tag => (
          <MarkerButton
            key={tag.id}
            title={tag.name}
            onClick={() => setShowTags(true)}
          >
            <TagGlyph color={tag.color} size={13} />
          </MarkerButton>
        ))}
        <MarkerButton
          title={visibleTags.length ? 'Edit tags' : 'Add tag'}
          onClick={() => setShowTags(value => !value)}
        >
          <TagGlyph
            color={visibleTags.length ? 'var(--muted)' : 'var(--accent2)'}
            size={13}
            outline={visibleTags.length > 0}
          />
        </MarkerButton>
        {showNote ? (
          <NotePopover
            txn={txn}
            onSave={handleNoteSave}
            onClose={() => setShowNote(false)}
          />
        ) : null}
        {showTags ? (
          <TagPickerPopover
            allTags={availableTags}
            visibleTagIds={visibleTagIds}
            loading={loadingTags}
            onToggleTag={handleToggleTag}
            onClose={() => setShowTags(false)}
          />
        ) : null}
      </div>
      <AmountDisplay
        amount={txn.amount}
        isPending={!!txn.is_pending}
        style={{ display: 'flex', justifyContent: 'flex-end', width: '100%' }}
      />
    </div>
  )
}

export function InlineCategorySelect({ txn, categories, onSave, onSaveNew, onAddCategory, onClose, initialQuery = '' }) {
  const currentCat = categories.find(c => c.id === txn.category_id)
  const [query, setQuery]             = useState(initialQuery || '')
  const [cursor, setCursor]           = useState(0)
  const [showAll, setShowAll]         = useState(false)
  const [openUp, setOpenUp]           = useState(false)
  const [dropVisible, setDropVisible] = useState(false)
  const [showNew, setShowNew]         = useState(false)
  const [newName, setNewName]         = useState('')
  const [newParent, setNewParent]     = useState('')
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [newGroupName, setNewGroupName]   = useState('')
  const [createError, setCreateError] = useState('')
  const inputRef  = useRef(null)
  const listRef   = useRef(null)
  const wrapRef   = useRef(null)

  useEffect(() => {
    setQuery(initialQuery || '')
    inputRef.current?.focus()
  }, [initialQuery])

  useEffect(() => {
    if (!wrapRef.current || !listRef.current) return
    const wrap = wrapRef.current.getBoundingClientRect()
    const list = listRef.current.getBoundingClientRect()
    const spaceBelow = window.innerHeight - wrap.bottom - 8
    const spaceAbove = wrap.top - 8
    if (list.height <= spaceBelow) {
      setDropVisible(true); setOpenUp(false)
    } else if (spaceAbove >= list.height) {
      setDropVisible(true); setOpenUp(true)
    } else if (spaceBelow >= spaceAbove) {
      setDropVisible(true); setOpenUp(false)
    } else {
      setDropVisible(true); setOpenUp(true)
    }
  }, [showAll, query, showNew])

  const leaves   = categories.filter(c => !categories.some(x => x.parent_id === c.id))
  const groups   = buildGroups(categories)
  const topGrps  = categories.filter(c => !c.parent_id)
  const filtered = query.trim() ? leaves.filter(c => c.name.toLowerCase().includes(query.toLowerCase())) : []
  const options  = query.trim() ? filtered : (showAll ? leaves : [])
  const total    = options.length

  useEffect(() => { setCursor(0) }, [query])
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${cursor}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  function pick(cat) { onSave(cat.id) }

  function handleKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(c + 1, total - 1)); return }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setCursor(c => Math.max(c - 1, 0)); return }
    if ((e.key === 'Enter' || e.key === 'Tab') && total > 0) { e.preventDefault(); pick(options[cursor]); return }
    if ((e.key === 'Enter' || e.key === 'Tab') && !query.trim()) { onClose(); return }
  }

  function handleBlur() {
    // Let pointer interactions inside the floating menu win before blur tears the inline editor down.
    setTimeout(() => { if (!wrapRef.current?.contains(document.activeElement)) onClose() }, 150)
  }

  async function handleNewSave() {
    if (!newName.trim()) return
    setCreateError('')
    try {
      const cat = await api.createCategory({ name: newName.trim(), parent_id: newParent || null })
      onAddCategory?.(cat)
      onSaveNew?.(cat)
      onClose?.()
    } catch (error) {
      setCreateError(error?.message || 'Could not create that category')
    }
  }

  function handleParentChange(val) {
    if (val === '__new_group__') {
      setCreatingGroup(true)
      setNewGroupName('')
    } else {
      setNewParent(val)
    }
  }

  async function handleNewGroupSave() {
    if (!newGroupName.trim()) return
    setCreateError('')
    try {
      const grp = await api.createCategory({ name: newGroupName.trim(), parent_id: null })
      onAddCategory?.(grp)
      setNewParent(grp.id)
      setCreatingGroup(false)
      setNewGroupName('')
    } catch (error) {
      setCreateError(error?.message || 'Could not create that group')
    }
  }

  const parentName = cat => categories.find(c => c.id === cat.parent_id)?.name

  const dropStyle = {
    position: 'fixed', zIndex: 1000,
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 8, minWidth: 240, maxHeight: 280,
    overflowY: 'auto', boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
    visibility: dropVisible ? 'visible' : 'hidden',
    top:    openUp ? 'auto' : (wrapRef.current?.getBoundingClientRect().bottom + 4) || 0,
    bottom: openUp ? (window.innerHeight - (wrapRef.current?.getBoundingClientRect().top - 4)) || 0 : 'auto',
    left:   wrapRef.current?.getBoundingClientRect().left || 0,
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-block' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4,
        border: '1px solid var(--accent)', borderRadius: 6,
        background: 'var(--surface2)', padding: '2px 6px',
      }}>
        <input
          ref={inputRef}
          value={query}
          onChange={e => { setDropVisible(false); setOpenUp(false); setQuery(e.target.value); setShowAll(false); setShowNew(false) }}
          onKeyDown={handleKey}
          onBlur={handleBlur}
          placeholder={currentCat?.name || 'Type to search…'}
          style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontSize: 13, width: 140 }}
        />
        <button
          onMouseDown={e => { e.preventDefault(); setDropVisible(false); setOpenUp(false); setShowAll(v => !v); setQuery(''); setShowNew(false) }}
          style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 11, padding: '0 2px', lineHeight: 1 }}
          title="Browse all categories"
        >▾</button>
      </div>

      {(options.length > 0 || showAll || showNew || query.trim().length > 0) && (
        <div ref={listRef} style={dropStyle}>
          {showNew ? (
            <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>New category</div>
              <TransientTextInput value={newName} onChange={value => { if (createError) setCreateError(''); setNewName(value) }}
                onCommit={handleNewSave}
                onCancel={() => { setShowNew(false); setNewName('') }}
                restoreOnEscape
                onBlurCommit={false}
                placeholder="Name"
                style={{ ...getFormControlStyle({ size: 'sm' }), fontSize: 13 }}
              />
              {creatingGroup ? (
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <TransientTextInput
                    value={newGroupName}
                    onChange={value => { if (createError) setCreateError(''); setNewGroupName(value) }}
                    placeholder="New group name"
                    onCommit={handleNewGroupSave}
                    onCancel={() => { setCreatingGroup(false); setNewParent(''); setNewGroupName('') }}
                    restoreOnEscape
                    onBlurCommit={false}
                    style={{ flex: 1, ...getFormControlStyle({ size: 'sm', accent: true }), fontSize: 13 }}
                  />
                  <Button small onMouseDown={e => { e.preventDefault(); handleNewGroupSave() }} disabled={!newGroupName.trim()}>
                    Create
                  </Button>
                  <Button small variant="ghost" onMouseDown={e => { e.preventDefault(); setCreatingGroup(false); setNewParent('') }}>
                    ✕
                  </Button>
                </div>
              ) : (
                <select value={newParent} onChange={e => handleParentChange(e.target.value)}
                  style={{ ...getFormControlStyle({ size: 'sm', clickable: true }), fontSize: 13 }}>
                  <option value="">— Top-level group —</option>
                  {topGrps.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                  <option value="__new_group__">＋ New group…</option>
                </select>
              )}
              {createError ? (
                <div style={{ fontSize: 12, color: 'var(--danger)', lineHeight: 1.3 }}>
                  {createError}
                </div>
              ) : null}
              <div style={{ display: 'flex', gap: 6 }}>
                <Button small onMouseDown={e => { e.preventDefault(); handleNewSave() }} disabled={!newName.trim()} style={{ flex: 1, justifyContent: 'center' }}>
                  Add & assign
                </Button>
                <Button small variant="ghost" onMouseDown={e => { e.preventDefault(); setShowNew(false) }}>
                  Back
                </Button>
              </div>
            </div>
          ) : query.trim() ? (
            <>
              {options.length === 0 ? (
                <div style={{ padding: '10px 12px', fontSize: 13, color: 'var(--muted)' }}>No matches</div>
              ) : options.map((cat, i) => (
                <div key={cat.id} data-idx={i}
                  onMouseDown={e => { e.preventDefault(); pick(cat) }}
                  onMouseEnter={() => setCursor(i)}
                  style={{ padding: '7px 12px', cursor: 'pointer', fontSize: 13, background: i === cursor ? 'var(--surface2)' : 'transparent', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <CategoryMarker kind="category" />
                  <span>{cat.name}</span>
                  {parentName(cat) && <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 'auto' }}>{parentName(cat)}</span>}
                </div>
              ))}
            </>
          ) : (
            groups.map(g => (
              <div key={g.value}>
                <SectionEyebrow style={{ padding: '6px 12px 4px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <CategoryMarker kind="group" />
                  <span>{g.label}</span>
                </SectionEyebrow>
                {g.options.map(o => {
                  const globalIdx = leaves.findIndex(l => l.id === o.value)
                  return (
                    <div key={o.value} data-idx={globalIdx}
                      onMouseDown={e => { e.preventDefault(); pick(leaves.find(l => l.id === o.value)) }}
                      onMouseEnter={() => setCursor(globalIdx)}
                      style={{ padding: '7px 12px 7px 20px', cursor: 'pointer', fontSize: 13, background: globalIdx === cursor ? 'var(--surface2)' : 'transparent', display: 'flex', alignItems: 'center', gap: 8 }}>
                      <CategoryMarker kind="category" />
                      {o.label}
                    </div>
                  )
                })}
              </div>
            ))
          )}
          {!showNew && (
            <div onMouseDown={e => { e.preventDefault(); setShowNew(true); setNewName(query) }}
              style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 13, color: 'var(--accent2)', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>＋</span> New category{query.trim() ? ` "${query}"` : ''}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function CategoryCell({ txn, categories, onSave, onAddCategory, onRulePrompt, onOpenDetail }) {
  const [editId, setEditId] = useState(null)

  function fireRulePrompt(catId, catObj) {
    if (!onRulePrompt) return
    // Manual recategorization is the strongest signal for a useful rule, so pass the triggering merchant text
    // and amount/sign through to the suggestion flow as optional defaults.
    const merchantName = getTxnMerchantLabel(txn)
    const keywordSource = txn.merchant_name || txn.raw_name || merchantName
    if (!keywordSource && !merchantName) return
    const cat = catObj || categories.find(c => c.id === catId)
    if (!cat) return
    onRulePrompt({
      merchantName,
      keywordSource,
      transactionId:  txn.id,
      categoryId:    cat.id,
      categoryName:  cat.name,
      categoryColor: null,
      transactionData: {
        amount: txn.amount,
      },
    })
  }

  function handleSave(catId) {
    setEditId(null)
    onSave(txn.id, catId)
    fireRulePrompt(catId, null)
  }

  function handleSaveNew(cat) {
    setEditId(null)
    onSave(txn.id, cat.id, cat)
    fireRulePrompt(cat.id, cat)
  }

  if (editId === txn.id) {
    return (
      <InlineCategorySelect
        txn={txn}
        categories={categories}
        onSave={handleSave}
        onSaveNew={handleSaveNew}
        onAddCategory={onAddCategory}
        onClose={() => setEditId(null)}
      />
    )
  }

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <div
        onClick={() => setEditId(txn.id)}
        style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}
        title="Click to change category"
      >
        <CategoryDisplay
          id={txn.category_id}
          name={txn.category_name}
        />
      </div>
      {onOpenDetail && txn.category_name && (
        <button
          onClick={e => { e.stopPropagation(); onOpenDetail() }}
          title="View category spending history"
          style={detailButtonStyle}
        >↗</button>
      )}
    </div>
  )
}
