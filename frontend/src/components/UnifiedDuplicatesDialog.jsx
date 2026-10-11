// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unified view of duplicate detections for one import batch. Combines hard-reject entries
// (which never landed in the ledger) and soft-flag entries (which landed in the ledger with
// suspect_duplicate_of set) into a single row-per-entry table. Color stripe on the left of each
// row distinguishes the two pools at a glance.
//
// This component used to live inside ImportExport.jsx. It was extracted so that
// `UnifiedDuplicatesViewerContext` can mount it at the top of the App tree and keep it open
// while the user navigates between Import, Accounts, Transactions, etc. The dialog is
// presentational + makes its own API calls for keep/reject/restore/import-anyway actions; the
// context owns the open/close/reload state and routes drill-through requests back to the
// Import page (which is the only place that can render a batch-detail panel).
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

import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api.js'
import { formatTransactionAmount } from '../lib/moneyDisplay.js'
import { useUserPreference } from '../lib/UserPreferencesContext.jsx'
import { DUPLICATE_REPORT_COLUMNS_PREF_KEY } from '../lib/importExport/constants.js'
import { hasFileOriginDetail } from '../lib/importSourceFields.js'
import { Button, COMPACT_ACTION_BTN_STYLE, Tooltip, ROW_HOVER_OPEN_DELAY_MS, RefreshButton} from './ui.jsx'
import { MerchantOriginHoverCard } from './OriginFields.jsx'
import { MatchReport } from './importExport/MatchReport.jsx'
import { TransactionMatchCell, SourceFileLink } from './importExport/TransactionMatchCell.jsx'
import {
  DetailPanelShell,
  useDetailPanelChrome,
  useRestorablePanelGeometry,
} from './detailShared.jsx'
import { isMatchedElsewhere, isMatchedTransfer, kindMeta, kindRank } from '../lib/duplicateKinds.js'
import { UndoToast } from './CategoryTreePrimitives.jsx'
import { summarizeBulkOutcome } from '../lib/bulkRequestOutcome.js'
import { AccountIdentityPrompt } from './importExport/AccountIdentityPrompt.jsx'
import { notifyAccountsChanged } from '../App.jsx'
import ContextualExplainer from '../help/ContextualExplainer.jsx'
import FeatureExplainer from '../help/FeatureExplainer.jsx'
import HelpHoverCard from '../help/HelpHoverCard.jsx'

// Sticky UI state for the dialog. Sort survives close/reopen so a user who prefers
// merchant-asc gets it on the next visit; panel geometry is restored if the user has dragged
// or resized the dialog. The active rule filter intentionally does NOT persist — opening the
// report should always start from the "All" view so the user sees every entry by default
// rather than landing on a stale filter from a previous session. The one exception is a caller that
// opens it *for* a kind of entry (`kindFilter`), and that is chosen per open, never remembered.
const UNIFIED_DUPLICATES_SORT_PREF_KEY = 'ui.unifiedDuplicates.sort'
const UNIFIED_DUPLICATES_PANEL_PREF_KEY = 'ui.unifiedDuplicates.panel'

const DEFAULT_SORT_STATE = { key: 'kind', dir: 'asc' }

// The "needs attention" kinds get their own quick-filter pills so the user can isolate them and
// bulk-select (filter → header select-all). Membership is the same question the Kind cell answers with
// amber: is anything being asked of the reader?
const REVIEW_KIND_PILLS = [
  { key: 'review', label: 'Review', topic: 'cross-account-duplicates' },
  { key: 'matched_near_date', label: 'Matched nearby date', topic: 'covered-range-review' },
  { key: 'no_match', label: 'No specific match', topic: 'covered-range-review' },
]

// Settled counterparts, rendered with 'Removed later' in the neutral group rather than beside the amber
// pills above. The coverage rule had already rejected these rows; the cross-account probes that named
// their match ran afterwards and changed no verdict, so there is nothing to accept, reject or confirm —
// only a population worth isolating when auditing what a file's rejections actually were.
const SETTLED_KIND_PILLS = [
  { key: 'matched_elsewhere', label: 'Matched another account', topic: 'covered-range-review' },
  { key: 'matched_transfer', label: 'Matched transfer', topic: 'covered-range-review' },
]

