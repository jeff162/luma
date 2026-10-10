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
cannot collide. The durable version of the rule is in
[`ui-patterns.md`](ui-patterns.md) → *An edited transaction lingers where it was found*; delete this entry
and keep that.

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
