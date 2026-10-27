# Agent Profile

How to work on this repo: environment facts, tooling footguns and working habits that apply across
tasks. It is read at the start of every session, so each entry is one or two sentences — the rule and
the short reason for it. What the system is and why lives in the topic docs; project decision
principles live in `collaboration-notes.md`.

If a point here conflicts with `AGENTS.md`, `CLAUDE.md`, or the topic docs, follow the stricter
instruction and fix the drift.

## Collaboration Defaults

- The user handles commits and pushes, so leave changes in the working tree and do not ask about
  committing.

- A "why not X?" question scopes the work to X: answer it, propose the smallest change that addresses
  it, and offer a larger design as an option, because an unrequested investigation is a cost the user
  pays.

- Repeat any question for the user in the closing summary, because one buried mid-answer is easily
  missed and costs a round trip.

- When a reply removes a premise, re-derive what rested on it before editing anything. A question aimed
  at a whole section ("is this needed?") asks whether it should exist, and the test is what breaks if it
  is gone.

- Check a fact before writing it down, because a confident sentence in a doc or comment stops the next
  reader from checking: grep for an invariant or a rendered behaviour, and measure a quantity.

- When something will not work after a couple of attempts, stop and tell the user what was tried and
  what happened, so they can decide whether to fix something themselves, take the task over, or have the
  agent keep trying. Repeated failed attempts cost time and credits, and the user can often clear the
  block quickly.

- If a question implies an audit, do the whole audit before answering, because findings surfaced one per
  turn each cost the user a round trip.

- Before reporting a change done, re-read the sentence that asked for it and what the session already
  established, because the report is otherwise checked against a paraphrase.

## Investigation Strategy

- Open the thing before reasoning about it, because a name does not say what a component, a file or a
  caller actually does.

- `.env` is an optional override file and `DB_PATH` / `CONTROL_DB_PATH` / `DATA_DIR` often differ from
  the defaults, so check which database the app is pointed at before querying live state.

- Copy a live database with `sqlite3 <db> ".backup <copy>"`, not `cp`, because both databases run in
  WAL mode.

- Measure before blaming, and measure on a copy of real data, because the test fixtures (largest ~1,200
  rows) cannot show a cost that appears only at ledger scale. To sweep for one, trace the suite's SQL
  with `sqlite3.set_trace_callback` and run `EXPLAIN QUERY PLAN` on each statement against the copy.

- The user works in the app while a session is open, so figures from the live ledger are comparable
  only within a single run.

- To track down a bug, browser tools are there to be used. Start with the cheapest thing that can
  reproduce it (a service call, then a headless spec, then a step-by-step browser session), because each
  step of a driven session costs a call and a large result. Close any browser or dev server the session
  opened.

- Playwright's WebKit build is installed, so a bug reported in a browser you lack can be reproduced
  here; propose that in the first round and reproduce the exact click sequence before theorizing.
  After a Playwright upgrade, `npx playwright install webkit` fetches the new build. If its launch then
  names a missing system library, `apt-get download` that package and its dependencies, extract them
  with `dpkg-deb -x`, and copy the `.so` files into the build's `minibrowser-wpe/sys/lib`; no `sudo` is
  needed. Launch with `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1`.
- Playwright cannot produce a real finger drag in WebKit. Chromium can, through a CDP session's
  `Input.dispatchTouchEvent`, which is the way to check scroll-versus-drag behaviour; an iPad is the
  only full check for Safari's engine.
- An iPad scroll or keyboard bug in a fixed layer rarely shows on a desktop-sized page: a fixed layer
  hands leftover scroll to the document, which does not scroll there. Make the document scrollable to
  reproduce it, and simulate the keyboard by replacing `window.visualViewport` from a Playwright init
  script; Safari's own sliding of the page shows only on the device.

- The browser specs run against the demo ledger, which a script can build (temp database, `init_db`,
  `load_demo_data`, `scan_and_store`, then the service call the page makes), so a spec failure about
  data can be reproduced without a browser and without its timeouts.

- When a defect is found, grep for the other call sites and for other code with the same shape before
  closing it, because the reasoning that produced one instance usually produced others.

