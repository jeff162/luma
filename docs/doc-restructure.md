# Documentation restructure

**Started 2026-08-26.** Retire the backlog's completed project files by rewriting what they hold into
topic-organized reference docs. This is not backlog — it is committed work in progress, which is why it
lives outside `docs/backlog/` alongside [`pre-release.md`](pre-release.md).

**Delete this file when the last completed project has been disposed.** It is a plan with an expiry
date. Anything in it worth keeping belongs in the topic docs it describes.

**Resumed 2026-09-02.** The gate this was parked behind — [`pre-release.md`](pre-release.md) features
**2** (recurring anomaly signals, 2026-08-27) and **4** (vault recovery, 2026-08-31 / 2026-09-01) —
is met, and feature 4 landing first did what it was meant to: the *recovery and compromise response*
half of category A was written once rather than twice.

**Steps 1 and 2 of the order below are done.** The tail-section shape is settled and recorded in
[`../AGENTS.md`](../AGENTS.md) → *Every topic doc ends with the same three sections*; category **A** is
[`security-model.md`](security-model.md). See the ledger for what that disposed.

The predecessor entry — *Finish the backlog prose pass* in
[`backlog/misc-followups.md`](backlog/misc-followups.md) — is superseded by this file and was struck
there with the first disposal.

---

## Why

The backlog is now larger than the reference docs it feeds: **5,948 lines across 37 files** (36
initiatives plus the index), against 5,381 for all of `docs/*.md` as it stood before this file.
[`backlog/security-and-deployment-model.md`](backlog/security-and-deployment-model.md)
alone is 917 lines — within 8% of [`architecture.md`](architecture.md). A file kept "for the record"
at that size is a second reference doc that no read-first rule points anyone at.

The current policy keeps a completed file alive when it still holds a rejected shape or an obstacle,
and makes it reachable by a link from the main doc. Two things are wrong with that:

- **Links to project files decay, and one already had.** `backend/routers/sync.py` and
  `backend/db/database.py` both cited `docs/backlog/sync-import-records-and-dedupe.md`, which does not
  exist — the dead pointers were dropped with the first disposal, the rule they named kept inline.
  Three backlog files have been deleted across history. Topic docs are stable; project filenames are
  transient by construction.
- **A project file is organized around a project, and topics cross them.**
  [`backlog/ofx-direct-connect.md`](backlog/ofx-direct-connect.md) contains a section headed *"The
  threat-model consequence — read this first"* — a security rule, filed under a parked protocol nobody
  is implementing, unreachable from any reading of the security model. Meanwhile
  `security-and-deployment-model.md` holds at least four distinct topics, and three separate files feed
  the deployment one.

Neither direction is one-to-one. One project generates several topics; one topic is fed by several
projects.

## The rules

**1. Route by question, not by project.** A topic answers a question someone actually arrives with.
[`building-a-connector.md`](building-a-connector.md) is the reference shape already in the tree: its
sections are the questions an adapter author hits — ids must be globally unique, zero-amount rows,
dates a source does not have, request budgets, what a failure costs — and not one is named after a
project or a feature.

**2. Keep behavioral facts; cut the case for the design.** The sharper of the two filters, and the one
that does the most work. A *behavioral fact* is something a reader could get wrong in a way that
produces bad data or a bad change: *mortgages and monthly auto-payments are recurring series, not
multi-payment purchases*; *splits and multi-payment compose — a deposit can itself be split*. A
*justification* argues that the chosen design was correct: *the categorization is already right*;
*tags don't solve it because a tag doesn't divide the amount*. Nothing follows from a justification
once the work has landed. Cut it.

**3. Keep what a reader could re-propose; cut what could not occur to anyone.** The existing filter
from [`backlog/README.md`](backlog/README.md). It catches rejected alternatives, which rule 2 does not
— the two piles are different.

**4. Keep obstacles that would bite a second attempt.** The four blocking `ImportRuleSuggestionReview`;
rotation crossing two databases; a restore leaving a cursor ahead of the ledger.

**5. Cut the work log.** The narrative of arriving at the current state — an expectation that turned
out wrong, discovery order, what a testing pass revealed, which symptom looked like another bug first.

