<!-- SPDX-FileCopyrightText: 2026 Jeffrey Orlin -->
<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# Architecture

This document provides a compact technical overview of FinTrack.

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

The browser talks only to the local backend API. Core application data and
persistence are local; external network dependencies are limited to optional
integrations such as Plaid.

## Backend structure

- **`backend/main.py`:** bootstrap, middleware, and router registration
- **`backend/db/database.py`:** SQLite connection handling, schema creation,
  migrations, and seed data
- **`backend/routers/`:** feature-oriented API endpoints
- **`backend/services/`:** shared backend logic such as categorization and
  crypto helpers

The backend favors explicit SQL and feature-oriented router modules over a heavy
ORM layer.

## Frontend structure

- **`frontend/src/App.jsx`:** app shell, navigation, and page routing
- **`frontend/src/pages/`:** top-level screens such as Dashboard, Transactions,
  Rules, and Import / Export
- **`frontend/src/components/`:** shared UI and interaction building blocks
- **`frontend/src/lib/api.js`:** central API wrapper used by the frontend
- **`frontend/src/lib/FilterContext.jsx`:** shared
  date/account/owner/group filtering state

The frontend mixes page-specific screens with a small set of shared interaction
surfaces:

- **`TransactionRow.jsx`:** shared transaction display/editing behavior
- **`detailShared.jsx`:** shared detail-panel shell, chart, and lazy-loading behavior
- **`lib/uiInteractions.js`:** shared interaction hooks for dismissible layers,
  popups, escape handling, and transient text editing
- **`components/TransientTextInput.jsx`:** shared single-field transient edit
  control used when Enter/blur should commit and Escape should cancel back to
  the pre-edit value

There are shared primitives designed to create a uniform user experience.
Unless a frontend interaction has special requirements, it should use the
shared interaction primitives in `frontend/src/lib/uiInteractions.js` and
`frontend/src/components/TransientTextInput.jsx` instead of page-local
reimplementation. Search boxes, filters, and other intentionally custom
controls sometimes contain page-specific logic.

## Data flow

Typical request flow:

1. A page reads global filters from `FilterContext`
2. The page calls `api.js`
3. FastAPI router executes SQL against SQLite
4. JSON response returns to the page
5. Local state updates, often optimistically for inline edits

For many inline edits, the UI updates first and the API call is fire-and-forget.
This keeps interaction responsive and is acceptable because the backend remains
the durable source of truth and the expected level of concurrent editing is low.

## Major subsystems

### Transactions and summaries

- **Backend:** `backend/routers/transactions.py`
- **Handles:** transaction lists, category overrides, merchant name edits, and
  summary queries for dashboard and detail panels
- **Used by:** Transactions page and dashboard/detail drill-down surfaces

### Rules and categorization

- **Storage:** `category_rule`
- **Runtime:** categorizer service
- **Behavior:** rules are ordered automatically by specificity; rules can
  assign categories and optionally rename merchants; manually overridden
  transaction categories are preserved

### Import / export

- **Backend:** `backend/routers/import_export.py`
- **Handles:** CSV preview/import, saved import profiles, undoable import
  batches, CSV export, data backup/restore, and credentials backup/restore
- **Note:** the module is large because the import/export workflow is
  concentrated in a single feature area

### Detail panels

- **Panels:** payee detail, category detail, account detail
- **Shared behavior:** draggable shell, monthly bar charts, month selection,
  lazy-loaded transaction lists, and remembered floating position
- **Shared implementation:** `frontend/src/components/detailShared.jsx`

### Storage layers

FinTrack uses several distinct storage layers for working state.

#### Browser-local storage

- **Lives in:** browser `localStorage` and browser `sessionStorage`
- **Lifespan:** `localStorage` survives reloads on the same browser profile until
  cleared; `sessionStorage` lasts only for the current browser tab/session
- **Contains:** browser-specific remembered local-profile selection, import
  draft/fallback state, migration fallback values from older UI preference
  storage, and other machine-local or browser-local UI state that should not
  be treated as durable shared preference data

#### Frontend session state

- **Lives in:** React state in the running frontend session
- **Lifespan:** lasts until page reload, app restart, or active user/profile change
- **Contains:** in-memory copy of loaded user/profile preferences, transient edit
  drafts, open/closed UI state for the current interaction, and other
  short-lived state needed to keep interaction responsive
- **Key files:** `frontend/src/lib/UserPreferencesContext.jsx`,
  `frontend/src/lib/api.js`

#### Preference storage in the control database

- **Lives in:** `backend/control.db`
- **Lifespan:** durable until explicitly changed or cleared
- **Contains:** per-user preferences in authenticated mode, per-local-profile
  preferences in local access mode, and other small JSON-friendly UI preference
  values that should follow the active user or local profile
- **Authenticated mode:** keyed to the signed-in user
- **Local access mode:** keyed to a lightweight **local profile** instead of a
  security identity
- **Key files:** `backend/db/control_database.py`, `backend/routers/auth.py`,
  `frontend/src/lib/UserPreferencesContext.jsx`

#### Local-profile records in the control database

- **Lives in:** `backend/control.db`
- **Lifespan:** durable until explicitly deleted
- **Contains:** local access mode profile identities used to separate layout/view
  preferences for different people sharing one database
- **Properties:** selected from the browser-facing profile picker in
  `frontend/src/App.jsx`; not authentication or authorization identities; used
  to scope preference data and startup behavior in local mode

#### Application data database

- **Lives in:** `backend/fintrack.db`
- **Lifespan:** durable application data until changed, deleted, restored, or
  replaced
- **Contains:** transactions, categories, rules, accounts, owners, saved import
  profiles, import batches, snapshots, and other import/export data

#### Developer reset tools

When `FINTRACK_DEVELOPER_OPTIONS=true`, the Settings page exposes developer
reset actions that clear these layers selectively:

- **`Clear browser-local state`:** clears browser `localStorage` / `sessionStorage`
- **`Clear saved preferences`:** clears preference values stored in the control
  database
- **`Clear import memory`:** clears backend import-memory data stored in the main
  application database
- **`Clear local user profiles`:** clears local-profile records stored in the
  control database

These resets remain separate because they target different storage layers with
different lifespans and different effects on startup behavior.

## Cross-platform approach

FinTrack is intended to run on:

- Windows
- Linux
- macOS
- Raspberry Pi / ARM Linux

Where commands differ, the repo should provide script wrappers or document the
differences clearly in `README.md`.

## Where to change things

- **New API behavior:** add or update a router in `backend/routers/`
- **Schema changes:** add a migration in `backend/db/database.py`
- **Shared transaction editing/display behavior:** update `TransactionRow.jsx`
- **Shared detail-panel behavior:** update `detailShared.jsx`
- **User-facing setup or behavior changes:** update `README.md` and possibly
  `CHANGELOG.md`
