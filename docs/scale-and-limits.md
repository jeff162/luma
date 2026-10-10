# Scale, limits and behavior at volume

What breaks as a ledger grows, what is deliberately capped, and which limits were accepted rather than
fixed. A personal ledger accumulates for years — hundreds of thousands of rows is an ordinary end
state, not a stress case — so "it works on my data" is never the question. The question is what the
cost is *proportional to*.

**This document is the register, not the mechanism.** Each bound is implemented somewhere that owns its
own design, and those places are not repeated here:

| Bound | Owned by |
| --- | --- |
| Database concurrency, and why a write transaction contains only its own work | `architecture.md` → *Database concurrency* |
| Provider request budgets, pacing and pausing | `building-a-connector.md` → *Request budgets and pausing* |
| Backup/restore streaming, the NDJSON layout, the incremental cipher | `data-model.md` → *Backups* |
| The list `limit` contract | `data-model.md` → *Categories* |
| Windowing rules a list must not break | `ui-patterns.md` |

What has no other home is the part below: **which caps exist on purpose, what each costs, and under
what condition it should be revisited.** That question is unfindable when its answers are distributed,
which is why it is collected.

---

## Three independent bounds, and the rule they share

A dataset can overwhelm the app in three separate places, and fixing one does nothing for the others:

- **The fetch** — how many rows leave the database. Bounded by pagination with server-side sort.
- **The DOM** — how many rows become real nodes. Bounded by render windowing.
- **Working memory** — how much a bulk operation holds at once. Bounded by streaming.

They are genuinely independent: a paginated list can still mount every loaded row, and a windowed list
can still be fed by an unbounded fetch. What connects them is one rule.

> **Nothing may accumulate a whole dataset** — not as a SQL result, not as DOM nodes, not as a Python
> list. Every one of the three defects below was an accumulation that looked bounded because the data
> was small when it was written.

## Fetch limits, and the caps that remain on purpose

**The 200-row default page is a safety rail, and it stays.** `txn` has no inherent size bound, so an
unbounded *default* would be the worse failure — a memory and render blowup rather than a bounded page
whose `total` tells the caller the real size. Unbounded is only ever the explicit `limit=0` opt-in, and
only for scopes the caller already knows are small.

**The standing audit is a runtime warning, not a review.** A `getTransactions` call that omits `limit`
and receives a truncated page warns in development. That is deliberately the whole audit: a silent
truncation regression is caught while it is being written rather than found later by inspection, so no
periodic sweep is owed.

**Accepted caps.** Each of these truncates something on purpose. They are listed with what the user
actually loses and what would have to be observed before revisiting:

| Cap | What it costs | Revisit when |
| --- | --- | --- |
| Detail-drawer trend windows — **36 months** (category), **60 months** (account) | The drawer's **"All time"** range derives its window from the charted span, so on a scope older than 3 or 5 years "All time" means "the last 36 or 60 months", and the footer count and total reflect only that window. **The label over-promises.** The transaction *list* is not truncated — it pages the fetched window. | Somebody actually reads "All time" as lifetime and is misled. The fix is true-lifetime aggregates at the cost of a full-history scan — a design decision, not a bug fix. |
| Trend-length server caps — **120 months** (monthly-trend), **240 months** (monthly-by-group) | Mostly theoretical: the rolling clause applies only to a *no-scope* trend request, and the Dashboard's own "all time" passes an explicit ancient start date, bypassing it. Only the generic no-date, no-account trend is bounded. | A trend view longer than ten years with no scope is ever surfaced. |
| Money-movement Type preview — **1000 rows** | A source with more than 1000 transactions of one type shows a **preview undercount**. Informational only — the panel does not perform the recategorization — and it passes an explicit limit, so the dev warning correctly exempts it. | It needs one account with 1000+ transactions of a single type. Fix path: paginate, or compute the affected/not-affected split server-side. |
| Trashed-transaction list — **200 rows** | A larger trash is not visible all at once. Still recoverable; trash is transient. | Low stakes throughout. Fix path: paginate, or "load more". |

**Server-side sort is not optional on a paginated list.** A client-side sort cannot reach rows past the
fetch cursor, so reversing the sort on a long list silently sorts the wrong subset. Every scoped list
therefore folds `sort_by`/`sort_dir` into each page.

