"""
The Amazon funding-source → account map (`services/amazon_funding.py`): resolution order
(override → global → unmapped), the untracked short-circuit, upsert idempotency, and many-to-one.

All data here is fabricated.
"""

from __future__ import annotations

import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import (
    SHARED_OWNER_ID,
    get_db,
    init_db,
    reset_current_db_path,
    set_current_db_path,
)
from backend.services import amazon_funding


class AmazonFundingMapTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "amzfund.db"
        init_db(str(self.db_path))
        with self._use_db_path(), get_db() as conn:
            for acc in ("amazon", "amazon2", "card", "card2"):
                conn.execute(
                    """INSERT INTO account (id, plaid_account_id, plaid_item_id, name, display_name, type, owner_id)
                       VALUES (?, ?, 'fixture', ?, ?, 'credit', ?)""",
                    (acc, f"p_{acc}", acc, acc, SHARED_OWNER_ID),
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

    def _resolve(self, amazon_account_id, last4, network):
        with self._use_db_path(), get_db() as conn:
            return amazon_funding.resolve_funding_account(conn, amazon_account_id, last4, network)

    # ---- resolution order -------------------------------------------------------------------------

    def test_unmapped_instrument_resolves_unmapped(self):
        r = self._resolve("amazon", "4455", "Fablecard")
        self.assertEqual(r.state, "unmapped")
        self.assertIsNone(r.funding_account_id)

    def test_no_last4_is_unmapped(self):
        # A bare off-card leg has no last-4, so it can't be keyed.
        self.assertEqual(self._resolve("amazon", None, "Fablecard").state, "unmapped")

    def test_global_mapping_applies_to_any_amazon_account(self):
        with self._use_db_path(), get_db() as conn:
            amazon_funding.upsert_funding_source(conn, last4="4455", network="Fablecard",
                                                 funding_account_id="card")
        # Mapped for the account that set it up *and* for a different Amazon account (global default).
        for amz in ("amazon", "amazon2"):
            r = self._resolve(amz, "4455", "Fablecard")
            self.assertEqual(r.state, "mapped")
            self.assertEqual(r.funding_account_id, "card")

    def test_override_wins_over_global(self):
        with self._use_db_path(), get_db() as conn:
            amazon_funding.upsert_funding_source(conn, last4="4455", network="Fablecard",
                                                 funding_account_id="card")  # global → card
            amazon_funding.upsert_funding_source(conn, last4="4455", network="Fablecard",
                                                 funding_account_id="card2", amazon_account_id="amazon2")
        # amazon2 sees its override; every other Amazon account sees the global default.
        self.assertEqual(self._resolve("amazon2", "4455", "Fablecard").funding_account_id, "card2")
        self.assertEqual(self._resolve("amazon", "4455", "Fablecard").funding_account_id, "card")

    def test_untracked_short_circuits(self):
        with self._use_db_path(), get_db() as conn:
            amazon_funding.upsert_funding_source(conn, last4="9999", network="Othercard", untracked=True)
        r = self._resolve("amazon", "9999", "Othercard")
        self.assertEqual(r.state, "untracked")
        self.assertIsNone(r.funding_account_id)

    def test_network_is_part_of_identity(self):
        with self._use_db_path(), get_db() as conn:
            amazon_funding.upsert_funding_source(conn, last4="4455", network="Fablecard",
                                                 funding_account_id="card")
        # Same last-4, different network → a different instrument, still unmapped.
        self.assertEqual(self._resolve("amazon", "4455", "Othercard").state, "unmapped")

    # ---- upsert idempotency & many-to-one ---------------------------------------------------------

    def test_upsert_updates_in_place(self):
        with self._use_db_path(), get_db() as conn:
            id1 = amazon_funding.upsert_funding_source(conn, last4="4455", network="Fablecard",
                                                       funding_account_id="card")
            id2 = amazon_funding.upsert_funding_source(conn, last4="4455", network="Fablecard",
                                                       funding_account_id="card2")
            self.assertEqual(id1, id2)  # same row, updated — not a duplicate
            self.assertEqual(len(amazon_funding.list_funding_map(conn)), 1)
        self.assertEqual(self._resolve("amazon", "4455", "Fablecard").funding_account_id, "card2")

    def test_many_to_one_and_reissue(self):
        # Two instruments (a card reissue: new last-4) both point at the same funding account — a
        # first-class case, not a conflict.
        with self._use_db_path(), get_db() as conn:
            amazon_funding.upsert_funding_source(conn, last4="4455", network="Fablecard",
                                                 funding_account_id="card")
            amazon_funding.upsert_funding_source(conn, last4="7788", network="Fablecard",
                                                 funding_account_id="card")
            self.assertEqual(len(amazon_funding.list_funding_map(conn)), 2)
        self.assertEqual(self._resolve("amazon", "4455", "Fablecard").funding_account_id, "card")
        self.assertEqual(self._resolve("amazon", "7788", "Fablecard").funding_account_id, "card")

    def test_delete_returns_to_unmapped(self):
        with self._use_db_path(), get_db() as conn:
            mid = amazon_funding.upsert_funding_source(conn, last4="4455", network="Fablecard",
                                                       funding_account_id="card")
            self.assertTrue(amazon_funding.delete_funding_source(conn, mid))
            self.assertFalse(amazon_funding.delete_funding_source(conn, mid))  # already gone
        self.assertEqual(self._resolve("amazon", "4455", "Fablecard").state, "unmapped")

    def test_list_reports_untracked_and_account_name(self):
        with self._use_db_path(), get_db() as conn:
            amazon_funding.upsert_funding_source(conn, last4="4455", network="Fablecard",
                                                 funding_account_id="card")
            amazon_funding.upsert_funding_source(conn, last4="9999", network="Othercard", untracked=True)
            mappings = {m["last4"]: m for m in amazon_funding.list_funding_map(conn)}
        self.assertEqual(mappings["4455"]["funding_account_name"], "card")
        self.assertFalse(mappings["4455"]["untracked"])
        self.assertTrue(mappings["9999"]["untracked"])
        self.assertIsNone(mappings["9999"]["funding_account_id"])


if __name__ == "__main__":
    unittest.main()
