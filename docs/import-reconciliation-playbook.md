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

### One source lumps several real accounts under a single label ("umbrella" account)

e.g. an aggregator records two physical cards under one generic account name. Merging that umbrella
into *one* of the real cards only resolves that card's overlaps and strands the other's.

- **Do not merge** the umbrella into a single card (merge means "these are the same physical
  account"). Instead resolve the overlaps per-row in the report — **Replace existing** keeps the
  correctly-accounted copy — or fix accounts after import.

### Reconciling by merging accounts — order doesn't matter

Merging two accounts that are genuinely the same physical account auto-confirms the overlapping
duplicates between them. **Importing then merging** and **merging then importing** reach the same
state. **Detaching** an account later reverses the merge's auto-confirmations (your explicit
Reject/Replace decisions are preserved).

### A covered-range row is off by a day or two, matches a transfer, or has no match

When an earlier import already covered a date range, every transaction in that range is expected to
already be in the ledger, so a new row landing inside it is rejected as a presumed duplicate and paired
against the existing data by date and amount — the exact date first, then ±1 day, then ±2 days, then a
cross-account transfer twin. Three of the pairing outcomes are surfaced for review:

- **Matched ±2 days** — a same-account counterpart turned up only after the window widened to ±2 days.
  Posting dates drift between sources for several reasons — pending-vs-posted timing, weekend or holiday
  settlement, and time-zone differences on foreign charges — so the same transaction can sit a day or
  two apart in two sources. After the pair is confirmed, **Mark reviewed** in bulk (or per row) clears
  it from the needs-attention list. If a pair is *not* the same transaction, select the rows and
  **import both**.
- **Possible transfer match** — nothing matched on this account, but a same-amount transaction that
  *names this account* sits on another account within a few days. That is the wallet-funding signature:
  importing a PayPal/Venmo account's activity, its "Bank Deposit" / funding legs have no twin on the
  wallet itself — their money-movement twin is the funding charge on the bank or card that paid it
  (named "PAYPAL…"), already in the ledger. So the leg is correctly not re-imported: **Mark reviewed**
  to confirm, or **Import anyway** if they're genuinely separate. The match is by amount + date + the
  account name (a soft signal, opposite-signed and cross-account, which is why the same-account lookup
  misses it), so it is surfaced for confirmation, never applied automatically.
- **No specific match** — the date is covered but nothing paired at all, even at ±2 days or across
  accounts. This is the one to actually investigate: usually a row present in one source and genuinely
  missing from the other, in which case **Import anyway** keeps it.

A covered row that pairs cleanly on the exact date or ±1 day stays rejected without being flagged — only
the three cases above need a look.

### A source duplicates rows *within a single file*

