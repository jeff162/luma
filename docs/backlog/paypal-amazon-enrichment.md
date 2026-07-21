# Import enrichment & Amazon import — deferred remainder

**The feature shipped.** What began (2026-07-04) as "special import support for PayPal/Amazon" resolved,
through several design passes, into three things that are now all live: **PayPal is an ordinary import**
(a wallet-style account CSV — columns map normally, transfers are categorized by the user's rules); the
one general new capability — **enrich an existing transaction with a later import's novel detail** — is
built; and **Amazon** took its own **account + link** design (the orders-only model, superseding the
earlier per-item itemization). The durable record now lives in the main docs — this file keeps only what
was **not** built.

Where the shipped design is documented:

- **Enrich-on-duplicate** (additive/gap-filling fold into `import_evidence`; manual per-row/bulk action;
  per-source `enrich_from_source` auto-enrich flag; batch-scoped "enrich from this source" toggle; undo via
  `import_batch_duplicate`) and **`display_name_source`** (the manual-rename guard it relies on) →
  `data-model.md`.
- **Evidence capture** (`column_map.evidence_columns`, the "capture extra detail" panel) and the
  **descriptive vs categorical role tag** that keeps categorical values out of the fuzzy duplicate matcher
  → `data-model.md`.
- **Amazon orders-only import** (one txn per order, the matched card charge excluded + linked), the general
  **`txn_link`** primitive, the **funding-source → account map**, and the **reconciliation** report →
  `data-model.md` → "Transaction links and Amazon order import" + `architecture.md` → "Amazon order import
  contract".
- **Wallet funding-leg suppression** (`kind='wallet_funding'`) and the PayPal **`Type`-rule money-movement**
  recognition → `data-model.md` (wallet funding-leg suppression section).
- **Import UI** (capture panel, the reconciliation / import-detail detached report viewers, marketplace
  routing) → `ui-patterns.md`.

## Deferred

- **AZAD ingestion ergonomics — skip the file (polish; the CSV path is fine).** AZAD renders its result as
  an on-screen table and both it and Luma run in the same browser, prompting "can we skip the file?" The
  realistic win is a **Luma paste/drag target** that reads the clipboard `text/html` (or tab-separated
  `text/plain`) selection from AZAD's plain-table view and parses it exactly like a CSV — no file (caveat:
  set AZAD "Show → all entries" so pagination doesn't truncate). Heavier options were rejected: a
  Luma-owned extension / AZAD fork that POSTs to the backend (best UX, but a new artifact coupling us to
  Amazon's DOM, against the swappable-front-end principle), and Luma driving a browser to log in and fetch
  (a web app can't read a cross-origin window, and a headless scrape reintroduces the bot wall / 2FA / ToS
  problems AZAD exists to avoid). There is no cross-origin "drag one window into another" — the "drag"
  variant is just HTML5 drag-drop of the same selection.
- **AZAD "preview features" gating** — open item: which item fields a plain (non-preview) AZAD install
  actually exports. Keep the ingestion loosely coupled to the extension (the `order url` column is an
  auth-gated per-account deep link — a UI click-through only, never a runtime data source).
- **Manual un-suppress of a wallet funding-leg pair.** The structural `wallet_funding` suppression is always
  on and deliberately high-precision, but there is no in-report action to *undo* a specific pairing the user
  disagrees with. (The related "DB-backed editable `Type` vocabulary with an add-this-type prompt" is
  effectively delivered by the user-approved PayPal `Type` rules — see
  `paypal-money-movement-recognition.md`; a manual per-pair un-suppress for the *structural* pairs is what
  remains.)
- **Enrich re-derive from stored raw values.** Capture happens at import time, so already-imported rows
  carry only what was captured then; picking up newly-selected evidence columns needs a re-import. A
  possible refinement: have enrich re-derive detail from a duplicate row's stored raw `values_json` using
  the *current* capture config, so a later capture-config change can enrich old rows without a re-import.
- **Column-centric mapping rework (skipped, may revisit).** The add-on "capture extra detail" panel splits
  the import screen into a mapped-fields table plus a separate capture panel. The alternative considered was
  flipping the mapping screen around: **one row per file column** with a per-column meaning dropdown (the
  field roles + **Ignore** + **Capture as detail**), keyword/shape defaults prefilled, scrollable for wide
  (20-column) files — surfacing *every* column up front in one unified control. It was skipped to keep scope
  down (it rewrites `ImportColumnMappingSection` / `ImportMappingFieldGrid` and touches amount-convention
  derivation and the account picker); the backend (`evidence_columns`, role classifier) is UI-shape-agnostic
  so it can drop in later. Open sub-questions if revisited: amount still needs an explicit pick among the
  numeric columns (PayPal has four — `Amount` / `Total` / `Fees` / `Balance`), so a column-first list must
  still special-case the required mapped fields; and how two-column debit/credit and the account column fold
  into a column-first layout.
