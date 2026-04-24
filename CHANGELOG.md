<!-- SPDX-FileCopyrightText: 2026 Jeffrey Orlin -->
<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# Changelog

All notable changes to FinTrack are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Added

- Cross-platform launcher and setup helpers for Windows and Unix-like systems,
  including first-run environment bootstrap and a runtime repair screen for
  missing required settings.
- Import/export upgrades, including smarter CSV preview and recent-setting reuse,
  account creation during import, post-import category mapping from CSV text,
  and zipped backup/restore with optional RSA encryption for cloud-safe storage.
- Rule-system upgrades, including the post-categorization rule suggestion toast,
  the redesigned "If / Then" rule editor, natural-language rule descriptions,
  live match previews, and merchant renaming folded into categorization rules.
- Category and detail-view upgrades, including income/expense super-groups and
  new category/account detail panels alongside the existing payee detail view.

### Changed

- The setup flow is now organized around launcher scripts and a simpler `.env`
  story, with advanced overrides documented separately.
- Accounts and Settings were reorganized so account editing lives on the
  Accounts page, owner/category ownership is managed where it is used, and
  security settings now cover password policy, 2FA, backup recipients, and
  environment-backed options more cleanly.
- Rule evaluation now uses computed specificity instead of manual priority, and
  the Rules page is organized around readable descriptions rather than grid-style
  editing.
- Detail panels now share common shell/chart/paging behavior, use incremental
  transaction loading, stay open until explicitly closed, and remember floating
  placement between openings.
- Backup restore is more resilient across exported instances, including restore
  handling for category/account relationship ordering.
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

### Removed

- Merchant Renames tab from the Rules page — functionality merged into rules.
- Merchant rename API methods from `api.js` (`getMerchantRenames`,
  `createMerchantRename`, `updateMerchantRename`, `deleteMerchantRename`,
  `applyMerchantRenames`). The `merchants.py` router was already unregistered.
