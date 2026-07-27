# Transaction-list fetch limits (remaining)

**Status: surveyed, mostly resolved (2026-07-27).** The transaction-list caps that silently truncated a
rendered list have been fixed by routing every scoped list through the shared paginated + server-sorted
loader. This file records the caps that **remain on purpose** (accepted tradeoffs) and the few that are
**deferred fix candidates**, so a future pass knows these were looked at deliberately, not missed.

## What was resolved (context)

- **`usePagedTransactions` gained server-side sort** (`sort_by`/`sort_dir` folded into each page) plus
  first-page `total`/`sumAmount` aggregates. Server-side sort is mandatory for an infinite-scroll list:
  a client-side sort can't reach rows past the fetch cursor on a reversed sort. See `ui-patterns.md`
  ("Every scoped transaction list is paginated with server-side sort").
- **Converted from one-shot capped fetches to pagination:** `PeriodDetail` (the generalized single-month
  `MonthDetail`, whose `limit: 1000` dropped the oldest rows once a year exceeded 1000 — the bug that
  kicked this off), `TagDetail` (also upgraded its bulk select-all from `'loaded'` to server `'filter'`),
  both **Dashboard single-period drill tables** (were `limit: 500` group / `limit: 200` category), and the
  **Recurring series drill-down** member list (was `limit: 500`, disagreeing with the card's
  `occurrence_count`). `CategoryDetail`/`AccountDetail`/`TransactionDetail`/`ImportBatchDetail` already
  paginated and were wired to controlled server sort for parity.
- **`limit=0` = "no limit"** opt-in on `/transactions` (SQLite `LIMIT -1`), for *known-bounded* scopes
  only — applied to the recurring *removed-rows* list. Plus a **dev-mode warning** in
  `api.getTransactions` when a caller that omitted `limit` gets a truncated page. See `data-model.md`
  ("The list `limit` contract").

## Remaining — accepted tradeoffs (not planned to fix)

- **Detail-drawer trend windows: `CategoryDetail` = 36 months, `AccountDetail` = 60 months.** Deliberate
  (keeps the drawer trend bounded rather than scanning full history). Consequence: the drawer's **"All
  time" range control** derives its window from the charted trend span, so for a category/account older
  than 3/5 years "All time" really means "the last 36/60 months," and its footer count/total (summed from
  the trend rows) reflect only that window — the label over-promises. The transaction *list* itself is not
  truncated (it pages the fetched window). Already noted in `ui-patterns.md` (DetailRangeControl bullet).
  A real fix would offer true-lifetime totals at the cost of a full-history scan/aggregate — a design
  decision, not a bug. **Revisit only if a user actually reads "All time" as lifetime and is misled.**
- **Trend-length server caps: monthly-trend `months le=120` (10y), monthly-by-group `le=240` (20y).**
  These back the windows above and are mostly theoretical: the rolling-`months` clause only applies to a
  no-scope trend request; the Dashboard's own "all time" trend passes an explicit ancient `date_start`, so
  it bypasses the cap and returns full history. Only the generic no-date/no-account trend is bounded to
  the last 10 years. Leave as-is unless a >10-year no-scope trend view is ever surfaced.

## Remaining — deferred fix candidates (low priority)

- **`MoneyMovementTypeReportPanel` — `limit: 1000`.** The PayPal import review panel fetches all rows on a
  source carrying one `import_evidence_type` and splits them client-side (affected / not-affected). A
  source with >1000 transactions of a single Type shows a **preview undercount** — informational only (the
  panel doesn't perform the recategorization), and it passes an *explicit* limit (a conscious cap, so the
  dev warning exempts it). Fix path if it ever matters: paginate, or compute the affected/not-affected
  split server-side. Rare (needs one account with 1000+ txns of the same Type).
- **`list_trashed_transactions` — default `limit: 200` (le=1000).** The Settings → Trash view shows the
  newest 200 trashed rows; a larger trash isn't fully visible at once (still recoverable). Low stakes —
  trash is transient. Fix path: paginate the trash list, or a "load more".
- **General: any `getTransactions` call that omits `limit`** gets the backend default of 200. This is now
  **loud in dev** (the `api.getTransactions` warning fires on truncation), so a future silent-truncation
  regression is caught during development rather than shipped. No standing audit needed — the guard is the
  audit.

## Deliberately NOT changed

- The **200-row default page** stays as a safety rail. `txn` has no inherent size bound (years of imports
  → 100k+ rows), so an unbounded *default* would be a worse failure (memory/perf blowup) than a bounded
  page whose `total` tells the caller the real size. Unbounded is only ever the explicit `limit=0`
  opt-in, for scopes the caller knows are small.
