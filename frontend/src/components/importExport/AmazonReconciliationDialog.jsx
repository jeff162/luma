// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useState } from 'react'
import { api } from '../../lib/api.js'
import { AppDialog, Button, Tooltip, COMPACT_ACTION_BTN_STYLE, ROW_HOVER_OPEN_DELAY_MS } from '../ui.jsx'
import { DetailPanelShell, useDetailPanelChrome, useRestorablePanelGeometry } from '../detailShared.jsx'
import { formatTransactionAmount } from '../../lib/moneyDisplay.js'
import { safeExternalUrl } from '../../lib/utils.js'
import { AMAZON_RECONCILIATION_COLUMNS_PREF_KEY } from '../../lib/importExport/constants.js'
import FeatureExplainer from '../../help/FeatureExplainer.jsx'
import { MerchantOriginHoverCard } from '../OriginFields.jsx'
import { MatchReport } from './MatchReport.jsx'
import { TransactionMatchCell } from './TransactionMatchCell.jsx'

// Panel geometry (drag/resize position + size) persists per user across opens, like the duplicate report.
const AMAZON_RECON_PANEL_PREF_KEY = 'ui.amazonReconciliation.panel'

// The Amazon reconciliation report for one import batch: how the imported orders line up with the card
// charges in the ledger. Buckets (see routers/import_export/amazon.amazon_reconciliation):
//   • matched            — an order and the card charge(s) it excluded (one, or several for a split order)
//   • matched_review     — an unmatched order whose total is covered by a unique set of unaccounted charges
//                          (a split shipment). Advisory: Accept links them, Dismiss keeps it no-charge-found.
//   • duplicate          — an order whose charge is duplicated (≥2 identical charges → ambiguous, so it
//                          couldn't auto-match). Carries every copy with a per-charge Trash: remove the
//                          redundant one (usually a double import) and the order matches the survivor.
//   • amazon_unmatched   — a cash order with no candidate charge at all (link charges to it by hand)
//   • payment_unmatched  — Amazon-looking ledger charges no order accounts for (heuristic reverse scan)
// It renders through the shared MatchReport table — the same visual format as the duplicate-detection
// report — with the buckets flattened into one kind-grouped list.

// A backend txn summary ({ id, date, amount, name, account, source }) → the record TransactionMatchCell wants.
function toRecord(txn) {
  if (!txn) return null
  return { date: txn.date, merchant: txn.name, amount: txn.amount, account_name: txn.account }
}

// A charge's cell, with the ledger's shared origin-fields card on hover (raw source text, source file +
// imported time, imported category, source account label, original description) — the full "where did this
// come from" detail, so near-identical Mint copies can be told apart. `txn` carries the origin fields the
// card reads (see _txn_summary / importSourceFields.js).
function withOriginHover(txn, child) {
  return (
    // `interactive` so the pointer can move into the card — its rows can carry a followable link
    // (an order's own Amazon page), which a close-on-leave tooltip would make unreachable. The dwell
    // keeps these cells from strobing a card at every row that scrolls under a resting cursor.
    <Tooltip content={<MerchantOriginHoverCard txn={txn} />} maxWidth={380} triggerStyle={{ minWidth: 0 }} interactive openDelay={ROW_HOVER_OPEN_DELAY_MS}>
      {child}
    </Tooltip>
  )
}

// The order's own page on Amazon, when the export captured it (evidence `source_url`). A thin digital
// order carries almost nothing else, so this is often the only route to the real detail — kept as a
// visible ↗ rather than hover-only so it takes one click. Resolved once per entry when the rows are
// built, not per render: parsing every order's evidence blob on each filter click / busy-state change
// would re-do the work for the whole report.
function orderSourceUrl(order) {
  try {
    const evidence = order?.import_evidence_json ? JSON.parse(order.import_evidence_json) : null
    // Scheme-checked: the URL came out of an imported file (see safeExternalUrl).
    return safeExternalUrl(evidence?.source_url)
  } catch {
    return null
  }
}

// The order cell: the same origin-detail hover the charge cells use (source file, captured fields,
// imported category), plus the ↗ to the order's Amazon page.
function OrderCell({ order, url }) {
  if (!order) return <TransactionMatchCell record={null} />
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        {withOriginHover(order, <div><TransactionMatchCell record={toRecord(order)} /></div>)}
      </div>
      {url ? (
        <a href={url} target="_blank" rel="noreferrer" title="Open this order on Amazon"
          style={{ flexShrink: 0, color: 'var(--accent2)', textDecoration: 'none', fontSize: 12 }}>↗</a>
      ) : null}
    </div>
  )
}

