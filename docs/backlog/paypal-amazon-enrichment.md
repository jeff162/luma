# Enriching existing transactions on import — and why PayPal needs no special source

> **Status: active working design. Started 2026-07-04.** This began as "special import support for
> PayPal/Amazon" and, through several design passes, collapsed to something much smaller and more
> general. The record below is the *destination*, with a short history of what was explored and dropped
> so the reasoning isn't lost. The design of record: **PayPal is an ordinary import; the one genuinely
> new capability is a general feature — enrich an existing transaction with a later import's novel
> detail.** Amazon is deferred and, when it lands, is built on that same feature, not a bespoke pipeline.

## The core realization: PayPal is an account, not a special source

A PayPal Activity CSV is just a bank/card CSV for a wallet-style account. Each purchase is a spend on
the PayPal account (the counterparty is the merchant, straight from the `Name` column); each funding
leg is a transfer from a bank/card into it. That is exactly what a credit card is, with the funding
batched per-transaction instead of monthly. So the existing import already handles it:

- **Columns** map normally (`Name`→merchant, `Amount` with a sign convention, date, etc.).
- **Account** is picked or created on the import screen (a CSV with no account column is the existing
  single-account case — you pick/add the account it maps to).
- **Re-import overlap** is the existing duplicate detection (coverage window + content hash).
- **Save as a profile** for next time is the existing data-source mechanism.
- **One profile per PayPal account.** The earlier worry — "reuse one source across accounts" — dissolves:
  make a profile per account; if the user maps or categorizes them differently, we don't care.
- **Transfers** (the funding legs, and the `PAYPAL` charge that lands on the card) are categorized to an
  `exclude_from_totals` category the same way *every* transfer already is — by the user's own rules.

**We deliberately do not build:** money-movement auto-identification, a transaction-type/transfer model,
a `kind` system-source, an owner+account pairing screen, or a reconciliation report. The transfer/
transaction-type modeling was considered and rejected — it reopens a settled decision (`data-model.md`:
`exclude_from_totals` is a category property, formal two-sided transfer pairing is deferred) and surfaces
nothing about spending patterns. Money-movement identification was considered and dropped — the user
categorizes those rows with normal rules; a fuzzy auto-classifier isn't worth the special-casing.

**When *would* a special source have been worth it?** If the primary flow were aggregator users who need
silent enrich-and-merge at scale, or if a guided no-mapping experience were itself the product. Neither
is the case here, so: ordinary import.

## The one new capability: enrich an existing transaction on import (general)

Today a duplicate is only ever *rejected or flagged* — the incoming row's detail is discarded. But a
later import from a richer source often carries detail the stored row lacks (a memo, a cleaner merchant,
a counterparty). The feature: **when an import matches a transaction already in the ledger, fold the
*novel* part of the incoming detail into that row.** General — credit-card CSVs, PayPal, any source.

This is where the earlier "enrich on overlap" idea belongs: at the **dedup layer**, reusing what exists
(`import_evidence_json` + the Origin hover; the duplicate-resolution screen; the match `evaluate_duplicate`
already computes). It is *not* PayPal-specific.

**Design guardrails:**

- **Additive / gap-filling only.** Add novel detail to `import_evidence_json`; never overwrite a value
  already present, and never a `manual` name or category. This sidesteps any "which source is better"
  ranking — you only ever fill blanks — and makes `display_name_source` (below) the guard that protects a
  deliberate rename.
- **The delta is computed against what the row already holds** (its names + existing evidence), so
  nothing identical is re-copied. (This is the one reusable idea extracted from the reverted reconciler
  work: a `_enrichment_delta`-style merge.)
- **Lands in `import_evidence_json`** — the existing source-record surface; `match_source_text` rules can
  already categorize on it, the Origin hover already renders it.

**Two mechanisms, built in order:**

1. **Manual action on the duplicate-resolution screen** (`UnifiedDuplicatesDialog`): a per-row + bulk
   "Enrich stored transaction with this import's detail," reusing the existing bulk-edit pattern. The
   always-available, user-judged baseline; no new source semantics.
