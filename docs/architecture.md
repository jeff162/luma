# Architecture

How Luma is built: its structure, its data flow, and the contracts between subsystems, each with the
reason for it.

Other questions have their own document: what a field means is in `data-model.md`; the assumptions the
security design rests on are in `security-model.md`; running an instance is `operations.md` and building
one is `releasing.md`; adding a data source is `building-a-connector.md`; conventions shared across UI
surfaces are in `ui-patterns.md`.

## Contents

- [High-level shape](#high-level-shape)
- [Backend structure](#backend-structure)
- [Frontend structure](#frontend-structure)
- [First run and demo data](#first-run-and-demo-data)
- [Data flow](#data-flow)
- [Major subsystems](#major-subsystems)
  - [Transactions and summaries](#transactions-and-summaries)
  - [Rules and categorization](#rules-and-categorization)
  - [Transaction tags](#transaction-tags)
  - [Attached documents](#attached-documents)
  - [Multi-payment purchases](#multi-payment-purchases)
  - [Recurring series](#recurring-series)
  - [Import / export](#import--export)
  - [Detail panels](#detail-panels)
  - [Help / FeatureExplainer](#help--featureexplainer)
  - [Configuration layers](#configuration-layers)
  - [Identity, access & deployment model](#identity-access--deployment-model)
  - [Token vault & transport security](#token-vault--transport-security)
  - [Data providers (the aggregator seam)](#data-providers-the-aggregator-seam)
  - [Database concurrency](#database-concurrency)
  - [Storage layers](#storage-layers)
- [Cross-platform approach](#cross-platform-approach)
  - [Standalone and server mode](#standalone-and-server-mode)
  - [Stopping](#stopping)
  - [Liveness in the browser](#liveness-in-the-browser)
  - [Packaged builds](#packaged-builds)
  - [Distribution forms and the build stamp](#distribution-forms-and-the-build-stamp)
  - [macOS packaging](#macos-packaging)
  - [TLS trust](#tls-trust)
  - [License](#license)
  - [Checking for a new version](#checking-for-a-new-version)
  - [The data-location line](#the-data-location-line)
- [Where to change things](#where-to-change-things)
- [Open](#open)

## High-level shape

Luma is a local-first web application with:

- a **FastAPI** backend in `backend/`
- a **React + Vite** frontend in `frontend/`
- **SQLite** as the persistent store

The browser talks only to the local backend API. Application data and persistence are local; external
network dependencies are limited to optional integrations such as Plaid and SimpleFIN Bridge.

**One origin in every topology.** The SPA and the API always share an origin: the Vite dev server
proxies `/api` in development, and a downloaded build or the container image has the backend serve
`frontend/dist` itself (`backend/spa.py`), so one process is a whole application. `CORS_ORIGINS`
therefore defaults to empty, since no shipped topology makes a cross-origin call. A path that is not a
real file returns `index.html` for the client router, except under `/api`, which stays a JSON 404.

**Every response passes three outermost middlewares** (`backend/http_hardening.py`): a host check that
refuses a request addressed to a name not this server's, a cookie pass that adds `Secure` to anything set
over HTTPS, and the security headers (framing limited to the app's own origin, `nosniff`, a content
policy, `Referrer-Policy: same-origin`, and `Cache-Control: no-store` on everything but the hashed
assets). FastAPI's generated API pages are switched off. The policy's script hashes are read from the built `index.html` at startup (`spa.py`), so the
inline theme script is allowed without a hash to keep in step by hand. The session cookie itself is
`SameSite=Strict`. What each defends is in `security-model.md` → *Other websites in the same browser*.

## Backend structure

- **`backend/main.py`:** bootstrap, middleware, and router registration
- **`backend/db/database.py`:** SQLite connection handling, schema creation, migrations, and seed data
- **`backend/routers/`:** feature-oriented API endpoints
- **`backend/services/`:** shared backend logic such as categorization and crypto helpers
- **`backend/spa.py`:** serves the built frontend with the client-route fallback
- **`backend/desktop.py`:** the standalone entry point — starts the server on loopback, opens a browser
  at it, and reuses a running instance rather than starting a second one onto the same databases

The backend uses explicit SQL and feature-oriented router modules rather than an ORM.

## Frontend structure

- **`frontend/src/App.jsx`:** app shell — navigation, bootstrap, and everything drawn around the page
- **`frontend/src/AppRoutes.jsx`:** the route table. It is separate from the shell so it can be mounted
  without the shell's bootstrap, auth and preference state, which is what makes the table testable.
  `lib/routeChunks.js` owns the lazy loaders it and the shell's idle prefetch share
- **`frontend/src/pages/`:** top-level screens such as Dashboard, Transactions, Rules, and Import
- **`frontend/src/components/`:** shared UI and interaction building blocks
- **`frontend/src/lib/api.js`:** the one API wrapper the frontend uses
- **`frontend/src/lib/FilterContext.jsx`:** shared date, amount and chip filtering state
- **`frontend/src/lib/filterParams.js`:** the one translation of the filter chips into API parameters
  (the frontend half of the facet registry — see `data-model.md` → *One facet registry, both halves*)
- **`frontend/src/lib/AppSessionContext.jsx`:** bootstrap/session metadata (the active preference
  subject, the database instance id) so pages reuse shell-loaded auth state instead of re-fetching it

Shared interaction surfaces:

- **`TransactionRow.jsx`:** transaction display and editing
- **`detailShared.jsx`:** the detail-panel shell, chart, and lazy loading
- **`components/ui.jsx`:** visual primitives — cards, buttons, floating panels, overlays, form control
  styling, and the confirm/notice/text-entry dialogs
- **`lib/uiInteractions.js`:** hooks for dismissible layers, popups, escape handling, and transient text
  editing. Escape goes through one shared stack: each active layer registers with `useEscapeAction`, and a
  press reaches only the layer activated most recently
- **`components/TransientTextInput.jsx`:** the single-field edit control where Enter/blur commits and
  Escape restores the pre-edit value

A frontend interaction uses these primitives rather than a page-local version unless it has special
requirements, because popovers, inline editors and dismissal rules rebuilt per page drift apart.
`shared-components.md` is the index of what exists.

## First run and demo data

- **Local-mode onboarding** lives in `App.jsx` as part of bootstrap: when auth is off and no identity
  exists, a welcome flow creates the first identity and navigates **once** to a chosen data-entry
  surface (import a CSV, connect a provider, load the demo dataset, or an empty app). The shell is
  blocked until an identity is selected because preferences are scoped to it. The destination is a
  one-time navigation and does not touch the persisted startup-route preference, so later launches land
  on the dashboard.

- **The demo dataset is built through the real pipeline.** `load_demo_data` generates CSV files and
  imports them via `run_import_core`, and an Amazon order history via `run_amazon_import`, passing its
  own `conn` so the whole build is one transaction. The result has real batches, coverage, dedupe
  results, wallet funding pairs, a rule alert's hit, stated balances (from the bank file's balance column, and two entered by hand), saved data sources and a reconciliation report. What cannot arrive in a file — a split, a
  receivable and its repayment, an attached receipt, a rule with an amount range, a multi-payment
  purchase, rule suggestions already accepted, deferred or discarded — is layered on by `db/demo_examples.py` through the same services the endpoints call. Its tests assert
  through the feature (each recurring signal kind fires, a document's text was extracted) rather than by
  row count, because the dataset exists to demonstrate features. It is also what the README screenshots
  are captured from (`npm run screenshots`), so it carries thirteen months of steady, household-sized
  activity and only the last week arrives unreviewed. Monthly rows fall on the same calendar day each
  month, never a fixed count of days apart, so every month's total is steady whatever day the ledger
  loads.

- **Demo mode blocks every path that brings data in.** Loading writes a marker (`demo_data` in the data
  DB's `import_workflow_state`). While it is present the backend answers 409 to CSV import, the Amazon
  import, data-source connect, both restores (data and credentials) and sync. Because nothing non-demo
  can be added, "clear demo data" may wipe the whole tenant data DB. The credentials restore is in the
  set because it inserts `connection` rows, and sync because it writes through one. **A new path that
  brings data in must take this gate.** The shell fetches the status once per tenant and shares it as
  `demoLoaded` in the app session; each gated control disables itself from that.

- **Clearing** (`POST /auth/demo-data/clear`) refuses unless the marker is present. It reuses
  `_wipe_user_data_tables`, the wipe restore uses, then re-seeds the group skeleton. It touches only the
  tenant data DB; identities and credentials are untouched.

- **Loading and clearing are sign-in-protection-off actions; the status is not.** Turning protection on
  leaves loaded demo data in place, still blocking every path that brings data in, so
  `GET /auth/demo-data` answers in both modes and the banner shows. With protection on it reports
  nothing to load, and the banner's Clear stays visible but disabled, naming why.

## Data flow

1. A page reads global filters from `FilterContext`
2. The page calls `api.js`
3. A FastAPI router executes SQL against SQLite
4. The JSON response returns to the page
5. Local state updates

For many inline edits the UI updates first and the API call is fire-and-forget. The backend remains the
durable source of truth and concurrent editing is rare, so responsiveness is preferred over confirming
each write.

**A change made elsewhere reaches an open page through the ledger epoch.** A tablet keeps a backgrounded
page alive for days, and nothing pushes the server's writes to it. `db_meta.ledger_epoch` is moved by a
trigger on every table the Transactions, Dashboard and Recurring pages read (`_LEDGER_EPOCH_SOURCE_TABLES`
in `db/database.py`), and `GET /api/app/ledger-epoch` reports it. `BackgroundCatchUp` (`App.jsx`) runs on
mount, on each return to the foreground and on the first input after two idle minutes: it asks for the
request-driven background work, then compares the epoch with the last value the page knew and, if it
moved, has those pages re-query in place (`useAfterLedgerChange`), then raises the mutation signal so the
server-computed counts refresh. The page's own writes are absorbed by re-reading the epoch after each one
(`lib/ledgerEpoch.js`), so it never reloads to show its own edit. The epoch is separate from
`recon_epoch`, which watches fewer tables because each of its moves recomputes the reconciliation
reports. A third, `rule_reach_epoch`, keeps the owner lens's rule reach
cached (`data-model.md` → *Owner lens*), and a fourth, `balance_history_epoch`, the balance totals' history
flags (`services/balance_totals.py`). Both are moved by triggers scoped to the columns their answer reads,
so the most frequent edits (categorizing, tagging) leave those caches alone.

**The derived caches are filled ahead of the pages that read them.** A start moves `recon_epoch` and
`rule_reach_epoch`, so every cache they stamp is stale until read, and a read that finds one stale runs
the whole computation (seconds at ledger scale). The catch-up therefore ends with `POST
/app/warm-derived-caches`, not awaited, which fills the reconciliation counts and, for a viewer whose lens
is on, the rule reach. Readers that find the same cache stale together share one computation
(`services/cache_fill.py`), so a page asking during the warm-up waits for it instead of repeating it.

**What an account's settings decided at ingest is re-derived when they change.** A rule category (rules
scope by owner and account type) and a wallet pairing (account type, owner and wallet match text) are worked
out when a row arrives and stored, so an edit to the account would leave them stale with no ingest to revisit
them. Every write that changes an account's type, owner or match text calls `settle_account_change`
(`services/account_settings_followups.py`) after its commit, and anything stored that reads account settings
is either re-derived there or worked out when read, as account groups and the owner lens are. One write
does not call it: merging or detaching an account whose own owner is empty changes the owner it resolves to
(`COALESCE(child, parent)`). That case is rare and is left until it matters.

**Preferences are re-read on the same catch-up**, except on mount, where they were just loaded
(`refreshPreferences` in `lib/UserPreferencesContext.jsx`). They are not part of the epoch: the read is
small, and a preference change has no page to re-query. A key this page is still saving, or wrote while the
read was out, keeps its local value, because the server's copy may predate that write. Without the re-read
a page left open would also save its stale copy of a list preference (saved filters) over another device's
edit.

## Major subsystems

### Transactions and summaries

- **Backend:** `backend/routers/transactions.py` — transaction lists, category overrides, merchant name
  edits, and the summary queries behind the dashboard and detail panels

- **Uncategorized contract:** `category_id = NULL` is one stored state. Summaries and tree surfaces may
  expose separate synthetic expense and income buckets for it, so uncategorized credits are not counted
  as expense activity.

- **A write that changes a row's category answers with the row's resolved tags.** `PATCH
  /transactions/{id}/category`, `.../uncategorize` and `.../imported-category` return `{ok, tags,
  blocked_tags}` (`_resolved_tags_response`), as `PATCH /transactions/{id}/tags` does. Clients patch the
  edited row in place rather than refetching it, and tags are inherited from the category, its group and
  the effective account, so only the server can say what the new set is. Any endpoint that moves a
  transaction between categories returns the same shape.

- **Signed monthly totals:** `/summary/monthly-trend` returns signed sums, so a refund in an expense
  scope is a negative contribution. A `view` parameter (`spending` | `income` | `cash_flow`) chooses the
  frame when no category/payee scope is given; for a category scope the sign is flipped for income-type
  categories so received income reads positive. The cross-cutting frames exclude categories marked
  `exclude_from_totals` unless a group or category include chip names them (see `data-model.md` →
  *Reporting assumptions*).

- **Day-precise range totals:** `/summary/range-trend` is `monthly-trend`'s population and sign (one
  shared scope builder) totalled over caller-supplied inclusive date ranges — one row per range in the
  order asked, a zero row for an empty range, at most `RANGE_TREND_MAX_RANGES` per call. It serves the
  single-period trend's same-span mode, where a bar must equal what selecting its range shows and a
  range off month boundaries cannot be rebuilt from monthly rows.

- **Cash-flow monthly split:** `/summary/monthly-cash-flow` returns `inflow`, `outflow` and `net` per
  month over the `cash_flow` population. Its atom is a **leaf category's net for the month**, not a
  transaction's sign: categories that net money in make up `inflow`, the rest `outflow`. That is the rule
  the Sankey uses to place a node, so a month's bars equal the sides of that month's diagram.
  `granularity=year` nets each category over the whole year rather than summing monthly rows, for the
  same reason. It returns no `count`: the split-expansion seam puts one transaction in several buckets,
  so a correct count would need a second read of the source.

- **List filtering:** `/transactions` accepts the same `view`; `cash_flow` applies no category-type
  clause but still drops `exclude_from_totals` categories (with the same named-chip exemption), so a
  drill from a cash-flow node lists the rows its figure came from. `tag_ids` matches on a row's *effective* tags (see *Transaction tags*).

- **Bulk edit:** `POST /transactions/bulk` applies field changes to a selection in one transaction. The
  selection is an explicit id list or `{mode:'filter', filter, exclude_ids}`; filter mode resolves rows
  server-side through `_build_transaction_filter`, the same WHERE the list feed uses, so "select all
  matching" covers rows the client never loaded. Delete is a soft-delete to the transaction trash.
  `set_date` exists only here.

  **An unrecognized filter key is rejected (400), never dropped**, because every filter narrows and a
  dropped key widens the set the actions run against. `_BULK_FILTER_KEYS` is the allowlist; its facet
  half is derived from `FACET_PARAM_NAMES`, so only non-facet filters are named by hand.

#### The shared date filter and its back-step

`FilterContext` owns the cross-app period and a bounded history of prior values (`goBackDate`,
`previousDate`, `canGoBackDate`). Only a chart pin records into it (`pinDateFromChart`): clicking a
trend bar re-pins the period as a side effect of drilling, which is the change a user wants to step back
over. `setDate` and `clearDate` reset the history, because a FilterBar pick is already visible in the
chip. Back restores only the date. `describeDateFilter` names a value for UI and distinguishes three
shapes: `null` (unset, falls back to a page's registered default), the `{start:null,end:null}` sentinel
(explicit all-time, overrides that default), and a real range.

#### Saved filters

A saved filter is a name for one setting of the FilterBar (date, chips and amount), shown as a chip at the
start of the bar. Clicking it replaces the filters in force (`replaceFilters`, which resets the date
back-step like any explicit pick); from then on they are ordinary filters, and the saved copy changes only
through its menu's *Replace with current filters*. Save sits beside Clear all and appears only when the
filters in force are not already a saved filter. The list and whether it is collapsed are per-user
preferences. `lib/savedFilters.js` holds the rules:

- **A preset date is stored by its label and worked out again on apply** (`lib/datePresets.js`), so a
  saved *Year to date* is always the current year. A custom range is fixed.
- **Chips are rebuilt from what they name on apply** (`lib/filterSelections.js`, the same builders the
  picker uses), so a rename shows. A chip whose target no longer exists is kept and marked `missing`
  rather than dropped, because dropping it would widen the filter silently.

### Rules and categorization

- **Storage:** `category_rule`. **Runtime:** the categorizer service.

- **Behavior:** rules are ordered automatically by specificity, after one term the user sets: a rule's
  priority (normal or low), which settles the pairs specificity cannot. See `data-model.md` →
  *Precedence*. A rule can assign a category, scope an
  amount rule to debits or credits, rename a merchant, add tags, and raise an alert. Manually overridden categories are
  preserved; a per-transaction tag edit overrides only that row's rule-derived tag presence.

- **Shared filter facets:** every axis the FilterBar exposes — account (by id or by type), group,
  category, owner, payee, tag, attribute — is declared once in `services/transaction_facets.py` and consumed by every faceted
  endpoint through a `TransactionFacets` dependency and `append_facets`. Facets AND with each other;
  values within one facet OR. The FilterBar's amount filter reaches the same endpoints through
  `AmountFilter` / `append_amount_filter`. Rationale and invariants: `data-model.md` → *One facet registry, both
  halves* and *Attributes — filtering by what a row is*.

- **Owner lens:** a per-user "show only these owners" setting over the scoped pages. The frontend holds
  it in `OwnerLensContext` (the preference, the owner list, and whether the current route is scoped) and
  draws its control once, as a collapsible tab in the top-right corner of the page area (`OwnerLensTab`).
  Transaction reads carry it as `owner_lens` on the facet dependency. Lists a page holds whole are
  narrowed client-side by `ownerLensAdmits` against the owners each item reaches: `owner_ids` on a
  recurring series, `GET /rules/owner-reach` for rules. `GET /recurring/signals` and `GET /tasks` narrow
  on the server so their counts follow. See `data-model.md` → *Owner lens*.

- **Scope by account type:** besides a single owner or account, a rule can scope by account type
  (`category_rule.account_type`), matching through the row's *effective* account type
  (`COALESCE(parent.type, account.type)`, threaded into every SELECT that feeds `rule_matches_row` /
  `categorize_transaction`). Precedence is `account_id` > `account_type` > global, and `account_type`
  is part of the one-rule-per-matcher identity. The PayPal money-movement rules are built on it via
  `create_rule_core`. See `data-model.md` → Accounts / Rules.

- **Applying a match is shared per action.** Every path that runs rules — CSV import, sync,
  `recategorize_all` and its preview count — matches once via `categorize_transaction` and applies the
  result through shared points: tags via `sync_rule_tags_for_transaction`, scalar actions (the merchant
  rename) via `rule_scalar_effects`. One apply point per action is what keeps the paths from diverging
  and makes a new rule action a one-place change. Category *source* policy stays site-specific (import
  has mapping and file-label fallbacks; recategorize preserves a `cleared` marker).

- **An alert is the one action that only arriving rows trigger.** Each ingest path (file and Amazon
  imports, sync, a held duplicate brought in) hands the rows it added to `rule_alerts.record_arrivals`
  inside its own transaction, beside the recurring rescan it owes. No re-apply path calls it, which is
  what keeps a new alert rule from reporting history. The Task reads the stored hits, so the Tasks poll
  stays one grouped query. See `data-model.md` → *Rule alerts*.

- **`recategorize_all` is retain-by-default:** it sets or changes a category or rule tag but never
  strips one, so deleting or narrowing a rule does not un-categorize its history. Clearing a no-match
  row is an opt-in pass scoped by `txn_ids`, used by the rule delete/edit re-evaluation and the
  money-movement "remove a type" path. See `data-model.md` → "How an existing transaction's category can
  change".

- **Starter set (opt-in):** tenant creation seeds only the group skeleton. Starter leaves and rules are
  added on demand via `POST /categories/generate-starter` (`GET /categories/starter-rules` exposes the
  catalog), which backs onboarding, the Categories and Rules pages, and the demo loader. See
  `data-model.md` → Categories / Rules.

### Transaction tags

- **Storage:** `tag`, `rule_tag`, `txn_tag`, `category_tag`, `account_tag`

- **Effective tags** are the union of four sources: direct tags (rule and manual, `txn_tag`), tags on
  the leaf category, tags on its parent group (both `category_tag`), and tags on the **effective
  (top-level) account** (`account_tag` through `COALESCE(parent_account_id, account_id)`, so a parent's
  tags reach its children and a merged child's own tags are dormant until it is detached).

- **Per-transaction override:** `txn_tag.manual_state` is `+1` force-on, `0` neutral, `-1` block. A
  block suppresses the tag on that transaction whatever its source, so an inherited tag can be hidden on
  one row without retagging the category or account.

- **Two chokepoints:** `services/transaction_tags.py` computes live tags (merging the four sources, then
  applying blocks; `get_blocked_transaction_tag_map` exposes the hidden ones), and
  `tag_filter_membership_sql` builds the `tag_ids` filter for the list feed, summaries and export. All
  sources and blocks therefore reach every surface the same way.

- **UI:** `components/TagPickerWithCreate.jsx` is the one surface for browsing and creating tags.

### Attached documents

- **Storage:** `document` rows, files under `documents/` beside the data database, and `document_fts`
  (the search index)

- **Backend:** `backend/services/documents.py` (ingest normalization, atomic writes, extraction,
  reconciliation) and `backend/routers/documents.py`

- **One ingestion seam.** File drop, file picker, clipboard paste (image, text, or `text/html`) and a
  saved `.eml` all arrive as the same multipart upload of *(bytes, media type, filename)*, so a new way
  of choosing a file does not reach the backend. An email is converted at ingest to the document it
  carries. The media type is decided from the file's own header. Oversized images are downscaled once at
  ingest; PDFs pass through byte-for-byte because their text layer is what gets indexed. An identical
  file re-attached to the same transaction is reported as already present, using the ingest digest.

- **A document can be stored before its transaction exists** (`txn_id` NULL) and attached later, which
  moves no file.

- **The bytes are files, not rows**, so file and row cannot share a transaction. The ordering is the
  contract — file first on the way in, row first on the way out — and removal is derived: every
  destructive path deletes rows and then sweeps files the ledger no longer references. Invariants:
  `data-model.md` → *Attached documents*.

- **Serving returns bytes a user supplied**, so it sends the media type recorded at ingest,
  `X-Content-Type-Options: nosniff`, and a sandbox CSP, because a PDF viewer is a scripting host.

- **Search:** document text is indexed in `document_fts` and reached from the Transactions search box;
  `doc:<terms>` narrows to documents only. A row matched inside an attachment carries
  `matched_document` so the ledger can show why it came back, and the matching document entries carry
  the passage that matched, since the viewer hands the file to the browser and cannot point at it.

- **List feed:** each row carries slim document entries (`documents` — id, filename, media type) and
  `document_count`, so the row marker opens the viewer without a fetch.

### Multi-payment purchases

- **Storage:** `txn_link` / `txn_link_member` with `kind='purchase'` — the general association
  primitive, with no schema of its own

- **Backend:** `backend/services/purchase_links.py` (invariants and summaries) and
  `backend/routers/purchases.py`, plus a transaction-scoped read on the transactions router and a
  per-page projection into the list feed

- **Behavior:** several transactions that are one purchase (a deposit and a balance, an instalment plan)
  are grouped so the purchase has a total, each payment an ordinal, and an expected total somewhere to
  sit. It mutates nothing on the member rows, so **no reporting surface knows it exists**. Invariants:
  `data-model.md` → *Multi-payment purchases*.

- **Lifecycle:** a purchase cannot outlive its payments. `trg_purchase_link_prune` drops the link when
  its last member row goes; it is a trigger because the hard-delete sites are scattered.

- **List feed:** each row carries a summary (`purchase` — label, ordinal, counts, totals) rather than
  the sibling payments; `PurchaseEditorDialog` loads the full record when it opens.

### Recurring series

- **Backend:** `backend/services/recurring_detection.py` (detection), `backend/services/transfer_pairs.py`
  (pairing the two rows one money movement leaves behind), `backend/routers/recurring.py`

- **Frontend:** `frontend/src/pages/Recurring.jsx` (route `/recurring`)

- **Storage:** `recurring_series` (+ `rule_id` for rule-backed series), the `txn.recurring_series_id`
  membership link, `recurring_membership_override` (per-transaction pin/exclude), and
  `recurring_signal_dismissal` (the only durable state the anomaly signals have)

- **A scan is idempotent.** It rewrites auto-detected, unconfirmed series and preserves confirmed,
  manual and suppressed ones. It is one function (`scan_and_store`) with an optional `payee_keys` scope,
  called three ways:
  - **On demand:** `POST /recurring/scan`.
  - **Scoped**, as an owed rescan: an import, a sync, a transaction edit or a rule apply records the
    payees it touched in `recurring_rescan_owed` inside its own write transaction, then
    `settle_owed_rescans` reprocesses only those payees after the commit. That is correct because
    detection groups by payee and `reconcile_series` does not disturb out-of-scope rows. A scoped pass
    does not stamp the watermark, since it cannot see cross-payee effects; bulk edits owe once per batch.
    Every scan settles what is owed within its scope, so a failed settle is retried by the next one
    (`data-model.md` → *When a scan runs*).
  - **Full catch-up** (`POST /recurring/auto-scan`): each background catch-up (*Data flow*) runs a
    global scan only when the `db_meta` watermark says one is due (never scanned, or older than the daily
    interval), and settles any owed rescan that is overdue. It also hosts the payee-key re-derivation
    repair.

- **A money movement between two tracked accounts is one series that owns both legs.** `scan_and_store`
  runs a transfer pass first: `transfer_pairs.pair_money_movements` pairs rows structurally (same amount
  and category, opposite directions, different accounts, within a few days),
  `detect_transfer_series` scores the rhythm over the pairs, and the series claims both legs. Every
  paired row is withheld from the payee pass, including pairs with no rhythm, because a paired leg is
  not merchant activity. The pass runs over the full pool even on a scoped scan, and a scoped scan
  widens to any payee series holding a paired row. Its rows reach `reconcile_series` as `reserved`, so a
  payee series holding them gives them up. It yields only to a rule-backed series
  (`_rule_backed_holdings`), and it reports a pairing tie instead of guessing
  (`GET /recurring/transfer-review`). An open tie is a section of the Recurring page's *Needs attention*
  view and a Tasks item.

- **Anomaly and forecast signals are a read-time projection** (`backend/services/recurring_signals.py`).
  An auto series gets a new id on every scan and an edit can change membership at any time, so a stored
  finding would be orphaned or stale; deriving on read is bounded by series membership. The rule
  range-drift findings on the Rules page (`backend/services/rule_range_drift.py`) work the same way and
  share the dismissal store. The four anomaly kinds become Tasks items (`routers/tasks.py` reads the
  same counts). **Upcoming** is a view on the Recurring page only, because it is not something to fix.

- **User-driven series are rule-backed.** A rule flagged `is_recurring` owns a `source='rule'` series
  whose membership is the rule's matches (`categorizer.rule_matches_row`). Pin/exclude corrections
  (`POST /recurring/{id}/membership`) survive scans, and rule-backed series are reconciled over the full
  window even on a scoped pass.

- **Members are read through the transactions endpoint's `recurring_series_id` filter**, so the
  drill-down is the shared transaction list.

Detection keys, scoring, curation gates and the signal kinds: `data-model.md` → *Recurring series*.

### Import / export

- **Backend:** `backend/routers/import_export/`, a package whose `__init__.py` assembles one router and
  re-exports the `backend.routers.import_export` surface

- **Handles:** CSV preview and import, saved data sources (import profiles), undo, CSV export, and
  backup/restore of the financial data and the accounts (`services/accounts_backup.py`)

#### Module layout

`core.py` holds the run-import flow, the dedupe context, and batch history, undo, duplicate report,
category and rule-suggestion logic, plus the primitives the package reuses (hashing, amount/date/header
parsing, effective-account resolution). It is large on purpose: preview, saved profiles, history, undo,
duplicate handling, category application and rule learning have to agree, so that logic stays together.
The run sits behind a parse seam — a front end hands `run_import_parsed` a `ParsedFile`, and the CSV
front end `parse_csv_text` is shared with the preview.

Leaves carry separable concerns and import from `core`: `profiles.py` (data-source CRUD), `backup.py`
(backup/restore and CSV export), `preview.py`, `paypal_statement.py` (statement PDFs read by
`services/paypal_statement.py`, imported through `run_import_parsed`), `amazon.py`, `watch.py`, and
`rule_suggestion_actions.py`. The one reverse dependency is `core`'s undo paths needing
`amazon.reverse_batch_amazon_links`, imported lazily inside the function so the module-load graph stays
acyclic.

**A review scope is the only thing that differs between the three populations the Generate Rules review
runs over** — one batch, every completed batch of a saved data source, or every completed batch using
its file's categories. A scope carries where the review state is stored, which rows it covers (shared by
the generator and the matching-rows report), and the identity fields the report names itself with. Every
endpoint in the family is one implementation taking a scope opener.

#### Preview contract

The mapping table's amounts are computed by the import's own `parse_amount`, via `POST
/import-export/preview/amounts` (`preview.py`), because a preview has to show what the import will do.
The client posts the rows it already holds, since `/preview` persists nothing to re-parse. The answer is
`null` for an unparseable cell or a convention whose columns are not mapped yet.
`frontend/src/lib/importExport/previewAmounts.js` owns the debounced fetch and the by-position merge and
parses no amounts. The latest date of each account value, which the mapping step compares with a closed
account's date, comes the same way from `POST /import-export/preview/account-dates`, which takes the whole
file because the latest row can be anywhere in it.

#### Batches, history and saved data sources

- **Effective account:** import review, data-source summaries and CSV export resolve a grouped child
  account through its parent's display name.

- **History payload:** batch rows carry summary data only; the duplicate-review payload is fetched when
  the viewer opens. The file-scoped ledger (`ImportBatchDetail`) also fetches how many of the batch's
  rows were later removed as duplicates (`GET /batches/{id}/removed-duplicates`), because a decision
  made from another file's report can trash a row belonging to this batch.

- **Needs review:** every imported or synced row is flagged `needs_review`. Batch summaries expose
  `needs_review_count`, and `POST /import-export/batches/{id}/mark-reviewed` clears the flag for a card.
  Sync cards work the same way, since synced rows carry their card's `import_batch_id`.

- **Saved data sources** remember whether files from that source use the categories in the data; each
  batch keeps the decision and scope actually used. Deleting a data source moves its files to the
  unknown-source bucket and keeps each batch's own state. The editor remembers which file last served as
  its template, and the user still chooses a template file to edit column choices against.

- **Imported categories:** an import that uses the file's categories applies them directly, adds missing
  ones as leaves under the system `Unassigned` group, and feeds the rows into rule suggestion.
  Placeholder labels meaning "not categorized" become `NULL`. A label matching an inactive category
  imports uncategorized with its label retained. See `data-model.md` for the inactive-category
  lifecycle.

- **Organize / inactive surface:** the "Group Imported Categories" workspace on the Import page is the
  one place `Unassigned` leaves are organized into groups. Placement and "Set aside" are draft edits
  committed together on Apply. Set-aside parks a category (`set_aside = 1`) and leaves it active; only
  Delete deactivates one (`is_active = 0`), recoverable via `POST /categories/{id}/reactivate`.
  - **The draft is shared tenant state**, because it stages the one shared category tree. It is stored
    in `import_workflow_state` (key `system_category_workspace_draft`, carried by backups) through
    `GET`/`PUT /import-export/category-workspace-draft`, not in the per-profile `ui_preference` store.
    The `category` table is the durable truth; the workspace re-seeds from it when no draft exists
    (`categoryImportState.js::buildInitialSnapshot`).
  - **Saves are revisioned.** Every `PUT` names the revision it was edited from (`base_revision`); a
    stale one is refused with `409 draft_conflict` and the stored draft, the check and the write sharing
    one immediate transaction. A stale save equal to the stored draft is accepted. The browser saves one
    at a time and coalesces edits made meanwhile.
  - **Apply is one transaction** (`POST /categories/imported-workspace/apply`): groups, placements and
    the set-aside list go through the same create and edit rules as the individual category endpoints.
    A plan naming a category that is no longer waiting is refused with `409 workspace_stale`.

#### Duplicate detection

All verdict logic lives in `backend/services/duplicate_detection.py`: a `DedupeContext` (precomputed
lookups for one pass), a `DedupeVerdict` (hard-reject | soft-flag | passthrough), and a per-row
`evaluate_duplicate`. One module holds the rule ladder so the medium-confidence rules share their
precondition; its docstring has the ladder. What each state and field means is in `data-model.md` →
*Import batches and profiles*.

- **Hard-reject:** the row is never inserted into `txn`. Its would-be payload is kept in
  `import_batch_duplicate` and can be replayed (`POST /import-export/batches/{id}/duplicates/import`,
  through `_insert_imported_transaction`). A record lasts as long as the import its verdict leaned on:
  when that import leaves the ledger, the row is judged again (see *Records are revisited* below).

- **Soft-flag:** after a batch finalizes, each row is checked against the rest of the ledger for
  cross-account matches and flagged via `suspect_duplicate_of`. Same-batch rows on different accounts
  are trusted as distinct. `promote_in_group_suspects_to_confirmed` then confirms any flag whose two
  accounts are already in one linked group, which makes the outcome independent of whether the merge or
  the import came first.

- **The service asks the user whether two accounts are the same; it does not infer it.** Keep on a
  cross-account suspect writes `account_pair_distinct` and clears the other unresolved flags between
  that pair. Merging two accounts removes the assertion (`clear_account_pair_distinct_for_merge`).

- **Records are revisited when their premise changes:**
  - `undo_batch` deletes the batch's `import_batch_duplicate` and `import_batch_account` rows and clears
    `suspect_duplicate_of` pointers at its deleted rows.
  - **Other files' rows rejected against an import are judged again when it leaves the ledger**: Undo, a
    re-import replacing the file (after the new rows are in), and a connection's *Remove synced
    transactions*. `rejudge_orphaned_rejections` takes every record whose verdict names an import that is
    no longer completed (a coverage claim's batch or connection, or a matched row's batch) and asks what a
    fresh import of that file would decide today. A row still accounted for keeps its record, re-pointed;
    one that is not comes in through the Import anyway path, takes today's rules, and gets the full
    post-import sweep. The trigger is the import, not the matched row, so a twin purged from the Trash
    brings nothing back. Files are judged oldest first, without the coverage claims of files still waiting
    to be judged: those claims do not hold until the files' own rows are dealt with, and two such files
    would otherwise each keep the other's row out.
  - `attach_account` clears the pair's distinct assertion and promotes existing flags inside the new
    group, tagged `dedupe_resolved_by = 'auto_merge'`.
  - `detach_account` restores any `auto_merge` promotion whose pair straddles the detach boundary,
    whichever side holds the trashed row. Rows the user rejected (`'user'`) are left alone.
  - Applying a connection mapping re-judges that connection's earlier rows (see *Data providers*).
  - `POST /accounts/duplicate-rescan` runs on app load, gated on `DUPLICATE_DETECTION_VERSION`: it
    re-judges any rejection whose import is gone, as above, then re-scans each account once per matcher
    change and skips pairs the user has judged.

- **The report replays a stored verdict.** `matched_transaction_json` is written at import. Opening a
  report first runs `refresh_unexplained_coverage_candidates`, which recomputes candidates only for
  coverage rejects that currently name nothing, since a later import can bring the twin into the ledger.
  It runs the cross-account probes only on entries the prefetched indexes leave unexplained, and never
  changes a verdict, a reason or `reviewed_at`.

- **Coverage rejects are classified once at import** (`coverage_review_substate`, stored in
  `import_batch_duplicate.review_substate`), so a file card counts rejections wanting a look with an
  indexed query. `save_batch_duplicate_rows` is the one writer; the refresh above restates the sub-state
  in the same UPDATE because it is derived from the candidate list. `POST
  /batches/{id}/duplicates/mark-reviewed` sets `reviewed_at` for advisory rejects. Labels, emphasis and
  sort rank come from `frontend/src/lib/duplicateKinds.js`.

- **Both sides of a match name their account, per row**, resolved when the report is read from the
  stored `account_id` and rendered through one label expression (`_account_label_sql`), mask included.
  It is per row because one import can spread across several accounts.

#### Mapping-time distinctness

The account-mapping grid (`AccountMappingGrid`: CSV import, connection setup, data-source editor) asks
what a source account becomes. Giving it its own account also asserts it is none of the accounts it
might have been, recorded as `account_pair_distinct` rows so the cross-account sweep does not re-ask
per transaction.

- `findAccountMatchCandidates` returns every plausible account. `findLikelyAccountMatch` collapses that
  to one for the one-click accept chip only, and requires exactly one possibility **and** name evidence,
  so surfaces call it rather than testing the list length.
- The picker (`AccountMatchSelect`) answers *which existing account*. `+New` answers *create one*, and
  goes through `PossibleAccountMatchChooserDialog` whenever candidates exist, because **an assertion may
  only cover what the user was shown**. With no candidates it creates in one press.
- An account sharing the source value's masked digits is a candidate (`extractAccountMask`, the mirror
  of what `normalizeAccountMatchStem` strips) but never the chip, since unrelated accounts commonly
  share four digits.

#### Amazon order import contract

The Amazon form imports an AZAD orders/items export through its own pipeline, folded into the same
import-batch and undo contracts as a CSV. Matching rules, report buckets and link semantics are in
`data-model.md` → *Transaction links and Amazon order import*.

- **Parsing is source-pluggable** (`services/amazon_import.py`): a thin header-sniffing `read_export`
  over a reusable `rows → orders` core.
- **One `import_batch` per source file**, grouped by content hash (`run_amazon_import`,
  `_import_group_to_batch`), so dropping several periods at once behaves as if each file were imported
  alone, with its own coverage, undo and reconciliation. An orders file and its items file fold into one
  card. An items file without its orders becomes its own card whose detail is parked
  (`amazon_pending_item`) and attached when the orders arrive (`_take_parked_items`), reversibly: undoing
  the orders import returns them to waiting. Once every item is taken by a single orders card, the items
  card is folded into it (`_merge_items_card_into_orders`), in either import order.
- **Order rows go through `_insert_imported_transaction`**, so they carry batch linkage, `needs_review`
  and provenance like any imported row.
- **The linked card charge lives outside the batch**, so `reverse_batch_amazon_links` restores its prior
  category inside `undo_batch` and the re-import `replace_batch_id` path, before the batch's rows are
  deleted, as `reverse_batch_enrichments` does.
- **A charge that arrives after its order** is matched by `match_orders_after_ingest`, called from the
  CSV import and sync paths ahead of PayPal pairing.
- **The attention count is cached** on `import_batch.recon_attention_count`, because `list_batches` and
  `get_tasks` both read it on every load and computing it runs the whole reconciliation. Staleness is
  one epoch in `db_meta` (`recon_epoch`), bumped by a trigger on every table the reconciliation reads;
  triggers are used because the writes are scattered. The epoch also advances at every start
  (`_bump_recon_epoch` in `init_db`), so a count cached by earlier code is not served to new code.
- **Every duplicate claim goes through `_duplicate_group`**, which owns the guards: candidates share an
  effective account, and a group the user marked *Not duplicates* (`amazon_charge_distinct`) does not
  re-flag. `merge_duplicate_charges` calls it too, so a merge is validated server-side, and refuses when
  an order links several charges.
- **Each batch stores an `import_summary`, the content hashes of its files, and the Amazon account it
  imported into** in `config_snapshot` (`GET /amazon/import-detail/{batch_id}`). A re-uploaded file is
  recognized and skipped; a file with discarded rows stays re-importable, and undoing a card frees the
  files it took. The account is recorded rather than derived from the card's rows, because a card need
  not have any — an items-only card holds parked detail and no transactions — and the history groups a
  vendor's cards by account. A skipped file is reported with *why*: `already_imported` names the card
  that already covers it, while `duplicate_in_drop` names the copy taken earlier in the same upload and
  says nothing was imported, since there is no card and no rows to go looking for.
- **A saved Amazon source** (`csv_import_profile` with `source_kind = 'marketplace:amazon'`) holds the
  Amazon account its files import into, the categorize toggle, a filename pattern and the `watch_*`
  block. Two people's exports are two sources, each with its own account and folder. The CSV-only
  columns stay unused — an AZAD export is recognized by its header — and `GET /profiles` leaves these
  rows out, because the CSV mapping editor has nothing to show for one. Only a watched-folder import
  stamps its card with the source; the import form takes no source. A stamped card still belongs to the
  vendor's history row, not to a data-source row (`dataSourceRows.js`).
- The reconciliation and import-detail dialogs are App-level detached viewers on
  `useDetachedReportViewer`.

Adding another marketplace vendor: `building-a-connector.md` → *Adding a marketplace importer*.

#### Watched import folders

A data source may name a directory on the **server**; a file that appears there is imported through
`run_import_parsed` (`watch.py`). The result is an ordinary import batch, so its duplicates, refused
rows and rule suggestions appear on the usual file card.

Which files a source takes, and how each is read, identified and imported, is one table in `watch.py`
(`_FILE_KINDS_BY_SOURCE`, keyed on `source_kind` and then extension); the scan, the purge's re-check,
the folder picker and the hand-back of a parked file all look a file up there. A **marketplace source**
watches a folder the same way, its CSVs going to `run_amazon_import` instead. The refusal rule is the same — park anything the saved source does not
answer — but the questions differ: there is no header fingerprint to check and no hand import to wait
for (an AZAD export is recognized by `read_export`, so there is no mapping to prove), and what must be answered instead is the Amazon account and the funding
account of every paying card the file names. An unmapped card parks the file, because the interactive
form refuses to import until each one is mapped and an unattended path may not take the looser option.

The **PayPal source** takes statement PDFs beside its activity CSVs, imported as the statement upload
imports them. What a statement must have answered is the ledger account its PayPal account goes into,
which a statement imported by hand settles for that PayPal account (the tie `_statement_accounts` reads
back); a statement for a PayPal account with no tie yet parks. A zip of statements is not taken from a
folder, although the upload expands one: an archive found on disk is one nobody has opened.

- **Scanning is request-driven; there is no scheduler.** The app has per-identity database paths, so a
  timer thread would have no tenant to run as. `POST /import-export/watch/auto-scan` scans only if one
  is due (a `db_meta` watermark, `AUTO_SCAN_MIN_INTERVAL_MINUTES`) and is called on each background
  catch-up (*Data flow*) and when `WatchedFoldersPanel` mounts; `POST /import-export/watch/scan` is the
  unconditional *Check now*. The nav badge and Tasks read a persisted count (`attention_counts`) and never touch the
  filesystem.
- **A per-file watermark keeps a scan cheap.** `import_watch_file` holds `(size, mtime)` per entry, so
  only a new or changed entry is read, hashed and parsed, then matched against
  `import_batch.file_content_hash`. The table is a cache and is outside backups (`data-model.md` →
  *Watched import folders*).
- **A folder the scan cannot list is skipped whole** and keeps the reason in
  `csv_import_profile.watch_notice`, which raises an administrator's Task until a scan can list it again. A
  file that cannot be read is an `error` row whose reason the waiting-files Task counts apart, since its
  answer is the file's owner or permissions rather than the import flow.
- **Anything the stored mapping does not answer parks the file** and raises a Task, which opens the
  ordinary import flow with the file pre-seeded (`GET /import-export/watch/files/{id}/content`). A
  parked file is retried on every pass, so mapping the account (or the Amazon funding card) in the
  import form is what lets the folder resume on its own.
- A source's `filename_pattern` is a secondary filter, so several sources can share one directory.
- **Settings are admin-gated** (`PATCH /import-export/profiles/{id}/watch`, `require_admin_or_local`),
  because naming a directory is a statement about the server's filesystem; see `security-model.md` →
  *Reading and deleting outside the data directory*. **Where is the operator's**: an installation other
  devices can reach (`transport.reachable_from_network`) watches only inside its own `imports/` folder
  (beside the data database, created at startup) and `WATCH_FOLDER_ROOTS`. `watch_folder_refusal` is the one check, applied on save, in the picker, in the
  scan (a refused folder is a source notice, and its purge is skipped) and when a parked file is handed
  back (`operations.md` → *Watched folders on a server*). A restore from another instance switches watching
  off and marks each folder `watch_restore_pending` until it is used here or cleared
  (`POST /import-export/profiles/{id}/watch/restored`); the verdict is taken before the wipe, since every
  restore gives the system a new `instance_id`.
- **The folder is picked by browsing the server, not the viewer's machine** (`GET
  /import-export/watch/browse`, same gate, read-only, creates nothing). The browser's own pickers
  (`webkitdirectory`, `showDirectoryPicker`) choose on the machine the page is open on and yield
  relative names, so neither can produce the absolute server path the field means; there is no native
  dialog to fall back on either, since even the desktop build serves itself to the system browser.
  `ServerFolderPicker` is an inline panel inside `WatchedFolderDialog` — one picker for CSV and
  marketplace sources alike. It is **controlled by the dialog's path field**: navigating writes the
  folder into that field, and the field is what the picker lists, so typing a path and walking to it are
  the same act. A picker holding a current path of its own beside the field left the field looking
  inert, which is the reason this is stated. Abandoning a browse restores the path the field held when
  it opened. The list area reserves its height whether or not it has anything in it, so the first click
  does not grow the dialog; only its border and fill come and go, since a bordered box holding one line
  of text is indistinguishable from the path field above it. It lists the **files the folder would
  import** under its subfolders — plain rows, not buttons, since a folder is picked and never a file —
  because a name like last year's export settles "is this the folder?" in a way a path cannot. Which
  files those are is decided server-side, for the source being edited, from the same table the scan
  filters on, so the picker can never offer a file the folder would pass over; the client is told *which
  files*, never *which extensions*, so the table growing does not reach it.

### Detail panels

- **Panels:** payee (`TransactionDetail`), category (`CategoryDetail`), account (`AccountDetail`),
  range-scoped listing (`PeriodDetail`), and tag-signature listing (`TagDetail`). All share one chrome:
  `useDetailPanelChrome` owns drag and resize state, `DetailPanelShell` renders it, and
  `frontend/src/components/detailShared.jsx` holds the shared chart and lazy-loaded list.

- **Reporting contract:** detail panels and dashboard summaries include every matching row for the
  selected slice and use the net amount. A refund or reimbursement in an expense category offsets the
  expense; it is not income and is not dropped for having an unusual sign.

### Help / FeatureExplainer

- **Location:** `frontend/src/help/`

- **One registry** (`content.jsx`, entries of `{ id, title, surfaces, summary, body }`) feeds both the
  `<FeatureExplainer topic="...">` popover and the `/help` and `/help/:topic` pages (`pages/Help.jsx`),
  so the two cannot disagree. A new explainer is one entry plus a `<FeatureExplainer>` at the surface.

- `<HelpLink>` is used for links between topics so the "Back to `<page>`" state survives several hops.

### Configuration layers

Every setting resolves through three layers, highest wins:

```text
hardcoded default  <  control-DB `app_setting` row  <  environment variable
```

**An ordinary install needs no configuration file.** Defaults cover the common case, so `.env` is an
override and its absence is normal. The registry in `backend/app_config.py` declares each setting once
(environment variable, default, whether it is stored, whether it is redacted); the resolver and the
`GET /api/auth/config` report read from it. A setting changed inside the app does not belong in the
registry, since everything there gains an environment variable that outranks it.

**The environment layer wins** so an operator can force a value from outside the app; a broken stored
setting would otherwise be unreachable. `.env` is loaded with `override=True`, so the file beats the
shell environment; the Playwright harness relies on that by pointing `LUMA_ENV_FILE` at an isolated
file. Because an override is invisible from inside the app, the Settings → Startup configuration
report names the layer each value came from.

**`.env` is loaded by an import every entry point makes first** (`backend/load_env_file.py`). The
database modules read their locations from the environment once, at first import, so an entry point that
reaches them another way fixes the paths without the file. `test_desktop_launcher.py` pins the order.

**The report offers one write: clearing a stored value** (`POST /api/auth/config/{key}/reset`), so its
default applies at the next start. The two stored settings derive or generate themselves, so there is
nothing to type, and everything here is consumed at startup. Clearing is refused while an environment
override is in force, since it would change nothing.

**Stored rather than defaulted:** the session signing secret and the session cookie name, because both
must persist. The secret is generated on first run; regenerating it per boot would invalidate every
session. The cookie name is derived from the **control database path** and then stored, because one
checkout run against two databases needs two cookie names: each database signs with its own secret.

**Environment only:**

- `DATA_DIR`, because the database's location cannot be read from the database. It is one directory with
  fixed filenames, since the two databases travel together. `DB_PATH` / `CONTROL_DB_PATH` still win for
  their own file, which is the only way to reach a database not on the default filename. These resolve
  at import and are held as module state; the report reads them from the owning module.
- The bind port and the frontend/Vite ports, consumed before the server binds.
- `LUMA_USE_LOG_FILES` and `LUMA_BACKEND_READY_TIMEOUT`, read by the start scripts before Python runs,
  and `SERVER_MODE`, read by the launcher before it has a server.
- `SESSION_COOKIE_SECURE`, which forces the cookie's `Secure` flag for a proxy that does not report the
  HTTPS it terminated. A cookie set over HTTPS is marked without it.
- `CORS_ORIGINS`, empty by default because every topology is single-origin.
- `ALLOWED_HOSTS`, the names beyond the always-answered ones that the host check accepts.
- `LUMA_DEVELOPER_OPTIONS`, which gates destructive reset tooling.

**Bootstrap ordering.** The session secret and cookie name are constructor arguments to
`SessionMiddleware`, so `backend/main.py` initializes the control database and resolves configuration
before the app object is built; `init_control_db()` therefore runs at import rather than in the lifespan
hook. Settings a user changes in the app — sign-in, password policy, currency, data-source credentials —
have their own endpoints and storage and are not part of this system.

### Identity, access & deployment model

The shape is **one shared workspace with multiple login identities**; `security-model.md` has the
assumptions behind it. Every member is provisioned into the single workspace and shares one data DB:
the one the configuration names (`DB_PATH`), which every request uses. Nothing in the control database
says where the data DB is, because a location written into one file goes stale the moment the files are
copied or moved. *The two databases, and what separates them* covers how the pair is held together.

- **Login is an authentication perimeter, not an authorization system.** It keeps non-users out. Every
  user sees and edits the same data, and no data route checks role.
- **Admin gates the install and the perimeter, not the ledger.** The guards in
  `backend/authorization.py` cover user management, environment and provider settings, backup and
  restore, and the backup keys.
- **Being shown the admin surfaces is asked once per side.** `useShowsAdminFeatures`
  (`lib/adminFeatures.js`) decides what the client lists, and `shows_admin_features`
  (`backend/authorization.py`) decides the reminders and counts the server sends. While sign-in is on
  both follow the role; while it is off both read the user's `ui.showAdminFeatures` preference, which is
  kept, unread, through a spell with sign-in on. Neither is a guard: `canAdminister` and
  `require_admin_or_local` still say what works, which is why a watched folder, set beside its source,
  stays editable and its unreadable-folder reminder stays raised.
- **One identity concept, `user_account`, in one table.** A perimeter-off identity and an authenticated
  user are the same row; the sign-in flag decides only whether the password is verified. Perimeter off
  is local mode: passwordless identities picked from a chooser, scoping per-person UI preferences.
  Perimeter on reuses the same rows with accounts, 2FA, roles and password policy. "Password optional"
  is a workspace property (`enable_auth_mode()` / `disable_auth_mode()`), never per-user, because the
  data is shared. `auth_required()` is the sign-in flag alone.
- **The password policy is enforced by `validate_password_for_policy` and previewed by the forms.**
  `none` and `min_8` are judged in the browser as well (`lib/passwordPolicy.js`). `strong` is the
  estimator in `backend/password_strength.py`, which the vault floor also uses, so the forms ask
  `POST /auth/password-strength` as a password is typed (`usePasswordChecks`). That route is public in
  the middleware, because the first account and the change forced at sign-in come before any session
  exists, and answers only a session that is setting a password.
- **The session carries identity in both modes.** The sign-in session middleware (`backend/main.py`) reads
  `session['user_id']`. A perimeter-off session is stamped `pwless` (chosen via `POST
  /auth/select-identity`), and enabling sign-in invalidates `pwless` sessions on their next request.
- **A session is also a row.** Every sign-in path calls `sign_in_sessions.start`, which records a
  `sign_in_session` row in the control DB (keyed by a SHA-256 of the id) and puts the id in the cookie
  as `sid`. The middleware checks the row exists before anything reads the session on an API path and
  clears the session if not. Logging out deletes the browser's row; setting an account's password or
  disabling it deletes that account's rows (`control_database.update_user`), keeping only the session
  that made the change when it is the account's own. Idle rows are pruned when a session starts. The
  same id keys the vault's unlock cache.
- **Typed secrets are limited against guessing** (`services/attempt_limiter.py`), per account: a minimum
  spacing between attempts and a lockout after consecutive failures (`MIN_SPACING_SECONDS`,
  `MAX_CONSECUTIVE_FAILURES`, `LOCKOUT_SECONDS`), answered with `429 too_many_attempts` and
  `Retry-After`. It covers `/auth/login`, `/auth/2fa/verify`, `/auth/2fa/disable`,
  `/auth/2fa/recovery-codes`, `/auth/vault/unlock`, `/auth/vault/change-passphrase` and
  `/auth/vault/recover`. A lockout at `/auth/2fa/verify` also drops the pending challenge
  (`restart_sign_in`). What is left out, and why: `security-model.md` → *Identity and the network
  perimeter*.
- **Enable and disable are flag flips.** Enable claims one existing identity as admin (sets its
  password), marks every other passwordless identity `must_change_password`, and flips the flag
  (`enable_auth_with_admin`). Disable (admin-gated) flips it back and keeps identities and password
  hashes, so re-enabling needs no migration. `_unify_local_profiles_into_users()` at startup folds
  `local_preference_profile` rows from an older install into `user_account`s.

**A 401 is answered by the shell.** `request()` in `lib/api.js` dispatches `SESSION_LOST_EVENT` on any
401; `App.jsx` drops back behind the gate and re-runs the identity bootstrap, so a lapsed session leads
to the chooser or sign-in from any surface. The `/auth/` endpoints never signal, because their 401 is
the bootstrap's answer, and a signal suppresses further ones for `SESSION_LOST_QUIET_MS`, because a page
has several requests in flight.

**Passkey sign-in** is an additional credential on this perimeter, never a replacement for the password.

- `app_passkey` (control DB) holds one row per registered device: credential id, COSE public key, sign
  counter, transports, a label, and the RP id it was registered under (`rp_id`, recorded at its next
  sign-in for one registered before it was kept). It is separate from `vault_slot`, which also holds passkeys; the two
  features share no storage, endpoint or ceremony (`security-model.md` → *Passkeys and the second
  factor*).
- `services/app_passkey.py` wraps `py_webauthn`: it builds the ceremony options and verifies the result
  (origin, RP id, type, signature, user verification, sign-counter regression, and that a returned user
  handle is the owner's). User verification is required on both ceremonies, and registration asks for a
  discoverable credential so the sign-in screen can offer a passkey before a username is typed. The
  sign-in ceremony's `allowCredentials` names every active account's passkey that can answer at the
  page's host, never an empty list.
  Sign-in passkeys are registered under their own user handle (`sign_in_user_handle`, a hash of the
  account id).
- `POST /auth/passkey/register/begin|complete` needs a signed-in session. `GET /auth/passkey/params` and
  `POST /auth/passkey/login/begin|complete` are public (in the sign-in session middleware's `public_paths`),
  because the sign-in screen runs them before a session exists. `DELETE /auth/passkey/{id}` removes one, and
  `PATCH` renames it: the label is this install's, while the name in the device's passkey list is fixed at
  registration.
- **The challenge lives in the signed session**, which makes it single-use (popped on use) and bound to
  the browser that asked.
- A passkey sign-in completes without the TOTP step, since required user verification is the second
  factor. It still honors `must_change_password`.
- `transport.passkey_context` reports whether a ceremony can run on this connection, with a
  stated reason (`insecure_context`, `ip_address_host`). The accepted origin is any origin on the RP
  id's host; the port is unpinned because both ports are configurable.
- Frontend: `lib/appPasskey.js`, `lib/base64url.js` (the vault stores standard base64, sign-in speaks
  base64url), the button in `components/AuthScreen.jsx`, and `SignInPasskeysPanel` in
  `components/settings/SignInFactorsSection.jsx`.

Provider-token protection is independent of this perimeter: the vault secret is per-user, so a
passwordless install can still hold vault-encrypted tokens.

### Token vault & transport security

Provider access tokens are protected at rest by a **multi-wrap envelope vault**
(`backend/services/crypto_service.py`). Why custody has this shape is in `security-model.md` → *Secret
custody*; this section is the mechanism.

- **One workspace Data Encryption Key (DEK)** encrypts every per-connection secret
  (`connection.credential_enc`) and every app-level provider secret (`provider_config.secret_enc`).
  Those columns are registered as `crypto_service.ENCRYPTED_COLUMNS`, which rotation and reset iterate,
  and a test fails if an encrypted column is added without being listed. The ciphertext travels with
  data backups, the key material with the control DB. The ledger itself is plaintext at rest.
- **A slot is a keypair.** Each `vault_slot` row (control DB) holds a public X25519 key, its private key
  AEAD-wrapped under the KEK derived from that user's unlock secret, and the DEK sealed to the public
  key. Sealing needs only a public key, so a member can grant access to someone whose secret they do not
  have and rotation can re-seal for every slot. **Format 1** (the DEK wrapped directly) is still
  readable and is converted at the next unlock.
- **Unlock secrets** are a passphrase or a recovery code stretched with Argon2id, or a passkey's WebAuthn
  PRF output via `HKDF`. Each slot records its KDF and parameters (`kdf_*`), so a slot written under
  scrypt still opens. One passphrase and any number of passkeys per user, enforced by a partial unique
  index; the last method that opens the vault cannot be removed. No WebAuthn assertion is verified: a
  wrong PRF output fails at the AEAD tag as a wrong passphrase does. WebAuthn's preconditions (a secure
  context, an RP id that is a domain) are detected server-side (`transport.passkey_context`) and returned
  as stated reasons. A passkey slot records the RP id it answers under (`rp_id`), at registration or, for
  one registered before that was kept, at its next unlock. The names a passkey could answer under here are
  those this install's pages have been opened at (`served_host`, written by `/auth/status` through
  `transport.note_served_host`) plus the asking page's (`transport.passkey_host_names`). A restore does
  not adopt a passkey registered under none of them (*The accounts part* in `data-model.md`). A page offers
  only passkeys whose `rp_id` is its own host or unrecorded, and the passkey lists say where any other one
  works (`passkeyHost.js`); sign-in follows the same rules.
- **Unlocking** holds the DEK in a server-side, in-process cache keyed by `user_id` and the sign-in
  session, with an idle TTL (`UNLOCK_TTL_SECONDS`). It is never put in the session cookie, and is
  dropped on logout and restart. Endpoints: `POST /auth/vault/{set-passphrase,change-passphrase,unlock,
  lock}`, `/auth/vault/passkey/{params,register,unlock,set-passphrase}`, `PATCH|DELETE
  /auth/vault/passkey/{slot_id}` (rename needs no proof, since it changes no way in), `/auth/vault/reenrol`. Status:
  `vault_configured`, `vault_has_passphrase`, `vault_unlocked`, `vault_access_pending`. Connect, sync
  and a credentials restore that has to re-key need an unlocked vault (`423`; connect on an unconfigured
  vault `409`); the credentials export copies ciphertext and needs none. There is no plaintext path and
  no app-held master key.
- **Passphrase strength is an all-slots property**, since the DEK is only as strong as its weakest wrap.
  `passphrase_shortfall` is the floor: `VAULT_PRODUCTION_MIN_LEN` and the zxcvbn estimate at
  `VAULT_MIN_STRENGTH_SCORE`. `_write_slot` refuses a passphrase below it, and `POST
  /auth/vault/passphrase-strength` answers the dialog as it is typed. Each slot stores its verdict
  (`meets_production_min`) with what it was taken under (`strength_basis`): the rule's version and the
  installed zxcvbn release (`STRENGTH_BASIS`, read from the distribution's metadata, which
  `scripts/luma.spec` collects into the frozen kit).
- **A passphrase slot is brought current at unlock** (`_bring_passphrase_slot_current`), the one moment
  the passphrase is in hand: the verdict is re-taken under `STRENGTH_BASIS`, and a slot on an
  outdated KDF is rewrapped under the current one, keeping its keypair and carrying its
  `credentials_export` rows across. A failing verdict leaves the unlock working and sets
  `vault_passphrase_needs_change`, which raises the `vault_passphrase_change` task; `ready_for_production`
  then refuses a connect, and an unencrypted backup leaves the passphrase out
  (`passphrase_export_shortfall`), until the owner changes it. A verdict under an older basis sets
  `vault_passphrase_needs_check` instead, which raises the dismissable `vault_passphrase_check` task and a
  note on the locked strip; only an unencrypted backup waits on it. The backup
  surface offers whichever of the two would clear its warning: a passphrase-only check (gate mode
  `check`, an unlock that offers no passkey, since a passkey cannot judge a passphrase) or the change.
  Developer options can put every passphrase in the unchecked state and lock every session
  (`mark_passphrases_unchecked`, a NULL basis), as an upgrade carrying a rule change leaves it, so the
  check can be exercised without one.
- **Minting a durable unlock method needs a recently presented secret.** Writing a passphrase slot,
  registering a passkey and issuing a recovery code each require proof within `PROOF_TTL_SECONDS`,
  stamped where a secret is verified (`unlock`, `unlock_with_passkey`, `change_passphrase`,
  `recover_with_code`) and by choosing a first passphrase. The stamp and the unlock belong to the
  browser session. The stamp is absolute, not sliding, because the unlock cache's TTL is extended on
  every read. A lapsed window returns `403 proof_required` rather than `423`, since the vault is open.
  The session carries `vault_proof_seconds_remaining` so a surface can ask before an action. Not gated:
  `set-passphrase`, `rotate`, `reset`, and the credentials export (`security-model.md` → *Authorizing a
  change to how the vault opens*).
- **Any method that opens the vault can replace the passphrase.** `POST
  /auth/vault/passkey/set-passphrase` proves with a ceremony and writes the passphrase in one request,
  so no proof is spent without a passphrase written. It is also how a passkey-only member sets a first
  passphrase, since `set-passphrase` refuses a caller who already holds a working slot.
- **Enrollment.** Setting a passphrase or registering a passkey as a user the vault does not know writes
  a slot with no sealed DEK, reported as `vault_access_pending`. A member who lost the secret that
  opened their slot uses `POST /auth/vault/reenrol`, which replaces it with a pending one and refuses
  when no other member could grant it; that request carries `replaces_access`. Any member holding the
  DEK approves (`/auth/vault/access-requests/{slot}/approve`, `423` if locked); admins revoke
  (`/auth/vault/access/{user}/revoke`). A waiting request is surfaced to every member who holds an
  unlock method, whether or not their vault is open (`_vault_access_task`, the Connections vault strip).
  `GET /auth/vault/members` lists who holds access.
- **Rotation.** `POST /auth/vault/rotate` mints a new DEK and re-encrypts every registered column in
  three phases — seal the new key into every slot (keeping the outgoing one in `sealed_dek_prev`),
  rewrite the ciphertext, clear the previous seals — because no transaction spans the control and data
  DBs. An interrupted rotation is resumed on the next call. Revoke before rotating: rotation re-seals
  for the slots that remain.
- **Exposure response.** `POST /auth/vault/reissue-credentials` (`services/exposure_response.py`) gets a
  new credential from the provider for each connection whose adapter declares `reissues_credential` and
  returns the rest as outcomes. Each outcome carries `covered_by_app_secret` (the adapter's
  `credential_needs_app_secret`): replacing the app secret retires that credential, so its result line
  states the outcome with no instruction (`security-model.md` → *Responding to an exposure*).
- **Recovery, cheapest first.**
  1. Another member re-enrols the stuck user.
  2. A recovery-code slot (`method='recovery'`, one per user) opens the vault and re-keys the passphrase
     against the same DEK. The code has its own generator (`RECOVERY_CODE_BYTES`), stronger than the
     sign-in recovery codes, because a slot's wrap can be attacked offline. `POST /auth/vault/recover`
     takes `{code, new_passphrase}` as one operation: the replacement slot is written before the
     recovery slot is deleted, so a failure leaves the code usable, and a fresh code is issued.
  3. A backup holding the vault: restoring its accounts part puts the vault back as it was, opened by
     each member's passphrase, recovery code or passkey the file carries, as they were when it was taken,
     less any passkey registered under a host name this install is never opened at.
  4. `POST /auth/vault/reset` (admin-gated): every slot deleted, every `ENCRYPTED_COLUMNS` value cleared,
     `reauth_required` set on every connection. Connections, accounts, transactions, mappings and
     coverage survive. It asks *lost or compromised*: after a compromise each credential is first revoked
     at its provider where `revokes_on_disconnect` allows and the vault is open (locked, those are listed
     for the user), except one whose adapter declares `credential_needs_app_secret`, which is left
     connected (`app_secret`) since deleting the old app secret stops a copy reaching the provider, with
     per-connection outcomes. The preview names other members and the caller's passkeys, and the result
     reports `also_locked_out`, since one DEK per workspace means a reset ends every member's access.
- **Erasing an empty vault** (`POST /auth/vault/erase`, admin-gated, `crypto_service.erase_empty_vault`)
  deletes every slot and retires the key as `lost`, with no typed phrase and no lost-or-compromised
  question, and is refused while anything a reset would clear is stored (`holds_stored_secrets`). Vault
  settings offers it only then (`holds_secrets` on `/auth/vault/members`).
- `VaultDecryptError` during a sync is classified as `reauth_required`, because retrying cannot fix it.
- **Transport is a per-topology property.** The backend always speaks HTTP; a client-server deployment
  terminates TLS at a reverse proxy with uvicorn on `--proxy-headers`. `backend/transport.py` detects
  loopback and HTTPS per request, reading loopback from the client's address and never from the `Host`
  header. Plain HTTP on a networked bind is acceptable only with no sign-in and no provider. This is
  enforced by marking the session cookie `Secure` whenever it is set over HTTPS, by `transport.require_protected_link` (which refuses operations
  carrying a provider secret from another device in cleartext), and by a computed "Set up HTTPS" task
  (`tasks.py`) shown to whoever can act on it. The launcher declares what it started (`transport.declare_listener`):
  whether other devices can reach the installation, and whether they reach its plain HTTP directly. A
  device seen getting through, in cleartext or not, overrides the declaration until the next start.
  Settings → *Security checklist* (`services/security_checklist.py`) reads both.

### Data providers (the aggregator seam)

Data-source aggregators reach the app through one provider-neutral seam, so adding a provider is an
adapter and not a change to the connect and sync callers. `building-a-connector.md` is the guide to
writing one.

**One sync writes to three stores, chosen by who may lose the fact:** durable connection status on
`connection` / `connection_account` (cursor, last outcome, coverage, allowance); a disposable diagnostic
history in `connection_sync_log` (pruned and user-clearable, so nothing user-facing derives from it);
and the transactions received, on `import_batch` + `import_batch_account`, which behave like a CSV
import card. The full rule is in `data-model.md`.

- **Storage.** A `connection` row is the credential boundary: a `provider` discriminator, the provider's
  `external_id`, and the per-connection credential encrypted under the DEK (`credential_enc`). Which kind
  of connection a row is depends on the provider (`data-model.md` → *Data-source linkage*). Accounts
  link through `account.connection_id` (`ON DELETE SET NULL`, so a disconnected account keeps its rows);
  `account.provider` records origin and `account.external_account_id` is the provider's per-account
  handle and the sync upsert key. CSV and manual accounts have `connection_id IS NULL`.

- **`external_id` is stable only where the provider issues it and the app can re-authorize in place**,
  declared as `stable_external_id`. Plaid uses Link update mode (`POST /plaid/repair`), which re-fetches
  accounts as proof the Item answers and clears `reauth_required`. Where the handle is derived from the
  credential (SimpleFIN hashes the access URL), re-authorizing yields a new handle, so connect takes an
  `adopt_connection_id` and re-points the surviving row; coverage, cursor and sync history hang off
  `connection_id`. The choice is collected before the provider call because a claim is single-use.
  Rationale: `building-a-connector.md` → *Where the connection handle comes from*.

- **Adapter interface.** `backend/services/providers/` exposes `get_adapter(provider)` over a
  `ProviderAdapter` (`connect`, `fetch_accounts`, `fetch_transactions`, `fetch_transactions_sync`,
  `remove`), normalized to provider-neutral keys. The connect and sync paths speak only the adapter and
  the `connection` table.

- **Capabilities are declared, not branched on by provider name.** Each trait that differs between
  providers is a class attribute a caller asks the adapter for (`building-a-connector.md` → *Capability
  declarations*). `zero_amount_rows` and `currency_scope` have no default. The CSV and Amazon importers
  have no adapter class, so they declare through `services/source_capabilities.py`.

- **One connect flow, two entry points.** `providers.establish_connection` is the whole flow after the
  handshake: demo and vault gates, credential encryption, the `(provider, external_id)` upsert,
  `upsert_connection_accounts`, the unmapped count. Link-style providers reach it via `POST
  /plaid/exchange` (a separate route because the payload comes from the widget's callback), everything
  else via `POST /api/providers/{provider}/connect`.

- **Sync treats cursor and non-cursor providers alike.** `fetch_transactions_sync` defaults on the base
  class to a range pull presented as one complete page. Its return separates `has_more` /
  `update_status` (more to deliver now), `backfill_complete` (history fetched to its end), and
  `resume_later` (stop polling; the backfill resumes on a later sync). `account_coverage` reports how
  far back the pull actually reached per account, and a page reports only the accounts it advanced;
  overstating coverage makes duplicate detection reject genuine rows (`data-model.md` → "coverage has
  two shapes"). `removed` is empty on a range pull because the provider cannot report deletions.

- **Each page is applied and committed before the next is fetched**, so no write transaction spans a
  provider call (see *Database concurrency*). `continuing` is false on a pull's first call and true on
  its pages, for work that belongs to the pull. A metered adapter calls `budget_checkpoint` after
  debiting and before the request, so a crash can forfeit an unused allowance but not lose the record of
  a request made. Progress is committed with each page (`connection.sync_progress`), which lets other
  requests observe a pull in flight. The response breaks totals down per connection (`connections[]`),
  from the same per-call facts as the sync log and the connection card. `run_sync` takes `full_history`
  to tell a deepening pull from a routine top-up, and `provider` to scope a sync to one provider's
  request budget. A pull may return `warnings` — problems that did not fail it — which are shown because
  the pull otherwise looks clean.

- **An account added on the provider's side is discovered by syncing and never mapped by it.** When a
  transaction arrives for an id with no `connection_account` row, the sync fetches the provider's
  account list once and records the newcomers as unmapped. The guard is the `connection_account` row,
  not the local account: an account the user chose to skip has a row and no account.

- **History state is per account, and the caller owns it.** `coverage_start_date` and
  `history_complete` live on `connection_account`. `run_sync` decides which accounts want older data and
  passes `account_targets`; the adapter answers with `account_coverage`. A first backfill, a deepening
  pull and a late-arriving account therefore differ only in which accounts are targets, and a paused
  pull resumes from each account's recorded reach. A cursor provider reports no `account_coverage` and
  ignores `account_targets`, since a cursor is a checkpoint in a change feed.

- **A range pull fetches unfiltered when two or more accounts want a window**, because one request
  advances all of them, and narrows to an account only when one wants it. Rows already held are skipped
  on `external_transaction_id`.

- **A pull that walks history spends its first request on the recent window**, so new transactions
  keep arriving while history fills. Only a connection's first pull skips it, since then every account is
  walking from today; on any later pull an account that is not walking, or is walked on its own filtered
  window, is brought current only by that request. The top-up watermark (`through`) advances only after
  that fetch. A top-up whose gap since the last one is wider than one request may ask for is fetched in
  abutting `WINDOW_DAYS` requests, oldest first, because the server caps a wider range without failing;
  `through` advances per request, so an allowance running out partway claims only what was fetched.

- **The ledger's currency is a setting that adapters are told.** `services/ledger_currency.py` owns it
  (tenant state in `import_workflow_state`); `run_sync` passes `ledger_currency` into
  `fetch_transactions_sync`, and the adapter drops rows in another currency and reports them as
  `unsupported_currency`. Nothing outside that module compares against `DEFAULT_LEDGER_CURRENCY`.
  `GET`/`PUT /api/currency` read and write it; the PUT answers 409 when the ledger holds rows and the
  caller has not confirmed, because the change converts nothing. The frontend's `MONEY_DISPLAY_CONFIG`
  mirrors it at boot, and Settings reloads after saving. Per-provider handling:
  `building-a-connector.md` → *Currency*.

- **Balances arrive in one of two ways, chosen by what they cost** (`data-model.md` → *Account balances*). A
  provider whose responses already carry them (SimpleFIN) reports them on each page as `balances`; one
  that needs a request of its own (Plaid) implements `fetch_balances`, which `run_sync` calls once after a
  successful drain, committing first because nothing may be held open across a provider call. Plaid's
  default is the free cached copy (`/accounts/get`); `connection.realtime_balances`, offered where the
  adapter declares `offers_realtime_balances` and set from the connection's settings (`PUT
  /api/connections/{id}/realtime-balances`), asks for a live one, which the provider bills per request. A
  failed balance request is a warning on a pull that otherwise succeeded.

- **Provider-supplied error text is clipped in the adapter** (`_clip`, `_MAX_MESSAGE_CHARS`). SimpleFIN's
  bank-level codes are shown to the user and its request advisories go to the log.

- **Sync health is recorded per connection and rides `GET /api/providers`**, because the Connections
  card shows it while collapsed. `run_sync` stamps `last_synced_at` on success only, counts
  `consecutive_sync_failures` (reset by any success), and stores the latest error and warnings. The same
  payload carries the last sync's report: the import cards the pull wrote to and a count of rows added
  or revised. Row ids stay server-side (`sync_connection_id` expands them) because the payload is polled
  throughout a sync. Field meanings: `data-model.md`.

- **`reauth_required` is separate from "syncing failed" because only it is actionable.** An adapter
  raises `ProviderCredentialRejected` (`services/providers/base.py`) when the provider stops accepting
  the credential; `run_sync` sets `connection.reauth_required`, which stays until a pull succeeds. Other
  failures are left undifferentiated, since the failure count says how long they have lasted. For a
  provider with no revocation API this is the only notice the app gets that the user revoked access.

- **Credential AAD.** `crypto_service.encrypt/decrypt_connection_credential` binds the ciphertext to
  `(provider, external_id)`. For `provider='plaid'` the AAD is `plaid_item|<item_id>|access_token`.

- **App-level credentials.** A provider's own app secret (Plaid `client_id` / `secret` / `env`) lives in
  `provider_config`: `secret` is vault-encrypted (`secret_enc`, AAD `app_credential|<provider>|secret`),
  the rest is plaintext. `providers.config.resolve_app_config(user, provider)` returns the decrypted
  config, the saved row being the only source, and every adapter method takes it rather than reading the
  environment. A provider with `requires_app_config = False` receives `{}`, reports itself configured
  once it has a connection, and is gated on a Production-strength vault at connect time. CRUD is
  admin-gated at `GET/POST /api/providers/{provider}/config`; every save needs the vault unlocked,
  since the three values work only as a set, so the Configure dialog opens behind the vault gate. App credentials ride the accounts part of a backup (`provider_configs`).
  `DELETE /api/providers/{provider}/config` removes a provider: each of its account connections as a
  disconnect (revoked or kept at the provider, by `revoke`), then the row. The connections go first because none of
  them can sync or be revoked without the app credential. A refused revoke stops the walk with the row
  kept, so what remains can be retried or removed without revoking. It refuses while a sync runs and,
  like a save, needs the vault unlocked.

- **The vault gate is hosted at App level** (`contexts/VaultGateContext.jsx`, `lib/useVaultGate.js`),
  because the navigation pane's sync control (`components/SyncNavItem.jsx`) starts gated work from any
  route. Everything needing an open vault goes through it: it raises the unlock dialog and resumes the
  action when the unlock lands, and treats a `423` as the same gate arriving late. Its flags derive from
  `currentUser`. It also hosts the change-passphrase dialog, which is not a gate (nothing waits on it)
  but is opened from both Vault settings and the backup surface.

- **Connect on a networked bind requires HTTPS** (`transport.is_https` from `/auth/status`).

- **Disconnect** (`POST /api/providers/{provider}/disconnect`) revokes the token at the provider where
  the adapter's `remove` can, then drops the `connection` row and keeps accounts and transactions. Where
  `revokes_on_disconnect` is false, `remove` is a no-op and the confirm dialog says so.
  `remove_without_revoking` drops the row without calling the provider, needing neither the vault nor the
  app credential; the confirm dialog offers it beside revoking, since another install may share the token
  (`security-model.md` → *Revocation, in both directions*). A provider that refuses is a `revoke_failed`
  502 that keeps the row, and the same option is offered then. A connection with no stored credential is
  removed without a provider call either way. The disconnect log row's `reason` says why access did not
  end: `no_credential`, `provider_cannot_revoke`, `kept_at_provider`, or a restore's `restored`.

- **The mapping seam** (`connection_account`, `routers/connections.py`,
  `services/connection_mapping.py`). Connecting records the provider's accounts as unmapped and creates
  nothing. A required mapping step runs before the first backfill, so the first rows are deduped against
  what the mapped accounts already hold; the ladder's cross-account rules need the receiving account to
  have coverage or a declared alias. `upsert_connection_accounts` materializes accounts from the
  mapping, and "Refresh accounts" adds newly seen provider accounts as unmapped. Endpoints: `GET
  /api/connections/{id}/accounts`, `POST .../account-map` (idempotent; triggers the re-scan when a
  mapping changed), `PUT .../nickname` (the name the connection is shown by; display only, no vault),
  `POST .../captured-fields`. Modes: `data-model.md` → Accounts.

- **`GET`/`DELETE /api/connections/{id}/synced-transactions`** preflight and remove everything a
  connection has synced. Rows go through `undo_batches` in `import_export/core.py`, the path a file's
  Undo and a re-import's replace share. It then resets cursor, `initial_sync_complete` and the coverage
  columns, because a cursor left past deleted rows makes them unreachable. It makes no provider call and
  works with the vault locked. See `data-model.md` → "Sync import cards".

- **Captured fields are declared by the adapter.** `ProviderAdapter.capture_fields()` returns `[{key,
  label, locked, default_on}]`. Locked fields are the ones duplicate detection depends on; optional ones
  persist as `connection.captured_fields`. `GET /api/providers` reports `has_optional_capture_fields`,
  which names the card's menu entry: "Connection settings…" when there is a choice to make, otherwise
  "Account mapping…", whose dialog omits the all-locked list. `posted_date` is a `txn` column; everything else goes into
  `import_evidence_json` in the shape a CSV import writes, which is what makes a synced row visible to
  the text matcher. Plaid's `personal_finance_category`, `payment_channel` and `transaction_code` are
  not captured, because the app's own rules own categorization.

- **Duplicate detection for connection rows** lives in `services/connection_dedupe.py`, one context
  builder shared by the sync path and the re-scan. The re-scan runs only from applying a mapping and
  re-judges rows synced before the mapping existed. Two tested properties: the pass excludes the whole
  connection's own batches from its candidate pool, so two rows from one connection cannot reject each
  other; and it removes a row only when it can name the surviving counterpart. Removals are trashed with
  `rejection_reason='duplicate_confirmed'`, `dedupe_resolved_by='connection_rescan'` and the
  `suspect_duplicate_of` pointer, so the card's duplicate report shows them and Restore returns them.

### Database concurrency

**The backend is multi-threaded.** FastAPI runs plain `def` endpoints in a worker threadpool, so several
requests execute at once.

**Nothing is shared between those threads.** `get_db()` opens a fresh `sqlite3` connection per call and
closes it at the end of the block; there is no pool. The concurrency that matters is SQLite's.

**WAL: readers never block, writers serialize.** A blocked writer waits out `_BUSY_TIMEOUT_SECONDS` and
then fails with `database is locked`.

**A write transaction takes the lock when it opens** (`WRITE_TRANSACTION_ISOLATION`, on both databases'
connections; an explicit one is `BEGIN IMMEDIATE`). SQLite will not let a transaction that has already
read wait for the write lock, so behind a deferred `BEGIN` a read before the first write — including the
one preparing a DELETE on `txn` makes, since its full-text index reads its settings — turns another
request's brief write into an immediate failure that skips the busy wait. Python opens the transaction
before any INSERT, UPDATE or DELETE, and before an `executemany` of one with nothing to insert.
`backend/tests/test_write_transactions.py` pins both openings.

**A write transaction contains only the work it exists to do.** Gather what the update needs before
opening it, write, commit, then continue. Anything else held inside makes every other writing request
wait or fail for its duration. In particular:

- **No provider call inside a write transaction.** Sync fetches with nothing open, applies, commits, and
  repeats per page.
- **A write and the analysis after it are separate stages, divided at the commit.** The duplicate
  sweep, the recurring rescan and the wallet funding pairing each run after the ingest commit, in their
  own connections, guarded so a failure cannot fail the ingest. A transaction edit or rule apply and its
  recurring rescan are divided the same way, with the debt recorded inside the write so a failed rescan
  is not lost. A long read inside a write transaction blocks writers too, because the lock is held from
  the first write to the commit.
- **A read endpoint never holds the write lock past its own write.** SQLite takes the lock for a DELETE
  or UPDATE even when it matches nothing, and the caller's transaction then holds it until the block
  ends — the whole of a listing that only reads after it. So a read path's maintenance write runs only
  when a read has found something to change, and a cache it writes commits at once
  (`services/reconciliation_attention.py`, the batch history's reconcile). That write is also wrapped,
  so lock contention degrades instead of returning 500 (`backend/routers/import_export/core.py`).

**A file import holds its write transaction from first row to commit**: there is nothing to fetch
between rows, and a failed import leaves nothing behind. Its progress therefore cannot be read from the
database, so the run reports into an in-memory registry (`services/import_progress.py`), keyed by a name
the browser sends with the upload and by tenant, which the browser polls at `GET
/import-export/run-progress/{id}`. The endpoint does its work via `run_in_threadpool`, because work in
an `async def` body would hold the event loop and the poll could not be answered.

**A request-driven catch-up claims itself before its long work** (`single_runner`,
`backend/db/database.py`). The background catch-up, a second tab and a page mount can each ask for the
same work — the recurring auto-scan, the duplicate-detection rescan, a watched-folder scan — and each
would read "due" before the other stamps it, so both would do the work, and two folder scans would import
one file twice. A read-only due check answers the common case without the write lock. Only work that is
due takes a claim, written in its own short immediate transaction, and a second caller is turned away
while it stands. A claim left by a process that died lapses after its lease.

**Every request shares one interpreter lock.** Python lets only one thread run Python code at a time;
the lock that enforces this is the GIL. The `sqlite3` module lets go of it while SQLite works and has to
take it back afterwards, once for each call and once for each row it fetches. While other requests are
busy in Python, each of those take-backs waits its turn, so a request that fetches thousands of rows can
take many times longer than it does alone, even when the machine and the database are mostly idle. The
effect grows with the number of requests in flight, which is why the browser lane runs a limited number
of sessions (`scale-and-limits.md` → *Many sessions on one server*). So a request should make few calls
and fetch few rows:

- **Let SQL do the counting and filtering.** Ask for `COUNT`, `SUM`, a `WHERE` clause or a `LIMIT`
  rather than fetching rows to count or filter them in Python.
- **One query for a set, never one per item.** Load what a list of rows needs with `IN (…)` in a single
  query, not in a loop that queries for each row. A loop of queries grows with the data and goes
  unnoticed on a small ledger; `backend/tests/test_query_budget.py` is there to catch it.
- **Work every page triggers must stay cheap.** The Tasks poll runs on every page change and after every
  edit. Anything it computes should cost about the same on a large ledger as on a small one. Where that
  is impossible, compute it once and keep the result until the data changes.

**An expression in a predicate needs an index on that same expression.** SQLite matches the expression
textually, so a function around a column opts the query out of every index on the column.
`idx_txn_amount_round` exists because the cross-account duplicate sweep joins on `ROUND(amount, 2)`.

**Commits are durable and cheap.** No `PRAGMA synchronous` is set, so it is `FULL`: each commit fsyncs
the WAL. That is why the sync path commits per page.

### Storage layers

#### Browser-local storage

`localStorage` (survives reloads on one browser profile) and `sessionStorage` (one tab) hold the
remembered identity selection (a convenience; the session cookie is the source of truth), import draft
state, and other browser-local UI state that is not shared preference data. A preference should be cached
in the browser for efficiency, so it is not fetched on every read, but each change is written back to the
server.

#### Frontend session state

React state holds the loaded preferences, transient edit drafts and open/closed UI state until reload or
a change of active user. Key files: `frontend/src/lib/UserPreferencesContext.jsx`,
`frontend/src/lib/api.js`.

#### The two databases, and what separates them

The split is by **whose data it is**. Everything the user puts into the app — transactions, accounts,
owners, categories, rules, tags, import history, UI preferences — lives in the **data** database
(`luma-data.db`), so a data backup carries all of it. What the application needs in order to run —
identities (the `user_account` table), the vault key slots — lives in the **control** database
(`luma-control.db`), which is not part of a data backup and can be created fresh beside existing data.

**Data-connection secrets sit in the data database**, encrypted (`provider_config.secret_enc`,
`connection.credential_enc`), while the key that opens them stays in the control database. Both files
are needed to reach a live credential.

**The two files carry the same workspace id, and a startup checks it before opening the data
database** (`control_database.pairing_problem`). The id is the control database's `tenant.id`, and the
data database keeps it in `db_meta` (`WORKSPACE_ID_KEY`). A mismatched pair would run one installation's
sign-ins and vault against another's ledger, and a path naming nothing would have SQLite create an empty
ledger that looks like total data loss. So a startup that finds no ledger, a ledger with no id, or one
with a different id finishes without opening it and answers every request with the explanation
(`backend/pairing_lock.py`). `operations.md` → *When the two databases do not belong together* has
the cases and the way back from each.

- **A control database with no workspace yet adopts the ledger beside it.** Its first identity, or an
  accounts restore, creates the workspace record with the ledger's id, or writes a new one into the
  ledger when it has none. That is what lets a lost control database be replaced by a fresh one.
- **The id never changes and never travels.** `db_meta` is not in a backup and a restore does not wipe
  it, so restoring another system's file keeps this pair together. Unlike `instance_id`, which a restore
  replaces on purpose (`data-model.md` → *The compatibility guard*).
- **Re-pairing is a console action** (`--adopt-ledger`, `backend/ledger_adoption.py`), for the reason
  `--reset-password` is: whoever can run it can already read both files, and anyone who can reach the
  server cannot choose which ledger its sign-ins open.

`data-model.md` is authoritative on tables and fields.

#### Developer reset tools

With `LUMA_DEVELOPER_OPTIONS=true`, Settings exposes resets that each clear one layer, because they have
different effects on startup:

- **Clear browser-local state:** `localStorage` / `sessionStorage`
- **Clear saved preferences:** the current user's `ui_preference` rows
- **Clear import memory:** backend import-memory data in the data database
- **Reset to first-run:** deletes every `user_account` and reloads to the welcome screen. In auth mode
  it first turns sign-in protection off, then removes all users, the current session's identity last.
  `Clear all` does this plus the three clears above.

## Cross-platform approach

Luma runs on Windows, Linux, macOS, and Raspberry Pi / ARM Linux. `operations.md` has the operator's
view of each topology and `releasing.md` the build.

### Standalone and server mode

`python -m backend.desktop` serves the SPA and the API from one process on loopback and opens a browser
at it.

- **The bind is `127.0.0.1` and the URL handed out is `http://localhost:<port>`**, because a WebAuthn
  Relying Party id must be a domain; the address form would disable every passkey.
- **The port is `FRONTEND_PORT`**, since this process is what the browser reaches; `BACKEND_PORT` is not
  read. It is preferred, not guaranteed: a busy port falls back to an ephemeral one, and the launcher
  says so. Nothing durable is keyed to the port.
- **Server mode** (`SERVER_MODE`, or `--server`) is the same process without the desktop conveniences —
  no browser, no in-app stop, no joining a running instance — and with the port required, because a
  reverse proxy is configured with it. The bind stays loopback behind a TLS proxy and follows
  `FRONTEND_HOST` when the process is put on the network itself.
- **A lockfile in the data directory records the port**, so a second launch opens a tab against the
  running instance instead of starting a second process on the same databases. It survives a crash, so
  `/api/health` decides whether the recorded instance is there. It only knows instances the launcher
  started.
- **Opening a browser is a convenience.** No opener reports success reliably, so the printed URL is
  what the user relies on. WSL uses `wslview`, then `explorer.exe`. On Linux the launcher starts
  `xdg-open` itself with its output discarded and in its own session, so browser startup output stays
  off Luma's console and Ctrl+C does not close the browser; an explicit `BROWSER` defers to Python's
  `webbrowser`. `--no-browser` skips the attempt.

### Stopping

- **The app can stop itself where the launcher started it.** `backend/routers/app_control.py` exposes
  `POST /api/app/shutdown`, and the navigation panel offers "Shut down Luma". The launcher registers a
  handler when it creates the server; a deployment started with plain uvicorn has none, so the route
  refuses and the control is not drawn. A desktop user needs it because a macOS bundle's Dock Quit is an
  Apple Event the Python process cannot answer; on a supervised server it would let one user stop the
  service for everyone. The handler asks for a graceful shutdown after the response is sent.
- **Every way of stopping sets `server.should_exit`**, uvicorn's graceful path, so in-flight requests
  finish and the lockfile is released. `backend/desktop.py` installs its own signal handlers:
  - **SIGTERM**, because uvicorn restores the previous handler on exit and re-raises the signal, which
    would otherwise reach `SIG_DFL` and kill the process before cleanup.
  - **SIGHUP**, which uvicorn does not handle, so closing the terminal stops the app gracefully.
  - **SIGINT**, because a Ctrl+C can be delivered twice (the terminal signals the process group and the
    onefile bootloader forwards it). A second SIGINT is not a force quit (`_GracefulServer`);
    `GRACEFUL_SHUTDOWN_SECONDS` bounds the wait instead.

  The handlers request a stop, which also covers a quit during startup, before uvicorn's own exist.

### Liveness in the browser

`frontend/src/lib/backendLiveness.js` tells every open tab when the backend has stopped, without
polling.

- The api layer routes every request through one wrapper. A rejection with no `.status` never reached a
  server. One failure then probes `/api/health` (coalesced), and only a failed probe is reported.
- `BroadcastChannel` tells the other tabs, and the in-app shutdown announces itself the same way.
- A probe on returning to visibility covers a tab that was idle when the app was quit.
- Route chunks load through dynamic `import()`, which the api layer never sees, so the lazy loaders
  report failures into the same watch. `AppErrorBoundary` waits for the probe before rendering, because
  a stale chunk hash against a live server fails the same way.
- **The stopped state latches, and coming back is a reload**, because a restart may be on a different
  port, session or database. Once stopped, any click, keypress or the "Check again" button probes for a
  return, and a confirmed return is broadcast so every tab reloads.

### Packaged builds

**A packaged build has two roots.** `runtime_config.bundle_root()` is where resources shipped inside the
app live (the built frontend); in a PyInstaller onefile build that is a temporary directory deleted on
exit. `runtime_config.install_root()` is where the executable sits, where a portable copy keeps its
databases and optional `.env`. A checkout has one directory serving as both.

`anchor_relative()` resolves a relative `DATA_DIR` (or `DB_PATH` / `CONTROL_DB_PATH`) against the
install root **in a packaged build only**, so a portable copy behaves the same however it is launched,
while a checkout keeps the working-directory meaning. The portable archive therefore ships no
configuration file: the default `DATA_DIR = "."` means "beside the executable" once frozen.
`scripts/luma.spec` and `scripts/build_desktop.py` produce the artifact; `backend/requirements-build.txt`
holds the build-only dependency.

### Distribution forms and the build stamp

**Where writable data defaults to follows from how a copy was distributed.** A **portable** copy (the
Windows zip, the Linux tar) keeps its databases beside the executable. An **installed** one keeps them
in the per-OS user-data directory (`%LOCALAPPDATA%\Luma`, `~/Library/Application Support/Luma`,
`$XDG_DATA_HOME` or `~/.local/share` plus `luma`), because it may sit somewhere the user does not own
and is replaced by an upgrade. The two are the same binary, so `scripts/luma.spec` writes the form into
the bundle as a one-word file selected by `LUMA_DIST_FORM`, and `runtime_config.distribution_form()`
reads it.

A checkout is recognized, not declared. A build with a missing or unrecognized declaration falls back to
**installed on macOS and portable elsewhere**, since "beside the executable" on macOS is inside
`Luma.app/Contents/MacOS`; `scripts/luma.spec` refuses to build a portable macOS artifact. An installed
build reads its optional `.env` from `user_data_dir()`, not `data_dir()`, because that file may set
`DATA_DIR`.

**The build stamp** uses the same mechanism. `APP_VERSION` names a release, so
`scripts/build_stamp.py` derives the commit with `git describe`, `scripts/luma.spec` writes it into the
bundle as `build-stamp`, and `runtime_config.build_stamp()` reads it for the About panel and the log
start lines. Only a frozen copy reports one. See `releasing.md` → *What identifies a build*.

### macOS packaging

Elsewhere the artifact is a onefile binary; macOS gets a onedir build inside a `Luma.app` bundle,
shipped in a `.dmg`.

- **The bundle is assembled by `scripts/build_desktop.py` around a native wrapper** (`macos/main.swift`),
  because LaunchServices expects an application to check in with the window server and a Python process
  does not. The wrapper is the application and the server is its child.
- **Each watches the other.** The wrapper holds the write end of a pipe whose read end is the child's
  stdin, so a zero-length read means the wrapper is gone, including after SIGKILL; the wrapper quits
  when the server exits.
- **onedir**, because a onefile bootloader forks and the wrapper's quit signal would reach the wrong
  process.
- **Output goes to `luma-desktop.log`** beside the data when the app was started by LaunchServices,
  detected by the environment variable it sets rather than by whether stdout is a terminal, so
  `scripts/smoke_artifact.py` can still capture output through a pipe. The startup line omits the Ctrl+C
  advice when it goes to a log.

### TLS trust

`backend/main.py` calls `truststore.inject_into_ssl()` during bootstrap, so certificate verification
uses the operating system's store. A frozen macOS build carries an OpenSSL whose default CA path is the
build machine's, so without this it has no trust store. `backend/tests/test_system_trust_store.py` pins
both the stdlib path and urllib3's separately bound reference, which the Plaid SDK verifies against.

### License

- A binary is a conveyed copy, so the AGPL text accompanies it. `scripts/luma.spec` places `LICENSE` at
  the bundle root, `runtime_config.bundled_license_path()` finds it in a build and a checkout alike,
  `GET /api/app/license` serves it, and the auth status payload reports `bundled_license_available`.
- `scripts/build_desktop.py` also writes `LICENSE` beside the executable in each archive, for someone
  who never runs the binary. The bundled copy serves a user of a hosted instance, who never receives the
  archive.
- **The About page shows one license link and prefers the local copy.** Without one it falls back to the
  FSF's text (`LICENSE_CANONICAL_URL`), which no fork controls. Every link on the page is a plain
  anchor, so nothing is fetched until a click, in keeping with the README's *Local unless told
  otherwise*.

### Checking for a new version

The check is the one outbound request no click directly causes, so it is opt-in: off until switched on
at the welcome screen or in Settings → About. `services/update_check.py` asks GitHub for the latest
published release and compares its tag with `APP_VERSION`.

- **Install-wide:** the setting is in the control database's `app_setting`, since the server makes the
  request. Switching it on and *Check now* are admin-or-local.
- **Request-driven on a watermark** (`MIN_INTERVAL_HOURS`), called from `App.jsx` when the data scope
  activates. The watermark is written before the request and advances on failure, so an install with no
  route out does not retry on every load.
- **Only a version number is taken from the reply.** A tag that does not parse as `vX.Y.Z` is ignored
  and the link shown is a constant.
- **The request carries nothing about the install.**
- Whether an update is available is decided at read time against the running version, so the Tasks
  reminder clears after an upgrade. Its dismissal key includes the version, so a dismissal covers one
  release.
- Nothing is downloaded or installed, since a kit, a container and a checkout each update differently.

### The data-location line

The navigation pane can show which database this copy is open on. `app_config.data_location()` reports
the ledger and control-database paths, read from the modules that hold them, with a shortened form for
display and a `show_by_default` flag.

- **The flag is the default of a user preference.** It is true when the databases are not at this
  build's default location, when the copy is a checkout, or when developer options are on. An untouched
  preference follows it; an explicit choice wins.
- **The paths are admin-or-local information, gated on the server.** The status payload carries
  `data_location` only for a session that could read `/auth/config` (`_session_can_manage_config`). The
  toggle sits in Settings → Appearance and appears only when that field is present, so the switch and the
  line follow one rule.
- **The server's name is not gated, and not part of the toggle.** The interface's name is fixed at build
  time, so the status payload carries `server_name` (`APP_NAME`) for every session, and the pane shows it
  when it differs from the build's or carries a colour. Which copy this is matters to every user of two
  copies, since each user's saved passkeys are labelled with the name.
- **The colour never becomes part of the name.** `APP_NAME` may start with one colour from
  `APP_NAME_COLORS` (`<red>Luma Demo`). `runtime_config.parse_app_name` splits it off, so `app_name()`
  returns plain text to every reader (passkey labels, the sign-in issuer, the tray, the CLI), and anything
  else tag-shaped refuses the value: the server will not start, since a typo kept as text would be written
  into passkey labels that cannot be corrected. A colour with no name is dropped, with a warning in the
  startup log. The configuration report shows the value as written.

## Where to change things

- **New API behavior:** add or update a router in `backend/routers/`

- **Schema changes:** update `init_db` **and** register a `@migration(N)` (plus a
  `POST_RESTORE_DATA_INIT[N]` step when the migration derives data from existing rows) in
  `backend/db/database.py` — see `data-model.md` → *Schema evolution*

- **Shared transaction editing/display behavior:** `TransactionRow.jsx`

- **Shared detail-panel behavior:** `detailShared.jsx`

- **User-facing setup or behavior changes:** `README.md`, and an entry under `[Unreleased]` in
  `CHANGELOG.md` when the change is notable (see `AGENTS.md` → *Documentation Consistency*)

- **Version bump:** `APP_VERSION` in `backend/runtime_config.py` is authoritative. `frontend/package.json`
  and `backend/pyproject.toml` carry their own copy because npm and Python packaging read theirs before
  any app code runs. `backend/version_sources.py` states where those literals live; it is shared by
  `backend/tests/test_app_version.py` (which fails when they disagree) and `scripts/release.py
  --set-version` (which rewrites all three).

## Open

- **Dependency-based query-cache invalidation**, replacing the hand-wired refresh map.
  → [`backlog/query-cache-invalidation.md`](backlog/query-cache-invalidation.md)
