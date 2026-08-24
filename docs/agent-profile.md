# Agent Profile

This document distills durable repo-specific agent guidance from prior session-memory notes.
It is the shared replacement for private tool-specific memory: useful collaboration habits,
operational footguns, and verification preferences that should survive across agents.

Use it for **how to work on this repo**, not for the product's architecture or current feature
state. The source of truth for system behavior stays in `architecture.md`, `data-model.md`,
`ui-patterns.md`, and `docs/backlog/`.

If a point here conflicts with `AGENTS.md`, `CLAUDE.md`, or the topic docs, follow the stricter
instruction and fix the drift rather than silently choosing the looser version.

## Collaboration Defaults

- Treat questions, feasibility checks, bug reports, and musings as discussion requests, not build
  requests (hard rule in `CLAUDE.md` / `AGENTS.md`). Investigate freely and answer directly, propose a
  path, then edit code only on an explicit action word (go / build it / do it / fix it / add it). The
  user picking among options you offered, or a detailed design answer, is not itself the go.

- **A "why not X?" question scopes the work to X.** Asked why some flagged rows had not been matched,
  the honest answer was about how a stored verdict is labeled and tiered; the response instead designed
  an automatic pairing mechanism the user had not asked for and had to be pulled back from it. Answer
  the question that was asked, propose the smallest change that answers it, and surface a larger design
  as an option rather than exploring it unprompted — the more so once a session has already run long,
  since a long investigation is itself a cost the user is paying.

- The user handles commits and pushes. Leave changes in the working tree and do not ask whether to
  commit at the end.

- Favor low-friction routine tool use. Keep ordinary commands simple and single-purpose so they are
  easy to approve or allowlist; still treat package installs or broader environment changes as
  higher-friction decisions.

## Investigation Strategy

- Read the repo docs before reconstructing shared behavior from source. Source-reading and DB
  queries are for verification, stale-doc cleanup, and live-state diagnosis that the docs cannot
  answer.

- **When a bug is only observable in an environment you lack, say so and propose the tooling on the
  first round — do not theorize blind.** A Safari-only layout collapse took three rounds of hypotheses
  built from reading source, each revised by the next data point, each costing the user a rebuild and a
  manual inspection. All of it was avoidable: Playwright's WebKit build was already installed on the
  dev machine, and driving the real app in it located the true cause in minutes. The rule in
  `CLAUDE.md` forbids browser-driving to check one's *own* work, and explicitly permits it to diagnose
  a bug the user reported that cannot be diagnosed another way — that permission is worth *asking about
  early*, since the user's feedback was "best would have been for you to have raised this as a
  possibility and just asked." Reproduce first, then theorize.

- **A cross-browser report is a claim about sequence until proven otherwise.** That same bug was
  reported as Safari-only and Chromium-clean; both engines in fact collapsed identically once the exact
  click sequence was reproduced. "Works in the other browser" often means the other browser was not put
  through the same steps, and treating it as an engine difference sends the investigation into CSS when
  the cause is application state.

- **Open the thing before reasoning about it.** The most expensive mistakes in this repo have not
  been hard problems reasoned about badly; they have been easy facts inferred from a name instead of
  read. Four in one session: using the shared `Spinner` in a status row without noticing it is a
  page-level block ("Loading…" with 40px of padding); diagnosing live budget state against
  `luma-data.db` when `.env` points the app at `testing/luma-data.db`, then reporting a confident
  and entirely wrong conclusion from it; writing a "is anything else syncing?" predicate without
  checking that callers already mark their own provider syncing before delegating; and reporting a
  UI change done without re-reading the sentence that asked for it. Each cost a user round trip that
  reading for thirty seconds would have saved.

