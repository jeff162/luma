# Write-lock contention

**Status: cause established 2026-10-15, nothing started.** Diagnosed while auditing `data-model.md`
against the code; the audit's own findings shipped separately. Two independent defects combine here,
and either can be taken on alone.

The symptom that led to it is a flaky browser lane, which undersells it: the same two defects sit on
every category edit and every import-card read in the running app.

## What happens

SQLite in WAL mode lets readers run freely and serializes writers. `get_db` sets a 15-second busy
timeout (`_BUSY_TIMEOUT_SECONDS`), so a writer that cannot get the lock waits up to fifteen seconds and
then raises `database is locked`.

Under the browser lane's ten workers, requests reach that ceiling. A spec whose page cannot read sits
at 15–18 seconds and then passes; one whose assertion deadline (20s) expires first fails with
`element(s) not found` while the page still shows `0 transactions` and `Loading…`. The victim moves
between runs, which is why it read as an intermittent for a long time.

**The stall is present on a cold single run.** Load decides whether it crosses an assertion deadline,
not whether it happens.

## Defect 1: a write transaction held across work that is not SQL

`PATCH /transactions/{id}/category` (`routers/transactions.py`) does the category write, then
`rescan_edited_transactions`, then tag resolution, then the refund lookup — all inside one `get_db()`
block. Measured in the lane:

```
span 6.29s  write 0.15s  read 0.07s  idle 6.07s  stmts 10w/19r
  first:   UPDATE txn SET category_id = ?, category_overridden = 1, category_source = 'manual' …
  slowest: UPDATE txn SET recurring_series_id = ?
```

**6.07 of those 6.29 seconds ran no SQL at all**, with the write lock open throughout. The rescan is
not slow in itself — 0.01s for one row on a 445-row ledger with the machine idle. It is a scan whose
pool load and scoring get descheduled while holding the lock, and a scan loads the whole detection
window before filtering by payee (see [`recurring-detection.md`](recurring-detection.md)).

This is the shape `_BUSY_TIMEOUT_SECONDS` already records as the contention that used to matter — a
sync holding its transaction across provider network calls, fixed by committing per page — and the
opposite of what `get_db`'s docstring prescribes for work another request has to see.

**The shape repeats.** `PATCH /{id}/amount`, the bulk editor and the rule-apply paths all call a rescan
inside their own write block. Fixing one endpoint and leaving the others is worth less than it looks.

### What it needs

Commit the write, then rescan in its own short block. The ordering requirement is only that the scan
runs *after* the write — `data-model.md` → *When a scan runs* — not that it runs inside it.

The design pass owes answers on:

- **What a crash between the two leaves behind.** `txn.recurring_series_id` is a cache the next scan
  rebuilds (`data-model.md` → *Recurring series*), which argues this is safe, but the same is not
  obviously true of the other callers.
- **Which callers get the treatment**, given the four paths above share it.
- **Whether the prior-payee-keys capture still works** when the write commits first. The callers read
  prior keys *before* writing precisely because the rename moves rows between payee groups, so the
  capture and the scan would straddle two transactions.

## Defect 2: read paths write, so there is always a queue

Every contended block logged over seven gate runs, by its first write:

| blocks | statement | triggered by |
| --- | --- | --- |
| 18 | `INSERT INTO ui_preference` | a page load saving view state |
| 13 | `UPDATE import_batch SET recon_attention_count` | **a GET**, recomputing the attention cache (73 reads each) |
| 8 | `INSERT INTO db_meta` | the PayPal and reconciliation attention caches, same shape |
| 7 | `DELETE FROM import_batch_account` | batch totals refresh |
| 4 | `UPDATE txn` | real edits |

Ten workers merely *reading* pages therefore produce a steady stream of writers. **SQLite's busy
handler is not FIFO**: a waiter that sleeps can be passed over by threads arriving fresh, so a steady
stream plus a fifteen-second timeout starves the unlucky request for ten to fourteen seconds. The
waiters show this directly — a single-row update by primary key spending its entire span inside one
blocked `execute`:

```
span 13.86s  write 13.86s  read 0.00s  idle 0.00s  stmts 1w/1r
  first: UPDATE document SET filename = ? WHERE id = ?
```

### What it needs

`batch_attention` (`services/reconciliation_attention.py`) recomputing its cache during a GET is the
clearest case, and the `db_meta` attention keys are the same shape. Options not yet weighed: compute on
write instead, accept a stale count on read and refresh out of band, or keep the cache in a store whose
writes do not contend.

This is the larger lever of the two, and the more invasive change.

## Obstacles

- **Reducing the lane's worker count masks it and fixes nothing.** The stall is present on a cold
  single run; fewer workers only lowers the collision rate.
- **Raising `_BUSY_TIMEOUT_SECONDS` is worse than leaving it.** Its own comment says why: a longer
  timeout trades a visible error for an invisible stall, which is the worse failure for a request
  someone is waiting on.
- **Measuring this needs the right instrument, and the obvious one is wrong.** A
  `set_trace_callback` fires when a statement *begins*, so a statement blocked waiting for the lock
  reads as time spent holding it — that reading reported a four-statement document rename as a
  seven-second hold, while 1954 statements elsewhere committed in 1.8s. Timing each `execute` from a
  `sqlite3.Connection` subclass is what separates the two, and **reads have to be timed as well as
  writes**: a read inside a held transaction keeps the lock exactly as a write does, so leaving reads
  out makes a slow read indistinguishable from a stalled thread. The signature to read off is
  `slowest-stmt ≈ span` with one write for a **waiter**, and large `idle` with few statements for a
  **holder**.
- **Three candidates were measured and ruled out** before the instrument was right, so a second attempt
  need not revisit them: the first-load duplicate re-examination (~5 ms, and since made a no-op on a
  fresh database), the demo-data load (~0.81 s in one transaction), and the attention cache's
  invalidation fan-out (3 batches, so frequency rather than fan-out is what matters).

## Open

Nothing is owed to another topic. Both halves are implementation decisions inside this file.
