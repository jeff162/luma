"""
Reimbursable expenses — the receivable arithmetic, the settle rule, and the reversal.

The load-bearing claim is the settle rule: a residual is a *category balance* rather than a row, so it
can only be moved by rewriting an existing transaction's allocations, and which transaction can legally
carry it is decided by the sign. A positive residual (repaid short, or never repaid) settles on the
expense and restates the original period on purpose; a negative one (repaid over) settles on the
repayment. Both halves are asserted, because a rule that only ever settled on the expense would look
correct on every short case and then need a mixed-sign allocation — which `txn_splits` refuses — the
first time somebody was repaid more than their own portion. That case has its own test.

Fixtures use whole scenarios rather than hand-built minimal rows: a four-ticket purchase split between
the buyer and their friends is the motivating case, and the residual only means anything against a
transaction whose parts actually sum to it.
"""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import (
    SHARED_OWNER_ID,
    get_db,
    init_db,
    reset_current_db_path,
    set_current_db_path,
)
from backend.services.excluded_categories import (
    REIMBURSABLE_GROUP,
    REIMBURSABLE_SYSTEM_KEY,
    find_reimbursable_group_id,
    reimbursable_leaf_ids,
)
from backend.services.reimbursements import (
    EXPENSE_ROLE,
    REPAYMENT_ROLE,
    ReimbursementError,
    add_claims,
    create_reimbursement,
    outstanding,
    receivable_amounts,
    reimbursements_for_txn,
    complete,
    reopen,
    unclaimed_amounts,
)
from backend.services.txn_splits import get_split_parts, save_split


class ReimbursementTestCase(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "reimbursements.db"
        init_db(str(self.db_path))
        with self._db() as conn:
            self.receivable = self._reimbursable_leaf(conn, "Concert tickets")
            self.entertainment = self._leaf(conn, "Entertainment", "Movies & Events")
            self.groceries = self._leaf(conn, "Food & Drink", "Groceries")
            self.account = str(uuid.uuid4())
            conn.execute(
                "INSERT INTO account (id, external_account_id, provider, name, display_name, type, "
                "subtype, mask, owner_id) VALUES (?, ?, 'fixture_reimb', 'Everyday', 'Everyday', "
                "'checking', 'checking', '0000', ?)",
                (self.account, f"acct_{self.account}", SHARED_OWNER_ID),
            )

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

    def _reimbursable_leaf(self, conn, name: str) -> str:
        """A leaf under the seeded Reimbursable group, made the way a user makes one.

        Named for what the money is rather than for its state: the group already says it is owed back,
        and a state name would stop being true the moment it was repaid.
        """
        group_id = find_reimbursable_group_id(conn)
        leaf_id = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO category (id, parent_id, name, category_type, exclude_from_totals, sort_order) "
            "VALUES (?,?,?,'expense',1,0)",
            (leaf_id, group_id, name),
        )
        return leaf_id

    def _claims(self, *txn_ids, amount=None, label=None):
        """The claims shape every construction call now takes. An unstated amount claims whatever of the
        row is still unclaimed, which is what the ordinary single-portion case wants."""
        return [{"txn_id": txn_id, "amount": amount, "label": label} for txn_id in txn_ids]

    def _leaf(self, conn: sqlite3.Connection, group_name: str, leaf_name: str) -> str:
        group = conn.execute(
            "SELECT id FROM category WHERE name = ? AND parent_id IS NULL", (group_name,)
        ).fetchone()
        leaf_id = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO category (id, parent_id, name, category_type, sort_order) VALUES (?,?,?,?,0)",
            (leaf_id, group["id"], leaf_name, "expense"),
        )
        return leaf_id

    def _txn(self, conn, *, amount, date="2026-02-14", category=None, name="Concert Tickets"):
        txn_id = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO txn (id, account_id, owner_id, category_id, amount, merchant_name, "
            "display_name, raw_name, date, is_pending, category_overridden) "
            "VALUES (?,?,?,?,?,?,?,?,?,0,0)",
            (txn_id, self.account, SHARED_OWNER_ID, category, amount, name, name, name, date),
        )
        return txn_id

    def _tickets(self, conn, *, mine=125.0, theirs=375.0):
        """The motivating case: four tickets at $125, one the buyer's and three for friends."""
        txn_id = self._txn(conn, amount=round(mine + theirs, 2))
        save_split(
            conn,
            txn_id,
            [
                {"category_id": self.entertainment, "amount": mine, "label": "My ticket"},
                {"category_id": self.receivable, "amount": theirs, "label": "Three friends"},
            ],
        )
        return txn_id

    def _repayment(self, conn, amount, date="2026-07-03"):
        """Money coming back, categorized straight to the holding group."""
        return self._txn(
            conn, amount=-abs(amount), date=date, category=self.receivable, name="Repayment"
        )

    def _parts(self, conn, txn_id):
        return {
            (part["category_id"]): round(float(part["amount"]), 2)
            for part in get_split_parts(conn, txn_id)
        }

    def _row(self, conn, txn_id):
        return conn.execute(
            "SELECT category_id, category_source, category_overridden, is_split FROM txn WHERE id = ?",
            (txn_id,),
        ).fetchone()