2. **A per-source flag** = automation of (1) for trusted sources. When set, that source's matched
   duplicates enrich **automatically during import, silently but reported** ("N transactions enriched" in
   the import result). The duplicate report stays available to review/undo/change anything. Wording is
   behavior-named to avoid confusion with "trust these categories" / dedup toggles:
   > ☐ **Enrich existing transactions from this source** — *When an import from this source matches a
   > transaction already in your ledger, add any extra detail it carries (memos, counterparty names) to
   > that transaction. Turn on for sources whose detail is richer than your other imports.*

**Reporting & undo:** extend the existing duplicate record (`import_batch_duplicate`) with an "enriched"
outcome + the applied delta — it shows in the report and reverses on undo. No new table.

## `display_name_source` — landed, and the guard this feature needs

The display-name analog of `category_source` (`manual | rule | import | enrichment`, NULL = legacy):
provenance for `display_name` so an automatic rename can be attributed, and — the point — a **manual
rename is protected**: rules and enrichment never overwrite `'manual'`. Threaded through every rename
writer (manual single/bulk, `rule_scalar_effects`, import/sync inserts), with `recategorize_all` now
sparing a manual name just as it already spares a manual category. Because `txn` stores no per-row
rule_id, a migration backfill re-derives provenance (currently-matching rule's `clean_name` == the name
→ `'rule'`; else name differs from `merchant_name`/`raw_name` → `'manual'`; else `'import'`). See
`data-model.md`. Migration 6. This is general and independent of everything above — and it is exactly the
manual-guard the enrich-on-duplicate feature relies on.

## Amazon — deferred, and genuinely enrichment (unlike PayPal)

Amazon is the opposite species: **a merchant, not an account.** There is no Amazon account to import onto
— its charges already hit your card as bare `AMAZON.COM` rows, and one order fans out into several card
charges (billed per shipment). The job is to attach item detail to those *existing* card rows: match a
parsed order-charge `(card last-4, date, amount)` to a card row and enrich it. That is precisely the
**enrich-on-duplicate feature above**, fed by an Amazon adapter (parse the AZAD order export → per-charge
detail) instead of a re-imported CSV. So Amazon, when scoped, is built *on* this feature — an adapter + a
match, not a bespoke reconciler.

Acquisition (unchanged): the open-source **AZAD** extension (`philipmulcahy/azad`, Apache-2.0) exports the
order CSV; we ingest the file. Keep it loosely coupled — the extension is a swappable front-end. Open
items for the Amazon pass: AZAD "preview features" gating (which item fields a plain install exports);
whether multi-item/partial orders warrant more than attaching items to one card row; Amazon's own
`payments` card record could map to an account, revisit then.

## What was explored and reverted (so the history isn't a mystery)

A full **reconciliation** approach was designed and largely built, then dropped as over-scoped for PayPal:
a headless two-axis reconciler (`p2p record × funding counterpart`), source adapters, a `kind` system-
source (schema + partial-unique singleton), an owner+account pairing step, and a persisted reconciliation
report. It was reverted in favor of the ordinary-import + general-enrich direction above. Two things
survived: **`display_name_source`** (general, kept) and the **delta-merge idea** (repurposed as the enrich
engine). The reconciler itself was PayPal-shaped and neither PayPal (an account) nor Amazon (enrich-only)
actually needs its create/transfer dispositions, so it was deleted rather than parked; Amazon's simpler
need is served by the enrich-on-duplicate feature. The reasoning that led here — "PayPal is an account,"
"Amazon is a merchant," "transfers are categorization" — is the durable part.

## Build plan

