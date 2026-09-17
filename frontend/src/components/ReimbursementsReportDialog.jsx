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
  isDue,
  primaryAction,
  reimbursementBoard,
  reimbursementListLabel,
  residualSummary,
} from '../lib/reimbursements.js'
import ClaimPortionPicker from './ClaimPortionPicker.jsx'
import ReimbursementEditorDialog from './ReimbursementEditorDialog.jsx'
import TransactionDetail from './TransactionDetail.jsx'
import { UndoToast } from './CategoryTreePrimitives.jsx'
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
 * **It owns the reminder default**, which is the one piece of configuration this feature has. It lives
 * here rather than on the Settings page because this is the surface where the outstanding money already
 * is — it is where someone goes when wondering why something is being asked about, and one orphan row
 * on a long page of unrelated machinery is not somewhere anyone would find it. The setting is
 * ledger-level: one ledger has one answer, and the reminders are shown to everyone.
 *
 * **Opened from a Tasks reminder it arrives narrowed** — to that owner, and to what is actually due — so
 * the screen and the badge cannot disagree about which rows were meant. The narrowing is visible and
 * removable rather than silent, because a report that quietly hid most of its contents would be worse
 * than one that did not filter at all.
 *
 * A dialog rather than a page, following the Amazon reconciliation report it is modelled on: it is a
 * periodic review of a pile of work rather than a place to navigate to and dwell in.
 */
