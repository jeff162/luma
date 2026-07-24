"""
Account type as a rule criterion, and migration 13 (backfill PayPal account types + consolidate the
per-account money-movement rules onto one account_type='paypal' rule).

A rule can scope by account *type* ('paypal', 'amazon', …): it matches only rows whose effective account
is of that type, so one rule covers every account of the type. Precedence: a specific account beats an
account type beats global. All data here is fabricated.
"""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import (
    SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, run_migrations, set_current_db_path,
)
from backend.routers.rules import RuleCreate, create_rule_core
from backend.services.categorizer import recategorize_all


class AccountTypeCriterionTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "acctype.db"
        init_db(str(self.db_path))
        with self._use_db(), get_db() as conn:
            for acct_id, acct_type in (("pp", "paypal"), ("chk", "depository")):
                conn.execute(
                    """INSERT INTO account (id, plaid_account_id, plaid_item_id, name, display_name, type, owner_id)
                       VALUES (?, ?, 'fix', ?, ?, ?, ?)""",
                    (acct_id, f"p_{acct_id}", acct_id, acct_id, acct_type, SHARED_OWNER_ID),
                )
            grp = str(uuid.uuid4())
            conn.execute("INSERT INTO category (id, parent_id, name, category_type) VALUES (?, NULL, 'G', 'expense')", (grp,))
            self.cat_type = str(uuid.uuid4())
            self.cat_id = str(uuid.uuid4())
            conn.execute("INSERT INTO category (id, parent_id, name, category_type) VALUES (?, ?, 'ByType', 'expense')", (self.cat_type, grp))
            conn.execute("INSERT INTO category (id, parent_id, name, category_type) VALUES (?, ?, 'ById', 'expense')", (self.cat_id, grp))

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _txn(self, account_id, merchant):
        tid = str(uuid.uuid4())
        with self._use_db(), get_db() as conn:
            conn.execute(
                """INSERT INTO txn (id, account_id, owner_id, amount, merchant_name, display_name, raw_name, date, is_pending)
                   VALUES (?, ?, ?, 5.00, ?, ?, ?, '2026-01-01', 0)""",
                (tid, account_id, SHARED_OWNER_ID, merchant, merchant, merchant),
            )
        return tid

    def _rule(self, keyword, category_id, *, account_id=None, account_type=None):
        with self._use_db(), get_db() as conn:
            conn.execute(
                "INSERT INTO category_rule (id, category_id, keyword, account_id, account_type) VALUES (?, ?, ?, ?, ?)",
                (str(uuid.uuid4()), category_id, keyword, account_id, account_type),
            )

    def _cat(self, txn_id):
        with self._use_db(), get_db() as conn:
            return conn.execute("SELECT category_id FROM txn WHERE id = ?", (txn_id,)).fetchone()["category_id"]

    def test_type_scoped_rule_matches_only_that_account_type(self):
        pp_txn = self._txn("pp", "PayPal Fee")
        chk_txn = self._txn("chk", "PayPal Fee")  # same text, non-PayPal account
        self._rule("fee", self.cat_type, account_type="paypal")
        with self._use_db(), get_db() as conn:
            recategorize_all(conn)
        self.assertEqual(self._cat(pp_txn), self.cat_type, "the PayPal-account row is categorized by the type-scoped rule")
        self.assertIsNone(self._cat(chk_txn), "a non-PayPal row is not matched by a paypal-type rule")

    def test_specific_account_beats_account_type(self):
        pp_txn = self._txn("pp", "PayPal Fee")
        self._rule("fee", self.cat_type, account_type="paypal")
        self._rule("fee", self.cat_id, account_id="pp")  # more specific — should win
        with self._use_db(), get_db() as conn:
            recategorize_all(conn)
        self.assertEqual(self._cat(pp_txn), self.cat_id, "account_id scope outranks account_type scope")

    def test_effective_type_follows_a_merged_child_to_its_parent(self):
        # A child account merged under a PayPal parent inherits the parent's type for matching.
        with self._use_db(), get_db() as conn:
            conn.execute(
                """INSERT INTO account (id, plaid_account_id, plaid_item_id, name, display_name, type, owner_id, parent_account_id)
                   VALUES ('ppchild', 'p_ppchild', 'fix', 'child', 'child', 'depository', ?, 'pp')""",
                (SHARED_OWNER_ID,),
            )
        child_txn = self._txn("ppchild", "PayPal Fee")
        self._rule("fee", self.cat_type, account_type="paypal")
        with self._use_db(), get_db() as conn:
            recategorize_all(conn)
        self.assertEqual(self._cat(child_txn), self.cat_type, "a merged child inherits the parent's paypal type")

    def test_account_type_is_part_of_the_matcher_identity(self):
        with self._use_db(), get_db() as conn:
            a = create_rule_core(conn, RuleCreate(keyword="x", category_id=self.cat_type, account_type="paypal"))
            self.assertEqual(a["status"], "created")
            # Same keyword, no type scope → a *different* matcher, created normally (not a collision).
            b = create_rule_core(conn, RuleCreate(keyword="x", category_id=self.cat_id))
            self.assertEqual(b["status"], "created")
            self.assertNotEqual(a["id"], b["id"])
            # Same keyword + same type scope → same matcher → duplicate (no fork).
            c = create_rule_core(conn, RuleCreate(keyword="x", category_id=self.cat_type, account_type="paypal"))
            self.assertEqual(c["status"], "duplicate")

    def test_rule_backed_recurring_membership_honors_account_type(self):
        # A rule-backed recurring series owns exactly its rule's matches (shared rule_matches_row). The
        # rule loader for recurring membership (_load_series_rules) must carry account_type, or a
        # type-scoped recurring rule would wrongly claim rows of every account type.
        from backend.services.recurring_detection import _load_series_rules, _candidate_members
        with self._use_db(), get_db() as conn:
            created = create_rule_core(conn, RuleCreate(keyword="fee", category_id=self.cat_type, account_type="paypal"))
            rid = created["id"]
        pool = [
            {"display_name": "PayPal Fee", "merchant_name": "PayPal Fee", "raw_name": "PayPal Fee",
             "amount": 5.0, "owner_id": SHARED_OWNER_ID, "effective_account_id": "pp",
             "effective_account_type": "paypal", "id": "row-pp"},
            {"display_name": "PayPal Fee", "merchant_name": "PayPal Fee", "raw_name": "PayPal Fee",
             "amount": 5.0, "owner_id": SHARED_OWNER_ID, "effective_account_id": "chk",
             "effective_account_type": "depository", "id": "row-chk"},
        ]
        series = {"source": "rule", "rule_id": rid}
        with self._use_db(), get_db() as conn:
            series_rules = _load_series_rules(conn, [series])
        members = _candidate_members(pool, series, series_rules)
        self.assertEqual({r["id"] for r in members}, {"row-pp"}, "only the paypal-type row is owned by the type-scoped rule")


