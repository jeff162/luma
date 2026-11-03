"""
A file import's progress is readable by another request while the import runs.

The browser polls `GET /run-progress/{id}` during the upload's own request, so two things have to hold:
the import must not occupy the event loop (or the poll is only answered once there is nothing left to
report), and the registry it reports into has to show the run's position mid-flight and forget it after.
"""

from __future__ import annotations

import asyncio
import json
import tempfile
import threading
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.import_export import core
from backend.services.import_progress import import_progress, tracked_import


class FakeUploadFile:
    def __init__(self, filename, content):
        self.filename = filename
        self._content = content.encode("utf-8")

    async def read(self, size: int = -1):
        return self._content


class ImportRunProgressTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "import-progress-tests.db"
        init_db(str(self.db_path))

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self, path=None):
        token = set_current_db_path(str(path or self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _insert_account(self):
        account_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """
                INSERT INTO account (id, external_account_id, provider, name, display_name, type, subtype, mask, owner_id)
                VALUES (?, ?, 'fixture_import', 'Checking', 'Checking', 'checking', 'checking', '1234', ?)
                """,
                (account_id, f"test_{account_id}", SHARED_OWNER_ID),
            )
        return account_id

    def _config(self, account_id):
        return json.dumps({
            "filename": "fixture.csv",
            "account_id": account_id,
            "column_map": {"date": "Date", "description": "Description", "amount": "Amount"},
            "date_format": "%Y-%m-%d",
            "amount_convention": "single_signed",
        })

    async def test_progress_is_readable_on_the_event_loop_while_the_import_runs(self):
        account_id = self._insert_account()
        reported = threading.Event()
        release = threading.Event()
        real_core = core.run_import_core

        def paused_core(text, cfg, *, filename, on_progress):
            on_progress(1, 2)
            reported.set()
            release.wait(5)
            return real_core(text, cfg, filename=filename, on_progress=on_progress)

        csv_text = "Date,Description,Amount\n2026-01-02,WBWB STORE,-12.00\n2026-01-03,QPQP SHOP,-7.00\n"
        with self._use_db_path(), mock.patch.object(core, "run_import_core", paused_core):
            run = asyncio.create_task(core.run_import(
                file=FakeUploadFile("fixture.csv", csv_text), config=self._config(account_id), progress_id="run-1"))
            await asyncio.to_thread(reported.wait, 5)
            # Read from the loop while the import is parked mid-run. Were the import running on the loop
            # itself, this line would only be reached once it had finished and its entry was gone.
            during = core.get_import_run_progress("run-1")
            release.set()
            result = await run
            after = core.get_import_run_progress("run-1")

        self.assertEqual(during, {"active": True, "done": 1, "total": 2})
        self.assertEqual(result["imported"], 2)
        self.assertEqual(after, {"active": False})

    async def test_the_row_loop_reports_every_row_and_ends_at_the_total(self):
        account_id = self._insert_account()
        seen = []
        rows = "".join(f"2026-01-{day:02d},STORE {day},-{day}.00\n" for day in range(1, 6))
        with self._use_db_path():
            core.run_import_core(
                "Date,Description,Amount\n" + rows, json.loads(self._config(account_id)),
                on_progress=lambda done, total: seen.append((done, total)))

        self.assertEqual(seen, [(n, 5) for n in range(6)])

    def test_a_run_is_visible_only_to_its_own_tenant_and_only_while_it_runs(self):
        other_db = Path(self.tempdir.name) / "other-tenant.db"
        with self._use_db_path():
            with self.assertRaises(RuntimeError):
                with tracked_import("run-2") as report:
                    report(3, 10)
                    self.assertEqual(import_progress("run-2"), {"done": 3, "total": 10})
                    with self._use_db_path(other_db):
                        self.assertIsNone(import_progress("run-2"))
                    raise RuntimeError("the import failed")
            self.assertIsNone(import_progress("run-2"), "a failed run leaves nothing behind")


if __name__ == "__main__":
    unittest.main()
