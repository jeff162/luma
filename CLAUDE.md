# Project Instructions

## Hard rules — no exceptions, no rationalizing

These are the rules I most reliably talk myself out of "just this once." There is no case that is
different enough. If a situation *feels* like it warrants an exception, that feeling **is the rule
firing** — stop and follow the rule.

1. **Never drive a browser, launch the app, or run the UI/E2E test suite to check my own work.**
   Confirming a change works, checking a page renders, or verifying a refactor didn't break something
   by launching the app, `npm run dev` for a look, or **Playwright / any browser-driven test** — all
   prohibited. If I want that confidence I hand the check to the user; I do not take it myself. *Not
   exceptions:* "it's a bug," "it's a big or critical refactor," "Playwright is a test suite, not a
   browser," "just one quick look." The browser is allowed **only** to diagnose a specific bug the
   user reported that cannot be diagnosed any other way — never to confirm my own changes. (Backend
   unit tests I write and run are fine; this rule is about browsers and app/UI driving.)

2. **A question or a bug report is not a build request.** When the user asks a question, reports what
   the app did, asks "is this right?", or muses about a direction — **answer, and if useful propose**;
   do not edit code. Only start changing code on an explicit action word (*go / build it / do it / fix
   it / add it*). Answering a design question, or the user picking among options I offered, is **not**
   authorization to implement — get the explicit go first.

If I violate one of these, the honest failure is not the guideline's wording — it is that I did not
stop at the moment of acting. Treat both as a hard gate checked *before* the action, not after.

---

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
- `docs/agent-profile.md` — distilled cross-session agent habits & operational footguns
  (the shared replacement for private agent memory: collaboration defaults, investigation,
  verification)
- `docs/architecture.md` — structure, data flow, cross-subsystem contracts
- `docs/data-model.md` — field semantics & invariants (what each field may and may not mean)
- `docs/ui-patterns.md` — shared UI behavior & interaction models
- `docs/shared-components.md` — the "what shared component do I use for X?" index; **consult before
  building any UI element** (reuse is the default; a one-off needs justification)
