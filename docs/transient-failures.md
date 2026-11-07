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

**Status: fixed in the test (2026-10-25). Sunset: 2026-11-22.** Before the fix it fired in roughly one full
browser run in four, so a month of the suite's usual few runs a week would almost certainly have shown it
again. If it has not fired by then, delete this entry and the diagnostics in the spec
(`instrumentTrendClick`, `trendClickReport`), and add the lesson to `agent-profile.md` → *Writing a test*:
after a chart or a list re-renders with new data, wait for the new content to replace the old rather than
for the request.

**Last seen: 2026-10-25.**

### Symptom

`frontend/tests/ui/dashboard.spec.js` → *single-period trend keeps its grain chooser through bar clicks
and compares exact spans* fails at the first bar click: the trend's chooser has just been switched to
*Same span each month* under *Month to date*, the test clicks in the column of the oldest plot bar, and
`← Back to Month to date` never appears in 20 seconds. The failing run took 23.2s against ~3.5s for a
passing one, in a full browser run on 7 workers. Once in three full runs that day; it has passed in every
run since.

### Evidence

The screenshot, video and trace were lost: the suite was re-run before they were read, and Playwright
empties `test-results/` at the start of every run. What was noted from the screenshot first:

- the chooser read *Same span each month*, so the switch had happened;
- the pointer sat over the oldest plot bar (Sep 2025), with recharts' hover band drawn;
- the tooltip read "Sep 1 – Sep 17, 2025 · Spending: $58.90", which is same-span data, so by the time of
  the screenshot the new buckets had rendered;
- there was no back-step button, so the click never re-pinned the period.

A second occurrence (2026-10-25, a full run on 7 workers; it passed in the next full run and in nine
repeats of the spec), and a third the same way later that day, failed one step earlier, before any
click: `bar.scrollIntoViewIfNeeded()` reported the bar `firstPlotBar()` had returned as not stable and
then not attached to the document. That bar was
found by position (`nth(count / 2)`), so it was one of the bars on screen *before* the same-span
response, and the chart replaced it while the test was scrolling to it. The click report below did not
print, because it only covers failures from the click onward.

### What is suspected, and why it is not proven

The test waits for the same-span *request* to be sent, not for its response, and then measures the bar
and clicks. In a passing run the response lands about 220ms before the click, because finding the bar
takes that long; a response slower than that lands between the measurement and the click, or after it.
Two ways that loses the click, and the screenshot fits both:

- **The chart is redrawn under the press.** The response replaces the bucket set, and the pan
  re-anchors on a new set (`Dashboard.jsx`, the `useLayoutEffect` keyed on `trendBucketsKey`), so the
  mousedown and the mouseup can land on different nodes, or the click on a column the press was not on.
- **recharts reports nothing active at the click.** The trend's click reads the hover state, not the
  click position (`lib/chartInteraction.js`), and a click with no active index is ignored. A click in the
  same frame as a redraw can find that state reset.

The test now waits for the same-span response and then for a bar from the monthly chart to leave the
page before it finds one, so the first way cannot recur: the chart it measures and clicks has finished
redrawing. That wait cannot hide the second, which would be a defect a person can hit: a click ignored on
a settled chart still fails, and the report below says so.

### What the next occurrence will say

`instrumentTrendClick` in the spec records, on the page's clock, every summary request and when it settled,
and for each mousedown, mouseup and click: the element under the pointer, whether it was inside the chart,
the bar count, **whether the bar the test measured is still in the document**, the plot's scroll offset,
and **the tooltip recharts was showing**. The failure prints all of it from the switch to same span
onward, timed against the bar's mousedown, with the chooser and the date chip as they stand.

- A range-trend response between *bar measured* and the mousedown, the measured bar detached, or a scroll
  offset that moved: the chart was redrawn under the click, which the wait above should now prevent, so
  look first at what else redraws the chart.
- The measured bar still attached, the scroll unchanged, and no tooltip showing at the click: recharts
  dropped a click on a settled chart. That is a product defect.

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
