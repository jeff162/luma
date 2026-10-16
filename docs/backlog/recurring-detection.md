# Recurring detection — the pool-load optimization

**Everything else shipped.** The recurring-series subsystem is live end to end — detection, curation,
the rule-backed path, the ended/canceled lifecycle, the four anomaly/forecast signals (2026-08-27), and
amount identity with the user-pinned expectation band (2026-09-01, schema v46). All of it, including
every shape that was tried and rejected on the way, is in [`../data-model.md`](../data-model.md) →
*Recurring series* and `architecture.md` → *Recurring series*.

One deferred item remains, and it is a cost question rather than a design one.

## A scoped scan still finds its payees' rows by reading the whole window

`scan_and_store` takes a `payee_keys` scope. A scoped pass reads every money-movement row in the window
(transfer pairing needs all of them) and reconciles a rule-backed series only when an edit touched it or
its rule changed (`docs/data-model.md` → *Rule-backed series*). What is left is the payee rows: there is
no way to select a payee's rows in SQL, because the key is derived in Python from the row's names, so the
pass reads and normalizes the whole window and keeps the rows in scope.

**Measured 2026-10-15** on a copy of a real ledger (about 19,000 transactions, 6,400 of them in the
window, four rule-backed series, 43 confirmed):

| | before this pass | after |
| --- | --- | --- |
| scoped scan, one payee | ~92 ms | **~62 ms** |
| full scan | ~145 ms | ~130 ms |

Before, the scoped scan's cost split roughly evenly between running the four rules over the whole window
and reading and normalizing it. After, reading and normalizing the window is roughly half of what is
left; re-pairing the money movements once per transfer series is most of the rest.

The scan follows **every write that changes what detection reads** (`owe_recurring_rescan`), running in
the request after the write commits, so this cost grows with the ledger rather than with the edit. The
frequent callers are single edits in the ledger:

- a transaction's category set or cleared, its merchant renamed, its amount changed, or one created by
  hand;
- a bulk edit;
- a transaction trashed or restored, from the ledger, the Trash, the duplicate report or the Amazon
  reconciliation report;
- rule actions: edit, apply, widen, delete with revert, cleanup, and the rule-suggestion review actions
  with their Undo.

The rest are already slow requests or rare: imports, syncs, import undo, emptying the trash, and
removing an account with its transactions deleted. Account merge, detach and regrouping, reassigning a
removed account's transactions, a transfer-pair answer and a global recategorize owe a full scan, which
no payee scope can narrow.

**What remains is storing the key, and it is parked.** `payee_key` materialized on `txn`, with an
index, turns the payee read into a lookup. It needs a column, a backfill, and a migration to recompute it
whenever `_normalize_payee` or `resolve_txn_name` changes — suspected to be rarely, but the current cost is low so its worth waiting a bit to see if that becomes a frequent event or not. This also needs the keeping the key current at every
write of `merchant_name`, `display_name` or `raw_name`, which requires:

- **One writer and a guard.** Every name write goes through a helper that also writes the key, with a
  test that fails on any other. The writes are many and some build their `SET` list dynamically, so the
  guard is harder to make exact than the trash and account-group ones.

**Revisit threshold.** When it doesn't seem likely that the field will need to be recalculated of when the measured edit latency makes it noticeable — a scoped scan nearer 150 ms,
on a ledger with roughly three times today's window.

## Recency is measured in periods, so a stale series' cadence is biased long

**Live bug, reproduced on real data.** `_score` rejects a reading whose last charge is older than three
periods — and applies that test *after* a cadence is proposed, so the longer the proposed period, the
more forgiving the test. When a series goes quiet, the correct cadence is the first reading disqualified.

Measured: fifteen charges at gaps of 28-34 days, median 30, snapping cleanly to **monthly** — and
`_detect_by_rhythm` returned nothing, because the newest was 336 days old against a 3 × 30-day bar. The
amount-cluster fallback then found three of those charges near one price, spanning 2024-10 to 2025-09,
median gap 168 days → **semiannual**, which clears 3 × 183 and is emitted at confidence 0.55. The wrong
cadence survived precisely because it was longer.

