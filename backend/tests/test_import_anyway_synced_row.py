"""
"Import anyway" on a duplicate a *sync* held, rather than a file.

The held payload is written by `record_sync_duplicate` and inserted by the importer's own
`_insert_imported_transaction`, and the two disagreed about its shape: the insert never wrote the provider
id, and read evidence from a key the sync never used. So a forced row arrived with no provider id — and
the next sync re-sending that transaction found nothing holding it and added it a second time — and with
no evidence for duplicate matching or enrichment to read. Reports held before the writer was fixed are
still in the database (and in backups), so the old shape is pinned too.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

from fastapi import HTTPException

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.import_export.core import BatchDuplicateImportRequest, import_batch_duplicates
from backend.routers.sync import record_sync_duplicate
from backend.services.duplicate_detection import DedupeVerdict
from backend.services.import_enrichment import enrich_duplicate_row

CARD = "card-1"
EVIDENCE = {"description": {"header": "Description", "value": "STREAMING SVC 0412"}}


class ImportAnywaySyncedRowTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.tempdir.name) / "sync-dupes.db")
        init_db(self.db_path)
        with get_db(self.db_path) as conn:
            conn.execute(
                "INSERT INTO account (id, external_account_id, provider, name, display_name, type, owner_id) "
                "VALUES ('acc-1', 'plaid-acct-1', 'plaid', 'Harborline Checking', 'Harborline Checking', "
                "'depository', ?)",
                (SHARED_OWNER_ID,),
            )
            conn.execute(
                "INSERT INTO import_batch (id, filename, row_count, skipped_count, deduped_count, config_snapshot, "
                "source_kind) VALUES (?, 'sync', 0, 0, 1, ?, 'connection_sync')",
                (CARD, json.dumps({"import_summary": {"imported_count": 0, "skipped_count": 0}})),
            )

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db(self):
        token = set_current_db_path(self.db_path)
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _hold(self, provider_id: str) -> None:
        """Hold a synced row the way a sync does when the ladder rejects it."""
        with get_db(self.db_path) as conn:
            record_sync_duplicate(
                conn, batch_id=CARD,
                txn={"date": "2026-04-12", "amount": 15.49, "raw_name": "STREAMING SVC 0412",
                     "external_transaction_id": provider_id},
                merchant_name="Streaming Service", content_hash="h-1",
                evidence_json=json.dumps(EVIDENCE),
                verdict=DedupeVerdict(hard_reject=True, passthrough=False, matched={"id": "other"},
                                      reason="Matches an existing transaction"),
                account_id="acc-1", owner_id=SHARED_OWNER_ID, source_label="Checking",
            )

    def _import_anyway(self) -> dict:
        with self._use_db():
            return import_batch_duplicates(CARD, BatchDuplicateImportRequest(import_all=True))

    def _forced(self):
        with get_db(self.db_path) as conn:
            return conn.execute(
                "SELECT external_transaction_id, owner_id, display_name, import_evidence_json FROM txn"
            ).fetchone()

    def test_the_forced_row_keeps_its_provider_id_evidence_and_owner(self):
        self._hold("plaid:t-1")
        self.assertEqual(self._import_anyway()["imported_count"], 1)
        row = self._forced()
        self.assertEqual(row["external_transaction_id"], "plaid:t-1")
        self.assertEqual(json.loads(row["import_evidence_json"]), EVIDENCE)
        self.assertEqual(row["owner_id"], SHARED_OWNER_ID)
        self.assertEqual(row["display_name"], "Streaming Service")

    def test_a_report_held_in_the_old_shape_imports_the_same_way(self):
        # Evidence as a JSON string, and no owner: what the sync wrote until its payload took the import shape.
        with get_db(self.db_path) as conn:
            conn.execute(
                "INSERT INTO import_batch_duplicate (batch_id, row_number, reason, values_json, "
                "matched_transaction_json, txn_payload_json) VALUES (?, 1, 'x', '{}', '{}', ?)",
                (CARD, json.dumps({
                    "account_id": "acc-1", "date": "2026-04-12", "amount": 15.49,
                    "merchant_name": "Streaming Service", "raw_name": "STREAMING SVC 0412",
                    "content_hash": "h-1", "import_evidence_json": json.dumps(EVIDENCE),
                    "external_transaction_id": "plaid:t-2", "display_name_source": "import",
                })),
            )
        self._import_anyway()
        row = self._forced()
        self.assertEqual(row["external_transaction_id"], "plaid:t-2")
        self.assertEqual(json.loads(row["import_evidence_json"]), EVIDENCE)
        self.assertEqual(row["owner_id"], SHARED_OWNER_ID)

    def test_a_held_row_whose_provider_id_is_already_in_the_ledger_is_not_imported_again(self):
        self._hold("plaid:t-3")
        with get_db(self.db_path) as conn:
            conn.execute(
                "INSERT INTO txn (id, external_transaction_id, account_id, amount, date) "
                "VALUES ('synced-later', 'plaid:t-3', 'acc-1', 15.49, '2026-04-12')"
            )
        # Refused as not importable, not by the UNIQUE constraint failing the whole request.
        with self.assertRaises(HTTPException):
            self._import_anyway()
        with get_db(self.db_path) as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM txn").fetchone()[0], 1)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM import_batch_duplicate").fetchone()[0], 1,
                             "the held row stays in the report")

    def test_a_forced_synced_row_goes_through_the_rules(self):
        # A sync holds its row before the rules run, so the held payload has no category to restore. The
        # forced row is categorized now, as a hand-entered row is, instead of landing uncategorized.
        with get_db(self.db_path) as conn:
            category_id = "cat-streaming"
            conn.execute("INSERT INTO category (id, name) VALUES (?, 'Streaming')", (category_id,))
            conn.execute(
                "INSERT INTO category_rule (id, category_id, keyword) VALUES ('r-stream', ?, 'streaming')",
                (category_id,),
            )
        self._hold("plaid:t-4")
        self._import_anyway()
        with get_db(self.db_path) as conn:
            row = conn.execute("SELECT category_id, category_source FROM txn").fetchone()
        self.assertEqual((row["category_id"], row["category_source"]), (category_id, "rule"))

    def test_enrichment_reads_a_synced_rows_evidence_in_either_shape(self):
        # The same key mismatch left enrichment with nothing to fold in from a synced row.
        with get_db(self.db_path) as conn:
            conn.execute(
                "INSERT INTO txn (id, account_id, amount, date, raw_name) "
                "VALUES ('held', 'acc-1', 15.49, '2026-04-12', 'Streaming Service')"
            )
            conn.execute(
                "INSERT INTO import_batch_duplicate (batch_id, row_number, reason, values_json, "
                "matched_transaction_json, txn_payload_json) VALUES (?, 1, 'x', '{}', '{}', ?)",
                (CARD, json.dumps({"account_id": "acc-1", "import_evidence_json": json.dumps(EVIDENCE)})),
            )
            self.assertIsNotNone(enrich_duplicate_row(conn, CARD, 1, "held"))


if __name__ == "__main__":
    unittest.main()
