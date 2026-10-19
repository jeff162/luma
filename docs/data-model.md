# Data Model

What each field and state means, the invariants that hold between them, and the reason for each. How
they are exposed through the API and the UI is in `architecture.md`.

## Contents

- [Core hierarchy](#core-hierarchy)
- [Owners](#owners)
- [Accounts](#accounts)
- [Transactions](#transactions)
- [Categories](#categories)
- [Rules](#rules)
- [Recurring series](#recurring-series)
- [Import batches and profiles](#import-batches-and-profiles)
- [Watched import folders](#watched-import-folders)
- [Transaction links and Amazon order import](#transaction-links-and-amazon-order-import)
- [Backups](#backups)
- [Schema evolution](#schema-evolution)
- [Reporting assumptions](#reporting-assumptions)
- [Transaction splits](#transaction-splits)
- [Attached documents](#attached-documents)
- [Multi-payment purchases](#multi-payment-purchases)
- [Reimbursable expenses](#reimbursable-expenses)
- [Open](#open)

## Core hierarchy

`Owner -> Account -> Transaction -> Category (leaf) -> Category group`

- an **owner** is a person or a shared household bucket
- an **account** belongs to at most one owner
- a **transaction** belongs to one account
- a transaction is assigned to one leaf category or, when **split**, to a set of allocations that each
  name a leaf and together sum to its amount
- a **leaf category** belongs to a top-level category group

## Owners

Owners are household members or shared buckets (Alice, Bob, Shared). An owner holds accounts, scopes
some rules, divides dashboard views, and decides whether its new transactions arrive flagged for review
(`owner.flag_new_for_review`, see [`needs_review`](#needs_review)).

`txn.owner_id` is copied from the account when a row is created, so owner filters need no join. It is
the owner axis every filter and task reads. Changing an account's owner rewrites every one of its rows
in the same write, which is what keeps the stored axis and the account in step; the column exists so
that every filter, summary and task reads one place rather than joining, and so a correction has one
site to make.

## Accounts

An account is a bank, card, wallet or marketplace account, created by mapping a connection, by a CSV
import, or by hand. It is a reporting and ownership dimension only: it carries no balance.

### Data-source linkage

An account fed by a provider connection carries `external_account_id` (the provider's per-account
handle, the upsert key on connect and sync, `UNIQUE`), `connection_id` (FK to `connection`,
`ON DELETE SET NULL`) and `provider` (the provider key, or the `csv` / `manual` sentinels). CSV and
manual accounts, and any account whose connection was removed, have `connection_id IS NULL`.

The per-bank credential lives on the `connection` row. The aggregator's app-level credential, one per
provider, lives in `provider_config` with its secret vault-encrypted. The provider seam and the
credential resolver are in `architecture.md` → *Provider connections*.

### Connection account mapping

`connection_account`, keyed `(connection_id, external_account_id)`, is a connection's account mapping:
the counterpart of a CSV import's account step. It records

- what the provider offers: `provider_name`, `provider_official_name`, `provider_type`,
  `provider_subtype`, `provider_mask`, `provider_currency`. These are kept apart from the local account
  so the mapping screen still shows what the bank calls an account after the local one is renamed
- what the user decided: `mapping_mode`, `account_id`, `target_account_id`
- that account's coverage: `coverage_start_date`, `coverage_through_date`, `terminal_window_days`,
  `history_complete`, `history_empty_streak` (see [Coverage has two shapes](#coverage-has-two-shapes))

Connecting a bank writes these rows with `mapping_mode = NULL` and creates no local account. Nothing
lands until the user says what each provider account is.

| mode | effect | what duplicate detection gets |
| --- | --- | --- |
| `existing` | the connection linkage is stamped onto the chosen account | same-account exact-hash and coverage rules apply directly |
| `group` | a new account whose `parent_account_id` is the target's group root | the group's compare target, so exact-hash matches resolve across the group. Not an alias: a sibling is a different physical account, so coverage does not span the pair |
| `new` | a plain new account | the soft-flag sweep only |
| `skip` | no local account, and the choice is remembered | sync counts the rows as skipped, and *Refresh accounts* does not recreate the account |

- **Mapping is idempotent and revisitable**: the same call after Link or months later, because for a
  metered provider re-linking to start over may not be available.
- **A provider handle already held by a local account is adopted as `existing`.** The handle outlives
  the mapping row, which a disconnect cascades away, so a reconnect would otherwise start a second copy
  of every account.
- **Switching an already-linked account to `group` or `new` reuses that account.**
- **Only `existing` and `group` feed the alias machinery** (`account_duplicate_compare_targets`,
  `explicit_alias_csv_values`), and only an alias unlocks the coverage rules. Two accounts kept apart
  get the soft-flag sweep and auto-confirmation of exact in-group matches.
- **The table rides the data backup.** Nothing in it is a credential, and a data restore has to wipe
  coverage: a restored three-month-old ledger with a surviving coverage claim would hard-reject the rows
  a re-sync brings back.

### Type

`account.type` is one of `depository`, `credit`, `savings`, `loan`, `investment`, `p2p`, `other`, the
marketplace `amazon`, or the wallet `paypal`. It is user-editable, and it is what the account-type rule
scope matches (see [Rules](#rules)).

- A recognized PayPal import sets `type = 'paypal'` on a **newly created** target account only.
- Approving a PayPal source's money-movement `Type`s also types that source's accounts `paypal` while
  they are still generic (`depository`, `other`, `p2p`), because the money-movement rules are scoped by
  account type. A non-generic type the user set is never overwritten.
- `amazon` is a marketplace kind and is hidden from the generic CSV importer. `paypal` is not; PayPal
  files use the generic importer.

### Names and labels

`display_name` is the label used outside the Accounts page. A standalone account keeps it equal to
`name`; a merged child inherits its parent's. Inside a group it therefore names the group, not the
member, so anything that has to tell two members apart labels an account through `_account_label_sql`
(display name plus masked suffix).

A duplicate report labels the matched side with `_account_label_sql` and nothing richer. The incoming
side of a hard reject shows the source's own label, so a richer label on one side would render one
account as two different-looking ones.

### Account groups

`parent_account_id IS NULL` marks a top-level, selectable account. A child keeps its own name and mask
on the Accounts page and resolves through its parent everywhere else. Groups are one level deep:
regrouping a parent under another top-level account makes every member, the old parent included, a
direct child of the new one.

Merging sets `parent_account_id` and moves nothing, which is what lets a detach reverse it.

### A stored account id is a reference into a mutable graph

Because a merge rewrites nothing, an account id stored in another table can become a child after it was
written, while the transactions it was meant to select resolve to the group root. Every account
comparison has two sides that must resolve the same way: the **row side**
(`COALESCE(parent_account_id, account_id)`, the effective account a transaction sits on) and the
**stored side**. A raw stored id compared against a resolved row side selects nothing and raises
nothing.

`backend/services/account_groups.py` holds both forms of the resolution: `effective_account_id_sql` for
queries, `effective_account_id` / `account_group_member_ids` for id lists. API filters resolve the ids
they are given in SQL (`account_membership` in `services/transaction_facets.py`), so a child id passed
as `account_ids` means the group it belongs to. "Exactly this underlying account" is
`source_account_ids`.

How a column behaves depends on whether it names a **matching scope** or a **specific account row**.

- **Scopes resolve.** `category_rule.account_id` (which rows a rule governs), `recurring_series.account_id`
  (which rows a series owns), `amazon_funding_map.funding_account_id` and `amazon_account_id`, and
  `import_batch_account.account_id` (dedupe coverage, through `duplicate_detection.scope_id_for`).
- **Specific references stay raw**, and a merge is meant to change what they select.
  `account_tag.account_id` attaches a tag to one account row, so a merged child's tags lie dormant and
  return on detach. `account_pair_distinct` asserts something about two account rows, and a merge
  deletes the row. `connection_account` and `csv_import_profile` name a write target, where a merged
  child is a legitimate destination because its rows roll up through the row side.

`backend/tests/test_account_group_references.py` derives every foreign key into `account(id)` from the
schema and fails until a new one is classified. Filter behavior is pinned in
`backend/tests/test_merged_account_filters.py`.

Repointing a stored id is correct in one place, `reassign_account_references`
(`services/account_references.py`), where the account row is about to be deleted and the merge can no
longer be reversed.

### Removing an account

`txn.account_id` is `NOT NULL`, so removing an account has two possible outcomes for its transactions:
they move to an account the user names (`transactions=reassign&target_account_id=…`) or they are deleted
with it (`transactions=delete`). The parameter is required once the account holds any row, so history
is never destroyed implicitly. An empty account is removed without a question.

- **Deletion does not go through the transaction trash**, because a trashed row still carries the
  `account_id` that is about to stop existing.
- **Both outcomes are permanent.** After a reassignment nothing distinguishes the moved rows from those
  already on the target, so an undo would need a per-row record of what moved, the unbounded
  accumulation `scale-and-limits.md` rules out.
- **What follows the transactions is declared.** `services/account_references.py` holds one row per
  foreign key into `account(id)` with a disposition for each removal path: `FOLLOW` (re-point at the
  account taking the history), `CLEAR`, `DELETE_ROW`, `CASCADE`, `CALLER`, `STRUCTURAL`. Both paths
  derive their statements from it, so a reference with no disposition is a test failure
  (`tests/test_account_reference_disposition.py`).
- **`recurring_series.account_id` follows.** Its foreign key is `ON DELETE SET NULL`, and a NULL account
  scope means every account, so leaving it to the key would widen a one-card series to the whole ledger.
- **`amazon_funding_map` follows.** Its foreign key cascades, which would delete the instrument mapping
  for the history being moved.
- **A connection's mapping is released, not moved**: `connection_account.account_id`,
  `target_account_id` and `mapping_mode` are cleared. `account.external_account_id` is `UNIQUE`, so
  re-pointing would feed an account the user never mapped. The mode is cleared with the target because
  a mode with no target reads as decided while `apply_account_mapping` skips it.
- **A group root refuses removal** until its children are removed or ungrouped. Removing a root means
  promoting a member, which moves the group's dedupe scope and reverses the merge's duplicate
  promotions; that is a separate decision from where the transactions go.

`account.trashed_at` is vestigial. Nothing sets it; migration 64 cleared it, and that step replays
after a restore because an older backup can carry trashed accounts. The column stays because every
backup carries it, and the read paths that filter on it are left in place.

### Distinct-pair assertions

Three sparse tables record that two things the system would pair are different. Each stores its pair
canonically (`*_low < *_high`), cascades with either side, and rides the data backup.

- **`suspect_pair_distinct`**: "these two rows are not the same charge". Written by *Keep* on a
  soft-flag suspect. `resolve_suspect` records the pair before clearing the `suspect_duplicate_of`
  pointer that names it. Both dedupe sweeps skip a recorded pair. It carries `flagged_txn_id` and
  `reason` so an undo (`POST /accounts/duplicate-pairs/reopen`) restores the original finding instead
  of re-deriving one under matching rules that may have changed. It says nothing about the accounts.
- **`account_pair_distinct`**: "these two accounts are different physical accounts". Written only by an
  explicit answer to the account question (see
  [Are these two accounts the same account?](#are-these-two-accounts-the-same-account)). The sweep
  skips every pair of rows across the two accounts. A merge deletes the row, since it contradicts it.
- **`amazon_charge_distinct`**: "these two charges are distinct purchases", from *Not duplicates* on the
  Amazon reconciliation report. The unaccounted grouping will not chain an asserted pair, and an
  order-anchored duplicate bucket is skipped only when every pair in the group is asserted. A re-import
  that adds a new copy forms new, unasserted pairs.

## Transactions

`txn` is the central fact table.

### Amount and sign

`amount > 0` is money out; `amount < 0` is money in.

`parse_amount` is the one parser behind both the import and the mapping preview (`architecture.md` →
*Preview contract*). A cell carries at most one of two direction signals, and they point opposite ways:

- a **bare sign** is in the file's convention (positive is money in) and is inverted for storage, so
  `-50.00` and `(50.00)` are debits
- a **`DR` / `CR` suffix** names the direction outright and is read as written. It wins over a sign, and
  in a two-column file it overrides the column it sits in

Otherwise the column supplies the direction and the cell's own sign reverses it, so a negative
debit-column cell is a refund. A two-column row blank on both sides is `0.0`, which is a real amount.

A third shape states the direction in its own column (`column_map.direction`, with the amount unsigned).
There the column is the only signal read: a `DR` / `CR` suffix in the amount cell does not override it,
since a file carrying both has already said which way it means.

### Dates

`date` is when the charge was made, the transaction date, wherever the source gives one, and the posted
date otherwise. Every list, report and total uses it, because it is the day a charge is remembered by
and the month it belongs in.

`posted_date` is when the charge settled. It is nullable and set only where the source supplies a
posting distinct from an undifferentiated date; a CSV with one date column leaves it NULL. It exists for
duplicate detection: two sources routinely date one charge on different bases, so every date test in
the ladder asks whether either date applies.

- A posted timestamp of `0` from a provider is read as absent. SimpleFIN's protocol makes the field
  mandatory, so a pending row carries `0` there.
- When a pending row settles, the sync fills `posted_date` and re-stamps the provider-owned fields.
- A row with neither date is dropped at the adapter. Dating it from the import time or the window bound
  would be indistinguishable from a real date.

### Hand-entered rows

A transaction can be entered by hand (`POST /transactions`). What makes it behave like every other row
is its provenance:

- no `import_batch_id` and no `external_transaction_id`, since it belongs to no ingestion event
- `content_hash` from the importers' own `make_hash`, which is how a later import or sync of the same
  charge recognizes it. A second hash implementation would never match
- an uncategorized entry is run through the rules, as an imported row is
- the owner follows the account
- `needs_review = 0`, since the person who would review it just typed it

### Editing amount and date

An amount is editable in place (`PATCH /transactions/{id}/amount`) only on a hand-entered row that is
neither split nor part of a reimbursement.

- **Not a row from a source.** A synced row's amount is re-stamped whenever the provider revises it,
  and `content_hash` digests the amount, so an edit would stop the row matching its own file.
- **Not a split or a reimbursement.** A split's allocations are checked against the amount only when
  the split is saved. A claim is checked against the receivable when it is made, and the edits that
  could move the receivable afterwards are refused separately (see
  [Reimbursement records](#reimbursement-records)); an amount is refused outright here, because unlike a
  reallocation it is never legitimately corrected downward past a claim.

The edit restamps the hash, re-runs the rules (a category set by hand stays), and triggers a recurring
rescan.

`date` is editable through the bulk editor, which restamps the hash too. A marketplace row is the
exception: its hash is computed from the order id and cannot be rebuilt from the row's fields, so it
keeps the stale one, which still matches its file.

### Category provenance

- `category_source` records where the current category came from: `manual`, `import` (a category
  present in the file), `rule`, `cleared`, `enrichment`, `split`, `refund`, or NULL.
- `category_overridden = 1` means automatic categorization must leave the category alone. It is set for
  `manual` and `split` only.

What each source allows is in
[How an existing transaction's category can change](#how-an-existing-transactions-category-can-change).

### Name fields

- `raw_name`: the literal imported or provider-supplied text
- `merchant_name`: the cleaned name, when the source or a rule supplies one
- `display_name`: the name the row shows
- `display_name_source`: `manual` (a deliberate rename), `rule` (a rule's `clean_name`), `import`, or
  `enrichment` (filled from a richer source by enrich-on-import). NULL is treated as not manual

Automatic name-setting never overwrites `manual`; only the explicit full-force rule apply may.
`recategorize_all` leaves a manual name alone while still recategorizing the row.

A paper-check row whose file carries a separate check-number column gets `"Check #<n>"` folded into
`merchant_name` and `display_name`. `raw_name` and `content_hash` are untouched, so duplicate detection
is unaffected.

### import_evidence_json

A compact subset of the original source row. It feeds cross-source duplicate detection,
`match_source_text` rules, the ledger search, and the transaction detail's Origin block. The ledger
search's SQL reads `description.value` and `extra_text_fields[].value` directly, so a change of shape
moves that query too.

- **CSV** keeps the source account and description labels plus up to `MAX_IMPORT_EVIDENCE_TEXT_FIELDS`
  further columns whose headers match a keyword list of descriptive free text (memo, note, reference,
  payee, counterparty and similar). Identifier and figure columns are left out because they would add
  noise to the text matcher that reads the same fields. `column_map.evidence_columns`, when present, is
  authoritative.
- **A connection** writes the same shape but selects by declaration (`ProviderAdapter.capture_fields()`):
  an adapter knows its fields by name, where a CSV header is a guess. The account slot carries the
  provider account label and the description slot the provider's original description, which is what
  lets a synced row be a terminal-window candidate.
- Each `extra_text_fields` entry may carry `role: "categorical"`; see
  [Evidence field roles](#evidence-field-roles).

### needs_review

`needs_review = 1` marks a freshly imported or synced row nobody has looked over. It is workflow state,
independent of categorization: a rule-categorized row can need review, and a reviewed row can be
uncategorized.

- **Set** on every import and sync insert unless the row's owner has flagging off. Hand-entered rows
  start at `0`.
- **Cleared** by a manual category edit (the actions that write `category_source = 'manual'`), by
  saving a split or a reimbursement's allocations — the row has plainly been looked at — or by an
  explicit mark-reviewed, per row or over a whole import card. Automatic categorization never clears it.
- **Set back on by hand only**, through the bulk editor's *Review status*, which is the one writer that
  raises the flag after arrival.
- **`owner.flag_new_for_review`** (default on, read through `services/review_flagging.py`) is per owner
  because the flag is written at ingest, where a sync has no user to ask but every row has an owner. A
  row with no owner is always flagged.
- **It governs arrival only.** Each run reads the owners that have it off once, before its insert loop.
  Changing the switch, or an account's owner, rewrites no stored row.
- The merge-time duplicate scan keeps a reviewed row over an unreviewed one, and a row that arrived
  unflagged counts as reviewed.

### Pending rows

A pending transaction appears in lists and is left out of summary totals. A list requested with `view`
(spending, income, cash flow) is the set behind a figure, so it drops pending rows and
excluded-from-totals categories too.

### Trash and duplicate resolution

`trashed_at IS NOT NULL` soft-deletes a row. Every read path filters it out; the row stays in `txn`
until the trash is emptied.

Every move into or out of the trash goes through `trash_txns` / `restore_txns`
(`services/txn_trash.py`), because a move changes what recurring detection reads and so owes a rescan
(see *When a scan runs*). A flow that also records why a row left writes its dedupe provenance beside the
move. A move skips rows already in the target state, so trashing again keeps the original `trashed_at`.

**`suspect_duplicate_of`, `suspect_duplicate_reason`, `suspect_resolved_at`** carry the soft-duplicate
flag (see [Soft duplicates](#soft-duplicates)).

- The reason is `cross_account` (texts identical, punctuation aside), `cross_account_fuzzy` (a
  near-miss) or `cross_account_weak` (shared distinctive tokens). The last two are
  `REVIEW_ONLY_SOFT_FLAG_REASONS` and are never auto-confirmed.
- The reason records the account relationship that created the flag. The relationship a report states
  is derived at read time from the effective roots then in force (`_IN_ACCOUNT_RULE_KEYS`), so a merge
  or a detach re-describes every flag with no backfill. The tier is not re-derived, since a merge does
  not change the evidence about two rows.
- A flag is resolved by **keep** (clears the flag on that row), **reject** (trashes the incoming row) or
  **replace** (the incoming row survives and the matched row is removed). None of the three says
  anything about the accounts.
- On **replace** the surviving row keeps its own category only when its file is the sole one with
  `use_imported_categories` set. Otherwise it takes the existing row's category as a manual override,
  and never copies a NULL.
- Resolving a row that already carries `suspect_resolved_at` succeeds, because a bulk action issues one
  request per row and asserting a pair distinct clears every flag between it. A row with neither field
  was never a suspect, and an action on it is an error.

**`rejection_reason`** says why a trashed row left the ledger. NULL is ordinary trash.
`'duplicate_confirmed'` means a soft-flag suspect was accepted as a real duplicate. The pointer in
`suspect_duplicate_of` is kept as the record of which row was canonical.

**`dedupe_resolved_by`** says who confirmed it:

| value | meaning | undone by |
| --- | --- | --- |
| `user` | decided in the duplicate report (a Reject, or the row a Replace removed) | *Undo reject* in the report |
| `auto_merge` | `promote_in_group_suspects_to_confirmed`, as a side effect of an account merge | detaching the accounts |
| `auto_cross_source` | the same sweep, for an exact match between two sources on **one** account. Kept apart from `auto_merge` because no detach can separate rows that share an account | the duplicate report, as for `user` (`REPORT_RESTORABLE_RESOLUTIONS`) |
| `amazon_merge` | Amazon reconciliation *Merge → keep one*; `suspect_duplicate_of` names the survivor | restoring from Trash |
| `amazon_discard` | a per-copy *Discard* on the reconciliation report; no survivor pointer | restoring from Trash |

- **Settings → Trash and empty-trash exclude confirmed duplicates**, except the two Amazon values. Those
  rows belong to their file's duplicate report, and deleting them from Trash would remove the restore
  path. The Amazon removals were deliberate deletions, so they stay in Trash and restore from there
  (`POST /transactions/{id}/restore` clears the dedupe tags).
- The row-level *Trash* on an unaccounted Amazon charge is not tagged: it means "not in my ledger at
  all", which is an ordinary delete.
- **Clearing a card's duplicate report hands its confirmed duplicates to the Trash.** `rejection_reason`
  and `dedupe_resolved_by` are cleared in the same write, because the report was where those rows were
  restorable from. `auto_merge` rows are not released; their undo is a detach.
- **Deleting the canonical row restores every copy that deferred to it**, whatever the marker says. A
  confirmed duplicate is a statement about a pair, and the deletion removes its referent. The copy
  returns as an ordinary transaction with its dedupe tags cleared. `undo_batches`
  (`import_export/core.py`) does this for a file's Undo, a re-import replace, and the removal of a
  connection's synced data, and it reads `suspect_duplicate_of` before the sweep that clears dangling
  pointers. A detach, by contrast, leaves the canonical row in place and restores `auto_merge` only.
- A row hard-rejected at import (`import_batch_duplicate`) was never inserted, so nothing restores it;
  *Import anyway* on its card is the path.

## Categories

### Two levels

Categories are **groups** (top level) and **leaf categories** (children), for example the group
`Food & Drink` with leaves `Groceries` and `Dining Out`.

- **A transaction is assigned only to a leaf.** The assignment endpoints reject a group id, imports
  resolve a file label to a leaf (creating one under `Unassigned` if none matches), and seed rules look
  up leaves only. A group is a reporting rollup.
- **The two levels are enforced at the API.** A parent must be an active top-level group, a group that
  holds categories cannot be placed inside another, and nothing can be placed inside itself. Requiring
  every parent to be top-level rules out depth and cycles together. A move that would break the shape
  is refused.
- **Names are unique within a kind** after trimming and case-folding. A leaf and a group may share a
  name, because the only path that resolves a bare name to an assignable category looks at leaves.

### What a group carries

- **`category_type`**: `expense` or `income`. A leaf's type is its group's: moving a leaf rewrites its
  type, retyping a group carries every leaf with it (inactive ones included), and a leaf cannot be given
  its own. A leaf may hold NULL and inherit. This is what keeps a group's total equal to the sum of its
  slices (see [Reporting assumptions](#reporting-assumptions)).
- **`exclude_from_totals`**: removes the group and its leaves from charts and totals. It is `NOT NULL`,
  so a parent always wins `COALESCE(parent.exclude_from_totals, leaf.exclude_from_totals, 0)`.
- **`sort_order`**: the order shared by the Categories page and the pickers. A new group joins its
  section alphabetically unless the user has reordered it.

Colour is derived in the UI from stable ids and names; none is stored. Categories and groups have no
`owner_id`. Dimensions such as personal/shared or essential/discretionary are tags, attached to a group,
a leaf or a transaction through `category_tag` / `txn_tag`.

### System groups

- **`Unassigned`** holds categories an import created that the user has not yet placed. It takes part in
  filters and reports, cannot be renamed or deleted, and may be hidden while empty.
- **`Transfers`** (`system_key`, excluded) is where the app files money movement of its own: the Amazon
  importer's matched card charge, wallet funding legs. Its `exclude_from_totals` is the user's to
  clear, since nothing computes against it.
- **`Reimbursable`** (`system_key = 'reimbursable'`, excluded) holds money owed back. Its exclusion is
  locked (see [Reimbursable expenses](#reimbursable-expenses)).

A keyed group is resolved by key before name, so a rename cannot lose it, and it cannot be deleted or
moved inside another group. Every lookup requires `parent_id IS NULL`, so a reparented group would make
the next write create a second one.

### Seeding

A new data database is seeded with the group skeleton only: the top-level groups with their type and
exclusion, plus the system groups. It gets no leaves and no rules. Starter leaves and rules are added on
request through `POST /categories/generate-starter`, which is idempotent, and by the demo dataset.

Groups ship because the import's *Group Imported Categories* workspace needs buckets to drop labels
into. Leaves and rules do not, so that a user bringing their own categories has no taxonomy and no
data-mutating rules imposed. The built-in rules target leaves by name, so withholding the leaves
withholds the rules.

### Lifecycle flags

A category carries `is_active` (default 1), `set_aside` (default 0) and `import_pending` (default 0).

- **`import_pending = 1`** marks a label waiting in the *Group Imported Categories* workspace, which
  shows only active `Unassigned` leaves with the flag. Import sets it when it creates a leaf for a
  label. It is cleared when the category is placed in a group or deleted, and is never set again, so a
  user-created or recovered category under `Unassigned` does not appear in the workspace.
- **`set_aside = 1`** parks a pending label out of the "still needs sorting" pool. The category stays
  active, keeps its transactions, and future imports of the label still categorize to it.
- **`is_active = 0`** is a soft delete, and the only state that suppresses a label from future imports.

Deleting a **leaf**:

- rewrites the branch's transactions first (`_rewrite_branch_categorizations`). With no replacement they
  become uncategorized (`category_id`, `category_source` NULL, `category_overridden = 0`) and keep their
  `imported_category` text; with a replacement they move to it. An inactive category is therefore
  referenced by no live transaction
- **rewrites the split allocations too, and they are the row's categorization.** A part filed in the
  branch follows the replacement, or is left naming nothing, which the expansion seam already reads as
  uncategorized; the row stays split, because its allocations exist nowhere else. A split row's own
  `category_id` is the stashed prior rather than a categorization, so that value is repointed while
  `category_source = 'split'` and its lock bit stay as they are
- clears `import_pending` and keeps `parent_id`, which is how reactivation returns it to its group
- deletes every rule that targets it; the categorizer also skips any rule whose target is inactive
- removes it from `GET /categories` and `/categories/flat`; it appears in `GET /categories/inactive`

**Whether a category is in use is one question** (`_categories_referenced_by_transactions`), asked by
the delete preview, the usage summary and the empty sweep alike. It reads the expansion seam as well as
`txn.category_id`, because a split's money is filed in `txn_split` and the column holds only the prior.
Both columns are `ON DELETE SET NULL`, so a reader that misses the allocations reports a category as
unused and the removal then moves that money to *Uncategorized* with nothing on screen saying so.

Deleting a **group** removes the row outright, since a group is a container and not an import label.
Its leaves are deactivated like any leaf, and their `parent_id` is nulled by the foreign key, so they
reactivate under `Unassigned`.

**Reactivation** sets `is_active = 1`, clears `set_aside`, leaves `import_pending = 0`, and restores the
leaf to its former group when that group is still an active top-level group, else to `Unassigned`. It
does not recategorize the transactions the deletion cleared.

**Permanent delete** (`DELETE /categories/{id}/forever`) accepts only an inactive category, which is
what makes it safe: nothing references one. It refuses anyway while a split allocation still names the
branch — the state the delete above no longer produces, so reaching it means a backup predating that
rewrite, and the foreign key would otherwise null the allocation. Afterwards the label is no longer
suppressed, so a future import creates a fresh pending leaf.

**Empty cleanup** (`POST /categories/empty-cleanup`) removes, outright, every active non-system leaf
that is not import-pending and that no transaction (trashed or not, allocations included) and no rule
references, then every non-system group left without children. The set is recomputed server-side. It
removes rather than deactivates, so a leaf it misread as empty would be destroyed instead of parked.

**Undo of an import** removes only still-pending leaves that import created.

### Filter exclusion ("is not")

The shared transaction filter accepts each facet (account, group, category, owner, payee, tag,
attribute) as an include set and an exclude set (`exclude_*` parameters). It feeds the list, the bulk
"select all matching" resolver, every `/transactions/summary/*` endpoint and the CSV export.

- **Combination.** Within a facet, include ids OR and exclude ids AND; across facets everything ANDs.
- **Exclusion is the NULL-safe negation of the same membership expression the include path builds**:
  `COALESCE((membership), 0) = 0`. A bare `NOT IN` is SQL-unknown for a NULL category and would drop
  every uncategorized row from "not Groceries". The invariant is that a row the include set does not
  match survives that facet's exclusion.
- **Excluding a synthetic bucket is the inverse.** Excluding *Uncategorized* is `category IS NOT NULL`
  (sign-scoped for the expense and income buckets); excluding the owner `unassigned` bucket removes the
  NULL-owner rows, since that is the set the user named.
- **The tag facet's membership is an `EXISTS`** (`effective_tag_match_sql` in
  `services/transaction_tags.py`): the tag is direct, or inherited from the leaf, its group or the
  effective account, and is not blocked on the row. `EXISTS` is never NULL, so exclusion is a plain
  `NOT`. A row tagged only through its account is therefore excluded by "not that tag".
- **Untagged** (`UNTAGGED_FILTER_ID`) is the rows with no effective tag at all. Real ids and the bucket
  OR within the facet (`tag_filter_membership_sql`).
- **`require_all_tag_ids`** is a separate AND constraint ("has all of these",
  `effective_tag_match_all_sql`) that applies alongside the OR `tag_ids`. The tag-report drill uses it
  to scope rows to an exact signature. The app-wide filter bar does not offer it.
- The frontend carries `mode: 'include' | 'exclude'` on each selection and splits selections by type and
  mode (`ui-patterns.md` → *Pickers and filters*).

### One facet registry, both halves

`services/transaction_facets.py` declares each facet once: a `Facet` row (membership builder, the two
parameter names, negation, separator), a `TransactionFacets` dependency carrying the query parameters,
and `append_facets`, which walks the registry. `lib/filterParams.js` is the frontend counterpart.
Adding an axis is a row in each.

The registry exists because an endpoint that has not learned a facet does not fail; it answers
unfiltered, and a total stops matching the list it drills into.

- `_BULK_FILTER_KEYS` on the bulk endpoint is built from `FACET_PARAM_NAMES`. A facet missing there
  would widen the set a bulk action resolves past the count on screen.
- `tests/test_transaction_facets.py` asserts every faceted endpoint accepts every facet.
- **A facet may be named in more than one way, and the ways OR.** The payee facet takes whole names
  (`payees`) and fragments (`payee_contains`) as variants of one facet, because two facets would AND.
  The fragment is compared against the name the row shows, so a row is never returned for a raw
  descriptor it does not display. `GET /transactions/payee-names` lists the names a fragment selects.
- **The CSV export takes the list feed's whole filter, row source and order**
  (`transaction_list_filters`, `transaction_list_scope` in `routers/transactions.py`), so the file holds
  the rows on screen. `tests/test_export_matches_ledger.py` asserts the dependency names every filter
  the list accepts.

### Attributes — filtering by what a row is

The other facets ask what a transaction is filed under. The attribute facet
(`services/transaction_attributes.py`, `attribute_ids` / `exclude_attribute_ids`) asks what it is:
carries an attachment, belongs to a recurring series, has money owed back, needs review. The vocabulary
is the row's own marker strip, so reading a row and filtering for it use the same words.

- **A relationship is one attribute covering both sides.** `reimbursable` holds the expense and the
  repayment; `refund` holds the payment and the money that came back.
- **`purchase`** is labelled *Multi-payment purchase*, because splits and multi-payment purchases are
  the pair `mechanism-index.md` records as confused, and "payments" is the word that separates them.
- **`from-connection` and `from-file`** are provenance. The discriminator is
  `external_transaction_id`: it is present on every synced row and never written by a file importer, so
  both predicates stay on `txn` with no join. The file predicate excludes the provider id instead of
  asking for a batch, because a synced row has an `import_batch_id` too. A hand-entered row matches
  neither.
- **Keys are plain words** (`attachment`, `needs-review`) and double as the `?only=<key>` deep link.
- **Every predicate is NULL-free**, so "is not X" returns every row that is not X.
- **An unknown key is ignored; an unknown parameter is a 400.** A stale key from an old link narrows to
  what it can still express, as a deleted tag id does.
- **`in_filter_bar`** marks `uncategorized` as absent from the filter bar, because the Categories tab
  already offers that bucket. The ledger's quick filter and `?only=` links still use it.
- `GET /transactions/filter-attributes` serves the vocabulary with labels and descriptions, so the
  frontend holds no copy.
- **`require_all_attribute_ids`** is the AND counterpart, sent by the ledger's toolbar filter. Values
  within a facet OR, so folding the toolbar's key into `attribute_ids` would widen the result. It is not
  a facet and is named by hand in `_BULK_FILTER_KEYS`.

Recurring is an attribute and not a tag, because facets AND with each other: "Business" and "Recurring"
together must mean both.

## Rules

A rule (`category_rule`) matches transactions by merchant text and optional scopes, and assigns a
category, a rename (`clean_name`), tags, a recurring series, or any combination.

### The matcher

- **Merchant text** is a set of **alternatives**, at least one of which must appear, then **filters**,
  every one of which must also appear: `(alt₁ or alt₂) and f₁ and f₂`, each a case-insensitive
  `contains`, in any order. It is how one rule claims the several descriptors one payee arrives under.
  A plain rule is a single `keyword`. Filters alone are stored as
  `{"op":"and","clauses":[{"type":"contains","text":"…"}]}`; with alternatives, as
  `{"op":"any_and","any":[…],"all":[…]}`. `MAX_MATCH_CLAUSES` caps each list.
- **The text matched is the names as they arrived**: `merchant_name` and `raw_name`
  (`categorizer.name_match_text`), plus the import evidence for a `match_source_text` rule. Never
  `display_name`, which holds what a rule's `clean_name` or the user last wrote: matching it would let
  one rule match another's output, so a second categorization pass would not see what the first saw,
  and a rename meant for one rule could hand the row to an unrelated rule with a longer keyword. A
  rule-suggestion keyword is taken from the same two names, so an accepted suggestion matches the rows
  it came from.
- **Every alternative gets the same filters.** "`alt₁` must also contain X but `alt₂` need not" is two
  different conditions, and belongs in two rules.
- **Canonical form**, owned by `build_match_expr`: each list is trimmed, lowercased, de-duplicated and
  sorted, and a single alternative folds into the filters, so two spellings of one matcher store one
  form and matcher identity cannot fork a duplicate. `match_expr` is NULL for a single-keyword rule.
  `keyword` is derived from every text (alternatives, then filters, space-joined) so it stays the search
  target. `merchant_matcher` parses a stored matcher, and every match site uses
  `merchant_matcher_matches`.
- **An alternatives matcher carries no `clauses` key, so a build that predates it fails closed.** Such a
  build reads only `clauses`, finds none, and falls back to `keyword`, which as one joined substring
  matches essentially nothing. Storing the filters under `clauses` would instead have it fire on the
  filters alone, far more broadly than the rule was written.
- **`match_source_text`** (default off) tests the text against the row's captured import free text as
  well: the `import_evidence_json` description slot and extra fields, not the account label. The
  per-row evidence parse runs only when the rule set holds at least one such rule. Import and sync both
  pass the evidence at insert, so the rule applies the same way whichever route a row arrived by.
- **Amount** conditions compare absolute values. **Direction** (debit or credit) is a separate scope
  applied through the sign.
- **Owner** scope, **account** scope (one account, resolved through its group), and **account type**
  scope (`account_type`), which matches every account whose effective account
  (`COALESCE(parent, self)`) has that type.
- The type scope is the account's type and not the batch's `source_kind`, because a type applies to
  every row on the account, while `source_kind` is stamped only on batches imported after that field
  existed.

### One rule per matcher

A matcher is the keyword, the clause set, owner, account, account type, amount range, direction and the
`match_source_text` flag. At most one live rule exists per matcher, because duplicates would make
"which rule wins" depend on row order and leave one copy firing after the other is edited.

Saving a rule whose matcher exists is classified and reconciled:

- **duplicate** (adds nothing): reported, not written
- **mergeable** (adds a category or rename the existing rule lacks, or new tags): folded into the
  existing rule
- **conflict** (a category or rename that disagrees): reported for the user to resolve

`create_rule` and `update_rule` take `on_existing = reject` (classify and report, the default) or
`merge`. When an edit makes a rule collide with a different rule, the merge folds the edited rule into
the other and deletes the edited one. Tags still union across different matching rules.

### Precedence

Priority is computed, not curated. `categorizer.rule_specificity_order_sql` is the one definition, used
by the engine, by the preview and apply in `routers/rules`, and by the rules list.

1. **Scope**, in this order: an owner-scoped rule, then one pinned to a single account, then one
   covering an account type, then a global one.
2. **Text length**: `LENGTH(keyword)`. For a multi-clause rule that is the summed clause length, so a
   rule whose clauses are a superset of another's is always longer and wins where both match. An
   alternative widens a rule rather than narrowing it, so a rule with alternatives is as broad as its
   shortest one: its length is that alternative plus every filter, with the joined keyword's separators,
   which ranks it exactly as the AND rule of its shortest alternative. It is computed from `match_expr`
   in the ORDER BY rather than stored, so no write path can leave it stale.
3. **Amount span**: `COALESCE(amount_max, sentinel) − COALESCE(amount_min, 0)`. A range contained in
   another has the smaller span, so `>= 3000` beats `>= 300`. Counting bounds cannot distinguish them.
4. **Rule id**, so a tie is stable across a `VACUUM` or an index change.

Two ranges that overlap without one containing the other have no principled winner; that case is
reported, below.

### How matching rules combine

Matching does not stop at the first rule. Every rule is tested against every row, and every rule that
matches contributes (`categorizer.categorize_transaction`). Precedence picks a winner for each action
separately:

| Action | Comes from |
|---|---|
| Category | the first matching rule, in precedence order, that sets one |
| Rename | the first matching rule that sets one, which need not be the rule that set the category |
| Tags | every matching rule: they are added together |
| Recurring series | the first matching rule that is recurring, decided by the recurring scan; see *Rule-backed series* |

So which of two matching rules wins changes a row only where both set a category and the categories
differ, or both rename and the names differ. A category or rename only one of them sets applies either
way, and both rules' tags apply either way. Two recurring rules count the same way as two categories: a
row belongs to one series, so only the winner's series gets it. The rule checkup's test for this is
`rule_overlaps._outcomes_agree`.

Deleting a rule is a different question from which rule wins: its tags, rename and series go with it
even where it never decided anything, which is why the checkup offers a delete only when both rules
carry the same actions (`_actions_agree`).

### Rule checkup

- **Range drift** (`GET /rules/range-drift`, `services/rule_range_drift.py`). An amount range is a
  matching gate, so a bill that drifts past a bound loses the rule's category and its place in the
  rule's series with nothing else noticing. The finding is derived on read and shares the recurring
  signals' dismissal store (`services/signal_dismissals.py`). A row already carrying the rule's
  category is never reported, and a dismissal does not consume a rule's per-rule cap.
- **Widening is one transaction** (`POST /rules/{id}/widen`): the bound moves and the rule is applied
  together.
- **Overlaps** (`GET /rules/overlaps`, `services/rule_overlaps.py`). Four ways two rules contend. An
  **amount overlap** is two rules with the same matcher and the same scope whose ranges intersect with
  neither containing the other. A **matcher co-match** is two matchers that neither repeat nor contain
  each other, under the same scope, both matching a real transaction. A **matcher nesting** is one rule
  matching a subset of the other's rows, decided from the rules alone: its matcher sits inside the
  other's (every row it matches carries each of the outer one's filters and one of its alternatives) and
  its owner and account limits sit inside the other's. A **scope split** is a matcher inside another
  where the outer rule carries an owner or account limit the inner one lacks, so neither contains the
  other and the limit decides; it is reported only when a real transaction matches both and the two
  rules' outcomes differ. Which rule wins is read from `rule_specificity_order_sql`.
- **The co-match check reads the ledger; nothing else here does.** Whether two unrelated keywords ever
  land in one merchant name is a fact about the transactions, not about `category_rule`. It matters
  because precedence settles such a pair on text length, and that term stands for containment —
  between matchers that do not nest there is no subset relation for it to stand for, so it decides on
  nothing. See *Scale and limits* for the scan.
- **A pair whose winner changes nothing is information, not a warning.** `_outcomes_agree` applies
  *How matching rules combine*: where the two rules do not both set differing categories, do not both
  set differing renames, and are not both recurring, the finding is reported as `amount_overlap_benign`
  or `matcher_co_match_benign`. The split is by kind
  rather than severity because dismissibility is keyed on kind, and it rides in the finding key, so an
  acknowledgement lapses as soon as the two rules stop agreeing.
- **`removable_rule_id`** names a rule whose deletion changes no row, and is the only rule a finding
  offers to delete. It requires both rules to carry the same category, rename, tags and recurring flag
  (`_actions_agree`), which is stricter than the benign test. For a nesting pair it is the inner rule,
  when the outer one's amount range and direction also take every charge the inner one does. For a
  benign pair it is a rule whose every transaction the other rule also matches, read off the co-match
  scan's per-rule counts; that is a fact about the ledger so far, not about the rules.
- Containment is not a finding, since precedence resolves it. Bounds are inclusive, so two rules split
  at one value overlap on that value. Managed rules, trashed rules and rules targeting an inactive
  category are left out; so are pending and trashed transactions, as evidence.
- **`rule_overlap_dismissal`**, keyed by the finding's fingerprint, is the check's only stored answer.
  `rule_overlaps.DISMISSIBLE_KINDS` admits the kinds whose winner changes nothing — nestings and the two
  benign variants. A live amount overlap or co-match is settled only by the ordering's last terms:
  reproducibly, but on no basis that is about the two rules. The key carries the pair and the
  redundancy verdict, so a dismissal lapses when the situation changes. It is not a foreign key; a
  dismissal whose pair dissolves stops matching. It is shared across users and rides the data backup.
- **`rule_conflict`** (`services/rule_conflicts.py`) brings the two warnings forward to when the rules
  are applied, so they surface without the checkup being run. Every pass that applies rules (import,
  sync, Amazon order categorization, Run categorization, a rule's own apply) records the pairs it meets on
  a live, posted row not categorized by hand, judged by `rule_overlaps.conflict_kind`, the checkup's own
  test. One row per pair, ids sorted, carrying the newest transaction that showed it. It is a note, not a
  verdict: each read re-tests the pair against the current rules and that transaction and deletes what no
  longer holds, so an edit resolves it without another pass. The open count drives the `rule_conflict`
  task and the checkup button's badge; the task is dismissed by count, as every task is, while the pair
  itself cannot be acknowledged. Not backed up, since the next pass that meets a pair records it again.

### Rule hygiene columns

- **`last_effect_date`**: the newest transaction date the rule has applied a live effect to, kept as a
  forward-only maximum. It is the transaction's date, never wall-clock, so a re-run cannot drift it.
  Every apply site and the seed attribute a row through `effect_rule_ids` and `bump_rule_effect_dates`.
  A rule is credited for a row it wins even when an import or a manual edit holds that row's category;
  a rule that always loses to a more specific one reads as never used.
- **`deleted_at`**: the rules trash. The categorizer and the matcher-identity checks filter
  `deleted_at IS NULL`, so a trashed rule neither categorizes nor blocks re-creation of its matcher.
  Restore refuses with a 409 when a live rule now holds the matcher. A rule-backed series is dropped on
  trash and re-created on restore with its cadence reset to monthly.
- **`is_managed`**: 1 for rules the app maintains (the money-movement `Type` rules). Cleanup skips them.
- **Cleanup** (`POST /rules/cleanup`) trashes the reviewed set of live, unmanaged rules whose
  `last_effect_date` is older than a user-chosen window or NULL. Categorizations are left in place
  unless the user opts into a revert.

A rule must target an **active** category. Deleting a category deletes the rules pointing into it, and
the categorizer skips a rule whose target is inactive. A tag-only rule has no category and is
unaffected.

### How rules come into being

Three paths write `category_rule`, and all go through the matcher reconciliation above: turning a
manual categorization into a rule; *Generate rules*, which derives suggestions from rows that arrived
categorized by their file (see [Rule suggestions](#rule-suggestions)); and the opt-in starter rules.
Rules mutate transactions, so both bulk paths are reviewed per rule before anything is created.

### Concurrent writes

SQLite has no row versioning, so two writes to one field of one transaction are last-write-wins. Three
properties keep that narrow:

- edits are **field-scoped PATCHes** (`/category`, `/merchant`, `/notes`, `/tags`, `/uncategorize`), so
  two writers collide only on the same field
- a sync revision refreshes provider-owned fields and the content hash and leaves the user's category
  and name edits
- `category_overridden` keeps a manual categorization out of every automatic pass

What remains is two people writing the same field of the same row within seconds.

### How an existing transaction's category can change

`category_source` and `category_overridden` decide it:

| source | locked | who may change it |
| --- | --- | --- |
| `manual` | yes | another manual edit, or a full-force rule apply |
| `split` | yes | un-splitting only; no rule apply takes it |
| `rule` | no | any automatic pass |
| `import` | no | any automatic pass |
| `cleared` | no | any automatic pass |
| `enrichment` | no | the owning feature's reversal, or a full-force apply |
| `refund` | no | follows its payment; a manual edit or a full-force apply ends that |
| NULL | no | any automatic pass |

`enrichment`, `split` and `refund` are `FEATURE_OWNED_CATEGORY_SOURCES` (`services/categorizer.py`),
which every automatic pass skips by source.

- **A trusted import is not locked.** A rule beats a file's label at import, so a rule created later
  has to beat it too, or the ledger's categories would depend on which arrived first.
- **Every write-back of a stashed categorization derives the lock through `category_lock_for`.** Link
  priors, reimbursement completion records, undo snapshots and held duplicate payloads can predate the
  point where `import` stopped being locked, and restoring the bit verbatim would re-lock the row.
- **`enrichment`** marks a row a feature moved into an excluded category and joined to a `txn_link`
  that stashes its prior (an Amazon funding charge, a wallet funding leg, a PayPal pair). A rule
  reclaiming it would un-exclude the row and double-count the spend.
- **`split`**: the row's categorization is its `txn_split` allocations, and `category_id` is the stashed
  pre-split value. A full-force apply and a bulk category edit refuse a split row and report how many
  they declined, because the allocations exist nowhere else. `PATCH /transactions/{id}/category` and
  `PATCH /transactions/{id}/uncategorize` refuse outright — the second matters because it also resets
  `category_source` and the lock bit, which on a still-split row would take it out of
  `FEATURE_OWNED_CATEGORY_SOURCES` and hand the prior slot to the next automatic pass. A rule's rename
  and tags still apply.
- **`refund`**: the row carries its payment's category and a trigger moves it with the payment (see
  [Refunds](#refunds)). A category deletion rewrites it like any row and ends the following.
- **`cleared`** is a row whose file label the user discarded. It is rule-eligible and keeps its
  `imported_category` text, and it is skipped by the trust-flag re-derivation
  (`_set_batch_imported_category_usage`), which fills ordinary NULL rows. NULL alone could not carry
  that difference. `recategorize_all` keeps the marker when no rule matches.

The operations:

- **Run categorization** (`recategorize_all`) takes unlocked rows that are not feature-owned. It only
  sets or changes a category and rule tags; a `rule` row that now matches nothing keeps its category,
  so deleting or narrowing a rule does not un-categorize history. A matched `import` row becomes `rule`.
- **Reconcile** (`recategorize_all(retain_unmatched=False)`) clears a no-match `rule` row and removes
  its rule tags. It runs only over an explicit row set (`txn_ids`): one rule's matched rows on a rule
  delete or edit with `?reconcile=true`, or the *Money movement* leaf's rows when a type is removed. A
  cleared row falls back to what import would have given it with no rule in the way: its file label's
  category as `import` when its batch is trusted (through `adopt_file_categories`), else uncategorized.
  A no-match `import` row is left as it is.
- **Full-force apply** (`POST /rules/{id}/apply`) re-categorizes every match regardless of source,
  `manual` included, to `rule` and unlocked. An explicit apply is the user asking the rule to own those
  rows.
- **Preserve-manual apply** (`?preserve_manual=true`, or `_apply_rule_to_existing` over a row list)
  skips `manual`, `enrichment` and `refund` rows and reclaims `import` rows.
- **Manual edits** write `manual` and the lock.

### Tags

Tags are separate from the category tree. A transaction's **effective tags** are the union of these
sources, most specific first:

- **direct** (`txn_tag`): added by a matching rule (`rule_present`) or by hand (`manual_state = 1`)
- **category** (`category_tag` on the leaf)
- **group** (`category_tag` on the leaf's parent)
- **account** (`account_tag` on the effective account). A child account's own tags are not consulted
  while it is merged and apply again on detach. The Accounts page offers to copy a child's tags the
  parent lacks onto the parent at merge; those become the parent's own and a detach does not remove
  them.

`manual_state = -1` on a `txn_tag` row **blocks** that tag on that transaction whichever source would
contribute it. Blocks are keyed `(txn_id, tag_id)` and survive rule reruns; only the direct-rule
`clear_manual_blocks` path, which requires `rule_present`, clears one.
`get_visible_transaction_tag_map` applies blocks last, and `get_blocked_transaction_tag_map` reports
them.

Recategorizing a transaction changes its effective tags in a way no client can compute, so every
endpoint that moves a transaction between categories answers with the resolved `tags` and
`blocked_tags`. Tag filters and aggregations match on effective tags.

## Recurring series

A recurring series (`recurring_series`) is an obligation whose charges recur: a subscription, a bill, a
periodic tax. It is a record of its own because recurrence has structure a flag cannot hold: a cadence
(`weekly` … `annual`, with a canonical `period_days`), an expected amount band, a projected
`next_due_date` and a lifecycle. `txn.recurring_series_id` links a row to its series; it is a cache the
detector maintains.

Detection is `backend/services/recurring_detection.py`; the API is `backend/routers/recurring.py`.

### Identity and grouping

- **The detection key is (payee, category, sign).** One payee can bill several things, and category is
  what separates them. Within a group, amount clustering separates same-category series, and a cluster
  must be amount-tight so a coincidental subset of noise does not pass as a series.
- **Both readings of a group are computed.** Two monthly charges a fortnight apart interleave into a
  plausible biweekly series, so the split by price point is preferred when the whole-set reading is
  amount-incoherent, the split explains at least as many charges, and each price point has a rhythm.
- **The payee is the name the row shows**, `display_name` first, then normalized (lower-cased,
  punctuation to spaces, trailing store numbers and domain endings dropped). A rename or a rule's
  `clean_name` therefore groups a vendor's spellings.
- **`payee_key` is derived**, rebuilt from the current members' names on every full scan, so a
  normalization change cannot strand a series. It comes from the members and not the editable label.
- **The label** is a rule-authored name if the members have one, else the most common name still
  appearing recently, else the newest member's. A user rename persists and does not affect matching.
- **Timing regularity is the primary signal.** A high-volume irregular payee scores itself out through
  gap variance, with no name blocklist.

### Amount

`amount_mode` is `variable` (the default) or `fixed`. A `variable` series ignores amount when matching,
because a bill recurs on schedule while its amount moves. A `fixed` series matches only charges inside
its band. The detector sets `fixed` only where a group resolved into more than one series and this one
sits at a single price point, since there the amount is all that tells them apart. Rule-backed and
manually created series are always `variable`; for a rule-backed one the rule owns the amount gate.

- **Every amount gate has a grace band**, narrower than the jump the detector splits price points on, so
  a price rise still matches and can be reported, and the gate cannot re-merge a split pair.
- **`amount_min` / `amount_max` are derived**: rewritten by every scan from the rows the series owns.
- **`expected_min` / `expected_max` are pinned by the user**, never rewritten, and win when set.
  Pinning marks the series user-owned.
- **A band is extended to take in a new price, never moved onto it.** Membership is re-derived from the
  whole ledger on every scan, so a band relocated to the new amount stops matching the series' own
  history. *Accept new amount* moves only the bound the charge falls outside, and is offered only on a
  `fixed` series; on a `variable` one the band gates nothing.
- **The sign is applied before the bounds are ordered.** The band editor works in magnitudes, and
  negating swaps which bound is lower.

### Membership

- **A transaction belongs to at most one series, and `occurrence_count` equals the linked-row count.**
  User-owned series claim in priority order (rule-backed first, then active before ended,
  account-scoped before account-agnostic, then confidence), each taking only unclaimed rows, and stats
  are written from exactly the rows owned.
- **An auto candidate is skipped when a user-owned series covers it**: same payee and category with an
  overlapping account scope, where NULL covers every account.
- **One charge per occurrence date.** When several share a date, the one closest to the series' typical
  amount is the member and the rest are left for other series. This is why there is no
  duplicated-charge signal: a real double charge is import dedupe's question.
- **`recurring_membership_override`** (`txn_id`, `series_id`, `state = 'excluded'`) keeps a matched row
  out of a series. It is its own table because membership is rebuilt each scan; `reconcile_series`
  subtracts exclusions before the one-per-date selection. Setting one confirms the series, so an auto
  series is not re-minted under a new id. Only `excluded` is written; a row that should belong and does
  not is corrected by fixing its name or the rule. `state = 'clear'` removes the override.
- The list feed carries `recurring_series_name`, `recurring_rule_id` and
  `recurring_excluded_series_id`, and the transactions filter accepts `recurring_excluded_series_id`.

### Curation and lifecycle

- **`source`, `confirmed`, `status`.** A scan rewrites `source='auto'`, `confirmed=0`,
  `status='active'` series wholesale. Manual (`source='manual'`), confirmed and suppressed series are
  user-owned and never overwritten. Confirm, suppress, edit, manual create, pin and exclude all make a
  series user-owned.
- **A candidate matching a user-owned identity is not proposed.** The identity is
  `(payee_key, category_id, account_id, price point)`. A component NULL on either side matches
  anything: category is derived from member rows, which keep being recategorized, so a decision made
  while the charges were uncategorized must still cover them afterwards. The price point is NULL for a
  `variable` series; with it, two price points of one payee are separate identities.
- **`suppressed`** means the detector was wrong. The series owns no transactions and persists so the
  candidate is not proposed again. `suppressed_member_ids` snapshots what it held before the links are
  dropped, because membership is a periodicity fit and cannot be re-derived by query. `restore` clears
  it.
- **`ended`** means the series was real and has stopped. It keeps its transactions, is left out of
  forecasts, and has its `next_due_date` frozen. A scan reactivates it when a charge lands on or after
  that date, so a resubscription revives the same record. Only the user sets it; the missed-charge
  signal offers it and never writes it.
- **`created_at` means first detected.** An auto series is deleted and re-inserted with a new id on
  every scan, so `scan_and_store` carries `created_at` across by the identity tuple
  `(payee_key, category_id, scope_account_id)`. Anything that must outlive a rebuild is keyed by that
  tuple, not the id.

### Rule-backed series

A rule with `is_recurring` set owns a series (`source='rule'`, `rule_id`, `confirmed=1`) whose
membership is the rule's matches, through the same predicate rule apply uses
(`categorizer.rule_matches_row`). `is_recurring` is a valid rule action on its own.

- **A scoped scan reconciles the rule-backed series only when something could have changed what one
  holds**, and then all of them, against the whole window, since their members can span payees. That is
  when an edited row is linked to one or its rule matches an edited row as it now stands
  (`_rule_series_touching`, recorded with the debt as `series:<id>`), or when one's rule differs from the
  one it was last reconciled against (`rule_fingerprint`, compared on every scan so a rule edit on any
  path is caught). Nothing else can move their rows, because they claim ahead of every other series
  whatever their status. Creating, editing or removing one relinks them all at once
  (`relink_rule_series`).
- **Suppress** and **delete** clear the rule's `is_recurring` and drop the series, deleting the rule if
  that leaves it with no action. **End** keeps the flag, so a resubscription can resume it.
- Deleting the rule, merging it away, or unchecking the flag drops the series.
- **Two rule-backed series can match one row, and rule precedence decides which holds it**, ahead of
  status, so the row's series and its category come from the same rule (`_reconcile_priority`, ranked by
  `rule_specificity_order_sql`). They are reconciled together, never one alone, because reconcile does
  not take a row from a series outside the set it is given.

### When a scan runs

`scan_and_store` takes an optional `payee_keys` scope.

- **Scoped**: a completed import or sync reprocesses only the payees it touched. It does not stamp the
  watermark and does not re-derive payee keys.
- **Every path that writes a category, merchant name, date, amount, trash state, new rows or removes
  rows owes the payees it touched a rescan** (`owe_recurring_rescan`). Trash moves owe through the trash
  helpers, and the two hard deletes (`delete_transactions`, `undo_batches`) owe before the rows go, since
  a payee is read off the row. A path whose effect no payee list can name owes a full one
  (`owe_full_recurring_scan`): a global recategorize, a transfer-pair answer, and a change to the
  account a row resolves to, since a series' account scope and the two sides of a movement are read
  through it. Regrouping goes through `set_account_parent` (`services/account_groups.py`), and a
  removal that reassigns transactions owes from `reassign_account_references`. The scope
  is the payees the rows belong to now plus those they belonged to before, so the caller reads the prior
  keys before it writes. A no-op edit owes nothing and a bulk edit owes once, because a scan loads the
  whole detection window before it filters by payee.
- **The debt is recorded inside the write's transaction and settled after it commits**
  (`settle_owed_rescans`), in a connection of its own. A scan held inside the write held the write lock
  for all of its reading. The debt row in `recurring_rescan_owed` is what makes the split safe: a scan
  that fails, or a process that stops before it runs, leaves the debt standing, and **every scan settles
  what is owed within its scope**, so the next one retries it. A failed settle never fails the write it
  follows. `generation` moves each time a payee is owed again, and a scan deletes only the generation it
  read, so a write that lands during a scan keeps its own debt.
- **An overdue debt** (older than `OWED_RESCAN_OVERDUE_MINUTES`) has lost its settling scan. App load
  settles it, and Tasks reports it, because the series, members and findings read off those payees are
  known to be stale until a scan runs. A younger debt is left to the scan already settling it. The table
  is derived state: not backed up, and wiped with the ledger.
- **A payee series holding a paired row is always in scope** (`_payee_keys_holding`), because a
  movement's two legs sit in different payee groups and an edit to one changes the other.
- **Full** (`run_auto_scan`): app load calls `maybe_auto_scan`, which runs a global scan when none has
  run or the last is older than about a day. `POST /sync/recategorize` triggers one directly, since it
  can rename payees across the ledger.
- The watermark is `db_meta.recurring_last_scan_at`, one per data database, because a database has one
  set of series whoever loads it first.

### Money movement and transfer pairs

A series whose category or group is `exclude_from_totals` is money movement. That is derived at read
time and shown as a badge.

A movement between two tracked accounts is **one series that owns both legs**
(`services/transfer_pairs.py`). `account_id` is the paying side, `counterpart_account_id` the receiving
side, and `payee_key` is a synthetic `transfer:<from>:<to>`, because its identity is the two accounts
and the category.

- **Rows are paired first and scored second.** Two rows pair when they have the same absolute amount and
  category, on different accounts, in opposite directions, within `PAIR_WINDOW_DAYS`. Names are not
  consulted, because two institutions describe one movement differently and change their descriptors
  over time. A window is used because the two sides post on their own schedules. Resolution is
  nearest-date-first across the whole pool, so the result does not depend on row order.
- **Only money-movement categories pair.** Same-amount opposite rows in counted categories are
  coincidences.
- **A movement is all-or-nothing.** Its occurrences are pairs, so a movement that cannot have all its
  rows is not inserted.
- **The pair takes its rows from a payee series.** `scan_and_store` passes paired rows to
  `reconcile_series` as `reserved`. Nothing is deleted: a confirmed payee series keeps the charges it
  holds outside the payment.
- **A rule-backed series wins over a pair.** `_rule_backed_holdings` is read before the reconcile, and a
  movement touching one of those rows defers whole.
- **A tie is asked** (`GET /recurring/transfer-review`): two same-day, same-amount candidates.
  `transfer_pair_decision` stores the answer (`receiving_txn_id`, or NULL for a dismissal), and
  `pair_money_movements` applies stored answers before it infers anything.
- **A paired row is never payee material**, even when its pairs score no rhythm.
  `detect_transfer_series` returns every paired row id, and the payee pass runs over the pool without
  them.
- The transfer pass reads every money-movement row in the window even on a scoped scan.

Two obstacles, both tracked in [`backlog/recurring-detection.md`](backlog/recurring-detection.md):

- **Recency is measured in periods, which biases a stale series' cadence long.** `_score` discards a
  reading whose last charge is more than three periods old, after the cadence is proposed, so a longer
  proposed period passes more easily. Confirmation then freezes the cadence:
  `_write_series_stats` never rewrites `cadence` / `period_days`.
- **A pair that is not a series is shown nowhere.** Pairing is derived per scan and not stored, so no
  other surface can ask whether a row is half of a transfer.

### Signals

Upcoming, missed, new series and price change are derived on read (`services/recurring_signals.py`) and
not stored.

- **A price change is measured against the occurrences before the latest charge.** The stored band
  cannot detect one, because the scan has already widened it to include the new charge. Tightness is
  judged over the whole prior history and the range over the recent window, so a seasonal bill is not
  read as fixed-price. A step the previous occurrence already made is not reported again.
- **Excluding the charge a price-change finding names can raise the previous step in its place**, since
  that step was hidden only by the newer charge.
- **A dismissal on a `variable` series widens the range later charges are compared against**
  (`_load_accepted_amounts`), to the dismissed amount and no further. It is derived by joining the
  dismissals, so restoring one narrows the range again. It does not apply to a `fixed` series.
- **A one-off dismissal** (`recurring_signal_dismissal.one_off`) leaves the charge in the series and out
  of the history later charges are judged against (`_load_one_off_charges`). It is accepted only for
  the price-change kind.
- **Lateness is measured against data freshness.** "Now" for a missed charge is the newest live
  transaction on the series' account (the ledger's newest for an account-agnostic series), never later
  than today, so a month without an import raises nothing.
- **`presumed_ended`** is a reading derived once a series has missed `_PRESUMED_ENDED_PERIODS` whole
  periods. It changes what the signal offers and writes no status.

`recurring_signal_dismissal` is the signals' only stored state. It is keyed by each signal's
fingerprint (a transaction id, or a series identity tuple plus a date) and not by series id. It has no
foreign key; a dismissal whose subject is trashed stops matching. It is shared across users and is per
finding.

## Import batches and profiles

- **`csv_import_profile`** is a saved data source: the mapping and settings for a recurring file format.
- **`import_batch`** is one import run, the unit a file's Undo removes. A connection's syncs write
  batches too (see [Sync import cards](#sync-import-cards)).

### What a batch counts

Five of these are `import_batch` columns; the other two are figures the card derives, and the
difference matters because only the columns record something the ledger cannot be asked again. The
columns are `row_count`, `skipped_count`, `deduped_count`, `ignored_count` and `updated_count`.

- **`skipped_count`**: every row the import refused for a reason other than duplication — a parse
  failure, another currency, a zero amount, or an account set to Skip.
- **`deduped_count`**: rows refused as duplicates that the batch's duplicate report can show. It is left
  out of the card's duplicates figure once `detail_cleared_at` is set, since the count's contract
  (`removed_duplicate_count`) is that it never names a row the report cannot show.
- **`ignored_count`**: rows turned away as this source restating its own earlier import, which is what
  an overlapping re-export mostly is. They are counted and not written to the duplicate report
  (`is_settled_source_restatement`, `prune_source_restatements`), because the transaction each
  duplicates is already the record and storing them dominated the report's size. It is kept apart
  from `deduped_count` so that count's contract holds.
- **`updated_count`**: rows that corrected a transaction already held. The corrected row does not say it
  moved, so the card is the only record.
- **`row_count`**: rows received — **the sum of all five populations**: imported, skipped, deduped,
  ignored and updated. The four that added nothing to the ledger are still rows the file offered, and
  leaving the ignored and updated ones out is what made a file of thousands of already-held rows read
  as a handful.

Two more are derived rather than stored, and are reported through `config_snapshot.import_summary`:

- **`imported_count`**: rows inserted. Recounted from the ledger on every history load
  (`refresh_batch_totals`), so it falls as rows are hard-deleted while the stored counters stay put.
- **`rejected_count`**: the part of `skipped_count` refused on the row's own content — zero-amount,
  another currency, a parse failure — leaving out the rows dropped for belonging to a skipped account
  (`account_skipped_count`). It is what the card's *Not imported* view totals (see
  [Rejected rows](#rejected-rows)), and being inside `skipped_count` it is inside `row_count` too.

`refresh_batch_totals` re-derives `row_count` and every headline summary figure from one set of parts,
so the card's row count and its summary cannot contradict each other.

A row counts as a **restatement** when all of these hold:

- the claim is Rule 1: this source's own coverage of this source account
- the source account is identified by a non-empty label, or by the same data source having filed onto
  the same account. `import_batch_account` records which account a source's rows were filed on per
  batch, and that does not change afterwards, so it identifies the source account when an aggregator
  renames it or a single-account file never names it. Rule 1 marks such a claim
  `covered.same_source_account`. Both the data source and the account must match
- the rejection is not one of `ADVISORY_REVIEW_SUBSTATES` (a covered date that paired with nothing, or
  paired only two days out). That list is shared with the card's "to review" count

A row the id rung recognizes with an equal amount is a restatement on the source's word (see
[`source_transaction_id`](#source_transaction_id)). A row that enriched its match keeps its record,
since the record is how the enrichment is undone; pruning therefore runs after auto-enrich. Until the
report is written `deduped` includes these rows, so a wholly restated file does not trip the
empty-batch delete and lose its `file_content_hash`.

Two single-account files on one account are covered like any other pairing: by Rule 1 under one data
source, by Rule 2 otherwise.

### Clearing a card's stored detail

`detail_cleared_at` marks a batch whose duplicate report was cleared (Settings → *Import storage*). The
report holds, per refused row, the raw values, the matched transaction and the payload that would have
been inserted, and is the largest thing the import history stores. Everything else stays, because each
part is read elsewhere:

- the `import_batch` row: `txn.import_batch_id` is `ON DELETE SET NULL`, and its presence is how the
  ledger knows a row was not entered by hand
- `file_content_hash` and `status`: together they are the re-import guard, which is why the marker is
  its own column and not a `status` value
- `import_batch_account`: its `coverage_*` columns are the claim duplicate detection reads
- `config_snapshot`: a PayPal statement finds its account by reading earlier statements' snapshots

### What a batch covers

`covers_start`, `covers_end` and `covers_source` are the span of transaction dates the file carried,
which the import history orders and groups by. They are written with the batch, because coverage is a
property of the file: trashing one of its rows later does not change what the file contained.

- `'statement'`: a declared period, which wins where one exists
- `'rows'`: read from the batch's transactions and its deduplicated rows together, since a file whose
  every row matched an earlier import still covers those dates
- `'items'`: a marketplace items-only card, dated by its parked items

`import_batch_rejected_row` is not a source, because it is capped.

### Zero-amount rows

Whether a `$0.00` row is kept is declared by the source and read through `rejects_zero_amount`:
`zero_amount_rows` on a `ProviderAdapter`, and the registry in `services/source_capabilities.py` for the
CSV and Amazon importers. There is no default; an undeclared source fails.

A `$0` row is usually a pending placeholder. It is kept only where refusing it would lose the
settlement: where the provider later revises the row in place, keyed on an id the ledger holds only if
the placeholder was inserted.

| source | policy | reason |
| --- | --- | --- |
| Plaid | keep | a settling charge arrives only as a `modified` revision of the row it names |
| SimpleFIN | reject | no change feed; the settled charge arrives as an ordinary row. It sometimes reuses the placeholder's id, so the already-held branch of `_insert_added` re-stamps provider fields |
| CSV, PayPal | reject | the settled charge is a row in a later file |
| Amazon | keep | a `$0` order is a finished record (gift card, promotion) |

A refusal is recorded as kind `zero_amount`, counted in `rejected_count`, and listed on the card. A sync
card records it through `config_snapshot.import_summary`, the key and shape CSV import writes, and
accumulates the counts across the month's syncs. The connector checklist is in
`docs/building-a-connector.md`.

### Duplicate detection at import

Detection blocks only rows that match transactions already in the ledger before the import starts.
Duplicate rows within one file are allowed.

- **Exact content hash** is the highest-confidence rule and is unconditional.
- **The ladder** (`backend/services/duplicate_detection.py`) then applies coverage, terminal-window and
  text rules within the same effective account scope.
- **Confidence decides whether a signal may hard-reject.** It does not decide the label: when several
  hard-reject rules apply, the broadest reason is reported, so a re-imported range reads as one reason.
- **The coverage, terminal-window and text rules hard-reject only when the receiving account itself
  appeared in the prior coverage**, or is an alias of one (a `connection_account` mapped `existing`). A
  new sibling account that only inherits its group's coverage passes to the soft-duplicate review,
  because the earlier import did not contain that account's transactions.
- **A connection's own coverage is excluded when that connection is ingesting.** A sync delta inside
  its own covered range is a late-posting charge; the claim was "everything the provider has told us is
  here", not "nothing more will arrive". Coverage from other sources applies to a sync unchanged.

### Soft duplicates

After a batch finalizes, and after each sync writes to its card, `mark_import_suspects` compares every
new row against existing rows from a **different source**: same amount, matching source text, dates
within `CROSS_ACCOUNT_DATE_WINDOW_DAYS`. A match is flagged through the `suspect_duplicate_*` columns,
never blocked.

- **The gate is differing origin**: a different connection, or a different file when neither row came
  from a connection. Landing on different accounts also suffices. One source does not report a charge
  twice, so two rows from one source are a real repeat.
- **A hand-entered row has no origin** and never pairs within its own account.
- **Same-batch rows on different accounts are distinct**; the file's account column says so.
- **Text is the union of each row's captured texts** (`source_match_texts`): `merchant_name`,
  `raw_name`, and the descriptive evidence fields. `display_name` is left out, so a rename neither hides
  nor creates a match.
- **Tiers.** Identical text (after the comparison's normalization) is `cross_account`; a character
  similarity at or above `CROSS_ACCOUNT_FUZZY_RATIO` is `cross_account_fuzzy`; at least
  `_WEAK_SHARED_TOKEN_FLOOR` shared distinctive tokens is `cross_account_weak`.
- **When both rows carry precise text** (`raw_name` or a descriptive evidence field), the tier is
  decided on that text and the cleaned payee name alone can reach no higher than weak
  (`row_match_texts`). A chain cleans every branch to one merchant string.
- **A differing explicit check number vetoes a match.**
- **Skipped**: pairs in `suspect_pair_distinct`, account pairs in `account_pair_distinct`, rows that
  already carry a suspect pointer, and rows the source gave different ids.
- The window is wide because two sources date a charge on different bases; the text comparison is what
  rejects coincidences inside it.

`promote_in_group_suspects_to_confirmed` runs at import finalize, after a sync, and on an account merge.
It confirms exact matches whose two sides share a group (`auto_merge`) or an account
(`auto_cross_source`), so import order and merge order give the same result.

An account merge also runs `scan_scope_for_cross_account_duplicates` over the group first, because
import-time detection compares only incoming rows against existing ones. A single account is a valid
scope. The canonical row is the reviewed one over a `needs_review` one, then the earliest import, then
the id; a row already carrying a suspect pointer is never canonical.

**A matcher change re-examines stored rows once.** `DUPLICATE_DETECTION_VERSION` is bumped with any
change that could alter a verdict on stored rows. App load compares it with a `db_meta` stamp and runs
the existing-versus-existing scan over every account (`maybe_rescan_for_detection_change`). A missing
stamp reads as "never examined", so **`init_db` stamps a fresh database** (`stamp_detection_version`):
one holds no stored rows, and without it every first app load opened a write transaction to reach that
conclusion. The stamp is the version and not a "done" flag, so a later bump still re-examines
everything; an upgraded database is deliberately left unstamped, because it has rows that predate the
stamp.
`rescan_until_settled` loops to a fixed cap, because each row takes one partner per pass. It is not the
schema version: a threshold change needs no migration. A flag already raised keeps its tier.

### Evidence field roles

Each `import_evidence_json.extra_text_fields` entry is **descriptive** (free text that names the
charge) or **categorical** (a small repeated vocabulary, or a structured datum such as a date, a check
number or an opaque id). Only descriptive fields feed duplicate text matching, through
`evidence_field_feeds_text_match` (`backend/services/import_evidence.py`).

- Only `categorical` is stamped; an unmarked field is descriptive.
- CSV import infers the role from the column's cardinality across the file.
- `build_sync_evidence` stamps each field by declaration, which leaves `Counterparty` as the only
  sync-captured extra that takes part.

A categorical value two unrelated rows share would otherwise match as identical text, which is the
auto-confirming tier.

### Are these two accounts the same account?

A set of cross-account flags between one pair of accounts is one question. It is asked at mapping time
(the "Possible duplicate account?" chooser, where *Keep separate* passes `distinct_from_account_id`)
and in the duplicate report (`unresolved_account_pairs`, with `can_merge` decided server-side).

- **Different accounts** (`record_account_pair_distinct`) clears every unresolved flag between the pair,
  whatever its tier, because the assertion also suppresses future detection.
- **Same account** (a merge) auto-confirms only exact matches. A near-miss inside one account may be two
  real transactions.
- A pair of an account with itself is refused; it would switch detection off for that account.

Assertions are listed and reversible (`GET` / `POST` / `DELETE /accounts/distinct-pairs`). Forgetting
one re-enables checking and does not revisit row decisions.

### external_transaction_id

`txn.external_transaction_id` is the provider's id for a synced row; NULL for file and hand-entered
rows. A sync that re-fetches a row it holds finds it here, which makes an overlapping pull harmless.

The column is `UNIQUE` and the sync lookups query it unscoped, so an id must be unique across the
ledger. Each adapter stores ids under a prefix: `plaid:<id>`, and `simplefin:<account>:<bank id>`
because SimpleFIN ids are unique only within an account. A new adapter namespaces by account if its
provider's guarantee is per account. A regression shows as `added == skipped` with one account empty
(`test_two_accounts_issuing_the_same_transaction_ids_both_import`).

### source_transaction_id

`txn.source_transaction_id` is the id a file source gave a row (`column_map.transaction_id`; a
recognized PayPal file reads `Transaction ID` regardless). It is not unique and is matched only against
rows whose batch belongs to the importing source (`import_batch.profile_id`). The scope is read through
the batch, so it follows a file whose batch is assigned to another source. The mechanism is
`services/source_transaction_ids.py`.

- **A row's id was issued by the source of the batch it belongs to.** The pending-to-posted conversion,
  which re-homes a row, gives it the incoming id or keeps only an id the same source issued.
- **The id rung runs ahead of the ladder.** A row whose id the source already holds is that
  transaction: an equal amount restates (`ignored_count`), a held pending row converts in place, and a
  changed amount corrects the held row in place (`updated_count`).
- **Different ids refute a pairing.** A held row the source gave a different id is withheld from every
  rung, tier and sweep that would name it (`refuted` on `evaluate_duplicate`). A counterpart on another
  account is not refuted; it is a different record.
- **An id-less row takes an id when the ladder pairs it one-to-one with an incoming row of the same
  source.** A row with no id never clears or rewrites one, so files with and without the column can be
  imported in any order.
- The scope is the data source, so files from one provider split across two sources share no ids.
  Assigning one source's batches to the other brings them into one scope.

### Sync state on a connection

- **`transactions_cursor`** is an opaque resume token. A provider with no change feed stores its own
  checkpoint there (SimpleFIN keeps a JSON walk position).
- **`provider_request_budget`** holds what a metered provider has spent. It is separate because the two
  persist under opposite rules: a resume token rolls back with a failed pull, and spending cannot. It is
  passed to the adapter as a mutable record and written back in a `finally`. A "N per day, replenished"
  limit is a refilling bucket, and separate allowances per request shape are metered separately.
- **Each page is applied and committed before the next is fetched**, so no write transaction is held
  across a provider call. **Removals accumulate and are applied after the drain**, because a
  pending-to-posted pair can straddle a page boundary and every `added` must be applied before any
  `removed`.
- **`sync_progress`** is the per-page checkpoint, cleared when the run ends.
- **A pending row converts in place** when it posts, matched on the provider's
  `pending_transaction_id`, so the user's category, name and tags stay. The CSV path does the same on
  account, date and source text, and depends on `ColumnMap` carrying the `pending` column to
  `parse_pending_flag`.
- **`initial_sync_complete`** records that the historical pull finished. "Nothing more right now" and
  "history is complete" are separate adapter signals (`resume_later`, `backfill_complete`): a metered
  provider can stop mid-backfill, and marking it complete would strand the unfetched history.
- **`full_history`** on a pull, not the depth requested, distinguishes a deepening pull from a routine
  top-up. Only a full-history pull may widen coverage backward or re-walk history.
- **Sync health.** `last_synced_at` is the last successful pull. `last_sync_error` /
  `last_sync_error_at` hold the latest failure and are cleared by a success.
  `consecutive_sync_failures` resets on success. `last_sync_warnings` holds problems reported by a pull
  that succeeded (one bank of several needing re-authentication) and is replaced each pull.
- **`last_sync_outcome` / `last_sync_summary`** are computed at sync time by `sync_outcome` and written
  with the log row from the same facts (`_record_connection_last_sync`). A walk that stopped on the
  request budget is `incomplete`.
- **`last_sync_summary.row_ids`** lists the rows the last pull added or revised, and `cards` the cards
  they landed on. Past `_SCOPED_SYNC_ROW_CAP` the list is dropped whole, since a partial list would
  misstate its extent. `list_connections` publishes a count (`scoped_rows`) and not the ids, because
  that endpoint is polled during a sync. The transactions filter `sync_connection_id` expands the list
  in SQL. A missing summary, list or connection yields zero rows. The set is replaced every pull.

### Three stores describe a sync

Which store a fact belongs in is decided by who may lose it.

- **Connection status**: `connection` and `connection_account`. Durable, and shaped by the provider.
- **Diagnostic history**: `connection_sync_log`. Pruned by age on every write
  (`connections.log_retention_days`, a shared preference) and clearable from the UI, so nothing
  user-facing may derive from it. It is left out of the data backup.
- **The transactions received**: `import_batch`, `import_batch_account`, `import_batch_duplicate` and
  `config_snapshot.import_summary`. These behave like a CSV import card.

The log (`services/connection_log.py`) holds one row per provider operation, named by `event`: `sync`,
`connect`, `reconnect`, `refresh_accounts`, `disconnect`, `reissue`, `revoke`. It records the
provider's answer, not the app's own pre-flight refusals.

- `connection_id` is nullable with no foreign key, because a failed connect has no connection and a
  disconnect's row must outlive the connection it removed.
- A row snapshots the level of anything the next sync overwrites (`request_allowance`, the `pool` each
  requested window was charged to, each account's `reached` / `history_complete`), since the live
  columns no longer hold it.
- `update_status` distinguishes `BUDGET_PAUSED` (this client declined to ask) from `RATE_LIMITED` (the
  server refused).
- `warnings` are problems the user can act on and mirror the connection card; `advisories`
  (`{message, count, context}`) are remarks nobody can act on. The message is the aggregation key.
- The cursor is stored as a fingerprint, never whole: a length and prefix for an opaque token, the short
  scalars for a JSON checkpoint.
- The columns `skipped_no_account` / `skipped_already_held` are vestigial; the buckets live in
  `account_counts` and are summed on read (`_skipped_breakdown`).

**`skipped` on a sync is four separate events**, counted per provider account in `account_counts`:
`skipped_by_choice` (mapped `skip`), `skipped_unknown_account` (no mapping yet), `skipped_already_held`
(the top-up's overlap) and `skipped_zero_amount`. `attention` is raised only for
`skipped_held_by_other_connection`: rows whose card belongs to a different, still-existing connection,
which is what a transaction-id collision looks like. An unmapped account is already reported by the
"N to map" badge.

### Sync import cards

A connection's batches have `source_kind = 'connection_sync'`, carry `connection_id`, and store the
connection's `provider` key so a card still names its provider after the connection is removed.

- **The first backfill lands on one card** (`resolve_initial_sync_batch`,
  `config_snapshot.initial_backfill`), reused across the polling calls of that pull.
- **After `initial_sync_complete`, rows land on monthly cards** (`resolve_sync_period_batch`,
  `sync_period = 'YYYY-MM'`) keyed on each row's own transaction date, so one fetch may write to
  several cards.
- **A card's date span is not a coverage claim.** Coverage lives on `connection_account`.
- **A row is filed once.** A later revision that moves its date does not move it between cards, so a
  reviewed card's contents do not change underneath the review.
- **A card is created on the first row the pull has something to report**: an inserted row, a
  zero-amount refusal, or a row dropped for lack of a local account. An already-held row creates none.
- **There is no per-card Undo.** The cursor has moved past the rows, so a re-sync would not bring them
  back. `DELETE /connections/{id}/synced-transactions` removes a connection's synced data, deletes its
  cards, and resets `transactions_cursor`, `initial_sync_complete` and coverage. The cards are deleted
  and not left `undone`, because both resolvers key on (connection, period) regardless of status and
  would reuse a tombstone the history filters out.
- **A sync card emptied by another route is deleted** when it recomputes to nothing and holds no
  duplicate report (`refresh_batch_totals`). A CSV card in that state is kept, since it records a file
  the user supplied.

**`import_batch_account` on a sync card:**

- `csv_value` is the provider account label, `"{provider_name} ···{mask}"` (`provider_account_label`),
  not the provider id. The per-account breakdown, the ladder's source-scoped rules, and the
  terminal-window matcher (through `import_evidence_json.account.value`) all key on it.
- A source account whose rows had no local destination gets a row with `was_skipped = 1` and its count,
  the shape CSV writes for an unmapped value. `row_count` is rows seen for the pair.
- On update, `account_id` is COALESCEd, so a later sync's dropped rows cannot erase a recorded
  destination, and `was_skipped` is MINed, so one landed row clears it for good.
- No coverage columns are written.
- A mapped account that received nothing has no row.

**A card's counts stay consistent after rows leave the ledger.** A hard delete of imported rows goes
through `delete_transactions` (`services/import_batch_totals.py`), which decrements the per-account
entry that counted each row (found by the source label in the row's evidence, not its current account)
and re-derives the batch columns and summary figures (`refresh_batch_totals`). An entry is decremented
and never removed, since it carries the coverage claim.

### Coverage has two shapes

- **A file** stores its trusted window and terminal date per source account label on
  `import_batch_account`.
- **A connection** stores `coverage_start_date` / `coverage_through_date` on `connection_account`. A
  cursor delta is a set of rows, not a date range, so only the chain of cursor plus
  `initial_sync_complete` can carry a claim.

`build_dedupe_context` reads the union of both.

- A range pull (initial backfill, *Fetch more history*) sets or extends `coverage_start_date`; a delta
  advances `coverage_through_date`; a failed sync advances nothing; a cursor reset clears both.
- **A range pull claims what it reached, per account.** The adapter reports `account_coverage`. The
  caller falls back to the requested depth only for an adapter that keeps no per-account coverage (a
  cursor provider). A walking adapter that reports an empty set reached nothing new. An overstated
  claim makes the ladder hard-reject real transactions.
- **A mapped account with no `coverage_start_date` joined after the history was fetched**, and the next
  history pull picks it up. `skip` accounts are excluded.
- **`history_complete`** means the account's history ran out, which coverage cannot say, and only it may
  stop a deeper request. `history_empty_streak` persists the two-empty-windows count across a paused
  walk. Both are per account. A new row starts at `0`.
- **A walking adapter's windows abut**, and only the window holding the pull's newest bound closes at
  the end of the day, since nothing else covers the rest of today.

### The terminal window

Coverage stops short of a source's last date, and the excluded days are reconciled one-to-one (Rule 5)
instead of rejected as covered, because most sources lag what they describe: an aggregator is waiting
on the bank.

- The covered range ends at the last date the source carries that is before
  `terminal_date - (terminal_window_days - 1)`.
- The setting is `csv_import_profile.terminal_window_days` for a file source and
  `connection_account.terminal_window_days` for a connection. The default is
  `DEFAULT_TERMINAL_WINDOW_DAYS`; `1` is the setting for a first-party source with no lag.
- The default is the wide one because the errors are not symmetric: too narrow rejects a real
  transaction, too wide costs one more reconciliation pass that still catches duplicates.
- A stated window below 1 clamps to 1; an absent or unreadable one takes the default.
- An upgraded database keeps `DEFAULT 1` in the column's DDL, so every insert path states the column.
- **A connection's candidate slots are derived from its own claim** (`coverage_through_date` and
  `terminal_window_days`), and are registered before the coverage computation returns for a connection
  whose range lies inside its own lag.
- **A source that does not outrun its own lag covers nothing.** Its rows still reconcile one-to-one.

**A revised amount is a correction** (`match_terminal_amount_revision`). Rule 5 pairs on exact hash,
then on amount; a row whose amount moved matches neither. The `(source, date, descriptor)` group is
reconciled as a set: equal amounts pair off first, and a lone leftover on each side is a revision. The
held row is updated in place (amount and `content_hash`), so the user's edits stay. It is same-source
only, and the row is not re-homed to the correcting batch, so undoing that import leaves the corrected
amount.

**Candidates shown for a coverage reject** (`_display_candidates`) are filtered after the verdict. A
candidate with no textual agreement is kept only while no other candidate has any, and the list is
ordered by tier and then date distance.

**Within one batch a worded same-day claim outranks a near-date guess at the same row**
(`release_contested_candidates`). A candidate is dropped from a row's list when another row of the
batch names it as its only match, in agreeing words, more strongly. A cross-account candidate is never
released, and a wordless claim releases nothing. Verdicts do not change.

**Enrichment refuses a row that states a different kind of transaction**
(`import_enrichment._conflicting_kind`): when both sides carry a captured `Type` and the kinds differ,
nothing is folded in.

### One ledger currency

`txn.amount` stores no denomination, so the ledger holds one currency, and which one is a setting:
`ledger_currency` in `import_workflow_state` (shared, because everyone reads the same numbers), read
through `services/ledger_currency.py`.

- **The test is "does this match the ledger".** Nothing outside `ledger_currency.py` compares against
  `DEFAULT_LEDGER_CURRENCY`.
- **Changing it converts nothing.** `PUT /api/currency` answers 409
  (`currency_change_needs_confirmation`) when the ledger holds transactions and the caller has not
  confirmed.
- **Adapters report mismatches at the level the provider states currency.** SimpleFIN states it per
  account, so a mismatched account is dropped whole. Plaid states it per transaction, so rows are
  filtered. Both report `unsupported_currency`, and `currency_scope` tells the sync layer which warning
  is true.
- **`connection_account.provider_currency`** is recorded at connect and refresh, before mapping. NULL
  means not stated and is accepted. An account with a stated other currency is excluded from
  `_build_account_targets`, since a target that can only be discarded would accumulate false coverage.
  The warning is driven by the stored currency.
- **A file states currency through an optional mapped column** (`column_map.currency`). A row naming
  another currency is refused (`kind: "currency"`, `currency_rejected_count`); a blank cell is taken to
  be the ledger's.

### Data sources

- A source's name is unique after trimming and case-folding.
- A source stores a default `use_imported_categories`. Each batch stores the choice that file actually
  used, with any owner or unassigned-account scope, because undo and review need the per-file decision.
- **`header_fingerprint` is the layout of the last file imported through the source.** A file is matched
  to a source by equality on it, so a completed import rewrites it (`run_import_parsed`); only a
  completed import shows the mapping still reads the file. A recognized source (PayPal) is matched on
  its kind and is excluded, since it serves two file shapes.
- The value is `ParsedFile.fingerprint`, with blank header cells dropped, for every caller.
- `column_map` also stores the per-value account map (`account_assignments`, `account_skips`,
  `account_new`), written by `autoSaveProfile` after each import.
- A per-user preference seeds whether new imports use file categories (`all`, `none`, `per_source`). It
  does not override a source's or a batch's setting.

### Categorization at import

Precedence is **mapping → rule → imported label → uncategorized**.

- An explicit per-label mapping from the review screen wins.
- A rule runs before the file's category. When a rule categorizes a row, the file label is not promoted
  into a category for it.
- The imported label is adopted, and its leaf created, only for rows nothing above claimed and only
  when the batch uses imported categories. It is matched against **leaf** categories only.
- A label matching an **inactive** leaf leaves the row uncategorized and creates nothing, which is what
  makes a deletion hold across re-imports. A set-aside label is still used.
- Labels that mean "uncategorized" (`Uncategorized`, `Unassigned` and similar) create no category.
- `imported_category` keeps the raw label on the row whichever category wins.
- A tag-only rule applies its tags and leaves the category to the label.

The same precedence governs the per-batch toggle after import and every later pass, so the order in
which a rule and a file arrived never decides the outcome. The flag is a bootstrap: file categories
fill rows the user's rules have not claimed.

A category created by a trusted batch keeps that batch's id while it is the category's only source, so
undo can remove it.

### Rule suggestions

Suggestions are generated from transactions whose category came from the file
(`category_source = 'import'`), plus manual rows that reinforce a category the file already showed for
that merchant. A category seen only through manual edits originates none.

When one merchant carries different imported categories, the rows form a **conflict set**. Two edits
are available on its rows:

- **Recategorize** (`PATCH /transactions/{id}/imported-category`) keeps `category_source = 'import'` and
  rewrites `imported_category`, so the row keeps feeding suggestions and a trust-flag re-derivation
  does not revert it.
- **Preserve** writes `manual`, and the row leaves the suggestions.

Resolving a conflict set derives each member's disposition from its target category:

| target | result |
| --- | --- |
| the winner's category | reclaimed to `rule` by the accept's scoped preserve-manual apply |
| another leaf, different from the row's imported category | `manual` at that leaf |
| the row's own imported category | left `import` |
| emptied | `cleared` |

With no winner, every member is settled to its target. Rejecting a suggestion
(`settle_rejected_suggestion_rows`) uses the same three outcomes and spares rows already `manual`.
Keeping a row as imported is not an override, so a later rule can still claim it.

**Accepting** applies the rule to the suggestion's own `source_row_ids` with a preserve-manual apply.
The accepted entry stores `rule_id`, `created_rule_id` when the review created the rule, and
`accepted_prior_rows`.

**Each review action is one transaction across rules, rows and review state**
(`routers/import_export/rule_suggestion_actions.py`), and answers with an undo payload holding the prior
review entries, the first-captured categorization of every row changed, and every rule created, edited
or folded away, snapshotted whole. Undo trashes a created rule. No route writes review state on its
own; `record_rule_suggestion_review` runs inside an action's transaction.

**A partition record makes an entry own its rows.** Most pending entries are regenerated from live rows
on every read. An entry with a `partition` record owns its `source_row_ids`, which are withheld from
generation while it is pending.

- **refined**: the matched subset of a card whose matcher was edited. A multi-member refined set's
  `conflict_group_id` names the seed suggestion.
- **remainder**: rows split away from another card. `origin_id` names the suggestion whose
  re-refinement or return to pending discards it, and `split_root_id` the card it renders beside.

A backup from before the records existed restores without them, and its pending refinements return to
ordinary generation.

| state | what owns the rows | rule | `source_row_ids` |
| --- | --- | --- | --- |
| pending, generated | nothing; rows stay `import` | none | recomputed every read |
| pending, refined | the stored entry | none | rows the refined matcher matched |
| pending, remainder | the stored entry | none | the leftover of a partial accept or a refinement |
| accepted | the rule | `rule_id` | rows the accept applied to |
| deferred (`skipped`) | unchanged | none | rows at deferral |
| discarded | `import`, `manual` or `cleared` | none | rows settled; `review_action` records the transition |
| trashed | review state only | untouched | kept for restore |

- `review_group_id` groups one merchant's suggestions for display. It is derived on read
  (`_assign_rule_suggestion_review_groups`) and not stored.
- `latest_txn_date` is the newest date among a suggestion's rows. The look-back preference
  (`ui.importRuleSuggestions.lookbackYears`) filters the view only; generation and the substance
  threshold use full history.
- Clearing a settled pile stores its entries as one restorable set. Clear and restore change no rule
  and no transaction.
- **A hard-deleted transaction leaves every review that names it**, in the delete's own transaction
  (`release_rule_suggestion_rows`, called by `delete_transactions`, `undo_batches` and the Amazon order
  removal). An entry left with no rows goes, with its decision: its count, report and undo all read
  those ids. A rule it created stays. Trashing a transaction is not a delete.

### Rejected rows

`import_batch_rejected_row` holds one row per refused line: the row as written plus the date,
description and amount parsed so far. An uploaded file cannot be re-read, so the stored rows are the
only answer to what a file left out.

- Every kind of refusal is recorded, including rows for an account set to Skip. Duplicates are not;
  they have their own table and report.
- The record is capped at `MAX_STORED_REJECTED_ROWS` and filled by `REJECTED_ROW_KIND_PRIORITY`, in
  which a parse failure outranks a skipped account.
- Exact totals stay in `config_snapshot.import_summary`, and the report says when it holds fewer rows.
- A suspected footer is one row naming the range.
- No file path is stored. A watched source's directory belongs to the source, not the batch.

## Watched import folders

A data source may name a directory on the server (`csv_import_profile.watch_dir`); a CSV appearing
there is imported unattended. The mechanism is in `architecture.md` → *Import / export*.

**`watch_dir` and `watch_enabled` are separate.** A restore from another instance clears the switch and
keeps the path, so the person can see what the folder was. Clearing the path clears the switch.

**The scan never creates or guesses an account**, because an invented account splits a ledger in a way
nothing later reports, while every other mistake is visible on the file's card. A file is parked when

- any non-empty account value is unmapped, or maps to an account that no longer exists
- the source's map has an `account_new` entry for a value in the file
- the source has no account column and no `account_id`, or would create its single account
- the source's `header_fingerprint` differs from the file's
- the source has no completed batch yet, so every source proves its mapping on one hand import

The interactive flow's fallback to an exact name match is not used here, since nobody is present to
approve it. A blank account cell is not an unmapped account; the import refuses that row and records it.

**A marketplace source** (`source_kind = 'marketplace:amazon'`) watches a folder the same way, and
parks on the same principle with its own list: the file is not an Amazon export, the source names no
Amazon account or one that no longer exists, the source has no completed batch yet, or any paying card
in the file has no funding account mapped. The last is the counterpart of an unmapped account value —
resolving it wrong moves a charge into the wrong account quietly.

**`import_watch_file` is a cache**: `(size, mtime)` per file plus the reason a file is waiting. It is
left out of backups because it describes a filesystem the restoring machine does not have. The durable
record of a file having been taken is `import_batch.file_content_hash` — or, for a marketplace card,
the hashes in its `config_snapshot`.

- A **parked** file is retried on every scan, since its fix happens in the ledger.
- A file whose **import raised** is not retried until it changes or someone opens it by hand, because
  the cause is unknown.

**Purging deletes only a file the app can still prove it imported**: a row names it, and its stored
content hash is re-checked against the disk immediately before the delete. The cost of that capability
is in `security-model.md` → *Reading and deleting outside the data directory*.

## Transaction links and Amazon order import

### The link primitive

`txn_link` groups transactions under a `kind`. Each `txn_link_member` row carries a `role`. A link has
an optional `external_ref` (the outside entity it stands for) and a `metadata_json` blob for
kind-specific data.

- **A link is pure association.** Creating or deleting one never changes the linked transactions. The
  feature that owns a kind makes any change and records the prior state in `metadata_json` so it can
  reverse it.
- **A member row cascades with either endpoint; a link row has no foreign key to `txn`.** The owning
  feature and the wipe path delete stale links explicitly.
- Both tables ride the data backup. Writes to `txn_link` bump `recon_epoch`, which invalidates the
  cached reconciliation attention counts.
- `get_link` returns `metadata` already parsed into a dict.

| kind | roles | what the owner changes |
| --- | --- | --- |
| `amazon_order` | `order`, `charge` | the charge moves to the excluded *Amazon Funding* leaf |
| `wallet_funding` | `leg`, `purchase` (or `refund`) | the leg moves to the excluded *Money movement* leaf |
| `paypal_funding` | `paypal`, `counterpart` | one or both rows are excluded (see [PayPal funding pairs](#paypal-funding-pairs)) |
| `paypal_funding_declined`, `paypal_funding_reviewed` | — | nothing; they record a decision |
| `refund` | `payment`, `refund` | the refund takes the payment's category (see [Refunds](#refunds)) |
| `purchase` | `payment` | nothing (see [Multi-payment purchases](#multi-payment-purchases)) |
| `reimbursement` | derived | nothing (see [Reimbursable expenses](#reimbursable-expenses)) |

### Amazon orders

Each order in an orders export becomes **one spending transaction** on a chosen Amazon account: amount
is net cash (`total − refund`), the memo is the order's item list, and the user's rules categorize it.
The matching card charge is moved to the excluded *Amazon Funding* leaf under `Transfers` and joined to
the order by an `amazon_order` link, whose `external_ref` is the order id.

- **The money counts once.** The order counts; its linked charge is excluded. Only a charge linked to
  an imported order is excluded, so Amazon spending with no imported order still counts.
- **An order may link several charges** (split shipments). Each charge's prior categorization is stashed
  in `metadata_json.charge_priors`, keyed by charge id; a singular `charge_prior` is still read.
- **The items file is enrichment, not rows.** Its per-item detail is folded into the order
  transaction's `import_evidence`, once. Amazon's own categories are not used.
- **Items with no imported order are parked** in `amazon_pending_item` (keyed by `order_id`, upserted,
  with `parked_batch_id` naming the import that parked them) and attached when the orders file arrives
  (`_take_parked_items`). A parked row is cleared when its parking import is undone. Attaching marks the
  row with the orders import that took it (`consumed_batch_id`) rather than deleting it, so undoing that
  import returns the items to waiting and importing the orders again re-attaches them. An items-only card
  whose items were all taken by one orders card is folded into it (`_merge_items_card_into_orders`), so
  importing the two files together or apart, in either order, ends in the same card; its parked rows go
  with it, since undoing that card undoes both files. One whose items went to two orders cards stays
  separate, so either can be undone back into it. A partly matched card's "no matching
  order" count is derived from the ledger (`unmatched_parked_order_count`).
- **An order funded only by points or gift-card balance** is recorded in the excluded category, since
  the export gives no cash figure. An order whose card is not tracked counts as the sole record.
- **Ingestion is keyed on the order id.** A re-imported order that has a link is `already_applied`; an
  items file for an order that already carries item detail is `already_enriched`.
- **Orders and charges converge in either order.** Every CSV import and sync runs
  `match_orders_after_ingest` over the rows it brought. It links an order only when the charge is its
  sole candidate and no other unmatched order wants that charge. A pending charge is not linked until
  it posts. It runs before PayPal pairing.
- **Unlinking is remembered.** `unlink_order_charges` records `declined_charge_ids` on the link, and no
  automatic pass offers those charges to that order again; linking one by hand clears it.
- **Undo restores the charge first.** The charge lives outside the batch, so batch undo and re-import
  replace restore each linked charge's prior and delete the link before deleting the batch's rows.
- The batch has `source_kind = 'marketplace:amazon'`. `config_snapshot` holds the `import_summary`,
  `amazon_file_hashes` and `amazon_account_id` — the Amazon account the card imported into, which the
  import history groups a vendor's cards by. It is recorded rather than derived from the card's rows,
  since an items-only card has none; cards predating it were backfilled from their rows (migration v80),
  and one with no rows to read stays unattributed. An upload whose hash matches a **completed** batch's
  file is skipped; an undone batch's files, and files with discarded rows, are not remembered.
- **A card may name a saved Amazon source** (`profile_id`), which holds the account, the categorize
  toggle, a filename pattern and a watched folder. The source is a `csv_import_profile` row marked
  `marketplace:amazon`; deleting it leaves its cards, which are the provenance of rows still in the
  ledger.

**The funding-source map** (`amazon_funding_map`) says which account an order's paying instrument
charges, because imported ledgers rarely carry card masks.

| row | meaning |
| --- | --- |
| `funding_account_id` set | **mapped**: the charge search is limited to that account |
| `funding_account_id` NULL | **untracked**: not an account the user holds; the order is the sole record |
| no row | **unmapped**: the last-4 disambiguates only among accounts that carry a mask |

`amazon_account_id` NULL is the global default; a value is an override for that Amazon account.
Resolution is override, then global, then last-4, then no match. A `$0` charge never matches, and the
search excludes the target Amazon account. The map rides the data backup; a mapping whose account does
not survive a restore is dropped, not turned into "untracked".

**Reconciliation** (`amazon_reconciliation(batch_id)`) reports per batch:

- **matched**: an order and the charges it excluded
- **duplicate**: an order with two or more same-amount candidate charges **on one effective account**,
  inside the matcher's own window. `mergeable` is set only when no other unmatched order shares the
  amount; otherwise the copies may be distinct purchases (`merge_duplicate_charges` checks the same
  condition). Copies spread across different accounts are never grouped here — they are distinct rows
- **duplicate_review**: the same shape, but the copies appear only in the wider review window, so their
  dates do not corroborate the way an in-window duplicate's do. Kept apart so each copy is looked at
  before a merge or discard
- **matched_review**: an unmatched order whose total is covered by a unique combination of unaccounted
  charges. Accepting links the set; dismissing stores `split_suggestion_dismissed` on the link
- **amazon_unmatched**: an order with no candidate charge. `no_charge_reviewed` on the link acknowledges
  it, and linking a charge clears the flag
- **payment_unmatched**: Amazon-looking charges on the cards Amazon uses, in the batch's date range,
  that no order links. `amazon_charge_reviewed` acknowledges one, and linking clears it
- **unaccounted_duplicate**: reverse-scan charges that look like copies of *each other* — same account
  and amount, dates close — with no order accounting for either. Carved out of `payment_unmatched`,
  because this is the double import the general dedupe cannot catch

`reconciliation_attention_count` is the four duplicate and review buckets whole, plus each
unacknowledged row of `amazon_unmatched` and `payment_unmatched`. It is cached as
`import_batch.recon_attention_count` against `recon_epoch`.

### Wallet funding legs

A wallet export (PayPal, Venmo) records one balance-funded purchase as two rows: the payment out and an
equal, opposite, nameless deposit into the balance. `suppress_batch_funding_legs`
(`services/money_movement.py`) pairs them within the batch and moves only the **leg** to the excluded
*Money movement* leaf, linking it to the purchase (`wallet_funding`) with the leg's prior stashed.

- **The structural signal is a nameless credit whose unique same-day equal-and-opposite twin is a named
  debit.** A named credit with no offsetting purchase is left alone, and so is a group with two
  same-amount rows on a side.
- **A captured `Type` corroborates and is not required.** An unrecognized `Type` on a suppressed leg is
  reported as `money_movement_unrecognized_types`.
- **A stated reference outranks the structure** (`_referenced_pairs`). A PayPal statement's deposit
  names the payment it paid for through `Ref ID`, so those pairs are taken as stated. Only a deposit
  `Type` can be a payment's leg this way; a refund refers to its payment the same way and is real money
  back.
- **A withdrawal equal and opposite to a refund it names is the refund's leg**, linked with the refund
  in the `refund` role. The refund itself stays paired with its payment.
- `reverse_batch_money_movement_links` runs in batch undo and re-import replace.

### PayPal source recognition

- A PayPal activity CSV is recognized by its header (`sniff_paypal_activity`). A recognized import
  attaches to the single system PayPal data source (`csv_import_profile.source_kind = 'source:paypal'`,
  `account_id` NULL), which cannot be deleted. A hand-made PayPal source is adopted on its next PayPal
  import. The batch is stamped `source:paypal`.
- **A monthly statement (PDF)** imports through the same source: `services/paypal_statement.py` reads it
  into rows under the CSV's column names. Only the document's first statement is read; the second
  repeats the rows that touched the balance.
- **A statement belongs to one PayPal account.** Its header names the PayPal account id; the first
  import ties that id to the chosen account group, and later statements are held to it. The tie is read
  from completed batches' `config_snapshot.statement`, so undoing those imports undoes it.
- **`Type`, `Item Title` and `Transaction ID` are always captured** (`_forced_evidence_headers`),
  whatever the user's capture choices, because money-movement handling and refund pairing read them.
  `Transaction ID` is declared categorical (`_PAYPAL_FORCED_CATEGORICAL`): a unique value would measure
  as descriptive and feed duplicate matching. A statement declares its `Ref ID`, `Transaction ID`,
  `Type` and funding bank categorical too.
- A statement row in another currency is refused, and so is a same-currency deposit or withdrawal whose
  `Ref ID` names one.
- **Money-movement `Type`s become rules the user approves.** Each approved type is a
  `match_source_text` rule to the *Money movement* leaf, scoped `account_type = 'paypal'` and
  `is_managed`. `is_money_movement_type` matches by fragment (deposit, withdrawal, currency conversion,
  hold) and only pre-checks the review. The review covers the source's types across all its imports
  (`money_movement_type_proposals_for_profile`), and applying runs `recategorize_all`.

### PayPal funding pairs

A tracked PayPal account holds the real transaction. What PayPal took from a card or bank, or sent back,
also appears on that other account, and counted in both places the purchase counts twice. After every
import and sync, `services/paypal_funding.py` pairs each PayPal row with the row on the other side of
the movement and links them (`paypal_funding`).

- **A transfer pair** (money into or out of PayPal) is movement on both sides, so both rows move to the
  *Money movement* leaf. A row already excluded is left where it is, and so is a split row, whose
  `category_id` is the stashed prior its parts replaced rather than a category it is filed under.
- **A payment pair** (a PayPal payment a card or bank paid directly) counts once. The PayPal row records
  what was bought, so the card row is excluded, unless the PayPal row is already excluded, in which case
  nothing changes.
- The card row is excluded only because its PayPal row is in the ledger. A blanket rule would drop
  spending for anyone not tracking the PayPal account.
- Changed rows get `category_source = 'enrichment'` and their priors are stashed on the link (`priors`).
- A PayPal row with no captured `Type` could be either kind; the candidate's sign settles it.

**A candidate** is a row on a non-PayPal account that reads as PayPal in its name, raw text or evidence,
with the same amount to the cent, within that module's `PAIR_WINDOW_DAYS`, on an account whose owner is
compatible (same owner, the shared owner, or none). Pending rows wait until they post. Split rows and
rows an Amazon order or wallet leg already claims are not offered.

**Only an unambiguous pairing applies itself**: a row with exactly one candidate no other row wants, or
a cluster of interchangeable rows where every assignment has the same effect. A row with a single
candidate claims it, which can leave another row with one uncontested candidate, so the rounds repeat
until one claims nothing. Two rows cornered on one candidate are a shortage, and both go to the user.

- **Decisions are links.** Unpairing writes `paypal_funding_declined`, so the pass does not repeat the
  pair; acknowledging a row with nothing to pair writes `paypal_funding_reviewed`. As link kinds they
  ride backups, cascade with their rows, and invalidate the attention cache.
- **The pass runs after ingestion and after each pair, unpair or decline** (`pair_after_decision`),
  never from a report read, because a decision can make another row unambiguous.
- **Reversal restores only what is still the pairing's.** Unpairing, or undoing either row's import
  (`reverse_batch_paypal_funding`), puts a category back only while the row still holds the category
  and source the pairing set.
- **A pair whose PayPal row was hard-deleted is healed at the start of the next pass**: the surviving
  row is restored and the link dropped.
- **Attention** counts each row with a choice of candidates, each contested bank or card row once, and
  each unreviewed row of the other kinds. It is cached in `db_meta` against `recon_epoch`
  (`services/reconciliation_attention.py`). `card_counts` gives per batch the rows its review lists.

### Refunds

Money back on a purchase offsets what was spent, and does so in the totals only when the refund sits in
the purchase's category. Where a source states which payment a refund returns,
`services/refund_links.py` pairs the two after each import (`refund`, roles `payment` / `refund`).

- **Only a stated reference pairs.** A PayPal statement's `Ref ID` is the payment's `Transaction ID`; a
  CSV refund says the same through the optional `Reference Txn ID` column. The refund must be on the
  same account group, in the other direction, for no more than was paid. A refund with no reference is
  an ordinary transaction. A reversal of a payment received pairs the same way.
- **The reference is the qualifying signal; a captured `Type` is only a veto.** Naming the transaction
  returned is the source saying what the row is, and most file sources carry no `Type` column to
  corroborate it with — so a word the PayPal vocabulary does not know ("Return" on a card export), or
  no `Type` at all, still pairs. A `Type` is read only to rule a row out, and only where it names a
  different mechanism: a deposit, withdrawal, currency conversion or hold references its counterpart in
  the same field and belongs to [wallet funding legs](#wallet-funding-legs), not here
  (`states_money_movement`).
- **The payment is looked up by the id under either name it is stored under.** A mapped
  `transaction_id` column lands in [`source_transaction_id`](#source_transaction_id); a source that
  force-captures the header (PayPal) also leaves `Transaction ID` among the evidence fields. A stated
  reference names the id without saying which, so both are indexed and the evidence value wins a
  collision.
- The pair may cross imports and arrive in either order.
- **The refund follows the payment's category.** It takes the category with `category_source = 'refund'`
  and `trg_refund_follows_payment` moves it whenever the payment's `category_id` changes. It is a
  trigger because a category is written from many places. While the payment is split the trigger does
  nothing, since a split payment's `category_id` is the stashed prior.
- **A refund categorized by hand is linked and not moved.** What the pairing changed is stashed as
  `refund_prior` and restored on undo only while the refund is still following.
- The list feed carries `refund_link` per row (`refund_map_for`). A category write answers with
  `followed_ids`, the refunds that moved with it (`ui-patterns.md` → *Transaction lists*).

A refund is not a [reimbursable expense](#reimbursable-expenses): nothing is owed back.

## Backups

A backup is always everything, in two parts, and the restore chooses which to put back. The **data** part
is the financial data and holds no secret. The **accounts** part is the identities, the perimeter, the
backup keys, and the data-source credentials as ciphertext with the vault slots that open them
(`services/accounts_backup.py`). The data part is the same layout the financial-data backup always had,
with the accounts members beside its sections.

A file's `kind` says what it holds: `full` for a backup written now, `data` for one from before the
accounts part, and `credentials` for the standalone credentials backup that preceded it. It is declared in
`meta.json` and, for an encrypted archive, in `manifest.json` outside the ciphertext, with
`credentials_included` and `exported_at`, so the restore can offer its choices and say how old the file is
before a private key is produced. A file
without the field is identified by the sections it carries. A standalone credentials file restores
through its own endpoint, which refuses every other kind by name, as the archive restore refuses it.

Secrets stay in the data database as ciphertext and keys stay in the control database. That separation
is why a leaked database does not leak tokens, and why the credentials and the vault have to travel as
one part: either half alone restores and never syncs.

### The data backup

It covers the whole data database, so a restore reproduces the working app and not only the ledger:
every table, the user's decisions and preferences included, plus each document file. The exceptions
are listed with their reasons in `backend/tests/test_backup_restore.py`: `EXCLUDED_TABLES` (among them
`connection_sync_log`, `import_watch_file`, the `document_fts` index, `db_meta`, and the credential
tables that ride the other backup) and `EXCLUDED_COLUMNS`.
`test_backup_carries_every_column_of_every_table` compares each section's columns with the live table,
because an omitted column restores at its default, which for `txn.trashed_at` would bring every trashed
row back.

- **Layout.** `meta.json` (the header and a sha256 per member) and one NDJSON member per section,
  `sections/<name>.ndjson`, a row per line. Document files are `documents/<id>` members, stored
  uncompressed. The line-per-row layout is what lets both directions stream; neither may hold the
  archive in memory.
- **The export builds in a staging file beside the database**, not the system temp directory, which is
  RAM-backed on many Linux installs. The file is unnamed, so an interrupted export leaves nothing.
- **Integrity.** Restore recomputes every member digest before anything destructive. Older single-JSON
  payloads and the standalone credentials backup carry `content_sha256` over the canonical payload. Both are
  optional and detect accidental corruption only; authenticity is the encrypted backup's AES-GCM tag.
- **An encrypted restore decrypts `payload.bin` to a staging file and checks the tag before opening
  it.** The envelope's `manifest.json` carries `format: "luma-encrypted-backup"`.
- **Restore is destructive and is one transaction**, so a failed restore leaves the target untouched.
  It runs with `PRAGMA defer_foreign_keys = ON`, inserting rows as they stream and repairing references
  in SQL before commit. `restored_counts` is counted from the tables afterwards.
- **Referential repair has three outcomes.** An optional reference is nulled. A row meaningless without
  its reference (a rule with no category) is dropped. A reference where NULL is a different, legitimate
  state is dropped too: an Amazon funding mapping with no account means "untracked", which a lost
  account should not become.

### Two version axes

- **`version`** is the payload format, set by `BACKUP_PAYLOAD_VERSION`. Restore accepts the versions in
  `RESTORABLE_PAYLOAD_VERSIONS` (`routers/import_export/backup.py`) and rejects any other.
- **`schema_version`** is the migration level (`db_meta.version`) the data conformed to.

Restore inserts only the payload columns the live table still has (`_insert_section` intersects with
`PRAGMA table_info`). A column the schema has since added takes its default; one since dropped is
skipped.

- **A renamed column is translated explicitly**, since drop-and-default would lose its value. A
  version-7 account's `plaid_account_id` / `plaid_item_id` become `external_account_id` and a resolved
  `connection_id` plus `provider` (`_reconcile_restored_account_links`), and a pre-9 transaction's
  `plaid_transaction_id` becomes `external_transaction_id` (`_legacy_transaction_transform`). Without
  the second, the next sync would re-add every restored row.
- **After the insert, restore replays the data-init half of every migration newer than the backup**
  (`run_post_restore_data_init`), so derived columns the backup predates are recomputed. See
  [Schema evolution](#schema-evolution).
- **A backup with a newer `schema_version` than this build is refused** (`newer_schema`), because its
  newer columns would be dropped.

### The compatibility guard

The payload is stamped with the source database's `instance_id` and `access_mode`. Three conditions are
checked independently, and any of them answers `409 restore_incompatible` naming the reasons that
fired, with `force` the only way past:

- `different_system` — the target holds data and the backup is another instance's. **This is the one an
  empty target suppresses**: there is nothing to overwrite, so a fresh install takes any backup
- `mode_mismatch` — the backup was made in the other access mode (`auth` vs `local`)
- `newer_schema` — the backup's `schema_version` is past this build's, which is the one direction that
  loses data, since restore drops columns this schema does not know

So "the target is empty" is not on its own a pass: a first install restoring an `auth`-mode backup's
financial data into a `local`-mode instance is refused, and so is any downgrade. A restore that applies
the accounts part skips `mode_mismatch`, since the file's sign-in setting comes with it. A restore of the
accounts part alone is checked by none of the three: each is a question about the ledger, and the
confirmation before it names what it replaces.

**Every restore of the financial data gives the system a new `instance_id`** (`new_db_instance_id`). A
restore moves the system back in time or brings it from elsewhere, so whatever backups preceded it, here
or on the system the file came from, are no longer this system's own: restoring one of them, the same
file included, asks the `different_system` question. Whether the backup was this system's own is decided
before the wipe, for the backup history and the watched folders. The id also namespaces browser-local UI
caches, which a restore therefore starts afresh.

### The backup history

`backup_history` (`services/backup_history.py`) holds a row per backup made, written when the file is
complete on the server: when, by whom (a name, since the row can outlive the people of the system it came
from), the suggested filename, the keys an encrypted file was sealed to, whether the credentials were
included, and the archive's size divided into ledger, accounts part and documents. The documents share is
the signal that documents are becoming the bulk of a backup
([`backlog/document-incremental-backups.md`](backlog/document-incremental-backups.md)).

- **It rides the data backup, and the restore decides whose history survives.** Restoring this system's
  own backup keeps the live history, which already holds every row the file's copy does and every backup
  made since; the table is outside the wipe for that reason. Any other restore takes the file's history and
  adds a row for the file itself (`restored_at` set), since a backup never holds its own row; its sizes are
  read from the archive and its maker from `meta.json`'s `made_by`.
- **Retention is by age**, a ledger setting in the shared preference scope, and the newest row outside the
  trash is never purged.
- **A row can be wrong, so it can be corrected or trashed.** It is written before the browser saves the
  file, and nothing reports whether the save happened or what name it used. `filename` is editable, and
  `deleted_at` is the history's trash (Settings → Trash, for an administrator). Trashing a row withdraws the
  `credentials_export` row made with the same file (*The accounts part* below), which shares its id
  as `backup_id`, and restoring it puts that row back.

### A connection is split across the two parts

The credential (`credential` / `credential_enc`) rides the accounts part. The data part's
`connections` section carries the rest: that the connection exists, its sync-health fields, and
`transactions_cursor` with `initial_sync_complete`. The resume point belongs with the data because it
is a claim about data held, written with the rows it describes.

`connection` is never wiped, so a data restore (`_restore_connections`) reconciles:

- **A connection in both** (same id, or the same provider handle under another id) takes the backup's
  state and keeps its credential.
- **One only in the backup** is created without a credential, so its accounts, mappings and cards have
  a parent. A later restore of the accounts part fills it in.
- **One only on the install** keeps its credential and loses its resume point and its account list,
  since its synced rows and `connection_account` rows went with the old ledger. *Refresh accounts*
  rebuilds the list; Tasks reports the state (`connections_without_accounts`).

The backup's resume point is reset, not restored, when the backup is older than
`RESTORED_CURSOR_MAX_AGE_DAYS` or undated, or when the live row's handle has changed.
`provider_request_budget`, `sync_started_at` and `sync_progress` stay with the target: spending cannot
be un-made, and the other two describe a running process.

**Restoring credentials writes them onto the rows; it does not replace rows**
(`accounts_backup.write_credentials`). It matches by id, then by provider handle, writes the credential
and handle, and inserts only a connection the install never had. A connection the file does not hold keeps
its row, loses its credential and is flagged `reauth_required`. `connection_account` cascades from
`connection`, so replacing rows would erase the mappings. The two parts can be restored in either order.

**A connection may hold no credential.** A vault reset clears credentials and keeps the rows, because
the mappings, coverage and cards hang off `connection_id`. `crypto_service.connection_has_credential`
asks without decrypting, and `decrypt_connection_credential` raises `MissingCredential`. A disconnect
then removes the row locally and reports `revoked: false`; re-authorize and refresh-accounts refuse; a
sync skips and flags `reauth_required`.

### The accounts part

Members `accounts/<rows>.ndjson` for `users`, `recovery_codes`, `passkeys`, `settings` and `backup_keys`,
and `accounts/credentials.json` (absent when the credentials were left out), all digested in `meta.json`,
which also records `accounts_version`.

- **Identities are the control database's people and how they sign in**: `user_account`,
  `user_recovery_code` and `app_passkey`, every column but `tenant_id`, plus the perimeter's two settings,
  `auth_enabled` and `password_policy` (`control_database.IDENTITY_TABLES`, `PERIMETER_SETTING_KEYS`).
  Everything else in that database describes the machine and stays; `test_accounts_backup.py` lists each
  table left out with its reason.
- **The backup keys** are the data database's `backup_recipient` rows.
- **The credentials are copied as stored**: `connection.credential_enc` and `provider_config.secret_enc`,
  with the exporter's slots (`crypto_service.export_vault_slots`) in a `vault_slots` list. The slots
  carry their passphrase, recovery-code and passkey material and no other member's. A recovery slot
  carries `issued_at`; a passkey slot its `credential_id`, `prf_salt`, `label`, and `site`, a salted
  digest of the RP id it was registered under. Each carries its strength verdict and the basis it was
  taken under, so it comes back judged.
- **Export needs no unlocked vault**, since it copies wrapped material. The credentials are **left out**,
  and the rest of the backup written, while the exporter's passphrase has not been judged under the
  current rule or fails it (`credentials_export_refusal`), and when there is ciphertext and the exporter
  holds no slot, since nothing could open the restored credentials (`vault_access_required`).
  `GET /backup/status` says which before the file is made, and `meta.json` records
  `credentials_included`. The reasoning is in `security-model.md` → *Secrets in backup and export*.
- **Restore replaces.** The credentials are written back verbatim, then `replace_identities` makes the
  control database's people, slots and perimeter exactly the file's in one transaction and ends every
  sign-in session. A part without the credentials leaves the vault and the credentials here as they are,
  less the slots of the people it removes; if that leaves nobody able to open the vault, the credentials
  are cleared as a vault reset clears them (`crypto_service.clear_stored_secrets`). A person in both keeps their row, so the id this machine's records hang off survives;
  a person the file does not name is deleted. The slots are adopted under their own `user_id` and `id`,
  which their AAD binds them to, so the vault opens again for the exporter with the secrets in force at
  export; the passkey's RP id is recorded at its next unlock. The per-person preferences in the data part
  are keyed by the same ids, so a full restore reattaches them.
- **A file that turns sign-in on needs an administrator of it** (`check_restoring_admin`): the username
  and password of an active admin with a password, checked against the file's own hash before anything is
  touched. Refused as `admin_password_required` or `incorrect_admin_password`, with the file's admin
  names.
- **The data database is written first, then the control database.** No transaction spans them. An
  interruption between leaves credentials under the backup's key beside the old vault, and restoring the
  same file again completes it, since every step is a replacement.
- **`credentials_export`** (control database) holds one row per backup that carried the credentials: a timestamp
  and `wrapped_dek_fingerprint`, a digest of the passphrase slot's wrapping. On a keypair slot it covers
  `wrapped_private_key`, the field a passphrase change alters; a KDF upgrade at unlock alters it too and
  moves the rows with it, since the same passphrase still opens those files. The passphrase-change
  dialog uses it to name the backups that would put the old passphrase back. It is in the control
  database so it survives a data restore, and a restore of the accounts part keeps the rows of everyone it
  keeps. Each row also records what else opened the file (the exporter's recovery code by issue time, their
  passkeys by credential id) and `seal_digest`, the key it is under. `backup_id` names the file's
  `backup_history` row, and `withdrawn_at` is set while that row is in the trash; every reader skips a
  withdrawn row. The reset dialog lists the newest
  backup per passphrase from these (`crypto_service.credentials_backups_by_passphrase`), and the backup
  tasks compare the newest with the vault now (`routers/tasks.py` → `_backup_due_tasks`).
- **`retired_vault_key`** (control database) records each seal of a key a reset or a rotation retired,
  with the reason. Credentials under a key retired as `compromised` or `replaced` are not restored, from
  an archive's accounts part (`credentials_withheld`) or a standalone credentials file
  (`credentials_retired`); the rest of the part restores as a file without credentials does. A key
  retired as `lost` is one nobody else has, so its backups stay the way back. It survives an accounts
  restore, which is exactly what it has to outlive.

### The standalone credentials backup

The file the accounts part replaced: `kind: credentials`, the same `connections`, `provider_configs` and
`vault_slots` as one JSON payload (`RESTORABLE_CREDENTIALS_VERSIONS`; v3 and v4 carried a single slot as
`vault`, v1 and v2 plaintext). It is no longer written. It carries no identities, so its slots may belong
to no one here and are never adopted; it restores into whatever vault the install has.

- **It asks for a secret only when the file's ciphertext is not already valid under the live workspace
  key.** It is valid when one of the file's slots seals the key this install holds now
  (`exported_slots_hold_live_dek`, comparing the seal, which rotation changes and a passphrase change
  does not), or, with the vault unlocked, when one of its secrets opens with the live key. Rows then go
  back verbatim.
- **Otherwise it needs one of the exporter's secrets** — a passphrase, a recovery code, or a passkey's
  PRF output with its credential id (`deks_from_exported_slot`, whose AAD is the slot's own `user_id` and
  `id`) — and the local vault unlocked. Each secret is re-sealed under this workspace's key. The refusal
  that asks (`backup_secret_required`) lists the `unlock_options` the file carries, offering a passkey
  only when the request's RP id matches its `site`.

### Backup recipients

- `POST /import-export/backup/keypair` generates a keypair and stores nothing. The private key is
  returned once; the caller submits the public half to `/backup/recipients` after the user has saved
  it, so no recipient exists whose private key was never kept.
- Keys must be at least 2048 bits.
- Recipient names are unique after trimming and case-folding.
- `enabled` is eligibility. An encrypted export with no list seals to every enabled recipient;
  `?recipients=` narrows it, and an unknown or disabled id is an error, since a file sealed to fewer
  keys than asked for fails only at restore.
- The UI says "backup key"; the code, API and file format say "recipient", because `manifest.json`
  writes `recipient_id` into every encrypted backup.
- The list rides the accounts part, not the data part: it decides who can read a backup, which is the
  perimeter's concern rather than the ledger's.

### Preferences

`ui_preference(scope_id, pref_key, pref_value)` lives in the data database, so a data backup carries
it. `scope_id` is the user id in auth mode or the local preference profile id. The control database
keeps identity, secrets and the profile definitions. `/preferences` (`services/preferences.py`) is the
one facade.

**The dividing line is per-person chrome versus shared data state.** `ui_preference` holds what may
differ per person: columns, collapse and sort state, which dashboard view they prefer. State that
describes the shared data lives in `import_workflow_state`, the workspace-wide store, because every
user reads the same data and a restore into another profile would orphan a per-user copy. Examples of
shared state: the category workspace draft (`system_category_workspace_draft`), the saved tag reports
(`system_dashboard_tag_reports`) and the ledger currency. Which report a user has open
(`ui.dashboard.spendingViewBy`) is per user.

Ledger-level settings the user chooses, such as the reimbursement reminder default and the sync-log
retention, sit in a reserved shared scope of `ui_preference` and not in `db_meta`, which backups leave
out.

## Schema evolution

A fresh database is created in the current schema by `init_db` and stamped `CURRENT_VERSION`. An
existing one is advanced by `run_migrations`, which applies each registered `@migration(version)` newer
than `db_meta.version`, in order. `backend/db/database.py` is the record of what each migration does. A
database from before the rebrand has no upgrade path; it comes across by backup and restore.

**A migration has two halves, schema and data-init.** A migration that derives a field from existing
rows puts the derivation in a named function, calls it, and registers it in `POST_RESTORE_DATA_INIT`
keyed by version. A restore loads rows into the current schema, so it runs the registered steps in
`(backup_schema_version, CURRENT_VERSION]` in ascending order
(`run_post_restore_data_init`). Each step runs once, on data that predates it, because some are
destructive when repeated. A backup with no `schema_version` is treated as version 1.

When the schema changes:

- update `init_db` so a fresh database is created in the new shape
- register a `@migration(N)` that brings an existing database to that shape, and bump `CURRENT_VERSION`
  to `N`
- if the migration derives data, extract and register the step as above
- a migration that changes what an existing database holds (a rename with data, a backfill, a dropped
  constraint) gets an upgrade test from a hand-built database at the version before it
  (`test_migrations_after_v25.py`). A fresh install proves nothing about an upgrade
- a data step checks that the tables and columns it touches exist and returns quietly otherwise,
  because the per-migration tests build a minimal old schema and run the whole chain against it
- an index or trigger that references a migration-added column or table is created after the
  fresh/migrate branch in `init_db`, not in the baseline script, where the column does not exist yet on
  an older database (`idx_txn_needs_review`, `_create_recon_epoch_triggers`)
- every insert path states a column whose default a migration changed, since SQLite cannot change a
  column default on an existing database

## Reporting assumptions

- income groups match money-in transactions and expense groups money-out
- a branch may still hold the other sign: an expense category holds refunds, an income category holds
  reversals. Summaries include every matching transaction
- `exclude_from_totals` is honored by every cross-cutting summary and chart. **A scope the user named
  explicitly is the exception**: a drill into one group or category shows that group's own activity
  unfiltered, so `/summary/by-category-in-group` applies no exclusion and the trend endpoints apply it
  only when no `category_id` scopes them. Asking for an excluded category's figures is not the same as
  asking for a total
- pending rows are left out of totals
- **A group's total equals the sum of its category slices.** It holds because a leaf's type always
  matches its group's. No single bucket looks wrong when it breaks, which is why it is tested
  (`backend/tests/test_report_sign_filters.py`). Every category write enforces it, and a restore —
  which inserts verbatim — has it re-asserted by the registered data step that also repairs a database
  that already drifted (see [Schema evolution](#schema-evolution))
- **Every category rollup counts allocations, not transactions.** A split transaction contributes one
  row per `txn_split` part, with that part's category and amount. A new aggregation gets this by
  selecting from `txn_effective_sql` and loses it by selecting from `txn` (see
  [Transaction splits](#transaction-splits))

### Totals come from the server

A total or breakdown is aggregated server-side, never by summing a fetched page, because the
`/transactions` list is paginated and a client sum undercounts past the page size. A client gets a
total from one of:

- a `/summary/*` endpoint, which returns a total and count per bucket
- `range.total` / `range.count` from the monthly-trend aggregation (`computeDetailRange`)
- the list response's `total` (count) and `sum_amount` (signed net over the whole filtered set)

`/transactions` returns a default page; a scoped list that can exceed it paginates
(`usePagedTransactions`). `limit=0` means "every matching row" and is for scopes known to be bounded.

### One aggregation sign

Every reporting bucket carries the **signed net**, through `_summary_signed_total_sql`: income-type
buckets negate so income reads positive, and reverses (a refund in an expense bucket, a return in an
income bucket) stay negative. A bucket whose refunds outweigh its spend is negative and reduces the
period total. A total under `ABS` would show a net refund as spending and make the pies disagree with
the trend.

Charts that cannot draw a negative magnitude floor the geometry at zero on the client. Every displayed
number keeps the signed value.

**Which side a bucket is on is inherited.** A leaf usually carries no `category_type`, so "is this
income" is `COALESCE(leaf, parent)` at the category level and `COALESCE(parent, leaf)` at the group
level, where the bucket is the group. Selection and signing are separate expressions and both must
resolve the type the same way.

### Averages

An average per unit — month, quarter or year — divides by **elapsed days**, not by the number of
buckets drawn, and is
withheld where the window does not cover one whole unit. Buckets are uneven, a partial bucket at either
end is not a whole one, and `txn.date` has no finer grain than a day.

- The span is the first and last transaction in the window, inclusive, which is why
  `/summary/monthly-trend`, `/summary/monthly-cash-flow` and `/summary/monthly-by-group` return
  `first_date` / `last_date`.
- `frontend/src/lib/periodAverage.js` is the one implementation. It returns null when the window is too
  short, and the caller hides the figure and any reference line.
- Same-span mode on the single-period trend keeps the mean of its buckets, because those buckets are
  the same window repeated across years and are equal by construction.

The **trend span** (`frontend/src/lib/trendSpan.js`, `ui.dashboard.trendSpan`) sets how much history
the dashboard's multi-period charts draw. It is one setting, so the charts agree on what an average
covers. It floors where the bars start and does not filter the selection. N years is counted in whole
buckets of the grain drawn, and "last N years" is anchored on the data's last month.

### Cash flow

Cash flow is a frame over the same population: all transactions, minus `exclude_from_totals`, netted.

- **`exclude_from_totals` is the whole exclusion mechanism.** Excluded from spending means excluded
  from cash flow. An inflow that funds spending is categorized somewhere counted and reads as income; a
  transfer to savings is categorized somewhere excluded and drops out. A second exclusion axis would
  drift against the first.
- **A credit-card payment** sits under `Transfers` and is excluded, while the card's purchases count at
  their own dates.
- **A bucket's side is the sign of its own net**, not its `category_type`. A bucket can change sides
  between periods, so colour, order and identity are not keyed to the side.
- **The atom is a category's net for the period.** A period's inflow is the sum of the categories that
  net money in. A gross reading by row sign nets to the same figure with larger magnitudes on both
  sides and does not reconcile with the diagram.
- **A rolling window is calendar months**, so a ledger that skips a month still spans the labelled
  period. A ledger shorter than the window starts where its data starts.
- **A tag report has no cash-flow reading.** A signature bucket mixes categories of both directions and
  has no `category_type`.

## Transaction splits

A purchase that spans categories is **one ledger row with a set of allocations** (`txn_split`). There
are no child transactions, so nothing can count twice and editing, undo and import handle one row.

Enforced on save in `services/txn_splits.py`, since no SQLite constraint expresses a cross-row sum:

- the parts sum to the transaction's amount, to the cent
- every part shares the transaction's sign, because `_summary_signed_total_sql` needs a bucket's type
  to be constant
- a part names a leaf
- at least two parts; one part is a category assignment
- several parts may name the same category. A split records the items a payment covered, and two items
  can classify alike. Every summary therefore counts `DISTINCT` transactions

A part's optional **`label`** is free text naming what it covers, defaulted from an imported order's
item description. No report reads it. It is shown under the merchant name on a part row and is read by
the ledger's plain search (`matched_split_label`). The stored value is capped.

- **`txn.category_id` is kept while a row is split**, as the prior that un-splitting restores.
  **`txn.is_split`** marks the row. Because the column is the prior and not the categorization,
  anything asking what a category holds has to read the allocations (see
  [Categories](#lifecycle-flags) on removing one).
- **`txn_effective_sql` is the expansion seam.** It left-joins `txn` to its allocations and substitutes
  the part's `category_id` and `amount` where one matched, so every filter, sign expression and
  exclusion written against `t.category_id` / `t.amount` applies per allocation. The substitution keys
  on whether a part row matched, so a part whose category was deleted stays uncategorized. It is a left
  join because a union reads `txn` twice on every summary, split or not.
- **`split_part_id`** is the allocation that matched, NULL where none did. Under expansion `t.id` does
  not identify a row, since two parts may share a category and an amount, so windowed lists key on the
  part id. An expanded row also carries the transaction's `is_split` with the part's amount;
  `split_part_id IS NOT NULL` is the test for "this row is one allocation" (`lib/splitRows.js`).
- **Expansion is chosen by what a query is for.** Summaries and trends always expand. The list expands
  only when a category-shaped facet scopes it — a category or group filter, included or excluded, or
  any of the `spending` / `income` / `cash_flow` views, since each of those resolves through the
  category — so a drill-down's rows sum to the total it came from. Dedupe, rule matching, recurring
  detection and import read plain `txn`.
- **The CSV export follows the list.** Unscoped, a split exports once at its full amount with Category
  and Group reading `--split--`, since `category_id` on a split is the stashed prior and an empty cell
  would read as uncategorized.
- The list feed carries `split_parts` and `split_part_count` for rows flagged `is_split`.
- **A part is shown in the transaction's direction**: surfaces multiply by `transactionDirection`, since
  the ledger displays stored amounts negated.
- **Tags resolve per part.** A direct tag applies to the whole transaction; an inherited tag follows
  each part's category. In the tag-signature report a split can contribute to two buckets.
- **Pre-fill from an order's items**: an item with no list price becomes a zero part for the user to
  fill, and pre-fill is refused when net cash or the list prices sum to zero.

Which paths may overwrite a split is in
[How an existing transaction's category can change](#how-an-existing-transactions-category-can-change).
Neighbouring mechanisms are told apart in [`mechanism-index.md`](mechanism-index.md).

## Attached documents

A **document** (`document`) is paperwork attached to a transaction. The row is the record; the bytes
are a file under `documents/` beside the data database. The noun is "document" because "attachment"
already means a tag attachment in this codebase.

- **A document may be stored before its transaction exists**: `txn_id` is NULL, and attaching sets it.
  One table serves both states, so upload, extraction, viewing and backup are the same and attaching
  never touches a file.
- **Nothing cascades a stored document away.** Every wipe of the ledger names `document` explicitly.
- **Detaching** returns a document to the stored set. **Deleting** removes the row and then the file.
  Moving a document directly between transactions is refused.
- **Arriving where an identical file already is keeps the one already there.** The duplicate check on
  upload applies to the stored set as its own scope.
- **Several documents may hang off one transaction.**
- **A name can be changed.** It is display and download text; the file is keyed by id.

Storage:

- **Files on disk, not blobs**, so backup and restore copy them between disk and zip member with a
  fixed buffer.
- **The directory is derived from the data database's path**, not `DATA_DIR`, so a `DB_PATH` override
  keeps documents beside the ledger that references them.
- **The file is written first and the row second.** A crash leaves a file with no row, which a sweep
  reclaims, and never a row with no file. Each file is written to a temporary name and `os.replace()`d,
  so a file present under its real name is complete.
- **`sha256` and `byte_size` describe the stored bytes.** The digest lets a restore tell a complete file
  from a torn one, extends the backup's integrity check to the files, and is the key for the duplicate
  check.
- **Removal is derived.** Whatever destroys documents deletes rows (or lets the cascade) and then sweeps
  files no row references. Incremental callers spare recently written files, since a file is
  unreferenced between its write and its row commit.
- **Documents follow their transaction through the trash**: hidden with it, restored with it, and
  deleted when it is purged. A stored document has no trash.
- **They ride the data backup**: rows in the `documents` section, each file as `documents/<id>`. Their
  digests are not repeated in `meta.json`.
- **Drift resolves toward keeping the ledger.** An export whose file is missing writes the row without
  its member. A restore reports a document it could not write or that failed its digest, deletes a
  corrupt file, and continues.

Content:

- **Accepted kinds**: files, photographs, pasted text, pasted HTML, and a saved email (`.eml`), which is
  converted at ingest to its HTML or plain part with the subject as the filename. `message/rfc822` is
  never a stored type.
- **A formatted paste is stored as `text/html`** when it contains markup, so a receipt's table layout
  is kept.
- **Every document is served with `Content-Security-Policy: sandbox; default-src 'none'`**, so stored
  HTML runs no script and fetches nothing. The attach preview rebuilds the same policy on the client
  (`lib/pastedHtmlPreview.js`).
- **An oversized photograph is downscaled once at ingest and the original is not kept.** PDFs pass
  through byte for byte. `MAX_DOCUMENT_BYTES` caps a file.
- **Editing a `text/plain` document replaces it** (`replace_document_text`): a new file is written, the
  old row deleted and the new one inserted in one transaction, and the old file removed afterwards.
  The file cannot be rewritten in place because `sha256` must describe the bytes on disk. The filename
  and `created_at` carry over; **the id changes**, so every holder of the id swaps it.

Text and search:

- **`document.text`** holds text obtained from the document. NULL means none was obtained, which is
  distinct from empty.
- **`text_source`** records how it was obtained, because the sources differ in reliability: `verbatim`
  (pasted text, exactly as written, never to be replaced by an extraction), `html_text` (markup with
  tags removed), or a PDF's own text layer. A PDF yielding only stray characters is recorded as having
  no text.
- **`document_fts`** is an FTS5 index over `document.text`, maintained by triggers, because rows leave
  by `ON DELETE CASCADE` and arrive by restore, where no application code runs. It is derived, is not
  backed up, and is rebuilt when created.
- A stored document's text is indexed but found from the ledger only once it is attached.
- The list feed projects `matched_document` on rows whose match came from a document, and
  `matched_hidden_text` on rows matched through raw or captured text, only when the filter has such a
  component.

## Multi-payment purchases

A deposit and a final payment are several real movements that buy one thing. A **purchase**
(`txn_link` `kind='purchase'`, `services/purchase_links.py`) groups them.

**Nothing is excluded, restated or netted.** Every payment is real money on its own date, so the totals
are already right and the link adds only the relationship. No report reads it.

- Members carry role `payment`. One role serves every member, since the dates already say which
  payment came first.
- `external_ref` is an invoice or order number. `metadata_json` holds `label` and `expected_total`.
- **`expected_total` is stored signed**, in the ledger's convention. The UI derives the sign from the
  payments (`lib/purchaseLinks.js` → `signedExpectedTotal`).
- **`unaccounted` is `expected_total − linked_total`.** It may be a payment not made or one not linked.
  It is NULL when no expected total was stated, which is different from zero.

Enforced in the service:

- **A transaction belongs to at most one purchase**, or one payment would count whole into two totals.
  Dividing one payment is a [split](#transaction-splits).
- **At least two payments.** Removing one that would leave fewer deletes the link.
- **Signs are not constrained.** A refund against the purchase is part of what it cost.
- **Totals count live payments.** A trashed payment stays listed and is not counted, and a trashed row
  cannot be added.

**`trg_purchase_link_prune`** drops a purchase link when its last member row goes, because a link has
no foreign key to `txn` and transactions are hard-deleted from several places. Its `WHEN` clause is
limited to `kind='purchase'`, since other kinds run multi-step reversals.

## Reimbursable expenses

Money that leaves as an expense and comes back later. Both movements are recorded correctly; the
problem is that the netting crosses a period boundary, so one month overstates spending and a later one
shows an inflow that is not income.

### The holding category

The reimbursable portion of the expense is allocated, through `txn_split`, to a leaf under the seeded,
excluded **`Reimbursable`** group, and the repayment is filed in the same group. Each period then
reports correctly on its own, and **the outstanding balance is the group's sum**, with nothing paired.
Nothing is assumed about a repayment that may never arrive.

- **The group's identity is `system_key = 'reimbursable'`.** The empty-category sweep skips keyed rows,
  and a receivable category is empty exactly when nothing is outstanding.
- **Leaves are the user's**, added to the group on the Categories page like any other, and **any active
  leaf in the group is a receivable** — the feature keys on the group, never on one blessed leaf
  (`reimbursable_leaf_ids`). A leaf is named for what the money is for, so it stays true after
  repayment.
- **The group cannot be deleted, moved, or have `exclude_from_totals` changed.** A moved group becomes a
  leaf, which no lookup finds, and clearing the exclusion restores the overstatement. Renaming and
  re-sorting are allowed.
- **A leaf holding claimed money stays in the group.** Moving or deleting it is refused while any
  reimbursement, completed ones included, claims money in it. A delete whose replacement is another
  Reimbursable leaf is allowed.
- **A completed pair stays where it is.** It is `+n` and `−n` in one excluded group and nets to zero.

### Reimbursement records

A record is a `txn_link` with `kind='reimbursement'` (`services/reimbursements.py`). `external_ref` is
the counterparty. `metadata_json` holds the per-transaction **claims**, an optional reminder date, and
once finished the **completion record**.

- **A claim is how much of one transaction's receivable belongs to this record.** A row may appear in
  as many records as it has receivable to divide: one charge split between two people is two debts.
- **Claims are amounts, not split-part ids.** `save_split` deletes and reinserts parts on every edit,
  so part ids are not stable. A part's label is kept as display provenance. When settling draws from a
  row with several shares, which allocation shrinks is taken in order.
- **A transaction's claims across all records may not exceed its receivable.** The remainder is
  **unclaimed**. Each claim is non-zero and has the sign of the row's receivable. A transaction
  allocating nothing to the group cannot join.
- **The receivable cannot be moved out from under a standing claim.** It is decided by the row's
  category or its allocations, so recategorizing, re-splitting or un-splitting the row would otherwise
  leave the claims behind: a record claiming more than its row holds reports a residual nobody owes, and
  a row left with nothing in the group drops out of the outstanding report while its record stays live,
  so the headline reads as nothing owed. `receivable_change_refusal` asks what the edit would *leave*
  and refuses only what would not cover the claims — raising a receivable, or lowering it to a figure
  that still covers them, is an ordinary correction, and moving the money between two receivable leaves
  changes nothing. It guards the single category edit, the uncategorize, the split save and the
  un-split; the bulk category edit declines those rows and counts them (`skipped_claimed`), since the
  user selected a set and the rest of it is still correct to act on; both counts are kept out of
  `updated_count` and named in the notice, so the total is what changed and the difference is
  accounted for. Detaching the claim is the way through, which is what the refusal names.
- **One claim per transaction per record**, keyed by transaction id. Attaching again replaces it, so
  choosing several portions means one claim for their sum.
- **Roles are derived from the claim's sign**: positive is an `expense`, negative a `repayment`.
- **The expected total is not stored.** It is the sum of the expense claims.
- **Tracking is optional.** The outstanding total is the open records' residuals plus the unclaimed
  money in the group. A record adds a counterparty and the pairing that settling needs.
- **Moving a claim between records releases and re-attaches in one transaction, in that order**, since
  the invariant counts claims across every record.

### Settling and completing

A repayment rarely equals the expense. Repaid short leaves a real cost, repaid over a real gain, and a
short repayment cannot be told from an unpaid one by amount, so settling is an explicit act.

- **A positive residual settles on an expense.** The shortfall is money spent, and this restates the
  original period.
- **A negative residual settles on the repayment**, in the period the surplus arrived. This is legal at
  any size, since every part of an inbound repayment has the same sign, so no mixed-sign split is
  needed.
- **Settling is per record**, because moving a residual means rewriting a named transaction's
  allocations.
- **Settling draws against this record's claim**, and the claim is reduced with the allocation, so
  another record's portion of the same row is not consumed.
- **`complete`** marks the record finished. It moves a residual where there is one and requires a
  destination category for it. No path closes a record leaving money in the holding group, which keeps
  the group's balance meaning "still owed".
- **The completion record stashes the target's prior allocations, category and provenance**, and
  `reopen` restores from it. It does not recompute an inverse, because the destination may have been
  edited since.
- **A record with only repayments is a credit**, named as such in summary text. It completes like a
  surplus.

### Reminders

- **The reminder date lives on the record**, since one charge split between two people is two debts
  with two dates. Unclaimed money follows only the household default.
- **Three states**: absent follows the default, empty is switched off, a date is chosen.
- **The default is ledger-level**, in a reserved shared scope of `ui_preference`. Zero disables it.
- **The clock runs from the oldest expense's transaction date**, so recording a debt late or receiving a
  part payment does not postpone it.
- **Only money still owed is due.** A surplus, an unmatched credit and a completed record raise nothing.
- **The signal is grouped by `txn.owner_id` of the expense side**, and only where the household has more
  than one personal owner.

## Open

Decisions still owed, each naming the backlog item that will settle it. See `AGENTS.md` → *Obstacles
and owed decisions*.

- **Number and date display formatting**, and the free-text parse bucket behind it. The correctness
  risk is the ledger search's date/amount ambiguity.
  → [`backlog/i18n-display-formatting.md`](backlog/i18n-display-formatting.md)
- **Account type as a filtering and search axis.** It exists as a rule scope only.
  → [`backlog/account-type-as-rule-criterion.md`](backlog/account-type-as-rule-criterion.md)
- **Incremental backups for attached documents**, once documents are the bulk of a backup.
  → [`backlog/document-incremental-backups.md`](backlog/document-incremental-backups.md)
- **`cash_date`, a second date for cash-basis timing.** What decides it is the drill-through question:
  an attributed node lists purchases dated outside the displayed period.
  → [`backlog/dashboard-reporting.md`](backlog/dashboard-reporting.md)
- **Document text beyond a PDF's text layer**: OCR, and itemized lines from a document. OCR is also the
  precondition for suggesting multi-payment purchases.
  → [`backlog/transaction-attachments.md`](backlog/transaction-attachments.md)
- **A data source's account map cannot be viewed or edited.** It is stored in the source's `column_map`
  as a side effect of importing, and a watched folder depends on it. Removing an account rewrites it.
  No backlog item; this section owns it.
- **Marketplace enrichment remainder**: AZAD ingestion ergonomics, re-deriving enrichment from stored
  raw values, and the column-centric mapping rework.
  → [`backlog/paypal-amazon-enrichment.md`](backlog/paypal-amazon-enrichment.md)
- **Import-source field registry remainder**: report columns drawn from the registry, and structured
  `(field, op, value)` rule matchers.
  → [`backlog/import-source-field-registry.md`](backlog/import-source-field-registry.md)
- **Recurring detection**: the pool-load cost of a scoped scan, the long-cadence bias on stale series,
  and showing a transfer pair that is not a series.
  → [`backlog/recurring-detection.md`](backlog/recurring-detection.md)
- **Dedupe follow-ups**, including the prefix-stripping item and auto-restore after an undo.
  → [`backlog/import-dedupe-followups.md`](backlog/import-dedupe-followups.md)
- **An online merchant categorizer**, ending in the existing rule store.
  → [`backlog/online-categorizer.md`](backlog/online-categorizer.md)
- **`clean_name` / merchant rename: keep or drop.**
  → [`backlog/merchant-rename-fate.md`](backlog/merchant-rename-fate.md)
- **The invariants a semantic database checker would assert.**
  → [`backlog/database-diagnostics.md`](backlog/database-diagnostics.md)
