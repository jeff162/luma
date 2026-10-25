// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- a vendor module exports its config; the cells it renders are private to it */

import { useState } from 'react'
import { api } from '../../../lib/api.js'
import { Button, Tooltip } from '../../ui.jsx'
import SplitEditorDialog from '../../SplitEditorDialog.jsx'
import { formatTransactionAmount } from '../../../lib/moneyDisplay.js'
import { safeExternalUrl } from '../../../lib/utils.js'
import { AMAZON_RECONCILIATION_COLUMNS_PREF_KEY } from '../../../lib/importExport/constants.js'
import { TxnCell, TxnStack } from './reconciliationCells.jsx'

// The Amazon reconciliation report for one import batch: how the imported orders line up with the card
// charges in the ledger. Buckets (see routers/import_export/amazon.amazon_reconciliation):
//   • matched            — an order and the card charge(s) it excluded (one, or several for a split order)
//   • matched_review     — an unmatched order whose total is covered by a unique set of unaccounted charges
//                          (a split shipment). Advisory: Accept links them, Dismiss keeps it no-charge-found.
//   • duplicate          — an order whose charge is duplicated (≥2 identical charges → ambiguous, so it
//                          couldn't auto-match). Carries every copy with a per-charge Trash: remove the
//                          redundant one (usually a double import) and the order matches the survivor.
//   • amazon_unmatched   — a cash order with no candidate charge at all (link charges by hand, or Mark
//                          reviewed to acknowledge an untracked card so it leaves the attention count)
//   • payment_unmatched  — Amazon-looking ledger charges no order accounts for (heuristic reverse scan);
//                          Trash a stray, or Mark reviewed to acknowledge one so it leaves the attention count
// It is one vendor of the shared reconciliation shell (ReconciliationReportDialog), which renders these
// buckets flattened into one kind-grouped list.

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
  if (!order) return <TxnCell txn={null} />
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <TxnCell txn={order} />
      </div>
      {url ? (
        <a href={url} target="_blank" rel="noreferrer" title="Open this order on Amazon"
          style={{ flexShrink: 0, color: 'var(--accent2)', textDecoration: 'none', fontSize: 12 }}>↗</a>
      ) : null}
    </div>
  )
}

// Per-bucket presentation. The buckets that need attention lead (duplicate, no-charge-found, then the
// split-shipment suggestion), the informational unaccounted-charge bucket follows, and cleanly-matched rows
// sort last — problems first. `warn` marks the alarm buckets; `review` marks the advisory suggestion
// (coloured, but not an error).
const KINDS = {
  duplicate: { rank: 0, label: 'Duplicate detected', stripe: '#ef4444', warn: true,
    help: "Two or more identical charges made this order ambiguous, so it couldn't auto-match — usually a double import (e.g. Mint). Trash the redundant copy and the order matches the one that remains; Not duplicates marks them distinct purchases instead (never re-flagged)." },
  duplicate_review: { rank: 1, label: 'Duplicate · review', stripe: '#fb7185', review: true,
    help: "Same-amount charges near this order, but outside the strict ±3-day match window — likely still a double import, but the dates don't corroborate it. Examine each copy (hover for its origin detail), then Merge, Discard, or Not duplicates — per row, or select the rows you've checked and bulk-Merge. A merged-away copy is restorable from Settings → Trash." },
  unmatched: { rank: 2, label: 'No charge found', stripe: '#f59e0b', warn: true,
    help: "These orders are counted, but no matching charge was found to exclude — an untracked card, or a match we missed. Check your funding sources, or link the charges by hand from the unaccounted list. If there's genuinely nothing to link (an untracked card), Mark reviewed acknowledges it — it stays here but drops out of the attention count so it won't nag." },
  matched_review: { rank: 3, label: 'Matched · review', stripe: '#14b8a6', review: true,
    help: 'No single charge matched this order, but a set of unaccounted charges sums to its total — likely a split shipment. Review and Accept to link them (each is excluded), or Dismiss to keep it as no-charge-found.' },
  unaccounted_duplicate: { rank: 4, label: 'Unaccounted · duplicate', stripe: '#f472b6', review: true,
    help: "Unaccounted charges that look like copies of each other — same account and amount, days apart — with no order accounting for either: the double import the general dedupe can't catch. Check each copy's origin (hover), then Discard a copy, Merge → keep one (the survivor keeps the richest detail and returns to the unaccounted list), or Not duplicates. Merge works per row or in bulk on selected rows; a merged-away copy is restorable from Settings → Trash." },
  reverse: { rank: 5, label: 'Unaccounted charge', stripe: '#94a3b8', warn: true,
    help: "Charges in your ledger that look like Amazon, on the cards Amazon uses, in this import's date range, that no imported order accounts for. Possibly purchases the export didn't cover. These count toward the needs-attention total so a stray one (e.g. an unpaired duplicate) gets a look; Trash sends one to Trash (for a duplicate the report failed to pair), or Mark reviewed acknowledges a legitimately-uncovered charge so it drops out of the count without trashing it (Undo puts it back)." },
  matched: { rank: 6, label: 'Matched', stripe: 'var(--success, #22c55e)',
    help: 'Each order was linked to the card charge(s) it paid, and those are excluded from totals.' },
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
            <TxnCell txn={c} />
          </div>
          {c.matched ? (
            <span title="Currently linked to this order" style={{ fontSize: 10, color: 'var(--success)', fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0 }}>linked</span>
          ) : null}
          <Button variant="secondary" disabled={disabled} onClick={() => onDiscard(c)} size="compact" style={{ flexShrink: 0, whiteSpace: 'nowrap' }} title="Discard this copy — sends it to Trash and keeps the other">Discard</Button>
        </div>
      ))}
    </div>
  )
}

