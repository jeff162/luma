# Data Model

This is the working model FinTrack is built around.

This document focuses on data semantics and invariants. For how these are exposed through the API and UI, see `architecture.md`.

## Contents

- [Core hierarchy](#core-hierarchy)

- [Owners](#owners)

- [Accounts](#accounts)

- [Transactions](#transactions)

- [Categories](#categories)

- [Rules](#rules)

- [Import batches and profiles](#import-batches-and-profiles)

- [Backups](#backups)

- [Schema evolution](#schema-evolution)

- [Reporting assumptions](#reporting-assumptions)

## Core hierarchy

The main relationship chain is:

`Owner -\> Account -\> Transaction -\> Category (leaf) -\> Category Group`

In practice:

- an **owner** represents a person or household bucket

- an **account** belongs to one owner

- a **transaction** belongs to one account

- a **transaction** may be assigned to one leaf category

- a **leaf category** belongs to a top-level category group

## Owners

Owners represent household members or shared buckets such as:

- Alice

- Bob

- Shared

They are used for:

- assigning accounts

- scoping some rules

- splitting dashboard views

- surfacing ownership-related tasks

Transactions also carry `owner\_id`, denormalized from the account, so owner-based filtering is cheaper in summary queries.

## Accounts

Accounts represent bank or credit accounts, typically imported from Plaid or created during CSV import.

Important behavior:

- each account belongs to an owner or is temporarily unassigned

- transactions reference `account\_id`

- account ownership affects owner-based reporting and tasks

- `display_name` is the effective label used outside the Accounts page; standalone accounts keep it aligned to `name`, while merged child accounts inherit the parent's display name

- `parent_account_id = NULL` means the row is a top-level selectable account; child accounts keep historical account numbers visible on the Accounts page but resolve through the parent for account filtering, import/export display, and other account-facing surfaces

- regrouping one merged parent onto another top-level account flattens the dragged group's visible members so they all become direct children of the new parent; the old parent remains as one of those children rather than preserving a deeper tree

- `trashed_at != NULL` means the child account is hidden but still recoverable; emptying the trash is the irreversible step that folds remaining references into the parent and deletes the child row

- the sparse table `account_pair_distinct` records the user's explicit "these two accounts are different physical accounts" assertions, written automatically when the user clicks Keep on a cross-account soft-flag suspect. Rows are stored canonically with `account_id_low < account_id_high` so each pair has exactly one row. The dedupe sweep consults this table to skip pairs the user has already reviewed, and the management UI on the SuspectDuplicates page can forget an assertion to re-enable detection. Merging two accounts deletes any row between them (the merge contradicts the distinct assertion)

## Transactions

Transactions are the central fact table.

Important conventions:

- `amount \> 0` means money out

- `amount \< 0` means money in

- `category\_overridden = 1` means rule reruns must leave the current category alone

- `category\_source` records whether the current category came from a manual edit, an import that used categories present in the data, or a rule

- `import\_evidence\_json` stores a compact subset of the original import row for cross-source duplicate detection and later explanation; this is intentionally narrower than a full raw-row archive and focuses on source account/description labels plus a few statement-like text fields

- pending transactions are visible in lists but usually excluded from summary totals

- `trashed_at != NULL` means the row is soft-deleted; every read path (the raw list, the summary endpoints, the dashboard, the import-card counts) filters it out, but the record stays in `txn` until the user empties the transaction trash from Settings, mirroring the account-trash pattern. The Settings → Trash view and the empty-trash operation are the one exception to "all trashed rows": both deliberately exclude confirmed-duplicate rows (`rejection_reason='duplicate_confirmed'` — see below), so the manual Trash only ever surfaces user-deleted transactions and emptying it cannot destroy a dedupe decision's restore path

- `suspect_duplicate_of`, `suspect_duplicate_reason`, and `suspect_resolved_at` together carry the soft-duplicate flag set by the post-import sweep when an imported row matches an existing row on a different account by (date, amount, normalized payee); the reason is `cross_account`. The sweep runs unconditionally for every batch row — there is no "brand-new account" precondition — and is gated only by the per-pair-distinct table `account_pair_distinct`. Flagged rows show a badge in lists and surface in a review report under Tasks until the user resolves each with Keep (asserts the two accounts are distinct, cascade-clears every other flagged row between the same pair, records the pair in `account_pair_distinct`) or Reject (confirms the row is a real duplicate)

- `rejection_reason` discriminates *why* a `trashed_at` row was excluded from the active ledger: `NULL` means user-driven cleanup ("trash"), while `'duplicate_confirmed'` means a soft-flag suspect was accepted as a real duplicate — either by the user via the unified duplicate-detection report or automatically as a side effect of an account merge. Both states hide the row from active reads through the same `trashed_at` filter; the discriminator lets the unified report group confirmed soft-flags alongside the import-time hard-rejects in `import_batch_duplicate` while keeping user trash a separate concern. That separation is enforced, not just conceptual: the Settings → Trash list (`GET /transactions/trash`) and the empty-trash delete (`POST /transactions/trash/empty`) both filter on `rejection_reason <> 'duplicate_confirmed'`, so confirmed-duplicate rows never appear in the manual Trash and an empty-trash never deletes them. This is deliberate — those rows are not user-deleted items, they belong to the originating file's duplicate report, and keeping them undeletable from here preserves the restore paths (account detach for `auto_merge`, "undo reject" for `user` — see `dedupe_resolved_by`). The `suspect_duplicate_of` pointer is intentionally kept after a confirmed-duplicate rejection as an audit trail of which existing row was accepted as the canonical copy

- `dedupe_resolved_by` records the provenance of a `rejection_reason='duplicate_confirmed'` resolution: `'user'` means the user explicitly clicked Reject in the dialog, `'auto_merge'` means `promote_in_group_suspects_to_confirmed` flagged it as a side effect of an account merge, and `NULL` means either unresolved (active suspect) or legacy data from before the marker existed. This is what lets `detach_account` safely reverse merge-time auto-promotions without trampling deliberate user decisions: detach restores only `'auto_merge'` rows

These conventions are meant to preserve user intent and keep reporting stable.
`category_overridden` and `category_source` exist so automated categorization can stay helpful without silently undoing deliberate user choices or imported categories the user chose to keep.

Name fields:

- **`raw\_name`:** imported or provider-supplied name

- **`merchant\_name`:** cleaned display name when available

## Categories

Categories are intentionally limited to **two levels**:

- top-level **groups**

- child **leaf categories**

Examples:

- Group: `Food & Drink`

- Leaf: `Groceries`

- Leaf: `Dining Out`

Important invariant:

- transactions should be assigned to leaf categories, not groups
- category and group names must be globally unique after trimming/case-folding so pickers, rule suggestions, and import review never have to guess which branch a label means

The underlying concern here is ambiguity. FinTrack tries to keep category assignment, rule generation, and import review understandable and reversible, which is much harder if one visible label can point to more than one branch or if a transaction can be assigned to a reporting bucket that still has unresolved children beneath it.

Groups also carry important reporting behavior:

- **`category\_type`:** typically `expense` or `income`

- **`exclude\_from\_totals`:** removes that group and all descendants from charts and totals

- category appearance is derived in the UI from stable ids/names rather than stored as user-managed color metadata

- the system also reserves a protected top-level **`Unassigned`** group for imported categories that are real, usable categories but have not yet been moved into a user-chosen reporting group; this group participates in filters/reporting but cannot be renamed or deleted
- when `Unassigned` has no child categories, category-management surfaces may hide it until imported categories populate it again

`Unassigned` exists to keep imported categories usable immediately without forcing the user to stop and redesign their reporting tree during import. Protecting the group keeps that temporary landing zone predictable for imports, undo, and later cleanup.

- top-level group `sort_order` is the shared order used by the Categories page and category pickers; unless a user deliberately reorders a section, new groups should join that section in alphabetical order

This is used for things like transfers and credit-card-payment categories.

Categories and groups themselves do **not** have an `owner_id`; the column was dropped in migration `m19_drop_category_owner_id`. The dimensions a user wants to report by — personal/shared, essential/discretionary, business/personal, and similar — are expressed through tags, attached at whichever level matches the user's intent (group, leaf category, or individual transaction). Tag attachment for categories is stored in `category_tag(category_id, tag_id)` with `ON DELETE CASCADE` on both foreign keys, so deleting a tag also drops its `category_tag` rows and deleting a category also drops its attachments. Reporting endpoints (`/summary/by-group`, `/summary/by-category`, `/summary/monthly-trend`, `/summary/monthly-by-group`) no longer accept the old `category_owner_ids` parameter; tag-aware filtering via `tag_ids` is the replacement.

Reporting should not assume every transaction inside an expense or income branch shares the same sign.

- expense categories may still contain credits such as reimbursements or returns

- income categories may still contain debits such as reversals, corrections, or offsets

- summaries and detail reports should include all matching transactions for the selected slice instead of filtering out the "unexpected" side

## Rules

Rules are keyword-based categorization rules.

They can include:

- merchant keyword

- amount conditions

- debit/credit direction scope

- owner scope

- account scope

- category assignment

- merchant rename (`clean\_name`)

- transaction-tag assignment

Important behavior:

- rule priority is automatic, not manually curated

- more specific rules beat more general ones

- amount comparisons use absolute values, with debit/credit scope applied separately through transaction sign when a rule is limited to one side

- owner-scoped rules beat global rules when otherwise similar

- at most one rule per *matcher* (keyword + owner + account + amount range + debit/credit). Saving a rule whose matcher already exists does not fork a second copy — `create_rule` classifies the collision and reconciles instead: a **duplicate** (adds nothing) is reported, not written; a **mergeable** save (adds a category/rename the existing rule lacks, or new tags) folds additively into the existing rule; a **conflict** (a category/rename that disagrees with the existing rule) is surfaced rather than silently resolved. A genuinely different matcher is not a collision and is created normally. A single manual save prompts the user on collision; the bulk Generate Rules flow auto-merges mergeable saves, skips duplicates, and surfaces conflicts in a summary. In the rule-suggestions UI that conflict summary names the colliding rule's category and resolves each in place without leaving the review: **Replace** overwrites the existing rule's action with the suggestion's — preserving the rule's id and tags — and accepts the suggestion against it, while **Keep** leaves the existing rule untouched and defers the suggestion; the conflict response carries the existing rule's category/rename so the summary can show both sides in one round trip. Because a merge or replace changes a rule that may already govern transactions (unlike accepting a brand-new rule), that summary then offers to re-categorize the rows the changed rule already matches, using a **preserve-manual** apply: it reclaims rows the rule should own — including import-locked ones — but leaves a deliberate manual per-transaction edit as the final say. Tags still union across *different* matching rules; only a same-matcher tag addition becomes a merge into the one rule.

- the same invariant is enforced when *editing* a rule (`update_rule`): if an edit makes a rule's matcher collide with a **different** existing rule, both rows already exist, so reconciling means one is removed — a mergeable/duplicate edit folds the edited rule's actions into the other rule and **deletes the edited rule**; a conflict is reported for the user to resolve (edit the other rule, delete one, or change scope). Both `create_rule` and `update_rule` take `on_existing` = `reject` (default: classify and report without writing) or `merge` (apply the reconciliation).

The goal is to make rule behavior explainable without requiring users to hand-maintain a priority table. Specificity and owner scope stand in for manual ordering because they usually match what a user means when two rules overlap. The one-rule-per-matcher invariant keeps that ordering meaningful: duplicate matchers would make "which rule wins" order-dependent, and editing one copy would leave the other firing.

Tags are separate from the category tree and are meant for cross-cutting labels such as `Essential Expenses`, `Alice`, `Reimbursable`, etc. A transaction's **effective tags** are the additive union of four sources, listed by precedence when reporting the source for a tag the transaction picked up through more than one path:

- **direct (txn_tag):** added on a transaction by a matching rule (`rule_present`) and/or a manual edit (`manual_state = 1`); manual `manual_state = -1` blocks a rule-applied direct tag for that one transaction without changing the rule

- **category-level (category_tag):** any tag attached to the transaction's leaf category propagates to every transaction in that category

- **group-level (category_tag):** any tag attached to the leaf category's parent group propagates to every transaction in any leaf under it

Inherited tags (category- or group-level) are not currently overridable on a single transaction; if a transaction needs to opt out, retag at the level the inheritance comes from. A future block-inherited mechanism (parallel to the existing `manual_state` for direct tags) can be added when an actual case calls for it.

Tag-aware filtering and aggregation matches a transaction if its effective tags include the requested tag, regardless of which source contributed it. Rules can still add tags directly:

- a rule may assign a category, rename the merchant, add tags, or do any combination of those actions

- category/rename still come from the first matching rule that provides that action, while direct tags are the union of all matching rules

## Import batches and profiles

CSV import creates supporting records for workflow and recovery:

- **Import profiles:** saved mapping/setup templates for recurring CSV formats

- **Import batches:** one record per import run so imported transactions can be undone

Imports use exact content hashing first for duplicate detection, then can fall back to narrower cross-source heuristics when an import explicitly links a new account to an existing account/group for duplicate comparison.

Important import-batch behavior:

- duplicate detection only blocks rows that match transactions already in FinTrack before the import starts

- exact duplicate protection remains the highest-confidence rule; heuristic matching only considers existing transactions in the same effective account scope with the same date and signed amount, then compares stored import evidence/source text to decide whether the row should be reviewed as a possible duplicate

- a separate **soft-duplicate** check runs after a batch finalizes: every imported row is compared against existing rows on *other* accounts by (date, amount, normalized payee), and matches are flagged (not blocked) via the `suspect_duplicate_of` columns with reason `cross_account`. The check is gated only by `account_pair_distinct` — pairs the user has previously asserted as distinct (via Keep on a soft-flag) are skipped, since the user has already declared the accounts to be different physical accounts. Same-batch sibling rows on different accounts are trusted as distinct (the CSV asserts via its account column that two rows on different accounts in one statement file are separate transactions, even if their date/amount/payee match); cross-batch matches are the candidates. There is no longer a "brand-new account" precondition: the check runs for every batch row, and `account_pair_distinct` is the mechanism that keeps the output non-noisy after the user has reviewed each pair. Account merges run `promote_in_group_suspects_to_confirmed` to graduate any pre-existing soft-flag whose two sides are now in the merged group, and `clear_account_pair_distinct_for_merge` to drop any prior distinct assertion between the now-merged accounts (the merge contradicts it)

- duplicate rows within the same CSV are allowed

- each imported raw account label also stores a trusted coverage window plus the source file's terminal date on `import_batch_account`; later imports auto-exclude rows that fall inside already-covered days, and on that shared terminal day they reconcile against the finite set of rows imported from earlier files on the same day so any remaining new rows import once the historical overlap has been consumed

- the coverage-window, terminal-day, and text-strategy medium-confidence rules only hard-dedupe against prior coverage when the receiving account itself appeared in that coverage (or was explicitly declared an alias of an existing account via `duplicate_compare_account_id` at import time); a brand-new sibling account inheriting only its linked-group's coverage does not satisfy the precondition and the row passes through to the soft-duplicate review instead, because the prior import provably did not contain transactions from this new account and "covered" cannot mean "covered for this account." Exact content-hash matches are unconditional — same date+amount+payee is high-confidence enough to drop regardless of which account the receiving row lands on

- saved data sources keep reusable import mapping defaults plus a default `use_imported_categories` flag for future files from that source; in the UI this is exposed as whether categories present in the data should be used by default

- saved data source names must be unique after trimming and case-folding so source pickers never show ambiguous duplicate labels

- saved data sources remember the last template filename/hash used while editing them, but loading a fresh template file remains an explicit user action

- each completed import batch stores whether that specific file used categories present in the data, along with any owner or unassigned-account filtering used for that scope

This separation exists because the reusable default and the actual decision for one file are not the same thing. A source may usually provide useful categories while a specific file from that source still needs to be treated differently, and undo/review flows need the exact per-batch choice, not just the profile default.

- imports that use categories present in the data can assign real `category_id` values to imported transactions, lock those assignments against *automatic* rule reruns (an explicit per-rule apply can still reclaim them — the preserve-manual variant used after a merge/replace does so while sparing manual edits), and treat those rows as learning input for future rule suggestions
- those imports promote missing imported category names into real leaf categories under the protected `Unassigned` group instead of keeping a pending review list
- imported labels that only mean "still uncategorized", such as `Uncategorized`, `Uncategorised`, or `Unassigned`, should not create real categories; those rows stay at `category_id = NULL` so the app has one canonical uncategorized state
- reporting and category-management surfaces may still split that one `NULL` state into synthetic expense-side and income-side buckets based on transaction sign, but those are presentation buckets rather than stored categories
- those imports treat any existing category or group name as already claimed, so they do not create a new imported leaf whose label duplicates another branch elsewhere in the tree

- imported categories created from a batch that used categories present in the data keep their source batch id only while that batch is their sole source, so undo can remove them when safe but repeated appearance in another such file makes them independent of the original import

- system-wide rule suggestions are generated from imported transactions that carry real categories — rows whose category came from the file (`category_source = 'import'`), plus manual rows that *reinforce* a category the file already evidenced for that merchant (e.g. rows the user reconciled onto it). A category seen only through manual edits — one the file never carried for that merchant — does not originate a suggestion, so a Preserved one-off neither spawns its own suggestion nor re-creates a conflict. Suggestions are not built from per-file proposal queues or raw imported category text alone

Using real categorized transactions rather than raw imported labels keeps rule suggestions aligned with the actual category tree the app is using. That avoids learning from labels that were never accepted, were ambiguous, or no longer map cleanly to the current category structure.

When the same merchant carries *different* imported categories across rows, those rows surface as a conflict group (the majority category is the reference; the rest are flagged). The suggestion's matching-transactions report lets the user reconcile them — per row or via a "set all to" bulk pick — and reconciling writes a manual lock (`setCategory`), which is the honest record (it's the user's decision now, and `'manual'` is what protects it from being reverted by a later re-import of the file's mapping). For display, though, the report treats `'manual'` and `'import'` rows the same: it lists the merchant's imported rows whatever their *current* source, so a reconciled row stays visible (with a manual-override badge) and can be re-edited, rather than vanishing. A manual row is never flagged as conflicting — it's a settled decision, not an open conflict. Picking a winner therefore collapses the conflict to a single-category suggestion that keeps its full row count: the reconciled rows reinforce the chosen category (a manual row reinforces a category the file already evidenced, but never originates a new one), so the surviving suggestion stays where the group was instead of shrinking and relocating. A legitimately distinct subset can instead be kept on its own category via Preserve — and because that category has no file-derived backing, it simply drops out rather than re-surfacing as a conflict.

Whether to record this reconcile as a manual override or as a *correction to the file's* `imported_category` is a genuine judgment call, and the current choice (manual override) is a default rather than a settled principle. It is favored here for edit-semantics consistency — a category change means the same thing on every screen, and the file label stays a historical (if regenerable) record — but the opposite is defensible: a screen whose whole purpose is resolving cross-row categorization conflicts could reasonably treat the edit as correcting the file's data, especially when every conflicting row comes from one file. The intended arbiter is **least surprise to the user** — which outcome a person would find least unexpected — and that test is not conclusively answered here; revisiting the choice is reasonable if real usage shows the manual-override behavior surprises people.

- batch summaries keep lightweight counts and small rejected-row samples
- when later account cleanup deletes imported transactions, batch summaries and per-account import breakdowns should shrink to match the transactions that still remain from that batch

- detailed duplicate-row review data is stored separately and loaded on demand so long-lived import history stays compact

- per-user or per-local-profile preferences may also carry a default mode for whether categories present in the data should be used for new imports (`all`, `none`, or `per_source`); this does not override saved data-source settings or per-batch choices, but it seeds the initial import workflow before a source-specific decision exists

## Backups

Backup/restore deals with two different classes of data:

- regular app data

- credentials/secrets such as Plaid-linked credentials

Those are intentionally separated so normal backups can stay safer and simpler.

## Schema evolution

The SQLite schema is versioned and migrated automatically on startup.

If the schema changes:

- add a migration in `backend/db/database.py`

- bump the current schema version

- keep migrations idempotent when practical

## Reporting assumptions

A few behavior rules matter across the whole app:

- income groups match money-in transactions

- expense groups match money-out transactions

- `exclude\_from\_totals` must be honored consistently across summaries and charts

- category grouping is only two levels deep

If any of these assumptions change, both backend queries and frontend UI logic will likely need coordinated updates.
