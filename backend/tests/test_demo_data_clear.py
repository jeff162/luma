"""Demo-data clear: the destructive wipe and its guard.

The wipe must NEVER run on real data — its only gate is the demo marker, so the load-the-marker /
refuse-without-it contract is the safety property worth pinning. Also covers that a real data op
(restore) is blocked while demo data is loaded, so demo and real data can't mix."""

import asyncio
import json
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

from fastapi import HTTPException

from backend.db.database import get_db, init_db, reset_current_db_path, set_current_db_path
from backend.db.demo_data import is_demo_data_loaded, load_demo_data
from backend.routers.auth import clear_demo_data_endpoint, demo_data_status
from backend.routers.import_export import run_import
from backend.routers.import_export.backup import RestoreRequest, restore_backup


class _FakeUpload:
    def __init__(self, filename, content):
        self.filename = filename
        self._content = content.encode("utf-8")

    async def read(self):
        return self._content


class DemoDataClearTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "demo-clear.db"
        init_db(str(self.db_path))

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _counts(self):
        with get_db(str(self.db_path)) as conn:
            return {
                "accounts": conn.execute("SELECT COUNT(*) FROM account").fetchone()[0],
                "txns": conn.execute("SELECT COUNT(*) FROM txn").fetchone()[0],
                "leaves": conn.execute("SELECT COUNT(*) FROM category WHERE parent_id IS NOT NULL").fetchone()[0],
                "groups": conn.execute("SELECT COUNT(*) FROM category WHERE parent_id IS NULL").fetchone()[0],
            }

    def test_status_reflects_marker(self):
        with get_db(str(self.db_path)) as conn:
            self.assertFalse(is_demo_data_loaded(conn))
            load_demo_data(conn, scope_id="demo-profile")
            self.assertTrue(is_demo_data_loaded(conn))

    def test_clear_refuses_without_marker_and_touches_nothing(self):
        # Simulate live data: an account, no demo marker. The wipe must refuse and leave it intact.
        with get_db(str(self.db_path)) as conn:
            conn.execute(
                """INSERT INTO account (id, plaid_account_id, plaid_item_id, name, display_name, type)
                   VALUES ('a1', NULL, 'manual', 'Real Acct', 'Real Acct', 'depository')"""
            )
        before = self._counts()
        with self._use_db_path():
            with self.assertRaises(HTTPException) as ctx:
                clear_demo_data_endpoint()
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertEqual(self._counts(), before)
        with get_db(str(self.db_path)) as conn:
            self.assertTrue(conn.execute("SELECT 1 FROM account WHERE id = 'a1'").fetchone())

    def test_clear_with_marker_wipes_and_reseeds_skeleton(self):
        with get_db(str(self.db_path)) as conn:
            load_demo_data(conn, scope_id="demo-profile")
        loaded = self._counts()
        self.assertGreater(loaded["accounts"], 0)
        self.assertGreater(loaded["txns"], 0)

        with self._use_db_path():
            result = clear_demo_data_endpoint()
        self.assertEqual(result, {"ok": True})

        after = self._counts()
        self.assertEqual(after["accounts"], 0)
        self.assertEqual(after["txns"], 0)
        self.assertEqual(after["leaves"], 0)          # starter leaves gone; back to opt-in state
        self.assertGreater(after["groups"], 1)        # skeleton groups reseeded
        with get_db(str(self.db_path)) as conn:
            self.assertFalse(is_demo_data_loaded(conn))   # marker cleared by the wipe
            # The protected Unassigned group is restored.
            self.assertTrue(conn.execute("SELECT 1 FROM category WHERE system_key = 'unassigned'").fetchone())

    def test_clear_is_repeatable_after_reload(self):
        with get_db(str(self.db_path)) as conn:
            load_demo_data(conn, scope_id="demo-profile")
        with self._use_db_path():
            clear_demo_data_endpoint()
        # A fresh demo load works again, and clears again — the lifecycle is closed.
        with get_db(str(self.db_path)) as conn:
            summary = load_demo_data(conn, scope_id="demo-profile")
        self.assertFalse(summary["skipped"])
        with self._use_db_path():
            self.assertEqual(clear_demo_data_endpoint(), {"ok": True})

    def test_status_endpoint(self):
        with self._use_db_path():
            # Empty tenant: not loaded, but loadable (the "Load demo data" offer shows).
            self.assertEqual(demo_data_status(), {"loaded": False, "loadable": True})
        with get_db(str(self.db_path)) as conn:
            load_demo_data(conn, scope_id="demo-profile")
        with self._use_db_path():
            # Loaded → no longer loadable (tenant has data).
            self.assertEqual(demo_data_status(), {"loaded": True, "loadable": False})

    def test_restore_blocked_while_demo_loaded(self):
        with get_db(str(self.db_path)) as conn:
            load_demo_data(conn, scope_id="demo-profile")
        with self._use_db_path():
            with self.assertRaises(HTTPException) as ctx:
                restore_backup(RestoreRequest(data={"version": 7}))
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertEqual(ctx.exception.detail.get("code"), "demo_data_loaded")

    def test_import_blocked_while_demo_loaded(self):
        with get_db(str(self.db_path)) as conn:
            load_demo_data(conn, scope_id="demo-profile")
        cfg = {
            "column_map": {"date": "Date", "amount": "Amount", "description": "Description"},
            "date_format": "%Y-%m-%d",
            "amount_convention": "single_signed",
        }
        upload = _FakeUpload("x.csv", "Date,Description,Amount\n2026-01-01,Acme,10.00\n")
        with self._use_db_path():
            with self.assertRaises(HTTPException) as ctx:
                asyncio.run(run_import(file=upload, config=json.dumps(cfg)))
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertEqual(ctx.exception.detail.get("code"), "demo_data_loaded")


if __name__ == "__main__":
    unittest.main()
