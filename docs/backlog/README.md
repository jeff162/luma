# Backlog

Deferred and parked work that is **not** blocking current features. Each file is one initiative,
written so it can be picked up cold. This is a living list: when an item ships, fold its durable
"what it is and why" into the main docs (`architecture.md` / `data-model.md` / `ui-patterns.md`) and
delete the backlog file.

## Items

- [paypal-amazon-enrichment.md](paypal-amazon-enrichment.md) — **shipped; deferred remainder only.** The
  import-enrichment + Amazon initiative landed in full — PayPal as an ordinary import, the general
  enrich-an-existing-transaction capability, `display_name_source`, evidence capture + role tagging, the
  Amazon orders-only account+link model with the funding-source map and reconciliation, and wallet
  funding-leg suppression — all folded into the main docs. What remains: AZAD paste/drag ingestion
  ergonomics, AZAD preview-features gating, a manual un-suppress of a funding-leg pair, enrich re-derive
  from stored raw values, and the deferred column-centric mapping-screen rework.
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
- [account-type-as-rule-criterion.md](account-type-as-rule-criterion.md) — **backlog, not started
  (2026-07-20).** Generalize "restrict to PayPal/Amazon" from per-account-id scoping to **account *type***
  as a first-class axis for rules (and filtering/search): add PayPal as an account type, add an
  account-type rule criterion (parallel to the existing account-id one), and structured account-type
  filters — with a `accttype:`/`acctname:` tag grammar flagged as the harder free-text-search piece.
  Money-movement rules are the first consumer ready to migrate. Punts on existing data.
- [paypal-money-movement-recognition.md](paypal-money-movement-recognition.md) — **shipped; deferred
  remainder only.** PayPal source recognition, force-captured `Type`/`Item Title`, and the user-approved,
  account-scoped, bidirectional `Type` → *Money movement* rules all landed (2026-07-20) and are folded into
  the main docs. What remains: fold the dedicated review into the generic rule-suggestion engine (cluster by
  `Type`), and migrate the rules from account-id to account-type scope once that axis exists.
- [transaction-splits.md](transaction-splits.md) — **backlog, not started (2026-07-23).** Let a single
  transaction's amount be split across several categories (a Costco run, an Amazon order with mixed items).
  A **general** feature on any transaction, modeled as a `txn_split` allocation table (one ledger row, N
  category/amount parts) with reporting routed through an "effective category rows" seam — deliberately not
  the abandoned per-item-rows model. Amazon orders **pre-fill** the split by reallocating net cash across
  items in proportion to list price (list prices exclude tax/shipping/discounts, so they can't be used
  directly). Main cost is the cross-cutting reporting-expansion change.
- [refactor-audits.md](refactor-audits.md) — **recurring process.** Periodically hunt duplication /
  shotgun-surgery smells (structural tools + a judgment pass), fix the safe ones. Records the first
  run's shipped items (`getFormControlStyle` in Dashboard, `TransactionListToolbar`, `useTags()`), the
  deferred candidates (row-patch util, the four drill panels), and the next scope (**backend audit**).
- [help-topic-search.md](help-topic-search.md) — **parked, not started (2026-07-25).** A search box on the
  `/help` topic index (in the sticky header) to find articles by typing. Parked because it's of limited
  use until the match reaches article *body* text, not just titles/summaries — and bodies are JSX, so
  that needs a per-topic `keywords` field (ongoing authoring) rather than free full-text search.
- [tag-report-exclude-warning.md](tag-report-exclude-warning.md) — **parked, not started (2026-07-26).**
  A small inline note on the Dashboard tag-report view when a filter chip references a tag the active
  report is built from (the exclude is honored, not suppressed — the note just explains the subset).
  Parked for a larger tag-report pass rather than a one-off; the behavior is already correct without it.
- [transaction-list-limits.md](transaction-list-limits.md) — **surveyed, mostly resolved (2026-07-27).**
  Every scoped transaction list now paginates with server-side sort (the `limit: 1000`/`500`/`200` caps
  that silently truncated rendered lists are gone), plus a `limit=0` no-limit opt-in and a dev-mode
  truncation warning. This file records the caps that **remain on purpose** (the 36/60-month detail-drawer
  trend windows; "All time" means recent history there) and the few **deferred fix candidates**
  (money-movement Type preview `1000`, trash list `200`).

## Related (already tracked elsewhere)

- `docs/import-source-fields-plan.md` Phase 3 — user-selectable transaction-report columns drawn from
  the import-source field registry. Parked there ("maybe never"); not duplicated here.
