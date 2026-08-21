# Transaction splits (categorize one purchase across several categories)

**Status: backlog, not started (2026-07-23).** Came out of Amazon orders, but is deliberately a **general**
feature. Today a transaction carries exactly one category, so a single purchase that spans categories — a
Costco run that's part groceries / part electronics, or an Amazon order with a battery charger *and* a
network switch — can only land in one bucket. This item adds the ability to **split a transaction's amount
across multiple categories**, on *any* transaction, with Amazon orders able to **pre-fill** the split from
their captured per-item detail.

## Why not a lighter shortcut

Tags don't solve it: a tag is cross-cutting metadata, it doesn't divide the **amount**, so tagging an order
"electronics" wouldn't move any dollars into an electronics total. The requirement is fundamentally to
allocate the amount across categories, so some form of amount-split is unavoidable.

## The core model — split-allocation table (recommended)

Keep the transaction as **one row** and attach a set of allocations that sum to its amount:

```
txn_split(id, txn_id, category_id, amount, sort_order)
```

- The transaction's own `category_id` becomes a **split marker** (a sentinel, or a `is_split` flag) so the
  ledger renders it as "Split (N)" and expands to the parts; the parts carry the real categories/amounts.
- Allocations must **sum to the transaction amount** (enforced in the app on save, not by the DB), and share
  its sign (Amazon net cash is positive = spending; a refund/credit split would be all-negative).
- A split is a **manual override** in spirit: like a hand-set category, it is protected from automatic rule
  reruns (`category_overridden = 1` equivalent), and only an explicit re-split changes it.

**Why this over child transactions.** The alternative — turn the order into a parent excluded from totals
with N child rows — resurrects exactly the **per-item-rows model that was already abandoned** for Amazon
(orders-only, 2026-07-10; see `data-model.md` → "Transaction links and Amazon order import"), and it adds a
visible parent/child hierarchy, a double-count risk, and tree-handling in editing/undo/import. The
allocation table keeps the ledger one clean row per purchase and confines the complexity to reporting.

### The load-bearing cost: reporting must expand splits

Every category rollup currently reads `txn.category_id + txn.amount`. With splits, a split transaction must
contribute **one row per allocation** instead. Do this once, via an **"effective category rows"** seam (a
SQL view / CTE) that yields `(txn_id, category_id, amount)` — a non-split row maps to itself; a split row
maps to its allocations — and route **all** summary queries through it:
`/summary/by-group`, `/summary/by-category`, `/summary/monthly-trend`, `/summary/monthly-by-group`, plus any
other category aggregation (dashboard, reconciliation tallies). `exclude_from_totals` still applies
per-allocation-category (`COALESCE(parent, leaf)`), and the "an expense branch may hold credits" sign rule
is preserved per allocation. This is the main build cost — a contained but cross-cutting reporting change.

## Amazon pre-fill (the motivating convenience)

An Amazon order already stores its items in `import_evidence` (`AmazonItem`: description, **list price**,
quantity, ASIN). The catch — and the reason a naïve "one part per item at its price" is wrong — is that the
item figure is a **list price** (`amazon_import.py`: "reference detail only … never a ledger amount"),
while the transaction amount is **net cash** (`total − refund`, which folds in tax, shipping, and any
discount/promo). List prices generally **don't sum to what was paid**.

So the pre-fill **reallocates the actual net cash across the items in proportion to each item's list-price
contribution**:

```
allocation_i = round(net_cash × list_i / Σ list_j, 2)
```

with the rounding remainder assigned to the largest part so the allocations sum to the amount **exactly**.
This distributes tax/shipping/discount proportionally — a reasonable default the user can then adjust. The
pre-fill is a *starting suggestion* on the split UI, not automatic; the user confirms/edits. (The item
categories are **not** taken from Amazon's taxonomy — that's deliberately unused; the user picks categories,
possibly aided by their normal rules per item name.)

## Surfaces / where it lives

- **New:** `txn_split` table (rides in backups, v8 payload); the "effective category rows" view/CTE; the
  split editor on `TransactionDetail` (add/remove parts, per-part category + amount, live remainder that must
  reach 0); the ledger's "Split (N)" affordance.
- **Reporting:** `routers/transactions.py` summary endpoints + any category aggregation → route through the
  effective-rows seam.
- **Amazon pre-fill:** a helper that reads the order's item evidence and produces the proportional
  allocation; offered from the split editor when the transaction is an Amazon order with item detail.
- **Reuse:** the `exclude_from_totals` mechanism (per-allocation), `category_overridden` protection semantics
  (a split resists rule reruns), the shared `CategoryPicker`, `TransactionDetail`.

## A second consumer: reimbursable expenses

[`reimbursable-expenses.md`](reimbursable-expenses.md) depends on this allocation table for its
motivating case — part of an expense is reimbursable (three tickets for friends, one for me) and part is
not. It is a second, independent consumer of the same mechanism, which is worth knowing when weighing
whether the reporting-expansion cost is justified: it is not paid for by Amazon pre-fill alone.

Nothing in that design asks anything extra of splits. It needs one allocation part to land in a holding
category and the rest in ordinary ones, which is the base capability.

## Open questions

- **Split marker vs. NULL+flag** for the parent transaction's own category, and how the ledger/filter/search
  treat a split row (does it match a category filter for any of its parts?).
- **Rules & splits:** a split is manual-override-like (rules don't touch it), but should a *rule* ever be
  able to author a split? (Probably not initially.)
- **Tags on a split** — apply to the whole transaction (all parts) or per-part? Whole-transaction is simpler.
- **Items with no list price** (`price = None`) in the Amazon pre-fill — exclude from weighting, split the
  remainder equally, or leave for manual? And non-cash/points orders (amount 0) — split N/A.
- **Undo/import interaction:** undoing an Amazon batch must drop splits on its order rows; a re-import replace
  likewise. Splits are per-transaction, so this is mostly "cascade on the txn."
- **Bulk edit / recategorize** must skip split rows (they're overrides), same as manual categories.
