// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

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

import { useMemo, useState } from 'react'
import { api } from '../lib/api.js'
import { formatTransactionAmount } from '../lib/moneyDisplay.js'
import { useUserPreference } from '../lib/UserPreferencesContext.jsx'
import { DUPLICATE_REPORT_COLUMNS_PREF_KEY } from '../lib/importExport/constants.js'
import { Button, COMPACT_ACTION_BTN_STYLE } from './ui.jsx'
import { MatchReport } from './importExport/MatchReport.jsx'
import { TransactionMatchCell, SourceFileLink } from './importExport/TransactionMatchCell.jsx'
import {
  DetailPanelShell,
  useDetailPanelChrome,
  useRestorablePanelGeometry,
} from './detailShared.jsx'
import ContextualExplainer from '../help/ContextualExplainer.jsx'
import FeatureExplainer from '../help/FeatureExplainer.jsx'
import HelpHoverCard from '../help/HelpHoverCard.jsx'

// Sticky UI state for the dialog. Sort survives close/reopen so a user who prefers
// merchant-asc gets it on the next visit; panel geometry is restored if the user has dragged
// or resized the dialog. The active rule filter intentionally does NOT persist — opening the
// report should always start from the "All" view so the user sees every entry by default
// rather than landing on a stale filter from a previous session.
const UNIFIED_DUPLICATES_SORT_PREF_KEY = 'ui.unifiedDuplicates.sort'
const UNIFIED_DUPLICATES_PANEL_PREF_KEY = 'ui.unifiedDuplicates.panel'

const DEFAULT_SORT_STATE = { key: 'kind', dir: 'asc' }

// The two "needs attention" kinds get their own quick-filter pills so the user can isolate them and
// bulk-select (filter → header select-all). The resolved/plain-rejected kinds get none — they need no
// action. Mirrors the Kind-cell label precedence below (soft flag → Review; a coverage hard-reject
// with no specific match and not yet resolved → Rejected · review). Returns null for the rest.
const REVIEW_KIND_PILLS = [
  { key: 'review', label: 'Review', topic: 'cross-account-duplicates' },
  { key: 'matched_2d', label: 'Matched ±2 days', topic: 'covered-range-review' },
  { key: 'transfer_match', label: 'Possible transfer match', topic: 'covered-range-review' },
  { key: 'no_match', label: 'No specific match', topic: 'covered-range-review' },
]

// Soft flags need a Keep/Discard/Replace decision. Advisory coverage rejects (already rejected,
// never imported) carry a backend `review_substate`: 'matched_2d' (a same-amount twin was found
// only at the ±2 timezone fallback) or 'no_match' (no twin anywhere). The backend clears the
// substate once the row is acknowledged (`reviewed`), so a reviewed row returns null here and
// drops out of the needs-attention pills.
function reviewKindOf(entry) {
  if (entry.kind === 'soft_flag') return 'review'
  if (entry.review_substate === 'matched_2d') return 'matched_2d'
  if (entry.review_substate === 'transfer_match') return 'transfer_match'
  if (entry.review_substate === 'no_match') return 'no_match'
  return null
}

// Amounts arrive in the app's stored convention (spending positive). Render them through the shared
// transaction formatter so sign and currency match the ledger and every other surface — a deposit reads
// as +$, a spend as -$ — instead of the raw stored number, which is inverted from how the UI reads money.
// (formatTransactionAmount reuses a module-level Intl.NumberFormat, so the large-batch caching still holds.)
function formatAmount(value) {
  if (!Number.isFinite(Number(value))) return ''
  return formatTransactionAmount(value)
}

// Pure per-entry helpers (like reviewKindOf above) — they read only their `entry` argument and module-level
// constants, no props/state, so they live at module scope: stable identities that don't need to be listed
// as hook dependencies where the selection summary and sort/render use them.
const entryId = (entry) => `${entry.kind}:${entry.incoming?.txn_id || entry.incoming?.row_number || ''}`

