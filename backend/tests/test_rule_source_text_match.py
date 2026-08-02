"""
Opt-in `match_source_text` rules categorize on a row's captured import source text (the description +
extra evidence fields like "Original Statement"), not just the merchant/raw/display name.

The motivating case: a merchant ("Riverstone") whose visible name is categorized normally, but
one row's Original Statement reads "RENEWAL MEMBERSHIP FEE" and should land in Membership. A plain
keyword rule can't see that field; a source-text rule can.

Guards proven here, not just asserted:
  - the source-text rule DOES categorize the row (positive),
  - an otherwise-identical name-only rule does NOT (the guard fires on known-bad input), and
  - `match_source_text` is part of the matcher identity — two rules differing only by it coexist.
"""

from __future__ import annotations

import json
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import (
    SHARED_OWNER_ID,
    get_db,
    init_db,
    reset_current_db_path,
    set_current_db_path,
)
from backend.routers.rules import RuleCreate, create_rule
from backend.services.categorizer import categorize_transaction, recategorize_all

KEYWORD = "renewal membership fee"
ORIGINAL_STATEMENT = "RENEWAL MEMBERSHIP FEE"
EVIDENCE = json.dumps({
    "description": {"header": "Description", "value": "RIVERSTONE"},
    "extra_text_fields": [{"header": "Original Statement", "value": ORIGINAL_STATEMENT}],
})


class RuleSourceTextMatchTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "source-text.db"
        init_db(str(self.db_path))
        self.account = self._account()
        self.membership = self._leaf("Membership")
        self.txn = self._insert_txn("Riverstone", "RIVERSTONE", EVIDENCE, -695.0)

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
                   VALUES (?, ?, 'fixture', 'Riverstone', 'Riverstone', 'credit', 'credit_card', '7304', ?, NULL, NULL)""",
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
        # Original Statement field. The visible/raw name is "Riverstone", which never contains it.
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
                "Riverstone", "RIVERSTONE", None, -695.0, conn,
                owner_id=SHARED_OWNER_ID, account_id=self.account,
                source_text=ORIGINAL_STATEMENT,
            )
            self.assertEqual(result["category_id"], self.membership)
            self.assertEqual(result["matched_rule_ids"], [flagged["id"]])
            # No source text in hand → no match, even for the flagged rule.
            self.assertIsNone(categorize_transaction(
                "Riverstone", "RIVERSTONE", None, -695.0, conn,
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