export default function ReimbursementsReportDialog({
  categories, onAddCategory, onClose, onChanged,
  // The Tasks deep link's narrowing. `ownerId` uses the same `unassigned` token the transaction list's
  // owner facet does, so the task's link and this filter name the same set.
  ownerId = null,
  dueOnly = false,
}) {
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
  // The last action, and how to put it back. A drag lands on whatever the cursor was over, so a pairing
  // is the one action here that is routinely made by accident — and the dialog saves as it goes, which
  // leaves nothing for a Cancel to discard. See `commitDrop` for what each reversal restores.
  const [undo, setUndo] = useState(null)
  // The narrowing starts as the caller asked for it and is then the reader's to drop, which is why it is
  // state rather than a prop read straight through.
  const [owner, setOwner] = useState(ownerId)
  const [showDueOnly, setShowDueOnly] = useState(dueOnly)
  const [savingDays, setSavingDays] = useState(false)

  const load = useCallback(() => {
    let cancelled = false
    api.getOutstandingReimbursements()
      .then(result => { if (!cancelled) setReport(result) })
      .catch(err => { if (!cancelled) setError(err?.message || 'This report could not be loaded.') })
    return () => { cancelled = true }
  }, [])

  useEffect(load, [load])

  const board = reimbursementBoard(report, { ownerId: owner, dueOnly: showDueOnly })
  const reminderDays = report?.reminder_days || 0
  // Counted off the unfiltered report so the control can say what dropping the filter would reveal.
  const everything = reimbursementBoard(report)
  const dueCount = everything.expenses.filter(entry => isDue(entry.dueOn)).length
  const allOwners = everything.expenses.flatMap(entry => entry.owners || [])
  const ownerName = owner && allOwners.find(o => o.id === owner)?.name
  const filtered = everything.expenses.length - board.expenses.length
  // What the narrowed list actually adds up to. The headline above stays the *group's whole balance*,
  // which is the property that makes it trustworthy — so with a filter on, the two would silently
  // disagree unless the subset states its own figure.
  const shownTotal = board.expenses.reduce((sum, entry) => sum
    + (entry.kind === 'record' ? entry.reimbursement.residual : entry.row.unclaimed), 0)
  // Worth naming an owner on a row only where the board holds more than one. Otherwise it is the same
  // name repeated down the column, which says nothing and costs the label its room.
  const showOwners = new Set(allOwners.map(o => o.id)).size > 1

  async function saveReminderDays(days) {
    setSavingDays(true)
    setError('')
    try {
      await api.setReimbursementSettings(days)
      load()
    } catch (err) {
      setError(err?.message || 'That reminder setting could not be saved.')
    } finally {
      setSavingDays(false)
    }
  }

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
      let reverse
      if (entry.kind === 'record') {
        await api.addReimbursementClaims(entry.id, [
          { txn_id: row.txn_id, amount: portion.amount, label: portion.label },
        ])
        // The drop adds this transaction to the record, so taking it off is the whole reversal: a row
        // the record *already* claims is refused as a drop (`dropRefusal`), which is what keeps this
        // from having to restore a claim it replaced.
        reverse = () => api.removeReimbursementTransaction(entry.id, row.txn_id)
      } else {
        const created = await api.createReimbursement({
          claims: [
            { txn_id: entry.row.txn_id, amount: entry.row.unclaimed, label: null },
            { txn_id: row.txn_id, amount: portion.amount, label: portion.label },
          ],
        })
        // Deleting the record unpairs both rows and leaves the transactions untouched, which is exactly
        // the state before the drop — the record did not exist.
        reverse = () => api.deleteReimbursement(created.id)
      }
      setPendingDrop(null)
      setUndo({
        title: 'Paired',
        description: `${row.payee} now counts toward ${entryLabel(entry)}.`,
        reverse,
      })
      afterChange()
    } catch (err) {
      setError(err?.message || 'These could not be matched.')
    } finally {
      setBusy(false)
    }
  }

  /* Completing from the board, for the one ending that needs no decision: the two sides balance, so
   * there is nothing to move and no category to choose (the editor completes such a record on one click
   * too). Reopening restores it, so this is offered with the same undo a pairing gets. */
  async function completeEntry(entry) {
    setBusy(true)
    setError('')
    try {
      await api.completeReimbursement(entry.id, {})
      setUndo({
        title: 'Completed',
        description: `${entryLabel(entry)} is finished and has left this list.`,
        reverse: () => api.reopenReimbursement(entry.id),
      })
      afterChange()
    } catch (err) {
      setError(err?.message || 'That reimbursement could not be completed.')
    } finally {
      setBusy(false)
    }
  }

  async function runUndo() {
    const action = undo
    setUndo(null)
    if (!action) return
    setBusy(true)
    setError('')
    try {
      await action.reverse()
      afterChange()
    } catch (err) {
      setError(err?.message || 'That could not be undone.')
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

          {/* The narrowing a task's link arrived with, stated and removable. A report that quietly hid
              most of its rows would be worse than one that did not filter — the reader would be looking
              at a total that did not match the list under it. */}
          {filtered > 0 || owner || showDueOnly ? (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
              fontSize: 12.5, padding: '6px 8px', borderRadius: 6,
              background: 'var(--surface2)', border: '1px solid var(--border)',
            }}>
              <span style={{ color: 'var(--muted)' }}>
                Showing {showDueOnly ? 'what is due' : 'everything'}
                {ownerName ? ` on ${ownerName}'s accounts` : (owner ? ' on unassigned accounts' : '')}
                {' '}&mdash; {formatMoneyMagnitude(Math.abs(shownTotal))} of the total above
                {filtered > 0 ? ` · ${filtered} hidden` : ''}
              </span>
              <Button
                variant="ghost"
                small
                onClick={() => { setOwner(null); setShowDueOnly(false) }}
                disabled={!owner && !showDueOnly}
              >Show everything</Button>
            </div>
          ) : null}

          {!board.expenses.length && !board.income.length ? (
            <EmptyState message={
              owner || showDueOnly
                ? 'Nothing here matches that. Show everything to see the rest.'
                : 'Nothing is waiting to come back.'
            } />
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
                    showOwner={showOwners}
                    dropTarget={dropTarget === entry.id}
                    busy={busy}
                    onOpen={() => openEntry(entry)}
                    onComplete={() => completeEntry(entry)}
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

          {/* The one piece of configuration this feature has, at the foot of the surface that shows what
              it acts on. Stated as a sentence rather than as a labelled field because it is a single
              number with an obvious unit, and 0 is a real answer — the disable switch, which is not a
              dead end since a record can still be given a date of its own. */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
            fontSize: 12.5, color: 'var(--muted)',
            borderTop: '1px solid var(--border)', paddingTop: 10,
          }}>
            <label htmlFor="reimbursement-reminder-days">Ask about anything still owed after</label>
            <input
              id="reimbursement-reminder-days"
              type="number"
              min="0"
              max="3650"
              defaultValue={reminderDays}
              disabled={savingDays}
              // On blur rather than on every keystroke: this writes a household-wide setting and
              // reloads the report, so a request per digit would be both wasteful and visibly jumpy.
              onBlur={e => {
                const next = Number(e.target.value)
                if (Number.isFinite(next) && next !== reminderDays) saveReminderDays(next)
              }}
              style={{
                font: 'inherit', fontSize: 12.5, width: 64, padding: '3px 6px', borderRadius: 6,
                border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)',
              }}
            />
            <span>
              days{reminderDays ? '' : ' — 0 turns the default reminder off'}
              {dueCount ? ` · ${dueCount} past that now` : ''}
            </span>
          </div>
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

      {undo ? (
        // Above the dialog that raised it: the shared toast's default sits below an AppDialog, where it
        // would be hidden behind this surface.
        <UndoToast
          title={undo.title}
          description={undo.description}
          zIndex={1300}
          onUndo={runUndo}
          onDismiss={() => setUndo(null)}
        />
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
function BoardEntry({ entry, showOwner, dropTarget, busy, onOpen, onComplete, onDragOver, onDragLeave, onDrop }) {
  const [hovered, setHovered] = useState(false)
  const tracked = entry.kind === 'record'
  const amount = tracked ? entry.reimbursement.residual : entry.row.unclaimed
  const due = isDue(entry.dueOn)
  // The ending that needs no decision — the two sides balance, so completing moves nothing. Offered on
  // the row because this is where the reader already is; everything else stays in the editor, where the
  // residual and the category question are.
  const readyToComplete = tracked && primaryAction(entry.reimbursement) === 'complete'
  // Whose it is, where that is not the same answer for everything on screen. A record whose expenses
  // span two people names both — the debt genuinely concerns both, and picking one would hide it from
  // the other.
  const owners = showOwner ? (entry.owners || []).map(owner => owner.name).join(' & ') : ''
  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        borderRadius: 6,
        border: `1px solid ${dropTarget ? 'var(--accent)' : 'var(--border)'}`,
        background: dropTarget
          ? 'color-mix(in srgb, var(--accent) 12%, var(--surface2))'
          : 'var(--surface2)',
      }}
    >
      {/* The row opens its record (or its transaction), which nothing about a list row says on its own —
          the ledger's ↗ on hover is how the rest of the app makes that readable. */}
      <button type="button" onClick={onOpen} title="Open" style={{ ...looseRowStyle, width: '100%', background: 'none', border: 'none' }}>
        <span style={{ fontWeight: tracked ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {/* Ahead of the name rather than after it: it is the reason the row is being looked at, and a
              marker at the end of a truncating label is the first thing to disappear. */}
          {due ? <span title={`Due since ${entry.dueOn}`} style={{ color: 'var(--danger)' }}>● </span> : null}
          {tracked ? reimbursementListLabel(entry.reimbursement) : entry.row.payee}
          {owners ? <span style={{ color: 'var(--muted)', fontWeight: 400 }}> · {owners}</span> : null}
          <span aria-hidden="true" style={{ color: 'var(--muted)', opacity: hovered ? 1 : 0 }}> ↗</span>
        </span>
        <span style={{ textAlign: 'right', color: getTransactionAmountColor(amount) }}>
          {formatTransactionAmount(amount)}
        </span>
      </button>
      {tracked ? (
        <div style={{ display: 'grid', gap: 2, padding: '0 8px 6px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
              {residualSummary(entry.reimbursement)}
            </span>
            {readyToComplete ? (
              <Button small variant="ghost" disabled={busy} onClick={onComplete}>Mark complete</Button>
            ) : null}
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
