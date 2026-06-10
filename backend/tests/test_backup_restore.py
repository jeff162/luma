"""
Backup/restore round-trip coverage for the full app state.

A restore wipes the data DB and rebuilds it from the backup payload, so its whole value is "does the
*entire* data graph survive a round trip". That makes a minimal hand-built fixture nearly useless
here — it only catches the shapes you happened to insert. So this fixture populates **every**
user-data table, including the awkward ones (a *merged* account = self-FK; an *imported* category
referencing a batch = forward-FK), and a schema-coverage guard fails if any data table in the DB
isn't carried by the backup. Together they force completeness instead of relying on remembering.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from fastapi import HTTPException

from backend.db.control_database import auth_required
from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.import_export.backup import RestoreRequest, build_backup_data, restore_backup

# Data-DB tables deliberately NOT in the regular backup (credentials/encryption config/schema meta).
EXCLUDED_TABLES = {"plaid_item", "backup_recipient", "db_meta"}

# Every other data-DB table maps to a backup payload section. A new table with no entry here fails
# the coverage guard, which is the point: it can't be silently left out of backups.
TABLE_TO_SECTION = {
    "owner": "owners",
    "account": "accounts",
    "category": "categories",
    "category_rule": "category_rules",
    "merchant_rename": "merchant_renames",
    "csv_import_profile": "csv_profiles",
    "import_batch": "import_batches",
    "import_batch_account": "import_batch_accounts",
    "import_batch_duplicate": "import_batch_duplicates",
    "import_workflow_state": "import_workflow_states",
    "txn": "transactions",
    "tag": "tags",
    "txn_tag": "txn_tags",
    "category_tag": "category_tags",
    "account_tag": "account_tags",
    "rule_tag": "rule_tags",
    "account_pair_distinct": "account_pair_distinct",
    "ui_preference": "ui_preferences",
}


class BackupRestoreTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "backup-tests.db"
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

    def _seed_complete(self) -> None:
        a1, a2 = str(uuid.uuid4()), str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                for acc in (a1, a2):
                    conn.execute(
                        """
                        INSERT INTO account (id, plaid_account_id, plaid_item_id, name, display_name, type, subtype, mask, owner_id, parent_account_id, trashed_at)
                        VALUES (?, ?, 'fixture', ?, ?, 'checking', 'checking', '1', ?, NULL, NULL)
                        """,
                        (acc, f"plaid_{acc}", f"Acct {acc[:4]}", f"Acct {acc[:4]}", SHARED_OWNER_ID),
                    )
                # Merge a1 (the lower rowid) under a2 → the backup dumps a child before its parent.
                conn.execute("UPDATE account SET parent_account_id = ? WHERE id = ?", (a2, a1))

                tag = str(uuid.uuid4())
                conn.execute("INSERT INTO tag (id, name, color, sort_order) VALUES (?, 'Joint', '#22c55e', 0)", (tag,))
                leaf = conn.execute("SELECT id FROM category WHERE parent_id IS NOT NULL LIMIT 1").fetchone()["id"]
                rule = conn.execute("SELECT id FROM category_rule LIMIT 1").fetchone()["id"]

                txn = str(uuid.uuid4())
                conn.execute(
                    "INSERT INTO txn (id, account_id, owner_id, category_id, amount, merchant_name, display_name, raw_name, date, is_pending, category_overridden) VALUES (?, ?, ?, ?, 10.0, 'M', 'M', 'M', '2026-04-15', 0, 0)",
                    (txn, a1, SHARED_OWNER_ID, leaf),
                )
                conn.execute("INSERT INTO txn_tag (txn_id, tag_id, rule_present, manual_state) VALUES (?, ?, 0, 1)", (txn, tag))
                conn.execute("INSERT INTO category_tag (category_id, tag_id) VALUES (?, ?)", (leaf, tag))
                conn.execute("INSERT INTO account_tag (account_id, tag_id) VALUES (?, ?)", (a2, tag))
                conn.execute("INSERT INTO rule_tag (rule_id, tag_id) VALUES (?, ?)", (rule, tag))
                low, high = sorted([a1, a2])
                conn.execute("INSERT INTO account_pair_distinct (account_id_low, account_id_high, asserted_at) VALUES (?, ?, '2026-04-15')", (low, high))
                conn.execute("INSERT INTO ui_preference (scope_id, pref_key, pref_value, updated_at) VALUES ('profile-1', 'ui.dashboard.tagReports', '[{\"id\":\"r1\"}]', '2026-04-15')")

                # Import history + an imported category that forward-references its batch.
                profile = str(uuid.uuid4())
                conn.execute("INSERT INTO csv_import_profile (id, name, account_id) VALUES (?, 'Fixture Source', ?)", (profile, a2))
                batch = str(uuid.uuid4())
                conn.execute("INSERT INTO import_batch (id, profile_id, filename) VALUES (?, ?, 'fixture.csv')", (batch, profile))
                conn.execute("INSERT INTO import_batch_account (batch_id, csv_value, account_id, row_count) VALUES (?, 'Checking', ?, 1)", (batch, a1))
                conn.execute("INSERT INTO import_batch_duplicate (batch_id, row_number, reason) VALUES (?, 1, 'exact')", (batch,))
                unassigned = conn.execute("SELECT id FROM category WHERE system_key = 'unassigned'").fetchone()["id"]
                conn.execute(
                    "INSERT INTO category (id, parent_id, name, sort_order, exclude_from_totals, import_source_batch_id, is_active) VALUES (?, ?, 'Imported Cat', 0, 0, ?, 1)",
                    (str(uuid.uuid4()), unassigned, batch),
                )
                conn.execute("INSERT INTO merchant_rename (id, raw_pattern, clean_name) VALUES (?, 'amzn mktp', 'Amazon')", (str(uuid.uuid4()),))
                conn.execute("INSERT INTO import_workflow_state (key, payload_json) VALUES ('imported_category_settings', '{}')")

    def _user_data_tables(self) -> set[str]:
        with self._use_db_path():
            with get_db() as conn:
                rows = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall()
        return {row["name"] for row in rows} - EXCLUDED_TABLES

    def _export_payload(self) -> dict:
        with self._use_db_path():
            with get_db() as conn:
                return build_backup_data(conn)

    def _counts(self, tables) -> dict[str, int]:
        with self._use_db_path():
            with get_db() as conn:
                return {t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in tables}

    def test_backup_covers_every_user_data_table(self):
        self._seed_complete()
        tables = self._user_data_tables()

        # Any data table not mapped to a backup section is a table that won't be backed up — fail
        # loudly so adding a table forces wiring it into build_backup_data/restore_backup.
        unmapped = tables - set(TABLE_TO_SECTION)
        self.assertEqual(unmapped, set(), f"data tables with no backup section (add to backup + TABLE_TO_SECTION): {unmapped}")

        payload = self._export_payload()
        counts = self._counts(tables)
        for table in sorted(tables):
            section = TABLE_TO_SECTION[table]
            self.assertGreater(counts[table], 0, f"fixture left {table} empty — the round trip isn't actually covering it")
            self.assertIn(section, payload, f"{table}: backup payload has no '{section}' section")
            self.assertEqual(len(payload[section]), counts[table], f"{table}: rows missing from the backup payload")

    def test_restore_round_trip_preserves_every_table(self):
        self._seed_complete()
        tables = self._user_data_tables()
        before = self._counts(tables)

        payload = self._export_payload()
        with self._use_db_path():
            restore_backup(RestoreRequest(data=payload))  # same instance → guard allows without force

        self.assertEqual(self._counts(tables), before)

    def test_restore_rejects_unsupported_version(self):
        with self._use_db_path():
            with self.assertRaises(HTTPException):
                restore_backup(RestoreRequest(data={"version": 5, "owners": []}))

    def test_guard_blocks_foreign_backup_over_existing_data(self):
        self._seed_complete()
        payload = self._export_payload()
        payload["instance_id"] = "some-other-system"
        with self._use_db_path():
            with self.assertRaises(HTTPException) as ctx:
                restore_backup(RestoreRequest(data=payload))
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertIn("different_system", ctx.exception.detail["reasons"])

    def test_guard_allows_foreign_backup_into_empty_target(self):
        # No _seed_complete(): a fresh DB has no accounts/transactions, so a foreign backup may load.
        payload = self._export_payload()
        payload["instance_id"] = "some-other-system"
        with self._use_db_path():
            result = restore_backup(RestoreRequest(data=payload))
        self.assertTrue(result["ok"])

    def test_guard_blocks_mode_mismatch(self):
        payload = self._export_payload()
        target_mode = "auth" if auth_required() else "local"
        payload["access_mode"] = "local" if target_mode == "auth" else "auth"
        with self._use_db_path():
            with self.assertRaises(HTTPException) as ctx:
                restore_backup(RestoreRequest(data=payload))
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertIn("mode_mismatch", ctx.exception.detail["reasons"])

    def test_force_overrides_guard(self):
        self._seed_complete()
        payload = self._export_payload()
        payload["instance_id"] = "some-other-system"
        with self._use_db_path():
            result = restore_backup(RestoreRequest(data=payload, force=True))
        self.assertTrue(result["ok"])


if __name__ == "__main__":
    unittest.main()
