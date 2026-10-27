# Backlog

Deferred and parked work that is **not** blocking current features. Each file is one initiative,
written so it can be picked up cold.

**When an item ships, its file and its line here are deleted.**

**A link to a project filename decays,** because project filenames are transient by construction; topic
docs are stable, so a code comment cites `docs/<doc>.md` → *Section name* and never a path under here.
Before deleting a file, grep for what still points at it — code, the sibling project files and this
index — and repoint those citations in the same change.

A status line per item is welcome: *done*, *in progress*, *what remains* is exactly what someone picking
a file up cold needs first.

**Why many small files rather than one long one:** an agent (or a person) picking up one initiative
should be able to read one file, not scan a monolith for the paragraph that applies. The same reasoning
splits the topic docs by question — structure, field semantics, UI behavior, security, operations,
scale — rather than by feature.

## Items

- [paypal-amazon-enrichment.md](paypal-amazon-enrichment.md) — **shipped; deferred remainder only.** The
  import-enrichment + Amazon initiative landed in full — PayPal as an ordinary import, the general
  enrich-an-existing-transaction capability, `display_name_source`, evidence capture + role tagging, the
  Amazon orders-only account+link model with the funding-source map and reconciliation, and wallet
  funding-leg suppression — all folded into the main docs. What remains: AZAD paste/drag ingestion
  ergonomics, AZAD preview-features gating, a manual un-suppress of a funding-leg pair, enrich re-derive
  from stored raw values, and the deferred column-centric mapping-screen rework.
- [marketplace-purchase-detail.md](marketplace-purchase-detail.md) — **design, not started
  (2026-09-16).** Import eBay's purchase history and add the item detail to the card charge that paid for
  it, instead of Amazon's order-row model (the export names no paying card, order number or tax). Covers
  the purchase-record store, the matching (tax band + unique assignment, measured on one real download),
  a marketplace review shell that Amazon moves onto in the same change, the enriched `eBay: <item>` name
  with a rule pass for uncategorized charges, and eBay joining Amazon as a row in the data-source list. No product
  decisions owed.
- [online-categorizer.md](online-categorizer.md) — **parked design.** An opt-in online (LLM) merchant
  categorizer for cold-start, plus deterministic merchant-name cleaning at rule-build time. Both
  terminate in the existing rule store ("the rule is the cache"). Adjacent to the rules work — worth
  resuming next time rules are in focus.
- [cleanup-pass.md](cleanup-pass.md) — small, non-urgent cleanups to batch together: console quieting,
  the rest of the native-`title` → shared-`Tooltip` migration, and an opt-in
  per-detail-panel Refresh seam.
- [recurring-detection.md](recurring-detection.md) — **reduced 2026-09-03 to the pool-load
  optimization, the only item left.** The subsystem is live end to end — detection and curation, the
  rule-backed path, the ended/canceled lifecycle, the anomaly/forecast signals (2026-08-27) and amount
  identity with the user-pinned expectation band (2026-09-01, schema v46) — and all of it is in [`../data-model.md`](../data-model.md) → *Recurring series*. What stays:
  the payee filter is applied *after* a full pool load, so a scoped scan costs what a full one does
  (~125 ms vs ~124 ms on 20,000 rows) — academic when scans followed an import, less so now that it is
  on the path of every category edit. Pushing the filter into SQL needs `payee_key` materialized on
  `txn`; the revisit threshold is roughly 50,000 rows.
- [menu-consolidation.md](menu-consolidation.md) — **not started.** Four separate pop-up menu
  implementations, each with its own rows, hover and placement; settle one shell and row and move them
  onto it.
- [transaction-attachments.md](transaction-attachments.md) — **reduced 2026-09-03 to the unbuilt
  extraction tiers.** Phase 1 shipped 2026-08-24 — the `document` table and on-disk store, the
  format-agnostic ingestion seam (file, paste, the `text/html` flavour, a saved `.eml`), tier-1 PDF text
  and the FTS5 index, the backup and resumable-restore halves, the shared UI — and all of it is in
  [`../data-model.md`](../data-model.md) → *Attached documents*. What stays: tier 1b (embedded
  e-invoices, a file probe), tier 2 (local OCR, whose obstacle is packaging a system binary, not code),
  tier 3 (a BYOK extractor that is **the same subsystem** as
  [online-categorizer.md](online-categorizer.md) and should be designed with it), phase 4 (an approved
  itemization pre-filling a split), the **sizing assumption** and the signal that would falsify it, and
  the space-reclamation view — plus why originals are never sunset on a timer.
