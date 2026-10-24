// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- shared transaction-cell components live alongside their tag/label helpers used across the app */

import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api.js'
import { txnMutations } from '../lib/txnMutations.js'
import CategoryDisplay from './CategoryDisplay.jsx'
import CategoryPicker from './CategoryPicker.jsx'
import { useDismissibleLayer, useTransientTextEdit } from '../lib/uiInteractions.js'
import TransientTextInput from './TransientTextInput.jsx'
import NoteEditor from './NoteEditor.jsx'
import DocumentViewerDialog from './DocumentViewerDialog.jsx'
import PurchaseEditorDialog from './PurchaseEditorDialog.jsx'
import ReimbursementEditorDialog from './ReimbursementEditorDialog.jsx'
import AmountDisplay from './AmountDisplay.jsx'
import TagPickerWithCreate from './TagPickerWithCreate.jsx'
import { Tooltip, ROW_HOVER_OPEN_DELAY_MS, getFloatingPanelSurfaceStyle } from './ui.jsx'
import { MerchantOriginHoverCard } from './OriginFields.jsx'
import { getTxnSourceType, hasFileOriginDetail } from '../lib/importSourceFields.js'
import { formatSignedMoneyAmount, getTransactionAmountColor, transactionDirection } from '../lib/moneyDisplay.js'
import { purchaseMarkerTooltip, purchaseRowSummary } from '../lib/purchaseLinks.js'
import { refundLinkTooltip } from '../lib/refundLinks.js'
import { amazonOrderLinkTooltip } from '../lib/amazonOrderLinks.js'
import { reimbursementMarkerTooltip, reimbursementStatus } from '../lib/reimbursements.js'
import { isSplitPartRow, splitPartLabel, splitPartSummary } from '../lib/splitRows.js'
import { useUnifiedDuplicatesViewer } from '../contexts/UnifiedDuplicatesViewerContext.jsx'

/*
 * These cells centralize transaction editing semantics across every table in the app. Parents keep the row data;
 * the cells keep transient edit state local and report only committed changes back so each surface can stay
 * optimistic without forking the interaction rules for merchant rename, notes, or recategorization.
 */

// Every tooltip in a transaction row goes through this so it inherits the scroll-list dwell: these rows
// live in windowed/scrolling lists where a resting cursor would otherwise strobe a hint at each row that
// scrolls past. A caller can still override `openDelay` if it needs to. See ui-patterns.md.
function RowTooltip({ openDelay = ROW_HOVER_OPEN_DELAY_MS, ...props }) {
  return <Tooltip openDelay={openDelay} {...props} />
}

// The category cell on one expanded allocation of a split: the badge and the ◧ beside it are a single
// control, since both lead to the same editor. Reset to nothing visible so the badge reads exactly as it
// does on an ordinary row — the button contributes the hit area and the cursor, not chrome of its own.
const splitPartControlStyle = {
  background: 'none',
  border: 'none',
  padding: 0,
  font: 'inherit',
  color: 'inherit',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  cursor: 'pointer',
}

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

// The name a row goes by, or '' when it has none — a wallet's funding deposit or withdrawal has no
// counterparty to name. Editors start from this rather than from the label, so a nameless row opens its
// rename field empty instead of pre-filled with a placeholder.
export function getTxnName(txn) {
  return txn.display_name || txn.merchant_name || txn.raw_name || ''
}

export function getTxnMerchantLabel(txn) {
  return getTxnName(txn) || '—'
}

// What a nameless row shows where the name would be: the kind of transaction its source recorded,
// muted so it does not read as a counterparty, or "—" where the source recorded nothing. Display only —
// never written as the name, since namelessness is what marks a funding leg (services/money_movement.py).
export function NamelessMerchant({ txn }) {
  const sourceType = getTxnSourceType(txn)
  if (!sourceType) return '—'
  return <span style={{ color: 'var(--muted)', fontStyle: 'italic', fontWeight: 400 }}>{sourceType}</span>
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

export function useContextMenu() {
  const [menu, setMenu] = useState(null)

  function onContextMenu(e, txn) {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, txn })
  }

  function close() { setMenu(null) }

  return { menu, onContextMenu, close }
}

