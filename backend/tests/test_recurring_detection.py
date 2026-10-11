"""
Recurring-series detection.

Detection is timing-driven and invariant-heavy (a noisy high-volume payee must NOT be mistaken for a
series; one payee may host several series split by category), so this exercises the behaviors that
would silently regress: a clean fixed series, a variable-amount bill, the town-with-three-cadences
case, rejection of irregular noise, and the idempotent-rebuild contract that preserves user curation.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from datetime import date, timedelta
from pathlib import Path

from fastapi import HTTPException

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.recurring import (
    SeriesUpdate, restore_series, suppress_series, update_series,
)
from backend.services.recurring_detection import (
    _LAST_SCAN_META_KEY,
    maybe_auto_scan,
    payee_keys_for_ids,
    scan_and_store,
    scan_imported_payees,
)


class RecurringDetectionTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "recurring-tests.db"
        init_db(str(self.db_path))
        self.account_id = str(uuid.uuid4())
        self.cats: dict[str, str] = {}
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO account (id, provider, name, display_name) VALUES (?, 'fixture', 'Checking', 'Checking')",
                    (self.account_id,),
                )
                unassigned = conn.execute("SELECT id FROM category WHERE system_key = 'unassigned'").fetchone()["id"]
                for label in ("Streaming", "Property Tax", "Excise", "Water"):
                    cid = str(uuid.uuid4())
                    conn.execute(
                        "INSERT INTO category (id, parent_id, name) VALUES (?, ?, ?)",
                        (cid, unassigned, label),
                    )
                    self.cats[label] = cid

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _add_series(self, *, payee, category, count, period_days, amount, amount_step=0.0, end=None):
        """Insert `count` charges `period_days` apart ending at `end` (default today)."""
        end = end or date.today()
        with self._use_db_path():
            with get_db() as conn:
                for i in range(count):
                    d = (end - timedelta(days=period_days * i)).isoformat()
                    amt = amount + amount_step * i
                    conn.execute(
                        """
                        INSERT INTO txn (id, account_id, owner_id, category_id, amount, merchant_name,
                                         display_name, raw_name, date)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (str(uuid.uuid4()), self.account_id, SHARED_OWNER_ID,
                         self.cats[category] if category is not None else None,
                         amt, payee, payee, payee, d),
                    )

    def _add_irregular(self, *, payee, category, gaps, amounts):
        end = date.today()
        offset = 0
        with self._use_db_path():
            with get_db() as conn:
                for gap, amt in zip(gaps, amounts):
                    offset += gap
                    d = (end - timedelta(days=offset)).isoformat()
                    conn.execute(
                        """
                        INSERT INTO txn (id, account_id, owner_id, category_id, amount, merchant_name,
                                         display_name, raw_name, date)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (str(uuid.uuid4()), self.account_id, SHARED_OWNER_ID, self.cats[category],
                         amt, payee, payee, payee, d),
                    )

    def _series(self, include_suppressed=False):
        with self._use_db_path():
            with get_db() as conn:
                where = "" if include_suppressed else "WHERE status != 'suppressed'"
                return [dict(r) for r in conn.execute(f"SELECT * FROM recurring_series {where}").fetchall()]

    def _scan(self):
        with self._use_db_path():
            with get_db() as conn:
                return scan_and_store(conn)

    def _scan_scoped(self, payee_keys):
        with self._use_db_path():
            with get_db() as conn:
                return scan_imported_payees(conn, set(payee_keys))

    def _watermark(self):
        with self._use_db_path():
            with get_db() as conn:
                row = conn.execute("SELECT value FROM db_meta WHERE key = ?", (_LAST_SCAN_META_KEY,)).fetchone()
                return row["value"] if row else None

    def _age_watermark(self, expr):
        with self._use_db_path():
            with get_db() as conn:
                conn.execute("UPDATE db_meta SET value = datetime('now', ?) WHERE key = ?",
                             (expr, _LAST_SCAN_META_KEY))

    def test_detects_fixed_monthly_series(self):
        self._add_series(payee="Netflix", category="Streaming", count=12, period_days=30, amount=15.99)
        self._scan()
        series = self._series()
        self.assertEqual(len(series), 1)
        self.assertEqual(series[0]["cadence"], "monthly")
        self.assertEqual(series[0]["display_name"], "Netflix")
        self.assertEqual(series[0]["occurrence_count"], 12)

    def test_detects_variable_amount_bill(self):
        # A utility bill recurs on schedule while its amount swings — timing carries it, amount does not gate.
        self._add_series(payee="City Electric", category="Water", count=14, period_days=30,
                         amount=60.0, amount_step=7.0)
        self._scan()
        series = self._series()
        self.assertEqual(len(series), 1)
        self.assertEqual(series[0]["cadence"], "monthly")
        self.assertNotAlmostEqual(series[0]["amount_min"], series[0]["amount_max"])

    def test_one_payee_multiple_cadences_split_by_category(self):
        # The town: property tax quarterly, excise annually, water monthly — one payee, three series
        # separated by category.
        self._add_series(payee="Town of Springfield", category="Property Tax", count=8, period_days=91, amount=1800.0)
        self._add_series(payee="Town of Springfield", category="Excise", count=3, period_days=365, amount=420.0)
        self._add_series(payee="Town of Springfield", category="Water", count=18, period_days=30, amount=55.0, amount_step=3.0)
        self._scan()
        cadences = sorted(s["cadence"] for s in self._series())
        self.assertEqual(cadences, ["annual", "monthly", "quarterly"])

    def test_irregular_high_volume_payee_is_not_a_series(self):
        # Amazon-style noise: many charges, irregular gaps, non-clustering amounts → detected as nothing,
        # with no name blocklist. This is the property that makes the feature usable.
        self._add_irregular(
            payee="Amazon",
            category="Streaming",
            gaps=[2, 9, 1, 14, 3, 6, 1, 21, 4, 2, 11, 1, 7, 3],
            amounts=[7.0, 42.0, 3.5, 128.0, 19.0, 64.0, 5.0, 210.0, 33.0, 12.0, 88.0, 4.0, 150.0, 27.0],
        )
        self._scan()
        self.assertEqual(self._series(), [])

    def test_scan_is_idempotent_and_preserves_confirmation(self):
        self._add_series(payee="Netflix", category="Streaming", count=12, period_days=30, amount=15.99)
        self._scan()
        first = self._series()
        self.assertEqual(len(first), 1)

        # Confirm it (user-owned), then re-scan: it must survive as the same row, not be duplicated.
        with self._use_db_path():
            with get_db() as conn:
                conn.execute("UPDATE recurring_series SET confirmed = 1 WHERE id = ?", (first[0]["id"],))
        summary = self._scan()
        second = self._series()
        self.assertEqual(len(second), 1)
        self.assertEqual(second[0]["id"], first[0]["id"])
        self.assertEqual(summary["preserved"], 1)
        # Membership was reassigned to the preserved series.
        with self._use_db_path():
            with get_db() as conn:
                linked = conn.execute(
                    "SELECT COUNT(*) FROM txn WHERE recurring_series_id = ?", (first[0]["id"],)
                ).fetchone()[0]
        self.assertEqual(linked, 12)

    def _add_two_price_points(self, *, offset_days):
        """Two fixed-price subscriptions from one biller, same category, at distinct price points.
        `offset_days` shifts the second one's billing day relative to the first."""
        self._add_series(payee="Harborline Digest", category="Streaming", count=8, period_days=30, amount=-4.00)
        self._add_series(payee="Harborline Digest", category="Streaming", count=8, period_days=30,
                         amount=-20.00, end=date.today() - timedelta(days=offset_days))

    def test_two_price_points_on_the_same_billing_day_are_separate_series(self):
        # One biller, one category, two fixed-price subscriptions. Amount is what tells them apart.
        self._add_two_price_points(offset_days=0)
        self._scan()
        series = self._series()
        self.assertEqual(len(series), 2)
        self.assertEqual({round(s["expected_amount"], 2) for s in series}, {-4.00, -20.00})
        for s in series:
            self.assertEqual(s["occurrence_count"], 8)

    def test_two_price_points_on_different_billing_days_are_separate_series(self):
        # Same pair, billing a fortnight apart. The interleaved dates form a plausible biweekly rhythm
        # over the whole set, which must not be preferred to the two real monthly series: doing so
        # invents a cadence, an expected amount ($12) and a band ([-20,-4]) that describe nothing.
        self._add_two_price_points(offset_days=15)
        self._scan()
        series = self._series()
        self.assertEqual(len(series), 2)
        self.assertEqual({s["cadence"] for s in series}, {"monthly"})
        self.assertEqual({round(s["expected_amount"], 2) for s in series}, {-4.00, -20.00})

    def test_confirming_one_price_point_does_not_orphan_the_other(self):
        # Confirming a correctly-detected series must not destroy its sibling. The candidate-coverage
        # check keys on (payee, category, account), which cannot tell two price points apart, so the
        # unconfirmed sibling was suppressed as redundant and its charges left linked to nothing.
        self._add_two_price_points(offset_days=0)
        self._scan()
        small = min(self._series(), key=lambda s: abs(s["expected_amount"]))
        with self._use_db_path():
            with get_db() as conn:
                conn.execute("UPDATE recurring_series SET confirmed = 1 WHERE id = ?", (small["id"],))
        self._scan()

        series = self._series()
        self.assertEqual(len(series), 2)
        self.assertEqual({round(s["expected_amount"], 2) for s in series}, {-4.00, -20.00})
        with self._use_db_path():
            with get_db() as conn:
                orphaned = conn.execute(
                    "SELECT COUNT(*) FROM txn WHERE display_name = 'Harborline Digest'"
                    " AND recurring_series_id IS NULL"
                ).fetchone()[0]
        self.assertEqual(orphaned, 0)

    def test_price_hike_stays_in_its_series(self):
        # An amount-gated series must not drop a charge that steps past its band — the gate needs a
        # grace band, or a price rise evicts the charge from the very series that should report it.
        self._add_series(payee="Harborline Digest", category="Streaming", count=8, period_days=30, amount=-4.00)
        self._add_series(payee="Harborline Digest", category="Streaming", count=8, period_days=30, amount=-20.00)
        self._scan()
        small = min(self._series(), key=lambda s: abs(s["expected_amount"]))
        with self._use_db_path():
            with get_db() as conn:
                conn.execute("UPDATE recurring_series SET confirmed = 1 WHERE id = ?", (small["id"],))
                # The next month's charge arrives 10% higher.
                conn.execute(
                    """
                    INSERT INTO txn (id, account_id, owner_id, category_id, amount, merchant_name,
                                     display_name, raw_name, date)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (str(uuid.uuid4()), self.account_id, SHARED_OWNER_ID, self.cats["Streaming"],
                     -4.40, "Harborline Digest", "Harborline Digest", "Harborline Digest",
                     (date.today() + timedelta(days=30)).isoformat()),
                )
        self._scan()
        with self._use_db_path():
            with get_db() as conn:
                linked = conn.execute(
                    "SELECT recurring_series_id FROM txn WHERE amount = -4.40"
                ).fetchone()["recurring_series_id"]
        self.assertEqual(linked, small["id"])

    def test_pinned_band_separates_two_bills_a_percentage_cannot(self):
        # A town billing water monthly and property tax quarterly, at sizes close enough that each sits
        # inside the other's grace margin. The derived bands overlap, so only an explicit bound separates
        # them — which is the whole reason the pinned band exists.
        self._add_series(payee="Northgate Township", category="Water", count=8, period_days=30, amount=-100.0)
        with self._use_db_path():
            with get_db() as conn:
                sid = str(uuid.uuid4())
                conn.execute(
                    "INSERT INTO recurring_series (id, payee_key, display_name, category_id, cadence, "
                    "period_days, expected_amount, amount_min, amount_max, amount_mode, expected_min, "
                    "expected_max, occurrence_count, confidence, status, source, confirmed) "
                    "VALUES (?, 'northgate township', 'Northgate Township', ?, 'monthly', 30, -100.0, "
                    "-100.0, -100.0, 'fixed', -110.0, -90.0, 0, 1.0, 'active', 'manual', 1)",
                    (sid, self.cats["Water"]),
                )
                # A charge just outside the pinned band, but well inside a 25% grace on the derived one.
                conn.execute(
                    """
                    INSERT INTO txn (id, account_id, owner_id, category_id, amount, merchant_name,
                                     display_name, raw_name, date)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (str(uuid.uuid4()), self.account_id, SHARED_OWNER_ID, self.cats["Water"], -118.0,
                     "Northgate Township", "Northgate Township", "Northgate Township",
                     date.today().isoformat()),
                )
        self._scan()
        with self._use_db_path():
            with get_db() as conn:
                claimed = conn.execute(
                    "SELECT recurring_series_id FROM txn WHERE amount = -118.0"
                ).fetchone()["recurring_series_id"]
        self.assertNotEqual(claimed, sid)  # outside the pinned band — not this series' charge

    def test_a_scan_never_rewrites_a_pinned_band(self):
        # The derived band is the scan's to rewrite from the rows the series owns; the pinned one is the
        # user's claim. Keeping them in separate columns is what makes that true, so pin it and check.
        self._add_series(payee="Harborline Digest", category="Streaming", count=8, period_days=30, amount=-4.00)
        self._scan()
        sid = self._series()[0]["id"]
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "UPDATE recurring_series SET confirmed = 1, amount_mode = 'fixed', "
                    "expected_min = -5.0, expected_max = -3.0 WHERE id = ?", (sid,)
                )
        self._scan()
        with self._use_db_path():
            with get_db() as conn:
                row = conn.execute(
                    "SELECT amount_min, amount_max, expected_min, expected_max FROM recurring_series WHERE id = ?",
                    (sid,),
                ).fetchone()
        self.assertEqual((row["expected_min"], row["expected_max"]), (-5.0, -3.0))  # pin intact
        self.assertEqual((row["amount_min"], row["amount_max"]), (-4.0, -4.0))      # derived still derived

    def test_editing_amount_matching_reassigns_membership_immediately(self):
        # Turning the amount gate on must take effect now, not at the next scan: the card reports its
        # members straight after the edit, so a deferred re-match reads as the edit having done nothing.
        self._add_two_price_points(offset_days=0)
        self._scan()
        small = min(self._series(), key=lambda s: abs(s["expected_amount"]))
        with self._use_db_path():
            updated = update_series(small["id"], SeriesUpdate(
                amount_mode="fixed", expected_min=-5.0, expected_max=-3.0))
        self.assertEqual(updated["amount_mode"], "fixed")
        self.assertEqual((updated["expected_min"], updated["expected_max"]), (-5.0, -3.0))
        self.assertEqual(updated["occurrence_count"], 8)  # only the $4 charges

        # Retracting the pin needs the explicit flag — a null bound means "unchanged" everywhere else.
        with self._use_db_path():
            reverted = update_series(small["id"], SeriesUpdate(clear_expected_band=True))
        self.assertIsNone(reverted["expected_min"])
        self.assertIsNone(reverted["expected_max"])
        self.assertEqual(reverted["amount_mode"], "fixed")  # the gate itself is a separate decision

    def test_a_pinned_band_needs_both_bounds(self):
        self._add_series(payee="Harborline Digest", category="Streaming", count=8, period_days=30, amount=-4.00)
        self._scan()
        sid = self._series()[0]["id"]
        with self._use_db_path():
            with self.assertRaises(HTTPException) as caught:
                update_series(sid, SeriesUpdate(expected_min=-5.0))
        self.assertEqual(caught.exception.status_code, 400)

    def test_same_date_outlier_not_folded_into_series(self):
        # A quarterly series and an annual payment landing on the SAME date (tax day) must not merge: the
        # annual is dropped from the quarterly series, not summed into it. Regression for the bug where a
        # card showed 3 occurrences while the report listed 4 transactions with an inflated ($20,771) range.
        today = date.today()
        self._add_series(payee="Internal Revenue Service", category="Property Tax",
                         count=4, period_days=91, amount=3800.0)
        # An annual filing sharing the second quarterly date.
        self._add_series(payee="Internal Revenue Service", category="Property Tax",
                         count=1, period_days=1, amount=16971.0, end=today - timedelta(days=91))
        self._scan()

        quarterly = [s for s in self._series() if s["cadence"] == "quarterly"]
        self.assertEqual(len(quarterly), 1)
        series = quarterly[0]
        self.assertEqual(series["occurrence_count"], 4)
        self.assertLess(series["amount_max"], 10000)  # not the summed 3800 + 16971 = 20,771

        with self._use_db_path():
            with get_db() as conn:
                linked = conn.execute(
                    "SELECT COUNT(*) FROM txn WHERE recurring_series_id = ?", (series["id"],)
                ).fetchone()[0]
                annual_series_id = conn.execute(
                    "SELECT recurring_series_id FROM txn WHERE amount = 16971.0"
                ).fetchone()["recurring_series_id"]
        self.assertEqual(linked, 4)                       # report count matches the card's occurrence count
        self.assertNotEqual(annual_series_id, series["id"])  # the annual is not a member of the quarterly series

    def test_overlapping_series_membership_is_exclusive_and_counts_match(self):
        # Two confirmed series for the same payee+category — one account-scoped, one account-agnostic —
        # must not double-count or diverge: each series' occurrence_count must equal its linked-row count,
        # and every transaction belongs to exactly one series. Regression for the "27 charges but only 3
        # shown" bug (occurrence_count computed from the match set while membership was last-writer-wins).
        self._add_series(payee="Audible", category="Streaming", count=6, period_days=30, amount=9.99)
        with self._use_db_path():
            with get_db() as conn:
                cat = self.cats["Streaming"]
                for acct in (self.account_id, None):  # account-scoped + account-agnostic, same payee+cat
                    conn.execute(
                        "INSERT INTO recurring_series (id, payee_key, display_name, category_id, account_id, "
                        "cadence, period_days, expected_amount, amount_min, amount_max, occurrence_count, "
                        "confidence, status, source, confirmed) "
                        "VALUES (?, 'audible', 'Audible', ?, ?, 'monthly', 30, 9.99, 9.99, 9.99, 99, 1.0, 'active', 'auto', 1)",
                        (str(uuid.uuid4()), cat, acct),
                    )
        self._scan()

        with self._use_db_path():
            with get_db() as conn:
                rows = conn.execute(
                    "SELECT id, account_id, occurrence_count FROM recurring_series WHERE payee_key = 'audible'"
                ).fetchall()
                linked = {
                    r["id"]: conn.execute(
                        "SELECT COUNT(*) FROM txn WHERE recurring_series_id = ?", (r["id"],)
                    ).fetchone()[0]
                    for r in rows
                }
                total_linked = conn.execute(
                    "SELECT COUNT(*) FROM txn WHERE recurring_series_id IN (SELECT id FROM recurring_series WHERE payee_key = 'audible')"
                ).fetchone()[0]

        self.assertEqual(len(rows), 2)  # both user-owned survive; dedup didn't mint a third auto series
        for r in rows:
            self.assertEqual(r["occurrence_count"], linked[r["id"]])  # count == actual membership
        self.assertEqual(total_linked, 6)  # the 6 charges, each linked once — no double-counting
        scoped = next(r for r in rows if r["account_id"] == self.account_id)
        self.assertEqual(linked[scoped["id"]], 6)  # the account-scoped series (priority) owns them all

    def test_manual_create_links_members_immediately(self):
        # A manually created series must link its matching transactions right away, without a scan.
        from backend.routers.recurring import create_series, SeriesCreate
        self._add_series(payee="Spotify", category="Streaming", count=6, period_days=30, amount=10.99)
        with self._use_db_path():
            with get_db() as conn:
                anchor = conn.execute("SELECT id FROM txn WHERE merchant_name = 'Spotify' LIMIT 1").fetchone()["id"]
            created = create_series(SeriesCreate(transaction_id=anchor, cadence="monthly"))
            with get_db() as conn:
                linked = conn.execute(
                    "SELECT COUNT(*) FROM txn WHERE recurring_series_id = ?", (created["id"],)
                ).fetchone()[0]
        self.assertEqual(created["source"], "manual")
        self.assertEqual(created["occurrence_count"], 6)
        self.assertEqual(linked, 6)

    def test_ended_series_stays_ended_then_resumes_on_resubscribe(self):
        # Ended is distinct from suppressed: it stays ended across scans while there's no new activity,
        # but a charge on/after its frozen next_due (a resubscribe) reactivates it — the invariant that
        # makes "canceled" different from "not recurring".
        from backend.routers.recurring import end_series
        self._add_series(payee="Hulu", category="Streaming", count=8, period_days=30, amount=12.99)
        self._scan()
        sid = self._series()[0]["id"]
        with self._use_db_path():
            with get_db() as conn:
                conn.execute("UPDATE recurring_series SET confirmed = 1 WHERE id = ?", (sid,))
            end_series(sid)

        def status():
            return next(s for s in self._series(include_suppressed=True) if s["id"] == sid)["status"]

        self._scan()  # no new activity → stays ended, next_due frozen
        self.assertEqual(status(), "ended")

        next_due = date.fromisoformat(next(s for s in self._series(include_suppressed=True) if s["id"] == sid)["next_due_date"])
        self._add_series(payee="Hulu", category="Streaming", count=1, period_days=30, amount=12.99,
                         end=next_due + timedelta(days=1))
        self._scan()
        self.assertEqual(status(), "active")

    def test_suppressed_series_is_not_reproposed(self):
        self._add_series(payee="Netflix", category="Streaming", count=12, period_days=30, amount=15.99)
        self._scan()
        sid = self._series()[0]["id"]
        with self._use_db_path():
            with get_db() as conn:
                conn.execute("UPDATE recurring_series SET status = 'suppressed' WHERE id = ?", (sid,))
        self._scan()
        # Nothing in the default (non-suppressed) list, and no second Netflix row was created.
        self.assertEqual(self._series(), [])
        self.assertEqual(len(self._series(include_suppressed=True)), 1)

    def test_suppressing_records_the_rows_it_held(self):
        # The count on a suppressed card and the rows its link opens have to be the same set. They cannot
        # be re-derived to agree: membership is a rhythm fit over one charge per date, not a predicate,
        # and matching on the payee instead missed rows the bank spelled differently while sweeping in
        # unrelated charges to the same counterparty. So the set is captured before the links are dropped.
        self._add_series(payee="Netflix", category="Streaming", count=12, period_days=30, amount=15.99)
        self._scan()
        sid = self._series()[0]["id"]
        with self._use_db_path():
            with get_db() as conn:
                held = [r["id"] for r in conn.execute(
                    "SELECT id FROM txn WHERE recurring_series_id = ? ORDER BY date, id", (sid,)).fetchall()]
            self.assertTrue(held, "precondition: the series owns rows before it is suppressed")
            suppressed = suppress_series(sid)

        self.assertEqual(suppressed["suppressed_member_ids"], held)
        self.assertEqual(len(suppressed["suppressed_member_ids"]), suppressed["occurrence_count"],
                         "the snapshot is what the card's count promises")
        with self._use_db_path():
            with get_db() as conn:
                still_linked = conn.execute(
                    "SELECT COUNT(*) FROM txn WHERE recurring_series_id = ?", (sid,)).fetchone()[0]
        self.assertEqual(still_linked, 0, "a suppressed series must still own no rows")

    def test_restoring_drops_the_snapshot(self):
        # A restored series owns rows again from the next scan, so a snapshot left behind would send the
        # drill-down to a frozen set while the card counted the live one — the same disagreement, mirrored.
        self._add_series(payee="Netflix", category="Streaming", count=12, period_days=30, amount=15.99)
        self._scan()
        sid = self._series()[0]["id"]
        with self._use_db_path():
            self.assertTrue(suppress_series(sid)["suppressed_member_ids"])
            self.assertIsNone(restore_series(sid)["suppressed_member_ids"])

    def test_a_suppression_survives_its_charges_being_categorized_later(self):
        # The rejection is keyed on an identity derived from the member rows, and their category is not
        # fixed — a rule or a hand edit moves it long afterwards. Treating a missing category as a
        # specific value let that mutation walk out from under the user's decision: the same payee, at
        # the same cadence and the same amounts, came back as a fresh suggestion, with nothing in either
        # row looking wrong. Suppressed while uncategorized is the case that actually happened.
        self._add_series(payee="Netflix", category=None, count=12, period_days=30, amount=15.99)
        self._scan()
        sid = self._series()[0]["id"]
        with self._use_db_path():
            with get_db() as conn:
                self.assertIsNone(conn.execute(
                    "SELECT category_id FROM recurring_series WHERE id = ?", (sid,)).fetchone()[0],
                    "precondition: the series was detected with no category")
                conn.execute("UPDATE recurring_series SET status = 'suppressed' WHERE id = ?", (sid,))
                conn.execute("UPDATE txn SET category_id = ? WHERE merchant_name = 'Netflix'",
                             (self.cats["Streaming"],))
        self._scan()
        self.assertEqual(self._series(), [], "the categorized charges must not be re-proposed")
        self.assertEqual(len(self._series(include_suppressed=True)), 1)

    def test_two_categories_on_one_payee_are_still_two_series(self):
        # The other half of the rule: a missing category is agnostic, but two categories that are both
        # present stay distinct. One payee can carry genuinely different obligations, and collapsing them
        # would destroy a correctly detected series the way ignoring the price point once did — so
        # confirming one must leave the other standing.
        self._add_series(payee="Multipay", category="Streaming", count=12, period_days=30, amount=9.99)
        self._add_series(payee="Multipay", category="Water", count=12, period_days=30, amount=88.00)
        self._scan()
        self.assertEqual(len(self._series()), 2, "precondition: two series, one per category")
        with self._use_db_path():
            with get_db() as conn:
                conn.execute("UPDATE recurring_series SET confirmed = 1 WHERE category_id = ?",
                             (self.cats["Streaming"],))
        self._scan()
        self.assertEqual(len(self._series()), 2, "confirming one must not swallow its sibling")

    def test_auto_scan_runs_when_never_scanned_and_stamps_watermark(self):
        # No watermark (a fresh, or migrated pre-recurring, database) → the catch-up must scan and record
        # when it ran, so subsequent loads can tell a scan is no longer due.
        self._add_series(payee="Netflix", category="Streaming", count=12, period_days=30, amount=15.99)
        self.assertIsNone(self._watermark())
        with self._use_db_path():
            with get_db() as conn:
                summary = maybe_auto_scan(conn)
        self.assertNotIn("skipped", summary)          # it actually scanned
        self.assertEqual(len(self._series()), 1)      # series detected
        self.assertIsNotNone(self._watermark())       # watermark stamped

    def test_auto_scan_skips_when_recent(self):
        # Guard proof: a fresh watermark makes the catch-up a true no-op. Delete the detected series after
        # the first scan; if the second call really skips, the series stay gone (it didn't rebuild).
        self._add_series(payee="Netflix", category="Streaming", count=12, period_days=30, amount=15.99)
        with self._use_db_path():
            with get_db() as conn:
                maybe_auto_scan(conn)                 # stamps a fresh watermark
                conn.execute("DELETE FROM recurring_series")
                result = maybe_auto_scan(conn)        # fresh watermark → skip
        self.assertTrue(result.get("skipped"))
        self.assertEqual(self._series(), [])          # skip really skipped — nothing was rebuilt

    def test_auto_scan_reruns_when_stale(self):
        # A watermark older than the interval → due again, so detection stays current on daily reopen.
        self._add_series(payee="Netflix", category="Streaming", count=12, period_days=30, amount=15.99)
        with self._use_db_path():
            with get_db() as conn:
                maybe_auto_scan(conn)
        self._age_watermark("-2 days")
        with self._use_db_path():
            with get_db() as conn:
                conn.execute("DELETE FROM recurring_series")
                result = maybe_auto_scan(conn)        # stale watermark → runs
        self.assertNotIn("skipped", result)
        self.assertEqual(len(self._series()), 1)      # series rebuilt from the ledger


    def test_scoped_scan_leaves_untouched_payees_alone(self):
        # A scoped rescan reprocesses only its payees. An unrelated auto series (and its membership) must
        # survive untouched — a *full* scan would delete-and-recreate it (new id), so an unchanged id is
        # the proof the scope actually narrowed the work rather than silently rescanning everything.
        self._add_series(payee="Netflix", category="Streaming", count=12, period_days=30, amount=15.99)
        self._add_series(payee="Hulu", category="Streaming", count=12, period_days=30, amount=12.99)
        self._scan()  # full: both detected
        before = {s["display_name"]: s for s in self._series()}
        self.assertEqual(set(before), {"Netflix", "Hulu"})
        hulu_id = before["Hulu"]["id"]

        self._scan_scoped(["netflix"])  # reprocess only Netflix

        after = {s["display_name"]: s for s in self._series()}
        self.assertEqual(set(after), {"Netflix", "Hulu"})
        self.assertEqual(after["Hulu"]["id"], hulu_id)  # untouched: same row, not deleted/recreated
        with self._use_db_path():
            with get_db() as conn:
                hulu_members = conn.execute(
                    "SELECT COUNT(*) FROM txn WHERE recurring_series_id = ?", (hulu_id,)
                ).fetchone()[0]
        self.assertEqual(hulu_members, 12)  # its membership is intact

    def test_scoped_scan_matches_new_charge_into_existing_series(self):
        # The "rule is the cache" path: a fresh charge for a payee that already has a (confirmed) series is
        # matched into it and its next_due advanced, via the scoped scan — no full rescan of the ledger.
        end = date.today()
        self._add_series(payee="Netflix", category="Streaming", count=11, period_days=30,
                         amount=15.99, end=end - timedelta(days=30))
        self._scan()
        sid = self._series()[0]["id"]
        with self._use_db_path():
            with get_db() as conn:
                conn.execute("UPDATE recurring_series SET confirmed = 1 WHERE id = ?", (sid,))
        self._add_series(payee="Netflix", category="Streaming", count=1, period_days=30, amount=15.99, end=end)

        self._scan_scoped(["netflix"])

        series = next(s for s in self._series() if s["id"] == sid)
        self.assertEqual(series["occurrence_count"], 12)  # the new charge folded into the same series
        with self._use_db_path():
            with get_db() as conn:
                linked = conn.execute(
                    "SELECT COUNT(*) FROM txn WHERE recurring_series_id = ?", (sid,)
                ).fetchone()[0]
        self.assertEqual(linked, 12)

    def test_scoped_scan_does_not_stamp_full_scan_watermark(self):
        # A scoped pass can't see cross-payee/normalization effects, so it must leave the full-scan
        # watermark alone — otherwise the daily global catch-up would wrongly consider itself not due.
        self._add_series(payee="Netflix", category="Streaming", count=12, period_days=30, amount=15.99)
        self.assertIsNone(self._watermark())
        self._scan_scoped(["netflix"])
        self.assertIsNone(self._watermark())

    def test_payee_keys_for_ids_matches_detector_normalization(self):
        # The import/sync scope is derived with the detector's own name resolution + normalization, so it
        # lines up with the series those rows match (store-number suffix dropped, etc.).
        self._add_series(payee="AMZN Mktp #12", category="Streaming", count=1, period_days=30, amount=5.0)
        self._add_series(payee="Netflix", category="Streaming", count=1, period_days=30, amount=15.99)
        with self._use_db_path():
            with get_db() as conn:
                ids = [r["id"] for r in conn.execute("SELECT id FROM txn").fetchall()]
                keys = payee_keys_for_ids(conn, ids)
        self.assertEqual(keys, {"amzn mktp", "netflix"})


    # --- Rule-backed series + pin/exclude overrides + lifecycle -----------------------------------

    def _add_txn(self, *, payee, category, amount, d, display=None):
        tid = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO txn (id, account_id, owner_id, category_id, amount, merchant_name, "
                    "display_name, raw_name, date) VALUES (?,?,?,?,?,?,?,?,?)",
                    (tid, self.account_id, SHARED_OWNER_ID, self.cats[category], amount, payee,
                     display or payee, payee, d),
                )
        return tid

    def _create_recurring_rule(self, keyword, *, cadence="monthly", category=None):
        from backend.routers.rules import create_rule, RuleCreate
        with self._use_db_path():
            res = create_rule(
                RuleCreate(keyword=keyword, is_recurring=True, cadence=cadence,
                           category_id=self.cats[category] if category else None),
                on_existing="reject",
            )
        return res["id"]

    def _series_for_rule(self, rule_id):
        with self._use_db_path():
            with get_db() as conn:
                row = conn.execute("SELECT * FROM recurring_series WHERE rule_id = ?", (rule_id,)).fetchone()
        return dict(row) if row else None

    def _members(self, series_id):
        with self._use_db_path():
            with get_db() as conn:
                return {r["id"] for r in conn.execute(
                    "SELECT id FROM txn WHERE recurring_series_id = ?", (series_id,)).fetchall()}

    def _rule_is_recurring(self, rule_id):
        with self._use_db_path():
            with get_db() as conn:
                row = conn.execute("SELECT is_recurring FROM category_rule WHERE id = ?", (rule_id,)).fetchone()
        return row["is_recurring"] if row else None

    def test_rule_backed_series_spans_payee_name_variants(self):
        # Two spellings that normalize to different payee keys (the phone-number tail doesn't strip to the
        # same key) — a derived series can't group them, but a keyword rule owns both. This is the whole
        # point of rule-backed membership.
        end = date.today()
        for i in range(6):
            name = "NYTIMES.COM" if i % 2 == 0 else "NYTimes NY TIMES 800 555 4637"
            self._add_txn(payee=name, category="Streaming", amount=17.0,
                          d=(end - timedelta(days=30 * i)).isoformat())
        rule_id = self._create_recurring_rule("nytimes")
        series = self._series_for_rule(rule_id)
        self.assertIsNotNone(series)
        self.assertEqual(series["source"], "rule")
        self.assertEqual(len(self._members(series["id"])), 6)   # linked immediately on rule save
        self.assertEqual(series["occurrence_count"], 6)         # count == linked rows
        self._scan()                                            # survives a full rebuild (rule, not key)
        self.assertEqual(len(self._members(series["id"])), 6)

    def test_rule_backed_membership_updates_when_rule_matcher_edited(self):
        self._add_txn(payee="Blue Apron", category="Streaming", amount=60.0, d=date.today().isoformat())
        self._add_txn(payee="Green Chef", category="Streaming", amount=60.0, d=date.today().isoformat())
        rule_id = self._create_recurring_rule("blue apron")
        series = self._series_for_rule(rule_id)
        self.assertEqual(len(self._members(series["id"])), 1)
        from backend.routers.rules import update_rule, RuleUpdate
        with self._use_db_path():
            update_rule(rule_id, RuleUpdate(keyword="chef"), on_existing="reject")
        self.assertEqual(len(self._members(series["id"])), 1)  # now matches Green Chef, not Blue Apron

    def test_a_row_cannot_be_forced_into_a_series_it_does_not_match(self):
        # Pinning was withdrawn deliberately. A series is defined by what recurs, so a charge that merely
        # shares a payee and category with one — a late fee on a tax payment — is not part of it, and
        # forcing it in would misrepresent the series and every total read from it. A row that ought to
        # belong and does not is a matching problem: fix the name, or widen the rule.
        self._add_series(payee="Gym", category="Streaming", count=6, period_days=30, amount=40.0)
        odd = self._add_txn(payee="ACH DEBIT 99", category="Water", amount=40.0,
                            d=(date.today() - timedelta(days=15)).isoformat())
        self._scan()
        gym = next(s for s in self._series() if s["display_name"] == "Gym")
        from backend.routers.recurring import set_membership, MembershipOverride
        with self._use_db_path():
            with self.assertRaises(HTTPException) as raised:
                set_membership(gym["id"], MembershipOverride(transaction_id=odd, state="pinned"))
        self.assertEqual(raised.exception.status_code, 400)
        self.assertNotIn(odd, self._members(gym["id"]))

    def test_exclude_removes_member_and_survives_scan(self):
        self._add_series(payee="Netflix", category="Streaming", count=6, period_days=30, amount=15.99)
        self._scan()
        nf = next(s for s in self._series() if s["display_name"] == "Netflix")
        victim = next(iter(self._members(nf["id"])))
        from backend.routers.recurring import set_membership, MembershipOverride
        with self._use_db_path():
            set_membership(nf["id"], MembershipOverride(transaction_id=victim, state="excluded"))
        self.assertNotIn(victim, self._members(nf["id"]))
        self._scan()  # a rescan that would otherwise re-match it leaves it out
        remaining = self._members(nf["id"])
        self.assertNotIn(victim, remaining)
        # occurrence_count stays equal to the linked-row count with the override applied.
        after = next(s for s in self._series() if s["id"] == nf["id"])
        self.assertEqual(after["occurrence_count"], len(remaining))

    def test_rule_backed_suppress_clears_flag_and_removes_series(self):
        self._add_txn(payee="Spotify", category="Streaming", amount=10.0, d=date.today().isoformat())
        rule_id = self._create_recurring_rule("spotify")  # recurring-only rule (no category)
        series = self._series_for_rule(rule_id)
        from backend.routers.recurring import suppress_series
        with self._use_db_path():
            res = suppress_series(series["id"])
        self.assertTrue(res.get("deleted"))
        self.assertIsNone(self._series_for_rule(rule_id))
        # A recurring-only rule would be actionless without its flag, so it goes to the rules trash —
        # flag intact, so restoring it brings the series back.
        with self._use_db_path():
            with get_db() as conn:
                row = conn.execute("SELECT is_recurring, deleted_at FROM category_rule WHERE id = ?", (rule_id,)).fetchone()
        self.assertIsNotNone(row["deleted_at"])
        self.assertEqual(row["is_recurring"], 1)

    def test_end_keeps_rule_flag_live(self):
        self._add_txn(payee="Patreon", category="Streaming", amount=5.0, d=date.today().isoformat())
        rule_id = self._create_recurring_rule("patreon", category="Streaming")
        series = self._series_for_rule(rule_id)
        from backend.routers.recurring import end_series
        with self._use_db_path():
            end_series(series["id"])
        self.assertEqual(self._rule_is_recurring(rule_id), 1)  # end != "not recurring"; resume stays possible
        after = self._series_for_rule(rule_id)
        self.assertEqual(after["status"], "ended")

    def test_uncheck_recurring_drops_series(self):
        self._add_txn(payee="Disney", category="Streaming", amount=8.0, d=date.today().isoformat())
        rule_id = self._create_recurring_rule("disney", category="Streaming")  # has a category action too
        self.assertIsNotNone(self._series_for_rule(rule_id))
        from backend.routers.rules import update_rule, RuleUpdate
        with self._use_db_path():
            update_rule(rule_id, RuleUpdate(is_recurring=False), on_existing="reject")
        self.assertIsNone(self._series_for_rule(rule_id))
        self.assertEqual(self._rule_is_recurring(rule_id), 0)  # the rule survives (it still assigns a category)

    def test_marking_recurring_on_existing_matcher_turns_that_rule_recurring(self):
        # A non-recurring rule already owns this matcher; "Mark as recurring" (merge) must flip it
        # recurring and mint the series rather than silently no-op on the duplicate.
        self._add_txn(payee="Netflix", category="Streaming", amount=15.99, d=date.today().isoformat())
        from backend.routers.rules import create_rule, RuleCreate
        with self._use_db_path():
            base = create_rule(RuleCreate(keyword="netflix", category_id=self.cats["Streaming"]),
                               on_existing="reject")
            self.assertEqual(base["status"], "created")
            merged = create_rule(
                RuleCreate(keyword="netflix", category_id=self.cats["Streaming"], is_recurring=True, cadence="monthly"),
                on_existing="merge",
            )
        self.assertEqual(merged["status"], "merged")
        self.assertEqual(self._rule_is_recurring(base["id"]), 1)
        series = self._series_for_rule(base["id"])
        self.assertIsNotNone(series)
        self.assertEqual(series["source"], "rule")

    def test_excluded_filter_returns_only_removed_rows(self):
        # The drill-down's "N removed" list reads through this filter, so a removed row must be reachable
        # to be added back.
        self._add_series(payee="Netflix", category="Streaming", count=6, period_days=30, amount=15.99)
        self._scan()
        nf = next(s for s in self._series() if s["display_name"] == "Netflix")
        victim = next(iter(self._members(nf["id"])))
        from backend.routers.recurring import set_membership, MembershipOverride
        from backend.routers.transactions import list_transactions
        with self._use_db_path():
            set_membership(nf["id"], MembershipOverride(transaction_id=victim, state="excluded"))
            result = list_transactions(
                month=None, date_start=None, date_end=None, import_batch_id=None,
                sort_by="date", sort_dir="desc", account_id=None, source_account_ids=None, category_id=None, direction=None, view=None,
                search=None, quick_filter=None, ids=None,
                recurring_excluded_series_id=nf["id"],
                needs_review=False, include_trashed=False, limit=200, offset=0,
            )
        self.assertEqual([r["id"] for r in result["transactions"]], [victim])
        # The row also carries the excluded-series id/name, which is what lets its right-click menu offer a
        # targeted "Restore to recurring series".
        row = result["transactions"][0]
        self.assertEqual(row["recurring_excluded_series_id"], nf["id"])
        self.assertEqual(row["recurring_excluded_series_name"], "Netflix")
        self.assertIsNone(row["recurring_series_id"])  # excluded → not a current member

    def test_delete_rule_removes_backed_series(self):
        self._add_txn(payee="Hulu", category="Streaming", amount=8.0, d=date.today().isoformat())
        rule_id = self._create_recurring_rule("hulu")
        series = self._series_for_rule(rule_id)
        from backend.routers.rules import delete_rule
        with self._use_db_path():
            delete_rule(rule_id)
        self.assertIsNone(self._series_for_rule(rule_id))
        self.assertEqual(self._members(series["id"]), set())


if __name__ == "__main__":
    unittest.main()
