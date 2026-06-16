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

- `import\_evidence\_json` stores a compact subset of the original import row for cross-source duplicate detection and later explanation; this is intentionally narrower than a full raw-row archive (a full archive would roughly double per-transaction footprint for little gain). It keeps the source account/description labels plus up to `MAX_IMPORT_EVIDENCE_TEXT_FIELDS` additional columns whose headers match a curated keyword list of **descriptive free text** — memo/note/narrative/particulars/remittance/statement/reference/payee/counterparty/beneficiary/purpose and similar — the fields that help a user decode a cryptic transaction. Identifier/figure columns (check number, balance, transaction type, status, location) are deliberately excluded: they don't aid recognition and would add noise to the text duplicate-matcher that also consumes these fields. The transaction detail's Origin → "Show more" renders all captured fields

- **check-number enrichment** is the one exception that *derives* rather than stores: a paper-check row (`merchant\_name`/description reads as the whole word "check"/"cheque", not "CHECKCARD") whose file carries a separate check-number column gets that number folded into `merchant\_name`/`display\_name` as `"Check #<n>"` (only when not already present). It is applied to the merchant/display fields only — `raw\_name` (the literal source text) and `content\_hash` (dedupe) are left untouched — so a lone "Check" line becomes recognizable without storing the check-number column or perturbing duplicate detection

- pending transactions are visible in lists but usually excluded from summary totals

- `trashed_at != NULL` means the row is soft-deleted; every read path (the raw list, the summary endpoints, the dashboard, the import-card counts) filters it out, but the record stays in `txn` until the user empties the transaction trash from Settings, mirroring the account-trash pattern. The Settings → Trash view and the empty-trash operation are the one exception to "all trashed rows": both deliberately exclude confirmed-duplicate rows (`rejection_reason='duplicate_confirmed'` — see below), so the manual Trash only ever surfaces user-deleted transactions and emptying it cannot destroy a dedupe decision's restore path

- `suspect_duplicate_of`, `suspect_duplicate_reason`, and `suspect_resolved_at` together carry the soft-duplicate flag set by the post-import sweep when an imported row matches an existing row on a different account by (date, amount, normalized payee); the reason is `cross_account`. The sweep runs unconditionally for every batch row — there is no "brand-new account" precondition — and is gated only by the per-pair-distinct table `account_pair_distinct`. Flagged rows show a badge in lists and surface in a review report under Tasks until the user resolves each with one of three actions (labeled by outcome in the UI as Keep both / Discard new / Replace existing): **keep** (asserts the two accounts are distinct, cascade-clears every other flagged row between the same pair, records the pair in `account_pair_distinct`); **reject** (confirms the incoming row is a real duplicate — trashes the incoming row, keeps the existing one); or **replace** (the inverse survivor — the incoming row is the correct record, so it survives and the *existing* matched row is removed as the confirmed duplicate). `replace` is for fixing an account when one source mislabeled it (e.g. a legacy umbrella "Credit Card" account vs. the real card from a newer statement): the surviving incoming row's categorization follows each file's `use_imported_categories` choice — it keeps its own category only when the incoming file is the sole one with that flag set, otherwise it adopts the existing row's category (existing-only, and the both/neither tie) as a manual override, never copying a NULL category. Unlike keep, replace records no `account_pair_distinct` row (it asserts the two rows are the *same* transaction, not distinct accounts)

- `rejection_reason` discriminates *why* a `trashed_at` row was excluded from the active ledger: `NULL` means user-driven cleanup ("trash"), while `'duplicate_confirmed'` means a soft-flag suspect was accepted as a real duplicate — either by the user via the unified duplicate-detection report or automatically as a side effect of an account merge. Both states hide the row from active reads through the same `trashed_at` filter; the discriminator lets the unified report group confirmed soft-flags alongside the import-time hard-rejects in `import_batch_duplicate` while keeping user trash a separate concern. That separation is enforced, not just conceptual: the Settings → Trash list (`GET /transactions/trash`) and the empty-trash delete (`POST /transactions/trash/empty`) both filter on `rejection_reason <> 'duplicate_confirmed'`, so confirmed-duplicate rows never appear in the manual Trash and an empty-trash never deletes them. This is deliberate — those rows are not user-deleted items, they belong to the originating file's duplicate report, and keeping them undeletable from here preserves the restore paths (account detach for `auto_merge`, "undo reject" for `user` — see `dedupe_resolved_by`). The `suspect_duplicate_of` pointer is intentionally kept after a confirmed-duplicate rejection as an audit trail of which existing row was accepted as the canonical copy