Some exports list the same purchase twice (often a day apart). The importer **intentionally allows
within-file duplicates** (it can't tell a real repeat purchase from an export artifact), so this is a
source-quality problem to fix *before* import.

- Use a **one-off, review-first CSV de-duplication script** (`data/clean_mint_csv.py` is the example
  built for this) that writes a cleaned copy plus an audit file of what it dropped; tune the day
  window / cross-account scope. Tiny fixed-amount recurring items (vending, parking meters) are
  acceptable false positives — they don't move totals.

### A file uses one amount column + a separate debit/credit "type" column

Pick the **"Single column + a debit/credit type column"** amount convention and map the type column
(the one that says debit/credit or deposit/withdrawal). The other conventions are a single signed
column, or separate debit/credit columns.

### An imported file is under "unknown data source" or "temporary draft"

On that file's card: **Assign to data source** (pick an existing one) or **+ New data source from
this file** (creates a data source from that file's own import mapping and links it). The temporary
draft card additionally keeps **Save as data source**, which builds the new source from the draft
snapshot (column/account mapping). Several file labels can also collapse onto one account during
import by giving them the same target.

### An import keeps creating a category I don't want

**Delete** it — from the **Delete…** action in **Group Imported Categories** (Import / Export) or the
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

### "Where did a removed duplicate go?"

Open a file's ledger (the `↗`); a collapsible **Removed as duplicates** list shows each removed row
and which account the kept copy lives on — so a Replace/merge done from another file doesn't make a
row vanish without a trace.

### Finding a transaction in a long ledger

The file-ledger and Transactions search boxes accept date and amount, not just merchant — type a year
(`2023`), month (`03/2023`), day (`03/15/2023`), or an amount (`68`) to jump to it.

### An Amazon order shows "Duplicate detected" on the reconciliation report

Two or more identical same-amount charges made the order's auto-match ambiguous — usually the same
charge imported twice (e.g. two Mint syncs). If it's one purchase with redundant copies, use
**Merge → keep one**: the richest copy survives (any distinguishing detail from the others folds into
it), the rest go to Trash, and the order matches the survivor. When *other* unmatched orders share the
amount, the copies are distinct purchases, not redundant — Merge isn't offered; use **Not duplicates**
to mark the group distinct (it never re-flags; the order falls back to the unmatched path, where a copy
dated on the order itself is re-suggested for review), or the per-copy **Discard** to remove only the
copies you know are double imports. Filter to one kind with the pills, select rows with the checkboxes,
and the bulk bar applies Merge/Accept/Dismiss to everything selected that supports it.

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
groups. A plain **Unaccounted charge** row also offers **Discard** as the escape hatch for a duplicate
the grouping failed to pair.

A mistaken merge or discard is undoable: the removed copy sits in Settings → Trash under the
**Duplicate transactions** section, in a collapsible group named for the file it was imported from
(ordinary deletes stay in the separate Transactions section), and **Restore** brings it back — the
reconciliation grouping simply re-derives on the next refresh. A merge loser also appears in its
source file's "Removed as duplicates" ledger list, pointing at the kept copy.

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

### An Amazon order shows "No charge found"

Either the paying card isn't in your ledger (an untracked card, or the charge predates your imported
history) — nothing to do, the order still counts — or the match was missed. **Link charges…** opens a
picker over the unaccounted charges with a running sum against the order total: check the charge(s)
that paid for it (several, if it was split) and link them. A mismatched sum warns but doesn't block.

### I imported the Amazon items file before its orders file

The items had no orders to attach to, so they were **discarded** (nothing entered the ledger) — the
file shows struck-through on its card, and the import-detail report lists exactly which order ids were
skipped and from which file. Import the orders file, then re-import the same items file: it is *not*
blocked as "already imported" (a file with discarded rows is deliberately not remembered), and its
items attach normally.

### I re-imported an Amazon file (or uploaded the same file twice)

Files are matched by **content**, not name: one that a completed import already took raises an
"already imported" alert at scan time, and acknowledging it drops the file from the selection — nothing
is re-processed and no new file card is created; the original card still covers it. Undoing an import
frees its files to be imported again. Use the file
card's outcome pills (orders / items matched / discarded / duplicates / payments) to open the
import-detail report and see what any import actually did, including which file each row came from.

## Tags (cross-cutting reporting)

Accounts have owners; **categories/groups do not**. The dimensions you report by — personal/shared,
essential/discretionary, business/personal — are **tags**, attached at whichever level fits
(transaction, leaf category, or group), and they're additive. Use tags rather than trying to encode
those dimensions in the account or category tree.

## In-app surfacing

The situations above are surfaced inside the app through the Help/FeatureExplainer registry
(`frontend/src/help/content.jsx`) — see `docs/ui-patterns.md` → *Help and contextual explainers* for
the pattern. Each situation is a help topic, reachable three ways from that single source: the `/help`
pages, an always-present `?` next to the relevant surface (the duplicate-report header, the Amazon
reconciliation and import-detail report headers, the amount-convention picker, the Group Imported
Categories title, the Accounts merge area, the rule-suggestion review, the file-ledger search and
removed-as-duplicates list), and a context-triggered
"explain this" tip that appears only when the app recognizes the situation (cross-account matches,
covered-range ±2-day and no-match rows, unknown-source files, rule-suggestion conflicts).

**This doc remains the content source of truth.** When a reconciliation tool changes, update the
situation here first, then reconcile the matching help topic so the in-app copy doesn't drift.