class ReceivableArithmeticTests(ReimbursementTestCase):
    def test_split_row_is_read_from_its_parts(self):
        with self._db() as conn:
            txn_id = self._tickets(conn)
            self.assertEqual(receivable_amounts(conn, [txn_id])[txn_id], 375.0)

    def test_unsplit_row_is_read_from_its_own_category(self):
        with self._db() as conn:
            txn_id = self._txn(conn, amount=500.0, category=self.receivable)
            self.assertEqual(receivable_amounts(conn, [txn_id])[txn_id], 500.0)

    def test_row_with_no_receivable_contributes_nothing(self):
        with self._db() as conn:
            txn_id = self._txn(conn, amount=42.0, category=self.groceries)
            self.assertEqual(receivable_amounts(conn, [txn_id])[txn_id], 0.0)

    def test_split_with_no_receivable_part_does_not_fall_back_to_the_row(self):
        # The seam's robustness rule: substitution keys on whether allocation rows *matched*, not on
        # the flag. A split row whose parts are all ordinary must read 0, not its full amount — the
        # naive COALESCE(part, txn.category) would report the whole purchase as owed back.
        with self._db() as conn:
            txn_id = self._txn(conn, amount=90.0, category=self.receivable)
            save_split(
                conn,
                txn_id,
                [
                    {"category_id": self.entertainment, "amount": 50.0},
                    {"category_id": self.groceries, "amount": 40.0},
                ],
            )
            self.assertEqual(receivable_amounts(conn, [txn_id])[txn_id], 0.0)


class LinkInvariantTests(ReimbursementTestCase):
    def test_roles_are_derived_from_the_sign(self):
        with self._db() as conn:
            expense = self._tickets(conn)
            repayment = self._repayment(conn, 375)
            link = create_reimbursement(conn, self._claims(expense, repayment), counterparty="Ticket friends")
            roles = {member["txn_id"]: member["role"] for member in link["members"]}
        self.assertEqual(roles[expense], EXPENSE_ROLE)
        self.assertEqual(roles[repayment], REPAYMENT_ROLE)

    def test_a_lone_expense_is_a_valid_reimbursement(self):
        with self._db() as conn:
            expense = self._tickets(conn)
            link = create_reimbursement(conn, self._claims(expense))
        self.assertEqual(link["residual"], 375.0)
        self.assertEqual(link["repaid"], 0.0)

    def test_a_transaction_with_no_receivable_share_is_refused(self):
        with self._db() as conn:
            plain = self._txn(conn, amount=20.0, category=self.groceries)
            with self.assertRaises(ReimbursementError) as caught:
                create_reimbursement(conn, self._claims(plain))
        self.assertIn("Reimbursable", str(caught.exception))

    def test_a_transaction_belongs_to_at_most_one_reimbursement(self):
        with self._db() as conn:
            expense = self._tickets(conn)
            create_reimbursement(conn, self._claims(expense))
            with self.assertRaises(ReimbursementError):
                create_reimbursement(conn, self._claims(expense))

    def test_trashed_member_is_listed_but_left_out_of_the_figures(self):
        with self._db() as conn:
            expense = self._tickets(conn)
            repayment = self._repayment(conn, 375)
            link = create_reimbursement(conn, self._claims(expense, repayment))
            self.assertEqual(link["residual"], 0.0)
            conn.execute("UPDATE txn SET trashed_at = '2026-08-01' WHERE id = ?", (repayment,))
            reloaded = reimbursements_for_txn(conn, expense)[0]
        self.assertEqual(reloaded["residual"], 375.0)
        self.assertIn(repayment, {member["txn_id"] for member in reloaded["members"]})


class ResidualTests(ReimbursementTestCase):
    def _link(self, conn, repaid):
        expense = self._tickets(conn)
        repayment = self._repayment(conn, repaid)
        return expense, repayment, create_reimbursement(conn, self._claims(expense, repayment))

    def test_repaid_in_full_is_square(self):
        with self._db() as conn:
            _, _, link = self._link(conn, 375)
        self.assertEqual(link["residual"], 0.0)

    def test_repaid_short_leaves_a_positive_residual(self):
        with self._db() as conn:
            _, _, link = self._link(conn, 350)
        self.assertEqual(link["residual"], 25.0)

    def test_repaid_over_leaves_a_negative_residual(self):
        with self._db() as conn:
            _, _, link = self._link(conn, 400)
        self.assertEqual(link["residual"], -25.0)


