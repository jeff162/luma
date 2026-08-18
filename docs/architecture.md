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

- **Local-mode onboarding:** when auth is off and no identities exist yet, `App.jsx` opens a first-run welcome flow that creates the initial identity and then routes the user once to a chosen data-entry surface — import a CSV, connect a data source, load the demo dataset, or skip into an empty app. Getting data in is the point of the flow; account owners, additional identities, and categorization setup are deferred to the normal app surfaces rather than collected up front. The chosen destination is a **one-time** navigation, deliberately distinct from the persisted startup-route preference (which stays at its default so later launches land on the dashboard, not back on import/accounts).

Keeping this in `App.jsx` makes it part of bootstrap rather than a repeatable workflow. The main need is to block the ordinary shell until an identity is selected to scope preferences cleanly, not to create a long-lived page in the app’s information architecture. The welcome flow guides the user toward their first import because that data is what activates the rest of the app; the supporting concepts are introduced where they become relevant (e.g. a post-import nudge about categories) instead of as onboarding prerequisites.

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

- **Scope by account type:** besides a single owner/account, a rule can scope by account **type** (`category_rule.account_type`, e.g. `paypal`/`amazon`) — matching every account of that type via the row's *effective* account type (`COALESCE(parent.type, account.type)`, threaded into every SELECT that feeds `rule_matches_row`/`categorize_transaction`). Precedence is account_id > account_type > global, and account_type joins the one-rule-per-matcher identity. This is the primitive the PayPal money-movement rules use (one `account_type='paypal'` rule per `Type`, created via the shared `create_rule_core`); see `data-model.md` → Accounts/Rules and `docs/backlog/account-type-as-rule-criterion.md`

- **Applying a match (shared, per action):** every path that runs rules — CSV import, Plaid sync, and `recategorize_all` (plus its preview count) — matches once via `categorize_transaction`, then applies the result through shared apply points rather than re-deriving it each place: tags via `sync_rule_tags_for_transaction`, and the scalar actions (the merchant rename today, a rule-set note tomorrow) via `rule_scalar_effects`. Category *source* policy stays site-specific (import has mapping/file-label fallbacks; recategorize preserves a `cleared` marker). Keeping each action in one place is what stops sites drifting — the CSV import path had silently dropped the rename before this was centralized — and makes a new scalar rule action a one-place change. `recategorize_all` is also **retain-by-default** — it sets/changes a category or rule-tag but never strips one, so deleting or narrowing a rule doesn't silently un-categorize its history; clearing a no-match row (**reconcile**) is an opt-in `txn_ids`-scoped pass invoked only by the rule delete/edit "re-evaluate this rule's transactions" control and the money-movement "remove a type" path (see `data-model.md` → "How an existing transaction's category can change")

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

- **Preview contract — one parser, server-side:** the mapping table's amounts are computed by the *import's* `parse_amount`, via `POST /import-export/preview/amounts` (`preview.py`), not by the browser. A preview exists to show what the import will do, so a second implementation makes it wrong exactly where that matters: the client used to parse amounts itself and disagreed with the import on `single_unsigned` rows (it ignored the direction column, so every row rendered as a credit), on `DR`/`CR` suffixes, and on blank two-column cells. The endpoint posts the ten rows the client already holds rather than referencing the file, because `/preview` persists nothing there is a handle to re-parse and re-uploading the file on every dropdown change would be far heavier. It answers `null` — rendered as the raw cell or an em dash — for an unparseable cell or a convention whose columns aren't mapped yet. `frontend/src/lib/importExport/previewAmounts.js` owns the debounced fetch and the by-position merge, and no amount parsing at all

- **Effective-account behavior:** import review, saved-profile summaries, and CSV export resolve grouped child accounts through the parent's display name so historical account numbers still read as one physical account outside the Accounts page

- **Import history contract:** recent-import batch rows expose lightweight summary data; large duplicate-review payloads are fetched separately when the duplicate viewer is opened. The file-scoped ledger drawer (`ImportBatchDetail`) additionally fetches the batch's *removed-as-duplicate* rows (`GET /batches/{id}/deduped-rows`) and surfaces them as a collapsible audit list ("removed → kept on `<account>`"). This exists because a Replace/Reject performed from *another* file's duplicate report trashes a row that belongs to *this* file's batch, which would otherwise vanish from the file view with no trace; the list resolves the surviving copy through `suspect_duplicate_of` so the user can see where the kept transaction went. Amazon reconciliation merges feed the same list through the same pointer (losers are tagged `rejection_reason='duplicate_confirmed'`, `dedupe_resolved_by='amazon_merge'`, `suspect_duplicate_of` → the kept copy) — there the kept copy is usually on the *same* account (a doubled import of one charge)

- **Duplicate matching contract:** import dedupe always keeps the exact content-hash path as the high-confidence rule, while lower-confidence cross-source matches rely on stored import evidence and stay visible in duplicate review with an explicit reason instead of being silently treated like exact duplicates

- **Soft-duplicate contract:** the same exact-match dedup that blocks imports cannot catch identical activity entered through two CSVs into separately-named accounts. After each batch finalizes, every batch row also runs a soft check against the rest of the ledger (date + amount + normalized payee) for cross-account matches; matches are flagged via `suspect_duplicate_of` (reason `cross_account`) rather than blocked and surface in the duplicate-review report. The check is gated only by `account_pair_distinct` — pairs the user has previously asserted as distinct via Keep are skipped. Same-batch sibling rows on different accounts are trusted as distinct (the CSV column carries the source-of-truth assertion for split purchases on the same statement) and are never the anchor for a soft-flag. Immediately after the sweep, import finalize runs `promote_in_group_suspects_to_confirmed` over the accounts the batch touched: any flag whose two accounts are *already in the same linked group* (a merge that predates this import) is promoted to confirmed (`auto_merge`) on the spot, because the merge already declared them the same physical account. This makes import order-independent — importing a file into an account that was previously merged with the account holding the matched rows settles identically to importing first and merging afterward. Flags against accounts outside the receiving group stay as soft-flags for review.

- **Per-pair-distinct trust model:** the dedupe service does not infer "this pair of accounts is the same physical account" or "this pair of accounts is distinct" — it asks the user. Clicking Keep on any cross-account suspect is a *broad* assertion ("these two accounts are distinct"): the service writes a row to `account_pair_distinct` and cascade-clears every other unresolved soft-flag between the same two accounts, so the user does not have to click Keep N times for N coincidences. Conversely, merging two accounts contradicts the distinct assertion and `clear_account_pair_distinct_for_merge` removes any matching row. The management surface on the SuspectDuplicates page lists every recorded assertion and lets the user forget one to re-enable detection between that pair.

- **Dedupe module boundary:** all duplicate-detection logic — hard-reject and soft-flag verdicts, import-time rule chain, cross-batch post-import soft-flag sweep, per-pair-distinct filtering, and the post-merge soft-flag promotion — lives in `backend/services/duplicate_detection.py`. The module exposes a `DedupeContext` (precomputed lookups for one import pass), a `DedupeVerdict` (hard-reject | soft-flag | passthrough), and a per-row `evaluate_duplicate` function used by the import flow. Keeping the rule ladder in one place is what lets the medium-confidence rules share their "receiving account must have prior history or be an explicit alias" precondition — see the module docstring for the full ladder and the rationale behind each rule's confidence level.

