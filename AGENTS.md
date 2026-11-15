# Agent Guidelines

## Hard rule — no exceptions, no rationalizing

The rule an agent most reliably talks itself out of "just this once." There is no case different
enough. If a situation *feels* like it warrants an exception, that feeling **is the rule firing** —
stop and follow the rule. Check it *before* acting, not after.

**A question or a bug report is not a build request.** When the user asks a question, reports what
the app did, asks "is this right?", or muses about a direction — answer and, if useful, propose; do
not edit code. Start changing code only on an explicit action word (*go / build it / do it / fix it
/ add it*). Answering a design question, or the user picking among options you offered, is not
authorization to implement.

Follow the commenting style defined in `docs/code-commenting-style.md`.

Before any non-trivial change, read `docs/collaboration-notes.md` for the project's decision principles. The bar is first-class code conforming to accepted best practice, not just something that works; when getting it right reveals a needed refactor or a real tradeoff, surface it for a decision rather than silently working around it or expanding scope.

For workflow changes that touch generated state, persisted review state, imports, rules, categorization, or undo/return paths, follow the design-pass guidance in `docs/collaboration-notes.md` before implementation: map affected surfaces and lifecycle states first, then code.

Before building or changing shared UI, read `docs/ui-patterns.md` for the conventions that apply across surfaces. It does not specify any one surface: what a page, dialog or card looks like is the code's to say and is free to change, so the document is never a reason not to change one. Update it only when a convention itself changes. An entry can be too narrow or simply describe what the code did; when a fix shows that, update the entry as part of the fix.

Before working on anything that touches provider credentials, the login perimeter, transport, or backups — including adding a data source — read `docs/security-model.md` first. It carries the assumptions the design rests on and the conditions under which one has to be reopened; `architecture.md` carries only the mechanism, which is not enough to tell whether a change is safe.

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

- Structural or UI narration (e.g. "Render", "Header")

## General

- If unsure whether a comment adds value, skip it

- Prefer consistency with existing patterns in the codebase

- Do not modify working logic unless explicitly requested

## License Headers

The repo carries REUSE-style per-file SPDX headers (`SPDX-FileCopyrightText` plus
`SPDX-License-Identifier: AGPL-3.0-or-later`) at the very top of a file.

- Add the header to **substantive source** — files that carry real application logic worth licensing

- Omit it on tests, scripts, and configuration: there is nothing meaningful to copyright in scaffolding, and the boilerplate is noise

- The tree is currently consistent with this: no test, script, or config file carries a header. Keep it that way — do not add one to a new test just because older code elsewhere has it

- Third-party material keeps its own holder and license in its header, not the project's (`frontend/src/lib/effLargeWordlist.txt` is `CC-BY-4.0`). A build ships every such notice in a generated `THIRD-PARTY-LICENSES.txt` and the About page links it — see `docs/releasing.md` → *What the kit carries besides the program*

## Local Scratch Files

- Use `data/` for local helper scripts, screenshots, notes, temporary test artifacts, and other scratch files that should not be committed

- Prefer `data/` over tracked project directories for one-off debugging utilities or local workflow helpers

- For UI debugging, use `data/ui/` for browser helpers and `data/ui/artifacts/` for screenshots or other captured output

## Documentation Consistency

The `docs/` directory captures the **intent** of the system: what it does, **why** it works the way it does, and **how the pieces fit together at a high level**. Git history records what changed; `docs/` records what the system *is* and *why*. Keep them in sync.

**Overlap and precedence.** Some rules are intentionally stated in more than one place — most notably, `CLAUDE.md` and this file both carry the read-first rule and the quality bar so that each entry point is self-sufficient (an agent that reads only one of them still gets the rule). These copies are meant to agree. If two statements ever appear to conflict, follow the **stricter** one and surface the discrepancy to the user to reconcile — do not act on the looser reading, and do not silently rewrite one to match the other. This keeps intentional duplication safe and turns drift into a flagged question instead of a silent regression. The same rule applies to any apparent inconsistency between docs, code comments, and these instruction files.

**Guidance carries its reason.** A rule in any of these files states the goal it serves ("do X, because Y") rather than standing as a bare command. The reason lets a reader recognise a case it doesn't cover, where departing from the rule may be right, and it keeps a rule from becoming stronger than it was meant to be. The few absolute rules, such as the hard rule in `CLAUDE.md`, say so explicitly.

When working on the codebase:

- A change is finished only when every description of what it touched is still true — code comments, the in-app help (`frontend/src/help/content.jsx`), the README and the docs below. Update them in the same change.

- Follow the commenting style in `docs/code-commenting-style.md`.

