"""Watched import folders: the unattended scan, and every case in which it must refuse.

The claims worth pinning are the refusals, because they are what separates an unattended import from
an automatic one. A file is taken only when the source's stored mapping already answers every question
the mapping UI would ask; anything else parks it for a person, and parking self-clears once the reason
is fixed somewhere else. The rest covers the watermark that keeps a scan off the disk and the purge,
which deletes only what it can still prove it imported.
"""

import os
import tempfile
import time
import unittest
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.import_export import watch
from backend.routers.import_export.core import run_import_core

HEADER = "Date,Description,Amount,Account\n"
ROW = "2026-02-03,Corner Market,12.50,Checking\n"


class ImportWatchTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "watch.db"
        self.watched = Path(self.tempdir.name) / "downloads"
        self.watched.mkdir()
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

    # --- fixtures -----------------------------------------------------------------------------

    def _column_map(self, **extra):
        column_map = {
            "date": "Date", "amount": "Amount", "description": "Description", "account": "Account",
            "account_assignments": {"Checking": "acc-chk"},
        }
        column_map.update(extra)
        return column_map

    def _create_source(self, *, column_map=None, watch_enabled=1, purge_mode="never", purge_days=30,
                       filename_pattern=None, header_fingerprint="Date|Description|Amount|Account"):
        import json
        with get_db(str(self.db_path)) as conn:
            conn.execute(
                """
                INSERT INTO csv_import_profile
                  (id, name, column_map, date_format, amount_convention, apply_categorization,
                   header_fingerprint, filename_pattern,
                   watch_dir, watch_enabled, watch_purge_mode, watch_purge_days)
                VALUES ('src-1', 'Bank', ?, '%Y-%m-%d', 'single_signed', 0, ?, ?, ?, ?, ?, ?)
                """,
                (json.dumps(column_map if column_map is not None else self._column_map()),
                 header_fingerprint, filename_pattern,
                 str(self.watched), watch_enabled, purge_mode, purge_days),
            )
        return "src-1"

    def _prove_source(self):
        """The one hand import a source needs before it may run on its own."""
        with self._use_db_path():
            run_import_core(
                HEADER + "2026-01-02,Opening,1.00,Checking\n",
                {"profile_id": "src-1", "account_map": {"Checking": "acc-chk"},
                 "column_map": self._column_map(), "date_format": "%Y-%m-%d",
                 "amount_convention": "single_signed", "apply_categorization": False},
                filename="proof.csv",
            )

    def _drop(self, name, body=HEADER + ROW, *, age_seconds=None):
        path = self.watched / name
        path.write_text(body)
        stamp = time.time() - (age_seconds if age_seconds is not None else watch.QUIET_SECONDS + 5)
        os.utime(path, (stamp, stamp))
        return path

    def _scan(self):
        with self._use_db_path():
            return watch.scan_watched_sources()

    def _files(self):
        with get_db(str(self.db_path)) as conn:
            return {row["filename"]: dict(row) for row in
                    conn.execute("SELECT * FROM import_watch_file").fetchall()}

    # --- the watermark ------------------------------------------------------------------------

    def test_a_new_file_is_only_taken_on_the_pass_after_it_is_first_seen(self):
        """The first sighting records the file; only a second pass that finds it unmoved reads it. A
        half-written download parses as a truncated one, which is worse than not seeing it at all."""
        self._create_source()
        self._prove_source()
        self._drop("january.csv")

        self._scan()
        self.assertEqual(self._files()["january.csv"]["state"], watch.WATCH_STATE_WATCHING)
        with get_db(str(self.db_path)) as conn:
            self.assertIsNone(conn.execute(
                "SELECT id FROM import_batch WHERE filename = 'january.csv'").fetchone())

        self._scan()
        self.assertEqual(self._files()["january.csv"]["state"], watch.WATCH_STATE_IMPORTED)
        with get_db(str(self.db_path)) as conn:
            self.assertIsNotNone(conn.execute(
                "SELECT id FROM import_batch WHERE filename = 'january.csv'").fetchone())

    def test_a_file_written_seconds_ago_is_left_alone_however_many_passes_run(self):
        """`(size, mtime)` unchanged across two passes is satisfiable by two presses of Check now while
        a download is between writes; the quiet period is what closes that."""
        self._create_source()
        self._prove_source()
        self._drop("fresh.csv", age_seconds=0)
        for _ in range(3):
            self._scan()
        self.assertEqual(self._files()["fresh.csv"]["state"], watch.WATCH_STATE_WATCHING)

    def test_a_file_replaced_in_place_is_re_read_rather_than_trusted(self):
        """A replacement that keeps the name is exactly what a file-count comparison misses."""
        self._create_source()
        self._prove_source()
        self._drop("statement.csv")
        self._scan(); self._scan()
        self.assertEqual(self._files()["statement.csv"]["state"], watch.WATCH_STATE_IMPORTED)

        self._drop("statement.csv", HEADER + "2026-02-09,Hardware Store,31.00,Checking\n")
        self._scan()
        self.assertEqual(self._files()["statement.csv"]["state"], watch.WATCH_STATE_WATCHING)
        self._scan()
        self.assertEqual(self._files()["statement.csv"]["state"], watch.WATCH_STATE_IMPORTED)
        with get_db(str(self.db_path)) as conn:
            descriptions = {r["raw_name"] for r in conn.execute("SELECT raw_name FROM txn").fetchall()}
        self.assertIn("Hardware Store", descriptions)

    def test_a_file_already_imported_by_hand_is_recognized_not_re_imported(self):
        self._create_source()
        self._prove_source()
        self._drop("proof.csv", HEADER + "2026-01-02,Opening,1.00,Checking\n")
        self._scan(); self._scan()
        self.assertEqual(self._files()["proof.csv"]["state"], watch.WATCH_STATE_DUPLICATE)
        with get_db(str(self.db_path)) as conn:
            self.assertEqual(conn.execute(
                "SELECT COUNT(*) AS n FROM import_batch").fetchone()["n"], 1)

    def test_only_candidate_files_are_looked_at(self):
        """A watched folder is a download destination, so it collects things this source cannot read,
        and a half-finished download is not a file yet."""
        self._create_source()
        self._prove_source()
        self._drop("statement.csv")
        self._drop("statement.csv.crdownload")
        self._drop("receipt.pdf")
        self._drop(".hidden.csv")
        self._scan()
        self.assertEqual(set(self._files()), {"statement.csv"})

    def test_a_filename_pattern_lets_two_sources_share_one_folder(self):
        self._create_source(filename_pattern="bank-")
        self._prove_source()
        self._drop("bank-january.csv")
        self._drop("card-january.csv")
        self._scan()
        self.assertEqual(set(self._files()), {"bank-january.csv"})

    # --- the refusals -------------------------------------------------------------------------

    def test_a_source_that_has_never_been_imported_by_hand_parks_its_first_file(self):
        self._create_source()
        self._drop("january.csv")
        self._scan(); self._scan()
        parked = self._files()["january.csv"]
        self.assertEqual(parked["state"], watch.WATCH_STATE_PARKED)
        self.assertIn("by hand", parked["reason"])

    def test_an_unmapped_account_value_parks_the_file_rather_than_importing_part_of_it(self):
        """The whole safety rule. The import would refuse these rows one by one and take the rest,
        which is how half a file lands with nobody having chosen that."""
        self._create_source()
        self._prove_source()
        self._drop("january.csv", HEADER + ROW + "2026-02-04,Rent,900.00,Savings\n")
        self._scan(); self._scan()
        parked = self._files()["january.csv"]
        self.assertEqual(parked["state"], watch.WATCH_STATE_PARKED)
        self.assertIn("Savings", parked["reason"])
        with get_db(str(self.db_path)) as conn:
            self.assertIsNone(conn.execute(
                "SELECT id FROM import_batch WHERE filename = 'january.csv'").fetchone())

    def test_a_source_that_would_create_an_account_never_runs_unattended(self):
        self._create_source(column_map=self._column_map(
            account_assignments={}, account_new={"Checking": {"name": "Checking", "type": "depository"}}))
        self._prove_source()
        self._drop("january.csv")
        self._scan(); self._scan()
        parked = self._files()["january.csv"]
        self.assertEqual(parked["state"], watch.WATCH_STATE_PARKED)
        self.assertIn("new account", parked["reason"])

    def test_a_mapping_pointing_at_a_deleted_account_parks_rather_than_falling_back_to_the_name(self):
        """The interactive flow falls back to an exact name match and shows the result for approval.
        Unattended there is nobody to approve it, and a name match is precisely the guess that puts
        rows on the wrong account."""
        self._create_source(column_map=self._column_map(account_assignments={"Checking": "acc-gone"}))
        self._prove_source()
        self._drop("january.csv")
        self._scan(); self._scan()
        parked = self._files()["january.csv"]
        self.assertEqual(parked["state"], watch.WATCH_STATE_PARKED)
        self.assertIn("no longer exists", parked["reason"])

    def test_a_trashed_account_does_not_count_as_resolved(self):
        with get_db(str(self.db_path)) as conn:
            conn.execute("UPDATE account SET trashed_at = '2026-02-01T00:00:00' WHERE id = 'acc-chk'")
        self._create_source()
        self._prove_source()
        self._drop("january.csv")
        self._scan(); self._scan()
        self.assertEqual(self._files()["january.csv"]["state"], watch.WATCH_STATE_PARKED)

    def test_a_file_with_the_wrong_columns_is_parked_not_read_through_the_wrong_map(self):
        self._create_source()
        self._prove_source()
        self._drop("other.csv", "Posted,Memo,Debit,Credit\n2026-02-03,Corner Market,12.50,\n")
        self._scan(); self._scan()
        parked = self._files()["other.csv"]
        self.assertEqual(parked["state"], watch.WATCH_STATE_PARKED)
        self.assertIn("columns", parked["reason"])

    def test_a_blank_account_cell_does_not_park_the_whole_file(self):
        """A trailing footer line has no account value, and the import already refuses such a row and
        records it on the card. Parking for one would make every export with a footer a Task."""
        self._create_source()
        self._prove_source()
        self._drop("january.csv", HEADER + ROW + "Total,,,\n")
        self._scan(); self._scan()
        self.assertEqual(self._files()["january.csv"]["state"], watch.WATCH_STATE_IMPORTED)

    def test_a_parked_file_imports_itself_once_the_reason_is_fixed(self):
        """Parking is a question about the ledger, and the answer is given somewhere else entirely —
        which is what makes the Task able to clear itself rather than needing the file touched."""
        import json
        self._create_source()
        self._prove_source()
        self._drop("january.csv", HEADER + ROW + "2026-02-04,Rent,900.00,Savings\n")
        self._scan(); self._scan()
        self.assertEqual(self._files()["january.csv"]["state"], watch.WATCH_STATE_PARKED)

        with get_db(str(self.db_path)) as conn:
            conn.execute(
                """INSERT INTO account (id, external_account_id, provider, name, display_name, type)
                   VALUES ('acc-sav', NULL, 'manual', 'Savings', 'Savings', 'depository')"""
            )
            conn.execute(
                "UPDATE csv_import_profile SET column_map = ? WHERE id = 'src-1'",
                (json.dumps(self._column_map(
                    account_assignments={"Checking": "acc-chk", "Savings": "acc-sav"})),),
            )
        self._scan()
        self.assertEqual(self._files()["january.csv"]["state"], watch.WATCH_STATE_IMPORTED)

    def test_a_dismissed_file_is_not_reported_again_until_it_changes(self):
        self._create_source()
        self._drop("january.csv")
        self._scan(); self._scan()
        file_id = self._files()["january.csv"]["id"]
        with self._use_db_path():
            watch.dismiss_watch_file(file_id)
            self.assertEqual(watch.scan_watched_sources()["attention"]["total"], 0)
        self.assertEqual(self._files()["january.csv"]["state"], watch.WATCH_STATE_DISMISSED)

        self._drop("january.csv", HEADER + "2026-02-11,Pharmacy,9.00,Checking\n")
        self._scan()
        self.assertEqual(self._files()["january.csv"]["state"], watch.WATCH_STATE_WATCHING)

    # --- notices, purging and the restore rule ------------------------------------------------

    def test_a_missing_folder_is_a_notice_on_the_source_rather_than_a_failed_scan(self):
        self._create_source()
        with get_db(str(self.db_path)) as conn:
            conn.execute("UPDATE csv_import_profile SET watch_dir = ? WHERE id = 'src-1'",
                         (str(self.watched / "not-mounted"),))
        result = self._scan()
        self.assertEqual(len(result["sources"]), 1)
        self.assertIn("not there", result["sources"][0]["notice"])

    def test_purge_deletes_an_imported_file_and_leaves_one_that_changed_since(self):
        self._create_source(purge_mode=watch.PURGE_ON_IMPORT)
        self._prove_source()
        self._drop("january.csv")
        self._scan(); self._scan()
        self.assertFalse((self.watched / "january.csv").exists())
        self.assertEqual(self._files(), {})

        self._drop("february.csv", HEADER + "2026-02-20,Bakery,4.00,Checking\n")
        self._scan()
        self._drop("february.csv", HEADER + "2026-02-21,Bakery,5.00,Checking\n")
        # Second pass imports what it read, then the file is swapped before the purge would run again.
        self._scan(); self._scan()
        self._drop("february.csv", HEADER + "2026-02-22,Something Else,6.00,Checking\n")
        self._scan()
        self.assertTrue((self.watched / "february.csv").exists(),
                        "a file whose content changed after import must not be deleted")

    def test_purge_never_is_the_default_and_leaves_everything_in_place(self):
        self._create_source()
        self._prove_source()
        self._drop("january.csv")
        self._scan(); self._scan()
        self.assertEqual(self._files()["january.csv"]["state"], watch.WATCH_STATE_IMPORTED)
        self.assertTrue((self.watched / "january.csv").exists())

    def test_disabling_watching_keeps_the_path_and_drops_the_watermark(self):
        """What a restore from another machine does: the folders stop being read, and the paths stay
        visible so the person can say what each one should be here."""
        self._create_source()
        self._drop("january.csv")
        self._scan()
        with get_db(str(self.db_path)) as conn:
            self.assertEqual(watch.disable_watching(conn, "restored elsewhere"), 1)
            row = conn.execute(
                "SELECT watch_dir, watch_enabled, watch_notice FROM csv_import_profile WHERE id = 'src-1'"
            ).fetchone()
        self.assertEqual(row["watch_dir"], str(self.watched))
        self.assertEqual(row["watch_enabled"], 0)
        self.assertIn("restored", row["watch_notice"])
        self.assertEqual(self._files(), {})
        self.assertEqual(self._scan()["sources"], [])

    def test_auto_scan_is_a_no_op_until_it_is_due(self):
        self._create_source()
        self._prove_source()
        self._drop("january.csv")
        with self._use_db_path():
            self.assertNotIn("skipped", watch.maybe_auto_scan())
            self.assertEqual(watch.maybe_auto_scan().get("skipped"), "recent")
        self.assertEqual(self._files()["january.csv"]["state"], watch.WATCH_STATE_WATCHING)

    def test_auto_scan_does_not_look_at_anything_when_no_source_is_watched(self):
        self._create_source(watch_enabled=0)
        with self._use_db_path():
            self.assertEqual(watch.maybe_auto_scan().get("skipped"), "no_watched_sources")


if __name__ == "__main__":
    unittest.main()