## Render windowing: the one list left unwindowed

Every long list renders through the shared windowing component **except
`ImportRuleSuggestionReview`**, which is excluded deliberately. It is the hard case with the weakest
payoff, and the exclusion is recorded because the absence otherwise reads as an oversight.

Four obstacles stand in the way, and none is a blocker alone — together they make it a restructure
rather than a drop-in:

- **The list is grouped and heterogeneous.** Top-level items are any of four shapes and range from
  ~80px to 1500px+. A virtualizer tolerates variable heights, but variance this extreme wrecks the
  total-size estimate and reintroduces exactly the scroll jitter windowing exists to prevent.
  *Handling:* window at the **merchant-group** granularity — the stable top-level unit — with a
  per-item size estimate derived from each group's member count rather than one global constant. Bulk
  mode is already flat and could be windowed independently first.
- **It does not own a scroll container; it scrolls with the page.** Every windowed surface so far has a
  dedicated bounded viewport with a sticky header inside it. **This is the structural blocker**: the
  honest prerequisite is giving the page a real bounded scroll region, which changes its scroll model
  and its sticky-panel arithmetic and deserves its own decision. A document-scroller mode in the shared
  component is the alternative and was deliberately not built — new surface area for one consumer.
- **It reads its own rows out of the DOM.** Bulk-anchor scroll restoration finds a card by query
  selector; after windowing the target is usually not mounted. *Handling:* scroll by index against the
  data, not by DOM query — and audit the whole file for other row-reading measurements first, because
  there is likely more than one.
- **Cards mutate height in place**, and that is the *primary* interaction here rather than a rare event.
  Re-measurement copes, but each in-place growth can shift scroll position mid-edit. *Handling:* make
  sure the expand animation does not fight the observer, and either accept the nudge or pin the edited
  card as the scroll anchor.

**If it ever does get slow, reach for memoization first.** Memoizing the card render so a single edit
stops re-rendering every card is the same class of win as the two fixes that actually resolved the
original slowness, and is far less risky than fighting the grouping, the page-level scroll and the
DOM-reading scroll restoration at once.

## Import history: retention

**The lossy global cap is gone.** The completed-history query returned the newest 50 rows overall,
which was a *silent* window: older imports vanished from the interface with no indication, while their
records and transactions stayed in the database. Worse, because the cap was global, an actively-fed
source could push another source's cards out of the window entirely — so that source displayed "0
imported files" while its history was intact underneath. The display query is now unbounded.
Cardinality is one row per imported *file*, not per transaction, which is what makes that tolerable in
the interim.

**The best-effort reconcile pass on the same endpoint stays capped to a recent window**, and that
asymmetry is deliberate: it *writes* on every load, so running it over all history would rewrite every
batch on each call and worsen lock contention.

**The list is windowed per source rather than globally**: an expanded data source shows its recent
cards and files the rest into a reachable by-year archive (`docs/ui-patterns.md` → the recency-window
pattern). That is what bounds the *rendered* history; the fetch is still unbounded behind it.

**The largest thing the history stores is the duplicate reports**, not the cards: one row per refused
row, each holding the raw values, the matched transaction and the payload that would have been inserted.
Measured on a real ledger that was **34 MB of JSON against a 73 MB database** — more than every
transaction put together — and it rides every backup. A maintenance screen (*Free up import space*, served by
`services/import_detail_storage.py`) attributes that space per source and clears it on request, leaving
the cards, their counts, their coverage claims and their file hashes in place. There is deliberately no
retention *policy*: an automatic sweep would be the silent cap again, and the clearing cannot be undone.
See `data-model.md` → *Import batches and profiles*.

**What stopped that growing back is a decision about what to write, not a sweep over what is held.** The
population above was overwhelmingly one thing: a source restating its own prior import, which is what a
re-export with an overlapping window is. On the measured ledger that was **89% of the report's bytes**,
and of those rows only 172 — fewer than one in 150 — were ever flagged as wanting a look. Those refusals are now counted
(`import_batch.ignored_count`) and not recorded (`is_settled_source_restatement`,
`prune_source_restatements`), because there is nothing in such a record to read — the transaction each
one duplicates is in the ledger and *is* the record. The distinction from a retention policy is the
whole of why this is allowed: nothing accumulated is touched, no record is removed after the fact, and
a refusal that asks anything of anyone — a covered date that paired with nothing, a twin two days out,
any claim from a *different* source — still writes its row and keeps its place in the report. Reports
written before this remain, and remain the clearing screen's to remove.

