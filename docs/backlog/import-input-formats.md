# New file-import formats: QIF, XLSX and the OFX family

Not started. Three file formats, each a new front end on the existing parse seam: a front end produces a
`ParsedFile` and `run_import_parsed` does the rest. The CSV and PayPal statement imports are the two
existing front ends; [`../building-a-connector.md`](../building-a-connector.md) → *Adding a file
importer* covers the seam and the four CSV assumptions a new format has to answer.

Connections (Plaid, SimpleFIN) are a different track, also in `building-a-connector.md`.

## Which first

QIF has the most value: it is the way out of Quicken, so it lets someone bring their history. XLSX is the
cheapest, since nothing past the parse seam changes. QIF and OFX both need an account-mapping step for a
file holding several accounts, so whichever is built first builds it and the other reuses it.

## What every new front end owes

- **A zero-amount policy** registered under its source name in `services/source_capabilities.py`. There
  is no default, so a source without one fails on its first import.
- **Evidence roles** (`ParsedFile.evidence_roles`) for any captured column it cannot measure from the
  file, such as a memo on a short statement.
- **Currency.** A row in another currency is refused and listed with the rejected rows, as a CSV's
  currency column does. A format that states a currency carries it in the row's currency column, as the
  PayPal statement import does. One that states none is in the ledger's currency. If
  [`per-account-currency.md`](per-account-currency.md) ships first, the comparison is against the mapped
  account's currency instead.

## QIF (moving from Quicken)

QIF is the migration path out of Quicken, not a bank-download format: banks produce the OFX family, and
Quicken imports QFX but does not export it. QIF is the only Quicken export that keeps the structure: full
history for every account in one file, with categories, splits, transfers, memos, check numbers and
classes. Quicken for Windows exports it (File → Export → QIF); Quicken for Mac has dropped and restored QIF
export across versions, so a Mac user may only have CSV. Simplifi exports CSV only. A Quicken CSV already
goes through the CSV import, but splits come out flattened and transfers as unlinked rows on both sides.
The menu paths and per-version support are from memory; check them against current Quicken before
building.

**Not the data file.** The Windows `.QDF` is proprietary, can be password-protected and changes between
versions. The Mac `.quicken` package holds an SQLite database, but its schema is undocumented and
version-fragile, so a reader would break silently. QIF carries what matters at a fraction of the upkeep.

The fields are known, so this is a mapping-free front end shaped like the PayPal statement import
(`routers/import_export/paypal_statement.py`). The edges:

- **Several accounts per file.** `!Account` blocks precede each account's `!Type:` section; each needs
  mapping to a Luma account, the one new UX step.
- **Sign flip.** QIF `T` is negative for money out; Luma is `amount > 0 = money out`. Invert exactly.
- **Splits.** `S`/`E`/`$` lines map onto transaction splits (see
  [`../mechanism-index.md`](../mechanism-index.md)). Splits are feature-owned and no rule may author one,
  so whether an import may write them is a decision to settle first.
- **Transfers.** A category of `[Account Name]` marks a transfer, and Quicken writes it into both
  accounts' registers, so both legs arrive. Neither is a duplicate; they want a transfer category with
  `exclude_from_totals` rather than a `txn_link` (the mechanism index says why).
- **Dedupe.** No row id, so it stays on the duplicate ladder. A Quicken history overlaps whatever a
  connected account already synced, so the overlap is where this gets tested.
- **Currency.** QIF names none, so the whole file is in the ledger's currency.
- **Dates.** `M/D'YY` and locale-dependent orders are ambiguous; detect over the whole file, never per
  row.
- **Categories.** Quicken's `Parent:Child` names feed the imported-category workspace.
- **Investment accounts** use a different record type (`!Type:Invst`); leave them out of v1.

## XLSX

`.xlsx` only; legacy `.xls` is out of scope. A spreadsheet is tabular like CSV in a binary container, so
once parsed it becomes the same `(headers, rows)` and the mapping UI, account mapping, dedupe and
categorization apply unchanged. openpyxl is pure Python, so it stays cross-platform. Take the first sheet
for v1.

XLSX breaks all four CSV assumptions at once, and nothing past the seam changes:

- **Header detection** over cell rows, since exports carry preamble rows above the header as CSVs do.
- **Cells become strings** at the boundary. A float amount or a datetime cell is normalized before the
  amount and date parsers see it.
- **The content hash** is over the parsed rows, not the file bytes. Re-saving a workbook changes its
  bytes without changing its data.
- **No file viewer.** `lines` stays empty.

## OFX / QFX / QBO

OFX is a structured format with a defined schema (`<STMTTRN>`: `TRNTYPE` / `DTPOSTED` / `TRNAMT` /
`FITID` / `NAME` / `MEMO` / `CHECKNUM`; `<BANKACCTFROM>` with `BANKID` / `ACCTID`, or `<CCACCTFROM>`
with only `ACCTID` for a card). QFX and QBO are Intuit's branded variants, so OFX support covers roughly
all three. Mapping-free, like QIF.

- **Parser.** OFX 1.x is SGML (unclosed tags, not valid XML) and 2.x is XML, both behind a header block,
  so the parser has to be tolerant. `ofxtools` fits: pure Python, stdlib-only, maintained. `ofxparse` is
  largely unmaintained, and [libofx](https://github.com/libofx/libofx) is a C library with a per-platform
  build cost (see [`ofx-direct-connect.md`](ofx-direct-connect.md)).
- **Several accounts per file.** One download can hold several statements. Each needs mapping to a Luma
  account, the same step QIF needs; `BANKID` + `ACCTID` can pre-fill it.
- **Sign flip.** `TRNAMT` is negative for a debit; Luma is `amount > 0 = money out`. Invert exactly. This
  is the one silent-corruption edge in the format.
- **`FITID` is the row id.** It goes in `txn.source_transaction_id`, which already ranks above the rest of
  the duplicate ladder (`services/source_transaction_ids.py`), so dedupe needs no new rung. `FITID` is
  unique only within one bank account, while a source's ids are matched across the whole data source, so
  store it as `<ACCTID>:<FITID>`. Otherwise two accounts imported through one source can share an id and
  one row is dropped as already held.
- **Currency.** The statement's `CURDEF` is the default and a transaction's own `CURRENCY` overrides it.
  The row's currency column carries the result.
- Dates are OFX timestamps (`YYYYMMDDHHMMSS[.XXX][TZ]`). Categories are usually absent, so the
  imported-category workspace mostly does not apply.

**OFX Direct Connect** (pulling from a bank over the protocol) is a provider adapter, not a file format,
and is in [`ofx-direct-connect.md`](ofx-direct-connect.md). File support neither depends on it nor
advances it.
