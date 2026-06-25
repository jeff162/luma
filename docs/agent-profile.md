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

- Treat questions, feasibility checks, and musings as discussion requests, not build requests.
  Investigate freely, answer directly, recommend a path, and wait for confirmation before editing.

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

- Do not spend browser quota on routine post-change confirmation. Use the browser when it helps
  debug or disambiguate behavior, not just to re-check ordinary UI work the user will inspect
  anyway.

- If a temporary dev server or browser session is needed, tear down only the specific processes or
  ports launched for that session. Never use broad process-name kills.

## Implementation Bias

- Aim for first-class code, not just a passing fix. If the right shape suggests a needed refactor
  or exposes a real tradeoff, surface it instead of quietly patching around it.

- Once a pattern is agreed, extend it to genuinely analogous cases rather than only the literal
  examples discussed. Surface those extensions in the summary so they can be confirmed or scoped
  back.

- Before changing a shared UI behavior, find the closest existing implementation and match that
  shape unless there is a clear reason to diverge. Do not use shared components as a workaround
  surface for a single page's problem.

- Keep user-facing wording generic and impersonal. Avoid brand-specific flavor text unless the
  brand is the technical fact, and avoid pronoun-heavy help copy where a cleaner impersonal phrasing
  will do.

## Verification And Tests

- Test by value, not by reflex. Invest in recurrence-prone bugs, invariants, contracts, and
  cross-component behavior; do not assume every local fix needs a dedicated test.

- When a test is worth writing, make the fixture worthy of the claim. Round-trip, backup,
  serialization, and migration tests should use complete realistic data and include omission guards
  where possible.

- Prove new guards actually fire. A green result is only meaningful after seeing the same check fail
  on known-bad input.

- Backend tests run from `backend/venv`, and direct calls into FastAPI router functions must pass
  every `Query(...)` parameter explicitly because omitted values stay as `FieldInfo` objects outside
  the HTTP layer.

## Where Durable Project State Belongs

- Hidden memory is the wrong home for settled product behavior or backlog state. If a conclusion
  changes how the system should be understood, move it into the repo docs in the same change.

- Active or deferred initiatives belong in `docs/backlog/`, one file per initiative.

- Shipped system behavior belongs in the topic docs, not here. This profile should stay focused on
  working habits and reusable operational knowledge.
