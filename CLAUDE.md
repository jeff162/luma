# Project Instructions

Read `AGENTS.md` first if you haven't already — it is the shared, open-standard instruction
file for every agent on this repo; this file only adds the Claude/harness-specific layer on
top of it (`AGENTS.md` points back here with the same "if you haven't already" guard, so the
cross-reference can't loop). Where this file and `AGENTS.md` overlap they are meant to agree; if
they ever seem to conflict, follow the stricter statement and surface the discrepancy rather than
acting on the looser one. The record of what the system *is* and *why* lives in `docs/`.

**Read-first rule.** Before working on *or answering questions about* shared systems,
persistence, invariants, imports/dedupe, or shared UI, read the relevant doc below first.
Investigations and "I'm only answering a question" are not exemptions — reconstructing the
model from source wastes time and misses the *why*. Use source reading and DB queries to
*verify* the docs (and fix them if stale) and to answer live-data questions the docs can't,
not as the first resort.

**Quality bar.** Before any non-trivial change, the working habits and decision principles in
`docs/collaboration-notes.md` apply — the standard is first-class code conforming to accepted
best practice, not just something that works. When doing it right reveals a needed refactor or
a real tradeoff, surface it for a decision rather than silently working around it or silently
expanding scope.

**Git snapshot is stale.** The harness injects a git status / recent-commits block at session
start; the user commits between and during sessions, so that block can be out of date by the time
you read it. Run `git status` / `git log` and report from that — never describe working-tree or
branch state from the injected snapshot.

**Where things live:**

- `AGENTS.md` — conventions, commenting style, doc-consistency rules
- `docs/collaboration-notes.md` — decision principles & agent working habits (get it right
  the first time; reuse shared components; reference implementations)
- `docs/architecture.md` — structure, data flow, cross-subsystem contracts
- `docs/data-model.md` — field semantics & invariants (what each field may and may not mean)
- `docs/ui-patterns.md` — shared UI behavior & interaction models