- **When a defect is found, enumerate its siblings before closing it.** One frozen progress panel produced
  seven more findings, and almost none of them came from insight — they came from two mechanical habits.
  *Grep for the other call sites of anything you touch*: the duplicate sweep sat inside the ingest
  transaction at three call sites, and a review of the commit that added the first would have seen only
  one. *Ask what else has the shape of the bug you just fixed*: an index was missing because a predicate
  wrapped a column in a function, and grepping for other function-wrapped predicates found a second one on
  a per-imported-row path (15 ms a row) that nothing had noticed. The same habit applied to a rendering
  rule found three surfaces re-deriving one judgement from `mode`, disagreeing with each other on screen.

- **Ask structural questions of a diff, not just "is this correct?"** Most of that session's defects were
  invisible to a correctness reading and obvious to a specific question — *is everything between BEGIN and
  COMMIT part of what this transaction is for?*, *is a durable state being used as an event?* (`mode`
  stays `initial` for every call of a resumed backfill), *does this predicate need an index it cannot
  use?*, *does this render one judgement that is also rendered somewhere else?* A rule stated as a
  rejection ("we decided we don't need threads") does not fire when someone later adds a step; the same
  rule stated as an invariant ("the ingest transaction ends before analysis begins") does. When a decision
  is recorded, record the invariant that survived it, not only what was declined.

- **Measure before blaming, and measure on a copy of real data.** The first suspect for a 109-second
  freeze was the recurring auto-scan; it measured 0.03 s and was innocent. The actual cause measured 109 s
  on the same database and 1 s with an index. `cp` the live DB to the scratchpad and drive the real
  functions against it — the test fixtures are tiny (largest ~1,200 rows) and cannot show a cost that only
  appears at ledger scale. Two sweeps worth repeating: EXPLAIN the SQL the suite actually executes (trace
  it with `sqlite3.set_trace_callback` from a pytest plugin, then `EXPLAIN QUERY PLAN` each statement
  against a real-data copy and flag scans of large tables), and grep `with get_db()` blocks that both
  write and call into a service that reads broadly.

- **Check which database the app is actually pointed at before querying live state.** The defaults put
  both databases in the working directory, but `.env` is an *override* file that may or may not exist —
  and where it does, `DB_PATH` / `CONTROL_DB_PATH` routinely differ from those defaults. Read the file
  (or Settings → Configuration) rather than assuming either shape. A live-state answer from the wrong
  file is worse than no answer: it looks authoritative and sends the next few decisions in the wrong
  direction.

- **When a reporting surface reads badly, ask what it fails to record before asking how it renders.**
  Asked why the connection sync log was "not all that useful", the first pass audited the presentation
  of the fields already there — collapsing a repeated status, splitting a folded count, reconciling two
  numbers. All real, and all beside the point: the log named a cause (`BUDGET_PAUSED`) whose *level*
  lived only in a column the next sync overwrote, so no amount of formatting could make it diagnosable.
  The rule that fell out, now in `data-model.md`: a consumable's level belongs in the record wherever its
  effects are recorded. The habit that fell out is broader — for any diagnostic surface, enumerate what
  the underlying record holds against what a reader needs to reconstruct the event, *then* lay it out.

- **Do the systematic pass up front; drip-feeding findings is its own failure.** The cost of the above
  was not the wrong first answer, it was surfacing one more gap per turn across four exchanges, each
  landing as "why is this only coming up now?". If a question implies an audit, do the whole audit before
  answering — a complete list with a recommendation is worth more than a correct partial answer, even
  when the partial answer arrives sooner.

- Never use a browser, launch the app, or run a browser-driven test (Playwright / E2E) to confirm
  your own work — hard rule in `CLAUDE.md` / `AGENTS.md`. The browser is only for diagnosing a
  specific reported bug you cannot localize any other way; it is never for re-checking UI work or a
  refactor (the user inspects that), and "it makes me surer" is not a reason. "It's a bug," "it's a
  big refactor," and "Playwright is a test, not a browser" are not exceptions — hand the check to the
  user. (Unit tests you write and run are fine — the backend suite, and the frontend's vitest suite,
  which runs in Node/jsdom rather than a browser. Run vitest after a UI change: it is the only thing
  besides lint and a build that can catch a frontend regression without costing the user a round trip.)