class SettleTests(ReimbursementTestCase):
    def test_shortfall_settles_on_the_expense_and_restates_the_original_period(self):
        # $375 was owed and $350 came back, so $25 of the purchase was genuinely the buyer's cost.
        # February moves from $125 of entertainment to $150 — the restatement is the point.
        with self._db() as conn:
            expense = self._tickets(conn)
            repayment = self._repayment(conn, 350)
            link = create_reimbursement(conn, self._claims(expense, repayment))
            settled = complete(conn, link["id"], category_id=self.entertainment)
            expense_parts = self._parts(conn, expense)
            repayment_row = self._row(conn, repayment)
        self.assertTrue(settled["completed"])
        self.assertEqual(expense_parts[self.entertainment], 150.0)
        self.assertEqual(expense_parts[self.receivable], 350.0)
        self.assertEqual(settled["residual"], 0.0)
        # The repayment is untouched: only one side of a reimbursement ever carries the residual.
        self.assertEqual(repayment_row["category_id"], self.receivable)
        self.assertEqual(repayment_row["is_split"], 0)

    def test_surplus_settles_on_the_repayment_and_leaves_february_alone(self):
        # Resold at a profit: $400 came back against $375 owed. The gain was realized in July, so July
        # is where it lands — booking it into February would claim a gain in a month where nothing had
        # yet gone right.
        with self._db() as conn:
            expense = self._tickets(conn)
            repayment = self._repayment(conn, 400)
            link = create_reimbursement(conn, self._claims(expense, repayment))
            complete(conn, link["id"], category_id=self.entertainment)
            expense_parts = self._parts(conn, expense)
            repayment_parts = self._parts(conn, repayment)
        self.assertEqual(expense_parts, {self.entertainment: 125.0, self.receivable: 375.0})
        self.assertEqual(repayment_parts, {self.receivable: -375.0, self.entertainment: -25.0})

    def test_surplus_larger_than_the_buyers_own_share_needs_no_mixed_sign_allocation(self):
        # The case that would force a mixed-sign split if every residual settled on the expense:
        # $520 back against $375 owed is a $145 gain, and the buyer's own portion was only $125, so the
        # expense's entertainment part would have to go to -$20. On the repayment every part stays
        # negative at any magnitude. Do not "simplify" settlement to always target the expense.
        with self._db() as conn:
            expense = self._tickets(conn)
            repayment = self._repayment(conn, 520)
            link = create_reimbursement(conn, self._claims(expense, repayment))
            self.assertEqual(link["residual"], -145.0)
            complete(conn, link["id"], category_id=self.entertainment)
            repayment_parts = self._parts(conn, repayment)
        self.assertEqual(repayment_parts, {self.receivable: -375.0, self.entertainment: -145.0})
        self.assertTrue(all(amount < 0 for amount in repayment_parts.values()))

    def test_a_surplus_cannot_be_forced_onto_the_expense(self):
        with self._db() as conn:
            expense = self._tickets(conn)
            repayment = self._repayment(conn, 400)
            link = create_reimbursement(conn, self._claims(expense, repayment))
            with self.assertRaises(ReimbursementError) as caught:
                complete(conn, link["id"], category_id=self.entertainment, target_txn_id=expense)
        self.assertIn("a surplus against a repayment", str(caught.exception))

    def test_never_repaid_partial_split_collapses_to_the_real_category(self):
        # Nobody paid; the whole $500 was really spent on entertainment in February.
        with self._db() as conn:
            expense = self._tickets(conn)
            link = create_reimbursement(conn, self._claims(expense))
            complete(conn, link["id"], category_id=self.entertainment)
            row = self._row(conn, expense)
            parts = get_split_parts(conn, expense)
        self.assertEqual(parts, [], "a single remaining allocation must collapse, not sit as a split")
        self.assertEqual(row["is_split"], 0)
        self.assertEqual(row["category_id"], self.entertainment)
        self.assertEqual(row["category_source"], "manual")

    def test_never_repaid_wholly_reimbursable_row_is_simply_recategorized(self):
        with self._db() as conn:
            expense = self._txn(conn, amount=500.0, category=self.receivable)
            link = create_reimbursement(conn, self._claims(expense))
            complete(conn, link["id"], category_id=self.entertainment)
            row = self._row(conn, expense)
        self.assertEqual(row["is_split"], 0)
        self.assertEqual(row["category_id"], self.entertainment)

    def test_settling_into_the_holding_group_is_refused(self):
        with self._db() as conn:
            expense = self._tickets(conn)
            link = create_reimbursement(conn, self._claims(expense))
            with self.assertRaises(ReimbursementError) as caught:
                complete(conn, link["id"], category_id=self.receivable)
        self.assertIn("move out of the Reimbursable group", str(caught.exception))

    def test_settling_into_a_group_is_refused(self):
        with self._db() as conn:
            group = conn.execute(
                "SELECT id FROM category WHERE name = 'Entertainment' AND parent_id IS NULL"
            ).fetchone()["id"]
            expense = self._tickets(conn)
            link = create_reimbursement(conn, self._claims(expense))
            with self.assertRaises(ReimbursementError) as caught:
                complete(conn, link["id"], category_id=group)
        self.assertIn("not a group", str(caught.exception))

    def test_repaid_in_full_completes_with_nothing_to_move(self):
        # The commonest happy ending, and it was unreachable while "already square" was an error: the
        # record stayed on the open list forever with no action that could finish it. Completing moves
        # nothing — the two sides already cancel inside the excluded group — and asks for no category.
        with self._db() as conn:
            expense = self._tickets(conn)
            repayment = self._repayment(conn, 375)
            link = create_reimbursement(conn, self._claims(expense, repayment))
            self.assertEqual(link["residual"], 0.0)
            done = complete(conn, link["id"])
            parts = self._parts(conn, expense)
            repayment_row = self._row(conn, repayment)
        self.assertTrue(done["completed"])
        self.assertEqual(done["residual"], 0.0)
        # Nothing about either transaction changed.
        self.assertEqual(parts, {self.entertainment: 125.0, self.receivable: 375.0})
        self.assertEqual(repayment_row["category_id"], self.receivable)

    def test_a_completed_reimbursement_drops_off_the_open_list(self):
        with self._db() as conn:
            expense = self._tickets(conn)
            repayment = self._repayment(conn, 375)
            link = create_reimbursement(conn, self._claims(expense, repayment))
            self.assertEqual(len(outstanding(conn)["reimbursements"]), 1)
            complete(conn, link["id"])
            report = outstanding(conn)
        self.assertEqual(report["reimbursements"], [])
        # And the headline figure is unaffected, because a completed one's claims sum to zero.
        self.assertEqual(report["total"], 0.0)

    def test_completing_with_nothing_to_move_can_be_reopened(self):
        with self._db() as conn:
            expense = self._tickets(conn)
            repayment = self._repayment(conn, 375)
            link = create_reimbursement(conn, self._claims(expense, repayment))
            complete(conn, link["id"])
            reopened = reopen(conn, link["id"])
            parts = self._parts(conn, expense)
        self.assertFalse(reopened["completed"])
        self.assertEqual(reopened["residual"], 0.0)
        self.assertEqual(parts, {self.entertainment: 125.0, self.receivable: 375.0})

    def _two_expenses(self, conn, first, second, repaid):
        """One payment covering two receipts — the work-expenses shape."""
        a = self._txn(conn, amount=first, category=self.receivable, name="Receipt A")
        b = self._txn(conn, amount=second, category=self.receivable, name="Receipt B")
        repayment = self._repayment(conn, repaid)
        return a, b, create_reimbursement(conn, self._claims(a, b, repayment))

    def test_several_expenses_require_the_user_to_choose(self):
        with self._db() as conn:
            _, _, link = self._two_expenses(conn, 100.0, 300.0, 350)
            with self.assertRaises(ReimbursementError) as caught:
                complete(conn, link["id"], category_id=self.groceries)
        self.assertIn("choose which one", str(caught.exception))

    def test_a_named_target_absorbs_the_residual(self):
        with self._db() as conn:
            a, _, link = self._two_expenses(conn, 100.0, 300.0, 350)
            complete(conn, link["id"], category_id=self.groceries, target_txn_id=a)
            parts = self._parts(conn, a)
        self.assertEqual(parts, {self.receivable: 50.0, self.groceries: 50.0})

    def test_a_target_too_small_for_the_residual_is_refused(self):
        with self._db() as conn:
            a, _, link = self._two_expenses(conn, 20.0, 300.0, 270)
            self.assertEqual(link["residual"], 50.0)
            with self.assertRaises(ReimbursementError) as caught:
                complete(conn, link["id"], category_id=self.groceries, target_txn_id=a)
        self.assertIn("portion of that transaction is smaller", str(caught.exception))