// A duplicate can enrich its match when exactly one existing transaction is unambiguously matched —
// a coverage reject with a single candidate, or a terminal/exact reject matched to one row directly.
// Mirrors the backend's `_duplicate_match_txn_id`.
function enrichTargetExists(entry) {
  const matched = entry.matched
  if (!matched || typeof matched !== 'object') return false
  if (Array.isArray(matched.candidates)) {
    // A cross-account transfer twin isn't an enrich target — the row is the funding leg of a transfer,
    // not richer detail for the matched transaction; its only resolutions are Mark reviewed / Import anyway.
    if (matched.candidates.some(c => c.cross_account)) return false
    return matched.candidates.length === 1
  }
  return !!matched.id
}

function actionsFor(entry) {
  if (entry.kind === 'soft_flag') return { keep: true, reject: true, replace: true }
  if (entry.kind === 'hard_reject' && entry.incoming?.txn_id) return { restore: true }
  if (entry.kind === 'hard_reject' && entry.incoming?.row_number != null) {
    // Advisory coverage rejects: already rejected, but offer both "Import anyway" (if it's
    // actually a distinct row missing from the other file) and "Mark reviewed" (acknowledge the
    // rejection, clearing it from the needs-attention pills). A reviewed one can be un-reviewed.
    const actions = { import_anyway: true }
    if (entry.review_substate) actions.mark_reviewed = true
    else if (entry.reviewed && entry.matched?.covered) actions.unreview = true
    // Enrich: fold this rejected row's incoming detail into the transaction it matched (or undo).
    if (entry.enriched) actions.unenrich = true
    else if (enrichTargetExists(entry)) actions.enrich = true
    return actions
  }
  return {}
}

// Display order for the Kind column: review (needs action) first, then rejected-review
// (also needs attention but lower urgency), then resolved (a soft-flag the user already
// decided about — either Rejected or auto-promoted), then plain Rejected (import-time
// hard-reject with a specific match). Keep these four ranks in sync with the Kind-cell
// labels in the row template further down.
function kindRank(entry) {
  if (entry.kind === 'soft_flag') return 0  // Review (undecided)
  if (entry.review_substate) return 1       // Rejected · review (matched ±2 days / no specific match)
  if (entry.incoming?.txn_id) return 2      // Resolved (confirmed soft-flag)
  return 3                                  // Rejected (settled, incl. acknowledged)
}

// The Kind cell's label + amber emphasis and the row's left-border stripe, kept in sync (they read the
// same four states). Used by the MatchReport column render and getRowStripe.
function kindMeta(entry) {
  const isSoft = entry.kind === 'soft_flag'
  const isConfirmedSoftFlag = entry.kind === 'hard_reject' && !!entry.incoming?.txn_id
  const isAdvisoryReview = !!entry.review_substate
  const isAcknowledged = entry.kind === 'hard_reject' && entry.reviewed && !!entry.matched?.covered
  // A settled hard-reject that folded its detail into the transaction it matched reads as a positive
  // outcome, not a discard: "Rejected" (= not imported as new) undersells it. Labeled "Matched" (green),
  // with the ✓ enriched detail line below carrying the specifics. Only when it isn't still a soft-flag
  // or an advisory-review row that needs a decision first.
  const isEnrichedMatch = entry.kind === 'hard_reject' && !!entry.enriched && !isConfirmedSoftFlag && !isAdvisoryReview
  return {
    warn: isSoft || isAdvisoryReview,
    positive: isEnrichedMatch,
    label: isSoft ? 'Review' : isConfirmedSoftFlag ? 'Resolved' : isAdvisoryReview ? 'Rejected · review'
      : isEnrichedMatch ? 'Matched' : isAcknowledged ? 'Reviewed' : 'Rejected',
    stripe: isSoft ? 'var(--warning)'
      : isConfirmedSoftFlag ? 'color-mix(in srgb, var(--warning) 60%, var(--border))'
      : isAdvisoryReview ? 'color-mix(in srgb, var(--warning) 30%, var(--border))'
      : isEnrichedMatch ? 'var(--success)'
      : 'var(--border)',
  }
}

