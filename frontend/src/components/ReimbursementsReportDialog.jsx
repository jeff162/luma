// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../lib/api.js'
import { formatMoneyMagnitude, formatTransactionAmount, getTransactionAmountColor } from '../lib/moneyDisplay.js'
import {
  claimRemainder,
  claimablePortions,
  dropRefusal,
  reimbursementBoard,
  reimbursementListLabel,
  residualSummary,
} from '../lib/reimbursements.js'
import ClaimPortionPicker from './ClaimPortionPicker.jsx'
import ReimbursementEditorDialog from './ReimbursementEditorDialog.jsx'
import TransactionDetail from './TransactionDetail.jsx'
import { AppDialog, Button, EmptyState, Spinner } from './ui.jsx'

/*
 * Everything still owed back, in one place — the answer to "has anyone paid me back yet?" without
 * hunting through the ledger for the rows that carry it.
 *
 * **It lists only what is open, and that is the whole point of it.** A completed reimbursement has no
 * work left, so a finished/unfinished toggle would be two lists where one of them is never read;
 * completing something simply removes it from here, and it stays reachable from any of its transactions
 * if it is ever wanted again. The server decides this rather than the screen filtering after the fact,
 * so the headline total and the list can never disagree.
 *
 * **Two piles, because pairing is optional and late.** *Tracked* reimbursements have been grouped and
 * can be completed; *unclaimed* money is receivable nobody has linked to anything yet, which is the
 * normal state of a reimbursable between the purchase and the repayment rather than a defect. Adding
 * them together gives the receivable group's own balance, which is what makes the header figure
 * trustworthy with nothing linked at all.
 *
 * A dialog rather than a page, following the Amazon reconciliation report it is modelled on: it is a
 * periodic review of a pile of work rather than a place to navigate to and dwell in.
 */
