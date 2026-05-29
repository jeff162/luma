// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

// Unified view of duplicate detections for one import batch. Combines hard-reject entries
// (which never landed in the ledger) and soft-flag entries (which landed in the ledger with
// suspect_duplicate_of set) into a single row-per-entry table. Color stripe on the left of each
// row distinguishes the two pools at a glance.
//
// This component used to live inside ImportExport.jsx. It was extracted so that
// `UnifiedDuplicatesViewerContext` can mount it at the top of the App tree and keep it open
// while the user navigates between Import/Export, Accounts, Transactions, etc. The dialog is
// presentational + makes its own API calls for keep/reject/restore/import-anyway actions; the
// context owns the open/close/reload state and routes drill-through requests back to the
// Import/Export page (which is the only place that can render a batch-detail panel).
//
// Per-row actions:
//   * soft_flag row → "Keep" (broad assertion: records the two accounts as distinct; clears the
//     flag here AND every other flagged row between the same account pair; stops future imports
//     from re-flagging the pair) | "Reject" (confirms as a real duplicate; row leaves the ledger
//     and graduates into the rejected pool)
//   * hard_reject row from import_batch_duplicate → "Import anyway" (re-injects the row)
//   * hard_reject row from a confirmed soft-flag → "Restore" (un-reject; row returns to ledger)
//
// Why a hand-rolled <table> instead of the shared PillGridTable:
//   PillGridTable's header renders each column label INSIDE a pill-shaped sort button (see
//   PillTableHeader). This dialog needs an interactive select-all checkbox in its leftmost
//   header cell, with indeterminate state — there's no clean way to embed that inside a sort
//   button without confusing both the visual treatment and the click target. None of the
//   existing PillGridTable consumers (Transactions, TransactionListTable, RuleForm) use
//   select-all, so there's no established extension to lean on. If/when select-all becomes a
//   shared pattern across tables, the right move is to extend PillGridTable's header to accept
//   custom node labels and migrate this dialog at the same time as the others.

import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { useUserPreference } from '../lib/UserPreferencesContext.jsx'
import { Button, Spinner, EmptyState } from './ui.jsx'
import {
  DetailPanelShell,
  useDetailPanelChrome,
  DETAIL_PANEL_MIN_WIDTH,
  DETAIL_PANEL_MIN_HEIGHT,
} from './detailShared.jsx'

// Sticky UI state for the dialog. Sort survives close/reopen so a user who prefers
// merchant-asc gets it on the next visit; panel geometry is restored if the user has dragged
// or resized the dialog. The active rule filter intentionally does NOT persist — opening the
// report should always start from the "All" view so the user sees every entry by default
// rather than landing on a stale filter from a previous session.
const UNIFIED_DUPLICATES_SORT_PREF_KEY = 'ui.unifiedDuplicates.sort'
const UNIFIED_DUPLICATES_PANEL_PREF_KEY = 'ui.unifiedDuplicates.panel'

const DEFAULT_SORT_STATE = { key: 'date', dir: 'desc' }