// Every settled filter shares one tone — the rule pills' blue rather than the review amber — so the group
// reads as "nothing is being asked of you" before any label is read.
const settledPillStyle = active => ({
  fontSize: 11, padding: '2px 10px', borderRadius: 99, cursor: 'pointer',
  background: active ? 'var(--accent2)' : 'color-mix(in srgb, var(--accent2) 10%, var(--surface2))',
  color: active ? 'white' : 'var(--accent2)',
  border: '1px solid color-mix(in srgb, var(--accent2) 40%, var(--border))',
  fontWeight: active ? 600 : 500,
})

// Soft flags need a Keep/Discard/Replace decision. Advisory coverage rejects (already rejected, never
// imported) carry a backend `review_substate`: 'matched_near_date' (a same-amount twin was found only on
// a nearby day, not the exact one — the row itself shows how many days) or 'no_match' (no twin anywhere).
// The backend clears the substate once the row is acknowledged (`reviewed`), so a reviewed row returns
// null for those two and drops out of the needs-attention pills.
//
// The settled cross-account kinds are read off the candidates instead (`isMatchedElsewhere` /
// `isMatchedTransfer`), for the same reason the Kind cell does: they describe what the row *is*, which an
// acknowledgement does not change, so they keep their filter after Mark reviewed.
// Whether an entry belongs to the active kind filter. 'removed' is the settled counterpart of the pills
// above: rows that landed in the ledger and were taken out later by a decision (Replace, Reject, a merge).
// They need no action, but they are what a file ledger's "Removed as duplicates" line sends the user to
// find, and they share the settled kind with import rejects that can outnumber them by thousands.
function matchesKindFilter(entry, key) {
  if (key === 'removed') return !!entry.removed
  return reviewKindOf(entry) === key
}

