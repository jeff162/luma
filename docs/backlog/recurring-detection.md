# Recurring detection: remaining items

Three independent items. The subsystem as built is in [`../data-model.md`](../data-model.md) →
*Recurring series* and `architecture.md` → *Recurring series*; the first two items are recorded there as
obstacles. The detector's tuning constants are at the top of `services/recurring_detection.py`, with their
reasons beside them.

## A stale series' cadence is biased long (a bug)

`_score` rejects a reading whose last charge is more than three periods old, and applies that test
*after* a cadence is proposed, so the longer the proposed period, the easier it passes. When a series
goes quiet, the correct cadence is the first one disqualified.

Reproduced on real data: fifteen charges at gaps of 28 to 34 days snap cleanly to **monthly**, but the
newest was 336 days old against a 3 × 30-day bar, so `_detect_by_rhythm` returned nothing. The
amount-cluster fallback then found three of those charges near one price, a median gap of 168 days, and
emitted **semiannual** at confidence 0.55. The wrong cadence survived because it was longer.

**Confirmation freezes it.** A confirmed series is never re-derived, and `_write_series_stats` rewrites
counts, amounts, `last_txn_date` and `next_due` but never `cadence` / `period_days`. An invented cadence
is permanent, and `next_due` lands in the past and stays there.

Pairing removed the common trigger (a payee whose descriptor drifted), since a money movement no longer
depends on the descriptor. Any *payee* series whose name changes is still exposed.

**The narrow fix:** do not let the amount-cluster fallback rescue a group whose rhythm reading was
rejected **only** for staleness. That is a small distinction inside `_detect_in_group` (the rhythm path
has to report *why* it declined), and it turns the case above into "no series" rather than "a wrong
series", which is the honest answer for a payee that has gone quiet. Pair it with a decision on whether a
confirmed series should ever have its cadence re-derived.

## A paired movement that is not a series is shown nowhere

`pair_money_movements` identifies every two-legged movement in the ledger, but only the groups that
settle into a rhythm become something the user can see. The rest are correctly withheld from payee
matching, and then displayed by nothing.

On the reference ledger, about a third of the pairs fall here: card payments made whenever the card
carries a balance, occasional savings sweeps, P2P wallet withdrawals. Each is a real, ongoing
relationship between two of the user's own accounts, and the rhythm test is right to decline it, since
inventing a cadence is the bug above. What is missing is anywhere for a movement to appear other than the
Recurring page.

**The obstacle: pairing is derived, never stored.** It is recomputed on each scan inside
`services/transfer_pairs.py`, so nothing else (the ledger, the transaction detail, dedupe, a report) can
ask whether a row is half of a transfer.

**`mechanism-index.md` argues against storing it**, under *A recurring movement's two legs vs.
`txn_link`*: a link "would store what the rows already say". That holds for the pairs a movement series
owns, since the series is the record. It does not cover the pairs no series owns. Revisit that entry with
the split in mind rather than re-deriving the whole argument, and change it if the answer changes.

Two shapes, neither designed:

- **A second consumer of the existing derivation.** Cheapest, stores nothing, consistent by
  construction. Enough for a read-only "money moved between these accounts" view and for marking a
  paired row in the ledger. It cannot answer anywhere the pool is not loaded.
- **A stored `txn_link` kind.** Survives outside a scan, reaches every surface, and is the only shape that
  lets a user *correct* a pairing. Costs a migration, upkeep at every write site, and a reconciliation
  story for when the derivation and the stored link disagree.

Not urgent: nothing is wrong in the data, and the withholding already stops the visible symptom.

## A scoped scan reads the whole window to find its payees

A scan follows every write that changes what detection reads (`owe_recurring_rescan`, listed in
`data-model.md` → *Recurring series*), in the request after the write commits, so its cost grows with the
ledger rather than with the edit. A scoped scan (`payee_keys`) still reads and normalizes every
money-movement row in the window: transfer pairing needs all of them, and a payee's rows cannot be
selected in SQL because the key is derived in Python from the row's names.

On a copy of a real ledger (about 19,000 transactions, 6,400 in the window), a scoped scan for one payee
takes about 62 ms and a full scan about 130 ms. Reading and normalizing the window is roughly half the
scoped cost; re-pairing the money movements once per transfer series is most of the rest.

**The fix is storing the key.** `payee_key` on `txn`, with an index, turns the payee read into a lookup.
It needs:

- a column, a backfill, and a migration to recompute it whenever `_normalize_payee` or
  `resolve_txn_name` changes;
- **one writer and a guard**: every write of `merchant_name`, `display_name` or `raw_name` goes through a
  helper that also writes the key, with a test that fails on any other. Some writes build their `SET`
  list dynamically, so the guard is harder to make exact than the trash and account-group ones.

**When to do it:** once the normalizer looks settled enough that recomputing the key will be rare, or
when edit latency becomes noticeable (a scoped scan nearer 150 ms, on a ledger with roughly three times
today's window).
