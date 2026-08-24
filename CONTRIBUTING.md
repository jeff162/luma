# Contributing

This guide records the main conventions contributors should follow when
changing the application.

## Contents

- [Goals](#goals)
- [Local development](#local-development)
- [Useful checks](#useful-checks)
- [Hooks and lint](#hooks-and-lint)
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

For manual development, the backend requires **Python 3.12 or newer** (`backend/pyproject.toml` declares
`requires-python = ">=3.12"`). The venv belongs at `backend/venv/` — that is where every script in
`scripts/` looks for it.

```bash
# backend
cd backend
python3.12 -m venv venv       # or `py -3.12 -m venv venv` on Windows
venv\Scripts\activate         # Windows
source venv/bin/activate      # Unix-like shells
pip install -r requirements.txt
```

Start both halves together:

```bash
bash ./scripts/start_luma.sh                                        # macOS / Linux / WSL
scripts\start_luma.bat                                              # Windows
powershell -ExecutionPolicy Bypass -File .\scripts\start_luma.ps1   # Windows PowerShell
```

Or start them individually:

```bash
# backend — from the REPO ROOT, not from backend/, since the app is imported as backend.main
uvicorn backend.main:app --reload --reload-dir backend --host 0.0.0.0 --port 8000

# frontend
cd frontend
npm install
npm run dev
```

No `.env` file is required — a checkout runs on defaults (backend 8000, frontend 5173, databases in the
working directory), and the session secret is generated on first run into the control database. A
repo-root `.env` is the override mechanism, and is what most contributors will want for running against different databases (test v. prod) or different instances running on the same box:
`BACKEND_PORT` and `FRONTEND_PORT` are read by the launcher scripts and by `vite.config.js`,
and `DATA_DIR` specifies the database location. A hand-run `uvicorn`
does not read `.env` for its port, so pass the same value `.env` sets or the frontend will call a
backend that is not there. **Settings → Configuration** lists every effective value and its source.

`LUMA_ENV_FILE` points the backend at a different override file, and is set in the environment rather
than in one (it chooses which file is read, so it cannot live inside the file). It redirects **the backend
only** — `start_luma.sh`, `start_backend.sh`, and `vite.config.js` each read the repo-root `.env` directly
for their ports — so it is the right tool for pointing a backend at a throwaway database for testing, which is exactly
what `scripts/run-e2e-backend.sh` uses it for, and the wrong one for switching between whole
configurations. Switching those means choosing which file *is* `.env`.

Shell examples and local tooling should stay WSL-friendly where practical.

### Working with an AI assistant

The repo carries its own agent instructions, and they are worth pointing an assistant at explicitly
before it starts editing — most of the avoidable rework on this project has come from an agent
reconstructing the design from source instead of reading the file that already explains it.

A reasonable opening instruction:

> Check `CLAUDE.md`, your memory, and the relevant `docs/` before diving in.

**Give that instruction even though the files are meant to be automatic.** Claude Code loads
`CLAUDE.md` into context on its own and still benefits from being told to act on it — an instruction
that arrives as ambient background gets treated as background. Naming the files in the prompt is what
turns them from context into a step.

- **[CLAUDE.md](CLAUDE.md)** is the one Claude Code picks up automatically. It carries the hard rules
  and a routing index into `docs/`.
- **[AGENTS.md](AGENTS.md)** is the same guidance in the tool-agnostic open-standard file, for
  assistants that read it. Claude Code does **not** load it automatically, so name whichever your
  assistant actually reads — the two are written to agree, and each points at the other.
- **Your assistant's memory** is worth naming even though it is empty on a first clone. It accumulates
  the things a repo cannot record — what was tried and rejected, and how a particular contributor
  prefers to work — and once there is anything in it, an assistant that was never told to consult it
  will not.
- **`docs/`** holds the *why*. [docs/collaboration-notes.md](docs/collaboration-notes.md) covers
  decision principles and working habits, and [docs/agent-profile.md](docs/agent-profile.md) collects
  the operational footguns that recur across sessions. These live in the repo rather than in any one
  developer's assistant memory, so every contributor and every agent starts from the same guidance.

The rule most likely to be getting violated when work goes wrong: **read the relevant doc before
changing — or answering questions about — shared systems, persistence, invariants, or shared UI.**
"I'm only investigating" is not an exemption.

### Developer flag

Environment-only by design — it gates destructive reset tooling, so it is not an in-app toggle. Set it
in `.env` (or the shell) to expose Developer options on the main Settings page:

```bash
LUMA_DEVELOPER_OPTIONS=true
```

### Running it as a single process

The two-window setup above is the development arrangement. The application can also run as one process
that serves both halves and opens a browser at itself — the same shape the packaged downloads use:

```bash
cd frontend && npm run build && cd ..
backend/venv/bin/python -m backend.desktop    # Windows: backend\venv\Scripts\python -m backend.desktop
```

It listens on loopback only and stops with Ctrl+C. Launching it again while it is already running opens
a new tab against the existing instance rather than starting a second one. The frontend only needs
rebuilding when it changes.

The URL is printed on startup and is the reliable part; opening a browser is a convenience on top, and
`--no-browser` skips it for a machine reached over SSH or without a browser installed.

## Useful checks

Before committing, run the checks that match the changed files:

```bash
# frontend production build
cd frontend
npm run build
```

```bash
# backend test suite — wraps `python -m unittest` using backend/venv
scripts/run_tests.sh                                            # everything
scripts/run_tests.sh backend.tests.test_suspect_duplicates      # one module
```

Tests use isolated SQLite files under `tempfile.TemporaryDirectory()`, so they never touch the live
database and are safe to run with the backend still up. If a new dependency lands, re-run
`start_backend.sh` once to refresh the venv first.

For larger backend changes, also start the app and exercise the affected flow
manually.

### Frontend unit tests

`vitest` is the fast lane and the one to run after any frontend change:

```bash
cd frontend
npm test                 # the whole suite
npm test -- Backup       # files matching a name
```

It runs in Node — pure helpers in `src/lib` need no DOM, and a test that does opts in per file with a
`// @vitest-environment jsdom` directive — so it needs no browser and no running app. Tests live in a
`__tests__/` folder beside the code they cover.

### UI checks

Playwright is the end-to-end lane, driving real browsers against a running app. Available for local UI
verification from `frontend/`:

```bash
cd frontend
npm run ui:test
npm run ui:test:a11y
npm run ui:test:all
npm run ui:test -- --headed
npm run ui:codegen
```

`npm run ui:test` is the routine UI regression lane and skips the opt-in
browser accessibility audits. Run `npm run ui:test:a11y` when you want the
focused form-label/id sweep, or `npm run ui:test:all` to run both lanes
together.

The Playwright config pins its own ports (frontend 5199, backend 8099) and
runs against an isolated backend with throwaway databases, so it is unaffected
by a local `.env`. If needed, `PLAYWRIGHT_BASE_URL` can override the target URL
explicitly for one run.

## Hooks and lint

Running `npm install` in `frontend/` installs the repo pre-commit hook via the
frontend `postinstall` script.

If you need to install or refresh the hook manually, run:

```bash
./scripts/install-hooks.sh
```

That hook does not run the full frontend build or Playwright suite. It checks
only staged files:

- staged `frontend/*` files run `frontend/scripts/check-comments.js`
- staged `backend/*.py` files run `backend/scripts/check_comments.py` (through
  `scripts/run_backend_comment_check.js`, which finds the right Python on each
  platform), then `scripts/check-backend-timestamps.js`

### The timestamp guard

Stored timestamps are naive UTC and must come from `utcnow_iso()` in
`backend/time_utils.py`, the single chokepoint that keeps them consistent. The
guard blocks the two calls that quietly break that: `datetime.utcnow()`
(deprecated in 3.12+) and a no-arg `datetime.now()` (returns *local* time).

A few values genuinely are local time and are not stored timestamps at all — a
download filename the user reads as a date, or a ZIP entry's MS-DOS date/time
field, which carries no timezone and which every archive tool writes and reads
as local. Those take a per-line exemption with a **mandatory reason**:

```python
stamp = datetime.now()  # local-time: ZIP entry dates are MS-DOS fields with no timezone
```

The reason is required because an exemption that can be applied without saying
why is a rubber stamp. The marker applies to its own line only, and it exempts
`datetime.now()` alone — `datetime.utcnow()` has no local-time reading, so no
reason makes it correct. `backend/tests/test_timestamp_guard.py` pins both
halves; it is itself skipped by path, since a test for a lint rule has to
contain the thing the rule forbids.

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