**6. Relocate rather than delete when the fact is load-bearing but misfiled.** The half most easily
skipped. `security-and-deployment-model.md`'s ~230 lines of `[DONE]` build phases are not purely a work
log — migration numbers, AAD schemes, endpoint names and payload-format versions are mixed in, and
those read as `architecture.md` material. Roughly twenty verifications, where a wrong call deletes the
only record of something like *migration v18 folds `plaid_item` rows in carrying the ciphertext
verbatim*.

**7. Every topic ends with the same three sections.** This is what lets a project file die, and it is
the structural change the taxonomy depends on. No current doc has anywhere to put:

- **Considered and rejected** — with the reason, so it is not re-proposed.
- **Obstacles** — what a second attempt hits.
- **Open** — decisions owed, naming the live backlog items that will feed this topic.

Code comments cite `docs/<topic>.md#considered-and-rejected`, never a project filename.

**8. Pending projects are surveyed but not ingested.** A pending file stays a project file. Its topic
is recorded in the routing table below so the slot exists, and the topic's *Open* section names it.
The link runs from the stable doc to the transient one, and the disposal ritual updates it.

**9. Partly-shipped files are a judgment call, not a rule.** Ingest the shipped half where that is
most useful — several of these files are mostly settled and become legible once the settled part
leaves. Where the halves are entangled, leave it whole.

## Categories

Committed: A–E. File granularity — a chapter in an existing doc versus its own file with an index
entry — is a mechanical question and is decided per topic when it is written, not here.

### A. Security model *(new)*

**[Written 2026-09-02 as [`security-model.md`](security-model.md).]** There was no threat model in the
main docs at all; it existed only in a backlog file. `architecture.md` → *Identity, access & deployment
model* and *Token vault & transport security* carry a thorough summary of the settled shape, but the
assumptions it rests on were not in the reference layer. (Cite these by heading — the line numbers this
survey originally used have all moved.)

This is the **maintainer** record, not a public-facing document — `README.md` §Security and
`SECURITY.md` are the public surfaces and already exist. Three surfaces now describe security, so A
must state what they summarize without restating it, and should link rather than duplicate. The
`security-and-deployment-model.md` section headed *Docs to write* is the existing note about that
overlap and gets settled here.

Topics: threat model and what is deliberately *not* defended (the plaintext ledger, no DB-file
encryption) · the read-only/revocable conditioning and how a provider may fail either clause
independently · identity and the network perimeter (login is authentication, not authorization; admin
gates settings not data) · secret custody (workspace DEK, keypair slots, unlock methods, no escrow) ·
enrollment, revocation and rotation · transport security per topology · secrets in backup and export ·
recovery and compromise response.

### B. Deployment, packaging & operations *(new)*

**[Written 2026-09-02 as [`operations.md`](operations.md) — and the open decision below is settled: B
*is* two topics, and one of them already existed.]** [`releasing.md`](releasing.md) was already a
question-organized maintainer doc owning building, the two distribution forms, macOS signing, CI and the
release checklist. Duplicating that into a new file would have created exactly the drift these rules
exist to prevent, so B became the **running** half only: the shapes, binds, data location, restore as a
destructive operation, and diagnosis. The survey's "four files" also missed a third live topology —
`docker-compose.yml` — which `operations.md` now covers.

One audience — someone installing, running, packaging, or diagnosing — was reading four files.

Topics: the two shapes and why topology is detected rather than chosen · what each server binds to and
why · distribution forms (the rule is per-form, not per-OS) and the data-directory resolution · the
Python version ceiling and what lifting it costs · macOS specifics (signing, quarantine, the native
wrapper, the Dock lifecycle) · configuration layers and the irreducible env core · release and CI ·
database diagnostics and what a structural check does not cover · restore as a destructive operation.

### C. Scale, limits & behavior at volume *(new)*

The unifying question — *what breaks at volume, what did we cap, and what did we deliberately accept*
— has no home today. It spans UI, API and DB, which is why it fell between the existing docs.

Topics: render windowing (content-independent column geometry; no row-id helpers that scan; no
`content-visibility` on a windowed row; the one list left unwindowed and its four obstacles) · fetch
limits and the `limit` contract, including the caps that remain on purpose · import-history retention ·
memory profile of backup and restore, and why bounded memory requires that rows never accumulate as
lists · database concurrency · provider request budgets · frontend cache invalidation.

### D. Testing & verification *(extend `CONTRIBUTING.md`)*

CONTRIBUTING covers *how to run* the suites. Nothing covers *what is tested, what isn't, and why*.

