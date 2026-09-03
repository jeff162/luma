# Backlog

Deferred and parked work that is **not** blocking current features. Each file is one initiative,
written so it can be picked up cold.

> **The keep-and-link rule below is being replaced.** [`../doc-restructure.md`](../doc-restructure.md)
> is the committed plan to retire completed project files entirely — rewriting what each holds into
> topic-organized reference docs rather than keeping the file and linking to it, since a link to a
> project filename decays and one already had. Read it before disposing of a shipped item.
>
> **The first disposals landed 2026-09-02** — the security model became
> [`../security-model.md`](../security-model.md). Every disposed project keeps a permanent row in that
> plan's **Ledger**, which is what distinguishes *disposed* from *nobody got to it yet*; the row records
> the file's **path**, so `git log -- <path>` still finds the last version of a file that no longer
> exists. The **Completed** section below is retired along with the last disposal and is not being
> extended — a newly shipped item folds into the topic docs and takes a ledger row.

**When an item ships**, fold its durable "what it is and why" into the main docs (`architecture.md` /
`data-model.md` / `ui-patterns.md` / `shared-components.md`) — those are what the read-first rule makes
someone open, so that is where a rule has to live to be found. Then either delete the backlog file or,
if it still holds something the main docs should not carry, move its entry to **Completed** below.

**What the main docs should not carry is the record of what was deliberately *not* done** — the
obstacles, the rejected shapes, the "don't redo this" notes. Those answer a question nobody asks until
they are already proposing the thing, so a doc read never surfaces them. Two habits make them reachable
anyway, and both are load-bearing: the main-doc paragraph **links back** to the backlog file for depth
(ten such links exist today), and the **code carries the decision at the site** — the header comment on
`ImportRuleSuggestionReview.jsx` fires exactly when someone thinks "this list should be windowed", which
no document could.

**A rejected shape is not a work log, and only one of them belongs here.** The distinction is what
keeps these files readable: a *rejected shape* answers a question someone is about to ask again — what
was considered, why it fails, what it would cost to revisit — and an *obstacle* is a trap that would
bite a second attempt. Both earn their space. What does not is the narrative of arriving at the current
state: an expectation that turned out wrong, the order in which things were discovered, what a testing
pass revealed, which symptom looked like a different bug first. Nothing follows from any of it once the
work has landed, and it buries the notes that do matter. Three tests, all of them cheap to apply:

- **Could a reader re-propose this?** If yes, keep the rejection and its reason. If it could not occur
  to anyone, cut it.
- **Would this bite a second attempt?** If yes, keep the obstacle. Being interesting is not the same as
  being load-bearing.
- **Does the main doc already say it, better?** Then link, and delete the copy. A shipped mechanism
  described in two places drifts, and the backlog copy is the one that goes stale — see the fold-into-
  the-main-docs rule above.
- **Is it in the wrong file rather than surplus?** Then move it. A cleanup pass is not only deletion:
  a generalized rule buried in a phase entry belongs in `ui-patterns.md` (or whichever main doc owns
  that question), and it is unreachable where it sits — nobody building a dialog reads the security
  model. Relocating is the more valuable half of a pass, and the more easily skipped.

A status line per item is separate from all this and is welcome: *done*, *in progress*, *what remains*
is exactly what someone picking the file up cold needs first.

**Why many small files rather than one long one:** an agent (or a person) picking up one initiative
should be able to read one file, not scan a monolith for the paragraph that applies. The same reasoning
splits the main docs by question — structure, field semantics, UI behavior, component choice — rather
than by feature.

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
- [online-categorizer.md](online-categorizer.md) — **parked design.** An opt-in online (LLM) merchant
  categorizer for cold-start, plus deterministic merchant-name cleaning at rule-build time. Both
  terminate in the existing rule store ("the rule is the cache"). Adjacent to the rules work — worth
  resuming next time rules are in focus.
- [cleanup-pass.md](cleanup-pass.md) — small, non-urgent cleanups to batch together: console quieting,
  the rest of the native-`title` → shared-`Tooltip` migration, a legacy dead-code sweep, and an opt-in
  per-detail-panel Refresh seam.
- [import-rule-suggestion-review-extraction.md](import-rule-suggestion-review-extraction.md) — the one
  remaining piece of the import/export refactor: in-component JSX extraction from the large
  `ImportRuleSuggestionReview` component into prop-driven seams.
