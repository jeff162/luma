# Agent Guidelines

Follow the commenting style defined in `docs/code-commenting-style.md`.

Review `docs/collaboration-notes.md` for project decision-making preferences and collaboration guidance.

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

When working on the codebase:

- Follow the commenting style in `docs/code-commenting-style.md`.

- If your work introduces a system, alters one, shifts an invariant, or settles a design decision that future readers would need to know to understand the code, update the relevant doc in the same change:

  - `docs/architecture.md` — structure, data flow, cross-cutting contracts between subsystems

  - `docs/data-model.md` — data semantics, invariants, what each field means and what it is *not* allowed to mean

  - `docs/ui-patterns.md` — shared UI behavior and interaction models

- Document the **why** (the design decision and the constraints it's responding to) and the **how at a high level** (the shape of the solution, the contracts it depends on, the alternatives that were rejected and the reason). Do **not** narrate the change itself — phrases like "we now do X", "added Y", "changed Z to W" belong in commit messages and PR descriptions, not in `docs/`. A reader picking up the file a year from now should see the system as it is, not as a sequence of edits.

- After any substantive piece of work — including investigations that produce conclusions — pause and ask: *did this shape the design, settle an open question, or reveal an invariant that wasn't written down?* If yes, update the docs. The check is "did the model shift," not "did the diff touch a particular file."

- Skip doc updates for trivial or localized changes that don't move the high-level model (bug fixes confined to one function, renames, dependency bumps, etc.).

- When you find a doc claim that no longer matches the code, fix the doc — stale docs are worse than missing ones. If the discrepancy reveals a real design question rather than a clean stale-fact, surface it to the user before guessing.