- `dedupe_resolved_by` records the provenance of a `rejection_reason='duplicate_confirmed'` resolution: `'user'` means the user explicitly decided it in the dialog (a Reject on the row itself, or a Replace whose surviving row is the *other* one — in the Replace case it is the removed existing row that carries this marker), `'auto_merge'` means `promote_in_group_suspects_to_confirmed` flagged it as a side effect of an account merge, and `NULL` means either unresolved (active suspect) or legacy data from before the marker existed. This is what lets `detach_account` safely reverse merge-time auto-promotions without trampling deliberate user decisions: detach restores only `'auto_merge'` rows

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

- transactions are only ever assigned to **leaf** categories, never to groups. This is enforced at the API (the category-assignment endpoints reject a group id) and, just as importantly, in every place that turns a *name* back into a category — imports resolve a file label to a leaf (creating one under `Unassigned` if none matches, never adopting a same-named group) and seed rules look up leaves only. A group is a reporting rollup, not an assignable bucket.
- names are unique **within a kind** after trimming/case-folding: no two groups may share a name and no two leaves may share a name (so a given leaf belongs to exactly one branch). A leaf and a group **may** share a name, however — e.g. a `Miscellaneous` leaf alongside a `Miscellaneous` group. That is safe specifically because the two kinds are never interchangeable: the only context that resolves a bare name to an assignable category targets leaves, so the shared name can never make a transaction land on the group.

The underlying concern is ambiguity in *name → assignable category* resolution. FinTrack keeps category assignment, rule generation, and import review understandable and reversible by guaranteeing a label resolves to exactly one assignable leaf. Cross-kind name sharing does not reintroduce ambiguity because group and leaf are structurally distinct — a group cannot hold transactions — so the relaxation is limited to that one case while leaf↔leaf and group↔group uniqueness still hold. (Historically the rule was global uniqueness across all names; it was narrowed to per-kind once the resolvers were made leaf-aware.)

Groups also carry important reporting behavior:

- **`category\_type`:** typically `expense` or `income`

- **`exclude\_from\_totals`:** removes that group and all descendants from charts and totals

- category appearance is derived in the UI from stable ids/names rather than stored as user-managed color metadata

- the system also reserves a protected top-level **`Unassigned`** group for imported categories that are real, usable categories but have not yet been moved into a user-chosen reporting group; this group participates in filters/reporting but cannot be renamed or deleted
- when `Unassigned` has no child categories, category-management surfaces may hide it until imported categories populate it again

`Unassigned` exists to keep imported categories usable immediately without forcing the user to stop and redesign their reporting tree during import. Protecting the group keeps that temporary landing zone predictable for imports, undo, and later cleanup.

**Seeding model — what a fresh tenant starts with.** Creating a tenant database seeds only the **group skeleton**: the top-level reporting groups (with their `category_type` / `exclude_from_totals`) plus the protected `Unassigned` group. It seeds **no leaf categories and no rules**. The built-in starter *leaves* and *rules* are opt-in — added on demand through `POST /categories/generate-starter` (the onboarding "Add starter categories" / "Add starter rules" steps and the equivalent Categories- and Rules-page actions) and seeded directly by the demo dataset. That endpoint is idempotent (it upserts leaves by name and skips existing rule matchers), so the set can be grown later without duplicating anything.