- [refactor-audits.md](refactor-audits.md) — **two recurring audit processes.** (1) Duplication /
  shotgun-surgery smells — the method is in the file, and its deciding caveats in `collaboration-notes.md` →
  *Code Structure Preferences*; the file records the first run's shipped items (`getFormControlStyle` in Dashboard,
  `TransactionListToolbar`, `useTags()`), the deferred candidates (row-patch util, the four drill
  panels) and the next scope (**backend audit**). (2) **Doc conformance** — does the code do what
  `data-model.md` says it does, claim by claim, with a five-way verdict per claim. The first run
  (2026-10-15) covered twelve of the doc's seventeen sections; what is carried is the four it did not
  reach — **import batches and profiles, watched import folders, transaction links and Amazon order
  import, backups** — plus the method and the two obstacles, of which the load-bearing one is that a
  green suite says nothing about conformance.
- [help-topic-search.md](help-topic-search.md) — **parked, not started (2026-07-25).** A search box on the
  `/help` topic index (in the sticky header) to find articles by typing. Parked because it's of limited
  use until the match reaches article *body* text, not just titles/summaries — and bodies are JSX, so
  that needs a per-topic `keywords` field (ongoing authoring) rather than free full-text search.
- [in-page-help-explain-mode.md](in-page-help-explain-mode.md) — **not started (2026-09-13).** An
  "explain this" mode that outlines the controls on a page that have help topics and opens the topic on a
  click, declared per control so it points at the real screen rather than a mockup; recorded with the
  post-data guided tour from the onboarding rework, which would sequence over the same declarations.
- [import-history-windowing.md](import-history-windowing.md) — **reduced again 2026-10-09; the
  per-source window, the by-year archive, the move onto transaction coverage and the stored-detail
  maintenance screen are all built.** The retention story — the silent global
  `LIMIT 50` that hid older imports and let one active source crowd out another, why the display query
  is unbounded, and why the writing reconcile pass on the same endpoint stays capped — is in
  [`../scale-and-limits.md`](../scale-and-limits.md); the window and archive as built are in
  [`../data-model.md`](../data-model.md). What stays: the
  fetch re-bound, now blocked on the five
  consumers that read the batch list as an aggregate rather than as a page.
- [ofx-direct-connect.md](ofx-direct-connect.md) — **researched, parked (2026-08-07).** OFX Direct
  Connect as a data-source provider — the only transaction pull with no aggregator in the middle. Settles
  the technology (`ofxtools`, pure Python; **not** aqbanking, a per-platform C build whose own consumers
  have abandoned the path), records that the protocol is being *retired* rather than held stable by
  Quicken (its successor, EWC+, is closed to third parties), and flags the disclosure it owes: an OFX
  credential **is the bank login** and cannot be revoked from inside the app, so both the connect and
  disconnect flows have to say so. Parked on
  **coverage**: the bundled FI list matched none of the institutions actually in use here.
