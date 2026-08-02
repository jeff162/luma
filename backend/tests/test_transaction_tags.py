"""
Transaction-tag coverage.

These tests protect the shared tag model across rules, manual transaction edits,
and reporting filters so tags behave like stable cross-cutting labels instead of
becoming a second category system with inconsistent override rules.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import SHARED_OWNER_ID, _seed_default_categories, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.rules import _apply_rule_to_existing, create_rule, RuleCreate
from backend.routers.transactions import list_transactions, spending_by_group
from backend.services.categorizer import preview_recategorize_count, recategorize_all
from backend.services.transaction_tags import (
    get_blocked_transaction_tag_map,
    list_visible_transaction_tags,
    set_manual_transaction_tag,
)


class TransactionTagsTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "transaction-tags.db"
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

    def _insert_account(self, name: str) -> str:
        account_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO account
                      (id, external_account_id, provider, name, display_name, type, subtype, mask, owner_id, parent_account_id, trashed_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
                    """,
                    (
                        account_id,
                        f"plaid_{account_id}",
                        "fixture_transaction_tags",
                        name,
                        name,
                        "checking",
                        "checking",
                        "1234",
                        SHARED_OWNER_ID,
                    ),
                )
        return account_id

    def _insert_expense_leaf(self, name: str) -> str:
        category_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                expense_group = conn.execute(
                    "SELECT id FROM category WHERE name = 'Food & Drink' AND parent_id IS NULL"
                ).fetchone()
                conn.execute(
                    """
                    INSERT INTO category (id, parent_id, name, category_type, sort_order)
                    VALUES (?, ?, ?, 'expense', 0)
                    """,
                    (category_id, expense_group["id"], name),
                )
        return category_id

    def _insert_tag(self, name: str, color: str) -> str:
        tag_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                sort_order = conn.execute("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM tag").fetchone()[0]
                conn.execute(
                    "INSERT INTO tag (id, name, color, sort_order) VALUES (?, ?, ?, ?)",
                    (tag_id, name, color, sort_order),
                )
        return tag_id

    def _insert_transaction(self, *, account_id: str, merchant_name: str, amount: float = 54.0, date: str = "2026-04-15") -> str:
        txn_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO txn
                      (id, account_id, owner_id, category_id, amount, merchant_name, display_name, raw_name, date, is_pending, category_overridden)
                    VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, 0)
                    """,
                    (txn_id, account_id, SHARED_OWNER_ID, amount, merchant_name, merchant_name, merchant_name, date),
                )
        return txn_id

    def _create_rule(self, *, keyword: str, category_id: str | None = None, clean_name: str | None = None, tag_ids: list[str] | None = None) -> str:
        with self._use_db_path():
            result = create_rule(RuleCreate(
                keyword=keyword,
                category_id=category_id,
                clean_name=clean_name,
                tag_ids=tag_ids or [],
            ))
        return result["id"]

    def test_recategorize_unions_tags_and_keeps_first_category_action(self):
        account_id = self._insert_account("Primary Checking")
        groceries_id = self._insert_expense_leaf("Groceries")
        essential_tag_id = self._insert_tag("Essential", "#22c55e")
        grocery_tag_id = self._insert_tag("Groceries Run", "#3b82f6")
        txn_id = self._insert_transaction(account_id=account_id, merchant_name="TAG FIXTURE MART")
        self._create_rule(keyword="fixture mart", category_id=groceries_id, tag_ids=[essential_tag_id])
        self._create_rule(keyword="fixture", clean_name="Fixture Mart", tag_ids=[grocery_tag_id])

        with self._use_db_path():
            with get_db() as conn:
                self.assertEqual(preview_recategorize_count(conn), 1)
                self.assertEqual(recategorize_all(conn), 1)
                txn = conn.execute(
                    "SELECT category_id, display_name FROM txn WHERE id = ?",
                    (txn_id,),
                ).fetchone()
                tags = list_visible_transaction_tags(conn, txn_id)

        self.assertEqual(txn["category_id"], groceries_id)
        self.assertEqual(txn["display_name"], "Fixture Mart")
        self.assertEqual({tag["id"] for tag in tags}, {essential_tag_id, grocery_tag_id})

    def test_manual_remove_blocks_rule_tag_during_recategorize(self):
        account_id = self._insert_account("Primary Checking")
        essential_tag_id = self._insert_tag("Essential", "#22c55e")
        # Fixture keyword (not one of the seeded default rules) so this exercises tag sync in
        # isolation rather than colliding with the seeded matcher.
        txn_id = self._insert_transaction(account_id=account_id, merchant_name="FIXTURE GROCER")
        self._create_rule(keyword="fixture grocer", tag_ids=[essential_tag_id])

        with self._use_db_path():
            with get_db() as conn:
                self.assertEqual(recategorize_all(conn), 1)
                set_manual_transaction_tag(conn, txn_id, essential_tag_id, present=False)
                self.assertEqual(preview_recategorize_count(conn), 0)
                self.assertEqual(recategorize_all(conn), 0)
                tags = list_visible_transaction_tags(conn, txn_id)

        self.assertEqual(tags, [])

    def test_manual_add_survives_rule_sync(self):
        account_id = self._insert_account("Primary Checking")
        manual_tag_id = self._insert_tag("Budget Watch", "#f97316")
        txn_id = self._insert_transaction(account_id=account_id, merchant_name="Corner Store")

        with self._use_db_path():
            with get_db() as conn:
                set_manual_transaction_tag(conn, txn_id, manual_tag_id, present=True)
                self.assertEqual(preview_recategorize_count(conn), 0)
                self.assertEqual(recategorize_all(conn), 0)
                tags = list_visible_transaction_tags(conn, txn_id)

        self.assertEqual([tag["id"] for tag in tags], [manual_tag_id])

    def test_apply_rule_adds_tags_and_tag_filter_reaches_reporting(self):
        account_id = self._insert_account("Primary Checking")
        spending_group = None
        groceries_id = None
        with self._use_db_path():
            with get_db() as conn:
                # Starter leaves are opt-in now; this case needs the seeded 'Groceries'/'Food & Drink'.
                _seed_default_categories(conn, include_leaves=True)
                groceries = conn.execute(
                    """
                    SELECT c.id, p.id AS group_id
                    FROM category c
                    JOIN category p ON p.id = c.parent_id
                    WHERE c.name = 'Groceries'
                      AND p.name = 'Food & Drink'
                    LIMIT 1
                    """
                ).fetchone()
                groceries_id = groceries["id"]
                spending_group = groceries["group_id"]
        essential_tag_id = self._insert_tag("Essential", "#22c55e")
        other_tag_id = self._insert_tag("Optional", "#a855f7")
        # Fixture keyword (not a seeded default rule) so the rule is created fresh rather than
        # colliding with the seeded matcher.
        tagged_txn_id = self._insert_transaction(account_id=account_id, merchant_name="FIXTURE BULLSEYE", amount=81.0)
        self._insert_transaction(account_id=account_id, merchant_name="MOVIE", amount=18.0)
        rule_id = self._create_rule(keyword="fixture bullseye", category_id=groceries_id, tag_ids=[essential_tag_id])

        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO txn_tag (txn_id, tag_id, rule_present, manual_state)
                    VALUES (?, ?, 0, 1)
                    """,
                    (tagged_txn_id, other_tag_id),
                )
                self.assertEqual(len(_apply_rule_to_existing(conn, rule_id)), 1)
            ledger = list_transactions(
                month=None,
                date_start=None,
                date_end=None,
                import_batch_id=None,
                sort_by="date",
                sort_dir="desc",
                account_id=None,
                account_ids=None,
                category_id=None,
                group_ids=None,
                category_ids=None,
                tag_ids=essential_tag_id,
                owner_ids=None,
                payees=None,
                direction=None,
                search=None,
                quick_filter=None,
                limit=200,
                offset=0,
            )
            grouped = spending_by_group(
                month="2026-04",
                date_start=None,
                date_end=None,
                account_id=None,
                account_ids=None,
                tag_ids=essential_tag_id,
                owner_ids=None,
                category_owner_ids=None,
            )

        self.assertEqual([txn["id"] for txn in ledger["transactions"]], [tagged_txn_id])
        self.assertEqual(len(grouped), 1)
        self.assertEqual(grouped[0]["group_id"], spending_group)
        self.assertEqual(grouped[0]["total"], 81.0)

    def test_tag_only_rule_is_allowed(self):
        tag_id = self._insert_tag("Essential", "#22c55e")
        with self._use_db_path():
            result = create_rule(RuleCreate(keyword="rent", tag_ids=[tag_id]))
        self.assertTrue(result["id"])

    # --- Per-transaction override (opt-out) of inherited tags ---------------------------------------
    #
    # An inherited tag (category/group/account) can be hidden on one transaction via the universal
    # manual_state = -1 block, without retagging the source. These cover the two shared chokepoints
    # (display + filter) and the toggle state machine.

    def _attach_category_tag(self, category_id: str, tag_id: str) -> None:
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO category_tag (category_id, tag_id) VALUES (?, ?)",
                    (category_id, tag_id),
                )

    def _attach_account_tag(self, account_id: str, tag_id: str) -> None:
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO account_tag (account_id, tag_id) VALUES (?, ?)",
                    (account_id, tag_id),
                )

    def _set_txn_category(self, txn_id: str, category_id: str) -> None:
        # Mark it overridden so a recategorize pass leaves the category (and thus its inherited tag)
        # in place, mirroring a manual category assignment.
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "UPDATE txn SET category_id = ?, category_overridden = 1 WHERE id = ?",
                    (category_id, txn_id),
                )

    def _txn_tag_row(self, conn, txn_id: str, tag_id: str):
        return conn.execute(
            "SELECT rule_present, manual_state FROM txn_tag WHERE txn_id = ? AND tag_id = ?",
            (txn_id, tag_id),
        ).fetchone()

    def test_block_inherited_category_tag_hides_only_that_transaction(self):
        account_id = self._insert_account("Primary Checking")
        groceries_id = self._insert_expense_leaf("Groceries")
        essential_tag_id = self._insert_tag("Essential", "#22c55e")
        self._attach_category_tag(groceries_id, essential_tag_id)
        txn_a = self._insert_transaction(account_id=account_id, merchant_name="Store A")
        txn_b = self._insert_transaction(account_id=account_id, merchant_name="Store B")
        self._set_txn_category(txn_a, groceries_id)
        self._set_txn_category(txn_b, groceries_id)

        with self._use_db_path():
            with get_db() as conn:
                # Both inherit the tag to start (source = category).
                self.assertEqual([t["id"] for t in list_visible_transaction_tags(conn, txn_a)], [essential_tag_id])
                self.assertEqual(list_visible_transaction_tags(conn, txn_a)[0]["source"], "category")

                # Block on A only.
                set_manual_transaction_tag(conn, txn_a, essential_tag_id, present=False)
                self.assertEqual(list_visible_transaction_tags(conn, txn_a), [])
                self.assertEqual(
                    [t["id"] for t in get_blocked_transaction_tag_map(conn, [txn_a]).get(txn_a, [])],
                    [essential_tag_id],
                )
                # Sibling B is untouched.
                self.assertEqual([t["id"] for t in list_visible_transaction_tags(conn, txn_b)], [essential_tag_id])
                # A block leaves a -1 row.
                self.assertEqual(self._txn_tag_row(conn, txn_a, essential_tag_id)["manual_state"], -1)

                # Re-check restores it and drops the row (pure inheritance needs no direct row).
                set_manual_transaction_tag(conn, txn_a, essential_tag_id, present=True)
                self.assertEqual([t["id"] for t in list_visible_transaction_tags(conn, txn_a)], [essential_tag_id])
                self.assertIsNone(self._txn_tag_row(conn, txn_a, essential_tag_id))
                self.assertEqual(get_blocked_transaction_tag_map(conn, [txn_a]).get(txn_a, []), [])

    def test_block_inherited_account_tag(self):
        account_id = self._insert_account("Primary Checking")
        travel_tag_id = self._insert_tag("Travel", "#3b82f6")
        self._attach_account_tag(account_id, travel_tag_id)
        txn_id = self._insert_transaction(account_id=account_id, merchant_name="Airline")

        with self._use_db_path():
            with get_db() as conn:
                self.assertEqual(list_visible_transaction_tags(conn, txn_id)[0]["source"], "account")
                set_manual_transaction_tag(conn, txn_id, travel_tag_id, present=False)
                self.assertEqual(list_visible_transaction_tags(conn, txn_id), [])
                self.assertEqual(
                    [t["id"] for t in get_blocked_transaction_tag_map(conn, [txn_id]).get(txn_id, [])],
                    [travel_tag_id],
                )

    def test_block_excludes_from_filter_and_reporting_per_tag(self):
        account_id = self._insert_account("Primary Checking")
        groceries_id = self._insert_expense_leaf("Groceries")
        group_id = None
        with self._use_db_path():
            with get_db() as conn:
                group_id = conn.execute(
                    "SELECT parent_id FROM category WHERE id = ?", (groceries_id,)
                ).fetchone()["parent_id"]
        essential_tag_id = self._insert_tag("Essential", "#22c55e")
        other_tag_id = self._insert_tag("Other", "#a855f7")
        self._attach_category_tag(groceries_id, essential_tag_id)
        txn_a = self._insert_transaction(account_id=account_id, merchant_name="Store A", amount=30.0)
        txn_b = self._insert_transaction(account_id=account_id, merchant_name="Store B", amount=12.0)
        self._set_txn_category(txn_a, groceries_id)
        self._set_txn_category(txn_b, groceries_id)

        with self._use_db_path():
            with get_db() as conn:
                # A also carries a direct 'Other' tag, and blocks the inherited 'Essential'.
                set_manual_transaction_tag(conn, txn_a, other_tag_id, present=True)
                set_manual_transaction_tag(conn, txn_a, essential_tag_id, present=False)

            def _ledger(tag_ids):
                return list_transactions(
                    month=None, date_start=None, date_end=None, import_batch_id=None,
                    sort_by="date", sort_dir="desc", account_id=None, account_ids=None,
                    category_id=None, group_ids=None, category_ids=None, tag_ids=tag_ids,
                    owner_ids=None, payees=None, direction=None, search=None, quick_filter=None,
                    limit=200, offset=0,
                )

            # Filtering by the blocked tag excludes A but keeps sibling B.
            essential_only = _ledger(essential_tag_id)
            self.assertEqual([t["id"] for t in essential_only["transactions"]], [txn_b])

            # Reporting agrees: the Essential total counts only B's amount.
            grouped = spending_by_group(
                month="2026-04", date_start=None, date_end=None, account_id=None,
                account_ids=None, tag_ids=essential_tag_id, owner_ids=None, category_owner_ids=None,
            )
            self.assertEqual(len(grouped), 1)
            self.assertEqual(grouped[0]["group_id"], group_id)
            self.assertEqual(grouped[0]["total"], 12.0)

            # A block on one requested tag never hides a match through another: filtering [Essential,
            # Other] still returns A (via its direct Other) and B (via Essential).
            both = _ledger(f"{essential_tag_id},{other_tag_id}")
            self.assertEqual({t["id"] for t in both["transactions"]}, {txn_a, txn_b})

    def test_inherited_block_survives_rule_rerun_and_manual_add_still_deletes(self):
        account_id = self._insert_account("Primary Checking")
        groceries_id = self._insert_expense_leaf("Groceries")
        essential_tag_id = self._insert_tag("Essential", "#22c55e")
        manual_tag_id = self._insert_tag("Budget Watch", "#f97316")
        self._attach_category_tag(groceries_id, essential_tag_id)
        txn_id = self._insert_transaction(account_id=account_id, merchant_name="Store A")
        self._set_txn_category(txn_id, groceries_id)

        with self._use_db_path():
            with get_db() as conn:
                # Inherited block persists across a full recategorize pass (it's rule-independent).
                set_manual_transaction_tag(conn, txn_id, essential_tag_id, present=False)
                self.assertEqual(recategorize_all(conn), 0)
                self.assertEqual(self._txn_tag_row(conn, txn_id, essential_tag_id)["manual_state"], -1)
                self.assertEqual(list_visible_transaction_tags(conn, txn_id), [])

                # A purely manual add that is then removed leaves no row (unchanged "no opinion" path).
                set_manual_transaction_tag(conn, txn_id, manual_tag_id, present=True)
                self.assertEqual(self._txn_tag_row(conn, txn_id, manual_tag_id)["manual_state"], 1)
                set_manual_transaction_tag(conn, txn_id, manual_tag_id, present=False)
                self.assertIsNone(self._txn_tag_row(conn, txn_id, manual_tag_id))


if __name__ == "__main__":
    unittest.main()
