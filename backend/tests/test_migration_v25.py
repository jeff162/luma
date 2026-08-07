"""
Migration v25 — a source is assumed to lag its bank unless it says otherwise.

v24 added `csv_import_profile.terminal_window_days` defaulted to 1, meaning "only the export day is
incomplete", on the premise that widening should be opt-in per source. That premise was backwards.
Most sources lag the thing they describe, and the two errors are not symmetric: assuming no lag when
there is one blanket-rejects a real transaction as "already covered" and removes it from the ledger,
while assuming a lag that isn't there costs one extra reconciliation pass that still catches genuine
duplicates and names them.

So v25 does two things a fresh install gets for free and only an upgrading database needs: it is the
step that makes an already-v24 database agree with a brand-new one. The only database in the world
that ran v24's original `DEFAULT 1` is one that upgraded mid-development, which is precisely the case
these tests construct — a fresh migration through the current v24 never produces a 1 to rewrite.
"""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from backend.db import database
from backend.services.duplicate_detection import DEFAULT_TERMINAL_WINDOW_DAYS


class MigrationV25Tests(unittest.TestCase):
    """A database already stamped at 24, holding the column as v24 originally created it."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = str(Path(self.tmp.name) / "v24.db")
        self.conn = sqlite3.connect(self.path)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript("""
            CREATE TABLE csv_import_profile (
                id TEXT PRIMARY KEY, name TEXT, column_map TEXT,
                terminal_window_days INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO db_meta (key, value) VALUES ('version', '24');
        """)
        self.conn.commit()

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def _profile(self, pid, *, window=None):
        if window is None:
            self.conn.execute(
                "INSERT INTO csv_import_profile (id, name, column_map) VALUES (?,?,'{}')", (pid, pid))
        else:
            self.conn.execute(
                "INSERT INTO csv_import_profile (id, name, column_map, terminal_window_days)"
                " VALUES (?,?,'{}',?)", (pid, pid, window))
        self.conn.commit()

    def _window(self, pid):
        return self.conn.execute(
            "SELECT terminal_window_days AS w FROM csv_import_profile WHERE id = ?", (pid,)
        ).fetchone()["w"]

    def _migrate(self):
        database.run_migrations(self.conn)
        self.conn.commit()

    def test_a_source_left_at_the_old_default_starts_assuming_a_lag(self):
        self._profile("monarch")
        self.assertEqual(self._window("monarch"), 1)

        self._migrate()

        self.assertEqual(self._window("monarch"), DEFAULT_TERMINAL_WINDOW_DAYS)
        self.assertEqual(database.get_db_version(self.conn), database.CURRENT_VERSION)

    def test_a_source_that_stated_a_wider_lag_is_left_exactly_as_it_was(self):
        # Only the untouched default is rewritten. Anything else is someone's answer.
        self._profile("slow", window=14)
        self._migrate()
        self.assertEqual(self._window("slow"), 14)

    def test_the_stale_column_default_survives_and_is_why_every_writer_states_the_value(self):
        # Worth pinning as a known asymmetry rather than discovering it later. SQLite cannot change a
        # column default in place, and rebuilding a table other tables reference by foreign key to fix
        # a value no code reads is a poor trade. So an upgraded database keeps DEFAULT 1 in its DDL
        # while a fresh one has 7 — harmless *because* every insert path in the app supplies the column
        # explicitly (create_profile, create_profile_from_batch, the PayPal source, demo data). If a
        # new writer ever omits it, an upgraded database would silently create no-lag sources.
        self._migrate()
        self.conn.execute("INSERT INTO csv_import_profile (id, name, column_map) VALUES ('raw','raw','{}')")
        self.assertEqual(self._window("raw"), 1)

    def test_running_it_again_changes_nothing(self):
        # It is registered for post-restore replay, so it must be idempotent against data that has
        # already had it applied — and must not walk a deliberate 1 back up on a second pass.
        self._profile("monarch")
        self._migrate()
        database._widen_unset_csv_terminal_window(self.conn)
        self.conn.commit()
        self.assertEqual(self._window("monarch"), DEFAULT_TERMINAL_WINDOW_DAYS)

    def test_a_deliberate_no_lag_choice_is_protected_by_the_version_gate_not_by_the_value(self):
        # The honest limit of the rewrite, stated so nobody assumes a protection that isn't there. A 1
        # written *after* v25 is a real decision ("this source publishes its own records"), but it is
        # byte-identical to v24's old default, so the step cannot tell them apart — called directly, it
        # rewrites both. What protects the decision is `run_post_restore_data_init`, which replays a
        # step only when the backup predates it: a backup taken at 25 or later never runs this again.
        self._migrate()
        self.conn.execute(
            "INSERT INTO csv_import_profile (id, name, column_map, terminal_window_days)"
            " VALUES ('amazon','amazon','{}',1)")
        self.conn.commit()

        database.run_post_restore_data_init(self.conn, database.CURRENT_VERSION)
        self.conn.commit()
        self.assertEqual(self._window("amazon"), 1,
                         "a restore of a current-version backup must not replay the widening")

        database.run_post_restore_data_init(self.conn, 24)
        self.conn.commit()
        self.assertEqual(self._window("amazon"), DEFAULT_TERMINAL_WINDOW_DAYS,
                         "a restore of a pre-v25 backup does replay it, which is the intended trade")


if __name__ == "__main__":
    unittest.main()
