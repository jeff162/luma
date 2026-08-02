"""
Retain-vs-reconcile behavior of `recategorize_all`.

The default is **retain**: the pass is monotonic — it only sets or changes a category/rule-tag, never
strips one. So deleting an obsolete rule (or narrowing its scope, or a routine Run categorization) leaves
the transactions it already categorized alone. **Reconcile** (clear a no-match rule row) is the opt-in,
scoped path used by the rule delete/edit "re-evaluate this rule's transactions" control and the
money-movement "remove a type" flow.

All data here is fabricated.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.services.categorizer import recategorize_all
from backend.routers.rules import RuleUpdate, delete_rule, update_rule


class RecategorizeRetainTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "retain.db"
        init_db(str(self.db_path))
        with self._use_db(), get_db() as conn:
            conn.execute(
                """INSERT INTO account (id, external_account_id, provider, name, display_name, type, owner_id)
                   VALUES ('acct', 'p_acct', 'fix', 'Checking', 'Checking', 'depository', ?)""",
                (SHARED_OWNER_ID,),
            )
            grp = str(uuid.uuid4())
            conn.execute("INSERT INTO category (id, parent_id, name, category_type) VALUES (?, NULL, 'Food', 'expense')", (grp,))
            self.coffee = str(uuid.uuid4())
            self.dining = str(uuid.uuid4())
            conn.execute("INSERT INTO category (id, parent_id, name, category_type) VALUES (?, ?, 'Coffee', 'expense')", (self.coffee, grp))
            conn.execute("INSERT INTO category (id, parent_id, name, category_type) VALUES (?, ?, 'Dining', 'expense')", (self.dining, grp))

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    # --- fixtures ---------------------------------------------------------------------------------

    def _txn(self, merchant):
        tid = str(uuid.uuid4())
        with self._use_db(), get_db() as conn:
            conn.execute(
                """INSERT INTO txn (id, account_id, owner_id, amount, merchant_name, display_name, raw_name, date, is_pending)
                   VALUES (?, 'acct', ?, 5.00, ?, ?, ?, '2026-01-01', 0)""",
                (tid, SHARED_OWNER_ID, merchant, merchant, merchant),
            )
        return tid

    def _rule(self, keyword, category_id, *, tag_id=None):
        rid = str(uuid.uuid4())
        with self._use_db(), get_db() as conn:
            conn.execute(
                "INSERT INTO category_rule (id, category_id, keyword) VALUES (?, ?, ?)", (rid, category_id, keyword)
            )
            if tag_id:
                conn.execute("INSERT INTO rule_tag (rule_id, tag_id) VALUES (?, ?)", (rid, tag_id))
        return rid

    def _tag(self, name):
        tid = str(uuid.uuid4())
        with self._use_db(), get_db() as conn:
            conn.execute("INSERT INTO tag (id, name, color) VALUES (?, ?, '#888')", (tid, name))
        return tid

    def _cat(self, txn_id):
        with self._use_db(), get_db() as conn:
            row = conn.execute("SELECT category_id, category_source, category_overridden FROM txn WHERE id = ?", (txn_id,)).fetchone()
        return dict(row)

    def _has_rule_tag(self, txn_id, tag_id):
        with self._use_db(), get_db() as conn:
            row = conn.execute("SELECT rule_present FROM txn_tag WHERE txn_id = ? AND tag_id = ?", (txn_id, tag_id)).fetchone()
        return bool(row and row["rule_present"])

    def _recategorize(self):
        with self._use_db(), get_db() as conn:
            return recategorize_all(conn)

    # --- category retain / reconcile --------------------------------------------------------------

    def test_delete_rule_retains_the_category_by_default(self):
        txn = self._txn("Starbucks")
        rid = self._rule("star", self.coffee)
        self._recategorize()
        self.assertEqual(self._cat(txn)["category_id"], self.coffee)
        # Delete without reconcile, then a routine Run categorization: the category must survive.
        with self._use_db():
            delete_rule(rid)
        self._recategorize()
        self.assertEqual(self._cat(txn)["category_id"], self.coffee, "retain: a deleted rule's categorization stays")
        self.assertEqual(self._cat(txn)["category_source"], "rule")

    def test_delete_rule_with_reconcile_reverts_its_rows(self):
        txn = self._txn("Starbucks")
        rid = self._rule("star", self.coffee)
        self._recategorize()
        with self._use_db():
            delete_rule(rid, reconcile=True)  # the "this rule was wrong" path
        self.assertIsNone(self._cat(txn)["category_id"], "reconcile: the rule's rows revert to uncategorized")
        self.assertIsNone(self._cat(txn)["category_source"])

    def test_narrowing_a_rule_retains_out_of_scope_rows_by_default(self):
        keep = self._txn("Starbucks")
        drop = self._txn("Star Market")
        rid = self._rule("star", self.coffee)
        self._recategorize()
        with self._use_db():
            update_rule(rid, RuleUpdate(keyword="starbucks"))
        self._recategorize()
        self.assertEqual(self._cat(keep)["category_id"], self.coffee)
        self.assertEqual(self._cat(drop)["category_id"], self.coffee, "retain: a row dropped by a narrowed rule keeps its category")

    def test_narrowing_a_rule_with_reconcile_reverts_only_the_dropped_rows(self):
        keep = self._txn("Starbucks")
        drop = self._txn("Star Market")
        rid = self._rule("star", self.coffee)
        self._recategorize()
        with self._use_db():
            update_rule(rid, RuleUpdate(keyword="starbucks"), reconcile=True)
        self.assertEqual(self._cat(keep)["category_id"], self.coffee, "the still-matched row keeps the category")
        self.assertIsNone(self._cat(drop)["category_id"], "the dropped row is reconciled to uncategorized")

    def test_a_retained_row_is_still_reclaimable_by_a_new_rule(self):
        txn = self._txn("Star Market")
        rid = self._rule("star", self.coffee)
        self._recategorize()
        with self._use_db():
            delete_rule(rid)  # retain: keeps Coffee, stays overridden=0
        self.assertEqual(self._cat(txn)["category_overridden"], 0)
        # A new rule for the same merchant reclaims it on the next pass (retain never locks the row).
        self._rule("star market", self.dining)
        self._recategorize()
        self.assertEqual(self._cat(txn)["category_id"], self.dining, "a retained rule-row is not locked; a new rule reclaims it")

    def test_reconcile_leaves_a_manual_edit_alone(self):
        txn = self._txn("Starbucks")
        rid = self._rule("star", self.coffee)
        self._recategorize()
        # Make it a manual override (locked), then delete-with-reconcile: the manual choice must survive.
        with self._use_db(), get_db() as conn:
            conn.execute("UPDATE txn SET category_id = ?, category_source = 'manual', category_overridden = 1 WHERE id = ?", (self.dining, txn))
        with self._use_db():
            delete_rule(rid, reconcile=True)
        self.assertEqual(self._cat(txn)["category_id"], self.dining, "reconcile never touches a manual override")

    # --- tags follow categories -------------------------------------------------------------------

    def test_delete_rule_retains_its_tag_by_default(self):
        txn = self._txn("Netflix")
        tag = self._tag("Subscription")
        rid = self._rule("netflix", self.dining, tag_id=tag)
        self._recategorize()
        self.assertTrue(self._has_rule_tag(txn, tag))
        with self._use_db():
            delete_rule(rid)
        self._recategorize()
        self.assertTrue(self._has_rule_tag(txn, tag), "retain: a rule-applied tag survives the rule (like the category)")

    def test_delete_rule_with_reconcile_removes_its_tag(self):
        txn = self._txn("Netflix")
        tag = self._tag("Subscription")
        rid = self._rule("netflix", self.dining, tag_id=tag)
        self._recategorize()
        self.assertTrue(self._has_rule_tag(txn, tag))
        with self._use_db():
            delete_rule(rid, reconcile=True)
        self.assertFalse(self._has_rule_tag(txn, tag), "reconcile: tags follow the category out")


if __name__ == "__main__":
    unittest.main()
