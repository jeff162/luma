// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from 'react'
import { Button, Input, SegmentedToggle, Tooltip, IconButton } from './ui.jsx'
import { DIRECTIONS, round2, signedAmount } from '../lib/manualTransaction.js'
import { formatCurrency } from '../lib/utils.js'
import { formatTransactionAmount } from '../lib/moneyDisplay.js'
import { onEnter } from '../lib/formKeys.js'
import { amountEditState } from '../lib/amountEdit.js'
import { formatAmountInput } from '../lib/displayFormat.js'

/*
 * Correcting the amount of a transaction that was entered by hand — the mistyped figure noticed just
 * after it was saved.
 *
 * **It takes a magnitude and a direction, never a signed number.** Amounts are stored with positive
 * meaning money *out* and displayed the other way round, so asking for a signed figure would invert half
 * of what people enter while looking entirely plausible on the way in. The derivation is
 * `lib/manualTransaction.js` — the same function the entry form uses, not a second copy — and the
 * derived figure is echoed back before saving, so an inference that came out wrong is visible rather
 * than silent (`ui-patterns.md` → *Editing in place*).
 *
 * **Explicit submit, no commit-on-blur.** Two controls decide one value, so a click-away would save a
 * figure whose direction the user had not finished choosing — the multi-field case in `ui-patterns.md` →
 * *Editing in place*. Enter submits, gated on the same expression the Save button is disabled
 * by, so Enter can never accept what the button refuses.
 *
 * **Where the edit is refused, the reason hangs off a `Tooltip` rather than a `title`.** Which rows are
 * refused and why is `lib/amountEdit.js`, deliberately one expression behind both the greying and the
 * hint; the backend refuses the same cases independently. A row that was imported gets no control and no
 * hint at all — see that module for why the three-way answer is the point.
 */
export default function TransactionAmountEditor({ txn, onSave }) {
  const { offered, editable, reason } = amountEditState(txn)
  const [editing, setEditing] = useState(false)
  const [magnitude, setMagnitude] = useState('')
  const [direction, setDirection] = useState('out')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const current = round2(txn?.amount)
  const next = signedAmount(magnitude, direction)
  // One expression for the button's disabled state and for Enter, so the two cannot disagree about what
  // is submittable. An unchanged figure is not an error — there is simply nothing to write.
  const canSave = !saving && next !== null && next !== current

  function begin() {
    setMagnitude(formatAmountInput(Math.abs(current), { cents: true }))
    setDirection(current < 0 ? 'in' : 'out')
    setError('')
    setEditing(true)
  }

  function cancel() {
    setEditing(false)
    setError('')
  }

  async function save() {
    if (!canSave) return
    setSaving(true)
    setError('')
    try {
      await onSave?.(next)
      setEditing(false)
    } catch (err) {
      // The backend's own refusal text, shown as written rather than restated here: it owns the
      // invariants, and a second phrasing of them is what drifts.
      setError(err?.message || 'The amount could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  const amountText = (
    <div style={{ fontSize: 14, fontWeight: 600 }}>{formatCurrency(current)}</div>
  )

  if (!editing) {
    return (
      <div style={{ display: 'grid', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {amountText}
          {offered && editable ? (
            <IconButton size="compact" onClick={begin} aria-label="Edit amount">✎</IconButton>
          ) : null}
          {offered && !editable ? (
            // A span rather than a disabled <button>: an inert control receives no pointer events, so
            // the hover it needs has to reach a wrapper around it (`ui-patterns.md` → *Loading and feedback*).
            <Tooltip describeTrigger content={reason} maxWidth={260}>
              <span
                aria-disabled="true"
                style={{
                  color: 'var(--muted)', opacity: 0.45, fontSize: 13,
                  padding: '2px 4px', cursor: 'not-allowed',
                }}
              >✎</span>
            </Tooltip>
          ) : null}
        </div>
        {error ? <div style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</div> : null}
      </div>
    )
  }

  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div style={{ justifySelf: 'start' }}>
        <SegmentedToggle
          value={direction}
          onChange={setDirection}
          options={DIRECTIONS.map(option => ({ value: option.value, label: option.label }))}
          ariaLabel="Direction"
        />
      </div>
      <Input
        value={magnitude}
        onChange={setMagnitude}
        placeholder="0.00"
        aria-label="Amount"
        inputMode="decimal"
        autoFocus
        onKeyDown={onEnter(save)}
        style={{ textAlign: 'right', width: 130 }}
      />
      {/* The derived figure, shown the way the ledger will show it — what makes the direction toggle
          checkable rather than something to be trusted. */}
      <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
        {next === null ? 'Enter an amount' : `Will be recorded as ${formatTransactionAmount(next)}`}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Button onClick={save} disabled={!canSave}>{saving ? 'Saving…' : 'Save'}</Button>
        <Button variant="secondary" onClick={cancel} disabled={saving}>Cancel</Button>
      </div>
      {error ? <div style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</div> : null}
    </div>
  )
}
