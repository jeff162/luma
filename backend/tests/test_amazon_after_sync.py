"""
An Amazon order imported before its card charge synced pairs with the charge when the sync brings it.

The Amazon import matches a new order against the charges already in the ledger, so a file imported
before the card's sync found nothing; the sync runs the match for the rows it brought
(``match_orders_after_ingest``). The rest of the rule is pinned at the service in
``test_amazon_enrich.py``; this pins that the sync reaches it.

All data here is fabricated.
"""

from __future__ import annotations

import tempfile
import unittest
from contextlib import contextmanager
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers import sync as sync_module
from backend.routers.import_export.amazon import amazon_reconciliation, run_amazon_import
from backend.services.amazon_import import AmazonOrder, PaymentLeg
from backend.tests._fake_adapter import FakeCursorAdapter


class _FrozenDate(date):
    @classmethod
    def today(cls):
        return date(2026, 8, 10)


class _Adapter(FakeCursorAdapter):
    def __init__(self, added):
        super().__init__()
        self._added = added

    def fetch_transactions_sync(self, app_config, credential, *, cursor=None, days_requested=730,
                                account_targets=None, **kwargs):
        added, self._added = self._added, []
        return {**super().fetch_transactions_sync(app_config, credential, cursor=cursor,
                                                  days_requested=days_requested,
                                                  account_targets=account_targets, **kwargs),
                "added": added, "next_cursor": "c1"}


class AmazonAfterSyncTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "amz-sync.db"
        init_db(str(self.db_path))
        with self._db() as conn:
            conn.execute(
                "INSERT INTO connection (id, provider, external_id, credential, institution) "
                "VALUES ('conn-1','simplefin','item-1','','Harborline')"
            )
            conn.execute(
                "INSERT INTO account (id, name, display_name, type, owner_id, external_account_id, connection_id,"
                " provider) VALUES ('card', 'Rewards Card', 'Rewards Card', 'credit', ?, 'ext-card', 'conn-1',"
                " 'simplefin')",
                (SHARED_OWNER_ID,),
            )
            conn.execute(
                "INSERT INTO account (id, name, display_name, type, owner_id) VALUES ('amazon', 'Amazon', 'Amazon',"
                " 'other', ?)",
                (SHARED_OWNER_ID,),
            )

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _db(self):
        token = set_current_db_path(str(self.db_path))
        try:
            with get_db() as conn:
                yield conn
        finally:
            reset_current_db_path(token)

    def _sync(self, added):
        request = SimpleNamespace(state=SimpleNamespace(user={"id": "u1"}))
        token = set_current_db_path(str(self.db_path))
        try:
            with mock.patch.object(sync_module.crypto_service, "is_unlocked", return_value=True), \
                 mock.patch.object(sync_module.crypto_service, "decrypt_connection_credential", return_value="tok"), \
                 mock.patch.object(sync_module, "resolve_app_config", return_value={"client_id": "x"}), \
                 mock.patch.object(sync_module, "get_adapter", return_value=_Adapter(added)), \
                 mock.patch.object(sync_module, "date", _FrozenDate):
                return sync_module.run_sync(days=0, connection_id="conn-1", request=request)
        finally:
            reset_current_db_path(token)

    def test_the_sync_that_brings_the_charge_pairs_it_with_the_order(self):
        order = AmazonOrder(
            order_id="111-0000000-0000077", order_date="2026-08-03", total=18.45, items_summary="Trail Lantern;",
            payment_legs=[PaymentLeg(method="Test Card", last4="7712", date="2026-08-03", amount=18.45)],
            has_order_detail=True,
        )
        with self._db() as conn:
            batch_id = run_amazon_import(conn, [order], account_id="amazon", filename="orders.csv")["batch_id"]
            self.assertEqual(len(amazon_reconciliation(conn, batch_id)["amazon_unmatched"]), 1)

        self._sync([{
            "external_transaction_id": "t-1", "external_account_id": "ext-card", "amount": 18.45,
            "merchant_name": "Amazon", "raw_name": "AMAZON MARKETPLACE", "date": "2026-08-04",
            "posted_date": "2026-08-04", "is_pending": False,
        }])

        with self._db() as conn:
            matched = amazon_reconciliation(conn, batch_id)["matched"]
        self.assertEqual(len(matched), 1)
        self.assertEqual(matched[0]["charges"][0]["date"], "2026-08-04")


if __name__ == "__main__":
    unittest.main()