- **Dedupe state lifecycle:** dedupe records are not write-once — they are revisited on the events that invalidate their premise. Undoing an import (`undo_batch`) deletes the batch's own `import_batch_duplicate` rows (decisions about a now-defunct import), deletes its `import_batch_account` coverage records (so future imports stop being blocked by a coverage window that no longer exists), and clears any `suspect_duplicate_of` pointers from other batches that referenced the now-deleted txns. Attaching an account into a linked group (`attach_account`) runs `clear_account_pair_distinct_for_merge` (the merge contradicts any prior "distinct" assertion between the now-grouped accounts) AND `promote_in_group_suspects_to_confirmed` to graduate any PRE-EXISTING soft-flag whose two sides are now both in the linked group — the merge declared those accounts as the same physical account, so a same date+amount+payee match across them is the same case `exact_hash_linked_group` would hard-reject at import time. Each auto-promotion is tagged `dedupe_resolved_by = 'auto_merge'` so detach knows it can safely reverse it. Promote also performs a *same-batch transitivity clear*: when a row Y on a merging account is promoted (because its suspect target is now in the merged group), any sibling row Z in the same import batch as Y — necessarily on a different account, since the CSV's account column asserts same-batch rows on different accounts are distinct transactions — whose own suspect points at the **same canonical row X** has its suspect flag cleared too. Concretely: a single CSV containing two same-amount charges on cards A and B both flagged against the same canonical X gets both suspects cleared once the user merges A↔X, not just A's. The match must be the *same* canonical row, not merely a row in the same merged group: if Z's suspect points at a *different* transaction that happens to live on an account now in the group (e.g. a legacy umbrella "Credit Card" account merged into one real card still holds the row a same-batch charge on a *different* card legitimately duplicates), Z stays flagged — the merge with A proves nothing about a different canonical, and clearing it would silently destroy a real suspect (it is *cleared*, not confirmed, so a later detach cannot bring it back). Detaching (`detach_account`) reverses any `dedupe_resolved_by='auto_merge'` promotion whose account pair straddles the detach boundary — one endpoint on the detaching account, the other still in the now-shrunk group — restoring it to active-suspect state (back in the dialog for review). The reversal is **symmetric in which side holds the trashed row**: promotion graduates whichever row carries the `suspect_duplicate_of` pointer whenever *either* endpoint lands in the merged group, so the auto-promoted row can sit on the detaching account (pointing at a canonical that stays) OR on a staying account (pointing at a canonical on the detaching account — the case where the imported file holding the suspect was the one that stayed and the row it duplicated was on the account being pulled out). Both orientations are restored; restoring only the first strands the second permanently, which is what made a sequence of "map the same source account to one card, then another" look irreversible. Pairs wholly inside the remaining group are untouched. Rows the user explicitly Rejected (`dedupe_resolved_by='user'`) are left alone — the user's deliberate decision survives the un-merge. Soft-flags from `mark_import_suspects` (still active suspects, no resolution marker) also survive a detach since they reflect import-time facts, not group membership. The audit pointer `suspect_duplicate_of` is preserved across promotion and rejection so the user can always see what was matched and Restore if the auto-decision was wrong.

- **Hard-reject recoverability:** exact-match (and other hard-reject) duplicates are never inserted into `txn` at all — the row is dropped at import time and only its full would-be payload is persisted in `import_batch_duplicate` (plus a per-batch `deduped_count`). That payload is re-playable: `POST /import-export/batches/{id}/duplicates/import` re-inserts selected (or all) skipped rows via `_insert_imported_transaction`, independent of the import that originally caused the rejection. These records are scoped to their own batch, so undoing a *different* batch does not touch them — a row that file B skipped because it matched file A stays recorded against file B and remains re-playable even after file A is undone. The flip side is that the system does **not** auto-restore them: undoing file A removes file A's rows but does not survey later batches to re-materialize anything they deduped against A, so those rows simply stay absent (recoverable only by the manual "Import duplicates" action on file B, or by re-importing file B). See TODO ("Auto-restore deduped rows when a contributing import is undone") for the deferred automation and why it is non-trivial.

- **Advisory-review rejects:** a coverage-window hard-reject can fire without pinpointing the specific prior row it matched (the date is inside a covered range but no same-account row matches by date+amount). These surface in the unified report as "Rejected · review" — already rejected, but flagged for a look. The candidate lookup searches the receiving account and — for an **in-scope** coverage reject, whose premise is that the prior import covered the whole linked group — that group's sibling accounts too, since a second source routinely files the same charge under a sibling (the group index is keyed per scope and the lookup reads only the row's own scope, so an unrelated group in the same import can never supply a candidate). It then widens display-only from exact→±1→outward, a day at a time, to `CROSS_ACCOUNT_DATE_WINDOW_DAYS` (posting dates differ between sources for several reasons — pending-vs-posted timing, weekend or holiday settlement, a foreign charge posting a local calendar day ahead — and measured skew on a real ledger reached +6; the widened reach is a fallback that never fires when a closer match exists, is ordered closest-day-first, and cannot change the reject verdict). A candidate found by that **widened** reach must additionally agree textually to be reported — `classify_source_text_relation`'s `exact`/`fuzzy`/`weak` tiers, the same ladder the soft-flag sweeps use, recorded on the candidate as `text_relation` and worded for the user at read time from `_CANDIDATE_TEXT_RELATION_LABELS` (stored as the bare tier key, so re-wording never needs a re-import). Amount and a nearby date alone are thin evidence: a week-wide window around any common amount picks up unrelated charges, and the report then presents a coincidence with the same confidence as the actual twin. Two exemptions: exact/±1 hits are kept regardless of wording (that band is the case the lookup exists for, and two sources routinely describe one charge with no shared text), and a pair with no captured text on either side is never hidden (a nameless money-movement leg matches nothing by design — silence is not disagreement). The gate is display-only in the strict sense: `_coverage_reject_verdict` runs its "named row with no candidate" escape hatch against the **unfiltered** list and applies `_display_candidates` only on the way into the stored `matched`, because an empty list there is what sends a genuinely-new named payment down the import path. Filtering everything out yields `no_match`, not an import. This splits the bucket into report sub-states: **`matched_near_date`** (a same-amount twin was found only on a nearby day, each candidate carrying the `day_offset` the report renders), **`transfer_match`** (no same-account twin, but a same-|amount| row within ±3 days on a *different* account whose name contains the receiving account's name — the funding/deposit leg of a wallet transfer whose bank/card counterpart is already on the books; cross-account and opposite-signed, so the same-account lookup can't see it; a targeted query that only fires on the no-same-account residual, surfaced for confirm/reject and never auto-applied), and **`no_match`** (no twin anywhere in the window or across accounts — the one genuinely worth investigating, e.g. a row present in one file but missing from the other, recoverable via "Import anyway"). The report **replays a stored verdict** — `matched_transaction_json` is written once at import and read back thereafter — so opening it first runs `refresh_unexplained_coverage_candidates`, which recomputes the candidate list for coverage rejects that currently name *nothing* and leaves every other entry untouched. Without it an entry would keep reading "no specific match" forever, even after the lookup improves or a later import brings the twin into the ledger. It is bounded to be safe on a read path: it recomputes only the same-account and linked-group reach (the cross-account transfer fallback already ran at import time and costs a query per entry, so it is deliberately disabled here), queries only the exact amounts and probe dates of the unexplained entries, and returns after one query when nothing qualifies. It re-derives each entry's scope from the account rather than replaying the one stored at import, so a group the account joined afterwards is visible. It never re-points an explanation that already exists, and never touches the verdict, reason, or `reviewed_at`. The user can acknowledge these with **Mark reviewed** (`POST /batches/{id}/duplicates/mark-reviewed`, bulk by `row_number`), which sets `import_batch_duplicate.reviewed_at`; an acknowledged row stays rejected (never imported) but drops out of the needs-attention pills. This acknowledgment is *only* for advisory rejects — soft-flag suspects are still resolved through Keep both / Discard new / Replace existing, which already clear them.

