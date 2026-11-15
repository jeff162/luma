# Accounts in more than one currency

## What it is

Luma holds one currency for the whole ledger, so someone with a euro account and a dollar account cannot
track both. This project gives each account its own currency. The app shows one currency at a time,
picked from a selector, and nothing is ever converted: euro accounts are totalled with euro accounts,
dollar with dollar. A ledger with one currency looks exactly as it does today.

**Where it stands:** proposal, not started. The design is agreed in outline; five decisions under
*Decisions owed* are settled before building starts.

## Goal

Hold accounts in more than one currency in one ledger without converting anything. Each account has one
currency. Accounts **interact only with accounts of the same currency**: no total, match or rule
crosses a currency boundary. The app shows one currency at a time through a selector. The few surfaces
that are about the whole install, not one currency's money, stay app-wide.

This is neither of the two options `services/ledger_currency.py` describes. It is not the single
ledger currency that ships today. It is also not *multi-currency* in that module's sense, meaning a
per-row denomination, a rate source, and totals that span currencies. Each currency is its own set of
accounts that never mix, so there is still nothing to convert and no rate to source. Within one
currency, every existing invariant holds as written.

## The model

| Belongs to | What |
| --- | --- |
| **One currency** | accounts, rules, recurring series, saved dashboard tag reports |
| **App-wide** | categories, tags, owners, Tasks, data sources and connections, import history |

- **`account.currency`** (ISO-4217, `NOT NULL`). Existing accounts are backfilled from the current
  `ledger_currency`. A transaction's currency is its account's; `txn` gets no column of its own. A
  merged child takes its group root's currency, so a merge across currencies is refused.
- **`category_rule.currency`** (`NOT NULL`), backfilled the same way. A rule matches only rows whose
  account is in its currency. A rule scoped to an `account_id` must agree with that account's currency.
  Currency is part of the rule's matcher identity, so the same keyword rule can exist once per
  currency. Rules are per-currency because they follow account data (account and account-type scopes,
  amount ranges), and an amount range means different things in different currencies.
- **The selected currency is a per-user view choice** (`ui_preference`). It is not shared state, since
  two people may legitimately be looking at different currencies. The selector appears only when the
  ledger holds accounts in more than one currency. A one-currency ledger looks exactly as it does today.
- **The ledger-wide setting becomes the default for new accounts.** `ledger_currency` keeps its storage
  and its Settings section. It no longer decides what may be imported; the target account's currency
  does.

## Scope per surface

| Surface | Scope |
| --- | --- |
| Dashboard, Transactions, Recurring, Rules, rule suggestions, Reimbursements, Accounts | selected currency |
| Categories, tags | app-wide (no amounts on them) |
| Tasks, and the nav badge count | app-wide; see *Tasks* |
| Data sources, connection mapping, import history cards | app-wide (setup and counts) |
| Import batch detail and sync card detail (row lists) | see *Decisions owed* |

## Changes by layer

### Filtering: one enforced choke point

Every scoped read adds the currency clause in the shared filter layer (`append_facets` /
`TransactionFacets` in `services/transaction_facets.py`). The clause is **required**: a scoped
endpoint that does not pass the current currency fails, so a total cannot quietly omit it. This covers
the dashboard summaries (`/summary/by-category`, `by-tag-signature`, `by-group`,
`by-category-in-group`, `monthly-trend`, `range-trend`), the transaction list and its totals,
Recurring, and Reimbursements. Every other `SUM(` over `txn.amount` in the backend is audited against
this list before the work counts as done. A missed one shows up as wrong numbers, not as an error.

### Matching features: same currency only

Every mechanism that looks for a counterpart row or compares amounts across accounts restricts its
candidates to accounts of the same currency:

- transfer pairing (`transfer_pairs.py`: same absolute amount on different accounts)
- duplicate detection and soft-flagging (`duplicate_detection.py`, `connection_dedupe.py`)
- refund links, purchase links, Amazon and wallet funding (`refund_links.py`, `purchase_links.py`,
  `amazon_funding.py`, `wallet_pairs.py`)
- reimbursements (`reimbursements.py`)
- recurring detection (`recurring_detection.py`): a series lives in one currency
- the rule checks: conflicts, overlaps, range drift, suggestions

Build the restriction **once**, as a shared candidate-scope helper these call, not as a predicate
pasted into each one. A transfer between currencies never pairs: each side stays an ordinary row,
counted in its own currency.

### Ingestion

The check changes from "matches the ledger" to "matches the target account". `run_sync` passes each
target account's currency, not the single `ledger_currency`.

- **SimpleFIN** states currency per account (`connection_account.provider_currency`). Mapping to a
  *new* account creates it in that currency. Mapping to an existing account in another currency is
  refused in the mapping dialog, which offers only same-currency targets when the provider stated one.
  `_build_account_targets` excludes on mismatch with the target, not with the ledger.
- **Plaid** states currency per transaction. Rows not in the target account's currency are dropped and
  reported as today (`unsupported_currency`).