class UnsettleTests(ReimbursementTestCase):
    def test_round_trips_a_split_expense_exactly(self):
        with self._db() as conn:
            expense = self._tickets(conn)
            repayment = self._repayment(conn, 350)
            link = create_reimbursement(conn, self._claims(expense, repayment))
            before_parts = self._parts(conn, expense)
            before_row = dict(self._row(conn, expense))
            complete(conn, link["id"], category_id=self.entertainment)
            reopened = reopen(conn, link["id"])
            after_parts = self._parts(conn, expense)
            after_row = dict(self._row(conn, expense))
        self.assertEqual(after_parts, before_parts)
        self.assertEqual(after_row, before_row)
        self.assertFalse(reopened["completed"])
        self.assertEqual(reopened["residual"], 25.0)

    def test_round_trips_a_row_that_settlement_had_collapsed(self):
        with self._db() as conn:
            expense = self._tickets(conn)
            link = create_reimbursement(conn, self._claims(expense))
            before_parts = self._parts(conn, expense)
            before_row = dict(self._row(conn, expense))
            complete(conn, link["id"], category_id=self.entertainment)
            self.assertEqual(get_split_parts(conn, expense), [])
            reopen(conn, link["id"])
            after_parts = self._parts(conn, expense)
            after_row = dict(self._row(conn, expense))
        self.assertEqual(after_parts, before_parts)
        self.assertEqual(after_row, before_row)

    def test_round_trips_a_repayment_that_settlement_had_split(self):
        with self._db() as conn:
            expense = self._tickets(conn)
            repayment = self._repayment(conn, 400)
            link = create_reimbursement(conn, self._claims(expense, repayment))
            before_row = dict(self._row(conn, repayment))
            complete(conn, link["id"], category_id=self.entertainment)
            self.assertEqual(len(get_split_parts(conn, repayment)), 2)
            reopen(conn, link["id"])
            after_row = dict(self._row(conn, repayment))
            self.assertEqual(get_split_parts(conn, repayment), [])
        self.assertEqual(after_row, before_row)

    def test_a_settled_reimbursement_refuses_edits_until_it_is_reopened(self):
        with self._db() as conn:
            expense = self._tickets(conn)
            link = create_reimbursement(conn, self._claims(expense))
            complete(conn, link["id"], category_id=self.entertainment)
            other = self._txn(conn, amount=-40.0, category=self.receivable, name="Late repayment")
            with self.assertRaises(ReimbursementError):
                add_claims(conn, link["id"], self._claims(other))


