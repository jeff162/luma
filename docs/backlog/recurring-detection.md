# Recurring detection — deferred follow-ups

The recurring-series subsystem is **shipped** (see `data-model.md` → Recurring series and
`architecture.md` → Recurring series): schema (`recurring_series` + `txn.recurring_series_id`,
migration v4), the timing-regularity detector (`backend/services/recurring_detection.py`), the API
(`backend/routers/recurring.py`), and the `/recurring` page with confirm/suppress/edit/manual-create
curation. The scan runs both on demand and automatically (after import/sync, plus a watermark-gated app-
load catch-up — see item 1). Backup coverage and detection tests are in place.

The **anomaly/forecast signals** (§2) are also shipped — derived on read, with per-finding dismissal.

The **ended/canceled lifecycle** is also implemented (minimal): `status='ended'` keeps a stopped
series as history (transactions stay linked, excluded from forecasts) without blocking re-detection —
its `next_due` is frozen and a rescan reactivates it if a charge lands on/after that date (resubscribe).
Ended is set by the user (confirmed-series button / detected-series "Mark canceled" split control, or
"Mark ended" on a missed-charge signal). The missed-charge signal is the **auto-end trigger** in the only
form it should take: it derives "presumed ended" after two whole missed periods and offers the action —
it never writes the status itself.

The first cut was deliberately scoped to **detect + list + curate**. The following were left for later:

## 1. Automatic + scoped detection — DONE

Detection no longer waits for a manual scan, and the automatic triggers use the cheap scoped path:

- **Scoped** (`scan_imported_payees`): a completed CSV import or Plaid sync reprocesses only the payees
  the batch touched — matching new charges into existing series and detecting new series among those
  payees — instead of re-scanning the whole ledger.
- **Full catch-up** (`POST /recurring/auto-scan` → `maybe_auto_scan`): a watermark-gated global scan on
  app load, covering never-scanned/migrated databases and the cross-payee/normalization effects a scoped
  pass can't see. See `data-model.md` → Recurring series.

This landed on a shared core rather than a second code path: `scan_and_store` takes an optional
`payee_keys` scope, and both scopes route through the `reconcile_series` matching core (shared with
`link_series_members`). Correctness is independent of the pool's breadth — `_match_members` filters by
each series' own payee/category/account — so scope changes only cost, not outcome. The one thing a scoped
pass skips is the global payee-key re-derivation (the full catch-up owns it).

- **Hand edits** (`rescan_edited_transactions`, 2026-08-27): the transaction edit endpoints run the same
  scoped scan for the payees an edit touched. Membership is a cache only a scan rewrites, so without it a
  recategorized row stayed linked to the series it had left — see `data-model.md` → Recurring series.

**The parked pool-load optimization is now worth more.** The payee filter is still applied *after* a full
pool load, so a scoped scan costs what a full one does: **measured at ~125 ms against ~124 ms on a
20,000-row synthetic ledger**. That was academic while scans only followed an import; it is now on the
path of every category edit, and it grows with the ledger. Pushing the filter into SQL needs `payee_key`
materialized on `txn` rather than derived in Python — a column, a backfill, and maintenance at every
write site, which is why it has not been taken. The two mitigations in place instead: a no-op edit
(re-saving the same category) skips the scan entirely, and a bulk edit scans **once for the batch**, so
the cost is per request rather than per row.

Worth revisiting when either the measured edit latency or the ledger size makes ~125 ms per edit
noticeable — call it a ledger past roughly 50,000 rows, where the same measurement would be nearer 300 ms.

## 2. Anomaly / forecast signals — DONE

All four shipped, plus a fifth that fell out of the same design (rule amount-range drift). Detail and
rationale live in `data-model.md` → Recurring series and `architecture.md` → Recurring series; what
belongs here is what the design as written got wrong.

**The wiring seam named below was not used, and the note in `scan_imported_payees` is now wrong.**
Signals are derived on read (`services/recurring_signals.py`), not fired from the import/sync scan. Two
reasons, both fatal to the event-driven version:

- An auto series is deleted and re-inserted with a fresh id on every scan, so anything stored against a
  series id is orphaned within a day.
