# Backlog

Deferred and parked work that is **not** blocking current features. Each file is one initiative,
written so it can be picked up cold.

**When an item ships, the file is retired rather than kept.** Fold its durable "what it is and why"
into the topic docs — those are what the read-first rule makes someone open, so that is where a rule
has to live to be found — and then **delete the project file and record it in the [Ledger](#ledger)
below**. A file survives only where some topic's *Open* section still points at it for work that has
not started.

This replaced a keep-and-link policy, and the reason is worth stating because the old one looked
safer: **a link to a project filename decays.** Two code comments already cited a backlog file that no
longer existed. Project filenames are transient by construction; topic docs are stable, so a code
comment cites `docs/<topic>.md#considered-and-rejected` — or, for a multi-topic reference doc,
`docs/<doc>.md` → *Section name* — and never a path under here. When a file is disposed of, repoint its
citations in the same change.

**What the topic docs should not carry is the record of what was deliberately *not* done** — the
obstacles, the rejected shapes, the "don't redo this" notes. Those answer a question nobody asks until
they are already proposing the thing, so a doc read never surfaces them. They now have somewhere to go:
see `AGENTS.md` → *Where rejections, obstacles and owed decisions go*, which says a single-question
topic doc ends with **Considered and rejected / Obstacles / Open**, while a multi-topic reference doc
keeps rejections inline beside their subject and carries only **Open**. The other half stays
load-bearing: the **code carries the decision at the site** — the header comment on
`ImportRuleSuggestionReview.jsx` fires exactly when someone thinks "this list should be windowed",
which no document could.

**UI material goes to `ui-patterns.md` only as a convention.** A rule that applies across surfaces and
tells someone how to build the next one belongs there. How one surface works, and what was tried on the
way to it, does not: the code states the first, and the second is kept only as a comment at the site
where the code would otherwise look wrong.

**A rejected shape is not a work log, and only one of them belongs anywhere.** A *rejected shape*
answers a question someone is about to ask again — what was considered, why it fails, what it would
cost to revisit. An *obstacle* is a trap that would bite a second attempt. Both earn their space. What
does not is the narrative of arriving at the current state: an expectation that turned out wrong, the
order in which things were discovered, what a testing pass revealed, which symptom looked like a
different bug first. Nothing follows from any of it once the work has landed, and it buries the notes
that do matter. Four tests, all cheap to apply:

- **Could a reader re-propose this?** If yes, keep the rejection and its reason. If it could not occur
  to anyone, cut it.
- **Would this bite a second attempt?** If yes, keep the obstacle. Being interesting is not the same as
  being load-bearing.
- **Does a topic doc already say it, better?** Then delete the copy — and check first, because it
  usually does. Repeatedly through this restructure, material that read as homeless in a project file
  turned out to have been folded into a topic doc as the work landed, leaving a stale second copy
  behind. A shipped mechanism described in two places drifts, and the backlog copy is the one that goes
  stale.
- **Is it in the wrong file rather than surplus?** Then move it. Disposal is not only deletion: a
  generalized rule buried in a build-phase entry belongs in whichever topic doc owns that question, and
  it is unreachable where it sits — nobody building a dialog reads the security model. Relocating is
  the more valuable half of a pass, and the more easily skipped.

**A doc's own outbound links are a checklist.** Before deleting a file, grep for what still points at
it — not only code, but the sibling project files and this index. More than once the prose promised
that depth or a measurement lived in the file about to be removed, and the disposal had to make good on
that promise first.

A status line per item is welcome and separate from all this: *done*, *in progress*, *what remains* is
exactly what someone picking a file up cold needs first.

**Why many small files rather than one long one:** an agent (or a person) picking up one initiative
should be able to read one file, not scan a monolith for the paragraph that applies. The same reasoning
splits the topic docs by question — structure, field semantics, UI behavior, security, operations,
scale — rather than by feature.

> **Before going public:** [`../pre-release.md`](../pre-release.md) holds the committed, blocking
> plan — six features drawn from the files below, plus the release mechanics. Items named there are
> scoped: only part of `dashboard-reporting.md` and `recurring-detection.md` is in that scope.

## Items

- [paypal-amazon-enrichment.md](paypal-amazon-enrichment.md) — **shipped; deferred remainder only.** The
  import-enrichment + Amazon initiative landed in full — PayPal as an ordinary import, the general
  enrich-an-existing-transaction capability, `display_name_source`, evidence capture + role tagging, the
  Amazon orders-only account+link model with the funding-source map and reconciliation, and wallet
  funding-leg suppression — all folded into the main docs. What remains: AZAD paste/drag ingestion
  ergonomics, AZAD preview-features gating, a manual un-suppress of a funding-leg pair, enrich re-derive
  from stored raw values, and the deferred column-centric mapping-screen rework.
- [marketplace-purchase-detail.md](marketplace-purchase-detail.md) — **design, not started
  (2026-09-16).** Import eBay's purchase history and add the item detail to the card charge that paid for
  it, instead of Amazon's order-row model (the export names no paying card, order number or tax). Covers
  the purchase-record store, the matching (tax band + unique assignment, measured on one real download),
  a marketplace review shell that Amazon moves onto in the same change, the enriched `eBay: <item>` name
  with a rule pass for uncategorized charges, and eBay joining Amazon as a row in the data-source list. No product
  decisions owed.
- [import-source-field-registry.md](import-source-field-registry.md) — **shipped; deferred remainder
  only.** The registry, the origin surfacing built on it, and opt-in source-text rule matching all landed
  and are folded into `data-model.md`. What remains: selectable report columns drawn
  from the registry, and structured `(field, op, value)` matchers in place of the shipped
  "anywhere in the source text" form.
- [online-categorizer.md](online-categorizer.md) — **parked design.** An opt-in online (LLM) merchant
  categorizer for cold-start, plus deterministic merchant-name cleaning at rule-build time. Both
  terminate in the existing rule store ("the rule is the cache"). Adjacent to the rules work — worth
  resuming next time rules are in focus.
- [cleanup-pass.md](cleanup-pass.md) — small, non-urgent cleanups to batch together: console quieting,
  the rest of the native-`title` → shared-`Tooltip` migration, a legacy dead-code sweep, and an opt-in
  per-detail-panel Refresh seam.
- [import-rule-suggestion-review-extraction.md](import-rule-suggestion-review-extraction.md) — the one
  remaining piece of the import/export refactor: in-component JSX extraction from the large
  `ImportRuleSuggestionReview` component into prop-driven seams. No longer blocked — the review-model
  work it waited on has landed (see the Ledger).
- [recurring-detection.md](recurring-detection.md) — **reduced 2026-09-03 to the pool-load
  optimization, the only item left.** The subsystem is live end to end — detection and curation, the
  rule-backed path, the ended/canceled lifecycle, the anomaly/forecast signals (2026-08-27) and amount
  identity with the user-pinned expectation band (2026-09-01, schema v46) — and all of it, including
  every rejected shape, is in [`../data-model.md`](../data-model.md) → *Recurring series*. What stays:
  the payee filter is applied *after* a full pool load, so a scoped scan costs what a full one does
  (~125 ms vs ~124 ms on 20,000 rows) — academic when scans followed an import, less so now that it is
  on the path of every category edit. Pushing the filter into SQL needs `payee_key` materialized on
  `txn`; the revisit threshold is roughly 50,000 rows.
- [rule-amount-overlaps.md](rule-amount-overlaps.md) — **shipped 2026-08-27.** The overlap half of *Rule checkup*
  on the Rules page reports two things: amount ranges that overlap without containment (a warning —
  nothing decides which rule claims the charge) and merchant matchers that nest (information — the
  winner is not always the one a reader predicts). The mechanism is in `data-model.md` → Category rules;
  the file keeps the rejected shapes (a one-click fix, a badge, a keyword-length floor) and the one
  deferred case, two equal-length keywords matching one row.
- [button-consolidation.md](button-consolidation.md) — **design-system task, deferred.** Audit the app's
  button treatments (shared `Button` + bespoke one-offs that have drifted) and settle on one shared set
  of sizes/variants, then migrate the one-offs. Central decision is solid-vs-soft-tint primary and the
  ghost drop shadow, not just pixel size.
- [account-type-as-rule-criterion.md](account-type-as-rule-criterion.md) — **reduced 2026-09-03 to
  part 3, which has not started.** The account-*type* axis itself shipped (2026-07-21, migration v13):
  PayPal is a first-class account type, rules match and rank on `account_type`, and the money-movement
  rules collapsed onto it — all in [`../data-model.md`](../data-model.md) → *Accounts* / *Rules*,
  including why the axis is the account's type and not the batch's `source_kind`. What stays is
  **filtering and search** by account type: structured filters (the safe half, shippable alone) and the
  `accttype:`/`acctname:` free-text grammar (a design pass, not a feature), which must compile into the
  rule matcher's own `match_expr` rather than fork a second matcher.
- [paypal-money-movement-recognition.md](paypal-money-movement-recognition.md) — **shipped; deferred
  remainder only.** PayPal source recognition, force-captured `Type`/`Item Title`, and the user-approved,
  account-type-scoped, bidirectional `Type` → *Money movement* rules all landed (2026-07-20) and are
  folded into the main docs; the code citations were repointed at them 2026-09-03. What remains: fold the
  dedicated review into the generic rule-suggestion engine (cluster by `Type`), which today clusters by
  merchant name only — so nameless money-movement rows never cluster at all.
- [transaction-attachments.md](transaction-attachments.md) — **reduced 2026-09-03 to the unbuilt
  extraction tiers.** Phase 1 shipped 2026-08-24 — the `document` table and on-disk store, the
  format-agnostic ingestion seam (file, paste, the `text/html` flavour, a saved `.eml`), tier-1 PDF text
  and the FTS5 index, the backup and resumable-restore halves, the shared UI — and all of it is in
  [`../data-model.md`](../data-model.md) → *Attached documents*. What stays: tier 1b (embedded
  e-invoices, a file probe), tier 2 (local OCR, whose obstacle is packaging a system binary, not code),
  tier 3 (a BYOK extractor that is **the same subsystem** as
  [online-categorizer.md](online-categorizer.md) and should be designed with it), phase 4 (an approved
  itemization pre-filling a split), the **sizing assumption** and the signal that would falsify it, and
  the space-reclamation view — plus why originals are never sunset on a timer.
- [refactor-audits.md](refactor-audits.md) — **recurring process; the method moved 2026-09-02** to `CONTRIBUTING.md` → *Auditing for duplication*. Periodically hunt duplication /
  shotgun-surgery smells (structural tools + a judgment pass), fix the safe ones. Records the first
  run's shipped items (`getFormControlStyle` in Dashboard, `TransactionListToolbar`, `useTags()`), the
  deferred candidates (row-patch util, the four drill panels), and the next scope (**backend audit**).
- [help-topic-search.md](help-topic-search.md) — **parked, not started (2026-07-25).** A search box on the
  `/help` topic index (in the sticky header) to find articles by typing. Parked because it's of limited
  use until the match reaches article *body* text, not just titles/summaries — and bodies are JSX, so
  that needs a per-topic `keywords` field (ongoing authoring) rather than free full-text search.
- [in-page-help-explain-mode.md](in-page-help-explain-mode.md) — **not started (2026-09-13).** An
  "explain this" mode that outlines the controls on a page that have help topics and opens the topic on a
  click, declared per control so it points at the real screen rather than a mockup; recorded with the
  post-data guided tour from the onboarding rework, which would sequence over the same declarations.
- [tag-report-exclude-warning.md](tag-report-exclude-warning.md) — **reduced 2026-09-03 to the parked
  include case.** The exclude note shipped 2026-07-28 and its behavior — `FilterConflictNote`, the
  like-for-like and view/totals-aware boundaries, and both symmetric tag-report cases — is in
  the header comment of `frontend/src/lib/reportFilterConflicts.js`. What stays: whether an **include** chip
  on a group/category report deserves the same note. It is deliberately not flagged today (a transaction
  has one category, so an include is ordinary focusing) and the behavior is correct without it; it is held
  for a larger tag-report pass rather than a one-off.
- [import-history-windowing.md](import-history-windowing.md) — **reduced again 2026-10-09; the
  per-source window, the by-year archive, the move onto transaction coverage and the stored-detail
  maintenance screen are all built.** The retention story — the silent global
  `LIMIT 50` that hid older imports and let one active source crowd out another, why the display query
  is unbounded, and why the writing reconcile pass on the same endpoint stays capped — is in
  [`../scale-and-limits.md`](../scale-and-limits.md); the window and archive as built are in
  [`../data-model.md`](../data-model.md). What stays: the
  fetch re-bound, now blocked on the five
  consumers that read the batch list as an aggregate rather than as a page.
- [ofx-direct-connect.md](ofx-direct-connect.md) — **researched, parked (2026-08-07).** OFX Direct
  Connect as a data-source provider — the only transaction pull with no aggregator in the middle. Settles
  the technology (`ofxtools`, pure Python; **not** aqbanking, a per-platform C build whose own consumers
  have abandoned the path), records that the protocol is being *retired* rather than held stable by
  Quicken (its successor, EWC+, is closed to third parties), and flags the disclosure it owes: an OFX
  credential **is the bank login** and cannot be revoked from inside the app, so both the connect and
  disconnect flows have to say so. Parked on
  **coverage**: the bundled FI list matched none of the institutions actually in use here.
- [provider-candidates.md](provider-candidates.md) — **research, nothing started (2026-10-09).** Which
  provider to add next, and what each would cost. The structural half is the finding worth acting on:
  SimpleFIN is a protocol with several independent servers — four of the seven services checked expose one
  — and the adapter isolates the protocol *mapping* cleanly while keeping every Bridge-specific policy in
  module constants no subclass can reach, so a second server costs a parameterizing refactor before it
  costs anything else. Records what each service actually is, the two that sell direct access to
  individuals (Akahu, Enable Banking's restricted production), the **server profile** that makes "named
  server" and "paste any token" one mechanism rather than two, and why accepting an unlisted host leaks
  nothing — so the fixed host allowlist is not re-imposed out of caution.

### Migrated from `TODO.md` / `TODO-TESTING.md` (2026-07-30)

- [saved-tag-reports.md](saved-tag-reports.md) — **deferred.** Four dashboard tag-report
  follow-ups: a Settings-page manager mirror, capturing filters in a preset, cross-user sharing
  (a real `tag_report` table), and a richer (drag/NL) report builder.
- [dashboard-reporting.md](dashboard-reporting.md) — **reduced 2026-09-02 to what has not started.**
  The cash-flow work shipped 2026-08-25 and its durable half is now in the topic docs: chart behaviour in
  the comments beside the chart code, reporting semantics (including
  `exclude_from_totals` as the *only* exclusion axis and the three richer schemes rejected in its favour)
  in [`../data-model.md`](../data-model.md) → *Reporting assumptions* → *Cash flow*, and the endpoints in
  `architecture.md`. What stays: the **`cash_date`** phase for cash-basis timing, a cash-flow form for
  **Compare** (left open deliberately), and the **Trends-tab double-count audit**, gated on that tab
  gaining a tag-report selector and unrelated to cash flow despite sharing the file. The trend-bucketing
  question was settled and built 2026-10-07 — see the Ledger.
- [import-input-formats.md](import-input-formats.md) — **reduced 2026-09-03 to the two file formats,
  unstarted.** The **parse-seam extraction** they shared is done (2026-09-18, with the PayPal statement
  import as the second front end): XLSX first, reusing the entire downstream unchanged, then OFX/QFX/QBO,
  which follows the statement import's mapping-free path plus a `FITID` rung in dedupe. SimpleFIN — the Plaid-parallel connection track that
  shared this file — shipped 2026-08-07 and everything it taught is in
  [`../building-a-connector.md`](../building-a-connector.md).
- [import-dedupe-followups.md](import-dedupe-followups.md) — **deferred (not safety).** Auto-restore
  deduped rows when a contributing import is undone, and a duplicate-resolution history view + batch
  undo. Both convenience only — per-row restore already prevents loss. Also holds two measured/scoped
  deferrals: bank-side type prefixes, and letting a coverage reject rest on the actual twin rather than
  on whichever same-amount row filled the candidate slot (the report half of that one shipped).
- [merchant-rename-fate.md](merchant-rename-fate.md) — **dormant code, decision pending.** Keep-or-drop
  the unwired `merchants.py` / `merchant_rename` CRUD (its role was absorbed by
  `category_rule.clean_name`); revisit when Plaid sync is exercised.
- [backup-restore-scope-and-secrets.md](backup-restore-scope-and-secrets.md) — **reduced 2026-09-03 to
  the scope/UX half, unstarted.** The secrets half is done and documented elsewhere: the v12 envelope,
  streaming both directions, the incremental cipher, referential repair, `restore_state` and the
  resumable documents phase are in [`../data-model.md`](../data-model.md) → *Backups*, restore semantics
  in [`../operations.md`](../operations.md), the memory profile in
  [`../scale-and-limits.md`](../scale-and-limits.md), custody in
  [`../security-model.md`](../security-model.md). What stays: an **accounts & secrets** backup and a
  sectioned *back up all* (one artifact, because the token ciphertext and the key that opens it live in
  different databases — split them and the file restores but cannot sync), the **restore-time identity
  reconciliation** flow, `backup_recipient` inclusion, whether the file carries every member's vault
  slot, and restoring an incremental chain (the document delta is the tractable half; a date-windowed
  backup is a slice, not disaster recovery).
- [deployment-topologies.md](deployment-topologies.md) — **reduced 2026-09-02 to what is genuinely
  unbuilt.** The settled half — the shapes and what each binds to, the data directory, the shell decision
  and every other rejected alternative — is in [`../operations.md`](../operations.md), with building in
  [`../releasing.md`](../releasing.md) and the mechanism in `architecture.md`. What stays here: **Shape A**
  (a LAN server) is built, so what is left is the decisions behind it and what has not yet been seen
  working on a real server — the per-device certificate steps beyond Windows, a sign-in passkey on a
  `.local` name, a tablet, and macOS as the server; and **Shape B step 3's remainder**, which is only what CI structurally cannot
  reach and needs a Mac in front of somebody — the Dock lifecycle, Gatekeeper, and the log-file redirect.
- [i18n-display-formatting.md](i18n-display-formatting.md) — **reduced 2026-09-03 to the number/date
  half, unstarted.** Tier-1 **formatting**, not translation. The ledger-currency setting shipped
  2026-08-08 and its model is in [`../data-model.md`](../data-model.md) — including why currency is
  tenant-wide while a date format is per-user `ui_preference`. What stays: **Bucket A** (the `en-US`
  formatter, a date-format preference, and the ~9 raw ISO renders the central helpers never reach —
  cosmetic) and **Bucket B**, the only correctness risk: the ledger search parses dates MDY-first and
  amounts with fixed separator roles, and CSV amount parsing carries the same hazard, where `1.234,56`
  silently imports as `1.234`.
- [query-cache-invalidation.md](query-cache-invalidation.md) — **parked, maybe never.** Swap the
  hand-wired `notifyTransactionsChanged` refresh map for dependency-based (query-key) invalidation —
  only if transaction-derived views proliferate enough to hurt.
- [lint-and-tooling.md](lint-and-tooling.md) — **deferred; the posture moved 2026-09-02** to `CONTRIBUTING.md` → *Lint posture*. Two "enable → measure → triage → gate"
  linter passes: raise eslint strictness beyond the narrow baseline, and make the aspirational **ruff**
  config real (wire it in; adopt `flake8-datetimez` over the bespoke timestamp guard).
- [test-coverage-gaps.md](test-coverage-gaps.md) — **running checklist. The migration/fresh-schema parity entry was corrected 2026-09-02 from "dormant" to OWED** — its precondition passed dozens of migrations ago and no test exists. Owed tests: rule-collision
  HTTP + E2E + component coverage, the migration/fresh-schema parity guard (build with the first
  post-rebrand migration), rule-suggestion owner-scope stability, a component-test harness for
  `Settings.jsx`, which has none of any kind, and — added 2026-09-03 — restoring a credentials backup
  across a vault reset, the recovery ladder's first real rung and the only one nothing exercises end to
  end. Also records the E2E harness that *is* available
  (`npm run ui:test` against its own throwaway stack).
- [database-diagnostics.md](database-diagnostics.md) — **backlog, not started (2026-08-10).** Nothing
  ever checks that the databases are intact — no health surface, and notably no check of the *target*
  before a destructive restore. Structural half is small (`integrity_check` + `foreign_key_check`, ~100 ms
  on a 60 MB DB; note the former does **not** cover foreign keys). The larger half is an invariant
  checker for the semantic inconsistencies those pragmas call "ok" — kept deliberately separate.
- [misc-followups.md](misc-followups.md) — **catch-all.** One-offs too small for their own file:
  the unwritten CHANGELOG entry for the category-owner → tag migration, a denser Connections-tab card
  layout, SimpleFIN's 90-day window becoming a silent cap, whether timestamps should ever be relative,
  the stalled-request gap a blanket request timeout was rejected for, and what checking a tag on a
  transaction should *mean* — the open question being whether a hand-checked tag survives a later
  recategorization, with a concrete hole in bulk `add_tags` to look at first.

## Ledger

Every project file that has been disposed of, so **"disposed" is distinguishable from "nobody got to
it yet"** — the question this index could not answer before. A row is permanent, and it records the
**path** rather than a project name, because the path is what makes `git log -- <path>` find the last
version of a file that no longer exists. That is the thread to pull on when a row's summary is not
enough.

A file is kept only where something still points at it for work that has not started. Reachability
from a chronological record is not reachability: `CHANGELOG.md` holds no backlog references and starts
at the first public release, so it cannot point at anything completed before that.

| Path | Disposed | Fed | File kept? |
| --- | --- | --- | --- |
| `docs/backlog/import-source-header-evolution.md` | 2026-10-09 | **data-model** — the fingerprint as the last imported file's layout (learned on import, older file takes it back, recognized sources excluded), the capture panel's blind spot that let an added column go uncaptured, and the single `ParsedFile.fingerprint` definition; **ui-patterns** (*Import mapping persistence*) — continuing past the header warning applies the source's mapping rather than re-inferring, and the one thing it drops | **No** — deleted the day it was written. Written as a plan, built in the same session; nothing in it was left unstarted and no code ever cited it |
| `docs/backlog/security-and-deployment-model.md` | 2026-09-02 | **A** (`security-model.md`) — threat model, perimeter, custody, enrollment/rotation, transport, all rejected shapes | **Partly** — reduced 917 → ~250 lines. The build-phase log stays until its facts are relocated to `architecture.md`; that pass is the open decision below. Cited from code by phase number (`database.py`, `providers/config.py`, `routers/providers.py`) |
| `docs/backlog/pre-auth-security-ui.md` | 2026-09-02 | **A** (identity & the network perimeter) | **No** — deleted. Past the shipped Settings forms it was a work log of what a lint cleanup had removed |
| `docs/backlog/optional-env-and-layered-config.md` | 2026-09-02 | **B** (`operations.md`) — layer order, env core, per-file overrides, rejected alternatives; **A** — why app credentials left `.env` | **No** — deleted. The mechanism was already in `architecture.md` → *Configuration layers*; its one unbuilt follow-up (mDNS) moved to B's *Open* |
| `docs/backlog/transaction-splits.md` | 2026-09-02 | **E** (`mechanism-index.md`) — the forks and non-goals; data-model — the pre-fill refusal edges | **No** — deleted. Mechanism, invariants and UI behaviour were already in `data-model.md` / `ui-patterns.md`; `services/txn_splits.py` repointed to both |
| `docs/backlog/multi-payment-purchases.md` | 2026-09-02 | **E** — its hand-rolled *three neighbours* table, generalized into the index; data-model — the four reasoned exclusions | **No** — deleted |
| `docs/backlog/list-virtualization.md` | 2026-09-02 | **C** (`scale-and-limits.md`) — the unwindowed list and its four obstacles, the measurement method, the rejected hand-rolled windower and document-scroller mode | **No** — deleted. The windowing rules were already in `ui-patterns.md`; `ImportRuleSuggestionReview.jsx` repointed to C |
| `docs/backlog/transaction-list-limits.md` | 2026-09-02 | **C** — the accepted caps as a table (cost, and the condition for revisiting each) | **No** — deleted. The `limit` contract was already in `data-model.md` |
| `docs/backlog/import-history-windowing.md` | 2026-09-02 (partial) | **C** — the lossy-cap retention story and the write-on-load reconcile asymmetry | **Yes**, 52 → 36 at the time; the window and archive landed 2026-10-08 and fed `ui-patterns.md`, leaving the fetch re-bound and the deletion strategy |
| `docs/backlog/dashboard-reporting.md` | 2026-09-02 (partial) | ui-patterns — the charts body was already folded in; this added only the frame-vs-fourth-mode rejection. data-model — `exclude_from_totals` as the sole exclusion axis, the three rejected schemes, sides-by-net, the netted atom, the calendar-month window, tag reports having no reading | **Yes**, 374 → 95 — `cash_date`, Compare, trend bucketing and the Trends-tab audit have not started. Citations in `Dashboard.jsx` and `routers/transactions.py` repointed |
| `docs/backlog/deployment-topologies.md` | 2026-09-02 (partial) | **B** (`operations.md`) — shapes, binds, data location, rejected shell options; **A** — the host-name constraint; `releasing.md` — macOS build detail and the rejected packaging options | **Yes**, 300 → 57 — Shape A is unbuilt and Shape B step 3 has a remainder CI cannot reach. Cited from `backend/desktop.py`, repointed to `operations.md` |
| `docs/backlog/tag-report-exclude-warning.md` | 2026-09-03 (partial) | ui-patterns — nothing new: the shipped note was already folded in as the work landed, so the disposal was deletion of the second copy rather than authorship | **Yes**, 44 → 22 — include narrowing on group/category reports is unstarted. `lib/reportFilterConflicts.js` repointed to `ui-patterns.md` |
| `docs/backlog/account-type-as-rule-criterion.md` | 2026-09-03 (partial) | data-model — the account-type scope, precedence and matcher identity were already there; this added the **`source_kind` rejection** (provenance on a batch is not retroactive to an account's older rows) | **Yes**, 101 → 43 — part 3, filtering and search by account type, is unstarted. `services/money_movement.py` repointed |
| `docs/backlog/i18n-display-formatting.md` | 2026-09-03 (partial) | data-model — the one-currency rule was already there; this added the **date-format counter-example**, the case where `ui_preference` *is* right. ui-patterns — name a settings section for what it contains, not what it will grow into | **Yes**, 161 → 75 — the number/date half is unstarted, and Bucket B is the only correctness risk in it |
| `docs/backlog/import-input-formats.md` | 2026-09-03 (partial) | building-a-connector — the seam gaps and request budgets were already there in more depth; this added **The published guide is not the contract** (a documented history window and a CDN that refuses unnamed clients), plus the `## Open` section the doc lacked | **Yes**, 112 → 71 — XLSX and the OFX family are unstarted, both gated on extracting the parse seam |
| `docs/backlog/cleanup-pass.md` | 2026-09-03 (partial) | **D** — console cleanliness as signal preservation (2026-09-02); ui-patterns — the shared `Tooltip`'s accessibility debt, and why a **press**-driven label follows a different rule from a **load**-driven one | **Yes**, 107 → 100 — the tooltip migration, dead-code sweep, per-panel Refresh seam and schema leftovers are all unstarted |
| `docs/backlog/recurring-detection.md` | 2026-09-03 (partial) | data-model — most was already there; this added the **both-readings** detector rule (a plausible whole-set rhythm is not sufficient — two price points a fortnight apart interleave into a bogus biweekly), **apply the sign before ordering a typed band**, and why there is deliberately **no duplicated-charge signal**. ui-patterns — reusing a shared control means reusing its *contract* | **Yes**, 257 → 44 — the pool-load optimization is the only item left. `services/recurring_detection.py` repointed |
| `docs/backlog/transaction-attachments.md` | 2026-09-03 (partial) | data-model / ui-patterns / **B** — phase 1 was already folded in as it landed; this relocated the **client-side backup blob** (the browser is the last hop still holding a whole artifact) to **C** → *Obstacles* | **Yes**, 366 → 149 — tiers 1b/2/3, phase 4, the sizing assumption and space reclamation are unstarted. `services/documents.py` repointed |
| `docs/backlog/backup-restore-scope-and-secrets.md` | 2026-09-03 (partial) | data-model / **A** / **B** / **C** — all already ingested; this added to **B** why a restore's outcome depends on the database it never touches, and that turning sign-in off is a flag flip rather than a reinstall | **Yes**, 505 → 101 — the sectioned artifact, restore-time identity reconciliation, `backup_recipient`, member slots and the incremental chain are unstarted |
| `docs/backlog/reimbursable-expenses.md` | 2026-09-03 | data-model — the reminder model (record-level date, the transaction-dated clock, the three-way answer, the ledger-level default and why it is not `db_meta`), owner grouping, moving a claim, and the rejections that had no home yet: the unstored expected total, the removed free-text note, and settling per record rather than per position. ui-patterns — a record's terminal action lives in its dialog, not on a right-click menu. shared-components — the symmetric match picker, and the rejected dropping of named portions. **C** (`scale-and-limits.md`) — `/tasks` is recomputed on every mutation, and what that costs here | **No** — deleted, 377 lines. The mechanism, invariants and every guard were already in `data-model.md` as the work landed; this pass added the reminder half and relocated the four rejections the topic docs did not yet carry. `services/reimbursements.py` repointed to `data-model.md` and `mechanism-index.md` |
| `docs/import-source-fields-plan.md` | 2026-09-03 | data-model — the source-text rule's **perf gate** (the per-row evidence parse is conditional on a source-text rule existing) and the correction that a provider sync captures evidence but does not pass it to the categorizer at insert time; ui-patterns — the registry as the single seam for "what the source said", and why it is dynamic | **No** — deleted, 169 lines. It sat outside `docs/backlog/` and so escaped the disposal pass; Phases 1 and 2 were both marked DONE and already folded into the topic docs as they landed. The unstarted remainder became `backlog/import-source-field-registry.md`, reached from `data-model.md` → *Open*. Four citations repointed (`lib/importSourceFields.js`, `services/categorizer.py`, `data-model.md`, `backlog/online-categorizer.md`) |
| `docs/backlog/vault-passphrase-recovery.md` | 2026-09-03 | **A** (`security-model.md`) — the recovery ladder, reset as compromise response, the mint-a-method gate and both reversals (the two narrower rules that each miss a case; the other-member refusal that became a redirect). The one owed test moved to `test-coverage-gaps.md` | **No** — deleted, 674 lines. The A-slice was ingested 2026-09-02 but the file was never reduced; on re-reading, nothing survived the diff except that test, and the running test checklist is its natural owner |
| `docs/backlog/import-rule-suggestion-review-model.md` | 2026-09-15 | data-model — the review's state lifecycle (what owns the rows, which rule, and what `source_row_ids` means in each state), the partition record and the rejected read-time normalization, undo's exactness and its reversal of an edit to a rule the review did not create, and the rejected raw review-write route; architecture — what a review scope carries and what may not branch on it | **No** — deleted. All four stages shipped and both questions stage 2 left were settled (undo now reverses an edit to a pre-existing rule; the three routes that had lost their only caller were removed). What remained past the fold was the stage-by-stage work log |

| `docs/backlog/watched-import-folders.md` | 2026-09-20 | architecture — the mechanism as built (the module, the three triggers, the `(size, mtime)` watermark) and the three rejected shapes (OS file events, a scheduler thread, a `processed/` subdirectory); data-model — the field semantics and every refusal the scan must make, plus the corrected account-map note; **A** (`security-model.md`) — *Reading and deleting outside the data directory*, the one place the app touches a path it does not own; **B** (`operations.md`) — which machine the folder is on, per topology; **C** (`scale-and-limits.md`) — why a listing is cheap and a badge never scans; playbook + a help topic for the user-facing half | **No** — deleted. Both open questions were decided when the work was picked up (purge ships; a source proves itself with one hand import first), and the file's stated precondition was wrong: the account map *is* persisted, just invisibly, which became its own entry in data-model → *Open* |
| `docs/backlog/dashboard-reporting.md` | 2026-10-07 (partial) | ui-patterns → *The single-period trend* — the trend-bucketing question, settled as calendar grains with the selection highlighted plus an exact same-span mode, and the rejected month-rounded period-sized buckets | **Yes**, 113 → 96 — `cash_date`, Compare and the Trends-tab audit are unstarted |
| `docs/backlog/passkey-app-login.md` | 2026-09-17 | **A** (`security-model.md`) — *Passkeys and the second factor*: why required user verification stands in for the TOTP step, why the convenience case is itself a security argument, why the password stays the floor, why the two passkey features must not merge, and the scoping of the vault's assertion-verification rejection; architecture — the mechanism as built (table, service, endpoints, session-held challenge, frontend modules) | **No** — deleted. Every open question in it was decided as the work landed: discoverable credentials required, the management surface beside the vault's passkeys but separately labelled, and a password mandatory per account |
| `docs/backlog/settings-administration-split.md` | 2026-10-11 | **A** (`security-model.md`) — admin gates the install and the perimeter, not the ledger, that the same gate sorts Settings from Administration, creating a backup joining the gate, and the rejected gating of ledger-wide settings; ui-patterns — the section-list layout was already there as the work landed, and this added the export dialog working on a copy of the page's filter; architecture — startup configuration as a report that in-app settings never join; the Settings, Administration, Import and Transactions help topics | **No** — deleted. Every stage shipped, and it also retired the *Import / Export still needs a reachability pass* entry in `misc-followups.md`, which it superseded. No code cited it |

### Checked, and found to owe nothing

Not disposals, and recorded separately so the table above keeps meaning one thing. Both files were
worked on **2026-09-03** and turned out to need no ingest at all: the durable half had been folded into
the topic docs as the work landed, exactly as the same-change rule intends. What each still owed was its
**code citations** — and that is the finding worth keeping, because in both cases the citations had
already begun to decay, naming sections their own file no longer had.

| Path | What it owed | State |
| --- | --- | --- |
| `docs/backlog/paypal-money-movement-recognition.md` | Two citations (`services/money_movement.py`, `routers/import_export/core.py`), repointed to `data-model.md`. Also carried a **stale deferred item** — migrating the rules from account-id to account-type scope, which shipped in migration v13 on 2026-07-21 — removed on 2026-09-03 along with the copy of it in `data-model.md` → *Open* | Kept, 28 lines — the fold into the generic rule suggester is unstarted |
| `docs/backlog/paypal-amazon-enrichment.md` | **Seven** citations (`lib/api.js`, `routers/import_export/amazon.py`, `services/txn_links.py`, `import_enrichment.py`, `amazon_funding.py`, `amazon_import.py`, `db/database.py`), every one naming a section the file no longer had, repointed to `data-model.md` / `architecture.md` / `mechanism-index.md` | Kept, 64 lines — AZAD ingestion, manual un-suppress, enrich re-derive and the column-centric rework are unstarted |
