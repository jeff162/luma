# Contributing

This guide covers the conventions to follow when you change the application.

## Contents

- [Goals](#goals)
- [Local development](#local-development)
- [Useful checks](#useful-checks)
- [What is tested, what isn't, and why](#what-is-tested-what-isnt-and-why)
- [Hooks and lint](#hooks-and-lint)
- [Project conventions](#project-conventions)
- [Important product invariants](#important-product-invariants)
- [Documentation expectations](#documentation-expectations)

## Goals

- Keep the app easy to run locally on Windows, Linux, and macOS
- Prefer clear behavior and maintainability over cleverness
- Keep existing product conventions unless there is a deliberate reason to change them
- Update user-facing docs when behavior changes in a meaningful way

## Local development

The quickest way to start the app is with the launcher scripts described in [README.md](README.md).

**Toolchain:** Python 3.12 or newer and Node.js 22.12 or newer. The packaged downloads are built on
3.12, and CI runs the backend suite on 3.14.

The launcher scripts expect the virtual environment at `backend/venv/`:

```bash
# backend
cd backend
python3.12 -m venv venv       # or `py -3.12 -m venv venv` on Windows
venv\Scripts\activate         # Windows
source venv/bin/activate      # Unix-like shells
pip install -r requirements.txt
```

Start the frontend and backend together:

```bash
bash ./scripts/start_luma.sh                                        # macOS / Linux / WSL
scripts\start_luma.bat                                              # Windows
powershell -ExecutionPolicy Bypass -File .\scripts\start_luma.ps1   # Windows PowerShell
```

Or separately:

```bash
# backend: run from the REPO ROOT, not from backend/
uvicorn backend.main:app --reload --reload-dir backend --port 8011

# frontend
cd frontend
npm install
npm run dev
```

When `npm install` reports advisories, check whether they affect the build and test tools or code the
user runs. `devDependencies` holds the build and test tools (vite, vitest, eslint and their trees). The
packages in `dependencies` are the ones that reach the user's browser, and an advisory there should be
resolved.

You only need a `.env` file to change a default; the defaults suit development. `env_example.txt`
describes each setting.

`LUMA_ENV_FILE` names a different `.env` file to load. It is an environment variable, not a `.env`
setting, and only the backend reads it: `start_luma.sh`, `start_backend.sh` and `vite.config.js` always
read the repo-root `.env`. `scripts/run-e2e-backend.sh` uses it to give a test backend its own databases.

Keep shell examples and local tooling WSL-friendly where practical.

### Working with an AI assistant

The repo includes instructions for AI assistants, and it is worth pointing your assistant at them
explicitly:

> Check `CLAUDE.md`, your memory, and the relevant `docs/` before diving in.

Naming them explicitly seems to make an assistant follow them more consistently, even though it loads
some of them on its own.

- **[CLAUDE.md](CLAUDE.md)** is the file Claude Code loads automatically. It holds the hard rule and an
  index of which `docs/` file covers what.
- **[AGENTS.md](AGENTS.md)** has the same guidance in the tool-agnostic open-standard file, for
  assistants that read it. Claude Code does **not** load it automatically, so name whichever file your
  assistant actually reads. The two are written to agree, and each points at the other.
- **Your assistant's memory** is worth naming even though it is empty on a first clone. Over time it
  collects what the repo can't record, such as what was tried and rejected and how you prefer to work.
  An assistant that is never told to check its memory won't.
- **`docs/`** records the *why*. [docs/collaboration-notes.md](docs/collaboration-notes.md) covers
  decision principles, and [docs/agent-profile.md](docs/agent-profile.md) lists the operational
  footguns that recur across sessions. These live in the repo rather than in any one developer's
  assistant memory, so every contributor and every agent starts from the same guidance.

When work goes wrong, this is the rule most likely to have been broken: **read the relevant doc before
changing, or answering questions about, shared systems, persistence, invariants, or shared UI.**
"I'm only investigating" is not an exemption.

### Developer flag

`LUMA_DEVELOPER_OPTIONS=true` in `.env` (or the shell) adds a Developer options section to
Settings, with tools that reset the app to a known state: clear browser storage, saved
preferences or import memory, or go back to the first-run welcome screen.

### Running as a single process

The two-window setup above is for development. The app can also run as a single process that serves
both the frontend and the backend and opens a browser. This is how the packaged downloads run:

```bash
cd frontend && npm run build && cd ..
backend/venv/bin/python -m backend.desktop    # Windows: backend\venv\Scripts\python -m backend.desktop
```

The backend listens on loopback only unless started in server mode (`--server`), and stops with Ctrl+C.
If you launch it again while it is already running, it opens a new tab on the running instance instead
of starting a second one.

A browser opens at startup. The `--no-browser` flag skips this, which is useful when no browser is
available.

**This serves the built frontend in `frontend/dist`**, so run `npm run build` after changing the
frontend.

### Running in Docker

`docker-compose.yml` runs the server setup in containers: the app in server mode, with a Caddy proxy in
front of it for HTTPS. From the top of a checkout, on a Linux host:

```bash
docker compose up -d --build     # build the image from this checkout and start it
docker compose logs app          # the address other computers open
docker compose down              # stop it
```

`--build` makes it run your checkout. Without it, Docker pulls the published image for the latest
release instead. The image builds the frontend from source, so `frontend/dist` isn't used. The
databases are written to `./data`, owned by root, and an optional `.env` at the top of the checkout is
read.

It needs a Linux host. Under Docker Desktop the containers run inside a virtual machine's network, so
neither the advertised name nor other computers can reach them. See `docs/operations.md` →
*Containers* for the details.

## Useful checks

One command runs the whole local test suite:

```bash
scripts/check_backend_and_frontend.sh        # backend suite + frontend lint + vitest + browser suite
scripts/check_backend_and_frontend.sh lint   # frontend lint only: seconds, no browser
```

Check `docs/transient-failures.md` before assuming a red run was caused by your change. It lists the
intermittent failures that are tracked but not yet understood.

`npm run check` in `frontend/` runs the frontend half of the suite (lint, then vitest, then the browser
suite), so the cheapest failures show up first.

The commands below run the individual pieces, so you can run the check that matches the files you
changed:

```bash
# frontend production build
cd frontend
npm run build
```

```bash
# backend test suite: wraps pytest using backend/venv
scripts/run_tests.sh                                            # everything
scripts/run_tests.sh backend.tests.test_suspect_duplicates      # one module
scripts/run_tests.sh backend.tests.test_suspect_duplicates.SuspectDuplicateTests   # one class
scripts/run_tests.sh -v                                         # name every test as it runs
```

If a new dependency has been added, run `start_backend.sh` once first to refresh the venv.

The runner and CI both use **pytest** on purpose, because the two runners collect different tests.
`unittest` only finds `TestCase` classes, and several modules are written as plain `def test_`
functions, so running the suite locally under `unittest` silently skipped tests that CI ran. You can
write either style; pytest collects both.

Tests use isolated SQLite files under `tempfile.TemporaryDirectory()`, so they never touch the live
databases and are safe to run while the backend is up. **Both** databases have to be redirected, not
just the ledger. Anything built for a `Request` can reach the control database, and the two paths are
set separately: `set_current_db_path` for the data database, and the
`control_database.CONTROL_DB_PATH` module attribute for the control database.
`backend/tests/_api_client.py` does both and is the pattern to copy.

**Attached documents** need the same isolation but are found differently. They live in a `documents/`
directory beside the data database, located through `current_db_path()` rather than through the
connection a test holds. So passing a path to `get_db` isn't enough on its own. Without
`set_current_db_path`, a test reads its own temporary ledger while writing files into the developer's
real document store. It looks isolated, but it isn't.

The isolation is enforced. `backend/tests/conftest.py` refuses to open a *configured* database path or
the configured document store, and the error says how to fix the test. This matters because a test
that skips isolation doesn't fail on a machine where those files exist. It silently reads the
developer's own data, and only a clean checkout would turn that into a visible failure.

For larger backend changes, also start the app and try the affected flow by hand.

### Frontend unit tests

`vitest` is the fast suite. Run it after any frontend change:

```bash
cd frontend
npm test                 # the whole suite
npm test -- Backup       # files matching a name
```

It runs in Node, so it needs no browser and no running app. Pure helpers in `src/lib` need no DOM; a
test that does need one opts in with a `// @vitest-environment jsdom` directive at the top of the file.
Tests live in a `__tests__/` folder beside the code they cover.

### UI checks

Playwright runs the end-to-end tests, driving real browsers against a running app. From `frontend/`:

```bash
cd frontend
npm run ui:test
npm run ui:test:a11y
npm run ui:test:all
npm run ui:test -- --headed
npm run ui:codegen
```

`npm run ui:test` is the routine UI regression run and skips the opt-in browser accessibility audits.
Run `npm run ui:test:a11y` for the focused form-label and id sweep, or `npm run ui:test:all` to run
both. `npm run ui:stress` runs the suite with ten sessions instead of three and reports how the server
held up; `docs/scale-and-limits.md` → *Many sessions on one server* says when to run it and how to read
the results.

The Playwright config uses its own ports (frontend 5199, backend 8099) and runs against an isolated
backend with throwaway databases, so a local `.env` doesn't affect it. To point a single run at a
different URL, set `PLAYWRIGHT_BASE_URL`.

**The suite signs in once, in `tests/globalSetup.js`, and every spec reuses that session.** A fresh
stack has no identities, and almost every endpoint returns 401 without one, including the demo-data
load, which is scoped to the current identity. So the setup lists identities, creates one if there are
none, selects it, and then loads the demo data. Selecting is the step that starts the session; creating
doesn't. The resulting cookie is saved to `tests/.auth/state.json`, and both configs point
`use.storageState` at it.

If you write a new spec, know this: **the `request` fixture is a separate context from the browser.**
Without the shared state, its API calls are unauthenticated even though clicks in the same test work.
That failure is hard to spot. A helper that ignores a bad response leaves the API work undone, and the
spec fails much later, somewhere else, waiting for UI that never appears.

**The suite runs in phases, set by the `projects` list in `playwright.config.js`**, and the comment
there explains why. `app` runs first and holds every spec that reads the demo ledger. `rule-review`
runs next, alone, and reloads the demo before each of its tests. A setup spec then clears the demo
data, and the phases after it need that empty tenant and run one at a time. The npm
scripts pick phases with `--project`; `package.json` shows which ones the routine `ui:test` runs.

Put a new spec in `app` unless it needs an empty tenant. If it does, give it its own project at the end
of the chain, or add it to a phase whose specs it can't disturb. Specs within a phase still run in
parallel, so a spec that reads the demo data should leave it as it found it, and a spec that has to
change it should restore it afterwards (see `categorize.spec.js`). A spec whose changes are too broad
to put back goes in a phase of its own before the clear and reloads the demo instead (see
`rule-suggestions-actions.spec.js`).

## What is tested, what isn't, and why

The section above covers how to *run* the suites. This one covers what each suite tests and where the
open gaps are listed.

### The four lanes, and the line that matters

| Lane | Runs in | Launches the app? | In CI |
| --- | --- | --- | --- |
| **pytest** (`scripts/run_tests.sh`) | Python, isolated temp SQLite | no | yes |
| **vitest** (`npm test`) | Node, with per-file jsdom opt-in | no | yes |
| **Playwright** (`npm run ui:test*`) | headless browsers, on an isolated throwaway stack | **yes** | yes |
| **Smoke** (`npm run ui:smoke`) | a headless browser, on the **built** app | **yes** | no (see below) |

Locally, `scripts/check_backend_and_frontend.sh` runs the first three. CI runs the same three on every
push and pull request through `.github/workflows/ci.yml`. The release workflow *calls* that workflow
rather than repeating it, so a release is held to the same checks as an ordinary push. None of the
three is optional, because a suite that has to be remembered separately stops being run and then stops
being maintained. The smoke lane is the one deliberate exception, for the reason given under *The smoke
lane* below.

**A headless Playwright run is a test runner**, not a browser session. It starts its own stack on its
own ports, touches no real data, and reports a structured result. **Run the unit suites too.** If you
skip vitest after a frontend change, nothing but lint and a build stands between the change and users.
Where no suite can judge a result, such as how a screen looks, a person checking it once is a valid
test.

### The smoke lane, and the gap it closes

The first three lanes share a blind spot: **none of them loads the bundle a user gets.** vitest runs
modules through its own transform, the Playwright suite drives the *dev* server, and
`scripts/smoke_artifact.py` only starts the packaged app far enough to check its health endpoint. So a
change to how the app is *built*, such as a bundler upgrade, a chunking rule, or a `define` that stops
being replaced, can leave every screen blank while all of them pass.

`npm run ui:smoke` (`playwright.smoke.config.js`) runs `vite build`, serves the result with
`vite preview`, and checks only that each route loads and draws: the nav marks the current page, a
heading appears, and there is no console error, failed request or error boundary. It is shallow on
purpose. Behavior is tested by the suites above, and a rarely-run suite that fails for its own reasons
gets ignored, which is worse than not having one.

**Run it when a build or runtime dependency changes, and before cutting a release.** It stays out of
CI even though the rest of the Playwright suite runs there. The bundle only changes when the build
does, so running it on every push would keep answering a question nothing has changed.

**Match the check to the change.** A comment or documentation edit needs lint (which includes the
comment checks for both the frontend and the backend) and, for a Python file, a syntax check. A full
suite run can't catch anything such an edit could break.

### Where the open gaps are listed

`docs/backlog/test-coverage-gaps.md` is a **running checklist** of tests that are wanted but not yet
written: HTTP-contract tests to back up direct-call unit tests, the rule-collision UI flows, component
coverage for the shared interactive parts of the UI, and a check that fresh and migrated databases
get the same schema. Delete an entry when its test lands. `docs/backlog/refactor-audits.md` holds the
audit's standing list of candidates.

## Hooks and lint

Running `npm install` in `frontend/` installs the repo's pre-commit hook through the frontend
`postinstall` script. The installer skips the hook outside a git checkout, leaves a `pre-commit` hook
it didn't write in place, and honors `core.hooksPath`. An install run with `--ignore-scripts` leaves no
hook, so to install or refresh it by hand, run:

```bash
./scripts/install-hooks.sh
```

The hook checks only staged files. It doesn't run the build, the test suites or ruff:

- every staged file runs the personal-data guard and the ASCII guard
- staged `frontend/*` files run the frontend comment check
- staged `backend/*.py` files run the backend comment check and the timestamp guard
- a staged document (`docs/*.md`, `README.md`, `CONTRIBUTING.md`) runs the contents guard

`npm run lint` in `frontend/` runs all of these over the whole tree, plus eslint and ruff. CI runs it
too. ruff is an optional dev dependency; install it into the venv with
`pip install -r backend/requirements-dev.txt`.

```bash
cd frontend
npm run lint
```

Each check's header comment explains its design. What you need to know to work with them:

### The contents guard

`scripts/check-doc-contents.js` keeps the `## Contents` list in any document that has one, and
`docs/README.md` (the index of every document in `docs/`), in step with the headings. Renaming, adding
or removing a `##` heading makes the check fail until you regenerate them:

```bash
node scripts/check-doc-contents.js --write
```

To give a document a contents list, add a `## Contents` heading and the script fills it in. Never edit
`docs/README.md` by hand.

### The timestamp guard

Stored timestamps are naive UTC and must come from `utcnow_iso()` in `backend/time_utils.py`. The
guard blocks `datetime.utcnow()` and `datetime.now()` with no arguments, which returns *local* time.

A value that really is local time, such as a download filename the user reads as a date or a ZIP
entry's date field, takes a per-line exemption with a reason:

```python
stamp = datetime.now()  # local-time: ZIP entry dates are MS-DOS fields with no timezone
```

The exemption applies to its own line only, and only to `datetime.now()`. Nothing exempts
`datetime.utcnow()`.

### The personal-data guard

`scripts/check-personal-data.js` keeps the real account names, institutions and card last-4s of
whoever runs the repo out of tracked files. Its list of terms lives in `data/personal-data-terms.txt`,
which is gitignored, since a committed list would itself be the leak. With no list the check passes;
with an empty list it fails.

Build or refresh the list from a database you name explicitly:

```bash
python3 scripts/refresh-personal-data-terms.py <path-to-the-real-database>
python3 scripts/refresh-personal-data-terms.py --dry-run <path>   # print, write nothing
```

New terms are merged into the list, so entries you add by hand survive a refresh. Single words from
account names are written as commented-out `# candidate:` lines; delete the prefix on the ones that
really identify you.

When the guard fires, replace the value with a made-up one. `docs/collaboration-notes.md` lists the
names to use, and the repo already uses Fablecard, Harborline, Riverstone and Northgate with invented
masks. `data/personal-data-allow.txt` (also untracked) takes path prefixes for a known leftover.

### The ASCII guard

`scripts/check_shipped_ascii.py` rejects any character above U+007F in string literals in the files
whose text ends up in a terminal: `scripts/build_desktop.py`, which writes the `README.txt` in every
downloadable kit, and `backend/desktop.py`, whose messages print on every launch. A Windows console
shows UTF-8 punctuation such as an em dash as garbled characters. Rewrite with a hyphen, a semicolon,
parentheses, or a new sentence. Comments and docstrings are exempt, and so is the frontend.

## Project conventions

### Backend

- **Routers:** `backend/routers/`
- **Database setup and migrations:** `backend/db/database.py`
- **Schema changes:** write them as migrations, not ad hoc SQL edits
- **Database style:** SQLite is the source of truth; prefer simple, explicit SQL over abstraction
  layers

### Frontend

- **Shared transaction display and editing:** `frontend/src/components/TransactionRow.jsx`
- **Shared detail-panel behavior:** `frontend/src/components/detailShared.jsx`
- **Shared transient interaction behavior:** `frontend/src/lib/uiInteractions.js` and
  `frontend/src/components/TransientTextInput.jsx`
- **Components:** reuse shared components rather than creating page-specific copies
- **Optimistic UI:** fine when it keeps the interface responsive and a failure is low-risk

## Important product invariants

- **Amount sign convention:** positive = money out, negative = money in
- **Category depth:** groups at the top, leaf categories underneath
- **Transaction categorization:** assign transactions to leaf categories, not groups
- **Rule specificity:** more specific rules override more general ones without manual priority
  ordering
- **`exclude_from_totals`:** removes a group and its descendants from summaries and charts

See [docs/data-model.md](docs/data-model.md) and [docs/architecture.md](docs/architecture.md) for more
detail.

## Documentation expectations

Update the docs when a change affects:

- how the app is started or configured
- how a major feature behaves
- core data-model assumptions
- contributor workflow or extension points

As a rule of thumb:

- `README.md` explains what the app does and how to run it
- `CHANGELOG.md` records meaningful user-visible changes
- `docs/` files explain structure, architecture, and internal conventions