1. **Enrich-on-duplicate engine** (general, headless-testable) — **landed.** `services/import_enrichment.py`:
   `compute_enrichment_delta` (novel-only vs. the row's names + existing evidence), `enrich_transaction`
   (append the delta to `import_evidence_json.extra_text_fields` — additive, idempotent, so the existing
   Origin hover renders it with no frontend change) and `unenrich_transaction`, plus `enrich_duplicate_row`
   / `undo_duplicate_enrichment` recording the outcome on `import_batch_duplicate` (migration 7:
   `enriched_txn_id` / `enriched_delta_json` / `enriched_at`). It touches only `import_evidence` — no
   display_name/category/notes — so there is no manual value to protect at this stage. Covered by
   `test_import_enrichment.py`.
2. **Manual resolution-screen action** (per-row + bulk) on `UnifiedDuplicatesDialog` — an endpoint that
   calls the engine against the matched candidate, plus the UI action + undo. **Landed.**
3. **Per-source flag** + the silent-but-reported auto-enrich path in the import — **landed (2026-07-05).**
   A `csv_import_profile.enrich_from_source` opt-in (migration 8; default off), surfaced on both the live
   import screen and the saved-source editor and threaded through the run config + `config_snapshot`. In
   `run_import`, after the batch's hard-reject duplicates are persisted, `_enrich_duplicate_rows` (the
   shared helper now behind the manual endpoint too) folds each **unambiguous** hard-reject's novel detail
   into the row it matched — scope deliberately limited to hard-reject + single target (ambiguous and
   soft-flags are left for manual review); a non-empty delta is required, so a second source carrying the
   same detail is a no-op. The count rides back as `enriched_count` (import result + a completion notice)
   and the enriched rows show in the duplicate report with Undo. **Crucially**, because an enrichment
   mutates a row *outside* the batch, `reverse_batch_enrichments` runs in **both** `undo_batch` and the
   `replace_batch_id` re-import path *before* the duplicate records (which hold the deltas) are deleted —
   otherwise the change would be orphaned and un-reversible. Covered by `test_import_auto_enrich.py`.
4. **Amazon** (separate, later): an AZAD adapter feeding the same enrich path.

**Capture side — a user-picked "extra detail columns" selector (supersedes the keyword tweak).** The
engine can only fold in detail the import *captured*, and today extra evidence is auto-detected purely by
the `IMPORT_EVIDENCE_HEADER_KEYWORDS` heuristic — which misses columns like PayPal's `Item Title`
("Pats tix"). Rather than hard-code more keywords, let the user **explicitly pick which unmapped columns to
capture as evidence** on the import mapping screen. It's transparent, per-source, general, and it makes
"Pats tix" flow through the *general* mechanism (pick Item Title → captured → enriched onto duplicates).
Design points settled: **supplement, don't replace** the keyword auto-detect (keep zero-effort capture);
**honor an explicit pick over** the `MAX_IMPORT_EVIDENCE_TEXT_FIELDS` cap. Storage is a
`column_map.evidence_columns: [headers]` list on the profile — no schema change.

**Two kinds of capturable column, and the role tag that keeps them apart (settled).** "Interesting"
is not "varied free text." A capturable column is one of *two* shapes, and they must be treated
differently downstream:

- **Descriptive free-text** (PayPal `Item Title`: 9/9 distinct; `Name`: 16/28) — high distinct ratio,
  word-like. Decodes "what was this?" for a human *and* is safe for the fuzzy duplicate text-matcher
  (varied enough that an exact/near match is meaningful).
- **Categorical vocabulary** (PayPal `Type`: 10/58, heavily repeated — "Bank Deposit to PP Account" ×13,
  "General Withdrawal" ×13; `Status`, `Currency`) — low distinct count. Valuable for `match_source_text`
  rules, the Origin hover, and money-movement classification, but **toxic to the fuzzy matcher**: two
  unrelated deposits share the identical `Type` string → similarity 1.0 → a spurious duplicate. (This
  corrects an earlier note here that called extra columns "safe because the matcher takes the max
  similarity across fields." That argument only rules out false *negatives* from a low-scoring column;
  the real hazard is a false *positive* from a shared categorical value, which `max` does nothing to
  stop. It is also exactly why the original keyword list deliberately excluded type/status.)

