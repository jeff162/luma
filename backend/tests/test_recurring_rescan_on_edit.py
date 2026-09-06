"""
Recurring membership after a hand edit.

`txn.recurring_series_id` is a cache only a scan rewrites, and until this landed nothing re-ran after a
manual edit: import and sync scan the payees they touched, a global recategorize scans everything, and
the app-load catch-up is watermark-gated to roughly a day. So recategorizing a bill left it linked to
the series it used to belong to — the row's menu opened the *old* series, the new series' drill-down
never gained it, and a missed-charge signal about the new series stayed open because its occurrences are
read through that same link. One stale cache, three symptoms, which is what these pin.

The contract is *re-evaluation*, not re-attachment: a row that still belongs where it was stays put.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from datetime import date, timedelta
from pathlib import Path

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.transactions import (
    BulkAction,
    BulkSelection,
    BulkUpdateRequest,
    CategoryOverride,
    bulk_update_transactions,
    override_category,
    update_merchant,
)
from backend.services.recurring_detection import scan_and_store
from backend.services.recurring_signals import compute_signals


class RecurringRescanOnEditTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "rescan-on-edit.db"
        init_db(str(self.db_path))
        self.account_id = str(uuid.uuid4())
        self.cats: dict[str, str] = {}
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO account (id, provider, name, display_name, type) "
                    "VALUES (?, 'fixture', 'Checking', 'Checking', 'depository')",
                    (self.account_id,),
                )
                unassigned = conn.execute("SELECT id FROM category WHERE system_key = 'unassigned'").fetchone()["id"]
                for label in ("Water", "Property Tax", "Misc"):
                    cid = str(uuid.uuid4())
                    conn.execute("INSERT INTO category (id, parent_id, name) VALUES (?, ?, ?)", (cid, unassigned, label))
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

    def _txn(self, *, payee, category, amount, when):
        txn_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO txn (id, account_id, owner_id, category_id, amount, merchant_name,
                                     display_name, raw_name, date)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (txn_id, self.account_id, SHARED_OWNER_ID, self.cats[category], amount,
                     payee, payee, payee, when.isoformat()),
                )
        return txn_id

    def _monthly(self, *, payee, category, count, amount, end=None, step_days=30):
        end = end or date.today()
        return [self._txn(payee=payee, category=category, amount=amount,
                          when=end - timedelta(days=step_days * i)) for i in range(count)]

    def _scan(self):
        with self._use_db_path():
            with get_db() as conn:
                return scan_and_store(conn)

    def _series_of(self, txn_id):
        with self._use_db_path():
            with get_db() as conn:
                row = conn.execute(
                    "SELECT s.display_name FROM txn t LEFT JOIN recurring_series s "
                    "ON s.id = t.recurring_series_id WHERE t.id = ?", (txn_id,)).fetchone()
        return row["display_name"]

    def _series_id_of(self, txn_id):
        with self._use_db_path():
            with get_db() as conn:
                return conn.execute("SELECT recurring_series_id FROM txn WHERE id = ?",
                                    (txn_id,)).fetchone()["recurring_series_id"]

    def _members_of(self, series_name):
        with self._use_db_path():
            with get_db() as conn:
                return conn.execute(
                    "SELECT COUNT(*) AS n FROM txn t JOIN recurring_series s ON s.id = t.recurring_series_id "
                    "WHERE s.display_name = ?", (series_name,)).fetchone()["n"]

    # --- the reported sequence ---------------------------------------------------------------------

    def test_recategorizing_moves_the_row_out_of_its_old_series(self):
        # Two series under one payee, split by category — the town billing water monthly and property
        # tax quarterly. One charge lands in the wrong one.
        self._monthly(payee="Town of Harborline", category="Water", count=8, amount=-95.00)
        stray = self._txn(payee="Town of Harborline", category="Water", amount=-3400.00,
                          when=date.today() - timedelta(days=5))
        self._scan()
        self.assertIsNotNone(self._series_of(stray), "precondition: the scan claimed the stray charge")

        with self._use_db_path():
            override_category(stray, CategoryOverride(category_id=self.cats["Property Tax"]))

        # It is no longer sitting in the water series, without anyone running a scan.
        self.assertNotEqual(self._series_of(stray), "Town of Harborline")

    def test_a_row_that_still_belongs_is_left_alone(self):
        # Re-evaluation, not re-attachment: an edit that changes nothing the detector reads must not
        # disturb membership.
        ids = self._monthly(payee="Streamly", category="Misc", count=8, amount=-15.99)
        self._scan()
        before = self._series_of(ids[0])
        self.assertIsNotNone(before)

        with self._use_db_path():
            override_category(ids[0], CategoryOverride(category_id=self.cats["Misc"]))
        self.assertEqual(self._series_of(ids[0]), before)

    def test_renaming_reconsiders_the_group_the_row_leaves(self):
        # The payee key is derived from the name, so a rename moves a row between groups. The group it
        # left has to be re-evaluated too, which only a key captured before the write can name.
        ids = self._monthly(payee="Streamly", category="Misc", count=6, amount=-15.99)
        self._scan()
        self.assertEqual(self._members_of("Streamly"), 6)

        with self._use_db_path():
            update_merchant(ids[0], {"merchant_name": "Something Else Entirely"})
        self.assertEqual(self._members_of("Streamly"), 5)
        self.assertIsNone(self._series_of(ids[0]))

    def test_a_missed_charge_signal_clears_once_the_charge_is_recategorized(self):
        # The whole reported problem end to end: the signal reads occurrences through the membership
        # link, so a stale link keeps reporting a charge that has in fact arrived. The quarterly series
        # last billed 130 days ago, which is past the ~23-day tolerance for a 91-day cadence.
        self._monthly(payee="Town of Harborline", category="Property Tax", count=4,
                      amount=-3400.00, end=date.today() - timedelta(days=130), step_days=91)
        # The charge that did arrive on schedule, mistakenly categorized as water.
        stray = self._txn(payee="Town of Harborline", category="Water", amount=-3450.00,
                          when=date.today() - timedelta(days=39))
        self._monthly(payee="Corner Store", category="Misc", count=2, amount=-4.25)  # keeps the ledger current
        self._scan()
        # Only a series the user has taken on reports a missing charge, so accepting it is part of
        # stating the case — an unaccepted candidate raises nothing to be cleared.
        with self._use_db_path():
            with get_db() as conn:
                conn.execute("UPDATE recurring_series SET confirmed = 1 WHERE source = 'auto'")

        with self._use_db_path():
            with get_db() as conn:
                missed = [s for s in compute_signals(conn)["signals"] if s["kind"] == "missed"]
        self.assertTrue(missed, "precondition: the quarterly series reports a missing charge")

        with self._use_db_path():
            override_category(stray, CategoryOverride(category_id=self.cats["Property Tax"]))
            with get_db() as conn:
                still_missed = [s for s in compute_signals(conn)["signals"] if s["kind"] == "missed"]
        self.assertEqual(still_missed, [], "recategorizing the charge should settle the finding")

    def test_bulk_edits_rescan_once_for_the_whole_batch(self):
        ids = self._monthly(payee="Town of Harborline", category="Water", count=8, amount=-95.00)
        self._scan()
        self.assertEqual(len({self._series_id_of(i) for i in ids}), 1, "precondition: one series")

        with self._use_db_path():
            bulk_update_transactions(BulkUpdateRequest(
                selection=BulkSelection(mode="ids", ids=ids[:4]),
                actions=[BulkAction(type="set_category", category_id=self.cats["Property Tax"])],
            ))
        # Counting by series *name* would miss this: both halves keep the payee's name, so the split
        # only shows in the identities.
        moved = {self._series_id_of(i) for i in ids[:4]}
        stayed = {self._series_id_of(i) for i in ids[4:]}
        self.assertTrue(moved.isdisjoint(stayed), "the recategorized rows should have left the series")

    def test_a_bulk_action_the_detector_ignores_does_not_rescan(self):
        # Tagging or reviewing rows changes nothing the detector reads; scanning anyway would load the
        # whole detection window for no reason.
        ids = self._monthly(payee="Streamly", category="Misc", count=6, amount=-15.99)
        self._scan()
        before = self._series_of(ids[0])

        with self._use_db_path():
            bulk_update_transactions(BulkUpdateRequest(
                selection=BulkSelection(mode="ids", ids=ids),
                actions=[BulkAction(type="mark_reviewed")],
            ))
        self.assertEqual(self._series_of(ids[0]), before)
