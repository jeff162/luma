# Backlog

Deferred and parked work that is **not** blocking current features. Each file is one initiative,
written so it can be picked up cold.

> **The keep-and-link rule below is being replaced.** [`../doc-restructure.md`](../doc-restructure.md)
> is the committed plan to retire completed project files entirely — rewriting what each holds into
> topic-organized reference docs rather than keeping the file and linking to it, since a link to a
> project filename decays and one already has. Read it before disposing of a shipped item. It is parked
> behind two `pre-release.md` features as of 2026-08-26, and takes the **Completed** section with it
> when it lands.

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
> plan — five features drawn from the files below, plus the release mechanics. Items named there are
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
- [recurring-detection.md](recurring-detection.md) — **follow-ups to a shipped feature.** The recurring-
  series subsystem is live (detect + list + curate), and the "Mark as recurring" row action has since
  shipped in the shared context menu (`markRecurringFromMenu`). Deferred pieces are the per-import
  matching hook and the anomaly/forecast signals (upcoming / missed / new / price-change).
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
- [transaction-attachments.md](transaction-attachments.md) — **backlog, not started (2026-08-20).**
  Attach a receipt or invoice to a transaction — photo, PDF, screenshot, pasted clipboard content —
  through **one format-agnostic ingestion seam**, and where possible make its text searchable. Tiered so
  most of the value needs no network call: store-only always, **PDF text-layer extraction free and
  unconditional** (the emailed-invoice case), local OCR as a *declared capability* (Tesseract is a system
  binary, painful in the frozen builds), and structured line-item extraction only as an opt-in BYOK
  adapter with per-result approval. Records why local document-ML and template-based tooling are both
  out, and that **email means copy/paste — never a mailbox**. Key finding: tier 3 is the *same subsystem*
  as [online-categorizer.md](online-categorizer.md) (opt-in external call, structured output,
  approve-before-apply) and the two should be designed together. Blocked on one real decision — where
  attachments live, which belongs to the backup-scope work.
- [transaction-splits.md](transaction-splits.md) — **backlog, not started (2026-07-23).** Let a single
  transaction's amount be split across several categories (a Costco run, an Amazon order with mixed items).
  A **general** feature on any transaction, modeled as a `txn_split` allocation table (one ledger row, N
  category/amount parts) with reporting routed through an "effective category rows" seam — deliberately not
  the abandoned per-item-rows model. Amazon orders **pre-fill** the split by reallocating net cash across
  items in proportion to list price (list prices exclude tax/shipping/discounts, so they can't be used
  directly). Main cost is the cross-cutting reporting-expansion change.
- [reimbursable-expenses.md](reimbursable-expenses.md) — **backlog, not started (2026-08-21).** Money
  that leaves as an expense and returns later (tickets bought for friends, work expenses claimed back).
  The categorization is already right; the problem is that the netting **crosses period boundaries**, so
  a month overstates spending until the repayment lands. Models it as a **receivable category** carrying
  the existing `exclude_from_totals` treatment — nothing is restated, nothing is asserted about a
  repayment that may never come, and "who still owes me" is the category's sum. The design turns on the
  **residual**: a repayment is often *not* equal (tickets resold at a loss or a profit), a short
  repayment and an unpaid one are indistinguishable by amount, so a **settle** action is what moves the
  leftover to a real category. Pairing is **optional and late** — needed only to settle, and served by
  `txn_link` (`kind='reimbursement'`) rather than a new table. Downstream of
  [transaction-splits.md](transaction-splits.md), and a second consumer justifying it.
- [refactor-audits.md](refactor-audits.md) — **recurring process.** Periodically hunt duplication /
  shotgun-surgery smells (structural tools + a judgment pass), fix the safe ones. Records the first
  run's shipped items (`getFormControlStyle` in Dashboard, `TransactionListToolbar`, `useTags()`), the
  deferred candidates (row-patch util, the four drill panels), and the next scope (**backend audit**).
- [help-topic-search.md](help-topic-search.md) — **parked, not started (2026-07-25).** A search box on the
  `/help` topic index (in the sticky header) to find articles by typing. Parked because it's of limited
  use until the match reaches article *body* text, not just titles/summaries — and bodies are JSX, so
  that needs a per-topic `keywords` field (ongoing authoring) rather than free full-text search.
- [tag-report-exclude-warning.md](tag-report-exclude-warning.md) — **parked, not started (2026-07-26).**
  A small inline note on the Dashboard tag-report view when a filter chip references a tag the active
  report is built from (the exclude is honored, not suppressed — the note just explains the subset).
  Parked for a larger tag-report pass rather than a one-off; the behavior is already correct without it.
