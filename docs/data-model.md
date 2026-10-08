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

The main relationship chain is:

`Owner -\> Account -\> Transaction -\> Category (leaf) -\> Category Group`

In practice:

- an **owner** represents a person or household bucket

- an **account** belongs to at most one of the defined owners (a person or a shared bucket)

- a **transaction** belongs to one account

- a **transaction** may be assigned to one leaf category — or, when **split**, to a set of allocations
  that each name a leaf and together sum to its amount

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

Transactions also carry `owner_id`, denormalized from the account to support owner-based filtering in queries.

## Accounts

Accounts represent bank or credit accounts, typically created by a data-source connection or during CSV import.

Important behavior:

- each account belongs to at most one of the defined owners

- **Data-source linkage.** An account created by a provider connection carries `external_account_id` (the provider's per-account handle, the upsert key on connect/sync), `connection_id` (FK → the backing **`connection`** row, `ON DELETE SET NULL`), and `provider` (origin: the provider key — `plaid`, `simplefin` — or the `csv`/`manual` sentinels). The per-bank credential lives on the `connection` row; the aggregator's **app-level** credential (Plaid `client_id`/`secret`/`env`, one per provider — its `secret` vault-encrypted) lives in **`provider_config`**. See `architecture.md` → "Provider connections" for the provider-agnostic seam and the app-credential resolver. CSV/manual accounts (and any account whose connection was disconnected) have `connection_id IS NULL`. *(A version-7 backup predates these columns and carries `plaid_account_id`/`plaid_item_id` instead; restore translates them to this shape, so that path has to keep working for as long as 7 stays in `RESTORABLE_PAYLOAD_VERSIONS`.)*

- **`connection_account` is a connection's account mapping — the data-source analog of a CSV import's account step.** Keyed `(connection_id, external_account_id)`, it records what the provider offers (`provider_name` / `provider_official_name` / `provider_type` / `provider_subtype` / `provider_mask`, kept separately so the mapping screen still shows what the *bank* calls an account even when it is mapped onto a locally-renamed one), what the user decided (`mapping_mode`, `account_id`, `target_account_id`), and that account's coverage (`coverage_start_date`, `coverage_through_date`, `terminal_window_days`). Connecting a bank records these rows with `mapping_mode = NULL` and creates **no local accounts**; nothing lands anywhere until the user says what each provider account *is*. The four modes and what each buys duplicate detection:

  | mode | effect | dedupe consequence |
  | --- | --- | --- |
  | `existing` | no new account — the connection linkage is stamped onto the chosen account | strongest: same-account exact-hash **and** coverage apply directly, no alias needed |
  | `group` | new account with `parent_account_id` = the target's linked-group **root** | gets the group's compare target, so exact-hash matches resolve across the group (as a CSV import's group attachment does); runs the merge sweeps. Deliberately **not** an alias — a sibling is a *different* physical account, and letting coverage span the pair would over-collapse |
  | `new` | a plain new account (the old behavior) | soft-flag sweep only |
  | `skip` | no local account, and **remembered** | sync counts the rows `skipped`; "Refresh accounts" stops recreating an account the user rejected |

  Mapping is **idempotent and revisitable** — the same call whether it runs after Link or months later
  from the connection card. That matters beyond convenience: for a metered provider, re-linking to start
  over may not be available. Two rules keep a revisit from stranding history. A provider handle already
  held by a local account is adopted as `existing` rather than left unmapped — the handle outlives the
  mapping row, which a disconnect cascades away, so without this a reconnect would start a second copy of
  every account. And switching an already-linked account to `group`/`new` **reuses that account** rather
  than creating a second one.

  **Only `existing` and `group` feed the alias machinery** (`account_duplicate_compare_targets` /
  `explicit_alias_csv_values`), and only an alias unlocks the **coverage** rules. Two accounts
  deliberately kept apart therefore do not hard-dedupe on coverage; they get the soft-flag sweep and
  auto-confirmation of exact in-group matches instead. There is deliberately no mode meaning "the same
  physical account, kept separate" — `existing` says they are one account and `group` says related but
  distinct, and a mode between those two states nothing the dedupe rules can act on
  (`test_connection_account_mapping.py` asserts `compare` stays out of `MAPPING_MODES`).

  `connection_account` rides the **data** backup, not the credentials backup: nothing in it is a
  credential, the account-side half of the mapping is already in the data backup, and — decisively —
  coverage *must* be wiped by a data restore, since restoring a three-month-old backup removes those
  months of rows while a surviving coverage claim would hard-reject the very rows a re-sync brings back.

- transactions reference `account_id`

- account ownership affects owner-based reporting and tasks

- **`type`** classifies the account (`depository`/`credit`/`savings`/`loan`/`investment`/`p2p`/`other`, plus the marketplace `amazon` and the wallet `paypal`). It is user-editable on the Accounts page and, beyond display, is what the **account-type rule scope** matches against (see Rules). A recognized **PayPal** import auto-assigns `type='paypal'` to a **newly-created** target account (only — an existing account keeps its type on import); approving that source's money-movement `Type`s additionally types the source's accounts `paypal` when still generic (`depository`/`other`/`p2p`), since the money-movement rules are account-type scoped and need the account typed to match. A deliberately-set non-generic type is never overwritten. `amazon` carries a `kind: 'marketplace'` UI convention (hidden from the generic importer); `paypal` does not (PayPal uses the generic CSV importer)

- `display_name` is the effective label used outside the Accounts page; standalone accounts keep it aligned to `name`, while merged child accounts inherit the parent's display name. **Inside a group the display name therefore names the group, not the member**, so anything that has to tell two members apart labels an account through `_account_label_sql` (display name + masked suffix) rather than the display name alone — a duplicate report that named a sibling's copy by display name said a row duplicated a charge "on" the same account it was already on. Where masks are absent on both sides the two are genuinely indistinguishable by label, and the account's own `name` is the only remaining separator (the merged-sources list on the Accounts page uses exactly that). **Do not reach for it to enrich a duplicate report's label**, obvious as it looks: the incoming side of a hard-reject shows the *source's* own label for the account, which is not ours to restate, so the matched side has to arrive at the same string by its own route — a richer label on one side renders one account as two different-looking ones directly beside itself, which is the failure `_account_label_sql` exists to prevent. A maskless collision is left standing on purpose; the fix, if one is ever wanted, is a mask or a rename on the account, not a second label form in the report

- `parent_account_id = NULL` means the row is a top-level selectable account; child accounts keep historical account numbers visible on the Accounts page but resolve through the parent for account filtering, import/export display, and other account-facing surfaces

- **A stored account id is a reference into a mutable graph, and is resolved at read time — never rewritten at merge time.** Merging is deliberately non-destructive: it sets `parent_account_id` and moves nothing, which is exactly what lets detach reverse it. So an account id persisted in some *other* table can become a child after it was written, while the transactions it was meant to select keep resolving to the group root. Every account comparison therefore has two sides that must resolve the same way — the **row side** (`COALESCE(parent_account_id, account_id)`, the effective account a transaction sits on) and the **stored side**. Comparing a raw stored id against a resolved row side is a silent failure mode, not an error: nothing resolves to a merged child any more, so the reference simply stops selecting rows — a rule stops firing, an Amazon order stops finding its charge — with nothing in the stored row that looks wrong. `backend/services/account_groups.py` is the single home for both forms of the resolution (`effective_account_id_sql` for queries, `effective_account_id` / `account_group_member_ids` for id lists), and the one place repointing *is* correct is `reassign_account_references` (`services/account_references.py`), where the account row is about to be deleted and the merge is no longer reversible. **The tell for where this goes wrong is column-vs-parameter.** Where the stored side is a *column* the codebase has always resolved it — `rule.account_id`, `amazon_funding_map`, a recurring series' scope — because the resolution is right there in the same query. Where the stored side arrives as a *bind parameter* it went unresolved for years, in every such filter at once, because nothing in the expression looks wrong: an id that has since become a child simply matches no row. API-parameter filters resolve their given ids in SQL (`account_membership` in `services/transaction_facets.py` — one definition, reached by every faceted endpoint including the CSV export, which used to inline its own copy), so a child id passed to `account_ids` means *the group it belongs to* — the only reading a caller wants, with "exactly this underlying account" living in `source_account_ids`. Behavior is pinned in `backend/tests/test_merged_account_filters.py`. **One comparison is deliberately asymmetric and must stay that way:** `account_tag` matching (`services/transaction_tags.py`) compares its stored side raw, which is exactly what makes a merged child's own tags go dormant and return on detach — resolving it would reactivate them all and make detach unable to restore the prior state

- the distinction that decides how a given column behaves is whether it names a **matching scope** or a **specific account row**. Scopes resolve: `category_rule.account_id` (which rows a rule governs), `recurring_series.account_id` (which rows a series owns — written as an already-effective id, which a later merge can still demote to a child), `amazon_funding_map.funding_account_id` / `amazon_account_id` (which account a card's charges land on, and which Amazon account an override applies to), and `import_batch_account.account_id` (dedupe coverage, resolved through `duplicate_detection.scope_id_for`). Specific references stay raw, and the merge is *meant* to change what they mean: `account_tag.account_id` attaches a tag to one account row, so a merged child's tags lie dormant until detached; `account_pair_distinct` records assertions about the account rows themselves and a merge deletes the row outright; `connection_account` / `csv_import_profile` name a write target, where a merged child is a legitimate destination because its rows roll up through the row side. `backend/tests/test_account_group_references.py` derives every foreign key into `account(id)` from the schema and fails until a new one is classified — the choice is easy to make and easy to skip, and skipping it is invisible until data goes missing

- regrouping one merged parent onto another top-level account flattens the dragged group's visible members so they all become direct children of the new parent; the old parent remains as one of those children rather than preserving a deeper tree

- `trashed_at` is **vestigial on `account`**: the account trash it drove was retired (see *Removing an account* below), nothing sets it any more, and migration 64 released whatever was still in it — replayed after a restore, since a backup taken before the retirement carries trashed rows. The column stays because every backup carries it and the read paths still honour it, so a stale value from an old payload keeps meaning "hidden" rather than becoming a live account by surprise

- **Removing an account is a question about its transactions, and it has only two answers.** `txn.account_id` is `NOT NULL`, so a transaction without an account does not exist: the rows either move to an account the user names (`DELETE /accounts/{id}?transactions=reassign&target_account_id=…`) or they are deleted with it (`transactions=delete`). The parameter is **required once the account holds any row**, because the implicit answer it replaced was `delete` — removing an account silently destroyed its history with nothing to restore from. An account holding nothing is removed without a question. Deletion here cannot route through the transaction trash, and that is a consequence of the same `NOT NULL` rather than a policy: a trashed row still carries the `account_id` that is about to stop existing

- **Both answers are permanent, and that was settled rather than defaulted to.** Reassigning immediately while keeping the account recoverable is not expressible: after the move, nothing distinguishes the rows from those already on the target, so an undo would need a per-row record of what moved — the unbounded accumulation `scale-and-limits.md` forbids. The alternative, an **account trash** holding the account while its disposition waited, existed and was retired: it could only defer the move, and nothing outside the accounts listing filters `account.trashed_at`, so the ledger went on reporting the rows under the old account until someone emptied the trash. The accident is prevented at the point of action instead — removal lives behind the row's ⋯ menu (`ui-patterns.md`)

- **What follows the transactions is declared, not hand-written.** `services/account_references.py` holds one row per foreign key into `account(id)` with a disposition for each removal path — `FOLLOW` (re-point at the account taking the history), `CLEAR`, `DELETE_ROW`, `CASCADE` (left to the foreign key, recorded so the decision is on file), `CALLER`, `STRUCTURAL` — and both paths derive their statements from it. Deriving rather than restating is what makes a *missing* reference a test failure (`tests/test_account_reference_disposition.py`) instead of a behavior nobody notices, which is what it had been: the reassignment carried five references while the schema had thirteen, and two of the foreign keys left holding the rest decide wrongly. `recurring_series.account_id` is `ON DELETE SET NULL`, and a NULL account scope is not a narrow scope but *no* scope — `recurring_detection.py` skips the account test entirely when it is NULL — so a series pinned to one card silently began claiming rows on every account in the ledger; `amazon_funding_map` is `ON DELETE CASCADE`, so an instrument→account mapping was destroyed rather than following the history it describes. The one reference deliberately **not** moved is a connection's mapping (`connection_account.account_id` / `target_account_id`): `account.external_account_id` is UNIQUE, so one provider handle belongs to one account, and re-pointing it would start feeding an account the user never mapped it to. It is released instead, `mapping_mode` included — a mode left set with no target reads as decided while `apply_account_mapping` skips it, so neither a sync nor *Refresh accounts* can act on it and nothing on screen says why

- **A group root still refuses removal** until its children are ungrouped or trashed, and deliberately: removing one means promoting a member in its place, which moves the group's dedupe scope and reverses the merge's duplicate promotions (`restore_auto_merged_after_detach`). That is a separate decision about which account is the real one, not a question about where these transactions go, and one confirmation performing both would be two unrelated structural changes behind one click

- the sparse table `suspect_pair_distinct` records the user's "these two **rows** are not the same
  charge" judgements — the row-level counterpart of `account_pair_distinct` below, and what Keep never
  had. Keep clears its own row's `suspect_duplicate_of` and stamps `suspect_resolved_at`, and **neither
  says which pair was judged**, so anything re-examining stored rows could not tell one it had never
  looked at from one the user had already decided: it re-raised the finding, and the re-flag overwrote
  the stamp that was the only evidence a decision was ever made. `resolve_suspect` therefore records the
  pair *before* clearing the pointer that names it — that ordering is the whole mechanism. Both sweeps
  skip a pair present here. Stored canonically (`txn_id_low < txn_id_high`), cascading with either row,
  and carried in backups because it holds user decisions. It says nothing about the accounts, which is
  the distinction from the table below and the reason Keep stopped writing that one. Forgettable
  (`DELETE /accounts/duplicate-pairs/{a}/{b}`): permanent against the system re-asking is not the same as
  permanent against a misclick — and undoing is **one operation, not two**: the judgement is lifted *and*
  the finding restored (`POST /accounts/duplicate-pairs/reopen`, which takes a list so a bulk Keep's Undo
  reverses all of it), because forgetting alone would leave the pair unflagged until some later scan
  happened to notice it and the Undo would read as having done nothing. The flag is restored from
  `flagged_txn_id`/`reason` recorded at Keep rather than re-derived, since the matching rules may have
  moved since and a re-derivation could restore a different finding from the one being undone; a
  judgement written before those columns existed can only be lifted, and says so. Two surfaces reach it:
  an `UndoToast` at the moment of the decision, and a **Dismissed duplicate pairs** section in Settings
  beside its account-level neighbour, for a decision regretted later. **Nothing was backfilled and nothing could be** — judgements made before
  the table existed record only that a row was resolved, not what against, so the first version-gated
  re-scan re-raises them once
- the sparse table `account_pair_distinct` records the user's explicit "these two accounts are different physical accounts" assertions, written automatically when the user clicks Keep on a cross-account soft-flag suspect. Rows are stored canonically with `account_id_low < account_id_high` so each pair has exactly one row. The dedupe sweep consults this table to skip pairs the user has already reviewed, and the management UI on the SuspectDuplicates page can forget an assertion to re-enable detection. Merging two accounts deletes any row between them (the merge contradicts the distinct assertion)
- its charge-level sibling `amazon_charge_distinct` (canonical `txn_id_low < txn_id_high`) records "these two charges are distinct purchases" assertions from the Amazon reconciliation report's **Not duplicates** action, offered on every duplicate-flavored row. The report consults it everywhere it claims "duplicate": the unaccounted grouping refuses to chain an asserted pair, and the order-anchored `duplicate`/`duplicate_review` buckets are skipped when *every* pair in the group is asserted (partial marking still flags — the ambiguity is unresolved). An order-anchored assertion removes only the duplicate claim: the order falls back to the unmatched path, where the split-suggestion pass prefers a candidate dated on the order itself (surfaced as Matched·review with a reason note) and otherwise leaves it at No charge found for manual linking. The verdict sticks across refreshes; a re-import that adds a new copy forms new unasserted pairs and correctly re-flags

## Transactions

Transactions are the central fact table.

Important conventions:

- `amount \> 0` means money out

- `amount \< 0` means money in

- **How an imported cell reaches that sign** (`parse_amount`, the one parser behind both the import and the mapping preview — see `architecture.md` → "Preview contract"): a cell carries at most one of two direction signals, and they point opposite ways. A **bare sign** is in the *file's* convention (positive = money in), so it is inverted on the way to storage — `-50.00` and `(50.00)` are debits. A **`DR`/`CR` suffix** names the direction outright and is read as written, never inverted; where both appear the suffix wins, and in the two-column convention a suffix likewise overrides the column it sits in (a `CR` in the debit column is a credit). Conflating the two is a live failure mode, not a hypothetical: the suffix was formerly inverted along with everything else, so `50.00 CR` — a credit in the notation's own terms — imported as a debit (fixed 2026-08-13; `backend/tests/test_import_amount_parsing.py` is the record). Otherwise the column supplies the direction and the cell's own sign reverses it, so a negative or parenthesized debit-column cell reads as a refund. A blank/blank two-column row is `0.0`, not unparseable — zero is a real transaction

- `date` is **when the charge was made** — the transaction date — wherever the source gives one, and the posted date otherwise. It is the date every list, report, and total uses, and the right one for them: the transaction date is the day a charge is looked for on a statement and remembered by, and the month it belongs in, while posting is only the bank processing it (on a credit card, the money actually leaves when the card is paid). Until v59 it was the posted date, on the theory that a second basis for "when did this happen" would make two totals for one period both defensible; that treated a processing date as the more meaningful one, which it is not. `posted_date` is the *other* date: when the charge settled, which for a card transaction typically trails the transaction by one to several days. It is nullable and populated only where the source supplies a posting distinct from an undifferentiated date — a data connection captures it as a locked field — while a CSV normally carries one date column and leaves it NULL, and a pending row has none yet. It exists for **duplicate detection**, not display: two sources routinely date the same charge differently — some exports report the transaction date, others the posted date — so every date test in the ladder asks whether **either** date applies. Without it, a row dated on the other basis falls outside a range that covers the same charge, and coverage never engages. A pending row has no posting, so a provider whose protocol makes the posted timestamp mandatory must put something there, and SimpleFIN puts `0`. Read literally that is a valid instant — before v59, when it supplied `date`, such rows entered the ledger dated 1970-01-01, sorting before everything, inside no report period, beyond the reach of every date test in the duplicate ladder, and (since sync cards key on the transaction's own month) filed on a card labelled "January 1970". A zero is therefore read as *absent*, not as an epoch. When a pending row settles the sync fills in `posted_date` and re-stamps the provider-owned fields. A row with neither date is dropped at the adapter rather than dated from the import time or the window bound, both of which would be indistinguishable from a real date. **A field being required by a protocol is not a promise that it carries a value** — the sentinel is what a mandatory field degrades into, and a numeric sentinel converts without complaint

- **A transaction can also be entered by hand** (`POST /transactions`), for cash, a cheque, or an account nothing syncs. The data model always allowed for it — `external_transaction_id`, `needs_review` and duplicate detection each name hand-entered rows in their own definitions — so what a manual entry needs is not new columns but the *provenance* that makes it behave like every other row afterwards. Three parts of that are worth stating because none is visible in the row: it carries **no `import_batch_id` and no `external_transaction_id`**, since it belongs to no ingestion event; its `content_hash` is computed by the **importers' own `make_hash`**, which is the entire mechanism by which a later import or sync of the same charge recognizes it as a duplicate (a second hash implementation would digest identical data differently and the match would silently never fire); and an entry left **uncategorized is run through the rules**, exactly as an imported row is, so which door a transaction came through does not decide whether it lands in the uncategorized pile. The owner follows the account, as it does on every import. `needs_review` stays `0`: the row was just typed by the person who would be reviewing it

- **An amount is editable in place only on a hand-entered row** (`PATCH /transactions/{id}/amount`), and only where that row is neither split nor part of a reimbursement. The case it exists for is the figure mistyped and noticed a moment later; correcting any *other* row is still done by trashing it and entering it again, so what is withheld is the shortcut rather than the capability — in exactly the cases where the shortcut points the wrong way. Each of the three conditions has its own reason. **A row from a source** is a record of what that source reported, and two mechanisms make editing one worse than it looks: a synced row's amount is re-stamped from provider data whenever the charge is re-sent as `modified` or settles, so the correction does not reliably survive; and `content_hash` — which any amount edit must restamp, since it digests the amount — is the digest that row's own file reproduces, so restamping makes it stop matching that file on duplicate detection's exact rung. Neither applies to a hand-entered row, where nothing re-sends it and the corrected figure is the one a future source describing the same charge will carry, so the restamp is strictly an improvement. **A split and a reimbursement are refused because both fail silently**: a split's allocations are checked against the transaction's amount only when the split is saved, and a reimbursement's claims against the row's receivable only when the claim is made, and nothing re-checks either afterwards — so an amount moved out from under one leaves a split that no longer sums and an outstanding report whose headline has quietly stopped being true. The edit restamps the hash, re-runs the rules (an amount is a rule condition, so a corrected figure can belong to a different rule than the typo did — and a category set by hand is still protected), and triggers a recurring rescan, since series membership and the expected-amount band are read off the amount

- **`date` is editable through the bulk editor, which restamps the hash for the same reason.** The hash digests the date as well, so a row moved without one goes on describing a date it no longer has. The one exception is a **marketplace** row, whose hash is computed from the *order id* rather than from a description: it cannot be recomputed from the row's own fields, and a digest matching nothing is worse than a stale one, which at least still matches the file that produced it. Neither a date nor an amount edit touches a split or a reimbursement, which is why the bulk date setter needs none of the gating above

- `category_overridden = 1` means rule reruns must leave the current category alone. It is set for a manual edit and a split, and deliberately **not** for a trusted import's category — a file's categories rank below the rules (see *How an existing transaction's category can change*)

- `category_source` records whether the current category came from a manual edit, an import that used categories present in the data, a rule, or an **enrichment** — a feature (Amazon order import, wallet funding-leg suppression) moving the row into an excluded category as part of a link it can reverse — or is a **refund** following the category of the payment it returns (see [Refunds](#refunds))

- `display_name_source` is the same idea for the *name*: `manual` (a deliberate rename), `rule` (a rule's `clean_name` owns it), `import` (the imported/synced name), or `enrichment` (an enrich-on-import fold from a richer source filled it); NULL means unknown/legacy and is treated as non-manual (enrichable). It exists so a name can be attributed and, crucially, so a `manual` rename is protected: automatic name-setting must never overwrite `manual`. The rename writers stamp it (manual single/bulk `set_merchant` → `manual`; the rule-apply derivation `rule_scalar_effects` → `rule` only when a rule actually authored the name; import/sync inserts → `import`/`rule`). It mirrors `category_source`'s protection contract — `recategorize_all` (the automatic pass) leaves a `manual` name alone while still recategorizing the row, and only the explicit full-force rule apply may overwrite a manual name. Because `txn` stores no per-row rule_id, the migration backfill re-derives provenance: a currently-matching rule whose `clean_name` equals `display_name` → `rule`; else a name differing from both `merchant_name` and `raw_name` → `manual`; else `import`

- `import_evidence_json` stores a compact subset of the original import row for cross-source duplicate detection, `match_source_text` rules, the ledger search (whose SQL reads the `description.value` and `extra_text_fields[].value` paths directly, so a change to that shape moves it too) and later explanation; this is intentionally narrower than a full raw-row archive (a full archive would roughly double per-transaction footprint for little gain). It keeps the source account/description labels plus up to `MAX_IMPORT_EVIDENCE_TEXT_FIELDS` additional columns whose headers match a curated keyword list of **descriptive free text** — memo/note/narrative/particulars/remittance/statement/reference/payee/counterparty/beneficiary/purpose and similar — the fields that help a user decode a cryptic transaction. Identifier/figure columns (check number, balance, transaction type, status, location) are deliberately excluded: they don't aid recognition and would add noise to the text duplicate-matcher that also consumes these fields. The transaction detail's Origin → "Show more" renders all captured fields. **A data connection writes the same shape but selects differently**, and the divergence is principled: the CSV rule is a *keyword heuristic over unknown headers*, where an identifier column is as likely to be noise as signal, whereas an adapter **declares** its fields by name (`ProviderAdapter.capture_fields()`) — so a connection captures exactly the counterparties, merchant entity id, check number, and authorized date it knows it is getting, with location as an opt-in. The account/description slots carry the provider account label and the provider's original description, which is what lets a synced row serve as a terminal-window candidate at all

- **check-number enrichment** is the one exception that *derives* rather than stores: a paper-check row (`merchant_name`/description reads as the whole word "check"/"cheque", not "CHECKCARD") whose file carries a separate check-number column gets that number folded into `merchant_name`/`display_name` as `"Check #<n>"` (only when not already present). It is applied to the merchant/display fields only — `raw_name` (the literal source text) and `content_hash` (dedupe) are left untouched — so a lone "Check" line becomes recognizable without storing the check-number column or perturbing duplicate detection

- `needs_review = 1` flags a freshly imported or synced row the user hasn't looked over yet — a per-transaction convenience for reviewing newly arrived transactions, surfaced as a subtle amber `R` marker in the row strip plus a "Needs review" filter/toggle on the Transactions page. It is **set on every import/sync insert** (the CSV `_insert_imported_transaction` path and the sync insert in `routers/sync.py`); existing and hand-created rows default to `0` and stay out of the review pool. It is **its own axis, independent of categorization** — a rule-categorized row can still need review, and a reviewed row can be deliberately uncategorized. It clears two ways: a **manual category edit** (`override_category`, bulk `set_category`, the rejected-suggestion manual re-point — the same actions that write `category_source = 'manual'`) clears it implicitly, and an explicit **mark reviewed** (the `mark_reviewed` bulk action, the row-menu action or a click on the row's `R` marker — both of which offer an undo that sets it back through `set_review_status` — or the per-batch sweep) clears it for "looked, it's fine as-is." Automatic categorization (rule, import, the conflict-screen `imported-category` recategorize, `cleared`) deliberately does **not** clear it. This is deliberately a column, not a tag: review is workflow lifecycle, not a reporting label, mirroring `suspect_duplicate_*` and the advisory-reject `reviewed_at`. Historical-backfill floods are handled by bulk mark-reviewed (select-all-matching) and a per-CSV-batch "Mark all reviewed" (`POST /import-export/batches/{id}/mark-reviewed`), which is why there is no import-time default-review choice yet. Data-source syncs get the same per-file sweep because a sync's rows now carry an `import_batch_id` — the **`connection_sync` period card** (see "Data-source sync records" below), which the "Mark all reviewed" endpoint treats like any other batch
- pending transactions are visible in lists but excluded from summary totals — and so from a Dashboard drill-through too: a list asked for with `view` (spending / income / cash flow) is the set behind a figure, and drops pending rows along with excluded-from-totals categories

- `trashed_at != NULL` means the row is soft-deleted; every read path (the raw list, the summary endpoints, the dashboard, the import-card counts) filters it out, but the record stays in `txn` until the user empties the transaction trash from Settings, mirroring the account-trash pattern. The Settings → Trash view and the empty-trash operation are the one exception to "all trashed rows": both deliberately exclude confirmed-duplicate rows (`rejection_reason='duplicate_confirmed'` — see below), so the manual Trash only ever surfaces user-deleted transactions and emptying it cannot destroy a dedupe decision's restore path

- `suspect_duplicate_of`, `suspect_duplicate_reason`, and `suspect_resolved_at` together carry the soft-duplicate flag set by the post-import sweep when an imported row matches an existing row on a different account by amount, source text, and date within a ±7-day window (see the matcher note under "Import batches and profiles"); the reason is `cross_account` for an identical text match (punctuation aside — see the matcher note; high confidence, auto-confirmed on merge), `cross_account_fuzzy` for a review-only near-miss, or `cross_account_weak` for a review-only shared-distinctive-token match (neither of the latter two is ever auto-confirmed). The sweep runs unconditionally for every batch row — there is no "brand-new account" precondition — and is gated only by the per-pair-distinct table `account_pair_distinct`. The reason records the account relationship that *created* the flag, which a later merge can retire — so the relationship a report **states** is re-derived at read time from the effective roots in force then (`_IN_ACCOUNT_RULE_KEYS`: `cross_account`/`cross_account_fuzzy`/`cross_account_weak` read as `in_account`/`in_account_fuzzy`/`in_account_weak` once both sides share a root, and the `_confirmed` variants likewise — a pair that was flagged **within** one account simply reads that way from the start). Deriving rather than storing is what makes it hold in both directions — a merge re-describes every existing flag with no backfill, and a detach restores the cross-account reading with no bookkeeping to keep in step — and it is the same synthesis the `_confirmed` suffix already uses. Only the *relationship* is re-derived: the tier is evidence about the two rows, which a merge does not change, so an exact in-group match is still auto-confirmed and a near-miss is still review-only. Without this the report contradicts itself, since a merged pair also prints the same account name on both sides. Flagged rows show a badge in lists and surface in a review report under Tasks until the user resolves each with one of three actions (labeled by outcome in the UI as Keep both / Discard new / Replace existing): **keep** (clears the flag on **that row only** — identically for a same-account and a cross-account pair); **reject** (confirms the incoming row is a real duplicate — trashes the incoming row, keeps the existing one); or **replace** (the inverse survivor — the incoming row is the correct record, so it survives and the *existing* matched row is removed as the confirmed duplicate). `replace` is for fixing an account when one source mislabeled it: the surviving incoming row's categorization follows each file's `use_imported_categories` choice — it keeps its own category only when the incoming file is the sole one with that flag set, otherwise it adopts the existing row's category (existing-only, and the both/neither tie) as a manual override, never copying a NULL category. Like keep, replace records no `account_pair_distinct` row (it asserts the two rows are the *same* transaction). **None of the three says anything about the accounts** — see the account-identity question below. **Resolving a row that is already resolved is a success rather than an error**: rows get resolved out from under a per-row action (asserting a pair distinct clears every flag between it), and a bulk issues one request per selected row. `suspect_resolved_at` is what separates that from the genuine error — a row carrying it *was* flagged and has been dealt with, while a row with neither field was never a suspect and naming an action on it is still a mistake. Reporting the former as a failure made a bulk keep of N rows fail after doing all N rows' work, and (because the client abandoned its reload on the error) leave every count on screen describing the state before it

- `rejection_reason` discriminates *why* a `trashed_at` row was excluded from the active ledger: `NULL` means user-driven cleanup ("trash"), while `'duplicate_confirmed'` means a soft-flag suspect was accepted as a real duplicate — either by the user via the unified duplicate-detection report or automatically as a side effect of an account merge. Both states hide the row from active reads through the same `trashed_at` filter; the discriminator lets the unified report group confirmed soft-flags alongside the import-time hard-rejects in `import_batch_duplicate` while keeping user trash a separate concern. That separation is enforced, not just conceptual: the Settings → Trash list (`GET /transactions/trash`) and the empty-trash delete (`POST /transactions/trash/empty`) both exclude confirmed-duplicate rows **except the Amazon reconciliation's (`dedupe_resolved_by` in `'amazon_merge'`/`'amazon_discard'`)**, so the unified dedupe flow's rows never appear in the manual Trash and an empty-trash never deletes them. This is deliberate — those rows are not user-deleted items, they belong to the originating file's duplicate report, and keeping them undeletable from here preserves the restore paths (account detach for `auto_merge`, "undo reject" for `user` — see `dedupe_resolved_by`). Amazon-reconciliation removals are the exception: the user removed those copies deliberately, so they stay visible on the Trash page — in their own **Duplicate transactions** section, grouped by the source file each copy came from (direct deletes stay a flat list in the Transactions section, where the import source isn't meaningful) — restore from there (`POST /transactions/{id}/restore` clears the dedupe tags along with the untrash, and the reconciliation grouping simply re-derives — a mistaken merge or discard is fully undoable), and empty with their section (`POST /transactions/trash/empty?scope=deleted|duplicates|all` scopes each section's Empty button to its own rows; the optional `older_than=1m|3m|6m|1y` narrows the purge to rows trashed at least that long ago — the age is measured on `trashed_at`, compared via `julianday()` — so each Empty button opens a timeframe chooser that defaults to erasing everything). The `suspect_duplicate_of` pointer is intentionally kept after a confirmed-duplicate rejection as an audit trail of which existing row was accepted as the canonical copy

- `dedupe_resolved_by` records the provenance of a `rejection_reason='duplicate_confirmed'` resolution: `'user'` means the user explicitly decided it in the dialog (a Reject on the row itself, or a Replace whose surviving row is the *other* one — in the Replace case it is the removed existing row that carries this marker), `'auto_merge'` means `promote_in_group_suspects_to_confirmed` flagged it as a side effect of an account merge, `'amazon_merge'` means an Amazon reconciliation **Merge → keep one** trashed this copy (its `suspect_duplicate_of` points at the kept survivor), `'amazon_discard'` means a per-copy **Discard** on the reconciliation report — a dedupe resolution removing one redundant copy (no kept-copy pointer, since a discard doesn't always know one); the row-level **Trash** on an unaccounted charge is deliberately *not* tagged, because it means "this shouldn't be in my ledger at all" rather than "this is a redundant copy", and so files as an ordinary delete; both Amazon values, unlike `user`/`auto_merge`, stay visible in the manual Trash — see `rejection_reason` above. `'auto_cross_source'` means the same promotion sweep confirmed an **exact** match between two rows on **one** account reported by two different sources — the same automatic, restorable removal, but deliberately not `'auto_merge'`, since that marker means "a merge asserted this and a detach should take it back" and here nothing merged: the rows share one account outright, so no detach can separate them and reversing on one would restore a duplicate for a reason that never applied. `NULL` means either unresolved (active suspect) or legacy data from before the marker existed. This is what lets `detach_account` safely reverse merge-time auto-promotions without trampling deliberate user decisions: detach restores only `'auto_merge'` rows

- **Deleting the canonical row restores every copy that deferred to it, whatever the marker says.** A confirmed-duplicate resolution is a statement about a *pair* — "the same transaction is already here" — so when the surviving copy is deleted (a file's Undo, a re-import replacing a batch, or a connection's synced data being removed) the deferring copy comes back to the ledger with its dedupe tags cleared, as an ordinary transaction rather than an active suspect: with no twin left there is nothing to re-judge it against. This is done by `undo_batches` (`import_export/core.py`), the one path all three removals go through, and it is **deliberately unlike detach**, which restores `'auto_merge'` only. The distinction is what the decision still refers to: a detach leaves the canonical row in place, so an explicit user Reject keeps its referent and survives, whereas a deletion takes the referent with it and the decision's premise with it. Ordering makes this work — the restore reads `suspect_duplicate_of` *before* the dangling-pointer sweep that would clear it. The sweep still owns the other half: an **unresolved** soft-flag pointing at a deleted row has nothing to restore, so it just stops claiming a match it can no longer name. The `import_batch_duplicate` direction is **not** covered — a row hard-rejected at import was never inserted, so bringing it back would mean materializing a transaction rather than untrashing one; its card's "Import anyway" stays the (visible, user-driven) path

These conventions are meant to preserve user intent and keep reporting stable.
`category_overridden` and `category_source` exist so automated categorization can stay helpful without silently undoing deliberate user choices, and so a category's origin stays visible after the fact.

Name fields:

- **`raw_name`:** imported or provider-supplied name

- **`merchant_name`:** cleaned display name when available

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
- the two levels are **enforced at the API**, not only drawn that way: creating or moving a category requires its parent to be an active top-level group, a group that still holds categories cannot itself be placed inside one, and nothing can be placed inside itself. Requiring every parent to be top-level rules out depth and cycles together, since a row that has a parent can never be one. A move that would break the shape is refused rather than repaired. (`PATCH /categories/{id}/ungroup`, which could turn a leaf holding transactions into a group, was removed; nothing called it.)
- names are unique **within a kind** after trimming/case-folding: no two groups may share a name and no two leaves may share a name (so a given leaf belongs to exactly one branch). A leaf and a group **may** share a name, however — e.g. a `Miscellaneous` leaf alongside a `Miscellaneous` group. That is safe specifically because the two kinds are never interchangeable: the only context that resolves a bare name to an assignable category targets leaves, so the shared name can never make a transaction land on the group.

The underlying concern is ambiguity in *name → assignable category* resolution. Luma keeps category assignment, rule generation, and import review understandable and reversible by guaranteeing a label resolves to exactly one assignable leaf. Cross-kind name sharing does not reintroduce ambiguity because group and leaf are structurally distinct — a group cannot hold transactions — so the relaxation is limited to that one case while leaf↔leaf and group↔group uniqueness still hold. (Historically the rule was global uniqueness across all names; it was narrowed to per-kind once the resolvers were made leaf-aware.)

Groups also carry important reporting behavior:

- **`category_type`:** typically `expense` or `income`. **A leaf's type is its group's.** Moving a leaf rewrites its type to the new group's, retyping a group carries every one of its categories (inactive ones included) with it, and a leaf cannot be given a type of its own — a leaf may still carry `NULL` and inherit. Without this, dragging a group across the income/expense sections left its leaves on the old side, and a group's total stopped equalling the sum of its slices (see *Reporting assumptions*)

- **`exclude_from_totals`:** removes that group and all descendants from charts and totals

- category appearance is derived in the UI from stable ids/names rather than stored as user-managed color metadata

- the system also reserves a protected top-level **`Unassigned`** group for imported categories that are real, usable categories but have not yet been moved into a user-chosen reporting group; this group participates in filters/reporting but cannot be renamed or deleted
- when `Unassigned` has no child categories, category-management surfaces may hide it until imported categories populate it again

`Unassigned` exists to keep imported categories usable immediately without forcing the user to stop and redesign their reporting tree during import. Protecting the group keeps that temporary landing zone predictable for imports, undo, and later cleanup.

**Two further groups are protected, and carry a `system_key` rather than being found by name:** the
seeded, excluded **`Transfers`** — where the app files money movement of its own (the Amazon importer's
matched card charge, wallet funding-leg suppression) — and **`Reimbursable`**, which holds money owed
back. The key is their durable identity: each is resolved by key *before* name, so a rename cannot lose
one, and neither can be deleted or moved inside another group. Every lookup requires `parent_id IS NULL`,
so an absent or reparented group makes the next write build a **second** one while the existing leaves
stay behind. Before `Transfers` was keyed (v53 stamps it; the name lookup that follows the key is what
adopts a group predating it) a rename did exactly that, and silently — both groups are excluded, so no
total ever looked wrong while the money-movement leaves and their history split in two. The two differ in one
respect: `Transfers`' `exclude_from_totals` **is** the user's to clear, because filing money movement
there is a reporting convention that nothing computes against, whereas `Reimbursable`'s is locked
(see [Reimbursable expenses](#reimbursable-expenses)).

**Seeding model — what a fresh database starts with.** Creating the data database seeds only the **group skeleton**: the top-level reporting groups (with their `category_type` / `exclude_from_totals`) plus the protected `Unassigned` group. It seeds **no leaf categories and no rules**. The built-in starter *leaves* and *rules* are opt-in — added on demand through `POST /categories/generate-starter` (the onboarding "Add starter categories" / "Add starter rules" steps and the equivalent Categories- and Rules-page actions) and seeded directly by the demo dataset. That endpoint is idempotent (it updates/inserts leaves by name and skips existing rule matchers), so the set can be grown later without duplicating anything.

The reason groups ship but leaves and rules do not: a user bringing their own categories should not have our taxonomy — and especially not our *data-mutating* rules — imposed on them, yet the import "Group Imported Categories" workspace still needs visible buckets to drop imported labels into, and the small, easily-deleted group skeleton supplies them. Because the built-in rules target leaves by name, withholding the leaves also withholds the rules, so a bring-your-own install has zero starter rules touching its data until it explicitly asks for them. (The leaf seed is kept consistent with its own legacy renames — e.g. the canonical medical leaf is `Medical Services`, never a `Medical` leaf that would collide with the `Medical` group — so re-running the opt-in seed is a no-op rather than a source of forked duplicates.)

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

Categories and groups themselves do **not** have an `owner_id`; the schema does not define that column. The dimensions a user wants to report by — personal/shared, essential/discretionary, business/personal, and similar — are expressed through tags, attached at whichever level matches the user's intent (group, leaf category, or individual transaction). Tag attachment for categories is stored in `category_tag(category_id, tag_id)` with `ON DELETE CASCADE` on both foreign keys, so deleting a tag also drops its `category_tag` rows and deleting a category also drops its attachments. Reporting endpoints (`/summary/by-group`, `/summary/by-category`, `/summary/monthly-trend`, `/summary/monthly-by-group`) no longer *act* on the old `category_owner_ids` parameter; tag-aware filtering via `tag_ids` is the replacement. `/summary/by-group` still declares it and ignores it — a leftover, not parity, since its three siblings do not.

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

  **Which side a bucket is on is inherited, and every resolver has to agree.** A leaf may carry no `category_type` of its own — that is the ordinary shape, since the seeded skeleton types the *groups* and most leaves never set one — so "is this income?" is `COALESCE(leaf, parent)` at the category level and `COALESCE(parent, leaf)` at the group level, where the bucket *is* the group. The precedences are opposite on purpose and neither is a fallback for the other. The failure this guards is silent and asymmetric rather than an error: selection and signing are separate expressions, so a resolver that skipped the inheritance still *selected* an untyped income leaf (every filter COALESCEs) and then signed it as an expense — received income rendered as a large negative, and a group's total stopped equalling the sum of its own slices while each figure looked individually plausible. **That reconciliation — a group's total equals the sum of its category slices — is the invariant worth testing**, because it is the one thing no single bucket can look right about on its own (`backend/tests/test_report_sign_filters.py`).

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

### One facet registry, both halves

A facet is declared once and reaches every surface that filters transactions: `services/transaction_facets.py`
holds one `Facet` row per axis (its membership builder, its two parameter names, its negation and its
separator), a `TransactionFacets` dependency carrying the query parameters, and one `append_facets` that
walks the registry; `lib/filterParams.js` is its frontend counterpart, turning the chip row into those
same parameters. Adding an axis is a row in each.

**The registry exists because the failure of the hand-written version was silent.** Nine endpoints
consume these facets — the list feed, seven summary/trend endpoints, and CSV export — and each formerly
declared its own parameter block and called its own sequence of append helpers, with three separate
frontend translations feeding them. An endpoint that never learned about a facet does not error; it
answers unfiltered, so a total stops matching the list it drills into. That had already happened: the
export hand-rolled its membership SQL and compared the synthetic uncategorized bucket ids as though they
were rows in `category`, so an Uncategorized chip exported an empty file while the ledger showed rows.

Two derivations keep it honest rather than merely tidy. The bulk endpoint's `_BULK_FILTER_KEYS` is built
from `FACET_PARAM_NAMES` instead of restating it — a facet missing there does not fail closed, it
*widens* the set bulk resolves past the count on screen. And because the axes are now enumerable, a guard
asserts every faceted endpoint accepts every facet (`tests/test_transaction_facets.py`), so an omission
is a red test rather than a report nobody checks.

The CSV export goes further than sharing the facets: it takes the list feed's **whole** filter, row source
and order (`transaction_list_filters` and `transaction_list_scope` in `routers/transactions.py`), because
the Transactions ledger hands over a list too large to copy as that file, which must hold exactly the rows
on screen. A guard asserts the dependency names every filter the list feed accepts
(`tests/test_export_matches_ledger.py`).

### Attributes — filtering by what a row is

The facets above ask what a transaction is *filed under*. The attribute facet
(`services/transaction_attributes.py`, parameters `attribute_ids` / `exclude_attribute_ids`) asks what it
*is*: carries an attachment, belongs to a recurring series, has money owed back on it, has not been
looked over yet. The vocabulary is deliberately **the row's own marker strip** plus the two states the
ledger previously had dedicated toggles for, so that reading a row and filtering for it use one set of
words — with the origin pair below the one deliberate departure from that rule.

- **Labels name the distinction, not the mechanism's category.** `purchase` reads *Multi-payment
  purchase* rather than "part of a purchase", because nearly every debit is a purchase so that names
  nothing — and not "multi-part purchase" either, since a split's allocations are the parts, and
  `mechanism-index.md` records splits-versus-multi-payment-purchases as the one pair that genuinely gets
  confused. Dividing across **payments** is what separates it, so that word has to survive the shortening.
- **A relationship is one attribute covering both of its sides.** `reimbursable` holds the expense and
  the repayment; `refund` (*Refunded*) holds the payment and the money that came back on it. Someone
  asking for either wants the pair side by side, and one row marker already stands for both. A refund pair
  shares the purchase's `🔗` on the row but keeps its own attribute, since "paid in several payments" and
  "money came back" are different questions.
- **Where a row came from is the one pair not on the marker strip.** `from-connection` (*From a
  connection*) and `from-file` (*Imported from a file*) are provenance rather than anything the row
  draws, and they are here because the alternative was expressing a ledger-wide question one import card
  at a time. The words are still the interface's own — the detail panel's Origin block and the merchant
  hover card already say which file or connection a row arrived on — so reading and filtering stay in one
  vocabulary; what the attributes add is asking *across* rows, which neither of those surfaces can do.
  **The discriminator is `external_transaction_id`, not the batch's `source_kind`**: it is the provider's
  own id, definitionally present on a synced row (it is what makes a sync idempotent) and never written
  by a file importer, so both predicates stay on `txn` with no join and NULL-free. A synced row also
  carries an `import_batch_id` — its per-period sync card — which is why the file predicate excludes the
  provider id rather than merely asking for a batch. A hand-entered row matches neither, which is the
  honest answer rather than a third bucket nobody asked for. Together with `date_end` these are what make
  "everything imported from a file before 2015" a selection the bulk endpoint can resolve; see
  `backend/tests/test_transaction_origin_attributes.py`, whose last case is that cleanup end to end.
- **Keys are plain words** (`attachment`, `needs-review`), not the `__sentinel__` shape the category and
  tag facets use. That shape exists to avoid colliding with real ids in a namespace shared with uuids;
  this namespace holds nothing else. The same keys serve as the `?only=<key>` deep link.
- **Every predicate must be NULL-free**, so `negate_membership`'s COALESCE is belt-and-braces rather than
  load-bearing. "Is not X" has to return every row that is not X, including rows where X is unknown.
- **An unknown key is ignored; an unknown *parameter* is still a 400.** A key is a value inside a filter,
  so a stale one from an old link narrows to what it can still express, exactly as a deleted tag id in
  `tag_ids` matches nothing. Strictness belongs at the parameter name, which is where it stays.
- **`in_filter_bar` marks the one deliberate omission.** `uncategorized` is in the vocabulary (the
  ledger's quick filter and `?only=` links need it) but the FilterBar does not offer it as a row, because
  the Categories tab already owns that bucket and two identical-looking controls in one popover is a
  question the user should not have to answer.
- The vocabulary — labels and descriptions included — is served by `GET /transactions/filter-attributes`
  rather than duplicated in the frontend, so adding an attribute cannot leave a label table behind.
- **`require_all_attribute_ids` is the AND counterpart**, mirroring `require_all_tag_ids`, and it exists
  because the ledger's toolbar filter is a *separate control* rather than another tick in the FilterBar's
  picker. Values within a facet OR, so folding the toolbar's key into `attribute_ids` would OR it with
  the chips — and a second filter that **widens** the result is the one behaviour a filter must never
  have. The toolbar therefore sends this parameter; the FilterBar sends the facet. It is not a facet, so
  it is named by hand in `_BULK_FILTER_KEYS` like the other non-facet filters.

**Recurring used to be a synthetic tag** (`__recurring__` inside `tag_filter_membership_sql`), because
riding the tag facet bought it every surface the tag filter already reached with no per-endpoint
plumbing. It is an attribute now. The move became possible once the attribute facet reached those same
surfaces on its own, and it was necessary because **facets AND with each other while values within one
facet OR**: as a pseudo-tag, "Business" plus "Recurring" meant *either*, where the combination anyone
actually wants is *both*. Do not re-add it to the tag facet.

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

- account **type** scope (`account_type`, e.g. `paypal`/`amazon`): the rule matches only rows whose
  **effective** account (`COALESCE(parent, self)`, so a merged child inherits the parent's type) is of
  that type — one rule covers *every* account of the type. Parallel to the single-account scope but
  broader; part of the matcher identity. Precedence is **account_id > account_type > global** (a rule
  pinned to one account is more specific than one covering a whole type). This is the primitive the PayPal
  money-movement rules are scoped by — one `account_type='paypal'` rule per `Type` instead of one per
  (Type, account). The axis is deliberately the account's **type** and not the batch's `source_kind`,
  which could express "restrict to PayPal" equally well: a type is intrinsic to the account and so
  applies retroactively to every row on it, whereas `source_kind` is provenance stamped on an
  `import_batch` — one join away, and only present on batches imported after that field existed — so a
  `source_kind`-scoped rule would silently miss a wallet's older history. Generalizing the same axis to
  filtering and search is not built; see Open.

- category assignment

- merchant rename (`clean_name`)

- transaction-tag assignment

- match against captured import source text (opt-in `match_source_text`): when set, the keyword is
  tested against the row's captured import free text (the `import_evidence_json` description slot plus
  extra fields like "Original Statement"), not only the merchant/raw/display name. Default off, and the
  per-row evidence parse is **gated on the rule set holding at least one source-text rule**, so a ledger
  with none pays nothing for the feature. The source text excludes the account label. A **provider sync
  captures evidence but does not pass it to the categorizer at insert time**, so a source-text rule
  reaches synced rows on a later recategorize pass rather than as they arrive.

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

- **amount specificity is the *span* of a rule's range, not the number of bounds it sets.** Where two
  rules match the same row, the one whose amount range is *contained* in the other's wins — `>= 3000`
  matches a strict subset of the rows `>= 300` does, which is the same argument `LENGTH(keyword)` makes
  on the text axis. Counting bounds cannot see that (both rules set exactly one), which scored a town's
  water rule and its property-tax rule identically and let a $3,618 property-tax bill be categorized as
  water. `COALESCE(amount_max, sentinel) − COALESCE(amount_min, 0)` never contradicts containment: if one
  range contains another, the contained one has the smaller span. Amount ranks **below** keyword length —
  the name stays the stronger discriminator — and ranges that merely *overlap* (`[300, 4000]` vs
  `[3000, ∞)`) have no principled winner at all, which is a modelling ambiguity for the user to resolve
  rather than something ordering can answer — it is **surfaced rather than resolved**, see below

- **charges that drifted out of a rule's amount range are reported on the Rules page**
  (`GET /rules/range-drift`, `services/rule_range_drift.py`), because **an amount range on a rule is a
  matching gate**: when a bill drifts past the bound the row stops matching, so it loses the rule's
  category *and* its place in the rule's series, and nothing else in the app notices — the row is
  categorized, just not as intended. Derived on read over a 90-day window, like the recurring signals it
  was first written beside, and sharing their dismissal store (`services/signal_dismissals.py`) rather
  than a table of its own. A charge missing a bound by up to 25% is a **warning** with a one-click
  *Widen to include* (the bound has one right answer; the row then takes the category back, and the
  detector returns it to the series on its next pass). **Widening is one transaction** (`POST
  /rules/{id}/widen`), so it cannot stop between moving the bound and applying the rule. As two requests
  it could, and a user once found exactly that state (the bound moved, the charge unclaimed, shown as a
  near-edge warning at 0%) without the cause ever being established. One sitting within 10% *inside* a
  bound is the
  same warning one occurrence earlier, **information**, with no widen offered since the rule still claims
  it. A row already carrying the rule's own category is never reported, and each rule reports at most its
  three most recent near-misses, since a drifted range says one thing however many rows hit it — a
  **dismissal does not consume that cap**, or acknowledging what is on screen would silence the rule.
  This is the half of the Rules page's *Rule checkup* that **arrives on its own**, and therefore the only
  half that badges the control: the overlap findings below change only when the user edits a rule.

- **rules that compete for the same rows are surfaced on demand**, from *Rule checkup* on the
  Rules page (`GET /rules/overlaps`, `services/rule_overlaps.py`). Two findings with opposite intents.
  An **amount overlap** is the case above: two rules the ordering can separate only by the span term,
  whose ranges intersect with neither containing the other. **Nothing is offered but Edit** — inventing a
  tiebreak would dress a coin flip as a decision, and *removing* a side is picking a winner rather than
  fixing the model, so the resolution is to refine the two rules' conditions until only one applies.
  A **matcher nesting** (`amazon` inside `amazon prime`, or a clause superset) is *not* a problem, and is
  reported for two reasons. The winner is not the one a reader predicts: keyword length is
  consulted only after scope, so an owner-scoped `amazon` rule beats a global `amazon prime` rule on
  that owner's rows. And where the pair files to the **same category under the same scope and direction**
  (`narrower_is_redundant`), the narrow rule changes no categorization at all and is simply surplus —
  this is the half that carries **Delete**, on the *narrow* rule only, since removing the broad one would
  strand every row the narrow matcher does not reach. The delete carries the rules list's own opt-in to
  re-evaluate that rule's transactions, defaulted off as it is there. **Same category alone is not
  sufficient** for redundancy: a scope or direction difference means the broad rule is not a superset,
  and the narrow rule is what categorizes the rows the broad one cannot reach. The flag is also about the
  *category* only — a rename or tag held by just one of the two changes hands on removal, which the panel
  states before the fact rather than folding into the flag. Which rule wins is read from `rule_specificity_order_sql`'s own ordering rather
  than re-decided, so the check cannot describe a precedence the engine does not apply. **Containment is
  deliberately not a finding** — precedence answers it correctly, and flagging it would cry wolf on the
  two-rule split that is the recommended way to model several bills from one biller. Bounds are
  inclusive on both sides, so capping one rule at the other's floor leaves a **one-value** overlap that
  is still reported: a rule set split at a round number is one whose bills land on that number. Managed
  rules, trashed rules and rules targeting a deactivated category are excluded — a finding naming one
  would name something the user cannot act on. Substring containment is compared between *matchers*
  only; see [`backlog/rule-amount-overlaps.md`](backlog/rule-amount-overlaps.md)

- **a nesting finding can be dismissed; an amount overlap cannot** (`rule_overlap_dismissal`, keyed by
  the finding's fingerprint — the check's only durable state). The asymmetry is the policy, and it is
  owned by `rule_overlaps.DISMISSIBLE_KINDS` and enforced where findings are assembled, so no stored row
  can suppress a warning however it got there (the API refuses a non-dismissible kind with a 400 rather
  than a silent no-op). A nesting pair is *information*, and most are deliberate: a panel listing thirty
  of them forever is one nobody opens twice, so an acknowledged pair drops out of the list and out of the
  counts, with a *Show dismissed* toggle bringing the set back flagged and restorable. An amount overlap
  is **nondeterminism** — nothing decides which of the two rules categorizes the charge — so it stays
  listed until the conditions are refined; letting it be waved through would leave the ledger categorized
  by an arithmetic accident with the app reporting that as settled.
  **The key carries the pair *and* the redundancy verdict**, which is what keeps a dismissal honest: it
  holds through edits that do not change the situation (a rename, a tag) and lapses when one does, so a
  pair that becomes redundant re-raises the offer to delete its surplus half — an offer the user was
  never asked about. Keyed by fingerprint rather than by rule id, so it is deliberately **not** a foreign
  key: a dismissal whose pair later dissolves stops matching anything, which costs a row and no
  correctness, and is why nothing prunes them. Shared rather than per-user, like the recurring signals'
  dismissals — saying a pair of rules is fine is curation of the rule set, not a UI preference — and
  carried in the data backup (payload version 14), without which a restore would re-raise every pair the
  user had already waved through.

- **the ordering ends in the rule id, so a genuine tie is stable.** Without a final tiebreak two
  indistinguishable rules are separated by whatever order SQLite returns, which means the same ledger can
  categorize differently after a `VACUUM` or an index change

- **the precedence contract lives in one function**, `categorizer.rule_specificity_order_sql`, consumed by
  the engine, by the "what would this rule do" preview/apply mirror in `routers/rules`, and by the rules
  list (which renders it reversed, general → specific). It was three hand-kept copies; a preview that
  disagrees with what the import will actually do is worse than no preview

- amount comparisons use absolute values, with debit/credit scope applied separately through transaction sign when a rule is limited to one side

- owner-scoped rules beat global rules when otherwise similar

- at most one rule per *matcher* (keyword + the `match_expr` clause set + owner + account + account **type** + amount range + debit/credit + the `match_source_text` flag — two rules differing only by whether they also match source text, or only by account type, target different rows, so they are distinct matchers). The `match_expr` is canonicalized (clauses sorted) so reordering clauses never forks a phantom duplicate, and a multi-clause rule is a *distinct* matcher from a single-keyword rule that happens to portion the derived keyword (`contains "amazon flash"` ≠ `{contains "amazon", contains "flash"}`). Saving a rule whose matcher already exists does not fork a second copy — `create_rule` classifies the collision and reconciles instead: a **duplicate** (adds nothing) is reported, not written; a **mergeable** save (adds a category/rename the existing rule lacks, or new tags) folds additively into the existing rule; a **conflict** (a category/rename that disagrees with the existing rule) is surfaced rather than silently resolved. A genuinely different matcher is not a collision and is created normally. A single manual save prompts the user on collision; the bulk Generate Rules flow auto-merges mergeable saves, skips duplicates, and surfaces conflicts in a summary. In the rule-suggestions UI that conflict summary names the colliding rule's category and resolves each in place without leaving the review: **Replace** overwrites the existing rule's action with the suggestion's — preserving the rule's id and tags — and accepts the suggestion against it, while **Keep** leaves the existing rule untouched and defers the suggestion; the conflict response carries the existing rule's category/rename so the summary can show both sides in one round trip. Because a merge or replace changes a rule that may already govern transactions (unlike accepting a brand-new rule), that summary then offers to re-categorize the rows the changed rule already matches, using a **preserve-manual** apply: it reclaims rows the rule should own — including import-locked ones — but leaves a deliberate manual per-transaction edit as the final say. Tags still union across *different* matching rules; only a same-matcher tag addition becomes a merge into the one rule.

- **Last-used tracking + trash + cleanup (stale-rule hygiene).** Three `category_rule` columns support cleaning out obsolete rules:
  - **`last_effect_date`** — the newest transaction *date* a rule has applied a **live effect** (category, rename, or tag) to, kept as a **monotonic-forward max**. It's a "does this rule still do anything" signal, not an event log: it's the transaction's date (never wall-clock), so a re-run can't drift it toward "now", and a rule that only touches old rows stays old-dated. Seeded by the v15 data-init (a derived pass, re-run after a restore of a pre-v15 backup — see *Schema evolution*) and maintained incrementally afterward. The seed **and** every apply site (`recategorize_all`, `_apply_rule_to_existing`, and the CSV import loop) attribute a row through the **same** `effect_rule_ids` helper (+ `bump_rule_effect_dates`), so they can't disagree — an earlier bug had the seed use its own stricter, source-gated logic and diverge. **Attribution is by winning *matcher*, not by a row's stored source:** a rule is credited for a row it *wins* (would categorize) even when import or an earlier manual edit currently holds that row's category (`category_source != 'rule'`) — the rule is still what categorizes that merchant, so it isn't stale. It is therefore **not** the raw match count the ↗ report shows (that is the *pure* matcher, every row the rule hits): a row shadowed by a **more-specific** rule credits that winner, not this rule, so a rule that always loses can match rows yet legitimately read "never used". Monotonic-max can slightly *overstate* freshness (a rule that once categorized a row later overridden still shows that date), which is the **safe** bias for a cleanup tool — it errs toward keeping a maybe-active rule.
  - **`deleted_at`** — soft-delete marker for the **rules trash**. Deleting a rule (single or via cleanup) sets it; the categorizer (`load_categorization_rules`, `_find_matching_rule`) and matcher-identity (`_existing_rule_for_matcher`, the update-collision probe) all filter `deleted_at IS NULL`, so a trashed rule stops categorizing and stops blocking re-creation of its matcher, while its row + `rule_tag` survive for restore. Restore refuses if an *active* rule now shares the matcher (409). Purge hard-deletes. Rule-backed recurring series are dropped on trash and re-created on restore (cadence resets to monthly — a minor edge). Recoverable from Settings → Trash → Rules.
  - **`is_managed`** — 1 for app-created infrastructure rules (the money-movement Type rules); the stale-rule cleanup **excludes** them so a sweep can't remove rules the app maintains.
  - **Cleanup** (`GET /rules/cleanup-candidates?before=…` + `POST /rules/cleanup`): active, non-managed rules whose `last_effect_date` is older than a user-chosen window (or NULL = never used) are the candidates; the user reviews them (per-rule keep) and trashes the set — **retain-by-default** (categorizations left alone), with an opt-in batch revert. The window is a per-user preference and starts unset (nothing swept until chosen).

- a rule must target an **active** category. Deleting a category deletes every rule pointing into the deactivated branch, and the categorizer skips any rule whose target category is inactive — so a stale rule can never re-categorize new rows into a deleted category. Tag-only rules (no category) are unaffected.

- the same invariant is enforced when *editing* a rule (`update_rule`): if an edit makes a rule's matcher collide with a **different** existing rule, both rows already exist, so reconciling means one is removed — a mergeable/duplicate edit folds the edited rule's actions into the other rule and **deletes the edited rule**; a conflict is reported for the user to resolve (edit the other rule, delete one, or change scope). Both `create_rule` and `update_rule` take `on_existing` = `reject` (default: classify and report without writing) or `merge` (apply the reconciliation).

The goal is to make rule behavior explainable without requiring users to hand-maintain a priority table. Specificity and owner scope stand in for manual ordering because they usually match what a user means when two rules overlap. The one-rule-per-matcher invariant keeps that ordering meaningful: duplicate matchers would make "which rule wins" order-dependent, and editing one copy would leave the other firing.

**How rules come into being.** Rules are rarely authored cold; three paths feed the same `category_rule` store. The primary one is *learning from a categorization*: when the user sets a transaction's category the UI offers to turn that action into a rule, and once saved the rule applies automatically to newly imported transactions (rule application can be disabled globally, and a *run categorization* pass can be triggered on demand). The bulk **Generate rules from imported data** path derives candidate rules from transactions that arrived already categorized in a curated import (the "categories present in the data" flag) and presents them for review — the data-driven path for users migrating curated data. The opt-in **starter rules** add a fixed, curated catalog for users with no data to learn from. The distinction that matters: rules mutate transaction data, so neither bulk path applies blindly — Generate rules is reviewed per suggestion, and the starter rules are presented as an approve-before-add list (the user sees every `keyword → category` before any is created). All three converge on the same one-matcher reconciliation described above; inert categories have no such gate, which is why a starter *category* can be added in one click while starter *rules* go through the list.

**Concurrent writes to one transaction are last-write-wins, and the API shape is what limits the damage.** SQLite offers no protection here: there is no row versioning and no cross-request conflict detection, so the read that populates an editor and the write that saves it are unrelated transactions and the second write silently overwrites the first. **Three** existing decisions keep that narrow, and none should be undone casually. Edits are **field-scoped PATCHes** rather than whole-object writes (`/category`, `/merchant`, `/notes`, `/tags`, `/uncategorize`), so two writers collide only when they touch the *same* field — saving a note cannot clobber a category. Sync **partitions against user edits**: a provider revision refreshes provider-owned fields and the content hash while leaving the user's category and display-name edits intact. And `category_overridden` **locks a human categorization against the automatic passes** — `manual` and `import` set it, and `recategorize_all` selects only `category_overridden = 0` non-`enrichment` rows — so a rule pass cannot overwrite a saved manual edit, however much concurrent activity there is (and there is more by design, since sync stopped blocking the rest of the app and editing during a sync became normal rather than impossible).

Between them those three close the machine-versus-human case entirely. **What remains exposed is two *humans*** — two browser tabs, or two people in the household — writing the same field of the same row inside the seconds between opening an editor and saving it.

**If that is ever worth closing, the mechanism is a per-field compare-and-swap, not a row version.** The client sends back the prior value it read and the PATCH folds the comparison into the write — `UPDATE txn SET category_id = ? WHERE id = ? AND category_id IS ?` — treating `rowcount = 0` as a conflict instead of an overwrite. One statement, so there is no read-then-write window to lock around, and no schema change: SQLite already holds a write lock for the duration of the statement, so the atomicity is free. A **row-level version column is the wrong shape and would be a regression** — any field's change bumps it, so a rule re-categorization would reject an unrelated note save, reintroducing exactly the cross-field collisions the field-scoped PATCHes exist to prevent. The cost is breadth rather than depth: a prior-value field on six endpoints, every client call site passing what it read, and conflict handling in every editing surface. On conflict the intended resolution is to **discard the stale edit and re-present the current value**, as if the field had been reloaded, with a notice loud enough that the reverted value is not mistaken for a failed save — the edits are single-field and cheap to redo, so merge or conflict-resolution UI would cost more than the defect. **Trigger:** build it if a lost edit is ever actually observed; not before.

**How an existing transaction's category can change.** Two fields govern this: `category_source` (`manual` / `import` / `rule` / `cleared` / `enrichment` / `split` / `refund` / NULL) records provenance, and `category_overridden` is a lock bit (1 = automatic categorization must leave the row alone), set for `manual` and `split`, clear for `rule`, `cleared`, `import`, `enrichment` and `refund`. The three feature-owned sources are one list, `FEATURE_OWNED_CATEGORY_SOURCES` (`services/categorizer.py`), which every automatic pass reads. The retroactive operations differ only in which of those they respect.

**A trusted import is not locked, and must not be.** At import a rule already beats a file's label (see *categorization precedence at import*), so a rule created *after* the import has to beat it too — otherwise the ledger's categories depend on whether the rule or the file arrived first, which nothing a user can see explains. Until v54 the import writers set the lock on `import` rows, which is exactly that order-dependence; v54 clears it on existing rows (and is a data-init step, since an older backup brings the bit back). Because categorizations are also **stashed and put back** — an Amazon or wallet link's prior, a reimbursement's captured state, a rejected-suggestion Undo snapshot, a held duplicate's payload — and those snapshots can predate v54, every write-back derives the bit through `category_lock_for` rather than restoring it verbatim; restoring `import` with the bit set would re-lock the row silently and for good.

- **`enrichment` is feature-owned and off-limits to automatic categorization**, even though it carries `category_overridden = 0`. An excluded Amazon funding charge (`_exclude_charge`) or a suppressed wallet funding leg (`suppress_batch_funding_legs`) is deliberately moved into an excluded category and joined to a `txn_link` that stashes its prior categorization for reversal. Letting a rule reclaim it — or `recategorize_all` clearing it to NULL when nothing matches — would silently un-exclude the row and double-count the spend against its still-counted order/purchase. So both automatic passes (`recategorize_all` and its `preview_recategorize_count`) *and* the preserve-manual apply skip `enrichment` by source, not by the lock bit. The reversal path (batch undo / re-import replace, and the reconciliation report's unlink/detach) is what returns the row to its stashed prior. Only an explicit full-force rule apply may take an `enrichment` row.

- **`split` is feature-owned too, and is the one source no rule apply may take.** A split transaction's categorization *is* its set of `txn_split` allocations; the row's own `category_id` is only the retained pre-split value that un-splitting restores. Every automatic pass skips it by source, as with `enrichment`. Where it diverges is the **full-force rule apply**, which may take an `enrichment` row but **refuses** a split one and reports how many it declined: an `enrichment` row's prior is recoverable from its `txn_link` metadata, whereas a split is hand-built allocation work with no other record, so replacing it with a single category would be an unrecoverable loss performed silently. Bulk category edit refuses on the same grounds and reports the same count, and `PATCH /transactions/{id}/category` refuses outright rather than discarding the parts. The refusal is scoped to the **category** effect only — a rule's rename and tags describe the purchase, which a split says nothing about, so those still apply. Un-splitting is therefore always an explicit act.

- **`refund` is feature-owned as well: the row's category is its payment's.** A refund paired with the payment it returns (see [Refunds](#refunds)) carries that payment's category and follows it — every automatic pass and the preserve-manual apply skip it by source, as with `enrichment`, and a trigger moves it when the payment is recategorized by any path. A manual edit makes it the user's (`manual`) and it stops following; the full-force rule apply may take it, as it may an `enrichment` row, and it then belongs to the rule. A category deletion rewrites it like every other row, which also ends the following — taxonomy maintenance resets provenance for all sources alike.

- **Run categorization** (`recategorize_all`, the *Categorize* button via `POST /sync/recategorize`) re-runs all rules but selects only `category_overridden = 0` rows that are not feature-owned (`enrichment`, `split`, `refund`) — `rule`, uncategorized, `cleared` and `import` — so only `manual` and the feature-owned rows are left untouched. A matched `import` row becomes `rule`, even when the rule agrees with the file's category, and so leaves the rule-suggestion learning set — exactly as a row a rule claimed at import never entered it. It is **retain-by-default and monotonic**: it only ever *sets* or *changes* a category (and rule-applied tags), never *removes* one. A `rule` row that now matches nothing **keeps its category** — it stays `category_overridden = 0`, so a future rule can still reclaim it. This is deliberate: deleting an obsolete rule, or narrowing one, must not silently un-categorize the history it already produced. (Rule *renames* have always behaved this way — a no-match row keeps its display name; this makes categories and rule-tags consistent with that.)

  - **Reconcile is the opt-in, scoped exception.** `recategorize_all(retain_unmatched=False)` restores the old projection behavior — a no-match `rule` row is cleared, and its rule-tags removed. **Cleared means what import would have given the row with no rule in the way:** where the row carries a file label and its batch is trusted for categories, it falls back to that label's category as `import` (through the import pipeline's own `adopt_file_categories`, so batch owner/account scope and a deleted label's suppression apply); otherwise it becomes uncategorized (a `cleared` row keeps its marker). A no-match `import` row is left exactly as it is — nothing claimed it, so it already holds that fallback, and clearing and re-adopting it would mint a fresh leaf if the label's category had since been renamed. It is **only** ever run over a **specific row set** (`txn_ids`), never the whole ledger, so it cannot mass-revert the orphaned-rule rows that retain accumulates. Two callers: the **"re-evaluate this rule's transactions" opt-in** on a rule delete/edit (`DELETE`/`PATCH /rules/{id}?reconcile=true` — the "this rule was wrong, revert its rows" path, off by default), which reconciles just that rule's matched rows; and the money-movement **"remove a type"** path, which reconciles just the excluded "Money movement" leaf's rows so an un-approved type falls back out (retain would otherwise strand it there). Scoping to one rule's rows is what makes reconcile safe — it re-derives each row against the *remaining* rules (a dropped row clears or moves to another matching rule; a still-matched row is unchanged) and never touches a categorization another rule owns.

- **Full-force rule apply** (`POST /rules/{id}/apply`, the "apply to N matching transactions" offered when a rule is saved) re-categorizes *every* matcher match regardless of source — including `manual` and `import` — to the rule (`category_source = 'rule'`, `category_overridden = 0`). It is the one bulk path that overrides a manual edit, on the premise that an explicit apply is the user asking the rule to own those rows (the api layer labels the no-flag call "full force, overwriting all matches").

- **Preserve-manual apply** (`POST /rules/{id}/apply?preserve_manual=true`, and `_apply_rule_to_existing` scoped to a row list for an in-process caller such as a review action) is the same reclaim but with a `category_source IS NOT 'manual'` (and `IS NOT 'enrichment'`, `IS NOT 'refund'`) guard, so it reclaims `import` rows while sparing manual edits, feature-owned enrichment exclusions and following refunds — scoped to the rows it is given, where Run categorization would reach the same `import` rows only on its next run. It is used after a merge/replace changes a governing rule (see the suspect-duplicate section) and when accepting an import-rule suggestion (scoped to that suggestion's `source_row_ids`).

- **The Generate-rules conflict screen** is the one place an `import` row is re-categorized *while staying `import`*: Recategorize (`PATCH /transactions/{id}/imported-category`) keeps `category_source = 'import'` and rewrites the stored `imported_category` so the row keeps feeding suggestions, while Preserve writes `'manual'`. This is the deliberate exception to "an imported-category edit elsewhere becomes a manual override" detailed in the rule-suggestions section below.

- **Conflict-set matcher refinement happens before disposition.** On the Generate-rules conflict card, the top-level *Edit match* action refines the shared matcher for the rows currently represented by that card before any winner category or keep/preserve decision is made. Saving that edit immediately re-partitions the pending review: the narrowed subset becomes the current pending suggestion/card, while leftover rows return to canonical generation so equivalent remainders from other owners/cards can coalesce into one broader rule. If a refined card is later broadened back to the row's ordinary merchant matcher, it also returns to canonical generation so conflicts and owner scoping are recomputed against the full merchant population rather than staying hidden as a one-row refined partition. A remainder partition is retained only when the leftover rows would otherwise regenerate under the refined subset's own suggestion identity. This is a review-state partitioning step, not a rule/action edit — it changes which rows are grouped together for the next decision, not their category source or disposition.

- **Rejecting a rule suggestion** (`settle_rejected_suggestion_rows`, behind the Generate-rules review's *discard and: keep / remove categorization* control and its conflict-set resolution — `keep`/`clear` modes below) settles the rows the suggestion covered, sparing rows already `manual`. Three outcomes by intent: **keep as imported** (mode `keep` with no `category_id`, or a `category_id` equal to the row's current one) **leaves the row untouched at `import`** — keeping the file's own category is not an override, so the row stays re-derivable and, crucially, still reclaimable by a later explicit "apply to existing" (a `manual` row would be *spared* by that, defeating the toast) — and by an automatic Run categorization, which lets any matching rule take it exactly as that rule would have at import. Discarding a suggestion declines *that* rule, not every rule. **Re-point** (mode `keep` with a *different* active-leaf `category_id`) writes `category_source = 'manual'` at the chosen category — a genuine override (the conflict-set card's "keep these, but as a different category"), spared by both Run categorization and explicit apply. **clear** writes `category_source = 'cleared'` with `category_id = NULL` (*the category is wrong* — messy/mangled source data; rule-eligible again). Only rows that actually change are returned in the prior-state snapshot, so Undo restores the exact pre-change `(category_id, source, overridden)` and a keep-as-imported (no-op) leaves nothing to restore. **Trade-off of keep-as-imported:** because the rows stay `import`-backed, the merchant keeps regenerating as a *discarded* suggestion rather than vanishing the way a `manual` settle did — benign, and the review's look-back lens hides stale ones anyway.

Manual edits (`override_category`, bulk category edit) always set `category_source = 'manual'`, `category_overridden = 1` — the user's final say, undone only by another manual edit or a full-force apply.

The **`cleared`** source is a deliberately distinct value from a plain NULL source. A `cleared` row is **rule-eligible** (`category_overridden = 0`, so Run categorization and future rules can claim it — at which point it becomes `rule`), but it **retains its `imported_category` text** for audit and is **skipped by the trust-flag re-derivation** (`_set_batch_imported_category_usage`), which otherwise re-applies a file label to any labeled non-`manual`/`rule` row on enable. NULL alone could not carry that distinction: the re-derivation must keep filling ordinary uncategorized (`NULL`) rows, so "the user discarded this label" needs its own marker. `recategorize_all` likewise preserves the `cleared` marker when no rule matches (it only overwrites to `rule` on a positive match), so a rename/tag-only rule cannot silently strip it.

Tags are separate from the category tree and are meant for cross-cutting labels such as `Essential Expenses`, `Alice`, `Reimbursable`, etc. A transaction's **effective tags** are the additive union of these sources, listed by precedence (most specific first) when reporting the source for a tag the transaction picked up through more than one path:

- **direct (txn_tag):** added on a transaction by a matching rule (`rule_present`) and/or a manual edit (`manual_state = 1`); manual `manual_state = -1` blocks a rule-applied direct tag for that one transaction without changing the rule

- **category-level (category_tag):** any tag attached to the transaction's leaf category propagates to every transaction in that category

- **group-level (category_tag):** any tag attached to the leaf category's parent group propagates to every transaction in any leaf under it

- **account-level (account_tag):** any tag attached to the transaction's **effective (top-level) account** propagates to every transaction in that account. The effective account is `COALESCE(parent_account_id, account_id)`, so a top-level account's tags reach its own *and its child accounts'* transactions, while a child account's own tags stay **dormant** while it is merged (resolution never consults the child's row) and reactivate automatically when it is detached. Merging a tagged account under a parent therefore sets its tags aside rather than deleting them — the parent's tags govern, and the child's return on detach. **Promote-on-merge (UI):** when the merged child carries tags the parent *lacks*, the Accounts page offers to **promote** just those missing tags onto the parent (via `PUT /accounts/{id}/tags`), so they keep applying instead of going dormant; overlapping tags are already governed by the parent and left alone, and an identical/empty tag set merges silently with no prompt. Promotion is **one-way** — it adds the tags to the parent as its own, so a later detach does *not* strip them (both accounts then carry the tag, the child's having simply reactivated). Account is the broadest scope, so it is the most general (lowest-precedence) source

Inherited tags (account-, category-, or group-level) **are** overridable on a single transaction: unchecking one in the transaction's tag picker hides it on that row only, without touching the category/account it comes from. This reuses the direct layer's `manual_state = -1` **block** as a *universal* per-transaction suppression — a `txn_tag` row with `manual_state = -1` removes the tag from that transaction no matter which source(s) would otherwise contribute it. Re-checking the tag clears the block (a purely inherited tag needs no `txn_tag` row at all once unblocked). Blocks are keyed to `(txn_id, tag_id)`, independent of rules, so they survive rule reruns and recategorization (only the direct-rule `clear_manual_blocks` path — which requires `rule_present` — ever clears one). `get_visible_transaction_tag_map` applies blocks last (after the source merge), and `get_blocked_transaction_tag_map` reports the hidden tags so the picker can offer them for restore.

**Recategorizing a transaction therefore changes its tags**, and no client can predict how: the new set depends on the leaf, its group, the effective account and any blocks on that row. This is why every endpoint that moves a transaction between categories answers with the resolved `tags`/`blocked_tags` (see `docs/architecture.md`) — a caller patching its row in place has no other way to learn them, and a block already on the row means the new category's tag can arrive suppressed.

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

  **The group is read both ways, and a plausible rhythm over the whole set is not sufficient.** Treating
  amount clustering as a fallback used only when the whole set produces *no* rhythm is the intuitive
  design and it merges real series: a $4 and a $20 monthly charge billing a fortnight apart interleave
  into a perfectly plausible **biweekly** series at $12 spanning `[-20, -4]` — a cadence, an expected
  amount and a band describing nothing that ever happens. So both readings are computed, and the split
  is preferred when the whole-set reading is **amount-incoherent**, the split explains at least as many
  charges, and each price point holds a rhythm of its own.

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
  hint, and gates matching only where a series declares that it does** — see the next entry. A
  variable-amount utility bill still recurs on schedule, and for it amount gates nothing.

- **Amount is part of a series' identity only when it is doing discriminating work** — `amount_mode`,
  `'variable'` (the default) or `'fixed'`. The default is the general truth: a bill recurs on schedule
  while its amount swings, so gating on amount would evict its own charges. But one payee can bill two
  *fixed-price* subscriptions in one category at different prices, and then nothing except the amount
  tells them apart. A `fixed` series matches only charges inside its band; a `variable` one ignores
  amount entirely.

  The detector sets it, and only where the distinction is load-bearing: a group that resolved into more
  than one series, where this one sits at a single price point. A lone series never needs the gate —
  there is nothing to be confused with — and a loose one must not have it.

  **Every amount gate here carries a grace band**, because a price rise would otherwise stop matching
  the series that should report it: the charge would fall out of its own history and the price-change
  signal would never fire. The grace is deliberately narrower than the jump the detector splits price
  points on, so the gate can never re-merge a pair the detector separated.

  **The band comes from one of two places, in separate columns so a scan cannot erase a choice.**
  `amount_min`/`amount_max` are *derived* — rewritten by every scan from exactly the rows the series
  owns, self-adjusting, needing no maintenance, and the right default. `expected_min`/`expected_max` are
  *pinned* by the user, never rewritten, and take precedence when set. A pin is for the bound a
  percentage cannot express — a town's water bill and its property tax are each "about right" for the
  other's grace margin. Pinning is an edit like any other, so it marks the series user-owned and the row
  then survives the scan that re-mints auto series; nothing about a pin has to be carried across a
  rebuild. Rule-backed and manually created series are always `variable`: for a rule-backed one the
  **rule owns the matching gate**, which is where an amount condition belongs.

  **A band is extended to take in a new price, never relocated onto it.** Membership is re-derived from
  the whole ledger on every scan, so a band moved onto the new amount stops matching the series' own
  history — measured, an eight-charge series drops to one. This is what the price-change finding's
  *Accept new amount* does: it moves only the bound the charge falls outside and carries the other
  across. The action is offered **only on a gated series**, since on any other the band is read by
  nothing; there, dismissing the finding is the accept, and a variable series' envelope is learned from
  exactly those dismissals. Unlike a rule's *Widen to include*, it opens the band editor on a proposal
  rather than applying it — a rule bound has one right answer, while a series band has two ends and only
  the user knows whether a rise lifted every bill (carry both up) or added one outlier (move one).

  **Apply the sign before ordering the bounds, never after.** The band editor takes magnitudes while the
  ledger stores a direction, and negating swaps which of the two is the lower bound — so ordering first
  sends an inverted band for every expense series. It fails silently and looks correct on screen, which
  is why it is pinned by a test rather than left to review.

- **A series holds at most one charge per occurrence date.** When several charges share a date, only
  the one whose amount is closest to the series' typical amount is a member; the rest are dropped from
  it (never summed into the occurrence). This is what keeps an annual tax filing that lands on the same
  day as a quarterly estimate from being folded into the quarterly series and inflating its amount.
  Detection claims series iteratively — a series takes one charge per date, then leftover same-date
  charges are re-examined and can coalesce into their own series (e.g. the annuals form an annual
  series) rather than contaminating the first. This is also why there is **no duplicated-charge signal**
  on a series: the case a reader has in mind is already handled here, silently and without a finding,
  and a genuine double charge is a duplicate — import dedupe's question, not recurrence's. The same
  one-per-date selection governs membership when a
  confirmed/manual series is re-matched on a later scan, so the outlier can't creep back in.

- **`source`/`confirmed`/`status` record curation and gate the idempotent rescan.** A scan
  (`POST /recurring/scan`) is re-runnable: it rewrites `source='auto'` + `confirmed=0` +
  `status='active'` series wholesale, while **manual** (`source='manual'`), **confirmed**
  (`confirmed=1`), and **suppressed** (`status='suppressed'`) series are user-owned — never overwritten,
  and a candidate matching a user-owned identity `(payee_key, category_id, account_id, price point)`
  is **not re-proposed**. A component that is **null on either side is agnostic** — a series carrying no
  category covers a candidate that has one, exactly as an account-agnostic series covers every account.
  That is not a convenience: the category is *derived from the member rows*, and those rows keep changing
  as rules and hand edits recategorize them, so treating null as a specific value let a decision the user
  had already made walk out from under itself — a series suppressed while its charges were uncategorized
  stopped covering those same charges once they were categorized, and returned as a fresh suggestion at
  the same payee, cadence and amounts, with nothing in either row looking wrong. Category still
  distinguishes two identities when both sides *have* one, for the same reason the price point does.
  The price point is the last component and is null for a `variable` series;
  without it the two price points of one payee share an identity, and confirming either one suppresses
  the other as redundant — destroying a correctly-detected series by the act of endorsing its sibling. A suppressed series owns no transactions but persists so detection won't resurface it
  ("this is not recurring"). **What it held is snapshotted into `suppressed_member_ids` before the links
  are dropped**, because dropping them is not reversible by query — membership is a periodicity fit over
  one charge per date, not a predicate — and a drill-down re-deriving it from the payee could not agree
  with the `occurrence_count` shown beside it. Null for an unsuppressed series and for one suppressed
  before the column existed; `restore` clears it, since a restored series owns rows again. Confirm/suppress/edit/manual-create/pin/exclude are all the actions that make
  a series user-owned. Membership (`txn.recurring_series_id`) is recomputed for every surviving series on
  each scan.

- **Rule-backed series (`source='rule'`) let a user declare a series instead of waiting for detection.**
  The common path is writing a rule for a charge already known to recur — after categorizing it, or from
  the row menu — often before there is enough history for the detector to find it. Varying payee names
  (`NYTIMES.COM` vs. `NYTimes NY TIMES …4637`) do *not* need this: those normalize to different keys, but
  a rule renaming them to one `display_name` unifies the key the detector reads, and the series is found.
  So a **rule** gains an `is_recurring` flag; when set it owns a
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

- **`recurring_membership_override` is a surgical, scan-durable *exclusion* layered over the matcher.**
  Membership is a rebuilt cache, so a one-off correction (`state='excluded'` keeps a matched row out)
  can't live in `txn.recurring_series_id` — it lives in its own `(txn_id, series_id, state)` table that
  `reconcile_series` re-applies every scan, subtracting the exclusions before the one-per-date selection.
  Setting one **confirms the series** (like edit/confirm) so an auto series isn't deleted and re-minted
  with a fresh id out from under the override.

  **There is deliberately no way to force a row *in*.** A `pinned` state existed — API, reconcile and
  a partial unique index — and was withdrawn without ever having had a UI: a series is defined by *what
  recurs*, so a charge that merely shares a payee and category with one (a late fee on a tax payment)
  is not part of the series, and pinning it in would misrepresent the series and every total read from
  it. A row that ought to belong and does not is a **matching** problem — correct its name, or widen the
  rule — which is also why a hand edit now re-runs the scoped scan. The endpoint rejects the state and
  `_load_overrides` filters on `'excluded'`, so nothing can write one; the index is vestigial. Don't
  re-propose it. Stats derive from the effective (override-adjusted) set, so
  `occurrence_count` still equals the linked-row count. Surfaced as the row menu's "Remove from recurring
  series" and as **Exclude from series** on an *Amount changed* finding, the one finding that names a
  charge (`POST /recurring/{id}/membership` for both). A removal is recoverable three ways: an immediate **Undo**
  toast (clears the override right away); the removed row's own right-click menu, which offers **Restore
  to recurring series** because the transaction payload carries the `recurring_excluded_series_id`/name it
  was removed from; and — to browse all of a series' removals — the series drill-down's **"N removed"**
  list (rows read via the transactions filter `recurring_excluded_series_id`), each with an **Add back**.
  All three resolve to `state='clear'`, after which the row re-matches and rejoins.

  **Excluding the charge an *Amount changed* finding names does not have to reduce the findings.** The
  step is measured against the newest occurrence, and one the *previous* charge already made is not
  reported twice — so on a series whose price is still climbing (the demo's seasonal gas bill), removing
  the newest charge promotes the one before it, whose own step was never news while it had a newer charge
  above it, and that step is raised in its place. This is deliberate: the earlier rise is a real finding
  that was only ever hidden by a later one, and suppressing it would mean an exclusion could bury a step
  the user has not seen. It does mean the action can read on screen as having done nothing, which is the
  accepted cost. A test about the exclusion therefore asserts that *that finding* is gone, never that the
  list got shorter (`frontend/tests/ui/recurring.spec.js`).

- **Rule↔series lifecycle coupling.** For a `source='rule'` series the "recurring" checkbox lives on the
  rule, so the destructive series actions reconcile the two: **suppress** and **delete** clear the rule's
  `is_recurring` and drop the series (and delete the rule outright if clearing the flag leaves it
  actionless), while **end** deliberately keeps the flag live and freezes `next_due` so a resubscribe can
  still resume it — end means "stopped", not "not recurring". Deleting the rule (or an edit that merges it
  away) drops its backing series; unchecking `is_recurring` on the rule drops the series while keeping the
  rule if it still has another action.

- **Every path that writes a category re-evaluates the payees it touched — including a rule apply.**
  Membership is a cache only a scan rewrites, so
  before this a manual recategorization left the row linked to the series it used to belong to: the
  row's menu opened the *old* series, the new series' drill-down never gained it, and a missed-charge
  signal about it stayed open — one stale link with three faces, since all three read through it. None
  of the other triggers covered it (import and sync scan the payees *they* touched, a global
  recategorize scans everything, and the app-load catch-up is watermark-gated to roughly a day).
  `rescan_edited_transactions` runs the scoped scan from the transaction edit endpoints for the fields
  the detector actually reads — **category** (part of a derived series' identity), **merchant name**
  (it *is* the key), **date**, and **trash**; tags, notes and the review flag are read by nothing.
  Scope is the payees the rows belong to *now* plus any they belonged to *before*, because a rename
  moves a row between groups and the group it left has to be reconsidered too — so the caller captures
  those keys before it writes. The contract is **re-evaluation, not re-attachment**: a row that still
  belongs where it was stays put. Two costs shape the wiring: a no-op edit (re-saving the same
  category) skips the scan, and a **bulk** edit scans **once for the batch**, because a scan loads the
  whole detection window before it filters by payee — measured at ~125 ms on a 20,000-row ledger,
  effectively the same as a full scan, which is what makes the per-row version untenable and the
  parked `payee_key` materialization worth more than it was.

  **The rule paths write the same field in bulk and were the last ones left uncovered**
  (`rules._rescan_recurring`): *apply to matching transactions*, *apply to these transactions* (accepting
  a rule suggestion), the opt-in reconcile on a rule edit, and trashing a rule with *re-evaluate its
  transactions* — the last two recategorize through `recategorize_all` directly rather than through the
  endpoint that owns the full scan. Each runs the scoped scan after its transaction commits, in its own
  connection, guarded so a detection hiccup cannot fail an apply that already succeeded; a bulk cleanup
  scans once for every rule it trashed. Prior payee keys are read **before** the write for the same reason
  a hand edit reads them: a rule's `clean_name` moves rows between groups, and after the update the old
  name is gone.

  What made these worth finding rather than merely missing is the **phantom series**. A movement's two
  legs pair only when both carry a money-movement category, so filing the second leg by rule can make a
  pair that did not exist — and the payee series over the first leg's rows, correctly detected while
  nothing paired, becomes a reading of one payment off two descriptions. Unscanned it sits in *Needs
  attention* beside a **Confirm** that makes it permanent: a confirmed series is preserved by every later
  scan and goes on claiming rows, so the window between the rule apply and the next daily catch-up is one
  in which the user can ratify a reading the ledger no longer supports.

- **The scan also runs automatically, at two scopes, gated so it never does redundant heavy work.**
  `scan_and_store` takes an optional `payee_keys` scope, so the same pipeline serves both:
  - *Scoped* (`scan_imported_payees`, `payee_keys` set) — a completed CSV import or Plaid sync reprocesses
    only the payees the batch touched, matching new charges into existing series and detecting new series
    among those payees immediately, while every other payee's series and membership are left exactly as
    they are. Correct because detection groups by payee and reconcile never disturbs out-of-scope rows.
    A scoped pass **does not** stamp the watermark and **skips** the payee-key re-derivation (both are
    global concerns it can't do), so it trusts stored keys.

    **A payee series holding a paired row is always in scope, whatever the caller asked for**
    (`_payee_keys_holding`). Pairing is the one relationship in the detector decided by the money rather
    than by a name, so a movement's two legs normally sit in *different* payee groups — which makes an
    edit to one leg's group an edit whose consequence lands on the other's. Scoped to the payee that
    changed, the scan would never look at the group that has to give the rows up. The widening is
    computed from the pairing that already runs over the full pool, so it costs one indexed read of the
    membership links and nothing else.
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
  user, or offered by the missed-charge signal once a series has gone two whole periods without a charge
  (a button on a confirmed series, the "Not recurring" split control's "Mark canceled" on a detected
  one, or "Mark ended" on the signal). **The signal never writes the status itself** — a presumed-ended
  series is a *derived reading*, not a stored one, because silently freezing a confirmed series'
  `next_due` is invisible until it is wrong.

- **Money-movement series are classified, not hidden.** A series whose category (or its parent group)
  is `exclude_from_totals` — a transfer or a credit-card payment — is *money movement*, not spending or
  income. Rather than dropping these from detection, the series is flagged (derived at read time from
  the category, no stored column) so the UI marks it with a badge. It sorts in among the bills: it once
  clustered after them to keep a transfer's two legs adjacent, which stopped applying when a pair became one
  series owning both legs (below).
  This keeps a recurring CC payment from masquerading as a bill while still surfacing genuine recurring
  transfers.

- **A movement between two tracked accounts is one series that owns both its legs**
  (`services/transfer_pairs.py`, `recurring_series.counterpart_account_id`). A transfer — or a
  credit-card payment — is a single movement of money that a ledger organized by account necessarily
  records twice. Grouped by payee the detector saw two unrelated things; grouped by **pair** it sees the
  movement. `account_id` is the paying side, `counterpart_account_id` the receiving side, and the series'
  `payee_key` is a synthetic `transfer:<from>:<to>` because its identity is the two accounts plus the
  category — deliberately not a name.

  **Rows are paired first and scored second, and that order is the whole point.** Two rows pair when they
  carry the same absolute amount and category, on different accounts, in opposite directions, within
  `PAIR_WINDOW_DAYS`. Names are never consulted:

  > One monthly card payment on the reference ledger, ten years, **sixteen descriptors** across its two
  > institutions. Payee-grouped it fell into three series of 15, 16 and 3 members — two carrying cadences
  > invented from a stale slice — with 210 of its 244 rows in no series at all. Paired, it is a single
  > monthly series over 96 movements.

  **Why a window rather than an exact date.** Two institutions post one movement on their own schedules;
  a third of that payment's pairs are one to three days apart. Exact-date matching found 293 pairs across
  the reference ledger, ±3 days found 660. Same width the duplicate report already uses for its
  cross-account transfer twin. Resolution is **nearest-date-first globally**, so the outcome does not
  depend on pool order.

  **Why money movement only.** Of 637 unambiguous pairs on that ledger, **634 were already in an excluded
  category**; the three that were not are coincidences (a shared meal, a refund) where two people's rows
  offset by chance. The gate costs nothing and removes the whole false-positive class.

  **A movement is all-or-nothing.** Its occurrences are pairs, so a candidate that could take only the
  halves nobody else claimed would be a series of orphaned legs — wrong count, wrong amounts, a
  drill-down showing one side of a two-sided thing. A movement whose rows it cannot have in full is not
  inserted at all.

  **The pair wins, and does not ask.** `scan_and_store` hands the paired rows to `reconcile_series` as
  `reserved`, which holds them back from the payee series that would otherwise match them. A payee series
  over those rows is the same payment read off two descriptions that drift apart, so it is simply the
  wrong reading — being confirmed first does not make it the right one. **Nothing is deleted to achieve
  this:** membership is exclusive, one row to one series, so a confirmed series covering a payment *and*
  charges outside it keeps the charges outside it and is re-stated by the same pass. An earlier design
  reported these as a *replacement* to accept or decline, and was withdrawn: it named a whole blocking
  series beside the movement's own total — two populations that do not subtract — and a series reaching
  outside the payment made `Accept` far more destructive than the card admitted.

  **The one claim it yields to is a rule.** A `source='rule'` series' membership is an instruction the
  user wrote (these rows, by this rule), so `_rule_backed_holdings` is read *before* the reconcile and any
  movement touching one of those rows defers whole. `_reconcile_priority` orders rule-backed series ahead
  of everything for the same reason. Deferral is silent and not reported: the answer is already known, so
  there is no question to ask.

  **One refusal is asked rather than resolved** (`GET /recurring/transfer-review`): *a tie* — nothing
  distinguishes two same-day, same-amount candidates, and guessing files real money against the wrong
  movement (one row in 18,400 on the reference ledger; those rows fall through to payee matching
  meanwhile).

  **What the user answers is the only stored part, and it is taken as given.** `transfer_pair_decision`
  holds the answer to a tie — `receiving_txn_id` names the counterpart, NULL is the dismissal, one
  column because they answer the same question. `pair_money_movements` applies it **before** it infers
  anything: the pass never learns from a decision it made itself, only from one a person made, which is
  the same discipline `account_pair_distinct` follows in the dedupe service. Additive, empty on an
  existing database, and reversible — an unanswered question behaves exactly as it did before it
  existed.

  **A paired row is never payee material, even when its pairs are not a series.** `detect_transfer_series`
  returns *every* paired row id alongside its candidates, and the payee pass is run over the pool minus
  all of them — a wider set than `reserved`, which holds only what a movement series will actually claim.
  The two differ because taking rows *away* from an existing series needs somewhere for them to go, while
  declining to invent a new one does not. A pair with no rhythm is still a pair: the money moved between
  two of the user's own accounts, so "not a series" is a fine answer for it and "a merchant" is not.
  Measured: a card paid whenever it carried a balance (gaps of 1 to 50 days, amounts $400 to $5,600)
  scored no movement, and its legs then surfaced as a handful of one-sided suggestions on each account —
  the per-account fragments the pairing exists to remove, minus the rhythm that would have earned them.

  **Most series are not movements.** The payee pass is untouched and detects everything else exactly as
  before; the transfer pass only ever touches money-movement rows that actually pair. It runs over the
  **full** pool even on a scoped scan, the same exception rule-backed series get and for the same reason:
  a movement's identity is its two accounts, so a pool scoped to one payee holds only part of it.

- **Recency is measured in periods, which biases a stale series' cadence long.** `_score` discards a
  reading whose last charge is more than three periods old, and that test is applied *after* a cadence is
  proposed — so for data that has gone quiet, the longer the proposed period the more forgiving the test
  becomes. A monthly series 336 days idle is rejected at 3 × 30 days; the amount-cluster fallback then
  offers a semiannual reading of three of its charges, clears 3 × 183 days, and is emitted. **The wrong
  cadence survives precisely because it is longer.** Confirmation then freezes it: a confirmed series is
  never re-derived, and `_write_series_stats` rewrites counts, amounts and `next_due` but never
  `cadence`/`period_days`. Pairing removes the trigger for money movements — their rows no longer go
  stale under a drifting descriptor — but the bias is general and still reachable by any payee whose name
  changes. → [`backlog/recurring-detection.md`](backlog/recurring-detection.md)

- **A movement that is not a series is displayed nowhere.** Pairing identifies every two-legged movement,
  but only the routes that settle into a rhythm become a series, and a series is the only thing that
  renders. On the reference ledger 84 of 248 pairs sit on routes that will never score — a card paid when
  it carries a balance, a wallet drained to checking, an occasional reverse sweep — all correctly
  identified, correctly kept out of payee matching, and shown by nothing. The obstacle is that pairing is
  derived per scan and stored nowhere, so no surface outside recurring detection can ask whether a row is
  half of a transfer. → [`backlog/recurring-detection.md`](backlog/recurring-detection.md)

- **`created_at` on a series means *first detected*, not *last rebuilt*.** An auto series is deleted and
  re-inserted with a fresh `uuid` on every scan, so the column would otherwise advance daily and no
  surface could answer "what appeared since I last looked". `scan_and_store` captures each dropped auto
  series' `created_at` keyed by its identity tuple `(payee_key, category_id, scope_account_id)` — the
  same tuple candidate de-duplication uses — and carries it onto the row that replaces it. That
  identity, not the id, is the only stable handle an auto series has; anything that must outlive a
  rebuild is keyed by it.

- **Anomaly/forecast signals are derived on read and never stored** (`services/recurring_signals.py`).
  Four kinds: **upcoming**, **missed**, **new series detected** and **price change**. A fifth once lived
  here — the charge that drifted outside an amount-gated rule's range — and now sits with the rules
  (below); it reads as a recurring finding because a drifted range costs the row its series, but both
  actions it offers edit a *rule* and it never needed a series to exist at all. Two facts force the
  derivation rather than the event-driven alternative the scan seam was originally marked for:
  - **The stored `amount_min`/`amount_max` band cannot detect a price change.** `_write_series_stats`
    rewrites it from exactly the rows the series owns, so a hiked charge is *inside* the band by the
    time anything could compare against it. Price change is measured against the occurrences
    *preceding* the latest charge, which only a read-time derivation has. **Tightness is judged over the
    whole prior history, the range over the recent window.** The split matters for a seasonal bill: four
    consecutive winter gas bills look tight in isolation, so a trailing-window tightness test would
    classify the series as fixed-price and then report the following spring as a price collapse. A step
    whose *previous* occurrence already made it is not reported again.

    **A dismissal on a variable series teaches its range.** A gas bill that reaches its peak every
    January should say so once, not every January — and a trailing window cannot remember across a full
    cycle, since by the next winter the last one has long left it. So the amounts whose price-change
    warnings the user has dismissed are folded into the range a later charge is compared against
    (`_load_accepted_amounts`), and the seasonal envelope is *learned* from what the user accepts rather
    than modelled from dates. Three properties make that safe: the band widens only to what has been
    **explicitly accepted** — an untriaged outlier still reports next time, which using the full history
    instead would not give; it widens only *to* the accepted amount, so a genuinely larger charge is
    still reported; and it is **derived from the dismissals**, reconstructing the fingerprint by join
    rather than storing an amount, so restoring a dismissal narrows the band again and a charge that
    leaves the series takes its acceptance with it. Deliberately **not** applied to a fixed series: there
    a dismissal means "yes, the price went up", the next charge at the new price is already silent under
    the settled rule, and widening the band would mask the *next* hike.
  - **Lateness is measured against data freshness, not the calendar.** The reference "now" for a missed
    charge is the newest live transaction on the series' account (the ledger's newest, for an
    account-agnostic series), never later than today. Comparing `next_due_date` to today would turn a
    month without an import into a wall of false alarms, and an account that has stopped syncing has no
    opinion about whether its charge arrived.

- **`recurring_signal_dismissal` is the whole of the signals' durable state.** Keyed by each signal's
  own fingerprint — a transaction id, or a series' identity tuple plus the date concerned — deliberately
  *not* a `recurring_series` id, which an auto series loses on every scan. It carries no foreign key: a
  dismissal whose subject is later trashed simply stops matching, which costs a row and no correctness.
  Shared at the data-DB level rather than per-user, because "seen it, it's fine" is curation of the
  ledger like confirm/suppress, not a UI preference. Dismissal is **per finding**, so a later missed
  cycle or a different charge still surfaces.

This is the same "algorithm proposes, user disposes" idiom as import rule suggestions, and the same
"the rule is the cache" split as the parked online-categorizer note: detection is the expensive
bounded-window pass, while matching a new transaction to an existing series is a cheap keyed lookup.
The signals sit on the other side of that split again: they are cheap enough to recompute per request
that storing them would only create state to keep true.

## Import batches and profiles

CSV import creates supporting records for workflow and recovery:

- **Import profiles:** saved mapping/setup templates for recurring CSV formats

- **Import batches:** one record per import run so imported transactions can be undone

Imports use exact content hashing first for duplicate detection, then can fall back to narrower cross-source heuristics when an import explicitly links a new account to an existing account/group for duplicate comparison.

Important import-batch behavior:

- duplicate detection only blocks rows that match transactions already in Luma before the import starts

- **whether a $0.00 row is kept is declared by the source, not decided by the ingesting code.** A source often publishes a pending charge before it carries an amount, settling it later, so a $0 row is usually a placeholder rather than a transaction — but not always, and what it means differs by source. The policy lives on the source (`zero_amount_rows` on a `ProviderAdapter`; the registry in `services/source_capabilities.py` for the CSV and Amazon importers, which are data sources with no class to hold an attribute) and is honored through the single `rejects_zero_amount` predicate. **There is deliberately no default** — the reasoning does not generalize, so an undeclared source fails loudly rather than inheriting another's answer. A source keeps its $0 rows if **either** the row is reachable later (a revision lands on the row already held, keyed on the provider transaction id via a change feed or a pending→posted pointer — so dropping it would *discard* the charge rather than delay it, since a revision naming a row never inserted is ignored) **or** the zero is genuine (a finished record: a fully gift-carded order, a refund netting out). If neither holds it is unreachable dead weight — the real charge arrives as its own row, and duplicate detection cannot pair the two because the amounts differ. Hence: **Plaid keeps** (revises in place), **SimpleFIN rejects** (no change feed and no pending pointer, so nothing *guarantees* a revision can land: a settling charge is sometimes re-sent under its original id — observed on a live connection, and the reason the already-held branch of `_insert_added` re-stamps the row's provider fields rather than only clearing its pending flag — and sometimes arrives as a new id that strands the placeholder. Reachability that holds only some of the time cannot justify keeping a row whose whole defence is that the settlement will find it), **CSV/PayPal reject** (no identity carries between files), **Amazon keeps** (a $0 order is a real record; reconciliation would otherwise read it as an order with no charge found). A refusal is always **reported, never silent**: filed as kind `zero_amount` with reason "Zero amount", counted into the card's `rejected_count`, and listed under *Not imported* on the file's report — on a sync card through an `import_summary` in `config_snapshot`, the same key and shape CSV import writes, so the existing card UI needs no changes. Those sync counts **accumulate** across syncs, because a monthly period card is added to all month and a summary that overwrote would report only the latest pull's refusals. The consequence accepted where a source keeps them is that a genuinely-zero row stays in the ledger forever; that is harmless (it joins no total and cannot move a report), and suppressing it from display is not worth doing, since no display rule can tell it apart from a placeholder that is still live. Rationale and the full connector checklist: `docs/building-a-connector.md`.

- exact duplicate protection remains the highest-confidence rule; heuristic matching only considers existing transactions in the same effective account scope with the same date and signed amount, then compares stored import evidence/source text to decide whether the row should be reviewed as a possible duplicate. Confidence decides which signal is trusted enough to **hard-reject** (vs. soft-flag for review); it does **not** decide the report *label* when several hard-reject rules overlap. There the broadest reason wins: a row that both exactly matches an existing transaction and falls inside an already-covered date range is reported as a covered-range duplicate, not an exact match — so a re-imported range reads as one uniform reason instead of a scattered "exact match" subset (which rows happen to share an identical content hash is an incidental artifact of merchant-string formatting). The verdict is identical either way; only the displayed reason differs. See the ladder/ordering in `backend/services/duplicate_detection.py`

- a separate **soft-duplicate** check runs after a batch finalizes: every imported row is compared against existing rows **reported by a different source** by amount + **source text** + **date within a ±7-day window**. **The gate is the source, not the account** — and the change is a correction rather than a widening. The premise has always been *two independent sources describing one charge*: a single source does not report a charge twice, so two rows from one source are a legitimate repeat and are never paired. Landing on two different accounts used to imply that and still counts on its own, but it stopped being *necessary* once two data connections could each map `existing` onto **one** local account, at which point the same charge arrives twice inside that account, worded differently by each provider, where an account-difference test cannot see it. The condition therefore reads *differing origin* — a different connection, or a different file when neither row came from a connection — with "different accounts" retained as the other sufficient arm. Measured against a real ledger, the origin gate is what makes the same-account case safe at all: same-account cross-source candidates numbered in the single digits, against thousands of same-account **same**-source repeats it correctly refuses to pair. A **manual** row carries no origin and so never pairs within its own account — with no ingesting source it asserts nothing, and treating "no origin" as "some other origin" would pair every hand-entered row against its own account's history (the same charge often carries a transaction date from one source and a later posted date from another, and settlement skips weekends/holidays; candidates pair closest-date-first so a genuine same-day twin binds before a near-date one — `CROSS_ACCOUNT_DATE_WINDOW_DAYS` in `duplicate_detection.py`). The window was widened from 3 to 7 **on measurement, not intuition**: pairing a real ledger's connection rows against their CSV counterparts by amount and inspecting each by hand found genuine matches at +1, +3, +3, +4 and +6 days, while the false positives at those distances were rejected by the **text** comparison regardless of window (both halves of that measurement — the tail *and* the two distinct same-amount Zelle receipts that must never match — are kept as a fixture in `backend/tests/test_cross_account_window_evidence.py`, so the constant is held by a test that fails at 3 rather than by its own value) — the date is a far weaker discriminator than the text, so widening it is cheap. The real fix for the tail is `posted_date` (above), which collapses most of those gaps to zero; the window is the fallback for sources publishing only one date. The **text** side compares the *union* of each row's captured texts — `merchant_name`, `raw_name`, and the `import_evidence_json` description + extra fields (e.g. an "Original Statement") — via `source_match_texts`, rather than a single normalized payee: two sources for the same charge often park the rawest bank descriptor in different fields (a data-connection row keeps it in `raw_name`; a CSV that cleaned `raw_name` into a merchant column keeps the original only in an evidence field), so keying on one preferred field missed the match. `display_name` stays out (a user or rule rename on one side must neither hide nor create a match). Only **descriptive** captured fields participate — fields stamped `role: "categorical"` (see "Evidence field roles" below) are excluded, because the whole justification for the wide date window above is that the *text* rejects the coincidences the date lets through; a field two unrelated rows share by coincidence, admitted as text, quietly converts that strong test back into the weak one. A **byte-identical** overlap flags reason `cross_account` (high confidence — auto-confirmed on merge); a **near-miss** whose character similarity clears `CROSS_ACCOUNT_FUZZY_RATIO` flags `cross_account_fuzzy`; and two rows sharing at least `_WEAK_SHARED_TOKEN_FLOOR` **distinctive tokens** flag `cross_account_weak`. The last two are `REVIEW_ONLY_SOFT_FLAG_REASONS`, deliberately **never** auto-confirmed on merge (a slightly different spelling is surfaced, not silently trashed). **The union has one carve-out, `row_match_texts`/`RowMatchTexts`:** when *both* rows carry precise text — `raw_name` or a descriptive evidence field, as against the cleaned `merchant_name` — the tier is decided on the precise half alone, and the payee name can then reach no higher than `cross_account_weak`. A chain cleans every branch to one merchant string, so `TST*<SHOP> - <BRANCH A>` and `TST*<SHOP> - <BRANCH B>` intersect on the payee and come back byte-identical: the top tier, and auto-confirm-on-merge, asserted from the one field that cannot tell the two apart, while the field that can is outvoted. Demotion to weak is not a hedge — *same payee, different branch detail* is equally consistent with one charge described twice and with two real charges at two branches, and weak is exactly the tier meaning "worth a look, never act on it unseen". Measured on a real ledger the split moves **3 of 247** existing flagged pairs (all shaped like `TRADER JOE S #509` vs `Trader Joe's`), from auto-confirm into review. The ladder's own hard-reject rung (Rule 6, `find_textual_duplicate_candidate` over `score_duplicate_text_match`) deliberately keeps the plain union: **32 of 45** recorded text-strategy rejects there pair two sources that word a charge completely differently (`<PAYEE> Transfer` against `Send Money <PAYEE> <RECIPIENT>`), where the cleaned name is the only thing legitimately binding them — and same-date-**and**-amount already rules out the branch ambiguity. The weak tier exists because character similarity is the wrong instrument when two sources bracket one payee with different boilerplate — a bank's `WDRL-ACH <PAYEE> 5990 - debitpmt` against an aggregator's `<PAYEE> Insurance Debitpmt` sits near 0.57, nowhere close to the fuzzy ratio, while sharing the two tokens that actually name the charge. Two is the measured floor, not a guess: at one shared token a pair joined only by a survivor of `GENERIC_DUPLICATE_TEXT_TOKENS` ("general", "account") is admitted, which is noise. Note what this tier is emphatically **not** — corpus rarity. Weighting tokens by inverse document frequency was measured and inverts on a personal ledger: a recurring payee's own name is *common* there (df 327) while the generic payment suffix beside it is rare (df 51), so IDF ranks the boilerplate as the more distinctive of the two. Shared-token **count** works where rarity does not. Three differences are normalized away *before* that comparison rather than left to the similarity fallback, because in each the two texts do not actually disagree — one source simply wrote the same descriptor with different formatting, or wrote less of it, and which source did so is a property of the source, not of the charge. **Punctuation** is folded to single spaces on both sides (`_comparable_texts`): one bank's ACH descriptor reaches the ledger as `DEPOSIT - ACH PAYPAL TRANSFER - TRANSFER` through one aggregator and `DEPOSIT PAYPAL TRANSFER TRANSFER` through another, and the separators alone cost enough character similarity — 0.889 against the 0.90 floor — to sink a pair whose words agree completely, while the weak tier cannot recover it either, one distinctive token surviving the generic stoplist where two are required. It is folded for the **comparison only**: the stored texts keep their punctuation, which the processor-tag strip (it needs the `*` it removes) and the tokenizer both read, and a text of pure punctuation is dropped rather than folded to `""`, which would intersect on both sides and read as the top tier. Measured before adopting: across **756** candidate pairs over every import on a real ledger, exactly **one** pair changes tier, into review rather than auto-confirm — a deposit one aggregator wrote with separators and another without. **A leading payment-processor tag** (`<tag> *MERCHANT`, matched as a shape rather than a list of processor names) makes a row offer its descriptor *both* as delivered and with the tag removed, rather than stripping in place: sources disagree about the tag in two directions — dropped entirely, kept punctuated, or kept bare (`SQ MERCHANT`) — and stripping in place fixes the first disagreement while opening the second, since the bare form has no separator to strip and would then face a stripped counterpart it no longer resembles. Holding both forms matches whichever the other side kept. No variant is offered when too little would survive, so a residue like a single generic word never becomes a match key. This is deliberately *not* shared with `sanitize_rule_merchant_text`, whose trailing-reference-digit strip is also the rules engine's primitive — rule text is authored by the user and matched unanchored, so a typed tag is a deliberate choice there, while dedupe reads whatever pre-processing a source applied. **A truncation** is accepted by `classify_text_match` as exact when one text *is the other entire text* plus a tail of at most a few characters, and the cut either lands mid-word (nothing but a length limit slices a word) or comes after a long enough agreement to rule out a second location. The asymmetry is load-bearing and must not be relaxed into "the two share a long common prefix": two receipts to the same payee with consecutive reference numbers agree for their whole length but the last digit, and a common-prefix reading would promote them to the tier a merge auto-removes (the control in `test_cross_account_window_evidence.py`). Truncation length is *not* derivable per source — one charge was observed carrying 22-, 24- and 25-character forms while both sources publish descriptors past 100 characters — which is why the rule reads the shape of the disagreement instead of a length model. **A bank's own leading transaction-type token** (a withdrawal/ATM marker such as `WDRL-ACH`) looks like the same problem and is deliberately *not* stripped: the processor tag is applied by the charge's **originator**, and sources disagree about passing it through, so it lands *between* two records of one charge — whereas a bank-applied prefix rides along consistently with everything that bank feeds, and where a counterpart lacks it, the counterpart came from a different source and differs in substance too. Measured over a real ledger, stripping it recovered no matches at any tier, and the generalized form (dropping leading `GENERIC_DUPLICATE_TEXT_TOKENS`) recovered none while moving more pairs into review — stripping type words makes descriptors *more* generic, which is the direction that produces false pairings. See `docs/backlog/import-dedupe-followups.md` for the conditions under which this is worth re-measuring.

**A matcher change re-examines stored rows once, gated on a version.** `DUPLICATE_DETECTION_VERSION`
(in `duplicate_detection.py`) is bumped in the same commit as any change that could make detection reach
a different verdict on rows already in the ledger — a new tier, a tokenizer change, a threshold move, a
widened pairing condition. App load compares it against a `db_meta` stamp and, when the database was last
examined under older rules, runs the existing-vs-existing scan over every account
(`maybe_rescan_for_detection_change`, mirroring `recurring_detection.maybe_auto_scan` — same place in the
lifecycle, gated on a *version* rather than an interval because the trigger is a code change, not elapsed
time). It is deliberately **not** the schema version: tying them together would force a migration for a
threshold tweak, and would silently consume a re-scan whenever a migration happened to land first.

The scan lets each row take one partner per pass, so it converges rather than settling at once (measured
on a real ledger: 70 flagged, then 5, then 3, then 0). `rescan_until_settled` loops to a fixed cap, which
makes convergence a guarantee rather than an observation. Pairs already judged (`suspect_pair_distinct`)
are skipped, so a bump surfaces what was never examined without re-asking anything that was. **This is
the gap the version gate exists for**: the rules improved, nothing re-examined what was already stored,
and the pairs the improvement was written for stayed invisible — including a tier added specifically to
catch two sources bracketing one payee with different boilerplate, which then never fired on the rows
that motivated it.

A change to these text rules re-tiers **future** flags only. Both sweeps skip rows that already carry a `suspect_duplicate_of` pointer, so a flag keeps whatever reason it was given when it was raised; already-stored suspects are resolved by hand (or by a merge, for the exact tier) rather than being re-judged in place. A differing explicit check number (`Check #<n>`) vetoes either tier. Matches are flagged (not blocked) via the `suspect_duplicate_of` columns. The check is gated only by `account_pair_distinct` — pairs the user has previously asserted as distinct (via Keep on a soft-flag) are skipped, since the user has already declared the accounts to be different physical accounts. Same-batch sibling rows on different accounts are trusted as distinct (the CSV asserts via its account column that two rows on different accounts in one statement file are separate transactions, even if their date/amount/payee match); cross-batch matches are the candidates. There is no longer a "brand-new account" precondition: the check runs for every batch row, and `account_pair_distinct` is the mechanism that keeps the output non-noisy after the user has reviewed each pair. Account merges run `promote_in_group_suspects_to_confirmed` to graduate any pre-existing soft-flag whose two sides are now in the merged group, and `clear_account_pair_distinct_for_merge` to drop any prior distinct assertion between the now-merged accounts (the merge contradicts it). The same `promote_in_group_suspects_to_confirmed` also runs at import finalize (right after the sweep, scoped to the accounts the batch touched), so a batch importing into an account already merged with the matched account auto-confirms those in-group duplicates instead of leaving them for review — making import order and merge order interchangeable

- **evidence field roles decide what may be compared as source text** (`backend/services/import_evidence.py`, a leaf module because CSV import and sync *write* the role while duplicate detection *reads* it). Each `import_evidence_json.extra_text_fields` entry is either **descriptive** — high-cardinality free text that *names* the charge (a memo, an item title, a counterparty, the raw bank descriptor), where a match between two rows is real evidence they are the same transaction — or **categorical**: a value from a small repeated vocabulary (type, status, currency) *or* a structured datum that describes a row without naming it (a date, a check number, a provider's opaque merchant id). Only descriptive fields feed duplicate text matching, through the single predicate `evidence_field_feeds_text_match` that both text collectors go through. Only `categorical` is ever stamped, so an unmarked field — including every evidence blob written before roles existed — reads as descriptive. CSV import infers the role from the column's cardinality across the whole file; a sync has no file to measure but knows what it is writing, so `build_sync_evidence` stamps each field, leaving `Counterparty` as the only sync-captured extra that participates. **The failure this prevents:** every synced row records its second date as a captured field and both provider adapters emit it as an ISO date, so while `source_match_texts` admitted *every* captured value, any two synced rows on different accounts sharing an amount and that date matched byte-identically **on the date string** — flagged `cross_account`, the high-confidence tier that auto-confirms on merge, with entirely unrelated merchants. The date is also exactly the signal the sweep's ±7-day SQL gate has already spent, so the text gate was answering with the weak discriminator it exists to backstop. (`collect_duplicate_match_texts` had applied the role filter from the start; `source_match_texts` never did — an asymmetry between two collectors of the same thing, which is why they now share one predicate rather than each carrying its own copy of the rule.)

- **the soft-duplicate machinery now also runs on data-source sync and (freshly) on account merge, not only CSV import.** A **sync** stamps each newly-synced row with a `content_hash` (the same `make_hash` formula as CSV import, so synced rows become first-class dedupe citizens instead of the NULL-hash blind spot they were) and, after inserting a fetch's rows onto the connection's sync card (below), runs `mark_import_suspects` + `promote_in_group_suspects_to_confirmed` on that card exactly as import finalize does — closing the gap where a CSV/manual row re-fetched via a data source slipped through: the sync creates a *new* account record keyed on the provider handle (distinct from the CSV account until the user merges them), so the duplicate is **cross-account**, which same-provider-id idempotence never sees. An **account merge** additionally runs a fresh existing-vs-existing scan (`scan_scope_for_cross_account_duplicates`) over the newly-unified group *before* the promote sweep: import-time detection only ever compares an *incoming* row against what already exists, so a pair that both predate the comparison (e.g. a pre-existing synced row that ran no detection) is otherwise never looked at. The scan soft-flags each un-compared same-amount, source-text match (the same `source_match_texts` union basis as import — exact `cross_account`, near-miss `cross_account_fuzzy`, or shared-token `cross_account_weak`) within the ±7-day window between rows from two different **sources**, then the promote sweep confirms the in-group **exact** ones (reversibly, `auto_merge` — or `auto_cross_source` where the pair sits on one account); the review-only tiers are left flagged, never auto-confirmed. A **single** account is a legitimate scope for this scan, which the old two-account floor precluded: two sources can both report into one account, so a group of one still has pairs worth finding. Canonical choice keeps the more-curated row — a still-`needs_review` row (every synced row starts there) yields to a reviewed one, then earliest import, then id — so a re-fetched copy is the one trashed, not the categorized row it duplicates; a row already carrying a suspect pointer is never chosen as canonical, so no reciprocal double-flag is created

- **A connection records its own sync health, and the four fields mean different things.** `connection.last_synced_at` is the time of the last **successful** pull — the freshness of the *data*, not of the last attempt — so a connection that has been failing reads as stale rather than as recently synced. `last_sync_error` / `last_sync_error_at` hold the most recent failure and are cleared by any success. `consecutive_sync_failures` is what separates a transient blip from a connection that has stopped working; it is **reset** on success rather than decremented, because one good pull settles that question. `last_sync_warnings` (JSON list) is the odd one: problems reported by a pull that **succeeded** — one bank on a multi-bank credential needing re-authentication while the others delivered — which is the only failure mode a sync cannot self-correct or even notice, since by every other measure it worked. It is replaced each pull, so a bank that starts working again stops being reported with nothing to dismiss. All four ride `GET /api/providers` with the connection list rather than a separate call, because the Connections card must be able to say "this stopped working" **while collapsed**: a failure a user has to expand a card to discover is one they will not discover. *(Added in migration **v27**; a connection that predates it starts with `last_synced_at` NULL — "never synced here" is the honest answer, since nothing recorded the earlier syncs.)*

- **`txn.external_transaction_id` is the provider's own id for a transaction, and the key that makes a sync idempotent.** NULL for rows from a file import or entered by hand. A sync re-fetching a row it already holds finds it here and advances or skips it rather than inserting a second copy — which is what makes a re-pulled or overlapping window harmless, and therefore what lets a provider with no change feed be synced at all.

  - **It must be unique across the whole ledger, and the *adapter* is what makes that true.** The column is `UNIQUE` and all four sync lookups query it unscoped (no account, no connection), so an id that repeats across two accounts reads as "already held" and the second account's rows are silently dropped — the account imports nothing while the sync reports success. Plaid's ids are globally unique and need nothing. **SimpleFIN's are unique only within an account**, so its adapter namespaces the id by the (already provider-namespaced) account: `simplefin:<account>:<bank id>`, the same treatment `external_account_id` gets and for the same reason. This was not hypothetical — the Bridge's demo server derives ids from the posting instant and runs every account on one schedule, so two accounts issued byte-identical ids and the second imported nothing. **A new adapter must check its provider's uniqueness guarantee and namespace if it is per-account**; scoping the lookups instead would trade a real ledger invariant for generality nothing needs. `test_two_accounts_issuing_the_same_transaction_ids_both_import` holds the line, and the signature to recognize a regression is `added == skipped` exactly, with one account empty. *(Named `plaid_transaction_id` while Plaid was the only provider; renamed in migration **v26**, following `plaid_account_id` → `external_account_id` in v20. Backup payload **9** carries the new name and pre-v9 payloads are translated on restore — without that translation a restored row would come back with no provider id and the next sync would re-add it as a fresh transaction.)*

- **Data-source sync uses a cursor where the provider has one, and a bounded range pull where it does not.** `run_sync` pulls each connection's changes since a stored `connection.transactions_cursor` — an **opaque provider resume token**, not necessarily a cursor: a provider with no change feed stores whatever checkpoint its own resume needs (SimpleFIN keeps a JSON walk position there). **What a metered provider has spent is deliberately not in that token** — it lives in `connection.provider_request_budget`, because the two persist under opposite rules: a resume token claims data is held and so must roll back with a failed pull's un-inserted rows, while spending can never roll back, the requests having already been made. It is therefore passed to the adapter as a *mutable* record and written back in a `finally`, since a return value cannot carry a partial pull's spending back out of an exception — and a metered adapter whose spending is forgotten on failure overruns the provider's limit precisely when a user is retrying a broken connection hardest. Where a provider publishes a limit as "N per day, replenished through the day", it is modelled as a refilling bucket rather than a per-day counter (a calendar reset grants a full allowance immediately after one already spent, which is exactly what a backfill resuming night after night does), and where it grants *separate* allowances per request shape — SimpleFIN gives an unfiltered `/accounts` call and each `?account=` call their own — each is metered separately. It drains pages (`has_more`) in one call — **applying and committing each page before fetching the next**, so no write transaction is ever held across a provider call. That matters twice over. SQLite serializes writers, so a transaction spanning a multi-minute pull blocked every other request that writes until it timed out, which is what made the app route but not load during a sync; and a pull that dies now costs the page in flight rather than everything it had fetched. The one thing that cannot be applied per page is **removed**: processing every `added` before any `removed` is what converts a pending→posted pair in place, and that pair can straddle a page boundary, so removals accumulate across the drain and are applied once it ends. Per-page commits also make each page a progress checkpoint (`connection.sync_progress`, cleared when the run ends) and a resume point, and they are why targets are re-derived from committed coverage on every page rather than computed once. It applies **added** (insert — categorized + `content_hash` + the dedup sweep above), **modified** (refresh the provider-owned fields + hash, but leave the user's category/name edits), and **removed** (trash the row). A pending→posted transition converts the pending row **in place** — new posted id + refreshed fields, with the row's category/name/tag edits and identity preserved — matched on the provider's explicit `pending_transaction_id`; all `added` are applied before all `removed`, so the pending row's `removed` entry becomes a no-op. Backfill readiness is polled **without a webhook**: each call returns the provider's readiness signal, and the client re-syncs until nothing more is available *right now*, with `connection.initial_sync_complete` recording that the historical pull finished. **"Nothing more right now" and "the history is complete" are separate facts** and the adapter reports them separately (`backfill_complete`, `resume_later`): a metered provider can stop mid-backfill with history still outstanding, and it must say *stop polling* — more requests would only push it toward cutting the connection off — while the connection stays un-flipped so a later sync resumes. Marking it complete there would strand the un-fetched history behind a short routine look-back with nothing left to go back for it. Fetch depth is `days_requested`, capped by the provider's own `max_history_days` (Plaid ≈ 730; a provider that publishes none is bounded by its adapter's own stopping rule), from the user's per-connection history-window default (persisted as a `connection.historyDays` preference). **A routine top-up is distinguished from an initial/deepening pull by an explicit `full_history` flag, not by the depth requested** — both send the same `days`, and only a full-history pull may widen the coverage claim backward or (on a provider with no cursor) re-walk history rather than fetching a bounded recent window. *(The parallel CSV pending→posted reconciliation matches on account + date + source-text and **converts in place, preserving edits** — it never deletes and re-inserts, which would lose them. It depends on the import's `ColumnMap` carrying the `pending` column through to `parse_pending_flag`; drop that column and the whole path goes silently inert.)*

- **Sync import cards: one initial, then monthly by *transaction* month (`source_kind='connection_sync'`).** A connection's **first** historical backfill lands on a single **"Initial import"** card (`resolve_initial_sync_batch`; `config_snapshot.initial_backfill`), reused across the polling calls that make up that one pull rather than split across months — so a 24-month backfill stays one card. Once `initial_sync_complete` flips, routine syncs accrete onto **monthly period cards** (`resolve_sync_period_batch`, `sync_period='YYYY-MM'` in `config_snapshot`), keyed on **each row's own transaction date**, not the fetch date. One fetch may therefore write to more than one card. This is a correction, not a refinement: keying on the fetch month filed a July 30th transaction arriving August 2nd under "August 2026", and the month is the one property a user reads straight off the card. Card volume is unchanged for the daily-sync case — a fetch touches the current month, plus the tail of the previous one for a few days after rollover. Two consequences follow. First, **a card's date span is not a coverage claim**: a delta card can span all of July while holding only the three July rows that happened to arrive, and coverage lives on `connection_account` instead (below) — stated explicitly because the card *looks* like a CSV card, which does carry one. Second, **a row is filed once and stays put**: the card is chosen from the row's date at *insert*, and a later revision that moves that date — a pending charge dated by when it was made, settling into the following month — re-stamps the row without re-filing it. Deliberate, not an oversight: the card records which pull delivered the row, moving rows between cards after the fact would make an already-reviewed card's contents change underneath the review, and the drift is bounded to rows that settle across a month boundary. Third, **"reviewed" is not terminal on a delta card**: a late arrival re-badges an already-reviewed month, which is correct and already true of the current month today. All cards carry `connection_id` (indexed via `idx_import_batch_connection`) and the connection's `provider` key, written with the card because removing the connection nulls `connection_id` and a synced row should still name its connection afterwards (the origin hover then reads "Plaid (removed)"; cards whose connection was removed before the column existed, v55, stay unnamed). They are created **lazily on the first row the pull has something to say about** — an inserted row, a zero-amount refusal, or a row dropped for having no local account to land in — so a sync that genuinely found nothing leaves no empty card, while one that received data and imported none of it still has a card to report that on. (`row_count` is rows *received* — imported + skipped + deduped — exactly as on a file card, so a card whose entire content is dropped rows still counts them. It once counted only landed rows, which made the column mean two things on one card, since the history's reconcile re-derives it the file-card way.) **An already-held row is the deliberate exception**: it reaches no card and creates none. The other two are reported on a card because a card is the only place they appear at all — a dropped row is nowhere, a refused row is in no ledger — whereas an already-held row *is* in the ledger and a card entry would restate the transaction list; it is also the single most routine event a sync has (every top-up re-asks for recent days on purpose), so resolving a card for it would mint an empty one every month. They accumulate `row_count` / `skipped_count` / `deduped_count` + a per-account `import_batch_account` breakdown, and expose the standard per-batch duplicates + "Mark all reviewed" report. Two homes: the Import/Export history (one row per connection, its cards as the expandable batches) and a review badge on the Accounts → Connections tab. These cards have **no per-card Undo** by design — a sync isn't a discrete file event, and because the cursor has advanced past the rows, deleting them is not auto-recoverable by a normal re-sync; removing a connection's synced data is a **connection-level** action (`DELETE /connections/{id}/synced-transactions`) that also **resets `transactions_cursor` + `initial_sync_complete`** and clears the connection's coverage, so a later sync re-backfills. That removal **deletes** the connection's cards rather than leaving them as `status='undone'` tombstones the way a file's Undo does: a sync card records rows, not a user-supplied file, so with its rows gone and the cursor reset it records nothing — and both resolvers key on (connection, backfill/period) *without regard to status*, so a tombstone would be silently reused by the re-backfill and its rows would land on a card the history (`status='completed'`) filters out. It is available on a connection with nothing synced, because the case it recovers is precisely a sync that advanced the cursor while skipping every row for lack of a mapping. **A sync card emptied by any other route is deleted on the same reasoning**: deleting an account or emptying the trash recomputes each affected card's totals from the surviving rows (`delete_transactions` → `refresh_batch_totals`, `services/import_batch_totals.py`) and drops a `connection_sync` card that recomputes to nothing and holds no duplicate report — a CSV card in the same state is kept, because it records a file the user supplied and that stays true after its rows are gone. Without that, deleting the accounts a connection synced into stranded a zero-row card, and disconnecting afterwards (`connection_id` is `ON DELETE SET NULL`) put it beyond every cleanup path that keys on the connection, leaving it on Import/Export as an empty card labelled "Data connection" — the generic subheading the history falls back to when a card's provider can no longer be resolved

- **`import_batch_account.csv_value` for a sync card is the provider account *label*, not the opaque provider id.** "Source value" is simply whatever label a source uses to name an account, and a connection's is `"{provider_name} ···{mask}"` (`provider_account_label`). Three things depend on it: a sync card's per-account breakdown renders through the *same* `source label → mapped account` form a file card uses, with no connection special-case (the remaining `isConnection` branches in `ImportHistorySection` are about a sync being read-only — no rename/description/Undo — which is a real difference, not a labelling one), the ladder's source-scoped rules key on it, and the terminal-window matcher identifies a row's source account from the same label written into its `import_evidence_json.account.value`. Rows synced before this carry the opaque id and are rewritten by migration v24
- **a sync card's `import_batch_account` rows cover the accounts that received *nothing*, not only the ones that contributed.** A source account whose rows were dropped for having no local destination gets a row with `was_skipped = 1` and the count it dropped — the same shape the CSV path writes for a source value the user chose not to map, so `✕ Some Account 35` means one thing on both kinds of card. Written from the sync's own per-account tally rather than from what landed, because a breakdown built from inserted rows structurally cannot name an account that inserted none; the label comes from `provider_account_index`, which unlike the dedupe context's `label_by_external` keeps `skip` and unmapped accounts, since those are precisely the ones needing a name here. `row_count` is rows **seen** for the pair, landed or dropped — `was_skipped` already says which kind, and only a card outliving the sync that made it can hold both. That is the case the flush's two merge clauses exist for: `account_id` is COALESCEd so a later sync's dropped rows (no destination, so NULL) cannot erase a destination an earlier one recorded, and `was_skipped` is MINed so mapping a previously-skipped account clears the flag on the next sync that lands a row and nothing can set it back — "skipped" is a claim about the pair, and one row landing disproves it. No coverage columns are written, for the reason a dropped row cannot make a coverage claim at all: it was never held. **An account that is mapped but simply received nothing still has no row here**, and cannot: there is nothing to count. That asymmetry is real rather than an omission — a file is a closed set, so "present but not imported" is always countable, whereas a connection's silent account leaves no trace anywhere. Only the connection card can show it, by building chips from the accounts the connection *offers* (`docs/ui-patterns.md`)
- **an import card's counts must still add up after rows leave the ledger.** A card states its counts three times — the `import_batch` columns, the `import_summary` headline, and the per-account `import_batch_account.row_count` — and an import or sync writes them together, but a later hard delete (an account deleted, the trash emptied) was free to move some and not others: account chips kept counting a purged row, and a recount rewrote `imported_count` and `total_rows` while leaving the summary's `deduped_count` behind, so a card could read "83 rows" beside chips and a duplicates pill summing to 67. The invariant is that **a hard delete of imported rows goes through `delete_transactions`** (`services/import_batch_totals.py`), which takes each row off the per-account entry that counted it — found by the source label in the row's evidence (`''` for a single-account file), not by its current account, since a row moved after import is exactly the one the account would miss — and then re-derives the columns and all four headline figures from one set of parts (`refresh_batch_totals`, the same recount the history listing runs). The entry is decremented, never removed, because a file card's entry also carries the coverage claim duplicate detection reads, and that stays true after the rows are gone. A file's Undo, a connection's synced-data removal and a restore are outside this: each deletes the card's accounting along with its rows. So is an Amazon order reversal, whose card counts orders rather than received rows

- **"are these two accounts the same account?" is asked as a question about accounts, in two places, and never as a side effect.** A pile of cross-account flags between one pair of accounts is one question, not N: either the accounts are the same and the rows are duplicates, or they are different and every flag between them is a false positive. Both answers are terminal and both settle the whole pile, which is why it can be asked once. It is asked (a) at **mapping time** by the "Possible duplicate account?" chooser — where *Keep separate* now persists as an `account_pair_distinct` assertion via `distinct_from_account_id`, carried through `apply_account_mapping` (connections) and `new_accounts` (CSV) and recorded once the account exists; and (b) in the **duplicate report**, from `unresolved_account_pairs`, which names each pair still carrying unresolved flags and says whether a merge is even possible (`can_merge` — same type, compatible owners, neither already grouped; decided server-side so it and the Accounts page cannot disagree).

  What the two answers do differs, and the asymmetry is deliberate. **Different accounts** (`record_account_pair_distinct`) clears *every* unresolved flag between the pair whatever its tier, because if the accounts differ then all of them are false positives by definition — and the clearing is not a convenience but what makes the assertion self-consistent, since the assertion suppresses future detection and leaving the existing flags would have the same evidence read as a problem before it and as nothing after. **Same account** (a merge) auto-confirms only the *exact* matches and leaves the review-only tiers standing, because a near-miss inside one account is a genuinely open question — two similar real transactions, or one recorded twice — and trashing on similarity alone would destroy real data. A same-account pair is refused outright: a `(X, X)` row would be matched by the sweep's own `MIN`/`MAX` filter for every future candidate on that account, switching detection off there for good.

  This replaced a much worse arrangement in which **keep** carried the account decision. A button on a transaction row, labelled for what it did to that transaction, silently wrote a durable assertion suppressing detection between two accounts forever and cascade-cleared every other flag between them — so selecting five rows and clicking it resolved forty-two, making the bulk selection beside it a fiction, and the assertion it wrote had no screen anywhere to show or undo it. Assertions are now listed and reversible under Settings → **Distinct account pairs** (`GET`/`POST`/`DELETE /accounts/distinct-pairs`); forgetting one only re-enables checking and never revisits decisions already made about individual rows.

- **three stores describe a sync, and which one a fact belongs in is decided by who may lose it.** A connection accumulated several overlapping records of "what happened", and the resulting confusion was structural rather than cosmetic — the connection card's own summary was being derived from a debugging artifact. The split, and the rule for each:
  - **Connection status** — `connection` (cursor, last synced, last outcome + summary, request budget, error/failure state) and `connection_account` (coverage, history completeness). **Durable, and provider-shaped.** Each adapter genuinely needs different things here — a cursor provider keeps a resume token, a walking one keeps per-account coverage and a metered allowance — and that variation is expected rather than a gap to close.
  - **Diagnostic history** — `connection_sync_log`. **Best-effort and disposable**: pruned by age on every write, cleared wholesale from the UI. Nothing user-facing may derive from it. It carries what only a per-call record can explain — cursor fingerprints, requested windows, the allowance a pull left behind, the status sequence — and the app must remain fully legible after it is emptied.
  - **The bundle of transactions received** — `import_batch` + `import_batch_account` + `import_batch_duplicate` + `config_snapshot.import_summary`. **Behaves like a CSV import card.** The monthly-vs-per-file boundary is the expected difference; anything else is an exception that needs a reason (per-card Undo, rename, coverage claims — each argued separately above).
  
  Two defects followed from not stating this. `_sync_outcome` derived the connection card's pill, totals and per-account chips from the newest log row, so `DELETE /sync/diagnostics` — a debugging action on a healthy connection — erased the card's entire "Last sync" block; the outcome is now computed at sync time by `sync_outcome` and stored on `connection.last_sync_outcome` / `last_sync_summary`, written from the same assembled facts as the log row so the two cannot describe one pull differently. And the log stored **sums of itself**: `skipped_no_account` / `skipped_already_held` were column-wise totals of `account_counts` in the same row, while the one bucket that never got a column was recovered by subtracting the others *in the browser* — so every bucket added afterwards silently corrupted whichever was computed last. The buckets now live only in `account_counts` and are summed on read (`_skipped_breakdown`); the two columns are vestigial, written 0 and read by nothing, and removable whenever a rebuild of that table is otherwise worth doing.

- **`skipped` on a sync is four unrelated events, and only one of them is anyone's problem.** `skipped_by_choice` (the account is mapped `skip` — the user's decision being honoured), `skipped_unknown_account` (no mapping decision yet, or an account the provider added since), `skipped_already_held` (the incremental overlap re-asking for recent days, non-zero on every top-up by design), `skipped_zero_amount` (a refusal the adapter's declared policy chose). The split is taken where the row is counted, from `connection_account`: a `skip` row means the first, anything else means the second. **`attention` is reserved for a problem with no other surface**, which leaves exactly one — already-held rows that a *different* connection brought in, the outward appearance of a transaction-id collision. No-destination rows used to raise it and that was wrong twice: a `skip` account's alarm could never be cleared, so a correctly-configured connection reported a problem forever; and an account genuinely awaiting a mapping already raises the "N to map" badge from `connection_account`, so a second alarm added nothing. Where those rows *went* is a question about the bundle received, and it is answered per account on the import card.

- **Connection sync diagnostics (`connection_sync_log`).** A per-call record of provider syncs written by `run_sync` — and, despite the name, of every other operation on a data connection (see *Every connection operation* at the end of this entry) — for answering the two questions a connection cannot answer about itself: *did this sync fetch everything?* (the motivating case: an initial pull that stopped at the ~30-day Initial Update instead of running to `HISTORICAL_UPDATE_COMPLETE`) and *why did nothing arrive?* One row per (connection, `/sync` call): `status_sequence` (the adapter's `update_status` readiness signal across the drained pages — Plaid's `transactions_update_status` today), `final_status`, `became_complete` (the call that flipped `initial_sync_complete`), page count, added/updated/removed/skipped **deltas**, `mode` (`initial`/`routine`), `days_requested`, cursor fingerprints (never the full resume token — see below), `card_counts`, `requested_windows`, any `error`, and the two message lists below. The last two exist because a per-call total answers neither question a reader actually arrives with. **`card_counts`** (`[{card, added, id, imported_at}]`) names the import cards the rows landed on: a sync files each row under its *own* transaction month, so one call routinely writes to several cards while `added` reports one number — and against an Import/Export page showing one card at a time, a total that reconciles with nothing on screen reads as rows having gone missing. **`requested_windows`** (`[{start, end}]`) records the date ranges actually asked for, which for a walking, budgeted adapter is not recoverable from anything else: it may spend twenty requests and stop partway, leaving a resume checkpoint that says where it *ended up* rather than what it looked at. Both are optional in the page contract and empty for a cursor provider, which asks for "everything since this token" and names no window. **The governing rule is that a consumable's *level* belongs in the row, not only its effect.** Everything a sync advances or spends lives, by default, in a column the *next* sync overwrites — `connection.provider_request_budget` holds the metered allowance, `connection_account.coverage_*` holds each account's position. A log row that records only outcomes can therefore say a pull "paused on the request limit" while the limit it names is unverifiable and already gone, which is a record of what happened rather than one anybody can diagnose from. So three things are snapshotted per call even though they duplicate live state: **`request_allowance`** (`{capacity, refill_per_hour, pools:{pool key: tokens left}}` — an absent pool is a full one, and NULL means the provider meters nothing, which is *not* a measured zero), the **`pool`** each entry of `requested_windows` was charged to (a walk narrow enough to filter spends each account's own bucket while a wide one spends the shared bucket, so a bare request count reconciles against neither), and the **`reached`/`history_complete`** pair merged into each account's `account_counts` entry (where that account got to on *this* call, as against where it stands now). Relatedly, `update_status` distinguishes `BUDGET_PAUSED` from `RATE_LIMITED`: this client declining to ask and the server refusing a request are opposite failures — the second means the local accounting disagrees with the provider's — and collapsing them left the log unable to tell "working as designed" from "the model of the limit is wrong". **Provider-agnostic by construction** — it records only the neutral adapter fields from `services/providers/base.py`, so it serves any future aggregator unchanged, not just Plaid. The row carries a denormalized `provider`/`institution` snapshot, which labels it without a join. **Retention is by age** — a ledger setting (`connections.log_retention_days` in the shared preference scope, so it rides backups), default 30 days, 1–365, pruned on every write and at once when the setting changes — which, with the clear endpoint, is exactly why nothing user-facing may read from here (see the three-store split above). It replaced a cap of the newest ~500 rows, which let one busy connection push every other connection's history out of the log with nothing to say it had happened. The read endpoint derives each row's `skipped_breakdown` from `account_counts` rather than shipping counts for the client to reconstruct. Read/cleared via `GET`/`DELETE /api/sync/diagnostics`, and its retention set with `PUT /api/sync/diagnostics/retention`. The read takes repeatable `subject` (a connection id, or `connect:<provider>`) and `provider` filters, a row matching either being returned, so a scoped view does not ship the whole retention window to be filtered in the browser; it returns the newest `limit` (200) matches with their `total`. Opened from the **Sync log** button on the Data connections card (Import / Export → Import), beside the sync it describes, and reachable from each connection's ⋯ menu scoped to it via `?connection=<id>`. Accounts → Connections opens the same dialog in place: a provider card's **Sync log** button starts it filtered to that provider, and a connection's last-sync outcome pill to that one connection. **Excluded from the regular backup** — operational diagnostics tied to `connection` (itself credential data that rides the separate credentials backup, not the data backup), not part of the financial dataset a backup preserves.

  **Every connection operation, not only syncs** (`services/connection_log.py`). Each operation that talks to a provider on a connection's behalf writes one row, named by `event`: `sync`, `connect`, `reconnect`, `refresh_accounts`, `disconnect`, and the per-connection outcomes of an exposure response's credential `reissue` and a vault reset's `revoke`. A non-sync row fills only `error` and `detail` (a JSON object of its own facts: accounts offered, whether a disconnect revoked at the provider, a credential outcome) and leaves the sync columns at their defaults. On a failure of any kind of row, sync included, `detail.provider_error` keeps what the provider itself said — Plaid's error body, request id and documentation link among it, never the response headers — beside the readable `error`; the dialog shows it under the row's **Details** and *Copy for support* includes it. One log because they are one story — a sync failing the morning after a secret rotation is explained by the rows beside it. What is recorded is **the provider's answer**, not the app's own pre-flight refusals (vault locked, demo data loaded, not configured), which already say why in place and involve no provider. A Link session that errors in the browser is reported back (`POST /api/plaid/link-error`) so the connect it belonged to is not missing. **Two kinds of row have no live connection**, which is why v60 made `connection_id` nullable and removed its foreign key: a connect that failed before the provider issued one (`connection_id` NULL, filed under the provider's connect attempts), and a **disconnect**, which deletes the connection's other rows and keeps its own under the gone connection's id, so the log can still say when a connection was removed and whether access ended at the provider. The disconnect endpoint is the only place a connection is deleted, and it does that cleanup itself (`delete_for_connection`). v56 had once made the id `NOT NULL … ON DELETE CASCADE` because rows kept with the id *nulled* collapsed into one pill that could not filter; keeping the real id is what avoids that here. Don't re-add the cascade: it would delete the disconnect row the moment it was written.

  - **`warnings` and `advisories` (both JSON, added in migration v31) are the "why did nothing arrive" half**, and they split by *who can act*, the same rule the connection card uses. `warnings` are user-actionable bank-level problems and mirror what the card shows; `advisories` are `[{message, count, context}]` for things nobody can act on — what the provider said about *our own request* (a date range wider than it recommends), plus the sync layer's own notices that rows had nowhere to go (an unmapped non-ledger-currency account, newly discovered provider accounts skipped until mapped). `count` is how many of the call's requests drew the same remark: a windowed history walk provokes an advisory on every one of its ~24 requests, and "24 times" says the whole walk was affected rather than one stray request. `context` names one concrete request that drew it (the first — e.g. `fetching 2023-11-22..2024-01-06`), which the message alone cannot. **They are separate fields deliberately**: the message is the aggregation key, so folding the request into it would give every window its own entry and destroy the count. The card deliberately shows only `warnings` — a note about our request shape sitting beside "your bank needs re-authentication" teaches the user to ignore both — but *not worth a card* was never a reason to leave something unrecorded, which is what the log now fixes. The console (`log_warning`) keeps receiving all of it; it simply stopped being the only sink.

  - **The cursor fingerprint has two shapes, because `transactions_cursor` holds two different things.** Plaid's is an **opaque** paging token, where `len=<n>·<first 8 chars>` is the only marker available. A provider with no change feed stores its own **JSON checkpoint** there instead, and slicing that yields `{"throug` — meaningless, indistinguishable from a truncation bug, and hiding the fact worth having (how far the walk reached). A checkpoint is therefore summarized as its own short scalars: `through=2026-08-08`. Values longer than a date or a count are elided — parsing as JSON does not make a token non-secret, so "never store the whole thing" holds for both shapes.

  - **`skipped` is several unrelated events** and is recorded split, per provider account, in `account_counts` — keyed by the *provider's* account id rather than the local one, because a tally built from what landed can never name the account that received nothing, which is exactly the account worth naming. The buckets and the rule that decides which one an alarm may read are above; the column-wise totals that used to sit beside them (migration v32's `skipped_no_account` / `skipped_already_held`) are vestigial.

  - **`already_held` is a contradiction only when another connection brought the row in, and is judged by who, not when.** A connection re-seeing its own rows is routine however it happens — the top-up's overlap, a metered backfill resuming across many syncs, a walk's overlapping pages, a restore that clears the resume point and puts every synced row back — so the bucket that counts is `skipped_held_by_other_connection`: rows whose import card belongs to a different, still-existing connection. That is what a transaction-id collision looks like from the outside (see `txn.external_transaction_id` above), and it is the signal that would have caught that bug on the first sync rather than the third. It was once judged by timing (no resume point meant a first pull, which could hold nothing), and the first sync after every restore then reported the connection's entire history as a collision with itself. A row whose card has lost its connection (the connection was removed) is not counted: a reconnect re-offering it is that account's earlier data coming round again.

  - **The connection card's last-sync summary is NOT derived from this log.** It once was — `list_connections` joined each connection's newest row — and the consequence was that clearing a debugging view blanked the "Last sync" block on a healthy connection, because a capped, prunable, user-clearable buffer had become a user-facing contract. The outcome word is now computed at sync time by `sync_outcome` and stored on `connection.last_sync_outcome` / `last_sync_summary`; both records are written from the same assembled facts in one call (`_record_connection_last_sync`), which is what preserves the original guarantee that the card and the log cannot describe one call differently. The vocabulary still names the *effect on the user's data*, not the mechanism: a walk that stopped on the provider's request budget is `incomplete` — "more history to fetch" — because "budget paused" means nothing to someone who doesn't know the provider meters requests.

  - **A pull's own rows are recorded on the connection, capped, so "review what just arrived" is answerable.** A synced row's only lasting provenance is its import card, and a card is per-(connection, calendar month): it accretes across every sync of that month, so filtering by it answers *what did this month receive*, never *what did this pull bring*. Nothing on `txn` records which sync delivered it — there is no `created_at` and no run id, and the id lists a sync builds (`card_added_ids`, `touched_ids`) live only for the duration of the call. `last_sync_summary` therefore also stores `cards` (`[{id, label, added, imported_at}]` — the id is what lets a surface *open* the card rather than merely name it) and `row_ids`, the rows the pull added or revised. Three rules govern it, and each is avoiding a specific way this goes wrong:
    - **Past `_SCOPED_SYNC_ROW_CAP` (250) the list is dropped whole, never truncated.** A partial list is a report that misstates its own extent. The fallback is the card itself, which at that size is the better report anyway: the only pull that exceeds the cap is a first backfill, and a backfill already lands on one dedicated "Initial import" card that isolates it exactly. The cap is a judgement about the *report* — past a few hundred rows nobody is categorizing them one at a time — not a limit of the query.
    - **The ids are never published.** `list_connections` projects the summary through `_projected_sync_summary` and sends `scoped_rows` (a count) instead. `GET /api/providers` is **polled** for the duration of every sync, so the ids would ride every poll, for every connection, whether or not anyone opened the report. The report is served by connection id instead: `sync_connection_id` on the transactions filter expands the list in SQL (`json_each` over the stored summary), which also keeps it out of a query string that would otherwise carry ~10KB of uuids on every page and every sort, and puts it in the **shared** filter builder so the list feed and the bulk endpoint resolve the identical set.
    - **Every missing case collapses to zero rows, not to the unfiltered set.** No summary, a summary written before this existed, a dropped list, an unknown connection id — a scope that silently widened to the whole card would misreport the pull, which is the one thing the report exists to get right. The row set is also **replaced every pull**, which is what makes it "the last sync" and not an audit trail; the rows themselves remain on their card.

    `removed` rows are deliberately outside the scope: they are trashed, so a report cannot show them and offering to categorize a row that has left the ledger would be nonsense. And this list is **not** copied to `connection_sync_log` — a 500-row ring buffer would retain the ids 500 times over for a report only the newest pull can serve, and a user-facing report may not rest on something `DELETE /sync/diagnostics` erases (the same rule that moved the outcome word here).

  - **It is deliberately not behind `LUMA_DEVELOPER_OPTIONS`** (it was until 2026-08-08, *including writes* — so enabling the flag after trouble produced an empty table and the user had to reproduce the failure to learn anything, which is backwards for the one case the log exists for). That flag gates **destructive dev reset tools** and stays env-only for the reasons in `docs/operations.md` -> "Considered and rejected"; this log is read-only, is the only in-app answer to "why did this connection import nothing?", and is what a user attaches to a help request. It inherited the gate by having been added as a neighbouring Settings card, not by needing one.

- duplicate rows within the same CSV are allowed

- **coverage has two shapes, and both are correct.** A **file** stores its trusted window plus its terminal date per raw account label on `import_batch_account`: a file's claim genuinely *is* per-batch ("this file covered this range"). A **data connection** stores `coverage_start_date` / `coverage_through_date` on `connection_account` instead, because a cursor delta is **not a date range** — it is "everything new to us since checkpoint C", an arbitrary set of rows scattered across whatever dates they carry, so no window computed from what a delta happened to contain means anything. What *can* carry a claim is the chain: `transactions_cursor` + `initial_sync_complete` together assert "every change the provider has reported, back to the backfill window, is in the ledger", which is a stronger claim than any per-card one and belongs to the account over time. A **range pull** (the initial backfill, or Fetch more history) establishes or extends `coverage_start_date` backward; a **delta** only advances `coverage_through_date`; a **failed** sync advances nothing, so coverage simply stops growing — self-correcting, with no staleness flag to maintain; a cursor reset clears both. Which of those two paths runs turns on whether the adapter **reports** per-account coverage, never on whether the report is non-empty: an adapter that keeps no per-account coverage (a cursor provider) licenses recording the depth that was *requested*, while a walking adapter reporting an empty set is saying this pull reached nothing new. A walking provider reports exactly the empty set once every account's history is complete, so reading the two as the same thing made "Fetch more history" on a finished connection claim the whole requested depth — years — for accounts nothing had fetched. A per-account `coverage_start_date` therefore carries a second meaning worth stating: **its absence on a mapped account identifies one that joined the connection after its history was fetched.** Every account present during a range pull came away with a start date, so a mapped account with none was not there at the time — which is how such an account is picked up by the next history pull without anything having to track newcomers or schedule work for them. (`skip` is excluded: it has no destination to fill.)

- **`connection_account.history_complete` is a different claim from `coverage_start_date`, and only it may stop a search.** Coverage says how far back data has been fetched; it cannot distinguish "the account's history ran out" from "we stopped at the depth asked for" or "we ran out of request budget". Only the first means there is nothing older, and only it may prevent a later, deeper request from looking again — so it is stored separately rather than inferred. `history_empty_streak` is the per-account form of the two-empty-windows stop that concludes it (one empty window is a quiet period; two is the end of history), persisted so a walk that pauses resumes counting rather than starting the streak over. Both are per account because a connection's accounts do not advance together: one added on the provider's side later starts with no history while its siblings are years deep. *(Added in migration **v28**; existing rows take `history_complete = 0` — "we have not established that this account's history has ended" — which costs one extra window on the next deep pull, where the opposite guess would leave history that is never fetched again.)*

- **the ledger holds one currency at a time, and which one is a user setting.** The constraint is *one*, not *USD*: `txn.amount` is a bare number with no denomination stored beside it, so two denominations saved together are indistinguishable and both join every total, budget and report. There is nothing to convert *from* and no rate source to convert *with*, so face-value import of a second currency is the one option that silently corrupts arithmetic. The value lives in `import_workflow_state` under `ledger_currency` (workspace-wide shared state, not `ui_preference` — everyone reads the same numbers, and a per-user copy would be orphaned by a restore into another profile), is read through `services/ledger_currency.py`, and reaches provider adapters as the `ledger_currency` argument to `fetch_transactions_sync` — the same "the caller owns the database, so it owns the facts in it" rule that governs `account_targets`. The frontend's counterpart is `MONEY_DISPLAY_CONFIG.currencySymbol`, applied at boot from the same setting and derived via `Intl` rather than a hand-kept table. **A date-format setting is the opposite case and belongs in `ui_preference`** — two people can legitimately prefer different date orders while reading the same ledger, where they cannot prefer different currencies for the same numbers. Do not "make them consistent": they sit on opposite sides of the dividing line below because the questions differ, and the date half is not built (see Open).
  - **The question is "does this match the ledger", never "is this dollars".** A consistently-AUD ledger is entirely correct; only *mixing* breaks. An earlier version compared against a hardcoded `"USD"`, which would have discarded every transaction belonging to a non-US user whose data was never wrong — so **nothing outside `ledger_currency.py` may compare against `DEFAULT_LEDGER_CURRENCY`**, or the setting becomes decorative and the bug returns.
  - **Changing it converts nothing** — no amount is rescaled or rewritten, so the change is instant and perfectly reversible. That is also what makes it dangerous: it silently relabels every historical figure. `PUT /api/currency` therefore answers **409** (`currency_change_needs_confirmation`, carrying from/to and the row count) when the ledger already holds transactions and the caller has not confirmed; an empty ledger changes in one click, since there is nothing to relabel and that is the first-run case.
  - **Multi-currency is a separate, much larger change** and this is not a down payment on it: holding two at once needs a per-row currency column, a rate source with historical rates, and a decision about what a total spanning currencies means.
  - **Both adapters report it, at the level their provider states it.** SimpleFIN carries a currency per account, so a mismatched account is dropped whole and never becomes a walk target. Plaid carries one per *transaction* (`iso_currency_code`, or `unofficial_currency_code` for crypto and currencies it does not officially support — which can never equal an ISO ledger, the right answer for them), so its adapter filters `added` and `modified` row by row. Both report the same `unsupported_currency` map, and the one place the difference *does* reach the sync layer is what the user is told, which each adapter declares as `currency_scope`: a per-account drop warns that the account "is held in" the other currency and cannot fill, while a per-transaction drop says that *some* of the account's transactions were not imported — the account-level sentence is false for a wallet that holds one foreign charge among dollar ones.
  - **A file states currency per row, through an optional mapped column** (`column_map.currency`). Mapped, a row whose cell names another currency is refused and listed on the import card as a rejected row (`kind: "currency"`, counted in `currency_rejected_count`), the same visible refusal a $0 row gets; a blank cell states nothing and is taken to be the ledger's. Unmapped, nothing is judged, which is right for nearly every export, since nearly none carries the column. The mapper suggests a column headed *Currency*, so a wallet export that does mix currencies costs nothing to set up. Refusing rather than importing matters twice over for a wallet: a £10 subscription imported as $10 is wrong in every total, and its real cost — the $14.21 charge on the funding card — can never pair with it as a duplicate because the amounts differ.
  - The provider's stated denomination is recorded per account as `connection_account.provider_currency` at connect/refresh time — **before** any mapping decision, so the mapping grid can warn instead of letting the user create an account that can never fill (migration **v29**; existing rows take NULL). **NULL means "not stated", never "not ours"**: the field is optional in the protocols, and rejecting an account over a missing field would discard real data on a formatting gap — only a *stated* other currency is unambiguous. Such an account is excluded from `_build_account_targets`, which matters for correctness and not only cost: a target that can only ever be discarded would come back with `coverage_start_date` set and its empty-window streak climbing to `history_complete`, both asserting there is no data over a range where there plainly is — the over-claim shape above, reached by a different route. The user-facing warning is driven by the **stored** currency rather than by what a given pull discarded, because the walk narrows a request to a single account whenever only one still wants history, and a warning that appears or vanishes with the shape of an unrelated fetch teaches the user that its absence means nothing. Only *mapped* accounts warn; unmapped ones are logged, since their rows are dropped regardless and there is nothing there to lose.

**A range pull claims what it actually reached, not what it asked for, and per account**: the adapter reports `account_coverage`, and only where it cannot say does the caller fall back to the requested depth for everything synced (right for a cursor provider, whose maintained window *is* the requested one and is the same across the item). Both halves matter for a provider that walks history in windows and can stop early — out of history, or out of request budget. Claiming the requested depth would assert coverage over a range nothing fetched; spreading one figure across every account would do the same to accounts a filtered pull never touched. Coverage that overstates itself makes the ladder hard-reject genuine transactions — concretely, a later CSV import of that period discarded as duplicates of rows that were never fetched. Sync cards therefore write **no** coverage columns at all. `build_dedupe_context` reads the **union** of both shapes, so the ladder sees one coverage picture regardless of which recorded it. **A walking adapter's request bounds are instants while its coverage claim is per date, and the two have to line up.** SimpleFIN's windows abut — each one's end date is the next one's start date — so only the window holding the pull's *newest* bound closes at 23:59:59; every older one ends at midnight, where the window forward of it already covers the rest of that day. Closing them all long instead was not a correctness bug (the insert is idempotent on the provider transaction id) but it re-fetched the boundary day in full and, since the bounds are instants, made a nominal N-day window N days plus 23:59:59 on the wire — enough to trip the Bridge's own same-sized range advisory. The newest window is the one place the long bound is load-bearing: nothing covers the rest of today, so a midnight end there would leave anything posted since midnight outside every window ever requested while coverage went on claiming the day — the over-claim shape this whole bullet is about, reached through the clock instead of through the calendar

- **the terminal *window* generalizes the terminal day, and a source is assumed to lag unless it says otherwise.** Coverage stops short of a source's last date, and those excluded days are reconciled one-to-one (Rule 5) rather than blanket-rejected. The original premise — that only the export *day* is partial — turned out to be the special case rather than the rule: **most sources lag the thing they describe.** An aggregator (Monarch, Fidelity, any data connection) is itself waiting on the bank, so an export dated the 27th can be missing a 25th transaction it had not yet ingested; only a first-party export of records the source itself created (Amazon, PayPal) genuinely has no lag. So the covered range ends at the **last date the source actually carries** that is still before `terminal_date - (terminal_window_days - 1)` — the window sets the bound, but coverage never claims a date the file does not contain, so widening the window moves the end back by more than the window's own size whenever the file's last dates are sparse. Every day in the window gets a candidate slot, and the **default is the lagging case (7)** for CSV sources and connections alike — with **1** available as the explicit opt-out for a first-party source. The setting is a property of the source: `csv_import_profile.terminal_window_days` for a saved CSV data source (surfaced in the data-source editor as how many days it lags the bank), `connection_account.terminal_window_days` for a connection, applied to the trailing edge of `coverage_through_date`. **The two halves must be kept together, and for a connection they were not.** Candidate slots were built solely from `import_batch_account.terminal_date`, which a sync card deliberately never writes (a cursor delta is not a date range), so a connection received the coverage carve-out with none of the reconciliation it exists to enable — a `terminal_window_days`-wide hole at the leading edge of every connection's coverage in which neither the coverage rules nor Rule 5 could fire, and through which a second source's copy of a charge imported silently. `build_dedupe_context` now derives a connection's slots from its own claim (`coverage_through_date` + `terminal_window_days`, candidates being that connection's rows on those days), keyed into the same two indexes a file's rows feed. Slots are registered *before* the coverage computation bails on a connection whose range is entirely inside its own lag: proving no range is not the same as having no rows to reconcile against. The self-exclusion asymmetry is unchanged — a connection reconciles against every source but itself, because a delta inside its own window is a late-posting charge, not a re-import.
  - **Why the default is the wide one — the errors are not symmetric.** Too *narrow* a window blanket-rejects a real transaction the earlier export had not caught yet: it never enters the ledger, and the only trace is a "covered, no specific match" line in that file's duplicate report. Too *wide* a window costs one extra one-to-one reconciliation pass over a few more days, which still catches genuine duplicates *and names the row it matched* — a better answer than "date covered" either way. The window is also a far weaker discriminator than the text match running alongside it. 7 is the same evidence-derived bound as `CROSS_ACCOUNT_DATE_WINDOW_DAYS`: measured posting skew between two sources describing one charge reached +6 days.
  - **A coverage reject's candidate list is filtered *relatively*, not absolutely (`_display_candidates`).** The lookup finds candidates on amount and date alone, so the report has to decide which of them are worth showing as "this is what the row duplicates". A candidate is kept if it agrees textually (exact / fuzzy / weak), or if there is no text on one side to compare at all — a nameless money-movement leg agrees with nothing by design, and silence is not disagreement. The third rule is the one that matters: an exact-date or ±1 candidate with **no** textual agreement is kept **only while nothing else in the list has any**. That band genuinely is the case the lookup was built for — two sources routinely describe one charge with no shared text whatsoever (a bank's terminal string against an aggregator's cleaned merchant name) — but stated as an absolute rule it cannot tell that case from a coincidence arriving close in. Three same-amount charges on adjacent days each listed all three candidates at equal confidence, with each row's real twin (identical wording, matching amount, a day away) buried among two unrelated charges. Once *some* candidate agrees textually, a better explanation is already present and the wordless neighbours become exactly the noise the filter exists to remove. The kept list is then ordered by **tier, then date distance** rather than date alone, so the row a reader checks first is the one most likely to be right. All of this is display-only and applied **last**: `_coverage_reject_verdict` sees the complete list, so nothing here changes which rows were rejected or why.
  - **Within one batch, a worded same-day claim outranks a near-date guess at the same row (`release_contested_candidates`).** Each row's lookup judges that row alone, so two rows of one file can both name one existing row — and one file does not describe one transaction twice. The case that found it: a wallet purchase and its refund two days apart, each with a nameless card leg of the same amount beside it in the wallet's export; each leg's only same-amount row in reach was the *other* day's purchase or refund, while that row's own same-day, same-wording twin was claiming it. Auto-enrich then folded the leg's `Type` into the wrong row, and a refund reading "General Card Deposit" sent the PayPal reconciliation looking for a card charge that does not exist. So before the report is saved and enrichment runs, a candidate is dropped from a row's list when another row of the batch names it as its **only** match, **in agreeing words** (or as a specific ladder match), **more strongly** — tier, then date distance. A row left with nothing reads as `no_match`, and `refresh_unexplained_coverage_candidates` honours the same claims when it looks wider. Two guards hold it to what it is for, and both were measured: a **cross-account** candidate is never released (a file carrying both legs of a PayPal payment rightly points two rows at one card charge, in two senses — releasing those turned ~45 settled rows on a real ledger into review work), and a **wordless** claim releases nothing (a same-day neighbour with no shared text proves no more than the guess it would displace). With both, the real ledger's stored reports change in 8 rows. Verdicts are untouched.
  - **Enrichment refuses a row that states a different kind of transaction (`import_enrichment._conflicting_kind`).** A captured `Type` is the source's own word for what the row is; when both sides carry one and they name different kinds — payment, refund, wallet funding, wallet withdrawal, other money movement, compared by kind because two exports spell one type differently — nothing of the incoming row is folded in. It cannot stop a *first* enrichment, since a row with no captured type has nothing to disagree with; the batch claims above are what keep the wrong row from being reached at all.
  - **Two safeguards divide this space; know which one catches what.** A *named* row inside a covered range that matches **nothing at all** was already falling through and importing before the window widened (`_coverage_reject_verdict`, for the wallet-funded-payment case). What that escape cannot rescue is a row colliding with a **coincidental same-amount** row elsewhere in the range — the collision counts as a candidate, so the row is rejected. It no longer costs the row its *explanation*, though: once the text tiering empties the displayed list, the ledger probe runs again for the report and names the corroborating charge if one exists (the verdict is untouched — the row stays rejected either way). That collision case, plus nameless money-movement legs, is what the trailing window actually rescues. Worth stating because a test that widens the window and asserts "the row imports" will pass with or without the change unless it constructs the collision.
  - **A source that does not outrun its own lag covers nothing** — correct, not a bug: it has proven nothing, so it must blanket-reject nothing. Its rows still reconcile one-to-one. This is why a short export no longer establishes a coverage claim at all, and why the dedupe fixtures span more than a week.
  - **The narrow setting is not reachable by accident.** A stated window below 1 clamps to 1 (a window under 1 would push coverage *past* the source's own last date); an absent or unreadable one takes the default. The two are deliberately distinguished, so a stray `0` cannot be read as "unset" and handed the widest window of all.
  - **Migration v25 flipped this**, rewriting the rows v24 had written at 1. That rewrite was sound only at that moment: the setting had no writer of any kind until the data-source editor gained the field, so every stored 1 was a column default rather than a decision. Afterwards a 1 *is* a decision — and, being byte-identical to the old default, it is protected only by `run_post_restore_data_init`'s version gate, not by its value. Note also that SQLite cannot change a column default in place, so an upgraded database keeps `DEFAULT 1` in its DDL where a fresh one has 7; this is harmless **because every insert path states the column explicitly**, and a new writer that omits it would silently create no-lag sources on upgraded databases only

- the coverage-window, terminal-window, and text-strategy medium-confidence rules only hard-dedupe against prior coverage when the receiving account itself appeared in that coverage (or was explicitly declared an alias of an existing account — today only a `connection_account` mapped `existing`, i.e. "this provider account IS that local account"); a brand-new sibling account inheriting only its linked-group's coverage does not satisfy the precondition and the row passes through to the soft-duplicate review instead, because the prior import provably did not contain transactions from this new account and "covered" cannot mean "covered for this account." Exact content-hash matches are unconditional — same date+amount+payee is high-confidence enough to drop regardless of which account the receiving row lands on

- **a connection's own coverage is excluded when that connection is the one ingesting**, and the asymmetry is load-bearing. A CSV re-import of an already-covered range **is** a duplicate — the user handed over the same range twice. A sync delta inside its own connection's covered range is **not**: the provider has just reported a late-posting charge, and the claim was only ever "everything the provider has told us about is here", never "nothing more will arrive for these dates". Without the exclusion every late arrival would be rejected against the connection's own coverage. Coverage from *other* sources — a CSV, another connection — applies to a sync unchanged, and is what catches a re-fetch of rows already imported from a file

- saved data sources keep reusable import mapping defaults plus a default `use_imported_categories` flag for future files from that source; in the UI this is exposed as whether categories present in the data should be used by default

- saved data source names must be unique after trimming and case-folding so source pickers never show ambiguous duplicate labels

- saved data sources remember the last template filename/hash used while editing them, but loading a fresh template file remains an explicit user action

- each completed import batch stores whether that specific file used categories present in the data, along with any owner or unassigned-account filtering used for that scope

This separation exists because the reusable default and the actual decision for one file are not the same thing. A source may usually provide useful categories while a specific file from that source still needs to be treated differently, and undo/review flows need the exact per-batch choice, not just the profile default.

- imports that use categories present in the data can assign real `category_id` values to imported transactions, lock those assignments against *automatic* rule reruns (an explicit per-rule apply can still reclaim them — the preserve-manual variant, used after a merge/replace and when accepting an import-rule suggestion, does so while sparing manual edits), and treat those rows as learning input for future rule suggestions. Accepting a suggestion auto-applies the rule's outputs (category / rename / tags) to *only* the rows that generated it (a preserve-manual apply scoped to that suggestion's `source_row_ids`), so conflicting rows owned by other suggestions and Preserved manual exceptions are left alone rather than reassigned. The accepted review entry stores whether that save created a rule owned by the suggestion, plus the rows' pre-apply categorization snapshot; returning that accepted entry to pending uses those persisted facts to remove only the owned rule and put the rows back into the suggestion pool. Editing an already-accepted suggestion redraws that accepted row partition: newly matching rows are added to `source_row_ids` and to the restore snapshot, while rows that no longer match are restored immediately to their original imported/manual state so they can regenerate as pending suggestions instead of remaining stranded as rule-sourced rows
- each review action — accepting (including editing an accepted suggestion), changing a status, resolving a conflict set — is **one transaction across the rules, the rows and the review state** (`routers/import_export/rule_suggestion_actions.py`), so a failure part way changes none of the three. A same-matcher rule that assigns something different is an expected outcome rather than a failure: that suggestion stays pending and the rest of the request commits. Each action answers with the undo payload that reverses all three together — the prior review entry and status of every suggestion it touched, the first-captured categorization of every row it changed (including rows an opted-in *apply to existing* reached, which `accepted_prior_rows` does not hold and a return to pending therefore does not restore), and the rules it created or trashed. Undo trashes a created rule rather than deleting it, so it stays recoverable, and it **does** reverse a change to a rule the review did not create — an accepted suggestion's rule edited in place, a merge into a pre-existing rule, or *Replace existing*. Every pre-existing rule an action writes to is snapshotted whole (the row plus its tags) before that write, including one a collision merge folds away and deletes, which undo re-inserts; restoring writes the pre-edit matcher, which by construction did not collide with the rule that survived the merge. A re-created recurring series does not recover its cadence (it resets to monthly), the same accepted edge as restoring a trashed rule. **Every control on the review that writes transaction categories is one of these actions**, including the resolve banner's offer to re-apply a rule a merge or replace repointed to everything it already matches (`…/rule-suggestions/apply-rules`, preserve-manual, all the named rules in one transaction). That offer reaches rows *outside* the suggestion that changed the rule, so routing it through a bare rule apply left the largest write on the screen as the only one with no captured prior state and no undo entry. Rule applies **elsewhere** — the Rules page, the row menu's rule modal, the post-import suggestion toast — deliberately stay bare `POST /rules/{id}/apply` calls with no undo: those surfaces offer undo for nothing, so an undoable apply there would be the anomaly, where on the review it was the one control lacking what all of its neighbours had. The payload is **exact rather than replayed** — replaying statuses through the review write re-ran an accept's side effects and could not reinstate a trashed rule — and there is deliberately **no route that writes review state on its own**: that primitive is what let a page action change the three stores non-atomically, so review-state writes exist only as the half of an action that `record_rule_suggestion_review` performs inside the action's transaction
- accepted, deferred, and discarded rule-suggestion entries are review artifacts, not live mirrors of the rule table. Clearing one of those settled piles removes the entries from the active review and stores them as one restorable trash set for that clear action (surfaced as the **cleared sets** pill — named for the action that fills it, and counting *sets* rather than suggestions like every other pill). Restoring a set returns every suggestion in it to its prior review status. Clear/restore never creates, deletes, or edits live rules and never mutates transactions; it only prunes or rehydrates the persisted review-state entries so long-lived import reviews can be kept compact without losing a short-term recovery path
- those imports promote missing imported category names into real leaf categories under the protected `Unassigned` group instead of keeping a pending review list
- imported labels that only mean "still uncategorized", such as `Uncategorized`, `Uncategorised`, or `Unassigned`, should not create real categories; those rows stay at `category_id = NULL` so the app has one canonical uncategorized state
- reporting and category-management surfaces may still split that one `NULL` state into synthetic expense-side and income-side buckets based on transaction sign, but those are presentation buckets rather than stored categories
- those imports match an imported label against existing **leaf** categories only: a label that matches an existing leaf reuses it, otherwise a new leaf is created under `Unassigned`. A top-level group that happens to share the label is *not* treated as a match (it is not assignable), so an imported `Miscellaneous` becomes a `Miscellaneous` leaf rather than being folded into a `Miscellaneous` group
- a label matching an **inactive (deleted)** leaf is suppressed: the row imports uncategorized (`category_id`/`category_source` left NULL, `imported_category` retained), no new leaf is created, and the inactive leaf is *not* resurrected. This is what makes a deletion durable across re-imports — a deleted label keeps landing uncategorized instead of repopulating the organize pool. The match is name-based, so reactivating the leaf (which restores it under `Unassigned`) lets future imports of that label adopt it again. A **set-aside** (still-active) label is *not* suppressed — imports keep categorizing to it, because set-aside only parks the category, it does not remove it

- **categorization precedence at import is `mapping → rule → imported label → uncategorized`, and it is deliberate.** The user's own rules run *before* the file's category: when a rule categorizes a row it is stored under the rule's category and the file label is **not** promoted into a category for that row (it would be an empty, unused category). An explicit per-label mapping from the review screen outranks rules; the imported label is adopted (and lazily created) only for rows nothing above claimed, and only when the source/batch is flagged to use imported categories. Tag-only rules still apply their tags while leaving the category open for the label fallback. The raw label is always kept on the row as `imported_category` text regardless of which category wins, so it survives for audit (surfaced in the transaction detail's Origin → "Show more"). The same precedence governs the post-import per-batch "use imported categories" toggle, so enabling it later fills only rows no mapping or rule has claimed — it never overrides a rule. **It also holds after import, whichever arrived first:** a rule created later reclaims a row holding its file category on the next Run categorization, and a scoped reconcile that releases a row returns it to its file category rather than to uncategorized (both under *How an existing transaction's category can change*), so the order of the rule and the file never decides the outcome.

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

- target **== the winner's category** → the rule owns those rows: they ride in the same preserve-manual rule apply as the winner's own rows (the accept's scoped preserve-manual apply), so `import` rows are reclaimed to `rule` at once (later edits to the rule propagate to them via Run categorization);
- target **== another active leaf, different from the row's imported category** → kept as a manual exception there (`settle_rejected_suggestion_rows` in `keep` mode with that `category_id`), the "keep these, but as a different category" case;
- target **== the row's own imported category** (unchanged) → left at `import` (keeping the file's category is not an override; see Rejecting a rule suggestion above);
- target **emptied** → `cleared`.

With **no winner** chosen, every member is settled to its target (`keep`) — the "no rule, keep everything as imported (or as edited)" path: members left at their imported category stay `import`, members re-pointed to a different category become `manual`. The whole set commits in one combined Undo entry (prior member review statuses plus the row snapshots of rows that actually changed, including rows reclaimed by the winner's rule). Only the winner's rows and rows re-targeted to the winner become `rule`-owned; a re-pointed keep becomes a `manual` carve-out the rule must not touch, while an unchanged keep stays `import`.

When a conflict-set action changes a member's row categories, the review entry also keeps a compact `review_action` summary of the category transition (grouped counts from original category to applied category). This is display history, not category truth: transactions remain at their current category, and restoring an individual discarded/deferred suggestion does not automatically roll rows back. The settled views use this metadata to preserve context such as `Lunch (was Food & Dining)` after several formerly distinct buckets have been re-pointed to the same target category.

All suggestions for one displayed merchant render together in the review inside one **bordered merchant container** (the container appears only when a merchant has >=2 distinct items; a lone card or a lone conflict set renders bare). The grouping key is each suggestion's `review_group_id`, computed by the review response over the whole returned list (`_assign_rule_suggestion_review_groups`) so the page parses no ids. It favors the normalized merchant label, falling back to the keyword when no label is available; unresolved conflict sets use their canonical conflict keyword so members with sampled label differences still stay together. Refined keywords such as `merchant renewal` remain in the original merchant's neighborhood rather than sorting away from the broader `merchant` suggestion. A card a split came from and the remainder that left it share a working-set key, named by the remainder's own partition record (below) rather than derived from its id; that split key outranks display-label grouping, so neither label cleanup differences such as `Merchant` vs `MERCHANT #1234` nor a remainder that regenerates under a different scope — an owner-scoped card's leftover comes back global once no other owner files the merchant elsewhere — can separate the chunks the user is actively resolving. Settling one member of that split does not delete the pending remainder: accepting, deferring, or discarding one chunk leaves the remaining chunk in the review with its own row ownership, so the accepted entry cannot be overwritten by the regenerated remainder. The group's **combined** row count across all members drives its sort position, so a small owner-scoped variant sorts beside its high-volume sibling instead of sinking down the list. A conflict subset inside the container still resolves on its own `ConflictSetCard`. This is purely a display/grouping concern — the key is derived on read and never stored, and it does not change how suggestions are generated or scoped. Distinct merchants never merge: scope variants for the same merchant can legitimately co-exist as separate rules (the more specific wins at categorize time), so broadening one — e.g. removing its owner to make it generic — never discards the others.

The review record (`review_state.suggestions[id]`, in the batch/profile/system snapshot) reflects edits made on the way to acceptance: removing a suggestion's owner or account to generalize it is persisted back to the record (an explicit clear-to-null is honored, not dropped), so the accepted card shows the rule's real scope. An accepted suggestion also carries its `rule_id` (from `review_state.statuses[id]`) in the API response, so editing an already-accepted suggestion updates that existing rule in place rather than creating a second one.

**A review entry's partition — which entries own their rows.** Most pending entries are snapshots: the generator rebuilds them from live rows on every read, so the stored entry is only what was last seen. An entry carrying a `partition` record owns its `source_row_ids` instead — while it is pending those rows are withheld from canonical generation, and the entry persists as it stands rather than being regenerated. Two kinds exist. A **refined** partition is the matched subset of a card whose selection criteria were edited (*Conflict-set matcher refinement* above); a multi-member refined set's `conflict_group_id` names the seed suggestion rather than a keyword, which is how the grouping above tells it from a canonical conflict set. A **remainder** partition holds rows split away from another card — the leftover of an accept whose matcher is stricter than the rows its entry held, or a refinement's remainder that would otherwise regenerate under the refined card's own identity — and names both the suggestion whose re-refinement or return to pending discards it (`origin_id`) and the card it renders beside (`split_root_id`). Those two differ for a refinement, whose root is the refined card rather than the seed it was refined from. The record is what every reader consults; a remainder's id exists only to keep it distinct from the suggestion its rows would otherwise regenerate as, and nothing parses it. It rides on the entry rather than in a **separate top-level collection of partitions**, which was the rejected shape: undo compares state per suggestion (entry plus status) and a trash set stores whole entries, so a per-entry record travels through both with no work of its own, where a collection would be a second copy of the same membership for each to keep in sync. Before migration v57 the same facts were carried as flags plus a back-reference, with the split root parsed out of the id — which cost a remainder its place beside its card whenever the leftover rows regenerated under another scope. A backup older than v57 restores without the records, which costs that backup's pending refinements and remainders — their rows return to ordinary generation — and nothing else. **Normalizing the old shape on read was the rejected alternative**: old backups exist indefinitely, so that path keeps a legacy reader in live code permanently to buy a graceful restore of something a fresh backup settles (the real database held 9 entries in the old shape when the choice was made, 2 of them pending).

What owns a suggestion's rows differs by state, and every action above is a move between these:

| State | What owns the rows | Rule | What `source_row_ids` means |
| --- | --- | --- | --- |
| pending, generated | nothing — rows stay `import` | none | rows the generator grouped on this read (recomputed every read) |
| pending, refined partition | the persisted entry; its rows are withheld from canonical generation | none | rows matched by the refined matcher at refine time |
| pending, remainder partition | the persisted entry | none | the leftover of a partial accept, or of a refinement whose remainder id collided |
| accepted | the rule — rows reclaimed to `rule` by a scoped preserve-manual apply | `rule_id`; `created_rule_id` only if this review created it | rows the accept applied to; `accepted_prior_rows` is their pre-apply snapshot |
| deferred (`skipped`) | unchanged | none | rows as they stood at deferral |
| discarded | `import` (keep) / `manual` (re-pointed) / `cleared` | none | rows settled; `review_action` records the category transition |
| trashed | review state only | untouched | preserved so Restore brings the set back |

**Look-back lens.** Rules are forward-looking, so a merchant pattern with no recent activity is unlikely to recur and just clogs the review. Each generated suggestion carries `latest_txn_date` (the newest date among its source rows); the pending/conflicts views show only merchant working sets with visible activity inside a per-user window (`ui.importRuleSuggestions.lookbackYears`, default 2; `0` = all time, set via the **Look back** control). The stale remainder isn't dropped — fully stale merchant groups move to a dedicated **`older` pill** (a pending sub-filter, surfaced only when non-empty), so the `pending` pill is lensed to the in-window merchant groups and `pending + older = all pending` (the counts still reconcile to `total`). Clicking `older` shows those fully stale groups — the natural place to bulk-settle them (Discard, keep). The lens is a **view filter only** — it never changes generation or stored review state, and the substance threshold stays computed from full history (so narrowing the window can't lower the bar and flood the list with tiny suggestions). A merchant group or split working set (one `review_group_id`) is kept whole while any visible member of that working set is recent, including recently accepted/deferred/discarded siblings, because settling one chunk should not immediately strand the remaining pending chunk in Older while the user is still resolving that merchant. Once those visible settled siblings are cleared from review, a fully-stale pending group naturally lives under `older`. Decoupling "is this pattern substantial" (full history) from "is it still live" (recent activity) is deliberate: recency, not raw count, is the better predictor of recurrence.

**Bulk disposition.** The pending bulk menu settles a whole selection at once with one combined Undo entry: **Discard, keep categories** marks the suggestions discarded and leaves their rows `import` (status-only — the rows keep their category and stay reclaimable), and **Discard, clear categories** additionally clears the rows to `cleared`. There is deliberately no bare "remove" — keeping-as-imported is the honest default for "reviewed, don't build a rule." A stale tail outside the look-back window needs no special bulk control — existing controls already re-apply rules to it. Both dispositions leave the rows unlocked (`cleared` and `import` are both `category_overridden = 0`), so the page's global **Apply categorization rules** button — which runs `recategorize_all` — reclaims any row from either that now matches a rule the user has since created; a per-rule **apply to existing** reaches the same rows for that one rule.

- **What a file left out is a record of its own, not just a count** (`import_batch_rejected_row`, one row
per refused line, holding the whole row as written plus the date, description and amount the import got
as far as parsing). An uploaded file is unrecoverable — a browser upload carries no path, and in the
networked topologies the file was never on the server's disk at all — so a count is the entire answer to
"why is this account short of what I fed it" unless the rows themselves were kept. Four properties are
load-bearing:

  - **Every class of refusal is here, including the deliberate one.** A row skipped because its account
    was set to Skip used to leave only a per-value tally on `import_batch_account`, which cannot say what
    was in the part that was left out. Duplicates are the one exception, and they are excluded because
    they are *reviewable* rather than merely dropped: they keep their own table, their own review state
    and their own report, and a second read-only listing of them would be a list with nothing to do
    about it.
  - **The record is capped and the cap is filled by priority** (`MAX_STORED_REJECTED_ROWS`,
    `REJECTED_ROW_KIND_PRIORITY` in `import_export/core.py`). A misconfigured mapping can refuse every
    row of a large file, and this is a diagnostic record rather than a second ledger. Where it binds, a
    parse failure outranks an account the user chose to skip — the reverse fills the record with the one
    outcome already known.
  - **The exact totals stay in `config_snapshot.import_summary`, which is what makes a partial record
    safe.** The report compares what it holds against those counts and says so when they differ, so there
    is no truncation flag to fall out of step with the rows.
  - **A suspected footer collapses to one row naming the range.** The tail was excluded on a single
    judgement, so it is a single fact; listing forty lines of address block would bury the handful of
    rows a reader opened the report for. It is the one kind whose stored row count is deliberately not
    its row total.

  Batches imported before the table existed fall back to the up-to-twenty sample their snapshot recorded
  (with no account-skipped rows among them), which is worth more than reporting that the file dropped
  nothing.

  **Two other ways to answer the same question were considered.** *Re-attaching the file on demand* —
  the report offers a drop zone, verifies what is dropped against `file_content_hash`, and renders the
  whole file with each row marked — needs no storage and works in every topology, and is the only one
  of the three that shows a row the import never reached (a line the parser stopped at). It was not
  built because it asks the person to still have the file, and the stored rows already answer the
  question they would be opening it for; it stays the natural addition if "show me the literal file"
  turns out to be a separate need. *Storing the source file* is the only one that still works weeks
  later once the exports have been cleaned up, and a CSV is small enough that the cost is not the
  bytes — it puts raw statements at rest, enlarges the data backup, and needs a retention policy of its
  own, so it would have to be an opt-in per source rather than a default. Neither is foreclosed.

  **No path is stored, and none can be.** A browser upload carries only a file name, and in the LAN and
  container topologies the file is never on the server's disk at all. A *watched* source is the one case
  where the server does hold a directory it can re-read — see *Watched import folders* below — and even
  there the path belongs to the source rather than to the batch, so a batch imported by hand still has
  nothing to re-open.
- when later account cleanup deletes imported transactions, batch summaries and per-account import breakdowns should shrink to match the transactions that still remain from that batch

- detailed duplicate-row review data is stored separately and loaded on demand so long-lived import history stays compact

- per-user preferences may also carry a default mode for whether categories present in the data should be used for new imports (`all`, `none`, or `per_source`); this does not override saved data-source settings or per-batch choices, but it seeds the initial import workflow before a source-specific decision exists

## Watched import folders

A data source may name a directory on the **server** (`csv_import_profile.watch_dir`), and a CSV that
appears there is imported without anyone opening the Import page. The mechanism is in
`architecture.md` → *Import / export*; what belongs here is what the fields mean and what the scan may
never decide on its own.

**The path and the switch are separate fields, and that is deliberate.** `watch_dir` is where to look;
`watch_enabled` is whether to. A restore from another instance clears the switch and keeps the path
(see *Backups*), so the person sees what the folder was set to on the machine the data came from rather
than having to rediscover it. Clearing the path clears the switch with it, since there is nothing left
to watch.

**Never create or guess an account.** This is the whole safety rule, and every refusal follows from it:
everything else an unattended import gets wrong is visible and reversible on the file's card, while an
invented account quietly splits a ledger in a way nothing later surfaces. So a file is parked, not
imported, when

- any non-empty value in the account column is unmapped, maps to an account that no longer exists, or
  maps to an account in the trash;
- the source's map carries an `account_new` entry for a value present in the file, which is a standing
  instruction to create an account;
- the source has no account column and no `account_id`, or would create its single account (only a source
  saved from the import screen can be in that state: the data source editor resolves the request on save,
  to the existing account of that name or by creating the account there and then — `new_account` on the
  profile endpoints);
- the source's `header_fingerprint` disagrees with the file's, meaning the columns are not the ones this
  source is set up for;
- **the source has no completed batch yet.** A source imports unattended only once one file has been
  imported by hand. For a multi-account source this is close to automatic, because the stored account map
  exists only because an import wrote it; the rule is stated anyway, so a single-account source proves its
  column map against a real file too.

The interactive flow resolves a dead mapping by falling back to an exact **name** match and showing the
result for approval. Unattended there is nobody to approve it, and a name match is precisely the guess
that puts rows on the wrong account, so the same situation refuses here. A **blank** account cell is not
an unmapped account: the import already refuses that row on its own and records it on the card, and
parking a whole file for one would make every export with a footer line a Task.

**`import_watch_file` is a cache, not a record.** It holds `(size, mtime)` per file so a scan can skip
what it has already judged, plus the reason a file is waiting. The durable answer to "have we taken this
exact file" stays `import_batch.file_content_hash`, which is why the table is deliberately left out of
backups: it describes a filesystem the restoring machine does not have, and a target that rebuilds it
from its own disk loses nothing.

A **parked** file is retried on every scan, because its refusal is about the ledger and the fix happens
somewhere else entirely — that is what lets the Task clear itself once the account is mapped. A file
whose **import raised** is not retried: the cause is unknown by definition, and re-running an unknown
failure on a timer is a loop with nobody watching. It waits for the file to change or for someone to open
it by hand.

**Purging only ever deletes a file it can still prove it imported.** Eligibility is never "everything
older than N days in that folder": a row must name a file this app recorded as imported, and the stored
content hash is re-checked against what is on disk immediately before the delete, so a file replaced
under the same name is left alone and reported. What that capability costs, and why it is gated, is in
`security-model.md` → *Reading and deleting outside the data directory*.

## Transaction links and Amazon order import

**`txn_link` is a general association primitive, not an Amazon feature.** A link groups a set of transactions under a `kind` (e.g. `amazon_order`), each membership row (`txn_link_member`) carrying a `role` within the link (e.g. the funding `charge` vs the `item` rows it was split into); a link also carries an optional `external_ref` (the external entity it represents — an Amazon order id, which is the reconciliation key) and a `metadata_json` blob for kind-specific data. The primitive is deliberately **pure association**: creating or deleting a link never mutates the linked transactions (no category change, no `exclude_from_totals`, no amount change). Whatever feature owns the link performs those mutations and records what it did in `metadata_json` so it can reverse them. That separation is what lets the one table serve unrelated cases — Amazon order itemization, **wallet funding-leg suppression** (`kind='wallet_funding'`, see below), **multi-payment purchases** (`kind='purchase'`, see [Multi-payment purchases](#multi-payment-purchases)), **reimbursable expenses** (`kind='reimbursement'`, see [Reimbursable expenses](#reimbursable-expenses)), **PayPal funding pairs** (`kind='paypal_funding'`, see [PayPal funding pairs](#paypal-funding-pairs)) and **refunds** (`kind='refund'`, see [Refunds](#refunds)) today, credit-card payment-leg pairing and a cash-flow lens as intended future clients. Both tables ride in backups. A member row cascades away with either endpoint (`ON DELETE CASCADE` on both FKs), but a link row has **no** FK to `txn`, so the owning feature (and the wipe path) must delete stale links explicitly rather than relying on cascade. One trap for a new client: `get_link` returns `metadata` **already parsed** into a dict, so a reader that reaches for a JSON-string helper on it silently gets an empty object rather than an error — every field it was looking for reads as absent, and the write path keeps working, so the loss shows up only as a stored value that never comes back.

**Amazon order import is the first client** (parsed from an AZAD orders/items export; **orders-only model**, 2026-07-10 — the earlier per-item itemization was superseded). Each order becomes **one spending transaction** in a chosen **Amazon account** — an ordinary account, since an account here is only a reporting/owner dimension with no balance or net-worth role — amount = net cash (`total − refund`), memo = the orders file's concatenated item list, categorized by the user's normal rules. The matching card charge (found by amount + date, with the account resolved from the funding-source map — see below) is recategorized into the excluded **"Amazon Funding"** leaf (created under the seeded `Transfers` group, so exclusion is inherited via `COALESCE(parent, leaf)`) and joined to the order by an `amazon_order` link (member roles `order` + `charge`). An order may link **several** charges (a split-shipment order — see the reconciliation bullet): each charge's prior categorization is stashed per charge in the link `metadata_json` (`charge_priors: {charge_id: prior}`; the legacy singular `charge_prior` written by the auto-matcher is still honored) so undo restores each exactly. The invariants that keep totals honest:

- **The money counts once.** The order row counts as spending; the funding charge is excluded. Exclusion is *conditional* — only a charge actually linked to an imported order is excluded (a blanket `AMAZON.COM → exclude` rule would wrongly drop Amazon spend that has no imported order), which is exactly the fact the link records.
- **The items file is optional enrichment, not rows.** The orders file alone is a complete transaction. If the **items** export is present, its per-item reference detail (ASIN, list price, quantity) is folded into the existing order transaction's `import_evidence` (idempotent, PayPal-style) — never as separate rows. Amazon's category taxonomy is parsed but deliberately unused (the user categorizes their own way). Item rows whose order isn't imported yet are **parked** rather than lost: their detail is retained in `amazon_pending_item` (keyed by `order_id`, upserted so a re-imported items file refreshes rather than duplicates; `parked_batch_id` ties each row to the orphan import that created it), and importing the matching orders file later **auto-attaches** it at order creation (`_take_parked_items`) — no manual re-import. A parked row is consumed on attach and cleared when its parking import is undone. Once an items-only card is fully matched it is folded into the orders card that holds its orders (`_merge_items_card_into_orders`: the items file's name, hash, and enrichment summary move onto the orders card and the empty items card is deleted), so a split import converges to one card labeled with both files — the same end state as importing them together. This is symmetric in import order: items-**before**-orders folds the prior parked-items card into the new orders card; items-**after**-orders (an items file enriching already-imported orders) folds the new empty items card into the prior orders card. Only when a single orders card is involved. While only *partly* matched, the items card survives and its "no matching order" count is derived **live** from the ledger (`unmatched_parked_order_count`) so it resolves toward zero as orders arrive and re-flags if an import is undone; it stays *not* hash-remembered (see the per-file hashes bullet) so a manual re-import isn't blocked, though with auto-attach it's rarely needed.
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

**Wallet funding-leg suppression is the second client** (`kind='wallet_funding'`, `services/money_movement.py`, landed 2026-07-19). A wallet-style CSV (PayPal, Venmo, …) records a single balance-funded purchase as **two** rows in one export — the payment out to the merchant, and an equal-and-opposite nameless deposit *into* the wallet balance. That deposit is money movement, not income. After the import insert loop, `suppress_batch_funding_legs` pairs the two **within the batch** — a *nameless credit* whose **unique** same-day equal-and-opposite twin is a *named debit* — and recategorizes only the **leg** into an excluded **"Money movement"** leaf (under the seeded `Transfers` group), joining it to the purchase by a `wallet_funding` link (roles `leg`/`purchase`, the leg's prior category stashed in `metadata_json` for reversal). Always on, but deliberately high-precision so a genuine inbound payment (a *named* credit with no offsetting purchase) is never touched and an *ambiguous* group (two same-amount rows on a side) is left entirely alone. The captured `Type` value ("Bank Deposit to PP Account", …) is **corroborating, not required**: the recognized vocabulary is a code constant, the structural signal stands without it, and any unrecognized `Type` on a suppressed leg is reported in the import summary (`money_movement_unrecognized_types`). The category is intentionally **generic/source-agnostic** (the same two-legged shape occurs across wallets); per-source provenance lives on the link + the leg's `import_evidence`. Reversal (`reverse_batch_money_movement_links`) runs in both `undo_batch` and the re-import replace path — and, unlike the Amazon charge, both paired rows belong to the batch, so reversal exists mainly to drop the link (a `txn_link` row has no FK to `txn`) plus restore any leg that outlives the batch. **A stated reference outranks the structure.** A PayPal statement names the payment each funding deposit paid for (the deposit's `Ref ID` is the payment's `Transaction ID`), so those pairs are taken first, as stated (`_referenced_pairs`) — including a deposit that carries the merchant's name, which the structural signal would read as a genuine inflow. Only a deposit `Type` can be a leg of a *payment* this way: a refund refers to its payment the same way and is real money back. The statement also shows that refund's way out: a refund lands in the balance and a withdrawal carries it straight back to the card or bank, naming the same payment (or the refund itself) in its `Ref ID`. That withdrawal, equal and opposite to a refund it names, is the **refund's** leg — money movement, linked with the refund in the `refund` role — while the refund itself stays real money back, paired with its payment (see [Refunds](#refunds)). It is taken only as stated: a withdrawal of money *received* has no reference and is left to the `Type` rules below.

**PayPal source recognition + `Type`-based money-movement categorization** (landed 2026-07-20). Beyond the structural funding-leg pairs above, the other money-movement rows (holds/reversals, standalone deposits/withdrawals/currency conversions) are recognized by the PayPal `Type` field, with three supporting pieces:

- **Source recognition.** A PayPal Activity CSV is identified by its header (`sniff_paypal_activity`, a marker-subset test). A recognized import auto-attaches to the **single system "PayPal" data source** — `csv_import_profile.source_kind = 'source:paypal'`, created on first use (named "PayPal", "PayPal 2"… on name collision), `account_id` NULL so one source spans accounts (the target is picked per import), **visible/renamable but not deletable**. A *hand-created* PayPal source is **adopted** (tagged `source:paypal`) on its next PayPal import rather than left untagged, so there's exactly one. The batch is likewise stamped `source_kind = 'source:paypal'`.
- **Monthly statements (PDF).** PayPal's monthly statement lists the same transactions as the activity CSV, with the same Transaction IDs, so it imports through the same data source: `services/paypal_statement.py` reads the PDF's text layer by column into rows under the CSV's own column names (the description split into `Type` and `Name` at its first colon), and `routers/import_export/paypal_statement.py` hands them to the ordinary import as a `ParsedFile` — one batch per statement, mapping-free. Only the document's first statement ("PayPal account") is read; the second ("PayPal Balance account") repeats the rows that touched the balance. The statement's `Ref ID`, `Transaction ID`, `Type` and the bank a payment drew on are captured as **categorical** evidence, declared rather than measured (a month is too few rows for cardinality). A row in another currency is refused as a CSV's is, and so is a same-currency deposit or withdrawal whose `Ref ID` names one — the card deposit that paid for a payment in pounds would otherwise pair its card charge away and leave nothing counting the purchase. **Each statement belongs to one PayPal account, both ways**: its header names the PayPal Account ID, the first import of an ID ties it to the account chosen, and after that a statement for that ID is refused anywhere else and an account holding one ID's statements refuses another's. The tie is read from the completed batches' snapshots (`config_snapshot.statement`), resolved to the account group, so undoing those imports undoes it and nothing else stores it. A PayPal data source first created by a statement has no header fingerprint; the first activity CSV to attach gives it that CSV's header and mapping.
- **Forced capture.** A recognized file **force-captures** `Type`, `Item Title` and `Transaction ID` into `import_evidence` regardless of the user's column-capture picks (`_forced_evidence_headers`), so the signal money-movement handling depends on is always present (an unchecked `Type` can't silently drop it), and so does the identifier the activity CSV shares with a statement, which is how a statement's refund finds a payment only the CSV brought in ([Refunds](#refunds)). `Transaction ID`'s role is **declared categorical** (`_PAYPAL_FORCED_CATEGORICAL`) rather than measured: a value unique to every row measures as descriptive text and would feed duplicate matching, where an opaque identifier names nothing two sources would both write. The statement declares the same column the same way.
- **User-approved `Type` rules, not a frozen vocabulary.** Approved types become `match_source_text` rules keyed on the `Type` value → the excluded **Money movement** category. `is_money_movement_type` is **fragment-based** (*deposit / withdrawal / currency conversion / hold* — so a future `eCheck Deposit` still matches, stale-resistant) and only **pre-checks** a review; the user decides which types become rules. The review is **source-scoped** (`money_movement_type_proposals_for_profile` unions the `Type`s across all the source's imports — one surface for every type, not one per card) and **bidirectional** (each type's `already_ruled` state; an `{add, remove}` apply creates/deletes rules and runs `recategorize_all`, so *existing* rows move too). Rules are **account-type-scoped** (`account_type='paypal'`), so **one** rule per `Type` covers every PayPal account and a same-text transaction on a non-PayPal account can't match. Approving a `Type` also types the source's accounts `paypal` when generic (so the type-scoped rule matches — see Accounts → `type`). Reached from a "Money movement" button on the PayPal data-source header and automatically after a PayPal import.

### PayPal funding pairs

A tracked PayPal account holds the real transaction — the purchase, the payment received — because money
can sit in a PayPal balance, and then the PayPal row is the only record there is. What PayPal took from a
card or bank, or sent back to one, also lands on that account as a PayPal-looking row, and counted there
too the purchase is counted twice. After every import and every sync, `services/paypal_funding.py` pairs
each PayPal row with the bank or card row on the other side of the same movement, links the two
(`kind='paypal_funding'`, roles `paypal` / `counterpart`) and makes the money count once. The wallet
funding-leg suppression above works *inside* one PayPal export; this works *across* accounts, and the two
compose: a suppressed funding leg is one of the PayPal rows that pairs.

**What a pair changes depends on which way the money went, and the invariant is "counted once".**

- A **transfer** pair — money into PayPal from a card or bank (a funding leg, or a row whose captured
  `Type` is a deposit), or out of PayPal to one (a `Type` naming a withdrawal) — is money moving on both
  sides, so both rows move to the excluded *Money movement* leaf. Two rows the user had filed alike so
  they cancelled keep the same net, now without a phantom expense and a phantom income.
- A **payment** pair — a PayPal payment a card or bank paid directly — must count exactly once, and the
  PayPal row is the record of what was bought, so the card row is excluded. **Unless the PayPal row is
  already excluded**: then the user has chosen to count the card side, which already counts it once, and
  excluding the card row too would drop the purchase from every total. Nothing changes in that case, and
  nothing changes when both are already excluded.

Excluding the card row is safe only because the PayPal row it belongs to is in the ledger — the same
conditional exclusion the Amazon importer applies, and for the same reason: a blanket "PAYPAL → excluded"
rule would drop real spending for anyone not tracking the PayPal account, where the card row is the only
record. What a pair changed is stashed per row on the link (`priors`), with `category_source =
'enrichment'` on the changed rows so automatic passes leave them alone. A PayPal row with no captured
`Type` (a synced account) could be a payment or a withdrawal, so it is offered both directions; the sign of
the candidate settles which.

**What makes a candidate**: a row on a non-PayPal account whose name, raw text or captured detail reads as
PayPal, of the matching amount to the cent, within `PAIR_WINDOW_DAYS` either side, on an account whose owner
is compatible (the same owner, the shared owner, or none recorded — a household's second PayPal account is
funded from different accounts, and a coincidence of amount between them must not pair). Pending rows wait
until they post; split rows and rows an Amazon order or a wallet leg already claims are not offered. The
window was measured on one real ledger: over 241 unambiguous pairs, the card or bank row was dated between
two days before and four days after the PayPal row, and widening the window to seven days found no more.

**Only an unambiguous pairing applies itself**: a PayPal row with exactly one candidate that no other PayPal
row also wants, or a cluster of interchangeable rows (one amount on each side, every PayPal row wanting
every candidate, as many of each) where every assignment has the same effect. A row with a single candidate
also **claims** it, taking it out of the lists of rows that have alternatives — that row can pair with that
one or with nothing, so leaving it on offer elsewhere is what strands it. Two same-amount payments days
apart do this on a real ledger: the earlier one's only bank row falls inside the later one's window too, and
both were handed to the user although only the later one was ever in doubt. A claim often leaves another row
with a single uncontested candidate in turn, so the rounds repeat until one claims nothing, and a row left
with no candidate at all is treated as having none to find. The claim is made only where a **single** row is
cornered: two rows cornered on one candidate is a *shortage* rather than an ambiguity (the other payment came
from the balance, or its own bank row isn't in the ledger), at most one of them can have it, and which is not
deducible — so nothing is taken from anyone and both go to the user. That shortage is most of what is left
for a person: of the six clusters one ledger could not settle, five were two payments competing for one bank
row, and a sixth was a bank deposit imported twice.

**The review** (`paypal_funding_report`, shown as the *PayPal reconciliation* — the PayPal vendor of the
reconciliation shell, where a pair reads as a *match*) lists the pairs and
three kinds of work: a PayPal row the pass could not settle — shown as *Several possible matches* where it
has a choice of candidates, and, where its single candidate is one other rows are cornered on too, as *Two
transactions, one match*: **one row carrying every rival**, each beside the button that gives the
transaction to it. Listed a row apiece they showed the same lone transaction twice with no sign of the
rivalry that was the whole difficulty, and a picker offering one candidate is not a choice. The split and
the grouping are made in the vendor, off the candidate lists the report already sends, since it is one
bucket's work and one bucket's data. Declining is the group's own action (*Neither*, in the Actions column,
where the answer is about the group rather than one of its rows): it declines the contested row for every
rival, which releases it to the unaccounted list, where it reads as a bank row no PayPal row accounts
for — which is what it is; a PayPal row stating that money crossed to
another account (a deposit or withdrawal) with no candidate — a payment with none is not listed, since a
balance-funded payment has no counterpart to find; and a PayPal-looking bank or card row nothing pairs
with, looked for only on accounts already paired with a PayPal account and only within the dates that
PayPal account's rows cover, since a PayPal-looking charge elsewhere belongs to a PayPal account the ledger
does not track, where it is the only record. The report is read-only; the pairing runs after ingestion and
after each **decision** that changes what is there to pair — `pair_after_decision`, on the pair / unpair /
decline endpoints — never from a report `GET`. A decision is not only about its own row: taking a
transaction settles what everything cornered on it could have been, and declining one releases it, so a row
the decision just made unambiguous would otherwise drop out of the review (nothing is left to ask about it)
while nothing paired it, its bank row counting on beside the PayPal row until the next import happened to
run the pass. Claiming reaches that state from more decisions than the old rule did, since settling one row
now cascades through the rows it was cornered against. It is best-effort and runs after the decision's own
write, which stands whatever the pass then finds; acknowledging a row runs nothing, since a review state is
not consulted by the matching. The whole pass is ~80 ms over an 18k-row ledger, one more than the report
already runs on each reload.

**Decisions are links of their own kinds**: unpairing records the pair as declined
(`paypal_funding_declined`), so the pass never makes it again; "none of these" declines each candidate
shown; acknowledging a row with nothing to pair records it as reviewed (`paypal_funding_reviewed`).
Storing them as link kinds rather than tables means they ride in backups, cascade with their rows, and
invalidate the attention cache through the `recon_epoch` triggers already on `txn_link`.

**Reversal restores only what is still the pairing's.** Unpairing, or undoing the import that brought either
row in (`undo_batches` runs `reverse_batch_paypal_funding` before the rows go), puts a row's category back
only while it still holds the category and source the pairing set; a category the user chose since is
kept. A link has no foreign key to `txn`, so a pairing whose PayPal row was hard-deleted by some other path
(emptied from Trash, an account merge) is **healed** at the start of the next pass: the surviving row is
restored and the link dropped — otherwise its bank row would stay excluded with nothing left counting the
money.

**Which cards offer it, and attention.** A card offers its share of the review when that share lists
anything (`card_counts`: per batch, the rows its review lists and which of them need the user — ids, so
a data source's collapsed header can total its cards counting each row once, since a bank row with no
PayPal record is listed by every card whose dates cover it). The card is
chosen by where its rows landed, not by what kind of file it was — a PayPal account's rows arrive by
PayPal file, by an aggregator's export and by sync alike — and a card whose PayPal rows have no other side
(payments from the balance, holds) is left out rather than offering an empty report. **Attention** —
every row with a choice of candidates, every contested bank or card row (**once**, named by that row: a
shortage is one decision however many PayPal rows it settles, and naming it by the contested row also
counts it once across cards when the rivals arrived with different files), plus each unreviewed row of the
other two kinds — tints the card and,
over the whole ledger, drives one Tasks entry, since pairs are made after syncs too. Both are cached in
`db_meta` against the `recon_epoch` (`services/reconciliation_attention.py`), the per-card figures from
one analysis of every card.

### Refunds

Money back on a purchase is not income: it offsets what was spent (see [Reporting assumptions](#reporting-assumptions)),
and it does so in the totals only when the refund sits in the purchase's category. Where a source says which
payment a refund returns, `services/refund_links.py` pairs the two after each import and keeps the refund in
the payment's category. A PayPal statement says it on every refund — its `Ref ID` is the payment's
`Transaction ID`, which the activity CSV always captures too, so a statement's refund pairs with a payment
from either file. A CSV refund can say the same only through the optional `Reference Txn ID` column, which
an activity download does not always include; it is read where it was captured and not forced. A reversal of a payment *received* refers to it the same way and pairs
the same way. The link is `kind='refund'` (roles `payment` / `refund`), and it may cross imports and arrive
in either order, since a refund may land in a later statement than its payment.

- **Only a stated reference pairs.** No amount-and-date matching: a refund is paired with the payment it
  names, on the same account group, in the other direction, for no more than was paid — so a partial refund
  pairs and a mismatched reference does not. A refund with no reference stays an ordinary transaction.
- **The refund follows the payment's category, whichever way that changes.** It takes the category with the
  feature-owned source `refund` (see *How an existing transaction's category can change*), and the
  `trg_refund_follows_payment` trigger moves it whenever the payment's `category_id` changes. A trigger for
  the reason the purchase prune trigger is one: a category is written from many places, and one missed
  would leave the refund counting against a category its payment has left. While the payment is split the
  trigger holds still, since a split payment's `category_id` is only the value its allocations replaced, and
  a refund of an already-split payment is linked without being moved.
- **The user's category wins.** A refund categorized by hand is linked but not moved; categorizing it by hand
  later stops the following. What the pairing changed is stashed on the link (`refund_prior`), and undoing
  either row's import — or losing the payment to any other deletion, healed at the start of the next pass —
  puts it back only while the refund is still following.
- **It can be filtered for.** The *Refunded* attribute (`refund`) selects both sides of every pairing, in
  the ledger's quick filter and the Transactions and Dashboard filter bars alike (see
  [Attributes](#attributes--filtering-by-what-a-row-is)).
- **The row shows it with the link marker.** The list feed carries `refund_link` per row — its role and the
  other side's name, date and amount (`refund_map_for`) — and the ledger draws it with the `🔗` the
  multi-payment purchase already uses, opening the other transaction (`ui-patterns.md` → *Transaction rows*).
- **The client is told what moved.** A category write answers with `followed_ids`, the refunds that moved
  with it, since a surface patches only the row it edited; see `ui-patterns.md` → *An edited transaction
  lingers where it was found*.

Recording a refund as a member of a [multi-payment purchase](#multi-payment-purchases) is the other way to say
the two belong together, and changes no category; a stated refund needs no such act. What a refund is **not**
is a [reimbursable expense](#reimbursable-expenses): nothing is owed back, and the money has already returned.

## Backups

Backup/restore deals with two different classes of data:

- regular app data

- credentials/secrets such as Plaid-linked credentials

Those are intentionally separated so normal backups can stay safer and simpler.

**The credentials backup (payload version 4) exports ciphertext, never plaintext.** Versions 1 and 2
*decrypted* every connection credential and app-level provider secret into a plain zip — an artifact
strictly weaker than the databases it came from, which hold only ciphertext — and producing it was the
sole reason the export demanded an unlocked vault. v3 copies `connection.credential_enc` and
`provider_config.secret_enc` as they sit and carries the exporting vault's key material alongside them
(`vault: {...}` from `crypto_service.export_vault_slot`). **v4 is the same file with a keypair slot in
that block** — `{public_key, wrapped_private_key, sealed_dek}` where v3 had a directly-wrapped
`wrapped_dek` — and the block is read by its `format`, so v1–v3 all still restore. The version bump exists
so an *older* install rejects a v4 file outright rather than reporting the passphrase as wrong when it
reaches material it cannot interpret. Consequences, each load-bearing:

- **Export needs no vault at all.** It copies wrapped material and never touches a plaintext secret, so a
  locked vault is not an error on this path. (It used to answer `423`, and because the button was a plain
  browser navigation rather than a fetch, the user got a raw JSON error page in place of the app — see
  `downloadUrl` in `lib/api.js`.)
- **One slot, the exporting user's.** `export_vault_slot` asks for `method="passphrase"`, so the file
  carries that account's passphrase slot and nothing else — never a passkey (its key comes from an
  authenticator's PRF for a device-bound credential, so it cannot be reproduced during a restore
  elsewhere), and never another member's. Consequence for a shared workspace: **cross-install**, only the
  exporting user's passphrase opens the file. That is deliberate — each slot is an independently
  offline-crackable wrap of the same DEK, so carrying every member's would make the file only as strong as
  the weakest passphrase among them. The alternative is recorded in
  `backlog/backup-restore-scope-and-secrets.md`.
- **The slot material is what makes the file portable.** The ciphertext lives in the data DB and the key
  that opens it in the control DB (`vault_slot`), so a credentials backup carrying only one half restores
  nowhere but the install that produced it. Including it is safe *because* every part of it is guarded by
  the passphrase: the file's security is exactly the vault passphrase's strength, which is why
  `meets_production_min` rides along for the UI to warn on.
- **There is no encrypted variant.** A payload that is already ciphertext gains nothing from the RSA
  recipient layer, so the credentials section offers one button and no choice. (Data backups keep theirs
  — that payload really is plaintext.)
- **Restore is where the passphrase is asked for**, and only when it must be. What decides that is
  whether the file's ciphertext is **already valid under the live workspace DEK** — a property of the
  workspace, not of who exported the file. Two checks establish it: the file carrying *this* slot
  (`crypto_service.vault_slot_is_local`), which is cheap and works with the vault still locked; failing
  that, trial-opening one of the file's secrets with the live DEK, which needs the vault unlocked because
  it uses the key. Either way the rows go back **verbatim** — no passphrase, no re-encryption.

  The second check is not a refinement of the first, it covers cases the first calls foreign. **Every
  member's slot seals the same DEK**, so a colleague's backup restores verbatim on the shared install;
  identity alone would demand their passphrase to re-key data that is already correct. And because
  changing a passphrase re-wraps the *same* DEK, leaving stored ciphertext untouched, a backup predating a
  passphrase change was never stranded on **this** install either — only on a different one. That is the
  precise scope of "keep your old passphrase": it is about restoring elsewhere. A file from
  elsewhere needs the passphrase *that backup* was made with (`unwrap_dek_from_slot`, whose AAD is the
  exporting `user_id` — hence that id in the payload) **and** the local vault unlocked, because each
  secret is reopened with the backup's DEK and re-sealed under this workspace's own. A foreign slot is
  never adopted into `vault_slot`: one DEK per workspace.
- **v1 and v2 still restore** (their plaintext payloads keep the old local-vault requirement — there is
  something to encrypt), and round-tripping one **upgrades** it: what came in as plaintext goes back out
  as ciphertext.
- **Each export is recorded, so a passphrase change can name what it strands.** Changing the passphrase
  re-guards the *same* slot under a new KEK: stored ciphertext is untouched, the DEK's seal is untouched,
  and no data source needs re-linking — but every credentials file written beforehand carries the old
  wrapping and stays restorable **only with the old passphrase, permanently**. Nothing on screen would
  otherwise reveal that at the moment it happens. `credentials_export` (control DB, beside `vault_slot`)
  therefore holds one row per export: a timestamp and `wrapped_dek_fingerprint`, a salt-free digest of the
  slot's **wrapping** — never the passphrase, never the DEK, and not the wrap itself, since the only
  question it answers is "same wrapping?". *Which field that digest covers is load-bearing:* on a keypair
  slot it is `wrapped_private_key`, because a passphrase change leaves `sealed_dek` byte-identical, and
  fingerprinting the seal would report "nothing changed" after exactly the event this record exists to
  detect. (Converting a format-1 slot re-points the existing rows to the new value rather than orphaning
  them — the conversion does not change which passphrase opens those files.)
  The change dialog matches it against the slot in force and names those backups by date;
  files from before an earlier change are deliberately *not* listed, having been stranded already, and a
  general caution covers exports predating the record. It lives in the control DB because it describes
  vault state and must survive a **data** restore — the event most likely to be followed by wondering
  which backup still opens. Distinct from `meets_production_min` above, which travels *inside* the file
  and describes the strength of the wrap rather than which wrap it was.

Secrets deliberately stay in the **data** DB while keys stay in the **control** DB. That is not "secrets
in the data DB" but the standard separation of key material from the ciphertext it protects, and it is
the only reason the "leaked DB ≠ leaked tokens" property holds; `connection` additionally carries
ledger-coupled sync state (`transactions_cursor`) that has no business in the security DB.

The regular backup (payload version `BACKUP_PAYLOAD_VERSION`, bumped by hand as the format changes; the
restorable set is `RESTORABLE_PAYLOAD_VERSIONS`) covers the full **data-DB** state so a restore reproduces the working app, not just the ledger: owners, accounts, categories/groups, rules, merchant renames, import profiles/batches/history, transactions, the entire **tag system** (`tag` plus every attachment — `txn_tag`, `category_tag`, `account_tag`, `rule_tag`), the `account_pair_distinct` and `amazon_charge_distinct` assertions, the `amazon_charge_reviewed` acknowledgments (reconciliation reverse-scan "Mark reviewed" state), the **recurring series** (`recurring_series` plus the
`txn.recurring_series_id` membership link), the **transaction links** (`txn_link` plus its `txn_link_member` membership — see "Transaction links and Amazon order import"), the **Amazon funding-source map** (`amazon_funding_map` — the instrument→account mappings the Amazon importer resolves charges against), the **parked Amazon items** (`amazon_pending_item` — per-item detail from an items file awaiting its orders file; kept whole rows whose `parked_batch_id` survived the restore), the **non-secret half of each connection** (`connection` less its credential and in-flight sync markers — see *A connection is split across the two backups* below), the **connection account mapping** (`connection_account` — see Accounts; it rides the *data* backup because nothing in it is a credential and its coverage claim must move with the ledger it describes, re-resolving `account_id` via the stable `external_account_id` on restore), **UI/layout preferences** (`ui_preference` — see below), the **split allocations** (`txn_split` — without them a restore leaves rows flagged as split with nothing to expand into, and every category rollup silently drops that money), and the **attached documents** (`document`, plus each file as its own zip member — see "Attached documents" below). Restore is destructive — it wipes and rebuilds inside one transaction, and drops any attachment whose endpoints didn't survive. Every payload version in `RESTORABLE_PAYLOAD_VERSIONS` (`routers/import_export/backup.py`) is still accepted — the list is not restated here, because it grows with the format and a copied range goes stale. The later ones differ from the current format only by sections a newer build added, which an older archive simply lacks; the pre-10 ones additionally have their pre-rename columns translated on restore — v7's `plaid_account_id`/`plaid_item_id` account columns to the current `external_account_id`/`connection_id`/`provider` shape, and pre-v9's `plaid_transaction_id` to `external_transaction_id` (see the two-version-axes note below); older payload versions are no longer accepted.

**The archive is streamed, not assembled — in both directions.** A backup grows with the ledger, and nothing in this project is allowed to degrade as the transaction count grows, so neither writing nor reading one may hold it in memory. That is what version 10's layout is for: `meta.json` (the header plus a digest per member) and one **NDJSON member per section**, `sections/<name>.ndjson`, a row per line. Versions 7-9 were a single JSON object, which forces whole-payload handling on the way back in; the line-per-row layout makes both directions a stream with no incremental JSON parser and no new dependency. The *content* of a section is unchanged from version 9, which is why the restore's per-section handling is shared across every version rather than duplicated. Versions 11 and 12 are additive in the same way: 11 added the `txn_splits` section, 12 the `documents` section and the `documents/<id>` file members beside it. Members are individually compressed: the sections deflate ~10:1, while an already-compressed member (the encrypted payload, and every attached document) is stored, since deflating it would be pure CPU.

Consequences worth knowing, because each is load-bearing rather than incidental:

- **The export builds into a staging file beside the database, never the system temp directory** — `/tmp` is RAM-backed `tmpfs` on many Linux installs, which would put the artifact back into the memory this exists to avoid, and the data directory is both the volume the user has sized for their data and the one a portable install carries. The file is unnamed (`tempfile.TemporaryFile`), so an interrupted export cannot strand one. Because the artifact is finished before the first byte is sent, the response carries a real `Content-Length`.
- **The encrypted path streams through an incremental cipher and the envelope is unchanged.** `AESGCM.encrypt()` is one-shot and needs plaintext and ciphertext resident at once; the incremental encryptor over the same cipher emits byte-identical output (ciphertext followed by the 16-byte tag), so an archive written this way opens with the one-shot API and no manifest version bump was needed.
- **Decryption verifies before anything acts on the result.** GCM authenticates only at the end, so a restore decrypts `payload.bin` into a staging file and checks the tag *before* that file is opened as an archive. Nothing is ever read out of unverified plaintext.
- **Referential repair is SQL over the restored tables, not set membership over the payload.** The restore transaction runs with `PRAGMA defer_foreign_keys = ON`, so rows can be inserted in any order as they stream and dangling references repaired before commit — which is what removes the last thing a restore held in memory (an id set per table). The three kinds of rule are a product decision, not a technicality: an optional reference is **nulled** and its row survives; a row that is meaningless without its reference (an attachment with no transaction, a rule with no category) is **dropped**; and a reference where NULL is legitimate but a *broken* value is not is also dropped rather than downgraded into the NULL state, because that state means something different (an Amazon funding mapping with no account means "untracked", which is not what a lost account should become). Most children declare `ON DELETE CASCADE`, so dropping an orphaned parent takes its attachments with it. A rule naming a column the live schema no longer has is skipped, for the same reason the insert path intersects payload keys with `PRAGMA table_info`.
- **The restore transaction stays whole.** Splitting it into committed chunks was considered and rejected: an open SQLite write transaction spills to the WAL rather than to memory, so there is nothing to gain, and all-or-nothing is the property that makes a *failed* restore leave the target untouched. `restored_counts` is therefore counted from the tables afterwards — what actually landed, net of rows dropped as unreferenced — rather than from what the payload offered.

**Every backup declares which of the two it is.** The data and credentials backups are separate artifacts
with separate consequences, and telling them apart used to depend on the *name* of the member inside the
zip — which is why choosing the wrong one answered "Unexpected backup file inside ZIP" rather than naming
what had actually been chosen. Each container now carries a `kind` of `data` or `credentials`: in
`meta.json` for a version-10 archive, in the payload for a credentials backup, and in `manifest.json` for
an encrypted archive. That last one is the point of putting it there — **an encrypted backup must be
identifiable before anyone has produced a private key for it**, so the declaration sits outside the
ciphertext, where it discloses nothing the filename did not already say.

Files written before the field exists are identified by **shape**: the sections a payload carries are as
good a fingerprint as a declaration (`connections`/`provider_configs`/`plaid_items`/`vault` for
credentials, `owners`/`transactions`/`accounts`/`categories` for data), with the member name used only as
a last resort. Detection is never *primarily* by filename — files get renamed, and a name is not a fact
about the contents. A file matching nothing is refused as not being a backup at all, and each restore
endpoint refuses the other kind by name rather than by symptom.

**Two version axes, and why restore tolerates schema drift.** The payload carries `version` (the *payload format* — its section names, its row contents and, from version 10, its member layout — bumped by hand, with restore hard-rejecting anything it does not know) and, independently, `schema_version` (the *DB migration level* `db_meta.version` the data conformed to when exported). They move on different cadences: a schema change bumps `CURRENT_VERSION` without touching the envelope shape. Restore rebuilds each table by inserting only the payload columns the *live* table still has (`_insert_section` intersects the row's keys with `PRAGMA table_info`), so it survives schema evolution in both safe directions: a column the schema has since **added** is simply absent and takes its default (e.g. `category_rule.match_source_text`), and a column since **dropped** is skipped rather than failing the whole restore with "no column named …" (the real case: `category_rule.priority`, removed once rule ordering became automatic, which a pre-removal backup still carries). The accounts and transactions dumps additionally use curated column lists rather than `SELECT *`, so they never carry an incidental/legacy column in the first place; the `SELECT *` tables (categories, rules, tags, …) rely on the restore-side filtering. **A curated list must still name every column the table has**, because a restore is meant to return the system to the state it was in when the backup was taken and an omitted column restores at its default — which for `txn` is not neutral: a list that had fallen behind the schema dropped `trashed_at` and the dedupe-resolution columns, so every trashed row and every confirmed duplicate came back into the ledger as a live transaction. `test_backup_carries_every_column_of_every_table` compares each section's columns with the live table, and a column that deliberately does not travel has to be recorded, with its reason, in that test's `EXCLUDED_COLUMNS`; the round-trip tests compare every row's full contents rather than counts, since a restore can return every row while resetting a column on each. A **column *rename*** is the one drift the drop-and-default handling can't absorb (the payload's old name is dropped and the renamed column silently takes its default) — so restore **explicitly translates** each one before insert. For version-7 accounts: `plaid_account_id → external_account_id`, and `plaid_item_id →` a resolved `connection_id` (looked up against the live `connection` table, which restore never wipes) plus a `provider` (see `_reconcile_restored_account_links`); the same pass nulls any `connection_id` absent locally, so a cross-system restore can't leave a dangling FK. For pre-version-9 transactions: `plaid_transaction_id → external_transaction_id` (`_legacy_transaction_transform`) — the case that shows why this matters rather than being tidiness, since that column is what makes a sync idempotent, and letting it default to NULL would have the next sync re-add every restored transaction as a fresh row. The one direction restore can *not* make safe is a **downgrade** — a backup whose `schema_version` is newer than this build — because a column the newer build added with real content would be dropped silently; the compatibility guard refuses that (see below). Restore loads the old values straight into the current schema and then **replays the data-init half of every migration newer than the backup** (`run_post_restore_data_init`, gated on the backup's `schema_version` — see *Schema evolution* → migrations' two halves) so derived fields the backup predates are recomputed rather than left empty. The column-drift handling above and this data-init replay are complementary: the former fills *stored* columns the payload lacks with their defaults; the latter recomputes *derived* columns a newer migration would have produced (e.g. `last_effect_date`), which no default can supply. The schema DDL itself is deliberately **not** replayed — the target is already at `CURRENT_VERSION`, so those ALTERs would be no-ops; only the data-derivation half is missing after a raw insert.

**Content integrity: a digest per member, and the hash it replaced.** A version-10 archive records the sha256 of each member in `meta.json`, and restore recomputes them all — in a pass of its own, *before* anything destructive — refusing a mismatch with a `400`. That is the same guarantee version 9 got from a single `content_sha256` field embedded in the payload, but checkable while streaming instead of by re-serializing the whole payload to compare one hash, and it extends to members that are not JSON at all. Versions 7-9 and the credentials backup still carry `content_sha256` over the canonical payload (sorted keys, compact separators, the hash field itself excluded), and so does any payload handed to `POST /restore` as a dict, since a materialized payload has rows rather than member bytes and needs an integrity check of its own. Either form is **optional and additive**: absent → skipped (a backup predating the field, or one a power user deliberately stripped, still restores), exactly like `schema_version`. It is deliberately an *unsigned* checksum — it detects **accidental** corruption, not tampering: anyone editing the plaintext file can recompute or drop the hash, so it makes no authenticity claim. Tamper-/authenticity-proofing is the **encrypted backup's** job: its `payload.bin` is sealed with AES-256-GCM, whose auth tag is verified at decrypt time (a stronger, keyed check), and the hash rides along inside the encrypted inner payload for free rather than being duplicated at the envelope level.

The **encrypted backup envelope** carries the `format` tag `"luma-encrypted-backup"` in its `manifest.json`.

**The keypair generator stores nothing.** Encrypted backups need a keypair the user owns, and producing
one otherwise means knowing an `openssl` incantation — a barrier unrelated to the decision being made. So
`POST /import-export/backup/keypair` will make one, with **no side effects at all**: no recipient row, no
file, no record that it was called. The private half is returned once in that response (`Cache-Control:
no-store`, never written to either database) and the *caller* submits the public half to
`POST /backup/recipients` only after the user has saved it — so a recipient can never exist whose private
key was never kept. Optionally passphrase-protected: a passphrase produces standard PKCS8
(`BestAvailableEncryption`), so the file is readable by `openssl pkcs8` and by restore's own
`load_pem_private_key`, and improves as the library does.

Generating server-side rather than in the browser is deliberate. The browser's selling point — that the
app never sees the private key — does not survive the observation that the app is what serves the script
doing the generating, and it would cost hand-built PKCS8 encryption in JavaScript whose failure mode is a
key file that only proves unreadable at restore. Here the library that writes the key is the one that
reads it back.

**The UI calls these "backup keys"; the code, the API and the file format call them recipients.** The
divergence is deliberate, not drift: `manifest.json` writes `recipient_id` and `wrapped_keys[].label` into
every encrypted backup ever produced, so that name is permanent in the format, while "recipient" reads as
a person being sent something — which is wrong for what is usually your own key, kept so you can read your
own file later. The line falls at the user-visible boundary: display text says *backup key*, and
`backup_recipient`, `/backup/recipients`, `?recipients=` and the manifest fields keep the original name so
the code agrees with the artifact it writes. Do not "fix" one side to match the other.

**`enabled` is eligibility; the selection is per backup.** An encrypted export with no recipient list
seals to every enabled recipient, which is what a single-recipient install always wants. Naming ids
(`?recipients=…`) narrows it, for a file going somewhere that should not be openable by every key on the
list — and an id that is unknown or not enabled is an **error, not a silent omission**, since encrypting
to fewer keys than were asked for yields a file the user believes one of their keys opens and none does,
discovered at restore. The UI asks which keys only when more than one is enabled: a dialog showing a
single entry that is always accepted trains dismissal rather than providing verification.

The public key stays retrievable from its recipient row (an **Export** action saving SPKI PEM — `.pem`,
not `.pub`, which reads as an OpenSSH key and is a different format). That exists for one use: adding the
same recipient on another install, which is a paste-the-public-key job. It is deliberately *not* a
recovery path, because there is nothing to recover — a PKCS8 private key already contains its public half
(`openssl rsa -in key.pem -pubout` reproduces it), which is also why the generator hands over the private
key alone rather than a pair. Bundling both would imply the public half is precious and dilute the one
message that file has to carry.

**Recipient names must be unique**, compared case-insensitively on the trimmed value, on both add and
rename. Not tidiness: the name is how a person tells two saved keys apart, since the fingerprint beside it
is forty characters of base64 that settles nothing at a glance — so two rows sharing a name make the list
unreadable at exactly the moment it matters, choosing which key a backup was sealed to.

Keys are required to be **at least 2048-bit**, whether generated or pasted (the generator offers 2048 /
3072 / 4096 and defaults to 4096). The floor is not ceremony: a backup is a long-lived artifact, so the
key has to hold for however long the file sits on a drive.

The payload is also **stamped** with the source data DB's `instance_id` (from `db_meta`) and its `access_mode` (`local`/`auth`). Restore uses this as a **compatibility guard** so it can't silently replace the wrong system: it proceeds freely when the target is empty (no accounts/transactions — a fresh install) or when restoring this system's *own* backup (matching `instance_id`) in the same mode, but returns `409 {code: "restore_incompatible", reasons: […]}` when the target already has data and the backup came from a *different* `instance_id` (`different_system`), when the access modes differ (`mode_mismatch`), or when the backup's `schema_version` is **newer** than this build's `CURRENT_VERSION` (`newer_schema` — the lossy downgrade above). An older or absent `schema_version` is safe and never flagged. The UI turns that 409 into an explicit confirmation and retries with a `force` flag; `force` is the only way past the guard, so an accidental cross-system, cross-mode, or downgrade wipe always requires a deliberate second confirmation.

**A connection is split across the two backups, and a restore reconciles it rather than replacing it.**
The credential (`credential`/`credential_enc`) rides the credentials backup; everything that describes the
ledger in a data backup rides with it, in the `connections` section — that the connection exists, its
captured fields, what its last sync did (`last_synced_at`, `last_sync_error*`,
`consecutive_sync_failures`, `last_sync_warnings`, `reauth_required`, `last_sync_outcome`,
`last_sync_summary`) and how far it had read (`transactions_cursor` + `initial_sync_complete`). The resume
point belongs with the data because it is a *claim about data held* ("every change the provider has
reported is in the ledger") and was written in the same export as the rows it claims, so handing it back is
what returns the system to the backed-up moment: the next sync is a delta from there, re-delivering
everything the provider reported since, rather than a full backfill that finds the whole history already
held. It is an opaque position in the provider's feed and opens nothing without the credential. Because
`connection` is never wiped, a data restore (`_restore_connections`) works through three cases:

- **A connection the backup names and this install has** (same id, or the same provider handle under
  another id, which the restore then maps the backup's references onto) takes the recorded state. Its
  credential stays.
- **One the backup names and this install lacks** — a fresh install, or credentials not restored yet — is
  created **without a credential**, the "waiting to be re-linked" state below, so its accounts, mappings and
  sync cards survive instead of being dropped for want of a parent (a sync card naming a missing connection
  failed the whole restore on its foreign key). A credentials restore later fills the credential in on that
  same row.
- **One this install has and the backup does not name** loses only its resume point: its synced rows went
  with the rest of the ledger, and a cursor past them would leave every one behind it for good (the same
  reset `Remove synced transactions` performs after deleting rows). A backup written before the section
  existed names no connections, so every connection takes this path.

The backup's resume point is not handed back in two cases, which reset it instead: a backup older than
`RESTORED_CURSOR_MAX_AGE_DAYS` (Plaid documents a cursor as valid for at least a year) or with no export
date, and a live row whose handle has changed since, which reads a different feed. Three columns stay with
the target and are listed, with reasons, in the backup coverage test: `provider_request_budget`, because
spending is a record of requests the provider really received and a restore cannot un-make them, and
`sync_started_at`/`sync_progress`, which describe a sync running in the process that wrote them.

**A credentials restore fills credentials in; it does not replace connection rows.** It matches each file
connection by id, then by provider handle, and writes the credential (and the handle, since the ciphertext
is bound to it) onto that row, inserting only a connection the install has never had. A connection the file
does not hold keeps its row and loses its credential, flagged `reauth_required`, exactly as a vault reset
leaves one. It once deleted every connection and re-inserted the file's, and because `connection_account`
cascades from `connection`, restoring credentials onto a ledger that already held its mappings — the state a
data restore leaves — erased all of them. Together the two rules make the backups order-independent: data
then credentials, or credentials then data, end in the same rows.

**A connection may hold no credential at all, and that is a state rather than a fault.** A vault reset
clears `credential`/`credential_enc` on every connection and deliberately *keeps* the rows, because the
account mappings, per-account coverage and sync history hanging off `connection_id` are the expensive part
and are not lost with the credential — the row is what a re-link lands back on. So "no credential" means
*this connection is waiting to be re-linked*, and `crypto_service.connection_has_credential` is how a
caller asks without attempting a decrypt.

The consequence is a rule for every path that reaches for one: `decrypt_connection_credential` raises
`MissingCredential` rather than returning `""`. It previously returned the empty string, which is
indistinguishable from a credential, so callers passed it to the provider — Plaid answers *"access_token
must be a non-empty string"*, and because `disconnect` converts a failed revocation into a 502 that keeps
the row, the connection that could not be revoked also could not be deleted. A reset therefore left husks
with no way to clear them. Each caller now answers in its own terms: a **disconnect** skips the provider
call and removes the row locally, reporting `revoked: false` (for a provider that normally *does* revoke,
that is a real caveat — the access may still be live at the provider); **re-authorize** and
**refresh-accounts** refuse with somewhere to go; a **sync** skips and flags `reauth_required`.

**A restore adopts the backup's `instance_id`.** Because a restore is a full replacement — it wipes the target and reloads the backup wholesale — afterward the data *is* exactly the backup's system, so the DB takes on the backup's `instance_id` rather than keeping the target's old one. (Only the identity changes; `access_mode` is a property of the deployment, not stored in the DB.) This keeps identity meaning "which data lineage this is": without it, restoring a backup into a fresh DB and then restoring the *same* backup again would wrongly trip the "different system" guard, since the fresh DB would still carry its own throwaway id. The guard itself is unaffected — it compares the *incoming* backup against the *pre-restore* data to decide whether confirmation is needed; the adoption only sets the identity the DB carries once that data has been replaced. The `instance_id` also namespaces browser-local UI caches (remembered profile, account-UI state) per database, so adopting the backup's id keeps those caches aligned with the data lineage they describe.

### Preferences

Non-sensitive **UI/layout preferences** — page layouts, collapse state, dashboard view, the currently-selected dashboard breakdown, import-page UI state (expanded rows, panel positions), etc. — live in the **data DB** in `ui_preference(scope_id, pref_key, pref_value)`. `scope_id` is the authenticated user id (auth mode) or the local-preference-profile id (local mode). They live here, with the data they describe, rather than in the control DB — so a data backup carries them and there is no cross-DB/scope plumbing. The **control DB keeps only identity/secrets** (users, auth secrets, recovery codes) and the local-preference-profile *definitions*; profile names stay control-side, the preference *values* are data-side.

**The dividing line is per-user chrome vs. shared data state.** `ui_preference` is only for things that may legitimately differ per person — column choices, collapse/sort state, panel geometry, which dashboard view/breakdown they prefer. State that describes *the shared data itself* must not be scoped per profile, because every user is looking at the same data and a restore into a different profile would orphan it. Such state lives in shared `import_workflow_state` (the workspace-wide KV store, carried by backups) instead. Two worked examples: the "Group Imported Categories" workspace draft (how the one shared category tree is being organized — `system_category_workspace_draft`, see `architecture.md` → Organize / inactive surface), and the **dashboard tag-report catalog** (`system_dashboard_tag_reports`, via `GET`/`PUT /tags/dashboard-reports`). The tag-report case shows the split sharply: the *catalog* of saved reports is shared (everyone sees the same saved reports), while which report a user currently has open (`ui.dashboard.spendingViewBy`) stays a per-user `ui_preference` — **shared catalog, personal selection**. When adding a new persisted value, classify it on this line before choosing a store.

The `/preferences` API (`auth.py`) is the single facade: it resolves the scope id and reads/writes `ui_preference` (via `services/preferences.py`). `init_control_db` drops two legacy tables (`user_preference` / `local_preference_value`) from installs that predate the move into the data DB, so the control DB holds only identity and secrets.

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
trash), and `is_managed`; **v16** adds the `amazon_pending_item` parked-items table; **v17** adds the
`amazon_charge_reviewed` table (reconciliation reverse-scan "Mark reviewed" acknowledgments).

The list above is illustrative rather than exhaustive — `database.py`'s `@migration` registrations are the
record, and each carries its own reasoning. The ones this document's other sections rely on are called out
where they matter: **v20** makes the account→connection link provider-neutral (`plaid_account_id` →
`external_account_id`, `plaid_item_id` → `connection_id` + `provider`) and drops the vestigial `plaid_item`
table, **v24** backfills `connection_account` mappings, **v25** widens unset CSV terminal windows, **v26** renames `txn.plaid_transaction_id` to
`external_transaction_id`, **v27** adds the connection sync-health columns, **v28** moves history state onto
`connection_account`, **v29** adds `connection_account.provider_currency`, and **v30** adds
`connection.reauth_required`. **Do not restate the current version here** — `database.py`'s
`CURRENT_VERSION` is the only copy that can be right, and a number transcribed into prose goes stale at
the next migration (this one read `30` while the code was at `48`).

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

- a migration that changes what an existing database *holds* — renames a column with data in it, sets a
  value on rows that exist, backfills from another table, drops an index that forbade rows now allowed, stamps
  an identity — gets an upgrade test from a hand-built database at the version before it. A fresh install is
  created directly in the current shape, so it proves nothing about an upgrade. Everything from v26 to v53
  that does this is covered in `test_migrations_after_v25.py`; purely additive migrations (an empty column or
  table) need none

- a data step must **check that the tables and columns it touches exist** and return quietly if they do
  not. The per-migration tests (`test_migration_v24.py`, `test_account_type_rules.py`, …) hand-build a
  minimal schema at an old version and then run the *whole* chain to `CURRENT_VERSION`, so every later
  migration executes against a database holding only what that one test needed. An unguarded `UPDATE txn
  SET category_overridden …` (v54's first draft) failed thirteen tests that have nothing to do with it; v53
  and v54 show the `sqlite_master` + `PRAGMA table_info` guard

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

- `exclude_from_totals` must be honored consistently across summaries and charts

- category grouping is only two levels deep

- **a group's total equals the sum of its category slices.** No single bucket can look wrong on its own when this breaks, which is why it is the invariant worth testing (`test_report_sign_filters.py`). It holds because a leaf's type always matches its group's, across creation, moves and retyping (see *Categories*)

- **every category rollup counts allocations, not transactions.** A split transaction contributes one row per `txn_split` part, carrying that part's category and amount, so the rules above apply *per allocation*: an excluded part leaves the totals while its siblings stay, and an income-typed part negates on its own terms. This is a property of the row source (see *Transaction splits* below), not of each query — a new category aggregation gets it by selecting from that source, and silently loses it by selecting from `txn` directly

If any of these assumptions change, both backend queries and frontend UI logic will likely need coordinated updates.

### Cash flow

Cash flow is a **frame over the same population**, not a separate rule set: all transactions, minus
`exclude_from_totals`, netted. The endpoints are in `architecture.md`; what follows is what the numbers
are allowed to mean.

**`exclude_from_totals` is the entire exclusion mechanism.** Excluded from spending means excluded from
cash flow, and there is no second axis. The directional asymmetry people expect comes out of
**categorization, not configuration**: an inflow that funds spending is categorized somewhere *not*
excluded and reads as income, while a transfer out that represents saving is categorized somewhere
excluded and drops out. No new field, no new setting, no new system category.

Three richer mechanisms were considered and rejected. **Do not re-propose them:**

- **Transfer-leg pairing** — treating a movement as internal when both legs are visible and as
  boundary-crossing when one is missing. It decides *dynamically* what the category flag already decides
  declaratively. (Recurring series *do* pair their two legs, under *Recurring series* above, but only to
  draw one card over them — it changes no total, and is not a route to this.)
- **A boundary relative to the current filter selection** — money "leaving" whatever accounts are
  selected. Its motivating case, validating a period against a statement, is served by reading the
  statement. What it costs is disqualifying: cash flow for two accounts selected together would not equal
  the sum of each selected alone, so *adding* an account to the filter could *lower* the total.
- **A separate `exclude_from_cash_flow` flag**, or a settings surface for exempting categories. A second
  exclusion axis on categories drifts against the first.

**Credit-card payments need no special handling.** A card payment already sits under the seeded
`Transfers` group, so the `COALESCE(parent, leaf)` rollup excludes it, while the purchases on that card
count at their own transaction dates. The double-count that would otherwise arise does not exist.

**A bucket's side is the sign of its own net, not its `category_type`.** An expense category that
refunded more than it spent moved money *in* that period. This is what keeps the frame honest under
signed-net reporting — no link in the diagram can have a negative width, so the alternative would be an
`ABS()` somewhere. The consequence to design against: **a bucket changes sides between periods**, so
nothing durable — colour, ordering, identity — may be keyed to the side it landed on.

**The atom is a category's net for the period, not a transaction's sign.** A period's inflow is the sum
of the categories that net money in and its outflow the sum of those that net money out, so a period's
two bars *are* the two sides of that period's diagram. **Do not switch it to gross** to simplify the
SQL: reading every negative-amount row as inflow and every positive one as outflow nets to the same
figure while reporting larger magnitudes in both directions, and stops reconciling against the diagram
beside it.

**A rolling window is calendar months, not rows.** The two differ exactly when the ledger skips a month
— taking twelve rows and running the axis continuously across them spans thirteen or more months under
a label reading "Last 12 months". A ledger shorter than the window starts where its data starts rather
than being padded with months it never had.

**A tag report has no cash-flow reading.** A signature bucket mixes categories from both directions, so
it has no single direction to net and no `category_type` to derive one from. Deciding what a
mixed-direction signature's net *means* is the prerequisite for any proposal here.

## Transaction splits

A purchase that spans categories — part groceries, part hardware — is held as **one ledger row with a set of allocations** (`txn_split`), never as a parent row with children. The per-item-rows model was already tried and abandoned for the marketplace importer (orders-only, 2026-07-10, see *Transaction links and Amazon order import*); reviving it here would have brought back a visible parent/child hierarchy, a double-count risk, and tree handling in editing, undo and import, to solve a problem that is really about reporting.

A part also carries an optional **`label`** — free text naming what that allocation covers, defaulted from an imported order's item description and meant to be edited down by the user. It is descriptive only: no report or total reads it, which is why it can be changed freely while the category and amount carry the protections below. It is *shown* and *searched*: a part row in a category-scoped list carries its label under the merchant name, and the ledger's unprefixed search reads it — any part's label for a whole split (marked `matched_split_label`, since the row shows no label), only the row's own part's label under expansion, so a search inside one category does not return a sibling part of the same purchase. It exists because without it a saved split is a column of amounts with no record of *why* each was set — the pre-fill's item names were visible while editing and then thrown away. Marketplace item titles routinely run past 200 characters, so the stored value is capped and every display truncates it with the full text on hover.

**The invariants**, enforced on save in `services/txn_splits.py` rather than by the DB, because no SQLite constraint expresses a cross-row sum:

- the parts sum to the transaction's amount, to the cent
- every part shares the transaction's sign — `_summary_signed_total_sql` needs a bucket's type to be constant, and *Reporting assumptions* ties income groups to money-in, so a mixed-sign split would report against both. (A part representing a refunded item is a coherent future relaxation, deliberately not built.)
- several parts **may** name the same category. A split records the *items* a payment covered, and two items bought together can classify alike — two records from one order are two purchases at two prices, and folding them into one allocation would discard exactly the detail a split exists to keep. The cost is that an expanded bucket holds more rows than transactions, which is paid for on the reporting side: **every summary counts `DISTINCT` transactions**, not rows. (The list endpoint keeps a row count, because its count drives pagination.) An earlier one-part-per-category rule was imposed to avoid that count change and was wrong — it traded the user's data for a query convenience
- a part names a leaf, never a group — the same rule ordinary categorization follows
- at least two parts; one part is a category assignment, and admitting it would leave a row flagged as split, reporting identically to an ordinary one, while being skipped by every automatic pass

**A part is *shown* in the transaction's own direction, not as it is stored.** Since every part shares the transaction's sign, a part's sign states nothing its transaction's amount does not already state — and printed raw it contradicts it, because the ledger displays a stored amount negated (`getTransactionDisplayAmount`): a deposit's allocations read as money out beneath a row reading money in, and splitting a deposit means typing a column of negative numbers. Both surfaces that show parts — the row's hover card and the split editor, which works in that direction end to end and converts back on save — therefore multiply by `transactionDirection`, so a charge's and a deposit's allocations alike read as shares of the whole and direction is left to the row's own amount and the money-in green. Multiplying rather than taking an absolute value is what keeps this honest should the mixed-sign relaxation above ever be built: an opposing part would still print negative, and the parts on screen would still visibly sum to the transaction.

`txn.category_id` is **retained** while a row is split, as the stashed prior that un-splitting restores — the same reversal discipline the `txn_link` metadata follows for an excluded charge. `txn.is_split` marks the row for everything that must know it is split without reaching for its parts.

**The expansion seam is the whole reporting story.** Every category aggregation selects its rows from `txn_effective_sql`, which left-joins `txn` to its allocations and substitutes the part's `category_id` and `amount` wherever one matched. A non-split transaction joins to nothing and yields itself; a split one yields a row per part. Because the summary and list queries were already phrased entirely against one alias — `t.category_id`, `t.amount`, `t.id` — every facet filter, uncategorized sentinel, signed-total expression and `exclude_from_totals` guard then applies per allocation with no restatement. The substitution keys on whether a part row *matched* (`s.txn_id`, NOT NULL) rather than on its values, so a part whose category was deleted stays uncategorized instead of falling back to the transaction's own.

The list feed carries a split row's allocations inline (`split_parts`, plus `split_part_count`), resolved for the whole page in one query keyed only on the rows already flagged `is_split`. They are part of the payload rather than a per-row lookup because the ledger renders them in the row's hover, where a fetch would mean a loading state inside a tooltip.

**An expanded row is not a transaction, and says so.** The seam also projects `split_part_id` — the id of the allocation that matched, null where none did — and the list feed carries it. Two things need it, and both are silently wrong without it. First, **identity**: expanded, `t.id` no longer identifies a row, because two parts may name the same category (the split rules permit it) and come back as two rows with one id; two parts alike in category *and* amount are not distinguishable by value either, so the part id is the only honest key, and it is what the windowed lists key their rows by. Second, **which kind of row this is**: an expanded row carries the part's `category_id` and `amount` but the transaction's own `is_split`, so a renderer reading the flag alone treats one allocation as the whole split — labelling a $10 part "Split (2)" and answering a hover about it with the other part's $240. `split_part_id IS NOT NULL` is the test that separates the two, and the frontend writes it down once in `lib/splitRows.js`.

**Expansion is opt-in per query, and the rule is what a query is *for*.** Summaries and trends always expand — rollup is their job. The transaction list expands **only when a category-shaped facet scopes it** (a category or group filter, or a `spending`/`income` view, which resolve through a category): scoped that way a split returns as the part that matched, so a drill-down's visible rows sum to the total its summary reported; unscoped, the ledger shows one row per purchase at its full amount. Everything else — dedupe, rule matching, recurring detection, import — reads plain `txn`, because those operate on the purchase rather than on how it was allocated. The CSV export follows the list (it shares `transaction_list_scope`), so a category-scoped file holds the matching parts; unscoped, a split exports once at its full amount with **Category and Group reading `--split--`** — a CSV row cannot hold several categories, and `txn.category_id` on a split is only the stashed pre-split prior, which a file would otherwise present as current. The marker is deliberate over an empty cell, which would read as *uncategorized* — an equally wrong claim, and a silent one. **Copying is the other answer to the same question**: the clipboard and share text are read by a person rather than re-imported, so there a split names every category it touched (`Groceries / Hardware`, repeats collapsed, a name containing the separator quoted — `splitCategoryNames` in `lib/splitRows.js`).

**Tags resolve per part without any special handling.** A row's effective tags are already the union of its direct `txn_tag` rows (keyed on the transaction id) and the tags inherited from its category. Under expansion a direct tag therefore applies to the whole transaction and every part, while an inherited tag follows each part's own category — which is the semantic worth wanting, and is what the existing SQL already meant. One consequence to expect: in the tag-signature report a split transaction can contribute to two signature buckets, each with its part's amount.

**Pre-fill has refusal edges, and they are not guesses.** Where a split is seeded from an imported
order's captured item detail, an item with **no list price** is excluded from the proportional weighting
and lands as a **zero part for the user to fill** rather than being dropped or estimated; and pre-fill is
**refused outright** when net cash is zero (a fully gift-carded or points order) or when the list prices
sum to zero, since there is nothing to apportion against.

**The seam is a left join rather than a union of the split and non-split branches, and that is measured
rather than stylistic.** The obvious formulation — select the unsplit rows, `UNION ALL` the split ones
joined to their parts — reads `txn` twice. Measured on a real-scale ledger of ~18.5k rows **with no
splits in it at all**, that cost about **80%** on top of *every* summary query (23.6 ms → 42.9 ms), and
driving the second branch from `txn_split` instead barely moved it (41.9 ms). The left join measures
**~6%** (23.6 ms → 25.0 ms). A feature nobody has used yet should be close to free on every report in
the app, and this is the difference between that and a standing tax on all of them. **Do not "optimize"
it back into a union.**

Which paths may and may not overwrite a split is covered under *Categories* → "How an existing
transaction's category can change"; the alternatives that were rejected, and the neighbouring mechanisms
a split is not, are in [`mechanism-index.md`](mechanism-index.md).

## Attached documents

A transaction records that money moved and where it went; it does not record *what was bought*. For most rows nobody cares. For the ones where it matters — a car repair, a service invoice, a warranty-relevant purchase — the useful fact exists only on a document the app has never seen. A **document** (`document`) is that paperwork attached to a transaction: the row is the record, the bytes are a file under `documents/` beside the data database.

**A document can be kept before its transaction exists.** An invoice routinely arrives days before the charge it describes is imported, and making someone find it again later is the cost this avoids. Such a document is **stored**: `txn_id` is NULL, and it is attached later by setting it. That is a column value rather than a second store on purpose — upload, extraction, the digest, the viewer and the backup are all the same for both states, and attaching or detaching never touches a file. The consequences worth knowing:

- **Nothing cascades a stored document away.** Every wipe of the ledger that relies on deleting transactions (the restore, the demo-data clear) names the `document` table explicitly; a wipe that forgot would leave stored documents from before a restore mixed into the restored ledger.
- **A document is taken off a transaction in one of two ways, and they differ in what can be undone.** *Detaching* moves it back among the stored documents — the answer to "attached to the wrong transaction", reversed by attaching it again. *Deleting* removes the row and then the file, and nothing brings it back. Moving a document from one transaction straight to another is refused rather than offered: no surface does it, and a mistaken request should not quietly take a receipt off the row it belongs to.
- **Arriving where an identical file already is folds the two together.** Attaching a stored document to a transaction that already carries the same bytes, or detaching one onto an identical stored copy, keeps the copy already there (and its name) and removes the moved one. It is the upload's duplicate check applied to a move, for the same reason: two entries holding one receipt differ in nothing a person can tell apart. The duplicate check on upload applies to the stored set as a scope of its own.
- **A stored document's text is indexed but explains no row.** Search reaches documents through the transaction they hang off, so a stored invoice is not found from the ledger until it is attached — at which point it is, with no reindexing, because the index follows the row.
- **A name can be changed after the fact,** attached or stored. It is display and download text only (the file is keyed by id), so a rename goes through the same reduction an upload's name does and cannot be emptied. A paste arrives named `documentation.<ext>` — neutral, since it could be a receipt, an invoice or a confirmation — and a lone document added to the store opens its name for editing, because the name is what it will be picked by later.

The noun is deliberate. **"Attachment" was already taken** — it means a *tag* attachment throughout this file ("tag definitions before any attachment") — and "document" reads better for a repair invoice anyway.

**Several documents may hang off one transaction**, and there is deliberately no unique index saying otherwise. A repair arrives as an estimate and then a final invoice; a two-page bill arrives as two photographs. Constraining that would be a limit on what the user is allowed to record whose only justification is that one file is the common case, which is not a reason.

**Files on disk, not blobs in the database.** The backup payload is JSON, so a blob would have to be base64'd into it — a third larger, and a receipt that has to be held whole in memory to be encoded. Files keep the bytes out of the JSON entirely, which is what lets both backup directions copy them straight between disk and zip member with a fixed buffer, at any size. The directory is derived from the data database's own path rather than from `DATA_DIR`, so a `DB_PATH` override (which an install carrying pre-rename filenames uses) keeps documents beside the ledger that references them rather than beside a directory the environment happened to name.

**The write order is the invariant, because file and row cannot be one transaction.** The file is written first and the row second, so a crash between them leaves a file with no row — inert litter a sweep reclaims — rather than a row with no file, which is a broken link on screen. Each file is written to a temporary name and `os.replace()`d into place, so a torn write is never visible under the real name and "present on disk" keeps meaning "complete".

**`document.sha256` is not bookkeeping.** It is what lets a restore tell a complete file from a torn one and resume, what extends a backup's integrity check to cover the files rather than only the JSON, and the natural key for noticing the same receipt was attached twice. It and `byte_size` describe the **stored** bytes, which are not always the uploaded ones — see downscaling below.

**Removal is derived from the ledger, never declared beside it.** Everything that destroys documents — a purged transaction, a cleared demo dataset, a restore replacing the ledger — deletes rows (or lets `ON DELETE CASCADE` do it) and then *sweeps* files the ledger no longer references. Two reasons: the file-first write order makes litter a normal outcome that something has to reclaim anyway, and an interrupted destructive operation then leaves extra files rather than having already deleted originals it cannot get back. The sweep's one subtlety is that it must not race an ingest — between that file write and its row commit a file is legitimately unreferenced — so incremental callers spare recently-written files and a restore, which has just replaced the entire ledger, does not need to.

**Documents follow their transaction through the trash.** Trashing hides the row and its documents together, restoring brings them back intact, and the age-based purge deletes the transaction, cascades its document rows, and sweeps the files. The trash is the reversible stage and the purge the irreversible one; documents inherit that rather than defining their own lifetime. A stored document has no transaction to follow and so no trash: it stays until it is attached or deleted.

**In the backup they ride the *data* bucket**, because a document is transaction detail rather than a credential — and it is the backup people actually take, so anything else would mean a backup that silently omitted every receipt. The rows travel as the `documents` section and each file as its own `documents/<id>` member, stored rather than deflated. Their digests are deliberately **not** repeated in `meta.json`: the digest on the `document` row is the one source of truth, and duplicating it would create a second that could disagree.

**Row-and-file drift is expected rather than exceptional, and always resolves toward keeping the ledger.** An export whose file is missing writes the row without its member instead of refusing to produce a backup — withholding the whole ledger over one unreadable receipt is the worst available answer. A restore reports a document it could not write, or one that failed its digest, and keeps going; a file that arrives corrupt is *deleted* rather than left, so the "present means intact" invariant survives.

**A document is a file, a photograph, or pasted content.** Text is a first-class kind rather than only something extracted *from* a document: a receipt forwarded by email is pasted rather than saved first, and that paste is the whole of the email story — no mailbox polling, no receiving address, nothing that would put mail credentials in the vault. A pasted-text document stores exactly what was pasted and carries `text_source = 'verbatim'`, which is deliberately **not** an extraction tier: nothing was interpreted, so it is the most trustworthy text the store holds and a later re-extraction pass must never treat it as weaker output to improve on. Text is also the one accepted kind with no magic number, so it is identified by *decoding* — and only when the upload claimed to be text, since plenty of binary happens to decode and this is a receipt store rather than a general file dump.

**A paste keeps the layout it came with, because the clipboard carries more than one flavour.** A receipt copied out of an email offers both `text/html` (the table the sender laid out) and `text/plain` (that table flattened, every cell on its own line, so an amount lands *under* the item it prices rather than beside it). Storing the plain flavour loses structure that was never the app's to lose, so a formatted paste is previewed as formatted and stored as `text/html`. It is attached as shown or discarded; the formatting is not editable (the interaction is in `ui-patterns.md`). The rich flavour is only taken when it actually contains markup — a source offering `text/html` that is merely the same words again has no layout to preserve, and storing it as HTML would be strictly worse. Its search text is the markup with tags removed (`text_source = 'html_text'`): derived, but from the document's own words rather than from interpreting a picture of them, so it sits with a PDF's text layer in reliability. A table row becomes one line with its cells tab-separated, so the extracted text keeps an amount on the same line as its item. That has to hold against how point-of-sale receipts are actually marked up, with the item name in a `<div>` *inside* its cell: a cell's content is gathered on its own and only its edges are trimmed, so the block around a lone item name does not split the row, while breaks within a cell (a work order's notes) survive. Cells whose end tags were omitted close at the next cell or row of their own table, and a layout table around the receipt does not merge it with the letterhead. Source whitespace is not layout and collapses as a browser collapses it; script and stylesheet bodies are dropped, being text to a parser and noise to a reader. Search text already stored under an earlier extraction is not rebuilt; its terms are the same words, and the ledger search matches terms rather than lines.

**A saved email (`.eml`) is accepted and converted at ingest.** It is the one receipt source no clipboard quirk can defeat, and no browser renders one — so keeping the message would mean storing a document that could never be viewed. Its HTML part becomes the document (falling back to the plain part), which keeps the seam's promise that every ingestion path produces *(bytes, media type, filename)* and nothing downstream knows where they came from. The **subject** becomes the filename, since an exported message is usually named opaquely by whatever produced it while the subject is what a person recognizes later. `message/rfc822` is therefore an *accepted upload* type but never a stored one. Detection reads the first line for a real RFC 5322 header rather than trusting the declared type, which browsers report inconsistently for `.eml` — and requires the colon to arrive before any whitespace, so a text file that merely opens with the word "From" stays a text file. **Inline `cid:` images do not render**: the sandbox CSP blocks every subresource, so an image-heavy receipt arrives with gaps — the honest cost of never fetching anything an email points at.

**Stored HTML is rendered under the same headers as everything else, which is what makes it safe to keep.** `Content-Security-Policy: sandbox; default-src 'none'` accompanies every document: `sandbox` with no tokens means no scripts and an opaque origin, and `default-src 'none'` blocks every subresource — including the remote tracking images an email may carry, which would otherwise fire the moment a receipt was opened. That header was added for PDFs and covers this unchanged, which is why storing markup from an email needed no new defence. The one place pasted markup is rendered *before* it has a URL to carry that header — the attach preview — rebuilds the same policy on the client (`lib/pastedHtmlPreview.js`), so nothing an email points at is fetched at that step either. **Neither stops a frame navigating itself**: the preview removes links and refresh directives for that reason, while a stored document's links still load their target inside the viewer when clicked.

**A `text/plain` document can be edited after it is attached, and an edit is a replacement.** The file cannot be rewritten in place: `sha256` must describe the bytes on disk, and file and row cannot change together, so an in-place rewrite has a moment where they disagree, and a crash in it leaves a document that restore and backup both read as torn. So an edit is ordinary ingest (`replace_document_text`): the new file is written, the old row is deleted and the new one inserted in one transaction, and the old file is removed after that commits, or by the next sweep if the request dies first. The filename and `created_at` carry over, so the document keeps its name and its place in the list; **its id does not**, and every holder of a document id has to swap it, which for the ledger row's own copy is the viewer's `onDocumentReplaced` contract. The replacement is still `text_source = 'verbatim'`, because the edited text is exactly what the person wrote. An edit is **not** checked against the transaction's other documents for duplicates: that check catches the same file dropped twice by accident, and an edit is a deliberate statement of what the text should be. An edit to nothing is refused (removing the document is the way to do that), and HTML, PDFs and images are not editable. HTML is kept for its formatting, and editing markup safely costs more than trimming a receipt is worth.

**Ingest is deliberately lossy for photographs and lossless for PDFs.** A receipt shot at 12 MP is ~4 MB and carries nothing above roughly 300 DPI at text size that any reader or extractor can use, so an oversized image is downscaled once, at ingest, and the original is not kept — worth doing on its own merits, not as a response to storage pressure. Three rules shape it: EXIF orientation is applied before re-encoding (which drops EXIF, so a naive resize lands the receipt sideways), an image with transparency stays PNG (flattening alpha changes the picture rather than trading quality), and a re-encode larger than its input is discarded. Small images pass through untouched, since a screenshot's crisp text is what JPEG treats worst. PDFs pass through byte-for-byte: re-rendering one needs far more machinery, a digital invoice is small anyway, and its text layer is exactly what makes it worth preferring. A generous per-file cap (~25 MB) stops pathology; it is not a ration, because a cap that rejects is a dead end for someone photographing a receipt with the phone they own.

`document.text` holds text pulled out of the document and `text_source` records which tier produced it. NULL means no text was obtained — a photograph, or a PDF with no text layer — which is distinct from a document whose text is genuinely empty. Nothing but search reads it, so a document with no text is fully functional. **`text_source` is recorded rather than inferred from the media type** because the tiers are not interchangeable in reliability: a PDF's own text layer is exact, OCR is a guess, and anything reading the text later — a decision to re-extract once a better tier exists, how much to trust a match — needs to know which it got. Tier 1 (a digital PDF's text layer) is the only one that runs today; a PDF yielding only a handful of stray characters is treated as having *no* text layer, since recording that as an extraction would mark the document searched when nothing searchable was found.

**Searching a receipt works from the plain search box, and `doc:<terms>` narrows to documents only.** The text is indexed by SQLite's built-in FTS5 (`document_fts`, external-content over `document.text`, so the terms are stored but not a second copy of the text). **Why not `LIKE` over the text column:** it is a substring scan that grows with the stored text, and substring is the wrong instrument for prose, where word matching is what a person means by searching a receipt. Terms match by prefix and several terms are an AND, and every term is quoted before it reaches FTS5 — MATCH is a query language, so raw input would turn an ordinary typo (an unbalanced quote) into a server error and let a search accidentally become an expression.

**A row that matched inside a document says so, and that is what makes the plain-box behaviour safe.** Document text was first put *behind* the prefix on the reasoning that an unprefixed hit has no visible cause — every field shown on the row lacks the term, so it reads as a wrong result. That reasoning was right about the problem and wrong about the remedy: it was reversed on first real use, when searching for a word from a just-attached receipt found nothing. The fix is to show the cause rather than hide the match — the list feed projects `matched_document` for rows whose match came from an attachment, and the ledger emphasizes the document marker on them. The projection is added **only when the filter actually has a document component**, so an ordinary listing pays nothing for it, and it is deliberately absent for a field-scoped filter like `merchant:` — the flag is a *reason*, and marking a row that matched its payee would send the reader looking for an attachment that had nothing to do with it. Don't re-impose the prefix-only rule: the discoverability cost is real and the objection it answered is already handled. The same resolution was later applied to a row's imported text — its raw name and captured free text are searched from the plain box and marked with `matched_hidden_text` — see `ui-patterns.md` → *The ledger search*.

**The index is maintained by triggers, which is a correctness requirement rather than a style choice.** A `document` row is most often removed by `ON DELETE CASCADE` when its transaction is purged, and a restore rebuilds the whole table by streaming rows in — neither is a place application code could hook even if every endpoint remembered to. An index that missed those would keep returning transactions that no longer exist. The same property means the restore needs no search awareness at all: rows land, the index follows. It is derived state and is deliberately **not** backed up; it is rebuilt from `document.text` whenever it is created.

The extraction tiers above tier 1 — local OCR, a BYOK line-item extractor, and the splits hand-off they feed — are unbuilt; see [`backlog/transaction-attachments.md`](backlog/transaction-attachments.md).

## Multi-payment purchases

A deposit and a final payment — or a three-instalment plan — are several real movements of money that
together buy one thing. Each is recorded correctly on its own date, and nothing in the ledger says they
belong together: "what did the deck actually cost" has to be reassembled from memory, and a deposit
sitting alone reads as a mysterious partial amount.

A **purchase** (`txn_link` `kind='purchase'`, `services/purchase_links.py`) is that grouping. It is the
third client of the link primitive and by far the cheapest, because of what makes it different from the
other two: Amazon order itemization and wallet funding-leg suppression both exist to stop the *same*
money counting twice, so each recategorizes a leg into an excluded bucket and stashes the prior for
reversal. Here both payments are genuinely spent money on genuinely different dates. **Nothing is
excluded, restated or netted** — the link is pure association, exactly what the primitive is by
default, which is what makes grouping a purchase incapable of changing a total that was already right.

**Every reporting surface is deliberately untouched.** Summaries, trends, the dashboard and every drill
read plain `txn` and know nothing about purchases; a grouped payment reports exactly as it did before.
This is the opposite of the choice [Reimbursable expenses](#reimbursable-expenses) makes, and for a
stated reason: there the numbers are wrong across a period boundary and a holding
category is what fixes them, so pairing is optional and late. Here the numbers are already right and
only the *relationship* is missing, so the link is the whole feature and no category machinery is
warranted. Do not add one.

**What it holds.** The members carry role `payment`; `external_ref` is the invoice or order number when
there is one; `metadata_json` holds `label` (a name for the purchase) and `expected_total`.

- **`expected_total` is stored signed, in the ledger's convention** (`amount > 0` is money out), like
  every amount the API carries. A person types a magnitude — "6000", not a sign against a convention
  they have never seen — so the *UI* derives the direction from the payments being linked
  (`lib/purchaseLinks.js` → `signedExpectedTotal`) and shows the derived figure back before saving,
  which keeps the inference visible rather than silent. A sign the user typed explicitly is honored
  rather than overridden.
- **`unaccounted` is `expected_total − linked_total`, and is named for what it is.** The gap may be a
  payment not made yet or one made and not linked, and nothing in the ledger can tell which, so it is
  deliberately not called "remaining" or "owed". It is NULL when no expected total was stated — "not
  stated" is a real answer and is not the same as zero, which would claim the purchase is complete.

**The invariants**, enforced in the service rather than the schema (no SQLite constraint reaches across
the two tables to express them):

- **A transaction belongs to at most one purchase.** Not a query convenience: one payment covering two
  invoices would count whole into both purchases' totals, so admitting it would make the single figure
  this feature exists to produce wrong. Dividing *one* payment across things is the other axis —
  [transaction splits](#transaction-splits) — and the refusal says so.
- **Two payments minimum.** One payment is not a multi-payment purchase. Removing a payment that would
  leave fewer than two therefore deletes the whole link rather than leaving a degenerate one that
  renders "1 of 1".
- **Signs are not constrained.** A refund against the purchase is part of what it cost, so it may be a
  member and the honest total is the net. (Contrast splits, where a mixed-sign allocation would report
  one transaction against both an income and an expense bucket.)
- **One role for every member.** Which payment is the deposit is already told by the dates, and a role
  saying it again is a second truth that can drift from the first.

**Totals count live payments only; trashed ones stay visible.** A trashed payment is money that is not
in the ledger, so counting it would overstate the purchase — and it is given no ordinal, since it is
not one of the N the purchase is made of. It is still listed (struck through) rather than silently
dropped, because the trash is the reversible stage and a payment vanishing without explanation is worse
than one shown as removed. A trashed row cannot be *added* to a purchase, which is a different case: it
would contribute nothing, so a purchase whose figures do not move when a payment is added is the
confusing outcome being avoided.

**A purchase does not outlive its payments, and a trigger is what guarantees it.** A `txn_link` row has
no FK to `txn`, so hard-deleting the last member leaves an orphan link nothing will ever show again.
Transactions are hard-deleted from five scattered places (empty-trash, batch undo, account merge, an
Amazon order's removal, a restore's wipe), so `trg_purchase_link_prune` (`db/database.py`, created in
the deferred post-migration block alongside the recon-epoch triggers) drops a purchase link once its
last member row goes — the same "a trigger makes a miss impossible" reasoning the recon-epoch and FTS
triggers record. Its `WHEN` clause is scoped to `kind='purchase'` precisely because the other kinds run
multi-step reversals that must not have rows swept out from under them.

**No schema change was needed and none should be added.** `txn_link`/`txn_link_member` already carry
every field this uses and already ride in backups, so a purchase round-trips through export and restore
with nothing feature-specific in the payload. One side effect worth knowing: writes to `txn_link` bump
`recon_epoch`, so creating a purchase invalidates the Amazon reconciliation's cached attention count.
That is over-invalidation of the harmless kind the cache already documents — it forces one recompute on
the next read — and is not worth complicating the trigger to avoid.

**Four things were deliberately not built.** Each is re-proposable, so each carries its reason:

- **Automatic suggestion.** The plausible signals — same payee, two-to-four payments within a few
  months, amounts summing to a round figure — are weak on their own, and this repo's precedent for the
  shape is *advisory only, never guessed at*. The genuinely strong signal is the invoice, and
  `document.text` plus full-text search already exist to search one; what is missing is extraction, so a
  photographed invoice yields nothing to match on. **A re-open condition, not pending work** — revisit
  if OCR lands ([`backlog/transaction-attachments.md`](backlog/transaction-attachments.md) → tier 2).
- **A document attached to the purchase rather than to one payment.** The invoice that revealed the
  problem covers both payments and can currently hang off only one of them, arbitrarily. `document` keys
  on `txn_id`; letting it key on a link as well is a real change to that table's contract.
- **A Tasks entry for an unaccounted purchase.** Exactly the "needs attention" shape, but a purchase
  legitimately part-paid for months would nag the whole time — the same objection recorded against
  nagging an open receivable. Age-gate it if it is ever added.
- **A purchases list page.** Purchases are reached from their payments; a browse surface is worth
  building only once there are enough of them to browse, which is a question about use rather than
  design.

How this differs from the mechanisms it is most often confused with — splits, recurring series and
reimbursements — is in [`mechanism-index.md`](mechanism-index.md).

## Reimbursable expenses

Money that leaves as an expense and comes back later — concert tickets bought for friends, a work
expense paid personally and claimed afterwards. Both movements are already recorded correctly and
categorization is already right; what breaks is that **the netting crosses a period boundary**, so
February overstates spending until July's repayment lands, and July shows an inflow that is not income.

**The model is a holding category, not a restatement.** The reimbursable portion of the expense is
allocated (through `txn_split`) to a leaf under the seeded, excluded **`Reimbursable`** group, and the
later inflow lands against the same group instead of against income. February then reports its own
spending correctly on its own, July reports no income, and **the outstanding balance is simply the
group's sum** — no pairing required to produce it. Nothing is asserted about a repayment that may never
arrive, which is the failure of the obvious alternative (flag the expense and exclude it): if the money
never comes back, spending is under-reported permanently with nothing showing what is outstanding.

**The group is machinery, and its identity is `system_key = 'reimbursable'`, not its name.** Two
properties follow, both load-bearing. The empty-category sweep deletes leaves with no transactions and
groups with no surviving children, skipping only `system_key IS NOT NULL` rows — and a receivable
category is *empty exactly when nothing is outstanding*, which is its healthy state rather than evidence
it is unused. And the user may rename the group freely, because every read resolves it by key. It is
seeded for everyone like the other top-level reporting groups; its **leaves are created on first use**
(`services/excluded_categories.py`), so someone who never records a reimbursable carries one empty group
and no stray category.

**The group carries the state; its leaves carry the thing, and no leaf is seeded.** `Reimbursable ›
Concert tickets` — "owed back" is already said by the parent, so a leaf that says it again is doing the
group's job instead of its own. Only the user knows what a given receivable is *for*, which is why the
app seeds the group and nothing inside it.

The rule generalizes and is worth stating because getting it wrong is self-concealing: **a category
named for a state goes stale, because the state changes and the name does not.** A leaf called
"Awaiting reimbursement" is a lie about every row in it the moment that row is repaid, and the apparent
fix — a second "Completed" leaf that finishing moves rows into — was designed and then rejected here,
because it pays for a bad label by destroying a good one. Moving a finished row out of "Concert tickets"
loses exactly the thing that made it findable. Named for what the money is, a leaf stays true forever
and nothing has to move.

Nothing is lost by leaving completed rows where they are, on any surface: a completed pair is `+n` and
`−n` inside the same excluded group, so it **nets to zero and cannot distort the group's balance**
wherever it sits; the outstanding report lists open reimbursements only; and the ledger's row marker
renders a completed one dimmed and an open one bright.

**The feature keys on the group, never on one blessed leaf.** Any active leaf inside it is a receivable,
so the user may keep the default `Awaiting reimbursement`, rename it, or add their own beside it. This
is what makes "one receivable category or one per counterparty" a non-question, and it is safe because
`exclude_from_totals` is `NOT NULL`, so an existing parent always wins
`COALESCE(parent.exclude_from_totals, leaf.exclude_from_totals, 0)` — a leaf under the group cannot opt
itself back into spending totals whatever it carries. **The group itself cannot be deleted, moved, or
have its `exclude_from_totals` changed** — three flat refusals rather than gates on whether it currently
holds anything:

- **delete** never durably worked anyway: seeding restores the group at next start, leaving deactivated
  leaves holding the balance outside the group the feature reads.
- **move** is the quietest of the three. Reparenting turns the group into a *leaf*, and every lookup
  that finds it requires `parent_id IS NULL` — so the next write creates a second group while the whole
  outstanding balance stays stranded under the moved row, and the report reads zero with nothing having
  visibly gone wrong.
- **exclusion** is the likeliest accident, and clearing it silently restores the exact overstatement the
  feature exists to remove.

Renaming and re-sorting stay open, because the key is the identity and what the group is called is the
user's business.

**A leaf holding claimed money stays in the group.** A reimbursement stores its claims as amounts against
transactions and reads the money behind them from whatever sits in a Reimbursable leaf, so moving that
leaf to another group, or deleting it, takes the money out from under claims that survive — the
outstanding balance vanishes with nothing visibly wrong. Both are refused while any reimbursement claims
money in the leaf, completed ones included, since reopening one works on the same allocations. A delete
whose replacement is another Reimbursable category is allowed, being the one path that keeps the money
inside the group, and a leaf with nothing claimed in it moves and deletes freely.

**The residual is the feature.** A repayment is not reliably equal to the expense — tickets bought for
$400 may be sold on for $350 or $450 — so the receivable rarely closes cleanly, and what is left behind
is the point: repaid short leaves a real cost genuinely incurred, repaid over leaves a genuine gain, and
not repaid at all leaves money still outstanding. A short repayment and an unpaid one are
**indistinguishable by amount**, and only the user knows which happened, which is what makes *settling*
an explicit act rather than something derived.

**Where a residual lands is decided by its sign, and is not a preference.** The residual is a category
balance rather than a row, so moving it means rewriting the allocations of a transaction that already
exists, and there are only two candidates:

- a **positive** residual (repaid short, or never repaid) settles on an **expense** — the shortfall is
  money genuinely spent, and only an outbound row points the right way to absorb it. This **restates the
  original period, deliberately**: $125 is what February actually cost once the repayment is final. The
  restatement is explicit and user-initiated; nothing restates on its own.
- a **negative** residual (repaid over) settles on the **repayment** — the surplus came back when the
  overpayment arrived, so booking it into February would claim a gain in a month where nothing had yet
  gone right.

**Settling is per record, never per position.** "Write off $50 of this category" sounds like the
simpler control and has nothing to act on: a residual is a category balance, so it can only be moved by
rewriting a *named transaction's* allocations, and a position-level action could not choose between the
expense and the repayment without already knowing which expense fell short.

**That asymmetry is why no mixed-sign split is needed, and the rule must not be reached for here.**
Settling everything on the expense is the uniform-looking trap: a surplus larger than the buyer's own
share drives the expense's real-category part negative, which `txn_splits.validate_parts` refuses by
design — and would make relaxing that rule look like a prerequisite for this feature. It is not one.
Sending a surplus to the repayment is legal at *any* magnitude, because every component of an inbound
repayment points the same way.

**Completing is the terminal act, and it is not the same thing as settling a residual.** A
reimbursement that was repaid in full has nothing to move and still has to be finishable, or it sits on
the open list forever — which is exactly what happened while "already square" was an error rather than
the easy case, leaving the outcome the whole feature aims at unreachable. So `complete` means *this is
finished*: it moves a residual where there is one, closes with no change where there is not, and asks
for a destination category only in the first case. **Any residual must be given a category** — a
shortfall, a surplus, or a reimbursement nothing was ever repaid against (the write-off, where the
residual is the whole amount). There is no path that closes a reimbursement leaving money unaccounted
for in the holding group, which is what keeps the group's balance meaning "still owed". `reopen` reverses either, restoring allocations only
where any were moved.

**The outstanding report lists open reimbursements only.** A completed one is absent rather than sorted
to the bottom or filed under a second heading: there is no work left on it, and it stays reachable from
any of its transactions. The headline total is unaffected either way, because a completed
reimbursement's claims sum to zero. Note the consequence that its transactions **stay in the holding
group** — the two sides cancel there, so no report is wrong, and moving them would restate a period for
no reporting gain.

**The link is the fourth client of `txn_link`** (`kind='reimbursement'`, `services/reimbursements.py`),
and it observes the primitive's contract: the link never mutates what it joins. `external_ref` carries
the counterparty, `metadata_json` the per-transaction **claims**, the record's own **reminder date**
where it has one, and — once finished — the **completion
record**, which stashes the target's prior allocations, category and provenance so any move can be
reversed exactly (all null where completing moved nothing). Reversal reads that stash rather than
recomputing an inverse, because the destination category may have been edited since and re-deriving
"what it must have been" would launder those edits into the restore.

**A reimbursement covers a *portion* of a transaction, not the transaction — and this is the correction
that matters most here.** The first implementation made a transaction the unit and enforced "at most one
reimbursement per transaction". That cannot express two ordinary uses of splits, which exist precisely
so one ledger row can mean several things:

- one charge split between two friends is **two debts**, each needing its own counterparty, its own
  repayments and its own settlement;
- one ATM deposit split across buckets can **repay two different debts at once**.

So a link records a **claim** per transaction — how much of that row's receivable belongs to *this*
reimbursement — and a row may appear in as many reimbursements as it has receivable money to divide.
`txn_link_member` is keyed `(link_id, txn_id)`, so several links over one row need no schema change; the
claims live in the link's `metadata_json`. Do not reintroduce the per-row rule: it reads as a tidy
invariant and is the thing that made the feature unable to model its own motivating example.

**Claims are stored as amounts, deliberately, not as split-part ids.** `save_split` deletes and
reinserts a transaction's parts on every edit, so part ids are not stable across an ordinary re-split
and a claim keyed on one would break the first time an amount was adjusted. A part is still how the
*user* picks a portion — the picker offers "Dana's ticket $250" — but what is written down is the amount,
with the part's label kept alongside as display provenance that no arithmetic reads. One consequence:
when settling draws a residual out of a row holding several shares, *which* allocation shrinks is taken
in order, so the labels are not evidence of whose money moved. Nothing reported anywhere depends on it —
the row's receivable, each link's residual and every category total are identical either way.

**The invariant is per portion.** A transaction's claims across all reimbursements may not exceed its
receivable, and what is left over is **unclaimed** — which is what the outstanding report lists as loose
and what the link picker offers. Every claim must be non-zero and point the same way as the row's
receivable. A transaction allocating *nothing* to the group is refused at the join with the next step
named — split the expense so the part owed back lands in the group — because a member contributing
nothing to the residual would sit in the report as a row with no action attached.

**The expected total is deliberately not stored, though the first design said it would be.** It is the
sum of the members' receivable claims, so a stored copy would be a second truth able to drift from the
ledger the moment a split was edited — the same objection that makes roles derived rather than stated.
A **free-text note** beside the record's name is likewise gone (removed 2026-09-02; nothing migrates,
since `metadata_json` is a blob): the name is free text already and appears everywhere the record does,
while the note reached exactly one surface. Surfacing it more widely to justify it is the wrong
direction — that is inventing a use for a field after the fact.

**One claim per transaction per reimbursement**, keyed by transaction id, and this shapes the picker.
Attaching a second portion of a row a reimbursement already covers *replaces* the first rather than adding
to it — which is what makes re-picking a share a correction instead of a silent doubling, and which is
why choosing several portions has to mean **one claim for their sum**. The picker is therefore multi-select
(`ClaimPortionPicker`): a charge divided between two people is routinely owed back in full by one of them,
and there is no other way to express it.

**The outstanding report is organised by direction, not by tracked-ness.** Left is everything owed back
— records and unclaimed expenses together — and right is money in that nothing has claimed; a record
shows its members nested under it, dated by its earliest member so it sorts where the debt started.
Nesting hangs off the record rather than off an expense because a reimbursement may hold several
expenses and one payment may be split across two records, and each nested line states *that record's
claim* rather than the transaction's amount.

**A pairing is offered against both piles, because tracked-or-not is not a property of the money.** When
a repayment asks what it repays, the candidates are the open reimbursements *and* the untracked
receivable rows of the opposite sign; picking an untracked one creates the record holding both sides at
once. Offering only records made the ordinary case unreachable — an expense had to be turned into a
record by hand before anything could be matched to it, which is a step that exists only because of how
the data happens to be stored. Two filters keep the list honest: **opposite sign only**, so it never
proposes a pairing the server would refuse; and **not a record that already claims this row**, since a
reimbursement holds one claim per transaction and a second would replace the first rather than add to it.

**The sign decides what there is to do with a row, not just what role it plays.** Roles are already
derived from it; the surfaces follow the same rule. Money out is an expense — the act is saying it is
coming back, which needs no counterpart to exist yet. Money in repays something — the act is naming
what, chosen from the open reimbursements. Offering "track this" on both is what stranded every expense
in one ledger: a repayment tracked on its own became a record holding only a credit, and since **a claim
belongs to exactly one record**, the expense (already claimed by its own) could never be joined to it.
Recording a repayment alone stays available, because a credit can genuinely clear before its receipt is
entered; it is the quiet option rather than a refused one.

Worth stating plainly because it is what makes the asymmetry legible: **tracking is optional.** The
outstanding total is the open records' residuals plus the unclaimed money in the group, so an untracked
reimbursable expense is already counted, as loose. A record adds exactly two things the category cannot
— a counterparty's name, and the pairing that settling requires.

**A reimbursement with no expense recorded is a credit, not an overpayment.** Its only entries are
repayments, so the arithmetic makes every penny a surplus — reported as one it reads as an error on a
record whose sole entry *is* that money. It is named separately in the summary text (`Unmatched $240.00
credit`) rather than as a distinct status, because for every other purpose it genuinely is a surplus and
completes the same way. The amount named is whatever the surface is describing: a card inside one
transaction's panel names that row's claim, a list describing the whole record names its total.

**Every figure the panel shows is stated against the row's whole receivable.** A claim's amount is
otherwise a number with no visible cause: a $250 deposit with $10 claimed reported "$240.00 not yet
matched" while the reimbursement holding that $10 said nothing about this row at all, so the missing $10
was unaccounted for anywhere on screen. Each reimbursement card therefore names what it claims *of this
transaction* (where the row is shared — on a row it covers whole it would only restate the figure beside
it), the unclaimed line reads "$240.00 of $250.00", and a refused selection names both the sum asked for
and the standing claim rather than only the limit.

A consequence worth stating, because it looks like a bug from the UI: **a claim is an amount, never a set
of parts.** Split parts are rewritten wholesale by `save_split`, so binding a claim to one would not
survive an edit. Once part of a row is claimed, its named portions therefore no longer describe what is
available — a $250 deposit divided $10/$240 with $10 claimed still lists both portions while only $240 is
left. Every subset remains a *legal* claim (the limit is the total, not the identity), but none of them is
"the remainder" by name, so an explicit **everything not yet claimed** option is offered — and only in
that case, since otherwise it would sit beside a share of identical value.

**Roles are derived, never stored as an independent fact.** A member's role follows the sign of its
claim — positive is an `expense`, negative a `repayment` — so there is no second truth able to disagree
with the ledger.

**Pairing stays optional and late.** Reporting works off the category aggregate with nothing linked at
all; a link is required only to settle, because that is the one operation that has to know which inflow
closes which expense. One payment may close several expenses (an employer settling a month of receipts),
so the link is one-to-many throughout and the residual's target is named by the user whenever a role has
more than one candidate — nothing in the ledger can say which expense fell short.

**Settling draws against this link's own claim, never against the whole row.** A charge whose other
portion belongs to a different reimbursement must not have that portion consumed, so the limit is the claim,
and the claim is reduced along with the allocation — which keeps a row's claims and its receivable in
step whichever of its reimbursements is settled first.

**A reminder is a property of the debt, not of the transaction.** The date a receivable starts being
asked about lives on the *record* (in the link's `metadata_json`, beside its claims), because one charge
split between two friends is two debts that may be owed back on two different dates. A `remind_on` on
`txn` could hold only one of them, which is the same "at most one reimbursement per transaction" mistake
in another costume.

It follows that **loose receivable money answers only to a household default**: an unclaimed portion has
no record to carry a date, and the way to give one a date of its own is to track it — which is the thing
worth doing with a receivable one intends to defer anyway. Storing per-row dates outside the ledger (in
the per-user preference store, say) was rejected: it would put a ledger fact in a per-user surface that
does not share the ledger's lifecycle.

**The clock runs from the transaction's date, never from the record's creation.** A reimbursement
entered today for a February charge is already months old. Dating it from the record would mean that
tidying up — the one act the feature wants to encourage — postpones the reminder every time, and a
repayment arriving would restart it, so partial progress would push the reminder further away than no
progress at all. For the same reason a record's clock starts at its **oldest expense**, not its oldest
member of any kind.

**A record's reminder has three states, not two.** Absent means *follow the household default*; empty
means the user switched this record off; a date means they chose it. "Off" and "unset" have to stay
distinguishable, or turning a reminder off would silently revert the next time the default was
consulted. The default itself is **ledger-level**, kept in a reserved shared scope of `ui_preference`
rather than in `db_meta`: it is user-chosen configuration, and `db_meta` is deliberately outside the
backup payload, so a value stored there would quietly revert to 30 days on restore. Zero disables the
default and is not a dead end — a record can still carry a date of its own.

**Only money still owed is ever due.** A surplus is a gain waiting to be booked rather than something to
chase, an unmatched credit is not under-reported spending, and a completed record has no work left. The
signal exists because an unsettled receivable *is* under-reported spending — the disease the
flag-and-exclude model was rejected for — so it must not fire on any state where that is not true.

**The signal is grouped by owner, read from `txn.owner_id`.** That column is stamped from the account
when a row is created and is the axis every owner filter in the app already uses, so a task can
deep-link to precisely the rows it counted; joining through to `account.owner_id` instead would fork a
second owner axis that disagrees with the ledger the moment one row's owner is corrected. A record is
attributed to the owners of its **expense** side — the question a reminder asks is who is owed, so a
repayment landing on someone else's account does not make the debt theirs — and one whose expenses span
two people appears under both. Grouping applies only where the household has **more than one personal
owner**, since a built-in `Shared` owner exists as soon as the Owners page is opened.

**Claims are exclusive, so moving one is its own operation.** What one record holds, another cannot,
which is why the ordinary picker offers unclaimed money only — and which left a row whose receivable was
entirely spoken for reachable from nowhere but the record already holding it. The move releases and
re-attaches in one transaction, in that order: the invariant counts claims across every record, so an
add before the release would be refused as an over-claim of a row that is merely mid-move.

The mechanisms this one is adjacent to but is *not* — splits, multi-payment purchases, `txn_link`,
`exclude_from_totals` — are told apart in [`mechanism-index.md`](mechanism-index.md).

## Open

Decisions still owed on this document's subjects, each naming the live backlog item that will settle it.
Rejections and obstacles are **not** here — they sit inline beside the thing they are about, which is
this doc's convention and the more findable one. See `AGENTS.md` → *Where rejections, obstacles and owed
decisions go*.

- **Number and date display formatting**, and the free-text parse bucket behind it. The ledger-currency
  half shipped; what remains is cosmetic except for the ledger search's date/amount ambiguity, which is the
  only correctness risk in it. → [`backlog/i18n-display-formatting.md`](backlog/i18n-display-formatting.md)
- **Account type as a filtering and search axis.** It exists as a rule scope; generalizing it to
  structured filters — and to an `accttype:` / `acctname:` free-text grammar, the harder half — has not
  been done. → [`backlog/account-type-as-rule-criterion.md`](backlog/account-type-as-rule-criterion.md)
- **The wider backups artifact**: a sectioned file, whether `backup_recipient` rides along, and an
  incremental chain. The credentials half is settled.
  → [`backlog/backup-restore-scope-and-secrets.md`](backlog/backup-restore-scope-and-secrets.md)
- **`cash_date` — a second date for cash-basis timing.** Deferred with its attribution method worked
  out; what decides whether it is worth building is the drill-through question, since an attributed node
  lists purchases dated outside the displayed period.
  → [`backlog/dashboard-reporting.md`](backlog/dashboard-reporting.md)
- **Attachment tiers 2 and 3** — OCR, and itemized lines from a document. Tier 2 is also the named
  precondition for automatic multi-payment suggestion.
  → [`backlog/transaction-attachments.md`](backlog/transaction-attachments.md)
- **A data source's account map is invisible and uneditable.** It *is* persisted — `autoSaveProfile`
  writes `account_assignments` / `account_skips` / `account_new` into the source's `column_map` after
  every import, and the next import restores them — but only as a side effect of importing, so it can be
  inspected and corrected nowhere. A watched folder now depends on it (see *Watched import folders*),
  which makes a mapping nobody can see the thing standing between a parked file and a fixed one. The one
  thing that keeps it from silting up is that removing an account rewrites it — following the account the
  transactions went to, or dropping the entry outright, never leaving a blank behind (*Removing an
  account*). No backlog item — this section owns it.
- **Marketplace enrichment remainder**: AZAD ingestion ergonomics, enrich re-derive from stored raw
  values, and the column-centric mapping rework.
  → [`backlog/paypal-amazon-enrichment.md`](backlog/paypal-amazon-enrichment.md)
- **Import-source field registry remainder**: user-selectable report columns drawn from the registry,
  and structured `(field, op, value)` rule matchers in place of the shipped "anywhere in the source
  text" form. Both inherit the no-new-capture constraint and the categorizer's perf contract.
  → [`backlog/import-source-field-registry.md`](backlog/import-source-field-registry.md)
- **Folding money-movement recognition into the generic rule-suggestion engine**, so a captured
  categorical field clusters candidates the way a merchant name already does. The account-type scoping
  this once waited on shipped with migration v13.
  → [`backlog/paypal-money-movement-recognition.md`](backlog/paypal-money-movement-recognition.md)
- **The recurring pool-load optimization.** The payee filter is applied after a full pool load, so a
  scoped scan costs what a full one does — now on the path of every category edit. Revisit threshold is
  roughly 50,000 rows. → [`backlog/recurring-detection.md`](backlog/recurring-detection.md)
- **Dedupe follow-ups**, including the prefix-stripping item whose precondition is now met — the open
  question there is the 4-character prefix floor.
  → [`backlog/import-dedupe-followups.md`](backlog/import-dedupe-followups.md)
- **An online merchant categorizer**, terminating in the existing rule store ("the rule is the cache").
  Parked design. → [`backlog/online-categorizer.md`](backlog/online-categorizer.md)
- **`clean_name` / merchant-rename: keep or drop.** Dormant code awaiting a decision rather than a
  design. → [`backlog/merchant-rename-fate.md`](backlog/merchant-rename-fate.md)
- **The invariants a semantic checker would assert.** A structural database check answers "is the file
  corrupt" and never "is the data coherent"; which invariants are worth asserting, and whether any can be
  repaired rather than only reported, is unstarted design.
  → [`backlog/database-diagnostics.md`](backlog/database-diagnostics.md)