class OutstandingReportTests(ReimbursementTestCase):
    def _group_balance(self, conn) -> float:
        """The receivable group's own balance, read the way a report reads any category rollup: through
        the split expansion, per allocation. The report's headline total has to equal this or the
        "outstanding is just the category's sum" claim is not true."""
        leaves = reimbursable_leaf_ids(conn)
        places = ",".join("?" for _ in leaves)
        from_parts = conn.execute(
            f"SELECT COALESCE(SUM(s.amount), 0) AS total FROM txn_split s "
            f"JOIN txn t ON t.id = s.txn_id "
            f"WHERE t.trashed_at IS NULL AND s.category_id IN ({places})",
            leaves,
        ).fetchone()["total"]
        from_rows = conn.execute(
            f"SELECT COALESCE(SUM(t.amount), 0) AS total FROM txn t "
            f"WHERE t.trashed_at IS NULL AND t.is_split = 0 AND t.category_id IN ({places})",
            leaves,
        ).fetchone()["total"]
        return round(float(from_parts) + float(from_rows), 2)

    def test_total_equals_the_receivable_group_balance(self):
        with self._db() as conn:
            linked_expense = self._tickets(conn)
            repayment = self._repayment(conn, 350)
            create_reimbursement(conn, self._claims(linked_expense, repayment))
            self._txn(conn, amount=80.0, category=self.receivable, name="Loose receipt")
            report = outstanding(conn)
            balance = self._group_balance(conn)
        self.assertEqual(report["total"], balance)
        self.assertEqual(report["total"], 105.0)

    def test_linked_and_loose_receivables_are_kept_apart(self):
        with self._db() as conn:
            linked_expense = self._tickets(conn)
            create_reimbursement(conn, self._claims(linked_expense))
            loose = self._txn(conn, amount=80.0, category=self.receivable, name="Loose receipt")
            report = outstanding(conn)
        self.assertEqual([row["txn_id"] for row in report["loose"]], [loose])
        self.assertEqual(len(report["reimbursements"]), 1)
        self.assertEqual(report["reimbursements"][0]["residual"], 375.0)

    def test_a_settled_reimbursement_stops_contributing(self):
        with self._db() as conn:
            expense = self._tickets(conn)
            link = create_reimbursement(conn, self._claims(expense))
            complete(conn, link["id"], category_id=self.entertainment)
            report = outstanding(conn)
            balance = self._group_balance(conn)
        self.assertEqual(report["total"], 0.0)
        self.assertEqual(balance, 0.0)


