# Import / Reconciliation Playbook

**Audience & purpose.** This is the *user-facing* "when situation X arises, reach for tool Y" guide
for building one clean ledger from several data sources over time — where some sources identify
accounts or categories better than others, and the same activity often arrives more than once.

It is deliberately separate from the developer docs: `architecture.md` and `data-model.md` record the
*why* and the invariants behind these tools; this file records the *when/how* for the person using
the app. It is also the **content source** for the in-app version of this guidance (see
[in-app surfacing](#in-app-surfacing) — the Help/FeatureExplainer registry is its home). Examples are
generic on purpose so they can be reused as help copy.

## Mental model

- A **data source** is a saved mapping template; each **import batch** is one imported file, grouped
  under its data source (or under *unknown data source* / a *temporary draft* if none).
- Reconciliation is mostly about deciding, per attribute, **which source wins**: one source may carry
  the correct *account*, another the better *categorization*, a third the cleaner *description*.
- The dedupe engine settles the easy, high-confidence cases automatically and **surfaces the
  judgment calls** in the per-file duplicate-detection report (the `↗` / report on each file). The
  tools below are mostly about resolving those surfaced cases.

## Choosing how to bring data in

Transactions arrive one of two ways, and most ledgers end up using both.

- **A data provider** fetches transactions from the bank directly, so there is no file to export. It
  needs an account with the provider (a subscription, or developer credentials) and a vault passphrase
  to protect the stored credential. A sync is started by hand, and history reaches back only as far as
  the bank and the provider allow.
- **Files** cost nothing and reach back as far as the bank's own export does. The price is the repeated
  download. A saved data source takes the mapping out of every later file, and a watched folder takes
  out the trip to the Import page as well.

**Using both.** A common shape is files once for the older history and a connection from then on. The
overlap is safe, because every import is compared against the ledger — provided the same bank account
maps to the same account here from both.

**Sources worth adding either way.** A card or bank account records where money went, not always what
it bought:

- An Amazon purchase reads as some form of AMAZON.COM and an amount, however the charge arrived. The
  order export adds the orders and, optionally, their items, which is what lets one order be split
  across categories.
- A purchase paid through PayPal reads as a "PAYPAL…" line. PayPal's own history names the purchase.
  The monthly statement PDFs are the easy way to get that history; the activity CSV adds each
  purchase's item title.

Neither has to wait for the account that paid: orders and PayPal transactions are matched with their
card or bank transactions whichever side arrives first.

**Arriving with categorized data.** An export from another tool often carries a category on every row.
Noting that the categories are present in the data, during the import or afterwards on the file's
card, lets **Group imported categories** bring them in and **Generate rules** propose rules that file
future imports the same way. That is a quicker start than the starter categories or categorizing from nothing.

## Keeping the ledger up to date

Once the accounts are in, the same handful of steps repeats, at whatever interval suits — monthly is
typical:

1. **Bring in what is new.** **Sync now** for connections; for files, download the export and drop it on
   the Data Import tab, or leave it in the source's watched folder. Check **Watched folders** for
   anything left for review.
2. **Refresh the detail sources.** Re-export the recent Amazon orders and the latest PayPal statement
   (see *Adding purchase detail from Amazon and PayPal* below). An export that overlaps the last one is
   fine.
3. **Settle what the import could not.** A card in the import history says when something on it needs
   a decision: a duplicate, an Amazon order or a PayPal transaction with no clear match.
4. **Look over what arrived.** The needs-review count on each card opens just those transactions.
   Correct the ones a rule filed wrongly, categorize the ones no rule caught — accepting the offered
   rule means the same payee is filed next time — and mark the rest reviewed.
5. **Check Tasks** for anything else: a connection needing attention, a new recurring series, a bill
   whose amount changed.

## Adding purchase detail from Amazon and PayPal

A card or bank line for a marketplace purchase says only AMAZON.COM or PAYPAL and an amount, whether a
file or a data connection brought it in. The marketplace's own export says what was bought, and is worth
importing alongside either.

| Source | What to export | What it adds |
| --- | --- | --- |
| Amazon | The Orders file from the AZAD browser extension, and optionally the Items file for the same period | One transaction per order, in an Amazon account. With the Items file, each order's items, so the order can be split across categories |
| PayPal | The monthly statement PDFs (or a zip of them), or the activity CSV | One transaction per PayPal payment, naming who was paid. The CSV adds the item title; the statements pair each refund with its payment |

The steps are the same for both:

1. **Export** the period wanted. The first time that is the whole history worth having; afterwards the
   recent months.
2. **Drop the files** on the Data Import tab. They are recognized by their contents. The first import
   asks which account the purchases go into and, for Amazon, which account each payment card is.
3. **Check the reconciliation.** Each order or PayPal payment is matched with the card or bank
   transaction that paid for it, and that transaction is moved out of the totals so the purchase counts
   once. The import's card says when a match needs a decision.
4. **Use the detail.** The order or PayPal transaction is the one to categorize. An Amazon order with
   item detail opens in the split editor with one line per item, and **Use items** fills them in from
   the order's items.

Overlapping exports are safe, and so is importing before the card or bank account that paid: matching
runs again when that side arrives.

## Situations → what to use

### The same transaction was imported from two sources (cross-account duplicate)

The report lists it as a **Cross-account match** ("Review"). Three actions, by outcome:

- **Keep both** — they really are different transactions. Also asserts *these two accounts are
  distinct* (so future imports stop re-flagging the pair).
- **Discard new** — the just-imported row is the duplicate; keep the one already in the ledger.
- **Replace existing** — the just-imported row is the *better* record (e.g. it has the correct
  account); keep it and remove the existing one. The surviving row's **categorization follows each
  file's "use imported categories" choice**: it keeps the new file's category only when the new file
  is the sole one with that box checked; otherwise it adopts the existing row's category. Use this
  when one source has the right account but another had the better categories.

### Reconciling by merging accounts — order doesn't matter

Merging two accounts that are genuinely the same physical account auto-confirms the overlaps **both
sources describe identically** — the amount always matches, so the wording is what decides — and those
rows leave the ledger without being asked about, listed as "Duplicate in this account (confirmed)". Two
descriptions that merely resemble each other, or share only the payee, are never auto-confirmed: the row
stays in review as "Possible duplicate in this account" (or "Same payee, different wording") and still
needs Keep both / Discard new / Replace existing. **Importing then
merging** and **merging then importing** reach the same state. **Detaching** an account later reverses
the merge's auto-confirmations (your explicit Reject/Replace decisions are preserved).

### A covered-range row is off by a day or two, matched elsewhere, or has no match

When an earlier import already covered a date range, every transaction in that range is expected to
already be in the ledger, so a new row landing inside it is rejected as a presumed duplicate and paired
against the existing data by date and amount — the exact date first, then ±1 day, then outward a day at a
time to a week, then across other accounts. Re-importing a file, or importing a second export that
overlaps the first, puts every overlapping row through this, and most of them pair cleanly. The report's
**Kind** column names the outcome; only two of them ask for anything.

**Worth a look:**

- **Matched · review** — a same-account counterpart turned up only after the window widened past the
  exact day; each row states the gap. The window reaches `CROSS_ACCOUNT_DATE_WINDOW_DAYS` (7), sized from
  settlement skew measured on a real ledger, and is ordered closest-day-first so a nearer candidate is
  never displaced. The further apart a pair sits, the more it is worth a glance before clearing.
  Posting dates drift between sources for several reasons — pending-vs-posted timing, weekend or holiday
  settlement, and time-zone differences on foreign charges — so the same transaction can sit several
  days apart in two sources. After the pair is confirmed, **Mark reviewed** in bulk (or per row) clears
  it from the needs-attention list. If a pair is *not* the same transaction, select the rows and
  **import both**.
- **Rejected · review** (no specific match) — the date is covered but nothing paired at all, anywhere in
  the window or across accounts. **A *named* payment that reaches this point is auto-rescued:** the
  importer checks whether the same payment already sits in the ledger as a charge elsewhere (matched by a
  distinctive merchant token + the same signed amount within ±14 days). If none does, the payment is
  genuinely new — a balance-funded subscription or P2P send the covering aggregator never saw, since it
  never hit a card or bank — and it **imports** instead of being buried here; if a corroborating charge
  *does* exist, the row stays rejected and reads *Matched another account* below. So this bucket is
  mostly **nameless money-movement** (deposits, withdrawals, currency conversions, holds) — genuinely no
  counterparty, correctly held back — plus any payment whose new-vs-duplicate status the token match
  couldn't settle; **Import anyway** for anything real that remains.

**Settled — named so a rejection can be audited, but needing nothing:**

- **Matched** — paired on the exact date or ±1 day. Where the row had detail its match lacked, that
  detail was folded in and the row reads green.
- **Matched another account** — the same charge, in the same direction, already sits on another account
  within a couple of weeks, matched on a distinctive part of the name. One payment recorded twice by two
  sources: an aggregator's export and a card's own download both carry the charge behind a wallet
  purchase. The money left once, so the second copy is not a new transaction. Common where two exports
  overlap.
- **Matched transfer** — an equal-and-opposite row *naming this account* sits on another one within a few
  days. That is the wallet-funding signature: importing a PayPal/Venmo account's activity, its "Bank
  Deposit" / funding legs have no twin on the wallet itself — their twin is the funding charge on the
  bank or card that paid it (named "PAYPAL…"), already in the ledger. Two legs of one movement, so this
  one is correctly not re-imported. The match is by amount + date + the account name, searched across the
  cleaned merchant name, the **raw statement name**, and the captured source text (e.g. Mint's
  `Original Description`) — the bank's clean descriptor often drops "PayPal" while the raw statement keeps
  it, so searching only the name misses most of these. All three are read, which is what makes **renaming
  safe**: a rename rule writes the clean name and leaves the raw one alone, so cleaning up a cryptic
  descriptor can only add a name to search for, never take one away. Renaming a bank's `CRD AUTOPAY` row
  to name the card it pays off is the useful case — it introduces the card's own name and lets a card
  payment pair the way a wallet's funding leg already does. (A rename never revisits a rejection already
  recorded; it changes what later imports, and a re-opened report, can find.) Because the twin is the
  *other* leg rather than the same transaction, it is never an enrich target.

Neither settled outcome is a duplicate *verdict* of its own: the coverage rule had already rejected the
row, and the cross-account probes run afterwards only so the report can name something rather than report
"no specific match". Both are counted in the file card's duplicates total and neither appears in the
needs-attention pills. **Import anyway** stays available on both for the rare row that really is separate.

A stored verdict names the accounts as they stood on import day. Merging two accounts afterwards does not
revisit it, so an old report can describe a split that has since been healed.

### A source duplicates rows *within a single file*

Some exports list the same purchase twice (often a day apart). The importer **intentionally allows
within-file duplicates** (it can't tell a real repeat purchase from an export artifact), so this is a
source-quality problem to fix *before* import.

- Use a **one-off, review-first CSV de-duplication script** (`data/clean_mint_csv.py` is the example
  built for this) that writes a cleaned copy plus an audit file of what it dropped; tune the day
  window / cross-account scope. Tiny fixed-amount recurring items (vending, parking meters) are
  acceptable false positives — they don't move totals.

### A file held more rows than the import brought in

Open that file's report from the **↗** beside its name and switch to **Not imported**. Every row the
file offered and the import did not take is listed there with the reason it was left out — a date or
amount that could not be read, a currency the ledger does not hold, a zero amount, an account set to
Skip, and the trailing text at the end of an export. The list sorts and searches, and the pills at the
top narrow it to one reason. The **N rejected** pill on the file's card opens the same place.

Rows held as possible duplicates are counted there but reviewed in the duplicate report, which is where
they can be imported anyway or restored.

Two limits are worth knowing. Only a few hundred rows are kept per file — a file whose columns were
mapped wrongly can refuse every row, so the report says when it is showing a slice of a larger count.
And a file imported before this record existed keeps only the small sample its card recorded at the
time.

### A file uses one amount column + a separate debit/credit "type" column

Pick the **"Single column + a debit/credit type column"** amount convention and map the type column
(the one that says debit/credit or deposit/withdrawal). The other conventions are a single signed
column, or separate debit/credit columns.

### A file mixes currencies (a wallet export with the odd foreign charge)

Map the file's **Currency** column — the mapper suggests it when the header says so. Rows in any currency
other than the ledger's are then not imported and are listed under **Not imported** on the file's report,
since an amount in pounds would otherwise count as dollars in every total. A row with the currency cell left blank imports
as the ledger's currency, and a file with no currency column needs nothing.

### A file gives every transaction its own ID

Map the file's **Transaction ID** column — the mapper suggests a column headed *Id* or *Transaction ID*.
Each later file from the same data source then recognizes the transactions already imported by their ID,
even when a description was reworded or an amount changed (a tip added after a charge settled corrects
the amount in place rather than adding a second copy), and a second identical charge with a different ID
is imported as the separate transaction it is. PayPal files are read this way without any mapping.

The IDs are compared only with transactions imported through the same data source, so keep one data
source per provider, and when the provider changes its export's columns, continue with the existing data
source rather than creating a new one — it takes on the new layout. Transactions imported before the
provider added the column receive their IDs when the first file carrying it is imported; importing an
older file without the column afterwards changes nothing. When one provider's files have ended up under
two data sources, delete one: its files move to *unknown data source*, and **Assign to data source** on
each card places them under the other.

### An imported file is under "unknown data source" or "temporary draft"

On that file's card: **Assign to data source** (pick an existing one) or **+ New data source from
this file** (creates a data source from that file's own import mapping and links it). The temporary
draft card additionally keeps **Save as data source**, which builds the new source from the draft
snapshot (column/account mapping). Several file labels can also collapse onto one account during
import by giving them the same target.

### The same export gets downloaded every month and imported by hand

A data source can watch a folder instead. **Folder**, on the source's row on the File Sources tab,
takes a directory path; a CSV that appears there is imported the next time the app is opened, and shows
up in the import history as an ordinary file card with all the usual review on it.

Two things about that folder are worth knowing before setting one. It is read on the machine running
the app — the same machine only when the app runs on the desktop; on a server or in a container it is a
folder there. And the files are left alone unless the source says otherwise: **Once a file is imported**
offers deleting it after a number of days, or straight away, and only ever deletes a file whose contents
still match what was imported from it.

A source will not import on its own until one of its files has been imported by hand, so set the source
up, import one export the usual way, then point it at the folder.

### A watched folder left a file for review instead of importing it

Files it could not take are listed under **Watched folders** on the Import page, each with the reason,
and a Task points at the same place. **Import…** opens the file in the ordinary import flow with
everything already filled in, so the answer is to finish it there once; **Dismiss** stops reporting a
file without touching it, until the file itself changes.

The reasons are all the same kind — something only a person can decide:

- an account in the file the data source has never been shown, or one whose account has since been
  deleted or trashed. A watched folder never creates an account, and never matches one by name, because
  a wrong guess splits an account's history quietly
- a data source that is set up to create a new account when it imports
- a file whose columns are not the ones the data source expects, which usually means the wrong file
  landed in the folder
- the first file from a source that has not imported anything by hand yet

Fixing the reason is enough — mapping the account from the source's row in the **Data sources** list, say. The next check
picks the file up on its own, and the Task clears itself.

### An import keeps creating a category I don't want

**Delete** it — from the **Delete…** action in **Group Imported Categories** (Import) or the
Categories page. Delete doesn't erase the row: its existing transactions clear (or, via the Categories
page dialog, reassign to another category) while keeping their raw imported label, and **future
imports of that label come in uncategorized** instead of recreating it. The category moves to the
**Inactive** list at the bottom of the Categories page, where **Recover** restores it as a permanent
system category — back in the group it was deleted from, or `Unassigned` if that group is gone. A
recovered (or any user-created) category does **not** reappear in the Group Imported Categories
workspace; that workspace is only a landing spot for pending *imported* labels.

Note the difference from **Set aside**: setting a label aside only *parks* it out of the
"needs sorting" pool — the category stays active and imports keep categorizing to it. Use Set aside
for "I've triaged this, leave it in Unassigned"; use Delete for "stop bringing this in as a category."

### A transaction was imported, then removed as a duplicate

Most duplicates are caught during the import and never reach the ledger; **Import anyway** on the
duplicate report is the way back for those. A few are removed afterwards: the older copy when a Review
row is settled with **Replace existing**, the newer one when it is settled with **Discard new**, the
copies an account merge finds, or a doubled charge merged on the Amazon reconciliation report. Such a transaction was in its file's ledger and no longer is.

It stays on the **duplicate report** of the import it came from, under **Removed later**. A Replace
removes the older copy, so that can be a different file from the one where the decision was made. The
**Removed as duplicates** line in that file's ledger (the `↗`) opens the report on just those rows.
**Restore** puts the row back; detaching a merged account restores every removal the merge made.

### Finding a transaction in a long ledger

The file-ledger and Transactions search boxes accept date and amount, not just merchant — type a year
(`2023`), month (`03/2023`), day (`03/15/2023`), or an amount (`68`) to jump to it.

### An Amazon order shows "Duplicate detected" on the reconciliation report

Two or more identical same-amount charges **on the same account** made the order's auto-match
ambiguous — usually the same charge imported twice (e.g. two Mint syncs). Same-amount charges on
*different* accounts are never grouped as duplicates: two imports of one charge always land on the
same account, so cross-account matches are distinct transactions (this matters because an order whose
payments string names no card has no last-4/account constraint at all, making every same-amount charge
in the window a candidate — without the guard a Merge could trash a real transaction elsewhere). If it's one purchase with redundant copies, use
**Merge → keep one**: the richest copy survives (any distinguishing detail from the others folds into
it), the rest go to Trash, and the order matches the survivor. When *other* unmatched orders share the
amount, the copies are distinct purchases, not redundant — Merge isn't offered; use **Not duplicates**
to mark the group distinct (it never re-flags; the order falls back to the unmatched path, where a copy
dated on the order itself is re-suggested for review), or the per-copy **Discard** to remove only the
copies you know are double imports. Filter to one kind with the pills, select rows with the checkboxes,
and the bulk bar applies Merge/Accept/Dismiss/Unlink/Move-to-trash to everything selected that supports
it. Because the report's rows are heterogeneous — each kind has its own valid resolutions — a mixed
selection is allowed and each button shows the count of selected rows it actually applies to, rather
than restricting the selection to one kind. Only row-level actions get a bulk form: the per-copy
**Discard** on a stacked duplicate row names *which* copy to remove, so its bulk equivalent is Merge.

### An Amazon order shows "Duplicate · review" (same amount, dates don't line up)

Same-amount copies exist, but only **outside** the strict ±3-day match window (within two weeks) — so
the dates don't corroborate the duplicate reading the way an in-window pair's do. The row offers the
same per-copy **Discard**, **Merge → keep one** (merging exactly the copies the row displays), and
**Not duplicates**; examine each copy's origin detail (hover) before resolving — then resolve per row,
or select the rows you've checked and bulk-Merge (a merged copy is restorable from Settings → Trash).
Note that after a
per-copy Discard the out-of-window survivor is *not* auto-linked — the order returns as
**Matched · review** with a note naming the date gap, one Accept away; Merge links the survivor in
one step.

### Two "Unaccounted charges" are copies of each other

Copies of one real charge (a bank's post date vs. an aggregator's date, e.g. Mint) land on the same
account with the same amount a day or three apart — and when no order accounts for either, the general
dedupe can't catch them (different dates / payee text). The report groups these as
**Unaccounted · duplicate**: **Merge → keep one** keeps the richest copy (folding in the others'
detail) and returns it to the unaccounted list, **Discard** a copy by hand, or **Not duplicates**
asserts they're distinct purchases — persisted (`amazon_charge_distinct`), so the group never
re-flags. Same-amount-nearby without an order is weaker evidence (repeated same-price purchases are
real), so check each group's origin detail first — then Merge per row, or bulk-Merge the selected
groups. A plain **Unaccounted charge** row offers **Trash** as the escape hatch for a duplicate the
grouping failed to pair. It is named Trash rather than Discard because it acts on the whole row (that
row owns one charge) — which is also what lets it work in bulk as **Move to trash**, where the per-copy
**Discard** on a stacked duplicate row can't, since that one names *which* copy to remove. The two also
file differently in Settings → Trash: a per-copy **Discard** is a dedupe resolution and lands under
*Duplicate transactions*, while **Trash** is an ordinary delete and lands under *Transactions* with
everything else you removed by hand.

A mistaken merge or discard is undoable: the removed copy sits in Settings → Trash under the
**Duplicate transactions** section, in a collapsible group named for the file it was imported from
(ordinary deletes stay in the separate Transactions section), and **Restore** brings it back — the
reconciliation grouping simply re-derives on the next refresh. A merge loser also appears in its
source file's duplicate report, pointing at the kept copy.

### An Amazon order shows "Matched · review" (a split shipment)

No single charge equals the order total, but a unique set of unaccounted charges sums to it — Amazon
billed the order per shipment. **Accept** links the whole set (each charge is excluded, so the money
still counts once); **Dismiss** if it's not a match (it won't be re-suggested). A set whose charges are
more than a week apart is flagged so you can eyeball it first. A *single*-charge suggestion means the
auto-matcher refused a pairing the wider review pass found — the row carries a note naming why (charge
outside the ±3-day match window, a cent off the order total, on an unexpected account, or simply
imported after the order was). After a **Not duplicates** verdict frees same-amount candidates back to
this pass, the one dated on the order itself is suggested over its off-date rivals (the note says so);
if none is on-date, the order lands in No charge found for manual linking.

### How an order's charge is found (and why some orders don't match)

The matcher looks for an unlinked charge of the same amount within ±3 days, narrowed by whatever
account signal the order carries: a **mapped funding source** pins it to that account; failing that the
card's **last-4** rules out accounts whose mask disagrees. A funding source follows its account into a
merge — if the card it names is later merged into another account (a reissued card, or a CSV-imported
account merged into the synced one), the mapping keeps pointing at the same physical card and charges
arriving on the surviving account still match. An order whose payments string names **no
card at all** (a digital `D01` order, or one paid off-card) has neither — so the payee becomes the only
remaining signal and the charge must at least *look* like Amazon (`AMZN`/`AMAZON`). Without that rule,
amount + date alone would match any coincidental same-amount charge in the window, on any account.

The deliberate trade-off: an off-card order whose real charge carries a non-Amazon descriptor (say it
was funded through PayPal, so the card reads "PAYPAL") now lands in **No charge found** instead of
matching. That's a miss you fix with **Link charges…** — much cheaper than a wrong match, which would
exclude an unrelated charge from your totals and can't be spotted without auditing.

### An Amazon order is matched to the wrong charge

A pairing can be wrong — a coincidental same-amount charge, or an accepted suggestion that turned out
not to be this order's. **Unlink** on the Matched row detaches the charge(s), restores each one's
pre-exclusion category, and drops the order back to "No charge found", where **Link charges…** pairs
it correctly. The order transaction itself is untouched; only the pairing is removed, and the unlinked
charge is never matched to that order again automatically.

To investigate what an order actually was, hover it for its origin detail (source file, captured
fields) or click the **↗** to open the order's own page on Amazon — often the only place the detail
exists for a thin digital (D01) order, whose export row may carry no item text at all. The Amazon link
is captured at import, so it is present on orders imported after that capture was added.

### An Amazon order shows "No charge found"

Either the paying card isn't in your ledger (an untracked card, or the charge predates your imported
history) — nothing to do, the order still counts — or the match was missed. A charge that simply hadn't
arrived yet needs nothing either: when the card syncs or is imported after the Amazon file, the new rows
are matched by the import's own rule (the order's only candidate, and no other order's), and anything
less clear-cut shows up here as a suggestion. **Link charges…** opens a
picker over the unaccounted charges with a running sum against the order total: check the charge(s)
that paid for it (several, if it was split) and link them. A mismatched sum warns but doesn't block.

