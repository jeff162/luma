# Contributing

This guide records the main conventions contributors should follow when
changing the application.

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
- Preserve existing product conventions unless there is a deliberate reason to change them
- Update user-facing docs when behavior changes in a meaningful way

## Local development

For the shortest local startup path, use the launcher scripts documented in
[README.md](README.md).

**Toolchain:** **Python 3.12 or 3.13**, and **Node.js 20 or newer**. The Python range has a ceiling as
well as a floor — `backend/pyproject.toml` declares `requires-python = ">=3.12,<3.14"`, because the
pinned `pydantic-core` publishes no wheels for 3.14 and a 3.14 environment falls back to compiling it
from source, failing somewhere that says nothing about the real cause. [README.md](README.md) carries
the fuller note, including why this does not apply to the packaged downloads.

The venv belongs at `backend/venv/` — that is where every script in `scripts/` looks for it.

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

`npm install` reports advisories against the build and test tooling — vite, vitest, esbuild and
eslint's dependencies. These are devDependencies and none of them reaches a user: the product is a
static bundle served by the backend, so the dev server and the test runner those advisories concern
exist only on a developer machine. The runtime dependencies are the six in `dependencies`, and those
are the ones an advisory has to be acted on for.

No `.env` file is required — a checkout runs on defaults (backend 8000, frontend 5173, databases in the working directory). A
repo-root `.env` is the override mechanism, and is useful for running against different databases (test v. prod) or different instances running on the same box:
`BACKEND_PORT` and `FRONTEND_PORT` are read by the launcher scripts and by `vite.config.js`,
and `DATA_DIR` specifies the database location. A hand-run `uvicorn`
does not read `.env` for its port, so pass the same value `.env` sets or the frontend will call a
backend that is not there. **Settings → Configuration** lists every effective value and its current source. Most settings can be set via
a `.env` file, see `.env_example`.

For building test scrpits, the `LUMA_ENV_FILE` environment variable (not a `.env` file setting as it points at the `.env` file to use). It redirects **the backend
only** — `start_luma.sh`, `start_backend.sh`, and `vite.config.js` each read the repo-root `.env` directly
for their ports — so it is the right tool for pointing a backend at a throwaway database for testing. `scripts/run-e2e-backend.sh` uses this. It is not of much interest to users starting the application.

Shell examples and local tooling should stay WSL-friendly where practical.

### Working with an AI assistant

