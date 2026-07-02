# Recurring detection — deferred follow-ups

The recurring-series subsystem is **shipped** (see `data-model.md` → Recurring series and
`architecture.md` → Recurring series): schema (`recurring_series` + `txn.recurring_series_id`,
migration v4), the timing-regularity detector (`backend/services/recurring_detection.py`), the API
(`backend/routers/recurring.py`), and the `/recurring` page with confirm/suppress/edit/manual-create
curation. The scan runs both on demand and automatically (after import/sync, plus a watermark-gated app-
load catch-up — see item 1). Backup coverage and detection tests are in place.

The **ended/canceled lifecycle** is also implemented (minimal): `status='ended'` keeps a stopped
series as history (transactions stay linked, excluded from forecasts) without blocking re-detection —
its `next_due` is frozen and a rescan reactivates it if a charge lands on/after that date (resubscribe).
Ended is set by the user today (confirmed-series button / detected-series "Mark canceled" split
control); the **auto-end trigger** (a missed expected charge concluding the series ended) is part of
the deferred anomaly work below, as are the forecast/history surfaces that give ended its full payoff.

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

Not yet pushed further: the payee filter is still applied *after* a full pool load (a future optimization
could push it into the SQL once `payee_key` is materialized rather than derived). Worth doing only if the
load itself becomes a cost on real data.

## 2. Anomaly / forecast signals

The series records exist precisely to power these; none are surfaced yet. **Wiring seam:** the natural
home for the event-driven anomalies (missed/duplicated/off-amount) is `scan_imported_payees` — it runs on
every import/sync, knows exactly which payees changed, and has just refreshed their `next_due_date` /
`expected_amount` / `amount_min`–`amount_max` / membership. It's marked in that function; adding detection
there needs no change to the scan or its callers. The forward-looking views (upcoming charges) read the
same persisted stats and can render off the series list directly.

The signals:

- **Upcoming charges** — a forward view from `next_due_date` + `expected_amount` (cash-flow hint,
  natural Tasks/dashboard surface).
- **Missed charge** — an expected occurrence didn't arrive within tolerance of `next_due_date`
  (canceled service / failed payment).
- **New recurring detected** — a newly-formed series since last review (the forgotten free trial that
  started billing) — distinct from the full list.
- **Price change** — a charge outside the established `amount_min`/`amount_max` band (a hike).

## 3. "Mark as recurring" from a transaction row — DONE

Shipped, but the design evolved past a simple `POST /recurring` shortcut. Because forcing users to rename
merchants so the *derived* detector groups a varying-name payee is the wrong ask, the user-driven path is
now **rule-backed series** (`is_recurring` on a rule; membership = the rule's matches — see `data-model.md`
→ Recurring series). Entry points: the shared `ContextMenu`'s "Mark as recurring…" routes into the rule
editor (`RuleActionModal`) recurring-focused; the transaction editor (`TransactionDetail`) gained a general
**Rule** button plus a recurring **status row** that links to the series' card on `/recurring`; the rule
editor (`RuleForm`) has the "Recurring series" checkbox + cadence. Surgical **pin/exclude overrides**
(`recurring_membership_override`, `POST /recurring/{id}/membership`, the menu's "Remove from recurring
series") handle one-off membership corrections that survive a scan. The lighter anchor-create dialog on
`/recurring` stays for a series you don't want a rule for.

## 4. Fixed vs. variable amount series + price-increase review (deferred — phase 2)

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

## Tuning notes

Detector constants live at the top of `recurring_detection.py`: `_CONFIDENCE_THRESHOLD` (emit bar),
`_SNAP_TOLERANCE` (gap→cadence snapping), `_FALLBACK_AMOUNT_CV_MAX` (amount-tightness gate for the
amount-cluster fallback), and the long-period 2-occurrence allowance (`_LONG_PERIOD_DAYS`). The scan is
idempotent and re-runnable, so these can be tuned against real data without migrations.