- Several surfaces are built to behave identically on purpose (`AccountMappingGrid` and the
  data-source editor's single-account picker; the CSV and connection dedupe paths), so a bug in one is
  checked in every sibling and fixed together.

- A correctness reading misses structural defects, so also ask of a diff: is everything between BEGIN
  and COMMIT part of what the transaction is for; is a durable state being used as an event; is a
  transient state (unlocked, connected, in flight) gating a durable judgement (who may approve, who
  should be told); does a predicate need an index it cannot use; is one judgement rendered in two places.

- Record a decision as the invariant that survived it ("the ingest transaction ends before analysis
  begins"), because a recorded rejection does not fire when someone later adds a step.

- Knowing how a symptom is produced is not knowing why the precondition held. Name the line that
  produces it and check the observed data meets that line's preconditions; with the cause unproven,
  prefer the fix that is correct either way, since one aimed at a guess cannot be validated.

- Use `git show HEAD:path` or `git diff HEAD -- path` to see the committed version, because the working
  tree routinely carries uncommitted work and git writes are denied.

- Tear down only the processes or ports launched for the session, never by process name, because the
  user's own dev server and other instances run on the same machine.

## Implementation Bias

- Recommend a cleanup that reduces drift or repeated bug fixes plainly, because maintainability is the
  standard (`collaboration-notes.md` → *Code Structure Preferences*) and not one side of a tradeoff;
  the open question is scope and sequencing.

- A constraint on what may be recorded needs a reason in the domain; if the difficulty is in the
  queries, fix the queries.

- Repeated near-identical plan steps ("wire X on A / B / C") are the signal to build the shared piece
  first, because pasted copies drift before the consolidation pass arrives.

- Thread a new field on a shared callback or prop through every call site, so the contract has one
  shape.

- When removing a condition that looks wrong, ask what else it was doing, because it may be holding up
  something its stated purpose does not mention (a request rate, an ordering).

- An authenticated endpoint is reachable whether or not the app's own client calls it, so never grade a
  gap by what the UI does. When adopting a security rule, enumerate every operation in its class and
  write down each deliberate exception with its reason, because an unrecorded exception is
  indistinguishable from a gap.

- Deliver work the tests cannot judge (how a screen looks) in small pieces the user can exercise as they
  land, because each such defect costs a full round trip.

## Verification And Tests

A small, local fix gets no new test by default: run the existing suite and lint. The entries about
writing a test apply once one has earned its place (`collaboration-notes.md` → *Testing*).

### Running

- To verify a change, run the tests that cover it; `scripts/check_backend_and_frontend.sh` is the whole
  gate (backend, lint, vitest, headless browser suite). Where no test can judge the result, such as how
  a screen looks, hand it to the user and say what to click and what correct looks like: a one-time
  check by the user is a valid test and costs less than a driven browser session.

- Look at a layout before handing it over when it is a new or reworked page, panel or list, or a visual
  change that has already come back once, because spacing and alignment defects are otherwise found by
  the user. Run the isolated stack (`.claude/skills/run-app`) and screenshot the affected region in each
  theme from a short Playwright script, cropped: a few thousand tokens, where each devtools snapshot
  costs 5–20k. A label or one control's color does not need it. The script passes Playwright's own
  `~/.cache/ms-playwright/chromium-*` binary as `executablePath`, since the build number in that path
  changes with each Playwright update.

- Investigate a red run before re-running it, because a green re-run destroys the state that explained
  it. The gate writes every run to `data/check-logs/` and prints the path, and keeps a failed browser
  run's screenshots, videos and traces in `data/check-logs/last-browser-failure/`; check the failure
  against [`transient-failures.md`](transient-failures.md), since one intermittent surfaces in several
  unrelated specs. A Playwright run started directly keeps no copy: its artifacts are in
  `frontend/test-results/` only until the next run starts.

- Redirect a test or build run to a file and read the file; never pipe it into `tail`, `head` or `grep`,
  because the pipe discards the only evidence an unexpected failure produces. The file goes in the
  session scratchpad, not `data/check-logs/`: that directory belongs to the gate, which never prunes a
  loose file left in it.

- The gate's browser step (`npm run ui:test`) leaves out the a11y lane that CI runs, so run
  `npm run ui:test:all` after touching shared UI.

- To run one spec, put its path before the project flag (`npx playwright test tests/ui/<spec>.js
  --config=playwright.config.js --project=app`), because after `--project` the path is read as a project
  name.

- Scope the run to what the change can reach: a module's tests plus lint and a build for a confined
  change, the full backend suite for something shared (a migration, a resolver, a row source). Vitest is
  cheap enough to run whole. A docs or comment-only edit gets lint and a link check, since no suite can
  observe it.

- Run `npm run lint` (from `frontend/`) after editing any `backend/*.py`, because it carries ruff and
  the backend guards (timestamps, comments), which pytest does not run.

- The pre-commit hook reads `git diff --cached` and the personal-data guard scans `git ls-files`, so
  neither sees an untracked file; name new files to the checker directly
  (`node scripts/check-personal-data.js <files>`).

- `docs/*.md` does not match `docs/backlog/*.md`; sweep with `docs/**/*.md` or `git grep`.

- Git writes are denied, `stash` included, so prove a new test fails on the old code against
  `git archive HEAD | tar -x -C <scratch dir>`, run with `backend/venv/bin/python -m pytest … -p
  no:cacheprovider`. Write the proof around behavior the old code exposes, because a test importing a
  new name fails at import and proves nothing.

- A portable kit can be built here (`backend/venv/bin/python scripts/build_desktop.py --form
  portable`), so when a change touches packaging, build one and assert against the archive, because the
  suite tests the code that produces the artifact and not the artifact.

- Where only the user's machine can verify (the macOS artifact), exhaust what can be checked here, hand
  over the whole change set at once, and state the specific thing to look for, because their loop is
  build, download, install, run.

### Environment

- Under WSL the wall clock has been seen to step backwards by one to three seconds between reads, so use
  `time.monotonic()` or `performance.now()` for timing, and order by `rowid` when a test means "the newest
  row".

- Use `LUMA_ENV_FILE` pointed at a scratch file to isolate an ad-hoc script, because every entry point
  loads `.env` with `override=True` and it beats a shell `DATA_DIR`. Print the resolved paths before
  writing anything.

- Importing `backend.main` loads the developer's `.env` into `os.environ` for the whole session, so a
  test that depends on an env flag pins it with `mock.patch.dict(os.environ, ...)`, including when the
  claim is that the flag is unset.

- Backend tests run from `backend/venv`. A direct call into a router function passes every `Query(...)`
  parameter explicitly, because an omitted one arrives as a `FieldInfo` object outside the HTTP layer.

- A vault unlock belongs to the browser session that made it, so a test that unlocks over HTTP wraps
  direct `crypto_service` calls in `in_browser_session(client)` (`backend/tests/_api_client.py`), and
  unlocks again after `select-identity`, which starts a new session.

- Playwright's `check()` / `uncheck()` verify the state flipped in the same tick, and a picker checkbox
  here follows the row's state as the write answers; use `click()` and assert the outcome.

- A vitest run that hangs with no output is usually a render loop from a mock: `useUserPreference` must
  return a value that is stable per key, as the real hook does. Run a suspect file under `timeout`.

- `MatchReport` windows its rows, so under jsdom it renders none; stand it in when asserting what a
  dialog passes it.

- Write `beforeEach(() => { api.get.mockClear() })` with braces, because Vitest runs a function returned
  from `beforeEach` as cleanup and the unbraced form returns the mock.

### Writing a test

- Build the fixture from the reported case, not from the fix, because a test shaped like the fix asserts
  the line just written and passes even when the fix is incomplete.

- Derive the test list from intent and the domain model as well as the code, because code-only tests
  cannot see a behavior that was never coded.

- Unit tests verify a component against the props you chose, so pass a deliberately unstable callback
  where a host will, render a deep-mounted dialog inside a representative ancestor, and revisit the
  contract when a consumer is widened.

- Render a surface that loads on open inside `<StrictMode>` and assert the loaded content appears,
  because the app runs under it and a plain `render()` mounts once: a "fetch once" ref beside a cancel
  flag deadlocks only on the remount. The cancel flag is the one guard.

- Assert the behavior, not the copy (a refusal by its status and the untouched row), because matching
  the sentence turns every wording edit into a red run.

- Assert the consequence rather than an attribute (click the disabled button and check the call did not
  happen), because an attribute is a claim about the element and not about the action.

- A guard is proven by making the exact edit it exists to forbid and watching it fail; for a changed
  default or constant, run the new test against the old value. A test that passes either way usually
  means a second safeguard owns the behavior.

- When a new test goes red, check its premise before changing the code, because a test written from a
  description encodes an assumption about the situation that is often the wrong part.

- When a change alters a precondition, re-check that existing fixtures still meet it, because a fixture
  can keep passing while no longer reaching the branch it was built for.

- To neutralize an optional field in a test payload, drop it, because reconstructing a valid value
  couples the test to that field's internals.

- After changing a matcher or a normalizer, compare classification counts before and after over a copy
  of real data, because the suite proves only the cases that were thought of.

- A knob that changes timing (worker count, a longer timeout) changes a race's probability, not its
  cause, so look for a rule the two sides disagree on first. Where a timeout is the fix, name in a
  comment the number it has to stay above.

- A timing threshold verified on an idle page says nothing about a loaded one, so get the figure from
  the environment that reproduces the bug.

- Verify a reference doc against the code mechanically (constants, paths against `git ls-files`, routes
  against the `@router` decorators). That finds stale facts only, so say which kind of pass was done.

## What Belongs Here

- An entry earns its place if it would change what someone does on a different task. The account of how
  a mistake happened does not belong, and neither does a lesson that only records one incident.

- A single correction is not a rule: ask before recording one, because only something that repeats has
  shown it generalizes.

- A fact about one component or one test goes in a comment at that site.

- Shipped system behavior belongs in the topic docs, and active or deferred initiatives in
  `docs/backlog/`, one file per initiative. If a conclusion changes how the system should be understood,
  move it into the repo docs in the same change.