- If a temporary dev server or browser session is genuinely needed for a bug diagnosis, tear down only
  the specific processes or ports launched for that session. Never use broad process-name kills.

- **A bug in one of two deliberately-parallel surfaces is a bug in the family — check every sibling
  before fixing one.** This repo has several sets of surfaces built to behave identically on purpose
  (the CSV import account grid, the connection mapping dialog, and the data-source editor's
  single-account picker; the CSV and connection dedupe paths). A defect in the shared *idea* reaches
  all of them, and the copies drift in which have been fixed: one may already carry the fix with a
  comment naming the failure, while a third has it live and unreported. Enumerate the family first and
  fix them together, rather than patching the one that was reported.

- **`get_db()` commits when its block exits, so anything that must be visible to *another* request
  mid-operation needs its own short transaction.** A long-running endpoint holds one connection open
  for its whole run; a row written on it — a progress marker, a lock, a heartbeat — does not become
  visible to any other request until that run finishes, which for such a value means never being
  visible when it matters. The naive version compiles, passes a single-request test, and silently does
  nothing. Write it through a separate `get_db()` before the long block opens, and clear it after the
  block exits (in a `finally`, so a raised request cannot leave the marker behind). Assert the
  visibility property from *inside* the long operation through a second connection — that is the only
  form of the test that would fail on the naive implementation.

