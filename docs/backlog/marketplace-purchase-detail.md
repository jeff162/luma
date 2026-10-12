# Marketplace purchase detail — eBay, and a shared review surface

**Design, not started (2026-09-16).** Nothing eBay-specific is built; the shared review shell this design
called for exists, with Amazon and the PayPal reconciliation as its vendors (see *The review surface*).
The four product decisions the first draft left open were settled the same day and are written into the
sections they affect; what is still open is under [Open](#open) at the end.

The feature: import a marketplace's purchase history and **add the item detail to the card charge that
already paid for it**, so a charge reading only "eBay" says what was bought and is found by searching for
it. Purchases that cannot be paired with a charge automatically are put in front of the user to decide.
eBay is the first vendor; the review surface is built to be shared by any marketplace, Amazon included.

## Why this is not the Amazon model

Amazon import creates one transaction per order in a marketplace account, then finds the card charge,
moves it into an excluded category and links the two. `building-a-connector.md` → *Adding a marketplace
importer* makes one prerequisite for that shape: the export has to name the paying card, because that is
what lets the charge be found. It also says that where the export does not, "the honest shape is a
different feature". eBay's purchase history is that case. It lacks three things the Amazon matcher relies
on:

- **No payment instrument.** Nothing identifies the card or account that paid.
- **No order number.** Card descriptors carry eBay's order number (`eBay O*NN-NNNNN-NNNNN`), but the
  export carries only the listing's item id, so there is no key to join on.
- **No sales tax.** The charge is item total + shipping + tax, so amounts never agree exactly.

An order row per purchase would therefore sit beside its charge, counted twice, until someone excluded
each one by hand. Adding detail to the existing charge creates no money, so it cannot double-count
anything — which is also why none of the Amazon model's exclusion machinery (the marketplace account
type, the funding category, the funding-source map) is needed.

## The export

eBay's account-data download is a folder of static HTML reports, each a single table: `purchaseHistory`,
`sellingHistory`, `returnsAndRefunds`, plus feedback, bidding, listings, disputes, reviews and an
`index.html` linking them. The purchase history has one row per item:

| column | notes |
| --- | --- |
| Purchase Date | `Mon DD, YYYY HH:MM AM` — minute precision, no time zone stated |
| Item Id | the listing, not the order; the same listing bought twice repeats it |
| Listing Title | the seller's title, often keyword-stuffed |
| Individual Price, Quantity, Total Price | `Total Price` = price × quantity, **excluding** shipping |
| Transaction Shipping Fee | separate from `Total Price` |
| Currency | per row; a download can mix currencies |
| Seller Name | the seller's user id |

**Observed on one real download, which is all the evidence so far:** it covered roughly nine years, so
the download appears to be cumulative rather than windowed; every row had its own timestamp (no two items
shared a checkout); one row was in a foreign currency.

## Shape

### Purchase records are stored, not just applied

A purchase has to outlive the import that brought it. The charge may not have arrived yet (a file
imported before the card syncs), the user may resolve it days later, and undo has to know exactly what
was written. So each purchase becomes a row in a new vendor-neutral table — working name
`marketplace_purchase`:

- vendor, `import_batch_id`, the vendor's row identity (below), purchase timestamp, title, seller,
  quantity, item total, shipping, currency;
- `charge_txn_id` (nullable) and a **state**: *pending* (no charge yet), *matched*, or *no charge* (the
  user said it was not paid from a tracked account);
- how it was matched (*auto* or *user*), and the **enrichment delta** that was written, so it can be
  removed verbatim.

**Row identity, because the download is cumulative.** The batch's file content hash recognizes a
re-upload of the *same* file, but a later download is a different file holding every earlier purchase
again. Without a row identity every re-download would add each old purchase a second time. The item id
alone is not unique (the same listing bought twice); item id + purchase timestamp is the candidate key,
and a purchase already on record is skipped rather than re-imported.

It is a table of its own rather than a `txn_link` because a purchase is not a transaction:
`txn_link` joins ledger rows, and nothing here adds one. Amazon's parked items (`amazon_pending_item`)
have a similar lifecycle and could move onto this table later; that is not part of this work.

