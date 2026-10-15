"""
Upgrades through the migrations after v25 that change what an existing database holds.

A fresh database is created directly in the current shape, so nothing about a fresh install proves an upgrade.
The migrations from v26 to v53 fall into two kinds. Most only add an empty column or table, and there is nothing
an old database could get wrong about them. The ones exercised here change something already stored — rename a
column that has data in it, set a value on rows that exist, backfill from another table, drop an index that
forbade rows now allowed, stamp an identity — and each of those can be wrong on real data in a way no fresh
database would show.

Each case follows `test_migration_v54.py`: a hand-built database holding only what that migration reads,
stamped at the version before it, taken through the whole chain to `CURRENT_VERSION`. Running the whole chain
is deliberate, because it also proves every later migration steps around a table it does not find.
"""

from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from backend.db import database


class MigrationCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.conn = sqlite3.connect(str(Path(self.tmp.name) / "upgrade.db"))
        self.conn.row_factory = sqlite3.Row

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def _database_at(self, version: int, schema: str) -> None:
        self.conn.executescript(
            schema
            + "\nCREATE TABLE db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);"
            + f"\nINSERT INTO db_meta (key, value) VALUES ('version', '{version}');"
        )
        self.conn.commit()

    def _upgrade(self) -> None:
        database.run_migrations(self.conn)
        self.conn.commit()
        self.assertEqual(database.get_db_version(self.conn), database.CURRENT_VERSION)

    def _columns(self, table: str) -> set[str]:
        return {row["name"] for row in self.conn.execute(f"PRAGMA table_info({table})")}

    def _index_exists(self, name: str) -> bool:
        return self.conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?", (name,)
        ).fetchone() is not None


class ProviderTransactionIdRenameTests(MigrationCase):
    """v26 renames a column that holds every synced row's idempotency key."""

    def test_the_ids_survive_the_rename_and_stay_unique(self):
        self._database_at(25, """
            CREATE TABLE txn (id TEXT PRIMARY KEY, plaid_transaction_id TEXT UNIQUE);
            INSERT INTO txn (id, plaid_transaction_id) VALUES ('a', 'simplefin:acct:prov-1'), ('b', NULL);
        """)
        self._upgrade()

        self.assertNotIn("plaid_transaction_id", self._columns("txn"))
        self.assertEqual(
            self.conn.execute("SELECT external_transaction_id FROM txn WHERE id = 'a'").fetchone()[0],
            "simplefin:acct:prov-1",
        )
        # The uniqueness is the point of the column: a sync that re-sends a row must not insert it twice.
        with self.assertRaises(sqlite3.IntegrityError):
            self.conn.execute("INSERT INTO txn (id, external_transaction_id) VALUES ('c', 'simplefin:acct:prov-1')")


class ConnectionHealthBackfillTests(MigrationCase):
    """v27 and v30 add NOT NULL counters to existing connections and state their values explicitly."""

    def test_existing_connections_start_healthy_with_no_sync_history(self):
        self._database_at(26, """
            CREATE TABLE connection (id TEXT PRIMARY KEY, provider TEXT);
            INSERT INTO connection (id, provider) VALUES ('c1', 'plaid'), ('c2', 'simplefin');
        """)
        self._upgrade()

        rows = self.conn.execute(
            "SELECT consecutive_sync_failures, reauth_required, last_synced_at FROM connection ORDER BY id"
        ).fetchall()
        self.assertEqual([tuple(row) for row in rows], [(0, 0, None), (0, 0, None)])


class PerAccountHistoryStateTests(MigrationCase):
    """v28 moves history state onto accounts, conservatively: nothing is assumed complete."""

    def test_every_existing_account_is_marked_not_yet_complete(self):
        self._database_at(27, """
            CREATE TABLE connection_account (id TEXT PRIMARY KEY, connection_id TEXT, external_account_id TEXT);
            INSERT INTO connection_account (id, connection_id, external_account_id) VALUES
                ('a1', 'c1', 'ext-1'), ('a2', 'c1', 'ext-2');
        """)
        self._upgrade()

        rows = self.conn.execute(
            "SELECT history_complete, history_empty_streak FROM connection_account ORDER BY id"
        ).fetchall()
        self.assertEqual([tuple(row) for row in rows], [(0, 0), (0, 0)])