// The per-row way into the split editor. Named for the row's state, like the row menu's equivalent:
// an order already split is being adjusted, not divided again. Offered on the two kinds where the
// order is settled enough that classifying it is the next job — a duplicate or a pending suggestion
// wants resolving first, and a reverse-scan charge is not an order at all. Not offered on an order known
// to hold one item, which has nothing to divide — the register's Split… still covers the rare exception.
// An order with no item detail (`item_count` 0) keeps it, since its contents are unknown.
function SplitAction({ order, busy, onOpen }) {
  if (!order?.id) return null
  if (!order.is_split && order.item_count === 1) return null
  return (
    <Button
      variant="secondary"
      disabled={busy}
      onClick={() => onOpen(order)}
      title={order.is_split
        ? 'Adjust how this order is divided across categories'
        : 'Divide this order across categories, starting from its items'}
    >{order.is_split ? 'Edit split…' : 'Split…'}</Button>
  )
}

function buildEntries(data) {
  return [
    ...(data.matched || []).map(m => ({ id: `m:${m.link_id}`, kind: 'matched', linkId: m.link_id, order: m.order, orderUrl: orderSourceUrl(m.order), charges: m.charges || [] })),
    ...(data.matched_review || []).map(r => ({ id: `r:${r.link_id}`, kind: 'matched_review', linkId: r.link_id, order: r.order, orderUrl: orderSourceUrl(r.order), charges: r.charges || [], total: r.total, spansDays: r.spans_days, reason: r.reason })),
    ...(data.duplicate || []).map(d => ({ id: `d:${d.link_id}`, kind: 'duplicate', linkId: d.link_id, order: d.order, orderUrl: orderSourceUrl(d.order), charges: d.charges, mergeable: d.mergeable })),
    ...(data.duplicate_review || []).map(d => ({ id: `dr:${d.link_id}`, kind: 'duplicate_review', linkId: d.link_id, order: d.order, orderUrl: orderSourceUrl(d.order), charges: d.charges, mergeable: d.mergeable })),
    ...(data.amazon_unmatched || []).map(m => ({ id: `u:${m.link_id}`, kind: 'unmatched', linkId: m.link_id, order: m.order, orderUrl: orderSourceUrl(m.order), charges: null, reviewed: !!m.reviewed })),
    ...(data.payment_unmatched || []).map(t => ({ id: `p:${t.id}`, kind: 'reverse', linkId: null, order: null, charge: t, reviewed: !!t.reviewed })),
    ...(data.unaccounted_duplicate || []).map(g => ({ id: `ud:${g.charges[0]?.id}`, kind: 'unaccounted_duplicate', linkId: null, order: null, charges: g.charges })),
  ]
}

// A row's bulk-eligible actions. Only row-level ones qualify: the per-copy Discard on a multi-charge row
// names *which* copy to remove, so it has no unambiguous bulk form (its bulk equivalent is Merge), and the
// manual Link needs a per-item choice. Merge is offered only for a *mergeable* duplicate (no other unmatched
// order shares its amount — see the backend `mergeable` flag). The single-charge `reverse` row's button is
// row-level — hence "Trash" rather than "Discard" — so it does.
function rowActions(entry) {
  if (entry.kind === 'duplicate' || entry.kind === 'duplicate_review') return entry.mergeable ? { merge: true } : {}
  if (entry.kind === 'unaccounted_duplicate') return { merge: true }
  if (entry.kind === 'matched_review') return { accept: true, dismiss: true }
  if (entry.kind === 'matched') return { unlink: true }
  if (entry.kind === 'reverse') return entry.reviewed ? { trash: true, unreview: true } : { trash: true, mark_reviewed: true }
  if (entry.kind === 'unmatched') return entry.reviewed ? { unreview: true } : { mark_reviewed: true }
  return {}
}

