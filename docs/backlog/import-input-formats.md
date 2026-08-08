# Import / input formats

**Status: file formats deferred, not started (migrated from `TODO.md` 2026-07-30); SimpleFIN built
2026-08-07.** New ingestion formats, ranked. XLSX and OFX share a **parse-seam extraction**
prerequisite; SimpleFIN was a separate connection/sync track that parallels Plaid, and has shipped.

The import pipeline has a sharp **parse seam**: a format-specific stage
(`bytes → decode → _detect_header_row_index → csv.DictReader → headers:list +
rows:list[dict]`) feeds a fully format-agnostic downstream (account resolution,
`ColumnMap`, amount/date parsing, dedupe, categorization, batch/undo, the
imported-category workspace). The parse is currently inlined and **duplicated**
in `backend/routers/import_export/preview.py::preview_csv` and
`core.py::run_import_core`. Extracting it behind a format dispatch (so preview
and run agree) is the shared prerequisite for any new *file* format below.
SimpleFIN is a different animal — see its own entry.

## Tier 1 — XLS / XLSX spreadsheet import

**Context.** Spreadsheets are tabular like CSV — just a binary container — so
once parsed they become the same `(headers, rows)` and the **entire** mapping
UI, account mapping, dedupe, and categorization apply unchanged. This is the
smallest, highest-ROI new format and the natural first step.

**Why deferred.** Nobody has needed it yet, and it's gated on the parse-seam
extraction above (not hard, but real).

**Suggested approach when picked up.**

- Add a parser (openpyxl for `.xlsx`, xlrd for legacy `.xls`) → first sheet →
  `headers + list[dict]`, behind the extracted format dispatch.
- Generalize the seam from "pass `text`, parse with csv inside" to "parse at the
  boundary, pass rows in."
- Edges to handle: a **format-agnostic content hash** (replace
  `make_import_file_hash(text)`, which drives re-import continuity + profile
  matching); **header-row detection over cell rows** (the spreadsheet analog of
  `_detect_header_row_index`); **cell→string normalization** (Excel numbers are
  floats, dates are datetimes — the amount/date parsers expect strings); pick the
  first sheet for v1; the "raw text preview" panel has no spreadsheet analog.
- Pure-python deps keep it cross-platform (Windows/Pi).

## Tier 2 — OFX / QFX / QBO import

**Context.** OFX is a structured financial-exchange format with a defined schema
(`<STMTTRN>`: `TRNTYPE`/`DTPOSTED`/`TRNAMT`/`FITID`/`NAME`/`MEMO`/`CHECKNUM`;
`<BANKACCTFROM>` with `BANKID`/`ACCTID`). QFX and QBO are Intuit's branded OFX
variants — supporting OFX gets ~90% of all three. Because the fields are known,
this does **not** go through column mapping; it needs a branched, mapping-free
import flow that maps OFX fields → internal transaction fields in code, then
feeds the existing construction/dedupe/categorize stages.

**Why deferred.** Bigger than Tier 1: it spans a new parser **plus** a new UX
path **plus** the dedupe subsystem, and no one has asked yet.

**Suggested approach when picked up.**

- Tolerant parser: OFX 1.x is SGML (unclosed tags, not valid XML), 2.x is XML;
  all carry a header block. Candidates: `ofxtools` (pure Python, stdlib-only,
  actively maintained — the best fit for the cross-platform constraint below),
  `ofxparse` (somewhat unmaintained), [libofx](https://github.com/libofx/libofx)
  (a C library, so it carries the same per-platform build cost that ruled
  aqbanking out for the connection track — see
  [`ofx-direct-connect.md`](ofx-direct-connect.md)), or a small hand-rolled
  tolerant parser.
- **Sign flip:** OFX `TRNAMT` is signed with negative = debit; Luma is
  `amount > 0 = money out` — the opposite. Invert exactly.
- **`FITID` is a high-confidence dedupe key** — a bank-assigned, per-account
  unique transaction id, far more reliable than the content-hash + heuristic
  ladder. Slotting it into `backend/services/duplicate_detection.py` (above
  content-hash, per-account) is the main design work and the main payoff.
- Optional: auto-identify/pre-fill the account from `BANKID`+`ACCTID`.
- Dates are OFX timestamps (`YYYYMMDDHHMMSS[.XXX][TZ]`); categories are usually
  absent, so the imported-category workspace mostly doesn't apply.

## SimpleFIN — connection/sync — **BUILT 2026-08-07**

Shipped as the second provider adapter. The design and the protocol facts now live with the code
(`backend/services/providers/simplefin.py`) and in
[`security-and-deployment-model.md`](security-and-deployment-model.md) → phase 6c; this entry is kept
only for the part that is still useful to a *reader of this file*: why it was never a file-import item,
and what the three "seam gaps" listed here turned out to cost.

**It was never a file format.** SimpleFIN is an open read-only aggregation protocol (SimpleFIN Bridge), so
it parallels the Plaid integration, not the CSV parse seam above. That framing was right and is why it
sits in this document at all — a reader looking for "how do I get data in" will keep finding it here.

**The three seam gaps were the real cost, and they were generic.** As predicted, none of the work was
SimpleFIN-specific: connect-is-not-Link became a shared `establish_connection` plus a `connect_spec`
declaration; the missing cursor became a **range-pull default** on the base adapter; the missing
app-level credential became `requires_app_config`. Each is now a declared adapter capability rather than
a branch on provider name, which is what a third adapter inherits. Two things the prediction missed:

- **The range-pull default was necessary but not sufficient.** Presenting a window as one page is the easy
  half. The hard half was that a range-pull provider forces apart three questions a cursor provider lets
  you conflate — *more right now?*, *history complete?*, *resume later?* — plus a fourth, how far back the
  pull *actually* reached versus what it asked for. Collapsing any of them is a data-loss or
  false-coverage bug, not a cosmetic one.
- **A published request budget is a first-class constraint.** SimpleFIN allows ~24 requests/day and
  *disables the token* if exceeded, which the existing sync shape would have blown on the first click (a
  45-iteration poll loop, and a routine "Sync now" that requested full history). Bounding a routine pull
  and stopping the poll loop were the load-bearing fixes. Worth carrying forward as a question to ask of
  any future provider, since nothing in the seam would have surfaced it.
- **The live server contradicts the published guide, so trust the server.** Two facts only appeared on a
  real call: the recommended date-range width is **45 days**, not the 90 the developer guide states (a
  90-day request returns a deprecation notice warning it "may be capped" later), and the Bridge sits
  behind a **CDN that rejects unnamed HTTP clients** — urllib's default agent gets a bare
  `403 error code: 1010` with nothing in it to suggest the User-Agent is the cause. Both were invisible to
  a test suite that mocks the HTTP layer, which is the general lesson: an adapter's *transport* deserves
  at least one test that inspects what actually goes on the wire.

**Ranking (unchanged for what remains).** XLSX first (small, reuses everything). OFX family second
(parser + mapping-free flow + FITID dedupe). Both are still file-import work gated on the parse-seam
extraction above.
