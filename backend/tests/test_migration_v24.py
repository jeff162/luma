"""
Migration v24 — the per-connection account mapping, run against a v23 database.

The interesting half is the backfill, not the ALTERs. A connection linked months ago has accounts that
already ARE its provider accounts; without a `connection_account` row saying so, the mapping UI would show
every one of them as undecided and the dedupe ladder would treat none of them as an alias — so the feature
would arrive switched off for exactly the ledger it was built for. The `csv_value` rewrite is the same
story one level down: sync cards keyed on the provider's opaque external account id are invisible to every
source-scoped rule.

These drive `run_migrations` on a database stamped at 23, rather than asserting on a fresh one, because a
fresh install gets all of this from the baseline schema and would prove nothing.
"""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from backend.db import database
from backend.services.duplicate_detection import DEFAULT_TERMINAL_WINDOW_DAYS


def _columns(conn, table):
    return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}


class MigrationV24Tests(unittest.TestCase):
    """A v23-shaped database, migrated in place."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = str(Path(self.tmp.name) / "v23.db")
        self.conn = sqlite3.connect(self.path)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript("""
            CREATE TABLE connection (
                id TEXT PRIMARY KEY, provider TEXT, external_id TEXT, institution TEXT,
                credential TEXT, transactions_cursor TEXT, initial_sync_complete INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE account (
                id TEXT PRIMARY KEY, name TEXT, display_name TEXT, type TEXT, subtype TEXT, mask TEXT,
                owner_id TEXT, parent_account_id TEXT, trashed_at TEXT,
                external_account_id TEXT UNIQUE, connection_id TEXT, provider TEXT
            );
            CREATE TABLE txn (
                id TEXT PRIMARY KEY, account_id TEXT, date TEXT, amount REAL, import_batch_id TEXT
            );
            CREATE TABLE csv_import_profile (id TEXT PRIMARY KEY, name TEXT, column_map TEXT);
            CREATE TABLE import_batch (
                id TEXT PRIMARY KEY, filename TEXT, status TEXT, connection_id TEXT, profile_id TEXT
            );
            CREATE TABLE import_batch_account (
                batch_id TEXT NOT NULL, csv_value TEXT NOT NULL, account_id TEXT,
                row_count INTEGER NOT NULL DEFAULT 0, was_skipped INTEGER NOT NULL DEFAULT 0,
                coverage_start_date TEXT, coverage_end_date TEXT, terminal_date TEXT,
                PRIMARY KEY (batch_id, csv_value)
            );
            CREATE TABLE db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO db_meta (key, value) VALUES ('version', '23');

            INSERT INTO connection (id, provider, external_id, institution)
              VALUES ('conn-1', 'plaid', 'item-1', 'Northgate');
            INSERT INTO account (id, name, display_name, type, mask, external_account_id, connection_id, provider)
              VALUES ('acct-card', 'CREDIT CARD', 'CREDIT CARD', 'credit', '4103', 'ext-card', 'conn-1', 'plaid');
            INSERT INTO account (id, name, display_name, type, provider)
              VALUES ('acct-csv', 'Monarch Checking', 'Monarch Checking', 'depository', 'csv');
            INSERT INTO import_batch (id, filename, status, connection_id)
              VALUES ('card-1', 'Northgate · July 2026', 'completed', 'conn-1');
            INSERT INTO import_batch_account (batch_id, csv_value, account_id, row_count)
              VALUES ('card-1', 'ext-card', 'acct-card', 12);
        """)
        # The table the migration expects init_db's baseline script to have created on both paths.
        self.conn.executescript("""
            CREATE TABLE IF NOT EXISTS connection_account (
                connection_id TEXT NOT NULL, external_account_id TEXT NOT NULL,
                account_id TEXT, mapping_mode TEXT, target_account_id TEXT,
                provider_name TEXT, provider_official_name TEXT, provider_type TEXT,
                provider_subtype TEXT, provider_mask TEXT,
                coverage_start_date TEXT, coverage_through_date TEXT,
                terminal_window_days INTEGER NOT NULL DEFAULT 7,
                created_at TEXT, updated_at TEXT,
                PRIMARY KEY (connection_id, external_account_id)
            );
        """)
        self.conn.commit()

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def _migrate(self):
        database.run_migrations(self.conn)
        self.conn.commit()

    # ---- the schema half -----------------------------------------------

    def test_it_adds_the_columns_an_existing_database_lacks(self):
        self._migrate()
        self.assertIn("captured_fields", _columns(self.conn, "connection"))
        # v59 renamed it once `date` became the transaction date.
        self.assertIn("posted_date", _columns(self.conn, "txn"))
        self.assertIn("terminal_window_days", _columns(self.conn, "csv_import_profile"))
        self.assertEqual(database.get_db_version(self.conn), database.CURRENT_VERSION)

    def test_a_source_that_never_stated_a_lag_ends_up_assuming_one(self):
        # v24 adds the column, v25 settles what its default means (see test_migration_v25). Asserted on
        # the end state rather than v24 alone, because a database that stopped between the two would be
        # the only one in existence and the pair is meant to land in one place.
        self._migrate()
        self.conn.execute("INSERT INTO csv_import_profile (id, name, column_map) VALUES ('p1','Monarch','{}')")
        self.assertEqual(self.conn.execute(
            "SELECT terminal_window_days AS w FROM csv_import_profile WHERE id = 'p1'"
        ).fetchone()["w"], DEFAULT_TERMINAL_WINDOW_DAYS)

    # ---- the backfill --------------------------------------------------

    def test_an_already_linked_account_is_recorded_as_mapped(self):
        # Records what is already true. Otherwise a long-standing connection arrives looking wholly
        # unmapped and none of its accounts count as an alias.
        self._migrate()
        row = self.conn.execute(
            "SELECT * FROM connection_account WHERE connection_id = 'conn-1' AND external_account_id = 'ext-card'"
        ).fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(row["mapping_mode"], "existing")
        self.assertEqual(row["account_id"], "acct-card")
        self.assertEqual(row["target_account_id"], "acct-card",
                         "'existing' compares against the account itself")
        self.assertEqual(row["provider_name"], "CREDIT CARD")
        self.assertEqual(row["provider_mask"], "4103")

    def test_an_unconnected_account_gets_no_mapping_row(self):
        self._migrate()
        self.assertEqual(self.conn.execute(
            "SELECT COUNT(*) AS n FROM connection_account"
        ).fetchone()["n"], 1)

    def test_sync_card_source_values_become_provider_labels(self):
        # The opaque id is invisible to every source-scoped rule and reads as noise in the history.
        self._migrate()
        self.assertEqual(self.conn.execute(
            "SELECT csv_value FROM import_batch_account WHERE batch_id = 'card-1'"
        ).fetchone()["csv_value"], "CREDIT CARD ···4103")

    def test_a_csv_batchs_source_value_is_untouched(self):
        self.conn.executescript("""
            INSERT INTO import_batch (id, filename, status) VALUES ('b-csv','Monarch.csv','completed');
            INSERT INTO import_batch_account (batch_id, csv_value, account_id, row_count)
              VALUES ('b-csv','Checking','acct-csv',40);
        """)
        self._migrate()
        self.assertEqual(self.conn.execute(
            "SELECT csv_value FROM import_batch_account WHERE batch_id = 'b-csv'"
        ).fetchone()["csv_value"], "Checking")

    def test_a_rewrite_that_would_collide_drops_the_opaque_row_instead_of_failing(self):
        # csv_value is half the primary key, so a card that already has a labelled row (a sync after the
        # feature landed, on a card that predates it) would trip the constraint. The labelled row wins and
        # the opaque one goes, rather than the whole migration aborting.
        self.conn.execute(
            "INSERT INTO import_batch_account (batch_id, csv_value, account_id, row_count)"
            " VALUES ('card-1', 'CREDIT CARD ···4103', 'acct-card', 5)"
        )
        self._migrate()
        rows = self.conn.execute(
            "SELECT csv_value, row_count FROM import_batch_account WHERE batch_id = 'card-1'"
        ).fetchall()
        self.assertEqual([r["csv_value"] for r in rows], ["CREDIT CARD ···4103"])
        self.assertEqual(rows[0]["row_count"], 5)

    def test_an_account_with_neither_name_nor_mask_keeps_its_opaque_value(self):
        # Nothing better to call it than the id it already has — a blank label would collide with any
        # other unnamed source and silently merge two sources' coverage.
        self.conn.executescript("""
            INSERT INTO account (id, name, display_name, external_account_id, connection_id, provider)
              VALUES ('acct-bare', '', '', 'ext-bare', 'conn-1', 'plaid');
            INSERT INTO import_batch_account (batch_id, csv_value, account_id, row_count)
              VALUES ('card-1', 'ext-bare', 'acct-bare', 3);
        """)
        self._migrate()
        self.assertIn("ext-bare", {r["csv_value"] for r in self.conn.execute(
            "SELECT csv_value FROM import_batch_account WHERE batch_id = 'card-1'"
        ).fetchall()})

    def test_it_is_safe_to_run_twice(self):
        self._migrate()
        database.run_migrations(self.conn)  # no-op: already at CURRENT_VERSION
        self.assertEqual(self.conn.execute(
            "SELECT COUNT(*) AS n FROM connection_account"
        ).fetchone()["n"], 1)

    def test_coverage_is_not_seeded(self):
        # Deliberate: coverage can only be derived from the ledger, and a connection with a hole in its
        # history would claim a range it does not cover and hard-reject legitimate rows inside it. That
        # derivation is an inspect-before-applying step, not a migration.
        self._migrate()
        row = self.conn.execute("SELECT * FROM connection_account").fetchone()
        self.assertIsNone(row["coverage_start_date"])
        self.assertIsNone(row["coverage_through_date"])


if __name__ == "__main__":
    unittest.main()
