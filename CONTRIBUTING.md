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

**Toolchain:** **Python 3.12 or newer**, and **Node.js 22.12 or newer**. The packaged downloads are
built on 3.12, and CI runs the backend suite on 3.14 as well.

The venv belongs at `backend/venv/` — that is where the scripts in `scripts/` expect it.

```bash
# backend
cd backend
python3.12 -m venv venv       # or `py -3.12 -m venv venv` on Windows
venv\Scripts\activate         # Windows
source venv/bin/activate      # Unix-like shells
pip install -r requirements.txt
```

Start frontend and backend:

```bash
bash ./scripts/start_luma.sh                                        # macOS / Linux / WSL
scripts\start_luma.bat                                              # Windows
powershell -ExecutionPolicy Bypass -File .\scripts\start_luma.ps1   # Windows PowerShell
```

Or individually:

```bash
# backend — from the REPO ROOT, not from backend/, since the app is imported as backend.main
uvicorn backend.main:app --reload --reload-dir backend --port 8011

# frontend
cd frontend
npm install
npm run dev
```

When `npm install` reports advisories, determine whether they are build/test related or affect code the user sees. `devDependencies` contains vite, vitest, eslint and their trees. These are the build and testing tools. The six packages in `dependencies` are the ones that reach the user's browser, and an advisory there should be resolved. 

Configuration is via the `.env` file. This is only needed to change one of the defaults, many of which are useful in a development environment. env_example.txt describes the various settings.

The `LUMA_ENV_FILE` environment variable is useful for building test script. This is not a `.env` file setting as it points at the `.env` file to use. This redirects the database for the **the backend
only**. `scripts/run-e2e-backend.sh` uses this  `start_luma.sh`, `start_backend.sh`, and `vite.config.js` each read the repo-root `.env` directly
so they do not see this. 

Shell examples and local tooling should stay WSL-friendly where practical.

### Working with an AI assistant

The repo carries its own agent instructions, and they may worth pointing an assistant at explicitly
before it starts editing. The agents do not always follow the guidelines but for the most part they help.

A reasonable opening instruction:

> Check `CLAUDE.md`, your memory, and the relevant `docs/` before diving in.

**Give that instruction even though the files are meant to be automatic.** Claude Code loads
`CLAUDE.md` into context on its own and still benefits from being told to act on it — an instruction
that arrives as ambient background gets treated as background. Naming the files in the prompt may provide a bit of emphasis.

- **[CLAUDE.md](CLAUDE.md)** is the one Claude Code picks up automatically. It carries the hard rule
  and a routing index into `docs/`.
- **[AGENTS.md](AGENTS.md)** is the same guidance in the tool-agnostic open-standard file, for
  assistants that read it. Claude Code does **not** load it automatically, so name whichever your
  assistant actually reads — the two are written to agree, and each points at the other.
- **Your assistant's memory** is worth naming even though it is empty on a first clone. It accumulates
  the things a repo cannot record — what was tried and rejected, and how a particular contributor
  prefers to work — and once there is anything in it, an assistant that was never told to consult it
  will not.
- **`docs/`** attempts to capture the *why*. [docs/collaboration-notes.md](docs/collaboration-notes.md) covers
  decision principles, and [docs/agent-profile.md](docs/agent-profile.md) is 
  the operational footguns that recur across sessions. These live in the repo rather than in any one
  developer's assistant memory, so every contributor and every agent starts from the same guidance (these are
  more of an attempt to get quality work from the agents).

The rule most likely to be getting violated when work goes wrong: **read the relevant doc before
changing — or answering questions about — shared systems, persistence, invariants, or shared UI.**
"I'm only investigating" is not an exemption.

### Developer flag

Set it in `.env` (or the shell) to expose Developer options on the main Settings page and add a toggle to add the database path to the navigation panel.

```bash
LUMA_DEVELOPER_OPTIONS=true
```

### Running as a single process

The two-window setup above is the development arrangement. The application can also run as one process
that serves both halves and opens a browser at itself — the same shape the packaged downloads use:

```bash
cd frontend && npm run build && cd ..
backend/venv/bin/python -m backend.desktop    # Windows: backend\venv\Scripts\python -m backend.desktop
```