### I imported the Amazon items file before its orders file

The items had no orders to attach to yet, so their per-item detail is **parked** (kept, keyed by order
id) rather than discarded — the items file gets its own card with a **no matching order** pill, and the
import-detail report lists exactly which order ids are waiting and from which file. Just import the
orders file whenever you have it: the parked detail **attaches automatically** to the new order rows —
no need to re-import the items file. Once every parked item has attached, the items-only card **folds into
the orders card** (which now lists both files), so you end up with a single card, exactly as if you'd
imported the two files together; a partly-matched items card stays until the rest of its orders arrive.
(Undoing the items-only import discards its parked detail; undoing the orders import returns those items to
waiting.)

### I re-imported an Amazon file (or uploaded the same file twice)

Files are matched by **content**, not name: one that a completed import already took raises an
"already imported" alert at scan time, and acknowledging it drops the file from the selection — nothing
is re-processed and no new file card is created; the original card still covers it. Undoing an import
frees its files to be imported again. Use the file
card's outcome pills (orders / items matched / discarded / duplicates / payments) to open the
import-detail report and see what any import actually did, including which file each row came from.

### PayPal history from monthly statements (PDF)

PayPal's monthly statements are the easy way to get its history: one PDF per month, or a zip of them.
Drop them on the importer like any file. Each statement is read, and its PayPal account (the PayPal
Account ID printed on it) is given an account here — a PayPal account, or a new one. After that, that
PayPal account's statements always go into the same account, and that account takes no other PayPal
account's statements, so one person's statements cannot land in another's PayPal account.