class GroupGuardTests(ReimbursementTestCase):
    """The holding group is machinery. Both guards are flat rather than conditional on whether it
    currently holds anything — a gate on present state produces a control that works on some days and
    not others, and the delete never durably worked anyway (seeding restores the group at next start)."""

    def _group_id(self):
        with self._db() as conn:
            return find_reimbursable_group_id(conn)

    def test_the_group_is_seeded_with_a_system_key_and_excluded(self):
        with self._db() as conn:
            row = conn.execute(
                "SELECT name, system_key, exclude_from_totals, parent_id FROM category WHERE system_key = ?",
                (REIMBURSABLE_SYSTEM_KEY,),
            ).fetchone()
        self.assertEqual(row["name"], REIMBURSABLE_GROUP)
        self.assertIsNone(row["parent_id"])
        self.assertEqual(row["exclude_from_totals"], 1)

    def test_the_group_cannot_be_deleted(self):
        from fastapi import HTTPException

        from backend.routers.categories import delete_category

        token = set_current_db_path(str(self.db_path))
        try:
            with self.assertRaises(HTTPException) as caught:
                delete_category(self._group_id(), None)
        finally:
            reset_current_db_path(token)
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("cannot be deleted", caught.exception.detail)

    def test_the_groups_exclusion_cannot_be_cleared(self):
        from fastapi import HTTPException

        from backend.routers.categories import CategoryUpdate, update_category

        token = set_current_db_path(str(self.db_path))
        try:
            with self.assertRaises(HTTPException) as caught:
                update_category(self._group_id(), CategoryUpdate(exclude_from_totals=0))
            # Renaming stays open: the feature resolves the group by key, so what it is called is the
            # user's business and only the exclusion is load-bearing.
            update_category(self._group_id(), CategoryUpdate(name="Owed back"))
        finally:
            reset_current_db_path(token)
        self.assertEqual(caught.exception.status_code, 400)
        with self._db() as conn:
            row = conn.execute(
                "SELECT name, exclude_from_totals FROM category WHERE system_key = ?",
                (REIMBURSABLE_SYSTEM_KEY,),
            ).fetchone()
            self.assertEqual(row["exclude_from_totals"], 1)
            self.assertEqual(row["name"], "Owed back")
            # A rename must not lose the feature its group — the whole reason the key is the anchor.
            self.assertEqual(find_reimbursable_group_id(conn), self._group_id_direct(conn))

    def _group_id_direct(self, conn):
        return conn.execute(
            "SELECT id FROM category WHERE system_key = ?", (REIMBURSABLE_SYSTEM_KEY,)
        ).fetchone()["id"]

    def test_the_group_cannot_be_moved_inside_another_group(self):
        # Reparenting turns the group into a leaf, and every lookup that finds it requires
        # `parent_id IS NULL`. Left open, the next write creates a *second* group while the outstanding
        # balance stays stranded under the moved row, and the report reads zero having visibly done
        # nothing wrong. Asserted end to end rather than on the 400 alone, because the refusal only
        # matters for what it prevents.
        from fastapi import HTTPException

        from backend.routers.categories import CategoryUpdate, update_category

        group_id = self._group_id()
        token = set_current_db_path(str(self.db_path))
        try:
            with self._db() as conn:
                shopping = conn.execute(
                    "SELECT id FROM category WHERE name = 'Shopping' AND parent_id IS NULL"
                ).fetchone()["id"]
            with self.assertRaises(HTTPException) as caught:
                update_category(group_id, CategoryUpdate(parent_id=shopping))
        finally:
            reset_current_db_path(token)
        self.assertEqual(caught.exception.status_code, 400)
        with self._db() as conn:
            self.assertEqual(find_reimbursable_group_id(conn), group_id)
            self.assertEqual(reimbursable_leaf_ids(conn), [self.receivable])
            self.assertEqual(
                conn.execute(
                    "SELECT COUNT(*) AS n FROM category WHERE system_key = ?",
                    (REIMBURSABLE_SYSTEM_KEY,),
                ).fetchone()["n"],
                1,
            )

    def test_a_leaf_may_still_be_moved_into_the_group(self):
        # The guard stops at the group. Dragging an ordinary category in makes it a receivable leaf,
        # which is exactly what "the feature keys on the group" is meant to allow.
        from backend.routers.categories import CategoryUpdate, update_category

        group_id = self._group_id()
        token = set_current_db_path(str(self.db_path))
        try:
            update_category(self.groceries, CategoryUpdate(parent_id=group_id))
        finally:
            reset_current_db_path(token)
        with self._db() as conn:
            self.assertIn(self.groceries, reimbursable_leaf_ids(conn))

    def test_leaves_inside_the_group_stay_the_users_to_manage(self):
        # The guards stop at the group: a leaf cannot opt itself back into totals anyway, because
        # exclude_from_totals is NOT NULL so an existing parent always wins COALESCE(parent, leaf).
        from backend.routers.categories import CategoryUpdate, update_category

        token = set_current_db_path(str(self.db_path))
        try:
            update_category(self.receivable, CategoryUpdate(name="Owed by friends"))
            update_category(self.receivable, CategoryUpdate(exclude_from_totals=0))
        finally:
            reset_current_db_path(token)
        with self._db() as conn:
            row = conn.execute(
                "SELECT c.name, COALESCE(p.exclude_from_totals, c.exclude_from_totals, 0) AS effective "
                "FROM category c LEFT JOIN category p ON p.id = c.parent_id WHERE c.id = ?",
                (self.receivable,),
            ).fetchone()
        self.assertEqual(row["name"], "Owed by friends")
        self.assertEqual(row["effective"], 1)


