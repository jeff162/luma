# Changelog

All notable changes to Luma are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Changed

- The backup history keeps a number of backups (50 by default) rather than a number of days, and scrolls
  in its own box on Backup / Restore.
- A backup carries the sync log. Restoring the data together with the credentials brings it back with the
  connections; a restore that keeps this system's connections keeps its log.

### Fixed

- Duplicate cleanup could trash both copies of a charge: re-checking a connection's rows after mapping an
  account, or confirming a flagged duplicate whose other copy had since been trashed.
- A SimpleFIN pending charge too old to be reported again no longer widens every sync, and a routine sync
  stays within the Bridge's recommended range.

## [0.3.1] - 2026-11-23

### Added

- Account balance tracking. Balances appear on the Accounts page, can be entered by hand or imported
  from a CSV file, and the account report shows a running balance. A Balances dashboard charts them over
  time, and an account can be left out of it.
- A quick filter on reports for transactions excluded from totals.
- `luma --version` prints the version and, for a downloaded build, the commit it was built from.
- Accounts can be closed. A closed account is listed apart on the Accounts page and keeps its
  transactions; one dated after the close raises a Task. Closing one account of a merged group retires
  it alone, such as a replaced card number. An import whose data source sends an account to a closed one
  asks again where its rows go when the file has rows dated after the close, and a watched folder holds
  such a file.
- Tasks are listed newest first, marked New when they appeared or grew since the page was last opened,
  with occasional alerts above the steady flow of work.
- A merged group's primary can be changed, from the account's menu or by dragging it onto the primary;
  the group keeps its settings. A Task suggests it when the primary has gone quiet while another account
  in the group has not.
- An owner's transactions can be left out of the Uncategorized transactions task, from the owner's
  **Track uncategorized transactions** switch on the Accounts page's Owners tab.

### Fixed

- A long press on a touch device opens the Luma menu instead of starting a text selection.
- Escape closes only the topmost panel or dialog rather than everything open.
- Owner filters on the imported rule suggestions page now agree with the set of matching rules.
- A linked group's account report shows which member account each transaction came from, in place of
  the group name and the separate per-account filters.
- The preview of pasted HTML now removes links inside embedded SVG images, which it had missed while
  removing every other link.

## [0.3.0] - 2026-11-19

First public release. What it does is described under [Features](README.md#features) in the README;
from here on, this log records what changes between releases.

[Unreleased]: https://github.com/jeff162/luma/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/jeff162/luma/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/jeff162/luma/releases/tag/v0.3.0
