"""Watched import folders: the unattended scan, and every case in which it must refuse.

The claims worth pinning are the refusals, because they are what separates an unattended import from
an automatic one. A file is taken only when the source's stored mapping already answers every question
the mapping UI would ask; anything else parks it for a person, and parking self-clears once the reason
is fixed somewhere else. The rest covers the watermark that keeps a scan off the disk and the purge,
which deletes only what it can still prove it imported.
"""

import asyncio
import json
import os
import tempfile
import time
import unittest
from contextlib import contextmanager
from pathlib import Path

from fastapi import HTTPException

from backend.db.database import get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.import_export import watch
from backend.routers.import_export.core import PAYPAL_SOURCE_KIND, _get_or_create_paypal_profile, run_import_core
from backend.routers.import_export.paypal_statement import COLUMN_MAP as STATEMENT_COLUMN_MAP
from backend.routers.import_export.paypal_statement import import_paypal_statements
from backend.tests._pdf_fixture import make_text_pdf
from backend.tests.test_paypal_statement import DEPOSIT, PAYMENT, FakeUpload, statement_pdf, txn

def _as_desktop(test):
    """Pin the installation to one only this computer can open, with no roots named, which is where any
    folder may be watched. Both are read per call from process-wide state — whether another device has
    been seen, the developer's `.env` — that other tests in the same worker can set, so a test about
    something else must not inherit them."""
    from unittest import mock
    for patcher in (mock.patch.object(watch, "reachable_from_network", return_value=False),
                    mock.patch.object(watch.app_config, "watch_folder_roots", return_value=[])):
        patcher.start()
        test.addCleanup(patcher.stop)


HEADER = "Date,Description,Amount,Account\n"
ROW = "2026-02-03,Corner Market,12.50,Checking\n"


class _WatchFolderCase(unittest.TestCase):
    """The database, source and folder fixtures the watched-folder tests share; it holds no tests."""

    def setUp(self):
        _as_desktop(self)
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


class ImportWatchTests(_WatchFolderCase):
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

    def test_a_vendor_adding_a_column_costs_one_hand_import_rather_than_a_new_source(self):
        """The parked reason names the way out, and this is it: a hand import teaches the source the
        columns it was shown, so the folder resumes without its settings being touched."""
        header_v2 = "Date,Description,Amount,Account,Reference\n"
        self._create_source()
        self._prove_source()
        self._drop("february.csv", header_v2 + "2026-02-03,Corner Market,12.50,Checking,R-1\n")
        self._scan(); self._scan()
        self.assertEqual(self._files()["february.csv"]["state"], watch.WATCH_STATE_PARKED)

        with self._use_db_path():
            run_import_core(
                header_v2 + "2026-01-09,Bakery,4.25,Checking,R-0\n",
                {"profile_id": "src-1", "account_map": {"Checking": "acc-chk"},
                 "column_map": self._column_map(), "date_format": "%Y-%m-%d",
                 "amount_convention": "single_signed", "apply_categorization": False},
                filename="by-hand.csv",
            )
        with get_db(str(self.db_path)) as conn:
            self.assertEqual(
                conn.execute("SELECT header_fingerprint FROM csv_import_profile WHERE id = 'src-1'")
                    .fetchone()["header_fingerprint"],
                "Date|Description|Amount|Account|Reference",
            )

        self._scan()
        self.assertEqual(self._files()["february.csv"]["state"], watch.WATCH_STATE_IMPORTED)

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

    def test_clearing_the_path_clears_the_switch_even_when_the_same_request_enables_it(self):
        """Two reasons to write one column, in one request. SQLite takes the last assignment without
        complaining, so writing each as it was decided left a source with no folder and the switch
        still on — invisible in the status view, which lists only sources that have a path, and armed
        for whatever named a folder next."""
        self._create_source()
        with self._use_db_path():
            watch.set_profile_watch("src-1", watch.WatchSettings(watch_dir="", watch_enabled=True))
        with get_db(str(self.db_path)) as conn:
            row = conn.execute(
                "SELECT watch_dir, watch_enabled FROM csv_import_profile WHERE id = 'src-1'"
            ).fetchone()
            self.assertIsNone(row["watch_dir"])
            self.assertEqual(row["watch_enabled"], 0)
            self.assertEqual(watch.watched_sources(conn), [])

    def test_a_request_that_only_sets_the_switch_leaves_the_path_alone(self):
        self._create_source(watch_enabled=0)
        with self._use_db_path():
            watch.set_profile_watch("src-1", watch.WatchSettings(watch_enabled=True))
        with get_db(str(self.db_path)) as conn:
            row = conn.execute(
                "SELECT watch_dir, watch_enabled FROM csv_import_profile WHERE id = 'src-1'"
            ).fetchone()
        self.assertEqual(row["watch_dir"], str(self.watched))
        self.assertEqual(row["watch_enabled"], 1)

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