class ApiContractTests(unittest.TestCase):
    """The endpoints through the full stack — routing, serialization, and the 400s the screen shows.

    Worth doing over the real client rather than by calling the router functions: `/outstanding` is a
    literal path declared alongside `/{link_id}`, so only real routing proves the collection read is not
    being swallowed as a lookup of a reimbursement whose id happens to be "outstanding".
    """

    def _seed(self, path):
        conn = sqlite3.connect(path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        account = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO account (id, external_account_id, provider, name, display_name, type, "
            "subtype, mask, owner_id) VALUES (?,?,'fixture_reimb_api','Everyday','Everyday',"
            "'checking','checking','0000',?)",
            (account, f"acct_{account}", SHARED_OWNER_ID),
        )
        group = conn.execute(
            "SELECT id FROM category WHERE name = 'Entertainment' AND parent_id IS NULL"
        ).fetchone()["id"]
        entertainment = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO category (id, parent_id, name, category_type, sort_order) VALUES (?,?,?,?,0)",
            (entertainment, group, "Movies & Events", "expense"),
        )
        receivable_group = conn.execute(
            "SELECT id FROM category WHERE system_key = ?", (REIMBURSABLE_SYSTEM_KEY,)
        ).fetchone()["id"]
        receivable = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO category (id, parent_id, name, category_type, exclude_from_totals, sort_order) "
            "VALUES (?,?,?,?,1,0)",
            (receivable, receivable_group, "Awaiting reimbursement", "expense"),
        )

        def txn(amount, date, category, name):
            txn_id = str(uuid.uuid4())
            conn.execute(
                "INSERT INTO txn (id, account_id, owner_id, category_id, amount, merchant_name, "
                "display_name, raw_name, date, is_pending, category_overridden) "
                "VALUES (?,?,?,?,?,?,?,?,?,0,0)",
                (txn_id, account, SHARED_OWNER_ID, category, amount, name, name, name, date),
            )
            return txn_id

        expense = txn(500.0, "2026-02-14", receivable, "Concert Tickets")
        repayment = txn(-350.0, "2026-07-03", receivable, "Repayment")
        conn.commit()
        conn.close()
        return {"expense": expense, "repayment": repayment, "entertainment": entertainment}

    def test_create_settle_and_reverse_round_trip(self):
        from backend.tests._api_client import api_client

        with api_client() as (client, path):
            seeded = self._seed(path)
            created = client.post(
                "/api/reimbursements",
                json={
                    "claims": [{"txn_id": seeded["expense"]}, {"txn_id": seeded["repayment"]}],
                    "counterparty": "Friends",
                },
            )
            self.assertEqual(created.status_code, 200, created.text)
            link = created.json()
            self.assertEqual(link["residual"], 150.0)
            self.assertEqual(link["counterparty"], "Friends")

            listed = client.get("/api/reimbursements/outstanding")
            self.assertEqual(listed.status_code, 200, listed.text)
            self.assertEqual(listed.json()["total"], 150.0)
            self.assertEqual(len(listed.json()["reimbursements"]), 1)

            settled = client.post(
                f"/api/reimbursements/{link['id']}/complete",
                json={"category_id": seeded["entertainment"]},
            )
            self.assertEqual(settled.status_code, 200, settled.text)
            self.assertTrue(settled.json()["completed"])
            self.assertEqual(client.get("/api/reimbursements/outstanding").json()["total"], 0.0)

            reopened = client.delete(f"/api/reimbursements/{link['id']}/complete")
            self.assertEqual(reopened.status_code, 200, reopened.text)
            self.assertEqual(reopened.json()["residual"], 150.0)
            self.assertEqual(client.get("/api/reimbursements/outstanding").json()["total"], 150.0)

    def test_a_broken_invariant_comes_back_as_a_400_the_screen_can_show(self):
        from backend.tests._api_client import api_client

        with api_client() as (client, path):
            seeded = self._seed(path)
            created = client.post(
                "/api/reimbursements", json={"claims": [{"txn_id": seeded["expense"]}]}
            ).json()
            refused = client.post(
                f"/api/reimbursements/{created['id']}/complete",
                json={"category_id": seeded["entertainment"], "target_txn_id": seeded["repayment"]},
            )
            self.assertEqual(refused.status_code, 400)
            self.assertIn("cannot carry this residual", refused.json()["detail"])


