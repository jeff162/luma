# Agent Guidelines

## Hard rules — no exceptions, no rationalizing

The rules an agent most reliably talks itself out of "just this once." There is no case different
enough. If a situation *feels* like it warrants an exception, that feeling **is the rule firing** —
stop and follow the rule. Check these *before* acting, not after.

1. **Never drive a browser, launch the app, or run the UI/E2E test suite to check your own work.**
   Confirming a change works, checking a page renders, or verifying a refactor didn't break something
   by launching the app or running **Playwright / any browser-driven test** is prohibited — hand that
   check to the user instead. *Not exceptions:* "it's a bug," "it's a big/critical refactor,"
   "Playwright is a test suite, not a browser," "just one quick look." The browser is allowed **only**
   to diagnose a specific bug the user reported that cannot be diagnosed another way — never to confirm
   your own changes. (Backend unit tests you write and run are fine; this is about browsers and app/UI
   driving.)

2. **A question or a bug report is not a build request.** When the user asks a question, reports what
   the app did, asks "is this right?", or muses about a direction — answer and, if useful, propose; do
   not edit code. Start changing code only on an explicit action word (*go / build it / do it / fix it
   / add it*). Answering a design question, or the user picking among options you offered, is not
   authorization to implement.

Follow the commenting style defined in `docs/code-commenting-style.md`.

Before any non-trivial change, read `docs/collaboration-notes.md` for project decision-making preferences and working habits. The bar is first-class code conforming to accepted best practice, not just something that works; when getting it right reveals a needed refactor or a real tradeoff, surface it for a decision rather than silently working around it or expanding scope.

For workflow changes that touch generated state, persisted review state, imports, rules, categorization, or undo/return paths, follow the design-pass guidance in `docs/collaboration-notes.md` before implementation: map affected surfaces and lifecycle states first, then code.

Before working on shared UI behavior — whether changing it, investigating it, debugging it, or designing against it — read `docs/ui-patterns.md` first. The docs are the authoritative high-level map; treat the code as the implementation to verify against, not the source of truth for intent.

Before working on shared systems, persistence, or invariants — same rule — read `docs/architecture.md` and `docs/data-model.md` first. "I'm only investigating" or "I'm only answering a question" is not an exemption: investigations shape later design, and rediscovering the model from code wastes time and tends to miss the *why*.

## Core Rules

- Comment **systems and intent**, not individual lines

- Prefer **one comment per conceptual model or subsystem**

- Place comments at **system entry points** (top of component, key function, or initialization)

- Do not comment obvious logic

- Determine whether a file encodes a meaningful system before adding a top-level comment

- Files that represent workflows, shared logic, or invariants should have a single top-level system comment

- Simple or localized files should remain minimal and may have no top-level comment

## What to Comment

### Frontend

- Interaction models and UI behavior

- State coordination and component relationships

- Non-obvious user flows or constraints

### Backend

- API contracts and endpoint behavior

- Data semantics and transformations

- Invariants, constraints, and filtering rules

## What to Avoid

- Restating what the code does

- Commenting simple CRUD or obvious queries

- Structural or UI narration (e.g. �Render�, �Header�)

## General

- If unsure whether a comment adds value, skip it

- Prefer consistency with existing patterns in the codebase

- Do not modify working logic unless explicitly requested

## Local Scratch Files

- Use `data/` for local helper scripts, screenshots, notes, temporary test artifacts, and other scratch files that should not be committed

- Prefer `data/` over tracked project directories for one-off debugging utilities or local workflow helpers

- For UI debugging, use `data/ui/` for browser helpers and `data/ui/artifacts/` for screenshots or other captured output

## Documentation Consistency

The `docs/` directory captures the **intent** of the system: what it does, **why** it works the way it does, and **how the pieces fit together at a high level**. Git history records what changed; `docs/` records what the system *is* and *why*. Keep them in sync.

**Overlap and precedence.** Some rules are intentionally stated in more than one place — most notably, `CLAUDE.md` and this file both carry the read-first rule and the quality bar so that each entry point is self-sufficient (an agent that reads only one of them still gets the rule). These copies are meant to agree. If two statements ever appear to conflict, follow the **stricter** one and surface the discrepancy to the user to reconcile — do not act on the looser reading, and do not silently rewrite one to match the other. This keeps intentional duplication safe and turns drift into a flagged question instead of a silent regression. The same rule applies to any apparent inconsistency between docs, code comments, and these instruction files.

When working on the codebase:

- Follow the commenting style in `docs/code-commenting-style.md`.

- If your work introduces a system, alters one, shifts an invariant, or settles a design decision that future readers would need to know to understand the code, update the relevant doc in the same change:

  - `docs/architecture.md` — structure, data flow, cross-cutting contracts between subsystems

  - `docs/data-model.md` — data semantics, invariants, what each field means and what it is *not* allowed to mean

  - `docs/ui-patterns.md` — shared UI behavior and interaction models

  - `docs/shared-components.md` — the "what shared component do I use for X?" index; consult **before building any UI element** (reuse is the default; a new one-off requires explicit justification)

- Document the **why** (the design decision and the constraints it's responding to) and the **how at a high level** (the shape of the solution, the contracts it depends on, the alternatives that were rejected and the reason). Do **not** narrate the change itself — phrases like "we now do X", "added Y", "changed Z to W" belong in commit messages and PR descriptions, not in `docs/`. A reader picking up the file a year from now should see the system as it is, not as a sequence of edits.

- After any substantive piece of work — including investigations that produce conclusions — pause and ask: *did this shape the design, settle an open question, or reveal an invariant that wasn't written down?* If yes, update the docs. The check is "did the model shift," not "did the diff touch a particular file."

- Skip doc updates for trivial or localized changes that don't move the high-level model (bug fixes confined to one function, renames, dependency bumps, etc.).

- When you find a doc claim that no longer matches the code, fix the doc — stale docs are worse than missing ones. If the discrepancy reveals a real design question rather than a clean stale-fact, surface it to the user before guessing.

## For Claude / harness-based agents

If you are running with a `CLAUDE.md` (e.g. Claude Code) and haven't read it yet, read it now. It adds a Claude/harness-specific layer on top of this file — the persistent-memory workflow, a consolidated read-first routing index for the `docs/`, and tool conventions. Both files carry the "if you haven't already" guard so this cross-reference can't loop.

Agents without a `CLAUDE.md` can ignore that file: this `AGENTS.md` plus `docs/` are self-contained. In particular the read-first rule above and the `docs/` pointers (commenting style, collaboration notes, ui-patterns, architecture, data-model) are the full set you need to get oriented — `CLAUDE.md` only re-states and consolidates them for the agent whose harness loads it automatically.
