# Reimbursable expenses

**Status: backlog, not started (2026-08-21).** Money that leaves as an expense and comes back later —
concert tickets bought for friends, a work expense paid personally and claimed afterwards. The ledger
already records both movements correctly. What it cannot say is that February's $500 was really $100 of
spending, because the $400 that offsets it does not arrive until July.

## The problem is timing, not categorization

The categorization is already right, and deliberately so: expense categories accept inflows, and
signed-net reporting means a bucket that was refunded reads negative rather than being flattened by an
absolute value. Over a long enough window a reimbursable nets out on its own.

What breaks is that the netting crosses period boundaries. The cash-flow view is accurate as it stands —
money left in February and returned in July, which is what actually happened. The *spending* view is not:
February overstates by the reimbursable portion and July shows an inflow that is not income.

This is a neighbour of the deferred `cash_date` idea in
[`dashboard-reporting.md`](dashboard-reporting.md) — both are cash-basis versus accrual-basis questions —
but not the same case. `cash_date` moves *one* transaction's reporting date. Here a *second* transaction
offsets an earlier one, and the two may not be equal.

## The model: a receivable category, not a restatement

The reimbursable portion is split into a holding category — money owed back — that carries the
`exclude_from_totals` treatment already used for transfers and credit-card payments. The later inflow
lands against that same category rather than against income.

- **February:** $100 entertainment + $400 receivable.
- **July:** the repayment reduces the receivable. Nothing about February changes.

Three properties, each of which is why this shape is preferred over the alternatives:

- **Nothing is restated.** A period already looked at does not silently change months later, and the
  ledger still agrees with the bank statement.
- **Nothing is asserted about the future.** A flag-and-exclude approach declares at purchase time that a
  reimbursement *will* arrive; if it never does, spending is under-reported permanently with nothing
  showing what is outstanding.
- **"Has Dave paid me back yet?" is free.** The outstanding total is the sum of the category. No pairing
  is needed to answer it.

It also stays inside the scope the README draws: this is transactions in categories, not balances. No
asset register, no net worth.

## The residual is the feature

A reimbursement is **not** reliably equal to the expense. Tickets bought for $400 may be sold on for
$350, or for $450. So the receivable does not close cleanly, and what is left behind is the point:

| case | receivable residual | what it means |
| --- | --- | --- |
| Repaid in full | zero | done |
| Repaid short | positive | a real cost that was genuinely incurred |
| Repaid over | negative | a genuine gain |
| Not yet repaid | positive | still outstanding |

**A short repayment and an unpaid one look identical by amount.** Nothing can distinguish them
automatically — only the user knows which is which. That is what requires a **settle** action: closing a
receivable moves its residual to a real category (normally the one the original expense belonged to),
and that is the moment the books become true. Until then the residual sits honestly as "unresolved".

The over-repaid case needs no special machinery, because signed-net reporting already handles it: the
original category reads negative for that period, which is the honest answer and an already-supported
presentation. Do **not** reach for an income category to absorb a surplus — that would misfile a
recovered cost as earnings.

## Pairing: optional, and late

Pairing is not required for the numbers to be right, and should not gate the feature:

- **Reporting** works off the category aggregate. Correct period spending and a correct outstanding
  total, with nothing linked.
- **Settling** needs to know which inflow closes which expense, once more than one receivable is open.
  That is the only place identity is needed.

When it is needed, the primitive exists. [`data-model.md`](../data-model.md) states `txn_link` is a
**general association primitive, not an Amazon feature**, and already names further clients as intended.
A `kind='reimbursement'` link with roles `expense` / `repayment`, an `external_ref` carrying a
user-supplied label ("Dave — concert tickets"), and the expected amount in `metadata_json` fits without
a new table.

Follow the primitive's rule: **a link never mutates the transactions it joins.** The feature performs
the recategorization at settle time and records what it did in `metadata_json` so it can be reversed —
the same contract Amazon order itemization and wallet funding-leg suppression already observe.

The resulting surface is the Amazon reconciliation shape again: an expected total, inflows reconciling
against it, and an acknowledge/settle action for what will never match. That report is the reference
implementation for the screen, not a new pattern to invent.

## Depends on splits

"All or part of an expense" is exactly what [`transaction-splits.md`](transaction-splits.md) provides —
one ledger row, N category/amount parts. A wholly reimbursable expense could be done by
recategorization alone, but the motivating case is partial (one ticket mine, three for friends), so this
sits downstream of splits and should not be started before them.

It also strengthens the case for splits, which currently reads as useful-but-invasive: this is a second
independent consumer of the same allocation table.

## Open questions

- **Where does the receivable category live?** A seeded group beside `Transfers`, or a user-created
  category the feature merely recognizes? A seeded one makes reporting predictable; a user-created one
  avoids inventing structure for people who never use this.
- **One receivable category or one per counterparty?** Per-counterparty answers "who owes me" by
  category alone and needs no linking at all, but multiplies categories and misuses them as a directory
  of people. Probably one category, with the counterparty on the link's `external_ref`.
- **Does an unsettled receivable belong in Tasks?** It is exactly the "needs attention" shape, but a
  reimbursement legitimately outstanding for months would nag the whole time. Perhaps only past a
  user-set age.
- **Is the settle action per-expense or per-position?** Per-expense needs the link; per-position ("write
  off $50 of this category") does not, but cannot say *which* expense was short.
- **Work expenses may reimburse several purchases at once** — one payment from an employer covering a
  month of receipts. That is a one-to-many link, which `txn_link` supports, but the settle UI has to
  cope with it rather than assuming pairs.

## Cross-refs

- [`transaction-splits.md`](transaction-splits.md) — the allocation mechanism this depends on
- [`dashboard-reporting.md`](dashboard-reporting.md) — `cash_date`, the adjacent timing question
- [`../data-model.md`](../data-model.md) — `txn_link` as a general primitive; signed-net reporting;
  `exclude_from_totals`
