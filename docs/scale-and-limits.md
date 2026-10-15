# Scale, limits and behavior at volume

Which caps exist on purpose, what each costs, and when to revisit it. A personal ledger accumulates for
years, so the question about any cost is what it is proportional to.

The mechanism behind each bound is owned elsewhere:

| Bound | Owned by |
| --- | --- |
| Database concurrency, and why a write transaction contains only its own work | `architecture.md` → *Database concurrency* |
| Provider request budgets, pacing and pausing | `building-a-connector.md` → *Request budgets and pausing* |
| Backup/restore streaming and the NDJSON layout | `data-model.md` → *Backups* |
| The list `limit` contract | `data-model.md` → *Totals come from the server* |
| Windowing and paging rules for a list | `ui-patterns.md` → *Tables and lists* |

## Contents

- [Three independent bounds, and the rule they share](#three-independent-bounds-and-the-rule-they-share)
- [Fetch limits, and the caps that remain on purpose](#fetch-limits-and-the-caps-that-remain-on-purpose)
- [Render windowing: the one list left unwindowed](#render-windowing-the-one-list-left-unwindowed)
- [Import history: retention](#import-history-retention)
- [A watched folder is listed often and read rarely](#a-watched-folder-is-listed-often-and-read-rarely)
- [Bulk operations must not accumulate](#bulk-operations-must-not-accumulate)
- [The Tasks list is recomputed on every mutation](#the-tasks-list-is-recomputed-on-every-mutation)
- [Many sessions on one server](#many-sessions-on-one-server)
- [Measuring performance](#measuring-performance)
- [Obstacles](#obstacles)
- [Open](#open)

---

## Three independent bounds, and the rule they share

A dataset can overwhelm the app in three places, and bounding one does nothing for the others:

- **The fetch**: how many rows leave the database. Bounded by pagination with server-side sort.
- **The DOM**: how many rows become real nodes. Bounded by render windowing.
- **Working memory**: how much a bulk operation holds at once. Bounded by streaming.

> **Nothing may accumulate a whole dataset**: not as a SQL result, not as DOM nodes, not as a Python
> list, and not as a stored per-row record that grows with the ledger.

## Fetch limits, and the caps that remain on purpose

`/transactions` returns a bounded default page because `txn` has no inherent size bound; `limit=0` is
the explicit opt-in for a scope known to be small. `getTransactions` (`lib/api.js`) warns in development
when a call that omitted `limit` comes back truncated, so no periodic audit of callers is owed.

Each cap below truncates something on purpose.

| Cap | What it costs | Revisit when |
| --- | --- | --- |
| Category detail drawer: the trend window `CategoryDetail` requests | With no date filter from the page, the drawer's *All time* range is that many months ending at the category's latest activity, and its footer count and total cover only that window. The transaction list pages the same window. | Someone reads *All time* as lifetime and is misled. Lifetime aggregates cost a full-history scan. |
| The `months` ceiling on `monthly-by-group` | The endpoint always applies its rolling window, so the Trends view reaches back no further than the ceiling. | A ledger outgrows the ceiling. |
| The `months` ceiling on `monthly-trend` and `monthly-cash-flow` | It bounds only the rolling window, which applies when a request has no dates. An explicit date range bypasses it, and `monthly-trend` also skips it for an account or payee scope. | A view needs an undated trend longer than the ceiling. |
| Money-movement Type preview: the limit `MoneyMovementTypeReportPanel` passes | An account with more rows of one type than the limit shows an undercount in the preview. The preview does not perform the recategorization. | It is reported. Paginate, or compute the affected and not-affected split on the server. |
| Trash: the default `limit` of `list_trashed_transactions`, per section | A larger section lists only its most recently trashed rows. The heading states the whole count and the list says it is partial. | Low stakes. Paginate or add "load more". |

## Render windowing: the one list left unwindowed

The transaction lists, the Rules page and the match reports render through `WindowedRows`. The lists
that do not are capped or small, except `ImportRuleSuggestionReview`. Windowing it is a restructure and
not a drop-in, for four reasons:

- its items are grouped and heterogeneous, and range from about 80px to over 1500px
- it scrolls with the page and has no bounded viewport of its own, which is the structural blocker
- it reads its own rows out of the DOM to restore scroll position
- its cards change height in place as their primary interaction

If the list gets slow, memoize the card render first, so that one edit stops re-rendering every card.

## Import history: retention

- **The history fetch is unbounded** (`list_batches`). That is tolerable because cardinality is one row
  per imported file, not per transaction.
- **The rendered history is bounded per source**: an expanded data source shows its recent cards and
  files the rest into a by-year archive (`lib/importExport/importHistoryWindow.js`). The window is per
  source because a global one lets an actively fed source push a quiet one's cards out of view.
- **The reconcile pass on the same endpoint is capped to recent batches**, because it writes on every
  load and running it over all history would rewrite every batch on each call.
- **Duplicate reports are the largest thing the history stores.** Two things hold them down. A source
  restating its own earlier import is counted and not recorded (`data-model.md` → *What a batch
  counts*). And Settings → *Import storage* clears a card's stored detail on request (`data-model.md` →
  *Clearing a card's stored detail*).
- **Nothing sweeps stored detail on a schedule.** The clearing cannot be undone, so it is always a
  selection someone made on that screen.
- **Rejected rows are capped per batch** (`MAX_STORED_REJECTED_ROWS`), since one wrong column choice
  refuses every row of a file. The cap is safe because the exact counts survive it and the report says
  it is showing a slice (`data-model.md` → *Rejected rows*).

Revisit the unbounded fetch when watched folders are in real use: unattended imports add cards at a
rate no longer limited by how often someone sits down to import.

## A watched folder is listed often and read rarely

A scan lists the folder and opens only the entries whose `(size, mtime)` moved; the mechanism is in
`architecture.md` → *Watched import folders*. Two bounds belong here:

- **The nav badge and the Tasks list never touch the filesystem.** Both read the persisted count in
  `import_watch_file`, because a network share is slower and less predictable than the database and
  these are read on every page load.
- **An unattended import has a file-size ceiling** (`MAX_WATCHED_FILE_BYTES`). A file is read into
  memory whole, and here nobody chose it; a larger file is parked.

## Bulk operations must not accumulate

Backup export and restore stream in both directions, and neither holds rows as a list. The Python
structure is the dominant memory term, larger than the serialized JSON and the zip together, so
streaming only the output to a file recovers about a third of the peak. The cost of getting it wrong is
an operation that dies on a small machine.

## The Tasks list is recomputed on every mutation

`/tasks` has no timer. It is fetched on every route change and on every successful mutation anywhere in
the app (the `luma:data-mutated` broadcast), so each of its conditions runs at that cadence. Two do
work that is not constant-time:

- **Amazon reconciliation** runs a whole report per completed Amazon batch. Its count is cached against
  `recon_epoch` (`services/reconciliation_attention.py`), so the report reruns only after a write to a
  table it reads.
- **Reimbursement reminders** load the whole outstanding report: every transaction holding money in the
  receivable group, and every open reimbursement record, read in a fixed number of queries.

Someone who does not use reimbursements pays a few small lookups, because the receivable group ships
empty and `outstanding` returns before touching `txn`. Keep that property when extending either condition: the
cost should follow use, not ledger size.

The transactions holding receivable money include the members of completed reimbursements, which stay
in the group. They are excluded before the per-row work but are still scanned. Revisit if that scan
shows up in a mutation's latency; the fix is a due-query that never assembles the report.

## Many sessions on one server

When many sessions use one Luma server at the same time, pages can load slowly or stop loading
altogether, even though the computer is mostly idle and the database answers quickly. One person using
the app does not see this. The browser tests did, because they run many browser sessions against one
server at once: with ten, the transaction list took 10 to 16 seconds to load instead of a fraction of a
second, and tests failed waiting for it.

### Why it happens

The server is a single Python program, and Python runs only one piece of Python code at a time. However
many requests arrive together, they take turns. The lock that enforces the turns is called the GIL
(Global Interpreter Lock).

SQLite is not bound by that lock, so the database itself does work in parallel. But each time Python
hands a query to SQLite, and each time it takes the next row of the answer, it gives up its turn and has
to wait for it again before carrying on. A request that reads many rows waits many times. When nothing
else is busy, getting the turn back is instant. When other requests are busy running Python, each wait
can take several milliseconds, and those add up row by row.

Measured on the demo ledger, reading 200 rows took:

| Other requests busy at the same time | Time to read the rows |
| --- | --- |
| none | 4 ms |
| one | 144 ms |
| two | 1.3 s |

With one person, a page asks for about 27 things at once and the effect is small: the transaction list
takes about 150 ms instead of 63 ms on a ledger of 20,000 transactions. It grows quickly with the number
of sessions, which is why ten browser sessions turned it into seconds.

A different database would not remove it. The waiting happens in Python, not in SQLite, and SQLite
suits a program that runs on a single machine with its data in one file.

### What made it worse, and was fixed

Investigating the stalled tests turned up three problems, each fixed:

- **An edit held the database's write lock while it rescanned recurring charges.** SQLite allows one
  writer at a time, so every other change waited behind the rescan. The edit is now saved first, and the
  rescan runs after it (`data-model.md` → *When a scan runs*).
- **Pages that only read data held the write lock while they loaded.** Saving a cached count, or tidying
  an import card, took the lock, and the page kept it until it had finished reading everything else. Those
  writes now happen only when something actually changed, and let go of the lock straight away.
- **The reimbursement reminders on Tasks ran a few queries for every reimbursement.** On a ledger with
  441 reimbursable transactions that was 1,779 queries every time Tasks was checked, which happens on
  every page change and after every edit. It now takes 25, however many there are.

The rules for writing code that avoids these are in `architecture.md` → *Database concurrency*.

### What guards against it now

- **The browser tests run three sessions at a time** (`frontend/playwright.config.js`). Past about three,
  requests slow each other down enough to make tests fail for reasons unrelated to the change being
  tested. Three take about the same overall time as ten, because the extra sessions only waited on each
  other.
- **The requests every page makes may not issue more queries as the ledger grows**
  (`backend/tests/test_query_budget.py`). Each is run against a small ledger and one ten times larger,
  and both must take the same number of queries. This is the check that would have caught the
  reimbursement reminders.
- **A page that only reads may not keep the write lock** (`backend/tests/test_read_path_write_lock.py`).
- **`npm run ui:stress` runs the browser tests with ten sessions** and reports how the server held up.
  It is a measurement, not a pass or fail check, and some tests are expected to fail along the way. Run
  it before a release and after changing anything every page asks for, Tasks above all, or how the
  server uses the database. The whole run is kept in `data/stress-logs/`.

### Reading the stress report

The figures from a run on 2026-10-15, on a machine with 20 cores, after the fixes above:

| Report line | Figure | What it says |
| --- | --- | --- |
| Specs failed | 2, and 22 did not run | Ten sessions are past what the tests can absorb. A run with none failing is good news, not the expected result. |
| `database is locked` errors | 0 | A write waited the full 15 seconds for the lock. Anything above zero means something holds the lock too long again. |
| Longest single write | 2.9 s | Mostly time spent waiting for the lock. Before the fixes this reached 14 to 15 seconds. |
| Requests over a second | 168, 543 s in total | The overall amount of waiting. Before the fixes, 608 to 815 seconds. |
| Slowest request | `GET /api/transactions`, 13 s | The transaction list suffers most, because it reads the most rows. |
| Slowest connections | about 13 s, nearly all in database calls | Time in database calls includes each row's wait for Python's turn, so a long one is either slow SQL or a queue behind other requests. Timing the same request on its own tells which. |

Runs vary a lot from one to the next, by several hundred seconds of waiting, so compare a couple of runs
rather than one. A figure far worse than these, or `database is locked` appearing at all, is worth
investigating.

### Finding out what is slow

The report says which requests were slow, not why. A profiler shows where the time goes inside the
server. With `TRACE_DB_CONTENTION` set, as `ui:stress` sets it, the server allows a profiler from
another window to attach to it:

1. Start `npm run ui:stress`.
2. Once the tests are running, find the server's process: `ss -ltnp | grep :8099`.
3. Record it with py-spy (`pip install py-spy` into any Python environment):
   `py-spy record --pid <pid> --idle --threads --nonblocking --format raw --duration 55 -o profile.txt`.
   `--idle` includes requests that are waiting; `--gil` instead of `--idle` shows only what was running
   Python at each moment, which is what the waiting requests were waiting for.
4. Each line of `profile.txt` is one call stack and how often it was seen; group them by the endpoint in
   each stack to see which requests take the time.

At the time of writing the profile shows the Tasks check as the largest single user of Python's turn,
about 40%, mostly the recurring charge findings and the rule amount checks. Both are recomputed on every
check. Keeping their results until the data changes was considered, but every edit changes the data and
is followed by a check, so it would save little where it matters.

## Measuring performance

Take a baseline on a production build with the React DevTools Components panel closed. A development
build and the DevTools hook each inflate render cost enough to change which cost looks largest.

---

## Obstacles

- **True incremental backup needs `updated_at` on every table plus delete tombstones**, with every write
  site maintaining them. The decomposition that avoids it: the ledger is mutable anywhere in history but
  small once zipped, so it is always sent in full; documents are immutable once written but grow
  forever, so only they need a delta, and "which files does the target lack" is answerable by id alone.
  Both prerequisites, id-addressed members and a digest per document, exist.
- **Restoring a chain is unsolved.** The compatibility guard's checks would have to apply across files,
  and restore is wipe-and-rebuild with no merge mode.
- **A bound is safe only once what falls outside it is reachable.** Paging a list before its archive
  exists hides rows with no way back to them.
- **Paging `GET /import-export/batches` breaks the callers that read it as an aggregate over all
  history.** Each would answer from the first page: the Rules page's pending rule-suggestion count, the
  Connections tab's per-connection rollup, the import-storage dialog's per-source attribution, the
  rule-suggestions page's lookup of a batch and its source's other batches, and the data-source
  manager's per-source totals and known template hashes. The hash set guards against re-importing a
  file, so it would become wrong and not merely stale. Each needs its own endpoint first.
- **The browser holds a whole backup while saving it.** `downloadUrl` (`lib/api.js`) fetches into a Blob
  so that an error stays in the app. That is irrelevant for a ledger-only backup and binds once
  documents dominate the size. The way out is to preflight what the endpoint can fail on and then
  navigate, letting the browser stream to disk, or to pipe the body through the File System Access API,
  which is Chromium-only.

## Open

- **Re-bounding the import-history fetch**, which means moving the aggregate consumers above off the
  whole-list payload first.
  → [`backlog/import-history-windowing.md`](backlog/import-history-windowing.md)
- **Whether the document delta is worth building.** The ledger half needs nothing; the open part is
  restoring a chain.
  → [`backlog/backup-restore-scope-and-secrets.md`](backlog/backup-restore-scope-and-secrets.md)
- **Dependency-based cache invalidation**, if transaction-derived views proliferate enough that the
  hand-maintained refresh set hurts. → [`backlog/query-cache-invalidation.md`](backlog/query-cache-invalidation.md)
- **A structural database check does not answer whether the data is coherent**: a cursor ahead of a
  restored ledger, a coverage claim disagreeing with its rows and a mapping pointing at a merged account
  all read as `ok`. What a semantic checker should assert is unstarted design.
  → [`backlog/database-diagnostics.md`](backlog/database-diagnostics.md)
