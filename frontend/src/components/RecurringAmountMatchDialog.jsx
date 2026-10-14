// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Amount matching for one recurring series.
 *
 * A series normally matches on payee, category and account, and its amount is a forecast hint. That is
 * right for a bill whose amount is the thing that moves, and wrong for two subscriptions from one biller
 * at different prices — nothing but the amount tells those apart, so without a gate whichever one the
 * user confirms claims the other's charges too.
 *
 * Two separate decisions, deliberately not collapsed into one control:
 *
 * - **Match by amount** turns the gate on. On its own it uses the range the scan observed, which
 *   self-adjusts as the charges do and needs no maintenance — the right default.
 * - **A pinned range** replaces that observed one and is never rewritten by a scan. It exists for the
 *   bound a percentage cannot express: a town's water bill and its property tax are each "about right"
 *   for the other's grace margin, so only an explicit figure separates them.
 *
 * The gate carries a grace margin either way, so a price rise stays in the series that should report it
 * rather than falling out of its own history. Sign is not asked for: a series' direction is already
 * settled by its charges, and the bounds are read as magnitudes.
 *
 * `suggested` opens the dialog on a proposed band rather than the series' current one — how accepting a
 * price change arrives here. It is deliberately a proposal the user lands on rather than an edit applied
 * for them: which end should move is a judgement the finding cannot make. A bill that rose because
 * everything rose wants both ends carried up; one new outlier wants a single bound moved, and the same is
 * true downward, where a utility's new cheapest month should widen the floor and nothing else.
 */

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { AppDialog, Button, Input, Toggle } from './ui.jsx'
import { formatCurrency } from '../lib/utils.js'

// The dialog is opened from a card in a long list, so it portals to the body: a fixed overlay is
// positioned and stacked against whatever ancestor established a containing block, not the viewport.
// See the comment on `AppDialog` in `ui.jsx`.
export default function RecurringAmountMatchDialog({ series, suggested = null, onClose, onSave }) {
  const observedLow = Math.min(Math.abs(series.amount_min ?? 0), Math.abs(series.amount_max ?? 0))
  const observedHigh = Math.max(Math.abs(series.amount_min ?? 0), Math.abs(series.amount_max ?? 0))
  const pinned = series.expected_min != null && series.expected_max != null

  // A proposal arrives as magnitudes already widened to take in the charge; otherwise the dialog opens
  // on whatever the series carries — a pin where one is set, the scan's observed range otherwise.
  const startLow = suggested ? suggested.low : (pinned ? Math.abs(series.expected_min) : observedLow)
  const startHigh = suggested ? suggested.high : (pinned ? Math.abs(series.expected_max) : observedHigh)

  const [gated, setGated] = useState(series.amount_mode === 'fixed' || !!suggested)
  const [usePin, setUsePin] = useState(pinned || !!suggested)
  const [low, setLow] = useState(String(startLow))
  const [high, setHigh] = useState(String(startHigh))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // The series' own direction, applied to typed magnitudes so the user never types a minus sign.
  const sign = (series.expected_amount ?? 0) < 0 ? -1 : 1
  const parsed = (value) => {
    const n = Number.parseFloat(String(value).replace(/[^0-9.]/g, ''))
    return Number.isFinite(n) ? n : null
  }
  const lowValue = parsed(low)
  const highValue = parsed(high)
  const boundsValid = !usePin || !gated || (lowValue != null && highValue != null)

  async function save() {
    if (!boundsValid) { setError('Enter both ends of the range.'); return }
    setSaving(true)
    setError('')
    const payload = { amount_mode: gated ? 'fixed' : 'variable' }
    if (gated && usePin) {
      // Signed here rather than in the field: the ledger stores a direction, the user types a size. The
      // ordering has to come *after* the sign — negating swaps which bound is the lower one, so ordering
      // the magnitudes first sends an inverted band for every expense series.
      const a = sign * lowValue
      const b = sign * highValue
      payload.expected_min = Math.min(a, b)
      payload.expected_max = Math.max(a, b)
    } else {
      payload.clear_expected_band = true
    }
    try {
      await onSave(payload)
      onClose()
    } catch (e) {
      setError(e?.message || 'Could not save.')
      setSaving(false)
    }
  }

  return createPortal(
    <AppDialog
      title="Amount matching"
      description={series.display_name}
      onClose={onClose}
      width="min(460px, 100%)"
      actions={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={saving || !boundsValid}>Save</Button>
        </>
      )}
    >
      {suggested ? (
        <div style={{
          marginBottom: 14, padding: '9px 11px', borderRadius: 8,
          background: 'color-mix(in srgb, var(--accent) 8%, transparent)',
          fontSize: 12.5, color: 'var(--text)', lineHeight: 1.5,
        }}>
          {suggested.note} Adjust either end before saving — whether the other end should move too is
          the part only you can answer.
        </div>
      ) : null}

      <Toggle
        checked={gated}
        onChange={setGated}
        label="Match by amount"
      />
      <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 6, lineHeight: 1.5 }}>
        {gated
          ? 'Only charges near this series’ amount belong to it. Use this to separate two charges from the same payee that differ only in price.'
          : 'Any charge from this payee and category belongs to this series, whatever it costs — the right choice for a bill that varies.'}
      </div>

      {gated ? (
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
          <Toggle
            checked={usePin}
            onChange={setUsePin}
            label="Set the range myself"
          />
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 6, lineHeight: 1.5 }}>
            {usePin
              ? 'A range you set is never changed by a scan.'
              : `Using the observed range, ${formatCurrency(sign * observedLow)}–${formatCurrency(sign * observedHigh)}, which follows the charges as they change.`}
          </div>

          {usePin ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
              <Input
                value={low}
                onChange={setLow}
                inputMode="decimal"
                aria-label="Lowest amount"
                style={{ width: 110 }}
              />
              <span style={{ color: 'var(--muted)', fontSize: 13 }}>to</span>
              <Input
                value={high}
                onChange={setHigh}
                inputMode="decimal"
                aria-label="Highest amount"
                style={{ width: 110 }}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <div style={{ marginTop: 12, fontSize: 12.5, color: 'var(--danger)' }}>{error}</div>
      ) : null}
    </AppDialog>,
    document.body,
  )
}