Each statement becomes its own card under the PayPal data source, beside any activity CSVs. A statement
row already in the ledger — from a data connection or an earlier CSV — is recognized as a duplicate and
enriched with the statement's detail. A statement imported before is skipped, and so is a month with no activity.
A payment in another currency is not imported, and neither is the card deposit that paid for it, so the
card charge stays the record of that purchase. The statement lacks the activity CSV's item title; where
that matters, the CSV is still the richer file.

A statement also says which payment each refund returns, so a refund is **paired with its payment** and
takes the payment's category: categorize the purchase and the refund moves with it, so the two cancel out
in that category. This works across statements, in whichever order they are imported, and with a payment
imported from the activity CSV. Setting the refund's own category by hand ends the pairing's hold on it.
Both rows carry the 🔗 link marker, which names the other one and opens it. When the refund went straight back out to
the card or bank it came from, that withdrawal moves to *Money movement* with it. A deposit or withdrawal
has no name of its own; the ledger shows what kind of transaction it was ("General Credit Card
Withdrawal") in its place.

### A PayPal purchase shows up on the card or bank as well

When a PayPal account is tracked, its rows are the record of what was bought or received — money can sit
in a PayPal balance, and then the PayPal row is the only record there is. What PayPal took from a card or
bank, or sent back to one, also appears on that card or bank account as a "PAYPAL…" row, and counting
both would count the purchase twice. So after every import and every sync, each PayPal row is **matched**
with the card or bank row on the other side of the same money, and the money counts once:

- a **payment** a card or bank paid directly counts on the PayPal side, and the card or bank row moves
  to *Money movement* — unless the PayPal row was already filed as a transfer, in which case the card
  row is the one counted and nothing changes;
- a **transfer** — money added to PayPal from a bank or card, or withdrawn from PayPal to one — is money
  moving on both sides, so both rows move to *Money movement*.

A match is made only when it is unambiguous: one matching amount within a few days, on an account
belonging to the same person (or a shared one). The **PayPal reconciliation** lists what was matched and
what was not — open it from the **Reconciliation** pill on an import or sync card whose PayPal rows have
something to show (a collapsed data source or connection says **⚠ N to resolve** when one of its cards
needs a look), or from the Tasks entry for the whole ledger:

- **Several possible matches** — more than one card or bank row could be the other side. **Pick…** the right one,
  or **None of these**.
- **Two transactions, one match** — one card or bank row that could equally be the other side of either of
  two PayPal rows, and only one of them can have it: usually the other payment came from the PayPal balance, or
  its own card or bank row isn't in the ledger. Both PayPal rows are listed together on one line against that
  single row; **Pick this one** beside the one it belongs to settles the pair, and the other drops off the list
  with nothing to match, which is what a balance-funded payment looks like. **Neither** when it belongs to none
  of them — it is then listed as *No PayPal record* on the account that funds PayPal. (A row whose *only*
  candidate nothing else wants is never listed — it is matched automatically, and so is whatever that leaves
  unambiguous.)
- **Matching transaction not found** — a PayPal deposit or withdrawal with nothing found on the other side. **Link…** one by
  hand (the picker lists nearby PayPal rows on other accounts, whatever the amount), or **Mark
  reviewed** when that account isn't tracked here.
- **No PayPal record** — a "PAYPAL…" row on an account that pays into PayPal, within the PayPal history,
  that no PayPal row accounts for. It still counts as it is; **Mark reviewed** once checked. A row like
  this is often a gap in the PayPal history, or a PayPal row recorded in another currency.
- **Matched** — the matches. **Unlink** puts back whatever the match changed, and the same match is never
  made again.

Undoing an import that brought either side of a pair in undoes the pair too. A category chosen by hand
after pairing is kept when a pair is undone.

## Tags (cross-cutting reporting)

Accounts have owners; **categories/groups do not**. The dimensions you report by — personal/shared,
essential/discretionary, business/personal — are **tags**, attached at whichever level fits
(transaction, leaf category, or group), and they're additive. Use tags rather than trying to encode
those dimensions in the account or category tree.

## In-app surfacing

The situations above are surfaced inside the app through the Help/FeatureExplainer registry
(`frontend/src/help/content.jsx`) — see `docs/ui-patterns.md` → *Help* for
the pattern. Each situation is a help topic, reachable three ways from that single source: the `/help`
pages, an always-present `?` next to the relevant surface (the duplicate-report header, the Amazon
reconciliation and import-detail report headers, the PayPal reconciliation header, the amount-convention picker, the Group Imported
Categories title, the Accounts merge area, the rule-suggestion review, the file-ledger search, the
not-imported view, the watched-folders panel and the removed-as-duplicates line), and a context-triggered
"explain this" tip that appears only when the app recognizes the situation (cross-account matches,
covered-range ±2-day and no-match rows, unknown-source files, rule-suggestion conflicts).

**This doc remains the content source of truth.** When a reconciliation tool changes, update the
situation here first, then reconcile the matching help topic so the in-app copy doesn't drift.
