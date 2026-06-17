"""
UI preferences storage (data DB, keyed by scope_id).

Preferences live in the data DB so they travel with the data and are captured by backups. These
pin the store's scope isolation (one scope's writes never bleed into another, upserts replace, and
clear is scoped to one scope).
"""

from __future__ import annotations

import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import init_db, reset_current_db_path, set_current_db_path
from backend.services.preferences import (
    clear_preferences,
    get_preferences,
    set_preference,
)


class PreferenceStoreTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "prefs-data.db"
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


if __name__ == "__main__":
    unittest.main()
