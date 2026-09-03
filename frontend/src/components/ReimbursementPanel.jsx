// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import ClaimPortionPicker from './ClaimPortionPicker.jsx'
import ReimbursementMatchPicker from './ReimbursementMatchPicker.jsx'
import { formatMoneyMagnitude } from '../lib/moneyDisplay.js'
import {
  claimablePortions,
  receivableActionLabel,
  isRepaymentRow,
  claimRemainder,
  matchCandidates,
  looseReceivableSummary,
  reimbursementListLabel,
  reimbursementCardSummary,
} from '../lib/reimbursements.js'
import ReimbursementEditorDialog from './ReimbursementEditorDialog.jsx'
import FeatureExplainer from '../help/FeatureExplainer.jsx'

/*
 * The transaction detail panel's statement about money owed back against this row.
 *
 * **It lists reimbursements rather than showing one, because a row can be in several.** One $750 charge
 * split between two friends is two debts; one ATM deposit can repay both. Naming one and hiding the
 * other would be the surface describing the old model rather than the money.
 *
 * **It also speaks for money nothing has claimed yet**, which is where it diverges from `PurchasePanel`.
 * That panel renders nothing until two rows have been grouped, because until then there is nothing to
 * say. Here the row has already declared itself: money allocated to the Reimbursable group is a
 * receivable whether or not a repayment has been found, and the gap between the purchase and the
 * repayment is the normal state of one. A row with neither a reimbursement nor unclaimed money still
 * renders nothing at all.
 *
 * **Where a row holds several portions, starting one asks which.** That question is the whole point of
 * the portion model — it is how the user says *whose* money this is — so it is asked inline rather than
 * behind a dialog. A row with a single portion asks nothing.
 *
 * **A summary, not an editor**, like the purchase panel: the editor is a dialog so a ledger row's
 * marker can open the same one, and a second inline implementation is the drift this repo keeps
 * finding in its own history.
 *
 * `onReimbursementsChange` reports the current list so the host can keep the ledger row in step without
 * refetching the page. Like `DocumentsPanel`'s and `PurchasePanel`'s it **must be a stable reference**:
 * the report patches the host's row, which re-renders this panel, so an inline arrow would restart the
 * fetch on every one of those renders and loop between loading and loaded.
 */
