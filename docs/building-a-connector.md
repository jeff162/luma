# Building a Connector

How to add a new data source, and — more usefully — which of this system's assumptions are actually
**Plaid's assumptions** wearing a general name. The seam was built around one aggregator first, and
almost every trait that looked universal turned out to belong to that provider. Each time one of those
was discovered, the fix was the same shape: stop branching on the provider's name, and have the source
*declare* the fact so the shared path can honor it.

This document is the checklist of those facts. Read it before writing an adapter; the failures below are
all ones that shipped, and every one of them was silent.

> Scope note: "connector" here means any **data source** that produces transactions — a provider
> connection (a `ProviderAdapter`) *or* a file importer. The two do not share a base class, so some
> declarations live on the adapter class and some in a registry; see
> [Zero-amount rows](#zero-amount-rows). Where a rule applies only to connections, it says so.

---

## Contents

* [The adapter interface](#the-adapter-interface)
* [Capability declarations](#capability-declarations)
* [Transaction ids must be globally unique](#transaction-ids-must-be-globally-unique)
* [Zero-amount rows](#zero-amount-rows)
* [Dates a source does not have](#dates-a-source-does-not-have)
* [Currency](#currency)
* [Request budgets and pausing](#request-budgets-and-pausing)
* [Coverage claims](#coverage-claims)
* [Reporting what was refused](#reporting-what-was-refused)

---

## The adapter interface

`backend/services/providers/` exposes `get_adapter(provider)` over a `ProviderAdapter` — `connect`,
`fetch_accounts`, `fetch_transactions`, `fetch_transactions_sync`, `remove` — normalized to
provider-neutral dict keys (`external_account_id`, `external_transaction_id`, …). The connect and sync
paths speak only the adapter plus the `connection` table, never a provider's own field names.

Subclass `ProviderAdapter` rather than duck-typing the two methods a caller happens to use. The sync loop
reads capability declarations to decide how deep to fetch and whether a backfill finished, so a partial
stand-in goes stale the moment the contract grows — silently, because an `AttributeError` inside the loop
is swallowed by the per-connection error handler. Inheriting means each new declaration arrives with its
real default, or fails loudly where there deliberately is none.

## Capability declarations

The class attributes on `ProviderAdapter` are facts about a provider that the routers and sync loop would
otherwise learn by branching on `provider`:

| Declaration | What it governs |
| --- | --- |
| `requires_app_config` | Whether there is an app-level credential at all. `False` (SimpleFIN) stops "no app config" from reading as "setup unfinished". |
| `connect_spec` | How the frontend collects the connect payload — `None` for a Link-style widget, otherwise a generic token form, so the UI never branches on provider name. |
| `max_history_days` | The provider's own cap on history depth, where it publishes one. |
| `has_cursor` | Whether there is a change feed. `False` means every pull is a date range and a routine sync must choose a look-back window. |
| `revokes_on_disconnect` | Whether `remove()` actually invalidates the credential upstream. `False` changes what the disconnect confirmation must tell the user. |
| `routine_lookback_days` | How far a routine (non-backfill) sync reaches on a cursorless provider. |
| `zero_amount_rows` | Whether $0 rows are kept or refused — see below. **No default.** |

Most have a default. `zero_amount_rows` deliberately does not, because its answer does not generalize
between providers and a wrong inherited guess is silent.

## Transaction ids must be globally unique

`txn.external_transaction_id` is `UNIQUE` across the whole ledger, and all four sync lookups query it
**unscoped** — no account, no connection. That is what makes a sync idempotent, and it is a real ledger
invariant, not an implementation detail.

**Check your provider's uniqueness guarantee before writing anything else.** Plaid's ids are globally
unique. SimpleFIN's are unique only *within an account*, so its adapter namespaces them:
`simplefin:<account>:<bank id>`, mirroring how `external_account_id` is namespaced.

This was not hypothetical. The Bridge's demo server derives ids from the posting instant and runs every
account on one schedule, so two accounts issued byte-identical ids — the second account's rows matched the
first's on the unscoped lookup and were dropped as already held. The account imported **nothing** while
the sync reported success. Namespace at the adapter boundary, which is the layer that knows; do not weaken
the lookups. The signature of this regression is `added == skipped` exactly, with one account empty
(`test_two_accounts_issuing_the_same_transaction_ids_both_import`).

## Zero-amount rows

A source may publish a transaction with **no amount**. Whether to keep it is not a universal fact — it
depends on what a $0 row *means* from that source, and the four current sources answer for three different
reasons. The declaration and the rule live in `backend/services/source_capabilities.py`.

**Keep $0 rows if either is true:**

1. **The row is reachable later.** A pending charge is often published before it carries an amount and
   revised when it settles. Where the revision lands on the row already held — keyed on the provider's
   transaction id, via a change feed (`modified`) or a pending→posted pointer — the $0 row is exactly what
   the settled amount updates. Dropping it does not delay the charge, it **discards** it: a revision
   naming a row that was never inserted is ignored, not treated as an insert.
2. **The zero is genuine.** Some sources publish $0 rows that are finished records rather than
   placeholders — a fully gift-carded or promotional order, a refund that nets out.

**Reject only if neither holds.** Then the row is unreachable dead weight: the real charge arrives as its
own separate row, and duplicate detection cannot pair the two because their amounts differ.

| Source | Policy | Why |
| --- | --- | --- |
| Plaid | `keep` | Revises in place, via `modified` and `pending_transaction_id`. |
| SimpleFIN | `reject` | No change feed and no pending pointer, so nothing *guarantees* reachability: a settling charge is sometimes re-sent under its original id (observed live) and sometimes arrives as a new one, stranding the placeholder. A revision that may or may not find the row cannot carry a policy whose whole premise is that it will. |
| CSV / PayPal | `reject` | No identity carries between files, so nothing can ever revise the placeholder. |
| Amazon | `keep` | A $0 order is a finished record; reconciliation would otherwise read it as an order whose charge was not found. |

Adapters declare `zero_amount_rows` as a class attribute. **Sources that are code paths rather than
adapter classes** — the CSV importer, the Amazon importer — have nowhere to put an attribute, so they are
registered in `_NON_ADAPTER_SOURCE_POLICY` and read through `zero_amount_policy_for_source`. Every call
site goes through the single `rejects_zero_amount` predicate so a typo cannot mean "keep" in one place and
"reject" in another.

There is **no default**, on purpose: a source that has not been thought about must fail loudly rather than
inherit another source's reasoning.

A refusal is only acceptable while it stays visible — see
[Reporting what was refused](#reporting-what-was-refused).

## Dates a source does not have

A **required** protocol field is not a promise that it carries a value. Where the protocol makes a field
mandatory and the source has nothing to put in it, the field does not go missing — it degrades into a
**sentinel**, and a numeric sentinel converts without raising anything. SimpleFIN's `posted` is required
and reads `0` for a charge that has not posted, which `datetime.fromtimestamp` turns into a perfectly
well-formed 1970-01-01. Nothing errors, nothing is logged, and the row lands in the ledger sorting before
every other transaction, inside no report period, unreachable by every date test in the duplicate ladder,
and filed on a sync card labelled "January 1970".

So an adapter must decide, per date field, **which values mean "absent"** — not only a missing key. Then:

* Prefer the field the ledger actually reports on (`posted`), and **fall back** to the other date the
  source publishes (`transacted_at`) rather than to nothing. A pending row is ledger content, and the date
  it *does* have is when the charge was made.
* Never synthesize a date from the import time or a window bound. A fabricated date is indistinguishable
  from a real one; a dropped row is at least honest, and a row with no usable date anywhere is dropped.
* Where the settled version of a row can arrive later, the sync must **re-stamp** the date, not merely
  clear the pending flag — see `_refresh_provider_fields` in `routers/sync.py`. A field written from a
  provisional version of a row is provisional until the row is superseded.

The corresponding trap on the fixture side is that a simulator is written from what a source *documents*.
The captured demo data and the first version of `_simplefin_sim.py` gave every pending row a real posting
timestamp, so the entire class was invisible to a test suite that otherwise covered pending rows well.

## Currency

The ledger holds **one** currency at a time and `txn.amount` stores no denomination beside it, so two
denominations saved together are indistinguishable and both join every total. There is nothing to convert
from and no rate source to convert with.

An adapter receives the ledger currency as the `ledger_currency` argument to `fetch_transactions_sync` and
must **drop** accounts denominated in anything else, reporting them so the user is told rather than left
with silently wrong arithmetic. An account whose rows were discarded must also be kept out of coverage —
claiming a range for an account whose transactions were thrown away produces the over-claim that makes
duplicate detection reject genuine rows later.

## Request budgets and pausing

A provider may meter requests. **"Nothing more right now" and "the history is complete" are separate
facts, and an adapter must report them separately** (`resume_later` vs `backfill_complete`). A metered
provider can stop mid-backfill with history still outstanding: it must say *stop polling* — more requests
would push it toward being cut off — while leaving the connection un-flipped so a later sync resumes.
Marking it complete there strands the unfetched history behind a short routine look-back with nothing left
to go back for it.

Record where the walk got to. For a cursorless provider the `connection.transactions_cursor` column
carries whatever checkpoint the adapter's own resume needs (SimpleFIN keeps a JSON walk position there) —
the column was always defined as an opaque resume token, not literally a cursor.

**Spending is not part of that checkpoint.** It travels as `request_budget`, a mutable dict the adapter
writes through as it spends, persisted separately in `connection.provider_request_budget`. Two rules follow
from the difference, and both are easy to get backwards:

* **A resume checkpoint must roll back with a failed pull; spending must not.** A checkpoint claims data is
  held, so a pull that inserted nothing must not advance it. A request that has already left the machine
  counts whether or not the call it belonged to returned. Sharing one field forces one persistence rule on
  both, and each one's correct rule is the other's bug — a budget that forgets a failed pull's requests
  overruns exactly when a user is retrying a broken connection hardest.
* **Mutable, because a return value cannot escape an exception.** The sync layer writes the record back in
  a `finally`, so a failure mode added later cannot silently opt out of being metered.

**Model a published limit as what it actually is.** A limit described as "N per day, replenished through
the day" is a refilling bucket, not a daily quota, and a counter that resets on a calendar boundary hands
out a full allowance immediately after one already spent — which is precisely what a backfill resuming
night after night does. Where the refill rate is inferred rather than stated, infer it *slow*: crediting
too slowly costs a request that could have been made, while crediting too fast spends one the provider has
not granted.

**Check whether the limit is one allowance or several.** SimpleFIN grants an unfiltered `/accounts` call
and each `?account=` call their own, which changes what an account-filtered request is *for*: not a
bandwidth saving but a different pool to spend from. It also bounds how a filtered request may be shaped —
the separate allowance was described for a single account, so a request naming several has no known cost
and is not sent.

## Pages, commits, and what a failure may cost

**A pull is delivered a page at a time, and each page is committed before the next is fetched.** The sync
layer holds no write transaction across a provider call. Two things follow that an adapter has to
cooperate with:

* **Report `has_more` while work remains**, rather than draining everything into one call. A walking
  adapter should return after a small number of windows — SimpleFIN uses one (`WINDOWS_PER_PAGE`), because
  a page boundary costs a commit (~1ms) and bounds a provider request (~1s), which is not a close call.
  Draining instead means the write lock is held for the length of the whole pull, which makes the rest of
  the app unusable, and a failure discards everything fetched.
* **Report only what *this page* did.** `account_coverage` must describe the accounts the page actually
  advanced — never pre-seeded from where they already stood. A page that ends early says nothing about the
  accounts it did not reach, and an adapter that reports them anyway claims depth nothing fetched.

`continuing` distinguishes the first call of a pull from the pages after it, for work that belongs to the
pull rather than the page. SimpleFIN opens a pull by fetching its recent window once, so the ledger stays
current while a long walk fills in behind it; repeating that per page would spend a metered request
re-fetching one window. The adapter cannot tell the two apart from its own state — only the caller knows
whether it is starting or draining.

**Metered adapters must checkpoint before they spend.** Call `budget_checkpoint()` immediately after
debiting and *before* issuing the request it paid for. The orderings fail differently: debiting afterwards
loses the request on a crash in between, so the count reads low and the next sync over-spends a limit whose
penalty may be a disabled credential; debiting first can only forfeit an allowance nothing used, which a
refilling allowance heals on its own.

## Coverage claims

Only claim what was actually fetched. A walk that advances its frontier by the window it *asked for*,
while the server returned less, records coverage over days nothing fetched — and a coverage over-claim is
worse than a gap, because duplicate detection then rejects genuine rows as falling inside an
already-covered range. Watch for silent server-side truncation of over-wide date ranges.

Note that a **card's** date span is not a coverage claim: a delta card can span a month while holding the
three rows that happened to arrive. Coverage lives on `connection_account`.

**"Reports no per-account coverage" and "reports none this time" are different claims**, and collapsing
them over-claims. An adapter that does not track coverage per account (a cursor provider) licenses the sync
layer to record the depth it *requested*; an adapter that does track it, reporting an empty set, is saying
this pull reached nothing new — which licenses recording nothing. A walking provider reports exactly the
empty set once every account's history is complete, so reading the two as one makes "Fetch more history" on
a finished connection claim the full requested depth for accounts nothing fetched. The signal is therefore
the *presence* of `account_coverage`, never its truthiness.

## Reporting what was refused

Anything a source refuses must land on the import/sync card, in the shape the CSV importer already uses —
a refusal the user cannot see is indistinguishable from a bug.

Both reports write through the same writers as CSV import, so the existing card UI, the rejected-rows
dialog, "Import anyway" and Restore all work on a sync card with no frontend changes:

* **Duplicates** — `record_sync_duplicate` → `import_batch_duplicate`.
* **Rejected rows** (today: $0 refusals) — `record_sync_zero_amount_rejection` → an `import_summary` in
  the card's `config_snapshot`, the same key and shape CSV import writes.

Two details are easy to get wrong:

* **Counts accumulate.** A CSV summarizes one file once; a monthly sync period card is added to by every
  top-up for the rest of the month. A summary that overwrites silently resets the count and reports only
  the most recent sync's refusals.
* **A row number is an ordinal.** A sync has no file lines, but the reports are keyed by row, so arrivals
  are counted instead.

**Tentative decision — resolving a refusal-only sync.** A sync whose only content is refused rows still
resolves (and therefore creates) its card, so the refusals have somewhere to be reported. This matches
what duplicates already do. The cost is that a sync which imported nothing can leave a card showing only
rejects. The alternative is CSV's rule — delete the batch when nothing was imported or deduped — which
would keep the card list clean at the price of making the refusals invisible and of having rejects and
duplicates behave differently on the same card. **This is expected to be revisited once the effect is
visible in practice; it is not settled.**
