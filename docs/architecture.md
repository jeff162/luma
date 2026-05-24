# Architecture

This document provides a compact technical overview of FinTrack.

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

## High-level shape

FinTrack is a local-first web application with:

- a **FastAPI** backend in `backend/`

- a **React + Vite** frontend in `frontend/`

- **SQLite** as the persistent store

The browser talks only to the local backend API. Core application data and persistence are local; external network dependencies are limited to optional integrations such as Plaid.

## Backend structure

- **`backend/main.py`:** bootstrap, middleware, and router registration

- **`backend/db/database.py`:** SQLite connection handling, schema creation, migrations, and seed data

- **`backend/routers/`:** feature-oriented API endpoints

- **`backend/services/`:** shared backend logic such as categorization and crypto helpers

The backend favors explicit SQL and feature-oriented router modules over a heavy ORM layer.

## Frontend structure

- **`frontend/src/App.jsx`:** app shell, navigation, page routing, and route-level lazy loading for the main screens

- **`frontend/src/pages/`:** top-level screens such as Dashboard, Transactions, Rules, and Import / Export

- **`frontend/src/components/`:** shared UI and interaction building blocks

- **`frontend/src/lib/api.js`:** central API wrapper used by the frontend

- **`frontend/src/lib/FilterContext.jsx`:** shared date/account/owner/group filtering state

- **`frontend/src/lib/AppSessionContext.jsx`:** shared bootstrap/session metadata such as the active preference subject and database instance id so pages can reuse shell-loaded auth state instead of re-fetching it

The frontend mixes page-specific screens with a small set of shared interaction surfaces:

- **`TransactionRow.jsx`:** shared transaction display/editing behavior

- **`detailShared.jsx`:** shared detail-panel shell, chart, and lazy-loading behavior

- **`components/ui.jsx`:** shared visual primitives for cards, buttons, floating panels, overlays, form control styling, and everyday confirm/notice/text-entry dialogs

- **`lib/uiInteractions.js`:** shared interaction hooks for dismissible layers, popups, escape handling, and transient text editing

- **`components/TransientTextInput.jsx`:** shared single-field transient edit control used when Enter/blur should commit and Escape should cancel back to the pre-edit value

There are shared primitives designed to create a uniform user experience. Unless a frontend interaction has special requirements, it should use the shared interaction primitives in `frontend/src/lib/uiInteractions.js` and `frontend/src/components/TransientTextInput.jsx` instead of a page-local version. Search boxes, filters, and other intentionally custom controls sometimes contain page-specific logic.

The concern behind this is interaction drift. Repeated popovers, inline editors, and dismissal rules are easy to make "almost the same" on each page, which creates both subtle bugs and a less coherent product feel over time.

- **Local-mode onboarding:** when auth is off and no local preference profiles exist yet, `App.jsx` opens a first-run welcome flow that can seed multiple local profiles, optional account owners, default imported-category behavior, and an optional next route such as data-provider setup before the normal shell appears

Keeping this in `App.jsx` makes it part of bootstrap rather than a repeatable workflow. The main need is to block the ordinary shell until there is enough local-profile state to scope preferences cleanly, not to create a long-lived page in the app’s information architecture.

## Data flow

Typical request flow:

1. A page reads global filters from `FilterContext`

2. The page calls `api.js`

3. FastAPI router executes SQL against SQLite

4. JSON response returns to the page

5. Local state updates, often optimistically for inline edits

For many inline edits, the UI updates first and the API call is fire-and-forget. This keeps interaction responsive and is acceptable because the backend remains the durable source of truth and the expected level of concurrent editing is low.

This is a deliberate tradeoff toward local responsiveness. FinTrack is optimized for a mostly single-user, local-first workflow, so a small amount of optimistic UI is preferable to making everyday edits feel remote or form-heavy.

## Major subsystems

### Transactions and summaries

- **Backend:** `backend/routers/transactions.py`

