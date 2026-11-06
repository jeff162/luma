"""
Files the server keeps or watches but cannot open, typically after an install's data was moved across from
another user and kept that user as owner.

An attached document is the server's own file, so one it cannot read fails the database check, refuses a
backup with a message naming it, and is refused with its reason when viewed rather than dropped mid-response;
a missing one stays the tolerated drift it was. A watched folder the scan
could not list is a Task for an administrator, since nothing in it is imported, and a watched file that could
not be read is called out in the waiting-files Task.
"""

from __future__ import annotations

import os
import unittest
from pathlib import Path
from types import SimpleNamespace

from backend.db import control_database
from backend.db.database import get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.import_export.watch import UNREADABLE_FILE_REASON, attention_counts
from backend.routers.tasks import get_tasks
from backend.services import database_health
from backend.tests._api_client import api_client

# Permissions do not stop root, and Windows has no mode bits to clear.
CANNOT_MAKE_UNREADABLE = not hasattr(os, "geteuid") or os.geteuid() == 0


def _attach(conn, data_path: str, document_id: str, filename: str, readable: bool = True) -> Path:
    conn.execute("INSERT OR IGNORE INTO account (id, name, display_name) VALUES ('acct', 'Everyday', 'Everyday')")
    conn.execute(
        "INSERT OR IGNORE INTO txn (id, account_id, amount, date, merchant_name, display_name, raw_name) "
        "VALUES ('txn-1', 'acct', -12.5, '2026-03-14', 'Garage', 'Garage', 'Garage')")
    conn.execute(
        "INSERT INTO document (id, txn_id, filename, mime_type, byte_size, sha256, created_at) "
        "VALUES (?, 'txn-1', ?, 'application/pdf', 4, 'x', '2026-03-14T00:00:00Z')",
        (document_id, filename))
    path = Path(data_path).parent / "documents" / document_id
    path.parent.mkdir(exist_ok=True)
    path.write_bytes(b"%PDF")
    if not readable:
        path.chmod(0)
    return path


@unittest.skipIf(CANNOT_MAKE_UNREADABLE, "needs a user that file permissions apply to")
class UnreadableDocumentTests(unittest.TestCase):
    def test_the_check_names_an_unreadable_file_and_passes_over_a_missing_one(self):
        with api_client() as (client, data_path):
            with get_db() as conn:
                _attach(conn, data_path, "doc-fine", "fine.pdf")
                _attach(conn, data_path, "doc-gone", "gone.pdf").unlink()
                locked = _attach(conn, data_path, "doc-locked", "receipt.pdf", readable=False)
            try:
                check = client.get("/api/diagnostics/database/check").json()
            finally:
                locked.chmod(0o600)
        documents = check["databases"][database_health.DOCUMENTS]
        self.assertFalse(check["ok"])
        self.assertEqual(documents["unreadable"], 1)
        self.assertEqual(len(documents["problems"]), 1)
        self.assertIn("receipt.pdf", documents["problems"][0])
        self.assertEqual(documents["server_user"], database_health.server_user())

    def test_a_backup_is_refused_with_a_message_naming_the_file(self):
        with api_client() as (client, data_path):
            with get_db() as conn:
                locked = _attach(conn, data_path, "doc-locked", "receipt.pdf", readable=False)
            try:
                refused = client.get("/api/import-export/backup")
            finally:
                locked.chmod(0o600)
            self.assertEqual(refused.status_code, 409)
            detail = refused.json()["detail"]
            self.assertEqual(detail["code"], "documents_unreadable")
            self.assertIn("receipt.pdf", detail["message"])
            self.assertIn(str(locked.parent), detail["message"])
            self.assertEqual(client.get("/api/import-export/backup").status_code, 200)


    def test_viewing_an_unreadable_file_is_refused_with_its_reason_and_a_missing_one_apart(self):
        with api_client() as (client, data_path):
            with get_db() as conn:
                locked = _attach(conn, data_path, "doc-locked", "receipt.pdf", readable=False)
                _attach(conn, data_path, "doc-gone", "gone.pdf").unlink()
            try:
                refused = client.get("/api/documents/doc-locked/file", headers={"Range": "bytes=0-0"})
            finally:
                locked.chmod(0o600)
            missing = client.get("/api/documents/doc-gone/file")
            served = client.get("/api/documents/doc-locked/file", headers={"Range": "bytes=0-0"})
        self.assertEqual(refused.status_code, 500)
        self.assertEqual(refused.json()["detail"]["code"], "document_unreadable")
        self.assertIn("Permission denied", refused.json()["detail"]["message"])
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(served.status_code, 206)
        self.assertEqual(served.content, b"%")


class WatchedFolderTaskTests(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        original = control_database.CONTROL_DB_PATH
        control_database.CONTROL_DB_PATH = str(Path(self.tempdir.name) / "control.db")
        self.addCleanup(setattr, control_database, "CONTROL_DB_PATH", original)
        control_database.init_control_db()
        self.db_path = str(Path(self.tempdir.name) / "tasks.db")
        init_db(self.db_path)
        token = set_current_db_path(self.db_path)
        self.addCleanup(reset_current_db_path, token)
        with get_db() as conn:
            conn.execute(
                "INSERT INTO csv_import_profile (id, name, watch_enabled, watch_dir) "
                "VALUES ('src', 'Card exports', 1, '/srv/statements')")

    def _tasks(self):
        request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"),
                                  url=SimpleNamespace(hostname="127.0.0.1", scheme="http"),
                                  state=SimpleNamespace(user={"id": "test-user"}))
        return {t["id"]: t for t in get_tasks(request)["tasks"]}

    def test_a_folder_the_scan_could_not_list_is_a_task_until_it_can(self):
        self.assertNotIn("watched_folder_unreadable", self._tasks())
        with get_db() as conn:
            conn.execute("UPDATE csv_import_profile SET watch_notice = 'This folder cannot be read.'")
        task = self._tasks()["watched_folder_unreadable"]
        self.assertIn("Card exports", task["description"])
        self.assertIn("/srv/statements", task["description"])

        with get_db() as conn:
            conn.execute("UPDATE csv_import_profile SET watch_notice = NULL")
        self.assertNotIn("watched_folder_unreadable", self._tasks())

    def test_a_watched_file_that_could_not_be_read_is_counted_apart_from_other_failures(self):
        with get_db() as conn:
            conn.executemany(
                "INSERT INTO import_watch_file (id, profile_id, filename, size, mtime, state, reason) "
                "VALUES (?, 'src', ?, 10, 1.0, 'error', ?)",
                [("f1", "a.csv", f"{UNREADABLE_FILE_REASON}: Permission denied"),
                 ("f2", "b.csv", "The import failed: bad row")])
        with get_db() as conn:
            self.assertEqual(attention_counts(conn)["unreadable"], 1)


if __name__ == "__main__":
    unittest.main()
