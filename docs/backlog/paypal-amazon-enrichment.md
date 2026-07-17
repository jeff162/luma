# Enriching existing transactions on import — and why PayPal needs no special source

> **Status: active working design. Started 2026-07-04.** This began as "special import support for
> PayPal/Amazon" and, through several design passes, collapsed to something much smaller and more
> general. The record below is the *destination*, with a short history of what was explored and dropped
> so the reasoning isn't lost. The design of record: **PayPal is an ordinary import; the one genuinely
> new capability is a general feature — enrich an existing transaction with a later import's novel
> detail.** Amazon has since taken its own design pass — the **account + link model** (2026-07-05) —
> which *reuses* the enrich/dedup match machinery but goes beyond it: Amazon item rows become first-class
> transactions in an Amazon account, and a new, general **transaction-link** primitive ties the
> funding card charge to them. See the Amazon section.

## The core realization: PayPal is an account, not a special source

A PayPal Activity CSV is just a bank/card CSV for a wallet-style account. Each purchase is a spend on
the PayPal account (the counterparty is the merchant, straight from the `Name` column); each funding
leg is a transfer from a bank/card into it. That is exactly what a credit card is, with the funding
batched per-transaction instead of monthly. So the existing import already handles it:

- **Columns** map normally (`Name`→merchant, `Amount` with a sign convention, date, etc.).
- **Account** is picked or created on the import screen (a CSV with no account column is the existing
  single-account case — you pick/add the account it maps to).
- **Re-import overlap** is the existing duplicate detection (coverage window + content hash).
- **Save as a profile** for next time is the existing data-source mechanism.
- **One profile per PayPal account.** The earlier worry — "reuse one source across accounts" — dissolves:
  make a profile per account; if the user maps or categorizes them differently, we don't care.
- **Transfers** (the funding legs, and the `PAYPAL` charge that lands on the card) are categorized to an
  `exclude_from_totals` category the same way *every* transfer already is — by the user's own rules.

**We deliberately do not build:** money-movement auto-identification, a transaction-type/transfer model,
a `kind` system-source, an owner+account pairing screen, or a reconciliation report. The transfer/
transaction-type modeling was considered and rejected — it reopens a settled decision (`data-model.md`:
`exclude_from_totals` is a category property, formal two-sided transfer pairing is deferred) and surfaces
nothing about spending patterns. Money-movement identification was considered and dropped — the user
categorizes those rows with normal rules; a fuzzy auto-classifier isn't worth the special-casing.

**When *would* a special source have been worth it?** If the primary flow were aggregator users who need
silent enrich-and-merge at scale, or if a guided no-mapping experience were itself the product. Neither
is the case here, so: ordinary import.

## The one new capability: enrich an existing transaction on import (general)

Today a duplicate is only ever *rejected or flagged* — the incoming row's detail is discarded. But a
later import from a richer source often carries detail the stored row lacks (a memo, a cleaner merchant,
a counterparty). The feature: **when an import matches a transaction already in the ledger, fold the
*novel* part of the incoming detail into that row.** General — credit-card CSVs, PayPal, any source.

This is where the earlier "enrich on overlap" idea belongs: at the **dedup layer**, reusing what exists
(`import_evidence_json` + the Origin hover; the duplicate-resolution screen; the match `evaluate_duplicate`
already computes). It is *not* PayPal-specific. (Shipped; 2026-07-16 added a batch-scoped **"Enrich
existing transactions from this source"** toggle on the file card — retroactive fold at any time, exact
undo on untoggle — alongside the per-profile auto-enrich flag and the per-row report actions. Rejected
rows keep their full incoming detail forever, so enriching late loses nothing.)

**Design guardrails:**

- **Additive / gap-filling only.** Add novel detail to `import_evidence_json`; never overwrite a value
  already present, and never a `manual` name or category. This sidesteps any "which source is better"
  ranking — you only ever fill blanks — and makes `display_name_source` (below) the guard that protects a
  deliberate rename.
- **The delta is computed against what the row already holds** (its names + existing evidence), so
  nothing identical is re-copied. (This is the one reusable idea extracted from the reverted reconciler
  work: a `_enrichment_delta`-style merge.)
- **Lands in `import_evidence_json`** — the existing source-record surface; `match_source_text` rules can
  already categorize on it, the Origin hover already renders it.

**Two mechanisms, built in order:**

1. **Manual action on the duplicate-resolution screen** (`UnifiedDuplicatesDialog`): a per-row + bulk
   "Enrich stored transaction with this import's detail," reusing the existing bulk-edit pattern. The
   always-available, user-judged baseline; no new source semantics.
2. **A per-source flag** = automation of (1) for trusted sources. When set, that source's matched
   duplicates enrich **automatically during import, silently but reported** ("N transactions enriched" in
   the import result). The duplicate report stays available to review/undo/change anything. Wording is
   behavior-named to avoid confusion with "trust these categories" / dedup toggles:
   > ☐ **Enrich existing transactions from this source** — *When an import from this source matches a
   > transaction already in your ledger, add any extra detail it carries (memos, counterparty names) to
   > that transaction. Turn on for sources whose detail is richer than your other imports.*

**Reporting & undo:** extend the existing duplicate record (`import_batch_duplicate`) with an "enriched"
outcome + the applied delta — it shows in the report and reverses on undo. No new table.

## `display_name_source` — landed, and the guard this feature needs

The display-name analog of `category_source` (`manual | rule | import | enrichment`, NULL = legacy):
provenance for `display_name` so an automatic rename can be attributed, and — the point — a **manual
rename is protected**: rules and enrichment never overwrite `'manual'`. Threaded through every rename
writer (manual single/bulk, `rule_scalar_effects`, import/sync inserts), with `recategorize_all` now
sparing a manual name just as it already spares a manual category. Because `txn` stores no per-row
rule_id, a migration backfill re-derives provenance (currently-matching rule's `clean_name` == the name
→ `'rule'`; else name differs from `merchant_name`/`raw_name` → `'manual'`; else `'import'`). See
`data-model.md`. Migration 6. This is general and independent of everything above — and it is exactly the
manual-guard the enrich-on-duplicate feature relies on.

## Amazon — the account + link model (design pass 2026-07-05)

