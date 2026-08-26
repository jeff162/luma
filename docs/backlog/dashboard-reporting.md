# Dashboard / reporting — follow-ups

**Status: cash flow built 2026-08-25 (design settled 2026-08-20; migrated from `TODO.md` 2026-07-30);
the Trends-tab audit below is still deferred.** Two unrelated dashboard items that happen to share a
file: a cash-flow visualization, and a latent double-count audit that the Trends tab needs before it
gains a tag-report selector.

## Cash flow as a dashboard view

**Built 2026-08-25** — the frame selector widened to three, the single-period Sankey, and the Trends
form. What the build settled is recorded under *What the implementation settled* at the end of this
section; everything above it is the design as it stood, and still holds.

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

> *Corrected by the build.* The Sankey needed **no** new endpoint: `/summary/by-category` already
> returns exactly the node set — one row per leaf category with `group_id`, `category_type`, a signed
> total, and the `exclude_from_totals` guard already applied — so both breakdown levels come out of the
> call the Single-mode loader already makes, with the `exclude_income`/`exclude_expense` flags dropped.
> The **Trends form** is what needed something new, and the obvious shortcut is wrong: see below.

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

### What the implementation settled

Decisions taken during the 2026-08-25 build. Each is recorded here because the rejected alternative
reads as reasonable and will be re-proposed otherwise.

- **The trend's bars are netted per category, not gross per transaction.** A month's `inflow` is the sum
  of the categories that net money in and `outflow` the sum of those that net money out, so a month's
  two bars *are* the two sides of that month's Sankey. The gross reading (every negative-amount row is
  inflow, every positive one outflow) nets to the same figure but reports larger magnitudes both ways,
  and would not reconcile against the diagram beside it. **Do not switch it to gross** to make the SQL
  simpler.

- **It needed its own endpoint, `/summary/monthly-cash-flow`.** Two calls to `monthly-trend` with
  `view=spending` and `view=income` cannot produce these bars: those views filter on `category_type` and
  deliberately drop *type-less categorized* rows (the `Unassigned` note at `monthly_trend`), while
  `view=cash_flow` counts everything — so `income - spending` would not equal the `cash_flow` net, and
  the net line would disagree with the bars drawn under it. The endpoint returns no `count`, on purpose:
  an accurate one cannot be recovered by summing per-bucket counts through the split-expansion seam, and
  reading the source a second time is the cost that seam exists to avoid.

- **`/transactions?view=cash_flow` was added alongside it.** The list endpoint gated its
  `exclude_from_totals` clause on `view in ("spending", "income")`, so a cash-flow drill would have
  listed the transfers its own total excluded. `cash_flow` takes no category-type clause but does take
  that guard.

- **The node granularity is the existing breakdown selector**, not a new control — the same *group* /
  *category* picker the pie uses, relabelled "Cash flow by". The two levels can disagree about which
  side a bucket lands on (a net-outflow category inside a net-inflow group), which is the same kind of
  divergence the pies already have between levels.

- **A balancing terminal completes the diagram.** The two sides differ by the period's net, so the
  surplus flows into a `Net saved` node and a shortfall is funded from a `Net drawdown` node. Without
  one the hub's halves are visibly unequal and read as a rendering fault. It is the only node that does
  not open, because it stands for an arithmetic remainder rather than for transactions.

- **Tag reports are not a cash-flow breakdown.** A signature bucket mixes categories from both
  directions, so it has no single direction to net and no `category_type` to derive one from. The frame
  offers only *group* and *category*; a persisted tag-report selection reads as *group* here and is left
  intact, so switching back to Expenses restores it. **Don't re-propose** a tag-signature Sankey without
  first deciding what a mixed-direction signature's net means.

- **Compare has no cash-flow form, deliberately.** The frame selector was already hidden in Compare and
  stays hidden; `frameForMode` keeps a persisted cash-flow preference from leaking into loaders that
  have no branch for it. Specifying a two-period cash-flow comparison is open work, not an oversight.

- **The single-period frame drops the breakdown *list* card** that sits beside the pie. The diagram runs
  full width and its node labels already carry the names and figures the list carries, and the long-tail
  paging is the frame's equivalent of "Show all". If the list turns out to be wanted, it is additive.