function formatAmount(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return ''
  return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function UnifiedDuplicatesDialog({
  entries = [],
  hardRejectCount = 0,
  softFlagCount = 0,
  ruleBreakdown = [],
  title = 'this import',
  batchId = '',
  loading = false,
  error = '',
  onClose,
  onReload,
  onMinimize,
  onDrillThrough,
  stackIndex = 0,
  isTopmost = true,
}) {
  // forceFloating=true makes the dialog non-modal — the user can interact with the rest of
  // the app while the report stays open (the cross-account-merge workflow). initialSize
  // gives the panel a constrained explicit height so it has vertical drag range; without
  // it clampPanelPosition would lock Y when the panel filled the viewport.
  //
  // Saved geometry is shape { pos, size, viewport }: we snapshot the viewport at save time
  // so a restore on a different-sized browser can scale pos/size proportionally (a panel
  // saved bottom-right on 1920×1080 stays bottom-right on 1280×720, just smaller). Min
  // sizes (DETAIL_PANEL_MIN_*) are enforced after scaling so an aggressive shrink can't
  // produce an unusable panel. The hook's own clamp pass is the final safety net.
  const [savedPanel, setSavedPanel] = useUserPreference(UNIFIED_DUPLICATES_PANEL_PREF_KEY, null)
  const { initialPosition, initialSize } = useMemo(() => {
    const fallbackSize = {
      width:  Math.min(1280, (typeof window !== 'undefined' ? window.innerWidth  : 1280) - 48),
      height: Math.min(720,  (typeof window !== 'undefined' ? window.innerHeight : 720)  - 160),
    }
    if (!savedPanel || typeof window === 'undefined') {
      return { initialPosition: null, initialSize: fallbackSize }
    }
    const savedViewport = savedPanel.viewport
    if (!savedViewport?.width || !savedViewport?.height) {
      // Legacy save (pre-viewport-scaling): use as-is. Hook clamping handles overflow.
      return { initialPosition: savedPanel.pos || null, initialSize: savedPanel.size || fallbackSize }
    }
    const scaleX = window.innerWidth / savedViewport.width
    const scaleY = window.innerHeight / savedViewport.height
    const scaledSize = savedPanel.size ? {
      width:  Math.max(DETAIL_PANEL_MIN_WIDTH,  Math.round(savedPanel.size.width  * scaleX)),
      height: Math.max(DETAIL_PANEL_MIN_HEIGHT, Math.round(savedPanel.size.height * scaleY)),
    } : fallbackSize
    const scaledPos = savedPanel.pos ? {
      x: Math.round(savedPanel.pos.x * scaleX),
      y: Math.round(savedPanel.pos.y * scaleY),
    } : null
    return { initialPosition: scaledPos, initialSize: scaledSize }
  }, [savedPanel])
  const { pos, size, dragging, resizing, panelRef, onDragStart, onResizeStart } = useDetailPanelChrome(onClose, { forceFloating: true, stackIndex, initialPosition, initialSize })

  // Commit on drag/resize end (false-from-true transition): the hook only updates React
  // state on mouseup so this fires once per gesture, not per intermediate frame. Snapshot
  // the current viewport size alongside so the next restore can scale proportionally.
  const wasDragging = useRef(false)
  const wasResizing = useRef(false)
  useEffect(() => {
    const dragEnded = wasDragging.current && !dragging
    const resizeEnded = wasResizing.current && !resizing
    wasDragging.current = dragging
    wasResizing.current = resizing
    if ((dragEnded || resizeEnded) && (pos || size)) {
      setSavedPanel({
        pos: pos || null,
        size: size || null,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      })
    }
  }, [dragging, resizing, pos, size, setSavedPanel])

  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [activeRuleFilter, setActiveRuleFilter] = useState(null)
  const [sortState, setSortState] = useUserPreference(UNIFIED_DUPLICATES_SORT_PREF_KEY, DEFAULT_SORT_STATE)
  const [pendingBulk, setPendingBulk] = useState(false)
  const [actionError, setActionError] = useState('')

  const entryId = (entry) => `${entry.kind}:${entry.incoming?.txn_id || entry.incoming?.row_number || ''}`

  function actionsFor(entry) {
    if (entry.kind === 'soft_flag') return { keep: true, reject: true }
    if (entry.kind === 'hard_reject' && entry.incoming?.txn_id) return { restore: true }
    if (entry.kind === 'hard_reject' && entry.incoming?.row_number) return { import_anyway: true }
    return {}
  }

  // Display order for the Kind column: review (needs action) first, then rejected-review
  // (also needs attention but lower urgency), then resolved (a soft-flag the user already
  // decided about — either Rejected or auto-promoted), then plain Rejected (import-time
  // hard-reject with a specific match). Keep these four ranks in sync with the Kind-cell
  // labels in the row template further down.
  function kindRank(entry) {
    if (entry.kind === 'soft_flag') return 0  // Review
    if (entry.incoming?.txn_id) return 2      // Resolved (confirmed soft-flag)
    if (entry.matched?.covered && !entry.matched.candidates?.length) return 1  // Rejected · review
    return 3                                  // Rejected
  }

  const visibleEntries = useMemo(() => {
    const filtered = activeRuleFilter
      ? entries.filter(e => (e.rule_key || '') === activeRuleFilter)
      : entries
    const dir = sortState.dir === 'asc' ? 1 : -1
    const getKey = (entry) => {
      switch (sortState.key) {
        case 'date':     return String(entry.incoming?.date || '')
        case 'merchant': return String(entry.incoming?.merchant || '').toLowerCase()
        case 'amount':   return Number(entry.incoming?.amount || 0)
        case 'account':  return String(entry.incoming?.account_name || '').toLowerCase()
        case 'rule':     return String(entry.rule_label || entry.rule_key || '').toLowerCase()
        case 'kind':     return kindRank(entry)
        default:         return ''
      }
    }
    return [...filtered].sort((a, b) => {
      const av = getKey(a); const bv = getKey(b)
      if (av < bv) return -1 * dir
      if (av > bv) return 1 * dir
      // Secondary tiebreaker: when another column is the primary sort, ties fall back to
      // Kind in its natural order (review → rejected-review → resolved → rejected), always
      // ascending regardless of primary sort direction. When Kind itself is the primary,
      // skip this — the primary already covers it.
      if (sortState.key !== 'kind') {
        const ar = kindRank(a); const br = kindRank(b)
        if (ar < br) return -1
        if (ar > br) return 1
      }
      return 0
    })
  }, [entries, activeRuleFilter, sortState])

  const visibleIds = useMemo(() => new Set(visibleEntries.map(entryId)), [visibleEntries])

  const selectionSummary = useMemo(() => {
    const summary = { total: 0, keep: 0, reject: 0, restore: 0, import_anyway: 0 }
    for (const entry of visibleEntries) {
      if (!selectedIds.has(entryId(entry))) continue
      summary.total += 1
      const a = actionsFor(entry)
      if (a.keep) summary.keep += 1
      if (a.reject) summary.reject += 1
      if (a.restore) summary.restore += 1
      if (a.import_anyway) summary.import_anyway += 1
    }
    return summary
  }, [visibleEntries, selectedIds])

  const allVisibleSelected = visibleEntries.length > 0
    && visibleEntries.every(e => selectedIds.has(entryId(e)))
  const someVisibleSelected = visibleEntries.some(e => selectedIds.has(entryId(e))) && !allVisibleSelected

  function toggleEntry(entry) {
    const id = entryId(entry)
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  function toggleSelectAllVisible() {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (allVisibleSelected) {
        for (const id of visibleIds) next.delete(id)
      } else {
        for (const id of visibleIds) next.add(id)
      }
      return next
    })
  }

  function toggleSort(key) {
    setSortState(current => current.key === key
      ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: key === 'date' ? 'desc' : 'asc' })
  }

  async function runBulk(action) {
    setActionError('')
    setPendingBulk(true)
    try {
      const tasks = []
      for (const entry of visibleEntries) {
        if (!selectedIds.has(entryId(entry))) continue
        const a = actionsFor(entry)
        if (!a[action]) continue
        if (action === 'keep')          tasks.push(api.resolveSuspectDuplicate(entry.incoming.txn_id, 'keep'))
        else if (action === 'reject')   tasks.push(api.resolveSuspectDuplicate(entry.incoming.txn_id, 'reject'))
        else if (action === 'restore')  tasks.push(api.restoreRejectedDuplicate(entry.incoming.txn_id))
        else if (action === 'import_anyway') tasks.push(api.importBatchDuplicates(batchId, { row_numbers: [entry.incoming.row_number] }))
      }
      await Promise.all(tasks)
      setSelectedIds(new Set())
      if (typeof onReload === 'function') await onReload()
    } catch (err) {
      setActionError(err?.message || 'Bulk action failed')
    } finally {
      setPendingBulk(false)
    }
  }

  async function runSingle(entry, action) {
    setActionError('')
    setPendingBulk(true)
    try {
      if (action === 'keep')              await api.resolveSuspectDuplicate(entry.incoming.txn_id, 'keep')
      else if (action === 'reject')       await api.resolveSuspectDuplicate(entry.incoming.txn_id, 'reject')
      else if (action === 'restore')      await api.restoreRejectedDuplicate(entry.incoming.txn_id)
      else if (action === 'import_anyway') await api.importBatchDuplicates(batchId, { row_numbers: [entry.incoming.row_number] })
      if (typeof onReload === 'function') await onReload()
    } catch (err) {
      setActionError(err?.message || 'Action failed')
    } finally {
      setPendingBulk(false)
    }
  }

  function ruleBadge(entry) {
    const confidence = entry.confidence || 'medium'
    const accent = confidence === 'high' ? 'var(--accent)'
                 : confidence === 'low'  ? '#f59e0b'
                 : 'var(--accent2)'
    const raw = entry.rule_label || entry.rule_key || 'unknown'
    const parenIdx = raw.indexOf(' (')
    const primary = parenIdx >= 0 ? raw.slice(0, parenIdx) : raw
    const qualifier = parenIdx >= 0 ? raw.slice(parenIdx + 1) : ''
    return (
      <span title={entry.rule_description || ''} style={{
        display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start',
        padding: '2px 7px',
        borderRadius: 8, border: `1px solid color-mix(in srgb, ${accent} 45%, var(--border))`,
        background: `color-mix(in srgb, ${accent} 12%, var(--surface2))`,
        color: accent, lineHeight: 1.15,
      }}>
        <span style={{ fontSize: 10.5, fontWeight: 600, whiteSpace: 'nowrap' }}>{primary}</span>
        {qualifier ? <span style={{ fontSize: 9.5, fontWeight: 400, opacity: 0.8, whiteSpace: 'nowrap' }}>{qualifier}</span> : null}
      </span>
    )
  }

  function sortIndicator(key) {
    if (sortState.key !== key) return <span style={{ color: 'var(--border)', marginLeft: 4 }}>↕</span>
    return <span style={{ marginLeft: 4 }}>{sortState.dir === 'asc' ? '↑' : '↓'}</span>
  }

  function sortableHeader(label, key, extraStyle = {}) {
    return (
      <th
        onClick={() => toggleSort(key)}
        style={{ padding: '6px 8px', cursor: 'pointer', userSelect: 'none', ...extraStyle }}
      >
        {label}{sortIndicator(key)}
      </th>
    )
  }

  function sourceFileLink({ filename, batchId: linkBatchId, importedAt, dateStart, dateEnd }) {
    if (!filename) return null
    const short = filename.length > 32 ? `${filename.slice(0, 12)}…${filename.slice(-16)}` : filename
    const tipParts = [filename]
    if (importedAt) tipParts.push(`imported ${(importedAt || '').slice(0, 16).replace('T', ' ')}`)
    const tip = tipParts.join(' — ')
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: 'var(--muted)', fontSize: 11 }}>
        <span title={tip} style={{ whiteSpace: 'nowrap' }}>from {short}</span>
        {onDrillThrough && linkBatchId ? (
          <button
            type="button"
            title={`Open ${filename} ledger${dateStart ? ` (${dateStart}…${dateEnd || dateStart})` : ''}`}
            onClick={() => onDrillThrough({ batchId: linkBatchId, dateStart, dateEnd, filename })}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px',
              color: 'var(--accent)', fontSize: 12, lineHeight: 1,
            }}
          >↗</button>
        ) : null}
      </span>
    )
  }

  function partyBlock(side, sourceInfo = null) {
    if (!side) return <span style={{ color: 'var(--muted)' }}>—</span>
    const acct = side.account_name || ''
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1, lineHeight: 1.3 }}>
        <div>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{side.date || ''}</span>
          {' · '}
          <span>{side.merchant || ''}</span>
          {' · '}
          <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{formatAmount(side.amount)}</span>
        </div>
        {acct ? <div style={{ color: 'var(--muted)', fontSize: 11 }}>{acct}</div> : null}
        {sourceInfo ? sourceFileLink(sourceInfo) : null}
      </div>
    )
  }

  function matchedBlock(matched, reasonText) {
    if (!matched || (typeof matched !== 'object')) {
      return <div style={{ color: 'var(--muted)', fontSize: 11 }}>{reasonText || '—'}</div>
    }
    if (matched.covered) {
      const covered = matched.covered || {}
      const candidates = Array.isArray(matched.candidates) ? matched.candidates : []
      const range = `${covered.start_date || ''}${covered.end_date && covered.end_date !== covered.start_date ? `..${covered.end_date}` : ''}`
      const sourceInfo = covered.source_filename ? {
        filename:   covered.source_filename,
        batchId:    covered.source_batch_id,
        importedAt: covered.source_imported_at,
        dateStart:  covered.start_date,
        dateEnd:    covered.end_date,
      } : null
      const noMatchMarker = (
        <span style={{
          display: 'inline-flex', alignItems: 'center', padding: '0 5px',
          borderRadius: 4, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.02em',
          background: 'color-mix(in srgb, #f59e0b 14%, var(--surface2))',
          color: '#f59e0b', border: '1px solid color-mix(in srgb, #f59e0b 40%, var(--border))',
          marginRight: 4,
        }}>NO SPECIFIC MATCH</span>
      )
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, lineHeight: 1.3 }}>
          <div style={{ color: 'var(--muted)', fontSize: 11 }}>
            {candidates.length === 0 ? noMatchMarker : null}
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{range ? `Range: ${range}` : ''}</span>
          </div>
          {/* Render the coverage-source link only when there are no candidates. With
              candidates, each candidate already renders its own "from <file>" link below, so
              repeating the same file at the top is just noise. Without candidates ("NO
              SPECIFIC MATCH"), the top link is the only drill-through into the source file
              the user can use to investigate why the date was covered. */}
          {sourceInfo && candidates.length === 0 ? sourceFileLink(sourceInfo) : null}
          {candidates.map((c, idx) => (
            <div key={c.id || idx} style={{ fontSize: 11, paddingLeft: 6, borderLeft: '2px solid color-mix(in srgb, var(--accent2) 30%, var(--border))' }}>
              <div>
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>{c.date || ''}</span>
                {' · '}<span>{c.merchant_name || ''}</span>
                {' · '}<span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{formatAmount(c.amount)}</span>
              </div>
              {c.source_filename ? sourceFileLink({
                filename:   c.source_filename,
                batchId:    c.source_batch_id,
                importedAt: c.source_imported_at,
              }) : null}
            </div>
          ))}
          {candidates.length === 0 ? (
            <div style={{ color: 'var(--muted)', fontSize: 10.5, fontStyle: 'italic' }}>
              The date is in the covered range of the earlier import above, but no row on this account matches by date+amount. Open the source file to investigate.
            </div>
          ) : null}
        </div>
      )
    }
    if (matched.id || matched.merchant || matched.merchant_name) {
      const sourceInfo = matched.source_filename ? {
        filename:   matched.source_filename,
        batchId:    matched.source_batch_id,
        importedAt: matched.source_imported_at,
      } : null
      return partyBlock({
        date:         matched.date,
        merchant:     matched.merchant || matched.merchant_name,
        amount:       matched.amount,
        account_name: matched.account_name,
      }, sourceInfo)
    }
    return <div style={{ color: 'var(--muted)', fontSize: 11 }}>{reasonText || '—'}</div>
  }

  const dialogHeader = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: 15 }}>Duplicate detection report — {title}</div>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          {entries.length} total · {hardRejectCount} rejected at import · {softFlagCount} flagged for review
        </div>
      </div>
      {onReload ? (
        <button
          type="button"
          title="Refresh"
          disabled={loading || pendingBulk}
          onClick={onReload}
          onMouseDown={e => e.stopPropagation()}
          style={{
            background: 'var(--surface2)', border: '1px solid var(--border)',
            borderRadius: 6, padding: '4px 10px', cursor: 'pointer',
            color: 'var(--muted)', fontSize: 13,
          }}
        >↻ Refresh</button>
      ) : null}
      {onMinimize ? (
        <button
          type="button"
          title="Minimize to nav bar (state is preserved — click the pill to restore)"
          onClick={onMinimize}
          onMouseDown={e => e.stopPropagation()}
          style={{
            background: 'var(--surface2)', border: '1px solid var(--border)',
            borderRadius: 6, padding: '4px 10px', cursor: 'pointer',
            color: 'var(--muted)', fontSize: 13,
          }}
        >– Minimize</button>
      ) : null}
    </div>
  )

  return (
    <DetailPanelShell
      pos={pos}
      size={size}
      dragging={dragging}
      resizing={resizing}
      panelRef={panelRef}
      onDragStart={onDragStart}
      onResizeStart={onResizeStart}
      onClose={onClose}
      header={dialogHeader}
      isTopmost={isTopmost}
    >
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, margin: '-20px -24px', overflow: 'hidden' }}>
        {ruleBreakdown.length > 0 ? (
          <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', background: 'color-mix(in srgb, var(--surface2) 50%, transparent)' }}>
            <span style={{ fontSize: 11, color: 'var(--muted)', marginRight: 4 }}>Show:</span>
            <button
              type="button"
              onClick={() => setActiveRuleFilter(null)}
              style={{
                fontSize: 11, padding: '2px 10px', borderRadius: 99, cursor: 'pointer',
                background: activeRuleFilter === null ? 'var(--accent)' : 'var(--surface2)',
                color: activeRuleFilter === null ? 'white' : 'var(--muted)',
                border: '1px solid var(--border)',
              }}
            >
              All ({entries.length})
            </button>
            {ruleBreakdown.map(rule => {
              const active = activeRuleFilter === rule.rule_key
              const accent = rule.confidence === 'high' ? 'var(--accent)'
                          : rule.confidence === 'low'  ? '#f59e0b'
                          : 'var(--accent2)'
              return (
                <button
                  key={rule.rule_key}
                  type="button"
                  title={rule.rule_description}
                  onClick={() => setActiveRuleFilter(active ? null : rule.rule_key)}
                  style={{
                    fontSize: 11, padding: '2px 10px', borderRadius: 99, cursor: 'pointer',
                    background: active ? accent : `color-mix(in srgb, ${accent} 10%, var(--surface2))`,
                    color: active ? 'white' : accent,
                    border: `1px solid color-mix(in srgb, ${accent} 40%, var(--border))`,
                    fontWeight: active ? 600 : 500,
                  }}
                >
                  {rule.rule_label} ({rule.count})
                </button>
              )
            })}
          </div>
        ) : null}

        {selectionSummary.total > 0 ? (
          <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', background: 'color-mix(in srgb, var(--accent) 6%, var(--surface2))' }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>{selectionSummary.total} selected</span>
            <Button
              size="sm"
              variant="ghost"
              disabled={pendingBulk || selectionSummary.keep === 0}
              onClick={() => runBulk('keep')}
              title="For each selected soft-flag, record the two accounts as distinct and cascade-clear every other flagged row between the same account pair. Future imports skip the pair."
            >
              Keep ({selectionSummary.keep})
            </Button>
            <Button size="sm" variant="ghost" disabled={pendingBulk || selectionSummary.reject === 0} onClick={() => runBulk('reject')}>
              Reject ({selectionSummary.reject})
            </Button>
            <Button size="sm" variant="ghost" disabled={pendingBulk || selectionSummary.import_anyway === 0} onClick={() => runBulk('import_anyway')}>
              Import anyway ({selectionSummary.import_anyway})
            </Button>
            <Button size="sm" variant="ghost" disabled={pendingBulk || selectionSummary.restore === 0} onClick={() => runBulk('restore')}>
              Restore ({selectionSummary.restore})
            </Button>
            <span style={{ flex: 1 }} />
            <Button size="sm" variant="ghost" disabled={pendingBulk} onClick={() => setSelectedIds(new Set())}>Clear selection</Button>
          </div>
        ) : null}

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          {loading || error || actionError || (!loading && !error && visibleEntries.length === 0) ? (
            <div style={{ padding: '12px 16px' }}>
              {loading ? <Spinner /> : null}
              {error ? <div style={{ color: 'var(--danger)', marginBottom: 8 }}>{error}</div> : null}
              {actionError ? <div style={{ color: 'var(--danger)', marginBottom: 8 }}>{actionError}</div> : null}
              {!loading && !error && visibleEntries.length === 0 ? (
                <EmptyState message={entries.length === 0
                  ? "No duplicate decisions recorded for this import."
                  : "No entries match the current filter."} />
              ) : null}
            </div>
          ) : null}
          {!loading && !error && visibleEntries.length > 0 ? (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead style={{ position: 'sticky', top: 0, background: 'var(--surface)', zIndex: 1, boxShadow: '0 1px 0 var(--border)' }}>
                <tr style={{ color: 'var(--muted)', textAlign: 'left' }}>
                  <th style={{ padding: '8px 8px 8px 16px', width: 32 }}>
                    <input
                      type="checkbox"
                      ref={el => { if (el) el.indeterminate = someVisibleSelected }}
                      checked={allVisibleSelected}
                      onChange={toggleSelectAllVisible}
                      title={allVisibleSelected ? 'Deselect all visible' : 'Select all visible'}
                    />
                  </th>
                  {sortableHeader('Kind', 'kind', { width: 90 })}
                  {sortableHeader('Rule', 'rule')}
                  {sortableHeader('Incoming', 'date')}
                  <th style={{ padding: '8px' }}>Matched existing</th>
                  <th style={{ padding: '8px 16px 8px 8px', width: 180 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleEntries.map((entry) => {
                  const id = entryId(entry)
                  const isSoft = entry.kind === 'soft_flag'
                  const isConfirmedSoftFlag = entry.kind === 'hard_reject' && !!entry.incoming?.txn_id
                  const isNoMatchCoverage = entry.kind === 'hard_reject'
                    && entry.matched && entry.matched.covered
                    && (!entry.matched.candidates || entry.matched.candidates.length === 0)
                  const stripe = isSoft ? '#f59e0b'
                               : isConfirmedSoftFlag ? 'color-mix(in srgb, #f59e0b 60%, var(--border))'
                               : isNoMatchCoverage ? 'color-mix(in srgb, #f59e0b 30%, var(--border))'
                               : 'var(--border)'
                  const a = actionsFor(entry)
                  return (
                    <tr key={id} style={{ borderBottom: '1px solid color-mix(in srgb, var(--border) 60%, transparent)', borderLeft: `3px solid ${stripe}` }}>
                      <td style={{ padding: '6px 8px 6px 16px', textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(id)}
                          onChange={() => toggleEntry(entry)}
                        />
                      </td>
                      <td style={{ padding: '6px 8px', color: isSoft ? '#f59e0b' : isNoMatchCoverage ? '#f59e0b' : 'var(--muted)', fontWeight: (isSoft || isNoMatchCoverage) ? 600 : 400, whiteSpace: 'nowrap' }}>
                        {isSoft ? 'Review' : isConfirmedSoftFlag ? 'Resolved' : isNoMatchCoverage ? 'Rejected · review' : 'Rejected'}
                      </td>
                      <td style={{ padding: '6px 8px' }}>{ruleBadge(entry)}</td>
                      <td style={{ padding: '6px 8px' }}>{partyBlock(entry.incoming)}</td>
                      <td style={{ padding: '6px 8px' }}>{matchedBlock(entry.matched, entry.reason_text)}</td>
                      <td style={{ padding: '6px 16px 6px 8px' }}>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {a.keep ? <Button variant="ghost" size="sm" disabled={pendingBulk} onClick={() => runSingle(entry, 'keep')} title="Marks the two accounts as distinct. Clears every other flagged row between this same account pair, and stops future imports from re-flagging the pair.">Keep</Button> : null}
                          {a.reject ? <Button variant="ghost" size="sm" disabled={pendingBulk} onClick={() => runSingle(entry, 'reject')}>Reject</Button> : null}
                          {a.restore ? <Button variant="ghost" size="sm" disabled={pendingBulk} onClick={() => runSingle(entry, 'restore')}>Restore</Button> : null}
                          {a.import_anyway ? <Button variant="ghost" size="sm" disabled={pendingBulk} onClick={() => runSingle(entry, 'import_anyway')}>Import anyway</Button> : null}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          ) : null}
        </div>
      </div>
    </DetailPanelShell>
  )
}