> **Superseded 2026-07-10 by the orders-only model (see that section below).** This section's
> *itemization* — one transaction **per item**, Amazon's category taxonomy, net-cash allocation across
> items, and the two-file *pairing* it required (items-only staging / "awaiting a pair") — was dropped.
> The realization: the **orders** file already carries the concatenated item descriptions, so the
> **items** file's only unique substantive content is Amazon's category taxonomy plus product-reference
> metadata (ASIN / URL / list price) — and the user does not want to categorize by Amazon's taxonomy. So
> the whole itemization apparatus served a feature that isn't wanted. **What still stands from this
> section:** Amazon orders become spending transactions in an Amazon *account*, the matching card charge
> is recategorized into an excluded category and **linked** (the `txn_link` primitive), and the account
> semantics. **What changed:** one transaction **per order** (not per item), the item detail rides in
> *evidence* (not rows), and the items file is *optional enrichment* of an existing order row. Read the
> orders-only section for the current design; this section is kept for the reasoning history.

**What changed, and why enrich-only wasn't enough.** The earlier sketch (kept as history at the end of
this section) made Amazon a pure client of the enrich-on-duplicate feature: match each order-charge
`(card last-4, date, amount)` to the card row and fold item text into `import_evidence_json`. That is
correct for *drill-down* ("what was in this charge?") but it cannot deliver the two things that turned out
to be the actual point of importing Amazon: **per-item categorization** and **dashboard visualization of
what was bought.** The export data shows why — in 2024, ~11% of orders (4/35) span more than one top-level
category, so a single category on the one card row is simply wrong for those; and a flat evidence blob
can't be summed, so "Amazon spend by category" is impossible without structured, queryable per-item
records. Enrich-only remains the right model for sources that *only* add descriptive text; Amazon needs
more. (Data correction to the old sketch: an order does **not** fan out into several card charges — in the
whole export every order maps to a *single* charge; the many-to-one that occurs is several *orders* on the
same day, which the amount disambiguates.)

**The model: Amazon item rows become transactions in an Amazon account; the card charge is excluded and
linked.** This is the PayPal "it's an account" reframe applied to Amazon, plus an explicit link. Note an
"account" here carries **no balance and no asset/net-worth role** — in this app an account is only a
reporting / owner dimension on a transaction, and the only aggregation is totaling spending and income. So
the "Amazon account" is an *ordinary* account, not a special pass-through kind, and there is nothing to
suppress.

