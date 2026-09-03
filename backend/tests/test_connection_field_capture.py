"""
Per-transaction field capture from a data-source connection.

Two things are being pinned. First, the provider boundary actually extracts the fields duplicate
detection depends on — above all `authorized_date`, since two sources reporting *different* dates for
the same charge is what made real duplicates read as near-misses. Second, a synced row's captured
detail lands in the same `import_evidence_json` shape a CSV import writes, because that shape is what
the dedupe text matcher and the terminal-window matcher both read; a bespoke shape would leave synced
rows invisible to them exactly as carrying no evidence at all did.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from contextlib import contextmanager
from datetime import date
from pathlib import Path

from backend.db import control_database as cdb
from backend.db import database
from backend.services import plaid_service
from backend.services.connection_mapping import build_sync_evidence, captured_field_keys
from backend.services.duplicate_detection import (
    collect_duplicate_match_texts,
    parse_import_evidence,
    source_match_texts,
)
from backend.services.import_evidence import EVIDENCE_ROLE_CATEGORICAL
from backend.services.providers import PlaidAdapter


@contextmanager
def _isolated_db():
    tmp = tempfile.TemporaryDirectory()
    data_path = str(Path(tmp.name) / "data.db")
    originals = (database.DB_PATH, cdb.DB_PATH, cdb.CONTROL_DB_PATH)
    database.DB_PATH = data_path
    cdb.DB_PATH = data_path
    cdb.CONTROL_DB_PATH = str(Path(tmp.name) / "control.db")
    database.init_db(data_path)
    try:
        yield data_path
    finally:
        database.DB_PATH, cdb.DB_PATH, cdb.CONTROL_DB_PATH = originals
        tmp.cleanup()


# A Plaid transaction with every capture-relevant field populated, shaped as the SDK returns it.
PLAID_TXN = {
    "transaction_id": "txn-1",
    "account_id": "acct-1",
    "amount": 20.0,
    "date": date(2026, 7, 5),
    "authorized_date": date(2026, 7, 2),
    "name": "CAREMARK MAIL",
    "merchant_name": "CVS Caremark",
    "merchant_entity_id": "ent-cvs",
    "pending": False,
    "pending_transaction_id": None,
    "counterparties": [{"name": "CVS Caremark", "type": "merchant"}, {"name": "", "type": "junk"}],
    "transaction_code": "check",
    "payment_meta": {"reference_number": "1042"},
    "location": {"address": "1 Main St", "city": "Boston", "region": "MA", "postal_code": "02101"},
}


class PlaidNormalizationTests(unittest.TestCase):
    def test_authorized_date_is_captured_separately_from_the_posted_date(self):
        out = plaid_service._normalize_txn(PLAID_TXN)
        self.assertEqual(out["date"], "2026-07-05")
        self.assertEqual(out["authorized_date"], "2026-07-02")

    def test_missing_authorized_date_is_none_not_an_error(self):
        out = plaid_service._normalize_txn({**PLAID_TXN, "authorized_date": None})
        self.assertIsNone(out["authorized_date"])

    def test_check_number_only_when_the_transaction_code_says_check(self):
        # payment_meta.reference_number carries unrelated references under other transaction codes, so
        # reading it unconditionally would invent check numbers and make distinct transactions look
        # like distinct *checks* — suppressing genuine duplicate matches.
        self.assertEqual(plaid_service._normalize_txn(PLAID_TXN)["check_number"], "1042")
        other = plaid_service._normalize_txn({**PLAID_TXN, "transaction_code": "purchase"})
        self.assertIsNone(other["check_number"])

    def test_counterparties_drop_blanks_and_deduplicate(self):
        out = plaid_service._normalize_txn(PLAID_TXN)
        self.assertEqual(out["counterparties"], ["CVS Caremark"])

    def test_adapter_passes_capture_fields_through_the_neutral_seam(self):
        normalized = PlaidAdapter._normalize_txn(plaid_service._normalize_txn(PLAID_TXN))
        self.assertEqual(normalized["authorized_date"], "2026-07-02")
        self.assertEqual(normalized["check_number"], "1042")
        self.assertEqual(normalized["merchant_entity_id"], "ent-cvs")
        self.assertEqual(normalized["counterparties"], ["CVS Caremark"])
        # No Plaid field names survive the seam.
        self.assertNotIn("plaid_transaction_id", normalized)

    def test_every_declared_capture_field_is_actually_produced(self):
        # Fail-on-omission: a field the picker offers but the adapter never fills would be a control
        # that silently does nothing.
        normalized = PlaidAdapter._normalize_txn(plaid_service._normalize_txn(PLAID_TXN))
        produced = set(normalized) | {"provider_description"}  # provider_description == raw_name
        for field in PlaidAdapter().capture_fields():
            self.assertIn(field["key"], produced, f"{field['key']} is offered but never captured")


class SyncEvidenceTests(unittest.TestCase):
    def _evidence(self, _captured={"location"}, **overrides):
        txn = {
            "raw_name": "CAREMARK MAIL",
            "authorized_date": "2026-07-02",
            "merchant_entity_id": "ent-cvs",
            "counterparties": ["CVS Caremark"],
            "check_number": "1042",
            "location": "1 Main St, Boston, MA",
            **overrides,
        }
        return json.loads(build_sync_evidence(txn, source_label="CREDIT CARD ···4103",
                                              captured_fields=_captured))

    def test_account_label_is_written_so_the_row_can_serve_as_a_terminal_candidate(self):
        # The terminal-window matcher identifies a row's source account from evidence.account.value.
        # Without it a synced row can never be a candidate, which is why synced rows were invisible to
        # that rule entirely.
        ev = self._evidence()
        self.assertEqual(ev["account"], {"header": "Account", "value": "CREDIT CARD ···4103"})

    def test_captured_detail_feeds_the_shared_text_matcher(self):
        # The payoff: because the shape matches a CSV's, collect_duplicate_match_texts picks the
        # provider's descriptor and counterparties up with no per-source handling.
        raw = build_sync_evidence(
            {"raw_name": "CAREMARK MAIL", "counterparties": ["CVS Caremark"], "authorized_date": None,
             "merchant_entity_id": None, "check_number": None, "location": None},
            source_label="CREDIT CARD ···4103", captured_fields=set(),
        )
        texts = collect_duplicate_match_texts(
            merchant_name="CVS Caremark", display_name=None, raw_name="CAREMARK MAIL",
            import_evidence=parse_import_evidence(raw),
        )
        self.assertIn("CVS Caremark", texts)
        self.assertIn("CAREMARK MAIL", texts)

    def test_optional_fields_are_gated_but_dedupe_relevant_ones_are_not(self):
        headers = lambda ev: {f["header"] for f in ev.get("extra_text_fields", [])}
        with_location = self._evidence(_captured={"location"})
        self.assertIn("Location", headers(with_location))

        without = self._evidence(_captured=set())
        self.assertNotIn("Location", headers(without))
        # Locked captures stay regardless of the user's optional selection.
        self.assertEqual(headers(without), {"Counterparty", "Merchant ID", "Check number", "Authorized date"})

    def test_empty_values_are_omitted_rather_than_stored_blank(self):
        ev = self._evidence(merchant_entity_id=None, check_number="", counterparties=[], _captured=set())
        self.assertEqual({f["header"] for f in ev.get("extra_text_fields", [])}, {"Authorized date"})

    def test_only_the_counterparty_is_offered_to_the_duplicate_text_matcher(self):
        # A CSV infers roles from column cardinality; a sync stamps them, because it knows what each
        # field is. Everything but the counterparty is structured metadata two unrelated charges can
        # carry identically — the authorized date most of all, since every synced row has one and the
        # cross-account sweep already spends the date as its ±7-day window. Leaving these unstamped
        # made any two same-amount rows sharing an authorized date an exact-tier duplicate.
        ev = self._evidence()
        roles = {f["header"]: f.get("role") for f in ev["extra_text_fields"]}
        self.assertIsNone(roles["Counterparty"])
        for header in ("Merchant ID", "Check number", "Authorized date", "Location"):
            self.assertEqual(roles[header], EVIDENCE_ROLE_CATEGORICAL, header)

        # The behavior the roles buy: only the counterparty reaches the cross-account matcher.
        texts = source_match_texts("CVS Caremark", "CAREMARK MAIL", json.dumps(ev))
        self.assertEqual(texts, {"cvs caremark", "caremark mail"})


class CapturedFieldSelectionTests(unittest.TestCase):
    def setUp(self):
        self._stack = _isolated_db()
        self._stack.__enter__()
        with database.get_db() as conn:
            conn.execute(
                "INSERT INTO connection (id, provider, external_id, institution) VALUES ('c1','plaid','i1','Northgate')"
            )

    def tearDown(self):
        self._stack.__exit__(None, None, None)

    def test_defaults_apply_when_the_user_has_chosen_nothing(self):
        with database.get_db() as conn:
            keys = captured_field_keys(conn, "c1", PlaidAdapter())
        expected = {f["key"] for f in PlaidAdapter().capture_fields() if not f["locked"] and f["default_on"]}
        self.assertEqual(keys, expected)

    def test_a_stored_selection_replaces_the_defaults(self):
        with database.get_db() as conn:
            conn.execute("UPDATE connection SET captured_fields = ? WHERE id = 'c1'", (json.dumps(["location"]),))
            self.assertEqual(captured_field_keys(conn, "c1", PlaidAdapter()), {"location"})

    def test_an_empty_selection_means_none_not_fall_back_to_defaults(self):
        # A user turning everything off must not silently get the defaults back.
        with database.get_db() as conn:
            conn.execute("UPDATE connection SET captured_fields = ? WHERE id = 'c1'", (json.dumps([]),))
            self.assertEqual(captured_field_keys(conn, "c1", PlaidAdapter()), set())

    def test_locked_and_unknown_keys_are_never_returned_as_optional(self):
        with database.get_db() as conn:
            conn.execute(
                "UPDATE connection SET captured_fields = ? WHERE id = 'c1'",
                (json.dumps(["authorized_date", "made_up", "location"]),),
            )
            self.assertEqual(captured_field_keys(conn, "c1", PlaidAdapter()), {"location"})


if __name__ == "__main__":
    unittest.main()
