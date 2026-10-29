"""A data source's decimal separator, from the import it configures to the source saved from it.

The parse itself is pinned in `test_import_amount_parsing.py`. What this pins is that the setting reaches
the parse on every path a file takes, and survives the round trip through a batch's snapshot: a path
that drops it falls back to point-decimal, and a comma-decimal file read that way is refused row by row.
"""

import json
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

from fastapi import HTTPException

from backend.db.database import get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.import_export.core import parse_csv_text, run_import_core
from backend.routers.import_export.profiles import (
    BatchCreateProfileRequest, ProfileCreate, ProfileUpdate, create_profile, create_profile_from_batch,
    get_profile_compatible_batches, list_profiles, update_profile,
)
from backend.routers.import_export.watch import build_watch_import_config

COMMA_CSV = (
    "Date,Description,Amount\n"
    "2026-01-05,Grocer,\"-1.234,56\"\n"
    "2026-01-06,Refund,\"12,50\"\n"
)


class DecimalSeparatorImportTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "decimal.db"
        init_db(str(self.db_path))
        with get_db(str(self.db_path)) as conn:
            conn.execute(
                """INSERT INTO account (id, external_account_id, provider, name, display_name, type)
                   VALUES ('acc-chk', NULL, 'manual', 'Checking', 'Checking', 'depository')"""
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

    def _import(self, decimal_separator=None, filename="bank.csv"):
        cfg = {
            "account_id": "acc-chk",
            "column_map": {"date": "Date", "amount": "Amount", "description": "Description"},
            "date_format": "%Y-%m-%d",
            "amount_convention": "single_signed",
            "apply_categorization": False,
        }
        if decimal_separator is not None:
            cfg["decimal_separator"] = decimal_separator
        with self._use_db_path():
            return run_import_core(COMMA_CSV, cfg, filename=filename)

    def _stored_amounts(self):
        with get_db(str(self.db_path)) as conn:
            return sorted(r["amount"] for r in conn.execute("SELECT amount FROM txn"))

    def test_a_comma_source_imports_its_amounts_and_records_the_setting(self):
        result = self._import("comma")
        self.assertEqual(result.get("imported"), 2)
        self.assertEqual(self._stored_amounts(), [-12.5, 1234.56])
        with get_db(str(self.db_path)) as conn:
            snapshot = json.loads(conn.execute("SELECT config_snapshot FROM import_batch").fetchone()[0])
        self.assertEqual(snapshot["decimal_separator"], "comma")

    def test_a_comma_file_read_point_decimal_is_refused_not_misread(self):
        result = self._import()
        self.assertEqual(result.get("imported"), 0)
        self.assertEqual(result.get("skipped"), 2)
        self.assertEqual(self._stored_amounts(), [])

    def test_an_unknown_separator_is_refused_before_anything_is_written(self):
        with self.assertRaises(HTTPException) as caught:
            self._import("dot")
        self.assertEqual(caught.exception.status_code, 400)
        with get_db(str(self.db_path)) as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM import_batch").fetchone()[0], 0)

    def test_a_source_saved_from_the_batch_keeps_the_setting_and_its_watch_imports_use_it(self):
        self._import("comma")
        with get_db(str(self.db_path)) as conn:
            batch_id = conn.execute("SELECT id FROM import_batch").fetchone()[0]
        with self._use_db_path():
            profile_id = create_profile_from_batch(batch_id, BatchCreateProfileRequest(name="Comma Bank"))["id"]
        with get_db(str(self.db_path)) as conn:
            profile = dict(conn.execute("SELECT * FROM csv_import_profile WHERE id = ?", (profile_id,)).fetchone())
            self.assertEqual(profile["decimal_separator"], "comma")
            cfg, problem = build_watch_import_config(conn, profile, parse_csv_text(COMMA_CSV))
        self.assertIsNone(problem)
        self.assertEqual(cfg["decimal_separator"], "comma")

    def _separator(self, profile_id):
        with self._use_db_path():
            return {p["id"]: p for p in list_profiles()}[profile_id]["decimal_separator"]

    def test_a_source_states_its_separator_and_an_edit_changes_only_what_it_names(self):
        with self._use_db_path():
            profile_id = create_profile(ProfileCreate(name="Plain", column_map={}))["id"]
        self.assertEqual(self._separator(profile_id), "point")
        with self._use_db_path():
            update_profile(profile_id, ProfileUpdate(decimal_separator="comma"))
        self.assertEqual(self._separator(profile_id), "comma")
        with self._use_db_path():
            update_profile(profile_id, ProfileUpdate(name="Renamed"))
        self.assertEqual(self._separator(profile_id), "comma")

    def test_a_source_does_not_adopt_a_file_read_the_other_way(self):
        # Adopting it would claim the source reads that file, which it would refuse row by row.
        self._import("comma")
        column_map = {"date": "Date", "amount": "Amount", "description": "Description"}
        with get_db(str(self.db_path)) as conn:
            fingerprint = json.loads(
                conn.execute("SELECT config_snapshot FROM import_batch").fetchone()[0])["header_fingerprint"]
        reports = {}
        for separator in ("point", "comma"):
            with self._use_db_path():
                profile_id = create_profile(ProfileCreate(
                    name=f"Source {separator}", column_map=column_map, account_id="acc-chk",
                    header_fingerprint=fingerprint, date_format="%Y-%m-%d", apply_categorization=False,
                    decimal_separator=separator,
                ))["id"]
                reports[separator] = len(get_profile_compatible_batches(profile_id)["batches"])
        self.assertEqual(reports, {"point": 0, "comma": 1})


if __name__ == "__main__":
    unittest.main()