export function ContextMenu({ menu, onClose, onOpenDetail, onEditNote, onEditTags, onOpenRule, onOpenSplit, onMarkRecurring, onRemoveFromRecurring, onRestoreRecurring, onMarkReviewed, onTrash, ruleActionLabel = 'Rule…' }) {
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
        padding: '5px 14px', cursor: 'pointer', fontSize: 13,
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
      {/* Named for what the row ends up as, not for the mechanism: an ordinary row is being divided,
          a split one is being adjusted. Sits with the rule item because both are categorization. */}
      {onOpenSplit ? item(
        menu.txn.is_split ? '◧ Edit split…' : '◧ Split…',
        () => onOpenSplit(menu.txn),
      ) : null}
      {/* Recurring: a member edits/views its series; a row the user previously removed offers a targeted
          restore back into that same series; otherwise "Mark as recurring…" (which starts a new one). */}
      {onRestoreRecurring && !menu.txn.recurring_series_id && menu.txn.recurring_excluded_series_id
        ? item('↻ Restore to recurring series', () => onRestoreRecurring(menu.txn))
        : (onMarkRecurring ? item(
          menu.txn.recurring_series_id
            ? (menu.txn.recurring_rule_id ? '↻ Edit recurring rule…' : '↻ View recurring series')
            : '↻ Mark as recurring…',
          () => onMarkRecurring(menu.txn),
        ) : null)}
      {onRemoveFromRecurring && menu.txn.recurring_series_id
        ? item('↻ Remove from recurring series', () => onRemoveFromRecurring(menu.txn))
        : null}
      <div style={{ height: 1, background: 'var(--border)', margin: '3px 0' }} />
      {item(
        menu.txn.notes ? '📝 Edit note' : '📝 Add note',
        () => onEditNote(menu.txn)
      )}
      {menu.txn.notes && item('Remove note', () => onEditNote(menu.txn, true), true)}
      {onEditTags ? item('🏷 Tags…', () => onEditTags(menu.txn)) : null}
      {onMarkReviewed && menu.txn.needs_review ? item('✓ Mark reviewed', () => onMarkReviewed(menu.txn)) : null}
      {onTrash ? (
        <>
          <div style={{ height: 1, background: 'var(--border)', margin: '3px 0' }} />
          {item('🗑 Send to trash…', () => onTrash(menu.txn), true)}
        </>
      ) : null}
    </div>
  )
}

