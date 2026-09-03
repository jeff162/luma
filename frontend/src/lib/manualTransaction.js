// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Turning a filled-in form into a transaction the ledger will store correctly.
 *
 * **The sign rule is the whole reason this is a module rather than three lines in the dialog.** Amounts
 * are stored with `amount > 0` meaning money *out*, and every screen in the app displays the opposite
 * (`getTransactionDisplayAmount`). A person entering a transaction types a magnitude and knows which way
 * the money went; they do not know, and must never be asked about, a storage convention they have never
 * seen. So the form takes a direction and a magnitude and this derives the stored value — the same
 * boundary `signedExpectedTotal` draws for a purchase's expected total, and drawn in the same place for
 * the same reason: the derived figure can be shown back before it is saved, so an inference that came
 * out wrong is visible rather than silent.
 *
 * Getting this backwards would invert every hand-entered transaction while looking entirely plausible
 * on the way in, which is why it has its own tests rather than being covered incidentally.
 */

// The direction control's two sides. Named for what happened to the money rather than for a category
// type: sitting above an amount box this reads as debit/credit, and the category field below it is a
// separate question — a refund is Received and still belongs in the category it offsets.
export const DIRECTIONS = [
  { value: 'out', label: 'Spent' },
  { value: 'in', label: 'Received' },
]

export function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100
}

/*
 * The magnitude a person typed, as the ledger stores it. Returns null for anything that is not a usable
 * amount — an empty box, a stray character, a zero — so the caller gates on one condition rather than
 * distinguishing "not filled in yet" from "filled in wrongly", which the form has no reason to.
 *
 * A typed sign is ignored rather than honored, which is the one place this deliberately differs from
 * `signedExpectedTotal`. There, a person editing a stored figure may know the convention and mean it.
 * Here the direction is a control on screen with the answer already in it, so a stray "-" is far more
 * likely to be a typo than a second opinion — and honoring it would silently contradict the toggle the
 * user can see.
 */
export function signedAmount(raw, direction) {
  const text = String(raw ?? '').trim()
  if (!text) return null
  const value = Number.parseFloat(text.replace(/[^0-9.]/g, ''))
  if (!Number.isFinite(value) || value === 0) return null
  return round2(direction === 'in' ? -Math.abs(value) : Math.abs(value))
}

// Today in the ledger's date format, for the date box's default. Built from local parts rather than
// toISOString, which converts to UTC and hands back yesterday for anyone west of Greenwich after
// their afternoon.
export function todayIsoDate(now = new Date()) {
  const pad = value => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim())
}

/*
 * Whether the form is ready to submit, and the request body if it is.
 *
 * Returns the reason rather than a bare false so the dialog can say which box needs attention — the
 * error-handling preference this repo states: keep the screen open and explain what to change.
 */
export function buildTransactionPayload(form) {
  const payee = String(form?.payee || '').trim()
  if (!payee) return { ok: false, reason: 'Enter who this was paid to, or what it was for.' }
  if (!form?.accountId) return { ok: false, reason: 'Choose which account this belongs to.' }
  if (!isIsoDate(form?.date)) return { ok: false, reason: 'Enter the date as YYYY-MM-DD.' }
  const amount = signedAmount(form?.amount, form?.direction)
  if (amount === null) return { ok: false, reason: 'Enter an amount.' }
  return {
    ok: true,
    payload: {
      account_id: form.accountId,
      date: String(form.date).trim(),
      amount,
      payee,
      category_id: form.categoryId || null,
      notes: String(form?.notes || '').trim() || null,
    },
  }
}