### What the first real-app pass changed

Found on first use against the real ledger, 2026-08-25. Both are label legibility, and neither was
visible to a green unit suite — the chart cannot be rendered under the unit runner at all.

- **Labels adapt to node height.** The stacked name-over-amount label was a fixed ~27px whatever the
  node's height, while consecutive nodes sit only `nodePadding` (14px) apart — so every node under about
  13px overlapped the labels above and below it. Name and amount now share one line below that
  threshold, which needs roughly the padding alone and so always fits. **Do not restore the fixed
  stack:** node height is proportional to value, so a long tail always produces a run of near-zero nodes
  and the overlap is structural rather than an edge case.

- **A side too short to reach the named-slice floor now still collapses its dust.** The shared slicing
  names at least `MIN_NAMED_SLICES` (10) buckets before collapsing anything, so a side holding fewer than
  ten named all of them — on the observed ledger an inflow side of eight, whose smallest was 0.0004% of
  the side, drawn with no height and nothing on screen but its label. `computeSlicePages` gained an
  opt-in `minShare`, and the cash-flow sides pass 1%. It is opt-in because the surfaces genuinely differ:
  a hairline pie wedge costs nothing (the legend beside it still names the item) while a hairline Sankey
  band costs a label row. **Don't fold it into the shared defaults** — the pies want the old behaviour.

The two are complementary rather than alternatives. The floor means a hairline node is usually not drawn
separately; the label rule means the diagram survives the ones the floor does not govern — a collapsed
`Other` whose tail is itself tiny, and the balancing terminal on a period that nearly broke even.

- **The Trends bars need `stackOffset="sign"`, and it is not a removable nicety.** The two bars share a
  `stackId` so they form one diverging column, but recharts' default offset chains each layer from where
  the previous one *ended* regardless of sign — so money out was drawn downward from the top of the
  money-in bar and landed exactly on the net. The chart then showed money in, the net twice (as the
  unoverlapped remainder of the first bar, and as whatever crossed below zero), money out nowhere at all,
  and a rust colour that was nothing but two translucent fills overlapping. Every tooltip figure was
  correct throughout, which is what made it survive to first use. `sign` keeps separate positive and
  negative accumulators, so money in stacks up from zero and money out down from zero. It also depends on
  `outflow` reaching the chart **negative** — the row shaping negates it, and the magnitude rides along
  separately for the tooltip. **Don't remove either half**: the prop reads like tidying and the negation
  reads like a bug, and undoing either one silently restores this picture. The negation is now the stated
  contract of `lib/cashFlowTrend.js` and is pinned by tests; the prop is not testable — no unit runner can
  render the chart — so it carries a comment saying what it holds up, and that comment is the only guard
  there is.

- **The rolling window is twelve calendar months, not twelve rows.** They differ exactly when the ledger
  skips a month: taking rows and then running the axis continuously across them spanned thirteen or more
  months under a label reading "Last 12 months". A ledger shorter than the window still starts where its
  data starts rather than being padded with empty months it never had.

### Second real-app pass, 2026-08-25

Three findings from using the Single-period frame against the real ledger, all on the **shared** trend
chart below the breakdown rather than on anything cash-flow specific.