- [recurring-detection.md](recurring-detection.md) — **all four follow-ups shipped; two small items
  remain.** The recurring-series subsystem is live (detect + list + curate) and every numbered follow-up
  has landed: automatic + scoped detection (the per-import matching hook and the watermark-gated app-load
  catch-up), the **anomaly/forecast signals** — upcoming / missed / new / price-change, derived on read
  with per-finding dismissal (2026-08-27) — "Mark as recurring" in the shared context menu, and §4's
  identity half (2026-09-01, schema v46): `amount_mode`, amount-gated membership with a grace band, and
  the user-pinned expectation band. The ended/canceled lifecycle shipped alongside. §4 turned out to be
  **two live defects rather than a missing feature** — confirming one of a biller's two subscriptions
  orphaned the other, and two billing a fortnight apart merged into one bogus biweekly series — and the
  file records both, plus the shapes not to re-impose. Promoting a price step landed with it as
  **Accept new amount** on the price-change finding, which *extends* a gated series' band rather than
  relocating it — a band moved onto the new price stops matching the series' own history. Still open:
  the **pool-load optimization** (the payee filter is applied after a full pool load, so a scoped scan
  costs what a full one does — now on the path of every category edit, with a revisit threshold of
  roughly 50,000 rows).
- [rule-amount-overlaps.md](rule-amount-overlaps.md) — **shipped 2026-08-27.** *Check overlaps*
  on the Rules page reports two things: amount ranges that overlap without containment (a warning —
  nothing decides which rule claims the charge) and merchant matchers that nest (information — the
  winner is not always the one a reader predicts). The mechanism is in `data-model.md` → Category rules;
  the file keeps the rejected shapes (a one-click fix, a badge, a keyword-length floor) and the one
  deferred case, two equal-length keywords matching one row.
- [button-consolidation.md](button-consolidation.md) — **design-system task, deferred.** Audit the app's
  button treatments (shared `Button` + bespoke one-offs that have drifted) and settle on one shared set
  of sizes/variants, then migrate the one-offs. Central decision is solid-vs-soft-tint primary and the
  ghost drop shadow, not just pixel size.
- [account-type-as-rule-criterion.md](account-type-as-rule-criterion.md) — **parts 1–2 implemented
  (2026-07-21, migration v13); part 3 deferred.** The account *type* axis exists — PayPal is an account
  type and rules match and rank on `account_type` — so what remains is the filtering/search half.
  Generalize "restrict to PayPal/Amazon" from per-account-id scoping to **account *type***
  as a first-class axis for rules (and filtering/search): add PayPal as an account type, add an
  account-type rule criterion (parallel to the existing account-id one), and structured account-type
  filters — with a `accttype:`/`acctname:` tag grammar flagged as the harder free-text-search piece.
  Money-movement rules are the first consumer ready to migrate. Punts on existing data.
- [paypal-money-movement-recognition.md](paypal-money-movement-recognition.md) — **shipped; deferred
  remainder only.** PayPal source recognition, force-captured `Type`/`Item Title`, and the user-approved,
  account-scoped, bidirectional `Type` → *Money movement* rules all landed (2026-07-20) and are folded into
  the main docs. What remains: fold the dedicated review into the generic rule-suggestion engine (cluster by
  `Type`), and migrate the rules from account-id to account-type scope once that axis exists.
- [transaction-attachments.md](transaction-attachments.md) — **phase 1 built and exercised in the running
  app 2026-08-24; phases 2–4 deferred.** Attach a receipt or invoice to a transaction through **one
  format-agnostic ingestion seam**, and where possible make its text searchable. Phase 1 shipped: the
  `document` table and the on-disk store under `DATA_DIR/documents/`, the backup half (a `documents`
  section plus each file as a zip member) with `restore_state` and the resumable documents phase, the
  attach/list/serve/detach endpoints, **tier-1 PDF text extraction** and the FTS5 index, plus the shared
  `DropZone`, `DocumentsPanel`, the ledger paperclip and `DocumentViewerDialog`; Help topic written. The
  storage decision that once blocked this is settled. **The ingestion seam ended up wider than the file
  first described**, all of it from real use: pasted text, the `text/html` flavour that keeps an emailed
  receipt's table intact, and a saved `.eml` — and two calls were **reversed** under real use and are
  recorded as don't-re-impose. Still deferred: OCR (tier 2), structured line-item extraction (tier 3, an
  opt-in BYOK adapter with per-result approval), and the splits hand-off (phase 4). Records why local
  document-ML and template-based tooling are both out, and that **email means copy/paste — never a
  mailbox**. Key finding that still holds: tier 3 is the *same subsystem* as
  [online-categorizer.md](online-categorizer.md) (opt-in external call, structured output,
  approve-before-apply) and the two should be designed together.