- **Never run a state-changing git command to answer a read-only question.** `git stash`,
  `checkout`, `reset`, and `clean` are not investigation tools, and this repo routinely carries a
  large uncommitted working tree, so a stash can swallow a session's worth of work. To ask "was this
  already like that before my change?", read the committed version non-destructively — `git show
  HEAD:path`, `git diff HEAD -- path`, or a copy into the scratchpad. If a working tree does get
  disturbed, `git stash pop` conflicts on any file that was both staged and unstaged (`MM`);
  recover the content from `stash@{0}` and the index from `stash@{0}^2` per file, then confirm with
  an empty `git diff stash@{0}` before dropping the stash.

## Implementation Bias

- Aim for first-class code, not just a passing fix. If the right shape suggests a needed refactor
  or exposes a real tradeoff, surface it instead of quietly patching around it.

- **"No functional gain" is not a cost, and maintainability is not one side of a tradeoff.** Do not
  present a cleanup as a churn-versus-benefit judgement call for the user to weigh: the standard is
  already set (`collaboration-notes.md` → Code Structure Preferences — shared code goes in when it
  clearly reduces drift, repeated bug fixes, or inconsistent behavior; and **a bug found in one copy
  of a repeated interaction is itself the signal to check whether the behavior should be shared**).
  Where that applies, recommend the cleanup plainly and say the standard requires it. The only real
  question left is scope and sequencing, never whether quality work is worth doing.

- **Having read the evidence is not the same as using it.** The costly failures are not missing
  context — they are proceeding against context already in hand: the repo file that had been read,
  the alternative already written down in an earlier message, the mechanism already known (React
  state does not update until re-render, so a `if (busy) return` guard cannot stop a same-tick
  double press — the guard shipped anyway, and was reported as the primary fix). Before recommending
  or reporting, re-read what has already been established in the session and check the
  recommendation against it, rather than against the argument being constructed.

- Once a pattern is agreed, extend it to genuinely analogous cases rather than only the literal
  examples discussed. Surface those extensions in the summary so they can be confirmed or scoped
  back.

- Before changing a shared UI behavior, find the closest existing implementation and match that
  shape unless there is a clear reason to diverge. Do not use shared components as a workaround
  surface for a single page's problem.

- When work spans several near-identical surfaces, build the shared piece first. Repeated
  near-identical plan or todo steps ("wire X on A / B / C / D / E") are themselves the signal to
  extract — a second hand-copy is a pause, a third is a stop. Do not paste the same block across
  surfaces and leave a later consolidation pass to clean it up. Rejecting one specific sharing
  approach does not settle whether it should be shared; reconsider a simpler extraction.

- When adding a field to a shared callback or prop contract, thread it through every callsite for
  one uniform shape, even if several are near-identical one-liners. Surface a partial rollout only
  when finishing carries real risk or added complexity, not merely more edits.

- Keep user-facing wording generic and impersonal. Avoid brand-specific flavor text unless the
  brand is the technical fact, and avoid pronoun-heavy help copy where a cleaner impersonal phrasing
  will do.

- **On surfaces you cannot verify yourself, work in small checkable steps.** Every defect in UI work
  costs a full round trip through the user, because the hard rule puts the browser off limits. A
  large single pass therefore front-loads the user with a pile of defects to find one at a time. The
  same amount of code delivered in pieces the user can exercise as they land costs the same effort
  and far less of theirs. Backend work does not have this constraint — tests close the loop — which
  is exactly why the two halves of a change deserve different pacing.

- **Before reporting a change done, re-read the sentence that asked for it.** Reporting completion
  on a paraphrase, and worse, following it with proposals for further changes, reads as not having
  listened — and hides the omission behind new material. If a follow-on improvement seems worth
  making, it goes after a plain confirmation of what was actually asked, not instead of it.

- **When removing something that was accidentally load-bearing, ask what else it was doing.** A
  wrong-looking condition can be holding up more than its stated purpose: the SimpleFIN drain's
  `has_more and not resume_later` was genuinely incorrect (one account out of allowance stalled its
  siblings), but it had also been throttling request *rate*, and removing it immediately tripped a
  CDN limit nothing in the code modelled. Fixing the stated bug was right; not asking what the
  accident was covering is what turned it into a live outage.

## Verification And Tests

- **Where the only verification path is the user's own machine, batch the whole change set before
  handing it over, and exhaust what can be checked here first.** The macOS artifact is the live case:
  the agent may not drive the app at all, and the user's loop is build → download → install → run,
  which is slow enough that they will say so and then wait for everything before testing once. That
  makes a round trip expensive rather than merely inconvenient, so tests, lint and a real build are not
  a formality before the handoff — they are the only feedback available, and every defect they can
  reach is one the user does not spend a cycle finding. Land the sequence complete, then state the
  specific falsifiable claims to look for (for a shutdown fix: this exact line in this exact log), so
  one pass produces a usable answer rather than "it didn't seem to work".

- Test by value, not by reflex. Invest in recurrence-prone bugs, invariants, contracts, and
  cross-component behavior; do not assume every local fix needs a dedicated test.

- Derive a feature's test list from intent and the domain model, not only from the code as written —
  code-only tests ratify the implementation and stay blind to a behavior that was never coded. Use
  both sources: intent/spec for behavior completeness, code structure for the contracts a refactor
  must not silently break. Where a dimension is enumerable, add a fail-on-omission guard.

- To neutralize an optional/additive field in a test payload, drop it rather than reconstructing a
  valid value — reconstructing couples the test to that field's internals for no benefit.

- When a test is worth writing, make the fixture worthy of the claim. Round-trip, backup,
  serialization, and migration tests should use complete realistic data and include omission guards
  where possible.

- **After changing a matcher or a normalizer, re-run a corpus comparison over real data — the suite is
  not enough.** A processor-tag strip applied *in place* passed every test and silently destroyed five
  near-miss pairs, because one source spells a tag with its separator and another spells it as a plain
  word: stripping one side leaves two texts that resemble each other less than the originals did. Only a
  before/after tally over the whole ledger (classification counts per tier, plus the pairs that moved)
  showed it. Tests prove the cases you thought of; the corpus scan finds the direction you did not.

- **A negative guard must fail under the specific relaxation it claims to prevent.** A control written
  to stop a "one text is a prefix of the other" rule from being loosened into "the two share a long
  common prefix" passed even *with* the rule loosened — an unrelated constraint was rejecting the
  fixture, so the guard tested nothing. Prove it by making the exact edit the guard exists to forbid,
  not by disabling the feature wholesale; the two fail differently and only the former is the claim.

- **A timing threshold verified on an idle page proves nothing about a loaded one.** A paint gate
  tuned to 150ms was confirmed twice — green tests, and a browser session driving the real app — and
  was wrong both times, because both checks ran against a page with nothing else in flight. The defect
  only existed under contention: the request answered in 22ms and *landed* several hundred
  milliseconds later, queued behind the page's other requests. The user's own Network panel showed it
  (a 22ms "Time" against a bar spanning ~220ms), and the way to get it was to ask for that number
  rather than to re-derive confidence from a quiet environment. When a fix depends on how long
  something takes, get the figure from the environment that reproduces the bug, and treat a clean
  local reproduction as evidence about *that* environment only.

- **Figures from a live ledger are only comparable within a single run.** The user works in the app
  while a session is open, so rows get resolved, synced, or trashed between two scans. Re-derive every
  number a comparison depends on in the same pass rather than quoting an earlier run's totals.

- **The pre-commit hook only sees *staged* files, so running it proves nothing about a new one.**
  `scripts/pre-commit.sh` reads `git diff --cached`, so an untracked file is invisible to it — and the
  most likely file to trip a lint is the one just written. This was reported as "the hook passes" and the
  user's very next commit failed on exactly the new file. To check work that adds files, either stage them
  first or invoke the checkers directly with the paths (`node scripts/check-backend-timestamps.js <files>`),
  which is what the hook does anyway.

- **An assertion that cannot fail is worse than no assertion.** Before trusting a new check, ask what it
  would take for it to go red. The concrete case: the shared `Button` never sets the DOM `disabled`
  attribute (it dims and drops the handler), so `expect(btn.disabled).toBe(true)` passes against every
  implementation of everything. Assert the consequence — click it, and check the call did not happen.

- Prove new guards actually fire. A green result is only meaningful after seeing the same check fail
  on known-bad input. This bites hardest when **changing a default or a constant**: run the new test
  against the old value and require it to fail. A test that passes either way is not testing the
  change, and the usual cause is a second, unnoticed safeguard already handling the case — find which
  one owns the behavior before claiming the test covers it.

- When a change alters a precondition, re-check that existing fixtures still *meet* it. A fixture can
  keep passing while silently no longer exercising the thing it was built for (a date range that no
  longer establishes coverage, an input that no longer reaches the branch). Prefer extending the
  fixture so the original scenario still exists over rewriting assertions down to the weaker reality —
  the assertions are the record of what was meant to be true.

- Backend tests run from `backend/venv`, and direct calls into FastAPI router functions must pass
  every `Query(...)` parameter explicitly because omitted values stay as `FieldInfo` objects outside
  the HTTP layer.

- **A test that depends on an env flag must pin it, never inherit it.** Any test importing
  `backend.main` runs `load_dotenv()`, which puts whatever the developer's own `.env` holds into
  `os.environ` for the whole session — so a value set locally silently reaches every test that runs
  after it. This bites assertions about *absence* just as hard: "no override is set" has to be made
  true by clearing the variable, not assumed from a clean-looking default. The failure
  shape is nasty: the test passes in isolation, fails only in a full-suite run, and in between has been
  asserting the *opposite* of what it claims. Wrap the flag with `mock.patch.dict(os.environ, ...)` in
  `setUp` and assert both directions where the behavior is supposed to be flag-independent.

## Where Durable Project State Belongs

- Hidden memory is the wrong home for settled product behavior or backlog state. If a conclusion
  changes how the system should be understood, move it into the repo docs in the same change.

- Active or deferred initiatives belong in `docs/backlog/`, one file per initiative.

- Shipped system behavior belongs in the topic docs, not here. This profile should stay focused on
  working habits and reusable operational knowledge.
