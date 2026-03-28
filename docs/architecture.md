# Architecture

This document gives a compact mental model of how FinTrack is put together.

## High-level shape

FinTrack is a local-first web app with:

- a **FastAPI** backend in `backend/`
- a **React + Vite** frontend in `frontend/`
- **SQLite** as the persistent store

The browser talks only to the local backend API. There is no required cloud
service except optional Plaid connectivity for bank sync.

## Backend structure

Key areas:

- `backend/main.py`
  App bootstrap, middleware, and router registration
- `backend/db/database.py`
  SQLite connection handling, schema creation, migrations, and seed data
- `backend/routers/`
  Feature-oriented API endpoints
- `backend/services/`
  Shared backend logic such as categorization and crypto helpers

The backend favors explicit SQL and simple router modules over a heavy ORM layer.

## Frontend structure

Key areas:

- `frontend/src/App.jsx`
  App shell, navigation, and page routing
- `frontend/src/pages/`
  Top-level screens such as Dashboard, Transactions, Rules, and Import / Export
- `frontend/src/components/`
  Shared UI and interaction building blocks
- `frontend/src/lib/api.js`
  Central API wrapper used by the frontend
- `frontend/src/lib/FilterContext.jsx`
  Shared date/account/owner/group filtering state

The frontend mixes page-specific components with a few important shared
interaction hubs:

- `TransactionRow.jsx`
  shared transaction display/editing behavior
- `detailShared.jsx`
  shared detail-panel shell, chart, and lazy-loading behavior

## Data flow

Typical UI flow:

1. A page reads global filters from `FilterContext`
2. The page calls `api.js`
3. FastAPI router executes SQL against SQLite
4. JSON response returns to the page
5. Local state updates, often optimistically for inline edits

For many inline edits, the UI updates first and the API call is fire-and-forget.
This keeps local interaction smooth and is acceptable because the app is
single-user or small-household oriented.

## Major subsystems

### Transactions and summaries

`backend/routers/transactions.py` serves:

- transaction lists
- category overrides
- merchant name edits
- summary queries for dashboard and detail panels

The frontend relies on these endpoints for both the Transactions page and the
dashboard/detail drill-down experience.

### Rules and categorization

Rules are stored in `category_rule` and applied by the categorizer service.

Important behavior:

- rules are ordered automatically by specificity
- rules can assign categories and optionally rename merchants
- manually overridden transaction categories are preserved

### Import / export

`backend/routers/import_export.py` handles:

- CSV preview/import
- saved import profiles
- undoable import batches
- CSV export
- data backup/restore
- credentials backup/restore

This file is intentionally large because the feature area has a lot of related
workflow logic in one place.

### Detail panels

There are three main detail panels:

- payee detail
- category detail
- account detail

They share:

- a draggable shell
- monthly bar charts
- month selection behavior
- lazy-loaded transaction lists
- remembered floating position

Those shared mechanics live in `frontend/src/components/detailShared.jsx`.

## Cross-platform approach

FinTrack is intended to run on:

- Windows
- Linux
- macOS
- Raspberry Pi / ARM Linux

Where commands differ, the repo tries to provide script wrappers or document the
differences clearly in `README.md`.

## Where to change things

- New API behavior:
  add or update a router in `backend/routers/`
- Schema changes:
  add a migration in `backend/db/database.py`
- Shared transaction editing/display behavior:
  update `TransactionRow.jsx`
- Shared detail-panel behavior:
  update `detailShared.jsx`
- User-facing setup or behavior changes:
  update `README.md` and possibly `CHANGELOG.md`

