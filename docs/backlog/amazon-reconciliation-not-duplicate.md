# Amazon reconciliation — a "not a duplicate" marker

**Status: implemented (2026-07-16).** Kept as the design record; the open questions below were settled
as noted.

## Context

The reconciliation report ([`amazon_reconciliation`](../../backend/routers/import_export/amazon.py)) groups
an order's same-amount candidate charges and, when there's a *surplus* (more charges than orders in the
amount cluster), surfaces them as **Duplicate detected** with **Merge** / **Discard** actions. Grouping is
by the matcher's own rule (amount + date window + last-4 / funding map), so it's amount-identity, **not**
purchase-identity: two genuinely distinct purchases of the same amount within the window would still group
together.

The **charges-vs-orders count rule** (shipped) removes most false positives: when charges *equal* orders in
a cluster, they're auto-paired at import (and after a resolve) and never flagged. So the residual is narrow:
a *surplus* cluster that is actually distinct purchases (e.g. bought two identical-price things, then a third
same-price refund-and-rebuy), where Merge would be wrong.

## What shipped (2026-07-16)

The "confirm before investing" gate was satisfied by real data — the false positive first appeared in the
**Unaccounted · duplicate** grouping (a Kindle charge next to a same-amount non-Kindle charge), and the
marker was built there, then extended to the order-anchored groups:

- **Persistence**: a dedicated pair table **`amazon_charge_distinct`** (`txn_id_low < txn_id_high`,
  mirroring `account_pair_distinct`'s accumulated-filter model), created by the baseline
  `CREATE TABLE IF NOT EXISTS` script and covered by backup/restore. This superseded the doc's earlier
  `txn_link`-kind preference: the assertion is a symmetric pair fact with no member roles, so the sparse
  pair table is the closer fit and keeps `txn_link` for real order↔charge relationships.
- **Backend**: `mark_charges_distinct` / `POST /amazon/charges-not-duplicates` records every pair in the
  group. The report consults the table everywhere it claims "duplicate": the unaccounted grouping refuses
  to chain asserted pairs, and the `duplicate` / `duplicate_review` buckets (and the matched-order
  extra-copies case) are skipped when **all** pairs in the group are asserted.
- **Semantics** (the settled granularity question): the assertion is **pairwise, whole-group** — the UI
  marks every pair in the displayed group; a later re-import that adds a new copy forms new unasserted
  pairs and correctly re-flags. A partially marked 3+ group still flags (the ambiguity is unresolved).
  For an order-anchored group the assertion removes the *duplicate* claim, not the *match* question — the
  order falls back to the unmatched path, where the split-suggestion pass's **exact-date tie-break**
  nominates a candidate dated on the order itself (as Matched · review, with a reason note) and otherwise
  the order lands in No charge found for manual linking.
- **Frontend**: a **Not duplicates** action on all three duplicate-flavored rows (unaccounted, duplicate,
  duplicate · review); on an unmergeable group (other orders share the amount) it is the row's primary
  resolution.

## Don't-forget (original gate, satisfied)

Only worth building if the residual false-positive actually shows up in real data. As of shipping A+B, the
observed Mint case was **all** true duplicates (one purchase, two syncs — the earlier "AMAZON MARKETPLACE"
preliminary vs. the later enriched copy), which Merge/Discard already handle. ~~Confirm the distinct-surplus
case is real before investing.~~ Confirmed 2026-07-16 in the unaccounted flavor (same-amount Kindle /
non-Kindle pair).
