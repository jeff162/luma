"""
Data-source (csv_import_profile) listing coverage.

Pins the rule that a saved data source stays visible regardless of the trash state of any account
it maps. Previously `list_profiles` hid any profile that referenced a trashed account, which —
because the name-uniqueness check scans every row — turned the profile into a ghost: invisible in
the UI yet still blocking its own name, so it could be neither edited, deleted, nor recreated.
"""

from __future__ import annotations

import json
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.import_export import list_profiles


class ImportProfileListingTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "profiles.db"
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

    def _insert_account(self, name: str, *, trashed: bool = False) -> str:
        account_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO account
                      (id, external_account_id, provider, name, display_name, type, subtype,
                       mask, owner_id, parent_account_id, trashed_at)
                    VALUES (?, ?, 'fixture', ?, ?, 'depository', 'checking', NULL, ?, NULL, ?)
                    """,
                    (account_id, f"plaid_{account_id}", name, name, SHARED_OWNER_ID,
                     "2026-01-01T00:00:00.000Z" if trashed else None),
                )
        return account_id

    def _insert_profile(self, name: str, *, account_id: str | None = None,
                        account_assignments: dict | None = None) -> str:
        profile_id = str(uuid.uuid4())
        column_map = {"account_assignments": account_assignments} if account_assignments else {}
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO csv_import_profile (id, name, account_id, column_map) VALUES (?, ?, ?, ?)",
                    (profile_id, name, account_id, json.dumps(column_map)),
                )
        return profile_id

    def test_profile_with_trashed_account_assignment_still_listed(self):
        # The real-world ghost: a multi-account data source where one mapped account was later
        # trashed (e.g. a merged child folded into its parent). The profile must stay visible.
        good = self._insert_account("Main Checking")
        gone = self._insert_account("Old Card", trashed=True)
        self._insert_profile("Mint", account_assignments={"Main Checking": good, "Old Card": gone})
        with self._use_db_path():
            names = [p["name"] for p in list_profiles()]
        self.assertIn("Mint", names,
                      "a data source must stay listed even when a mapped account is trashed")

    def test_profile_with_trashed_single_account_still_listed(self):
        gone = self._insert_account("Old Card", trashed=True)
        self._insert_profile("Single", account_id=gone)
        with self._use_db_path():
            names = [p["name"] for p in list_profiles()]
        self.assertIn("Single", names)