- **Needs-review contract:** every imported/synced row is flagged `needs_review` so the user can look newly arrived transactions over (see the field in `data-model.md`). Batch summaries expose a per-file `needs_review_count`, and `POST /import-export/batches/{id}/mark-reviewed` clears the flag across a whole file — the CSV-batch counterpart to bulk Mark reviewed on the Transactions filter, available because batches already track which rows belong to a file (data-source syncs don't yet)

- **Saved-data-source behavior:** saved data sources remember whether imported files from that source should use categories present in the data by default, while each completed import batch keeps the actual per-file decision and scope used for that file

- **Imported-category behavior:** imports that use categories present in the data can apply those file categories directly to imported transactions, add missing imported categories as real leaf categories under the protected system `Unassigned` group, and feed those categorized transactions into the shared rule-suggestion workflow; placeholder labels that only mean "not categorized yet" are normalized back to `NULL` instead of creating a real category. A label matching an **inactive** category (one the user Set aside or deleted) is suppressed — the row imports uncategorized with its label retained, no leaf is created, and the inactive leaf is not resurrected — see the inactive-category lifecycle in `data-model.md`
- **Organize / inactive surface:** there is one place to organize `Unassigned` leaves into reporting groups — the system-level "Group Imported Categories" workspace on Import / Export, seeded from the live `Unassigned` leaves. Group placement and "Set aside" are both draft edits committed together on **Apply** (set-aside is treated like a bucket, undoable in-session). Applying a set-aside, and Delete on the Categories page, both *deactivate* a category (`is_active = 0`) rather than hard-deleting it; deactivated categories leave the active tree and the organize pool, appear in the Categories page "Inactive" list, and are recoverable via `POST /categories/{id}/reactivate`
  - **The workspace's in-progress draft is shared tenant state, not a per-user preference.** It stages how the one *shared* category tree is being organized, so all users/profiles see a single draft. It is stored in `import_workflow_state` (key `system_category_workspace_draft`, shared, in the data DB, carried by backups) and read/written through `GET`/`PUT /import-export/category-workspace-draft` — deliberately *not* the scoped `ui_preference` store, which would silo the draft per profile and orphan it on a restore into a different profile. The durable truth for parked/grouped state is the `category` table itself (group membership + `set_aside`); the draft only layers *un-applied* edits on top, and the workspace re-seeds parked/grouped state from those live flags whenever the draft is absent (see `categoryImportState.js::buildInitialSnapshot`), so losing a draft never loses committed organization.

- **Template-file behavior:** the saved-data-source editor remembers which CSV filename/hash last served as its template, but the user still explicitly chooses a template file when they want live column choices for editing

- **Delete fallback:** deleting a saved data source moves its files back into the unknown-source bucket while preserving each batch's own imported-category usage state

- **Amazon order import contract** (orders-only model, 2026-07-10 — the earlier per-item itemization was superseded)**:** the Amazon tab imports an AZAD orders/items export through a pipeline distinct from the CSV mapping flow, but folded into the *same* import-batch and undo contracts. Parsing is source-pluggable (`services/amazon_import.py`: a thin `read_export` header-sniffing front-end over a reusable `rows → orders` core, so a future clipboard-paste or combined-file source is a drop-in), and the ledger work is the `amazon.py` leaf — `run_amazon_import` splits a drop into **one `import_batch` per source file** and applies each order into its card via `apply_amazon_order` (`_import_group_to_batch` per group). Orders are grouped by the content hash of the file they came from: an orders file and its items file fold into one card (the items enrich the orders, joined on `order id` in `merge` before batching), while an items file dropped *without* its orders file becomes its own card whose per-item detail is **parked** (`amazon_pending_item`, keyed by order id) rather than discarded — so a later import of the matching orders file **auto-attaches** it (`_take_parked_items` at order creation), no manual re-import needed. Once that items card is **fully** consumed (nothing left waiting) it is **folded into the orders card** that took its detail (`_merge_items_card_into_orders`: the items file's name, hash, and enrichment summary move onto the orders card and the now-empty items card — which never had ledger rows of its own — is deleted), so a split items↔orders import ends on a single card labeled with both files, exactly as a combined drop would. The fold is symmetric across import order: an items file imported **before** its orders (parked, then the orders import consumes it) folds the prior items card into the new orders card; an items file imported **after** its orders (enriching already-imported orders — `enriched_into_batches`) folds the new, empty items card into the prior orders card. Both apply only when a **single** orders card is involved (an items file spanning two orders cards, or a partly-matched one, keeps its own card). The parked rows are removed when the parking import is undone (`reverse_batch_amazon_links`), and while an items card is only *partly* matched its "no match" pill resolves live from the ledger (`unmatched_parked_order_count`: its discarded order ids that still have no order link), flipping to "attached to orders" as orders arrive and re-flagging if that import is undone. Batching by *file* rather than by *drop* is deliberate — dropping several order-history periods at once then behaves exactly as if each file had been imported one at a time (independent coverage window / undo / reconciliation per card), instead of bundling unrelated periods onto one card; the content hash rather than the filename is the grouping key so two genuinely different files that share a name still split (identical content is deduped away before batching). It reuses the shared machinery rather than duplicating it: one order row per order is created through `_insert_imported_transaction` (so it carries batch linkage, `needs_review`, and provenance like any imported row; an optional items file folds per-item detail into that row's evidence), and the one extra side effect an Amazon import has — the matched card charge recategorized-and-linked (a `txn_link`) — is reversed inside the *existing* undo paths. `reverse_batch_amazon_links` runs in both `undo_batch` and the re-import `replace_batch_id` path, restoring each linked charge's prior category *before* the batch's own rows are deleted, exactly mirroring `reverse_batch_enrichments` and for the same reason (the charge lives outside the batch). The link / optional-item-enrichment / conditional-exclusion semantics live in `data-model.md` → "Transaction links and Amazon order import"; the architectural point is that Amazon import is an ordinary reversible import batch with one linked charge folded into the same undo discipline. Extensions since (2026-07, contracts in that same data-model section): an order may link *several* charges (split shipments) with per-charge undo stashes; the reconciliation report grew duplicate-merge, split-suggestion (`matched_review`, Accept/Dismiss) and bulk-resolution surfaces, and its actionable-attention count feeds both `list_batches` (per Amazon batch) and `get_tasks` (aggregate warning task) so the file card and the Tasks nag track resolution. That count is **cached** on the batch (`import_batch.recon_attention_count`) and recomputed lazily only when stale — both readers run on every history load / task poll, and computing it live runs the whole reconciliation. Staleness is a single monotonic epoch in `db_meta` (`recon_epoch`) bumped by a **trigger** on every write to a table the reconciliation reads (`txn`, `txn_link`(`_member`), `account`, `amazon_funding_map`, `amazon_charge_distinct`); a batch whose stored epoch trails the current one recomputes on the next read (`reconciliation_attention_count`). Triggers rather than per-endpoint bump calls because the charge-affecting writes are scattered and a missed site would silently show a stale count; over-invalidation only forces one recompute, and the accessor's cache write targets `import_batch` (no trigger) so it never invalidates itself. Each batch also persists an investigable `import_summary` plus the content hashes of the files that fed it in `config_snapshot` (a re-uploaded file is recognized and skipped, so nothing is ever re-processed into an all-duplicates batch), served back via `GET /amazon/import-detail/{batch_id}`. A file with any discarded rows is left re-importable — decided across the *whole drop*, since one items file can fold into an orders card here yet leave orphans (a missing orders file) on its own card there — and a taken file's hash is pinned to every card its rows fed, so undoing a card frees exactly the files it took. The two report dialogs (reconciliation + import detail) are App-level detached viewers on the shared `useDetachedReportViewer` seam (see `ui-patterns.md` → Floating detail panels → Minimize-to-nav-bar), alongside the duplicate-detection viewer. Charge matching narrows by the strongest account signal the order carries — mapped funding account (resolved to its **account group**, since the map stores a plain id that a later merge turns into a child while the charges keep arriving on the root — see `data-model.md` → Accounts), else the card's last-4 (maskless accounts stay eligible) — and when an order carries **neither** (`instrument: null`: a digital `D01` order or one paid off-card) the payee becomes the last remaining constraint, so the candidate must match `_AMAZON_NAME_LIKE`, the same "looks like Amazon" predicate the reverse scan uses. Amount+date alone had let an instrument-less order match a coincidental same-amount charge on any account (and drag unrelated payments into duplicate groups); the trade is that an off-card order whose real charge has a non-Amazon descriptor now reports no charge found — a recoverable miss rather than a silent wrong exclusion. Every "these charges are duplicates" claim goes through the single `_duplicate_group` seam, which owns all of the guards so a new consumer inherits them instead of re-deriving them (each guard exists because omitting it destroyed real data): candidates must share an **effective account** — two imports of one charge always land on one physical account (the Mint double-sync case), so same-amount rows on *different* accounts are distinct transactions and merging them trashes a real one — and a group the user settled via **Not duplicates** (`amazon_charge_distinct`) never re-flags. The report's three duplicate branches and `merge_duplicate_charges` all call it, so merging is re-validated server-side rather than trusted from the client; `merge_duplicate_charges` additionally refuses outright when an order links **several** charges, since an accepted split's shipments are all real and none is a redundant copy. Callers that want the *matcher's* candidate set rather than a duplicate claim (the equal-count pairing pass, the split-suggestion pass) keep calling `_order_charge_candidates` directly. It matters because an order whose payments string names no card (`instrument: null`, e.g. a D01 digital order) resolves to no last-4/account constraint at all, making every same-amount charge in the date window on *any* account a candidate. Further extensions (2026-07-16): two review-flavored duplicate buckets (`duplicate_review` — equal-amount copies only ambiguous at the ±14-day review window; `unaccounted_duplicate` — same-account/amount/near-date clusters in the reverse scan), a persisted **"Not duplicates"** assertion (`amazon_charge_distinct` pair table, consulted by every duplicate claim; an asserted order-anchored group falls back to the unmatched path with an exact-date tie-break suggestion), single-charge suggestion *reason notes*, and **removal provenance**: reconciliation merges/discards tag their trashed copies with the dedupe flow's confirmed-duplicate fields (`dedupe_resolved_by = 'amazon_merge'`/`'amazon_discard'`), routing them into the file ledger's removed-as-duplicates list and the Trash page's own Duplicate-transactions section (visible + scoped-emptiable there, unlike the unified flow's hidden rows).