export function MerchantCell({ txn, onOpenDetail, onRename, showReport = true }) {
  const [name, setName] = useState(getTxnName(txn))
  const labelRef = useRef(null)
  const [nameTruncated, setNameTruncated] = useState(false)
  const importedName = getTxnImportedMerchantLabel(txn)
  const renamed = Boolean(txn.display_name && txn.display_name !== importedName)
  const matchedHiddenText = !!txn.matched_hidden_text

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
    if (!editing) setName(getTxnName(txn))
    // Listing the three fields getTxnName reads (not txn itself) is deliberate:
    // tag/note edits patch txn too and we don't want them to reset the inline name mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txn.display_name, txn.merchant_name, txn.raw_name, editing])

  // Detect whether the merchant name is ellipsized (drives whether the origin-hover tooltip is
  // attached). This runs once per row in a *post-paint* effect rather than useLayoutEffect, and
  // deliberately does NOT install a per-row ResizeObserver: in a long ledger that was thousands of
  // observers each firing an initial + per-layout-change callback — a measured perf hotspot (forced
  // reflow storm). As a plain read-only effect with no DOM writes between rows, the browser serves
  // every row's measurement from one layout flush instead of one per row mid-commit. The trade-off is
  // truncation no longer auto-updates on a column/viewport resize; remeasureTruncation() on hover
  // (below) restores correctness exactly when the tooltip would be shown.
  function remeasureTruncation() {
    const element = labelRef.current
    if (element && !editing) setNameTruncated(element.scrollWidth > element.clientWidth + 1)
  }
  useEffect(() => {
    if (editing) {
      setNameTruncated(false)
      return
    }
    remeasureTruncation()
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const labelSpan = (
    <span
      ref={labelRef}
      onMouseEnter={remeasureTruncation}
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
        // Found by the search through text this name does not show (the bank's raw wording, a memo
        // column). The underline says there is more behind the name; the hover below shows what matched.
        // Such a row always has that text to show, so the hover is attached whenever this is set.
        ...(matchedHiddenText ? { textDecoration: 'underline dotted var(--accent)', textUnderlineOffset: 3 } : null),
      }}
    >
      {name || <NamelessMerchant txn={txn} />}
    </span>
  )
  // Hover the merchant name to reveal the captured import-source detail (full name when truncated,
  // raw source text, "Original Statement"-style extras, the source file, the file's imported category
  // and source account). Only attach the hover when there is something to show beyond the visible name.
  // See lib/importSourceFields.js.
  const showOriginHover = nameTruncated || hasFileOriginDetail(txn)
  // On one part of a split (a category-scoped list), what that part covers — the row's name is the whole
  // purchase's, so without this every part of it reads alike.
  const partLabel = splitPartLabel(txn)

  const nameRow = (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0, maxWidth: '100%' }}>
      {showOriginHover ? (
        <RowTooltip
          // Copyable here because this card is showing a real ledger row — the affordance says out
          // loud what the card could always do, rather than leaving Ctrl+C to be guessed at.
          content={<MerchantOriginHoverCard txn={txn} copyable />}
          maxWidth={380}
          // Interactive so the card's links (e.g. Amazon "View on Amazon") are reachable and clickable:
          // pointer-events stay on, and a short close grace keeps the card open while the pointer crosses
          // into it. See Tooltip's `interactive` in ui.jsx.
          interactive
          triggerStyle={{ minWidth: 0, flex: '0 1 auto', maxWidth: '100%' }}
        >
          {labelSpan}
        </RowTooltip>
      ) : labelSpan}
      {onOpenDetail && showReport && (
        <RowTooltip content="Open merchant spending report">
          <button
            // The merchant report and the transaction editor share one panel (TransactionDetail). The
            // `↗` wants the merchant *report* (activity only), so it tags the open payload; the panel
            // reads the marker and drops its single-transaction editor card. The pencil opens the same
            // panel unmarked (full editor). Rides the open payload like the duplicate report's
            // `batch._dateFilter`, so no host needs to plumb an extra prop. `showReport` is off where the
            // arrow would be self-referential (a list already scoped to one merchant).
            onClick={e => { e.stopPropagation(); onOpenDetail({ ...txn, _merchantReport: true }) }}
            aria-label="Open merchant spending report"
            style={{ ...detailButtonStyle, flexShrink: 0 }}
          >↗</button>
        </RowTooltip>
      )}
    </div>
  )
  if (!partLabel) return nameRow
  return (
    <div style={{ display: 'grid', minWidth: 0, maxWidth: '100%' }}>
      {nameRow}
      <span
        title={partLabel}
        style={{ fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >{partLabel}</span>
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

// A page with its bottom corner curled, for attached documents. Drawn rather than an emoji: 📎 read as the
// purchase marker's 🔗 at row size, and a colour emoji ignores `color`, which the search-match emphasis
// relies on. Portrait and tailless so it does not read as the note glyph beside it.
function DocumentGlyph({ size = 13, color = 'currentColor' }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" aria-hidden="true">
      <path
        d="M12.5 10V2.5a1 1 0 0 0-1-1H4.5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1H8.5"
        stroke={color}
        strokeWidth="1.25"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <path
        d="M8.5 14.5C10.9 14.5 12.5 12.6 12.5 10C11.7 11.3 10.4 11.9 9 11.6C9 12.7 8.8 13.7 8.5 14.5z"
        stroke={color}
        strokeWidth="1.15"
        strokeLinejoin="round"
      />
      <path d="M5.5 4.75h5M5.5 7.25h5M5.5 9.75h2" stroke={color} strokeWidth="1.15" strokeLinecap="round" />
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
    <RowTooltip content={tooltip} maxWidth={MAX_TAG_TOOLTIP_WIDTH}>
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
    </RowTooltip>
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
    <RowTooltip content={tooltip} maxWidth={MAX_TAG_TOOLTIP_WIDTH}>
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
    </RowTooltip>
  )
}

// The inline note/tag popovers anchor to a cell inside a transaction row, but the rows carry
// `content-visibility: auto` (paint containment) which makes each row its own stacking context —
// so an absolutely-positioned popover is trapped behind the rows that follow it. Portaling the
// popover to <body> and positioning it `fixed` against the anchor's live rect escapes that trap
// (the same approach CategoryPicker uses). Right-aligned to the anchor (the marker strip); flips
// above the anchor when there isn't room below.
// The chooser the document marker opens when a transaction carries more than one document — an estimate and
// then a final invoice, or a two-page bill scanned as two images. Names only: what a document *is* is
// the viewer's job, and this exists purely to answer "which one".
function DocumentListPopover({ documents, onOpen, onClose }) {
  const ref = useRef(null)
  useDismissibleLayer({ ref, onDismiss: onClose })

  return (
    <div
      ref={ref}
      style={{
        ...getFloatingPanelSurfaceStyle(),
        minWidth: 220, maxWidth: 340, padding: 6, display: 'grid', gap: 2,
      }}
    >
      {documents.map(doc => (
        <button
          key={doc.id}
          type="button"
          onClick={() => onOpen(doc)}
          title={doc.filename}
          style={{
            textAlign: 'left', background: 'none', border: 'none', borderRadius: 4,
            padding: '5px 7px', fontSize: 13, color: 'var(--text)', cursor: 'pointer',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
        >
          {doc.filename}
        </button>
      ))}
    </div>
  )
}


function RowPopoverPortal({ anchorRef, children }) {
  const [layout, setLayout] = useState(null)

  useLayoutEffect(() => {
    const element = anchorRef.current
    if (!element) return undefined

    function update() {
      const rect = element.getBoundingClientRect()
      const gap = 4
      const spaceBelow = window.innerHeight - rect.bottom
      const openUp = spaceBelow < 300 && rect.top > spaceBelow
      setLayout({
        right: Math.max(8, window.innerWidth - rect.right),
        ...(openUp
          ? { bottom: Math.max(8, window.innerHeight - rect.top + gap) }
          : { top: rect.bottom + gap }),
        maxHeight: Math.max(160, (openUp ? rect.top : spaceBelow) - 12),
      })
    }

    update()
    // Capture-phase scroll catches the inner detail-panel/list scroll container, not just the window,
    // so the popover tracks the row as the list scrolls.
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [anchorRef])

  if (!layout) return null
  return createPortal(
    <div style={{ position: 'fixed', zIndex: 1000, overflowY: 'auto', ...layout }}>
      {children}
    </div>,
    document.body,
  )
}

export function TransactionMarkersCell({ txn, onUpdateNote, onUpdateTags, onUpdatePurchase, onUpdateReimbursements, onUpdateDocuments, onMarkReviewed, onOpenDetail, showExcludedFromTotals = false }) {
  const navigate = useNavigate()
  const unifiedDuplicatesViewer = useUnifiedDuplicatesViewer()
  const markerStripRef = useRef(null)
  const [showNote, setShowNote] = useState(false)
  const [showTags, setShowTags] = useState(false)
  const [showDocuments, setShowDocuments] = useState(false)
  const [viewingDocument, setViewingDocument] = useState(null)
  const [editingPurchase, setEditingPurchase] = useState(false)
  // The pairings this row is one side of — a refund and its payment, an Amazon order and the card charge
  // that paid it — each with what the hover says and the transaction on the other side.
  const pairings = [
    [txn.refund_link, refundLinkTooltip],
    [txn.amazon_order, amazonOrderLinkTooltip],
  ]
    .filter(([link]) => link?.others?.length)
    .map(([link, describe]) => ({ label: describe(link), otherId: link.others[0].id }))
  // A purchase always opens (its editor lives here); a pairing opens the other transaction only where the
  // host can show one.
  const linkMarkerOpens = Boolean(txn.purchase) || (pairings.length > 0 && Boolean(onOpenDetail))
  // The row carries only enough of the other side to name it, so the whole transaction is fetched to open
  // it — the detail panel needs a real row, as it does from every other way in.
  async function openLinkedTransaction(otherId) {
    const resp = await api.getTransactions({ ids: otherId, limit: 1 })
    const other = resp?.transactions?.[0]
    if (other) onOpenDetail?.(other)
  }
  // Which reimbursement's editor is open, by link id — a row may have a share in several, so a boolean
  // could not say which one the click was about.
  const [editingReimbursement, setEditingReimbursement] = useState(null)
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
  // Tags the user hid on just this transaction (inherited/rule opt-out). Passing the set — even when
  // empty — puts the picker in transaction mode, where inherited tags can be unchecked to hide them.
  const blockedTagIds = new Set((Array.isArray(txn.blocked_tags) ? txn.blocked_tags : []).map(tag => tag.id))

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
    const result = await txnMutations.setTag(txn.id, tag.id, present)
    onUpdateTags?.(txn.id, result.tags || [], result.blocked_tags || [])
  }

  const useStack = visibleTags.length > TAG_INLINE_LIMIT
  const hasNote = !!txn.notes
  const documentCount = txn.document_count || 0
  const matchedDocument = !!txn.matched_document
  const documents = Array.isArray(txn.documents) ? txn.documents : []
  // Surfaces that pair this list with a total which omits excluded-from-totals rows (the account
  // activity panel) opt in via showExcludedFromTotals; the row then carries a quiet ⊘ marker (and its
  // amount is dimmed over in TransactionAmountCell) so the gap between the visible rows and the total
  // reads as intentional.
  const excludedFromTotals = showExcludedFromTotals && !!txn.excluded_from_totals

  return (
    <div style={{ display: 'flex', alignItems: 'center', minWidth: 0, maxWidth: '100%' }}>
      {/* The markers live in their own column now, so the strip no longer needs the opaque background
        that used to let it overflow leftward and paint over the neighbouring column — it simply lays
        out left-to-right within its own cell. `position: relative` anchors the note/tag popovers. */}
      <div ref={markerStripRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
        {txn.needs_review ? (
          <RowTooltip
            content={<span>Needs review — recently imported and not yet looked over. {onMarkReviewed
              ? 'Click to mark it reviewed.'
              : 'Clears when you edit its category or mark it reviewed.'}</span>}
            maxWidth={MAX_TAG_TOOLTIP_WIDTH}
          >
            {onMarkReviewed ? (
              // Clicking marks the row reviewed, through the same action as the row menu (which also
              // raises the undo toast). Only offered where the host wires the row actions; elsewhere the
              // marker stays informational. The row stays where it is — see ui-patterns.md → Transaction lists.
              <button
                type="button"
                aria-label="Needs review — mark reviewed"
                onClick={event => { event.stopPropagation(); onMarkReviewed(txn) }}
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  minWidth: 18, minHeight: 18, padding: '0 2px', margin: '-2px 0',
                  background: 'none', border: 'none', borderRadius: 4, cursor: 'pointer',
                  color: 'var(--review-marker-color)', fontSize: 13, fontWeight: 700, lineHeight: 1,
                }}
              >
                R
              </button>
            ) : (
              <span
                aria-label="Needs review"
                style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--review-marker-color)', fontSize: 13, fontWeight: 700, cursor: 'default' }}
              >
                R
              </span>
            )}
          </RowTooltip>
        ) : null}
        {txn.recurring_series_id ? (
          <RowTooltip
            content={<span>Part of a recurring series.</span>}
            maxWidth={MAX_TAG_TOOLTIP_WIDTH}
          >
            <span
              aria-label="Part of a recurring series"
              style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--accent2)', fontSize: 13, cursor: 'default' }}
            >
              ↻
            </span>
          </RowTooltip>
        ) : null}
        {txn.purchase || pairings.length ? (
          /* The row belongs with other transactions: one payment of a multi-payment purchase — a
             deposit and a balance, an instalment plan — or one side of a refund and the payment it
             returns, or an Amazon order and the card charge that paid it. One glyph for all of them
             rather than a marker each, since the strip is already crowded and they say the same thing:
             this row has partners. It opens what it stands for, like every
             other interactive marker here (this repo has twice reversed a marker left inert on the
             reasoning that another route already existed): a purchase opens its editor — the same
             dialog the detail panel's purchase summary opens, so a mis-linked payment is repaired from
             wherever it was noticed — and a pairing, which has nothing to edit, opens the
             transaction on the other side. A row that is both opens the purchase, the one that can be
             edited; its hover names both. */
          <RowTooltip
            content={(
              <span>
                {[txn.purchase ? purchaseMarkerTooltip(txn.purchase) : null, ...pairings.map(pairing => pairing.label)]
                  .filter(Boolean)
                  .map(line => <span key={line} style={{ display: 'block' }}>{line}</span>)}
                {linkMarkerOpens ? <span style={{ display: 'block' }}>Click to open</span> : null}
              </span>
            )}
            maxWidth={MAX_TAG_TOOLTIP_WIDTH}
          >
            {linkMarkerOpens ? (
              <button
                type="button"
                onClick={event => {
                  event.stopPropagation()
                  if (txn.purchase) setEditingPurchase(true)
                  else openLinkedTransaction(pairings[0].otherId)
                }}
                aria-label={txn.purchase
                  ? `${purchaseMarkerTooltip(txn.purchase)} — open this purchase`
                  : `${pairings[0].label} — open it`}
                style={{ ...iconButtonStyle, fontSize: 11 }}
              >
                🔗
              </button>
            ) : (
              <span aria-label={pairings.map(pairing => pairing.label).join('; ')} style={{ ...iconButtonStyle, fontSize: 11, cursor: 'default' }}>🔗</span>
            )}
          </RowTooltip>
        ) : null}
        {(txn.reimbursements || []).length ? (
          /* Money owed back against this row. It opens the reimbursement, like every other interactive
             marker in this strip opens what it stands for — and it is the answer to "I have to go find
             this in the transaction editor" for a row noticed anywhere in the ledger.

             One marker per reimbursement rather than one for the row: a charge split between two people
             is two debts, and a single marker would have to pick one of them to open. */
          (txn.reimbursements || []).map(reimbursement => (
            <RowTooltip
              key={reimbursement.id}
              content={<span>{reimbursementMarkerTooltip(reimbursement)} — click to open</span>}
              maxWidth={MAX_TAG_TOOLTIP_WIDTH}
            >
              <button
                type="button"
                onClick={event => {
                  event.stopPropagation()
                  setEditingReimbursement(reimbursement.id)
                }}
                aria-label={`${reimbursementMarkerTooltip(reimbursement)} — open this reimbursement`}
                style={{
                  ...iconButtonStyle,
                  fontSize: 11,
                  // A finished one is still worth marking — it explains why the money is where it is —
                  // but it is not work, so it recedes rather than competing with the open ones.
                  opacity: reimbursementStatus(reimbursement) === 'completed' ? 0.45 : 1,
                }}
              >
                ↩
              </button>
            </RowTooltip>
          ))
        ) : null}
        {txn.suspect_duplicate_of ? (
          <RowTooltip
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
                  navigate('/import-export?tab=history')
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
          </RowTooltip>
        ) : null}
        {hasNote ? (
          <RowTooltip
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
          </RowTooltip>
        ) : null}
        {documentCount > 0 ? (
          <RowTooltip
            content={
              <span>
                {documentCount === 1 ? '1 attached document' : `${documentCount} attached documents`}
                {matchedDocument ? ' — this row matched your search inside one of them' : ''}
                {documentCount === 1 ? ' — click to open' : ' — click to choose one'}
              </span>
            }
          >
            {/* Opens the document, like every other marker in this strip opens what it stands for —
                the note glyph and the tag chips both do, so an inert document marker reads as broken rather
                than as restraint. *Attaching* still belongs to the detail panel, which has room for it.
                When the search matched *inside* a document, this marker is the row's only explanation
                for being here at all — every field on screen lacks the term — so it is emphasized
                rather than quiet, and it is also the fastest route to the thing that matched. */}
            <button
              type="button"
              onClick={event => {
                event.stopPropagation()
                // One document has nothing to choose between, so it opens straight away; several get
                // the popover the note and tag markers beside this one already use.
                if (documents.length === 1) setViewingDocument(documents[0])
                else setShowDocuments(value => !value)
              }}
              aria-label={
                matchedDocument
                  ? 'Matched inside an attached document — open it'
                  : (documentCount === 1 ? 'Open the attached document' : `Open ${documentCount} attached documents`)
              }
              style={{
                ...iconButtonStyle,
                width: documentCount > 1 ? 'auto' : iconButtonStyle.width,
                minWidth: iconButtonStyle.width,
                gap: 1,
                fontSize: 11,
                color: matchedDocument ? 'var(--accent)' : 'var(--muted)',
                fontWeight: matchedDocument ? 700 : undefined,
              }}
            >
              <DocumentGlyph size={13} />{documentCount > 1 ? documentCount : ''}
            </button>
          </RowTooltip>
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
          <RowPopoverPortal anchorRef={markerStripRef}>
            <NotePopover
              txn={txn}
              positioning="relative"
              onSave={handleNoteSave}
              onClose={() => setShowNote(false)}
            />
          </RowPopoverPortal>
        ) : null}
        {showTags ? (
          <RowPopoverPortal anchorRef={markerStripRef}>
            <TagPickerWithCreate
              allTags={availableTags || []}
              selectedTagIds={visibleTagIds}
              inheritedTagIds={inheritedTagIds}
              blockedTagIds={blockedTagIds}
              loading={availableTags === null}
              positioning="relative"
              onToggleTag={handleToggleTag}
              onTagCreated={tag => setAvailableTags(prev => (prev || []).some(t => t.id === tag.id) ? prev : [...(prev || []), tag])}
              onClose={() => setShowTags(false)}
            />
          </RowPopoverPortal>
        ) : null}
        {showDocuments ? (
          <RowPopoverPortal anchorRef={markerStripRef}>
            <DocumentListPopover
              documents={documents}
              onOpen={doc => { setShowDocuments(false); setViewingDocument(doc) }}
              onClose={() => setShowDocuments(false)}
            />
          </RowPopoverPortal>
        ) : null}
        {viewingDocument ? (
          <DocumentViewerDialog
            document={viewingDocument}
            onClose={() => setViewingDocument(null)}
            // An edit replaces the document under a new id, and this row opens documents from its own
            // copy, so the id is swapped there too — otherwise the next click opens a document that is gone.
            onDocumentReplaced={(previousId, replacement) => {
              setViewingDocument(replacement)
              onUpdateDocuments?.(txn.id, documents.map(doc => (doc.id === previousId
                ? { id: replacement.id, filename: replacement.filename, mime_type: replacement.mime_type }
                : doc)))
            }}
          />
        ) : null}
        {editingPurchase ? (
          /* Owned here rather than threaded down from a row-actions controller, the way the document
             viewer beside it is: this editor needs nothing from the host but a place to report the
             result, so a controller in between would be plumbing with no decision in it. */
          <PurchaseEditorDialog
            txnId={txn.id}
            onClose={() => setEditingPurchase(false)}
            onSaved={purchase => onUpdatePurchase?.(txn.id, purchaseRowSummary(purchase, txn.id))}
          />
        ) : null}
        {editingReimbursement ? (
          /* Owned here for the same reason the purchase editor beside it is. This cell holds no category
             list, so none is passed: the dialog loads its own when completing asks for a category. An
             empty array was passed here once, and the completion picker offered nothing but "New group". */
          <ReimbursementEditorDialog
            linkId={editingReimbursement}
            txnId={txn.id}
            onClose={() => setEditingReimbursement(null)}
            onSaved={() => onUpdateReimbursements?.(txn.id)}
          />
        ) : null}
        {excludedFromTotals ? (
          <RowTooltip
            content={<span>Not counted in spending totals — its category is in a group excluded from totals (e.g. Transfers).</span>}
            maxWidth={MAX_TAG_TOOLTIP_WIDTH}
          >
            <span
              aria-label="Excluded from totals"
              style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--muted)', fontSize: 13, cursor: 'default' }}
            >
              ⊘
            </span>
          </RowTooltip>
        ) : null}
      </div>
    </div>
  )
}

