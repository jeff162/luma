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
  an automatic pairing mechanism nobody had asked for. Answer the question that was asked, propose the smallest change that answers it, and surface a larger design
  as an option rather than exploring it unprompted — the more so once a session has already run long,
  since a long investigation is itself a cost the user is paying.

- **A question for the user goes in the closing summary, not only where it arose.** The user reads the
  whole reply, but a question buried mid-answer — beside the reasoning that produced it — is the thing
  most easily missed, and a missed question costs a whole round trip. State it inline if that is where it
  belongs, then repeat it at the end where the user is looking for what to do next. If several came up,
  the summary carries all of them.

- **Ask what the user is doing, not only what each message says.** Across four exchanges the user
  removed, one at a time, the two premises this profile's author had himself named as a documentation
  section's entire foundation; each message was processed as a local fix, and the section was rewritten
  four times before being deleted whole. Asking outright why it existed did not stop the rewriting, so
  the user fell back to walking the document paragraph by paragraph — work that should never have been
  theirs to do. **When a reply removes a premise, re-derive what still stands on it before editing
  anything**: what rested on it may no longer stand. A question aimed at a whole section ("what does this
  mean?", "is this needed?") is a question about whether it should exist, and a repeated objection to
  already-revised text is never a request to say it better. "Can I articulate why this is here" always
  passes for prose you wrote yourself; the test that discriminates is **what breaks if it is gone**.

- **Before giving a claim structural weight, grep for it in the code.** The section that cost the day
  above was built on a per-connection credential being read-only — given its own heading, a table, "both
  clauses are load-bearing", and a trigger to reopen the document. `git log -S read_only -- backend`
  returns nothing: the string has never existed in this codebase in any commit. It came from a
  build-phase log, where it was an observation about the *first* provider's token, and became a premise
  purely by being formatted like one. **An invariant a document asserts should be findable in the thing
  it describes** — a capability flag, a constraint, a test, a gate. If nothing expresses it, it is an
  observation and belongs in a sentence. The failure this guards against is not drift: nothing changed
  underneath, and no amount of re-reading the document would have exposed it. Ten seconds of grep would
  have. **Beware the diagnosis that locates a fault in events rather than in a choice** — "the foundation
  moved" was offered here as the explanation and the history flatly contradicted it.

- **Do not assert what has not been established — in prose, in a number, or in a diagnosis.** Three of
  these landed in a single session and they are one habit rather than three. `SECURITY.md` told the
  reader that "a leak that came from a synced folder or a backup routine is rarely a one-time event" —
  a claim about frequency in the *reader's* circumstances, which nothing here can see, and it turned a
  one-time response into what read as a standing chore. A comment in the packaging script said
  compressing the executable saved nearly the whole download; the real binary measured **1%**, because
  PyInstaller has already compressed the archive inside it. And a flaky browser suite was reported as
  fixed by lowering the worker count, which had only moved a probability. Each was caught, and each had
  the same shape: a confident sentence standing where a measurement or a condition belonged. **State
  what makes the thing true instead** — "the recovered secret would otherwise protect the replacement
  credentials" is the real reason *and* survives not knowing how the file escaped. Where a quantity is
  the point, measure it before writing it down; the measurement is usually cheaper than the sentence.

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
  a reported bug that cannot be diagnosed another way. **Asking early is what that permission is for** —
  raising the possibility costs one question, while theorizing blind costs a round trip per hypothesis.
  Reproduce first, then theorize.

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

- **A gate written against *current state* where the right predicate is *capability*.** The same
  one-word mistake appeared three times in one feature (2026-09-01), each time with a comment
  confidently justifying it. A pending vault-access request was hidden from anyone whose vault was not
  open right now — `is_unlocked` where the question is `user_has_slot` — in the Tasks nag and again on
  the Connections strip, both reasoning that a locked member "has no action available". They do: they
  unlock, then act. Hiding it removed the only signal that would tell them to, so the person waiting
  waited on a notification nobody was ever shown. The same conflation shaped the first draft of a
  security rule in the same session.

  **How to apply.** When a check hides, refuses, or skips something, say which question it is asking —
  *can this actor ever do this?* or *can they do it this second?* — and which one the surface needs. A
  transient state (unlocked, connected, in-flight) as the predicate for a *durable* judgement (who may
  approve, who should be told) is the shape to distrust. Then grep for the other readers of that same
  state: the reasoning that produced one instance almost always produced the others.

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
  on the same database and 1 s with an index. Take the copy with `sqlite3 <live.db> ".backup <scratch.db>"` rather than
  `cp`: both databases run in WAL mode, so copying the main file alone drops whatever is committed but
  still sitting in the `-wal`, and the copy is then quietly missing recent rows. Drive the real functions
  against that copy — the test fixtures are tiny (largest ~1,200 rows) and cannot show a cost that only
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

- Run the headless suites; ask before anything headed — hard rule in `CLAUDE.md` / `AGENTS.md`. The
  Playwright lanes are ordinary tests: headless, on their own isolated stack, with results you can
  read, so running them to check your own work is expected rather than an exception, as is a scripted
  headless session for exploring or diagnosing. What waits for permission is the *headed* forms
  (`--headed`, `--debug`, `ui:codegen`, a hand-driven `npm run dev`), because that is where the
  trouble has been — long interactive sessions and a conclusion drawn from one screenshot. Ask for a
  headed session when it would genuinely help rather than grinding on: something that cannot be
  isolated another way, or an attempt or two that have already failed. Say what it would settle.
  `scripts/check_backend_and_frontend.sh` runs the whole gate and is the habitual command. To run one spec,
  put its path before the project flag — `npx playwright test tests/ui/<spec>.js --config=playwright.config.js
  --project=app` — since `--project app tests/ui/<spec>.js` reads the path as a second project name and
  exits with "Project(s) not found" before running anything.

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

### Separate "I know the mechanism" from "I know the cause"

Being right about *how* a symptom is produced says nothing about *why the precondition held*, and only
the second licenses a preventive fix. The two come apart routinely: a mechanism can be confirmed and
even reproduced in a test while its cause stays unrecoverable, the evidence having cascaded away with a
deleted row.

**Before naming a mechanism, state which line produces it, then check that the observed data meets that
line's preconditions.** What this catches is a plausible neighbour — a fallback on the *skipped-row*
path, which writes `account_id: None`, offered as the explanation for a row that had a real account id.

**How to apply.** Say plainly which half is in hand, and treat "how confident are you?" as a request for
that split rather than for reassurance. With the mechanism confirmed and the cause unproven, prefer the
change that is correct either way over one aimed at the guess, which may fix nothing and cannot be
validated — and prefer the fix with no semantic blast radius. A label that looks presentational may be
written into row evidence and feed duplicate matching, so "just correct the label" can alter matching on
the strength of that guess.

Where a cause is unrecoverable, leave the recurrence diagnosable: record an advisory on the path that
fired, into `connection_sync_log.advisories` — a table with a reader behind it (the **Sync log**
on Import / Export or Accounts → Connections), not a console line nobody opens. Pick the surface by who can act on it:
`advisories` is the developer's, while `last_sync_warnings` shows on the connection card and is reserved
for what the *user* can act on.

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

- **A constraint on what may be recorded needs a reason in the domain, not in the queries.** Split
  allocations were given a "one part per category" rule, written into `data-model.md` as settled and
  supplied with a rationale; the real reason was avoiding five `COUNT(*)` → `COUNT(DISTINCT)` edits, and
  it discarded exactly the detail the feature existed to capture. Before constraining the data model,
  ask which side the difficulty is on — if it is the queries, fix the queries. When such a rule is
  reversed, record the reversal where the rationale lived, with a "don't re-impose it", because the
  original argument reads as plausible to whoever finds it next.

- **A green unit suite says nothing about how a component sits in the live tree — and that is where the
  defects are.** Attachments phase 1 shipped with ~40 new tests passing and the user found four defects
  in an hour, every one of them invisible to those tests by construction rather than by oversight. A
  panel looped forever because its host passed an inline callback, while the test passed a stable
  `vi.fn()` whose identity never changed. A dialog surfaced underneath the page header because it was
  opened from inside a table, while the test rendered the row with no table around it. A row opened a
  deleted document because the reconcile carried a count and the row had grown to need ids — the test
  asserted the count contract as written. The pattern: **unit tests verify a component against the
  props you chose to give it, and every one of these failures came from props or ancestors the real app
  supplies and the test does not.** Practical consequences — pass a deliberately *unstable* callback
  where a host will; render a deep-mounted dialog inside a representative ancestor; and when a consumer
  is widened (a marker that now *opens* what it used to merely count), revisit the contract feeding it
  rather than assuming it still fits. Above all, when a feature's risk is concentrated in tree
  placement, say so and ask for a targeted look **early**, instead of reporting it done and discovering
  it over four round trips.

- **Withholding a capability keeps being the mistake, and it arrives wearing two different arguments.**
  The first is *it might be confusing* — a search prefix made mandatory, a document marker left as an
  inert counter — where the fix was to **explain** rather than to withhold: a label, a marker, or a
  tooltip, which it almost always is. The second is *another route already reaches it*, which is
  how the multi-payment purchase marker was first built inert: the row's pencil opened a panel holding
  the editor, so a marker that opened the same thing read as redundant. It is not redundant, because the
  question is not whether the capability is reachable but whether **this** control does what it stands
  for — a marker representing something openable that does nothing reads as broken, whatever else exists
  elsewhere. Every one of these was reversed on first real use, and each is recorded in its own design
  doc as don't-re-impose precisely because the original argument reads as restraint rather than as a
  defect. **Watch for the second form especially**: the first is caught by asking "could this be
  misread?", and the second sails straight past that question. Both are the same shape as the
  split-allocation rule above — a constraint whose real justification was the implementer's convenience
  or tidiness rather than anything in the domain.

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

- **Work in small checkable steps on anything the tests do not reach.** The headless suites close the
  loop on a lot of UI work now, so use them; what they cannot judge is whether a screen *looks* right,
  and every defect of that kind costs a full round trip through the user. A large single pass
  front-loads them with a pile of defects to find one at a time, where the same code delivered in
  pieces they can exercise as it lands costs the same effort and far less of theirs. Write the spec
  and run it before handing over — an unverified spec is a defect delivered with extra steps.

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

- **"Our own UI never calls it" is not a security boundary, and one instance is not the class.** An
  authenticated endpoint let an unlocked session replace the vault passphrase with no proof of the old
  one — turning transient access to someone's screen into durable, independent access that survives a
  relock. It was graded as *optional* hardening on the reasoning that the app's client never makes that
  call — which is not the test: reachability for an authenticated endpoint is the API surface, not the
  client. The follow-up question that settled it — *does that leave any actions that still don't require
  proof?* — found a fourth operation in the same
  class with a **shorter** path to abuse than the three being fixed, which had not been enumerated
  because only the reported instance was in view.

  **How to apply.** Never grade a reachable-by-request gap by whether the shipped client exercises it.
  When adopting a security rule, enumerate every operation in its class before implementing, and write
  the ones deliberately left out into the docs **with the reason for each** — an exception with a
  recorded rationale is a decision, while an exception nobody wrote down is indistinguishable from a
  gap, including to the next agent who audits it.

- **Never describe intended design as though it were built.** Writing a doc or a code comment in the same
  pass as the code makes it easy to record the design you *meant* to ship rather than the one that is
  there. It happened cleanly on 2026-09-05: a comment and a `ui-patterns.md` paragraph both stated that
  the Accounts connection card "keeps a compact last-synced line", which was the plan and was load-bearing
  for the argument that neither half of a split surface goes silent about the other. The line had never
  been added. The user found it by looking at the screen and asking why a status word sat where a time
  should be — and the doc, being confident and specific, would have kept the next reader from checking.

  The check is cheap and mechanical: before writing that a surface *does* something, grep for the thing.
  A claim about rendered UI is verifiable in seconds and is exactly the kind that survives unexamined
  because it reads as authoritative. Prose describing intent ("this is why X sits here") is safe; prose
  asserting behaviour ("X shows Y") needs the same standard as a test assertion.

## Verification And Tests

- **Every test failure is investigated when it happens, before anything else — including before
  re-running it.** The question that feels natural, *"was that caused by my change?"*, is the wrong one
  and it is what turns a failure into a lost signal: the answer is moot, because a failure has to be
  fixed regardless of which change surfaced it. Treat a red run as *information that exists right now and
  will not exist in a minute*. Preserve it first — the full output, the artifacts, whatever the run
  produced — and only then form a theory. Re-running to see whether the failure follows the current
  change set is legitimate and often useful, but it is a **second** step, never the first, because a
  green re-run destroys the state that would have explained the red one.

  Identifying the root cause is not required. Preserving enough to dig into it later is. "Passed on a
  re-run, probably a known flake" is not an investigation — it is the report of one that did not happen,
  and it hands the next reader a fact that was true and no longer checkable.

  The gate now writes every run whole to `data/check-logs/` and prints the path on its last line
  (`scripts/check_backend_and_frontend.sh`), so preserving a failure costs nothing and forgetting to is
  no longer possible. Read that directory *before* re-running, and check the failure against
  [`transient-failures.md`](transient-failures.md) — an intermittent can surface in several unrelated
  specs, so the failing test's name is not how you tell them apart. This rule is stated first because it is
  the one that has been broken twice, and the piping rule below is only the mechanism by which it was
  broken the second time.

- **Write the test as a miniature of the reported case, not of the fix.** A rule apply left a phantom
  recurring series on screen. The obvious cause was real — the rule endpoints never re-ran detection —
  and fixing it was necessary and *not sufficient*. A test shaped like the fix ("an apply triggers the
  rescan") would have passed by construction, since it asserts the line just written. The test shaped
  like the user's ledger — two accounts, a counterpart leg the rule is about to file, a payee series
  already sitting over the other leg — failed, and named the missing half: the rescan ran, scoped to the
  payee that changed, while the stale series lived in the *other* leg's payee group. Build the fixture
  from the reported shape before believing a diagnosis, and let it fail once against the incomplete fix.
  The failure this prevents is a change that ships green against its own mechanism and does nothing at
  all for the person who reported the bug.

- **Never pipe a test or build run into `tail`, `head`, or a filtering `grep`. Redirect to a file and
  read the file.** A run that fails unexpectedly is the only evidence that failure will produce, and a
  pipe throws all of it away before anyone can look. This was learned the expensive way and immediately:
  minutes after adding a diagnostic log line to the auth middleware *specifically* so an intermittent
  401 could be identified, a routine `pytest … | tail -2` hit that exact failure and discarded the line
  it had just been built to capture — then five re-runs were spent trying to make it happen again. The
  reasoning that led there is the part to distrust: the run was framed as a green-check, where only the
  last line matters, and that framing is wrong for **any** suite with a known intermittent, where every
  run is also a capture opportunity. Cheap and unconditional:

  ```bash
  ./scripts/check_backend_and_frontend.sh backend > /tmp/run.log 2>&1; tail -5 /tmp/run.log
  ```

  The same shape applies to a long build, a Playwright run, and anything whose interesting output is in
  the middle. Filter the *file*, never the stream.

  **Written down once was not enough.** This rule was added to this file and broken again within three
  hours, on the same intermittent test, by an agent that had read `CLAUDE.md` and `AGENTS.md` but never
  opened *this* document — so the failure was not the wording, it was that nothing structural enforced
  it. Hence the gate's own logging above, which is the version that does not depend on anyone having
  read this paragraph. Two lessons generalize: a rule that lives only in prose is a rule that holds only
  for the agent who happened to read the prose, so prefer making the right thing automatic; and the docs
  named in `CLAUDE.md` are a **list to work through**, not a menu to sample from — this one is where the
  operational footguns live, which makes skipping it the most expensive omission available.

- **To prove a new test fails on the old code, run it against a copy of `HEAD`, not a stashed tree.** Git
  writes are denied, `git stash` included, and a stash would pocket the user's uncommitted work anyway.
  `git archive HEAD | tar -x -C <scratch dir>` is read-only and produces a clean checkout of what is
  committed; copy the new or changed test files into it and run them with the repo's own
  `backend/venv/bin/python -m pytest … -p no:cacheprovider` from that directory. A test that passes there
  is not testing the change. It does not work for a test importing a name the change introduced — that
  fails at import, which proves nothing — so write the proof around behavior the old code already exposes
  (an HTTP route, a service call) wherever possible.

- **A test that unlocks the vault over HTTP and then calls `crypto_service` directly gets `VaultLocked`.**
  An unlock belongs to the browser session that presented the secret (`security-model.md` → *Identity and
  the network perimeter*), and a direct service call from the test thread is a different session with
  nothing unlocked. Wrap such calls in `in_browser_session(client)` from `backend/tests/_api_client.py`,
  which joins the test client's session. The same rule is why a test that switches identity with
  `select-identity` and switches back finds the first user locked: picking an identity starts a new
  session, so unlock again.

- **A flaky test is not fixed by lowering concurrency.** Capping Playwright's worker count made a
  failure stop reproducing, and that is evidence of nothing: a knob that changes timing changes a race's
  *probability* without touching its cause. Six clean runs at the original setting then showed the
  correlation was spurious. The user's objection is the test to apply to any mitigation before accepting
  it — "that by itself is not a deterministic change." What the failure actually was: a fixed wrong
  relationship between two constants, `expect.timeout` at 10s against the backend's
  `_BUSY_TIMEOUT_SECONDS` of 15s, so a spec gave up partway through a wait the app is designed to absorb
  and then succeed after. SQLite's WAL serializes writers, so that wait is by design and the test was
  less patient than the thing it tested. Look for a rule the two sides disagree on before reaching for a
  setting that makes the symptom rarer — and where a timeout genuinely is the fix, name the other number
  it has to stay above, in a comment, so the pair moves together.

- **Where the only verification path is the user's own machine, batch the whole change set before
  handing it over, and exhaust what can be checked here first.** The macOS artifact is the live case:
  the agent may not drive the app at all, and the user's loop is build → download → install → run,
  which is slow enough that they will say so and then wait for everything before testing once. That
  makes a round trip expensive rather than merely inconvenient, so tests, lint and a real build are not
  a formality before the handoff — they are the only feedback available, and every defect they can
  reach is one the user does not spend a cycle finding. Land the sequence complete, then state the
  specific falsifiable claims to look for (for a shutdown fix: this exact line in this exact log), so
  one pass produces a usable answer rather than "it didn't seem to work".

- **A portable kit can be built and opened here, and packaging defects live where no test looks.**
  `backend/venv/bin/python scripts/build_desktop.py --form portable` produces a real Linux artifact in
  about forty seconds (PyInstaller is in `backend/requirements-build.txt`), and reading the zip back
  with `zipfile` is what exposed two defects the whole suite was green through: the executable went in
  dated 1980 and uncompressed, and the text members extracted as mode 0o600. Neither was reachable from
  tests of the code that *produces* the artifact, because both were properties of the artifact — and
  CI's `smoke_artifact.py` does not look either, since it launches the binary and asserts where the
  databases land. So when a change touches packaging, build one and inspect the output, then write the
  assertion against the archive rather than against the call. The bullet above still holds for the
  macOS `.app`, which cannot be produced or run here at all.

- **Scope the test run to what the change can reach.** A change confined to a page, a component, or one
  backend module is verified by that module's tests plus lint and a build — running the whole 2,000-test
  backend suite for a frontend change or a self-contained helper re-proves code the diff cannot touch.
  It costs about half a minute now that the runner passes `-n auto` rather than the two minutes it used
  to, so the argument is noise rather than time, but it is the same argument. Reach for the full suite when the change is to something shared: a
  migration, the row source a query selects from, a resolver, an invariant several subsystems read. The
  frontend's vitest suite is cheap enough (~10s) to run whole after any UI change.

  **A change that cannot alter behavior gets no suite at all.** A documentation edit, or a source edit
  confined to a comment or docstring, is verified by the checks that can actually observe it: a
  link/anchor check over the docs, `npm run lint` (which carries the comment-quality checks for both
  halves of the repo), and a syntax check on any touched source file. Running pytest against a diff of
  eleven comment lines re-proves code the edit could not reach — the same waste this bullet already
  names, in the case where it is total rather than partial.

- Test by value, not by reflex. Invest in recurrence-prone bugs, invariants, contracts, and
  cross-component behavior; do not assume every local fix needs a dedicated test.

- **Assert the behavior, not the copy.** A refusal is tested by its status and by the row being left
  alone; a hint by whether one is shown; an echoed figure by the figure. Matching the sentence around any
  of these tests nothing the behavior depends on, and turns every wording edit into a red run.

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

- **Verify a reference doc against the code, not by reading it.** The productive pass over `docs/` was
  mechanical: every backticked constant checked against its real value, every cited path and bare filename
  against `git ls-files`, every `GET|POST /path` against the `@router` decorators, and every threshold
  stated in prose against the constant behind it. That found six defects in one document and zero in six
  others, cheaply and with no round-trips. It finds **stale facts**; it cannot tell whether a document is
  about the right things — that needs a reader who knows the decisions. State which of the two a pass
  covered rather than reporting "the docs are in good shape".

- **`docs/*.md` does not match `docs/backlog/*.md`.** A sweep glob that stops at the top level reported
  every stale reference gone while six survived one directory down, in the file most likely to be read
  cold by someone who was not there. Use `docs/**/*.md` or `git grep`, and re-run the search that produced
  a clean result before reporting it as one.

- **The pre-commit hook only sees *staged* files, so running it proves nothing about a new one.**
  `scripts/pre-commit.sh` reads `git diff --cached`, so an untracked file is invisible to it — and the
  most likely file to trip a lint is the one just written. This was reported as "the hook passes" and the
  user's very next commit failed on exactly the new file. To check work that adds files, either stage them
  first or invoke the checkers directly with the paths (`node scripts/check-backend-timestamps.js <files>`),
  which is what the hook does anyway. The personal-data guard has the same blind spot from the other side:
  with no paths it scans `git ls-files`, so a new test file passes `npm run lint` unread — name the new
  files (`node scripts/check-personal-data.js $(git ls-files --others --exclude-standard)`).

- **The backend timestamp guard runs in `npm run lint`, not in the test suite.**
  Despite the name, `scripts/check-backend-timestamps.js` is a Python lint rather than anything about file
  times: it forbids `datetime.utcnow()` (deprecated in 3.12+, and never exemptable) and a bare
  `datetime.now()` (which returns **local** time, silently corrupting a value that is UTC by convention),
  requiring stored timestamps to route through `utcnow_iso()` in `backend/time_utils.py`. A value that
  genuinely is local time takes `# local-time: <reason>` on the same line, and the reason is mandatory —
  an exemption that can be applied without stating why is a rubber stamp. `npm run lint` (as
  `lint:timestamps`, with no paths) scans the whole backend tree, while
  `backend/tests/test_timestamp_guard.py` only exercises the guard's own logic against fixtures — so a
  violation survives a green test suite, and `npm run lint` is the check to run after editing any
  `backend/*.py`.

- **An assertion that cannot fail is worse than no assertion.** Before trusting a new check, ask what it
  would take for it to go red. The concrete case: the shared `Button` used to dim and drop its handler
  without setting the DOM `disabled` attribute, so an assertion on that attribute said nothing about
  whether the button could still act. It sets the attribute now, but the lesson stands for any control a
  wrapper renders: the attribute is a claim about the element, not about the action. Assert the
  consequence — click it, and check the call did not happen.

- **When a new test goes red, check its premise before changing the code.** A test written from a
  description of the behaviour encodes an assumption about the situation, and that assumption is wrong
  often enough that the red is information rather than a defect. Three in one session, each of which
  paid: a "no collision" case whose average turned out to genuinely sit 13px from a tick (the fixture
  was wrong, and a correctly chosen one made the test stronger); a "crowded axis" case that exposed a
  real gap — the code would place a label 51px from the line it belonged to, so the fix was a distance
  cap, not a test edit; and a round-trip that cannot hold because a bucket set narrower than its
  viewport cannot be scrolled at all, so the true property was "on screen", not "centred". Reaching for
  the implementation first would have papered over two of the three. The tell is a failure whose numbers
  make sense — read them and work out what situation actually produces them.

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

- **A vitest run that hangs with no output is usually a render loop from a mock, not the code.** Mock
  `useUserPreference` with a value that is stable per key, as the real hook's is; returning the default
  afresh each render makes any consumer that reacts to it re-render forever. And `MatchReport` windows its
  rows, so under jsdom it renders none — stand it in when asserting which entries a dialog passes it. Run a
  suspect file under `timeout` so a hang ends.

- **Brace a one-line `beforeEach`/`afterEach` that calls a mock.** `beforeEach(() => api.get.mockClear())`
  returns the mock, and Vitest runs a function returned from `beforeEach` as that test's cleanup — so the
  mock is called once more, with no arguments, after the test body. The failure points at the wrong place:
  a destructuring error inside the mock's implementation, reported against whichever test is running (both
  tests in a file at once, once the implementation outlives a reset), with no caller in the stack. It cost
  several probe runs to trace. `beforeEach(() => { api.get.mockClear() })` returns nothing.

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
