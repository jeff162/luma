"""
A pull settles provider accounts that share a local account.

When a provider reissues an account's id, the old id and the new one can both end up pointing at one local
account, and only the one holding the handle receives rows. Which one the provider still reports is known
only from its listings, so a pull records them (`last_listed_at`) and settles the pair once it has: the
next pull's rows for the new id then land instead of being dropped as having no destination.
"""

from __future__ import annotations

import os
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers import sync as sync_module
from backend.tests._fake_adapter import DONE, FakeCursorAdapter

CONNECTION_ID = "conn-1"


def _txn(external_id, account, amount):
    return {"external_transaction_id": external_id, "external_account_id": account, "date": "2026-11-18",
            "posted_date": None, "amount": amount, "merchant_name": "Grocer", "raw_name": "GROCER 0042",
            "is_pending": False}


class PullSettlesReplacedProviderAccountTests(unittest.TestCase):
    def setUp(self):
        env = mock.patch.dict(os.environ, {"LUMA_DEVELOPER_OPTIONS": ""})
        env.start()
        self.addCleanup(env.stop)
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.db_path = str(Path(self.tempdir.name) / "sync.db")
        init_db(self.db_path)
        with self._db(), get_db() as conn:
            conn.execute("INSERT INTO connection (id, provider, external_id, credential, institution) "
                         "VALUES (?, 'plaid', 'item-1', '', 'Example Bank')", (CONNECTION_ID,))
            conn.execute(
                "INSERT INTO account (id, external_account_id, connection_id, provider, name, display_name, "
                "type, owner_id) VALUES ('a1', 'old', ?, 'plaid', 'Checking', 'Checking', 'depository', ?)",
                (CONNECTION_ID, SHARED_OWNER_ID),
            )
            # The stored shape of a reissue: both ids point at the account, the dead one holding it.
            for external_id in ("old", "new"):
                conn.execute(
                    "INSERT INTO connection_account (connection_id, external_account_id, account_id, "
                    "mapping_mode, target_account_id, provider_name) VALUES (?, ?, 'a1', 'existing', 'a1', 'CHECKING')",
                    (CONNECTION_ID, external_id),
                )

    @contextmanager
    def _db(self):
        token = set_current_db_path(self.db_path)
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _sync(self, page):
        adapter = FakeCursorAdapter(pages=[{"has_more": False, "update_status": DONE, **page}])
        request = SimpleNamespace(state=SimpleNamespace(user={"id": "u1"}))
        with self._db(), \
                mock.patch.object(sync_module.crypto_service, "is_unlocked", return_value=True), \
                mock.patch.object(sync_module.crypto_service, "decrypt_connection_credential", return_value="tok"), \
                mock.patch.object(sync_module, "resolve_app_config", return_value={"client_id": "x"}), \
                mock.patch.object(sync_module, "get_adapter", return_value=adapter):
            sync_module.run_sync(days=0, connection_id=CONNECTION_ID, request=request)

    def _txn_count(self):
        with self._db(), get_db() as conn:
            return conn.execute("SELECT COUNT(*) AS n FROM txn WHERE account_id = 'a1'").fetchone()["n"]

    def test_the_id_the_provider_lists_takes_the_account_and_its_rows_land_from_the_next_pull(self):
        listing = [{"external_account_id": "new", "start": "2026-11-01", "end": "2026-11-18"}]
        self._sync({"added": [_txn("t1", "new", -12.5)], "complete_listings": listing})
        # Dropped on the pull that settled it: the handle moves only once its listing is recorded.
        self.assertEqual(self._txn_count(), 0)
        with self._db(), get_db() as conn:
            self.assertEqual(conn.execute("SELECT external_account_id FROM account WHERE id = 'a1'").fetchone()[0], "new")
            self.assertEqual(conn.execute(
                "SELECT replaced_by FROM connection_account WHERE external_account_id = 'old'").fetchone()[0], "new")

        self._sync({"added": [_txn("t2", "new", -7.25)], "complete_listings": listing})
        self.assertEqual(self._txn_count(), 1)


if __name__ == "__main__":
    unittest.main()
