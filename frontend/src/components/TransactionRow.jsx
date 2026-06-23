// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- shared transaction-cell components live alongside their tag/label helpers used across the app */

import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api.js'
import CategoryDisplay from './CategoryDisplay.jsx'
import CategoryPicker from './CategoryPicker.jsx'
import { useDismissibleLayer, useTransientTextEdit } from '../lib/uiInteractions.js'
import TransientTextInput from './TransientTextInput.jsx'
import NoteEditor from './NoteEditor.jsx'
import AmountDisplay from './AmountDisplay.jsx'
import TagPickerWithCreate from './TagPickerWithCreate.jsx'
import { Tooltip } from './ui.jsx'
import { useUnifiedDuplicatesViewer } from '../contexts/UnifiedDuplicatesViewerContext.jsx'

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

export function getTxnMerchantLabel(txn) {
  return txn.display_name || txn.merchant_name || txn.raw_name || '—'
}

function getTxnImportedMerchantLabel(txn) {
  return txn.merchant_name || txn.raw_name || txn.display_name || '—'
}

export function getTxnImportSourceLabel(txn) {
  return txn.import_batch_filename || 'Not imported from file'
}

export function NotePopover({ txn, onSave, onClose, positioning = 'absolute' }) {
  const ref = useRef(null)

  useDismissibleLayer({
    open: true,
    onClose,
    refs: [ref],
  })

  const positionStyle = positioning === 'absolute'
    ? { position: 'absolute', zIndex: 500, top: '100%', left: 0, marginTop: 4 }
    : { position: 'relative' }

  return (
    <div
      ref={ref}
      style={{
        ...positionStyle,
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
        padding: 12, minWidth: 260,
      }}
      onClick={e => e.stopPropagation()}
    >
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 6 }}>
        {txn.notes ? 'Edit note' : 'Add note'}
      </div>
      <NoteEditor
        value={txn.notes}
        autoFocus
        onSave={async next => { await onSave(next); onClose() }}
        onCancel={onClose}
      />
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

export function ContextMenu({ menu, onClose, onOpenDetail, onEditNote, onEditTags, onOpenRule, onTrash, ruleActionLabel = 'Rule…' }) {
  const ref = useRef(null)
  useDismissibleLayer({
    open: !!menu,
    onClose,
    refs: [ref],
  })

  const x = Math.min(menu.x, window.innerWidth - 180)
  const y = Math.min(menu.y, window.innerHeight - 240)

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
      {onEditTags ? item('🏷 Tags…', () => onEditTags(menu.txn)) : null}
      {onTrash ? (
        <>
          <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
          {item('🗑 Send to trash…', () => onTrash(menu.txn), true)}
        </>
      ) : null}
    </div>
  )
}

export function MerchantCell({ txn, onOpenDetail, onRename }) {
  const [name, setName] = useState(getTxnMerchantLabel(txn))
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
    // Listing the three fields getTxnMerchantLabel reads (not txn itself) is deliberate:
    // tag/note edits patch txn too and we don't want them to reset the inline name mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        <Tooltip content="Open merchant spending report">
          <button
            onClick={e => { e.stopPropagation(); onOpenDetail(txn) }}
            aria-label="Open merchant spending report"
            style={{ ...detailButtonStyle, flexShrink: 0 }}
          >↗</button>
        </Tooltip>
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

function PencilGlyph({ size = 13, color = 'currentColor' }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" aria-hidden="true">
      <path
        d="M2.5 13.5l.9-2.8L10 4.1l1.9 1.9-6.6 6.6-2.8.9z"
        stroke={color}
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M9 5l2 2" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
      <path
        d="M10 4.1l1.4-1.4a1 1 0 0 1 1.4 0l.5.5a1 1 0 0 1 0 1.4L11.9 6"
        stroke={color}
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  )
}

const TAG_INLINE_LIMIT = 3
const MAX_TAG_TOOLTIP_WIDTH = 260
const MAX_NOTE_TOOLTIP_WIDTH = 320

const iconButtonStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 18,
  height: 18,
  borderRadius: 6,
  border: 'none',
  background: 'transparent',
  color: 'var(--muted)',
  cursor: 'pointer',
  padding: 0,
  flexShrink: 0,
}

function getTagLetter(tag) {
  const trimmed = (tag?.name || '').trim()
  return (trimmed.charAt(0) || '?').toUpperCase()
}

function TagLetterChip({ tag, inherited, onClick }) {
  const tooltip = inherited
    ? `${tag.name} (inherited from ${tag.source})`
    : tag.name
  return (
    <Tooltip content={tooltip} maxWidth={MAX_TAG_TOOLTIP_WIDTH}>
      <button
        type="button"
        onClick={event => {
          event.stopPropagation()
          onClick?.(event)
        }}
        aria-label={tooltip}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 16,
          height: 16,
          borderRadius: '50%',
          background: tag.color || 'var(--muted)',
          color: '#fff',
          fontSize: 9,
          fontWeight: 700,
          lineHeight: 1,
          border: inherited
            ? '1.5px solid color-mix(in srgb, #0f172a 32%, transparent)'
            : 'none',
          cursor: 'pointer',
          padding: 0,
          flexShrink: 0,
          textShadow: '0 0 1px rgba(0,0,0,0.25)',
        }}
      >
        {getTagLetter(tag)}
      </button>
    </Tooltip>
  )
}

