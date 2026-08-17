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

- **Open the thing before reasoning about it.** The most expensive mistakes in this repo have not
  been hard problems reasoned about badly; they have been easy facts inferred from a name instead of
  read. Four in one session: using the shared `Spinner` in a status row without noticing it is a
  page-level block ("Loading…" with 40px of padding); diagnosing live budget state against
  `luma-data.db` when `.env` points the app at `testing/luma-data.db`, then reporting a confident
  and entirely wrong conclusion from it; writing a "is anything else syncing?" predicate without
  checking that callers already mark their own provider syncing before delegating; and reporting a
  UI change done without re-reading the sentence that asked for it. Each cost a user round trip that
  reading for thirty seconds would have saved.

- **Check which database the app is actually pointed at before querying live state.** `.env` carries
  `DB_PATH` / `CONTROL_DB_PATH`, and they routinely differ from the repo-root defaults. A live-state
  answer from the wrong file is worse than no answer: it looks authoritative and sends the next few
  decisions in the wrong direction.

- For reproducible runtime or persisted-state bugs, prefer targeted instrumentation plus a user
  repro over long static tracing. A confirmed repro usually localizes the issue faster and more
  reliably.

- Never use a browser, launch the app, or run a browser-driven test (Playwright / E2E) to confirm
  your own work — hard rule in `CLAUDE.md` / `AGENTS.md`. The browser is only for diagnosing a
  specific reported bug you cannot localize any other way; it is never for re-checking UI work or a
  refactor (the user inspects that), and "it makes me surer" is not a reason. "It's a bug," "it's a
  big refactor," and "Playwright is a test, not a browser" are not exceptions — hand the check to the
  user. (Backend unit tests you write and run are fine.)

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

- **Figures from a live ledger are only comparable within a single run.** The user works in the app
  while a session is open, so rows get resolved, synced, or trashed between two scans. Re-derive every
  number a comparison depends on in the same pass rather than quoting an earlier run's totals.

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
  `backend.main` runs `load_dotenv()`, which puts the developer's own `.env` into `os.environ` for the
  whole session — so a flag set locally silently reaches every test that runs after it. The failure
  shape is nasty: the test passes in isolation, fails only in a full-suite run, and in between has been
  asserting the *opposite* of what it claims. Wrap the flag with `mock.patch.dict(os.environ, ...)` in
  `setUp` and assert both directions where the behavior is supposed to be flag-independent.

## Where Durable Project State Belongs

- Hidden memory is the wrong home for settled product behavior or backlog state. If a conclusion
  changes how the system should be understood, move it into the repo docs in the same change.

- Active or deferred initiatives belong in `docs/backlog/`, one file per initiative.

- Shipped system behavior belongs in the topic docs, not here. This profile should stay focused on
  working habits and reusable operational knowledge.