- **Marketplace accounts — the extension pattern.** Amazon is the reference implementation of a *marketplace* account: a shopping venue whose purchases arrive itemized through a dedicated importer, not the generic CSV mapper. The pattern is meant to generalize to any similar vendor (AliExpress, Temu, …); a new one needs four pieces, in order:
  1. **An account-type marker.** Add an `ACCOUNT_TYPES` entry with `kind: 'marketplace'` (frontend `lib/accountTypes.js`). This alone makes the type selectable on the Accounts page while **excluding** it — and any account of it — from the generic CSV importer's type dropdown and account-mapping picker (which consume `GENERIC_IMPORT_ACCOUNT_TYPES` / `isMarketplaceAccountType`), because those accounts are filled by their own flow. `kind` is a UI convention only: the account stays ordinary in the DB (its `type` column holds the value; nothing enforces marketplace behavior).
  2. **A vendor-specific parser + detector.** Export formats differ per vendor, so the parser is bespoke — the reference is `services/amazon_import.py` (a thin header-sniffing front-end over a reusable `rows → orders` core). It ships with a header **sniff** mirrored client-side (cf. `lib/amazonDetect.js`) so a file dropped on the *generic* importer is recognized and routed to the vendor's flow instead of column mapping.
  3. **The shared ledger substrate.** The `txn_link` primitive and the order engine (`routers/import_export/amazon.py`: one spending transaction per order, match + exclude + link the funding card charge, plus a reconciliation report over the result, reversible via the batch-undo hook). A vendor that fits the same "one row per order + link the funding charge" model reuses this directly; one with different semantics forks it. These currently carry Amazon-specific names (`apply_amazon_order`, `LINK_KIND = 'amazon_order'`); generalizing them to a vendor-neutral abstraction is deferred until a second vendor exists, so the shape is known rather than guessed.
  4. **A dedicated import UI** — its own tab (or sub-surface), which is also the home for that vendor's setup help. The importer stamps each batch with `import_batch.source_kind = 'marketplace:<vendor>'` so the recent-import history groups the batches under that vendor instead of "unknown data source" (they have no CSV profile). See `ui-patterns.md` → Import-specific patterns for the interaction rules and the open question of how the single "Amazon" tab restructures when a second vendor lands.
  5. **A funding-source → account map** (only if the vendor's export names the *paying card* rather than which of the user's accounts it hit — Amazon does). `amazon_funding_map` + `services/amazon_funding.py` key each payment instrument (card `last-4` + network) to the system funding account it charges, so the importer can constrain its card-charge search to that account (imported ledgers rarely carry masks, so this — not `account.mask` — is the real signal). It is a user-maintained, global-by-default map (with an optional per-account override) surfaced as a persistent section under the vendor's import tab (`AmazonFundingSourcesSection`), and it accrues instruments as imports discover them. Resolution order in `find_matching_charge` is **override → global → graceful-last-4 → no match**; see `data-model.md` → "Transaction links and Amazon order import".

- **Module layout:** the package keeps a deliberately large, cohesive `core` alongside four thin leaf modules. `core.py` holds the run-import flow, the dedupe context, and batch history/undo/duplicate-report/category/rule-suggestion logic — plus the shared primitives (hashing, amount/date/header parsing, effective-account resolution, imported-category settings) the rest of the package reuses. The leaves carry only cleanly-separable concerns: `profiles.py` (saved data-source / import-profile CRUD), `backup.py` (data + credentials backup/restore and CSV export), `preview.py` (the read-only CSV preview endpoint), and `amazon.py` (the AZAD Amazon order/items import — parse via `services/amazon_import.py`, then create one transaction per order, the funding-charge link, and the reconciliation report). Dependencies flow one way — leaves import from `core` — with a single deliberate exception: `core`'s undo paths need `amazon.reverse_batch_amazon_links`, so they import it **lazily inside the function** rather than at module load. That keeps the module-load graph acyclic (the one place `core` depends on a leaf) while letting undo reverse Amazon links; `__init__.py` is the only place that wires the combined router and re-exports the public surface.

That core concentration is intentional. Import behavior is one of the places where many small decisions have to stay consistent across preview, saved profiles, history, undo, duplicate handling, category application, and rule learning, so the workflow logic that has to agree across those stages stays together in `core` rather than being scattered for the sake of smaller files. The leaf modules were split out precisely because they do *not* share that web of decisions — profile CRUD, the backup/encryption envelope, and preview each depend on `core` through a few named helpers but carry no logic the core needs back — so extracting them relieves navigation and merge-conflict pressure without splitting the parts that must move together.

### Detail panels

- **Panels:** payee detail (`TransactionDetail`), category detail (`CategoryDetail`), account detail (`AccountDetail`), range-scoped transaction listing (`PeriodDetail`, opened by double-clicking a bar on the dashboard's single-period trend chart or from the trend card's "View transactions" link, and by clicking a month bar on the Trends-tab monthly chart), and tag-signature listing (`TagDetail`, opened by clicking a wedge on a dashboard tag-report pie). All five share the same chrome.

- **Shared behavior:** draggable + **resizable** shell, monthly bar charts, month selection, lazy-loaded transaction lists, and page-driven default placement when multiple panels are open. The resize handle in the bottom-right corner converts a docked panel to floating geometry on first drag so size and position stay coherent; the `useDetailPanelChrome` hook owns drag/resize state and `DetailPanelShell` renders the chrome.

- **Stacking and dismissal:** multiple panels can be open at once and each stacks with an offset; the topmost panel carries the strongest edge and elevation while older panels recede. Re-opening the same target focuses the existing panel rather than spawning a duplicate.

- **Reporting contract:** Expense/Income are simply how the user thinks about their data. Expenses can include positive values for various reasons, an expense might get reimbursed, a purchase might be returned for a refund, etc. These monies received are not income, they offset an expenditure. To support this detail drawers and dashboard summaries should not drop rows just because a transaction's sign is unusual for an expense or income category; they include all matching rows for the selected slice and use the net amount.

- **Shared implementation:** `frontend/src/components/detailShared.jsx`

### Help / FeatureExplainer

- **Location:** `frontend/src/help/`

- **Pieces:** a content registry (`content.jsx`) that holds every explainer as `{ id, title, surfaces, summary, body }`; a `<FeatureExplainer topic="...">` popover component for inline `?` affordances next to feature controls; the `/help` and `/help/:topic` routes (`pages/Help.jsx`) for the standalone index and per-topic pages; a `<HelpLink>` component that propagates back-navigation state across hops between topics; and a small `labelForPath` helper for the "Back to `<page>`" affordance

- **Single source of truth:** the same registry powers the popover summary and the standalone Help page body, so the two surfaces cannot drift. Adding a new explainer is one new entry in `content.jsx` plus a `<FeatureExplainer>` drop-in at the feature surface

- **Back navigation:** the popover stamps `state={{ from: <pathname> }}` onto the Read-more `<Link>`; the Help page reads it back to render a labeled "Back to `<page>`" button. `<HelpLink>` is used for cross-topic links inside content bodies so the original source survives multiple hops within the Help section

### Identity, access & deployment model

The settled shape (see `docs/backlog/security-and-deployment-model.md` for the full decision record) is
**one shared workspace with multiple login identities** — not multi-tenant hosting. Every member is
provisioned into the single admin tenant and shares one data DB; there is no per-tenant data isolation
and no hosted multi-tenant target. Per-tenant DB routing (`set_current_db_path`, `TENANT_DATA_ROOT/<id>/`)
is retained as **dormant plumbing** — the code no longer offers to spin up new tenants, but excising the
routing would be risky and low-value, so it stays wired and unused.

- **Login is an authentication *perimeter*, not an authorization system.** Its only job is to keep
  *non-users* out. Once inside, every user sees and edits the **same** data with no row- or scope-level
  restriction. No data route checks role.
- **Admin gates *settings*, not *data*.** The `_require_admin` split (`backend/routers/auth.py`) governs
  user management and environment/provider settings only; nothing at the data layer is admin-gated.
- **One identity concept — a `user_account` — in a single table.** There is no separate local-profile
  table: a perimeter-off identity and an authenticated user are the *same* row, and the "Enable sign-in
  protection" flag decides **only whether the login password is verified**. *Perimeter off* is local mode:
  passwordless `user_account`s picked from a chooser, scoping per-person UI preferences. *Perimeter on* is
  auth mode: the same identities, now password-checked, reusing the accounts / 2FA / roles / password-policy
  machinery. "Password optional" is a **workspace** property (`enable_auth_mode()` / `disable_auth_mode()`),
  never per-user — because the data is shared, a per-user opt-out would let a LAN peer just pick the
  passwordless identity and read the same ledger. `auth_required()` is now **only** the sign-in flag (the
  old `user_count() > 1` latch is gone, so multiple passwordless users are ordinary).