export default function UnifiedDuplicatesDialog({
  entries = [],
  hardRejectCount = 0,
  softFlagCount = 0,
  ruleBreakdown = [],
  title = 'this import',
  batchId = '',
  accountFilter = null,
  onClearAccountFilter,
  loading = false,
  error = '',
  onClose,
  onReload,
  onMinimize,
  onDrillThrough,
  stackIndex = 0,
  isTopmost = true,
}) {
  // forceFloating=true makes the dialog non-modal — the user can interact with the rest of the app
  // while the report stays open (the cross-account-merge workflow). initialSize gives the panel a
  // constrained explicit height so it has vertical drag range; without it clampPanelPosition would lock
  // Y when the panel filled the viewport. Geometry is restored/persisted across opens by the shared hook.
  const { initialPosition, initialSize, onGestureEnd } = useRestorablePanelGeometry(UNIFIED_DUPLICATES_PANEL_PREF_KEY)
  const { pos, size, panelRef, onDragStart, onResizeStart } = useDetailPanelChrome(onClose, {
    forceFloating: true,
    stackIndex,
    initialPosition,
    initialSize,
    onGestureEnd,
  })

  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [activeRuleFilter, setActiveRuleFilter] = useState(null)
  // Kind/status quick-filter, mutually exclusive with the rule filter (picking one clears the other).
  const [activeKindFilter, setActiveKindFilter] = useState(null)
  const [sortState, setSortState] = useUserPreference(UNIFIED_DUPLICATES_SORT_PREF_KEY, DEFAULT_SORT_STATE)
  const [pendingBulk, setPendingBulk] = useState(false)
  const [actionError, setActionError] = useState('')

  // When opened from an account's detail panel, scope the whole report to that account's rows so the
  // counts, filter chips, and list all reflect just what's relevant — the user lands on exactly the
  // duplicates that explain their empty account instead of scrolling the full batch.
  const scopedEntries = useMemo(() => (
    accountFilter?.id
      ? entries.filter(e => String(e.incoming?.account_id || '') === String(accountFilter.id))
      : entries
  ), [entries, accountFilter])

  const reviewKindBreakdown = useMemo(() => {
    const counts = { review: 0, matched_2d: 0, transfer_match: 0, no_match: 0 }
    for (const e of scopedEntries) {
      const k = reviewKindOf(e)
      if (k) counts[k] += 1
    }
    return counts
  }, [scopedEntries])

  const visibleEntries = useMemo(() => {
    const filtered = activeKindFilter
      ? scopedEntries.filter(e => reviewKindOf(e) === activeKindFilter)
      : activeRuleFilter
        ? scopedEntries.filter(e => (e.rule_key || '') === activeRuleFilter)
        : scopedEntries
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
  }, [scopedEntries, activeRuleFilter, activeKindFilter, sortState])

  const visibleIds = useMemo(() => new Set(visibleEntries.map(entryId)), [visibleEntries])

  const selectionSummary = useMemo(() => {
    const summary = { total: 0, keep: 0, reject: 0, replace: 0, restore: 0, import_anyway: 0, mark_reviewed: 0, unreview: 0, enrich: 0, unenrich: 0 }
    for (const entry of visibleEntries) {
      if (!selectedIds.has(entryId(entry))) continue
      summary.total += 1
      const a = actionsFor(entry)
      if (a.keep) summary.keep += 1
      if (a.reject) summary.reject += 1
      if (a.replace) summary.replace += 1
      if (a.restore) summary.restore += 1
      if (a.import_anyway) summary.import_anyway += 1
      if (a.mark_reviewed) summary.mark_reviewed += 1
      if (a.unreview) summary.unreview += 1
      if (a.enrich) summary.enrich += 1
      if (a.unenrich) summary.unenrich += 1
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
      const selected = visibleEntries.filter(e => selectedIds.has(entryId(e)) && actionsFor(e)[action])
      if (action === 'mark_reviewed' || action === 'unreview') {
        // Acknowledgment is one row-number-set call rather than N requests.
        const rows = selected.map(e => e.incoming.row_number).filter(n => n != null)
        if (rows.length) await api.markBatchDuplicatesReviewed(batchId, rows, action === 'mark_reviewed')
      } else if (action === 'enrich' || action === 'unenrich') {
        const rows = selected.map(e => e.incoming.row_number).filter(n => n != null)
        if (rows.length) {
          if (action === 'enrich') await api.enrichBatchDuplicates(batchId, rows)
          else await api.undoBatchDuplicateEnrichment(batchId, rows)
        }
      } else {
        const tasks = selected.map(entry => {
          if (action === 'keep')          return api.resolveSuspectDuplicate(entry.incoming.txn_id, 'keep')
          if (action === 'reject')        return api.resolveSuspectDuplicate(entry.incoming.txn_id, 'reject')
          if (action === 'replace')       return api.resolveSuspectDuplicate(entry.incoming.txn_id, 'replace')
          if (action === 'restore')       return api.restoreRejectedDuplicate(entry.incoming.txn_id)
          if (action === 'import_anyway') return api.importBatchDuplicates(batchId, { row_numbers: [entry.incoming.row_number] })
          return null
        }).filter(Boolean)
        await Promise.all(tasks)
      }
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
      else if (action === 'replace')      await api.resolveSuspectDuplicate(entry.incoming.txn_id, 'replace')
      else if (action === 'restore')      await api.restoreRejectedDuplicate(entry.incoming.txn_id)
      else if (action === 'import_anyway') await api.importBatchDuplicates(batchId, { row_numbers: [entry.incoming.row_number] })
      else if (action === 'mark_reviewed') await api.markBatchDuplicatesReviewed(batchId, [entry.incoming.row_number], true)
      else if (action === 'unreview')      await api.markBatchDuplicatesReviewed(batchId, [entry.incoming.row_number], false)
      else if (action === 'enrich')        await api.enrichBatchDuplicates(batchId, [entry.incoming.row_number])
      else if (action === 'unenrich')      await api.undoBatchDuplicateEnrichment(batchId, [entry.incoming.row_number])
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
                 : confidence === 'low'  ? 'var(--warning)'
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


  // Thin wrappers over the shared match-report cells (see importExport/TransactionMatchCell). The
  // duplicate report is the first consumer; the reconciliation report reuses the same cells.
  function sourceFileLink(info) {
    return <SourceFileLink {...info} onDrillThrough={onDrillThrough} />
  }

  function partyBlock(side, sourceInfo = null) {
    if (!side) return <TransactionMatchCell record={null} />
    return <TransactionMatchCell record={{ ...side, source: sourceInfo || undefined }} onDrillThrough={onDrillThrough} />
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
      // Cross-account transfer twin (a funding/deposit leg matched to its counterpart on the funding
      // account): its own marker, since it's not a same-account match and reads differently.
      const isTransferMatch = candidates.length > 0 && candidates.every(c => c.cross_account)
      const markerStyle = {
        display: 'inline-flex', alignItems: 'center', padding: '0 5px',
        borderRadius: 4, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.02em',
        background: 'color-mix(in srgb, var(--warning) 14%, var(--surface2))',
        color: 'var(--warning)', border: '1px solid color-mix(in srgb, var(--warning) 40%, var(--border))',
        marginRight: 4,
      }
      const noMatchMarker = <span style={markerStyle}>NO SPECIFIC MATCH</span>
      const transferMarker = (
        <span style={{
          ...markerStyle,
          background: 'color-mix(in srgb, var(--accent2) 14%, var(--surface2))',
          color: 'var(--accent2)', border: '1px solid color-mix(in srgb, var(--accent2) 40%, var(--border))',
        }}>POSSIBLE TRANSFER MATCH</span>
      )
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, lineHeight: 1.3 }}>
          <div style={{ color: 'var(--muted)', fontSize: 11 }}>
            {candidates.length === 0 ? noMatchMarker : isTransferMatch ? transferMarker : null}
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
                {c.day_offset ? (
                  <span style={{ marginLeft: 4, fontSize: 9.5, fontWeight: 600, color: 'var(--accent2)', whiteSpace: 'nowrap' }}>
                    ({Math.abs(c.day_offset)} day{Math.abs(c.day_offset) === 1 ? '' : 's'} {c.day_offset < 0 ? 'earlier' : 'later'})
                  </span>
                ) : null}
                {' · '}<span>{c.merchant_name || ''}</span>
                {' · '}<span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{formatAmount(c.amount)}</span>
                {c.cross_account && c.account_name ? (
                  <span style={{ marginLeft: 4, fontSize: 9.5, fontWeight: 600, color: 'var(--accent2)', whiteSpace: 'nowrap' }}>
                    on {c.account_name}
                  </span>
                ) : null}
              </div>
              {c.source_filename ? sourceFileLink({
                filename:   c.source_filename,
                batchId:    c.source_batch_id,
                importedAt: c.source_imported_at,
                dateStart:  c.date || null,
                dateEnd:    c.date || null,
              }) : null}
            </div>
          ))}
          {candidates.length === 0 ? (
            <div style={{ color: 'var(--muted)', fontSize: 10.5, fontStyle: 'italic' }}>
              The date is in the covered range of the earlier import above, but no row on this account matches by date+amount. Open the source file to investigate.
            </div>
          ) : isTransferMatch ? (
            <div style={{ color: 'var(--muted)', fontSize: 10.5, fontStyle: 'italic' }}>
              A same-amount transaction naming this account sits on another account — likely the funding leg of this transfer, already on your books. Mark reviewed to confirm, or Import anyway if they&apos;re separate.
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
        // Open the ledger focused on the matched row's own date so the user lands on the
        // transaction in question instead of the whole file.
        dateStart:  matched.date || null,
        dateEnd:    matched.date || null,
      } : null
      return partyBlock({
        date:                matched.date,
        merchant:            matched.merchant || matched.merchant_name,
        amount:              matched.amount,
        account_name:        matched.account_name,
        account_merged_into: matched.account_merged_into,
      }, sourceInfo)
    }
    return <div style={{ color: 'var(--muted)', fontSize: 11 }}>{reasonText || '—'}</div>
  }

  const dialogHeader = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1 }}>
      <span onMouseDown={e => e.stopPropagation()} style={{ display: 'inline-flex', flexShrink: 0 }}>
        <FeatureExplainer topic="duplicate-report" placement="bottom-left" />
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: 15 }}>Duplicate detection report — {title}</div>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          {accountFilter?.id
            ? `${scopedEntries.length} duplicate${scopedEntries.length === 1 ? '' : 's'} for ${accountFilter.name}`
            : `${entries.length} total · ${hardRejectCount} rejected at import · ${softFlagCount} flagged for review`}
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
      panelRef={panelRef}
      onDragStart={onDragStart}
      onResizeStart={onResizeStart}
      onClose={onClose}
      header={dialogHeader}
      isTopmost={isTopmost}
    >
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, margin: '-20px -24px', overflow: 'hidden' }}>
        {accountFilter?.id ? (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
            padding: '8px 16px', borderBottom: '1px solid var(--border)',
            background: 'color-mix(in srgb, var(--accent) 8%, var(--surface2))', fontSize: 12,
          }}>
            <span style={{ color: 'var(--muted)' }}>
              Showing only duplicates for <strong style={{ color: 'var(--text)' }}>{accountFilter.name}</strong>.
            </span>
            {onClearAccountFilter ? (
              <button
                type="button"
                onClick={onClearAccountFilter}
                onMouseDown={e => e.stopPropagation()}
                style={{
                  background: 'none', border: 'none', padding: 0,
                  color: 'var(--accent2)', cursor: 'pointer', fontSize: 12, textDecoration: 'underline',
                }}
              >
                Show all duplicates in this import
              </button>
            ) : null}
          </div>
        ) : null}
        <ContextualExplainer
          topic="duplicate-report"
          active={entries.length > 0}
          persistentButton={false}
          style={{ margin: '10px 16px 4px' }}
        />
        {(ruleBreakdown.length > 0 || reviewKindBreakdown.review || reviewKindBreakdown.matched_2d || reviewKindBreakdown.transfer_match || reviewKindBreakdown.no_match) ? (
          <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 6, alignItems: 'baseline', background: 'color-mix(in srgb, var(--surface2) 50%, transparent)' }}>
            <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>Show:</span>
            <button
              type="button"
              onClick={() => { setActiveRuleFilter(null); setActiveKindFilter(null) }}
              style={{
                fontSize: 11, padding: '2px 10px', borderRadius: 99, cursor: 'pointer', flexShrink: 0,
                background: (activeRuleFilter === null && activeKindFilter === null) ? 'var(--accent)' : 'var(--surface2)',
                color: (activeRuleFilter === null && activeKindFilter === null) ? 'white' : 'var(--muted)',
                border: '1px solid var(--border)',
              }}
            >
              All ({scopedEntries.length})
            </button>
            {/* "Show:" and "All" stay fixed; only the rule + kind pills wrap, so wrapped rows line up
                under the first rule pill (to the right of All) rather than under "Show:" or "All". */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, flex: 1, minWidth: 0 }}>
            {ruleBreakdown.map(rule => {
              const active = activeRuleFilter === rule.rule_key
              const accent = rule.confidence === 'high' ? 'var(--accent)'
                          : rule.confidence === 'low'  ? 'var(--warning)'
                          : 'var(--accent2)'
              return (
                <button
                  key={rule.rule_key}
                  type="button"
                  title={rule.rule_description}
                  onClick={() => { setActiveRuleFilter(active ? null : rule.rule_key); setActiveKindFilter(null) }}
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
            {(reviewKindBreakdown.review || reviewKindBreakdown.matched_2d || reviewKindBreakdown.transfer_match || reviewKindBreakdown.no_match) ? (
              <span style={{ width: 1, alignSelf: 'stretch', margin: '0 2px', background: 'var(--border)' }} />
            ) : null}
            {REVIEW_KIND_PILLS.map(k => {
              const count = reviewKindBreakdown[k.key]
              if (!count) return null
              const active = activeKindFilter === k.key
              // Amber = needs attention (matches the Kind-cell styling); the transfer-match pill uses
              // accent2 to tie to its blue POSSIBLE TRANSFER MATCH badge in the matched-existing cell.
              const accent = k.key === 'transfer_match' ? 'var(--accent2)' : 'var(--warning)'
              return (
                <HelpHoverCard key={k.key} topic={k.topic}>
                  <button
                    type="button"
                    onClick={() => { setActiveKindFilter(active ? null : k.key); setActiveRuleFilter(null) }}
                    style={{
                      fontSize: 11, padding: '2px 10px', borderRadius: 99, cursor: 'pointer',
                      background: active ? accent : `color-mix(in srgb, ${accent} 10%, var(--surface2))`,
                      color: active ? 'white' : accent,
                      border: `1px solid color-mix(in srgb, ${accent} 40%, var(--border))`,
                      fontWeight: active ? 600 : 500,
                    }}
                  >
                    {k.label} ({count})
                  </button>
                </HelpHoverCard>
              )
            })}
            </div>
          </div>
        ) : null}

        {selectionSummary.total > 0 ? (
          <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', background: 'color-mix(in srgb, var(--accent) 6%, var(--surface2))' }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>{selectionSummary.total} selected</span>
            <Button
              style={COMPACT_ACTION_BTN_STYLE}
              variant="ghost"
              disabled={pendingBulk || selectionSummary.keep === 0}
              onClick={() => runBulk('keep')}
              title="These are different transactions: keep the new row too, mark the two accounts as distinct, and cascade-clear every other flagged row between the same account pair. Future imports skip the pair."
            >
              Keep both ({selectionSummary.keep})
            </Button>
            <Button
              style={COMPACT_ACTION_BTN_STYLE}
              variant="ghost"
              disabled={pendingBulk || selectionSummary.reject === 0}
              onClick={() => runBulk('reject')}
              title="The new file's row is a duplicate: discard it and keep the existing transaction."
            >
              Discard new ({selectionSummary.reject})
            </Button>
            <Button
              style={COMPACT_ACTION_BTN_STYLE}
              variant="ghost"
              disabled={pendingBulk || selectionSummary.replace === 0}
              onClick={() => runBulk('replace')}
              title="The new file's row is the correct record (e.g. correct account): keep it and remove the existing duplicate. Categorization follows whichever file was set to use its imported categories."
            >
              Replace existing ({selectionSummary.replace})
            </Button>
            <Button
              style={COMPACT_ACTION_BTN_STYLE}
              variant="ghost"
              disabled={pendingBulk || selectionSummary.mark_reviewed === 0}
              onClick={() => runBulk('mark_reviewed')}
              title="Acknowledge these already-rejected rows as reviewed — clears them from the needs-attention list without importing them."
            >
              Mark reviewed ({selectionSummary.mark_reviewed})
            </Button>
            <Button style={COMPACT_ACTION_BTN_STYLE} variant="ghost" disabled={pendingBulk || selectionSummary.import_anyway === 0} onClick={() => runBulk('import_anyway')}>
              Import anyway ({selectionSummary.import_anyway})
            </Button>
            {selectionSummary.enrich > 0 ? (
              <Button style={COMPACT_ACTION_BTN_STYLE} variant="ghost" disabled={pendingBulk} onClick={() => runBulk('enrich')} title="Fold each selected row's extra detail into the transaction it matched — additive and reversible.">
                Enrich existing ({selectionSummary.enrich})
              </Button>
            ) : null}
            {selectionSummary.unenrich > 0 ? (
              <Button style={COMPACT_ACTION_BTN_STYLE} variant="ghost" disabled={pendingBulk} onClick={() => runBulk('unenrich')}>
                Undo enrich ({selectionSummary.unenrich})
              </Button>
            ) : null}
            <Button style={COMPACT_ACTION_BTN_STYLE} variant="ghost" disabled={pendingBulk || selectionSummary.restore === 0} onClick={() => runBulk('restore')}>
              Restore ({selectionSummary.restore})
            </Button>
            {selectionSummary.unreview > 0 ? (
              <Button style={COMPACT_ACTION_BTN_STYLE} variant="ghost" disabled={pendingBulk} onClick={() => runBulk('unreview')}>
                Un-review ({selectionSummary.unreview})
              </Button>
            ) : null}
            <span style={{ flex: 1 }} />
            <Button style={COMPACT_ACTION_BTN_STYLE} variant="ghost" disabled={pendingBulk} onClick={() => setSelectedIds(new Set())}>Clear selection</Button>
          </div>
        ) : null}

        {actionError ? <div style={{ padding: '8px 16px', color: 'var(--danger)' }}>{actionError}</div> : null}
        <MatchReport
          columnsPrefKey={DUPLICATE_REPORT_COLUMNS_PREF_KEY}
          entries={visibleEntries}
          getRowId={entryId}
          getRowStripe={(entry) => kindMeta(entry).stripe}
          sortState={sortState}
          onHeaderClick={toggleSort}
          selectable
          selectedIds={selectedIds}
          onToggleRow={toggleEntry}
          onToggleAll={toggleSelectAllVisible}
          allVisibleSelected={allVisibleSelected}
          someVisibleSelected={someVisibleSelected}
          loading={loading}
          error={error}
          emptyMessage={scopedEntries.length === 0
            ? (accountFilter?.id
              ? `No duplicate decisions recorded for ${accountFilter.name} in this import.`
              : "No duplicate decisions recorded for this import.")
            : "No entries match the current filter."}
          columns={[
            { key: 'kind', label: 'Kind', width: 90, minWidth: 76, sortable: true, render: (entry) => {
              const meta = kindMeta(entry)
              return (
                <div style={{ color: meta.warn ? 'var(--warning)' : meta.positive ? 'var(--success)' : 'var(--muted)', fontWeight: meta.warn || meta.positive ? 600 : 400, whiteSpace: 'nowrap' }}>
                  {meta.label}
                  {entry.enriched ? <div style={{ fontSize: 10, color: 'var(--success)', fontWeight: 600, marginTop: 2 }} title="This row's detail was folded into the transaction it matched.">✓ enriched</div> : null}
                </div>
              )
            } },
            { key: 'rule', label: 'Rule', width: 150, minWidth: 90, sortable: true, render: (entry) => ruleBadge(entry) },
            { key: 'date', label: 'Incoming', width: 300, minWidth: 160, sortable: true, render: (entry) => partyBlock(entry.incoming) },
            { key: 'matched', label: 'Matched existing', width: 340, minWidth: 160, render: (entry) => matchedBlock(entry.matched, entry.reason_text) },
            { key: 'resolve', label: 'Resolve', width: 210, minWidth: 140, render: (entry) => {
              const a = actionsFor(entry)
              return (
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {a.keep ? <Button variant="ghost" style={COMPACT_ACTION_BTN_STYLE} disabled={pendingBulk} onClick={() => runSingle(entry, 'keep')} title="These are different transactions: keep the new row too and mark the two accounts as distinct. Clears every other flagged row between this account pair and stops future imports from re-flagging it.">Keep both</Button> : null}
                  {a.reject ? <Button variant="ghost" style={COMPACT_ACTION_BTN_STYLE} disabled={pendingBulk} onClick={() => runSingle(entry, 'reject')} title="The new file's row is a duplicate: discard it and keep the existing transaction.">Discard new</Button> : null}
                  {a.replace ? <Button variant="ghost" style={COMPACT_ACTION_BTN_STYLE} disabled={pendingBulk} onClick={() => runSingle(entry, 'replace')} title="The new file's row is the correct record (e.g. correct account): keep it and remove the existing duplicate. Categorization follows whichever file was set to use its imported categories.">Replace existing</Button> : null}
                  {a.restore ? <Button variant="ghost" style={COMPACT_ACTION_BTN_STYLE} disabled={pendingBulk} onClick={() => runSingle(entry, 'restore')}>Restore</Button> : null}
                  {a.mark_reviewed ? <Button variant="ghost" style={COMPACT_ACTION_BTN_STYLE} disabled={pendingBulk} onClick={() => runSingle(entry, 'mark_reviewed')} title="Already rejected — acknowledge it as reviewed so it leaves the needs-attention list. Does not import it.">Mark reviewed</Button> : null}
                  {a.import_anyway ? <Button variant="ghost" style={COMPACT_ACTION_BTN_STYLE} disabled={pendingBulk} onClick={() => runSingle(entry, 'import_anyway')}>Import anyway</Button> : null}
                  {a.enrich ? <Button variant="ghost" style={COMPACT_ACTION_BTN_STYLE} disabled={pendingBulk} onClick={() => runSingle(entry, 'enrich')} title="Fold this row's extra detail (memo, counterparty, item title…) into the existing transaction it matched. Additive — nothing already there is overwritten — and reversible. Skips a row that adds nothing new.">Enrich existing</Button> : null}
                  {a.unenrich ? <Button variant="ghost" style={COMPACT_ACTION_BTN_STYLE} disabled={pendingBulk} onClick={() => runSingle(entry, 'unenrich')} title="Remove the detail this row folded into the matched transaction.">Undo enrich</Button> : null}
                  {a.unreview ? <Button variant="ghost" style={COMPACT_ACTION_BTN_STYLE} disabled={pendingBulk} onClick={() => runSingle(entry, 'unreview')} title="Move this back to the needs-review list.">Un-review</Button> : null}
                </div>
              )
            } },
          ]}
        />
      </div>
    </DetailPanelShell>
  )
}
