// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from 'react'
import { api } from '../../../lib/api.js'
import { Button } from '../../ui.jsx'
import { PAYPAL_FUNDING_COLUMNS_PREF_KEY } from '../../../lib/importExport/constants.js'
import { TxnCell, TxnStack } from './reconciliationCells.jsx'

// The PayPal reconciliation: how a tracked PayPal account's rows match the bank and card rows on the
// other side of the same movement (services/paypal_funding.py, which calls a match a pair). The matching
// runs by itself after imports and syncs; this is where its results are checked and what it could not
// decide is settled. Buckets:
//   • choice       — a PayPal row with more than one candidate: pick one, or none of these
//   • unmatched    — a PayPal row that moved money to or from another account, with no candidate: link one
//                    by hand, or mark it reviewed (an account the ledger does not track)
//   • unaccounted  — a PayPal-looking bank or card row nothing matches: mark it reviewed
//   • matched      — a match; Unlink restores whatever the match changed and is remembered
// One vendor of the shared reconciliation shell (ReconciliationReportDialog).

const KINDS = {
  choice: { rank: 0, label: 'Several possible matches', stripe: '#f59e0b', warn: true,
    help: 'More than one bank or card transaction could be the other side of this PayPal transaction. Pick the right one, or choose None of these.' },
  unmatched: { rank: 1, label: 'Matching transaction not found', stripe: '#ef4444', warn: true,
    help: 'This PayPal transaction moved money to or from another account, but no matching bank or card transaction was found. Link one by hand, or mark it reviewed when that account is not tracked here.' },
  unaccounted: { rank: 2, label: 'No PayPal record', stripe: '#94a3b8', warn: true,
    help: 'A PayPal charge or deposit on an account that pays into PayPal, dated within the PayPal history, that no PayPal transaction accounts for. It still counts as it is; mark it reviewed once checked.' },
  matched: { rank: 3, label: 'Matched', stripe: 'var(--success, #22c55e)',
    help: 'Each PayPal transaction and the bank or card transaction on the other side. The money counts once: a transfer is excluded on both sides, a payment is counted on the PayPal side.' },
}

function buildEntries(data) {
  return [
    ...(data.matched || []).map(m => ({ id: `m:${m.link_id}`, kind: 'matched', linkId: m.link_id, paypal: m.paypal, counterpart: m.counterpart })),
    ...(data.choice || []).map(c => ({ id: `c:${c.paypal?.id}`, kind: 'choice', paypal: c.paypal, candidates: c.candidates || [] })),
    ...(data.unmatched || []).map(u => ({ id: `u:${u.paypal?.id}`, kind: 'unmatched', paypal: u.paypal, reviewed: !!u.reviewed })),
    ...(data.unaccounted || []).map(t => ({ id: `x:${t.id}`, kind: 'unaccounted', counterpart: t, reviewed: !!t.reviewed })),
  ]
}

// The row an acknowledgement is recorded against: the PayPal row, or for a bank row with no PayPal record,
// the bank row itself.
const reviewedTxnId = (entry) => (entry.kind === 'unaccounted' ? entry.counterpart.id : entry.paypal.id)

function rowActions(entry) {
  if (entry.kind === 'matched') return { unpair: true }
  if (entry.kind === 'choice') return { decline: true }
  return entry.reviewed ? { unreview: true } : { mark_reviewed: true }
}

// Each call is about its own row alone, so the bulk bar can run them side by side.
function actionCall(action, entry) {
  if (action === 'unpair') return api.unpairPaypalFunding({ link_ids: [entry.linkId] })
  if (action === 'decline') {
    return api.declinePaypalFunding({ paypal_txn_id: entry.paypal.id, counterpart_txn_ids: entry.candidates.map(c => c.id) })
  }
  if (action === 'mark_reviewed') return api.markPaypalFundingReviewed({ txn_ids: [reviewedTxnId(entry)], reviewed: true })
  if (action === 'unreview') return api.markPaypalFundingReviewed({ txn_ids: [reviewedTxnId(entry)], reviewed: false })
  return null
}

const BULK_ACTIONS = [
  { key: 'decline', label: 'None of these', title: "Record that none of each selected row's candidates is its other side" },
  { key: 'mark_reviewed', label: 'Mark reviewed', title: 'Acknowledge each selected row — it stays listed but no longer needs attention' },
  { key: 'unreview', label: 'Undo review', title: 'Return each selected reviewed row to needing attention' },
  { key: 'unpair', label: 'Unlink', title: 'Undo each selected match — whatever it changed is put back, and it is not matched again' },
]

