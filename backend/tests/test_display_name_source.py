"""
Provenance for `txn.display_name` (`display_name_source`), the display-name analog of `category_source`.

Pins the three behaviors that make "a manual rename wins forever" real:
  1. the migration backfill re-derives provenance with no stored rule_id — rule-authored / manual / import;
  2. a manual rename stamps 'manual';
  3. `recategorize_all` (the automatic pass that must never undo a deliberate choice) leaves a manual
     name alone while still recategorizing the row, and authors 'rule' on a non-manual name.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import (
    SHARED_OWNER_ID,
    _backfill_display_name_source,
    get_db,
    init_db,
    reset_current_db_path,
    set_current_db_path,
)
from backend.services.categorizer import recategorize_all
from backend.routers.transactions import update_merchant


class DisplayNameSourceTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "display-name-source.db"
        init_db(str(self.db_path))

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _account(self):
        account_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO account
                     (id, external_account_id, provider, name, display_name, type, subtype, mask, owner_id)
                   VALUES (?, ?, 'fixture', 'Checking', 'Checking', 'checking', 'checking', '1234', ?)""",
                (account_id, f"plaid_{account_id}", SHARED_OWNER_ID),
            )
        return account_id

    def _expense_leaf(self, name="Coffee"):
        category_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            group = conn.execute(
                "SELECT id FROM category WHERE category_type = 'expense' AND parent_id IS NULL LIMIT 1"
            ).fetchone()
            conn.execute(
                "INSERT INTO category (id, parent_id, name, category_type, sort_order) VALUES (?, ?, ?, 'expense', 0)",
                (category_id, group["id"], name),
            )
        return category_id

    def _rule(self, *, keyword, clean_name=None, category_id=None):
        rule_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO category_rule
                     (id, category_id, keyword, amount_min, amount_max, debit_credit, clean_name, owner_id, account_id)
                   VALUES (?, ?, ?, NULL, NULL, 'both', ?, NULL, NULL)""",
                (rule_id, category_id, keyword, clean_name),
            )
        return rule_id

    def _txn(self, *, account_id, merchant, raw=None, display_name=None,
             display_name_source=None, category_overridden=0, category_source=None):
        txn_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO txn
                     (id, account_id, owner_id, category_id, amount, merchant_name, display_name, raw_name,
                      date, is_pending, category_overridden, category_source, display_name_source)
                   VALUES (?, ?, ?, NULL, 12.00, ?, ?, ?, '2026-04-23', 0, ?, ?, ?)""",
                (txn_id, account_id, SHARED_OWNER_ID, merchant, display_name if display_name is not None else merchant,
                 raw if raw is not None else merchant, category_overridden, category_source, display_name_source),
            )
        return txn_id

    def _source_of(self, txn_id):
        with self._use_db_path(), get_db() as conn:
            row = conn.execute(
                "SELECT display_name, display_name_source, category_id, category_source FROM txn WHERE id = ?",
                (txn_id,),
            ).fetchone()
        return row

    # --- backfill --------------------------------------------------------------------------------

    def test_backfill_rederives_rule_manual_and_import(self):
        account_id = self._account()
        cat = self._expense_leaf("Coffee")
        # A rule whose clean_name matches a row's display_name and whose keyword matches it → 'rule'.
        self._rule(keyword="blue bottle", clean_name="Blue Bottle Coffee", category_id=cat)
        rule_named = self._txn(account_id=account_id, merchant="BLUE BOTTLE #42", display_name="Blue Bottle Coffee")
        # display_name differs from both merchant and raw, no rule explains it → 'manual'.
        manual = self._txn(account_id=account_id, merchant="SQ *CORNER STORE", raw="SQ *CORNER STORE",
                           display_name="Corner Store")
        # display_name equals the imported merchant → 'import'.
        imported = self._txn(account_id=account_id, merchant="WHOLE FOODS", display_name="WHOLE FOODS")
        # No display_name → nothing to attribute, stays NULL.
        nameless = self._txn(account_id=account_id, merchant="", raw="", display_name="")

        with self._use_db_path(), get_db() as conn:
            _backfill_display_name_source(conn)

        self.assertEqual(self._source_of(rule_named)["display_name_source"], "rule")
        self.assertEqual(self._source_of(manual)["display_name_source"], "manual")
        self.assertEqual(self._source_of(imported)["display_name_source"], "import")
        self.assertIsNone(self._source_of(nameless)["display_name_source"])

    # --- manual writer ---------------------------------------------------------------------------

    def test_manual_rename_stamps_manual(self):
        account_id = self._account()
        txn_id = self._txn(account_id=account_id, merchant="WHOLE FOODS", display_name="WHOLE FOODS",
                           display_name_source="import")
        with self._use_db_path():
            update_merchant(txn_id, {"merchant_name": "Whole Foods Market"})
        row = self._source_of(txn_id)
        self.assertEqual(row["display_name"], "Whole Foods Market")
        self.assertEqual(row["display_name_source"], "manual")

    # --- recategorize_all: manual name protected, rule name authored ------------------------------

    def test_recategorize_protects_a_manual_name_but_still_recategorizes(self):
        account_id = self._account()
        cat = self._expense_leaf("Coffee")
        self._rule(keyword="blue bottle", clean_name="Blue Bottle Coffee", category_id=cat)
        # Manually renamed row, no manual category lock (category_overridden=0) so recategorize sees it.
        txn_id = self._txn(account_id=account_id, merchant="BLUE BOTTLE #42", raw="BLUE BOTTLE #42",
                           display_name="My Coffee Spot", display_name_source="manual")
        with self._use_db_path(), get_db() as conn:
            recategorize_all(conn)
        row = self._source_of(txn_id)
        self.assertEqual(row["display_name"], "My Coffee Spot")     # manual name untouched
        self.assertEqual(row["display_name_source"], "manual")      # provenance preserved
        self.assertEqual(row["category_id"], cat)                   # but the row is still recategorized
        self.assertEqual(row["category_source"], "rule")

    def test_recategorize_authors_rule_name_on_a_non_manual_row(self):
        account_id = self._account()
        cat = self._expense_leaf("Coffee")
        self._rule(keyword="blue bottle", clean_name="Blue Bottle Coffee", category_id=cat)
        txn_id = self._txn(account_id=account_id, merchant="BLUE BOTTLE #42", raw="BLUE BOTTLE #42",
                           display_name="BLUE BOTTLE #42", display_name_source="import")
        with self._use_db_path(), get_db() as conn:
            recategorize_all(conn)
        row = self._source_of(txn_id)
        self.assertEqual(row["display_name"], "Blue Bottle Coffee")
        self.assertEqual(row["display_name_source"], "rule")


if __name__ == "__main__":
    unittest.main()