**Re-bounding the fetch is blocked on two things, and the order matters.** Paging that hides rows with
no way to reach them would recreate the lossy cap under a new name, so the archive had to come first —
it has. The second is less obvious and is the larger half: **five consumers of `GET /import-export/batches`
read the whole list as an aggregate rather than as a page of history** — the Rules page's pending
rule-suggestion count, the per-connection suspect rollups on Accounts and the connections panel, and the
data-source manager's lifetime per-profile totals *and its set of known template hashes*, which guards
against re-importing a file already imported. Page the endpoint and each of those silently answers from
the first page; the hash guard becomes wrong rather than merely stale. They need their own aggregate
endpoints before the list response can change shape. See *Open*.

**The rows a file left behind are capped per batch, and the cap is visible rather than silent** — the
distinction the paragraph above turns on. `import_batch_rejected_row` keeps what an import refused
(`MAX_STORED_REJECTED_ROWS`, `import_export/core.py`), which a badly mapped file can make as large as
the file itself: one wrong column choice refuses every row, and nothing about that is worth a permanent
per-row record. What makes a cap acceptable here and not there is that the exact counts survive it — the
report compares the rows it holds against the batch's own totals and says plainly that it is showing a
slice. Which rows survive is chosen by kind, not by position, so the diagnostic ones outlast a deliberate
account skip; see `data-model.md` → *Import batches and profiles*.

## A watched folder is listed often and read rarely

A watched import folder is scanned on every app load past the interval, on every visit to Import /
Export, and whenever someone presses *Check now* — so the listing has to be cheap enough that nobody
ever notices it, while the reading does not have to be.

**`os.scandir` returns each entry's name, size and mtime for about the cost of the syscall**, so listing
a folder with a few hundred files in it is immaterial. The expensive part is reading, hashing and
parsing, and that is what the per-file `(size, mtime)` watermark in `import_watch_file` gates: only an
entry that is new, or has moved since the last pass, is opened at all. A steady folder therefore costs
one directory listing per trigger and nothing else.

**Comparing a file *count* would be cheaper and wrong** — a replacement that keeps the count is missed,
and a file edited in place is exactly the case a monthly re-export produces.

**A file is read into memory whole**, as every import is, so an unattended path that picks its own files
needs its own ceiling: `MAX_WATCHED_FILE_BYTES` parks anything larger rather than reading it. The
interactive import needs no such cap because a person chose the file.

**The nav badge and the Tasks list never scan.** Both read the persisted count in `import_watch_file`,
which is a table read; a badge that stat-ed a network share on every page load would put the whole
interface behind whatever that share was doing. The same reasoning as *The Tasks list is recomputed on
every mutation* below, one step further out — the filesystem is slower and less predictable than the
database, so it is kept off the poll entirely rather than merely made fast.

**Unattended imports make the unwindowed import history worse**, because cards now accumulate with
nobody present to notice. That does not change the cost of any single load — cardinality is still one
row per imported file — but it removes the assumption the interim rests on, that the rate is bounded by
how often someone sits down to import something. See *Import history: retention* above.

## Bulk operations must not accumulate

Export and restore were both written to assemble the whole payload in memory, and both scaled with the
ledger before documents existed to make it acute. The measurement is worth keeping because it is
counter-intuitive:

| Stage | Peak, on a ~18,500-transaction ledger producing a 4.9 MB artifact |
| --- | --- |
| baseline | 80 MB |
| payload assembled as a Python structure | 251 MB |
| serialized to JSON | 315 MB |
| zipped | 354 MB |

**The dominant term is the Python structure — larger than the JSON string and the zip combined.** That
is why "stream the export to a temp file", the obvious reading of the defect, recovers only about a
third of the cost. **Bounded memory requires that rows never accumulate as lists at all**, in either
direction. Pretty-printing was worth dropping but was ~9% of the serialized size, not the problem.

