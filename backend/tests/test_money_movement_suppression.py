"""
Wallet funding-leg suppression: a nameless deposit paired with its equal-and-opposite same-day purchase
(both rows a single import just created) is money movement, not income. The importer moves only the leg
into an excluded "Money movement" category and links it to the purchase, always on, high-precision.

Covered here, end-to-end through the real import path:
  * a paired funding leg is suppressed (excluded category) and linked to its purchase; the count is
    reported; the purchase and an unrelated inbound payment are left untouched.
  * `Type` is corroborating, not required: a pair with no captured Type still suppresses; an unrecognized
    Type still suppresses and is surfaced for review.
  * an ambiguous group (two same-day, same-amount purchases for one leg) is left entirely alone.
  * reversing the batch's links restores the leg's prior category and removes the link (no orphan).
  * re-importing with replace reverses the old links and re-pairs cleanly (no double links).

Sign convention (core.get_import_display_amount): stored positive = money out (a purchase), stored
negative = money in (a deposit). With `single_signed` the importer stores `-raw`, so a purchase is CSV
`Amount = -X` and a funding leg is CSV `Amount = X` with a blank Name.
"""

from __future__ import annotations

import json
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import (
    SHARED_OWNER_ID,
    get_db,
    init_db,
    reset_current_db_path,
    set_current_db_path,
)
from backend.routers.import_export import run_import
from backend.routers.import_export.core import undo_batch
from backend.services import txn_links
from backend.services.money_movement import LINK_KIND, reverse_batch_money_movement_links


class FakeUploadFile:
    def __init__(self, filename, content):
        self.filename = filename
        self._content = content.encode("utf-8")

    async def read(self):
        return self._content


class MoneyMovementSuppressionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "money-movement.db"
        init_db(str(self.db_path))
        self.account_id = self._insert_account("PayPal")

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _insert_account(self, name):
        account_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO account
                      (id, plaid_account_id, plaid_item_id, name, display_name, type, subtype, mask, owner_id, parent_account_id, trashed_at)
                    VALUES (?, ?, ?, ?, ?, 'checking', 'checking', NULL, ?, NULL, NULL)
                    """,
                    (account_id, f"test_{account_id}", "fixture_import", name, name, SHARED_OWNER_ID),
                )
        return account_id

    async def _run_import(self, csv_text, *, capture_type=True, replace_batch_id=None):
        column_map = {"date": "Date", "description": "Name", "amount": "Amount"}
        if capture_type:
            column_map["evidence_columns"] = ["Type"]
        config = {
            "filename": "paypal.csv",
            "account_map": {},
            "single_account_new": None,
            "account_id": self.account_id,
            "column_map": column_map,
            "date_format": "%Y-%m-%d",
            "amount_convention": "single_signed",
            "apply_categorization": False,
        }
        if replace_batch_id is not None:
            config["replace_batch_id"] = replace_batch_id
        with self._use_db_path():
            return await run_import(file=FakeUploadFile("paypal.csv", csv_text), config=json.dumps(config))

    # --- query helpers ----------------------------------------------------------------------------

    def _txn_by_name(self, name):
        with self._use_db_path():
            with get_db() as conn:
                row = conn.execute(
                    "SELECT id, amount, category_id, category_source FROM txn WHERE COALESCE(display_name, merchant_name, raw_name) = ? AND trashed_at IS NULL",
                    (name,),
                ).fetchone()
                return dict(row) if row else None

    def _nameless_leg(self):
        """The single nameless credit row (the funding leg)."""
        with self._use_db_path():
            with get_db() as conn:
                row = conn.execute(
                    """SELECT id, amount, category_id, category_source FROM txn
                       WHERE COALESCE(NULLIF(TRIM(display_name),''), NULLIF(TRIM(merchant_name),''), NULLIF(TRIM(raw_name),'')) IS NULL
                         AND trashed_at IS NULL""",
                ).fetchone()
                return dict(row) if row else None

    def _category(self, category_id):
        with self._use_db_path():
            with get_db() as conn:
                row = conn.execute(
                    "SELECT name, exclude_from_totals FROM category WHERE id = ?", (category_id,)
                ).fetchone()
                return dict(row) if row else None

    def _links(self):
        with self._use_db_path():
            with get_db() as conn:
                return [dict(r) for r in conn.execute(
                    "SELECT id, kind FROM txn_link WHERE kind = ?", (LINK_KIND,)
                ).fetchall()]

    # --- tests ------------------------------------------------------------------------------------

    async def test_paired_leg_suppressed_and_linked_others_untouched(self):
        csv = "\n".join([
            "Date,Name,Type,Amount",
            "2024-01-11,RANDONNEURS USA,Express Checkout Payment,-10.00",  # purchase
            "2024-01-11,,Bank Deposit to PP Account,10.00",                # funding leg
            "2024-01-13,Tsun Au Yeung,General Payment,35.00",              # genuine inbound payment (money in, named)
        ])
        result = await self._run_import(csv)
        self.assertEqual(result["money_movement_suppressed_count"], 1)
        self.assertEqual(result["import_summary"]["money_movement_suppressed_count"], 1)

        leg = self._nameless_leg()
        self.assertIsNotNone(leg)
        cat = self._category(leg["category_id"])
        self.assertEqual(cat["name"], "Money movement")
        self.assertEqual(cat["exclude_from_totals"], 1)
        self.assertEqual(leg["category_source"], "enrichment")

        # The purchase stays real spending; the inbound payment stays untouched (never suppressed).
        purchase = self._txn_by_name("RANDONNEURS USA")
        self.assertIsNone(purchase["category_id"])
        inbound = self._txn_by_name("Tsun Au Yeung")
        self.assertIsNone(inbound["category_id"])

        # Exactly one wallet_funding link, tying the leg (role leg) to the purchase (role purchase).
        links = self._links()
        self.assertEqual(len(links), 1)
        with self._use_db_path():
            with get_db() as conn:
                self.assertEqual(txn_links.member_txn_ids(conn, links[0]["id"], role="leg"), [leg["id"]])
                self.assertEqual(txn_links.member_txn_ids(conn, links[0]["id"], role="purchase"), [purchase["id"]])

    async def test_type_absent_still_suppresses_structurally(self):
        csv = "\n".join([
            "Date,Name,Type,Amount",
            "2024-01-06,Best Buy Co. Inc.,Express Checkout Payment,-39.83",
            "2024-01-06,,Bank Deposit to PP Account,39.83",
        ])
        result = await self._run_import(csv, capture_type=False)  # Type not captured into evidence
        self.assertEqual(result["money_movement_suppressed_count"], 1)
        self.assertEqual(result["import_summary"]["money_movement_unrecognized_types"], [])

    async def test_unrecognized_type_still_suppresses_and_is_reported(self):
        csv = "\n".join([
            "Date,Name,Type,Amount",
            "2024-01-06,Best Buy Co. Inc.,Express Checkout Payment,-39.83",
            "2024-01-06,,Some New Deposit Kind,39.83",
        ])
        result = await self._run_import(csv)
        self.assertEqual(result["money_movement_suppressed_count"], 1)
        self.assertEqual(result["import_summary"]["money_movement_unrecognized_types"], ["Some New Deposit Kind"])

    async def test_ambiguous_group_left_untouched(self):
        # Two same-day, same-amount purchases for one leg: which purchase the leg funds is ambiguous, so
        # nothing is suppressed (a safe miss).
        csv = "\n".join([
            "Date,Name,Type,Amount",
            "2024-01-11,RANDONNEURS USA,Express Checkout Payment,-10.00",
            "2024-01-11,Other Merchant,Express Checkout Payment,-10.00",
            "2024-01-11,,Bank Deposit to PP Account,10.00",
        ])
        result = await self._run_import(csv)
        self.assertEqual(result["money_movement_suppressed_count"], 0)
        self.assertEqual(self._links(), [])
        leg = self._nameless_leg()
        self.assertIsNone(leg["category_id"], "the leg keeps its (uncategorized) state")

    async def test_reverse_restores_prior_category_and_removes_link(self):
        csv = "\n".join([
            "Date,Name,Type,Amount",
            "2024-01-11,RANDONNEURS USA,Express Checkout Payment,-10.00",
            "2024-01-11,,Bank Deposit to PP Account,10.00",
        ])
        result = await self._run_import(csv)
        self.assertEqual(result["money_movement_suppressed_count"], 1)

        # Reverse directly (rows survive) to exercise the restore-and-unlink branch on its own.
        with self._use_db_path():
            with get_db() as conn:
                reversed_count = reverse_batch_money_movement_links(conn, result["batch_id"])
        self.assertEqual(reversed_count, 1)
        self.assertEqual(self._links(), [])
        leg = self._nameless_leg()
        self.assertIsNone(leg["category_id"], "prior (uncategorized) state restored")
        self.assertIsNone(leg["category_source"])

    async def test_undo_batch_removes_links(self):
        csv = "\n".join([
            "Date,Name,Type,Amount",
            "2024-01-11,RANDONNEURS USA,Express Checkout Payment,-10.00",
            "2024-01-11,,Bank Deposit to PP Account,10.00",
        ])
        result = await self._run_import(csv)
        self.assertEqual(len(self._links()), 1)
        with self._use_db_path():
            undo_batch(result["batch_id"], force=True)
        self.assertEqual(self._links(), [], "undo must leave no orphan link")
        self.assertIsNone(self._nameless_leg(), "the batch's rows are gone")

    async def test_recategorize_all_leaves_the_suppressed_leg_excluded(self):
        # The suppressed funding leg is `enrichment`, feature-owned; a Run categorization pass (e.g. the one
        # apply_money_movement_rules triggers) must not clear it back out of the excluded category.
        csv = "\n".join([
            "Date,Name,Type,Amount",
            "2024-01-11,RANDONNEURS USA,Express Checkout Payment,-10.00",
            "2024-01-11,,Bank Deposit to PP Account,10.00",
        ])
        result = await self._run_import(csv)
        self.assertEqual(result["money_movement_suppressed_count"], 1)
        leg_before = self._nameless_leg()
        with self._use_db_path():
            with get_db() as conn:
                from backend.services.categorizer import recategorize_all
                recategorize_all(conn)
        leg_after = self._nameless_leg()
        self.assertEqual(leg_after["category_id"], leg_before["category_id"], "leg must stay in Money movement")
        self.assertEqual(leg_after["category_source"], "enrichment")
        self.assertEqual(self._category(leg_after["category_id"])["name"], "Money movement")

    async def test_reimport_replace_reverses_then_repairs(self):
        first = await self._run_import("\n".join([
            "Date,Name,Type,Amount",
            "2024-01-11,RANDONNEURS USA,Express Checkout Payment,-10.00",
            "2024-01-11,,Bank Deposit to PP Account,10.00",
        ]))
        self.assertEqual(len(self._links()), 1)

        # Replace with a corrected file on different dates (so the rows re-insert rather than hard-reject
        # against the replaced batch's coverage). The old link must be reversed, leaving exactly one.
        second = await self._run_import("\n".join([
            "Date,Name,Type,Amount",
            "2024-02-20,RANDONNEURS USA,Express Checkout Payment,-10.00",
            "2024-02-20,,Bank Deposit to PP Account,10.00",
        ]), replace_batch_id=first["batch_id"])
        self.assertEqual(second["money_movement_suppressed_count"], 1)
        self.assertEqual(len(self._links()), 1, "the replaced batch's link was reversed, not left to accumulate")


if __name__ == "__main__":
    unittest.main()