class WatchRootsTests(_WatchFolderCase):
    """Where an installation other devices can reach may watch. An administrator in the app need not have
    a shell on the machine, so the folders it may read are named by whoever does, in WATCH_FOLDER_ROOTS;
    with none named it watches nothing. Every way in is checked, not only the save, so a folder saved
    before the setting changed stops being read and is never deleted from."""

    def setUp(self):
        super().setUp()
        self.outside = Path(self.tempdir.name) / "elsewhere"
        self.outside.mkdir()

    @contextmanager
    def _server(self, *roots):
        from unittest import mock
        with mock.patch.object(watch, "reachable_from_network", return_value=True), \
                mock.patch.object(watch.app_config, "watch_folder_roots", return_value=[str(r) for r in roots]):
            yield

    def _save_folder(self, folder):
        with self._use_db_path():
            return watch.set_profile_watch("src-1", watch.WatchSettings(watch_dir=str(folder), watch_enabled=True))

    def test_a_server_with_no_roots_named_watches_nothing(self):
        self._create_source()
        self._prove_source()
        self._drop("january.csv")
        with self._server():
            self._scan(); self._scan()
            with self.assertRaises(HTTPException) as refused:
                self._save_folder(self.watched)
            listing = watch.browse_directories(None)
        self.assertEqual(refused.exception.status_code, 400)
        self.assertFalse(listing["watching_enabled"])
        self.assertEqual(listing["roots"], [])
        self.assertNotIn(self._files().get("january.csv", {}).get("state"), (watch.WATCH_STATE_IMPORTED,))
        with get_db(str(self.db_path)) as conn:
            self.assertEqual(conn.execute(
                "SELECT watch_notice FROM csv_import_profile WHERE id = 'src-1'").fetchone()["watch_notice"],
                watch.WATCHING_NOT_ENABLED)

    def test_a_folder_inside_a_root_is_watched_and_one_outside_is_refused(self):
        self._create_source()
        self._prove_source()
        with self._server(self.watched.parent / "downloads"):
            self.assertEqual(self._save_folder(self.watched), {"ok": True})
            with self.assertRaises(HTTPException):
                self._save_folder(self.outside)
            self._drop("january.csv")
            self._scan(); self._scan()
        self.assertEqual(self._files()["january.csv"]["state"], watch.WATCH_STATE_IMPORTED)

    def test_a_link_inside_a_root_that_leads_outside_it_is_outside(self):
        link = self.watched / "shortcut"
        os.symlink(self.outside, link)
        with self._server(self.watched):
            self.assertEqual(watch.watch_folder_refusal(str(link)), watch.OUTSIDE_WATCH_ROOTS)

    def test_a_folder_saved_before_the_roots_changed_is_neither_read_nor_purged(self):
        self._create_source(purge_mode="on_import")
        self._prove_source()
        imported = self._drop("january.csv")
        self._scan(); self._scan()
        self.assertFalse(imported.exists(), "unconfined, the purge runs as configured")

        kept = self._drop("february.csv", HEADER + "2026-03-03,Corner Market,9.00,Checking\n")
        with self._server(self.outside):
            self._scan(); self._scan()
        self.assertTrue(kept.exists())
        self.assertNotEqual(self._files().get("february.csv", {}).get("state"), watch.WATCH_STATE_IMPORTED)

    def test_the_picker_starts_at_the_roots_and_goes_no_higher(self):
        with self._server(self.watched):
            start = watch.browse_directories(None)
            inside = watch.browse_directories(str(self.watched))
            above = watch.browse_directories(str(self.watched.parent))
        self.assertEqual([r["path"] for r in start["roots"]], [os.path.realpath(self.watched)])
        self.assertIsNone(inside["parent"])
        self.assertEqual(above["notice"], watch.OUTSIDE_WATCH_ROOTS)
        self.assertEqual(above["entries"], [])