The figures are transient allocation during the operation, not resting footprint. What they cost is an
operation that dies on a small machine — and fixing only the export would have been half an answer,
since **a ledger that can be backed up and not restored has no backup.**

## The Tasks list is recomputed on every mutation

`/tasks` has no cache and no timer. It is fetched on every route change *and* on every successful
mutation anywhere in the app (the `luma:data-mutated` broadcast), so each of its conditions runs at that
cadence. Two of them are not constant-time, and both were accepted on the same reasoning:

- **Amazon reconciliation** reconciles each completed Amazon batch on demand — bounded by the number of
  such batches, which is small in practice.
- **Reimbursement reminders** load the whole outstanding report: every transaction holding money in the
  receivable group, plus roughly four queries per open reimbursement record. The per-record half is
  bounded by how many the user is tracking at once, which is tens rather than thousands.

**A user who does not use the feature pays two queries.** The receivable group is seeded for everyone
but ships empty, so `reimbursable_leaf_ids` returns nothing and the whole computation exits before
touching `txn`. That is what makes the cost proportional to use rather than to ledger size, and it is
the property to preserve if either condition is extended.

The half that does grow with time is the set of transactions holding receivable money, which **includes
the members of completed reimbursements** — those deliberately stay in the group, since the two sides
cancel there. Their portions are fully claimed, so they are excluded before the expensive per-row work,
but they are still scanned. Revisit if a ledger accumulates enough resolved reimbursements for that scan
to show up in a mutation's latency; the fix would be a leaner due-query that never assembles the report.

## Measuring performance

**Re-baseline on a production build with the DevTools Components panel closed.** A development build
amplifies render cost enough to change conclusions — in the trace that started the windowing work the
DevTools hook was ~55% of busy time. The underlying per-node cost was real, but its size in that trace
was not.

**Attribute before optimizing.** The same trace's "closing the report is slow" turned out not to be
unmount cost at all (~160 ms) but two full re-renders of the entire row list, triggered by a drag-handle
state flag living in consumer scope so that every consumer re-rendered on a plain header click. The
windowing was still needed — for initial mount and to make sort, filter and select-all proportional to
the visible rows — but it would not have fixed the symptom that prompted it.

**A virtualizer under a unit runner needs geometry stubbed.** jsdom performs no layout, so a windowed
list renders nothing until the scroll element and rows report sizes. The existing harness stubs the
observer and the size properties keyed off each row's index — keyed, specifically, so that a row never
reports the *viewport's* height, which would make one row appear to fill the screen and silently defeat
every assertion.

---

## Considered and rejected

- **An unbounded default page size.** The default is the safety rail; unbounded is the opt-in. A list
  endpoint with no bound fails worse than one whose `total` reports the real size.
- **A periodic audit for silent truncation.** The development-time warning on a truncated page *is* the
  audit, and it fires while the offending call is being written rather than months later.
- **`content-visibility: auto` on a windowed row.** Redundant — windowing already keeps unmounted rows
  out of layout — and actively harmful, because the intrinsic-size placeholder feeds the virtualizer a
  wrong height. Do not reintroduce it.
- **A hand-rolled windowing hook.** The hard part is scroll anchoring — correcting the viewport when a
  row above it measures taller than its estimate — plus a measurement cache that survives unmount. The
  chosen library was already a dependency and already proven on the first surface.
- **A document-scroller mode in the shared windowing component**, to accommodate the one list that
  scrolls with the page. New surface area for a single consumer; the honest fix is to give that page a
  bounded viewport.
- **Windowing the last list at all, for now.** It is realistically dozens to low hundreds of top-level
  groups — the surface least likely to stall — against four obstacles, one of them structural.
- **Chunked commits during a restore.** No memory argument (an open SQLite write transaction spills to
  the WAL, which is disk), and it forfeits the all-or-nothing property that makes a failed restore leave
  the target untouched. Also in `operations.md`.