- Item rows from the AZAD **items** export become **first-class transactions in an "Amazon" account** — each
  with its own category (from Amazon's taxonomy, user-adjustable), so categorization, rules,
  `category_source`/the manual guard, dashboards, and search all work unchanged. This is why the account
  model (B) beats a second-class line-item model (A): it *reuses the entire spending stack* instead of
  re-implementing categorization + reporting for a sub-entity.
- The matching `AMAZON.COM` **card** charge (already in the ledger from the card CSV) is **recategorized into
  an `exclude_from_totals` category** (an "Amazon" / transfer category) and **linked** to those item rows, so
  the money is counted once — on the itemized side. Exclusion is just a category assignment (the existing
  money-movement mechanism); doing it *conditionally* (only for itemized orders — a blanket
  `AMAZON.COM → exclude` rule would wrongly drop every un-itemized Amazon charge from totals) is exactly what
  the link expresses, and is why the link is the one genuinely new primitive here.

**Correctness rule — the swap is atomic, and orders is the activating file.** An order's item rows count
toward spending **only once that order is linked to and has excluded its card charge**; until then they are
inert detail. So the **orders** export *activates* an order (link + exclude + a coarse categorized spend
from the concatenated `items` text if the items file isn't loaded yet); the **items** export *refines* an
activated order's coarse row into per-item categorized rows (same total, same link). Ingestion is therefore
order-independent and idempotent, keyed on **`order id`** (a durable join-key column — **no staging table**;
the Amazon-account rows *are* the state), and it never transiently double-counts.

**Amounts — allocate the net cash charge across items (item prices are only weights).** The items file's
prices do **not** reconcile to the charge: in 2024, 12 of 36 orders are off (often by $10+) because list
prices ignore discounts, coupons, Subscribe & Save, and promo credits. So the item transactions' amounts are
**not** taken from the items file — instead the **authoritative matched charge, net of any refund, is
allocated across the order's items in proportion to their list prices**, so the per-category amounts always
sum exactly to the real card charge. List price is kept in evidence for reference. This is robust to
discounts / promos / tax / shipping all at once (it never depends on item prices summing to anything), and it
replaces the earlier "add one tax/shipping row" idea. Orders-only (no items yet) → the coarse single row
carries the whole charge amount.

**Two files, disjoint halves.** `orders` carries the charge/link half (`payments` → `(last4, date,
amount)`, `total`); `items` carries the categorization half (per-item `price`, `category`, ASIN). They join
on `order id`. Both are required for the full model; each alone degrades predictably (items-only = uncounted
detail; orders-only = activated + one coarse category). Auto-detect each by header signature and accept both
in one drop, any order. `payments` is a **compound string** needing a dedicated Amazon parser (not the
generic column mapper), which also splits multi-method orders (card + `Rewards Points`, the points leg
carrying no dollar amount). Skip the export's `=SUBTOTAL(...)` footer row.

**Orphans are reported, not blocked (bimodal).** AZAD exports one file per (kind × year) with all rows, so
the two files for a year *should* have identical `order id` coverage. Orphan *count* is therefore
diagnostic: ~all orphaned → benign ("upload the partner file"); a *small fraction* orphaned → a genuine gap
in one export, with no procedural user fix — surfaced for review (not framed as a boundary artifact).
**Manual remedy** is the model's two operations exposed by hand: manually **link** an order to its card
charge (activation), or manually **itemize** a coarse order — surfaced fix-in-place on the import-file /
duplicate report (where orphans appear), and reachable from the transaction register / detail for ad-hoc
cleanup. Manual itemize is the same "create linked categorized item rows for a charge" capability the
importer uses, exposed to the user.

**The link is a general primitive; Amazon is its first client.** Design it as a typed association between a
transaction and a set of counterpart transactions (with a role/kind), so it can *later* carry (a)
credit-card **payment-leg pairing** — the clean two-sided case (checking debit ↔ card credit, equal amount)
that plausibly falls out of the existing cross-account dedup — and (b) a **cash-flow vs spending lens.**
**Do not build those now.** Honest scoping: the payment *leg-pair* is cheap, but "payment ↔ the charges it
settled" is many-to-many, period/statement-based, and does **not** fall out of dedup; and a cash-flow *view*
("money leaving bank accounts over time") is largely a reporting lens over account-type + money-movement
flags, mostly independent of any link. So the primitive is built general-shaped for Amazon and
*accommodates* the CC/cash-flow work without committing to the reconciler that was reverted (see below).

**Decisions settled (2026-07-05):**

- **Amounts / tax / shipping → allocation** (see "Amounts" above): allocate the net cash charge by
  list-price weight; no separate tax row. Supersedes the earlier "one tax/shipping row" option, which the
  data killed (item prices don't reconcile to the total).
- **Orders with no matching card charge** (distinct from file-pairing orphans) — disambiguate via
  `payments`: a card+amount we can't find → the charge is on an *untracked card*, so the items are the sole
  record and count directly (no exclusion); a payment made only from a **non-cash instrument** —
  `Rewards Points` or `Amazon gift card balance` (both appear as payment methods carrying no dollar amount;
  gift-card balance shows in 12 of the sampled orders), or an off-card / gift order (`D01…`, no card) →
  **non-cash**: record the items as detail but don't count them, and surface for manual handling. When an
  instrument is *mixed* with a card (`Amazon gift card balance; Riverstone …`), only the card leg is
  cash — allocate that; the instrument-funded remainder is non-cash. A refund reduces the allocation base
  (`charge − refund`); a full refund nets the order's items to zero. A card leg carrying **$0.00** (a
  free/promo order) is likewise non-cash — no cash moved, so there is no charge to find, and the order
  must not surface as "No charge found" (settled 2026-07-16). Starting with the **2024** export, a
  points-participating order names the card with **no per-leg amounts at all**
  (`Riverstone ending in 5093; Rewards Points;`) — the split is undisclosed, so classification
  alone lands non-cash; the importer then runs the **bare-card probe** (settled 2026-07-16): a *unique*
  eligible charge equal to the order's **full total** on the named card (the matcher's own rules —
  funding map / last-4, ±3-day window) proves the card paid everything, and the order imports as
  ordinary cash (counted at its total, charge matched + excluded); no such charge → non-cash as before
  (points-funded, or a partial split we never guess at). Sampled 2024–2025 data: every such order had a
  full-total card charge, i.e. the points tag appeared without points actually paying.
- **Received rewards / gift cards → not in this data (income non-goal).** `Rewards Points` and
  `Amazon gift card balance` are real money that entered the account *earlier*, but the AZAD *order* export
  shows only what was *spent* from them, never the *credit* that loaded them (that lives on Amazon's
  separate gift-card / rewards **activity** pages, which AZAD doesn't export). So surfacing received gift
  cards or rewards as income isn't sourceable here; amounts are small. If a future export ever carries that
  activity, mapping a credit → an income transaction is trivial — a data gap, not a design gap. (Note: gift
  cards the user *buys* — the `gift` column, items like "…Gift Cards…" — are ordinary outbound spend.)
- **Account semantics → nothing special needed.** An account is only a reporting / owner dimension with no
  balance or net-worth role, so the Amazon account is an ordinary account — surface it normally. (Dropped
  the earlier "synthetic / pass-through / non-balance flavor" idea; there is nothing to suppress.)
- **Multiple Amazon accounts** — `n` of them, user-named (may map to different owners). On import the user
  picks/creates which Amazon account the file targets (the file has no account column — the existing
  single-account import pattern); the orders file's payment card last-4 is a **prefill hint** for that pick
  but not authoritative (accounts can share a card — all 179 charges in the sample are one card), and the
  items file inherits the account via its order-id join. (Distinct from this pick, the same card last-4
  keys the **funding-source → account map** used for *charge* matching — design pass 2026-07-09.)
- **Retroactive reclassification** — importing a past year flips those `AMAZON.COM` charges into the excluded
  "Amazon" / transfer category (overriding a manual category is acceptable; the user then re-categorizes the
  item rows). Reported and reversible via batch undo. The report **surfaces charges whose manual category was
  changed** and **shows the linked Amazon import transactions there even when their detail is incomplete**,
  so the reclassification is never opaque.

**Acquisition (unchanged):** the open-source **AZAD** extension (`philipmulcahy/azad`, Apache-2.0) exports
the orders and items CSVs; we ingest the files. Keep it loosely coupled — the extension is a swappable
front-end, and the `order url` column is an auth-gated per-account deep link (fetching it server-side
redirects to Amazon sign-in), usable only as a UI click-through, never a runtime data source. Open item:
AZAD "preview features" gating (which item fields a plain install exports).

**Ingestion ergonomics (deferred — the CSV is fine, this is polish).** AZAD renders its result as an
on-screen table and both it and Luma run in the same browser, prompting "can we skip the file?" Options,
lightest to heaviest: (1) **paste/drag the rendered table into Luma** — AZAD's "plain table" view is
selectable; a Luma paste target reads the clipboard `text/html` (or tab-separated `text/plain`) and parses
it, same as CSV, no file (caveat: set AZAD "Show → all entries" so pagination doesn't truncate); this is
the realistic win. (2) a **Luma-owned extension / AZAD fork** that POSTs straight to the local backend —
best UX but a new artifact to maintain and it couples us to Amazon's DOM, against the swappable-front-end
principle. (3) **Luma drives a browser to log in and fetch** — rejected: a web app can't read a cross-origin
window, and a backend headless scrape reintroduces exactly what AZAD avoids (the bot wall we already hit,
credential/2FA handling, ToS). Note there is **no cross-origin "drag one window into another"** capability;
option 1's "drag" is just HTML5 drag-drop of the selection, i.e. the same clipboard parse.

**Earlier framing (superseded 2026-07-05, kept for history).** The first sketch called Amazon "a merchant,
not an account — the opposite species from PayPal," and scoped it as enrich-only: attach item text to the
existing card row via the enrich-on-duplicate feature, an adapter + a match, not a bespoke reconciler. That
was right about acquisition and about reusing the dedup match, but it was abandoned once per-item
*categorization* and *visualization* became firm requirements — which the account + link model above serves
and enrich-only cannot. The durable insight it got right: Amazon detail must attach to *existing* card
charges; the model just grew from "enrich the charge" to "itemize into a linked Amazon account."

## Amazon — funding-source → account mapping (design pass 2026-07-09)

**Why.** `find_matching_charge` keyed the card charge on the account's stored mask (`COALESCE(p.mask,
a.mask) = payments last-4`). Real imported ledgers rarely carry masks (CSV imports don't populate them), so
on the first multi-year Amazon import **zero of 56 cash charges matched** — every card charge stayed in its
spending category *and* the Amazon items also counted (double-count), and nothing moved into the excluded
Amazon Funding category. The last-4 is the right *precision* signal but the wrong *hard* dependency: absent
masks it silently matches nothing.

**The fix, two tiers.** (1) **A user-maintained funding-source map** — the authoritative signal: the user
tells us which system payment account each Amazon payment instrument (a card `last-4` + network label) is,
so the matcher constrains the charge search to that account (strong enough to also resolve the same-amount
ambiguous cases). (2) **A graceful-last-4 fallback** for unmapped instruments — *landed this pass*: last-4
now disambiguates only among accounts that *carry* a mask; a maskless account can't contradict it, so
amount + date + uniqueness carries the match. The map is the durable answer; the fallback is what makes an
un-set-up ledger work at all.

**What's mapped, and its cardinality.** The instrument (`last-4` + network, e.g. "Fablecard ···4455")
→ a system funding account. Discovered from the `payments` field of the files imported into an Amazon
account; the distinct set is tiny and stable (the sample: three years, effectively one card) and
**accrues** — new instruments append as they appear, old ones stay so historical orders keep resolving.
**Many-to-one is first-class**: several Amazon accounts may fund from the same card (independent, correct
assertions, not a conflict), and a card reissue (new last-4, same account) is just another instrument row
pointing at the same account. A third state — **"untracked"** — is explicit ("this card isn't an account I
hold"), making the doc's existing *untracked-card → items count directly* disposition a deliberate choice
rather than an inference from a failed search.

**Storage — one global table, optional per-account override (dissolves "one table vs. split by account").**
Key on the instrument; value = funding account id (nullable / sentinel = untracked); scope = *all Amazon
accounts* by default, or *one* Amazon account for an override. Resolution prefers a specific-account
override, else the global default. Global-by-default gives the cross-account reuse the user asked for (map
···4455 once, it applies when importing for any Amazon account); the per-account override is the escape
hatch for the rare different-owners-same-last-4 collision — not a parallel structure. Not per-batch, and not
a column on the account.

**Where it's viewed / edited (the actual open question).** A persistent **"Amazon funding sources" section
beneath the Amazon upload form**, mirroring the *pattern* of the generic Import tab's "Data sources" section
(`ImportHistorySection`) that sits under its upload form — always reachable by opening the Amazon tab, never
buried in a transient import step. The import flow reads/writes the *same* table: a dropped file surfaces
only **new/unmapped** instruments inline (prefilled from the table); everything already mapped resolves
silently. Secondary echo (optional): the account-detail view on the Accounts page can show that account's
effective mappings read-mostly — but the canonical editable home is the Amazon-tab section, since the table
is global. (The `payments` last-4 remains, separately, a weak *prefill hint* for which Amazon account to
import into — a different use of the same field; see the "Multiple Amazon accounts" decision.)

**Matcher resolution order.** override map → global map → graceful-last-4 fallback → (no match) manual link.
A mapped instrument constrains the search to its funding account (`t.account_id = mapped`); untracked
short-circuits to "items count directly, no charge"; unmapped falls to amount + date + graceful-last-4.

**Shared components — reuse before building (per `shared-components.md`).**

- **Section shell + controls:** build from `ui.jsx` primitives — `Card`, `Button`, `Select` (the
  funding-account picker), `EmptyState`, `Badge`, `Spinner` — the same primitives `ImportHistorySection` is
  built from; mirror that section's structure rather than a bespoke shell. No new panel/table control.
- **Remove + undo:** `AppConfirmDialog` (if a confirm is wanted) and the shared **`UndoToast`** for a
  reversible mapping removal, matching the app-wide undo pattern.
- **Help:** extend the existing help registry (`help/content.jsx`) — the `amazon-import` `FeatureExplainer`
  topic, or a sibling — for the funding-source concept; no ad-hoc help text.
- **No shared account picker exists** (the index lists `CategoryPicker` / `TagPickerWithCreate` but no
  account equivalent), so the target picker is a `Select` over the accounts list — reuse `AmazonImportTab`'s
  existing accounts fetch rather than adding a second one.

**Watchlist tipping points this surfaces (per `shared-components.md` → watchlist) — flag, don't silently
add.**

- **"Map a discovered identifier → account (existing or + New)"** already exists inline in the CSV
  importer's account-mapping row (`ImportExport.jsx`); this funding-source row is a **second** instance. It
  is not a shared control today — keep the two visually/behaviorally consistent, and this is the tipping
  point to consider extracting a small shared `AccountMappingRow` (value label + account `Select` + "+ New").
- **Reference-data fetch (accounts)** — `AmazonImportTab` already refetches accounts (a listed watchlist
  instance) and the section needs the same list. Reuse that fetch; a 3rd+ independent refetch is the trigger
  for a cached `useAccounts` hook (à la `useTags`).

**Matcher hardening (landed this pass, independent of the map; tests in `test_amazon_enrich.py`).** Two bugs
in `find_matching_charge`: (a) the last-4 hard-requirement → the graceful degrade above; (b) a **$0 order
self-matched its own just-created $0 item** as the "charge" (the search excluded neither the Amazon account
nor a non-positive amount), moving a phantom item into Amazon Funding — now the search excludes the target
Amazon account and a `$0` charge never matches. These make the *fallback* correct; the map builds on top.

## Amazon — orders-only model (design pass 2026-07-10, current — landed)

**The realization that collapsed itemization.** The **orders** export's `items` column already carries the
full concatenated item descriptions ("what was bought") for every order. The **items** export's only
*unique* content is per-item: Amazon's `category` taxonomy, `ASIN`, `item url`, list `price`, `quantity`,
`subscribe & save`. Since the user categorizes Amazon spend by their **own** rules (not Amazon's taxonomy),
the per-item split existed *only* to serve Amazon-category breakdowns — a feature that isn't wanted. So the
itemization / two-file-pairing machinery was removed.

**The model.**

- **Orders file → one spending transaction per order** in the Amazon account: `amount` = net cash
  (`total − refund`), `date`, memo/`display_name` = the orders file's item list. Categorized by the user's
  rules. The funding card charge is matched (funding-source → account map, then graceful-last-4) and
  recategorized into the excluded "Amazon spending" category + **linked** (money counts once, on the Amazon
  side). A cash order with no matching charge is counted directly and surfaced in the report; a non-cash
  (points / gift-card) order is recorded in the excluded category. Link member roles: `order` + optional
  `charge`.
- **Items file → optional enrichment**, PayPal-style: per-item reference detail (ASIN, list price,
  quantity) is folded into the *existing* order transaction's `import_evidence` (idempotent). It never
  creates rows. Amazon's category is parsed but deliberately unused.
- **Items with no imported order → discarded** (reported, not staged): "import the orders file, then
  re-import the items file." Nothing incomplete enters the ledger, and there is **no staging table** and no
  "awaiting a pair" state — the earlier staging plan (a client of the CSV importer's off-ledger
  `import_batch_duplicate` pattern) was rendered unnecessary once items became optional enrichment rather
  than ledger-shaping.

**Reconciliation report** (`amazon_reconciliation(batch_id)`, `GET /amazon/reconciliation/{batch_id}`;
`AmazonReconciliationDialog`, opened from the import summary's "View reconciliation report →" and the
marketplace batch's row in the import history). Three buckets: **matched** (order ↔ the card charge it
excluded), **amazon_unmatched** (a cash order whose charge wasn't found — a manual-link candidate), and
**payment_unmatched** — the **reverse scan**: Amazon-looking ledger charges (`merchant/raw LIKE %AMZN%/
%AMAZON%`, positive amount) on the cards Amazon uses (this batch's matched-charge accounts ∪ every
globally-mapped funding account), within the batch's date range, that no order is linked to. Heuristic and
informational, so the user can spot purchases the export missed. A **manual link** action (landed) lets
the user attach an `amazon_unmatched` order to one of the `payment_unmatched` charges
(`manual_link_charge`, `POST /amazon/link-charge`): it excludes the charge + adds it as the link's
`charge` member exactly like the auto-matcher (guarded so it can't double-exclude or steal an
already-linked charge), reversing through the normal batch-undo path via the stashed `charge_prior`. The
report dialog renders a charge picker + **Link** on each unmatched order.

**Summary + counts.** `run_amazon_import` returns `orders_imported`, `charges_matched`, `items_enriched`,
`items_discarded`, `non_cash`, `already_applied`, plus the instruments seen (funding-map state). The import
UI shows a compact summary + the report link; the old top/bottom orphan duplication is gone.

**The import mapping screen (landed 2026-07-10) — map before importing, never twice.** The Amazon tab is
modeled on the CSV import-mapping page (there is *no* retroactive reconcile — a mapping, like the category,
affects the current/future import only, matching the "we do not rewrite old imports" rule). Dropping files
`POST /amazon/scan`s them (`_scan_instruments`, read-only) to find the distinct payment cards + each card's
current funding-map state. The screen then shows, top-to-bottom: the **files**; the **target Amazon
account** + the **excluded category** (`CategoryPicker`); a **payment-card row per instrument**
(`AmazonPaymentSourceRow` → account / Untracked / + New, prefilled from the global map); an **apply-my-rules**
toggle; and **Import / Cancel**. Import is gated until the account is chosen *and* every card is resolved
(the hover text names the first unresolved one). Because the cards are mapped *before* the import runs, the
charges match on that same pass — no re-import. The standalone "Amazon settings" card was removed (its
category + funding-map controls live in this screen; both still persist globally and prefill next time).

**Apply categorizations (landed).** An import option (default on; `run_amazon_import(..., apply_categorization)`,
`POST /amazon/import` form field) runs the user's category rules over the new order rows via
`_categorize_batch_orders` — the same category + rule-rename + rule-tag apply the CSV importer does (non-cash
rows in the excluded category are skipped). Off leaves them uncategorized. No "enrich existing" (PayPal) or
"use the file's categories" options.

**Excluded-category settings (landed).** The category the card charge is moved into is a **global**
setting (`import_workflow_state` key `amazon_funding_category`; `find_or_create_funding_category` reads it,
falling back to the seeded "Amazon Funding" leaf under Transfers if unset or the chosen category was
deleted). `GET`/`PUT /amazon/funding-category` expose it; the PUT requires a **leaf** category and is read
at import time, so a change affects **future imports only** — an already-imported charge keeps its category.
Surfaced as the category picker in the import mapping screen. The UI warns if a chosen category isn't
actually excluded from totals (which would double-count Amazon spend). Not per-account.

**Tests.** `test_amazon_enrich.py` (one-txn creation, refund, charge exclude/undo, non-cash, unmatched,
funding-map disambiguation, untracked, orders-only, items-discarded, items-enrich + idempotency,
reconciliation matched/unmatched + reverse scan); `test_amazon_endpoint.py` (one row per order + evidence);
`test_amazon_funding.py` unchanged. Dead code: `amazon_import.allocate` (per-item allocation) is now unused.

### Shipped on top of the orders-only model (2026-07-13 → 2026-07-16)

The contracts now live in `data-model.md` → "Transaction links and Amazon order import" (this is just the
changelog):

- **Reconciliation v2** — the report gained a **duplicate** bucket (same charge imported twice: Merge → keep
  one with identifier-token detail folding, or per-copy Discard; a `mergeable` flag keeps Merge off distinct
  same-amount purchases) and a **matched_review** bucket (a split-shipment order covered by a *unique* set of
  unaccounted charges: Accept links them all, Dismiss persists). Orders can link **multiple charges**
  (per-charge `charge_priors` undo stash; manual multi-charge "Link charges…" picker). Row checkboxes + an
  intersection bulk bar (Merge/Accept/Dismiss); duplicate + matched_review counts surface as the file card's
  "N to resolve" warning and a Tasks-page nag.
- **Import-detail report** — per-batch persisted `import_summary` (counts + enriched / already-enriched /
  discarded / duplicate rows, each with `source_file` provenance) rendered as a second detached report
  (orders / items matched / already enriched / discarded / duplicates / payments-by-account), opened from the
  file card's outcome pills. Answers "which file did this come from?".
- **Per-file re-import skip** — every file taken is content-hashed (`amazon_file_hashes`); a re-upload of the
  same content is skipped with an "already imported" scan-time alert and creates no new card. A file with any
  discarded rows is deliberately *not* remembered (items-before-orders stays re-importable; such a file shows
  struck through on its card), and undo frees a batch's files.
- **Both report dialogs are App-level detached viewers** on the shared `useDetachedReportViewer` seam
  (float/drag/resize, minimize-to-nav, survive navigation) — see `ui-patterns.md`.

## What was explored and reverted (so the history isn't a mystery)

A full **reconciliation** approach was designed and largely built, then dropped as over-scoped for PayPal:
a headless two-axis reconciler (`p2p record × funding counterpart`), source adapters, a `kind` system-
source (schema + partial-unique singleton), an owner+account pairing step, and a persisted reconciliation
report. It was reverted in favor of the ordinary-import + general-enrich direction above. Two things
survived: **`display_name_source`** (general, kept) and the **delta-merge idea** (repurposed as the enrich
engine). The reconciler itself was PayPal-shaped: its heavyweight create/transfer dispositions, owner+
account pairing, and `kind` system-source were more than either source needed, so it was deleted rather
than parked. The reasoning that led away from it — "PayPal is an account," "transfers are categorization"
— is the durable part.

> **Superseded by the 2026-07-05 Amazon pass.** This section originally added "Amazon is a merchant, not
> an account" and "Amazon's need is served by enrich-only" as durable conclusions. The account + link
> model above **reverses** the first (Amazon becomes an *account* precisely to get first-class item
> categorization) and outgrows the second (enrich-only can't do per-item category or
> dashboard rollups). Note this is *not* a return to the reverted reconciler: the new **transaction-link**
> is a single lightweight typed association, not the two-axis reconciler with its pairing step and
> system-source. What survived the revert still stands — `display_name_source` and the delta-merge enrich
> engine; the Amazon model simply adds a link on top.

## Build plan

1. **Enrich-on-duplicate engine** (general, headless-testable) — **landed.** `services/import_enrichment.py`:
   `compute_enrichment_delta` (novel-only vs. the row's names + existing evidence), `enrich_transaction`
   (append the delta to `import_evidence_json.extra_text_fields` — additive, idempotent, so the existing
   Origin hover renders it with no frontend change) and `unenrich_transaction`, plus `enrich_duplicate_row`
   / `undo_duplicate_enrichment` recording the outcome on `import_batch_duplicate` (migration 7:
   `enriched_txn_id` / `enriched_delta_json` / `enriched_at`). It touches only `import_evidence` — no
   display_name/category/notes — so there is no manual value to protect at this stage. Covered by
   `test_import_enrichment.py`.
2. **Manual resolution-screen action** (per-row + bulk) on `UnifiedDuplicatesDialog` — an endpoint that
   calls the engine against the matched candidate, plus the UI action + undo. **Landed.**
3. **Per-source flag** + the silent-but-reported auto-enrich path in the import — **landed (2026-07-05).**
   A `csv_import_profile.enrich_from_source` opt-in (migration 8; default off), surfaced on both the live
   import screen and the saved-source editor and threaded through the run config + `config_snapshot`. In
   `run_import`, after the batch's hard-reject duplicates are persisted, `_enrich_duplicate_rows` (the
   shared helper now behind the manual endpoint too) folds each **unambiguous** hard-reject's novel detail
   into the row it matched — scope deliberately limited to hard-reject + single target (ambiguous and
   soft-flags are left for manual review); a non-empty delta is required, so a second source carrying the
   same detail is a no-op. The count rides back as `enriched_count` (import result + a completion notice)
   and the enriched rows show in the duplicate report with Undo. **Crucially**, because an enrichment
   mutates a row *outside* the batch, `reverse_batch_enrichments` runs in **both** `undo_batch` and the
   `replace_batch_id` re-import path *before* the duplicate records (which hold the deltas) are deleted —
   otherwise the change would be orphaned and un-reversible. Covered by `test_import_auto_enrich.py`.
4. **Amazon** (separate, later) — **the account+link *itemization* pipeline below was superseded
   2026-07-10 by the orders-only model** (see "Amazon — orders-only model"). What survived: the
   `txn_link` primitive, the Amazon account, and charge match+exclude+link. What was removed: per-item
   rows, Amazon categories, net-cash allocation, and two-file pairing/staging. The description below is
   history. Not "feed the enrich path"; it grew into its own pipeline: (a) a general **transaction-link**
   primitive (typed
   association between a transaction and its counterpart set) — **landed (2026-07-06):**
   `services/txn_links.py` (`txn_link` + `txn_link_member` tables — a link groups transactions under a
   `kind` with a per-member `role`, plus an optional `external_ref` and `metadata_json`; pure
   association, never mutates the linked rows) with backup/restore/wipe wiring; covered by
   `test_txn_links.py`. (b) an Amazon **account** whose item
   rows are first-class categorized transactions (an ordinary account — no balance/asset role — chosen at
   import; the engine just takes an `account_id`). (c) an AZAD **two-file adapter** — **parsing + engine
   landed (2026-07-06):** `services/amazon_import.py` (source-pluggable: a thin `read_export` front-end
   over a reusable `rows → orders` core — join on `order id`, `classify_order`, `allocate`) covered by
   `test_amazon_import.py`; and `routers/import_export/amazon.py` (`apply_amazon_order` /
   `reverse_amazon_order`: create item txns, allocate the net cash charge, find + exclude the matched card
   charge into the "Amazon Funding" category, link charge↔items with the prior category stashed for undo;
   non-cash and untracked-card and ambiguous-match dispositions; idempotent by order id) covered by
   `test_amazon_enrich.py`. **Import run + UI landed (2026-07-06):** `run_amazon_import` (batch creation,
   orders-activates / items-refines, coarse row for orders-only) and the `POST /amazon/import` endpoint
   (covered by `test_amazon_endpoint.py`), with reversal wired into `undo_batch` and the re-import replace
   path via `reverse_batch_amazon_links`; a dedicated **Amazon tab** on Import / Export
   (`AmazonImportTab` — account pick/create, multi-file drop, result summary) surfaced through the shared
   `ui.jsx` primitives; a `FeatureExplainer` **help topic** (`amazon-import`) covering AZAD install +
   export steps; and drop-routing on the general CSV importer (a dropped AZAD file is header-sniffed via
   `lib/amazonDetect.js` and handed to the Amazon tab); the batch is stamped
   `source_kind = 'marketplace:amazon'` so the recent-import history groups these under an "Amazon"
   entry rather than "unknown data source". (b) the Amazon **account** is an ordinary account
   with an `ACCOUNT_TYPES` entry `kind: 'marketplace'` — excluded from the generic importer's type/account
   pickers (see `architecture.md` → "Marketplace accounts — the extension pattern"). (d) the `payments`
   compound-string parser — **landed** (in `amazon_import.py`). (e) orphan reporting — the import **summary**
   reports the bimodal orphan counts; **still to build:** the fully-manual **link / itemize** actions on the
   report (manually link an order to a charge, or itemize a coarse order) — the automatic path is done, the
   hand-resolution UI is not.
   Decisions are settled in the Amazon section (allocation of the net cash charge, no-matching-charge
   disambiguation, ordinary-account semantics, multi-account, retroactive reclassification).
5. **Amazon funding-source → account map** (design pass 2026-07-09; see that section) — **landed
   (2026-07-09).** Storage: `amazon_funding_map` (migration 10) keys an instrument (`last-4` + network) →
   funding account, `funding_account_id` NULL = the explicit *untracked* state, `amazon_account_id` NULL =
   global default / non-NULL = per-account override, with two partial unique indexes (global vs. override
   scope). Resolution + CRUD live in `services/amazon_funding.py` (`resolve_funding_account`,
   `upsert_funding_source`, `delete_funding_source`, `list_funding_map`); `find_matching_charge` gained a
   `restrict_account_id` that constrains the search to the mapped account and drops the last-4 clause, and
   `apply_amazon_order` resolves the map first (**override → global → graceful-last-4 → no match**;
   untracked short-circuits). `match_network` threads through `OrderDisposition`/`classify_order`, and
   `run_amazon_import` returns the run's `instruments` with their map state. Endpoints: `GET/PUT/DELETE
   /amazon/funding-sources`. `amazon_funding_map` rides in backups (dump/restore/wipe, dropping a mapping
   whose named account didn't survive). UI: the persistent **`AmazonFundingSourcesSection`** under the
   Amazon upload form (built from `ui.jsx` primitives — `Card`/`Select`/`Button`/`Badge`/`EmptyState`/
   `Spinner`, `UndoToast` for a reversible removal, mirroring `ImportHistorySection`); a completed import
   feeds its discovered instruments in so new/unmapped ones surface inline as **Needs mapping** rows, and
   the summary nudges when an unmapped card was seen. Help topic `amazon-funding-sources`. Tests:
   `test_amazon_funding.py` (resolution order, untracked, upsert/dedupe, many-to-one) + `test_amazon_enrich.py`
   (mapped disambiguates a same-amount pair; untracked skips the match). **Watchlist flagged, not extracted**
   (per `shared-components.md`): the funding row is the 2nd inline "map identifier → account" control (the CSV
   importer's is the 1st) → the `AccountMappingRow` extraction tipping point; the section reuses the tab's
   existing accounts fetch (a 3rd refetch would trigger a `useAccounts` hook).

**Capture side — a user-picked "extra detail columns" selector (supersedes the keyword tweak).** The
engine can only fold in detail the import *captured*, and today extra evidence is auto-detected purely by
the `IMPORT_EVIDENCE_HEADER_KEYWORDS` heuristic — which misses columns like PayPal's `Item Title`
("Pats tix"). Rather than hard-code more keywords, let the user **explicitly pick which unmapped columns to
capture as evidence** on the import mapping screen. It's transparent, per-source, general, and it makes
"Pats tix" flow through the *general* mechanism (pick Item Title → captured → enriched onto duplicates).
Design points settled: **supplement, don't replace** the keyword auto-detect (keep zero-effort capture);
**honor an explicit pick over** the `MAX_IMPORT_EVIDENCE_TEXT_FIELDS` cap. Storage is a
`column_map.evidence_columns: [headers]` list on the profile — no schema change.

**Two kinds of capturable column, and the role tag that keeps them apart (settled).** "Interesting"
is not "varied free text." A capturable column is one of *two* shapes, and they must be treated
differently downstream:

- **Descriptive free-text** (PayPal `Item Title`: 9/9 distinct; `Name`: 16/28) — high distinct ratio,
  word-like. Decodes "what was this?" for a human *and* is safe for the fuzzy duplicate text-matcher
  (varied enough that an exact/near match is meaningful).
- **Categorical vocabulary** (PayPal `Type`: 10/58, heavily repeated — "Bank Deposit to PP Account" ×13,
  "General Withdrawal" ×13; `Status`, `Currency`) — low distinct count. Valuable for `match_source_text`
  rules, the Origin hover, and money-movement classification, but **toxic to the fuzzy matcher**: two
  unrelated deposits share the identical `Type` string → similarity 1.0 → a spurious duplicate. (This
  corrects an earlier note here that called extra columns "safe because the matcher takes the max
  similarity across fields." That argument only rules out false *negatives* from a low-scoring column;
  the real hazard is a false *positive* from a shared categorical value, which `max` does nothing to
  stop. It is also exactly why the original keyword list deliberately excluded type/status.)

So **capture stays a single user choice**, but the system tags each captured column's **role**
(`descriptive` vs `categorical`), inferred from sampled cardinality, and the **fuzzy duplicate
text-matcher consumes only `descriptive` fields** (`_collect_duplicate_match_texts` gates on role).
Categorical captures still feed the hover, rules, classification, and enrich. The user never has to reason
about matcher noise.

> **Backend landed (2026-07-05).** `column_map.evidence_columns` threads through the import;
> `_build_evidence_column_plan` is **authoritative when the list is provided** — the import UI seeds its
> capture checkboxes from the keyword auto-detect, so the list it sends is the user's resolved choice
> (including any keyword default they unchecked), captured exactly and uncapped; when the field is
> **absent (`None`)** — a saved profile with no capture config, or an API caller — the zero-effort
> keyword auto-detect still runs (capped). Each captured column is role-classified via
> `_classify_evidence_column_role` (cardinality: distinct ≤ 12, genuine repeats, distinct/nonempty ≤ 0.5
> → `categorical`, else `descriptive`) and stamped with its role (categorical only — descriptive stays
> unmarked for a lean shape, and the matcher reads missing-role as descriptive so legacy evidence is
> unchanged); `_collect_duplicate_match_texts` skips categorical; and enrich preserves the role so a
> transferred categorical value stays out of the matcher on its new row. Covered by
> `test_import_evidence_roles.py`.
>
> **UI landed: add-on capture panel** (2026-07-05) — `ImportEvidenceColumnsSection.jsx`, a "Capture extra
> detail" section below the field-centric mapping table on both surfaces (the live import page
> `ImportExport.jsx` and the saved-source editor `ImportProfilesManager.jsx`). It lists every *unmapped*
> column as a checkbox with its inferred shape; whatever is checked becomes `evidence_columns`
> (authoritative). Shape inference + defaults live in `importColumnInference.js`
> (`classifyEvidenceColumnShape`, `computeEvidenceColumnOptions`, `defaultEvidenceColumns`), mirroring the
> backend cardinality classifier. **Default-check policy (revised 2026-07-05 on live-import feedback):**
> a column is pre-checked when its header is a descriptive keyword, **or** its shape is **free text**,
> **or** it is an *informative categorical* — a real vocabulary, distinct-value count ≥
> `EVIDENCE_INFORMATIVE_CATEGORICAL_MIN_DISTINCT` (4). That last clause is the fix for the useful
> categorical: a PayPal `Type` (≈9 kinds of transaction) genuinely classifies each row and is worth
> capturing, whereas a near-constant categorical — `Currency` (1 value), `Status`/`TimeZone` (2) — carries
> almost no per-row information and stays **off by default** (distinct count is the signal). Identifier,
> number, date, and *time-of-day* columns are shown but off by default too. The panel shows the distinct
> count next to a categorical column so the user can see why it is/isn't pre-checked. **Ordering:** the
> panel lists columns **highest capture value first** (free text → informative categorical / keyword →
> low-value categorical → identifier → number → date → empty; `evidenceOptionSortRank`), so a useful
> sparse column like `Item Title` rises to the top instead of sitting wherever it falls in the file. The
> first pass
> pre-checked *all* categorical (junk suggestions: Time/TimeZone/Status/Currency) while missing the useful
> `Item Title`; two fixes brought it into line: (a) classify from the preview's **whole-file** per-column
> stats
> (`column_value_counts` + `column_distinct_meta.total_count`) rather than the 10-row sample, so a
> *sparse* descriptive column like `Item Title` (populated in a handful of rows, none in the first 10)
> is recognized instead of read as empty; (b) added time-of-day detection so a `Time` column reads as
> temporal, not free text. The descriptive-vs-categorical split still exists (backend uses it to gate the
> duplicate matcher), but the *default capture* decision is deliberately narrower than that split. The
> picks flow through `getColumnMap` → import + profile save + draft snapshot; a saved list
> restores the checkboxes, and editing a profile without a re-uploaded sample preserves (never clobbers)
> the saved picks. Covered by `importColumnInference.test.js`.
>
> **Deferred alternative — the column-centric mapping rework (skipped 2026-07-05, may revisit).** The
> other UI shape considered was flipping the mapping screen *around*: instead of a table of transaction
> fields each asking "which column?", present **one row per file column** with a per-column meaning
> dropdown (the existing field roles — date / amount / description / … — plus **Ignore** and **Capture as
> detail**), keyword/shape defaults prefilled and adjustable, already-captured columns marked, scrollable
> for wide (20-column) files. Its appeal: it satisfies "surface *every* column up front" in one unified
> list (the add-on panel splits it — mapped columns in the table, the rest in the panel) and unifies
> mapping + capture into one control. We chose the add-on panel this round to keep scope down (the rework
> rewrites `ImportColumnMappingSection` / `ImportMappingFieldGrid` and touches the amount-convention
> derivation and account-handling picker); the backend (`evidence_columns`, role classifier) is UI-shape-
> agnostic, so the rework can drop in later without backend changes. Open sub-questions if we revisit:
> amount still needs an explicit user pick among the numeric columns (PayPal has four — `Amount` / `Total`
> / `Fees` / `Balance`), so a column-first list must still special-case the required mapped fields; and
> how two-column debit/credit and the account column fold into a column-first layout.

**Smart prefill = classify each column's shape from sampled rows.** Numeric / date / empty /
identifier(near-unique, code-like) / free-text / categorical → a default meaning: numeric → an *amount
candidate* (never auto-picked — PayPal has four numeric columns, `Amount`/`Total`/`Fees`/`Balance`, and
`Amount` vs `Total` are indistinguishable by shape, so the user explicitly confirms the amount, suggested
by header); date → date; free-text **or** categorical → **capture** (with the role tag); identifier &
empty → ignore. This catches `Item Title` *and* `Type` with no keyword list. Keep the existing file-level
fingerprint → saved-profile match as a second, confirmable prefill layer.

**UI is open** (the main requirement: *surface every column in the file so the user can see them*, with
scrolling for wide files). Leading candidate is the column-centric rework: one row per file column, each
with a meaning selector (the existing field roles + `ignore` + `capture as detail`), keyword/shape-matched
defaults pre-filled and adjustable, and already-captured columns marked. A simpler multi-select of unmapped
columns with keyword-matched ones pre-checked is the fallback.

**Foundation for the parking lot.** Capturing `Type` as a *categorical* field is the substrate for the
money-movement work below — the funding-leg deposits flagged "no specific match" are precisely the rows
whose `Type` reads "Bank Deposit to PP Account" / "General Withdrawal". This capture design pre-pays for
recognizing/pairing/suppressing them later.

Note: capture happens at import time, so already-imported rows carry only what was captured then — either
re-import to pick up newly-selected columns, or (a possible refinement) have enrich re-derive detail from
the duplicate row's stored raw `values_json` using the current capture config.

**Parking lot (revisit after this project): PayPal funding-leg deposits flagged "no specific match."** A
PayPal purchase's funding leg (e.g. "Bank Deposit to PP Account", `+4130` raw → stored `−4130`) has no
counterparty and often no match in a ledger populated from another aggregator, so it surfaces as a
covered-range "no specific match" for review. The detection is arguably correct, but whether these
deposits should be handled more gracefully (recognized as transfers, paired, or suppressed) is worth a
look once the enrich work is done. (The report's sign/detail confusion around this case was fixed
separately in `UnifiedDuplicatesDialog`: stored amounts now render through `formatTransactionAmount`, and
the incoming cell hovers the full raw row.)

## Reuse map (don't reinvent)

- Match / duplicate identification → existing `duplicate_detection` (`evaluate_duplicate`); the enrich acts
  on the row it already matched.
- Detail storage → `import_evidence_json`; rule matching on it → existing `match_source_text`.
- Manual name protection → `display_name_source` (landed).
- Resolution/report UI → `UnifiedDuplicatesDialog` + the existing `import_batch_duplicate` record/undo.
- Transfers/exclusion → existing `exclude_from_totals` categorization + user rules (nothing new).