class BrowseDirectoriesTests(unittest.TestCase):
    """The folder picker's listing. It exists because the path names a directory on the *server*, which
    the person setting it usually cannot see — and it is read-only on purpose: naming a path and
    scanning it already lists a directory and imports from it, so listing alone adds no capability."""

    def setUp(self):
        _as_desktop(self)
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name) / "downloads"
        (self.root / "statements").mkdir(parents=True)
        (self.root / ".cache").mkdir()
        (self.root / "january.csv").write_text(HEADER + ROW)
        (self.root / "february.csv").write_text(HEADER + ROW)
        (self.root / "notes.txt").write_text("not an export")

    def tearDown(self):
        self.tempdir.cleanup()

    def test_it_lists_the_folders_and_the_files_that_would_be_taken(self):
        # Naming the files is what makes the choice answerable in the picker: a folder is the right one
        # because the exports are sitting in it, which the path by itself does not say.
        result = watch.browse_directories(str(self.root))
        self.assertEqual([e["name"] for e in result["entries"]], [".cache", "statements"])
        self.assertEqual([f["name"] for f in result["files"]], ["february.csv", "january.csv"])
        self.assertEqual(result["file_count"], 2)
        self.assertIsNone(result["notice"])

    def test_a_file_the_scan_would_not_take_is_not_offered_as_one_it_would(self):
        # The picker filters on the same table the scan does, so it can never name a file the folder
        # would pass over. What must not drift is the two being one list.
        (self.root / "statement.pdf").write_bytes(b"%PDF-1.4")
        result = watch.browse_directories(str(self.root))
        self.assertEqual({f["name"] for f in result["files"]}, {"january.csv", "february.csv"})
        self.assertTrue(all(watch._is_candidate_name(f["name"], {}) for f in result["files"]))

    def test_a_dot_folder_is_marked_rather_than_dropped(self):
        # The scan ignores dot-prefixed names, so listing them unmarked would offer a folder that can
        # never take a file; hiding them outright would strand anyone whose exports live under one.
        entry = next(e for e in watch.browse_directories(str(self.root))["entries"] if e["name"] == ".cache")
        self.assertTrue(entry["hidden"])

    def test_a_folder_that_is_not_there_is_a_notice_rather_than_a_failure(self):
        # Removable media and network shares come and go; the same wording the scan itself uses.
        result = watch.browse_directories(str(self.root / "nope"))
        self.assertEqual(result["notice"], "This folder is not there right now.")
        self.assertEqual(result["entries"], [])

    def test_a_file_path_says_so_instead_of_listing_its_folder(self):
        result = watch.browse_directories(str(self.root / "january.csv"))
        self.assertEqual(result["notice"], "This path is not a folder.")

    def test_no_path_returns_the_starting_places_and_touches_nothing(self):
        result = watch.browse_directories(None)
        self.assertIsNone(result["path"])
        self.assertEqual(result["entries"], [])
        self.assertIn("Home", [root["label"] for root in result["roots"]])

    def test_the_walk_up_stops_at_a_root_rather_than_pointing_at_itself(self):
        # `os.path.dirname` of a root returns the root, which would render as an Up that goes nowhere.
        self.assertIsNone(watch._parent_of(os.path.abspath(os.sep)))
        self.assertEqual(watch.browse_directories(str(self.root))["parent"], str(self.root.parent))

    def test_a_huge_folder_is_cut_and_says_so(self):
        # Read into one response, so it needs the ceiling every other unbounded list has.
        crowded = Path(self.tempdir.name) / "crowded"
        crowded.mkdir()
        for i in range(watch.MAX_BROWSE_ENTRIES + 5):
            (crowded / f"d{i:04d}").mkdir()
        result = watch.browse_directories(str(crowded))
        self.assertEqual(len(result["entries"]), watch.MAX_BROWSE_ENTRIES)
        self.assertTrue(result["truncated"])