// A no-charge-found order acknowledges by its order link id; an unaccounted reverse-scan charge by its txn
// id (it has no order link). Shared by the per-row buttons and the bulk bar so both buckets clear the same way.
const reviewCall = (entry, reviewed) => (
  entry.kind === 'reverse'
    ? api.markAmazonUnaccountedReviewed({ txn_ids: [entry.charge.id], reviewed })
    : api.markAmazonOrdersReviewed({ link_ids: [entry.linkId], reviewed })
)

// Orderless groups send their explicit charge ids (the server re-validates them); a review-window group
// merges the exact ±14-day copy set its row displayed (see the endpoint); a plain duplicate derives at the
// matcher's ±3.
const mergeCall = (entry) => (
  entry.kind === 'unaccounted_duplicate'
    ? api.mergeUnaccountedAmazonCharges({ charge_txn_ids: entry.charges.map(c => c.id) })
    : api.mergeAmazonDuplicateCharges({ order_link_id: entry.linkId, review_window: entry.kind === 'duplicate_review' })
)

// The call behind each row-level action, shared by a row's own button and the bulk bar. Bulk runs them in
// parallel, which is safe: Merge is only offered on *mergeable* rows (orderless groups validate per-group
// server-side and have no cross-row guard to trip), so no call can hit the same-amount guard, and a
// reverse-scan row owns exactly one charge and no order link, so trashing it is independent of the others.
function actionCall(action, entry) {
  if (action === 'merge') return mergeCall(entry)
  if (action === 'accept') return api.linkAmazonCharges({ link_id: entry.linkId, charge_txn_ids: (entry.charges || []).map(c => c.id) })
  if (action === 'dismiss') return api.dismissAmazonSplitSuggestion({ link_id: entry.linkId })
  if (action === 'unlink') return api.unlinkAmazonOrderCharges({ order_link_id: entry.linkId })
  if (action === 'mark_reviewed') return reviewCall(entry, true)
  if (action === 'unreview') return reviewCall(entry, false)
  if (action === 'trash') return api.trashAmazonDuplicateCharge({ charge_txn_id: entry.charge?.id, order_link_id: null, as_duplicate: false })
  return null
}

// Trash is destructive, so it's the last of the action buttons — set apart from the constructive run.
const BULK_ACTIONS = [
  { key: 'merge', label: 'Merge → keep one', title: 'Merge each selected duplicate into one — keep the richest copy, trash the rest' },
  { key: 'accept', label: 'Accept', title: "Link each selected split suggestion's charges to its order" },
  { key: 'dismiss', label: 'Dismiss', title: 'Dismiss each selected split suggestion' },
  { key: 'unlink', label: 'Unlink', title: "Detach each selected matched order's charge(s) — their categories are restored and the orders return to needing a match" },
  { key: 'mark_reviewed', label: 'Mark reviewed', title: "Acknowledge each selected 'No charge found' order or unaccounted charge — clears them from the attention count without resolving them further" },
  { key: 'unreview', label: 'Undo review', title: 'Un-acknowledge each selected reviewed row — returns it to the attention count' },
  { key: 'trash', label: 'Move to trash', title: 'Send each selected unaccounted charge to Trash (recoverable from Settings → Trash)' },
]

