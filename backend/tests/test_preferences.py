"""
UI preferences storage + the control-DB→data-DB relocation bridge.

Preferences moved out of the control DB into the data DB (keyed by scope_id) so they travel with
the data and are captured by backups. These pin the new store's scope isolation and that the
transitional relocation copies a scope's values over and clears the control-DB copy (no loss, no
double-home).
"""

from __future__ import annotations

import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

from backend.db import control_database
from backend.db.database import get_db, init_db, reset_current_db_path, set_current_db_path
from backend.services.preferences import (
    clear_preferences,
    get_preferences,
    relocate_legacy_preferences,
    set_preference,
)


class PreferenceStoreTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "prefs-data.db"
        init_db(str(self.db_path))
        # Isolate the control DB so the relocation test never touches the real one.
        self._control_path = control_database.CONTROL_DB_PATH
        control_database.CONTROL_DB_PATH = str(Path(self.tempdir.name) / "prefs-control.db")
        control_database.init_control_db()

    def tearDown(self):
        control_database.CONTROL_DB_PATH = self._control_path
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def test_set_get_clear_are_scope_isolated(self):
        with self._use_db_path():
            set_preference("scope-a", "k", "1")
            set_preference("scope-b", "k", "2")
            self.assertEqual(get_preferences("scope-a"), {"k": "1"})
            self.assertEqual(get_preferences("scope-b"), {"k": "2"})
            set_preference("scope-a", "k", "9")  # upsert
            self.assertEqual(get_preferences("scope-a"), {"k": "9"})
            clear_preferences("scope-a")
            self.assertEqual(get_preferences("scope-a"), {})
            self.assertEqual(get_preferences("scope-b"), {"k": "2"})  # other scope untouched

    def test_relocate_moves_local_pref_into_data_db_and_clears_control(self):
        profile = control_database.create_local_preference_profile("Alice")
        control_database.set_local_preference(profile["id"], "ui.dashboard.tagReports", '[{"id":"r1"}]')

        with self._use_db_path():
            relocated = relocate_legacy_preferences(profile["id"], is_auth=False)
            data_prefs = get_preferences(profile["id"])

        self.assertEqual(relocated, {"ui.dashboard.tagReports": '[{"id":"r1"}]'})
        self.assertEqual(data_prefs, {"ui.dashboard.tagReports": '[{"id":"r1"}]'})
        self.assertEqual(control_database.get_local_preferences(profile["id"]), {})

    def test_relocate_is_a_noop_when_no_legacy_values(self):
        with self._use_db_path():
            self.assertEqual(relocate_legacy_preferences("nobody", is_auth=False), {})
            self.assertEqual(get_preferences("nobody"), {})


if __name__ == "__main__":
    unittest.main()
