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

- The user handles commits and pushes. Leave changes in the working tree and do not ask whether to
  commit at the end.

- Favor low-friction routine tool use. Keep ordinary commands simple and single-purpose so they are
  easy to approve or allowlist; still treat package installs or broader environment changes as
  higher-friction decisions.

## Investigation Strategy

- Read the repo docs before reconstructing shared behavior from source. Source-reading and DB
  queries are for verification, stale-doc cleanup, and live-state diagnosis that the docs cannot
  answer.

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

## Where Durable Project State Belongs

- Hidden memory is the wrong home for settled product behavior or backlog state. If a conclusion
  changes how the system should be understood, move it into the repo docs in the same change.

- Active or deferred initiatives belong in `docs/backlog/`, one file per initiative.

- Shipped system behavior belongs in the topic docs, not here. This profile should stay focused on
  working habits and reusable operational knowledge.