// Per-bucket presentation: display order, label, and the stripe/pill colour. The buckets that need
// attention lead (duplicate, no-charge-found, then the split-shipment suggestion), the informational
// unaccounted-charge bucket follows, and cleanly-matched rows sort last — problems first. `warn` marks the
// alarm buckets; `review` marks the advisory suggestion (coloured, but not an error).
const KIND_META = {
  duplicate: { rank: 0, label: 'Duplicate detected', stripe: '#ef4444', warn: true,
    help: "Two or more identical charges made this order ambiguous, so it couldn't auto-match — usually a double import (e.g. Mint). Trash the redundant copy and the order matches the one that remains; Not duplicates marks them distinct purchases instead (never re-flagged)." },
  duplicate_review: { rank: 1, label: 'Duplicate · review', stripe: '#fb7185', review: true,
    help: "Same-amount charges near this order, but outside the strict ±3-day match window — likely still a double import, but the dates don't corroborate it. Examine each copy (hover for its origin detail), then Merge, Discard, or Not duplicates — per row, or select the rows you've checked and bulk-Merge. A merged-away copy is restorable from Settings → Trash." },
  unmatched: { rank: 2, label: 'No charge found', stripe: '#f59e0b', warn: true,
    help: 'These orders are counted, but no matching charge was found to exclude — an untracked card, or a match we missed. Check your funding sources, or link the charges by hand from the unaccounted list.' },
  matched_review: { rank: 3, label: 'Matched · review', stripe: '#14b8a6', review: true,
    help: 'No single charge matched this order, but a set of unaccounted charges sums to its total — likely a split shipment. Review and Accept to link them (each is excluded), or Dismiss to keep it as no-charge-found.' },
  unaccounted_duplicate: { rank: 4, label: 'Unaccounted · duplicate', stripe: '#f472b6', review: true,
    help: "Unaccounted charges that look like copies of each other — same account and amount, days apart — with no order accounting for either: the double import the general dedupe can't catch. Check each copy's origin (hover), then Discard a copy, Merge → keep one (the survivor keeps the richest detail and returns to the unaccounted list), or Not duplicates. Merge works per row or in bulk on selected rows; a merged-away copy is restorable from Settings → Trash." },
  reverse: { rank: 5, label: 'Unaccounted charge', stripe: '#94a3b8',
    help: "Charges in your ledger that look like Amazon, on the cards Amazon uses, in this import's date range, that no imported order accounts for. Possibly purchases the export didn't cover — informational. Discard sends one to Trash, for a duplicate the report failed to pair." },
  matched: { rank: 6, label: 'Matched', stripe: 'var(--success, #22c55e)',
    help: 'Each order was linked to the card charge(s) it paid, and those are excluded from totals.' },
}

// One charge, with its full origin detail on hover.
function ChargeCell({ txn }) {
  if (!txn) return <TransactionMatchCell record={null} />
  return withOriginHover(txn, <div><TransactionMatchCell record={toRecord(txn)} /></div>)
}

// The card-charge cell for a duplicate group: every copy stacked, each with origin detail on hover and the
// linked one badged. The per-copy Discard sits beside its charge (the association matters — it picks which
// copy to keep). The group-level Merge action lives in the report's Actions column, not here. `flexShrink:0`
// on the badge/button keeps the narrow column from squeezing them when the charge text is long.
function DuplicateCharges({ charges, disabled, onDiscard }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {charges.map(c => (
        <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {withOriginHover(c, <div><TransactionMatchCell record={toRecord(c)} /></div>)}
          </div>
          {c.matched ? (
            <span title="Currently linked to this order" style={{ fontSize: 10, color: 'var(--success)', fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0 }}>linked</span>
          ) : null}
          <Button variant="ghost" disabled={disabled} onClick={() => onDiscard(c)} style={{ ...COMPACT_ACTION_BTN_STYLE, flexShrink: 0, whiteSpace: 'nowrap' }} title="Discard this copy — sends it to Trash and keeps the other">Discard</Button>
        </div>
      ))}
    </div>
  )
}

// A read-only vertical stack of charges (each with origin detail on hover) — the card-charge cell for a
// matched order (usually one charge, several for an accepted split) and for a Matched·review suggestion.
function ChargeStack({ charges }) {
  if (!charges || charges.length === 0) return <TransactionMatchCell record={null} />
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {charges.map(c => (
        <div key={c.id}>{withOriginHover(c, <div><TransactionMatchCell record={toRecord(c)} /></div>)}</div>
      ))}
    </div>
  )
}