The repo carries its own agent instructions, and they are worth pointing an assistant at explicitly
before it starts editing — most of the avoidable rework on this project has come from an agent
reconstructing the design from source instead of reading the file that already explains it or an agent discovered it didn't follow the
instructions and it introduced a bug or other technical debt that needs to get resolve later.

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
# backend test suite — wraps pytest using backend/venv
scripts/run_tests.sh                                            # everything
scripts/run_tests.sh backend.tests.test_suspect_duplicates      # one module
scripts/run_tests.sh backend.tests.test_suspect_duplicates.SuspectDuplicateTests   # one class
scripts/run_tests.sh -v                                         # name every test as it runs
```

The runner and CI both use **pytest**, deliberately: they collect different sets otherwise. `unittest`
finds `TestCase` classes only, while several modules are written as plain `def test_` functions, so
running the suite locally under `unittest` silently skipped what CI would run. Write either style —
pytest collects both.

Tests use isolated SQLite files under `tempfile.TemporaryDirectory()`, so they never touch the live
databases and are safe to run with the backend still up. **Both** databases have to be repointed, not
just the ledger: anything built for a `Request` can reach the control DB, and the two paths are set
separately — `set_current_db_path` for the data DB, the `control_database.CONTROL_DB_PATH` module
attribute for the control one. `backend/tests/_api_client.py` does both and is the pattern to copy.

Isolation is enforced rather than assumed. `backend/tests/conftest.py` refuses any open of a
*configured* database path and names the fix in the error, because a test that skips the isolation
does not fail on a machine where those databases exist — it silently reads the developer's own data,
and only a clean checkout turns that into a visible failure. If a new dependency lands, re-run
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

## What is tested, what isn't, and why

The section above is how to *run* the suites. This is what they cover, what they structurally cannot,
and which gaps are open on purpose.

### The three lanes, and the line that matters

| Lane | Runs in | Needs the app? |
| --- | --- | --- |
| **pytest** (`scripts/run_tests.sh`) | Python, isolated temp SQLite | no |
| **vitest** (`npm test`) | Node, with per-file jsdom opt-in | no |
| **Playwright** (`npm run ui:test*`) | real browsers, driving a running app | **yes** |

**The line falls between the first two and the third**, and it is worth stating plainly because
"frontend tests" sounds like it should sit on the far side of it. **vitest is a unit runner** — no
browser engine, no app, nothing rendered to a screen — so it belongs with pytest. Playwright is the
only lane that launches anything.

That line is load-bearing for **agent contributors**, who must not launch the app or run the
browser-driven suite to check their own work (see `AGENTS.md` / `CLAUDE.md`, which state it as a hard
rule). The corollary is the half that gets forgotten: **the unit lanes are expected**, and skipping
vitest after a frontend change ships it behind nothing but lint and a build. The `test:` block in
`frontend/vite.config.js` draws the same line in the config itself.

**Match the check to the change.** A comment or documentation edit needs lint (which includes the
comment-quality checks for both halves of the repo) and, for a touched Python file, a syntax check —
not a full suite run that cannot observe anything the edit could have altered.

### What a unit runner structurally cannot reach

These are not gaps to close. They are the reason some defects can only be found another way, and
knowing which is which stops a green suite being read as more assurance than it is:

- **A chart cannot be rendered under it.** jsdom performs no layout, so anything whose correctness is
  geometric — an axis aligned to a plot, a diverging bar's stacking, a label that must clear a tick —
  produces no measurable output. Two of the worst chart defects in this repo's history had *every
  tooltip figure correct throughout*, which is exactly why they survived to first use.
- **A virtualized list renders nothing without stubbed geometry.** The existing harness stubs the
  resize observer and the size properties, keyed off each row's index — keyed specifically so a row
  never reports the *viewport's* height, which would make one row appear to fill the screen and silently
  defeat every assertion.
- **An adapter's transport needs a test that inspects the wire.** Asserting on a normalized return value
  proves the mapping, not the request: a window cap, a sign convention, a pacing rule and a budget are
  all properties of what was *sent*. See `building-a-connector.md`.
- **Console warnings are only visible in a browser**, which makes a quiet console a testing asset
  rather than tidiness. The point is **signal preservation**: once the baseline is clean, a *new* real
  error stands out instead of being lost in known noise. React warnings usually flag a real latent bug
  and are worth prioritizing; one-off third-party and extension noise is not.
- **How a component sits in the live tree** is not observable in isolation. The pattern is established
  enough to plan around: a first pass against the real app has repeatedly found several defects in an
  hour, every one of them about placement or wiring rather than logic. Treat that pass as blocking work
  rather than a formality, and hand it to the person who can run the app.

### Migration and fresh-schema parity — currently unguarded

A database's schema comes into existence **two ways that share no code**. A fresh install runs
`init_db`'s `CREATE TABLE` script and is stamped straight to `CURRENT_VERSION`, skipping migrations
entirely. An existing file is advanced in place by `run_migrations`. So every schema change lives in two
places that must be kept in lockstep by hand — the canonical create block *and* the migration that
introduces or alters it.

**Nothing asserts that the two paths converge**, so they can drift silently: add a column to the create
block and forget the migration, or the reverse, and brand-new versus upgraded databases end up with
different schemas — a bug only users with older files ever hit.

This was written down as dormant, to be built alongside the *first* post-rebrand migration rather than
after a drift bug. **That precondition passed a long time ago** — the baseline is well past v1 with
dozens of registered migrations — and the guard still does not exist. It is the most consequential open
gap in this section.

The shape it wants: build the schema both ways into two temp databases and diff the *structure* —
column names, types, nullability and defaults; foreign keys; indexes — via `PRAGMA`, never by diffing
`sqlite_master.sql` text, which is too brittle (whitespace, `IF NOT EXISTS`, column order). Compare the
*table sets* first, so "new table added to only one path" trips before the per-table diff. Ignore
version rows and seeded data, which differ legitimately.

### Lint posture: enable, measure, triage, then gate

The rule sets are **narrow by design**; strictness is added only where it earns its keep. The procedure
is the same for either half of the repo:

1. Enable one candidate rule as a **warning**.
2. Run it and read the count and locations *before* deciding anything.
3. Fix the genuine, cheap hits. For false positives, prefer tuning the rule's options over restructuring
   correct code.
4. Promote to **error** only once the existing hits are cleared, so it becomes a real regression gate.
   Leave a noisy or low-value rule **off**, with a one-line comment saying why.

**Count before conviction.** A rule reporting ~89 hits against placeholder-only inputs was measured
against what a browser actually does — a placeholder *is* the accessible name there, so the real defect
count was about one. Chasing the raw number would have been most of a day for nothing. Conversely a
browser-console check that no linter enforces is not a rule at all, and deciding to ignore it is a
legitimate outcome to record rather than a task to carry.

### Auditing for duplication

A periodic pass looks for **shotgun surgery** (one logical change forcing edits in many places) and
**divergent duplication** (the same shape copy-pasted). Two lenses, and only one works here:

- **Structural** — a copy-paste detector over each half of the tree, plus a structural search to
  enumerate a fan-out and confirm a refactor's blast radius. This is the primary tool.
- **Historical co-change** — *not useful in this repo*, because commits are batched, so "changed
  together" is noise. Revisit only if commit granularity tightens.

Then a reading pass, ranking candidates by frequency × safety, and applying two caveats that decide
most cases: the **rule of three** — do not centralize two copies that may still diverge — and
**divergence risk**, since a forced abstraction that leaks is worse than the duplication it replaced.
The output is "do it / leave it", not raw hits. A deliberate *leave* is a result worth recording.

### Where the open gaps are listed

`docs/backlog/test-coverage-gaps.md` is a **running checklist** of tests that are wanted and not yet
built — HTTP-contract tests behind direct-call unit tests, the rule-collision UI flows, component
coverage for the shared interactive surfaces, and the parity guard above. Delete an entry when its test
lands. `docs/backlog/lint-and-tooling.md` holds the two deferred linter projects, and
`docs/backlog/refactor-audits.md` carries the audit's standing candidate list.

## Hooks and lint

Running `npm install` in `frontend/` installs the repo pre-commit hook via the
frontend `postinstall` script.

Because that runs unattended on a machine whose owner did not ask for it, it declines rather than
insists: no git working directory means it skips and says so instead of failing the install, a
`pre-commit` hook it did not write is left in place with the manual command printed, and
`core.hooksPath` is honored when set. An install run with `--ignore-scripts` therefore leaves no hook
at all — run the script by hand if the checks are wanted.

If you need to install or refresh the hook manually, run:

```bash
./scripts/install-hooks.sh
```

That hook does not run the full frontend build or Playwright suite. It checks
only staged files:

- **every** staged file runs `scripts/check-personal-data.js` — a real account name or card
  last-4 leaks the same from a doc or a fixture as from source, so this one is not scoped by
  path
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

### The personal-data guard

`scripts/check-personal-data.js` keeps real account names, institutions and card last-4s belonging
to whoever runs the repo out of tracked files — the rule in `docs/collaboration-notes.md` (what to
keep out of UI copy, comments and fixtures), made enforceable rather than remembered.

**Its term list is deliberately not in the repository.** A committed denylist would *be* the
disclosure: one labelled, greppable place naming every bank and last-4 it exists to protect. The
list therefore lives in `data/personal-data-terms.txt` (gitignored), and the script is the only
public half. Three behaviours follow, and the middle one is the point:

- **No list** → the check prints a notice and passes. That is correct on any clone that is not the
  data owner's, and in CI.
- **An empty list** → the check **fails**. An empty list passes everything, so silence there would be
  indistinguishable from a clean run.
- Every run prints the term count, so "checked nothing" is a visible line rather than a clean exit.

Build or refresh the list from a database you **name explicitly**:

```bash
python3 scripts/refresh-personal-data-terms.py <path-to-the-real-database>
python3 scripts/refresh-personal-data-terms.py --dry-run <path>   # print, write nothing
```

The path is an argument and never discovered from configuration. Reading whatever `.env` currently
points at is the failure this design exists to avoid: with a test database configured, the refresh
would harvest fabricated names, the guard would match nothing, and the whole chain would report
success while checking for the wrong strings.

Terms are merged, never replaced, so an entry added by hand after a leak is found in practice
survives every later refresh. Only card last-4s and multi-word names are added outright — both are
specific enough that a match is a real finding. Bare words out of account names are written as
commented-out `# candidate:` lines to accept by hand, because the words in real account names
include ones this repo uses legitimately ("Bridge" is SimpleFIN's own term), and a noisy guard is
one that gets switched off. Declining a suggestion is remembered.

When the guard fires, replace with fabricated values: `docs/collaboration-notes.md` names the
vocabulary, and the repo already uses Fablecard / Harborline / Riverstone / Northgate with invented
masks. `data/personal-data-allow.txt` (also untracked) takes path prefixes for a known leftover.

You can run the same combined checks manually from `frontend/` — `npm run lint` is eslint plus both
comment checks, the timestamp guard and the personal-data guard:

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
