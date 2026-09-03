// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../lib/api.js'
import ClaimPortionPicker from './ClaimPortionPicker.jsx'
import { formatTransactionAmount, getTransactionAmountColor } from '../lib/moneyDisplay.js'
import {
  claimablePortions,
  claimRemainder,
  completeExplanation,
  completionTargets,
  hasRepayment,
  needsTargetChoice,
  primaryAction,
  reimbursementDisplayLabel,
  reimbursementStatus,
  residualSummary,
} from '../lib/reimbursements.js'
import CategoryPicker from './CategoryPicker.jsx'
import { AppConfirmDialog, AppDialog, Button, Input, Spinner } from './ui.jsx'

/*
 * The reimbursement editor: what is owed, what came back, and the one decision only the user can make.
 *
 * **Completing is the reason this screen exists.** A repayment that fell short and one that never
 * arrived are identical by amount, so nothing can finish a reimbursement automatically. Where money is
 * left over, completing *moves it between categories*, which is what separates this dialog from the
 * purchase editor it otherwise mirrors: grouping payments as a purchase changes nothing and needs no
 * undo beyond unlinking, while this rewrites a transaction's allocations, so it has an explicit
 * reversal and the record that drives it is refused deletion while it exists.
 *
 * **Repaid in full is the ordinary ending and completes with no move at all.** It gets the same button
 * and no category question, because there is nothing to decide — the two sides already cancel inside
 * the excluded group. Treating that case as an error is what left finished reimbursements stranded on
 * the open list with no way to close them.
 *
 * **Complete sits in the action row and only *looks* like the main verb when it is one.** Cancel ·
 * Complete · Save, with the accent on Complete exactly when the two sides balance — the one case with
 * nothing to decide. A shortfall or a surplus keeps the accent on Save, because closing a record with
 * money still unaccounted for is a judgement the user may not want to make on this visit. With nothing
 * repaid at all it stays reachable but unaccented, and the panel it opens says what it is really
 * claiming: not "the rest was a real cost" but the whole amount, recorded as spending in the month of
 * the expense. Blocking that outcome would deny a real one — sometimes nobody pays you back — while
 * accenting it would invite a click on a record that is merely unfinished.
 *
 * **The sign picks the target, so the user is never asked to.** A shortfall settles against an expense
 * and a surplus against a repayment (see `lib/reimbursements.js`), and the only question left is
 * *which* one, asked only when that role has more than one candidate — nothing in the ledger can say
 * which expense fell short.
 *
 * **Settling a shortfall changes an earlier month, and the dialog says so before the click.** That is
 * the design's one surprising consequence and the difference between a deliberate correction and a
 * number that moved for no visible reason next time February is opened.
 *
 * **A reimbursement covers a *portion* of a transaction, not the transaction.** The member list therefore
 * shows this link's claim against each row rather than the row's whole receivable, and says so where
 * the two differ — a $250 claim on a $750 charge whose other portions belong to other people.
 *
 * **Candidates to link come from the loose list, not a search box.** Receivable money that no
 * reimbursement has claimed is exactly what would be attached here, and the server already computes it
 * for the outstanding report. A free search would offer thousands of rows that could not be added, and
 * a row divided between people offers its portions individually so picking one says whose money it is.
 *
 * It portals to the body for the same load-bearing reason `PurchaseEditorDialog` does: one of the hosts
 * for this editor is a ledger row, and a `position: fixed` overlay inside a table is stacked against
 * whatever ancestor established a containing block rather than the viewport.
 *
 * Fields are explicit-submit; linking, settling and unlinking act at once, each behind its own confirm
 * or its own button. The form is seeded once and deliberately not reset from a reload, so refetching
 * after a link cannot discard a counterparty the user had already typed.
 */