The reason groups ship but leaves and rules do not: a user bringing their own categories should not have our taxonomy — and especially not our *data-mutating* rules — imposed on them, yet the import "Group Imported Categories" workspace still needs visible buckets to drop imported labels into, and the small, easily-deleted group skeleton supplies them. Because the built-in rules target leaves by name, withholding the leaves also withholds the rules, so a bring-your-own tenant has zero starter rules touching its data until it explicitly asks for them. (The leaf seed is kept consistent with its own legacy renames — e.g. the canonical medical leaf is `Medical Services`, never a `Medical` leaf that would collide with the `Medical` group — so re-running the opt-in seed is a no-op rather than a source of forked duplicates.)

Categories carry three flags: **`is_active`** (default 1), **`set_aside`** (default 0), and **`import_pending`** (default 0). They model distinct lifecycles that must not be conflated — this distinction is deliberate (see the import-reconciliation playbook):

- **`import_pending` = a pending imported label in the Group Imported Categories workspace.** The workspace is a *temporary landing spot* for labels that arrived via import and haven't been decided yet; it shows **only** active Unassigned leaves with `import_pending = 1`. The flag is set when import creates a new Unassigned leaf for a label, and it is **cleared the moment the category leaves the workspace** — by being organized into a real group, or deleted. It is **never re-set** (recover keeps it 0), and **user-created categories default to 0**, so neither a user-created category nor a deleted-then-recovered one ever appears in the workspace, even while sitting under `Unassigned`. (`GET /categories`/`/categories/flat` return the flag so the workspace can filter; a recovered or user-made Unassigned leaf is a permanent system category that shows on the Categories page but not the workspace.) Backfill on upgrade marks existing import-sourced Unassigned leaves as pending.
- **`set_aside` = parked but still live** (only meaningful while `import_pending = 1`). In the workspace a pending label can be "set aside" to clear it out of the "still needs sorting" pool without committing it to a group — it stays parked in the workspace's Set Aside list indefinitely. This is **not** a deletion: the category stays `is_active = 1`, keeps its transactions, and **future imports of that label still categorize to it**. Endpoints: `POST /categories/{id}/set-aside` and `POST /categories/{id}/restore-to-pool`. The workspace's Apply reconciles this flag from the parked list (and clears it for anything restored to the pool or organized into a group).
- **`is_active = 0` = deleted (soft, recoverable).** Delete — from the Categories page *or* the workspace's Delete action — is the *default* delete. For a **leaf category** it flips the row (and its descendant branch) to inactive rather than dropping it, so it stays recoverable; this is the only thing that suppresses a label from future imports. (An already-inactive row can be purged for good — see permanent delete below.) A **group** is treated differently — see "deleting a group" — because a group is an organizational container, not an import label. Semantics:
  - **deletion rewrites the branch's transactions, then hides the rows.** With no replacement the affected transactions become uncategorized (`category_id = NULL`, `category_overridden = 0`, `category_source = NULL`) while their `imported_category` text is preserved; with a replacement they are reassigned to that (active) category as a rule-style move. Either way an inactive category is left referentially empty — no live transaction points at it — so an active-only default read path is safe. Deletion also clears `import_pending` (the category has left the workspace) but **preserves `parent_id`**, which is what lets recovery return it to the group it came from. The undo-import path likewise only removes still-pending leaves it created, never a category that has been promoted into a real group or recovered.
  - **deleting a group removes the group row outright** rather than parking it in the Inactive list — there is nothing to recover (it's a container, not a label) and nothing to suppress from imports. Its child categories are deactivated like any leaf delete (recoverable, their transactions handled by the same replace/unassigned choice). Removing the group nulls those children's `parent_id` (`ON DELETE SET NULL`), so recovery falls back to `Unassigned`. **Only leaf categories ever appear in the Inactive list**; groups never do. (Databases predating this change may still hold inactive groups; permanent delete purges those as a branch.)
  - **rules targeting a deleted category are deleted.** A rule must point at an active category; on deactivate every `category_rule` row whose `category_id` is in the branch is dropped, and the categorizer additionally skips any rule whose target is inactive as defense in depth (tag-only rules, `category_id IS NULL`, still apply).
  - **inactive categories drop out of the active tree** (`GET /categories` and `/categories/flat` filter `is_active = 1`; both also return `set_aside` so the workspace can split pool vs. parked) and surface only in a separate flat recovery list (`GET /categories/inactive`), rendered as the "Inactive" section on the Categories page. Set-aside (active) categories never appear there.
  - **reactivation** (`POST /categories/{id}/reactivate`) sets `is_active = 1`, clears `set_aside`, leaves `import_pending = 0`, and restores the row to **the group it was deleted from** when that group still exists as an active top-level group, falling back to `Unassigned` otherwise. Because `import_pending` stays 0, a recovered category is a permanent system category that does **not** reappear in the import workspace (pool or set-aside). It does **not** retro-recategorize the transactions deletion previously cleared — only future assignments apply.
  - **imports respect inactive labels.** An imported label matching an inactive category imports the row uncategorized (label retained), creates no new leaf, and never resurrects the inactive one — see the import-batch section. (A per-label "redirect matching imports to a chosen category instead of unassigned" is a possible future feature; it would be expressed as an import-source + imported-category rule, since the same label can mean different things across sources.)
  - **permanent delete** (`DELETE /categories/{id}/forever`, the "Delete forever" action next to Recover in the Inactive list) drops the row (and its inactive branch) for good — the irreversible counterpart to reactivate. It only accepts an **inactive** category (an active one is rejected; it must be soft-deleted first), which is what keeps it safe: an inactive branch is already referentially empty, so the delete orphans nothing. `category_rule`/`category_tag` rows go via FK cascade (deleted explicitly too); `txn.imported_category` *text* is left intact. The one behavioral effect: with no inactive row left to match, the label is no longer suppressed, so a future import bearing it creates a fresh pending leaf instead of landing uncategorized.
  - **empty cleanup** (`GET /categories/empty-cleanup-preview`, `POST /categories/empty-cleanup`; the "Delete empty (N)" button beside the Categories search box, shown only when N > 0) is a one-pass sweep that removes clutter **outright** (not via Inactive). An *empty leaf* is active, non-system, not an import-workspace pending label, and referenced by **nothing the user configured** — no transaction (trashed or not) and no rule targets it (a rule target is configured-but-unused, so it's kept). An *empty group* is a non-system group left with no surviving children after that leaf removal (childless groups included); the Unassigned group is never touched. Implementation reuses the tested paths — each empty leaf is soft-deleted then purged (so import-snapshot refs are scrubbed and rules dropped), then each now-childless group is deleted. The set is recomputed server-side from the DB, never trusted from the client. A confirm dialog lists exactly what will go (empty ≠ unwanted — e.g. unused seeded defaults appear here), which is the review gate that replaces per-item recoverability for this bulk action.

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

- a rule must target an **active** category. Deleting a category deletes every rule pointing into the deactivated branch, and the categorizer skips any rule whose target category is inactive — so a stale rule can never re-categorize new rows into a deleted category. Tag-only rules (no category) are unaffected.

- the same invariant is enforced when *editing* a rule (`update_rule`): if an edit makes a rule's matcher collide with a **different** existing rule, both rows already exist, so reconciling means one is removed — a mergeable/duplicate edit folds the edited rule's actions into the other rule and **deletes the edited rule**; a conflict is reported for the user to resolve (edit the other rule, delete one, or change scope). Both `create_rule` and `update_rule` take `on_existing` = `reject` (default: classify and report without writing) or `merge` (apply the reconciliation).

The goal is to make rule behavior explainable without requiring users to hand-maintain a priority table. Specificity and owner scope stand in for manual ordering because they usually match what a user means when two rules overlap. The one-rule-per-matcher invariant keeps that ordering meaningful: duplicate matchers would make "which rule wins" order-dependent, and editing one copy would leave the other firing.

**How rules come into being.** Rules are rarely authored cold; three paths feed the same `category_rule` store. The primary one is *learning from a categorization*: when the user sets a transaction's category the UI offers to turn that action into a rule, and once saved the rule applies automatically to newly imported transactions (rule application can be disabled globally, and a *run categorization* pass can be triggered on demand). The bulk **Generate rules from imported data** path derives candidate rules from transactions that arrived already categorized in a curated import (the "categories present in the data" flag) and presents them for review — the data-driven path for users migrating curated data. The opt-in **starter rules** add a fixed, curated catalog for users with no data to learn from. The distinction that matters: rules mutate transaction data, so neither bulk path applies blindly — Generate rules is reviewed per suggestion, and the starter rules are presented as an approve-before-add list (the user sees every `keyword → category` before any is created). All three converge on the same one-matcher reconciliation described above; inert categories have no such gate, which is why a starter *category* can be added in one click while starter *rules* go through the list.

Tags are separate from the category tree and are meant for cross-cutting labels such as `Essential Expenses`, `Alice`, `Reimbursable`, etc. A transaction's **effective tags** are the additive union of these sources, listed by precedence (most specific first) when reporting the source for a tag the transaction picked up through more than one path:

- **direct (txn_tag):** added on a transaction by a matching rule (`rule_present`) and/or a manual edit (`manual_state = 1`); manual `manual_state = -1` blocks a rule-applied direct tag for that one transaction without changing the rule

- **category-level (category_tag):** any tag attached to the transaction's leaf category propagates to every transaction in that category

- **group-level (category_tag):** any tag attached to the leaf category's parent group propagates to every transaction in any leaf under it

- **account-level (account_tag):** any tag attached to the transaction's **effective (top-level) account** propagates to every transaction in that account. The effective account is `COALESCE(parent_account_id, account_id)`, so a top-level account's tags reach its own *and its child accounts'* transactions, while a child account's own tags stay **dormant** while it is merged (resolution never consults the child's row) and reactivate automatically when it is detached. Merging a tagged account under a parent therefore quietly sets its tags aside rather than deleting or promoting them — the parent's tags govern, and the child's return on detach. Account is the broadest scope, so it is the most general (lowest-precedence) source

Inherited tags (account-, category-, or group-level) are not currently overridable on a single transaction; if a transaction needs to opt out, retag at the level the inheritance comes from. A future block-inherited mechanism (parallel to the existing `manual_state` for direct tags) can be added when an actual case calls for it.

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

- exact duplicate protection remains the highest-confidence rule; heuristic matching only considers existing transactions in the same effective account scope with the same date and signed amount, then compares stored import evidence/source text to decide whether the row should be reviewed as a possible duplicate. Confidence decides which signal is trusted enough to **hard-reject** (vs. soft-flag for review); it does **not** decide the report *label* when several hard-reject rules overlap. There the broadest reason wins: a row that both exactly matches an existing transaction and falls inside an already-covered date range is reported as a covered-range duplicate, not an exact match — so a re-imported range reads as one uniform reason instead of a scattered "exact match" subset (which rows happen to share an identical content hash is an incidental artifact of merchant-string formatting). The verdict is identical either way; only the displayed reason differs. See the ladder/ordering in `backend/services/duplicate_detection.py`

- a separate **soft-duplicate** check runs after a batch finalizes: every imported row is compared against existing rows on *other* accounts by (date, amount, normalized payee), and matches are flagged (not blocked) via the `suspect_duplicate_of` columns with reason `cross_account`. The check is gated only by `account_pair_distinct` — pairs the user has previously asserted as distinct (via Keep on a soft-flag) are skipped, since the user has already declared the accounts to be different physical accounts. Same-batch sibling rows on different accounts are trusted as distinct (the CSV asserts via its account column that two rows on different accounts in one statement file are separate transactions, even if their date/amount/payee match); cross-batch matches are the candidates. There is no longer a "brand-new account" precondition: the check runs for every batch row, and `account_pair_distinct` is the mechanism that keeps the output non-noisy after the user has reviewed each pair. Account merges run `promote_in_group_suspects_to_confirmed` to graduate any pre-existing soft-flag whose two sides are now in the merged group, and `clear_account_pair_distinct_for_merge` to drop any prior distinct assertion between the now-merged accounts (the merge contradicts it). The same `promote_in_group_suspects_to_confirmed` also runs at import finalize (right after the sweep, scoped to the accounts the batch touched), so a batch importing into an account already merged with the matched account auto-confirms those in-group duplicates instead of leaving them for review — making import order and merge order interchangeable

- duplicate rows within the same CSV are allowed

- each imported raw account label also stores a trusted coverage window plus the source file's terminal date on `import_batch_account`; later imports auto-exclude rows that fall inside already-covered days, and on that shared terminal day they reconcile against the finite set of rows imported from earlier files on the same day so any remaining new rows import once the historical overlap has been consumed

- the coverage-window, terminal-day, and text-strategy medium-confidence rules only hard-dedupe against prior coverage when the receiving account itself appeared in that coverage (or was explicitly declared an alias of an existing account via `duplicate_compare_account_id` at import time); a brand-new sibling account inheriting only its linked-group's coverage does not satisfy the precondition and the row passes through to the soft-duplicate review instead, because the prior import provably did not contain transactions from this new account and "covered" cannot mean "covered for this account." Exact content-hash matches are unconditional — same date+amount+payee is high-confidence enough to drop regardless of which account the receiving row lands on

- saved data sources keep reusable import mapping defaults plus a default `use_imported_categories` flag for future files from that source; in the UI this is exposed as whether categories present in the data should be used by default

- saved data source names must be unique after trimming and case-folding so source pickers never show ambiguous duplicate labels

- saved data sources remember the last template filename/hash used while editing them, but loading a fresh template file remains an explicit user action

- each completed import batch stores whether that specific file used categories present in the data, along with any owner or unassigned-account filtering used for that scope

This separation exists because the reusable default and the actual decision for one file are not the same thing. A source may usually provide useful categories while a specific file from that source still needs to be treated differently, and undo/review flows need the exact per-batch choice, not just the profile default.

- imports that use categories present in the data can assign real `category_id` values to imported transactions, lock those assignments against *automatic* rule reruns (an explicit per-rule apply can still reclaim them — the preserve-manual variant, used after a merge/replace and when accepting an import-rule suggestion, does so while sparing manual edits), and treat those rows as learning input for future rule suggestions. Accepting a suggestion auto-applies the rule's outputs (category / rename / tags) to *only* the rows that generated it (`POST /rules/{id}/apply-to-transactions` with that suggestion's `source_row_ids`), so conflicting rows owned by other suggestions and Preserved manual exceptions are left alone rather than reassigned
- those imports promote missing imported category names into real leaf categories under the protected `Unassigned` group instead of keeping a pending review list
- imported labels that only mean "still uncategorized", such as `Uncategorized`, `Uncategorised`, or `Unassigned`, should not create real categories; those rows stay at `category_id = NULL` so the app has one canonical uncategorized state
- reporting and category-management surfaces may still split that one `NULL` state into synthetic expense-side and income-side buckets based on transaction sign, but those are presentation buckets rather than stored categories
- those imports match an imported label against existing **leaf** categories only: a label that matches an existing leaf reuses it, otherwise a new leaf is created under `Unassigned`. A top-level group that happens to share the label is *not* treated as a match (it is not assignable), so an imported `Miscellaneous` becomes a `Miscellaneous` leaf rather than being folded into a `Miscellaneous` group
- a label matching an **inactive (deleted)** leaf is suppressed: the row imports uncategorized (`category_id`/`category_source` left NULL, `imported_category` retained), no new leaf is created, and the inactive leaf is *not* resurrected. This is what makes a deletion durable across re-imports — a deleted label keeps landing uncategorized instead of repopulating the organize pool. The match is name-based, so reactivating the leaf (which restores it under `Unassigned`) lets future imports of that label adopt it again. A **set-aside** (still-active) label is *not* suppressed — imports keep categorizing to it, because set-aside only parks the category, it does not remove it

- **categorization precedence at import is `mapping → rule → imported label → uncategorized`, and it is deliberate.** The user's own rules run *before* the file's category: when a rule categorizes a row it is stored under the rule's category and the file label is **not** promoted into a category for that row (it would be an empty, unused category). An explicit per-label mapping from the review screen outranks rules; the imported label is adopted (and lazily created) only for rows nothing above claimed, and only when the source/batch is flagged to use imported categories. Tag-only rules still apply their tags while leaving the category open for the label fallback. The raw label is always kept on the row as `imported_category` text regardless of which category wins, so it survives for audit (surfaced in the transaction detail's Origin → "Show more"). The same precedence governs the post-import per-batch "use imported categories" toggle, so enabling it later fills only rows no mapping or rule has claimed — it never overrides a rule.

  **Why this order — the intent behind the "use imported categories" flag.** The flag is a *bootstrapping* aid, not an authority claim (its UI label "use/trust the categories present in the data" reads stronger than its real job). Early on FinTrack has no categories or rules, so a source's own categories seed the user's taxonomy and give the rule-suggester something to learn from. As the user groups/cleans categories and builds rules *inside FinTrack*, FinTrack becomes the source of truth and the external source decays into a mere aggregator — a pipe, not a categorizer. So the file label is only ever a gap-filler for rows the user has not yet taught FinTrack to categorize, and the flag **self-attenuates**: as rules grow, more rows are claimed by rules before the label fallback is reached, so the source's categories quietly stop mattering without the user ever turning the flag off. That is why a rule must win over the file label, and why we never mint a category nothing is stored under.

- imported categories created from a batch that used categories present in the data keep their source batch id only while that batch is their sole source, so undo can remove them when safe but repeated appearance in another such file makes them independent of the original import

- system-wide rule suggestions are generated from imported transactions that carry real categories — rows whose category came from the file (`category_source = 'import'`), plus manual rows that *reinforce* a category the file already evidenced for that merchant (e.g. rows the user reconciled onto it). A category seen only through manual edits — one the file never carried for that merchant — does not originate a suggestion, so a Preserved one-off neither spawns its own suggestion nor re-creates a conflict. Suggestions are not built from per-file proposal queues or raw imported category text alone

Using real categorized transactions rather than raw imported labels keeps rule suggestions aligned with the actual category tree the app is using. That avoids learning from labels that were never accepted, were ambiguous, or no longer map cleanly to the current category structure.

When the same merchant carries *different* imported categories across rows, those rows surface as a conflict group (the majority category is the reference; the rest are flagged). The suggestion's matching-transactions report lets the user act on them two distinct ways, and the distinction is deliberate:

- **Recategorize** — the per-row category picker, the "set all to" bulk pick, and the per-row "Use majority" button — records a *corrected file categorization* (`setImportedCategory`, `PATCH /transactions/{id}/imported-category`): it keeps `category_source = 'import'` and rewrites `imported_category` to the chosen category's name. Because the row stays import-derived it keeps driving the suggestions, so recategorizing re-targets / collapses the conflict rather than removing rows from the learning set; and because the recorded file label is rewritten, toggling the batch's "trust these categories" flag (which re-derives `'import'` rows from their stored label) can't revert it. Undoing the import and re-importing the file still starts fresh.
- **Preserve This Categorization** records a manual exception (`setCategory`, `'manual'`): the rules never change that row and it drops out of the suggestions entirely — a deliberate one-off, not part of any rule.

For display the report treats `'manual'` and `'import'` rows the same: it lists the merchant's imported rows whatever their *current* source, so a Preserved row stays visible (with a manual-override badge) and can be re-edited, rather than vanishing. A manual row is never flagged as conflicting — it's a settled decision, not an open conflict. Recategorizing the minority onto the winner therefore collapses the conflict to a single-category suggestion that keeps its full row count, instead of shrinking and relocating. A legitimately distinct subset can instead be kept on its own category via Preserve — and because that category then has no file-derived backing, it simply drops out rather than re-surfacing as a conflict.

This splits a judgment call that was previously open: a category edit on the conflict-resolution screen is treated as *correcting the file's data* (it keeps `import` and rewrites the label), while Preserve is the way to say "this one is a manual exception." The reasoning is least surprise — on a screen whose whole purpose is resolving cross-row categorization conflicts, the common gesture (fixing a mislabeled row so the merchant's rule is right) should feed the rule and survive a trust-flag re-toggle, and only the explicit "preserve" gesture should carve out an untouchable exception. Note this makes the conflict-resolution screen an intentional exception to the general "an imported-category edit elsewhere becomes a manual override" default.