// The manual multi-charge link window for a "No charge found" order: pick the card charge(s) that together
// paid for it (Amazon can bill one order as several shipment charges). Candidates are the unaccounted
// charges, sorted by date-proximity to the order; a live selected-sum is checked against the order total —
// a mismatch warns but doesn't block (real splits don't always reconcile to the penny).
function LinkChargesDialog({ order, candidates, busy, onCancel, onConfirm }) {
  const target = Math.abs(Number(order?.amount) || 0)
  const orderDay = order?.date
  const [selected, setSelected] = useState(() => new Set())
  const sorted = useMemo(() => {
    const diff = (d) => (orderDay && d ? Math.abs((new Date(d) - new Date(orderDay)) / 86400000) : 9e9)
    return [...candidates].sort((a, b) => diff(a.date) - diff(b.date))
  }, [candidates, orderDay])
  const sum = sorted.reduce((s, c) => s + (selected.has(c.id) ? Number(c.amount) || 0 : 0), 0)
  const matches = Math.abs(sum - target) <= 0.02
  const toggle = (id) => setSelected(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })
  return (
    <AppDialog
      title="Link charges to this order"
      description="Pick the card charge(s) that together paid for this order — Amazon sometimes splits an order into several shipment charges."
      width="min(640px, 100%)"
      onClose={onCancel}
      actions={(
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button onClick={() => onConfirm([...selected])} disabled={busy || selected.size === 0}>
            Link {selected.size || ''} charge{selected.size === 1 ? '' : 's'}
          </Button>
        </>
      )}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
        padding: '8px 12px', borderRadius: 8, background: 'var(--surface2)', fontSize: 13 }}>
        <span style={{ color: 'var(--muted)' }}>Order total <strong style={{ color: 'var(--text)' }}>{formatTransactionAmount(target)}</strong></span>
        <span style={{ color: matches ? 'var(--success)' : 'var(--warning)', fontWeight: 600 }}>
          Selected {formatTransactionAmount(sum)} {matches ? '✓' : `· ${formatTransactionAmount(sum - target)} off`}
        </span>
      </div>
      {!matches && selected.size > 0 ? (
        <div style={{ fontSize: 11, color: 'var(--warning)', marginTop: 6 }}>
          The selection doesn&apos;t match the order total — you can still link it.
        </div>
      ) : null}
      <div style={{ marginTop: 12, maxHeight: '46vh', overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
        {sorted.length === 0 ? (
          <div style={{ padding: 16, color: 'var(--muted)', fontSize: 13 }}>No unaccounted charges to link.</div>
        ) : sorted.map(c => (
          <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
            borderBottom: '1px solid color-mix(in srgb, var(--border) 60%, transparent)', cursor: 'pointer', fontSize: 13 }}>
            <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
            <span style={{ width: 88, color: 'var(--muted)', flexShrink: 0 }}>{c.date}</span>
            <span style={{ width: 88, textAlign: 'right', flexShrink: 0 }}>{formatTransactionAmount(c.amount)}</span>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--muted)' }}>
              {c.account}{c.name ? ` · ${c.name}` : ''}
            </span>
          </label>
        ))}
      </div>
    </AppDialog>
  )
}

// The bulk-eligible actions for one row — the basis of the bulk bar's intersection (a button shows a count
// and enables only when some selected row offers it). Merge is offered only for a *mergeable* duplicate
// (no other unmatched order shares its amount — see the backend `mergeable` flag); the per-copy Discard and
// the manual Link need per-item choices, so they aren't bulk actions.
// A row's bulk-eligible actions. Only row-level ones qualify: the per-copy Discard on a multi-charge row
// names *which* copy to remove, so it has no unambiguous bulk form (its bulk equivalent is Merge). The
// single-charge `reverse` row's button is row-level — hence "Trash" rather than "Discard" — so it does.
function rowActionsFor(entry) {
  if (entry.kind === 'duplicate' || entry.kind === 'duplicate_review') return entry.mergeable ? { merge: true } : {}
  if (entry.kind === 'unaccounted_duplicate') return { merge: true }
  if (entry.kind === 'matched_review') return { accept: true, dismiss: true }
  if (entry.kind === 'matched') return { unlink: true }
  if (entry.kind === 'reverse') return { trash: true }
  return {}
}