- **Handles:** transaction lists, category overrides, merchant name edits, and summary queries for dashboard and detail panels
- **Uncategorized contract:** transactions with `category_id = NULL` stay as one stored state, while shared summaries and tree surfaces may expose separate synthetic expense and income buckets so uncategorized credits do not masquerade as expense activity

- **Used by:** Transactions page and dashboard/detail drill-down surfaces

### Rules and categorization

- **Storage:** `category\_rule`

- **Runtime:** categorizer service

- **Behavior:** rules are ordered automatically by specificity; rules can assign categories, scope amount rules to debits or credits, rename merchants, and add transaction tags; manually overridden transaction categories are preserved, while per-transaction tag edits override only that row's rule-derived tag presence

### Transaction tags

- **Storage:** `tag`, `rule_tag`, `txn_tag`, `category_tag`

- **Runtime:** shared transaction-tag service plus shared row UI; the picker (`components/TagPickerWithCreate.jsx`) is the one surface for browsing and creating tags, used from transaction rows and from the Categories right panel

- **Behavior:** tags are lightweight labels separate from categories. A transaction's effective tags are the additive union of direct tags (rule + manual via `txn_tag`), tags on its leaf category, and tags on the leaf category's parent group (both via `category_tag`). Rules contribute a union of tag assignments across all matching rules, and transactions keep a per-tag manual override state for the *direct* layer; inherited (category- and group-level) tags are not overridable per-transaction at present. Tag filtering and aggregation match against effective tags, so reporting picks up tags applied at the most natural level

- **Reporting:** the dashboard's "Spending by …" picker offers built-in `group` / `category` partitions plus user-saved tag reports built on the multi-tag breakdown; combination wedges represent transactions matching multiple selected tags, and an `Other / Untagged` wedge holds the remainder

### Import / export

- **Backend:** `backend/routers/import\_export.py`

- **Handles:** CSV preview/import, saved import profiles, support undo import operations, CSV export, data backup/restore, and credentials backup/restore

- **Effective-account behavior:** import review, saved-profile summaries, and CSV export resolve grouped child accounts through the parent's display name so historical account numbers still read as one physical account outside the Accounts page

- **Import history contract:** recent-import batch rows expose lightweight summary data; large duplicate-review payloads are fetched separately when the duplicate viewer is opened

- **Duplicate matching contract:** import dedupe always keeps the exact content-hash path as the high-confidence rule, while lower-confidence cross-source matches rely on stored import evidence and stay visible in duplicate review with an explicit reason instead of being silently treated like exact duplicates

- **Saved-data-source behavior:** saved data sources remember whether imported files from that source should use categories present in the data by default, while each completed import batch keeps the actual per-file decision and scope used for that file

- **Imported-category behavior:** imports that use categories present in the data can apply those file categories directly to imported transactions, add missing imported categories as real leaf categories under the protected system `Unassigned` group, and feed those categorized transactions into the shared rule-suggestion workflow; placeholder labels that only mean "not categorized yet" are normalized back to `NULL` instead of creating a real category

- **Template-file behavior:** the saved-data-source editor remembers which CSV filename/hash last served as its template, but the user still explicitly chooses a template file when they want live column choices for editing

- **Delete fallback:** deleting a saved data source moves its files back into the unknown-source bucket while preserving each batch's own imported-category usage state

- **Note:** the module is large because the import/export workflow is concentrated in a single feature area

That concentration is intentional. Import behavior is one of the places where many small decisions have to stay consistent across preview, saved profiles, history, undo, duplicate handling, category application, and rule learning, so keeping the workflow logic close together reduces drift between those stages.

### Detail panels

- **Panels:** payee detail, category detail, account detail

- **Shared behavior:** draggable shell, monthly bar charts, month selection, lazy-loaded transaction lists, and page-driven default placement when multiple panels are open

- **Reporting contract:** Expense/Income are simply how the user thinks about their data. Expenses can include positive values for various reasons, an expense might get reimbursed, a purchase might be returned for a refund, etc. These monies received are not income, they offset an expenditure. To support this detail drawers and dashboard summaries should not drop rows just because a transaction's sign is unusual for an expense or income category; they include all matching rows for the selected slice and use the net amount.