- **CSV** (`column_map.currency`) and the **PayPal statement** refuse a row naming a currency other than
  the target account's. A blank cell, or an unmapped column, is the account's currency. A PayPal account
  holding several balances keeps one currency here; its other balances are refused, as they are now.

### Tasks

Tasks stays app-wide so alerts are seen without switching currency. Tasks are counts and links, and
`Tasks.jsx` renders no amounts, so no money total can mix there. What changes:

- **A task with items in more than one currency splits into one task per currency**, titled with the
  currency (e.g. "Uncategorized transactions · EUR"). In a one-currency ledger, tasks are unchanged.
- **A task's link carries its currency** and switches the selector when followed. Otherwise it opens
  on whichever currency was last selected and shows nothing.
- **Dismissal is per currency**: the currency becomes part of the dismiss key.

### Display

Scoped pages need no display change. `MONEY_DISPLAY_CONFIG` in `lib/moneyDisplay.js` is applied from the
*selected* currency instead of the ledger setting, and every formatter reads it already. Changing the
selection re-applies it and re-renders the scoped pages. Today a currency change reloads the page; that
is no longer acceptable once switching is routine. Only a surface that shows amounts from more than one
currency at once needs an explicit per-amount currency. See *Decisions owed*.

### Persistence and docs

- **Schema:** migrations add `account.currency` and `category_rule.currency`, with backfill. They are
  registered last, per the migration conventions.
- **Backup and restore:** the payload carries both columns, and a backup without them restores with the
  backfill value. The CSV transaction export gains a currency column.
- **Docs rewritten:** `data-model.md` → *One ledger currency* (becomes "one currency per account;
  accounts interact only within their currency"), the matching paragraph in `architecture.md`,
  `building-a-connector.md` → *Currency* (an adapter checks against the target account, and
  `ledger_currency` is no longer its argument), `mechanism-index.md` for the same-currency condition on
  every pairing mechanism, and the docstring of `services/ledger_currency.py`. In-app help for Settings →
  Currency, Accounts, Rules and Tasks follows the change.

## Decisions owed

Each has a recommendation; settle them before the go.

1. **Changing an account's currency.** *Recommended:* allowed after a confirmation that states what it
   undoes. The usual reason is a wrong label, and the migration can create one: it backfills every
   account with the ledger currency, and a CSV imported without a currency column was taken at face
   value. Refusing would force a delete and re-import to fix a label. The change moves the account's
   rows into the new currency and undoes only what would then cross a currency boundary:
   - transfer pairs, refund links, reimbursements and funding links to rows in the old currency
   - duplicate flags against rows in the old currency
   - the rows' membership in old-currency recurring series; the account is rescanned afterwards

   Categories stay, since they are app-wide. A rule-assigned category stays, and later rule runs use the
   new currency's rules. The change is refused while the account is in a merged group (detach first),
   and refused when the data source states a different currency for the account
   (`connection_account.provider_currency`), since every later sync would drop its rows.
2. **Import batch and sync card detail.** A sync card can cover accounts in several currencies.
   *Recommended:* the detail view filters to the selected currency and says how many rows are in other
   currencies. This avoids a per-row currency renderer for one surface.
3. **Accounts page.** *Recommended:* scoped to the selected currency like the other pages, with the
   account's currency shown and set there. A new currency is introduced by creating or mapping an
   account in it.
4. **Saved dashboard tag reports** (`ui.dashboard.tagReports`). *Recommended:* each report belongs
   to the currency it was saved in, and the picker shows only those. A report is a set of tags, so a
   "copy to another currency" is cheap if it is ever wanted. It is not built up front.
5. **Rules page with an account-type scope** (`account_type = 'paypal'`). A type spans currencies, so a
   type-scoped rule still belongs to one currency. *Recommended:* nothing special, since the rule's
   currency already limits which accounts of that type it matches.

## Obstacles

- **The risk is a sum that forgets the currency.** It produces plausible wrong numbers, not an error.
  That is why the clause is enforced in the shared filter layer and why tests seed **two currencies**
  and assert that no total, match or rule crosses between them. A one-currency fixture cannot catch
  this.
- **The money symbol is a module-level mutable** read as a default argument. A currency switch only
  shows once the scoped pages re-render, so the selector has to drive that re-render explicitly.
- **Rule identity and uniqueness checks** (conflict and overlap detection, the generate-rules flow,
  managed PayPal money-movement rules) currently assume one rule per matcher. Each gains currency in its
  key, or two currencies' identical rules collide.

## Staging

1. Schema, backfill and backup. With one currency nothing visibly changes.
2. Ingestion checks against the target account, and the mapping dialog's same-currency targets.
3. The enforced currency clause, the selector, and the display re-apply. A second currency becomes
   usable here.
4. The same-currency candidate-scope helper across every matching feature, and per-currency rules.
5. Tasks splitting, linking and dismissal; then help and the doc rewrites.

Stages 3 and 4 ship together if a second currency is to be imported before stage 4 lands. Until then,
matching can pair rows across currencies.
