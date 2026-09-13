"""
The category tree's shape, enforced where it is written rather than only where it is drawn.

Three rules, each of which used to fail silently rather than loudly:

- **Two levels, leaf-only.** A category nested under another leaf is counted in neither report branch, and one
  placed under itself has no group at all. Every parent has to be a top-level group, and a group that still
  holds categories cannot become somebody's child.
- **A leaf's type is its group's.** Dragging a group across the income/expense sections retyped the group
  alone, so its leaves stayed on the old side and the group's total stopped equalling its own slices.
- **Claimed money stays where reimbursements can see it.** Moving or deleting a Reimbursable leaf that held
  claimed money made the outstanding balance vanish while the claims themselves survived.

Driven through the router functions, since the refusals are the API contract; the reconciliation the type
rule protects is asserted against the report endpoints in `test_report_sign_filters.py`.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from fastapi import HTTPException

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.categories import (
    CategoryCreate,
    CategoryDelete,
    CategoryUpdate,
    create_category,
    delete_category,
    update_category,
)
from backend.services.excluded_categories import find_reimbursable_group_id
from backend.services.reimbursements import create_reimbursement, receivable_amounts
from backend.services.txn_splits import save_split


class CategoryTreeTestCase(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "category-tree.db"
        init_db(str(self.db_path))
        with self._db() as conn:
            self.account = str(uuid.uuid4())
            conn.execute(
                "INSERT INTO account (id, external_account_id, provider, name, display_name, type, subtype, "
                "mask, owner_id) VALUES (?, ?, 'fixture_tree', 'Everyday', 'Everyday', 'checking', 'checking', "
                "'0000', ?)",
                (self.account, f"acct_{self.account}", SHARED_OWNER_ID),
            )

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    @contextmanager
    def _db(self):
        with self._path(), get_db() as conn:
            yield conn

    def _group(self, name: str, category_type: str = "expense") -> str:
        group_id = str(uuid.uuid4())
        with self._db() as conn:
            conn.execute(
                "INSERT INTO category (id, parent_id, name, category_type, sort_order) VALUES (?, NULL, ?, ?, 0)",
                (group_id, name, category_type),
            )
        return group_id

    def _leaf(self, group_id: str, name: str, category_type: str | None = "expense", *, active: int = 1) -> str:
        leaf_id = str(uuid.uuid4())
        with self._db() as conn:
            conn.execute(
                "INSERT INTO category (id, parent_id, name, category_type, sort_order, is_active) "
                "VALUES (?, ?, ?, ?, 0, ?)",
                (leaf_id, group_id, name, category_type, active),
            )
        return leaf_id

    def _txn(self, *, amount: float, category_id: str | None) -> str:
        txn_id = str(uuid.uuid4())
        with self._db() as conn:
            conn.execute(
                "INSERT INTO txn (id, account_id, owner_id, category_id, amount, merchant_name, display_name, "
                "raw_name, date, is_pending, category_overridden) VALUES (?, ?, ?, ?, ?, 'Box Office', "
                "'Box Office', 'Box Office', '2026-02-14', 0, 0)",
                (txn_id, self.account, SHARED_OWNER_ID, category_id, amount),
            )
        return txn_id

    def _row(self, category_id: str) -> dict:
        with self._db() as conn:
            row = conn.execute("SELECT * FROM category WHERE id = ?", (category_id,)).fetchone()
        return dict(row) if row else None

    def _refused(self, call) -> HTTPException:
        with self._path(), self.assertRaises(HTTPException) as ctx:
            call()
        self.assertEqual(ctx.exception.status_code, 400)
        return ctx.exception


class TwoLevelTreeTests(CategoryTreeTestCase):
    def test_a_category_cannot_be_created_inside_another_category(self):
        group = self._group("Entertainment")
        leaf = self._leaf(group, "Concerts")
        self._refused(lambda: create_category(CategoryCreate(name="Stadium shows", parent_id=leaf)))
        with self._db() as conn:
            self.assertIsNone(conn.execute("SELECT id FROM category WHERE name = 'Stadium shows'").fetchone())

    def test_a_category_cannot_be_moved_inside_another_category(self):
        group = self._group("Entertainment")
        concerts = self._leaf(group, "Concerts")
        theatre = self._leaf(group, "Theatre")
        self._refused(lambda: update_category(theatre, CategoryUpdate(parent_id=concerts)))
        self.assertEqual(self._row(theatre)["parent_id"], group)

    def test_a_group_that_still_holds_categories_cannot_move_into_a_group(self):
        entertainment = self._group("Entertainment")
        hobbies = self._group("Hobbies")
        self._leaf(hobbies, "Model trains")
        self._refused(lambda: update_category(hobbies, CategoryUpdate(parent_id=entertainment)))
        self.assertIsNone(self._row(hobbies)["parent_id"])

    def test_an_empty_group_can_be_folded_into_another_as_a_category(self):
        entertainment = self._group("Entertainment")
        hobbies = self._group("Hobbies")
        with self._path():
            update_category(hobbies, CategoryUpdate(parent_id=entertainment))
        self.assertEqual(self._row(hobbies)["parent_id"], entertainment)

    def test_nothing_can_be_placed_inside_itself(self):
        group = self._group("Entertainment")
        self._refused(lambda: update_category(group, CategoryUpdate(parent_id=group)))
        self.assertIsNone(self._row(group)["parent_id"])

    def test_a_missing_parent_is_not_found_rather_than_written(self):
        group = self._group("Entertainment")
        leaf = self._leaf(group, "Concerts")
        with self._path(), self.assertRaises(HTTPException) as ctx:
            update_category(leaf, CategoryUpdate(parent_id=str(uuid.uuid4())))
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertEqual(self._row(leaf)["parent_id"], group)

    def test_reordering_inside_the_same_group_is_not_a_move(self):
        # The Categories page persists a drop by re-sending every sibling's parent alongside its new sort
        # order. None of that is a move, so none of the move refusals may fire on it.
        group = self._group("Entertainment")
        concerts = self._leaf(group, "Concerts")
        with self._path():
            update_category(concerts, CategoryUpdate(parent_id=group, sort_order=3))
        self.assertEqual(self._row(concerts)["sort_order"], 3)


class TypeFollowsGroupTests(CategoryTreeTestCase):
    def test_a_category_moved_to_the_other_side_takes_its_new_groups_type(self):
        entertainment = self._group("Entertainment", "expense")
        side_income = self._group("Side income", "income")
        tickets = self._leaf(entertainment, "Ticket resale", "expense")
        with self._path():
            update_category(tickets, CategoryUpdate(parent_id=side_income))
        self.assertEqual(self._row(tickets)["category_type"], "income")

    def test_retyping_a_group_carries_every_one_of_its_categories(self):
        group = self._group("Freelance", "expense")
        typed = self._leaf(group, "Invoices", "expense")
        untyped = self._leaf(group, "Tips", None)
        deleted = self._leaf(group, "Old retainer", "expense", active=0)
        with self._path():
            update_category(group, CategoryUpdate(category_type="income"))
        self.assertEqual(self._row(group)["category_type"], "income")
        for leaf in (typed, untyped, deleted):
            self.assertEqual(self._row(leaf)["category_type"], "income")

    def test_a_category_cannot_be_given_a_type_other_than_its_groups(self):
        group = self._group("Entertainment", "expense")
        leaf = self._leaf(group, "Concerts", None)
        self._refused(lambda: update_category(leaf, CategoryUpdate(category_type="income")))
        self.assertIsNone(self._row(leaf)["category_type"])
        with self._path():
            update_category(leaf, CategoryUpdate(category_type="expense"))
        self.assertEqual(self._row(leaf)["category_type"], "expense")


class ReimbursementClaimTests(CategoryTreeTestCase):
    def setUp(self):
        super().setUp()
        with self._db() as conn:
            self.reimbursable = find_reimbursable_group_id(conn)
        self.tickets = self._leaf(self.reimbursable, "Concert tickets")
        self.entertainment = self._group("Entertainment")

    def _claim(self, txn_id: str, amount: float | None = None) -> None:
        with self._db() as conn:
            create_reimbursement(conn, [{"txn_id": txn_id, "amount": amount, "label": None}], counterparty="Friends")

    def test_a_category_with_claimed_money_cannot_leave_the_group(self):
        self._claim(self._txn(amount=375.0, category_id=self.tickets))
        refusal = self._refused(lambda: update_category(self.tickets, CategoryUpdate(parent_id=self.entertainment)))
        self.assertIn("1 reimbursement", refusal.detail)
        self.assertEqual(self._row(self.tickets)["parent_id"], self.reimbursable)

    def test_a_claim_on_a_split_portion_holds_the_category_just_the_same(self):
        # The ordinary case: one charge, part of it owed back. The row's own category is elsewhere, and only a
        # split part sits in the Reimbursable leaf.
        movies = self._leaf(self.entertainment, "Movies")
        charge = self._txn(amount=500.0, category_id=movies)
        with self._db() as conn:
            save_split(conn, charge, [
                {"category_id": movies, "amount": 125.0, "label": "Mine"},
                {"category_id": self.tickets, "amount": 375.0, "label": "Friends' tickets"},
            ])
        self._claim(charge, 375.0)
        self._refused(lambda: update_category(self.tickets, CategoryUpdate(parent_id=self.entertainment)))
        self.assertEqual(self._row(self.tickets)["parent_id"], self.reimbursable)

    def test_a_category_with_claimed_money_cannot_be_deleted(self):
        charge = self._txn(amount=375.0, category_id=self.tickets)
        self._claim(charge)
        self._refused(lambda: delete_category(self.tickets, None))
        self.assertEqual(self._row(self.tickets)["is_active"], 1)
        with self._db() as conn:
            self.assertEqual(
                conn.execute("SELECT category_id FROM txn WHERE id = ?", (charge,)).fetchone()["category_id"],
                self.tickets,
            )

    def test_deleting_into_another_reimbursable_category_keeps_every_claim_standing(self):
        work = self._leaf(self.reimbursable, "Work travel")
        charge = self._txn(amount=375.0, category_id=self.tickets)
        self._claim(charge)
        with self._path():
            delete_category(self.tickets, CategoryDelete(replacement_category_id=work))
        self.assertEqual(self._row(self.tickets)["is_active"], 0)
        with self._db() as conn:
            self.assertEqual(receivable_amounts(conn, [charge])[charge], 375.0)

    def test_deleting_into_a_category_outside_the_group_is_still_refused(self):
        movies = self._leaf(self.entertainment, "Movies")
        self._claim(self._txn(amount=375.0, category_id=self.tickets))
        self._refused(lambda: delete_category(self.tickets, CategoryDelete(replacement_category_id=movies)))
        self.assertEqual(self._row(self.tickets)["is_active"], 1)

    def test_a_category_with_nothing_claimed_moves_and_deletes_freely(self):
        self._txn(amount=60.0, category_id=self.tickets)
        with self._path():
            update_category(self.tickets, CategoryUpdate(parent_id=self.entertainment))
        self.assertEqual(self._row(self.tickets)["parent_id"], self.entertainment)
        spare = self._leaf(self.reimbursable, "Spare")
        with self._path():
            delete_category(spare, None)
        self.assertEqual(self._row(spare)["is_active"], 0)


if __name__ == "__main__":
    unittest.main()
