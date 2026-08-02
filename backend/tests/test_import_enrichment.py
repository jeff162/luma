"""
The enrich-on-duplicate engine (`services/import_enrichment.py`): fold a later import's *novel* detail
into an existing transaction, additively and reversibly.

Pins the three properties: the delta is novel-only (nothing already on the row is re-copied), applying
it appends to `extra_text_fields` and is idempotent, and undo removes exactly what was added — plus the
duplicate-report record/undo cycle keyed on `import_batch_duplicate`.
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
from backend.services.import_enrichment import (
    compute_enrichment_delta,
    enrich_duplicate_row,
    enrich_transaction,
    unenrich_transaction,
    undo_duplicate_enrichment,
)


# A PayPal-style incoming payment leg: the counterparty and the item title the stored row lacks.
INCOMING_EVIDENCE = {
    "description": {"header": "Name", "value": "Clinton Moon"},
    "extra_text_fields": [{"header": "Item Title", "value": "Pats tix"}],
}


class DeltaTests(unittest.TestCase):
    def test_delta_keeps_only_novel_values(self):
        existing_evidence = {"description": {"header": "Merchant", "value": "Payment to Clinton Moon"}}
        delta = compute_enrichment_delta(existing_evidence, ("Payment to Clinton Moon", None, None), INCOMING_EVIDENCE)
        values = {f["value"] for f in delta}
        self.assertIn("Pats tix", values)       # genuinely new detail
        self.assertIn("Clinton Moon", values)   # differs from the stored "Payment to Clinton Moon"

    def test_delta_skips_values_already_present(self):
        # The row already carries both the counterparty and the item title → nothing new to add.
        existing_evidence = {
            "description": {"header": "Merchant", "value": "Clinton Moon"},
            "extra_text_fields": [{"header": "Memo", "value": "Pats tix"}],
        }
        delta = compute_enrichment_delta(existing_evidence, ("Clinton Moon", None, None), INCOMING_EVIDENCE)
        self.assertEqual(delta, [])

    def test_delta_matches_against_the_rows_names_too(self):
        # A value equal to the display/merchant/raw name is not novel even if absent from evidence.
        delta = compute_enrichment_delta({}, ("Clinton Moon", "CLINTON MOON", None), INCOMING_EVIDENCE)
        self.assertEqual({f["value"] for f in delta}, {"Pats tix"})


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "enrich.db"
        init_db(str(self.db_path))
        self.batch_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO account (id, external_account_id, provider, name, display_name, type, owner_id)
                   VALUES ('acct', 'p_acct', 'fixture', 'PayPal', 'PayPal', 'checking', ?)""",
                (SHARED_OWNER_ID,),
            )
            conn.execute("INSERT INTO import_batch (id, filename) VALUES (?, 'paypal.csv')", (self.batch_id,))

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _txn(self, *, merchant="Payment to Clinton Moon", evidence=None):
        txn_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO txn (id, account_id, owner_id, amount, merchant_name, display_name, raw_name,
                                    date, is_pending, import_evidence_json)
                   VALUES (?, 'acct', ?, 4130.0, ?, ?, ?, '2024-03-27', 0, ?)""",
                (txn_id, SHARED_OWNER_ID, merchant, merchant, merchant,
                 json.dumps(evidence) if evidence is not None else None),
            )
        return txn_id

    def _evidence(self, txn_id):
        with self._use_db_path(), get_db() as conn:
            raw = conn.execute("SELECT import_evidence_json FROM txn WHERE id = ?", (txn_id,)).fetchone()[0]
        return json.loads(raw) if raw else None

    def test_enrich_appends_novel_fields(self):
        txn_id = self._txn(evidence={"description": {"header": "Merchant", "value": "Payment to Clinton Moon"}})
        with self._use_db_path(), get_db() as conn:
            delta = enrich_transaction(conn, txn_id, INCOMING_EVIDENCE)
        self.assertEqual({f["value"] for f in delta}, {"Clinton Moon", "Pats tix"})
        extras = self._evidence(txn_id)["extra_text_fields"]
        self.assertIn({"header": "Item Title", "value": "Pats tix"}, extras)

    def test_enrich_is_idempotent(self):
        txn_id = self._txn(evidence={"description": {"header": "Merchant", "value": "Payment to Clinton Moon"}})
        with self._use_db_path(), get_db() as conn:
            enrich_transaction(conn, txn_id, INCOMING_EVIDENCE)
            second = enrich_transaction(conn, txn_id, INCOMING_EVIDENCE)  # re-run adds nothing
        self.assertIsNone(second)
        self.assertEqual(len(self._evidence(txn_id)["extra_text_fields"]), 2)

    def test_enrich_creates_evidence_when_row_had_none(self):
        txn_id = self._txn(evidence=None)  # e.g. a hand-created or synced row
        with self._use_db_path(), get_db() as conn:
            enrich_transaction(conn, txn_id, INCOMING_EVIDENCE)
        self.assertEqual({f["value"] for f in self._evidence(txn_id)["extra_text_fields"]}, {"Clinton Moon", "Pats tix"})

    def test_undo_removes_exactly_what_was_added(self):
        original = {"description": {"header": "Merchant", "value": "Payment to Clinton Moon"},
                    "extra_text_fields": [{"header": "Memo", "value": "wire"}]}
        txn_id = self._txn(evidence=dict(original))
        with self._use_db_path(), get_db() as conn:
            delta = enrich_transaction(conn, txn_id, INCOMING_EVIDENCE)
            unenrich_transaction(conn, txn_id, delta)
        # The row's own pre-existing "wire" field survives; the folded-in fields are gone.
        self.assertEqual(self._evidence(txn_id)["extra_text_fields"], [{"header": "Memo", "value": "wire"}])

    def test_duplicate_record_enrich_and_undo_cycle(self):
        txn_id = self._txn(evidence={"description": {"header": "Merchant", "value": "Payment to Clinton Moon"}})
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO import_batch_duplicate (batch_id, row_number, reason, txn_payload_json)
                   VALUES (?, 7, 'Falls within the covered range', ?)""",
                (self.batch_id, json.dumps({"import_evidence": INCOMING_EVIDENCE})),
            )
            delta = enrich_duplicate_row(conn, self.batch_id, 7, txn_id)
        self.assertEqual({f["value"] for f in delta}, {"Clinton Moon", "Pats tix"})

        with self._use_db_path(), get_db() as conn:
            rec = conn.execute(
                "SELECT enriched_txn_id, enriched_at FROM import_batch_duplicate WHERE batch_id = ? AND row_number = 7",
                (self.batch_id,),
            ).fetchone()
            self.assertEqual(rec["enriched_txn_id"], txn_id)
            self.assertIsNotNone(rec["enriched_at"])
            # Re-enriching a row already enriched is a no-op.
            self.assertIsNone(enrich_duplicate_row(conn, self.batch_id, 7, txn_id))
            undone = undo_duplicate_enrichment(conn, self.batch_id, 7)

        self.assertTrue(undone)
        self.assertIsNone(self._evidence(txn_id).get("extra_text_fields"))
        with self._use_db_path(), get_db() as conn:
            rec = conn.execute(
                "SELECT enriched_at FROM import_batch_duplicate WHERE batch_id = ? AND row_number = 7",
                (self.batch_id,),
            ).fetchone()
            self.assertIsNone(rec["enriched_at"])


