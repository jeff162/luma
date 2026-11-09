# Transient failures under investigation

**Live register, not a backlog.** Each entry is a test failure that happens intermittently, is not
understood yet, and has been instrumented so the *next* occurrence explains itself. Backlog files hold
work that is parked; nothing here is parked — these are open questions waiting on evidence that only
arrives when the failure next fires.

**An entry is deleted when its failure is fixed**, and this file goes when the last entry does. Anything
durable an entry produced — a rule, an invariant, a lesson about how the system behaves — belongs in the
topic doc that owns it before the entry is removed, and the diagnostics the entry added to its test go
with it. Entries keep their numbers, because tests and comments cite them by number.

**A fix that was never reproduced on demand gets a sunset date**, because a passing run proves nothing
about a failure that only fires now and then. The date is chosen from how often the failure used to fire,
far enough out that it would almost certainly have fired again in the meantime if the fix had missed. If
the date passes quietly, the entry is deleted; if the failure fires first, the entry is updated and the
date moves.

**Each entry carries a last-seen date**, bumped whenever its failure fires again. Without one there is no
way to tell a live failure from one that something else has already fixed — and for an entry whose fix has
landed but was never reproduced on demand, the quiet time since that date is the only confirmation there
is. Where the date is a bound rather than an observation, it says so.

**Read this before re-running a red suite.** The rule it exists to serve is in
[`agent-profile.md`](agent-profile.md) → *Verification And Tests*: a failure is investigated when it
happens, before anything else, because a green re-run destroys the evidence. The gate writes every run
whole to `data/check-logs/` and prints the path on its last line. When its browser suite fails, it also
copies Playwright's screenshots, videos and traces to `data/check-logs/last-browser-failure/`, which only
the next browser failure replaces, since Playwright empties `frontend/test-results/` at the start of every
run. Both are deleted after 30 days. Check whether a red run matches an entry below before concluding anything
about the change in hand. One entry can also wear several different masks: the session-cookie bug below
was filed three times under three spec names before it turned out to be one thing, so **grep the
preserved log for the symptom rather than trusting the failing test's name**.

**Opening an entry.** When a failure matches no entry and will not reproduce on demand:

1. Save the evidence before re-running anything.
2. Write down the leading theory and the alternatives it has to beat.
3. Add diagnostics that tell them apart: an assertion that dumps state, or a log line that names which
   path was taken. Then the next occurrence confirms or rules out the theory instead of just repeating
   the symptom.
4. Record the symptom, the theory, what was ruled out and why, and what each possible reading of the new
   diagnostics would mean.

When it fires again, update the entry with what the diagnostics showed and bump the last-seen date. If
the theory was wrong, replace it and add new diagnostics, rather than adding retries or lowering
parallelism: those make the failure rarer without explaining it. Without the diagnostics the same failure
gets filed again under another spec name and investigated from scratch.

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

## 3. A click on a same-span trend bar does not navigate

**Status: fixed in the product (2026-11-09). Sunset: 2026-12-07.** The chart was still dimmed as stale
when the test clicked, and a dimmed chart ignored pointer events (below). The cause was read from the
evidence but not reproduced on demand, so the sunset stands in for that: four failures in about two weeks
of runs means four quiet weeks would almost certainly have shown it again. If it has not fired by then,
delete this entry and the spec's diagnostics (`instrumentTrendClick`, `trendClickReport`), drop the entry
reference in `StaleWhileRefreshing`'s comment, and add the lesson below to `agent-profile.md`.

**Last seen: 2026-11-09.**

### Symptom

`frontend/tests/ui/dashboard.spec.js` → *single-period trend keeps its grain chooser through bar clicks
and compares exact spans* fails at the first bar click: the trend's chooser has just been switched to
*Same span each month* under *Month to date*, the test clicks in the column of the oldest plot bar, and
`← Back to Month to date` never appears in 20 seconds. A failing run takes about 25s against ~3.5s for a
passing one. Seen in full browser runs on 7 workers; it has not failed when the spec runs alone.

### Cause

