"""
Opt-in `match_source_text` rules categorize on a row's captured import source text (the description +
extra evidence fields like "Original Statement"), not just the merchant/raw/display name.

The motivating case: a merchant ("Fablecard") whose visible name is categorized normally, but
one row's Original Statement reads "RENEWAL MEMBERSHIP FEE" and should land in Membership. A plain
keyword rule can't see that field; a source-text rule can.

Guards proven here, not just asserted:
  - the source-text rule DOES categorize the row (positive),
  - an otherwise-identical name-only rule does NOT (the guard fires on known-bad input), and
  - `match_source_text` is part of the matcher identity — two rules differing only by it coexist, and
  - a **synced** row is matched on its captured evidence too, not only an imported one.

The last is the one that regressed silently: a sync writes the same evidence shape a CSV import does,
but did not pass it to the categorizer, so the identical rule behaved differently depending on how the
row arrived and only caught up on a later recategorize pass.
"""

from __future__ import annotations

import json
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from backend.db.database import (
    SHARED_OWNER_ID,
    get_db,
    init_db,
    reset_current_db_path,
    set_current_db_path,
)
from backend.routers import sync as sync_module
from backend.routers.rules import RuleCreate, create_rule
from backend.services.categorizer import categorize_transaction, recategorize_all
from backend.tests._fake_adapter import FakeCursorAdapter

KEYWORD = "renewal membership fee"
ORIGINAL_STATEMENT = "RENEWAL MEMBERSHIP FEE"
EVIDENCE = json.dumps({
    "description": {"header": "Description", "value": "FABLECARD"},
    "extra_text_fields": [{"header": "Original Statement", "value": ORIGINAL_STATEMENT}],
})


class RuleSourceTextMatchTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "source-text.db"
        init_db(str(self.db_path))
        self.account = self._account()
        self.membership = self._leaf("Membership")
        self.txn = self._insert_txn("Fablecard", "FABLECARD", EVIDENCE, -695.0)

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _account(self) -> str:
        account_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO account (id, external_account_id, provider, name, display_name, type,
                   subtype, mask, owner_id, parent_account_id, trashed_at)
                   VALUES (?, ?, 'fixture', 'Fablecard', 'Fablecard', 'credit', 'credit_card', '4455', ?, NULL, NULL)""",
                (account_id, f"plaid_{account_id}", SHARED_OWNER_ID),
            )
        return account_id

    def _leaf(self, name: str) -> str:
        category_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            group = conn.execute(
                "SELECT id FROM category WHERE parent_id IS NULL AND category_type = 'expense' LIMIT 1"
            ).fetchone()
            conn.execute(
                "INSERT INTO category (id, parent_id, name, category_type, sort_order) VALUES (?, ?, ?, 'expense', 0)",
                (category_id, group["id"], name),
            )
        return category_id

    def _insert_txn(self, merchant: str, raw: str, evidence_json: str | None, amount: float) -> str:
        txn_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO txn (id, account_id, owner_id, category_id, amount, merchant_name,
                   display_name, raw_name, date, is_pending, category_overridden, import_evidence_json, trashed_at)
                   VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, '2026-04-26', 0, 0, ?, NULL)""",
                (txn_id, self.account, SHARED_OWNER_ID, amount, merchant, raw, evidence_json),
            )
        return txn_id

    def _txn_category(self, txn_id: str):
        with self._use_db_path(), get_db() as conn:
            row = conn.execute(
                "SELECT category_id, category_source FROM txn WHERE id = ?", (txn_id,)
            ).fetchone()
        return row["category_id"], row["category_source"]

    def test_source_text_rule_categorizes_via_recategorize(self):
        with self._use_db_path():
            create_rule(RuleCreate(keyword=KEYWORD, category_id=self.membership, match_source_text=True))
        with self._use_db_path(), get_db() as conn:
            recategorize_all(conn)
        category_id, source = self._txn_category(self.txn)
        self.assertEqual(category_id, self.membership)
        self.assertEqual(source, "rule")

    def test_name_only_rule_does_not_match_source_text(self):
        # The guard must fire: the same keyword as a plain (name-only) rule must NOT reach into the
        # Original Statement field. The visible/raw name is "Fablecard", which never contains it.
        with self._use_db_path():
            create_rule(RuleCreate(keyword=KEYWORD, category_id=self.membership, match_source_text=False))
        with self._use_db_path(), get_db() as conn:
            recategorize_all(conn)
        category_id, _ = self._txn_category(self.txn)
        self.assertIsNone(category_id)

    def test_engine_matches_only_when_flagged(self):
        # Direct categorizer check: same row + keyword, source text decides the verdict by the flag.
        with self._use_db_path(), get_db() as conn:
            flagged = create_rule(RuleCreate(keyword=KEYWORD, category_id=self.membership, match_source_text=True))
            result = categorize_transaction(
                "Fablecard", "FABLECARD", -695.0, conn,
                owner_id=SHARED_OWNER_ID, account_id=self.account,
                source_text=ORIGINAL_STATEMENT,
            )
            self.assertEqual(result["category_id"], self.membership)
            self.assertEqual(result["matched_rule_ids"], [flagged["id"]])
            # No source text in hand → no match, even for the flagged rule.
            self.assertIsNone(categorize_transaction(
                "Fablecard", "FABLECARD", -695.0, conn,
                owner_id=SHARED_OWNER_ID, account_id=self.account,
                source_text=None,
            ))

    def test_match_source_text_is_part_of_matcher_identity(self):
        # Same keyword + scope, differing only by match_source_text: distinct matchers, both created.
        with self._use_db_path():
            first = create_rule(RuleCreate(keyword=KEYWORD, category_id=self.membership, match_source_text=False))
            second = create_rule(RuleCreate(keyword=KEYWORD, category_id=self.membership, match_source_text=True))
        self.assertEqual(first["status"], "created")
        self.assertEqual(second["status"], "created")
        self.assertNotEqual(first["id"], second["id"])
        with self._use_db_path(), get_db() as conn:
            count = conn.execute("SELECT COUNT(*) FROM category_rule WHERE keyword = ?", (KEYWORD,)).fetchone()[0]
        self.assertEqual(count, 2)


