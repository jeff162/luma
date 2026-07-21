# Architecture

This document provides a compact technical overview of Luma.

For domain concepts such as ownership, categories, and rules, see `data-model.md`.

For UI interaction patterns and shared behavior, see `ui-patterns.md`.

## Contents

- [High-level shape](#high-level-shape)

- [Backend structure](#backend-structure)

- [Frontend structure](#frontend-structure)

- [Data flow](#data-flow)

- [Major subsystems](#major-subsystems)

- [Cross-platform approach](#cross-platform-approach)

- [Where to change things](#where-to-change-things)

## High-level shape

Luma is a local-first web application with:

- a **FastAPI** backend in `backend/`

- a **React + Vite** frontend in `frontend/`

- **SQLite** as the persistent store

The browser talks only to the local backend API. Core application data and persistence are local; external network dependencies are limited to optional integrations such as Plaid.

## Backend structure

- **`backend/main.py`:** bootstrap, middleware, and router registration

- **`backend/db/database.py`:** SQLite connection handling, schema creation, and seed data

- **`backend/routers/`:** feature-oriented API endpoints

- **`backend/services/`:** shared backend logic such as categorization and crypto helpers

The backend favors explicit SQL and feature-oriented router modules over a heavy ORM layer.

## Frontend structure

- **`frontend/src/App.jsx`:** app shell, navigation, page routing, and route-level lazy loading for the main screens

- **`frontend/src/pages/`:** top-level screens such as Dashboard, Transactions, Rules, and Import / Export

- **`frontend/src/components/`:** shared UI and interaction building blocks

- **`frontend/src/lib/api.js`:** central API wrapper used by the frontend

- **`frontend/src/lib/FilterContext.jsx`:** shared date/account/owner/group filtering state

- **`frontend/src/lib/AppSessionContext.jsx`:** shared bootstrap/session metadata such as the active preference subject and database instance id so pages can reuse shell-loaded auth state instead of re-fetching it

The frontend mixes page-specific screens with a small set of shared interaction surfaces:

- **`TransactionRow.jsx`:** shared transaction display/editing behavior

- **`detailShared.jsx`:** shared detail-panel shell, chart, and lazy-loading behavior

- **`components/ui.jsx`:** shared visual primitives for cards, buttons, floating panels, overlays, form control styling, and everyday confirm/notice/text-entry dialogs

- **`lib/uiInteractions.js`:** shared interaction hooks for dismissible layers, popups, escape handling, and transient text editing

- **`components/TransientTextInput.jsx`:** shared single-field transient edit control used when Enter/blur should commit and Escape should cancel back to the pre-edit value

There are shared primitives designed to create a uniform user experience. Unless a frontend interaction has special requirements, it should use the shared interaction primitives in `frontend/src/lib/uiInteractions.js` and `frontend/src/components/TransientTextInput.jsx` instead of a page-local version. Search boxes, filters, and other intentionally custom controls sometimes contain page-specific logic.

The concern behind this is interaction drift. Repeated popovers, inline editors, and dismissal rules are easy to make "almost the same" on each page, which creates both subtle bugs and a less coherent product feel over time.

- **Local-mode onboarding:** when auth is off and no local preference profiles exist yet, `App.jsx` opens a first-run welcome flow that creates the initial local profile and then routes the user once to a chosen data-entry surface — import a CSV, connect a data source, load the demo dataset, or skip into an empty app. Getting data in is the point of the flow; account owners, additional profiles, and categorization setup are deferred to the normal app surfaces rather than collected up front. The chosen destination is a **one-time** navigation, deliberately distinct from the persisted startup-route preference (which stays at its default so later launches land on the dashboard, not back on import/accounts).

Keeping this in `App.jsx` makes it part of bootstrap rather than a repeatable workflow. The main need is to block the ordinary shell until there is enough local-profile state to scope preferences cleanly, not to create a long-lived page in the app’s information architecture. The welcome flow guides the user toward their first import because that data is what activates the rest of the app; the supporting concepts are introduced where they become relevant (e.g. a post-import nudge about categories) instead of as onboarding prerequisites.

- **Demo data — built through the real pipeline:** the demo is constructed by generating CSV files and importing them via `run_import_core` (the import endpoint's reusable, in-process core), not by hand-inserting rows. So it has genuine batches, per-account coverage, dedupe results, and saved data sources — the file cards look exactly like real imports. It generates two sources with different header formats: one *with* a category column imported "using imported categories" (creates `Pet Care` under Unassigned, maps the rest onto starter leaves), and one *without* (rows categorized only by the rules it then seeds, or left uncategorized). One transaction is duplicated across the two files/accounts so the real post-import sweep flags it. `load_demo_data` passes its own `conn` to `run_import_core` so the whole build is one transaction.

- **Demo data — mode + safe teardown:** loading the demo set writes a marker (`demo_data` in the data DB's `import_workflow_state`). While it is present the app shows a global "demo data" strip in the shell and the backend **blocks new-data operations** (CSV import, data-source connect, backup restore) with a 409. That block is the safety mechanism: because nothing non-demo can be added, *all* data is demo data, so "clear demo data" can wipe the whole tenant data DB. The clear endpoint (`POST /auth/demo-data/clear`) **refuses unless the marker is present**, so it can never run against real data (which never carries the marker); it reuses the same `_wipe_user_data_tables` helper restore uses (one wipe order, FK checks deferred), then re-seeds the group skeleton, returning the tenant to the clean first-run state. The wipe is scoped to the tenant data DB — local profiles and credentials are untouched. This is the one user-facing destructive reset; the developer reset tools below remain separate, lower-level, and layer-specific.

## Data flow

Typical request flow:

1. A page reads global filters from `FilterContext`

2. The page calls `api.js`

3. FastAPI router executes SQL against SQLite

4. JSON response returns to the page

5. Local state updates, often optimistically for inline edits

For many inline edits, the UI updates first and the API call is fire-and-forget. This keeps interaction responsive and is acceptable because the backend remains the durable source of truth and the expected level of concurrent editing is low.

This is a deliberate tradeoff toward local responsiveness. Luma is optimized for a mostly single-user, local-first workflow, so a small amount of optimistic UI is preferable to making everyday edits feel remote or form-heavy.

## Major subsystems

### Transactions and summaries

- **Backend:** `backend/routers/transactions.py`

- **Handles:** transaction lists, category overrides, merchant name edits, and summary queries for dashboard and detail panels
- **Uncategorized contract:** transactions with `category_id = NULL` stay as one stored state, while shared summaries and tree surfaces may expose separate synthetic expense and income buckets so uncategorized credits do not masquerade as expense activity

- **Signed monthly totals:** `/summary/monthly-trend` returns signed sums (no `ABS()`), so refunds in an expense scope render as negative bars instead of being folded into magnitudes. A `view` query parameter (`spending` | `income` | `cash_flow`) chooses the cross-cutting frame when no category/payee scope is given; for a category scope, the sign is auto-flipped for income-type categories so received income reads as positive. The cross-cutting frames also exclude categories marked `exclude_from_totals` so transfers do not pollute dashboard totals.

- **Tag-scoped transaction filtering:** the `/transactions` list endpoint accepts the same `view` (`spending` | `income`) for dashboard-style scoping. The `tag_ids` filter matches a transaction through any of three paths — direct (`txn_tag`), inherited from leaf category (`category_tag`), or inherited from parent group (`category_tag`) — so tag-aware reporting picks up tags applied at the most natural level.
- **Bulk edit:** `POST /transactions/bulk` applies one or more field changes to a selection. The selection is either an explicit id list or `{mode:'filter', filter, exclude_ids}` — filter mode resolves the target rows server-side from the **same** WHERE the list feed uses (both go through the shared `_build_transaction_filter` helper), so "select all matching" covers rows the client never loaded. Actions (`set_category` — leaf-only, reuses the per-row guard; `add_tags`/`remove_tags`; `set_notes`; `set_merchant`; `set_date`; `mark_reviewed` — clears the `needs_review` flag; `trash`) are applied in one transaction. Delete is soft-delete to the existing transaction trash, not a separate state. `set_date` is bulk-only (no per-row date endpoint exists).
- **Used by:** Transactions page and dashboard/detail drill-down surfaces

### Rules and categorization

- **Storage:** `category\_rule`

- **Runtime:** categorizer service

- **Behavior:** rules are ordered automatically by specificity; rules can assign categories, scope amount rules to debits or credits, rename merchants, and add transaction tags; manually overridden transaction categories are preserved, while per-transaction tag edits override only that row's rule-derived tag presence

- **Applying a match (shared, per action):** every path that runs rules — CSV import, Plaid sync, and `recategorize_all` (plus its preview count) — matches once via `categorize_transaction`, then applies the result through shared apply points rather than re-deriving it each place: tags via `sync_rule_tags_for_transaction`, and the scalar actions (the merchant rename today, a rule-set note tomorrow) via `rule_scalar_effects`. Category *source* policy stays site-specific (import has mapping/file-label fallbacks; recategorize preserves a `cleared` marker). Keeping each action in one place is what stops sites drifting — the CSV import path had silently dropped the rename before this was centralized — and makes a new scalar rule action a one-place change

- **Starter set (opt-in):** the built-in categories and rules are not seeded at tenant creation — only the group skeleton is. The starter leaves and rules are added on demand via `POST /categories/generate-starter` (`GET /categories/starter-rules` exposes the rule catalog for the approve-before-add picker), which backs the onboarding steps, the Categories/Rules-page actions, and the demo loader. See `data-model.md` (Categories → seeding model, Rules → how rules come into being) for the rationale.

### Transaction tags

- **Storage:** `tag`, `rule_tag`, `txn_tag`, `category_tag`

- **Runtime:** shared transaction-tag service plus shared row UI; the picker (`components/TagPickerWithCreate.jsx`) is the one surface for browsing and creating tags, used from transaction rows and from the Categories right panel

- **Behavior:** tags are lightweight labels separate from categories. A transaction's effective tags are the additive union of direct tags (rule + manual via `txn_tag`), tags on its leaf category, tags on the leaf category's parent group (both via `category_tag`), and tags on its **effective (top-level) account** via `account_tag` (`COALESCE(parent_account_id, account_id)`, so a parent's tags reach its children while a merged child's own tags stay dormant until detached). Rules contribute a union of tag assignments across all matching rules, and transactions keep a per-tag manual override state (`txn_tag.manual_state`: `+1` force-on, `0` neutral, `-1` block). The `-1` **block** is universal: it suppresses a tag on that transaction whatever the source, so unchecking an *inherited* tag in a transaction's picker hides it there without retagging the category/account. Both the live-tag computation (`services/transaction_tags.py` — which applies blocks after merging the four sources, and exposes the hidden ones via `get_blocked_transaction_tag_map`) and the `tag_ids` filter (`_append_tag_filter`, which unions the effective tag ids and excludes per-tag blocks) are single shared chokepoints, so all four sources — and blocks — reach list and reporting uniformly

- **Reporting:** the dashboard's "Spending by …" picker offers built-in `group` / `category` partitions plus user-saved tag reports built on the multi-tag breakdown; combination wedges represent transactions matching multiple selected tags, and an `Other / Untagged` wedge holds the remainder

### Recurring series

- **Backend:** `backend/services/recurring_detection.py` (detection) + `backend/routers/recurring.py` (API)

- **Frontend:** `frontend/src/pages/Recurring.jsx` (route `/recurring`, nav "Recurring")

- **Storage:** `recurring_series` (+ `rule_id` for rule-backed series) + the `txn.recurring_series_id`
  membership link + `recurring_membership_override` (per-transaction pin/exclude corrections)

- **Handles:** detection of recurring obligations (subscriptions, bills, taxes) and their curation. A
  **scan** is idempotent — it rewrites auto-detected+unconfirmed series while preserving the user's
  confirmed, manual, and suppressed ones (see `data-model.md` → Recurring series for the detection key,
  the timing-over-frequency scoring, and the curation gates). The scan runs both **on demand**
  (`POST /recurring/scan` from the page) and **automatically**, at two scopes:
  - **Scoped** (`scan_imported_payees`) — the ingest paths (a completed CSV import or Plaid sync)
    reprocess only the payees the batch touched, so a freshly imported/synced charge is matched (and a
    new series among those payees detected) immediately, without re-scanning the whole ledger. Correct
    because detection groups by payee and `reconcile_series` never disturbs out-of-scope rows; a scoped
    pass deliberately does **not** stamp the watermark (it can't see cross-payee/normalization effects).
  - **Full catch-up** (`POST /recurring/auto-scan`, gated by a `db_meta` watermark) — app load runs a
    global scan only when one is due: never scanned (a fresh or migrated pre-recurring database) or stale
    (older than the daily interval). This is the safety net for what a scoped pass can't see, and the
    home of the payee-key re-derivation repair.

  The scan is one function (`scan_and_store`) with an optional `payee_keys` scope; scoped and full share
  the whole pipeline. Anomaly/forecast signals (missed/duplicated/off-amount charge) are the deferred
  payoff and hang off the scoped path (`scan_imported_payees`, which knows exactly which payees changed).

- **User-driven series are rule-backed.** Rather than force a rename so the derived key groups a
  varying-name payee, a rule flagged `is_recurring` owns a `source='rule'` series whose membership is the
  rule's matches (shared predicate `categorizer.rule_matches_row`). Entry points reuse the rule editor:
  the shared row menu's "Mark as recurring…" and the transaction editor's Rule button both open
  `RuleActionModal` (with a "Recurring series" checkbox), and the editor shows a status row linking to the
  series' `/recurring` card. Pin/exclude corrections (`recurring_membership_override`,
  `POST /recurring/{id}/membership`) survive scans; rule-backed series are reconciled over the full window
  even on a scoped pass. See `data-model.md` → Recurring series for the membership/override/lifecycle rules.

- **Drill-down:** clicking a series' charge count opens its member transactions in a docked bottom
  panel that renders the shared `TransactionListTable` (pill header, shared row cells + row menu), not a
  bespoke list — members are fetched via the transactions endpoint's `recurring_series_id` filter, so
  the drill-down looks and edits like every other transaction list (see `ui-patterns.md` → per-row
  editing). Editing a member (recategorize, trash) only affects membership on the next scan; the series
  record itself is user-owned and persists.

### Import / export

- **Backend:** `backend/routers/import\_export/` (a package; `__init__.py` assembles one combined router and preserves the original `backend.routers.import_export` import surface)

- **Handles:** CSV preview/import, saved import profiles, support undo import operations, CSV export, data backup/restore, and credentials backup/restore

- **Effective-account behavior:** import review, saved-profile summaries, and CSV export resolve grouped child accounts through the parent's display name so historical account numbers still read as one physical account outside the Accounts page

- **Import history contract:** recent-import batch rows expose lightweight summary data; large duplicate-review payloads are fetched separately when the duplicate viewer is opened. The file-scoped ledger drawer (`ImportBatchDetail`) additionally fetches the batch's *removed-as-duplicate* rows (`GET /batches/{id}/deduped-rows`) and surfaces them as a collapsible audit list ("removed → kept on `<account>`"). This exists because a Replace/Reject performed from *another* file's duplicate report trashes a row that belongs to *this* file's batch, which would otherwise vanish from the file view with no trace; the list resolves the surviving copy through `suspect_duplicate_of` so the user can see where the kept transaction went. Amazon reconciliation merges feed the same list through the same pointer (losers are tagged `rejection_reason='duplicate_confirmed'`, `dedupe_resolved_by='amazon_merge'`, `suspect_duplicate_of` → the kept copy) — there the kept copy is usually on the *same* account (a doubled import of one charge)

- **Duplicate matching contract:** import dedupe always keeps the exact content-hash path as the high-confidence rule, while lower-confidence cross-source matches rely on stored import evidence and stay visible in duplicate review with an explicit reason instead of being silently treated like exact duplicates

- **Soft-duplicate contract:** the same exact-match dedup that blocks imports cannot catch identical activity entered through two CSVs into separately-named accounts. After each batch finalizes, every batch row also runs a soft check against the rest of the ledger (date + amount + normalized payee) for cross-account matches; matches are flagged via `suspect_duplicate_of` (reason `cross_account`) rather than blocked and surface in the duplicate-review report. The check is gated only by `account_pair_distinct` — pairs the user has previously asserted as distinct via Keep are skipped. Same-batch sibling rows on different accounts are trusted as distinct (the CSV column carries the source-of-truth assertion for split purchases on the same statement) and are never the anchor for a soft-flag. Immediately after the sweep, import finalize runs `promote_in_group_suspects_to_confirmed` over the accounts the batch touched: any flag whose two accounts are *already in the same linked group* (a merge that predates this import) is promoted to confirmed (`auto_merge`) on the spot, because the merge already declared them the same physical account. This makes import order-independent — importing a file into an account that was previously merged with the account holding the matched rows settles identically to importing first and merging afterward. Flags against accounts outside the receiving group stay as soft-flags for review.

- **Per-pair-distinct trust model:** the dedupe service does not infer "this pair of accounts is the same physical account" or "this pair of accounts is distinct" — it asks the user. Clicking Keep on any cross-account suspect is a *broad* assertion ("these two accounts are distinct"): the service writes a row to `account_pair_distinct` and cascade-clears every other unresolved soft-flag between the same two accounts, so the user does not have to click Keep N times for N coincidences. Conversely, merging two accounts contradicts the distinct assertion and `clear_account_pair_distinct_for_merge` removes any matching row. The management surface on the SuspectDuplicates page lists every recorded assertion and lets the user forget one to re-enable detection between that pair.

- **Dedupe module boundary:** all duplicate-detection logic — hard-reject and soft-flag verdicts, import-time rule chain, cross-batch post-import soft-flag sweep, per-pair-distinct filtering, and the post-merge soft-flag promotion — lives in `backend/services/duplicate_detection.py`. The module exposes a `DedupeContext` (precomputed lookups for one import pass), a `DedupeVerdict` (hard-reject | soft-flag | passthrough), and a per-row `evaluate_duplicate` function used by the import flow. Keeping the rule ladder in one place is what lets the medium-confidence rules share their "receiving account must have prior history or be an explicit alias" precondition — see the module docstring for the full ladder and the rationale behind each rule's confidence level.

- **Dedupe state lifecycle:** dedupe records are not write-once — they are revisited on the events that invalidate their premise. Undoing an import (`undo_batch`) deletes the batch's own `import_batch_duplicate` rows (decisions about a now-defunct import), deletes its `import_batch_account` coverage records (so future imports stop being blocked by a coverage window that no longer exists), and clears any `suspect_duplicate_of` pointers from other batches that referenced the now-deleted txns. Attaching an account into a linked group (`attach_account`) runs `clear_account_pair_distinct_for_merge` (the merge contradicts any prior "distinct" assertion between the now-grouped accounts) AND `promote_in_group_suspects_to_confirmed` to graduate any PRE-EXISTING soft-flag whose two sides are now both in the linked group — the merge declared those accounts as the same physical account, so a same date+amount+payee match across them is the same case `exact_hash_linked_group` would hard-reject at import time. Each auto-promotion is tagged `dedupe_resolved_by = 'auto_merge'` so detach knows it can safely reverse it. Promote also performs a *same-batch transitivity clear*: when a row Y on a merging account is promoted (because its suspect target is now in the merged group), any sibling row Z in the same import batch as Y — necessarily on a different account, since the CSV's account column asserts same-batch rows on different accounts are distinct transactions — whose own suspect points at the **same canonical row X** has its suspect flag cleared too. Concretely: a single CSV containing two same-amount charges on cards A and B both flagged against the same canonical X gets both suspects cleared once the user merges A↔X, not just A's. The match must be the *same* canonical row, not merely a row in the same merged group: if Z's suspect points at a *different* transaction that happens to live on an account now in the group (e.g. a legacy umbrella "Credit Card" account merged into one real card still holds the row a same-batch charge on a *different* card legitimately duplicates), Z stays flagged — the merge with A proves nothing about a different canonical, and clearing it would silently destroy a real suspect (it is *cleared*, not confirmed, so a later detach cannot bring it back). Detaching (`detach_account`) reverses any `dedupe_resolved_by='auto_merge'` promotion whose account pair straddles the detach boundary — one endpoint on the detaching account, the other still in the now-shrunk group — restoring it to active-suspect state (back in the dialog for review). The reversal is **symmetric in which side holds the trashed row**: promotion graduates whichever row carries the `suspect_duplicate_of` pointer whenever *either* endpoint lands in the merged group, so the auto-promoted row can sit on the detaching account (pointing at a canonical that stays) OR on a staying account (pointing at a canonical on the detaching account — the case where the imported file holding the suspect was the one that stayed and the row it duplicated was on the account being pulled out). Both orientations are restored; restoring only the first strands the second permanently, which is what made a sequence of "map the same source account to one card, then another" look irreversible. Pairs wholly inside the remaining group are untouched. Rows the user explicitly Rejected (`dedupe_resolved_by='user'`) are left alone — the user's deliberate decision survives the un-merge. Soft-flags from `mark_import_suspects` (still active suspects, no resolution marker) also survive a detach since they reflect import-time facts, not group membership. The audit pointer `suspect_duplicate_of` is preserved across promotion and rejection so the user can always see what was matched and Restore if the auto-decision was wrong.

- **Hard-reject recoverability:** exact-match (and other hard-reject) duplicates are never inserted into `txn` at all — the row is dropped at import time and only its full would-be payload is persisted in `import_batch_duplicate` (plus a per-batch `deduped_count`). That payload is re-playable: `POST /import-export/batches/{id}/duplicates/import` re-inserts selected (or all) skipped rows via `_insert_imported_transaction`, independent of the import that originally caused the rejection. These records are scoped to their own batch, so undoing a *different* batch does not touch them — a row that file B skipped because it matched file A stays recorded against file B and remains re-playable even after file A is undone. The flip side is that the system does **not** auto-restore them: undoing file A removes file A's rows but does not survey later batches to re-materialize anything they deduped against A, so those rows simply stay absent (recoverable only by the manual "Import duplicates" action on file B, or by re-importing file B). See TODO ("Auto-restore deduped rows when a contributing import is undone") for the deferred automation and why it is non-trivial.

- **Advisory-review rejects:** a coverage-window hard-reject can fire without pinpointing the specific prior row it matched (the date is inside a covered range but no same-account row matches by date+amount). These surface in the unified report as "Rejected · review" — already rejected, but flagged for a look. The candidate lookup widens display-only from exact→±1→±2 (posting dates can differ by an extra day between sources — pending-vs-posted timing, weekend or holiday settlement, or a foreign charge posting a local calendar day ahead — so the usual ±1 drift stretches to ±2; the ±2 reach is a fallback that never fires when a closer match exists and cannot change the reject verdict), splitting the bucket into report sub-states: **`matched_2d`** (a same-amount twin was found only at ±2 — a near-date duplicate offset by posting-date drift), **`transfer_match`** (no same-account twin, but a same-|amount| row within ±3 days on a *different* account whose name contains the receiving account's name — the funding/deposit leg of a wallet transfer whose bank/card counterpart is already on the books; cross-account and opposite-signed, so the same-account lookup can't see it; a targeted query that only fires on the no-same-account residual, surfaced for confirm/reject and never auto-applied), and **`no_match`** (no twin even at ±2 or across accounts — the one genuinely worth investigating, e.g. a row present in one file but missing from the other, recoverable via "Import anyway"). The user can acknowledge these with **Mark reviewed** (`POST /batches/{id}/duplicates/mark-reviewed`, bulk by `row_number`), which sets `import_batch_duplicate.reviewed_at`; an acknowledged row stays rejected (never imported) but drops out of the needs-attention pills. This acknowledgment is *only* for advisory rejects — soft-flag suspects are still resolved through Keep both / Discard new / Replace existing, which already clear them.

- **Needs-review contract:** every imported/synced row is flagged `needs_review` so the user can look newly arrived transactions over (see the field in `data-model.md`). Batch summaries expose a per-file `needs_review_count`, and `POST /import-export/batches/{id}/mark-reviewed` clears the flag across a whole file — the CSV-batch counterpart to bulk Mark reviewed on the Transactions filter, available because batches already track which rows belong to a file (data-source syncs don't yet)

- **Saved-data-source behavior:** saved data sources remember whether imported files from that source should use categories present in the data by default, while each completed import batch keeps the actual per-file decision and scope used for that file

- **Imported-category behavior:** imports that use categories present in the data can apply those file categories directly to imported transactions, add missing imported categories as real leaf categories under the protected system `Unassigned` group, and feed those categorized transactions into the shared rule-suggestion workflow; placeholder labels that only mean "not categorized yet" are normalized back to `NULL` instead of creating a real category. A label matching an **inactive** category (one the user Set aside or deleted) is suppressed — the row imports uncategorized with its label retained, no leaf is created, and the inactive leaf is not resurrected — see the inactive-category lifecycle in `data-model.md`
- **Organize / inactive surface:** there is one place to organize `Unassigned` leaves into reporting groups — the system-level "Group Imported Categories" workspace on Import / Export, seeded from the live `Unassigned` leaves. Group placement and "Set aside" are both draft edits committed together on **Apply** (set-aside is treated like a bucket, undoable in-session). Applying a set-aside, and Delete on the Categories page, both *deactivate* a category (`is_active = 0`) rather than hard-deleting it; deactivated categories leave the active tree and the organize pool, appear in the Categories page "Inactive" list, and are recoverable via `POST /categories/{id}/reactivate`
  - **The workspace's in-progress draft is shared tenant state, not a per-user preference.** It stages how the one *shared* category tree is being organized, so all users/profiles see a single draft. It is stored in `import_workflow_state` (key `system_category_workspace_draft`, shared, in the data DB, carried by backups) and read/written through `GET`/`PUT /import-export/category-workspace-draft` — deliberately *not* the scoped `ui_preference` store, which would silo the draft per profile and orphan it on a restore into a different profile. The durable truth for parked/grouped state is the `category` table itself (group membership + `set_aside`); the draft only layers *un-applied* edits on top, and the workspace re-seeds parked/grouped state from those live flags whenever the draft is absent (see `categoryImportState.js::buildInitialSnapshot`), so losing a draft never loses committed organization.

- **Template-file behavior:** the saved-data-source editor remembers which CSV filename/hash last served as its template, but the user still explicitly chooses a template file when they want live column choices for editing

- **Delete fallback:** deleting a saved data source moves its files back into the unknown-source bucket while preserving each batch's own imported-category usage state

- **Amazon order import contract** (orders-only model, 2026-07-10 — the earlier per-item itemization was superseded)**:** the Amazon tab imports an AZAD orders/items export through a pipeline distinct from the CSV mapping flow, but folded into the *same* import-batch and undo contracts. Parsing is source-pluggable (`services/amazon_import.py`: a thin `read_export` header-sniffing front-end over a reusable `rows → orders` core, so a future clipboard-paste or combined-file source is a drop-in), and the ledger work is the `amazon.py` leaf — `run_amazon_import` creates an ordinary `import_batch` and applies each order via `apply_amazon_order`. It reuses the shared machinery rather than duplicating it: one order row per order is created through `_insert_imported_transaction` (so it carries batch linkage, `needs_review`, and provenance like any imported row; an optional items file folds per-item detail into that row's evidence), and the one extra side effect an Amazon import has — the matched card charge recategorized-and-linked (a `txn_link`) — is reversed inside the *existing* undo paths. `reverse_batch_amazon_links` runs in both `undo_batch` and the re-import `replace_batch_id` path, restoring each linked charge's prior category *before* the batch's own rows are deleted, exactly mirroring `reverse_batch_enrichments` and for the same reason (the charge lives outside the batch). The link / optional-item-enrichment / conditional-exclusion semantics live in `data-model.md` → "Transaction links and Amazon order import"; the architectural point is that Amazon import is an ordinary reversible import batch with one linked charge folded into the same undo discipline. Extensions since (2026-07, contracts in that same data-model section): an order may link *several* charges (split shipments) with per-charge undo stashes; the reconciliation report grew duplicate-merge, split-suggestion (`matched_review`, Accept/Dismiss) and bulk-resolution surfaces, and its actionable-attention count is recomputed by `list_batches` (per Amazon batch) and `get_tasks` (aggregate warning task) so the file card and the Tasks nag track resolution; each batch persists an investigable `import_summary` plus per-file content hashes in `config_snapshot` (a re-uploaded file is recognized and skipped, so nothing is ever re-processed into an all-duplicates batch), served back via `GET /amazon/import-detail/{batch_id}`. The two report dialogs (reconciliation + import detail) are App-level detached viewers on the shared `useDetachedReportViewer` seam (see `ui-patterns.md` → Floating detail panels → Minimize-to-nav-bar), alongside the duplicate-detection viewer. Charge matching narrows by the strongest account signal the order carries — mapped funding account, else the card's last-4 (maskless accounts stay eligible) — and when an order carries **neither** (`instrument: null`: a digital `D01` order or one paid off-card) the payee becomes the last remaining constraint, so the candidate must match `_AMAZON_NAME_LIKE`, the same "looks like Amazon" predicate the reverse scan uses. Amount+date alone had let an instrument-less order match a coincidental same-amount charge on any account (and drag unrelated payments into duplicate groups); the trade is that an off-card order whose real charge has a non-Amazon descriptor now reports no charge found — a recoverable miss rather than a silent wrong exclusion. Every "these charges are duplicates" claim goes through the single `_duplicate_group` seam, which owns all of the guards so a new consumer inherits them instead of re-deriving them (each guard exists because omitting it destroyed real data): candidates must share an **effective account** — two imports of one charge always land on one physical account (the Mint double-sync case), so same-amount rows on *different* accounts are distinct transactions and merging them trashes a real one — and a group the user settled via **Not duplicates** (`amazon_charge_distinct`) never re-flags. The report's three duplicate branches and `merge_duplicate_charges` all call it, so merging is re-validated server-side rather than trusted from the client; `merge_duplicate_charges` additionally refuses outright when an order links **several** charges, since an accepted split's shipments are all real and none is a redundant copy. Callers that want the *matcher's* candidate set rather than a duplicate claim (the equal-count pairing pass, the split-suggestion pass) keep calling `_order_charge_candidates` directly. It matters because an order whose payments string names no card (`instrument: null`, e.g. a D01 digital order) resolves to no last-4/account constraint at all, making every same-amount charge in the date window on *any* account a candidate. Further extensions (2026-07-16): two review-flavored duplicate buckets (`duplicate_review` — equal-amount copies only ambiguous at the ±14-day review window; `unaccounted_duplicate` — same-account/amount/near-date clusters in the reverse scan), a persisted **"Not duplicates"** assertion (`amazon_charge_distinct` pair table, consulted by every duplicate claim; an asserted order-anchored group falls back to the unmatched path with an exact-date tie-break suggestion), single-charge suggestion *reason notes*, and **removal provenance**: reconciliation merges/discards tag their trashed copies with the dedupe flow's confirmed-duplicate fields (`dedupe_resolved_by = 'amazon_merge'`/`'amazon_discard'`), routing them into the file ledger's removed-as-duplicates list and the Trash page's own Duplicate-transactions section (visible + scoped-emptiable there, unlike the unified flow's hidden rows).

- **Marketplace accounts — the extension pattern.** Amazon is the reference implementation of a *marketplace* account: a shopping venue whose purchases arrive itemized through a dedicated importer, not the generic CSV mapper. The pattern is meant to generalize to any similar vendor (AliExpress, Temu, …); a new one needs four pieces, in order:
  1. **An account-type marker.** Add an `ACCOUNT_TYPES` entry with `kind: 'marketplace'` (frontend `lib/accountTypes.js`). This alone makes the type selectable on the Accounts page while **excluding** it — and any account of it — from the generic CSV importer's type dropdown and account-mapping picker (which consume `GENERIC_IMPORT_ACCOUNT_TYPES` / `isMarketplaceAccountType`), because those accounts are filled by their own flow. `kind` is a UI convention only: the account stays ordinary in the DB (its `type` column holds the value; nothing enforces marketplace behavior).
  2. **A vendor-specific parser + detector.** Export formats differ per vendor, so the parser is bespoke — the reference is `services/amazon_import.py` (a thin header-sniffing front-end over a reusable `rows → orders` core). It ships with a header **sniff** mirrored client-side (cf. `lib/amazonDetect.js`) so a file dropped on the *generic* importer is recognized and routed to the vendor's flow instead of column mapping.
  3. **The shared ledger substrate.** The `txn_link` primitive and the order engine (`routers/import_export/amazon.py`: one spending transaction per order, match + exclude + link the funding card charge, plus a reconciliation report over the result, reversible via the batch-undo hook). A vendor that fits the same "one row per order + link the funding charge" model reuses this directly; one with different semantics forks it. These currently carry Amazon-specific names (`apply_amazon_order`, `LINK_KIND = 'amazon_order'`); generalizing them to a vendor-neutral abstraction is deferred until a second vendor exists, so the shape is known rather than guessed.
  4. **A dedicated import UI** — its own tab (or sub-surface), which is also the home for that vendor's setup help. The importer stamps each batch with `import_batch.source_kind = 'marketplace:<vendor>'` so the recent-import history groups the batches under that vendor instead of "unknown data source" (they have no CSV profile). See `ui-patterns.md` → Import-specific patterns for the interaction rules and the open question of how the single "Amazon" tab restructures when a second vendor lands.
  5. **A funding-source → account map** (only if the vendor's export names the *paying card* rather than which of the user's accounts it hit — Amazon does). `amazon_funding_map` + `services/amazon_funding.py` key each payment instrument (card `last-4` + network) to the system funding account it charges, so the importer can constrain its card-charge search to that account (imported ledgers rarely carry masks, so this — not `account.mask` — is the real signal). It is a user-maintained, global-by-default map (with an optional per-account override) surfaced as a persistent section under the vendor's import tab (`AmazonFundingSourcesSection`), and it accrues instruments as imports discover them. Resolution order in `find_matching_charge` is **override → global → graceful-last-4 → no match**; see `data-model.md` → "Transaction links and Amazon order import".

- **Module layout:** the package keeps a deliberately large, cohesive `core` alongside four thin leaf modules. `core.py` holds the run-import flow, the dedupe context, and batch history/undo/duplicate-report/category/rule-suggestion logic — plus the shared primitives (hashing, amount/date/header parsing, effective-account resolution, imported-category settings) the rest of the package reuses. The leaves carry only cleanly-separable concerns: `profiles.py` (saved data-source / import-profile CRUD), `backup.py` (data + credentials backup/restore and CSV export), `preview.py` (the read-only CSV preview endpoint), and `amazon.py` (the AZAD Amazon order/items import — parse via `services/amazon_import.py`, then create one transaction per order, the funding-charge link, and the reconciliation report). Dependencies flow one way — leaves import from `core` — with a single deliberate exception: `core`'s undo paths need `amazon.reverse_batch_amazon_links`, so they import it **lazily inside the function** rather than at module load. That keeps the module-load graph acyclic (the one place `core` depends on a leaf) while letting undo reverse Amazon links; `__init__.py` is the only place that wires the combined router and re-exports the public surface.

That core concentration is intentional. Import behavior is one of the places where many small decisions have to stay consistent across preview, saved profiles, history, undo, duplicate handling, category application, and rule learning, so the workflow logic that has to agree across those stages stays together in `core` rather than being scattered for the sake of smaller files. The leaf modules were split out precisely because they do *not* share that web of decisions — profile CRUD, the backup/encryption envelope, and preview each depend on `core` through a few named helpers but carry no logic the core needs back — so extracting them relieves navigation and merge-conflict pressure without splitting the parts that must move together.

### Detail panels

- **Panels:** payee detail (`TransactionDetail`), category detail (`CategoryDetail`), account detail (`AccountDetail`), single-month transaction listing (`MonthDetail`, opened by clicking a bar on the dashboard's monthly-trend chart), and tag-signature listing (`TagDetail`, opened by clicking a wedge on a dashboard tag-report pie). All five share the same chrome.

- **Shared behavior:** draggable + **resizable** shell, monthly bar charts, month selection, lazy-loaded transaction lists, and page-driven default placement when multiple panels are open. The resize handle in the bottom-right corner converts a docked panel to floating geometry on first drag so size and position stay coherent; the `useDetailPanelChrome` hook owns drag/resize state and `DetailPanelShell` renders the chrome.

- **Stacking and dismissal:** multiple panels can be open at once and each stacks with an offset; the topmost panel carries the strongest edge and elevation while older panels recede. Re-opening the same target focuses the existing panel rather than spawning a duplicate.

- **Reporting contract:** Expense/Income are simply how the user thinks about their data. Expenses can include positive values for various reasons, an expense might get reimbursed, a purchase might be returned for a refund, etc. These monies received are not income, they offset an expenditure. To support this detail drawers and dashboard summaries should not drop rows just because a transaction's sign is unusual for an expense or income category; they include all matching rows for the selected slice and use the net amount.

- **Shared implementation:** `frontend/src/components/detailShared.jsx`

### Help / FeatureExplainer

- **Location:** `frontend/src/help/`

- **Pieces:** a content registry (`content.jsx`) that holds every explainer as `{ id, title, surfaces, summary, body }`; a `<FeatureExplainer topic="...">` popover component for inline `?` affordances next to feature controls; the `/help` and `/help/:topic` routes (`pages/Help.jsx`) for the standalone index and per-topic pages; a `<HelpLink>` component that propagates back-navigation state across hops between topics; and a small `labelForPath` helper for the "Back to `<page>`" affordance

- **Single source of truth:** the same registry powers the popover summary and the standalone Help page body, so the two surfaces cannot drift. Adding a new explainer is one new entry in `content.jsx` plus a `<FeatureExplainer>` drop-in at the feature surface

- **Back navigation:** the popover stamps `state={{ from: <pathname> }}` onto the Read-more `<Link>`; the Help page reads it back to render a labeled "Back to `<page>`" button. `<HelpLink>` is used for cross-topic links inside content bodies so the original source survives multiple hops within the Help section

### Storage layers

Luma uses several distinct storage layers for working state.

#### Browser-local storage

- **Lives in:** browser `localStorage` and browser `sessionStorage`

- **Lifespan:** `localStorage` survives reloads on the same browser profile until cleared; `sessionStorage` lasts only for the current browser tab/session

- **Contains:** browser-specific remembered local-profile selection, import draft/fallback state, migration fallback values from older UI preference storage, and other machine-local or browser-local UI state that should not be treated as durable shared preference data

#### Frontend session state

- **Lives in:** React state in the running frontend session

- **Lifespan:** lasts until page reload, app restart, or active user/profile change

- **Contains:** in-memory copy of loaded user/profile preferences, transient edit drafts, open/closed UI state for the current interaction, and other short-lived state needed to keep interaction responsive

- **Key files:** `frontend/src/lib/UserPreferencesContext.jsx`, `frontend/src/lib/api.js`

#### Preference storage in the control database

- **Lives in:** `backend/luma-control.db`

- **Lifespan:** durable until explicitly changed or cleared

- **Contains:** per-user preferences in authenticated mode, per-local-profile preferences in local access mode, and other small JSON-friendly UI preference values that should follow the active user or local profile

- **Authenticated mode:** keyed to the signed-in user

- **Local access mode:** keyed to a lightweight **local profile** instead of a security identity

- **Key files:** `backend/db/control\_database.py`, `backend/routers/auth.py`, `frontend/src/lib/UserPreferencesContext.jsx`

#### Local-profile records in the control database

- **Lives in:** `backend/luma-control.db`

- **Lifespan:** durable until explicitly deleted

- **Contains:** local access mode profile identities used to separate layout/view preferences for different people sharing one database

- **Properties:** selected from the browser-facing profile picker in `frontend/src/App.jsx`; not authentication or authorization identities; used to scope preference data and startup behavior in local mode

#### Application data database

- **Lives in:** `backend/luma-data.db`

- **Lifespan:** durable application data until changed, deleted, restored, or replaced

- **Contains:** transactions, categories, rules, accounts, owners, saved import profiles, import batches, snapshots, and other import/export data

- **Account lifecycle note:** account rows can participate in a parent/child merge model for reissued account numbers, and child accounts can move through a recoverable trash state before permanent cleanup folds their references into the parent

- **Transaction lifecycle note:** transactions also support a recoverable soft-delete via `txn.trashed_at` — every user-facing read filters trashed rows out, but they stay in the table until the user empties the transaction trash from Settings. Neither trash is auto-emptied; both require a manual action. Confirmed-duplicate rows (`rejection_reason='duplicate_confirmed'`, set by an explicit Reject or by a merge-time auto-promotion) are soft-deleted through the same `trashed_at` mechanism but are intentionally excluded from both the Settings → Trash view and the empty-trash delete: they are dedupe artifacts owned by the duplicate report, not user deletions, and their restore paths (account detach for `auto_merge`, "undo reject" for `user`) depend on the row surviving — so the manual Trash must never be able to remove them.

- **Account regrouping note:** dragging one merged parent onto another top-level account flattens the dragged group's visible members under the new parent instead of preserving a nested account tree

#### Developer reset tools

When `LUMA\_DEVELOPER\_OPTIONS=true`, the Settings page exposes developer reset actions that clear these layers selectively:

- **`Clear browser-local state`:** clears browser `localStorage` / `sessionStorage`

- **`Clear saved preferences`:** clears preference values stored in the control database

- **`Clear import memory`:** clears backend import-memory data stored in the main application database

- **`Clear local user profiles`:** clears local-profile records stored in the control database

These resets remain separate because they target different storage layers with different lifespans and different effects on startup behavior.

The separation is important because "resetting the app" can mean very different things in practice. Browser-local troubleshooting, preference cleanup, import-workflow cleanup, and removing local profiles are all recoveries with different blast radii, so the tooling keeps them explicit instead of hiding them behind one broad reset.

## Cross-platform approach

Luma is intended to run on:

- Windows

- Linux

- macOS

- Raspberry Pi / ARM Linux

Where commands differ, the repo should provide script wrappers or document the differences clearly in `README.md`.

## Where to change things

- **New API behavior:** add or update a router in `backend/routers/`

- **Schema changes:** update `init_db` in `backend/db/database.py` (see "Schema evolution" in `docs/data-model.md` — there is currently no in-place migration path)

- **Shared transaction editing/display behavior:** update `TransactionRow.jsx`

- **Shared detail-panel behavior:** update `detailShared.jsx`

- **User-facing setup or behavior changes:** update `README.md` and possibly `CHANGELOG.md`