- **One outlier owned the whole axis.** A year of miscategorised transfers at -$233k flattened eight
  ordinary years into hairlines. No chart in the app set a Y `domain` — all seven `<YAxis>` auto-scaled —
  so this was latent everywhere, not a defect of this chart. `lib/chartOutliers.js` plus the shared
  `ClippedBar` shape now bound the axis and draw anything past it torn off at the frame with its true
  figure.

  **The first rule shipped was wrong and did nothing on the real ledger** — worth recording, because it
  is the intuitive rule and will be proposed again. It compared the largest magnitude against the *next
  largest*, which assumes a lone freak. A personal ledger has a heavy tail instead: measured over 136
  months, the largest was $222k against a next-largest of $142k (a ratio of 1.6, waved straight through)
  while the median month was $4.0k. The ordinary scale is now a high percentile, which a run of giant
  Decembers cannot drag upward. A second rule capping how much of a chart could be torn was written and
  then removed: the percentile already guarantees at most a quarter of bars can exceed the bound, and the
  cap's only effect was to reject the real 2-of-12 case it was meant to protect.

  **Two drawing defects followed on first sight of it**, both from one root cause: recharts gives a bar
  below the axis a *negative* `height`, with `y` as the far edge. Read as positive, a falling bar is
  drawn end-for-end — the break landed on the zero line and the label outside the bar, in white on the
  card background where it could only be found by hovering. The break also moved from the clipped end to
  the **middle** of the bar: at the end it sits on the chart frame and reads as an artefact, and on the
  zero side it collides with the baseline every other bar shares. The geometry now lives in
  `clippedBarGeometry` rather than inside the shape, tested against the exact props recharts was measured
  to hand it.

- **The value axis now stays put while the plot pans.** It had always scrolled away with the bars — not
  a regression, but it left the reader with unlabelled columns at any pan position other than the start.
  The chart is now a fixed axis column beside the scrolling plot, which is the only way to pin an axis
  recharts offers. The two are held in step by a shared vertical geometry and nothing else, so
  `TrendAxisAlignment.test.jsx` asserts the column's zero tick lands on the plot's baseline; it carries
  its own copy of the layout constants on purpose, since importing them would make it agree with whatever
  the page happens to say. Clamped domains also gained **outward-rounded ends** — recharts pins ticks to
  the exact ends it is given, so the clamping had been producing axes reading -27792 / -12792 / 2208 with
  no zero on them. **Applied so far only to the single-period trend chart**; `DetailTrendChart`, the two Trends-tab
  charts, the account-balance chart and the cash-flow diverging chart still auto-scale. Extending is
  mechanical for the plain bar charts. The diverging one is *not* mechanical and should be thought about
  separately: its bars are a stack, so clamping has to decide which side is clipped and what happens to
  the net line drawn across them.