- [transaction-list-limits.md](transaction-list-limits.md) — **surveyed, mostly resolved (2026-07-27).**
  Every scoped transaction list now paginates with server-side sort (the `limit: 1000`/`500`/`200` caps
  that silently truncated rendered lists are gone), plus a `limit=0` no-limit opt-in and a dev-mode
  truncation warning. This file records the caps that **remain on purpose** (the 36/60-month detail-drawer
  trend windows; "All time" means recent history there) and the few **deferred fix candidates**
  (money-movement Type preview `1000`, trash list `200`).
- [import-history-windowing.md](import-history-windowing.md) — **lossy cap fixed; archive UX deferred
  (2026-07-30).** The import history's silent global `LIMIT 50` (older cards — and whole crowded-out
  sources — vanished with no indication) is gone: `list_batches` now returns the full completed history.
  Deferred: the actual windowing — a per-source recent window with a reachable **"Older imports"** archive
  grouped by year (marketplace cards too), a *reachable* re-bound on the fetch, and an explicit
  batch-history deletion strategy (purge records, not the imported transactions).
- [vault-passphrase-recovery.md](vault-passphrase-recovery.md) — **backlog, not started (2026-08-13).**
  A forgotten vault passphrase is currently a dead end — `unlock` needs it and `set_passphrase` needs the
  vault already unlocked — with no endpoint and no UI for a state every install eventually reaches. Sets
  out the recovery ladder in order: a **credentials backup opened with the passphrase it was made under**
  is a complete recovery needing no re-linking (and `credentials_export` already knows whether one
  exists), with a destructive **reset** — drop the slot, clear the two encrypted columns, flag every
  connection for reconnection, keep every account and transaction — as the only other option. Names the
  wrinkle that decides how good this can be: `connect` upserts on `(provider, external_id)`, so a
  provider whose handle is **issued** (Plaid's `item_id`) re-links in place while one whose handle is
  **derived from the credential** (SimpleFIN's access-URL hash) arrives as a new connection, stranding the
  old one's account mappings. Open: multi-user (another member's slot still opens the same DEK — that is
  re-enrollment, phase 5, not a reset). **Expanded 2026-08-21:** compromise is a second, independent
  motivation for the same reset (re-linking retires a stolen credential by re-issuing it, which beats
  trusting a revocation call); reset should **revoke on the way out**, driven by `revokes_on_disconnect`
  rather than by naming a provider — except in the very case that motivated this file, since revocation
  needs a decrypted token, so a *lost*-passphrase reset can revoke nothing at all and must instruct
  manually for every provider. That split is why the dialog asks which situation the user is in. Also adds
  **vault recovery codes**: the 2FA sign-in path has them, the vault has none, and `vault_slot.method`
  already generalizes to a third kind — they would give the single-user install a rung above "destroy it",
  making the destructive reset rare rather than routine. Also flags an existing bug worth fixing regardless
  — `VaultDecryptError` is unclassified and reports as a generic sync failure instead of "reconnect
  needed".
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
- [dashboard-reporting.md](dashboard-reporting.md) — **designed, not started (2026-08-20).** Cash flow
  as a third frame on the Expenses/Income selector — a **Sankey** for a single period, diverging bars
  plus a net line for trends — settled on the existing `exclude_from_totals` flag rather than any new
  transfer-pairing or per-view exclusion machinery, with a deferred `cash_date` phase for cash-basis
  timing. Plus a **Trends-tab double-count audit** to do before the tag-report selector reaches Trends
  mode.
- [import-input-formats.md](import-input-formats.md) — **deferred, ranked.** New ingestion formats
  behind a shared **parse-seam extraction**: XLSX (Tier 1, reuses everything), OFX/QFX/QBO (Tier 2,
  mapping-free + FITID dedupe), and SimpleFIN (a Plaid-parallel connection/sync track).
- [import-dedupe-followups.md](import-dedupe-followups.md) — **deferred (not safety).** Auto-restore
  deduped rows when a contributing import is undone, and a duplicate-resolution history view + batch
  undo. Both convenience only — per-row restore already prevents loss.
- [merchant-rename-fate.md](merchant-rename-fate.md) — **dormant code, decision pending.** Keep-or-drop
  the unwired `merchants.py` / `merchant_rename` CRUD (its role was absorbed by
  `category_rule.clean_name`); revisit when Plaid sync is exercised.
- [backup-restore-scope-and-secrets.md](backup-restore-scope-and-secrets.md) — **unblocked: the phase-6
  gate is MET and the credentials-backup piece has landed (2026-08-10).** What remains is the scope/UX
  half. Make each backup's *scope* explicit on the Backup page and add a coherent **accounts &
  secrets** backup — the control DB (identities, perimeter, `vault_slot`) **plus** the data DB's vaulted
  tokens, which phase 3 made cryptographically coupled (ciphertext in data DB, keys in control DB). Adds a
  sectioned **back up all**, moves recipient management onto the Backup page, and a **restore flow that asks
  how to reconcile identities** (always preserves the current admin → no self-lockout, no silent perimeter
  overwrite). Motivated by restore-over-existing ≠ restore-onto-fresh.
- [deployment-topologies.md](deployment-topologies.md) — **Shape B steps 1–2 done (2026-08-19), step 3
  deferred; Shape A notes only.** Also records the Python 3.12–3.13 build ceiling (pydantic-core has no
  3.14 wheels) and the tag-triggered release workflow, which has not yet run — the Windows artifact is
  the one piece of step 2 never actually produced. How Luma is *packaged and run* (vs. who may reach it): a **LAN server + Caddy** shape and a
  **single-user desktop** shape. The shell question is settled by passkeys — the browser-launcher wins
  because `prf` needs a real browser, and the RP id being the *hostname* makes `localhost` (never
  `127.0.0.1`) load-bearing, and makes mDNS + HTTPS a passkey precondition on the LAN rather than
  polish. Also: the shared SPA-serving addition, and the portable-vs-installed rule for where the
  databases live.
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
  post-rebrand migration), and rule-suggestion owner-scope stability.