export default function ReimbursementPanel({ txnId, categories, onAddCategory, onReimbursementsChange }) {
  const [state, setState] = useState({ reimbursements: [], receivable: 0, unclaimed: 0, parts: [] })
  const [editingId, setEditingId] = useState(null)
  const [choosing, setChoosing] = useState(false)
  // { portion, tracked, untracked } once a repayment's portion is chosen and its candidates are loaded.
  const [matching, setMatching] = useState(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')

  const notifyRef = useRef(onReimbursementsChange)
  notifyRef.current = onReimbursementsChange

  const publish = useCallback((next) => {
    setState(next)
    notifyRef.current?.(next.reimbursements)
  }, [])

  const reload = useCallback(() => {
    let cancelled = false
    api.getTransactionReimbursement(txnId)
      .then(result => {
        if (cancelled) return
        publish({
          reimbursements: result.reimbursements || [],
          // Kept, not discarded: the row's whole receivable is what makes "$240.00 unclaimed"
          // account for itself — see looseReceivableSummary and trackButtonLabel.
          receivable: result.receivable || 0,
          unclaimed: result.unclaimed || 0,
          parts: result.parts || [],
        })
      })
      .catch(() => {
        if (!cancelled) publish({ reimbursements: [], receivable: 0, unclaimed: 0, parts: [] })
      })
    return () => { cancelled = true }
  }, [txnId, publish])

  useEffect(reload, [reload])

  const portions = claimablePortions(state)
  const remainder = claimRemainder(state)
  const repayment = isRepaymentRow(state.unclaimed)

  /*
   * What happens after a portion is chosen, which is *matching* on both sides now.
   *
   * A repayment repays something, so it asks what. An expense is repaid by something, so it asks what
   * repaid it — but only when there is an answer to give: the temporal norm is money out first and back
   * later, so an expense usually has no unmatched credit waiting for it, and putting an empty chooser in
   * front of the ordinary case would cost every reimbursable expense a click to dismiss. So the
   * candidates are fetched either way and an expense with none falls straight through to tracking, which
   * is what the old asymmetry did unconditionally.
   *
   * The fetch is not skippable for an expense: whether anything is waiting is exactly the question, and
   * it can only be answered by asking.
   */
  async function choosePortion(portion) {
    setChoosing(false)
    setStarting(true)
    setError('')
    let candidates = null
    try {
      const report = await api.getOutstandingReimbursements()
      candidates = matchCandidates(report, { txnId, amount: portion.amount })
    } catch (err) {
      setError(err?.message || 'The open reimbursements could not be loaded.')
    } finally {
      setStarting(false)
    }
    if (!candidates) return
    // Falling through rather than showing an empty chooser — and outside the block above, so tracking
    // owns the busy state for its own request instead of having it cleared out from under it.
    if (!repayment && !candidates.tracked.length && !candidates.untracked.length) {
      return startTracking(portion)
    }
    setMatching({ portion, ...candidates })
  }

  /*
   * Pair with an expense nobody has tracked yet: one record created holding both sides.
   *
   * The expense contributes whatever of it is still unclaimed, which is what "this repays that" means
   * by default. A finer division of the expense stays available in the editor afterwards; asking for it
   * here would put a second picker in front of the ordinary case.
   */
  async function matchToRow(row) {
    const portion = matching?.portion
    if (!portion) return
    setStarting(true)
    setError('')
    try {
      const created = await api.createReimbursement({
        claims: [
          { txn_id: row.txn_id, amount: row.unclaimed, label: null },
          { txn_id: txnId, amount: portion.amount, label: portion.label },
        ],
      })
      setMatching(null)
      reload()
      setEditingId(created.id)
    } catch (err) {
      setError(err?.message || 'These could not be paired.')
    } finally {
      setStarting(false)
    }
  }

  async function matchTo(reimbursement) {
    const portion = matching?.portion
    if (!portion) return
    setStarting(true)
    setError('')
    try {
      await api.addReimbursementClaims(reimbursement.id, [
        { txn_id: txnId, amount: portion.amount, label: portion.label },
      ])
      setMatching(null)
      reload()
      setEditingId(reimbursement.id)
    } catch (err) {
      setError(err?.message || 'This could not be matched to that reimbursement.')
    } finally {
      setStarting(false)
    }
  }

  async function startTracking(portion) {
    setStarting(true)
    setChoosing(false)
    setMatching(null)
    setError('')
    try {
      // Created with this portion alone, which is a complete reimbursement in its own right — "nobody has
      // paid me back yet" is the state most of them live in. The dialog then opens on it so a
      // counterparty and any repayment already in the ledger can be added straight away.
      const created = await api.createReimbursement({
        claims: [{ txn_id: txnId, amount: portion.amount, label: portion.label }],
      })
      reload()
      setEditingId(created.id)
    } catch (err) {
      setError(err?.message || 'This could not be tracked as a reimbursement.')
    } finally {
      setStarting(false)
    }
  }

  if (!state.reimbursements.length && !state.unclaimed) return null

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Reimbursement{state.reimbursements.length > 1 ? 's' : ''}
        </span>
        <FeatureExplainer topic="reimbursable-expenses" placement="bottom-left" />
      </div>

      {state.reimbursements.map(reimbursement => (
        <button
          key={reimbursement.id}
          type="button"
          onClick={() => setEditingId(reimbursement.id)}
          title="Open this reimbursement — what is owed, what came back, and how to settle it"
          style={{
            display: 'grid', gap: 3, width: '100%', textAlign: 'left', cursor: 'pointer',
            background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6,
            padding: '6px 8px', color: 'var(--text)', font: 'inherit',
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            {reimbursementListLabel(reimbursement)}
          </span>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            {/* The progress line says nothing while no expense is recorded, and the headline names that
                state instead — "$10.00 back of $0.00" was true and unreadable. */}
            {reimbursementCardSummary(reimbursement, {
              txnId, receivable: state.receivable,
            })}
          </span>
        </button>
      ))}

      {state.unclaimed ? (
        <div style={{ display: 'grid', gap: 6 }}>
          {/* Dropped where the button below names the amount itself — with one portion the click *is*
              the claim, so the line and the button would state the same figure twice. It stays for the
              multi-portion case, where the button can only open the picker and where the arithmetic
              matters most, since that is the case a selection can overshoot. */}
          {portions.length > 1 ? (
            <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
              {looseReceivableSummary(state.unclaimed, state.receivable)}
            </div>
          ) : null}
          {matching ? (
            <ReimbursementMatchPicker
              reimbursements={matching.tracked}
              rows={matching.untracked}
              amountLabel={formatMoneyMagnitude(Math.abs(matching.portion.amount))}
              repayment={repayment}
              // On the expense side "record it on its own" would describe the *ordinary* outcome as a
              // fallback. Expecting it back is the normal thing to do with a reimbursable expense; the
              // list beside it is the exception.
              trackAloneLabel={repayment ? '' : 'Just expect it back'}
              busy={starting}
              onMatch={matchTo}
              onMatchRow={matchToRow}
              onTrackAlone={() => startTracking(matching.portion)}
              onCancel={() => setMatching(null)}
            />
          ) : choosing && portions.length > 1 ? (
            <ClaimPortionPicker
              portions={portions}
              remainder={remainder}
              unclaimed={state.unclaimed}
              receivable={state.receivable}
              busy={starting}
              confirmLabel={repayment ? 'Continue' : undefined}
              onCancel={() => setChoosing(false)}
              onConfirm={choosePortion}
            />
          ) : (
            <div>
              <button
                type="button"
                onClick={() => (portions.length > 1 ? setChoosing(true) : choosePortion(portions[0]))}
                disabled={starting || !portions.length}
                style={{
                  fontSize: 12.5, cursor: starting ? 'default' : 'pointer',
                  background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6,
                  padding: '4px 10px', color: 'var(--text)', font: 'inherit',
                }}
              >
                {starting ? 'Starting…' : receivableActionLabel({
                  unclaimed: state.unclaimed, receivable: state.receivable, portionCount: portions.length,
                })}
              </button>
            </div>
          )}
        </div>
      ) : null}

      {error ? <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{error}</div> : null}

      {editingId ? (
        <ReimbursementEditorDialog
          linkId={editingId}
          txnId={txnId}
          categories={categories}
          onAddCategory={onAddCategory}
          onClose={() => setEditingId(null)}
          onSaved={reload}
        />
      ) : null}
    </div>
  )
}