So **capture stays a single user choice**, but the system tags each captured column's **role**
(`descriptive` vs `categorical`), inferred from sampled cardinality, and the **fuzzy duplicate
text-matcher consumes only `descriptive` fields** (`_collect_duplicate_match_texts` gates on role).
Categorical captures still feed the hover, rules, classification, and enrich. The user never has to reason
about matcher noise.

> **Backend landed (2026-07-05).** `column_map.evidence_columns` threads through the import;
> `_build_evidence_column_plan` is **authoritative when the list is provided** — the import UI seeds its
> capture checkboxes from the keyword auto-detect, so the list it sends is the user's resolved choice
> (including any keyword default they unchecked), captured exactly and uncapped; when the field is
> **absent (`None`)** — a saved profile with no capture config, or an API caller — the zero-effort
> keyword auto-detect still runs (capped). Each captured column is role-classified via
> `_classify_evidence_column_role` (cardinality: distinct ≤ 12, genuine repeats, distinct/nonempty ≤ 0.5
> → `categorical`, else `descriptive`) and stamped with its role (categorical only — descriptive stays
> unmarked for a lean shape, and the matcher reads missing-role as descriptive so legacy evidence is
> unchanged); `_collect_duplicate_match_texts` skips categorical; and enrich preserves the role so a
> transferred categorical value stays out of the matcher on its new row. Covered by
> `test_import_evidence_roles.py`.
>
> **UI landed: add-on capture panel** (2026-07-05) — `ImportEvidenceColumnsSection.jsx`, a "Capture extra
> detail" section below the field-centric mapping table on both surfaces (the live import page
> `ImportExport.jsx` and the saved-source editor `ImportProfilesManager.jsx`). It lists every *unmapped*
> column as a checkbox with its inferred shape; whatever is checked becomes `evidence_columns`
> (authoritative). Shape inference + defaults live in `importColumnInference.js`
> (`classifyEvidenceColumnShape`, `computeEvidenceColumnOptions`, `defaultEvidenceColumns`), mirroring the
> backend cardinality classifier. **Default-check policy (revised 2026-07-05 on live-import feedback):**
> a column is pre-checked when its header is a descriptive keyword, **or** its shape is **free text**,
> **or** it is an *informative categorical* — a real vocabulary, distinct-value count ≥
> `EVIDENCE_INFORMATIVE_CATEGORICAL_MIN_DISTINCT` (4). That last clause is the fix for the useful
> categorical: a PayPal `Type` (≈9 kinds of transaction) genuinely classifies each row and is worth
> capturing, whereas a near-constant categorical — `Currency` (1 value), `Status`/`TimeZone` (2) — carries
> almost no per-row information and stays **off by default** (distinct count is the signal). Identifier,
> number, date, and *time-of-day* columns are shown but off by default too. The panel shows the distinct
> count next to a categorical column so the user can see why it is/isn't pre-checked. **Ordering:** the
> panel lists columns **highest capture value first** (free text → informative categorical / keyword →
> low-value categorical → identifier → number → date → empty; `evidenceOptionSortRank`), so a useful
> sparse column like `Item Title` rises to the top instead of sitting wherever it falls in the file. The
> first pass
> pre-checked *all* categorical (junk suggestions: Time/TimeZone/Status/Currency) while missing the useful
> `Item Title`; two fixes brought it into line: (a) classify from the preview's **whole-file** per-column
> stats
> (`column_value_counts` + `column_distinct_meta.total_count`) rather than the 10-row sample, so a
> *sparse* descriptive column like `Item Title` (populated in a handful of rows, none in the first 10)
> is recognized instead of read as empty; (b) added time-of-day detection so a `Time` column reads as
> temporal, not free text. The descriptive-vs-categorical split still exists (backend uses it to gate the
> duplicate matcher), but the *default capture* decision is deliberately narrower than that split. The
> picks flow through `getColumnMap` → import + profile save + draft snapshot; a saved list
> restores the checkboxes, and editing a profile without a re-uploaded sample preserves (never clobbers)
> the saved picks. Covered by `importColumnInference.test.js`.
>
> **Deferred alternative — the column-centric mapping rework (skipped 2026-07-05, may revisit).** The
> other UI shape considered was flipping the mapping screen *around*: instead of a table of transaction
> fields each asking "which column?", present **one row per file column** with a per-column meaning
> dropdown (the existing field roles — date / amount / description / … — plus **Ignore** and **Capture as
> detail**), keyword/shape defaults prefilled and adjustable, already-captured columns marked, scrollable
> for wide (20-column) files. Its appeal: it satisfies "surface *every* column up front" in one unified
> list (the add-on panel splits it — mapped columns in the table, the rest in the panel) and unifies
> mapping + capture into one control. We chose the add-on panel this round to keep scope down (the rework
> rewrites `ImportColumnMappingSection` / `ImportMappingFieldGrid` and touches the amount-convention
> derivation and account-handling picker); the backend (`evidence_columns`, role classifier) is UI-shape-
> agnostic, so the rework can drop in later without backend changes. Open sub-questions if we revisit:
> amount still needs an explicit user pick among the numeric columns (PayPal has four — `Amount` / `Total`
> / `Fees` / `Balance`), so a column-first list must still special-case the required mapped fields; and
> how two-column debit/credit and the account column fold into a column-first layout.

