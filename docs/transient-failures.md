# Transient failures under investigation

**Live register, not a backlog.** Each entry is a test failure that happens intermittently, is not
understood yet, and has been instrumented so the *next* occurrence explains itself. Backlog files hold
work that is parked; nothing here is parked — these are open questions waiting on evidence that only
arrives when the failure next fires.

**An entry is deleted when its failure is fixed**, and this file goes when the last entry does. Anything
durable an entry produced — a rule, an invariant, a lesson about how the system behaves — belongs in the
topic doc that owns it before the entry is removed.

**Each entry carries a last-seen date**, bumped whenever its failure fires again. Without one there is no
way to tell a live failure from one that something else has already fixed — and for an entry whose fix has
landed but was never reproduced on demand, the quiet time since that date is the only confirmation there
is. Where the date is a bound rather than an observation, it says so.

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

**Last seen: 2026-09-05** — the occurrence itself was not dated, so this is the day the entry was written
and the latest it can have been.

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

## 2. A row marked reviewed does not settle: the marker returns, or the row leaves the list

**Status: cause identified and fixed (2026-09-19). Kept until a clean run history confirms it, because
the failure was never reproduced on demand — a recurrence now means the fix did not cover it.**

**Last seen: 2026-09-19** — the fix landed the same day, so quiet time from here is what confirms it.

### Symptom

`frontend/tests/ui/needs-review-marker.spec.js` fails somewhere after the click. Two tails were seen, and
they are opposites:

- **2026-09-17 — the marker came back.** The marker count was unchanged (23 where 22 was expected) for the
  full 20-second budget, and the failure screenshot showed the clicked row still carrying its **R**.
- **2026-09-19 — the row left the list.** The marker assertion *passed* (the marker did clear), and the
  count label then read `123 transactions` where `124` was expected.

Both failing runs were slow: 25.7s and 27.3s against the ~7s a passing run takes. Once in four full gate
runs on the first day, once in two on the second.

### The cause

**Two loads of the same query were both committing, and arrival order decided which one the grid kept.**

`load()` in `pages/Transactions.jsx` guarded against out-of-order responses by comparing a key built from
the resolved filter params. That answers "did the filters change while this was in flight" and is blind to
the case where they did not: two concurrent loads for one query produce an *identical* key, so both passed
the check and both called `setData`. Whichever response landed last won.

That single mechanism produces both tails, which is what identified it:

- a duplicate load served **before** the write, settling **after** the row patch → `total=124`, row still
  `needs_review=1` → the patch is overwritten and the marker comes back;
- a duplicate load still in flight at click time, served **after** the write commits → `total=123`, row
  absent → the count falls.

Either needs a slow run to widen the gap between the two responses, which is the one property both
failures shared. The count label reads `data.total` straight off the last list response and the row patch
cannot touch it, so a count that moves is a response that *arrived* — that is what ruled out a local edit
and pointed at the load.

**Where the overlap came from here is React StrictMode, which double-invokes effects in development only**
— the browser suite runs against the Vite dev server, so it sees two identical list requests about 1 ms
apart on every load. That is StrictMode working as intended rather than a defect of its own, and a
production build issues one. The defect it exposed is not dev-only: `useAfterLedgerSync`, the Refresh
button and `bulk.onReload` all re-load with the filters unchanged and can overlap a load already in
flight.

### The fix

The guard counts **calls** rather than queries: `loadSeqRef` is incremented per call and compared after
the await, so any newer call wins whether or not the filters changed. It subsumes what the key was for and
cannot collide. The durable version of the rule is the comment on that guard in
`frontend/src/pages/Transactions.jsx`; delete this entry and keep that.

`src/pages/__tests__/TransactionsLoadRace.test.jsx` pins it deterministically: the page is rendered inside
`StrictMode`, every load is held open, the newest resolves first and the older ones after, and the newest
must still be what the grid shows. It fails against the old guard.

### What a recurrence would say

The fix missed something, and the instrumentation is still in the spec to say what.
`instrumentTransactionFetches` wraps the page's own `fetch` through `addInitScript` — test-side only, so
nothing production-side changes — and **all four post-click assertions** report, not just the first. (The
2026-09-19 run lost every diagnostic because only the marker assertion was wrapped and the failure landed
one line lower.) A failure carries:

- **the clicked row's state on the server**, read back through the API by the payee the app's own
  confirmation named. `needs_review: 0` is a write that landed; `1` is one that did not.
- **every `/api/transactions` request the page made**, each with the time it was issued *and* the time it
  settled, both relative to the click — so a response in flight across the click is visible as itself
  rather than inferred.
- **what came back**: `total`, the row count, and how many of those rows still need review. Matching a
  moved count against the `total` of a specific response is what names the culprit response.
- **what issued each one**: the JS stack at the call, which tells a React effect apart from an event
  handler apart from a late timer.

Times are `performance.now()` rather than `Date.now()`, deliberately: this host's wall clock steps
backwards (entry 1 above), and every question here is a question about ordering.

---

## 3. `database is locked` in the browser lane, specs reading an empty ledger

**Status: not understood. The holder of the lock is the open question; the candidates that looked
obvious were measured and ruled out.**

**Last seen: 2026-10-15** — **three of four gate runs**, against **0 of 2** standalone
`npm run ui:test` runs on the same tree, same worker count (10). Gate-only is the one reproducible fact
about *when* it happens: the browser lane runs after the backend suite (2763 tests, 20 workers) and
vitest (164 files), so the machine is loaded by the time it starts. At three in four it is closer to
reliable-in-the-gate than intermittent, which is itself the strongest hint — whatever holds the lock is
being made slow rather than being triggered.