- If your work introduces a system, alters one, shifts an invariant, or settles a design decision that future readers would need to know to understand the code, update the relevant doc in the same change:

  - `docs/architecture.md` — structure, data flow, cross-cutting contracts between subsystems

  - `docs/data-model.md` — data semantics, invariants, what each field means and what it is *not* allowed to mean

  - `docs/security-model.md` — the assumptions the security design rests on: what is defended and what deliberately is not, the conditions under which a decision has to be reopened, transport per topology, and secrets in backup. The mechanism as built stays in `architecture.md`

  - `docs/operations.md` — running an instance: the topologies and what each binds to, where data lives and which settings come only from the environment, restore as a destructive operation, and diagnosing. Building the artifacts is `docs/releasing.md`; the mechanism is `architecture.md`

  - `docs/scale-and-limits.md` — what breaks at volume and what was capped on purpose: fetch limits and the accepted tradeoffs, render windowing and the one list left out of it, import-history retention, and why a bulk operation must never accumulate a whole dataset

  - `docs/building-a-connector.md` — adding a data source (provider adapter or file importer): the capability declarations, and the checklist of traits that turned out to be one provider's rather than universal

  - `docs/ui-patterns.md` — UI conventions shared across surfaces (not a description of any one surface)

  - `docs/mechanism-index.md` — the "which mechanism is this?" domain lookup; consult **before recording a relationship between transactions**, or building anything that groups, divides, offsets or hides money. Several of these look alike and are not interchangeable; the wrong one fails quietly rather than loudly

  - `docs/shared-components.md` — the "what shared component do I use for X?" index; consult **before building any UI element** (reuse is the default; a new one-off requires explicit justification)

- Document the **why** (the design decision and the constraints it's responding to) and the **how at a high level** (the shape of the solution and the contracts it depends on). Do **not** record the alternatives that were turned down or the bug that led to a rule, and do **not** narrate the change itself — phrases like "we now do X", "added Y", "changed Z to W" belong in commit messages and PR descriptions, not in `docs/`. A reader picking up the file a year from now should see the system as it is, not as a sequence of edits.

- After any substantive piece of work — including investigations that produce conclusions — pause and ask: *did this shape the design, settle an open question, or reveal an invariant that wasn't written down?* If yes, update the docs. The check is "did the model shift," not "did the diff touch a particular file."

- `CLAUDE.md` is loaded into every session, so it stays a routing map: the read-first trigger and one
  line per doc naming its scope. Rules and their reasons live here and in `docs/`, never copied into it.

- Skip doc updates for trivial or localized changes that don't move the high-level model (bug fixes confined to one function, renames, dependency bumps, etc.).

- **Cite a constant; never transcribe its value.** A number copied into prose — a schema version, a
  payload version, a threshold, a timeout — is a second copy that nothing updates and no test guards, and
  it goes stale at the next change to the real one. Name the constant (`CURRENT_VERSION`,
  `BULK_CONFIRM_THRESHOLD`) and let the reader look. Where the value genuinely has to appear (user-facing
  copy, a worked example), say where the authoritative one lives in the same breath.

- When you find a doc claim that no longer matches the code, fix the doc — stale docs are worse than missing ones. If the discrepancy reveals a real design question rather than a clean stale-fact, surface it to the user before guessing.

### Obstacles and owed decisions

A reference doc describes the system as it is and the reason for each design choice. **It does not record what was considered and rejected** — not inline, and not in a section of its own — because such an entry is rarely in front of anyone when it would help, the few useful ones are buried by the rest, and git history keeps them all. State the reason beside the design instead ("scanning is request-driven because there is no tenant for a timer to run as"), and where code would look wrong without the explanation, put a comment at that site.

Two kinds of fact still need a home, and where they go depends on which of two shapes the doc is.

**A topic doc answers one question** (`security-model.md`, `operations.md`, `releasing.md`, `building-a-connector.md`, `scale-and-limits.md`). It ends with both sections below.

**A multi-topic reference doc collects many** (`data-model.md`, `architecture.md`). There, an **obstacle stays inline, beside the subject it is about**, and the doc carries **only an `## Open` section**, because a decision still owed has no natural inline home and it is the link that keeps a pending backlog item reachable. Code cites these by section name (`docs/data-model.md` → *Reporting assumptions*).

`ui-patterns.md` is neither shape. It holds conventions only: no history and no `## Open` section. Its closing section, *What belongs here*, is the test for adding to it. `shared-components.md` is its sibling, an index: one line per shared component, with the same closing test. How a component works goes in that component's header comment.

The two sections, in a topic doc:

- **`## Obstacles`** — what a second attempt actually hits: a constraint that makes the obvious approach fail, an ordering that cannot be violated, a seam with no atomicity. These apply whether or not the work is planned, which is why they are separated from *Open*.
- **`## Open`** — decisions still owed, each naming the **live backlog item** that will feed this topic when it is picked up. This is the link from the stable doc to the transient one: a pending project stays a project file, and its slot here is what keeps it reachable.

Two rules make these load-bearing rather than decorative:

- **Cut the work log.** The narrative of arriving at the current state — an expectation that turned out wrong, discovery order, what a testing pass revealed, which symptom looked like another bug first — goes in neither the body nor the tail. Git history holds it.
- **Code comments cite a stable doc location, never a project filename:** `docs/<doc>.md` → *Section name*. Backlog filenames are transient by construction and links to them decay. When a project file is deleted, repoint its code citations in the same change.

## For Claude / harness-based agents

If you are running with a `CLAUDE.md` (e.g. Claude Code) and haven't read it yet, read it now. It adds a Claude/harness-specific layer on top of this file — the persistent-memory workflow, a consolidated read-first routing index for the `docs/`, and tool conventions. Both files carry the "if you haven't already" guard so this cross-reference can't loop.

Agents without a `CLAUDE.md` can ignore that file: this `AGENTS.md` plus `docs/` are self-contained. In particular the read-first rule above and the `docs/` pointers (commenting style, collaboration notes, ui-patterns, architecture, data-model) are the full set you need to get oriented — `CLAUDE.md` only re-states and consolidates them for the agent whose harness loads it automatically.