- batch summaries keep lightweight counts and small rejected-row samples
- when later account cleanup deletes imported transactions, batch summaries and per-account import breakdowns should shrink to match the transactions that still remain from that batch

- detailed duplicate-row review data is stored separately and loaded on demand so long-lived import history stays compact

- per-user or per-local-profile preferences may also carry a default mode for whether categories present in the data should be used for new imports (`all`, `none`, or `per_source`); this does not override saved data-source settings or per-batch choices, but it seeds the initial import workflow before a source-specific decision exists

## Backups

Backup/restore deals with two different classes of data:

- regular app data

- credentials/secrets such as Plaid-linked credentials

Those are intentionally separated so normal backups can stay safer and simpler.

The regular backup (payload **version 7**) covers the full **data-DB** state so a restore reproduces the working app, not just the ledger: owners, accounts, categories/groups, rules, merchant renames, import profiles/batches/history, transactions, the entire **tag system** (`tag` plus every attachment — `txn_tag`, `category_tag`, `account_tag`, `rule_tag`), the `account_pair_distinct` assertions, and **UI/layout preferences** (`ui_preference` — see below). Restore is destructive — it wipes and rebuilds in foreign-key-safe order (tag definitions before any attachment; attachments after their other parent), and drops any attachment whose endpoints didn't survive the restore. Older payload versions are no longer accepted.

