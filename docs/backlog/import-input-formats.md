# New file-import formats — XLSX and the OFX family

**Deferred, not started.** SimpleFIN — the connection/sync track that shared this file — shipped
2026-08-07, and everything durable it taught is in
[`../building-a-connector.md`](../building-a-connector.md): the three seam gaps became declared adapter
capabilities (`connect_spec`, the range-pull default behind `has_cursor`/`routine_lookback_days`,
`requires_app_config`), request budgets and pacing have their own section there, and *The published
guide is not the contract* records the two facts only a real call produced. It is worth saying once here
why it was never a file-format item: SimpleFIN is an open read-only aggregation protocol, so it parallels
the Plaid adapter rather than the parse seam below — but a reader asking "how do I get data in" keeps
arriving at this file, so the pointer belongs here.

What remains is the two *file* formats, both unstarted, and the prerequisite they share.

## The shared prerequisite — extract the parse seam

The seam itself, the four CSV assumptions buried in it, and why extraction has to come *before* a second
format rather than alongside one are described in
[`../building-a-connector.md`](../building-a-connector.md) → *Adding a file importer*. That is the
durable half and it belongs there; what is deferred is the extraction.

The work: the parse is inlined and duplicated in `routers/import_export/preview.py::preview_csv` and
`core.py::run_import_core`, and the generalization is from "pass `text`, parse with csv inside" to
"parse at the boundary, pass rows in" behind a format dispatch. It gates both formats below.

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
known, this does **not** go through column mapping — it needs a branched, mapping-free flow that maps
OFX fields to internal ones in code and then feeds the existing construction/dedupe/categorize stages.
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

## Out of scope

**OFX *Direct Connect*** — pulling from a bank over the protocol rather than importing a file it
produced — is a provider adapter, not a file format, and is parked separately in
[`ofx-direct-connect.md`](ofx-direct-connect.md) on institution coverage and on the disclosure a bank
login owes the user. Supporting OFX *files* neither depends on it nor advances it.
