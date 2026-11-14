"""
Whose transactions a rule reaches, as the owner lens on the Rules page reads it
(`services/rule_owner_reach.py`).
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import get_db, init_db, reset_current_db_path, set_current_db_path
from backend.services.rule_owner_reach import rule_owner_reach


class RuleOwnerReachTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "rule-owner-reach.db"
        init_db(str(self.db_path))
        self.alex, self.robin = str(uuid.uuid4()), str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute("INSERT INTO owner (id, name) VALUES (?, 'Alex')", (self.alex,))
            conn.execute("INSERT INTO owner (id, name) VALUES (?, 'Robin')", (self.robin,))
            self.leaf = str(uuid.uuid4())
            conn.execute("INSERT INTO category (id, name, category_type) VALUES (?, 'Fun', 'expense')", (self.leaf,))
            self.alex_card = self._account(conn, self.alex)
            self.robin_card = self._account(conn, self.robin)
            self.loose_card = self._account(conn, None)
            for account, merchant in (
                (self.alex_card, "NETFLIX.COM"), (self.alex_card, "Coffee Bar"),
                (self.robin_card, "Coffee Bar"), (self.loose_card, "Bakery"),
            ):
                owner = conn.execute("SELECT owner_id FROM account WHERE id = ?", (account,)).fetchone()[0]
                conn.execute(
                    "INSERT INTO txn (id, account_id, date, amount, merchant_name, raw_name, owner_id, is_pending, "
                    "needs_review) VALUES (?, ?, '2026-05-10', 9.0, ?, ?, ?, 0, 0)",
                    (str(uuid.uuid4()), account, merchant, merchant, owner),
                )

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    @staticmethod
    def _account(conn, owner_id):
        account_id = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO account (id, external_account_id, provider, name, display_name, type, subtype, mask, "
            "owner_id) VALUES (?, ?, 'fixture', 'Card', 'Card', 'credit', 'credit', '1111', ?)",
            (account_id, f"ext_{account_id}", owner_id),
        )
        return account_id

    def _rule(self, keyword, *, owner_id=None, account_id=None):
        rule_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "INSERT INTO category_rule (id, category_id, keyword, owner_id, account_id) VALUES (?, ?, ?, ?, ?)",
                (rule_id, self.leaf, keyword, owner_id, account_id),
            )
        return rule_id

    def _reach(self):
        with self._use_db_path(), get_db() as conn:
            return rule_owner_reach(conn)

    def test_an_unscoped_rule_reaches_the_owners_of_the_rows_it_matches(self):
        netflix = self._rule("netflix")
        coffee = self._rule("coffee")
        bakery = self._rule("bakery")
        reach = self._reach()
        self.assertEqual(reach[netflix], [self.alex])
        self.assertEqual(reach[coffee], sorted([self.alex, self.robin]))
        self.assertEqual(reach[bakery], ["unassigned"])

    def test_a_scoped_rule_reaches_its_scope_even_before_it_matches(self):
        robin_only = self._rule("nothing matches this", owner_id=self.robin)
        loose_account = self._rule("nor this", account_id=self.loose_card)
        reach = self._reach()
        self.assertEqual(reach[robin_only], [self.robin])
        self.assertEqual(reach[loose_account], ["unassigned"])

    def test_an_unscoped_rule_with_no_matches_reaches_no_one(self):
        rule = self._rule("nothing matches this")
        self.assertEqual(self._reach()[rule], [])

    def test_the_cached_reach_follows_a_new_matching_row(self):
        # The answer is cached against an epoch the triggers move; a row arriving for another owner has to
        # show up in the next read rather than wait for a restart.
        netflix = self._rule("netflix")
        self.assertEqual(self._reach()[netflix], [self.alex])
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "INSERT INTO txn (id, account_id, date, amount, merchant_name, raw_name, owner_id, is_pending, "
                "needs_review) VALUES (?, ?, '2026-05-11', 9.0, 'NETFLIX.COM', 'NETFLIX.COM', ?, 0, 0)",
                (str(uuid.uuid4()), self.robin_card, self.robin),
            )
        self.assertEqual(self._reach()[netflix], sorted([self.alex, self.robin]))

    def test_an_amount_condition_is_judged_against_every_row(self):
        # Rules that read more than names are tested against whole rows, not the distinct names.
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "INSERT INTO txn (id, account_id, date, amount, merchant_name, raw_name, owner_id, is_pending, "
                "needs_review) VALUES (?, ?, '2026-05-11', 90.0, 'Coffee Bar', 'Coffee Bar', ?, 0, 0)",
                (str(uuid.uuid4()), self.robin_card, self.robin),
            )
        rule_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "INSERT INTO category_rule (id, category_id, keyword, amount_min) VALUES (?, ?, 'coffee', 50)",
                (rule_id, self.leaf),
            )
        self.assertEqual(self._reach()[rule_id], [self.robin])


if __name__ == "__main__":
    unittest.main()