class AccountTypeMigrationTests(unittest.TestCase):
    """Migration 13 on a hand-built pre-v13 database: adds the column, backfills PayPal account types from
    PayPal import provenance, and consolidates per-account money-movement rules onto account_type='paypal'."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.tempdir.name) / "v12.db")

    def tearDown(self):
        self.tempdir.cleanup()

    def test_migration_13_backfills_types_and_consolidates_rules(self):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.executescript(
            """
            CREATE TABLE db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO db_meta VALUES ('version', '12');
            CREATE TABLE account (id TEXT PRIMARY KEY, type TEXT);
            CREATE TABLE category (id TEXT PRIMARY KEY, parent_id TEXT, name TEXT);
            CREATE TABLE category_rule (id TEXT PRIMARY KEY, category_id TEXT, keyword TEXT,
                                        account_id TEXT, match_source_text INTEGER DEFAULT 0);
            CREATE TABLE import_batch (id TEXT PRIMARY KEY, source_kind TEXT);
            CREATE TABLE txn (id TEXT PRIMARY KEY, account_id TEXT, import_batch_id TEXT, trashed_at TEXT);
            -- Two PayPal accounts (generic types) that received PayPal imports, one non-PayPal account.
            INSERT INTO account VALUES ('pp1', 'depository'), ('pp2', 'other'), ('chk', 'depository');
            INSERT INTO category VALUES ('tg', NULL, 'Transfers'), ('mm', 'tg', 'Money movement');
            INSERT INTO import_batch VALUES ('b1', 'source:paypal');
            INSERT INTO txn VALUES ('t1', 'pp1', 'b1', NULL), ('t2', 'pp2', 'b1', NULL);
            -- Per-account money-movement rules (same keyword on two PayPal accounts → should consolidate to one).
            INSERT INTO category_rule VALUES ('r1', 'mm', 'general withdrawal', 'pp1', 1);
            INSERT INTO category_rule VALUES ('r2', 'mm', 'general withdrawal', 'pp2', 1);
            INSERT INTO category_rule VALUES ('r3', 'mm', 'account hold', 'pp1', 1);
            """
        )
        conn.commit()
        run_migrations(conn)  # applies v13

        cols = [r["name"] for r in conn.execute("PRAGMA table_info(category_rule)")]
        self.assertIn("account_type", cols)
        # Both PayPal-import accounts retyped; the non-PayPal account untouched.
        self.assertEqual(conn.execute("SELECT type FROM account WHERE id = 'pp1'").fetchone()["type"], "paypal")
        self.assertEqual(conn.execute("SELECT type FROM account WHERE id = 'pp2'").fetchone()["type"], "paypal")
        self.assertEqual(conn.execute("SELECT type FROM account WHERE id = 'chk'").fetchone()["type"], "depository")
        # The two 'general withdrawal' rules consolidated to one account_type='paypal' rule; 'account hold' too.
        gw = conn.execute("SELECT id, account_id, account_type FROM category_rule WHERE keyword = 'general withdrawal'").fetchall()
        self.assertEqual(len(gw), 1)
        self.assertIsNone(gw[0]["account_id"])
        self.assertEqual(gw[0]["account_type"], "paypal")
        hold = conn.execute("SELECT account_type FROM category_rule WHERE keyword = 'account hold'").fetchall()
        self.assertEqual([r["account_type"] for r in hold], ["paypal"])
        conn.close()


if __name__ == "__main__":
    unittest.main()
