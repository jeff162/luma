// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- a vendor module exports its config; the cells it renders are private to it */

import { useState } from 'react'
import { api } from '../../../lib/api.js'
import { Button } from '../../ui.jsx'
import { PAYPAL_FUNDING_COLUMNS_PREF_KEY } from '../../../lib/importExport/constants.js'
import { TxnCell, TxnStack } from './reconciliationCells.jsx'
import { txnSortFields } from './reconciliationSort.js'

// The PayPal reconciliation: how a tracked PayPal account's rows match the bank and card rows on the
// other side of the same movement (services/paypal_funding.py, which calls a match a pair). The matching
// runs by itself after imports and syncs; this is where its results are checked and what it could not
// decide is settled. Buckets:
//   • choice       — a PayPal row with more than one candidate: pick one, or none of these
//   • contested    — the PayPal rows cornered on one bank or card transaction, as **one** row: at most one of
//                    them can have it, and the matcher cannot say which (services/paypal_funding.py claims
//                    a candidate for a row that is cornered alone, so a lone candidate left here is always
//                    one several rows are cornered on). Same work as `choice`, so it is the same bucket on
//                    the wire — split and grouped here, where the candidate list it is read off is what the
//                    row renders. Giving the transaction to one of them is all the work there is: the
//                    others are left with no candidate and the group is gone on the next read
//   • unmatched    — a PayPal row that moved money to or from another account, with no candidate: link one
//                    by hand, or mark it reviewed (an account the ledger does not track)
//   • unaccounted  — a PayPal-looking bank or card row nothing matches: mark it reviewed
//   • matched      — a match; Unlink restores whatever the match changed and is remembered
// One vendor of the shared reconciliation shell (ReconciliationReportDialog).

const KINDS = {
  choice: { rank: 0, label: 'Several possible matches', stripe: '#f59e0b', warn: true,
    help: 'More than one bank or card transaction could be the other side of this PayPal transaction. Pick the right one, or choose None of these.' },
  contested: { rank: 1, label: 'Two transactions, one match', stripe: '#f59e0b', warn: true,
    help: 'One bank or card transaction that could equally be the other side of either of these PayPal transactions, and only one of them can have it — usually because the other payment came from the PayPal balance, or its own bank transaction is not in the ledger. Pick this one beside the transaction it belongs to; the others are then left with none, which is what a balance-funded payment looks like. Neither, when it belongs to none of them.' },
  unmatched: { rank: 2, label: 'Matching transaction not found', stripe: '#ef4444', warn: true,
    help: 'This PayPal transaction moved money to or from another account, but no matching bank or card transaction was found. Link one by hand, or mark it reviewed when that account is not tracked here.' },
  unaccounted: { rank: 3, label: 'No PayPal record', stripe: '#94a3b8', warn: true,
    help: 'A PayPal charge or deposit on an account that pays into PayPal, dated within the PayPal history, that no PayPal transaction accounts for. It still counts as it is; mark it reviewed once checked.' },
  matched: { rank: 4, label: 'Matched', stripe: 'var(--success, #22c55e)',
    help: 'Each PayPal transaction and the bank or card transaction on the other side. The money counts once: a transfer is excluded on both sides, a payment is counted on the PayPal side.' },
}

// The PayPal cell of a contested group: the rows cornered on one bank or card transaction, stacked, each
// beside the button that gives that transaction to it. The button sits with its own row because that row
// is what it picks — the same reason the Amazon vendor's per-copy Discard sits beside its charge — and a
// column of buttons in Actions would have the whole Bank-or-card column between it and what it refers to.
function ContestedRivals({ rivals, disabled, onPick }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {rivals.map(paypal => (
        <div key={paypal.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}><TxnCell txn={paypal} /></div>
          <Button variant="secondary" disabled={disabled} onClick={() => onPick(paypal)}
            size="compact" style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
            title="The bank or card transaction is the other side of this one">Pick this one</Button>
        </div>
      ))}
    </div>
  )
}

// A PayPal row the pass could not settle is one of two things, told apart by how many candidates it has:
// a choice between several, or one of the rows cornered on a single one. The count is read off the very
// list the row renders, so the label cannot claim more possibilities than are shown. The cornered rows
// are collected into one row per contested transaction — they are not separate decisions, they are the
// two sides of one, and listed apart each showed the same lone transaction with no sign of the rival it
// was being weighed against. (A report scoped to one import can hold just one side of such a group, where
// the rival arrived with a different file; the row is still contested, and still resolved the same way.)
function buildChoiceEntries(choice) {
  const groups = new Map()
  const entries = []
  for (const c of choice) {
    const candidates = c.candidates || []
    if (candidates.length > 1) {
      entries.push({ id: `c:${c.paypal?.id}`, kind: 'choice', paypal: c.paypal, candidates })
      continue
    }
    const contested = candidates[0]
    if (!contested) continue
    if (!groups.has(contested.id)) {
      groups.set(contested.id, { id: `g:${contested.id}`, kind: 'contested', counterpart: contested, rivals: [] })
    }
    groups.get(contested.id).rivals.push(c.paypal)
  }
  // Oldest first, as the report sorts every other row: which of two payments a bank row belongs to is
  // usually read off the dates, and a stack that is not in date order makes that comparison by hand.
  for (const group of groups.values()) {
    group.rivals.sort((a, b) => String(a?.date || '').localeCompare(String(b?.date || '')))
  }
  return [...entries, ...groups.values()]
}

