# Display formatting — the number and date half

**Deferred; the currency half shipped 2026-08-08.** Tier 1 is *formatting* — currency symbol,
decimal/thousands separators, date order — and explicitly **not** language translation. The shipped
currency setting and the reasoning behind where it lives are in [`../data-model.md`](../data-model.md)
→ *One ledger currency* (why it is shared state and not a per-user preference is under *Preferences*),
with the adapter contract in [`../building-a-connector.md`](../building-a-connector.md) → *Currency*.

What remains splits into two buckets that must stay distinct, because only one of them can be wrong
about a number.

## Bucket A — display formatting (cosmetic; no correctness risk)

- **Move from a symbol swap to `Intl.NumberFormat(locale, { style: 'currency', currency })`.** Only the
  *symbol* is derived from `Intl` today (`currencyDisplay: 'narrowSymbol'`, so an AUD ledger reads
  `$12.00` rather than `A$12.00`); the `en-US` grouping formatter underneath is untouched. The wholesale
  switch is the right end state — it is what gets separators and symbol *placement* right (`1.234,56 €`)
  — but it changes every rendered amount at once, which is why it was deliberately not ridden in on a
  setting that only had to answer "which currency is this ledger in". The four money helpers
  (`formatMoneyMagnitude`, `formatSignedMoneyAmount`, `formatTransactionAmount`, `formatSignedAxisTick`)
  already funnel ~48 call sites, so the change concentrates there. The hand-rolled `k`-abbreviation in
  `formatSignedAxisTick` is the one spot that stays locale-naive and needs its own answer.
- **A date-format preference**, threaded into `formatDate` / `monthLabel` in `lib/utils.js`.
- **Sweep the renders the central helpers do not reach.** A grep for `formatDate` misses roughly nine
  spots that render a raw ISO `{x.date}` directly, clustered in the duplicate and import surfaces
  (`UnifiedDuplicatesDialog`, `ImportBatchDetail`, `TransactionDetail`, plus
  `Settings` / `Transactions` / `ImportExport`). Without this the app keeps showing ISO after the user
  picks a format — the shape of bug where "I set my format and half the app ignored it".

## Bucket B — parsing human free-text input (the only correctness risk)

The **Transactions quick filter** resolves **server-side** (`_parse_quick_filter_date`,
`_parse_quick_filter_year_month`, `_parse_quick_filter_amount` in `routers/transactions.py`), which is
the one place this work is not purely frontend: the chosen format has to reach the backend, either
alongside `quick_filter` or by the backend reading the same stored preference.

- **Date order is ambiguous and currently silently US.** The parser tries `%m/%d/%Y` *first*, so
  `02/01/2023` reads as Feb 1 for a user who meant 1 Feb. A format-string swap is not enough — the
  *parse order* (MDY / DMY / YMD) has to follow the chosen format, with ISO `%Y-%m-%d` always accepted
  as the unambiguous fallback in every format. That rule needs stating in the UI, not just implementing.
- **The document search writes its numeric forms month-first too.** A typed date is searched inside
  attachments in the forms a receipt might print it (`_fts_date_phrases`), and the numeric ones are
  generated in one order. The assumption to build on is that a receipt prints its date in the app's
  chosen format, so the generated order follows the preference. A possible refinement is reading the
  order off the receipt's own text: `6/7/26` is ambiguous, but `31/7/26` can only be day-first.
- **Separator roles flip.** `_parse_quick_filter_amount` strips `,` as thousands and reads `.` as
  decimal; both invert in a `1.234,56` locale, so the same input yields a different number rather than
  an error.
- **CSV amount parsing carries the same hazard, and the currency setting does not touch it.**
  `import_export/core.py` and `amazon_import.py` both strip `$` and `,` unconditionally before parsing,
  so a `1.234,56` amount imports as `1.234` — silently, at a hundredth of the real figure. The setting
  says what the numbers *mean*, not how a file writes them. Whether the fix is a locale-aware parser or
  a per-source amount-format option (alongside the existing amount-convention choice, which is where a
  user already answers a question of this shape) is undecided.

## Verified not a hazard — so it does not get over-engineered

- **The duplicate report's date drill-through** looks like a date filter and is not one:
  `UnifiedDuplicatesDialog` passes a row's *stored ISO* date through `ImportBatchDetail` to the backend's
  `date_start` / `date_end`. Machine-to-machine ISO throughout, no human-format parsing. Its only tier-1
  touch is the ISO it *displays*, which is Bucket A.
- **The FilterBar date range** is a picker whose stored value is ISO — locale-independent.
- **Import column date parsing** is a separate system that already infers format, and is not part of
  this.

## Out of scope, recorded so the boundary stays clear

- **Tier 2 — multi-currency** (a currency per account, mixed in one ledger). A data-model change plus
  the real problem: every summary, dashboard and trend `SUM`s amounts, and USD + EUR has no meaningful
  sum — so it needs either a one-currency-per-report rule or FX conversion with rates, as-of dates and a
  rate source. Do not fold it into tier 1.
- **Tier 3 — language translation** (every UI string, plus ongoing upkeep). Fully separable.

## Order when picked up

Preferences and their Settings controls first; then Bucket A, which is cosmetic and low-risk; then
Bucket B, with tests for the ambiguous `01/02` date and the `1.234,56` amount. Renaming the **Currency**
settings section to a broader name belongs with the date-format control landing, not before it.
