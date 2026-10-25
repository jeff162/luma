// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Choosing how much of one transaction a reimbursement claims.
 *
 * The portions are **toggles, not a radio group**. A row divided between two people is routinely claimed
 * whole — one charge, one debt, two line items — and the buttons this replaced looked multi-select while
 * accepting exactly one, so "I want both pieces" had no expression at all. A reimbursement holds at most
 * one claim per transaction (claims are keyed by transaction id, `services/reimbursements.py`), so
 * several selected portions become **one claim for their sum** rather than several — which is why the
 * running total is shown: it is the figure that will be stored.
 *
 * The remainder option is exclusive against the portions. Once part of a row is claimed its named portions
 * no longer describe what is left, so "everything not yet claimed" is a different *kind* of answer
 * rather than one more portion, and combining it with them would double-count. It appears only when the
 * portions cannot express it — see `claimRemainder`.
 *
 * Shared by the detail panel (starting a reimbursement) and the editor (attaching a row to one) because
 * both are the same question about the same money; the earlier per-surface buttons had already drifted
 * to different labels for the same option.
 */

import { useState } from 'react'
import { Button } from './ui.jsx'
import { formatMoneyMagnitude } from '../lib/moneyDisplay.js'
import { portionSelectionLabel, portionSelectionProblem, round2 } from '../lib/reimbursements.js'

const REMAINDER_KEY = 'remainder'

const optionStyle = (selected, disabled) => ({
  display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center',
  fontSize: 12.5, textAlign: 'left', width: '100%', font: 'inherit',
  cursor: disabled ? 'default' : 'pointer',
  padding: '4px 10px', borderRadius: 6,
  // The selected background the FilterBar's buttons use, so a chosen portion here reads
  // the same as a chosen option anywhere else in the app.
  background: selected ? 'color-mix(in srgb, var(--accent) 12%, var(--surface2))' : 'var(--surface2)',
  border: `1px solid ${selected ? 'color-mix(in srgb, var(--accent) 30%, var(--border))' : 'var(--border)'}`,
  color: 'var(--text)',
})

export default function ClaimPortionPicker({
  portions = [],
  remainder = null,
  unclaimed = 0,
  receivable = 0,
  busy = false,
  confirmLabel = 'Track this reimbursement',
  onConfirm,
  onCancel,
}) {
  // Indices of the chosen portions, or the remainder sentinel. Held as a Set so a second click clears the
  // one it lands on, which is the whole point of toggles over the buttons this replaced.
  const [selected, setSelected] = useState(() => new Set())

  const remainderChosen = selected.has(REMAINDER_KEY)
  const chosenPortions = portions.filter((_, index) => selected.has(index))
  const amounts = remainderChosen ? [remainder] : chosenPortions.map(portion => portion.amount)
  const total = round2(amounts.reduce((sum, amount) => sum + round2(amount), 0))
  const problem = portionSelectionProblem(amounts, unclaimed, receivable)
  // An empty selection is a starting state; only an impossible one is worth alarming about.
  const overCommitted = Boolean(problem) && amounts.length > 0

  function toggle(key) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(key)) { next.delete(key); return next }
      // The remainder and the named portions are alternative readings of the same money, never additive.
      if (key === REMAINDER_KEY) return new Set([REMAINDER_KEY])
      next.delete(REMAINDER_KEY)
      next.add(key)
      return next
    })
  }

  function confirm() {
    if (problem || busy) return
    onConfirm?.({
      amount: total,
      label: remainderChosen ? null : portionSelectionLabel(chosenPortions),
    })
  }

  return (
    <div style={{ display: 'grid', gap: 4 }}>
      {/* Not "which portions does this cover": these are parts of *this* transaction, and "cover" runs
          the wrong way — a payment covers an expense, not the other way about. */}
      <div style={{ fontSize: 12, color: 'var(--muted)' }}>Which parts of this transaction?</div>
      {portions.map((portion, index) => (
        <button
          key={`portion-${index}`}
          type="button"
          aria-pressed={selected.has(index)}
          onClick={() => toggle(index)}
          disabled={busy}
          style={optionStyle(selected.has(index), busy)}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {portion.label || 'This transaction'}
          </span>
          <span>{formatMoneyMagnitude(Math.abs(portion.amount))}</span>
        </button>
      ))}
      {remainder != null ? (
        <button
          type="button"
          aria-pressed={remainderChosen}
          onClick={() => toggle(REMAINDER_KEY)}
          disabled={busy}
          style={optionStyle(remainderChosen, busy)}
          title="Some of this transaction is already claimed, so its portions no longer add up to what is left"
        >
          <span>Everything not yet claimed</span>
          <span>{formatMoneyMagnitude(Math.abs(remainder))}</span>
        </button>
      ) : null}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 2 }}>
        <span style={{ fontSize: 12, color: overCommitted ? 'var(--danger)' : 'var(--muted)' }}>
          {/* Three things in one slot, and only one of them is a fault: what there is to claim before
              anything is chosen, the figure about to be stored once something is (several portions become
              one claim for their sum, which a set of toggles does not say on its own), and why a
              selection is refused. Choosing nothing yet is not an error, so it is not coloured as one. */}
          {problem || `Claiming ${formatMoneyMagnitude(Math.abs(total))}`}
        </span>
        <span style={{ display: 'flex', gap: 6 }}>
          {onCancel ? (
            <Button variant="ghost" small onClick={onCancel} disabled={busy}>Cancel</Button>
          ) : null}
          <Button small onClick={confirm} disabled={busy || Boolean(problem)}>
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </span>
      </div>
    </div>
  )
}
