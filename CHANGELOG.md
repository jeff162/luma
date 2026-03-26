# Changelog

All notable changes to FinTrack are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Added
- Categorization rule suggestion toast — after manually categorizing a transaction,
  a non-intrusive toast appears offering to create a rule for that payee. Dismisses
  automatically after 8 seconds; clicking "Create rule" opens the full rule editor
  pre-filled with the merchant name and chosen category.
- Rule editor redesign — rules now use a two-section "If / Then" layout with
  expandable condition chips (merchant name, amount, owner, account). Amount
  conditions support `>=`, `>`, `<=`, `<`, and equals operators with separate
  lower/upper bounds and a debit/credit/both selector.
- Rules list plain-text descriptions — each rule row shows its conditions and
  action as natural language ("amount >= $10 → Groceries") instead of separate
  columns, making complex rules easier to read at a glance.
- Merchant rename folded into rules — the "Rename merchant to" action is now
  part of the categorization rule rather than a separate Merchant Renames tab.
  Rules with a `clean_name` set will rename the merchant display name when they
  fire during sync or re-categorization.
- Income / Expense super-groups on Categories page — groups are now separated
  into Expense and Income sections. A Type toggle (Expense / Income) in the
  group detail panel controls which section a group appears in and whether it
  contributes to income or spending totals.
- Automatic rule specificity ordering — rules are evaluated most-specific first
  (longer keyword beats shorter, more conditions beat fewer, owner-scoped beats
  global) with no manual priority number needed.
- Rule list sort order — rules are listed alphabetically by keyword; within the
  same keyword, less-specific rules appear first (general → specific top-to-bottom,
  matching reverse evaluation order so overrides are visible at the bottom).
- Match preview when editing rules — after setting keyword or amount conditions,
  the form shows a live count of uncategorized transactions that match, with an
  optional checkbox to apply the rule to those transactions immediately on save.
- Sticky filter bar on Rules page — the keyword filter and rule count stay pinned
  while the rule list scrolls.

### Changed
- `categorizer.py` — `categorize_transaction()` now returns a dict
  `{"category_id": ..., "clean_name": ...}` instead of a bare string, enabling
  rules to carry rename instructions. `recategorize_all()` applies clean names
  to existing transactions when re-running rules.
- `sync.py` — merchant display name is set from the matched rule's `clean_name`
  during sync, replacing the separate merchant_rename pre-pass.
- Rule evaluation order changed from `priority DESC` to computed specificity
  (keyword length DESC, condition count DESC, owner-scoped first).
- Rules page list changed from multi-column grid to two-column layout
  (keyword + plain-text description).
- "New rule" button renamed to "Add rule".
- Rule priority field removed from the UI (stored in DB for compatibility but
  no longer surfaced or used for ordering).

### Removed
- Merchant Renames tab from the Rules page — functionality merged into rules.
- Merchant rename API methods from `api.js` (`getMerchantRenames`,
  `createMerchantRename`, `updateMerchantRename`, `deleteMerchantRename`,
  `applyMerchantRenames`). The `merchants.py` router was already unregistered.

---

## [0.1.0] — Initial release

### Added
- SQLite database with versioned migration system (v1–v13)
- Plaid integration for live bank account sync
- CSV import with column mapping, saved profiles, and duplicate detection
- Multi-owner support (assign accounts and category groups to owners)
- Two-level category hierarchy (groups → leaf categories)
- Keyword-based auto-categorization rules with amount range and owner scope
- Dashboard with spending by group, drill-down to categories and transactions,
  period comparison, multi-month trends, and owner split view
- Transaction list with inline categorization, merchant rename, and notes
- Transaction detail panel — payee spending history with 18-month chart window
- Import/Export — CSV export, full data backup/restore as JSON
- Tasks — live action items for unowned accounts and uncategorized transactions
- Auth system — optional multi-user mode with session-based login and 2FA
- Docker support via `docker-compose.yml`
- Nightly sync via `scripts/sync.sh` (cron-compatible)
