# Project Instructions

## Hard rule — no exceptions, no rationalizing

This is the rule I most reliably talk myself out of "just this once." There is no case that is
different enough. If a situation *feels* like it warrants an exception, that feeling **is the rule
firing** — stop and follow the rule.

**A question or a bug report is not a build request.** When the user asks a question, reports what
the app did, asks "is this right?", or muses about a direction — **answer, and if useful propose**;
do not edit code. Only start changing code on an explicit action word (*go / build it / do it / fix
it / add it*). Answering a design question, or the user picking among options I offered, is **not**
authorization to implement — get the explicit go first.

If I violate it, the honest failure is not the guideline's wording — it is that I did not stop at the
moment of acting. Treat it as a hard gate checked *before* the action, not after.

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

**Quality bar.** Before any non-trivial change, the decision principles in
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
- `docs/collaboration-notes.md` — the decision principles behind implementation choices (get it
  right the first time; the design pass; what earns a test; naming hygiene)
- `docs/agent-profile.md` — distilled cross-session agent habits & operational footguns
  (the shared replacement for private agent memory: collaboration defaults, investigation,
  verification)
- `docs/transient-failures.md` — the register of intermittent test failures that are instrumented but
  not yet understood; **check it before concluding anything about a red run**, since these fire in
  several different specs and the failing test's name does not identify which one it is
- `docs/architecture.md` — structure, data flow, cross-subsystem contracts
- `docs/data-model.md` — field semantics & invariants (what each field may and may not mean)
- `docs/security-model.md` — what is defended and what deliberately is not; the revocation
  conditioning a new provider can break, secret custody, transport per topology, recovery &
  compromise response (the *mechanism* stays in `architecture.md`)
- `docs/operations.md` — running an instance: the topologies and what each binds to, where the
  data lives & the env core, restore as a destructive operation, diagnosing (building is
  `docs/releasing.md`)
- `docs/scale-and-limits.md` — what breaks at volume: the caps that exist on purpose & what each
  costs, the one list left unwindowed, import-history retention, why bulk operations must not
  accumulate
- `docs/building-a-connector.md` — adding a data source (provider adapter or file importer):
  capability declarations & the traits that turned out to be Plaid-specific
- `docs/ui-patterns.md` — UI conventions shared across surfaces. It does not describe or specify any one
  surface, so it is never a reason not to change one; update it only when a convention itself changes
- `docs/import-reconciliation-playbook.md` — the *user-facing* "situation → which tool" guide, and the
  **content source of truth** for the in-app help topics; changing an import or reconciliation tool means
  updating this first, then reconciling the help topic against it
- `docs/mechanism-index.md` — the "which mechanism is this?" domain lookup; **consult before recording
  a relationship between transactions** (splits vs multi-payment vs recurring vs reimbursable vs
  `txn_link` vs `exclude_from_totals`) — picking wrong puts bad data in the ledger quietly
- `docs/shared-components.md` — the "what shared component do I use for X?" index; **consult before
  building any UI element** (reuse is the default; a one-off needs justification)

**What is being worked on right now** is a different kind of document from the reference docs above,
and lives in `docs/pre-release.md` — the committed, blocking plan for making the repository public, with
the scope boundary for each item (several name only *part* of their backlog file) and the decisions still
owed. Read it before picking up work, and prefer it over `docs/backlog/` for what to do next: the backlog
is parked work, this is not. **It is self-deleting** — it says to remove it once the release ships, so its
absence means that happened, not that it was lost.

**When a shipped backlog item is disposed of**, the ritual is stated in `docs/backlog/README.md`: fold the
durable half into the topic doc that owns the question, repoint the code citations off the project
filename, and record the path in that file's *Ledger*.