- A finding written at import time goes stale on the next recategorize, trash, or membership override.

Two things the design as written could not have done:

- **"A charge outside the established `amount_min`/`amount_max` band" is not implementable.**
  `_write_series_stats` rewrites that band from exactly the rows the series owns, so the hiked charge is
  *inside* it by the time anything looks. Price change had to be measured against the occurrences
  preceding the latest charge — which is also what let the fixed/variable distinction below fall out for
  free, since the prior amounts say which kind of series it is.
- **"Missed" had to be judged against data freshness, not the calendar.** Against `date.today()`, a
  month without an import reports every active series as missing.

Also fixed on the way: **`recurring_series.created_at` now means "first detected"**, carried across the
auto-series re-mint by identity tuple. Without it "new since you last looked" could never be answered —
every daily catch-up re-minted the row and reset the column.

**Found by using it, not by the tests** (the class a unit suite cannot see): the findings were first
rendered into the Recurring page's *pinned* header, which is `flexShrink: 0` over a `minHeight: 0` body,
so a real ledger's nine findings collapsed the series list and the drill-down region to zero height —
opening a series drew its report into nothing and read as a dead button.

Capping the section's height fixed the symptom; **the diagnosis was that findings and the series they
refer to had no business sharing a viewport.** The page is now three peer views on the shared
`SegmentedToggle` — **Series / Needs attention / Upcoming** — each owning the scrolling body, with the
open-findings count as a badge on the control (a count only visible after switching cannot tell anyone
to switch). Filter/sort/search travel with the series view alone. Upcoming was promoted out of the findings panel at
the same time, which is what its own "not an anomaly" argument implied all along.

A finding's **Open series** first *switched* to the series view with that drill-down open. That was
wrong twice: it took the user out of the findings they were working through, and the series list's own
filter can exclude the series being opened — a Confirmed series while only Suggested is selected — so the
drill-down described a card that was nowhere on screen. The panel now opens **in place** under whichever
view is showing, and the finding that opened it is marked the way a series card is. **Don't re-impose
the view switch.**

Fixed alongside: the page had three different left margins (header, cards, drill-down) because
`maxWidth` sat on padded elements, which measures the column inside the padding. One named `PAGE_COLUMN`
now, applied inside the padding everywhere.

Recorded in `ui-patterns.md` three times over: nothing variable-length belongs in a pinned header; split
a page into views when two things compete for one viewport rather than rationing the space, but bring
the detail to the user rather than the user to the detail; and measure a content column inside the
padding, not on it.

**Seasonal amounts (added 2026-08-27).** A gas or electric bill swings with the season, and the first
build reported every winter peak afresh because the range came from a trailing window that no longer
held last year's. Rejected: modelling seasonality from dates. Taken instead: dismissals widen the range
(`_load_accepted_amounts`), so the envelope is learned from what the user accepts. Two things fixed in
the same pass — tightness is now judged over the whole history (a run of winter bills looked *tight*, so
the series was classified fixed-price and the spring read as a collapse), and the code now matches its
own comment, which had claimed the range covered "everything this series has ever done" while the code
looked at four occurrences.

**Don't re-impose:**

- *Upcoming as a task.* It is a forward view on `/recurring` with no actions and no badge. Settled with
  the user: some people will not care, it is a budgeting aid rather than a "where did my money go"
  question, and a badge that counts ordinary life stops meaning anything.
- *Auto-writing `status='ended'` on a missed charge.* Presumed-ended is derived and offers the action;
  the status is only ever written by the user.
- *Using the full member history as the variable range* instead of dismissals. It looks simpler and it
  does silence the seasonal nag — but it lets an outlier nobody triaged teach the band by itself, which
  is the opposite of the point: the band is meant to record what someone has actually accepted.
