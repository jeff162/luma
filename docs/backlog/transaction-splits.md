# Transaction splits (categorize one purchase across several categories)

**Status: decisions settled 2026-08-23, in build.** Came out of Amazon orders, but is deliberately a
**general** feature. Today a transaction carries exactly one category, so a single purchase that spans
categories — a warehouse-store run that's part groceries / part electronics, or an online order with a
battery charger *and* a network switch — can only land in one bucket. This item adds the ability to
**split a transaction's amount across multiple categories**, on *any* transaction, with orders that carry
per-item detail able to **pre-fill** the split from it.

## Why not a lighter shortcut

Tags don't solve it: a tag is cross-cutting metadata, it doesn't divide the **amount**, so tagging an order
"electronics" wouldn't move any dollars into an electronics total. The requirement is fundamentally to
allocate the amount across categories, so some form of amount-split is unavoidable.

## The core model — split-allocation table

Keep the transaction as **one row** and attach a set of allocations that sum to its amount:

```
txn_split(id, txn_id, category_id, amount, sort_order)
```

- `txn.is_split` is the marker (see *Why a flag, not a sentinel category* below); the transaction's own
  `category_id` is **retained** as the stashed pre-split category so un-splitting restores it exactly.
- Allocations must **sum to the transaction amount** (enforced in the app on save, not by the DB) and
  share its sign.
- A split is **feature-owned categorization**, not a plain manual override — see *Protection* below.

