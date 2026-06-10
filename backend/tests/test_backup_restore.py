"""
Backup/restore round-trip coverage for the full app state.

A restore wipes the database and rebuilds it from the backup payload, so anything the export omits
is silently lost on restore. The tag system (tag + txn_tag/category_tag/account_tag/rule_tag) and
the account-pair distinct assertions were previously absent — this pins that a backup→restore cycle
preserves them, with FK-safe ordering, so the gap can't reopen.
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

    def _seed(self) -> dict:
        ids = {"a1": str(uuid.uuid4()), "a2": str(uuid.uuid4()), "tag": str(uuid.uuid4()), "txn": str(uuid.uuid4())}
        with self._use_db_path():
            with get_db() as conn:
                for acc in (ids["a1"], ids["a2"]):
                    conn.execute(
                        """
                        INSERT INTO account (id, plaid_account_id, plaid_item_id, name, display_name, type, subtype, mask, owner_id, parent_account_id, trashed_at)
                        VALUES (?, ?, 'fixture', ?, ?, 'checking', 'checking', '1', ?, NULL, NULL)
                        """,
                        (acc, f"plaid_{acc}", f"Acct {acc[:4]}", f"Acct {acc[:4]}", SHARED_OWNER_ID),
                    )
                conn.execute("INSERT INTO tag (id, name, color, sort_order) VALUES (?, 'Joint', '#22c55e', 0)", (ids["tag"],))
                ids["leaf"] = conn.execute("SELECT id FROM category WHERE parent_id IS NOT NULL LIMIT 1").fetchone()["id"]
                ids["rule"] = conn.execute("SELECT id FROM category_rule LIMIT 1").fetchone()["id"]
                conn.execute(
                    """
                    INSERT INTO txn (id, account_id, owner_id, category_id, amount, merchant_name, display_name, raw_name, date, is_pending, category_overridden)
                    VALUES (?, ?, ?, NULL, 10.0, 'M', 'M', 'M', '2026-04-15', 0, 0)
                    """,
                    (ids["txn"], ids["a1"], SHARED_OWNER_ID),
                )
                conn.execute("INSERT INTO txn_tag (txn_id, tag_id, rule_present, manual_state) VALUES (?, ?, 0, 1)", (ids["txn"], ids["tag"]))
                conn.execute("INSERT INTO category_tag (category_id, tag_id) VALUES (?, ?)", (ids["leaf"], ids["tag"]))
                conn.execute("INSERT INTO account_tag (account_id, tag_id) VALUES (?, ?)", (ids["a1"], ids["tag"]))
                conn.execute("INSERT INTO rule_tag (rule_id, tag_id) VALUES (?, ?)", (ids["rule"], ids["tag"]))
                low, high = sorted([ids["a1"], ids["a2"]])
                conn.execute("INSERT INTO account_pair_distinct (account_id_low, account_id_high, asserted_at) VALUES (?, ?, '2026-04-15')", (low, high))
                conn.execute(
                    "INSERT INTO ui_preference (scope_id, pref_key, pref_value, updated_at) VALUES ('profile-1', 'ui.dashboard.tagReports', '[{\"id\":\"r1\"}]', '2026-04-15')"
                )
        return ids

    def _export_payload(self) -> dict:
        with self._use_db_path():
            with get_db() as conn:
                return build_backup_data(conn)

    def _count(self, table: str) -> int:
        with self._use_db_path():
            with get_db() as conn:
                return conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]

    def test_export_includes_tag_system_and_pairs(self):
        self._seed()
        payload = self._export_payload()
        self.assertEqual(payload["version"], 7)
        for section in ("tags", "txn_tags", "category_tags", "account_tags", "rule_tags", "account_pair_distinct", "ui_preferences"):
            self.assertEqual(len(payload[section]), 1, f"export should carry one {section} row")

    def test_restore_round_trip_preserves_tag_system_and_pairs(self):
        self._seed()
        payload = self._export_payload()

        # Restore wipes and rebuilds from the payload; the tag system must survive the round trip.
        with self._use_db_path():
            result = restore_backup(RestoreRequest(data=payload))

        for table in ("tag", "txn_tag", "category_tag", "account_tag", "rule_tag", "account_pair_distinct", "ui_preference"):
            self.assertEqual(self._count(table), 1, f"{table} should be restored")
        self.assertEqual(result["restored_counts"]["tags"], 1)
        self.assertEqual(result["restored_counts"]["ui_preferences"], 1)

    def test_restore_rejects_unsupported_version(self):
        with self._use_db_path():
            with self.assertRaises(HTTPException):
                restore_backup(RestoreRequest(data={"version": 5, "owners": []}))

    def test_guard_blocks_foreign_backup_over_existing_data(self):
        self._seed()
        payload = self._export_payload()
        payload["instance_id"] = "some-other-system"  # pretend the backup came from a different system
        with self._use_db_path():
            with self.assertRaises(HTTPException) as ctx:
                restore_backup(RestoreRequest(data=payload))
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertIn("different_system", ctx.exception.detail["reasons"])

    def test_guard_allows_foreign_backup_into_empty_target(self):
        # No _seed(): a fresh DB has no accounts/transactions, so a foreign backup may load freely.
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
        self._seed()
        payload = self._export_payload()
        payload["instance_id"] = "some-other-system"
        with self._use_db_path():
            result = restore_backup(RestoreRequest(data=payload, force=True))
        self.assertTrue(result["ok"])


if __name__ == "__main__":
    unittest.main()