function useColumns({ data, busy, run, reload, openPicker, reportError }) {
  const unaccounted = data?.payment_unmatched || []

  // Splitting an order is offered *here* because this is where orders are actually reviewed — the
  // alternative is finding the row again in the ledger, which is the same work twice. The categories
  // the editor's pickers need are fetched on first use rather than with the report: most sessions
  // never split anything, and the report is already several queries deep.
  const [splitTarget, setSplitTarget] = useState(null)
  const [splitCategories, setSplitCategories] = useState(null)
  const openSplit = async (order) => {
    if (!splitCategories) {
      try {
        setSplitCategories(await api.getCategories())
      } catch (e) {
        reportError(e?.message || 'Could not load categories')
        return
      }
    }
    setSplitTarget(order)
  }

  const discardCharge = (charge, entry) => run(() => api.trashAmazonDuplicateCharge({
    charge_txn_id: charge.id,
    order_link_id: entry.linkId || null,
    // A reverse row's Trash is an ordinary delete ("this shouldn't be here at all"), not a dedupe
    // resolution — so it files under the Trash page's Deleted transactions. The per-copy Discard on
    // a stacked duplicate row is a dedupe resolution and keeps that provenance.
    as_duplicate: entry.kind !== 'reverse',
  }), 'Could not discard the charge')

  // "Not duplicates" persists the distinct-purchases assertion (every pair in the group, including a linked
  // copy) so the report never re-flags them. An unaccounted group's copies return to the informational list;
  // an order-anchored group's order falls back to the unmatched path, where the exact-date tie-break may
  // still nominate one charge for review.
  const markNotDuplicates = (entry) => run(
    () => api.markAmazonChargesNotDuplicates({ charge_txn_ids: entry.charges.map(c => c.id) }),
    'Could not mark the charges as distinct')
  const mergeGroup = (entry) => run(() => mergeCall(entry), 'Could not merge the charges')
  const setReviewed = (entry, reviewed) => run(() => reviewCall(entry, reviewed), 'Could not update the review state')

  // Acknowledge a row so it drops out of the attention count while staying listed, or un-acknowledge it
  // back in. A reviewed row carries its ✓ status in the Kind cell; here it offers Undo review.
  const reviewToggle = (entry, subject, markTitle) => (entry.reviewed ? (
    <Button variant="secondary" disabled={busy} onClick={() => setReviewed(entry, false)} title={`Un-acknowledge — return this ${subject} to the attention count`}>Undo review</Button>
  ) : (
    <Button variant="secondary" disabled={busy} onClick={() => setReviewed(entry, true)} title={markTitle}>Mark reviewed</Button>
  ))

  // The manual multi-charge link window for a "No charge found" order: pick the card charge(s) that together
  // paid for it (Amazon can bill one order as several shipment charges), from the unaccounted charges.
  const openLink = (entry) => openPicker({
    title: 'Link charges to this order',
    description: 'Pick the card charge(s) that together paid for this order — Amazon sometimes splits an order into several shipment charges.',
    targetLabel: 'Order total',
    target: entry.order?.amount,
    targetDate: entry.order?.date,
    candidates: unaccounted,
    multiple: true,
    mismatchNote: "The selection doesn't match the order total — you can still link it.",
    emptyMessage: 'No unaccounted charges to link.',
    confirmLabel: n => `Link ${n || ''} charge${n === 1 ? '' : 's'}`,
    onConfirm: ids => api.linkAmazonCharges({ link_id: entry.linkId, charge_txn_ids: ids }),
    failMessage: 'Could not link the charges',
  })

  const columns = [
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
            <TxnStack charges={entry.charges} />
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
      return <TxnCell txn={entry.charge} />
    } },
    { key: 'action', label: 'Actions', width: 240, sortable: false, render: (entry) => {
      // The duplicate group's recommended one-click resolution: keep the richest copy, fold in the
      // others' detail, trash the rest. It lives here (the right-edge Actions column) rather than under
      // the stacked charges, so it reads as the row-level action and doesn't sit beneath the charge text.
      if (entry.kind === 'unaccounted_duplicate') {
        return (
          <div style={{ display: 'flex', gap: 6 }}>
            <Button variant="secondary" disabled={busy} onClick={() => mergeGroup(entry)} title="Merge into one: keep the richest copy, fold in any detail the others have, and trash the rest — the survivor stays in the unaccounted list">
              Merge → keep one
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => markNotDuplicates(entry)} title="These are distinct purchases — keep every copy and never flag this group again">
              Not duplicates
            </Button>
          </div>
        )
      }
      if (entry.kind === 'reverse') {
        // Informational, but surfaced for a look: Trash it (a duplicate the grouping failed to pair — labelled
        // "Trash" rather than "Discard" because it acts on the whole one-charge row, which is what makes it
        // bulk-able), or Mark reviewed to acknowledge a legitimately-uncovered charge so it leaves the
        // attention count.
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Button variant="secondary" disabled={busy} onClick={() => discardCharge(entry.charge, entry)}
              title="Send this charge to Trash — for a duplicate copy the report failed to pair up (recoverable from Settings → Trash)">
              Trash
            </Button>
            {reviewToggle(entry, 'charge', "Acknowledge this charge — a purchase the export didn't cover, or otherwise fine — so it leaves the attention count without trashing it")}
          </div>
        )
      }
      if (entry.kind === 'duplicate' || entry.kind === 'duplicate_review') {
        // "Not duplicates" persists the distinct-purchases verdict: the duplicate row disappears and the
        // order falls back to the unmatched path. Merge is only offered where it would succeed — a lone
        // order at this amount whose extra charges are redundant copies; when other unmatched orders
        // share the amount the copies look like distinct purchases (merge would steal a charge), so
        // Not duplicates is the row's primary resolution there.
        return (
          <div style={{ display: 'flex', gap: 6 }}>
            {entry.mergeable ? (
              <Button variant="secondary" disabled={busy} onClick={() => mergeGroup(entry)} title="Merge into one: keep the richest copy, fold in any detail the others have, and trash the rest">
                Merge → keep one
              </Button>
            ) : null}
            <Button variant="secondary" disabled={busy} onClick={() => markNotDuplicates(entry)}
              title="These are distinct purchases, not copies — keep them all and never flag this group again. The order returns to the unmatched path for linking (a charge dated on the order is re-suggested for review).">
              Not duplicates
            </Button>
          </div>
        )
      }
      if (entry.kind === 'matched_review') {
        return (
          <div style={{ display: 'flex', gap: 6 }}>
            <Button variant="secondary" disabled={busy} onClick={() => run(() => actionCall('accept', entry), 'Could not link the charges')} title="Link these charges to the order — each is excluded from totals">Accept</Button>
            <Button variant="secondary" disabled={busy} onClick={() => run(() => actionCall('dismiss', entry), 'Could not dismiss the suggestion')} title="Not a match — keep this order as no-charge-found and stop suggesting it">Dismiss</Button>
          </div>
        )
      }
      // A matched row can be wrong (a coincidental same-amount charge, or an accepted suggestion that
      // turned out not to be this order's). Unlink detaches the charge(s), restores their categories,
      // and drops the order back to "No charge found" where Link charges… can pair it correctly.
      if (entry.kind === 'matched') {
        return (
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-start' }}>
            <Button variant="secondary" disabled={busy} onClick={() => run(() => actionCall('unlink', entry), 'Could not unlink the charges')}
              title="Not this order's charge — detach it (its category is restored) and put the order back to needing a match">
              Unlink
            </Button>
            <SplitAction order={entry.order} busy={busy} onOpen={openSplit} />
          </div>
        )
      }
      // No charge found: link a charge by hand, or acknowledge it (Mark reviewed) so it drops out of the
      // attention count — the escape valve for an untracked card with nothing to link.
      if (entry.kind !== 'unmatched') return null
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <Tooltip content={unaccounted.length ? 'Pick the card charge(s) that paid for this order' : 'No unaccounted charges to link'}>
            <Button variant="secondary" disabled={busy || !unaccounted.length} onClick={() => openLink(entry)}>
              Link charges…
            </Button>
          </Tooltip>
          <SplitAction order={entry.order} busy={busy} onOpen={openSplit} />
          {reviewToggle(entry, 'order', 'Acknowledge this order — clears it from the attention count without linking a charge (for an untracked card with nothing to link)')}
        </div>
      )
    } },
  ]

  const overlay = splitTarget && splitCategories ? (
    <SplitEditorDialog
      txn={splitTarget}
      categories={splitCategories}
      onAddCategory={cat => setSplitCategories(prev => (
        prev?.some(existing => existing.id === cat.id) ? prev : [...(prev || []), cat]
      ))}
      onClose={() => setSplitTarget(null)}
      // Reloads the report, as every other row action here does. The rows are rebuilt from the
      // reconciliation payload rather than held locally, so patching the open row would leave the
      // *entry* it came from stale — the row's Split…/Edit split… label is read from `entry.order`,
      // and the editor closes on save, so there is nothing left to patch anyway.
      onSaved={() => reload?.()}
    />
  ) : null

  return { columns, overlay }
}

export const amazonReconciliation = {
  subtitle: "How this import's orders line up with the card charges in your ledger.",
  explainerTopic: 'amazon-reconciliation',
  panelPrefKey: 'ui.amazonReconciliation.panel',
  columnsPrefKey: AMAZON_RECONCILIATION_COLUMNS_PREF_KEY,
  emptyMessage: 'Nothing to reconcile for this import.',
  kinds: KINDS,
  buildEntries,
  entryDate: (entry) => (entry.order || entry.charges?.[0] || entry.charge)?.date || '',
  isAcknowledged: (entry) => !!entry.reviewed && (entry.kind === 'unmatched' || entry.kind === 'reverse'),
  rowActions,
  bulkActions: BULK_ACTIONS,
  actionCall,
  useColumns,
}
