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

import asyncio
import hashlib
import io
import json
import tempfile
import unittest
import uuid
import zipfile
from contextlib import contextmanager
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import HTTPException, UploadFile

from backend.db import control_database
from backend.db.control_database import auth_required
from backend.db.database import CURRENT_VERSION, SHARED_OWNER_ID, _seed_default_categories, get_db, get_db_instance_id, init_db, reset_current_db_path, set_current_db_path
from backend.routers.import_export.backup import (
    BACKUP_PAYLOAD_VERSION,
    BackupKeypairRequest,
    BackupRecipientCreate,
    BackupRecipientUpdate,
    BACKUP_SECTION_NAMES,
    CONTENT_HASH_FIELD,
    RestoreRequest,
    _b64url_decode,
    _stamp_content_hash,
    _verify_payload_content_hash,
    build_backup_data,
    create_backup_recipient,
    export_backup,
    generate_backup_keypair,
    inspect_backup_file,
    restore_backup,
    restore_backup_file,
    restore_credentials_file,
    restore_from_archive,
    router,
    update_backup_recipient,
    write_backup_archive,
)
from backend.routers.import_export.backup import _zip_json_bytes, read_payload_bytes
from backend.services.documents import document_file_path, write_document_file
from backend.services.categorizer import seed_default_rules

# Data-DB tables deliberately NOT in the regular backup (credentials/encryption config/schema meta).
# `connection` (per-bank credentials), its legacy predecessor `plaid_item`, and `provider_config`
# (app-level provider credentials) hold vault-encrypted secrets, which ride the separate credentials
# backup (export/restore_credentials), not the regular data backup. `connection_sync_log` is the
# provider-sync diagnostic log (developer-options surface) tied to `connection` (also excluded): operational
# diagnostics, not part of the financial dataset a backup preserves, and pointless to restore against
# connections the data backup never carries.
EXCLUDED_TABLES = {"plaid_item", "connection", "connection_sync_log", "provider_config", "backup_recipient", "db_meta"}
# The document text index and the shadow tables FTS5 keeps beside it. Derived state, not data: every
# term in it comes from `document.text`, which the backup *does* carry, and the triggers rebuild the
# index as those rows stream back in. Backing it up would ship a second copy of the same text and a
# second thing that could disagree with the first.
EXCLUDED_TABLES |= {"document_fts", "document_fts_data", "document_fts_idx", "document_fts_docsize",
                    "document_fts_config", "document_fts_content"}
# Machine-local operational state: where *this* install got to in a restore. It must never travel to
# another install — carrying it would tell the target it has a restore outstanding against an artifact
# path that does not exist there. Being outside the wipe list is also what keeps it alive across the very
# operation it tracks.
EXCLUDED_TABLES |= {"restore_state"}

# Every other data-DB table maps to a backup payload section. A new table with no entry here fails
# the coverage guard, which is the point: it can't be silently left out of backups.
TABLE_TO_SECTION = {
    "owner": "owners",
    "account": "accounts",
    "category": "categories",
    "category_rule": "category_rules",
    "merchant_rename": "merchant_renames",
    "csv_import_profile": "csv_profiles",
    "connection_account": "connection_accounts",
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
    "suspect_pair_distinct": "suspect_pair_distinct",
    "amazon_charge_reviewed": "amazon_charge_reviewed",
    "amazon_pending_item": "amazon_pending_items",
    "ui_preference": "ui_preferences",
    "recurring_series": "recurring_series",
    "recurring_membership_override": "recurring_membership_overrides",
    "recurring_signal_dismissal": "recurring_signal_dismissals",
    "transfer_pair_decision": "transfer_pair_decisions",
    "rule_overlap_dismissal": "rule_overlap_dismissals",
    "txn_link": "txn_links",
    "txn_link_member": "txn_link_members",
    "amazon_funding_map": "amazon_funding_map",
    "txn_split": "txn_splits",
    "document": "documents",
}


