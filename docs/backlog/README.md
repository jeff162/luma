# Backlog

Deferred and parked work that is **not** blocking current features. Each file is one initiative,
written so it can be picked up cold. This is a living list: when an item ships, fold its durable
"what it is and why" into the main docs (`architecture.md` / `data-model.md` / `ui-patterns.md`) and
delete the backlog file.

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
- [list-virtualization.md](list-virtualization.md) — **scale/perf, deferred.** Render-window the large
  lists (duplicate-rows dialog first, then `TransactionListTable` / the ledger) so DOM node count is
  bounded by the viewport, not the dataset. Built into the shared table shells; preserves sticky pill
  header, column-pref grid template, and select-all-matching bulk edit.
- [recurring-detection.md](recurring-detection.md) — **follow-ups to a shipped feature.** The recurring-
  series subsystem is live (detect + list + curate); deferred pieces are the per-import matching hook,
  the anomaly/forecast signals (upcoming / missed / new / price-change), and a "Mark as recurring" row
  action in the shared transaction context menu.
- [button-consolidation.md](button-consolidation.md) — **design-system task, deferred.** Audit the app's
  button treatments (shared `Button` + bespoke one-offs that have drifted) and settle on one shared set
  of sizes/variants, then migrate the one-offs. Central decision is solid-vs-soft-tint primary and the
  ghost drop shadow, not just pixel size.
- [account-type-as-rule-criterion.md](account-type-as-rule-criterion.md) — **backlog, not started
  (2026-07-20).** Generalize "restrict to PayPal/Amazon" from per-account-id scoping to **account *type***
  as a first-class axis for rules (and filtering/search): add PayPal as an account type, add an
  account-type rule criterion (parallel to the existing account-id one), and structured account-type
  filters — with a `accttype:`/`acctname:` tag grammar flagged as the harder free-text-search piece.
  Money-movement rules are the first consumer ready to migrate. Punts on existing data.
- [paypal-money-movement-recognition.md](paypal-money-movement-recognition.md) — **shipped; deferred
  remainder only.** PayPal source recognition, force-captured `Type`/`Item Title`, and the user-approved,
  account-scoped, bidirectional `Type` → *Money movement* rules all landed (2026-07-20) and are folded into
  the main docs. What remains: fold the dedicated review into the generic rule-suggestion engine (cluster by
  `Type`), and migrate the rules from account-id to account-type scope once that axis exists.
- [transaction-splits.md](transaction-splits.md) — **backlog, not started (2026-07-23).** Let a single
  transaction's amount be split across several categories (a Costco run, an Amazon order with mixed items).
  A **general** feature on any transaction, modeled as a `txn_split` allocation table (one ledger row, N
  category/amount parts) with reporting routed through an "effective category rows" seam — deliberately not
  the abandoned per-item-rows model. Amazon orders **pre-fill** the split by reallocating net cash across
  items in proportion to list price (list prices exclude tax/shipping/discounts, so they can't be used
  directly). Main cost is the cross-cutting reporting-expansion change.
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
  re-enrollment, phase 5, not a reset). Also flags an existing bug worth fixing regardless —
  `VaultDecryptError` is unclassified and reports as a generic sync failure instead of "reconnect needed".
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
- [backup-restore-scope-and-secrets.md](backup-restore-scope-and-secrets.md) — **parked, do after phase 6
  (2026-08-01).** Make each backup's *scope* explicit on the Backup page and add a coherent **accounts &
  secrets** backup — the control DB (identities, perimeter, `vault_slot`) **plus** the data DB's vaulted
  tokens, which phase 3 made cryptographically coupled (ciphertext in data DB, keys in control DB). Adds a
  sectioned **back up all**, moves recipient management onto the Backup page, and a **restore flow that asks
  how to reconcile identities** (always preserves the current admin → no self-lockout, no silent perimeter
  overwrite). Motivated by restore-over-existing ≠ restore-onto-fresh. Waits on phase 6 (app creds into the
  vault).
- [pre-auth-security-ui.md](pre-auth-security-ui.md) — **DONE (2026-07-30).** The three Settings forms
  (security profile / sign-in protection / password policy) were rebuilt and session-wired alongside
  phases 1–2b of [security-and-deployment-model.md](security-and-deployment-model.md).
- [deployment-topologies.md](deployment-topologies.md) — **Shape B steps 1–2 done (2026-08-19), step 3
  deferred; Shape A notes only.** Also records the Python 3.12–3.13 build ceiling (pydantic-core has no
  3.14 wheels) and the tag-triggered release workflow, which has not yet run — the Windows artifact is
  the one piece of step 2 never actually produced. How Luma is *packaged and run* (vs. who may reach it): a **LAN server + Caddy** shape and a
  **single-user desktop** shape. The shell question is settled by passkeys — the browser-launcher wins
  because `prf` needs a real browser, and the RP id being the *hostname* makes `localhost` (never
  `127.0.0.1`) load-bearing, and makes mDNS + HTTPS a passkey precondition on the LAN rather than
  polish. Also: the shared SPA-serving addition, and the portable-vs-installed rule for where the
  databases live.
- [optional-env-and-layered-config.md](optional-env-and-layered-config.md) — **DONE (2026-08-18).**
  `.env` is now optional: layered precedence (defaults < DB-backed settings < env override), the session
  secret generated and stored in the control DB on first run, the blocking first-run setup screen and the
  `.env`-writing endpoints removed, and the launchers no longer creating the file. The irreducible env
  core is DB paths / ports / launcher knobs / the developer gate (the "two installations on one host"
  case). Settings → Configuration reports every effective value and its layer. The doc keeps the
  decisions and one deliberate follow-up (an mDNS service name, env-only like the ports).
- [i18n-display-formatting.md](i18n-display-formatting.md) — **deferred.** Tier-1 currency-symbol +
  number/date **formatting** (not translation): a display bucket (cosmetic) and a free-text-parse bucket
  (the quick-filter date/amount ambiguity — the only correctness risk).
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
- [misc-followups.md](misc-followups.md) — **catch-all.** One-offs too small for their own file;
  currently the unwritten CHANGELOG entry for the category-owner → tag migration.

## Related (already tracked elsewhere)

- `docs/import-source-fields-plan.md` Phase 3 — user-selectable transaction-report columns drawn from
  the import-source field registry. Parked there ("maybe never"); not duplicated here.
