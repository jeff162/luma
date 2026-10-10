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

from fastapi import HTTPException

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.import_export import ProfileCreate, ProfileUpdate, create_profile, list_profiles, update_profile
from backend.routers.import_export.core import run_import_core
from backend.routers.import_export.profiles import get_profile_compatible_batches
from backend.routers.import_export.profiles import MAX_TERMINAL_WINDOW_DAYS, ProfileNewAccount
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


class CompatibleBatchesTests(unittest.TestCase):
    """Which already-imported files a saved source offers to adopt.

    A file imported before its source existed sits under "unknown data source"; creating the source
    afterwards should offer to take those files over, matched on the mapping they were imported with.
    The comparison reads the profile's `column_map` out of the database as text and the batch's out of
    its own `config_snapshot`, which the caller has already parsed — two shapes into one normalizer, and
    reading only the text form meant the batch side arrived with every column blank. The effect was
    total rather than partial: any profile with a column mapped (so, any profile) matched nothing, and
    the feature looked like it had simply found no candidates.
    """

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "compatible.db"
        init_db(str(self.db_path))
        with get_db(str(self.db_path)) as conn:
            conn.execute(
                """
                INSERT INTO account
                  (id, external_account_id, provider, name, display_name, type, subtype,
                   mask, owner_id, parent_account_id, trashed_at)
                VALUES ('acc-chk', 'fixture-chk', 'fixture', 'Checking', 'Checking', 'depository',
                        'checking', NULL, ?, NULL, NULL)
                """,
                (SHARED_OWNER_ID,),
            )

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    COLUMN_MAP = {"date": "Date", "description": "Description", "amount": "Amount", "account": "Account"}

    def _import_without_a_source(self, *, apply_categorization: bool = False) -> str:
        csv = ("Date,Description,Amount,Account\n"
               "2026-06-02,Corner Market,-18.40,Checking\n")
        with self._use_db_path():
            result = run_import_core(
                csv,
                {
                    "account_map": {"Checking": "acc-chk"},
                    "column_map": self.COLUMN_MAP,
                    "header_fingerprint": "Date|Description|Amount|Account",
                    "date_format": "%Y-%m-%d",
                    "amount_convention": "single_signed",
                    "apply_categorization": apply_categorization,
                },
                filename="june.csv",
            )
        return result["batch_id"]

    def _create_matching_source(self) -> str:
        with self._use_db_path():
            return create_profile(ProfileCreate(
                name="Harborline Checking",
                column_map=dict(self.COLUMN_MAP),
                header_fingerprint="Date|Description|Amount|Account",
                date_format="%Y-%m-%d",
                amount_convention="single_signed",
                apply_categorization=False,
            ))["id"]

    def test_a_source_finds_the_historical_file_it_could_own(self):
        batch_id = self._import_without_a_source()
        profile_id = self._create_matching_source()
        with self._use_db_path():
            report = get_profile_compatible_batches(profile_id)
        self.assertEqual([b["id"] for b in report["batches"]], [batch_id])
        self.assertEqual(report["batches"][0]["filename"], "june.csv")

    def test_a_source_whose_columns_disagree_finds_nothing(self):
        """The other half of the claim. Without this the test above passes against a comparison that
        matches everything, which is the opposite failure and just as wrong."""
        self._import_without_a_source()
        with self._use_db_path():
            profile_id = create_profile(ProfileCreate(
                name="Different Layout",
                column_map={"date": "Posted", "description": "Memo", "amount": "Value"},
                header_fingerprint="Posted|Memo|Value",
                date_format="%Y-%m-%d",
                amount_convention="single_signed",
                apply_categorization=False,
            ))["id"]
            report = get_profile_compatible_batches(profile_id)
        self.assertEqual(report["batches"], [])

    def test_a_flag_the_two_sides_spell_differently_still_discriminates(self):
        """`apply_categorization` is an integer on the profile row and a boolean in the batch snapshot.

        Read by identity against the `False` singleton, a stored 0 came back as *on*, so the field
        stopped discriminating in the only direction that is observable: a source with categorization
        **off** read as on and therefore matched a file imported **on**, which it must not. The
        complementary case — off against off — is the positive test above, which the same defect broke.
        """
        batch_id = self._import_without_a_source(apply_categorization=True)
        with self._use_db_path():
            report = get_profile_compatible_batches(self._create_matching_source())
        self.assertNotIn(
            batch_id, [b["id"] for b in report["batches"]],
            "a source that does not categorize must not claim a file that was imported categorized",
        )