**Smart prefill = classify each column's shape from sampled rows.** Numeric / date / empty /
identifier(near-unique, code-like) / free-text / categorical → a default meaning: numeric → an *amount
candidate* (never auto-picked — PayPal has four numeric columns, `Amount`/`Total`/`Fees`/`Balance`, and
`Amount` vs `Total` are indistinguishable by shape, so the user explicitly confirms the amount, suggested
by header); date → date; free-text **or** categorical → **capture** (with the role tag); identifier &
empty → ignore. This catches `Item Title` *and* `Type` with no keyword list. Keep the existing file-level
fingerprint → saved-profile match as a second, confirmable prefill layer.

**UI is open** (the main requirement: *surface every column in the file so the user can see them*, with
scrolling for wide files). Leading candidate is the column-centric rework: one row per file column, each
with a meaning selector (the existing field roles + `ignore` + `capture as detail`), keyword/shape-matched
defaults pre-filled and adjustable, and already-captured columns marked. A simpler multi-select of unmapped
columns with keyword-matched ones pre-checked is the fallback.

**Foundation for the parking lot.** Capturing `Type` as a *categorical* field is the substrate for the
money-movement work below — the funding-leg deposits flagged "no specific match" are precisely the rows
whose `Type` reads "Bank Deposit to PP Account" / "General Withdrawal". This capture design pre-pays for
recognizing/pairing/suppressing them later.

Note: capture happens at import time, so already-imported rows carry only what was captured then — either
re-import to pick up newly-selected columns, or (a possible refinement) have enrich re-derive detail from
the duplicate row's stored raw `values_json` using the current capture config.

**Parking lot (revisit after this project): PayPal funding-leg deposits flagged "no specific match."** A
PayPal purchase's funding leg (e.g. "Bank Deposit to PP Account", `+4130` raw → stored `−4130`) has no
counterparty and often no match in a ledger populated from another aggregator, so it surfaces as a
covered-range "no specific match" for review. The detection is arguably correct, but whether these
deposits should be handled more gracefully (recognized as transfers, paired, or suppressed) is worth a
look once the enrich work is done. (The report's sign/detail confusion around this case was fixed
separately in `UnifiedDuplicatesDialog`: stored amounts now render through `formatTransactionAmount`, and
the incoming cell hovers the full raw row.)

## Reuse map (don't reinvent)

- Match / duplicate identification → existing `duplicate_detection` (`evaluate_duplicate`); the enrich acts
  on the row it already matched.
- Detail storage → `import_evidence_json`; rule matching on it → existing `match_source_text`.
- Manual name protection → `display_name_source` (landed).
- Resolution/report UI → `UnifiedDuplicatesDialog` + the existing `import_batch_duplicate` record/undo.
- Transfers/exclusion → existing `exclude_from_totals` categorization + user rules (nothing new).
