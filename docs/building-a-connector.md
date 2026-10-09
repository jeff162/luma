# Building a Connector

How to add a new data source, and — more usefully — which of this system's assumptions are actually
**one provider's assumptions** wearing a general name. The seam was built around a single aggregator
first, so anything in it that looks universal may only be that provider's behaviour under a neutral
name; distrust the general-sounding ones. The fix is always the same shape: stop branching on the
provider's name, and have the source *declare* the fact so the shared path can honor it.

This document is the checklist of those facts. **None of the failures below announce themselves** —
each one produces a plausible-looking result, so a test that does not already know what to look for
will not find it.

> Scope note: "connector" here means any **data source** that produces transactions. There are three
> shapes — a provider connection (a `ProviderAdapter`), a file importer, and a marketplace importer —
> and they do not share a base class, so some declarations live on the adapter class and some in a
> registry (`services/source_capabilities.py`).

**Which sections apply.** Most of the material below came from building
provider adapters, so the connection sections are the longer ones — but the rules that survived turned
out to be about *sources*, not about connections, and the other two shapes hit several of them unchanged.

| Section | Connection | File importer | Marketplace importer |
| --- | --- | --- | --- |
| The adapter interface · Capability declarations · Where the connection handle comes from | ✅ | — | — |
| Adding a file importer | — | ✅ | partly (the downstream rules; not the CSV parse seam) |
| Adding a marketplace importer | — | — | ✅ |
| Transaction ids must be globally unique | ✅ | — (a file carries no identity between imports; dedupe keys on content) | — (an order id joins a vendor's own files; it is not a ledger identity) |
| Zero-amount rows | ✅ | ✅ | ✅ (and the one current source that answers `keep` for reason 2) |
| Dates a source does not have | ✅ | ✅ (a column can be blank or hold a sentinel exactly as a protocol field can) | ✅ |
| Currency | ✅ | ✅ (the one-currency rule; the `ledger_currency` argument is connection-only) | ✅ (the one-currency rule) |
| The published guide is not the contract · Request budgets · Pages and commits | ✅ | — | — |
| Coverage claims | ✅ | ✅ (an import writes `import_batch_account`; the over-claim rule is the same) | ✅ (per file card, not per account) |
| Reporting what was refused | ✅ | ✅ | ✅ |

---

## Contents

* [The adapter interface](#the-adapter-interface)
* [Capability declarations](#capability-declarations)
* [Where the connection handle comes from](#where-the-connection-handle-comes-from)
* [Adding a file importer](#adding-a-file-importer)
* [Adding a marketplace importer](#adding-a-marketplace-importer)
* [Transaction ids must be globally unique](#transaction-ids-must-be-globally-unique)
* [Zero-amount rows](#zero-amount-rows)
* [Dates a source does not have](#dates-a-source-does-not-have)
* [Currency](#currency)
* [The published guide is not the contract](#the-published-guide-is-not-the-contract)
* [Request budgets and pausing](#request-budgets-and-pausing)
* [Pages, commits, and what a failure may cost](#pages-commits-and-what-a-failure-may-cost)
* [Coverage claims](#coverage-claims)
* [Reporting what was refused](#reporting-what-was-refused)
* [What a failure says](#what-a-failure-says)
* [Where requests may go](#where-requests-may-go)
* [Considered and rejected](#considered-and-rejected)
* [Obstacles](#obstacles)
* [Open](#open)

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
| `connect_noun` | What one connect action adds, as a noun for the connect button (Plaid: `"Institution"` → "+ Connect Institution"). `None` where a single connect covers a set no noun describes — a SimpleFIN token claims a bridge that may span several banks — and the button reads "+ Connect". Never `"Account"`: that means a ledger account everywhere else in the app. |
| `max_history_days` | The provider's own cap on history depth, where it publishes one. |
| `has_cursor` | Whether there is a change feed. `False` means every pull is a date range and a routine sync must choose a look-back window. |
| `revokes_on_disconnect` | Whether `remove()` actually invalidates the credential upstream. `False` changes what the disconnect confirmation must tell the user. |
| `reissues_credential` | Whether `reissue_credential()` can swap a connection's credential for a new one, killing the old, with no re-authorization. `False` means responding to an exposure costs that connection a re-link. Decide it from the provider's documentation on how its credentials are deactivated. |
| `stable_external_id` | Whether re-authorizing returns the **same** `external_id`. `False` means a re-link needs to be told which connection it replaces — see below. |
| `routine_lookback_days` | How far a routine (non-backfill) sync reaches on a cursorless provider. |
| `zero_amount_rows` | Whether $0 rows are kept or refused — see below. **No default.** |
| `currency_scope` | Whether the provider states a currency per `"account"` or per `"transaction"` — see [Currency](#currency). **No default.** |

Most have a default. `zero_amount_rows` and `currency_scope` deliberately do not, because their answers do
not generalize between providers and a wrong inherited guess is silent.

## Where the connection handle comes from

`connect` returns an `external_id`, and `(provider, external_id)` is the unique key a connection is
upserted on. **Where that handle comes from decides what a re-link does**, and it is the trait most likely
to be assumed rather than checked, because the Plaid answer is invisible until a second provider disagrees.

| Source of the handle | `stable_external_id` | What a re-link does |
| --- | --- | --- |
| Issued by the provider **and re-authorizable in place** (Plaid's `item_id`, via Link update mode) | `True` (default) | Upserts onto the existing row — a clean credential refresh. Nothing to ask. |
| Derived from the credential (SimpleFIN hashes the access URL) | `False` | Produces a **new** handle, so the upsert would insert a second row and strand the first. |

**`stable_external_id` is a claim about the app's own re-authorization path, not only about the
provider.** This is the trap it is easiest to fall into, and this repo fell into it: Plaid's `item_id` is
stable across an *update-mode* Link session, but a plain Link session creates a **new Item** with a new
`item_id` and new per-account ids. Declared `True` while the app only ever opened plain Link, the flag was
false in exactly the case it exists for — every "reconnect" produced a second connection, stranded the
first, and left it wearing a `reauth_required` badge that nothing could ever clear, because nothing would
ever sync it again. A provider declaring `True` must therefore implement `create_link_token`'s
`access_token` argument (or an equivalent re-authorize-in-place step); if re-authorizing can only mean
"authorize again", the honest declaration is `False`.

Note also what update mode does *not* do: it issues no new credential, and Plaid's guidance is not to
exchange the public token its callback returns. So the repair path is not a connect — it confirms the
Item answers and records that, which is why `POST /plaid/repair` re-fetches the accounts rather than
trusting the client's success callback. `reauth_required` is retired by **proof** everywhere in this app;
clearing it on a callback would put the badge back at the next sync.

A credential-derived handle is not sloppiness: SimpleFIN's credential *is* a URL, and `external_id` is
stored in the clear and used as the encryption AAD, so the credential cannot also be the public handle.
Any provider whose secret is its identity lands in the same place.

**What is actually stranded is narrower than it looks.** Account mappings survive a second row on their
own — `record_provider_accounts` adopts on `account.external_account_id`, which is unique and durable, and
sync resolves each row to a local account through the same column rather than through the connection. What
is lost is everything keyed to `connection_id`: per-account **coverage** (`coverage_start_date`,
`history_complete`, walk state), the cursor, and sync history. For a metered provider that means a full
history re-walk, which is the expensive part.

So a provider declaring `stable_external_id = False` gets the connect dialog's *"what is this
connecting?"* question, and the answer travels as `adopt_connection_id`, which **re-points the surviving
row** — swapping only `external_id` and `credential_enc` — rather than inserting and migrating. Nothing
keyed to `connection_id` moves, which is why nothing keyed to it is lost.

**The question is asked before the provider call, and that ordering is forced.** A claim or an exchange is
single-use, so by the time the new handle is known the authorization is already spent and there is no
second attempt to act on a different answer. Two consequences for anyone touching this path: the UI must
collect the answer up front, and the server must **absorb** a stale answer rather than refuse it — a named
connection that has since been disconnected, or a handle that turns out to belong to another row, falls
through to the ordinary upsert and reports `adopted: false`. Refusing would be tidier and would cost the
user their token.

## Adding a file importer

A file importer has no class and no handle to manage. What it has instead is a **parse seam**, and
nearly everything that goes wrong when adding a format goes wrong at that seam or in what it hands
downstream.

**The seam.** A format-specific front end produces a `ParsedFile` (`routers/import_export/core.py`) —
the headers, the rows keyed by them, a content hash, and the few things only the front end can know —
and `run_import_parsed` does everything after it, format-agnostic: account resolution, `ColumnMap`,
amount and date parsing, duplicate detection, categorization, the batch/undo contract, the
imported-category workspace. None of that learns what the file was. For CSV the front end is
`parse_csv_text` (`decode → _detect_header_row_index → csv.DictReader`), and the preview and the import
both call it, so the preview reads exactly the rows the import will — a preview that read different rows
would be worse than none, because it is trusted. The second front end is the PayPal statement reader
(`services/paypal_statement.py`), which turns a PDF into rows under fixed column names and so skips the
mapping stage altogether (`routers/import_export/paypal_statement.py`).

**Four CSV assumptions sat in that front end, and a format with no text breaks all four.** They are worth
naming because none of them announces itself — each fails as wrong data rather than as an error — and
`ParsedFile` is where each is answered:

* **The file hash.** It drives re-import recognition and profile matching, so `content_hash` is the
  front end's to define. A CSV hashes its text; a format with none hashes what it parsed, and it must be
  stable across a re-export of the same data, or every re-import looks like a new file. A PayPal
  statement is hashed over its account, period and rows, so the same month downloaded again — a
  different file — is still recognized.
* **Header detection** scans lines, because exports carry preamble rows above the real header. It is
  the CSV front end's own step; any tabular container needs the same over *cell* rows.
* **Downstream parsers expect strings.** The amount and date parsers exist to interpret *human* text, so
  a front end hands them strings (the statement reader keeps amounts as printed). A spreadsheet's floats
  and datetimes are normalized at the boundary rather than teaching each parser a second input type.
* **The file viewer has no analog** for a binary container. `lines` holds the text the viewer shows
  around a bad row; a format with none leaves it empty, and the import then reports the row without
  opening a viewer with nothing in it.

**What else only the front end can know.** Which source the rows come from (`source`) is what its
declarations are read by — see [Zero-amount rows](#zero-amount-rows). Recognizing a source (`source_kind`) is decided where the
file can be seen. A column's evidence role (below) is measured from a CSV, but a front end that cannot
measure it — a month's statement is a handful of rows — declares it (`evidence_roles`). And a row can
belong to another currency without saying so: a PayPal card deposit that paid for a payment in pounds is
itself in dollars, so the front end names it (`currency_refusals`) and it is refused with the payment.

**Source recognition is a header-only sniff.** `sniff_paypal_activity(headers)` tests whether a marker
set is a subset of the file's cleaned header keys — no row inspection, because the header is the stable
part of an export across years. Cleaning matters: `_clean_header_key` strips a leading UTF-8 BOM, which
real exports carry and which otherwise makes the first column of a recognized file unrecognizable.

**Recognition buys two things, and the second is the one to design for.** A recognized file is stamped
with a `source_kind` on its profile, and it gets **forced evidence capture**: `_forced_evidence_headers`
keeps named columns regardless of what the user mapped or ticked. That override exists because those
columns drive behavior the user cannot be expected to anticipate — PayPal's `Type` is what the
money-movement rules read — and a column the user did not think to keep is not recoverable later without
a re-import.

**Capturing a field obliges you to classify it, and misclassifying is silent.** Every captured evidence
field is `descriptive` (free text that *names* the charge) or `categorical` (a small repeated vocabulary,
or a structured datum that describes a row without naming it). Only descriptive fields feed duplicate
text matching. A categorical value admitted as descriptive turns the strong text test back into the weak
one, and two unrelated rows sharing a type or a date match byte-identically at the tier that
auto-confirms on merge. CSV import infers the role from a column's cardinality across the whole file;
anything that cannot measure a file must stamp the role deliberately (a file front end does so through
`ParsedFile.evidence_roles`). See
[`data-model.md`](data-model.md) → *Import batches and profiles*.

**Capture what is helpful.** A captured field is stored on every synced row, and every evidence field
feeds the ledger's search text whatever its role, so a provider field nothing is likely to use is better
left out. Plaid's `merchant_entity_id` was dropped on that basis: an opaque id that appeared on a handful of
rows and was only ever matched by search.

**Where a file importer's declarations go.** With no class to hold a class attribute, a non-adapter
source registers by name in `services/source_capabilities.py` and every consumer reads through one
accessor. [Zero-amount rows](#zero-amount-rows) is the worked example, and it has **no default** for the
same reason there: the answer does not generalize between sources, so a source nobody has thought about
must fail loudly rather than inherit another's.

## Adding a marketplace importer

A **marketplace** source is a shopping venue whose purchases arrive itemized from the venue itself,
while the money already arrived through an ordinary account. It reads like a file importer and is not
one, and the difference is the whole design: a file importer **maps rows onto an account**, adding money
to the ledger. A marketplace importer **adds detail behind money that is already there** — one
transaction per order in a dedicated marketplace account, and then a reach back into the ledger to find
the card charge that paid for it, recategorize it into an excluded category, and link the two so the
basket is itemized without being counted twice.

That inverts the question a file importer asks. The interesting failure is not a misparsed row; it is an
order that lands in the ledger next to the charge that already paid for it, doubling the spend under a
plausible-looking pair of rows.

**The prerequisite is the paying instrument, and it is worth checking before anything else.** The link
only exists because the vendor's export names the card that paid — an order's compound payments string
carries a network and a last-4, which resolves through a user-maintained funding-source map to the
account the charge landed on. A vendor whose export omits it can still create order rows, but nothing
can find their charges, so every order double-counts until the user excludes each one by hand. **Establish
that the export names the instrument before designing anything else**; if it does not, the honest shape
is a different feature, not a thinner version of this one.

Three more questions are specific to this shape, and none is answered elsewhere in this document:

* **What funds an order that moved no cash.** Points and gift-card balances are redeemed at spend time
  with nothing leaving an account, and the export routinely gives no dollar figure for them. Such an
  order is recorded **excluded** rather than as spending — counting it invents money the ledger never
  saw, and dropping it makes reconciliation report an order whose charge was not found.
* **What joins the vendor's files, and whether it survives a re-export.** A vendor typically exports
  orders and items separately, joined on an order id. That id is a *within-vendor* key, not a ledger
  identity — see [Transaction ids](#transaction-ids-must-be-globally-unique) for why it is not one. The
  key that has to be stable is the **content hash** of each file, since that is what makes a re-import
  recognize itself rather than land as a second copy.
* **Refunds and returns.** A partly refunded order is one net figure against one charge; a separately
  refunded one is a second ledger row the reconciliation has to not mistake for a duplicate.

**What still binds, from the rest of this page.** A marketplace source states a zero-amount policy like
any other, registered by name in `_NON_ADAPTER_SOURCE_POLICY` rather than as a class attribute, since it
is a code path with no class to hold one — and with no default, for the reason given under
[Zero-amount rows](#zero-amount-rows). Per-item detail folded into an order row's evidence is subject to
the same [descriptive-vs-categorical](#adding-a-file-importer) classification, and misclassifying it is
just as silent. Refusals report through the same writers as everything else, so
[Reporting what was refused](#reporting-what-was-refused) applies unchanged.

**What does not bind is the CSV parse seam.** Export formats differ per vendor with nothing in common to
dispatch on, so the parser is bespoke rather than a format registered behind the seam that
[Adding a file importer](#adding-a-file-importer) describes. Keep the vendor's own front end thin over a
reusable `rows → orders` core, so a later paste path or combined-file export is another front end rather
than a second parser.

The five pieces a new vendor needs, in build order — the account-type marker, the parser and its
client-side sniff, the shared `txn_link` ledger substrate, the dedicated import UI, and the
funding-source map — are in [`architecture.md`](architecture.md) → *Marketplace accounts — the extension
pattern*, which is the implementation contract; this section is the design questions to settle first.

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
depends on what a $0 row *means* from that source, and the five current sources answer for three different
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
| PayPal statement | `reject` | A closed month's finished record that nothing revises; a $0 line in it moved no money — an authorization or a hold. |
| Amazon | `keep` | A $0 order is a finished record; reconciliation would otherwise read it as an order whose charge was not found. |

Adapters declare `zero_amount_rows` as a class attribute. **Sources that are code paths rather than
adapter classes** — the CSV importer, the PayPal statement importer, the Amazon importer — have nowhere
to put an attribute, so they are
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

* Date the row by when the charge was made (`transacted_at`) and **fall back** to the other date the
  source publishes (`posted`) rather than to nothing; carry the posting as `posted_date`, absent while the
  charge is pending. See `docs/data-model.md` → `date` for why the transaction date is the ledger's.
* Never synthesize a date from the import time or a window bound. A fabricated date is indistinguishable
  from a real one; a dropped row is at least honest, and a row with no usable date anywhere is dropped.
* Where the settled version of a row can arrive later, the sync must **re-stamp** the provider-owned
  fields, `posted_date` among them, not merely clear the pending flag — see `_refresh_provider_fields` in
  `routers/sync.py`. A field written from a
  provisional version of a row is provisional until the row is superseded.

The corresponding trap on the fixture side is that a simulator is written from what a source *documents*.
The captured demo data and the first version of `_simplefin_sim.py` gave every pending row a real posting
timestamp, so the entire class was invisible to a test suite that otherwise covered pending rows well.

## Currency

The ledger holds **one** currency at a time and `txn.amount` stores no denomination beside it, so two
denominations saved together are indistinguishable and both join every total. There is nothing to convert
from and no rate source to convert with.

An adapter receives the ledger currency as the `ledger_currency` argument to `fetch_transactions_sync` and
must **drop** rows denominated in anything else, reporting them so the user is told rather than left
with silently wrong arithmetic. An account whose rows were discarded must also be kept out of coverage —
claiming a range for an account whose transactions were thrown away produces the over-claim that makes
duplicate detection reject genuine rows later.

**Declare what the provider states a currency on** (`currency_scope`), because it decides what dropping
means. A provider that names a currency per account (SimpleFIN) drops a mismatched account whole: it can
never fill, so the user is warned from its recorded currency on every sync. A provider that names one per
transaction (Plaid) drops only the mismatched rows while the account goes on filling, so the account-level
warning is false there — one foreign subscription in a dollar wallet read as "held in GBP, so its
transactions were not imported". Its notice names the rows instead, and only on a pull that dropped some.

**A file importer has no adapter to declare this on, and a file is per-row by nature.** The CSV mapper
takes an optional currency column; a row it names in another currency is refused and listed with the
import's rejected rows, and an unmapped column means the whole file is in the ledger's currency. A new
file importer whose format can mix currencies should do the same rather than import at face value.

## The published guide is not the contract

**A provider's conformance checklist is a design input, and the items worth the reading are the ones the
protocol does not force.** Where a provider publishes one — SimpleFIN does, on its protocol page — read it
*before* writing the adapter. Most of its items are satisfied by any client that works at all, because the
protocol will not function otherwise. The rest are about the **user's security posture**, which reasoning
from the request and response shapes never reaches, and which is therefore the half that gets missed.
Three kinds to look for, all of them present in SimpleFIN's list:

* **What a failed claim on a single-use credential means.** The reassuring reading ("generate a new one")
  and the alarming one (someone else spent it) rest on identical evidence, and only the alarming one is
  safe to act on.
* **Which refusals are conditions of their own** rather than an outage — a 403 on a data call says
  something a 500 does not, and collapsing the two loses it.
* **What provider-supplied text may do when displayed.** Framework escaping covers injection, so the live
  risk is usually **volume** rather than markup, and the bound belongs at the adapter boundary rather than
  at each consumer.

Deviating from an item is allowed; deviating silently is not. `architecture.md` → *Provider connections
(the aggregator seam)* records the one deliberate deviation here and the reason for it.

**Where a live call and the provider's documentation disagree, the call is right.** Two of SimpleFIN's
load-bearing facts appear nowhere in its developer guide, and both were invisible to a suite that mocks
the HTTP layer:

* **The usable history window was narrower than the documented one.** The guide states 90 days; a 90-day
  request comes back with a deprecation notice warning that it "may be capped" later, while the width the
  server actually recommends is 45. A declaration like `max_history_days` is a claim about the *server*,
  so it is worth one real call to fill in — a value copied from a guide is a guess wearing a constant's
  clothing, and it fails as silently missing history rather than as an error.
* **The transport in front of a provider is part of the provider.** The Bridge sits behind a CDN that
  refuses unnamed HTTP clients: urllib's default user agent draws a bare `403 error code: 1010` with
  nothing in the body naming the cause. The same layer is what answers a burst with `429 error code:
  1015` (see below), so a CDN in the path is worth establishing early — it adds failure modes that belong
  to neither the protocol nor the app.

The general form is that an adapter's **transport** is a subject in its own right, not an implementation
detail of the mapping. `CONTRIBUTING.md` → *What is tested, what isn't, and why* draws the testing
consequence: a window cap, a sign convention, a pacing rule and a budget are all properties of what was
*sent*, so at least one test has to inspect the wire rather than the normalized return value.

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

**Check for a second limit on *rate*.** A published "N per day" bounds how many requests are made; it says
nothing about how fast, and a provider fronted by a CDN usually enforces both. SimpleFIN's answers a burst
with `429 error code: 1015` — Cloudflare, the same layer that rejects unnamed user agents — while the
request count is still comfortably inside the daily allowance. So a metered adapter needs a **minimum
interval between requests** as well as a budget, paced process-wide rather than per connection (the limiter
keys on the caller, so two connections syncing at once are one client to it).

Being rate-limited is **not a failure**: it is neither the user's to fix nor a reason to stop. Treat it as a
pause — keep what arrived, report `resume_later`, and suppress `has_more` so the caller does not come
straight back into another refusal. Note that this is a different shape from running out of the daily
allowance, which blocks one account while its siblings carry on; a rate limit blocks the whole client.

**Report the two pauses under different names, and report the level, not just the effect.** `resume_later`
says a pull stopped; it cannot say which limit stopped it, and the two are opposite findings. Declining to
ask because the local bucket is empty means the accounting worked; being refused a request means the
provider's count and this app's disagree, which is a bug with a real penalty behind it. Distinguish them on
`update_status` (`BUDGET_PAUSED` vs `RATE_LIMITED`).

**If an adapter keeps more than one pool, the rule choosing between them is worth stating where a reader
will look for it, because the choice is not the one they will guess.** SimpleFIN keeps a shared allowance
plus one per account, and picks by the size of the *still-walking set* alone — a small set makes one
filtered request per account and spends their own pools, a large one makes a single unfiltered request and
spends the shared pool. It is deliberately **not** keyed on initial-vs-routine, which is the intuitive
reading and the wrong one: a credential with only a few accounts filters throughout its first backfill,
leaving the shared allowance untouched and available for the top-ups that keep the ledger current. That is
correct behaviour and looks like a bug in the log — the same pull that spends dozens of per-account
requests reports its shared bucket as full. Filtering buys no extra depth (every pool is the same size);
it trades round trips for keeping the shared allowance free. State the trade, or the log's own numbers will
be read as evidence against it.

Then report the allowance itself, via the optional `request_allowance` field on the page dict
(`{capacity, refill_per_hour, pools:{pool key: tokens left}}`). This is easy to skip and the omission is
invisible until someone has to diagnose a stuck connection: the budget lives in a column the next sync
overwrites, so without a per-call snapshot the log names a cause nobody can check and cannot say when the
pull could resume. **A resource that empties and refills has to have its level recorded wherever its
effects are recorded** — the same reasoning applies to any per-account position, which is why the sync log
also keeps each account's reach per call rather than trusting the live coverage columns. For the same
reason, charge attribution belongs on each requested window (`pool`): a bare request count cannot be
reconciled against any one allowance when a walk spends several.

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

## What a failure says

**An adapter's exception text is shown to the user unedited** — in the connect error box, on the connection
card, and in the Sync log, which records every connect, reconnect, account refresh and disconnect as well as
each sync (`services/connection_log.py`). So an adapter raises errors whose message is a sentence about what
went wrong: SimpleFIN's `SimpleFinError`, and Plaid's `PlaidError`, which `plaid_service` builds from
Plaid's error body rather than letting the client library's status line and header dump through. Where the
fix is a step in this app, the message names it (a rejected app secret points at Configure). The original is
not thrown away: an exception's `provider_detail` (Plaid's error fields, request id included) is what the
Sync log keeps under a row's Details, read from the exception or any it was raised from.

**`ProviderCredentialRejected` is for a refusal the reconnect button can repair**, because it sets
`reauth_required` and the card then offers exactly that. SimpleFIN raises it for a refused access URL, which
a new setup token replaces. Plaid raises it only for `ITEM_LOGIN_REQUIRED`: Link's update mode needs a
working token to start from, so an invalid or removed token would send the user into a reconnect that
fails, and a rejected *app* secret is not the connection's to fix at all.

## Where requests may go

**An adapter sends requests only to its provider's own servers, named in a fixed list.** Any part of a
request address that arrives from outside — a setup token the user pastes, an access URL a claim returns, a
credential read back out of the vault — could otherwise aim the server's own request anywhere, including an
address on the private network, and an error message that quotes the reply turns that into a way to read
it. SimpleFIN keeps its list in `SIMPLEFIN_BRIDGE_HOSTS` (the real-account Bridge and the demo one) and
checks it at three points: before a claim is sent, before a returned access URL is stored, and inside
`_http`, which every request passes through, so a future call that forgets its own check still cannot reach
another host. The list is the place to extend if SimpleFIN moves or adds a server.

**Redirects are refused, not followed.** A followed redirect carries the `Authorization` header to an address
no check has seen; `_RefuseRedirects` reports it as the HTTP error it is.

**With the destination fixed, quoting a failed response back is safe, and it is kept.** Stripping the reply
text was the other half of the original finding, but its danger was reading from an arbitrary host, which the
list removes — while the text itself has been the only evidence of a cause (the CDN's `error code: 1010`).

A provider whose addresses come only from its SDK's own environment settings, as Plaid's do, takes no
address from outside and needs no list.

## Considered and rejected

- **A `read_only` capability declaration**, alongside the others, so a source could state what its
  credential reaches. There is nothing to state: what a credential is authorized for is the provider's
  to define and is not visible from here, and the passphrase floor is unconditional precisely because
  the reach is unknowable — every credential is already protected as though it carried full account and
  identity access. A declaration would therefore gate nothing, and asking an adapter author to
  investigate the scope produces a finding that changes no code path.
  See [`security-model.md`](security-model.md) → *Why provider credentials are the only things encrypted*.
- **Per-item rows for a marketplace order** — one ledger row per line item instead of one per order.
  Tried and abandoned; it brings a visible parent/child hierarchy, a double-count risk, and tree
  handling in editing, undo and import, to solve what is really a reporting problem. An order that spans
  categories is one row with `txn_split` allocations instead.
  See [`data-model.md`](data-model.md) → *Transaction links and Amazon order import*.
- **A vendor-neutral marketplace abstraction before a second vendor exists.** The order engine's names
  are deliberately still the first vendor's. Generalizing from one instance guesses at the shape; the
  second vendor is what reveals which parts were the pattern and which were that vendor's export.
- **Per-account scoping of the `external_transaction_id` lookups**, as the fix for a provider whose ids
  are unique only within an account. That trades a ledger invariant for one provider's convenience.
  Namespace at the adapter boundary, which is the layer that knows.

## Obstacles

- **A marketplace vendor whose export does not name the paying instrument cannot be linked at all**, only
  created — which makes every order double-count. No amount of matching effort recovers it, because
  amount and date alone match coincidental charges on any account. The check belongs before the design,
  not after the parser.
- **The connect question for a provider with an unstable handle must be asked before the provider call**,
  because a claim or exchange is single-use. By the time the new handle is known the authorization is
  spent, so the server has to absorb a stale answer rather than refuse it.
  See [Where the connection handle comes from](#where-the-connection-handle-comes-from).
- **A provider's list of environments is the provider's, and it changes without telling anyone.** The
  offered set, the accepted set, and the set the client library can actually reach are three separate
  places, and nothing fails when they disagree: an environment map keyed by name resolves an unknown one
  through its default, so a withdrawn environment stays selectable, stores cleanly, badges as a distinct
  mode, and silently points every call at whichever environment the default happens to be — which is the
  test one, because that is the safe default for the case this is not. The adapter's own map cannot be
  what decides — it is per-provider and knows only its own names. The shared config layer owns both which
  names are offered and what a retired one now means, and resolves it on read
  (`providers/config.py` → `VALID_ENVS`, `RETIRED_ENVS`), so the adapter's default is left as the
  fail-toward-test backstop it should be rather than the thing quietly answering the question.

## Open

Decisions owed on this topic, each naming the live backlog item that will feed it.

- **New *file* ingestion formats: XLSX, then the OFX/QFX/QBO family.** The parse seam they waited on is
  extracted (`ParsedFile`). XLSX reuses the whole downstream unchanged; the OFX family additionally needs
  a `FITID` rung in duplicate detection, and follows the PayPal statement import as its mapping-free path.
  → [`backlog/import-input-formats.md`](backlog/import-input-formats.md)
- **OFX Direct Connect as a provider adapter** — a pull with no aggregator in the middle. Researched and
  parked on institution coverage. It would declare `revokes_on_disconnect = False` with no provider-side
  remove call to build one from, so what disconnect does and does not do is a disclosure question to
  settle before an adapter is written.
  → [`backlog/ofx-direct-connect.md`](backlog/ofx-direct-connect.md)
- **Whether a SimpleFIN *server* other than the Bridge may be connected.** The protocol defines many
  independent servers and several third-party aggregators expose one, while the host allowlist above is
  fixed to the Bridge's two hosts and every other per-server fact — window width, budget shape, pacing key,
  account-id namespace, zero-amount policy — sits in a module constant no subclass can reach. The direction
  is a **server profile** holding those values, with an unprofiled server taking conservative ones; what is
  owed is the values themselves and what a connection walked on guesses should disclose.
  → [`backlog/provider-candidates.md`](backlog/provider-candidates.md)