class LastSyncSummaryBackfillTests(MigrationCase):
    """v38 derives each connection's card summary from its newest surviving sync-log row."""

    def setUp(self):
        super().setUp()
        self._database_at(37, """
            CREATE TABLE connection (id TEXT PRIMARY KEY);
            CREATE TABLE connection_sync_log (
                id INTEGER PRIMARY KEY, connection_id TEXT, started_at TEXT, mode TEXT, error TEXT,
                became_complete INTEGER, added INTEGER, updated INTEGER, removed INTEGER,
                account_counts TEXT, skipped_already_held INTEGER
            );
            INSERT INTO connection (id) VALUES ('failed'), ('attention'), ('incomplete'), ('ok'), ('never');
            INSERT INTO connection_sync_log
                (connection_id, started_at, mode, error, became_complete, added, updated, removed,
                 account_counts, skipped_already_held)
            VALUES
                ('failed',     '2026-08-01T10:00:00', 'incremental', 'bank timed out', 0, 0, 0, 0, NULL, 0),
                ('attention',  '2026-08-01T10:00:00', 'initial', NULL, 1, 4, 0, 0, NULL, 3),
                ('incomplete', '2026-08-01T10:00:00', 'initial', NULL, 0, 9, 0, 0, NULL, 0),
                ('ok',         '2026-07-01T10:00:00', 'incremental', 'an older failure', 0, 0, 0, 0, NULL, 0),
                ('ok',         '2026-08-01T10:00:00', 'incremental', NULL, 1, 2, 1, 0,
                 '{"acct-1": {"added": 2, "skipped_no_account": 5}}', 0);
        """)
        self._upgrade()

    def _summary(self, connection_id: str):
        row = self.conn.execute(
            "SELECT last_sync_outcome, last_sync_summary FROM connection WHERE id = ?", (connection_id,)
        ).fetchone()
        return row["last_sync_outcome"], json.loads(row["last_sync_summary"]) if row["last_sync_summary"] else None

    def test_each_outcome_is_read_from_the_newest_row(self):
        self.assertEqual(self._summary("failed")[0], "failed")
        self.assertEqual(self._summary("attention")[0], "attention")
        self.assertEqual(self._summary("incomplete")[0], "incomplete")
        outcome, summary = self._summary("ok")
        self.assertEqual(outcome, "ok", "an older failure must not outrank the newest row")
        self.assertEqual(
            (summary["at"], summary["mode"], summary["added"], summary["updated"], summary["removed"]),
            ("2026-08-01T10:00:00", "incremental", 2, 1, 0),
        )

    def test_the_pre_split_skip_key_is_folded_into_the_unknown_account_bucket(self):
        _, summary = self._summary("ok")
        self.assertEqual(summary["accounts"], {"acct-1": {"added": 2, "skipped_unknown_account": 5}})

    def test_a_connection_with_no_surviving_log_is_left_without_a_summary(self):
        self.assertEqual(self._summary("never"), (None, None))


class SplitPartsMayRepeatACategoryTests(MigrationCase):
    """v41 drops the index that forbade two parts of one split sharing a category."""

    def test_two_items_from_one_order_can_share_a_category_after_the_upgrade(self):
        self._database_at(40, """
            CREATE TABLE txn_split (id TEXT PRIMARY KEY, txn_id TEXT, category_id TEXT, amount REAL);
            CREATE UNIQUE INDEX idx_txn_split_txn_category ON txn_split(txn_id, category_id);
            INSERT INTO txn_split (id, txn_id, category_id, amount) VALUES ('p1', 't1', 'groceries', 12.5);
        """)
        self._upgrade()

        self.assertFalse(self._index_exists("idx_txn_split_txn_category"))
        self.conn.execute(
            "INSERT INTO txn_split (id, txn_id, category_id, amount) VALUES ('p2', 't1', 'groceries', 4.0)"
        )


class RecurringSeriesAmountModeTests(MigrationCase):
    """v46 gives every existing series the behavior it was detected under, and drops an inert index."""

    def test_existing_series_are_variable_with_no_pinned_band(self):
        self._database_at(45, """
            CREATE TABLE recurring_series (id TEXT PRIMARY KEY, name TEXT);
            INSERT INTO recurring_series (id, name) VALUES ('s1', 'Streaming'), ('s2', 'Water bill');
            CREATE TABLE recurring_membership_override (txn_id TEXT, series_id TEXT, state TEXT);
            CREATE UNIQUE INDEX idx_recurring_override_pin
                ON recurring_membership_override(txn_id) WHERE state = 'pinned';
        """)
        self._upgrade()

        rows = self.conn.execute(
            "SELECT amount_mode, expected_min, expected_max FROM recurring_series ORDER BY id"
        ).fetchall()
        self.assertEqual([tuple(row) for row in rows], [("variable", None, None), ("variable", None, None)])
        self.assertFalse(self._index_exists("idx_recurring_override_pin"))