class NewAccountOnSaveTests(unittest.TestCase):
    """The data source editor's "Create new account…": the account is created with the source.

    The import screen's version instead stores `single_account_new` and creates the account at the next
    import, which a watched folder refuses to act on — so the editor creates it on save.
    """

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "new-account.db"
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

    def _accounts_named(self, name: str) -> list:
        with get_db(str(self.db_path)) as conn:
            return conn.execute("SELECT id, type, provider FROM account WHERE name = ?", (name,)).fetchall()

    def _profile_account_id(self, profile_id: str):
        with self._use_db_path():
            return {p["id"]: p for p in list_profiles()}[profile_id]["account_id"]

    def test_creating_a_source_with_a_new_account_points_it_at_that_account(self):
        with self._use_db_path():
            pid = create_profile(ProfileCreate(
                name="Riverstone Card", column_map={},
                new_account=ProfileNewAccount(name="Riverstone Card", type="credit"),
            ))["id"]
        [account] = self._accounts_named("Riverstone Card")
        self.assertEqual((account["type"], account["provider"]), ("credit", "csv"))
        self.assertEqual(self._profile_account_id(pid), account["id"])

    def test_an_edit_can_create_the_account_too(self):
        with self._use_db_path():
            pid = create_profile(ProfileCreate(name="Northgate", column_map={}))["id"]
            update_profile(pid, ProfileUpdate(new_account=ProfileNewAccount(name="Northgate Savings")))
        [account] = self._accounts_named("Northgate Savings")
        self.assertEqual(self._profile_account_id(pid), account["id"])

    def test_a_name_already_in_use_is_refused_and_nothing_is_saved(self):
        # The editor shows the same refusal before saving; this is the backstop. The import path's
        # find-or-create would instead point the source at an account the user did not pick.
        with self._use_db_path():
            create_profile(ProfileCreate(
                name="First", column_map={}, new_account=ProfileNewAccount(name="Harborline Checking"),
            ))
            with self.assertRaises(HTTPException):
                create_profile(ProfileCreate(
                    name="Second", column_map={}, new_account=ProfileNewAccount(name="harborline checking"),
                ))
            names = [p["name"] for p in list_profiles()]
        self.assertEqual(names, ["First"])
        self.assertEqual(len(self._accounts_named("Harborline Checking")), 1)

    def test_an_import_asked_to_create_an_account_that_exists_uses_it(self):
        # `single_account_new` naming an existing account resolves to that account. This path used to
        # read a variable only the create branch assigned, and failed the whole import.
        with self._use_db_path():
            create_profile(ProfileCreate(
                name="Seed", column_map={}, new_account=ProfileNewAccount(name="Harborline Checking"),
            ))
            run_import_core(
                "Date,Description,Amount\n2026-06-02,Corner Market,-18.40\n",
                {
                    "column_map": {"date": "Date", "description": "Description", "amount": "Amount"},
                    "single_account_new": {"name": "Harborline Checking", "type": "depository"},
                    "date_format": "%Y-%m-%d",
                    "amount_convention": "single_signed",
                },
                filename="june.csv",
            )
        [account] = self._accounts_named("Harborline Checking")
        with get_db(str(self.db_path)) as conn:
            landed = conn.execute("SELECT account_id FROM txn").fetchall()
        self.assertEqual([row["account_id"] for row in landed], [account["id"]])


