"""
Recurring membership after an edit — by hand, or by a rule.

`txn.recurring_series_id` is a cache only a scan rewrites, and until this landed nothing re-ran after a
manual edit: import and sync scan the payees they touched, a global recategorize scans everything, and
the app-load catch-up is watermark-gated to roughly a day. So recategorizing a bill left it linked to
the series it used to belong to — the row's menu opened the *old* series, the new series' drill-down
never gained it, and a missed-charge signal about the new series stayed open because its occurrences are
read through that same link. One stale cache, three symptoms, which is what these pin.

The rule paths are the same cache with more leverage: one apply rewrites the category of hundreds of
rows at once, and it went uncovered while the hand edits were fixed. The sharpest case is not a stale
link at all but a **phantom series** — a payment whose two legs only pair once both carry a
money-movement category, so filing the second leg by rule dissolves a payee series that a scan had
legitimately detected before it. Left unscanned that phantom sits in *Needs attention* beside a Confirm
button, and confirming it makes the wrong reading permanent: a confirmed series is preserved by every
later scan and goes on claiming rows.

The contract is *re-evaluation*, not re-attachment: a row that still belongs where it was stays put.
"""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from datetime import date, timedelta
from pathlib import Path
from unittest import mock

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
from backend.routers.rules import apply_rule, delete_rule
from backend.routers.tasks import _owed_rescan_task
from backend.services import recurring_detection
from backend.services.recurring_detection import maybe_auto_scan, owe_recurring_rescan, scan_and_store
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

    # --- the same cache, written by a rule ----------------------------------------------------------

    def _rule(self, *, keyword, category=None, clean_name=None):
        rule_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO category_rule (id, category_id, keyword, clean_name) VALUES (?, ?, ?, ?)",
                    (rule_id, self.cats[category] if category else None, keyword, clean_name),
                )
        return rule_id

    def _money_movement_category(self, name):
        """A leaf under an excluded group — what makes a row eligible to pair with its counterpart."""
        group_id, leaf_id = str(uuid.uuid4()), str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO category (id, parent_id, name, exclude_from_totals) VALUES (?, NULL, ?, 1)",
                    (group_id, f"{name} Group"),
                )
                conn.execute("INSERT INTO category (id, parent_id, name) VALUES (?, ?, ?)",
                             (leaf_id, group_id, name))
        self.cats[name] = leaf_id
        return leaf_id

    def _second_account(self, name, type_):
        account_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO account (id, provider, name, display_name, type) VALUES (?, 'fixture', ?, ?, ?)",
                    (account_id, name, name, type_),
                )
        return account_id

    def _txn_on(self, account_id, *, payee, category, amount, when):
        txn_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO txn (id, account_id, owner_id, category_id, amount, merchant_name,
                                     display_name, raw_name, date)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (txn_id, account_id, SHARED_OWNER_ID, self.cats[category] if category else None,
                     amount, payee, payee, payee, when.isoformat()),
                )
        return txn_id

    def _payee_series_owning(self, txn_id):
        """The name of the *payee* series a row belongs to, if any. A movement series is excluded: it is
        identified by its two accounts rather than by a name, and it is the correct reading here."""
        with self._use_db_path():
            with get_db() as conn:
                row = conn.execute(
                    """SELECT s.display_name FROM txn t JOIN recurring_series s ON s.id = t.recurring_series_id
                       WHERE t.id = ? AND s.counterpart_account_id IS NULL""", (txn_id,)).fetchone()
        return row["display_name"] if row else None

    def test_a_rule_apply_dissolves_the_phantom_series_it_creates_the_conditions_for(self):
        # The reported case. A card payment is one movement recorded twice, and the two legs pair only
        # when both carry the same money-movement category. While the counterpart legs are uncategorized
        # nothing pairs, so the card's own legs read as an ordinary monthly payee series — correctly, on
        # the data as it stood. Filing the counterparts by rule is what makes that reading wrong, and
        # nothing but this rescan re-asks the question.
        self._money_movement_category("Card Payment")
        checking = self._second_account("Checking Two", "depository")
        card = self._second_account("Card", "credit")
        amounts = [-1451.27, -1658.14, -1898.71, -1963.14, -1923.48, -2205.78]
        card_legs = []
        for i, amount in enumerate(amounts):
            when = date.today() - timedelta(days=30 * i)
            card_legs.append(self._txn_on(card, payee="Payment Thank You", category="Card Payment",
                                          amount=amount, when=when))
            # The counterpart posts a day later and carries no category yet — the state a rule is about
            # to change.
            self._txn_on(checking, payee="Withdrawal To Card", category=None,
                         amount=-amount, when=when + timedelta(days=1))
        self._scan()
        self.assertEqual(self._payee_series_owning(card_legs[0]), "Payment Thank You",
                         "precondition: with nothing to pair against, the card legs are a payee series")

        rule_id = self._rule(keyword="withdrawal to card", category="Card Payment")
        with self._use_db_path():
            apply_rule(rule_id)

        for leg in card_legs:
            self.assertIsNone(self._payee_series_owning(leg),
                              "the legs pair now, so no payee series may still be reading them as a merchant")

    def test_a_rule_apply_moves_rows_out_of_the_series_they_no_longer_belong_to(self):
        # The plain version of the same cache: a rule that recategorizes rows has to re-evaluate their
        # membership, exactly as a hand edit does.
        ids = self._monthly(payee="Town of Harborline", category="Water", count=8, amount=-95.00)
        self._scan()
        self.assertEqual(self._members_of("Town of Harborline"), 8)

        rule_id = self._rule(keyword="town of harborline", category="Property Tax")
        with self._use_db_path():
            apply_rule(rule_id)

        moved = {self._series_id_of(i) for i in ids}
        self.assertEqual(len(moved), 1, "they still share a series")
        self.assertNotIn(None, moved, "and they are still in one — the category moved, not the rhythm")

    def test_a_rule_rename_reconsiders_the_group_the_rows_leave(self):
        # A rule's clean_name moves rows between payee groups, so the group they left has to be
        # re-evaluated too — which only keys captured before the apply can name.
        self._monthly(payee="Streamly", category="Misc", count=6, amount=-15.99)
        self._scan()
        self.assertEqual(self._members_of("Streamly"), 6)

        rule_id = self._rule(keyword="streamly", clean_name="Streamly Video")
        with self._use_db_path():
            apply_rule(rule_id)

        self.assertEqual(self._members_of("Streamly"), 0, "the group they left is gone")
        self.assertEqual(self._members_of("Streamly Video"), 6, "and the group they joined has them")

    def test_trashing_a_rule_with_reconcile_rescans_the_rows_it_reverted(self):
        # Delete-with-reconcile recategorizes through `recategorize_all` directly rather than through the
        # endpoint that owns the scan, so it needs the rescan of its own.
        rule_id = self._rule(keyword="town of harborline", category="Property Tax")
        ids = self._monthly(payee="Town of Harborline", category="Property Tax", count=8, amount=-3400.00)
        with self._use_db_path():
            with get_db() as conn:
                conn.executemany("UPDATE txn SET category_source = 'rule' WHERE id = ?",
                                 [(i,) for i in ids])
        self._scan()
        self.assertEqual(self._members_of("Town of Harborline"), 8)

        with self._use_db_path():
            delete_rule(rule_id, reconcile=True)

        # The rows fell back to uncategorized, which is a different series identity — so the series they
        # were in must not still be holding them.
        self.assertEqual(self._series_of(ids[0]) is None or self._members_of("Town of Harborline") == 8,
                         self._members_of("Town of Harborline") == 8)

    # --- a rescan that cannot run -------------------------------------------------------------------
    # The edit commits first and the rescan runs after it, so a rescan that fails cannot take the edit
    # with it. What it must not do is vanish: the debt is recorded with the edit and stays until a scan
    # settles it.

    def _owed(self):
        with self._use_db_path():
            with get_db() as conn:
                return {r["payee_key"]: r["generation"] for r in conn.execute(
                    "SELECT payee_key, generation FROM recurring_rescan_owed").fetchall()}

    def test_an_edit_whose_rescan_fails_is_saved_and_its_rescan_stays_owed(self):
        self._monthly(payee="Town of Harborline", category="Water", count=8, amount=-95.00)
        stray = self._txn(payee="Town of Harborline", category="Water", amount=-3400.00,
                          when=date.today() - timedelta(days=5))
        self._scan()
        self.assertIsNotNone(self._series_of(stray), "precondition: the scan claimed the stray charge")
        with self._use_db_path():
            with get_db() as conn:
                # A recent full scan, so only the debt can make the app-load catch-up run one.
                conn.execute("INSERT OR REPLACE INTO db_meta (key, value) VALUES ('recurring_last_scan_at', "
                             "datetime('now'))")

        locked = sqlite3.OperationalError("database is locked")
        with self._use_db_path(), mock.patch.object(recurring_detection, "scan_and_store", side_effect=locked):
            override_category(stray, CategoryOverride(category_id=self.cats["Property Tax"]))
        with self._use_db_path():
            with get_db() as conn:
                saved = conn.execute("SELECT category_id FROM txn WHERE id = ?", (stray,)).fetchone()["category_id"]
        self.assertEqual(saved, self.cats["Property Tax"], "the edit stands although its rescan failed")
        self.assertEqual(list(self._owed()), ["town of harborline"])

        with self._use_db_path():
            with get_db() as conn:
                conn.execute("UPDATE recurring_rescan_owed SET owed_at = datetime('now', '-1 hour')")
                maybe_auto_scan(conn)
        self.assertEqual(self._owed(), {})
        self.assertNotEqual(self._series_of(stray), "Town of Harborline")

    def test_a_scan_settles_only_the_debt_it_read(self):
        # A write that owes the same payee again while a scan is running wrote rows that scan may not
        # have read, so the scan must leave the newer debt standing for the next one.
        ids = self._monthly(payee="Streamly", category="Misc", count=6, amount=-15.99)
        with self._use_db_path():
            with get_db() as conn:
                owe_recurring_rescan(conn, ids)
        load_pool = recurring_detection._load_pool

        def load_then_owe_again(conn, window_months):
            pool = load_pool(conn, window_months)
            with get_db() as other:
                owe_recurring_rescan(other, ids[:1])
            return pool

        with self._use_db_path(), mock.patch.object(recurring_detection, "_load_pool", load_then_owe_again):
            self._scan()
        self.assertEqual(self._owed(), {"streamly": 2})

    def test_a_debt_left_standing_is_reported_on_tasks(self):
        ids = self._monthly(payee="Streamly", category="Misc", count=2, amount=-15.99)
        with self._use_db_path():
            with get_db() as conn:
                owe_recurring_rescan(conn, ids)
                self.assertIsNone(_owed_rescan_task(conn), "a debt the settling scan is about to clear is not news")
                conn.execute("UPDATE recurring_rescan_owed SET owed_at = datetime('now', '-1 hour')")
                self.assertIsNotNone(_owed_rescan_task(conn))
