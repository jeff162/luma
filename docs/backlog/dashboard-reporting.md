# Dashboard / reporting — the deferred remainder

**Status: the cash-flow work shipped 2026-08-25 and was disposed 2026-09-02.** One item remains, and
it has not started.

Where the shipped half went:

- **Chart behaviour** — outlier clamping against a percentile rather than the next-largest bar, the
  pinned value axis and the average pill's tick collision, `stackOffset="sign"` and the negation it
  depends on, explicit sizing instead of `<ResponsiveContainer>`, scroll anchoring and re-centring, the
  named-slice floor, the Sankey's node labels and balancing terminal — is in
  the comments beside the chart code (`pages/Dashboard.jsx`, `lib/trendPlotLayout.js`,
  `lib/chartOutliers.js`, `components/CashFlowSankey.jsx`).
- **Reporting semantics** — `exclude_from_totals` as the entire exclusion mechanism and the three
  richer schemes rejected in its favour, sides decided by net direction, the netted-per-category atom,
  the calendar-month rolling window, and why a tag report has no cash-flow reading — is in
  [`../data-model.md`](../data-model.md) → *Reporting assumptions* → *Cash flow*.
- **The endpoints** — `/summary/monthly-cash-flow`, the `cash_flow` list view, and why the count is
  deliberately absent — are in [`../architecture.md`](../architecture.md).

---

## Deferred: a second date for cash-basis timing

Everything above recognizes spending on the **transaction date**, which is what the ledger already
carries. A later, separable phase adds a second date recording when money actually left an account
that holds it, letting the same views be re-run on cash-basis timing by pointing at a different
column.

- **Sparse and derived.** For most rows the two dates are identical — the difference only arises for
  card-funded spending — so the column falls back to the transaction date and phase-one numbers are
  unchanged for everything not on a card.
- **Attribution comes from the card's own data.** A card export reports both purchases and payments,
  so the purchases between one payment and the next are what that payment covered.
- **Each attribution proves itself.** Summing the intervening transactions and comparing against the
  payment amount either ties out or does not. Attribute where it ties out and flag where it does not —
  a month with a carried balance then identifies itself rather than silently producing wrong numbers.
  This turns "only works if the card is paid in full" from an assumption into a per-payment condition.
- **The statement boundary can be recovered from the data.** Purchases falling between statement close
  and payment date belong to the *next* payment, so a naive "everything since the last payment" window
  overshoots even for an account paid in full. Scanning forward for the cut-off date at which the
  running total equals the payment finds that boundary without a close date the ledger does not have.
- **The earliest payment in the data cannot tie out** — its purchases predate the import window. Expected,
  not a bug.
- **Open UX question.** Drilling into an attributed node shows purchases dated *outside* the displayed
  period ("the purchases this period's payments covered"), which breaks the invariant that a drill-through
  stays inside the period. Whether that is acceptable is what decides whether this phase is worth building.
- **It changes what the three frames *are*, which is a documentation problem as much as a code one.**
  Today spending, income and cash flow are three readings of one population over one set of dates, and
  both `data-model.md` → *Reporting assumptions* → *Cash flow* and the README's feature list describe them
  that way. On a second date column they stop being that: a March purchase paid in April lands in March's
  spending and April's cash flow, so the frames no longer reconcile against each other and cash flow
  answers *when money moved* rather than presenting the same rows a different way. Any wording that
  describes cash flow as sitting alongside the other two goes stale the moment this ships — the honest
  version is that the user picks which question is being asked. Worth knowing before the phase starts,
  because it argues for surfacing the basis in the UI rather than treating it as a column swap behind
  three unchanged view names.
- **Reimbursable money is out of cash flow entirely, and this phase is where that gets decided (parked
  2026-09-18).** The `Reimbursable` group is excluded from totals, so the portion fronted for someone
  else appears in neither the month it left nor the month it came back — correct for spending, but not
  the actual movement of money. A second date alone does not change that: the rows drop out by
  *category*, not by date. The two excluded groups are excluded for different reasons — a transfer never
  left the household, while fronted money did leave and became a claim — so a cash-basis frame has to
  separate them, which it can do by the group's `system_key` without adding the second exclusion flag
  `data-model.md` → *Cash flow* rules out.
- **Name.** `cash_date`, from the accounting sense of *cash basis* versus *accrual basis*. Recorded with
  its reasoning because the term is jargon that only pays off for a reader who already has that frame —
  `settled_date` or `cleared_date` would carry the same meaning in plainer banking language, and the
  choice is cheap to revisit while nothing depends on it. `debit_date` was rejected: the field applies to
  inflows as much as outflows, so it would contradict itself on a credit row, and `debit` already names a
  *direction* here (`category_rule.debit_credit`, the list endpoint's `direction`).
