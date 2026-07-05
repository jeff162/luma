"""
Per-source auto-enrich (Phase 3): when a data source is flagged `enrich_from_source`, importing from it
folds each hard-rejected duplicate's novel detail into the existing transaction it matched — silently,
but reported and reversible.

Covered here, end-to-end through the real import path:
  * a rich source enriches the existing (sparse) row it duplicates; the count is reported.
  * the flag off leaves the existing row untouched.
  * re-importing the same rich file is idempotent (delta already present -> nothing new, count 0).
  * undoing the enriching batch reverses the change to the existing (non-batch) row.
  * an ambiguous match (>1 candidate) is skipped, not force-enriched.
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
from backend.routers.import_export.core import _enrich_duplicate_rows, undo_batch


class FakeUploadFile:
    def __init__(self, filename, content):
        self.filename = filename
        self._content = content.encode("utf-8")

    async def read(self):
        return self._content


# A sparse "aggregator" row and the richer "PayPal" export of the same transaction (same date/amount/
# name so it hard-rejects as a duplicate; the rich file additionally carries an Item Title).
SPARSE_CSV = "\n".join([
    "Date,Name,Account,Amount",
    "2026-03-24,Clinton Moon,Checking,4130.00",
])
RICH_CSV = "\n".join([
    "Date,Name,Account,Amount,Item Title",
    "2026-03-24,Clinton Moon,Checking,4130.00,Pats Tix",
])
# A second, distinct rich source (different file content -> not blocked as a re-import) carrying the
# same transaction and the same Item Title, used to prove enrichment doesn't double-add.
RICH_CSV_B = "\n".join([
    "Date,Name,Account,Amount,Item Title,Ref",
    "2026-03-24,Clinton Moon,Checking,4130.00,Pats Tix,R1",
])


class AutoEnrichImportTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "auto-enrich.db"
        init_db(str(self.db_path))
        self.account_id = self._insert_account("Checking")

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
                    VALUES (?, ?, ?, ?, ?, 'checking', 'checking', '1234', ?, NULL, NULL)
                    """,
                    (account_id, f"test_{account_id}", "fixture_import", name, name, SHARED_OWNER_ID),
                )
        return account_id

    async def _run_import(self, csv_text, *, enrich_from_source=False, evidence_columns=None):
        column_map = {"date": "Date", "description": "Name", "account": "Account", "amount": "Amount"}
        if evidence_columns is not None:
            column_map["evidence_columns"] = evidence_columns
        config = {
            "filename": "fixture.csv",
            "account_map": {"Checking": self.account_id},
            "column_map": column_map,
            "date_format": "%Y-%m-%d",
            "amount_convention": "single_signed",
            "apply_categorization": False,
            "enrich_from_source": enrich_from_source,
        }
        with self._use_db_path():
            return await run_import(file=FakeUploadFile("fixture.csv", csv_text), config=json.dumps(config))

    def _existing_evidence_values(self):
        with self._use_db_path():
            with get_db() as conn:
                raw = conn.execute(
                    "SELECT import_evidence_json FROM txn ORDER BY import_batch_id LIMIT 1"
                ).fetchone()["import_evidence_json"]
        evidence = json.loads(raw) if raw else {}
        return [field.get("value") for field in evidence.get("extra_text_fields", [])]

    async def test_rich_source_enriches_existing_duplicate_and_reports_count(self):
        await self._run_import(SPARSE_CSV)  # establishes the existing row, no Item Title
        self.assertNotIn("Pats Tix", self._existing_evidence_values())

        result = await self._run_import(RICH_CSV, enrich_from_source=True, evidence_columns=["Item Title"])

        self.assertEqual(result["deduped"], 1, "the rich row is a duplicate, not a new import")
        self.assertEqual(result["enriched_count"], 1)
        self.assertIn("Pats Tix", self._existing_evidence_values(), "novel detail folded into the existing row")

    async def test_flag_off_does_not_enrich(self):
        await self._run_import(SPARSE_CSV)
        result = await self._run_import(RICH_CSV, enrich_from_source=False, evidence_columns=["Item Title"])
        self.assertEqual(result["deduped"], 1)
        self.assertEqual(result["enriched_count"], 0)
        self.assertNotIn("Pats Tix", self._existing_evidence_values())

    async def test_second_rich_source_with_same_detail_is_idempotent(self):
        await self._run_import(SPARSE_CSV)
        first = await self._run_import(RICH_CSV, enrich_from_source=True, evidence_columns=["Item Title"])
        self.assertEqual(first["enriched_count"], 1)
        # A different rich source carrying the same transaction + same detail: still a duplicate, but
        # the detail is already present, so nothing new is folded in and it isn't stored twice.
        second = await self._run_import(RICH_CSV_B, enrich_from_source=True, evidence_columns=["Item Title"])
        self.assertEqual(second["enriched_count"], 0, "no new detail to add")
        self.assertEqual(self._existing_evidence_values().count("Pats Tix"), 1, "not duplicated")

    async def test_undo_reverses_enrichment_on_the_existing_row(self):
        await self._run_import(SPARSE_CSV)
        result = await self._run_import(RICH_CSV, enrich_from_source=True, evidence_columns=["Item Title"])
        self.assertIn("Pats Tix", self._existing_evidence_values())

        with self._use_db_path():
            undo_batch(result["batch_id"], force=True)

        self.assertNotIn("Pats Tix", self._existing_evidence_values(),
                         "undoing the batch must reverse the change it made to the pre-existing row")

    async def test_ambiguous_match_is_skipped(self):
        # A duplicate record whose match carries two candidates must not be force-enriched.
        target = str(uuid.uuid4())
        batch_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO import_batch (id, filename, file_content_hash, row_count, skipped_count, deduped_count, config_snapshot) "
                    "VALUES (?, 'f.csv', 'h', 0, 0, 1, '{}')",
                    (batch_id,),
                )
                conn.execute(
                    """INSERT INTO import_batch_duplicate (batch_id, row_number, reason, values_json, matched_transaction_json, txn_payload_json)
                       VALUES (?, 2, 'covered', '{}', ?, ?)""",
                    (
                        batch_id,
                        json.dumps({"candidates": [{"id": target}, {"id": str(uuid.uuid4())}]}),
                        json.dumps({"import_evidence": {"extra_text_fields": [{"header": "Item Title", "value": "Pats Tix"}]}}),
                    ),
                )
                enriched, skipped = _enrich_duplicate_rows(conn, batch_id, [2])
        self.assertEqual(enriched, [])
        self.assertEqual(skipped, [{"row": 2, "reason": "ambiguous match"}])


if __name__ == "__main__":
    unittest.main()
