# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

"""
Duplicate-detection integration coverage for CSV import.

These tests run anonymized fixture CSVs through the real import endpoint logic so
coverage-window dedupe, terminal-day reconciliation, exact-match blocking, and
cross-source text matching are exercised together. The assertions combine batch
counts/reasons with a normalized export-style ledger snapshot so regressions show
up even when the high-level counts still look plausible.
"""

from __future__ import annotations

import csv
import io
import json
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from fastapi import UploadFile

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.import_export import get_batch_duplicates, make_hash, run_import, undo_batch


FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures" / "import_duplicates"


class ImportDuplicateDetectionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "duplicate-tests.db"
        init_db(str(self.db_path))

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _fixture_text(self, name: str) -> str:
        return (FIXTURE_DIR / name).read_text(encoding="utf-8")

    async def _run_import_fixture(self, fixture_name: str, config: dict) -> dict:
        content = self._fixture_text(fixture_name).encode("utf-8")
        upload = UploadFile(filename=fixture_name, file=io.BytesIO(content))
        with self._use_db_path():
            return await run_import(file=upload, config=json.dumps(config))

    def _get_duplicates(self, batch_id: str) -> dict:
        with self._use_db_path():
            return get_batch_duplicates(batch_id)

    def _undo_batch(self, batch_id: str) -> dict:
        with self._use_db_path():
            return undo_batch(batch_id)

    def _insert_account(
        self,
        name: str,
        *,
        account_type: str,
        mask: str | None = None,
        display_name: str | None = None,
        parent_account_id: str | None = None,
    ) -> str:
        account_id = str(uuid.uuid4())
        subtype = {
            "credit": "credit_card",
            "savings": "savings",
            "investment": "brokerage",
            "loan": "loan",
            "p2p": "p2p",
            "other": "other",
        }.get(account_type, "checking")
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO account
                      (id, plaid_account_id, plaid_item_id, name, display_name, type, subtype, mask, owner_id, parent_account_id, trashed_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
                    """,
                    (
                        account_id,
                        f"test_{account_id}",
                        "fixture_import",
                        name,
                        display_name or name,
                        account_type,
                        subtype,
                        mask,
                        SHARED_OWNER_ID,
                        parent_account_id,
                    ),
                )
        return account_id

    def _insert_existing_transaction(
        self,
        *,
        account_id: str,
        date: str,
        amount: float,
        merchant_name: str,
        raw_name: str | None = None,
        display_name: str | None = None,
    ) -> str:
        txn_id = str(uuid.uuid4())
        raw_value = raw_name or merchant_name
        display_value = display_name or merchant_name
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO txn
                      (id, account_id, owner_id, amount, merchant_name, display_name, raw_name, date, is_pending, content_hash, import_batch_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL)
                    """,
                    (
                        txn_id,
                        account_id,
                        SHARED_OWNER_ID,
                        amount,
                        merchant_name,
                        display_value,
                        raw_value,
                        date,
                        make_hash(date, amount, merchant_name),
                    ),
                )
        return txn_id

    def _account_mapping_config(
        self,
        *,
        headers: dict[str, str],
        account_map: dict[str, str],
    ) -> dict:
        column_map = {
            "date": headers["date"],
            "description": headers["description"],
            "account": headers["account"],
            "amount": headers["amount"],
        }
        if headers.get("category"):
            column_map["category"] = headers["category"]
        if headers.get("notes"):
            column_map["notes"] = headers["notes"]
        return {
            "filename": "fixture.csv",
            "profile_id": None,
            "account_id": None,
            "single_account_new": None,
            "account_map": account_map,
            "skip_accounts": [],
            "new_accounts": None,
            "column_map": column_map,
            "date_format": headers.get("date_format", "%Y-%m-%d"),
            "amount_convention": headers.get("amount_convention", "single_signed"),
            "skip_rows": 0,
            "apply_categorization": False,
            "use_imported_categories": False,
        }

    def _ledger_snapshot(self) -> list[dict[str, str]]:
        with self._use_db_path():
            with get_db() as conn:
                rows = conn.execute(
                    """
                    SELECT
                      t.date AS date,
                      COALESCE(t.display_name, t.merchant_name, t.raw_name) AS merchant,
                      printf('%.2f', t.amount) AS amount,
                      COALESCE(a.display_name, a.name) AS account
                    FROM txn t
                    JOIN account a ON a.id = t.account_id
                    WHERE t.is_pending = 0
                    ORDER BY t.date, account, merchant, t.amount, t.id
                    """
                ).fetchall()
        return [dict(row) for row in rows]

    def _expected_snapshot(self, fixture_name: str) -> list[dict[str, str]]:
        with (FIXTURE_DIR / fixture_name).open("r", encoding="utf-8", newline="") as handle:
            return list(csv.DictReader(handle))

    async def test_coverage_window_and_terminal_day_reconciliation(self):
        rewards_id = self._insert_account("Travel Rewards", account_type="credit", mask="1234")

        fullview_config = self._account_mapping_config(
            headers={
                "date": "Date",
                "description": "Description",
                "account": "Account",
                "amount": "Amount",
                "category": "Category",
                "date_format": "%m/%d/%Y",
            },
            account_map={"Travel Rewards": rewards_id},
        )
        result_one = await self._run_import_fixture("duplicate_fullview_base.csv", fullview_config)
        self.assertEqual(result_one["imported"], 6)
        self.assertEqual(result_one["deduped"], 0)

        monarch_config = self._account_mapping_config(
            headers={
                "date": "Date",
                "description": "Merchant",
                "account": "Account",
                "amount": "Amount",
                "category": "Category",
                "notes": "Notes",
                "date_format": "%Y-%m-%d",
            },
            account_map={"CREDIT CARD (...1234)": rewards_id},
        )
        result_two = await self._run_import_fixture("duplicate_monarch_overlap.csv", monarch_config)
        self.assertEqual(result_two["imported"], 1)
        self.assertEqual(result_two["deduped"], 4)

        duplicates = self._get_duplicates(result_two["batch_id"])
        reasons = [row["reason"] for row in duplicates["rows"]]
        self.assertEqual(sum("Falls within the fully covered date range" in reason for reason in reasons), 2)
        self.assertEqual(sum("terminal covered day" in reason for reason in reasons), 2)
        self.assertEqual(self._ledger_snapshot(), self._expected_snapshot("expected_coverage_terminal_ledger.csv"))

    async def test_exact_match_duplicate_beats_covered_day(self):
        rewards_id = self._insert_account("Travel Rewards", account_type="credit", mask="1234")

        base_config = self._account_mapping_config(
            headers={
                "date": "Date",
                "description": "Description",
                "account": "Account",
                "amount": "Amount",
                "category": "Category",
                "date_format": "%m/%d/%Y",
            },
            account_map={"Travel Rewards": rewards_id},
        )
        await self._run_import_fixture("duplicate_fullview_base.csv", base_config)

        exact_config = self._account_mapping_config(
            headers={
                "date": "Date",
                "description": "Merchant",
                "account": "Account",
                "amount": "Amount",
                "category": "Category",
                "notes": "Notes",
                "date_format": "%Y-%m-%d",
            },
            account_map={"CREDIT CARD (...1234)": rewards_id},
        )
        result = await self._run_import_fixture("duplicate_monarch_exact.csv", exact_config)
        self.assertEqual(result["imported"], 0)
        self.assertEqual(result["deduped"], 1)

        duplicates = self._get_duplicates(result["batch_id"])
        self.assertEqual(len(duplicates["rows"]), 1)
        self.assertEqual(duplicates["rows"][0]["reason"], "Matches an existing transaction")
        self.assertEqual(self._ledger_snapshot(), self._expected_snapshot("expected_fullview_base_ledger.csv"))

    async def test_cross_source_text_match_without_coverage_window(self):
        checking_id = self._insert_account("Home Checking", account_type="depository", mask="4321")
        self._insert_existing_transaction(
            account_id=checking_id,
            date="2025-12-03",
            amount=125.00,
            merchant_name="PAYPAL INST XFER CLEANING CREW",
            raw_name="PAYPAL INST XFER CLEANING CREW",
            display_name="PAYPAL INST XFER CLEANING CREW",
        )

        config = self._account_mapping_config(
            headers={
                "date": "Date",
                "description": "Merchant",
                "account": "Account",
                "amount": "Amount",
                "category": "Category",
                "notes": "Notes",
                "date_format": "%Y-%m-%d",
            },
            account_map={"CHECKING (...4321)": checking_id},
        )
        result = await self._run_import_fixture("duplicate_monarch_text_match.csv", config)
        self.assertEqual(result["imported"], 0)
        self.assertEqual(result["deduped"], 1)

        duplicates = self._get_duplicates(result["batch_id"])
        self.assertEqual(len(duplicates["rows"]), 1)
        self.assertIn("Possible cross-source match by date, amount, and source text", duplicates["rows"][0]["reason"])
        self.assertEqual(
            self._ledger_snapshot(),
            [
                {
                    "date": "2025-12-03",
                    "merchant": "PAYPAL INST XFER CLEANING CREW",
                    "amount": "125.00",
                    "account": "Home Checking",
                }
            ],
        )

    async def test_duplicate_rows_within_same_csv_are_allowed(self):
        rewards_id = self._insert_account("Travel Rewards", account_type="credit", mask="1234")
        config = self._account_mapping_config(
            headers={
                "date": "Date",
                "description": "Description",
                "account": "Account",
                "amount": "Amount",
                "category": "Category",
                "date_format": "%m/%d/%Y",
            },
            account_map={"Travel Rewards": rewards_id},
        )
        result = await self._run_import_fixture("duplicate_same_file_allowed.csv", config)
        self.assertEqual(result["imported"], 2)
        self.assertEqual(result["deduped"], 0)
        self.assertEqual(self._ledger_snapshot(), self._expected_snapshot("expected_same_file_allowed_ledger.csv"))

    async def test_duplicate_compare_only_against_linked_existing_account(self):
        checking_id = self._insert_account("House Checking", account_type="depository", mask="4321")

        base_config = self._account_mapping_config(
            headers={
                "date": "Date",
                "description": "Description",
                "account": "Account",
                "amount": "Amount",
                "category": "Category",
                "date_format": "%m/%d/%Y",
            },
            account_map={"House Checking": checking_id},
        )
        result_one = await self._run_import_fixture("duplicate_linked_base.csv", base_config)
        self.assertEqual(result_one["imported"], 3)
        self.assertEqual(result_one["deduped"], 0)

        self._insert_existing_transaction(
            account_id=checking_id,
            date="2025-10-13",
            amount=125.00,
            merchant_name="PAYPAL INST XFER CLEANING CREW",
            raw_name="PAYPAL INST XFER CLEANING CREW",
            display_name="PAYPAL INST XFER CLEANING CREW",
        )

        linked_config = {
            "filename": "duplicate_linked_compare.csv",
            "profile_id": None,
            "account_id": None,
            "single_account_new": None,
            "account_map": {},
            "skip_accounts": [],
            "new_accounts": [
                {
                    "csv_value": "CHECKING (...4321)",
                    "name": "House Checking Alias",
                    "type": "depository",
                    "duplicate_compare_account_id": checking_id,
                }
            ],
            "column_map": {
                "date": "Date",
                "description": "Merchant",
                "account": "Account",
                "amount": "Amount",
                "category": "Category",
                "notes": "Notes",
            },
            "date_format": "%Y-%m-%d",
            "amount_convention": "single_signed",
            "skip_rows": 0,
            "apply_categorization": False,
            "use_imported_categories": False,
        }
        result_two = await self._run_import_fixture("duplicate_linked_compare.csv", linked_config)
        self.assertEqual(result_two["imported"], 1)
        self.assertEqual(result_two["deduped"], 3)

        duplicates = self._get_duplicates(result_two["batch_id"])
        reasons = [row["reason"] for row in duplicates["rows"]]
        self.assertEqual(sum(reason == "Matches an existing transaction in the linked account group" for reason in reasons), 1)
        self.assertEqual(sum("Falls within the fully covered date range from an earlier import in this account scope" in reason for reason in reasons), 1)
        self.assertEqual(sum("Possible cross-source match by date, amount, and source text in the linked account group" in reason for reason in reasons), 1)
        self.assertEqual(self._ledger_snapshot(), self._expected_snapshot("expected_linked_compare_ledger.csv"))

    async def test_group_with_existing_account_dedupes_against_three_account_group(self):
        parent_id = self._insert_account("Merged Checking", account_type="depository", mask="0000")
        child_a_id = self._insert_account(
            "Merged Checking (...1111)",
            account_type="depository",
            mask="1111",
            display_name="Merged Checking",
            parent_account_id=parent_id,
        )
        child_b_id = self._insert_account(
            "Merged Checking (...2222)",
            account_type="depository",
            mask="2222",
            display_name="Merged Checking",
            parent_account_id=parent_id,
        )

        base_a_config = self._account_mapping_config(
            headers={
                "date": "Date",
                "description": "Description",
                "account": "Account",
                "amount": "Amount",
                "category": "Category",
                "date_format": "%m/%d/%Y",
            },
            account_map={"CHECKING (...1111)": child_a_id},
        )
        result_a = await self._run_import_fixture("duplicate_grouped_base_a.csv", base_a_config)
        self.assertEqual(result_a["imported"], 3)
        self.assertEqual(result_a["deduped"], 0)

        base_b_config = self._account_mapping_config(
            headers={
                "date": "Date",
                "description": "Description",
                "account": "Account",
                "amount": "Amount",
                "category": "Category",
                "date_format": "%m/%d/%Y",
            },
            account_map={"CHECKING (...2222)": child_b_id},
        )
        result_b = await self._run_import_fixture("duplicate_grouped_base_b.csv", base_b_config)
        self.assertEqual(result_b["imported"], 3)
        self.assertEqual(result_b["deduped"], 0)

        self._insert_existing_transaction(
            account_id=child_b_id,
            date="2025-10-20",
            amount=-125.00,
            merchant_name="PAYPAL INST XFER CLEANING CREW",
            raw_name="PAYPAL INST XFER CLEANING CREW",
            display_name="PAYPAL INST XFER CLEANING CREW",
        )

        grouped_config = {
            "filename": "duplicate_grouped_compare.csv",
            "profile_id": None,
            "account_id": None,
            "single_account_new": None,
            "account_map": {},
            "skip_accounts": [],
            "new_accounts": [
                {
                    "csv_value": "CHECKING (...3333)",
                    "name": "Merged Checking (...3333)",
                    "type": "depository",
                    "group_with_account_id": parent_id,
                }
            ],
            "column_map": {
                "date": "Date",
                "description": "Merchant",
                "account": "Account",
                "amount": "Amount",
                "category": "Category",
                "notes": "Notes",
            },
            "date_format": "%Y-%m-%d",
            "amount_convention": "single_signed",
            "skip_rows": 0,
            "apply_categorization": False,
            "use_imported_categories": False,
        }
        result_grouped = await self._run_import_fixture("duplicate_grouped_compare.csv", grouped_config)
        self.assertEqual(result_grouped["imported"], 1)
        self.assertEqual(result_grouped["deduped"], 3)

        duplicates = self._get_duplicates(result_grouped["batch_id"])
        reasons = [row["reason"] for row in duplicates["rows"]]
        self.assertEqual(sum(reason == "Matches an existing transaction in the linked account group" for reason in reasons), 2)
        self.assertEqual(sum("Falls within the fully covered date range from an earlier import in this account scope" in reason for reason in reasons), 1)
        self.assertEqual(self._ledger_snapshot(), self._expected_snapshot("expected_grouped_compare_ledger.csv"))

    async def test_terminal_day_reconciliation_consumes_only_prior_same_amount_rows(self):
        checking_id = self._insert_account("House Checking", account_type="depository", mask="4321")

        base_config = self._account_mapping_config(
            headers={
                "date": "Date",
                "description": "Description",
                "account": "Account",
                "amount": "Amount",
                "category": "Category",
                "date_format": "%m/%d/%Y",
            },
            account_map={"House Checking": checking_id},
        )
        result_one = await self._run_import_fixture("duplicate_terminal_same_amount_base.csv", base_config)
        self.assertEqual(result_one["imported"], 3)
        self.assertEqual(result_one["deduped"], 0)

        overlap_config = self._account_mapping_config(
            headers={
                "date": "Date",
                "description": "Merchant",
                "account": "Account",
                "amount": "Amount",
                "category": "Category",
                "notes": "Notes",
                "date_format": "%Y-%m-%d",
            },
            account_map={"CHECKING (...4321)": checking_id},
        )
        result_two = await self._run_import_fixture("duplicate_terminal_same_amount_overlap.csv", overlap_config)
        self.assertEqual(result_two["imported"], 1)
        self.assertEqual(result_two["deduped"], 2)

        duplicates = self._get_duplicates(result_two["batch_id"])
        reasons = [row["reason"] for row in duplicates["rows"]]
        self.assertEqual(sum("terminal covered day" in reason for reason in reasons), 2)
        self.assertEqual(self._ledger_snapshot(), self._expected_snapshot("expected_terminal_same_amount_ledger.csv"))

    async def test_undo_then_reimport_same_file_imports_again_cleanly(self):
        rewards_id = self._insert_account("Travel Rewards", account_type="credit", mask="1234")
        config = self._account_mapping_config(
            headers={
                "date": "Date",
                "description": "Description",
                "account": "Account",
                "amount": "Amount",
                "category": "Category",
                "date_format": "%m/%d/%Y",
            },
            account_map={"Travel Rewards": rewards_id},
        )

        first_result = await self._run_import_fixture("duplicate_fullview_base.csv", config)
        self.assertEqual(first_result["imported"], 6)
        self.assertEqual(first_result["deduped"], 0)
        self.assertEqual(self._ledger_snapshot(), self._expected_snapshot("expected_fullview_base_ledger.csv"))

        undo_result = self._undo_batch(first_result["batch_id"])
        self.assertEqual(undo_result, {"ok": True})
        self.assertEqual(self._ledger_snapshot(), [])

        second_result = await self._run_import_fixture("duplicate_fullview_base.csv", config)
        self.assertEqual(second_result["imported"], 6)
        self.assertEqual(second_result["deduped"], 0)
        self.assertEqual(self._ledger_snapshot(), self._expected_snapshot("expected_fullview_base_ledger.csv"))


if __name__ == "__main__":
    unittest.main()
