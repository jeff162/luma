// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Multi-payment purchases — the presentation rules three surfaces share.
 *
 * The ledger row's marker, the transaction detail panel's section, and the dialog that groups a
 * selection all have to say the same things about a purchase: what it is called, which payment of how
 * many this row is, and how the linked total stands against the expected one. Keeping those decisions
 * here rather than in each component is what stops the three from drifting into three different
 * readings of one record.
 *
 * **The sign rule is the load-bearing piece.** Amounts are stored with `amount > 0` meaning money out,
 * and the UI shows the opposite (spending reads negative — `getTransactionDisplayAmount`). A person
 * typing an invoice total types a magnitude: "6000", not "+6000" against a convention they have never
 * seen. `signedExpectedTotal` puts that magnitude back into the ledger's convention by taking the sign
 * of the payments being linked, which is the only signal available and the right one — an expected
 * total is the figure those payments are meant to add up to. The derived value is rendered back to the
 * user before it is saved (the dialog shows it beside the running total), so an inference that came out
 * wrong is visible rather than silent.
 */

import { formatTransactionAmount } from './moneyDisplay.js'
import { parseAmountInput, formatAmountInput } from './displayFormat.js'

// What a purchase with no name of its own is called. Naming is optional on purpose: a purchase found
// while reconciling is worth grouping before it is worth titling.
export const UNTITLED_PURCHASE_LABEL = 'Linked purchase'

export function purchaseDisplayLabel(purchase) {
  return (purchase?.label || '').trim() || UNTITLED_PURCHASE_LABEL
}

// The net of a set of payments, in the ledger's convention. Trashed payments are excluded — they are
// money that is not in the ledger, and counting them would overstate the purchase.
export function livePaymentsTotal(payments) {
  return round2((payments || []).reduce((sum, p) => (p?.trashed ? sum : sum + (Number(p?.amount) || 0)), 0))
}

export function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100
}

/*
 * A typed magnitude turned into a signed ledger amount, taking its direction from the payments it
 * describes. Returns null for an empty box — "no expected total stated" is a real answer and is not the
 * same as zero, which would claim the purchase is fully accounted for.
 *
 * A sign the user typed themselves is honored rather than overridden: someone who writes "-6000" has
 * said something deliberate, and silently flipping it would be the app arguing with an explicit input.
 */
export function signedExpectedTotal(raw, payments) {
  const text = String(raw ?? '').trim()
  if (!text) return null
  const value = parseAmountInput(text)
  if (!Number.isFinite(value)) return null
  if (value === 0) return 0
  if (value < 0) return round2(value)
  // Money out is the overwhelming case and the sensible default when a set of payments nets to nothing
  // (two rows that cancel), which carries no direction to take.
  const direction = livePaymentsTotal(payments) < 0 ? -1 : 1
  return round2(Math.abs(value) * direction)
}

// The magnitude to put back in the box when editing a purchase that already has an expected total —
// the inverse of the rule above, so a re-save round-trips instead of flipping sign each time.
export function expectedTotalInputValue(expectedTotal) {
  if (expectedTotal === null || expectedTotal === undefined) return ''
  return formatAmountInput(Math.abs(round2(expectedTotal)))
}

/*
 * Which payment of how many, for the row marker and the panel's heading.
 *
 * A trashed payment has no ordinal — it is not one of the N the purchase is made of — so it says what
 * it is instead of claiming a place in the sequence.
 */
export function paymentPositionLabel({ position, payment_count: count } = {}) {
  if (!count) return 'Linked payment'
  if (!position) return `Removed payment · ${count} in this purchase`
  return `Payment ${position} of ${count}`
}

/*
 * The row marker's tooltip: the whole of what this feature tells a ledger row. Built as ordered parts
 * so a purchase with no expected total simply says less rather than saying "of $0.00".
 */
export function purchaseMarkerTooltip(summary) {
  if (!summary) return ''
  const parts = [paymentPositionLabel(summary), purchaseDisplayLabel(summary)]
  const { linked_total: linked, expected_total: expected } = summary
  parts.push(
    expected === null || expected === undefined
      ? `${formatTransactionAmount(linked)} linked`
      : `${formatTransactionAmount(linked)} of ${formatTransactionAmount(expected)}`,
  )
  return parts.join(' · ')
}

/*
 * How a selection of ledger rows may be grouped, decided from the rows themselves — the list feed
 * already carries each row's purchase, so this needs no extra request.
 *
 * Three outcomes, and the middle one is the reason this is a function rather than an `if`: finding a
 * third instalment later is the ordinary way a purchase grows, so a selection that touches exactly one
 * existing purchase adds to it instead of refusing. Two different purchases in one selection has no
 * sensible reading — merging them would be a decision the user did not ask for — so it is refused with
 * the reason.
 */
export function planPurchaseLink(rows) {
  const selected = rows || []
  const existing = new Map()
  const unlinked = []
  for (const row of selected) {
    if (row?.purchase?.id) existing.set(row.purchase.id, row.purchase)
    else unlinked.push(row)
  }
  if (existing.size > 1) {
    return { mode: 'blocked', reason: 'These payments are already in different purchases. Group them one purchase at a time.' }
  }
  if (existing.size === 1) {
    const [purchase] = [...existing.values()]
    if (!unlinked.length) {
      return { mode: 'blocked', reason: `These payments are already grouped as ${purchaseDisplayLabel(purchase)}.` }
    }
    return { mode: 'add', purchase, rows: unlinked }
  }
  if (selected.length < 2) {
    return { mode: 'blocked', reason: 'Select at least two payments to group them as one purchase.' }
  }
  return { mode: 'create', purchase: null, rows: selected }
}

/*
 * The per-row summary the ledger's marker draws from, derived from a full purchase record.
 *
 * This exists so the rule has **one** definition on the client. The backend already computes the same
 * summary for the list feed (`purchase_map_for`); when the detail panel edits a purchase it has the
 * full record in hand and must patch the row behind it *without* refetching the page, so it needs the
 * same derivation locally. Two hand-written copies of "which payment of how many, counting live ones
 * only" is precisely the shape that drifts.
 */
export function purchaseRowSummary(purchase, txnId) {
  if (!purchase) return null
  const live = (purchase.payments || []).filter(payment => !payment.trashed)
  const index = live.findIndex(payment => payment.txn_id === txnId)
  return {
    id: purchase.id,
    label: purchase.label,
    // A trashed payment is not one of the N, so it gets no place in the sequence — the same rule the
    // server applies. `findIndex` returning -1 is exactly that case.
    position: index === -1 ? null : index + 1,
    payment_count: live.length,
    linked_total: livePaymentsTotal(purchase.payments),
    expected_total: purchase.expected_total ?? null,
  }
}

// A name to propose for a new purchase: the payee, when every payment names the same one. A purchase
// paid to one supplier is the common case and its name is the obvious title; where the payees differ
// there is no honest guess to make, so the box stays empty rather than picking one of them.
export function suggestPurchaseLabel(rows) {
  const names = new Set(
    (rows || []).map(row => (row?.display_name || row?.merchant_name || row?.raw_name || '').trim()).filter(Boolean),
  )
  return names.size === 1 ? [...names][0] : ''
}
