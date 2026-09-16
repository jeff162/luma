// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Whether a transaction's amount may be corrected in place, and what to say when it may not.
 *
 * **Only a row entered by hand is offered this at all.** A row that came from a file or a provider is a
 * record of what that source reported, and two mechanisms make editing one worse than it looks: a synced
 * row's amount is re-stamped from provider data whenever the charge is re-sent or settles
 * (`routers/sync.py`), so the correction does not reliably survive; and the row's `content_hash` — which
 * dedupe matches an incoming row against exactly — is the digest its own source reproduces, so
 * restamping it makes that row stop matching the file it came from. Neither applies to a hand-entered
 * row: nothing re-sends it, and the corrected figure is the one a future source describing the same
 * charge will carry. Correcting an imported figure is still possible, by trashing the row and entering
 * it again; what is withheld is the shortcut, in the one place the shortcut points the wrong way.
 *
 * **Among hand-entered rows, two are refused** — and these are the expensive ones, because both fail
 * silently rather than loudly. A split's allocations are checked against the transaction's amount only
 * when the split is saved (`services/txn_splits.py`), and a reimbursement's claims are checked against
 * what the row has receivable only when the claim is made (`services/reimbursements.py`). Nothing
 * re-checks either afterwards, so an amount moved out from under one leaves a split that no longer sums
 * and a reimbursement report whose headline quietly stops being true.
 *
 * This governs **rendering only** — `ui-patterns.md` → *A control that is disabled by an unmet
 * condition says which one, on hover*. The backend refuses the same three cases independently, since
 * that is what holds across every entry point; this exists so the screen agrees with it, and so the
 * reason on the hover and the condition that greys the control come from one expression rather than two
 * that can drift apart.
 */

// A row entered by hand belongs to no ingestion event: no import batch, and no provider id. That is how
// `data-model.md` → *Transactions* already defines one, which is why this reads the absence rather than
// asking for a column that would have to be backfilled to mean the same thing.
function isHandEntered(txn) {
  return !txn?.import_batch_id && !txn?.external_transaction_id
}

/*
 * `offered` — whether this surface should say anything about editing the amount at all.
 * `editable` — whether the edit may proceed.
 * `reason` — why not, for the hover, and empty whenever there is nothing to explain.
 *
 * The three-way answer is the point: a row that was imported renders no affordance and no explanation,
 * because "this came from a file" is not a problem the user has to solve and a hint on every imported
 * row in the ledger would be noise. A row they typed themselves is the opposite case — the control is
 * there on their other hand-entered rows, so its absence on this one is a mystery worth one sentence.
 */
export function amountEditState(txn) {
  if (!txn || !isHandEntered(txn)) return { offered: false, editable: false, reason: '' }
  if (txn.is_split) {
    return {
      offered: true,
      editable: false,
      reason: "Cannot edit the amount of a split transaction.",
    }
  }
  if (Array.isArray(txn.reimbursements) && txn.reimbursements.length > 0) {
    return {
      offered: true,
      editable: false,
      reason: 'Cannot edit the amount of a transaction that is part of a reimbursement.',
    }
  }
  return { offered: true, editable: true, reason: '' }
}
