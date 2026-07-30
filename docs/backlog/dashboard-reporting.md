# Dashboard / reporting — follow-ups

**Status: deferred, not started (migrated from `TODO.md` 2026-07-30).** Two unrelated
dashboard items: a new cash-flow visualization, and a latent double-count audit that the
Trends tab needs before it gains a tag-report selector.

## Cash-flow Sankey diagram

**Context.** "Cash flow" is conceptually distinct from spending or income
— it's about how money moves through accounts and categories, not just
totals. Best visualized as a Sankey diagram (income sources on the left,
expense buckets on the right). We deliberately *removed* `cash_flow` from
the dashboard's Expenses/Income toggle to avoid conflating it with the
spending/income reports.

**Why deferred.** Sankey is its own visualization with its own data shape
(weighted edges between source and sink nodes). Wants its own dashboard
mode or page.

**Suggested approach when picked up.**

- Likely a new top-level dashboard mode alongside Single/Compare/Trends,
  or a sibling of the Dashboard accessible from the nav.
- Backend: a new summary endpoint that returns weighted edges (income
  category → bucket-of-spending, perhaps grouped by tag or by category) for
  a period.
- Frontend: use a Sankey library or render directly with d3-sankey. Click
  on a flow to drill into the transactions on that path.

## Trends-tab semantics audit when the tag-report selector lands there

**Context.** The Trends tab's "Total per month" and "Annual totals" bar
charts aggregate across all series returned by `/summary/monthly-by-group`.
We filter income/expense in the per-series rendering, but the per-month
and per-year totals are sums of `r.total` across all rows — which can
double-count or produce misleading magnitudes depending on which series
mix is present.

**Why deferred.** The Trends tab today has no tag-report selector — adding
one is what would expose this latent issue. We patched the analogous
problem on Single mode during Phase 1 (filter to expense series before
summing); the same fix shape applies to Trends mode but needs to be
revisited in the context of whatever filter UI Trends mode gets.

**Suggested approach when picked up.**

- Introduce the same Expenses/Income toggle (and eventually the tag-report
  picker) on Trends mode.
- Derive an `expenseSeriesIds` (or active-selection equivalent) and have
  `monthlyTotal` and `annualData` filter against it before summing.
- Possibly add an `Avg` reference line to `Annual totals` (already done
  for `Total per month` and `Monthly spending by group`).
