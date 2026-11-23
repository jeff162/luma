# Backlog

Work that has not been built yet. Each file is one project, written so it can be picked up cold.

**Each file opens the same way:** a title naming the outcome, a short *What it is* in user terms (what
someone would see or be able to do, and why it is wanted), and a *Where it stands* line (not started,
parked on what, or ready to build). Code names and mechanism come after that. A file holding several
small items gives each one a line in *What it is*.

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

## Ready to build

- [Accounts in more than one currency](per-account-currency.md) — each account has its own currency and
  the app shows one currency at a time; nothing is converted. Five decisions are owed, each with a
  recommendation.
- [Showing what was bought on eBay](ebay-purchase-detail.md) — import eBay's purchase history and
  add the item to the card charge that paid for it, so the row reads `eBay: <item>`. No decisions owed.

## Sign-in

- [An administrator can require a second factor](require-second-factor.md) — a switch that makes every
  account sign in with an authenticator code or a passkey. One design pass owed: the setup step at sign-in.

## Import and bank connections

- [Importing Quicken files, spreadsheets and bank OFX downloads](import-input-formats.md) — QIF (the way
  out of Quicken, highest value), XLSX (cheapest) and the OFX family.
- [More bank-connection services, mostly outside the US](provider-candidates.md) — research on which
  service to add next. One change to the SimpleFIN connector would open several of them at once.
- [Connecting straight to the bank](ofx-direct-connect.md) — OFX Direct Connect, with no service in the
  middle. Parked: few banks still support it, and it needs the user's bank login.
- [Amazon, PayPal and import-mapping improvements](amazon-paypal-improvements.md) — five small, independent
  items, such as pasting Amazon orders instead of saving a file.
- [Duplicate detection improvements](duplicate-detection-improvements.md) — a history of duplicate decisions with
  batch undo, and a rejection that rests on the right reason.
- [Import history that stays fast as it grows](import-history-paging.md) — load the import history a
  page at a time. Blocked on four screens that read all of it.

## Ledger, rules and reporting

- [Recurring page: a cadence bug, unscheduled transfers, and speed](recurring-detection.md) — a stopped
  subscription can get the wrong schedule; transfers on no schedule are shown nowhere; edits slow down as
  the ledger grows.
- [Reports by when the money actually left the bank](cash-basis-reporting.md) — a second date on card
  purchases, the date the card payment covered them.
- [A cash-flow Trends view whose two charts agree](cash-flow-trends-view.md) — the yearly and monthly
  charts pick their periods separately, yet a click on one moves the other. No design agreed.
- [Managing and building tag reports](saved-tag-reports.md) — one place to manage saved tag reports, and
  a richer report builder.
- [Categorizing merchants Luma has never seen](online-categorizer.md) — an opt-in AI categorizer for a new
  ledger, and cleaned-up keywords when building a rule.
- [Small rule and tag improvements](rule-and-tag-improvements.md) — show where a transaction's tag comes from, and a
  rule option that stops lower rules from applying.

## Documents, backups and data checks

- [Reading receipts](document-extraction.md) — searchable photographed receipts, line items read
  from invoices, and a view of what documents take up space.
- [Smaller backups when there are many attached documents](document-incremental-backups.md) — back up
  documents separately. Not needed until documents are the bulk of a backup.
- [Finding data that is quietly wrong](data-consistency-checker.md) — a checker for data that passes the
  database damage check but no longer makes sense.

## Help

- [Searching the help pages](help-topic-search.md) — a search box on the Help index. Waits on a way to
  match article text.
- [Help that points at the screen](in-page-help-explain-mode.md) — an "explain this" mode that outlines
  the controls with help topics, and a guided tour on the same mechanism.

## Code health

- [Periodic code-health audits](code-health-audits.md) — duplicated code (next: the backend), docs
  checked against code (next: `architecture.md`), and work recomputed on every request at a cost that
  grows with the ledger (never run).
- [Small UI cleanups to batch](cleanup-pass.md) — the import card's rejected count, and button labels that
  flash for an instant.
- [Screens that refresh themselves when the data they show changes](query-cache-invalidation.md) —
  replaces a hand-written refresh list. Maybe never needed.
- [Lint on ESLint 10](eslint-10.md) — parked until eslint-plugin-react and eslint-plugin-jsx-a11y release
  support; one command checks.