What a new table brings with it: the baseline `CREATE` plus a registered migration; a backup section and
a payload-version bump (the backup test's `sqlite_master` table list catches an omission); and a
`recon_epoch` trigger, since the review's attention count reads it (see below).

### Matching

**Candidates** are ledger charges whose name, raw name or captured source text looks like the vendor
(for eBay, `ebay`), on any account — the export names no account to narrow by. That includes wallet
accounts, where a charge can carry the vendor's name.

**The amount band.** A charge is a candidate when it lies between the purchase's `total + shipping` and
that figure plus a tax allowance. **The date window** runs from a day before the purchase to a few days
after, since a charge posts after the purchase and the export's timestamp has no stated time zone. The
starting values should be measured rather than chosen; the one real download below is the measurement so
far.

**Assignment, not per-purchase lookup.** Two purchases on the same day routinely both fit both charges.
Deciding each purchase separately would either give up on both or pick arbitrarily, so candidates are
resolved as a bipartite assignment over each cluster. `_perfect_matching` in `amazon.py` already does
this for equal-amount orders; it finds *an* assignment, so it needs a uniqueness check added — only a
**unique** assignment is applied automatically.

**Ranking what is left.** Where the assignment is not unique, the candidate whose implied tax rate
(`(charge − total − shipping) / total`) agrees with the rate the user's other matched purchases imply is
offered as a **suggestion**, never applied. On the real download the implied rate clustered tightly
around a single value, and in both same-day pairs exactly one assignment agreed with it. Tax on the item
but not on shipping also occurred, so the rate is computed against the item total.

**Foreign currency** goes straight to *no charge found*, with the currency stated: the charged amount
cannot be derived from the export.

**Measured against a copy of a real ledger** (one download, one household): of the purchases dated after
the earliest eBay-looking charge on any account, about four in five matched uniquely by band and window
alone. The remainder were two same-day pairs (resolved by the tax-rate check above), three charges
imported twice by two sources (a ledger problem the review has to show plainly, not a matching problem),
and one purchase with no candidate. Purchases older than any eBay-looking charge had nothing to match,
which the review has to handle without burying the rest.

### What applying a match writes

Three things, in this order, each recorded on the purchase row so it can be reversed exactly.

**1. Evidence.** Through `services/import_enrichment.py`, the existing additive and reversible
enrichment engine: title (with quantity when above one), seller and item id are appended to the charge's
`import_evidence_json` `extra_text_fields`. The ledger search, the origin hover and `match_source_text`
rules already read that surface. The delta is stored and removed verbatim on undo or unmatch.

**2. The name becomes `eBay: <item title>`.** The item has to be readable on the row itself, not only on
hover. The prefix is the vendor's label rather than whatever the charge was called (`EBAY O*…`, `eBay`),
so every enriched charge reads the same way. The name is stamped `display_name_source = 'enrichment'`, a
value `data-model.md` already defines but which nothing writes today. The prior name and source are
stored.

- **A `manual` name is left alone.** A deliberate rename wins, as it does everywhere; the evidence is
  still added.
- **An `enrichment` name needs the same protection from automatic passes as `manual` has.** The
  categorizer's rename guard (`display_name_source != "manual"` in `recategorize_all`, mirrored in
  `preview_recategorize_count` so the preview agrees with the run) would otherwise let any rule with a `clean_name` that matches —
  including one that tidies `EBAY O*` into `eBay` — put the old name back on the next Categorize run.
  This mirrors the category contract, where `category_source = 'enrichment'` is already feature-owned and
  skipped by automatic passes. As with `manual`, the explicit full-force rule apply may still overwrite
  it. Nothing writes an `enrichment` name today, so widening the guard changes no existing row.
- **Consequences of the name changing.** Rules match against the display name as well as the merchant
  and raw names, so the item title becomes matchable text; that is what step 3 relies on. Recurring
  detection and Generate rules both group by the displayed name, so enriched eBay charges stop grouping
  together as "eBay". Neither treats one-off marketplace purchases as a pattern worth finding, so that is
  the right result rather than a loss.

**3. Categorize, only if the charge is uncategorized.** Once the name carries the item, the charge is
run through the rule set once. A matching rule sets the category and its tags exactly as an automatic
pass would, and the rename half is skipped by the protection above. A charge that already has a category
— from any source — is not touched, and neither is one with `category_overridden` set. Nothing matching
leaves it uncategorized, for the user to categorize once the description says what it was. A broad
keyword rule can match an item title (a title naming a brand the user has a rule for); which rule wins is
the ordinary rule ranking, not something this feature adds a policy for. The prior category, source and
tags are stored.

### When matching runs

At import, over the new purchases. After that, **pending** purchases are retried when later ledger rows
could satisfy them — at the end of an import or a sync — which is cheap because the pending set is small
and window-bounded. Matching is never run from a report `GET`, since applying a match is a write.

### Undo

Undoing the import batch, or unmatching one purchase in the review, reverses the three writes in the
opposite order, and deletes the purchase rows on undo. It hooks into the existing batch-undo paths beside
`reverse_batch_enrichments` and `reverse_batch_amazon_links`.

**A reversal restores only what is still the feature's.** The name goes back only while the row still
carries the enriched name with source `enrichment`; the category only while it is still the one step 3
set, with source `rule`. A rename or recategorization the user made since is kept — undoing an import
must not undo the user's own edits. The evidence delta is removed regardless, since nothing else writes
those exact fields.

## The review surface

### What already exists and is already shared

- **`MatchReport`** — the "record ↔ matched record" table, windowed, with controlled sort and selection.
  Both the duplicate report and the reconciliation reports render through it.
