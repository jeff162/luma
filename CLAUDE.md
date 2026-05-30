# Project Instructions

`AGENTS.md` is the repo-wide conventions/architecture index — read it. The record of what
the system *is* and *why* lives in `docs/`.

**Read-first rule.** Before working on *or answering questions about* shared systems,
persistence, invariants, imports/dedupe, or shared UI, read the relevant doc below first.
Investigations and "I'm only answering a question" are not exemptions — reconstructing the
model from source wastes time and misses the *why*. Use source reading and DB queries to
*verify* the docs (and fix them if stale) and to answer live-data questions the docs can't,
not as the first resort.

**Where things live:**

- `AGENTS.md` — conventions, commenting style, doc-consistency rules
- `docs/collaboration-notes.md` — decision principles & agent working habits (get it right
  the first time; reuse shared components; reference implementations)
- `docs/architecture.md` — structure, data flow, cross-subsystem contracts
- `docs/data-model.md` — field semantics & invariants (what each field may and may not mean)
- `docs/ui-patterns.md` — shared UI behavior & interaction models
