# Dashboard / reporting — follow-ups

**Status: designed, not started (design settled 2026-08-20; migrated from `TODO.md` 2026-07-30).**
Two unrelated dashboard items: a cash-flow visualization, and a latent double-count audit that the
Trends tab needs before it gains a tag-report selector.

## Cash flow as a dashboard view

**What it is.** Cash flow is a third frame alongside spending and income, not a third series inside
them. Its single-period form is a **Sankey diagram** — inflows on one side, outflows on the other —
while its compare and trends forms reuse the existing period machinery. The earlier removal of
`cash_flow` from the Expenses/Income toggle stands as a rejection of *conflating* it with the
spending and income reports, not of the frame itself.

### Exclusion is the existing flag, and nothing else

The design question that consumed most of the discussion was which transfers count. The answer is
that the question is already answered: **`exclude_from_totals` governs cash flow exactly as it governs
every other report.** Excluded from spending means excluded from cash flow.

Several more elaborate mechanisms were considered and **rejected** — do not re-propose them:

- **Transfer-leg pairing** ("both legs visible means the movement is internal, one leg missing means it
  crossed a boundary"). Attractive, and the deferred transfer-set note in
  [`data-model.md`](../data-model.md) anticipates the primitive, but it is not needed here and it
  decides dynamically what the category flag already decides declaratively.
- **A boundary relative to the current filter selection** (money "leaving" whatever accounts are
  selected). Its motivating use case — validating a period against a statement — is served by reading
  the statement and adjusting for transfers by hand. What it costs is severe: cash flow for two
  accounts selected together would not equal the sum of each selected alone, so adding an account to
  the filter could lower the total.
- **A separate `exclude_from_cash_flow` flag**, or a settings surface for exempting categories. A
  second exclusion axis on categories would drift against the first.

**The directional asymmetry comes from categorization, not from configuration.** An inflow that funds
spending is categorized somewhere *not* excluded and reads as income; a transfer out that represents
saving is categorized somewhere excluded and drops out. No new field, no new setting, no new system
category.

**Credit-card payments need no special handling.** A card payment already sits under the seeded
`Transfers` group, so `COALESCE(parent, leaf)` already excludes it, while the purchases on that card
count at their own transaction dates. The double-count that would otherwise arise does not exist.

### The backend semantics already exist

`/summary/monthly-trend` already accepts `view=spending | income | cash_flow` (and `cash_flow` is its
default; `AccountDetail` is the current caller). That view takes all transactions, drops
`exclude_from_totals` rows, and nets them — which is precisely the semantics settled above. **What is
missing is presentation, not calculation.** The Sankey needs a new edge-shaped endpoint, but it is a
new projection of settled rules rather than a new rule set, and the shared summary-filter helpers
(`_append_account/tag/owner/group/category/payee_filter`, `_summary_signed_total_sql`) already carry
the filter parity every dashboard endpoint is held to.

### Sides are decided by net direction, not by category type

A node sits on the inflow or the outflow side according to **the sign of its own net**, not according
to the `category_type` of the category behind it. A category that nets refunded lands on the inflow
side; an income category running a deficit lands on the outflow side. This is what keeps the diagram
honest under the signed-net reporting rule — no link can have a negative width, so the alternative
would be an ABS somewhere.

Two consequences to design for:

- **Magnitude drives geometry; the label carries the truth.** Link width is the magnitude, and the
  node label and tooltip show the true signed value — the same split already applied to floored pie
  wedges and bars.
- **A node can change sides between periods.** Color and ordering must therefore not be keyed to which
  side a node landed on, or compare mode becomes unreadable.

### Surfacing

- **The frame selector is the existing Expenses/Income control, widened to three.** Not a fourth
  top-level mode beside Single/Compare/Trends — cash flow wants the same period, compare and trend
  machinery, and a top-level mode would fork it. (The pre-2026-08-20 version of this file suggested the
  fourth mode; that suggestion predates the observation that compare and trends are valid frames for
  cash flow.)
- **Single period** renders the Sankey.
- **Trends** renders inflow and outflow as diverging bars around a zero centerline, plus a net line and
  an average line. Recharts covers this natively (`ComposedChart`, negative-value bars, `ReferenceLine`)
  and `recharts@2.15` also ships `<Sankey>`, so no new dependency is required — though the shipped
  Sankey is bare, and custom node/link renderers for labels, color and tooltips are the bulk of the
  frontend work.
- **Compare** is not yet specified.
- **Drill-through to the transaction level is a requirement, not a refinement.** Every node must bottom
  out in real transactions; a node that cannot be drilled into is a defect in the design, not a
  limitation to be documented.
- Cash flow honors the standard dashboard date range and filter chips like every other view.

### Deferred: a second date for cash-basis timing

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
- **Name.** `cash_date`, from the accounting sense of *cash basis* versus *accrual basis*. Recorded with
  its reasoning because the term is jargon that only pays off for a reader who already has that frame —
  `settled_date` or `cleared_date` would carry the same meaning in plainer banking language, and the
  choice is cheap to revisit while nothing depends on it. `debit_date` was rejected: the field applies to
  inflows as much as outflows, so it would contradict itself on a credit row, and `debit` already names a
  *direction* here (`category_rule.debit_credit`, the list endpoint's `direction`).

## Trends-tab semantics audit when the tag-report selector lands there

**Context.** The Trends tab's "Total per month" and "Annual totals" bar charts aggregate across all
series returned by `/summary/monthly-by-group`. Income and expense are filtered in the per-series
rendering, but the per-month and per-year totals are sums of `r.total` across all rows — which can
double-count or produce misleading magnitudes depending on which series mix is present.

**Why deferred.** The Trends tab today has no tag-report selector — adding one is what would expose
this latent issue. The analogous problem was patched on Single mode during Phase 1 (filter to expense
series before summing); the same fix shape applies to Trends mode but needs to be revisited in the
context of whatever filter UI Trends mode gets.

**Suggested approach when picked up.**

- Introduce the same Expenses/Income selector (and eventually the tag-report picker) on Trends mode.
- Derive an `expenseSeriesIds` (or active-selection equivalent) and have `monthlyTotal` and `annualData`
  filter against it before summing.
- Possibly add an `Avg` reference line to `Annual totals` (already done for `Total per month` and
  `Monthly spending by group`).