The payload is also **stamped** with the source data DB's `instance_id` (from `db_meta`) and its `access_mode` (`local`/`auth`). Restore uses this as a **compatibility guard** so it can't silently replace the wrong system: it proceeds freely when the target is empty (no accounts/transactions — a fresh install) or when restoring this system's *own* backup (matching `instance_id`) in the same mode, but returns `409 {code: "restore_incompatible", reasons: […]}` when the target already has data and the backup came from a *different* `instance_id`, or when the access modes differ. The UI turns that 409 into an explicit "restore over a different system?" confirmation and retries with a `force` flag; `force` is the only way past the guard, so an accidental cross-system or cross-mode wipe always requires a deliberate second confirmation.

### Preferences

Non-sensitive **UI/layout preferences** — page layouts, collapse state, dashboard view, **dashboard tag reports**, import drafts, etc. — live in the **data DB** in `ui_preference(scope_id, pref_key, pref_value)`. `scope_id` is the authenticated user id (auth mode) or the local-preference-profile id (local mode). They live here, with the data they describe (tag reports reference tag ids, for instance), rather than in the control DB — so a data backup carries them and there is no cross-DB/scope plumbing. The **control DB keeps only identity/secrets** (users, auth secrets, recovery codes) and the local-preference-profile *definitions*; profile names stay control-side, the preference *values* are data-side.

The `/preferences` API (`auth.py`) is the single façade and is unchanged for callers; it now resolves the scope id and reads/writes `ui_preference`. Preferences originally lived in the control DB (`user_preference` / `local_preference_value`); those rows relocate **lazily on first read** per scope (see `services/preferences.py::relocate_legacy_preferences`) and the control-side copy is cleared. That bridge — and the now-unused control-DB pref tables — can be removed once all active scopes have migrated.

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