The backend listens on loopback only by default (override with .env BACKEND_ADDR setting) and stops with Ctrl+C. Launching it again while it is already running opens
a new tab against the existing instance rather than starting a second one. The frontend only needs
rebuilding when it changes. 

By default a browser is launched at startup. The `--no-browser` flag skips this which is useful if starting with no browser available.

**This serves `frontend/dist`, which is a copy of the source tree** Use `npm run build` to rebuild the dist directory from the source tree.

### Running in Docker

`docker-compose.yml` runs the server arrangement in containers: the application in server mode, with a
Caddy proxy in front of it for HTTPS. From the top of a checkout, on a Linux host:

```bash
docker compose up -d --build     # build the image from this checkout and start it
docker compose logs app          # the address other computers open
docker compose down              # stop it
```

`--build` is what makes it run this checkout. Without it the published image for the latest release is
pulled instead. The image builds its own interface from the source, so `frontend/dist` plays no part.
The databases land in `./data`, owned by root, and an optional `.env` at the top of the checkout is
honored. It needs a Linux host: under Docker Desktop the containers' network is a virtual machine's, so
neither the advertised name nor other computers reach it. `docs/operations.md` → *Containers* has the
rest.

## Useful checks

The whole local test suite is one command:

```bash
scripts/check_backend_and_frontend.sh        # backend suite + frontend lint + vitest + browser suite
scripts/check_backend_and_frontend.sh lint   # frontend lint only — seconds, no browser
```

`lint` only is available for a tight edit loop.

`npm run check` inside `frontend/` is the frontend half of the suites (lint → vitest → browser
suite), in cheapest-failure-first order.

Everything below is the individual pieces, for running the check that matches the changed files:

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

A third store follows the same rule and is reached differently: **attached documents** live in a
`documents/` directory beside the data database, found through `current_db_path()` rather than through
whichever connection a test is holding. Passing a path to `get_db` is therefore not enough on its own —
without `set_current_db_path` a test reads its own temp ledger while writing files into the developer's
real document store, which looks isolated and is not.

Isolation is enforced rather than assumed. `backend/tests/conftest.py` refuses any open of a
*configured* database path or the configured document store, and names the fix in the error, because a
test that skips the isolation does not fail on a machine where those exist — it silently reads the
developer's own data, and only a clean checkout turns that into a visible failure. If a new dependency lands, re-run
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
together. `npm run ui:stress` runs the lane with ten sessions instead of three
and reports how the server held up; `docs/scale-and-limits.md` → *Many sessions
on one server* says when to run it and how to read it.

The Playwright config pins its own ports (frontend 5199, backend 8099) and
runs against an isolated backend with throwaway databases, so it is unaffected
by a local `.env`. If needed, `PLAYWRIGHT_BASE_URL` can override the target URL
explicitly for one run.

**The suite signs in once, in `tests/globalSetup.js`, and every spec inherits that session.** A
pristine stack has no identities, and almost every endpoint answers 401 without one — including the
demo-data load, which is scoped to the current identity. So the setup lists identities, creates one if
the stack is empty, selects it (this is the step that establishes the session; creating does not), then
seeds. The resulting cookie is written to `tests/.auth/state.json` and both configs point
`use.storageState` at it.

That last part is what a new spec needs to know: **the `request` fixture is a different context from
the browser**, and without the shared state its API calls are unauthenticated while clicks in the same
test are fine. The failure is quiet in the worst way — a helper that ignores a bad response leaves the
API work undone, and the spec fails much later, somewhere else, waiting for UI that never arrives.

**The run is ordered phases, not one flat pass, and the lanes are projects rather than `--grep`.**
One spec in the a11y sweep clears the demo data so it can drive the import screen with the drop zone
enabled; that wipe is harmless alone and fatal beside the dozen specs that read the demo ledger. The
two therefore have to be *ordered*, not merely told apart — and a command-line filter cannot do the
telling, because Playwright does not apply `--grep` to a dependency project, so a lane excluded on
the command line runs anyway as somebody's dependency. The `projects` list in `playwright.config.js`
sequences it instead, and is the record of the phases and their order.

