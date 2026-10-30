# Backlog

Work that has not been built yet. Each file is one project, written so it can be picked up cold.

**A file describes the work remaining, not its history.** When part of a project ships, its durable facts
move into the topic docs (or a comment beside the code) and the file is cut down to what is left. What
was tried, what shipped and when belong in git history. A rejected approach stays only where it would
stop the next attempt from repeating it.

**When a project ships, its file and its line here are deleted.** Project filenames are transient, so a
code comment cites `docs/<doc>.md` → *Section name* and never a path under here. Before deleting a file,
grep for what still points at it (code, the sibling project files and this index) and repoint those
citations in the same change.

**Why many small files rather than one long one:** someone picking up one project should be able to read
one file, not scan a monolith for the paragraph that applies.

## Proposals ready to build

- [per-account-currency.md](per-account-currency.md) — one currency per account, with accounts and rules
  interacting only within their currency and a per-user selector choosing which currency the app shows.
  Nothing is converted. Five decisions are owed, each with a recommendation.
- [marketplace-purchase-detail.md](marketplace-purchase-detail.md) — import eBay's purchase history and
  add each item's detail to the card charge that paid for it. Covers the purchase-record table, matching
  by tax band and unique assignment, the eBay vendor on the shared reconciliation review, and the
  `eBay: <item>` name. No product decisions owed.

## Import and data sources

- [import-input-formats.md](import-input-formats.md) — three file formats: QIF (the way out of Quicken,
  highest value), XLSX (cheapest) and the OFX family. Each is a new front end on the existing parse seam.
- [provider-candidates.md](provider-candidates.md) — which data provider to add next. Several services
  expose a SimpleFIN server, so a server-profile refactor of the SimpleFIN adapter makes each one a
  configuration entry. Two others (Akahu, Enable Banking) sell direct access to individuals.
- [ofx-direct-connect.md](ofx-direct-connect.md) — OFX Direct Connect as a provider, the only pull with
  no aggregator in the middle. Parked on institution coverage. The credential is the bank login, which
  the connect and disconnect flows have to say.
- [paypal-amazon-enrichment.md](paypal-amazon-enrichment.md) — leftovers from the enrichment and Amazon
  work: AZAD paste/drag ingestion, AZAD preview-feature gating, undoing one wallet funding-leg pairing,
  re-deriving enrichment from stored raw values, and a column-per-row mapping screen.
- [import-dedupe-followups.md](import-dedupe-followups.md) — a duplicate-resolution history view with
  batch undo, letting a coverage reject rest on the real twin rather than a coincidence, and the
  bank-side type prefixes that stay unstripped.
- [import-history-windowing.md](import-history-windowing.md) — page the import-history fetch, once the
  four callers that read it as all of history have their own endpoints.

## Ledger, rules and reporting

- [recurring-detection.md](recurring-detection.md) — the stale-series cadence bug, showing transfer
  pairs that are not a series, and storing `payee_key` so a scoped scan stops reading the whole window.
- [dashboard-reporting.md](dashboard-reporting.md) — `cash_date`, a second date for cash-basis timing.
- [saved-tag-reports.md](saved-tag-reports.md) — a manager for saved tag reports outside the dashboard,
  and a richer report builder.
- [online-categorizer.md](online-categorizer.md) — an opt-in LLM categorizer for merchants with no
  history, and deterministic merchant-name cleaning for the suggested rule keyword. Both end in the
  existing rule store.
- [misc-followups.md](misc-followups.md) — one-offs too small for their own file: showing every source
  of a transaction's tag, and a per-rule *stop matching* option.

## Documents and backups

- [transaction-attachments.md](transaction-attachments.md) — document extraction past the PDF text
  layer: embedded e-invoices, local OCR, a BYOK itemizer shared with the online categorizer, and
  itemizations pre-filling splits. Also the space-reclamation view.
- [document-incremental-backups.md](document-incremental-backups.md) — document-only backups, with each
  data backup carrying only new documents. Not needed until documents are the bulk of a backup.
- [database-diagnostics.md](database-diagnostics.md) — an invariant checker for the inconsistencies the
  structural database check reports as `ok`.

## Help

- [help-topic-search.md](help-topic-search.md) — a search box on the `/help` index. Waits on a way to
  match article bodies.
- [in-page-help-explain-mode.md](in-page-help-explain-mode.md) — an "explain this" mode that outlines
  the controls on a page that have help topics, and a guided tour built on the same declarations.

## Code health

- [refactor-audits.md](refactor-audits.md) — two recurring passes: duplication and shotgun surgery
  (next scope: the backend), and checking the code against what a topic doc claims (next scope:
  `architecture.md`).
- [cleanup-pass.md](cleanup-pass.md) — small cleanups to batch: the file card's *rejected* count, and the
  press-driven transient labels.
- [query-cache-invalidation.md](query-cache-invalidation.md) — dependency-based refresh instead of the
  hand-wired `notifyTransactionsChanged` list. Only if derived views multiply enough to hurt.
