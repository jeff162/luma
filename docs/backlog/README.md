# Backlog

Deferred and parked work that is **not** blocking current features. Each file is one initiative,
written so it can be picked up cold. This is a living list: when an item ships, fold its durable
"what it is and why" into the main docs (`architecture.md` / `data-model.md` / `ui-patterns.md`) and
delete the backlog file.

## Items

- [paypal-amazon-enrichment.md](paypal-amazon-enrichment.md) — **active working design (not parked).**
  Collapsed from a bespoke reconciliation source to something small and general: **PayPal is an ordinary
  import** (an account like any card; transfers stay categorization), and the one new capability is a
  **general feature — enrich an existing transaction with a later import's novel detail** at the dedup
  layer (a manual resolution-screen action + an opt-in per-source auto-enrich). `display_name_source`
  (the manual-rename guard it relies on) has **landed**. Amazon is deferred and, when scoped, is built on
  the same enrich feature (it is genuinely a merchant enriching existing card rows, unlike PayPal).
- [online-categorizer.md](online-categorizer.md) — **parked design.** An opt-in online (LLM) merchant
  categorizer for cold-start, plus deterministic merchant-name cleaning at rule-build time. Both
  terminate in the existing rule store ("the rule is the cache"). Adjacent to the rules work — worth
  resuming next time rules are in focus.
- [cleanup-pass.md](cleanup-pass.md) — small, non-urgent cleanups to batch together: console quieting,
  the rest of the native-`title` → shared-`Tooltip` migration, a legacy dead-code sweep, and an opt-in
  per-detail-panel Refresh seam.
- [import-rule-suggestion-review-extraction.md](import-rule-suggestion-review-extraction.md) — the one
  remaining piece of the import/export refactor: in-component JSX extraction from the large
  `ImportRuleSuggestionReview` component into prop-driven seams.
- [list-virtualization.md](list-virtualization.md) — **scale/perf, deferred.** Render-window the large
  lists (duplicate-rows dialog first, then `TransactionListTable` / the ledger) so DOM node count is
  bounded by the viewport, not the dataset. Built into the shared table shells; preserves sticky pill
  header, column-pref grid template, and select-all-matching bulk edit.
- [recurring-detection.md](recurring-detection.md) — **follow-ups to a shipped feature.** The recurring-
  series subsystem is live (detect + list + curate); deferred pieces are the per-import matching hook,
  the anomaly/forecast signals (upcoming / missed / new / price-change), and a "Mark as recurring" row
  action in the shared transaction context menu.
- [button-consolidation.md](button-consolidation.md) — **design-system task, deferred.** Audit the app's
  button treatments (shared `Button` + bespoke one-offs that have drifted) and settle on one shared set
  of sizes/variants, then migrate the one-offs. Central decision is solid-vs-soft-tint primary and the
  ghost drop shadow, not just pixel size.
- [amazon-batch-by-period.md](amazon-batch-by-period.md) — **noted, not started (2026-07-19).** Amazon
  import batches by *drop* (one card per upload, any number of periods) rather than by *coherent period*;
  correct for the orders+items pairing of one span but it also bundles unrelated years onto one card.
  Direction: batch by period/order-set, keeping same-period orders+items together. Amazon-specific — the
  CSV importer already batches per file.
- [amazon-reconciliation-not-duplicate.md](amazon-reconciliation-not-duplicate.md) — **implemented
  (2026-07-16).** A "Not duplicates" disposition on every duplicate-flavored reconciliation row, persisted
  in the `amazon_charge_distinct` pair table (not the `txn_link` kind originally guessed) so detection
  never re-flags asserted pairs; an order-anchored group falls back to the unmatched path with an
  exact-date tie-break suggestion. Kept as the design record.
- [refactor-audits.md](refactor-audits.md) — **recurring process.** Periodically hunt duplication /
  shotgun-surgery smells (structural tools + a judgment pass), fix the safe ones. Records the first
  run's shipped items (`getFormControlStyle` in Dashboard, `TransactionListToolbar`, `useTags()`), the
  deferred candidates (row-patch util, the four drill panels), and the next scope (**backend audit**).

## Related (already tracked elsewhere)

- `docs/import-source-fields-plan.md` Phase 3 — user-selectable transaction-report columns drawn from
  the import-source field registry. Parked there ("maybe never"); not duplicated here.
