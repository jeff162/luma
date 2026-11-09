// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../lib/api.js'
import { txnMutations } from '../lib/txnMutations.js'
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
  UNASSIGNED_OWNER,
} from '../lib/reimbursements.js'
import ClaimPortionPicker from './ClaimPortionPicker.jsx'
import OwnerChip, { ownerChipLabels } from './OwnerChip.jsx'
import ReimbursementEditorDialog from './ReimbursementEditorDialog.jsx'
import TransactionDetail from './TransactionDetail.jsx'
import { UndoToast } from './CategoryTreePrimitives.jsx'
import { Button, EmptyState, Spinner } from './ui.jsx'
import FloatingDialog from './FloatingDialog.jsx'
import { DRAG_SOURCE_STYLE, startPointerDrag, useDropZone } from '../lib/pointerDrag.js'

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
  // A received row opens its transaction, not a reimbursement editor — see openLooseRow.
  const [looseTxn, setLooseTxn] = useState(null)
  // Which left-column entry a dragged row is over, and the drop awaiting a portion choice.
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
  // One pill per owner on the Expected side, Unassigned last since it is nobody's name.
  const boardOwners = [...new Map(allOwners.map(o => [o.id, o])).values()].sort((a, b) =>
    (a.id === UNASSIGNED_OWNER) - (b.id === UNASSIGNED_OWNER) || a.name.localeCompare(b.name))
  const chipLabels = ownerChipLabels(boardOwners)
  const filtered = everything.expenses.length - board.expenses.length
  // What the narrowed list actually adds up to. The headline above stays the *group's whole balance*,
  // which is the property that makes it trustworthy — so with a filter on, the two would silently
  // disagree unless the subset states its own figure.
  const shownTotal = board.expenses.reduce((sum, entry) => sum
    + (entry.kind === 'record' ? entry.reimbursement.residual : entry.row.unclaimed), 0)
  // Worth naming an owner on a row, or filtering by one, only where the board holds more than one.
  // Otherwise it is the same name repeated down the column, which says nothing and costs the label its room.
  const showOwners = boardOwners.length > 1

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
   * A row in the Received column opens the **transaction**. A payment on its own is not a reimbursement
   * to edit, and its detail panel's reimbursable section already offers what it can repay.
   *
   * Fetched by id because a loose row carries only date, payee and amount — the panel needs the whole
   * transaction.
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

  // Every Expected entry opens the reimbursement editor; an untracked expense opens it as a draft that
  // nothing is written for until it is saved. Whether a record exists yet is not something the reader
  // should have to know to predict which screen a click opens.
  function openEntry(entry) {
    setEditing(entry.kind === 'record'
      ? { linkId: entry.id, txnId: entry.members?.[0]?.txn_id }
      : { untrackedRow: entry.row, txnId: entry.row.txn_id })
  }

  function handleDrop(entry, row) {
    setDropTarget(null)
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
      await txnMutations.completeReimbursement(entry.id, {})
      setUndo({
        title: 'Completed',
        description: `${entryLabel(entry)} is finished and has left this list.`,
        reverse: () => txnMutations.reopenReimbursement(entry.id),
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

  // A report, so it floats like the others: it can be moved aside while the ledger behind is checked.
  // What it opens sits beside it rather than inside, so each takes its own place in the stack.
  return createPortal(
    <>
    <FloatingDialog
      panelKey="ui.reimbursementsReport.panel"
      title="Reimbursements"
      description="Money that left as an expense and is expected back. Completed ones drop off this list."
      onClose={onClose}
      width={700}
      bodyStyle={{ display: 'flex', flexDirection: 'column' }}
      actions={<Button variant="secondary" onClick={onClose}>Close</Button>}
    >
      {report === null && !error ? <Spinner /> : null}
      {error ? <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{error}</div> : null}

      {report ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: '1 1 auto', minHeight: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>Still outstanding</span>
            {/* A magnitude: the label already says which way this money points, and a signed figure
                under it reads as a double negative. The per-row residuals below stay signed — nothing
                but the number states their direction there, and their colour keys off it. */}
            <span style={{ fontSize: 16, fontWeight: 600 }}>{formatMoneyMagnitude(Math.abs(report.total))}</span>
          </div>

          {/* The same narrowing a Tasks reminder arrives with, made something the reader can set. It
              narrows the Expected side only, as that narrowing always has — see `reimbursementBoard`. */}
          {showOwners ? (
            <div role="group" aria-label="Show whose" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <OwnerChip owner={{ name: 'Everyone' }} swatch={false} selected={!owner} onClick={() => setOwner(null)} />
              {boardOwners.map(o => (
                <OwnerChip key={o.id} owner={o} selected={owner === o.id} onClick={() => setOwner(o.id)} />
              ))}
            </div>
          ) : null}

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
                variant="secondary"
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
            /* Each column scrolls on its own, in whatever height the dialog has left. Scrolled together, a
               long Expected column carried the Received one out of view on the way down to a target, so
               a payment and what it repays could not both be on screen. The floor keeps a few rows
               visible on a short window; below it the whole body scrolls instead. */
            <div style={{
              display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gridTemplateRows: 'minmax(0, 1fr)',
              gap: 14, flex: '1 1 auto', minHeight: 200,
            }}>
              <Section
                title="Expected"
                note="Drag a payment from the right onto what it repays."
              >
                {board.expenses.map(entry => (
                  <BoardEntry
                    key={`${entry.kind}-${entry.id}`}
                    entry={entry}
                    ownerLabels={showOwners ? chipLabels : null}
                    dropTarget={dropTarget === entry.id}
                    busy={busy}
                    onOpen={() => openEntry(entry)}
                    onComplete={() => completeEntry(entry)}
                    onDropTargetChange={over => setDropTarget(over ? entry.id : null)}
                    onDrop={row => handleDrop(entry, row)}
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
                    onPointerDown={event => startPointerDrag(event, {
                      onStart: () => entry.row,
                      onEnd: () => setDropTarget(null),
                    })}
                    onClick={() => openLooseRow(entry.row)}
                    style={{ ...looseRowStyle, ...DRAG_SOURCE_STYLE, cursor: 'grab' }}
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

    </FloatingDialog>
      {looseTxn ? (
        // Centered rather than floating, the same choice the rule-suggestion review makes when it hosts
        // this panel: a floating panel measures and snaps on open, which reads as a stutter on top of a
        // surface that is already placed.
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
        // Above every dialog, as the toast for an action taken in one has to be.
        <UndoToast
          title={undo.title}
          description={undo.description}
          zIndex={1300}
          onUndo={runUndo}
          onDismiss={() => setUndo(null)}
        />
      ) : null}

      {editing ? (
        <ReimbursementEditorDialog
          linkId={editing.linkId}
          untrackedRow={editing.untrackedRow}
          txnId={editing.txnId}
          categories={categories}
          onAddCategory={onAddCategory}
          onClose={() => setEditing(null)}
          onSaved={afterChange}
        />
      ) : null}
    </>,
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
function BoardEntry({ entry, ownerLabels, dropTarget, busy, onOpen, onComplete, onDropTargetChange, onDrop }) {
  const [hovered, setHovered] = useState(false)
  // Only a target that can take the row lights up, so the refusal reasons double as the "is this a
  // target" test. Every entry still takes the drop, so landing on one that cannot says why.
  const dropRef = useDropZone({
    onEnter: row => onDropTargetChange(!dropRefusal(entry, row)),
    onLeave: () => onDropTargetChange(false),
    onDrop: row => onDrop(row),
  })
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
  const owners = ownerLabels ? entry.owners || [] : []
  return (
    /* The whole card opens its reimbursement (a draft one, if untracked), not just the headline: the
       summary and member lines are most of its area. The click is taken here so the headline button
       reaches it by bubbling, which keeps Enter on the focused headline doing the same thing. */
    <div
      ref={dropRef}
      onClick={onOpen}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        borderRadius: 6,
        cursor: 'pointer',
        border: `1px solid ${dropTarget ? 'var(--accent)' : 'var(--border)'}`,
        background: dropTarget
          ? 'color-mix(in srgb, var(--accent) 12%, var(--surface2))'
          : hovered
            ? 'color-mix(in srgb, var(--accent) 5%, var(--surface2))'
            : 'var(--surface2)',
      }}
    >
      <button type="button" title="Open" style={{ ...looseRowStyle, width: '100%', background: 'none', border: 'none', cursor: 'inherit' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
          {/* The due marker and the owners go ahead of the name rather than after it: the marker is the
              reason the row is being looked at, and anything at the end of a truncating label is the
              first thing to disappear. */}
          {due ? <span title={`Due since ${entry.dueOn}`} style={{ color: 'var(--danger)', flexShrink: 0 }}>●</span> : null}
          {owners.map(owner => <OwnerChip key={owner.id} owner={owner} label={ownerLabels.get(owner.id)} />)}
          <span style={{ fontWeight: tracked ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {tracked ? reimbursementListLabel(entry.reimbursement) : entry.row.payee}
          </span>
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
              <Button
                variant="secondary"
                disabled={busy}
                onClick={event => { event.stopPropagation(); onComplete() }}
              >Mark complete</Button>
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
  const scrollRef = useDropZone({ autoScroll: true })
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {title}
      </div>
      {note ? <div style={{ fontSize: 12, color: 'var(--muted)' }}>{note}</div> : null}
      <div ref={scrollRef} style={{
        display: 'grid', gap: 3, alignContent: 'start', flex: '1 1 auto', minHeight: 0, overflowY: 'auto',
        scrollbarWidth: 'thin',
      }}>{children}</div>
    </div>
  )
}