- [reimbursable-expenses.md](reimbursable-expenses.md) — **built 2026-09-02: service, API, detail
  panel, ledger marker, the outstanding report (a two-column board with drag-to-pair) and the Help
  topic. Still owed: the Tasks signal.** Reworked repeatedly under real use — rows to *portions*, one
  action to **sign-driven** actions (money out expects a repayment, money in names what it repays), a
  Tracked/Not-tracked report to a board split by direction, and from "settle" to **complete** (a
  repaid-in-full reimbursement had no terminal action at all while a zero residual was an error, so the
  feature's own happy ending was unreachable). Don't re-impose either. The app seeds the **group only**:
  leaves are named for what the money is *for*, not for its state, which is why finished rows stay put
  and a "Completed" leaf was designed and rejected. A reimbursement covers a **claim on
  part of a transaction** (a *portion*), because one charge split between two friends is two debts and one
  ATM deposit can repay both — "at most one reimbursement per transaction" was the first rule and could not model
  the file's own motivating example. Don't re-impose it. The durable model is in `data-model.md` → Reimbursable expenses. Money
  that leaves as an expense and returns later (tickets bought for friends, work expenses claimed back).
  The categorization is already right; the problem is that the netting **crosses period boundaries**, so
  a month overstates spending until the repayment lands. Models it as a **receivable category** carrying
  the existing `exclude_from_totals` treatment — nothing is restated automatically, nothing is asserted
  about a repayment that may never come, and "who still owes me" is the category's sum. The design turns on the
  **residual**: a repayment is often *not* equal (tickets resold at a loss or a profit), a short
  repayment and an unpaid one are indistinguishable by amount, so a **settle** action is what moves the
  leftover to a real category. **Which transaction carries that move is settled and is not a preference:**
  the residual is a category balance rather than a row, so the sign decides — a positive residual settles
  on the **expense** (explicitly restating the original period, which is the point) and a negative one on
  the **repayment**. That asymmetry is what keeps mixed-sign splits from looking like a prerequisite;
  they are not one, and the file records why. Pairing is **optional and late** — needed only to settle,
  and served by `txn_link` (`kind='reimbursement'`) rather than a new table. Downstream of
  transaction splits, **which have since shipped** — so the dependency is met
  and this can start. The receivable lives under a **seeded top-level `Reimbursable` group** carrying a
  `system_key` — which is load-bearing, since the empty-category sweep skips only system rows and an
  empty receivable category is its *healthy* state. The feature keys on the **group**, not one blessed
  leaf, so the one-category-versus-per-counterparty question is moot: leaves are the user's to add and
  the group's `exclude_from_totals` covers them all. No migration — `_seed_default_categories` runs
  ahead of the migrate branch. The group is **undeletable and its exclusion unchangeable** — flat
  refusals, since the delete never durably worked anyway (re-seeding returns it) and clearing the
  exclusion silently restores the overstatement the feature removes; leaves stay entirely the user's,
  because an existing parent always wins `COALESCE(parent, leaf)`. The default leaf is
  `Awaiting reimbursement`.
- [refactor-audits.md](refactor-audits.md) — **recurring process.** Periodically hunt duplication /
  shotgun-surgery smells (structural tools + a judgment pass), fix the safe ones. Records the first
  run's shipped items (`getFormControlStyle` in Dashboard, `TransactionListToolbar`, `useTags()`), the
  deferred candidates (row-patch util, the four drill panels), and the next scope (**backend audit**).
- [help-topic-search.md](help-topic-search.md) — **parked, not started (2026-07-25).** A search box on the
  `/help` topic index (in the sticky header) to find articles by typing. Parked because it's of limited
  use until the match reaches article *body* text, not just titles/summaries — and bodies are JSX, so
  that needs a per-topic `keywords` field (ongoing authoring) rather than free full-text search.
- [tag-report-exclude-warning.md](tag-report-exclude-warning.md) — **exclude case shipped 2026-07-28; the
  include case still parked.** The inline note on the Dashboard report when a filter chip references a slice
  the active report is built from shipped for **exclude** chips (`FilterConflictNote` in `ui.jsx`, driven by
  `lib/reportFilterConflicts.js`) — the exclude is honored, not suppressed, and the note just explains the
  subset. The parallel **include** case stays parked for a larger tag-report pass rather than a one-off; the
  behavior is already correct without it.
- [import-history-windowing.md](import-history-windowing.md) — **reduced 2026-09-02; the archive UX
  has not started.** The retention story — the silent global `LIMIT 50` that hid older imports and let
  one active source crowd out another, why the display query is now unbounded, and why the writing
  reconcile pass on the same endpoint stays capped — is in
  [`../scale-and-limits.md`](../scale-and-limits.md). What stays: the per-source recency window with an
  "Older imports" archive grouped by year, the fetch re-bound it unblocks (**and only in that order** —
  paging before the archive recreates the lossy cap), and a deletion strategy that purges history
  records rather than transactions.
- [ofx-direct-connect.md](ofx-direct-connect.md) — **researched, parked (2026-08-07).** OFX Direct
  Connect as a data-source provider — the only transaction pull with no aggregator in the middle. Settles
  the technology (`ofxtools`, pure Python; **not** aqbanking, a per-platform C build whose own consumers
  have abandoned the path), records that the protocol is being *retired* rather than held stable by
  Quicken (its successor, EWC+, is closed to third parties), and flags the blocking consequence: an OFX
  credential **is the bank login** — neither read-only nor revocable in-app — which breaks the
  conditioning [security-and-deployment-model.md](security-and-deployment-model.md) rests on. Parked on
  **coverage**: the bundled FI list matched none of the institutions actually in use here.

### Migrated from `TODO.md` / `TODO-TESTING.md` (2026-07-30)

- [saved-tag-reports.md](saved-tag-reports.md) — **deferred.** Four dashboard tag-report
  follow-ups: a Settings-page manager mirror, capturing filters in a preset, cross-user sharing
  (a real `tag_report` table), and a richer (drag/NL) report builder.
- [dashboard-reporting.md](dashboard-reporting.md) — **reduced 2026-09-02 to what has not started.**
  The cash-flow work shipped 2026-08-25 and its durable half is now in the topic docs: chart behaviour in
  [`../ui-patterns.md`](../ui-patterns.md) → *Charts and overlays*, reporting semantics (including
  `exclude_from_totals` as the *only* exclusion axis and the three richer schemes rejected in its favour)
  in [`../data-model.md`](../data-model.md) → *Reporting assumptions* → *Cash flow*, and the endpoints in
  `architecture.md`. What stays: the **`cash_date`** phase for cash-basis timing, a cash-flow form for
  **Compare** (left open deliberately), the **trend-bucketing** question — whether the grain picker
  should be the sole control — and the **Trends-tab double-count audit**, gated on that tab gaining a
  tag-report selector and unrelated to cash flow despite sharing the file.
- [import-input-formats.md](import-input-formats.md) — **SimpleFIN shipped 2026-08-07; the file formats
  deferred, ranked.** New *file* ingestion formats behind a shared **parse-seam extraction**: XLSX (Tier 1,
  reuses everything) and OFX/QFX/QBO (Tier 2, mapping-free + FITID dedupe). SimpleFIN was the separate
  Plaid-parallel connection/sync track in the same file, and has landed.
- [import-dedupe-followups.md](import-dedupe-followups.md) — **deferred (not safety).** Auto-restore
  deduped rows when a contributing import is undone, and a duplicate-resolution history view + batch
  undo. Both convenience only — per-row restore already prevents loss. Also holds two measured/scoped
  deferrals: bank-side type prefixes, and letting a coverage reject rest on the actual twin rather than
  on whichever same-amount row filled the candidate slot (the report half of that one shipped).
- [merchant-rename-fate.md](merchant-rename-fate.md) — **dormant code, decision pending.** Keep-or-drop
  the unwired `merchants.py` / `merchant_rename` CRUD (its role was absorbed by
  `category_rule.clean_name`); revisit when Plaid sync is exercised.
- [backup-restore-scope-and-secrets.md](backup-restore-scope-and-secrets.md) — **credentials backup landed
  2026-08-10; streaming both directions landed 2026-08-23; the scope/UX half is what remains.** The payload
  version-10 envelope (`meta.json` + `sections/<name>.ndjson` + `documents/<id>`), streaming export and
  restore, the incremental cipher, referential repair as SQL and the CSV export all shipped — and
  `restore_state` plus the resumable documents phase landed with
  [transaction-attachments.md](transaction-attachments.md) on 2026-08-24. Fixed on the way: a data restore
  left every connection's `transactions_cursor` ahead of the ledger it had just rolled back. What remains is
  the scope/UX half. Make each backup's *scope* explicit on the Backup page and add a coherent **accounts &
  secrets** backup — the control DB (identities, perimeter, `vault_slot`) **plus** the data DB's vaulted
  tokens, which phase 3 made cryptographically coupled (ciphertext in data DB, keys in control DB). Adds a
  sectioned **back up all**, moves recipient management onto the Backup page, and a **restore flow that asks
  how to reconcile identities** (always preserves the current admin → no self-lockout, no silent perimeter
  overwrite). Motivated by restore-over-existing ≠ restore-onto-fresh.
- [deployment-topologies.md](deployment-topologies.md) — **reduced 2026-09-02 to what is genuinely
  unbuilt.** The settled half — the shapes and what each binds to, the data directory, the shell decision
  and every other rejected alternative — is in [`../operations.md`](../operations.md), with building in
  [`../releasing.md`](../releasing.md) and the mechanism in `architecture.md`. What stays here: **Shape A**
  (a LAN server) has requirements written down but nothing shipped — no Caddyfile, no systemd unit, no
  install sequence — plus the mDNS name and the one empirical unknown (whether a `.local` name is accepted
  as a WebAuthn RP id); and **Shape B step 3's remainder**, which is only what CI structurally cannot
  reach and needs a Mac in front of somebody — the Dock lifecycle, Gatekeeper, and the log-file redirect.
- [i18n-display-formatting.md](i18n-display-formatting.md) — **currency half shipped (2026-08-08); the
  date/number half deferred.** Tier-1 **formatting**, not translation. The ledger-currency setting and
  its display path landed (`lib/moneyDisplay.js`, `services/ledger_currency.py`); what remains is the
  number/date display bucket (cosmetic) and the free-text-parse bucket (the quick-filter date/amount
  ambiguity — the only correctness risk).
- [query-cache-invalidation.md](query-cache-invalidation.md) — **parked, maybe never.** Swap the
  hand-wired `notifyTransactionsChanged` refresh map for dependency-based (query-key) invalidation —
  only if transaction-derived views proliferate enough to hurt.
- [lint-and-tooling.md](lint-and-tooling.md) — **deferred.** Two "enable → measure → triage → gate"
  linter passes: raise eslint strictness beyond the narrow baseline, and make the aspirational **ruff**
  config real (wire it in; adopt `flake8-datetimez` over the bespoke timestamp guard).
- [test-coverage-gaps.md](test-coverage-gaps.md) — **running checklist.** Owed tests: rule-collision
  HTTP + E2E + component coverage, the migration/fresh-schema parity guard (build with the first
  post-rebrand migration), rule-suggestion owner-scope stability, and a component-test harness for
  `Settings.jsx`, which has none of any kind. Also records the E2E harness that *is* available
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
  recategorization, with a concrete hole in bulk `add_tags` to look at first. Its *Finish the backlog
  prose pass* entry is superseded by [`../doc-restructure.md`](../doc-restructure.md) and should be removed
  from there when the first disposal lands.

## Completed (kept for the record)

Shipped work whose durable rules now live in the main docs. These files are kept because they still
carry something the main docs should not — a rejected design, an obstacle list, a "read this before
reintroducing X". Nothing here is pending.

- ~~transaction-splits.md~~ — **disposed 2026-09-02, file deleted.** The mechanism and every invariant
  were already in `data-model.md` → *Transaction splits*, and the row/editor behaviour in
  `ui-patterns.md`. Its forks now live in [`../mechanism-index.md`](../mechanism-index.md): the
  per-item-rows model abandoned twice, the **two-parts-in-one-category** rule imposed and then reversed
  (*don't re-impose it* — the fix is counting `DISTINCT` transactions, not constraining what the user
  may record), rules never authoring a split, and mixed-sign parts as a coherent later relaxation that
  is **not** a prerequisite for reimbursements. The pre-fill refusal edges went to `data-model.md`.
  `services/txn_splits.py` cites both.
- ~~multi-payment-purchases.md~~ — **disposed 2026-09-02, file deleted.** Its "three neighbours it is
  not" table was the hand-rolled version of [`../mechanism-index.md`](../mechanism-index.md), which is
  now the real one; the four reasoned exclusions (automatic suggestion with its OCR re-open condition, a
  document on the link rather than a payment, an age-gated Tasks entry, a purchases list page) went to
  `data-model.md` → *Multi-payment purchases*.
- [vault-passphrase-recovery.md](vault-passphrase-recovery.md) — **complete 2026-09-01; kept for its
  rejected shapes and one owed test.** The recovery ladder is built: a **vault recovery code** (a third
  `vault_slot.method`, one per user, recovered and re-keyed in a single atomic request), the destructive
  **reset** with its lost-vs-compromise split and capability-driven revocation, `VaultDecryptError`
  classified as *reconnect needed*, and **re-link adoption**. The durable rules live in
  `architecture.md` (the vault section), `data-model.md` (a connection may hold no credential) and
  `building-a-connector.md` (where the connection handle comes from). What this file still holds is the
  reasoning behind two reversals worth not re-litigating — why the other-member check became a
  **redirect rather than a refusal**, and why a **single** recovery code is as safe as a set — plus the
  corrected account of what a re-link actually strands (coverage and cursor, *not* the mappings). The
  **second pass (2026-09-01)** closed two defects in what shipped and one wider finding behind them:
  `set_passphrase`, `register_passkey_slot` and `issue_recovery_code` each minted a *durable* unlock method
  from a DEK merely found in the unlock cache, turning transient access to an unlocked session into
  permanent independent access — now a five-minute proof window on every door that mints one, plus a passkey
  route to a new passphrase and the re-enrollment rung that had never executed. One test is still owed:
  reset → set → restore a credentials backup taken under the old passphrase.
- ~~list-virtualization.md~~ — **disposed 2026-09-02, file deleted.** The windowing rules had already
  been folded into [`../ui-patterns.md`](../ui-patterns.md); what it still held — the one list left
  unwindowed on purpose and its four obstacles, plus the measurement method (re-baseline on a production
  build; attribute before optimizing) — is in [`../scale-and-limits.md`](../scale-and-limits.md).
  `ImportRuleSuggestionReview.jsx` cites it there now.
- ~~transaction-list-limits.md~~ — **disposed 2026-09-02, file deleted.** The `limit` contract was
  already in `data-model.md`; the caps that remain **on purpose** — the 36/60-month drawer trend windows
  and the "All time" label that over-promises because of them, the trend-length server caps, the
  money-movement preview undercount and the trash list — are now a table in
  [`../scale-and-limits.md`](../scale-and-limits.md) with what each costs and what would have to be
  observed before revisiting it.
- [security-and-deployment-model.md](security-and-deployment-model.md) — **disposed 2026-09-02 into
  [`../security-model.md`](../security-model.md); a residual stub remains.** The design record — the
  threat model, the identity perimeter, secret custody, enrollment/revocation/rotation, the transport
  policy and every rejected shape — moved to that topic doc. What is left in the file is the
  build-phase log, which is *not* purely a work log: migration numbers, AAD schemes, endpoint names and
  payload-format versions are mixed into it and read as `architecture.md` material. Relocating them is
  its own pass; until it runs, the file is the only record of facts like *migration v18 folds the legacy
  provider-item rows in carrying the ciphertext verbatim*.
- ~~pre-auth-security-ui.md~~ — **disposed 2026-09-02, file deleted.** The Settings-forms rebuild it
  tracked shipped in 2026-07-30; what it held past that was a work log of what a lint cleanup had
  removed and what would have to be stitched back. The identity-perimeter substance is in
  [`../security-model.md`](../security-model.md); the forms themselves are in `Settings.jsx`.
- ~~optional-env-and-layered-config.md~~ — **disposed 2026-09-02, file deleted.** `.env` is optional and
  the layered precedence is settled. The operator's half — the layer order, the irreducible env core, the
  permanent per-file overrides, the two-installations case, and every rejected alternative — is in
  [`../operations.md`](../operations.md); the mechanism is in `architecture.md` → *Configuration layers*;
  why app-level provider credentials left `.env` is in [`../security-model.md`](../security-model.md). Its
  one unbuilt follow-up, the mDNS service name, is carried in `operations.md` → *Open*.

## Related (already tracked elsewhere)

- `docs/import-source-fields-plan.md` Phase 3 — user-selectable transaction-report columns drawn from
  the import-source field registry. Parked there ("maybe never"); not duplicated here.