export default function ReimbursementsReportDialog({ categories, onAddCategory, onClose, onChanged }) {
  const [report, setReport] = useState(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(null)
  // A not-yet-tracked row opens its transaction, not a reimbursement editor — see openLooseRow.
  const [looseTxn, setLooseTxn] = useState(null)
  // Which right-column row is in flight, which left-column entry is under it, and the drop awaiting a
  // portion choice. The dragged row is module-adjacent state rather than dataTransfer because `dragover`
  // cannot read dataTransfer — the same reason the category tree keeps its own payload.
  const [dragRow, setDragRow] = useState(null)
  const [dropTarget, setDropTarget] = useState(null)
  const [pendingDrop, setPendingDrop] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    let cancelled = false
    api.getOutstandingReimbursements()
      .then(result => { if (!cancelled) setReport(result) })
      .catch(err => { if (!cancelled) setError(err?.message || 'This report could not be loaded.') })
    return () => { cancelled = true }
  }, [])

  useEffect(load, [load])

  const board = reimbursementBoard(report)

  function afterChange() {
    load()
    onChanged?.()
  }

  /*
   * A row in "Not tracked yet" opens the **transaction**, not the reimbursement editor — there is no
   * reimbursement to edit, which is what makes it untracked, and the editor has no create mode. Its
   * detail panel is where the act lives: the reimbursable section there already decides what to offer
   * from the row's sign, its portions and what is left unclaimed, so nothing about that flow is restated
   * here.
   *
   * Fetched by id because a loose row carries only date, payee and amount — the panel needs the whole
   * transaction. This click previously stored `{ linkId: null }` into state that only rendered for a
   * truthy `linkId`, so every one of these rows silently did nothing.
   */
  async function openLooseRow(row) {
    setError('')
    try {
      const resp = await api.getTransactions({ ids: row.txn_id, limit: 1 })
      const txn = resp?.transactions?.[0]
      if (txn) setLooseTxn(txn)
      else setError('That transaction could not be opened.')
    } catch (err) {
      setError(err?.message || 'That transaction could not be opened.')
    }
  }

  function entryLabel(entry) {
    return entry.kind === 'record'
      ? reimbursementListLabel(entry.reimbursement)
      : entry.row.payee
  }

  function openEntry(entry) {
    if (entry.kind === 'record') {
      setEditing({ linkId: entry.id, txnId: entry.members?.[0]?.txn_id })
      return
    }
    openLooseRow(entry.row)
  }

  // Only a droppable target highlights and accepts. Without the preventDefault the browser refuses the
  // drop outright, so the refusal reasons double as the "is this a target" test.
  function allowDrop(event, entry) {
    if (!dragRow || dropRefusal(entry, dragRow)) return
    event.preventDefault()
    setDropTarget(entry.id)
  }

  function handleDrop(event, entry) {
    event.preventDefault()
    setDropTarget(null)
    const row = dragRow
    setDragRow(null)
    if (!row) return
    const refusal = dropRefusal(entry, row)
    if (refusal) { setError(refusal); return }
    // A divided row cannot be assumed whole — which of its portions this covers is a real question, and
    // the same picker the panel uses answers it.
    if (claimablePortions(row).length > 1) {
      setPendingDrop({ entry, row, targetLabel: entryLabel(entry) })
      return
    }
    commitDrop(entry, row, { amount: row.unclaimed, label: null })
  }

  async function commitDrop(entry, row, portion) {
    setBusy(true)
    setError('')
    try {
      if (entry.kind === 'record') {
        await api.addReimbursementClaims(entry.id, [
          { txn_id: row.txn_id, amount: portion.amount, label: portion.label },
        ])
      } else {
        await api.createReimbursement({
          claims: [
            { txn_id: entry.row.txn_id, amount: entry.row.unclaimed, label: null },
            { txn_id: row.txn_id, amount: portion.amount, label: portion.label },
          ],
        })
      }
      setPendingDrop(null)
      afterChange()
    } catch (err) {
      setError(err?.message || 'These could not be matched.')
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <AppDialog
      title="Reimbursements"
      description="Money that left as an expense and is expected back. Completed ones drop off this list."
      onClose={onClose}
      width="min(700px, 100%)"
      actions={<Button variant="ghost" onClick={onClose}>Close</Button>}
    >
      {report === null && !error ? <Spinner /> : null}
      {error ? <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{error}</div> : null}

      {report ? (
        <div style={{ display: 'grid', gap: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>Still outstanding</span>
            {/* A magnitude: the label already says which way this money points, and a signed figure
                under it reads as a double negative. The per-row residuals below stay signed — nothing
                but the number states their direction there, and their colour keys off it. */}
            <span style={{ fontSize: 16, fontWeight: 600 }}>{formatMoneyMagnitude(Math.abs(report.total))}</span>
          </div>

          {!board.expenses.length && !board.income.length ? (
            <EmptyState message="Nothing is waiting to come back." />
          ) : null}

          {pendingDrop ? (
            /* The dragged row is divided, so which of its portions this covers is a real question rather
               than something to assume. Shown in place of the columns rather than as a second overlay:
               the answer replaces the drag, it does not sit on top of it. */
            <div style={{ display: 'grid', gap: 6 }}>
              <div style={{ fontSize: 12.5 }}>
                <strong>{pendingDrop.row.payee}</strong> → {pendingDrop.targetLabel}
              </div>
              <ClaimPortionPicker
                portions={claimablePortions(pendingDrop.row)}
                remainder={claimRemainder(pendingDrop.row)}
                unclaimed={pendingDrop.row.unclaimed}
                receivable={pendingDrop.row.receivable}
                busy={busy}
                confirmLabel="Match these"
                onCancel={() => setPendingDrop(null)}
                onConfirm={portion => commitDrop(pendingDrop.entry, pendingDrop.row, portion)}
              />
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 14 }}>
              <Section
                title="Expected"
                note="Drag a payment from the right onto what it repays."
              >
                {board.expenses.map(entry => (
                  <BoardEntry
                    key={`${entry.kind}-${entry.id}`}
                    entry={entry}
                    dropTarget={dropTarget === entry.id}
                    onOpen={() => openEntry(entry)}
                    onDragOver={event => allowDrop(event, entry)}
                    onDragLeave={() => setDropTarget(null)}
                    onDrop={event => handleDrop(event, entry)}
                  />
                ))}
                {board.expenses.length ? null : (
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>Nothing owed back.</div>
                )}
              </Section>

              <Section title="Received" note="Not yet matched to anything.">
                {board.income.map(entry => (
                  <button
                    key={entry.id}
                    type="button"
                    draggable
                    onDragStart={() => setDragRow(entry.row)}
                    onDragEnd={() => { setDragRow(null); setDropTarget(null) }}
                    onClick={() => openLooseRow(entry.row)}
                    style={{ ...looseRowStyle, cursor: 'grab' }}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {entry.row.payee}
                    </span>
                    <span style={{ textAlign: 'right', color: getTransactionAmountColor(entry.row.unclaimed) }}>
                      {formatTransactionAmount(entry.row.unclaimed)}
                    </span>
                  </button>
                ))}
                {board.income.length ? null : (
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>Nothing waiting to be matched.</div>
                )}
              </Section>
            </div>
          )}
        </div>
      ) : null}

      {looseTxn ? (
        // Centered rather than floating, the same choice the rule-suggestion review makes when it hosts
        // this panel from inside a dialog: a floating panel measures and snaps on open, which reads as a
        // stutter on top of an overlay that is already placed.
        <div style={{ position: 'fixed', inset: 0, zIndex: 960 }}>
          <TransactionDetail
            txn={looseTxn}
            categories={categories}
            onAddCategory={onAddCategory}
            showPayeeActivity={false}
            onClose={() => { setLooseTxn(null); afterChange() }}
            // Tracking a row from in here changes both piles and the headline, so the report reloads
            // rather than waiting for the panel to close.
            onReconcile={(txnId, patch) => { afterChange(); if (patch === null) setLooseTxn(null) }}
          />
        </div>
      ) : null}

      {editing?.linkId ? (
        <ReimbursementEditorDialog
          linkId={editing.linkId}
          txnId={editing.txnId}
          categories={categories}
          onAddCategory={onAddCategory}
          onClose={() => setEditing(null)}
          onSaved={afterChange}
        />
      ) : null}
    </AppDialog>,
    document.body,
  )
}