`app` comes first and holds everything that reads the demo ledger. `demo-cleared` is one setup spec
that clears it once, at a point where nothing else is in flight. Every phase after it wants the empty
tenant that leaves behind, and runs as a single chain ending in `a11y`. The npm scripts select
projects with `--project`; which lanes the routine `ui:test` runs is in `package.json`.

The chain is deliberately a chain rather than a fan-out: **no two phases run at once.** The empty-tenant
phases clear or populate the same saved data sources and import batches, so run side by side they
delete each other's — and the resulting failure is a spec that passes alone and fails in company,
which is the expensive kind to diagnose.

A new spec belongs in `app` unless it needs an empty tenant; one that does gets its own project at the
end of the chain, or joins a phase whose specs it cannot disturb. Within a phase specs still run in
parallel, so anything reading the demo baseline should leave it as it found it, and anything that
must mutate should restore it (see `categorize.spec.js`).

## What is tested, what isn't, and why

The section above is how to *run* the suites. This is what they cover, what they structurally cannot,
and which gaps are open on purpose.

### The four lanes, and the line that matters

| Lane | Runs in | Launches the app? | In CI |
| --- | --- | --- | --- |
| **pytest** (`scripts/run_tests.sh`) | Python, isolated temp SQLite | no | yes |
| **vitest** (`npm test`) | Node, with per-file jsdom opt-in | no | yes |
| **Playwright** (`npm run ui:test*`) | headless browsers, on an isolated throwaway stack | **yes** | yes |
| **Smoke** (`npm run ui:smoke`) | a headless browser, on the **built** app | **yes** | no — see below |

The first three are run the same way and by the same command — `scripts/check_backend_and_frontend.sh`
— and again on every push and pull request by `.github/workflows/ci.yml`, which the release workflow
*calls* rather than restates, so a release is gated on the same definition an ordinary push is. Neither
side is opt-in, because a lane that has to be remembered separately stops being run and then stops
being maintained; the smoke lane is the deliberate exception, for the reason given under *The smoke
lane* below.

**A headless Playwright run is a test runner**, not a browser session: it boots its own stack on its
own ports, touches no real data, and reports a structured result. **The unit lanes are expected too** —
skipping vitest after a frontend change ships it behind nothing but lint and a build. Where no lane can
judge a result, such as how a screen looks, a person checking it once is a valid test.

### The smoke lane, and the gap it closes

The first three lanes share a blind spot: **none of them loads the bundle a user gets.** vitest runs
modules through its own transform, the Playwright suite drives the *dev* server, and
`scripts/smoke_artifact.py` launches the packaged artifact but only far enough to answer its health
endpoint. Between them, a change to how the app is *built* — a bundler upgrade, a chunking rule, a
`define` that stops being replaced — can blank every screen while all of them stay green.

`npm run ui:smoke` (`playwright.smoke.config.js`) runs `vite build` and serves the result through
`vite preview`, then asks only whether each route loads, routes and draws: the nav marks itself current,
a heading appears, and no console error, failed request or error boundary shows up. Deliberately
shallow — behaviour belongs in the lane above, and a rarely-run suite that fails for its own reasons
gets ignored, which is worse than not having one.

**Run it when a build or runtime dependency changes, and before cutting a release.** It stays out of
CI even though the rest of the Playwright suite now runs there: the bundle only changes when the build
does, so a run on every push re-answers a question nothing has re-asked.

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

### A known flaky failure, and the one thing to capture

**Any test driving the full-stack `api_client()` harness can intermittently fail with a `401` where a
success code is expected (first seen 2026-09-05, unresolved).** Observed so far in
`test_plaid_update_mode.py`, `test_vault_endpoints.py` and `test_credentials_backup.py` — the common
factor is the harness, not the feature under test, so a new sighting in a fourth file is the same bug
rather than a new one. It ran at roughly **one full-suite run in three** when first measured, once
taking six sibling tests down with it, and has since gone twenty-plus runs without appearing: do not
expect to summon it on demand, and do not read a green run as evidence it is gone.

