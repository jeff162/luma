# Recurring detection — the pool-load optimization

**Everything else shipped.** The recurring-series subsystem is live end to end — detection, curation,
the rule-backed path, the ended/canceled lifecycle, the four anomaly/forecast signals (2026-08-27), and
amount identity with the user-pinned expectation band (2026-09-01, schema v46). All of it, including
every shape that was tried and rejected on the way, is in [`../data-model.md`](../data-model.md) →
*Recurring series* and `architecture.md` → *Recurring series*, with the page's own interaction rules in
[`../ui-patterns.md`](../ui-patterns.md).

One deferred item remains, and it is a cost question rather than a design one.

## The scoped scan costs what a full scan does

`scan_and_store` takes an optional `payee_keys` scope, but the payee filter is applied **after a full
pool load** — so a scoped pass loads the whole ledger and then throws most of it away. Measured on a
20,000-row synthetic ledger: **~125 ms scoped against ~124 ms unscoped.**

Correctness does not depend on this. `_match_members` filters by each series' own payee, category and
account, so the pool's breadth changes only cost, never outcome — which is why the scoped path was safe
to ship unoptimized.

**What changed is who pays it.** The scan was originally only on the import/sync path, where 125 ms is
invisible. It is now on the path of **every category edit** (`rescan_edited_transactions` keeps
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

## Tuning notes

The detector constants sit at the top of `services/recurring_detection.py`: `_CONFIDENCE_THRESHOLD`
(the emit bar), `_SNAP_TOLERANCE` (gap → cadence snapping), `_FALLBACK_AMOUNT_CV_MAX` (the
amount-tightness gate on the clustering fallback), and the long-period two-occurrence allowance
(`_LONG_PERIOD_DAYS`). The scan is idempotent and re-runnable, so these can be tuned against real data
without a migration — which is the reason they were left as constants rather than settings.