### Symptom

One to four `app` specs fail together, each on a `toBeVisible` that times out with `element(s) not
found`. **The failing assertion names the symptom badly in every case**: the page snapshot shows the
ledger reporting `0 transactions` with the list still `Loading…`, so nothing was wrong with the tags,
documents or markers the assertions were about — the page could not read. `transactions.spec.js:7`
(inherited category tags) failed in both occurrences; `documents.spec.js`, `duplicates.spec.js` and
`needs-review-marker.spec.js` joined it in the first. `demo-data.spec.js` passes earlier in the same
run, so the ledger is seeded and the data is there.

Alongside it, four to eight `sqlite3.OperationalError: database is locked` tracebacks in the
`[WebServer]` output.

### What the lock errors mean here, exactly

`get_db` sets a **15-second** busy timeout (`_BUSY_TIMEOUT_SECONDS`), so these are not instant
collisions: **some writer held the write lock for more than fifteen seconds.** That also explains the
20-second spec timeouts — a request waits out the 15s, fails, and the page never fills.

The sites in the tracebacks are **victims, not the holder**, which is why they look unrelated and move
between runs. Three of the four are incidental writes that a read or a view preference triggers:

- `services/reconciliation_attention.py` → `batch_attention`, which **writes its cache on a read path**
- `services/preferences.py` → `set_preference`
- `services/documents.py` → `rename_document`
- `routers/transactions.py` → `_apply_bulk_action`, the `mark_reviewed` branch

### Candidates measured and ruled out

Both were timed against a freshly seeded demo ledger (445 rows) on an idle machine, which is the
wrong machine state but the right order of magnitude to exclude them:

- **The first-load duplicate re-examination**, which used to run on every fresh stack because
  `init_db` wrote no `duplicate_detection_version`: **~5 ms**. `init_db` now stamps a fresh database
  (`stamp_detection_version`), so the pass no longer runs there at all — that was worth doing on its
  own, as waste avoidance, and it is **not** a fix for this entry. Ruled out before it was changed, and
  the failure has been seen since.
- **The demo-data load**, one write transaction for the whole dataset (`POST /api/auth/demo-data`):
  **~0.81 s**. It would need roughly a twentyfold slowdown to cross the timeout.

### It is a permanent stall, not an intermittent — the flake is the tail of it

The slowest four spec durations in each condition, same tree, same 10 workers:

| condition | slowest four (s) |
| --- | --- |
| standalone, cold | 18.4 · 16.3 · 15.5 · 15.4 |
| standalone, after a vitest run | 20.9 · 19.1 · 17.2 · 15.1 |
| inside the gate | 34.2 · 32.5 · 26.3 · 21.1 |

**Every condition has specs sitting at or just above fifteen seconds**, which is
`_BUSY_TIMEOUT_SECONDS`. Those specs are waiting out the write lock and then succeeding. Load does not
cause the contention; it shifts the distribution until some spec crosses its own 20-second assertion
timeout and the wait becomes a failure. A cold run is not a clean run, it is the same stall with more
headroom — which is why "it passed standalone" was the wrong conclusion to draw, twice.

Two consequences worth stating. The lane is paying this on every run, so whatever is fixed here makes
it faster rather than merely greener. And the shape argues against one long writer: ten workers each
triggering incidental writes on page load (a view preference, an attention-cache recompute) serialize
against WAL's single writer, and each waits up to the timeout. That is contention among many short
writes, not one transaction held open — the opposite of the sync-across-network-calls case
`_BUSY_TIMEOUT_SECONDS` was sized for.

### What the next occurrence needs

Nothing in the current output identifies the holder, which is why this entry cannot say. What would:

- the writer's identity and duration — log the statement and elapsed time whenever a `get_db()` block
  holds a write transaction beyond a second or two, which is cheap and would name the holder directly,
  and would also settle one-long-holder against many-short-writers;
- whether taking the write off the read paths is enough on its own: `batch_attention` recomputing its
  cache during a GET is the clearest candidate, and the attention count is a cache by construction;
- `PRAGMA wal_checkpoint` / WAL size at the time, since an unbounded WAL and a blocked checkpointer
  present exactly this way;
- whether the frontend dev server's own `--reload` backend was also running against a different
  database on the same host, which affects machine load but not this lock.

**Until the holder is named, a red run matching this signature is not evidence about the change in
hand**: look for the `0 transactions` / `Loading…` snapshot and the lock tracebacks before concluding
anything. The lane's database is wiped and re-seeded per launch (`scripts/run-e2e-backend.sh`), so no
migration or accumulated state is involved, and `reuseExistingServer: false` rules out a stale server
holding the old file.

Distinct from entry 2 despite sharing a spec list: that one is two reads committing out of order and
leaves the page populated, while this one leaves it empty with a lock error behind it.

---

## Not an entry: the cash-flow frame, and the 401 burst behind it

Recorded because it was filed three times as three separate intermittents and someone will otherwise
re-open it. **All of it is fixed**; the durable half is in `backend/session_signing.py`.

The one bug wore three masks, none of which named it: `cash-flow.spec.js` failing with `Money out · `
never visible (the frame switched correctly and its data request returned 401), a
`DELETE /api/import-export/profiles/{id}` answering 401 where the helper asserts `[200, 404]`, and any
other spec unlucky enough to be mid-request. The cause was the host clock stepping backwards, which
invalidated every session cookie signed in the skipped window. **If a burst of `[auth] rejected` lines
appears again**, the rejection line now carries a re-verify verdict; an `expired (age -Ns)` there would
mean a step larger than the five-minute tolerance, which is a new fact and not this bug returning.