- **The reconciliation shell** — `ReconciliationReportDialog` with its viewer, `ReconciliationViewerContext`
  (one viewer parameterized by vendor): the floating panel, the filter pills per bucket, the kind column,
  the intersection bulk bar and the charge picker (`ChargePickerDialog` — candidates sorted by date
  proximity, single- or multi-select, a running sum against the record's amount that warns without
  blocking). A vendor supplies its buckets, columns and the call behind each action; Amazon and the PayPal
  pairing review are its vendors (`components/importExport/reconciliation/`).
- **The attention cache** — `services/reconciliation_attention.py`: a per-batch count cached on the batch
  and a whole-ledger count cached in `db_meta`, both invalidated by the `recon_epoch` triggers.
- **`MarketplaceImportHistory`** — the per-vendor import card, with a registry for a vendor's own per-file
  action pill.
- **`reconciliation_attention_count`** — the cached per-batch attention count behind the file card's
  tint and the Tasks nag, invalidated by the `recon_epoch` triggers.

### What eBay still adds to the shared pieces

- **Backend.** A report endpoint returning its buckets, an attention compute function handed to the shared
  cache, and its own Tasks entry and file-card annotation, as Amazon and PayPal each have.
- **The charge picker's comparison** is an exact total today (Amazon). eBay's is the tax band: the
  comparison becomes per vendor, still warning rather than blocking.

**Split offers are a per-vendor capability.** eBay charges one item per charge, so its config offers no
split. A vendor whose orders routinely hold several items — Amazon today, and a Target- or Walmart-style
vendor later — renders the split action in its own columns, as Amazon's config does.

### eBay's buckets

| bucket | what it holds | actions | attention? |
| --- | --- | --- | --- |
| Matched | applied automatically or by the user | Unmatch | no |
| Suggested | one best candidate, not applied | Accept, Reject | yes |
| Several possible matches | several candidates, none preferred | Pick charge… | yes |
| No charge found | no candidate, or a foreign currency | Pick charge…, Mark reviewed | until reviewed |
| Charges with no purchase | vendor-looking charges no purchase accounts for (reverse scan) | Mark reviewed | until reviewed |

**A rejected suggestion stays rejected.** The rejected purchase ↔ charge pair is persisted, so the same
pair is never offered again, the way Amazon's *Not duplicates* assertion works.

**Double-imported charges** show up as *several possible matches* with two identical candidates on different
accounts. The review says so rather than making the user guess which one to pick, but it does not
resolve the duplicate itself: which copy is wrong is a ledger question.

## Where it lives on the Import page

A vendor is a data source rather than a tab (`ui-patterns.md` → *Marketplace accounts get their own
import form*): eBay gets a **row in the File Import tab's data-source list**, beside Amazon's, carrying its
"how to get the export" help; its files are dropped on the ordinary drop zone; and its imports land on
their cards in the Import History. eBay needs no setup, so it may need no form at all where Amazon has
one, and the list of rows is the list of supported vendors. That also means an eBay row would have no marketplace
account type — the account-type marker in `architecture.md`'s five-piece pattern is Amazon-model only,
and the pattern's description needs saying so once a vendor exists without it.

**Drop routing extends to HTML.** The main import page already sniffs an AZAD CSV header and hands the
file to the Amazon import form. eBay files are recognized by the report title in the HTML (`Purchase History`,
`Returns and Refunds`), and dropping the whole download folder picks out the reports the importer reads
and ignores the rest.

## Returns, refunds and selling

- **Returns and refunds — second phase.** A refund arrives as a credit on the card, and the report gives
  the refunded amount, so the same enrichment can label the credit. Its table nests a refund sub-table
  per return, so it needs its own parser pass.
- **Selling history — not planned.** eBay pays sellers in batched payouts with fees already deducted,
  and the report lists neither fees nor payouts, so a sale has nothing reliable to be matched against. A
  seller would get a list, not a reconciliation.

## Considered and rejected

- **Amazon's order-row model for eBay** — see above; without the paying instrument every order
  double-counts until excluded by hand.
- **Matching on the order number** — the descriptor carries it; the export does not.
- **A configurable, no-code vendor definition** — the matching semantics differ per vendor (order rows
  and exclusion for Amazon, enrichment for eBay; totals exact for one, tax-banded for the other), so a
  configuration would be a second programming language. The generic CSV mapper remains the no-code path.
- **The item title in evidence only** — searchable and on hover, but a charge still reads "eBay" in the
  ledger, which is the problem the feature exists to fix.
- **The item title in the notes** — notes are the user's own field, and nothing automatic writes them.
- **A separate detail line on enriched ledger rows** — a ledger layout change for one feature, where the
  display name already is the row's readable description.
- **A split offer for eBay** — one item per charge; see *Split offers are a per-vendor capability*.

## Open

Nothing product-level. The band and window starting values are fixed at build time from the
measurement above, not chosen.
