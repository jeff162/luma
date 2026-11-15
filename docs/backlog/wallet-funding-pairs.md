# Pairing Venmo and other wallets with the bank and card side

## What it is

PayPal rows are already paired with the bank or card row on the other side of the same movement, so the
money counts once. A Venmo-style account works the same way: it draws on a bank or card to pay for
things and cashes out to a bank. Today it gets none of that pairing. The bank deposit from a Venmo
cash-out stays wherever it was filed, so money received on Venmo and then cashed out is counted twice.
This project makes every **wallet account** (types `paypal` and `p2p`) pair the way PayPal does.

It also fixes a blind spot that PayPal already has. A bank or card row filed under a **Reimbursable**
leaf counts as "already excluded" and is left alone. A receivable repaid on the wallet and then cashed
out then reads as over-repaid.

**Where it stands:** design agreed in outline, not started. Three decisions under *Decisions owed*, each
with a recommendation.

## The model

- **A wallet is a property of the account type**, not a per-account switch. `paypal` and `p2p` are
  wallets, and the type list marks them `kind: 'wallet'` beside `amazon`'s `kind: 'marketplace'`
  (`frontend/src/lib/accountTypes.js`). The backend keys the pass on the same set of types. Credit,
  loan, `other` and the deposit types are not wallets: a card purchase is real spending with no
  same-time mirror elsewhere, and its later payment is an ordinary transfer that the Transfer
  categories and transfer pairing already handle.
- **Each wallet account carries its match text.** A candidate is a row on a non-wallet account that
  reads as *this* wallet. Today that test is the literal `LIKE '%paypal%'` in
  `services/paypal_funding.py` (`_Ledger.__init__`). A `p2p` type does not name its service, so the text
  is stored on the account (decision 2). It is read from the effective (group root) account, the same
  way type is.
- **The pairing logic carries over unchanged.** `_Ledger.targets` already handles a row with no
  captured `Type`, which is what a synced wallet produces:
  - a money-out row is offered both a same-sign charge (a payment the card or bank paid) and an
    opposite-sign deposit (a cash-out);
  - a money-in row has no counterpart unless a funding leg or a `Type` says it came from outside.

  A payment received on the wallet is therefore never paired, and its cash-out is.
- **A counterpart must be on a non-wallet account.** This keeps the rule PayPal has now ("not a PayPal
  account"), widened to "not a wallet". Wallet-to-wallet funding is out of scope.

## "Already excluded" means money movement

`_attach` skips a row whose category, or that category's parent, has `exclude_from_totals`. The intent
is to respect a row the user has already classed as movement. A Reimbursable leaf is excluded for a
different reason: it holds a receivable whose balance is meant to be read
(`data-model.md` → *Reimbursable expenses*).

- **Transfer pair:** both rows move to *Money movement* unless the row is already in a money-movement
  category, meaning the Transfers group (`find_transfers_group_id`) or a category under it. A
  Reimbursable row is moved.
- **Payment pair:** the card row is excluded unless the wallet row is in a money-movement category,
  which is the "user counts the bank side" case. A wallet row in a Reimbursable leaf no longer stops the
  card row from being excluded. Today it does, and that counts the purchase as both spending and a
  receivable.
- **The old test was also guarding reimbursement claims.** Because it skipped every excluded row, it
  never moved a row a reimbursement record claims. Without that skip, the pass would take money out from
  under a standing claim, which `receivable_change_refusal` forbids for every other write. The
  replacement guard is decision 3.

## Decisions owed

1. **Naming.** Rename the module and its identifiers to wallet-generic ones, and migrate the stored link
   kinds (`paypal_funding`, `paypal_funding_declined`, `paypal_funding_reviewed`) to `wallet_pair`,
   `wallet_pair_declined` and `wallet_pair_reviewed`. Register the migration's data step in
   `POST_RESTORE_DATA_INIT` so restored backups come across. `wallet_funding` is already taken by the leg
   suppression in `services/money_movement.py`, which is why the new names are not `wallet_funding_*`.
   The reconciliation card title names the wallet account ("Venmo reconciliation") instead of the fixed
   "PayPal reconciliation" (`frontend/src/lib/reconciliationReports.js`), and the report's help strings
   (`paypalReconciliation.jsx`) say "wallet" where they now say "PayPal".
   *Recommendation: rename.* A stored kind called `paypal_funding` holding Venmo pairs would mislead
   every later reader of the data and the code, and the migration is one `UPDATE` per kind.
2. **Where the match text lives.** Recommendation: a nullable `account.wallet_match_text` column, used
   only on wallet types.
   - The migration backfills `PayPal` on existing `paypal` accounts.
   - A PayPal import that creates an account sets it.
   - When an account becomes a wallet type, it is prefilled from `institution`, or from `name` if that is
     empty.
   - The account editor shows it only for wallet types.
   - A wallet with no match text has no candidates. Its money-out rows that state a crossing then appear
     in the report as unmatched, which is where the user finds them.

   The alternative is deriving the text from the name at read time. That fails silently on a renamed
   account.
3. **A row a reimbursement record claims.** Recommendation: treat it as not pairable, the same as a split
   row, so the pass never changes it and never offers it. The claim is a deliberate statement about that
   row. The user can detach the claim and let the pass pair it, which matches how
   `receivable_change_refusal` handles every other write.

## Touch points

- `services/paypal_funding.py`: the candidate query, the wallet-account clause, `_attach`'s skip,
  and the claimed-row exclusion in `pairable_other`. `funding_pairs` (read by duplicate detection),
  `account_settings_followups.settle_account_change` and the sync and import hooks keep calling the same
  entry points.
- `services/money_movement.ensure_paypal_account_type` still retypes `p2p` to `paypal` when PayPal
  money-movement types are approved. That source is PayPal, so the retype stays correct.
- Docs: `data-model.md` → *PayPal funding pairs* becomes *Wallet funding pairs*, the *Type* section names
  the wallet kind, the `mechanism-index.md` row is updated, and `docs/README.md` is regenerated. In-app
  help changes with the surface.
- Tests: build the fixture from the reported case. A synced wallet with no `Type` holds a payment
  received and a "Standard transfer" out. The bank holds the cash-out filed under a Reimbursable leaf,
  unclaimed. Also cover:
  - the same cash-out claimed by a reimbursement (left alone);
  - a payment pair whose wallet row is in a Reimbursable leaf (card row excluded);
  - a `p2p` account with no match text (no candidates);
  - the link-kind migration on a restored backup.

## Obstacles

- **A top-up from a bank into a synced wallet is not paired.** A money-in wallet row with no `Type` and
  no funding leg has no target, by design: a payment received looks the same. The bank side is listed as
  unaccounted ("no wallet record") and still counts as filed. Filing it under Transfer lets transfer
  pairing take it.
- **Duplicate rows inside a merged wallet group make pairs contested.** Two copies of one wallet row both
  want the same bank row, so neither pairs automatically and both go to the user. Dedupe inside the group
  is the fix. This pass does not work around it.
