<!-- SPDX-FileCopyrightText: 2026 Jeffrey Orlin -->
<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# Contributing

This guide records the main conventions contributors should follow when
changing the application.

## Contents

- [Goals](#goals)
- [Local development](#local-development)
- [Useful checks](#useful-checks)
- [Project conventions](#project-conventions)
- [Important product invariants](#important-product-invariants)
- [Documentation expectations](#documentation-expectations)

## Goals

- Keep the app easy to run locally on Windows, Linux, and macOS
- Prefer clear behavior and maintainability over cleverness
- Preserve existing product conventions unless there is a deliberate reason to change them
- Update user-facing docs when behavior changes in a meaningful way

## Local development

For the shortest local startup path, use the launcher scripts documented in
[README.md](README.md).

For manual development:

```bash
# backend
cd backend
python -m venv venv
venv\Scripts\activate    # Windows
source venv/bin/activate # Unix-like shells
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

```bash
# frontend
cd frontend
npm install
npm run dev
```

Many contributors may use WSL on Windows, so shell examples and local tooling should stay WSL-friendly where practical.

### Developer flag

Set in `.env` to expose Developer options on the main Settings page:

```bash
LUMA_DEVELOPER_OPTIONS=true
```

## Useful checks

Before committing, run the checks that match the changed files:

```bash
# frontend production build
cd frontend
npm run build
```

```bash
# backend syntax sanity check
cd backend
py -3.12 -m py_compile main.py
```

For larger backend changes, also start the app and exercise the affected flow
manually.

### UI checks

Playwright is available for local UI verification from `frontend/`:

```bash
cd frontend
npm run ui:test
npm run ui:test -- --headed
npm run ui:codegen
```

The Playwright config reads the frontend dev-server port from the repo-root
`.env` via `FRONTEND_PORT`. If needed, `PLAYWRIGHT_BASE_URL` can override the
target URL explicitly for one run.

## Hooks and lint

Running `npm install` in `frontend/` installs the repo pre-commit hook via the
frontend `postinstall` script.

If you need to install or refresh the hook manually, run:

```bash
./scripts/install-hooks.sh
```

That hook does not run the full frontend build or Playwright suite. It checks
comment/documentation lint only for staged files:

- staged `frontend/*` files run `node frontend/scripts/check-comments.js`
- staged `backend/*.py` files run `python backend/scripts/check_comments.py`

You can run the same combined check manually from `frontend/`:

```bash
cd frontend
npm run lint
```

## Project conventions

### Backend

- **Routers:** `backend/routers/`
- **Database setup and migrations:** `backend/db/database.py`
- **Schema changes:** implement as migrations, not ad-hoc SQL edits
- **Database style:** SQLite is the source of truth; prefer simple, explicit SQL
  over abstraction layers

### Frontend

- **Shared transaction display/editing:** `frontend/src/components/TransactionRow.jsx`
- **Shared detail-panel behavior:** `frontend/src/components/detailShared.jsx`
- **Shared transient interaction behavior:** `frontend/src/lib/uiInteractions.js`
  and `frontend/src/components/TransientTextInput.jsx`
- **Component strategy:** prefer reusing shared components over duplicating
  page-specific variants
- **Optimistic UI:** acceptable when it keeps local interaction smooth and
  failures are low-risk

## Important product invariants

- **Amount sign convention:** positive = money out, negative = money in
- **Category depth:** groups at the top, leaf categories underneath
- **Transaction categorization:** transactions should be assigned to leaf
  categories, not groups
- **Rule specificity:** more specific rules override more general ones without
  manual priority ordering
- **`exclude_from_totals`:** removes a group and its descendants from
  summaries/charts

See [docs/data-model.md](docs/data-model.md) and
[docs/architecture.md](docs/architecture.md) for more detail.

## Documentation expectations

Update docs when a change affects:

- how the app is started or configured
- how a major feature behaves
- core data-model assumptions
- contributor workflow or extension points

As a rule of thumb:

- `README.md` explains what the app does and how to run it
- `CHANGELOG.md` records meaningful user-visible changes
- `docs/` files explain structure, architecture, and internal conventions
