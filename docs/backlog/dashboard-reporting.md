# Cash-basis timing: a second date (`cash_date`)

Not started. Reporting recognizes spending on the **transaction date**. This adds a second date recording
when money actually left an account that holds it, so the same views can be re-run on cash-basis timing
by pointing at a different column. The current reporting semantics are in
[`../data-model.md`](../data-model.md) → *Reporting assumptions* → *Cash flow*.

## What decides whether to build it

Drilling into an attributed node shows purchases dated *outside* the displayed period ("the purchases
this period's payments covered"), which breaks the rule that a drill-through stays inside the period.
Whether that is acceptable decides whether this is worth building.

## Shape

- **Sparse and derived.** For most rows the two dates are identical; they differ only for card-funded
  spending. The column falls back to the transaction date, so numbers are unchanged for everything not
  on a card.
- **Attribution comes from the card's own data.** A card export reports both purchases and payments, so
  the purchases between one payment and the next are what that payment covered.
- **Each attribution proves itself.** Sum the intervening purchases and compare against the payment.
  Attribute where it ties out and flag where it does not, so a month with a carried balance identifies
  itself rather than producing wrong numbers. "Only works if the card is paid in full" becomes a
  per-payment condition instead of an assumption.
- **The statement boundary can be recovered from the data.** Purchases between statement close and the
  payment date belong to the *next* payment, so "everything since the last payment" overshoots even for
  a card paid in full. Scanning forward for the cut-off where the running total equals the payment finds
  the boundary without a close date the ledger does not have.
- **The earliest payment in the data cannot tie out**, since its purchases predate the import window.
  Expected, not a bug.

## It changes what the three frames are

Today spending, income and cash flow are three readings of one population over one set of dates, and
both `data-model.md` → *Cash flow* and the README's feature list describe them that way. With a second
date, a March purchase paid in April lands in March's spending and April's cash flow, so the frames no
longer reconcile against each other. Cash flow then answers *when money moved*. That argues for showing
the basis in the UI rather than a column swap behind three unchanged view names, and the docs and README
wording change with it.

## Reimbursable money

The `Reimbursable` group is excluded from totals, so money fronted for someone else appears in neither
the month it left nor the month it came back. That is right for spending but not for the movement of
money. A second date alone does not change it, because the rows drop out by *category*, not by date. The
two excluded groups are excluded for different reasons (a transfer never left the household; fronted
money did leave and became a claim), so a cash-basis frame has to separate them. It can do that by the
group's `system_key`, without the second exclusion flag `data-model.md` → *Cash flow* rules out.

## Name

`cash_date`, from *cash basis* versus *accrual basis*. That is jargon; `settled_date` or `cleared_date`
say the same thing in plainer banking language and the choice is cheap to revisit until something
depends on it. Not `debit_date`: the field applies to inflows too, and `debit` already names a direction
here (`category_rule.debit_credit`, the list endpoint's `direction`).