- *A duplicated-charge signal.* Deliberately out. The series case is already handled silently by
  `_one_per_date`, and the real double-charge case belongs to import dedupe. (The "missed / duplicated /
  off-amount" phrasing in the old docstrings predates the four-signal list and has been corrected.)

## 3. "Mark as recurring" from a transaction row — DONE

Shipped, but the design evolved past a simple `POST /recurring` shortcut. Because forcing users to rename
merchants so the *derived* detector groups a varying-name payee is the wrong ask, the user-driven path is
now **rule-backed series** (`is_recurring` on a rule; membership = the rule's matches — see `data-model.md`
→ Recurring series). Entry points: the shared `ContextMenu`'s "Mark as recurring…" routes into the rule
editor (`RuleActionModal`) recurring-focused; the transaction editor (`TransactionDetail`) gained a general
**Rule** button plus a recurring **status row** that links to the series' card on `/recurring`; the rule
editor (`RuleForm`) has the "Recurring series" checkbox + cadence. Surgical **exclusion overrides**
(`recurring_membership_override`, `POST /recurring/{id}/membership`, the menu's "Remove from recurring
series") handle one-off membership corrections that survive a scan.

**Don't re-propose pinning** (forcing a row *into* a series it does not match). It was built — endpoint,
reconcile handling, a partial unique index, docs and a Help paragraph — and never given a UI, then
withdrawn on the modelling argument: a series is defined by *what recurs*, so a charge that merely shares
a payee and category with one (a late fee on a tax payment) is not part of the series, and pinning it in
misrepresents the series and every total read from it. A row that ought to belong and does not is a
**matching** problem — fix the name, or widen the rule — which is what `rescan_edited_transactions` now
makes immediate. The endpoint rejects the state and `_load_overrides` filters on `'excluded'`; the index
survives only because dropping it would cost a migration for nothing. The lighter anchor-create dialog on
`/recurring` stays for a series you don't want a rule for.

## 4. Fixed vs. variable amount series + price-increase review — DONE

**Shipped 2026-09-01** (schema v46: `recurring_series.amount_mode` plus the pinned
`expected_min`/`expected_max`). The mechanism is in `data-model.md` → Recurring series; what stays here
is what the work found that the design as written did not know.

**Two live defects, not one missing feature.** The file framed this as "two fixed-price subscriptions
can't be separated". Measured against the code, the auto detector separated them *already* — but only
when both billed on the same day, and the separation did not survive contact with the user:

- **Confirming one destroyed the other.** `_covered_by_owned` keys on `(payee, category, account)`,
  which cannot tell two price points apart, so the unconfirmed sibling was suppressed as redundant and
  its charges were left linked to nothing. The act of endorsing a correct detection deleted its
  neighbour. Same collision in `_auto_first_seen`, where the two identities silently shared one
  `created_at`. Fixed by making the price point the tuple's fourth component.
- **Different billing days merged them outright.** `_detect_in_group` only fell back to amount
  clustering when the whole set produced *no* rhythm — and a $4 and a $20 monthly charge a fortnight
  apart interleave into a perfectly plausible **biweekly** series at $12 spanning `[-20, -4]`, a
  cadence, an expected amount and a band describing nothing that happens. Fixed by reading the group
  both ways and preferring the split when the whole-set reading is amount-incoherent, the split
  explains at least as many charges, and each price point holds a rhythm of its own.

**The promote-on-pin question answered itself.** An edit already marks a series user-owned
(`update_series` sets `confirmed = 1`), and a user-owned series is never re-minted — so a pinned band
needs no carry across the rebuild, unlike `created_at`. The identity tuple still needed the amount
component, but for coverage rather than for carrying state.

**Don't re-impose:**

- *Gating every amount-tight series.* Only a series whose group resolved into more than one gets the
  gate. A lone series has nothing to be confused with, and turning it on there would evict its own
  charges the first time a price moved.
- *Ordering a typed band before applying its sign.* The dialog takes magnitudes and the ledger stores a
  direction; negating swaps which bound is the lower one, so ordering first sends an inverted band for
  every expense series. Caught by a test, invisible on screen.
- *Reusing `AmountCondition` for the pinned band.* The shared control carries per-bound comparators and
  a debit/credit side; a series band is inclusive at both ends and its direction is already settled by
  its own charges, so the shared contract is the wrong one rather than merely a heavier one.

**The *tentative pending price* resolved into an action, not a review surface.** §2 had already
established that the pending price is a derivation rather than stored state (one off-price charge is an
anomaly, three at the new price are a step), so nothing needed storing — what was missing was a way to
*promote* a step. The price-change finding now offers **Accept new amount** on a gated series.

Three things it settled, all worth not re-deriving:

- **Extend the band, never relocate it.** `_match_members` re-filters the whole pool every scan, so a
  band moved onto the new price stops matching the series' own history — measured, an eight-charge
  series dropped to **one**. Only the bound the charge falls outside moves.
- **Accepting cannot mask the next change.** The concern recorded against widening on *dismissal*
  (`_load_accepted_amounts`) does not transfer: that widens the **comparison set** a later charge is
  judged against, while accepting moves the **membership gate**. `_price_change` takes its baseline from
  the recent *occurrences*, never from the stored band, so the next step is measured the same either way.
- **It must pin.** A derived band cannot learn a charge the gate is excluding — the charge can't become
  a member, so the scan never sees it. Accepting writes `expected_min`/`expected_max`, which is what
  breaks that deadlock.

**Offered only where amount gates membership.** On an ungated series the band is read by nothing, so a
button that moved it would be theatre; there, **Dismiss is the accept** — it records the amount as one
the user has allowed, which is precisely what a variable series' envelope is learned from. Unlike a
rule's *Widen to include* it opens the editor on a proposal rather than applying it: a rule bound has one
right answer, a series band has two ends, and only the user knows whether a rise lifted every bill or
added a single outlier. **The same holds downward** — a utility posting its cheapest month yet widens
the floor.

**Still not built:** nothing here. The remaining recurring items are the pool-load optimization (§1) and
whatever a later pass wants from the tuning constants.

### Original entry (the design as it stood)


The follow-on the rule-backed work was scoped *out* of. Today amount is never part of series identity
(`_match_members`/rule matching ignore it), which is right for variable bills but means two same-payee,
same-category **fixed-price** subscriptions (e.g. NYT at $4 and $20) can't be separated on the manual/rule
path. The idea: an explicit **fixed vs. variable** flag; for a fixed series amount becomes part of the
identity (amount-gated membership), which both separates the two subs and enables **price-increase
detection**. Price steps are inherently stateful — one off-price charge can't distinguish a hike from a
one-off — so a fixed series would carry a *tentative pending price*: a new charge within ~20% of the
established price is flagged for review (not auto-merged) until enough occurrences confirm the step, then
the price point is promoted or the row rejected. This overlaps the anomaly work in §2 (price change /
off-amount) and needs its own review surface, which is why it's its own phase.

**What §2 settled that this should build on:**

- An explicit `amount_mode` (`fixed` | `variable`) on the series, and an optional user-pinned expectation
  band (`expected_min`/`expected_max`, NULL = derived). The division of labour is settled: **the rule owns
  the matching gate, the series owns the expectation band.** A derived band self-adjusts and needs no
  maintenance; a pinned one is for the case a percentage cannot express — separating a town's water bill
  from its property tax by size — and is exactly the one that drifts.
- **Amount-gated membership needs a grace band, for the same reason a rule's amount range does.** A price
  hike on a fixed series would otherwise stop matching and fall out of its own series. That is the same
  mechanism as the rule near-miss shipped in §2, and the unifying rule is worth stating: *every amount
  gate in this subsystem needs a "just outside" grace band, and the signal is what lives in it.*
- The "tentative pending price" is a **derivation**, not stored state: one off-price charge is an
  anomaly, three at the new price are a step. Only the *promotion* of an amount-gated band needs a write.

## Tuning notes

Detector constants live at the top of `recurring_detection.py`: `_CONFIDENCE_THRESHOLD` (emit bar),
`_SNAP_TOLERANCE` (gap→cadence snapping), `_FALLBACK_AMOUNT_CV_MAX` (amount-tightness gate for the
amount-cluster fallback), and the long-period 2-occurrence allowance (`_LONG_PERIOD_DAYS`). The scan is
idempotent and re-runnable, so these can be tuned against real data without migrations.