class AmazonWatchedFolderTests(unittest.TestCase):
    """An Amazon source watching a folder. The shape is the CSV path's, so what is pinned here is what
    differs: an AZAD export is recognized by its own header rather than by a stored column map, and the
    question the saved source has to answer is which real account each paying card charges. An unmapped
    card parks the file, because resolving it wrong moves a charge into the wrong account silently —
    the same reason an unmapped account value parks a CSV."""

    ORDERS_CSV = (
        "order id,order url,items,to,date,total,shipping,shipping_refund,gift,tax,refund,payments\n"
        '111-000,,Air Widget; ,J,2024-11-19,37.32,0,,,2.19,,"Test Card ending in 4321: 2024-11-19: $37.32; "\n'
    )

    def setUp(self):
        _as_desktop(self)
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "watch.db"
        self.watched = Path(self.tempdir.name) / "amazon"
        self.watched.mkdir()
        init_db(str(self.db_path))
        with get_db(str(self.db_path)) as conn:
            conn.execute(
                """INSERT INTO account (id, external_account_id, provider, name, display_name, type)
                   VALUES ('acc-amz', NULL, 'manual', 'Amazon', 'Amazon', 'amazon')"""
            )
            conn.execute(
                """INSERT INTO account (id, external_account_id, provider, name, display_name, type)
                   VALUES ('acc-card', NULL, 'manual', 'Card', 'Card', 'credit')"""
            )
            conn.execute(
                """
                INSERT INTO csv_import_profile
                  (id, name, source_kind, account_id, apply_categorization, column_map,
                   watch_dir, watch_enabled)
                VALUES ('amz-1', 'Amazon household', 'marketplace:amazon', 'acc-amz', 0, '{}', ?, 1)
                """,
                (str(self.watched),),
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

    def _map_card(self):
        # Through the service, so the mapping is keyed exactly as the import form's would be — the
        # network label is part of an instrument's identity, and a row keyed without it is a different
        # card that never matches.
        from backend.services import amazon_funding
        with get_db(str(self.db_path)) as conn:
            amazon_funding.upsert_funding_source(
                conn, last4="4321", network="Test Card", funding_account_id="acc-card")

    def _prove_source(self):
        """The one hand import an Amazon source needs before it may run on its own — here, a card of its
        own so `_source_has_completed_batch` is satisfied without re-deriving the import."""
        with get_db(str(self.db_path)) as conn:
            conn.execute(
                """INSERT INTO import_batch (id, filename, status, source_kind, profile_id)
                   VALUES ('b-proof', 'proof.csv', 'completed', 'marketplace:amazon', 'amz-1')"""
            )

    def _drop(self, name, body=None):
        path = self.watched / name
        path.write_text(body if body is not None else self.ORDERS_CSV)
        stamp = time.time() - (watch.QUIET_SECONDS + 5)
        os.utime(path, (stamp, stamp))
        return path

    def _scan_twice(self):
        with self._use_db_path():
            watch.scan_watched_sources()
            return watch.scan_watched_sources()

    def _file_state(self, name):
        with get_db(str(self.db_path)) as conn:
            row = conn.execute(
                "SELECT state, reason FROM import_watch_file WHERE filename = ?", (name,)
            ).fetchone()
        return (row["state"], row["reason"]) if row else (None, None)

    def test_an_orders_export_in_the_folder_is_imported_onto_a_card_of_its_source(self):
        self._prove_source()
        self._map_card()
        self._drop("2024-orders.csv")
        self._scan_twice()
        self.assertEqual(self._file_state("2024-orders.csv"), (watch.WATCH_STATE_IMPORTED, None))
        with get_db(str(self.db_path)) as conn:
            row = conn.execute(
                """SELECT profile_id, row_count FROM import_batch
                   WHERE filename = '2024-orders.csv' AND source_kind = 'marketplace:amazon'"""
            ).fetchone()
        self.assertEqual((row["profile_id"], row["row_count"]), ("amz-1", 1))

    def test_a_file_whose_paying_card_is_unmapped_is_parked_rather_than_guessed_at(self):
        self._prove_source()
        self._drop("2024-orders.csv")
        self._scan_twice()
        state, reason = self._file_state("2024-orders.csv")
        self.assertEqual(state, watch.WATCH_STATE_PARKED)
        self.assertIn("4321", reason)
        with get_db(str(self.db_path)) as conn:
            self.assertEqual(conn.execute(
                "SELECT COUNT(*) AS n FROM txn").fetchone()["n"], 0)

    def test_parking_clears_itself_once_the_card_is_mapped(self):
        """A parked file is retried every pass because its refusal is about the ledger, which is fixed
        somewhere else — mapping the card in the import form is what lets the folder resume."""
        self._prove_source()
        self._drop("2024-orders.csv")
        self._scan_twice()
        self.assertEqual(self._file_state("2024-orders.csv")[0], watch.WATCH_STATE_PARKED)
        self._map_card()
        with self._use_db_path():
            watch.scan_watched_sources()
        self.assertEqual(self._file_state("2024-orders.csv")[0], watch.WATCH_STATE_IMPORTED)

    def test_a_source_with_nothing_imported_by_hand_takes_nothing_on_its_own(self):
        self._map_card()
        self._drop("2024-orders.csv")
        self._scan_twice()
        state, reason = self._file_state("2024-orders.csv")
        self.assertEqual(state, watch.WATCH_STATE_PARKED)
        self.assertIn("by hand", reason)

    def test_a_csv_that_is_not_an_amazon_export_is_parked_not_read_through_some_other_mapping(self):
        self._prove_source()
        self._map_card()
        self._drop("bank.csv", "Date,Description,Amount\n2026-02-03,Corner Market,12.50\n")
        self._scan_twice()
        state, reason = self._file_state("bank.csv")
        self.assertEqual(state, watch.WATCH_STATE_PARKED)
        self.assertIn("not an Amazon", reason)

    def test_a_file_already_imported_is_recognized_by_content_not_re_imported(self):
        self._prove_source()
        self._map_card()
        self._drop("2024-orders.csv")
        self._scan_twice()
        self._drop("2024-orders-copy.csv")
        self._scan_twice()
        self.assertEqual(self._file_state("2024-orders-copy.csv")[0], watch.WATCH_STATE_DUPLICATE)
        with get_db(str(self.db_path)) as conn:
            self.assertEqual(conn.execute(
                """SELECT COUNT(*) AS n FROM import_batch
                   WHERE source_kind = 'marketplace:amazon' AND id != 'b-proof'""").fetchone()["n"], 1)


class PaypalStatementWatchedFolderTests(unittest.TestCase):
    """The PayPal source watching a folder takes statement PDFs as well as activity CSVs. The question a
    statement asks is which ledger account its PayPal account goes into; a statement imported by hand
    answers it for that PayPal account, and nothing else may — so a statement for a PayPal account with
    no statement imported yet is parked rather than guessed into one."""

    def setUp(self):
        _as_desktop(self)
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "watch.db"
        self.watched = Path(self.tempdir.name) / "paypal"
        self.watched.mkdir()
        init_db(str(self.db_path))
        with get_db(str(self.db_path)) as conn:
            conn.execute(
                """INSERT INTO account (id, external_account_id, provider, name, display_name, type)
                   VALUES ('acc-pp', NULL, 'manual', 'PayPal', 'PayPal', 'paypal')"""
            )
        with self._use_db_path(), get_db() as conn:
            self.profile_id = _get_or_create_paypal_profile(
                conn, header_fingerprint="", column_map=STATEMENT_COLUMN_MAP, date_format="%m/%d/%Y",
                amount_convention="single_signed", decimal_separator="point")
            conn.execute("UPDATE csv_import_profile SET watch_dir = ?, watch_enabled = 1 WHERE id = ?",
                         (str(self.watched), self.profile_id))

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _import_by_hand(self, pdf):
        with self._use_db_path():
            asyncio.run(import_paypal_statements([FakeUpload("by-hand.pdf", pdf)],
                                                 json.dumps({"robin@example.com": "acc-pp"})))

    def _drop(self, name, data):
        path = self.watched / name
        path.write_bytes(data)
        stamp = time.time() - (watch.QUIET_SECONDS + 5)
        os.utime(path, (stamp, stamp))
        return path

    def _scan_twice(self):
        with self._use_db_path():
            watch.scan_watched_sources()
            return watch.scan_watched_sources()

    def _file_state(self, name):
        with get_db(str(self.db_path)) as conn:
            row = conn.execute(
                "SELECT state, reason FROM import_watch_file WHERE filename = ?", (name,)
            ).fetchone()
        return (row["state"], row["reason"]) if row else (None, None)

    def _paypal_rows(self):
        with get_db(str(self.db_path)) as conn:
            return conn.execute(
                "SELECT COUNT(*) AS n FROM txn WHERE account_id = 'acc-pp' AND trashed_at IS NULL").fetchone()["n"]

    def test_a_statement_for_a_paypal_account_seen_before_goes_into_the_same_account(self):
        self._import_by_hand(statement_pdf([PAYMENT, DEPOSIT]))
        may = txn("05/03/2026", "Mobile Payment: Sam Okafor", "-12.00", "9MM00000MM0000009")
        self._drop("statement-May-2026.pdf", statement_pdf([may], period=("May 1, 2026 - May 31,", "2026")))
        self._scan_twice()
        self.assertEqual(self._file_state("statement-May-2026.pdf"), (watch.WATCH_STATE_IMPORTED, None))
        self.assertEqual(self._paypal_rows(), 3)
        with get_db(str(self.db_path)) as conn:
            row = conn.execute(
                "SELECT profile_id, source_kind FROM import_batch WHERE filename = 'statement-May-2026.pdf'"
            ).fetchone()
        self.assertEqual((row["profile_id"], row["source_kind"]), (self.profile_id, PAYPAL_SOURCE_KIND))

    def test_a_statement_for_an_unseen_paypal_account_parks_until_one_is_imported_by_hand(self):
        """The account a statement goes into is chosen by a person once per PayPal account; after that the
        parked file is retried and imports itself."""
        self._drop("statement-Apr-2026.pdf", statement_pdf([PAYMENT, DEPOSIT]))
        self._scan_twice()
        state, reason = self._file_state("statement-Apr-2026.pdf")
        self.assertEqual(state, watch.WATCH_STATE_PARKED)
        self.assertIn("robin@example.com", reason)
        self.assertEqual(self._paypal_rows(), 0)

        march = txn("03/10/2026", "Mobile Payment: Sam Okafor", "-8.00", "8MM00000MM0000008")
        self._import_by_hand(statement_pdf([march], period=("Mar 1, 2026 - Mar 31,", "2026")))
        with self._use_db_path():
            watch.scan_watched_sources()
        self.assertEqual(self._file_state("statement-Apr-2026.pdf")[0], watch.WATCH_STATE_IMPORTED)
        self.assertEqual(self._paypal_rows(), 3)

    def test_a_statement_whose_account_was_trashed_parks_rather_than_landing_elsewhere(self):
        self._import_by_hand(statement_pdf([PAYMENT, DEPOSIT]))
        with get_db(str(self.db_path)) as conn:
            conn.execute("UPDATE account SET trashed_at = '2026-05-01T00:00:00Z' WHERE id = 'acc-pp'")
        may = txn("05/03/2026", "Mobile Payment: Sam Okafor", "-12.00", "9MM00000MM0000009")
        self._drop("may.pdf", statement_pdf([may], period=("May 1, 2026 - May 31,", "2026")))
        self._scan_twice()
        self.assertEqual(self._file_state("may.pdf")[0], watch.WATCH_STATE_PARKED)

    def test_the_same_month_downloaded_again_is_recognized(self):
        self._import_by_hand(statement_pdf([PAYMENT, DEPOSIT]))
        self._drop("statement-Apr-2026 (1).pdf",
                   statement_pdf([PAYMENT, DEPOSIT], footnote="*Totals include any fees."))
        self._scan_twice()
        self.assertEqual(self._file_state("statement-Apr-2026 (1).pdf")[0], watch.WATCH_STATE_DUPLICATE)
        self.assertEqual(self._paypal_rows(), 2)

    def test_a_pdf_that_is_not_a_statement_is_parked(self):
        self._import_by_hand(statement_pdf([PAYMENT, DEPOSIT]))
        self._drop("invoice.pdf", make_text_pdf(["INVOICE", "Harbor Cycle Works", "Total 54.95"]))
        self._scan_twice()
        state, reason = self._file_state("invoice.pdf")
        self.assertEqual(state, watch.WATCH_STATE_PARKED)
        self.assertIn("not a PayPal statement", reason)

    def test_purge_re_reads_a_statement_to_prove_it_was_imported(self):
        """A statement's recorded identity is over what was read, not its bytes, so the purge's re-check
        has to read it the same way — hashing the bytes would call every statement changed."""
        self._import_by_hand(statement_pdf([PAYMENT, DEPOSIT]))
        with get_db(str(self.db_path)) as conn:
            conn.execute("UPDATE csv_import_profile SET watch_purge_mode = 'on_import' WHERE id = ?",
                         (self.profile_id,))
        may = txn("05/03/2026", "Mobile Payment: Sam Okafor", "-12.00", "9MM00000MM0000009")
        path = self._drop("may.pdf", statement_pdf([may], period=("May 1, 2026 - May 31,", "2026")))
        self._scan_twice()
        self.assertFalse(path.exists())

    def test_only_the_paypal_source_takes_pdfs_and_none_takes_a_zip(self):
        # A zip is expanded by the upload, never from a folder: nobody has looked inside it.
        self._drop("statements.zip", b"PK\x03\x04")
        self._drop("statement.pdf", statement_pdf([PAYMENT, DEPOSIT]))
        with self._use_db_path():
            watch.scan_watched_sources()
            listing = watch.browse_directories(str(self.watched), profile_id=self.profile_id)
            plain = watch.browse_directories(str(self.watched))
        self.assertEqual(set(self._watched_names()), {"statement.pdf"})
        self.assertEqual([f["name"] for f in listing["files"]], ["statement.pdf"])
        self.assertEqual(plain["files"], [])

    def test_a_parked_statement_is_handed_back_as_the_pdf_on_disk(self):
        pdf = statement_pdf([PAYMENT, DEPOSIT])
        self._drop("statement.pdf", pdf)
        self._scan_twice()
        with get_db(str(self.db_path)) as conn:
            file_id = conn.execute("SELECT id FROM import_watch_file").fetchone()["id"]
        with self._use_db_path():
            response = watch.watch_file_content(file_id)
        self.assertEqual((response.body, response.media_type), (pdf, "application/pdf"))

    def _watched_names(self):
        with get_db(str(self.db_path)) as conn:
            return [r["filename"] for r in conn.execute("SELECT filename FROM import_watch_file")]


if __name__ == "__main__":
    unittest.main()