// The amount and its inline edit pencil. The status/tag markers that used to share this cell now live
// in their own column (TransactionMarkersCell) so the amount reorders on its own; the pencil stays
// here, riding the amount's right edge. A stable min-width slot keeps amounts right-aligned row to row.
export function TransactionAmountCell({ txn, onOpenDetail, showExcludedFromTotals = false }) {
  const excludedFromTotals = showExcludedFromTotals && !!txn.excluded_from_totals
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, width: '100%', minWidth: 0 }}>
      <AmountDisplay
        amount={txn.amount}
        isPending={!!txn.is_pending}
        style={{ display: 'flex', justifyContent: 'flex-end', minWidth: 72, flexShrink: 0, ...(excludedFromTotals ? { opacity: 0.5 } : {}) }}
      />
      {onOpenDetail ? (
        <RowTooltip content="Edit transaction…">
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
        </RowTooltip>
      ) : null}
    </div>
  )
}

// The allocation behind a "Split (N)" chip, shown on hover. The amounts are what make this worth a
// hover rather than a list of category names: in a category-scoped list the row itself shows only the
// *part* that matched, so this is where "why does this row say $60 when the purchase was $100?" gets
// answered.
//
// Each part is stated in the transaction's own direction (`transactionDirection`), so the shares of a
// charge and of a deposit both read as magnitudes that add up to the row beside them. Direction is
// carried by the color instead — the same green a deposit's own amount gets, since a part that moves
// money in is the thing worth marking, not every part of an ordinary purchase.
function SplitPartsHoverCard({ parts, txnAmount, matchedSearch = false }) {
  const dir = transactionDirection(txnAmount)
  return (
    <div style={{ display: 'grid', gap: 3, minWidth: 160 }}>
      {/* Set by the ledger's search when the row matched on a part's description, which the row itself
          does not show — this card is then the only place the reason for the row being listed is visible. */}
      {matchedSearch ? (
        <div style={{ fontSize: 12, color: 'var(--accent)' }}>Matched the search in an item description below.</div>
      ) : null}
      {parts.map((part, i) => (
        // Keyed by position, not by category: two allocations may name the same category, so the
        // category id is not an identity here. The list is static — rendered in the stored order,
        // never sorted or filtered in place — so the index is the stable one.
        <div key={`part-${i}`} style={{ display: 'grid', gap: 1 }}>
          <div style={{ display: 'flex', gap: 16, justifyContent: 'space-between' }}>
            <span>{part.category_name || 'Uncategorized'}</span>
            <span style={{
              color: getTransactionAmountColor(part.amount),
              fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
            }}>
              {formatSignedMoneyAmount(part.amount * dir)}
            </span>
          </div>
          {/* What the allocation covers, where the user recorded it. Clamped to one line: these come
              from marketplace item titles, which are long enough to swamp the figures they annotate. */}
          {part.label ? (
            <span style={{
              color: 'var(--muted)', fontSize: 11, overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{part.label}</span>
          ) : null}
        </div>
      ))}
    </div>
  )
}


// `onOpenSplit` (optional) is what makes a split row editable: a split transaction has no single
// category to pick, so the cell renders "Split (N)" and routes a click to the split editor instead of
// the category picker. A host that doesn't pass it renders the marker read-only rather than offering a
// picker that the backend would refuse — see docs/data-model.md, Transaction splits.
export function CategoryCell({ txn, categories, onSave, onAddCategory, onRulePrompt, onOpenDetail, onOpenSplit }) {
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

  if (txn.is_split) {
    const parts = txn.split_parts || []
    const { partCount, total } = splitPartSummary(txn)

    // One expanded allocation of a split, not the split itself. The row's category and amount are the
    // *part's*, so the cell names that category: the "Split (N)" marker below would claim the row is the
    // whole purchase, and its hover would answer a question about this $10 row with the other part's
    // $240.
    //
    // The badge and its ◧ are one control, and it leads to the split editor rather than the picker —
    // the same destination the whole-split row's chip has, so a split's category is edited in one place
    // whether the row is expanded or not. Repointing a single allocation in place would be the lighter
    // gesture and is the thing to build if this proves a nuisance; what stops it today is that every
    // surface reconciles an edited row by transaction id, which is the right identity for a note or a
    // tag and the wrong one here — two allocations sharing a category would both take the new one.
    if (isSplitPartRow(txn)) {
      // The transaction's own amount, which an expanded row does not carry — summed from the parts,
      // which the split invariant guarantees add up to it.
      const wholeAmount = total ?? txn.amount
      const content = (
        <>
          <CategoryDisplay id={txn.category_id} name={txn.category_name} />
          <span aria-hidden="true" style={{ color: 'var(--muted)' }}>◧</span>
        </>
      )
      const control = onOpenSplit ? (
        <button
          onClick={e => { e.stopPropagation(); onOpenSplit(txn) }}
          aria-label={`${txn.category_name || 'Uncategorized'} — one part of a split; edit the split`}
          style={splitPartControlStyle}
        >{content}</button>
      ) : (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>{content}</span>
      )
      return (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <RowTooltip
            maxWidth={320}
            content={
              <div style={{ display: 'grid', gap: 6 }}>
                <div style={{ color: 'var(--muted)' }}>
                  {partCount ? `One of ${partCount} parts` : 'Part'} of{' '}
                  {formatSignedMoneyAmount(wholeAmount * transactionDirection(wholeAmount))}
                </div>
                {parts.length ? <SplitPartsHoverCard parts={parts} txnAmount={wholeAmount} /> : null}
              </div>
            }
          >
            {control}
          </RowTooltip>
        </div>
      )
    }

    const matchedSearch = !!txn.matched_split_label
    const chip = (
      <span style={{
        border: '1px dashed var(--border)', borderRadius: 6, color: 'var(--muted)',
        fontSize: 12, padding: '1px 7px', whiteSpace: 'nowrap',
        // The same mark a name found through hidden text carries; the hover lists the descriptions.
        ...(matchedSearch ? { textDecoration: 'underline dotted var(--accent)', textUnderlineOffset: 3 } : null),
      }}>
        {partCount ? `Split (${partCount})` : 'Split'}
      </span>
    )
    return (
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <div
          onClick={onOpenSplit ? () => onOpenSplit(txn) : undefined}
          style={{ cursor: onOpenSplit ? 'pointer' : 'default', display: 'inline-flex', alignItems: 'center', gap: 4 }}
        >
          {parts.length ? (
            <RowTooltip content={<SplitPartsHoverCard parts={parts} txnAmount={txn.amount} matchedSearch={matchedSearch} />} maxWidth={320}>
              {chip}
            </RowTooltip>
          ) : chip}
        </div>
      </div>
    )
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
        <RowTooltip content="View category spending history">
          <button
            onClick={e => { e.stopPropagation(); onOpenDetail() }}
            aria-label="View category spending history"
            style={detailButtonStyle}
          >↗</button>
        </RowTooltip>
      )}
    </div>
  )
}
