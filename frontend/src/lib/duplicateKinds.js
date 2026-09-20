// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// What a duplicate-detection entry reads as in the report's Kind column, and where it sorts.
//
// Pure data and pure functions, so they live here rather than in `UnifiedDuplicatesDialog.jsx` where they
// started. Two reasons, and the second is the one that matters: a `.jsx` module exporting non-components
// breaks Vite's Fast Refresh for the whole file, so editing that dialog with it open reloaded the page;
// and the table's guarantee is a *logic* guarantee, tested on its own, which reads better imported from a
// module than reached out of a dialog.

// The two cross-account outcomes a coverage reject can carry. Both arrive from the backend under the one
// `transfer_match` sub-state, because both probes tag their candidate `cross_account`, but they are
// different findings and read differently: the ledger-payment probe names the SAME charge already
// recorded on another account (its candidate carries `payment_match`), while the transfer probe names the
// OTHER LEG of one movement. Derived from the candidates rather than the sub-state so the label survives
// `Mark reviewed`, which clears the sub-state — what the row *is* does not change when it is acknowledged.
const coverageCandidates = entry => (Array.isArray(entry?.matched?.candidates) ? entry.matched.candidates : [])

export function isMatchedElsewhere(entry) {
  const candidates = coverageCandidates(entry)
  return candidates.length > 0 && candidates.every(c => c?.cross_account && c?.payment_match)
}

export function isMatchedTransfer(entry) {
  const candidates = coverageCandidates(entry)
  return candidates.length > 0 && candidates.every(c => c?.cross_account) && !isMatchedElsewhere(entry)
}

// Single source of truth for the Kind column's states, listed in display + sort order (index 0 shows and
// sorts first — most urgent). Each state's `is(entry)` predicate is evaluated top-down and the FIRST match
// wins, so this one array encodes BOTH the label precedence (which state a row reads as when several
// predicates could apply — earlier wins: a coverage reject that is also enriched reads as its coverage
// outcome, because "why was this not imported" outranks "and it gave up its detail") AND the sort rank
// (the array index). Deriving label, stripe, and rank from the same list is the point: it stops a newly
// added state from getting a label without a matching sort position — the drift that used to let an
// acknowledged "Reviewed" row (and an enriched "Matched" row) collapse into the plain-"Rejected" rank and
// sort scattered among them. `warn` = amber needs-attention emphasis; `positive` = green good-outcome
// emphasis; the rest are settled and deliberately neutral.
//
// **"Rejected" is reserved for a row that matched nothing.** Everything the coverage ladder did pair reads
// as some flavour of "Matched", since that is what the reader needs to know — the row is not in the ledger
// because its transaction already is. Only `no_match` (covered date, nothing paired anywhere) and the
// catch-all keep the word.
export const KIND_STATES = [
  { key: 'review',    is: e => e.kind === 'soft_flag',                                           label: 'Review',                   warn: true,     stripe: 'var(--warning)' },
  // Covered, and nothing paired with it anywhere — the one advisory reject genuinely worth investigating,
  // so it sorts ahead of the near-date confirmation below.
  { key: 'no_match',  is: e => e.review_substate === 'no_match',                                 label: 'Rejected · review',        warn: true,     stripe: 'color-mix(in srgb, var(--warning) 30%, var(--border))' },
  { key: 'near_date', is: e => e.review_substate === 'matched_near_date',                        label: 'Matched · review',         warn: true,     stripe: 'color-mix(in srgb, var(--warning) 30%, var(--border))' },
  { key: 'resolved',  is: e => e.kind === 'hard_reject' && !!e.incoming?.txn_id,                 label: 'Resolved',                                 stripe: 'color-mix(in srgb, var(--warning) 60%, var(--border))' },
  // Settled cross-account outcomes. The coverage rule made the verdict; these probes only name what the
  // row duplicates, so neither asks the reader for anything. They rank above `matched` so an enriched one
  // still says which of the two it was.
  { key: 'elsewhere', is: e => e.kind === 'hard_reject' && isMatchedElsewhere(e),                label: 'Matched another account',                  stripe: 'color-mix(in srgb, var(--accent2) 45%, var(--border))' },
  { key: 'transfer',  is: e => e.kind === 'hard_reject' && isMatchedTransfer(e),                 label: 'Matched transfer',                         stripe: 'color-mix(in srgb, var(--accent2) 45%, var(--border))' },
  // A settled hard-reject that folded its detail into the transaction it matched reads as a positive
  // outcome, not a discard: "Matched" (green), with the ✓ enriched detail line below carrying the specifics.
  { key: 'matched',   is: e => e.kind === 'hard_reject' && !!e.enriched,                         label: 'Matched',                  positive: true, stripe: 'var(--success)' },
  { key: 'reviewed',  is: e => e.kind === 'hard_reject' && !!e.reviewed && !!e.matched?.covered, label: 'Reviewed',                                 stripe: 'var(--border)' },
  { key: 'rejected',  is: () => true,                                                            label: 'Rejected',                                 stripe: 'var(--border)' },
]

// The winning state for a row: the first KIND_STATES entry whose predicate matches (the `rejected`
// catch-all guarantees a hit, so this never returns -1). Its index is the Kind-column sort rank; the entry
// itself carries the label + stripe the cell paints. Both readers below go through here, so the sort order
// and the label can never drift apart again.
function kindStateIndex(entry) {
  return KIND_STATES.findIndex(s => s.is(entry))
}

// The Kind cell's label + emphasis + the row's left-border stripe (used by the MatchReport column render
// and getRowStripe).
export function kindMeta(entry) {
  return KIND_STATES[kindStateIndex(entry)]
}

// The Kind column's sort rank — the same table's index, so labels and order stay in lockstep.
export function kindRank(entry) {
  return kindStateIndex(entry)
}
