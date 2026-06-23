# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

"""
Import placeholder-category coverage.

These tests keep the uncategorized model consistent across import and later
filtering by ensuring labels like "Uncategorized" stay as `category_id = NULL`
instead of becoming real leaf categories under the protected `Unassigned` group.
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


class FakeUploadFile:
    def __init__(self, filename: str, content: str):
        self.filename = filename
        self._content = content.encode("utf-8")

    async def read(self) -> bytes:
        return self._content


class ImportUncategorizedPlaceholderTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "uncategorized-import-tests.db"
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

    def _insert_account(self, name: str) -> str:
        account_id = str(uuid.uuid4())
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
                        name,
                        "checking",
                        "checking",
                        "1234",
                        SHARED_OWNER_ID,
                        None,
                    ),
                )
        return account_id

    async def _run_import(self, csv_text: str, *, account_map: dict[str, str], use_imported_categories: bool) -> dict:
        upload = FakeUploadFile("fixture.csv", csv_text)
        config = {
            "filename": "fixture.csv",
            "profile_id": None,
            "account_id": None,
            "account_map": account_map,
            "skip_accounts": [],
            "new_accounts": None,
            "column_map": {
                "date": "Date",
                "description": "Description",
                "account": "Account",
                "amount": "Amount",
                "category": "Category",
            },
            "date_format": "%Y-%m-%d",
            "amount_convention": "single_signed",
            "skip_rows": 0,
            "apply_categorization": False,
            "use_imported_categories": use_imported_categories,
        }
        with self._use_db_path():
            return await run_import(file=upload, config=json.dumps(config))

    def _fetch_transactions(self) -> list[dict]:
        with self._use_db_path():
            with get_db() as conn:
                rows = conn.execute(
                    """
                    SELECT id, category_id, imported_category, category_source, category_overridden
                    FROM txn
                    ORDER BY date, id
                    """
                ).fetchall()
        return [dict(row) for row in rows]

    def _fetch_unassigned_children(self) -> list[dict]:
        with self._use_db_path():
            with get_db() as conn:
                rows = conn.execute(
                    """
                    SELECT c.id, c.name
                    FROM   category c
                    JOIN   category p ON p.id = c.parent_id
                    WHERE  p.system_key = 'unassigned'
                    ORDER  BY c.name, c.id
                    """
                ).fetchall()
        return [dict(row) for row in rows]

    async def test_placeholder_imported_categories_stay_uncategorized(self):
        account_id = self._insert_account("Checking")

        await self._run_import(
            "\n".join([
                "Date,Description,Account,Amount,Category",
                "2026-01-02,Coffee Shop,Checking,4.50,Uncategorized",
                "2026-01-03,Book Store,Checking,12.00,Unassigned",
                "2026-01-04,Taxi,Checking,9.25,Uncategorised",
            ]),
            account_map={"Checking": account_id},
            use_imported_categories=True,
        )

        transactions = self._fetch_transactions()
        self.assertEqual(len(transactions), 3)
        for txn in transactions:
            self.assertIsNone(txn["category_id"])
            self.assertIsNone(txn["imported_category"])
            self.assertIsNone(txn["category_source"])
            self.assertEqual(txn["category_overridden"], 0)

        self.assertEqual(self._fetch_unassigned_children(), [])

    async def test_meaningful_imported_categories_still_create_unassigned_leaves(self):
        account_id = self._insert_account("Checking")

        await self._run_import(
            "\n".join([
                "Date,Description,Account,Amount,Category",
                "2026-01-02,Video Service,Checking,14.99,Subscription",
            ]),
            account_map={"Checking": account_id},
            use_imported_categories=True,
        )

        transactions = self._fetch_transactions()
        self.assertEqual(len(transactions), 1)
        self.assertIsNotNone(transactions[0]["category_id"])
        self.assertEqual(transactions[0]["imported_category"], "Subscription")
        self.assertEqual(transactions[0]["category_source"], "import")
        self.assertEqual(transactions[0]["category_overridden"], 1)

        self.assertEqual(self._fetch_unassigned_children(), [{"id": transactions[0]["category_id"], "name": "Subscription"}])


if __name__ == "__main__":
    unittest.main()