- [database-diagnostics.md](database-diagnostics.md) — **backlog, not started (2026-08-10).** Nothing
  ever checks that the databases are intact — no health surface, and notably no check of the *target*
  before a destructive restore. Structural half is small (`integrity_check` + `foreign_key_check`, ~100 ms
  on a 60 MB DB; note the former does **not** cover foreign keys). The larger half is an invariant
  checker for the semantic inconsistencies those pragmas call "ok" — kept deliberately separate.
- [misc-followups.md](misc-followups.md) — **catch-all.** One-offs too small for their own file:
  the unwritten CHANGELOG entry for the category-owner → tag migration, a denser Connections-tab card
  layout, SimpleFIN's 90-day window becoming a silent cap, whether timestamps should ever be relative,
  and the stalled-request gap a blanket request timeout was rejected for.

## Completed (kept for the record)

Shipped work whose durable rules now live in the main docs. These files are kept because they still
carry something the main docs should not — a rejected design, an obstacle list, a "read this before
reintroducing X". Nothing here is pending.

- [list-virtualization.md](list-virtualization.md) — **effectively complete (2026-07-19); kept for its
  notes.** `MatchReport`, `TransactionListTable`, the Transactions ledger and the Rules list all window
  through the shared `WindowedRows`. The durable rules live in `ui-patterns.md` (windowing needs a
  content-independent column geometry; sort/selection stay driven from the full list; no scanning
  row-id helpers; no `content-visibility` on a windowed row). What this file still holds is the record
  of the one list left unwindowed **on purpose** — `ImportRuleSuggestionReview` — and the four
  obstacles a future attempt would have to clear.
- [security-and-deployment-model.md](security-and-deployment-model.md) — **COMPLETE (2026-08-13); every
  phase built.** The settled security/deployment design: drop multi-tenant hosted;
  one shared workspace with multiple login identities (login = perimeter, admin gates settings not data);
  provider credentials protected by **multi-wrap envelope encryption** (one workspace DEK reachable through
  a per-user slot guarded by a passphrase or a WebAuthn-PRF **passkey** — separate from login). Also
  generalizes to **provider-agnostic connections** (a `connection`/adapter seam, Plaid then SimpleFIN; app
  credentials moved from `.env` into the vault; connections stay on the Accounts → Connections tab), and
  carries the **transport-security policy** (HTTP-vs-HTTPS per topology). The final phases (4–5) replaced
  the planned bearer-secret **invite ceremony** with **keypair slots** — a slot owns an X25519 keypair
  rather than wrapping the DEK directly, so access can be granted from a public key alone. That made
  enrollment "enrol → approve" with no secret in transit, and made **key rotation** able to preserve every
  remaining member, which the original design could not do at all. Read that section before reintroducing
  any invite/bearer-code design.
- [pre-auth-security-ui.md](pre-auth-security-ui.md) — **DONE (2026-07-30).** The three Settings forms
  (security profile / sign-in protection / password policy) were rebuilt and session-wired alongside
  phases 1–2b of [security-and-deployment-model.md](security-and-deployment-model.md).
- [optional-env-and-layered-config.md](optional-env-and-layered-config.md) — **DONE (2026-08-18).**
  `.env` is now optional: layered precedence (defaults < DB-backed settings < env override), the session
  secret generated and stored in the control DB on first run, the blocking first-run setup screen and the
  `.env`-writing endpoints removed, and the launchers no longer creating the file. The irreducible env
  core is DB paths / ports / launcher knobs / the developer gate (the "two installations on one host"
  case). Settings → Configuration reports every effective value and its layer. The doc keeps the
  decisions and one deliberate follow-up (an mDNS service name, env-only like the ports).

## Related (already tracked elsewhere)

- `docs/import-source-fields-plan.md` Phase 3 — user-selectable transaction-report columns drawn from
  the import-source field registry. Parked there ("maybe never"); not duplicated here.
