"""
Data-source (csv_import_profile) CRUD coverage.

Two unrelated rules live here. The first: a saved data source stays visible regardless of the trash
state of any account it maps. Previously `list_profiles` hid any profile that referenced a trashed
account, which — because the name-uniqueness check scans every row — turned the profile into a
ghost: invisible in the UI yet still blocking its own name, so it could be neither edited, deleted,
nor recreated.

The second: `terminal_window_days`, the per-source declaration of how many trailing days it lags its
bank. The column and the coverage math that reads it landed first; these pin the CRUD half, without
which the setting was unreachable from anywhere but SQL.
"""

from __future__ import annotations

import json
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.import_export import ProfileCreate, ProfileUpdate, create_profile, list_profiles, update_profile
from backend.routers.import_export.profiles import MAX_TERMINAL_WINDOW_DAYS
from backend.services.duplicate_detection import DEFAULT_TERMINAL_WINDOW_DAYS


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


class SourceLagSettingTests(unittest.TestCase):
    """`terminal_window_days` — how many trailing days of an export are still filling in."""

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

    def _create(self, name: str, **kwargs) -> str:
        with self._use_db_path():
            return create_profile(ProfileCreate(name=name, column_map={}, **kwargs))["id"]

    def _lag(self, profile_id: str) -> int:
        with self._use_db_path():
            listed = {p["id"]: p for p in list_profiles()}
        return listed[profile_id]["terminal_window_days"]

    def test_a_new_source_assumes_it_lags_its_bank(self):
        # Most sources do, and the direction of error is asymmetric: assuming no lag when there is one
        # blanket-rejects a real transaction out of the ledger, while assuming a lag that isn't there
        # only costs a one-to-one reconciliation pass that still catches true duplicates by name.
        self.assertEqual(self._lag(self._create("Plain")), DEFAULT_TERMINAL_WINDOW_DAYS)

    def test_a_first_party_source_can_declare_that_it_has_no_lag(self):
        # A store or payment service publishes records it created itself, so only the export day is
        # partial. 1 restores exactly the pre-window behavior for that source alone.
        self.assertEqual(self._lag(self._create("PayPal", terminal_window_days=1)), 1)

    def test_a_source_can_declare_a_lag_of_its_own_size(self):
        self.assertEqual(self._lag(self._create("Slow Aggregator", terminal_window_days=10)), 10)

    def test_the_lag_is_editable_after_the_fact(self):
        # The value someone wants is discovered by watching a source miss things, not known when the
        # source is first saved — so the edit path matters more than the create path.
        pid = self._create("Fidelity")
        with self._use_db_path():
            update_profile(pid, ProfileUpdate(terminal_window_days=5))
        self.assertEqual(self._lag(pid), 5)

    def test_an_edit_that_does_not_mention_the_lag_leaves_it_alone(self):
        # Every other field on the form patches independently; this one must too, or renaming a
        # source would quietly reset how it dedupes.
        pid = self._create("Amazon", terminal_window_days=1)
        with self._use_db_path():
            update_profile(pid, ProfileUpdate(name="Amazon Orders"))
        self.assertEqual(self._lag(pid), 1)

    def test_a_lag_below_one_is_raised_to_one_not_to_the_default(self):
        # 0 is not merely odd, it is incoherent: the covered range would extend one day *past* the
        # source's own last date. It clamps to the narrowest legal window, because someone asking for
        # the narrowest must not be handed the widest.
        self.assertEqual(self._lag(self._create("Zero", terminal_window_days=0)), 1)
        self.assertEqual(self._lag(self._create("Negative", terminal_window_days=-4)), 1)

    def test_an_implausible_lag_is_capped_rather_than_rejected(self):
        pid = self._create("Typo", terminal_window_days=900)
        self.assertEqual(self._lag(pid), MAX_TERMINAL_WINDOW_DAYS)

    def test_the_cap_applies_on_edit_too(self):
        pid = self._create("Typo")
        with self._use_db_path():
            update_profile(pid, ProfileUpdate(terminal_window_days=0))
        self.assertEqual(self._lag(pid), 1)
