"""
Rule conflicts recorded as the rules are applied.

The pairs recorded must be exactly the checkup's warnings, met on a transaction the rules decide: two
rules picked between arbitrarily that do different things. Most of these tests pin the pairs that must
not be recorded, since a Tasks card raised by an ordinary refinement (`amazon` beside `amazon prime`)
would come back on every import. The rest pin the read side: a recorded pair is re-tested each time it
is counted, so an edit that resolves it clears it without another pass.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.tasks import _rule_conflict_tasks
from backend.services import rule_conflicts
from backend.services.categorizer import recategorize_all
from backend.services.rule_overlaps import find_rule_overlaps


class RuleConflictTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "rule-conflicts.db"
        init_db(str(self.db_path))
        self.account_id = str(uuid.uuid4())
        with self._db() as conn:
            conn.execute(
                "INSERT INTO account (id, provider, name, display_name, type) "
                "VALUES (?, 'fixture', 'Harborline Checking', 'Harborline Checking', 'depository')",
                (self.account_id,),
            )
            unassigned = conn.execute("SELECT id FROM category WHERE system_key = 'unassigned'").fetchone()["id"]
            self.category_id = str(uuid.uuid4())
            conn.execute("INSERT INTO category (id, parent_id, name) VALUES (?, ?, 'Supplies')",
                         (self.category_id, unassigned))
            self.other_category_id = str(uuid.uuid4())
            conn.execute("INSERT INTO category (id, parent_id, name) VALUES (?, ?, 'Travel')",
                         (self.other_category_id, unassigned))

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

    def _rule(self, keyword, *, category_id=None, amount_min=None, amount_max=None):
        rule_id = str(uuid.uuid4())
        with self._db() as conn:
            conn.execute(
                "INSERT INTO category_rule (id, category_id, keyword, amount_min, amount_max) VALUES (?, ?, ?, ?, ?)",
                (rule_id, category_id or self.category_id, keyword, amount_min, amount_max),
            )
        return rule_id

    def _txn(self, name, *, amount=100.0, date="2026-03-01", is_pending=0, category_overridden=0):
        txn_id = str(uuid.uuid4())
        with self._db() as conn:
            conn.execute(
                """INSERT INTO txn (id, account_id, date, amount, raw_name, display_name, is_pending,
                                    category_overridden)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (txn_id, self.account_id, date, amount, name, name, is_pending, category_overridden),
            )
        return txn_id

    def _categorize(self):
        with self._db() as conn:
            recategorize_all(conn)

    def _open(self):
        with self._db() as conn:
            return rule_conflicts.open_conflicts(conn)

    def _stored(self):
        with self._db() as conn:
            return conn.execute("SELECT rule_id_low, rule_id_high, txn_id FROM rule_conflict").fetchall()

    def _conflicting_pair(self):
        first = self._rule("northgate")
        second = self._rule("riverstone", category_id=self.other_category_id)
        return first, second

    # --- What is recorded ------------------------------------------------------------------------------

    def test_unrelated_keywords_doing_different_things_are_recorded(self):
        first, second = self._conflicting_pair()
        txn_id = self._txn("NORTHGATE RIVERSTONE SUPPLY")
        self._categorize()
        conflicts = self._open()
        self.assertEqual(len(conflicts), 1)
        self.assertEqual(sorted(conflicts[0]["rule_ids"]), sorted([first, second]))
        self.assertEqual(conflicts[0]["txn_id"], txn_id)
        self.assertEqual(conflicts[0]["kind"], "matcher_co_match")

    def test_every_recorded_pair_is_a_checkup_warning(self):
        first, second = self._conflicting_pair()
        self._txn("NORTHGATE RIVERSTONE SUPPLY")
        self._categorize()
        with self._db() as conn:
            warnings = [f for f in find_rule_overlaps(conn)["findings"] if f["severity"] == "warning"]
        self.assertEqual([sorted(f["rule_ids"]) for f in warnings], [sorted([first, second])])

    def test_partly_overlapping_amount_ranges_are_recorded(self):
        self._rule("northgate", amount_min=300, amount_max=4000)
        self._rule("northgate", category_id=self.other_category_id, amount_min=3000)
        self._txn("NORTHGATE UTILITY", amount=3500)
        self._categorize()
        self.assertEqual([c["kind"] for c in self._open()], ["amount_overlap"])

    def test_a_keyword_inside_another_is_a_refinement_and_not_recorded(self):
        self._rule("amazon")
        self._rule("amazon prime", category_id=self.other_category_id)
        self._txn("AMAZON PRIME MEMBERSHIP")
        self._categorize()
        self.assertEqual(self._stored(), [])

    def test_a_pair_doing_the_same_thing_is_not_recorded(self):
        self._rule("northgate")
        self._rule("riverstone")
        self._txn("NORTHGATE RIVERSTONE SUPPLY")
        self._categorize()
        self.assertEqual(self._stored(), [])

    def test_a_rename_only_one_rule_carries_is_not_recorded(self):
        # It applies whichever rule wins, so the pick changes nothing.
        self._rule("northgate")
        second = self._rule("riverstone")
        with self._db() as conn:
            conn.execute("UPDATE category_rule SET clean_name = 'Riverstone' WHERE id = ?", (second,))
        self._txn("NORTHGATE RIVERSTONE SUPPLY")
        self._categorize()
        self.assertEqual(self._stored(), [])

    def test_a_pending_row_is_not_evidence(self):
        self._conflicting_pair()
        txn_id = self._txn("NORTHGATE RIVERSTONE SUPPLY", is_pending=1)
        with self._db() as conn:
            rule_conflicts.record_for_txns(conn, [txn_id])
        self.assertEqual(self._stored(), [])

    def test_a_row_categorized_by_hand_is_not_evidence(self):
        self._conflicting_pair()
        txn_id = self._txn("NORTHGATE RIVERSTONE SUPPLY", category_overridden=1)
        with self._db() as conn:
            rule_conflicts.record_for_txns(conn, [txn_id])
        self.assertEqual(self._stored(), [])

    def test_a_pair_is_recorded_once_with_its_newest_transaction(self):
        self._conflicting_pair()
        self._txn("NORTHGATE RIVERSTONE SUPPLY", date="2026-01-05")
        newest = self._txn("NORTHGATE RIVERSTONE SUPPLY", date="2026-04-05")
        self._txn("NORTHGATE RIVERSTONE SUPPLY", date="2026-02-05")
        self._categorize()
        stored = self._stored()
        self.assertEqual(len(stored), 1)
        self.assertEqual(stored[0]["txn_id"], newest)

    # --- Re-tested on read -----------------------------------------------------------------------------

    def test_an_edit_that_resolves_the_pair_clears_it_without_another_pass(self):
        _first, second = self._conflicting_pair()
        self._txn("NORTHGATE RIVERSTONE SUPPLY")
        self._categorize()
        with self._db() as conn:
            conn.execute("UPDATE category_rule SET category_id = ? WHERE id = ?", (self.category_id, second))
        self.assertEqual(self._open(), [])
        self.assertEqual(self._stored(), [])

    def test_a_trashed_rule_clears_the_pair(self):
        _first, second = self._conflicting_pair()
        self._txn("NORTHGATE RIVERSTONE SUPPLY")
        self._categorize()
        with self._db() as conn:
            conn.execute("UPDATE category_rule SET deleted_at = datetime('now') WHERE id = ?", (second,))
        self.assertEqual(self._open(), [])

    def test_a_trashed_example_clears_the_pair(self):
        self._conflicting_pair()
        txn_id = self._txn("NORTHGATE RIVERSTONE SUPPLY")
        self._categorize()
        with self._db() as conn:
            conn.execute("UPDATE txn SET trashed_at = datetime('now') WHERE id = ?", (txn_id,))
        self.assertEqual(self._open(), [])

    # --- The Tasks entry -------------------------------------------------------------------------------

    def test_the_task_counts_open_pairs(self):
        self._conflicting_pair()
        self._txn("NORTHGATE RIVERSTONE SUPPLY")
        with self._db() as conn:
            self.assertEqual(_rule_conflict_tasks(conn), [])
        self._categorize()
        with self._db() as conn:
            tasks = _rule_conflict_tasks(conn)
        self.assertEqual([(t["id"], t["count"]) for t in tasks], [("rule_conflict", 1)])
        self.assertEqual(tasks[0]["link"], "/rules?findings=conflicts")


if __name__ == "__main__":
    unittest.main()