function TagStackChip({ tags, onClick }) {
  const preview = tags.slice(0, 3)
  const tooltip = (
    <div style={{ display: 'grid', gap: 4 }}>
      {tags.map(tag => {
        const inherited = tag.source && tag.source !== 'direct'
        return (
          <div key={tag.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: tag.color || 'var(--muted)',
                flexShrink: 0,
              }}
            />
            <span>{tag.name}{inherited ? <span style={{ color: 'var(--muted)' }}> (from {tag.source})</span> : null}</span>
          </div>
        )
      })}
    </div>
  )
  return (
    <Tooltip content={tooltip} maxWidth={MAX_TAG_TOOLTIP_WIDTH}>
      <button
        type="button"
        onClick={event => {
          event.stopPropagation()
          onClick?.(event)
        }}
        aria-label={`${tags.length} tags`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          height: 16,
          padding: '0 3px 0 0',
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        {preview.map((tag, idx) => (
          <span
            key={tag.id}
            style={{
              width: 12,
              height: 12,
              borderRadius: '50%',
              background: tag.color || 'var(--muted)',
              border: '1.5px solid var(--surface)',
              marginLeft: idx === 0 ? 0 : -5,
              boxShadow: '0 0 0 0.5px color-mix(in srgb, #0f172a 18%, transparent)',
            }}
          />
        ))}
        <span
          style={{
            marginLeft: 4,
            fontSize: 10,
            fontWeight: 600,
            color: 'var(--muted)',
            lineHeight: 1,
          }}
        >
          {tags.length}
        </span>
      </button>
    </Tooltip>
  )
}

export function TransactionAmountCell({ txn, onUpdateNote, onUpdateTags, onOpenDetail }) {
  const navigate = useNavigate()
  const unifiedDuplicatesViewer = useUnifiedDuplicatesViewer()
  const [showNote, setShowNote] = useState(false)
  const [showTags, setShowTags] = useState(false)
  // null sentinel = not fetched yet; an array (possibly empty) = fetched.
  // Tracking via state alone (no separate loading flag) avoids a cancel-loop where
  // the effect re-runs on every loading-state flip and aborts its own in-flight fetch.
  const [availableTags, setAvailableTags] = useState(null)

  const visibleTags = Array.isArray(txn.tags) ? txn.tags : []
  const visibleTagIds = new Set(visibleTags.map(tag => tag.id))
  // Tags inherited from the transaction's category or group cannot be removed at the
  // transaction level — they live on the category itself. The picker shows them as
  // checked but disabled so the user understands why they cannot be un-ticked here.
  const inheritedTagIds = new Set(
    visibleTags.filter(tag => tag.source && tag.source !== 'direct').map(tag => tag.id),
  )

  useEffect(() => {
    if (!showTags || availableTags !== null) return
    let cancelled = false
    api.getTags()
      .then(tags => { if (!cancelled) setAvailableTags(Array.isArray(tags) ? tags : []) })
      .catch(() => { if (!cancelled) setAvailableTags([]) })
    return () => { cancelled = true }
  }, [showTags, availableTags])

  async function handleNoteSave(val) {
    await api.updateNotes(txn.id, val)
    onUpdateNote?.(txn.id, val)
  }

  async function handleToggleTag(tag, present) {
    const result = await api.updateTransactionTag(txn.id, tag.id, present)
    onUpdateTags?.(txn.id, result.tags || [])
  }

  const useStack = visibleTags.length > TAG_INLINE_LIMIT
  const hasNote = !!txn.notes

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, width: '100%', minWidth: 0 }}>
      <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
        {txn.suspect_duplicate_of ? (
          <Tooltip
            content={<span>Possible duplicate of another transaction. Click to review.</span>}
            maxWidth={MAX_TAG_TOOLTIP_WIDTH}
          >
            <button
              type="button"
              onClick={event => {
                event.stopPropagation()
                // Open the unified per-batch report scoped to this transaction's import batch.
                // Soft-flagged rows always carry an import_batch_id (the flagging happens at
                // import time); the navigate() fallback covers the impossible case so the
                // click does something rather than silently nothing.
                if (txn.import_batch_id) {
                  unifiedDuplicatesViewer.open({
                    batchId: txn.import_batch_id,
                    title: txn.import_batch_filename || 'Possible duplicates',
                  })
                } else {
                  navigate('/import-export')
                }
              }}
              aria-label="Possible duplicate — review"
              style={{
                ...iconButtonStyle,
                color: 'var(--warning)',
                fontSize: 13,
                fontWeight: 700,
              }}
            >
              ⚠
            </button>
          </Tooltip>
        ) : null}
        {hasNote ? (
          <Tooltip
            content={<span style={{ whiteSpace: 'pre-wrap' }}>{txn.notes}</span>}
            maxWidth={MAX_NOTE_TOOLTIP_WIDTH}
          >
            <button
              type="button"
              onClick={event => {
                event.stopPropagation()
                setShowNote(value => !value)
              }}
              aria-label="Edit note"
              style={{ ...iconButtonStyle, color: 'var(--accent2)' }}
            >
              <NoteGlyph size={13} />
            </button>
          </Tooltip>
        ) : null}
        {useStack ? (
          <TagStackChip tags={visibleTags} onClick={() => setShowTags(true)} />
        ) : (
          visibleTags.map(tag => (
            <TagLetterChip
              key={tag.id}
              tag={tag}
              inherited={tag.source && tag.source !== 'direct'}
              onClick={() => setShowTags(true)}
            />
          ))
        )}
        {showNote ? (
          <NotePopover
            txn={txn}
            onSave={handleNoteSave}
            onClose={() => setShowNote(false)}
          />
        ) : null}
        {showTags ? (
          <TagPickerWithCreate
            allTags={availableTags || []}
            selectedTagIds={visibleTagIds}
            inheritedTagIds={inheritedTagIds}
            loading={availableTags === null}
            onToggleTag={handleToggleTag}
            onTagCreated={tag => setAvailableTags(prev => (prev || []).some(t => t.id === tag.id) ? prev : [...(prev || []), tag])}
            onClose={() => setShowTags(false)}
          />
        ) : null}
      </div>
      <AmountDisplay
        amount={txn.amount}
        isPending={!!txn.is_pending}
        style={{ display: 'flex', justifyContent: 'flex-end' }}
      />
      {onOpenDetail ? (
        <Tooltip content="Edit transaction…">
          <button
            type="button"
            onClick={event => {
              event.stopPropagation()
              onOpenDetail(txn)
            }}
            aria-label="Edit transaction"
            style={{ ...iconButtonStyle, color: 'var(--muted)', marginLeft: 2 }}
          >
            <PencilGlyph size={13} />
          </button>
        </Tooltip>
      ) : null}
    </div>
  )
}