- **Shared implementation:** `frontend/src/components/detailShared.jsx`

### Storage layers

FinTrack uses several distinct storage layers for working state.

#### Browser-local storage

- **Lives in:** browser `localStorage` and browser `sessionStorage`

- **Lifespan:** `localStorage` survives reloads on the same browser profile until cleared; `sessionStorage` lasts only for the current browser tab/session

- **Contains:** browser-specific remembered local-profile selection, import draft/fallback state, migration fallback values from older UI preference storage, and other machine-local or browser-local UI state that should not be treated as durable shared preference data

#### Frontend session state

- **Lives in:** React state in the running frontend session

- **Lifespan:** lasts until page reload, app restart, or active user/profile change

- **Contains:** in-memory copy of loaded user/profile preferences, transient edit drafts, open/closed UI state for the current interaction, and other short-lived state needed to keep interaction responsive

- **Key files:** `frontend/src/lib/UserPreferencesContext.jsx`, `frontend/src/lib/api.js`

#### Preference storage in the control database

- **Lives in:** `backend/fintrack-control.db`

- **Lifespan:** durable until explicitly changed or cleared

- **Contains:** per-user preferences in authenticated mode, per-local-profile preferences in local access mode, and other small JSON-friendly UI preference values that should follow the active user or local profile

- **Authenticated mode:** keyed to the signed-in user

- **Local access mode:** keyed to a lightweight **local profile** instead of a security identity

- **Key files:** `backend/db/control\_database.py`, `backend/routers/auth.py`, `frontend/src/lib/UserPreferencesContext.jsx`

#### Local-profile records in the control database

- **Lives in:** `backend/fintrack-control.db`

- **Lifespan:** durable until explicitly deleted

- **Contains:** local access mode profile identities used to separate layout/view preferences for different people sharing one database

- **Properties:** selected from the browser-facing profile picker in `frontend/src/App.jsx`; not authentication or authorization identities; used to scope preference data and startup behavior in local mode

#### Application data database

- **Lives in:** `backend/fintrack-data.db`

- **Lifespan:** durable application data until changed, deleted, restored, or replaced

- **Contains:** transactions, categories, rules, accounts, owners, saved import profiles, import batches, snapshots, and other import/export data

- **Account lifecycle note:** account rows can participate in a parent/child merge model for reissued account numbers, and child accounts can move through a recoverable trash state before permanent cleanup folds their references into the parent

- **Account regrouping note:** dragging one merged parent onto another top-level account flattens the dragged group's visible members under the new parent instead of preserving a nested account tree

#### Developer reset tools

When `FINTRACK\_DEVELOPER\_OPTIONS=true`, the Settings page exposes developer reset actions that clear these layers selectively:

- **`Clear browser-local state`:** clears browser `localStorage` / `sessionStorage`

- **`Clear saved preferences`:** clears preference values stored in the control database

- **`Clear import memory`:** clears backend import-memory data stored in the main application database

- **`Clear local user profiles`:** clears local-profile records stored in the control database

These resets remain separate because they target different storage layers with different lifespans and different effects on startup behavior.

The separation is important because "resetting the app" can mean very different things in practice. Browser-local troubleshooting, preference cleanup, import-workflow cleanup, and removing local profiles are all recoveries with different blast radii, so the tooling keeps them explicit instead of hiding them behind one broad reset.

## Cross-platform approach

FinTrack is intended to run on:

- Windows

- Linux

- macOS

- Raspberry Pi / ARM Linux

Where commands differ, the repo should provide script wrappers or document the differences clearly in `README.md`.

## Where to change things

- **New API behavior:** add or update a router in `backend/routers/`

- **Schema changes:** add a migration in `backend/db/database.py`

- **Shared transaction editing/display behavior:** update `TransactionRow.jsx`

- **Shared detail-panel behavior:** update `detailShared.jsx`

- **User-facing setup or behavior changes:** update `README.md` and possibly `CHANGELOG.md`
