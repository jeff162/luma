"""
Data-source sync → period import cards (docs/backlog/sync-import-records-and-dedupe.md, phase 1).

A sync groups its inserted rows into one import_batch per (connection, calendar month),
source_kind='connection_sync', so synced rows carry an import_batch_id and gain a duplicate-review
home like any imported file. These tests pin: the card is created lazily and reused within a month,
synced rows are stamped with it, the card's row_count + per-account breakdown accumulate across
fetches, and a fetch that inserts nothing creates no empty card.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from datetime import date, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers import sync as sync_module
from backend.routers import providers as providers_module


class _FakeAdapter:
    def __init__(self, txns, accounts=None):
        self._txns = txns
        self._accounts = accounts or []
        self.calls = []  # start_date of each fetch_transactions call (for window/scoping assertions)

    def fetch_transactions(self, app_config, credential, *, start_date, end_date):
        self.calls.append(start_date)
        return self._txns

    def fetch_accounts(self, app_config, credential):
        return self._accounts


class SyncPeriodCardTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "sync-cards.db"
        init_db(str(self.db_path))
        self.connection_id = "conn-1"
        self.external_account_id = "acct-ext-1"
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "INSERT INTO connection (id, provider, external_id, credential, institution) "
                "VALUES (?, 'plaid', 'item-1', '', 'Example Bank')",
                (self.connection_id,),
            )
            conn.execute(
                """
                INSERT INTO account
                  (id, external_account_id, connection_id, provider, name, display_name, type, subtype,
                   mask, owner_id, parent_account_id, trashed_at)
                VALUES ('a1', ?, ?, 'plaid', 'Joint Checking', 'Joint Checking', 'depository', 'checking',
                        '1188', ?, NULL, NULL)
                """,
                (self.external_account_id, self.connection_id, SHARED_OWNER_ID),
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

    def _txn(self, txn_id, amount, name, day="2026-08-10", pending=False):
        return {
            "external_transaction_id": txn_id,
            "external_account_id": self.external_account_id,
            "amount": amount,
            "merchant_name": name,
            "raw_name": name,
            "date": day,
            "is_pending": pending,
        }

    @contextmanager
    def _driven_sync(self, txns, on_date, *, days=30, connection_id=None, adapter=None):
        """Run run_sync with the provider seam mocked and the clock pinned to `on_date`. Pass an `adapter`
        to inspect it after (fetch call count / start_date window); otherwise a throwaway one is used."""
        adapter = adapter if adapter is not None else _FakeAdapter(txns)
        request = SimpleNamespace(state=SimpleNamespace(user={"id": "u1"}))
        with self._use_db_path(), \
                mock.patch.object(sync_module.crypto_service, "is_unlocked", return_value=True), \
                mock.patch.object(sync_module.crypto_service, "decrypt_connection_credential", return_value="tok"), \
                mock.patch.object(sync_module, "resolve_app_config", return_value={"client_id": "x", "secret": "y"}), \
                mock.patch.object(sync_module, "get_adapter", return_value=adapter), \
                mock.patch.object(sync_module, "date", _FrozenDate(on_date)):
            yield sync_module.run_sync(days=days, connection_id=connection_id, request=request)

    def _cards(self):
        with self._use_db_path(), get_db() as conn:
            return [dict(r) for r in conn.execute(
                "SELECT id, filename, source_kind, connection_id, row_count, config_snapshot "
                "FROM import_batch WHERE source_kind = 'connection_sync' ORDER BY filename"
            ).fetchall()]

    def test_first_fetch_creates_one_period_card_and_stamps_rows(self):
        with self._driven_sync([self._txn("t1", -10.0, "Coffee"), self._txn("t2", -20.0, "Lunch")], "2026-08-10") as res:
            self.assertEqual(res["added"], 2)
        cards = self._cards()
        self.assertEqual(len(cards), 1)
        card = cards[0]
        self.assertEqual(card["connection_id"], self.connection_id)
        self.assertEqual(card["row_count"], 2)
        self.assertIn("August 2026", card["filename"])
        self.assertIn("Example Bank", card["filename"])
        with self._use_db_path(), get_db() as conn:
            stamped = conn.execute(
                "SELECT COUNT(*) n FROM txn WHERE import_batch_id = ?", (card["id"],)
            ).fetchone()["n"]
            self.assertEqual(stamped, 2)
            acct = conn.execute(
                "SELECT csv_value, account_id, row_count FROM import_batch_account WHERE batch_id = ?",
                (card["id"],),
            ).fetchone()
            self.assertEqual(acct["account_id"], "a1")
            self.assertEqual(acct["row_count"], 2)

    def test_second_fetch_same_month_reuses_and_extends_the_card(self):
        with self._driven_sync([self._txn("t1", -10.0, "Coffee")], "2026-08-10"):
            pass
        with self._driven_sync([self._txn("t2", -20.0, "Lunch")], "2026-08-25") as res:
            self.assertEqual(res["added"], 1)
        cards = self._cards()
        self.assertEqual(len(cards), 1, "same month must reuse the one card")
        self.assertEqual(cards[0]["row_count"], 2)
        with self._use_db_path(), get_db() as conn:
            self.assertEqual(
                conn.execute(
                    "SELECT row_count FROM import_batch_account WHERE batch_id = ?", (cards[0]["id"],)
                ).fetchone()["row_count"],
                2,
            )

    def test_next_month_opens_a_new_card(self):
        with self._driven_sync([self._txn("t1", -10.0, "Coffee", day="2026-08-10")], "2026-08-31"):
            pass
        with self._driven_sync([self._txn("t2", -20.0, "Lunch", day="2026-09-02")], "2026-09-01"):
            pass
        cards = self._cards()
        self.assertEqual(len(cards), 2)
        self.assertEqual({c["row_count"] for c in cards}, {1})

    def _seed_csv_row_on_other_account(self, *, account_id="a2", parent_id=None,
                                       amount=-10.0, name="Coffee", day="2026-08-10"):
        """A prior CSV/manual row on a *different* account — the thing a re-fetched sync duplicates."""
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """
                INSERT INTO account
                  (id, external_account_id, connection_id, provider, name, display_name, type, subtype,
                   mask, owner_id, parent_account_id, trashed_at)
                VALUES (?, NULL, NULL, 'csv', 'CSV Checking', 'CSV Checking', 'depository', 'checking',
                        NULL, ?, ?, NULL)
                """,
                (account_id, SHARED_OWNER_ID, parent_id),
            )
            conn.execute(
                "INSERT INTO import_batch (id, filename, row_count, status) VALUES ('csvb', 'ledger.csv', 1, 'completed')"
            )
            conn.execute(
                """
                INSERT INTO txn (id, account_id, owner_id, amount, merchant_name, display_name, raw_name,
                                 date, import_batch_id)
                VALUES ('csv-txn', ?, ?, ?, ?, ?, ?, ?, 'csvb')
                """,
                (account_id, SHARED_OWNER_ID, amount, name, name, name, day),
            )

    def test_sync_soft_flags_a_cross_account_duplicate_on_its_period_card(self):
        self._seed_csv_row_on_other_account()
        with self._driven_sync([self._txn("t1", -10.0, "Coffee", day="2026-08-10")], "2026-08-10") as res:
            self.assertEqual(res["added"], 1)
        with self._use_db_path(), get_db() as conn:
            synced = conn.execute(
                "SELECT suspect_duplicate_of, suspect_duplicate_reason, import_batch_id, trashed_at "
                "FROM txn WHERE plaid_transaction_id = 't1'"
            ).fetchone()
            self.assertEqual(synced["suspect_duplicate_of"], "csv-txn")
            self.assertEqual(synced["suspect_duplicate_reason"], "cross_account")
            self.assertIsNone(synced["trashed_at"])  # soft flag, not dropped
            # The suspect surfaces on the period card (its import_batch_id).
            card_id = synced["import_batch_id"]
            n = conn.execute(
                "SELECT COUNT(*) c FROM txn WHERE import_batch_id = ? AND suspect_duplicate_of IS NOT NULL "
                "AND suspect_resolved_at IS NULL AND trashed_at IS NULL",
                (card_id,),
            ).fetchone()["c"]
            self.assertEqual(n, 1)

    def test_sync_into_already_merged_account_promotes_to_confirmed(self):
        # The synced account (a1) is already merged under the CSV account (a2): the user has asserted they're
        # the same physical account, so a cross-account match is really an in-group duplicate → confirmed.
        self._seed_csv_row_on_other_account(account_id="a2", parent_id=None)
        with self._use_db_path(), get_db() as conn:
            conn.execute("UPDATE account SET parent_account_id = 'a2' WHERE id = 'a1'")
        with self._driven_sync([self._txn("t1", -10.0, "Coffee", day="2026-08-10")], "2026-08-10"):
            pass
        with self._use_db_path(), get_db() as conn:
            synced = conn.execute(
                "SELECT rejection_reason, dedupe_resolved_by, trashed_at, suspect_duplicate_of "
                "FROM txn WHERE plaid_transaction_id = 't1'"
            ).fetchone()
            self.assertEqual(synced["rejection_reason"], "duplicate_confirmed")
            self.assertEqual(synced["dedupe_resolved_by"], "auto_merge")
            self.assertIsNotNone(synced["trashed_at"])
            self.assertEqual(synced["suspect_duplicate_of"], "csv-txn")

    def test_synced_rows_get_a_content_hash(self):
        with self._driven_sync([self._txn("t1", -10.0, "Coffee")], "2026-08-10"):
            pass
        with self._use_db_path(), get_db() as conn:
            h = conn.execute("SELECT content_hash FROM txn WHERE plaid_transaction_id = 't1'").fetchone()["content_hash"]
            self.assertTrue(h)

    def test_fetch_with_no_inserts_creates_no_card(self):
        # First fetch inserts t1.
        with self._driven_sync([self._txn("t1", -10.0, "Coffee")], "2026-08-10"):
            pass
        # Re-fetch the same posted txn: idempotent skip, nothing inserted, no new card, no phantom row_count.
        with self._driven_sync([self._txn("t1", -10.0, "Coffee")], "2026-08-11") as res:
            self.assertEqual(res["added"], 0)
        cards = self._cards()
        self.assertEqual(len(cards), 1)
        self.assertEqual(cards[0]["row_count"], 1)

    def test_all_history_window_uses_max_lookback(self):
        # days=0 means "all available history" → start_date is ALL_HISTORY_DAYS back, not 30.
        adapter = _FakeAdapter([])
        with self._driven_sync([], "2026-08-10", days=0, adapter=adapter):
            pass
        self.assertEqual(len(adapter.calls), 1)
        expected = date.fromisoformat("2026-08-10") - timedelta(days=sync_module.ALL_HISTORY_DAYS)
        self.assertEqual(adapter.calls[0], expected)

    def test_positive_days_uses_that_window(self):
        adapter = _FakeAdapter([])
        with self._driven_sync([], "2026-08-10", days=30, adapter=adapter):
            pass
        self.assertEqual(adapter.calls[0], date.fromisoformat("2026-08-10") - timedelta(days=30))

    def test_connection_id_scopes_the_sync(self):
        # A second plaid connection. Scoped sync fetches only the named connection; unscoped fetches both.
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "INSERT INTO connection (id, provider, external_id, credential, institution) "
                "VALUES ('conn-2', 'plaid', 'item-2', '', 'Other Bank')"
            )
        scoped = _FakeAdapter([])
        with self._driven_sync([], "2026-08-10", connection_id=self.connection_id, adapter=scoped):
            pass
        self.assertEqual(len(scoped.calls), 1, "scoped sync must fetch only the named connection")
        unscoped = _FakeAdapter([])
        with self._driven_sync([], "2026-08-10", adapter=unscoped):
            pass
        self.assertEqual(len(unscoped.calls), 2, "unscoped sync must fetch every connection")


class RefreshAccountsTests(unittest.TestCase):
    """POST /providers/{provider}/refresh-accounts rebuilds account rows from an existing connection's
    still-valid credential — the recovery when a restore rolls back the ledger but keeps the connection."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "refresh.db"
        init_db(str(self.db_path))
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "INSERT INTO connection (id, provider, external_id, credential, institution) "
                "VALUES ('conn-1', 'plaid', 'item-1', '', 'Cambridge Savings Bank')"
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

    def test_refresh_recreates_missing_accounts_from_the_connection(self):
        # No account rows exist (as after a restore that rolled the ledger back before the connect).
        request = SimpleNamespace(state=SimpleNamespace(user={"id": "u1"}))
        fake = _FakeAdapter([], accounts=[
            {"external_account_id": "acct-ext-1", "name": "Joint Checking",
             "type": "depository", "subtype": "checking", "mask": "1188"},
        ])
        with self._use_db_path(), \
                mock.patch("backend.routers.providers.resolve_app_config", return_value={"client_id": "x"}), \
                mock.patch.object(providers_module.crypto_service, "decrypt_connection_credential", return_value="tok"), \
                mock.patch("backend.routers.providers.get_adapter", return_value=fake):
            res = providers_module.refresh_accounts(
                "plaid", providers_module.RefreshAccountsRequest(external_id="item-1"), request
            )
        self.assertEqual(res["accounts_added"], 1)
        self.assertEqual(res["connection_id"], "conn-1")
        with self._use_db_path(), get_db() as conn:
            acc = conn.execute(
                "SELECT connection_id, provider, name FROM account WHERE external_account_id = 'acct-ext-1'"
            ).fetchone()
        self.assertIsNotNone(acc, "refresh must recreate the account row")
        self.assertEqual(acc["connection_id"], "conn-1")
        self.assertEqual(acc["provider"], "plaid")

    def test_refresh_unknown_connection_is_404(self):
        from fastapi import HTTPException
        request = SimpleNamespace(state=SimpleNamespace(user={"id": "u1"}))
        with self._use_db_path(), self.assertRaises(HTTPException) as ctx:
            providers_module.refresh_accounts(
                "plaid", providers_module.RefreshAccountsRequest(external_id="does-not-exist"), request
            )
        self.assertEqual(ctx.exception.status_code, 404)


class _FrozenDate:
    """A stand-in for the `date` name inside sync.py that pins `date.today()` while leaving the
    rest of the type usable (the sync module also does `date.today() - timedelta(...)`)."""

    def __init__(self, iso):
        from datetime import date as _date
        self._today = _date.fromisoformat(iso)

    def today(self):
        return self._today


if __name__ == "__main__":
    unittest.main()