export default function ReimbursementEditorDialog({ linkId, txnId, categories, onAddCategory, onClose, onSaved }) {
  const [reimbursement, setReimbursement] = useState(null)
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [pendingRemoval, setPendingRemoval] = useState(null)
  const [unlinking, setUnlinking] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [loose, setLoose] = useState([])
  const [completeOpen, setCompleteOpen] = useState(false)
  const [completeCategory, setCompleteCategory] = useState(null)
  const [completeTarget, setCompleteTarget] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api.getReimbursement(linkId)
      .then(record => {
        if (cancelled) return
        setReimbursement(record)
        // Seeded once, on the load that opened the dialog. See the header.
        setForm(current => current || (record ? {
          counterparty: record.counterparty || '',
        } : null))
      })
      .catch(err => { if (!cancelled) setError(err?.message || 'This reimbursement could not be loaded.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [linkId])

  const members = reimbursement?.members || []
  const status = reimbursementStatus(reimbursement)
  const targets = completionTargets(reimbursement)
  // Repaid in full needs no category and no target — the button is the whole interaction.
  const nothingToMove = status === 'square'
  const completeIsPrimary = primaryAction(reimbursement) === 'complete'
  const completeAvailable = !!reimbursement && status !== 'completed' && status !== 'none'
  // Completing something nothing has been repaid against is a real outcome — the write-off — so it is
  // reachable rather than blocked. What keeps it from being an accidental click is that it is never the
  // accented button and it cannot happen without choosing a category for the money first.
  const nothingRepaid = !!reimbursement && !hasRepayment(reimbursement)
  // A completed record whose typed fields still match what is stored: nothing is pending, so the footer
  // is a single Close. Comparing against the record rather than tracking a dirty flag means typing and
  // then undoing it settles back to Close, which is the honest reading of "nothing to save".
  const fieldsEdited = !!reimbursement && !!form
    && form.counterparty !== (reimbursement.counterparty || '')
  const settledAndUnedited = status === 'completed' && !fieldsEdited
  const completeTitle = nothingToMove
    ? 'The repayments match what was owed — close this reimbursement'
    : nothingRepaid
      ? 'Nothing has been received. Record the whole amount as spending and close this reimbursement'
      : 'Move what is left over into a real category and close this reimbursement'

  function publish(next) {
    setReimbursement(next)
    onSaved?.(next)
    if (!next) onClose?.()
  }

  async function saveFields() {
    setSaving(true)
    setError('')
    try {
      const updated = await api.updateReimbursement(reimbursement.id, {
        counterparty: form.counterparty,
      })
      setReimbursement(updated)
      onSaved?.(updated)
      onClose?.()
    } catch (err) {
      setError(err?.message || 'The reimbursement could not be saved.')
      setSaving(false)
    }
  }

  async function openLinkPicker() {
    setError('')
    try {
      const report = await api.getOutstandingReimbursements()
      setLoose(report.loose || [])
      setLinkOpen(true)
    } catch (err) {
      setError(err?.message || 'The unlinked receivables could not be loaded.')
    }
  }

  async function linkPortion(row, portion) {
    setLinkOpen(false)
    setError('')
    try {
      publish(await api.addReimbursementClaims(reimbursement.id, [
        { txn_id: row.txn_id, amount: portion.amount, label: portion.label },
      ]))
    } catch (err) {
      setError(err?.message || 'That transaction could not be added.')
    }
  }

  async function confirmRemoval() {
    const target = pendingRemoval
    setPendingRemoval(null)
    if (!target) return
    setError('')
    try {
      const result = await api.removeReimbursementTransaction(reimbursement.id, target.txn_id)
      publish(result.reimbursement || null)
    } catch (err) {
      setError(err?.message || 'That transaction could not be removed.')
    }
  }

  async function confirmUnlink() {
    setUnlinking(false)
    setError('')
    try {
      await api.deleteReimbursement(reimbursement.id)
      publish(null)
    } catch (err) {
      setError(err?.message || 'This reimbursement could not be unlinked.')
    }
  }

  async function confirmComplete() {
    setError('')
    try {
      const updated = await api.completeReimbursement(reimbursement.id, {
        category_id: nothingToMove ? null : completeCategory,
        target_txn_id: nothingToMove ? null : (completeTarget || null),
      })
      setCompleteOpen(false)
      setCompleteCategory(null)
      setCompleteTarget('')
      publish(updated)
    } catch (err) {
      setError(err?.message || 'This reimbursement could not be completed.')
    }
  }

  async function reopenReimbursement() {
    setError('')
    try {
      publish(await api.reopenReimbursement(reimbursement.id))
    } catch (err) {
      setError(err?.message || 'This reimbursement could not be reopened.')
    }
  }

  const completeReady = nothingToMove
    || (!!completeCategory && (!needsTargetChoice(reimbursement) || !!completeTarget))

  return createPortal(
    <AppDialog
      // Reads the *form*, not the saved record, so the heading follows the name as it is typed — which
      // is what says that field is the title.
      title={form ? reimbursementDisplayLabel({ counterparty: form.counterparty })
        : (reimbursement ? reimbursementDisplayLabel(reimbursement) : 'Reimbursement')}
      description={
        reimbursement
          ? 'Money that left as an expense and comes back later. Linking transactions changes nothing about them; settling moves what is left over into a real category.'
          : undefined
      }
      onClose={onClose}
      width="min(620px, 100%)"
      actions={
        <>
          {/* A finished record with nothing typed has no pending decision, and Cancel and Save would do
              the same thing as each other — so it offers one Close until a field is actually edited.
              Its fields stay editable on purpose: naming is documentation rather than an accounting
              fact, and the server allows it after completion for exactly that reason. An *open* record
              keeps Cancel · Complete · Save throughout, because Complete is a decision that may be
              about to be made. */}
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {reimbursement && !settledAndUnedited ? 'Cancel' : 'Close'}
          </Button>
          {reimbursement && status !== 'completed' ? (
            <Button
              variant={completeIsPrimary ? 'primary' : 'ghost'}
              onClick={() => {
                if (nothingToMove) { confirmComplete(); return }
                // Pre-picked when the role has one candidate; the panel asks only when it cannot know.
                setCompleteTarget(targets.length === 1 ? targets[0].txn_id : '')
                setCompleteOpen(true)
              }}
              disabled={saving || !completeAvailable || completeOpen}
              title={completeTitle}
            >Complete</Button>
          ) : null}
          {reimbursement && !settledAndUnedited ? (
            <Button
              variant={completeIsPrimary ? 'ghost' : 'primary'}
              onClick={saveFields}
              disabled={saving}
            >{saving ? 'Saving…' : 'Save'}</Button>
          ) : null}
        </>
      }
    >
      {loading ? <Spinner /> : null}

      {!loading && !reimbursement ? (
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>
          {error || 'This transaction is no longer part of a reimbursement.'}
        </div>
      ) : null}

      {reimbursement && form ? (
        <div style={{ display: 'grid', gap: 12 }}>
          {/* Labelled above the field rather than by placeholder alone: this *is* the record's name —
              what the board, the row cards and this heading all show — and a placeholder disappears the
              moment it is typed into, so once named, nothing on screen said which field held the name.
              The heading tracks it as it is typed for the same reason.

              **Name, not "who owes it".** A reimbursement is as often an occasion as a person, and a
              second free-text field beside it ("what it covers") was removed rather than relabelled: the
              name is free text already and shows everywhere the record does, while that field reached a
              single surface. */}
          <div style={{ display: 'grid', gap: 4, maxWidth: 320 }}>
            <label style={fieldLabelStyle} htmlFor="reimbursement-counterparty">Name</label>
            <Input
              id="reimbursement-counterparty"
              value={form.counterparty}
              onChange={value => setForm(prev => ({ ...prev, counterparty: value }))}
              placeholder="A name for this reimbursement"
              aria-label="Name"
            />
          </div>

          <div style={{ display: 'grid', gap: 3 }}>
            {members.map(member => (
              <MemberRow
                key={member.txn_id}
                member={member}
                isThisRow={member.txn_id === txnId}
                onRemove={status === 'completed' ? null : () => setPendingRemoval(member)}
              />
            ))}
          </div>

          {status === 'completed' ? null : (
            <div>
              <Button variant="ghost" small onClick={openLinkPicker}>Link another transaction…</Button>
            </div>
          )}

          <div style={{ display: 'grid', gap: 2, fontSize: 12.5, borderTop: '1px solid var(--border)', paddingTop: 6 }}>
            <TotalLine label="Spent" amount={reimbursement.owed} muted />
            <TotalLine label="Received" amount={reimbursement.repaid} muted />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
              <span>{residualSummary(reimbursement)}</span>
              {status === 'outstanding' || status === 'surplus'
                ? <span>{formatTransactionAmount(reimbursement.residual)}</span>
                : null}
            </div>
          </div>

          {status === 'completed' ? (
            <CompletedNote reimbursement={reimbursement} onReopen={reopenReimbursement} />
          ) : null}

          {completeOpen ? (
            <div style={{ display: 'grid', gap: 8, padding: 10, borderRadius: 6, background: 'var(--surface2)', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{completeExplanation(reimbursement)}</div>
              {!nothingToMove && needsTargetChoice(reimbursement) ? (
                <label style={{ display: 'grid', gap: 4, fontSize: 12.5 }}>
                  <span style={{ color: 'var(--muted)' }}>
                    {status === 'outstanding' ? 'Which expense fell short?' : 'Which repayment carries the surplus?'}
                  </span>
                  <select
                    value={completeTarget}
                    onChange={e => setCompleteTarget(e.target.value)}
                    style={{ font: 'inherit', padding: '4px 6px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
                  >
                    <option value="">Choose one…</option>
                    {targets.map(member => (
                      <option key={member.txn_id} value={member.txn_id}>
                        {member.date} · {member.payee} · {formatTransactionAmount(member.amount)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {/* Only asked where there is something to move. Repaid in full has no residual and so no
                  category question — offering one would imply a decision that does not exist. */}
              {nothingToMove ? null : (
                <div style={{ display: 'grid', gap: 4, fontSize: 12.5 }}>
                  <span style={{ color: 'var(--muted)' }}>Which category does it belong to?</span>
                  <CategoryPicker
                    value={completeCategory}
                    categories={categories}
                    compact
                    showSelectedBadge
                    onChange={setCompleteCategory}
                    onAddCategory={onAddCategory}
                    // The picker portals its dropdown to <body> at 1100, which is behind an AppDialog
                    // (1200) — it has to be raised to be visible from inside one.
                    panelZIndex={1300}
                  />
                </div>
              )}
              <div style={{ display: 'flex', gap: 6 }}>
                {/* Labelled for what it does, so it is not a second button reading "Complete" beside
                    the one in the action row that opened this. */}
                <Button small onClick={confirmComplete} disabled={!completeReady}>Move and complete</Button>
                <Button variant="ghost" small onClick={() => setCompleteOpen(false)}>Cancel</Button>
              </div>
            </div>
          ) : null}

          {status === 'completed' ? null : (
            <div>
              <Button
                variant="ghost"
                small
                onClick={() => setUnlinking(true)}
                title="Keep every transaction exactly as it is, but stop tracking them as one reimbursement"
              >Stop tracking this</Button>
            </div>
          )}

          {error ? <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{error}</div> : null}
        </div>
      ) : null}

      {pendingRemoval ? (
        <AppConfirmDialog
          title="Remove this transaction from the reimbursement?"
          description={
            members.length - 1 < 1
              ? 'That was the last one, so the reimbursement stops being tracked. The transaction stays exactly as it is.'
              : 'The transaction stays exactly as it is — it just stops counting toward this reimbursement.'
          }
          confirmLabel="Remove"
          onConfirm={confirmRemoval}
          onCancel={() => setPendingRemoval(null)}
        />
      ) : null}

      {unlinking ? (
        <AppConfirmDialog
          title="Stop tracking these together?"
          description={
            `The ${members.length} transactions stay exactly as they are — nothing is recategorized and `
            + 'no money moves. They simply stop being paired, and the money owed back goes back to being '
            + 'untracked. Pairing them again later is the undo.'
          }
          confirmLabel="Stop tracking"
          onConfirm={confirmUnlink}
          onCancel={() => setUnlinking(false)}
        />
      ) : null}

      {linkOpen ? (
        <AppDialog
          title="Link another transaction"
          description="Anything holding money in the Reimbursable group that is not already part of a reimbursement."
          onClose={() => setLinkOpen(false)}
          width="min(520px, 100%)"
          actions={<Button variant="ghost" onClick={() => setLinkOpen(false)}>Cancel</Button>}
        >
          {loose.length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
              Nothing else is waiting. A repayment has to be categorized to the Reimbursable group before
              it can be linked here.
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {loose.map(row => (
                <div key={row.txn_id} style={{ display: 'grid', gap: 3 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, color: 'var(--muted)' }}>
                    <span>{row.date} · {row.payee}</span>
                    <span style={{ color: getTransactionAmountColor(row.amount) }}>
                      {formatTransactionAmount(row.amount)}
                    </span>
                  </div>
                  {/* The same picker the detail panel uses. It has to be multi-select here too, and for
                      a reason particular to this surface: a reimbursement holds one claim per
                      transaction, so attaching a second portion of a row it already covers *replaces* the
                      first rather than adding to it. Picking the portions together is the only way to
                      claim both. */}
                  <ClaimPortionPicker
                    portions={claimablePortions(row)}
                    remainder={claimRemainder(row)}
                    unclaimed={row.unclaimed}
                    receivable={row.receivable}
                    confirmLabel="Add to this reimbursement"
                    onConfirm={portion => linkPortion(row, portion)}
                  />
                </div>
              ))}
            </div>
          )}
        </AppDialog>
      ) : null}
    </AppDialog>,
    document.body,
  )
}

function CompletedNote({ reimbursement, onReopen }) {
  const completion = reimbursement.completion || {}
  const moved = Math.abs(Number(completion.residual) || 0) >= 0.005
  return (
    <div style={{ display: 'grid', gap: 6, padding: 10, borderRadius: 6, background: 'var(--surface2)', border: '1px solid var(--border)' }}>
      <div style={{ fontSize: 12.5 }}>
        {moved
          ? `${formatTransactionAmount(completion.residual)} was moved out of the Reimbursable group.`
          : 'Repaid in full.'}
      </div>
      <div>
        {/* Not styled as danger: reopening restores the transaction's allocations exactly, from the
            record completing it stashed. It is the undo, not a second destructive act. */}
        <Button variant="ghost" small onClick={onReopen}>Reopen</Button>
      </div>
    </div>
  )
}

function MemberRow({ member, isThisRow, onRemove }) {
  return (
    <div
      style={{
        display: 'grid', gridTemplateColumns: '78px 84px minmax(0, 1fr) 100px 22px',
        gap: 8, alignItems: 'center', fontSize: 12.5,
        padding: '4px 8px', borderRadius: 6,
        // The row the editor was opened from is marked, so the list answers "which of these am I
        // looking at?" without comparing dates against the ledger behind the dialog.
        background: isThisRow ? 'color-mix(in srgb, var(--accent) 10%, var(--surface2))' : 'var(--surface2)',
        opacity: member.trashed ? 0.55 : 1,
      }}
      title={
        member.trashed
          ? 'This transaction is in the trash and is not counted'
          : `${member.payee} · ${member.account_name}`
          + (Math.abs(member.receivable) - Math.abs(member.claim) > 0.005
            ? ` · this reimbursement covers ${formatTransactionAmount(member.claim)} of the ${formatTransactionAmount(member.receivable)} owed back on this row`
            : '')
      }
    >
      {/* The role is derived from the direction of the money, never stated by the user — so it is shown
          as a reading of the row rather than as something editable. */}
      <span style={{ color: 'var(--muted)' }}>{member.role === 'expense' ? 'Owed' : 'Received'}</span>
      <span style={{ color: 'var(--muted)' }}>{member.date}</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {member.payee}
        {member.claim_label ? (
          <span style={{ color: 'var(--muted)' }}> · {member.claim_label}</span>
        ) : null}
      </span>
      <span style={{
        textAlign: 'right',
        color: member.trashed ? 'var(--muted)' : getTransactionAmountColor(member.claim),
        textDecoration: member.trashed ? 'line-through' : 'none',
      }}>
        {formatTransactionAmount(member.claim)}
      </span>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          title="Remove this transaction from the reimbursement"
          aria-label="Remove this transaction from the reimbursement"
          style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 15, padding: 0 }}
        >
          ×
        </button>
      ) : <span />}
    </div>
  )
}

const fieldLabelStyle = {
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
}

function TotalLine({ label, amount, muted = false }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', color: muted ? 'var(--muted)' : 'var(--text)' }}>
      <span>{label}</span>
      <span>{formatTransactionAmount(amount)}</span>
    </div>
  )
}