// A right-column row and a nested member: two columns, since the payee and the amount are all there is
// to say once the column heading has said which side it is.
const looseRowStyle = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) 100px',
  gap: 8,
  alignItems: 'center',
  fontSize: 12.5,
  textAlign: 'left',
  padding: '6px 8px',
  borderRadius: 6,
  background: 'var(--surface2)',
  border: '1px solid var(--border)',
  color: 'var(--text)',
  font: 'inherit',
}

/*
 * One entry in the "Expected" column: a reimbursement with its members nested, or an expense nothing
 * has claimed yet. Both are drop targets and both open on click, because whether a row happens to carry
 * a record is not a distinction the reader should have to hold.
 *
 * The nested rows show **this record's claim**, not each transaction's whole amount — a payment split
 * across two reimbursements appears under both, and stating its full value in each would double it on
 * screen.
 */
function BoardEntry({ entry, dropTarget, onOpen, onDragOver, onDragLeave, onDrop }) {
  const tracked = entry.kind === 'record'
  const amount = tracked ? entry.reimbursement.residual : entry.row.unclaimed
  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{
        borderRadius: 6,
        border: `1px solid ${dropTarget ? 'var(--accent)' : 'var(--border)'}`,
        background: dropTarget
          ? 'color-mix(in srgb, var(--accent) 12%, var(--surface2))'
          : 'var(--surface2)',
      }}
    >
      <button type="button" onClick={onOpen} style={{ ...looseRowStyle, width: '100%', background: 'none', border: 'none' }}>
        <span style={{ fontWeight: tracked ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {tracked ? reimbursementListLabel(entry.reimbursement) : entry.row.payee}
        </span>
        <span style={{ textAlign: 'right', color: getTransactionAmountColor(amount) }}>
          {formatTransactionAmount(amount)}
        </span>
      </button>
      {tracked ? (
        <div style={{ display: 'grid', gap: 2, padding: '0 8px 6px 20px' }}>
          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
            {residualSummary(entry.reimbursement)}
          </div>
          {entry.members.map(member => (
            <div key={member.txn_id} style={{
              display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 90px', gap: 8, fontSize: 12,
            }}>
              <span style={{ color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {member.payee}
              </span>
              <span style={{ textAlign: 'right', color: getTransactionAmountColor(member.claim) }}>
                {formatTransactionAmount(member.claim)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}


function Section({ title, note, children }) {
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {title}
      </div>
      {note ? <div style={{ fontSize: 12, color: 'var(--muted)' }}>{note}</div> : null}
      <div style={{ display: 'grid', gap: 3 }}>{children}</div>
    </div>
  )
}