`StaleWhileRefreshing` (`components/ui.jsx`) dims the trend and sets `pointer-events: none` while
`computedTrend` is null, through `useBusyIndicator`. That hook shows its state only after 150ms of
loading, then holds it for at least 400ms, so the chart can stay non-interactive for up to 400ms after the
new data has rendered. Switching to same span clears the trend for about 200ms, long enough for the dim to
show, and the test clicks about 400ms after the response, at the edge of that hold. A click inside the
window reaches the card behind the chart and does nothing.

This affects people too: a click on the trend within 400ms of it redrawing is ignored, with nothing to say
why. The dimming is right to linger, because removing it sooner would flicker. Blocking clicks is only
needed while the figures are actually loading, so `pointer-events` now follows `refreshing` rather than
the delayed `stale` state. The test is unchanged: it already waits for the same-span chart to replace the
monthly one, which means the data is current.

### How it was found

The fourth occurrence (2026-11-09, full run on 7 workers; the spec passed when re-run alone) printed:

- the response at −400ms, the bar measured at −7ms, and the click at 0;
- the measured bar still attached and the scroll unchanged (6px) from measurement to click, which ruled
  out a redraw under the click;
- no tooltip showing, and the click's target was a classless `DIV` outside `.recharts-wrapper`, even though
  (372, 455) was inside the plot's box.

That combination fit neither earlier theory. The Playwright trace's DOM snapshot at the click, rebuilt
and hit-tested at the test's 1280×720 viewport, showed the plot's container carrying `opacity: 0.45;
pointer-events: none`, so the point resolved to the card behind it.

Earlier occurrences (three on 2026-10-25) were read as a race between the same-span response and the
click. Two of them failed while scrolling to a bar the redraw had replaced. The test was changed to wait
for the response and for the monthly chart to leave, which fixed that failure. It also moved the click
later, closer to the end of the dim's 400ms hold.

### Lesson for `agent-profile.md` when this entry closes

A click that lands outside the element it aimed at, on a settled page, points to something that disabled
or covered the target: check `pointer-events` and overlays before looking for timing. A Playwright trace
keeps a DOM snapshot of each action, so the page at the moment of a failed click can be rebuilt and
hit-tested after the run.

---

## 4. Compaction test sees the database's size change when nothing was compacted

**Status: fixed in the test (2026-11-06). Sunset: 2027-01-05.** Seen once, so how often it fired is
unknown, and the sunset is set long for that reason. If it has not fired by then, delete this entry and the
comment in the test that cites it, and add the lesson to `agent-profile.md` → *Writing a test*:
`with sqlite3.connect(...) as conn:` commits but does not close, so a connection a test means to be gone
needs `closing()`.

**Last seen: 2026-11-06.**

### Symptom

`backend/tests/test_database_compaction.py` →
`CompactIfWorthwhileTests::test_slack_below_the_threshold_is_left_for_sqlite_to_reuse` fails at its last
assertion: `compact_if_worthwhile` correctly returned 0, but the database file plus its write-ahead log
measured a different size afterwards than before. Once in a full backend run; it passed in three runs of
the file alone straight after.

### Diagnosis

`setUp` built the fixture inside `with sqlite3.connect(...) as conn:`, which commits on exit and leaves
the connection open. A `sqlite3.Connection` holds a reference cycle through its statement cache, so it is
not freed when it goes out of scope but whenever the garbage collector next runs. SQLite folds the
write-ahead log into the database and deletes it when the **last** connection to the database closes:

- With the setUp connection still open, the deletion's connection was not the last, so the log survived
  and was counted in the "before" size.
- If the collector closed the setUp connection between the two measurements, the connection
  `compact_if_worthwhile` opens to read the free-page count became the last one, and closing it removed
  the log, so the "after" size differed.

When the collector runs depends on every allocation before it, which fits a failure that needs the full
suite. Confirmed in a standalone script with the collector disabled: the log survived the deletion while
the setUp-style connection stayed open, and was gone after a collection and one more open and close. Not
reproduced in the test itself, since the collector's timing cannot be forced there.

### Fix

`setUp` closes its connection explicitly (`closing(...)`), so no connection outlives it and the log's
lifetime no longer depends on the collector. The same script with the fix shows no log left after the
deletion. If it fires again, the leading theory is wrong: check for another connection held open across
the measurement, starting with any test-local `sqlite3.connect` not closed.

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
