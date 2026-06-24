# Import Source Fields — Surfacing & Reuse Plan

> **Status: living plan / roadmap, not system-of-record.** This describes work that is partly
> unbuilt. As phases land, fold the durable "what it is and why" into `data-model.md` /
> `ui-patterns.md` and trim this file to the still-pending parts.

## Goal

Make better use of the import-source detail we **already capture** — surface it where the user is
working, and let rules act on it — **without expanding what we capture**. We capture enough today;
the gap is that the information is buried (reachable only via the transaction detail panel's
Origin → Show more, or by hopping to the merchant spending report and clicking "show more").

Two concrete motivations:

1. **Match a rule on source text that isn't the visible merchant.** Example: every payment to
   "Riverstone" is categorized normally, but one row's *Original Statement* reads
   `RENEWAL MEMBERSHIP FEE` and should be categorized as Membership. Today rules only match the
   merchant/raw/display name (see "Rule matching today"), so there is no way to target that field.
2. **See the source detail without digging.** Hovering a merchant name should reveal the text we
   have for it (raw source text, source description, "Original Statement"-style extras, the source
   file) — and also still show the full name when the cell is truncated.

## What we capture today (the field inventory)

Two tiers — the distinction drives the registry design.

**First-class `txn` columns** (always present, returned by `GET /transactions`,
`backend/routers/transactions.py` `list_transactions`):

- `raw_name` — "Raw source text"
- `merchant_name` — imported merchant; `display_name` — visible/renamed merchant
- `imported_category` — the file's own category label
- `category_source` — `manual` / `import` / `rule` / `cleared` / NULL (provenance)
- `import_batch_filename`, `import_batch_imported_at` — the source file

**`import_evidence_json`** — a compact, capped JSON subset captured at import
(`backend/routers/import_export/core.py` `_build_import_evidence`,
`MAX_IMPORT_EVIDENCE_TEXT_FIELDS = 6`). Shape:

```json
{ "account":     { "header": "Account",          "value": "Delta SkyMiles® Gold Card (...7304)" },
  "description": { "header": "Description",       "value": "RIVERSTONE" },
  "extra_text_fields": [
    { "header": "Original Statement", "value": "RENEWAL MEMBERSHIP FEE" }
  ] }
```

- `account` / `description` are **normalized** slots (we know what they mean).
- `extra_text_fields` is a **source-specific bag**: headers come straight from that file, curated
  only to "descriptive free text" columns (memo/statement/narrative/reference/…); identifier and
  figure columns are deliberately excluded. See `data-model.md` (`import_evidence_json` note).

The capture is intentionally narrower than a full raw-row archive (a full archive would roughly
double per-transaction text footprint). **This plan does not change capture.**

## Rule matching today

`backend/services/categorizer.py` `categorize_transaction` builds one haystack:

```python
text = " ".join(filter(None, [display_name, merchant_name, raw_name])).lower()
# a rule matches when:  rule["keyword"].lower() in text
```

So the evidence text (`description`, `extra_text_fields`) is **not** searched. Matcher identity is
`keyword + owner + account + amount range + debit/credit`. The hot loop has a perf contract
(`backend/tests/test_categorizer_perf_contract.py`): rules are loaded once and matching is a plain
substring test, so anything added here must stay cheap per row.

## The unifying model: an import-source field registry

One declarative registry of the fields above, each entry resolving its value from **either** a
first-class column **or** a path into the evidence object, plus capability flags. It is
**dynamic-aware**: the `extra_text_fields` bag expands into rows whose label is the file's own
header, so source-specific columns (like "Original Statement") appear without being hardcoded.

```
field = {
  key,                 // stable id
  label,               // display label (for evidence extras, the file's header)
  scope,               // 'name' | 'text' | 'meta'  — which surfaces show it
  get(txn, evidence),  // value resolver (column or evidence path); null/absent → row omitted
}
```

One registry feeds all three features:

- **Hover/origin surfacing** (Phase 1) — render `name`+`text` scope rows.
- **Rule matching** (Phase 2) — the set of `text`-scope values is the extra haystack.
- **Selectable report columns** (Phase 3, maybe never) — offer registry fields as columns.

Heterogeneity (a field present in some sources only) is handled naturally: a resolver that returns
nothing just drops its row.

## Phases

### Phase 1 — surface it (read-only, low risk) — IN PROGRESS

No backend, no perf/footprint tradeoffs; the data is already in the transactions list payload.

1. `frontend/src/lib/importSourceFields.js` — the registry + `parseImportEvidence(txn)` and
   `getTxnOriginRows(txn)` returning the ordered, populated rows (including expanded
   `extra_text_fields`), each tagged with `scope`.
2. Refactor the Origin block in `frontend/src/components/TransactionDetail.jsx` to render from
   `getTxnOriginRows` instead of parsing evidence inline (DRY; one source of truth).
3. A shared origin **hover card** on `MerchantCell` (`frontend/src/components/TransactionRow.jsx`)
   — the shared merchant renderer used by every transaction table, so this lands the helper on the
   Transactions report **and** all detail-panel lists at once. The card's first line is the full
   visible merchant (covering the truncation case the native `title` handled), followed by the
   `name`/`text` rows and the source file. Built on the shared `<Tooltip>` (`ui.jsx`).

### Phase 2 — match on it (opt-in, touches the categorizer)

Let a rule match captured source text. Start simple before structured per-field matchers:

- A per-rule **opt-in flag** ("also match the original / source text") that extends the
  categorizer haystack to include the `text`-scope evidence values. Opt-in so existing keyword
  rules don't silently change what they match.
- **Existing rows:** `recategorize_all` / `preview_recategorize_count` / rule-apply read
  `import_evidence_json` and fold its text in. Respect the perf contract — prefer extracting the
  searchable text once (e.g. at load) over `json_extract`/`json.loads` per match in the hot loop.
- **New imports:** thread the evidence text into `categorize_transaction` at import time (the row's
  values are already in hand there).
- Open question to settle when we start: does this stay an "anywhere in source text" match, or do
  we eventually want structured `(field, op, value)` matchers? The registry supports either; the
  flag is the cheap first step. Structured matchers would also reopen matcher-identity rules.

### Phase 3 — show it as columns (maybe never)

User-selectable transaction-report columns drawn from the registry. Reuses `useColumnPreference`
and the pill-header table shell already in the app. Listed for completeness; not committed.

## Constraints / decisions on record

- **No new capture.** Work strictly with the fields inventoried above.
- **Perf contract** governs Phase 2's hot loop — keep per-row matching cheap.
- **Dynamic over rigid** for the evidence extras: present-or-absent per row is a feature, not a
  bug, given source heterogeneity.
- The registry is the single seam; features consume it rather than re-parsing evidence.
