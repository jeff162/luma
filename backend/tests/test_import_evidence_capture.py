"""
Import-record surfacing: what source detail we keep/derive for a transaction.

Two concerns:
  * Evidence capture — the mapped account/description plus a bounded set of *descriptive free-text*
    columns (memo/note/narrative/etc.) that help decode a cryptic transaction. Identifier/figure
    columns (check number, balance) are dropped, the count is capped, and values already shown
    (description/account) are not duplicated. The same fields feed the text duplicate-matcher, so
    over-capturing has side effects — hence the guards here.
  * Check-number enrichment — a bare "Check" line is folded into the merchant as "Check #<n>" from a
    separate check-number column (when the row is really a paper check), without storing that column
    and without touching the literal raw source text.
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
from backend.routers.import_export.core import MAX_IMPORT_EVIDENCE_TEXT_FIELDS


class FakeUploadFile:
    def __init__(self, filename, content):
        self.filename = filename
        self._content = content.encode("utf-8")

    async def read(self, size: int = -1):
        return self._content


class ImportEvidenceCaptureTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "import-evidence-tests.db"
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

    def _insert_account(self, name):
        account_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO account
                      (id, external_account_id, provider, name, display_name, type, subtype, mask, owner_id, parent_account_id, trashed_at)
                    VALUES (?, ?, ?, ?, ?, 'checking', 'checking', '1234', ?, NULL, NULL)
                    """,
                    (account_id, f"test_{account_id}", "fixture_import", name, name, SHARED_OWNER_ID),
                )
        return account_id

    async def _run_import(self, csv_text, account_map):
        config = {
            "filename": "fixture.csv",
            "profile_id": None,
            "account_id": None,
            "account_map": account_map,
            "skip_accounts": [],
            "new_accounts": None,
            "column_map": {"date": "Date", "description": "Description", "account": "Account", "amount": "Amount"},
            "date_format": "%Y-%m-%d",
            "amount_convention": "single_signed",
            "skip_rows": 0,
            "apply_categorization": False,
            "use_imported_categories": False,
        }
        with self._use_db_path():
            return await run_import(file=FakeUploadFile("fixture.csv", csv_text), config=json.dumps(config))

    def _evidence(self):
        with self._use_db_path():
            with get_db() as conn:
                raw = conn.execute("SELECT import_evidence_json FROM txn LIMIT 1").fetchone()["import_evidence_json"]
        return json.loads(raw) if raw else {}

    def _txn(self):
        with self._use_db_path():
            with get_db() as conn:
                return dict(conn.execute(
                    "SELECT merchant_name, display_name, raw_name FROM txn LIMIT 1"
                ).fetchone())

    async def test_descriptive_columns_kept_identifier_columns_dropped(self):
        account_id = self._insert_account("Checking")
        await self._run_import(
            "\n".join([
                "Date,Description,Account,Amount,Memo,Notes,Balance,Check Number",
                "2026-01-02,POS 12345,Checking,9.99,Recurring streaming svc,Cancel before renewal,1042.18,2051",
            ]),
            {"Checking": account_id},
        )
        headers = {field["header"] for field in self._evidence().get("extra_text_fields", [])}
        self.assertIn("Memo", headers)
        self.assertIn("Notes", headers)
        self.assertNotIn("Balance", headers, "figures don't aid recognition and would add dedupe noise")
        self.assertNotIn("Check Number", headers, "identifiers are not descriptive text")

    async def test_extra_field_count_is_capped(self):
        account_id = self._insert_account("Checking")
        # Seven descriptive columns; capture must stop at MAX_IMPORT_EVIDENCE_TEXT_FIELDS.
        await self._run_import(
            "\n".join([
                "Date,Description,Account,Amount,Memo,Notes,Narrative,Particulars,Remittance,Reference,Payee",
                "2026-01-02,POS 1,Checking,9.99,m one,n two,r three,p four,rem five,ref six,pay seven",
            ]),
            {"Checking": account_id},
        )
        extras = self._evidence().get("extra_text_fields", [])
        self.assertEqual(len(extras), MAX_IMPORT_EVIDENCE_TEXT_FIELDS)

    async def test_identical_descriptive_columns_not_stored_twice(self):
        account_id = self._insert_account("Checking")
        await self._run_import(
            "\n".join([
                "Date,Description,Account,Amount,Merchant,Original Merchant",
                "2026-01-02,POS 99,Checking,9.99,ACME CORP,ACME CORP",
            ]),
            {"Checking": account_id},
        )
        extras = self._evidence().get("extra_text_fields", [])
        # "Merchant" and an unedited "Original Merchant" are identical -> kept once, not twice.
        self.assertEqual([f["value"] for f in extras], ["ACME CORP"])

    async def test_extra_equal_to_account_label_not_duplicated(self):
        account_id = self._insert_account("Checking")
        await self._run_import(
            "\n".join([
                "Date,Description,Account,Amount,Payee",
                "2026-01-02,POS 1,WALMART,9.99,WALMART",
            ]),
            {"WALMART": account_id},
        )
        # The payee equals the account label (already shown), so it is not stored as an extra.
        self.assertEqual(self._evidence().get("extra_text_fields", []), [])

    async def test_check_number_folded_into_merchant(self):
        account_id = self._insert_account("Checking")
        await self._run_import(
            "\n".join([
                "Date,Description,Account,Amount,Check Number",
                "2026-01-02,Check,Checking,120.00,1042",
            ]),
            {"Checking": account_id},
        )
        txn = self._txn()
        self.assertEqual(txn["merchant_name"], "Check #1042")
        self.assertEqual(txn["display_name"], "Check #1042")
        self.assertEqual(txn["raw_name"], "Check", "raw source text stays literal")

    async def test_checkcard_purchase_is_not_treated_as_a_check(self):
        account_id = self._insert_account("Checking")
        await self._run_import(
            "\n".join([
                "Date,Description,Account,Amount,Check Number",
                "2026-01-02,CHECKCARD PURCHASE,Checking,9.99,5051",
            ]),
            {"Checking": account_id},
        )
        # "CHECKCARD" is a debit-card line, not a paper check -> the number must NOT be appended.
        self.assertEqual(self._txn()["merchant_name"], "CHECKCARD PURCHASE")

    async def test_check_number_already_in_description_is_not_duplicated(self):
        account_id = self._insert_account("Checking")
        await self._run_import(
            "\n".join([
                "Date,Description,Account,Amount,Check Number",
                "2026-01-02,Check 1042,Checking,120.00,1042",
            ]),
            {"Checking": account_id},
        )
        self.assertEqual(self._txn()["merchant_name"], "Check 1042")

    async def test_recognized_paypal_file_stamps_source_and_forces_type_item_title(self):
        # A PayPal Activity file: even with capture explicitly emptied, Type + Item Title are captured,
        # and the batch is stamped source:paypal.
        account_id = self._insert_account("PayPal")
        csv_text = "\n".join([
            '"Date","Time","TimeZone","Name","Type","Status","Currency","Amount","Fees","Total","Exchange Rate","Receipt ID","Balance","Transaction ID","Item Title"',
            '"2019-11-02","12:00:00","PST","Routeplot Ltd","Website Payment","Completed","USD","-10.00","0.00","-10.00","","R1","100.00","T1","Bike subscription"',
        ])
        config = {
            "filename": "Paypal-2019.csv",
            "profile_id": None,
            "account_id": account_id,
            "account_map": {},
            "skip_accounts": [],
            "new_accounts": None,
            # Name → description; capture explicitly emptied so nothing is captured *by choice*.
            "column_map": {"date": "Date", "description": "Name", "amount": "Amount", "evidence_columns": []},
            "date_format": "%Y-%m-%d",
            "amount_convention": "single_signed",
            "skip_rows": 0,
            "apply_categorization": False,
            "use_imported_categories": False,
        }
        with self._use_db_path():
            result = await run_import(file=FakeUploadFile("Paypal-2019.csv", csv_text), config=json.dumps(config))
            with get_db() as conn:
                batch = conn.execute("SELECT source_kind FROM import_batch WHERE id = ?", (result["batch_id"],)).fetchone()
        self.assertEqual(batch["source_kind"], "source:paypal")
        headers = {f["header"] for f in self._evidence().get("extra_text_fields", [])}
        self.assertIn("Type", headers)
        self.assertIn("Item Title", headers)


if __name__ == "__main__":
    unittest.main()