**Confirmation then freezes it.** A confirmed series is never re-derived, and `_write_series_stats`
rewrites counts, amounts, `last_txn_date` and `next_due` but never `cadence`/`period_days` — so an
invented cadence is permanent, and `next_due` (last + 183 days) lands in the past and stays there.

**Pairing removed the common trigger, not the bug.** The rows went stale because the payee's descriptor
drifted and each spelling's slice stopped growing; a money movement no longer depends on the descriptor.
Any *payee* series whose name changes is still exposed.

**The narrow fix**, not yet taken: do not let the amount-cluster fallback rescue a group whose rhythm
reading was rejected **only** for staleness. That is a one-line distinction inside `_detect_in_group`
(the rhythm path would have to report *why* it declined), and it turns the case above into "no series"
rather than "a wrong series" — which is the honest answer for a payee that has genuinely gone quiet.
Worth pairing with a decision about whether a confirmed series should ever have its cadence re-derived.

## A paired movement that is not a series is surfaced nowhere

**Not a bug — a hole the pairing opened by working.** `pair_money_movements` identifies every
two-legged movement in the ledger, but only the groups that settle into a rhythm become anything the
user can see. The rest are correctly identified, correctly withheld from payee matching (so they no
longer surface as one-sided fragments), and then displayed by nothing at all.

Measured on the reference ledger: **248 pairs across eleven account routes**, of which five routes
(164 pairs) score into movement series and six (**84 pairs, 168 transactions**) never will:

| route | pairs | median gap | why not a series |
| --- | --- | --- | --- |
| checking → a card paid on no schedule | 41 | 17 d | gaps 1–50 days, amounts $417–$5,646 |
| checking → a second card | 17 | 33 d | gaps too irregular to snap |
| a P2P wallet → checking | 12 | 28 d | withdrawals when the balance suits |
| savings → checking (the reverse sweep) | 8 | 58 d | occasional, not scheduled |
| checking → a seldom-used card | 4 | 33 d | too few, too spread |
| a payment processor → checking | 2 | 1 d | two occurrences |

Every one is a real, ongoing relationship between two of the user's own accounts. The rhythm test is
right to decline them — a card paid whenever it carries a balance is not a recurring obligation, and
inventing a cadence for it is the failure recorded in the section above. What is missing is anywhere
for a movement to *be* other than the Recurring page.

**The obstacle is that pairing is derived, never stored.** It is recomputed from the pool on each scan
and lives entirely inside `services/transfer_pairs.py`, so nothing outside recurring detection can ask
"is this row half of a transfer?" — not the ledger, not the transaction detail, not dedupe, not any
report. Anything user-facing needs either a stored link or a second consumer of the derivation.

**`mechanism-index.md` currently argues against storing it**, under *A recurring movement's two legs vs.
`txn_link`*: recording a link "would store what the rows already say". That reasoning was written when
recurring detection was the only consumer, and it holds for the rows a movement series already owns —
the series *is* the record. It does not cover the 84 pairs no series owns, which are exactly the case
where the rows say it and nothing keeps it. **Revisit the rejection with that split in mind rather than
re-deriving the whole argument**; if it changes, the entry there changes with it.

Two shapes worth weighing, neither designed:

- **A second consumer of the existing derivation.** Cheapest, stores nothing, stays consistent by
  construction. Enough for a read-only "money moved between these accounts" view, and for marking a
  paired row in the ledger. It cannot answer the question anywhere the pool is not loaded.
- **A stored `txn_link` kind.** Survives outside a scan, reaches every surface, and is the only shape
  that lets a user *correct* a pairing. Costs a migration, a maintenance obligation at every write site,
  and a reconciliation story for when the derivation and the stored link disagree.

**Not urgent, and cheap to leave alone:** nothing is wrong in the data, and the withholding already
stops the visible symptom. What is deferred is surfacing, not correctness.

## Tuning notes

The detector constants sit at the top of `services/recurring_detection.py`: `_CONFIDENCE_THRESHOLD`
(the emit bar), `_SNAP_TOLERANCE` (gap → cadence snapping), `_FALLBACK_AMOUNT_CV_MAX` (the
amount-tightness gate on the clustering fallback), and the long-period two-occurrence allowance
(`_LONG_PERIOD_DAYS`). The scan is idempotent and re-runnable, so these can be tuned against real data
without a migration — which is the reason they were left as constants rather than settings.
