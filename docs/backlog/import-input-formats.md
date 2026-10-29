# New file-import formats — QIF, XLSX and the OFX family

**Deferred, not started.** SimpleFIN — the connection/sync track that shared this file — shipped
2026-08-07, and everything durable it taught is in
[`../building-a-connector.md`](../building-a-connector.md): the three seam gaps became declared adapter
capabilities (`connect_spec`, the range-pull default behind `has_cursor`/`routine_lookback_days`,
`requires_app_config`), request budgets and pacing have their own section there, and *The published
guide is not the contract* records the two facts only a real call produced. It is worth saying once here
why it was never a file-format item: SimpleFIN is an open read-only aggregation protocol, so it parallels
the Plaid adapter rather than the parse seam below — but a reader asking "how do I get data in" keeps
arriving at this file, so the pointer belongs here.

What remains is three *file* formats, all unstarted, and the prerequisite they share.

## Which first

QIF has the most value. It is the way out of Quicken, so it is what lets someone move their history
into Luma. XLSX is the cheapest, since nothing past the parse seam changes. OFX and QIF both need an
account-mapping step for a file holding several accounts, so whichever of the two is built first builds
it and the other reuses it.

`.xlsx` only. Legacy `.xls` is out of scope.

## The shared prerequisite — done

The parse seam is extracted: a front end produces a `ParsedFile` and `run_import_parsed` does the rest,
with the CSV front end (`parse_csv_text`) shared by the preview and the import. The PayPal monthly
statement import (2026-09-18) was the second front end, and it answered the four CSV assumptions the way
the formats below will need — see [`../building-a-connector.md`](../building-a-connector.md) → *Adding
a file importer*. What remains for them is a front end each.

Every new front end also owes the same three things:

- **A zero-amount policy** registered under its source name in `services/source_capabilities.py`. There
  is no default, so a source without one fails on its first import.
- **Evidence roles** (`ParsedFile.evidence_roles`) for any captured column it can't measure from the
  file, such as a memo on a short statement.
- **Currency.** A row in another currency is refused and listed with the rejected rows, as a CSV's
  currency column does. A format that states a currency carries it in the row's currency column, as the
  PayPal statement import does. One that states none is in the ledger's currency. If
  [`per-account-currency.md`](per-account-currency.md) ships first, the comparison is against the mapped
  account's currency instead.

## QIF (moving from Quicken)

QIF is the migration path out of Quicken, not a bank-download format — the OFX family below is what
banks produce, and Quicken imports QFX but does not export it. QIF is the only Quicken export that keeps
the structure: full history for every account in one file, with categories, splits, transfers, memos,
check numbers and classes. Quicken for Windows exports it (File → Export → QIF); Quicken for Mac has
dropped and restored QIF export across versions, so a Mac user may only have CSV. Simplifi exports CSV
only. A Quicken CSV from a register or report already goes through the existing CSV import, but splits
come out flattened and transfers as unlinked rows on both sides. Menu paths and per-version support are
from memory and need checking against current Quicken before building.

**Not the data file.** The Windows `.QDF` / `.QDF-backup` is proprietary, can be password-protected, and
changes between versions; reverse-engineering efforts have mostly stalled. The Mac `.quicken` package
holds an SQLite database, so it can be read, but the schema is undocumented and version-fragile — a
reader that breaks silently. QIF carries what matters at a fraction of the upkeep.

The fields are known, so this is a mapping-free front end in the shape of the PayPal statement import
(`routers/import_export/paypal_statement.py`). The edges:

- **Several accounts per file.** `!Account` blocks precede each account's `!Type:` section; each needs
  mapping to a Luma account, the one new UX step.
- **Sign flip.** QIF `T` is negative = money out; Luma is `amount > 0 = money out`. Invert exactly.
- **Splits.** `S`/`E`/`$` lines map onto transaction splits (see
  [`../mechanism-index.md`](../mechanism-index.md)). Splits are feature-owned and no rule may author
  one, so whether an import may write them is a decision to settle first, not assume.