// Data (the reconciliation payload), loading/error, and reload are owned by
// AmazonReconciliationViewerContext so the report survives route changes; this component is
// presentational + makes the per-row resolution API calls, then asks the context to reload.
export function AmazonReconciliationDialog({
  data,
  loading = false,
  error = '',
  onClose,
  onReload,
  onMinimize,
  stackIndex = 0,
  isTopmost = true,
}) {
  const [linkTarget, setLinkTarget] = useState(null)   // the unmatched entry whose "Link charges…" window is open
  const [linking, setLinking] = useState(false)
  const [busyTrash, setBusyTrash] = useState(false)
  const [activeKind, setActiveKind] = useState(null)   // null = All; otherwise a KIND_META key
  const [actionError, setActionError] = useState('')   // a failed per-row / bulk action
  const [selectedIds, setSelectedIds] = useState(() => new Set())   // bulk-select row ids
  const [pendingBulk, setPendingBulk] = useState(false)

  // Floating, draggable, resizable panel chrome — non-modal so the user can go inspect a
  // transaction while the report stays open; geometry persists across opens.
  const { initialPosition, initialSize, onGestureEnd } = useRestorablePanelGeometry(
    AMAZON_RECON_PANEL_PREF_KEY, { fallbackWidth: 1040, fallbackHeight: 680 })
  const { pos, size, panelRef, onDragStart, onResizeStart } = useDetailPanelChrome(onClose, {
    forceFloating: true, stackIndex, initialPosition, initialSize, onGestureEnd,
  })

  const { matched, matchedReview, duplicate, duplicateReview, amazonUnmatched, paymentUnmatched, unaccountedDuplicate } = useMemo(() => ({
    matched: data?.matched || [],
    matchedReview: data?.matched_review || [],
    duplicate: data?.duplicate || [],
    duplicateReview: data?.duplicate_review || [],
    amazonUnmatched: data?.amazon_unmatched || [],
    paymentUnmatched: data?.payment_unmatched || [],
    unaccountedDuplicate: data?.unaccounted_duplicate || [],
  }), [data])

  // Flatten the buckets into one kind-grouped entry list for MatchReport.
  const entries = useMemo(() => {
    const entryDate = (e) => (e.order || e.charges?.[0] || e.charge)?.date || ''
    const rows = [
      ...matched.map(m => ({ id: `m:${m.link_id}`, kind: 'matched', linkId: m.link_id, order: m.order, orderUrl: orderSourceUrl(m.order), charges: m.charges || [] })),
      ...matchedReview.map(r => ({ id: `r:${r.link_id}`, kind: 'matched_review', linkId: r.link_id, order: r.order, orderUrl: orderSourceUrl(r.order), charges: r.charges || [], total: r.total, spansDays: r.spans_days, reason: r.reason })),
      ...duplicate.map(d => ({ id: `d:${d.link_id}`, kind: 'duplicate', linkId: d.link_id, order: d.order, orderUrl: orderSourceUrl(d.order), charges: d.charges, mergeable: d.mergeable })),
      ...duplicateReview.map(d => ({ id: `dr:${d.link_id}`, kind: 'duplicate_review', linkId: d.link_id, order: d.order, orderUrl: orderSourceUrl(d.order), charges: d.charges, mergeable: d.mergeable })),
      ...amazonUnmatched.map(m => ({ id: `u:${m.link_id}`, kind: 'unmatched', linkId: m.link_id, order: m.order, orderUrl: orderSourceUrl(m.order), charges: null })),
      ...paymentUnmatched.map(t => ({ id: `p:${t.id}`, kind: 'reverse', linkId: null, order: null, charge: t })),
      ...unaccountedDuplicate.map(g => ({ id: `ud:${g.charges[0]?.id}`, kind: 'unaccounted_duplicate', linkId: null, order: null, charges: g.charges })),
    ]
    return rows.sort((a, b) =>
      (KIND_META[a.kind].rank - KIND_META[b.kind].rank)
      || String(entryDate(a)).localeCompare(String(entryDate(b))))
  }, [matched, matchedReview, duplicate, duplicateReview, amazonUnmatched, paymentUnmatched, unaccountedDuplicate])

  const visibleEntries = useMemo(
    () => (activeKind ? entries.filter(e => e.kind === activeKind) : entries),
    [entries, activeKind])

  const busy = linking || busyTrash || pendingBulk

  // Bulk selection (checkbox column + select-all), driving the bulk-action bar below the filter pills.
  const allVisibleSelected = visibleEntries.length > 0 && visibleEntries.every(e => selectedIds.has(e.id))
  const someVisibleSelected = !allVisibleSelected && visibleEntries.some(e => selectedIds.has(e.id))
  const toggleEntry = (entry) => setSelectedIds(prev => {
    const next = new Set(prev)
    next.has(entry.id) ? next.delete(entry.id) : next.add(entry.id)
    return next
  })
  const toggleSelectAllVisible = () => setSelectedIds(prev => {
    const next = new Set(prev)
    if (visibleEntries.every(e => prev.has(e.id))) visibleEntries.forEach(e => next.delete(e.id))
    else visibleEntries.forEach(e => next.add(e.id))
    return next
  })
  // The intersection of bulk actions across the selected rows — each button shows its applicable count.
  const selectionSummary = useMemo(() => {
    const s = { total: 0, merge: 0, accept: 0, dismiss: 0, unlink: 0, trash: 0 }
    for (const e of visibleEntries) {
      if (!selectedIds.has(e.id)) continue
      s.total += 1
      const a = rowActionsFor(e)
      if (a.merge) s.merge += 1
      if (a.accept) s.accept += 1
      if (a.dismiss) s.dismiss += 1
      if (a.unlink) s.unlink += 1
      if (a.trash) s.trash += 1
    }
    return s
  }, [visibleEntries, selectedIds])

  // Accept a Matched·review suggestion: link its whole suggested set of charges (each is excluded).
  const acceptSuggestion = async (entry) => {
    setBusyTrash(true)
    setActionError('')
    try {
      await api.linkAmazonCharges({ link_id: entry.linkId, charge_txn_ids: (entry.charges || []).map(c => c.id) })
      onReload?.()
    } catch (e) {
      setActionError(e?.message || 'Could not link the charges')
    } finally {
      setBusyTrash(false)
    }
  }

  const dismissSuggestion = async (entry) => {
    setBusyTrash(true)
    setActionError('')
    try {
      await api.dismissAmazonSplitSuggestion({ link_id: entry.linkId })
      onReload?.()
    } catch (e) {
      setActionError(e?.message || 'Could not dismiss the suggestion')
    } finally {
      setBusyTrash(false)
    }
  }

  // Confirm the manual "Link charges…" window: link the user-picked set to the open order.
  const confirmLinkCharges = async (chargeIds) => {
    if (!linkTarget || !chargeIds.length) return
    setLinking(true)
    setActionError('')
    try {
      await api.linkAmazonCharges({ link_id: linkTarget.linkId, charge_txn_ids: chargeIds })
      setLinkTarget(null)
      onReload?.()
    } catch (e) {
      setActionError(e?.message || 'Could not link the charges')
    } finally {
      setLinking(false)
    }
  }

  const discardCharge = async (charge, entry) => {
    setBusyTrash(true)
    setActionError('')
    try {
      await api.trashAmazonDuplicateCharge({
        charge_txn_id: charge.id,
        order_link_id: entry.linkId || null,
        // A reverse row's Trash is an ordinary delete ("this shouldn't be here at all"), not a dedupe
        // resolution — so it files under the Trash page's Deleted transactions. The per-copy Discard on
        // a stacked duplicate row is a dedupe resolution and keeps that provenance.
        as_duplicate: entry.kind !== 'reverse',
      })
      onReload?.()
    } catch (e) {
      setActionError(e?.message || 'Could not discard the charge')
    } finally {
      setBusyTrash(false)
    }
  }

  // "Not duplicates" on any duplicate group: persist the distinct-purchases assertion (every pair in
  // the group, including a linked copy) so the report never re-flags them. An unaccounted group's
  // copies return to the informational list; an order-anchored group's order falls back to the
  // unmatched path, where the exact-date tie-break may still nominate one charge for review.
  const markNotDuplicates = async (entry) => {
    setBusyTrash(true)
    setActionError('')
    try {
      await api.markAmazonChargesNotDuplicates({ charge_txn_ids: entry.charges.map(c => c.id) })
      onReload?.()
    } catch (e) {
      setActionError(e?.message || 'Could not mark the charges as distinct')
    } finally {
      setBusyTrash(false)
    }
  }

  // The kind-appropriate merge call for a duplicate-family entry: orderless groups send their explicit
  // charge ids (the server re-validates them); a review-window group merges the exact ±14-day copy set
  // its row displayed (see the endpoint); a plain duplicate derives at the matcher's ±3. Shared by the
  // per-row Merge button and the bulk bar.
  const mergeCallFor = (entry) => (
    entry.kind === 'unaccounted_duplicate'
      ? api.mergeUnaccountedAmazonCharges({ charge_txn_ids: entry.charges.map(c => c.id) })
      : api.mergeAmazonDuplicateCharges({ order_link_id: entry.linkId, review_window: entry.kind === 'duplicate_review' })
  )

  // Undo a wrong pairing: detach the order's charge(s) (their categories are restored) so the order
  // returns to the unmatched path, where Link charges… can pair it correctly.
  const unlinkCharges = async (entry) => {
    setBusyTrash(true)
    setActionError('')
    try {
      await api.unlinkAmazonOrderCharges({ order_link_id: entry.linkId })
      onReload?.()
    } catch (e) {
      setActionError(e?.message || 'Could not unlink the charges')
    } finally {
      setBusyTrash(false)
    }
  }

  const mergeGroup = async (entry) => {
    setBusyTrash(true)
    setActionError('')
    try {
      await mergeCallFor(entry)
      onReload?.()
    } catch (e) {
      setActionError(e?.message || 'Could not merge the charges')
    } finally {
      setBusyTrash(false)
    }
  }

  // Apply one action to every selected row that offers it. Because Merge is only offered on *mergeable*
  // rows (see rowActionsFor; orderless groups validate per-group server-side and have no cross-row
  // guard to trip), the calls can't hit the same-amount guard, so a plain Promise.all is safe.
  const runBulk = async (action) => {
    const selected = visibleEntries.filter(e => selectedIds.has(e.id) && rowActionsFor(e)[action])
    if (!selected.length) return
    setPendingBulk(true)
    setActionError('')
    try {
      await Promise.all(selected.map(entry => {
        if (action === 'merge') return mergeCallFor(entry)
        if (action === 'accept') return api.linkAmazonCharges({ link_id: entry.linkId, charge_txn_ids: (entry.charges || []).map(c => c.id) })
        if (action === 'dismiss') return api.dismissAmazonSplitSuggestion({ link_id: entry.linkId })
        if (action === 'unlink') return api.unlinkAmazonOrderCharges({ order_link_id: entry.linkId })
        // A reverse-scan row owns exactly one charge and no order link, so trashing it is independent
        // of every other selected row (no re-pairing pass runs) — safe to fire in parallel.
        if (action === 'trash') return api.trashAmazonDuplicateCharge({ charge_txn_id: entry.charge?.id, order_link_id: null, as_duplicate: false })
        return null
      }).filter(Boolean))
      setSelectedIds(new Set())
      await onReload?.()
    } catch (e) {
      setActionError(e?.message || 'Bulk action failed')
    } finally {
      setPendingBulk(false)
    }
  }

  // Filter pills, in bucket order: an "All" pill then one per non-empty kind (colour-coded to its stripe),
  // mirroring the duplicate report's Show:/All/kind-pill row.
  const kindPills = [
    { kind: 'duplicate', count: duplicate.length },
    { kind: 'duplicate_review', count: duplicateReview.length },
    { kind: 'unmatched', count: amazonUnmatched.length },
    { kind: 'matched_review', count: matchedReview.length },
    { kind: 'unaccounted_duplicate', count: unaccountedDuplicate.length },
    { kind: 'reverse', count: paymentUnmatched.length },
    { kind: 'matched', count: matched.length },
  ].filter(p => p.count > 0)

  const columns = [
    { key: 'kind', label: 'Kind', width: 150, render: (entry) => {
      const meta = KIND_META[entry.kind]
      const color = meta.warn ? 'var(--warning, #f59e0b)' : meta.review ? meta.stripe : 'var(--muted)'
      return (
        <span style={{ whiteSpace: 'nowrap', color, fontWeight: meta.warn || meta.review ? 600 : 400 }} title={meta.help}>
          {meta.label}
        </span>
      )
    } },
    { key: 'order', label: 'Amazon order', width: 330, render: (entry) => <OrderCell order={entry.order} url={entry.orderUrl} /> },
    { key: 'charge', label: 'Card charge', width: 320, render: (entry) => {
      if (entry.kind === 'duplicate' || entry.kind === 'duplicate_review' || entry.kind === 'unaccounted_duplicate') {
        const note = entry.kind === 'duplicate_review'
          ? 'Outside the ±3-day auto-match window — check each copy’s origin before resolving.'
          : entry.kind === 'unaccounted_duplicate'
            ? 'Same account & amount days apart, no order for either — check each copy’s origin before resolving.'
            : null
        return (
          <div>
            <DuplicateCharges charges={entry.charges} disabled={busy} onDiscard={(c) => discardCharge(c, entry)} />
            {note ? (
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, fontStyle: 'italic' }}>{note}</div>
            ) : null}
          </div>
        )
      }
      if (entry.kind === 'matched' || entry.kind === 'matched_review') {
        return (
          <div>
            <ChargeStack charges={entry.charges} />
            {entry.kind === 'matched_review' ? (
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                {entry.charges.length} charge{entry.charges.length === 1 ? '' : 's'} · sums to {formatTransactionAmount(entry.total)}
                {entry.spansDays > 7 ? <span style={{ color: 'var(--warning)', fontWeight: 600 }}> · {entry.spansDays} days apart</span> : null}
                {/* Single-charge suggestions look like a match that "should have just worked" — say why it didn't. */}
                {entry.reason ? <div style={{ marginTop: 2, fontStyle: 'italic' }}>{entry.reason}</div> : null}
              </div>
            ) : null}
          </div>
        )
      }
      return <ChargeCell txn={entry.charge} />
    } },
    { key: 'action', label: 'Actions', width: 240, sortable: false, render: (entry) => {
      // The duplicate group's recommended one-click resolution: keep the richest copy, fold in the
      // others' detail, trash the rest. It lives here (the right-edge Actions column) rather than under
      // the stacked charges, so it reads as the row-level action and doesn't sit beneath the charge text.
      if (entry.kind === 'unaccounted_duplicate') {
        return (
          <div style={{ display: 'flex', gap: 6 }}>
            <Button small variant="ghost" disabled={busy} onClick={() => mergeGroup(entry)} title="Merge into one: keep the richest copy, fold in any detail the others have, and trash the rest — the survivor stays in the unaccounted list">
              Merge → keep one
            </Button>
            <Button small variant="ghost" disabled={busy} onClick={() => markNotDuplicates(entry)} title="These are distinct purchases — keep every copy and never flag this group again">
              Not duplicates
            </Button>
          </div>
        )
      }
      if (entry.kind === 'reverse') {
        // The escape hatch for a duplicate the grouping failed to pair. Labelled "Trash" rather than
        // "Discard" because it acts on the whole row (this row owns one charge), which is also what makes
        // it bulk-able — unlike the per-copy Discard on a stacked duplicate row, which names one copy.
        return (
          <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
            <Button small variant="ghost" disabled={busy} onClick={() => discardCharge(entry.charge, entry)}
              title="Send this charge to Trash — for a duplicate copy the report failed to pair up (recoverable from Settings → Trash)">
              Trash
            </Button>
          </div>
        )
      }
      if (entry.kind === 'duplicate' || entry.kind === 'duplicate_review') {
        // "Not duplicates" persists the distinct-purchases verdict: the duplicate row disappears and the
        // order falls back to the unmatched path. Merge is only offered where it would succeed — a lone
        // order at this amount whose extra charges are redundant copies; when other unmatched orders
        // share the amount the copies look like distinct purchases (merge would steal a charge), so
        // Not duplicates is the row's primary resolution there.
        const notDuplicates = (
          <Button small variant="ghost" disabled={busy} onClick={() => markNotDuplicates(entry)}
            title="These are distinct purchases, not copies — keep them all and never flag this group again. The order returns to the unmatched path for linking (a charge dated on the order is re-suggested for review).">
            Not duplicates
          </Button>
        )
        return (
          <div style={{ display: 'flex', gap: 6 }}>
            {entry.mergeable ? (
              <Button small variant="ghost" disabled={busy} onClick={() => mergeGroup(entry)} title="Merge into one: keep the richest copy, fold in any detail the others have, and trash the rest">
                Merge → keep one
              </Button>
            ) : null}
            {notDuplicates}
          </div>
        )
      }
      if (entry.kind === 'matched_review') {
        return (
          <div style={{ display: 'flex', gap: 6 }}>
            <Button small variant="ghost" disabled={busy} onClick={() => acceptSuggestion(entry)} title="Link these charges to the order — each is excluded from totals">Accept</Button>
            <Button small variant="ghost" disabled={busy} onClick={() => dismissSuggestion(entry)} title="Not a match — keep this order as no-charge-found and stop suggesting it">Dismiss</Button>
          </div>
        )
      }
      // A matched row can be wrong (a coincidental same-amount charge, or an accepted suggestion that
      // turned out not to be this order's). Unlink detaches the charge(s), restores their categories,
      // and drops the order back to "No charge found" where Link charges… can pair it correctly.
      if (entry.kind === 'matched') {
        return (
          <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
            <Button small variant="ghost" disabled={busy} onClick={() => unlinkCharges(entry)}
              title="Not this order's charge — detach it (its category is restored) and put the order back to needing a match">
              Unlink
            </Button>
          </div>
        )
      }
      if (entry.kind !== 'unmatched') return null
      return (
        <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
          <Button small variant="ghost" disabled={busy || !paymentUnmatched.length} onClick={() => setLinkTarget(entry)}
            title={paymentUnmatched.length ? 'Pick the card charge(s) that paid for this order' : 'No unaccounted charges to link'}>
            Link charges…
          </Button>
        </div>
      )
    } },
  ]

  const busyOrLoading = busy || loading
  const chromeButtonStyle = {
    background: 'var(--surface2)', border: '1px solid var(--border)',
    borderRadius: 6, padding: '4px 10px', cursor: 'pointer', color: 'var(--muted)', fontSize: 13,
  }
  const dialogHeader = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1 }}>
      <span onMouseDown={e => e.stopPropagation()} style={{ display: 'inline-flex', flexShrink: 0 }}>
        <FeatureExplainer topic="amazon-reconciliation" placement="bottom-left" />
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: 15 }}>Amazon reconciliation</div>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          How this import&apos;s orders line up with the card charges in your ledger.
        </div>
      </div>
      {onReload ? (
        <button type="button" title="Refresh" disabled={busyOrLoading} onClick={onReload}
          onMouseDown={e => e.stopPropagation()} style={chromeButtonStyle}>↻ Refresh</button>
      ) : null}
      {onMinimize ? (
        <button type="button" title="Minimize to nav bar (state is preserved — click the pill to restore)"
          onClick={onMinimize} onMouseDown={e => e.stopPropagation()} style={chromeButtonStyle}>– Minimize</button>
      ) : null}
    </div>
  )

  return (
    <>
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
        <div style={{
          display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap',
          padding: '8px 16px', borderBottom: '1px solid var(--border)',
        }}>
          <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>Show:</span>
          <button
            type="button"
            onClick={() => setActiveKind(null)}
            style={{
              fontSize: 11, padding: '2px 10px', borderRadius: 99, cursor: 'pointer', flexShrink: 0,
              background: activeKind === null ? 'var(--accent)' : 'var(--surface2)',
              color: activeKind === null ? 'white' : 'var(--muted)',
              border: '1px solid var(--border)',
            }}
          >
            All ({entries.length})
          </button>
          {kindPills.map(({ kind, count }) => {
            const meta = KIND_META[kind]
            const active = activeKind === kind
            const accent = meta.stripe
            return (
              <button
                key={kind}
                type="button"
                title={meta.help}
                onClick={() => setActiveKind(active ? null : kind)}
                style={{
                  fontSize: 11, padding: '2px 10px', borderRadius: 99, cursor: 'pointer', flexShrink: 0,
                  background: active ? accent : `color-mix(in srgb, ${accent} 12%, var(--surface2))`,
                  color: active ? 'white' : `color-mix(in srgb, ${accent} 75%, var(--text))`,
                  border: `1px solid color-mix(in srgb, ${accent} 45%, var(--border))`,
                  fontWeight: active ? 600 : 500,
                }}
              >
                {meta.label} ({count})
              </button>
            )
          })}
        </div>
        {selectionSummary.total > 0 ? (
          <div style={{
            display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap',
            padding: '6px 16px', borderBottom: '1px solid var(--border)',
            background: 'color-mix(in srgb, var(--accent) 7%, var(--surface2))',
          }}>
            <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>{selectionSummary.total} selected:</span>
            <Button small variant="ghost" style={COMPACT_ACTION_BTN_STYLE} disabled={pendingBulk || selectionSummary.merge === 0}
              onClick={() => runBulk('merge')} title="Merge each selected duplicate into one — keep the richest copy, trash the rest">
              Merge → keep one ({selectionSummary.merge})
            </Button>
            <Button small variant="ghost" style={COMPACT_ACTION_BTN_STYLE} disabled={pendingBulk || selectionSummary.accept === 0}
              onClick={() => runBulk('accept')} title="Link each selected split suggestion's charges to its order">
              Accept ({selectionSummary.accept})
            </Button>
            <Button small variant="ghost" style={COMPACT_ACTION_BTN_STYLE} disabled={pendingBulk || selectionSummary.dismiss === 0}
              onClick={() => runBulk('dismiss')} title="Dismiss each selected split suggestion">
              Dismiss ({selectionSummary.dismiss})
            </Button>
            <Button small variant="ghost" style={COMPACT_ACTION_BTN_STYLE} disabled={pendingBulk || selectionSummary.unlink === 0}
              onClick={() => runBulk('unlink')} title="Detach each selected matched order's charge(s) — their categories are restored and the orders return to needing a match">
              Unlink ({selectionSummary.unlink})
            </Button>
            <Button small variant="ghost" style={COMPACT_ACTION_BTN_STYLE} disabled={pendingBulk || selectionSummary.trash === 0}
              onClick={() => runBulk('trash')} title="Send each selected unaccounted charge to Trash (recoverable from Settings → Trash)">
              Move to trash ({selectionSummary.trash})
            </Button>
            <span style={{ flex: 1 }} />
            <Button small variant="ghost" style={COMPACT_ACTION_BTN_STYLE} disabled={pendingBulk} onClick={() => setSelectedIds(new Set())}>
              Clear
            </Button>
          </div>
        ) : null}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <MatchReport
            columnsPrefKey={AMAZON_RECONCILIATION_COLUMNS_PREF_KEY}
            columns={columns}
            entries={visibleEntries}
            getRowId={(entry) => entry.id}
            getRowStripe={(entry) => KIND_META[entry.kind].stripe}
            selectable
            selectedIds={selectedIds}
            onToggleRow={toggleEntry}
            onToggleAll={toggleSelectAllVisible}
            allVisibleSelected={allVisibleSelected}
            someVisibleSelected={someVisibleSelected}
            loading={loading}
            error={error || actionError}
            emptyMessage={entries.length === 0 ? 'Nothing to reconcile for this import.' : 'No rows for this filter.'}
          />
        </div>
      </div>
    </DetailPanelShell>
    {linkTarget ? (
      <LinkChargesDialog
        order={linkTarget.order}
        candidates={paymentUnmatched}
        busy={linking}
        onCancel={() => setLinkTarget(null)}
        onConfirm={confirmLinkCharges}
      />
    ) : null}
    </>
  )
}
