# Changelog

All notable changes to Luma are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

This log starts at version 0.3.0.

---

## [Unreleased]

First public release. Development before this point is not recorded here: nothing preceded it that
anyone could be upgrading from, so the entry below describes what exists rather than what changed.

### Added

- **Importing** — CSV files and connected data sources (SimpleFIN Bridge), plus Amazon order history
  and PayPal activity for itemizing what a marketplace charge actually bought. A data source can also
  watch a folder, so a downloaded export is in the ledger the next time the app is open; anything its
  saved mapping cannot answer on its own is left for review rather than guessed at.
- **Duplicate detection across every source**, so overlapping exports and a card arriving from two
  places do not double-count.
- **Categorization that persists** — a category tree, rules that apply categories, merchant renames
  and tags as transactions arrive, and rule learning from already-categorized history.
- **Reporting** — spending, income and cash-flow views over a period or as a trend, with period
  comparison, cross-cutting tag reports, and drill-down to the individual transactions.
- **Recurring series** — automatic detection of subscriptions, bills and paychecks, with signals for a
  missed charge, a price change, a newly detected series and a charge drifting outside a rule's range.
- **Transaction splits**, allocating one charge across several categories.
- **Reimbursables** — pairing an expense with the income that repays it, including expenses that expect
  a future reimbursement and remind when one is late.
- **Attached documents** — receipts and invoices dropped, pasted or saved onto a transaction, with text
  from a PDF or an email receipt searchable alongside the ledger.
- **A credential vault** for connected data sources, opened by passphrase, passkey or recovery code,
  shared across a household with per-person access.
- **Backup and restore**, optionally encrypted, covering the ledger and its attached documents.
- **Multiple owners and multiple users**, with owner as a reporting axis rather than a separate ledger.
- **Local or networked operation** — a desktop install on loopback, or a machine on the LAN reached by
  other devices behind a sign-in perimeter.
- **An optional check for a new version**, off unless switched on, which adds a task when a newer
  release exists. Nothing is downloaded or installed.

[Unreleased]: https://github.com/jeff162/luma/compare/v0.3.0...HEAD
