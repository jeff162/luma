"""
A rule's priority, the one precedence term the user sets.

It is read before every inferred term, so a low-priority rule loses even to a shorter keyword it merely
co-matches with. These tests pin that through the paths that must agree on it: what a priority edit does
to the rows already categorized, what the checkup reports, and the conflict note a categorization pass
left behind.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.rules import RuleUpdate, update_rule
from backend.services import rule_conflicts
from backend.services.categorizer import RULE_PRIORITY_LOW, recategorize_all
from backend.services.rule_overlaps import find_rule_overlaps


class RulePriorityTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "rule-priority.db"
        init_db(str(self.db_path))
        self.account_id = str(uuid.uuid4())
        with self._db() as conn:
            conn.execute(
                "INSERT INTO account (id, provider, name, display_name, type) "
                "VALUES (?, 'fixture', 'Rewards Card', 'Rewards Card', 'credit')",
                (self.account_id,),
            )
            unassigned = conn.execute("SELECT id FROM category WHERE system_key = 'unassigned'").fetchone()["id"]
            self.payment_category = self._category(conn, unassigned, "Card payment")
            self.insurance_category = self._category(conn, unassigned, "Insurance")

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

    @staticmethod
    def _category(conn, parent_id, name):
        category_id = str(uuid.uuid4())
        conn.execute("INSERT INTO category (id, parent_id, name) VALUES (?, ?, ?)", (category_id, parent_id, name))
        return category_id

    def _rule(self, keyword, category_id, *, priority_level=0):
        rule_id = str(uuid.uuid4())
        with self._db() as conn:
            conn.execute(
                "INSERT INTO category_rule (id, category_id, keyword, priority_level) VALUES (?, ?, ?, ?)",
                (rule_id, category_id, keyword, priority_level),
            )
        return rule_id

    def _txn(self, name):
        txn_id = str(uuid.uuid4())
        with self._db() as conn:
            conn.execute(
                "INSERT INTO txn (id, account_id, date, amount, raw_name, display_name) VALUES (?, ?, '2026-03-01', 120.0, ?, ?)",
                (txn_id, self.account_id, name, name),
            )
        return txn_id

    def _category_of(self, txn_id):
        with self._db() as conn:
            return conn.execute("SELECT category_id FROM txn WHERE id = ?", (txn_id,)).fetchone()["category_id"]

    def _findings(self):
        with self._db() as conn:
            return find_rule_overlaps(conn)["findings"]

    def test_lowering_a_generic_rule_hands_its_co_matches_to_the_payee_rule(self):
        generic = self._rule("electronic payment", self.payment_category)
        self._rule("northgate", self.insurance_category)
        txn = self._txn("NORTHGATE MUTUAL INS ELECTRONIC PAYMENT")
        with self._db() as conn:
            recategorize_all(conn)
        # The longer keyword wins on length alone, which the checkup and the pass both call arbitrary.
        self.assertEqual(self._category_of(txn), self.payment_category)
        self.assertEqual([f["kind"] for f in self._findings()], ["matcher_co_match"])
        with self._db() as conn:
            self.assertEqual(len(rule_conflicts.open_conflicts(conn)), 1)

        token = set_current_db_path(str(self.db_path))
        try:
            update_rule(generic, RuleUpdate(priority_level=RULE_PRIORITY_LOW))
        finally:
            reset_current_db_path(token)

        # The edit itself moves the row; no separate Categorize is needed for the priority to mean anything.
        self.assertEqual(self._category_of(txn), self.insurance_category)
        self.assertEqual(self._findings(), [])
        with self._db() as conn:
            self.assertEqual(rule_conflicts.open_conflicts(conn), [])

    def test_a_low_rule_inside_a_broader_one_is_reported_when_it_changes_the_outcome(self):
        broader = self._rule("northgate", self.payment_category)
        narrower = self._rule("northgate mutual", self.insurance_category, priority_level=RULE_PRIORITY_LOW)
        findings = self._findings()
        self.assertEqual([f["kind"] for f in findings], ["matcher_priority_shadow"])
        self.assertEqual(findings[0]["winner_rule_id"], broader)
        self.assertEqual(findings[0]["rule_ids"], [broader, narrower])
        self.assertEqual(findings[0]["severity"], "warning")
        self.assertTrue(findings[0]["dismissible"])

        # Doing the same thing, the pair is an ordinary nesting: which one wins changes nothing.
        with self._db() as conn:
            conn.execute("UPDATE category_rule SET category_id = ? WHERE id = ?", (self.payment_category, narrower))
        self.assertEqual([f["kind"] for f in self._findings()], ["matcher_nesting"])


if __name__ == "__main__":
    unittest.main()
