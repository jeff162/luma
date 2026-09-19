# Transient failures under investigation

**Live register, not a backlog.** Each entry is a test failure that happens intermittently, is not
understood yet, and has been instrumented so the *next* occurrence explains itself. Backlog files hold
work that is parked; nothing here is parked — these are open questions waiting on evidence that only
arrives when the failure next fires.

**An entry is deleted when its failure is fixed**, and this file goes when the last entry does. Anything
durable an entry produced — a rule, an invariant, a lesson about how the system behaves — belongs in the
topic doc that owns it before the entry is removed.

**Read this before re-running a red suite.** The rule it exists to serve is in
[`agent-profile.md`](agent-profile.md) → *Verification And Tests*: a failure is investigated when it
happens, before anything else, because a green re-run destroys the evidence. The gate writes every run
whole to `data/check-logs/` and prints the path on its last line; a failed run's logs are kept until a
later failure replaces them. Check whether a red run matches an entry below before concluding anything
about the change in hand. One entry can also wear several different masks: the session-cookie bug below
was filed three times under three spec names before it turned out to be one thing, so **grep the
preserved log for the symptom rather than trusting the failing test's name**.

---

## 1. Two documents on one transaction list in the wrong order

**Status: instrumented, waiting on a recurrence.**

### Symptom

`test_documents_api.py::AttachAndServeTests::test_several_documents_hang_off_one_transaction_in_attach_order`
fails: two documents attached to one transaction come back in reverse attach order.

**Roughly 1 in 11 full backend runs, and never in 60 runs of that file alone** — it needs the parallel
suite (pytest-xdist, 20 workers). That asymmetry is itself the most interesting fact about it.

### Why it is strange

The listing already has the tiebreaker anyone would reach for
(`services/documents.py` → `list_documents`):

```sql
SELECT … FROM document WHERE txn_id = ? ORDER BY created_at, rowid
```

Each test builds its own temp database, so the table is two rows old and the rowids are 1 and 2. The
tiebreaker therefore cannot be what failed, which leaves `created_at` — written by `utcnow_iso()` at the
`INSERT`, microsecond ISO-8601. A healthy run has the two about 8ms apart and correctly ordered.

The one way ISO-8601 strings sort against chronology — `isoformat()` omits the microsecond field entirely
when it is zero, giving a 19-character string against a 26-character one — was checked and is **not** the
explanation: the shorter value is a prefix of the longer, so it still sorts first in both directions.

### What the next occurrence will say

The assertion now dumps `rowid`, `id` and `created_at` for both rows, which separates the three
candidates: equal timestamps (a tie the rowid should then have settled), an inverted pair (the wall clock
moved backwards mid-run), or rowids that are not what a fresh table should hold.

**The middle candidate is no longer speculative, and it is the one to check first.** This host's clock
*does* step backwards, by one to three seconds, repeatedly — that was established while chasing the
session-cookie bug (one run carried 81 rejections at negative ages), and it is a property of the machine
rather than of anything that was then fixed. A pair of `created_at` values written 8 ms apart across such
a step would invert, and `ORDER BY created_at, rowid` orders by the inverted column first. The dump will
say so directly: an inverted pair with ascending rowids is that, and nothing else.

---

## 2. A row marked reviewed comes back still needing review

**Status: seen once (2026-09-17), instrumented, waiting on a recurrence.**

### Symptom

`frontend/tests/ui/needs-review-marker.spec.js` fails on its first assertion after the click: the marker
count is unchanged (23 where 22 was expected) for the full 20-second budget. The failure screenshot shows
the clicked row — the first in the list — still carrying its **R** marker.

**Once in four full runs of the gate that day**, and the failing run was slow: 25.7s against the ~7s the
passing runs take, which is the only other thing that distinguished it.

### Why it is strange

The click's own confirmation had already been asserted, so the sequence got as far as a successful write:
`markReviewed` awaits the bulk update, *then* patches the row and raises the toast
(`lib/useTransactionRowActions.jsx`). The toast was on screen and the patch was not — or was, and was
then undone. Nothing on this page subscribes to the mutation events that could re-query it
(`luma:transactions-changed` has no listener here, and `luma:data-mutated` refreshes the Tasks badge),
which is what makes the surviving explanation a *stale response* rather than a deliberate reload.