class BackupFixtureTestCase(unittest.TestCase):
    """The complete-coverage fixture and the plumbing to point every helper at it. Split from the
    tests themselves so the three suites below share one fixture without re-running each other."""

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
                        INSERT INTO account (id, external_account_id, provider, name, display_name, type, subtype, mask, owner_id, parent_account_id, trashed_at)
                        VALUES (?, ?, 'fixture', ?, ?, 'checking', 'checking', '1', ?, NULL, NULL)
                        """,
                        (acc, f"plaid_{acc}", f"Acct {acc[:4]}", f"Acct {acc[:4]}", SHARED_OWNER_ID),
                    )
                # Merge a1 (the lower rowid) under a2 → the backup dumps a child before its parent.
                conn.execute("UPDATE account SET parent_account_id = ? WHERE id = ?", (a2, a1))

                # A connection + its account mapping. The connection itself rides the *credentials*
                # backup (it holds the secret) and is never wiped by a data restore, so it is seeded
                # here only as the FK parent; connection_account rides this data backup, carrying the
                # mapping and the connection's coverage claim. Both target columns are populated so the
                # restore-side reconciliation is exercised on a real value rather than a NULL.
                conn.execute(
                    "INSERT INTO connection (id, provider, external_id, institution) VALUES ('fixture-conn', 'plaid', 'item-fixture', 'Fixture Bank')"
                )
                conn.execute(
                    """
                    INSERT INTO connection_account
                        (connection_id, external_account_id, account_id, mapping_mode, target_account_id,
                         provider_name, provider_official_name, provider_type, provider_subtype, provider_mask,
                         coverage_start_date, coverage_through_date, terminal_window_days)
                    VALUES ('fixture-conn', 'ext-fixture', ?, 'existing', ?, 'CHECKING', 'Total Checking',
                            'depository', 'checking', '1111', '2025-01-01', '2026-04-15', 7)
                    """,
                    (a2, a2),
                )

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
                # A "these two rows are not the same charge" judgement, so the round trip covers
                # suspect_pair_distinct (references txn twice, like the row above).
                conn.execute("INSERT INTO suspect_pair_distinct (txn_id_low, txn_id_high, asserted_at) VALUES (?, ?, '2026-04-16')", (t_low, t_high))
                # A reconciliation reverse-scan "Mark reviewed" acknowledgment, so the round trip covers
                # amazon_charge_reviewed (references txn).
                conn.execute("INSERT INTO amazon_charge_reviewed (txn_id, reviewed_at) VALUES (?, '2026-04-16')", (txn2,))
                conn.execute("INSERT INTO ui_preference (scope_id, pref_key, pref_value, updated_at) VALUES ('profile-1', 'ui.dashboard.tagReports', '[{\"id\":\"r1\"}]', '2026-04-15')")

                # Import history + an imported category that forward-references its batch.
                profile = str(uuid.uuid4())
                conn.execute("INSERT INTO csv_import_profile (id, name, account_id) VALUES (?, 'Fixture Source', ?)", (profile, a2))
                batch = str(uuid.uuid4())
                conn.execute("INSERT INTO import_batch (id, profile_id, filename) VALUES (?, ?, 'fixture.csv')", (batch, profile))
                conn.execute("INSERT INTO import_batch_account (batch_id, csv_value, account_id, row_count) VALUES (?, 'Checking', ?, 1)", (batch, a1))
                # Amazon items parked awaiting their orders file, tied to this batch — so the round trip
                # covers amazon_pending_item (references import_batch via parked_batch_id).
                conn.execute(
                    "INSERT INTO amazon_pending_item (order_id, items_json, source_file, source_file_hash, parked_batch_id) VALUES ('111-9', '[{\"description\":\"Air Widget\",\"asin\":\"B0AAA\"}]', 'items.csv', 'H-ITEMS', ?)",
                    (batch,),
                )
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
                # A dismissed anomaly signal. Its key is a fingerprint, not a row id (the signals
                # themselves are derived), so this is the only durable state that side has to carry.
                conn.execute(
                    "INSERT INTO recurring_signal_dismissal (signal_key, kind, dismissed_at) "
                    "VALUES (?, 'price_change', '2026-04-16T09:00:00')",
                    (f"price_change:{txn}",),
                )
                # The user's answer to an ambiguous pairing. Same story again: the question is
                # re-derived from the ledger on every scan, so the answer is the only durable state —
                # and a restore that lost it would re-ask what the user had already settled.
                conn.execute(
                    "INSERT INTO transfer_pair_decision (paying_txn_id, receiving_txn_id) VALUES (?, NULL)",
                    (txn,),
                )
                # An acknowledged rule-overlap finding — same story on the rules side: the findings are
                # recomputed from the rules every run, so the dismissal is all there is to carry.
                conn.execute(
                    "INSERT INTO rule_overlap_dismissal (finding_key, kind, dismissed_at) "
                    "VALUES ('matcher_nesting:r1:r2:r', 'matcher_nesting', '2026-04-16T09:00:00')"
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

                # A split transaction with its allocations, so the round trip covers txn_split *and* the
                # txn.is_split flag that tells the reporting expansion the parts exist. A split whose
                # flag survived without its parts (or the reverse) is the failure worth pinning: both
                # halves restore or the money silently leaves every category total.
                second_leaf = str(uuid.uuid4())
                conn.execute(
                    "INSERT INTO category (id, name, parent_id, category_type) "
                    "SELECT ?, 'Split Sibling', parent_id, category_type FROM category WHERE id = ?",
                    (second_leaf, leaf),
                )
                conn.execute("UPDATE txn SET is_split = 1, category_source = 'split', category_overridden = 1 WHERE id = ?", (charge,))
                conn.execute(
                    "INSERT INTO txn_split (id, txn_id, category_id, amount, sort_order, label) "
                    "VALUES (?, ?, ?, 20.00, 0, 'Air Widget')",
                    (str(uuid.uuid4()), charge, leaf),
                )
                # One labelled part and one without, so the round trip covers both states of the column
                # rather than only the populated one.
                conn.execute(
                    "INSERT INTO txn_split (id, txn_id, category_id, amount, sort_order, label) "
                    "VALUES (?, ?, ?, 17.32, 1, NULL)",
                    (str(uuid.uuid4()), charge, second_leaf),
                )

                # Attached documents. Two, deliberately: one with its file present, which must come back
                # byte-identical, and one whose file is *missing*, because file-and-row drift is possible
                # by construction here — the store writes the file before the row and nothing stops the
                # file being deleted underneath it. A backup that refused to export over one unreadable
                # receipt would withhold the entire ledger, so the row has to ride without its member.
                self.document_bytes = b"%PDF-1.4\nfixture invoice\n%%EOF\n"
                self.present_document = str(uuid.uuid4())
                self.absent_document = str(uuid.uuid4())
                write_document_file(self.present_document, self.document_bytes)
                conn.execute(
                    "INSERT INTO document (id, txn_id, filename, mime_type, byte_size, sha256, created_at, text, text_source) "
                    "VALUES (?, ?, 'repair-invoice.pdf', 'application/pdf', ?, ?, '2026-04-16T10:00:00Z', "
                    "'Replaced front brake pads', 'pdf_text')",
                    (self.present_document, charge, len(self.document_bytes),
                     hashlib.sha256(self.document_bytes).hexdigest()),
                )
                conn.execute(
                    "INSERT INTO document (id, txn_id, filename, mime_type, byte_size, sha256, created_at) "
                    "VALUES (?, ?, 'lost-receipt.jpg', 'image/jpeg', 12, 'deadbeef', '2026-04-16T10:05:00Z')",
                    (self.absent_document, charge),
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

    def _drain(self, response) -> bytes:
        async def pump():
            parts = []
            async for chunk in response.body_iterator:
                parts.append(chunk if isinstance(chunk, bytes) else chunk.encode())
            return b"".join(parts)
        return asyncio.new_event_loop().run_until_complete(pump())

    def _upload(self, content: bytes, filename: str) -> UploadFile:
        return UploadFile(file=io.BytesIO(content), filename=filename)

    def _counts(self, tables) -> dict[str, int]:
        with self._use_db_path():
            with get_db() as conn:
                return {t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in tables}


class BackupRestoreTests(BackupFixtureTestCase):
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

    def test_restore_v7_translates_legacy_account_columns(self):
        # A pre-6b-3 (version 7) backup carries the old plaid_account_id / plaid_item_id columns. Restore
        # must translate them: the handle → external_account_id; a real item_id relinks to its live
        # connection (id + provider); the csv/manual sentinels become an origin-only provider with no
        # connection. `insert_rows` would otherwise silently drop the unknown v7 keys.
        with self._use_db_path():
            with get_db() as conn:
                # connection is credential data — not wiped by restore, not carried in the data payload.
                conn.execute(
                    "INSERT INTO connection (id, provider, external_id, credential) VALUES ('c1', 'plaid', 'item-9', '')"
                )
            payload = {
                "version": 7,
                "schema_version": 7,
                "owners": [{"id": "o1", "name": "Me", "color": "#111111"}],
                "accounts": [
                    {"id": "a1", "plaid_account_id": "acct-9", "plaid_item_id": "item-9",
                     "name": "Bank", "display_name": "Bank", "type": "depository", "owner_id": "o1", "parent_account_id": None},
                    {"id": "a2", "plaid_account_id": "csv_x", "plaid_item_id": "csv_import",
                     "name": "CSV", "display_name": "CSV", "type": "depository", "owner_id": "o1", "parent_account_id": None},
                    {"id": "a3", "plaid_account_id": None, "plaid_item_id": "manual",
                     "name": "Manual", "display_name": "Manual", "type": "other", "owner_id": "o1", "parent_account_id": None},
                ],
            }
            restore_backup(RestoreRequest(data=payload, force=True))
            with get_db() as conn:
                rows = {
                    r["id"]: r
                    for r in conn.execute("SELECT id, external_account_id, connection_id, provider FROM account")
                }
        self.assertEqual((rows["a1"]["external_account_id"], rows["a1"]["connection_id"], rows["a1"]["provider"]),
                         ("acct-9", "c1", "plaid"))
        self.assertEqual((rows["a2"]["external_account_id"], rows["a2"]["connection_id"], rows["a2"]["provider"]),
                         ("csv_x", None, "csv"))
        self.assertEqual((rows["a3"]["connection_id"], rows["a3"]["provider"]), (None, "manual"))

    def test_restore_v8_translates_the_legacy_transaction_id_column(self):
        # A pre-v9 backup carries `plaid_transaction_id`, renamed to `external_transaction_id` in v26.
        # `insert_rows` drops keys the schema doesn't have, so without the translation every restored
        # transaction would come back with no provider id — and that id is what makes a sync idempotent,
        # so the next sync would re-add every one of them as a fresh row.
        with self._use_db_path():
            payload = {
                "version": 8,
                "schema_version": 20,
                "owners": [{"id": "o1", "name": "Me", "color": "#111111"}],
                "accounts": [
                    {"id": "a1", "external_account_id": "acct-9", "name": "Bank", "display_name": "Bank",
                     "type": "depository", "owner_id": "o1", "parent_account_id": None},
                ],
                "transactions": [
                    {"id": "t1", "plaid_transaction_id": "prov-1", "account_id": "a1", "owner_id": "o1",
                     "amount": 5.0, "date": "2026-01-01", "merchant_name": "Shop"},
                    {"id": "t2", "plaid_transaction_id": None, "account_id": "a1", "owner_id": "o1",
                     "amount": 6.0, "date": "2026-01-02", "merchant_name": "Manual"},
                ],
            }
            restore_backup(RestoreRequest(data=payload, force=True))
            with get_db() as conn:
                rows = {r["id"]: r for r in conn.execute(
                    "SELECT id, external_transaction_id FROM txn"
                )}
        self.assertEqual(rows["t1"]["external_transaction_id"], "prov-1")
        self.assertIsNone(rows["t2"]["external_transaction_id"])

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
        reloaded = read_payload_bytes(_zip_json_bytes("luma_backup.json", payload))
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

# --- Version 10: the streaming archive ------------------------------------------------------------
# The dict round trips above exercise the payload's *content*; these exercise the container the app
# actually writes and reads — members, digests, the encrypted envelope, and the upload dispatch. The
# distinction matters because nothing on the export path materializes a payload dict any more, so a
# test that only ever handled one would be testing a shape no user ever receives.


class BackupArchiveTests(BackupFixtureTestCase):
    def _write_archive(self) -> bytes:
        with self._use_db_path():
            with get_db() as conn:
                buf = io.BytesIO()
                write_backup_archive(conn, buf)
        return buf.getvalue()

    def _restore_archive(self, archive_bytes: bytes, force: bool = False) -> dict:
        with self._use_db_path():
            with zipfile.ZipFile(io.BytesIO(archive_bytes)) as zf:
                return restore_from_archive(zf, force=force)

    @staticmethod
    def _rewrite_member(archive_bytes: bytes, member: str, content: bytes) -> bytes:
        """Rebuild an archive with one member's bytes replaced and everything else intact — the shape a
        corrupted download takes, as opposed to a wholesale truncation."""
        out = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(archive_bytes)) as src, zipfile.ZipFile(out, "w") as dst:
            for name in src.namelist():
                dst.writestr(name, content if name == member else src.read(name))
        return out.getvalue()

    def _add_recipient(self, label="Test key"):
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        public_pem = key.public_key().public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        ).decode()
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO backup_recipient (id, label, public_key, fingerprint) VALUES (?, ?, ?, ?)",
                    (str(uuid.uuid4()), label, public_pem, str(uuid.uuid4())),
                )
        private_pem = key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
        return key, private_pem

    # --- the container itself --------------------------------------------------------------------

    def test_export_endpoint_streams_a_complete_archive(self):
        self._seed_complete()
        with self._use_db_path():
            response = export_backup(encrypted=False, recipients=None)
        body = self._drain(response)

        # Declared length must match what is actually sent, or a download shows a progress bar that
        # never finishes (or truncates).
        self.assertEqual(int(response.headers["Content-Length"]), len(body))
        with zipfile.ZipFile(io.BytesIO(body)) as zf:
            names = set(zf.namelist())
            self.assertIn("meta.json", names)
            for section in BACKUP_SECTION_NAMES:
                self.assertIn(f"sections/{section}.ndjson", names,
                              f"{section} has no member in the archive")
            meta = json.loads(zf.read("meta.json"))
        self.assertEqual(meta["version"], BACKUP_PAYLOAD_VERSION)
        self.assertEqual(set(meta["members"]),
                         {f"sections/{s}.ndjson" for s in BACKUP_SECTION_NAMES})

    def test_archive_round_trip_preserves_every_table(self):
        self._seed_complete()
        tables = self._user_data_tables()
        before = self._counts(tables)

        self._restore_archive(self._write_archive())

        self.assertEqual(self._counts(tables), before)

    def test_restore_rolls_every_connection_cursor_back_with_the_ledger(self):
        # A cursor is a claim about data held. The restore just replaced that data, so a surviving cursor
        # would put every removed row behind it — a delta sync asks only for changes *since* the cursor, the
        # provider considers them delivered, and they are silently gone. `Remove synced transactions` resets
        # the same two columns for the same reason after deleting rows.
        self._seed_complete()
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """UPDATE connection
                       SET transactions_cursor = 'cursor-past-the-restored-rows',
                           initial_sync_complete = 1,
                           provider_request_budget = '{"spent": 41}',
                           last_synced_at = '2026-08-20T10:00:00'"""
                )

        self._restore_archive(self._write_archive())

        with self._use_db_path():
            with get_db() as conn:
                rows = [dict(r) for r in conn.execute(
                    "SELECT transactions_cursor, initial_sync_complete, provider_request_budget,"
                    " last_synced_at FROM connection"
                )]
        self.assertTrue(rows, "fixture must carry a connection for this to mean anything")
        for row in rows:
            self.assertIsNone(row["transactions_cursor"], "a cursor outlived the rows it described")
            self.assertEqual(row["initial_sync_complete"], 0)
            # Spending is a record of requests actually made — no restore can un-make them, so it must
            # survive. Sync health describes contact with the provider, not data held.
            self.assertEqual(row["provider_request_budget"], '{"spent": 41}')
            self.assertEqual(row["last_synced_at"], "2026-08-20T10:00:00")

    def test_archive_reports_what_actually_landed(self):
        self._seed_complete()
        tables = self._user_data_tables()
        result = self._restore_archive(self._write_archive())
        counts = result["restored_counts"]
        after = self._counts(tables)
        for table, section in TABLE_TO_SECTION.items():
            self.assertEqual(counts[section], after[table],
                             f"{section} count does not match the restored table")

    def test_row_counts_are_recorded_per_member(self):
        self._seed_complete()
        with zipfile.ZipFile(io.BytesIO(self._write_archive())) as zf:
            meta = json.loads(zf.read("meta.json"))
            for name, recorded in meta["members"].items():
                lines = [ln for ln in zf.read(name).decode().splitlines() if ln.strip()]
                self.assertEqual(recorded["rows"], len(lines), f"{name} row count is wrong")

    # --- attached documents ----------------------------------------------------------------------
    # Documents are the one part of the payload that is not rows, and the only part whose storage is not
    # transactional. What these pin is the seam: the bytes ride the same artifact as the ledger that
    # references them, and every way the two can disagree resolves toward keeping the ledger.

    def test_document_files_ride_the_archive_as_stored_members(self):
        self._seed_complete()
        with zipfile.ZipFile(io.BytesIO(self._write_archive())) as zf:
            info = zf.getinfo(f"documents/{self.present_document}")
            self.assertEqual(zf.read(info.filename), self.document_bytes)
            # Stored, not deflated: a PDF/JPEG/PNG payload is already compressed, so deflating it spends
            # CPU for nothing while the NDJSON sections beside it still compress ~10:1.
            self.assertEqual(info.compress_type, zipfile.ZIP_STORED)
            # A row whose file is gone rides without a member rather than failing the export — refusing
            # would withhold the whole ledger over one unreadable receipt.
            self.assertNotIn(f"documents/{self.absent_document}", set(zf.namelist()))
            # Their digests live on the `document` row, deliberately not repeated in meta.json: one
            # source of truth, and the one a resumed restore can check a half-written file against.
            self.assertNotIn(f"documents/{self.present_document}", json.loads(zf.read("meta.json"))["members"])

    def test_restore_rebuilds_the_document_store_and_sweeps_what_the_ledger_dropped(self):
        self._seed_complete()
        archive = self._write_archive()

        with self._use_db_path():
            # Destroy the store the way a restore onto a different machine would find it: the attached
            # file gone, and an unrelated file present that the restored ledger knows nothing about.
            document_file_path(self.present_document).unlink()
            orphan = str(uuid.uuid4())
            write_document_file(orphan, b"%PDF-1.4\nnot in the ledger\n%%EOF\n")

        result = self._restore_archive(archive)

        with self._use_db_path():
            self.assertEqual(document_file_path(self.present_document).read_bytes(), self.document_bytes)
            # Swept last rather than cleared up front, so an interrupted restore leaves inert litter
            # instead of originals it can no longer recover.
            self.assertFalse(document_file_path(orphan).exists())
        self.assertEqual(result["documents"]["restored"], 1)
        self.assertEqual(result["documents"]["swept"], 1)
        # The row whose file never made it into the archive is reported, not silently forgotten.
        self.assertEqual(result["documents"]["missing"], 1)

    def test_a_stale_file_under_a_restored_id_is_not_adopted_as_the_document(self):
        # Ids are stable across backups of one install, so a file for a restored id may already be in
        # the store. The archive here does not carry that document's member (its file was missing at
        # export), and the local file under the same id holds something else entirely. Leaving it would
        # be the worst outcome available: the restored ledger references the id, so the sweep spares it,
        # and the app would serve unrelated content as that receipt.
        self._seed_complete()
        archive = self._write_archive()

        with self._use_db_path():
            write_document_file(self.absent_document, b"%PDF-1.4\nsomeone else's invoice\n%%EOF\n")

        result = self._restore_archive(archive)

        with self._use_db_path():
            self.assertFalse(document_file_path(self.absent_document).exists())
        self.assertEqual(result["documents"]["missing"], 1)
        self.assertEqual(result["documents"]["retained"], 0)

    def test_a_local_file_matching_its_digest_survives_a_gap_in_the_archive(self):
        # The same branch, other outcome. When the local file *is* the document — the ordinary case for
        # a re-restore, since ids are stable — the archive's gap costs nothing and the file is kept. The
        # digest is what tells the two cases apart, which is why the decision is not made on the id.
        self._seed_complete()
        with self._use_db_path():
            # Drop the file so the export writes this row without its member, then put the genuine
            # bytes back, as an earlier restore or the original attach would have left them.
            document_file_path(self.present_document).unlink()
        archive = self._write_archive()
        with self._use_db_path():
            write_document_file(self.present_document, self.document_bytes)

        result = self._restore_archive(archive)

        with self._use_db_path():
            self.assertEqual(document_file_path(self.present_document).read_bytes(), self.document_bytes)
        self.assertEqual(result["documents"]["retained"], 1)

    def test_a_corrupt_document_costs_its_file_and_not_the_ledger(self):
        self._seed_complete()
        tables = self._user_data_tables()
        archive = self._rewrite_member(
            self._write_archive(), f"documents/{self.present_document}", b"corrupted on the way here",
        )

        result = self._restore_archive(archive)

        # The ledger is already committed and correct by the time a document is written, so one file
        # failing its digest must not cost the user their transactions.
        self.assertEqual(self._counts(tables)["txn"], result["restored_counts"]["transactions"])
        self.assertEqual(result["documents"]["corrupt"], 1)
        with self._use_db_path():
            # Removed rather than left in place: "present on disk" has to keep meaning "intact", or
            # every later digest comparison — a resumed restore above all — is reading a lie.
            self.assertFalse(document_file_path(self.present_document).exists())

    def test_restoring_a_backup_without_documents_empties_the_store(self):
        # Restore is destructive, and its destructive half is derived rather than declared: a ledger
        # with no documents means no files, whether the backup predates the feature or simply had none.
        self._seed_complete()
        with self._use_db_path():
            with get_db() as conn:
                conn.execute("DELETE FROM document")
        archive = self._write_archive()

        with self._use_db_path():
            write_document_file(self.present_document, self.document_bytes)
        self._restore_archive(archive)

        with self._use_db_path():
            self.assertFalse(document_file_path(self.present_document).exists())

    # --- integrity -------------------------------------------------------------------------------

    def test_restore_refuses_an_archive_whose_member_was_altered(self):
        # A content edit with the manifest left intact is exactly the accidental-corruption case the
        # digests exist to catch: restore must refuse before touching the target.
        self._seed_complete()
        tables = self._user_data_tables()
        before = self._counts(tables)
        archive = self._write_archive()
        rows = [ln for ln in zipfile.ZipFile(io.BytesIO(archive)).read("sections/owners.ndjson").decode().splitlines() if ln]
        self.assertTrue(rows, "fixture must include an owner to tamper with")
        tampered = self._rewrite_member(
            archive, "sections/owners.ndjson",
            (rows[0].replace('"name":"shared"', '"name":"tampered"') + "\n").encode(),
        )

        with self.assertRaises(HTTPException) as ctx:
            self._restore_archive(tampered)
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertEqual(self._counts(tables), before, "the target was modified despite the refusal")

    def test_restore_refuses_an_archive_missing_a_member_its_manifest_lists(self):
        self._seed_complete()
        archive = self._write_archive()
        out = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(archive)) as src, zipfile.ZipFile(out, "w") as dst:
            for name in src.namelist():
                if name != "sections/transactions.ndjson":
                    dst.writestr(name, src.read(name))
        with self.assertRaises(HTTPException) as ctx:
            self._restore_archive(out.getvalue())
        self.assertEqual(ctx.exception.status_code, 400)

    def test_digest_guard_fires_only_because_the_digest_is_checked(self):
        # The tamper test above is only meaningful if an altered member would otherwise sail through:
        # prove the archive restores fine when the *manifest* is updated to match the edit.
        self._seed_complete()
        archive = self._write_archive()
        rows = [ln for ln in zipfile.ZipFile(io.BytesIO(archive)).read("sections/owners.ndjson").decode().splitlines() if ln]
        edited = (rows[0].replace('"name":"shared"', '"name":"renamed"') + "\n").encode()
        tampered = self._rewrite_member(archive, "sections/owners.ndjson", edited)
        with zipfile.ZipFile(io.BytesIO(tampered)) as zf:
            meta = json.loads(zf.read("meta.json"))
        meta["members"]["sections/owners.ndjson"]["sha256"] = hashlib.sha256(edited).hexdigest()
        realigned = self._rewrite_member(tampered, "meta.json",
                                         json.dumps(meta, sort_keys=True, separators=(",", ":")).encode())

        self._restore_archive(realigned)  # must not raise
        with self._use_db_path():
            with get_db() as conn:
                names = {r["name"] for r in conn.execute("SELECT name FROM owner")}
        self.assertIn("renamed", names)

    # --- the encrypted envelope ------------------------------------------------------------------

    def test_encrypted_export_is_readable_by_the_one_shot_cipher(self):
        # The streaming encryptor replaced a one-shot AESGCM.encrypt(). The claim that made that a safe
        # swap is that the bytes are identical, so assert exactly that: the archive opens with the API
        # the old writer used, tag and all.
        self._seed_complete()
        private_key, _pem = self._add_recipient()
        with self._use_db_path():
            response = export_backup(encrypted=True, recipients=None)
        body = self._drain(response)

        with zipfile.ZipFile(io.BytesIO(body)) as zf:
            manifest = json.loads(zf.read("manifest.json"))
            sealed = zf.read("payload.bin")
        content_key = private_key.decrypt(
            _b64url_decode(manifest["wrapped_keys"][0]["wrapped_key"]),
            padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()), algorithm=hashes.SHA256(), label=None),
        )
        nonce = _b64url_decode(manifest["nonce"])
        plaintext = AESGCM(content_key).decrypt(nonce, sealed, None)

        with zipfile.ZipFile(io.BytesIO(plaintext)) as inner:
            self.assertEqual(json.loads(inner.read("meta.json"))["version"], BACKUP_PAYLOAD_VERSION)

    def test_encrypted_round_trip_through_the_upload_endpoint(self):
        self._seed_complete()
        _key, private_pem = self._add_recipient()
        tables = self._user_data_tables()
        before = self._counts(tables)
        with self._use_db_path():
            body = self._drain(export_backup(encrypted=True, recipients=None))

        with self._use_db_path():
            asyncio.new_event_loop().run_until_complete(restore_backup_file(
                file=self._upload(body, "luma_backup.encrypted.zip"),
                private_key_file=self._upload(private_pem, "key.pem"),
                private_key_passphrase=None,
                force=False,
            ))

        self.assertEqual(self._counts(tables), before)

    def test_an_explicit_recipient_list_narrows_who_can_read_it(self):
        # The per-backup choice: a file going somewhere that should not be openable by every key on the
        # list. What ends up in the manifest is what the caller asked for, not everything enabled.
        self._seed_complete()
        self._add_recipient("Home NAS")
        chosen, _pem = self._add_recipient("Offsite drive")
        with self._use_db_path():
            with get_db() as conn:
                target = conn.execute(
                    "SELECT id FROM backup_recipient WHERE label = 'Offsite drive'"
                ).fetchone()["id"]
            body = self._drain(export_backup(encrypted=True, recipients=target))

        with zipfile.ZipFile(io.BytesIO(body)) as zf:
            manifest = json.loads(zf.read("manifest.json"))
        self.assertEqual([w["label"] for w in manifest["wrapped_keys"]], ["Offsite drive"])
        # And the key that was left out genuinely cannot open it.
        self.assertEqual(len(manifest["wrapped_keys"]), 1)

    def test_omitting_the_list_still_means_every_enabled_recipient(self):
        self._seed_complete()
        self._add_recipient("Home NAS")
        self._add_recipient("Offsite drive")
        with self._use_db_path():
            body = self._drain(export_backup(encrypted=True, recipients=None))
        with zipfile.ZipFile(io.BytesIO(body)) as zf:
            manifest = json.loads(zf.read("manifest.json"))
        self.assertEqual(len(manifest["wrapped_keys"]), 2)

    def test_a_stale_recipient_id_is_an_error_not_a_quiet_omission(self):
        # Encrypting to fewer keys than were asked for produces a file the user believes one of their keys
        # opens and none does — discovered at restore, which is the worst moment.
        self._seed_complete()
        self._add_recipient("Home NAS")
        with self._use_db_path():
            with self.assertRaises(HTTPException) as ctx:
                export_backup(encrypted=True, recipients="not-a-real-id")
        self.assertEqual(ctx.exception.status_code, 400)

    def test_a_disabled_recipient_cannot_be_selected(self):
        # `enabled` is eligibility: a key switched off must not come back through an explicit id.
        self._seed_complete()
        self._add_recipient("Home NAS")
        with self._use_db_path():
            with get_db() as conn:
                rid = conn.execute("SELECT id FROM backup_recipient").fetchone()["id"]
                conn.execute("UPDATE backup_recipient SET enabled = 0")
            with self.assertRaises(HTTPException) as ctx:
                export_backup(encrypted=True, recipients=rid)
        self.assertEqual(ctx.exception.status_code, 400)

    def test_encrypted_restore_refuses_a_tampered_payload(self):
        self._seed_complete()
        _key, private_pem = self._add_recipient()
        tables = self._user_data_tables()
        before = self._counts(tables)
        with self._use_db_path():
            body = self._drain(export_backup(encrypted=True, recipients=None))
        sealed = bytearray(zipfile.ZipFile(io.BytesIO(body)).read("payload.bin"))
        sealed[len(sealed) // 2] ^= 0xFF
        tampered = self._rewrite_member(body, "payload.bin", bytes(sealed))

        with self._use_db_path():
            with self.assertRaises(HTTPException) as ctx:
                asyncio.new_event_loop().run_until_complete(restore_backup_file(
                    file=self._upload(tampered, "luma_backup.encrypted.zip"),
                    private_key_file=self._upload(private_pem, "key.pem"),
                    private_key_passphrase=None,
                    force=False,
                ))
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertEqual(self._counts(tables), before, "the target was modified despite the refusal")

    # --- the upload dispatch ---------------------------------------------------------------------

    def test_upload_restores_a_version_10_archive(self):
        self._seed_complete()
        tables = self._user_data_tables()
        before = self._counts(tables)
        archive = self._write_archive()
        with self._use_db_path():
            asyncio.new_event_loop().run_until_complete(restore_backup_file(
                file=self._upload(archive, "luma_backup.zip"),
                private_key_file=None, private_key_passphrase=None, force=False,
            ))
        self.assertEqual(self._counts(tables), before)

    def test_upload_still_restores_a_legacy_single_json_backup(self):
        # A version-9 file is one JSON object in a zip, not members — the container the dispatcher has to
        # keep recognizing for every backup anyone already holds.
        self._seed_complete()
        tables = self._user_data_tables()
        before = self._counts(tables)
        with self._use_db_path():
            with get_db() as conn:
                payload = build_backup_data(conn)
        payload["version"] = 9
        payload.pop(CONTENT_HASH_FIELD, None)
        legacy = _zip_json_bytes("luma_backup.json", _stamp_content_hash(payload))

        with self._use_db_path():
            asyncio.new_event_loop().run_until_complete(restore_backup_file(
                file=self._upload(legacy, "luma_backup.zip"),
                private_key_file=None, private_key_passphrase=None, force=False,
            ))
        self.assertEqual(self._counts(tables), before)

    def test_inspect_reports_the_archive_version_and_encryption(self):
        self._seed_complete()
        with self._use_db_path():
            plain = asyncio.new_event_loop().run_until_complete(
                inspect_backup_file(file=self._upload(self._write_archive(), "luma_backup.zip")))
        self.assertEqual(plain, {"kind": "data", "encrypted": False, "container": "zip",
                                 "version": BACKUP_PAYLOAD_VERSION})

        self._add_recipient()
        with self._use_db_path():
            body = self._drain(export_backup(encrypted=True, recipients=None))
            encrypted = asyncio.new_event_loop().run_until_complete(
                inspect_backup_file(file=self._upload(body, "luma_backup.encrypted.zip")))
        self.assertTrue(encrypted["encrypted"])
        self.assertEqual(encrypted["recipient_count"], 1)
        # Identified without a private key: the kind rides the plaintext manifest precisely so the
        # restore surface can name the file before anyone has produced a key for it.
        self.assertEqual(encrypted["kind"], "data")


# --- Telling the two backups apart -----------------------------------------------------------------
# The restore surface routes a file by what it *is*, so this is the seam that decides which flow the
# user gets — and the one that used to answer "Unexpected backup file inside ZIP" when someone picked
# their credentials file in the data restore.


class BackupIdentificationTests(BackupFixtureTestCase):
    def _identify(self, content: bytes):
        with self._use_db_path():
            return asyncio.new_event_loop().run_until_complete(
                inspect_backup_file(file=self._upload(content, "chosen.zip")))

    @staticmethod
    def _credentials_file(member="luma_credentials.json", **overrides) -> bytes:
        payload = {"kind": "credentials", "version": 4, "connections": [], "provider_configs": []}
        payload.update(overrides)
        return _zip_json_bytes(member, payload)

    def test_a_credentials_backup_is_identified_as_one(self):
        self.assertEqual(self._identify(self._credentials_file())["kind"], "credentials")

    def test_a_data_archive_is_identified_as_one(self):
        self._seed_complete()
        with self._use_db_path():
            with get_db() as conn:
                buf = io.BytesIO()
                write_backup_archive(conn, buf)
        self.assertEqual(self._identify(buf.getvalue())["kind"], "data")

    def test_older_files_without_a_kind_are_identified_by_shape(self):
        # Every backup written before the declaration existed still has to land in the right flow, and
        # the member name is not what decides it — the payload's own sections are.
        credentials = self._credentials_file(member="export.json")
        payload = json.loads(zipfile.ZipFile(io.BytesIO(credentials)).read("export.json"))
        payload.pop("kind")
        self.assertEqual(self._identify(_zip_json_bytes("export.json", payload))["kind"], "credentials")

        self._seed_complete()
        with self._use_db_path():
            with get_db() as conn:
                legacy = build_backup_data(conn)
        legacy.pop("kind", None)
        legacy["version"] = 9
        self.assertEqual(self._identify(_zip_json_bytes("export.json", legacy))["kind"], "data")

    def test_a_file_that_is_not_a_backup_says_so(self):
        with self.assertRaises(HTTPException) as ctx:
            self._identify(_zip_json_bytes("notes.json", {"shopping": ["milk"]}))
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("does not look like", ctx.exception.detail)

    def test_the_wrong_backup_in_the_data_restore_names_what_it_is(self):
        with self._use_db_path():
            with self.assertRaises(HTTPException) as ctx:
                asyncio.new_event_loop().run_until_complete(restore_backup_file(
                    file=self._upload(self._credentials_file(), "luma_credentials.zip"),
                    private_key_file=None, private_key_passphrase=None, force=False))
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertEqual(ctx.exception.detail, "This is a credentials backup, not a data backup.")

    def test_the_wrong_backup_in_the_credentials_restore_names_what_it_is(self):
        self._seed_complete()
        with self._use_db_path():
            with get_db() as conn:
                buf = io.BytesIO()
                write_backup_archive(conn, buf)
            with self.assertRaises(HTTPException) as ctx:
                asyncio.new_event_loop().run_until_complete(restore_credentials_file(
                    request=None, file=self._upload(buf.getvalue(), "luma_backup.zip"), passphrase=None))
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertEqual(ctx.exception.detail, "This is a data backup, not a credentials backup.")

    def test_restore_endpoint_is_bound_to_the_restore_handler(self):
        # The decorator for POST /restore once sat on the wipe helper directly above the handler, which
        # left the JSON-body restore unrouted and registered a helper taking a database connection as an
        # HTTP endpoint. Nothing caught it because the UI only uses /restore-file.
        routes = {route.path: route.endpoint for route in router.routes}
        self.assertIs(routes.get("/restore"), restore_backup)
        self.assertIs(routes.get("/backup"), export_backup)


# --- Referential repair ---------------------------------------------------------------------------
# A backup can outlive the deletions that happened after it was taken, so restore repairs dangling
# references rather than failing. The rules used to be set membership over the payload in memory and are
# now SQL over the restored tables; these pin the *decisions* (null it, or drop the row) so the
# translation cannot quietly change one.


class RestoreReferentialRepairTests(BackupFixtureTestCase):
    def _restore_with(self, mutate) -> None:
        with self._use_db_path():
            with get_db() as conn:
                payload = build_backup_data(conn)
        mutate(payload)
        payload.pop(CONTENT_HASH_FIELD, None)
        with self._use_db_path():
            restore_backup(RestoreRequest(data=payload, force=True))

    def _table_ids(self, table) -> set:
        with self._use_db_path():
            with get_db() as conn:
                return {r["id"] for r in conn.execute(f"SELECT id FROM {table}")}

    def test_optional_reference_is_nulled_and_the_row_survives(self):
        self._seed_complete()

        def drop_the_category(payload):
            for row in payload["transactions"]:
                row["category_id"] = "gone-" + str(uuid.uuid4())

        self._restore_with(drop_the_category)
        with self._use_db_path():
            with get_db() as conn:
                rows = conn.execute("SELECT COUNT(*) c, COUNT(category_id) named FROM txn").fetchone()
        self.assertGreater(rows["c"], 0, "transactions must survive a missing category")
        self.assertEqual(rows["named"], 0, "a dangling category reference must become NULL")

    def test_a_row_whose_required_parent_is_gone_is_dropped(self):
        self._seed_complete()
        before = self._counts({"txn"})["txn"]

        def orphan_one_transaction(payload):
            payload["transactions"][0]["account_id"] = "gone-" + str(uuid.uuid4())

        self._restore_with(orphan_one_transaction)
        self.assertEqual(self._counts({"txn"})["txn"], before - 1)

    def test_dropping_a_transaction_takes_its_attachments_with_it(self):
        self._seed_complete()
        orphaned = {"txn_id": None}

        def orphan_a_tagged_transaction(payload):
            tagged = {row["txn_id"] for row in payload["txn_tags"]}
            victim = next(row for row in payload["transactions"] if row["id"] in tagged)
            orphaned["txn_id"] = victim["id"]
            victim["account_id"] = "gone-" + str(uuid.uuid4())

        self._restore_with(orphan_a_tagged_transaction)
        with self._use_db_path():
            with get_db() as conn:
                left = conn.execute("SELECT COUNT(*) c FROM txn_tag WHERE txn_id = ?",
                                    (orphaned["txn_id"],)).fetchone()["c"]
        self.assertEqual(left, 0, "a tag attachment outlived the transaction it belonged to")

    def test_an_attachment_whose_tag_never_existed_is_dropped(self):
        self._seed_complete()

        def orphan_the_tag(payload):
            for row in payload["txn_tags"]:
                row["tag_id"] = "gone-" + str(uuid.uuid4())

        self._restore_with(orphan_the_tag)
        self.assertEqual(self._counts({"txn_tag"})["txn_tag"], 0)

    def test_a_broken_funding_mapping_is_dropped_rather_than_nulled(self):
        # NULL means "untracked", which is a different statement from "the account this pointed at is
        # gone" — so the row goes rather than being downgraded into a claim nobody made.
        self._seed_complete()
        self.assertGreater(self._counts({"amazon_funding_map"})["amazon_funding_map"], 0)

        def orphan_the_funding_account(payload):
            for row in payload["amazon_funding_map"]:
                row["funding_account_id"] = "gone-" + str(uuid.uuid4())

        self._restore_with(orphan_the_funding_account)
        self.assertEqual(self._counts({"amazon_funding_map"})["amazon_funding_map"], 0)


# --- The keypair generator -------------------------------------------------------------------------
# Encrypted backups need a keypair the user owns, and producing one otherwise means knowing an openssl
# incantation. The generator removes that barrier; these pin the two properties that make it safe to
# offer — it keeps nothing, and what it hands back genuinely opens a backup.


class BackupKeypairTests(BackupFixtureTestCase):
    def _generate(self, **kwargs):
        with self._use_db_path():
            response = generate_backup_keypair(BackupKeypairRequest(**kwargs))
        self.assertEqual(response.headers.get("Cache-Control"), "no-store",
                         "a response carrying a private key must not be cacheable")
        return json.loads(response.body)

    def _recipient_count(self) -> int:
        with self._use_db_path():
            with get_db() as conn:
                return conn.execute("SELECT COUNT(*) c FROM backup_recipient").fetchone()["c"]

    def test_it_returns_a_usable_pair(self):
        result = self._generate(key_size=2048)
        private_key = serialization.load_pem_private_key(result["private_key"].encode(), password=None)
        public_key = serialization.load_pem_public_key(result["public_key"].encode())
        self.assertEqual(private_key.key_size, 2048)
        self.assertEqual(result["key_size"], 2048)
        self.assertFalse(result["encrypted"])
        # The halves must actually belong together, which a fingerprint comparison settles.
        self.assertEqual(
            public_key.public_numbers(), private_key.public_key().public_numbers()
        )

    def test_a_passphrase_actually_encrypts_the_private_key(self):
        result = self._generate(key_size=2048, passphrase="correct horse battery staple")
        self.assertTrue(result["encrypted"])
        with self.assertRaises((TypeError, ValueError)):
            serialization.load_pem_private_key(result["private_key"].encode(), password=None)
        loaded = serialization.load_pem_private_key(
            result["private_key"].encode(), password=b"correct horse battery staple"
        )
        self.assertEqual(loaded.key_size, 2048)

    def test_a_blank_passphrase_is_not_a_passphrase(self):
        # Whitespace is what a user leaves behind in an untouched field; it must not produce a key file
        # that silently demands a passphrase of spaces.
        result = self._generate(key_size=2048, passphrase="   ")
        self.assertFalse(result["encrypted"])
        serialization.load_pem_private_key(result["private_key"].encode(), password=None)

    def test_generating_stores_nothing(self):
        before = self._recipient_count()
        self._generate(key_size=2048)
        self._generate(key_size=2048, passphrase="x")
        self.assertEqual(self._recipient_count(), before,
                         "generating a keypair must not create a recipient")

    def test_an_unsupported_key_size_is_refused(self):
        with self.assertRaises(HTTPException) as ctx:
            self._generate(key_size=512)
        self.assertEqual(ctx.exception.status_code, 400)

    def test_a_weak_pasted_key_is_refused(self):
        # The floor applies to keys from anywhere, not only ones this generator made.
        weak = rsa.generate_private_key(public_exponent=65537, key_size=1024).public_key()
        pem = weak.public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        ).decode()
        with self._use_db_path():
            with self.assertRaises(HTTPException) as ctx:
                create_backup_recipient(BackupRecipientCreate(label="Weak", public_key=pem))
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("1024-bit", ctx.exception.detail)

    def test_a_duplicate_name_is_refused(self):
        # The fingerprint beside a name is forty characters of base64 and settles nothing at a glance, so
        # two recipients sharing a name make the list unreadable exactly when it matters.
        first = self._generate(key_size=2048)
        second = self._generate(key_size=2048)
        with self._use_db_path():
            create_backup_recipient(BackupRecipientCreate(label="Home NAS", public_key=first["public_key"]))
            with self.assertRaises(HTTPException) as ctx:
                create_backup_recipient(BackupRecipientCreate(label="  home nas ", public_key=second["public_key"]))
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("already exists", ctx.exception.detail)

    def test_a_rename_cannot_collide_either(self):
        first = self._generate(key_size=2048)
        second = self._generate(key_size=2048)
        with self._use_db_path():
            create_backup_recipient(BackupRecipientCreate(label="Home NAS", public_key=first["public_key"]))
            other = create_backup_recipient(BackupRecipientCreate(label="Offsite", public_key=second["public_key"]))
            with self.assertRaises(HTTPException) as ctx:
                update_backup_recipient(other["id"], BackupRecipientUpdate(label="Home NAS"))
            self.assertEqual(ctx.exception.status_code, 400)
            # Renaming to its own name is not a collision with itself.
            kept = update_backup_recipient(other["id"], BackupRecipientUpdate(label="Offsite"))
        self.assertEqual(kept["label"], "Offsite")

    def test_a_generated_key_opens_a_real_encrypted_backup(self):
        # The claim the whole feature rests on. Everything else here checks shapes; this checks that the
        # file the user is handed actually decrypts a backup made for its public half — through the same
        # endpoints the app calls, with a passphrase in play.
        self._seed_complete()
        tables = self._user_data_tables()
        before = self._counts(tables)
        generated = self._generate(key_size=2048, passphrase="a passphrase")
        with self._use_db_path():
            create_backup_recipient(BackupRecipientCreate(label="Generated", public_key=generated["public_key"]))
            body = self._drain(export_backup(encrypted=True, recipients=None))

        with self._use_db_path():
            asyncio.new_event_loop().run_until_complete(restore_backup_file(
                file=self._upload(body, "luma_backup.encrypted.zip"),
                private_key_file=self._upload(generated["private_key"].encode(), "key.pem"),
                private_key_passphrase="a passphrase",
                force=False,
            ))
        self.assertEqual(self._counts(tables), before)