- **Date-windowed backups as a basis for incremental backup.** There is no change tracking: `txn` has no
  `updated_at`, so a "past year" backup slices by *transaction date*, not by when a row changed. A 2019
  charge recategorized this morning is absent from it, so full-plus-incremental restores the stale
  categorization — and an additive incremental cannot express a deletion at all. Date-windowed is a
  useful *slice* for export or sharing and is not disaster recovery.
- **Dependency-based query-cache invalidation**, replacing the hand-wired refresh map. Parked rather
  than rejected, but recorded here because it looks like an obvious win: the existing write seam already
  removed the real pain (a caller forgetting to announce a mutation is now impossible, enforced by lint),
  and what remains is only the cost of hand-maintaining a small set. Swapping it in is a real
  architectural shift — a new dependency and every data-loading screen migrated onto it.

## Obstacles

- **True incremental backup needs `updated_at` on every table plus delete tombstones**, with every write
  site maintaining them — a schema change with a permanent maintenance burden. The decomposition that
  avoids it: the **ledger** is mutable anywhere in history but small once zipped, so it is always sent
  in full; **documents** are immutable once written but grow forever, so only they need a delta, and
  "which files does the target lack" is answerable by id alone with no change tracking. Both
  prerequisites — id-addressed members and a digest per document — already exist.
- **Restoring a chain is unsolved even so.** The compatibility guard's checks would have to apply across
  files, and restore is wipe-and-rebuild with **no merge mode** — "restore on top" today means restoring
  into a non-empty database, which still replaces it.
- **Re-bounding a list before its archive exists recreates the lossy cap.** This is the general shape,
  not just the import-history case: a bound is only safe once what falls outside it is reachable.
- **A windowed list cannot be fed by anything that reads rows from the DOM.** Only mounted rows exist,
  so any selection, copy, or scroll-restoration path built on DOM queries breaks silently — it keeps
  working on short lists.
- **Sharing one column-preference key across different column sets silently merges them**, because
  unknown keys are dropped and defaults appended. Each windowed report needs its own key; one dialog
  keys per tab for the same reason.
- **A `'loaded'` select-all strategy assumes every row is in memory**, which windowing breaks. Verify it
  wherever it is still used.
- **The browser is the last hop that still holds a whole backup, and documents are what make it matter.**
  Both server directions stream, but `downloadUrl` (`lib/api.js`) fetches the artifact into a Blob before
  saving, so the client holds all of it. That is irrelevant for a ledger-only backup — 4.9 MB at ~18,500
  transactions, roughly 50 MB extrapolated to 200k — and binds only once documents dominate the size.
  Browsers page large blobs to disk, so the curve is sluggish before it is fatal; a tab dying while saving
  a backup is *broken* rather than merely slow. **The blob is deliberate and "just navigate instead" is
  not the fix**: a plain navigation hands the response to the browser, so an error status renders as raw
  JSON with the app gone from under it, which is why the fetch-and-save exists at all. The way out is to
  *preflight* what the endpoint can fail on (no enabled recipients being the main one) and then navigate,
  letting the browser stream to disk with its own progress UI — or to pipe the body through the File
  System Access API, which is better and Chromium-only. Until one of those lands, the `Content-Length`
  the export sends buys nothing visible: saving a finished blob gives the browser no download to draw a
  progress bar for.

## Open

- **Re-bounding the import-history fetch**, now that the archive exists — which means moving the five
  aggregate consumers above off the whole-list payload first.
  → [`backlog/import-history-windowing.md`](backlog/import-history-windowing.md)
- **Whether the document delta is worth building**, now that both its prerequisites exist. The ledger
  half needs nothing; the open part is restoring a chain.
  → [`backlog/backup-restore-scope-and-secrets.md`](backlog/backup-restore-scope-and-secrets.md)
- **Dependency-based cache invalidation**, if transaction-derived views ever proliferate enough that the
  hand-maintained refresh set hurts. → [`backlog/query-cache-invalidation.md`](backlog/query-cache-invalidation.md)
- **A structural database check does not answer whether the data is *coherent*** — a cursor ahead of a
  restored ledger, a coverage claim disagreeing with its rows, a mapping pointing at a merged account all
  read as `ok`. What a semantic checker should assert is unstarted design.
  → [`backlog/database-diagnostics.md`](backlog/database-diagnostics.md)