function reviewKindOf(entry) {
  if (entry.kind === 'soft_flag') return 'review'
  if (entry.review_substate === 'matched_near_date') return 'matched_near_date'
  if (entry.review_substate === 'no_match') return 'no_match'
  if (entry.kind === 'hard_reject' && isMatchedElsewhere(entry)) return 'matched_elsewhere'
  if (entry.kind === 'hard_reject' && isMatchedTransfer(entry)) return 'matched_transfer'
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

// Every side of an entry is summarized as "date · merchant · amount" — which is exactly the projection
// that hides *why* the pair matched, since the rules compare captured source text and two rows can match
// on a descriptor neither visible merchant shows. The backend attaches `origin` (the same captured-field
// shape a ledger row carries) to each side that names a transaction; this wraps the cell in the ledger's
// own hover card so the raw text, evidence fields, and originating connection are one hover away instead
// of a hunt through the register. Returns the node untouched when a side carries no captured detail.
const originHoverApplies = (origin) => !!origin && hasFileOriginDetail(origin)

function withOriginHover(node, origin) {
  if (!originHoverApplies(origin)) return node
  return (
    // The dwell matches the transaction list's — it keeps the card from strobing as rows scroll under
    // a resting cursor.
    <Tooltip content={<MerchantOriginHoverCard txn={origin} />} maxWidth={380} triggerStyle={{ minWidth: 0 }} openDelay={ROW_HOVER_OPEN_DELAY_MS}>
      <div>{node}</div>
    </Tooltip>
  )
}

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

export default function UnifiedDuplicatesDialog({
  entries = [],
  hardRejectCount = 0,
  removedCount = 0,
  softFlagCount = 0,
  ruleBreakdown = [],
  accountPairs = [],
  title = 'this import',
  batchId = '',
  accountFilter = null,
  onClearAccountFilter,
  kindFilter = null,
  openedWith = null,
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
  const [activeKindFilter, setActiveKindFilter] = useState(kindFilter)
  // Each open starts from what that open asked for. The dialog stays mounted when a second report is opened
  // over the first, so this follows the open (a new params object) rather than only the initial mount —
  // otherwise the ledger link would land on whatever filter the previous report was left showing.
  useEffect(() => {
    setActiveKindFilter(kindFilter)
    setActiveRuleFilter(null)
  }, [openedWith]) // eslint-disable-line react-hooks/exhaustive-deps -- keyed to the open, not to its fields
  const [sortState, setSortState] = useUserPreference(UNIFIED_DUPLICATES_SORT_PREF_KEY, DEFAULT_SORT_STATE)
  const [pendingBulk, setPendingBulk] = useState(false)
  const [actionError, setActionError] = useState('')
  // Pairs a just-issued Keep can still take back. Keep is permanent by design — the judgement is what
  // stops a later re-scan re-asking — so the moment of the decision is where the escape hatch belongs.
  const [keptUndo, setKeptUndo] = useState(null)

  // Collect the pairs out of the Keep responses. A Keep clears the pointer naming its partner, so the
  // response is the only place the pair still exists by the time this runs.
  function offerUndo(settled) {
    const pairs = settled
      .filter(r => r.status === 'fulfilled' && Array.isArray(r.value?.pair))
      .map(r => r.value.pair)
    setKeptUndo(pairs.length ? pairs : null)
  }

  async function undoKeeps() {
    const pairs = keptUndo
    setKeptUndo(null)
    if (!pairs) return
    try {
      await api.reopenDuplicatePairs(pairs)
      if (typeof onReload === 'function') await onReload()
    } catch (err) {
      setActionError(err?.message || 'Could not undo')
    }
  }
  // Pairs the user answered "Not now" to. Deliberately component state and not persisted: dismissing is
  // "leave me to it for now", not a durable preference, and the two real answers both remove the pair
  // from the server's list anyway. Re-asking on a later visit is fine — nothing was decided.
  const [dismissedPairs, setDismissedPairs] = useState(() => new Set())

  // The largest pair still awaiting an answer. `accountPairs` is already ordered by flag count, and only
  // the top one is offered: several prompts stacked above the list would compete for the same decision.
  const promptPair = useMemo(() => (
    (accountPairs || []).find(p => !dismissedPairs.has(`${p.account_id_low}:${p.account_id_high}`)) || null
  ), [accountPairs, dismissedPairs])

  function dismissPair(pair) {
    setDismissedPairs(prev => new Set(prev).add(`${pair.account_id_low}:${pair.account_id_high}`))
  }

  // Both answers are terminal and both settle every flag between the pair — that symmetry is the reason
  // the question can be asked once instead of per row. What they do differs, and deliberately so: mark
  // distinct clears every flag (if the accounts are different, all of them are false positives, whatever
  // the evidence was), while a merge auto-confirms only the *exact* matches as duplicates and leaves
  // near-misses for review, because within one account "similar" is a genuinely open question.
  async function resolvePair(pair, answer) {
    setActionError('')
    setPendingBulk(true)
    try {
      if (answer === 'merge') await api.attachAccount(pair.incoming.id, pair.matched.id)
      else await api.assertDistinctAccountPair(pair.incoming.id, pair.matched.id)
      // Accounts changed shape (a merge) or detection scope did (an assertion); either way every surface
      // keyed on accounts is now stale.
      notifyAccountsChanged()
    } catch (err) {
      setActionError(err?.message || 'Could not apply that answer')
    } finally {
      try {
        if (typeof onReload === 'function') await onReload()
      } catch { /* the reload's own error surfaces through the viewer */ }
      setPendingBulk(false)
    }
  }

  // When opened from an account's detail panel, scope the whole report to that account's rows so the
  // counts, filter chips, and list all reflect just what's relevant — the user lands on exactly the
  // duplicates that explain their empty account instead of scrolling the full batch.
  const scopedEntries = useMemo(() => (
    accountFilter?.id
      ? entries.filter(e => String(e.incoming?.account_id || '') === String(accountFilter.id))
      : entries
  ), [entries, accountFilter])

  const scopedRemovedCount = useMemo(() => scopedEntries.filter(e => e.removed).length, [scopedEntries])

  const reviewKindBreakdown = useMemo(() => {
    const counts = { review: 0, matched_near_date: 0, no_match: 0, matched_elsewhere: 0, matched_transfer: 0 }
    for (const e of scopedEntries) {
      const k = reviewKindOf(e)
      if (k) counts[k] += 1
    }
    return counts
  }, [scopedEntries])

  const settledKindTotal = SETTLED_KIND_PILLS.reduce((sum, k) => sum + (reviewKindBreakdown[k.key] || 0), 0)

  const visibleEntries = useMemo(() => {
    const filtered = activeKindFilter
      ? scopedEntries.filter(e => matchesKindFilter(e, activeKindFilter))
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
        setSelectedIds(new Set())
      } else if (action === 'enrich' || action === 'unenrich') {
        const rows = selected.map(e => e.incoming.row_number).filter(n => n != null)
        if (rows.length) {
          if (action === 'enrich') await api.enrichBatchDuplicates(batchId, rows)
          else await api.undoBatchDuplicateEnrichment(batchId, rows)
        }
        setSelectedIds(new Set())
      } else {
        // `selected` is already scoped to entries offering this action (`actionsFor`), so every one of
        // them yields a request — the map cannot produce a hole, which is what lets a result be paired
        // back to its entry by index below.
        const targets = selected
        const tasks = targets.map(entry => {
          if (action === 'restore')       return api.restoreRejectedDuplicate(entry.incoming.txn_id)
          if (action === 'import_anyway') return api.importBatchDuplicates(batchId, { row_numbers: [entry.incoming.row_number] })
          return api.resolveSuspectDuplicate(entry.incoming.txn_id, action)
        })
        // `allSettled`, not `all`: these are N independent requests and one refusal must not discard the
        // N−1 that worked. `all` rejected on the first failure, which skipped both the reload and the
        // selection clear below — so a bulk action that mostly succeeded left the dialog and the page's
        // pill counts showing the state from before it, and reported the whole thing as failed.
        const settled = await Promise.allSettled(tasks)
        const outcome = summarizeBulkOutcome(settled)
        if (outcome.error) setActionError(outcome.error)
        // A bulk Keep is one action to the user, so its Undo reverses all of it — the pairs are collected
        // from the responses because after a Keep the rows no longer say what they were judged against.
        if (action === 'keep') offerUndo(settled)
        // Only the rows that actually failed stay selected, so a retry re-sends exactly those rather than
        // re-issuing the ones that already succeeded.
        setSelectedIds(new Set(
          targets.filter((_, i) => outcome.failedIndexes.has(i)).map(entryId)
        ))
      }
    } catch (err) {
      setActionError(err?.message || 'Bulk action failed')
    } finally {
      // Unconditional, including after a failure: a partly-applied bulk is exactly the case where the
      // numbers on screen are least trustworthy, and this is what advances the viewer `version` that the
      // Import page watches to refresh its own counts.
      try {
        if (typeof onReload === 'function') await onReload()
      } catch { /* the reload's own error surfaces through the viewer */ }
      setPendingBulk(false)
    }
  }

  async function runSingle(entry, action) {
    setActionError('')
    setPendingBulk(true)
    try {
      if (action === 'keep')              offerUndo([{ status: 'fulfilled',
        value: await api.resolveSuspectDuplicate(entry.incoming.txn_id, 'keep') }])
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
    // `origin` feeds the hover, not the cell — keep it out of the record so the cell's contract stays
    // "what this row renders".
    const { origin, csv_values, ...record } = side
    // Only ONE of the two hovers may be attached. The cell renders `csv_values` as a native `title`,
    // and the origin card already shows everything that dump would (raw text, evidence extras such as
    // an "Original Statement" column, source file, imported category, source account label) — the rest
    // is the date and amount printed in the cell itself. Leaving both on stacked two tooltips over one
    // cell, the native one arriving a beat later on the browser's own dwell and vanishing on any
    // keypress. The cell keeps its fallback for the sides that carry no origin detail.
    const cellRecord = originHoverApplies(origin) ? record : { ...record, csv_values }
    return withOriginHover(
      <TransactionMatchCell record={{ ...cellRecord, source: sourceInfo || undefined }} onDrillThrough={onDrillThrough} />,
      origin,
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
      // A match found on another account gets its own marker, since it is not a same-account match and
      // the two flavours read differently: the same charge recorded elsewhere, or the opposite leg of one
      // movement. Asked through the shared predicates (wrapped as an entry) so the marker and the Kind
      // cell can never disagree about which one a row is.
      const crossAccountLabel = isMatchedElsewhere({ matched }) ? 'MATCHED ANOTHER ACCOUNT'
        : isMatchedTransfer({ matched }) ? 'MATCHED TRANSFER'
        : null
      const markerStyle = {
        display: 'inline-flex', alignItems: 'center', padding: '0 5px',
        borderRadius: 4, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.02em',
        background: 'color-mix(in srgb, var(--warning) 14%, var(--surface2))',
        color: 'var(--warning)', border: '1px solid color-mix(in srgb, var(--warning) 40%, var(--border))',
        marginRight: 4,
      }
      const noMatchMarker = <span style={markerStyle}>NO SPECIFIC MATCH</span>
      // Same chip shape as the markers above, in the neutral tone: a tier is supporting detail on a
      // candidate, not a state the row is in, so it must not compete with NO SPECIFIC MATCH for the eye.
      const candidateTierStyle = {
        ...markerStyle,
        marginRight: 0,
        fontWeight: 600,
        background: 'var(--surface2)',
        color: 'var(--muted)',
        border: '1px solid var(--border)',
      }
      // Settled, so it takes the neutral blue rather than NO SPECIFIC MATCH's amber.
      const crossAccountMarker = crossAccountLabel ? (
        <span style={{
          ...markerStyle,
          background: 'color-mix(in srgb, var(--accent2) 14%, var(--surface2))',
          color: 'var(--accent2)', border: '1px solid color-mix(in srgb, var(--accent2) 40%, var(--border))',
        }}>{crossAccountLabel}</span>
      ) : null
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, lineHeight: 1.3 }}>
          <div style={{ color: 'var(--muted)', fontSize: 11 }}>
            {candidates.length === 0 ? noMatchMarker : crossAccountMarker}
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
              {withOriginHover((
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
                  {/* How this row's wording agreed with the incoming one — the evidence that earned it a
                      place in the list, since past ±1 day a shared amount alone no longer qualifies a
                      candidate. Absent on a candidate matched on date evidence alone, which renders none. */}
                  {c.text_relation_label ? (
                    <span title={c.text_relation_description || ''} style={{ ...candidateTierStyle, marginLeft: 6 }}>
                      {c.text_relation_label}
                    </span>
                  ) : null}
                </div>
              ), c.origin)}
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
          ) : crossAccountLabel ? (
            <div style={{ color: 'var(--muted)', fontSize: 10.5, fontStyle: 'italic' }}>
              {isMatchedElsewhere({ matched })
                ? 'The same charge, in the same direction, is already recorded on another account, so this copy was not imported. Import anyway if the two are genuinely separate.'
                : 'An equal-and-opposite row naming this account sits on another one — the other leg of this movement, already in the ledger, so this leg was not re-imported. Import anyway if the two are genuinely separate.'}
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
        origin:              matched.origin,
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
        <div style={{ fontWeight: 600, fontSize: 15, display: 'flex', alignItems: 'center', gap: 8 }}>
          Duplicate detection report — {title}
          {onReload ? (
            <RefreshButton onRefresh={onReload} loading={loading} disabled={pendingBulk}
              onMouseDown={e => e.stopPropagation()} />
          ) : null}
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          {accountFilter?.id
            ? `${scopedEntries.length} duplicate${scopedEntries.length === 1 ? '' : 's'} for ${accountFilter.name}`
            : `${entries.length} total · ${hardRejectCount} rejected at import${removedCount ? ` · ${removedCount} removed later` : ''} · ${softFlagCount} flagged for review`}
        </div>
      </div>
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
        {kindFilter === 'removed' && activeKindFilter === 'removed' ? (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
            padding: '8px 16px', borderBottom: '1px solid var(--border)',
            background: 'color-mix(in srgb, var(--accent) 8%, var(--surface2))', fontSize: 12,
          }}>
            <span style={{ color: 'var(--muted)' }}>
              Showing only rows <strong style={{ color: 'var(--text)' }}>removed as duplicates after the import</strong>.
            </span>
            <button
              type="button"
              onClick={() => setActiveKindFilter(null)}
              onMouseDown={e => e.stopPropagation()}
              style={{
                background: 'none', border: 'none', padding: 0,
                color: 'var(--accent2)', cursor: 'pointer', fontSize: 12, textDecoration: 'underline',
              }}
            >
              Show all duplicates in this import
            </button>
          </div>
        ) : null}
        {/* One question that settles a whole pile, offered above the list rather than inside it: every
            flag in `pair` sits between the same two accounts, so "are these the same account?" resolves
            all of them at once whichever way it is answered. Only the largest outstanding pair is shown
            — stacking a prompt per pair would turn the answer to one into noise about the others. */}
        {promptPair ? (
          <div style={{ padding: '10px 16px 0' }}>
            <AccountIdentityPrompt
              pair={promptPair}
              busy={pendingBulk}
              onMerge={() => resolvePair(promptPair, 'merge')}
              onMarkDistinct={() => resolvePair(promptPair, 'distinct')}
              onDismiss={() => dismissPair(promptPair)}
            />
          </div>
        ) : null}
        <ContextualExplainer
          topic="duplicate-report"
          active={entries.length > 0}
          persistentButton={false}
          style={{ margin: '10px 16px 4px' }}
        />
        {(ruleBreakdown.length > 0 || reviewKindBreakdown.review || reviewKindBreakdown.matched_near_date || reviewKindBreakdown.no_match || settledKindTotal > 0 || scopedRemovedCount > 0) ? (
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
            {(reviewKindBreakdown.review || reviewKindBreakdown.matched_near_date || reviewKindBreakdown.no_match) ? (
              <span style={{ width: 1, alignSelf: 'stretch', margin: '0 2px', background: 'var(--border)' }} />
            ) : null}
            {REVIEW_KIND_PILLS.map(k => {
              const count = reviewKindBreakdown[k.key]
              if (!count) return null
              const active = activeKindFilter === k.key
              // Amber throughout: every pill in this group is a needs-attention kind, and the tone matches
              // the Kind cell's. The settled kinds render below in the neutral group instead.
              const accent = 'var(--warning)'
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
            {(settledKindTotal > 0 || scopedRemovedCount > 0) ? (
              <span style={{ width: 1, alignSelf: 'stretch', margin: '0 2px', background: 'var(--border)' }} />
            ) : null}
            {SETTLED_KIND_PILLS.map(k => {
              const count = reviewKindBreakdown[k.key]
              if (!count) return null
              const active = activeKindFilter === k.key
              return (
                <HelpHoverCard key={k.key} topic={k.topic}>
                  <button
                    type="button"
                    onClick={() => { setActiveKindFilter(active ? null : k.key); setActiveRuleFilter(null) }}
                    style={settledPillStyle(active)}
                  >
                    {k.label} ({count})
                  </button>
                </HelpHoverCard>
              )
            })}
            {scopedRemovedCount > 0 ? (
              <HelpHoverCard topic="removed-as-duplicates">
                <button
                  type="button"
                  onClick={() => { setActiveKindFilter(activeKindFilter === 'removed' ? null : 'removed'); setActiveRuleFilter(null) }}
                  style={settledPillStyle(activeKindFilter === 'removed')}
                >
                  Removed later ({scopedRemovedCount})
                </button>
              </HelpHoverCard>
            ) : null}
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
                  {a.keep ? <Button variant="ghost" style={COMPACT_ACTION_BTN_STYLE} disabled={pendingBulk} onClick={() => runSingle(entry, 'keep')} title="These are different transactions: keep both rows. Records the judgement for this pair only, so neither a later import nor a re-scan flags it again — undoable from the toast, and from the Dismissed filter afterwards.">Keep both</Button> : null}
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

      {keptUndo && (
        <UndoToast
          title={keptUndo.length === 1 ? 'Kept both' : `Kept both on ${keptUndo.length} pairs`}
          description="They won't be flagged as duplicates again."
          onUndo={undoKeeps}
          onDismiss={() => setKeptUndo(null)}
        />
      )}
    </DetailPanelShell>
  )
}
