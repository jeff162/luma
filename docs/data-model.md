# Data Model

This is the working model Luma is built around.

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

- **`type`** classifies the account (`depository`/`credit`/`savings`/`loan`/`investment`/`p2p`/`other`, plus the marketplace `amazon` and the wallet `paypal`). It is user-editable on the Accounts page and, beyond display, is what the **account-type rule scope** matches against (see Rules). A recognized **PayPal** import auto-assigns `type='paypal'` to a **newly-created** target account (only — an existing account keeps its type on import); approving that source's money-movement `Type`s additionally types the source's accounts `paypal` when still generic (`depository`/`other`/`p2p`), since the money-movement rules are account-type scoped and need the account typed to match. A deliberately-set non-generic type is never overwritten. `amazon` carries a `kind: 'marketplace'` UI convention (hidden from the generic importer); `paypal` does not (PayPal uses the generic CSV importer)

- `display_name` is the effective label used outside the Accounts page; standalone accounts keep it aligned to `name`, while merged child accounts inherit the parent's display name

- `parent_account_id = NULL` means the row is a top-level selectable account; child accounts keep historical account numbers visible on the Accounts page but resolve through the parent for account filtering, import/export display, and other account-facing surfaces

- regrouping one merged parent onto another top-level account flattens the dragged group's visible members so they all become direct children of the new parent; the old parent remains as one of those children rather than preserving a deeper tree

- `trashed_at != NULL` means the child account is hidden but still recoverable; emptying the trash is the irreversible step that folds remaining references into the parent and deletes the child row

- the sparse table `account_pair_distinct` records the user's explicit "these two accounts are different physical accounts" assertions, written automatically when the user clicks Keep on a cross-account soft-flag suspect. Rows are stored canonically with `account_id_low < account_id_high` so each pair has exactly one row. The dedupe sweep consults this table to skip pairs the user has already reviewed, and the management UI on the SuspectDuplicates page can forget an assertion to re-enable detection. Merging two accounts deletes any row between them (the merge contradicts the distinct assertion)
- its charge-level sibling `amazon_charge_distinct` (canonical `txn_id_low < txn_id_high`) records "these two charges are distinct purchases" assertions from the Amazon reconciliation report's **Not duplicates** action, offered on every duplicate-flavored row. The report consults it everywhere it claims "duplicate": the unaccounted grouping refuses to chain an asserted pair, and the order-anchored `duplicate`/`duplicate_review` buckets are skipped when *every* pair in the group is asserted (partial marking still flags — the ambiguity is unresolved). An order-anchored assertion removes only the duplicate claim: the order falls back to the unmatched path, where the split-suggestion pass prefers a candidate dated on the order itself (surfaced as Matched·review with a reason note) and otherwise leaves it at No charge found for manual linking. The verdict sticks across refreshes; a re-import that adds a new copy forms new unasserted pairs and correctly re-flags

## Transactions

Transactions are the central fact table.

Important conventions:

- `amount \> 0` means money out

- `amount \< 0` means money in

- `category\_overridden = 1` means rule reruns must leave the current category alone

- `category\_source` records whether the current category came from a manual edit, an import that used categories present in the data, a rule, or an **enrichment** — a feature (Amazon order import, wallet funding-leg suppression) moving the row into an excluded category as part of a link it can reverse