function useColumns({ busy, run, openPicker, reportError }) {
  const [loadingPicker, setLoadingPicker] = useState(false)

  // The manual linking window. A row with candidates offers exactly those; one with none asks the server
  // for every PayPal-looking row nearby, whatever its amount.
  const openPair = async (entry) => {
    let candidates = entry.candidates
    if (!candidates) {
      setLoadingPicker(true)
      try {
        candidates = await api.getPaypalFundingCandidates(entry.paypal.id)
      } catch (e) {
        reportError(e?.message || 'Could not load the transactions to link')
        return
      } finally {
        setLoadingPicker(false)
      }
    }
    openPicker({
      title: 'Link a bank or card transaction',
      description: 'Pick the transaction on the other side of this PayPal transaction.',
      targetLabel: 'PayPal amount',
      target: entry.paypal.amount,
      targetDate: entry.paypal.date,
      candidates,
      multiple: false,
      mismatchNote: 'The amounts differ — they can still be linked.',
      emptyMessage: 'No PayPal charges or deposits nearby to link.',
      confirmLabel: () => 'Link',
      onConfirm: ids => api.pairPaypalFunding({ paypal_txn_id: entry.paypal.id, counterpart_txn_id: ids[0] }),
      failMessage: 'Could not link the transactions',
    })
  }

  const act = (action, entry, failMessage) => run(() => actionCall(action, entry), failMessage)
  const reviewToggle = (entry, markTitle) => (entry.reviewed ? (
    <Button small variant="ghost" disabled={busy} onClick={() => act('unreview', entry, 'Could not update the review state')}
      title="Return this row to needing attention">Undo review</Button>
  ) : (
    <Button small variant="ghost" disabled={busy} onClick={() => act('mark_reviewed', entry, 'Could not update the review state')}
      title={markTitle}>Mark reviewed</Button>
  ))

  const columns = [
    { key: 'paypal', label: 'PayPal', width: 320, render: (entry) => <TxnCell txn={entry.paypal} /> },
    { key: 'counterpart', label: 'Bank or card', width: 330, render: (entry) => (
      entry.kind === 'choice' ? <TxnStack charges={entry.candidates} /> : <TxnCell txn={entry.counterpart} />
    ) },
    { key: 'action', label: 'Actions', width: 240, sortable: false, render: (entry) => {
      if (entry.kind === 'matched') {
        return (
          <Button small variant="ghost" disabled={busy} onClick={() => act('unpair', entry, 'Could not unlink the transactions')}
            title="Not the same money — put back whatever the match changed; it is not made again">Unlink</Button>
        )
      }
      if (entry.kind === 'choice') {
        return (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Button small variant="ghost" disabled={busy} onClick={() => openPair(entry)}>Pick…</Button>
            <Button small variant="ghost" disabled={busy} onClick={() => act('decline', entry, 'Could not record the choice')}
              title="None of these is the other side of this PayPal transaction">None of these</Button>
          </div>
        )
      }
      if (entry.kind === 'unmatched') {
        return (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Button small variant="ghost" disabled={busy || loadingPicker} onClick={() => openPair(entry)}>Link…</Button>
            {reviewToggle(entry, 'Acknowledge it — the other account is not tracked here, or nothing is missing')}
          </div>
        )
      }
      return reviewToggle(entry, 'Acknowledge it — it counts as it is, and no longer needs attention')
    } },
  ]
  return { columns, overlay: null }
}

export const paypalReconciliation = {
  subtitle: 'How PayPal transactions match the bank and card transactions on the other side, so the money counts once.',
  explainerTopic: 'paypal-reconciliation',
  panelPrefKey: 'ui.paypalFunding.panel',
  columnsPrefKey: PAYPAL_FUNDING_COLUMNS_PREF_KEY,
  emptyMessage: 'Nothing to reconcile.',
  kinds: KINDS,
  buildEntries,
  entryDate: (entry) => (entry.paypal || entry.counterpart)?.date || '',
  isAcknowledged: (entry) => !!entry.reviewed && (entry.kind === 'unmatched' || entry.kind === 'unaccounted'),
  rowActions,
  bulkActions: BULK_ACTIONS,
  actionCall,
  useColumns,
}