**Why this over child transactions.** The alternative — turn the order into a parent excluded from totals
with N child rows — resurrects exactly the **per-item-rows model that was already abandoned** for the
marketplace importer (orders-only, 2026-07-10; see `data-model.md` → "Transaction links and Amazon order
import"), and it adds a visible parent/child hierarchy, a double-count risk, and tree-handling in
editing/undo/import. The allocation table keeps the ledger one clean row per purchase and confines the
complexity to reporting.

## The load-bearing piece: the effective-category-rows seam

Every category rollup currently reads `txn.category_id + txn.amount`. With splits, a split transaction
must contribute **one row per allocation** instead.

What makes this tractable is that the summary and list queries are already written entirely against a
single alias: `FROM txn t LEFT JOIN category c ON c.id = t.category_id LEFT JOIN category p ON p.id =
c.parent_id`, with every facet helper, the uncategorized sentinels, `_summary_signed_total_sql`, and the
`COALESCE(p.exclude_from_totals, c.exclude_from_totals, 0)` guard all phrased as `t.category_id`,
`t.amount`, `t.id`. So the seam **replaces the row source and nothing else moves**:

```
txn_effective(expand) =
    expand = false → txn
    expand = true  → SELECT <txn columns,
                              category_id ← CASE WHEN s.txn_id IS NULL THEN t.category_id ELSE s.category_id END,
                              amount      ← CASE WHEN s.txn_id IS NULL THEN t.amount      ELSE s.amount      END>
                     FROM txn t LEFT JOIN txn_split s ON s.txn_id = t.id
```

Route **all** category aggregation through it: `/summary/by-category`, `/summary/by-group`,
`/summary/by-category-in-group`, `/summary/by-tag-signature`, `/summary/monthly-trend`,
`/summary/monthly-by-group`, and the category-usage aggregation in `routers/categories.py`.
`exclude_from_totals` then applies **per allocation category** (`COALESCE(parent, leaf)`) and the
"an expense branch may hold credits" sign rule is preserved per allocation, both for free.

**Why a left join rather than a union of the split and non-split branches.** The obvious formulation —
`SELECT … FROM txn WHERE is_split = 0 UNION ALL SELECT … FROM txn JOIN txn_split` — reads `txn` twice.
Measured on a real-scale ledger (~18.5k rows, **no splits at all**), that cost about **80%** on top of
every summary query (23.6 ms → 42.9 ms), and driving the second branch from `txn_split` instead barely
moved it (41.9 ms). The left join measures **~6%** (23.6 ms → 25.0 ms). A feature nobody has used yet
should be close to free on every report in the app, and this is the difference between that and a
standing tax.

It is also the more robust shape, which is the part worth keeping in mind before anyone "optimizes" it
back. The substitution keys on whether a part row **matched** — `s.txn_id`, which is NOT NULL in the
table — rather than on its values, so:

- a part whose category was deleted out from under it (`ON DELETE SET NULL`) stays **uncategorized**,
  where a `COALESCE(s.category_id, t.category_id)` would have silently fallen back to the
  transaction's own pre-split category and reported the money in the wrong bucket;
- neither inconsistent state can corrupt a total: a flag with no parts yields the transaction once at
  its full amount, and parts with no flag are still expanded. The union got the first case wrong by
  dropping the row entirely and the second by counting it twice.

**Why `is_split` is still a column.** Not for the expansion — that reads the parts directly and never
consults the flag. It exists for everything that needs to know a row is split *without* reaching for
its parts: the ledger's "Split (N)" rendering, and the guards that make automatic categorization, bulk
edits, and rule applies decline these rows. A sentinel *category* was rejected for a different reason:
it would sit in the `category` table and flow through every `COALESCE(p.…, c.…)` join, group listing,
and picker in the app as if it were a real category.

## Which surfaces expand, and which don't

Expansion is not unconditional — the ledger must still read one row per purchase.

- **Summaries and trends: always expand.** Their whole job is category rollup.
- **The transaction list: expands exactly when a category-shaped facet scopes it** (`category_id`,
  `category_ids`, `group_ids`, their exclusions, or a `spending`/`income` view, all of which resolve
  through a category). Scoped that way, a split row returns as its matching allocation — the **part's**
  `category_id` and the **part's** amount — so a category drill-down's visible rows sum to the header
  total the summary endpoint produced. Unscoped, the list reads plain `txn` and a split renders once, at
  its full amount, marked "Split (N)".

  This rule is what settles the accuracy problem: `CategoryDetail.jsx` sums its fetched rows client-side
  for the local total, so a split row carrying its *full* amount into a category it only partly belongs
  to would print a number that is simply wrong (`collaboration-notes.md` → every displayed number must be
  the true value; geometry may floor, numbers may not).
- **Everything else — dedupe, rules matching, recurring detection, import, export — reads plain `txn`.**
  Those operate on the purchase, not on its category allocation.

## Protection: a split is feature-owned, not a manual override

The obvious reading — "a split is like a hand-set category, so `category_overridden = 1`" — is wrong, and
wrong in a way that loses money silently. The right precedent is `category_source = 'enrichment'`
(`data-model.md` → "How an existing transaction's category can change"): a categorization **owned by a
feature**, carrying a stashed prior for reversal, skipped by *source* rather than by the lock bit, because
letting a rule reclaim it would silently break a totals invariant.

Splits take the same shape with a new source value, `category_source = 'split'`:

- **Run categorization** (`recategorize_all`) and its preview skip split rows by source.
- **Preserve-manual apply** skips them by source, as it already skips `enrichment`.
- **Full-force rule apply** (`POST /rules/{id}/apply`) — the one path that overwrites even `manual` —
  **refuses** split rows and reports how many it left alone. This is the deliberate divergence from
  `enrichment`, which full-force apply *may* take. An `enrichment` row's prior is recoverable from its
  `txn_link` metadata; a split is hand-built allocation work with no other record, so silently discarding
  it is not the kind of thing a rule apply should be able to do. Refusing with a count follows
  `collaboration-notes.md` → Error Handling: a clear in-app explanation over automatic repair.
- **Bulk category edit** likewise refuses split rows and reports the count, for the same reason.

Un-splitting is therefore always an explicit user action, and it restores the retained pre-split
`category_id`.

## Tags: whole-transaction and per-part, both, for free

`_EFFECTIVE_TAG_UNION_SQL` (`services/transaction_tags.py`) already defines a row's effective tags as the
union of its **direct** `txn_tag` rows (keyed `tt.txn_id = t.id`) and the tags **inherited from its
category** (`JOIN category cc ON cc.id = t.category_id`). Under the expansion seam this resolves itself
with no new code and no new concept:

- a **direct** tag is keyed on the transaction id, so it applies to the whole transaction and every part;
- an **inherited** tag follows each part's own category, so a part in a tagged category carries that tag
  and its siblings do not.

That is the semantic worth wanting, and it is what the existing SQL already means. One visible
consequence to know about: in the tag-signature report a split transaction can contribute to **two**
signature buckets, each with its part's amount.

## Settled decisions

Recorded so they are not re-opened; each was a real fork.

- **Marker** — `txn.is_split` flag; `txn.category_id` retained as the stashed pre-split prior. (Rationale
  above.)
- **Two parts in one category** — **allowed** (reversed 2026-08-24; it was briefly disallowed). The
  argument for forbidding it was that an expanded bucket's `COUNT(*)` would read as allocation rows
  rather than transactions. That is a real effect, but the fix belongs in the query — `COUNT(DISTINCT
  t.id)`, which is the more honest reading of "how many transactions contributed" anyway — not in a
  constraint on what the user may record. A split is a record of the *items* a payment covered: two
  records bought in one order are two purchases at two prices by two artists, and collapsing them
  because they share a category discards the detail the feature exists to capture. Sums were never
  affected either way. Don't re-impose it.
- **Sign** — every part shares the transaction's sign. `_summary_signed_total_sql` requires the bucket's
  type to be constant, and `data-model.md` → Reporting assumptions ties income groups to money-in. A
  mixed-sign split (a part representing a refunded item) is a coherent future relaxation, deliberately
  not in v1.
- **Rules authoring splits** — no. A rule sets one category; splits stay a manual act.
- **Full-force apply and bulk edit** — refuse and report a count (above).
- **List contract** — the part's amount under a category-shaped facet (above).
- **Pre-fill edges** — an item with no list price is excluded from the proportional weighting and lands as
  a zero part for the user to fill rather than being dropped or guessed at; pre-fill is refused outright
  when net cash is 0 (a points/gift-card order) or when the list prices sum to 0.
- **Cascade** — `txn_split.txn_id` is `ON DELETE CASCADE`. Trash is soft (`trashed_at`), so a trashed
  split keeps its allocations and restoring it restores the split intact.

## Pre-fill from captured item detail (the motivating convenience)

An imported order already stores its items in `import_evidence` (description, **list price**, quantity,
item id). The catch — and the reason a naïve "one part per item at its price" is wrong — is that the item
figure is a **list price** (`amazon_import.py`: "reference detail only … never a ledger amount"), while
the transaction amount is **net cash** (`total − refund`, which folds in tax, shipping, and any
discount/promo). List prices generally **don't sum to what was paid**.

So the pre-fill **reallocates the actual net cash across the items in proportion to each item's list-price
contribution**:

```
allocation_i = round(net_cash × extended_i / Σ extended_j, 2)      extended = unit price × quantity
```

**The weight is the *extended* price, not the unit price.** The export prices one of a thing and counts
them separately, so weighting by `price` alone gives a line the user bought six of the same share as a
line they bought one of — and pushes the tax and shipping spread onto the single items. That `price` is
per-unit was established empirically rather than assumed: across single-line orders with quantity > 1 in
a real ledger, the transaction amount repeatedly equalled `price × quantity` **exactly** and never fell
below it, which is only true of a per-unit figure. (Restricting the check to single-line orders is what
makes it conclusive — list prices exclude tax and shipping but predate promos, so a whole-order sum can
land either side of the total for reasons unrelated to quantity.)

with the rounding remainder assigned to the largest part so the allocations sum to the amount **exactly**.
This distributes tax/shipping/discount proportionally — a reasonable default the user can then adjust. The
pre-fill is a *starting suggestion* on the split editor, not automatic; the user confirms or edits it.

**Categories are proposed by running each item's own description through the user's ordinary rules.**
That is what makes a twelve-item order tractable — otherwise it arrives as twelve empty pickers. It
stays a proposal in both directions: a line no rule claims comes back uncategorized rather than guessed
at, and the strip says how many were classified so the result never reads as finished. The matcher sees
the *item's share*, not the order total, since a rule may be scoped by amount or by debit/credit and
the line is what it would be classifying; an item the export never priced has no share and is left
alone rather than matched against a number that does not exist. The marketplace's own category taxonomy
stays deliberately unused, as everywhere else in this importer.

## Affected surfaces (the design pass)

- **Schema** — `txn_split` table + `txn.is_split`; baseline `CREATE` in `init_db` **and** a registered
  migration; the index on `txn_split(txn_id)` and the partial index on `txn(is_split)` go in the deferred
  post-migration block, since `is_split` does not exist on a pre-migration database.
- **Backup** — a `txn_splits` section in `BACKUP_SECTIONS`, payload version bump. The `sqlite_master`-derived
  omission guard in `test_backup_restore.py` fails until this is done, which is the intended behavior.
- **Reporting** — the six summary endpoints + the transaction-usage count in `routers/categories.py` (its sibling rule-usage count aggregates `category_rule`, which splits do not touch).
- **List** — the conditional expansion rule above, including the pagination count.
- **Categorization lifecycle** — `recategorize_all`, its preview, preserve-manual apply, full-force apply,
  bulk category edit; `category_source = 'split'` added to the provenance vocabulary.
- **Category deletion** — `category.id` is `ON DELETE SET NULL` from `txn`; a split part pointing at a
  deleted category must follow the same branch-rewrite rules deletion already applies to transactions,
  or the allocation sum silently stops matching.
- **Undo / re-import replace** — allocations cascade with the transaction, so batch undo needs no new
  step; the case to verify is the marketplace path, where the *linked charge* lives outside the batch.
- **Entry points** — the editor is reachable from the transaction detail panel, the ledger row menu
  and its `Split (N)` marker, and the **Amazon reconciliation report**, which offers it on matched and
  no-charge-found orders. The report is where orders are actually reviewed, so making the user find the
  row again in the ledger would be the same work twice.
- **UI** — the split editor in `TransactionDetail.jsx`; the "Split (N)" affordance in the shared
  `CategoryCell` (`TransactionRow.jsx`), which both the ledger and the detail panel render through, so one
  change covers both; partial-amount rendering in a category-scoped list.

## Downstream consumers

Three, which is what justifies paying for the seam:

- [`reimbursable-expenses.md`](reimbursable-expenses.md) — needs one part in a holding category and the
  rest in ordinary ones. That is the base capability; it asks nothing extra.
- [`transaction-attachments.md`](transaction-attachments.md) — **phase 4** feeds an approved line-item
  extraction into a split, the same shape as the marketplace pre-fill. Deliberately last there, and
  deliberately decoupled: splits must not be held hostage to an optional extraction feature.
- Marketplace order pre-fill, above.

The dependency runs one way only — both of the other two are blocked on splits, and splits waits on
neither.