- **Identity is carried by the session in both modes.** The tenant middleware (`backend/main.py`) reads a
  single `session['user_id']` regardless of mode; a perimeter-off session is stamped `pwless` (identity
  chosen via `POST /auth/select-identity`, no password), and enabling sign-in invalidates any `pwless`
  session on its next request (Starlette sessions are stateless signed cookies, so this per-request check
  *is* the invalidation). There is no per-request identity header.
- **Enable and disable are flag flips.** *Enable* claims one existing identity as admin (sets its password),
  marks every other passwordless identity `must_change_password` (claimable at next login), and flips the
  flag (`enable_auth_with_admin`). *Disable* (admin-gated) just flips the flag back — identities and their
  password hashes are preserved (dormant), so re-enabling is seamless; no migration, no re-keying, no
  credential loss. A one-time `_unify_local_profiles_into_users()` at startup folds any legacy
  `local_preference_profile` rows from an older install into `user_account`s (preferences re-keyed) and
  drops the table.
- **Security profile is a setup *preset*, not an enforcement mechanism.** Two deployment shapes:
  **Standalone** (`local_private` — this one machine, loopback) and **Client-server** (`network_private`
  — backend on a networked box, reached from other devices). They steer recommendations (whether sign-in
  is recommended, and the HTTP/HTTPS transport guidance); they do not by themselves force auth on or off.
  (The retired `multi_tenant` and `household_shared` profiles are gone.)

Aggregator token protection (the Plaid/provider vault) is **orthogonal** to this perimeter — a
passwordless install can still hold vault-encrypted tokens because the vault secret is per-user and
independent of the app perimeter. See "Token vault & transport security" below for the vault itself.

### Token vault & transport security

Provider (Plaid/aggregator) access tokens are the crown jewels — a leaked token is live, ongoing bank
access, materially worse than the plaintext ledger — so they get real at-rest protection via a
**multi-wrap envelope vault** (`backend/services/crypto_service.py`). The full decision record is
`docs/backlog/security-and-deployment-model.md`; the shape:

- **One workspace Data Encryption Key (DEK)** encrypts every per-connection secret
  (`connection.credential_enc`; the retired `plaid_item.access_token_enc` was folded into `connection`
  by migration v18 — see "Provider connections" below) and every app-level provider secret
  (`provider_config.secret_enc`). Those two columns are the *entire* set, registered as
  `crypto_service.ENCRYPTED_COLUMNS` so rotation reaches all of them and a test fails if a third is added
  without being listed. The ciphertext travels with data backups, the key material with the control DB.
  **The property is leaked-DB ≠ leaked-tokens**: no live unlock secret ⇒ no KEK ⇒ nothing opens. It
  deliberately does *not* defend a compromised *running* host (the server is trusted and holds the DEK
  while unlocked) — matching the self-hosted/LAN model. The **ledger stays plaintext at rest**
  (host-protected, not vault-encrypted).
- **A slot is a keypair, not a wrapped DEK.** Each `vault_slot` row (control DB) holds a public X25519 key
  in the clear, its private key AEAD-wrapped under the KEK derived from that user's unlock secret, and the
  DEK **sealed to that public key**. Unlocking derives the KEK, opens the private key, and unseals the DEK.
  The indirection is what makes the DEK *giveable*: sealing needs only a public key, so a member can grant
  access to someone whose secret they do not have, and rotation can re-seal for every remaining slot.
  Wrapping the DEK directly (**format 1**, still readable and converted in place at the next unlock) could
  do neither — see the backlog doc's "A slot holds a keypair".
- **Unlock secrets** are a passphrase via `scrypt`, or a passkey's WebAuthn **PRF output** via `HKDF` (no
  stretching — it is already 32 uniform bytes from the authenticator). One passphrase and any number of
  passkeys per user, enforced by a partial unique index; the last method that opens the vault cannot be
  removed. **No WebAuthn assertion is verified**: a wrong PRF output fails at the AEAD tag exactly as a
  wrong passphrase does, so the slot is self-verifying and no WebAuthn library is needed. WebAuthn's own
  two preconditions — a secure context, and an RP id that is a domain rather than an IP address — are
  detected server-side and returned as stated reasons, since the answer to both is "use a passphrase here".
- **Unlocking** holds the DEK in a **server-side, in-process cache keyed by `user_id` with an idle TTL** —
  *never* the signed session cookie (which serializes to the browser). Dropped on logout and on restart
  (re-unlock ⇒ "first sync of the day"). Endpoints: `POST /auth/vault/{set-passphrase,change-passphrase,
  unlock,lock}`, `/auth/vault/passkey/{params,register,unlock}`; status via `vault_configured`/
  `vault_has_passphrase`/`vault_unlocked`/`vault_access_pending`. Connect/sync and credential
  export/restore require an unlocked vault (`423`; connect on an unconfigured vault `409`). There is **no
  `off`/plaintext path and no app-held master key** — the vault is the only custody. Every passphrase must
  meet **≥ 20 chars and ≥ 6 distinct characters** (`passphrase_meets_production_min`; the distinct-char
  guard rejects a long-but-degenerate repeat), an *all-slots* property since the DEK is only as strong as
  its weakest wrap. The passphrase is meant to live in a password manager, so length is cheap; the set
  dialog shows an **advisory strength meter** that blocks nothing.
- **Enrollment, revocation and rotation.** Setting a passphrase (or registering a passkey) as a user the
  vault does not yet know **enrols** them: the slot is written with no sealed DEK and reports
  `vault_access_pending` — a state distinct from "locked", because no secret they could enter would help.
  Any member holding the DEK approves it (`/auth/vault/access-requests/{slot}/approve`, `423` if locked);
  admins revoke (`/auth/vault/access/{user}/revoke`). `GET /auth/vault/members` lists who currently holds
  access, grouped per person with a count of their unlock methods — the counterpart to the request queue,
  and what makes "remove someone's access, then rotate" an instruction with something to act on. `POST /auth/vault/rotate` mints a new DEK and
  re-encrypts every registered column under it, in **three phases** — seal the new key into every slot
  (retaining the outgoing one in `sealed_dek_prev`), rewrite the ciphertext, then clear the previous seals
  — because no transaction spans the control and data DBs, and a failure between the two writes would
  otherwise strand every credential under a key no slot can produce. An interrupted rotation is **resumed**
  on the next call, never restarted. Revoke *then* rotate: rotation re-seals for whatever slots remain.
- **Transport** is a per-topology property, not an app mode: the backend always speaks HTTP; a
  client-server deployment terminates TLS at a reverse proxy (Caddy) with uvicorn on `--proxy-headers`,
  so `request.url.scheme` reflects the external scheme. `backend/transport.py` detects loopback-vs-network
  and HTTPS **per request**. The permissible-HTTP rule: plain HTTP on a networked bind is fine only with
  no perimeter to defeat (no sign-in, no provider); either trigger ⇒ HTTPS. Enforced/nudged by
  `SESSION_COOKIE_SECURE` (→ cookie `Secure`, set by the install, not derived from the profile), a
  `transport_warning` when connecting a provider on a cleartext link, and a **computed "Set up HTTPS"
  task** (`tasks.py`) — required/non-dismissible for a provider, recommended/suppressible for plain
  client-server, self-clearing over HTTPS.

### Provider connections (the aggregator seam)

Data-source aggregators reach the app through **one provider-neutral seam** (security-and-deployment-model
phase 6a), so adding Teller or SimpleFIN is an adapter, not a change to the connect/sync callers.

**One sync writes to three stores, and which one a fact belongs in is decided by who may lose it**:
durable *connection status* on `connection` / `connection_account` (cursor, last outcome + summary,
coverage, allowance — provider-shaped, and expected to differ per adapter); a disposable *diagnostic
history* in `connection_sync_log` (capped, pruned, user-clearable, so nothing user-facing may derive from
it); and the *bundle of transactions received* on `import_batch` + `import_batch_account`, which behaves
like a CSV import card apart from the monthly-vs-per-file boundary. Full rule, and the two defects that
came of leaving it unstated, in `docs/data-model.md`.

- **Storage.** A `connection` row (`backend/db/database.py`) is the durable credential boundary: a
  `provider` discriminator, the provider's stable `external_id` (Plaid's item_id), and the opaque
  per-connection credential vault-encrypted under the DEK (`credential_enc`; plaintext column always ''
  — see the vault above). It **superseded `plaid_item`**, which was dropped in migration v20 (phase 6b-3).
  Accounts link to their connection via an explicit `account.connection_id` FK (→ `connection.id`,
  `ON DELETE SET NULL` — a disconnected account keeps its rows but drops to `NULL`); `account.provider`
  records origin (`plaid`/`csv`/`manual`) and `account.external_account_id` (renamed from the old
  `plaid_account_id`) is the provider's per-account handle / sync upsert key. CSV and manual accounts have
  `connection_id IS NULL`.
