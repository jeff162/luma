# Changelog

All notable changes to Luma are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Added

- Account balance tracking. Balances appear on the Accounts page, can be entered by hand or imported
  from a CSV file, and the account report shows a running balance. A Balances dashboard charts them over
  time, and an account can be left out of it.
- A quick filter on reports for transactions excluded from totals.
- `luma --version` prints the version and, for a downloaded build, the commit it was built from.

### Fixed

- A long press on a touch device opens the Luma menu instead of starting a text selection.
- Escape closes only the topmost panel or dialog rather than everything open.
- Owner filters on the imported rule suggestions page now agree with the set of matching rules.
- A linked group's account report shows which member account each transaction came from, in place of
  the group name and the separate per-account filters.

## [0.3.0] - 2026-11-19

First public release. What it does is described under [Features](README.md#features) in the README;
from here on, this log records what changes between releases.

[Unreleased]: https://github.com/jeff162/luma/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/jeff162/luma/releases/tag/v0.3.0