- [provider-candidates.md](provider-candidates.md) — **research, nothing started (2026-10-09).** Which
  provider to add next, and what each would cost. The structural half is the finding worth acting on:
  SimpleFIN is a protocol with several independent servers — four of the seven services checked expose one
  — and the adapter isolates the protocol *mapping* cleanly while keeping every Bridge-specific policy in
  module constants no subclass can reach, so a second server costs a parameterizing refactor before it
  costs anything else. Records what each service actually is, the two that sell direct access to
  individuals (Akahu, Enable Banking's restricted production), the **server profile** that makes "named
  server" and "paste any token" one mechanism rather than two, and why accepting an unlisted host leaks
  nothing — so the fixed host allowlist is not re-imposed out of caution.

### Migrated from `TODO.md` / `TODO-TESTING.md` (2026-07-30)

- [saved-tag-reports.md](saved-tag-reports.md) — **deferred.** Four dashboard tag-report
  follow-ups: a Settings-page manager mirror, capturing filters in a preset, cross-user sharing
  (a real `tag_report` table), and a richer (drag/NL) report builder.
- [dashboard-reporting.md](dashboard-reporting.md) — **reduced 2026-09-02 to what has not started.**
  The cash-flow work shipped 2026-08-25 and its durable half is now in the topic docs: chart behaviour in
  the comments beside the chart code, reporting semantics (including
  `exclude_from_totals` as the *only* exclusion axis)
  in [`../data-model.md`](../data-model.md) → *Reporting assumptions* → *Cash flow*, and the endpoints in
  `architecture.md`. What stays: the **`cash_date`** phase for cash-basis timing. The trend-bucketing
  question was settled and built 2026-10-07.
- [import-input-formats.md](import-input-formats.md) — **reduced 2026-09-03 to the file formats,
  unstarted.** The **parse-seam extraction** they shared is done (2026-09-18, with the PayPal statement
  import as the second front end): XLSX first, reusing the entire downstream unchanged, then OFX/QFX/QBO,
  which follows the statement import's mapping-free path plus a `FITID` rung in dedupe, then QIF for
  moving from Quicken (added 2026-10-23), mapping-free too, with splits and transfers. SimpleFIN — the Plaid-parallel connection track that
  shared this file — shipped 2026-08-07 and everything it taught is in
  [`../building-a-connector.md`](../building-a-connector.md).
- [import-dedupe-followups.md](import-dedupe-followups.md) — **deferred (not safety).** A
  duplicate-resolution history view + batch undo, convenience only — per-row restore already prevents
  loss. Also holds two measured/scoped
  deferrals: bank-side type prefixes, and letting a coverage reject rest on the actual twin rather than
  on whichever same-amount row filled the candidate slot (the report half of that one shipped).
- [document-incremental-backups.md](document-incremental-backups.md) — **design, not started, not
  needed yet.** Document-only backups, with each data backup carrying only the documents added since the
  last one. Started when the backup history shows documents as the bulk of a backup.
- [i18n-display-formatting.md](i18n-display-formatting.md) — **reduced 2026-09-03 to the number/date
  half, unstarted.** Tier-1 **formatting**, not translation. The ledger-currency setting shipped
  2026-08-08 and its model is in [`../data-model.md`](../data-model.md) → *One ledger currency*. What stays: **Bucket A** (the `en-US`
  formatter, a date-format preference, and the ~9 raw ISO renders the central helpers never reach —
  cosmetic) and **Bucket B**, the only correctness risk: the ledger search parses dates MDY-first and
  amounts with fixed separator roles, and CSV amount parsing carries the same hazard, where `1.234,56`
  silently imports as `1.234`.
- [query-cache-invalidation.md](query-cache-invalidation.md) — **parked, maybe never.** Swap the
  hand-wired `notifyTransactionsChanged` refresh map for dependency-based (query-key) invalidation —
  only if transaction-derived views proliferate enough to hurt.
- [database-diagnostics.md](database-diagnostics.md) — **backlog, not started (2026-08-10).** Nothing
  ever checks that the databases are intact — no health surface, and notably no check of the *target*
  before a destructive restore. Structural half is small (`integrity_check` + `foreign_key_check`, ~100 ms
  on a 60 MB DB; note the former does **not** cover foreign keys). The larger half is an invariant
  checker for the semantic inconsistencies those pragmas call "ok" — kept deliberately separate.
- [misc-followups.md](misc-followups.md) — **catch-all.** One-offs too small for their own file:
  the unwritten CHANGELOG entry for the category-owner → tag migration, a denser Connections-tab card
  layout, SimpleFIN's 90-day window becoming a silent cap, whether timestamps should ever be relative,
  the stalled-request gap a blanket request timeout was rejected for, and what checking a tag on a
  transaction should *mean* — the open question being whether a hand-checked tag survives a later
  recategorization, with a concrete hole in bulk `add_tags` to look at first.