- **Transfers.** A category of `[Account Name]` marks a transfer, and Quicken writes it into both
  accounts' registers, so both legs arrive. Neither is a duplicate; they want a transfer category with
  `exclude_from_totals` rather than a `txn_link` (the mechanism index covers why).
- **Dedupe.** No row id, so it stays on the duplicate ladder. A Quicken history overlaps whatever a
  connected account already synced, so the overlap window is where this gets tested.
- **Currency.** QIF names none, so the whole file is in the ledger's currency.
- **Dates.** `M/D'YY` and locale-dependent orders are ambiguous; detect over the whole file, never per
  row.
- **Categories.** Quicken's `Parent:Child` names feed the imported-category workspace, which applies
  here as it does not for OFX.
- **Investment accounts** use a different record type (`!Type:Invst`); leave them out of v1.

## XLSX

Spreadsheets are tabular like CSV in a binary container, so once parsed they become the same
`(headers, rows)` and the entire mapping UI, account mapping, dedupe and categorization apply unchanged.
openpyxl is pure Python, so it stays cross-platform. Take the first sheet for v1.

The work is the four CSV assumptions named in [`../building-a-connector.md`](../building-a-connector.md)
→ *Adding a file importer*. XLSX breaks all four at once, and nothing past the seam changes:

- **Header detection** over cell rows, since exports carry preamble rows above the header just as CSVs
  do.
- **Cells become strings** at the boundary. A float amount or a datetime cell is normalized before the
  amount and date parsers see it.
- **The content hash** is over the parsed rows, not the file bytes. Re-saving a workbook changes its
  bytes without changing its data.
- **No file viewer.** `lines` stays empty.

## OFX / QFX / QBO

OFX is a structured exchange format with a defined schema (`<STMTTRN>`: `TRNTYPE` / `DTPOSTED` /
`TRNAMT` / `FITID` / `NAME` / `MEMO` / `CHECKNUM`; `<BANKACCTFROM>` with `BANKID` / `ACCTID`, or
`<CCACCTFROM>` with only `ACCTID` for a credit card). QFX and QBO are Intuit's branded variants, so
supporting OFX gets roughly all three. The fields are known, so this is a mapping-free front end like
QIF's.

- **Parser.** OFX 1.x is SGML (unclosed tags, not valid XML) and 2.x is XML, both behind a header block,
  so the parser has to be tolerant. `ofxtools` is the fit — pure Python, stdlib-only, maintained.
  `ofxparse` is somewhat unmaintained, and [libofx](https://github.com/libofx/libofx) is a C library
  carrying the same per-platform build cost that ruled aqbanking out for the connection track (see
  [`ofx-direct-connect.md`](ofx-direct-connect.md)).
- **Several accounts per file.** One download can hold several statements (checking and a card
  together). Each needs mapping to a Luma account, the same step QIF needs. `BANKID` + `ACCTID` can
  pre-fill it.
- **Sign flip.** OFX `TRNAMT` is signed negative = debit; Luma is `amount > 0 = money out`. Invert
  exactly — this is the one silent-corruption edge in the format.
- **`FITID` is the row id.** It goes in `txn.source_transaction_id`, which already ranks above the rest
  of the duplicate ladder (`services/source_transaction_ids.py`), so dedupe needs no new rung. `FITID` is
  unique only within one bank account, while a source's ids are matched across the whole data source,
  so store it as `<ACCTID>:<FITID>`. Otherwise two accounts imported through one source can share an id
  and one row is dropped as already held.
- **Currency.** The statement's `CURDEF` is the default, and a transaction's own `CURRENCY` overrides
  it. The row's currency column carries the result.
- Dates are OFX timestamps (`YYYYMMDDHHMMSS[.XXX][TZ]`), and categories are usually absent, so the
  imported-category workspace mostly does not apply.

## Out of scope

**OFX *Direct Connect*** — pulling from a bank over the protocol rather than importing a file it
produced — is a provider adapter, not a file format, and is parked separately in
[`ofx-direct-connect.md`](ofx-direct-connect.md) on institution coverage and on the disclosure a bank
login owes the user. Supporting OFX *files* neither depends on it nor advances it.