- **Adapter interface.** `backend/services/providers/` exposes `get_adapter(provider)` over a
  `ProviderAdapter` (`connect(app_config, payload)` → `{external_id, credential, institution}` /
  `fetch_accounts` / `fetch_transactions` / `fetch_transactions_sync` / `remove`), normalized to
  provider-neutral dict keys (`external_account_id`, `external_transaction_id`, …). Adapters delegate SDK
  details to a thin per-provider boundary (`plaid_service`) or speak the protocol directly (`simplefin`).
  The connect and sync paths speak only the adapter + `connection` table — never a provider's field name.
- **Capability declarations, not branches on provider name.** The seam was first built around Plaid, and
  several of its traits turned out not to be universal. Each is now a class attribute an adapter declares,
  so a caller asks the adapter rather than knowing which providers are special: `connect_spec` (a Link-style
  widget vs. a pasted token — it also drives what the connect UI renders), `requires_app_config`,
  `has_cursor`, `max_history_days`, `routine_lookback_days`, `revokes_on_disconnect`, `zero_amount_rows`,
  and `connect_requires_production_vault(payload)`. Adding a provider means declaring these; it should not
  mean editing the routers, the sync loop, or the Connections tab. `zero_amount_rows` is the one with **no
  default** — what a $0 row means does not generalize between sources, so an undeclared one must fail
  rather than inherit. It also spans beyond adapters: the CSV and Amazon importers are data sources with no
  class to hold an attribute, so they declare through the registry in `services/source_capabilities.py`.
  **See `docs/building-a-connector.md`** for the full checklist of provider traits that turned out not to
  be universal (id uniqueness, currency, budgets, coverage claims, reporting refusals) and the failures
  each one prevents.