- `display\_name\_source` is the same idea for the *name*: `manual` (a deliberate rename), `rule` (a rule's `clean_name` owns it), `import` (the imported/synced name), or `enrichment` (an enrich-on-import fold from a richer source filled it); NULL means unknown/legacy and is treated as non-manual (enrichable). It exists so a name can be attributed and, crucially, so a `manual` rename is protected: automatic name-setting must never overwrite `manual`. The rename writers stamp it (manual single/bulk `set_merchant` → `manual`; the rule-apply derivation `rule_scalar_effects` → `rule` only when a rule actually authored the name; import/sync inserts → `import`/`rule`). It mirrors `category_source`'s protection contract — `recategorize_all` (the automatic pass) leaves a `manual` name alone while still recategorizing the row, and only the explicit full-force rule apply may overwrite a manual name. Because `txn` stores no per-row rule_id, the migration backfill re-derives provenance: a currently-matching rule whose `clean_name` equals `display_name` → `rule`; else a name differing from both `merchant_name` and `raw_name` → `manual`; else `import`

- `import\_evidence\_json` stores a compact subset of the original import row for cross-source duplicate detection and later explanation; this is intentionally narrower than a full raw-row archive (a full archive would roughly double per-transaction footprint for little gain). It keeps the source account/description labels plus up to `MAX_IMPORT_EVIDENCE_TEXT_FIELDS` additional columns whose headers match a curated keyword list of **descriptive free text** — memo/note/narrative/particulars/remittance/statement/reference/payee/counterparty/beneficiary/purpose and similar — the fields that help a user decode a cryptic transaction. Identifier/figure columns (check number, balance, transaction type, status, location) are deliberately excluded: they don't aid recognition and would add noise to the text duplicate-matcher that also consumes these fields. The transaction detail's Origin → "Show more" renders all captured fields

- **check-number enrichment** is the one exception that *derives* rather than stores: a paper-check row (`merchant\_name`/description reads as the whole word "check"/"cheque", not "CHECKCARD") whose file carries a separate check-number column gets that number folded into `merchant\_name`/`display\_name` as `"Check #<n>"` (only when not already present). It is applied to the merchant/display fields only — `raw\_name` (the literal source text) and `content\_hash` (dedupe) are left untouched — so a lone "Check" line becomes recognizable without storing the check-number column or perturbing duplicate detection

- `needs_review = 1` flags a freshly imported or synced row the user hasn't looked over yet — a per-transaction convenience for reviewing newly arrived transactions, surfaced as a subtle amber `R` marker in the row strip plus a "Needs review" filter/toggle on the Transactions page. It is **set on every import/sync insert** (the CSV `_insert_imported_transaction` path and the Plaid sync insert); existing and hand-created rows default to `0` and stay out of the review pool. It is **its own axis, independent of categorization** — a rule-categorized row can still need review, and a reviewed row can be deliberately uncategorized. It clears two ways: a **manual category edit** (`override_category`, bulk `set_category`, the rejected-suggestion manual re-point — the same actions that write `category_source = 'manual'`) clears it implicitly, and an explicit **mark reviewed** (the `mark_reviewed` bulk action / row-menu action, or the per-batch sweep) clears it for "looked, it's fine as-is." Automatic categorization (rule, import, the conflict-screen `imported-category` recategorize, `cleared`) deliberately does **not** clear it. This is deliberately a column, not a tag: review is workflow lifecycle, not a reporting label, mirroring `suspect_duplicate_*` and the advisory-reject `reviewed_at`. Historical-backfill floods are handled by bulk mark-reviewed (select-all-matching) and a per-CSV-batch "Mark all reviewed" (`POST /import-export/batches/{id}/mark-reviewed`), which is why there is no import-time default-review choice yet. Data-source syncs have no per-set record to offer the equivalent per-file sweep — giving them CSV-batch parity (per-fetch records) is deferred
- pending transactions are visible in lists but usually excluded from summary totals

- `trashed_at != NULL` means the row is soft-deleted; every read path (the raw list, the summary endpoints, the dashboard, the import-card counts) filters it out, but the record stays in `txn` until the user empties the transaction trash from Settings, mirroring the account-trash pattern. The Settings → Trash view and the empty-trash operation are the one exception to "all trashed rows": both deliberately exclude confirmed-duplicate rows (`rejection_reason='duplicate_confirmed'` — see below), so the manual Trash only ever surfaces user-deleted transactions and emptying it cannot destroy a dedupe decision's restore path

- `suspect_duplicate_of`, `suspect_duplicate_reason`, and `suspect_resolved_at` together carry the soft-duplicate flag set by the post-import sweep when an imported row matches an existing row on a different account by (date, amount, normalized payee); the reason is `cross_account`. The sweep runs unconditionally for every batch row — there is no "brand-new account" precondition — and is gated only by the per-pair-distinct table `account_pair_distinct`. Flagged rows show a badge in lists and surface in a review report under Tasks until the user resolves each with one of three actions (labeled by outcome in the UI as Keep both / Discard new / Replace existing): **keep** (asserts the two accounts are distinct, cascade-clears every other flagged row between the same pair, records the pair in `account_pair_distinct`); **reject** (confirms the incoming row is a real duplicate — trashes the incoming row, keeps the existing one); or **replace** (the inverse survivor — the incoming row is the correct record, so it survives and the *existing* matched row is removed as the confirmed duplicate). `replace` is for fixing an account when one source mislabeled it (e.g. a legacy umbrella "Credit Card" account vs. the real card from a newer statement): the surviving incoming row's categorization follows each file's `use_imported_categories` choice — it keeps its own category only when the incoming file is the sole one with that flag set, otherwise it adopts the existing row's category (existing-only, and the both/neither tie) as a manual override, never copying a NULL category. Unlike keep, replace records no `account_pair_distinct` row (it asserts the two rows are the *same* transaction, not distinct accounts)

- `rejection_reason` discriminates *why* a `trashed_at` row was excluded from the active ledger: `NULL` means user-driven cleanup ("trash"), while `'duplicate_confirmed'` means a soft-flag suspect was accepted as a real duplicate — either by the user via the unified duplicate-detection report or automatically as a side effect of an account merge. Both states hide the row from active reads through the same `trashed_at` filter; the discriminator lets the unified report group confirmed soft-flags alongside the import-time hard-rejects in `import_batch_duplicate` while keeping user trash a separate concern. That separation is enforced, not just conceptual: the Settings → Trash list (`GET /transactions/trash`) and the empty-trash delete (`POST /transactions/trash/empty`) both exclude confirmed-duplicate rows **except the Amazon reconciliation's (`dedupe_resolved_by` in `'amazon_merge'`/`'amazon_discard'`)**, so the unified dedupe flow's rows never appear in the manual Trash and an empty-trash never deletes them. This is deliberate — those rows are not user-deleted items, they belong to the originating file's duplicate report, and keeping them undeletable from here preserves the restore paths (account detach for `auto_merge`, "undo reject" for `user` — see `dedupe_resolved_by`). Amazon-reconciliation removals are the exception: the user removed those copies deliberately, so they stay visible on the Trash page — in their own **Duplicate transactions** section, grouped by the source file each copy came from (direct deletes stay a flat list in the Transactions section, where the import source isn't meaningful) — restore from there (`POST /transactions/{id}/restore` clears the dedupe tags along with the untrash, and the reconciliation grouping simply re-derives — a mistaken merge or discard is fully undoable), and empty with their section (`POST /transactions/trash/empty?scope=deleted|duplicates|all` scopes each section's Empty button to its own rows). The `suspect_duplicate_of` pointer is intentionally kept after a confirmed-duplicate rejection as an audit trail of which existing row was accepted as the canonical copy

- `dedupe_resolved_by` records the provenance of a `rejection_reason='duplicate_confirmed'` resolution: `'user'` means the user explicitly decided it in the dialog (a Reject on the row itself, or a Replace whose surviving row is the *other* one — in the Replace case it is the removed existing row that carries this marker), `'auto_merge'` means `promote_in_group_suspects_to_confirmed` flagged it as a side effect of an account merge, `'amazon_merge'` means an Amazon reconciliation **Merge → keep one** trashed this copy (its `suspect_duplicate_of` points at the kept survivor), `'amazon_discard'` means a per-copy **Discard** on the reconciliation report — a dedupe resolution removing one redundant copy (no kept-copy pointer, since a discard doesn't always know one); the row-level **Trash** on an unaccounted charge is deliberately *not* tagged, because it means "this shouldn't be in my ledger at all" rather than "this is a redundant copy", and so files as an ordinary delete; both Amazon values, unlike `user`/`auto_merge`, stay visible in the manual Trash — see `rejection_reason` above. `NULL` means either unresolved (active suspect) or legacy data from before the marker existed. This is what lets `detach_account` safely reverse merge-time auto-promotions without trampling deliberate user decisions: detach restores only `'auto_merge'` rows

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

The underlying concern is ambiguity in *name → assignable category* resolution. Luma keeps category assignment, rule generation, and import review understandable and reversible by guaranteeing a label resolves to exactly one assignable leaf. Cross-kind name sharing does not reintroduce ambiguity because group and leaf are structurally distinct — a group cannot hold transactions — so the relaxation is limited to that one case while leaf↔leaf and group↔group uniqueness still hold. (Historically the rule was global uniqueness across all names; it was narrowed to per-kind once the resolvers were made leaf-aware.)

Groups also carry important reporting behavior:

- **`category\_type`:** typically `expense` or `income`

- **`exclude\_from\_totals`:** removes that group and all descendants from charts and totals

- category appearance is derived in the UI from stable ids/names rather than stored as user-managed color metadata

- the system also reserves a protected top-level **`Unassigned`** group for imported categories that are real, usable categories but have not yet been moved into a user-chosen reporting group; this group participates in filters/reporting but cannot be renamed or deleted
- when `Unassigned` has no child categories, category-management surfaces may hide it until imported categories populate it again

`Unassigned` exists to keep imported categories usable immediately without forcing the user to stop and redesign their reporting tree during import. Protecting the group keeps that temporary landing zone predictable for imports, undo, and later cleanup.

**Seeding model — what a fresh tenant starts with.** Creating a tenant database seeds only the **group skeleton**: the top-level reporting groups (with their `category_type` / `exclude_from_totals`) plus the protected `Unassigned` group. It seeds **no leaf categories and no rules**. The built-in starter *leaves* and *rules* are opt-in — added on demand through `POST /categories/generate-starter` (the onboarding "Add starter categories" / "Add starter rules" steps and the equivalent Categories- and Rules-page actions) and seeded directly by the demo dataset. That endpoint is idempotent (it updates/inserts leaves by name and skips existing rule matchers), so the set can be grown later without duplicating anything.

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

Categories and groups themselves do **not** have an `owner_id`; the schema does not define that column. The dimensions a user wants to report by — personal/shared, essential/discretionary, business/personal, and similar — are expressed through tags, attached at whichever level matches the user's intent (group, leaf category, or individual transaction). Tag attachment for categories is stored in `category_tag(category_id, tag_id)` with `ON DELETE CASCADE` on both foreign keys, so deleting a tag also drops its `category_tag` rows and deleting a category also drops its attachments. Reporting endpoints (`/summary/by-group`, `/summary/by-category`, `/summary/monthly-trend`, `/summary/monthly-by-group`) no longer accept the old `category_owner_ids` parameter; tag-aware filtering via `tag_ids` is the replacement.

Reporting should not assume every transaction inside an expense or income branch shares the same sign.

- expense categories may still contain credits such as reimbursements or returns

- income categories may still contain debits such as reversals, corrections, or offsets

- summaries and detail reports should include all matching transactions for the selected slice instead of filtering out the "unexpected" side

- **Totals and breakdowns must be aggregated server-side, never by summing a capped transaction fetch on the client.** The `/transactions` list is paginated (a `limit`), so any client that fetches it and then sums/counts to show a total will silently undercount once the result set exceeds the cap. The dashboard's group and category pies go through `/summary/by-*`; the **tag report** does too (`/summary/by-tag-signature`, which buckets by tag *signature* — the set of the report's selected tags a row effectively carries — with the same signed-net aggregation (see "One aggregation sign" below) and spending/income scope as `by-category`, so all three "Spending by" modes reconcile to one total). The ways a total legitimately reaches a client:
  - the **`/summary/*`** endpoints (a pre-aggregated total/count per bucket) — the pies, and the tag-report slice rows (each carries its bucket `total`/`count`, which `TagDetail`'s header shows verbatim);
  - **`range.total`/`range.count`** from the monthly-trend aggregation via `computeDetailRange` — `CategoryDetail` and `AccountDetail` window totals;
  - the list response's **`total` (count) and `sum_amount` (signed net over the whole filtered set)** — for a panel that shows a header total beside a paged list, e.g. `PeriodDetail` (whose list infinite-scrolls via `usePagedTransactions`). `sum_amount` exists precisely so the header need not sum the loaded rows.

  A new surface that needs a total uses one of these, never a client `reduce` over the fetched rows.

  **One aggregation sign, everywhere: signed net (no `ABS`).** Every reporting bucket — the pies (`by-category`, `by-group`, `by-category-in-group`, `by-tag-signature`) and the time-series charts (`monthly-trend`, `monthly-by-group`) — carries the **signed net** per bucket, following the sign convention in `transactions.py` (see `_summary_signed_total_sql` and the `monthly_trend` "Sign convention" note): income-type buckets negate so received income reads positive, while reverses — refunds in an expense bucket, returns in an income bucket — stay **negative**. So a period where a category's refunds outweigh its spend reads as a negative total, and it *reduces* the period total instead of inflating it. This is deliberate: `ABS(SUM(amount))` was removed because it hid a refund by flipping its sign (a net-refunded bucket showed as positive "spending"), which made the Trends "Total per month" bar and the pies disagree with the single-period trend. Note this has always been **net-within-bucket** (`ABS(SUM)`, not `SUM(ABS)`) — refunds inside a bucket already netted; the only case the sign change affects is a *whole* bucket that nets negative. Charts that can't draw a negative magnitude floor the **geometry** at zero client-side — the Trends stacked by-group area chart (`Math.max(net, 0)` per band) and the dashboard pie wedges (`pieValue`) — but every displayed **number** (list rows, header totals, tooltips, the "Total per month"/annual/averages bars) keeps the true signed net; the tooltip shows the signed figure even where the drawn band/wedge is clamped. Do **not** reintroduce `ABS` on any bucket total: a net refund legitimately reduces a period's spending, and all "Spending by" modes plus the trend charts are meant to agree on that net figure.

  **The list `limit` contract.** `/transactions` defaults to a **200-row page** (max `1000`); a scoped list that can exceed that must paginate (`usePagedTransactions`) rather than fetch once and render the page as complete. Two guards back this: passing **`limit=0`** is the explicit "no limit — return every matching row" opt-in, for *known-bounded* scopes only (e.g. a series' removed-from-recurring rows) — never for an open-ended ledger, since `txn` has no inherent size bound; and in **dev builds** `api.getTransactions` logs a warning when a caller that omitted `limit` gets a truncated page (`transactions.length < total`), turning a silent truncation into a visible signal. A caller that passes an explicit `limit` has made a conscious choice and is exempt from the warning.

### Filter exclusion ("is not")

The shared transaction filter (`FilterBar` → the list feed, the bulk "select all matching" resolver,
every `/transactions/summary/*` endpoint, and CSV export) accepts each facet — account, group,
category, owner, payee, **and tags** — as both an **include** set and an **exclude** set (`exclude_*`
params).

- **Combination:** within one facet, include ids OR together (`IN (...)`); exclude ids AND on; across
  facets everything ANDs. So `account:Checking` + `exclude category:Dining` reads as "in Checking AND
  not Dining."
- **Exclusion is the NULL-safe negation of the *same* membership expression the include path builds.**
  One membership builder per facet feeds both modes, so they can never drift. The negation is
  `COALESCE((membership), 0) = 0`, **not** a bare `NOT IN` — the COALESCE is load-bearing: `category_id
  NOT IN (...)` is SQL-*unknown* (not true) for a NULL category, which would silently drop every
  uncategorized row from a "not Groceries" result even though a NULL-category row plainly is not
  Groceries. The invariant: **a row the include set does not match must survive that facet's
  exclusion**, including rows with a NULL category/owner. Excluding the synthetic *Uncategorized*
  buckets is the deliberate inverse (`category IS NOT NULL`, or the sign-scoped form for the
  expense/income buckets); excluding the owner `unassigned` bucket is the one case that *removes*
  NULL-owner rows, since that is the row set the user named.
- **Tags are the one facet whose membership is an `EXISTS`, not an `IN`.** "Has tag X" is
  `effective_tag_match_sql` (`services/transaction_tags.py`) — the *effective*-tag test: direct
  (visible `txn_tag`) OR inherited from the leaf category, its parent group, or the effective account,
  block-aware (a tag hidden on the row via `manual_state = -1` does not count). Exclusion negates it
  with plain `NOT (...)`: `EXISTS` is never NULL, so no COALESCE guard is needed — a row with no
  matching tag (including a fully untagged row) is exactly the `NOT EXISTS` set. Because inheritance is
  honored, `≠ Business` drops a row tagged Business *only* through its account/category, not just rows
  tagged directly. The filter also offers a synthetic **Untagged** bucket (`UNTAGGED_FILTER_ID`,
  `'__untagged__'`) — rows with **no effective tag at all** (`NOT effective_tag_any_sql`), the complement
  of "has any tag" and the tag-facet analog of the category *Uncategorized* / owner *unassigned* buckets;
  so a row that inherits a tag from its account is *not* Untagged, and `≠ Untagged` means "only rows that
  have some tag." Real ids and the Untagged bucket OR together within the facet (`tag_filter_membership_sql`).
  **One definition** (that builder) feeds the list, the summaries, and CSV export — the export previously
  matched direct tags only (a latent bug that silently omitted inherited rows for both include and
  exclude), now corrected by routing it through the same builder. Separately, the `/transactions` list
  accepts **`require_all_tag_ids`** — an *AND* constraint ("has **all** of these", `effective_tag_match_all_sql`,
  count-distinct = n), **independent** of the OR `tag_ids`, so both can apply in one query. It is an
  internal primitive (not surfaced in the app-wide `FilterBar`, which stays OR): the tag-report drill
  (`TagDetail`) uses it to scope rows to an *exact* signature — has-all the signature's tags,
  `exclude_tag_ids` none of the report's others — server-side, while the active filter's own OR `tag_ids`
  still applies on top. A general "tagged with both X and Y" filter could build on it later.
- The frontend carries the mode on each selection (`mode: 'include' | 'exclude'`, default include) and
  **must split selections by both type and mode**; feeding an exclude selection into an include param
  would invert its meaning. See `ui-patterns.md` → the include/exclude facet pattern.

## Rules

Rules are keyword-based categorization rules (a single keyword, or a small AND of `contains` clauses).

They can include:

- merchant matcher — either a single **keyword** (case-insensitive substring) or a **multi-clause**
  matcher of up to 3 `contains` clauses AND'd together (`category_rule.match_expr`, JSON
  `{"op":"and","clauses":[{"type":"contains","text":"…"}, …]}`; v1 is AND-only / contains-only). A
  multi-clause rule matches a row only when *every* clause's text appears in the row's name text (or, for
  `match_source_text` rules, its source text) — **order-independent**, so `{amazon, flash}` matches
  "FLASH sale at Amazon". Adding a clause only ever *narrows* what matches (AND is self-limiting). When a
  `match_expr` is present the stored `keyword` is **derived** from the clause texts (sorted, lowercased,
  space-joined) so it stays the `keyword LIKE` search target and its `LENGTH` keeps driving specificity
  ordering (see below). `match_expr` is NULL for an ordinary single-keyword rule, evaluated exactly as
  before. The `/rules` API accepts a `clauses` list and the backend owns canonicalization + keyword
  derivation (`build_match_expr`); every match site shares one predicate (`merchant_matcher_matches`).

- amount conditions

- debit/credit direction scope

- owner scope

- account scope (a single account)

- account **type** scope (`account\_type`, e.g. `paypal`/`amazon`): the rule matches only rows whose
  **effective** account (`COALESCE(parent, self)`, so a merged child inherits the parent's type) is of
  that type — one rule covers *every* account of the type. Parallel to the single-account scope but
  broader; part of the matcher identity. Precedence is **account_id > account_type > global** (a rule
  pinned to one account is more specific than one covering a whole type). This is the primitive the PayPal
  money-movement rules are scoped by — one `account_type='paypal'` rule per `Type` instead of one per
  (Type, account). See `docs/backlog/account-type-as-rule-criterion.md`.

- category assignment

- merchant rename (`clean\_name`)

- transaction-tag assignment

- match against captured import source text (opt-in `match\_source\_text`): when set, the keyword is
  tested against the row's captured import free text (the `import_evidence_json` description slot plus
  extra fields like "Original Statement"), not only the merchant/raw/display name. Default off, so
  existing keyword rules are unchanged. The source text excludes the account label; the Plaid sync
  path has no such evidence. See `docs/import-source-fields-plan.md`.

Important behavior:

- rule priority is automatic, not manually curated

- more specific rules beat more general ones. The text-specificity signal is `LENGTH(keyword)` — and
  because a multi-clause rule's derived keyword is its clause texts joined, that is effectively the
  **summed clause length**. This has the right property: a rule whose clauses are a *superset* of
  another's (`{amazon, prime}` vs `{amazon}`) always has a strictly greater total length, so the
  narrower rule wins wherever both match. It reduces to exactly the single-keyword behavior for a
  one-clause rule. Precedence between two *unrelated* matchers is a heuristic (it always was, even for
  single keywords); summed length is the metric, and scope + the one-rule-per-matcher conflict surfacing
  remain the explicit levers. This stays a **static, computed-once rule ordering** — no per-row scoring.

- amount comparisons use absolute values, with debit/credit scope applied separately through transaction sign when a rule is limited to one side

- owner-scoped rules beat global rules when otherwise similar

- at most one rule per *matcher* (keyword + the `match\_expr` clause set + owner + account + account **type** + amount range + debit/credit + the `match\_source\_text` flag — two rules differing only by whether they also match source text, or only by account type, target different rows, so they are distinct matchers). The `match\_expr` is canonicalized (clauses sorted) so reordering clauses never forks a phantom duplicate, and a multi-clause rule is a *distinct* matcher from a single-keyword rule that happens to share the derived keyword (`contains "amazon flash"` ≠ `{contains "amazon", contains "flash"}`). Saving a rule whose matcher already exists does not fork a second copy — `create_rule` classifies the collision and reconciles instead: a **duplicate** (adds nothing) is reported, not written; a **mergeable** save (adds a category/rename the existing rule lacks, or new tags) folds additively into the existing rule; a **conflict** (a category/rename that disagrees with the existing rule) is surfaced rather than silently resolved. A genuinely different matcher is not a collision and is created normally. A single manual save prompts the user on collision; the bulk Generate Rules flow auto-merges mergeable saves, skips duplicates, and surfaces conflicts in a summary. In the rule-suggestions UI that conflict summary names the colliding rule's category and resolves each in place without leaving the review: **Replace** overwrites the existing rule's action with the suggestion's — preserving the rule's id and tags — and accepts the suggestion against it, while **Keep** leaves the existing rule untouched and defers the suggestion; the conflict response carries the existing rule's category/rename so the summary can show both sides in one round trip. Because a merge or replace changes a rule that may already govern transactions (unlike accepting a brand-new rule), that summary then offers to re-categorize the rows the changed rule already matches, using a **preserve-manual** apply: it reclaims rows the rule should own — including import-locked ones — but leaves a deliberate manual per-transaction edit as the final say. Tags still union across *different* matching rules; only a same-matcher tag addition becomes a merge into the one rule.

- **Last-used tracking + trash + cleanup (stale-rule hygiene).** Three `category_rule` columns support cleaning out obsolete rules:
  - **`last_effect_date`** — the newest transaction *date* a rule has applied a **live effect** (category, rename, or tag) to, kept as a **monotonic-forward max**. It's a "does this rule still do anything" signal, not an event log: it's the transaction's date (never wall-clock), so a re-run can't drift it toward "now", and a rule that only touches old rows stays old-dated. Seeded by the v15 data-init (a derived pass, re-run after a restore of a pre-v15 backup — see *Schema evolution*) and maintained incrementally afterward. The seed **and** every apply site (`recategorize_all`, `_apply_rule_to_existing`, and the CSV import loop) attribute a row through the **same** `effect_rule_ids` helper (+ `bump_rule_effect_dates`), so they can't disagree — an earlier bug had the seed use its own stricter, source-gated logic and diverge. **Attribution is by winning *matcher*, not by a row's stored source:** a rule is credited for a row it *wins* (would categorize) even when import or an earlier manual edit currently holds that row's category (`category_source != 'rule'`) — the rule is still what categorizes that merchant, so it isn't stale. It is therefore **not** the raw match count the ↗ report shows (that is the *pure* matcher, every row the rule hits): a row shadowed by a **more-specific** rule credits that winner, not this rule, so a rule that always loses can match rows yet legitimately read "never used". Monotonic-max can slightly *overstate* freshness (a rule that once categorized a row later overridden still shows that date), which is the **safe** bias for a cleanup tool — it errs toward keeping a maybe-active rule.
  - **`deleted_at`** — soft-delete marker for the **rules trash**. Deleting a rule (single or via cleanup) sets it; the categorizer (`load_categorization_rules`, `_find_matching_rule`) and matcher-identity (`_existing_rule_for_matcher`, the update-collision probe) all filter `deleted_at IS NULL`, so a trashed rule stops categorizing and stops blocking re-creation of its matcher, while its row + `rule_tag` survive for restore. Restore refuses if an *active* rule now shares the matcher (409). Purge hard-deletes. Rule-backed recurring series are dropped on trash and re-created on restore (cadence resets to monthly — a minor edge). Recoverable from Settings → Trash → Rules.
  - **`is_managed`** — 1 for app-created infrastructure rules (the money-movement Type rules); the stale-rule cleanup **excludes** them so a sweep can't remove rules the app maintains.
  - **Cleanup** (`GET /rules/cleanup-candidates?before=…` + `POST /rules/cleanup`): active, non-managed rules whose `last_effect_date` is older than a user-chosen window (or NULL = never used) are the candidates; the user reviews them (per-rule keep) and trashes the set — **retain-by-default** (categorizations left alone), with an opt-in batch revert. The window is a per-user preference and starts unset (nothing swept until chosen).

- a rule must target an **active** category. Deleting a category deletes every rule pointing into the deactivated branch, and the categorizer skips any rule whose target category is inactive — so a stale rule can never re-categorize new rows into a deleted category. Tag-only rules (no category) are unaffected.

- the same invariant is enforced when *editing* a rule (`update_rule`): if an edit makes a rule's matcher collide with a **different** existing rule, both rows already exist, so reconciling means one is removed — a mergeable/duplicate edit folds the edited rule's actions into the other rule and **deletes the edited rule**; a conflict is reported for the user to resolve (edit the other rule, delete one, or change scope). Both `create_rule` and `update_rule` take `on_existing` = `reject` (default: classify and report without writing) or `merge` (apply the reconciliation).

The goal is to make rule behavior explainable without requiring users to hand-maintain a priority table. Specificity and owner scope stand in for manual ordering because they usually match what a user means when two rules overlap. The one-rule-per-matcher invariant keeps that ordering meaningful: duplicate matchers would make "which rule wins" order-dependent, and editing one copy would leave the other firing.

**How rules come into being.** Rules are rarely authored cold; three paths feed the same `category_rule` store. The primary one is *learning from a categorization*: when the user sets a transaction's category the UI offers to turn that action into a rule, and once saved the rule applies automatically to newly imported transactions (rule application can be disabled globally, and a *run categorization* pass can be triggered on demand). The bulk **Generate rules from imported data** path derives candidate rules from transactions that arrived already categorized in a curated import (the "categories present in the data" flag) and presents them for review — the data-driven path for users migrating curated data. The opt-in **starter rules** add a fixed, curated catalog for users with no data to learn from. The distinction that matters: rules mutate transaction data, so neither bulk path applies blindly — Generate rules is reviewed per suggestion, and the starter rules are presented as an approve-before-add list (the user sees every `keyword → category` before any is created). All three converge on the same one-matcher reconciliation described above; inert categories have no such gate, which is why a starter *category* can be added in one click while starter *rules* go through the list.

**How an existing transaction's category can change.** Two fields govern this: `category_source` (`manual` / `import` / `rule` / `cleared` / `enrichment` / NULL) records provenance, and `category_overridden` is a lock bit (1 = automatic categorization must leave the row alone), set for `manual` and `import`, clear for `rule` and `cleared`. The retroactive operations differ only in which of those they respect:

- **`enrichment` is feature-owned and off-limits to automatic categorization**, even though it carries `category_overridden = 0`. An excluded Amazon funding charge (`_exclude_charge`) or a suppressed wallet funding leg (`suppress_batch_funding_legs`) is deliberately moved into an excluded category and joined to a `txn_link` that stashes its prior categorization for reversal. Letting a rule reclaim it — or `recategorize_all` clearing it to NULL when nothing matches — would silently un-exclude the row and double-count the spend against its still-counted order/purchase. So both automatic passes (`recategorize_all` and its `preview_recategorize_count`) *and* the preserve-manual apply skip `enrichment` by source, not by the lock bit. The reversal path (batch undo / re-import replace, and the reconciliation report's unlink/detach) is what returns the row to its stashed prior. Only an explicit full-force rule apply may take an `enrichment` row.

- **Run categorization** (`recategorize_all`, the *run categorization* button via `POST /sync/recategorize`) re-runs all rules but selects only `category_overridden = 0` rows that are not `enrichment` — `rule` and uncategorized — so `manual`, `import`, and `enrichment` rows are left untouched. It is **retain-by-default and monotonic**: it only ever *sets* or *changes* a category (and rule-applied tags), never *removes* one. A `rule` row that now matches nothing **keeps its category** — it stays `category_overridden = 0`, so a future rule can still reclaim it. This is deliberate: deleting an obsolete rule, or narrowing one, must not silently un-categorize the history it already produced. (Rule *renames* have always behaved this way — a no-match row keeps its display name; this makes categories and rule-tags consistent with that.)

  - **Reconcile is the opt-in, scoped exception.** `recategorize_all(retain_unmatched=False)` restores the old projection behavior — a no-match `rule` row is cleared to uncategorized (a `cleared` row keeps its marker), and its rule-tags removed. It is **only** ever run over a **specific row set** (`txn_ids`), never the whole ledger, so it cannot mass-revert the orphaned-rule rows that retain accumulates. Two callers: the **"re-evaluate this rule's transactions" opt-in** on a rule delete/edit (`DELETE`/`PATCH /rules/{id}?reconcile=true` — the "this rule was wrong, revert its rows" path, off by default), which reconciles just that rule's matched rows; and the money-movement **"remove a type"** path, which reconciles just the excluded "Money movement" leaf's rows so an un-approved type falls back out (retain would otherwise strand it there). Scoping to one rule's rows is what makes reconcile safe — it re-derives each row against the *remaining* rules (a dropped row clears or moves to another matching rule; a still-matched row is unchanged) and never touches a categorization another rule owns.

- **Full-force rule apply** (`POST /rules/{id}/apply`, the "apply to N matching transactions" offered when a rule is saved) re-categorizes *every* matcher match regardless of source — including `manual` and `import` — to the rule (`category_source = 'rule'`, `category_overridden = 0`). It is the one bulk path that overrides a manual edit, on the premise that an explicit apply is the user asking the rule to own those rows (the api layer labels the no-flag call "full force, overwriting all matches").

- **Preserve-manual apply** (`POST /rules/{id}/apply?preserve_manual=true` and `/apply-to-transactions`) is the same reclaim but with a `category_source IS NOT 'manual'` (and `IS NOT 'enrichment'`) guard, so it reclaims `import`-locked rows while sparing manual edits and feature-owned enrichment exclusions. It is used after a merge/replace changes a governing rule (see the suspect-duplicate section) and when accepting an import-rule suggestion (scoped to that suggestion's `source_row_ids`).

- **The Generate-rules conflict screen** is the one place an `import` row is re-categorized *while staying `import`*: Recategorize (`PATCH /transactions/{id}/imported-category`) keeps `category_source = 'import'` and rewrites the stored `imported_category` so the row keeps feeding suggestions, while Preserve writes `'manual'`. This is the deliberate exception to "an imported-category edit elsewhere becomes a manual override" detailed in the rule-suggestions section below.

- **Conflict-set matcher refinement happens before disposition.** On the Generate-rules conflict card, the top-level *Edit match* action refines the shared matcher for the rows currently represented by that card before any winner category or keep/preserve decision is made. Saving that edit immediately re-partitions the pending review: the narrowed subset becomes the current pending suggestion/card, while leftover rows return to canonical generation so equivalent remainders from other owners/cards can coalesce into one broader rule. If a refined card is later broadened back to the row's ordinary merchant matcher, it also returns to canonical generation so conflicts and owner scoping are recomputed against the full merchant population rather than staying hidden as a one-row pending override. A synthetic follow-up is retained only when a remainder would otherwise collide with the refined subset's suggestion identity. This is a review-state partitioning step, not a rule/action edit — it changes which rows are grouped together for the next decision, not their category source or disposition.

- **Rejecting a rule suggestion** (`POST /transactions/rejected-suggestion-disposition`, the *discard and: keep / remove categorization* control on the Generate-rules review — `keep`/`clear` modes below) settles the rows the suggestion covered, sparing rows already `manual`. Three outcomes by intent: **keep as imported** (mode `keep` with no `category_id`, or a `category_id` equal to the row's current one) **leaves the row untouched at `import`** — keeping the file's own category is not an override, so the row stays re-derivable and, crucially, still reclaimable by a later explicit "apply to existing" (a `manual` row would be *spared* by that, defeating the toast); it still survives an automatic Run categorization because import rows are `category_overridden = 1`. **Re-point** (mode `keep` with a *different* active-leaf `category_id`) writes `category_source = 'manual'` at the chosen category — a genuine override (the conflict-set card's "keep these, but as a different category"), spared by both Run categorization and explicit apply. **clear** writes `category_source = 'cleared'` with `category_id = NULL` (*the category is wrong* — messy/mangled source data; rule-eligible again). Only rows that actually change are returned in the prior-state snapshot, so Undo restores the exact pre-change `(category_id, source, overridden)` and a keep-as-imported (no-op) leaves nothing to restore. **Trade-off of keep-as-imported:** because the rows stay `import`-backed, the merchant keeps regenerating as a *discarded* suggestion rather than vanishing the way a `manual` settle did — benign, and the review's look-back lens hides stale ones anyway.

Manual edits (`override_category`, bulk category edit) always set `category_source = 'manual'`, `category_overridden = 1` — the user's final say, undone only by another manual edit or a full-force apply.

The **`cleared`** source is a deliberately distinct value from a plain NULL source. A `cleared` row is **rule-eligible** (`category_overridden = 0`, so Run categorization and future rules can claim it — at which point it becomes `rule`), but it **retains its `imported_category` text** for audit and is **skipped by the trust-flag re-derivation** (`_set_batch_imported_category_usage`), which otherwise re-applies a file label to any labeled non-`manual`/`rule` row on enable. NULL alone could not carry that distinction: the re-derivation must keep filling ordinary uncategorized (`NULL`) rows, so "the user discarded this label" needs its own marker. `recategorize_all` likewise preserves the `cleared` marker when no rule matches (it only overwrites to `rule` on a positive match), so a rename/tag-only rule cannot silently strip it.

Tags are separate from the category tree and are meant for cross-cutting labels such as `Essential Expenses`, `Alice`, `Reimbursable`, etc. A transaction's **effective tags** are the additive union of these sources, listed by precedence (most specific first) when reporting the source for a tag the transaction picked up through more than one path:

- **direct (txn_tag):** added on a transaction by a matching rule (`rule_present`) and/or a manual edit (`manual_state = 1`); manual `manual_state = -1` blocks a rule-applied direct tag for that one transaction without changing the rule

- **category-level (category_tag):** any tag attached to the transaction's leaf category propagates to every transaction in that category

- **group-level (category_tag):** any tag attached to the leaf category's parent group propagates to every transaction in any leaf under it

- **account-level (account_tag):** any tag attached to the transaction's **effective (top-level) account** propagates to every transaction in that account. The effective account is `COALESCE(parent_account_id, account_id)`, so a top-level account's tags reach its own *and its child accounts'* transactions, while a child account's own tags stay **dormant** while it is merged (resolution never consults the child's row) and reactivate automatically when it is detached. Merging a tagged account under a parent therefore quietly sets its tags aside rather than deleting or promoting them — the parent's tags govern, and the child's return on detach. Account is the broadest scope, so it is the most general (lowest-precedence) source

Inherited tags (account-, category-, or group-level) **are** overridable on a single transaction: unchecking one in the transaction's tag picker hides it on that row only, without touching the category/account it comes from. This reuses the direct layer's `manual_state = -1` **block** as a *universal* per-transaction suppression — a `txn_tag` row with `manual_state = -1` removes the tag from that transaction no matter which source(s) would otherwise contribute it. Re-checking the tag clears the block (a purely inherited tag needs no `txn_tag` row at all once unblocked). Blocks are keyed to `(txn_id, tag_id)`, independent of rules, so they survive rule reruns and recategorization (only the direct-rule `clear_manual_blocks` path — which requires `rule_present` — ever clears one). `get_visible_transaction_tag_map` applies blocks last (after the source merge), and `get_blocked_transaction_tag_map` reports the hidden tags so the picker can offer them for restore.

Tag-aware filtering and aggregation matches a transaction if its effective tags include the requested tag, regardless of which source contributed it. Rules can still add tags directly:

- a rule may assign a category, rename the merchant, add tags, or do any combination of those actions

- category/rename still come from the first matching rule that provides that action, while direct tags are the union of all matching rules

## Recurring series

A **recurring series** (`recurring_series`) is an ongoing obligation whose charges recur on a cadence —
a subscription, a bill, a periodic tax. It is modeled as a first-class record rather than a per-
transaction flag or a tag, because recurrence carries structure a boolean can't: a cadence
(`weekly`/`biweekly`/`monthly`/`quarterly`/`semiannual`/`annual` + a canonical `period_days`), an
expected amount band (`expected_amount`/`amount_min`/`amount_max`), a projected `next_due_date`, and a
lifecycle. Transactions link to their series through the nullable `txn.recurring_series_id` — a match
cache the detector maintains, not a user-authored field.

Detection lives in `backend/services/recurring_detection.py`; the API is `backend/routers/recurring.py`.
Key invariants:

- **The grouping/detection key is (payee, category, sign), not payee alone.** One payee can host
  several series distinguished by category — a town billing property tax quarterly, excise annually,
  and water monthly. Category is the strong discriminator; within a group, amount clustering is a
  fallback that separates same-category series (a fixed-price subscription buried in a noisy merchant,
  or two same-category bills at different price points), and a fallback cluster must be **amount-tight**
  (low amount CV) so a coincidental subset of noise can't masquerade as a series.

- **The "payee" is the user-facing name, resolved `display_name`-first** (matching the ledger's
  `getTxnMerchantLabel`), then normalized (lower-case, punctuation→spaces, trailing store-number and
  domain-ending tokens like `.org`/`.com` dropped). Because rule `clean_name`s and user renames land in
  `display_name`, this makes the user's naming *drive* grouping: unifying a vendor's spelling (via a
  rename/rule) automatically groups its variants, and the `Vendor: Subtype` convention naturally splits
  a payee's distinct bills into separate series. `recurring_series.payee_key` is stored but **derived,
  not authoritative** — re-derived from the current members' names on every scan, so a normalization
  change (or an edited series name) can never strand a series with a stale key. It is derived from the
  *members*, not the editable label, so renaming a series never breaks its matching.

- **The series' display label is chosen by precedence, and is user-editable.** From its members:
  (1) a rule-authored name (`category_source = 'rule'` → the rule's `clean_name`), else (2) the most
  common name that still appears recently (a stale legacy spelling doesn't beat the current one), else
  (3) the most recent member's name. The user can rename a series inline; the edit persists (it marks
  the series user-owned, so a later scan won't overwrite it) and does not affect matching.

- **A transaction belongs to at most one series, and `occurrence_count` equals the linked-row count.**
  A scan assigns membership exclusively: user-owned series are processed in priority order (active
  before ended, account-scoped before account-agnostic, then higher confidence), each claiming only
  rows not already claimed, and its stats are written from exactly the rows it owns — so the card's
  count can never diverge from its drill-down. Two overlapping series (e.g. an account-agnostic and an
  account-scoped one for the same payee) are prevented at the source: an auto candidate is skipped when
  a user-owned series already covers it — **same payee + category with an overlapping account scope,
  where a NULL (account-agnostic) scope covers every account.** (Pre-existing user-confirmed duplicates
  still coexist until the user deletes one; the exclusivity rule just keeps their counts honest.)

- **Timing regularity is the primary signal, not frequency.** A high-volume but irregular payee
  (Amazon, Venmo, PayPal) scores itself out via gap-variance with no name blocklist, while a low-
  volume-but-regular payee (an annual tax) survives. **Amount is a confidence booster and a forecast
  hint, never a matching gate** — a variable-amount utility bill still recurs on schedule.

- **A series holds at most one charge per occurrence date.** When several charges share a date, only
  the one whose amount is closest to the series' typical amount is a member; the rest are dropped from
  it (never summed into the occurrence). This is what keeps an annual tax filing that lands on the same
  day as a quarterly estimate from being folded into the quarterly series and inflating its amount.
  Detection claims series iteratively — a series takes one charge per date, then leftover same-date
  charges are re-examined and can coalesce into their own series (e.g. the annuals form an annual
  series) rather than contaminating the first. The same one-per-date selection governs membership when a
  confirmed/manual series is re-matched on a later scan, so the outlier can't creep back in.

- **`source`/`confirmed`/`status` record curation and gate the idempotent rescan.** A scan
  (`POST /recurring/scan`) is re-runnable: it rewrites `source='auto'` + `confirmed=0` +
  `status='active'` series wholesale, while **manual** (`source='manual'`), **confirmed**
  (`confirmed=1`), and **suppressed** (`status='suppressed'`) series are user-owned — never overwritten,
  and a candidate matching a user-owned identity `(payee_key, category_id, account_id)` is **not
  re-proposed**. A suppressed series owns no transactions but persists so detection won't resurface it
  ("this is not recurring"). Confirm/suppress/edit/manual-create/pin/exclude are all the actions that make
  a series user-owned. Membership (`txn.recurring_series_id`) is recomputed for every surviving series on
  each scan.

- **Rule-backed series (`source='rule'`) are the user-driven answer to varying payee names.** The derived
  `(payee, category, sign)` key is right for the *auto* detector but too rigid when a human declares a
  series a bank spells several ways (`NYTIMES.COM` vs. `NYTimes NY TIMES …4637`) — those normalize to
  different keys and would never group. So a **rule** gains an `is_recurring` flag; when set it owns a
  `recurring_series` row (`source='rule'`, `rule_id` FK, `confirmed=1`) whose **membership is the rule's
  matches** — the same shared predicate (`categorizer.rule_matches_row`) that rule *apply* uses, so
  "which rows the rule owns" has one definition. This is the deliberate exception to "unify the name to
  unify the series": edit the rule (keyword/scope/amount condition) to change membership. The rule is
  created/toggled through the shared rule editor's "Recurring series" checkbox (a cadence seeds the
  rhythm); `is_recurring` counts as a valid rule action on its own (a track-recurrence-only rule with no
  category). A rule-backed series is reconciled against the **full** window even on a scoped import scan
  (its members can span payees a scoped pool omits — the whole point), so a newly imported matching row
  attaches right away without stamping membership through every insert path. The transaction payload
  carries `recurring_series_name`/`recurring_rule_id` (a `LEFT JOIN`) so a row's `↻` marker and the
  editor's status row read membership directly, and the row menu's "Mark as recurring…" routes into the
  rule editor rather than a separate dialog.

- **`recurring_membership_override` is a surgical, scan-durable pin/exclude layered over the matcher.**
  Membership is a rebuilt cache, so a one-off correction (`state='pinned'` forces a row in even when it
  wouldn't match; `state='excluded'` keeps a matched row out) can't live in `txn.recurring_series_id` —
  it lives in its own `(txn_id, series_id, state)` table that `reconcile_series` re-applies every scan.
  A pin is exclusive (a partial unique index enforces one pinned series per transaction) and **wins a
  contested occurrence date** in the one-per-date selection; an exclude is subtracted before it. Setting
  either **confirms the series** (like edit/confirm) so an auto series isn't deleted and re-minted with a
  fresh id out from under the override. Stats derive from the effective (override-adjusted) set, so
  `occurrence_count` still equals the linked-row count. Surfaced as the row menu's "Remove from recurring
  series" (`POST /recurring/{id}/membership`). A removal is recoverable three ways: an immediate **Undo**
  toast (clears the override right away); the removed row's own right-click menu, which offers **Restore
  to recurring series** because the transaction payload carries the `recurring_excluded_series_id`/name it
  was removed from; and — to browse all of a series' removals — the series drill-down's **"N removed"**
  list (rows read via the transactions filter `recurring_excluded_series_id`), each with an **Add back**.
  All three resolve to `state='clear'`, after which the row re-matches and rejoins.

- **Rule↔series lifecycle coupling.** For a `source='rule'` series the "recurring" checkbox lives on the
  rule, so the destructive series actions reconcile the two: **suppress** and **delete** clear the rule's
  `is_recurring` and drop the series (and delete the rule outright if clearing the flag leaves it
  actionless), while **end** deliberately keeps the flag live and freezes `next_due` so a resubscribe can
  still resume it — end means "stopped", not "not recurring". Deleting the rule (or an edit that merges it
  away) drops its backing series; unchecking `is_recurring` on the rule drops the series while keeping the
  rule if it still has another action.

- **The scan also runs automatically, at two scopes, gated so it never does redundant heavy work.**
  `scan_and_store` takes an optional `payee_keys` scope, so the same pipeline serves both:
  - *Scoped* (`scan_imported_payees`, `payee_keys` set) — a completed CSV import or Plaid sync reprocesses
    only the payees the batch touched, matching new charges into existing series and detecting new series
    among those payees immediately, while every other payee's series and membership are left exactly as
    they are. Correct because detection groups by payee and reconcile never disturbs out-of-scope rows.
    A scoped pass **does not** stamp the watermark and **skips** the payee-key re-derivation (both are
    global concerns it can't do), so it trusts stored keys.
  - *Full* (`run_auto_scan`, `payee_keys=None`) — app load fires a catch-up (`POST /recurring/auto-scan`
    → `maybe_auto_scan`) that runs a global scan only when *due*: never scanned or older than a ~daily
    interval. It is the safety net for the cross-payee and normalization effects a scoped pass can't see.
    A **recategorize** (`POST /sync/recategorize`) also triggers a full scan directly, because it can
    rename payees (`clean_name`) and move categories across the whole ledger — and it is the one path that
    renames *existing* series members, exactly the case a scoped pass leaves to a full rebuild.

  "Last scanned" is a single data-DB-level watermark in `db_meta` (`recurring_last_scan_at`), not a
  per-user `ui_preference`: one data DB has one set of series, so in multi-user mode the first client to
  load triggers the catch-up and the rest skip. An absent watermark reads as "never scanned," so a
  database migrated from a pre-recurring schema populates its series on first load. Scoped passes never
  touch the watermark, so they give immediacy between the daily global rebuilds without suppressing them.

- **`ended` is distinct from `suppressed`, and deliberately so.** Suppressed means *the detector was
  wrong* (not a real series) and durably blocks re-proposal. **Ended** (`status='ended'`, set by
  `POST /recurring/{id}/end`) means *the detector was right but the series has stopped* — a canceled
  subscription. An ended series keeps its transactions linked (history) and is excluded from forecasts,
  but is **not** blocked from re-detection: its `next_due_date` is **frozen** while ended, and a rescan
  **reactivates** it (`ended → active`) if a charge lands on/after that frozen date — a resubscribe. So
  a resumed subscription revives the same record rather than spawning a duplicate. (Reactivate also
  happens manually via the same `restore` path suppressed series use.) The auto-*end* trigger — a
  missed expected charge — is deferred with the rest of the anomaly signals; today ended is set by the
  user (a button on a confirmed series, or the "Not recurring" split control's "Mark canceled" on a
  detected one).

- **Money-movement series are classified, not hidden.** A series whose category (or its parent group)
  is `exclude_from_totals` — a transfer or a credit-card payment — is *money movement*, not spending or
  income. Rather than dropping these from detection, the series is flagged (derived at read time from
  the category, no stored column) so the UI marks it and clusters money-movement series together (sorted
  by category, so the two legs of one transfer sit adjacent). This keeps a recurring CC payment from
  masquerading as a bill while still surfacing genuine recurring transfers. A formal two-sided "transfer
  set" (pairing the debit and credit legs into one record, à la import conflict sets) is deferred — the
  same-category adjacency sort covers the common case, and pairing can't span an untracked external
  account anyway.

This is the same "algorithm proposes, user disposes" idiom as import rule suggestions, and the same
"the rule is the cache" split as the parked online-categorizer note: detection is the expensive
bounded-window pass, while matching a new transaction to an existing series is a cheap keyed lookup.
Per-import matching and anomaly/forecast signals (missed charge, price change, upcoming) are deferred.

## Import batches and profiles

CSV import creates supporting records for workflow and recovery:

- **Import profiles:** saved mapping/setup templates for recurring CSV formats

- **Import batches:** one record per import run so imported transactions can be undone

Imports use exact content hashing first for duplicate detection, then can fall back to narrower cross-source heuristics when an import explicitly links a new account to an existing account/group for duplicate comparison.

Important import-batch behavior:

- duplicate detection only blocks rows that match transactions already in Luma before the import starts

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

- imports that use categories present in the data can assign real `category_id` values to imported transactions, lock those assignments against *automatic* rule reruns (an explicit per-rule apply can still reclaim them — the preserve-manual variant, used after a merge/replace and when accepting an import-rule suggestion, does so while sparing manual edits), and treat those rows as learning input for future rule suggestions. Accepting a suggestion auto-applies the rule's outputs (category / rename / tags) to *only* the rows that generated it (`POST /rules/{id}/apply-to-transactions` with that suggestion's `source_row_ids`), so conflicting rows owned by other suggestions and Preserved manual exceptions are left alone rather than reassigned. The accepted review entry stores whether that save created a rule owned by the suggestion, plus the rows' pre-apply categorization snapshot; returning that accepted entry to pending uses those persisted facts to remove only the owned rule and put the rows back into the suggestion pool. Editing an already-accepted suggestion redraws that accepted row partition: newly matching rows are added to `source_row_ids` and to the restore snapshot, while rows that no longer match are restored immediately to their original imported/manual state so they can regenerate as pending suggestions instead of remaining stranded as rule-sourced rows
- accepted, deferred, and discarded rule-suggestion entries are review artifacts, not live mirrors of the rule table. Clearing one of those settled piles removes the entries from the active review and stores them as one restorable trash set for that clear action (surfaced as the **cleared sets** pill — named for the action that fills it, and counting *sets* rather than suggestions like every other pill). Restoring a set returns every suggestion in it to its prior review status. Clear/restore never creates, deletes, or edits live rules and never mutates transactions; it only prunes or rehydrates the persisted review-state entries so long-lived import reviews can be kept compact without losing a short-term recovery path
- those imports promote missing imported category names into real leaf categories under the protected `Unassigned` group instead of keeping a pending review list
- imported labels that only mean "still uncategorized", such as `Uncategorized`, `Uncategorised`, or `Unassigned`, should not create real categories; those rows stay at `category_id = NULL` so the app has one canonical uncategorized state
- reporting and category-management surfaces may still split that one `NULL` state into synthetic expense-side and income-side buckets based on transaction sign, but those are presentation buckets rather than stored categories
- those imports match an imported label against existing **leaf** categories only: a label that matches an existing leaf reuses it, otherwise a new leaf is created under `Unassigned`. A top-level group that happens to share the label is *not* treated as a match (it is not assignable), so an imported `Miscellaneous` becomes a `Miscellaneous` leaf rather than being folded into a `Miscellaneous` group
- a label matching an **inactive (deleted)** leaf is suppressed: the row imports uncategorized (`category_id`/`category_source` left NULL, `imported_category` retained), no new leaf is created, and the inactive leaf is *not* resurrected. This is what makes a deletion durable across re-imports — a deleted label keeps landing uncategorized instead of repopulating the organize pool. The match is name-based, so reactivating the leaf (which restores it under `Unassigned`) lets future imports of that label adopt it again. A **set-aside** (still-active) label is *not* suppressed — imports keep categorizing to it, because set-aside only parks the category, it does not remove it

- **categorization precedence at import is `mapping → rule → imported label → uncategorized`, and it is deliberate.** The user's own rules run *before* the file's category: when a rule categorizes a row it is stored under the rule's category and the file label is **not** promoted into a category for that row (it would be an empty, unused category). An explicit per-label mapping from the review screen outranks rules; the imported label is adopted (and lazily created) only for rows nothing above claimed, and only when the source/batch is flagged to use imported categories. Tag-only rules still apply their tags while leaving the category open for the label fallback. The raw label is always kept on the row as `imported_category` text regardless of which category wins, so it survives for audit (surfaced in the transaction detail's Origin → "Show more"). The same precedence governs the post-import per-batch "use imported categories" toggle, so enabling it later fills only rows no mapping or rule has claimed — it never overrides a rule.

  **Why this order — the intent behind the "use imported categories" flag.** The flag is a *bootstrapping* aid, not an authority claim (its UI label "use/trust the categories present in the data" reads stronger than its real job). Early on Luma has no categories or rules, so a source's own categories seed the user's taxonomy and give the rule-suggester something to learn from. As the user groups/cleans categories and builds rules *inside Luma*, Luma becomes the source of truth and the external source decays into a mere aggregator — a pipe, not a categorizer. So the file label is only ever a gap-filler for rows the user has not yet taught Luma to categorize, and the flag **self-attenuates**: as rules grow, more rows are claimed by rules before the label fallback is reached, so the source's categories quietly stop mattering without the user ever turning the flag off. That is why a rule must win over the file label, and why we never mint a category nothing is stored under.

- imported categories created from a batch that used categories present in the data keep their source batch id only while that batch is their sole source, so undo can remove them when safe but repeated appearance in another such file makes them independent of the original import

- system-wide rule suggestions are generated from imported transactions that carry real categories — rows whose category came from the file (`category_source = 'import'`), plus manual rows that *reinforce* a category the file already evidenced for that merchant (e.g. rows the user reconciled onto it). A category seen only through manual edits — one the file never carried for that merchant — does not originate a suggestion, so a Preserved one-off neither spawns its own suggestion nor re-creates a conflict. Suggestions are not built from per-file proposal queues or raw imported category text alone

Using real categorized transactions rather than raw imported labels keeps rule suggestions aligned with the actual category tree the app is using. That avoids learning from labels that were never accepted, were ambiguous, or no longer map cleanly to the current category structure.

When the same merchant carries *different* imported categories across rows, those rows surface as a conflict group (the majority category is the reference; the rest are flagged). The suggestion's matching-transactions report lets the user act on them two distinct ways, and the distinction is deliberate:

- **Recategorize** — the per-row category picker, the "set all to" bulk pick, and the per-row "Use majority" button — records a *corrected file categorization* (`setImportedCategory`, `PATCH /transactions/{id}/imported-category`): it keeps `category_source = 'import'` and rewrites `imported_category` to the chosen category's name. Because the row stays import-derived it keeps driving the suggestions, so re-categorizing re-targets / collapses the conflict rather than removing rows from the learning set; and because the recorded file label is rewritten, toggling the batch's "trust these categories" flag (which re-derives `'import'` rows from their stored label) can't revert it. Undoing the import and re-importing the file still starts fresh.
- **Preserve This Categorization** records a manual exception (`setCategory`, `'manual'`): the rules never change that row and it drops out of the suggestions entirely — a deliberate one-off, not part of any rule.

The report is **scoped to the rows the opening card represents** — a single suggestion's own `source_row_ids`, or the union across a conflict set's members — passed as `row_ids` to `/rule-suggestions/matches`. This keeps the report's contents matching the card's row count: a *generic* suggestion (no owner/account/amount scope) would otherwise match every same-keyword row, sweeping in rows owned by other separately-scoped or already-disposed suggestions for that merchant. (When `row_ids` is omitted — e.g. a re-added suggestion with no stored source rows — the keyword/scope match defines the set, the legacy behavior.)

For display the report treats the scoped row ids as authoritative, whatever their *current* source, so a Preserved row stays visible (with a manual-override badge) and an accepted row can still be inspected after the rule has reclaimed it as `rule`. A manual row is never flagged as conflicting — it's a settled decision, not an open conflict. Re-categorizing the minority onto the winner therefore collapses the conflict to a single-category suggestion that keeps its full row count, instead of shrinking and relocating. A legitimately distinct subset can instead be kept on its own category via Preserve — and because that category then has no file-derived backing, it simply drops out rather than re-surfacing as a conflict.

This splits a judgment call that was previously open: a category edit on the conflict-resolution screen is treated as *correcting the file's data* (it keeps `import` and rewrites the label), while Preserve is the way to say "this one is a manual exception." The reasoning is least surprise — on a screen whose whole purpose is resolving cross-row categorization conflicts, the common gesture (fixing a mislabeled row so the merchant's rule is right) should feed the rule and survive a trust-flag re-toggle, and only the explicit "preserve" gesture should carve out an untouchable exception. Note this makes the conflict-resolution screen an intentional exception to the general "an imported-category edit elsewhere becomes a manual override" default.

In the pending review a conflict group is resolved as a unit on one **conflict-set card** (`ConflictSetCard`), and that card is built around the input/output split the rest of this section depends on. It shows two category columns per member: **Imported category** is the input fact (the category those rows currently carry) and is read-only; **Target category** is the output (where those rows should land) and is an editable pill on *every* row, defaulting to the imported category. A radio marks one member the **winner** — its target becomes the rule (`merchant contains keyword → target`). Each other member's disposition is then *derived by comparing its target to the winner's category*, with no separate keep/recategorize control:

- target **== the winner's category** → the rule owns those rows: they ride in the same preserve-manual rule apply as the winner's own rows (`POST /rules/{id}/apply-to-transactions`), so import-locked rows are reclaimed to `rule` (the lock is gone *because the row is no longer an `import` row*, so later edits to the rule propagate to them via Run categorization);
- target **== another active leaf, different from the row's imported category** → kept as a manual exception there (`rejected-suggestion-disposition` `keep` with that `category_id`), the "keep these, but as a different category" case;
- target **== the row's own imported category** (unchanged) → left at `import` (keeping the file's category is not an override; see Rejecting a rule suggestion above);
- target **emptied** → `cleared`.

With **no winner** chosen, every member is settled to its target (`keep`) — the "no rule, keep everything as imported (or as edited)" path: members left at their imported category stay `import`, members re-pointed to a different category become `manual`. The whole set commits in one combined Undo entry (prior member review statuses plus the row snapshots of rows that actually changed, including rows reclaimed by the winner's rule). Only the winner's rows and rows re-targeted to the winner become `rule`-owned; a re-pointed keep becomes a `manual` carve-out the rule must not touch, while an unchanged keep stays `import`.

When a conflict-set action changes a member's row categories, the review entry also keeps a compact `review_action` summary of the category transition (grouped counts from original category to applied category). This is display history, not category truth: transactions remain at their current category, and restoring an individual discarded/deferred suggestion does not automatically roll rows back. The settled views use this metadata to preserve context such as `Lunch (was Food & Dining)` after several formerly distinct buckets have been re-pointed to the same target category.

All suggestions for one displayed merchant render together in the review inside one **bordered merchant container** (the container appears only when a merchant has >=2 distinct items; a lone card or a lone conflict set renders bare). The grouping key favors the normalized merchant label, falling back to the keyword when no label is available; unresolved conflict sets use their canonical conflict keyword so members with sampled label differences still stay together. Refined keywords such as `merchant renewal` remain in the original merchant's neighborhood rather than sorting away from the broader `merchant` suggestion. When a refinement creates a follow-up suggestion, the refined card and its follow-up share a split-root working-set key; that split key outranks display-label grouping so label cleanup differences such as `Merchant` vs `MERCHANT #1234` cannot separate the chunks the user is actively resolving. Settling one member of that split does not delete the pending follow-up: accepting, deferring, or discarding one chunk leaves the remaining chunk in the review with its own row ownership, so the accepted entry cannot be overwritten by the regenerated remainder. The group's **combined** row count across all members drives its sort position, so a small owner-scoped variant sorts beside its high-volume sibling instead of sinking down the list. A conflict subset inside the container still resolves on its own `ConflictSetCard`. This is purely a display/grouping concern in `ImportRuleSuggestionReview` — it does not change how suggestions are generated, scoped, or stored. Distinct merchants never merge: scope variants for the same merchant can legitimately co-exist as separate rules (the more specific wins at categorize time), so broadening one — e.g. removing its owner to make it generic — never discards the others.

The review record (`review_state.suggestions[id]`, in the batch/profile/system snapshot) reflects edits made on the way to acceptance: removing a suggestion's owner or account to generalize it is persisted back to the record (an explicit clear-to-null is honored, not dropped), so the accepted card shows the rule's real scope. An accepted suggestion also carries its `rule_id` (from `review_state.statuses[id]`) in the API response, so editing an already-accepted suggestion updates that existing rule in place rather than creating a second one.

**Look-back lens.** Rules are forward-looking, so a merchant pattern with no recent activity is unlikely to recur and just clogs the review. Each generated suggestion carries `latest_txn_date` (the newest date among its source rows); the pending/conflicts views show only merchant working sets with visible activity inside a per-user window (`ui.importRuleSuggestions.lookbackYears`, default 2; `0` = all time, set via the **Look back** control). The stale remainder isn't dropped — fully stale merchant groups move to a dedicated **`older` pill** (a pending sub-filter, surfaced only when non-empty), so the `pending` pill is lensed to the in-window merchant groups and `pending + older = all pending` (the counts still reconcile to `total`). Clicking `older` shows those fully stale groups — the natural place to bulk-settle them (Discard, keep). The lens is a **view filter only** — it never changes generation or stored review state, and the substance threshold stays computed from full history (so narrowing the window can't lower the bar and flood the list with tiny suggestions). A merchant group or split working set is kept whole while any visible member of that working set is recent, including recently accepted/deferred/discarded siblings, because settling one chunk should not immediately strand the remaining pending chunk in Older while the user is still resolving that merchant. Once those visible settled siblings are cleared from review, a fully-stale pending group naturally lives under `older`. Decoupling "is this pattern substantial" (full history) from "is it still live" (recent activity) is deliberate: recency, not raw count, is the better predictor of recurrence.

**Bulk disposition.** The pending bulk menu settles a whole selection at once with one combined Undo entry: **Discard, keep categories** marks the suggestions discarded and leaves their rows `import` (status-only — the rows keep their category and stay reclaimable), and **Discard, clear categories** additionally clears the rows to `cleared`. There is deliberately no bare "remove" — keeping-as-imported is the honest default for "reviewed, don't build a rule." A stale tail outside the look-back window needs no special bulk control — existing controls already re-apply rules to it — but *which* control depends on how the rows were discarded, because the two dispositions leave the rows in different lock states. **Discard, clear categories** rows are `cleared` (`category_overridden = 0`), so the page's global **Apply categorization rules** button — which runs `recategorize_all`, the `category_overridden = 0` pass — reclaims any that now match a rule the user has since created. **Discard, keep categories** rows stay `import` (locked, `category_overridden = 1`), which that global pass deliberately skips; they are reclaimed only by an explicit per-rule **apply to existing** (the preserve-manual apply, which takes `import`-locked rows while sparing manual edits) — the same path the keep-as-imported note above relies on. So the global button is not itself the preserve-manual apply, and it does not touch `import` rows.

- batch summaries keep lightweight counts and small rejected-row samples
- when later account cleanup deletes imported transactions, batch summaries and per-account import breakdowns should shrink to match the transactions that still remain from that batch

- detailed duplicate-row review data is stored separately and loaded on demand so long-lived import history stays compact

- per-user or per-local-profile preferences may also carry a default mode for whether categories present in the data should be used for new imports (`all`, `none`, or `per_source`); this does not override saved data-source settings or per-batch choices, but it seeds the initial import workflow before a source-specific decision exists

## Transaction links and Amazon order import

**`txn_link` is a general association primitive, not an Amazon feature.** A link groups a set of transactions under a `kind` (e.g. `amazon_order`), each membership row (`txn_link_member`) carrying a `role` within the link (e.g. the funding `charge` vs the `item` rows it was split into); a link also carries an optional `external_ref` (the external entity it represents — an Amazon order id, which is the reconciliation key) and a `metadata_json` blob for kind-specific data. The primitive is deliberately **pure association**: creating or deleting a link never mutates the linked transactions (no category change, no `exclude_from_totals`, no amount change). Whatever feature owns the link performs those mutations and records what it did in `metadata_json` so it can reverse them. That separation is what lets the one table serve unrelated cases — Amazon order itemization and **wallet funding-leg suppression** (`kind='wallet_funding'`, see below) today, credit-card payment-leg pairing and a cash-flow lens as intended future clients. Both tables ride in backups. A member row cascades away with either endpoint (`ON DELETE CASCADE` on both FKs), but a link row has **no** FK to `txn`, so the owning feature (and the wipe path) must delete stale links explicitly rather than relying on cascade.

**Amazon order import is the first client** (parsed from an AZAD orders/items export; **orders-only model**, 2026-07-10 — the earlier per-item itemization was superseded). Each order becomes **one spending transaction** in a chosen **Amazon account** — an ordinary account, since an account here is only a reporting/owner dimension with no balance or net-worth role — amount = net cash (`total − refund`), memo = the orders file's concatenated item list, categorized by the user's normal rules. The matching card charge (found by amount + date, with the account resolved from the funding-source map — see below) is recategorized into the excluded **"Amazon Funding"** leaf (created under the seeded `Transfers` group, so exclusion is inherited via `COALESCE(parent, leaf)`) and joined to the order by an `amazon_order` link (member roles `order` + `charge`). An order may link **several** charges (a split-shipment order — see the reconciliation bullet): each charge's prior categorization is stashed per charge in the link `metadata_json` (`charge_priors: {charge_id: prior}`; the legacy singular `charge_prior` written by the auto-matcher is still honored) so undo restores each exactly. The invariants that keep totals honest:

- **The money counts once.** The order row counts as spending; the funding charge is excluded. Exclusion is *conditional* — only a charge actually linked to an imported order is excluded (a blanket `AMAZON.COM → exclude` rule would wrongly drop Amazon spend that has no imported order), which is exactly the fact the link records.
- **The items file is optional enrichment, not rows.** The orders file alone is a complete transaction. If the **items** export is present, its per-item reference detail (ASIN, list price, quantity) is folded into the existing order transaction's `import_evidence` (idempotent, PayPal-style) — never as separate rows. Amazon's category taxonomy is parsed but deliberately unused (the user categorizes their own way). Item rows whose order isn't imported yet are **parked** rather than lost: their detail is retained in `amazon_pending_item` (keyed by `order_id`, upserted so a re-imported items file refreshes rather than duplicates; `parked_batch_id` ties each row to the orphan import that created it), and importing the matching orders file later **auto-attaches** it at order creation (`_take_parked_items`) — no manual re-import. A parked row is consumed on attach and cleared when its parking import is undone. Once an items-only card is fully matched it is folded into the orders card that holds its orders (`_merge_items_card_into_orders`: the items file's name, hash, and enrichment summary move onto the orders card and the empty items card is deleted), so a split import converges to one card labeled with both files — the same end state as importing them together. This is symmetric in import order: items-**before**-orders folds the prior parked-items card into the new orders card; items-**after**-orders (an items file enriching already-imported orders) folds the new empty items card into the prior orders card. Only when a single orders card is involved. While only *partly* matched, the items card survives and its "no match" count is derived **live** from the ledger (`unmatched_parked_order_count`) so it resolves toward zero as orders arrive and re-flags if an import is undone; it stays *not* hash-remembered (see the per-file hashes bullet) so a manual re-import isn't blocked, though with auto-attach it's rarely needed.
- **Non-cash orders do not count.** An order funded only by `Rewards Points` or `Amazon gift card balance` (the export never discloses their dollar figure) is recorded in the excluded category — visible, no cash counted. An order whose card charge is on an *untracked* card (no ledger match) instead counts directly as the sole record, with nothing to exclude.
- **Reconciliation report.** `amazon_reconciliation(batch_id)` (endpoint `GET /import-export/amazon/reconciliation/{batch_id}`) reports, per import batch, five buckets:
  - **matched** — order ↔ the charge(s) it excluded (`charges`: usually one, several for an accepted split).
  - **duplicate** — an order whose charge is *duplicated* (≥2 same-amount candidate charges made the auto-match ambiguous — the Mint double-import case). Carries every copy plus a **`mergeable`** flag: merge (keep the richest copy, fold the losers' distinguishing detail into its evidence, trash the rest, link the survivor) is offered only when no *other* unmatched order shares the amount — otherwise the copies are distinct purchases and merging would steal a charge, so the per-copy Discard is the resolution (`merge_duplicate_charges` guards the same condition server-side). Folded "Merged duplicate detail" is filtered for noise: a loser's text folds only if it adds a token that is both new (exact or abbreviation-subsequence, so MKTPLACE≈MARKETPLACE) and identifier-like (digit-bearing) — generic payment filler never folds.
  - **matched_review** — a would-be-unmatched cash order whose total is covered by a **unique** combination of unaccounted charges (≤4 parts, within ±14 days, ~2¢ tolerance): Amazon billed the order as split shipments. Advisory only — **Accept** links the whole set (each charge excluded), **Dismiss** persists `split_suggestion_dismissed` in the link metadata so it stops re-surfacing (cleared if the order is later linked). Ambiguity (two covering combinations) is never guessed at.
  - **amazon_unmatched** — a cash order with no candidate charge at all; resolvable by hand via the multi-charge link (`POST /amazon/link-charges`), which warns on (but allows) a sum that doesn't equal the order total. It counts toward attention until acknowledged: **Mark reviewed** (`POST /amazon/mark-no-charge-reviewed`, bulk by `link_ids`, `reviewed=false` un-acknowledges) sets `no_charge_reviewed` in the order's link metadata, dropping it out of the attention count while it stays visible in the report. Linking a charge clears the flag (so an order re-surfaces fresh if later unlinked). This is the escape valve for untracked-card orders that have nothing to link — mirrors the CSV advisory-reject `reviewed_at` acknowledgment.
  - **payment_unmatched** — the heuristic *reverse scan*: Amazon-looking ledger charges (`merchant/raw LIKE %AMZN%/%AMAZON%`, positive) on the cards Amazon uses (this batch's matched-charge accounts ∪ globally-mapped funding accounts), in the batch's date range, that no order is linked to. The candidate pool the split suggestion draws from (with a wider ±14-day window). Each counts toward attention until acknowledged: **Mark reviewed** (`POST /amazon/mark-unaccounted-reviewed`, bulk by `txn_ids`, `reviewed=false` un-acknowledges) writes a row to `amazon_charge_reviewed`, dropping it out of the attention count while it stays listed. The acknowledgment is cleared if the charge is later linked to an order (so it re-surfaces fresh if unlinked). Trashing a charge doesn't clear the flag, but a trashed charge leaves the reverse scan anyway; the row cascades away on hard-delete.

  **Actionable attention** = the duplicate + duplicate_review + matched_review + unaccounted_duplicate counts, plus each **unacknowledged** no-charge-found order **and** each **unacknowledged** unaccounted (reverse-scan) charge (`reconciliation_attention_count`). Both of the last two are often benign (an untracked-card/pre-coverage gap with nothing to link; a purchase the export didn't cover), but a real anomaly — e.g. a stray unpaired duplicate — can hide in either pile, so each is surfaced until the user **Mark reviewed**s it (see the buckets above; no-charge-found acknowledgment lives in the order's `txn_link` metadata as `no_charge_reviewed`, unaccounted-charge acknowledgment in the `amazon_charge_reviewed` table). The acknowledgment is what keeps them from nagging forever. Attention is surfaced as `recon_attention_count` on each Amazon batch in `GET /import-export/batches` and as an `amazon_reconciliation` warning task in `GET /tasks`, so the file card and the Tasks nag clear together as items are resolved or acknowledged.
- **Which account the charge is on comes from the funding-source map (`amazon_funding_map`), not the mask.** An order's `payments` field names the paying **instrument** (a card `last-4` + network label), but imported ledgers rarely carry card masks, so keying the charge on `account.mask` alone matches nothing. The map keys an instrument → the system **funding account** it charges. Three states: a row with `funding_account_id` set = **mapped** (the charge search is constrained to that account, `t.account_id = funding_account_id`, which also resolves same-amount ambiguity across accounts); a row with `funding_account_id` NULL = **untracked** (an explicit "not an account I hold" — the items are the sole record and count directly, no charge); no row = **unmapped** (falls to the *graceful-last-4* search — the last-4 disambiguates only among accounts that *carry* a mask, so a maskless account can't contradict it and is carried by amount + date + uniqueness). Scope: `amazon_account_id` NULL is the **global default** (applies when importing for any Amazon account); a non-NULL value is a **per-account override** that wins for that one account. Resolution order is therefore **override → global → graceful-last-4 → no match** (a `$0` charge never matches, and the search always excludes the target Amazon account so an order can't self-match its own item). The map is user-maintained on the Amazon import tab, accrues instruments as imports surface them, and is many-to-one (several Amazon accounts, or a reissued card, may point at one funding account). It rides in backups; a mapping whose named account doesn't survive a restore is dropped (returning that instrument to unmapped) rather than silently flipped to untracked.
- **Idempotent, order-independent.** Ingestion is keyed on `order id` — a re-imported order that already has a link is a no-op (`already_applied`); a later items file for an already-imported order folds its detail in once (a re-imported items file whose order already carries item detail reports `already_enriched`, distinct from a duplicate order). An items file whose orders file is absent parks its detail (see above), so importing the files in either order converges once both are in — the parked detail attaches when the orders file arrives.
- **Persisted marketplace summary + per-file hashes.** Unlike CSV imports, a marketplace batch's outcome is investigable *after* the fact: `run_amazon_import` persists into `config_snapshot` the `import_summary` (the outcome counts plus the rows that never became transactions — `enriched_items` / `already_enriched_items` [each with the enriched order's `txn_id`], `discarded_items`, `duplicate_orders`, all carrying `source_file` provenance, and `skipped_files` — files whose *every* row discarded, struck through on the file card) and `amazon_file_hashes` (`{filename, hash}` per file taken, via the CSV importer's `make_import_file_hash`). A later upload whose content hash matches a **completed** batch's file is **skipped** and reported "already imported" (announced at scan time; an all-skipped import creates *no* batch — the file already has its card); an undone batch's files, and any file with discarded rows, are deliberately not remembered so they stay re-importable. Each created order transaction also records its `source_file` in `import_evidence`. `GET /import-export/amazon/import-detail/{batch_id}` renders all of this as the import-detail report (orders / items matched / already enriched / discarded / duplicates / matched charges by payment account), resolving enriched items by `txn_id` since the orders they touched usually live in the *orders* file's batch.
- **Undo restores the outside-the-batch charge first.** The order row belongs to the import batch and is removed by ordinary batch undo, but the linked charge lives *outside* the batch; batch undo (and the re-import replace path) therefore restores each linked charge's prior category from the link metadata and deletes the link *before* deleting the batch's own rows — the same ordering discipline as enrichment reversal, and for the same reason (otherwise the reclassification is orphaned and un-reversible).
- **History grouping.** The import batch is stamped `source_kind = 'marketplace:amazon'` — a generic `import_batch` column (NULL for ordinary CSV imports) — so the recent-import history groups these under an "Amazon" entry rather than "unknown data source" (a marketplace import has no CSV profile). See `ui-patterns.md` → Import-specific patterns.

**Wallet funding-leg suppression is the second client** (`kind='wallet_funding'`, `services/money_movement.py`, landed 2026-07-19). A wallet-style CSV (PayPal, Venmo, …) records a single balance-funded purchase as **two** rows in one export — the payment out to the merchant, and an equal-and-opposite nameless deposit *into* the wallet balance. That deposit is money movement, not income. After the import insert loop, `suppress_batch_funding_legs` pairs the two **within the batch** — a *nameless credit* whose **unique** same-day equal-and-opposite twin is a *named debit* — and recategorizes only the **leg** into an excluded **"Money movement"** leaf (under the seeded `Transfers` group), joining it to the purchase by a `wallet_funding` link (roles `leg`/`purchase`, the leg's prior category stashed in `metadata_json` for reversal). Always on, but deliberately high-precision so a genuine inbound payment (a *named* credit with no offsetting purchase) is never touched and an *ambiguous* group (two same-amount rows on a side) is left entirely alone. The captured `Type` value ("Bank Deposit to PP Account", …) is **corroborating, not required**: the recognized vocabulary is a code constant, the structural signal stands without it, and any unrecognized `Type` on a suppressed leg is reported in the import summary (`money_movement_unrecognized_types`). The category is intentionally **generic/source-agnostic** (the same two-legged shape occurs across wallets); per-source provenance lives on the link + the leg's `import_evidence`. Reversal (`reverse_batch_money_movement_links`) runs in both `undo_batch` and the re-import replace path — and, unlike the Amazon charge, both paired rows belong to the batch, so reversal exists mainly to drop the link (a `txn_link` row has no FK to `txn`) plus restore any leg that outlives the batch.

**PayPal source recognition + `Type`-based money-movement categorization** (landed 2026-07-20). Beyond the structural funding-leg pairs above, the other money-movement rows (holds/reversals, standalone deposits/withdrawals/currency conversions) are recognized by the PayPal `Type` field, with three supporting pieces:

- **Source recognition.** A PayPal Activity CSV is identified by its header (`sniff_paypal_activity`, a marker-subset test). A recognized import auto-attaches to the **single system "PayPal" data source** — `csv_import_profile.source_kind = 'source:paypal'`, created on first use (named "PayPal", "PayPal 2"… on name collision), `account_id` NULL so one source spans accounts (the target is picked per import), **visible/renamable but not deletable**. A *hand-created* PayPal source is **adopted** (tagged `source:paypal`) on its next PayPal import rather than left untagged, so there's exactly one. The batch is likewise stamped `source_kind = 'source:paypal'`.
- **Forced capture.** A recognized file **force-captures** `Type` + `Item Title` into `import_evidence` regardless of the user's column-capture picks (`_forced_evidence_headers`), so the signal money-movement handling depends on is always present (an unchecked `Type` can't silently drop it).
- **User-approved `Type` rules, not a frozen vocabulary.** Approved types become `match_source_text` rules keyed on the `Type` value → the excluded **Money movement** category. `is_money_movement_type` is **fragment-based** (*deposit / withdrawal / currency conversion / hold* — so a future `eCheck Deposit` still matches, stale-resistant) and only **pre-checks** a review; the user decides which types become rules. The review is **source-scoped** (`money_movement_type_proposals_for_profile` unions the `Type`s across all the source's imports — one surface for every type, not one per card) and **bidirectional** (each type's `already_ruled` state; an `{add, remove}` apply creates/deletes rules and runs `recategorize_all`, so *existing* rows move too). Rules are **account-type-scoped** (`account_type='paypal'`), so **one** rule per `Type` covers every PayPal account and a same-text transaction on a non-PayPal account can't match. Approving a `Type` also types the source's accounts `paypal` when generic (so the type-scoped rule matches — see Accounts → `type`). Reached from a "Money movement" button on the PayPal data-source header and automatically after a PayPal import.

## Backups

Backup/restore deals with two different classes of data:

- regular app data

- credentials/secrets such as Plaid-linked credentials

Those are intentionally separated so normal backups can stay safer and simpler.

The regular backup (payload **version 7**) covers the full **data-DB** state so a restore reproduces the working app, not just the ledger: owners, accounts, categories/groups, rules, merchant renames, import profiles/batches/history, transactions, the entire **tag system** (`tag` plus every attachment — `txn_tag`, `category_tag`, `account_tag`, `rule_tag`), the `account_pair_distinct` and `amazon_charge_distinct` assertions, the `amazon_charge_reviewed` acknowledgments (reconciliation reverse-scan "Mark reviewed" state), the **recurring series** (`recurring_series` plus the
`txn.recurring_series_id` membership link), the **transaction links** (`txn_link` plus its `txn_link_member` membership — see "Transaction links and Amazon order import"), the **Amazon funding-source map** (`amazon_funding_map` — the instrument→account mappings the Amazon importer resolves charges against), the **parked Amazon items** (`amazon_pending_item` — per-item detail from an items file awaiting its orders file; kept whole rows whose `parked_batch_id` survived the restore), and **UI/layout preferences** (`ui_preference` — see below). Restore is destructive — it wipes and rebuilds in foreign-key-safe order (tag definitions before any attachment; attachments after their other parent), and drops any attachment whose endpoints didn't survive the restore. Older payload versions are no longer accepted.

**Two version axes, and why restore tolerates schema drift.** The payload carries `version` (the JSON *envelope format*, bumped by hand — restore hard-rejects anything but the format it understands) and, independently, `schema_version` (the *DB migration level* `db_meta.version` the data conformed to when exported). They move on different cadences: a schema change bumps `CURRENT_VERSION` without touching the envelope shape. Restore rebuilds each table by inserting only the payload columns the *live* table still has (`insert_rows` intersects the row's keys with `PRAGMA table_info`), so it survives schema evolution in both safe directions: a column the schema has since **added** is simply absent and takes its default (e.g. `category_rule.match_source_text`), and a column since **dropped** is skipped rather than failing the whole restore with "no column named …" (the real case: `category_rule.priority`, removed once rule ordering became automatic, which a pre-removal backup still carries). The accounts and transactions dumps additionally use curated column lists rather than `SELECT *`, so they never carry an incidental/legacy column in the first place; the `SELECT *` tables (categories, rules, tags, …) rely on the restore-side filtering. The one direction restore can *not* make safe is a **downgrade** — a backup whose `schema_version` is newer than this build — because a column the newer build added with real content would be dropped silently; the compatibility guard refuses that (see below). Restore loads the old values straight into the current schema and then **replays the data-init half of every migration newer than the backup** (`run_post_restore_data_init`, gated on the backup's `schema_version` — see *Schema evolution* → migrations' two halves) so derived fields the backup predates are recomputed rather than left empty. The column-drift handling above and this data-init replay are complementary: the former fills *stored* columns the payload lacks with their defaults; the latter recomputes *derived* columns a newer migration would have produced (e.g. `last_effect_date`), which no default can supply. The schema DDL itself is deliberately **not** replayed — the target is already at `CURRENT_VERSION`, so those ALTERs would be no-ops; only the data-derivation half is missing after a raw insert.

**Content integrity hash.** The JSON backups (data and credentials) embed a `content_sha256` over the canonical payload (sorted keys, compact separators, the hash field itself excluded). Restore recomputes it and refuses a mismatch with a `400` *before* anything destructive, so a corrupted or truncated download can't get as far as wiping the target. It is **optional and additive**: absent → skipped (a backup predating the field, or one a power user deliberately stripped, still restores), exactly like `schema_version`. It is deliberately an *unsigned* checksum — it detects **accidental** corruption, not tampering: anyone editing the plaintext file can recompute or drop the hash, so it makes no authenticity claim. Tamper-/authenticity-proofing is the **encrypted backup's** job: its `payload.bin` is sealed with AES-256-GCM, whose auth tag is verified at decrypt time (a stronger, keyed check), and the hash rides along inside the encrypted inner payload for free rather than being duplicated at the envelope level.

The **encrypted backup envelope** carries the `format` tag `"luma-encrypted-backup"` in its `manifest.json`.

The payload is also **stamped** with the source data DB's `instance_id` (from `db_meta`) and its `access_mode` (`local`/`auth`). Restore uses this as a **compatibility guard** so it can't silently replace the wrong system: it proceeds freely when the target is empty (no accounts/transactions — a fresh install) or when restoring this system's *own* backup (matching `instance_id`) in the same mode, but returns `409 {code: "restore_incompatible", reasons: […]}` when the target already has data and the backup came from a *different* `instance_id` (`different_system`), when the access modes differ (`mode_mismatch`), or when the backup's `schema_version` is **newer** than this build's `CURRENT_VERSION` (`newer_schema` — the lossy downgrade above). An older or absent `schema_version` is safe and never flagged. The UI turns that 409 into an explicit confirmation and retries with a `force` flag; `force` is the only way past the guard, so an accidental cross-system, cross-mode, or downgrade wipe always requires a deliberate second confirmation.

**A restore adopts the backup's `instance_id`.** Because a restore is a full replacement — it wipes the target and reloads the backup wholesale — afterward the data *is* exactly the backup's system, so the DB takes on the backup's `instance_id` rather than keeping the target's old one. (Only the identity changes; `access_mode` is a property of the deployment, not stored in the DB.) This keeps identity meaning "which data lineage this is": without it, restoring a backup into a fresh DB and then restoring the *same* backup again would wrongly trip the "different system" guard, since the fresh DB would still carry its own throwaway id. The guard itself is unaffected — it compares the *incoming* backup against the *pre-restore* data to decide whether confirmation is needed; the adoption only sets the identity the DB carries once that data has been replaced. The `instance_id` also namespaces browser-local UI caches (remembered profile, account-UI state) per database, so adopting the backup's id keeps those caches aligned with the data lineage they describe.

### Preferences

Non-sensitive **UI/layout preferences** — page layouts, collapse state, dashboard view, the currently-selected dashboard breakdown, import-page UI state (expanded rows, panel positions), etc. — live in the **data DB** in `ui_preference(scope_id, pref_key, pref_value)`. `scope_id` is the authenticated user id (auth mode) or the local-preference-profile id (local mode). They live here, with the data they describe, rather than in the control DB — so a data backup carries them and there is no cross-DB/scope plumbing. The **control DB keeps only identity/secrets** (users, auth secrets, recovery codes) and the local-preference-profile *definitions*; profile names stay control-side, the preference *values* are data-side.

**The dividing line is per-user chrome vs. shared data state.** `ui_preference` is only for things that may legitimately differ per person — column choices, collapse/sort state, panel geometry, which dashboard view/breakdown they prefer. State that describes *the shared data itself* must not be scoped per profile, because every user is looking at the same data and a restore into a different profile would orphan it. Such state lives in shared `import_workflow_state` (the tenant-wide KV store, carried by backups) instead. Two worked examples: the "Group Imported Categories" workspace draft (how the one shared category tree is being organized — `system_category_workspace_draft`, see `architecture.md` → Organize / inactive surface), and the **dashboard tag-report catalog** (`system_dashboard_tag_reports`, via `GET`/`PUT /tags/dashboard-reports`). The tag-report case shows the split sharply: the *catalog* of saved reports is shared (everyone sees the same saved reports), while which report a user currently has open (`ui.dashboard.spendingViewBy`) stays a per-user `ui_preference` — **shared catalog, personal selection**. When adding a new persisted value, classify it on this line before choosing a store.

The `/preferences` API (`auth.py`) is the single facade: it resolves the scope id and reads/writes `ui_preference` (via `services/preferences.py`). Preferences originally lived in the control DB (`user_preference` / `local_preference_value`); that store, and the lazy per-scope relocation bridge that moved its rows into the data DB, have been removed now that the move is complete — `init_control_db` drops the two legacy tables, so the control DB holds only identity/secrets plus the local-profile *definitions*.

## Schema evolution

Fresh installs are created directly in the current schema by `init_db` and stamped at
`CURRENT_VERSION`. The historical incremental migration chain (v1..v32) that upgraded pre-rebrand
databases was dropped at the Luma rebrand break point and the baseline reset to `1`; there is no
in-place upgrade path *off a pre-rebrand database* (those come across via backup + restore into a
fresh install — see the backup envelope note above).

Post-rebrand, the **migration runner is active**: `run_migrations` advances an existing database to
`CURRENT_VERSION` by applying each registered `@migration(version)` newer than the DB's recorded
`db_meta.version`, in order. Fresh installs skip the runner — they are created at the full current
schema and stamped directly. Registered migrations so far: **v2** adds `category_rule.match_source_text`,
**v3** adds `txn.needs_review`, **v4** adds `txn.recurring_series_id` (the `recurring_series` table
itself is created by `init_db`'s `CREATE TABLE IF NOT EXISTS` script, which runs on both fresh and
migrated databases, so only the new *column* needs an `ALTER`). Later migrations continue the additive
pattern; **v12** adds the `import_batch.recon_attention_count` / `recon_epoch` cache columns and the
recon-epoch invalidation triggers, **v13** adds `category_rule.account_type` (the account-type rule scope),
**v14** adds `category_rule.match_expr` (the multi-clause AND/contains merchant matcher),
**v15** adds the stale-rule cleanup columns — `category_rule.last_effect_date`, `deleted_at` (the rules
trash), and `is_managed`; **v16** adds the `amazon_pending_item` parked-items table; and the newest,
**v17**, adds the `amazon_charge_reviewed` table (reconciliation reverse-scan "Mark reviewed"
acknowledgments) (`CURRENT_VERSION = 17`).

**Migrations have two halves — schema and data-init — and a restore replays the data-init half.** Some
migrations do more than add a column: they *derive* the new field from existing data (**v6** re-derives
`display_name_source`; **v13** backfills PayPal account types + consolidates money-movement rules; **v15**
seeds `last_effect_date` and flags `is_managed`). Each such data step is extracted into a named function,
called by the migration, and registered in `POST_RESTORE_DATA_INIT` keyed by version. This exists because a
**backup restore** loads the backup's rows into the *already-current* schema (restore never re-creates an
old schema or replays schema DDL), so the data-init half of every migration *newer than the backup* would
otherwise be skipped — the concrete bug being restored rules reading `last_effect_date` NULL despite recent
matches. `run_post_restore_data_init(conn, backup_schema_version)` (end of `restore_backup`) runs exactly the
registered steps in `(backup_schema_version, CURRENT_VERSION]`, in **ascending order** (later steps may read
earlier ones' output — v15's date seed reads the provenance v6 sets). Gating on the recorded `schema_version`
is essential: each step runs **once, only on data that predates it**, because some are destructive if re-run
(v6 overwrites provenance; v13 deletes duplicate rules), so "always re-run all backfills" is unsafe. A backup
with no/unknown `schema_version` — including any **pre-rebrand** backup — is treated as **Luma v1**, so all
post-rebrand data-init runs; a backup newer than this build runs none (empty range).

When the schema changes from here:

- update `init_db` in `backend/db/database.py` so fresh databases are created directly in the new
  shape (add the column to the baseline `CREATE TABLE`)

- register a `@migration(N)` that brings an existing database to the same shape (idempotent
  `ALTER TABLE … ADD COLUMN …` etc.) and bump `CURRENT_VERSION` to `N`

- if the migration *derives* the new field from existing rows (not just an additive column that takes a
  default), extract that derivation into a named function, call it from the migration, **and** register it
  in `POST_RESTORE_DATA_INIT[N]` so restoring an older backup re-runs it. Write it to be correct run once on
  data that predates it — it runs exactly once, gated on the backup's `schema_version`

- a structural object that *references* a migration-added column **or a migration-added table** (e.g. an
  index over the column, or a trigger on the table) must **not** live in `init_db`'s
  `CREATE TABLE`/`executescript` block — on a pre-`N` database that column/table doesn't exist yet when
  that script runs (it is all `CREATE TABLE IF NOT EXISTS`, so the column is added only later by
  `run_migrations`). Create such objects after the fresh/migrate branch in `init_db`, where they are
  guaranteed present on both paths. `idx_txn_needs_review` is the worked example for a column-referencing
  index; the recon-epoch triggers (`_create_recon_epoch_triggers`) are the example for triggers on tables
  a migration adds (`amazon_funding_map`, `amazon_charge_distinct`) — they also need `db_meta`, which the
  fresh/migrate branch has just created, so the post-branch placement satisfies both dependencies.

## Reporting assumptions

A few behavior rules matter across the whole app:

- income groups match money-in transactions

- expense groups match money-out transactions

- `exclude\_from\_totals` must be honored consistently across summaries and charts

- category grouping is only two levels deep

If any of these assumptions change, both backend queries and frontend UI logic will likely need coordinated updates.