// What the headers sort by: each cell shows a date, a name and an amount. A contested group sorts by its
// earliest rival, a choice by its first candidate.
const PAYPAL_SORT_FIELDS = txnSortFields(entry => entry.paypal || entry.rivals?.[0])
const COUNTERPART_SORT_FIELDS = txnSortFields(entry => entry.counterpart || entry.candidates?.[0])

function buildEntries(data) {
  return [
    ...(data.matched || []).map(m => ({ id: `m:${m.link_id}`, kind: 'matched', linkId: m.link_id, paypal: m.paypal, counterpart: m.counterpart })),
    ...buildChoiceEntries(data.choice || []),
    ...(data.unmatched || []).map(u => ({ id: `u:${u.paypal?.id}`, kind: 'unmatched', paypal: u.paypal, reviewed: !!u.reviewed })),
    ...(data.unaccounted || []).map(t => ({ id: `x:${t.id}`, kind: 'unaccounted', counterpart: t, reviewed: !!t.reviewed })),
  ]
}

// The row an acknowledgement is recorded against: the PayPal row, or for a bank row with no PayPal record,
// the bank row itself.
const reviewedTxnId = (entry) => (entry.kind === 'unaccounted' ? entry.counterpart.id : entry.paypal.id)

function rowActions(entry) {
  if (entry.kind === 'matched') return { unpair: true }
  // Giving the transaction to one of a group's rows is a per-row button inside the row; declining it for
  // all of them is about the group, so it is the group's row action — and bulk-eligible with it.
  if (entry.kind === 'contested' || entry.kind === 'choice') return { decline: true }
  return entry.reviewed ? { unreview: true } : { mark_reviewed: true }
}

// Each call is about its own row alone, so the bulk bar can run them side by side.
function actionCall(action, entry) {
  if (action === 'unpair') return api.unpairPaypalFunding({ link_ids: [entry.linkId] })
  if (action === 'decline') {
    // A group declines its one transaction for every row cornered on it, which releases the transaction
    // itself: nothing wants it afterwards, so it is listed as having no PayPal record on the account that
    // funds PayPal. A row with a choice declines the candidates it was offered.
    if (entry.kind === 'contested') {
      return Promise.all(entry.rivals.map(paypal => api.declinePaypalFunding({
        paypal_txn_id: paypal.id, counterpart_txn_ids: [entry.counterpart.id],
      })))
    }
    return api.declinePaypalFunding({ paypal_txn_id: entry.paypal.id, counterpart_txn_ids: entry.candidates.map(c => c.id) })
  }
  if (action === 'mark_reviewed') return api.markPaypalFundingReviewed({ txn_ids: [reviewedTxnId(entry)], reviewed: true })
  if (action === 'unreview') return api.markPaypalFundingReviewed({ txn_ids: [reviewedTxnId(entry)], reviewed: false })
  return null
}

const BULK_ACTIONS = [
  { key: 'decline', label: 'None of these', title: 'Record that none of the transactions offered beside each selected row is its other side' },
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

  // Giving a contested transaction to one of the rows cornered on it. There is nothing to choose from —
  // the one transaction is already on the row — so this matches outright instead of opening the picker.
  const pick = (entry, paypal) => run(
    () => api.pairPaypalFunding({ paypal_txn_id: paypal.id, counterpart_txn_id: entry.counterpart.id }),
    'Could not match the transactions')
  const reviewToggle = (entry, markTitle) => (entry.reviewed ? (
    <Button variant="secondary" disabled={busy} onClick={() => act('unreview', entry, 'Could not update the review state')}
      title="Return this row to needing attention">Undo review</Button>
  ) : (
    <Button variant="secondary" disabled={busy} onClick={() => act('mark_reviewed', entry, 'Could not update the review state')}
      title={markTitle}>Mark reviewed</Button>
  ))

  const columns = [
    { key: 'paypal', label: 'PayPal', width: 380, sortFields: PAYPAL_SORT_FIELDS, render: (entry) => (
      entry.kind === 'contested'
        ? <ContestedRivals rivals={entry.rivals} disabled={busy} onPick={(paypal) => pick(entry, paypal)} />
        : <TxnCell txn={entry.paypal} />
    ) },
    { key: 'counterpart', label: 'Bank or card', width: 330, sortFields: COUNTERPART_SORT_FIELDS, render: (entry) => (
      entry.kind === 'choice' ? <TxnStack charges={entry.candidates} /> : <TxnCell txn={entry.counterpart} />
    ) },
    { key: 'action', label: 'Actions', width: 240, render: (entry) => {
      if (entry.kind === 'matched') {
        return (
          <Button variant="secondary" disabled={busy} onClick={() => act('unpair', entry, 'Could not unlink the transactions')}
            title="Not the same money — put back whatever the match changed; it is not made again">Unlink</Button>
        )
      }
      // A contested group's Pick buttons are beside the rows they pick, in the PayPal cell; what is left
      // for this column is the answer about the group as a whole.
      if (entry.kind === 'contested') {
        return (
          <Button variant="secondary" disabled={busy} onClick={() => act('decline', entry, 'Could not record the choice')}
            title="The transaction is the other side of none of these — it is not offered to them again">Neither</Button>
        )
      }
      if (entry.kind === 'choice') {
        return (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Button variant="secondary" disabled={busy} onClick={() => openPair(entry)}>Pick…</Button>
            <Button variant="secondary" disabled={busy} onClick={() => act('decline', entry, 'Could not record the choice')}
              title="None of these is the other side of this PayPal transaction">None of these</Button>
          </div>
        )
      }
      if (entry.kind === 'unmatched') {
        return (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Button variant="secondary" disabled={busy || loadingPicker} onClick={() => openPair(entry)}>Link…</Button>
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
  sortPrefKey: 'ui.paypalFunding.sort',
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