- **One connect flow, two entry points.** `providers.establish_connection` is the whole flow after the
  handshake — demo/vault gates, credential encryption, the `(provider, external_id)` upsert,
  `upsert_connection_accounts`, the unmapped count. Link-style providers reach it via `POST
  /plaid/exchange` (which needs its own route only because the payload arrives from the widget's callback);
  everything else via the generic `POST /api/providers/{provider}/connect`. Both converge on its first
  line: a second copy of that tail would be free to drift on credential custody and account adoption,
  which is exactly what the seam exists to prevent.
- **Sync speaks to cursor and non-cursor providers identically.** `fetch_transactions_sync` defaults on the
  base class to a **range pull** (fetch a window, present it as one complete page), so a provider with no
  change feed needs no special case in `run_sync`. Its return separates three questions that a
  cursor provider lets you conflate: `has_more`/`update_status` (more to deliver *right now* — the
  poll-again signal), `backfill_complete` (history fetched to its *end*), and `resume_later` (stop polling,
  but the backfill is unfinished — resume on a later sync, which is how a metered provider pauses without
  the connection being marked done and its remaining history stranded). `account_coverage` reports how far
  back the pull *actually* reached **per account**, since a walk that stops early — out of history, or out
  of request budget — covers less than it asked for, and may have covered some accounts and not others.
  Overstating either makes duplicate detection reject genuine rows (`docs/data-model.md` → "coverage has
  two shapes") — and a paged pull sharpens that rule: a page reports only the accounts *it* advanced, never
  the ones still waiting their turn, since seeding coverage from where an account already stood claims
  depth the page never fetched. `removed` is unavoidably empty on the range-pull
  path: the provider *cannot report* deletions, which is not the same as confirming there were none.
  **Each page is applied and committed before the next is fetched**, so no write transaction spans a
  provider call — SQLite serializes writers, and a transaction held across a multi-minute pull left the app
  routing but unable to load anything that writes. Two contract pieces exist for that shape: `continuing`
  (false on a pull's first call, true on its pages) for work belonging to the pull rather than the page,
  such as SimpleFIN's one-per-pull recent-window top-up; and `budget_checkpoint`, which a metered adapter
  calls after debiting and *before* issuing the request, so a crash can only forfeit an unused allowance
  rather than lose the record of a request already made. Progress is committed with each page
  (`connection.sync_progress`), which is what lets any request observe a pull still in flight — the pull's
  own HTTP response cannot, being a single call that returns only at the end.
  `run_sync` takes `full_history` to tell an initial/deepening pull from a routine top-up (they otherwise
  send identical arguments), and `provider` to scope a sync so one card cannot spend another provider's
  request budget. A pull may also return **`warnings`** — problems that did not fail it, such as one bank
  on a multi-bank credential needing re-authentication while the rest delivered. These are reported rather
  than only logged because the pull *succeeds*: a partial failure wearing the appearance of a clean sync
  is the one failure mode nothing downstream would ever notice.
- **An account added on the provider's side is discovered by syncing, but never mapped by it.** Sync does
  not ask a provider what accounts it has — it matches incoming transactions to accounts by external id —
  so an account added after a connection was built would otherwise be invisible: its transactions match
  nothing, are counted as skipped, and are dropped. When a transaction arrives for an id with no
  `connection_account` row, the sync fetches the provider's account list once and records the newcomers as
  **unmapped**, which is what raises the existing "N to map" nudge. The guard is the `connection_account`
  row and *not* whether a local account exists: those differ precisely for an account the user chose to
  **skip**, which has a row and no account, and keying off the account would re-fetch the provider's list
  on every sync forever. Discovery deliberately stops short of creating anything — auto-creating a local
  account per provider account is the behaviour the mapping seam exists to replace.
- **History state is per account, and the caller owns it.** How far back an account has been fetched
  (`coverage_start_date`) and whether it has any older data at all (`history_complete`) live on
  `connection_account`, because both are facts about an individual account: a connection's accounts do not
  advance together once one is added on the provider's side later. `run_sync` therefore decides the work —
  which accounts still want older data, and how far back — and passes `account_targets` down; the adapter
  fetches and answers with `account_coverage`, what it *actually* reached per account. The adapter holds no
  history state of its own.

  This is what makes one loop serve a first backfill, a deepening pull, and a late-arriving account alike:
  they differ only in which accounts are targets. A newcomer needs no instruction and no scheduling — it
  simply has no coverage, so it is a target like any other, and budget exhaustion needs no parking because
  each account's recorded reach *is* where it resumes. An earlier design bolted a separate catch-up
  instruction beside a connection-level `history_exhausted` flag; that mechanism existed only to work
  around the state being stored at the wrong level, and disappeared once it moved.

  A cursor provider reports no `account_coverage` (it maintains one window across the whole item, so the
  requested depth is the accurate claim) and ignores `account_targets` — a cursor is a checkpoint in a
  change feed, not a date range, so there is no way to ask it for one account's history.
- **A window is bounded by a date range, not an account**, which decides when to filter. One unfiltered
  request advances every account that wants that period, so filtering a plural set would multiply requests
  without fetching anything more (three accounts over three years: 25 requests unfiltered, 75 filtered).
  The rule is therefore to fetch unfiltered whenever two or more accounts want a window and to narrow only
  when one does — where it costs the same and saves bandwidth. Re-fetching rows already held is free in the
  rationed dimension: they are idempotent-skipped on `external_transaction_id` before reaching duplicate
  detection.
- **A walk that has moved back from today spends its first request on the recent window.** Every window
  such a walk fetches is old, so without this no *new* transaction would arrive for however many days the
  walk takes to finish — and the recent ledger is the part a user actually looks at, while history is what
  they consult later. A walk still starting at today skips it, since its own first window already covers
  that period. The watermark this advances (`through`, where the next top-up begins) moves **only** after
  the fetch: advancing it for a pull that fetched only old windows would silently skip everything between
  the real last top-up and the new watermark.
- **The ledger's currency is a setting, and adapters are *told* it rather than assuming one.**
  `services/ledger_currency.py` owns the value (tenant state in `import_workflow_state`, default USD);
  `run_sync` resolves it per connection and passes `ledger_currency` into `fetch_transactions_sync`, the
  same "the caller owns the database, so it owns the facts in it" rule that governs `account_targets`. An
  adapter drops transactions from an account the provider states is denominated differently and reports
  them as `unsupported_currency`. **The question is "does this match the ledger", never "is this dollars"**
  — the app's constraint is one currency at a time, so a consistently-AUD ledger is entirely correct, and
  an earlier hardcoded `"USD"` comparison would have discarded every transaction of a non-US user whose
  data was never wrong. Nothing outside `ledger_currency.py` may compare against `DEFAULT_LEDGER_CURRENCY`.
  Both adapters implement it, and *where* each judges differs because the providers report differently:
  SimpleFIN states a currency per **account**, so its walk skips a mismatched account wholesale; Plaid
  states one per **transaction** (resolving `iso_currency_code` / `unofficial_currency_code` — the latter
  being crypto and unsupported currencies, which can never equal an ISO ledger), so its adapter filters
  `added` and `modified` row by row. Per-row is the stricter reading, and Plaid's data supports it: the
  number in `amount` is judged on its own terms rather than on an assumption about its account.
  `GET`/`PUT /api/currency` read and write it; the PUT answers **409** when the ledger already holds rows
  and the caller has not confirmed, because the change converts nothing and therefore silently relabels
  every historical amount (and, for the same reason, is perfectly reversible — a confirmation is the right
  guard rather than a prohibition). The frontend's `MONEY_DISPLAY_CONFIG` mirrors it at boot, with the
  symbol derived from `Intl` rather than a maintained table; Settings reloads after saving because the
  money formatters read that config at call time and nothing would otherwise re-render.
- **The provider's own conformance checklist is a design input, not a formality.** SimpleFIN publishes one
  (protocol page → *Checklist*), and three of its items are things reasoning from the protocol description
  does not produce, because they are about the *user's* security posture rather than the request: a failed
  claim must be reported as a possible **interception** (a setup token is single-use, so a claim that fails
  may mean someone else spent it, and only the user can disable it at the Bridge — "generate a new one" is
  the reassuring reading of identical evidence); a 403 on a data call must be handled as its own condition;
  and error text from the provider must be sanitized before display. React escaping covers injection, so the
  live risk there is **volume** — provider strings are clipped in the adapter (`_clip`, `_MAX_MESSAGE_CHARS`)
  at the boundary rather than at each consumer. One item is deliberately not followed to the letter:
  "display error messages from `/accounts` to the user" is applied to bank-level codes only, with request
  advisories routed to the log, because a note about our own date range sitting beside "your bank needs
  re-authentication" trains the user to ignore both. **Check a new provider's conformance list before
  writing its adapter, not after.**
- **Sync health is recorded per connection and travels with the connection list.** `run_sync` stamps
  `last_synced_at` on success only (so a failing connection reads as stale rather than recently synced),
  counts `consecutive_sync_failures` (reset, not decremented, by any success — what distinguishes a blip
  from a connection that has stopped working), and stores the most recent error and warning set. These
  ride `GET /api/providers` alongside each connection rather than sitting behind their own call,
  because the Connections card has to surface them **while collapsed** — a failure that only appears once
  a card is expanded is one nobody sees. See `docs/data-model.md` for what each field may and may not mean.
- **"Reconnect this" is a separate signal from "syncing failed", because only one of them is actionable.**
  An adapter raises `ProviderCredentialRejected` (`services/providers/base.py`) when the provider has
  stopped accepting the stored credential; `run_sync` sets `connection.reauth_required` (migration **v30**),
  which is sticky until a pull succeeds and is what the card leads with, suppressing the ordinary failure
  pill so the two do not say the same thing twice. Everything *else* is deliberately left undifferentiated —
  a user cannot act on the difference between a network blip and a provider outage, only on how long it has
  been going on, which the failure count already says. This matters most for a provider with no revocation
  API (SimpleFIN): revoking at the Bridge is the only way a user *can* revoke, and the refusal recorded here
  is the only notice the app ever gets that they did. Today only the SimpleFIN adapter raises it (403 on a
  data call); Plaid's `ITEM_LOGIN_REQUIRED` is the obvious second source and is not yet wired.
- **Credential continuity.** `crypto_service.encrypt/decrypt_connection_credential` binds the ciphertext
  to `(provider, external_id)`; for `provider='plaid'` it reuses the exact pre-6a AAD
  (`plaid_item|<item_id>|access_token`), so tokens written before the cutover decrypt unchanged — the
  migration re-keys nothing.
- **App-level credentials (phase 6b-1).** The aggregator's *own* app secret (Plaid `client_id`/`secret`/
  `env` — one per provider, distinct from the per-bank connection credential) lives in the vaulted DB
  `provider_config` table: only `secret` is vault-encrypted (`secret_enc`, AAD `app_credential|<provider>|
  secret`); `client_id`/`env` are semi-public plaintext. `providers.config.resolve_app_config(user, provider)`
  returns the decrypted `{client_id, secret, env}` the adapter needs — a saved row is authoritative,
  else it falls back to the **`.env` bootstrap** (`PLAID_*`), so pre-6b installs keep working with no
  action. Every adapter method takes this resolved `app_config` (never reads the environment itself).
  A provider that has **no** app-level credential (`requires_app_config = False`, e.g. SimpleFIN) receives
  `{}`: for it, "nothing configured" is the permanent normal state rather than setup left undone, so it
  reports itself *configured* once it has a connection, offers no Configure action and no environment
  badge, and — having no sandbox — is gated on a Production-strength vault at **connect** time, there
  being no later moment at which to ask.
  Admin-gated CRUD is `GET/POST /api/providers/{provider}/config` (`routers/providers.py`); saving the
  secret needs the vault unlocked (`423`), and switching a provider to Production still runs the all-slots
  vault gate. App credentials ride the **credentials backup** (`provider_configs`) alongside connections.
  There is **no `.env` → DB migration** — the credential is re-entered once via the Configure card
  (decided 2026-08-01).
- **Connections-tab UI (phase 6b-2).** `DataSourceConnections` (in `pages/Accounts.jsx`) renders the
  Connections tab as one card **per provider** (driven by `GET /api/providers`): a mode badge, admin-only
  **Configure** (the app credential — moved off the Settings form entirely; that section now only points
  here), **Connect bank**, **Sync now**, and the linked accounts. It also hosts the **vault set-passphrase
  / unlock** affordance (phase 3 deferred the vault UI to "ride the connection cards") — set/unlock post to
  `/auth/vault/*` and refresh the session's vault flags. Everything here needing an open vault (connect,
  sync, deepen history, refresh accounts, disconnect, the app-secret reveal/save) goes through one gate,
  `lib/useVaultGate.js`: it raises the passphrase dialog and the action **resumes** when the unlock lands,
  so a locked vault costs a passphrase rather than a passphrase plus a repeated gesture, and a `423` is
  handled as that same gate arriving late rather than surfaced as a failure (see `ui-patterns.md`).
  **Connect** additionally requires — on a networked (non-loopback) bind — real HTTPS
  (`transport.is_https` from `/auth/status`), so a bank secret never crosses the wire in cleartext; that
  one is a refusal, since no dialog on the page can resolve it. Each card lists its **connections** (from
  `GET /api/providers`, which returns them per provider) with a **Disconnect** action → `POST
  /api/providers/{provider}/disconnect`, which **revokes the token provider-side where the provider allows
  it** (the adapter's `remove` op → Plaid `/item/remove`, so a leaked copy dies too) then drops the local
  `connection` row, keeping the accounts/transactions. Where it does not (`revokes_on_disconnect = False`
  — SimpleFIN publishes no revocation call), `remove` is a documented no-op and only Luma's copy goes; the
  confirm dialog says which of the two is happening, because a user who believes access ended when it did
  not is worse off than one who knows to go and revoke it at the provider.
- **The mapping seam (`connection_account` + `routers/connections.py` + `services/connection_mapping.py`).**
  Connecting a bank used to create one local account per provider account, with no chance to say "this
  *is* my existing Northgate Voyager." That was not only a UX gap next to CSV import's account step — **it was
  the missing input to duplicate detection**, because the ladder's cross-account rules fire only when the
  receiving account already appears in the matching coverage *or* was explicitly declared an alias, and a
  sync could satisfy neither. So `POST /plaid/exchange` now records provider accounts into
  `connection_account` (unmapped) and creates nothing; a **required mapping step** runs after Link and
  **before the first backfill**, so the very first batch of rows is deduped against whatever the mapped
  accounts already hold instead of arriving unattached. `upsert_connection_accounts` became
  *mapping-driven*: it materializes accounts from `connection_account` rather than blindly creating one per
  provider account, and "Refresh accounts" adds newly-seen provider accounts as unmapped while re-applying
  existing decisions. Endpoints: `GET /api/connections/{id}/accounts`, `POST .../account-map` (idempotent;
  triggers the re-scan when a mapping changed), `POST .../captured-fields`.
  See `data-model.md` → Accounts for the modes and what each buys the ladder.
- **`routers/connections.py` also owns the reverse: `GET`/`DELETE /api/connections/{id}/synced-transactions`,**
  the preflight and the removal of everything a connection has synced. Its rows go through
  `import_export/core.py`'s `undo_batches` — the one path a file's Undo, a re-import's replace, and this
  share — and it then resets the chain that *describes* what has been pulled: cursor,
  `initial_sync_complete`, and the connection's coverage columns. That reset is the point of the endpoint
  existing at all (a cursor left advanced past deleted rows makes them unreachable), and it is the only
  writer of the "a cursor reset clears both coverage columns" invariant. No provider call and no
  credential are involved, so unlike sync/disconnect/refresh it works with the vault locked.
  See `data-model.md` → "Sync import cards" and `ui-patterns.md` for the decisions behind it.
- **Captured fields are declared by the adapter, not hardcoded per provider.**
  `ProviderAdapter.capture_fields()` returns `[{key, label, locked, default_on}]`, so each adapter states
  its own set and a Teller/SimpleFIN adapter is unaffected by the Plaid choices. **Locked** fields are the
  ones duplicate detection depends on and are not the user's to disable (`authorized_date`,
  `provider_description`, `counterparties`, `merchant_entity_id`, `check_number`); optional ones
  (`location`) are user-selectable and persist as `connection.captured_fields`. `authorized_date` is a
  first-class `txn` column; everything else goes into `import_evidence_json` **in the identical shape a CSV
  import writes**, which is what makes a synced row visible to the text matcher and — via
  `evidence.account.value` — to the terminal-window matcher. Plaid's `personal_finance_category`,
  `payment_channel`, and `transaction_code` are deliberately not captured (the app's own rules own
  categorization).
- **Duplicate detection for connection rows lives in `services/connection_dedupe.py`**, which both the sync
  path and the re-scan share: one context builder over a connection's mapping, so the two moments a
  connection's rows meet the ladder ask the same question with the same inputs. The **re-scan** is the
  retroactive half of the mapping feature — rows synced before a mapping existed were judged with no
  cross-account premise available, and re-judging them is what turns a mapping decision into a cleanup.
  It runs **only** from applying a mapping, and has no endpoint or user-facing trigger of its own:
  every other occasion that changes what a connection's rows should be compared against already runs
  detection at that moment (a CSV import and a sync each sweep their own batch — and a CSV import's
  ladder reads the connection's coverage; an account merge scans the newly-unified group), so a
  user-driven re-check had no state left to reach and was removed rather than kept as a lever whose
  only remaining job was to change which side of an already-visible pair got flagged.
  Two properties are load-bearing and directly tested: the pass excludes **the whole connection's own
  batches** from its candidate pool (excluding only "self" would let two rows from the same connection
  reject *each other*, trashing both copies of a transaction that has one duplicate), and it removes a row
  only when it can **name the surviving counterpart** — coverage can hard-reject on the range alone, which
  is right for a row nobody has seen yet but not for one already in the ledger with a category on it.
  Removals are trashed, never deleted, carrying `rejection_reason='duplicate_confirmed'` +
  `dedupe_resolved_by='connection_rescan'` + the `suspect_duplicate_of` audit pointer — the same state an
  account merge produces, so the card's duplicate report shows them and Restore returns them intact.

### Database concurrency

**The backend is multi-threaded, and always has been.** FastAPI runs plain `def` endpoints in a worker
threadpool, so several requests genuinely execute at once — a fact worth stating because it is invisible in
code that contains no threading of its own, and it changes what "safe" means for anything touching the DB.

**Nothing is shared between those threads.** `get_db()` opens a *fresh* `sqlite3` connection per call and
closes it at the end of the block; there is no pool, no module-global connection, and no caching.
`check_same_thread` is left at its default (`True`), which is correct here precisely because connections
are never handed across threads. DB routing is per-request for the same reason: `_current_db_path` is a
`ContextVar`, not a global, so the control-DB / data-DB split cannot leak between concurrent requests. The
practical consequence is that **there is no Python-level data race to defend against** — the concurrency
that matters is SQLite's own.

**WAL means readers never block; writers serialize.** Any number of requests can read while one writes, so
contention shows up only between writers, and it shows up as *waiting*: a blocked writer waits out the busy
timeout (`_BUSY_TIMEOUT_SECONDS`, explicitly set — Python's 5-second default was never chosen for this
workload) and then fails with `database is locked`. Data is never lost to contention, but a request can be.

**So the rule that matters is: never hold a write transaction across slow work.** A transaction spanning
network I/O converts "one slow operation" into "every writing request fails for the duration", which is how
a long sync used to leave the app routing but unable to load anything — navigation is client-side, so
clicks worked while the recurring auto-scan on app load, preference saves, and cache updates all timed out.
The provider-sync path is the case this was learned on and the pattern to copy: fetch with nothing open,
apply, commit, repeat. `backend/routers/import_export/core.py` also shows the defensive half — a read
endpoint whose best-effort write is wrapped so transient lock contention degrades instead of 500ing.

**Commits are genuinely durable, and cheap enough to take often.** No `PRAGMA synchronous` is set, so it is
SQLite's default `FULL`: each commit fsyncs the WAL and survives power loss, not merely process death. The
WAL being append-only also guarantees ordering — a later commit cannot survive without an earlier one. At
roughly a millisecond each they are noise beside anything network-bound, which is why the sync path commits
per page rather than batching.

### Storage layers

Luma uses several distinct storage layers for working state.

#### Browser-local storage

- **Lives in:** browser `localStorage` and browser `sessionStorage`

- **Lifespan:** `localStorage` survives reloads on the same browser profile until cleared; `sessionStorage` lasts only for the current browser tab/session

- **Contains:** browser-specific remembered identity selection (a convenience auto-select; the session cookie is the source of truth), import draft/fallback state, migration fallback values from older UI preference storage, and other machine-local or browser-local UI state that should not be treated as durable shared preference data

#### Frontend session state

- **Lives in:** React state in the running frontend session

- **Lifespan:** lasts until page reload, app restart, or active user/profile change

- **Contains:** in-memory copy of loaded user/profile preferences, transient edit drafts, open/closed UI state for the current interaction, and other short-lived state needed to keep interaction responsive

- **Key files:** `frontend/src/lib/UserPreferencesContext.jsx`, `frontend/src/lib/api.js`

#### Preference storage in the control database

- **Lives in:** `backend/luma-control.db`

- **Lifespan:** durable until explicitly changed or cleared

- **Contains:** UI preferences keyed to the current identity's `user_id`, and other small JSON-friendly UI preference values that follow the active identity

- **Scope:** always keyed to `user_id` — the same key whether the perimeter is on or off (the middleware resolves the identity from the session in both modes), so there is no profile-id ⇄ user-id re-keying

- **Key files:** `backend/db/control\_database.py`, `backend/routers/auth.py`, `frontend/src/lib/UserPreferencesContext.jsx`

#### Identity records in the control database

- **Lives in:** `backend/luma-control.db`

- **Lifespan:** durable until explicitly deleted

- **Contains:** the single `user_account` table — one identity concept for both modes. Perimeter-off identities are passwordless rows (unset-password sentinel); enabling sign-in assigns passwords/roles to the same rows. There is no separate local-profile table.

- **Properties:** perimeter-off identities are picked from the chooser in `frontend/src/App.jsx`, which establishes a `pwless` session via `POST /auth/select-identity`; the same rows become authenticated users when the perimeter is on

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

- **`Reset to first-run`:** deletes every `user_account` identity and reloads to the welcome screen. In auth mode it first turns sign-in protection off (admin-gated) — which drops to local mode so the identity endpoints are reachable and the keep-one-admin guard no longer applies — then removes all users (the current session's own identity last, so deleting it doesn't 401 the rest). Passwords/2FA/recovery codes go with the accounts. `Clear all` performs this same reset plus the preference/import-memory/browser clears.

These resets remain separate because they target different storage layers with different lifespans and different effects on startup behavior.

The separation is important because "resetting the app" can mean very different things in practice. Browser-local troubleshooting, preference cleanup, import-workflow cleanup, and resetting to first-run are all recoveries with different blast radii, so the tooling keeps them explicit instead of hiding them behind one broad reset.

## Cross-platform approach

Luma is intended to run on:

- Windows

- Linux

- macOS

- Raspberry Pi / ARM Linux

Where commands differ, the repo should provide script wrappers or document the differences clearly in `README.md`.

## Where to change things

- **New API behavior:** add or update a router in `backend/routers/`

- **Schema changes:** update `init_db` **and** register a `@migration(N)` (plus a `POST_RESTORE_DATA_INIT[N]` step when the migration *derives* data from existing rows) in `backend/db/database.py` — see "Schema evolution" in `docs/data-model.md` for the full checklist and the migrations' two-halves / post-restore-data-init contract

- **Shared transaction editing/display behavior:** update `TransactionRow.jsx`

- **Shared detail-panel behavior:** update `detailShared.jsx`

- **User-facing setup or behavior changes:** update `README.md` and possibly `CHANGELOG.md`
