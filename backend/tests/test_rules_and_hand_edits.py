"""
Rules and hand edits (services/categorizer.py → `decide_rule_effects`): a rule never overwrites a field set
by hand, and everything else it does still applies. Every matching rule's tags apply, and a tag removed by
hand stays removed except under a full-force apply. All data here is fabricated.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from pathlib import Path

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.rules import _apply_rule_to_existing
from backend.services.categorizer import recategorize_all


class RulesAndHandEditsTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "hand-edits.db"
        init_db(str(self.db_path))
        self.token = set_current_db_path(str(self.db_path))
        with get_db() as conn:
            conn.execute(
                """INSERT INTO account (id, external_account_id, provider, name, display_name, type, owner_id)
                   VALUES ('chk', 'x_chk', 'fixture', 'Riverstone Checking', 'Riverstone Checking', 'depository', ?)""",
                (SHARED_OWNER_ID,),
            )
            self.cats = {}
            for name in ("Lessons", "Fitness", "Gifts"):
                self.cats[name] = str(uuid.uuid4())
                conn.execute("INSERT INTO category (id, name, category_type) VALUES (?, ?, 'expense')",
                             (self.cats[name], name))
            self.kids = str(uuid.uuid4())
            conn.execute("INSERT INTO tag (id, name, color) VALUES (?, 'Kids', '#888888')", (self.kids,))
        # The specific rule outranks the broad one by its longer matcher.
        self.specific = self._rule("cedar studio", "Lessons", clean_name="Cedar Studio", tag=self.kids)
        self.broad = self._rule("studio", "Fitness")

    def tearDown(self):
        reset_current_db_path(self.token)
        self.tempdir.cleanup()

    def _rule(self, keyword, category, *, clean_name=None, tag=None):
        rule_id = str(uuid.uuid4())
        with get_db() as conn:
            conn.execute("INSERT INTO category_rule (id, category_id, keyword, clean_name) VALUES (?, ?, ?, ?)",
                         (rule_id, self.cats[category], keyword, clean_name))
            if tag:
                conn.execute("INSERT INTO rule_tag (rule_id, tag_id) VALUES (?, ?)", (rule_id, tag))
        return rule_id

    def _txn(self, *, category=None, source=None, overridden=0, name="CEDAR STUDIO 0412", name_source=None,
             split=0):
        txn_id = str(uuid.uuid4())
        with get_db() as conn:
            conn.execute(
                """INSERT INTO txn (id, account_id, owner_id, date, amount, raw_name, merchant_name, display_name,
                                    display_name_source, category_id, category_source, category_overridden, is_split)
                   VALUES (?, 'chk', ?, '2026-04-12', 40.0, 'CEDAR STUDIO 0412', 'CEDAR STUDIO 0412', ?, ?, ?, ?, ?, ?)""",
                (txn_id, SHARED_OWNER_ID, name, name_source, self.cats[category] if category else None, source,
                 overridden, split),
            )
        return txn_id

    def _row(self, txn_id):
        with get_db() as conn:
            return conn.execute(
                "SELECT category_id, category_source, display_name FROM txn WHERE id = ?", (txn_id,)).fetchone()

    def _has_kids_tag(self, txn_id):
        with get_db() as conn:
            row = conn.execute("SELECT rule_present, manual_state FROM txn_tag WHERE txn_id = ? AND tag_id = ?",
                               (txn_id, self.kids)).fetchone()
        return bool(row) and row["manual_state"] != -1

    def _recategorize(self):
        with get_db() as conn:
            recategorize_all(conn)

    def test_a_hand_set_category_keeps_its_category_and_takes_the_rename_and_tags(self):
        txn = self._txn(category="Gifts", source="manual", overridden=1)
        self._recategorize()
        row = self._row(txn)
        self.assertEqual((row["category_id"], row["category_source"]), (self.cats["Gifts"], "manual"))
        self.assertEqual(row["display_name"], "Cedar Studio")
        self.assertTrue(self._has_kids_tag(txn))

    def test_a_typed_name_keeps_the_name_and_the_category_still_follows_the_winning_rule(self):
        txn = self._txn(name="Saturday lessons", name_source="manual")
        self._recategorize()
        row = self._row(txn)
        self.assertEqual(row["display_name"], "Saturday lessons")
        self.assertEqual(row["category_id"], self.cats["Lessons"])    # not handed to the broad rule

    def test_a_split_row_takes_the_rename_and_tags(self):
        txn = self._txn(category="Gifts", source="split", overridden=1, split=1)
        self._recategorize()
        row = self._row(txn)
        self.assertEqual((row["category_id"], row["category_source"]), (self.cats["Gifts"], "split"))
        self.assertEqual(row["display_name"], "Cedar Studio")
        self.assertTrue(self._has_kids_tag(txn))

    def test_preserving_manual_leaves_a_matching_manual_category_manual_and_a_removed_tag_removed(self):
        txn = self._txn(category="Lessons", source="manual", overridden=1)
        with get_db() as conn:
            conn.execute("INSERT INTO txn_tag (txn_id, tag_id, rule_present, manual_state) VALUES (?, ?, 1, -1)",
                         (txn, self.kids))
            _apply_rule_to_existing(conn, self.specific, preserve_manual=True)
        self.assertEqual(self._row(txn)["category_source"], "manual")
        self.assertFalse(self._has_kids_tag(txn))

    def test_full_force_overrides_what_was_set_by_hand(self):
        txn = self._txn(category="Gifts", source="manual", overridden=1, name="Saturday lessons", name_source="manual")
        with get_db() as conn:
            conn.execute("INSERT INTO txn_tag (txn_id, tag_id, rule_present, manual_state) VALUES (?, ?, 1, -1)",
                         (txn, self.kids))
            _apply_rule_to_existing(conn, self.specific)
        row = self._row(txn)
        self.assertEqual((row["category_id"], row["category_source"]), (self.cats["Lessons"], "rule"))
        self.assertEqual(row["display_name"], "Cedar Studio")
        self.assertTrue(self._has_kids_tag(txn))


if __name__ == "__main__":
    unittest.main()
