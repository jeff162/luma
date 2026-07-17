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

from backend.db import control_database
from backend.db.control_database import auth_required
from backend.db.database import CURRENT_VERSION, SHARED_OWNER_ID, _seed_default_categories, get_db, get_db_instance_id, init_db, reset_current_db_path, set_current_db_path
from backend.routers.import_export.backup import (
    CONTENT_HASH_FIELD,
    RestoreRequest,
    _verify_payload_content_hash,
    build_backup_data,
    restore_backup,
)
from backend.routers.import_export.backup import _zip_json_bytes, _load_json_or_zip_payload
from backend.services.categorizer import seed_default_rules

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
    "amazon_charge_distinct": "amazon_charge_distinct",
    "ui_preference": "ui_preferences",
    "recurring_series": "recurring_series",
    "recurring_membership_override": "recurring_membership_overrides",
    "txn_link": "txn_links",
    "txn_link_member": "txn_link_members",
    "amazon_funding_map": "amazon_funding_map",
}


class BackupRestoreTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "backup-tests.db"
        init_db(str(self.db_path))
        # Isolate the control DB: the restore guard reads app_setting, so point it at a fresh temp
        # file and initialize it rather than falling back to whatever control DB sits in the CWD.
        self._orig_control_path = control_database.CONTROL_DB_PATH
        control_database.CONTROL_DB_PATH = str(Path(self.tempdir.name) / "control.db")
        control_database.init_control_db()

    def tearDown(self):
        control_database.CONTROL_DB_PATH = self._orig_control_path
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
                # Starter leaves + rules are opt-in now; this coverage fixture needs a leaf category and
                # a rule (and rule_tag) to populate, so seed the starter set explicitly.
                _seed_default_categories(conn, include_leaves=True)
                seed_default_rules(conn)
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
                # A second txn so the charge-level "not duplicates" pair table can hold a row.
                txn2 = str(uuid.uuid4())
                conn.execute(
                    "INSERT INTO txn (id, account_id, owner_id, category_id, amount, merchant_name, display_name, raw_name, date, is_pending, category_overridden) VALUES (?, ?, ?, ?, 10.0, 'M2', 'M2', 'M2', '2026-04-16', 0, 0)",
                    (txn2, a1, SHARED_OWNER_ID, leaf),
                )
                t_low, t_high = sorted([txn, txn2])
                conn.execute("INSERT INTO amazon_charge_distinct (txn_id_low, txn_id_high, asserted_at) VALUES (?, ?, '2026-04-16')", (t_low, t_high))
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

                # A recurring series + the txn membership link, so the round trip covers both the
                # recurring_series table and txn.recurring_series_id (a txn→recurring_series FK).
                series = str(uuid.uuid4())
                conn.execute(
                    "INSERT INTO recurring_series (id, payee_key, display_name, category_id, account_id, cadence, period_days, expected_amount, amount_min, amount_max, last_txn_date, next_due_date, occurrence_count, confidence, status, source, confirmed) "
                    "VALUES (?, 'm', 'M', ?, ?, 'monthly', 30, 10.0, 10.0, 10.0, '2026-04-15', '2026-05-15', 3, 0.9, 'active', 'auto', 1)",
                    (series, leaf, a2),
                )
                conn.execute("UPDATE txn SET recurring_series_id = ? WHERE id = ?", (series, txn))
                # A per-transaction membership override, so the round trip covers the pin/exclude table.
                conn.execute(
                    "INSERT INTO recurring_membership_override (txn_id, series_id, state) VALUES (?, ?, 'pinned')",
                    (txn, series),
                )

                # A typed transaction link (an Amazon-style charge↔item association) plus a second txn
                # to be its 'charge' member, so the round trip covers txn_link + txn_link_member.
                charge = str(uuid.uuid4())
                conn.execute(
                    "INSERT INTO txn (id, account_id, owner_id, category_id, amount, merchant_name, display_name, raw_name, date, is_pending, category_overridden) VALUES (?, ?, ?, ?, 37.32, 'AMAZON.COM', 'AMAZON.COM', 'AMAZON.COM', '2026-04-15', 0, 0)",
                    (charge, a1, SHARED_OWNER_ID, leaf),
                )
                link = str(uuid.uuid4())
                conn.execute(
                    "INSERT INTO txn_link (id, kind, external_ref, metadata_json) VALUES (?, 'amazon_order', 'ORD-1', '{\"prior_category_id\": null}')",
                    (link,),
                )
                conn.execute("INSERT INTO txn_link_member (link_id, txn_id, role) VALUES (?, ?, 'charge')", (link, charge))
                conn.execute("INSERT INTO txn_link_member (link_id, txn_id, role) VALUES (?, ?, 'item')", (link, txn))

                # An Amazon funding-source → account mapping (a global instrument → funding account), so
                # the round trip covers amazon_funding_map (a table with two FKs to account).
                conn.execute(
                    "INSERT INTO amazon_funding_map (id, last4, network, amazon_account_id, funding_account_id) VALUES (?, '4455', 'Fablecard', NULL, ?)",
                    (str(uuid.uuid4()), a1),
                )

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

    def test_restore_tolerates_since_removed_column(self):
        # A backup taken before a column was dropped (the real case: category_rule.priority, removed
        # once rule ordering became automatic) still carries that column in its payload. Restore must
        # skip the column the live schema no longer has rather than failing with "no column named …".
        self._seed_complete()
        tables = self._user_data_tables()
        before = self._counts(tables)

        payload = self._export_payload()
        self.assertTrue(payload["category_rules"], "fixture must include at least one rule")
        for rule in payload["category_rules"]:
            rule["priority"] = 5  # a column the current category_rule table does not define
        payload.pop(CONTENT_HASH_FIELD, None)  # a backup old enough to carry priority predates the hash

        with self._use_db_path():
            restore_backup(RestoreRequest(data=payload))  # must not raise OperationalError

        self.assertEqual(self._counts(tables), before)

    def test_restore_rejects_unsupported_version(self):
        with self._use_db_path():
            with self.assertRaises(HTTPException):
                restore_backup(RestoreRequest(data={"version": 5, "owners": []}))

    def test_backup_stamps_content_hash(self):
        self._seed_complete()
        payload = self._export_payload()
        self.assertIn(CONTENT_HASH_FIELD, payload)
        self.assertEqual(len(payload[CONTENT_HASH_FIELD]), 64)  # sha256 hex

    def test_content_hash_survives_real_file_round_trip(self):
        # The hash must be computed over a serialization that round-trips identically through the
        # actual export → zip → json.loads path (float reprs, key order, unicode), or every restore
        # would false-positive. Exercise that real path rather than hashing the in-memory dict twice.
        self._seed_complete()
        payload = self._export_payload()
        reloaded = _load_json_or_zip_payload(
            _zip_json_bytes("luma_backup.json", payload), "luma_backup.json.zip", "backup"
        )
        _verify_payload_content_hash(reloaded)  # must not raise
        with self._use_db_path():
            self.assertTrue(restore_backup(RestoreRequest(data=reloaded))["ok"])

    def test_restore_rejects_tampered_payload(self):
        # A content edit with the hash left intact is exactly the accidental-corruption case the hash
        # exists to catch: restore must refuse before touching the target.
        self._seed_complete()
        tables = self._user_data_tables()
        before = self._counts(tables)
        payload = self._export_payload()
        self.assertTrue(payload["owners"], "fixture must include an owner to tamper with")
        payload["owners"][0]["name"] = payload["owners"][0]["name"] + " (tampered)"
        with self._use_db_path():
            with self.assertRaises(HTTPException) as ctx:
                restore_backup(RestoreRequest(data=payload))
        self.assertEqual(ctx.exception.status_code, 400)
        # Refused before the wipe — the target is untouched.
        self.assertEqual(self._counts(tables), before)

    def test_backup_stamps_schema_version(self):
        self._seed_complete()
        payload = self._export_payload()
        self.assertEqual(payload["schema_version"], CURRENT_VERSION)

    def test_guard_blocks_backup_from_newer_schema(self):
        # A backup made by a future build (higher schema level) can carry columns this build would
        # silently drop on restore, so the guard must refuse it without force.
        self._seed_complete()
        payload = self._export_payload()
        payload["schema_version"] = CURRENT_VERSION + 1
        payload.pop(CONTENT_HASH_FIELD, None)  # not under test here; drop so the optional hash check no-ops
        with self._use_db_path():
            with self.assertRaises(HTTPException) as ctx:
                restore_backup(RestoreRequest(data=payload))
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertIn("newer_schema", ctx.exception.detail["reasons"])
        # Force is the explicit escape hatch (the user accepts the lossy downgrade).
        with self._use_db_path():
            self.assertTrue(restore_backup(RestoreRequest(data=payload, force=True))["ok"])

    def test_older_or_absent_schema_version_restores_without_force(self):
        # An older backup (lower level) and a pre-schema_version backup (field absent) are both safe:
        # columns this build has since added just take their defaults. Neither trips the guard.
        self._seed_complete()
        tables = self._user_data_tables()
        before = self._counts(tables)
        for mutate in (lambda p: p.update(schema_version=max(0, CURRENT_VERSION - 1)),
                       lambda p: p.pop("schema_version", None)):
            payload = self._export_payload()
            mutate(payload)
            payload.pop(CONTENT_HASH_FIELD, None)
            with self._use_db_path():
                restore_backup(RestoreRequest(data=payload))
            self.assertEqual(self._counts(tables), before)

    def test_guard_blocks_foreign_backup_over_existing_data(self):
        self._seed_complete()
        payload = self._export_payload()
        payload["instance_id"] = "some-other-system"
        payload.pop(CONTENT_HASH_FIELD, None)
        with self._use_db_path():
            with self.assertRaises(HTTPException) as ctx:
                restore_backup(RestoreRequest(data=payload))
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertIn("different_system", ctx.exception.detail["reasons"])

    def test_guard_allows_foreign_backup_into_empty_target(self):
        # No _seed_complete(): a fresh DB has no accounts/transactions, so a foreign backup may load.
        payload = self._export_payload()
        payload["instance_id"] = "some-other-system"
        payload.pop(CONTENT_HASH_FIELD, None)
        with self._use_db_path():
            result = restore_backup(RestoreRequest(data=payload))
        self.assertTrue(result["ok"])

    def test_guard_blocks_mode_mismatch(self):
        payload = self._export_payload()
        target_mode = "auth" if auth_required() else "local"
        payload["access_mode"] = "local" if target_mode == "auth" else "auth"
        payload.pop(CONTENT_HASH_FIELD, None)
        with self._use_db_path():
            with self.assertRaises(HTTPException) as ctx:
                restore_backup(RestoreRequest(data=payload))
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertIn("mode_mismatch", ctx.exception.detail["reasons"])

    def test_force_overrides_guard(self):
        self._seed_complete()
        payload = self._export_payload()
        payload["instance_id"] = "some-other-system"
        payload.pop(CONTENT_HASH_FIELD, None)
        with self._use_db_path():
            result = restore_backup(RestoreRequest(data=payload, force=True))
        self.assertTrue(result["ok"])

    def test_restore_adopts_backup_instance_id(self):
        # A full restore replaces the data, so afterward the DB *is* the backup's system and takes on
        # its instance_id. This is what stops a re-restore of the same backup (now over the data it
        # itself produced) from reading as "a different system" — the fresh-DB-then-restore-again case.
        self._seed_complete()
        payload = self._export_payload()
        payload["instance_id"] = "backup-origin-system"
        payload.pop(CONTENT_HASH_FIELD, None)
        with self._use_db_path():
            restore_backup(RestoreRequest(data=payload, force=True))  # force: target had its own data
            with get_db() as conn:
                self.assertEqual(get_db_instance_id(conn), "backup-origin-system")
            # The same backup now restores again WITHOUT force: it is recognized as this system's own.
            result = restore_backup(RestoreRequest(data=payload))
        self.assertTrue(result["ok"])


if __name__ == "__main__":
    unittest.main()
