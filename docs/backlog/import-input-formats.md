# New file-import formats — XLSX, the OFX family and QIF

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

## The shared prerequisite — done

The parse seam is extracted: a front end produces a `ParsedFile` and `run_import_parsed` does the rest,
with the CSV front end (`parse_csv_text`) shared by the preview and the import. The PayPal monthly
statement import (2026-09-18) was the second front end, and it answered the four CSV assumptions the way
the two formats below will need — see [`../building-a-connector.md`](../building-a-connector.md) → *Adding
a file importer*. What remains for them is a front end each, and XLSX's header detection over cell rows.

## Tier 1 — XLS / XLSX

Spreadsheets are tabular like CSV in a binary container, so once parsed they become the same
`(headers, rows)` and the entire mapping UI, account mapping, dedupe and categorization apply unchanged.
The smallest, highest-ROI format and the natural first step. Pure-Python parsers (openpyxl for `.xlsx`,
xlrd for legacy `.xls`) keep it cross-platform; take the first sheet for v1.

The four edges that are the actual work — a format-agnostic content hash, header detection over cell
rows, cell→string normalization, and the raw-text preview panel having no analog — are the four CSV
assumptions named in [`../building-a-connector.md`](../building-a-connector.md) → *Adding a file
importer*. XLSX is the format that breaks all four at once, which is exactly why it is the cheap one to
do first: nothing past the seam changes.

## Tier 2 — OFX / QFX / QBO

OFX is a structured exchange format with a defined schema (`<STMTTRN>`: `TRNTYPE` / `DTPOSTED` /
`TRNAMT` / `FITID` / `NAME` / `MEMO` / `CHECKNUM`; `<BANKACCTFROM>` with `BANKID` / `ACCTID`). QFX and
QBO are Intuit's branded variants, so supporting OFX gets roughly all three. Because the fields are
known, this does **not** go through column mapping — it needs a mapping-free flow that maps OFX fields
to internal ones in code and then feeds the existing construction/dedupe/categorize stages, which is the
shape the PayPal statement import already has (`routers/import_export/paypal_statement.py`).
Bigger than tier 1: a new parser *plus* a new UX path *plus* a change to dedupe.

- **Parser.** OFX 1.x is SGML (unclosed tags, not valid XML) and 2.x is XML, both behind a header block,
  so the parser has to be tolerant. `ofxtools` is the fit — pure Python, stdlib-only, maintained.
  `ofxparse` is somewhat unmaintained, and [libofx](https://github.com/libofx/libofx) is a C library
  carrying the same per-platform build cost that ruled aqbanking out for the connection track (see
  [`ofx-direct-connect.md`](ofx-direct-connect.md)).
- **Sign flip.** OFX `TRNAMT` is signed negative = debit; Luma is `amount > 0 = money out`. Invert
  exactly — this is the one silent-corruption edge in the format.
- **`FITID` is a high-confidence dedupe key** — bank-assigned and unique per account, far stronger than
  the content-hash + heuristic ladder. Slotting it into `services/duplicate_detection.py` above the
  content-hash rung, scoped per account, is both the main design work and the main payoff.
- Dates are OFX timestamps (`YYYYMMDDHHMMSS[.XXX][TZ]`), and categories are usually absent, so the
  imported-category workspace mostly does not apply. Optionally pre-fill the account from
  `BANKID` + `ACCTID`.

## Tier 3 — QIF (moving from Quicken)

QIF is the migration path out of Quicken, not a bank-download format — the OFX family above is what
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

Like OFX, the fields are known, so this is a mapping-free front end in the shape of the PayPal statement
import. The edges:

- **Several accounts per file.** `!Account` blocks precede each account's `!Type:` section; each needs
  mapping to a Luma account, the one new UX step.
- **Sign flip.** QIF `T` is negative = money out; Luma is `amount > 0 = money out`. Invert exactly.
- **Splits.** `S`/`E`/`$` lines map onto transaction splits (see
  [`../mechanism-index.md`](../mechanism-index.md)). Splits are feature-owned and no rule may author
  one, so whether an import may write them is a decision to settle first, not assume.
- **Transfers.** A category of `[Account Name]` marks a transfer, and Quicken writes it into both
  accounts' registers, so both legs arrive. Neither is a duplicate; they want a transfer category with
  `exclude_from_totals` rather than a `txn_link` (the mechanism index covers why).
- **Dedupe.** No bank-assigned id like `FITID`, so it stays on the content-hash ladder. A Quicken history
  overlaps whatever a connected account already synced, so the overlap window is where this gets tested.
- **Dates.** `M/D'YY` and locale-dependent orders are ambiguous; detect over the whole file, never per
  row.
- **Categories.** Quicken's `Parent:Child` names feed the imported-category workspace, which applies
  here as it does not for OFX.
- **Investment accounts** use a different record type (`!Type:Invst`); leave them out of v1.

## Out of scope

**OFX *Direct Connect*** — pulling from a bank over the protocol rather than importing a file it
produced — is a provider adapter, not a file format, and is parked separately in
[`ofx-direct-connect.md`](ofx-direct-connect.md) on institution coverage and on the disclosure a bank
login owes the user. Supporting OFX *files* neither depends on it nor advances it.
