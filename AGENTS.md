# Agent Guidelines

Follow the commenting style defined in `docs/code-commenting-style.md`.

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

## Documentation Consistency

When modifying code:

- Follow the commenting style in `docs/code-commenting-style.md`

- If a change introduces or alters a system, update the relevant documentation:

  - `docs/architecture.md` for structure and data flow

  - `docs/data-model.md` for data semantics or invariants

  - `docs/ui-patterns.md` for shared UI behavior

Do not add documentation for trivial or localized changes.

Keep documentation aligned with the current behavior of the system.

