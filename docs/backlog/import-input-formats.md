# Import / input formats

**Status: deferred, not started (migrated from `TODO.md` 2026-07-30).** New ingestion formats,
ranked. XLSX and OFX share a **parse-seam extraction** prerequisite; SimpleFIN is a separate
connection/sync track that parallels Plaid.

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

## SimpleFIN — connection/sync (NOT a file import)

**Context.** SimpleFIN is an open read-only **aggregation protocol** (SimpleFIN
Bridge), not a file format — so it parallels the existing **Plaid** integration
(`backend/routers/plaid.py` + `backend/routers/sync.py`), not the CSV parse
seam. Flow: a setup token → claim POST → an **access URL** with HTTP Basic creds
embedded → `GET {accessUrl}/accounts` → clean JSON (accounts + `transactions`:
`id`/`posted`(epoch)/`amount`(signed decimal)/`description`/`payee`/`memo`).
Strong philosophical fit for local-first/self-hosted: open, cheap, privacy-
friendly, no per-connection Plaid pricing.

**Why deferred.** It's a recurring-sync integration (connection-integration
sized), a distinct track from one-off file import, and Plaid itself isn't
exercised yet.

**Suggested approach when picked up.**

- Mirror the Plaid seams: a connect/claim flow; **credential storage** — the
  access URL is a secret, so encrypt via `services/crypto_service.py` and carry
  it in the **credentials** backup (not the regular backup), e.g. a
  `simplefin_connection` table; a sync path (≈ `sync.py::run_sync`) that pulls
  `/accounts` and feeds rows into the existing insert/dedupe/categorize
  pipeline; account linking.
- The per-transaction `id` is a **stable per-account dedupe key** (like `FITID`
  / `plaid_transaction_id`) — key off it.
- **Sign flip** (negative = money out → Luma positive) and **epoch
  timestamps**, same as OFX.
- Lighter than Plaid: no Link widget, no link-token endpoint, no paid SDK — two
  HTTP calls and JSON. Much of the account model, sync loop, credential crypto,
  and credentials backup is already proven by the Plaid path.

**The three seam gaps this actually pays for.** The provider seam built in security phases 6a/6b was
shaped around Plaid, so it assumes a Link-style OAuth provider that has an app-level credential and a
cursor API. SimpleFIN has none of the three, and neither does any other non-Plaid provider — so these
are the real cost of a second adapter, and they are generic work rather than SimpleFIN work.

1. **Connect is not Link.** `GET /plaid/link-token` → widget → `POST /plaid/exchange`
   (`backend/routers/plaid.py`) has no analog for a provider whose connect step is a form or a pasted
   setup token; that needs a parallel entry point on the adapter interface. Everything *downstream* of
   the exchange is already provider-agnostic — encrypt the credential, upsert the connection on its
   `(provider, external_id)` key, `upsert_connection_accounts`, `unmapped_count` — so that tail belongs
   factored out of `exchange_token` and shared between the two entry points rather than copied. A
   hand-copy here is exactly the drift `docs/agent-profile.md` warns about in deliberately-parallel
   surfaces.
2. **No cursor.** `run_sync` is written cursor-first and *skips* any connection whose adapter has no
   `fetch_transactions_sync` (`backend/routers/sync.py`). The natural fix is a **range-pull default on
   the base adapter**: call `fetch_transactions(start, end)` and shape the result into the same
   `{added, modified, removed, next_cursor, has_more, update_status}` return, so a non-cursor provider
   rides the existing loop untouched. It is safe because `_insert_added` is already idempotent on
   `external_transaction_id` — a re-pulled window advances pending rows or skips. Two catches: a routine
   sync then needs a **bounded look-back window** (there is no cursor to advance, so "all history" would
   be re-fetched every time), and `removed` is permanently empty — which must be stated on the method, so
   no later caller reads an empty list as "the provider confirmed nothing was deleted."
3. **A provider may have no app-level credential.** `resolve_app_config` returning `None` currently means
   a 409 `provider_not_configured` at connect and a skip at sync — correct for Plaid, wrong for a
   provider that has no app secret at all. The `provider_config` `(client_id, secret, env)` shape and the
   Sandbox/Production `EnvBadge` on the Connections card do not apply universally either; a provider
   without them needs the Configure action and the mode badge to be absent rather than empty.

**Ranking.** XLSX first (small, reuses everything). OFX family second (parser +
mapping-free flow + FITID dedupe). SimpleFIN is its own track, but arguably the
best fit if live bank connectivity matters more than ingesting one-off exports.
