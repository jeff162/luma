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

### A covered-range row is off by a day or two, or has no match (±2 days / no specific match)

When an earlier import already covered a date range, every transaction in that range is expected to
already be in the ledger, so a new row landing inside it is rejected as a presumed duplicate and paired
against the existing data by date and amount — the exact date first, then ±1 day, then ±2 days. Two of
the pairing outcomes are surfaced for review:

- **Matched ±2 days** — a counterpart turned up only after the window widened to ±2 days. Posting dates
  drift between sources for several reasons — pending-vs-posted timing, weekend or holiday settlement,
  and time-zone differences on foreign charges — so the same transaction can sit a day or two apart in
  two sources. After the pair is confirmed, **Mark reviewed** in bulk (or per row) clears it from the
  needs-attention list. If a pair is *not* the same transaction, select the rows and **import both**.
- **No specific match** — the date is covered but nothing paired at all, even at ±2 days. This is the
  one to actually investigate: usually a row present in one source and genuinely missing from the
  other, in which case **Import anyway** keeps it.

A covered row that pairs cleanly on the exact date or ±1 day stays rejected without being flagged — only
the two cases above need a look.

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

## Tags (cross-cutting reporting)

Accounts have owners; **categories/groups do not**. The dimensions you report by — personal/shared,
essential/discretionary, business/personal — are **tags**, attached at whichever level fits
(transaction, leaf category, or group), and they're additive. Use tags rather than trying to encode
those dimensions in the account or category tree.

## In-app surfacing

The situations above are surfaced inside the app through the Help/FeatureExplainer registry
(`frontend/src/help/content.jsx`) — see `docs/ui-patterns.md` → *Help and contextual explainers* for
the pattern. Each situation is a help topic, reachable three ways from that single source: the `/help`
pages, an always-present `?` next to the relevant surface (the duplicate-report header, the
amount-convention picker, the Group Imported Categories title, the Accounts merge area, the rule-
suggestion review, the file-ledger search and removed-as-duplicates list), and a context-triggered
"explain this" tip that appears only when the app recognizes the situation (cross-account matches,
covered-range ±2-day and no-match rows, unknown-source files, rule-suggestion conflicts).

**This doc remains the content source of truth.** When a reconciliation tool changes, update the
situation here first, then reconcile the matching help topic so the in-app copy doesn't drift.
