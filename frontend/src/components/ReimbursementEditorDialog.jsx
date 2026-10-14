// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../lib/api.js'
import ClaimPortionPicker from './ClaimPortionPicker.jsx'
import { formatTransactionAmount, getTransactionAmountColor } from '../lib/moneyDisplay.js'
import {
  FOLLOWING_DEFAULT,
  REMINDER_OFF,
  addDays,
  claimablePortions,
  claimRemainder,
  completeExplanation,
  completionTargets,
  hasRepayment,
  movableClaims,
  needsTargetChoice,
  primaryAction,
  recordDueDate,
  reimbursementDisplayLabel,
  reimbursementStatus,
  reminderMode,
  reminderSummary,
  residualSummary,
  todayIso,
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
  // Portions other records are holding, offered beside the loose ones so a row on the wrong record can
  // be brought here instead of being released first and hunted down again.
  const [movable, setMovable] = useState([])
  const [moving, setMoving] = useState(null)
  const [reminderDays, setReminderDays] = useState(0)
  const [completeOpen, setCompleteOpen] = useState(false)
  const [completeCategory, setCompleteCategory] = useState(null)
  const [completeTarget, setCompleteTarget] = useState('')
  // The category list the completion picker offers. A host that already holds the list passes it; a host
  // that does not (the ledger row's ↩ marker has no categories of its own) leaves it empty, and the dialog
  // loads it the first time the question is asked. Offering the picker an empty list is not a smaller
  // version of the right answer: it lists nothing but "New group", which reads as though a group is wanted.
  const [loadedCategories, setLoadedCategories] = useState(null)
  // Categories created from the picker here, kept locally so a new one is listed and shown as selected
  // even where the host passed no `onAddCategory` to fold it into its own list.
  const [addedCategories, setAddedCategories] = useState([])

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
          // The reminder is seeded as its three-way answer rather than as a date, because "following
          // the default" and "no reminder" are both states a date cannot express. See
          // `lib/reimbursements.js`.
          reminderMode: reminderMode(record),
          remindOn: record.remind_on || '',
        } : null))
      })
      .catch(err => { if (!cancelled) setError(err?.message || 'This reimbursement could not be loaded.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [linkId])

  const hostHasCategories = Array.isArray(categories) && categories.length > 0
  useEffect(() => {
    if (!completeOpen || hostHasCategories || loadedCategories) return undefined
    let cancelled = false
    api.getCategories()
      .then(list => { if (!cancelled) setLoadedCategories(Array.isArray(list) ? list : []) })
      .catch(err => { if (!cancelled) setError(err?.message || 'The categories could not be loaded.') })
    return () => { cancelled = true }
  }, [completeOpen, hostHasCategories, loadedCategories])

  const baseCategories = hostHasCategories ? categories : (loadedCategories || [])
  const pickerCategories = addedCategories.length
    ? [...baseCategories, ...addedCategories.filter(added => !baseCategories.some(c => c.id === added.id))]
    : baseCategories

  function handleAddCategory(category) {
    setAddedCategories(prev => (prev.some(c => c.id === category.id) ? prev : [...prev, category]))
    onAddCategory?.(category)
  }

  // The household default, so the reminder control can say what "following the default" works out to
  // for *this* record rather than naming a rule the reader then has to apply themselves.
  useEffect(() => {
    let cancelled = false
    api.getReimbursementSettings()
      .then(settings => { if (!cancelled) setReminderDays(settings?.reminder_days || 0) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

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
  // Whether the typed fields still match what is stored. Nothing else in this dialog waits for Save —
  // linking, removing and completing all act at once — so with nothing typed there is nothing to
  // discard, and the left button says Close rather than promising an undo it does not have. Comparing
  // against the record rather than tracking a dirty flag means typing and then undoing it settles back
  // to Close, which is the honest reading of "nothing to save".
  const fieldsEdited = !!reimbursement && !!form
    && (form.counterparty !== (reimbursement.counterparty || '')
      || form.reminderMode !== reminderMode(reimbursement)
      || (form.reminderMode === 'date' && form.remindOn !== (reimbursement.remind_on || '')))
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
        // Three fields rather than one nullable date: a record can carry its own date, be switched off,
        // or go back to following the household default, and "off" must not read as "unset".
        remind_on: form.reminderMode === 'date' ? form.remindOn : null,
        clear_reminder: form.reminderMode === REMINDER_OFF,
        follow_default_reminder: form.reminderMode === FOLLOWING_DEFAULT,
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
      setMovable(movableClaims(report, reimbursement.id))
      setLinkOpen(true)
    } catch (err) {
      setError(err?.message || 'The unlinked receivables could not be loaded.')
    }
  }

  /*
   * Bring a portion here from the record currently holding it.
   *
   * Confirmed rather than done on click, because it takes the money off another record and may delete
   * that record outright — the same weight as removing a member, which is also confirmed. The server
   * releases and re-attaches in one transaction, so there is no state where the portion belongs to
   * neither.
   */
  async function confirmMove() {
    const target = moving
    setMoving(null)
    if (!target) return
    setLinkOpen(false)
    setError('')
    try {
      publish(await api.moveReimbursementClaim(reimbursement.id, target.txn_id, target.from.id))
    } catch (err) {
      setError(err?.message || 'That portion could not be moved.')
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
      footerAlign="between"
      actions={
        <>
          {/* Unpairing sits with the other actions rather than loose in the body, and apart from them:
              it undoes the record itself, where everything to its right acts on what the record holds. */}
          <div>
            {reimbursement && status !== 'completed' ? (
              <Button
                variant="ghost"
                onClick={() => setUnlinking(true)}
                disabled={saving}
                title="Keep every transaction exactly as it is, but stop tracking them as one reimbursement"
              >Stop tracking this reimbursement</Button>
            ) : null}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {/* Cancel only once there is something it would discard. A finished record's fields stay
              editable on purpose — naming is documentation rather than an accounting fact, and the
              server allows it after completion for exactly that reason — so the same rule serves both:
              Close until a field is edited, Cancel after. Save appears with it, and an *open* record
              keeps Mark complete throughout, because completing is a decision that may be about to be
              made. */}
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {fieldsEdited ? 'Cancel' : 'Close'}
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
            >Mark complete</Button>
          ) : null}
          {reimbursement && !settledAndUnedited ? (
            <Button
              variant={completeIsPrimary ? 'ghost' : 'primary'}
              onClick={saveFields}
              disabled={saving}
            >{saving ? 'Saving…' : 'Save'}</Button>
          ) : null}
          </div>
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

          {/* Beside the name rather than tucked below the totals: the two together are what the record
              *is* — what it is called and when it will be asked about. A completed record still shows
              it, read-only, because the date is part of the history of what happened. */}
          {status === 'completed' ? null : (
            <ReminderField
              form={form}
              reimbursement={reimbursement}
              reminderDays={reminderDays}
              onChange={next => setForm(prev => ({ ...prev, ...next }))}
            />
          )}

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
                    aria-label={status === 'outstanding' ? 'Which expense fell short?' : 'Which repayment carries the surplus?'}
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
                    categories={pickerCategories}
                    compact
                    showSelectedBadge
                    onChange={setCompleteCategory}
                    onAddCategory={handleAddCategory}
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
          {loose.length === 0 && movable.length === 0 ? (
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

              {/* Portions another record is holding. Listed *after* the unclaimed ones and behind a
                  confirm, because taking one moves money off another record and may delete it — this is
                  a correction, not the ordinary way to add something. Without it a row whose receivable
                  is entirely claimed could only be moved by releasing it from its current record first,
                  which deletes that record on the way if it was its last portion. */}
              {movable.length ? (
                <div style={{ display: 'grid', gap: 6, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Already on another reimbursement
                  </div>
                  {movable.map(row => (
                    <div key={`${row.from.id}-${row.txn_id}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                      <div style={{ display: 'grid', gap: 1, minWidth: 0 }}>
                        <span style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {row.date} · {row.payee}
                          {row.claim_label ? <span style={{ color: 'var(--muted)' }}> · {row.claim_label}</span> : null}
                        </span>
                        <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                          on {row.from.label} · {formatTransactionAmount(row.claim)}
                        </span>
                      </div>
                      <Button variant="ghost" small onClick={() => setMoving(row)}>Move here</Button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          )}
        </AppDialog>
      ) : null}

      {moving ? (
        <AppConfirmDialog
          title="Move this portion here?"
          description={
            `${formatTransactionAmount(moving.claim)} of ${moving.payee} currently counts toward `
            + `${moving.from.label}. Moving it here takes it off that reimbursement`
            + '. The transactions themselves are not changed.'
          }
          confirmLabel="Move it"
          onConfirm={confirmMove}
          onCancel={() => setMoving(null)}
        />
      ) : null}
    </AppDialog>,
    document.body,
  )
}

/*
 * When this record will next be asked about.
 *
 * **Three answers, not a date and a checkbox.** Following the household default, a date of its own, or
 * no reminder at all — and the first two are genuinely different even when they land on the same day,
 * because a record following the default moves when the default does. Storing "off" as an empty date
 * would make it indistinguishable from "never set", so it would quietly revert to the default on the
 * next unrelated save.
 *
 * **The default option names the date it works out to**, not the rule behind it. "Following the
 * household default" is a fact about configuration; what the reader wants to know is when they will be
 * asked about this money. Where nothing is owed, or the default is switched off, there is no date to
 * name and it says so instead of showing an empty one.
 *
 * The push-out button is the snooze the Tasks signal points at: a due reminder is most often not a
 * decision to make, just a "not yet", and making the user open a date picker to say so is the friction
 * that turns a reminder into something to be ignored.
 */
function ReminderField({ form, reimbursement, reminderDays, onChange }) {
  const mode = form.reminderMode
  const dueOn = recordDueDate(reimbursement, reminderDays)
  const due = !!dueOn && dueOn <= todayIso()
  const pushedTo = addDays(todayIso(), reminderDays || 30)
  return (
    <div style={{ display: 'grid', gap: 4, maxWidth: 420 }}>
      <label style={fieldLabelStyle} htmlFor="reimbursement-reminder-mode">Reminder</label>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          id="reimbursement-reminder-mode"
          value={mode}
          onChange={e => onChange({
            reminderMode: e.target.value,
            // Seeded so switching to a date does not open on an empty field the user has to fill in
            // before the control means anything.
            remindOn: e.target.value === 'date'
              ? (form.remindOn || dueOn || pushedTo || todayIso())
              : form.remindOn,
          })}
          style={selectStyle}
        >
          <option value={FOLLOWING_DEFAULT}>Use the default</option>
          <option value="date">Remind me on…</option>
          <option value={REMINDER_OFF}>No reminder</option>
        </select>
        {mode === 'date' ? (
          <input
            type="date"
            value={form.remindOn || ''}
            onChange={e => onChange({ remindOn: e.target.value })}
            aria-label="Reminder date"
            style={selectStyle}
          />
        ) : null}
        {due ? (
          <Button
            variant="ghost"
            small
            onClick={() => onChange({ reminderMode: 'date', remindOn: pushedTo })}
            title="Push this reminder out and stop it asking for now"
          >Not yet</Button>
        ) : null}
      </div>
      <span style={{ fontSize: 12, color: due ? 'var(--danger)' : 'var(--muted)' }}>
        {mode === 'date'
          ? 'Nothing will be shown about this until then.'
          : reminderSummary(reimbursement, reminderDays)}
      </span>
    </div>
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
          as a reading of the row rather than as something editable. An expense reads "Owed", not the
          app's usual "Spent": the label names what the row is waiting on, money spent that is still to
          be paid back. The totals below keep "Spent". */}
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

// Shared by the reminder's select and its date input so the pair reads as one control rather than as
// two differently-shaped fields sitting next to each other.
const selectStyle = {
  font: 'inherit', fontSize: 12.5, padding: '4px 6px', borderRadius: 6,
  border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)',
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
