# Contributing

FinTrack is currently a small, fast-moving project. This guide is mainly here to
help future contributors, including future-me, make changes without having to
reverse-engineer the project conventions first.

## Goals

- Keep the app easy to run locally on Windows, Linux, and macOS
- Prefer clear behavior and maintainability over cleverness
- Preserve existing product conventions unless there is a deliberate reason to change them
- Update user-facing docs when behavior changes in a meaningful way

## Local development

The easiest way to start the app is with the launcher scripts documented in
[README.md](README.md).

For manual development:

```bash
# backend
cd backend
python -m venv venv
venv\Scripts\activate    # Windows
source venv/bin/activate # Unix-like shells
pip install -r requirements.txt
uvicorn main:app --reload --reload-exclude "db/test_fixtures" --host 0.0.0.0 --port 8000
```

```bash
# frontend
cd frontend
npm install
npm run dev
```

## Useful checks

Before committing, run what makes sense for the files you changed:

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

If you touched larger backend areas, it is also worth starting the app and
clicking through the affected flow manually.

## Project conventions

### Backend

- FastAPI routers live under `backend/routers/`
- Database setup and migrations live in `backend/db/database.py`
- New schema changes should be implemented as migrations, not ad-hoc SQL edits
- SQLite is the source of truth; prefer simple, explicit SQL over abstraction layers

### Frontend

- Shared transaction display/editing behavior belongs in
  `frontend/src/components/TransactionRow.jsx`
- Shared detail-panel behavior belongs in
  `frontend/src/components/detailShared.jsx`
- Prefer reusing shared components over duplicating page-specific variants
- Optimistic UI is acceptable when it keeps local interaction smooth and failures
  are low-risk

## Important product invariants

- Amount sign convention:
  positive = money out, negative = money in
- Categories are two-level only:
  groups at the top, leaf categories underneath
- Transactions should be assigned to leaf categories, not groups
- Rule specificity is automatic:
  more specific rules override more general ones without manual priority ordering
- `exclude_from_totals` removes a group and its descendants from summaries/charts

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