- **Pinning the axis left the average pill as the only label still panning away.** Moving it into the
  column was the ask; the reason it had not been there already was a real one, recorded in the code it
  replaced — a pill on the tick labels buries one. Measuring turned that from a worry into a
  requirement: five ticks 41px apart against a pill needing ~15px of clearance means **two thirds of
  positions collide**, and the collision is biased onto the worst tick, since a net cash-flow average
  sits near zero by nature and zero is always a tick on a diverging axis (measured 1.8px and 2.8px from
  `$0` on the two shapes tried). So the pill steps aside and the ticks do not, capped at the clearance —
  further than that and it reads as a value of its own rather than a label on its line, so a crowded
  axis gets an overlap instead of a drift. Two recharts specifics that are silent when wrong are in
  `docs/ui-patterns.md`: draw it through `<Customized>` (a `<ReferenceLine label>` is clipped here,
  because the column's plot area is a 16px sliver beside a 60px axis), and dodge `niceTicks` — the tick
  set actually drawn — rather than the scale's own denser `ticks()`.

  **Don't re-propose hiding the covered tick instead.** It was the first design and is worse for exactly
  the case above: the label it would hide is usually `$0`.

- **Changing the grain took seconds to settle, differently each time.** Two causes. The plot's bars still
  had recharts' default grow-in, which since the axis was split into its own chart meant an animation
  running against a scale that had already snapped. And both charts sat in a `<ResponsiveContainer>`,
  which measures its own box and keeps the result in state — so a re-bucket painted the new buckets at
  the *old* bucket set's width and corrected itself after paint, squeezed or stretched depending on
  which way the grain went and where the plot was scrolled. That also accounts for the scrollbar coming
  and going on its own: an over-wide SVG extends the container's `scrollWidth`, so the stale frame makes
  it scrollable and the correction takes that away again. Both charts are now handed explicit sizes —
  the width was never responsive, it is `max(buckets × bar width, viewport, floor)` and the page already
  computes it — leaving one observer on the scroll viewport for the stretch case, which does not change
  when the grain does.

  **The same pass closed a latent disagreement rather than leaving it.** The scroll-to-a-bucket
  arithmetic used the bar width while the plot's width came from `max(floor, buckets × bar width)`;
  those are the same number only while the buckets set the width, so a stretched plot put the bucket
  somewhere other than where its bar was drawn. Harmless in the usual stretched case (a plot that fits
  cannot scroll) but reachable through the floor — few buckets in a narrow panel scroll *and* have a
  pitch that is not the bar width. `lib/trendPlotLayout.js` now returns the width and the pitch
  together, and the test that covers it also asserts the old arithmetic left the bucket off screen.

- **Changing the grain then threw the reader to the end of the chart.** What looked like a last bit of
  settling turned out to be the re-centring rule working as written: it targets the *selected* bucket,
  and the grain selector only appears when there is no date chip — which is exactly when no bucket is
  selected — so every grain change fell through to "scroll to the newest bucket". Right for the case it
  was written for (a bar click, where landing on what was clicked is the point), wrong for a gesture
  that re-cuts the same data. The month under the middle of the viewport is now carried across, and the
  two cases are told apart by the selection that already distinguishes them rather than by a new flag.
  `trendScrollTargetIndex` holds the whole rule so it can be read and tested as one: picked period,
  then where the reader was, then — only with no history at all — the newest bucket.

- **A bar click left the chart apparently blank.** The chart pans by native scroll over a canvas sized
  from the bucket count, and the click replaces the bucket set — all-time monthly (hundreds of buckets)
  becomes a fifteen-bucket window. The scroll offset outlives that change, leaving the viewport past the
  end of the new content; it only resolves once the scroll region catches up, at which point the
  scrollbar disappears and the empty region is unreachable. Now re-centred on the selected bucket in a
  layout effect. **Don't key that effect on every render** — it would fight the user's own scrolling.

- **A trend click had no way back.** Re-pinning the period is a navigation, but it is not *levels*: each
  click replaces the date and re-buckets around the new selection, so a user generates a sequence, not a
  depth. The date history lives in `FilterContext` rather than the Dashboard, so a pin survives leaving
  the page that made it, and the control names its destination — which is what answers the actual
  complaint, that the old period was not recoverable or even visible. The existing breadcrumb was the
  wrong home: it tracks this page's group → category drill, while the date is a global filter shared
  with every page.

  **Recording *every* date change was the first rule and was wrong** (corrected 2026-08-25). Having one
  mechanism cover everything that moves the period is the tidier statement, but it made a FilterBar pick
  on any page — including Transactions — arm a control that only ever renders in the Dashboard trend
  card, and worse, it let one step back walk *over* that pick to a period two changes old. Only a chart
  pin records now (`pinDateFromChart`); every other path resets the history, so the back-step means
  "undo the bar clicks I just made" and nothing else. The scoping is a separate setter rather than a
  flag on `setDate` so that opting in is visible at the call site. Both chart entry points use it: the
  single-period trend bar click and the Trends-tab month drill, which moves the period as a side effect
  of drilling and lands on the card holding the control.

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

## Trend bucketing: period-sized buckets vs the grain picker

**Context (raised 2026-08-25, parked the same day).** The Dashboard single-period trend chart has two
bucketing models chosen by whether `filters.date` holds an explicit range. With no explicit chip
— including when the Dashboard's own "Last 12 months" default is in force, since the default lives
in `dashboardDefaultDate` rather than in the filter — it buckets all history by calendar grain and
shows the Monthly/Quarterly/Yearly selector (gated on >18 months of data). Pick any range by hand,
*including "Last 12 months"*, and the selector disappears and each bar becomes one period-length.

**Why it is filed rather than fixed.** The user read the default case as the intended model ("the
picker should just drive it") and was surprised the explicit pick behaves differently. That
expectation was never recorded anywhere: the split is a side effect of the documented decision that
the trend is deliberately independent of the Dashboard default (`ui-patterns.md`), and the only
mention of the hide rule is an aside in the scroll-anchoring entry above. Whether the picker should
become the sole control is an open design question — `computeTrendBuckets` and its "this kind of
slice, over time" model would lose its reason to exist on the single-period chart.

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