**What is established.** The failure is a session that authenticated successfully and then stopped:
the harness asserts that its own `select-identity` call returned 200, so the session *was* established,
and the rejection observed in practice is **`no user_id on the session`** — the cookie reached the
middleware carrying no identity at all. Note the ordering trap that follows: the other two rejection
paths call `session.clear()`, so a `no user_id` line can be the *downstream* of an earlier rejection in
the same test. Read every `[auth] rejected` line in the failure, not just the last one.

**If it reappears, read the log line before re-running. That is the diagnosis.** The three rejection
paths in `TenantSessionMiddleware` deliberately return an identical body — which check refused a
request is not a caller's business — so the response itself says nothing. Each one logs its reason
instead, and pytest surfaces it under *Captured log call* even under `-n auto`.

A corollary worth taking seriously, because it has already cost time here: **do not pipe the suite into
`tail` or `grep`.** A run that fails intermittently is the only evidence that failure will ever produce,
and a pipe discards it before anyone can look — as does hitting *re-run* on a red CI job before opening
its log. Redirect to a file and filter the file:

```bash
./scripts/check_backend_and_frontend.sh backend > /tmp/run.log 2>&1; tail -5 /tmp/run.log
```

The line to look for:

```text
WARNING  uvicorn.error:app_logging.py:32 [auth] rejected /api/plaid/repair (with a session cookie): no user_id on the session
```

**Read the parenthesis first — it carries more than the reason does.** `SessionMiddleware` answers a
cookie whose signature does not verify with an empty session, which is indistinguishable from no cookie
at all by the time the request reaches this check, so *"no user_id"* alone spans two unrelated bugs. The
cookie flag splits them:

| log line | meaning |
| --- | --- |
| *without* a cookie · `no user_id` | the session was never established, or an earlier request cleared it (a clear also deletes the cookie) |
| *with* a cookie · `no user_id` | **the cookie failed signature verification** — this process is verifying with a different `session_secret` than the one that signed it |
| *with* a cookie · `passwordless session, but the perimeter is on` | something set `auth_enabled` in the control database this request read |
| *with* a cookie · `session user_id … is not in the control database` | the request read a **different** control database than the harness seeded — `CONTROL_DB_PATH` is a module global that both `api_client()` and `test_transport.py`'s `_isolated_stack()` repoint and restore, and that pattern only holds while no two are live at once in a process |

**If it is the signature-verification row, the prime suspect is process-wide state the harness cannot
repoint.**
`app_config.resolve()` runs once at *module import*, and its `session_secret` is passed to
`SessionMiddleware` as a constructor argument, so the signing key is fixed for the life of the worker
process — while `api_client()` hands every test a fresh temp control database, each with its own stored
secret. The first test to import `backend.main` in a worker therefore decides the key every later test's
cookies are signed and verified with. That is consistent as long as nothing re-resolves configuration
or re-adds the middleware, which is the assumption worth testing first.

Ruled out already, so nobody spends the afternoon twice: cross-file interleaving inside a worker
(`--dist loadfile` made it *more* frequent, not less), the conftest schema-template cache (`mkdtemp`,
so per-process), the suite reaching the real databases (conftest refuses the ambient paths outright),
and a transient locked-database read masquerading as a deleted user (`get_user_by_id` does not swallow
exceptions, so a busy database surfaces as a 500, not a 401).

It behaves as timing-sensitive rather than order-dependent — merely adding `-v` suppressed it. So do
not "fix" it by lowering the worker count: that moves a probability rather than a cause, which is a
lesson this repo has already paid for once.

### Where the open gaps are listed

`docs/backlog/test-coverage-gaps.md` is a **running checklist** of tests that are wanted and not yet
built — HTTP-contract tests behind direct-call unit tests, the rule-collision UI flows, component
coverage for the shared interactive surfaces, and the parity guard above. Delete an entry when its test
lands. `docs/backlog/lint-and-tooling.md` holds the remaining vitest-matcher item (both linter projects
landed 2026-09-05), and `docs/backlog/refactor-audits.md` carries the audit's standing candidate list.

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
- **every** staged file also runs `scripts/check_shipped_ascii.py` (through
  `scripts/run_shipped_ascii_check.js`), which filters to the files it watches — see the ASCII
  guard below