class EndpointTests(unittest.TestCase):
    """The duplicate-report enrich/undo endpoints: enrich only unambiguous (single-candidate) rows,
    report the rest as skipped, and round-trip undo."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "enrich-endpoint.db"
        init_db(str(self.db_path))
        self.batch_id = str(uuid.uuid4())
        self.txn_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO account (id, external_account_id, provider, name, display_name, type, owner_id)
                   VALUES ('acct', 'p_acct', 'fixture', 'PayPal', 'PayPal', 'checking', ?)""",
                (SHARED_OWNER_ID,),
            )
            conn.execute("INSERT INTO import_batch (id, filename) VALUES (?, 'paypal.csv')", (self.batch_id,))
            conn.execute(
                """INSERT INTO txn (id, account_id, owner_id, amount, merchant_name, display_name, raw_name,
                                    date, is_pending, import_evidence_json)
                   VALUES (?, 'acct', ?, 4130.0, 'Payment to Clinton Moon', 'Payment to Clinton Moon',
                           'Payment to Clinton Moon', '2024-03-27', 0, ?)""",
                (self.txn_id, SHARED_OWNER_ID,
                 json.dumps({"description": {"header": "Merchant", "value": "Payment to Clinton Moon"}})),
            )

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _dup(self, row_number, candidates):
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO import_batch_duplicate (batch_id, row_number, reason, txn_payload_json, matched_transaction_json)
                   VALUES (?, ?, 'covered', ?, ?)""",
                (self.batch_id, row_number,
                 json.dumps({"import_evidence": INCOMING_EVIDENCE}),
                 json.dumps({"candidates": candidates})),
            )

    def test_enrich_endpoint_folds_single_match_and_skips_the_rest(self):
        from backend.routers.import_export.core import enrich_batch_duplicates, BatchDuplicateEnrichRequest
        self._dup(7, [{"id": self.txn_id}])   # single match → enriched
        self._dup(8, [])                       # no match → skipped
        self._dup(9, [{"id": self.txn_id}, {"id": "other"}])  # ambiguous → skipped
        with self._use_db_path():
            result = enrich_batch_duplicates(self.batch_id, BatchDuplicateEnrichRequest(row_numbers=[7, 8, 9]))
        self.assertEqual([e["row"] for e in result["enriched"]], [7])
        self.assertIn("Pats tix", {f["value"] for f in result["enriched"][0]["added"]})
        self.assertEqual({s["row"] for s in result["skipped"]}, {8, 9})
        with self._use_db_path(), get_db() as conn:
            evidence = json.loads(conn.execute("SELECT import_evidence_json FROM txn WHERE id = ?", (self.txn_id,)).fetchone()[0])
        self.assertIn("Pats tix", {f["value"] for f in evidence["extra_text_fields"]})

    def test_enrich_endpoint_empty_rows_means_the_whole_batch(self):
        # The file card's "Enrich existing transactions from this source" toggle sends no row_numbers:
        # every duplicate row of the batch is attempted (with the usual skips), and the empty-rows undo
        # reverses every enriched row — a full on/off round trip.
        from backend.routers.import_export.core import (
            enrich_batch_duplicates,
            undo_batch_duplicate_enrichment_endpoint,
            BatchDuplicateEnrichRequest,
        )
        self._dup(7, [{"id": self.txn_id}])   # single match → enriched
        self._dup(8, [])                       # no match → skipped
        with self._use_db_path():
            result = enrich_batch_duplicates(self.batch_id, BatchDuplicateEnrichRequest())
            self.assertEqual([e["row"] for e in result["enriched"]], [7])
            self.assertEqual({s["row"] for s in result["skipped"]}, {8})
            undone = undo_batch_duplicate_enrichment_endpoint(self.batch_id, BatchDuplicateEnrichRequest())
        self.assertEqual(undone["undone"], 1)
        with self._use_db_path(), get_db() as conn:
            evidence = json.loads(conn.execute("SELECT import_evidence_json FROM txn WHERE id = ?", (self.txn_id,)).fetchone()[0])
        self.assertNotIn("extra_text_fields", evidence)

    def test_enrich_endpoint_undo_round_trips(self):
        from backend.routers.import_export.core import (
            enrich_batch_duplicates,
            undo_batch_duplicate_enrichment_endpoint,
            BatchDuplicateEnrichRequest,
        )
        self._dup(7, [{"id": self.txn_id}])
        with self._use_db_path():
            enrich_batch_duplicates(self.batch_id, BatchDuplicateEnrichRequest(row_numbers=[7]))
            undone = undo_batch_duplicate_enrichment_endpoint(self.batch_id, BatchDuplicateEnrichRequest(row_numbers=[7]))
        self.assertEqual(undone["undone"], 1)
        with self._use_db_path(), get_db() as conn:
            evidence = json.loads(conn.execute("SELECT import_evidence_json FROM txn WHERE id = ?", (self.txn_id,)).fetchone()[0])
        self.assertNotIn("extra_text_fields", evidence)   # back to the pre-enrich state


if __name__ == "__main__":
    unittest.main()
