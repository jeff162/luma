# Reimbursable expenses

**Status: built 2026-09-02 (schema-free) — service, API, transaction-detail panel, ledger row marker,
the outstanding report (two-column board with drag-to-pair), and the Help topic. Reworked repeatedly
under real use rather than review: rows → *portions*, "settle" → *complete*, one action → **sign-driven**
actions, and a Tracked/Not-tracked report → a board split by direction. Still owed: the Tasks signal for
an ageing reimbursement. See *Open questions* for what was deliberately left.**
Design settled 2026-09-01. Money that leaves as an expense and comes back later — concert tickets
bought for friends, a work expense paid personally and claimed afterwards. The ledger already records
both movements correctly. What it cannot say is that
February's $500 was really $100 of spending, because the $400 that offsets it does not arrive until
July.

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

## The model: a receivable category, not an automatic restatement

The reimbursable portion is split into a holding category — money owed back — that carries the
`exclude_from_totals` treatment already used for transfers and credit-card payments. The later inflow
lands against that same category rather than against income.

- **February:** $100 entertainment + $400 receivable.
- **July:** the repayment reduces the receivable. Nothing about February changes.

Three properties, each of which is why this shape is preferred over the alternatives:

- **Nothing is restated on its own.** A period already looked at does not change months later as a
  side effect of anything, and the ledger still agrees with the bank statement. Settling *does* change
  an earlier period, deliberately and by hand — see *Where the residual lands* below.
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

Do **not** reach for an income category to absorb a surplus — that would misfile a recovered cost as
earnings. The over-repaid case needs no category of its own: signed-net reporting already handles it,
and the original category simply reads negative for the period the residual lands in.

### Where the residual lands

**The residual is a category balance, not a row**, so "move it to a real category" has to mean editing
the allocation of a transaction that already exists. There are only two candidates — the expense or the
repayment — and **the sign of the residual decides which, so it is not a preference to be exposed**:

| residual | settles on | the edit | why that one |
| --- | --- | --- | --- |
| positive (short / unpaid) | the **expense** | receivable part shrinks by the residual, real category's part grows by it | a shortfall is money genuinely spent, and only the outbound row points the right way to absorb it |
| negative (repaid over) | the **repayment** | receivable part covers what was owed, real category takes the remainder | a surplus is money that genuinely came back, and only the inbound row can carry it |

Two consequences worth stating plainly, because each is the opposite of an assumption that reads as
obvious:

- **Settling a shortfall restates the original period, and that is the intent.** Where only $375 of the
  $400 comes back, February stops saying $100 and starts saying $125 — because $125 is what February
  actually cost, once the repayment is known to be final. The restatement is an explicit act by the user
  against a specific expense — not automatic, not silent, and not a drift. Where a receivable was never
  split at all (a wholly reimbursable expense that was never repaid) settling is a plain
  recategorization with no split involved, and where it empties the receivable part entirely the
  transaction un-splits rather than being left holding a single allocation.
- **Settling a surplus does not touch the original period, and that is also the intent.** The gain was
  realized when the overpayment arrived, not when the tickets were bought. Booking it back into
  February would claim a gain in a month where nothing had yet gone right.

