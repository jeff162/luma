// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// What a duplicate-detection entry reads as in the report's Kind column, and where it sorts.
//
// Pure data and pure functions, so they live here rather than in `UnifiedDuplicatesDialog.jsx` where they
// started. Two reasons, and the second is the one that matters: a `.jsx` module exporting non-components
// breaks Vite's Fast Refresh for the whole file, so editing that dialog with it open reloaded the page;
// and the table's guarantee is a *logic* guarantee, tested on its own, which reads better imported from a
// module than reached out of a dialog.

// Single source of truth for the Kind column's states, listed in display + sort order (index 0 shows and
// sorts first — most urgent). Each state's `is(entry)` predicate is evaluated top-down and the FIRST match
// wins, so this one array encodes BOTH the label precedence (which state a row reads as when several
// predicates could apply — earlier wins, exactly as the old nested ternary did: a hard-reject that is also
// enriched still reads as Resolved/advisory because those sit above `matched`) AND the sort rank (the array
// index). Deriving label, stripe, and rank from the same list is the point: it stops a newly added state
// from getting a label without a matching sort position — the drift that used to let an acknowledged
// "Reviewed" row (and an enriched "Matched" row) collapse into the plain-"Rejected" rank and sort scattered
// among them. `warn` = amber needs-attention emphasis; `positive` = green good-outcome emphasis.
export const KIND_STATES = [
  { key: 'review',   is: e => e.kind === 'soft_flag',                                           label: 'Review',            warn: true,     stripe: 'var(--warning)' },
  { key: 'advisory', is: e => !!e.review_substate,                                              label: 'Rejected · review', warn: true,     stripe: 'color-mix(in srgb, var(--warning) 30%, var(--border))' },
  { key: 'resolved', is: e => e.kind === 'hard_reject' && !!e.incoming?.txn_id,                 label: 'Resolved',                          stripe: 'color-mix(in srgb, var(--warning) 60%, var(--border))' },
  // A settled hard-reject that folded its detail into the transaction it matched reads as a positive
  // outcome, not a discard: "Matched" (green), with the ✓ enriched detail line below carrying the specifics.
  { key: 'matched',  is: e => e.kind === 'hard_reject' && !!e.enriched,                         label: 'Matched',           positive: true, stripe: 'var(--success)' },
  { key: 'reviewed', is: e => e.kind === 'hard_reject' && !!e.reviewed && !!e.matched?.covered, label: 'Reviewed',                          stripe: 'var(--border)' },
  { key: 'rejected', is: () => true,                                                            label: 'Rejected',                          stripe: 'var(--border)' },
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