class ImportSourceLearnsItsLayoutTests(unittest.TestCase):
    """A source takes the columns of each file imported through it.

    Matching a file to a saved source is exact string equality on the header, so a vendor adding one
    column used to orphan every later export: the source went on describing a layout that no file
    had any more, and the only way forward was a second source per generation. The import is where
    that is corrected, and deliberately not the moment the warning was dismissed — only a completed
    import proves the source's mapping still reads the file.
    """

    HEADER = "Date,Description,Amount,Account\n"
    ROW = "2026-06-02,Corner Market,-18.40,Checking\n"
    COLUMN_MAP = {"date": "Date", "description": "Description", "amount": "Amount", "account": "Account"}

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "layout.db"
        init_db(str(self.db_path))
        with get_db(str(self.db_path)) as conn:
            conn.execute(
                """
                INSERT INTO account
                  (id, external_account_id, provider, name, display_name, type, subtype,
                   mask, owner_id, parent_account_id, trashed_at)
                VALUES ('acc-chk', 'fixture-chk', 'fixture', 'Checking', 'Checking', 'depository',
                        'checking', NULL, ?, NULL, NULL)
                """,
                (SHARED_OWNER_ID,),
            )

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _create_source(self, *, source_kind: str | None = None) -> str:
        with self._use_db_path():
            profile_id = create_profile(ProfileCreate(
                name="Harborline Checking",
                column_map=dict(self.COLUMN_MAP),
                header_fingerprint="Date|Description|Amount|Account",
                date_format="%Y-%m-%d",
                amount_convention="single_signed",
                apply_categorization=False,
            ))["id"]
        if source_kind:
            with get_db(str(self.db_path)) as conn:
                conn.execute("UPDATE csv_import_profile SET source_kind = ? WHERE id = ?",
                             (source_kind, profile_id))
        return profile_id

    def _import(self, profile_id: str, csv: str, filename: str = "june.csv"):
        with self._use_db_path():
            return run_import_core(
                csv,
                {
                    "profile_id": profile_id,
                    "account_map": {"Checking": "acc-chk"},
                    "column_map": dict(self.COLUMN_MAP),
                    "date_format": "%Y-%m-%d",
                    "amount_convention": "single_signed",
                    "apply_categorization": False,
                },
                filename=filename,
            )

    def _fingerprint(self, profile_id: str) -> str:
        with get_db(str(self.db_path)) as conn:
            return conn.execute(
                "SELECT header_fingerprint FROM csv_import_profile WHERE id = ?", (profile_id,)
            ).fetchone()["header_fingerprint"]

    def test_a_column_the_vendor_added_becomes_the_sources_own_layout(self):
        profile_id = self._create_source()
        self._import(profile_id, "Date,Description,Amount,Account,Reference\n"
                                 "2026-06-02,Corner Market,-18.40,Checking,R-1\n")
        self.assertEqual(self._fingerprint(profile_id), "Date|Description|Amount|Account|Reference")

    def test_importing_an_older_file_takes_the_source_back_to_that_layout(self):
        """Accepted rather than guarded against: the next current file moves it forward again, and a
        rule to stop it would have to decide which of two real layouts is the newer one."""
        profile_id = self._create_source()
        self._import(profile_id, "Date,Description,Amount,Account,Reference\n"
                                 "2026-06-02,Corner Market,-18.40,Checking,R-1\n", "june.csv")
        self._import(profile_id, self.HEADER + "2026-01-04,Bakery,-4.25,Checking\n", "january.csv")
        self.assertEqual(self._fingerprint(profile_id), "Date|Description|Amount|Account")

    def test_a_recognized_source_keeps_the_fingerprint_it_was_given(self):
        """One recognized source serves two file shapes — the activity CSV and the PDF statement —
        and is matched on the recognized kind rather than on this value. Letting each import claim it
        would leave the two rewriting each other."""
        profile_id = self._create_source(source_kind="source:paypal")
        self._import(profile_id, "Date,Description,Amount,Account,Reference\n"
                                 "2026-06-02,Corner Market,-18.40,Checking,R-1\n")
        self.assertEqual(self._fingerprint(profile_id), "Date|Description|Amount|Account")

    def test_a_file_imported_without_a_source_changes_no_source(self):
        profile_id = self._create_source()
        with self._use_db_path():
            run_import_core(
                "Date,Description,Amount,Account,Reference\n"
                "2026-06-02,Corner Market,-18.40,Checking,R-1\n",
                {
                    "account_map": {"Checking": "acc-chk"},
                    "column_map": dict(self.COLUMN_MAP),
                    "date_format": "%Y-%m-%d",
                    "amount_convention": "single_signed",
                    "apply_categorization": False,
                },
                filename="orphan.csv",
            )
        self.assertEqual(self._fingerprint(profile_id), "Date|Description|Amount|Account")