- staged `frontend/*` files run `frontend/scripts/check-comments.js`
- staged `backend/*.py` files run `backend/scripts/check_comments.py` (through
  `scripts/run_backend_comment_check.js`, which finds the right Python on each
  platform), then `scripts/check-backend-timestamps.js`
- a staged document (`docs/*.md`, `README.md`, `CONTRIBUTING.md`) runs
  `scripts/check-doc-contents.js` — see the contents guard below

Both Python-backed checks reach their interpreter through `scripts/python-runner.js`, which is where
the `python3` / `python` / `py -3` fallback order lives. Getting that order wrong fails silently — the
check looks like it passed — which is why it is in one place rather than copied per caller.

**ruff is the one backend check the hook does not run.** It is wired into `npm run lint` (so it gates
CI and any manual run) rather than into the staged-file hook, for two reasons: it is the only check
with an install prerequisite — an optional dev dependency, where every other check needs nothing a
checkout does not already have — and it is whole-tree rather than per-file, which is the wrong shape
for a hook that exists to be fast on a handful of staged paths. It reaches its executable through
`scripts/run_ruff.js`, which is separate from `python-runner.js` because ruff is a binary rather than a
`.py` file, and because `python -m ruff` exits 1 both for "found lint errors" and for "no such module" —
so each candidate is probed with `--version` before it is trusted, rather than the fallback chain
reading a real failure as a missing interpreter.

### The contents guard

`scripts/check-doc-contents.js` keeps two generated things in step with the headings they are built
from: the `## Contents` list in any document that has one, and `docs/README.md`, the index of every
document in `docs/` and its sections. Renaming, adding or removing a `##` heading makes the check fail
until they are regenerated:

```bash
node scripts/check-doc-contents.js --write
```

A document opts in to a contents list by having a `## Contents` heading; the script fills it in. A list
that is already correct is left exactly as written. `docs/README.md` is never edited by hand.

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

**ruff's `DTZ003`/`DTZ005` cover the same two calls, and both guards are kept on purpose.** The
overlap is not an oversight waiting to be tidied: this guard runs in the pre-commit hook with no
install prerequisite and understands the per-line `# local-time:` exemption above, while ruff runs
whole-tree in `npm run lint` and would need a `# noqa` for each of those legitimate cases. Retiring
this one would put a Python dependency into a hook that currently needs nothing, and trade a marker
that demands a reason for one that does not. The rest of the `DTZ` family is deliberately *not*
selected — 56 of its other hits are `date.today()`, and a local calendar date is usually the right
thing in a ledger.

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

### The ASCII guard

`scripts/check_shipped_ascii.py` refuses a character above U+007F in **string literals** in the files
whose text reaches a terminal: `scripts/build_desktop.py`, which writes the `README.txt` inside every
downloadable kit, and `backend/desktop.py`, whose messages print on every launch and land in
`luma-desktop.log`.

The reason is Windows. A console there decodes with the machine's OEM code page — CP437 or CP850 on
most installs — not UTF-8, so an em dash written as UTF-8 arrives as three bytes and renders as
`ΓÇö`. The reader chooses the code page, so nothing on this side can fix it; 7-bit ASCII is the
only range that renders the same under all of them. Rewrite with a hyphen, a semicolon, parentheses,
or a sentence break.

**Comments and docstrings are exempt** and never checked, because they do not leave the repository.
So an em dash in prose about the code is fine; one inside a string is not.

**The frontend is deliberately out of scope.** Its text is rendered by a browser, which knows the
document's encoding. The line is "text that reaches a terminal or ships as a file someone opens
outside a browser" — not a house style rule about punctuation, which is what this would become if the
watched list grew by habit. Adding a file means answering that question for it; the list in the script
records the answer beside each entry.

It exists as a check rather than a note because two files drifted into it independently, one of them
printing mojibake at every single startup for as long as it had been there.

You can run the same combined checks manually from `frontend/` — `npm run lint` is eslint plus both
comment checks, ruff, the timestamp guard, the personal-data guard and the ASCII guard:

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
