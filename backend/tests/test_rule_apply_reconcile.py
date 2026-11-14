"""
Contract behind the in-place "rule apply" reconcile on the dashboard/detail surfaces:

  1. `_apply_rule_to_existing` returns the ids of the rows it actually changed (not just a count), and
  2. the transaction-list endpoint's `ids=` filter re-fetches exactly those rows.

The frontend chains the two — apply returns the changed ids, then it re-fetches them by id and merges them
back in place so recategorized rows stay on a scoped view (e.g. "uncategorized only") instead of vanishing.
A regression in either half silently breaks that reconcile, so both are pinned here.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.rules import RulePreview, _apply_rule_to_existing, preview_rule
from backend.routers.transactions import (
    list_transactions,
    restore_categorization_rows,
)


def _list_by_ids(ids):
    # list_transactions is a FastAPI handler; called directly every Query param must be passed explicitly
    # (an unset one stays a FieldInfo, not its default), so spell them all out and vary only `ids`.
    return list_transactions(
        month=None, date_start=None, date_end=None, import_batch_id=None,
        sort_by="date", sort_dir="desc", account_id=None, category_id=None, direction=None, view=None, search=None,
        quick_filter=None, ids=ids, include_trashed=False, limit=200, offset=0,
    )


class RuleApplyReconcileTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "rule-apply-reconcile.db"
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

    def _account(self, name="Primary Checking"):
        account_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO account
                     (id, external_account_id, provider, name, display_name, type, subtype, mask, owner_id, parent_account_id, trashed_at)
                   VALUES (?, ?, 'fixture', ?, ?, 'checking', 'checking', '1234', ?, NULL, NULL)""",
                (account_id, f"plaid_{account_id}", name, name, SHARED_OWNER_ID),
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

    def _rule(self, *, category_id, keyword):
        rule_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO category_rule
                     (id, category_id, keyword, amount_min, amount_max, debit_credit, clean_name, owner_id, account_id)
                   VALUES (?, ?, ?, NULL, NULL, 'both', NULL, NULL, NULL)""",
                (rule_id, category_id, keyword),
            )
        return rule_id

    def _txn(self, *, account_id, merchant):
        txn_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO txn
                     (id, account_id, owner_id, category_id, amount, merchant_name, display_name, raw_name, date, is_pending, category_overridden)
                   VALUES (?, ?, ?, NULL, 12.00, ?, ?, ?, '2026-04-23', 0, 0)""",
                (txn_id, account_id, SHARED_OWNER_ID, merchant, merchant, merchant),
            )
        return txn_id

    def test_apply_returns_changed_ids_and_ids_filter_refetches_them(self):
        account_id = self._account()
        category_id = self._expense_leaf("Coffee")
        rule_id = self._rule(category_id=category_id, keyword="blue bottle")
        match_a = self._txn(account_id=account_id, merchant="BLUE BOTTLE COFFEE")
        match_b = self._txn(account_id=account_id, merchant="Blue Bottle #42")
        other = self._txn(account_id=account_id, merchant="WHOLE FOODS")

        with self._use_db_path(), get_db() as conn:
            affected = _apply_rule_to_existing(conn, rule_id)

        # Apply reports exactly the two matching rows, not the unrelated one.
        self.assertEqual(set(affected), {match_a, match_b})

        with self._use_db_path():
            refetched = _list_by_ids(",".join(affected))

        ids = {row["id"] for row in refetched["transactions"]}
        self.assertEqual(ids, {match_a, match_b})
        self.assertNotIn(other, ids)
        # Every re-fetched row carries the rule's category, which is what the frontend merges back in place.
        for row in refetched["transactions"]:
            self.assertEqual(row["category_id"], category_id)

    def test_a_scoped_apply_captures_prior_rows_that_restore_round_trips(self):
        # The undo of an accepted rule-suggestion relies on this: a capturing apply hands back each changed
        # row's prior categorization snapshot, which `restore_categorization_rows` puts back exactly.
        # Without it, undo can't reverse the accept and the suggestion is lost (its rows stay rule-claimed).
        account_id = self._account()
        prior_cat = self._expense_leaf("Groceries")
        rule_cat = self._expense_leaf("Coffee")
        rule_id = self._rule(category_id=rule_cat, keyword="blue bottle")
        # A row currently import-categorized to a *different* category, which the rule overwrites.
        txn_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO txn
                     (id, account_id, owner_id, category_id, amount, merchant_name, display_name, raw_name, date, is_pending, category_overridden, category_source)
                   VALUES (?, ?, ?, ?, 9.00, 'BLUE BOTTLE', 'BLUE BOTTLE', 'BLUE BOTTLE', '2026-04-23', 0, 0, 'import')""",
                (txn_id, account_id, SHARED_OWNER_ID, prior_cat),
            )

        prior_rows: list = []
        with self._use_db_path(), get_db() as conn:
            affected_ids = _apply_rule_to_existing(
                conn, rule_id, preserve_manual=True, txn_ids=[txn_id], capture_prior=prior_rows,
            )

        # The row moved to the rule's category, and its pre-apply state is captured for undo.
        self.assertEqual(affected_ids, [txn_id])
        self.assertEqual(len(prior_rows), 1)
        prior = prior_rows[0]
        self.assertEqual(prior["id"], txn_id)
        self.assertEqual(prior["category_id"], prior_cat)
        self.assertEqual(prior["category_source"], "import")

        with self._use_db_path(), get_db() as conn:
            restore_categorization_rows(conn, [prior])
            row = conn.execute(
                "SELECT category_id, category_source, category_overridden FROM txn WHERE id = ?",
                (txn_id,),
            ).fetchone()

        # Undo put the row back exactly where it started.
        self.assertEqual(row["category_id"], prior_cat)
        self.assertEqual(row["category_source"], "import")
        self.assertEqual(row["category_overridden"], 0)

    def test_preview_and_apply_count_only_visible_changes(self):
        # The editor offers the preview's count and the apply reports its own; both must count only rows whose
        # shown category changes. A manual row already in the rule's category still passes to the rule's
        # ownership, but nothing on screen changes, so neither count includes it — nor a split row (whose
        # category the apply declines) or a trashed one.
        account_id = self._account()
        category_id = self._expense_leaf("Coffee")
        rule_id = self._rule(category_id=category_id, keyword="blue bottle")
        changes = self._txn(account_id=account_id, merchant="BLUE BOTTLE COFFEE")
        owned_by_hand = self._txn(account_id=account_id, merchant="Blue Bottle #42")
        split = self._txn(account_id=account_id, merchant="Blue Bottle #7")
        trashed = self._txn(account_id=account_id, merchant="Blue Bottle #9")
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "UPDATE txn SET category_id = ?, category_source = 'manual', category_overridden = 1 WHERE id = ?",
                (category_id, owned_by_hand),
            )
            conn.execute("UPDATE txn SET is_split = 1 WHERE id = ?", (split,))
            conn.execute("UPDATE txn SET trashed_at = '2026-04-24T00:00:00' WHERE id = ?", (trashed,))

        with self._use_db_path():
            preview = preview_rule(RulePreview(keyword="blue bottle", category_id=category_id))
        self.assertEqual([t["id"] for t in preview["transactions"]], [changes])

        visible: list = []
        with self._use_db_path(), get_db() as conn:
            affected = _apply_rule_to_existing(conn, rule_id, visible_changes=visible)
            owner = conn.execute(
                "SELECT category_source, category_overridden FROM txn WHERE id = ?", (owned_by_hand,),
            ).fetchone()
        self.assertEqual(visible, [changes])
        self.assertEqual(set(affected), {changes, owned_by_hand, trashed})
        self.assertEqual((owner["category_source"], owner["category_overridden"]), ("rule", 0))

    def test_no_apply_takes_a_row_a_feature_owns(self):
        # An excluded Amazon charge taken into the rule's category would count the spend twice, and a
        # refund follows its payment. Neither is offered by the preview nor touched by either apply mode.
        account_id = self._account()
        excluded_leaf = self._expense_leaf("Funding")
        category_id = self._expense_leaf("Books")
        rule_id = self._rule(category_id=category_id, keyword="kindle")
        owned = {source: self._txn(account_id=account_id, merchant=f"Kindle {source}")
                 for source in ("enrichment", "refund")}
        with self._use_db_path(), get_db() as conn:
            for source in owned:
                conn.execute("UPDATE txn SET category_id = ?, category_source = ? WHERE id = ?",
                             (excluded_leaf, source, owned[source]))

        with self._use_db_path():
            preview = preview_rule(RulePreview(keyword="kindle", category_id=category_id))
        self.assertEqual(preview["transactions"], [])

        for preserve_manual in (False, True):
            with self._use_db_path(), get_db() as conn:
                affected = _apply_rule_to_existing(conn, rule_id, preserve_manual=preserve_manual)
                rows = conn.execute("SELECT id, category_id, category_source FROM txn").fetchall()
            self.assertEqual(affected, [])
            self.assertEqual({r["id"]: (r["category_id"], r["category_source"]) for r in rows},
                             {txn_id: (excluded_leaf, source) for source, txn_id in owned.items()})


if __name__ == "__main__":
    unittest.main()