class SharesOfOneTransactionTests(ReimbursementTestCase):
    """One ledger row serving two independent debts — the case that made portions rather than rows the
    unit, and which the first implementation could not express at all.

    Splits exist so a single row can mean several things, so both of these are ordinary use of the
    feature this one is built on rather than edge cases: a charge divided between two friends, and one
    deposit repaying two of them at once.
    """

    def _three_way_charge(self, conn):
        """$750 on three $250 tickets — one the buyer's, two owed by different people."""
        txn_id = self._txn(conn, amount=750.0)
        save_split(conn, txn_id, [
            {"category_id": self.entertainment, "amount": 250.0, "label": "My ticket"},
            {"category_id": self.receivable, "amount": 250.0, "label": "Dana's ticket"},
            {"category_id": self.receivable, "amount": 250.0, "label": "Rowan's ticket"},
        ])
        return txn_id

    def _split_deposit(self, conn, first, second, other):
        """One ATM deposit carrying repayments for two separate debts, plus unrelated money."""
        total = -round(first + second + other, 2)
        txn_id = self._txn(conn, amount=total, date="2026-07-03", name="ATM Deposit")
        save_split(conn, txn_id, [
            {"category_id": self.receivable, "amount": -first, "label": "From Dana"},
            {"category_id": self.receivable, "amount": -second, "label": "From Rowan"},
            {"category_id": self.groceries, "amount": -other, "label": "Change"},
        ])
        return txn_id

    def test_the_shares_of_one_charge_are_offered_individually(self):
        # The report used to sum a row's receivable parts into one figure, so a charge split between two
        # people looked like a single $500 debt and could only ever be tracked as one.
        with self._db() as conn:
            charge = self._three_way_charge(conn)
            report = outstanding(conn)
        [row] = report["loose"]
        self.assertEqual(row["unclaimed"], 500.0)
        self.assertEqual(
            [(part["label"], part["amount"]) for part in row["parts"]],
            [("Dana's ticket", 250.0), ("Rowan's ticket", 250.0)],
        )

    def test_one_charge_can_carry_two_reimbursements_with_different_counterparties(self):
        with self._db() as conn:
            charge = self._three_way_charge(conn)
            dana = create_reimbursement(
                conn, [{"txn_id": charge, "amount": 250.0, "label": "Dana's ticket"}],
                counterparty="Dana",
            )
            rowan = create_reimbursement(
                conn, [{"txn_id": charge, "amount": 250.0, "label": "Rowan's ticket"}],
                counterparty="Rowan",
            )
            unclaimed = unclaimed_amounts(conn, [charge])[charge]
            tracked = reimbursements_for_txn(conn, charge)
        self.assertEqual(dana["residual"], 250.0)
        self.assertEqual(rowan["residual"], 250.0)
        self.assertEqual(unclaimed, 0.0)
        self.assertEqual({r["counterparty"] for r in tracked}, {"Dana", "Rowan"})

    def test_claims_cannot_together_exceed_what_the_row_holds(self):
        with self._db() as conn:
            charge = self._three_way_charge(conn)
            create_reimbursement(conn, [{"txn_id": charge, "amount": 250.0}], counterparty="Dana")
            create_reimbursement(conn, [{"txn_id": charge, "amount": 250.0}], counterparty="Rowan")
            with self.assertRaises(ReimbursementError) as caught:
                create_reimbursement(conn, [{"txn_id": charge}], counterparty="Nobody")
        self.assertIn("already claimed by another reimbursement", str(caught.exception))

    def test_an_unstated_amount_claims_only_what_is_left(self):
        with self._db() as conn:
            charge = self._three_way_charge(conn)
            create_reimbursement(conn, [{"txn_id": charge, "amount": 250.0}], counterparty="Dana")
            # No amount given: takes the remaining $250 rather than the row's whole $500.
            rest = create_reimbursement(conn, [{"txn_id": charge}], counterparty="Rowan")
        self.assertEqual(rest["residual"], 250.0)

    def test_one_deposit_repays_two_separate_debts(self):
        with self._db() as conn:
            charge = self._three_way_charge(conn)
            deposit = self._split_deposit(conn, 250.0, 200.0, 150.0)
            dana = create_reimbursement(conn, [
                {"txn_id": charge, "amount": 250.0, "label": "Dana's ticket"},
                {"txn_id": deposit, "amount": -250.0, "label": "From Dana"},
            ], counterparty="Dana")
            rowan = create_reimbursement(conn, [
                {"txn_id": charge, "amount": 250.0, "label": "Rowan's ticket"},
                {"txn_id": deposit, "amount": -200.0, "label": "From Rowan"},
            ], counterparty="Rowan")
        self.assertEqual(dana["residual"], 0.0, "Dana paid in full")
        self.assertEqual(rowan["residual"], 50.0, "Rowan is $50 short")
        self.assertEqual({m["role"] for m in dana["members"]}, {EXPENSE_ROLE, REPAYMENT_ROLE})

    def test_settling_one_share_leaves_the_other_untouched(self):
        with self._db() as conn:
            charge = self._three_way_charge(conn)
            deposit = self._split_deposit(conn, 250.0, 200.0, 150.0)
            dana = create_reimbursement(conn, [
                {"txn_id": charge, "amount": 250.0}, {"txn_id": deposit, "amount": -250.0},
            ], counterparty="Dana")
            rowan = create_reimbursement(conn, [
                {"txn_id": charge, "amount": 250.0}, {"txn_id": deposit, "amount": -200.0},
            ], counterparty="Rowan")

            complete(conn, rowan["id"], category_id=self.entertainment, target_txn_id=charge)

            after_dana = reimbursements_for_txn(conn, charge)
            dana_after = next(r for r in after_dana if r["counterparty"] == "Dana")
            parts = self._parts(conn, charge)
            receivable = receivable_amounts(conn, [charge])[charge]
            unclaimed = unclaimed_amounts(conn, [charge])[charge]

        # Rowan's $50 shortfall became real spending in the month of the charge.
        self.assertEqual(parts[self.entertainment], 300.0)
        self.assertEqual(receivable, 450.0)
        # Dana's side is exactly as it was, and the row's claims still add up to its receivable.
        self.assertEqual(dana_after["residual"], 0.0)
        self.assertEqual(unclaimed, 0.0)

    def test_the_report_total_still_equals_the_group_balance_with_shares_in_play(self):
        with self._db() as conn:
            charge = self._three_way_charge(conn)
            deposit = self._split_deposit(conn, 250.0, 200.0, 150.0)
            create_reimbursement(conn, [
                {"txn_id": charge, "amount": 250.0}, {"txn_id": deposit, "amount": -250.0},
            ], counterparty="Dana")
            # Rowan's repayment portion is left unlinked, so it has to show up as loose rather than
            # vanishing between the two piles.
            create_reimbursement(conn, [{"txn_id": charge, "amount": 250.0}], counterparty="Rowan")
            report = outstanding(conn)
            leaves = reimbursable_leaf_ids(conn)
            places = ",".join("?" for _ in leaves)
            balance = conn.execute(
                f"SELECT COALESCE(SUM(s.amount), 0) AS total FROM txn_split s JOIN txn t ON t.id = s.txn_id "
                f"WHERE t.trashed_at IS NULL AND s.category_id IN ({places})",
                leaves,
            ).fetchone()["total"]
        self.assertEqual(report["total"], round(float(balance), 2))
        self.assertEqual([row["unclaimed"] for row in report["loose"]], [-200.0])
