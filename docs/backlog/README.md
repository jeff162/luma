# Backlog

Deferred and parked work that is **not** blocking current features. Each file is one initiative,
written so it can be picked up cold. This is a living list: when an item ships, fold its durable
"what it is and why" into the main docs (`architecture.md` / `data-model.md` / `ui-patterns.md`) and
delete the backlog file.

These were surfaced from session memory and reconciled against the code on 2026-06-24, so the
"already done" notes below reflect the tree at that point.

## Items

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

## Related (already tracked elsewhere)

- `docs/import-source-fields-plan.md` Phase 3 — user-selectable transaction-report columns drawn from
  the import-source field registry. Parked there ("maybe never"); not duplicated here.