if __name__ == "__main__":
    unittest.main()


class _SyncAdapter(FakeCursorAdapter):
    """One batch of rows on the first pull, nothing after — the minimum a cursor provider has to be."""

    def __init__(self, added):
        super().__init__()
        self._added = added

    def fetch_transactions_sync(self, app_config, credential, *, cursor=None, days_requested=730,
                                account_targets=None, **kwargs):
        added, self._added = self._added, []
        return {**super().fetch_transactions_sync(app_config, credential, cursor=cursor,
                                                  days_requested=days_requested,
                                                  account_targets=account_targets, **kwargs),
                "added": added, "next_cursor": "c1"}


class SyncedRowSourceTextTests(unittest.TestCase):
    """A synced row is categorized against its captured evidence, exactly as an imported one is.

    The discriminating field is a **counterparty**, deliberately: a sync writes `raw_name` into the
    evidence description as well, so a keyword found there would also be found in the plain name
    haystack and would prove nothing about the source-text path.
    """

    EXTERNAL = "ext-1"

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "sync-source-text.db"
        init_db(str(self.db_path))
        with self._db() as conn:
            conn.execute(
                "INSERT INTO connection (id, provider, external_id, credential, institution) "
                "VALUES ('conn-1','plaid','item-1','','Northgate Bank')"
            )
            conn.execute(
                "INSERT INTO account (id, name, display_name, type, owner_id, external_account_id,"
                " connection_id, provider) VALUES ('acct-1','Fablecard','Fablecard','credit',?,?,"
                "'conn-1','plaid')",
                (SHARED_OWNER_ID, self.EXTERNAL),
            )
            conn.execute(
                "INSERT INTO connection_account (connection_id, external_account_id, account_id,"
                " mapping_mode, provider_name) VALUES ('conn-1', ?, 'acct-1', 'existing', 'Fablecard')",
                (self.EXTERNAL,),
            )
            group = conn.execute(
                "SELECT id FROM category WHERE parent_id IS NULL AND category_type = 'expense' LIMIT 1"
            ).fetchone()
            self.membership = str(uuid.uuid4())
            conn.execute(
                "INSERT INTO category (id, parent_id, name, category_type, sort_order)"
                " VALUES (?, ?, 'Membership', 'expense', 0)",
                (self.membership, group["id"]),
            )

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _db(self):
        token = set_current_db_path(str(self.db_path))
        try:
            with get_db() as conn:
                yield conn
        finally:
            reset_current_db_path(token)

    def _rule(self, *, match_source_text: bool):
        token = set_current_db_path(str(self.db_path))
        try:
            create_rule(RuleCreate(keyword=KEYWORD, category_id=self.membership,
                                   match_source_text=match_source_text))
        finally:
            reset_current_db_path(token)

    def _sync_one_row(self):
        """One synced charge whose visible names never contain the keyword — only its counterparty does."""
        added = [{
            "external_transaction_id": "t-1",
            "external_account_id": self.EXTERNAL,
            "amount": -695.0,
            "merchant_name": "Fablecard",
            "raw_name": "FABLECARD",
            "date": "2026-08-01",
            "posted_date": None,
            "is_pending": False,
            "counterparties": [ORIGINAL_STATEMENT],
        }]
        request = SimpleNamespace(state=SimpleNamespace(user={"id": "u1"}))
        token = set_current_db_path(str(self.db_path))
        try:
            with mock.patch.object(sync_module.crypto_service, "is_unlocked", return_value=True), \
                 mock.patch.object(sync_module.crypto_service, "decrypt_connection_credential",
                                   return_value="tok"), \
                 mock.patch.object(sync_module, "resolve_app_config", return_value={"client_id": "x"}), \
                 mock.patch.object(sync_module, "get_adapter", return_value=_SyncAdapter(added)):
                sync_module.run_sync(days=30, connection_id="conn-1", request=request)
        finally:
            reset_current_db_path(token)
        with self._db() as conn:
            return conn.execute(
                "SELECT category_id, category_source, category_overridden, import_evidence_json"
                " FROM txn WHERE account_id = 'acct-1'"
            ).fetchone()

    def test_a_source_text_rule_categorizes_a_synced_row_as_it_arrives(self):
        self._rule(match_source_text=True)
        row = self._sync_one_row()
        self.assertIn(ORIGINAL_STATEMENT, row["import_evidence_json"])
        self.assertEqual(row["category_id"], self.membership)
        # Provenance is recorded exactly as the CSV import records it, so the row's "Categorized by" line
        # names the rule — and the row stays unpinned, open to Categorize like any rule row.
        self.assertEqual(row["category_source"], "rule")
        self.assertEqual(row["category_overridden"], 0)

    def test_a_name_only_rule_leaves_the_same_synced_row_alone(self):
        # The guard: proves the match above came from the evidence rather than from the row's own names.
        self._rule(match_source_text=False)
        row = self._sync_one_row()
        self.assertIn(ORIGINAL_STATEMENT, row["import_evidence_json"])
        self.assertIsNone(row["category_id"])
        self.assertIsNone(row["category_source"])
