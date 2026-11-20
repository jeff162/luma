"""
Provider balances: how each adapter's sign becomes the household's position, and what a sync records.

The sign is the property worth pinning. A balance stored with the wrong sign raises nothing; it counts a
card's debt as money held in every total built on it.
"""

from __future__ import annotations

import os
import sqlite3
import tempfile
import unittest
from contextlib import contextmanager
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers import sync as sync_module
from backend.services import plaid_service
from backend.services.account_balances import (
    balance_checks, current_balances, delete_manual_balance, record_manual_balance, running_balances,
)
from backend.services.providers.plaid import PlaidAdapter

from backend.tests._fake_adapter import FakeCursorAdapter


class PlaidBalanceTests(unittest.TestCase):
    def _balances(self, accounts, **kwargs):
        with mock.patch.object(plaid_service, "fetch_balances", return_value=accounts):
            return PlaidAdapter().fetch_balances({}, "tok", **kwargs)

    def test_an_amount_owed_becomes_a_negative_position(self):
        def account(account_id, kind, current, currency="USD", available=None):
            return {"plaid_account_id": account_id, "type": kind, "current": current, "available": available,
                    "currency": currency, "last_updated": None}

        result = self._balances([
            account("chk", "depository", 1250.0, available=1200.0),
            account("card", "credit", 412.5, available=1587.5),
            account("mortgage", "loan", 180000.0),
            account("brokerage", "investment", 50000.0),
            account("euro", "depository", 10.0, currency="EUR"),
            account("unknown", "depository", None),
        ], ledger_currency="USD")
        self.assertEqual({k: v["balance"] for k, v in result.items()}, {
            "chk": 1250.0, "card": -412.5, "mortgage": -180000.0, "brokerage": 50000.0,
        })
        # Available is what can be spent, not a position, so a card's remaining credit is not negated.
        self.assertEqual(result["card"]["available"], 1587.5)


class _BalanceAdapter(FakeCursorAdapter):
    """A cursor provider whose balances need their own request, as Plaid's do."""
    offers_realtime_balances = True

    def __init__(self, balances=None, error=None, **kwargs):
        super().__init__(**kwargs)
        self._balances = balances or {}
        self._error = error
        self.balance_calls = []

    def fetch_balances(self, app_config, credential, *, realtime=False, ledger_currency="USD"):
        self.balance_calls.append(realtime)
        if self._error:
            raise self._error
        return self._balances


class SyncRecordsBalancesTests(unittest.TestCase):
    CONNECTION_ID = "conn-balances"

    def setUp(self):
        self._env = mock.patch.dict(os.environ, {"LUMA_DEVELOPER_OPTIONS": ""})
        self._env.start()
        self.addCleanup(self._env.stop)
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.db_path = Path(self.tempdir.name) / "balances.db"
        init_db(str(self.db_path))
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "INSERT INTO connection (id, provider, external_id, credential, institution) "
                "VALUES (?, 'plaid', 'item-balances', '', 'Example Bank')", (self.CONNECTION_ID,))
            conn.execute(
                """
                INSERT INTO account (id, external_account_id, connection_id, provider, name, display_name, type,
                                     owner_id)
                VALUES ('a1', 'ext-mapped', ?, 'plaid', 'Everyday', 'Everyday', 'depository', ?)
                """, (self.CONNECTION_ID, SHARED_OWNER_ID))
            conn.execute(
                """
                INSERT INTO connection_account (connection_id, external_account_id, account_id, mapping_mode)
                VALUES (?, 'ext-mapped', 'a1', 'existing'), (?, 'ext-unmapped', NULL, NULL)
                """, (self.CONNECTION_ID, self.CONNECTION_ID))

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _sync(self, adapter):
        request = SimpleNamespace(state=SimpleNamespace(user={"id": "u1"}))
        with self._use_db_path(), \
                mock.patch.object(sync_module.crypto_service, "is_unlocked", return_value=True), \
                mock.patch.object(sync_module.crypto_service, "decrypt_connection_credential", return_value="tok"), \
                mock.patch.object(sync_module, "resolve_app_config", return_value={"client_id": "x", "secret": "y"}), \
                mock.patch.object(sync_module, "get_adapter", return_value=adapter):
            return sync_module.run_sync(days=0, connection_id=self.CONNECTION_ID, request=request)

    def _stored(self):
        with self._use_db_path(), get_db() as conn:
            return [dict(r) for r in conn.execute(
                "SELECT account_id, as_of_date, source, balance, available FROM account_balance ORDER BY as_of_date")]

    def test_balances_land_on_the_mapped_account_and_a_restated_day_is_replaced(self):
        def balance(amount, as_of="2026-08-09"):
            return {"balance": amount, "available": None, "as_of": as_of}

        self._sync(_BalanceAdapter(balances={"ext-mapped": balance(10.0), "ext-unmapped": balance(99.0)}))
        self._sync(_BalanceAdapter(balances={"ext-mapped": balance(12.5)}))
        self.assertEqual(self._stored(), [
            {"account_id": "a1", "as_of_date": "2026-08-09", "source": "provider", "balance": 12.5, "available": None},
        ])

    def test_a_failed_balance_request_warns_without_failing_the_pull(self):
        txn = {"external_transaction_id": "t1", "external_account_id": "ext-mapped", "amount": 5.0,
               "merchant_name": "Coffee", "raw_name": "Coffee", "date": "2026-08-09", "is_pending": False}
        self._sync(_BalanceAdapter(error=RuntimeError("provider unavailable"), pages=[{"added": [txn]}]))
        with self._use_db_path(), get_db() as conn:
            row = conn.execute(
                "SELECT last_sync_error, last_sync_warnings FROM connection WHERE id = ?",
                (self.CONNECTION_ID,)).fetchone()
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM txn").fetchone()[0], 1)
        self.assertIsNone(row["last_sync_error"])
        self.assertIn("provider unavailable", row["last_sync_warnings"])

    def test_the_connection_setting_decides_realtime(self):
        adapter = _BalanceAdapter()
        self._sync(adapter)
        with self._use_db_path(), get_db() as conn:
            conn.execute("UPDATE connection SET realtime_balances = 1 WHERE id = ?", (self.CONNECTION_ID,))
        self._sync(adapter)
        self.assertEqual(adapter.balance_calls, [False, True])


