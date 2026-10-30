# Amazon, PayPal and import-mapping improvements

## What it is

Five independent improvements around Amazon order import, PayPal, and adding detail from one import to
transactions already in the ledger:

- **Paste Amazon orders instead of saving a file**: copy the order table from the AZAD browser extension
  and paste or drag it into Luma.
- **Find out what a plain AZAD install exports**, so the import does not depend on AZAD's preview
  features.
- **Undo one PayPal funding pairing** the user disagrees with.
- **Add newly chosen detail columns to old rows** without re-importing the file.
- **A simpler column-mapping screen**: one row per column in the file, each with a dropdown for what it
  means.

**Where it stands:** none started; all are polish, and each can be done on its own.

The built system is in `data-model.md` (enrich-on-duplicate, `display_name_source`, evidence capture and
roles, *Transaction links and Amazon order import*, wallet funding-leg suppression, *PayPal source
recognition*) and `architecture.md` → *Amazon order import contract*.

## AZAD ingestion without a file

Polish; the CSV path works. AZAD shows its result as an on-screen table in the same browser Luma runs in,
so a **paste or drag target** in Luma could read the clipboard's `text/html` (or tab-separated
`text/plain`) selection from AZAD's plain-table view and parse it exactly like the CSV. AZAD has to be set
to "Show → all entries" so paging does not truncate the selection. "Drag" here is ordinary HTML5
drag-and-drop of the same selection; there is no cross-origin window-to-window drag.

Ruled out:

- **A Luma browser extension or an AZAD fork that posts to the backend.** Best experience, but a new
  artifact tied to Amazon's page structure, against keeping the front end swappable.
- **Luma driving a browser to log in and fetch.** A web app cannot read a cross-origin window, and a
  headless scrape brings back the bot checks, 2FA and terms-of-service problems AZAD exists to avoid.

## AZAD "preview features" gating

Find out which item fields a plain (non-preview) AZAD install exports. Keep the ingestion loosely coupled
to the extension. The `order url` column is an authenticated per-account deep link: a click-through in
the UI only, never a runtime data source.

## Undoing one wallet funding-leg pairing

The structural `wallet_funding` suppression is always on and deliberately high-precision, but there is no
action in the report to undo one pairing the user disagrees with. The user-approved PayPal `Type` rules
already cover editing the vocabulary; this is only the per-pair undo for structural pairs.

## Re-deriving enrichment from stored raw values

Capture happens at import time, so already-imported rows carry only what was captured then, and picking
up newly selected evidence columns needs a re-import. Enrich could instead re-derive detail from a
duplicate row's stored raw `values_json` using the *current* capture config.

## A column-per-row mapping screen

The import screen has a mapped-fields table plus a separate "capture extra detail" panel. The alternative
is one row per file column with a meaning dropdown (the field roles, **Ignore**, **Capture as detail**),
defaults pre-filled from keywords and shape, scrollable for wide files. Every column is visible in one
control.

It rewrites `ImportColumnMappingSection` / `ImportMappingFieldGrid` and touches amount-convention
derivation and the account picker. The backend (`evidence_columns`, the role classifier) does not depend
on the screen's shape. Questions to settle:

- Amount still needs an explicit pick among the numeric columns (PayPal has four: `Amount`, `Total`,
  `Fees`, `Balance`), so a column-first list still special-cases the required fields.
- How two-column debit/credit and the account column fit a column-first layout.