**This is why no mixed-sign allocation is needed, and the rule must not be reached for here.** Settling
*everything* on the expense looks like the uniform choice and is the trap: a surplus larger than the
user's own portion drives that expense's real-category part negative, which
[`../data-model.md`](../data-model.md) → *Transaction splits* refuses by design (`validate_parts` — every part shares
the transaction's sign), and which would otherwise argue for relaxing that rule as a prerequisite here.
It is not a prerequisite. Sending the surplus to the repayment instead is legal at *any* magnitude,
because every component of an inbound repayment points the same way. Mixed-sign splits remain a coherent
future relaxation on their own merits; this feature neither needs one nor justifies one.

**Which repayment**, when several settle one expense, is the link's job — and it is the point at which
pairing stops being optional (below). Where an instalment repayment tips into surplus on its final
payment, that payment is the one holding the money.

## Pairing: optional, and late

Pairing is not required for the numbers to be right, and should not gate the feature:

- **Reporting** works off the category aggregate. Correct period spending and a correct outstanding
  total, with nothing linked.
- **Settling** needs to know which inflow closes which expense, once more than one receivable is open.
  That is the only place identity is needed.

**One payment may close several expenses** — an employer settling a month of receipts at once. `txn_link`
supports the one-to-many shape directly, so the constraint this places is on the settle surface rather
than the model: it has to be built for a set from the start, not for pairs with the many-case bolted on.

When it is needed, the primitive exists. [`data-model.md`](../data-model.md) states `txn_link` is a
**general association primitive, not an Amazon feature**, and already names further clients as intended.
A `kind='reimbursement'` link with roles `expense` / `repayment` and an `external_ref` carrying the
counterparty ("Dave — concert tickets") fits without a new table.

**The expected amount is *not* stored, though the design first said it would be.** It is the sum of the
members' receivable allocations, so storing it would be a second truth able to drift from the ledger the
moment a split is edited — the same objection that makes the members' **roles derived from the sign of
their receivable portion** rather than stated. What `metadata_json` does hold is, once settled,
the settlement record: the target's prior allocations, category and provenance, which is the only thing
that can put a settlement back.

It follows that **every member must carry a non-zero receivable portion**. A transaction allocating
nothing to the holding group contributes nothing to the residual and would sit in the report as a row
that cannot be acted on, so it is refused at the join with the actual next step named — split the
expense so the part owed back lands in the group.

Follow the primitive's rule: **a link never mutates the transactions it joins.** The feature performs
the recategorization at settle time and records what it did in `metadata_json` so it can be reversed —
the same contract Amazon order itemization and wallet funding-leg suppression already observe.

The resulting surface is the Amazon reconciliation shape again: an expected total, inflows reconciling
against it, and an acknowledge/settle action for what will never match. That report is the reference
implementation for the screen, not a new pattern to invent.

## Built on splits

"All or part of an expense" is exactly what [`../data-model.md`](../data-model.md) → *Transaction splits* provides —
one ledger row, N category/amount parts. A wholly reimbursable expense needs only recategorization, but
the motivating case is partial (one ticket mine, three for friends), which is why this was downstream of
splits and could not start before them. **Splits shipped 2026-08-24, so that dependency is met.**

Nothing further is asked of them. The allocation table, the expansion seam every category rollup already
reads through, and the per-allocation `exclude_from_totals` guard together mean the reporting half of
this feature is arithmetic that already works: a receivable part drops out of spending totals wherever a
transfer would, in the period the part belongs to, with no reporting surface to change.

## A reimbursement covers a portion, not a transaction

The first build made the **transaction** the unit and enforced "at most one reimbursement per
transaction". That is a tidy-sounding invariant and it cannot express the file's own motivating example.
It was found within a day of being written, by ordinary use.

Splits exist so one ledger row can mean several things. A consumer that insists a row means one thing to
*it* is fighting the feature it is built on, and the cases that break are not exotic:

- **$750 on three concert tickets**, one the buyer's and two owed by different friends, is **two debts**
  on one charge. Each needs its own counterparty, its own repayments, and its own settlement — one may
  be repaid in full while the other is short.
- **One ATM deposit** split across buckets can carry repayments for **two different debts at once**.

So the unit is a **claim**: how much of a row's receivable belongs to *this* reimbursement. A row may
appear in as many reimbursements as it has receivable money to divide between them, and what no link has
claimed is **unclaimed** — which is what the outstanding report lists and the picker offers. This needed
no schema change: `txn_link_member` is keyed `(link_id, txn_id)`, so several links over one row were
always possible; only the service rule forbade it.

**Claims are amounts, not split-part ids.** `save_split` deletes and reinserts a row's parts on every
edit, so part ids do not survive an ordinary re-split. A part is how the *user* picks a portion — the
picker shows "Dana's ticket $250" — and the amount is what is stored, with the label kept as display
provenance that no arithmetic reads.

The lesson generalizes, and it is the same one `../mechanism-index.md` records about splits' own
two-parts-in-one-category rule: **before constraining what the user may record, ask whether the
difficulty is in the domain or in the queries.** Here it was in the queries — a per-transaction sum —
and the constraint quietly made the feature unable to model the case it was designed around.

## Completing is the ending; settling a residual is only what it sometimes does

The first build made **settle** the terminal act and refused it when the residual was zero — "this
reimbursement is already square". That reads like a sensible guard and is the second constraint in this
file to have made an ordinary outcome unreachable: *repaid in full* is the outcome the whole feature
aims at, and it was the one state with no action attached. A finished reimbursement stayed on the open
list forever with nothing the user could do about it.

So the action is **complete**, and it means *this is finished*:

- with a residual, it moves the residual and closes;
- with nothing left over, it closes and moves nothing — no category asked for, because there is no
  decision to make.

`reopen` reverses either, restoring allocations only where any were moved. The report then lists **open
reimbursements only**: a completed one is absent rather than filed under a second heading, because there
is no work left on it and a list of finished ones is not something anyone asked to read. It stays
reachable from any of its transactions.

One consequence worth knowing: a completed reimbursement's transactions **stay in the holding group,
and in whichever leaf they were already in**. The two sides cancel there, so no report is wrong.

That looked like a naming wrinkle at first — a leaf called *Awaiting reimbursement* stops being true
once the pair is closed — and the fix designed for it was a seeded *Completed* leaf that finishing would
move rows into. **Rejected, and the reason generalizes:** it pays for a bad label by destroying a good
one. Leaves named for what the money is *for* ("Concert tickets", "Work expenses") stay true forever and
are how a row is found again later; moving finished rows out of them loses exactly that. The group
already says "owed back", so a leaf that says it again is doing the group's job. Name leaves for the
thing, not the state, and nothing needs to move. See `data-model.md` → Reimbursable expenses.

The app therefore seeds the **group only** and nothing inside it — an earlier `ensure_reimbursable_leaf`
helper that would have created an *Awaiting reimbursement* leaf was never wired to anything and has been
removed, since an uncalled find-or-create for a category the user should be naming is what gets
connected by accident later.

## Settled decisions

Recorded so they are not re-opened.

- **The terminal action is "complete", not "settle".** Repaid in full completes with no move; don't
  re-impose a guard that treats a zero residual as an error.
- **The report lists open reimbursements only.** No second list of completed ones.

- **The unit is a portion of a transaction, never the transaction.** Don't re-impose "at most one
  reimbursement per transaction"; see above.

- **Settling restates the original period when the residual is positive** — see *Where the residual
  lands*. The restatement is explicit, user-initiated and per-expense, and it is what makes the earlier
  month true rather than a drift away from it.
- **A surplus settles on the repayment, not the expense.** The uniform-looking alternative is the trap;
  it is what would make mixed-sign allocations look like a prerequisite for this feature. They are not
  one — don't re-impose that reading.
- **The settle action is per-expense, not per-position.** A residual has to land on the allocation of a
  named transaction, so a per-position action ("write off $50 of this category") has nothing to edit,
  and it could not choose between the expense and the repayment without knowing which expense fell
  short.
- **The receivable lives under a seeded top-level group of its own** — `Reimbursable`, carrying
  `category_type = 'expense'`, `exclude_from_totals = 1` and a `system_key`. Not a leaf under
  `Transfers`: `ensure_excluded_transfers_leaf` is right there and does exactly the wrong thing here,
  because a receivable is not money movement and everything that reasons about that group would absorb
  it silently — the cash-flow frame, and the "money movement" reading the Recurring page takes off an
  excluded category. Not a user-created category the feature recognizes by name either; see the sweep
  below.
- **The feature keys on the *group*, not on one blessed leaf.** This is what makes the
  one-category-versus-one-per-counterparty question moot rather than answered: the group is the
  identity, so a user may keep the single default leaf or add their own (`Work expenses`,
  `Shared purchases`) without the feature knowing or caring, and `exclude_from_totals` on the group
  covers every leaf inside it through `COALESCE(parent, leaf)` — a receivable leaf that counts toward
  spending cannot be created by accident. The outstanding total is a `group_ids` facet, which the list
  endpoint already supports and already expands splits for. Counterparty still belongs on the link's
  `external_ref`, not in a category: categories are not a directory of people.
- **The group cannot be deleted, and its `exclude_from_totals` cannot be changed.** Both are flat
  refusals on the *group*, not conditional ones: the durable question is whether the group is part of
  the machinery, not whether it happens to hold money today, and a gate on the second produces a
  control that works on some days and not others. The delete refusal is also the honest description of
  what already happens — `_seed_default_categories` runs on every start, so a deleted group returns at
  next launch (the behaviour `_ensure_transfers_group` documents for `Transfers`), leaving deactivated
  leaves holding the outstanding balance outside the group the feature reads. Clearing the exclusion is
  the more likely accident of the two and the more damaging: it silently restores the exact
  overstatement this feature exists to remove. The checkbox therefore renders **disabled with its
  reason** rather than erroring on click, with the backend guard behind it because that is what holds
  across entry points.
- **No leaf is seeded inside the group, and completed rows never move.** Leaves are named for what the
  money is; a state-named leaf and the "Completed" bucket that patches it were both rejected. Don't
  re-propose either.
- **The group cannot be *moved* either — a third guard the design missed.** It surfaced only when the
  single `isSystemCategory` flag was decomposed into per-capability answers (`ui-patterns.md` → *What a
  protected row may have done to it is a table, not a flag*). Reparenting turns the group into a leaf,
  and every lookup requires `parent_id IS NULL`, so the next write creates a second group while the
  outstanding balance stays stranded under the moved row and the report reads zero. It is the quietest
  of the three failures and was reachable by an ordinary drag.
- **The guards stop at the group; leaves stay the user's.** Renaming, deleting and adding leaves are all
  free, because `exclude_from_totals` is `NOT NULL DEFAULT 0` and an existing parent therefore always
  wins `COALESCE(parent, leaf)` — a leaf under the group cannot opt itself back into spending totals
  whatever it is set to. Policing leaves as well would be constraint for its own sake.
- **An unsettled receivable becomes a Task, age-gated and dismissible.** Not a nicety — it is what keeps
  the model honest. Until a receivable is settled, spending is under-reported, which is the same disease
  the flag-and-exclude alternative was rejected for; the difference is only that the outstanding amount
  is visible. The age gate is what stops a reimbursement legitimately outstanding for months from
  nagging the whole time. Follows the recurring-signal precedent for dismissal.

### How the group and its leaf get created

The two halves follow the seeding policy already in force, and between them they need **no migration**:
`_seed_default_categories` runs on every start, before the fresh-versus-migrate branch, so an existing
database picks the group up at next launch.

- **The group is seeded for everyone**, like the other top-level reporting groups, because those exist
  so the import workspace always has visible buckets to drop imported labels into.
- **The leaf is find-or-create on first use**, mirroring `ensure_excluded_transfers_leaf` — including its
  reason for recreating a missing *group* rather than degrading to a parentless leaf, since a
  transaction may only ever be assigned to a leaf. A user who never touches this feature is therefore
  left with one empty group and no stray category.

**The `system_key` is load-bearing, not decoration.** The empty-category sweep deletes leaves with no
transactions and no rules, and groups whose active children are all swept — skipping both where
`system_key IS NOT NULL`. A receivable category is *empty whenever nothing is outstanding*, which is its
healthy state, so without the key the feature's own category is exactly what that sweep eats. The key
also survives the user renaming the group, which a name lookup does not.

## Still open

- **The Tasks signal for an ageing reimbursement.** Never built; the only item outstanding from the
  original design.
- **Moving an already-tracked receivable between records.** The editor's *Link another transaction*
  offers only *unclaimed* money, so a row whose receivable is entirely claimed by record A cannot be
  moved to record B — it has to be released with **Stop tracking this** first. The sign-driven actions
  stop rival records being created by accident going forward, but they do not free the ones already
  stranded that way. A "Move here" option on the picker, detaching the claim from its current record
  (and deleting that record if it was its last claim, as `remove_transaction` already does), is the fix.
- **The symmetric expense-side match.** Starting from a *repayment* offers the expenses it could repay;
  starting from an **expense** does not offer the repayments. Deliberate — the temporal norm is money out
  first, back later, and adding a chooser there costs the ordinary case a click — but it is the direction
  the user's own instinct went, so it may be worth revisiting.
- **Not this feature's, but found here:** the shared `Button` dims a disabled control and drops its
  handler without setting the DOM `disabled` attribute, so it stays focusable and announces as enabled.

## Decided against — do not re-propose

- **A free-text note beside the record's name.** Removed 2026-09-02. The name is free text already and
  appears everywhere the record does; the note reached exactly one surface. Nothing migrates — it lived
  in `metadata_json`. Rejected on the way: surfacing the note on the board instead, which would have been
  inventing a justification for the field after the fact.
- **A seeded "Completed" leaf** to move finished rows into. Leaves are named for what the money *is*, not
  for where it sits in a lifecycle; a state name goes stale the moment the state changes.
- **Right-click as the route to completing a record.** Completion lives in the editor, which already has
  the guards, the write-off path and the copy. A terminal action reachable only by right-click is
  undiscoverable.
- **Dropping the named portions from the picker once part of a row is claimed.** It would read more
  simply, but it breaks the ordinary case: claim one third of a three-way split and the other two
  portions become unofferable, leaving only "everything remaining".
- **Blocking a repayment from being recorded on its own.** A credit can clear before its receipt is
  entered; refusing it leaves that money nowhere to go. It is the quiet option, not an invalid one.

## Cross-refs

- [`../data-model.md`](../data-model.md) → *Transaction splits* — the allocation mechanism this depends on
- [`dashboard-reporting.md`](dashboard-reporting.md) — `cash_date`, the adjacent timing question
- [`../data-model.md`](../data-model.md) — `txn_link` as a general primitive; signed-net reporting;
  `exclude_from_totals`
