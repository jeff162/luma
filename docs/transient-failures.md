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