class CurrentBalanceTests(unittest.TestCase):
    """The derived balance today: one per group, carried forward from its latest stated balance."""
    TODAY = date(2026, 8, 16)

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        init_db(str(Path(self.tempdir.name) / "current.db"))
        self.conn = sqlite3.connect(str(Path(self.tempdir.name) / "current.db"))
        self.conn.row_factory = sqlite3.Row
        self.addCleanup(self.conn.close)
        for account_id, parent in (("card", None), ("old-card", "card"), ("cash", None)):
            self.conn.execute(
                "INSERT INTO account (id, name, display_name, type, parent_account_id) "
                "VALUES (?, ?, ?, 'credit', ?)", (account_id, account_id, account_id, parent))

    def _state(self, account_id, as_of, balance, recorded_at="2026-08-01 00:00:00"):
        self.conn.execute(
            "INSERT INTO account_balance (account_id, as_of_date, source, balance, recorded_at) "
            "VALUES (?, ?, 'provider', ?, ?)", (account_id, as_of, balance, recorded_at))

    def _txn(self, account_id, day, amount, pending=0, trashed_at=None):
        self.conn.execute(
            "INSERT INTO txn (id, account_id, amount, merchant_name, display_name, raw_name, date, is_pending, "
            "trashed_at) VALUES (?, ?, ?, 'M', 'M', 'M', ?, ?, ?)",
            (f"{account_id}-{day}-{amount}", account_id, amount, day, pending, trashed_at))

    def test_the_latest_stated_balance_is_carried_forward_through_later_posted_rows(self):
        self._state("card", "2026-08-10", -100.0)
        self._state("card", "2026-08-01", -900.0)
        self._txn("card", "2026-08-10", 7.0)        # on the anchor's day: already in its closing balance
        self._txn("card", "2026-08-12", 25.0)       # a purchase: more owed
        self._txn("old-card", "2026-08-13", -40.0)  # a payment on another member lands on the group
        self._txn("card", "2026-08-14", 9.0, pending=1)
        self._txn("card", "2026-08-15", 11.0, trashed_at="2026-08-16")
        result = current_balances(self.conn, today=self.TODAY)
        self.assertEqual(set(result), {"card"})
        self.assertEqual(result["card"]["amount"], -85.0)
        self.assertEqual(result["card"]["as_of_date"], "2026-08-10")
        self.assertFalse(result["card"]["stale"])

    def test_a_group_takes_its_newest_member_balance_and_names_a_second_live_feed(self):
        self._state("card", "2026-08-01", -50.0)
        self._state("old-card", "2026-08-05", -60.0)
        result = current_balances(self.conn, today=self.TODAY)["card"]
        self.assertEqual((result["account_id"], result["amount"]), ("old-card", -60.0))
        self.assertEqual(result["also_reporting"], ["card"])
        self.assertTrue(result["stale"])

    def test_a_balance_entered_by_hand_anchors_until_removed(self):
        self._state("cash", "2026-08-01", 300.0)
        self._txn("cash", "2026-08-12", 20.0)
        record_manual_balance(self.conn, "cash", "2026-08-10", 250.0)
        result = current_balances(self.conn, today=self.TODAY)["cash"]
        self.assertEqual((result["source"], result["stated"], result["amount"]), ("manual", 250.0, 230.0))
        self.assertTrue(delete_manual_balance(self.conn, "cash", "2026-08-10"))
        self.assertEqual(current_balances(self.conn, today=self.TODAY)["cash"]["amount"], 280.0)

    def test_a_balance_entered_by_hand_stays_fresh_for_a_statement_cycle(self):
        record_manual_balance(self.conn, "cash", "2026-07-27", 250.0)  # 20 days old
        self.assertFalse(current_balances(self.conn, today=self.TODAY)["cash"]["stale"])
        self.assertTrue(current_balances(self.conn, today=date(2026, 9, 1))["cash"]["stale"])  # 36 days

    def test_running_balances_anchor_on_today_and_a_disagreeing_span_is_flagged_once(self):
        self._state("card", "2026-07-20", -900.0)
        self._state("card", "2026-08-01", -900.0)
        self._state("card", "2026-08-10", -100.0)
        self._txn("card", "2026-08-05", -850.0)   # a payment, which the August 10 balance shows as 800
        self._txn("card", "2026-08-12", 25.0)
        self._txn("card", "2026-08-13", 4.0, pending=1)
        ids = ["card-2026-08-05--850.0", "card-2026-08-12-25.0", "card-2026-08-13-4.0"]
        self.assertEqual(running_balances(self.conn, "card", ids), {ids[0]: -100.0, ids[1]: -125.0})
        checks = balance_checks(self.conn, "card")
        self.assertEqual(len(checks), 1)
        self.assertEqual(
            {k: checks[0][k] for k in ("from_date", "to_date", "stated_change", "ledger_change", "gap", "flag_txn_id")},
            {"from_date": "2026-08-01", "to_date": "2026-08-10", "stated_change": 800.0, "ledger_change": 850.0,
             "gap": -50.0, "flag_txn_id": ids[0]})


if __name__ == "__main__":
    unittest.main()
