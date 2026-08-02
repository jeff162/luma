"""
Cross-account transfer twin for coverage-rejected funding/deposit legs.

A wallet (PayPal/Venmo/…) Activity CSV logs a funding/deposit leg — money into the wallet — whose
real-world twin is the *funding* transaction on the bank/card account: same magnitude, a day or three
off (ACH/settlement lag), named for the wallet. That twin is cross-account and opposite-signed, so the
same-account coverage lookup never sees it and the leg reads as a bare "no specific match". These tests
pin `_find_cross_account_transfer_candidates` (the targeted SQL that finds the twin) directly.
"""

from __future__ import annotations

import json
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.import_export.core import _find_cross_account_transfer_candidates


class CrossAccountTransferMatchTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "transfer-match.db"
        init_db(str(self.db_path))
        with self._use_db_path(), get_db() as conn:
            for acc_id, name in (("paypal", "PayPal"), ("checking", "Northgate Checking"), ("card", "Northgate Rewards")):
                conn.execute(
                    """INSERT INTO account (id, external_account_id, provider, name, display_name, type, owner_id)
                       VALUES (?, ?, 'fixture', ?, ?, 'checking', ?)""",
                    (acc_id, f"p_{acc_id}", name, name, SHARED_OWNER_ID),
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

    def _txn(self, account_id, amount, date, name, *, original_description=None):
        tid = str(uuid.uuid4())
        evidence = None
        if original_description is not None:
            evidence = json.dumps({"extra_text_fields": [{"header": "Original Description", "value": original_description}]})
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO txn (id, account_id, owner_id, amount, merchant_name, display_name, raw_name, date, is_pending, import_evidence_json)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)""",
                (tid, account_id, SHARED_OWNER_ID, amount, name, name, name, date, evidence),
            )
        return tid

    def _find(self, date, amount):
        with self._use_db_path(), get_db() as conn:
            return _find_cross_account_transfer_candidates(conn, "paypal", date, amount)

    def test_finds_the_opposite_signed_funding_twin_named_for_the_wallet(self):
        # Deposit leg into PayPal is stored -716 (a credit); the funding row on Northgate Checking is +716,
        # named "PayPal", a day later — the twin the same-account lookup can't see.
        fund = self._txn("checking", 716.0, "2026-01-21", "PayPal")
        out = self._find("2026-01-20", -716.0)
        self.assertEqual([c["id"] for c in out], [fund])
        self.assertTrue(out[0]["cross_account"])
        self.assertEqual(out[0]["account_name"], "Northgate Checking")

    def test_matches_a_wallet_token_embedded_in_a_longer_name(self):
        fund = self._txn("checking", 2251.67, "2026-03-12", "WDRL-ACH PAYPAL INSTANT TRANSFER - INST XFER")
        out = self._find("2026-03-11", -2251.67)
        self.assertEqual([c["id"] for c in out], [fund])

    def test_matches_via_original_description_evidence_when_the_clean_name_omits_the_wallet(self):
        # The common Mint shape: the cleaned display name drops "PayPal" but the captured Original
        # Description keeps it. Searching the source text (not just the name) must still find the twin.
        fund = self._txn(
            "checking", 254.88, "2026-08-24", "ELECTRONIC PAYMENT  INST XFER 200824",
            original_description="ELECTRONIC PAYMENT PAYPAL    INST XFER    200824",
        )
        out = self._find("2026-08-23", -254.88)
        self.assertEqual([c["id"] for c in out], [fund])
        self.assertTrue(out[0]["cross_account"])

    def test_ignores_same_amount_rows_not_named_for_the_wallet(self):
        # A same-amount, near-date charge on another account that doesn't mention PayPal is not the twin.
        self._txn("card", 716.0, "2026-01-20", "Whole Foods")
        self.assertEqual(self._find("2026-01-20", -716.0), [])

    def test_ignores_rows_whose_name_and_evidence_both_lack_the_wallet(self):
        # Evidence text must not become a false-positive source: a same-amount, near-date row whose name
        # AND Original Description both omit PayPal is still not the twin.
        self._txn(
            "card", 716.0, "2026-01-20", "ELECTRONIC PAYMENT  INST XFER",
            original_description="ELECTRONIC PAYMENT  INST XFER 200120",
        )
        self.assertEqual(self._find("2026-01-20", -716.0), [])

    def test_ignores_rows_outside_the_window_and_on_the_wallet_itself(self):
        self._txn("checking", 716.0, "2026-01-28", "PayPal")           # 8 days off — outside ±3
        self._txn("paypal", 716.0, "2026-01-20", "PayPal transfer")    # on the wallet itself
        self.assertEqual(self._find("2026-01-20", -716.0), [])

    def test_ignores_trashed_twins(self):
        with self._use_db_path(), get_db() as conn:
            tid = self._txn("checking", 716.0, "2026-01-21", "PayPal")
            conn.execute("UPDATE txn SET trashed_at = '2026-02-01T00:00:00Z' WHERE id = ?", (tid,))
        self.assertEqual(self._find("2026-01-20", -716.0), [])

    def test_nearest_date_ranks_first(self):
        far = self._txn("checking", 388.5, "2026-03-08", "PayPal")   # 3 off
        near = self._txn("card", 388.5, "2026-03-05", "PayPal")      # exact
        out = self._find("2026-03-05", -388.5)
        self.assertEqual([c["id"] for c in out], [near, far])


if __name__ == "__main__":
    unittest.main()
