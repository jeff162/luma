# Architecture

This document provides a compact technical overview of Luma.

For domain concepts such as ownership, categories, and rules, see `data-model.md`.

For UI interaction patterns and shared behavior, see `ui-patterns.md`.

## Contents

- [High-level shape](#high-level-shape)

- [Backend structure](#backend-structure)

- [Frontend structure](#frontend-structure)

- [Data flow](#data-flow)

- [Major subsystems](#major-subsystems)

- [Cross-platform approach](#cross-platform-approach)

- [Where to change things](#where-to-change-things)

- [Open](#open)

## High-level shape

Luma is a local-first web application with:

- a **FastAPI** backend in `backend/`

- a **React + Vite** frontend in `frontend/`

- **SQLite** as the persistent store

The browser talks only to the local backend API. Core application data and persistence are local; external network dependencies are limited to optional integrations such as Plaid and SimpleFIN Bridge.

**Three topologies, one origin in each.** The SPA and the API always share an origin, but what puts them there differs: the Vite dev server proxies `/api` in development, nginx does it in the Docker image, and the standalone build has the backend serve `frontend/dist` itself (`backend/spa.py`) so one process is a whole application. That third shape is what makes a packaged single-user build possible, and it is also why `CORS_ORIGINS` can default to empty — no shipped topology makes a cross-origin call at all.

Serving the bundle has one wrinkle worth stating, because the obvious implementation gets it wrong in a way that surfaces only as a confusing frontend error. Client routes such as `/transactions` are React Router inventions with no file behind them, so any path that does not resolve to a real file returns `index.html` — *except* under `/api`, which stays a JSON 404. Letting the fallback swallow unmatched API paths would hand `api.js` an HTML body where it parses a `detail`, turning every genuine 404 into a parse error.

## Backend structure

- **`backend/main.py`:** bootstrap, middleware, and router registration

- **`backend/db/database.py`:** SQLite connection handling, schema creation, and seed data

- **`backend/routers/`:** feature-oriented API endpoints

- **`backend/services/`:** shared backend logic such as categorization and crypto helpers

- **`backend/spa.py`:** serves the built frontend with the client-route fallback described above

- **`backend/desktop.py`:** the standalone entry point — starts the server on loopback, opens a browser at it, and reuses a running instance rather than starting a second one onto the same databases

The backend favors explicit SQL and feature-oriented router modules over a heavy ORM layer.

## Frontend structure

- **`frontend/src/App.jsx`:** app shell — navigation, bootstrap, and everything drawn around the page

- **`frontend/src/AppRoutes.jsx`:** the route table, which path renders which page. Separate from the
  shell because it is the app's navigation contract: on its own it can be mounted without the shell's
  bootstrap, auth and preference state, which is what makes the table testable. `lib/routeChunks.js`
  owns the lazy loaders it and the shell's idle prefetch share

- **`frontend/src/pages/`:** top-level screens such as Dashboard, Transactions, Rules, and Import

- **`frontend/src/components/`:** shared UI and interaction building blocks

- **`frontend/src/lib/api.js`:** central API wrapper used by the frontend

- **`frontend/src/lib/FilterContext.jsx`:** shared date/account/owner/group filtering state
- **`frontend/src/lib/filterParams.js`:** the one translation of that chip row into API parameters (the frontend half of the facet registry — see `data-model.md` → *One facet registry, both halves*)

- **`frontend/src/lib/AppSessionContext.jsx`:** shared bootstrap/session metadata such as the active preference subject and database instance id so pages can reuse shell-loaded auth state instead of re-fetching it

The frontend mixes page-specific screens with a small set of shared interaction surfaces:

- **`TransactionRow.jsx`:** shared transaction display/editing behavior

- **`detailShared.jsx`:** shared detail-panel shell, chart, and lazy-loading behavior

- **`components/ui.jsx`:** shared visual primitives for cards, buttons, floating panels, overlays, form control styling, and everyday confirm/notice/text-entry dialogs

- **`lib/uiInteractions.js`:** shared interaction hooks for dismissible layers, popups, escape handling, and transient text editing

- **`components/TransientTextInput.jsx`:** shared single-field transient edit control used when Enter/blur should commit and Escape should cancel back to the pre-edit value

There are shared primitives designed to create a uniform user experience. Unless a frontend interaction has special requirements, it should use the shared interaction primitives in `frontend/src/lib/uiInteractions.js` and `frontend/src/components/TransientTextInput.jsx` instead of a page-local version. Search boxes, filters, and other intentionally custom controls sometimes contain page-specific logic.

The concern behind this is interaction drift. Repeated popovers, inline editors, and dismissal rules are easy to make "almost the same" on each page, which creates both subtle bugs and a less coherent product feel over time.

- **Local-mode onboarding:** when auth is off and no identities exist yet, `App.jsx` opens a first-run welcome flow that creates the initial identity and then routes the user once to a chosen data-entry surface — import a CSV, connect a data provider, load the demo dataset, or skip into an empty app. Getting data in is the point of the flow; account owners, additional identities, and categorization setup are deferred to the normal app surfaces rather than collected up front. The chosen destination is a **one-time** navigation, deliberately distinct from the persisted startup-route preference (which stays at its default so later launches land on the dashboard, not back on import/accounts).

Keeping this in `App.jsx` makes it part of bootstrap rather than a repeatable workflow. The main need is to block the ordinary shell until an identity is selected to scope preferences cleanly, not to create a long-lived page in the app’s information architecture. The welcome flow guides the user toward their first import because that data is what activates the rest of the app; the supporting concepts are introduced where they become relevant (e.g. a post-import nudge about categories) instead of as onboarding prerequisites.

- **Demo data — built through the real pipeline:** the demo is constructed by generating CSV files and importing them via `run_import_core` (the import endpoint's reusable, in-process core), not by hand-inserting rows. So it has genuine batches, per-account coverage, dedupe results, and saved data sources — the file cards look exactly like real imports. It generates two sources with different header formats: one *with* a category column imported "using imported categories" (creates `Pet Care` under Unassigned, maps the rest onto starter leaves), and one *without* (rows categorized only by the rules it then seeds, or left uncategorized). One transaction is duplicated across the two files/accounts so the real post-import sweep flags it. `load_demo_data` passes its own `conn` to `run_import_core` so the whole build is one transaction.

- **Demo data — the worked examples** (`db/demo_examples.py`): anything *done to* a transaction rather
  than imported with it — a split, a receivable and its repayment, an attached receipt, a rule carrying
  an amount range — cannot come through a CSV, so it is layered on afterwards, through the same services
  the endpoints call. They are written as **examples rather than fixtures**: someone exploring the demo
  reads them to learn what a feature is for, so each is a recognizable situation and a feature with
  several distinct uses gets several (the reimbursements show a claim repaid weeks later, one settled the
  same afternoon, and one still half outstanding). The tests assert them **through the feature rather
  than by row count** — that all four recurring signal kinds fire, that both sorts of rule overlap are
  found, that a document's text really came out of it — because a dataset can carry the rows and still
  demonstrate nothing, which is the state it was in when every one of those counts was zero.

- **Demo data — mode + safe teardown:** loading the demo set writes a marker (`demo_data` in the data DB's `import_workflow_state`). While it is present the app shows a global "demo data" strip in the shell and the backend **blocks new-data operations** with a 409 — CSV import, the Amazon import, data-source connect, **both** restores (data and credentials), and sync. That block is the safety mechanism: because nothing non-demo can be added, *all* data is demo data, so "clear demo data" can wipe the whole tenant data DB. **The set has to be complete for that reasoning to hold**, which is what makes the credentials restore belong in it despite carrying no ledger rows: it inserts `connection` rows, and a linked connection is exactly what `is_demo_loadable` counts as disqualifying, so an ungated one is a route to a demo tenant that owns a live data source — whose synced rows the clear would then erase as though they were demo data. Sync is gated for the same reason a step behind: with the restore closed nothing can reach it with the marker set, so it is the backstop for that argument rather than a live case. A new path that brings data in and skips this gate is a way to lose real data to the demo clear. The UI mirrors the gate from one copy of the status: the shell fetches it once per tenant and shares it as `demoLoaded` in the app session, and each of those controls disables itself from that (loading and clearing both reload the app, so nothing re-fetches it). The clear endpoint (`POST /auth/demo-data/clear`) **refuses unless the marker is present**, so it can never run against real data (which never carries the marker); it reuses the same `_wipe_user_data_tables` helper restore uses (one wipe order, FK checks deferred), then re-seeds the group skeleton, returning the tenant to the clean first-run state. The wipe is scoped to the tenant data DB — local profiles and credentials are untouched. This is the one user-facing destructive reset; the developer reset tools below remain separate, lower-level, and layer-specific.

## Data flow

Typical request flow:

1. A page reads global filters from `FilterContext`

2. The page calls `api.js`

3. FastAPI router executes SQL against SQLite

4. JSON response returns to the page

5. Local state updates, often optimistically for inline edits

For many inline edits, the UI updates first and the API call is fire-and-forget. This keeps interaction responsive and is acceptable because the backend remains the durable source of truth and the expected level of concurrent editing is low.

This is a deliberate tradeoff toward local responsiveness. Luma is optimized for a mostly single-user, local-first workflow, so a small amount of optimistic UI is preferable to making everyday edits feel remote or form-heavy.

## Major subsystems

### Transactions and summaries

- **Backend:** `backend/routers/transactions.py`

- **Handles:** transaction lists, category overrides, merchant name edits, and summary queries for dashboard and detail panels
- **Uncategorized contract:** transactions with `category_id = NULL` stay as one stored state, while shared summaries and tree surfaces may expose separate synthetic expense and income buckets so uncategorized credits do not masquerade as expense activity

- **A write that changes a row's category answers with the row's resolved tags.** `PATCH /transactions/{id}/category`, `PATCH /transactions/{id}/uncategorize` and `PATCH /transactions/{id}/imported-category` all return `{ok, tags, blocked_tags}` (`_resolved_tags_response`), matching what `PATCH /transactions/{id}/tags` already returned. The reason is that clients patch the edited row **in place** rather than refetching it (see the in-place reconcile rule in `docs/ui-patterns.md`), and tags are *inherited* from the leaf category and its group — so the category write changes them, but only the server can say to what, since resolution also spans the effective account and the row's own blocks. An `{"ok": true}` answer left the row wearing the previous category's inherited tags until something unrelated refetched it. Any future endpoint that moves a transaction between categories owes the same response.

- **Signed monthly totals:** `/summary/monthly-trend` returns signed sums (no `ABS()`), so refunds in an expense scope render as negative bars instead of being folded into magnitudes. A `view` query parameter (`spending` | `income` | `cash_flow`) chooses the cross-cutting frame when no category/payee scope is given; for a category scope, the sign is auto-flipped for income-type categories so received income reads as positive. The cross-cutting frames also exclude categories marked `exclude_from_totals` so transfers do not pollute dashboard totals.

- **Day-precise range totals:** `/summary/range-trend` is `monthly-trend`'s population and sign (one shared scope builder) totalled over caller-supplied inclusive date ranges instead of calendar months — one row per range in the order asked, a zero row for a range nothing fell in, a transaction counted in every range holding it, at most `RANGE_TREND_MAX_RANGES` per call. It exists for the single-period trend's same-span mode (`ui-patterns.md` → *The single-period trend*), where a bar must equal what selecting its range shows and a range that does not start and end on month boundaries cannot be rebuilt from monthly rows. Over a range that *is* a calendar month it returns that month's `monthly-trend` figure in every frame, and the tests hold it to that.

- **Cash-flow monthly split:** `/summary/monthly-cash-flow` returns `inflow`, `outflow` and `net` per month over the same population as `monthly-trend`'s `cash_flow` view. Its atom is a *leaf category's net for the month* rather than a transaction's sign: the categories that net money in make up `inflow` and those that net money out make up `outflow`, so a refund inside an expense category reduces that month's outflow instead of appearing as income. That is the same rule the single-period Sankey needs to decide a node's side (no link can have a negative width), which is what makes a month's bars equal the sides of that month's diagram, and `net` equals `monthly-trend`'s `cash_flow` total for the same filters. `granularity=year` returns the same split per calendar year (a `year` key in place of `month`), netting each category over the *whole* year — summing a year's monthly rows instead would put a category that went out one month and came back the next on both sides, overstating that year's diagram while the net still agreed. It returns no `count`: an accurate one is `COUNT(DISTINCT t.id)` per month, which cannot be recovered by summing per-bucket counts because the split-expansion seam puts one transaction in several buckets, and reading the source twice to get it is the cost that seam is shaped to avoid.

- **Tag-scoped transaction filtering:** the `/transactions` list endpoint accepts the same `view` (`spending` | `income` | `cash_flow`) for dashboard-style scoping — `cash_flow` applies no category-type clause but still drops `exclude_from_totals` categories, so a drill from a cash-flow node lists exactly the rows its figure came from. The `tag_ids` filter matches a transaction through any of three paths — direct (`txn_tag`), inherited from leaf category (`category_tag`), or inherited from parent group (`category_tag`) — so tag-aware reporting picks up tags applied at the most natural level.
- **Bulk edit:** `POST /transactions/bulk` applies one or more field changes to a selection. The selection is either an explicit id list or `{mode:'filter', filter, exclude_ids}` — filter mode resolves the target rows server-side from the **same** WHERE the list feed uses (both go through the shared `_build_transaction_filter` helper), so "select all matching" covers rows the client never loaded. Actions (`set_category` — leaf-only, reuses the per-row guard; `add_tags`/`remove_tags`; `set_notes`; `set_merchant`; `set_date`; `mark_reviewed` — clears the `needs_review` flag; `trash`) are applied in one transaction. Delete is soft-delete to the existing transaction trash, not a separate state. `set_date` is bulk-only (no per-row date endpoint exists).

  **A filter key the endpoint does not recognize is rejected (400), never dropped.** `_BULK_FILTER_KEYS` is the allowlist and `_bulk_filter_params` enforces it; `include_trashed` and `ids` are refused by name rather than reported as unknown. Silently stripping is the tempting default and it is never conservative: every filter here *narrows*, so a dropped key **widens** the set the actions run against, and the client's count (from the list feed, which did honor the key) no longer describes what the server will touch. This is not hypothetical — `needs_review` was missing from the allowlist, and "mark the 28 rows needing review" resolved to the whole ledger. The facet half of the allowlist is therefore **derived** from `FACET_PARAM_NAMES` rather than restated, so a new facet reaches bulk on its own; only the non-facet filters still have to be named by hand, and those are the ones to remember.
- **Used by:** Transactions page and dashboard/detail drill-down surfaces

#### The shared date filter and its back-step

`FilterContext` owns the cross-app period. It keeps a bounded history of prior values (`goBackDate`, `previousDate`, `canGoBackDate`) because the period is not only chosen from the FilterBar: clicking a bar on the Dashboard trend re-pins it, which is a navigation the user did not necessarily read as one, and the chip afterwards shows where they are rather than where they were. **Only those chart pins record** — `pinDateFromChart` is a setter of its own for exactly that reason, and plain `setDate`/`clearDate` **reset** the history instead of extending it. Recording every date change reads as the more general rule but is the wrong one: a FilterBar pick is a deliberate choice the user can already see in the chip, so a step back over it lands on a period two changes old that was never asked for. Resetting also keeps the back-step honest about what it undoes — a chain of bar clicks, nothing else. A re-pick of the period already in force moves nothing, so it neither records nor resets (every setter builds a fresh object, and identity comparison would otherwise fill the history with no-ops). Back restores only the date — a page's own drill state resets on a date change anyway, and restoring both would make one control mean two things. `describeDateFilter` names a value for UI that has to say where a control leads, and distinguishes the three shapes that mean different things: `null` (unset, falls back to a page's registered default), the truthy `{start:null,end:null}` sentinel (explicit all-time, overrides that default), and a real range.

### Rules and categorization

- **Storage:** `category_rule`

- **Runtime:** categorizer service

- **Behavior:** rules are ordered automatically by specificity; rules can assign categories, scope amount rules to debits or credits, rename merchants, and add transaction tags; manually overridden transaction categories are preserved, while per-transaction tag edits override only that row's rule-derived tag presence

- **Shared filter facets:** every axis the FilterBar exposes — account, group, category, owner, payee, tag, and **attribute** — is declared once in `services/transaction_facets.py` and consumed by all nine faceted endpoints through a `TransactionFacets` dependency plus a single `append_facets`. Facets AND with each other; values within one facet OR. See `data-model.md` → *One facet registry, both halves* and *Attributes — filtering by what a row is* for the rationale and the invariants.

- **Scope by account type:** besides a single owner/account, a rule can scope by account **type** (`category_rule.account_type`, e.g. `paypal`/`amazon`) — matching every account of that type via the row's *effective* account type (`COALESCE(parent.type, account.type)`, threaded into every SELECT that feeds `rule_matches_row`/`categorize_transaction`). Precedence is account_id > account_type > global, and account_type joins the one-rule-per-matcher identity. This is the primitive the PayPal money-movement rules use (one `account_type='paypal'` rule per `Type`, created via the shared `create_rule_core`); see `data-model.md` → Accounts/Rules. Generalizing the same axis to filtering and search is unbuilt — see `data-model.md` → Open

- **Applying a match (shared, per action):** every path that runs rules — CSV import, Plaid sync, and `recategorize_all` (plus its preview count) — matches once via `categorize_transaction`, then applies the result through shared apply points rather than re-deriving it each place: tags via `sync_rule_tags_for_transaction`, and the scalar actions (the merchant rename today, a rule-set note tomorrow) via `rule_scalar_effects`. Category *source* policy stays site-specific (import has mapping/file-label fallbacks; recategorize preserves a `cleared` marker). Keeping each action in one place is what stops sites drifting — the CSV import path had silently dropped the rename before this was centralized — and makes a new scalar rule action a one-place change. `recategorize_all` is also **retain-by-default** — it sets/changes a category or rule-tag but never strips one, so deleting or narrowing a rule doesn't silently un-categorize its history; clearing a no-match row (**reconcile**) is an opt-in `txn_ids`-scoped pass invoked only by the rule delete/edit "re-evaluate this rule's transactions" control and the money-movement "remove a type" path (see `data-model.md` → "How an existing transaction's category can change")

- **Starter set (opt-in):** the built-in categories and rules are not seeded at tenant creation — only the group skeleton is. The starter leaves and rules are added on demand via `POST /categories/generate-starter` (`GET /categories/starter-rules` exposes the rule catalog for the approve-before-add picker), which backs the onboarding steps, the Categories/Rules-page actions, and the demo loader. See `data-model.md` (Categories → seeding model, Rules → how rules come into being) for the rationale.

### Transaction tags

- **Storage:** `tag`, `rule_tag`, `txn_tag`, `category_tag`

- **Runtime:** shared transaction-tag service plus shared row UI; the picker (`components/TagPickerWithCreate.jsx`) is the one surface for browsing and creating tags, used from transaction rows and from the Categories right panel

- **Behavior:** tags are lightweight labels separate from categories. A transaction's effective tags are the additive union of direct tags (rule + manual via `txn_tag`), tags on its leaf category, tags on the leaf category's parent group (both via `category_tag`), and tags on its **effective (top-level) account** via `account_tag` (`COALESCE(parent_account_id, account_id)`, so a parent's tags reach its children while a merged child's own tags stay dormant until detached). Rules contribute a union of tag assignments across all matching rules, and transactions keep a per-tag manual override state (`txn_tag.manual_state`: `+1` force-on, `0` neutral, `-1` block). The `-1` **block** is universal: it suppresses a tag on that transaction whatever the source, so unchecking an *inherited* tag in a transaction's picker hides it there without retagging the category/account. Both the live-tag computation (`services/transaction_tags.py` — which applies blocks after merging the four sources, and exposes the hidden ones via `get_blocked_transaction_tag_map`) and the `tag_ids` filter (`tag_filter_membership_sql`, reached through the facet registry, which unions the effective tag ids and excludes per-tag blocks) are single shared chokepoints, so all four sources — and blocks — reach list and reporting uniformly

- **Reporting:** the dashboard's "Spending by …" picker offers built-in `group` / `category` partitions plus user-saved tag reports built on the multi-tag breakdown; combination wedges represent transactions matching multiple selected tags, and an `Other / Untagged` wedge holds the remainder

### Attached documents

- **Storage:** `document` (rows) + files under `documents/` beside the data database + `document_fts` (search index)

- **Backend:** `backend/services/documents.py` (the store: ingest normalization, atomic writes, extraction, reconciliation) + `backend/routers/documents.py` (the API over it)

- **Behavior:** a receipt or invoice attached to a transaction, answering *what was bought* — the thing a ledger row never records. A document can also be **stored** before its transaction exists (`txn_id` NULL) and attached later, which moves no file. One format-agnostic ingestion seam: file drop, file picker, clipboard paste (image, text, or the rich `text/html` flavour that keeps an emailed receipt's table intact) and a saved `.eml` all arrive as the same multipart upload of *(bytes, media type, filename)*, so a new way of choosing a file never reaches the backend. An email is converted to the document it carries at ingest, so nothing past that point knows the format exists. The media type is decided from the file's own header rather than from what the upload claimed. Oversized images are downscaled once at ingest; PDFs pass through byte-for-byte, because their text layer is what makes them worth preferring. Several documents may hang off one transaction, and an identical file re-attached to the same transaction is reported as already there rather than stored twice (the ingest digest is what makes that answerable)

- **The bytes are files, not rows, and that shapes everything around them.** File and row cannot be one transaction, so the ordering is the contract — file first on the way in, row first on the way out — and removal is *derived*: every destructive path deletes rows and then sweeps files the ledger no longer references. `data-model.md` → *Attached documents* carries the invariants and why each is the way it is

- **Serving is the one endpoint that returns bytes a user supplied**, so it sends the media type recorded at ingest (never one derived from the request), `X-Content-Type-Options: nosniff`, and a sandbox CSP — a PDF viewer is a scripting host, and a stored document has no business running script against this origin

- **Search:** text held on a document (a PDF's extracted layer, or pasted text verbatim) is indexed in `document_fts` and reached from the Transactions search box — from the plain box, with `doc:<terms>` to narrow to documents only. A row matched inside an attachment carries `matched_document` so the ledger can show *why* it came back, which is what makes the plain-box behaviour readable — see `data-model.md`

- **Used by:** the transaction detail panel (attach, view, rename, move to the stored documents, delete, and attach a stored one) and the ledger row's document marker, which opens the viewer directly. The stored documents are managed from a dialog on the Transactions page, which adds, renames and deletes them but never attaches — that happens from the transaction. The list feed carries slim document rows (`documents` — id, filename, media type, no extracted text) plus `document_count`, so the marker opens without a fetch

### Multi-payment purchases

- **Storage:** `txn_link` / `txn_link_member` with `kind='purchase'` — the general association primitive, unchanged and with no schema of its own

- **Backend:** `backend/services/purchase_links.py` (the invariants and the summaries) + `backend/routers/purchases.py` (the API over them), plus one transaction-scoped read on the transactions router and a per-page projection into the list feed

- **Behavior:** several transactions that are one purchase — a deposit and a balance, an instalment plan — grouped so the purchase has a total, each payment has an ordinal, and an expected total (from the invoice) has somewhere to sit. The defining property is what it does *not* do: unlike the primitive's other two clients, which recategorize a leg to stop the same money counting twice, this one mutates nothing, so **no reporting surface knows it exists** and a grouped payment reports exactly as it did before. `data-model.md` → *Multi-payment purchases* carries the invariants and the reasons

- **Lifecycle:** a purchase is created from the ledger's bulk selection and edited or ungrouped from the transaction detail panel. It cannot outlive its payments — `trg_purchase_link_prune` drops the link when its last member row goes, which is a trigger rather than a call at each of the five hard-delete sites for the reason the recon-epoch triggers give

- **Used by:** the Transactions ledger (the `🔗` row marker and the "Link as one purchase" bulk action) and the transaction detail panel's purchase summary, which renders nothing for a transaction that is not grouped. Both open the same `PurchaseEditorDialog`, so editing a purchase has one implementation regardless of where it was noticed. The list feed carries a per-row summary (`purchase` — label, ordinal, counts, totals) rather than the sibling payments; the dialog loads the full record when it opens, which is what keeps the per-row cost to one summary

### Recurring series

- **Backend:** `backend/services/recurring_detection.py` (detection) + `backend/services/transfer_pairs.py`
  (pairing the two rows one money movement leaves behind) + `backend/routers/recurring.py` (API)

- **Frontend:** `frontend/src/pages/Recurring.jsx` (route `/recurring`, nav "Recurring")

- **Storage:** `recurring_series` (+ `rule_id` for rule-backed series) + the `txn.recurring_series_id`
  membership link + `recurring_membership_override` (per-transaction pin/exclude corrections) +
  `recurring_signal_dismissal` (the only durable state the anomaly signals have)

- **Handles:** detection of recurring obligations (subscriptions, bills, taxes) and their curation. A
  **scan** is idempotent — it rewrites auto-detected+unconfirmed series while preserving the user's
  confirmed, manual, and suppressed ones (see `data-model.md` → Recurring series for the detection key,
  the timing-over-frequency scoring, and the curation gates). The scan runs both **on demand**
  (`POST /recurring/scan` from the page) and **automatically**, at two scopes:
  - **Scoped** (`scan_imported_payees`) — the ingest paths (a completed CSV import or Plaid sync)
    reprocess only the payees the batch touched, so a freshly imported/synced charge is matched (and a
    new series among those payees detected) immediately, without re-scanning the whole ledger. Correct
    because detection groups by payee and `reconcile_series` never disturbs out-of-scope rows; a scoped
    pass deliberately does **not** stamp the watermark (it can't see cross-payee/normalization effects).
  - **Full catch-up** (`POST /recurring/auto-scan`, gated by a `db_meta` watermark) — app load runs a
    global scan only when one is due: never scanned (a fresh or migrated pre-recurring database) or stale
    (older than the daily interval). This is the safety net for what a scoped pass can't see, and the
    home of the payee-key re-derivation repair.

  **A money movement between two tracked accounts is one series that owns both its legs.** The ledger
  records the movement once per account, so a payee reading of those rows produces two series whose
  descriptors then drift apart independently. `scan_and_store` therefore runs a **transfer pass first**:
  `transfer_pairs.pair_money_movements` pairs the rows structurally (same amount and category, opposite
  directions, different accounts, within a few days), `detect_transfer_series` scores the rhythm over the
  *pairs*, and the resulting series claims both legs. **Every** paired row is withheld from the payee
  pass, not only those a series claimed: a pair with no rhythm is still a pair, so its legs are not
  merchant activity either, and reading them as one is what produced per-account fragments for a card
  paid at irregular intervals. It runs over the full pool even on a scoped scan, the same
  exception rule-backed series get. Its rows are handed to `reconcile_series` as `reserved`, so a payee
  series that already held them — confirmed or not — gives them up: that reading is the movement read off
  two descriptions that drift, and nothing is deleted to correct it, since membership is exclusive and a
  series covering charges outside the movement keeps them. The one claim it yields to is a rule-backed
  series (`_rule_backed_holdings`), whose membership the user wrote. The single thing it refuses is a
  pairing *tie*, which is reported rather than guessed (`GET /recurring/transfer-review`). See
  `data-model.md` → Recurring series and `ui-patterns.md`.

  **Duplicate detection has the same shape with a different trigger.** `POST /accounts/duplicate-rescan`
  runs on app load beside the recurring catch-up, but is gated on `DUPLICATE_DETECTION_VERSION` rather
  than a time watermark: the thing that goes stale is not the data but the *rules*, so the question is
  "were these rows last examined by an older matcher" rather than "how long since a scan". It re-scans
  every account once per bump and skips pairs the user has already judged. See `data-model.md` →
  duplicate detection.

  The scan is one function (`scan_and_store`) with an optional `payee_keys` scope; scoped and full share
  the whole pipeline. A third caller uses the scoped path: `rescan_edited_transactions`, wired into the
  transaction edit endpoints **and the rule apply/reconcile paths** so any write of a category
  re-evaluates the payees it touched — membership is a cache, and without it a recategorized row stays
  linked to the series it has left. Bulk edits and bulk rule cleanups scan once for the batch, never per
  row. A scoped scan widens its own scope to any payee series holding a *paired* row, since pairing is
  decided by the money and its two legs normally sit in different payee groups.

- **Anomaly/forecast signals are a read-time projection** (`backend/services/recurring_signals.py`),
  *not* an event fired from the scan. The ingest seam looks like the natural home — it knows which
  payees changed — but a stored finding would be orphaned within a day (an auto series is re-minted
  with a new id on every scan) and stale on the next edit (a recategorize, a trash, a membership
  override). Deriving from the series and their members on each read is self-healing, idempotent, and
  cheap: the pass is bounded by series membership rather than by ledger size. The same reasoning, and the
  same dismissal store, carries the rule range-drift findings on the Rules page
  (`backend/services/rule_range_drift.py`), which are about the rule set rather than about a series. See
  `data-model.md` → Recurring series for the four kinds, why the stored amount band cannot detect a price
  change, and why lateness is measured against data freshness rather than the calendar.

- **Two surfaces, split by whether the thing is wrong.** The four anomaly kinds become Tasks items
  (`routers/tasks.py` reads the same computed counts) linking into the Recurring page's review section,
  where the per-signal actions live. **Upcoming** is a forward view on that page only, never a task: a
  badge that counts ordinary life stops meaning anything.

- **User-driven series are rule-backed.** Rather than force a rename so the derived key groups a
  varying-name payee, a rule flagged `is_recurring` owns a `source='rule'` series whose membership is the
  rule's matches (shared predicate `categorizer.rule_matches_row`). Entry points reuse the rule editor:
  the shared row menu's "Mark as recurring…" and the transaction editor's Rule button both open
  `RuleActionModal` (with a "Recurring series" checkbox), and the editor shows a status row linking to the
  series' `/recurring` card. Pin/exclude corrections (`recurring_membership_override`,
  `POST /recurring/{id}/membership`) survive scans; rule-backed series are reconciled over the full window
  even on a scoped pass. See `data-model.md` → Recurring series for the membership/override/lifecycle rules.

- **Drill-down:** clicking a series' charge count opens its member transactions in a docked bottom
  panel that renders the shared `TransactionListTable` (pill header, shared row cells + row menu), not a
  bespoke list — members are fetched via the transactions endpoint's `recurring_series_id` filter, so
  the drill-down looks and edits like every other transaction list (see `ui-patterns.md` → per-row
  editing). Editing a member (recategorize, trash) only affects membership on the next scan; the series
  record itself is user-owned and persists.

### Import / export

- **Backend:** `backend/routers/import_export/` (a package; `__init__.py` assembles one combined router and preserves the original `backend.routers.import_export` import surface)

- **Handles:** CSV preview/import, saved import profiles, support undo import operations, CSV export, data backup/restore, and credentials backup/restore

- **Preview contract — one parser, server-side:** the mapping table's amounts are computed by the *import's* `parse_amount`, via `POST /import-export/preview/amounts` (`preview.py`), not by the browser. A preview exists to show what the import will do, so a second implementation makes it wrong exactly where that matters: the client used to parse amounts itself and disagreed with the import on `single_unsigned` rows (it ignored the direction column, so every row rendered as a credit), on `DR`/`CR` suffixes, and on blank two-column cells. The endpoint posts the ten rows the client already holds rather than referencing the file, because `/preview` persists nothing there is a handle to re-parse and re-uploading the file on every dropdown change would be far heavier. It answers `null` — rendered as the raw cell or an em dash — for an unparseable cell or a convention whose columns aren't mapped yet. `frontend/src/lib/importExport/previewAmounts.js` owns the debounced fetch and the by-position merge, and no amount parsing at all

- **Effective-account behavior:** import review, saved-profile summaries, and CSV export resolve grouped child accounts through the parent's display name so historical account numbers still read as one physical account outside the Accounts page

- **Import history contract:** recent-import batch rows expose lightweight summary data; large duplicate-review payloads are fetched separately when the duplicate viewer is opened. The file-scoped ledger drawer (`ImportBatchDetail`) additionally fetches how many of the batch's rows were later *removed as duplicates* (`GET /batches/{id}/removed-duplicates`) and links to the batch's duplicate report filtered to them (`kindFilter: 'removed'`), because a Replace/Reject made from *another* file's report trashes a row belonging to *this* batch, which would otherwise vanish from the file view. Removed rows keep `suspect_duplicate_of` → the kept copy, which is what lists them in the report as `removed: true` entries with **Restore**; `removed_duplicate_count` (core.py) uses the report's predicate, and the same count feeds the card's duplicates pill. A removed row with no stored reason is labelled by `dedupe_resolved_by` (`_REMOVED_WITHOUT_REASON_RULE_KEYS`). Amazon reconciliation merges feed the same count through the same pointer (losers are tagged `rejection_reason='duplicate_confirmed'`, `dedupe_resolved_by='amazon_merge'`, `suspect_duplicate_of` → the kept copy) — there the kept copy is usually on the *same* account (a doubled import of one charge)

- **Duplicate matching contract:** import dedupe always keeps the exact content-hash path as the high-confidence rule, while lower-confidence cross-source matches rely on stored import evidence and stay visible in duplicate review with an explicit reason instead of being silently treated like exact duplicates

- **Soft-duplicate contract:** the same exact-match dedup that blocks imports cannot catch identical activity entered through two CSVs into separately-named accounts. After each batch finalizes, every batch row also runs a soft check against the rest of the ledger (date + amount + normalized payee) for cross-account matches; matches are flagged via `suspect_duplicate_of` (reason `cross_account`) rather than blocked and surface in the duplicate-review report. The check is gated only by `account_pair_distinct` — pairs the user has previously asserted as distinct, either via Keep in the report or by giving a source account its own account at mapping time (see "Mapping-time distinctness" below), are skipped. Same-batch sibling rows on different accounts are trusted as distinct (the CSV column carries the source-of-truth assertion for split purchases on the same statement) and are never the anchor for a soft-flag. Immediately after the sweep, import finalize runs `promote_in_group_suspects_to_confirmed` over the accounts the batch touched: any flag whose two accounts are *already in the same linked group* (a merge that predates this import) is promoted to confirmed (`auto_merge`) on the spot, because the merge already declared them the same physical account. This makes import order-independent — importing a file into an account that was previously merged with the account holding the matched rows settles identically to importing first and merging afterward. Flags against accounts outside the receiving group stay as soft-flags for review.

- **Both sides of a duplicate-report match name their account, per row.** The incoming side always did; the matched side did not, because a coverage candidate attached `account_name` only when it was flagged `cross_account` — on the reasoning that a same-account match need not repeat the account. That reasoning was about the data, not the reader: with an account under one row and nothing under the other, the blank reads as *unknown* rather than as *the same*, and it stopped being true at all once coverage candidates began arriving from linked-group siblings. Resolved when the report is **read**, from the `account_id` the record already stored (falling back to the matched transaction's own `id` for records written before that was kept), which is what repairs reports that already exist instead of only ones imported afterwards. All of it goes through one label expression (`_account_label_sql`) so every account named anywhere in a report reads identically — **including the mask**, because the hard-reject incoming side shows the *source's* own label for the account (`provider_account_label`, `"Rewards Card ···4417"`) and a bare name beside it renders one account as two different-looking ones. It stays **per row** rather than being hoisted to a column header or the report title even though it is often constant within a report: a report is not structurally single-account — one import spreading across several accounts (a CSV with an account column, a connection feeding several) produces rows on different accounts, and a header naming one of them would read as authoritative while being wrong for the rest.

- **Per-pair-distinct trust model:** the dedupe service does not infer "this pair of accounts is the same physical account" or "this pair of accounts is distinct" — it asks the user. Clicking Keep on any cross-account suspect is a *broad* assertion ("these two accounts are distinct"): the service writes a row to `account_pair_distinct` and cascade-clears every other unresolved soft-flag between the same two accounts, so the user does not have to click Keep N times for N coincidences. Conversely, merging two accounts contradicts the distinct assertion and `clear_account_pair_distinct_for_merge` removes any matching row. The management surface on the SuspectDuplicates page lists every recorded assertion and lets the user forget one to re-enable detection between that pair.

- **Mapping-time distinctness is a set question, and the picker is what makes it answerable.** Both account-mapping grids (CSV import, connection setup) ask "what does this source account become?", and giving it its own account is simultaneously an assertion that it is **not** any of the accounts it might have been — recorded as `account_pair_distinct` rows so the cross-account sweep never re-asks it one flagged transaction at a time. Three properties make that assertion trustworthy, and each replaced a defect:
  - **The candidate set is rendered, not collapsed.** `findAccountMatchCandidates` returns every plausible account; `findLikelyAccountMatch` is a thin wrapper collapsing it to one for the **one-click accept chip only** — and its rule has two conditions (exactly one possibility, *and* name evidence), so surfaces must call it rather than reasoning "the list has one entry", which would offer one-click accepts on mask look-alikes. They were one function, tuned for the chip — which must be unambiguous — so rival candidates suppressed it entirely. A tie therefore produced *silence*: no suggestion, no chooser, and nothing recorded, exactly when the user had the most to rule out. A lone winner was scarcely better, recording distinctness from one arbitrarily-chosen account while its equally-plausible siblings went unmentioned.
  - **Two controls, one question each.** The picker (`AccountMatchSelect`) answers *which existing account* — candidates hoisted to the top behind a "Possible" pill, then everything else; picking one maps to it and nothing further is asked. The row's `+New` answers *create a new one*, and routes through `PossibleAccountMatchChooserDialog` **whenever candidates exist**, because that dialog is where they are shown — and **an assertion may only cover what the user was shown.** A modal cannot be missed, which is what lets "Keep separate" record distinctness against every candidate listed. With no candidates there is nothing to show and nothing to assert, so `+New` creates in one press; that is the ordinary case when connecting a genuinely new bank, and routing it through a dialog would tax it for nothing.
    An earlier attempt put `+ New account` *inside* the picker to get the same guarantee. It worked, but it made the picker answer two differently-shaped questions, buried the New entry under every account in the ledger, cost the no-candidate case a second click, and — worst — left "create new and group with existing" reachable only when there happened to be exactly *one* candidate, so the row with the most information offered the least capable interaction. The dialog generalized to N candidates fixes that: the relationship question is available for every candidate, uniformly.
  - **The dialog is a radio list plus the same three actions, not per-candidate buttons.** Actions keep their full labels ("Map to existing account", "Create new account and group with existing", "Keep separate"), and the control count stays at three whether there are two candidates or six. The two relationship actions are disabled until a candidate is selected; a lone candidate is **pre-selected**, so that case keeps the press count it always had. **"Keep separate" is never disabled and ignores any selection** — a radio group cannot be cleared once set, so gating it would strand anyone who selected a candidate to consider it and then decided against it, with cancel-and-reopen as their only escape. The list holds the candidates only, never every account: anyone wanting an account the matcher never proposed uses the picker, which lists them all.
  - **Candidacy is wider than the chip's evidence.** Beyond name-stem and token-subset matching, an account sharing the source value's **masked digits** is a candidate (`extractAccountMask`, the exact mirror of what `normalizeAccountMatchStem` strips). A mask is the strongest identifier a bank account has short of its name, and the name is what has already failed by the time this runs — two sources of one account routinely disagree on what to call it while agreeing on the digits. It is deliberately **shown but never one-click**: four digits shared between unrelated real accounts is ordinary, so a mask match retires the chip rather than becoming it. Widening candidacy was only safe *because* of the picker — a looser rule that silently auto-suggests is dangerous, while one that adds a labelled row to a list the user opened costs a glance.

- **Dedupe module boundary:** all duplicate-detection logic — hard-reject and soft-flag verdicts, import-time rule chain, cross-batch post-import soft-flag sweep, per-pair-distinct filtering, and the post-merge soft-flag promotion — lives in `backend/services/duplicate_detection.py`. The module exposes a `DedupeContext` (precomputed lookups for one import pass), a `DedupeVerdict` (hard-reject | soft-flag | passthrough), and a per-row `evaluate_duplicate` function used by the import flow. Keeping the rule ladder in one place is what lets the medium-confidence rules share their "receiving account must have prior history or be an explicit alias" precondition — see the module docstring for the full ladder and the rationale behind each rule's confidence level.

- **Dedupe state lifecycle:** dedupe records are not write-once — they are revisited on the events that invalidate their premise. Undoing an import (`undo_batch`) deletes the batch's own `import_batch_duplicate` rows (decisions about a now-defunct import), deletes its `import_batch_account` coverage records (so future imports stop being blocked by a coverage window that no longer exists), and clears any `suspect_duplicate_of` pointers from other batches that referenced the now-deleted txns. Attaching an account into a linked group (`attach_account`) runs `clear_account_pair_distinct_for_merge` (the merge contradicts any prior "distinct" assertion between the now-grouped accounts) AND `promote_in_group_suspects_to_confirmed` to graduate any PRE-EXISTING soft-flag whose two sides are now both in the linked group — the merge declared those accounts as the same physical account, so a same date+amount+payee match across them is the same case `exact_hash_linked_group` would hard-reject at import time. Each auto-promotion is tagged `dedupe_resolved_by = 'auto_merge'` so detach knows it can safely reverse it. Promote also performs a *same-batch transitivity clear*: when a row Y on a merging account is promoted (because its suspect target is now in the merged group), any sibling row Z in the same import batch as Y — necessarily on a different account, since the CSV's account column asserts same-batch rows on different accounts are distinct transactions — whose own suspect points at the **same canonical row X** has its suspect flag cleared too. Concretely: a single CSV containing two same-amount charges on cards A and B both flagged against the same canonical X gets both suspects cleared once the user merges A↔X, not just A's. The match must be the *same* canonical row, not merely a row in the same merged group: if Z's suspect points at a *different* transaction that happens to live on an account now in the group, Z stays flagged — the merge with A proves nothing about a different canonical, and clearing it would silently destroy a real suspect (it is *cleared*, not confirmed, so a later detach cannot bring it back). Detaching (`detach_account`) reverses any `dedupe_resolved_by='auto_merge'` promotion whose account pair straddles the detach boundary — one endpoint on the detaching account, the other still in the now-shrunk group — restoring it to active-suspect state (back in the dialog for review). The reversal is **symmetric in which side holds the trashed row**: promotion graduates whichever row carries the `suspect_duplicate_of` pointer whenever *either* endpoint lands in the merged group, so the auto-promoted row can sit on the detaching account (pointing at a canonical that stays) OR on a staying account (pointing at a canonical on the detaching account — the case where the imported file holding the suspect was the one that stayed and the row it duplicated was on the account being pulled out). Both orientations are restored; restoring only the first strands the second permanently, which is what made a sequence of "map the same source account to one card, then another" look irreversible. Pairs wholly inside the remaining group are untouched. Rows the user explicitly Rejected (`dedupe_resolved_by='user'`) are left alone — the user's deliberate decision survives the un-merge. Soft-flags from `mark_import_suspects` (still active suspects, no resolution marker) also survive a detach since they reflect import-time facts, not group membership. The audit pointer `suspect_duplicate_of` is preserved across promotion and rejection so the user can always see what was matched and Restore if the auto-decision was wrong.

- **Hard-reject recoverability:** exact-match (and other hard-reject) duplicates are never inserted into `txn` at all — the row is dropped at import time and only its full would-be payload is persisted in `import_batch_duplicate` (plus a per-batch `deduped_count`). That payload is re-playable: `POST /import-export/batches/{id}/duplicates/import` re-inserts selected (or all) skipped rows via `_insert_imported_transaction`, independent of the import that originally caused the rejection. These records are scoped to their own batch, so undoing a *different* batch does not touch them — a row that file B skipped because it matched file A stays recorded against file B and remains re-playable even after file A is undone. The flip side is that the system does **not** auto-restore them: undoing file A removes file A's rows but does not survey later batches to re-materialize anything they deduped against A, so those rows simply stay absent (recoverable only by the manual "Import duplicates" action on file B, or by re-importing file B). See TODO ("Auto-restore deduped rows when a contributing import is undone") for the deferred automation and why it is non-trivial.

- **Advisory-review rejects:** a coverage-window hard-reject can fire without pinpointing the specific prior row it matched (the date is inside a covered range but no same-account row matches by date+amount). These surface in the unified report under their own Kind labels (`frontend/src/lib/duplicateKinds.js`, the one table that owns label, emphasis and sort rank) — all already rejected, but only the two that ask something of the reader take the amber "· review" suffix and a needs-attention pill. The candidate lookup searches the receiving account and that account's linked-group siblings, since a second source routinely files the same charge under a sibling. **Both** coverage rules search the group: the same-source rule passed `scope_id=None` until 2026-09-19, on the reasoning that its premise is narrower, but that premise governs the coverage *claim* while `scope_id` governs only which row may be named as the match — and withholding the group made one import diverge on whether the accounts were merged before or after it, as well as feeding the escape hatch below a false “nothing matched” (the group index is keyed per scope and the lookup reads only the row's own scope, so an unrelated group in the same import can never supply a candidate). It then widens display-only from exact→±1→outward, a day at a time, to `CROSS_ACCOUNT_DATE_WINDOW_DAYS` (posting dates differ between sources for several reasons — pending-vs-posted timing, weekend or holiday settlement, a foreign charge posting a local calendar day ahead — and measured skew on a real ledger reached +6; the widened reach is a fallback that never fires when a closer match exists, is ordered closest-day-first, and cannot change the reject verdict). A candidate found by that **widened** reach must additionally agree textually to be reported — `classify_source_text_relation`'s `exact`/`fuzzy`/`weak` tiers, the same ladder the soft-flag sweeps use, recorded on the candidate as `text_relation` and worded for the user at read time from `_CANDIDATE_TEXT_RELATION_LABELS` (stored as the bare tier key, so re-wording never needs a re-import). Amount and a nearby date alone are thin evidence: a week-wide window around any common amount picks up unrelated charges, and the report then presents a coincidence with the same confidence as the actual twin. Two exemptions: exact/±1 hits are kept regardless of wording (that band is the case the lookup exists for, and two sources routinely describe one charge with no shared text), and a pair with no captured text on either side is never hidden (a nameless money-movement leg matches nothing by design — silence is not disagreement). The gate is display-only in the strict sense: `_coverage_reject_verdict` runs its "named row with no candidate" escape hatch against the **unfiltered** list and applies `_display_candidates` only on the way into the stored `matched`, because an empty list there is what sends a genuinely-new named payment down the import path. Filtering everything out yields `no_match`, not an import — but it does trigger a second, display-only run of the ledger payment probe, on a verdict already settled. A named row whose only same-account candidate is a coincidence is otherwise enough to stop that probe running at all (it is gated on the list being *empty*), which is how a row could be filed as `no_match` while its real twin, filed by a second source under a sibling account with the same descriptor, sat one account-hop away unexamined. This splits the bucket into sub-states — **classified once at import** by `coverage_review_substate` and stored on the row (`import_batch_duplicate.review_substate`, added and backfilled by migration v61), so a file card can count the rejections still wanting a look with an indexed query instead of parsing every stored candidate list. NULL means *settled*, never *unclassified*: `save_batch_duplicate_rows` is the one writer and sets it on every row, and the read path nulls it for an acknowledged row rather than rewriting the column. The classifier deliberately says nothing about `reviewed_at`, so Mark reviewed and un-review need no write to it. The one other writer of the stored verdict, `refresh_unexplained_coverage_candidates` below, restates the sub-state in the same UPDATE — it is classified *from* the candidate list, so the two cannot be allowed to drift. The sub-states are: **`matched_near_date`** (a same-amount twin was found only on a nearby day, each candidate carrying the `day_offset` the report renders), **`transfer_match`** (no same-account twin, but a same-|amount| row within ±3 days on a *different* account whose **resolved name, raw name, or captured source text** contains the receiving account's name — all three, deliberately: the resolved name comes through a COALESCE that puts `raw_name` last, so naming a row, whether by a merchant-rename rule writing `merchant_name` or a manual cleanup writing `display_name`, used to displace the statement text the token was found in and silently cost the pairing. Reading all three means a rename can only ever add a token, never remove one — the funding/deposit leg of a wallet transfer whose bank/card counterpart is already on the books; cross-account and opposite-signed, so the same-account lookup can't see it; a targeted query that only fires on the no-same-account residual, surfaced for confirm/reject and never auto-applied), and **`no_match`** (no twin anywhere in the window or across accounts — the one genuinely worth investigating, e.g. a row present in one file but missing from the other, recoverable via "Import anyway"). `transfer_match` covers **two** different findings, because the ledger payment probe tags its candidate `cross_account` as well: the *same charge already recorded on another account* (`payment_match`) and the *other leg of one movement* (no `payment_match`). The report splits them back apart on that flag — **Matched another account** and **Matched transfer** — and treats both as settled, since the coverage rule made the verdict and these probes only name what it matched. Only `matched_near_date` (**Matched · review**) and `no_match` (**Rejected · review**) reach the needs-attention pills. The split is derived from the candidates rather than the sub-state so it survives **Mark reviewed**, which clears the sub-state. It stays a flag test rather than a fourth stored value on purpose: both findings are settled, so nothing counts them and only the label differs — a stored split would buy a rename and cost a migration. The report **replays a stored verdict** — `matched_transaction_json` is written once at import and read back thereafter — so opening it first runs `refresh_unexplained_coverage_candidates`, which recomputes the candidate list for coverage rejects that currently name *nothing* and leaves every other entry untouched. Without it an entry would keep reading "no specific match" forever, even after the lookup improves or a later import brings the twin into the ledger. It is bounded to be safe on a read path by *where* the expensive steps sit rather than by leaving them out. The same-account and linked-group reach runs from the prefetched indexes; both cross-account probes — the transfer twin, then the ledger payment probe — are then called directly in the loop, as a last resort on whatever is still unexplained, so an entry the cheap path settles never pays for either. The transfer probe was disabled here until 2026-09-20, on the reasoning that it had already run at import on the same question; that holds for the ledger as it *was* and not as it *is*, and a twin imported a week after the verdict was stored is exactly what this function exists to find. What made it affordable is that the unexplained population is now a counted, indexed quantity — the stored `no_match` rows — rather than an unknown, queries only the exact amounts and probe dates of the unexplained entries, and returns after one query when nothing qualifies. It re-derives each entry's scope from the account rather than replaying the one stored at import, so a group the account joined afterwards is visible. It never re-points an explanation that already exists, and never touches the verdict, reason, or `reviewed_at`. The user can acknowledge these with **Mark reviewed** (`POST /batches/{id}/duplicates/mark-reviewed`, bulk by `row_number`), which sets `import_batch_duplicate.reviewed_at`; an acknowledged row stays rejected (never imported) but drops out of the needs-attention pills. This acknowledgment is *only* for advisory rejects — soft-flag suspects are still resolved through Keep both / Discard new / Replace existing, which already clear them.

- **Needs-review contract:** every imported/synced row is flagged `needs_review` so the user can look newly arrived transactions over (see the field in `data-model.md`). Batch summaries expose a per-file `needs_review_count`, and `POST /import-export/batches/{id}/mark-reviewed` clears the flag across a whole card — the per-card counterpart to bulk Mark reviewed on the Transactions filter. It applies to a data connection's sync cards as well as to files, since synced rows carry their card's `import_batch_id`; a sync card's count returns when later rows land on it. A collapsed data-source row totals the count across its cards, so unreviewed rows are visible without expanding it

- **Saved-data-source behavior:** saved data sources remember whether imported files from that source should use categories present in the data by default, while each completed import batch keeps the actual per-file decision and scope used for that file

- **Imported-category behavior:** imports that use categories present in the data can apply those file categories directly to imported transactions, add missing imported categories as real leaf categories under the protected system `Unassigned` group, and feed those categorized transactions into the shared rule-suggestion workflow; placeholder labels that only mean "not categorized yet" are normalized back to `NULL` instead of creating a real category. A label matching an **inactive** category (one the user deleted) is suppressed — the row imports uncategorized with its label retained, no leaf is created, and the inactive leaf is not resurrected — see the inactive-category lifecycle in `data-model.md`
- **Organize / inactive surface:** there is one place to organize `Unassigned` leaves into reporting groups — the system-level "Group Imported Categories" workspace on the Import page, seeded from the live `Unassigned` leaves. Group placement and "Set aside" are both draft edits committed together on **Apply** (set-aside is treated like a bucket, undoable in-session). Applying a set-aside *parks* a category (`set_aside = 1`) and leaves it active — its transactions keep it and later imports of its label still land in it. Only Delete, from the workspace or the Categories page, *deactivates* a category (`is_active = 0`) rather than hard-deleting it; deactivated categories leave the active tree and the organize pool, appear in the Categories page "Inactive" list, and are recoverable via `POST /categories/{id}/reactivate`
  - **The workspace's in-progress draft is shared tenant state, not a per-user preference.** It stages how the one *shared* category tree is being organized, so all users/profiles see a single draft. It is stored in `import_workflow_state` (key `system_category_workspace_draft`, shared, in the data DB, carried by backups) and read/written through `GET`/`PUT /import-export/category-workspace-draft` — deliberately *not* the scoped `ui_preference` store, which would silo the draft per profile and orphan it on a restore into a different profile. The durable truth for parked/grouped state is the `category` table itself (group membership + `set_aside`); the draft only layers *un-applied* edits on top, and the workspace re-seeds parked/grouped state from those live flags whenever the draft is absent (see `categoryImportState.js::buildInitialSnapshot`), so losing a draft never loses committed organization.
  - **Saving the draft is revisioned, and applying it is one transaction.** The stored draft carries a `revision`; every `PUT` names the revision it was edited from (`base_revision`) and a stale one is refused with `409 draft_conflict` and the stored draft, the check and the write sharing one immediate transaction. A stale save whose draft equals the stored one is accepted without a new revision, since nothing would be lost either way; and opening or restoring the workspace re-reads the shared draft first (unless the window holds an unsaved change or an unresolved refusal), because the workspace saves as soon as it mounts and a window left idle while someone else arranged would otherwise be refused on that first save. The browser runs saves one at a time and coalesces edits made meanwhile, and on a refusal stops saving and asks whether to keep its own arrangement (saved again over the reported revision) or load the stored one (the open workspace re-seeds from it); any other save failure is shown and retried with the next edit. **Apply** is `POST /categories/imported-workspace/apply`: the groups the draft names, the categories placed in them by id, and the set-aside list are committed through the same create and edit rules as the individual category endpoints, inside one transaction, and it returns the resulting flat category list. A plan naming a category that is no longer waiting is refused with `409 workspace_stale` rather than applied around, and any refusal reloads the tree. Before this, Apply was a run of separate create, move, set-aside and restore calls from the browser, so a failure partway left a partial tree, and saves were fire-and-forget, so two windows silently overwrote each other.

- **Template-file behavior:** the saved-data-source editor remembers which CSV filename/hash last served as its template, but the user still explicitly chooses a template file when they want live column choices for editing

- **Delete fallback:** deleting a saved data source moves its files back into the unknown-source bucket while preserving each batch's own imported-category usage state

- **Amazon order import contract** (orders-only model, 2026-07-10 — the earlier per-item itemization was superseded)**:** the Amazon import form imports an AZAD orders/items export through a pipeline distinct from the CSV mapping flow, but folded into the *same* import-batch and undo contracts. Parsing is source-pluggable (`services/amazon_import.py`: a thin `read_export` header-sniffing front-end over a reusable `rows → orders` core, so a future clipboard-paste or combined-file source is a drop-in), and the ledger work is the `amazon.py` leaf — `run_amazon_import` splits a drop into **one `import_batch` per source file** and applies each order into its card via `apply_amazon_order` (`_import_group_to_batch` per group). Orders are grouped by the content hash of the file they came from: an orders file and its items file fold into one card (the items enrich the orders, joined on `order id` in `merge` before batching), while an items file dropped *without* its orders file becomes its own card whose per-item detail is **parked** (`amazon_pending_item`, keyed by order id) rather than discarded — so a later import of the matching orders file **auto-attaches** it (`_take_parked_items` at order creation), no manual re-import needed. Once that items card is **fully** consumed (nothing left waiting) it is **folded into the orders card** that took its detail (`_merge_items_card_into_orders`: the items file's name, hash, and enrichment summary move onto the orders card and the now-empty items card — which never had ledger rows of its own — is deleted), so a split items↔orders import ends on a single card labeled with both files, exactly as a combined drop would. The fold is symmetric across import order: an items file imported **before** its orders (parked, then the orders import consumes it) folds the prior items card into the new orders card; an items file imported **after** its orders (enriching already-imported orders — `enriched_into_batches`) folds the new, empty items card into the prior orders card. Both apply only when a **single** orders card is involved (an items file spanning two orders cards, or a partly-matched one, keeps its own card). The parked rows are removed when the parking import is undone (`reverse_batch_amazon_links`), and while an items card is only *partly* matched its "no matching order" pill resolves live from the ledger (`unmatched_parked_order_count`: its discarded order ids that still have no order link), flipping to "attached to orders" as orders arrive and re-flagging if that import is undone. Batching by *file* rather than by *drop* is deliberate — dropping several order-history periods at once then behaves exactly as if each file had been imported one at a time (independent coverage window / undo / reconciliation per card), instead of bundling unrelated periods onto one card; the content hash rather than the filename is the grouping key so two genuinely different files that share a name still split (identical content is deduped away before batching). It reuses the shared machinery rather than duplicating it: one order row per order is created through `_insert_imported_transaction` (so it carries batch linkage, `needs_review`, and provenance like any imported row; an optional items file folds per-item detail into that row's evidence), and the one extra side effect an Amazon import has — the matched card charge recategorized-and-linked (a `txn_link`) — is reversed inside the *existing* undo paths. `reverse_batch_amazon_links` runs in both `undo_batch` and the re-import `replace_batch_id` path, restoring each linked charge's prior category *before* the batch's own rows are deleted, exactly mirroring `reverse_batch_enrichments` and for the same reason (the charge lives outside the batch). The link / optional-item-enrichment / conditional-exclusion semantics live in `data-model.md` → "Transaction links and Amazon order import"; the architectural point is that Amazon import is an ordinary reversible import batch with one linked charge folded into the same undo discipline. A charge that arrives *after* its order — the card synced or imported later — is matched then, by `match_orders_after_ingest` from the CSV import and sync paths (ahead of PayPal pairing). Extensions since (2026-07, contracts in that same data-model section): an order may link *several* charges (split shipments) with per-charge undo stashes; the reconciliation report grew duplicate-merge, split-suggestion (`matched_review`, Accept/Dismiss) and bulk-resolution surfaces, and its actionable-attention count feeds both `list_batches` (per Amazon batch) and `get_tasks` (aggregate warning task) so the file card and the Tasks nag track resolution. That count is **cached** on the batch (`import_batch.recon_attention_count`) and recomputed lazily only when stale — both readers run on every history load / task poll, and computing it live runs the whole reconciliation. Staleness is a single monotonic epoch in `db_meta` (`recon_epoch`) bumped by a **trigger** on every write to a table the reconciliation reads (`txn`, `txn_link`(`_member`), `account`, `amazon_funding_map`, `amazon_charge_distinct`); a batch whose stored epoch trails the current one recomputes on the next read (`reconciliation_attention_count`). Triggers rather than per-endpoint bump calls because the charge-affecting writes are scattered and a missed site would silently show a stale count; over-invalidation only forces one recompute, and the accessor's cache write targets `import_batch` (no trigger) so it never invalidates itself. The epoch also advances once at every start (`_bump_recon_epoch` in `init_db`), because a cached count is stamped only with the data it came from: without that, a value cached by earlier code — in a shape or with a meaning since changed — would be served to the new code until the next data write. Each batch also persists an investigable `import_summary` plus the content hashes of the files that fed it in `config_snapshot` (a re-uploaded file is recognized and skipped, so nothing is ever re-processed into an all-duplicates batch), served back via `GET /amazon/import-detail/{batch_id}`. A file with any discarded rows is left re-importable — decided across the *whole drop*, since one items file can fold into an orders card here yet leave orphans (a missing orders file) on its own card there — and a taken file's hash is pinned to every card its rows fed, so undoing a card frees exactly the files it took. The two report dialogs (reconciliation + import detail) are App-level detached viewers on the shared `useDetachedReportViewer` seam (see `ui-patterns.md` → Floating detail panels → Minimize-to-nav-bar), alongside the duplicate-detection viewer. Charge matching narrows by the strongest account signal the order carries — mapped funding account (resolved to its **account group**, since the map stores a plain id that a later merge turns into a child while the charges keep arriving on the root — see `data-model.md` → Accounts), else the card's last-4 (maskless accounts stay eligible) — and when an order carries **neither** (`instrument: null`: a digital `D01` order or one paid off-card) the payee becomes the last remaining constraint, so the candidate must match `_AMAZON_NAME_LIKE`, the same "looks like Amazon" predicate the reverse scan uses. Amount+date alone had let an instrument-less order match a coincidental same-amount charge on any account (and drag unrelated payments into duplicate groups); the trade is that an off-card order whose real charge has a non-Amazon descriptor now reports no charge found — a recoverable miss rather than a silent wrong exclusion. Every "these charges are duplicates" claim goes through the single `_duplicate_group` seam, which owns all of the guards so a new consumer inherits them instead of re-deriving them (each guard exists because omitting it destroyed real data): candidates must share an **effective account** — two imports of one charge always land on one physical account (the Mint double-sync case), so same-amount rows on *different* accounts are distinct transactions and merging them trashes a real one — and a group the user settled via **Not duplicates** (`amazon_charge_distinct`) never re-flags. The report's three duplicate branches and `merge_duplicate_charges` all call it, so merging is re-validated server-side rather than trusted from the client; `merge_duplicate_charges` additionally refuses outright when an order links **several** charges, since an accepted split's shipments are all real and none is a redundant copy. Callers that want the *matcher's* candidate set rather than a duplicate claim (the equal-count pairing pass, the split-suggestion pass) keep calling `_order_charge_candidates` directly. It matters because an order whose payments string names no card (`instrument: null`, e.g. a D01 digital order) resolves to no last-4/account constraint at all, making every same-amount charge in the date window on *any* account a candidate. Further extensions (2026-07-16): two review-flavored duplicate buckets (`duplicate_review` — equal-amount copies only ambiguous at the ±14-day review window; `unaccounted_duplicate` — same-account/amount/near-date clusters in the reverse scan), a persisted **"Not duplicates"** assertion (`amazon_charge_distinct` pair table, consulted by every duplicate claim; an asserted order-anchored group falls back to the unmatched path with an exact-date tie-break suggestion), single-charge suggestion *reason notes*, and **removal provenance**: reconciliation merges/discards tag their trashed copies with the dedupe flow's confirmed-duplicate fields (`dedupe_resolved_by = 'amazon_merge'`/`'amazon_discard'`), routing them into the file ledger's removed-as-duplicates list and the Trash page's own Duplicate-transactions section (visible + scoped-emptiable there, unlike the unified flow's hidden rows).

- **Marketplace accounts — the extension pattern.** Amazon is the reference implementation of a *marketplace* account: a shopping venue whose purchases arrive itemized through a dedicated importer, not the generic CSV mapper. The pattern is meant to generalize to any similar vendor (Target, AliExpress, Temu, …); a new one needs five pieces, in order (the fifth conditional on the vendor's export naming the paying card):
  1. **An account-type marker.** Add an `ACCOUNT_TYPES` entry with `kind: 'marketplace'` (frontend `lib/accountTypes.js`). This alone makes the type selectable on the Accounts page while **excluding** it — and any account of it — from the generic CSV importer's type dropdown and account-mapping picker (which consume `GENERIC_IMPORT_ACCOUNT_TYPES` / `isMarketplaceAccountType`), because those accounts are filled by their own flow. `kind` is a UI convention only: the account stays ordinary in the DB (its `type` column holds the value; nothing enforces marketplace behavior).
  2. **A vendor-specific parser + detector.** Export formats differ per vendor, so the parser is bespoke — the reference is `services/amazon_import.py` (a thin header-sniffing front-end over a reusable `rows → orders` core). It ships with a header **sniff** mirrored client-side (cf. `lib/amazonDetect.js`) so a file dropped on the *generic* importer is recognized and routed to the vendor's flow instead of column mapping.
  3. **The shared ledger substrate.** The `txn_link` primitive and the order engine (`routers/import_export/amazon.py`: one spending transaction per order, match + exclude + link the funding card charge, plus a reconciliation report over the result, reversible via the batch-undo hook). A vendor that fits the same "one row per order + link the funding charge" model reuses this directly; one with different semantics forks it. These currently carry Amazon-specific names (`apply_amazon_order`, `LINK_KIND = 'amazon_order'`); generalizing them to a vendor-neutral abstraction is deferred until a second vendor exists, so the shape is known rather than guessed.
  4. **A dedicated import form** — a dialog the Data Import drop zone opens when it recognizes the vendor's files, plus a row in the File Sources tab's data-source list, which is the home for the vendor's setup help. The importer stamps each batch with `import_batch.source_kind = 'marketplace:<vendor>'` so the import history groups the batches under that vendor instead of "unknown data source" (they have no CSV profile). See `ui-patterns.md` → Import-specific patterns for the interaction rules and why a vendor is a data-source row and a form rather than a tab.
  5. **A funding-source → account map** (only if the vendor's export names the *paying card* rather than which of the user's accounts it hit — Amazon does). `amazon_funding_map` + `services/amazon_funding.py` key each payment instrument (card `last-4` + network) to the system funding account it charges, so the importer can constrain its card-charge search to that account (imported ledgers rarely carry masks, so this — not `account.mask` — is the real signal). It is a user-maintained, global-by-default map (with an optional per-account override) surfaced as a persistent section under the vendor's import tab (`AmazonFundingSourcesSection`), and it accrues instruments as imports discover them. Resolution order in `find_matching_charge` is **override → global → graceful-last-4 → no match**; see `data-model.md` → "Transaction links and Amazon order import".

- **Watched import folders — the unattended way in** (`watch.py`): a data source may name a directory on the **server**, and a file that appears there is imported through `run_import_parsed` without anyone opening the page. It adds no reporting of its own, because it does not need any: a file it takes produces an ordinary import batch, so duplicates, refused rows, imported categories and rule suggestions all land on the file card that already reviews them.

  **There is no scheduler, and this must not introduce one.** The app is multi-tenant with per-identity database paths, so a timer thread would have no tenant to run as and no way to choose one. Scanning is request-driven on the `POST /recurring/auto-scan` pattern: `POST /import-export/watch/auto-scan` runs a scan only if one is due (a `db_meta` watermark, `AUTO_SCAN_MIN_INTERVAL_MINUTES`), and is called from `App.jsx` when the data scope activates and again when the Import page's `WatchedFoldersPanel` mounts; `POST /import-export/watch/scan` is the unconditional *Check now*. The nav badge and the Tasks list read a **persisted** count (`attention_counts`) and never touch the filesystem — a badge that stat-ed a network share would put every page load behind it.

  **A scan is cheap because of the per-file watermark.** `import_watch_file` holds `(size, mtime)` per entry, which `os.scandir` returns for about the cost of the syscall, so only an entry that is new or has moved is read, hashed and parsed. A file that has moved is re-hashed and matched against `import_batch.file_content_hash`, which stays the durable answer to "have we taken this exact file"; the table is a cache of the cheap half plus the reason a file is waiting on someone, which is why it is deliberately outside backups (`data-model.md` → *Watched import folders*).

  **The refusal is the design.** Anything the stored mapping does not already answer parks the file and raises a Task rather than being guessed at, and the Task opens the ordinary import flow with the file pre-seeded (`GET /import-export/watch/files/{id}/content` hands the bytes back, since everything downstream of the drop zone works from a `File`). Which cases refuse, and why each one has to, are in `data-model.md`.

  **Two shapes were turned down and read as obvious improvements, so they are worth naming.** *OS file-change events* (`watchdog`, inotify / FSEvents / ReadDirectoryChangesW) buy latency nobody feels on a monthly statement, against a new dependency and a platform matrix — inotify works on neither WSL `/mnt` paths nor network shares, which are exactly where a watched folder is likely to be. Polling on the triggers above is cheaper and more portable. *Moving an imported file to a `processed/` subdirectory* is a second mechanism for the job the purge option already does: it mutates a folder the user's own tooling may be watching, and the content hash makes it unnecessary for correctness. A source's `filename_pattern` is applied as a secondary filter so several sources can share one directory, but it is deliberately not how two sources are told apart — a directory each needs no naming discipline.

  **Settings are admin-gated, unlike the rest of a data source**: `PATCH /import-export/profiles/{id}/watch` is behind `require_admin_or_local` because naming a directory is a statement about the server's filesystem rather than about the ledger — see `security-model.md` → *Reading and deleting outside the data directory*. A restore switches watching off when the data came from another instance; the verdict is taken before the wipe, because the restore adopts the backup's `instance_id` and the question is unanswerable afterwards.

- **Module layout:** the package keeps a deliberately large, cohesive `core` alongside its thin leaf modules. `core.py` holds the run-import flow (behind a parse seam: a front end hands `run_import_parsed` a `ParsedFile`, and the CSV front end `parse_csv_text` is shared with the preview), the dedupe context, and batch history/undo/duplicate-report/category/rule-suggestion logic — plus the shared primitives (hashing, amount/date/header parsing, effective-account resolution, imported-category settings) the rest of the package reuses. The leaves carry only cleanly-separable concerns: `profiles.py` (saved data-source / import-profile CRUD), `backup.py` (data + credentials backup/restore and CSV export), `preview.py` (the read-only CSV preview endpoint), `paypal_statement.py` (PayPal monthly statement PDFs — read by `services/paypal_statement.py`, then imported through `run_import_parsed` under the PayPal data source), `amazon.py` (the AZAD Amazon order/items import — parse via `services/amazon_import.py`, then create one transaction per order, the funding-charge link, and the reconciliation report), and `rule_suggestion_actions.py` (the Generate Rules review's actions and their undo, each one transaction across rules, transaction rows and review state, run against the review scopes `core` defines). **A review scope is the only thing that differs between the three populations the review runs over** — one import batch, every completed batch of a saved data source, or every completed batch that uses its file's categories — and it carries exactly three of them: where the review state is stored (a batch's `config_snapshot`, a profile's `column_map`, or the system workflow state), which rows it covers (shared by the generator and the matching-rows report, so the two cannot disagree about the population), and the identity fields the report names itself with. Every endpoint in the family is one implementation taking a scope opener, and nothing else in it may branch on which scope it has. Dependencies flow one way — leaves import from `core` — with a single deliberate exception: `core`'s undo paths need `amazon.reverse_batch_amazon_links`, so they import it **lazily inside the function** rather than at module load. That keeps the module-load graph acyclic (the one place `core` depends on a leaf) while letting undo reverse Amazon links; `__init__.py` is the only place that wires the combined router and re-exports the public surface.

That core concentration is intentional. Import behavior is one of the places where many small decisions have to stay consistent across preview, saved profiles, history, undo, duplicate handling, category application, and rule learning, so the workflow logic that has to agree across those stages stays together in `core` rather than being scattered for the sake of smaller files. The leaf modules were split out precisely because they do *not* share that web of decisions — profile CRUD, the backup/encryption envelope, and preview each depend on `core` through a few named helpers but carry no logic the core needs back — so extracting them relieves navigation and merge-conflict pressure without splitting the parts that must move together.

### Detail panels

- **Panels:** payee detail (`TransactionDetail`), category detail (`CategoryDetail`), account detail (`AccountDetail`), range-scoped transaction listing (`PeriodDetail`, opened by double-clicking a bar on the dashboard's single-period trend chart or from the trend card's "View transactions" link, and by clicking a month bar on the Trends-tab monthly chart), and tag-signature listing (`TagDetail`, opened by clicking a wedge on a dashboard tag-report pie). All five share the same chrome.

- **Shared behavior:** draggable + **resizable** shell, monthly bar charts, month selection, lazy-loaded transaction lists, and page-driven default placement when multiple panels are open. The resize handle in the bottom-right corner converts a docked panel to floating geometry on first drag so size and position stay coherent; the `useDetailPanelChrome` hook owns drag/resize state and `DetailPanelShell` renders the chrome.

- **Stacking and dismissal:** multiple panels can be open at once and each stacks with an offset; the topmost panel carries the strongest edge and elevation while older panels recede. Re-opening the same target focuses the existing panel rather than spawning a duplicate.

- **Reporting contract:** Expense/Income are simply how the user thinks about their data. Expenses can include positive values for various reasons, an expense might get reimbursed, a purchase might be returned for a refund, etc. These monies received are not income, they offset an expenditure. To support this detail drawers and dashboard summaries should not drop rows just because a transaction's sign is unusual for an expense or income category; they include all matching rows for the selected slice and use the net amount.

- **Shared implementation:** `frontend/src/components/detailShared.jsx`

### Help / FeatureExplainer

- **Location:** `frontend/src/help/`

- **Pieces:** a content registry (`content.jsx`) that holds every explainer as `{ id, title, surfaces, summary, body }`; a `<FeatureExplainer topic="...">` popover component for inline `?` affordances next to feature controls; the `/help` and `/help/:topic` routes (`pages/Help.jsx`) for the standalone index and per-topic pages; a `<HelpLink>` component that propagates back-navigation state across hops between topics; and a small `labelForPath` helper for the "Back to `<page>`" affordance

- **Single source of truth:** the same registry powers the popover summary and the standalone Help page body, so the two surfaces cannot drift. Adding a new explainer is one new entry in `content.jsx` plus a `<FeatureExplainer>` drop-in at the feature surface

- **Back navigation:** the popover stamps `state={{ from: <pathname> }}` onto the Read-more `<Link>`; the Help page reads it back to render a labeled "Back to `<page>`" button. `<HelpLink>` is used for cross-topic links inside content bodies so the original source survives multiple hops within the Help section

### Configuration layers

Every setting resolves through three layers, highest wins:

```text
hardcoded default  <  control-DB `app_setting` row  <  environment variable
```

The shape follows from one goal: **an ordinary install needs no configuration file.** Defaults cover the
common case, so `.env` is an override mechanism rather than a prerequisite — nothing creates it, and its
absence is the normal state. The registry in `backend/app_config.py` is the single declaration of each
setting (environment variable, default, whether it is stored, whether it is redacted); the resolver, the
`GET /api/auth/config` report Administration → Startup configuration renders, and any setting added
later all read from it. That panel is a report of values resolved at startup. A setting changed inside
the app does not join its rows or this registry, since anything in the registry gains an environment
variable that outranks it.

**Why the environment layer still wins.** An operator has to be able to force a value from outside the
app — a broken stored setting would otherwise be unreachable, and the two-installations-on-one-host case
is configured entirely from outside. `.env` is loaded with `override=True`, so within that layer the file
beats a stale shell environment; that is also what lets the Playwright harness point `LUMA_ENV_FILE` at
an isolated file and get its throwaway databases. Because an override is invisible from inside the app,
the Administration → Startup configuration report names the layer each effective value came from rather than showing a
form that silently would not take effect.

**`.env` is loaded by an import that every entry point makes first** (`backend/load_env_file.py`). The
database locations are read from the environment once, when the database modules are first imported, so
an entry point that reaches them through anything else fixes the paths without the file and nothing
corrects them later. The launcher did that through `app_config` and ignored a portable copy's `DATA_DIR`
while honoring its port; `test_desktop_launcher.py` now pins the order in a fresh interpreter.

The panel leads with the three settings an ordinary install might change (the data directory and the two
ports) and files the rest under a collapsed **Advanced** group. Placement is declared per setting rather
than inferred from whether a value currently equals its default — placement that moved with the value
would make a row someone saw last week vanish this week — but a setting actually overridden in the
environment is surfaced regardless, since overriding it is direct evidence this installation cares about
it. A `FeatureExplainer` on the section header opens the `configuration` help topic, which carries the
narrative; the panel itself stays a report.

The panel offers exactly one write: **clearing** a stored value (`POST /api/auth/config/{key}/reset`), so
its default applies again at the next start. It is a reset rather than an edit because the only two
stored settings derive or generate themselves — there is no value worth typing — and because everything
here is consumed at startup, so a field that accepts input and changes nothing until a restart reads as
broken. It exists because a stored value is otherwise permanent: a cookie name stored under an earlier
derivation would never pick up the current one, and a leaked secret could not be rotated without editing
the database by hand. Clearing is refused, on both sides, while an environment override is in force — the
write would succeed and change nothing, since the environment still wins.

**What is stored rather than defaulted.** Only values that must *persist*: the session signing secret and
the session cookie name. The secret is generated on first run and written to the control DB — regenerating
it per boot would invalidate every session, and requiring the user to supply one was the last thing
forcing a configuration file to exist. The cookie name is derived from the **control database path** (a
readable label from its directory plus a digest of the full path) and then stored. Deriving it from the
install directory instead would miss the case that directory cannot distinguish — one checkout run
against two databases by swapping `.env` files — where a shared cookie name signs the user out on every
swap, because each database signs with its own secret and rejects the other's cookie.

**What can only be environment.** The data location (`DATA_DIR`) — where the database is cannot be read
out of the database. One directory setting rather than a path per file, with fixed filenames: the two
databases always travel together, so a second installation wants a second directory. `DB_PATH` /
`CONTROL_DB_PATH` remain honored and still win for their own file, which fixing the filenames makes
necessary rather than merely polite: a database not on the default filename is reachable only that way,
and dropping the overrides would create empty databases beside data that still exists. All of this is resolved at import and then held as module state, so the
report reads the value in force from the module that owns it rather than re-deriving it — it cannot name
a database the process never opened. The bind port and the frontend/Vite ports, which
are consumed before the server binds or before the app process exists. The launcher knobs
(`LUMA_USE_LOG_FILES`, `LUMA_BACKEND_READY_TIMEOUT`), read by the start scripts before Python runs, and
`SERVER_MODE`, read by the launcher (`backend/desktop.py`) before it has a server to configure.
`SESSION_COOKIE_SECURE`, a transport guarantee set at the deployment edge and deliberately not derived
from app state. `CORS_ORIGINS` names other web origins allowed to call the API from a browser *with
cookies*; it defaults to empty because every topology serves the app and the API on one origin (the dev
server and the Docker frontend both proxy `/api`), so a standing grant would be credentialed access
bought for nothing. And `LUMA_DEVELOPER_OPTIONS`, which gates destructive reset tooling — a gate, not a
preference, so it is intentionally not something the UI invites anyone to flip.

**Bootstrap ordering.** The session secret and cookie name are constructor arguments to
`SessionMiddleware`, not values a request can look up later, so `backend/main.py` initializes the control
database and resolves configuration *before* the app object is built. That is why `init_control_db()` runs
at import rather than in the lifespan hook. Settings a user actually changes — sign-in,
password policy, currency, data-source credentials — are not in this system at all: they have their own
endpoints and their own storage (see the storage-layers section and the token vault).

### Identity, access & deployment model

The settled shape (see `security-model.md` for the assumptions it rests on and the shapes rejected) is
**one shared workspace with multiple login identities** — not multi-tenant hosting. Every member is
provisioned into the single admin tenant and shares one data DB; there is no per-tenant data isolation
and no hosted multi-tenant target. Per-request DB routing (`set_current_db_path`, driven by the tenant
row's `db_path`) is retained as **dormant plumbing** — excising it would be risky and low-value, so it
stays wired, resolving every identity to the one configured database. The per-tenant *directory* layout
it once implied is gone: creating a tenant record points it at `DB_PATH`, and startup brings a record
that has since fallen out of step back to it (`reconcile_workspace_db_path`), so there is no second location
for data to land in.

**A 401 is answered by the shell, not by the caller.** `request()` in `lib/api.js` dispatches
`SESSION_LOST_EVENT` (`luma:session-lost`) on any 401 and `App.jsx` listens: it drops back behind the
gate and re-runs the identity bootstrap, which re-establishes a passwordless session or stops on the
chooser / sign-in. The alternative — every surface handling its own — is what shipped first, and it
surfaced a lapse as whatever error text the unlucky component happened to render (a red "Not
authenticated" inside a report dialog, with nothing to act on). Two rules keep it from feeding itself:
the `/auth/` endpoints never signal, because their 401 is the bootstrap's *answer* rather than a lapse;
and a signal suppresses further ones for five seconds, because a page holds several requests in flight
and the bootstrap it triggers makes more calls that may 401 while it works.

- **Login is an authentication *perimeter*, not an authorization system.** Its only job is to keep
  *non-users* out. Once inside, every user sees and edits the **same** data with no row- or scope-level
  restriction. No data route checks role.
- **Admin gates the install and the perimeter, not the ledger.** The guards in
  `backend/authorization.py` govern user management, environment/provider settings, backup and restore,
  and the backup keys; nothing at the data layer is admin-gated.
- **One identity concept — a `user_account` — in a single table.** There is no separate local-profile
  table: a perimeter-off identity and an authenticated user are the *same* row, and the "Enable sign-in
  protection" flag decides **only whether the login password is verified**. *Perimeter off* is local mode:
  passwordless `user_account`s picked from a chooser, scoping per-person UI preferences. *Perimeter on* is
  auth mode: the same identities, now password-checked, reusing the accounts / 2FA / roles / password-policy
  machinery. "Password optional" is a **workspace** property (`enable_auth_mode()` / `disable_auth_mode()`),
  never per-user — because the data is shared, a per-user opt-out would let a LAN peer just pick the
  passwordless identity and read the same ledger. `auth_required()` is now **only** the sign-in flag (the
  old `user_count() > 1` latch is gone, so multiple passwordless users are ordinary).
- **Identity is carried by the session in both modes.** The tenant middleware (`backend/main.py`) reads a
  single `session['user_id']` regardless of mode; a perimeter-off session is stamped `pwless` (identity
  chosen via `POST /auth/select-identity`, no password), and enabling sign-in invalidates any `pwless`
  session on its next request. There is no per-request identity header.
- **A session is also a row.** Every sign-in path calls `sign_in_sessions.start`, which records a
  `sign_in_session` row in the control DB (keyed by a SHA-256 of the id) and puts the id in the cookie
  as `sid`. Before anything reads the session on an API path, the middleware checks the row still exists
  and clears the session if not, so a signed cookie with no live row is signed out. Logging out deletes the
  browser's row; setting an account's password or disabling it deletes the account's rows
  (`control_database.update_user`), keeping only the session that made the change when it is the account's
  own; idle rows are pruned when a session starts. The same id keys the vault's unlock cache
  (`security-model.md` → *Identity and the network perimeter*).
- **Typed secrets are limited against guessing** (`services/attempt_limiter.py`): per account, attempts at
  least two seconds apart and a five-minute pause after five wrong secrets in a row, answered with `429
  too_many_attempts` and `Retry-After`. It covers `/auth/login`, `/auth/2fa/verify`, `/auth/2fa/disable`,
  `/auth/2fa/recovery-codes`, `/auth/vault/unlock`, `/auth/vault/change-passphrase` and
  `/auth/vault/recover`. A pause at `/auth/2fa/verify` also drops the pending challenge and says so
  (`restart_sign_in`), which the sign-in screen answers by returning to the password step. What is left
  out, and why, is in `security-model.md` → *Identity and the network perimeter*.
- **Enable and disable are flag flips.** *Enable* claims one existing identity as admin (sets its password),
  marks every other passwordless identity `must_change_password` (claimable at next login), and flips the
  flag (`enable_auth_with_admin`). *Disable* (admin-gated) just flips the flag back — identities and their
  password hashes are preserved (dormant), so re-enabling is seamless; no migration, no re-keying, no
  credential loss. A one-time `_unify_local_profiles_into_users()` at startup folds any legacy
  `local_preference_profile` rows from an older install into `user_account`s (preferences re-keyed) and
  drops the table.

**Passkey sign-in** is an additional credential on this perimeter, never a replacement for the password.
The mechanism, end to end:

- `app_passkey` (control DB) holds one row per registered device: the credential id, the authenticator's
  COSE public key, its sign counter, transports and a label. Nothing in it is secret — the private half
  never leaves the authenticator — and it is a **separate table from `vault_slot`** on purpose, which also
  holds passkeys. The two features share no storage, no endpoint and no ceremony (`security-model.md` →
  *Passkeys and the second factor*).
- `services/app_passkey.py` wraps `py_webauthn`: it builds the ceremony options, verifies the completed
  ceremony (origin, RP id, type, signature, user verification, sign-counter regression, and that a
  returned user handle is the owner's), and owns the policy around that — user verification is
  **required** on both ceremonies, and registration asks for a *discoverable* credential so the sign-in
  screen can offer a passkey before anyone types a username. The sign-in ceremony's `allowCredentials`
  names every active account's sign-in passkey (never an empty list, which a browser reads as "any").
  Sign-in passkeys are registered under their own user handle (`sign_in_user_handle`, a hash of the
  account id) while the vault's use the account id, and `passkey_account_names` labels both kinds —
  the vault's params call it too (`security-model.md` → *Passkeys and the second factor* for why each).
- `POST /auth/passkey/register/begin|complete` needs a signed-in session; `GET /auth/passkey/params` and
  `POST /auth/passkey/login/begin|complete` are public (listed in the tenant middleware's `public_paths`),
  because the sign-in screen runs them before a session exists. `DELETE /auth/passkey/{id}` removes one.
- **The challenge lives in the signed session**, not in a table, which makes it single-use (it is popped
  on use) and bound to the browser that asked for it — the same rule the vault applies to an unlock and to
  a proof stamp.
- A passkey sign-in **completes without the TOTP step**, since the ceremony's required user verification
  already establishes the second factor. It still honors `must_change_password`.
- `_passkey_context` (`routers/auth.py`) answers whether a ceremony can run on this connection at all,
  returning a *stated reason* (`insecure_context`, `ip_address_host`) rather than letting the browser fail
  opaquely. The accepted origin is any origin on the RP id's host — the port is deliberately unpinned,
  since the frontend and backend ports are both configurable and the browser already refuses to offer a
  credential whose RP id does not match the page.
- Frontend: `lib/appPasskey.js` (ceremony + serialization, separate from `lib/vaultPasskey.js`),
  `lib/base64url.js` (shared encoders — the vault stores standard base64, sign-in speaks base64url), the
  sign-in button in `components/AuthScreen.jsx`, and `SignInPasskeysPanel` in
  `components/settings/SignInFactorsSection.jsx`.

Aggregator token protection (the Plaid/provider vault) is **orthogonal** to this perimeter — a
passwordless install can still hold vault-encrypted tokens because the vault secret is per-user and
independent of the app perimeter. See "Token vault & transport security" below for the vault itself.

### Token vault & transport security

Provider (Plaid/aggregator) access tokens are the crown jewels — a leaked token is live, ongoing bank
access, materially worse than the plaintext ledger — so they get real at-rest protection via a
**multi-wrap envelope vault** (`backend/services/crypto_service.py`). Why custody is shaped this way —
and every alternative turned down — is in `security-model.md` → *Secret custody*; the shape:

- **One workspace Data Encryption Key (DEK)** encrypts every per-connection secret
  (`connection.credential_enc`; the retired `plaid_item.access_token_enc` was folded into `connection`
  by migration v18 — see "Provider connections" below) and every app-level provider secret
  (`provider_config.secret_enc`). Those two columns are the *entire* set, registered as
  `crypto_service.ENCRYPTED_COLUMNS` so rotation reaches all of them and a test fails if a third is added
  without being listed. The ciphertext travels with data backups, the key material with the control DB.
  **The property is leaked-DB ≠ leaked-tokens**: no live unlock secret ⇒ no KEK ⇒ nothing opens. It
  deliberately does *not* defend a compromised *running* host (the server is trusted and holds the DEK
  while unlocked) — matching the self-hosted/LAN model. The **ledger stays plaintext at rest**
  (host-protected, not vault-encrypted).
- **A slot is a keypair, not a wrapped DEK.** Each `vault_slot` row (control DB) holds a public X25519 key
  in the clear, its private key AEAD-wrapped under the KEK derived from that user's unlock secret, and the
  DEK **sealed to that public key**. Unlocking derives the KEK, opens the private key, and unseals the DEK.
  The indirection is what makes the DEK *giveable*: sealing needs only a public key, so a member can grant
  access to someone whose secret they do not have, and rotation can re-seal for every remaining slot.
  Wrapping the DEK directly (**format 1**, still readable and converted in place at the next unlock) could
  do neither — see `security-model.md` → *Secret custody* ("A slot holds a keypair, not a wrapped DEK").
- **Unlock secrets** are a passphrase via `scrypt`, or a passkey's WebAuthn **PRF output** via `HKDF` (no
  stretching — it is already 32 uniform bytes from the authenticator). One passphrase and any number of
  passkeys per user, enforced by a partial unique index; the last method that opens the vault cannot be
  removed. **No WebAuthn assertion is verified**: a wrong PRF output fails at the AEAD tag exactly as a
  wrong passphrase does, so the slot is self-verifying and no WebAuthn library is needed. WebAuthn's own
  two preconditions — a secure context, and an RP id that is a domain rather than an IP address — are
  detected server-side and returned as stated reasons, since the answer to both is "use a passphrase here".
- **Unlocking** holds the DEK in a **server-side, in-process cache keyed by `user_id` and the sign-in
  session, with an idle TTL** —
  *never* the signed session cookie (which serializes to the browser). Dropped on logout and on restart
  (re-unlock ⇒ "first sync of the day"). Endpoints: `POST /auth/vault/{set-passphrase,change-passphrase,
  unlock,lock}`, `/auth/vault/passkey/{params,register,unlock,set-passphrase}`, `/auth/vault/reenrol`;
  status via `vault_configured`/`vault_has_passphrase`/`vault_unlocked`/`vault_access_pending`. Connect/sync and credential
  export/restore require an unlocked vault (`423`; connect on an unconfigured vault `409`). There is **no
  `off`/plaintext path and no app-held master key** — the vault is the only custody. Every passphrase must
  meet **≥ 20 chars and ≥ 6 distinct characters** (`passphrase_meets_production_min`; the distinct-char
  guard rejects a long-but-degenerate repeat), an *all-slots* property since the DEK is only as strong as
  its weakest wrap. The passphrase is meant to live in a password manager, so length is cheap; the set
  dialog shows an **advisory strength meter** that blocks nothing.
- **Changing how the vault is opened needs a *recently presented* secret, not just an open vault.**
  Three operations mint a **durable** unlock method — writing a passphrase slot, registering a passkey,
  issuing a recovery code — and each would otherwise turn transient access to an unlocked session into
  permanent, independent access that survives lock, relock and the owner's own attempts to get back in.
  So each requires proof inside a five-minute window (`PROOF_TTL_SECONDS`), stamped by the four places a
  secret is actually verified (`unlock`, `unlock_with_passkey`, `change_passphrase`, `recover_with_code`)
  and by choosing a first passphrase. Both the stamp and the unlock belong to the **browser session** that
  presented the secret, not to the user (`security-model.md` → *Identity and the network perimeter*).
  **The stamp is absolute, not sliding** — the unlock cache's own TTL
  is pushed out on every read, so a stamp riding on it would be renewed by ordinary decryption and never
  expire. A lapsed window returns `403 proof_required`, deliberately *not* `423 vault_locked`: the vault
  is open and what is missing is recency, so the answer is to present a secret again rather than to
  unlock. The session carries `vault_proof_seconds_remaining` so a surface can ask *before* an action;
  that copy is advisory and being wrong costs one extra prompt. Because unlocking counts, the ordinary
  sitting — unlock, open Vault settings, add a passkey — is never prompted twice. Vault settings asks
  whichever question actually applies — *unlock* when the vault is shut, *confirm* when it is open and
  only the recency has lapsed — and runs the held action once the secret is given, so the click is never
  lost. **Not gated:** `set-passphrase` (both surviving branches have no existing access to escalate
  from), `rotate` (re-seals the slots that already exist and grants nothing new), `reset` (admin-gated
  and behind a typed confirm phrase), and the credentials export (it copies ciphertext and never
  decrypts, so the file is exactly as strong as the passphrase, which is asked for at restore).
- **Any method that opens the vault can also replace the passphrase.** `POST
  /auth/vault/passkey/set-passphrase` proves with a ceremony and writes the new passphrase in **one**
  request, the passkey sibling of `/auth/vault/recover` and one call for the same reason: no proof is
  ever spent with no passphrase written. It is also how a passkey-only member sets a *first* passphrase,
  since `set-passphrase` refuses a caller who already holds a working slot.
- **Enrollment, revocation and rotation.** Setting a passphrase (or registering a passkey) as a user the
  vault does not yet know **enrols** them: the slot is written with no sealed DEK and reports
  `vault_access_pending` — a state distinct from "locked", because no secret they could enter would help.
  A member who *had* access and lost the secret that opened it cannot enrol that way — their slot still
  holds the DEK, which is what makes it unopenable rather than absent — so `POST /auth/vault/reenrol`
  replaces it with a pending one, refusing when no other member could ever grant it (otherwise the only
  path to the DEK is destroyed with nobody able to seal it back). Such a request carries
  `replaces_access`, because handing access *back* is a different decision from admitting a newcomer and
  only the approver can tell them apart.
  Any member holding the DEK approves it (`/auth/vault/access-requests/{slot}/approve`, `423` if locked);
  admins revoke (`/auth/vault/access/{user}/revoke`).
  **A waiting request is surfaced to every member who could approve it, not only to one whose vault is
  currently open** — the Tasks nag (`_vault_access_task`) and the Connections vault strip both scope on
  holding an unlock method. Scoping them on *being unlocked* hid the queue from exactly the person who
  needed telling: someone who does not routinely unlock never learns there is anything to unlock for, so
  the requester waits on a signal nobody sends. A locked member's task names the unlock step, the locked
  strip names who is waiting beside its Unlock button, and an approve that returns `423` raises the
  unlock prompt and then completes the approval rather than reporting a string. A non-member is still
  told nothing: there is no moment at which they could act. `GET /auth/vault/members` lists who currently holds
  access, grouped per person with a count of their unlock methods — the counterpart to the request queue,
  and what makes "remove someone's access, then rotate" an instruction with something to act on. `POST /auth/vault/rotate` mints a new DEK and
  re-encrypts every registered column under it, in **three phases** — seal the new key into every slot
  (retaining the outgoing one in `sealed_dek_prev`), rewrite the ciphertext, then clear the previous seals
  — because no transaction spans the control and data DBs, and a failure between the two writes would
  otherwise strand every credential under a key no slot can produce. An interrupted rotation is **resumed**
  on the next call, never restarted. Revoke *then* rotate: rotation re-seals for whatever slots remain.
  `POST /auth/vault/reissue-credentials` is the exposure response for an open vault
  (`services/exposure_response.py`): each connection whose adapter declares `reissues_credential` gets a
  new credential from the provider, stored at once, and the rest come back as outcomes for the user to
  finish — see `security-model.md` → *Responding to an exposure*.
- **Recovery and reset.** A forgotten passphrase used to be an unhandled dead end — `unlock` needs the
  passphrase and `set_passphrase` on a configured vault takes the `require_dek` path — so the vault now
  carries a **recovery ladder**, offered strictly cheapest-first because only the last rung costs
  anything. (1) Another member re-enrols the stuck user; nothing moves. (2) A **recovery-code slot**
  (`method='recovery'`, one per user by partial unique index) opens the vault and re-keys the passphrase
  **against the same DEK**, so no ciphertext is rewritten and no source is re-linked. It is a third slot
  method needing no schema — `_derive_kek` does not care whether its secret was typed or generated — but
  it has its **own generator at ≥ 128 bits**, deliberately not the 40-bit sign-in one, because a slot's
  wrap is offline-attackable where a hash-checked 2FA code is rate-limited. `POST /auth/vault/recover`
  takes `{code, new_passphrase}` as **one operation**: the replacement slot is written *before* the
  recovery slot is deleted, so any failure leaves the code live and the attempt repeatable — which is
  what makes a single code safe — and a fresh code is issued on the way out. (3) A credentials backup,
  restorable with the passphrase *it* was made under. (4) `POST /auth/vault/reset` — destructive:
  every slot deleted, every `ENCRYPTED_COLUMNS` value cleared (driven off the registry rotation uses, so
  a column added later is reached without anyone remembering), and `reauth_required` set on every
  connection. Connections, accounts, transactions, mappings and coverage all **survive**: only two
  columns are ever encrypted, and the expensive state sits in plaintext beside them. The reset is
  **admin-gated** and asks *lost or compromised*, because the two differ: a compromised passphrase still
  opens the vault, so each credential is revoked at its provider first — driven by
  `revokes_on_disconnect`, reporting **per-connection outcomes** rather than aborting the way
  `disconnect` does — while a lost one can decrypt nothing and revokes nothing. **Nothing on the ladder
  blocks the reset**: the rungs are led with and named (the preview returns members by display name, and
  the caller's own granted passkeys), and a reset run anyway reports `also_locked_out`, since one DEK per
  workspace means it ends *every* member's access. An earlier design refused the lost path while another
  member held a slot; that was dropped because a slot row cannot prove the holder is reachable, the admin
  gate already settles who may do this, and the compromise path permitted the identical destruction — so
  it only stopped users who described their situation accurately. `VaultDecryptError` during a sync is
  classified as `reauth_required` rather than a generic failure — it is the one failure retrying can
  never fix.
- **Transport** is a per-topology property, not an app mode: the backend always speaks HTTP; a
  client-server deployment terminates TLS at a reverse proxy (Caddy) with uvicorn on `--proxy-headers`,
  so `request.url.scheme` reflects the external scheme. `backend/transport.py` detects loopback-vs-network
  and HTTPS **per request**, reading loopback from the client's address (the accepted peer, or what a
  loopback proxy forwarded for it) and never from the `Host` header. The permissible-HTTP rule: plain
  HTTP on a networked bind is fine only with no perimeter to defeat (no sign-in, no provider); either
  trigger ⇒ HTTPS. Enforced/nudged by `SESSION_COOKIE_SECURE` (→ cookie `Secure`, set by the install, not
  derived from the profile), `transport.require_protected_link` — which refuses the operations that
  carry a provider secret when they arrive from another device in cleartext — and a **computed "Set up
  HTTPS" task** (`tasks.py`) — required/non-dismissible for a provider, recommended/suppressible for plain
  client-server, self-clearing over HTTPS, and shown only to an admin (or anyone, with sign-in
  protection off), since a member cannot set it up.

### Provider connections (the aggregator seam)

Data-source aggregators reach the app through **one provider-neutral seam**, so adding a provider is an
adapter, not a change to the connect/sync callers.

**One sync writes to three stores, and which one a fact belongs in is decided by who may lose it**:
durable *connection status* on `connection` / `connection_account` (cursor, last outcome + summary,
coverage, allowance — provider-shaped, and expected to differ per adapter); a disposable *diagnostic
history* in `connection_sync_log` (pruned by age, user-clearable, so nothing user-facing may derive from
it); and the *bundle of transactions received* on `import_batch` + `import_batch_account`, which behaves
like a CSV import card apart from the monthly-vs-per-file boundary. Full rule, and the two defects that
came of leaving it unstated, in `docs/data-model.md`.

- **Storage.** A `connection` row (`backend/db/database.py`) is the durable credential boundary: a
  `provider` discriminator, the provider's `external_id` (Plaid's item_id), and the opaque
  per-connection credential vault-encrypted under the DEK (`credential_enc`; plaintext column always ''
  — see the vault above). It **superseded `plaid_item`**, which was dropped in migration v20.
  Accounts link to their connection via an explicit `account.connection_id` FK (→ `connection.id`,
  `ON DELETE SET NULL` — a disconnected account keeps its rows but drops to `NULL`); `account.provider`
  records origin (`plaid`/`csv`/`manual`) and `account.external_account_id` (renamed from the old
  `plaid_account_id`) is the provider's per-account handle / sync upsert key. **`external_id` is only
  stable where the provider issues it *and* the app can re-authorize in place** — declared per adapter as
  `stable_external_id`. For Plaid that means Link **update mode** (`create_link_token(access_token=…)`,
  `POST /plaid/repair`): a plain Link session mints a new Item, so without update mode "reconnect" would
  strand the connection it was meant to fix. The repair exchanges no token — it re-fetches accounts as
  proof the Item answers, then clears `reauth_required`. Where the handle
  is derived from the credential instead (SimpleFIN hashes the access URL, since the URL *is* the
  credential and cannot also be the public handle), re-authorizing yields a new handle and the upsert
  would insert a *second* row. The account mappings survive that regardless — both
  `record_provider_accounts` and sync key on `account.external_account_id` — but everything hanging off
  `connection_id` does not: per-account coverage, the cursor, sync history. So connect takes an
  `adopt_connection_id` and **re-points the surviving row** rather than inserting and migrating. The
  choice is collected **before** the provider call, because a claim or exchange is single-use and there
  is no second attempt to act on a later answer; a stale choice falls through to the ordinary upsert and
  reports `adopted: false`. Full rationale in `building-a-connector.md`. CSV and manual accounts have
  `connection_id IS NULL`.
- **Adapter interface.** `backend/services/providers/` exposes `get_adapter(provider)` over a
  `ProviderAdapter` (`connect(app_config, payload)` → `{external_id, credential, institution}` /
  `fetch_accounts` / `fetch_transactions` / `fetch_transactions_sync` / `remove`), normalized to
  provider-neutral dict keys (`external_account_id`, `external_transaction_id`, …). Adapters delegate SDK
  details to a thin per-provider boundary (`plaid_service`) or speak the protocol directly (`simplefin`).
  The connect and sync paths speak only the adapter + `connection` table — never a provider's field name.
- **Capability declarations, not branches on provider name.** The seam was first built around Plaid, and
  several of its traits turned out not to be universal. Each is now a class attribute an adapter declares,
  so a caller asks the adapter rather than knowing which providers are special: `connect_spec` (a Link-style
  widget vs. a pasted token — it also drives what the connect UI renders), `requires_app_config`,
  `has_cursor`, `max_history_days`, `routine_lookback_days`, `revokes_on_disconnect`, `connect_noun`,
  `reissues_credential`, `stable_external_id`, `zero_amount_rows` and `currency_scope`. Adding a provider
  means declaring these; it should not mean editing the routers, the sync loop, or the Connections tab. The
  last two are the ones with **no default** — what a $0 row means, and whether a currency is stated per
  account or per transaction, do not generalize between sources, so an undeclared one must fail rather than
  inherit. It also spans beyond adapters: the CSV and Amazon importers are data sources with no
  class to hold an attribute, so they declare through the registry in `services/source_capabilities.py`.
  **See `docs/building-a-connector.md`** for the full checklist of provider traits that turned out not to
  be universal (id uniqueness, currency, budgets, coverage claims, reporting refusals) and the failures
  each one prevents.
- **One connect flow, two entry points.** `providers.establish_connection` is the whole flow after the
  handshake — demo/vault gates, credential encryption, the `(provider, external_id)` upsert,
  `upsert_connection_accounts`, the unmapped count. Link-style providers reach it via `POST
  /plaid/exchange` (which needs its own route only because the payload arrives from the widget's callback);
  everything else via the generic `POST /api/providers/{provider}/connect`. Both converge on its first
  line: a second copy of that tail would be free to drift on credential custody and account adoption,
  which is exactly what the seam exists to prevent.
- **Sync speaks to cursor and non-cursor providers identically.** `fetch_transactions_sync` defaults on the
  base class to a **range pull** (fetch a window, present it as one complete page), so a provider with no
  change feed needs no special case in `run_sync`. Its return separates three questions that a
  cursor provider lets you conflate: `has_more`/`update_status` (more to deliver *right now* — the
  poll-again signal), `backfill_complete` (history fetched to its *end*), and `resume_later` (stop polling,
  but the backfill is unfinished — resume on a later sync, which is how a metered provider pauses without
  the connection being marked done and its remaining history stranded). `account_coverage` reports how far
  back the pull *actually* reached **per account**, since a walk that stops early — out of history, or out
  of request budget — covers less than it asked for, and may have covered some accounts and not others.
  Overstating either makes duplicate detection reject genuine rows (`docs/data-model.md` → "coverage has
  two shapes") — and a paged pull sharpens that rule: a page reports only the accounts *it* advanced, never
  the ones still waiting their turn, since seeding coverage from where an account already stood claims
  depth the page never fetched. `removed` is unavoidably empty on the range-pull
  path: the provider *cannot report* deletions, which is not the same as confirming there were none.
  **Each page is applied and committed before the next is fetched**, so no write transaction spans a
  provider call — SQLite serializes writers, and a transaction held across a multi-minute pull left the app
  routing but unable to load anything that writes. Two contract pieces exist for that shape: `continuing`
  (false on a pull's first call, true on its pages) for work belonging to the pull rather than the page,
  such as SimpleFIN's one-per-pull recent-window top-up; and `budget_checkpoint`, which a metered adapter
  calls after debiting and *before* issuing the request, so a crash can only forfeit an unused allowance
  rather than lose the record of a request already made. Progress is committed with each page
  (`connection.sync_progress`), which is what lets any request observe a pull still in flight — the pull's
  own HTTP response cannot, being a single call that returns only at the end. The response does, however,
  break its totals down **per connection** (`connections[]`, from the same per-call facts as the sync log
  and the connection card, so the three cannot disagree about one call): a client drives a *sequence* of
  these calls and wants a per-connection total for the whole run, and summing responses cannot miss a call
  where differencing the progress a slow poll happens to observe drops any call that starts and finishes
  between two polls — which a routine top-up usually does.
  `run_sync` takes `full_history` to tell an initial/deepening pull from a routine top-up (they otherwise
  send identical arguments), and `provider` to scope a sync so one card cannot spend another provider's
  request budget. A pull may also return **`warnings`** — problems that did not fail it, such as one bank
  on a multi-bank credential needing re-authentication while the rest delivered. These are reported rather
  than only logged because the pull *succeeds*: a partial failure wearing the appearance of a clean sync
  is the one failure mode nothing downstream would ever notice.
- **An account added on the provider's side is discovered by syncing, but never mapped by it.** Sync does
  not ask a provider what accounts it has — it matches incoming transactions to accounts by external id —
  so an account added after a connection was built would otherwise be invisible: its transactions match
  nothing, are counted as skipped, and are dropped. When a transaction arrives for an id with no
  `connection_account` row, the sync fetches the provider's account list once and records the newcomers as
  **unmapped**, which is what raises the existing "N to map" nudge. The guard is the `connection_account`
  row and *not* whether a local account exists: those differ precisely for an account the user chose to
  **skip**, which has a row and no account, and keying off the account would re-fetch the provider's list
  on every sync forever. Discovery deliberately stops short of creating anything — auto-creating a local
  account per provider account is the behaviour the mapping seam exists to replace.
- **History state is per account, and the caller owns it.** How far back an account has been fetched
  (`coverage_start_date`) and whether it has any older data at all (`history_complete`) live on
  `connection_account`, because both are facts about an individual account: a connection's accounts do not
  advance together once one is added on the provider's side later. `run_sync` therefore decides the work —
  which accounts still want older data, and how far back — and passes `account_targets` down; the adapter
  fetches and answers with `account_coverage`, what it *actually* reached per account. The adapter holds no
  history state of its own.

  This is what makes one loop serve a first backfill, a deepening pull, and a late-arriving account alike:
  they differ only in which accounts are targets. A newcomer needs no instruction and no scheduling — it
  simply has no coverage, so it is a target like any other, and budget exhaustion needs no parking because
  each account's recorded reach *is* where it resumes. An earlier design bolted a separate catch-up
  instruction beside a connection-level `history_exhausted` flag; that mechanism existed only to work
  around the state being stored at the wrong level, and disappeared once it moved.

  A cursor provider reports no `account_coverage` (it maintains one window across the whole item, so the
  requested depth is the accurate claim) and ignores `account_targets` — a cursor is a checkpoint in a
  change feed, not a date range, so there is no way to ask it for one account's history.
- **A window is bounded by a date range, not an account**, which decides when to filter. One unfiltered
  request advances every account that wants that period, so filtering a plural set would multiply requests
  without fetching anything more (three accounts over three years: 25 requests unfiltered, 75 filtered).
  The rule is therefore to fetch unfiltered whenever two or more accounts want a window and to narrow only
  when one does — where it costs the same and saves bandwidth. Re-fetching rows already held is free in the
  rationed dimension: they are idempotent-skipped on `external_transaction_id` before reaching duplicate
  detection.
- **A walk that has moved back from today spends its first request on the recent window.** Every window
  such a walk fetches is old, so without this no *new* transaction would arrive for however many days the
  walk takes to finish — and the recent ledger is the part a user actually looks at, while history is what
  they consult later. A walk still starting at today skips it, since its own first window already covers
  that period. The watermark this advances (`through`, where the next top-up begins) moves **only** after
  the fetch: advancing it for a pull that fetched only old windows would silently skip everything between
  the real last top-up and the new watermark.
- **The ledger's currency is a setting, and adapters are *told* it rather than assuming one.**
  `services/ledger_currency.py` owns the value (tenant state in `import_workflow_state`, default USD);
  `run_sync` resolves it per connection and passes `ledger_currency` into `fetch_transactions_sync`, the
  same "the caller owns the database, so it owns the facts in it" rule that governs `account_targets`. An
  adapter drops transactions from an account the provider states is denominated differently and reports
  them as `unsupported_currency`. **The question is "does this match the ledger", never "is this dollars"**
  — the app's constraint is one currency at a time, so a consistently-AUD ledger is entirely correct, and
  an earlier hardcoded `"USD"` comparison would have discarded every transaction of a non-US user whose
  data was never wrong. Nothing outside `ledger_currency.py` may compare against `DEFAULT_LEDGER_CURRENCY`.
  Both adapters implement it, and *where* each judges differs because the providers report differently:
  SimpleFIN states a currency per **account**, so its walk skips a mismatched account wholesale; Plaid
  states one per **transaction** (resolving `iso_currency_code` / `unofficial_currency_code` — the latter
  being crypto and unsupported currencies, which can never equal an ISO ledger), so its adapter filters
  `added` and `modified` row by row. Per-row is the stricter reading, and Plaid's data supports it: the
  number in `amount` is judged on its own terms rather than on an assumption about its account.
  `GET`/`PUT /api/currency` read and write it; the PUT answers **409** when the ledger already holds rows
  and the caller has not confirmed, because the change converts nothing and therefore silently relabels
  every historical amount (and, for the same reason, is perfectly reversible — a confirmation is the right
  guard rather than a prohibition). The frontend's `MONEY_DISPLAY_CONFIG` mirrors it at boot, with the
  symbol derived from `Intl` rather than a maintained table; Settings reloads after saving because the
  money formatters read that config at call time and nothing would otherwise re-render.
- **The provider's own conformance checklist is a design input, not a formality.** SimpleFIN publishes one
  (protocol page → *Checklist*), and three of its items are things reasoning from the protocol description
  does not produce, because they are about the *user's* security posture rather than the request: a failed
  claim must be reported as a possible **interception** (a setup token is single-use, so a claim that fails
  may mean someone else spent it, and only the user can disable it at the Bridge — "generate a new one" is
  the reassuring reading of identical evidence); a 403 on a data call must be handled as its own condition;
  and error text from the provider must be sanitized before display. React escaping covers injection, so the
  live risk there is **volume** — provider strings are clipped in the adapter (`_clip`, `_MAX_MESSAGE_CHARS`)
  at the boundary rather than at each consumer. One item is deliberately not followed to the letter:
  "display error messages from `/accounts` to the user" is applied to bank-level codes only, with request
  advisories routed to the log, because a note about our own date range sitting beside "your bank needs
  re-authentication" trains the user to ignore both. **Check a new provider's conformance list before
  writing its adapter, not after.**
- **Sync health is recorded per connection and travels with the connection list.** `run_sync` stamps
  `last_synced_at` on success only (so a failing connection reads as stale rather than recently synced),
  counts `consecutive_sync_failures` (reset, not decremented, by any success — what distinguishes a blip
  from a connection that has stopped working), and stores the most recent error and warning set. These
  ride `GET /api/providers` alongside each connection rather than sitting behind their own call,
  because the Connections card has to surface them **while collapsed** — a failure that only appears once
  a card is expanded is one nobody sees. See `docs/data-model.md` for what each field may and may not mean.
  The same payload carries the **last sync's report**: the import cards the pull wrote to, and a count of
  the rows it added or revised. The `↗` beside "Last sync" opens the shared import-card ledger
  (`useBatchDetailPanels`) over the Connections tab — scoped to just those rows when the count is non-zero,
  otherwise the whole card — so newly arrived transactions can be categorized where they arrived instead of
  the user navigating to the Import history to hunt for the card. Only the count travels; the row ids
  stay server-side and the query expands them (`sync_connection_id`), because this payload is polled
  throughout every sync. See `docs/data-model.md` for the cap and the three rules governing the row list.
- **"Reconnect this" is a separate signal from "syncing failed", because only one of them is actionable.**
  An adapter raises `ProviderCredentialRejected` (`services/providers/base.py`) when the provider has
  stopped accepting the stored credential; `run_sync` sets `connection.reauth_required` (migration **v30**),
  which is sticky until a pull succeeds and is what the card leads with, suppressing the ordinary failure
  pill so the two do not say the same thing twice. Everything *else* is deliberately left undifferentiated —
  a user cannot act on the difference between a network blip and a provider outage, only on how long it has
  been going on, which the failure count already says. This matters most for a provider with no revocation
  API (SimpleFIN): revoking at the Bridge is the only way a user *can* revoke, and the refusal recorded here
  is the only notice the app ever gets that they did. Today only the SimpleFIN adapter raises it (403 on a
  data call); Plaid's `ITEM_LOGIN_REQUIRED` is the obvious second source and is not yet wired.
- **Credential continuity.** `crypto_service.encrypt/decrypt_connection_credential` binds the ciphertext
  to `(provider, external_id)`; for `provider='plaid'` it reuses the exact pre-6a AAD
  (`plaid_item|<item_id>|access_token`), so tokens written before the cutover decrypt unchanged — the
  migration re-keys nothing.
- **App-level credentials.** The aggregator's *own* app secret (Plaid `client_id`/`secret`/
  `env` — one per provider, distinct from the per-bank connection credential) lives in the vaulted DB
  `provider_config` table: only `secret` is vault-encrypted (`secret_enc`, AAD `app_credential|<provider>|
  secret`); `client_id`/`env` are semi-public plaintext. `providers.config.resolve_app_config(user, provider)`
  returns the decrypted `{client_id, secret, env}` the adapter needs — the saved row is the **only**
  source. A `.env` bootstrap (`PLAID_*`) carried pre-6b installs through the move and was retired once it
  had nothing left to carry (2026-08-18): it kept a plaintext app secret readable in a file for exactly
  the credential the vault exists to protect, and it gave a locked vault an unlock-free path to a secret.
  Entering the credential once in the Configure card is the whole of the setup. Every adapter method takes
  this resolved `app_config` (never reads the environment itself).
  A provider that has **no** app-level credential (`requires_app_config = False`, e.g. SimpleFIN) receives
  `{}`: for it, "nothing configured" is the permanent normal state rather than setup left undone, so it
  reports itself *configured* once it has a connection, offers no Configure action, and — having no sandbox — is gated on a Production-strength vault at **connect** time, there
  being no later moment at which to ask.
  Admin-gated CRUD is `GET/POST /api/providers/{provider}/config` (`routers/providers.py`); saving the
  secret needs the vault unlocked (`423`), and switching a provider to Production still runs the all-slots
  vault gate. App credentials ride the **credentials backup** (`provider_configs`) alongside connections.
  There is **no `.env` → DB migration** — the credential is re-entered once via the Configure card
  (decided 2026-08-01).
- **Connections-tab UI.** `ConnectionsTab` (`components/connections/ConnectionsTab.jsx`) renders the
  Import page's Connections tab as one card **per provider** (driven by `GET /api/providers`): a mode badge, admin-only
  **Configure** (the app credential — moved off the Settings form entirely; that section now only points
  here), **Connect bank**, a small per-connection **Sync** for checking what was just configured, and the
  linked accounts. Across the top are one **Sync now** for every connection and the whole sync log;
  each connection's ⋯ menu carries fetch more history, refresh accounts and remove synced transactions.
  The actions come from `lib/useConnectionOperations.js` and the status rendering from
  `components/connections/ConnectionStatus.jsx`. It also hosts the **vault set-passphrase
  / unlock** *strip* — the vault UI deliberately rides the connection cards rather than owning a
  settings page of its own — set/unlock post to
  `/auth/vault/*` and refresh the session's vault flags. Everything needing an open vault (connect,
  sync, deepen history, refresh accounts, disconnect, the app-secret reveal/save) goes through one gate,
  `lib/useVaultGate.js`: it raises the passphrase dialog and the action **resumes** when the unlock lands,
  so a locked vault costs a passphrase rather than a passphrase plus a repeated gesture, and a `423` is
  handled as that same gate arriving late rather than surfaced as a failure (see `ui-patterns.md`).
  **The gate is hosted at App level** (`contexts/VaultGateContext.jsx`) rather than by this tab, because
  the navigation pane's sync control starts gated work too and a prompt mounted under one route cannot
  suspend an action taken anywhere else; its flags are derived from `currentUser` rather than separately
  fetched. The tab keeps the strip, the change-passphrase dialog, and the strip's own passkey button.
- **Sync is reachable app-wide.** `components/SyncNavItem.jsx` is a permanent row in the navigation pane
  that starts a sync of *every* provider (`runSyncAll`), reports a run in progress, and restores the
  finished run's panel — one control with three states rather than the transient stashed-run pill it
  replaced. Its freshness figure is derived from the connections' own `last_synced_at` (`syncFreshness`
  in `lib/connectionSummary.js`, the oldest across all of them) rather than stored anywhere. See
  `ui-patterns.md` for the reasoning behind all three properties.
  **Connect** additionally requires — on a networked (non-loopback) bind — real HTTPS
  (`transport.is_https` from `/auth/status`), so a bank secret never crosses the wire in cleartext; that
  one is a refusal, since no dialog on the page can resolve it. Each card lists its **connections** (from
  `GET /api/providers`, which returns them per provider) with a **Disconnect** action → `POST
  /api/providers/{provider}/disconnect`, which **revokes the token provider-side where the provider allows
  it** (the adapter's `remove` op → Plaid `/item/remove`, so a leaked copy dies too) then drops the local
  `connection` row, keeping the accounts/transactions. Where it does not (`revokes_on_disconnect = False`
  — SimpleFIN publishes no revocation call), `remove` is a documented no-op and only Luma's copy goes; the
  confirm dialog says which of the two is happening, because a user who believes access ended when it did
  not is worse off than one who knows to go and revoke it at the provider.
- **The mapping seam (`connection_account` + `routers/connections.py` + `services/connection_mapping.py`).**
  Connecting a bank used to create one local account per provider account, with no chance to say "this
  *is* my existing Northgate Voyager." That was not only a UX gap next to CSV import's account step — **it was
  the missing input to duplicate detection**, because the ladder's cross-account rules fire only when the
  receiving account already appears in the matching coverage *or* was explicitly declared an alias, and a
  sync could satisfy neither. So `POST /plaid/exchange` now records provider accounts into
  `connection_account` (unmapped) and creates nothing; a **required mapping step** runs after Link and
  **before the first backfill**, so the very first batch of rows is deduped against whatever the mapped
  accounts already hold instead of arriving unattached. `upsert_connection_accounts` became
  *mapping-driven*: it materializes accounts from `connection_account` rather than blindly creating one per
  provider account, and "Refresh accounts" adds newly-seen provider accounts as unmapped while re-applying
  existing decisions. Endpoints: `GET /api/connections/{id}/accounts`, `POST .../account-map` (idempotent;
  triggers the re-scan when a mapping changed), `POST .../captured-fields`.
  See `data-model.md` → Accounts for the modes and what each buys the ladder.
- **`routers/connections.py` also owns the reverse: `GET`/`DELETE /api/connections/{id}/synced-transactions`,**
  the preflight and the removal of everything a connection has synced. Its rows go through
  `import_export/core.py`'s `undo_batches` — the one path a file's Undo, a re-import's replace, and this
  share — and it then resets the chain that *describes* what has been pulled: cursor,
  `initial_sync_complete`, and the connection's coverage columns. That reset is the point of the endpoint
  existing at all (a cursor left advanced past deleted rows makes them unreachable), and it is the only
  writer of the "a cursor reset clears both coverage columns" invariant. No provider call and no
  credential are involved, so unlike sync/disconnect/refresh it works with the vault locked.
  See `data-model.md` → "Sync import cards" and `ui-patterns.md` for the decisions behind it.
- **Captured fields are declared by the adapter, not hardcoded per provider.**
  `ProviderAdapter.capture_fields()` returns `[{key, label, locked, default_on}]`, so each adapter states
  its own set and the SimpleFIN adapter is unaffected by the Plaid choices. **Locked** fields are the
  ones duplicate detection depends on and are not the user's to disable (`posted_date`,
  `provider_description`, `counterparties`, `check_number`); optional ones
  (`location`) are user-selectable and persist as `connection.captured_fields`. `posted_date` is a
  first-class `txn` column; everything else goes into `import_evidence_json` **in the identical shape a CSV
  import writes**, which is what makes a synced row visible to the text matcher and — via
  `evidence.account.value` — to the terminal-window matcher. Plaid's `personal_finance_category`,
  `payment_channel`, and `transaction_code` are deliberately not captured (the app's own rules own
  categorization).
- **Duplicate detection for connection rows lives in `services/connection_dedupe.py`**, which both the sync
  path and the re-scan share: one context builder over a connection's mapping, so the two moments a
  connection's rows meet the ladder ask the same question with the same inputs. The **re-scan** is the
  retroactive half of the mapping feature — rows synced before a mapping existed were judged with no
  cross-account premise available, and re-judging them is what turns a mapping decision into a cleanup.
  It runs **only** from applying a mapping, and has no endpoint or user-facing trigger of its own:
  every other occasion that changes what a connection's rows should be compared against already runs
  detection at that moment (a CSV import and a sync each sweep their own batch — and a CSV import's
  ladder reads the connection's coverage; an account merge scans the newly-unified group), so a
  user-driven re-check had no state left to reach and was removed rather than kept as a lever whose
  only remaining job was to change which side of an already-visible pair got flagged.
  Two properties are load-bearing and directly tested: the pass excludes **the whole connection's own
  batches** from its candidate pool (excluding only "self" would let two rows from the same connection
  reject *each other*, trashing both copies of a transaction that has one duplicate), and it removes a row
  only when it can **name the surviving counterpart** — coverage can hard-reject on the range alone, which
  is right for a row nobody has seen yet but not for one already in the ledger with a category on it.
  Removals are trashed, never deleted, carrying `rejection_reason='duplicate_confirmed'` +
  `dedupe_resolved_by='connection_rescan'` + the `suspect_duplicate_of` audit pointer — the same state an
  account merge produces, so the card's duplicate report shows them and Restore returns them intact.

### Database concurrency

**The backend is multi-threaded, and always has been.** FastAPI runs plain `def` endpoints in a worker
threadpool, so several requests genuinely execute at once — a fact worth stating because it is invisible in
code that contains no threading of its own, and it changes what "safe" means for anything touching the DB.

**Nothing is shared between those threads.** `get_db()` opens a *fresh* `sqlite3` connection per call and
closes it at the end of the block; there is no pool, no module-global connection, and no caching.
`check_same_thread` is left at its default (`True`), which is correct here precisely because connections
are never handed across threads. DB routing is per-request for the same reason: `_current_db_path` is a
`ContextVar`, not a global, so the control-DB / data-DB split cannot leak between concurrent requests. The
practical consequence is that **there is no Python-level data race to defend against** — the concurrency
that matters is SQLite's own.

**WAL means readers never block; writers serialize.** Any number of requests can read while one writes, so
contention shows up only between writers, and it shows up as *waiting*: a blocked writer waits out the busy
timeout (`_BUSY_TIMEOUT_SECONDS`, explicitly set — Python's 5-second default was never chosen for this
workload) and then fails with `database is locked`. Data is never lost to contention, but a request can be.

**So the rule that matters is: a write transaction contains only the work it exists to do.** Gather
everything the update needs *before* opening it, do the update, commit, and only then go on to whatever
comes next. A transaction that holds anything else converts "one slow operation" into "every writing
request fails for the duration", which is how a long sync used to leave the app routing but unable to load
anything — navigation is client-side, so clicks worked while the recurring auto-scan on app load,
preference saves, and cache updates all timed out. The provider-sync path is the case this was learned on
and the pattern to copy: fetch with nothing open, apply, commit, repeat.
`backend/routers/import_export/core.py` also shows the defensive half — a read endpoint whose best-effort
write is wrapped so transient lock contention degrades instead of 500ing.

**Network I/O is the obvious violation, not the only one — the expensive lesson was a purely local one.**
Ingestion (a sync, a file import) and the analysis that follows it (the cross-account duplicate sweep, the
recurring rescan, the PayPal funding pairing) are separate stages, and the transaction boundary is where they separate: the writing
stage ends at its commit, and every stage after it opens its own. This was decided when a
threaded producer/consumer ingest and a raw staging table were both rejected as overkill (`ui-patterns.md`
→ long operations) — the decision was that one process could keep the same *staging*, logically, and this
is what that means in practice. What was written down at the time was only the rejection, so the rule was
not there to fire when the duplicate sweep was added *inside* the sync's ingest transaction. It reads the
whole ledger; on a real database it took 109 seconds, and for all 109 the sync's own request could not
return, the progress panel sat frozen behind it (the running marker is cleared only once the response is on
its way), and every unrelated write failed with `database is locked`. Nothing about it was slow in the
"network" sense — it was a query holding a lock it had no business holding.

Two corollaries worth keeping in mind when adding a step to an ingest path. **A stage that only *reads*
still belongs outside**: a long read inside a write transaction blocks writers exactly as a long write
does, because the lock is held from the transaction's first write until its commit. And **a stage whose
result no response depends on has no reason to be inside at all** — the sweep and the rescan both feed
surfaces read later, so both now run after the commit, in their own connections, guarded so a failure in
either cannot fail the ingest that already succeeded.

**A file import holds its write transaction from first row to commit**, which the rule above allows:
there is nothing to fetch between rows, and an import that fails halfway leaves nothing behind. Two consequences follow. Its progress cannot be read back from the
database the way a sync's is, so the run reports into an in-memory registry instead
(`services/import_progress.py`), keyed by a name the browser sends with the upload and by tenant, present
only while the run is; the browser polls `GET /import-export/run-progress/{id}` beside the upload's own
request. And the endpoint does its work on the threadpool (`run_in_threadpool`), not on the event loop —
work done in an `async def` body holds the loop for its whole duration, so the poll, and every other
request, would be answered only once there was nothing left to report.

**An expression in a predicate needs an index on that same expression** — SQLite matches the expression
textually, not algebraically, so a function around a column silently opts the query out of every index on
it. `idx_txn_amount_round` exists for that reason: the cross-account duplicate sweep joins on
`ROUND(amount, 2)`, and until the index existed it scanned the whole ledger per row, which is how one
card's sweep reached 109 seconds. The cost is invisible until the table is large, so the check belongs at
writing time, where `EXPLAIN QUERY PLAN` costs a minute.

**But the first question is whether the expression is right, not whether to index it.** The money-movement
candidate lookup (`_amount_window_rows`) matched on `ROUND(ABS(amount), 2)` and so could use no index
either — the obvious fix being a second expression index beside the first. The better fix was to delete the
`ABS`: it was there because two callers share the helper and want *opposite* sign relationships (a
transfer's equal-and-opposite twin; a payment's same-signed corroborating charge), so comparing magnitudes
served both by serving each one loosely. Each now states its own sign, which is both more precise — an
opposite-signed refund could previously corroborate a payment and keep a real row from importing — and
indexable by the index that already existed. A predicate that cannot use an index is often a predicate
that is saying more than it means.

**Commits are genuinely durable, and cheap enough to take often.** No `PRAGMA synchronous` is set, so it is
SQLite's default `FULL`: each commit fsyncs the WAL and survives power loss, not merely process death. The
WAL being append-only also guarantees ordering — a later commit cannot survive without an earlier one. At
roughly a millisecond each they are noise beside anything network-bound, which is why the sync path commits
per page rather than batching.

### Storage layers

Luma uses several distinct storage layers for working state.

#### Browser-local storage

- **Lives in:** browser `localStorage` and browser `sessionStorage`

- **Lifespan:** `localStorage` survives reloads on the same browser profile until cleared; `sessionStorage` lasts only for the current browser tab/session

- **Contains:** browser-specific remembered identity selection (a convenience auto-select; the session cookie is the source of truth), import draft/fallback state, migration fallback values from older UI preference storage, and other machine-local or browser-local UI state that should not be treated as durable shared preference data

#### Frontend session state

- **Lives in:** React state in the running frontend session

- **Lifespan:** lasts until page reload, app restart, or active user/profile change

- **Contains:** in-memory copy of loaded user/profile preferences, transient edit drafts, open/closed UI state for the current interaction, and other short-lived state needed to keep interaction responsive

- **Key files:** `frontend/src/lib/UserPreferencesContext.jsx`, `frontend/src/lib/api.js`

#### The two databases, and what separates them

The split is by **whose data it is**, not by how sensitive it is. Everything the user puts into the app —
transactions, accounts, owners, categories, rules, tags, import history, and their UI preferences — lives
in the **data** database, so a data backup carries the whole of it and restoring one restores the user's
work intact. What the *application* needs in order to run — identities, the vault key slots — lives in the
**control** database, which is why it is not part of a data backup and why a fresh one can be created
beside existing data without disturbing it.

The one deliberate crossing is worth knowing: **data-connection secrets sit in the data database**, even
though they read as application state. They are stored encrypted (`provider_config.secret_enc`,
`plaid_item.access_token_enc`), and the key that opens them — the vault-wrapped DEK — stays in the
control database. That separation is the point: both files have to be brought together to reach a live
credential, so a copy of either one alone does not.

Enumerating each table here is not worth it — contents move (preferences did, precisely so that backups
would carry them) and a stale list is worse than none. `data-model.md` is authoritative on what any
particular field means.

#### Identity records in the control database

- **Lives in:** the control database (`luma-control.db` in the configured data directory)

- **Lifespan:** durable until explicitly deleted

- **Contains:** the single `user_account` table — one identity concept for both modes. Perimeter-off identities are passwordless rows (unset-password sentinel); enabling sign-in assigns passwords/roles to the same rows. There is no separate local-profile table.

- **Properties:** perimeter-off identities are picked from the chooser in `frontend/src/App.jsx`, which establishes a `pwless` session via `POST /auth/select-identity`; the same rows become authenticated users when the perimeter is on

#### Application data database

- **Lives in:** the data database (`luma-data.db` in the configured data directory)

- **Lifespan:** durable application data until changed, deleted, restored, or replaced

- **Contains:** everything the user enters or imports (see the separation above), plus the lifecycle rules below

- **Account lifecycle note:** account rows can participate in a parent/child merge model for reissued account numbers, and child accounts can move through a recoverable trash state before permanent cleanup folds their references into the parent

- **Transaction lifecycle note:** transactions also support a recoverable soft-delete via `txn.trashed_at` — every user-facing read filters trashed rows out, but they stay in the table until the user empties the transaction trash from Settings. Neither trash is auto-emptied; both require a manual action. Confirmed-duplicate rows (`rejection_reason='duplicate_confirmed'`, set by an explicit Reject or by a merge-time auto-promotion) are soft-deleted through the same `trashed_at` mechanism but are intentionally excluded from both the Settings → Trash view and the empty-trash delete: they are dedupe artifacts owned by the duplicate report, not user deletions, and their restore paths (account detach for `auto_merge`, "undo reject" for `user`) depend on the row surviving — so the manual Trash must never be able to remove them.

- **Account regrouping note:** dragging one merged parent onto another top-level account flattens the dragged group's visible members under the new parent instead of preserving a nested account tree

#### Developer reset tools

When `LUMA_DEVELOPER_OPTIONS=true`, the Settings page exposes developer reset actions that clear these layers selectively:

- **`Clear browser-local state`:** clears browser `localStorage` / `sessionStorage`

- **`Clear saved preferences`:** clears the current user's preference values (`ui_preference` rows for their scope) in the data database

- **`Clear import memory`:** clears backend import-memory data stored in the main application database

- **`Reset to first-run`:** deletes every `user_account` identity and reloads to the welcome screen. In auth mode it first turns sign-in protection off (admin-gated) — which drops to local mode so the identity endpoints are reachable and the keep-one-admin guard no longer applies — then removes all users (the current session's own identity last, so deleting it doesn't 401 the rest). Passwords/2FA/recovery codes go with the accounts. `Clear all` performs this same reset plus the preference/import-memory/browser clears.

These resets remain separate because they target different storage layers with different lifespans and different effects on startup behavior.

The separation is important because "resetting the app" can mean very different things in practice. Browser-local troubleshooting, preference cleanup, import-workflow cleanup, and resetting to first-run are all recoveries with different blast radii, so the tooling keeps them explicit instead of hiding them behind one broad reset.

## Cross-platform approach

Luma is intended to run on:

- Windows

- Linux

- macOS

- Raspberry Pi / ARM Linux

Where commands differ, the repo should provide script wrappers or document the differences clearly in `README.md`.

**Running it as one thing.** `python -m backend.desktop` is the standalone mode: it serves the SPA and the API from a single process on loopback and opens a browser at it, so no second process and no proxy is involved. Two details there are load-bearing rather than incidental. The bind is `127.0.0.1` but the URL handed out is `http://localhost:<port>`, because a WebAuthn Relying Party id has to be a domain — opening the address form would disable every passkey vault slot with nothing on screen to explain why (see *Token vault & transport security* for the two preconditions). And the port — `FRONTEND_PORT`, since the browser's port carries that name in every topology and this process is the frontend, so `BACKEND_PORT` is not read — is preferred-not-guaranteed, falling back to an ephemeral one when the configured port is busy; nothing durable is keyed to it, since cookies are not port-scoped and an RP id is the host alone.

**The same launcher is the LAN server.** Server mode (`SERVER_MODE`, or `--server`) is this process with the desktop conveniences withheld — no browser, no in-app stop, no joining a running instance — and the port made a requirement, because a reverse proxy on the same machine is configured with it. The bind stays loopback where a TLS proxy is what the network reaches, and follows `FRONTEND_HOST` where the process is put on the network itself, over plain HTTP. `operations.md` → *LAN server* has the operator's view.

A lockfile in the data directory records the port so a second launch opens a tab against the running instance instead of starting a second process onto the same SQLite pair. It records a port, not a claim of liveness — it survives a crash, so `/api/health` is what settles whether the recorded instance is really there. It only sees instances the launcher started, which is why falling back off a busy configured port says so rather than doing it silently: a separately-started `uvicorn` on the same databases is exactly what that case usually means.

Opening a browser is convenience, not contract. No opener on any platform reports success usefully — `webbrowser.open` returns true as soon as a child process exists, and `explorer.exe` exits non-zero even when it worked — so the outcome is never claimed and the printed URL is what the user is meant to rely on. WSL takes its own path (`wslview`, then `explorer.exe`) because `xdg-open` there walks a list of Linux browsers the distribution does not have and prints a failure for each, producing a wall of errors that reads as a crash while the server is running normally. `--no-browser` skips the attempt entirely.

**Packaged builds distinguish two roots.** A checkout has one directory that is both "where the code is" and "where the app sits"; a PyInstaller onefile build does not, and conflating them loses data. `runtime_config.bundle_root()` is where resources shipped *inside* the app live — the built frontend — which in a frozen build is the temporary directory PyInstaller unpacks to and then deletes on exit. `runtime_config.install_root()` is where the executable sits, and is what a portable copy keeps its databases and its optional `.env` beside. Reading resources from the install root finds nothing; writing databases into the bundle root loses them when the app closes.

`anchor_relative()` follows from that: a relative `DATA_DIR` (or `DB_PATH` / `CONTROL_DB_PATH`) resolves against the install root **in a packaged build only**, so a portable copy behaves the same however it was launched, while a checkout keeps the working-directory meaning every existing install already depends on. This is also why the portable zip ships no configuration file — the stock `DATA_DIR = "."` default already means "beside the executable" once frozen. `scripts/luma.spec` and `scripts/build_desktop.py` produce the artifact; `backend/requirements-build.txt` holds the build-only dependency, deliberately outside the runtime requirements.

**A packaged build carries the license, and the About page prefers the published one anyway.** The binary is a *conveyed* copy, so the AGPL requires the license to accompany it — `scripts/luma.spec` places `LICENSE` at the bundle root, where `runtime_config.bundled_license_path()` finds it in a packaged build and in a checkout alike. `GET /api/app/license` serves that text, and the auth status payload reports `bundled_license_available` so the UI knows whether a fallback exists before looking for one.

**The license reaches a recipient by two independent routes, because they serve people who never meet.** `scripts/build_desktop.py` writes a plain `LICENSE` beside the executable in the Windows zip, the Linux tar and the macOS disk image (and each `README.txt` points at it): that is the copy a downloader, a packager or a license scanner finds, and the only one readable when the binary will not run at all — wrong architecture, an unsigned build the OS refuses, a machine that never launches it. The copy inside the bundle serves the opposite case: someone using a *hosted* instance over the network never receives the archive, and the About page is the only license they can reach. Neither route covers the other's audience.

**The About page shows one license link, and it prefers the local copy.** Same-origin, no network, and identical text — the AGPL is immutable, so there is no fresher copy to defer to. When a build ships without one the link falls back to the FSF's canonical text (`LICENSE_CANONICAL_URL`), deliberately not this project's own published copy: a fork edits a repository URL as easily as it edits a file, so the only outward link that anchors anything is the one no fork controls. Linking both at once was the earlier arrangement and bought nothing.

**Probing the repository to choose between them was tried and removed.** Revealing a local link only when a probe failed meant one outbound request to github.com every time the panel rendered — contradicting the README's promise that the app makes no outbound request except for an action the user explicitly asked for ([README.md](../README.md), *Local unless told otherwise*). Every link on the page is a plain anchor, so nothing is fetched until a click; that is what keeps the promise intact. `navigator.onLine`-only gating would also have kept it (the flag is local, no request) but reports true on a LAN with no route out, which is the air-gapped shape that matters. Two further ideas were rejected: verifying the installed file against a shipped hash (a modified build ships a matching hash just as easily), and calling the local file *unverified* (the distributed copy is verified — what cannot be known is the state of that path at run time, so the page names what it serves rather than characterising it).

**Checking for a new version is the one request no click directly causes, and it is opt-in for that reason.** The same promise that removed the probe above governs this: the check is off until someone switches it on — the welcome screen asks, and Settings → About holds the switch — so the request still follows from a choice the user made. `services/update_check.py` asks GitHub for the project's latest published release and compares its tag against `APP_VERSION`. Four properties are deliberate. It is **install-wide**, held in the control database's `app_setting`, because the server makes the request and there is one answer per install; switching it on and *Check now* are admin-or-local, as other statements about the install are. It is **request-driven on a watermark** (`MIN_INTERVAL_HOURS`), called from `App.jsx` when the data scope activates, because there is no scheduler here; the watermark is written before the request and advances on failure too, so an install with no route out does not retry on every load. **Nothing in the reply is trusted beyond a version number**: a tag that does not parse as `vX.Y.Z` is ignored and the link shown is a constant, so a tampered answer can at most claim a version exists. And the request **carries nothing about the install** — no version, no identifier — which is what keeps it from being telemetry; the address it comes from is all the release host learns. Whether an update is available is decided at read time against the running version, so the Tasks reminder clears itself after an upgrade; its dismissal key carries the version, which is what makes a dismissal cover one release and lets the next raise it again. Nothing is downloaded or installed: a kit, a container and a checkout each update differently, and replacing a running program is a larger trust decision than reading a version number.

**Two distribution forms, declared at build time.** Where writable data defaults to follows from *how a copy was distributed*, not from which OS runs it. A **portable** copy — the Windows zip or the Linux tar — keeps its databases beside the executable; an **installed** one keeps them in the per-OS user-data directory (`%LOCALAPPDATA%\Luma` — local rather than roaming, since a roamed SQLite file resolves last-writer-wins on a logon sync; `~/Library/Application Support/Luma`, `$XDG_DATA_HOME` or `~/.local/share` plus `luma`), which is what an artifact placed somewhere the user does not own, and replaced wholesale by an upgrade, needs. The two are otherwise the same binary, so nothing observable at runtime distinguishes them: `scripts/luma.spec` bakes the answer into the bundle as a one-word file, `LUMA_DIST_FORM` selects it at build time, and `runtime_config.distribution_form()` reads it back. A file in the bundle rather than a generated module, so the signal travels inside the artifact and no build can leave one behind in a checkout.

A checkout is recognized rather than declared, and keeps the working-directory default every existing install depends on. A build whose declaration is missing or unrecognized falls back to what its platform can support, which is **installed on macOS and portable everywhere else** — "beside the executable" there resolves inside `Luma.app/Contents/MacOS`, so guessing portable would lose data rather than merely misplace it. `scripts/luma.spec` refuses outright to produce a portable macOS build for the same reason. The same signal moves the optional `.env`: an installed build reads it from `user_data_dir()` rather than `install_root()`, and deliberately from `user_data_dir()` rather than `data_dir()`, since that file is one of the things that may *set* `DATA_DIR`.

**The build stamp rides the same mechanism, for a different kind of fact.** `APP_VERSION` is bumped by hand at release time, so it names a release rather than a build: every artifact made between two releases reports the same version. `scripts/build_stamp.py` derives the commit with `git describe` during packaging, `scripts/luma.spec` writes it into the bundle as `build-stamp`, and `runtime_config.build_stamp()` reads it back for the About panel and both logs' start lines. Only a frozen copy reports one — a checkout's commit is a `git` command away, and a stamp left in a working copy would be stale the moment anything was committed, so the reader refuses one there even if the file exists. Absent is also what a build with no repository to ask looks like. See `docs/releasing.md` → *What identifies a build*.

**TLS trust comes from the operating system, not from this repository.** `backend/main.py` calls `truststore.inject_into_ssl()` during bootstrap, before the app exists, so certificate verification uses the macOS Keychain, the Windows certificate store, or OpenSSL's system paths on Linux. This is a packaging consequence rather than a preference: a frozen macOS build carries an OpenSSL whose default CA path points at the *build* machine's layout, so with nothing done it has no trust store at all and every outbound HTTPS call fails with "unable to get local issuer certificate" — Linux and Windows escape it only because their system stores happen to sit where their Python looks. Shipping `certifi` instead would have worked too, at the cost of a pinned snapshot that ages, ignores roots the user installed, and keeps trusting roots the OS has since distrusted. Both paths are pinned by `backend/tests/test_system_trust_store.py`: the stdlib one, and urllib3's separately bound reference, which is what the Plaid SDK verifies against.

**The app can stop itself, but only where that makes sense.** A desktop user has no good way out otherwise: a macOS bundle's Dock "Quit" is an Apple Event, and answering one needs a Cocoa event loop, while `backend/desktop.py` deliberately keeps uvicorn on the main thread because that is what makes Ctrl+C clean. So `backend/routers/app_control.py` exposes `POST /api/app/shutdown`, and the navigation panel offers "Shut down Luma" beneath Sign out. The capability is **registered rather than assumed**: the launcher hands over a handler when it creates the server, and a deployment started with plain uvicorn has none, so the route refuses and the UI never draws the control. That asymmetry is the point — on a supervised LAN box, stopping the process from a browser is either futile or a way for one signed-in user to take the service from everyone else. The handler asks for uvicorn's *graceful* shutdown after the response is sent, so the caller learns the request was accepted rather than watching the connection die.

**The navigation pane can say which database this copy is open on**, because on a machine running more than one of them nothing else on screen distinguishes a checkout pointed at a restored backup from one pointed at real data. `app_config.data_location()` reports the ledger and control-database paths — read from the modules that hold them, so the line cannot name a file the process never opened, and resolved to absolute form because a checkout's default is relative — plus a shortened `~`-prefixed form for display and a `show_by_default` flag.

That flag is a **default for the user preference in front of the line, not a rule**. It arms itself where "which database is this?" is a live question: the databases are somewhere other than this build's own default, or this copy is a `checkout` (a working copy is a development context by definition — tying it to `developer_options` instead would miss it, since that flag gates destructive reset tooling and plenty of people working on the app never turn it on), or developer options are on. Because the backend's answer is the preference's *default* rather than a seeded value, an untouched preference tracks the installation — setting `DATA_DIR` later makes the line appear on its own — while an explicit choice wins in both directions from then on.

**The paths are admin-or-local information, and the gate lives on the server.** `/auth/config` already restricts them, so the status payload carries `data_location` only for a session that could read it there (`_session_can_manage_config`, the non-raising twin of the guard that endpoint uses); every other session gets no field, and the client renders nothing rather than holding a second copy of the rule. The toggle that controls the line sits in Administration's *Startup configuration* panel for the same reason — that section is already behind the same gate, so one condition covers the control and the thing it controls.

**Every way of stopping converges on one line.** `server.should_exit` is uvicorn's graceful path, and the in-app control, the macOS wrapper's death, and the stop signals all set it — so in-flight requests finish, the lockfile is released, and the exit is the same however it was asked for. Signals need `backend/desktop.py` to install handlers of its own, for two different reasons. **SIGTERM** is already handled by uvicorn, and that is the problem: `Server.capture_signals` restores the *previous* handler on the way out and re-raises what it caught, so a SIGTERM that has just shut the server down cleanly is delivered a second time to `SIG_DFL`, which terminates the process before the lockfile is released or anything is printed — and SIGTERM is exactly what the Dock's Quit, Command-Q, and `systemctl stop` send. Registering a handler makes uvicorn save *that* as the previous one, so the re-raise lands somewhere harmless. **SIGHUP** is not in uvicorn's handled set at all, so this is the only handler it gets; without one, closing the terminal a portable build was started from kills it outright. **SIGINT** gets one too, because a Ctrl+C can arrive twice: a terminal signals its whole foreground process group, and the packaged Linux build's onefile bootloader, receiving it as well, forwards it to the server. uvicorn then re-raises both, and with Python's default handler in place `asyncio.run` has installed its own, which raises `KeyboardInterrupt` on the second — a traceback after a clean stop, first seen on a Raspberry Pi, where the two deliveries land far enough apart not to merge. For the same reason a second SIGINT is never uvicorn's force quit (`_GracefulServer`): every stop is graceful, and `GRACEFUL_SHUTDOWN_SECONDS` (5) bounds the wait for in-flight requests instead of a second keypress. The handlers *request* a stop rather than ignoring the signal, which is what covers the window before uvicorn's own exist — a quit during a slow startup is honoured instead of leaving the macOS wrapper to wait out its kill timer.

**Every open browser finds out, without anything polling.** A tab that did not press the button used to have no idea, and decayed into unexplained failures. The signal was always arriving and being discarded: a request to a port nothing is listening on is refused immediately, so `fetch` rejects within milliseconds and every call the app makes is already its own liveness check. `frontend/src/lib/backendLiveness.js` is what acts on it. The api layer routes every request through one wrapper that reports rejections; a rejection carrying no `.status` never reached a server (one that does means the server answered, and a deliberate `AbortError` means the app cancelled it). One failure is not proof — a graceful shutdown closes idle keep-alive connections under requests that would retry fine — so a failure asks `/api/health`, coalesced so a burst of simultaneous failures probes once, and only a failure of *that* is reported. Two additions cover what a failed request cannot reach: `BroadcastChannel` tells the other tabs, so one of them running into a failure is enough and the in-app shutdown announces itself before anything has failed anywhere; and a probe on returning to visibility covers the tab that has been idle — the Dock-Quit case, where the app was quit and nothing has been requested since, and equally the machine that has been asleep. **Route chunks are the third source of the same news**, and the one that is easy to miss: the app code-splits every page, and `React.lazy()` loads them with dynamic `import()` rather than `fetch`, so a stopped backend breaks any not-yet-loaded page without the api layer hearing about it. Left unreported that surfaced as `AppErrorBoundary`'s "Something went wrong" over the whole app — the boundary sits outside every provider, so it replaces the notice that would have explained it. The loaders now report into the same watch, and the boundary tells the two apart: a module-load failure cannot be judged from the error alone (a stale chunk hash after a rebuild fails identically against a live server), so it is reported and the probe decides, and the boundary renders neither verdict until it settles.

The state latches, because every piece of state on screen belongs to a process that no longer exists — a restart may be on a different port, under a different session, against a different database. **Coming back is therefore a reload rather than an unlatching**, and the watch inverts once stopped: the gestures that looked for a failure now look for a return, joined by any click or keypress, since somebody looking at the notice just after starting the app again is the likeliest moment for the answer to have changed. A confirmed return is broadcast like the stop was, so every tab reloads rather than each waiting for its own gesture. The notice carries a "Check again" button because a press that finds nothing must be distinguishable from a press that did nothing — the silent gesture probes report only success, by way of the page reloading.

**macOS is packaged differently, and the launcher notices.** Everywhere else the artifact is a onefile binary in a zip (Windows) or a `.tar.gz` (Linux); macOS gets a onedir build placed inside a `Luma.app` bundle, shipped in a drag-install `.dmg`. The bundle is assembled by `scripts/build_desktop.py` around a small native wrapper (`macos/main.swift`) rather than by PyInstaller's `BUNDLE`, because **a Python process cannot be a macOS application**: LaunchServices expects a regular app to check in with the window server, and one that never does bounces in the Dock for the length of the launch timeout before being marked as failed, after which the Dock offers only Force Quit. Declaring it background-only avoids the bounce by having no Dock presence at all. The wrapper is the application; the server is its child. The two watch each other in both directions — the wrapper holds the write end of a pipe whose read end is the child's stdin, so a *zero-length* read there means the wrapper is gone (a kernel guarantee that survives SIGKILL, which is what makes it a dead man's switch), while the wrapper's termination handler quits the app when the server exits on its own. onedir also matters here: a onefile bootloader forks, so the signal the wrapper sends on quit would arrive at the wrong process. The roots still land where they should — `bundle_root()` follows PyInstaller's unpack directory inside the bundle, and `install_root()` (which points inside `Contents/`) is never consulted, since the installed form reads neither its data nor its `.env` from there. What changes is output: an application started by LaunchServices has no terminal, so `backend/desktop.py` redirects both streams to `luma-desktop.log` beside the data. It detects that by the environment variable LaunchServices sets rather than by asking whether stdout is a terminal, because that question also answers "no" for a pipe — and diverting output whenever something captures it would take the diagnostics away from `scripts/smoke_artifact.py`, which captures it precisely to explain a failed launch. The same answer decides what the startup line *says*: where it is going to a log rather than a terminal, the advice to press Ctrl+C is dropped, since there is no session to press it in and the log is read after the fact by someone who cannot act on it.

## Where to change things

- **New API behavior:** add or update a router in `backend/routers/`

- **Schema changes:** update `init_db` **and** register a `@migration(N)` (plus a `POST_RESTORE_DATA_INIT[N]` step when the migration *derives* data from existing rows) in `backend/db/database.py` — see "Schema evolution" in `docs/data-model.md` for the full checklist and the migrations' two-halves / post-restore-data-init contract

- **Shared transaction editing/display behavior:** update `TransactionRow.jsx`

- **Shared detail-panel behavior:** update `detailShared.jsx`

- **User-facing setup or behavior changes:** update `README.md` and possibly `CHANGELOG.md`

- **Version bump:** `APP_VERSION` in `backend/runtime_config.py` is authoritative — the API reports it and the packaged artifact is named for it. `frontend/package.json` and `backend/pyproject.toml` carry their own copy because npm and Python packaging each read theirs before any of our code runs, so neither can derive it. `backend/version_sources.py` is the single statement of where those literals live, shared by `backend/tests/test_app_version.py` (which fails when they disagree, and if the literal reappears in application code) and `scripts/release.py --set-version` (which rewrites all three together). Rewrites are targeted substitutions rather than parse-and-reserialize, so a version bump stays a reviewable one-line diff per file.

## Open

Decisions still owed on this document's subjects, each naming the live backlog item that will settle it.
Rejections and obstacles are **not** here — they sit inline beside the subsystem they are about, which
is this doc's convention and the more findable one. See `AGENTS.md` → *Where rejections, obstacles and
owed decisions go*.

- **Dependency-based query-cache invalidation**, replacing the hand-wired refresh map. Parked and
  possibly never: it is worth doing only if transaction-derived views proliferate enough to hurt.
  → [`backlog/query-cache-invalidation.md`](backlog/query-cache-invalidation.md)
- **Extracting `ImportRuleSuggestionReview`** into prop-driven seams — the one remaining piece of the
  import/export refactor, and a code task with no doc home of its own.
  → [`backlog/import-rule-suggestion-review-extraction.md`](backlog/import-rule-suggestion-review-extraction.md)
- **Where the build-phase technical record lands.** Migration numbers, AAD schemes, endpoint names and
  payload-format versions still sit in a residual backlog file rather than here; relocating each needs
  checking against what this document already says — roughly twenty verifications, where a wrong call
  deletes the only record of something like *migration v18 folds `plaid_item` rows in carrying the
  ciphertext verbatim*. It wants its own pass rather than the tail end of another. Note that several code
  comments cite that file **by phase number** (`db/database.py` migrations v18/v20,
  `providers/config.py`, `routers/providers.py`), so the pass has to repoint them rather than only move
  the prose — and a citation naming a phase number rather than a model claim is still correct against the
  residual stub, so it should be left alone rather than force-fitted to a topic doc. This is the last
  thing keeping that file alive.
  → [`backlog/security-and-deployment-model.md`](backlog/security-and-deployment-model.md)
