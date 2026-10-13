"""
The workspace's recorded database path follows the installation.

Every request is routed by a path written into the control database when the first identity was created,
while startup readies the configured database. The cases here are the ways the two come apart, each of
which used to leave startup looking healthy and requests opening an empty file somewhere else.
"""

from __future__ import annotations

import sqlite3
import unittest
from pathlib import Path
from unittest import mock

from backend.db import control_database as cdb
from backend.tests._api_client import api_client


def _recorded() -> str:
    with cdb.get_control_db() as conn:
        return conn.execute("SELECT db_path FROM tenant").fetchone()["db_path"]


def _record(path: str) -> None:
    with cdb.get_control_db() as conn:
        conn.execute("UPDATE tenant SET db_path = ?", (path,))


class WorkspaceDbPathTests(unittest.TestCase):
    def test_a_moved_installation_finds_its_data_again(self):
        """The reported shape: a portable folder moved or renamed, so the recorded path names nothing.
        Requests have to land on the database that is here, and nothing may be created where it was."""
        with api_client() as (client, data_path):
            created = client.post("/api/categories", json={"name": "Kept Category"})
            self.assertEqual(created.status_code, 200, created.text)
            old_home = Path(data_path).parent / "where-it-used-to-be" / "data.db"
            _record(str(old_home))

            cdb.reconcile_workspace_db_path()

            self.assertEqual(_recorded(), data_path)
            listed = client.get("/api/categories")
            self.assertEqual(listed.status_code, 200, listed.text)
            self.assertIn("Kept Category", listed.text)
            self.assertFalse(old_home.parent.exists(), "an empty database was created at the old location")

    def test_a_copied_packaged_build_uses_its_own_data_not_the_originals(self):
        """A copy of a portable folder still has the original beside it, so the recorded path names a
        real file — someone else's. A packaged build's folder is its installation."""
        with api_client() as (_client, data_path):
            original = Path(data_path).parent / "original.db"
            sqlite3.connect(original).close()
            _record(str(original))

            with mock.patch.object(cdb, "is_frozen", return_value=True):
                cdb.reconcile_workspace_db_path()

            self.assertEqual(_recorded(), data_path)

    def test_a_checkout_running_on_its_recorded_database_is_not_moved_off_it(self):
        """In a checkout nothing says the folder is the installation, and adopting the configured path
        would put an install that has been running on the recorded one onto an empty database."""
        with api_client() as (_client, data_path):
            in_use = Path(data_path).parent / "in-use.db"
            sqlite3.connect(in_use).close()
            _record(str(in_use))

            with mock.patch.object(cdb, "is_frozen", return_value=False):
                cdb.reconcile_workspace_db_path()

            self.assertEqual(_recorded(), str(in_use))

    def test_a_record_that_already_agrees_is_not_rewritten(self):
        with api_client() as (_client, data_path):
            with mock.patch.object(cdb, "log_info") as logged:
                cdb.reconcile_workspace_db_path()
            self.assertEqual(_recorded(), data_path)
            logged.assert_not_called()
