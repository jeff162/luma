# Recurring detection — the pool-load optimization

**Everything else shipped.** The recurring-series subsystem is live end to end — detection, curation,
the rule-backed path, the ended/canceled lifecycle, the four anomaly/forecast signals (2026-08-27), and
amount identity with the user-pinned expectation band (2026-09-01, schema v46). All of it, including
every shape that was tried and rejected on the way, is in [`../data-model.md`](../data-model.md) →
*Recurring series* and `architecture.md` → *Recurring series*.

One deferred item remains, and it is a cost question rather than a design one.

## The scoped scan costs what a full scan does

`scan_and_store` takes an optional `payee_keys` scope, but the payee filter is applied **after a full
pool load** — so a scoped pass loads the whole ledger and then throws most of it away. Measured on a
20,000-row synthetic ledger: **~125 ms scoped against ~124 ms unscoped.**

Correctness does not depend on this. `_match_members` filters by each series' own payee, category and
account, so the pool's breadth changes only cost, never outcome — which is why the scoped path was safe
to ship unoptimized.

**What changed is who pays it.** The scan was originally only on the import/sync path, where 125 ms is
invisible. It is now on the path of **every category edit** (`owe_recurring_rescan` keeps
membership from going stale when a recategorization moves a row out of its series), and the cost grows
with the ledger rather than with the edit.

**Why it has not been taken.** Pushing the filter into SQL needs `payee_key` **materialized** on `txn`
rather than derived in Python — a column, a backfill, and maintenance at every write site. That is a
real ongoing obligation traded for a millisecond figure that is not yet uncomfortable.

**The two mitigations already in place**, which are why this is deferred rather than urgent: a no-op
edit (re-saving the same category) skips the scan entirely, and a bulk edit scans **once for the batch**,
so the cost is per request rather than per row.

**Revisit threshold.** When either the measured edit latency or the ledger size makes it noticeable —
call it a ledger past roughly **50,000 rows**, where the same measurement would land nearer 300 ms.

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
|---|---|---|---|
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