export function CategoryCell({ txn, categories, onSave, onAddCategory, onRulePrompt, onOpenDetail }) {
  const [editing, setEditing] = useState(false)
  // A category created from inside the picker is assigned in the same tick it's added, before the parent's
  // `categories` prop reflects it — capture it here so the save + rule prompt resolve the real object
  // instead of a stale lookup that would miss it.
  const createdRef = useRef(null)
  // The picker reports an open=false during mount before it auto-opens (its initial-state guard fires twice
  // under StrictMode); only treat a close as a real dismissal once we've seen it genuinely open, or that
  // spurious report would bounce us straight back out of edit mode.
  const hasOpenedRef = useRef(false)
  // Persistence flows through onSave; without it the cell is display-only (e.g. the Rules preview list).
  const editable = Boolean(onSave)

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
      transactionId: txn.id,
      // Category the row carried before this save (null when it was uncategorized). Consumers can
      // gate the suggestion on it — e.g. only prompt when an unassigned transaction is first
      // categorized, not when an existing assignment is changed.
      previousCategoryId: txn.category_id ?? null,
      categoryId: cat.id,
      categoryName: cat.name,
      categoryColor: null,
      transactionData: {
        amount: txn.amount,
      },
    })
  }

  // Picking an existing category and creating-then-assigning a new one both arrive here through the
  // picker's onChange; createdRef lets the new-category case carry the real object to the save + rule prompt.
  function handlePick(catId) {
    // catId === null is the picker's "Uncategorized" clear; persist it but never fire a rule prompt
    // (there's no category to learn a rule from).
    const created = catId != null && createdRef.current?.id === catId ? createdRef.current : null
    createdRef.current = null
    setEditing(false)
    onSave(txn.id, catId ?? null, created || undefined)
    if (catId != null) fireRulePrompt(catId, created)
  }

  if (editing) {
    return (
      <CategoryPicker
        value={txn.category_id ?? null}
        categories={categories}
        compact
        showSelectedBadge
        clearable
        openToken={1}
        onChange={handlePick}
        onAddCategory={onAddCategory}
        onCategoryCreated={created => { createdRef.current = created }}
        onOpenChange={open => {
          if (open) { hasOpenedRef.current = true; return }
          if (!hasOpenedRef.current) return
          createdRef.current = null
          setEditing(false)
        }}
      />
    )
  }

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <div
        onClick={editable ? () => { hasOpenedRef.current = false; createdRef.current = null; setEditing(true) } : undefined}
        style={{ cursor: editable ? 'pointer' : 'default', display: 'inline-flex', alignItems: 'center', gap: 4 }}
        title={editable ? 'Click to change category' : undefined}
      >
        <CategoryDisplay
          id={txn.category_id}
          name={txn.category_name}
        />
      </div>
      {onOpenDetail && txn.category_name && (
        <Tooltip content="View category spending history">
          <button
            onClick={e => { e.stopPropagation(); onOpenDetail() }}
            aria-label="View category spending history"
            style={detailButtonStyle}
          >↗</button>
        </Tooltip>
      )}
    </div>
  )
}