Topics: the vitest/Playwright boundary — currently stated only in `CLAUDE.md`, `AGENTS.md` and a vite
config comment · known coverage gaps and why each is open · migration and fresh-schema parity · lint
strictness posture (enable, measure, triage, then gate) · what a unit runner structurally cannot reach
(a chart cannot be rendered under it; an adapter's transport needs a test that inspects the wire).

### E. Mechanism index *(new — a lookup table, not prose)*

Built like [`shared-components.md`](shared-components.md), which is the same idea for UI and which
`CLAUDE.md` already tells everyone to consult before building an element. There is no domain-model
equivalent, which is why one was hand-rolled inside a project file.

**Inclusion test: has this pair actually been confused, or could it plausibly be, in a way that puts
wrong data in the ledger?** Splits versus multi-payment passes. Tags versus splits does not.

Rows: splits (one payment → N categories) · multi-payment purchase (N payments → one purchase; they
compose) · recurring series (an open-ended cadence — a mortgage is this, not a purchase) · reimbursable
(an offset crossing a period boundary) · `txn_link` as the general association primitive · transfer and
`exclude_from_totals` treatment.

### Existing docs

`architecture.md`, `data-model.md`, `ui-patterns.md`, `shared-components.md`,
`building-a-connector.md`, `import-reconciliation-playbook.md` all keep their questions. Two
observations from the survey:

- **`architecture.md`'s "Major subsystems" is doing two jobs.** It holds feature subsystems
  (transactions, rules, tags, recurring, import, detail panels) that correctly answer *where does this
  live* — and cross-cutting topics filed there for lack of anywhere else: Configuration layers,
  Identity/access, Token vault/transport, Database concurrency, Storage layers. Those five are roughly
  half the file. They move to A, B and C — though A deliberately left the *mechanism* halves of
  Identity/access and Token vault where they are, taking only the assumptions beneath them.
- **`ui-patterns.md` mixes element-level and system-level topics**, and *"Import-specific patterns"*
  (94 lines) is a feature-named section inside a question-organized doc. Reorganized by question:
  product intent and the polish bar · page and region structure · disclosure and navigation · editing
  in place · selection and input · states (empty, loading, first paint) · confirmation and destructive
  actions · guidance and help · **charts and visualization** · theming · density and volume (→ C) ·
  time and formatting display.

  Charts is the largest single gap and mostly still lives in `backlog/dashboard-reporting.md`: outlier
  clamping against a percentile rather than the next-largest value · axis pinning and tick collision ·
  `stackOffset="sign"` and the negation it depends on · explicit sizing rather than
  `ResponsiveContainer` when the bucket set changes · scroll anchoring and re-centring · the
  named-slice floor · **magnitude drives geometry, the label carries the truth**. Most carry an
  explicit *don't re-propose* or *don't remove*.

## Routing table

Disposition: **Ingest** (fully disposable) · **Split** (ingest the settled half, keep the remainder) ·
**Survey** (pending; slot recorded, file stays).

| File | Disposition | Topics |
| --- | --- | --- |
| `security-and-deployment-model.md` | ✅ Ingested 2026-09-02 | **A** (all), **B** (topology, transport) · **residual stub kept**: build-phase technical detail still awaiting relocation to architecture |
| ~~`pre-auth-security-ui.md`~~ | ✅ Ingested 2026-09-02, deleted | **A** (identity/perimeter surfaces) |
| ~~`optional-env-and-layered-config.md`~~ | ✅ Ingested 2026-09-02, deleted | **B** (config layers, env core), **A** (`.env` provider retirement); mechanism was already in architecture |
| `list-virtualization.md` | Ingest | **C** (windowing rules, the unwindowed case and its obstacles) |
| `i18n-display-formatting.md` | Split | data-model (one ledger currency; why currency is not `ui_preference` and a date format is), ui-patterns (formatting) · *open:* number/date half |
| `account-type-as-rule-criterion.md` | Split | data-model (account type as rule scope, precedence, matcher identity) · *open:* filtering/search, the query grammar |
| `deployment-topologies.md` | ✅ Split 2026-09-02 (300 → 57) | **B** (nearly all), **A** (passkeys make the host name load-bearing), releasing (macOS/build detail) · *file keeps:* Shape A, Shape B step 3's remainder |
| `backup-restore-scope-and-secrets.md` | Split | data-model (Backups), **A** (secrets custody, risk model, slot policy), **B** (restore semantics, identity reconciliation), **C** (streaming, memory) · *open:* sectioned artifact, `backup_recipient`, incremental chain |
| `dashboard-reporting.md` | Split | ui-patterns (**charts** — the bulk), data-model (reporting semantics, cash-flow exclusion) · *open:* `cash_date`, trend bucketing, Trends-tab audit |
| `transaction-attachments.md` | Split | data-model (documents), ui-patterns, **B** (documents phase of restore) · *open:* tiers 2–3 |
| `transaction-splits.md` | Ingest | data-model, ui-patterns, **E** |
| `multi-payment-purchases.md` | Ingest | data-model, ui-patterns, **E** |
| `paypal-amazon-enrichment.md` | Split | data-model (enrichment, evidence capture, `txn_link`), building-a-connector · *open:* AZAD ingestion, column-centric mapping |
| `paypal-money-movement-recognition.md` | Split | data-model (rules) · *open:* fold into the generic suggester |
| `recurring-detection.md` | Split | data-model (recurring series, scoped scan) · *open:* anomaly/forecast, fixed-vs-variable |
| `import-input-formats.md` | Split | building-a-connector (the three seam gaps, published request budgets, trust the server over the guide) · *open:* XLSX, OFX file import |
| `import-history-windowing.md` | Split | **C** (retention), ui-patterns (import history) · *open:* archive UX |
| `tag-report-exclude-warning.md` | Split | ui-patterns (report conflict notes) · *open:* include narrowing |
| `transaction-list-limits.md` | Ingest | **C** (limits, accepted tradeoffs), data-model (the `limit` contract) |
| `refactor-audits.md` | Split | **D** (audit method, rule of three, divergence risk) · *recurring process, file stays* |
| `cleanup-pass.md` | Split | ui-patterns (tooltip migration, press-scoped labels), **D** (console cleanliness, dead code) |
| `import-dedupe-followups.md` | Survey | data-model (dedupe tiers, the re-measurement method) |
| `ofx-direct-connect.md` | Survey · **A-slice relocated 2026-09-02** | **A** (the threat-model consequence — the *rule* moved, the OFX-specific facts stayed and now point at it), building-a-connector |
| `database-diagnostics.md` | Survey · **B slot filled 2026-09-02** | **B** (what a structural check does *not* cover — recorded in B's *Obstacles*; the build itself is B's *Open*), data-model (the invariants a checker would assert) |
| `vault-passphrase-recovery.md` | Split · **A-slice ingested 2026-09-02** | **A** (recovery, reset as compromise response — done; it completed 2026-09-01, so rule 8 no longer applied) · *file kept* for its two reversals and one owed test |
| `reimbursable-expenses.md` | Survey | data-model, **E** |
| `test-coverage-gaps.md` | Survey | **D** |
| `lint-and-tooling.md` | Survey | **D** |
| `query-cache-invalidation.md` | Survey | **C**, architecture (frontend data flow) |
| `online-categorizer.md` | Survey | data-model (the rule is the cache) |
| `merchant-rename-fate.md` | Survey | data-model (rules/`clean_name`) — a keep-or-drop decision, not a doc |
| `import-rule-suggestion-review-extraction.md` | Survey | — a code task with no doc home |
| `button-consolidation.md` | Survey | ui-patterns (design system) |
| `saved-tag-reports.md` | Survey | ui-patterns (reporting) |
| `help-topic-search.md` | Survey | ui-patterns (help) |
| `misc-followups.md` | Split · **prose-pass entry struck 2026-09-02** | scattered; the *backlog prose pass* entry is superseded by this file |
| `README.md` | Rewrite last | the policy above replaces its keep-and-link rule |

## Order

1. ~~**Settle the tail-section shape** (rule 7) by writing it once, in whichever topic goes first.~~
   **Done 2026-09-02** — settled in A and written up in [`../AGENTS.md`](../AGENTS.md) under
   *Documentation Consistency*, so it binds every future topic rather than living only as an example.
2. ~~**A — Security model.**~~ **Done 2026-09-02** — [`security-model.md`](security-model.md).
3. ~~**B — Deployment & operations.**~~ **Done 2026-09-02** — [`operations.md`](operations.md), the
   running half; [`releasing.md`](releasing.md) keeps the building half.
4. **ui-patterns charts topic.** Largest single body of homeless material outside A and B.
5. **C — Scale & limits.**
6. **E — Mechanism index.** Small; cheap once splits and multi-payment are ingested.
7. **D — Testing**, into CONTRIBUTING.
8. **Rewrite `backlog/README.md`**, replacing the Completed section with the ledger below.

## Ledger

Replaces *Completed (kept for the record)*. A row per disposed project, so "disposed" is
distinguishable from "nobody got to it yet". **A file is kept only if some topic's tail links to it** —
reachability from a chronological record is not reachability, and `CHANGELOG.md` cannot serve: it holds
zero backlog references and starts at 0.20, so it cannot point at anything completed before the first
public release.

A disposed project keeps its row permanently. Besides telling *disposed* apart from *not yet reached*,
the row is a thread to pull on: the path is what makes `git log -- <path>` find the last version of a
file that no longer exists, so the entry records the path rather than a project name.

| Path | Disposed | Fed | File kept? |
| --- | --- | --- | --- |
| `docs/backlog/security-and-deployment-model.md` | 2026-09-02 | **A** (`security-model.md`) — threat model, perimeter, custody, enrollment/rotation, transport, all rejected shapes | **Partly** — reduced 917 → ~250 lines. The build-phase log stays until its facts are relocated to `architecture.md`; that pass is the open decision below. Cited from code by phase number (`database.py`, `providers/config.py`, `routers/providers.py`) |
| `docs/backlog/pre-auth-security-ui.md` | 2026-09-02 | **A** (identity & the network perimeter) | **No** — deleted. Past the shipped Settings forms it was a work log of what a lint cleanup had removed |
| `docs/backlog/optional-env-and-layered-config.md` | 2026-09-02 | **B** (`operations.md`) — layer order, env core, per-file overrides, rejected alternatives; **A** — why app credentials left `.env` | **No** — deleted. The mechanism was already in `architecture.md` → *Configuration layers*; its one unbuilt follow-up (mDNS) moved to B's *Open* |
| `docs/backlog/deployment-topologies.md` | 2026-09-02 (partial) | **B** (`operations.md`) — shapes, binds, data location, rejected shell/packaging options; **A** — the host-name constraint; `releasing.md` — macOS build detail | **Yes**, 300 → 57 — Shape A is unbuilt and Shape B step 3 has a remainder CI cannot reach. Cited from `backend/desktop.py`, repointed to `operations.md` |

## Open decisions

Expected to fall out of writing the sections they belong to, rather than needing an answer first.

- **Where the `security-and-deployment-model.md` build phases land.** Still open after A. Relocation to
  `architecture.md` is the likely answer, but each of ~20 facts needs checking against what
  `architecture.md` already says. Its own pass, not the tail end of another — and it is now the *only*
  thing keeping that file alive. Note that several code comments cite it **by phase number**
  (`database.py` migrations v18/v20, `providers/config.py`, `routers/providers.py`), so the pass has to
  repoint them rather than merely move the prose.
- ~~**Whether B splits into two topics**~~ — **settled 2026-09-02: yes, and the packaging half already
  existed.** `releasing.md` covers building and distributing to a standard that would only have been
  damaged by a second copy, so B was written as the running half alone and links across. The audiences
  do overlap; the questions do not, and the split falls on *do I need a build?* — nothing in
  `operations.md` does, nothing in `releasing.md` is needed to run one.

## Costs the survey did not price

Found while doing A; they apply to every remaining category.

- **Ingesting a file drags its code citations with it.** Roughly two dozen `docs/backlog/...` references
  live in backend and frontend source. Rule 7 says a comment cites a topic anchor, so each *Ingest* row
  carries a repointing task the routing table does not name. A also showed the softer case: a citation
  that names a **phase number** rather than a model claim is still correct against a residual stub, and
  should be left alone rather than force-fitted to a topic doc.
- **Some "Survey" rows have gone stale in the right direction.** Rule 8 keeps a *pending* file whole,
  but two of the surveyed files completed after 2026-08-26. Re-check a row's status before honoring its
  disposition — `vault-passphrase-recovery.md` moved from Survey to Split on those grounds.
- **Deleting a file means finding every mention of it, not just the code ones.** `pre-auth-security-ui.md`
  was referenced from three other markdown files. Grep the whole tree, and expect the backlog index and a
  sibling project file to be among the hits.