Two candidates remain, and they are opposites:

- **The write never landed** — the bulk update answered but the row is still flagged on the server. That
  would make the toast a lie and point at the endpoint, not the page.
- **The patch was overwritten** — a list response already in flight when the click happened arrived
  afterwards carrying the pre-click rows, restoring the marker the patch had cleared. Under a slow run
  that window is exactly the one that widens.

### What the next occurrence will say

The spec now reports, on that assertion only:

- **the clicked row's state on the server**, read back through the API by the payee the app's own
  confirmation named. `needs_review: 0` is the overwrite; `1` is a write that did not land.
- **every `/api/transactions*` request the page made**, in order, split at the click — so a list response
  arriving after the write is visible as itself rather than inferred.

Those two together decide it without needing the failure to be reproducible.

---

## 3. A second sync of the same transaction reads as the first

**Status: seen once (2026-09-19), instrumented, waiting on a recurrence.**

### Symptom

`test_sync_diagnostics_log.py::SyncDiagnosticsLogTests::test_the_sums_are_derived_and_no_column_holds_them`
fails on `self.assertEqual(row["skipped"], 1)` with `0 != 1`. The test syncs one transaction twice and
reads the newest log row, which should be the second sync's, holding the transaction as already held.
`skipped` 0 is what the *first* sync writes. The preserved output is
`data/check-logs/20260919-160000-sums-test-intermittent.log`.

**Once, in a sequential (non-xdist) run of five backend files**, and then green in 6 runs of the test
alone, 8 of the same five files, and two full gates. Its sibling
`test_a_re_fetched_row_counts_as_already_held_not_as_lost` has the same shape and would fail the same way.

### Why it is strange

"Newest" is `ORDER BY started_at DESC, id DESC` (the test's `_log_rows`), and `started_at` is the wall clock
at the start of each connection's pull (`_utcnow_iso` in `routers/sync.py`). A probe of 40 back-to-back
syncs found no two rows sharing a `started_at`, so it is not a tie broken by the random `id`.

That leaves two candidates:

- **The clock stepped backwards between the two syncs**, which are a few milliseconds apart. The second
  row then sorts before the first and the test reads the wrong one. This host's clock is known to step back
  by one to three seconds (entry 1, and the session-cookie note below), so this is the one to check first.
- **The first sync did not leave the transaction behind** — not inserted, or rolled back — so the second
  genuinely added it. That would be a real defect in the sync ingest, not in the test.

### What the next occurrence will say

Both tests' assertions now dump (`_two_syncs_dump`) the log rows in `rowid` order — insertion order, which
the clock cannot disturb — with their `started_at`, `added`, `skipped` and `account_counts`, and every
`txn` row with its `external_transaction_id`, `trashed_at` and `import_batch_id`.

- A higher `rowid` carrying an **earlier** `started_at`, with `t1` held once: the clock step. The fix is
  then the test's ordering (`ORDER BY rowid`), not the product; the dialog's own `started_at` ordering
  would merely show two entries swapped.
- Rows in order, `added` 1 on both, or no `t1` after the first sync: the ingest lost the row, and this
  stops being a test problem.

---

## Not an entry: the cash-flow frame, and the 401 burst behind it

Recorded because it was filed three times as three separate intermittents and someone will otherwise
re-open it. **All of it is fixed** (`backend/session_signing.py`); the durable half is in
`security-model.md` → *Identity and the network perimeter*.

The one bug wore three masks, none of which named it: `cash-flow.spec.js` failing with `Money out · `
never visible (the frame switched correctly and its data request returned 401), a
`DELETE /api/import-export/profiles/{id}` answering 401 where the helper asserts `[200, 404]`, and any
other spec unlucky enough to be mid-request. The cause was the host clock stepping backwards, which
invalidated every session cookie signed in the skipped window. **If a burst of `[auth] rejected` lines
appears again**, the rejection line now carries a re-verify verdict; an `expired (age -Ns)` there would
mean a step larger than the five-minute tolerance, which is a new fact and not this bug returning.