class RetiredTransferDeclineTableTests(MigrationCase):
    """v52 removes a table only an unreleased v51 ever created."""

    def test_the_table_is_gone(self):
        self._database_at(51, "CREATE TABLE transfer_movement_declined (id TEXT PRIMARY KEY);")
        self._upgrade()
        self.assertIsNone(self.conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'transfer_movement_declined'"
        ).fetchone())


class TransfersGroupIdentityTests(MigrationCase):
    """v53 stamps the key on the group still found by name, and on nothing that merely shares the name."""

    def test_only_the_top_level_group_named_transfers_is_keyed(self):
        self._database_at(52, """
            CREATE TABLE category (id TEXT PRIMARY KEY, parent_id TEXT, name TEXT, system_key TEXT);
            INSERT INTO category (id, parent_id, name, system_key) VALUES
                ('group',    NULL,    'Transfers',   NULL),
                ('leaf',     'other', 'Transfers',   NULL),
                ('renamed',  NULL,    'Money moves', NULL),
                ('reimb',    NULL,    'Reimbursable', 'reimbursable');
        """)
        self._upgrade()

        keys = dict(self.conn.execute("SELECT id, system_key FROM category").fetchall())
        self.assertEqual(keys, {"group": "transfers", "leaf": None, "renamed": None, "reimb": "reimbursable"})


class LeafCategoryTypeAlignmentTests(MigrationCase):
    """v77 puts every leaf on its group's side, the property a group's total rests on.

    A leaf carrying the other side's type is selected by one expression and signed by another, so the
    group stops equalling the sum of its slices and no single bucket looks wrong. Enforced on every
    category write, and *not* by a restore — which is what an old database can get wrong.
    """

    def test_a_mismatched_leaf_takes_its_groups_side_and_the_rest_are_untouched(self):
        self._database_at(76, """
            CREATE TABLE category (
                id TEXT PRIMARY KEY, parent_id TEXT, name TEXT, category_type TEXT, is_active INTEGER
            );
            INSERT INTO category (id, parent_id, name, category_type, is_active) VALUES
                ('earnings',  NULL,       'Earnings',  'income',  1),
                ('salary',    'earnings', 'Salary',    'expense', 1),
                ('bonus',     'earnings', 'Bonus',     NULL,      1),
                ('retired',   'earnings', 'Old job',   'expense', 0),
                ('household', NULL,       'Household', 'expense', 1),
                ('groceries', 'household','Groceries', 'expense', 1),
                ('orphan',    NULL,       'Loose',     'income',  1);
        """)
        self._upgrade()

        types = dict(self.conn.execute("SELECT id, category_type FROM category").fetchall())
        # The mismatched leaf is corrected...
        self.assertEqual(types["salary"], "income")
        # ...including an inactive one, so a recovered category returns on its group's side.
        self.assertEqual(types["retired"], "income")
        # A leaf inheriting by NULL is given the type outright rather than left to COALESCE, which is
        # what makes the two resolvers agree without either of them having to.
        self.assertEqual(types["bonus"], "income")
        # A leaf that already agreed, and the groups themselves, are left exactly as they were.
        self.assertEqual(types["groceries"], "expense")
        self.assertEqual(types["earnings"], "income")
        self.assertEqual(types["household"], "expense")
        self.assertEqual(types["orphan"], "income")

    def test_the_step_is_safe_to_run_on_a_database_that_already_agrees(self):
        # It is registered in POST_RESTORE_DATA_INIT, so it runs against data that may already be right.
        self._database_at(76, """
            CREATE TABLE category (
                id TEXT PRIMARY KEY, parent_id TEXT, name TEXT, category_type TEXT, is_active INTEGER
            );
            INSERT INTO category (id, parent_id, name, category_type, is_active) VALUES
                ('household', NULL,        'Household', 'expense', 1),
                ('groceries', 'household', 'Groceries', 'expense', 1);
        """)
        self._upgrade()
        database._normalize_leaf_category_type(self.conn)

        types = dict(self.conn.execute("SELECT id, category_type FROM category").fetchall())
        self.assertEqual(types, {"household": "expense", "groceries": "expense"})


if __name__ == "__main__":
    unittest.main()
