"""Demo-data clear: the destructive wipe and its guard.

The wipe must NEVER run on real data — its only gate is the demo marker, so the load-the-marker /
refuse-without-it contract is the safety property worth pinning. Also covers the gates that keep demo
and real data from mixing — and those matter more than they look: the wipe is allowed to erase the whole
tenant *because* nothing non-demo can have been added, so every path that brings data in has to be shut
while the marker is set. The four here (data restore, CSV import, credentials restore, sync) are that
set; a fifth path added without a gate is a way to lose real data to the demo clear."""

import asyncio
import hashlib
import json
import os
import tempfile
import time
import unittest
from contextlib import contextmanager
from pathlib import Path

from fastapi import HTTPException

from backend.db import control_database
from backend.db.database import get_db, init_db, reset_current_db_path, set_current_db_path
from backend.db.demo_data import is_demo_data_loaded, load_demo_data
from backend.routers.auth import clear_demo_data_endpoint, demo_data_status
from backend.routers.import_export import run_import
from backend.routers.import_export.backup import (
    CredentialsRestoreRequest,
    RestoreRequest,
    restore_backup,
    restore_credentials,
)
from backend.routers.sync import run_sync
from backend.services.documents import (
    INGEST_GRACE_SECONDS,
    document_file_path,
    new_document_id,
    write_document_file,
)


class _FakeUpload:
    def __init__(self, filename, content):
        self.filename = filename
        self._content = content.encode("utf-8")

    async def read(self, size: int = -1):
        return self._content


class DemoDataClearTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "demo-clear.db"
        init_db(str(self.db_path))
        # Isolate the control DB: these endpoints read app_setting, so point it at a fresh temp
        # file and initialize it rather than falling back to whatever control DB sits in the CWD.
        self._orig_control_path = control_database.CONTROL_DB_PATH
        control_database.CONTROL_DB_PATH = str(Path(self.tempdir.name) / "control.db")
        control_database.init_control_db()

    def tearDown(self):
        control_database.CONTROL_DB_PATH = self._orig_control_path
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
        with self._use_db_path(), get_db(str(self.db_path)) as conn:
            self.assertFalse(is_demo_data_loaded(conn))
            load_demo_data(conn, scope_id="demo-profile")
            self.assertTrue(is_demo_data_loaded(conn))

    def test_clear_refuses_without_marker_and_touches_nothing(self):
        # Simulate live data: an account, no demo marker. The wipe must refuse and leave it intact.
        with get_db(str(self.db_path)) as conn:
            conn.execute(
                """INSERT INTO account (id, external_account_id, provider, name, display_name, type)
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
        with self._use_db_path(), get_db(str(self.db_path)) as conn:
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

    def test_clear_takes_attached_documents_and_their_files(self):
        # A document attached to a demo transaction is the case the wipe alone does not finish: the row
        # goes with its transaction via ON DELETE CASCADE, but files are outside that transaction and
        # would survive it as orphans nothing references. The sweep after the commit is what closes it.
        with self._use_db_path(), get_db(str(self.db_path)) as conn:
            load_demo_data(conn, scope_id="demo-profile")
            txn_id = conn.execute("SELECT id FROM txn LIMIT 1").fetchone()["id"]

        with self._use_db_path():
            document_id = new_document_id()
            payload = b"%PDF-1.4\ndemo receipt\n%%EOF\n"
            write_document_file(document_id, payload)
            with get_db(str(self.db_path)) as conn:
                conn.execute(
                    "INSERT INTO document (id, txn_id, filename, mime_type, byte_size, sha256, created_at) "
                    "VALUES (?, ?, 'demo.pdf', 'application/pdf', ?, ?, '2026-08-24T00:00:00Z')",
                    (document_id, txn_id, len(payload), hashlib.sha256(payload).hexdigest()),
                )
            # Aged past the ingest grace period, which exists to spare a file whose row has not committed
            # yet — without this the sweep would correctly decline to touch a file written a moment ago.
            path = document_file_path(document_id)
            stale = time.time() - (INGEST_GRACE_SECONDS + 60)
            os.utime(path, (stale, stale))

            clear_demo_data_endpoint()

            self.assertFalse(path.exists())
        with get_db(str(self.db_path)) as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM document").fetchone()[0], 0)

    def test_clear_is_repeatable_after_reload(self):
        with self._use_db_path(), get_db(str(self.db_path)) as conn:
            load_demo_data(conn, scope_id="demo-profile")
        with self._use_db_path():
            clear_demo_data_endpoint()
        # A fresh demo load works again, and clears again — the lifecycle is closed.
        with self._use_db_path(), get_db(str(self.db_path)) as conn:
            summary = load_demo_data(conn, scope_id="demo-profile")
        self.assertFalse(summary["skipped"])
        with self._use_db_path():
            self.assertEqual(clear_demo_data_endpoint(), {"ok": True})

    def test_status_endpoint(self):
        with self._use_db_path():
            # Empty tenant: not loaded, but loadable (the "Load demo data" offer shows).
            self.assertEqual(demo_data_status(), {"loaded": False, "loadable": True})
        with self._use_db_path(), get_db(str(self.db_path)) as conn:
            load_demo_data(conn, scope_id="demo-profile")
        with self._use_db_path():
            # Loaded → no longer loadable (tenant has data).
            self.assertEqual(demo_data_status(), {"loaded": True, "loadable": False})

    def test_status_answers_while_sign_in_protection_is_on(self):
        # Demo data loaded before protection was turned on stays loaded and keeps imports blocked, so the
        # status has to answer a signed-in session then too. Loading and clearing stay protection-off.
        with self._use_db_path(), get_db(str(self.db_path)) as conn:
            load_demo_data(conn, scope_id="demo-profile")
        control_database.enable_auth_mode()
        with self._use_db_path():
            self.assertEqual(demo_data_status(), {"loaded": True, "loadable": False})
            with self.assertRaises(HTTPException) as ctx:
                clear_demo_data_endpoint()
        self.assertEqual(ctx.exception.status_code, 400)
        with get_db(str(self.db_path)) as conn:
            self.assertTrue(is_demo_data_loaded(conn))

    def test_status_offers_no_load_while_sign_in_protection_is_on(self):
        control_database.enable_auth_mode()
        with self._use_db_path():
            self.assertEqual(demo_data_status(), {"loaded": False, "loadable": False})

    def test_restore_blocked_while_demo_loaded(self):
        with self._use_db_path(), get_db(str(self.db_path)) as conn:
            load_demo_data(conn, scope_id="demo-profile")
        with self._use_db_path():
            with self.assertRaises(HTTPException) as ctx:
                restore_backup(RestoreRequest(data={"version": 7}))
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertEqual(ctx.exception.detail.get("code"), "demo_data_loaded")

    def test_credentials_restore_blocked_while_demo_loaded(self):
        # Not merely for symmetry with the data restore: this path inserts `connection` rows, and a linked
        # connection is what `is_demo_loadable` treats as disqualifying — so without the gate it is the one
        # way to reach a demo tenant that owns a live data source, whose synced rows the demo clear would
        # then erase as though they were demo data.
        with self._use_db_path(), get_db(str(self.db_path)) as conn:
            load_demo_data(conn, scope_id="demo-profile")
        with self._use_db_path():
            with self.assertRaises(HTTPException) as ctx:
                restore_credentials(
                    CredentialsRestoreRequest(data={"version": 4, "connections": [], "provider_configs": []}),
                    None,
                )
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertEqual(ctx.exception.detail.get("code"), "demo_data_loaded")

    def test_sync_blocked_while_demo_loaded(self):
        with self._use_db_path(), get_db(str(self.db_path)) as conn:
            load_demo_data(conn, scope_id="demo-profile")
        with self._use_db_path():
            with self.assertRaises(HTTPException) as ctx:
                run_sync(days=0, connection_id=None, provider=None, full_history=False, request=None)
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertEqual(ctx.exception.detail.get("code"), "demo_data_loaded")

    def test_import_blocked_while_demo_loaded(self):
        with self._use_db_path(), get_db(str(self.db_path)) as conn:
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
